# mediafire-stream

Open a public MediaFire folder, see what's inside its RAR archives, and play
the videos in the browser. Nothing is saved to disk.

## How it works

- **Listing**: MediaFire's folder API allows any origin, so the page lists
  the folder (and subfolders) itself.
- **Inside the archives**: [`public/rar.js`](public/rar.js) reads only the RAR
  headers with small HTTP Range requests. It handles RAR 4 and RAR 5, and
  archives with any number of files.
- **Stored entries** (packed with WinRAR's "Store" mode): the video bytes sit
  unchanged inside the archive, so [`public/sw.js`](public/sw.js), a Service
  Worker, maps the player's range requests onto the archive. You can seek
  right away, whatever the size.
- **Compressed entries**: they have to be decompressed from the start.
  [`public/extract-worker.js`](public/extract-worker.js) runs UnRAR
  (WebAssembly) on the archive as it streams in, while
  [`public/fetch-worker.js`](public/fetch-worker.js) downloads windows ahead in
  parallel (6 x 32 MB, the most a browser opens to one HTTP/1.1 host).
  When MediaFire expires the download link mid-way, a fresh one is fetched
  and the download continues. The output is kept in the tab's memory, so it needs RAM roughly
  the size of the video. If the video's index (moov) is at the end of the
  file, playback starts once extraction finishes.
- **The one server job**: the direct download link sits on MediaFire's file
  page, which other sites can't read (CORS). The small Node server
  ([`server/mediafire.ts`](server/mediafire.ts)) fetches that page and returns
  the link. The video data itself goes straight from MediaFire to the browser.

## Run it

Requires Node.js 22.18 or newer. There's nothing to install.

```bash
npm start      # http://127.0.0.1:8788
npm run dev    # same, restarts on server changes
```

Paste a folder link like `https://www.mediafire.com/folder/<key>/<name>`, or
open `/?url=<link>` directly.

## Limits

- Password-protected and multi-part (`.part1.rar`) archives aren't supported.
- Compressed entries need free RAM about the size of the video. Very large
  ones (around 2 GB and up) may not fit, depending on the browser.
- Parallel download needs a cross-origin isolated page. The server sends the
  COOP/COEP headers for that. Without them extraction falls back to one
  request at a time, which is slower.
- Playback depends on the browser's codecs: MP4/H.264 and WebM play
  everywhere, while MKV and HEVC depend on the browser.

## Layout

```
server/index.ts           node:http: public/ + GET /api/link?key=<quickkey>
server/mediafire.ts       finds the direct download link on a file page
public/index.html         UI
public/app.js             listing, rows, playback
public/mediafire.js       MediaFire folder API
public/rar.js             RAR 4/5 header reader over HTTP Range
public/sw.js              Service Worker: /stream for stored and in-memory files
public/extract.js         in-memory file store, starts the workers
public/extract-worker.js  UnRAR WebAssembly, decompresses one entry
public/fetch-worker.js    parallel download into shared memory
public/vendor/unrar/      node-unrar-js 2.0.2 (MIT), see its README
```

## Disclaimer

This project is for **educational and research purposes**. It's a study of
RAR archives, HTTP range requests, Service Workers and WebAssembly in the
browser.

- **No affiliation.** This project is not affiliated with, endorsed by, or
  connected to MediaFire or RARLAB. All names and trademarks belong to their
  respective owners.
- **No content.** It hosts, mirrors, or distributes no files. It only plays
  files that MediaFire already serves publicly.
- **No circumvention of access control.** It uses no accounts, credentials,
  paid features, or DRM, and gets no access the site doesn't give any visitor.
- **Your responsibility.** You are responsible for what you open with it and
  for following the terms of service and laws that apply to you. The
  software comes with no warranty (see [LICENSE](LICENSE)).

**Rights holders:** if you have a concern about this project, please
[open an issue](../../issues) first. Reasonable requests will be addressed
promptly.

## License

[MIT](LICENSE). The vendored UnRAR WebAssembly build is covered by its own
licenses, see [`public/vendor/unrar`](public/vendor/unrar).
