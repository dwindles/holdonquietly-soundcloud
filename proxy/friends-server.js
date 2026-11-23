// holdonquietly friends-feed backend - zero dependencies (built-in http).
// Each app POSTs its now-playing to /presence; everyone reads /friends.
// The community feed lives at /feed (GET list, POST one item).
// Reached two ways: the old plain-http :8790 (installed apps up to v1.4.0) and
// https://sc.holdonquietly.com/__hoq/fb/* through nginx (v1.5.0+).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PORT = +process.env.PORT || 8790;   // PORT=18790 for a local test copy
const TTL = 5 * 60 * 1000; // a person drops off the feed after 5 min of silence
const presences = new Map(); // id -> {name, sc, title, artist, cover, url, pos, dur, paused, rate, ts}
// Track link + position let friends "listen along" (v1.6.25+). A soundcloud.com
// track link only (the app already drops secret links before sending).
const scUrl = (v) => { const t = url(v, 300); return /^https:\/\/(www\.|m\.)?soundcloud\.com\/[^/]+\/[^/?#]+/i.test(t) ? t : ''; };
// Someone's SoundCloud page. Profile and track links shown to everyone are
// SoundCloud's only: any https link let a post send readers to a look-alike site.
const scProfile = (v, n) => { const t = url(v, n || 300); return /^https:\/\/(www\.|m\.)?soundcloud\.com\/[^/?#]+/i.test(t) ? t : ''; };
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

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ---- Jam --------------------------------------------------------------------
// A shared listening session, like Spotify's Jam. One person hosts: their app
// plays, and everyone who joins follows its track and position. Anyone in the jam
// can add songs to a shared queue, which the host's app plays in order as songs
// end. Joined with a 6-character code, or from the friends list (a host's
// presence carries it). Starting or joining hands out a key that every later
// call needs, so an id seen in the friends list can't act for that person.
const jams = new Map();                          // code -> jam
const MAX_JAMS = 300, MAX_MEMBERS = 50, MAX_QUEUE = 100, MAX_WAITERS = 120;
const JAM_HOST_IDLE = 10 * 60 * 1000;            // ends 10 min after the host's app was last heard
const JAM_GUEST_IDLE = 90 * 1000;                // a guest drops out 90 s after their app last checked in
const JAM_WAIT = 20 * 1000;                      // a state request waits this long for a change
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O or 1/I to misread
const jamCode = (v) => { const c = s(v, 12).trim().toUpperCase(); return /^[A-HJ-NP-Z2-9]{6}$/.test(c) ? c : ''; };
const allowJamStart = limiter(6, 10 * 60 * 1000);
const allowJamJoin = limiter(20, 60 * 1000);     // also what makes guessing codes hopeless
const allowJamWrite = limiter(120, 60 * 1000);

function newJamCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 6; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!jams.has(c)) return c;
  }
}
const newKey = () => crypto.randomBytes(18).toString('base64url');
function jamTrack(t) {
  if (!t || typeof t !== 'object') return null;
  const u = scUrl(t.url), title = s(t.title, 200).trim();
  return u && title ? { url: u, title, artist: s(t.artist, 120), cover: url(t.cover, 400), dur: num(t.dur, 0, 86400, 0) } : null;
}
// Something everyone should see changed: wake every waiting state request.
function jamTouch(j) {
  j.v++;
  for (const wake of [...j.waiters]) wake();
}
function jamView(j) {
  const now = Date.now();
  const host = j.members.get(j.host);
  return {
    code: j.code, v: j.v, host: j.host, hostAge: host ? now - host.ts : 0,
    members: [...j.members].map(([id, m]) => ({ id, name: m.name, sc: m.sc, host: id === j.host })),
    queue: j.queue.map((q) => ({ qid: q.qid, url: q.url, title: q.title, artist: q.artist, cover: q.cover, dur: q.dur, by: q.by, byId: q.byId })),
    // age: how long ago the host's app sampled pos, so a guest adds that on
    now: j.now ? Object.assign({}, j.now.t, { pos: j.now.pos, paused: j.now.paused, rate: j.now.rate, age: now - j.now.at }) : null,
  };
}
function jamEnd(code) {
  const j = jams.get(code);
  if (!j) return;
  jams.delete(code);
  j.ended = true;
  for (const wake of [...j.waiters]) wake();
}
function sweepJams() {
  const now = Date.now();
  for (const [code, j] of jams) {
    const host = j.members.get(j.host);
    if (!host || now - host.ts > JAM_HOST_IDLE) { jamEnd(code); continue; }
    let gone = false;
    for (const [id, m] of j.members) if (id !== j.host && now - m.ts > JAM_GUEST_IDLE) { j.members.delete(id); gone = true; }
    if (gone) jamTouch(j);
  }
}
setInterval(sweepJams, 30 * 1000).unref();

// The caller is in this jam ({ j, m, id }), or the error has been sent (null).
function jamMember(res, d) {
  const j = jams.get(jamCode(d.code));
  if (!j) { send(res, 404, { error: 'no jam', ended: true }); return null; }
  const id = s(d.id, 64), m = j.members.get(id);
  if (!m || typeof d.key !== 'string' || d.key !== m.key) { send(res, 403, { error: 'not in this jam' }); return null; }
  m.ts = Date.now();
  return { j, m, id };
}

function jamRoute(req, res, ip) {
  let u;
  try { u = new URL(req.url, 'http://jam'); } catch (e) { return send(res, 400, { error: 'bad url' }); }
  // GET /jam/state?code&id&key&v: answers at once if the jam moved past v,
  // otherwise holds the request until it does (or 20 s pass).
  if (req.method === 'GET' && u.pathname === '/jam/state') {
    const q = Object.fromEntries(u.searchParams);
    const c = jamMember(res, q);
    if (!c) return;
    const reply = () => {
      if (res.writableEnded) return;
      c.m.ts = Date.now();
      if (c.j.ended) send(res, 404, { error: 'ended', ended: true }); else send(res, 200, jamView(c.j));
    };
    if (String(c.j.v) !== q.v || c.j.waiters.size >= MAX_WAITERS) return reply();
    const done = () => { clearTimeout(timer); c.j.waiters.delete(done); reply(); };
    const timer = setTimeout(done, JAM_WAIT);
    c.j.waiters.add(done);
    res.on('close', () => { clearTimeout(timer); c.j.waiters.delete(done); });
    return;
  }
  if (req.method !== 'POST') { res.writeHead(404); return res.end(); }
  const op = u.pathname.slice('/jam/'.length);
  if (op === 'start' && !allowJamStart(ip)) return send(res, 429, { error: 'slow down' });
  if (op === 'join' && !allowJamJoin(ip)) return send(res, 429, { error: 'slow down' });
  if (!allowJamWrite(ip)) return send(res, 429, { error: 'slow down' });
  readBody(req, 6000, (body) => {
    let d;
    try { d = JSON.parse(body); } catch (e) { return send(res, 400, { error: 'bad json' }); }
    if (!d || typeof d !== 'object') return send(res, 400, { error: 'bad json' });
    const id = s(d.id, 64), name = s(d.name, 60).trim() || 'Someone', sc = scProfile(d.sc, 200);

    if (op === 'start') {
      if (!id) return send(res, 400, { error: 'no id' });
      for (const [code, j] of jams) if (j.host === id) jamEnd(code);   // one jam per host
      if (jams.size >= MAX_JAMS) sweepJams();
      if (jams.size >= MAX_JAMS) return send(res, 503, { error: 'full' });
      const code = newJamCode(), key = newKey();
      const j = { code, host: id, v: 1, qn: 0, queue: [], now: null, waiters: new Set(),
        members: new Map([[id, { name, sc, key, ts: Date.now() }]]) };
      jams.set(code, j);
      return send(res, 200, { code, key, state: jamView(j) });
    }

    if (op === 'join') {
      const j = jams.get(jamCode(d.code));
      if (!j || !id) return send(res, 404, { error: 'no jam' });
      if (!j.members.has(id) && j.members.size >= MAX_MEMBERS) return send(res, 409, { error: 'full' });
      const key = newKey();
      j.members.set(id, { name, sc, key, ts: Date.now() });
      jamTouch(j);
      return send(res, 200, { code: j.code, key, state: jamView(j) });
    }

    const c = jamMember(res, d);
    if (!c) return;
    const { j, m } = c, isHost = c.id === j.host;

    if (op === 'add') {
      const t = jamTrack(d.track);
      if (!t) return send(res, 400, { error: 'not a track' });
      if (j.queue.length >= MAX_QUEUE) return send(res, 409, { error: 'queue full' });
      j.queue.push(Object.assign(t, { qid: ++j.qn, by: m.name, byId: c.id }));
      jamTouch(j);
      return send(res, 200, jamView(j));
    }
    if (op === 'remove') {
      const i = j.queue.findIndex((q) => q.qid === +d.qid);
      if (i >= 0) {
        if (!isHost && j.queue[i].byId !== c.id) return send(res, 403, { error: 'not yours' });
        j.queue.splice(i, 1);
        jamTouch(j);
      }
      return send(res, 200, jamView(j));
    }
    if (op === 'now') {
      // The host's app says what it's playing. Guests are only woken for what they
      // must act on (another song, play/pause, a seek), not every position report.
      if (!isHost) return send(res, 403, { error: 'host only' });
      let moved = false;
      if (d.qid != null) {
        const i = j.queue.findIndex((q) => q.qid === +d.qid);
        if (i >= 0) { j.queue.splice(i, 1); moved = true; }   // the host started this queued song
      }
      const t = jamTrack(d.now), at = Date.now();
      const next = t ? { t, pos: num(d.now.pos, 0, 86400, 0), paused: d.now.paused === true, rate: num(d.now.rate, 0.5, 1.5, 1), at } : null;
      const was = j.now;
      if (!was || !next) moved = moved || was !== next;
      else {
        const expect = was.paused ? was.pos : was.pos + (at - was.at) / 1000 * was.rate;
        if (was.t.url !== next.t.url || was.paused !== next.paused || was.rate !== next.rate || Math.abs(next.pos - expect) > 4) moved = true;
      }
      j.now = next;
      if (moved) jamTouch(j);
      return send(res, 200, { ok: true, v: j.v });
    }
    if (op === 'leave' || op === 'end') {
      if (isHost) { jamEnd(j.code); return send(res, 200, { ok: true, ended: true }); }
      if (op === 'end') return send(res, 403, { error: 'host only' });
      j.members.delete(c.id);
      jamTouch(j);
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'unknown' });
  });
}

