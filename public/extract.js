// Page side of in-browser extraction.
//
// extract-worker.js decompresses one RAR entry and posts the bytes here as
// they come out. They stay in this tab's memory (never on disk), and the
// service worker reads ranges of them for the <video> element through
// postMessage (see sw.js, `/stream?mem=`). Reads beyond what has been
// decompressed so far simply wait, so playback can start early when the
// video's index (moov) sits at the front of the file.

/** Bytes of one decompressed file, growing while the worker runs. */
class MemoryFile {
  constructor(size) {
    this.size = size
    this.chunks = []
    this.starts = []
    this.length = 0
    this.done = false
    this.error = null
    this.waiters = []
  }

  push(buffer) {
    this.starts.push(this.length)
    this.chunks.push(new Uint8Array(buffer))
    this.length += buffer.byteLength
    this.wake()
  }

  finish(error = null) {
    this.done = true
    this.error = error
    this.wake()
  }

  wake() {
    const waiters = this.waiters
    this.waiters = []
    for (const resolve of waiters) resolve()
  }

  /** Copies bytes [start, start + length), waiting until they exist. */
  async read(start, length) {
    const end = Math.min(start + length, this.size)
    while (this.length < end && !this.done) await new Promise((r) => this.waiters.push(r))
    if (this.error) throw this.error
    if (this.length < end) throw new Error("Extraction ended before the end of the file")

    const out = new Uint8Array(end - start)
    let i = upperBound(this.starts, start) - 1
    let written = 0
    while (written < out.length) {
      const chunk = this.chunks[i]
      const from = start + written - this.starts[i]
      const n = Math.min(chunk.length - from, out.length - written)
      out.set(chunk.subarray(from, from + n), written)
      written += n
      i++
    }
    return out
  }
}

function upperBound(sorted, value) {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] <= value) lo = mid + 1
    else hi = mid
  }
  return lo
}

// Parallel download (fetch-worker.js) needs SharedArrayBuffer, which browsers
// only allow on cross-origin isolated pages (the server sends COOP/COEP).
// MediaFire's download servers speak HTTP/1.1 only, so browsers open at most
// 6 connections to them; more slots wouldn't help. With ~1 s before each
// response starts, big windows pay off: measured 6 x 8 MB ~12 MB/s,
// 6 x 32 MB ~24 MB/s.
const PARALLEL_WINDOW = 32 * 1024 * 1024
const PARALLEL_SLOTS = 6
const PARALLEL_TAIL = 1024 * 1024 // end of the archive, which UnRAR reads first

const files = new Map() // id -> MemoryFile
let current = null // { id, workers }

/**
 * Starts decompressing `entry` from the archive at `url`. Only one extraction
 * runs at a time; starting another (or calling stopExtraction) frees the
 * previous one's memory.
 * @returns {{ id: string, file: MemoryFile }}
 */
export function startExtraction({ url, key, archiveSize, entry }, onProgress) {
  stopExtraction()
  const id = crypto.randomUUID()
  const file = new MemoryFile(entry.size)
  const worker = new Worker(new URL("./extract-worker.js", import.meta.url), { type: "module" })
  const workers = [worker]
  files.set(id, file)
  current = { id, workers }

  let shared
  if (globalThis.crossOriginIsolated) {
    const fetcher = new Worker(new URL("./fetch-worker.js", import.meta.url), { type: "module" })
    workers.push(fetcher)
    const data = new SharedArrayBuffer(PARALLEL_WINDOW * PARALLEL_SLOTS + PARALLEL_TAIL)
    const ctrl = new SharedArrayBuffer(4 * (3 + 3 * PARALLEL_SLOTS))
    const view = new Int32Array(ctrl)
    for (let s = 0; s < PARALLEL_SLOTS; s++) view[3 + s * 3 + 1] = -1 // no window yet
    const channel = new MessageChannel()
    const common = { window: PARALLEL_WINDOW, slots: PARALLEL_SLOTS, tail: PARALLEL_TAIL, data, ctrl }
    fetcher.postMessage({ url, key, size: archiveSize, ...common, port: channel.port1 }, [channel.port1])
    shared = { ...common, port: channel.port2 }
  }
  const stop = () => workers.forEach((w) => w.terminate())

  worker.onmessage = ({ data }) => {
    if (data.type === "chunk") {
      try {
        file.push(data.buffer)
      } catch {
        // Allocation failures surface as RangeError here.
        fail(new Error("Not enough memory to hold this video"))
        return
      }
      onProgress?.(file.length / file.size, null)
    } else if (data.type === "done") {
      file.finish()
      stop()
      onProgress?.(1, null)
    } else if (data.type === "error") {
      fail(new Error(data.message))
    }
  }
  worker.onerror = (event) => fail(new Error(event.message || "Extraction worker crashed"))

  function fail(error) {
    file.finish(error)
    stop()
    onProgress?.(file.length / file.size, error)
  }

  worker.postMessage({ url, key, archiveSize, entry: entry.name, shared }, shared ? [shared.port] : [])
  return { id, file }
}

export function stopExtraction() {
  if (!current) return
  current.workers.forEach((w) => w.terminate())
  files.get(current.id)?.finish(new Error("Stopped"))
  files.delete(current.id)
  current = null
}

// The service worker asks for byte ranges of in-memory files here.
navigator.serviceWorker?.addEventListener("message", async (event) => {
  const { type, id, start, length } = event.data ?? {}
  if (type !== "read") return
  const port = event.ports[0]
  const file = files.get(id)
  if (!file) {
    port.postMessage({ error: "This video is no longer in memory" })
    return
  }
  try {
    const bytes = await file.read(start, length)
    port.postMessage({ bytes: bytes.buffer }, [bytes.buffer])
  } catch (err) {
    port.postMessage({ error: err.message })
  }
})
