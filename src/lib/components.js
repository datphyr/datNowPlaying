/*
 * Component registry: the single source of truth for every piece of data the
 * extension can write. Shared by the options UI (to render sections and
 * checkboxes), the service worker (to assemble values) and the tests.
 *
 * tier:     0 = no extra request (DOM / mediaSession / <audio>), 1 = needs the
 *           SoundCloud API call
 * dynamic:  true = changes continuously during playback (so it only lands in
 *           nowplaying.json on a throttle, and is off by default)
 * kind:     'text' | 'image'
 * default:  enabled unless noted. Every checkbox drives its own output file;
 *           there is no separate "write files" or "fetch metadata" switch.
 */
(function (global) {
  'use strict';

  var SECTIONS = [
    {
      id: 'details',
      title: 'Track details',
      blurb: 'No SoundCloud API request needed. All on by default.',
      components: [
        { id: 'title', label: 'Track title', file: 'track.txt', tier: 0, default: true },
        { id: 'artist', label: 'Artist', file: 'artist.txt', tier: 0, default: true },
        { id: 'cover', label: 'Cover art', file: 'cover', kind: 'image', tier: 0, default: true },
        { id: 'album', label: 'Album / playlist', file: 'album.txt', tier: 0, default: true },
        { id: 'trackUrl', label: 'Track URL', file: 'track-url.txt', tier: 0, default: true }
      ]
    },
    {
      id: 'live',
      title: 'Live playback',
      blurb: 'Changes continuously, so it only refreshes nowplaying.json on a throttle. Off by default.',
      components: [
        { id: 'playing', label: 'Playing state', file: 'playing.txt', tier: 0, dynamic: true, default: false },
        { id: 'adPlaying', label: 'Ad break active', file: 'ad-break.txt', tier: 0, dynamic: true, default: false },
        { id: 'elapsed', label: 'Elapsed', file: 'elapsed.txt', tier: 0, dynamic: true, default: false },
        { id: 'remaining', label: 'Remaining', file: 'remaining.txt', tier: 0, dynamic: true, default: false },
        { id: 'duration', label: 'Duration', file: 'duration.txt', tier: 0, dynamic: true, default: false },
        { id: 'progress', label: 'Progress %', file: 'progress.txt', tier: 0, dynamic: true, default: false },
        { id: 'volume', label: 'Volume %', file: 'volume.txt', tier: 0, dynamic: true, default: false },
        { id: 'muted', label: 'Muted', file: 'muted.txt', tier: 0, dynamic: true, default: false }
      ]
    },
    {
      id: 'api',
      title: 'SoundCloud metadata',
      blurb: 'Needs a SoundCloud API request per track change (enabled automatically when you tick any of these). Off by default.',
      components: [
        { id: 'genre', label: 'Genre', file: 'genre.txt', tier: 1, default: false },
        { id: 'tags', label: 'Tags', file: 'tags.txt', tier: 1, default: false },
        { id: 'label', label: 'Label', file: 'label.txt', tier: 1, default: false },
        { id: 'releaseDate', label: 'Release date', file: 'release-date.txt', tier: 1, default: false },
        { id: 'uploadedAt', label: 'Uploaded', file: 'uploaded-at.txt', tier: 1, default: false },
        { id: 'license', label: 'License', file: 'license.txt', tier: 1, default: false },
        { id: 'isrc', label: 'ISRC', file: 'isrc.txt', tier: 1, default: false },
        { id: 'publisher', label: 'Publisher', file: 'publisher.txt', tier: 1, default: false },
        { id: 'writer', label: 'Writer / composer', file: 'writer.txt', tier: 1, default: false },
        { id: 'description', label: 'Description', file: 'description.txt', tier: 1, default: false },
        { id: 'playbackCount', label: 'Plays', file: 'plays.txt', tier: 1, default: false },
        { id: 'likesCount', label: 'Likes', file: 'likes.txt', tier: 1, default: false },
        { id: 'repostsCount', label: 'Reposts', file: 'reposts.txt', tier: 1, default: false },
        { id: 'commentCount', label: 'Comments', file: 'comments.txt', tier: 1, default: false },
        { id: 'downloadCount', label: 'Downloads', file: 'downloads.txt', tier: 1, default: false },
        { id: 'uploader', label: 'Uploader', file: 'uploader.txt', tier: 1, default: false },
        { id: 'uploaderUrl', label: 'Uploader URL', file: 'uploader-url.txt', tier: 1, default: false },
        { id: 'uploaderFollowers', label: 'Uploader followers', file: 'uploader-followers.txt', tier: 1, default: false },
        { id: 'waveformUrl', label: 'Waveform URL', file: 'waveform-url.txt', tier: 1, default: false },
        { id: 'coverUrl', label: 'Cover URL (hi-res)', file: 'cover-url.txt', tier: 1, default: false },
        { id: 'bpm', label: 'BPM', file: 'bpm.txt', tier: 1, default: false },
        { id: 'key', label: 'Key', file: 'key.txt', tier: 1, default: false },
        { id: 'monetization', label: 'Monetization', file: 'monetization.txt', tier: 1, default: false }
      ]
    }
  ];

  // Flat lookup
  var ALL = [];
  SECTIONS.forEach(function (sec) {
    sec.components.forEach(function (c) {
      ALL.push(Object.assign({ section: sec.id }, c));
    });
  });
  var BY_ID = {};
  ALL.forEach(function (c) { BY_ID[c.id] = c; });

  function defaults() {
    var components = {};
    ALL.forEach(function (c) { components[c.id] = { enabled: !!c.default, file: c.file }; });
    return {
      enabled: true,
      clearOnStop: false,
      writeJson: false,          // nowplaying.json is opt-in
      jsonFile: 'nowplaying.json',
      components: components
    };
  }

  // Merge stored settings over defaults (tolerates missing/new components).
  function merge(stored) {
    var d = defaults();
    var s = stored || {};
    var out = Object.assign({}, d, {
      enabled: s.enabled !== false,
      clearOnStop: !!s.clearOnStop,
      writeJson: s.writeJson === true,
      jsonFile: s.jsonFile || d.jsonFile
    });
    var comps = {};
    ALL.forEach(function (c) {
      var sc = (s.components || {})[c.id];
      comps[c.id] = {
        enabled: sc ? sc.enabled !== false : !!c.default,
        file: (sc && sc.file) || c.file
      };
    });
    out.components = comps;
    return out;
  }

  // True when at least one enabled component needs the API (Tier 1). This
  // replaces any separate "fetch metadata" switch.
  function needsApi(settings) {
    if (!settings) return false;
    var comps = settings.components || {};
    return ALL.some(function (c) { return c.tier === 1 && comps[c.id] && comps[c.id].enabled; });
  }

  var api = {
    SECTIONS: SECTIONS,
    ALL: ALL,
    BY_ID: BY_ID,
    defaults: defaults,
    merge: merge,
    needsApi: needsApi,
    ids: function () { return ALL.map(function (c) { return c.id; }); }
  };

  global.DNPcomponents = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
