'use strict';
// Full live test over CDP, built on the proven probe harness.
//   node live.js <port> <extPath>
// Writes progress to C:\temp-scnp\live.txt and result to stdout.
const fs = require('fs');
const http = require('http');

const PORT = parseInt(process.argv[2] || '9227', 10);
const EXT = process.argv[3] || 'C:\\temp-scnp\\ext';
const LOG = 'C:\\temp-scnp\\live.txt';
const lines = [];
function log(s) { lines.push(s); fs.writeFileSync(LOG, lines.join('\n')); }
let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; log('  ok  ' + name); }
  else { failed++; log('FAIL  ' + name + (extra ? '  << ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('http timeout')));
  });
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url); this.id = 0; this.pending = new Map();
    this.exceptions = [];
    this.contexts = [];
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
        return;
      }
      if (m.method === 'Runtime.executionContextCreated') {
        const c = m.params.context;
        this.contexts.push({ sessionId: m.sessionId, id: c.id, name: c.name, origin: c.origin, auxData: c.auxData || {} });
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const ex = m.params.exceptionDetails;
        this.exceptions.push((ex && (ex.exception && ex.exception.description || ex.text)) || 'exception');
      }
    });
  }
  ready() { return new Promise((res, rej) => { if (this.ws.readyState === 1) return res(); this.ws.addEventListener('open', () => res()); this.ws.addEventListener('error', () => rej(new Error('ws error'))); }); }
  send(method, params = {}, sessionId) {
    const id = ++this.id; const p = { id, method, params }; if (sessionId) p.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify(p));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('TIMEOUT ' + method)); } }, 20000);
    });
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

async function evalIn(cdp, sessionId, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, sessionId);
  if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
  return r.result && r.result.value;
}
async function findTarget(cdp, pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = await cdp.send('Target.getTargets');
    const hit = t.targetInfos.find(pred);
    if (hit) return hit;
    await sleep(400);
  }
  return null;
}

async function evalInContext(cdp, contextId, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, contextId }, cdp._csession);
  if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
  return r.result && r.result.value;
}

(async () => {
  try {
    log('live test port=' + PORT + ' ext=' + EXT);
    const v = await httpJson('/json/version');
    log('browser=' + v.Browser);
    const cdp = new CDP(v.webSocketDebuggerUrl);
    await cdp.ready();
    log('ws connected');
    await cdp.send('Target.setDiscoverTargets', { discover: true });

    let extId = null;
    try { const r = await cdp.send('Extensions.loadUnpacked', { path: EXT }); extId = r && r.id; log('loaded extension id=' + extId); }
    catch (e) { log('loadUnpacked failed: ' + e.message); }
    check('extension loaded', !!extId, 'id=' + extId);
    if (!extId) { finish(cdp); return; }

    // open SoundCloud tab -> wakes the SW, injects the content script
    const nt = await cdp.send('Target.createTarget', { url: 'https://soundcloud.com/' });
    const page = (await cdp.send('Target.attachToTarget', { targetId: nt.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, page);

    log('waiting for service worker of ' + extId);
    const sw = await findTarget(cdp, (t) => t.type === 'service_worker' && t.url.indexOf(extId) !== -1, 30000);
    check('service worker running for our extension', !!sw, sw ? sw.url : 'not found');

    if (sw) {
      const s = (await cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true })).sessionId;
      await cdp.send('Runtime.enable', {}, s);
      const mf = await evalIn(cdp, s, 'chrome.runtime.getManifest().name + " v" + chrome.runtime.getManifest().version');
      check('manifest readable in SW', /SoundCloud Now Playing/.test(mf), mf);
      const off = await evalIn(cdp, s, `(async()=>{ await ensureOffscreen(); return await chrome.offscreen.hasDocument(); })()`);
      check('offscreen writer document created', off === true, 'hasDocument=' + off);
      const st = await evalIn(cdp, s, `(async()=>{ try { return await askSelfTest(); } catch(e){ return {ok:false,error:String(e)}; } })()`);
      check('writer writes 3 files + reads back (OPFS)', st && st.ok === true, JSON.stringify(st));
      if (st && st.ok) log('  self-test readBack=' + JSON.stringify(st.readBack) + ' imageBytes=' + st.imageBytes);
      await sleep(1000);
      const tabsInfo = await evalIn(cdp, s, 'JSON.stringify(Array.from(tabStates.values()).map(v=>({playing:v.playing,title:v.title,artist:v.artist,artwork:!!v.artworkUrl,sources:v.sources})))');
      let tabsArr = [];
      try { tabsArr = JSON.parse(tabsInfo); } catch (e) {}
      check('background received state from SoundCloud tab', tabsArr.length >= 1, tabsInfo);
      if (tabsArr.length) log('  tab state in background: ' + tabsInfo);
    }

    // content script on the real page
    const url = await evalIn(cdp, page, 'location.href');
    check('page is soundcloud.com', /^https:\/\/soundcloud\.com\//.test(url || ''), url);
    // read the isolated-world content script of our extension
    let iso = null;
    for (let i = 0; i < 25 && !iso; i++) {
      iso = cdp.contexts.find((c) => c.sessionId === page && String(c.origin || '').indexOf(extId) !== -1);
      if (!iso) await sleep(300);
    }
    check('content script isolated world exists', !!iso, iso ? ('ctx ' + iso.id + ' ' + iso.origin) : 'no isolated context for ' + extId);
    if (iso) {
      cdp._csession = page;
      const has = await evalInContext(cdp, iso.id, 'typeof globalThis.__SCNP_READ__ === "function"');
      check('content script injected (isolated world)', has === true, 'typeof=' + has);
      if (has) {
        const stt = await evalInContext(cdp, iso.id, 'JSON.stringify(globalThis.__SCNP_READ__())');
        const p = JSON.parse(stt);
        check('content script returns a state object', p && 'playing' in p, stt);
        log('  state: playing=' + p.playing + ' title=' + JSON.stringify(p.title) + ' artist=' + JSON.stringify(p.artist) + ' sources=' + JSON.stringify(p.sources));
      }
    }
    check('no uncaught exceptions', cdp.exceptions.length === 0, cdp.exceptions.join(' | '));
    finish(cdp);
  } catch (e) {
    log('HARNESS ERROR: ' + (e && e.stack || e));
    failed++;
    finish(null, 2);
  }
})();

function finish(cdp, code) {
  if (cdp) cdp.close();
  log('RESULT ' + passed + ' passed, ' + failed + ' failed');
  process.exit(code != null ? code : (failed ? 1 : 0));
}
