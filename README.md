# datNowPlaying

A Chrome (Manifest V3) extension that watches your SoundCloud tab(s), finds the track
that is actually playing, and mirrors it to a folder you choose — one file per ticked
field, and optionally all of them combined into a single `nowplaying.json`.

Defaults on: the fields available with no extra request —

| File | Contents |
|------|----------|
| `track.txt`  | the track title |
| `artist.txt` | the artist name |
| `cover.*`    | the cover art (extension set from the real image type: `.jpg` / `.png` / `.webp` …) |
| `album.txt`  | album / playlist name |
| `track-url.txt` | the track URL |

Everything else is off by default and enabled per field in Settings: the live playback
fields, the whole **SoundCloud metadata** set (`genre.txt`, `label.txt`, `isrc.txt`, counts, …),
and `nowplaying.json` itself.

This matches the requested flow exactly:

1. look for SoundCloud tabs
2. check whether audio is playing
3. read the currently playing track
4. watch for changes
5. if it differs from what is on disk → update the files

Nothing is written while playback is paused or when no SoundCloud tab is playing.

## Repository layout

The extension lives at the repository root, so "Load unpacked" points straight at a
checkout (or at an unzipped release archive):

```
manifest.json          extension manifest (root = load this folder)
src/                   background service worker, content script, offscreen writer,
                       options/popup pages, shared lib/
src/lib/components.js  registry of every exportable field (sections, tiers, defaults)
src/lib/api.js         SoundCloud API access (Tier 1: client_id discovery + resolve)
icons/                 toolbar icons
scripts/               validate.sh, package.sh, make-icons.js, live-test.*
tests/                 unit tests + the CDP live test
```

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top-right)
3. Click **Load unpacked** and select the repository root (or an unzipped release)
4. Click the extension icon → **Settings** (or *Details → Extension options*)
5. Under **Save location** click **Choose folder…** and pick where the files should land
6. Play something on <https://soundcloud.com>

Use **Write a test file now** to confirm the folder works before you rely on it.

> No build step and no dependencies — the folder *is* the extension.

## How it works

```
SoundCloud tab                          extension
──────────────                          ─────────
 playbackSoundBadge (DOM)  ─┐
 navigator.mediaSession    ─┼─► content script ──► service worker ──► offscreen doc ──► your folder
 <audio>/<video> elements  ─┘   (reads state)      (assembles the    (owns the folder
                                                    enabled fields)   handle, writes files)
                                        Tier 1 API ↲
```

* **`src/content.js`** (isolated world, event-driven) reads the now-playing state from:
  * `navigator.mediaSession.metadata` — SoundCloud sets `title`, `artist` (uploader) and sized
    `artwork` entries; this is the primary, most reliable source;
  * the player bar DOM (`.playbackSoundBadge`) as a fallback and for paused/ad state;
  * any `<audio>`/`<video>` elements for real playback + position + volume.
  It is **event-driven** (DOM `MutationObserver` + capture-phase media events), so it stays
  accurate in background tabs where timers are throttled. A 2 s interval is only a backstop.
* **`src/background.js`** keeps the latest state per tab, picks the active one with
  `DNP.chooseActive` (playing & progressing & unmuted wins; ad breaks ignored), assembles the
  enabled components (`src/lib/components.js`), fetches Tier 1 metadata on a track change, and
  only writes when the track differs from what was last written.
* **`src/offscreen.js`** performs the disk I/O. It owns the `FileSystemDirectoryHandle`
  (persisted in IndexedDB) so the folder picker and the writer always agree. Writes are
  read-then-compare, so unchanged files are not re-written.

## Data you can export

Every field is a checkbox in Settings, grouped into sections. There is no separate
"write files" or "fetch metadata" switch — **the checkmarks are the switches**: each ticked
field gets its own file, and ticking any SoundCloud-metadata field is what enables the API
request.

* **Track details** (no extra request; on by default) — title, artist, cover art,
  album / playlist, track URL.
* **Live playback** (changes continuously; off by default, written only into
  `nowplaying.json` on a ~5 s throttle) — playing, ad-break, elapsed, remaining, duration,
  progress %, volume %, muted.
* **SoundCloud metadata** (Tier 1, one API request per track; **off by default**) — genre,
  tags, label, release date, uploaded, license, ISRC, publisher, writer, description, plays,
  likes, reposts, comments, downloads, uploader (+ URL, followers), waveform URL, hi-res
  cover URL, BPM, key, monetization.

