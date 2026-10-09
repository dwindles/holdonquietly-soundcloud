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
// It also relays now-playing from the phone to the desktop app (/__hoq/np, see
// below), so phone listening can show as Discord Rich Presence.
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

// ---------------------------------------------------------------------------
// Now-playing relay, phone -> desktop, for Discord Rich Presence. Discord only
// takes presence from a program beside its desktop client, so the phone reports
// here and the holdonquietly app on the PC long-polls and puts it on Discord.
// The two are matched by asking SoundCloud whose login token each one holds, so
// there is nothing extra to pair. Only the latest track per account is kept.
const NP_WAIT_MS = 25 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const TOKEN = /^[A-Za-z0-9._~+\/=-]{8,256}$/;
const slots = new Map();   // SoundCloud user id -> { track, at, v, waiters }
const owners = new Map();  // sha256(token) -> { uid, exp }
let lookups = [];          // timestamps of recent SoundCloud lookups (rate limit)

async function whoIs(token) {
  if (!TOKEN.test(token || '')) return null;
  const h = crypto.createHash('sha256').update(token).digest('hex');
  const c = owners.get(h);
  if (c && c.exp > Date.now()) return c.uid;
  // A flood of made-up tokens shouldn't turn into a flood of calls to SoundCloud.
  const now = Date.now();
  lookups = lookups.filter((t) => now - t < 60 * 1000);
  if (lookups.length >= 30) return null;
  lookups.push(now);
  let uid = null;
  try {
    const r = await fetch('https://api-v2.soundcloud.com/me', {
      headers: { Authorization: 'OAuth ' + token, Accept: 'application/json', 'User-Agent': UA, Origin: 'https://soundcloud.com' },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) { const j = await r.json(); if (j && j.id) uid = String(j.id); }
    else if (r.status !== 401 && r.status !== 403) return null;   // a SoundCloud hiccup: don't cache it
  } catch (e) { return null; }
  if (owners.size > 2000) owners.clear();
  owners.set(h, { uid, exp: now + (uid ? 30 : 1) * 60 * 1000 });
  return uid;
}

function cookieOf(header, name) {
  for (const part of String(header || '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return '';
}

function slot(uid) {
  let s = slots.get(uid);
  if (!s) {
    if (slots.size > 500) slots.clear();
    // Random start, so a desktop still holding a version from before a restart
    // can't mistake the new state for the one it already has.
    s = { track: null, at: 0, v: crypto.randomInt(1e9), waiters: new Set() };
    slots.set(uid, s);
  }
  return s;
}

// The phone sees everything through the proxy's hostnames. Discord needs the
// real ones: soundcloud.com links, and artwork from SoundCloud's CDN.
function cleanTrack(d, proxyHost) {
  const str = (v, n) => (typeof v === 'string' ? v : '').trim().slice(0, n);
  const num = (v) => (Number.isFinite(v) && v >= 0 && v < 86400 ? Math.round(v) : 0);
  const title = str(d.title, 200);
  const rp = d.rp && typeof d.rp === 'object' ? d.rp : {};
  if (!title || rp.on === false) return null;
  const page = (v) => {
    try {
      const u = new URL(str(v, 512));
      if (u.protocol !== 'https:' || (u.hostname !== 'soundcloud.com' && u.hostname !== proxyHost)) return '';
      return 'https://soundcloud.com' + u.pathname;
    } catch (e) { return ''; }
  };
  const art = (v) => {
    try {
      const u = new URL(str(v, 512));
      const m = u.hostname.match(/^(i[1-4])\.(.+)$/);
      if (u.protocol !== 'https:' || !m || (m[2] !== 'sndcdn.com' && m[2] !== proxyHost)) return '';
      return 'https://' + m[1] + '.sndcdn.com' + u.pathname;
    } catch (e) { return ''; }
  };
  return {
    title, artist: str(d.artist, 200),
    url: page(d.url), artistUrl: page(d.artistUrl), cover: art(d.cover),
    pos: num(d.pos), dur: num(d.dur), paused: d.paused === true,
    status: ['artist', 'song', 'app'].includes(rp.status) ? rp.status : 'artist',
    buttons: rp.buttons !== false, pauseHide: rp.pauseHide !== false,
  };
}

function npReport(req, res) {
  readBody(req, async (body) => {
    const uid = await whoIs(cookieOf(req.headers.cookie, 'oauth_token'));
    if (!uid) return send(res, 401, '{"error":"not signed in"}');
    let d;
    try { d = JSON.parse(body); } catch (e) { return send(res, 400, '{"error":"bad json"}'); }
    const s = slot(uid);
    s.track = cleanTrack(d, String(req.headers['x-hoq-host'] || 'sc.holdonquietly.com'));
    s.at = Date.now();
    s.v++;
    for (const wake of [...s.waiters]) wake();
    send(res, 200, '{"ok":true}');
  });
}

// GET /__hoq/np?v=<version it has>: answers at once if there's something newer,
// otherwise holds the request up to 25 s for the next report.
async function npListen(req, res) {
  const auth = String(req.headers.authorization || '');
  const uid = await whoIs(auth.startsWith('OAuth ') ? auth.slice(6) : '');
  if (!uid) return send(res, 401, '{"error":"not signed in"}');
  const s = slot(uid);
  const have = Number(new URL(req.url, 'http://x').searchParams.get('v'));
  const reply = () => {
    if (res.writableEnded) return;
    send(res, 200, JSON.stringify({ v: s.v, age: s.at ? Math.round((Date.now() - s.at) / 1000) : -1, track: s.track }));
  };
  if (have !== s.v) return reply();
  const done = () => { clearTimeout(timer); s.waiters.delete(done); reply(); };
  const timer = setTimeout(done, NP_WAIT_MS);
  s.waiters.add(done);
  // res, not req: since Node 16 a request's 'close' fires once its (empty) body
  // is read, which would end every long-poll immediately.
  res.on('close', () => { clearTimeout(timer); s.waiters.delete(done); });
}

http.createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;

  if (path === '/__hoq/np') {
    if (req.method === 'POST') return npReport(req, res);
    if (req.method === 'GET') return void npListen(req, res).catch(() => send(res, 500, '{"error":"failed"}'));
  }

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
