/*
 * Unit + integration tests for datNowPlaying.
 *   node tests/run.js
 * No dependencies. Covers: metadata extraction (mediaSession + DOM + merge),
 * the active-tab chooser, artwork-variant logic, and the offscreen disk writer
 * (text files, dedupe, image extension handling) against a fake FS + fetch.
 */
'use strict';
const path = require('path');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; failures.push(name + ': ' + e.message); console.log('FAIL  ' + name + '\n      ' + e.message); }
}
function eq(a, b, msg) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((msg || 'not equal') + '\n      actual:   ' + sa + '\n      expected: ' + sb);
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }

const M = require(path.join(__dirname, '..', 'src', 'lib', 'metadata.js'));

/* ------------------------- fake DOM helpers ------------------------- */

function classList(...names) {
  const set = new Set(names);
  return { contains: (n) => set.has(n) };
}
function el(opts = {}) {
  return {
    tagName: opts.tagName || 'DIV',
    textContent: opts.textContent || '',
    currentSrc: opts.currentSrc || '',
    _attrs: opts.attrs || {},
    classList: opts.classList || classList(),
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this._attrs, n) ? this._attrs[n] : null; },
    querySelector(sel) { return (opts.map && opts.map[sel]) || null; }
  };
}
function fakeWin({ badgeMap, msMeta, baseURI = 'https://soundcloud.com/feed', playbackState = 'playing' }) {
  const badge = badgeMap ? el({ tagName: 'DIV', classList: badgeMap.classList, map: badgeMap.map }) : null;
  return {
    document: {
      baseURI,
      querySelector: (sel) => (sel === '.playbackSoundBadge' ? badge : null)
    },
    navigator: {
      mediaSession: msMeta === undefined ? undefined : { metadata: msMeta, playbackState }
    }
  };
}

/* --------------------------- artwork logic --------------------------- */

console.log('\nartwork candidates');
test('swaps -large for -original first', () => {
  eq(M.artworkCandidates('https://i1.sndcdn.com/artworks-abc-0-large.jpg')[0],
    'https://i1.sndcdn.com/artworks-abc-0-original.jpg');
});
test('handles -t500x500 variant', () => {
  const c = M.artworkCandidates('https://i1.sndcdn.com/artworks-abc-0-t500x500.jpg');
  eq(c[0], 'https://i1.sndcdn.com/artworks-abc-0-original.jpg');
});
test('keeps original url as a fallback', () => {
  const u = 'https://i1.sndcdn.com/artworks-abc-0-large.jpg';
  ok(M.artworkCandidates(u).indexOf(u) !== -1, 'fallback missing');
});
test('does not touch urls without a known variant', () => {
  const u = 'https://i1.sndcdn.com/avatars-xyz-abc.jpg';
  eq(M.artworkCandidates(u), [u]);
});
test('picks the largest mediaSession artwork', () => {
  eq(M.pickLargestArtwork([
    { src: 'a-t120x120.jpg', sizes: '120x120' },
    { src: 'a-t500x500.jpg', sizes: '500x500' },
    { src: 'a-t300x300.jpg', sizes: '300x300' }
  ]), 'a-t500x500.jpg');
});

/* ---------------------------- cleanTitle ----------------------------- */

console.log('\ncleanTitle');
test('strips the "Current track:" aria prefix', () => {
  eq(M.cleanTitle('Current track: Foo — Bar'), 'Foo — Bar');
});
test('collapses whitespace', () => eq(M.cleanTitle('  hello   world '), 'hello world'));

/* ------------------------ mediaSession parsing ----------------------- */

console.log('\nmediaSession extraction');
test('reads title/artist/artwork', () => {
  const win = fakeWin({
    badgeMap: null,
    msMeta: {
      title: 'My Song', artist: 'The Artist', album: 'An Album',
      artwork: [{ src: 'cover-t500x500.jpg', sizes: '500x500' }, { src: 'cover-t120x120.jpg', sizes: '120x120' }]
    }
  });
  const r = M.extractFromMediaSession(win.navigator);
  eq(r.title, 'My Song');
  eq(r.artist, 'The Artist');
  eq(r.artworkUrl, 'cover-t500x500.jpg');
  eq(r.album, 'An Album');
});
test('returns null without metadata', () => {
  eq(M.extractFromMediaSession({ mediaSession: null }), null);
  eq(M.extractFromMediaSession({}), null);
});

/* ------------------------- DOM (badge) parsing ----------------------- */

