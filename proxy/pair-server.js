// One-time phone login links for the holdonquietly proxy (pm2 app "hoq-pair").
//
// The desktop app is already signed in. When the phone can't see its screen to
// scan the QR, the app POSTs SoundCloud's two login cookies here over https
// (nginx /__hoq/pair -> 127.0.0.1:3097) and gets back a random id. The link
// https://<proxy>/__hoq/pair/<id> then works ONCE, within 10 minutes, and carries
// only the id — so pasting it into a chat doesn't paste the login itself.
//
// Opening the link only loads a small page; that page's script claims the login
// with a POST. Link-preview bots fetch pages but don't run scripts, so they can't
// burn a link before the person taps it. The claimed cookies go to
// /#hoq-login=…, the fragment the proxy page already redeems.
//
// Nothing is written to disk, and nothing is logged except counts.
const http = require('http');
const crypto = require('crypto');

const PORT = 3097;
const TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 50;
// Same rule the page applies: RFC 6265 cookie-octet (printable ASCII minus
// space, " , ; and \). sc_session is URL-encoded JSON, so it has { } % :.
const SAFE = /^[!#-+\--:<-\[\]-~]{8,1024}$/;
const ID = /^\/__hoq\/pair\/([A-Za-z0-9_-]{16,64})$/;

const pending = new Map();   // id -> { o, s, exp }

function sweep() {
  const now = Date.now();
  for (const [id, v] of pending) if (v.exp <= now) pending.delete(id);
}
setInterval(sweep, 60 * 1000).unref();

function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'application/json',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

const DEAD = 'This link has expired or was already used. Make a new one from the app on your PC.';

const PAGE = `<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signing you in…</title>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  background:#0b0b0e;color:#c9c9d2;font:15px/1.5 -apple-system,Inter,Arial,sans-serif;text-align:center;padding:24px">
<div><div style="font-size:18px;font-weight:700;color:#fff;margin-bottom:6px">holdonquietly</div>
<div id="m">Signing you in…</div></div>
<script>
fetch(location.pathname, { method: 'POST' })
  .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
  .then((d) => location.replace(location.origin + '/#hoq-login=' + d.frag))
  .catch(() => { document.getElementById('m').textContent = ${JSON.stringify(DEAD)}; });
</script>`;

function readBody(req, cb) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
  req.on('end', () => cb(body));
}

http.createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;

  // Create: POST /__hoq/pair {o, s} -> {id, expiresIn}
  if (req.method === 'POST' && path === '/__hoq/pair') {
    return readBody(req, (body) => {
      let d;
      try { d = JSON.parse(body); } catch (e) { return send(res, 400, '{"error":"bad json"}'); }
      if (!SAFE.test(d.o || '') || (d.s && !SAFE.test(d.s))) return send(res, 400, '{"error":"bad payload"}');
      sweep();
      if (pending.size >= MAX_PENDING) return send(res, 429, '{"error":"too many pending links"}');
      const id = crypto.randomBytes(18).toString('base64url');   // 144 random bits
      pending.set(id, { o: d.o, s: d.s || '', exp: Date.now() + TTL_MS });
      console.log('pair: link created (' + pending.size + ' pending)');
      send(res, 200, JSON.stringify({ id, expiresIn: TTL_MS / 1000 }));
    });
  }

  const m = path.match(ID);
  if (m) {
    // Open: GET only serves the claiming page — it never uses the link up.
    if (req.method === 'GET') {
      const v = pending.get(m[1]);
      if (!v || v.exp <= Date.now()) return send(res, 410, PAGE.replace('Signing you in…</div>', DEAD + '</div>').replace(/<script>[\s\S]*<\/script>/, ''), 'text/html; charset=utf-8');
      return send(res, 200, PAGE, 'text/html; charset=utf-8');
    }
    // Claim: POST uses the link up, once.
    if (req.method === 'POST') {
      const v = pending.get(m[1]);
      pending.delete(m[1]);
      if (!v || v.exp <= Date.now()) { console.log('pair: dead link claimed'); return send(res, 410, '{"error":"expired"}'); }
      console.log('pair: link used');
      return send(res, 200, JSON.stringify({ frag: Buffer.from(JSON.stringify({ o: v.o, s: v.s })).toString('base64url') }));
    }
  }

  send(res, 404, '{"error":"not found"}');
}).listen(PORT, '127.0.0.1', () => console.log('hoq-pair listening on 127.0.0.1:' + PORT));
