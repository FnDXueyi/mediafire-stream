// Serves public/ and one API route with plain node:http.
// `npm start`, then open http://127.0.0.1:8788

import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { createServer, type ServerResponse } from "node:http"
import { extname, join, normalize, resolve, sep } from "node:path"

import { LinkError, resolveDirectLink } from "./mediafire.ts"

const HOST = process.env.HOST ?? "127.0.0.1"
const PORT = Number(process.env.PORT ?? 8788)
const PUBLIC = resolve(import.meta.dirname, "../public")

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
}

/** Direct links stay valid for a while; avoid re-scraping on every click. */
const LINK_TTL_MS = 30 * 60_000
const links = new Map<string, { url: string; at: number }>()

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  })
  res.end(payload)
}

async function handleLink(url: URL, res: ServerResponse, signal: AbortSignal) {
  const key = url.searchParams.get("key") ?? ""
  const cached = links.get(key)
  if (cached && Date.now() - cached.at < LINK_TTL_MS && url.searchParams.get("fresh") !== "1") {
    sendJson(res, 200, { ok: true, url: cached.url })
    return
  }
  try {
    const direct = await resolveDirectLink(key, { signal })
    links.set(key, { url: direct, at: Date.now() })
    sendJson(res, 200, { ok: true, url: direct })
  } catch (err) {
    if (signal.aborted) return
    const status = err instanceof LinkError ? err.status : 500
    sendJson(res, status, { ok: false, error: (err as Error).message })
  }
}

async function serveStatic(pathname: string, res: ServerResponse) {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    res.writeHead(400).end("Bad path")
    return
  }
  const rel = normalize(decoded).replace(/^([/\\])+/, "") || "index.html"
  const file = join(PUBLIC, rel)
  if (!file.startsWith(PUBLIC + sep)) {
    res.writeHead(400).end("Bad path")
    return
  }
  const info = await stat(file).catch(() => null)
  if (!info?.isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found")
    return
  }
  res.writeHead(200, {
    "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
    "Content-Length": info.size,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    // Cross-origin isolation, so workers can share memory (SharedArrayBuffer)
    // for the parallel archive download. MediaFire answers with CORS, which
    // is all require-corp asks of cross-origin fetches.
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
  })
  createReadStream(file).pipe(res)
}

const server = createServer(async (req, res) => {
  const controller = new AbortController()
  res.on("close", () => {
    if (!res.writableFinished) controller.abort()
  })
  try {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end()
      return
    }
    const url = new URL(req.url ?? "/", "http://localhost")
    if (url.pathname === "/api/link") return await handleLink(url, res, controller.signal)
    if (url.pathname.startsWith("/api/")) return sendJson(res, 404, { ok: false, error: "Not found." })
    await serveStatic(url.pathname, res)
  } catch (err) {
    console.error(err)
    if (!res.headersSent) res.writeHead(500).end("Internal error")
    else res.destroy()
  }
})

server.listen(PORT, HOST, () => {
  console.log(`mediafire-stream listening on http://${HOST}:${PORT}`)
})
