/*
 * Offscreen document: performs the actual disk I/O.
 *
 * It owns the FileSystemDirectoryHandle (persisted in IndexedDB), so both the
 * folder picker and the writer agree on one location. Writes are
 * read-then-compare to avoid churning unchanged files.
 *
 * A diagnostics self-test ("scnp:selftest") writes into the browser's private
 * OPFS sandbox and reads the bytes back, exercising the exact same code path
 * without needing a user gesture.
 */
(function () {
  'use strict';

  const MIME_EXT = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg'
  };

  async function getWritableDir() {
    const handle = await SCNPIdb.getHandle();
    if (!handle) return { error: 'no-folder' };
    const opts = { mode: 'readwrite' };
    let perm = await handle.queryPermission(opts);
    if (perm !== 'granted') {
      perm = await handle.requestPermission(opts);
    }
    if (perm !== 'granted') return { error: 'permission-required' };
    return { handle };
  }

  async function readExisting(dir, name) {
    try {
      const fh = await dir.getFileHandle(name);
      const file = await fh.getFile();
      return await file.text();
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

  async function fetchArtwork(url, base) {
    let candidates;
    try {
      candidates = globalThis.SCNP && globalThis.SCNP.artworkCandidates
        ? globalThis.SCNP.artworkCandidates(url)
        : [url];
    } catch (e) { candidates = [url]; }
    let lastErr = 'no-artwork-url';
    for (const candidate of candidates) {
      const abs = globalThis.SCNP && globalThis.SCNP.absUrl ? globalThis.SCNP.absUrl(candidate, base) : candidate;
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
    const files = p.files || { title: 'track.txt', artist: 'artist.txt', image: 'cover' };
    const written = [];

    if (p.clear) {
      await writeTextIfChanged(dir, files.title, '');
      await writeTextIfChanged(dir, files.artist, '');
      return { ok: true, written, cleared: true };
    }

    written.push(await writeTextIfChanged(dir, files.title, p.title || ''));
    written.push(await writeTextIfChanged(dir, files.artist, p.artist || ''));

    let imageName = null;
    if (p.artworkUrl) {
      const art = await fetchArtwork(p.artworkUrl, p.base);
      if (art && art.buffer) {
        const baseName = files.image || 'cover';
        imageName = baseName + '.' + art.ext;
        const fh = await dir.getFileHandle(imageName, { create: true });
        const w = await fh.createWritable();
        await w.write(art.buffer);
        await w.close();
        written.push({ name: imageName, changed: true });
        if (p.lastImageName && p.lastImageName !== imageName) {
          try { await dir.removeEntry(p.lastImageName); } catch (e) { /* ignore */ }
        }
      } else {
        return { ok: true, written, imageName: null, warning: 'artwork fetch failed: ' + (art && art.error) };
      }
    }
    return { ok: true, written, imageName };
  }

  async function writePayload(p) {
    let dir = null;
    if (p && p.dirOverride === 'opfs') {
      const root = await navigator.storage.getDirectory();
      dir = await root.getDirectoryHandle('scnp-selftest', { create: true });
    } else {
      const dirRes = await getWritableDir();
      if (dirRes.error) return { ok: false, error: dirRes.error };
      dir = dirRes.handle;
    }
    try {
      return await writeTo(dir, p);
    } catch (e) {
      return { ok: false, error: String((e && e.name ? e.name + ': ' : '') + ((e && e.message) || e)) };
    }
  }

  async function selftest() {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('scnp-selftest', { create: true });
    // Build real PNG bytes in-browser and expose them via a blob: URL, so the
    // image fetch+write path is exercised without depending on host permissions.
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    const sample = { files: { title: 'track.txt', artist: 'artist.txt', image: 'cover' }, title: 'Self-test Track', artist: 'Self-test Artist', artworkUrl: objectUrl };
    let w;
    try {
      w = await writeTo(dir, sample);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
    const back = {
      track: await readExisting(dir, 'track.txt'),
      artist: await readExisting(dir, 'artist.txt')
    };
    let imageBytes = 0;
    try {
      const fh = await dir.getFileHandle('cover.png');
      imageBytes = (await fh.getFile()).size;
    } catch (e) { /* none */ }
    return {
      ok: w.ok && back.track === sample.title && back.artist === sample.artist && imageBytes > 0,
      wrote: w.written,
      readBack: back,
      imageBytes,
      warning: w.warning,
      dir: 'opfs:/scnp-selftest'
    };
  }

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg || msg.target !== 'offscreen') return false;
    if (msg.type === 'scnp:write') {
      writePayload(msg.payload || {}).then(reply, (e) => reply({ ok: false, error: String(e) }));
      return true;
    }
    if (msg.type === 'scnp:selftest') {
      selftest().then(reply, (e) => reply({ ok: false, error: String((e && e.message) || e) }));
      return true;
    }
    return false;
  });
})();
