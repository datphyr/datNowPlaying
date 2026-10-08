/*
 * datNowPlaying - service worker.
 *
 * Responsibilities:
 *   - collect per-tab state pushed by the content script
 *   - decide which tab is "the" playing tab (pure logic in lib/metadata.js)
 *   - assemble the enabled components (lib/components.js) into values
 *   - fetch Tier 1 metadata from the SoundCloud API (lib/api.js) on track change
 *   - hand a write payload to the offscreen document (nowplaying.json + one file
 *     per enabled component + the cover image)
 *   - keep the toolbar badge + stored status for the popup/options UI
 */
importScripts('lib/components.js', 'lib/api.js', 'lib/metadata.js');

const tabStates = new Map();   // tabId -> latest state from the content script
let lastWritten = null;        // dedupe key for the currently-written track
let lastApiFields = null;      // last Tier 1 fields, reused for dynamic updates
let reconciling = null;
let reconcileTimer = null;
let dynamicTimer = null;
let offscreenCreating = null;

const DYNAMIC_MS = 5000;       // how often live fields land in nowplaying.json
const API_TIMEOUT_MS = 12000;

/* ------------------------------- storage -------------------------------- */

async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  return globalThis.DNPcomponents.merge(stored.settings);
}

async function setStatus(patch) {
  const stored = await chrome.storage.local.get('status');
  const status = { ...(stored.status || {}), ...patch, at: Date.now() };
  await chrome.storage.local.set({ status });
}

/* -------------------------------- badge --------------------------------- */

async function paintBadge() {
  for (const [tabId, st] of tabStates) {
    const on = !!(st && st.playing);
    try {
      await chrome.action.setBadgeText({ tabId, text: on ? '\u25B6' : '' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: on ? '#f50' : '#888888' });
      await chrome.action.setTitle({
        tabId,
        title: on
          ? `datNowPlaying: ${[st.artist, st.title].filter(Boolean).join(' \u2014 ') || 'playing'}`
          : 'datNowPlaying'
      });
    } catch (e) { /* tab gone */ }
  }
}

/* ------------------------- offscreen writer setup ------------------------ */

async function ensureOffscreen() {
  try {
    if (chrome.offscreen.hasDocument && await chrome.offscreen.hasDocument()) return;
  } catch (e) { /* older chrome */ }
  if (offscreenCreating) { await offscreenCreating; return; }
  offscreenCreating = chrome.offscreen.createDocument({
    url: 'src/offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Write now-playing metadata and cover art to the user-selected folder.'
  }).catch((e) => {
    if (!/single offscreen|already exists/i.test(String((e && e.message) || e))) throw e;
  }).finally(() => { offscreenCreating = null; });
  await offscreenCreating;
}

async function sendToOffscreen(msg, tries = 12) {
  await ensureOffscreen();
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      lastErr = e;
      // createDocument resolves before the offscreen script has registered its
      // listener -- retry briefly instead of failing the write.
      if (!/Receiving end does not exist|Could not establish connection/i.test(String((e && e.message) || e))) throw e;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw lastErr;
}

async function askWriter(payload) {
  return sendToOffscreen({ target: 'offscreen', type: 'dnp:write', payload });
}

async function askSelfTest() {
  return sendToOffscreen({ target: 'offscreen', type: 'dnp:selftest' });
}

/* --------------------------- value assembly ------------------------------ */

function S(v) { return v == null ? '' : String(v); }
function text(v) { const s = S(v); return { text: s, json: s }; }
function bool(v) { return { text: v ? 'true' : 'false', json: !!v }; }
function num(n, rendered) { return { text: rendered == null ? '' : String(rendered), json: typeof n === 'number' && isFinite(n) ? n : null }; }

function fmtClock(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + ':' + String(s).padStart(2, '0');
}

function coerceCount(v) {
  if (v == null || v === '') return { text: '', json: null };
  const n = Number(v);
  return { text: S(v), json: isFinite(n) ? n : S(v) };
}

