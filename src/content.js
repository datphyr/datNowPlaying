/*
 * datNowPlaying - content script (isolated world).
 *
 * Reads the now-playing state from the page (mediaSession metadata + the
 * playbackSoundBadge DOM + any <audio>/<video> elements) and pushes it to the
 * service worker. Event-driven so it stays accurate in background tabs, where
 * timers are throttled:
 *   - MutationObserver on the badge DOM
 *   - capture-phase media events (play/pause/timeupdate/...) on document
 *   - a low-frequency interval as a foreground backstop
 */
(function () {
  'use strict';

  var M = globalThis.DNP;
  if (!M) return;

  var lastKey = '';
  var lastSentAt = 0;

  function mediaInfo() {
    var playing = false, position = 0, muted = false, duration = 0;
    var els = document.querySelectorAll('audio, video');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      try {
        if (!el.paused && !el.ended && el.readyState >= 1 && el.currentTime > 0) {
          playing = true;
          if (el.currentTime > position) position = el.currentTime;
          if (el.duration && isFinite(el.duration)) duration = el.duration;
          if (el.muted || el.volume === 0) muted = true;
        } else if (el.currentTime > position) {
          position = el.currentTime;
        }
      } catch (e) { /* detached element */ }
    }
    return { mediaPlaying: playing, position: position, muted: muted, duration: duration };
  }

  function readState() {
    var meta = M.extractBest(window);
    var media = mediaInfo();
    var domPlaying = !!(meta.hasBadge && !meta.paused && !meta.isAd);
    var msPlaying = meta.playbackState === 'playing';
    var playing = !meta.isAd && (media.mediaPlaying || domPlaying || msPlaying);
    return {
      ok: true,
      href: location.href,
      title: meta.title,
      artist: meta.artist,
      album: meta.album,
      artworkUrl: meta.artworkUrl,
      trackUrl: meta.trackUrl,
      isAd: meta.isAd,
      muted: media.muted,
      position: Math.round(media.position * 1000) / 1000,
      duration: media.duration ? Math.round(media.duration) : null,
      mediaPlaying: media.mediaPlaying,
      domPlaying: domPlaying,
      msPlaying: msPlaying,
      // A tab whose <audio> element is actively advancing is the strongest
      // "this is the one playing" signal for multi-tab disambiguation.
      progressing: media.mediaPlaying,
      playbackState: playing ? 'playing' : 'paused',
      playing: playing,
      sources: meta.sources,
      updatedAt: Date.now()
    };
  }

  function send() {
    var st;
    try { st = readState(); } catch (e) { return; }
    var key = [st.playing, st.title, st.artist, st.artworkUrl, st.isAd, st.playbackState].join('\u0001');
    var now = Date.now();
    // Always forward position updates, but collapse identical states within 900ms.
    if (key === lastKey && now - lastSentAt < 900) return;
    lastKey = key;
    lastSentAt = now;
    try { chrome.runtime.sendMessage({ type: 'dnp:state', state: st }); } catch (e) { /* SW asleep */ }
  }

  var scheduled = false;
  function schedule(delay) {
    if (scheduled) return;
    scheduled = true;
    setTimeout(function () { scheduled = false; send(); }, delay == null ? 250 : delay);
  }

  // --- DOM changes (badge appears / track title changes / artwork swaps) ---
  var mo = new MutationObserver(function () { schedule(250); });
  function startObserver() {
    mo.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['class', 'src', 'srcset', 'title', 'href']
    });
  }
  if (document.documentElement) startObserver();
  else document.addEventListener('DOMContentLoaded', startObserver, { once: true });

  // --- media element events (fires even in background tabs) ---
  var MEDIA_EVENTS = ['play', 'playing', 'pause', 'ended', 'loadedmetadata', 'timeupdate', 'volumechange', 'durationchange', 'seeked'];
  function onMediaEvent() { schedule(200); }
  for (var i = 0; i < MEDIA_EVENTS.length; i++) {
    document.addEventListener(MEDIA_EVENTS[i], onMediaEvent, true);
  }

  // --- foreground backstop ---
  setInterval(send, 2000);
  window.addEventListener('focus', send);
  document.addEventListener('visibilitychange', send);

  chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
    if (msg && msg.type === 'dnp:request') {
      try { reply(readState()); } catch (e) { reply({ ok: false, error: String(e) }); }
      return true;
    }
    return false;
  });

  // Test hook: callable from the extension's isolated world via CDP. Invisible to the page.
  try { globalThis.__DNP_READ__ = readState; } catch (e) { /* noop */ }

  send();
})();
