/* Options page: folder picker (File System Access API) + settings. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const log = (el, text, cls) => { el.textContent = text; el.className = cls || ''; };

  async function loadSettings() {
    const { settings } = await chrome.storage.local.get('settings');
    const s = settings || {};
    const files = s.files || {};
    $('fileTitle').value = files.title || 'track.txt';
    $('fileArtist').value = files.artist || 'artist.txt';
    $('fileImage').value = files.image || 'cover';
    $('enabled').checked = s.enabled !== false;
    $('clearOnStop').checked = !!s.clearOnStop;
  }

  async function showFolder() {
    try {
      const handle = await SCNPIdb.getHandle();
      const el = $('folder');
      if (handle) { el.textContent = handle.name; el.classList.remove('unset'); }
      else { el.textContent = 'No folder chosen yet'; el.classList.add('unset'); }
    } catch (e) { /* ignore */ }
  }

  async function pickFolder() {
    if (!window.showDirectoryPicker) {
      log($('log'), 'This Chrome version has no folder picker. Update Chrome.', 'err');
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({ id: 'scnp', mode: 'readwrite', startIn: 'downloads' });
      // Ask for write permission while we still hold the user gesture.
      await handle.requestPermission({ mode: 'readwrite' });
      await SCNPIdb.saveHandle(handle);
      await showFolder();
      log($('log'), 'Folder set: ' + handle.name + ' — writing enabled.', 'ok');
      chrome.runtime.sendMessage({ type: 'scnp:folder-changed' });
    } catch (e) {
      if (e && e.name === 'AbortError') { log($('log'), 'Folder selection cancelled.'); return; }
      log($('log'), 'Could not use folder: ' + (e && e.message), 'err');
    }
  }

  async function clearFolder() {
    await SCNPIdb.clearHandle();
    await showFolder();
    log($('log'), 'Folder cleared.', '');
  }

  async function save() {
    const settings = {
      enabled: $('enabled').checked,
      clearOnStop: $('clearOnStop').checked,
      files: {
        title: $('fileTitle').value.trim() || 'track.txt',
        artist: $('fileArtist').value.trim() || 'artist.txt',
        image: ($('fileImage').value.trim() || 'cover').replace(/\.[a-z0-9]+$/i, '')
      }
    };
    const res = await chrome.runtime.sendMessage({ type: 'scnp:set-settings', settings });
    log($('saveLog'), res && res.ok ? 'Saved.' : 'Save failed.', res && res.ok ? 'ok' : 'err');
    setTimeout(() => log($('saveLog'), ''), 1500);
  }

  async function testWrite() {
    log($('saveLog'), 'Writing…');
    const res = await chrome.runtime.sendMessage({ type: 'scnp:test-write' });
    const r = res && res.result;
    if (res && res.ok) {
      const names = (r.written || []).map((w) => w.name + (w.changed ? '' : ' (unchanged)')).join(', ');
      log($('saveLog'), 'Wrote: ' + names + (r.warning ? '\nWarning: ' + r.warning : ''), 'ok');
    } else {
      const err = (r && r.error) || 'unknown error';
      log($('saveLog'), 'Write failed: ' + err + (err === 'no-folder' ? ' — choose a folder first.' : ''),
        'err');
    }
  }

  async function selfTest() {
    log($('saveLog'), 'Running writer self-test (browser sandbox)…');
    const r = await chrome.runtime.sendMessage({ type: 'scnp:selftest' });
    if (r && r.ok) {
      log($('saveLog'), 'Self-test OK — wrote 3 files and read them back (image ' + r.imageBytes + ' bytes).', 'ok');
    } else {
      log($('saveLog'), 'Self-test failed: ' + ((r && r.error) || JSON.stringify(r)), 'err');
    }
  }

  $('pick').addEventListener('click', pickFolder);
  $('selftest').addEventListener('click', selfTest);
  $('clear').addEventListener('click', clearFolder);
  $('save').addEventListener('click', save);
  $('test').addEventListener('click', testWrite);
  loadSettings();
  showFolder();
})();
