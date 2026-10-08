'use strict';
// Full live test over CDP, built on the proven probe harness.
//   node live.js <port> <extPath>
// Writes progress to C:\temp-dnp\live.txt and result to stdout.
const fs = require('fs');
const http = require('http');

const PORT = parseInt(process.argv[2] || '9227', 10);
const EXT = process.argv[3] || 'C:\\temp-dnp\\ext';
const LOG = 'C:\\temp-dnp\\live.txt';
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
      // Service workers can be suspended and restarted mid-run; (re)attach on demand.
      const swSessions = new Map();
      const swEval = async (expression, tries = 8) => {
        for (let i = 0; i < tries; i++) {
          const t = (await cdp.send('Target.getTargets')).targetInfos.find((tt) => tt.type === 'service_worker' && tt.url.indexOf(extId) !== -1);
          if (t) {
            try {
              let sid = swSessions.get(t.targetId);
              if (!sid) {
                sid = (await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
                swSessions.set(t.targetId, sid);
                await cdp.send('Runtime.enable', {}, sid);
              }
              return await evalIn(cdp, sid, expression);
            } catch (e) { swSessions.delete(t.targetId); }
          } else {
            // Worker asleep: nudge it with a fresh SoundCloud tab.
            try { await cdp.send('Target.createTarget', { url: 'https://soundcloud.com/' }); } catch (e) { /* noop */ }
          }
          await sleep(600);
        }
        throw new Error('swEval gave up on: ' + expression.slice(0, 60));
      };

      const mf = await swEval('chrome.runtime.getManifest().name + " v" + chrome.runtime.getManifest().version');
      check('manifest readable in SW', /datNowPlaying/.test(mf), mf);
      const off = await swEval(`(async()=>{ await ensureOffscreen(); return await chrome.offscreen.hasDocument(); })()`);
      check('offscreen writer document created', off === true, 'hasDocument=' + off);
      const st = await swEval(`(async()=>{ try { return await askSelfTest(); } catch(e){ return {ok:false,error:String(e)}; } })()`);
      check('writer writes files + json + cover and reads back (OPFS)', st && st.ok === true, JSON.stringify(st));
      if (st) log('  self-test: imageBytes=' + st.imageBytes + ' converted=' + JSON.stringify(st.converted) + ' steps=' + JSON.stringify(st.steps));
      check('cover format conversion (png -> jpg) produced art.jpg', !!(st && st.converted && st.converted.name === 'art.jpg' && st.converted.bytes > 0), JSON.stringify(st && st.converted));

      // Tier 1: hit the real SoundCloud API from the extension's own worker
      const apiRes = await swEval(`(async()=>{ try { const r = await DNPapi.fetchTrack('https://soundcloud.com/forss/flickermood'); return r.ok ? r.fields : { error: r.error }; } catch(e){ return { error: String(e) }; } })()`);
      check('Tier 1: resolved a real track from the SoundCloud API', !!(apiRes && apiRes.genre), JSON.stringify(apiRes).slice(0, 300));
      if (apiRes && apiRes.genre) log('  api: genre=' + apiRes.genre + ' label=' + apiRes.label + ' isrc=' + apiRes.isrc + ' plays=' + apiRes.playbackCount + ' writer=' + apiRes.writer);

      // Value assembly for the enabled components
      const asm = await swEval(`(()=>{ const v = DNPvalues.buildValues({ title:'T', artist:'A', playing:true, position:30, duration:120, volume:80, muted:false }, null); return JSON.stringify({ elapsed:v.elapsed, remaining:v.remaining, progress:v.progress, volume:v.volume, playing:v.playing, title:v.title }); })()`);
      let av = {}; try { av = JSON.parse(asm); } catch (e) {}
      check('assembles live values correctly', av.elapsed && av.elapsed.json === 30 && av.progress && av.progress.json === 25 && av.remaining && av.remaining.json === 90 && av.volume && av.volume.json === 80, asm);

      // nowplaying.json is opt-in; the payload must appear only when settings.writeJson is on.
      const jsonOff = await swEval(`(()=>{ const s = DNPcomponents.defaults(); const v = DNPvalues.buildValues({ title:'T' }, null); const p = DNPvalues.buildTrackPayload(s, {}, v, null); return JSON.stringify({ writeJson: s.writeJson, json: p.json, files: p.files.map(f=>f.name) }); })()`);
      const jOff = JSON.parse(jsonOff);
      check('nowplaying.json is NOT written by default', jOff.writeJson === false && jOff.json === null && jOff.files.indexOf('track.txt') !== -1, jsonOff);

      const jsonOn = await swEval(`(()=>{ const s = DNPcomponents.defaults(); s.writeJson = true; const v = DNPvalues.buildValues({ title:'T', artist:'A' }, null); const p = DNPvalues.buildTrackPayload(s, {}, v, null); return p.json ? p.json.text : 'MISSING'; })()`);
      let jOn = null; try { jOn = JSON.parse(jsonOn); } catch (e) {}
      check('nowplaying.json IS written when enabled', !!(jOn && jOn.title === 'T' && jOn.artist === 'A'), jsonOn);

      // Poll for the content script's first message reaching the background.
      let tabsArr = [];
      for (let i = 0; i < 30 && tabsArr.length === 0; i++) {
        try {
          const tabsInfo = await swEval('JSON.stringify(Array.from(tabStates.values()).map(v=>({playing:v.playing,title:v.title,artist:v.artist,artwork:!!v.artworkUrl,sources:v.sources})))', 2);
          tabsArr = JSON.parse(tabsInfo);
        } catch (e) { tabsArr = []; }
        if (tabsArr.length === 0) await sleep(500);
      }
      check('background received state from SoundCloud tab', tabsArr.length >= 1, JSON.stringify(tabsArr));
      if (tabsArr.length) log('  tab state in background: ' + JSON.stringify(tabsArr));
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
      const has = await evalInContext(cdp, iso.id, 'typeof globalThis.__DNP_READ__ === "function"');
      check('content script injected (isolated world)', has === true, 'typeof=' + has);
      if (has) {
        const stt = await evalInContext(cdp, iso.id, 'JSON.stringify(globalThis.__DNP_READ__())');
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
