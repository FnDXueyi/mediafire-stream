// Finds the direct download URL of a public MediaFire file.
//
// Everything else (folder listing, reading archives, streaming) happens in the
// browser. This is the one step that can't: the file page that carries the
// link only allows www.mediafire.com to read it (CORS), and the API's
// direct_download link type needs a login.

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"

/** MediaFire quick keys are short lowercase alphanumerics. */
const QUICK_KEY_RE = /^[a-z0-9]{8,20}$/i
/** Only links to MediaFire's own download servers are handed out. */
const DOWNLOAD_HOST_RE = /^download\d*\.mediafire\.com$/i

export class LinkError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "LinkError"
    this.status = status
  }
}

export function isQuickKey(key: string): boolean {
  return QUICK_KEY_RE.test(key)
}

export async function resolveDirectLink(
  quickKey: string,
  { signal }: { signal?: AbortSignal } = {}
): Promise<string> {
  if (!isQuickKey(quickKey)) throw new LinkError(400, "Invalid file key.")

  let res: Response
  try {
    res = await fetch(`https://www.mediafire.com/file/${quickKey}/`, {
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9" },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    })
  } catch (err) {
    throw new LinkError(502, `Could not reach MediaFire: ${(err as Error).message}`)
  }
  if (!res.ok) throw new LinkError(502, `MediaFire answered HTTP ${res.status}.`)

  const link = findDownloadLink(await res.text())
  if (!link) {
    throw new LinkError(404, "No download link on the file page (removed, private or password protected?).")
  }
  return link
}

/** Pulls the download URL out of a MediaFire file page. */
export function findDownloadLink(html: string): string | null {
  const candidates: string[] = []

  // <a ... href="https://download1234.mediafire.com/..." id="downloadButton">
  for (const m of html.matchAll(/href="(https?:\/\/download\d*\.mediafire\.com\/[^"]+)"/gi)) {
    candidates.push(m[1])
  }
  // Some page versions ship it base64-encoded in data-scrambled-url.
  for (const m of html.matchAll(/data-scrambled-url="([A-Za-z0-9+/=]+)"/g)) {
    try {
      candidates.push(Buffer.from(m[1], "base64").toString("utf8"))
    } catch {
      // not base64 after all
    }
  }

  for (const raw of candidates) {
    try {
      const url = new URL(raw.replaceAll("&amp;", "&"))
      if (url.protocol === "https:" && DOWNLOAD_HOST_RE.test(url.hostname)) return url.href
    } catch {
      // keep looking
    }
  }
  return null
}
