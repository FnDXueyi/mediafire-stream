import { startExtraction, stopExtraction } from "./extract.js"
import { directLink, getFile, listFolder, parseMediafireUrl } from "./mediafire.js"
import { listRar } from "./rar.js"

const $ = (id) => document.getElementById(id)
const form = $("form"), input = $("url"), openBtn = $("open")
const errorBox = $("error"), list = $("list"), rows = $("rows")
const player = $("player"), video = $("video"), now = $("now")

const VIDEO_TYPES = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/mp4", // most .mov files are H.264 and play as mp4
  webm: "video/webm",
  mkv: "video/x-matroska",
  ogv: "video/ogg",
}
const PROBE_CONCURRENCY = 3

let session = null // AbortController of the folder currently shown
let playing = null // { file, entry, row, retries, memory }

// ------------------------------------------------------------ helpers ---

const ext = (name) => name.toLowerCase().split(".").pop()
const videoType = (name) => VIDEO_TYPES[ext(name)] ?? null
const isRar = (name) => /\.(rar|cbr)$/i.test(name)

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return ""
  const units = ["B", "KB", "MB", "GB", "TB"]
  let i = 0
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024
    i++
  }
  return `${bytes.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children.filter((c) => c !== null && c !== undefined))
  return node
}

function spinner() {
  return el("span", { className: "spinner", role: "status", ariaLabel: "Loading" })
}

function showError(message) {
  errorBox.textContent = message
  errorBox.hidden = !message
}

/** Resolves (and caches) the direct download link of a MediaFire file. */
async function linkFor(file, { fresh = false } = {}) {
  if (!file.link || fresh) file.link = await directLink(file.key, { fresh })
  return file.link
}

// --------------------------------------------------- service worker ---

const swReady = (async () => {
  if (!("serviceWorker" in navigator)) return false
  await navigator.serviceWorker.register("/sw.js")
  await navigator.serviceWorker.ready
  if (navigator.serviceWorker.controller) return true
  // First visit: the worker claims this page right after activating.
  return new Promise((resolve) => {
    navigator.serviceWorker.addEventListener("controllerchange", () => resolve(true), { once: true })
    setTimeout(() => resolve(Boolean(navigator.serviceWorker.controller)), 3000)
  })
})()

// --------------------------------------------------------- playback ---

/**
 * Estimates time left from the rate since the first output arrived, so the
 * start-up (loading WebAssembly, first request) doesn't skew it.
 */
function etaMeter() {
  let first = null // { t, p }
  return (progress) => {
    const t = performance.now()
    if (!first) {
      if (progress > 0) first = { t, p: progress }
      return null
    }
    const rate = (progress - first.p) / (t - first.t) // fraction per ms
    if (!(rate > 0) || t - first.t < 2000) return null
    const seconds = Math.ceil((1 - progress) / rate / 1000)
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`
  }
}

function streamUrl(link, entry) {
  const query = new URLSearchParams({
    u: link,
    o: String(entry.offset),
    s: String(entry.size),
    t: videoType(entry.name) ?? "application/octet-stream",
  })
  return `/stream?${query}`
}

function memoryUrl(id, entry) {
  const query = new URLSearchParams({
    mem: id,
    s: String(entry.size),
    t: videoType(entry.name) ?? "application/octet-stream",
  })
  return `/stream?${query}`
}

async function play(file, entry, row) {
  showError("")
  document.querySelector(".row.playing")?.classList.remove("playing")
  row.classList.add("playing")
  player.hidden = false
  const title = entry ? `${file.name} › ${entry.name}` : file.name
  now.textContent = title
  player.scrollIntoView({ behavior: "smooth", block: "nearest" })
  stopExtraction() // frees the memory of a previous extraction

  try {
    const link = await linkFor(file)
    let memory = null
    if (entry) {
      if (!(await swReady)) {
        throw new Error("Streaming needs the service worker. Reload the page once (not a hard reload).")
      }
      if (entry.stored) {
        video.src = streamUrl(link, entry)
      } else {
        const eta = etaMeter()
        memory = startExtraction({ url: link, key: file.key, archiveSize: file.size, entry }, (progress, error) => {
          if (playing?.memory !== memory) return
          if (error) showError(`Extraction failed: ${error.message}`)
          const left = eta(progress)
          now.textContent =
            progress < 1 && !error
              ? `${title} · extracting ${Math.floor(progress * 100)}%${left ? ` · ${left} left` : ""}`
              : title
        })
        now.textContent = `${title} · extracting 0%`
        video.src = memoryUrl(memory.id, entry)
      }
    } else {
      video.src = link
    }
    playing = { file, entry, row, retries: 0, memory }
    await video.play().catch(() => {}) // autoplay may be blocked; controls still work
  } catch (err) {
    showError(err.message)
  }
}

