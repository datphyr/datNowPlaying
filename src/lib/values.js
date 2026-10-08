/*
 * Value assembly: turns the live tab state + Tier 1 API fields into the concrete
 * values written to disk. Extracted from the service worker so it is unit
 * testable (the "nowplaying.json never appeared" class of bug lives here).
 *
 * Every enabled component produces:
 *   { text, json }   text -> its own file, json -> the value inside nowplaying.json
 */
(function (global) {
  'use strict';

  var C = global.DNPcomponents;
  if (!C && typeof require === 'function') { try { C = require('./components.js'); } catch (e) { /* noop */ } }

  function S(v) { return v == null ? '' : String(v); }
  function text(v) { var s = S(v); return { text: s, json: s }; }
  function bool(v) { return { text: v ? 'true' : 'false', json: !!v }; }
  function num(n, rendered) {
    return { text: rendered == null ? '' : String(rendered), json: (typeof n === 'number' && isFinite(n)) ? n : null };
  }
  function coerceCount(v) {
    if (v == null || v === '') return { text: '', json: null };
    var n = Number(v);
    return { text: S(v), json: isFinite(n) ? n : S(v) };
  }

  function fmtClock(sec) {
    sec = Math.max(0, Math.round(sec));
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  // id -> { text, json } for every component.
  function buildValues(state, api) {
    state = state || {};
    api = api || {};
    var pos = Number(state.position) || 0;
    var dur = Number(state.duration) || 0;
    var v = {
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
    var counts = { playbackCount: 1, likesCount: 1, repostsCount: 1, commentCount: 1, downloadCount: 1, uploaderFollowers: 1 };
    Object.keys(api).forEach(function (k) {
      v[k] = counts[k] ? coerceCount(api[k]) : text(api[k]);
    });
    return v;
  }

  // Enabled components, optionally filtered.
  function enabledComps(settings, filter) {
    var out = [];
    (C ? C.ALL : []).forEach(function (c) {
      var s = (settings.components || {})[c.id];
      if (!s || !s.enabled) return;
      if (filter && !filter(c)) return;
      out.push(Object.assign({}, c, { file: s.file || c.file }));
    });
    return out;
  }

  function buildJson(values, enabled) {
    var obj = { schemaVersion: 1, updatedAt: new Date().toISOString() };
    enabled.forEach(function (c) {
      if (values[c.id] === undefined) return;
      obj[c.id] = values[c.id].json;
    });
    return JSON.stringify(obj, null, 2);
  }

  function buildTextFiles(values, enabled) {
    var files = [];
    enabled.forEach(function (c) {
      if (c.kind === 'image') return;
      if (values[c.id] === undefined) return;
      files.push({ name: c.file, text: values[c.id].text });
    });
    return files;
  }

  function coverName(settings) {
    var s = (settings.components || {}).cover;
    return s && s.enabled ? (s.file || 'cover') : null;
  }

  // Full write on a track change: every enabled field's file + optional json +
  // the cover image.
  function buildTrackPayload(settings, state, values, apiFields) {
    var enabled = enabledComps(settings, null);
    var payload = {
      files: buildTextFiles(values, enabled),
      json: settings.writeJson ? { name: settings.jsonFile, text: buildJson(values, enabled) } : null,
      image: null
    };
    var cover = coverName(settings);
    var url = state.artworkUrl || (apiFields && apiFields.coverUrl);
    if (cover && url) payload.image = { name: cover, url: url };
    return payload;
  }

  // Throttled update of only the live fields (never the cover, never static files).
  function buildDynamicPayload(settings, values) {
    var enabled = enabledComps(settings, null);
    var dyn = enabled.filter(function (c) { return c.dynamic; });
    return {
      files: buildTextFiles(values, dyn),
      json: settings.writeJson ? { name: settings.jsonFile, text: buildJson(values, enabled) } : null,
      image: null
    };
  }

  function buildClearPayload(settings) {
    var enabled = enabledComps(settings, null);
    return {
      files: enabled.filter(function (c) { return c.kind !== 'image'; }).map(function (c) { return { name: c.file, text: '' }; }),
      json: null,
      image: null,
      clear: true
    };
  }

  var api = {
    fmtClock: fmtClock,
    buildValues: buildValues,
    enabledComps: enabledComps,
    buildJson: buildJson,
    buildTextFiles: buildTextFiles,
    buildTrackPayload: buildTrackPayload,
    buildDynamicPayload: buildDynamicPayload,
    buildClearPayload: buildClearPayload
  };

  global.DNPvalues = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
