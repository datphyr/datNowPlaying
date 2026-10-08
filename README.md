# datNowPlaying

A Chrome (Manifest V3) extension that watches your SoundCloud tab(s), finds the track
that is actually playing, and mirrors it to **three files** in a folder you choose:

| File | Contents |
|------|----------|
| `track.txt`  | the track title |
| `artist.txt` | the artist name |
| `cover.*`    | the cover art (extension set from the real image type: `.jpg` / `.png` / `.webp` …) |

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
 <audio>/<video> elements  ─┘   (reads state)      (chooses the      (owns the folder
                                                    active track)     handle, writes files)
```

* **`src/content.js`** (isolated world, event-driven) reads the now-playing state from:
  * `navigator.mediaSession.metadata` — SoundCloud sets `title`, `artist` (uploader) and sized
    `artwork` entries; this is the primary, most reliable source;
  * the player bar DOM (`.playbackSoundBadge`) as a fallback and for paused/ad state;
  * any `<audio>`/`<video>` elements for real playback + position.
  It is **event-driven** (DOM `MutationObserver` + capture-phase media events), so it stays
  accurate in background tabs where timers are throttled. A 2 s interval is only a backstop.
* **`src/background.js`** keeps the latest state per tab, picks the active one with
  `DNP.chooseActive` (playing & progressing & unmuted wins; ad breaks ignored), and only
  writes when the track differs from what was last written.
* **`src/offscreen.js`** performs the disk I/O. It owns the `FileSystemDirectoryHandle`
  (persisted in IndexedDB) so the folder picker and the writer always agree. Writes are
  read-then-compare, so unchanged files are not re-written.

### Multiple tabs

Every SoundCloud tab reports its state. The picker prefers a tab whose media element is
actively progressing and not muted, ignores ad playback, and otherwise uses the most recent
metadata. One track is chosen at a time — no interleaving.

## Cover art

SoundCloud serves artwork at size variants (`…-large.jpg`, `…-t500x500.jpg`). The writer tries
`-original` first, then `-t500x500`, then the URL as given, and takes the first that
downloads. The file extension follows the real `Content-Type`.

## Settings

* **Save location** — the folder (required).
* **File names** — rename any of the three outputs; the image name has its extension added
  automatically.
* **Enabled** — pause the whole pipeline.
* **Clear files when playback stops** — empties the two text files when nothing is playing
  (the cover is left in place).
* **Write a test file now** — exercises the real folder path.
* **Run self-test** — writes the three files into Chrome's private sandbox and reads them
  back; useful when diagnosing.

## Notes & limitations

* **Folder access can be re-prompted by Chrome.** For safety, Chrome may drop a persisted
  folder grant after a restart. If writes stop, the badge shows `!` and the popup/options page
  says so — open **Settings** and click **Choose folder…** again.
* **`track.txt` / `artist.txt` are overwritten in place**, so the write is not crash-atomic;
  for the tiny payloads here this is not a practical concern.
* A cover can't be written when the track has no artwork; the text files are still updated.
* SoundCloud ad breaks are detected and skipped, so ads don't overwrite your track.
* Only `soundcloud.com` (and subdomains) is observed; the extension requests no other hosts.

## Development

```bash
bash scripts/validate.sh      # manifest JSON, referenced files, JS syntax, html refs
node tests/run.js             # 28 unit + integration tests (no dependencies)
bash scripts/package.sh dev   # build dist/datNowPlaying-dev.zip exactly as released
node scripts/make-icons.js    # regenerate icons (only if you change the artwork)
```

`tests/live-cdp.js` + `scripts/live-test.bat` drive a real headless Chrome over the DevTools
Protocol (verifying the manifest loads, the service worker runs, the writer's file path works,
and the content script injects into a live SoundCloud page). It must run with **Windows
`node.exe`** and a Windows Chrome, because a Windows Chrome's loopback DevTools port isn't
reachable from WSL.

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
