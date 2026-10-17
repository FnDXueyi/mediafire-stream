// Lists the entries of a remote RAR archive using small HTTP Range requests.
//
// RAR keeps a header in front of every entry, followed by the entry's data.
// Reading a header tells us how big the data is, so we can jump straight to
// the next header without downloading anything in between. For entries that
// are "stored" (not compressed) the data IS the file, so we also learn the
// exact byte range of e.g. a video inside the archive and can stream it.
//
// Formats: RAR 5 (signature Rar!\x1a\x07\x01\x00) and RAR 4 (Rar!\x1a\x07\x00).

const RAR5_SIG = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]
const RAR4_SIG = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]
const WINDOW = 64 * 1024 // bytes fetched per header read
const MAX_ENTRIES = 500

/**
 * @typedef {object} RarEntry
 * @property {string} name     path inside the archive, "/" separated
 * @property {number} size     unpacked size in bytes
 * @property {number} packed   bytes the entry occupies in the archive
 * @property {number} offset   where the entry's data starts in the archive
 * @property {boolean} stored  true when the data is the raw file (streamable)
 * @property {boolean} encrypted
 * @property {boolean} split   continues in another volume (.part2.rar …)
 */

/**
 * @param {string} url  direct URL of the archive (must allow CORS + Range)
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ format: "rar4" | "rar5", solid: boolean, entries: RarEntry[] }>}
 */