// On a playback error, try to continue where we were: download links expire
// after a while (fetch a fresh one), and a long wait for extraction can time
// out the player's request (just ask again).
video.addEventListener("error", async () => {
  if (!playing) return
  const { file, entry, memory } = playing
  if (memory?.file.error || playing.retries >= 3) {
    if (!memory?.file.error) showError("Playback failed. The format may not be supported by this browser.")
    return
  }
  playing.retries++
  const at = video.currentTime
  try {
    if (memory) {
      video.src = memoryUrl(memory.id, entry)
    } else {
      const link = await linkFor(file, { fresh: true })
      video.src = entry ? streamUrl(link, entry) : link
    }
    video.currentTime = at
    await video.play().catch(() => {})
  } catch (err) {
    showError(err.message)
  }
})

// ------------------------------------------------------------- rows ---

function fileRow(file) {
  const label = file.path ? el("small", { textContent: file.path }) : null
  const row = el(
    "div",
    { className: "row" },
    el("div", { className: "name" }, label, file.name),
    el("span", { className: "meta", textContent: formatSize(file.size) })
  )
  const action = el("span")
  row.append(action)

  if (videoType(file.name)) {
    action.replaceWith(playButton(file, null, row))
  } else if (isRar(file.name)) {
    action.replaceWith(spinner())
  } else {
    const open = el("button", { type: "button", className: "ghost sm", textContent: "Open" })
    open.addEventListener("click", async () => {
      try {
        window.open(await linkFor(file), "_blank", "noopener")
      } catch (err) {
        showError(err.message)
      }
    })
    action.replaceWith(open)
  }
  return row
}

function playButton(file, entry, row, label = "Play") {
  const button = el("button", { type: "button", className: entry && !entry.stored ? "ghost sm" : "sm", textContent: label })
  button.addEventListener("click", () => play(file, entry, row))
  return button
}

/** Replaces a .rar row with one row per entry inside the archive. */
function entryRows(file, archive) {
  const out = []
  for (const entry of archive.entries) {
    const row = el(
      "div",
      { className: "row" },
      el("div", { className: "name" }, el("small", { textContent: file.path ? `${file.path}/${file.name}` : file.name }), entry.name),
      el("span", { className: "meta", textContent: formatSize(entry.size) })
    )
    const why = entry.encrypted ? "Password" : entry.split ? "Split" : ""
    if (why) {
      row.append(el("span", { className: "meta", textContent: why }))
    } else if (videoType(entry.name)) {
      // Stored entries stream directly; compressed ones are decompressed in
      // memory first, which is slower and needs RAM roughly the video's size.
      row.append(playButton(file, entry, row, entry.stored ? "Play" : "Extract"))
    }
    out.push(row)
  }
  if (out.length === 0) {
    out.push(el("div", { className: "row" }, el("div", { className: "name" }, file.name), el("span", { className: "meta", textContent: "Empty" })))
  }
  return out
}

async function probe(file, row, signal) {
  try {
    let archive
    try {
      archive = await listRar(await linkFor(file), { signal })
    } catch (err) {
      if (signal.aborted) throw err
      // Download links stop working after a number of requests; try a fresh one.
      archive = await listRar(await linkFor(file, { fresh: true }), { signal })
    }
    if (!signal.aborted) row.replaceWith(...entryRows(file, archive))
  } catch (err) {
    if (signal.aborted) return
    row.lastChild.replaceWith(el("span", { className: "meta", textContent: "Can't read", title: err.message }))
  }
}

async function runPool(tasks, limit) {
  const queue = [...tasks]
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) await queue.shift()()
    })
  )
}

// ------------------------------------------------------------- open ---

async function open(raw) {
  const target = parseMediafireUrl(raw)
  if (!target) {
    showError("Paste a MediaFire folder or file link.")
    return
  }
  session?.abort()
  const controller = new AbortController()
  session = controller
  const { signal } = controller

  showError("")
  history.replaceState(null, "", `?${new URLSearchParams({ url: raw.trim() })}`)
  openBtn.disabled = true
  openBtn.replaceChildren(spinner())

  try {
    const folder = target.kind === "folder" ? await listFolder(target.key, { signal }) : await getFile(target.key, { signal })
    if (signal.aborted) return
    $("folder").textContent = folder.name
    const made = folder.files.map((file) => ({ file, row: fileRow(file) }))
    rows.replaceChildren(...made.map((m) => m.row))
    list.hidden = false
    if (made.length === 0) rows.append(el("div", { className: "row" }, el("div", { className: "name meta", textContent: "Empty folder" })))

    resetOpenButton(controller)

    // Peek inside the archives in the background; rows update as they finish.
    const archives = made.filter((m) => isRar(m.file.name))
    await runPool(archives.map((m) => () => probe(m.file, m.row, signal)), PROBE_CONCURRENCY)
  } catch (err) {
    if (!signal.aborted) showError(err.message)
  } finally {
    resetOpenButton(controller)
  }
}

function resetOpenButton(controller) {
  if (session !== controller) return
  openBtn.disabled = false
  openBtn.textContent = "Open"
}

form.addEventListener("submit", (event) => {
  event.preventDefault()
  open(input.value)
})

const initial = new URLSearchParams(location.search).get("url")
if (initial) {
  input.value = initial
  open(initial)
}