const server = http.createServer((req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.url.startsWith('/jam/')) return jamRoute(req, res, clientIp(req));

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
              name: s(d.name, 60), sc: scProfile(d.sc, 200),
              title: s(d.title, 200), artist: s(d.artist, 120),
              cover: url(d.cover, 400), url: scUrl(d.url),
              pos: num(d.pos, 0, 86400, 0), dur: num(d.dur, 0, 86400, 0), paused: d.paused === true, rate: num(d.rate, 0.5, 1.5, 1),
              jam: jamCode(d.jam),   // the jam this person hosts, so friends can join from the list
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
      const jam = p.jam && jams.has(p.jam) && jams.get(p.jam).host === id ? p.jam : '';   // only a live jam they host
      list.push({ id, name: p.name, sc: p.sc, title: p.title, artist: p.artist, cover: p.cover,
        url: p.url, pos: p.pos, dur: p.dur, paused: p.paused, rate: p.rate, jam, age: now - p.ts });
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
      const track = t && t.title ? { title: s(t.title, 200), artist: s(t.artist, 120), cover: url(t.cover, 400), url: scUrl(t.url) } : null;
      if (!d || !d.id || (!text && !track)) { res.writeHead(400); return res.end('empty'); }
      if (!allowPost(ip)) { res.writeHead(429); return res.end('slow down'); }
      feed.unshift({
        id: s(d.id, 64), name: s(d.name, 60) || 'Someone', avatar: url(d.avatar, 400),
        url: scProfile(d.url), text, track, ts: Date.now(),
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