export async function listRar(url, { signal } = {}) {
  const read = async (start, length) => {
    const res = await fetch(url, {
      headers: { Range: `bytes=${start}-${start + length - 1}` },
      cache: "no-store",
      signal,
    })
    if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status}`)
    const buf = new Uint8Array(await res.arrayBuffer())
    // A server that ignores Range sends the whole file; keep only what we asked.
    return res.status === 200 ? buf.subarray(start, start + length) : buf
  }

  const head = await read(0, WINDOW)
  if (startsWith(head, RAR5_SIG)) return walkRar5(head, read)
  if (startsWith(head, RAR4_SIG)) return walkRar4(head, read)
  throw new Error("Not a RAR archive")
}

// ---------------------------------------------------------------- RAR 5 ---

async function walkRar5(first, read) {
  const out = { format: "rar5", solid: false, entries: [] }
  let pos = RAR5_SIG.length
  let buf = first
  let bufStart = 0

  while (out.entries.length < MAX_ENTRIES) {
    // Make sure the window holds at least the start of this header.
    if (pos - bufStart + 16 > buf.length) {
      buf = await read(pos, WINDOW)
      bufStart = pos
    }
    let p = { i: pos - bufStart + 4 } // skip header CRC32
    const headerSize = vint(buf, p)
    const headerStart = p.i
    if (headerStart + headerSize > buf.length) {
      buf = await read(pos, headerStart - (pos - bufStart) + headerSize)
      bufStart = pos
      p = { i: 4 }
      vint(buf, p)
    }
    const hdrBegin = p.i // == start of the header fields
    const type = vint(buf, p)
    const flags = vint(buf, p)
    const extraSize = flags & 0x01 ? vint(buf, p) : 0
    const dataSize = flags & 0x02 ? vint(buf, p) : 0

    if (type === 1) {
      const archiveFlags = vint(buf, p)
      out.solid = Boolean(archiveFlags & 0x04)
    } else if (type === 2) {
      const fileFlags = vint(buf, p)
      const size = vint(buf, p)
      vint(buf, p) // attributes
      if (fileFlags & 0x02) p.i += 4 // mtime
      if (fileFlags & 0x04) p.i += 4 // data CRC32
      const compression = vint(buf, p)
      vint(buf, p) // host OS
      const nameLength = vint(buf, p)
      const name = utf8(buf.subarray(p.i, p.i + nameLength))
      const extraStart = hdrBegin + headerSize - extraSize
      const encrypted = hasRar5Record(buf, extraStart, extraSize, 0x01)
      const dataStart = bufStart + hdrBegin + headerSize
      if (!(fileFlags & 0x01)) {
        out.entries.push({
          name,
          size,
          packed: dataSize,
          offset: dataStart,
          stored: ((compression >> 7) & 0x07) === 0 && !encrypted,
          encrypted,
          split: Boolean(flags & 0x18), // data continues to / from another volume
        })
      }
    } else if (type === 4) {
      throw new Error("Archive headers are encrypted (password protected)")
    } else if (type === 5) {
      break // end of archive
    }

    pos = bufStart + hdrBegin + headerSize + dataSize
  }
  return out
}

/** Does the extra area of a RAR5 header contain a record of `wanted` type? */
function hasRar5Record(buf, start, size, wanted) {
  const p = { i: start }
  const end = start + size
  while (p.i < end) {
    const recordSize = vint(buf, p)
    const next = p.i + recordSize
    if (vint(buf, p) === wanted) return true
    p.i = next
  }
  return false
}

/** RAR5 variable-length integer (7 bits per byte, little endian). */
function vint(buf, p) {
  let value = 0
  let scale = 1
  for (let n = 0; n < 10; n++) {
    const byte = buf[p.i++]
    if (byte === undefined) throw new Error("Truncated header")
    value += (byte & 0x7f) * scale
    if (!(byte & 0x80)) return value
    scale *= 128
  }
  throw new Error("Bad header")
}

// ---------------------------------------------------------------- RAR 4 ---

async function walkRar4(first, read) {
  const out = { format: "rar4", solid: false, entries: [] }
  let pos = RAR4_SIG.length
  let buf = first
  let bufStart = 0

  while (out.entries.length < MAX_ENTRIES) {
    if (pos - bufStart + 7 > buf.length) {
      buf = await read(pos, WINDOW)
      bufStart = pos
    }
    let at = pos - bufStart
    let dv = new DataView(buf.buffer, buf.byteOffset)
    const type = buf[at + 2]
    const flags = dv.getUint16(at + 3, true)
    const headerSize = dv.getUint16(at + 5, true)
    if (headerSize < 7) throw new Error("Bad header")
    if (at + headerSize > buf.length) {
      buf = await read(pos, headerSize)
      bufStart = pos
      at = 0
      dv = new DataView(buf.buffer, buf.byteOffset)
    }

    let addSize = flags & 0x8000 ? dv.getUint32(at + 7, true) : 0

    if (type === 0x73) {
      // archive header
      out.solid = Boolean(flags & 0x0008)
      if (flags & 0x0080) throw new Error("Archive headers are encrypted (password protected)")
    } else if (type === 0x74) {
      // file header
      let packed = dv.getUint32(at + 7, true)
      let size = dv.getUint32(at + 11, true)
      const method = buf[at + 25]
      const nameSize = dv.getUint16(at + 26, true)
      let nameAt = at + 32
      if (flags & 0x0100) {
        packed += dv.getUint32(at + 32, true) * 2 ** 32
        size += dv.getUint32(at + 36, true) * 2 ** 32
        nameAt += 8
      }
      addSize = packed
      const rawName = buf.subarray(nameAt, nameAt + nameSize)
      // With the unicode flag the name is "ascii\0<packed unicode>"; the ascii
      // part is good enough for display.
      const zero = rawName.indexOf(0)
      const name = utf8(zero >= 0 ? rawName.subarray(0, zero) : rawName).replaceAll("\\", "/")
      const isDir = (flags & 0x00e0) === 0x00e0
      const encrypted = Boolean(flags & 0x0004)
      if (!isDir) {
        out.entries.push({
          name,
          size,
          packed,
          offset: pos + headerSize,
          stored: method === 0x30 && !encrypted,
          encrypted,
          split: Boolean(flags & 0x0003),
        })
      }
    } else if (type === 0x7b) {
      break // end of archive
    }

    pos += headerSize + addSize
  }
  return out
}

// --------------------------------------------------------------- helpers ---

function startsWith(buf, sig) {
  return sig.every((b, i) => buf[i] === b)
}

function utf8(bytes) {
  return new TextDecoder().decode(bytes)
}
