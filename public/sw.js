// Service Worker that gives the <video> element a normal, seekable URL for
// files that live inside a RAR archive. Two sources:
//
//   /stream?u=<archive url>&o=<offset>&s=<size>&t=<mime>
//     A stored (uncompressed) entry. The player asks for "bytes 1000-1999 of
//     the video"; we ask MediaFire for bytes o+1000 to o+1999 of the archive.
//
//   /stream?mem=<id>&s=<size>&t=<mime>
//     A compressed entry being decompressed in the page (extract.js). Bytes
//     are requested from the page in small pieces over postMessage.
//
// Nothing is written to disk either way.

const MEMORY_PIECE = 1024 * 1024
// Only MediaFire's download servers, and only media types, so /stream can't be
// abused to serve arbitrary content (e.g. HTML) from this origin.
const SOURCE_HOST_RE = /^download\d*\.mediafire\.com$/i
const TYPES = new Set(["video/mp4", "video/webm", "video/x-matroska", "video/ogg", "application/octet-stream"])

self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()))

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin || url.pathname !== "/stream") return
  if (event.request.mode === "navigate") return // only the <video> element uses it
  event.respondWith(stream(event, url.searchParams))
})

async function stream(event, params) {
  const size = Number(params.get("s"))
  const type = TYPES.has(params.get("t")) ? params.get("t") : "application/octet-stream"
  if (!Number.isSafeInteger(size) || size <= 0) return new Response("Bad size", { status: 400 })

  const range = parseRange(event.request.headers.get("range"), size)
  if (!range) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } })
  }
  const { start, end } = range

  let body
  if (params.has("mem")) {
    const client = await findClient(event.clientId)
    if (!client) return new Response("Page not found", { status: 502 })
    body = memoryBody(client, params.get("mem"), start, end)
  } else {
    const source = params.get("u")
    const offset = Number(params.get("o"))
    if (!isMediafireDownload(source) || !Number.isSafeInteger(offset)) {
      return new Response("Bad parameters", { status: 400 })
    }
    let upstream
    try {
      upstream = await fetch(source, {
        headers: { Range: `bytes=${offset + start}-${offset + end}` },
        cache: "no-store",
        redirect: "manual", // expired links redirect; fail fast so the page re-resolves
        signal: event.request.signal,
      })
    } catch (err) {
      return new Response(`Upstream error: ${err}`, { status: 502 })
    }
    // 403/410 usually means the download link expired; the page re-resolves it.
    if (upstream.status !== 206) return new Response(`Upstream HTTP ${upstream.status}`, { status: 502 })
    body = upstream.body
  }

  return new Response(body, {
    status: 206,
    headers: {
      "Content-Type": type,
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
    },
  })
}

function isMediafireDownload(value) {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && SOURCE_HOST_RE.test(url.hostname)
  } catch {
    return false
  }
}

/** Parses "bytes=start-end", "bytes=start-" or "bytes=-suffix". */
function parseRange(header, size) {
  let start = 0
  let end = size - 1
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? "")
  if (m) {
    if (m[1] === "" && m[2] !== "") {
      start = Math.max(0, size - Number(m[2]))
    } else {
      start = Number(m[1] || 0)
      if (m[2] !== "") end = Math.min(Number(m[2]), size - 1)
    }
  }
  return start < size && start <= end ? { start, end } : null
}

async function findClient(clientId) {
  const byId = clientId ? await self.clients.get(clientId) : null
  if (byId) return byId
  const windows = await self.clients.matchAll({ type: "window" })
  return windows.find((c) => c.focused) ?? windows[0] ?? null
}

/** A stream that pulls [start, end] from the page's in-memory file. */
function memoryBody(client, id, start, end) {
  let pos = start
  return new ReadableStream({
    async pull(controller) {
      if (pos > end) return controller.close()
      const length = Math.min(MEMORY_PIECE, end - pos + 1)
      try {
        const bytes = await ask(client, { type: "read", id, start: pos, length })
        controller.enqueue(bytes)
        pos += bytes.length
      } catch (err) {
        controller.error(err)
      }
    },
  })
}

function ask(client, message) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = ({ data }) => {
      if (data.error) reject(new Error(data.error))
      else resolve(new Uint8Array(data.bytes))
    }
    client.postMessage(message, [channel.port2])
  })
}
