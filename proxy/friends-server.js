// holdonquietly friends-feed backend - zero dependencies (built-in http).
// Each app POSTs its now-playing to /presence; everyone reads /friends.
// The community feed lives at /feed (GET list, POST one item).
// Reached two ways: the old plain-http :8790 (installed apps up to v1.4.0) and
// https://sc.holdonquietly.com/__hoq/fb/* through nginx (v1.5.0+).
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = 8790;
const TTL = 5 * 60 * 1000; // a person drops off the feed after 5 min of silence
const presences = new Map(); // id -> {name, sc, title, artist, cover, url, pos, dur, paused, rate, ts}
// Track link + position let friends "listen along" (v1.6.25+). A soundcloud.com
// track link only (the app already drops secret links before sending).
const scUrl = (v) => { const t = url(v, 300); return /^https:\/\/(www\.|m\.)?soundcloud\.com\/[^/]+\/[^/?#]+/i.test(t) ? t : ''; };
const num = (v, lo, hi, d) => { const n = +v; return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };

const FEED_FILE = path.join(__dirname, 'feed.json');
const FEED_MAX = 100;
let feed = [];
try { const f = JSON.parse(fs.readFileSync(FEED_FILE, 'utf8')); if (Array.isArray(f)) feed = f.slice(0, FEED_MAX); } catch (e) {}
let saveTimer = null;
function saveFeed() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = FEED_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(feed), (err) => { if (!err) fs.rename(tmp, FEED_FILE, () => {}); });
  }, 500);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
const s = (v, n) => String(v == null ? '' : v).slice(0, n);
// Links and images in the feed come from strangers: only plain https URLs get
// through (a javascript: or data: URL would run or hide things in every reader).
const url = (v, n) => { const t = s(v, n).trim(); return /^https:\/\/[^\s"'<>\\]+$/i.test(t) ? t : ''; };

// Per-address rate limits (nginx passes the real address).
function limiter(max, windowMs) {
  const seen = new Map(); // ip -> [timestamps]
  return (ip) => {
    const now = Date.now();
    const list = (seen.get(ip) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) { seen.set(ip, list); return false; }
    list.push(now); seen.set(ip, list);
    if (seen.size > 5000) seen.clear();
    return true;
  };
}
const allowPost = limiter(5, 60000);        // community feed posts
// An app reports every ~8 s while playing (more when skipping), and a few apps
// can share one address.
const allowPresence = limiter(60, 60000);

// Only nginx (on this box) may name the real address; direct :8790 callers get their own.
function clientIp(req) {
  const peer = String(req.socket.remoteAddress || '?');
  return /^(::ffff:)?127\.0\.0\.1$|^::1$/.test(peer) ? String(req.headers['x-real-ip'] || peer) : peer;
}

// Presence is anyone's to post, so it's bounded: unlimited posts with made-up ids
// grew the map until the box ran out of memory, and every app downloads the whole
// list each poll. Stale entries now go every minute, not only when someone reads
// /friends, and new ids stop at a ceiling.
const MAX_PRESENCES = 2000;
function sweepPresences() {
  const now = Date.now();
  for (const [id, p] of presences) if (now - p.ts > TTL) presences.delete(id);
}
setInterval(sweepPresences, 60 * 1000).unref();

function readBody(req, max, cb) {
  let body = '', dead = false;
  req.on('data', (c) => { body += c; if (body.length > max && !dead) { dead = true; req.destroy(); } });
  req.on('end', () => { if (!dead) cb(body); });
}

const server = http.createServer((req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method === 'POST' && req.url === '/presence') {
    if (!allowPresence(clientIp(req))) { res.writeHead(429); return res.end('slow down'); }
    readBody(req, 6000, (body) => {
      let code = 200;
      try {
        const d = JSON.parse(body);
        if (d && d.id) {
          const id = s(d.id, 64);
          if (!d.title) {
            presences.delete(id); // stopped playing
          } else {
            if (!presences.has(id) && presences.size >= MAX_PRESENCES) sweepPresences();
            if (!presences.has(id) && presences.size >= MAX_PRESENCES) code = 503;   // full: known ids still update
            else presences.set(id, {
              name: s(d.name, 60), sc: url(d.sc, 200),
              title: s(d.title, 200), artist: s(d.artist, 120),
              cover: url(d.cover, 400), url: scUrl(d.url),
              pos: num(d.pos, 0, 86400, 0), dur: num(d.dur, 0, 86400, 0), paused: d.paused === true, rate: num(d.rate, 0.5, 1.5, 1),
              ts: Date.now(),
            });
          }
        }
      } catch (e) {}
      res.writeHead(code); res.end(code === 200 ? 'ok' : 'full');
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/friends') {
    const now = Date.now();
    const list = [];
    for (const [id, p] of presences) {
      if (now - p.ts > TTL) { presences.delete(id); continue; }
      list.push({ id, name: p.name, sc: p.sc, title: p.title, artist: p.artist, cover: p.cover,
        url: p.url, pos: p.pos, dur: p.dur, paused: p.paused, rate: p.rate, age: now - p.ts });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
    return;
  }

  if (req.method === 'GET' && req.url === '/feed') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(feed));
    return;
  }

  if (req.method === 'POST' && req.url === '/feed') {
    const ip = clientIp(req);
    readBody(req, 8000, (body) => {
      let d;
      try { d = JSON.parse(body); } catch (e) { res.writeHead(400); return res.end('bad json'); }
      const text = s(d && d.text, 500).trim();
      const t = d && d.track && typeof d.track === 'object' ? d.track : null;
      const track = t && t.title ? { title: s(t.title, 200), artist: s(t.artist, 120), cover: url(t.cover, 400), url: url(t.url, 300) } : null;
      if (!d || !d.id || (!text && !track)) { res.writeHead(400); return res.end('empty'); }
      if (!allowPost(ip)) { res.writeHead(429); return res.end('slow down'); }
      feed.unshift({
        id: s(d.id, 64), name: s(d.name, 60) || 'Someone', avatar: url(d.avatar, 400),
        url: url(d.url, 300), text, track, ts: Date.now(),
      });
      if (feed.length > FEED_MAX) feed.length = FEED_MAX;
      saveFeed();
      res.writeHead(200); res.end('ok');
    });
    return;
  }

  if (req.url === '/' || req.url === '/health') { res.writeHead(200); return res.end('holdonquietly friends backend ok'); }
  res.writeHead(404); res.end();
});
server.listen(PORT, () => console.log('holdonquietly friends backend listening on :' + PORT));
