/*
 * SoundCloud API access (Tier 1). Runs in the service worker.
 *
 * There is no official key, so the client_id is scraped from SoundCloud's own
 * web bundles exactly as their player does (home page -> referenced JS bundles
 * -> "client_id:\"...\""). It rotates, so it is cached only briefly and
 * re-discovered on a 401/403. No new host permission is needed: the existing
 * host_permissions already cover soundcloud.com, *.soundcloud.com
 * (api-v2.soundcloud.com) and *.sndcdn.com (a-v2.sndcdn.com).
 */
(function (global) {
  'use strict';

  var HOME = 'https://soundcloud.com/';
  var BUNDLE_RE = /https:\/\/a-v2\.sndcdn\.com\/assets\/[0-9]+-[a-f0-9]+\.js/g;
  var CLIENT_ID_RE = /client_id[:=]\s*"([A-Za-z0-9]{20,})"/;

  var MAX_AGE_MS = 6 * 60 * 60 * 1000;  // re-discover at most every 6h
  var TRACK_TTL_MS = 10 * 60 * 1000;    // cache a track's metadata briefly

  var cache = { clientId: null, at: 0, tracks: new Map() };

  async function discoverClientId() {
    const home = await fetch(HOME, { credentials: 'omit', cache: 'no-store' });
    if (!home.ok) throw new Error('soundcloud home -> ' + home.status);
    const html = await home.text();
    const urls = Array.from(new Set(html.match(BUNDLE_RE) || []));
    for (const url of urls) {
      try {
        const res = await fetch(url, { credentials: 'omit', cache: 'no-store' });
        if (!res.ok) continue;
        const js = await res.text();
        const m = CLIENT_ID_RE.exec(js);
        if (m) { cache.clientId = m[1]; cache.at = Date.now(); return cache.clientId; }
      } catch (e) { /* try next bundle */ }
    }
    throw new Error('client_id not found in ' + urls.length + ' bundles');
  }

  async function getClientId(force) {
    if (!force && cache.clientId && Date.now() - cache.at < MAX_AGE_MS) return cache.clientId;
    return discoverClientId();
  }

  async function resolveRaw(trackUrl, forceNewId) {
    const cid = await getClientId(forceNewId);
    const url = 'https://api-v2.soundcloud.com/resolve?url=' + encodeURIComponent(trackUrl) + '&client_id=' + cid;
    return fetch(url, { credentials: 'omit', cache: 'no-store' });
  }

  // Returns a flat map of component-id -> string value for the Tier 1 fields.
  async function fetchTrack(trackUrl) {
    if (!trackUrl) return { ok: false, error: 'no-track-url' };
    const cached = cache.tracks.get(trackUrl);
    if (cached && Date.now() - cached.at < TRACK_TTL_MS) return cached.value;

    let value;
    try {
      let res = await resolveRaw(trackUrl, false);
      if (res.status === 401 || res.status === 403) res = await resolveRaw(trackUrl, true);
      if (!res.ok) { value = { ok: false, error: 'resolve ' + res.status }; }
      else { value = { ok: true, fields: pickTrackFields(await res.json()) }; }
    } catch (e) {
      value = { ok: false, error: String((e && e.message) || e) };
    }
    cache.tracks.set(trackUrl, { at: Date.now(), value });
    return value;
  }

  function str(v) { return v == null ? '' : String(v); }

  function pickTrackFields(d) {
    const u = d.user || {};
    const pm = d.publisher_metadata || {};
    return {
      genre: str(d.genre),
      tags: str(d.tag_list),
      label: str(d.label_name),
      releaseDate: str(d.release_date),
      uploadedAt: str(d.created_at),
      license: str(d.license),
      isrc: str(pm.isrc),
      publisher: str(pm.publisher),
      writer: str(pm.writer_composer),
      description: str(d.description),
      playbackCount: str(d.playback_count),
      likesCount: str(d.likes_count),
      repostsCount: str(d.reposts_count),
      commentCount: str(d.comment_count),
      downloadCount: str(d.download_count),
      uploader: str(u.username),
      uploaderUrl: str(u.permalink_url),
      uploaderFollowers: str(u.followers_count),
      waveformUrl: str(d.waveform_url),
      coverUrl: str(d.artwork_url),
      bpm: str(d.bpm),
      key: str(d.key_signature),
      monetization: str(d.monetization_model)
    };
  }

  global.DNPapi = {
    getClientId: getClientId,
    discoverClientId: discoverClientId,
    fetchTrack: fetchTrack,
    pickTrackFields: pickTrackFields,
    _cache: cache
  };
  if (typeof module === 'object' && module.exports) module.exports = global.DNPapi;
})(typeof globalThis !== 'undefined' ? globalThis : self);