console.log('\nDOM extraction');
function badgeFixture({ paused = false, ad = false, title = 'Song', artist = 'Artist', img = null } = {}) {
  const titleLink = el({
    tagName: 'A', textContent: title,
    attrs: { title, href: '/artist/song' }
  });
  const lightLink = el({ tagName: 'A', textContent: artist });
  const image = img ? el({ tagName: 'IMG', attrs: { src: img } }) : null;
  return {
    classList: classList(paused ? 'paused' : 'playing', ...(ad ? ['is-adPlaying'] : [])),
    map: {
      'a.playbackSoundBadge__titleLink, .playbackSoundBadge__titleLink': titleLink,
      '.playbackSoundBadge__lightLink': lightLink,
      '.playbackSoundBadge__avatar img': image
    }
  };
}
test('reads title, artist, artwork, track url', () => {
  const win = fakeWin({ badgeMap: badgeFixture({ title: 'Cool Track', artist: 'DJ Test', img: 'https://i1.sndcdn.com/x-large.jpg' }) });
  const r = M.extractFromDom(win.document);
  eq(r.title, 'Cool Track');
  eq(r.artist, 'DJ Test');
  eq(r.artworkUrl, 'https://i1.sndcdn.com/x-large.jpg');
  eq(r.trackUrl, 'https://soundcloud.com/artist/song');
  eq(r.paused, false);
});
test('detects paused state', () => {
  const r = M.extractFromDom(fakeWin({ badgeMap: badgeFixture({ paused: true }) }).document);
  eq(r.paused, true);
  eq(r.playbackState, 'paused');
});
test('detects ad playback', () => {
  const r = M.extractFromDom(fakeWin({ badgeMap: badgeFixture({ ad: true }) }).document);
  eq(r.isAd, true);
});
test('falls back to textContent when title attr is absent', () => {
  const tl = el({ tagName: 'A', textContent: 'Text Title' });
  const badge = { classList: classList('playing'), map: {
    'a.playbackSoundBadge__titleLink, .playbackSoundBadge__titleLink': tl,
    '.playbackSoundBadge__lightLink': el({ textContent: 'A' }),
    '.playbackSoundBadge__avatar img': null
  } };
  const win = fakeWin({ badgeMap: badge });
  eq(M.extractFromDom(win.document).title, 'Text Title');
});
test('returns null when there is no badge', () => {
  eq(M.extractFromDom(fakeWin({ badgeMap: null }).document), null);
});

/* --------------------------- merge (extractBest) --------------------- */

console.log('\nextractBest merge');
test('mediaSession title wins, DOM provides ad/paused', () => {
  const win = fakeWin({ badgeMap: badgeFixture({ title: 'DOM Title', artist: 'DOM Artist' }), msMeta: { title: 'MS Title', artist: 'MS Artist', artwork: [] } });
  const r = M.extractBest(win);
  eq(r.title, 'MS Title');
  eq(r.artist, 'MS Artist');
  eq(r.isAd, false);
});
test('DOM used when mediaSession empty', () => {
  const win = fakeWin({ badgeMap: badgeFixture({ title: 'Only DOM', artist: 'Only Artist' }), msMeta: undefined });
  const r = M.extractBest(win);
  eq(r.title, 'Only DOM');
});
test('handles a page with neither source', () => {
  const r = M.extractBest({ document: { querySelector: () => null, baseURI: 'https://soundcloud.com/' }, navigator: {} });
  eq(r.title, null);
  eq(r.playbackState, 'none');
});

/* --------------------------- chooseActive ---------------------------- */

console.log('\nchooseActive (multi-tab)');
test('prefers the progressing, unmuted playing tab', () => {
  const r = M.chooseActive([
    { playing: true, muted: true, progressing: true, title: 'Muted', updatedAt: 100 },
    { playing: true, muted: false, progressing: true, title: 'Real', updatedAt: 50 }
  ]);
  eq(r.active.title, 'Real');
  eq(r.playing, true);
});
test('ignores ad breaks', () => {
  const r = M.chooseActive([
    { playing: true, isAd: true, title: 'Ad', updatedAt: 999 },
    { playing: true, isAd: false, title: 'Song', updatedAt: 1 }
  ]);
  eq(r.active.title, 'Song');
});
test('falls back to most recent metadata when nothing plays', () => {
  const r = M.chooseActive([
    { playing: false, title: 'Old', updatedAt: 10 },
    { playing: false, title: 'Newer', updatedAt: 20 }
  ]);
  eq(r.active.title, 'Newer');
  eq(r.playing, false);
});
test('no tabs -> null', () => {
  const r = M.chooseActive([]);
  eq(r.active, null);
  eq(r.playing, false);
});

