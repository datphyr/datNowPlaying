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
 * The cover is downloaded and, when its name carries a target extension
 * (cover.jpg / cover.png / cover.webp), converted to that format with canvas.
 *
 * A diagnostics self-test ("dnp:selftest") writes the same shape into the
 * browser's private OPFS sandbox and reads the bytes back, exercising this code
 * path (including conversion) without needing a user gesture.
 */
(function () {
  'use strict';

  const MIME_EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg' };

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

  // Re-encode downloaded image bytes into the requested mime type using canvas.
  async function convertImage(buffer, sourceType, targetMime) {
    const srcBlob = new Blob([buffer], { type: sourceType || 'image/jpeg' });
    const bitmap = await createImageBitmap(srcBlob);
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      if (targetMime === 'image/jpeg') {         // JPEG has no alpha: flatten first
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(bitmap, 0, 0);
      const out = await canvas.convertToBlob({ type: targetMime, quality: 0.92 });
      return await out.arrayBuffer();
    } finally {
      if (bitmap.close) bitmap.close();
    }
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
        return { buffer: buf, type: type, url: abs };
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
      if (!art || !art.buffer) {
        return { ok: true, written, imageName: null, warning: 'artwork fetch failed: ' + (art && art.error) };
      }
      const t = DNPcover.resolveCoverTarget(p.image.name, art.type);
      const srcExt = MIME_EXT[art.type] || 'jpg';
      let bytes = art.buffer;
      let warning;
      if (t.convert) {
        try {
          bytes = await convertImage(art.buffer, art.type, t.mime);
        } catch (e) {
          // Conversion unsupported (e.g. SVG source): fall back to the original bytes.
          warning = 'could not convert to ' + t.ext + ', wrote ' + srcExt + ' instead';
        }
      }
      if (!bytes || bytes === art.buffer) {
        if (t.convert && warning) imageName = t.base + '.' + srcExt;
        else imageName = t.base + '.' + t.ext;
      } else {
        imageName = t.base + '.' + t.ext;
      }
      written.push(await writeBytes(dir, imageName, bytes));
      if (p.image.lastImageName && p.image.lastImageName !== imageName) {
        try { await dir.removeEntry(p.image.lastImageName); } catch (e) { /* ignore */ }
      }
      return { ok: true, written, imageName, warning };
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

  // Build a valid PNG in-browser and expose it via a blob: URL, so the image
  // path (and conversion) is exercised without host permissions or hand-written
  // bytes (a hand-assembled base64 PNG is easy to get subtly wrong).
  async function makeSamplePngUrl() {
    const c = new OffscreenCanvas(8, 8);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ff5500';
    ctx.fillRect(0, 0, 8, 8);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(2, 2, 4, 4);
    const blob = await c.convertToBlob({ type: 'image/png' });
    return URL.createObjectURL(blob);
  }

  async function readBytesSize(dir, name) {
    try { return (await (await dir.getFileHandle(name)).getFile()).size; } catch (e) { return 0; }
  }

  async function selftest() {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('dnp-selftest', { create: true });

    const url1 = await makeSamplePngUrl();
    const url2 = await makeSamplePngUrl();
    const steps = {};
    let w, wConv;
    try {
      w = await writeTo(dir, {
        files: [
          { name: 'track.txt', text: 'Self-test Track' },
          { name: 'artist.txt', text: 'Self-test Artist' },
          { name: 'genre.txt', text: 'Self-test Genre' }
        ],
        json: { name: 'nowplaying.json', text: JSON.stringify({ title: 'Self-test Track', genre: 'Self-test Genre' }, null, 2) },
        image: { name: 'cover', url: url1 }          // keep original extension
      });
      wConv = await writeTo(dir, {
        image: { name: 'art.jpg', url: url2 }        // force .jpg (convert from png)
      });
    } catch (e) {
      steps.writeError = String((e && e.message) || e);
    } finally {
      URL.revokeObjectURL(url1);
      URL.revokeObjectURL(url2);
    }

    // Probe the converter directly so a failure names the step that broke.
    try {
      const sampleCanvas = new OffscreenCanvas(4, 4);
      sampleCanvas.getContext('2d').fillRect(0, 0, 4, 4);
      const pngBuf = await (await sampleCanvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
      steps.convert = await convertImage(pngBuf, 'image/png', 'image/jpeg').then((b) => 'ok:' + b.byteLength).catch((e) => 'err:' + String((e && e.message) || e));
    } catch (e) { steps.convert = 'err:' + String((e && e.message) || e); }
    steps.hasCreateImageBitmap = typeof createImageBitmap === 'function';
    steps.hasOffscreenCanvas = typeof OffscreenCanvas === 'function';

    const back = {
      track: await readExisting(dir, 'track.txt'),
      artist: await readExisting(dir, 'artist.txt'),
      genre: await readExisting(dir, 'genre.txt'),
      json: await readExisting(dir, 'nowplaying.json')
    };
    const origPngBytes = await readBytesSize(dir, 'cover.png');
    const forcedJpgBytes = await readBytesSize(dir, 'art.jpg');
    let jsonOk = false;
    try { jsonOk = JSON.parse(back.json).genre === 'Self-test Genre'; } catch (e) { /* noop */ }

    const textOk = back.track === 'Self-test Track' && back.artist === 'Self-test Artist' && jsonOk;
    const conversionOk = forcedJpgBytes > 0 && (wConv && wConv.imageName === 'art.jpg');
    return {
      ok: !!(w && w.ok && textOk && origPngBytes > 0 && conversionOk),
      wrote: w && w.written,
      readBack: back,
      imageBytes: origPngBytes,
      converted: { name: wConv && wConv.imageName, bytes: forcedJpgBytes, warning: wConv && wConv.warning },
      steps: steps,
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