// Returns id -> { text, json } for every component, using the live state and
// whatever Tier 1 fields are available.
function buildValues(state, api) {
  api = api || {};
  const pos = Number(state.position) || 0;
  const dur = Number(state.duration) || 0;
  const v = {
    title: text(state.title),
    artist: text(state.artist),
    cover: text(state.artworkUrl || api.coverUrl || ''),
    album: text(state.album),
    trackUrl: text(state.trackUrl),
    playing: bool(state.playing),
    adPlaying: bool(state.isAd),
    elapsed: num(Math.round(pos * 1000) / 1000, fmtClock(pos)),
    remaining: dur ? num(Math.round((dur - pos) * 1000) / 1000, fmtClock(dur - pos)) : { text: '', json: null },
    duration: dur ? num(Math.round(dur), fmtClock(dur)) : { text: '', json: null },
    progress: dur ? num(Math.round(pos / dur * 100), Math.round(pos / dur * 100)) : { text: '', json: null },
    volume: state.volume == null ? { text: '', json: null } : num(Number(state.volume), state.volume),
    muted: bool(state.muted)
  };
  const counts = { playbackCount: 1, likesCount: 1, repostsCount: 1, commentCount: 1, downloadCount: 1, uploaderFollowers: 1 };
  for (const k of Object.keys(api)) {
    if (!k) continue;
    v[k] = counts[k] ? coerceCount(api[k]) : text(api[k]);
  }
  return v;
}

/* --------------------------- write payloads ------------------------------ */

function enabledComps(settings, filter) {
  const out = [];
  for (const c of globalThis.DNPcomponents.ALL) {
    const s = settings.components[c.id];
    if (!s || !s.enabled) continue;
    if (filter && !filter(c)) continue;
    out.push(Object.assign({}, c, { file: s.file || c.file }));
  }
  return out;
}

function buildJson(values, enabled) {
  const obj = { schemaVersion: 1, updatedAt: new Date().toISOString() };
  for (const c of enabled) {
    if (values[c.id] === undefined) continue;
    obj[c.id] = values[c.id].json;
  }
  return JSON.stringify(obj, null, 2);
}

function buildTextFiles(values, enabled) {
  const files = [];
  for (const c of enabled) {
    if (c.kind === 'image') continue;
    if (values[c.id] === undefined) continue;
    files.push({ name: c.file, text: values[c.id].text });
  }
  return files;
}

function coverComp(settings) {
  const s = settings.components.cover;
  return s && s.enabled ? (s.file || 'cover') : null;
}

// Full write on a track change.
function buildTrackPayload(settings, state, values, enabled) {
  const payload = { files: [], json: null, image: null };
  if (settings.writeFiles) payload.files = buildTextFiles(values, enabled);
  if (settings.writeJson) payload.json = { name: settings.jsonFile, text: buildJson(values, enabled) };
  const coverName = coverComp(settings);
  const url = state.artworkUrl || (lastApiFields && lastApiFields.coverUrl);
  if (coverName && url) payload.image = { name: coverName, url: url };
  return payload;
}

// Throttled update of the live fields (never the cover, never the static files).
function buildDynamicPayload(settings, values, enabled) {
  const dyn = enabled.filter((c) => c.dynamic);
  const payload = { files: [], json: null, image: null };
  if (settings.writeFiles) payload.files = buildTextFiles(values, dyn);
  if (settings.writeJson) payload.json = { name: settings.jsonFile, text: buildJson(values, enabled) };
  return payload;
}

/* ------------------------------- writing -------------------------------- */

async function performWrite(payload) {
  try {
    const last = (await chrome.storage.local.get('lastImageName')).lastImageName || null;
    if (payload.image) payload.image.lastImageName = last;
    const res = await askWriter(payload);
    if (res && res.imageName) await chrome.storage.local.set({ lastImageName: res.imageName });
    return res;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms))
  ]);
}

/* ------------------------------ reconcile -------------------------------- */

function dedupeKey(t) {
  return t ? [t.title || '', t.artist || '', t.trackUrl || '', t.artworkUrl || ''].join('\u0001') : '';
}

function scheduleReconcile() {
  if (reconcileTimer) return;
  reconcileTimer = setTimeout(() => { reconcileTimer = null; reconcile(); }, 180);
}