/* --------------------------- host detection -------------------------- */

console.log('\nhost detection');
test('accepts soundcloud hosts', () => {
  ok(M.isSoundCloudUrl('https://soundcloud.com/artist/track'));
  ok(M.isSoundCloudUrl('https://m.soundcloud.com/x'));
  ok(!M.isSoundCloudUrl('https://soundcloud.com.evil.test/x'));
  ok(!M.isSoundCloudUrl('https://example.com/'));
});

/* ======================= offscreen writer integration ================= */

console.log('\noffscreen writer (fake FS + fetch)');

function makeEnv() {
  // fresh module registry for offscreen.js
  const offscreenPath = path.join(__dirname, '..', 'src', 'offscreen.js');
  delete require.cache[require.resolve(offscreenPath)];

  const files = new Map();
  const removed = [];
  const fetched = [];

  function fileHandle(name) {
    return {
      async getFile() {
        if (!files.has(name)) { const e = new Error('NotFoundError'); e.name = 'NotFoundError'; throw e; }
        return { text: async () => files.get(name).data.toString('utf8') };
      },
      async createWritable() {
        return {
          async write(d) { files.set(name, { data: Buffer.isBuffer(d) ? d : Buffer.from(String(d), 'utf8') }); },
          async close() {}
        };
      }
    };
  }
  const dir = {
    name: 'FakeFolder',
    async queryPermission() { return 'granted'; },
    async requestPermission() { return 'granted'; },
    async getFileHandle(name) { return fileHandle(name); },
    async removeEntry(name) { removed.push(name); files.delete(name); }
  };

  const handlers = [];
  globalThis.chrome = { runtime: { onMessage: { addListener: (fn) => handlers.push(fn) } } };
  globalThis.DNP = M;
  globalThis.DNPIdb = { getHandle: async () => dir };
  globalThis.fetch = async (url) => {
    fetched.push(url);
    if (/fail/.test(url)) return { ok: false, status: 404, headers: { get: () => null } };
    const type = /webp/.test(url) ? 'image/webp' : 'image/jpeg';
    return {
      ok: true, status: 200,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? type : null) },
      async arrayBuffer() { return Uint8Array.from([1, 2, 3, 4]).buffer; }
    };
  };
  require(offscreenPath);
  const handler = handlers[0];
  const write = (payload) => new Promise((resolve) => handler({ target: 'offscreen', type: 'dnp:write', payload }, {}, resolve));
  return { write, files, removed, fetched, dir };
}

