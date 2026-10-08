/* Popup: live status view. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function setState(text, cls) { $('state').textContent = text; $('state').className = 'state ' + (cls || ''); }

  async function refresh() {
    let res;
    try { res = await chrome.runtime.sendMessage({ type: 'scnp:get-status' }); } catch (e) { res = null; }
    if (!res) { setState('extension reloaded — reopen this popup'); return; }

    const { status, active, playing, settings, error } = res;
    $('dot').className = 'dot' + (playing ? ' on' : '');

    const title = (active && active.title) || (status && status.current && status.current.title) || null;
    const artist = (active && active.artist) || (status && status.current && status.current.artist) || null;
    const art = (active && active.artworkUrl) || (status && status.current && status.current.artworkUrl) || null;

    $('title').textContent = title || 'Nothing playing';
    $('artist').textContent = artist || '';
    $('cover').src = art || '';
    $('cover').style.visibility = art ? 'visible' : 'hidden';

    if (!settings || settings.enabled === false) setState('disabled in settings');
    else if (playing) setState('playing — mirrored to disk');
    else if (title) setState('paused');
    else setState('no SoundCloud tab playing');

    const folderEl = $('folder');
    if (status && status.permNeeded) {
      folderEl.className = 'folder warn';
      folderEl.textContent = '⚠ Folder permission lost — open Settings and re-pick the folder.';
    } else if (status && status.error) {
      folderEl.className = 'folder warn';
      folderEl.textContent = '⚠ ' + status.error;
    } else if (status && status.written && status.written.length) {
      folderEl.className = 'folder';
      folderEl.textContent = 'Saved: ' + status.written.map((w) => w.name).join(', ');
    } else {
      folderEl.className = 'folder';
      folderEl.textContent = 'Last write: —';
    }
  }

  $('open').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('test').addEventListener('click', async () => {
    setState('writing test…');
    const r = await chrome.runtime.sendMessage({ type: 'scnp:test-write' });
    setState(r && r.ok ? 'test write ok' : 'test write failed');
    refresh();
  });

  refresh();
  setInterval(refresh, 1000);
})();
