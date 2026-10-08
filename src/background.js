/*
 * datNowPlaying - service worker.
 *
 * Responsibilities:
 *   - collect per-tab state pushed by the content script
 *   - decide which tab is "the" playing tab (pure logic in lib/metadata.js)
 *   - assemble the enabled components (lib/components.js + lib/values.js)
 *   - fetch Tier 1 metadata from the SoundCloud API (lib/api.js) on track change,
 *     but only when a SoundCloud-metadata field is actually enabled
 *   - hand a write payload to the offscreen document (one file per enabled
 *     component, optional nowplaying.json, and the cover image)
 *   - keep the toolbar badge + stored status for the popup/options UI
 */
importScripts('lib/components.js', 'lib/values.js', 'lib/api.js', 'lib/metadata.js');

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

async function fetchApiFields(settings, trackUrl) {
  if (!globalThis.DNPcomponents.needsApi(settings) || !trackUrl) return null;
  const r = await withTimeout(globalThis.DNPapi.fetchTrack(trackUrl), API_TIMEOUT_MS, { ok: false, error: 'timeout' });
  if (r && r.ok) { await setStatus({ apiError: null }); return r.fields; }
  await setStatus({ apiError: (r && r.error) || 'api failed' });
  return null;
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
        await performWrite(globalThis.DNPvalues.buildClearPayload(settings));
        lastWritten = null;
      }
      await setStatus({ playing: false, current: null, note: 'idle' });
      return;
    }

    await setStatus({ playing: playing, current: { title: active.title, artist: active.artist, artworkUrl: active.artworkUrl, trackUrl: active.trackUrl }, note: playing ? 'playing' : 'paused' });

    const key = dedupeKey(active);
    if (!playing) return;              // paused: keep the last written files

    if (key === lastWritten) return;   // nothing changed on disk

    // New track: fetch Tier 1 metadata first (only if something needs it),
    // then write everything.
    const apiFields = await fetchApiFields(settings, active.trackUrl);
    lastApiFields = apiFields;
    const values = globalThis.DNPvalues.buildValues(Object.assign({}, active, { playing: true }), apiFields);
    const res = await performWrite(globalThis.DNPvalues.buildTrackPayload(settings, active, values, apiFields));
    if (res && res.ok) {
      lastWritten = key;
      await setStatus({ written: res.written, wroteAt: Date.now(), error: null, permNeeded: false });
    } else if (res && res.error === 'permission-required') {
      await setStatus({ error: 'Folder permission needs to be re-granted.', permNeeded: true });
      try { await chrome.action.setBadgeText({ text: '!' }); } catch (e) {}
    } else {
      await setStatus({ error: (res && res.error) || 'write failed', permNeeded: false });
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
    const enabled = globalThis.DNPvalues.enabledComps(settings, null);
    if (!enabled.some((c) => c.dynamic)) return;
    const values = globalThis.DNPvalues.buildValues(Object.assign({}, active, { playing: playing }), lastApiFields);
    await performWrite(globalThis.DNPvalues.buildDynamicPayload(settings, values));
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

  // Test hook only (no UI): lets the CDP live test exercise the writer, which
  // cannot pick a real folder in headless Chrome. See tests/live-cdp.js.
  if (msg.type === 'dnp:selftest') {
    (async () => {
      try { reply(await askSelfTest()); } catch (e) { reply({ ok: false, error: String((e && e.message) || e) }); }
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