(async () => {
  const C = require(path.join(__dirname, '..', 'src', 'lib', 'components.js'));
  const A = require(path.join(__dirname, '..', 'src', 'lib', 'api.js'));

  /* ------------------------ component registry ------------------------ */
  test('registry: core three default on', () => {
    const d = C.defaults();
    eq(d.components.title.enabled, true);
    eq(d.components.artist.enabled, true);
    eq(d.components.cover.enabled, true);
    eq(d.components.cover.file, 'cover');
  });
  test('registry: non-dynamic tier 0 + tier 1 default on, dynamic default off', () => {
    const d = C.defaults();
    eq(d.components.genre.enabled, true);      // tier 1
    eq(d.components.label.enabled, true);      // tier 1
    eq(d.components.album.enabled, true);      // tier 0 static
    eq(d.components.elapsed.enabled, false);   // dynamic
    eq(d.components.volume.enabled, false);    // dynamic
  });
  test('registry: merge fills missing components from defaults', () => {
    const m = C.merge({ components: { genre: { enabled: false, file: 'g.txt' } } });
    eq(m.components.genre.enabled, false);
    eq(m.components.genre.file, 'g.txt');
    eq(m.components.title.enabled, true);      // untouched -> default
  });
  test('registry: every component has a unique id and file', () => {
    const ids = C.ALL.map((c) => c.id);
    eq(ids.length, new Set(ids).size);
    const files = C.ALL.map((c) => c.file);
    eq(files.length, new Set(files).size);
  });

  /* --------------------------- api field picker ----------------------- */
  test('api: pickTrackFields maps the SoundCloud payload', () => {
    const f = A.pickTrackFields({
      genre: 'Electronic', tag_list: 'downtempo', label_name: 'sonarkollektiv',
      release_date: '2003-06-02T00:00:00Z', created_at: '2007-09-22T14:45:46Z',
      license: 'all-rights-reserved', playback_count: 969998, likes_count: 2616,
      reposts_count: 413, comment_count: 399, download_count: 19395,
      waveform_url: 'https://wave.sndcdn.com/x_m.json', artwork_url: 'https://i1.sndcdn.com/a-large.jpg',
      monetization_model: 'AD_SUPPORTED', bpm: null, key_signature: null,
      user: { username: 'Forss', permalink_url: 'https://soundcloud.com/forss', followers_count: 132117 },
      publisher_metadata: { isrc: 'DEP960300042', publisher: 'Universal Music Publishing', writer_composer: 'Eric Wahlforss' }
    });
    eq(f.genre, 'Electronic');
    eq(f.label, 'sonarkollektiv');
    eq(f.isrc, 'DEP960300042');
    eq(f.writer, 'Eric Wahlforss');
    eq(f.uploader, 'Forss');
    eq(f.playbackCount, '969998');
    eq(f.coverUrl, 'https://i1.sndcdn.com/a-large.jpg');
    eq(f.bpm, '');   // null -> empty string, not 'null'
  });

  /* ----------------------- offscreen writer --------------------------- */
  {
    const env = makeEnv();
    const res = await env.write({
      files: [{ name: 'track.txt', text: 'T' }, { name: 'artist.txt', text: 'A' }, { name: 'genre.txt', text: 'Electronic' }],
      json: { name: 'nowplaying.json', text: JSON.stringify({ title: 'T', genre: 'Electronic' }, null, 2) },
      image: { name: 'cover', url: 'https://i1.sndcdn.com/x-large.jpg' }
    });
    test('writes one file per component + json + cover', () => {
      ok(res.ok, 'not ok: ' + JSON.stringify(res));
      eq(env.files.get('track.txt').data.toString(), 'T');
      eq(env.files.get('artist.txt').data.toString(), 'A');
      eq(env.files.get('genre.txt').data.toString(), 'Electronic');
      eq(JSON.parse(env.files.get('nowplaying.json').data.toString()).genre, 'Electronic');
      ok(env.files.get('cover.jpg'), 'cover.jpg missing');
      eq(res.imageName, 'cover.jpg');
    });
    test('tries the -original artwork variant first', () => {
      eq(env.fetched[0], 'https://i1.sndcdn.com/x-original.jpg');
    });
    test('reports unchanged on a repeat write', async () => {
      const res2 = await env.write({
        files: [{ name: 'track.txt', text: 'T' }],
        json: { name: 'nowplaying.json', text: JSON.stringify({ title: 'T', genre: 'Electronic' }, null, 2) },
        image: { name: 'cover', url: 'https://i1.sndcdn.com/x-large.jpg' }
      });
      eq(res2.written.find((w) => w.name === 'track.txt').changed, false);
      eq(res2.written.find((w) => w.name === 'nowplaying.json').changed, false);
    });
  }
  {
    const env = makeEnv();
    const res = await env.write({ files: [{ name: 'track.txt', text: '' }, { name: 'genre.txt', text: '' }], clear: true });
    test('clear empties the text files', () => {
      ok(res.ok);
      eq(env.files.get('track.txt').data.toString(), '');
    });
  }
  {
    const env = makeEnv();
    const res = await env.write({
      files: [{ name: 'track.txt', text: 'T' }],
      json: { name: 'nowplaying.json', text: '{}' },
      image: { name: 'cover', url: 'https://i1.sndcdn.com/x-fail.jpg' }
    });
    test('survives an artwork fetch failure and still writes text + json', () => {
      ok(res.ok, 'not ok');
      eq(env.files.get('track.txt').data.toString(), 'T');
      ok(env.files.get('nowplaying.json'), 'json missing');
      ok(/fetch/.test(res.warning || ''), 'expected a warning, got ' + JSON.stringify(res.warning));
    });
  }
  {
    const env = makeEnv();
    await env.write({ files: [{ name: 'cover', text: '' }], image: { name: 'cover', url: 'https://i1.sndcdn.com/x-large.jpg' } });
    const res = await env.write({ image: { name: 'cover', url: 'https://i1.sndcdn.com/x-webp.webp', lastImageName: 'cover.jpg' } });
    test('removes the previous cover when the extension changes', () => {
      eq(res.imageName, 'cover.webp');
      ok(env.removed.includes('cover.jpg'), 'cover.jpg not removed: ' + JSON.stringify(env.removed));
    });
  }
  {
    const env = makeEnv();
    globalThis.DNPIdb = { getHandle: async () => null };
    const res = await env.write({ files: [{ name: 'x.txt', text: 'x' }] });
    test('reports no-folder when unset', () => eq(res, { ok: false, error: 'no-folder' }));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { failures.forEach((f) => console.log(' - ' + f)); process.exit(1); }
})();