`nowplaying.json` is itself off by default; turn it on under **Output**.

Tier 1 is only fetched when at least one SoundCloud-metadata field is enabled (otherwise no
API request is made at all). It uses SoundCloud's own `/resolve` endpoint. There is no public
API key, so the `client_id` is scraped from SoundCloud's web bundles exactly as their player
does, cached for a few hours, and re-discovered on `401/403`. No extra host permission is
needed.

### Multiple tabs

Every SoundCloud tab reports its state. The picker prefers a tab whose media element is
actively progressing and not muted, ignores ad playback, and otherwise uses the most recent
metadata. One track is chosen at a time — no interleaving.

## Cover art

SoundCloud serves artwork at size variants (`…-large.jpg`, `…-t500x500.jpg`). The writer tries
`-original` first, then `-t500x500`, then the URL as given, and takes the first that
downloads.

The **Cover art** setting names the output file and controls its format:

| Setting | Result |
|---------|--------|
| `cover` | whatever format SoundCloud served (`cover.jpg`, `cover.png`, …) |
| `cover.jpg` | always `.jpg` — converted from the source if it was not JPEG |
| `cover.png` | always `.png` — converted if needed |
| `cover.webp` | always `.webp` — converted if needed |

Conversion runs in the offscreen document via `OffscreenCanvas`; JPEG output is flattened onto
white first (JPEG has no alpha). If a source cannot be decoded (e.g. SVG), the write falls back
to the served format and reports a warning rather than failing. Any other extension is treated
as part of the base name, so nothing is renamed silently.

## Settings

* **Enabled** — the master switch, at the top: pause the whole pipeline.
* **Save location** — the folder (required).
* **Output** — write `nowplaying.json` (renameable). Off by default.
* **Component grid** — every field in its own section with a checkbox and a renameable file
  name. Track details are on by default; live playback and SoundCloud metadata are off.
* **Clear files when playback stops** — at the bottom.
* **Write a test file now** — exercises the real folder path.
* **Run self-test** — writes files + JSON into Chrome's private sandbox and reads them back.

## Notes & limitations

* **Folder access can be re-prompted by Chrome.** For safety, Chrome may drop a persisted
  folder grant after a restart. If writes stop, the badge shows `!` and the popup/options page
  says so — open **Settings** and click **Choose folder…** again.
* **Text files are overwritten in place**, so the write is not crash-atomic; for the tiny
  payloads here this is not a practical concern.
* A cover can't be written when the track has no artwork; the text files are still updated.
* **Tier 1 needs a track URL and a working `client_id`.** It only runs when a SoundCloud-
  metadata field is enabled; if scraping fails, the other files still update and the popup
  shows the API error.
* Fields SoundCloud doesn't have for a track (e.g. BPM, key) are written empty, not as
  `"null"`.
* SoundCloud ad breaks are detected and skipped, so ads don't overwrite your track.
* Only `soundcloud.com` (and subdomains) plus `sndcdn.com` CDNs are observed.

## Development

```bash
bash scripts/validate.sh      # manifest JSON, referenced files, JS syntax, html refs
node tests/run.js             # 34 unit + integration tests (no dependencies)
bash scripts/package.sh dev   # build dist/datNowPlaying-dev.zip exactly as released
node scripts/make-icons.js    # regenerate icons (only if you change the artwork)
```

`tests/live-cdp.js` + `scripts/live-test.bat` drive a real headless Chrome over the DevTools
Protocol (verifying the manifest loads, the service worker runs, the writer's file path and cover
conversion work, a real track resolves through the SoundCloud API, and the content script injects
into a live SoundCloud page). It must run with **Windows `node.exe`** and a Windows Chrome,
because a Windows Chrome's loopback DevTools port isn't reachable from WSL.

The extension files carry no minification and no bundler on purpose: what you read is what
Chrome runs.

## Releases

`.github/workflows/release.yml` cuts a release once a day (06:00 UTC) **only if `main`
has changed** since the last tag, or on demand from the Actions tab. It smoke-tests
`validate.sh` + the unit tests **before** tagging, then packages `manifest.json`, `src/`
and `icons/` into `datNowPlaying-<tag>.zip` and attaches it to the `v0.YYMMDD` tag.
Unzip that archive and "Load unpacked" the resulting folder.

## License

MIT — see [LICENSE](LICENSE).
