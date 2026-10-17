// Web Worker that decompresses one file out of a remote RAR archive.
//
// UnRAR (compiled to WebAssembly, see vendor/unrar) never touches files
// itself; it calls back into JavaScript for every read and write. So:
//
//   read()  -> the archive is streamed from MediaFire in windows of a few MB;
//              it is never fully downloaded into memory. Reads must be
//              synchronous because UnRAR waits for the bytes, so either:
//              - SharedRemoteFile: fetch-worker.js downloads several windows
//                in parallel into shared memory and we Atomics.wait on them
//                (needs a cross-origin isolated page), or
//              - RemoteFile: one synchronous XHR at a time (fallback).
//   write() -> the decompressed bytes are batched and posted to the page,
//              which keeps them in memory and feeds the video player.
//
// Messages in:  { url, key, archiveSize, entry, shared? }
// Messages out: { type: "chunk", buffer } | { type: "done" } | { type: "error", message }

import unrarFactory from "./vendor/unrar/unrar.js"
import { Extractor } from "./vendor/unrar/Extractor.js"

// MediaFire takes about a second to answer each request, so big windows matter:
// 8 MB windows measured ~2.4 MB/s overall, 32 MB windows ~8 MB/s.
const READ_WINDOW = 32 * 1024 * 1024 // bytes per Range request
const POST_BATCH = 4 * 1024 * 1024 // bytes per message to the page
const ARCHIVE_PATH = "archive.rar"
const ARCHIVE_FD = 1

/** Random access to a remote file through synchronous Range requests. */
class RemoteFile {
  constructor(url, key, size) {
    this.url = url
    this.key = key
    this.size = size
    this.pos = 0
    this.window = new Uint8Array(0)
    this.windowStart = 0
  }

  read(length) {
    const end = Math.min(this.pos + length, this.size)
    if (this.pos >= end) return new Uint8Array(0)
    const windowEnd = this.windowStart + this.window.length
    if (this.pos < this.windowStart || end > windowEnd) {
      this.fetchWindow(this.pos, Math.max(READ_WINDOW, end - this.pos))
    }
    const from = this.pos - this.windowStart
    const out = this.window.subarray(from, from + (end - this.pos))
    this.pos = end
    return out
  }

  fetchWindow(start, length) {
    const end = Math.min(start + length, this.size) - 1
    for (let attempt = 1; ; attempt++) {
      const xhr = new XMLHttpRequest()
      xhr.open("GET", this.url, false)
      xhr.responseType = "arraybuffer"
      xhr.setRequestHeader("Range", `bytes=${start}-${end}`)
      try {
        xhr.send()
      } catch {
        // An expired link redirects to a page without CORS: a network error here.
      }
      if (xhr.status === 206) {
        this.window = new Uint8Array(xhr.response)
        this.windowStart = start
        return
      }
      if (attempt >= 2) throw new Error(`Archive download failed (HTTP ${xhr.status})`)
      this.url = freshLinkSync(this.key)
    }
  }

  seek(offset, method) {
    const next = method === "SET" ? offset : method === "CUR" ? this.pos + offset : this.size - offset
    if (next < 0 || next > this.size) return false
    this.pos = next
    return true
  }
}

/** Asks the local server for a new download link (synchronously). */
function freshLinkSync(key) {
  const xhr = new XMLHttpRequest()
  xhr.open("GET", `/api/link?${new URLSearchParams({ key, fresh: "1" })}`, false)
  xhr.send()
  const body = JSON.parse(xhr.responseText || "{}")
  if (!body.ok) throw new Error(body.error ?? "Could not refresh the download link")
  return body.url
}

/**
 * Same interface as RemoteFile, but reads windows that fetch-worker.js
 * downloads in parallel into shared memory. Needs a cross-origin isolated
 * page (SharedArrayBuffer); extract.js falls back to RemoteFile otherwise.
 */
class SharedRemoteFile {
  static CURRENT = 0
  static GENERATION = 1
  static TAIL_LENGTH = 2
  static SLOT_BASE = 3
  static READY = 2
  static FAILED = 3

  constructor({ size, window, slots, tail, data, ctrl, port }) {
    this.size = size
    this.windowSize = window
    this.slots = slots
    this.tailSize = Math.min(tail, size)
    this.tailStart = size - this.tailSize
    this.data = new Uint8Array(data)
    this.ctrl = new Int32Array(ctrl)
    this.port = port
    this.pos = 0
  }

  read(length) {
    const end = Math.min(this.pos + length, this.size)
    const out = new Uint8Array(Math.max(0, end - this.pos))
    let written = 0
    // UnRAR checks the end of the archive before extracting; fetch-worker
    // grabs that tail first so this small read doesn't queue behind windows.
    if (this.pos >= this.tailStart && end <= this.size) {
      this.waitForTail()
      const from = this.slots * this.windowSize + (this.pos - this.tailStart)
      out.set(this.data.subarray(from, from + out.length))
      this.pos = end
      return out
    }
    while (this.pos < end) {
      const w = Math.floor(this.pos / this.windowSize)
      const from = this.pos - w * this.windowSize
      const slot = this.waitForBytes(w, from)
      const available = Atomics.load(this.ctrl, this.field(slot, 2)) - from
      const n = Math.min(available, end - this.pos)
      out.set(this.data.subarray(slot * this.windowSize + from, slot * this.windowSize + from + n), written)
      written += n
      this.pos += n
    }
    return out
  }

