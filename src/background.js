/*
 * datNowPlaying - service worker.
 *
 * Responsibilities:
 *   - collect per-tab state pushed by the content script
 *   - decide which tab is "the" playing tab (pure logic in lib/metadata.js)
 *   - when the playing track changes, hand it to the offscreen document to be
 *     written to the user's chosen folder (3 files: title / artist / image)
 *   - keep the toolbar badge + stored status for the popup/options UI
 */
importScripts('lib/metadata.js');

const DEFAULT_SETTINGS = {
  enabled: true,
  clearOnStop: false,
  files: { title: 'track.txt', artist: 'artist.txt', image: 'cover' }
};

const tabStates = new Map();      // tabId -> latest state
let lastWritten = null;           // dedupe key for the currently-written track
let reconciling = null;
let reconcileTimer = null;
let offscreenCreating = null;

/* ------------------------------- storage -------------------------------- */

async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  const s = stored.settings || {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    files: { ...DEFAULT_SETTINGS.files, ...(s.files || {}) }
  };
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
      await chrome.action.setBadgeText({ tabId, text: on ? '▶' : '' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: on ? '#f50' : '#888888' });
      await chrome.action.setTitle({
        tabId,
        title: on
          ? `datNowPlaying: ${[st.artist, st.title].filter(Boolean).join(' — ') || 'playing'}`
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
    if (!/single offscreen|already exists/i.test(String(e && e.message || e))) throw e;
  }).finally(() => { offscreenCreating = null; });
  await offscreenCreating;
}

async function askWriter(payload) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: 'offscreen', type: 'dnp:write', payload });
}

async function askSelfTest() {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: 'offscreen', type: 'dnp:selftest' });
}

/* ------------------------------ reconcile -------------------------------- */

function dedupeKey(t) {
  return t ? [t.title || '', t.artist || '', t.artworkUrl || ''].join('\u0001') : '';
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

    const desired = active
      ? { title: active.title || null, artist: active.artist || null, artworkUrl: active.artworkUrl || null }
      : null;
    const key = dedupeKey(desired);

    if (!settings.enabled) {
      await setStatus({ enabled: false, playing: !!playing, current: desired, note: 'disabled' });
      return;
    }
    if (!active) {
      if (settings.clearOnStop && lastWritten !== null) {
        await writeNow({ title: '', artist: '', artworkUrl: null, clear: true }, settings);
        lastWritten = null;
      }
      await setStatus({ playing: false, current: null, note: 'idle' });
      return;
    }

    await setStatus({ playing: playing, current: desired, note: playing ? 'playing' : 'paused' });

    if (!playing) return;              // paused: keep the last written files
    if (key === lastWritten) return;   // no change on disk needed

    const res = await writeNow(desired, settings);
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

async function writeNow(desired, settings) {
  try {
    const res = await askWriter({
      dir: true,
      files: settings.files,
      clear: !!desired.clear,
      title: desired.title,
      artist: desired.artist,
      artworkUrl: desired.artworkUrl,
      lastImageName: (await chrome.storage.local.get('lastImageName')).lastImageName || null
    });
    if (res && res.imageName) await chrome.storage.local.set({ lastImageName: res.imageName });
    return res;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
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
      await chrome.storage.local.set({ settings: msg.settings });
      lastWritten = null;               // force re-write with any new names
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
      const desired = active
        ? { title: active.title, artist: active.artist, artworkUrl: active.artworkUrl }
        : { title: 'Test Track', artist: 'Test Artist', artworkUrl: null };
      const res = await writeNow(desired, settings);
      if (res && res.ok) lastWritten = dedupeKey(desired);
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

chrome.runtime.onInstalled.addListener(() => { paintBadge(); });
chrome.runtime.onStartup.addListener(() => { paintBadge(); });

// Keep the offscreen writer warm so a first track change isn't delayed.
chrome.runtime.onInstalled.addListener(() => { ensureOffscreen().catch(() => {}); });
