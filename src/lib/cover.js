/*
 * Cover-art filename + format resolution.
 *
 * The "Cover art" setting names the output. Two forms:
 *   "cover"      -> keep whatever format SoundCloud served (original extension)
 *   "cover.jpg"  -> force .jpg (convert the downloaded image if it is not JPEG)
 *
 * Recognised target formats: jpg / jpeg / png / webp. Anything else is treated
 * as part of the base name, so "cover" and "cover.foo" behave the same way
 * (never silently renamed).
 *
 * Kept pure (no DOM) so it is unit-testable; the actual pixel conversion lives
 * in src/offscreen.js.
 */
(function (global) {
  'use strict';

  var EXT_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  var MIME_EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

  function extFromMime(mime) {
    return MIME_EXT[String(mime || '').split(';')[0].trim().toLowerCase()] || null;
  }

  // configuredName + the served content-type -> how to write the cover.
  //   { base, ext, mime, convert }
  function resolveCoverTarget(configuredName, sourceType) {
    var name = String(configuredName == null ? '' : configuredName).trim() || 'cover';
    var srcExt = extFromMime(sourceType) || 'jpg';
    var m = /^(.*)\.([A-Za-z0-9]+)$/.exec(name);
    if (m) {
      var ext = m[2].toLowerCase();
      if (EXT_MIME[ext]) {
        return { base: m[1] || 'cover', ext: ext, mime: EXT_MIME[ext], convert: ext !== srcExt };
      }
      // unrecognised extension: treat the whole string as the base name
      return { base: name, ext: srcExt, mime: EXT_MIME[srcExt] || 'image/jpeg', convert: false };
    }
    return { base: name, ext: srcExt, mime: EXT_MIME[srcExt] || 'image/jpeg', convert: false };
  }

  var api = {
    EXT_MIME: EXT_MIME,
    extFromMime: extFromMime,
    resolveCoverTarget: resolveCoverTarget
  };

  global.DNPcover = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
