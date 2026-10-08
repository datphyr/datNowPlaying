/*
 * Tiny IndexedDB helper for persisting the FileSystemDirectoryHandle chosen by
 * the user. Directory handles are structured-cloneable, so they survive in IDB
 * and can be reused later (including from the offscreen document).
 *
 * Shared by src/options.js and src/offscreen.js (both run in extension pages,
 * same origin, same database).
 */
(function (global) {
  'use strict';

  var DB_NAME = 'scnp';
  var DB_VERSION = 1;
  var STORE = 'handles';
  var KEY = 'dir';

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  async function getHandle() {
    var db = await openDb();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE, 'readonly');
      var req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = function () { resolve(req.result || null); };
      req.onerror = function () { reject(req.error); };
      tx.oncomplete = function () { db.close(); };
    });
  }

  async function saveHandle(handle) {
    var db = await openDb();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(handle, KEY);
      tx.oncomplete = function () { db.close(); resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  }

  async function clearHandle() {
    var db = await openDb();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = function () { db.close(); resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  }

  global.SCNPIdb = {
    getHandle: getHandle,
    saveHandle: saveHandle,
    clearHandle: clearHandle
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
