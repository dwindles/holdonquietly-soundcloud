// Capture a screenshot of the app's SoundCloud page over CDP.
// usage: node shot.js <out.png>
const fs = require('fs');

async function main() {
  const out = process.argv[2] || 'shot.png';
  const list = await fetch('http://127.0.0.1:9222/json').then((r) => r.json());
  const pages = list.filter((t) => t.type === 'page' && /soundcloud\.com/.test(t.url || ''));
  if (!pages.length) { console.error('no soundcloud target'); process.exit(1); }
  const target = pages.sort((a, b) => a.url.length - b.url.length)[0];
  console.error('[shot] target:', target.url);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
  console.log('wrote', out, fs.statSync(out).size, 'bytes');
  ws.close();
}
main().catch((e) => { console.error('[shot] fail:', e.message); process.exit(1); });
