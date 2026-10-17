// MediaFire's public API allows any origin (CORS *), so folder listing runs
// straight from the browser. Only the direct download link needs the local
// server (/api/link), see server/mediafire.ts.

const API = "https://www.mediafire.com/api/1.5"

/**
 * Pulls the folder or file key out of a MediaFire URL.
 * @returns {{ kind: "folder" | "file", key: string } | null}
 */
export function parseMediafireUrl(input) {
  const text = input.trim()
  const folder = text.match(/mediafire\.com\/folder\/([a-z0-9]+)/i)
  if (folder) return { kind: "folder", key: folder[1] }
  const file = text.match(/mediafire\.com\/(?:file|file_premium|view|download)\/([a-z0-9]+)/i)
  if (file) return { kind: "file", key: file[1] }
  const legacy = text.match(/mediafire\.com\/\?([a-z0-9]+)/i)
  if (legacy) return { kind: "file", key: legacy[1] }
  if (/^[a-z0-9]{11,15}$/i.test(text)) return { kind: "folder", key: text }
  return null
}

async function api(path, params, signal) {
  const query = new URLSearchParams({ ...params, response_format: "json" })
  const res = await fetch(`${API}/${path}?${query}`, { signal, cache: "no-store" })
  const body = await res.json().catch(() => null)
  const response = body?.response
  if (!res.ok || response?.result !== "Success") {
    throw new Error(response?.message ?? `MediaFire API error (HTTP ${res.status})`)
  }
  return response
}

/**
 * @typedef {object} MfFile
 * @property {string} key   quick key
 * @property {string} name
 * @property {number} size
 * @property {string} path  folder path inside the shared folder, "" at the root
 */

/**
 * Lists every file in a folder, descending into subfolders.
 * @returns {Promise<{ name: string, files: MfFile[] }>}
 */
export async function listFolder(folderKey, { signal } = {}) {
  const info = await api("folder/get_info.php", { folder_key: folderKey }, signal)
  const files = []

  async function walk(key, path, depth) {
    for (const type of ["files", "folders"]) {
      for (let chunk = 1; ; chunk++) {
        const res = await api(
          "folder/get_content.php",
          { folder_key: key, content_type: type, chunk, chunk_size: 1000 },
          signal
        )
        const content = res.folder_content
        for (const item of content[type] ?? []) {
          if (type === "files") {
            files.push({ key: item.quickkey, name: item.filename, size: Number(item.size), path })
          } else if (depth < 10) {
            await walk(item.folderkey, path ? `${path}/${item.name}` : item.name, depth + 1)
          }
        }
        if (content.more_chunks !== "yes") break
      }
    }
  }

  await walk(folderKey, "", 0)
  return { name: info.folder_info.name, files }
}

/** @returns {Promise<{ name: string, files: MfFile[] }>} */
export async function getFile(quickKey, { signal } = {}) {
  const res = await api("file/get_info.php", { quick_key: quickKey }, signal)
  const f = res.file_info
  return { name: f.filename, files: [{ key: f.quickkey, name: f.filename, size: Number(f.size), path: "" }] }
}

/** Direct download URL for a file, via the local server. */
export async function directLink(quickKey, { fresh = false, signal } = {}) {
  const query = new URLSearchParams({ key: quickKey, ...(fresh ? { fresh: "1" } : {}) })
  const res = await fetch(`/api/link?${query}`, { signal })
  const body = await res.json().catch(() => null)
  if (!body?.ok) throw new Error(body?.error ?? `Link lookup failed (HTTP ${res.status})`)
  return body.url
}
