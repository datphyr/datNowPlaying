/* Options page: folder picker + component grid. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const log = (el, text, cls) => { el.textContent = text; el.className = cls || ''; };
  const C = globalThis.DNPcomponents;

  let settings = C.defaults();

  /* ------------------------------ render ---------------------------------- */

  function renderSections() {
    const host = $('sections');
    host.innerHTML = '';
    for (const sec of C.SECTIONS) {
      const el = document.createElement('section');
      const h = document.createElement('h2');
      h.textContent = sec.title;
      el.appendChild(h);
      const p = document.createElement('p');
      p.className = 'blurb';
      p.textContent = sec.blurb;
      el.appendChild(p);

      const grid = document.createElement('div');
      grid.className = 'grid';
      for (const c of sec.components) {
        const st = settings.components[c.id];
        const row = document.createElement('label');
        row.className = 'comp' + (st.enabled ? '' : ' off');
        row.dataset.comp = c.id;

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = st.enabled;
        cb.dataset.role = 'enable';

        const name = document.createElement('span');
        name.className = 'name';
        name.innerHTML = c.label + (c.tier === 1 ? '<span class="tier">tier 1</span>' : '');

        const input = document.createElement('input');
        input.type = 'text';
        input.value = st.file;
        input.dataset.role = 'file';
        input.title = c.kind === 'image' ? 'Base name (extension added automatically)' : 'File name';

        row.appendChild(cb); row.appendChild(name); row.appendChild(input);
        cb.addEventListener('change', () => { st.enabled = cb.checked; row.classList.toggle('off', !cb.checked); });
        input.addEventListener('input', () => { st.file = input.value; });
        grid.appendChild(row);
      }
      el.appendChild(grid);
      host.appendChild(el);
    }
  }

  function collect() {
    const out = {
      enabled: $('enabled').checked,
      clearOnStop: $('clearOnStop').checked,
      writeJson: $('writeJson').checked,
      writeFiles: $('writeFiles').checked,
      fetchApi: $('fetchApi').checked,
      jsonFile: $('jsonFile').value.trim() || 'nowplaying.json',
      components: {}
    };
    document.querySelectorAll('.comp[data-comp]').forEach((row) => {
      const id = row.dataset.comp;
      out.components[id] = {
        enabled: row.querySelector('[data-role=enable]').checked,
        file: row.querySelector('[data-role=file]').value.trim()
      };
    });
    return out;
  }

  function apply(s) {
    settings = s;
    $('enabled').checked = s.enabled !== false;
    $('clearOnStop').checked = !!s.clearOnStop;
    $('writeJson').checked = s.writeJson !== false;
    $('writeFiles').checked = s.writeFiles !== false;
    $('fetchApi').checked = s.fetchApi !== false;
    $('jsonFile').value = s.jsonFile || 'nowplaying.json';
    renderSections();
  }

  /* ------------------------------ folder ---------------------------------- */

  async function showFolder() {
    try {
      const handle = await DNPIdb.getHandle();
      const el = $('folder');
      if (handle) { el.textContent = handle.name; el.classList.remove('unset'); }
      else { el.textContent = 'No folder chosen yet'; el.classList.add('unset'); }
    } catch (e) { /* ignore */ }
  }

  async function pickFolder() {
    if (!window.showDirectoryPicker) { log($('log'), 'This Chrome version has no folder picker. Update Chrome.', 'err'); return; }
    try {
      const handle = await window.showDirectoryPicker({ id: 'dnp', mode: 'readwrite', startIn: 'downloads' });
      await handle.requestPermission({ mode: 'readwrite' });
      await DNPIdb.saveHandle(handle);
      await showFolder();
      log($('log'), 'Folder set: ' + handle.name + ' — writing enabled.', 'ok');
      chrome.runtime.sendMessage({ type: 'dnp:folder-changed' });
    } catch (e) {
      if (e && e.name === 'AbortError') { log($('log'), 'Folder selection cancelled.'); return; }
      log($('log'), 'Could not use folder: ' + (e && e.message), 'err');
    }
  }

  async function clearFolder() {
    await DNPIdb.clearHandle();
    await showFolder();
    log($('log'), 'Folder cleared.', '');
  }

  /* ------------------------------ actions --------------------------------- */

  async function save() {
    const res = await chrome.runtime.sendMessage({ type: 'dnp:set-settings', settings: collect() });
    log($('saveLog'), res && res.ok ? 'Saved.' : 'Save failed.', res && res.ok ? 'ok' : 'err');
    setTimeout(() => log($('saveLog'), ''), 1500);
  }

  async function testWrite() {
    log($('saveLog'), 'Writing…');
    const res = await chrome.runtime.sendMessage({ type: 'dnp:test-write' });
    const r = res && res.result;
    if (res && res.ok) {
      const names = (r.written || []).map((w) => w.name + (w.changed ? '' : ' (unchanged)')).join(', ');
      log($('saveLog'), 'Wrote: ' + names + (r.warning ? '\nWarning: ' + r.warning : ''), 'ok');
    } else {
      const err = (r && r.error) || 'unknown error';
      log($('saveLog'), 'Write failed: ' + err + (err === 'no-folder' ? ' — choose a folder first.' : ''), 'err');
    }
  }

  async function selfTest() {
    log($('saveLog'), 'Running writer self-test (browser sandbox)…');
    const r = await chrome.runtime.sendMessage({ type: 'dnp:selftest' });
    if (r && r.ok) log($('saveLog'), 'Self-test OK — wrote files + JSON and read them back (image ' + r.imageBytes + ' bytes).', 'ok');
    else log($('saveLog'), 'Self-test failed: ' + ((r && r.error) || JSON.stringify(r)), 'err');
  }

  /* ------------------------------- init ----------------------------------- */

  $('pick').addEventListener('click', pickFolder);
  $('clear').addEventListener('click', clearFolder);
  $('save').addEventListener('click', save);
  $('test').addEventListener('click', testWrite);
  $('selftest').addEventListener('click', selfTest);

  (async () => {
    const { settings: stored } = await chrome.storage.local.get('settings');
    apply(C.merge(stored));
    showFolder();
  })();
})();