async function reconcile() {
  if (reconciling) return reconciling;
  reconciling = (async () => {
    const settings = await getSettings();
    const states = [...tabStates.values()];
    const { active, playing } = globalThis.DNP.chooseActive(states);

    if (!settings.enabled) {
      await setStatus({ enabled: false, playing: !!playing, note: 'disabled' });
      return;
    }
    if (!active) {
      if (settings.clearOnStop && lastWritten !== null) {
        const enabled = enabledComps(settings, null);
        const files = enabled.filter((c) => c.kind !== 'image').map((c) => ({ name: c.file, text: '' }));
        await performWrite({ files, json: null, image: null, clear: true });
        lastWritten = null;
      }
      await setStatus({ playing: false, current: null, note: 'idle' });
      return;
    }

    await setStatus({ playing: playing, current: { title: active.title, artist: active.artist, artworkUrl: active.artworkUrl, trackUrl: active.trackUrl }, note: playing ? 'playing' : 'paused' });

    const key = dedupeKey(active);
    if (!playing) return;              // paused: keep the last written files

    if (key !== lastWritten) {
      // New track: fetch Tier 1 metadata first, then write everything.
      let apiFields = null;
      if (settings.fetchApi && active.trackUrl) {
        const r = await withTimeout(globalThis.DNPapi.fetchTrack(active.trackUrl), API_TIMEOUT_MS, { ok: false, error: 'timeout' });
        if (r && r.ok) { apiFields = r.fields; }
        else { await setStatus({ apiError: (r && r.error) || 'api failed' }); }
      }
      lastApiFields = apiFields;
      const enabled = enabledComps(settings, null);
      const values = buildValues(Object.assign({}, active, { playing: true }), apiFields);
      const res = await performWrite(buildTrackPayload(settings, active, values, enabled));
      if (res && res.ok) {
        lastWritten = key;
        await setStatus({ written: res.written, wroteAt: Date.now(), error: null, permNeeded: false, apiError: null });
      } else if (res && res.error === 'permission-required') {
        await setStatus({ error: 'Folder permission needs to be re-granted.', permNeeded: true });
        try { await chrome.action.setBadgeText({ text: '!' }); } catch (e) {}
      } else {
        await setStatus({ error: (res && res.error) || 'write failed', permNeeded: false });
      }
    }
  })().finally(() => { reconciling = null; });
  return reconciling;
}

async function updateDynamic() {
  try {
    const settings = await getSettings();
    if (!settings.enabled) return;
    const { active, playing } = globalThis.DNP.chooseActive([...tabStates.values()]);
    if (!active) return;
    const enabled = enabledComps(settings, null);
    if (!enabled.some((c) => c.dynamic)) return;
    const values = buildValues(Object.assign({}, active, { playing: playing }), lastApiFields);
    await performWrite(buildDynamicPayload(settings, values, enabled));
  } catch (e) { /* ignore transient */ }
}

function startDynamicTimer() {
  if (dynamicTimer) return;
  dynamicTimer = setInterval(updateDynamic, DYNAMIC_MS);
}

/* -------------------------------- events --------------------------------- */

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.target === 'offscreen') return; // not ours

  if (msg.type === 'dnp:state') {
    const tabId = sender && sender.tab && sender.tab.id;
    if (typeof tabId === 'number') tabStates.set(tabId, msg.state);
    paintBadge();
    scheduleReconcile();
    return false;
  }

  if (msg.type === 'dnp:get-status') {
    (async () => {
      const { status } = await chrome.storage.local.get('status');
      const settings = await getSettings();
      const { active, playing } = globalThis.DNP.chooseActive([...tabStates.values()]);
      reply({ status: status || null, settings, tabs: tabStates.size, active, playing });
    })();
    return true;
  }

  if (msg.type === 'dnp:set-settings') {
    (async () => {
      const merged = globalThis.DNPcomponents.merge(msg.settings);
      await chrome.storage.local.set({ settings: merged });
      lastWritten = null;
      await reconcile();
      reply({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'dnp:folder-changed') {
    lastWritten = null;
    (async () => { await reconcile(); reply({ ok: true }); })();
    return true;
  }

  if (msg.type === 'dnp:selftest') {
    (async () => {
      try { reply(await askSelfTest()); } catch (e) { reply({ ok: false, error: String((e && e.message) || e) }); }
    })();
    return true;
  }

  if (msg.type === 'dnp:test-write') {
    (async () => {
      const settings = await getSettings();
      const { active } = globalThis.DNP.chooseActive([...tabStates.values()]);
      let apiFields = null;
      if (settings.fetchApi && active && active.trackUrl) {
        const r = await withTimeout(globalThis.DNPapi.fetchTrack(active.trackUrl), API_TIMEOUT_MS, { ok: false, error: 'timeout' });
        if (r && r.ok) apiFields = r.fields;
      }
      lastApiFields = apiFields;
      const state = active
        ? Object.assign({}, active, { playing: true })
        : { title: 'Test Track', artist: 'Test Artist', artworkUrl: null, playing: true };
      const enabled = enabledComps(settings, null);
      const values = buildValues(state, apiFields);
      const res = await performWrite(buildTrackPayload(settings, state, values, enabled));
      if (res && res.ok) lastWritten = dedupeKey(active);
      await setStatus({ lastTest: res, wroteAt: Date.now(), error: res && res.ok ? null : (res && res.error) });
      reply({ ok: !!(res && res.ok), result: res });
    })();
    return true;
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabStates.delete(tabId)) scheduleReconcile();
});

chrome.runtime.onInstalled.addListener(() => { paintBadge(); ensureOffscreen().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { paintBadge(); });

startDynamicTimer();
