// Downloads the archive ahead of the extractor, several windows in parallel.
//
// The extractor (extract-worker.js) has to read synchronously, so on its own
// it can only wait for one request at a time, and MediaFire spends ~1 s on
// every request before sending a byte. This worker keeps SLOTS requests in
// flight for the windows right after the extractor's read position and
// streams them into shared memory. LENGTH grows as bytes arrive, so the
// extractor can start on a window before it has finished downloading.
//
// Shared layout (see extract.js):
//   data: SLOTS * WINDOW bytes, then the archive's last TAIL bytes
//   ctrl: Int32Array [CURRENT, GENERATION, TAIL_LENGTH, then per slot: STATE, WINDOW_INDEX, LENGTH]
//
// UnRAR reads the end of the archive before it starts extracting, so the
// tail is fetched first; otherwise that tiny read would wait behind the
// six big window downloads (browsers allow 6 connections per host).
//
// Download links stop working after a number of requests (MediaFire then
// redirects to download_repair.php). When that happens we fetch a fresh link
// from the local server and carry on.
//
// Messages in:  { url, key, size, window, slots, tail, data, ctrl, port }  (once)
//               { need: windowIndex }  on `port`, from the extractor

const CURRENT = 0 // window the extractor is reading
const GENERATION = 1 // bumped (and notified) whenever a slot changes
const TAIL_LENGTH = 2 // bytes of the tail in place; -1 if it failed
const SLOT_BASE = 3
const EMPTY = 0, LOADING = 1, READY = 2, FAILED = 3
const RETRIES = 4

self.onmessage = ({ data: init }) => {
  const { key, size, window: windowSize, slots, port } = init
  const tailSize = Math.min(init.tail, size)
  let link = init.url
  let refreshing = null
  const data = new Uint8Array(init.data)
  const ctrl = new Int32Array(init.ctrl)
  const windows = Math.ceil(size / windowSize)
  const field = (slot, i) => SLOT_BASE + slot * 3 + i

  const slotState = (s) => Atomics.load(ctrl, field(s, 0))
  const slotWindow = (s) => Atomics.load(ctrl, field(s, 1))

  function signal() {
    Atomics.add(ctrl, GENERATION, 1)
    Atomics.notify(ctrl, GENERATION)
  }

  /** One shared refresh for all slots that hit the expired link. */
  function refreshLink(stale) {
    if (link !== stale) return Promise.resolve()
    refreshing ??= fetch(`/api/link?${new URLSearchParams({ key, fresh: "1" })}`)
      .then((r) => r.json())
      .then((body) => {
        if (!body.ok) throw new Error(body.error)
        link = body.url
      })
      .finally(() => (refreshing = null))
    return refreshing
  }

  /** Fill free slots with the windows the extractor will need next. */
  function schedule() {
    const current = Atomics.load(ctrl, CURRENT)
    const last = Math.min(current + slots - 1, windows - 1)
    const wanted = []
    for (let w = current; w <= last; w++) {
      let have = false
      for (let s = 0; s < slots; s++) {
        if (slotWindow(s) === w && slotState(s) !== EMPTY) have = true
      }
      if (!have) wanted.push(w)
    }
    for (const w of wanted) {
      // A slot is free if it's empty or holds a window outside [current, last].
      let free = -1
      for (let s = 0; s < slots && free < 0; s++) {
        const st = slotState(s)
        const sw = slotWindow(s)
        if (st === EMPTY || (st !== LOADING && (sw < current || sw > last))) free = s
      }
      if (free < 0) return
      load(free, w)
    }
  }

  async function load(slot, w) {
    // Order matters: the extractor must never see the new window index next
    // to the previous window's state or length.
    Atomics.store(ctrl, field(slot, 0), LOADING)
    Atomics.store(ctrl, field(slot, 2), 0)
    Atomics.store(ctrl, field(slot, 1), w)
    const start = w * windowSize
    const end = Math.min(start + windowSize, size) - 1
    const total = end - start + 1
    const base = slot * windowSize
    let filled = 0
    for (let attempt = 1; ; attempt++) {
      try {
        const used = link
        const res = await fetch(used, {
          // After a dropped connection, resume where the bytes stopped.
          headers: { Range: `bytes=${start + filled}-${end}` },
          cache: "no-store",
          redirect: "manual", // an expired link redirects to a page without CORS
        })
        if (res.type === "opaqueredirect" || res.status === 403 || res.status === 410) {
          await refreshLink(used)
          throw new Error("Download link expired")
        }
        if (res.status !== 206) throw new Error(`HTTP ${res.status}`)
        const reader = res.body.getReader()
        let unsignalled = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          const n = Math.min(value.length, total - filled)
          data.set(value.subarray(0, n), base + filled)
          filled += n
          Atomics.store(ctrl, field(slot, 2), filled)
          unsignalled += n
          if (unsignalled >= 256 * 1024) {
            unsignalled = 0
            signal()
          }
        }
        if (filled !== total) throw new Error("Short read")
        Atomics.store(ctrl, field(slot, 0), READY)
        break
      } catch (err) {
        if (attempt >= RETRIES) {
          Atomics.store(ctrl, field(slot, 0), FAILED)
          break
        }
        await new Promise((r) => setTimeout(r, 500 * attempt))
      }
    }
    signal()
    schedule()
  }

  async function loadTail() {
    const start = size - tailSize
    for (let attempt = 1; ; attempt++) {
      try {
        const used = link
        const res = await fetch(used, {
          headers: { Range: `bytes=${start}-${size - 1}` },
          cache: "no-store",
          redirect: "manual",
        })
        if (res.type === "opaqueredirect" || res.status === 403 || res.status === 410) {
          await refreshLink(used)
          throw new Error("Download link expired")
        }
        if (res.status !== 206) throw new Error(`HTTP ${res.status}`)
        const bytes = new Uint8Array(await res.arrayBuffer())
        if (bytes.length !== tailSize) throw new Error("Short read")
        data.set(bytes, slots * windowSize)
        Atomics.store(ctrl, TAIL_LENGTH, tailSize)
        break
      } catch {
        if (attempt >= RETRIES) {
          Atomics.store(ctrl, TAIL_LENGTH, -1)
          break
        }
        await new Promise((r) => setTimeout(r, 500 * attempt))
      }
    }
    signal()
  }

  port.onmessage = () => schedule() // the extractor moved on or is waiting
  loadTail() // first in the browser's connection queue
  schedule()
}
