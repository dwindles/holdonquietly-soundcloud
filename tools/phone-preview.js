// Phone preview: headless Chrome at iPhone size on sc.holdonquietly.com, with the
// site's /hoq.js swapped for your local build (dist/holdonquietly.proxy.js), so a
// phone layout change can be seen before anything is uploaded. Its own Chrome
// profile in the temp folder: nothing touches your real browser.
//
//   node tools/build-userscript.js
//   node tools/phone-preview.js            control server on http://127.0.0.1:9400
//   node tools/phone-preview.js --headed   a visible window (sign it in once, by hand)
//
//   GET  /nav?u=URL&wait=MS     open a page, wait for load + MS (default 3000)
//   GET  /shot?f=name&full=1    screenshot -> <temp>/hoq-phone-preview/shots/name.png
//   POST /eval                  body = a JS expression; returns its JSON value
//   GET  /tap?x=&y=             a finger tap (CSS pixels)
//   GET  /size?w=&h=            viewport (default 390x844)
//   GET  /mode?m=local|live     which /hoq.js the next page load gets
//   GET  /logs                  page errors since the last call
//   GET  /quit
// Env: HOQ_PROFILE (profile folder), CHROME (browser exe), HOQ_PORT (9400).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const LOCAL_JS = path.join(ROOT, 'dist', 'holdonquietly.proxy.js');
const BASE = path.join(os.tmpdir(), 'hoq-phone-preview');
const PROFILE = process.env.HOQ_PROFILE || path.join(BASE, 'profile');
const SHOTS = path.join(BASE, 'shots');
const CTL = +process.env.HOQ_PORT || 9400, DBG = CTL - 67;   // 9333 by default
const HEADED = process.argv.includes('--headed');
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const CHROME = process.env.CHROME || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('No Chrome or Edge found; set CHROME to the browser exe.'); process.exit(1); }
fs.mkdirSync(SHOTS, { recursive: true });

let mode = 'local', W = 390, H = 844;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, [
  ...(HEADED ? [] : ['--headless=new', '--mute-audio', '--hide-scrollbars']),
  '--remote-debugging-port=' + DBG, '--user-data-dir=' + PROFILE,
  '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
  '--window-size=' + (HEADED ? '520,900' : W + ',' + H), 'about:blank',
], { stdio: 'ignore' });

let ws, nid = 0;
const pending = new Map(), handlers = {}, logs = [];
let loadWaiters = [];
const send = (method, params) => new Promise((res, rej) => {
  const id = ++nid;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params: params || {} }));
});
const metrics = () => send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true, screenWidth: W, screenHeight: H });
const evalJS = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) return { error: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
  return r.result ? r.result.value : undefined;
};
const loaded = () => new Promise((r) => { loadWaiters.push(r); setTimeout(r, 30000); });

handlers['Fetch.requestPaused'] = async (p) => {
  try {
    if (mode === 'local' && fs.existsSync(LOCAL_JS)) {
      await send('Fetch.fulfillRequest', {
        requestId: p.requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/javascript; charset=utf-8' }, { name: 'Cache-Control', value: 'no-store' }],
        body: fs.readFileSync(LOCAL_JS).toString('base64'),
      });
    } else {
      await send('Fetch.continueRequest', { requestId: p.requestId });
    }
  } catch (e) { logs.push('fetch: ' + e.message); }
};
handlers['Runtime.exceptionThrown'] = (p) => {
  const d = p.exceptionDetails || {};
  logs.push('EXC ' + ((d.exception && d.exception.description) || d.text || '').split('\n')[0] + ' @' + (d.url || '') + ':' + d.lineNumber);
};
handlers['Runtime.consoleAPICalled'] = (p) => {
  if (p.type === 'error') logs.push('error ' + (p.args || []).map((a) => (a.value !== undefined ? String(a.value) : a.description || '')).join(' ').slice(0, 300));
};
handlers['Page.loadEventFired'] = () => { const w = loadWaiters; loadWaiters = []; w.forEach((f) => f()); };

async function boot() {
  let page;
  for (let i = 0; i < 80 && !page; i++) {
    try { page = (await fetch('http://127.0.0.1:' + DBG + '/json/list').then((r) => r.json())).find((t) => t.type === 'page'); } catch (e) {}
    if (!page) await sleep(250);
  }
  if (!page) throw new Error('the browser never opened a page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    else if (m.method && handlers[m.method]) handlers[m.method](m.params);
  };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await metrics();
  await send('Emulation.setUserAgentOverride', { userAgent: UA, platform: 'iPhone', acceptLanguage: 'en-US' });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Fetch.enable', { patterns: [{ urlPattern: '*://sc.holdonquietly.com/hoq.js*', requestStage: 'Request' }] });
  if (HEADED) { await send('Page.navigate', { url: 'https://sc.holdonquietly.com/discover' }); }
}

// Every request waits for the browser: answering before it was connected
// dropped the first page load.
const ready = boot();
ready.then(() => console.log('phone preview on http://127.0.0.1:' + CTL + ' (hoq.js: ' + mode + ', shots: ' + SHOTS + ')'))
  .catch((e) => { console.error(e.message); try { chrome.kill(); } catch (er) {} process.exit(1); });

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), q = Object.fromEntries(u.searchParams);
  const out = (v) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v, null, 1)); };
  try {
    await ready;
    if (u.pathname === '/nav') {
      const l = loaded();
      await send('Page.navigate', { url: q.u });
      await l; await sleep(+q.wait || 3000);
      out({ ok: true, url: await evalJS('location.href') });
    } else if (u.pathname === '/shot') {
      const params = { format: 'png' };
      if (q.full === '1') {
        const h = await evalJS('Math.min(document.documentElement.scrollHeight, 6000)');
        params.captureBeyondViewport = true;
        params.clip = { x: 0, y: 0, width: W, height: h, scale: 1 };
      }
      const r = await send('Page.captureScreenshot', params);
      const f = path.join(SHOTS, (q.f || 'shot').replace(/[^\w.-]/g, '_') + '.png');
      fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
      out({ ok: true, file: f });
    } else if (u.pathname === '/eval') {
      let body = '';
      for await (const c of req) body += c;
      out(await evalJS(body));
    } else if (u.pathname === '/tap') {
      const pt = [{ x: +q.x, y: +q.y, radiusX: 4, radiusY: 4, force: 1, id: 1 }];
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt });
      await sleep(40);
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(+q.wait || 600);
      out({ ok: true });
    } else if (u.pathname === '/size') {
      W = +q.w || W; H = +q.h || H; await metrics(); out({ W, H });
    } else if (u.pathname === '/mode') {
      mode = q.m === 'live' ? 'live' : 'local'; out({ mode });
    } else if (u.pathname === '/logs') {
      out(logs.splice(0));
    } else if (u.pathname === '/quit') {
      out({ ok: true });
      try { chrome.kill(); } catch (e) {}
      setTimeout(() => process.exit(0), 300);
    } else { res.writeHead(404); res.end(); }
  } catch (e) { res.writeHead(500); res.end(String((e && e.stack) || e)); }
}).listen(CTL, '127.0.0.1');
process.on('SIGINT', () => { try { chrome.kill(); } catch (e) {} process.exit(0); });