  field(slot, i) {
    return SharedRemoteFile.SLOT_BASE + slot * 3 + i
  }

  waitForTail() {
    const { GENERATION, TAIL_LENGTH } = SharedRemoteFile
    for (let waited = 0; ; ) {
      const generation = Atomics.load(this.ctrl, GENERATION)
      const length = Atomics.load(this.ctrl, TAIL_LENGTH)
      if (length === this.tailSize) return
      if (length < 0) throw new Error("Archive download failed")
      if (Atomics.wait(this.ctrl, GENERATION, generation, 30_000) === "timed-out" && (waited += 30) >= 120) {
        throw new Error("Archive download stalled")
      }
    }
  }

  /**
   * Blocks until window `w` has more than `from` bytes in a slot (it may
   * still be downloading); returns the slot number.
   */
  waitForBytes(w, from) {
    const { CURRENT, GENERATION, READY, FAILED } = SharedRemoteFile
    if (Atomics.exchange(this.ctrl, CURRENT, w) !== w) this.port.postMessage({ need: w })
    for (let waited = 0; ; ) {
      const generation = Atomics.load(this.ctrl, GENERATION)
      for (let s = 0; s < this.slots; s++) {
        if (Atomics.load(this.ctrl, this.field(s, 1)) !== w) continue
        const state = Atomics.load(this.ctrl, this.field(s, 0))
        if (state === FAILED) throw new Error("Archive download failed")
        if (state === READY || Atomics.load(this.ctrl, this.field(s, 2)) > from) return s
      }
      if (Atomics.wait(this.ctrl, GENERATION, generation, 30_000) === "timed-out") {
        waited += 30
        this.port.postMessage({ need: w })
        if (waited >= 120) throw new Error("Archive download stalled")
      }
    }
  }

  seek(offset, method) {
    const next = method === "SET" ? offset : method === "CUR" ? this.pos + offset : this.size - offset
    if (next < 0 || next > this.size) return false
    this.pos = next
    return true
  }
}

/** Collects decompressed bytes and ships them to the page in batches. */
class Sink {
  constructor() {
    this.batch = new Uint8Array(POST_BATCH)
    this.used = 0
  }

  write(bytes) {
    let from = 0
    while (from < bytes.length) {
      const n = Math.min(bytes.length - from, this.batch.length - this.used)
      this.batch.set(bytes.subarray(from, from + n), this.used)
      this.used += n
      from += n
      if (this.used === this.batch.length) this.flush()
    }
  }

  flush() {
    if (this.used === 0) return
    const buffer = this.used === this.batch.length ? this.batch.buffer : this.batch.slice(0, this.used).buffer
    self.postMessage({ type: "chunk", buffer }, [buffer])
    this.batch = new Uint8Array(POST_BATCH)
    this.used = 0
  }
}

/** Plugs RemoteFile and Sink into UnRAR's file callbacks. */
class RemoteExtractor extends Extractor {
  constructor(unrar, archive) {
    super(unrar, "")
    this._filePath = ARCHIVE_PATH
    this.archive = archive
    this.sink = new Sink()
    this.nextFd = ARCHIVE_FD + 1
    this.outputs = new Set()
  }

  open(filename) {
    return filename === ARCHIVE_PATH ? ARCHIVE_FD : 0
  }

  create() {
    const fd = this.nextFd++
    this.outputs.add(fd)
    return fd
  }

  read(fd, ptr, size) {
    if (fd !== ARCHIVE_FD) return -1
    const bytes = this.archive.read(size)
    this.unrar.HEAPU8.set(bytes, ptr)
    return bytes.length
  }

  write(fd, ptr, size) {
    if (!this.outputs.has(fd)) return false
    this.sink.write(this.unrar.HEAPU8.subarray(ptr, ptr + size))
    return true
  }

  tell(fd) {
    return fd === ARCHIVE_FD ? this.archive.pos : -1
  }

  seek(fd, pos, method) {
    return fd === ARCHIVE_FD ? this.archive.seek(pos, method) : false
  }

  closeFile(fd) {
    if (this.outputs.has(fd)) this.sink.flush()
  }
}

self.onmessage = async ({ data }) => {
  try {
    const wasmBinary = await (await fetch(new URL("./vendor/unrar/unrar.wasm", import.meta.url))).arrayBuffer()
    const unrar = await unrarFactory({ wasmBinary })
    const archive = data.shared
      ? new SharedRemoteFile({ size: data.archiveSize, ...data.shared })
      : new RemoteFile(data.url, data.key, data.archiveSize)
    const extractor = new RemoteExtractor(unrar, archive)
    unrar.extractor = extractor

    const { files } = extractor.extract({ files: [data.entry] })
    let found = false
    for (const file of files) found ||= file.fileHeader.name.replaceAll("\\", "/") === data.entry
    extractor.sink.flush()
    if (!found) throw new Error(`"${data.entry}" was not found in the archive`)
    self.postMessage({ type: "done" })
  } catch (err) {
    const message = err?.reason ? `${err.reason}: ${err.message}` : (err?.message ?? String(err))
    self.postMessage({ type: "error", message })
  }
}
