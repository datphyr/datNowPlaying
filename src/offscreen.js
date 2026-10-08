/*
 * Offscreen document: performs the actual disk I/O.
 *
 * It owns the FileSystemDirectoryHandle (persisted in IndexedDB), so both the
 * folder picker and the writer agree on one location. Writes are
 * read-then-compare to avoid churning unchanged files.
 *
 * Payload shape (from the service worker):
 *   { files: [{name, text}],        // one entry per enabled non-image component
 *     json:  {name, text} | null,   // nowplaying.json
 *     image: {name, url, lastImageName} | null,
 *     clear: bool }
 *
 * A diagnostics self-test ("dnp:selftest") writes the same shape into the
 * browser's private OPFS sandbox and reads the bytes back, exercising this code
 * path without needing a user gesture.
 */
(function () {
  'use strict';

  const MIME_EXT = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg'
  };

  async function getWritableDir() {
    const handle = await DNPIdb.getHandle();
    if (!handle) return { error: 'no-folder' };
    const opts = { mode: 'readwrite' };
    let perm = await handle.queryPermission(opts);
    if (perm !== 'granted') perm = await handle.requestPermission(opts);
    if (perm !== 'granted') return { error: 'permission-required' };
    return { handle };
  }

  async function readExisting(dir, name) {
    try {
      const fh = await dir.getFileHandle(name);
      return await (await fh.getFile()).text();
    } catch (e) { return null; }
  }

  async function writeTextIfChanged(dir, name, text) {
    const existing = await readExisting(dir, name);
    if (existing !== null && existing === text) return { name, changed: false };
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
    return { name, changed: true };
  }

  async function writeBytes(dir, name, bytes) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(bytes);
    await w.close();
    return { name, changed: true };
  }

  async function fetchArtwork(url, base) {
    let candidates;
    try {
      candidates = globalThis.DNP && globalThis.DNP.artworkCandidates ? globalThis.DNP.artworkCandidates(url) : [url];
    } catch (e) { candidates = [url]; }
    let lastErr = 'no-artwork-url';
    for (const candidate of candidates) {
      const abs = globalThis.DNP && globalThis.DNP.absUrl ? globalThis.DNP.absUrl(candidate, base) : candidate;
      try {
        const res = await fetch(abs, { credentials: 'omit', cache: 'no-store' });
        if (!res.ok) { lastErr = 'http ' + res.status; continue; }
        const buf = await res.arrayBuffer();
        if (!buf || !buf.byteLength) { lastErr = 'empty image'; continue; }
        const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        return { buffer: buf, ext: MIME_EXT[type] || 'jpg', url: abs };
      } catch (e) { lastErr = String((e && e.message) || e); }
    }
    return { error: lastErr };
  }

  // Core writer. `dir` is a FileSystemDirectoryHandle (user folder or OPFS).
  async function writeTo(dir, p) {
    p = p || {};
    const written = [];
    let imageName = null;

    if (p.clear) {
      for (const f of (p.files || [])) written.push(await writeTextIfChanged(dir, f.name, ''));
      return { ok: true, written, cleared: true };
    }

    for (const f of (p.files || [])) {
      written.push(await writeTextIfChanged(dir, f.name, f.text == null ? '' : String(f.text)));
    }

    if (p.json && p.json.name) {
      written.push(await writeTextIfChanged(dir, p.json.name, p.json.text || ''));
    }

    if (p.image && p.image.url) {
      const art = await fetchArtwork(p.image.url, p.base);
      if (art && art.buffer) {
        imageName = (p.image.name || 'cover') + '.' + art.ext;
        written.push(await writeBytes(dir, imageName, art.buffer));
        if (p.image.lastImageName && p.image.lastImageName !== imageName) {
          try { await dir.removeEntry(p.image.lastImageName); } catch (e) { /* ignore */ }
        }
      } else {
        return { ok: true, written, imageName: null, warning: 'artwork fetch failed: ' + (art && art.error) };
      }
    }

    return { ok: true, written, imageName };
  }

  async function writePayload(p) {
    let dir;
    if (p && p.dirOverride === 'opfs') {
      const root = await navigator.storage.getDirectory();
      dir = await root.getDirectoryHandle('dnp-selftest', { create: true });
    } else {
      const dirRes = await getWritableDir();
      if (dirRes.error) return { ok: false, error: dirRes.error };
      dir = dirRes.handle;
    }
    try { return await writeTo(dir, p); }
    catch (e) { return { ok: false, error: String((e && e.name ? e.name + ': ' : '') + ((e && e.message) || e)) }; }
  }

  async function selftest() {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('dnp-selftest', { create: true });
    // Real PNG bytes via a blob: URL, so the image path is exercised without
    // depending on host permissions.
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    const sample = {
      files: [
        { name: 'track.txt', text: 'Self-test Track' },
        { name: 'artist.txt', text: 'Self-test Artist' },
        { name: 'genre.txt', text: 'Self-test Genre' }
      ],
      json: { name: 'nowplaying.json', text: JSON.stringify({ title: 'Self-test Track', genre: 'Self-test Genre' }, null, 2) },
      image: { name: 'cover', url: objectUrl }
    };
    let w;
    try { w = await writeTo(dir, sample); }
    finally { URL.revokeObjectURL(objectUrl); }

    const back = {
      track: await readExisting(dir, 'track.txt'),
      artist: await readExisting(dir, 'artist.txt'),
      genre: await readExisting(dir, 'genre.txt'),
      json: await readExisting(dir, 'nowplaying.json')
    };
    let imageBytes = 0;
    try { imageBytes = (await (await dir.getFileHandle('cover.png')).getFile()).size; } catch (e) { /* none */ }

    let jsonOk = false;
    try { jsonOk = JSON.parse(back.json).genre === 'Self-test Genre'; } catch (e) { /* noop */ }

    return {
      ok: w.ok && back.track === 'Self-test Track' && back.artist === 'Self-test Artist' && jsonOk && imageBytes > 0,
      wrote: w.written,
      readBack: back,
      imageBytes,
      warning: w.warning,
      dir: 'opfs:/dnp-selftest'
    };
  }

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg || msg.target !== 'offscreen') return false;
    if (msg.type === 'dnp:write') {
      writePayload(msg.payload || {}).then(reply, (e) => reply({ ok: false, error: String(e) }));
      return true;
    }
    if (msg.type === 'dnp:selftest') {
      selftest().then(reply, (e) => reply({ ok: false, error: String((e && e.message) || e) }));
      return true;
    }
    return false;
  });
})();
