// Minimal CDP client: evaluate JS in the app's SoundCloud page.
// usage: node cdp.js <file-with-js>   |   node cdp.js -e "<expr>"
const fs = require('fs');

async function main() {
  const arg = process.argv[2];
  const expr = arg === '-e' ? process.argv[3] : fs.readFileSync(arg, 'utf8');

  const list = await fetch('http://127.0.0.1:9222/json').then((r) => r.json());
  const pages = list.filter((t) => t.type === 'page' && /soundcloud\.com/.test(t.url || ''));
  if (!pages.length) {
    console.error('no soundcloud page target. targets:');
    list.forEach((t) => console.error(' ', t.type, t.url));
    process.exit(1);
  }
  // Prefer the top-level app frame (not an ad/oauth popup).
  const target = pages.sort((a, b) => (a.url.length - b.url.length))[0];
  console.error('[cdp] target:', target.url);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params) =>
    new Promise((res, rej) => {
      const mid = ++id;
      pending.set(mid, { res, rej });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    }
  };

  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const out = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
    allowUnsafeEvalBlockedByCSP: true,
  });
  if (out.exceptionDetails) {
    console.error('[cdp] EXCEPTION:', JSON.stringify(out.exceptionDetails.exception || out.exceptionDetails, null, 1));
    process.exit(2);
  }
  const v = out.result && out.result.value;
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
  ws.close();
}
main().catch((e) => { console.error('[cdp] fail:', e.message); process.exit(1); });
