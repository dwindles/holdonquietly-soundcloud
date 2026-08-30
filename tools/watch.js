// Subscribe to console/exception/network events while walking a list of routes.
// usage: node watch.js <secondsPerRoute> <url> [url...]
const secs = Number(process.argv[2]) || 8;
const urls = process.argv.slice(3);

async function main() {
  const list = await fetch('http://127.0.0.1:9222/json').then((r) => r.json());
  const pages = list.filter((t) => t.type === 'page' && /soundcloud\.com/.test(t.url || ''));
  if (!pages.length) { console.error('no soundcloud target'); process.exit(1); }
  const target = pages.sort((a, b) => a.url.length - b.url.length)[0];

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

  const seen = new Set();
  const hits = [];
  const note = (kind, text, extra) => {
    const t = String(text || '').slice(0, 300);
    if (!t || t === 'undefined') return;
    const k = kind + '|' + t;
    if (seen.has(k)) return;
    seen.add(k);
    hits.push({ kind, text: t, extra: extra ? String(extra).slice(0, 220) : undefined });
  };

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      return m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
    const p = m.params || {};
    if (m.method === 'Runtime.exceptionThrown') {
      const d = p.exceptionDetails || {};
      const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      note('EXCEPTION', desc, (d.url || '') + ':' + (d.lineNumber || ''));
    } else if (m.method === 'Runtime.consoleAPICalled' && (p.type === 'error' || p.type === 'warning')) {
      note(p.type.toUpperCase(), (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' '));
    } else if (m.method === 'Log.entryAdded') {
      const e = p.entry || {};
      if (e.level === 'error') note('LOG:' + (e.source || ''), e.text, e.url);
    } else if (m.method === 'Network.loadingFailed') {
      if (p.type === 'Image' || p.type === 'Script' || p.type === 'Stylesheet') {
        note('NETFAIL:' + p.type, p.errorText, p.blockedReason);
      }
    }
  };

  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  await send('Runtime.enable', {});
  await send('Log.enable', {});
  await send('Network.enable', {});

  for (const u of urls) {
    await send('Page.enable', {}).catch(() => {});
    await send('Runtime.evaluate', { expression: 'location.href=' + JSON.stringify(u) });
    await new Promise((r) => setTimeout(r, secs * 1000));
    // re-enable after the document swap so we keep receiving events
    await send('Runtime.enable', {}).catch(() => {});
    await send('Log.enable', {}).catch(() => {});
    console.error('[watch] done ' + u + '  (' + hits.length + ' so far)');
  }

  console.log(JSON.stringify({ count: hits.length, hits }, null, 1));
  ws.close();
}
main().catch((e) => { console.error('[watch] fail:', e.message); process.exit(1); });
