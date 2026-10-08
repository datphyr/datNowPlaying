/*
 * SoundCloud now-playing metadata extraction (shared, dependency-free).
 *
 * Loaded two ways:
 *   - as a content script (attaches to the isolated-world globalThis)
 *   - in the service worker via importScripts() (attaches to `self`)
 * Also exports CommonJS for node unit tests.
 *
 * Sources, in priority order:
 *   1. navigator.mediaSession.metadata  -> title / artist / artwork (set by SoundCloud)
 *   2. .playbackSoundBadge DOM subtree  -> title / artist / artwork / paused / ad state
 */
(function (global) {
  'use strict';

  var SC_HOST_RE = /(^|\.)soundcloud\.com$/i;

  function isSoundCloudHost(host) {
    return SC_HOST_RE.test(String(host || ''));
  }

  function isSoundCloudUrl(url) {
    try { return isSoundCloudHost(new URL(url).hostname); } catch (e) { return false; }
  }

  function absUrl(href, base) {
    if (!href) return null;
    try { return new URL(href, base || undefined).href; } catch (e) { return href; }
  }

  // SoundCloud artwork URLs end in a size variant: -large, -t500x500, -t300x300,
  // -small, -tiny, -mini, -badge, -crop. Swapping the variant to -original gives
  // the full-resolution upload.
  var ARTWORK_VARIANT_RE = /-(large|t\d+x\d+|small|tiny|mini|badge|crop)(?=\.(?:jpe?g|png|webp|gif)(?:$|\?))/i;

  function artworkCandidates(url) {
    if (!url) return [];
    var clean = String(url).trim();
    if (!clean) return [];
    var out = [];
    var orig = clean.replace(ARTWORK_VARIANT_RE, '-original');
    if (orig !== clean) out.push(orig);
    var big = clean.replace(ARTWORK_VARIANT_RE, '-t500x500');
    if (big !== clean) out.push(big);
    out.push(clean);
    return out.filter(function (v, i, a) { return v && a.indexOf(v) === i; });
  }

  function normalizeArtwork(url) {
    var c = artworkCandidates(url);
    return c.length ? c[0] : null;
  }

  function parseSize(sizes) {
    var m = /(\d+)\s*x\s*(\d+)/i.exec(String(sizes || ''));
    return m ? Math.min(parseInt(m[1], 10), parseInt(m[2], 10)) : 0;
  }

  function pickLargestArtwork(list) {
    var best = null, bestSize = -1;
    var arr = list ? Array.from(list) : [];
    for (var i = 0; i < arr.length; i++) {
      var item = arr[i];
      if (!item || !item.src) continue;
      var s = parseSize(item.sizes);
      if (s >= bestSize) { bestSize = s; best = item; }
    }
    return best ? best.src : null;
  }

  function fromSrcset(srcset) {
    if (!srcset) return null;
    var best = null, bestScore = -1;
    var parts = String(srcset).split(',');
    for (var i = 0; i < parts.length; i++) {
      var bits = parts[i].trim().split(/\s+/);
      if (!bits[0]) continue;
      var d = /^(\d+(?:\.\d+)?)x$/.exec(bits[1] || '');
      var w = /^(\d+)w$/.exec(bits[1] || '');
      var score = d ? parseFloat(d[1]) : (w ? parseInt(w[1], 10) : 1);
      if (score >= bestScore) { bestScore = score; best = bits[0]; }
    }
    return best;
  }

  function textOf(el) {
    return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  function cleanTitle(t) {
    if (!t) return null;
    var s = String(t).replace(/\s+/g, ' ').trim();
    var m = /^Current track:\s*(.+)$/i.exec(s);
    if (m) s = m[1].trim();
    return s || null;
  }

  function extractFromMediaSession(nav) {
    try {
      var ms = nav && nav.mediaSession;
      var md = ms && ms.metadata;
      if (!md) return null;
      var artwork = md.artwork ? Array.from(md.artwork) : [];
      return {
        source: 'mediaSession',
        title: cleanTitle(md.title),
        artist: md.artist ? (String(md.artist).trim() || null) : null,
        album: md.album ? (String(md.album).trim() || null) : null,
        artworkUrl: pickLargestArtwork(artwork),
        playbackState: (ms && ms.playbackState) || null,
        paused: ms && ms.playbackState ? ms.playbackState === 'paused' : null
      };
    } catch (e) { return null; }
  }

  function extractFromDom(doc) {
    if (!doc) return null;
    var badge = doc.querySelector('.playbackSoundBadge');
    if (!badge) return null;

    var paused = badge.classList.contains('paused');
    var isAd = badge.classList.contains('is-adPlaying');

    var titleLink = badge.querySelector('a.playbackSoundBadge__titleLink, .playbackSoundBadge__titleLink');
    var lightLink = badge.querySelector('.playbackSoundBadge__lightLink');

    var title = cleanTitle(titleLink && (titleLink.getAttribute('title') || textOf(titleLink)));
    var artist = lightLink ? (textOf(lightLink) || null) : null;

    var artworkUrl = null;
    var img = badge.querySelector('.playbackSoundBadge__avatar img');
    if (img && img.tagName === 'IMG') {
      artworkUrl = img.getAttribute('src') || img.currentSrc || fromSrcset(img.getAttribute('srcset'));
    }

    return {
      source: 'dom',
      hasBadge: true,
      title: title,
      artist: artist,
      album: null,
      artworkUrl: artworkUrl || null,
      trackUrl: titleLink ? absUrl(titleLink.getAttribute('href'), doc.baseURI) : null,
      playbackState: paused ? 'paused' : 'playing',
      paused: paused,
      isAd: isAd
    };
  }

  // Merge both sources. mediaSession wins on title/artist/artwork (it is explicit),
  // DOM provides paused / ad state and a fallback.
  function extractBest(win) {
    win = win || global;
    var dom = extractFromDom(win.document);
    var ms = extractFromMediaSession(win.navigator);
    return {
      title: (ms && ms.title) || (dom && dom.title) || null,
      artist: (ms && ms.artist) || (dom && dom.artist) || null,
      album: (ms && ms.album) || (dom && dom.album) || null,
      artworkUrl: (ms && ms.artworkUrl) || (dom && dom.artworkUrl) || null,
      trackUrl: (dom && dom.trackUrl) || null,
      hasBadge: !!(dom && dom.hasBadge),
      paused: dom ? dom.paused : (ms ? ms.paused : null),
      isAd: !!(dom && dom.isAd),
      playbackState: (ms && ms.playbackState) || (dom && dom.playbackState) || 'none',
      sources: [ms && 'mediaSession', dom && 'dom'].filter(Boolean)
    };
  }

  // Choose which tab is "the" now-playing tab. Pure -> unit testable.
  // states: array of {playing,isAd,muted,position,updatedAt,progressing,...}
  function chooseActive(states) {
    var playing = (states || []).filter(function (s) { return s && s.playing && !s.isAd && (s.title || s.artist); });
    if (playing.length) {
      playing.sort(function (a, b) {
        if (!!b.progressing !== !!a.progressing) return b.progressing ? 1 : -1;
        if (!!a.muted !== !!b.muted) return a.muted ? 1 : -1;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });
      return { active: playing[0], playing: true };
    }
    var withMeta = (states || []).filter(function (s) { return s && (s.title || s.artist); });
    withMeta.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    return { active: withMeta[0] || null, playing: false };
  }

  var api = {
    isSoundCloudHost: isSoundCloudHost,
    isSoundCloudUrl: isSoundCloudUrl,
    absUrl: absUrl,
    artworkCandidates: artworkCandidates,
    normalizeArtwork: normalizeArtwork,
    parseSize: parseSize,
    pickLargestArtwork: pickLargestArtwork,
    fromSrcset: fromSrcset,
    textOf: textOf,
    cleanTitle: cleanTitle,
    extractFromMediaSession: extractFromMediaSession,
    extractFromDom: extractFromDom,
    extractBest: extractBest,
    chooseActive: chooseActive
  };

  global.SCNP = Object.assign(global.SCNP || {}, api);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
