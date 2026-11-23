// ==UserScript==
// @name         holdonquietly for SoundCloud
// @namespace    https://github.com/dwindles/holdonquietly-soundcloud
// @version      2026.11.23
// @description  The holdonquietly theme for SoundCloud, on mobile.
// @author       dwindles
// @match        https://soundcloud.com/*
// @match        https://*.soundcloud.com/*
// @downloadURL  https://raw.githubusercontent.com/dwindles/holdonquietly-soundcloud/master/dist/holdonquietly.user.js
// @updateURL    https://raw.githubusercontent.com/dwindles/holdonquietly-soundcloud/master/dist/holdonquietly.user.js
// @run-at       document-start
// @inject-into  auto
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      discord.com
// @connect      discordapp.com
// @connect      155.138.222.253
// @connect      sndcdn.com
// ==/UserScript==

(function () {
  'use strict';

  const BACKEND = 'http://155.138.222.253:8790';
  const KEY = 'hoqWebhook';

  const store = {
    get: (k, d) => {
      try { return GM_getValue(k, d); }
      catch (e) { try { return localStorage.getItem(k) || d; } catch (e2) { return d; } }
    },
    set: (k, v) => {
      try { GM_setValue(k, v); }
      catch (e) { try { localStorage.setItem(k, v); } catch (e2) {} }
    },
  };

  const reply = (kind, extra) => {
    try {
      window.postMessage(Object.assign({ __hoqReply: 1, kind: kind }, extra), location.origin);
    } catch (e) {}
  };

  // Managers disagree on this one. Tampermonkey (Android) has the classic
  // sync GM_xmlhttpRequest; the iOS Userscripts app implements the newer
  // promise-style GM.xmlHttpRequest instead. Resolve whichever exists, and
  // fall back to plain fetch — SoundCloud ships no script-src/connect-src CSP,
  // so fetch reaches the webhook fine. It cannot read the artwork CDN (that is
  // a CORS wall, which is the whole reason GM is preferred).
  function req(opts) {
    try {
      if (typeof GM_xmlhttpRequest === 'function') return GM_xmlhttpRequest(opts);
    } catch (e) {}
    try {
      if (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') {
        return GM.xmlHttpRequest(opts);
      }
    } catch (e) {}
    try {
      fetch(opts.url, {
        method: opts.method || 'GET',
        headers: opts.headers || undefined,
        body: opts.data || undefined,
      })
        .then((r) => (
          opts.responseType === 'blob'
            ? r.blob().then((b) => ({ status: r.status, response: b, responseText: '' }))
            : r.text().then((t) => ({ status: r.status, responseText: t }))
        ))
        .then((res) => { if (opts.onload) opts.onload(res); })
        .catch((err) => {
          if (opts.onerror) opts.onerror(err);
          reply('toast', { text: 'request failed: ' + err.message });
        });
    } catch (e) { reply('toast', { text: 'no transport available: ' + e.message }); }
  }

  // Byte-for-byte the embed the C# host builds, so the Quiet bot sees an
  // identical message (it keys off embed.url and the "hoq-play" footer).
  function sendEmbed(json, play) {
    let wh = store.get(KEY, '');
    if (!wh) {
      wh = prompt('Paste your Discord webhook URL (kept on this device only):') || '';
      if (!/^https?:/.test(wh)) {
        reply('toast', { text: 'no webhook configured' });
        return;
      }
      store.set(KEY, wh.trim());
    }
    let r;
    try { r = JSON.parse(json); } catch (e) { return; }
    if (!r.title) { reply('toast', { text: 'payload had no title' }); return; }

    const author = {
      name: r.name ? (r.name + (play ? ' wants to play this' : ' shared a track'))
                   : (play ? 'Play request' : 'Now playing'),
    };
    if (r.avatar) author.icon_url = r.avatar;

    const embed = {
      author: author,
      title: r.title,
      color: typeof r.color === 'number' ? r.color : 0xff5500,
      timestamp: new Date().toISOString(),
      footer: { text: play ? 'hoq-play' : 'via holdonquietly' },
    };
    if (r.url) embed.url = r.url;
    if (r.artist) embed.description = 'by **' + r.artist + '**';
    if (r.cover) embed.thumbnail = { url: r.cover };

    const fields = [];
    if (r.length) fields.push({ name: 'Length', value: r.length, inline: true });
    if (r.url) fields.push({ name: 'Listen', value: '[Open in SoundCloud](' + r.url + ')', inline: true });
    if (fields.length) embed.fields = fields;

    const body = { username: r.name || 'holdonquietly', embeds: [embed] };
    if (r.avatar) body.avatar_url = r.avatar;

    req({
      method: 'POST',
      url: store.get(KEY, ''),
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(body),
      onload: (res) => reply('toast', { text: (play ? 'playreq' : 'share') + ' <- HTTP ' + res.status }),
      onerror: () => reply('toast', { text: (play ? 'playreq' : 'share') + ' failed' }),
    });
  }

  // SoundCloud's CDN taints the canvas, which is why the desktop build samples
  // artwork in C#. GM_xmlhttpRequest is not bound by that, so re-serve the
  // bytes as a data: URL and let preload's own extractor do the work.
  function cover(url) {
    req({
      method: 'GET', url: url, responseType: 'blob',
      onload: (res) => {
        try {
          const fr = new FileReader();
          fr.onload = () => reply('cover', { dataUrl: fr.result });
          fr.readAsDataURL(res.response);
        } catch (e) {}
      },
    });
  }

  function friends() {
    req({
      method: 'GET', url: BACKEND + '/friends',
      onload: (res) => { try { reply('friends', { list: JSON.parse(res.responseText) }); } catch (e) {} },
    });
  }

  // The desktop host polls this on its own loop (FriendsLoop) — nothing in the
  // page ever asks for it — so the sandbox has to drive it here too. The first
  // call is delayed so the page-side listener exists to receive the reply.
  setTimeout(friends, 3000);
  setInterval(friends, 60000);

  function dcWidget() {
    req({
      method: 'GET',
      url: 'https://discord.com/api/guilds/795316631655546900/widget.json',
      onload: (res) => {
        let j = null;
        try { j = JSON.parse(res.responseText); } catch (e) {}
        reply('dcwidget', { data: j });
      },
      onerror: () => reply('dcwidget', { data: null }),
    });
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__hoq !== 1) return;
    const cmd = String(d.cmd || '');
    if (cmd.indexOf('webhook:') === 0) sendEmbed(cmd.slice(8), false);
    else if (cmd.indexOf('playreq:') === 0) sendEmbed(cmd.slice(8), true);
    else if (cmd.indexOf('cover:') === 0) cover(cmd.slice(6));
    else if (cmd === 'dcwidget') dcWidget();
    else if (cmd.indexOf('open:') === 0) { if (/^https?:\/\//i.test(cmd.slice(5))) try { window.open(cmd.slice(5), '_blank', 'noopener'); } catch (er) {} }   // web links only, as on the desktop
    // Everything else (win:*, rpc:, acct:*, lastfm:*, update:apply, DBG…) has
    // no mobile equivalent and is intentionally dropped.
  });

  // Inject the payload into the PAGE world. Function.toString() carries the
  // source verbatim, so none of preload.js needs escaping.
  function __hoqPayload() {
// Preload runs in the SoundCloud page context. It:
//  - injects a slim custom titlebar (SoundCloud wordmark + palette + window btns)
//  - injects a color / gradient picker that recolors SoundCloud's orange accent
//  - hides clutter (GO MOBILE, footer legal links, upsell / cookie popups)
//  - styles the scrollbar
// Window controls talk to the main process over IPC (exposed via contextBridge).

// WebView2 injects this whole file before page scripts (CSP-exempt), so code
// here runs directly in the page's main world. Window controls + drag talk to
// the C# host via window.chrome.webview.postMessage.
function scPost(cmd) {
  // No C# host on mobile. Window/native commands are dropped by the sandbox;
  // the rest are relayed to it, since it owns the GM_* APIs. The community feed
  // goes from the page itself (the shim's __hoqFeedNet).
  try {
    cmd = String(cmd);
    if (cmd === 'feed:get' && window.__hoqFeedNet) { window.__hoqFeedNet.get(); return; }
    if (cmd.indexOf('feed:post:') === 0 && window.__hoqFeedNet) { window.__hoqFeedNet.post(cmd.slice(10)); return; }
    window.postMessage({ __hoq: 1, cmd: cmd }, location.origin);
  } catch (e) {}
}

// "Log in on your phone" — redeem side. The desktop app's QR opens the proxy with
// SoundCloud's two login cookies in the URL fragment (never sent to any server).
// Set them on this domain, scrub them from the address bar, and reload signed in.
// Only ever on the proxy, never on soundcloud.com itself.
(() => {
  try {
    const h = location.hash || '';
    if (h.indexOf('#hoq-login=') !== 0) return;
    if (!/(^|\.)holdonquietly\.com$/i.test(location.hostname)) return;
    // Scrub first, whatever happens next, so the login never sits in the
    // address bar or the history entry.
    history.replaceState(null, '', location.pathname + location.search);
    let b = h.slice(11).replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    const d = JSON.parse(atob(b));
    // Cookie-safe characters only: a ';' in a value would smuggle in attributes.
    // RFC 6265 cookie-octet: printable ASCII minus space, " , ; and \ (sc_session
    // is URL-encoded JSON, so it carries { } % : — a narrower set refused it).
    const ok = (v) => typeof v === 'string' && /^[!#-+\--:<-\[\]-~]{8,1024}$/.test(v);
    if (!ok(d.o)) return;
    const tail = '; path=/; max-age=31536000; secure; samesite=lax';
    const dom = '; domain=.' + location.hostname;
    // Drop any half-session first so there's no duplicate cookie to trip on.
    ['oauth_token', 'sc_session'].forEach((n) => {
      document.cookie = n + '=; path=/; max-age=0';
      document.cookie = n + '=; path=/; max-age=0' + dom;
    });
    // The proxy's pair service sets the login (proxy/pair-server.js): Safari caps
    // a cookie set from script at 7 days, Home Screen web apps included, which
    // signed phones out every week. Set from here only if that fails.
    const here = () => {
      document.cookie = 'oauth_token=' + d.o + tail;            // host-only, as SoundCloud sets it
      if (ok(d.s)) document.cookie = 'sc_session=' + d.s + tail + dom;
      document.cookie = 'soundcloud_session_hint=1' + tail + dom;
    };
    fetch('/__hoq/pair/login', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ o: d.o, s: ok(d.s) ? d.s : '', h: location.hostname }),
    }).then((r) => { if (!r.ok) here(); }, here).then(() => location.reload(), () => location.reload());
  } catch (e) {}
})();

// <hoq-webi-bridge>
// --- New track pages through the proxy ("webi" bridge) -----------------------
// Signed in, SoundCloud shows track pages with its new app inside an iframe and
// the two talk by postMessage — pinned to https://soundcloud.com both ways: the
// frame posts to the parent with that target origin (the browser drops it when
// the parent is our proxy), and it ignores any message whose origin isn't on
// its TRUSTED_V2_ORIGINS list. Both ends live on the proxy (hoq-rewrites.conf
// points webi_host here): re-address what the frame posts to the parent, and
// inside the frame present the parent's messages as SoundCloud's. Proxy only.
//
// Each piece is guarded on its own: Safari refused the first version's trick of
// redefining the parent's postMessage from inside the frame, the one try/catch
// swallowed everything after it, and song pages sat loading forever on iPhone.
(() => {
  const SC = 'https://soundcloud.com';
  const isSC = (t) => t === SC || t === SC + '/';
  if (!/(^|\.)holdonquietly\.com$/i.test(location.hostname)) return;

  if (window === window.top) {
    // The app owns its postMessage. A call addressed to SoundCloud comes from
    // the frame: hand it to the frame's courier (below), because a message's
    // .source is the realm of the script that called postMessage last, and the
    // app only accepts "ready" from the frame itself.
    try {
      const native = window.postMessage;
      window.__hoqNativePostMessage = native;
      window.postMessage = function (msg, target) {
        const a = Array.prototype.slice.call(arguments);
        if (isSC(target)) {
          a[1] = location.origin;
          if (typeof window.__hoqFrameCourier === 'function') return window.__hoqFrameCourier(a);
        }
        return native.apply(window, a);
      };
    } catch (e) {}
    return;
  }
  if (!/^\/n\//.test(location.pathname)) return;

  // Frame: the courier is frame-realm code, so what it sends is the frame's.
  // Only a plain property on the parent — nothing of the parent is redefined.
  try {
    const par = window.parent;
    const native = par.__hoqNativePostMessage;
    if (native) par.__hoqFrameCourier = function (a) { return native.apply(par, a); };
  } catch (e) {}

  try {
    const d = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'origin');
    Object.defineProperty(MessageEvent.prototype, 'origin', {
      configurable: true, enumerable: d.enumerable,
      get() {
        const o = d.get.call(this);
        return o === location.origin && this.source === window.parent ? SC : o;
      },
    });
  } catch (e) {}

  try {
      // The new app's code loads straight from SoundCloud's asset CDN, not
      // through us, so nginx never rewrites its API hosts — and those refuse our
      // origin (/me, likes, reposts, comments all "Failed to fetch"). Send the
      // calls through the proxy's subdomains, and hand back the answers with
      // nginx's host rewrites undone: the new app only accepts artwork from
      // SoundCloud's own hosts and crashed ("Something went wrong") on ours.
      const H = location.hostname.replace(/\./g, '\\.');
      const API = /^https:\/\/(api-v2|api-auth|api|graph)\.soundcloud\.com(?=[/?]|$)/;
      const BACK = [
        ['hls', 'cf-hls-media.sndcdn.com'], ['hls2', 'hls-media.sndcdn.com'], ['secure-cdn', 'secure.sndcdn.com'],
        ['a-v2', 'a-v2.sndcdn.com'], ['style', 'style.sndcdn.com'], ['va', 'va.sndcdn.com'], ['wis', 'wis.sndcdn.com'],
        ['wave', 'wave.sndcdn.com'], ['i1', 'i1.sndcdn.com'], ['i2', 'i2.sndcdn.com'], ['i3', 'i3.sndcdn.com'], ['i4', 'i4.sndcdn.com'],
        ['api-v2', 'api-v2.soundcloud.com'], ['api-auth', 'api-auth.soundcloud.com'], ['api', 'api.soundcloud.com'],
        ['graph', 'graph.soundcloud.com'], ['secure', 'secure.soundcloud.com'], ['pushers', 'pushers.soundcloud.com'], ['dwt', 'dwt.soundcloud.com'],
      ].map(([sub, real]) => [new RegExp('\\b' + sub.replace(/-/g, '\\-') + '\\.' + H + '\\b', 'g'), real]);
      const unRewrite = (t) => BACK.reduce((s, [re, real]) => s.replace(re, real), t);
      const fix = (u) => (typeof u === 'string' && API.test(u) ? u.replace(API, (m, h) => 'https://' + h + '.' + location.hostname) : u);
      const fetch0 = window.fetch;
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input && typeof input.url === 'string' ? input.url : '';
        if (!API.test(url)) return fetch0.apply(this, arguments);
        const req = typeof input === 'string' || input instanceof URL ? fix(url) : new Request(fix(url), input);
        return fetch0.call(this, req, init).then((r) => {
          // JSON only: buffering a stream (text/event-stream) would never finish.
          if (!/application\/json/.test(r.headers.get('content-type') || '')) return r;
          return r.text().then((t) => new Response(unRewrite(t), { status: r.status, statusText: r.statusText, headers: r.headers }));
        });
      };
  } catch (e) {}
})();
// --- Phone site: no Google display ads -----------------------------------------
// The desktop app's blocker extension stops these; a website can't load one.
// SoundCloud's own code sets up a full-screen "webi_interstitial" slot
// (#div-gpt-ad-interstitial) and adds Google's gpt.js to <head> with appendChild
// once cookie consent allows it. On the proxy, scripts from Google's ad hosts are
// never added (top page and the new app's frames alike), so the slot never fills.
(() => {
  try {
    if (!/(^|\.)holdonquietly\.com$/i.test(location.hostname)) return;
    const AD = /^https?:\/\/([a-z0-9-]+\.)*(doubleclick\.net|googlesyndication\.com|googletagservices\.com|adservice\.google\.com|amazon-adsystem\.com)\//i;
    const isAd = (n) => !!n && n.nodeName === 'SCRIPT' && AD.test(n.src || '');
    const N = Node.prototype, app0 = N.appendChild, ins0 = N.insertBefore;
    N.appendChild = function (n) { return isAd(n) ? n : app0.call(this, n); };
    N.insertBefore = function (n, ref) { return isAd(n) ? n : ins0.call(this, n, ref); };
    const st = document.createElement('style');
    st.textContent = '#div-gpt-ad-interstitial, [id^="div-gpt-ad"], [id^="google_ads_iframe"], ins.adsbygoogle, #google_vignette { display: none !important; }';
    (document.head || document.documentElement).appendChild(st);
  } catch (e) {}
})();
// </hoq-webi-bridge>

// --- iPhone (phone site): which <audio> is playing -----------------------------
// There the phone site plays through Safari's own HLS on a plain <audio>, with no
// Web Audio in the path (window.__hoqNativeHls, set by the proxy build), so
// createMediaElementSource below never runs and __hoqMediaEl was never set: the
// lock screen's position, the gap keep-alive and the players had no element.
// Taken from play() instead.
(() => {
  try {
    if (!window.__hoqNativeHls) return;
    const P = HTMLMediaElement.prototype, play0 = P.play;
    P.play = function () {
      if (this instanceof HTMLAudioElement) window.__hoqMediaEl = this;
      return play0.apply(this, arguments);
    };
  } catch (e) {}
})();

// --- iPhone, locked: keep the page awake between songs -------------------------
// iOS freezes a locked page's scripts once it stops playing audio, and between
// songs nothing plays: SoundCloud's own code never got to start the next one
// until the phone was unlocked. For those few seconds (from just before a song
// ends until the next one plays, at most 25 s) a Web Audio source plays a
// constant 0.0001: inaudible, but not silence, so the page counts as playing.
// Its context is unlocked by your first tap and kept suspended otherwise.
// localStorage hoqKeepAlive = "0" turns it off.
(() => {
  try {
    if (!window.__hoqNativeHls) return;
    let off = false;
    try { off = localStorage.getItem('hoqKeepAlive') === '0'; } catch (e) {}
    const AC = window.AudioContext || window.webkitAudioContext;
    if (off || !AC) return;
    let ac = null, src = null, stopT = 0;
    const unlock = () => {
      if (ac) return;
      try { ac = new AC(); } catch (e) { ac = null; return; }
      ac.resume().then(() => { if (!src) ac.suspend().catch(() => {}); }, () => {});
    };
    ['touchend', 'click'].forEach((ev) => document.addEventListener(ev, unlock, { capture: true, passive: true }));
    const stop = () => {
      clearTimeout(stopT);
      if (src) { try { src.stop(); src.disconnect(); } catch (e) {} src = null; }
      if (ac && ac.state === 'running') ac.suspend().catch(() => {});
    };
    const start = () => {
      if (src || !ac) return;
      try {
        src = ac.createConstantSource();
        src.offset.value = 0.0001;
        src.connect(ac.destination);
        src.start();
      } catch (e) { src = null; return; }
      ac.resume().catch(() => {});
      clearTimeout(stopT);
      stopT = setTimeout(stop, 25000);
    };
    let bound = null;
    setInterval(() => {
      const el = window.__hoqMediaEl;
      if (!el || el === bound) return;
      bound = el;
      el.addEventListener('timeupdate', () => {
        const left = (el.duration - el.currentTime) / (el.playbackRate || 1);
        if (document.hidden && isFinite(left) && left > 0 && left < 3) start();
      });
      el.addEventListener('ended', () => { if (document.hidden) start(); });
      el.addEventListener('playing', () => { if (src) setTimeout(stop, 1500); });
    }, 1000);
  } catch (e) {}
})();

// --- Lock screen / Now Playing controls ---------------------------------------
// SoundCloud's player registers seekforward/seekbackward for every track, and
// iOS shows that pair as ±10 buttons IN PLACE OF previous/next whenever both
// exist. Refusing the pair gives the lock screen track skip, like SoundCloud's
// own app; seekto makes its scrubber draggable. (The app's ★ is a native-only
// control — the Media Session API has no like action, so no site can show it.)
// Kept in place, not set once: iOS greyed out next and the scrubber on the
// phone. Previous/next and seekto are put back whenever anything clears them,
// re-applied as tracks change, and the position is reported (SoundCloud never
// calls setPositionState, and iOS wants it for a draggable scrubber).
(() => {
  try {
    const MS = window.MediaSession;
    if (!MS || !navigator.mediaSession || MS.prototype.__hoqLock) return;
    MS.prototype.__hoqLock = true;
    const orig = MS.prototype.setActionHandler;
    const click = (sel) => { const b = document.querySelector(sel); if (b) b.click(); };
    const seekTo = (sec) => {
      const wrap = document.querySelector('.playbackTimeline__progressWrapper');
      const dur = typeof playerProgress === 'function' ? playerProgress().dur : 0;
      if (!wrap || !(dur > 0)) return;
      const r = wrap.getBoundingClientRect();
      const x = r.left + Math.max(0, Math.min(1, sec / dur)) * r.width, y = r.top + r.height / 2;
      wrap.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
      wrap.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y }));
    };
    // Ours, for when SoundCloud has none (it sets previous/next once; its own
    // play-next goes through its queue, so it's kept when it's there).
    const mine = {
      nexttrack: () => click('.skipControl__next'),
      previoustrack: () => click('.skipControl__previous'),
      seekto: (d) => { if (d && isFinite(d.seekTime)) seekTo(d.seekTime); },
    };
    const sc = {};
    const pick = (action, handler) => {
      if (action === 'seekforward' || action === 'seekbackward') return null;
      if (action === 'seekto') return mine.seekto;
      return handler || mine[action] || null;
    };
    MS.prototype.setActionHandler = function (action, handler) {
      if (action in mine) sc[action] = handler || null;
      return orig.call(this, action, pick(action, handler));
    };
    const ms = navigator.mediaSession;
    const install = () => {
      ['nexttrack', 'previoustrack', 'seekto'].forEach((a) => {
        try { orig.call(ms, a, pick(a, sc[a])); } catch (e) {}
      });
      ['seekforward', 'seekbackward'].forEach((a) => { try { orig.call(ms, a, null); } catch (e) {} });
    };
    let lastKey = '', boundEl = null;
    const tick = () => {
      const el = window.__hoqMediaEl;
      if (el && el !== boundEl) {
        boundEl = el;   // its own events: SoundCloud's <audio> isn't in the page, so they never reach document
        ['play', 'pause', 'seeked', 'loadedmetadata', 'ratechange'].forEach((ev) => el.addEventListener(ev, () => setTimeout(tick, 0)));
      }
      const key = (el && (el.currentSrc || el.src)) || '';
      if (key !== lastKey) { lastKey = key; install(); }   // a new track: put ours back
      if (el && ms.setPositionState) {
        const dur = el.duration;
        if (isFinite(dur) && dur > 0) {
          try { ms.setPositionState({ duration: dur, position: Math.max(0, Math.min(el.currentTime || 0, dur)), playbackRate: el.playbackRate || 1 }); } catch (e) {}
        }
      }
    };
    setTimeout(install, 4000);
    setInterval(tick, 2000);
    // a seek, a pause or a new song: tell iOS right away rather than at the next tick
    ['play', 'pause', 'seeked', 'loadedmetadata', 'ratechange'].forEach((ev) =>
      document.addEventListener(ev, () => setTimeout(tick, 0), true));
  } catch (e) {}
})();

// --- Audio tap for the visualizer / ambient nebula ---------------------------
// SoundCloud plays through Web Audio and makes exactly ONE MediaElementSource on
// its audio element (a same-origin blob: with crossOrigin=anonymous, so it is
// NOT CORS-tainted). We can't create a second source on that element, but this
// runs before SoundCloud's code, so we patch createMediaElementSource to hang an
// AnalyserNode off their source the moment they make it — giving us real
// frequency data. Purely a tap: the analyser is never connected to a destination.
(() => {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || AC.prototype.__hoqTapped) return;
    AC.prototype.__hoqTapped = true;
    const orig = AC.prototype.createMediaElementSource;
    AC.prototype.createMediaElementSource = function (el) {
      const node = orig.call(this, el);
      try {
        const an = this.createAnalyser();
        an.fftSize = 512; an.smoothingTimeConstant = 0.82;
        node.connect(an);
        window.__hoqAudioAnalyser = an;
      } catch (e) {}
      try {
        // THIS context is the one SoundCloud actually plays through, so it is the
        // one whose output device we can steer with setSinkId (the "play out of…"
        // picker). Element-level el.setSinkId() aborts in WebView2; context-level
        // works. Capturing it here — the moment SC wires up its source — is why
        // this patch has to run before SC's code (it does; injected at doc-start).
        window.__hoqSCAC = this;
        window.__hoqMediaEl = el;   // the <audio> element — used for seek/volume/time in the mini player
        if (typeof window.__hoqApplySink === 'function') window.__hoqApplySink();
      } catch (e) {}
      return node;
    };
  } catch (e) {}
})();

// --- Audio output routing (the header "play out of <device>" picker) ----------
// SoundCloud's own AudioContext (captured above) drives playback; setSinkId on it
// moves ALL SoundCloud audio to a chosen device — e.g. your headphones — without
// touching the Windows default. Storing the choice here (not just in the picker)
// so it re-applies automatically the instant SC builds its context on first play.
(() => {
  try {
    window.__hoqSinkId = (() => { try { return localStorage.getItem('hoqSinkId') || ''; } catch (e) { return ''; } })();
    // Returns a promise<bool>. Never rejects, and crucially can only move the
    // audio or no-op — it never silences it (no graph surgery, just a sink swap).
    window.__hoqApplySink = function () {
      const ac = window.__hoqSCAC;
      const id = window.__hoqSinkId || '';
      if (!ac || typeof ac.setSinkId !== 'function') return Promise.resolve(false);
      try {
        return Promise.resolve(ac.setSinkId(id)).then(() => true).catch(() => false);
      } catch (e) { return Promise.resolve(false); }
    };
  } catch (e) {}
})();

// --- Output-device watchdog -------------------------------------------------------
// A chosen output that stops taking audio (monitor/HDMI asleep or switched input,
// headset unplugged, device grabbed exclusively) freezes the AudioContext clock.
// SoundCloud then waits forever and EVERY song shows as buffering. If the clock
// stalls while a song should be playing, fall back to the system default for this
// session (the saved choice is kept) and say so. When Windows reports a device
// change, the saved device is tried again.
(() => {
  try {
    let lastAc = -1, lastWall = 0, stalls = 0, fellBackFrom = '';
    const playingNow = () => { const b = document.querySelector('.playControls__play'); return !!b && /^pause/i.test(b.getAttribute('aria-label') || ''); };
    const fallBack = (why) => {
      const id = window.__hoqSinkId || '';
      if (!id) return false;
      fellBackFrom = id; window.__hoqSinkId = '';          // session only: localStorage keeps the choice
      try { window.__hoqApplySink(); } catch (e) {}
      try { window.__hoqUpdate && window.__hoqUpdate('notice', 'Switched to your default speakers', 'Your chosen output stopped responding' + (why ? ' (' + why + ')' : '') + '. It will be tried again when it reconnects.'); } catch (e) {}
      return true;
    };
    window.__hoqSinkWatch = { get fellBackFrom() { return fellBackFrom; } };
    setInterval(() => {
      const ac = window.__hoqSCAC; if (!ac) return;
      if (!ac.__hoqErrHooked) { ac.__hoqErrHooked = true; try { ac.addEventListener('error', () => fallBack('device error')); } catch (e) {} }
      const now = performance.now() / 1000;
      if (playingNow() && ac.state === 'suspended') { try { ac.resume(); } catch (e) {} }
      if (playingNow() && ac.state === 'running' && lastAc >= 0 && now - lastWall > 0.5) {
        const rate = (ac.currentTime - lastAc) / (now - lastWall);
        stalls = rate < 0.5 ? stalls + 1 : 0;
        if (stalls >= 3) { stalls = 0; fallBack(''); }
      } else stalls = 0;
      lastAc = ac.currentTime; lastWall = now;
    }, 1500);
    navigator.mediaDevices && navigator.mediaDevices.addEventListener && navigator.mediaDevices.addEventListener('devicechange', () => {
      if (!fellBackFrom) return;
      navigator.mediaDevices.enumerateDevices().then((ds) => {
        if (!ds.some((d) => d.kind === 'audiooutput' && d.deviceId === fellBackFrom)) return;
        let saved = ''; try { saved = localStorage.getItem('hoqSinkId') || ''; } catch (e) {}
        if (saved !== fellBackFrom) { fellBackFrom = ''; return; }   // they picked something else meanwhile
        window.__hoqSinkId = fellBackFrom; fellBackFrom = '';
        try { window.__hoqApplySink(); } catch (e) {}
      }).catch(() => {});
    });
  } catch (e) {}
})();

// --- Equalizer -----------------------------------------------------------------
// A 6-band graphic EQ spliced into SoundCloud's own audio graph at the very last
// stage. Rather than reroute SC's source (which risks breaking its volume), we
// patch AudioNode.connect so that whatever SC connects to the context destination
// is transparently passed through our filter chain first. SC's internal graph is
// left completely untouched. Fail-safe: any error falls back to the real connect,
// so the worst case is "EQ does nothing" and audio always plays.
const HOQ_EQ_FREQS = [70, 180, 450, 1100, 2800, 7000];
function hoqEnsureEqChain(ac) {
  if (ac.__hoqEqIn) return ac.__hoqEqIn;
  const rc = AudioNode.prototype.__hoqRealConnect;   // the un-patched connect
  const bands = HOQ_EQ_FREQS.map((f, i) => {
    const b = ac.createBiquadFilter();
    b.type = i === 0 ? 'lowshelf' : (i === HOQ_EQ_FREQS.length - 1 ? 'highshelf' : 'peaking');
    b.frequency.value = f; b.Q.value = 0.9; b.gain.value = 0;
    return b;
  });
  for (let i = 0; i < bands.length - 1; i++) rc.call(bands[i], bands[i + 1]);
  let tail = ac.destination;
  try { tail = hoqBuildFx(ac, rc); } catch (e) { tail = ac.destination; }
  rc.call(bands[bands.length - 1], tail);   // real connect, or we'd recurse
  ac.__hoqEqBands = bands;
  ac.__hoqEqIn = bands[0];
  (window.__hoqFxCtxs = window.__hoqFxCtxs || []).push(ac);
  try { hoqApplyEqGains(ac); } catch (e) {}
  try { hoqApplyFx(ac); } catch (e) {}
  return ac.__hoqEqIn;
}

// --- Volume boost + leveler + space effects (after the EQ bands) -------------
// bands -> pre -+-> dry ---------------------+
//               +-> convolver (reverb) -> wet +-> sum -> HP -> LP -> pan -> boost -> limiter -> out
//               +-> delay <-> feedback (echo) +
// Reverbs are synthesized impulse responses (no downloaded files). Everything is
// transparent at rest: no reverb buffer, filters wide open, boost 0 dB, limiter
// at ratio 1. The limiter only engages when boosting/levelling so a +12 dB boost
// squashes instead of clipping.
const HOQ_SPACES = {
  bathroom:   { label: 'Bathroom',    tip: 'The song through the door at a party', rt: .8, pre: 2, d0: 6000, d1: 2500, wet: .45, dry: .85, lp: 650, lpQ: .8, er: [[5, .5], [9, .4], [14, .3]] },
  shower:     { label: 'Shower',      tip: 'Bright tiled echo', rt: 1.3, pre: 1, d0: 11000, d1: 6000, wet: .55, dry: .8, er: [[3, .7], [6, .6], [9, .5], [13, .4], [17, .35], [22, .3]] },
  room:       { label: 'Room',        tip: 'A small live room', rt: .55, pre: 4, d0: 8000, d1: 3000, wet: .3, dry: 1 },
  hall:       { label: 'Concert hall', tip: 'Big, smooth hall', rt: 2.4, pre: 22, d0: 7000, d1: 2000, wet: .38, dry: .9 },
  church:     { label: 'Church',      tip: 'Long stone tail', rt: 5, pre: 38, d0: 6000, d1: 1200, wet: .5, dry: .75 },
  stadium:    { label: 'Stadium',     tip: 'Huge, with a bounce back', rt: 3.2, pre: 70, d0: 5000, d1: 1500, wet: .42, dry: .8, hp: 110, echo: .42, fb: .28, echoMix: .3 },
  cave:       { label: 'Cave',        tip: 'Dark and echoey', rt: 3.8, pre: 30, d0: 3500, d1: 700, wet: .5, dry: .75, echo: .29, fb: .38, echoMix: .3 },
  nextdoor:   { label: 'Next room',   tip: 'Through the wall', rt: .6, pre: 6, d0: 3000, d1: 900, wet: .35, dry: .8, lp: 320, lpQ: .7 },
  car:        { label: 'Car outside', tip: 'Someone bumping it in the parking lot', rt: 1.8, pre: 15, d0: 4000, d1: 1200, wet: .3, dry: .9, lp: 420, lpQ: 1.6, echo: .12, fb: .1, echoMix: .18 },
  underwater: { label: 'Underwater',  tip: 'Muffled and floaty', rt: 1.6, pre: 10, d0: 1500, d1: 400, wet: .55, dry: .7, lp: 420, lpQ: 4 },
  radio:      { label: 'Old radio',   tip: 'Thin AM-radio tone', rt: .25, pre: 2, d0: 4000, d1: 2000, wet: .12, dry: 1, hp: 450, lp: 3200, lpQ: 1.2 },
  phone:      { label: 'Phone speaker', tip: 'Played off a phone on the table', rt: .15, pre: 1, d0: 6000, d1: 3000, wet: .08, dry: 1, hp: 750, lp: 7000, lpQ: 1.8 },
  tunnel:     { label: 'Tunnel',      tip: 'Metallic flutter echo', rt: 2.2, pre: 8, d0: 5000, d1: 1800, wet: .35, dry: .85, echo: .055, fb: .5, echoMix: .25 },
  eightd:     { label: '8D',          tip: 'Circles around your head (headphones)', rt: 1.4, pre: 12, d0: 7000, d1: 2500, wet: .28, dry: .95, pan: .9 },
};
function hoqFxState() {
  const g = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } };
  const boost = Math.max(0, Math.min(12, +g('hoqBoost', '0') || 0));
  const space = HOQ_SPACES[g('hoqSpace', '')] ? g('hoqSpace', '') : '';
  let amount = +g('hoqSpaceAmt', '100'); if (!(amount >= 0 && amount <= 100)) amount = 100;
  let speed = +g('hoqSpeed', '1'); if (!(speed >= 0.5 && speed <= 1.5)) speed = 1;
  let xfade = +g('hoqXfade', '0'); if (!(xfade >= 0 && xfade <= 8)) xfade = 0;
  return { boost, level: g('hoqLevel', '0') === '1', space, amount, speed, xfade };
}
function hoqMakeIR(ac, s) {
  const sr = ac.sampleRate, pre = Math.floor(sr * s.pre / 1000);
  const len = pre + Math.floor(sr * s.rt * 1.15) + 1;
  const buf = ac.createBuffer(2, len, sr);
  let seed = 0x2545f491;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) / 4294967296) * 2 - 1; };
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch); let lp = 0, a = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / sr;
      if (((i - pre) & 63) === 0) { const fc = s.d0 * Math.pow(s.d1 / s.d0, Math.min(1, t / s.rt)); a = 1 - Math.exp(-2 * Math.PI * fc / sr); }
      lp += a * (rnd() - lp);
      const fadeIn = Math.min(1, t / 0.004);   // no click at the reverb onset
      d[i] = lp * Math.exp(-6.9 * t / s.rt) * fadeIn;
    }
    (s.er || []).forEach(([ms, gn], k) => {   // discrete early reflections (tiles/walls)
      const idx = Math.floor(sr * (ms + (ch ? 0.7 * (k + 1) : 0)) / 1000);
      if (idx < len) d[idx] += gn * (k % 2 ? -1 : 1) * 0.6;
    });
  }
  // Normalise energy so wet ~ the dry level regardless of length: sum(h^2) = 1.
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch); let e = 0;
    for (let i = 0; i < len; i++) e += d[i] * d[i];
    const k = e > 0 ? 1 / Math.sqrt(e) : 0;
    for (let i = 0; i < len; i++) d[i] *= k;
  }
  return buf;
}
function hoqBuildFx(ac, rc) {
  const n = {};
  n.pre = ac.createGain();
  n.dry = ac.createGain();
  n.conv = ac.createConvolver(); n.conv.normalize = false;
  n.wet = ac.createGain(); n.wet.gain.value = 0;
  n.delay = ac.createDelay(1.5); n.delay.delayTime.value = 0.3;
  n.fb = ac.createGain(); n.fb.gain.value = 0;
  n.echoLp = ac.createBiquadFilter(); n.echoLp.type = 'lowpass'; n.echoLp.frequency.value = 3000;
  n.echoOut = ac.createGain(); n.echoOut.gain.value = 0;
  n.sum = ac.createGain();
  n.hp = ac.createBiquadFilter(); n.hp.type = 'highpass'; n.hp.frequency.value = 10; n.hp.Q.value = 0.7;
  n.lp = ac.createBiquadFilter(); n.lp.type = 'lowpass'; n.lp.frequency.value = Math.min(20000, ac.sampleRate / 2 - 100); n.lp.Q.value = 0.7;
  n.panTrim = ac.createGain();   // panning stereo folds L+R onto one side (+6 dB); trim for 8D
  n.pan = ac.createStereoPanner();
  n.clip = ac.createWaveShaper(); n.clip.oversample = 'none';   // curve only while boosting/effects
  n.osc = ac.createOscillator(); n.osc.frequency.value = 0.11;
  n.oscAmt = ac.createGain(); n.oscAmt.gain.value = 0;
  n.agc = ac.createGain();       // "even out volume": slow auto-gain toward one loudness
  n.xf = ac.createGain();        // crossfade: song fades out into the next (driven by hoqPlaybackTick)
  n.meter = ac.createAnalyser(); n.meter.fftSize = 2048;
  n.boost = ac.createGain();
  n.lim = ac.createDynamicsCompressor();
  n.lim.threshold.value = 0; n.lim.knee.value = 0; n.lim.ratio.value = 1; n.lim.attack.value = 0.003; n.lim.release.value = 0.25;
  rc.call(n.pre, n.dry); rc.call(n.dry, n.sum);
  rc.call(n.pre, n.conv); rc.call(n.conv, n.wet); rc.call(n.wet, n.sum);
  rc.call(n.pre, n.delay); rc.call(n.delay, n.echoLp); rc.call(n.echoLp, n.fb); rc.call(n.fb, n.delay);
  rc.call(n.echoLp, n.echoOut); rc.call(n.echoOut, n.sum);
  rc.call(n.sum, n.hp); rc.call(n.hp, n.lp); rc.call(n.lp, n.panTrim); rc.call(n.panTrim, n.pan); rc.call(n.pan, n.agc); rc.call(n.agc, n.xf); rc.call(n.xf, n.boost); rc.call(n.pan, n.meter);
  rc.call(n.boost, n.lim); rc.call(n.lim, n.clip); rc.call(n.clip, ac.destination);
  rc.call(n.osc, n.oscAmt); rc.call(n.oscAmt, n.pan.pan);
  try { n.osc.start(); } catch (e) {}
  n.irs = {};
  ac.__hoqFx = n;
  return n.pre;
}
function hoqApplyFx(ac) {
  const n = ac && ac.__hoqFx; if (!n) return;
  const st = hoqFxState(), t = ac.currentTime, nyq = Math.min(20000, ac.sampleRate / 2 - 100);
  const set = (p, v, tc) => { try { p.setTargetAtTime(v, t, tc || 0.04); } catch (e) { p.value = v; } };
  const s = st.space ? HOQ_SPACES[st.space] : null, a = s ? st.amount / 100 : 0;
  // reverb buffer: swap while the wet path is faded out so it never clicks
  if (n.curSpace !== st.space) {
    n.curSpace = st.space;
    try { n.wet.gain.cancelScheduledValues(t); n.wet.gain.setValueAtTime(0, t); } catch (e) { n.wet.gain.value = 0; }
    try {
      if (s) { if (!n.irs[st.space]) n.irs[st.space] = hoqMakeIR(ac, s); n.conv.buffer = n.irs[st.space]; }
      else n.conv.buffer = null;
    } catch (e) {}
  }
  set(n.wet.gain, s ? s.wet * a : 0, 0.08);
  set(n.dry.gain, s ? 1 - (1 - s.dry) * a : 1);
  const echoOn = s && s.echo;
  if (echoOn) set(n.delay.delayTime, s.echo, 0.01);
  set(n.fb.gain, echoOn ? s.fb * a : 0);
  set(n.echoOut.gain, echoOn ? s.echoMix * a : 0);
  set(n.hp.frequency, s && s.hp ? 10 * Math.pow(s.hp / 10, a) : 10, 0.06);
  set(n.lp.frequency, s && s.lp ? nyq * Math.pow(s.lp / nyq, a) : nyq, 0.06);
  set(n.lp.Q, s && s.lp ? 0.7 + ((s.lpQ || 0.7) - 0.7) * a : 0.7);
  set(n.oscAmt.gain, s && s.pan ? s.pan * a : 0, 0.2);
  set(n.panTrim.gain, s && s.pan ? 1 - 0.3 * a : 1, 0.2);
  if (!(s && s.pan)) set(n.pan.pan, 0, 0.2);
  // Soft clipper catches the few peaks the compressor's attack lets through.
  // Identity below 0.8, smooth knee to 1.0 above. No curve at rest = bit-exact pass.
  const needClip = st.boost > 0 || st.level || !!s;
  if (needClip && !n.clipCurve) {
    const N = 4097, c = new Float32Array(N);
    for (let i = 0; i < N; i++) { const x = (i / (N - 1)) * 4 - 2, ax = Math.abs(x); c[i] = ax <= 0.8 ? x : Math.sign(x) * (0.8 + 0.2 * Math.tanh((ax - 0.8) / 0.2)); }
    n.clipCurve = c;
  }
  try { n.clip.curve = needClip ? n.clipCurve : null; } catch (e) {}
  set(n.boost.gain, Math.pow(10, st.boost / 20));
  hoqAgc(ac, st.level);
  // limiter: off (ratio 1) at rest; brickwall-ish when boosting / levelling / heavy reverb
  if (st.boost > 0 || st.level || (s && s.wet * a > 0.3)) {
    set(n.lim.threshold, -1.5, 0.1); set(n.lim.knee, 0, 0.1); set(n.lim.ratio, 20, 0.1);
    n.lim.attack.value = 0.002; n.lim.release.value = 0.2;
  } else {
    set(n.lim.threshold, 0, 0.1); set(n.lim.knee, 0, 0.1); set(n.lim.ratio, 1, 0.1);
  }
}
// Auto-volume: measures loudness (pre-boost) a few times a second, keeps a ~3 s
// running average, and glides a gain toward a -16 dB RMS target (max +12/-9 dB).
// Silence/gaps between songs are ignored so it doesn't pump up the noise floor.
const HOQ_AGC_TARGET = -16;
function hoqAgc(ac, on) {
  const n = ac.__hoqFx; if (!n) return;
  if (!on) {
    if (n.agcTimer) { clearInterval(n.agcTimer); n.agcTimer = 0; }
    try { n.agc.gain.setTargetAtTime(1, ac.currentTime, 0.3); } catch (e) { n.agc.gain.value = 1; }
    n.agcPow = 0; return;
  }
  if (n.agcTimer) return;
  const buf = new Float32Array(n.meter.fftSize);
  n.agcPow = 0;
  n.agcTimer = setInterval(() => {
    try {
      if (ac.state !== 'running') return;
      n.meter.getFloatTimeDomainData(buf);
      let e = 0; for (let i = 0; i < buf.length; i++) e += buf[i] * buf[i];
      const p = e / buf.length;
      if (p < 1e-5) return;                                // below -50 dB: silence, hold
      n.agcPow = n.agcPow ? n.agcPow * 0.92 + p * 0.08 : p;   // ~3 s average at 4 Hz
      const db = 10 * Math.log10(n.agcPow);
      const want = Math.max(-9, Math.min(12, HOQ_AGC_TARGET - db));
      n.agc.gain.setTargetAtTime(Math.pow(10, want / 20), ac.currentTime, 1.2);
      n.agcDb = want;
    } catch (e) {}
  }, 250);
}
window.__hoqFX = {
  spaces: HOQ_SPACES,
  get: hoqFxState,
  set(patch) {
    const map = { boost: 'hoqBoost', space: 'hoqSpace', amount: 'hoqSpaceAmt', level: 'hoqLevel', speed: 'hoqSpeed', xfade: 'hoqXfade' };
    Object.keys(patch || {}).forEach((k) => {
      if (!map[k]) return;
      let v = patch[k]; if (k === 'level') v = v ? '1' : '0';
      try { localStorage.setItem(map[k], String(v)); } catch (e) {}
    });
    (window.__hoqFxCtxs || []).forEach((ac) => { try { hoqApplyFx(ac); } catch (e) {} });
  },
  active() { const s = hoqFxState(); return s.boost > 0 || s.level || !!s.space || s.speed !== 1 || s.xfade > 0; },
};
// Seek the way a person does: press on SoundCloud's own progress bar at the spot.
// Setting the audio element's currentTime directly bypasses SoundCloud's HLS
// loader (it fetches the chunks itself), so playback sat 'buffering' forever.
function hoqSeek(sec) {
  if (hoqYtSeek(sec)) return true;   // a Go+ song playing from YouTube: its player seeks
  try {
    const w = document.querySelector('.playControls .playbackTimeline__progressWrapper');
    if (!w) return false;
    const dur = +w.getAttribute('aria-valuemax') || ((window.__hoqMediaEl || {}).duration);
    if (!(dur > 0) || !(sec >= 0)) return false;
    const r = w.getBoundingClientRect();
    if (!r.width) return false;
    const x = r.left + r.width * Math.min(0.995, sec / dur), y = r.top + r.height / 2;
    const o = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, buttons: 1 };
    w.dispatchEvent(new MouseEvent('mousedown', o));
    w.dispatchEvent(new MouseEvent('mouseup', Object.assign({}, o, { buttons: 0 })));
    document.dispatchEvent(new MouseEvent('mouseup', Object.assign({}, o, { buttons: 0 })));
    w.dispatchEvent(new MouseEvent('click', Object.assign({}, o, { buttons: 0 })));
    return true;
  } catch (e) { return false; }
}

window.__hoqSeek = hoqSeek;

// --- Playback ticker: speed/pitch, crossfade, resume --------------------------
// Speed: playbackRate with preservesPitch OFF, so speed and pitch move together
// like a record (slowed / nightcore) — a straight resample, no time-stretch warble.
// Crossfade: SoundCloud only ever plays one track at a time, so two songs can't
// overlap; instead the last N seconds fade out and the next song fades in over
// N/2 (a gain stage after the leveller). Resume: the last track + position are
// saved every few seconds; SoundCloud restores the track itself on launch (at
// 0:00), so the first time it plays this session we jump back to where you were.
(() => {
  let xfOut = false, fadeIn = false, lastTitle = '', lastPos = 0, resumeDone = false, saveAt = 0;
  const curTitle = () => { const a = document.querySelector('.playbackSoundBadge__titleLink'); return a ? (a.getAttribute('title') || a.textContent || '').trim() : ''; };
  const resumeSaved = () => { try { return JSON.parse(localStorage.getItem('hoqResume')) || null; } catch (e) { return null; } };
  setInterval(() => {
    const el = window.__hoqMediaEl;
    if (!el) return;
    if (!el.paused) window.__hoqEverPlayed = true;   // hoqWhenIdle: from now on, wait for a pause
    const st = hoqFxState();
    // ads are muted / fast-forwarded by the ad skipper: leave their rate alone
    if (!el.muted) {
      if (el.preservesPitch !== (st.speed === 1)) { try { el.preservesPitch = st.speed === 1; } catch (e) {} }
      if (Math.abs(el.playbackRate - st.speed) > 0.001) { try { el.playbackRate = st.speed; } catch (e) {} }
    }
    const title = curTitle(), pos = el.currentTime || 0, dur = el.duration;
    const rate = el.playbackRate || 1;

    // resume: once per session, on the first real playback of the restored track
    // Auto-resume is OFF: seeking the moment a song starts stalled SoundCloud's
    // stream loader on signed-in accounts (stuck buffering). Position is still
    // saved; the jump back stays disabled until it can be done safely.
    if (false && !resumeDone && !el.paused && title) {
      resumeDone = true;
      const r = resumeSaved();
      const fresh = r && r.pos > 10 && Date.now() - (r.at || 0) < 30 * 86400000;
      if (fresh && r.title === title && pos < 3 && isFinite(dur) && r.pos < dur - 15) {
        hoqSeek(r.pos);
      } else if (fresh && r.title !== title && r.path && pos < 3 && performance.now() < 15 * 60000) {
        // SoundCloud restored the last track you PICKED, not the one autoplay had
        // moved on to: switch to where you actually were
        try { el.pause(); } catch (e) {}
        hoqPfOpenAndPlay(r.path, r.pos);
      }
    }
    if (title && !el.paused && pos > 5 && Date.now() - saveAt > 4000) {
      saveAt = Date.now();
      let path = ''; try { const h = npPublicUrl('.playbackSoundBadge__titleLink'); path = h ? new URL(h).pathname : ''; } catch (e) {}
      try { localStorage.setItem('hoqResume', JSON.stringify({ title, path, pos: Math.floor(pos), at: saveAt })); } catch (e) {}
    }

    // crossfade envelope
    const n = window.__hoqSCAC && window.__hoqSCAC.__hoqFx;
    if (!n) return;
    const X = st.xfade;
    if (title !== lastTitle) { if (xfOut && X) fadeIn = true; xfOut = false; lastTitle = title; }
    else if (xfOut && pos < lastPos - 5) { fadeIn = !!X; xfOut = false; }   // repeat-one looped back
    lastPos = pos;
    let g = 1;
    if (X > 0 && isFinite(dur) && dur > X * 2 + 10) {
      const remain = (dur - pos) / rate;
      if (remain < X) { xfOut = true; g = Math.max(0, remain / X); }
      if (fadeIn) {
        const inT = (X / 2), played = pos / rate;
        if (played < inT) g = Math.min(g, Math.max(0.02, played / inT)); else fadeIn = false;
      }
    } else fadeIn = false;
    if (el.paused) return;
    try { n.xf.gain.setTargetAtTime(g, window.__hoqSCAC.currentTime, 0.06); } catch (e) { n.xf.gain.value = g; }
  }, 100);
})();

function hoqApplyEqGains(ac) {
  const bands = ac && ac.__hoqEqBands; if (!bands) return;
  let on = false, gains = [0, 0, 0, 0, 0, 0];
  try { on = localStorage.getItem('hoqEQOn') === '1'; } catch (e) {}
  try { const g = JSON.parse(localStorage.getItem('hoqEQ') || 'null'); if (Array.isArray(g)) gains = g; } catch (e) {}
  const t = ac.currentTime;
  bands.forEach((b, i) => { try { b.gain.setTargetAtTime(on ? (+gains[i] || 0) : 0, t, 0.03); } catch (e) { b.gain.value = on ? (+gains[i] || 0) : 0; } });
}
(() => {
  try {
    const P = window.AudioNode && AudioNode.prototype;
    const Dest = window.AudioDestinationNode;
    if (!P || !Dest || P.__hoqConnPatched) return;
    P.__hoqConnPatched = true;
    const realConnect = P.connect;
    P.__hoqRealConnect = realConnect;
    P.connect = function (dest) {
      try {
        if (dest instanceof Dest) {
          const eqIn = hoqEnsureEqChain(dest.context);
          if (eqIn && eqIn !== this) return realConnect.call(this, eqIn);
        }
      } catch (e) {}
      return realConnect.apply(this, arguments);
    };
  } catch (e) {}
})();
// Read/write access for the EQ UI. Persisted, and re-applied whenever the context
// exists (the chain is built lazily on first play via the connect patch above).
window.__hoqEQ = {
  freqs: HOQ_EQ_FREQS,
  labels: ['70', '180', '450', '1.1k', '2.8k', '7k'],
  get() { try { const g = JSON.parse(localStorage.getItem('hoqEQ') || 'null'); if (Array.isArray(g)) return g; } catch (e) {} return [0, 0, 0, 0, 0, 0]; },
  isOn() { try { return localStorage.getItem('hoqEQOn') === '1'; } catch (e) { return false; } },
  set(gains, on) {
    try { localStorage.setItem('hoqEQ', JSON.stringify(gains)); } catch (e) {}
    try { localStorage.setItem('hoqEQOn', on ? '1' : '0'); } catch (e) {}
    (window.__hoqFxCtxs || []).forEach((ac) => { try { hoqApplyEqGains(ac); } catch (e) {} });
  },
};

// --- Global media keys --------------------------------------------------------
// The C# host registers the hardware media keys system-wide (so they work while a
// game is focused) and calls this to drive SoundCloud's transport.
window.__hoqMedia = function (action) {
  try {
    if (hoqYtMedia(action)) return;   // a Go+ song playing from YouTube: play/pause/stop go to its player
    const q = (s) => document.querySelector(s);
    if (action === 'next') { const b = q('.playControls__next') || q('.skipControl__next'); if (b) b.click(); }
    else if (action === 'prev') { const b = q('.playControls__prev') || q('.skipControl__previous'); if (b) b.click(); }
    // Stop only ever pauses: as a toggle, pressing it while paused started the music.
    else if (action === 'stop') { const b = q('.playControls__play'); if (b && b.classList.contains('playing')) b.click(); }
    else { const b = q('.playControls__play'); if (b) b.click(); } // playpause
  } catch (e) {}
};

// --- Anti-bot-detection (does NOT clobber chrome.webview) ---
(() => {
  try { Object.defineProperty(navigator, 'webdriver', { get: () => false }); } catch (e) {}
  try { if (window.chrome && !window.chrome.runtime) window.chrome.runtime = {}; } catch (e) {}
  try {
    const orig = navigator.permissions && navigator.permissions.query;
    if (orig) navigator.permissions.query = (p) =>
      p && p.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : orig(p);
  } catch (e) {}
})();

// --- Audio-ad killer: hooks the media engine (SoundCloud uses detached media
// objects, not <audio> in the DOM), detects adswizz ads, mutes + fast-forwards. ---
(() => {
  if (window.__scAdKiller) return; window.__scAdKiller = true;
  var media = new Set();
  function watch(el){ if (el.__scWatched) return; el.__scWatched = true; }
  // --- Custom volume: our own 0..1 level applied to every media element ---
  // Guarded: on a sandboxed page (a bot check can be served that way) touching
  // localStorage throws, and a throw here stopped the whole file, titlebar and
  // Fix blocked included, leaving a frameless window that couldn't be moved or closed.
  var vol = NaN;
  try { vol = parseFloat(localStorage.getItem('scVol')); } catch (e) {}
  if (isNaN(vol)) vol = 1;
  window.__scGetVolume = function(){ return vol; };
  window.__scSetVolume = function(v){
    v = Math.max(0, Math.min(1, v)); vol = v;
    try { localStorage.setItem('scVol', String(v)); } catch(e){}
    media.forEach(function(el){ try { el.volume = v; el.muted = v <= 0; } catch(e){} });
  };
  try {
    var P = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function(){ media.add(this); watch(this); try { this.volume = vol; } catch(e){} return P.apply(this, arguments); };
  } catch(e){}
  try {
    var A = window.Audio;
    if (A) { window.Audio = function(){ var el = new A(arguments[0]); media.add(el); return el; }; window.Audio.prototype = A.prototype; }
  } catch(e){}
  function badge(on){ var b = document.getElementById('sc-ad-badge'); if (b) b.style.display = on ? 'block' : 'none'; }
  function apply(mute, rate){ media.forEach(function(el){ try { el.muted = mute; el.playbackRate = rate; } catch(e){} }); }
  var AD_SRC = /adswizz|doubleclick\.net|googlesyndication/i;
  function isAd(){
    try {
      var hit = false;
      media.forEach(function(el){ if (!el.paused && AD_SRC.test(el.currentSrc || '')) hit = true; });
      if (hit) return true;
      var pc = document.querySelector('.playControls');
      if (/\bm-ad\b|advertisement/i.test((pc && pc.className) || '')) return true;
    } catch(e){}
    return false;
  }
  var active = false, force = 0;
  setInterval(function(){
    var ad = isAd();
    if (ad || force > 0){
      apply(true, 16);
      if (!active && ad){ active = true; badge(true); }
    } else if (active){ active = false; apply(false, 1); badge(false); }
    if (force > 0){ force--; if (force === 0 && !ad){ apply(false, 1); badge(false); } }
  }, 350);
  document.addEventListener('sc-kill-ad', function(){ force = 16; badge(true); });
})();

const TITLEBAR_H = 34; // px

window.scDesktop = {
  minimize: () => scPost('win:minimize'),
  maximize: () => scPost('win:maximize'),
  close: () => scPost('win:close'),
  reset: () => scPost('app:reset'),
};

// Resize the frameless window by dragging near its edges (WebView2 covers the
// window edges, so WPF can't resize — we detect edges and trigger native resize).
function setupResize() {
  if (window.top !== window) return;
  const EDGE = 6;
  const curFor = {
    top: 'ns-resize', bottom: 'ns-resize', left: 'ew-resize', right: 'ew-resize',
    topleft: 'nwse-resize', bottomright: 'nwse-resize', topright: 'nesw-resize', bottomleft: 'nesw-resize',
  };
  const dirAt = (x, y) => {
    let d = '';
    if (y <= EDGE) d += 'top'; else if (y >= innerHeight - EDGE) d += 'bottom';
    if (x <= EDGE) d += 'left'; else if (x >= innerWidth - EDGE) d += 'right';
    return d;
  };
  let edged = null;
  window.addEventListener('mousemove', (e) => {
    const d = dirAt(e.clientX, e.clientY);
    if (d && d !== edged) {
      document.documentElement.style.setProperty('cursor', curFor[d], 'important');
      edged = d;
    } else if (!d && edged) {
      document.documentElement.style.removeProperty('cursor');
      edged = null;
    }
  }, true);
  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest && e.target.closest('.sc-tb-btn, .sc-light')) return; // let window buttons work
    const d = dirAt(e.clientX, e.clientY);
    if (d) { e.preventDefault(); e.stopPropagation(); scPost('win:resize:' + d); }
  }, true);
}

// ---------------------------------------------------------------------------
// Base stylesheet (clutter removal + scrollbar + accent hooks + titlebar offset)
// ---------------------------------------------------------------------------
// The app logo, inlined. It used to load from the holdonquietly.app virtual
// host, but soundcloud.com's CSP blocks that origin outright, so every place
// the logo appeared (tab header, Discord embed, friends fallback cover, the
// injected CSS mark) rendered as a broken image. data: URIs are permitted.
const HOQ_LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAC1WSURBVHhe7bwHWBTn+v6/KSYaYzya2DUqggWxARZARQURBUEE7Eqx94YFG/Yu0kQFKaKoYMGKvSuK1AWW3pGOwO7szGyZ2ft3vUP8noRzchI95fr/z+FzXRNhs7sz+7zvPOV+nkUkaqKJJppoookmmmiiiSaaaKKJJppoookmROPt5rSfPXvlD40fb+Lfzxd6Q0cb2cxcOGP+6q1jVq70+GHu5v0/Onp4fNP4iU386/lSJBK11h1i5LJqj9fIxXt9hlnPXPSTy6Y9IwF81fjJTfzr+ZosQF+D4ePH2s7aNX21Rw+RSNTMat6KYfoWs2b1MrJerj/OYYHLSvd2jV/YxL+Ijt20DA1Gjt84auLsBWZWs9yHDOnTuV1fk5M99MeHdx9oMrXbwNGTjcc7eE13XtqNPN8j5GlzAF98fH18fHwz7+job3/zpk38YzyAL508PJoPH2tlMGS4qcuMxWsXuh/2MTEcaTmj+4CRN3saTvAB8KXDgjUr7efN69+l95CBYybNmk9e6ygS/dU1de/efPfJS4OOhN1v+ev3b+If89XAgQNbmkx0mGXrsmq92WS7ldOcF012cFpk2W/IyK26o+3iDMynjLSbs2iTh6e/VgctrfYikegvRmZ2e0uBvg/y2QlP8mnbfLlmkIGBqFnjN/+fxsPDgwTV3wDg6x/7GLeycJhvSXY18fEikaid4ejRQ63mrVihO84xsrex7dX2/UY96TLYLH/g+JlFZjYzXA3N7WO2HfAeIhKJWpjaTN8we9MR1YyNx7mJi3dh8op9mOfupQm6E3tfo9H0b3zO/1W+IL7ZL/Jpx4+/k/8s2XZ0SNdeutrGExwW7N17rAt5bERXUYvW3QetadNvTEGrXsPDm7fvtf7b1u0Xfdnix6UtO/fb38twfLLFtMXeY63sBo2fOves0w4/9LV0Rl/zOehv6QJdC2f0n+AM/SnLsC/ourReoxn28SIi09K++XWM+F+C+OYvl3p4DVzucajzL4994TB/mbaxlYNNq+4DRljOWLq78qnf9617DN7bbsC4stY/D9AnT/Lw8Ph+gq0TyYBaa2t3H6I7zNSx93DL8AGGozZMnO9e32fiQvQZ74SOJjMh0honHD8MtkF/S2f0tnCGd8SjnKL6+jZbfSJ6nox41EUk+t9cAPKhfxgwYGSbCQ6uNuSBVq1a/di59zCPXobjbzX/sad312HWGDNrtVhrhE3Gqn2BHU6FXutl4TC/7bKd3nPtnNfoG09w6OMwf+2Oxes3jfnmm+8m6YyYJNexcOFaDbCE/eaT6DjWGaKuIyHqOgptjGdizJID0BrliFnu3nieVrL52LGIFo0v6n+NViKR6Btjsym2xuYTDTv10FtlbG53euq0OR4D+/eb/nX7PqmtDOxhM39jTHsdw0X9xs9l1207uGuS/YyZJibDBukaWRyevmhdaMuWzfrrmVhe1zaxqW5taIee412x51oSWg11RB+rJdC1XoLxa31w4kUprJbtg9FMN9xNLnEH4put3HrQ2MbFzS7o6uNBjS/uv5Zf+VwSZDt16N6nx+Ch4w7/RXtodEej6UqbhZur7Oxs3b7t2De59WBrbpzjwtyuA0Zli7qNxNDJ82UT7J2PftFRz6vHcOtye+c1ewePsYnqOGBsZa9RDjVdRs/E4OluOJcsw96r7+C63Qe2i7fhVb4U994DCw6eh/7UFTh/942v1iBj57aDrcp6W6+Aq9tej0aX+V/LlyQPX+lxRPeX3/9CMvQ2HX72aqEzCiKt8eg8Zh5cV26Obttz4DNRt1Fo1scCWuPmcQbT3TRW67zgevACZuwMxdSNPhi7cDcG2S7l+oy0zWndZ1TV8DnuMHBcjch0BfIVQFZ+CTJzCkEo5QCHjd4wcFgDUyd31Zd9LCDqMwmtBloVjrZ1HtXoOv97CHma9JdDFx58DLQkrfzW0sFF19x6pil5oJVIpNO6Vcs1X3cfphb1s4Ko9wT8PHoWWvQ2re03cQmWel7B/shX2Bf+GJv9IrH6UBDWHAqCm1c4PEKisev8I6z0jYKe7Sq01Z+MNv0tsPf8I8HovyYptxQDrRZizJL9EPWZiG90xtR1HmwWYGZlY/7bK/7vormBtfV3G4+f7eeyfv9wD49Iolp+RxZBT3+UlbnVjIUdBpoFtBpgWf1ln/GaL/pNhKjHGHytYw7XQ5fgdSseqw4GYMz05eg+Ygq+62sGkdZoiHqOxjc649B56GSY2C/G0t1+OBL5FAsOhaP1QGu00BqFgIs3kZmdh7yCYty6/wzTV+6C8+5gaJs71fzU1+iK/byFE1e5ewwcbz9neOOL/m+CpJsk2Da3mbvI0GrGArvxDnN6kkX4XiTq+33PYdlf9p8Mke5kfDT+D4NssP3cM+w5exumjgvRkhi9/TA06z8J2pOWYNiszRgxdyv07FajtcFUiDoMx5c9TWFo7YRNXsHYfyUGHUfOERbH7/wNeJ+NwsbjYXA7FgpzxwX3u/TQXg0P0ZcW01zmTZ6zZCnRhkhcct2wodWGQ2fItf7XQYJuG+Lv+/Yd+qPJeBu7voNN5rXUNor7S2+T0u96GMpFOuYQaY/Hd7oTsT38BbaeuID+ZtMg6jQCbQynwn6DN+bvDcHU9Z4YO38nTF12YPLqw3DZFQCXXUHoPWEBRD8NQ3t9KyzYcgCHrr2BlpkTJs7fjAXuh5XOK90ju/XQtiAXYz5u3Oq17rtMx9nOnKw3YozpxKkzVy9etU3HYf5abQ+/yI+F4X8lJOv5nmQ+7XoNeqhtZENb283wbd+m9cKvOvTNFHU3xcKjl7EzKAoGlrMh6mwEQ8f1cN0bikG2K/GlthlEXUxAArNwkJ+7m0JrnBPm7QjA5FWHIepkjNZ6E7B8txd2nHuMrsaO0B5iOoec3MjIqH0b3XF7Ohs7lExd5pHitHT9fLvZszsNHWW+RFfXlFzX/zcgegyAZp/a5PjldR9f+xudZ+VK729d3I/oGo230mvdpd8uHWObEtuZC/brjbD0MzQet+PLNt1f6M/YAI+wx7CcswJfaY/BANsVmLjyIETdR0LUbTREfS3xRePjF7cl+lEfo5y2wm7dUYg6GqHTMFtsPRmBtX5RsJ63JrKD4WTPb/paKL/qb42vtEYyPYdb5ds7LV9uOHLcHBPzSVN/fa3/cXZfkegsu1W/YslN6elFtxTPlt7jYpbe52M23acf7HhEnfCLqV/xMrfeQKPR/F/lWBof/9322+XDl0fTa5bcrPNZcoO6s+w+93r5Xe71sgca8tq77g+pk0deyDaFPEyzPHBgt8FSMx2tTp26LGrRZYCk/1hH+Zz5K5e2E4k6tullmN5cd4Jm6iY/zFh/GF1HTMGPw+ygN2Ulvu1vCZuN/ug2fj5Evcz+ZgFEOuPRcsgUGMzZiu90LTB2/g4YzXUX4oLZ7FU4fDUGfa2XoUV/S7TuZ5rZXkf/UJsfWs7orzfospHRSBfjsRYrV3t4kFT4P8vaEV1buF4scHa6Qb1ccotSbHsNHE0E/JOBYAlwNhM4lwkESQDfeODAC1bq/YqK3hJdPnnmxQ/HXW/Ruavustj5FvBKBvzFQHAqcEYCBGc0vEegBDj6Dtj1SKbe9qC+aNuVjAsO89euGKin5/59J+35XQaYRnQfPPZFC+2R1e1GOGKo/UoMt1uClnqW6DxqBprrTcJq/ztYF/QYPxlNA4kTjRfgSx1zdBs3D5Pc/DB791m0HWIN69WH0Vx3InqaTse2wCi47j8H08lzz6Iy8nsnJyezNp21ZvQaNv5lV+NpEToTF5Ws2ul1LPo/2aSZ5/d65ryrtenrXwBH44EQsQZXJCo8KlAjLFWFqxksQlOVuJShQFCKCmdSeYSmNxjVOx6C0c+IgYtpPC6mqXEhjUNUFic8P0yiwL18FtfSacSVMHiRU4dHaRW4HF+BYw+Kse68mF929Kp45frN+2bOnr3s+w7dQ0la+aOhHXQnzof22FlooWcJ0c8jMdp1J84l1mGU6078xdAOX+tOFNyQqM/HYwK+GzQZerbLMGzOFiz0vokp6zyhY+6EvpOXo5nOWCzadQLbwp7CbOaqlO4mU73bDbcvaTHQGsQVfaNrieb9zBmTKQsO/UcU0RE/iNrOPR13bskj4GAsEJqowONCDk8LFIgrpfGiQIqoLBq3cygEprAITlXCM0GJo4kKnBar4J/M4Wy6BhfS1Dgn0eBMCoczYhV84tU4layCb5IS3olKBKeyOJVI4VxiJe6klCE6MQ+xKem48eglwiKuwWTqYhjaLYPTqh2Zg0dNuNms+1BpuxH2GGq/HF2MpkLU1wJf9BqLHedfwvthLka57oCWxXx83X+S4IZEP4+CqPtoiHqNQzPdCZiy6QTWBz/BsXtZOP2yGMOmrcEA26VCvTBtzW7sjXiBbmPm4dve4/Btz+GaNn1HK9v0HOzTqm1n57YtRF0b2+nfwsiBA3vPDslOXv8KOBlD4U4Oj7RqFSgVgwqpHBVyFnl1NF4Xy/H2PY1LEjkuZbA4lcTAK16JM2IOJ5PVOCXmEJKmxkkxj4AUDkEpHE6L1TiTqsaZFB6nkxt+90tUwTdZgfMSBqeTpLifK0N0ajnuPn+FVe4e0B1jj7lrdsN+8Ra01Dbm2w23xzCHFWg/fKpg2PbG03D65XvBqK5HIqFluRBf9bNA6yGTscb/FvZefosf9a1h7LITh++kw/95Mc68qcClNAZOe4LRZ4ILvuk3AaNnroJH2EPo26/iTcwnv9bp1cPNcviQgR/tAqR9s887SGji6zo6fmMxZ8Wgg6cjf/bwOE2KxX8No4cM6TcrOCvL/TUQ8o7C0yKAVpPinINGowbHq8GolZArFcj+wCLnA4OHuRRu5jAIl1A4Ec8iKFkFr0QVTiWrEZzGITCFFwwenMojLI3DhQwe4RIOZ1OUCHz3AYfvZmNvVBK2n3+BZT63sPr4BSzcdQpz1+yE7bzl6DhwLAZYzMGsVTvQRs8cHY2nwcx5M9oa2kHUcwwGOqxFWEItfJ8U4OCtNKzwj0Z/uzWwWX0IeQCCnufgez1L+N2X4F4xEJZYh4CYcoSLZdgTGQsdM2e0HWKFkY7LsDXkLgnoKv0x1vmWs5bu0zGbt017zPSL3UfPfKht4VLqsn5/gLe397c/tGvXS89kwrQtvuf0Nx083bqxHT+LbiJR5+knk1LdY4Cz72R4UwpooAH5L6/hwGl4cDwPhUoJRqlAQS2FwtoGd/QoT46IDCn8k1kEiVl4JTQsQEgaj1CJGpcyeURlc7iVo8aDAh4PCtW4lSnFbUkNriRX4VxsCQKe5mLfrTRsv/QWbqFPsMrnClbv9YXzmm1oqTUM3Ybb4gc9C3QaOQPT1uxHT9OZQn5vMGOjYNSgt5XCzg4XU7iVWQcDu6XQHjtbqIx/GGSNtDI5JPXAk2INLqbSggq6/0octM3m4ScDW1i6bsCGUzcxZu6G+l6DTS626TsSfY0sk1p0G1j1Te9x6DbUCg4L17tfeJXQ2cDA4F9j9F/RzM4j8vr6l0BInBxvywClSgmOU4FRqUApVaDVKlAMizpWhRpagYxqGtk1NB7n1gt3wZVMGXyTaASmqOCdoBZ2fGQmj1t5PJ4Xc4gr45BSxSG3jkN2nRp5MhXy61XIqVYhsUqJF8UKXJbQOB1Tib3Rudh84S32BV3FtsN+WLZ+M7SNrEFk5nbDHeCy3Rv6kxdA1NkYo5y24XySFMGxVTibUIeHRUABA7wQ52Dmsh1wXOCOZ/Hp4ABU0kB2HfCyDLiex2NL6FP0s3DGT/qT4bh6LxYeCsdIx5XVgw2Gze/Qtadrl+7asV21+tz6+ttvl3/1fTt7nf6Dj5lPmbtw5U7PlUdPh/RtbMTPxtRhxYqF0SqcfEPjZpYKtFKJWpqGTKFADc2imqJRxyhRJqVRLlehmGKRUSlHzgcazwtkeFhA416eHEHJcoSmyeEZp0BwmgpXc3g8LOKRXMUhv45HFcOjXkEODlIVD0qtQT3Lo7ReiYQSKW6KKxH4ohhHHhZh7/0CBNxPwsqDwXBctB6jbOai/0hrNO83Aa4e/rBZ6iEE2aF2yxDwslgw/vVsFcTVQLmc3Le/Rc0BCg6oZYGsOiCmBlh6LBKdjBygNdoRi3efhMWKIxg80blu/vI1C7T761v30Na95jBjznjjcVaj7OYucuzYtbtl74FGT6fNX3Vk1ebdBo3t+Fm0F4m0pvvGle9/A9zKUqOgloFcwUJG02CVCshZBWhWAYVKLfwsV6hQzypRJWNRLVegsFaOlHIaKWU0rqVTuJoph2c8C/8kJc6nq3ErT4P4SrWw82sYDjIlD7mKA63WCMcHmkNFnQJpFQye5bGISFfi+KsKrAl+hC0+YXBcuh1Ws5Zh0cY9GGZJNJ+hmLB4J9YeP4/WQ6zR1sAGWwNvISJDjefvgUIpIFcBah7gfzm4Xx2sGqhVAzEFMox1dsdX2mMxft56OO88jf52qzB8snPYonVbHY3GWUzRHjL6nqmtU4zT6i2rNh8NsB5lOdlJW09/j+PC9U5rtx8y9fDwIBN4/xwT5mw86vYYCH0nQ8YHQKNRQc1xgIYnvzQcH/fT//2sAc83xAQ1p0Ydo4CUVSClXI537xkhRT2dzCAgSSlkO1G5HJ4V8xBXcsit51AsVaNErkY5rRZ+LpBySKjUCDv41Ls6eD5/j+MvSuAZ9RI2rusw1NoZw2wXwHLuSrTqY4Iuo2dg25mbsF2xB6KOI2Ayez3C3hYjRQpUyAEl91uj//ogV0/yCt9rL9C8nwV6jHLEsoPBsFhxCD8Ns4f9vCWXZi1aMXWAgfHaDj36ves33OzegFFWMXbzlobq9Bt0wNB4rO8W37MT1nocWea6fMPH3sXn8a1I1MPR602ZZ4waj/N+Mfxn0bAoCpUK1XIWJXUUHuXIcS+HhW8cgwCxUgjKF9M53MzlcD9fjSfFPF6V8nhUxOFpsRo3cnkEpfIIknDYfTcf7t4X4LB8ByznrMLGYyGwXuQOgwmzMGH6Aoh+HAz79Ydw4NJj9J/oIizCtDV7kPi+HpTm9xdA2D8AXmeWYbDNInQYZIF57sewwvMifjZ3gbbp9GR947EbBhsYHe7QofPk7r10r/QdqL9dd/DQzR27/OzQ6Wctk65afe0Gm5htN7ebbePo+E9OWg+zWbBh5T0VQuNplFLEhkLO+U/Ba3hoeA6ldQyK6xV4XkghOkeOiHQ5/BJohIiV8E7gcSZZjdA0NQKI0VN5nJFosO9hCdyDo7HyyFm4n32Iy28ysN7rAkynuGC7dygmuqxHf/NZ+FHPAq36T8CGE5dwIOJpQ7bzl0GwX+aB4lryQX6fG8/j0cdsNn42sMTirUeF4svIaStJRdXzFrstXrtlb5fO3XUC9fSNq5es27J93R6vkRaTp62xsbEh+v8PnTv3IrOkbRvb8nNobrnt8vM9scDjfA6UQo0qSoF6lgWtUkGtVjW+9k9Dw0MpuCcGuR8YZNbIcDNTiuh8FmeSaJxKpnFSrMDxOBX83klx8F4mtkbGwu9JJiKzlLhXqMCh83fgduAE1u3zhuPSrYKvXrjDGy37joHop6HobOKIXWHROH4nEaZOWyDqYIiuhtbYfuQUnsYkIruwFEVl1UjNzEPk7ceYtXw72umZw8TGBfv8QnHqdgxs1h1Bs77jVV0HjfPv27fvin6DR1zs0K3n7p+6aEVNd1l20dFpmfM4K4cZjo6ORPH94khYWMv4ePzzo4tfi0RDp5+WyP0TNXhaoIK4gsH9XDmisqR4UyLH4zwpSmUKlMsU0PCqv96/n4BGo4GGV6NWzuIDTSOmmMbb9wyuSmoRKmFxPl2B429l8HxVBd+3NTiRqMK1HA6BcR/gcyMWwQ/jEfQsE0eCL8PIxgVzNhzC2OkrYDlvDXoZTcIXPxuji5E9NvhfRvDrQvhcj8HstfvQw8QenUY4op/ZHPQeOwtdhtuh3RArmExZhM37/XDl0RtceR4PyyU7INKZAOOpi1Ntba1n9RtkOGfowIG9RSIRGeay0NM3fjV5mtMIkanpx2ArLILnubud/CKfflpf4HVybvvAt/UGFxOlxknFNV0GjHd2XHJDjnCxGmfFLCIyaPiS3ZjEIjhFAf8EJUJTGFzLkONpAYWiOlZIQ0k1/EmxQqNBPc2ilmaQUEohvozGVYkUIakMzogVOBanhD+RJMQcfOOUCIyrw/GnhQh9V42n5cCx66+xdq8fQh/EYfqSjeg1wgrWLuux7nAAWuqOFe6EZjpmmLRsF7zvvMPrYhmSSqVIfl+P/Go5Uouq8VSchzeSQiTnl+OVOAuHT51HfwsniLqMQLNuBll6prZpq9a5mw0YaeloOWNxtK2j42BSm+oOGhq0evUmshgfIb0Lwe97ePy2j/F3MRV1bz7v6ocFc29zVxbcZN8vv0Or1kbL1G7RsjKna3Si2z0GEakKeL+lEJqmQoCYR0QOhzt5HC5ncYJuQ8Sz/W/kgh+PzpYiu5pGYb1CqA1YNakZFFDzaqFS/ntoNDwohUI4UiooJJbTuJEtFaSAELEMnrEKnEhW43iCCkdjFfCPlyJAzOKChEXg4zQcCH+A2MI6zNlwBE6rt2Pq/FUY47gQniERMJ3ihCHm9ugwyAyitnr4ru84TJjvjn2nLiLi3ks8S8hATEouHr8V42zUA6zeeRyGVi5Cx+wnA1tpp16DFvbpo+0y2GDEfHMbx83tuuhM1TIwi7R0cF1GOnK9++sH2c9xNm5s1z+F9aGnU2Zek0vWvACOxAOnk4DIdA3u5wOPi4E7hUC4WIkrGSr4JsoRmqoSUsZL2RrczNUgIpv/RcdRYn8ci5vZckRlUHhTQiO1SgFxmRylUhq5tXLUyBkhDZWySnA8J6Snv4b8Th6vZxUooxTIrmEQnSPF3VxKyJLOptHwIQppnBJnUhl4xdE4+bYEZ19lISqDhk/oZez2CsK9t4m4dv8p7ryOxf7jvli12QPLNnnA9/QZbNixB8PG2wl1gqi9IZppm+KHQVb4YYAlWvQ1h0hrDERdRkH08xg0HzIVk+dvuLjt4PF+Y60dN+sbmW63sJ3uptN/SD+D0eaTRk6ctlEkEvXT0dN/sszN49N7vxMPPtvjfJfDgddqhMXL8bRQgyIpwPwmyeHwnlIivUaB8DQK5zMYnEhkcTKRQ1CqEn4JapxIZhGZySBSQiO5nMG7MjnSK2mhAn5TSiOjisabEgrviuXIrKGRUCpHvUKBOlb56xP9ho/6EqmwaxglkioYxJQweJBH42KaDHfzKAQnfsAFcTVelyjgF/UCW71CkFWnQmZhEd4kpyNZkoa9B47hsNcJrPU4gpqaKsTFxeKwpxd6G1tjxeadMJkwBd0Nx8PU3hXDJzqgk/54tOozBiKtsWhrNAt2TivDe+sOsezee9C9UWYTLwBoPmCkpZmp7XTB5bTp+HNInyFG+xvb9g8Z435l98LHgNcrOa5JFIL28XuoODVkShYplTSeF9GCES4kU3hSQONaJo2kcjmyqhkhEJPMiOhCNXIFahkl4krlSChn8SBPjsh0Bs+KGFxOp5BfS6OgTtH4VP8ADoyKg1zBQVIpQ1aNHE/zpYgpVeDK63QcDLqC7CoZxCV1kOQVoKisEklJyQg+G47Iqzdw6Vq08C73HjyEl99J+J05j/OXIuHl54+ExGTcffYat+7fx9J1W7B07SaIOgzB17qTYD5tUfnocROudO9nuGWIkem2wcNGzhw1yqJbv8HDdTp01fHv1KtfyCfn+QaOG2bOuaHE8RdS3MhQopJp/GH/FpKp8DyHEikraP2SCkoQ24rr5OD/L+D+tQJWcyqwagUS30vxuphGmITCyWTS4WLgk0jjZaFUuBP+Vo35Y4irkimVyK+j8SbnPUKjn+NGahXy6hR4lV2KWjmFD/X1ePLsBd7EvsOzl6+RX1gMipLhydNnCAgOQ4I4DV5+p5Cbl4fisirkFZUgp6AIvgFnMdVpORxcVmC09XSs2HJA7bbj0M2goJNk9LFTdx1d5269eu/p0E3raJde/ec1tu0f0lwk6jbZP7NwTwxwOVWBCrrxx/sjGgzGKhTCgnDc3y/KamkWlRSD29kyRGayOBLP4gwpqFKU8E5S4mK6HM8LaYBXCov7qbCcGgWVNbgVl4U3hXW4k8ci4b0UrwqkgkCY/74Ur97EoqKiAvHJqVCp1KiuqkJ6ZiYuXb6GU4FnsHPvQeQVFCIuWYKs/CI8e/UGew55YuXm3Xj1+hXmuS5AfJoEnmHXMdNl2VX3+TM6/DIGQ2Tmz2s5Dpm7b+fyJ0BwrAzpHxp/rE9EyN95cBwnLIZSrYRMqcIHhkVCGfH7NI6+I8FThSCxGlEFPKJy1QiTkKyJxa0cGjJWDnWjYPxHEAmcBPZ76ZW4JqlHZBYNvyQG17LkuJFJI6GwGjFpucjIzoFUKkVVrVR4HUVRKHlfisKiIpSWluL6zdt48PAxZBSFN3GJuBV9H+kZGXj77h0uXLqEma5LEHn7Pi7fe4YjEU/wLLvGtbE9P5V2FkdjMw/EanA/lwf/6RvvV/BgVUrQLIvieuKWFEgskyOunMG9fApnU+UITmVwPEGNK3kc7hfyeFnM4VWpGrdyOPglKIU7g2RHCiJJ/gl4jQachsPbQimeF8vgmVCPM2kq+CVzCEjmhFT4tFiJsLhSRKeUIbu0EgoFiw/1FFiFUtgkBLVajcLCQrx//x7u23cjOyf3V2fhEBB6DqaWU7DiUCjCX6Rjlc817Lopwc1iTb5GoyEF2Ofxk46+1azz5ZrAeCXy6n91zk+CGItHFcUgt5YUTTLcz5bjYR6NgCQ5zklYeMYrcJIYQqLC5RwOD4s5xJTyeFPGI7Zcjdv5KngmqBCRweBlIQWp8o8XgMSZQqkS4ioKQSkswlJo+MSRKpnD5Qwe13J5oY0ZmKzEgYeFOHHjNZIr5JBSFGiG/ZuUt7q6Gm9j4xAUeg77DhxBwJkQnLsQgU3bPGA42hL7Ay7AJ1mJrRdeY9elGAS/LcezOiC9lj/a2K5/Gt3p23ese8TjukQBBfep278huBZ8oFFUx+CipB43suTwT6CF4Ep23vH4hv7u2TTS5eJwI5tDdK4KD4s4PCzkEJ1Hijc1wjM5eCYxuJxJ4ZpEihKpQsia/hrEP54PYIWsSo20CimeFdK4kEbBP4mFf7ISp8UcwtI5XEhX46ykwbV5xdTA/dwTXI1JR3IFC1b591NdmUyGzKxsFBYVoiA/D1ev38Dh4z5w2XQAuwOvYtHeQHi9rMD5t0V4nF6F/HqgTAkU1SuLAWg1tu2fYtjy0yF7Y4Eb6QzqWAVkrAIaEP3m9yUDXsjIeVRSLHJr5DiXKsOlDBoHYxUISmURKFYiIpPHtWwyx8MhKofHrVwOV7MajvAMHufTVQhLU+NEEpl0IBMOapxKYHE1Q45zKfVIKGMQV0KjoJZGqZRB3gcK5TIGudUNkkRKJYPLEhnu5DIIT6UQkCQTsqkTSUoEpTAITlXAL0mO6xkUTr8uxvO0AiHFlTLsL/XE30L6FASSRBQWlyCzoBBnr97GociX2HH+MVwORsDvSQHu5jFIqQNKKQ5SJSBV85AquU/PfgjDlgecO5ECnExQIraMxqvChoyByAVkmoH42N9eJJluUCHvgxyvi2iEp8rgl6AQqt6ILB53izk8ec/jUTGPJyU8bhPDZ2twIUMljJiEpKqEjldAckM88IpnBL8fnNowpnI1S45AMYPrOQ0tykvpFG7kkJYlhRtZMmGxw9MaGjehYjluZNOIyqRxM7teSGEf5UqRWU0jq4ZBQR0rVNCV0obUlsSKP4LEAqWCFTIgcWYWLly9gS3+EdjoGw7Xvadx/HEBTtxPxd0sGZKrgIwPPIpUQImc92ls2z/F8OUBYadSAa93SlzLlONCihzJ5RQklTQqaQZylQqcWilo9WqeQy0lE3b+o3wZbmSRjEaOwBQNLmRpcDefx4MiDe4X8biex+FaHo/QVE4QzEJSFfCKoxCVQ+GcRI7oPBqPC+S4nkUKJ2JIOW5nM4jKkCMwSY6QNPLeLHwTVTiZrMLxOCX8EhXwilfgaDyD8+kMAhMpPClk8ayIRd4HWriDVYIUrm7oyn0GZAGk0noUlpQJ2c+tew+w2ycQ+06FY+2RIKw+dRfu517gdGwNLmbxwh19uwx4V85f/9RBY4Hhy0+fJwtwNI70YWmcEsvxII/Bm2IaqWWU0Lutk8uFjhWjUqCsnug4SjzJl+JmFgWfBEYYJSE7OyBVjdNkkIoYPYFBODFSPIun+XK8KZYLxRdRRiUVcsEdFJGAXUYhs4bF/XwGt7NoRKRT8EpgcUashE8iJ0xIkKB6No3DOQmH0FQex+MViMxUIFhMQVLFQFIlBy/crZ9n9F9D3BDLslAoFMjLy8PVm9GIiUtEWl4h7r1Nwc6gWwh8kQu/ZEaY7DuVpMCJDA0elShfAfg0mZkwdNoGX/8EDbwTOURkMghOk+Nerhxv3tNILJOimm4IhmSmhyxClZwRHkspp/C0kMbdXBqBiSyuZzLwT5ILjXXy2KsCSuhqFdYxDVWxmhPcmVA9c0Q+UAlDWulVMkElvZslxfUMGuFpNDwFYY1IzbwQvC9mcQiW8AgitUMKK7it23kMbmRSqKZYoWfwOdXzP6JeKhXqgrQsMqIFSGkK76urkVbNIqtOjeuZ5A4m6iyFm0UcEivY2M9agC59DBbvvVOCc6kcHuWTISkZnhXKkFBBI6mMFrQbkl6yKoUgIcsUSsEtkf5tXi2DYikt3C0F9QoklVGCmEb8bkNq+vtGEZryvAopZfVIqpALAZWMKZ5NISmrEgEpavgmqXBCrEaghIN3ohrBKSxCUoh+JBMa+EnlMig5ksv/8zv/I0IjSKMBwzCQ1tejqKxKKC6JbE6kjsI6BQrrGWGkRlKjwNsyBoUUT+acIhp/X+HPor/I90nt0xIyxynH8yIZEkvlguwrKaeEqQXSTCEVrUJN2o0NGg/5t0E+5oTpBs0vI4h/FuKrlSriv2m8LCFjiTLB7wf8EphJQ8cnSYFTYhaXMpUIFhNllkF0NoOUchkK61ihuuaFhf7Xo1QqhSpZzrDCxiOpbyXVkJURvSm+VIZSGYvsDzRYDVAqYzY1NuyfpfkY1z13npUBVYxayOfTq+VCSzG9WopKmkVJPQ0py0KmVAgl/9/f2H/3wd+BF6YfSurIzqdwp5CFv5hCYBIlxCHiyu7nyBCRIcfLIhpplQziiimUUywKauWQsgwoZUP/4N8FuQtU5LNCjXKKFiTwtCqyMeXIqKYgriDDxgqUUgoo1SqVlGGMGhv2T/PDT51nHLueytdzAK1kkF1HMiAlxJVyQffPryXSAoMaRiEsQoN7+RzUwqhiOdVQJRN5wieWxkWJAoFJNM4kkolqRqgF8mqVSK/6xfWpGrIw0iFrOH5dnP17IOehFSykcgo51TKU1DOIL6WEkcqMKrJJZaiiGUhVxGXxTwB8mvzciO/MZ62NktQQLYhD9ge50H16W0IhtYpB7HsiosmFgFpYKxMyjk9ptCtJbq1WQ1JOZkdpnJPUIiRVjoAUBXxIBpXCICSRwaVUkikpkFbFQMlxDQ39P6BBEidDXg3ukP8dJfbPImRSGo0wvUfuuJwaOcQVFHJqWaEAJD2LnBoahXUN8U6mUBHXa9fYoJ/DoC3HQoXv278tkQrpXYSEwq0cChHpUoSJKUHsuplRj2qaXBxpGPxeoCWP8YKbIDHkRRGF1yW0MIBLOlfH31HwSlIJ3wPwT1QhMI1BcAqDuzkUUioYKJUkq/lzEOMTo0sZpXC+91IalIKcl8QsEq/IpvqjRWm4o8hzy6UMKmQ04ooooaB7USRFQnlDqkw6e2RRiuoZVFOkuANqZLJL/7JvvrRo8b1tVPSj6pslwP0cGsdiaUHPOZFEip+GEv94PElTpXicL0O5VA65UiVkMw2LwQnFmpJXI++DFIkVFG5kShEiJvUFjaMJKmGeh2g2p1I4hKYpcTyWfE2JpJ+UMLRbJvuo//w+DUJIw3NISksWoEJG2pQKpJdLhQCdXkUhq1KKMhn5LgKJYUp8oFlQSjUUag6MQvlLp06N0npaaCrFFFF4lk8LkxxhqXI8KaBwOV2KF4X1gs8Xl8uFhhPJCgmsWpWh0VCkH/Cvo13btlM3hL6ovFJBvqtFviZEphx4XM3mcZk021M5+CQyCBazCE6QIq6cpKtSlFEsSomffN9wy4YkSXElg8ahWBank1XCuAqZYAuVEDmCxfEEJULSGBxLINmNHA9yZQ0GUvzRbm3ELzOotTTpJ7NILa+HpJLC26J64T1JD+JqOoVXxWREhsa9HCli38txK0uKR/kMojLlOCeWIzyDgV8Cg4BkBQJTVTgWr8YZMYtTyeRbPDK8LGYRWyxFlZwFCc0aDZ8nlUo/X4b+R7Rq89Ok3RHP8h58AF6WAm9KeSRUchB/4PDiPY9bhQ1q49FYJc5KFAhOoBCVRSEig0JoqlzQao7GsILIRtxMeDrRgzhczNAgTEIqZTUOvWVxPYtBeJoMuTW0IH0wSkaYpP4cSIxh1UoU1DS4jtdFxF3KcT+PxqlEOc5LZAhMkcEnUYHAFAW8EhVCJy4oRSEIg9dy1YjO5/CqWI1npQ0zp3dy1TibqoBPEtGmWNwvUILcn+UU/YJhGOFPVv47MdzsE/7oeRGDfB7IooAcGSCu4hFbqcb9QjXOZwGnJbywW/yIdJCkxKEkDgFpHE4nqXAuQyN8DfVKFo8rOTxCJBz8k9UIIrJFsgyvi1k8LWRRTrMolrJCxqMSgunnLQJxTvUMKyQQadUK3Mtj8KCAgV8iLZyzwQVqEJYBRGRr8LyUR1wVj+x6HmW0BrUsD5laA0oF1Ch4lCuAdzXAhSIg8j1wLqmmPi6vfOcvf9z1P0LbcZPnrPCJuPv6elwhHVumwttK4HUV8PQ9cDkfuFQA+GcCgelAQAbgTb7/mwMEZTT8G5ILhGQBF3MAvzQgJBuIzOMRlc8jrQ6I/8DjgxooZ4BqFSAnRY1CAxKGaziA4kHEceH4s5DoQHZqWj2QKQMu5fCIKgROpAHBmcDFfOD2eyCuFsiSAdUk/W4UeUiFQfMgAwTMpcTSpD1RyXutVu3WaWyg/xStm3/fxsRq7hJX582H1y3Y4bdhsYev27ytvm6uHr5ujtt93eZsbTgcN3u7zdrs6+a40dPNfqOvm91Gb7dJbr5udm7ebhZrvN3sNx91myUcnm5rdh11W7r1sNv2g55um/d7um086O3mcdjbzW2Pp5vHYZ/NWw+f2Lj7iNf6g57eboc9vd18fX0bjhMnhOPE3zlOkv/n6+128oS32+aDnm7bD3u7zdl81M1161G3SeuOutm7eQrXNGurt3Dty3d5C+fd5enrdtjT183b29fNy89v/REvnxW79x2cMcFuGvkjfk1/hLWJJppoookmmmiiiSaaaKKJJppoookmmmiiiSaaaKKJJppoookm/v/G/wOzFQuTa1r+rQAAAABJRU5ErkJggg==';

const BASE_CSS = `
  /* Merged bar: the SoundCloud header IS the top bar (our window controls overlay
     its right side), so no separate titlebar strip to reserve room for. */
  html { padding-top: 0 !important; box-sizing: border-box !important; }

  /* Ambient blurred song-cover background (toggle in palette) */
  #sc-bg {
    position: fixed; inset: -80px; z-index: -2; display: none;
    background-size: cover; background-position: center;
    /* brightness was 0.5, which crushed the art to near-black once the scrim
       below was layered on top — the cover has to actually read as the page.
       blur was 100px, which is past the point where an image is "blurred" and
       into a flat colour field: no shape of the artwork survived it. 52px keeps
       it soft but you can still tell what you're looking at — same reasoning as
       the custom-background rule below. */
    filter: blur(52px) saturate(1.5) brightness(var(--sc-bg-bright, 0.66)); transform: scale(1.18);
    transition: background-image .7s ease, opacity .5s ease; pointer-events: none;
  }
  html.sc-coverbg #sc-bg { display: block; }
  /* custom image/GIF background: lighter blur so it's actually visible */
  html.sc-custombg #sc-bg { filter: blur(16px) brightness(0.55) saturate(1.15) !important; transform: scale(1.1) !important; }
  html.sc-coverbg, html.sc-coverbg body { background: transparent !important; }
  html.sc-coverbg .l-container, html.sc-coverbg #content, html.sc-coverbg .l-content,
  html.sc-coverbg .stream, html.sc-coverbg .l-listen-wrapper, html.sc-coverbg .l-about,
  html.sc-coverbg [class*="l-container"] { background-color: transparent !important; }
  /* soft scrim so text stays readable over the art */
  html.sc-coverbg body::before {
    content: ''; position: fixed; inset: 0; z-index: -1; pointer-events: none;
    /* radial vignette fades the cover-bg into dark at the edges (cleaner) */
    /* Kept deliberately light. setBgBrightness() already normalises the wash to a
       constant level, so a heavy scrim here just cancels it out — that is what
       kept the page reading black however much brightness was added. */
    background:
      radial-gradient(140% 100% at 50% 30%, rgba(10,10,12,0) 48%, rgba(10,10,12,0.34) 100%),
      linear-gradient(180deg, rgba(10,10,12,0.10), rgba(10,10,12,0.26));
  }
  /* ...but only once. Frames from SoundCloud's new app (Home, the new track page)
     get our classes mirrored in, so they drew this scrim AGAIN over the page's
     own: a darker rectangle exactly the size of the frame. */
  html.hoq-webi.sc-coverbg body::before { content: none !important; display: none !important; }
  /* Frosted translucent bars so the top + bottom blend with the cover bg.
     (Titlebar is a transparent overlay merged into the header now — keep it
     see-through; the header itself carries the frosted bg below.) */
  html.sc-coverbg #sc-titlebar { background: transparent !important; border: 0 !important; }
  html.sc-coverbg .header, html.sc-coverbg .l-fixed-top {
    background: rgba(12,12,14,0.32) !important;
    backdrop-filter: blur(20px) saturate(1.3) !important;
  }
  /* The bar's blur lives on a layer BEHIND its contents, not on the bar itself:
     a backdrop-filter on the bar makes it a "backdrop root", so nothing inside
     it (the Next up panel) could blur the page; the queue just showed through. */
  html.sc-coverbg .playControls {
    background: transparent !important;
    backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
    border-top: 1px solid rgba(255,255,255,0.06) !important;
  }
  html.sc-coverbg .playControls::after {
    content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none;
    visibility: visible;   /* the bar itself is visibility:hidden (only its inner shows) */
    background: rgba(12,12,14,0.5);
    backdrop-filter: blur(24px) saturate(1.4); -webkit-backdrop-filter: blur(24px) saturate(1.4);
  }
  html.sc-coverbg .playControls::before,
  html.sc-coverbg .playControls__inner,
  html.sc-coverbg .playControls__bg { background: transparent !important; }
  /* Panels that sit on the page itself (library sidebar, the hoq tab's cards,
     rows and stats) don't re-blur what's behind them: it's already the blurred
     cover, so a second blur adds nothing you can see, and on some GPUs WebView2
     draws it in tiles with a hard line across the panel. Bars and pop-ups that
     float over moving content (header, player, menus) keep their blur. */
  /* Everything inside the page area, so it covers panels SoundCloud adds later
     too (library tabs, search filters, profile sidebars...). Exceptions float
     over moving content and keep their blur: the sticky profile bar, play
     buttons on artwork, menus and dialogs. */
  html.sc-coverbg #content :not(.dropbar):not(.dropbar__content):not(.playButton):not([role="dialog"]):not([role="menu"]):not(.dropdownMenu):not([class*="odal"]):not([class*="opover"]):not(.conversation__stickyHeader),
  html.sc-coverbg .l-nav .collectionNav.g-tabs,
  html.sc-coverbg #hoq-discord .hoq-dc-card *:not([id$="-modal"]):not(.hoq-pop) {
    backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
  }

  /* ===== Scrollbar =====
     Hide EVERY native scrollbar (no reserved gutter on the window edge — that was
     the "thing off to the side"). A custom overlay bar (#hoq-scroll, built in JS)
     floats OVER the content on the right, invisible until you scroll or move to
     the edge, colored in the playing song's accent gradient. */
  * { scrollbar-width: none !important; }
  ::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }
  #hoq-scroll {
    position: fixed !important; top: 56px !important; right: 3px !important; bottom: 8px !important;
    width: 12px !important; z-index: 2147483000 !important; pointer-events: none !important;
    opacity: 0 !important; transition: opacity .25s ease !important;
  }
  #hoq-scroll.show { opacity: 1 !important; }
  #hoq-scroll-thumb {
    position: absolute !important; left: 3px !important; width: 6px !important; top: 0 !important;
    border-radius: 6px !important; cursor: grab !important; pointer-events: auto !important;
    background: linear-gradient(180deg, var(--sc-accent,#ff5500),
                color-mix(in srgb, var(--sc-accent,#ff5500) 55%, #000)) !important;
    box-shadow: 0 0 9px color-mix(in srgb, var(--sc-accent,#ff5500) 55%, transparent) !important;
    transition: width .12s ease, left .12s ease !important;
  }
  #hoq-scroll:not(.show) #hoq-scroll-thumb { pointer-events: none !important; }
  #hoq-scroll:hover #hoq-scroll-thumb, #hoq-scroll-thumb:active { width: 9px !important; left: 1px !important; }

  /* Never allow HORIZONTAL document scrolling. The hero's cover wash bleeds a few
     px past the viewport (blur + scale to feather its edges); clip it here at the
     document level so it can't ever produce a bottom scrollbar. Vertical scroll
     and the hero's soft look are unaffected. */
  html, body { overflow-x: hidden !important; max-width: 100% !important; }

  /* Kill GO MOBILE / get-the-app clutter */
  .mobileApps, .downloadButtons, .m-mobileApps, .mobileHeader,
  .sidebarModule.mobileApps, .smartBanner, .l-mobile-banner,
  a[href*="app-store"], a[href*="play.google"],
  a[href*="itunes.apple"], a[href*="apps.apple"] { display: none !important; }

  /* Kill legal / language footer */
  .footer, .l-footer, .footer__wrapper, .footer__links,
  .sidebarFooter, .footer-links, .footerNav, .footerLinks { display: none !important; }

  /* Auto-kill upsell / promo / cookie popups (the ones with an X) */
  .upsell, [class*="upsell"], .playlistUpsell, .g-branded-box .upsell,
  #onetrust-banner-sdk, #onetrust-consent-sdk, .cookiePolicy,
  .cookieBanner, .smartBanner__button, .interstitial,
  .modal--upsell, [data-testid*="upsell"] { display: none !important; }

  /* Custom touches */
  .sound__artwork .image, .image__full, .sc-artwork,
  .fullHero__artwork .image { border-radius: 10px !important; overflow: hidden !important; }

  /* ---- Accent recolor (driven by the palette) ---- */
  :root { accent-color: var(--sc-accent, #ff5500) !important; }

  /* MUI-based pages (Artist Studio, Insights, track table, checkout) drive all
     their "primary" color off --mui-palette-primary-main (SoundCloud orange).
     Repoint it at the accent so buttons, chips, tab indicators, meters, progress
     rings AND the insights chart bars/fills all recolor in one shot. */
  :root, html, [data-mui-color-scheme], .mui-theme-light, .mui-theme-dark {
    --mui-palette-primary-main: var(--sc-accent, #ff5500) !important;
    --mui-palette-primary-dark: color-mix(in srgb, var(--sc-accent, #ff5500) 78%, #000) !important;
    --mui-palette-primary-light: color-mix(in srgb, var(--sc-accent, #ff5500) 72%, #fff) !important;
    --mui-palette-primary-mainChannel: var(--sc-accent, #ff5500) !important;
    --mui-palette-Chip-defaultBorder: color-mix(in srgb, var(--sc-accent, #ff5500) 40%, transparent) !important;
    /* New MUI track page waveform: bars are one static tone (light=top, dark=bottom
       of each bar) with a cursor line in contrastText. Repoint all three so the
       whole waveform reads as an accent monochrome with vertical depth. */
    --mui-palette-contrast-light: color-mix(in srgb, var(--sc-accent, #ff5500) 88%, #fff) !important;
    --mui-palette-contrast-dark: color-mix(in srgb, var(--sc-accent, #ff5500) 44%, #000) !important;
    --mui-palette-contrast-contrastText: #ffffff !important;
  }
  /* MUI contained-primary buttons + primary chips: force accent fill (some inline
     styles win over the var, so back it with a direct rule at higher specificity). */
  .MuiButton-containedPrimary, .MuiChip-filledPrimary,
  button.MuiButton-containedPrimary, .MuiChip-colorPrimary.MuiChip-filled {
    background-color: var(--sc-accent, #ff5500) !important;
    background-image: none !important;
  }
  .MuiTabs-indicator { background-color: var(--sc-accent, #ff5500) !important; }
  /* New track page: selected tab label (Fans "Top"/"First") → accent. */
  .MuiTab-root.Mui-selected { color: var(--sc-accent, #ff5500) !important; }
  /* Comment-position slider + any primary slider (track fill + thumb) → accent. */
  .MuiSlider-colorPrimary .MuiSlider-track { background-color: var(--sc-accent, #ff5500) !important; border-color: var(--sc-accent, #ff5500) !important; }
  .MuiSlider-colorPrimary .MuiSlider-thumb { color: var(--sc-accent, #ff5500) !important; }
  /* Track-page timestamp "jump to" chips: accent tint on hover instead of grey. */
  .MuiChip-clickable.MuiChip-colorSecondary:hover {
    background-color: color-mix(in srgb, var(--sc-accent, #ff5500) 26%, transparent) !important;
    color: var(--sc-accent, #ff5500) !important;
  }
  /* Related-track / playlist title links: accent on hover. */
  a.MuiLink-underlineNone.MuiTypography-h4:hover { color: var(--sc-accent, #ff5500) !important; }

  /* Promo / upsell banners ("Go everywhere: Distribute Now" etc.) → match the app:
     recolor the hard-coded #F50 orange star to the accent, frost the bar, accent link. */
  .banner__UiEvoIcon path[fill="#F50"], .banner__UiEvoIcon path[fill="#f50"] {
    fill: var(--sc-accent, #ff5500) !important;
  }
  .banner.m-promotion, .banner.primary, .banner.m-promotion.primary {
    background: rgba(20,20,24,0.5) !important; background-image: none !important;
    border: 1px solid color-mix(in srgb, var(--sc-accent, #ff5500) 30%, rgba(255,255,255,0.09)) !important;
    border-radius: 10px !important;
    backdrop-filter: blur(16px) saturate(1.3); -webkit-backdrop-filter: blur(16px) saturate(1.3);
  }
  .banner a, .targetedProUpsellBanner__link {
    color: var(--sc-accent, #ff5500) !important; font-weight: 600;
  }

  /* Upload / track-edit tag input tokens (the "Pop" pills) → accent tint. */
  .tagInput__token, .tokenInput__token {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 24%, transparent) !important;
    border: 1px solid color-mix(in srgb, var(--sc-accent, #ff5500) 42%, transparent) !important;
    color: #fff !important;
  }
  .tagInput__input, .tokenInput__input { color: #fff !important; }
  /* Auto-tagger suggestion panel: kill SC's opaque light box, use our frosted glass. */
  .autoTagger__content, .autoTagger {
    background: rgba(255,255,255,0.05) !important;
    background-image: none !important;
    border: 1px solid rgba(255,255,255,0.08) !important;
    border-radius: 12px !important;
  }
  .autoTagger__title { color: #fff !important; }
  .sc-button-cta, .sc-button-primary, .sc-classic .sc-button-cta,
  .g-branded-box .sc-button-cta, button.sc-button-cta,
  .sc-button-small.sc-button-cta, .sc-button-medium.sc-button-cta,
  .sc-button-small.sc-button-primary, .followButton.sc-button-cta {
    background: var(--sc-accent-bg, #ff5500) !important;
    border-color: transparent !important;
    color: #fff !important;
  }
  /* Blue text/links -> accent (gradient-aware via background-clip:text) */
  a.sc-link-primary, .sc-link-primary,
  .trackItem__trackTitle, .audibleTile__title a, .playableTile__mainHeading a,
  .userBadge__usernameLink, a.sc-text-primary, .sc-text-primary,
  .sectionNav__link.active, .g-link-primary, a.g-link-primary {
    background: var(--sc-accent-bg, #ff5500) !important;
    -webkit-background-clip: text !important;
    background-clip: text !important;
    -webkit-text-fill-color: transparent !important;
    color: var(--sc-accent, #ff5500) !important;
  }
  /* The big track-page title: solid WHITE with an accent glow, and NO dark box
     behind it/the uploader (SoundCloud paints one for contrast over artwork). */
  .fullListenHero .soundTitle *, .fullHero .soundTitle *,
  .soundTitle__title, .soundTitle__title *, .fullHero__title, .fullHero__title *,
  .soundTitle__usernameHeroLink, .soundTitle__secondary {
    background: none !important; background-color: transparent !important; box-shadow: none !important;
  }
  .soundTitle__title, .soundTitle__title a, .soundTitle__title span, .fullHero__title {
    color: #fff !important; -webkit-text-fill-color: #fff !important;
    -webkit-background-clip: border-box !important; background-clip: border-box !important;
  }
  /* Kill SoundCloud's heavy .g-dark-txt-shadow (the dark halo that reads as a
     black box on the light cover) and replace with a clean accent glow. */
  .g-dark-txt-shadow, .fullHero__title, .fullHero__title *,
  .soundTitle, .soundTitle *, .sc-link-dark,
  .soundTitle__usernameTitleContainer, .soundTitle__usernameTitleContainer *,
  .soundTitle__username, .soundTitle__secondary {
    text-shadow: 0 0 12px color-mix(in srgb, var(--sc-accent, #ff5500) 50%, transparent),
                 0 1px 4px rgba(0,0,0,0.5) !important;
    background: none !important; background-color: transparent !important; box-shadow: none !important;
  }
  /* nuke any pseudo-element box behind the title AND the artist/username */
  .fullHero__title::before, .fullHero__title::after,
  .soundTitle::before, .soundTitle::after,
  .soundTitle *::before, .soundTitle *::after {
    content: none !important; display: none !important; background: none !important;
  }

  /* ===== Custom hero play button — gradient accent, rounded, glow ===== */
  .fullHero .sc-button-play, .fullListenHero .sc-button-play, .sound__header .sc-button-play,
  .l-listen-hero .sc-button-play {
    background: linear-gradient(145deg, var(--sc-accent, #ff5500),
                color-mix(in srgb, var(--sc-accent, #ff5500) 65%, #000)) !important;
    border: 0 !important; border-radius: 16px !important;
    box-shadow: 0 10px 26px color-mix(in srgb, var(--sc-accent, #ff5500) 50%, transparent),
                inset 0 1px 0 rgba(255,255,255,0.35) !important;
    transition: transform .15s ease, box-shadow .2s ease !important;
  }
  .fullHero .sc-button-play:hover, .fullListenHero .sc-button-play:hover,
  .sound__header .sc-button-play:hover, .l-listen-hero .sc-button-play:hover {
    transform: scale(1.07) !important;
    box-shadow: 0 14px 34px color-mix(in srgb, var(--sc-accent, #ff5500) 65%, transparent),
                inset 0 1px 0 rgba(255,255,255,0.45) !important;
  }
  /* Sit the title/artist block up next to the play button (top-aligned) instead
     of dropping it to the row's vertical center when the title wraps 2+ lines.
     The play button + the title/username column are siblings inside
     .soundTitle__titleContainer — that's the flex row to align. */
  .soundTitle__titleContainer {
    align-items: flex-start !important;
  }
  .soundTitle__titleContainer .soundTitle__usernameTitleContainer {
    margin-top: 0 !important;
  }
  /* Play buttons: SOLID accent by default (e.g. the track-page play button) */
  .sc-button-play, .sc-button.sc-button-play, .playButton {
    background-color: var(--sc-accent, #ff5500) !important;
    background-image: none !important;
    border-color: transparent !important;
    color: #fff !important;
    transition: background-color .15s ease !important;
  }
  /* ...but TRANSLUCENT only when overlaid on a song cover, so art shows through */
  .sound__artwork .sc-button-play, .audibleTile__artwork .sc-button-play,
  .sound__coverArt .sc-button-play, .fullListenHero__artwork .sc-button-play,
  .listenArtworkWall .sc-button-play, .fullHero__artwork .sc-button-play,
  .playableTile__artwork .sc-button-play, .playableTile__actions .sc-button-play {
    background-color: color-mix(in srgb, var(--sc-accent, #ff5500) 55%, transparent) !important;
    backdrop-filter: blur(2px) !important;
  }
  .sound__artwork .sc-button-play:hover, .audibleTile__artwork .sc-button-play:hover,
  .sound__coverArt .sc-button-play:hover, .fullListenHero__artwork .sc-button-play:hover,
  .playableTile__artwork .sc-button-play:hover {
    background-color: color-mix(in srgb, var(--sc-accent, #ff5500) 80%, transparent) !important;
  }
  /* Header buttons (Upload / Create account): SOLID accent, compact + centered */
  .header .sc-button-cta, a.uploadButton, a[href="/upload"] {
    background: var(--sc-accent-bg, #ff5500) !important;
    background-color: var(--sc-accent, #ff5500) !important;
    border-color: transparent !important;
    color: #fff !important;
    border-radius: 7px !important;
    height: 30px !important;
    padding: 0 16px !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    align-self: center !important;
    flex: 0 0 auto !important;
    width: auto !important;
    min-width: 0 !important;
    max-width: max-content !important;
    margin: 0 4px !important;
    line-height: 1 !important;
    font-size: 13px !important;
    font-weight: 700 !important;
  }

  /* Keep the header nav inline so the Discord tab sits next to Library */
  .header__navMenu, .header__nav, ul.header__navMenu, .header nav > ul {
    display: flex !important; flex-wrap: nowrap !important; white-space: nowrap !important;
  }
  .hoq-dc-tab { display: inline-flex !important; align-items: center !important; white-space: nowrap !important; cursor: pointer !important; }
  .hoq-dc-tab.hoq-active { color: #fff !important; font-weight: 700 !important; box-shadow: inset 0 -2px 0 #fff !important; }
  /* Something new in Social/Settings -> Changes: a dot on the way in, until opened */
  html.hoq-chg-new .hoq-dc-tab:not(.hoq-active) { position: relative !important; }
  html.hoq-chg-new .hoq-dc-tab:not(.hoq-active)::before {
    content: '' !important; position: absolute !important; top: 50% !important; right: -11px !important;
    width: 7px !important; height: 7px !important; margin-top: -9px !important; border-radius: 50% !important;
    background: var(--sc-accent, #ff5500) !important; box-shadow: 0 0 8px color-mix(in srgb, var(--sc-accent, #ff5500) 70%, transparent) !important;
    pointer-events: none !important;
  }

  /* Cleaner header that matches the titlebar tone (frosted variant in cover-bg) */
  .header {
    top: 0 !important; /* merged: header is the top bar (window controls overlay it) */
    background: linear-gradient(180deg, #0f0f11 0%, #0b0b0d 100%) !important;
    border-bottom: 1px solid rgba(255,255,255,0.05) !important;
    box-shadow: none !important;
  }
  /* Reserve space on the header's right for our overlaid window controls
     (skip / settings / traffic lights) so SC's usernav never sits under them. */
  .header .header__inner { padding-right: 158px !important; }
  /* Replace SoundCloud's corner logo with the holdonquietly logo + name.
     .header__logo holds two links (icon-only + wordmark); keep icon-only as the
     clickable home link, hide the wordmark, and rebuild it as our brand. */
  .header__logo .header__logoLink-wordmark { display: none !important; }
  .header__logo .header__logoLink-iconOnly svg { display: none !important; }
  .header__logo {
    display: inline-flex !important; align-items: center !important; height: 46px !important;
    padding-left: 6px !important;
  }
  .header__logo .header__logoLink-iconOnly {
    display: inline-flex !important; align-items: center !important; height: 100% !important;
    width: auto !important; text-decoration: none !important;
  }
  .header__logo .header__logoLink-iconOnly::before {
    content: '' !important; flex: none !important; width: 30px !important; height: 30px !important;
    background: url("${HOQ_LOGO}") center/contain no-repeat !important;
    filter: drop-shadow(0 0 4px rgba(90,160,255,0.3)) !important;
  }
  /* Nav labels, renamed the same way. Scoped by data-menu-name so the injected
     Social/Settings tab (no such attribute) is left alone. */
  .header__navMenuItem[data-menu-name="home"],
  .header__navMenuItem[data-menu-name="stream"],
  .header__navMenuItem[data-menu-name="library"] { font-size: 0 !important; }
  .header__navMenuItem[data-menu-name]::after {
    font-size: 14px !important; font-weight: inherit !important; letter-spacing: normal !important;
  }
  .header__navMenuItem[data-menu-name="home"]::after { content: 'Discover' !important; }
  .header__navMenuItem[data-menu-name="stream"]::after { content: 'Stream' !important; }
  .header__navMenuItem[data-menu-name="library"]::after { content: 'Collection' !important; }

  /* SoundCloud's "new items" dot is always its brand orange, and recolorOrange
     only reaches it after the 800ms debounce — long enough to see it flash.
     It's unambiguously an accent dot, so paint it statically from frame one. */
  .newItemBadge { background-color: var(--sc-accent, #ff5500) !important; }

  /* Upsells: hidden for good rather than left in the row to flash on load. */
  .header__upsellWrapper, .header__fanUpsell, .creatorSubscriptionsButton,
  .header__forArtistsButton { display: none !important; }

  /* Vertically center the Upload button with the rest of the header row */
  .header__inner, .header__soundInput, .header__soundInput.left {
    display: flex !important; align-items: center !important;
  }
  a.uploadButton {
    align-self: center !important;
    margin: auto 18px auto 4px !important; /* extra right gap so it isn't crammed against the pfp */
    box-shadow: 0 0 12px color-mix(in srgb, var(--sc-accent, #ff5500) 45%, transparent) !important;
    transition: box-shadow .18s ease, filter .18s ease !important;
  }
  a.uploadButton:hover { box-shadow: 0 0 18px var(--sc-accent, #ff5500) !important; }
  /* Signed out, SoundCloud wraps Upload in a plain block (.header__upload) so it
     sat at the top of the row, and its label is "secondary" grey text on the
     accent. Center the wrapper; label solid white. */
  .header__upload { display: flex !important; align-items: center !important; align-self: stretch !important; }
  a.uploadButton .uploadButton__title { color: #fff !important; -webkit-text-fill-color: #fff !important; background: none !important; }

  /* Header avatar + icon buttons: subtle accent glow so they don't look plain */
  .header__userNav img, .userNavButton__avatar, .userBadge__image .sc-artwork {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--sc-accent, #ff5500) 55%, transparent),
                0 0 10px color-mix(in srgb, var(--sc-accent, #ff5500) 32%, transparent) !important;
    border-radius: 50% !important;
  }
  .header a[title*="notification" i], .header a[title*="message" i],
  .header .sc-button-icon, .header__userNav .sc-button {
    transition: filter .18s ease, color .18s ease !important;
  }
  .header a[title*="notification" i]:hover, .header a[title*="message" i]:hover,
  .header .sc-button-icon:hover, .header__userNav .sc-button:hover {
    filter: drop-shadow(0 0 6px var(--sc-accent, #ff5500)) !important;
    color: var(--sc-accent, #ff5500) !important;
  }
  /* Search bar to match the app: ONE clean box, compact height */
  .headerSearch, .header__soundInput .headerSearch, .header form.headerSearch {
    background: rgba(255,255,255,0.05) !important;
    border: 1px solid rgba(255,255,255,0.08) !important;
    border-radius: 8px !important; box-shadow: none !important; overflow: hidden !important;
    height: 34px !important; display: flex !important; align-items: center !important;
  }
  .headerSearch__input, .header__soundInput input, .header form input,
  input.headerSearch__input {
    background: transparent !important; border: 0 !important; height: 32px !important;
    box-shadow: none !important; outline: none !important; color: #e4e4e6 !important;
    font-size: 14px !important;
  }
  .headerSearch__input::placeholder, .header__soundInput input::placeholder { color: #8a8a8c !important; }
  .headerSearch:focus-within {
    border-color: var(--sc-accent, #ff5500) !important; background: rgba(255,255,255,0.07) !important;
  }
  .headerSearch__icon, .headerSearch svg { color: #9a9a9c !important; fill: #9a9a9c !important; }
  /* center the magnifier icon/button vertically in the compact bar */
  .headerSearch__icon, .headerSearch button, .headerSearch__submit,
  .headerSearch [type="submit"], .headerSearch a {
    display: flex !important; align-items: center !important; justify-content: center !important;
    height: 32px !important; top: auto !important; margin: 0 !important;
  }

  /* Kill embedded-module + ad iframes (Artist Tools, ad networks).
     NOTE: do NOT block velvetcake/banner — that's the profile header banner. */
  iframe[src*="credit-tracker"],
  iframe[src*="adtrafficquality"], iframe[src*="googlesyndication"],
  iframe[src*="doubleclick"], iframe[src*="/promoted"] { display: none !important; }
  /* Seek bar → animated audio-style visualizer (canvas overlay in .hoq-viz).
     Hide SoundCloud's plain line + handle but keep the wrapper fully clickable
     for seeking; the flowing waveform + playhead are drawn on our canvas. */
  .playbackTimeline__progressBackground,
  .playbackTimeline__progressBar,
  .playControls__progress .sc-slider-progress,
  .sc-slider-progress, .sc-slider-orange .sc-slider-progress,
  .sc-slider-background {
    background: transparent !important;
  }
  .playbackTimeline__progressWrapper, .playControls__progress {
    position: relative !important; overflow: visible !important;
  }
  .playbackTimeline__progressHandle { opacity: 0 !important; } /* invisible but still draggable */
  .hoq-viz {
    position: absolute !important; left: 0 !important; right: 0 !important;
    top: 50% !important; transform: translateY(-50%) !important;
    width: 100% !important; height: 34px !important;
    pointer-events: none !important; z-index: 6 !important;
  }
  /* Visualizer OFF (palette "Song visualizer bar" toggle) → restore SC's plain
     seek bar: dim track, accent played portion, visible handle. */
  html.hoq-noviz .hoq-viz { display: none !important; }
  html.hoq-noviz .playbackTimeline__progressBackground,
  html.hoq-noviz .sc-slider-background { background: rgba(255,255,255,0.14) !important; }
  html.hoq-noviz .playbackTimeline__progressBar,
  html.hoq-noviz .playControls__progress .sc-slider-progress,
  html.hoq-noviz .sc-slider-progress,
  html.hoq-noviz .sc-slider-orange .sc-slider-progress { background: var(--sc-accent-bg, #ff5500) !important; }
  html.hoq-noviz .playbackTimeline__progressHandle { opacity: 1 !important; }

  /* ===== Optional-effect toggles (palette → Effects) ===== */
  /* Speaker glow pulse OFF */
  html.hoq-no-pulse .volume__button, html.hoq-no-pulse .volume > button,
  html.hoq-no-pulse .volume .sc-ico-volume, html.hoq-no-pulse .volume .volumeIcon { animation: none !important; }
  /* Rounded corners OFF → square artwork */
  html.hoq-no-round .image, html.hoq-no-round .sc-artwork, html.hoq-no-round .image__full,
  html.hoq-no-round .fullHero__artwork, html.hoq-no-round .playableTile__image .image,
  html.hoq-no-round .soundBadge__artwork .image { border-radius: 0 !important; }
  /* Row hover highlight OFF */
  html.hoq-no-hover .soundList__item:hover, html.hoq-no-hover .trackList__item:hover,
  html.hoq-no-hover .compactTrackList__item:hover { background: transparent !important; }
  /* Frosted bars OFF → solid */
  html.hoq-no-frost.sc-coverbg .header, html.hoq-no-frost.sc-coverbg .l-fixed-top,
  html.hoq-no-frost.sc-coverbg .playControls, html.hoq-no-frost .dropdownMenu,
  html.hoq-no-frost .linkMenu, html.hoq-no-frost #sc-palette {
    backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
  }
  /* UI animations OFF → reduce motion */
  html.hoq-no-anim *, html.hoq-no-anim *::before, html.hoq-no-anim *::after {
    animation: none !important; transition: none !important;
  }
  /* Accent glow OFF → drop the halos/glows on the prominent elements */
  html.hoq-no-glow .sc-button-like.sc-button-selected,
  html.hoq-no-glow .volume__button, html.hoq-no-glow .volume > button { filter: none !important; }
  html.hoq-no-glow .fullHero__title, html.hoq-no-glow .soundTitle__title,
  html.hoq-no-glow .mixedSelectionModule__titleText, html.hoq-no-glow .lazyLoadingList__header,
  html.hoq-no-glow .sectionHead__title { text-shadow: none !important; }
  /* Grayscale covers ON (opt-in) */
  html.hoq-gray .image span, html.hoq-gray .sc-artwork, html.hoq-gray .sound__coverArt span,
  html.hoq-gray .fullHero__artwork span, html.hoq-gray .playableTile__image span { filter: grayscale(1) !important; }

  /* Ambient glow ON (opt-in): a soft bloom of the current track's accent light,
     screen-blended over the UI, drifting up from the player + bottom corners. */
  #hoq-ambient { position: fixed; inset: 0; z-index: 9998; pointer-events: none; opacity: 0;
    transition: opacity .6s ease; mix-blend-mode: screen; }
  html.hoq-ambient #hoq-ambient { opacity: 1; }
  #hoq-ambient::before, #hoq-ambient::after { content: ''; position: absolute; inset: -15%; }
  #hoq-ambient::before {
    background:
      radial-gradient(30% 34% at 8% 104%,  color-mix(in srgb, var(--sc-accent,#ff5500) 85%, transparent), transparent 66%),
      radial-gradient(34% 38% at 92% 104%, color-mix(in srgb, var(--sc-accent,#ff5500) 70%, transparent), transparent 68%),
      radial-gradient(46% 40% at 50% 116%, color-mix(in srgb, var(--sc-accent,#ff5500) 62%, transparent), transparent 70%);
    filter: blur(50px) saturate(1.4); animation: hoqAmb 15s ease-in-out infinite alternate;
  }
  #hoq-ambient::after {
    background:
      radial-gradient(40% 34% at 10% -8%, color-mix(in srgb, var(--sc-accent,#ff5500) 34%, transparent), transparent 66%),
      radial-gradient(40% 34% at 90% -8%, color-mix(in srgb, var(--sc-accent,#ff5500) 30%, transparent), transparent 66%);
    filter: blur(60px); animation: hoqAmb2 21s ease-in-out infinite alternate;
  }
  html.hoq-no-anim #hoq-ambient::before, html.hoq-no-anim #hoq-ambient::after { animation: none !important; }
  @keyframes hoqAmb  { from { transform: translateY(0) scale(1); } to { transform: translateY(-3%) scale(1.06); } }
  @keyframes hoqAmb2 { from { transform: translate(0,0); }        to { transform: translate(3%,2%); } }

  /* ===== Ambient mode — a big now-playing view (Spotify-ish), toggled from the
     player bar. Sits above the content but leaves the real player bar visible at
     the bottom, and mirrors the current track (art/title/artist/progress) with
     controls wired to the real transport buttons. ===== */
  #hoq-np { position: fixed; inset: 0; z-index: 9990; display: none; overflow: hidden;
    color: #fff; background: #0b0b0e; }
  #hoq-np.on { display: flex; align-items: center; justify-content: center; gap: 64px; }
  /* ambient mode has its own transport (prev/play/next/like/seek), so the real
     player bar is redundant while it's open — hide it. Keep it in layout
     (opacity, NOT display:none) and behind the overlay so the ambient seek can
     still read the real timeline's geometry to scrub. */
  html.hoq-np-open .playControls { opacity: 0 !important; pointer-events: none !important; z-index: 1 !important; }
  /* ===== "Next up" queue panel =====
     The queue's buttons (play/like/more/Clear) read as DEAD — clicks fell right
     through. Root cause: .playControls / .playControls__inner carry
     overflow-x:clip (to hide the bar's h-scroll), which clips the queue's
     HIT-TEST region down to the 49px bar. The panel still PAINTS above the bar
     (it's a composited transform layer), so it looked fine but nothing above the
     bar's height was clickable. While the queue is open, un-clip the bar so the
     panel is hit-testable, lift it above the page, and drop the overlapping
     right sidebar out of hit-testing for good measure. Plus give the flat black
     panel the app's frosted-glass look (it had none). */
  html.hoq-queue-open .playControls,
  html.hoq-queue-open .playControls__inner,
  html:has(.queue.m-visible) .playControls,
  html:has(.queue.m-visible) .playControls__inner { overflow: visible !important; }
  html.hoq-queue-open .playControls,
  html:has(.queue.m-visible) .playControls { z-index: 100000 !important; }
  html.hoq-queue-open .l-sidebar-right,
  html:has(.queue.m-visible) .l-sidebar-right { pointer-events: none !important; }
  /* match the app's own dark-frosted panels (header / dropdowns): a translucent
     dark ground with the same backdrop blur — no shimmer, no glass. */
  /* acrylic: a dark tint over a heavy, saturated blur. The old 50% tint let a
     light page wash it out to flat grey; this keeps it dark but picks up the
     page's colour. */
  .playControls__queue {
    background: linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0) 140px), rgba(14,14,19,0.74) !important;
    border: 1px solid rgba(255,255,255,0.10) !important; border-radius: 14px 14px 0 0 !important; overflow: hidden !important;
    box-shadow: 0 -12px 48px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.06) !important;
    backdrop-filter: blur(34px) saturate(1.8) brightness(0.85) !important;
    -webkit-backdrop-filter: blur(34px) saturate(1.8) brightness(0.85) !important; }
  /* theme the panel chrome to the accent so it matches the rest of the app */
  .playControls__queue .queue__title { color: #fff !important; }
  .playControls__queue .queueItemView.m-playing .queueItemView__title a,
  .playControls__queue .queueItemView.m-active .queueItemView__title a { color: var(--sc-accent, #ff5500) !important; }
  .playControls__queue .queue__clear:hover { color: var(--sc-accent, #ff5500) !important; }
  .playControls__queue .queue,
  .playControls__queue .queue__panel,
  .playControls__queue .queue__scrollable,
  .playControls__queue .queue__scrollableInner,
  .playControls__queue .queue__itemsHeight,
  .playControls__queue .queueFallback { background: transparent !important; }
  /* --- Next up, redone: compact header, clean rows (title over artist, the
     "From related tracks…" line dropped), actions on hover in place of the
     duration, played rows faded, the playing row tinted. Rows must stay 56px:
     SoundCloud positions them in 56px steps. --- */
  .playControls__queue .queue__panel { display: flex !important; align-items: center !important; gap: 6px !important;
    padding: 14px 12px 10px 18px !important; border: 0 !important; }
  .playControls__queue .queue__title { flex: 1 1 auto !important; margin: 0 !important; padding: 0 !important; float: none !important;
    font: 600 15px/1.2 Inter,-apple-system,Arial,sans-serif !important; letter-spacing: 0 !important; }
  .playControls__queue .queue__clear, .playControls__queue .queue__hide { float: none !important; margin: 0 !important; box-shadow: none !important;
    border: 0 !important; background: transparent !important; color: #a6a6b0 !important; -webkit-text-fill-color: currentColor !important;
    transition: background .12s ease, color .12s ease !important; }
  .playControls__queue .queue__clear { height: 28px !important; padding: 0 10px !important; border-radius: 8px !important;
    font: 600 12.5px/28px Inter,-apple-system,Arial,sans-serif !important; }
  .playControls__queue .queue__hide { width: 28px !important; height: 28px !important; padding: 0 !important; border-radius: 50% !important;
    display: inline-flex !important; align-items: center !important; justify-content: center !important; }
  .playControls__queue .queue__hide svg { width: 13px !important; height: 13px !important; }
  .playControls__queue .queue__clear:hover, .playControls__queue .queue__hide:hover { background: rgba(255,255,255,0.08) !important; color: #fff !important; }
  .playControls__queue .queue__itemsHeight { padding: 0 8px !important; background-image: none !important; }
  /* every row sits in a wrapper SoundCloud paints solid (#fff / grey in the dark
     theme): that was the flat grey behind the rows */
  .playControls__queue .queue__itemWrapper { background: transparent !important; background-color: transparent !important; }
  .playControls__queue .queueItemView { height: 56px !important; box-sizing: border-box !important; display: flex !important; align-items: center !important;
    gap: 10px !important; margin: 0 !important; padding: 0 8px 0 4px !important; border: 0 !important; border-radius: 10px !important;
    background: transparent !important; transition: background .12s ease, opacity .12s ease !important; }
  .playControls__queue .queueItemView:hover { background: rgba(255,255,255,0.06) !important; }
  .playControls__queue .queueItemView.m-dimmed { opacity: .45 !important; }
  .playControls__queue .queueItemView.m-dimmed:hover { opacity: 1 !important; }
  .playControls__queue .queueItemView.m-active, .playControls__queue .queueItemView.m-playing {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 14%, transparent) !important;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sc-accent, #ff5500) 26%, transparent) !important; opacity: 1 !important; }
  .playControls__queue .queueItemView__dragHandle { flex: 0 0 14px !important; width: 14px !important; margin: 0 !important; color: #8e8e99 !important;
    opacity: 0 !important; cursor: grab !important; transition: opacity .12s ease !important; }
  .playControls__queue .queueItemView:hover .queueItemView__dragHandle { opacity: .7 !important; }
  .playControls__queue .queueItemView__dragHandle svg { width: 14px !important; height: 14px !important; display: block !important; }
  .playControls__queue .queueItemView__artwork { flex: 0 0 40px !important; position: relative !important; width: 40px !important; height: 40px !important; }
  .playControls__queue .queueItemView__artworkImage { width: 40px !important; height: 40px !important; margin: 0 !important; border-radius: 6px !important; overflow: hidden !important; }
  .playControls__queue .queueItemView__artworkImage::after { display: none !important; }
  .playControls__queue .queueItemView__artworkImage .sc-artwork { width: 40px !important; height: 40px !important; border-radius: 6px !important; }
  .playControls__queue .queueItemView__playButton { position: absolute !important; inset: 0 !important; display: flex !important; align-items: center !important;
    justify-content: center !important; border-radius: 6px !important; background: rgba(0,0,0,0.5) !important; opacity: 0 !important; transition: opacity .12s ease !important; }
  .playControls__queue .queueItemView:hover .queueItemView__playButton { opacity: 1 !important; }
  .playControls__queue .queueItemView__playButton .sc-button { width: 100% !important; height: 100% !important; margin: 0 !important; padding: 0 !important;
    border: 0 !important; background: none !important; box-shadow: none !important; color: #fff !important; align-items: center !important; justify-content: center !important; }
  .playControls__queue .queueItemView__playButton .sc-button > div { width: 100% !important; height: 100% !important; margin: 0 !important;
    display: flex !important; align-items: center !important; justify-content: center !important; }
  .playControls__queue .queueItemView__playButton svg { display: block !important; width: 16px !important; height: 16px !important; margin: 0 !important; }
  .playControls__queue .queueItemView__details { flex: 1 1 auto !important; min-width: 0 !important; display: flex !important; flex-direction: column-reverse !important;
    justify-content: center !important; gap: 2px !important; margin: 0 !important; }
  .playControls__queue .queueItemView__title, .playControls__queue .queueItemView__meta { min-width: 0 !important; margin: 0 !important; line-height: 1.25 !important; }
  .playControls__queue .queueItemView__title a { font: 600 13px/1.25 Inter,-apple-system,Arial,sans-serif !important; color: #ececf1 !important;
    background: none !important; -webkit-background-clip: border-box !important; background-clip: border-box !important; -webkit-text-fill-color: currentColor !important; }
  .playControls__queue .queueItemView.m-active .queueItemView__title a, .playControls__queue .queueItemView.m-playing .queueItemView__title a {
    color: color-mix(in srgb, var(--sc-accent, #ff5500) 55%, #fff) !important; }
  .playControls__queue .queueItemView__meta { display: flex !important; overflow: hidden !important; }
  .playControls__queue .queueItemView__username { font: 500 11.5px/1.25 Inter,-apple-system,Arial,sans-serif !important; color: #8e8e99 !important;
    -webkit-text-fill-color: currentColor !important; background: none !important; max-width: 100% !important; }
  .playControls__queue .queueItemView__username:hover { color: #fff !important; }
  .playControls__queue .queueItemView__context { display: none !important; }
  .playControls__queue .queueItemView__duration { flex: none !important; min-width: 30px !important; margin: 0 !important; text-align: right !important;
    font: 500 11px Inter,-apple-system,Arial,sans-serif !important; color: #7d7d88 !important; font-variant-numeric: tabular-nums !important; }
  .playControls__queue .queueItemView__actions { display: none !important; flex: none !important; align-items: center !important; gap: 0 !important; margin: 0 !important; }
  .playControls__queue .queueItemView:hover .queueItemView__actions { display: flex !important; }
  .playControls__queue .queueItemView:hover .queueItemView__duration { display: none !important; }
  .playControls__queue .queueItemView__actions .sc-button { width: 28px !important; height: 28px !important; min-width: 0 !important; margin: 0 !important; padding: 0 !important;
    border: 0 !important; border-radius: 50% !important; background: transparent !important; box-shadow: none !important; color: #a6a6b0 !important;
    display: inline-flex !important; align-items: center !important; justify-content: center !important; }
  .playControls__queue .queueItemView__actions .sc-button:hover { background: rgba(255,255,255,0.09) !important; color: #fff !important; }
  .playControls__queue .queueItemView__actions .sc-button svg { width: 14px !important; height: 14px !important; }
  .playControls__queue .queueItemView__like.sc-button-selected { color: var(--sc-accent, #ff5500) !important; }
  /* autoplay station card + scrollbar */
  .playControls__queue .queueFallback { margin: 6px 8px !important; padding: 12px 12px 12px 14px !important; box-sizing: border-box !important;
    border-radius: 12px !important; border: 1px solid rgba(255,255,255,0.07) !important; background: rgba(255,255,255,0.035) !important; }
  .playControls__queue .queueFallback__stationMode { display: flex !important; align-items: center !important; gap: 12px !important; padding: 0 !important; }
  .playControls__queue .queueFallback__text { flex: 1 1 auto !important; min-width: 0 !important; }
  .playControls__queue .queueFallback__heading { margin: 0 0 2px !important; font: 600 13px/1.3 Inter,-apple-system,Arial,sans-serif !important; color: #ececf1 !important; }
  .playControls__queue .queueFallback__subheading { font: 400 11.5px/1.35 Inter,-apple-system,Arial,sans-serif !important; color: #8e8e99 !important; }
  .playControls__queue .queueFallback .sc-toggle.sc-toggle-on { background-color: var(--sc-accent, #ff5500) !important; border-color: transparent !important; }
  .playControls__queue .g-scrollbar { width: 4px !important; right: 3px !important; border-radius: 99px !important; background: rgba(255,255,255,0.22) !important; }
  html.hoq-no-frost .playControls__queue {
    background: rgba(14,14,18,0.97) !important;
    backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
  #hoq-np .np-bg { position: absolute; inset: -10%; background-size: cover; background-position: center;
    filter: blur(72px) saturate(1.7) brightness(.72); transform: scale(1.15); }
  #hoq-np .np-scrim { position: absolute; inset: 0;
    background:
      /* even edge vignette for depth (keeps particles from washing out at the
         borders) + a soft accent bloom rising from the bottom */
      radial-gradient(125% 105% at 50% 48%, transparent 42%, rgba(8,8,11,.5) 100%),
      radial-gradient(50% 55% at 50% 120%, color-mix(in srgb, var(--sc-accent,#ff5500) 34%, transparent), transparent 70%); }
  #hoq-np .np-art { position: relative; width: 380px; height: 380px; border-radius: 20px;
    background-size: cover; background-position: center; background-color: rgba(255,255,255,.04);
    box-shadow: 0 40px 90px rgba(0,0,0,.55),
      0 0 90px color-mix(in srgb, var(--sc-accent,#ff5500) 45%, transparent),
      0 0 0 1px rgba(255,255,255,.1); }
  #hoq-np .np-side { position: relative; width: 460px; max-width: 46vw; }
  #hoq-np .np-eyebrow { font-size: 12px; letter-spacing: .22em; font-weight: 700; text-transform: uppercase;
    color: var(--sc-accent, #ff5500); margin: 0 0 14px; opacity: .95; }
  #hoq-np .np-title { font-size: 40px; font-weight: 800; line-height: 1.12; letter-spacing: -.01em;
    margin: 0 0 10px; }
  #hoq-np .np-artist { font-size: 18px; opacity: .72; margin: 0 0 30px; }
  #hoq-np .np-bar { height: 7px; border-radius: 4px; background: rgba(255,255,255,.16); overflow: hidden; cursor: pointer; }
  #hoq-np .np-bar i { display: block; height: 100%; background: var(--sc-accent, #ff5500); width: 0%;
    box-shadow: 0 0 12px color-mix(in srgb, var(--sc-accent,#ff5500) 70%, transparent); }
  #hoq-np .np-times { display: flex; justify-content: space-between; font-size: 12px; opacity: .7; margin-top: 8px; }
  #hoq-np .np-ctrls { display: flex; align-items: center; gap: 26px; margin-top: 30px; }
  #hoq-np .np-ctrls button { background: none; border: 0; color: #fff; cursor: pointer; opacity: .85; padding: 0; display: flex; }
  #hoq-np .np-ctrls button:hover { opacity: 1; }
  #hoq-np .np-play { width: 62px; height: 62px; border-radius: 50%; background: #fff !important; color: #111 !important;
    align-items: center; justify-content: center; }
  #hoq-np .np-play svg { width: 26px; height: 26px; }
  #hoq-np .np-like { margin-left: 8px; }
  #hoq-np .np-like svg { width: 24px; height: 24px; }
  #hoq-np .np-close { position: absolute; top: 44px; left: 24px; width: 40px; height: 40px; border-radius: 50%;
    background: rgba(255,255,255,.1); border: 0; color: #fff; cursor: pointer; font-size: 20px; line-height: 40px; }
  #hoq-np .np-close:hover { background: rgba(255,255,255,.2); }
  /* trigger button in the player bar — matched to our Discord play/share buttons
     (and SoundCloud's own icon buttons): 26x26 box, 15px icon, secondary grey,
     accent on hover. */
  #hoq-ambient-btn { display: none; }
  .playbackSoundBadge__actions #hoq-ambient-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 30px; height: 30px; margin-left: 10px; padding: 0; background: none; border: 0;
    border-radius: 7px; cursor: pointer; color: #fff; flex: 0 0 auto;
    transition: color .15s ease, background .15s ease; }
  .playbackSoundBadge__actions #hoq-ambient-btn:hover { color: var(--sc-accent, #ff5500); background: rgba(255,255,255,0.09); }
  .playbackSoundBadge__actions #hoq-ambient-btn svg { width: 16px; height: 16px; flex: 0 0 auto; }

  /* ===== Mobile (the userscript build sets html.hoq-mobile — desktop never
     does, so these are phone-only) — adapt this session's features that the
     base mobile stylesheet predates: ambient mode, the feed, and the extra
     player-bar buttons. ===== */
  /* Ambient now-playing: the desktop 380px art + 460px text row overflows a
     390px phone. Stack it, shrink the art, centre the text. */
  html.hoq-mobile #hoq-np.on { flex-direction: column !important; gap: 22px !important; padding: 0 18px !important; }
  html.hoq-mobile #hoq-np .np-art { width: min(64vw, 260px) !important; height: min(64vw, 260px) !important; }
  html.hoq-mobile #hoq-np .np-side { width: 100% !important; max-width: 100% !important; text-align: center !important; }
  html.hoq-mobile #hoq-np .np-ctrls { justify-content: center !important; }
  html.hoq-mobile #hoq-np .np-title { font-size: 25px !important; }
  html.hoq-mobile #hoq-np .np-close { top: 16px !important; left: 16px !important; }
  html.hoq-mobile #hoq-np-gl { display: none !important; } /* skip the WebGL nebula on a phone GPU */
  html.hoq-mobile #hoq-np .np-bg { opacity: .32 !important; }
  /* Player bar: it was fit to Play+Share; the later Ambient button made three,
     which overflows 390px. Shrink all three so the whole set fits. */
  html.hoq-mobile .playbackSoundBadge__actions #hoq-ambient-btn,
  html.hoq-mobile .playbackSoundBadge__actions #hoq-playbtn,
  html.hoq-mobile .playbackSoundBadge__actions #hoq-share {
    width: 26px !important; height: 26px !important; margin-left: 0 !important; }
  html.hoq-mobile .playbackSoundBadge__actions #hoq-ambient-btn svg,
  html.hoq-mobile .playbackSoundBadge__actions #hoq-playbtn svg,
  html.hoq-mobile .playbackSoundBadge__actions #hoq-share svg { width: 15px !important; height: 15px !important; }
  /* Feed composer/list: keep it from overflowing at phone width. */
  html.hoq-mobile #hoq-discord .hoq-feed-crow { flex-wrap: wrap !important; row-gap: 6px !important; }
  html.hoq-mobile #hoq-discord .hoq-feed-post { margin-left: auto !important; }
  html.hoq-mobile #hoq-discord .hoq-feed-avatar { width: 34px !important; height: 34px !important; }
  html.hoq-mobile #hoq-discord .hoq-sub { flex-wrap: wrap !important; }
  /* hoq tab (Social/Feed/Settings) on a phone: the desktop grids are too wide.
     Stats 4-across -> 2x2; top artists/tracks 2-col -> stacked; and the settings
     toggles' 3-column override (a high-specificity rule the base mobile sheet
     can't reach) -> one per row. */
  html.hoq-mobile #hoq-discord .hoq-stat-row { grid-template-columns: 1fr 1fr !important; }
  html.hoq-mobile #hoq-discord .hoq-stat-cols { grid-template-columns: 1fr !important; }
  html.hoq-mobile #hoq-discord .hoq-settings-host #sc-palette .pal-grid { grid-template-columns: 1fr !important; }
  html.hoq-mobile #hoq-discord .hoq-settings-host #sc-palette > .row,
  html.hoq-mobile #hoq-discord .hoq-settings-host #sc-palette > .bgurl,
  html.hoq-mobile #hoq-discord .hoq-settings-host #sc-palette > .pal-note,
  html.hoq-mobile #hoq-discord .hoq-settings-host #sc-palette > .btn-2up { max-width: 100% !important; }
  /* the widened hoq card + activity/discord rows also need to fit 390px */
  html.hoq-mobile #hoq-discord .hoq-dc-card { max-width: 100% !important; padding: 16px 12px !important; }
  html.hoq-mobile #hoq-discord .hoq-dc-quick { flex-wrap: wrap !important; }

  /* Next-up queue on a phone: a full-height sheet opened from the phone player,
     styled in tools/mobile.css with the rest of the phone layout. */

  /* Search autocomplete: the input is full-width on mobile (above), so the
     dropdown has to be too — the desktop popup is a narrow fixed column that
     ran off the right edge. Pin it to both gutters and let width fill. */
  html.hoq-mobile .dropdownMenu:has(.searchAutocomplete),
  html.hoq-mobile .dropdownMenu:has(#searchMenuList) {
    left: 8px !important; right: 8px !important; width: auto !important;
    max-width: calc(100vw - 16px) !important;
  }

  /* Profile dropbar: content is laid out for a wide window. Trim the gutters
     and let the name/title wrap instead of forcing a wide single line. */
  html.hoq-mobile .dropbar__content { padding-left: 12px !important; padding-right: 12px !important; }
  html.hoq-mobile .userDropbar__title,
  html.hoq-mobile .userDropbar__usernameLink {
    white-space: normal !important; overflow-wrap: anywhere !important;
  }

  #hoq-np .np-art { transition: transform .14s ease; }
  html.hoq-no-anim #hoq-np .np-art { transition: none !important; }
  /* WebGL 3D backdrop (Three.js): a rotating accent crystal + starfield behind
     the card. Sits at the back; the cover wash dims when it's live. */
  /* Backdrop layers sit at NEGATIVE z so the card + text are normal-flow content
     above them WITHOUT a stacking context of their own — that's what lets the
     text's blend mode reach the nebula behind it. */
  #hoq-np-gl { position: absolute; inset: 0; z-index: -3; }
  #hoq-np .np-bg { z-index: -2; }
  html.hoq-np-gl #hoq-np .np-bg { opacity: .16 !important; }
  #hoq-np .np-scrim { z-index: -1; }
  #hoq-np .np-art, #hoq-np .np-side, #hoq-np .np-close { position: relative; }
  /* Text legibility over the busy nebula: solid white with a layered dark halo
     (a tight shadow for edge contrast + a wide soft one to lift it off bright
     particles). Reads cleanly on any part of the backdrop — no muddy blend.
     isolation still keeps our layers self-contained. */
  #hoq-np { isolation: isolate; }
  #hoq-np .np-title, #hoq-np .np-artist, #hoq-np .np-times {
    color: #fff !important; -webkit-text-fill-color: #fff !important; opacity: 1 !important;
    text-shadow: 0 1px 2px rgba(0,0,0,.72), 0 4px 26px rgba(0,0,0,.6); }
  #hoq-np .np-eyebrow { text-shadow: 0 1px 10px rgba(0,0,0,.55); }
  #hoq-np .np-artist { opacity: .82 !important; }

  a.sc-link-primary, .sc-link-primary:hover { color: var(--sc-accent, #ff5500) !important; }

  /* Waveform is a <canvas> (orange played + grey unplayed). Hue-rotate just the
     canvas so orange shifts to the accent while grey stays grey. Comment
     avatars are separate <img>s, so they're untouched. Default = 0deg (orange). */
  /* ===== Our own waveform: bars we fully control, overlaid on SC's canvas
     (which we hide but keep beneath for click-to-seek + comments). ===== */
  .waveform.hoq-cw > *:not(.hoq-wave) { opacity: 0 !important; }
  .hoq-wave { position: absolute; inset: 0; z-index: 6; pointer-events: none; perspective: 700px; }
  .hoq-wave .bars {
    position: absolute; inset: 0; display: flex; align-items: center; gap: 2px; box-sizing: border-box;
    /* the waveform's OWN 3D: bars stand up on a plane tilted away from you */
    transform: rotateX(28deg); transform-origin: center 76%;
  }
  .hoq-wave .bars i {
    flex: 1 1 0; min-width: 0; border-radius: 3px; align-self: center;
    transition: transform .12s ease; transform-origin: center; /* smooth cursor-wave */
    /* glossy cylinder shading so each bar reads as a 3D rod */
    box-shadow:
      inset 1.5px 0 1px rgba(255,255,255,0.30),
      inset -1.5px 0 1px rgba(0,0,0,0.30),
      inset 0 2px 0 rgba(255,255,255,0.38),
      0 2px 4px rgba(0,0,0,0.45);
  }
  .hoq-wave .bars.un i { background: rgba(255,255,255,0.26); }
  .hoq-wave .bars.pl i {
    background: var(--wave-color, var(--sc-accent, #ff5500));
    box-shadow: inset 1.5px 0 1px rgba(255,255,255,0.30), inset -1.5px 0 1px rgba(0,0,0,0.28),
                inset 0 2px 0 rgba(255,255,255,0.4), 0 0 3px color-mix(in srgb, var(--wave-color, var(--sc-accent,#ff5500)) 60%, transparent);
  }
  .hoq-wave .bars.pl { clip-path: inset(0 calc(100% - var(--wave-prog, 0%)) 0 0); }

  /* ===== Track page hero: fade into the app bg instead of the grey box ===== */
  .fullHero, .fullListenHero, .l-listen-hero, .listenHero, .sound__header,
  .fullHero__foreground, .fullHero__overlay, .listenHero__inner,
  .l-listen-wrapper > .fullHero, .listenEngagement,
  .fullListenHero > div, .fullListenHero > div > div {
    background: transparent !important; box-shadow: none !important;
    border: 0 !important; border-radius: 0 !important;
    outline: 0 !important; overflow: visible !important;
  }
  /* the desaturated artwork gradient SoundCloud paints behind the hero */
  .fullHero__background, .listenHero__background, .fullHero__artworkBackground,
  .fullHero__gradient, .listenHero__gradient {
    display: none !important;
  }
  /* The cover-colored hero gradient (SoundCloud's .backgroundGradient) — fade its
     edges into the app so it's a clean blended wash instead of a hard-edged block. */
  .backgroundGradient {
    /* Fade to transparent WELL INSIDE the box on every side so no hard edge is
       left for the container to clip into a rounded-rect outline. */
    -webkit-mask-image: radial-gradient(78% 78% at 50% 30%, #000 0%, rgba(0,0,0,0.45) 46%, transparent 82%) !important;
    mask-image: radial-gradient(78% 78% at 50% 30%, #000 0%, rgba(0,0,0,0.45) 46%, transparent 82%) !important;
    opacity: 0.8 !important;
    filter: blur(38px) !important;         /* feather the edges so it blends in/out */
    transform: scale(1.1) !important;      /* hide the blur's own soft border */
    overflow: visible !important;          /* don't hard-clip the blurred wash */
    border-radius: 0 !important;
  }
  .backgroundGradient, .backgroundGradient__buffer, .backgroundGradient__imageOverlay {
    border-radius: 0 !important;
  }
  .backgroundGradient__imageOverlay { opacity: 0.5 !important; }
  /* drop the dark readability boxes behind the title / uploader / tags; keep a
     soft text-shadow so it stays legible against the app background */
  .fullHero__title, .fullHero__uploader, .soundTitle__title, .soundTitle__info,
  .soundTitle__usernameHeroLink, .fullHero .sc-tagList, .fullHero__tag,
  .soundTitle__additionalContainer, .sc-media-content .soundTitle__title {
    background: transparent !important; box-shadow: none !important;
    text-shadow: 0 1px 8px rgba(0,0,0,0.55) !important;
  }

  /* ===== Library "All / Created / Liked" filter dropdown (SoundCloud .select) ===== */
  .collectionSection__filterSelect .select__list,
  .select .select__list, ul.select__list, .select__menu,
  .commentsList__sortSelect .select__list, [class*="sortSelect" i] .select__list,
  .collectionSection__filterSelect [role="listbox"], .select [role="listbox"] {
    background: rgba(14,14,18,0.6) !important;
    border: 1px solid rgba(255,255,255,0.10) !important;
    border-radius: 12px !important;
    box-shadow: 0 16px 44px rgba(0,0,0,0.55) !important;
    backdrop-filter: blur(24px) saturate(1.4) !important;
    -webkit-backdrop-filter: blur(24px) saturate(1.4) !important;
    overflow: hidden !important; padding: 5px !important;
  }
  .select__list li, .select__option, .select__list a, .select__list button,
  .collectionSection__filterSelect [role="option"] {
    border-radius: 8px !important; color: #d4d4d7 !important;
    padding: 8px 11px !important; background: transparent !important; border: 0 !important;
  }
  .select__list li:hover, .select__option:hover, .select__list a:hover,
  .collectionSection__filterSelect [role="option"]:hover,
  .collectionSection__filterSelect [role="option"][aria-selected="true"] {
    background: var(--sc-accent, #ff5500) !important; color: #fff !important;
  }

  /* ---- Bottom player: color-only polish (NO layout changes) ---- */
  .playControls {
    background: linear-gradient(180deg, #181818 0%, #0b0b0b 100%) !important;
    border-top: 1px solid rgba(255,255,255,0.06) !important;
  }
  /* Never show a horizontal scrollbar on the bottom player bar. Use overflow-x:
     CLIP (not hidden) — hidden forces overflow-y to compute to auto, which was
     clipping the upward-opening volume popup. clip leaves overflow-y visible. */
  .playControls, .playControls__inner {
    overflow-x: clip !important;
    scrollbar-width: none !important;
    -ms-overflow-style: none !important;
  }
  .playControls::-webkit-scrollbar, .playControls__inner::-webkit-scrollbar {
    display: none !important; width: 0 !important; height: 0 !important;
  }
  /* Text carets match the theme accent (was SoundCloud orange). */
  input, textarea, .sc-input, .headerSearch__input { caret-color: var(--sc-accent, #ff5500) !important; }
  /* Player control buttons: transparent (no boxes) so they blend with the bar */
  .playControls button:not(.playControls__play):not(.sc-button-play),
  .playControls .sc-button:not(.playControls__play):not(.sc-button-play),
  .playbackSoundBadge button, .playbackSoundBadge .sc-button {
    background: transparent !important;
    background-color: transparent !important;
    box-shadow: none !important;
    border-color: transparent !important;
  }
  .playControls button:not(.playControls__play):hover,
  .playbackSoundBadge button:hover {
    background: rgba(255,255,255,0.08) !important;
  }
  /* Soft fade so page content melts into the bar instead of a hard edge */
  .playControls::before {
    content: '' !important;
    position: absolute !important;
    left: 0 !important; right: 0 !important; bottom: 100% !important;
    height: 44px !important;
    background: linear-gradient(to top, rgba(11,11,11,0.95) 0%, rgba(11,11,11,0) 100%) !important;
    pointer-events: none !important;
  }
  /* Play/pause: just tint it the accent + soft glow, keep SoundCloud's shape */
  .playControls__play {
    background-color: var(--sc-accent, #ff5500) !important;
    box-shadow: 0 0 10px -3px var(--sc-accent, #ff5500) !important;
  }
  /* Prev / next / shuffle / repeat: accent on hover/active (color only) */
  .playControls__prev:hover, .playControls__next:hover,
  .shuffleControl.m-shuffling, .repeatControl.m-one, .repeatControl.m-all {
    color: var(--sc-accent, #ff5500) !important;
  }
  /* Rounded now-playing artwork thumbnail */
  /* Now-playing title: the badge is content-sized, so the title link was pinned
     to ~136px inside a 328px badge and truncated titles that had room to spare.
     Let the badge take the slack in the bar and the title take the slack in the
     badge. */
  /* 430 is the balance point: the title roughly doubles its visible length while
     the timeline keeps enough width for the seek-bar visualiser to read. */
  .playControls__soundBadge { flex: 1 1 auto !important; max-width: 430px !important; min-width: 0 !important; }
  .playbackSoundBadge { min-width: 0 !important; }
  .playbackSoundBadge__titleContextContainer,
  .playbackSoundBadge__title { min-width: 0 !important; flex: 1 1 auto !important; }
  .playbackSoundBadge__titleLink { max-width: 100% !important; }
  /* Still too long? Slide it on hover instead of stopping at an ellipsis. The
     parent clips, the link itself slides — no DOM is touched, only styles, so
     React keeps ownership of the markup. Distance is measured into --hoq-mq. */
  .playbackSoundBadge__title { overflow: hidden !important; }
  .playbackSoundBadge:hover .playbackSoundBadge__titleLink.hoq-mq {
    width: max-content !important; max-width: none !important;
    text-overflow: clip !important; will-change: transform;
    animation: hoqMarquee var(--hoq-mq-dur, 8s) ease-in-out infinite alternate;
  }
  @keyframes hoqMarquee {
    0%, 12% { transform: translateX(0); }
    88%, 100% { transform: translateX(var(--hoq-mq, 0px)); }
  }
  html.hoq-no-anim .playbackSoundBadge__titleLink.hoq-mq { animation: none !important; }

  .playbackSoundBadge__avatar .image {
    border-radius: 6px !important; overflow: hidden !important;
  }
  /* Like/heart button turns accent when active */
  .playbackSoundBadge .sc-button-like.sc-button-selected {
    color: var(--sc-accent, #ff5500) !important;
  }

  /* ===== Spotify-style horizontal volume (0-100) ===== */
  .volume__sliderWrapper, .volume__sliderBackground, .volume__sliderProgress,
  .volume .sc-slider, .volume__sliderHandle { display: none !important; }
  .volume { display: flex !important; align-items: center !important; overflow: visible !important;
    width: auto !important; position: relative !important; }
  /* Colored + glowing speaker icon */
  .volume__button, .volume > button, .volume .sc-ico-volume, .volume .volumeIcon,
  .volume__button *, .volume .sc-ico-volume::before {
    color: var(--sc-accent, #ff5500) !important;
    fill: var(--sc-accent, #ff5500) !important;
  }
  .volume__button, .volume > button, .volume .sc-ico-volume, .volume .volumeIcon {
    filter: drop-shadow(0 0 5px color-mix(in srgb, var(--sc-accent, #ff5500) 60%, transparent)) !important;
    animation: hoqVolGlow 5.5s ease-in-out infinite !important;
    transition: filter .2s ease !important;
  }
  .volume:hover .volume__button, .volume:hover > button,
  .volume:hover .sc-ico-volume, .volume:hover .volumeIcon {
    filter: drop-shadow(0 0 10px var(--sc-accent, #ff5500)) !important;
    animation: none !important;
  }
  @keyframes hoqVolGlow {
    0%, 100% { filter: drop-shadow(0 0 4px color-mix(in srgb, var(--sc-accent, #ff5500) 45%, transparent)); }
    50%      { filter: drop-shadow(0 0 9px color-mix(in srgb, var(--sc-accent, #ff5500) 95%, transparent)); }
  }
  /* Slider + % sit inline in the player bar, ALWAYS visible (no popup to fight). */
  .hoq-vol-pop {
    position: static !important; transform: none !important;
    display: inline-flex !important; align-items: center; gap: 8px;
    background: transparent !important; border: 0 !important; box-shadow: none !important;
    backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
    padding: 0 2px 0 8px !important; white-space: nowrap;
    opacity: 1 !important; visibility: visible !important; pointer-events: auto !important;
    z-index: 2147483000;
  }
  .hoq-vol-pop::after, .hoq-vol-pop::before { display: none !important; content: none !important; }
  .hoq-vol {
    -webkit-appearance: none; appearance: none; width: 92px; height: 5px;
    border-radius: 999px; outline: none; cursor: pointer; margin: 0; padding: 0;
    vertical-align: middle;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.05);
  }
  .hoq-vol::-webkit-slider-thumb {
    -webkit-appearance: none; width: 13px; height: 13px; border-radius: 50%;
    background: #fff; cursor: pointer;
    box-shadow: 0 0 7px color-mix(in srgb, var(--sc-accent, #ff5500) 90%, transparent),
                0 0 2px rgba(0,0,0,0.45);
    transition: transform .1s ease, box-shadow .15s ease;
  }
  .hoq-vol:hover::-webkit-slider-thumb {
    transform: scale(1.18);
    box-shadow: 0 0 13px var(--sc-accent, #ff5500),
                0 0 4px color-mix(in srgb, var(--sc-accent, #ff5500) 70%, transparent),
                0 0 2px rgba(0,0,0,0.5);
  }
  /* Always-visible live volume % (updates as you drag/scroll, not on hover) */
  .hoq-vol-pct {
    display: inline-block; min-width: 32px; margin: 0 4px 0 2px;
    font-family: Inter, -apple-system, Arial, sans-serif;
    font-size: 11px; font-weight: 700; color: #c9c9cc; letter-spacing: .2px;
    font-variant-numeric: tabular-nums; text-align: left; vertical-align: middle;
    user-select: none; cursor: default;
  }

  /* =====================  CLEANER UI PASS  ===================== */
  /* Rounded artwork everywhere */
  .image, .sc-artwork, .audibleTile__artwork .image, .badgeList__item .image,
  .systemPlaylistBadge__artwork .image, .compactTrackList .image,
  .sound__coverArt .image, .trackItem__image .image {
    border-radius: 8px !important;
  }
  /* ===== Unique track tiles (rounded, framed, zoom-on-hover) ===== */
  .audibleTile, .badgeList__item, .systemPlaylistBadge, .sound__coverArt,
  .playableTile {
    transition: transform .18s ease !important;
  }
  .audibleTile__artwork, .playableTile__artwork, .sound__coverArt,
  .systemPlaylistBadge__artwork, .badgeList__item .image {
    border-radius: 14px !important; overflow: hidden !important; position: relative !important;
    box-shadow: 0 6px 18px rgba(0,0,0,0.4), inset 0 0 0 1px rgba(255,255,255,0.05) !important;
    transition: transform .2s ease, box-shadow .2s ease !important;
  }
  /* subtle accent sheen from the top corner */
  .audibleTile__artwork::after, .playableTile__artwork::after {
    content: '' !important; position: absolute !important; inset: 0 !important; pointer-events: none !important;
    background: linear-gradient(135deg, color-mix(in srgb, var(--sc-accent, #ff5500) 22%, transparent), transparent 45%) !important;
    opacity: 0 !important; transition: opacity .2s ease !important; border-radius: 14px !important;
  }
  .audibleTile:hover .audibleTile__artwork, .playableTile:hover .playableTile__artwork,
  .audibleTile:hover .sound__coverArt, .badgeList__item:hover .image {
    transform: translateY(-5px) !important;
    box-shadow: 0 14px 30px rgba(0,0,0,0.55), 0 0 0 2px var(--sc-accent, #ff5500),
                inset 0 0 0 1px rgba(255,255,255,0.08) !important;
  }
  .audibleTile:hover .audibleTile__artwork::after, .playableTile:hover .playableTile__artwork::after { opacity: 1 !important; }
  /* zoom the cover image inside its rounded frame on hover */
  .audibleTile__artwork .image, .playableTile__artwork .image, .sound__coverArt .image {
    transition: transform .35s ease !important;
  }
  .audibleTile:hover .image, .playableTile:hover .image, .sound__coverArt:hover .image {
    transform: scale(1.07) !important;
  }
  /* Consistent rounded buttons */
  .sc-button, .sc-button-small, .sc-button-medium, .sc-button-large {
    border-radius: 6px !important;
  }
  /* Track/list rows: rounded + subtle hover highlight */
  .soundList__item, .trackList__item, .searchList__item, .soundBadgeList__item {
    border-radius: 8px !important;
    transition: background .12s ease !important;
  }
  .soundList__item:hover, .trackList__item:hover, .searchList__item:hover {
    background: rgba(255,255,255,0.035) !important;
  }
  /* Cleaner section headers */
  .soundList__header, .lazyLoadingList__header, .sectionHead, .soundTitle__title,
  h2.soundTitle__title { letter-spacing: .2px !important; }
  /* Tame harsh borders / dividers */
  hr, .divider, .g-hr, .divider--default { opacity: .35 !important; border-color: rgba(255,255,255,0.08) !important; }
  .sound, .sound__body { border: 0 !important; }

  /* User-adjustable song-list zoom (density). Default 1 = normal. */
  .soundList, .trackList, .lazyLoadingList__list, .systemPlaylistTrackList,
  .soundBadgeList, .searchList__results, .stream__list {
    zoom: var(--sc-list-zoom, 1) !important;
  }

  /* SoundCloud's promo strip ("Keep flowing: Skip the ads... Go+") is an ad, and
     with Social/Settings open it showed through on top of that page. Promotions
     go everywhere; any other banner just steps aside while the tab is open. */
  .l-product-banners .banner.m-promotion { display: none !important; }
  /* Messages: the conversation's sticky top bar (name, Block, Report) shipped a
     solid #121212 slab; messages scroll under it, so it keeps a real blur. */
  html.sc-coverbg .conversation__stickyHeader {
    background: rgba(12,12,14,0.5) !important;
    backdrop-filter: blur(24px) saturate(1.4) !important; -webkit-backdrop-filter: blur(24px) saturate(1.4) !important;
    border-bottom: 1px solid rgba(255,255,255,0.06) !important; }
  html.sc-coverbg .conversation__stickyHeader .conversation__actions { background: transparent !important; }
  .conversationActions .sc-button { background: rgba(255,255,255,0.06) !important;
    border: 1px solid rgba(255,255,255,0.1) !important; color: #e4e4e8 !important; }
  .conversationActions .sc-button:hover { background: rgba(255,255,255,0.12) !important; }
  /* A full-screen page from the new SoundCloud app is open (see themeFrames):
     the classic page's header and player sit behind its see-through backdrop. */
  html.hoq-webi-full #app { opacity: 0 !important; pointer-events: none !important; }
  /* "Amplify track" = SoundCloud's paid promotion upsell on your latest upload */
  .latestUploadContainer__soundDetails__amplifyButton { display: none !important; }
  html.hoq-tab .l-product-banners { display: none !important; }

  /* ===== Library: convert horizontal tabs into a vertical SIDE TAB ===== */
  .l-collection:has(.collectionNav) {
    display: flex !important; align-items: flex-start !important; gap: 24px !important;
  }
  .l-collection:has(.collectionNav) .l-nav {
    flex: 0 0 172px !important; width: 172px !important; margin: 0 !important;
    position: sticky !important; top: ${66}px !important; float: none !important;
  }
  .l-collection:has(.collectionNav) .l-main {
    flex: 1 1 auto !important; min-width: 0 !important; margin: 0 !important;
  }
  /* ===== 3D lift on tab bars (profile tabs + library/collection nav) =====
     JS tilts the hovered tab toward the cursor; CSS gives it a lit accent lift.
     Gated by the "3D tab bars" toggle (html.hoq-no-tabtilt) and Low-end mode. */
  .userInfoBar__tabs .profileTabs { perspective: 900px; }
  .userInfoBar__tabs .g-tabs-link, .l-nav .collectionNav.g-tabs .g-tabs-link {
    transform-style: preserve-3d;
    transition: transform .16s cubic-bezier(.2,.7,.2,1), background .14s ease, color .14s ease, box-shadow .18s ease !important; }
  .userInfoBar__tabs .g-tabs-link.hoq-tt, .l-nav .collectionNav.g-tabs .g-tabs-link.hoq-tt {
    position: relative; z-index: 3;
    box-shadow: 0 14px 30px rgba(0,0,0,.5),
      0 0 22px color-mix(in srgb, var(--sc-accent,#ff5500) 34%, transparent) !important; }
  html.hoq-no-tabtilt .userInfoBar__tabs .g-tabs-link,
  html.hoq-no-tabtilt .l-nav .collectionNav.g-tabs .g-tabs-link { transform: none !important; }

  /* ===== Profile dropbar (sticky mini-header on scroll) → themed frost ===== */
  .dropbar.m-active, .dropbar__content {
    background: rgba(12,12,16,0.6) !important;
    border-bottom: 1px solid rgba(255,255,255,0.08) !important;
    box-shadow: 0 14px 34px rgba(0,0,0,0.45) !important;
    backdrop-filter: blur(24px) saturate(1.5) !important;
    -webkit-backdrop-filter: blur(24px) saturate(1.5) !important; }
  .userDropbar { border-bottom: 0 !important; }
  .userDropbar__title { color: #fff !important; letter-spacing: -.01em !important; }
  .userDropbar .sc-media-image .image {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--sc-accent,#ff5500) 55%, transparent) !important; }
  html.hoq-no-frost .dropbar.m-active, html.hoq-no-frost .dropbar__content {
    background: rgba(14,14,18,0.97) !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }

  /* ===== Low-end mode: strip GPU/CPU-heavy work ===== */
  html.hoq-lowend *, html.hoq-lowend *::before, html.hoq-lowend *::after {
    backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
    animation: none !important; }
  html.hoq-lowend #hoq-np .np-bg { filter: brightness(.55) !important; }
  html.hoq-lowend #hoq-np .np-scrim, html.hoq-lowend #hoq-ambient { display: none !important; }
  html.hoq-lowend .playControls__queue, html.hoq-lowend .collectionNav.g-tabs,
  html.hoq-lowend .dropbar.m-active, html.hoq-lowend .dropbar__content,
  html.hoq-lowend #sc-palette, html.hoq-lowend .dropdownMenu, html.hoq-lowend .linkMenu {
    background: rgba(16,16,20,0.98) !important; }

  /* toggle: scroll long titles (marquee) */
  html.hoq-no-mq .hoq-mq { animation: none !important; transform: none !important; }
  /* toggle: profile banner bottom fade */
  html.hoq-no-herofade .l-user-hero .profileHeaderBackground.m-visualLoaded {
    -webkit-mask-image: none !important; mask-image: none !important; }
  /* settings note line */
  #sc-palette .pal-note { font-size: 11px; color: #8a8a90; line-height: 1.35; margin: 2px 2px 6px; }

  /* ===== Library side nav: quiet list with icons (v1.6.2) =====
     One look for every state: muted text + icon, soft hover, accent-tinted pick.
     No glow, no 3D lift, no frosted box (the page is already the blurred cover). */
  .collectionNav.g-tabs, .l-nav .collectionNav.g-tabs {
    display: flex !important; flex-direction: column !important; align-items: stretch !important; gap: 2px !important;
    background: rgba(255,255,255,0.035) !important; border: 1px solid rgba(255,255,255,0.07) !important;
    border-radius: 14px !important; padding: 6px !important; overflow: visible !important; box-sizing: border-box !important;
    backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; perspective: none !important;
  }
  .collectionNav.g-tabs li, .collectionNav.g-tabs .g-tabs-item {
    display: block !important; width: 100% !important; max-width: 100% !important;
    margin: 0 !important; padding: 0 !important; border: 0 !important; box-sizing: border-box !important;
  }
  /* Overview on its own, then the rest */
  .collectionNav.g-tabs .networkTabs__library { padding-bottom: 6px !important; margin-bottom: 4px !important;
    border-bottom: 1px solid rgba(255,255,255,0.06) !important; }
  .collectionNav.g-tabs a::after, .collectionNav.g-tabs li::before, .collectionNav.g-tabs li::after,
  .collectionNav.g-tabs .active::after { display: none !important; content: none !important; }
  .collectionNav.g-tabs a, .collectionNav.g-tabs a.g-tabs-link {
    display: flex !important; align-items: center !important; gap: 11px !important;
    width: 100% !important; height: 36px !important; padding: 0 12px !important; margin: 0 !important;
    border: 0 !important; border-radius: 9px !important; box-sizing: border-box !important; text-align: left !important;
    color: #a6a6b0 !important; font-size: 13.5px !important; font-weight: 500 !important; letter-spacing: 0 !important;
    background: transparent !important; box-shadow: none !important; text-shadow: none !important; transform: none !important;
    transition: background .14s ease, color .14s ease !important;
  }
  .collectionNav.g-tabs a::before {
    content: '' !important; display: block !important; position: static !important; flex: 0 0 18px !important;
    width: 18px !important; height: 18px !important; border: 0 !important; background: currentColor !important; opacity: .75;
    -webkit-mask: var(--hoq-ni) center / 18px 18px no-repeat; mask: var(--hoq-ni) center / 18px 18px no-repeat;
    transition: opacity .14s ease, background .14s ease !important;
  }
  .collectionNav.g-tabs a:hover { background: rgba(255,255,255,0.06) !important; color: #f2f2f5 !important; box-shadow: none !important; }
  .collectionNav.g-tabs a:hover::before { opacity: 1; }
  .collectionNav.g-tabs .active a, .collectionNav.g-tabs a.active,
  .collectionNav.g-tabs li.active a, .collectionNav.g-tabs [aria-current] a, .collectionNav.g-tabs a[aria-current],
  html.hoq-no-glow .collectionNav.g-tabs .active a, html.hoq-no-glow .collectionNav.g-tabs a.active {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 16%, transparent) !important;
    color: color-mix(in srgb, var(--sc-accent, #ff5500) 55%, #ffffff) !important;
    font-weight: 600 !important; border: 0 !important; text-shadow: none !important;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sc-accent, #ff5500) 30%, transparent) !important;
  }
  .collectionNav.g-tabs a.active::before, .collectionNav.g-tabs .active a::before {
    background: var(--sc-accent, #ff5500) !important; opacity: 1; }
  .collectionNav.g-tabs .networkTabs__library a { --hoq-ni: url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27black%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Crect%20x%3D%273.5%27%20y%3D%273.5%27%20width%3D%277%27%20height%3D%277%27%20rx%3D%271.6%27%2F%3E%3Crect%20x%3D%2713.5%27%20y%3D%273.5%27%20width%3D%277%27%20height%3D%277%27%20rx%3D%271.6%27%2F%3E%3Crect%20x%3D%273.5%27%20y%3D%2713.5%27%20width%3D%277%27%20height%3D%277%27%20rx%3D%271.6%27%2F%3E%3Crect%20x%3D%2713.5%27%20y%3D%2713.5%27%20width%3D%277%27%20height%3D%277%27%20rx%3D%271.6%27%2F%3E%3C%2Fsvg%3E"); }
  .collectionNav.g-tabs .networkTabs__likes a { --hoq-ni: url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27black%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Cpath%20d%3D%27M12%2020s-7.5-4.6-7.5-10.2A4.3%204.3%200%200%201%2012%207.2a4.3%204.3%200%200%201%207.5%202.6C19.5%2015.4%2012%2020%2012%2020z%27%2F%3E%3C%2Fsvg%3E"); }
  .collectionNav.g-tabs .networkTabs__sets a { --hoq-ni: url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27black%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Cpath%20d%3D%27M4%206h11M4%2011h11M4%2016h7%27%2F%3E%3Ccircle%20cx%3D%2716.5%27%20cy%3D%2717%27%20r%3D%272.5%27%2F%3E%3Cpath%20d%3D%27M19%2017V8.5l2%20.8%27%2F%3E%3C%2Fsvg%3E"); }
  .collectionNav.g-tabs .networkTabs__albums a { --hoq-ni: url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27black%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Ccircle%20cx%3D%2712%27%20cy%3D%2712%27%20r%3D%278.5%27%2F%3E%3Ccircle%20cx%3D%2712%27%20cy%3D%2712%27%20r%3D%272.5%27%2F%3E%3C%2Fsvg%3E"); }
  .collectionNav.g-tabs .networkTabs__stations a { --hoq-ni: url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27black%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Ccircle%20cx%3D%2712%27%20cy%3D%2712%27%20r%3D%271.8%27%2F%3E%3Cpath%20d%3D%27M8.2%208.2a5.4%205.4%200%200%200%200%207.6M15.8%208.2a5.4%205.4%200%200%201%200%207.6M5.4%205.4a9.3%209.3%200%200%200%200%2013.2M18.6%205.4a9.3%209.3%200%200%201%200%2013.2%27%2F%3E%3C%2Fsvg%3E"); }
  .collectionNav.g-tabs .networkTabs__following a { --hoq-ni: url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27black%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Ccircle%20cx%3D%279%27%20cy%3D%278%27%20r%3D%273.5%27%2F%3E%3Cpath%20d%3D%27M2.5%2020a6.5%206.5%200%200%201%2013%200M16%204.6a3.5%203.5%200%200%201%200%206.8M18.2%2014.2A6.5%206.5%200%200%201%2021.5%2020%27%2F%3E%3C%2Fsvg%3E"); }
  .collectionNav.g-tabs .networkTabs__purchases a { --hoq-ni: url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27black%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Cpath%20d%3D%27M5%208h14l-1.2%2012H6.2z%27%2F%3E%3Cpath%20d%3D%27M9%208V6.5a3%203%200%200%201%206%200V8%27%2F%3E%3C%2Fsvg%3E"); }
  .collectionNav.g-tabs .networkTabs__history a { --hoq-ni: url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27black%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Ccircle%20cx%3D%2712%27%20cy%3D%2712%27%20r%3D%278.5%27%2F%3E%3Cpath%20d%3D%27M12%207.5V12l3%202%27%2F%3E%3C%2Fsvg%3E"); }
  html.hoq-lowend .collectionNav.g-tabs { background: rgba(16,16,20,0.98) !important; }

  /* ===== Library "Filter" input — themed field with accent focus glow ===== */
  .textfield__inputWrapper .textfield__input, .collectionSection .textfield__input {
    background: rgba(255,255,255,0.05) !important; border: 1px solid rgba(255,255,255,0.12) !important;
    border-radius: 9px !important; color: #e4e4e6 !important; box-shadow: none !important;
    transition: border-color .12s ease, box-shadow .12s ease !important;
  }
  .textfield__inputWrapper .textfield__input:focus {
    border-color: var(--sc-accent, #ff5500) !important;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--sc-accent, #ff5500) 22%, transparent),
                0 0 12px color-mix(in srgb, var(--sc-accent, #ff5500) 26%, transparent) !important;
  }
  .textfield__inputWrapper .textfield__input::placeholder { color: #8a8a8c !important; }
  .textfield__clear { color: #b7b7ba !important; }
  .textfield__clearContainer:hover .textfield__clear { color: var(--sc-accent, #ff5500) !important; }

  /* ===== Library "View" (Badges / List) toggle — accent selection with glow ===== */
  .listDisplayToggle__title { color: #8a8a8c !important; }
  .listDisplayToggle__options .sc-button {
    background: transparent !important; border: 1px solid rgba(255,255,255,0.10) !important;
    border-radius: 9px !important; color: #b7b7ba !important; box-shadow: none !important;
    transition: background .12s ease, border-color .12s ease, color .12s ease, box-shadow .12s ease !important;
  }
  .listDisplayToggle__options .sc-button:hover {
    background: rgba(255,255,255,0.06) !important; color: #fff !important;
  }
  .listDisplayToggle__options .sc-button.sc-button-selected {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 18%, transparent) !important;
    border-color: color-mix(in srgb, var(--sc-accent, #ff5500) 45%, transparent) !important;
    color: var(--sc-accent, #ff5500) !important;
    box-shadow: 0 0 12px color-mix(in srgb, var(--sc-accent, #ff5500) 32%, transparent) !important;
  }

  /* ===== Library "All / Created / Liked" filter BUTTON — acrylic glass ===== */
  .collectionSection__filterSelect .sc-button-dropdown {
    background: rgba(255,255,255,0.05) !important;
    border: 1px solid rgba(255,255,255,0.12) !important;
    border-radius: 10px !important; color: #d6d6db !important; box-shadow: none !important;
    backdrop-filter: blur(22px) saturate(1.4) !important;
    -webkit-backdrop-filter: blur(22px) saturate(1.4) !important;
    transition: background .15s ease, border-color .15s ease, box-shadow .15s ease, color .15s ease !important;
  }
  .collectionSection__filterSelect .sc-button-dropdown:hover {
    color: #fff !important;
    border-color: color-mix(in srgb, var(--sc-accent, #ff5500) 55%, transparent) !important;
    box-shadow: 0 0 15px color-mix(in srgb, var(--sc-accent, #ff5500) 30%, transparent) !important;
  }
  .collectionSection__filterSelect .sc-button-dropdown.sc-button-selected,
  .collectionSection__filterSelect .sc-button-dropdown[aria-expanded="true"] {
    color: var(--sc-accent, #ff5500) !important;
    border-color: color-mix(in srgb, var(--sc-accent, #ff5500) 50%, transparent) !important;
    box-shadow: 0 0 12px color-mix(in srgb, var(--sc-accent, #ff5500) 28%, transparent) !important;
  }
  .collectionSection__filterSelect .sc-button-dropdown svg { fill: currentColor !important; }

  /* ===== Profile page (userInfoBar) action buttons → acrylic ===== */
  .userInfoBar__buttons .sc-button {
    background: rgba(255,255,255,0.05) !important;
    border: 1px solid rgba(255,255,255,0.12) !important; border-radius: 10px !important;
    color: #d6d6db !important; box-shadow: none !important;
    backdrop-filter: blur(22px) saturate(1.4) !important; -webkit-backdrop-filter: blur(22px) saturate(1.4) !important;
    transition: background .15s ease, border-color .15s ease, box-shadow .15s ease, color .15s ease !important;
  }
  .userInfoBar__buttons .sc-button:hover {
    color: #fff !important;
    border-color: color-mix(in srgb, var(--sc-accent, #ff5500) 55%, transparent) !important;
    box-shadow: 0 0 14px color-mix(in srgb, var(--sc-accent, #ff5500) 30%, transparent) !important;
  }
  .userInfoBar__buttons .sc-button-cta, .userInfoBar__buttons .sc-button-insights {
    background: var(--sc-accent, #ff5500) !important; color: #fff !important; border-color: transparent !important;
    box-shadow: 0 0 14px color-mix(in srgb, var(--sc-accent, #ff5500) 40%, transparent) !important;
  }
  .userInfoBar__buttons .sc-button svg { fill: currentColor !important; }

  /* ===== Profile hero — bottom fade =====
     Full-bleed (width:100vw + negative margins) was destabilising some profiles:
     on open, their content column collapsed to 0 height (a SoundCloud layout
     timing bug the extra reflow tipped over). So keep the banner at its normal
     width and only fade its bottom. Everything is scoped to .m-visualLoaded so
     profiles with no banner — and the brief pre-load state — are left untouched. */
  .l-user-hero .profileHeaderBackground.m-visualLoaded {
    background-color: transparent !important;
    -webkit-mask-image: linear-gradient(180deg,#000 0%,#000 68%,transparent 100%) !important;
    mask-image: linear-gradient(180deg,#000 0%,#000 68%,transparent 100%) !important;
  }
  /* Cover the width — the visual defaults to auto 100%, leaving a small grey gap
     on the right otherwise. */
  .l-user-hero .profileHeaderBackground.m-visualLoaded .profileHeaderBackground__visual {
    background-size: cover !important; background-position: center !important;
  }

  /* ===== Profile tabs (All / Popular tracks / Tracks / …) — accent active + hover glow ===== */
  .profileTabs.g-tabs .g-tabs-link {
    color: #b7b7ba !important; border: 0 !important; box-shadow: none !important;
    transition: color .12s ease, box-shadow .12s ease, text-shadow .12s ease !important;
  }
  .profileTabs.g-tabs .g-tabs-item::after, .profileTabs.g-tabs .g-tabs-link::after { display: none !important; content: none !important; }
  .profileTabs.g-tabs .g-tabs-link:hover {
    color: #fff !important; text-shadow: 0 0 10px color-mix(in srgb, var(--sc-accent, #ff5500) 40%, transparent) !important;
  }
  .profileTabs.g-tabs .g-tabs-link.active {
    color: var(--sc-accent, #ff5500) !important;
    box-shadow: inset 0 -2px 0 var(--sc-accent, #ff5500) !important;
    text-shadow: 0 0 10px color-mix(in srgb, var(--sc-accent, #ff5500) 45%, transparent) !important;
  }

  /* ===== Edit Spotlight button group → theme ===== */
  .editSpotlight .sc-button {
    background: rgba(255,255,255,0.05) !important; border: 1px solid rgba(255,255,255,0.12) !important;
    border-radius: 9px !important; color: #d6d6db !important; box-shadow: none !important;
  }
  .editSpotlight .sc-button:hover {
    color: #fff !important; border-color: color-mix(in srgb, var(--sc-accent, #ff5500) 50%, transparent) !important;
  }
  .editSpotlight .sc-button-cta, .editSpotlight__saveButton {
    background: var(--sc-accent, #ff5500) !important; color: #fff !important; border-color: transparent !important;
  }

  /* ===== Search left panel (.l-fixed-left) → real acrylic side panel ===== */
  /* The outer .searchOptions + SC's scroll wrappers get sized to the full
     viewport by SC's JS — so keep them TRANSPARENT and let content flow, then
     put the acrylic box on the nav <ul> itself (it naturally wraps the 6 items). */
  .l-fixed-left .searchOptions,
  .l-fixed-left .searchOptions__scrollable,
  .l-fixed-left .searchOptions__scrollableInner,
  .l-fixed-left .searchOptions__container {
    background: transparent !important; border: 0 !important; box-shadow: none !important;
    backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
    padding: 0 !important; height: auto !important; max-height: none !important; overflow: visible !important;
  }
  .l-fixed-left .searchOptions__navigation {
    display: flex !important; flex-direction: column !important; gap: 2px !important; margin: 0 !important;
    background: rgba(255,255,255,0.035) !important; border: 1px solid rgba(255,255,255,0.07) !important;
    border-radius: 14px !important; padding: 6px !important; box-shadow: none !important;
    backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
  }
  /* "Search results for …" title bar — was a solid black block; make it see-through. */
  .l-search .l-fixed-top, .l-search .searchTitle, .l-search .searchTitle__text {
    background: transparent !important; background-color: transparent !important;
    box-shadow: none !important; border: 0 !important;
    backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
  }
  .l-search .searchTitle__text { text-shadow: 0 1px 8px rgba(0,0,0,0.55) !important; }

  /* Search filters: same quiet icon list as the Library nav (v1.6.15).
     "Everything" sits on its own above the type filters. */
  .searchOptions__navigationItem { display: block !important; width: 100% !important; max-width: none !important;
    margin: 0 !important; padding: 0 !important; border: 0 !important; box-sizing: border-box !important;
    border-radius: 9px !important; background: transparent !important; box-shadow: none !important; }
  .searchOptions__navigationItem.g-nav-item-search { padding-bottom: 6px !important; margin-bottom: 4px !important;
    border-bottom: 1px solid rgba(255,255,255,0.06) !important; border-radius: 0 !important; }
  .searchOptions__navigationItem .searchOptions__navigationLink {
    display: flex !important; align-items: center !important; gap: 11px !important; height: 36px !important;
    width: 100% !important; padding: 0 12px !important; border-radius: 9px !important; box-sizing: border-box !important;
    background: transparent !important; -webkit-background-clip: border-box !important; background-clip: border-box !important;
    -webkit-text-fill-color: currentColor !important;
    color: #a6a6b0 !important; font-size: 13.5px !important; font-weight: 500 !important; line-height: 1 !important;
    letter-spacing: 0 !important; text-decoration: none !important; white-space: nowrap !important;
    transition: background .14s ease, color .14s ease !important;
  }
  .searchOptions__navigationLink::before {
    content: ''; flex: 0 0 18px; width: 18px; height: 18px; background: currentColor; opacity: .75;
    -webkit-mask: var(--hoq-ni) center / 18px 18px no-repeat; mask: var(--hoq-ni) center / 18px 18px no-repeat;
    transition: opacity .14s ease, background .14s ease;
  }
  .searchOptions__navigationItem:hover .searchOptions__navigationLink { background: rgba(255,255,255,0.06) !important; color: #f2f2f5 !important; }
  .searchOptions__navigationItem:hover .searchOptions__navigationLink::before { opacity: 1; }
  .searchOptions__navigationItem.active .searchOptions__navigationLink {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 16%, transparent) !important;
    color: color-mix(in srgb, var(--sc-accent, #ff5500) 55%, #ffffff) !important; font-weight: 600 !important;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sc-accent, #ff5500) 30%, transparent) !important;
  }
  .searchOptions__navigationItem.active .searchOptions__navigationLink::before { background: var(--sc-accent, #ff5500); opacity: 1; }
  .searchOptions__navigationItem.g-nav-item-search { --hoq-ni: url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27black%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Ccircle%20cx%3D%2711%27%20cy%3D%2711%27%20r%3D%276.5%27%2F%3E%3Cpath%20d%3D%27M20%2020l-4.2-4.2%27%2F%3E%3C%2Fsvg%3E"); }
  .searchOptions__navigationItem.searchOptions__navigation-high_tier { --hoq-ni: url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27black%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Cpath%20d%3D%27M12%203.5l1.8%204.9%204.9%201.8-4.9%201.8L12%2016.9l-1.8-4.9-4.9-1.8%204.9-1.8z%27%2F%3E%3Cpath%20d%3D%27M18.5%2015.5l.7%201.8%201.8.7-1.8.7-.7%201.8-.7-1.8-1.8-.7%201.8-.7z%27%2F%3E%3C%2Fsvg%3E"); }
  .searchOptions__navigationItem.searchOptions__navigation-sounds { --hoq-ni: url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27black%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Cpath%20d%3D%27M4%2010v4M8%207v10M12%204v16M16%208v8M20%2011v2%27%2F%3E%3C%2Fsvg%3E"); }
  .searchOptions__navigationItem.searchOptions__navigation-people { --hoq-ni: url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27black%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Ccircle%20cx%3D%279%27%20cy%3D%278%27%20r%3D%273.5%27%2F%3E%3Cpath%20d%3D%27M2.5%2020a6.5%206.5%200%200%201%2013%200M16%204.6a3.5%203.5%200%200%201%200%206.8M18.2%2014.2A6.5%206.5%200%200%201%2021.5%2020%27%2F%3E%3C%2Fsvg%3E"); }
  .searchOptions__navigationItem.searchOptions__navigation-albums { --hoq-ni: url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27black%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Ccircle%20cx%3D%2712%27%20cy%3D%2712%27%20r%3D%278.5%27%2F%3E%3Ccircle%20cx%3D%2712%27%20cy%3D%2712%27%20r%3D%272.5%27%2F%3E%3C%2Fsvg%3E"); }
  .searchOptions__navigationItem.searchOptions__navigation-playlists { --hoq-ni: url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27black%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Cpath%20d%3D%27M4%206h11M4%2011h11M4%2016h7%27%2F%3E%3Ccircle%20cx%3D%2716.5%27%20cy%3D%2717%27%20r%3D%272.5%27%2F%3E%3Cpath%20d%3D%27M19%2017V8.5l2%20.8%27%2F%3E%3C%2Fsvg%3E"); }

  /* ===== Search suggestions dropdown → acrylic, see-through (was solid black) ===== */
  :has(> #searchMenuList), .headerSearch__autosuggests, .searchAutosuggests,
  .autosuggests, .header__search .autocomplete {
    background: rgba(12,12,16,0.5) !important;
    border: 1px solid rgba(255,255,255,0.10) !important; border-radius: 12px !important;
    box-shadow: 0 18px 52px rgba(0,0,0,0.55) !important;
    backdrop-filter: blur(24px) saturate(1.5) !important; -webkit-backdrop-filter: blur(24px) saturate(1.5) !important;
    overflow: hidden !important;
  }
  #searchMenuList, #searchMenuList li, #searchMenuList ul,
  #searchMenuList .lazyLoadingList__list, .autosuggests li,
  /* the newer combobox wraps the list in a SOLID rgb(18,18,18) .searchAutocomplete
     that hid our frosted glass — make it (and its list wrapper) see-through so the
     .dropdownMenu acrylic shows. */
  .dropdownMenu .searchAutocomplete, .dropdownMenu .lazyLoadingList,
  .dropdownMenu .lazyLoadingList__list,
  .dropdownMenu .combox-box-content, .dropdownMenu .searchMenu__searchFor {
    background: transparent !important;
    /* SC draws rgb(48,48,48) grey top/bottom borders + a box-shadow on these —
       those are the stray grey outlines. Remove them for a clean frosted panel. */
    border: 0 !important; box-shadow: none !important;
  }
  /* the auto-highlighted first row -> accent wash instead of SC's solid grey */
  .dropdownMenu .searchMenu__searchFor:hover,
  .dropdownMenu .searchMenu__searchFor.m-active,
  .dropdownMenu [aria-selected="true"] .searchMenu__searchFor {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 22%, transparent) !important;
    border-radius: 8px !important;
  }
  /* SoundCloud's newer "combobox" search list paints its rows with sc-link-primary
     (the RAW accent) on inner spans — unreadable when the accent is a dark colour.
     Force light, readable text across the whole list; reserve the accent for the
     row hover. Covers the "Search for …" item, query suggestions and user rows. */
  #searchMenuList a, #searchMenuList a *, #searchMenuList li, #searchMenuList span,
  #searchMenuList .sc-link-primary, #searchMenuList .searchMenu__searchForText {
    color: #e7e7ed !important; -webkit-text-fill-color: #e7e7ed !important;
  }
  #searchMenuList .searchMenu__searchForText,
  #searchMenuList .searchMenu__searchForText * {
    color: #ffffff !important; -webkit-text-fill-color: #ffffff !important; font-weight: 600 !important;
  }
  #searchMenuList .sc-link-secondary, #searchMenuList .sc-link-light,
  #searchMenuList .sc-link-secondary * {
    color: #a6a6ac !important; -webkit-text-fill-color: #a6a6ac !important;
  }
  #searchMenuList li:hover, #searchMenuList li.selected, #searchMenuList li[aria-selected="true"],
  #searchMenuList [role="option"]:hover, #searchMenuList .sc-media:hover {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 22%, transparent) !important;
    border-radius: 8px !important;
  }
  /* the keyboard/hover selection is a DIV.autocompleteItem.selected which SC fills
     solid grey (rgb(48,48,48)) — that's the grey box left behind on mouse-off.
     Default it transparent and highlight the selected/hovered one in the accent. */
  #searchMenuList .autocompleteItem { background: transparent !important; border-radius: 8px !important; }
  #searchMenuList .autocompleteItem:hover, #searchMenuList .autocompleteItem.selected,
  #searchMenuList .autocompleteItem.m-active {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 22%, transparent) !important;
  }
  /* keep the accent glow on the search box's own icon/border, not the text */
  #searchMenuList mark, #searchMenuList .g-highlight {
    color: var(--sc-accent, #ff5500) !important; -webkit-text-fill-color: var(--sc-accent, #ff5500) !important;
    background: transparent !important; font-weight: 700 !important;
  }

  /* ===== GO+ tier badge on covers → more visible / legible ===== */
  .tierIndicator__artwork { transform: scale(1.12) !important; z-index: 3 !important; }
  .tierIndicator__artwork svg { filter: drop-shadow(0 1px 4px rgba(0,0,0,0.9)) !important; }

  /* ===== Feed / stream track cards → subtle acrylic + flat themed action buttons ===== */
  .sound.streamContext .soundActions .sc-button, .soundList__item .soundActions .sc-button {
    background: transparent !important; border: 0 !important; box-shadow: none !important; border-radius: 8px !important;
  }
  .sound.streamContext .soundActions .sc-button:hover, .soundList__item .soundActions .sc-button:hover {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 15%, transparent) !important;
  }

  /* ===== Denser track lists (Library / Likes) — more music, less space ===== */
  .soundList__item, .trackList__item, .soundBadgeList__item, .systemPlaylistTrackList__item {
    padding-top: 5px !important; padding-bottom: 5px !important;
    margin-bottom: 4px !important; /* keeps a gap so rows never touch when zoomed out */
    border-radius: 8px !important; transition: background .1s ease !important;
  }
  .soundList__item:hover, .trackList__item:hover { background: rgba(255,255,255,0.04) !important; }
  .soundBadge, .sound__body, .soundBadge__additionalContent { min-height: 0 !important; }
  /* Hide the bulky per-row waveform in list views so rows are compact */
  .soundList__item .waveform, .soundList__item .sound__waveform,
  .trackList__item .waveform, .compactTrackListItem .waveform { display: none !important; }
  .soundList__item .image, .trackList__item .image { border-radius: 6px !important; }

  /* No white wash on artwork hover. The real image (.image__full) fades on hover
     revealing a light placeholder behind it — so keep it fully opaque, drop the
     placeholder background + light outline, and kill any hover overlay. */
  .image__full, .sc-artwork.image__full { opacity: 1 !important; }
  [class*="sc-artwork-placeholder"], .image__lightOutline {
    background-color: transparent !important;
  }
  .image__lightOutline { box-shadow: none !important; }
  .sound__artwork:hover .image, .audibleTile__artwork:hover .image,
  .sound__coverArt:hover .image, .image:hover, .sc-artwork:hover {
    filter: none !important; opacity: 1 !important;
  }
  .image__hover, .image__hoverBox, .imageOverlay, .artwork__overlay,
  .sound__coverArt::after, .sound__coverArt::before,
  .sound__artwork:hover::after, .sound__artwork:hover::before {
    background: none !important; box-shadow: none !important; opacity: 0 !important;
  }
  /* THE actual home-card wash: SoundCloud's .playableTile__imageOverlay */
  .playableTile__imageOverlay,
  .playableTile__artwork:hover .playableTile__imageOverlay,
  .playableTile.m-overlayOpen .playableTile__imageOverlay {
    background: none !important; background-color: transparent !important;
    box-shadow: none !important; opacity: 0 !important;
  }

  /* The "Fans" leaderboard is an <iframe> (webi embedded module) — keep it, make
     it transparent so it blends (JS moves it to the bottom of the sidebar). */
  .sidebarModule__webiEmbeddedModule, .webiEmbeddedModule,
  .webiEmbeddedModuleContainer, .webiEmbeddedModuleIframe {
    background: transparent !important; background-color: transparent !important;
    border: 0 !important; box-shadow: none !important;
  }

  /* Remove the "Insights / X plays / View your Insights" nag everywhere */
  .insightsSidebarModule { display: none !important; }
  /* Same treatment for the "ON TOUR" module — it is an Artist Pro upsell, not a
     tour listing. It is also the one sidebar frame that genuinely cannot be
     themed: artist-events.soundcloud.com is a DIFFERENT ORIGIN, so
     contentDocument is null and themeFrames() can never reach it. ?theme=dark
     makes the child declare color-scheme: dark, so Chromium paints an opaque
     canvas under it (hard rule 7) and it renders as a black rectangle punched
     through the cover background. mix-blend-mode does not rescue it either —
     cross-origin frames composite on their own layer, so the black survives.
     Nothing to theme, so drop the module. */
  .sidebarModule:has(> .sidebarContent > iframe.velvetCakeIframe) {
    display: none !important;
  }
  /* Feed should be just the feed — drop the whole right sidebar there */
  html.hoq-feed .l-sidebar-right { display: none !important; }
  html.hoq-feed .l-fluid-fixed .l-fluid, html.hoq-feed .l-fluid-fixed .stream,
  html.hoq-feed .l-fluid-fixed > div:not(.l-sidebar-right) {
    width: 100% !important; max-width: 100% !important; float: none !important;
  }

  /* ---- Kill Artist Pro / upgrade / creator upsell banners ---- */
  .tierBanner, .artistProUpsell, .upsellBanner, .proUpsell,
  .g-promo, .promoBanner, .creatorSubscriptions__upsell,
  [class*="Upsell"], [class*="upsell"], [data-testid*="upsell"] { display: none !important; }

  /* Onboarding coachmarks / hint bubbles ("Tap the heart…", "OK, got it") */
  [class*="oachmark" i], [class*="ntroBubble" i], [class*="onboardingTip" i],
  .tooltip.onboarding, .g-tooltip--onboarding { display: none !important; }

  /* ---- Kill Artist Tools / Insights / creator clutter (sidebar) ---- */
  .artistTools, .g-artist-tools, .creatorSubscriptions, .artistShortcuts,
  .artistProSection, .userInsights, .insightsModule { display: none !important; }

  /* ---- Kill header promo junk (Get $15, Artist Studio, Go Pro) ---- */
  .header a[href*="refer"], .header a[href*="invite"],
  .header a[href*="/pro"], .header a[href*="artist-studio"],
  .header a[href*="artist.soundcloud"], .header a[href*="creators"],
  .header .header__proLink, .header .header__link--pro { display: none !important; }

  /* ---- Recolor any leftover SoundCloud orange to your accent ---- */
  .sc-text-orange, .g-text-orange, [class*="orange" i] {
    color: var(--sc-accent, #ff5500) !important;
  }

  /* ===== Home polish — accent section headers, matching the library's clean look ===== */
  .lazyLoadingList { margin-bottom: 26px !important; }
  .lazyLoadingList__header, .sectionHead__title,
  .soundList > .soundList__header .soundTitle__title {
    font-weight: 800 !important; letter-spacing: .2px !important; color: #fff !important;
    padding-left: 13px !important; position: relative !important;
  }
  .lazyLoadingList__header::before, .sectionHead__title::before {
    content: '' !important; position: absolute !important; left: 0 !important;
    top: 16% !important; bottom: 16% !important;
    width: 4px !important; border-radius: 3px !important;
    background: var(--sc-accent, #ff5500) !important;
  }
  /* framed home shortcut / mix modules so they read as cards like the library */
  .homeShortcutsModule__item, .mixedSelectionModule__item {
    border-radius: 14px !important;
  }

  /* Lucide (stroke) icons we inject — force outline rendering */
  svg.lucide { fill: none !important; }
  svg.lucide path, svg.lucide circle, svg.lucide line, svg.lucide rect,
  svg.lucide polyline, svg.lucide polygon { fill: none !important; }
  /* Swap SC's header notification (bell) + messages icons via CSS MASK only —
     NO DOM writes (mutating SC's React DOM tore out the header buttons). Hide the
     real svg and paint the holder div in currentColor, masked to the new shape. */
  .notificationIcon.activities > div > svg,
  .notificationIcon.messages > div > svg { display: none !important; }
  .notificationIcon.activities > div,
  .notificationIcon.messages > div {
    display: inline-block !important; width: 22px !important; height: 22px !important;
    background-color: currentColor !important;
    -webkit-mask-repeat: no-repeat !important; mask-repeat: no-repeat !important;
    -webkit-mask-position: center !important; mask-position: center !important;
    -webkit-mask-size: 22px 22px !important; mask-size: 22px 22px !important;
  }
  .notificationIcon.activities > div {
    -webkit-mask-image: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M10.268 21a2 2 0 0 0 3.464 0'/><path d='M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326'/></svg>") !important;
    mask-image: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M10.268 21a2 2 0 0 0 3.464 0'/><path d='M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326'/></svg>") !important;
  }
  /* plain bubble; the notched one (dot drawn in the notch) only when unread */
  .notificationIcon.messages > div {
    -webkit-mask-image: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z'/></svg>") !important;
    mask-image: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z'/></svg>") !important;
  }
  .notificationIcon.messages[class*='newItems__'] > div {
    -webkit-mask-image: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M12.7 3H4a2 2 0 0 0-2 2v16.286a.71.71 0 0 0 1.212.502l2.202-2.202A2 2 0 0 1 6.828 19H20a2 2 0 0 0 2-2v-4.7'/><circle cx='19' cy='6' r='3'/></svg>") !important;
    mask-image: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M12.7 3H4a2 2 0 0 0-2 2v16.286a.71.71 0 0 0 1.212.502l2.202-2.202A2 2 0 0 1 6.828 19H20a2 2 0 0 0 2-2v-4.7'/><circle cx='19' cy='6' r='3'/></svg>") !important;
  }

  /* Sidebar related-tracks badges: pop out in 3D on hover */
  .soundBadgeList .soundBadge, .sidebarContent .soundBadge {
    border-radius: 10px !important;
    transition: transform .16s ease, box-shadow .16s ease, background .16s ease !important;
  }
  .soundBadgeList .soundBadge:hover, .sidebarContent .soundBadge:hover {
    transform: translateY(-2px) scale(1.02) !important;
    box-shadow: none !important;
    z-index: 5 !important; position: relative !important;
  }
  /* Flatten the badge's ♥/⋯ action toolbar so it doesn't read as a box inside the
     row (the "double layer"). SoundCloud's CSS loads AFTER ours, so we need HIGHER
     specificity than their .soundActions__small.m-my-controls-active / .sc-button-selected
     rules — hence the extra class qualifiers below. */
  .soundBadge .soundBadge__additional, .soundBadge .soundBadge__actions,
  .soundBadge .soundBadge__actions .soundActions,
  .soundBadge .soundActions.soundActions__small,
  .soundBadge .soundActions.soundActions__small.m-my-controls-active,
  .soundBadge .soundBadge__actions .sc-button-toolbar,
  .soundBadge .soundBadge__actions .sc-button-group {
    background: transparent !important; background-color: transparent !important;
    background-image: none !important; /* kill the 270deg surface-color fade box */
    box-shadow: none !important; border: 0 !important;
  }
  .soundBadge .soundBadge__actions .sc-button.sc-button-secondary,
  .soundBadge .soundBadge__actions .sc-button-group .sc-button {
    background: transparent !important; background-color: transparent !important;
    border: 0 !important; box-shadow: none !important;
    border-radius: 7px !important; transition: background .12s ease, color .12s ease !important;
  }
  .soundBadge .soundBadge__actions .sc-button-group .sc-button:hover,
  .soundBadge .soundBadge__actions .sc-button-group .sc-button.sc-button-selected,
  .soundBadge .soundBadge__actions .sc-button.sc-button-more.sc-button-selected {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 18%, transparent) !important;
    background-color: color-mix(in srgb, var(--sc-accent, #ff5500) 18%, transparent) !important;
    color: var(--sc-accent, #ff5500) !important;
  }
  /* Kill SoundCloud's own background box on the badge itself (the OUTER layer) —
     our pop-out is shadow-only, so the badge fill must stay transparent in every
     state (hover / m-my-controls-active). */
  .soundBadgeList .soundBadge.compact, .soundBadgeList .soundBadge.m-interactive,
  .soundBadgeList__item .soundBadge, .sidebarContent .soundBadge.compact,
  .soundBadgeList .soundBadge.compact:hover, .soundBadgeList__item:hover .soundBadge {
    background: transparent !important; background-color: transparent !important;
  }
  .soundBadgeList .soundBadge__artwork .image, .sidebarContent .soundBadge__artwork .image {
    border-radius: 9px !important; overflow: hidden !important;
  }

  /* Tags (e.g. "Dance & EDM") — themed accent pill with glow on hover */
  .sc-tag {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 12%, rgba(255,255,255,0.05)) !important;
    border: 1px solid color-mix(in srgb, var(--sc-accent, #ff5500) 30%, transparent) !important;
    color: color-mix(in srgb, var(--sc-accent, #ff5500) 55%, #e2e2e5) !important;
    border-radius: 8px !important;
    transition: background .12s ease, border-color .12s ease, color .12s ease, box-shadow .12s ease !important;
  }
  .sc-tag:hover {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 22%, transparent) !important;
    border-color: color-mix(in srgb, var(--sc-accent, #ff5500) 55%, transparent) !important;
    color: #fff !important;
    box-shadow: 0 0 12px color-mix(in srgb, var(--sc-accent, #ff5500) 28%, transparent) !important;
  }

  /* Toggles (Reposts etc.) — accent TRACK (not SoundCloud orange); knob stays white */
  .sc-toggle.sc-toggle-active, .sc-toggle.sc-toggle-on {
    background-color: var(--sc-accent, #ff5500) !important;
    border-color: var(--sc-accent, #ff5500) !important;
    box-shadow: 0 0 8px color-mix(in srgb, var(--sc-accent, #ff5500) 40%, transparent) !important;
  }
  .sc-toggle.sc-toggle-active::before, .sc-toggle.sc-toggle-on::before {
    background-color: var(--sc-accent, #ff5500) !important;
  }
  .sc-toggle.sc-toggle-active .sc-toggle-handle { background-color: #fff !important; }

  /* Discover tile carousel: snappier tile animation + slightly rounder artwork */
  .tileGallery__sliderPanelSlide .playableTile { transition: transform .12s ease !important; }
  /* carousel forward/back arrows → themed acrylic, accent glow on hover */
  .tileGallery__sliderButton {
    background: rgba(255,255,255,0.06) !important; border: 1px solid rgba(255,255,255,0.12) !important;
    color: #d6d6db !important; box-shadow: none !important; border-radius: 50% !important;
    backdrop-filter: blur(14px) saturate(1.3) !important; -webkit-backdrop-filter: blur(14px) saturate(1.3) !important;
    transition: background .15s ease, color .15s ease, border-color .15s ease, box-shadow .15s ease !important;
  }
  .tileGallery__sliderButton:hover {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 22%, transparent) !important;
    border-color: color-mix(in srgb, var(--sc-accent, #ff5500) 55%, transparent) !important;
    color: #fff !important;
    box-shadow: 0 0 14px color-mix(in srgb, var(--sc-accent, #ff5500) 32%, transparent) !important;
  }
  .tileGallery__sliderButton svg { fill: currentColor !important; }
  .tileGallery .playableTile__image .image, .playableTile__image .image {
    border-radius: 12px !important; overflow: hidden !important;
  }
  /* Home "More of what you like" (+ similar) headers: a soft accent glow so the
     white text feels part of the themed/blended page instead of a harsh label
     floating over the wash. */
  .mixedSelectionModule__titleText, .mixedSelectionModule__title,
  .selectionTitle__title, .selectionTitle {
    /* dim, but tinted toward the playing song's accent so it feels themed */
    color: color-mix(in srgb, var(--sc-accent, #ff5500) 34%, #b4b4bc) !important;
    text-shadow: 0 0 15px color-mix(in srgb, var(--sc-accent, #ff5500) 45%, transparent),
                 0 1px 3px rgba(0,0,0,0.5) !important;
  }
  /* the descriptive sub-header line under those titles: mute it so it recedes */
  .mixedSelectionModule__subtitle, .mixedSelectionModule__descriptionText,
  .mixedSelectionModule__subtitleText, .selectionTitle__secondary,
  .mixedSelectionModule__secondaryText {
    color: rgba(214,214,220,0.62) !important;
    text-shadow: 0 1px 3px rgba(0,0,0,0.4) !important;
  }
  /* give the existing library-style headers the same gentle glow for consistency */
  .lazyLoadingList__header, .sectionHead__title {
    text-shadow: 0 0 15px color-mix(in srgb, var(--sc-accent, #ff5500) 40%, transparent),
                 0 1px 3px rgba(0,0,0,0.5) !important;
  }

  /* ===== 3D tilt on home tiles (JS sets a self-contained perspective() per tile,
     so we DON'T set transform-style:preserve-3d on the list — that created a 3D
     context that clipped the tile titles when zoomed out) ===== */
  .playableTile.hoq-tilt, .audibleTile.hoq-tilt,
  .homeShortcutsModule__item.hoq-tilt, .mixedSelectionModule__item.hoq-tilt {
    will-change: transform; position: relative !important; z-index: 20 !important;
  }

  /* ===== Track-page cover: dynamic 3D that follows the mouse (JS sets transform;
     we only ever touch transform/box-shadow so the layout can't break) ===== */
  .fullHero__artwork {
    transition: transform .12s ease, box-shadow .35s ease !important;
    transform-style: preserve-3d !important; will-change: transform;
  }
  .fullHero__artwork:hover { box-shadow: 0 26px 46px rgba(0,0,0,0.45) !important; }

  /* ===== Like state ===== */
  .sc-button-like { transition: transform .12s ease, box-shadow .12s ease, background .12s ease !important; }
  .sc-button-like:not(.sc-button-selected) { opacity: .8 !important; }
  .sc-button-like:not(.sc-button-selected):hover { opacity: 1 !important; }
  /* liked: accent heart with a soft glow (default) */
  .sc-button-like.sc-button-selected {
    color: var(--sc-accent, #ff5500) !important; fill: var(--sc-accent, #ff5500) !important;
    filter: drop-shadow(0 0 2px color-mix(in srgb, var(--sc-accent, #ff5500) 45%, transparent)) !important;
  }
  /* Some hearts (esp. comment likes) hard-code fill="#f50" as a presentation
     attribute on the <path>, which beats CSS fill on the button — override the
     path/svg directly so the heart follows the song accent. */
  .sc-button-like.sc-button-selected svg,
  .sc-button-like.sc-button-selected svg path,
  .sc-button-like.sc-button-selected svg * {
    fill: var(--sc-accent, #ff5500) !important;
  }
  /* strong glow ONLY on the real like TOGGLE (action bar + player bar) */
  .soundActions .sc-button-like.sc-button-selected,
  .sound__soundActions .sc-button-like.sc-button-selected,
  .listenEngagement__actions .sc-button-like.sc-button-selected,
  .playControls .sc-button-like.sc-button-selected,
  .playbackSoundBadge__like.sc-button-selected {
    filter: drop-shadow(0 0 6px var(--sc-accent, #ff5500))
            drop-shadow(0 0 2px var(--sc-accent, #ff5500)) !important;
  }
  /* engagement STAT counts (10.7K / 479 / 20): just color, NEVER a glow/box
     (that double-glow on the count was the bugged red box) */
  .sc-ministats .sc-button-like, [class*="ministat" i] .sc-button-like,
  .listenEngagement__stats .sc-button-like, .soundStats .sc-button-like,
  .sound__footer .sc-ministats, .sound__footer .sc-ministats * {
    filter: none !important; box-shadow: none !important;
    background: transparent !important; border: 0 !important;
  }
  /* tiles: minimal glow */
  .playableTile .sc-button-like.sc-button-selected,
  .audibleTile .sc-button-like.sc-button-selected,
  .sound__coverArt .sc-button-like.sc-button-selected,
  .mixedSelectionModule__item .sc-button-like.sc-button-selected,
  .homeShortcutsModule__item .sc-button-like.sc-button-selected {
    filter: drop-shadow(0 0 1.5px color-mix(in srgb, var(--sc-accent, #ff5500) 40%, transparent)) !important;
  }
  /* Action toolbar (Repost / Share / Copy / Add / More) — flat + clean, accent hover */
  .soundActions .sc-button, .sound__soundActions .sc-button, .listenEngagement__actions .sc-button {
    background: transparent !important; border: 0 !important; box-shadow: none !important;
    border-radius: 8px !important; transition: background .12s ease, filter .12s ease !important;
  }
  .soundActions .sc-button:hover, .sound__soundActions .sc-button:hover,
  .listenEngagement__actions .sc-button:hover {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 15%, transparent) !important;
  }

  /* ===== Track-row hover actions (heart / repost / "...") — no dark box, flat ===== */
  .soundActions__small, .soundActions__medium, .trackItem__actions, .trackItem__additional,
  .soundBadge__actions, .compactTrackListItem__additional,
  .sound__soundActions .sc-button-toolbar, .trackItem__actions .sc-button-group {
    background: transparent !important; box-shadow: none !important; border: 0 !important;
  }
  .soundActions__small .sc-button, .soundActions__medium .sc-button,
  .trackItem__actions .sc-button, .soundBadge__actions .sc-button {
    background: transparent !important; border: 0 !important; box-shadow: none !important;
    border-radius: 7px !important; transition: background .12s ease !important;
  }
  .soundActions__small .sc-button:hover, .soundActions__medium .sc-button:hover,
  .trackItem__actions .sc-button:hover, .soundBadge__actions .sc-button:hover {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 15%, transparent) !important;
  }

  /* ===== Comments: like button (was a black box) + "Write a comment" bar ===== */
  .commentsList .sc-button-like, .commentItem .sc-button-like, .comment .sc-button-like,
  .commentActions .sc-button, .commentItem__actions .sc-button, .comment__actions .sc-button {
    background: transparent !important; border: 0 !important; box-shadow: none !important;
    border-radius: 8px !important;
  }
  .commentsList .sc-button-like:hover, .commentItem .sc-button-like:hover {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 14%, transparent) !important;
  }
  /* Write-a-comment box → match the app. Only the INPUT gets the box; the form
     wrapper stays transparent (styling both = the double layer). */
  .commentForm, .addCommentForm, .commentForm__inner { background: transparent !important; border: 0 !important; box-shadow: none !important; }
  .commentForm__input, .comment__input, .commentInput,
  .commentForm .sc-input, .commentForm textarea,
  .commentForm input[type="text"], .commentForm [contenteditable] {
    background: rgba(255,255,255,0.05) !important;
    border: 1px solid rgba(255,255,255,0.08) !important;
    border-radius: 10px !important; color: #e4e4e6 !important; box-shadow: none !important;
  }
  .commentForm__input:focus, .commentForm .sc-input:focus,
  .commentForm textarea:focus, .commentForm [contenteditable]:focus {
    border-color: var(--sc-accent, #ff5500) !important; outline: none !important;
  }

  /* ===== Clean song-row hover — subtle accent wash + soft glow (not flat black) ===== */
  .soundList__item:hover, .trackList__item:hover, .searchList__item:hover,
  .soundBadgeList__item:hover, .systemPlaylistTrackList__item:hover,
  .trackItem:hover, .queueItemView:hover, .listenNetworkItem:hover,
  .compactTrackListItem:hover {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 8%, rgba(255,255,255,0.02)) !important;
    border-radius: 10px !important;
    box-shadow: none !important;
    transition: background .14s ease !important;
  }
  /* kill SoundCloud's own darker hover layer underneath so ours is the only one */
  .trackList__item:hover .trackItem, .systemPlaylistTrackList__item:hover .trackItem,
  .soundList__item:hover > .sound, .trackList__item:hover > * {
    background: transparent !important;
  }

  /* ===== Frosted "acrylic" header popovers ("..." menu, Notifications, DMs) =====
     Everything lives inside .dropdownMenu; give THAT the single glass pane and
     make SoundCloud's inner solid wrappers transparent so it isn't double-layered. */
  .dropdownMenu {
    background: rgba(12,12,16,0.42) !important;
    border: 1px solid rgba(255,255,255,0.10) !important;
    border-radius: 14px !important;
    box-shadow: 0 18px 52px rgba(0,0,0,0.5) !important;
    backdrop-filter: blur(24px) saturate(1.5) !important;
    -webkit-backdrop-filter: blur(24px) saturate(1.5) !important;
    overflow: hidden !important;
  }
  /* clear the inner solid wrappers SoundCloud paints (the "double layer") */
  .dropdownMenu > *, .dropdownMenu .dropdownContent, .dropdownMenu .dropdownContent__container,
  .dropdownMenu .dropdownContent__header, .dropdownMenu .dropdownContent__list,
  .dropdownMenu .moreActions, .dropdownMenu .moreActions__list {
    background: transparent !important; border: 0 !important; box-shadow: none !important;
    backdrop-filter: none !important;
  }
  /* When a dropdownMenu wraps a .linkMenu (comment-sort AND the Library
     "All / Created / Liked" filter), let the .linkMenu be the SINGLE acrylic pane
     — make the outer shell + its scrollable wrappers transparent (no double glass). */
  .dropdownMenu:has(.linkMenu) {
    background: transparent !important; border: 0 !important; box-shadow: none !important;
    backdrop-filter: none !important; -webkit-backdrop-filter: none !important; overflow: visible !important;
  }
  .linkMenu .g-scrollable, .linkMenu .g-scrollable-inner, .linkMenu__scrollable {
    background: transparent !important; border: 0 !important;
  }
  /* No scrollbars in these panels (wheel still scrolls) */
  .dropdownMenu, .dropdownMenu * { scrollbar-width: none !important; -ms-overflow-style: none !important; }
  .dropdownMenu::-webkit-scrollbar, .dropdownMenu *::-webkit-scrollbar {
    width: 0 !important; height: 0 !important; display: none !important;
  }
  /* Style ONLY the action-menu rows (Repost / Share / Add to Playlist…). Those
     dropdowns have no .dropdownContent, unlike Notifications/DMs — so this leaves
     the notification + message layouts completely alone. */
  .dropdownMenu:not(:has(.dropdownContent, .dropdownContent__container)) .sc-button,
  .dropdownMenu:not(:has(.dropdownContent, .dropdownContent__container)) button,
  .dropdownMenu:not(:has(.dropdownContent, .dropdownContent__container)) a[role="menuitem"] {
    display: flex !important; align-items: center !important; gap: 10px !important;
    width: 100% !important; justify-content: flex-start !important; text-align: left !important;
    background: transparent !important; border: 0 !important; box-shadow: none !important;
    border-radius: 8px !important; color: #d4d4d7 !important; font-weight: 600 !important;
    padding: 8px 11px !important; transition: background .12s ease, color .12s ease !important;
  }
  .dropdownMenu:not(:has(.dropdownContent, .dropdownContent__container)) .sc-button:hover,
  .dropdownMenu:not(:has(.dropdownContent, .dropdownContent__container)) button:hover,
  .dropdownMenu:not(:has(.dropdownContent, .dropdownContent__container)) a[role="menuitem"]:hover {
    background: var(--sc-accent, #ff5500) !important; color: #fff !important;
  }
  .dropdownMenu:not(:has(.dropdownContent, .dropdownContent__container)) .sc-button:hover * { color: #fff !important; }

  /* ===== Notifications / Messages popovers: same family as the other menus =====
     avatar | who + what + when | action (follow pill or the track's artwork) */
  .dropdownMenu:has(.dropdownContent__container) {
    background: rgba(12,12,16,0.82) !important; border: 1px solid rgba(255,255,255,0.09) !important;
    border-radius: 14px !important; box-shadow: 0 18px 52px rgba(0,0,0,0.55) !important;
  }
  .dropdownContent__container { padding: 6px !important; }
  /* SoundCloud sizes its scroll wrapper wider than the box to tuck a scrollbar
     away; scrollbars are hidden here, so that extra width just pushed the right
     edge (the Follow back pill) out of the frame. Pin everything to the box. */
  .dropdownMenu:has(.dropdownContent__container) .g-scrollable, .dropdownMenu:has(.dropdownContent__container) .g-scrollable-inner,
  .dropdownMenu:has(.dropdownContent__container) [class*="__scrollable"] {
    width: auto !important; max-width: 100% !important; margin-right: 0 !important; padding-right: 0 !important;
    box-sizing: border-box !important; overflow-x: hidden !important; }
  .dropdownMenu .dropdownContent, .dropdownMenu .dropdownContent__container, .dropdownMenu .dropdownContent__list,
  .dropdownMenu .dropdownContent__listItem { max-width: 100% !important; box-sizing: border-box !important; }
  .dropdownContent__header { display: flex !important; align-items: center !important; justify-content: space-between !important;
    padding: 6px 8px 10px !important; border: 0 !important; }
  .dropdownContent__header h2 { font-size: 13px !important; font-weight: 600 !important; color: #ececf1 !important; letter-spacing: 0 !important; margin: 0 !important; }
  .dropdownContent__headerButton { font-size: 12px !important; font-weight: 500 !important; color: #8e8e99 !important; text-decoration: none !important; }
  .dropdownContent__headerButton:hover { color: #fff !important; }
  .dropdownContent__list { margin: 0 !important; padding: 0 !important; }
  .dropdownContent__listItem { margin: 0 !important; padding: 0 !important; border: 0 !important; background: transparent !important; }
  .dropdownContent__listItem + .dropdownContent__listItem { margin-top: 2px !important; }
  .notificationBadge__linkContainer { position: relative !important; border-radius: 10px !important; transition: background .12s ease !important; }
  .notificationBadge__linkContainer:hover { background: rgba(255,255,255,0.06) !important; }
  .notificationBadge, .notificationBadge.m-small { background: transparent !important; border: 0 !important; padding: 8px !important; margin: 0 !important;
    width: auto !important; max-width: 100% !important; box-sizing: border-box !important; }
  .notificationBadge__linkContainer, .notificationBadge__row { max-width: 100% !important; box-sizing: border-box !important; }
  .notificationBadge__row { display: flex !important; align-items: center !important; gap: 11px !important; width: 100% !important; }
  .notificationBadge__side { flex: none !important; position: relative !important; z-index: 2 !important; margin: 0 !important; padding: 0 !important; }
  .notificationBadge__side:last-child { margin-left: auto !important; }
  .notificationBadge__main { flex: 1 1 auto !important; min-width: 0 !important; display: flex !important; flex-direction: column !important; gap: 2px !important;
    font-size: 12.5px !important; line-height: 1.35 !important; color: #a6a6b0 !important; }
  .notificationBadge__main .sc-text-secondary { color: #a6a6b0 !important; }
  .notificationBadge__username { font-size: 12.5px !important; font-weight: 600 !important; color: #f0f0f4 !important; margin: 0 4px 0 0 !important; }
  /* the global gradient-text link rule (.sc-text-primary / .sc-link-primary) turns
     names into a muddy cover gradient here: plain solid text in these popovers */
  .dropdownMenu .sc-text-primary, .dropdownMenu .sc-link-primary, .dropdownMenu .notificationBadge__username {
    background: none !important; -webkit-background-clip: border-box !important; background-clip: border-box !important;
    -webkit-text-fill-color: currentColor !important; }
  .dropdownMenu .notificationBadge__username { color: #f0f0f4 !important; }
  .notificationBadge__main .sc-text-h5 { font-size: inherit !important; }
  .notificationBadge .userAvatarBadge__imageContainer, .notificationBadge .userAvatarBadge__image {
    width: 36px !important; height: 36px !important; border-radius: 50% !important; }
  .notificationBadge .activityBadge__artwork { display: block !important; width: 36px !important; height: 36px !important;
    border-radius: 7px !important; background-size: cover !important; }
  .activityBadge__timeIndicator { display: inline-flex !important; align-items: center !important; gap: 4px !important;
    font-size: 11px !important; color: #7d7d88 !important; padding: 0 !important; }
  .activityBadge__icon { width: 11px !important; height: 11px !important; opacity: .8 !important; }
  /* follow pill: "Follow back" = accent tint, "Following" = quiet */
  .notificationBadge .sc-button-follow { height: 26px !important; min-width: 0 !important; padding: 0 11px !important; border-radius: 99px !important;
    font-size: 11.5px !important; font-weight: 600 !important; box-shadow: none !important; border: 0 !important;
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 24%, transparent) !important;
    color: color-mix(in srgb, var(--sc-accent, #ff5500) 55%, #fff) !important; }
  .notificationBadge .sc-button-follow:hover { background: color-mix(in srgb, var(--sc-accent, #ff5500) 32%, transparent) !important; }
  .notificationBadge .sc-button-follow.sc-button-selected { background: rgba(255,255,255,0.07) !important; color: #a6a6b0 !important; }
  .notificationBadge .sc-button-follow.sc-button-selected:hover { background: rgba(255,90,70,0.12) !important; color: #ff8a7a !important; }
  .dropdownContent__footerLink { display: block !important; margin: 6px 0 0 !important; padding: 10px 8px 6px !important; text-align: center !important;
    border-top: 1px solid rgba(255,255,255,0.07) !important; font-size: 12px !important; font-weight: 500 !important;
    color: #a6a6b0 !important; text-decoration: none !important; }
  .dropdownContent__footerLink:hover { color: #fff !important; }

  /* ===== Header "..." menu (.moreMenu): same look as the EQ / output menus ===== */
  .dropdownMenu:has(.moreMenu) {
    background: rgba(12,12,16,0.78) !important; border: 1px solid rgba(255,255,255,0.09) !important;
    border-radius: 14px !important; box-shadow: 0 18px 52px rgba(0,0,0,0.55) !important;
    /* never taller than the window: scroll instead of running off the bottom */
    max-height: calc(100vh - 64px) !important; overflow-y: auto !important; overflow-x: hidden !important; overscroll-behavior: contain;
  }
  .moreMenu, .moreMenu.m-light { width: 220px !important; padding: 6px !important; box-sizing: border-box !important;
    background: transparent !important; border: 0 !important; box-shadow: none !important; }
  .moreMenu .headerMenu__list { margin: 0 !important; padding: 0 !important; border: 0 !important; }
  .moreMenu .headerMenu__list + .headerMenu__list { margin-top: 4px !important; padding-top: 4px !important;
    border-top: 1px solid rgba(255,255,255,0.07) !important; }
  .moreMenu .headerMenu__link, .moreMenu .moreMenu__link {
    display: flex !important; align-items: center !important; height: 30px !important; padding: 0 10px !important;
    border: 0 !important; border-radius: 8px !important; background: transparent !important; box-shadow: none !important;
    color: #d6d6de !important; font-size: 13px !important; font-weight: 500 !important; text-decoration: none !important;
    transition: background .12s ease, color .12s ease !important;
  }
  .moreMenu .headerMenu__link:hover, .moreMenu .moreMenu__link:hover, .moreMenu .headerMenu__link:focus-visible {
    background: rgba(255,255,255,0.07) !important; color: #fff !important;
  }
  /* Go+ upsell: a quiet accent line, not a shout */
  .moreMenu .moreMenu__link.m-highlight { color: color-mix(in srgb, var(--sc-accent, #ff5500) 65%, #fff) !important; }
  .moreMenu .moreMenu__link.m-highlight:hover { background: color-mix(in srgb, var(--sc-accent, #ff5500) 14%, transparent) !important; }
  /* Sign out: muted, warns on hover */
  .moreMenu a[href="/logout"] { color: #9a9aa6 !important; }
  .moreMenu a[href="/logout"]:hover { color: #ff8a7a !important; background: rgba(255,90,70,0.10) !important; }

  /* ===== Comment-sort dropdown (.linkMenu: Newest / Oldest / Track Time) =====
     Same acrylic glass as the header popovers (.dropdownMenu) — low-alpha fill so
     the frost actually shows, slim rows. */
  /* The popover wrapper SoundCloud renders AROUND .linkMenu is solid — clear it
     (and any solid ancestor between it and the page) so the glass pane can
     actually frost the content behind it instead of blurring a solid slab. */
  :has(> .linkMenu) {
    background: transparent !important; background-color: transparent !important;
    box-shadow: none !important; border: 0 !important; backdrop-filter: none !important;
  }
  .linkMenu {
    /* light-topped gradient so it reads as glass even over dark comment area */
    background: linear-gradient(180deg, rgba(46,46,54,0.5) 0%, rgba(18,18,24,0.42) 100%) !important;
    border: 1px solid rgba(255,255,255,0.12) !important;
    border-radius: 14px !important;
    box-shadow: 0 18px 52px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.10) !important;
    backdrop-filter: blur(24px) saturate(1.5) !important;
    -webkit-backdrop-filter: blur(24px) saturate(1.5) !important;
    overflow: hidden !important;
    padding: 5px !important;
  }
  /* clear any solid inner wrappers so the single glass pane shows through */
  .linkMenu > *, .linkMenu__list, .linkMenu__group, .linkMenu__item {
    background: transparent !important; border: 0 !important;
    margin: 0 !important; padding: 0 !important; box-shadow: none !important;
    backdrop-filter: none !important;
  }
  /* Rounded, inset pills — the fill lives on the link, not the full-width row, so
     it doesn't bleed to the menu edges as a hard rectangle. Slim padding. */
  .linkMenu__link {
    display: block !important; border-radius: 8px !important;
    padding: 6px 12px !important; margin: 1px 0 !important;
    color: #d4d4d7 !important; font-weight: 600 !important; min-height: 0 !important;
    transition: background .12s ease, color .12s ease !important;
  }
  .linkMenu__item:hover .linkMenu__link {
    background: rgba(255,255,255,0.08) !important; color: #fff !important;
  }
  .linkMenu__activeItem .linkMenu__link {
    background: var(--sc-accent, #ff5500) !important; color: #fff !important;
  }
  /* The "Sorted by: Newest" button that opens the menu — transparent + accent
     glow so it matches the themed dropdown instead of SC's grey pill. */
  .commentsList__sortSelect .select__dropdownButton,
  .commentsList__sortSelect .sc-button-dropdown {
    background: transparent !important; background-color: transparent !important;
    border: 1px solid rgba(255,255,255,0.12) !important; border-radius: 10px !important;
    color: color-mix(in srgb, var(--sc-accent, #ff5500) 30%, #d6d6db) !important;
    box-shadow: none !important;
    text-shadow: 0 0 10px color-mix(in srgb, var(--sc-accent, #ff5500) 35%, transparent) !important;
    transition: border-color .15s ease, box-shadow .15s ease, color .15s ease !important;
  }
  .commentsList__sortSelect .select__dropdownButton:hover,
  .commentsList__sortSelect .sc-button-dropdown:hover {
    color: #fff !important;
    border-color: color-mix(in srgb, var(--sc-accent, #ff5500) 55%, transparent) !important;
    box-shadow: 0 0 15px color-mix(in srgb, var(--sc-accent, #ff5500) 32%, transparent) !important;
  }
  .commentsList__sortSelect .select__dropdownButton svg { fill: currentColor !important; }
  /* Profile header: SoundCloud prints the name / city on hard black boxes over
     the banner. Drop the boxes; a soft shadow keeps them readable on any banner. */
  .profileHeaderInfo [class*="g-type-shrinkwrap"] {
    background: none !important; background-color: transparent !important; padding-left: 0 !important; padding-right: 0 !important;
    text-shadow: 0 1px 2px rgba(0,0,0,.7), 0 2px 14px rgba(0,0,0,.55) !important; }
  .profileHeaderInfo__userName { color: #fff !important; -webkit-text-fill-color: #fff !important; }
  .profileHeaderInfo__additional[class*="g-type-shrinkwrap"] { color: rgba(255,255,255,.82) !important; -webkit-text-fill-color: currentColor !important; }
  .profileHeaderInfo__content br { display: none; }
  .profileHeaderInfo__content > h3 { display: block !important; margin-top: 4px !important; }
  /* Notifications page filter ("All notifications ▾"): a quiet pill, same
     family as the menus it opens */
  .activitiesFilterSelect__button.sc-button {
    display: inline-flex !important; align-items: center !important; gap: 6px !important;
    height: 32px !important; padding: 0 10px 0 13px !important; margin-right: 8px !important;
    background: rgba(255,255,255,0.05) !important; border: 1px solid rgba(255,255,255,0.09) !important;
    border-radius: 99px !important; box-shadow: none !important; text-shadow: none !important;
    color: #e4e4ea !important; font-size: 13px !important; font-weight: 600 !important; line-height: 1 !important; letter-spacing: 0 !important;
    -webkit-text-fill-color: currentColor !important; transition: background .12s ease, border-color .12s ease !important;
  }
  .activitiesFilterSelect__button.sc-button:hover, .activitiesFilterSelect__button.sc-button[aria-expanded="true"] {
    background: rgba(255,255,255,0.09) !important; border-color: rgba(255,255,255,0.16) !important; color: #fff !important; }
  .activitiesFilterSelect__button svg { width: 14px !important; height: 14px !important; padding: 0 !important; margin: 0 !important;
    opacity: .65; transition: transform .15s ease, opacity .12s ease; }
  .activitiesFilterSelect__button:hover svg { opacity: 1; }
  .activitiesFilterSelect__button[aria-expanded="true"] svg { transform: rotate(180deg); }

  /* ===== Modals incl. the Share popup — acrylic glass ===== */
  .modal__modal, .g-modal, .shareSheet, .sharePanel, .share__inner,
  [class*="shareModal" i], [class*="ShareModal"], .modal[aria-modal] > div {
    background: rgba(14,14,18,0.72) !important;
    border: 1px solid rgba(255,255,255,0.10) !important;
    border-radius: 16px !important;
    box-shadow: 0 26px 74px rgba(0,0,0,0.62) !important;
    backdrop-filter: blur(24px) saturate(1.45) !important;
    -webkit-backdrop-filter: blur(24px) saturate(1.45) !important;
  }
  /* dim + blur the page behind the modal */
  .modal__background, .modalBackground, .g-modal-overlay, .modal__overlay {
    background: rgba(0,0,0,0.5) !important;
    backdrop-filter: blur(5px) !important; -webkit-backdrop-filter: blur(5px) !important;
  }

  /* ===== Header, right side: one tidy grouped row =====
     Upload | output · EQ · mini | notifications · messages · more | avatar.
     .header__userNav becomes display:contents so its buttons line up (and
     reorder) with ours in the one flex row; the avatar goes last. */
  .header__right { display: flex !important; align-items: center !important; gap: 2px !important; }
  .header__userNav { display: contents !important; }
  .header__soundInput, .header__upload { order: 1; margin-right: 10px !important; }
  #hoq-out-btn { order: 2; } #hoq-eq-btn { order: 3; } #hoq-mini-btn, #hoq-upd-btn { order: 4; }
  /* Check for updates: spins while it looks, dotted once an update is ready */
  @keyframes hoq-upd-spin { to { transform: rotate(360deg); } }
  .header #hoq-upd-btn.is-busy svg { animation: hoq-upd-spin .9s linear infinite; }
  .header #hoq-upd-btn.has-upd::after { content: ''; position: absolute; top: 6px; right: 6px; width: 7px; height: 7px;
    border-radius: 50%; background: var(--sc-accent, #ff5500); box-shadow: 0 0 0 2px rgba(13,13,16,.9); }
  .header__loginMenu { order: 5; margin-left: 8px !important; }
  .header__userNavActivitiesButton { order: 6; } .header__userNavMessagesButton { order: 7; }
  .header__right > .header__navMenu { order: 8; margin: 0 !important; }
  .header__userNavUsernameButton { order: 9; }
  .header__right > .header__navMenu li { display: flex !important; }
  /* every icon button: same size, same grey, soft hover tile, no glow */
  .header #hoq-out-btn, .header .hoq-hdr-icon, .header .header__userNavActivitiesButton,
  .header .header__userNavMessagesButton, .header .header__moreButton {
    position: relative !important; display: inline-flex !important; align-items: center !important; justify-content: center !important;
    width: 34px !important; height: 34px !important; margin: 0 !important; padding: 0 !important; border: 0 !important;
    border-radius: 10px !important; background: transparent !important; box-shadow: none !important; filter: none !important;
    color: #a6a6b0 !important; transition: background .12s ease, color .12s ease !important; }
  .header #hoq-out-btn:hover, .header .hoq-hdr-icon:hover, .header .header__userNavActivitiesButton:hover,
  .header .header__userNavMessagesButton:hover, .header .header__moreButton:hover {
    background: rgba(255,255,255,0.08) !important; color: #fff !important; filter: none !important; }
  .header #hoq-out-btn svg, .header .hoq-hdr-icon svg { width: 19px !important; height: 19px !important; }
  .header .header__userNavActivitiesButton svg, .header .header__userNavMessagesButton svg { width: 21px !important; height: 21px !important; }
  .header .header__moreButton svg { width: 17px !important; height: 17px !important; }
  .header .header__userNavActivitiesButton *, .header .header__userNavMessagesButton *, .header .header__moreButton * { color: inherit !important; }
  .header .notificationIcon, .header .header__moreButtonIcon { display: flex !important; align-items: center !important; justify-content: center !important; position: relative !important; }
  /* "on" (output pinned / effects active): a small accent dot, not a whole orange icon */
  .header #hoq-out-btn.on, .header .hoq-hdr-icon.on { color: #a6a6b0 !important; }
  .header #hoq-out-btn.on:hover, .header .hoq-hdr-icon.on:hover { color: #fff !important; }
  .header #hoq-out-btn.on::after, .header .hoq-hdr-icon.on::after { content: ''; position: absolute; top: 6px; right: 6px; width: 6px; height: 6px;
    border-radius: 50%; background: color-mix(in srgb, var(--sc-accent, #ff5500) 45%, #fff); box-shadow: 0 0 0 2px rgba(10,10,14,0.55); }
  /* unread badge: the same small dot, in the same spot */
  /* the glyph box is exactly 22x22, so the dot can sit on a known spot: in the
     message bubble's notch (circle at 19,6 of 24), on the bell's top-right */
  .header .notificationIcon { width: 22px !important; height: 22px !important; }
  .header .notificationIcon__badge { position: absolute !important; margin: 0 !important; padding: 0 !important; line-height: 0 !important; right: auto !important; bottom: auto !important; }
  .header .notificationIcon.messages .notificationIcon__badge { left: 13.4px !important; top: 1.5px !important; }
  .header .notificationIcon.activities .notificationIcon__badge { left: 13px !important; top: 0 !important; }
  .header .notificationIcon__badge .newItemBadge { display: none !important; }
  .header .notificationIcon[class*='newItems__'] .newItemBadge, .header .newItemBadge[class*='newItems__'] {
    display: block !important; position: static !important; margin: 0 !important; width: 8px !important; height: 8px !important; min-width: 0 !important; padding: 0 !important;
    border-radius: 50% !important; background: color-mix(in srgb, var(--sc-accent, #ff5500) 45%, #fff) !important;
    box-shadow: 0 0 0 2px rgba(10,10,14,0.55) !important; font-size: 0 !important; }
  /* group dividers */
  .header #hoq-out-btn { margin-left: 2px !important; }
  .header .header__userNavActivitiesButton { margin-left: 13px !important; }
  .header .header__userNavActivitiesButton::before, .header .header__userNavUsernameButton::before {
    content: ''; position: absolute; left: -8px; top: 9px; bottom: 9px; width: 1px; background: rgba(255,255,255,0.12); }
  /* avatar last: small pill with a quiet chevron */
  .header .header__userNavUsernameButton { position: relative !important; display: inline-flex !important; align-items: center !important; gap: 3px !important;
    height: 34px !important; margin: 0 0 0 13px !important; padding: 0 6px 0 4px !important; border-radius: 99px !important;
    background: transparent !important; transition: background .12s ease !important; }
  .header .header__userNavUsernameButton:hover { background: rgba(255,255,255,0.08) !important; }
  .header .header__userNavAvatar, .header .header__userNavAvatar .sc-artwork {
    width: 26px !important; height: 26px !important; border-radius: 50% !important;
    box-shadow: 0 0 0 1px rgba(255,255,255,0.16) !important; filter: none !important; }
  .header .header__userNavUsernameButtonIcon { margin: 0 !important; color: #8e8e99 !important; display: flex !important; }
  .header .header__userNavUsernameButtonIcon svg { width: 12px !important; height: 12px !important; }
  .header .header__userNavUsernameButtonIcon, .header .header__userNavUsernameButtonIcon > div { display: flex !important; align-items: center !important; height: 34px !important; margin: 0 !important; padding: 0 !important; }
  .header .header__userNavUsernameButtonIcon svg { display: block !important; }
  /* ===== SoundCloud's little notices ("… was saved to your Library") =====
     Same card as the app's own toasts: bottom-right above the player, cover,
     title, a muted line; the × shows on hover. */
  #gritter-notice-wrapper { position: fixed !important; top: auto !important; left: auto !important;
    right: 18px !important; bottom: 96px !important; width: 330px !important; z-index: 2147483500 !important; }
  .gritter-item-wrapper { position: relative !important; margin: 8px 0 0 !important; background: none !important;
    display: block !important; width: auto !important; padding: 0 !important; border: 0 !important; box-shadow: none !important; border-radius: 0 !important;
    backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
    animation: hoqGritIn .32s cubic-bezier(.2,.9,.3,1) both; }
  @keyframes hoqGritIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
  .gritter-top, .gritter-bottom { display: none !important; }
  .gritter-item { display: flex !important; align-items: center !important; gap: 12px !important; margin: 0 !important;
    padding: 10px 34px 10px 10px !important; border-radius: 14px !important; min-height: 0 !important;
    background: rgba(20,20,24,0.78) !important; border: 1px solid rgba(255,255,255,0.12) !important;
    box-shadow: 0 12px 40px rgba(0,0,0,0.5) !important; color: #fff !important;
    backdrop-filter: blur(22px) saturate(1.6) !important; -webkit-backdrop-filter: blur(22px) saturate(1.6) !important;
    font: 500 13px/1.35 Inter,-apple-system,Arial,sans-serif !important; }
  .gritter-item > div[style*="clear"] { display: none !important; }
  .gritter-image { float: none !important; flex: none !important; width: 40px !important; height: 40px !important; margin: 0 !important;
    border-radius: 8px !important; object-fit: cover !important; box-shadow: 0 2px 8px rgba(0,0,0,0.35) !important; }
  .gritter-with-image, .gritter-without-image { float: none !important; flex: 1 1 auto !important; min-width: 0 !important; width: auto !important;
    display: flex !important; flex-direction: column !important; gap: 1px !important; padding: 0 !important; margin: 0 !important; }
  .gritter-item p { margin: 0 !important; padding: 0 !important; }
  .gritter-item p:empty { display: none !important; }
  .gritter-title { display: block !important; margin: 0 !important; padding: 0 !important; color: #fff !important; text-shadow: none !important;
    font: 600 13px/1.3 Inter,-apple-system,Arial,sans-serif !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; }
  .gritter-item .sc-text-secondary { color: #a6a6b0 !important; font-size: 12px !important; }
  .gritter-item a.sc-link-primary { background: none !important; -webkit-background-clip: border-box !important; background-clip: border-box !important;
    -webkit-text-fill-color: currentColor !important; color: color-mix(in srgb, var(--sc-accent, #ff5500) 55%, #fff) !important; font-weight: 600 !important; }
  .gritter-item a.sc-link-primary:hover { text-decoration: underline !important; }
  .gritter-close { display: flex !important; align-items: center !important; justify-content: center !important;
    position: absolute !important; top: 50% !important; right: 8px !important; left: auto !important; width: 22px !important; height: 22px !important;
    margin: -11px 0 0 !important; border-radius: 50% !important; background: transparent !important; color: #8e8e99 !important;
    opacity: 0 !important; transition: opacity .12s ease, background .12s ease !important; text-indent: 0 !important; }
  .gritter-item-wrapper:hover .gritter-close { opacity: 1 !important; }
  .gritter-close:hover { background: rgba(255,255,255,0.1) !important; color: #fff !important; }
  .gritter-close svg { width: 11px !important; height: 11px !important; }
  /* "Go to playlist" under the Discover / made-for-you rows: slim pill + arrow */
  .selectionModulePlaylistLink .sc-button {
    display: inline-flex !important; align-items: center !important; gap: 7px !important;
    height: 30px !important; padding: 0 12px 0 14px !important; margin: 0 !important; border-radius: 99px !important;
    border: 1px solid rgba(255,255,255,0.12) !important; background: rgba(255,255,255,0.05) !important;
    color: #e4e4ea !important; -webkit-text-fill-color: currentColor !important; box-shadow: none !important; text-shadow: none !important;
    font: 600 12.5px/1 Inter,-apple-system,Arial,sans-serif !important; letter-spacing: 0 !important; white-space: nowrap !important;
    transition: background .14s ease, border-color .14s ease, color .14s ease !important; }
  .selectionModulePlaylistLink .sc-button::after {
    content: ''; width: 12px; height: 12px; flex: none; background: currentColor; opacity: .75;
    -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 12h14M13 6l6 6-6 6'/%3E%3C/svg%3E") center / contain no-repeat;
            mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 12h14M13 6l6 6-6 6'/%3E%3C/svg%3E") center / contain no-repeat;
    transition: transform .16s ease, opacity .14s ease; }
  .selectionModulePlaylistLink .sc-button:hover {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 20%, transparent) !important;
    border-color: color-mix(in srgb, var(--sc-accent, #ff5500) 45%, transparent) !important; color: #fff !important; }
  .selectionModulePlaylistLink .sc-button:hover::after { transform: translateX(2px); opacity: 1; }
  /* ===== Player bar: cleaned up =====
     Times, volume and the song text are quiet (no orange paint); the play
     button carries the accent on its own; the right-side actions are even
     tiles with a hover, like the header. */
  .playControls .playbackTimeline__timePassed, .playControls .playbackTimeline__duration,
  .playControls .playbackTimeline__timePassed *, .playControls .playbackTimeline__duration * {
    background: none !important; -webkit-background-clip: border-box !important; background-clip: border-box !important;
    -webkit-text-fill-color: currentColor !important; color: #8e8e99 !important; border-color: transparent !important;
    font-family: Inter,-apple-system,Arial,sans-serif !important; font-size: 11.5px !important; font-weight: 500 !important; font-variant-numeric: tabular-nums !important; }
  .playControls .playbackTimeline__timePassed span[aria-hidden], .playControls .playbackTimeline__timePassed > span:last-child { color: #c9c9d2 !important; }
  .playControls .volume__button, .playControls .volume__button * { color: #a6a6b0 !important; fill: currentColor !important; background: transparent !important; border-color: transparent !important; }
  .playControls .volume__button:hover, .playControls .volume__button:hover * { color: #fff !important; }
  .playControls .hoq-vol-pct { color: #8e8e99 !important; font: 500 11px Inter,-apple-system,Arial,sans-serif !important; font-variant-numeric: tabular-nums !important; }
  .playControls .playControls__play { border-radius: 10px !important; box-shadow: none !important; color: #fff !important;
    background-color: var(--sc-accent, #ff5500) !important; transition: filter .12s ease, transform .1s ease !important; }
  .playControls .playControls__play:hover { filter: brightness(1.1) !important; }
  .playControls .playControls__play:active { transform: scale(.95) !important; }
  .playControls .playControls__play svg { color: #fff !important; fill: #fff !important; }
  .playbackSoundBadge .playbackSoundBadge__titleLink, .playbackSoundBadge .playbackSoundBadge__titleLink span {
    background: none !important; -webkit-background-clip: border-box !important; background-clip: border-box !important;
    -webkit-text-fill-color: currentColor !important; color: #ececf1 !important; font-weight: 600 !important; text-shadow: none !important; }
  .playbackSoundBadge .playbackSoundBadge__lightLink { color: #8e8e99 !important; -webkit-text-fill-color: currentColor !important; background: none !important; }
  .playbackSoundBadge .playbackSoundBadge__titleLink:hover, .playbackSoundBadge .playbackSoundBadge__lightLink:hover { color: #fff !important; }
  .playbackSoundBadge__actions { display: flex !important; align-items: center !important; gap: 2px !important; }
  .playbackSoundBadge__actions > .sc-button, .playbackSoundBadge__actions > #hoq-ambient-btn,
  .playbackSoundBadge__actions > #hoq-playbtn, .playbackSoundBadge__actions > #hoq-share {
    display: inline-flex !important; align-items: center !important; justify-content: center !important;
    width: 32px !important; height: 32px !important; min-width: 0 !important; margin: 0 !important; padding: 0 !important;
    border: 0 !important; border-radius: 9px !important; background: transparent !important; box-shadow: none !important;
    color: #a6a6b0 !important; filter: none !important; transition: background .12s ease, color .12s ease !important; }
  .playbackSoundBadge__actions > .sc-button:hover, .playbackSoundBadge__actions > #hoq-ambient-btn:hover,
  .playbackSoundBadge__actions > #hoq-playbtn:hover, .playbackSoundBadge__actions > #hoq-share:hover {
    background: rgba(255,255,255,0.08) !important; color: #fff !important; }
  .playbackSoundBadge__actions > .sc-button svg, .playbackSoundBadge__actions > button svg { width: 16px !important; height: 16px !important; }
  .playbackSoundBadge__actions > .sc-button-like.sc-button-selected,
  .playbackSoundBadge__actions > .sc-button-follow.sc-button-selected { color: var(--sc-accent, #ff5500) !important; }
  .playbackSoundBadge__actions > #hoq-playbtn:hover { color: #7d86ff !important; }
  .playbackSoundBadge__actions > #hoq-playbtn.done { color: var(--sc-accent, #ff5500) !important; }
  /* hairline between SoundCloud's actions and ours (Discord) */
  .playbackSoundBadge__actions > #hoq-playbtn { position: relative !important; margin-left: 13px !important; }
  .playbackSoundBadge__actions > #hoq-playbtn::before { content: ''; position: absolute; left: -7px; top: 8px; bottom: 8px; width: 1px; background: rgba(255,255,255,0.12); }
  /* Upload: calm pill, no glow */
  .header a.uploadButton { height: 30px !important; padding: 0 14px !important; border-radius: 9px !important; margin: 0 !important;
    box-shadow: none !important; font-weight: 600 !important; transition: filter .12s ease !important; }
  .header a.uploadButton:hover { box-shadow: none !important; filter: brightness(1.12) !important; }
`;

// ---------------------------------------------------------------------------
// NEW ("webi V2") track page. It renders inside a same-origin iframe
// (soundcloud.com/n/<user>/<track>?v2_layout=true, class .webiIframeV2Layout)
// and is built entirely from MUI components, so none of the BEM selectors above
// reach it. Everything here is token-first: MUI reads its own CSS variables, so
// repointing the tokens themes whole component families at once.
// ---------------------------------------------------------------------------
const MUI_CSS = `
  /* --- design tokens -------------------------------------------------------
     SoundCloud ships these as a near-white ramp (#FAFAFA, then 0.6 / 0.16
     alphas). Repoint the whole ramp at the accent and every MUI surface that
     consumes it follows: buttons, chips, tabs, sliders, the waveform. */
  :root, html, [data-mui-color-scheme] {
    --mui-palette-primary-main: var(--sc-accent, #ff5500) !important;
    --mui-palette-primary-dark: color-mix(in srgb, var(--sc-accent, #ff5500) 78%, #000) !important;
    --mui-palette-primary-light: color-mix(in srgb, var(--sc-accent, #ff5500) 72%, #fff) !important;
    --mui-palette-primary-mainChannel: var(--sc-accent-ch, 255 85 0) !important;
    --mui-palette-primary-contrastText: #fff !important;

  }

  /* The track waveform is an <svg> of <rect>s painted straight from the
     "contrast" palette:
         contrastText -> played bars (and the playhead line)
         light        -> unplayed bars
         dark         -> the mirrored reflection under the centre line
     contrastTextChannel is consumed as rgba(var(--...) / .5) for the centre
     rule, so it MUST be space-separated channels — a hex can't satisfy it
     (applyAccent keeps --sc-accent-ch in sync).

     These have to stay SCOPED TO THE WAVEFORM. MUI paints the track header's
     text out of contrast-contrastText as well — the title, the artist/tag/date
     caption, the elapsed time, the like count — so repointing it on :root
     turned the whole header monochrome accent instead of white. The slider
     element wraps the bars AND both presentation rules (centre line, playhead),
     so scoping it here still reaches everything the waveform draws. */
  [aria-label="Waveform"] {
    --mui-palette-contrast-contrastText: var(--sc-accent, #ff5500) !important;
    --mui-palette-contrast-contrastTextChannel: var(--sc-accent-ch, 255 85 0) !important;
    --mui-palette-contrast-light: color-mix(in srgb, var(--sc-accent, #ff5500) 52%, transparent) !important;
    --mui-palette-contrast-dark: color-mix(in srgb, var(--sc-accent, #ff5500) 28%, transparent) !important;
  }

  /* Top-frame side of the same fix: the <iframe> element itself must not paint
     an opaque box over #sc-bg either. */
  .webiIframe, .webiIframeV2Layout { background: transparent !important; }
  /* SoundCloud's new Home (and other pages) now render inside these frames too;
     whatever wraps one in the main column must not lay its own grey shade over
     the cover background (it read as a lighter panel behind the whole Home page). */
  html:not(.hoq-webi) .l-main :has(> iframe[class*="webi"]),
  html:not(.hoq-webi) .l-main :has(iframe[class*="webiIframe"]):not(.l-main) {
    background: transparent !important; background-image: none !important; box-shadow: none !important;
    backdrop-filter: none !important; -webkit-backdrop-filter: none !important; border-color: transparent !important;
  }
  /* light, not normal: the frame's root is normal (see html.hoq-webi) and the two
     must match or the browser paints an opaque canvas under the frame. Normal on
     the element resolves to the PAGE's scheme, and the phone site declares dark
     (a meta tag), which turned Home's sections white there. Light is what normal
     already meant in the desktop app, which declares no scheme. */
  html:not(.hoq-webi) iframe[class*="webi"] { background: transparent !important; color-scheme: light !important; }

  /* --- buttons ------------------------------------------------------------- */
  .MuiButton-contained.MuiButton-colorPrimary {
    background: var(--sc-accent-bg, #ff5500) !important;
    background-color: var(--sc-accent, #ff5500) !important;
    color: #fff !important;
  }
  .MuiButton-contained.MuiButton-colorPrimary:hover { filter: brightness(1.12); }
  /* Hero play button: outlined + colorContrast. Fill it so it reads as the
     primary action the way the old .sc-button-play did. */
  .MuiButton-outlined.MuiButton-colorContrast {
    border-color: color-mix(in srgb, var(--sc-accent, #ff5500) 55%, transparent) !important;
    color: var(--sc-accent, #ff5500) !important;
  }
  .MuiButton-outlined.MuiButton-colorContrast:hover {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 16%, transparent) !important;
    border-color: var(--sc-accent, #ff5500) !important;
  }
  .MuiButton-text.MuiButton-colorPrimary { color: var(--sc-accent, #ff5500) !important; }

  /* --- icon buttons (share / link / repost / add / more / like) ------------- */
  .MuiIconButton-colorContrast {
    border: 1px solid color-mix(in srgb, var(--sc-accent, #ff5500) 26%, rgba(255,255,255,0.10)) !important;
  }
  .MuiIconButton-colorContrast:hover {
    color: var(--sc-accent, #ff5500) !important;
    border-color: var(--sc-accent, #ff5500) !important;
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 14%, transparent) !important;
  }
  .MuiIconButton-colorPrimary:hover { color: var(--sc-accent, #ff5500) !important; }

  /* --- chips: comment timestamps + tag pills -------------------------------- */
  .MuiChip-filled.MuiChip-colorSecondary {
    background-color: color-mix(in srgb, var(--sc-accent, #ff5500) 20%, transparent) !important;
    color: var(--sc-accent, #ff5500) !important;
    border: 1px solid color-mix(in srgb, var(--sc-accent, #ff5500) 32%, transparent) !important;
  }
  .MuiChip-filled.MuiChip-colorSecondary:hover {
    background-color: color-mix(in srgb, var(--sc-accent, #ff5500) 34%, transparent) !important;
  }
  .MuiChip-filled.MuiChip-colorSecondary .MuiChip-label,
  .MuiChip-filled.MuiChip-colorSecondary .MuiTypography-root { color: inherit !important; }

  /* --- tabs (Fans "Top" / "First") ------------------------------------------ */
  .MuiTab-root.Mui-selected { color: var(--sc-accent, #ff5500) !important; }
  .MuiTabs-indicator { background-color: var(--sc-accent, #ff5500) !important; }

  /* --- sliders (comment-position handle over the waveform) ------------------ */
  .MuiSlider-colorPrimary .MuiSlider-track {
    background-color: var(--sc-accent, #ff5500) !important;
    border-color: var(--sc-accent, #ff5500) !important;
  }
  .MuiSlider-colorPrimary .MuiSlider-thumb { color: var(--sc-accent, #ff5500) !important; }

  /* --- links ---------------------------------------------------------------- */
  .MuiLink-root:hover { color: var(--sc-accent, #ff5500) !important; }
  /* Links inside track descriptions / comment bodies are plain <a>, not MuiLink,
     so they keep MUI's default blue unless we claim them here. */
  .MuiTypography-body a, .MuiTypography-body2 a, .MuiTypography-caption a[href] {
    color: var(--sc-accent, #ff5500) !important;
  }

  /* --- comment box ---------------------------------------------------------- */
  .MuiOutlinedInput-root .MuiOutlinedInput-notchedOutline {
    border-color: rgba(255,255,255,0.10) !important;
  }
  .MuiOutlinedInput-root:hover .MuiOutlinedInput-notchedOutline {
    border-color: color-mix(in srgb, var(--sc-accent, #ff5500) 45%, transparent) !important;
  }
  .MuiOutlinedInput-root.Mui-focused .MuiOutlinedInput-notchedOutline {
    border-color: var(--sc-accent, #ff5500) !important; border-width: 1px !important;
  }
  .MuiInputBase-input { caret-color: var(--sc-accent, #ff5500) !important; }

  /* --- surfaces: cards + dividers match the app's frosted look -------------- */
  .MuiCard-root, .MuiPaper-contained {
    background: rgba(255,255,255,0.035) !important;
    border: 1px solid color-mix(in srgb, var(--sc-accent, #ff5500) 16%, rgba(255,255,255,0.07)) !important;
    border-radius: 12px !important; background-image: none !important;
  }
  .MuiDivider-root { border-color: rgba(255,255,255,0.08) !important; }

  /* --- per-row "Play in Discord" (addQueueButtons) --------------------------
     Lives in both documents, so it is defined outside the .hoq-webi scope. */
  .hoq-q:not(.hoq-q-in) {
    position: absolute; top: 8px; right: 8px; z-index: 20;
    height: 26px; min-width: 26px; padding: 0 6px; box-sizing: border-box; border-radius: 999px;
    display: inline-flex; align-items: center; justify-content: center;
    border: 1px solid rgba(255,255,255,0.12) !important; background: rgba(14,14,18,0.86) !important;
    color: #c9c9d2 !important; -webkit-text-fill-color: currentColor !important; cursor: pointer;
    font: 600 11.5px/1 Inter,-apple-system,Arial,sans-serif; white-space: nowrap;
    box-shadow: 0 2px 10px rgba(0,0,0,0.35);
    opacity: 0; transform: translateY(-2px);
    transition: opacity .15s ease, transform .15s ease, background .15s ease, color .15s ease, border-color .15s ease;
  }
  *:hover > .hoq-q:not(.hoq-q-in), .hoq-q:not(.hoq-q-in):focus-visible { opacity: 1; transform: none; }
  .hoq-q:not(.hoq-q-in) svg { width: 13px; height: 13px; flex: none; fill: currentColor; }
  .hoq-q:not(.hoq-q-in) span { max-width: 0; overflow: hidden; transition: max-width .2s ease, margin .2s ease; }
  .hoq-q:not(.hoq-q-in):hover { background: #5865f2 !important; border-color: transparent !important; color: #fff !important; }
  .hoq-q:not(.hoq-q-in):hover span, .hoq-q:not(.hoq-q-in).done span { max-width: 110px; margin-left: 6px; }
  .hoq-q:not(.hoq-q-in).done {
    background: var(--sc-accent, #ff5500) !important; color: #fff !important; opacity: 1;
    transform: none; border-color: transparent !important; cursor: default;
  }
  .hoq-q:not(.hoq-q-in).done svg { fill: none; }
  /* in the tile's action row: one more of SoundCloud's icon buttons */
  .hoq-q.hoq-q-in svg { width: 16px; height: 16px; fill: currentColor; }
  .hoq-q.hoq-q-in span { display: none !important; }
  .hoq-q.hoq-q-in:hover { color: #7d86ff !important; -webkit-text-fill-color: currentColor !important; }
  .hoq-q.hoq-q-in.done { color: var(--sc-accent, #ff5500) !important; cursor: default; }
  .hoq-q.hoq-q-in.done svg { fill: none; }
  /* --- per-row "Add to Jam" while in a jam (addJamButtons): same shapes,
     floating one sits left of the Discord one, accent instead of blurple */
  .hoq-jq:not(.hoq-jq-in) {
    position: absolute; top: 8px; right: 40px; z-index: 20;
    height: 26px; min-width: 26px; padding: 0 6px; box-sizing: border-box; border-radius: 999px;
    display: inline-flex; align-items: center; justify-content: center;
    border: 1px solid rgba(255,255,255,0.12) !important; background: rgba(14,14,18,0.86) !important;
    color: #c9c9d2 !important; -webkit-text-fill-color: currentColor !important; cursor: pointer;
    font: 600 11.5px/1 Inter,-apple-system,Arial,sans-serif; white-space: nowrap;
    box-shadow: 0 2px 10px rgba(0,0,0,0.35);
    opacity: 0; transform: translateY(-2px);
    transition: opacity .15s ease, transform .15s ease, background .15s ease, color .15s ease, border-color .15s ease;
  }
  *:hover > .hoq-jq:not(.hoq-jq-in), .hoq-jq:not(.hoq-jq-in):focus-visible, .hoq-jq:not(.hoq-jq-in).done { opacity: 1; transform: none; }
  .hoq-jq:not(.hoq-jq-in) svg { width: 13px; height: 13px; flex: none; }
  .hoq-jq:not(.hoq-jq-in) span { max-width: 0; overflow: hidden; transition: max-width .2s ease, margin .2s ease; }
  .hoq-jq:not(.hoq-jq-in):hover { background: var(--sc-accent, #ff5500) !important; border-color: transparent !important; color: #fff !important; }
  .hoq-jq:not(.hoq-jq-in):hover span, .hoq-jq:not(.hoq-jq-in).done span { max-width: 110px; margin-left: 6px; }
  .hoq-jq:not(.hoq-jq-in).done { background: var(--sc-accent, #ff5500) !important; color: #fff !important; border-color: transparent !important; cursor: default; }
  .hoq-jq.hoq-jq-in svg { width: 16px; height: 16px; }
  .hoq-jq.hoq-jq-in span { display: none !important; }
  .hoq-jq.hoq-jq-in:hover { color: var(--sc-accent, #ff5500) !important; -webkit-text-fill-color: currentColor !important; }
  .hoq-jq.hoq-jq-in.done { color: var(--sc-accent, #ff5500) !important; cursor: default; }

  /* --- webi V2 frame only --------------------------------------------------
     themeFrames() tags the iframe's document with .hoq-webi so these can't leak
     into the top frame (which paints its own background and would go see-through). */

  /* The iframe paints an opaque canvas over #sc-bg, which is why the cover
     background never showed behind the new page. Make it see-through so the
     frosted panels below have something to actually blur. */
  html.hoq-webi, html.hoq-webi body,
  html.hoq-webi #navigation-shell-right-side-container, html.hoq-webi #main {
    background: transparent !important; background-image: none !important;
  }
  /* THE reason the frame stayed black. With color-scheme:dark on an iframe's
     ROOT element, Chromium paints its own opaque dark canvas underneath the
     document — transparent backgrounds on html/body do not defeat it. Clearing
     it on the root lets #sc-bg show through; re-declaring it on <body> keeps
     form controls and scrollbars dark, since that only needs an ancestor. */
  html.hoq-webi { color-scheme: normal !important; }
  html.hoq-webi body { color-scheme: dark; }


  /* ===== New Home page (SoundCloud's MUI rewrite) — matched to the classic theme =====
     SoundCloud moved Home onto the new app; the generic card rule above boxed
     every tile in a tinted border. Here: shelf tiles are bare rounded artwork
     (like the classic tiles), the rest are soft panels, headings and tile titles
     take the accent the classic pages use, genre chips use the tag style. */
  html.hoq-webi [aria-label="Home"] h2.MuiTypography-root {
    color: color-mix(in srgb, var(--sc-accent, #ff5500) 60%, #fff) !important;
    font-size: 20px !important; font-weight: 700 !important; letter-spacing: -0.01em !important;
    text-shadow: 0 0 18px color-mix(in srgb, var(--sc-accent, #ff5500) 45%, transparent) !important;
  }
  /* every Home card: a soft panel (no accent border, no frost) */
  html.hoq-webi [aria-label="Home"] .MuiCard-root {
    background: rgba(255,255,255,0.04) !important; border: 1px solid rgba(255,255,255,0.06) !important;
    border-radius: 12px !important; box-shadow: none !important;
    backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
    transition: background .14s ease, border-color .14s ease !important;
  }
  html.hoq-webi [aria-label="Home"] .MuiCard-root:hover { background: rgba(255,255,255,0.075) !important; border-color: rgba(255,255,255,0.1) !important; }
  /* shelf tiles (big artwork): no box at all, rounded art that lifts on hover */
  html.hoq-webi [aria-label="Home"] .MuiCard-root:has(img[sizes*="200px"]) {
    background: transparent !important; border: 0 !important; border-radius: 0 !important; overflow: visible !important;
  }
  html.hoq-webi [aria-label="Home"] .MuiCard-root:has(img[sizes*="200px"]):hover { background: transparent !important; }
  /* round + shadow + hover lift go on the box that holds BOTH the cover and the
     play overlay. Lifting only the image left the overlay behind, and its bottom
     3px stuck out under the cover as a dark strip. */
  html.hoq-webi [aria-label="Home"] .MuiCard-root:has(img[sizes*="200px"]) div:has(> img[sizes*="200px"]) {
    border-radius: 10px !important; overflow: hidden !important;
  }
  html.hoq-webi [aria-label="Home"] .MuiCard-root:has(img[sizes*="200px"]) div:has(> .entity-card__play-overlay) {
    border-radius: 10px !important; overflow: hidden !important;
    box-shadow: 0 6px 18px rgba(0,0,0,0.35) !important; transition: transform .18s ease, box-shadow .18s ease !important;
  }
  html.hoq-webi [aria-label="Home"] .MuiCard-root:has(img[sizes*="200px"]):hover div:has(> .entity-card__play-overlay) {
    transform: translateY(-3px); box-shadow: 0 10px 24px rgba(0,0,0,0.45) !important;
  }
  html.hoq-webi [aria-label="Home"] .entity-card__play-overlay { border-radius: 10px !important; }
  html.hoq-webi [aria-label="Home"] img[sizes*="200px"] { border-radius: 10px !important; }
  /* tile titles take the accent (like "Buzzing Mexico" on the classic pages); captions stay grey */
  html.hoq-webi [aria-label="Home"] .MuiCard-root:has(img[sizes*="200px"]) .MuiTypography-h4 {
    color: color-mix(in srgb, var(--sc-accent, #ff5500) 65%, #fff) !important;
  }
  html.hoq-webi [aria-label="Home"] .MuiCard-root .MuiTypography-body,
  html.hoq-webi [aria-label="Home"] .MuiCard-root a.MuiLink-root { color: #a6a6b0 !important; }
  html.hoq-webi [aria-label="Home"] .MuiCard-root a.MuiLink-root:hover { color: #fff !important; }
  /* "Your likes" and other card headings: white, not the accent */
  html.hoq-webi [aria-label="Home"] p.MuiTypography-h3 { color: #fff !important; }
  /* compact track rows (Trending by genre, Liked by people you follow): SoundCloud
     lays them out as a 3-row grid with 16px between columns but 0 between rows,
     so the cards touched. Same breathing room both ways. */
  html.hoq-webi [aria-label="Home"] ul:has(> li > .MuiCard-root img[sizes="48px"]) { row-gap: 10px !important; }
  /* compact rows + feature cards: round art */
  html.hoq-webi [aria-label="Home"] img[sizes="48px"], html.hoq-webi [aria-label="Home"] img[sizes="64px"],
  html.hoq-webi [aria-label="Home"] img[sizes="104px"], html.hoq-webi [aria-label="Home"] img[sizes="120px"],
  html.hoq-webi [aria-label="Home"] img[sizes="128px"] { border-radius: 8px !important; }
  /* genre chips: the tag look ("# Trap"), solid accent when picked */
  html.hoq-webi [aria-label="Home"] .MuiChip-root {
    height: 30px !important; border-radius: 8px !important;
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 14%, transparent) !important;
    border: 1px solid color-mix(in srgb, var(--sc-accent, #ff5500) 35%, transparent) !important;
    color: color-mix(in srgb, var(--sc-accent, #ff5500) 45%, #fff) !important;
    transition: background .12s ease, border-color .12s ease, color .12s ease !important;
  }
  html.hoq-webi [aria-label="Home"] .MuiChip-root:hover {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 24%, transparent) !important;
    border-color: color-mix(in srgb, var(--sc-accent, #ff5500) 55%, transparent) !important; color: #fff !important;
  }
  html.hoq-webi [aria-label="Home"] .MuiChip-filled {
    background: var(--sc-accent, #ff5500) !important; border-color: transparent !important; color: #fff !important;
  }
  html.hoq-webi [aria-label="Home"] .MuiChip-label { color: inherit !important; font-weight: 600 !important; font-size: 12.5px !important;
    text-transform: none !important; letter-spacing: 0 !important; padding: 0 12px !important; }
  /* hover on a tile: SoundCloud dims the whole cover and floats a big washed-out
     play disc in the middle. Classic look instead: the art stays bright (a light
     gradient at the bottom only) and a small solid accent play button sits in
     the bottom-right corner. */
  html.hoq-webi .entity-card__play-overlay {
    background: linear-gradient(to top, rgba(0,0,0,0.42), rgba(0,0,0,0) 55%) !important;
    display: flex !important; align-items: flex-end !important; justify-content: flex-end !important;
    padding: 10px !important; box-sizing: border-box !important; backdrop-filter: none !important;
  }
  /* pinned to the cover's bottom-right corner; SoundCloud's own hover motion on
     these wrappers (it slides the button in) is cancelled, or the button ended
     up half below the cover's edge */
  html.hoq-webi .entity-card__play-overlay { transform: none !important; }
  html.hoq-webi .entity-card__play-overlay > span {
    display: block !important; position: absolute !important; right: 10px !important; bottom: 10px !important;
    top: auto !important; left: auto !important; margin: 0 !important; transform: none !important; translate: none !important;
  }
  html.hoq-webi .entity-card__play-button {
    position: static !important; width: 40px !important; height: 40px !important; min-width: 0 !important; margin: 0 !important;
    border-radius: 50% !important; background: transparent !important; opacity: 1 !important;
    transform: none !important; translate: none !important;
  }
  html.hoq-webi .entity-card__play-button > span { display: block !important; transform: none !important; translate: none !important; }
  html.hoq-webi .entity-card__play-button button.MuiButton-root {
    width: 40px !important; height: 40px !important; min-width: 0 !important; padding: 0 !important;
    border-radius: 50% !important; background: var(--sc-accent-bg, var(--sc-accent, #ff5500)) !important; color: #fff !important;
    box-shadow: 0 4px 14px rgba(0,0,0,0.45) !important; opacity: 1 !important;   /* same gradient as the classic tiles' play buttons */
  }
  html.hoq-webi .entity-card__play-button button.MuiButton-root:hover { filter: brightness(1.12) !important; }
  html.hoq-webi .entity-card__play-button button.MuiButton-root svg { width: 18px !important; height: 18px !important; color: #fff !important; fill: #fff !important; }
  /* "Latest from artists you follow": SoundCloud paints an orange-pink-purple brand
     gradient frame (the card's last layer); take the accent instead */
  html.hoq-webi [aria-label="Home"] li:has(img[sizes="320px"]) > div > div:last-child {
    background: linear-gradient(135deg, var(--sc-accent, #ff5500), color-mix(in srgb, var(--sc-accent, #ff5500) 55%, #fff)) !important;
  }

  /* Panels pick up the same acrylic as the rest of the app. */
  html.hoq-webi.sc-coverbg section[aria-label="Track header"],
  html.hoq-webi.sc-coverbg aside[aria-label="Track sidebar"] .MuiCard-root,
  html.hoq-webi.sc-coverbg aside[aria-label="Track sidebar"] .MuiPaper-contained {
    background: rgba(12,12,14,0.3) !important;
    backdrop-filter: blur(24px) saturate(1.35) !important;
    -webkit-backdrop-filter: blur(24px) saturate(1.35) !important;
    border: 1px solid color-mix(in srgb, var(--sc-accent, #ff5500) 16%, rgba(255,255,255,0.08)) !important;
    border-radius: 14px !important;
  }
  /* Full-page pop-ups from the new SoundCloud app (Upload, ...): see-through
     backdrop so the blurred cover shows, frosted cards, and the header kept
     clear of the app's window buttons in the top-right corner.
     .hoq-fullpage / .hoq-surf are tagged by tagFullPage(). */
  html.hoq-webi.sc-coverbg .MuiModal-root.hoq-fullpage { background: rgba(10,10,12,0.42) !important; }
  html.hoq-webi.sc-coverbg .hoq-clear { background: transparent !important; }
  html.hoq-webi .MuiModal-root.hoq-fullpage header { background: transparent !important; padding-right: 150px !important; }
  html.hoq-webi.sc-coverbg .MuiModal-root.hoq-fullpage .hoq-surf {
    background: rgba(12,12,14,0.55) !important;
    border: 1px solid color-mix(in srgb, var(--sc-accent, #ff5500) 16%, rgba(255,255,255,0.08)) !important;
  }
  /* Inner wrappers ship their own solid fills that would sit on top of the blur. */
  html.hoq-webi section[aria-label="Track header"] > .MuiStack-root,
  html.hoq-webi section[aria-label="Track header"] .MuiStack-root > .MuiStack-root {
    background: transparent !important; background-image: none !important;
  }

  /* --- waveform: SVG <rect>s, not the legacy <canvas> ----------------------
     buildCustomWave() can't reach these (it reads canvas pixels), so instead of
     replacing the bars we restyle them to read like .hoq-wave: capsule caps and
     an accent glow. Keeping SC's own SVG means seeking and the comment markers
     keep working. The glow goes on the parent <g>, not per-rect — there are 500+
     rects and a filter on each one is a separate composite. */
  html.hoq-webi [aria-label="Waveform"] rect {
    rx: 1.2px; ry: 1.2px;
    /* fill-box so the hover ripple's scaleY pivots on each bar's own centre */
    transform-box: fill-box; transform-origin: center;
    transition: transform .12s ease;
  }
  html.hoq-webi [aria-label="Waveform"] svg > g {
    filter: drop-shadow(0 0 2.5px color-mix(in srgb, var(--sc-accent, #ff5500) 42%, transparent));
  }
  html.hoq-no-wave [aria-label="Waveform"] rect { transform: none !important; }

  /* --- hero play button: the same moulded accent lozenge as the legacy page --- */
  html.hoq-webi section[aria-label="Track header"] .MuiButton-outlined.MuiButton-colorContrast {
    background: linear-gradient(145deg, var(--sc-accent, #ff5500),
                color-mix(in srgb, var(--sc-accent, #ff5500) 65%, #000)) !important;
    border: 0 !important; border-radius: 16px !important; color: #fff !important;
    box-shadow: 0 10px 26px color-mix(in srgb, var(--sc-accent, #ff5500) 50%, transparent),
                inset 0 1px 0 rgba(255,255,255,0.35) !important;
    transition: transform .14s ease, box-shadow .14s ease !important;
  }
  html.hoq-webi section[aria-label="Track header"] .MuiButton-outlined.MuiButton-colorContrast:hover {
    transform: scale(1.07) !important;
    box-shadow: 0 14px 34px color-mix(in srgb, var(--sc-accent, #ff5500) 65%, transparent),
                inset 0 1px 0 rgba(255,255,255,0.45) !important;
  }

  /* --- section headings: accent rule + glow, matching .sectionHead__title ----- */
  html.hoq-webi h2.MuiTypography-h5 {
    font-weight: 800 !important; letter-spacing: .2px !important; color: #fff !important;
    padding-left: 13px !important; position: relative !important;
    text-shadow: 0 0 18px color-mix(in srgb, var(--sc-accent, #ff5500) 45%, transparent);
  }
  html.hoq-webi h2.MuiTypography-h5::before {
    content: '' !important; position: absolute !important; left: 0 !important;
    top: 16% !important; bottom: 16% !important;
    width: 4px !important; border-radius: 3px !important;
    background: var(--sc-accent, #ff5500) !important;
  }
  html.hoq-no-glow h2.MuiTypography-h5 { text-shadow: none !important; }

  /* --- sidebar: stat numbers + support heading carry the accent -------------- */
  html.hoq-webi aside[aria-label="Track sidebar"] .MuiTypography-h2 {
    color: var(--sc-accent, #ff5500) !important;
  }

  /* --- rows lift toward the cursor like the legacy sound badges -------------- */
  html.hoq-webi [role="listitem"] {
    border-radius: 12px !important;
    transition: transform .14s ease, background-color .14s ease !important;
  }
  html.hoq-webi:not(.hoq-no-hover) [role="listitem"]:hover {
    transform: translateY(-2px) !important;
    background-color: color-mix(in srgb, var(--sc-accent, #ff5500) 10%, transparent) !important;
  }

  /* --- cover wash: bleed the artwork's colour into the hero, radially masked
         so it fades out instead of ending on a hard rounded edge --------------- */
  html.hoq-webi.sc-coverbg section[aria-label="Track header"] { position: relative !important; }
  html.hoq-webi.sc-coverbg section[aria-label="Track header"]::before {
    content: ''; position: absolute; inset: 0; pointer-events: none; z-index: 0;
    border-radius: inherit;
    background: radial-gradient(78% 78% at 50% 30%,
      color-mix(in srgb, var(--sc-accent, #ff5500) 26%, transparent), transparent 70%);
  }
  html.hoq-webi section[aria-label="Track header"] > * { position: relative; z-index: 1; }

  /* --- track header polish -------------------------------------------------
     Anchored on aria-label and MUI's stable API classes; the mui-xxxxx hashes
     are emotion-generated and already changed once between SoundCloud builds. */
  html.hoq-webi section[aria-label="Track header"] {
    border-radius: 16px !important;
    padding: 20px 22px !important;
  }
  /* The frame begins flush under the app's top bar, so the header card's top
     edge and border collided with the chrome. Gap it off, matching the 20px the
     layout already leaves down each side. #main sits inside the scroll
     container, so the gap scrolls away with the content.
     SoundCloud is migrating more pages into these frames, so the gap is keyed
     to a header actually being there. The bounded "> * >" keeps the :has() off
     a whole-subtree scan. */
  html.hoq-webi #main:has(> * > section[aria-label="Track header"]) {
    padding-top: 16px !important;
  }
  html.hoq-webi section[aria-label="Track header"] h1.MuiTypography-h1 {
    line-height: 1.14 !important;
    letter-spacing: -0.2px !important;
    text-shadow: 0 2px 16px rgba(0,0,0,0.5);
  }
  /* The comment markers sit right under the waveform; give the pair room so the
     header doesn't read as one cramped block. */
  html.hoq-webi section[aria-label="Track header"] [aria-label="Waveform"] {
    margin-top: 4px !important;
  }
  /* Comment box: match the pill shape of the action buttons beside it. */
  html.hoq-webi section[aria-label="Track header"] .MuiOutlinedInput-root {
    border-radius: 999px !important;
    background: rgba(255,255,255,0.05) !important;
  }
  /* Give the like count and action circles a consistent weight. */
  html.hoq-webi section[aria-label="Track header"] .MuiIconButton-colorContrast {
    background: rgba(255,255,255,0.04) !important;
  }

  /* --- artwork: let the 3D tilt actually show ------------------------------
     The wrapper chain clips and flattens by default, so the rotate would be
     sheared off at the card edge. overflow:visible has to go on the GRANDparent
     — putting it on the frame that holds the <img> is what let the artwork
     spill past its own rounded corners. */
  html.hoq-webi section[aria-label="Track header"] .MuiBox-root:has(> .MuiBox-root > img[src*="artworks-"]) {
    overflow: visible !important;
  }
  /* The frame itself keeps clipping; the shadow still paints outside it. */
  html.hoq-webi section[aria-label="Track header"] .MuiBox-root:has(> img[src*="artworks-"]) {
    overflow: hidden !important; border-radius: 12px;
    transform-style: preserve-3d; will-change: transform;
    box-shadow: 0 18px 44px rgba(0,0,0,0.55),
                0 0 0 1px color-mix(in srgb, var(--sc-accent, #ff5500) 22%, transparent);
  }
  html.hoq-webi section[aria-label="Track header"] img[src*="artworks-"] {
    border-radius: 12px; cursor: pointer;
  }

  /* --- track sidebar panels ------------------------------------------------
     The artist card and the three stat tiles are plain MuiStack/MuiBox, NOT
     MuiCard/MuiPaper, so the acrylic rule further up never reached them: they
     stayed on SoundCloud's flat #212121 while the header went frosted. Anchor
     on what each panel actually contains. The 64px on the avatar is load
     bearing — without it the same shape also matches the "N others like this"
     row, which is transparent by design and should stay that way. */
  html.hoq-webi.sc-coverbg aside[aria-label="Track sidebar"] .MuiStack-root:has(> .MuiStack-root > a > img[sizes="64px"]),
  html.hoq-webi.sc-coverbg aside[aria-label="Track sidebar"] .MuiStack-root:has(> .MuiTypography-h2) {
    background: rgba(12,12,14,0.3) !important;
    backdrop-filter: blur(24px) saturate(1.35) !important;
    -webkit-backdrop-filter: blur(24px) saturate(1.35) !important;
    border: 1px solid color-mix(in srgb, var(--sc-accent, #ff5500) 16%, rgba(255,255,255,0.08)) !important;
    border-radius: 14px !important;
  }

  /* --- track header action row ---------------------------------------------
     Like / comment field / share / copy / repost / playlist / more. The circles
     are 42px with a 1px accent edge, but MUI draws the comment field's border
     on its <fieldset>, not on the input root — so the field rendered 40px tall
     and apparently borderless beside them. Two pixels out and one missing edge
     reads as a mistake rather than a choice; put the row on one height and one
     edge. */
  html.hoq-webi section[aria-label="Track header"] .MuiOutlinedInput-root {
    min-height: 42px !important;
  }
  html.hoq-webi section[aria-label="Track header"] .MuiOutlinedInput-notchedOutline {
    border-color: color-mix(in srgb, var(--sc-accent, #ff5500) 26%, rgba(255,255,255,0.10)) !important;
  }
  /* Liked reads as accent, the way the player bar's heart already does. */
  html.hoq-webi section[aria-label="Track header"] button[aria-label="Unlike"] {
    color: var(--sc-accent, #ff5500) !important;
    border-color: color-mix(in srgb, var(--sc-accent, #ff5500) 55%, transparent) !important;
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 12%, transparent) !important;
  }
`;

function injectBaseCSS() {
  if (document.getElementById('sc-desktop-style')) return;
  const style = document.createElement('style');
  style.id = 'sc-desktop-style';
  style.textContent = BASE_CSS + MUI_CSS;
  (document.head || document.documentElement).appendChild(style);
}

// The legacy waveform's signature hover ripple, ported onto the SVG bars. Only
// the bars inside the ripple window get written to — there are 500+ rects, so
// transforming all of them every frame would be pure waste — and the previous
// window is cleared as the cursor moves on. Bars come in top/bottom pairs, so
// adjacent indices scale together, which is exactly the mirrored look we want.
function attachWaveRipple(d) {
  if (d.__hoqRipple) return;
  d.__hoqRipple = true;
  const view = d.defaultView || window;
  const W = 0.08; // ripple reaches ~8% of the waveform either side of the cursor
  let raf = 0, mx = -1, prev = null;
  const run = () => {
    raf = 0;
    const svg = d.querySelector('[aria-label="Waveform"] svg');
    if (!svg) return;
    const rects = svg.querySelectorAll('rect');
    const N = rects.length;
    if (!N) return;
    const clear = (r) => { if (r) for (let i = r[0]; i <= r[1] && i < N; i++) rects[i].style.transform = ''; };
    if (mx < 0 || !effectOn('wave')) { clear(prev); prev = null; return; }
    const lo = Math.max(0, Math.floor((mx - W) * N));
    const hi = Math.min(N - 1, Math.ceil((mx + W) * N));
    clear(prev);
    for (let i = lo; i <= hi; i++) {
      const boost = 1 - Math.min(1, Math.abs(i / N - mx) / W);
      rects[i].style.transform = boost > 0 ? 'scaleY(' + (1 + boost * 0.5).toFixed(3) + ')' : '';
    }
    prev = [lo, hi];
  };
  const schedule = () => { if (!raf) raf = view.requestAnimationFrame(run); };
  d.addEventListener('mousemove', (e) => {
    const wf = d.querySelector('[aria-label="Waveform"]');
    if (!wf) { if (mx !== -1) { mx = -1; schedule(); } return; }
    const r = wf.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right &&
                   e.clientY >= r.top && e.clientY <= r.bottom;
    const nx = inside ? (e.clientX - r.left) / r.width : -1;
    if (nx !== mx) { mx = nx; schedule(); }
  }, { passive: true });
  d.addEventListener('mouseleave', () => { mx = -1; schedule(); }, { passive: true });
}

// setupCoverTilt() only listens in the top frame and only knows the legacy
// .fullHero__artwork, so the new page's cover sat there inert. Same 3D follow,
// re-bound inside the frame and hung off the artwork's wrapper so the whole card
// tilts rather than just the <img>.
function attachCoverTilt(d) {
  if (d.__hoqTilt) return;
  d.__hoqTilt = true;
  const view = d.defaultView || window;
  let art = null, px = 0, py = 0, raf = 0;
  const apply = () => {
    raf = 0;
    if (art) {
      art.style.transform =
        'perspective(1000px) rotateY(' + (px * 17).toFixed(2) + 'deg) rotateX(' +
        (-py * 12).toFixed(2) + 'deg) scale(1.02)';
    }
  };
  d.addEventListener('mousemove', (e) => {
    if (!effectOn('tilt')) {
      if (art) { art.style.transition = 'transform .4s ease'; art.style.transform = ''; art = null; }
      return;
    }
    const img = e.target.closest && e.target.closest(
      'section[aria-label="Track header"] img[fetchpriority="high"][crossorigin], ' +
      'section[aria-label="Track header"] img[src*="artworks-"]');
    const a = img ? img.parentElement : null;
    if (a !== art) {
      if (art) { art.style.transition = 'transform .4s ease'; art.style.transform = ''; }
      art = a;
      if (art) { art.style.transition = 'transform .1s ease'; art.style.willChange = 'transform'; }
    }
    if (!art) return;
    const r = art.getBoundingClientRect();
    px = (e.clientX - r.left) / r.width - 0.5;
    py = (e.clientY - r.top) / r.height - 0.5;
    if (!raf) raf = view.requestAnimationFrame(apply);
  }, { passive: true });
  d.addEventListener('mouseleave', () => {
    if (art) { art.style.transition = 'transform .4s ease'; art.style.transform = ''; art = null; }
  }, { passive: true });
}

// The webi V2 iframe does not reliably receive the injected preload, and even
// when it does it reads the SAVED accent from localStorage — so cover-match
// never reaches it. Pushing the stylesheet and the live accent vars in from the
// top frame fixes both at once, and survives the iframe re-navigating.
function themeFrames() {
  if (window.top !== window) return;
  const cs = getComputedStyle(document.documentElement);
  const vars = ['--sc-accent', '--sc-accent-bg', '--sc-accent-ch', '--wave-color'];
  let fullPage = false;   // a full-screen page from the new app is open (Upload...)
  document.querySelectorAll('iframe').forEach((f) => {
    let d = null;
    try { d = f.contentDocument; } catch (e) { return; } // cross-origin: not ours
    if (!d || !d.documentElement) return;
    try {
      if (!d.getElementById('sc-desktop-style')) {
        const st = d.createElement('style');
        st.id = 'sc-desktop-style';
        st.textContent = BASE_CSS + MUI_CSS;
        (d.head || d.documentElement).appendChild(st);
      }
      vars.forEach((v) => {
        const val = cs.getPropertyValue(v);
        if (val) d.documentElement.style.setProperty(v, val.trim(), 'important');
      });
      // Mirror OUR html classes across. The frosted-glass rules are gated on
      // .sc-coverbg and the optional effects on .hoq-*, and the iframe's own
      // <html> never gets them — which is why the new page stayed unfrosted.
      // Only our own tokens move; SoundCloud's classes on that element stay put.
      const mine = [...document.documentElement.classList].filter((c) => /^(sc-|hoq-)/.test(c));
      [...d.documentElement.classList].forEach((c) => {
        if (/^(sc-|hoq-)/.test(c) && c !== 'hoq-webi' && !mine.includes(c)) {
          d.documentElement.classList.remove(c);
        }
      });
      mine.forEach((c) => d.documentElement.classList.add(c));
      d.documentElement.classList.add('hoq-webi'); // scopes the frame-only rules
      attachWaveRipple(d);
      attachCoverTilt(d);
      addQueueButtons(d);
      addJamButtons(d);
      attachFrameContextMenu(d, f);
      attachGoPress(d);   // a play press in the new app's pages that opens the Go+ page
      attachScLinkGuard(d);   // phone site: its soundcloud.com links stay in the app
      // only while that frame is actually on screen (it stays loaded, hidden, on other pages)
      const fr = f.getBoundingClientRect();
      if (tagFullPage(d) && fr.width > 0 && fr.height > 0 && getComputedStyle(f).visibility !== 'hidden' && getComputedStyle(f).opacity !== '0') fullPage = true;
    } catch (e) {}
  });
  // Its see-through backdrop would show our header and player as ghosts behind it.
  document.documentElement.classList.toggle('hoq-webi-full', fullPage);
}

// ---------------------------------------------------------------------------
// Accent (color / gradient) — persisted in localStorage
// ---------------------------------------------------------------------------
const DEFAULT_ACCENT = { c1: '#ff5500', c2: '#ff8800', grad: false };

const ACCENT_VAR = 'var(--sc-accent, #ff5500)';

// Elements already repainted (so we don't re-scan them every tick). NOT permanent:
// SoundCloud is an SPA and its newer MUI surfaces resolve their theme tokens AFTER
// hydration, so an element can turn orange long after we first walked past it. We
// forget the whole cache on navigation, and forget individual elements when their
// class/style changes (see the attribute observer below).
let _seenOrange = new WeakSet();
let _seenPath = location.pathname;

// Is a computed value SoundCloud-orange? (matches #ff5500/#ff3300/#ff7700-ish, but
// not the red close button, reds, or ambers/yellows.) Scans EVERY color in the
// string, not just the first — gradients and box-shadows carry several.
//   b <= 90 (was 30) picks up the newer MUI tokens and color-mix() results whose
//   blue channel drifts up, while g - b > 35 is what keeps red out: SC orange has
//   green well above blue (#ff5500 -> 85), the red close button does not
//   (#ff5f57 -> 8).
function isOrange(str) {
  const re = /rgba?\((\d+),\s*(\d+),\s*(\d+)/g;
  let m;
  while ((m = re.exec(str || ''))) {
    const r = +m[1], g = +m[2], b = +m[3];
    if (r >= 235 && g >= 30 && g <= 140 && b <= 90 && g - b > 35) return true;
  }
  return false;
}

// Map one orange stop onto the accent while PRESERVING its lightness relative to
// SoundCloud's base #ff5500. Without this a two-tone orange gradient collapses to
// one flat accent and the badge/pill loses its depth.
function accentStop(r, g, b, a) {
  const lum = (rr, gg, bb) => (0.2126 * rr + 0.7152 * gg + 0.0722 * bb) / 255;
  const d = lum(r, g, b) - lum(255, 85, 0);
  let col = ACCENT_VAR;
  if (d > 0.04) col = 'color-mix(in srgb, ' + ACCENT_VAR + ' ' + Math.max(35, Math.round(100 - d * 160)) + '%, #fff)';
  else if (d < -0.04) col = 'color-mix(in srgb, ' + ACCENT_VAR + ' ' + Math.max(35, Math.round(100 + d * 160)) + '%, #000)';
  // Keep any alpha the original stop carried (shadows lean on it heavily).
  if (a != null && a < 1) col = 'color-mix(in srgb, ' + col + ' ' + Math.round(a * 100) + '%, transparent)';
  return col;
}

// Swap only the orange stops of a gradient/shadow, keeping its shape intact.
function accentize(value) {
  return value.replace(/rgba?\(([^)]*)\)/g, (whole, inner) => {
    if (!isOrange(whole)) return whole;
    const p = inner.split(',').map((n) => parseFloat(n));
    return accentStop(p[0], p[1], p[2], p.length > 3 ? p[3] : null);
  });
}

// Repaint any orange badge/dot/text to the current accent.
function recolorOrange() {
  if (_seenPath !== location.pathname) { _seenPath = location.pathname; _seenOrange = new WeakSet(); }
  const els = document.querySelectorAll('*');
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    // The phone UI's own elements (#hoq-tabs ...) are painted from the accent
    // already; repainting them inline froze their on/off states (a tab stayed lit).
    if (_seenOrange.has(el) || el.id === 'sc-titlebar' || el.closest('#sc-titlebar, #sc-palette, .header__upsellWrapper, .header__forArtistsButton, .hoq-q, #hoq-pf-tools, #hoq-pf-you, #hoq-out-btn, .hoq-hdr-icon, .notificationIcon__badge, .playbackTimeline__timePassed, .playbackTimeline__duration, .volume__button, .playControls__play, .playbackSoundBadge, .hoq-vol-pop, #hoq-tabs, #hoq-pill, #hoq-mnp, #hoq-acts, #hoq-mtoast, #hoq-signin-cta, #hoq-signin-sheet')) {
      continue;
    }
    _seenOrange.add(el);
    const cs = getComputedStyle(el);
    let painted = false;
    const paint = (prop, val) => { el.style.setProperty(prop, val, 'important'); painted = true; };
    if (isOrange(cs.backgroundColor)) paint('background-color', ACCENT_VAR);
    if (isOrange(cs.color)) paint('color', ACCENT_VAR);
    if (isOrange(cs.borderTopColor)) paint('border-color', ACCENT_VAR);
    // SVG icons: SoundCloud paints a lot of them with an inline fill="#f50", which
    // no stylesheet rule of ours reaches without a bespoke per-icon selector.
    if (isOrange(cs.fill)) paint('fill', ACCENT_VAR);
    if (isOrange(cs.stroke)) paint('stroke', ACCENT_VAR);
    // Gradients live in background-image, so background-color never sees them —
    // this is what left the Go+ tier badge (.tierIndicator__*) orange.
    if (cs.backgroundImage && cs.backgroundImage !== 'none' && isOrange(cs.backgroundImage)) {
      paint('background-image', accentize(cs.backgroundImage));
    }
    if (isOrange(cs.boxShadow)) paint('box-shadow', accentize(cs.boxShadow));
    if (painted) el.dataset.hoqPaint = '1';
  }
}

// Re-queue elements whose class/style changed so a late theme pass can't leave
// orange behind. Our own repaint writes to style, so ignore those or an element
// we just painted would loop back in forever. Top frame only — recolorOrange()
// runs from removeClutter(), which boot() skips in subframes.
if (window.top === window) {
  try {
    new MutationObserver((muts) => {
      for (let i = 0; i < muts.length; i++) {
        const t = muts[i].target;
        if (!t || t.nodeType !== 1) continue;
        if (muts[i].attributeName === 'style' && t.dataset && t.dataset.hoqPaint) continue;
        _seenOrange.delete(t);
      }
    }).observe(document.documentElement, {
      attributes: true, subtree: true, attributeFilter: ['class', 'style'],
    });
  } catch (e) {}
}

function readAccent() {
  try {
    return { ...DEFAULT_ACCENT, ...JSON.parse(localStorage.getItem('scAccent')) };
  } catch {
    return { ...DEFAULT_ACCENT };
  }
}

// Hue (degrees) of a hex color — used to hue-rotate the canvas waveform.
function hexToHue(hex) {
  let h = (hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  let hue;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  hue *= 60;
  return hue < 0 ? hue + 360 : hue;
}

function applyAccent(a, dontSave) {
  const bg = a.grad ? `linear-gradient(135deg, ${a.c1}, ${a.c2})` : a.c1;
  const root = document.documentElement;
  root.style.setProperty('--sc-accent', a.c1);
  root.style.setProperty('--sc-accent-bg', bg);
  // MUI's newer tokens are consumed as rgba(var(--...Channel) / alpha), which a
  // hex value cannot satisfy — keep space-separated channels alongside.
  try { root.style.setProperty('--sc-accent-ch', _hexToRgb(a.c1).join(' ')); } catch (e) {}
  if (!dontSave) localStorage.setItem('scAccent', JSON.stringify(a));
  try { themeFrames(); } catch (e) {}
}

// The waveform's played color follows the CURRENTLY PLAYING song's cover (not the
// selected accent) — hue-rotate SoundCloud's ~19° orange toward the cover's hue.
function setWaveHue(hex) {
  // our waveform's played bars follow the current cover color
  if (hex) document.documentElement.style.setProperty('--wave-color', hex);
}

// Build our OWN waveform: read the bar shape from SoundCloud's canvas, render our
// own bars over it (colored by the accent), and hide SC's canvas (kept beneath so
// clicks still seek). Rebuilds on track change; progress updates on a tick.
function buildCustomWave() {
  // The main track-page waveform on ANY layout (newer "webi" or classic A/B group):
  // pick the widest .waveform that isn't a comment/modal/dropdown/share popup.
  const wf = document.querySelector('.fullListenHero .waveform, .fullHero .waveform') ||
    Array.from(document.querySelectorAll('.waveform'))
      .filter((w) => !w.closest('.modal, .dropdownMenu, .commentPopover, [class*="share" i]') &&
        w.getBoundingClientRect().width > 400)
      .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
  if (!wf) return;
  if (wf.getBoundingClientRect().width < 300) return;
  const canvas = wf.querySelector('canvas');
  if (!canvas || !canvas.width) return;
  const existing = wf.querySelector(':scope > .hoq-wave');

  // While a new song loads, SoundCloud first paints a PLACEHOLDER (a flat line
  // with a bump in the middle) and only adds .loaded once the real waveform is
  // drawn. Copying the placeholder left a flat waveform that never updated, so
  // until then drop our copy and let SoundCloud's own loading state show.
  if (!wf.classList.contains('loaded')) {
    if (existing) existing.remove();
    wf.classList.remove('hoq-cw');
    return;
  }
  // canvas identity in the key: a re-rendered waveform gets a new canvas
  if (!canvas.__hoqId) canvas.__hoqId = Math.random().toString(36).slice(2, 8);
  const key = (currentCoverUrl() || location.pathname) + ':' + canvas.width + ':' + canvas.__hoqId;
  if (existing && existing.dataset.key === key) { updateWaveProgress(); return; }

  let heights;
  try {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height, half = h / 2;
    const data = ctx.getImageData(0, 0, w, h).data;
    const N = Math.min(220, Math.max(64, Math.floor(wf.getBoundingClientRect().width / 4)));
    heights = [];
    const step = w / N;
    for (let i = 0; i < N; i++) {
      const x = Math.min(w - 1, Math.floor(i * step + step / 2));
      let top = half;
      for (let y = 0; y < half; y++) { if (data[(y * w + x) * 4 + 3] > 24) { top = y; break; } }
      heights.push(Math.max(0.08, (half - top) / half));
    }
  } catch (e) { return; } // canvas not ready / unreadable → leave SC's waveform visible
  // a blank or not-yet-painted canvas reads as all-flat: try again next tick
  // instead of locking in a flat line
  const tall = heights.filter((a) => a > 0.2).length;
  if (tall < heights.length * 0.15) return;

  const barsHtml = heights.map((a) => '<i style="height:' + (a * 100).toFixed(1) + '%"></i>').join('');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = 'hoq-wave';
  el.dataset.key = key;
  el.innerHTML = '<div class="bars un">' + barsHtml + '</div><div class="bars pl">' + barsHtml + '</div>';
  wf.appendChild(el);
  wf.classList.add('hoq-cw');
  updateWaveProgress();
}

function updateWaveProgress() {
  const el = document.querySelector('.hoq-wave');
  if (!el) return;
  const pr = playerProgress();
  const frac = pr.dur > 0 ? Math.min(1, Math.max(0, pr.pos / pr.dur)) : 0;
  el.style.setProperty('--wave-prog', (frac * 100).toFixed(2) + '%');
}

// ---------------------------------------------------------------------------
// Bottom-player VISUALIZER — the seek bar rendered as a flowing glow waveform
// that REACTS to the actual audio (oscilloscope of the live signal) when SC is
// playing via MSE (a same-origin blob: audio element — safe to tap with Web
// Audio). Falls back to a procedural flowing line for the rarer cross-origin
// progressive streams (tapping those would mute playback). Played portion glows
// in the song accent; ends taper to the midline so they aren't cut off. Canvas
// is pointer-events:none so SoundCloud's seek/drag still works.
// ---------------------------------------------------------------------------
// Optional visual effects, toggled from the palette. Default ON (return true
// unless explicitly saved '0'). Effects: 'viz' (song bar), 'tilt' (3D tilt),
// 'wave' (interactive waveform).
function lowEndOn() { try { return localStorage.getItem('scFx_lowend') === '1'; } catch (e) { return false; } }
// Under Low-end mode the GPU/CPU-heavy effects are forced off regardless of their
// own switch (backdrop blur + the WebGL nebula are the big RAM/GPU spenders).
const HOQ_HEAVY = ['viz', 'wave', 'tilt', 'pulse', 'anim', 'frost', 'tabtilt'];
function effectOn(name) {
  if (lowEndOn() && HOQ_HEAVY.indexOf(name) !== -1) return false;
  return localStorage.getItem('scFx_' + name) !== '0';
}
function applyVizState() {
  const on = effectOn('viz');
  window.__hoqVizOn = on;
  document.documentElement.classList.toggle('hoq-noviz', !on);
}
// CSS-gated optional effects. Default-ON ones: OFF adds html.hoq-no-<name> to
// revert. Opt-in ones (default OFF): ON adds html.hoq-<name> to apply.
const HOQ_CSS_FX = ['pulse', 'round', 'hover', 'anim', 'frost', 'glow', 'mq', 'herofade', 'tabtilt'];
const HOQ_OPTIN_FX = ['gray', 'ambient', 'lowend'];
function applyFxClasses() {
  HOQ_CSS_FX.forEach((n) => document.documentElement.classList.toggle('hoq-no-' + n, !effectOn(n)));
  HOQ_OPTIN_FX.forEach((n) => document.documentElement.classList.toggle('hoq-' + n, localStorage.getItem('scFx_' + n) === '1'));
}

function startPlayerViz() {
  if (window.__hoqViz) return;
  window.__hoqViz = true;
  let canvas = null, ctx = null, wrap = null, amp = 0, accent = '#ff5500', accentTick = 0;
  // Real reactivity: the tap hung off SoundCloud's own source near the top of this
  // file (window.__hoqAudioAnalyser, which ambient mode reads too). SoundCloud's
  // media element is detached, so looking for an <audio>/<video> in the page found
  // nothing and the bar always drew the stand-in wave. No tap yet → procedural.
  let analyser = null, td = null;
  function ensureAnalyser() {
    const a = window.__hoqAudioAnalyser || null;
    if (a !== analyser) { analyser = a; td = a ? new Uint8Array(a.fftSize) : null; }
    return analyser;
  }

  function ensure() {
    wrap = document.querySelector('.playbackTimeline__progressWrapper') ||
           document.querySelector('.playControls__progress');
    if (!wrap) { canvas = ctx = null; return false; }
    if (!canvas || !canvas.isConnected || canvas.parentElement !== wrap) {
      canvas = wrap.querySelector(':scope > .hoq-viz');
      if (!canvas) { canvas = document.createElement('canvas'); canvas.className = 'hoq-viz'; wrap.appendChild(canvas); }
      ctx = canvas.getContext('2d');
    }
    return true;
  }

  function frame(t) {
    requestAnimationFrame(frame);
    try {
      if (window.__hoqVizOn === false) return; // disabled via palette → SC's plain bar shows
      if (!ensure()) return;
      const r = wrap.getBoundingClientRect();
      if (r.width < 24) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = Math.round(r.width), H = 34;
      if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
        canvas.width = W * dpr; canvas.height = H * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      // refresh the song accent occasionally (cheap-ish getComputedStyle)
      if (!(accentTick++ % 30)) {
        const c = getComputedStyle(document.documentElement).getPropertyValue('--sc-accent').trim();
        if (c) accent = c;
      }
      // played fraction straight from SC's own progress (follows the track exactly)
      const bar = document.querySelector('.playbackTimeline__progressBar');
      let frac = bar ? bar.getBoundingClientRect().width / r.width : 0;
      if (!isFinite(frac)) frac = 0;
      frac = Math.min(1, Math.max(0, frac));

      const pr = playerProgress();
      const an = ensureAnalyser();
      let live = false;
      // (a Go+ song from YouTube isn't in SoundCloud's audio: the stand-in wave then)
      if (an && !pr.paused && !_yt) { an.getByteTimeDomainData(td); live = true; }
      amp += ((pr.paused ? 0.04 : 1) - amp) * 0.08; // ease in/out (flat when paused)

      const pad = 3, IW = Math.max(1, W - pad * 2), midY = H / 2, maxA = H * 0.40;
      // taper: 0 at both ends → the line meets the midline cleanly (no cut edges)
      const win = (nx) => Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, nx))), 0.7);
      const sample = (nx) => live
        ? ((td[Math.min(td.length - 1, Math.round(nx * (td.length - 1)))] - 128) / 128) * 1.5
        : (Math.sin(nx * 6.3 + t * 0.0016) * 0.60 +
           Math.sin(nx * 13.1 - t * 0.0023) * 0.28 +
           Math.sin(nx * 21.0 + t * 0.0034) * 0.16);
      const yAt = (x) => {
        const nx = (x - pad) / IW;
        let v = sample(nx) * win(nx) * amp * maxA;
        if (v > maxA) v = maxA; else if (v < -maxA) v = -maxA;
        return midY + v;
      };
      const path = () => {
        ctx.beginPath();
        for (let x = pad; x <= W - pad; x += 2) { const y = yAt(x); x === pad ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
      };
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';

      // unplayed: dim, full span
      path();
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.20)'; ctx.shadowBlur = 0; ctx.stroke();

      // played: bright accent + glow, clipped to the progress region
      const pplayed = pad + frac * IW;
      if (frac > 0.001) {
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, pplayed, H); ctx.clip();
        path();
        ctx.lineWidth = 2.4; ctx.strokeStyle = accent;
        ctx.shadowColor = accent; ctx.shadowBlur = 9; ctx.stroke();
        ctx.restore();
      }
      // playhead dot sitting on the line
      const py = yAt(pplayed);
      ctx.beginPath(); ctx.arc(pplayed, py, 3.4, 0, 6.2832);
      ctx.fillStyle = '#fff'; ctx.shadowColor = accent; ctx.shadowBlur = 11; ctx.fill();
    } catch (e) { /* keep the loop alive */ }
  }
  requestAnimationFrame(frame);
}

// Interactive waveform: bars near the cursor rise up (a wave that follows the
// mouse). Overlay is pointer-events:none, so this never affects click-to-seek.
function setupWaveInteract() {
  let mx = -1, raf = 0;
  const schedule = () => { if (!raf) raf = requestAnimationFrame(apply); };
  function apply() {
    raf = 0;
    if (!effectOn('wave')) { document.querySelectorAll('.hoq-wave .bars i').forEach((b) => b.style.transform = ''); return; }
    document.querySelectorAll('.hoq-wave .bars').forEach((layer) => {
      const bars = layer.children, N = bars.length;
      for (let i = 0; i < N; i++) {
        if (mx < 0) { bars[i].style.transform = ''; continue; }
        const d = Math.abs(i / N - mx);
        const boost = d < 0.08 ? (1 - d / 0.08) : 0;   // ripple within ~8% of the cursor
        // LIFT the bars toward the cursor (a travelling crest) instead of scaling
        // their height — scaling made tall bars clip into a solid block.
        bars[i].style.transform = boost > 0 ? 'translateY(' + (-boost * 13).toFixed(1) + 'px)' : '';
      }
    });
  }
  document.addEventListener('mousemove', (e) => {
    const w = document.querySelector('.fullListenHero .waveform, .fullHero .waveform');
    if (!w) { if (mx !== -1) { mx = -1; schedule(); } return; }
    const r = w.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    const nx = inside ? (e.clientX - r.left) / r.width : -1;
    if (nx !== mx) { mx = nx; schedule(); }
  }, { passive: true });
}

function readZoom() { const z = parseFloat(localStorage.getItem('scZoom')); return isNaN(z) ? 1 : z; }
function applyZoom(z) {
  const v = Math.max(0.6, Math.min(1.4, Math.round(z * 20) / 20));
  document.documentElement.style.setProperty('--sc-list-zoom', v);
  localStorage.setItem('scZoom', String(v));
  const lbl = document.getElementById('sc-zoomval');
  if (lbl) lbl.textContent = Math.round(v * 100) + '%';
  return v;
}

// ---------------------------------------------------------------------------
// "Match song cover": pull the two dominant colors from the now-playing artwork
// and use them as the accent gradient, updating on each track change.
// ---------------------------------------------------------------------------
const _toHex = (c) => '#' + [c.r, c.g, c.b].map((x) => ('0' + Math.round(x).toString(16)).slice(-2)).join('');

// HSL helpers (hexToHue above only ever needed the hue).
function _hexToRgb(h) {
  h = (h || '').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function _rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return [h < 0 ? h + 360 : h, s, l];
}
function _hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const seg = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h / 60) % 6];
  return _toHex({ r: (seg[0] + m) * 255, g: (seg[1] + m) * 255, b: (seg[2] + m) * 255 });
}

// Greyscale artwork (pencil sketches, b&w photos) has no pixel that clears the
// chroma gate above, so extraction falls back to the flat image average — that is
// what washed the whole app grey and collapsed the gradient into one repeated
// stop. Lift weak colors to a saturation floor so they still read as a tint, keep
// the two stops apart so the gradient keeps its depth, and for genuinely
// achromatic art fall back to the accent the user actually picked rather than
// inventing a hue that isn't in the image.
const COVER_MIN_SAT = 0.42, COVER_MIN_L = 0.34, COVER_MAX_L = 0.72;
// The cover IS the page background, so a fixed brightness() is wrong: dark art
// blurs down to black and bright art washes out to haze. Aim the wash at a
// constant perceived lightness by dividing the target by the artwork's own
// luminance, so every cover lands in the same readable band.
function setBgBrightness(hex) {
  try {
    const rgb = _hexToRgb(hex);
    const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
    const v = Math.max(0.5, Math.min(2.0, 0.36 / Math.max(0.06, lum)));
    document.documentElement.style.setProperty('--sc-bg-bright', v.toFixed(2));
  } catch (e) {}
}

function normalizeCoverColors(c1, c2) {
  const [h1, s1, l1] = _rgbToHsl(..._hexToRgb(c1));
  if (s1 < 0.06) {
    const saved = readAccent();
    return { c1: saved.c1, c2: saved.c2, grad: saved.grad };
  }
  const clampL = (l) => Math.min(COVER_MAX_L, Math.max(COVER_MIN_L, l));
  const a1 = _hslToHex(h1, Math.max(s1, COVER_MIN_SAT), clampL(l1));
  const [h2, s2, l2] = _rgbToHsl(..._hexToRgb(c2 || c1));
  let dh = Math.abs(h2 - h1);
  if (dh > 180) dh = 360 - dh;
  const a2 = (dh < 12 && Math.abs(l2 - l1) < 0.1)
    ? _hslToHex(h1 + 28, Math.max(s1, COVER_MIN_SAT), clampL(l1 + 0.14))
    : _hslToHex(h2, Math.max(s2, COVER_MIN_SAT * 0.8), clampL(l2));
  return { c1: a1, c2: a2, grad: true };
}

function coverColors(url, cb) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      const S = 28;
      const cv = document.createElement('canvas');
      cv.width = S; cv.height = S;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0, S, S);
      const d = ctx.getImageData(0, 0, S, S).data; // throws if CORS-tainted
      const buckets = {};
      let avg = { r: 0, g: 0, b: 0, n: 0 };
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
        if (a < 200) continue;
        avg.r += r; avg.g += g; avg.b += b; avg.n++;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const sat = mx - mn, light = (mx + mn) / 2;
        if (sat < 42 || light < 28 || light > 235) continue; // skip greys / extremes
        const key = (r >> 5) + '_' + (g >> 5) + '_' + (b >> 5);
        const bk = buckets[key] || (buckets[key] = { r: 0, g: 0, b: 0, n: 0, sat: 0 });
        bk.r += r; bk.g += g; bk.b += b; bk.n++; bk.sat += sat;
      }
      const arr = Object.values(buckets).map((bk) => ({
        r: bk.r / bk.n, g: bk.g / bk.n, b: bk.b / bk.n, score: bk.sat,
      })).sort((x, y) => y.score - x.score);
      if (arr.length === 0) {
        if (avg.n) { const c = { r: avg.r / avg.n, g: avg.g / avg.n, b: avg.b / avg.n }; cb({ c1: _toHex(c), c2: _toHex(c), avg: _toHex(c) }); }
        else cb(null);
        return;
      }
      // `avg` is every pixel, not just the chromatic ones — it's the honest
      // measure of how dark the artwork actually is, which is what the blurred
      // background needs (the dominant colour is picked for chroma, not lightness).
      const avgHex = avg.n ? _toHex({ r: avg.r / avg.n, g: avg.g / avg.n, b: avg.b / avg.n }) : null;
      cb({ c1: _toHex(arr[0]), c2: _toHex(arr[1] || arr[0]), avg: avgHex });
    } catch (e) { cb(null); } // CORS-tainted canvas
  };
  img.onerror = () => cb(null);
  img.src = url;
}

// The cover of the track page you are LOOKING at, which is not necessarily the
// one playing — opening a song should hand the whole app that song's colors even
// before you hit play. On the new webi V2 page the hero artwork lives inside the
// same-origin iframe, so we have to reach in for it; the legacy hero is a plain
// background-image on a span.
const NOT_A_TRACK = /^(you|discover|feed|search|stream|library|upload|settings|pages|tags|n|messages|notifications)$/i;
function pageCoverUrl() {
  const seg = location.pathname.split('/').filter(Boolean);
  if (seg.length !== 2 || NOT_A_TRACK.test(seg[0]) || seg[1] === 'sets') return null;
  const big = (u) => u.replace(/-t\d+x\d+\./, '-t500x500.').replace(/-large\./, '-t500x500.');
  // Order matters: the track header also holds the commenter avatars pinned over
  // the waveform and the comment-box avatar, and both sit BEFORE the artwork in
  // DOM order. The artwork is the one SoundCloud marks high-priority and loads
  // with crossorigin (it feeds their own colour sampling); "artworks-" in the
  // path is the fallback tell.
  const HERO = [
    'section[aria-label="Track header"] img[fetchpriority="high"][crossorigin]',
    'section[aria-label="Track header"] img[src*="artworks-"]',
    'img[fetchpriority="high"][crossorigin][src*="sndcdn"]',
  ];
  for (const f of document.querySelectorAll('iframe')) {
    let d = null;
    try { d = f.contentDocument; } catch (e) { continue; } // cross-origin
    if (!d) continue;
    for (const sel of HERO) {
      const img = d.querySelector(sel);
      if (img && img.src) return big(img.src);
    }
  }
  const hero = document.querySelector(
    '.fullHero__artwork span, .fullListenHero .image__full span, .listenArtworkWall span');
  if (hero) {
    const m = (getComputedStyle(hero).backgroundImage || '').match(/url\(["']?(https?:[^"')]+)/);
    if (m) return big(m[1]);
  }
  return null;
}

function currentCoverUrl(raw) {
  const scope = document.querySelector('.playbackSoundBadge, .playControls');
  if (!scope) return null;
  const els = scope.querySelectorAll('span, div, a, .sc-artwork, .image');
  for (const el of els) {
    const bg = getComputedStyle(el).backgroundImage || '';
    const m = bg.match(/url\(["']?(https?:[^"')]+)["']?\)/);
    if (m) return raw ? m[1] : m[1].replace(/-t\d+x\d+\./, '-t200x200.').replace(/-large\./, '-t200x200.');
  }
  return null;
}

// The C# host delivers colors here when JS can't read the pixels (CORS).
window.__scCoverColors = function (c1, c2) {
  setBgBrightness(c1);                 // raw colour: reflects the actual artwork
  const n = normalizeCoverColors(c1, c2);
  setWaveHue(n.c1); // waveform always tracks the cover
  if (localStorage.getItem('scMatchCover') === '1') {
    applyAccent(n, true);
  }
};

function ensureBg() {
  let bg = document.getElementById('sc-bg');
  if (!bg) { bg = document.createElement('div'); bg.id = 'sc-bg'; document.body.appendChild(bg); }
  return bg;
}

function applyCoverBgState() {
  const custom = localStorage.getItem('scCustomBg');
  const coverOn = localStorage.getItem('scCoverBg') === '1';
  const on = coverOn || !!custom;
  document.documentElement.classList.toggle('sc-coverbg', on);
  document.documentElement.classList.toggle('sc-custombg', !!custom);
  const bg = ensureBg();
  if (custom) bg.style.backgroundImage = 'url("' + custom + '")';
}

// Set (or clear) a custom image/GIF background.
function setCustomBg(val) {
  if (val) {
    try { localStorage.setItem('scCustomBg', val); } catch (e) { /* too big to persist */ }
    document.documentElement.classList.add('sc-coverbg', 'sc-custombg');
    ensureBg().style.backgroundImage = 'url("' + val + '")';
  } else {
    localStorage.removeItem('scCustomBg');
    document.documentElement.classList.remove('sc-custombg');
    applyCoverBgState();
    _lastCover = null; matchTick();
  }
}

let _lastCover = null;
function matchTick() {
  const matchOn = localStorage.getItem('scMatchCover') === '1';
  const bgOn = localStorage.getItem('scCoverBg') === '1';
  // What's PLAYING owns the accent — clicking into a song shouldn't repaint the
  // app away from the track you're actually listening to. Only when nothing is
  // playing does the page you're looking at decide the colours.
  const url = currentCoverUrl() || pageCoverUrl();
  if (!url || url === _lastCover) return;
  _lastCover = url;
  if (bgOn && !localStorage.getItem('scCustomBg')) {
    const bg = document.getElementById('sc-bg');
    if (bg) bg.style.backgroundImage = 'url("' + url + '")'; // CSS bg = no CORS issue
  }
  // Always sample the cover: drives the waveform hue, and the accent too when
  // match-cover mode is on. (CORS-tainted → C# host samples + calls __scCoverColors.)
  // The colours come from the copy the player bar already shows (cached, and
  // 28px is all the sampler needs): fetching the 200px one first made the
  // accent trail the song by seconds on the phone, where it loads via the proxy.
  const sample = (currentCoverUrl() === url && currentCoverUrl(true)) || url;
  coverColors(sample, (cols) => {
    if (cols) {
      setBgBrightness(cols.avg || cols.c1);   // whole-image average when we have it
      const n = normalizeCoverColors(cols.c1, cols.c2);
      setWaveHue(n.c1);
      if (matchOn) applyAccent(n, true);
    } else {
      scPost('cover:' + url);
    }
  });
}

// ---------------------------------------------------------------------------
// Audio-ad UI. The actual muting/fast-forwarding runs in the injected page-world
// __scAdKiller script (it can reach SoundCloud's detached media objects — there
// are no <audio> elements in the DOM). Here we just create the badge it toggles
// and let the manual button signal it via a shared-DOM CustomEvent.
// ---------------------------------------------------------------------------
function ensureAdBadge() {
  let b = document.getElementById('sc-ad-badge');
  if (b) return b;
  b = document.createElement('div');
  b.id = 'sc-ad-badge';
  b.textContent = '⏩ Skipping ad…';
  b.style.cssText =
    'position:fixed;bottom:72px;left:50%;transform:translateX(-50%);' +
    'z-index:2147483646;background:var(--sc-accent,#ff5500);color:#fff;' +
    'font:600 12px Inter,Arial,sans-serif;padding:6px 13px;border-radius:20px;' +
    'box-shadow:0 4px 16px rgba(0,0,0,.5);display:none;pointer-events:none;';
  document.body.appendChild(b);
  return b;
}

// Manual "kill the ad now" — signals the page-world killer to force mute + 16x.
function skipAdManual() {
  document.dispatchEvent(new CustomEvent('sc-kill-ad'));
}

// localStorage keys that are the app's own (everything else is SoundCloud's):
// hoq*, the scFx_* effect switches, and the sc* look/volume settings.
const HOQ_OWN_KEY = /^(hoq|scFx_|sc(Accent|MatchCover|CoverBg|CustomBg|Zoom|Vol)$)/;

// ---------------------------------------------------------------------------
// Custom titlebar + palette panel
// ---------------------------------------------------------------------------
function buildTitlebar() {
  if (document.getElementById('sc-titlebar')) return;

  const bar = document.createElement('div');
  bar.id = 'sc-titlebar';
  bar.innerHTML = `
    <style>
      /* Merged with the SC header: transparent overlay, only our controls are
         visible + clickable; the rest lets header clicks through. */
      #sc-titlebar {
        position: fixed; top: 0; left: 0; right: 0; height: 48px;
        background: transparent; border: 0;
        display: flex; align-items: center; z-index: 2147483647; pointer-events: none;
        font-family: Inter, -apple-system, Segoe UI, Arial, sans-serif; color: #ddd;
        user-select: none;
      }
      #sc-titlebar .sc-tb-btn, #sc-titlebar .sc-tb-lights,
      #sc-titlebar .sc-tb-lights .sc-light { pointer-events: auto; }
      #sc-titlebar .sc-tb-brand { display: none; } /* SC logo is the brand now */
      #sc-titlebar .sc-tb-logo {
        width: 22px; height: 22px; object-fit: contain; display: block;
        filter: drop-shadow(0 0 5px rgba(90,160,255,0.4));
      }
      #sc-titlebar .sc-tb-spacer { flex: 1; }
      /* same tile as the header's icon buttons (34px, grey, soft hover tile) */
      #sc-titlebar .sc-tb-btn {
        width: 34px; height: 34px; padding: 0; margin: 0 2px; border-radius: 10px;
        display: flex; align-items: center; justify-content: center;
        background: transparent; border: 0; color: #a6a6b0; cursor: pointer;
        transition: background .12s ease, color .12s ease;
      }
      #sc-titlebar .sc-tb-btn svg { width: 16px; height: 16px; display: block; }
      #sc-titlebar .sc-tb-btn:hover { background: rgba(255,255,255,0.08); color: #fff; }
      #sc-titlebar .sc-tb-skipad:hover { color: var(--sc-accent, #ff5500); }
      #sc-titlebar .sc-tb-accentdot { fill: var(--sc-accent, #ff5500); }
      /* macOS-style window controls, calm like the rest of the header: soft grey
         dots at rest (like an inactive Mac window); hovering the group brings
         back red / yellow / green with their glyphs. A hairline sets them apart
         from the header's icon groups. */
      #sc-titlebar .sc-tb-lights { position: relative; display: flex; align-items: center; gap: 8px; height: 34px;
        margin-left: 10px; padding: 0 14px 0 12px; }
      #sc-titlebar .sc-tb-lights::before { content: ''; position: absolute; left: 0; top: 9px; bottom: 9px; width: 1px; background: rgba(255,255,255,0.12); }
      #sc-titlebar .sc-light {
        width: 12px; height: 12px; border-radius: 50%; border: 0; padding: 0; cursor: pointer;
        display: flex; align-items: center; justify-content: center; position: relative;
        background: rgba(255,255,255,0.2); box-shadow: inset 0 0 0 0.5px rgba(255,255,255,0.08);
        transition: background .14s ease, box-shadow .14s ease, transform .12s ease;
      }
      #sc-titlebar .sc-tb-lights:hover .sc-tb-close.sc-light { background: #ff5f57; box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.2); }
      #sc-titlebar .sc-tb-lights:hover .sc-tb-min.sc-light { background: #febc2e; box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.2); }
      #sc-titlebar .sc-tb-lights:hover .sc-tb-max.sc-light { background: #28c840; box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.2); }
      #sc-titlebar .sc-light:active { transform: scale(.9); }
      #sc-titlebar .sc-light span {
        font-size: 9px; line-height: 0; font-weight: 800; color: rgba(0,0,0,0.6);
        display: flex; align-items: center; justify-content: center;
        opacity: 0; transition: opacity .1s ease;
      }
      #sc-titlebar .sc-light span svg { width: 8px; height: 8px; display: block; }
      #sc-titlebar .sc-tb-lights:hover .sc-light span { opacity: 1; }

      #sc-palette {
        position: fixed; top: 52px; right: 12px; z-index: 2147483647;
        background: rgba(14,14,18,0.55);
        backdrop-filter: blur(24px) saturate(1.5); -webkit-backdrop-filter: blur(24px) saturate(1.5);
        border: 1px solid rgba(255,255,255,0.10); border-radius: 16px;
        padding: 12px 14px; width: 470px; display: none;
        max-height: calc(100vh - 66px); overflow-y: auto; overscroll-behavior: contain;
        scrollbar-width: thin !important;
        scrollbar-color: color-mix(in srgb, var(--sc-accent, #ff5500) 55%, transparent) transparent !important;
        box-shadow: 0 22px 60px rgba(0,0,0,.6);
        font-family: Inter, -apple-system, Arial, sans-serif; color: #e8e8ea; font-size: 12px;
        -webkit-app-region: no-drag;
        animation: scPalIn .16s ease;
      }
      @keyframes scPalIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
      #sc-palette.open { display: block; }
      /* Rows carry padding + a 1px border; without border-box each one renders
         wider than its grid track and bleeds into the neighbouring column. */
      #sc-palette, #sc-palette *, #sc-palette *::before, #sc-palette *::after {
        box-sizing: border-box;
      }

      /* --- Palette adopted by the Social/Settings tab ---------------------
         Same element, same handlers; it just stops being a floating popup and
         becomes an inline block that can breathe. The tab scrolls, so none of
         the popup's height clamping is needed (that was what clipped rows). */
      #hoq-discord .hoq-settings-host #sc-palette {
        position: static !important; display: block !important;
        width: auto !important; max-width: none !important;
        max-height: none !important; overflow: visible !important;
        background: transparent !important;
        backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
        border: 0 !important; border-radius: 0 !important;
        box-shadow: none !important; padding: 0 !important;
        animation: none !important; font-size: 12px;
      }
      /* The card already has a "Settings" label above it. */
      #hoq-discord .hoq-settings-host #sc-palette > h4 { display: none !important; }
      #hoq-discord .hoq-settings-host #sc-palette .section-label {
        margin: 16px 0 7px !important;
        /* The tab sits on the cover wash, which can be light — the popup's mid
           grey vanished on bright artwork, so lift it and anchor it with a shadow. */
        font-size: 10px !important;
        color: rgba(255,255,255,0.74) !important;
        text-shadow: 0 1px 3px rgba(0,0,0,0.55) !important;
      }
      #hoq-discord .hoq-settings-host #sc-palette .section-label:first-of-type { margin-top: 2px !important; }
      /* Fill the tab's width instead of forcing two cramped columns. */
      #hoq-discord .hoq-settings-host #sc-palette .pal-grid {
        grid-template-columns: repeat(3, 1fr) !important;
        gap: 8px 18px !important;
      }
      #hoq-discord .hoq-settings-host #sc-palette .row {
        padding: 7px 11px !important;
      }
      #hoq-discord .hoq-settings-host #sc-palette .pal-grid .row { margin: 0 !important; }
      /* Keep the full-width singles on the same column rhythm as the grids
         (2 cols = 232+232+18) instead of stretching across the whole tab. */
      #hoq-discord .hoq-settings-host #sc-palette > .row,
      #hoq-discord .hoq-settings-host #sc-palette > .bgurl,
      #hoq-discord .hoq-settings-host #sc-palette > .pal-note,
      #hoq-discord .hoq-settings-host #sc-palette > .btn-2up { max-width: calc(66.667% - 6px); }
      #sc-palette h4 {
        margin: 1px 0 8px; font-size: 10.5px; font-weight: 700; color: #fff;
        letter-spacing: 1.3px; text-transform: uppercase; display: flex; align-items: center; gap: 7px;
      }
      #sc-palette h4::before {
        content: ''; width: 7px; height: 7px; border-radius: 50%;
        background: var(--sc-accent, #ff5500); box-shadow: 0 0 8px var(--sc-accent, #ff5500);
      }
      #sc-palette .row {
        display: flex; align-items: center; justify-content: space-between;
        margin: 4px 0; padding: 8px 12px; background: rgba(255,255,255,0.045);
        border: 1px solid rgba(255,255,255,0.07);
        border-radius: 10px; font-weight: 500; font-size: 12px; color: #e9e9ee;
        transition: background .14s ease, border-color .14s ease;
      }
      #sc-palette .row:hover { background: rgba(255,255,255,0.075); border-color: rgba(255,255,255,0.12); }
      /* multi-column grid for the toggles */
      #sc-palette .pal-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 16px; }
      #sc-palette .pal-grid .row { margin: 0; gap: 10px; padding: 8px 12px; }
      #sc-palette .pal-grid .row span {
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0;
      }
      #sc-palette input[type=color] {
        width: 34px; height: 24px; border: 1px solid rgba(255,255,255,0.15);
        border-radius: 6px; background: none; cursor: pointer; padding: 0;
      }
      #sc-palette input[type=color]::-webkit-color-swatch { border: 0; border-radius: 5px; }
      #sc-palette input[type=color]::-webkit-color-swatch-wrapper { padding: 2px; }
      #sc-palette label { display: flex; align-items: center; gap: 7px; cursor: pointer; }
      #sc-palette label { justify-content: space-between; width: 100%; }
      /* ===== toggle: a hollow OUTLINED pill when OFF (dim recessed dot) that snaps
         to a clean SOLID accent when ON (the dot grows into a bright white knob).
         No glow bloom — reads crisp against the frosted rows. ===== */
      #sc-palette input[type=checkbox] {
        appearance: none; -webkit-appearance: none; flex: none; cursor: pointer;
        box-sizing: border-box; width: 42px; height: 23px; border-radius: 23px;
        position: relative; margin: 0; background: rgba(255,255,255,0.04);
        border: 1.5px solid rgba(255,255,255,0.24);
        transition: background .2s ease, border-color .2s ease;
      }
      #sc-palette input[type=checkbox]:hover { border-color: rgba(255,255,255,0.44); background: rgba(255,255,255,0.07); }
      #sc-palette input[type=checkbox]::after {
        content: ''; position: absolute; top: 4px; left: 4px; width: 11px; height: 11px;
        border-radius: 50%; background: rgba(255,255,255,0.5);
        transition: transform .26s cubic-bezier(.34,1.55,.64,1),
          width .16s ease, height .16s ease, top .16s ease, left .16s ease, background .2s ease;
      }
      #sc-palette input[type=checkbox]:checked {
        background: var(--sc-accent, #ff5500);
        border-color: var(--sc-accent, #ff5500);
        box-shadow: 0 0 10px color-mix(in srgb, var(--sc-accent, #ff5500) 45%, transparent);
      }
      #sc-palette input[type=checkbox]:checked::after {
        width: 16px; height: 16px; top: 2px; left: 2px; background: #fff;
        box-shadow: 0 1px 3px rgba(0,0,0,0.5);
        transform: translateX(19px);
      }
      #sc-palette input[type=checkbox]:focus-visible {
        outline: 2px solid color-mix(in srgb, var(--sc-accent, #ff5500) 70%, transparent); outline-offset: 2px;
      }
      #sc-palette .swatches {
        display: grid; grid-template-columns: repeat(8, 1fr); gap: 7px; margin: 14px 2px 6px;
      }
      #sc-palette .sw {
        width: 20px; height: 20px; border-radius: 50%; cursor: pointer;
        border: 2px solid transparent; box-shadow: 0 0 0 1px rgba(255,255,255,0.12);
        transition: transform .12s ease, box-shadow .12s ease;
      }
      #sc-palette .sw:hover { transform: scale(1.18); }
      #sc-palette .sw.sel { border-color: #fff; box-shadow: 0 0 0 2px var(--sc-accent, #ff5500); }
      #sc-palette .bgurl {
        width: 100%; box-sizing: border-box; margin: 3px 0 0; padding: 7px 10px;
        border-radius: 8px; border: 1px solid rgba(255,255,255,0.1);
        background: rgba(255,255,255,0.05); color: #e4e4e6; font-size: 12px; outline: none;
      }
      #sc-palette .bgurl:focus { border-color: var(--sc-accent, #ff5500); }
      /* two buttons side-by-side (background + reset rows) to save vertical space */
      #sc-palette .btn-2up { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 6px; }
      #sc-palette .btn-2up button { width: 100% !important; margin: 0 !important; }
      #sc-palette button.bgpick, #sc-palette button.bgclear {
        width: 100%; padding: 7px 8px; border-radius: 8px; cursor: pointer;
        font-size: 12px; font-weight: 600; border: 1px solid rgba(255,255,255,0.09);
        background: rgba(255,255,255,0.06); color: #ccc; transition: all .12s ease;
      }
      #sc-palette button.bgpick:hover { background: rgba(255,255,255,0.12); color: #fff; }
      #sc-palette button.bgclear { background: rgba(255,90,90,0.08); color: #ff9a9a; border-color: rgba(255,90,90,0.25); }
      #sc-palette button.bgclear:hover { background: rgba(255,90,90,0.18); color: #fff; }
      #sc-palette button.reset, #sc-palette button.fixblock {
        width: 100%; padding: 8px; border-radius: 9px; cursor: pointer;
        font-size: 12px; font-weight: 600; transition: all .12s ease;
      }
      #sc-palette button.reset { background: rgba(255,255,255,0.06); color: #ccc; border: 1px solid rgba(255,255,255,0.09); }
      #sc-palette button.reset:hover { background: rgba(255,255,255,0.11); color: #fff; }
      #sc-palette button.fixblock {
        background: rgba(255,120,40,0.1); color: #ffb37a; border: 1px solid rgba(255,120,40,0.28);
      }
      #sc-palette button.fixblock:hover { background: rgba(255,120,40,0.2); color: #fff; }
      #sc-palette .zoomctl { display: flex; align-items: center; gap: 8px; }
      #sc-palette .zmb {
        width: 24px; height: 24px; border-radius: 6px; cursor: pointer; font-size: 14px;
        border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.06); color: #ddd;
        display: flex; align-items: center; justify-content: center; line-height: 1;
      }
      #sc-palette .zmb:hover { background: rgba(255,255,255,0.15); color: #fff; }
      #sc-palette #sc-zoomval { min-width: 42px; text-align: center; font-size: 12px; font-weight: 600; }
      #sc-palette .gradctl { display: flex; align-items: center; gap: 10px; }
      #sc-palette .section-label {
        font-size: 9.5px; text-transform: uppercase; letter-spacing: 1.4px;
        color: #7a7a7c; margin: 9px 2px 5px; font-weight: 700;
      }
      #sc-palette .section-label:first-of-type { margin-top: 4px; }
    </style>
    <div class="sc-tb-brand">holdonquietly</div>
    <div class="sc-tb-spacer"></div>
    <button class="sc-tb-btn sc-tb-skipad" title="Kill current ad (mute + fast-forward)">
      <svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 4v16"/><path d="M6.029 4.285A2 2 0 0 0 3 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z"/></svg></button>
    <div class="sc-tb-lights">
      <button class="sc-light sc-tb-close" title="Close"><span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></span></button>
      <button class="sc-light sc-tb-min" title="Minimize"><span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12h14"/></svg></span></button>
      <button class="sc-light sc-tb-max" title="Maximize"><span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3m8 0h3a2 2 0 0 0 2-2v-3"/></svg></span></button>
    </div>
  `;
  document.body.appendChild(bar);

  const panel = document.createElement('div');
  panel.id = 'sc-palette';
  const presets = ['#ff5500', '#1db954', '#3b82f6', '#a855f7', '#ef4444', '#eab308', '#ec4899', '#14b8a6'];
  panel.innerHTML = `
    <h4>Appearance</h4>

    <div class="section-label">Color</div>
    <div class="pal-grid">
      <div class="row"><span>Primary</span><input type="color" id="sc-c1"></div>
      <div class="row"><span>Gradient</span><span class="gradctl">
        <input type="color" id="sc-c2"><input type="checkbox" id="sc-grad"></span></div>
    </div>
    <label class="row"><span>Match song cover</span><input type="checkbox" id="sc-match"></label>

    <div class="section-label">Background</div>
    <label class="row"><span>Blurred cover</span><input type="checkbox" id="sc-coverbg"></label>
    <input type="text" id="sc-bgurl" class="bgurl" placeholder="…or paste an image / GIF URL">
    <div class="btn-2up">
      <button class="bgpick">Choose image</button>
      <button class="bgclear">Clear bg</button>
    </div>

    <div class="section-label">Motion</div>
    <div class="pal-grid">
      <label class="row"><span>Visualizer</span><input type="checkbox" id="sc-fx-viz"></label>
      <label class="row"><span>Interactive wave</span><input type="checkbox" id="sc-fx-wave"></label>
      <label class="row"><span>3D tilt</span><input type="checkbox" id="sc-fx-tilt"></label>
      <label class="row"><span>3D tab bars</span><input type="checkbox" id="sc-fx-tabtilt"></label>
      <label class="row"><span>Speaker pulse</span><input type="checkbox" id="sc-fx-pulse"></label>
      <label class="row"><span>Animations</span><input type="checkbox" id="sc-fx-anim"></label>
      <label class="row"><span>Scroll long titles</span><input type="checkbox" id="sc-fx-mq"></label>
    </div>

    <div class="section-label">Look</div>
    <div class="pal-grid">
      <label class="row"><span>Accent glow</span><input type="checkbox" id="sc-fx-glow"></label>
      <label class="row"><span>Rounded</span><input type="checkbox" id="sc-fx-round"></label>
      <label class="row"><span>Row hover</span><input type="checkbox" id="sc-fx-hover"></label>
      <label class="row"><span>Frosted bars</span><input type="checkbox" id="sc-fx-frost"></label>
      <label class="row"><span>Grayscale covers</span><input type="checkbox" id="sc-fx-gray"></label>
      <label class="row"><span>Banner fade</span><input type="checkbox" id="sc-fx-herofade"></label>
      <label class="row"><span>Room glow</span><input type="checkbox" id="sc-fx-ambient"></label>
    </div>

    <div class="section-label">Performance</div>
    <label class="row"><span>Low-end mode</span><input type="checkbox" id="sc-fx-lowend"></label>
    <div class="pal-note">Turns off the WebGL nebula, frosted blur, the visualizer and animations to cut GPU/RAM use.</div>

    <div class="section-label">Display</div>
    <div class="row"><span>Song list zoom</span><span class="zoomctl">
      <button class="zmb" data-z="-1">&minus;</button><b id="sc-zoomval">100%</b><button class="zmb" data-z="1">+</button>
    </span></div>

    <div class="section-label">Trouble</div>
    <div class="btn-2up">
      <button class="reset" title="Put the accent back to SoundCloud orange">Reset color</button>
      <button class="fixblock" title="Clears cookies and Cloudflare block state, then reloads">Fix &quot;blocked&quot;</button>
    </div>
  `;
  document.body.appendChild(panel);

  // Manual ad-kill
  bar.querySelector('.sc-tb-skipad').addEventListener('click', () => skipAdManual());

  // Drag the frameless window by the titlebar (WebView2 has no app-region drag).
  bar.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.sc-tb-btn, .sc-light, #sc-palette')) return; // not on buttons
    scPost('win:drag');
  });
  bar.addEventListener('dblclick', (e) => {
    if (e.target.closest('.sc-tb-btn, .sc-light, #sc-palette')) return;
    window.scDesktop.maximize();
  });
  // Merged bar: drag / maximize by empty areas of the SC header too (event
  // listeners only — never mutate SC's React DOM).
  const hdrNoDrag = 'a, button, input, textarea, select, [role="button"], .headerSearch, .header__userNav, #sc-titlebar, #sc-palette';
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !e.target.closest('.header')) return;
    if (e.target.closest(hdrNoDrag)) return;
    scPost('win:drag');
  });
  document.addEventListener('dblclick', (e) => {
    if (!e.target.closest('.header') || e.target.closest(hdrNoDrag)) return;
    window.scDesktop.maximize();
  });

  // Window controls
  bar.querySelector('.sc-tb-min').addEventListener('click', () => window.scDesktop.minimize());
  bar.querySelector('.sc-tb-max').addEventListener('click', () => window.scDesktop.maximize());
  bar.querySelector('.sc-tb-close').addEventListener('click', () => window.scDesktop.close());
  // Settings live in the Social/Settings tab now, so the gear is just a shortcut
  // to it rather than a second place the same controls can appear.
  // No titlebar gear any more — the Social/Settings tab is the single entry
  // point, so the palette is never a floating panel and needs no dismiss logic.

  // Palette wiring
  const c1 = panel.querySelector('#sc-c1');
  const c2 = panel.querySelector('#sc-c2');
  const grad = panel.querySelector('#sc-grad');
  const state = readAccent();
  c1.value = state.c1;
  c2.value = state.c2;
  grad.checked = state.grad;

  const match = panel.querySelector('#sc-match');
  match.checked = localStorage.getItem('scMatchCover') === '1';

  const markSel = () => panel.querySelectorAll('.sw').forEach((sw) =>
    sw.classList.toggle('sel', sw.dataset.c.toLowerCase() === c1.value.toLowerCase()));
  // Manual change -> turn OFF match-cover mode.
  const push = () => {
    if (match.checked) { match.checked = false; localStorage.setItem('scMatchCover', '0'); }
    applyAccent({ c1: c1.value, c2: c2.value, grad: grad.checked });
    markSel();
  };
  c1.addEventListener('input', push);
  c2.addEventListener('input', push);
  grad.addEventListener('change', push);
  panel.querySelectorAll('.sw').forEach((sw) =>
    sw.addEventListener('click', () => {
      c1.value = sw.dataset.c;
      push();
    })
  );
  markSel();

  // Match-song-cover toggle.
  match.addEventListener('change', () => {
    localStorage.setItem('scMatchCover', match.checked ? '1' : '0');
    if (match.checked) { _lastCover = null; matchTick(); }
    else applyAccent(readAccent()); // restore saved manual color
  });

  // Blurred-cover-background toggle.
  const coverbg = panel.querySelector('#sc-coverbg');
  coverbg.checked = localStorage.getItem('scCoverBg') === '1';
  coverbg.addEventListener('change', () => {
    localStorage.setItem('scCoverBg', coverbg.checked ? '1' : '0');
    applyCoverBgState();
    _lastCover = null; matchTick();
  });

  // Optional-effects toggles. viz/tilt/wave are JS-gated; the rest are CSS-gated
  // via html.hoq-no-<name> (see applyFxClasses).
  [['viz', 'sc-fx-viz'], ['tilt', 'sc-fx-tilt'], ['wave', 'sc-fx-wave'],
   ['pulse', 'sc-fx-pulse'], ['round', 'sc-fx-round'], ['hover', 'sc-fx-hover'],
   ['anim', 'sc-fx-anim'], ['frost', 'sc-fx-frost'], ['glow', 'sc-fx-glow'],
   ['mq', 'sc-fx-mq'], ['herofade', 'sc-fx-herofade'], ['tabtilt', 'sc-fx-tabtilt'],
   ['gray', 'sc-fx-gray'], ['ambient', 'sc-fx-ambient'], ['lowend', 'sc-fx-lowend']].forEach(([name, id]) => {
    const cb = panel.querySelector('#' + id);
    if (!cb) return;
    // opt-in effects default OFF; everything else defaults ON.
    cb.checked = HOQ_OPTIN_FX.includes(name) ? (localStorage.getItem('scFx_' + name) === '1') : effectOn(name);
    cb.addEventListener('change', () => {
      localStorage.setItem('scFx_' + name, cb.checked ? '1' : '0');
      // Low-end mode flips the heavy effects, so re-sync everything that reads them.
      if (name === 'viz' || name === 'lowend') applyVizState();
      if (name === 'wave' && !cb.checked) document.querySelectorAll('.hoq-wave .bars i').forEach((b) => b.style.transform = '');
      applyFxClasses();
    });
  });

  panel.querySelector('.reset').addEventListener('click', () => {
    match.checked = false; localStorage.setItem('scMatchCover', '0');
    c1.value = DEFAULT_ACCENT.c1;
    c2.value = DEFAULT_ACCENT.c2;
    grad.checked = false;
    push();
  });
  panel.querySelector('.fixblock').addEventListener('click', () => {
    // SoundCloud's own saved state goes (its block flags can live there too); ours
    // stays. The listening stats and every setting exist only in localStorage, and
    // the host clears cookies and caches but never localStorage.
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && !HOQ_OWN_KEY.test(k)) localStorage.removeItem(k);
      }
    } catch (e) {}
    window.scDesktop.reset();
  });

  // Song-list zoom buttons.
  applyZoom(readZoom()); // sets the label
  panel.querySelectorAll('.zmb').forEach((b) =>
    b.addEventListener('click', () => applyZoom(readZoom() + parseInt(b.dataset.z, 10) * 0.05)));

  // Custom background (image / GIF via URL or file).
  const bgurl = panel.querySelector('#sc-bgurl');
  const savedBg = localStorage.getItem('scCustomBg') || '';
  bgurl.value = savedBg.startsWith('data:') ? '' : savedBg;
  bgurl.addEventListener('change', () => setCustomBg(bgurl.value.trim()));
  const fileInput = document.createElement('input');
  fileInput.type = 'file'; fileInput.accept = 'image/*'; fileInput.style.display = 'none';
  panel.appendChild(fileInput);
  panel.querySelector('.bgpick').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => setCustomBg(r.result);
    r.readAsDataURL(f);
  });
  panel.querySelector('.bgclear').addEventListener('click', () => { bgurl.value = ''; setCustomBg(''); });
}

// ---------------------------------------------------------------------------
// Discord tab: a hub next to Library — your live listening-activity card, a
// display-name setting, and a link to the server. (Rich Presence to friends
// wires up in the C# host once a public Client ID is provided.)
// ---------------------------------------------------------------------------
const HOQ_SERVER = '795316631655546900';

function cleanNP(s) {
  s = (s || '').replace(/[⠀]/g, '').replace(/^current track:\s*/i, '').trim();
  // SoundCloud duplicates the text (visible + a11y) — collapse exact doubles.
  const h = Math.floor(s.length / 2);
  if (s.length % 2 === 0 && s.slice(0, h).trim() === s.slice(h).trim()) s = s.slice(0, h);
  return s.trim();
}

// The current song's link: the player bar's, or a Go+ song YouTube plays on its own.
function hoqNowHref() {
  const s = hoqYtSolo();
  if (s) return s.url;
  const a = document.querySelector('.playbackSoundBadge__titleLink');
  return (a && a.getAttribute('href')) || '';
}

function currentNowPlaying() {
  // a Go+ song SoundCloud wouldn't play at all, on YouTube: SoundCloud's bar doesn't have it
  const s = hoqYtSolo();
  if (s) return { title: s.title, artist: s.artist, cover: s.cover };
  const t = document.querySelector('.playbackSoundBadge__titleLink');
  const a = document.querySelector('.playbackSoundBadge__lightLink, .playbackSoundBadge__usernameLink');
  return {
    title: cleanNP(t && (t.getAttribute('title') || t.textContent)),
    artist: cleanNP(a && (a.getAttribute('title') || a.textContent)),
    cover: currentCoverUrl() || '',
  };
}

// Community feed: composer (message + optional "current track") and the live
// list. Identity is hoqMe() (public SC handle/avatar). The list is served by the
// host via window.__hoqFeed; a cached copy + a warm empty state mean the feed
// never renders blank even if the backend is down (a dead feed makes the whole
// tab feel dead — that's the failsafe).
function setupFeed(p) {
  const list = p.querySelector('.hoq-feed-list');
  const input = p.querySelector('.hoq-feed-input');
  const attachBtn = p.querySelector('.hoq-feed-attach');
  const attachedBox = p.querySelector('.hoq-feed-attached');
  const postBtn = p.querySelector('.hoq-feed-post');
  const avatarImg = p.querySelector('.hoq-feed-avatar');
  if (!list || !input) return;
  let attached = null, feedItems = [], pending = [];

  const esc = hoqEsc; // reuse the shared HTML-escape helper
  const rel = (ts) => { const d = (Date.now() - ts) / 1000; if (d < 60) return 'now'; if (d < 3600) return Math.floor(d / 60) + 'm'; if (d < 86400) return Math.floor(d / 3600) + 'h'; return Math.floor(d / 86400) + 'd'; };
  const curTrack = () => { const np = currentNowPlaying(); if (!np.title) return null; const href = hoqNowHref(); return { title: np.title, artist: np.artist, cover: np.cover, url: href ? (href.startsWith('http') ? href : 'https://soundcloud.com' + href) : '' }; };
  const setMeAvatar = () => { const me = hoqMe(); if (me.avatar && avatarImg) avatarImg.src = me.avatar; };
  setMeAvatar(); setTimeout(setMeAvatar, 1500);

  const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(140, input.scrollHeight) + 'px'; };
  input.addEventListener('input', grow);

  const renderAttached = () => {
    if (!attached) { attachedBox.hidden = true; attachedBox.innerHTML = ''; attachBtn.classList.remove('on'); attachBtn.textContent = '♪ Attach current track'; return; }
    attachedBox.hidden = false; attachBtn.classList.add('on'); attachBtn.textContent = '♪ Track attached';
    attachedBox.innerHTML = (attached.cover ? '<img src="' + esc(attached.cover) + '">' : '') +
      '<div style="min-width:0"><div class="fa-t">' + esc(attached.title) + '</div><div class="fa-a">' + esc(attached.artist) + '</div></div><button class="fa-x" title="Remove">×</button>';
    attachedBox.querySelector('.fa-x').onclick = () => { attached = null; renderAttached(); };
  };
  attachBtn.addEventListener('click', () => {
    if (attached) { attached = null; renderAttached(); return; }
    attached = curTrack();
    if (!attached) { attachBtn.textContent = 'Nothing playing'; setTimeout(() => { if (!attached) attachBtn.textContent = '♪ Attach current track'; }, 1400); return; }
    renderAttached();
  });

  const trackCard = (t) => (t && t.title) ? ('<a class="hoq-fi-track"' + (hoqSafeUrl(t.url) ? ' href="' + esc(hoqSafeUrl(t.url)) + '"' : '') + '>' + (hoqSafeUrl(t.cover) ? '<img src="' + esc(hoqSafeUrl(t.cover)) + '">' : '') + '<div style="min-width:0"><div class="ft-t">' + esc(t.title) + '</div><div class="ft-a">' + esc(t.artist || '') + '</div></div><span class="ft-play">▶</span></a>') : '';
  const itemHtml = (f, isPending) => {
    const nameEl = hoqSafeUrl(f.url) ? '<a class="hoq-fi-name" href="' + esc(hoqSafeUrl(f.url)) + '">' + esc(f.name) + '</a>' : '<span class="hoq-fi-name">' + esc(f.name) + '</span>';
    return '<div class="hoq-feed-item' + (f.sys ? ' sys' : '') + (isPending ? ' pending' : '') + '">' +
      '<img class="hoq-fi-av" src="' + (hoqSafeUrl(f.avatar) ? esc(hoqSafeUrl(f.avatar)) : HOQ_LOGO) + '">' +
      '<div class="hoq-fi-body"><div class="hoq-fi-head">' + nameEl + '<span class="hoq-fi-time">' + (f.sys ? '' : rel(f.ts)) + '</span></div>' +
      (f.text ? '<div class="hoq-fi-text">' + esc(f.text) + '</div>' : '') + trackCard(f.track) + '</div></div>';
  };
  const render = () => {
    if (!pending.length && !feedItems.length) { list.innerHTML = '<div class="hoq-feed-empty">Nothing here yet.<br>Be the first to say something or share a track.</div>'; return; }
    list.innerHTML = pending.map((f) => itemHtml(f, true)).join('') + feedItems.map((f) => itemHtml(f, false)).join('');
    // Posts carry their own links, and the server only checks they're https. A
    // SoundCloud link opens here (on this site: the phone's proxy stays the
    // proxy); anything else goes to the browser, never into this window, where
    // a look-alike sign-in page would show no address.
    list.querySelectorAll('.hoq-fi-track[href], a.hoq-fi-name[href]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      const h = hoqSafeUrl(a.getAttribute('href'));
      if (!h) return;
      const sc = h.match(/^https:\/\/(?:www\.|m\.)?soundcloud\.com(\/[^?#]*)?/i);
      if (sc) location.href = location.origin + (sc[1] || '/');
      else scPost('open:' + h);
    }));
  };

  window.__hoqFeed = function (arr) {
    if (!Array.isArray(arr)) return;
    feedItems = arr;
    pending = pending.filter((q) => !arr.some((f) => f.id === q.id && f.text === q.text && Math.abs(f.ts - q.ts) < 120000));
    try { localStorage.setItem('hoqFeedCache', JSON.stringify(arr.slice(0, 30))); } catch (e) {}
    render();
  };
  window.__hoqFeedOffline = function () {
    if (!feedItems.length) { try { const c = JSON.parse(localStorage.getItem('hoqFeedCache') || '[]'); if (Array.isArray(c) && c.length) feedItems = c; } catch (e) {} }
    render();
  };

  const post = () => {
    const text = input.value.trim();
    if (!text && !attached) return;
    const me = hoqMe();
    const item = { id: me.id, name: me.name, avatar: me.avatar, url: me.url, text, track: attached, ts: Date.now() };
    pending.unshift(item); render();
    scPost('feed:post:' + JSON.stringify(item));
    input.value = ''; grow(); attached = null; renderAttached();
  };
  postBtn.addEventListener('click', post);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); post(); } });

  try { const c = JSON.parse(localStorage.getItem('hoqFeedCache') || '[]'); if (Array.isArray(c) && c.length) { feedItems = c; render(); } } catch (e) {}
  scPost('feed:get');
}

function buildDiscordTab() {
  if (document.querySelector('.hoq-dc-tab')) return;
  const lib = Array.from(document.querySelectorAll('.header__navMenuItem'))
    .find((a) => (a.textContent || '').trim() === 'Library' || a.getAttribute('href') === '/you/library');
  if (!lib) return;
  const libLi = lib.closest('li') || lib.parentElement;
  if (!libLi || !libLi.parentElement) return;
  // Give Discord its OWN <li> wrapper (matching Library's) so it sits inline.
  const li = libLi.cloneNode(false); // empty <li> with the same class
  const tab = document.createElement('a');
  tab.className = (lib.className || '').toString().replace(/\b(selected|active|m-selected)\b/g, '').trim() + ' hoq-dc-tab';
  tab.textContent = 'Social/Settings';
  tab.style.cursor = 'pointer';
  tab.addEventListener('click', (e) => { e.preventDefault(); toggleDiscord(); });
  li.appendChild(tab);
  libLi.insertAdjacentElement('afterend', li);
}

// Social/Settings -> Changes: what changed, newest first. Same list on the PC
// and the phone. When something ships, add it at the top (a new `id` puts the
// dot on the tab for everyone who hasn't opened it since).
// Each item: [kind, where, text]: kind 'new' | 'fix', where 'phone' | 'pc' | ''.
const HOQ_CHANGES = [
  { id: 'phone-noads', title: 'Phone: no pop-up ads, dark Home', when: 'Nov 23, 2026', items: [
    ['fix', 'phone', 'No more full-screen ads popping up on the phone.'],
    ['fix', 'phone', 'Home is dark again: its sections were white boxes on the phone.'],
    ['new', 'phone', 'Settings → Home Screen app → Page details copies how the page is built, for bug reports. No sign-in or personal info.'],
    ['new', 'phone', 'The Discord menu says what each option does: Play in Discord has the bot play it in your voice channel (and posts it), Share to Discord only posts it.'],
  ] },
  { id: 'v1.6.44', title: 'v1.6.44: check for updates, and phone fixes', when: 'Nov 23, 2026', items: [
    ['new', 'pc', 'A Check for updates button in the header, next to the compact player. It finds, downloads and offers the update right then.'],
    ['fix', 'phone', 'Tapping a song stays in holdonquietly instead of opening the SoundCloud app.'],
    ['fix', 'phone', 'Next and the scrubber work on the lock screen.'],
    ['fix', 'phone', 'A song ending while your phone is locked moves on to the next one, instead of waiting until you unlock.'],
    ['fix', 'phone', 'Pressing Next in the full-screen player no longer closes it.'],
    ['new', 'phone', 'Settings has its own button in the bottom bar.'],
    ['fix', 'phone', 'Turned sideways, your phone keeps the phone layout, and Home\'s sections are no longer white boxes on an iPad or a computer.'],
    ['fix', '', 'Match song cover changes the colours as soon as the song does.'],
    ['fix', 'phone', 'The Discord buttons show the real Discord logo.'],
  ] },
  { id: 'v1.6.43', title: 'v1.6.43: sign in with no PC', when: 'Nov 22, 2026', items: [
    ['new', 'phone', 'No PC? Sign in on soundcloud.com and a bookmark brings you back here signed in. Sign in → No PC? has every step. It\'s a stand-in until there\'s a direct way in.'],
    ['new', 'phone', 'Signed in in Safari but not the Home Screen app (or the other way round)? Settings → Home Screen app → Copy link, then paste it into the other one\'s Sign in sheet.'],
    ['fix', '', 'The sign-in code (Settings → Phone → Show code) is much smaller and scans first time. It holds a one-time link now instead of your whole login, so it works once, within 10 minutes.'],
  ] },
  { id: 'v1.6.42', title: 'v1.6.42: scan to sign in', when: 'Nov 22, 2026', items: [
    ['new', 'phone', 'Sign in by scanning: tap Sign in, then Scan the code, and point your phone at the code from the app on your PC (Settings → Phone → Show code). It signs you in right there, in the same tab or Home Screen app.'],
    ['fix', 'phone', 'Your phone stays signed in. iPhone was signing you out every week; the sign-in now lasts a year, and a phone that\'s already signed in moves over by itself.'],
    ['new', 'phone', 'Added to your Home Screen it\'s its own app: holdonquietly name and icon, dark, full screen. Add it again to get the new icon.'],
    ['new', 'phone', 'Bigger buttons, room for the notch in landscape, sheets that move above the keyboard, and Reduce Motion is respected.'],
    ['fix', 'phone', 'The 3D tilt, interactive wave and speaker pulse effects are really off on phones now, and a tapped row no longer stays highlighted.'],
    ['fix', '', 'On an iPad or a computer\'s browser, the "You\'re not signed in" banner no longer hides under the top bar.'],
    ['fix', '', 'Other websites can no longer show sc.holdonquietly.com inside their own page.'],
    ['fix', 'pc', 'Last.fm scrobbles are signed exactly the way Last.fm expects, whatever gets sent.'],
    ['new', '', 'This Changes tab: what\'s new and what\'s fixed, newest first. The dot on it goes away once you\'ve looked.'],
  ] },
  { id: 'v1.6.41', title: 'v1.6.41: bug runs', when: 'Nov 22, 2026', items: [
    ['fix', '', 'A link in a Feed post opens in your browser unless it\'s a SoundCloud link (before, any site could open inside the app).'],
    ['fix', '', 'No more empty box under the Feed\'s post field.'],
    ['fix', 'pc', 'Updates work even when the app isn\'t named holdonquietly.exe (a second download is saved as "holdonquietly (1).exe").'],
    ['fix', 'phone', 'The Feed tab works on the phone (it was stuck on "Loading the feed…").'],
    ['fix', 'phone', 'Search filters scroll to the last one, follower and like lists no longer pin a big header, and the grey strip above the tabs is gone.'],
    ['fix', 'phone', 'Last.fm and Accounts (PC only) no longer show in Settings on the phone, and typing in a field doesn\'t zoom the page.'],
    ['fix', 'phone', 'Smaller phone fixes: SoundCloud\'s full-screen pages, the page scrolling behind a track, its own player bar when ours can\'t show, and double taps zooming in.'],
  ] },
  { id: 'phone-layout', title: 'Phone: rebuilt layout', when: 'Nov 22, 2026', items: [
    ['new', 'phone', 'Laid out like a phone app: a tab bar at the bottom (Home, Feed, Library, Social) and a compact top bar with search, notifications, messages and you.'],
    ['new', 'phone', 'The floating player has previous and next next to like and Discord. Swipe it to skip.'],
    ['new', 'phone', 'Full-screen player (tap the floating one): big cover, a seek bar you can drag, shuffle, repeat, like, Discord, Share and your queue. Swipe down to close.'],
    ['new', 'phone', 'Compact track rows, search filters as chips, and artist pages and track pages fitted to the screen.'],
    ['fix', 'phone', 'Seeking (from the player or the lock screen) no longer jumps back to 0:00.'],
  ] },
  { id: 'v1.6.40', title: 'v1.6.40: Go+ songs in full', when: 'Nov 22, 2026', items: [
    ['new', 'pc', 'Go+ songs play in full: the app finds the same song on YouTube and plays it in a small player (Settings → Desktop to turn it off).'],
    ['fix', 'pc', 'If a jam drops you (say your PC slept), the app gets you back in by itself.'],
  ] },
  { id: 'v1.6.39', title: 'v1.6.39: Jam and better search', when: 'Nov 21, 2026', items: [
    ['new', 'pc', 'Jam, like Spotify\'s: start one and friends join with the code; everyone hears what you play and anyone in it can add songs.'],
    ['new', 'pc', 'Search: Best match puts the song you typed first, and Lyrics finds a song from a line you remember.'],
  ] },
];

// Something new since you last looked: a dot on the way in (CSS: hoq-chg-new).
function hoqChangesLatest() { return (HOQ_CHANGES[0] && HOQ_CHANGES[0].id) || ''; }
try {
  if (window.top === window && localStorage.getItem('hoqChangesSeen') !== hoqChangesLatest()) {
    document.documentElement.classList.add('hoq-chg-new');
  }
} catch (e) {}
function hoqChangesSeen() {
  try { localStorage.setItem('hoqChangesSeen', hoqChangesLatest()); } catch (e) {}
  document.documentElement.classList.remove('hoq-chg-new');
  const dot = document.querySelector('#hoq-discord .hoq-chg-dot');
  if (dot) dot.hidden = true;
}

function hoqChangesHtml() {
  const KIND = { new: 'New', fix: 'Fix' }, WHERE = { phone: 'Phone', pc: 'PC' };
  return HOQ_CHANGES.map((c, i) => '<div class="hoq-chg' + (i === 0 ? ' is-latest' : '') + '">' +
    '<div class="hoq-chg-head"><b>' + hoqEsc(c.title) + '</b><span>' + hoqEsc(c.when) + '</span></div>' +
    '<ul>' + c.items.map(([k, w, t]) => '<li>' +
      '<span class="hoq-chg-tags"><em class="hoq-chg-k is-' + k + '">' + KIND[k] + '</em>' +
      (WHERE[w] ? '<em class="hoq-chg-w">' + WHERE[w] + '</em>' : '') + '</span>' +
      '<span class="hoq-chg-t">' + hoqEsc(t) + '</span></li>').join('') + '</ul></div>').join('');
}

function ensureDiscordPanel() {
  let p = document.getElementById('hoq-discord');
  if (p) return p;
  p = document.createElement('div');
  p.id = 'hoq-discord';
  p.innerHTML = `
    <style>
      /* A PAGE, not a modal: it fills the same region SoundCloud's own content
         occupies — under the header, above the player — so the header stays
         usable and the play controls are never covered. Offsets are measured
         (hoqTabMetrics) because the titlebar is merged into the header and the
         player can be hidden, so 50px/0 were wrong on both edges. */
      #hoq-discord { position: fixed; top: var(--hoq-tab-top, 50px); left: 0; right: 0;
        bottom: var(--hoq-tab-bottom, 0px);
        /* No scrim and no backdrop blur: a scrim is what made this read as a
           modal floating over the page. SoundCloud's own content is hidden while
           the tab is active (rule below), so this sits on the app background
           exactly like Home or Library does. */
        z-index: 30; display: none; background: transparent;
        padding: 30px 24px 48px; overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-width: thin;
        scrollbar-color: color-mix(in srgb, var(--sc-accent, #ff5500) 55%, transparent) transparent;
        font-family: Inter, -apple-system, Arial, sans-serif; }
      #hoq-discord::-webkit-scrollbar { width: 10px; }
      #hoq-discord::-webkit-scrollbar-thumb {
        background: color-mix(in srgb, var(--sc-accent, #ff5500) 55%, transparent);
        border-radius: 99px; border: 3px solid transparent; background-clip: content-box; }
      #hoq-discord::-webkit-scrollbar-track { background: transparent; }
      #hoq-discord.open { display: block; animation: hoqIn .18s ease; }
      /* Selected-tab styling so "hoq" reads as the current page, like Home/Feed.
         Use SoundCloud's OWN mechanism — .selected draws border-bottom: 2px solid
         — just in the accent, so the underline sits at exactly the same height as
         the other tabs. The previous ::after sat 6px lower and something already
         paints an inset white line on the item, so the two together read as a
         doubled underline. */
      .hoq-dc-tab.hoq-active {
        color: #fff !important;
        border-bottom: 2px solid var(--sc-accent, #ff5500) !important;
        box-shadow: none !important;
      }
      .hoq-dc-tab.hoq-active::after { content: none !important; }
      /* Only one tab can be current. SoundCloud keeps its 'selected' class on whatever route
         is still mounted underneath, which left Home/Feed lit at the same time. */
      html.hoq-tab .header__navMenuItem.selected:not(.hoq-dc-tab) {
        border-bottom-color: transparent !important;
        color: #999 !important;
      }
      @keyframes hoqIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
      /* Page-width, and on a wide window the sections flow in two columns like a
         real settings page instead of one long 540px ribbon. */
      /* Page content, not a dialog — no panel gradient, border or drop shadow.
         The individual sections keep their own surfaces, same as SoundCloud's. */
      #hoq-discord .hoq-dc-card { max-width: min(1320px, 94vw); margin: 0 auto;
        background: transparent; border: 0; border-radius: 0; padding: 0; box-shadow: none; }
      /* While the tab is the current page, SoundCloud's content is not on screen
         (this is what a route swap does); the header and player stay untouched. */
      html.hoq-tab #content,
      html.hoq-tab .l-listen-wrapper,
      html.hoq-tab .webiIframe,
      html.hoq-tab .l-collection,
      html.hoq-tab .stream,
      html.hoq-tab .webAuthContainerWrapper { display: none !important; }
      @media (min-width: 900px) {
        #hoq-discord .hoq-dc-card { padding: 28px 30px; }
        #hoq-discord .hoq-dc-body { display: grid; grid-template-columns: 1fr 1fr; gap: 0 26px; align-items: start; }
        #hoq-discord .hoq-dc-body > .hoq-dc-sec.hoq-wide { grid-column: 1 / -1; }
      }
      #hoq-discord .hoq-dc-top { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; }
      /* Page header, not a dialog title bar — a tab has no close button; you
         leave it by picking another tab, the same as Home or Library. */
      #hoq-discord .hoq-dc-logo { width: 42px; height: 42px; object-fit: contain;
        filter: drop-shadow(0 0 8px color-mix(in srgb, var(--sc-accent,#ff5500) 55%, transparent)); }
      #hoq-discord .hoq-dc-titles { flex: 1; display: flex; flex-direction: column; gap: 2px; }
      #hoq-discord .hoq-dc-top span { font-weight: 800; font-size: 26px; color: #fff; letter-spacing: -.3px;
        text-shadow: 0 2px 14px rgba(0,0,0,0.55); }
      #hoq-discord .hoq-dc-top small { color: #c4c4c8; font-size: 12.5px; text-shadow: 0 1px 6px rgba(0,0,0,0.6); }
      #hoq-discord .hoq-dc-accent { display: flex; gap: 5px; }
      #hoq-discord .hoq-dc-accent i { width: 16px; height: 16px; border-radius: 5px; display: block;
        border: 1px solid rgba(255,255,255,0.18); }
      #hoq-discord .hoq-dc-accent .a1 { background: var(--sc-accent,#ff5500); }
      #hoq-discord .hoq-dc-accent .a2 { background: var(--sc-accent-bg,#ff5500); }

      /* now-playing hero */
      #hoq-discord .hoq-dc-bar { height: 4px; border-radius: 99px; margin-top: 8px;
        background: rgba(255,255,255,0.12); overflow: hidden; }
      #hoq-discord .hoq-dc-bar i { display: block; height: 100%; width: 0%;
        background: var(--sc-accent-bg, var(--sc-accent,#ff5500)); border-radius: 99px;
        transition: width .4s linear; }
      #hoq-discord .hoq-dc-times { display: flex; justify-content: space-between;
        color: #8a8a8c; font-size: 11px; margin-top: 4px; font-variant-numeric: tabular-nums; }

      /* quick actions */
      #hoq-discord .hoq-dc-quick { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
      #hoq-discord .hoq-dc-quick button { border: 1px solid rgba(255,255,255,0.12);
        background: rgba(12,12,14,0.55); backdrop-filter: blur(16px); color: #e4e4e6; border-radius: 999px;
        padding: 8px 14px; font-size: 12.5px; font-weight: 600; cursor: pointer;
        transition: background .12s ease, border-color .12s ease, color .12s ease; }
      #hoq-discord .hoq-dc-quick button:hover {
        background: color-mix(in srgb, var(--sc-accent,#ff5500) 20%, transparent);
        border-color: color-mix(in srgb, var(--sc-accent,#ff5500) 55%, transparent); color: #fff; }
      #hoq-discord .hoq-dc-quick button.done {
        background: var(--sc-accent,#ff5500); border-color: transparent; color: #fff; }

      /* listening stats */
      #hoq-discord .hoq-stat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
      #hoq-discord .hoq-stat-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
      #hoq-discord .hoq-stat-range { display: inline-flex; padding: 2px; border-radius: 999px; background: rgba(255,255,255,0.06);
        border: 1px solid rgba(255,255,255,0.08); letter-spacing: normal; text-transform: none; }
      #hoq-discord .hoq-stat-range button { border: 0; background: none; color: #a9a9b2; font-size: 11px; font-weight: 700;
        padding: 4px 11px; border-radius: 999px; cursor: pointer; }
      #hoq-discord .hoq-stat-range button.hoq-on { background: var(--sc-accent,#ff5500); color: #fff; }
      #hoq-discord .hoq-stat-tools { display: inline-flex; align-items: center; gap: 8px; }
      #hoq-discord .hoq-recap-btn { border: 1px solid color-mix(in srgb, var(--sc-accent,#ff5500) 50%, transparent); border-radius: 999px;
        background: color-mix(in srgb, var(--sc-accent,#ff5500) 18%, transparent); color: #fff; font-size: 11px; font-weight: 800;
        padding: 4px 12px; cursor: pointer; letter-spacing: normal; text-transform: none; }
      #hoq-discord .hoq-recap-btn:hover { background: color-mix(in srgb, var(--sc-accent,#ff5500) 32%, transparent); }
      #hoq-discord .hoq-stat { background: rgba(12,12,14,0.55); backdrop-filter: blur(20px) saturate(1.3);
        border: 1px solid rgba(255,255,255,0.09); border-radius: 12px; padding: 12px 13px;
        display: flex; flex-direction: column; gap: 2px; }
      #hoq-discord .hoq-stat b { color: var(--sc-accent,#ff5500); font-size: 21px; font-weight: 800;
        font-variant-numeric: tabular-nums; }
      #hoq-discord .hoq-stat span { color: #8a8a8c; font-size: 11px; text-transform: uppercase;
        letter-spacing: 1px; font-weight: 700; }
      #hoq-discord .hoq-stat-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-top: 16px; }
      #hoq-discord .hoq-top { list-style: none; margin: 0; padding: 0; display: flex;
        flex-direction: column; gap: 5px; counter-reset: hoqrank; }
      #hoq-discord .hoq-top li { counter-increment: hoqrank; display: flex; align-items: center; gap: 9px;
        background: rgba(12,12,14,0.5); backdrop-filter: blur(16px);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 9px; padding: 7px 10px; color: #e4e4e6; font-size: 12.5px; }
      #hoq-discord .hoq-top li::before { content: counter(hoqrank); color: var(--sc-accent,#ff5500);
        font-weight: 800; font-size: 11px; min-width: 12px; }
      #hoq-discord .hoq-top li em { margin-left: auto; font-style: normal; color: #8a8a8c; font-size: 11px; }
      #hoq-discord .hoq-top li b { flex: 1; font-weight: 500; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis; }
      #hoq-discord .hoq-stat-reset { background: none; border: 0; color: #8a8a8c; cursor: pointer;
        text-decoration: underline; font-size: 12px; padding: 0 2px; }
      #hoq-discord .hoq-stat-reset:hover { color: #ff9a9a; }
      #hoq-discord .hoq-dc-sec { margin-bottom: 18px; }
      #hoq-discord .hoq-dc-label { font-size: 11px; text-transform: uppercase; letter-spacing: 1.2px;
        color: #c9c9cc; font-weight: 700; margin-bottom: 9px;
        text-shadow: 0 1px 6px rgba(0,0,0,0.6); }
      #hoq-discord .hoq-dc-presence { display: flex; gap: 14px; align-items: center;
        background: rgba(12,12,14,0.55); backdrop-filter: blur(20px) saturate(1.3);
        border: 1px solid rgba(255,255,255,0.09);
        border-radius: 12px; padding: 14px; }
      #hoq-discord .hoq-dc-cover { width: 62px; height: 62px; border-radius: 10px; object-fit: cover;
        box-shadow: 0 2px 8px rgba(0,0,0,0.4); }
      #hoq-discord .hoq-dc-ptext { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
      #hoq-discord .hoq-dc-ptext b { color: var(--sc-accent,#ff5500); font-size: 12px; }
      #hoq-discord .hoq-dc-title { color: #fff; font-weight: 700; font-size: 15px; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis; }
      #hoq-discord .hoq-dc-artist { color: #b7b7ba; font-size: 13px; }
      #hoq-discord .hoq-dc-hint { color: #b9b9bd; font-size: 12px; margin-top: 8px;
        text-shadow: 0 1px 6px rgba(0,0,0,0.6); }
      #hoq-discord .hoq-dc-name, #hoq-discord .hoq-dc-sc { width: 100%; box-sizing: border-box; padding: 10px 12px;
        border-radius: 9px; border: 1px solid rgba(255,255,255,0.12); background: rgba(12,12,14,0.55);
        color: #e4e4e6; font-size: 13px; outline: none; }
      #hoq-discord .hoq-dc-name:focus, #hoq-discord .hoq-dc-sc:focus { border-color: var(--sc-accent,#ff5500); }
      #hoq-discord .hoq-dc-friends { min-height: 20px; display: flex; flex-direction: column; gap: 6px; }
      #hoq-discord .hoq-dc-friend { display: flex; gap: 12px; align-items: center; padding: 8px;
        border-radius: 10px; background: rgba(12,12,14,0.5); backdrop-filter: blur(16px);
        border: 1px solid rgba(255,255,255,0.08); }
      #hoq-discord .hoq-dc-fcover { width: 42px; height: 42px; border-radius: 8px; object-fit: cover; flex: none; }
      #hoq-discord .hoq-dc-ftext { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      #hoq-discord .hoq-dc-ftext b { color: #fff; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #hoq-discord .hoq-dc-ftext span { color: #b7b7ba; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #hoq-discord .hoq-me { font-style: normal; font-size: 10px; font-weight: 700; margin-left: 7px;
        padding: 1px 6px; border-radius: 99px; text-transform: uppercase; letter-spacing: .6px;
        color: #fff; background: color-mix(in srgb, var(--sc-accent,#ff5500) 60%, transparent); }
      #hoq-discord .hoq-dc-friend.is-me { border-color: color-mix(in srgb, var(--sc-accent,#ff5500) 35%, transparent); }
      #hoq-discord .hoq-dc-ftext { flex: 1 1 auto; }
      #hoq-discord .hoq-dc-along { flex: none; height: 28px; padding: 0 12px; border-radius: 99px; cursor: pointer; white-space: nowrap;
        border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.05); color: #e4e4ea;
        font: 600 12px Inter,-apple-system,Arial,sans-serif; transition: background .12s ease, border-color .12s ease; }
      #hoq-discord .hoq-dc-along:hover { background: rgba(255,255,255,0.1); border-color: rgba(255,255,255,0.22); }
      #hoq-discord .hoq-dc-along.on { background: color-mix(in srgb, var(--sc-accent,#ff5500) 24%, transparent);
        border-color: color-mix(in srgb, var(--sc-accent,#ff5500) 45%, transparent); color: #fff; }
      #hoq-discord .hoq-dc-follow { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 8px 8px 12px;
        border-radius: 10px; font-size: 12.5px; color: #d6d6dc;
        background: color-mix(in srgb, var(--sc-accent,#ff5500) 14%, rgba(12,12,14,0.5));
        border: 1px solid color-mix(in srgb, var(--sc-accent,#ff5500) 30%, transparent); }
      #hoq-discord .hoq-dc-follow b { color: #fff; }
      #hoq-discord .hoq-dc-unfollow { height: 26px; padding: 0 11px; border: 0; border-radius: 99px; cursor: pointer;
        background: rgba(255,255,255,0.1); color: #fff; font: 600 12px Inter,-apple-system,Arial,sans-serif; }
      #hoq-discord .hoq-dc-unfollow:hover { background: rgba(255,255,255,0.18); }
      #hoq-discord .hoq-toast-test { margin-left: 8px; height: 22px; padding: 0 9px; border: 0; border-radius: 99px; cursor: pointer; vertical-align: middle;
        background: rgba(255,255,255,0.1); color: #e4e4ea; font: 600 11px Inter,-apple-system,Arial,sans-serif; }
      #hoq-discord .hoq-toast-test:hover { background: rgba(255,255,255,0.18); color: #fff; }
      /* ===== Community feed ===== */
      #hoq-discord .hoq-feed-composer { display: flex; gap: 11px; align-items: flex-start; margin-bottom: 14px; }
      #hoq-discord .hoq-feed-avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; flex: none;
        background: rgba(255,255,255,0.06); box-shadow: 0 0 0 2px color-mix(in srgb, var(--sc-accent,#ff5500) 45%, transparent); }
      #hoq-discord .hoq-feed-cwrap { flex: 1; min-width: 0; }
      #hoq-discord .hoq-feed-input { width: 100%; box-sizing: border-box; resize: none; overflow: hidden;
        background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.09); border-radius: 12px;
        color: #fff; font: 500 13px Inter, system-ui, sans-serif; padding: 10px 12px; min-height: 40px; line-height: 1.4;
        transition: border-color .14s ease, background .14s ease; }
      #hoq-discord .hoq-feed-input:focus { outline: none; border-color: color-mix(in srgb, var(--sc-accent,#ff5500) 55%, transparent);
        background: rgba(255,255,255,0.06); }
      #hoq-discord .hoq-feed-input::placeholder { color: #8a8a90; }
      #hoq-discord .hoq-feed-attached { display: flex; align-items: center; gap: 10px; margin-top: 8px; padding: 7px 9px;
        background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.09); border-radius: 10px; position: relative; }
      /* display: flex beat the hidden attribute: an empty box sat under the composer */
      #hoq-discord .hoq-feed-attached[hidden] { display: none; }
      #hoq-discord .hoq-feed-attached img { width: 34px; height: 34px; border-radius: 6px; object-fit: cover; flex: none; }
      #hoq-discord .hoq-feed-attached .fa-t { color: #fff; font-size: 12.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #hoq-discord .hoq-feed-attached .fa-a { color: #b0b0b6; font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #hoq-discord .hoq-feed-attached .fa-x { margin-left: auto; background: none; border: 0; color: #b0b0b6; cursor: pointer; font-size: 16px; padding: 2px 6px; }
      #hoq-discord .hoq-feed-attached .fa-x:hover { color: #fff; }
      #hoq-discord .hoq-feed-crow { display: flex; align-items: center; gap: 8px; margin-top: 9px; }
      #hoq-discord .hoq-feed-attach { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.09);
        color: #cfcfd4; font: 600 12px Inter, system-ui, sans-serif; padding: 7px 12px; border-radius: 9px; cursor: pointer;
        transition: background .14s ease, color .14s ease, border-color .14s ease; }
      #hoq-discord .hoq-feed-attach:hover { color: #fff; border-color: color-mix(in srgb, var(--sc-accent,#ff5500) 40%, transparent); }
      #hoq-discord .hoq-feed-attach.on { color: #fff; background: color-mix(in srgb, var(--sc-accent,#ff5500) 20%, transparent);
        border-color: color-mix(in srgb, var(--sc-accent,#ff5500) 50%, transparent); }
      #hoq-discord .hoq-feed-post { margin-left: auto; background: var(--sc-accent,#ff5500); border: 0; color: #fff;
        font: 700 12.5px Inter, system-ui, sans-serif; padding: 8px 18px; border-radius: 9px; cursor: pointer;
        box-shadow: 0 0 12px color-mix(in srgb, var(--sc-accent,#ff5500) 35%, transparent); transition: filter .14s ease, opacity .14s ease; }
      #hoq-discord .hoq-feed-post:hover { filter: brightness(1.08); }
      #hoq-discord .hoq-feed-post:disabled { opacity: .45; cursor: default; box-shadow: none; }
      #hoq-discord .hoq-feed-list { display: flex; flex-direction: column; gap: 10px; }
      #hoq-discord .hoq-feed-item { display: flex; gap: 11px; align-items: flex-start; padding: 11px 12px;
        background: rgba(12,12,14,0.5); border: 1px solid rgba(255,255,255,0.07); border-radius: 12px;
        backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); animation: hoqIn .2s ease; }
      #hoq-discord .hoq-feed-item.sys { border-color: color-mix(in srgb, var(--sc-accent,#ff5500) 28%, transparent);
        background: color-mix(in srgb, var(--sc-accent,#ff5500) 8%, rgba(12,12,14,0.5)); }
      #hoq-discord .hoq-feed-item.pending { opacity: .6; }
      #hoq-discord .hoq-fi-av { width: 38px; height: 38px; border-radius: 50%; object-fit: cover; flex: none; background: rgba(255,255,255,0.06); }
      #hoq-discord .hoq-fi-body { flex: 1; min-width: 0; }
      #hoq-discord .hoq-fi-head { display: flex; align-items: baseline; gap: 8px; }
      #hoq-discord .hoq-fi-name { color: #fff; font-weight: 700; font-size: 13px; text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #hoq-discord a.hoq-fi-name:hover { color: var(--sc-accent,#ff5500); }
      #hoq-discord .hoq-fi-time { color: #7f7f86; font-size: 11px; flex: none; margin-left: auto; }
      #hoq-discord .hoq-fi-text { color: #dcdce0; font-size: 13px; line-height: 1.45; margin-top: 3px; white-space: pre-wrap; word-break: break-word; }
      #hoq-discord .hoq-fi-track { display: flex; gap: 10px; align-items: center; margin-top: 8px; padding: 8px 9px;
        background: rgba(255,255,255,0.045); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; cursor: pointer;
        text-decoration: none; transition: background .14s ease; }
      #hoq-discord .hoq-fi-track:hover { background: rgba(255,255,255,0.08); }
      #hoq-discord .hoq-fi-track img { width: 40px; height: 40px; border-radius: 7px; object-fit: cover; flex: none; }
      #hoq-discord .hoq-fi-track .ft-t { color: #fff; font-size: 12.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #hoq-discord .hoq-fi-track .ft-a { color: #b0b0b6; font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #hoq-discord .hoq-fi-track .ft-play { margin-left: auto; color: var(--sc-accent,#ff5500); flex: none; }
      #hoq-discord .hoq-feed-empty { text-align: center; color: #9a9aa0; font-size: 12.5px; padding: 18px 10px; line-height: 1.5; }
      #hoq-discord .hoq-feed-off { color: #8a8a90; font-size: 11.5px; margin-top: 4px; }
      #hoq-discord .hoq-dc-sclink { color: var(--sc-accent,#ff5500); font-size: 11px; cursor: pointer; text-decoration: none; }
      #hoq-discord .hoq-dc-sclink:hover { text-decoration: underline; }
      #hoq-discord .hoq-dc-open { width: 100%; padding: 11px; border-radius: 10px; cursor: pointer;
        border: 0; background: var(--sc-accent-bg,#5865F2); color: #fff; font-weight: 700; font-size: 14px; }
      #hoq-discord .hoq-dc-open:hover { filter: brightness(1.1); }
      /* Discord server embed */
      #hoq-discord .hoq-dc-embed { display: flex; gap: 13px; align-items: center; margin-bottom: 10px;
        background: rgba(88,101,242,0.10); border: 1px solid rgba(88,101,242,0.35);
        border-radius: 12px; padding: 13px; }
      #hoq-discord .hoq-dc-embed .hoq-dc-eicon { width: 46px; height: 46px; border-radius: 12px; object-fit: cover;
        background: #5865F2; flex: none; }
      #hoq-discord .hoq-dc-embed .hoq-dc-etext { min-width: 0; flex: 1; }
      #hoq-discord .hoq-dc-embed .hoq-dc-ename { color: #fff; font-weight: 800; font-size: 15px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #hoq-discord .hoq-dc-embed .hoq-dc-eonline { color: #b7f7c0; font-size: 12px; margin-top: 2px; display: flex; align-items: center; gap: 6px; }
      #hoq-discord .hoq-dc-embed .hoq-dc-dot { width: 8px; height: 8px; border-radius: 50%; background: #3ba55d; display: inline-block; }
      /* Last.fm scrobbler */
      #hoq-discord .hoq-lf { display: flex; gap: 14px; align-items: center;
        background: rgba(12,12,14,0.55); backdrop-filter: blur(20px) saturate(1.3);
        border: 1px solid rgba(255,255,255,0.09);
        border-radius: 12px; padding: 14px; }
      #hoq-discord .hoq-lf-logo { width: 44px; height: 44px; border-radius: 12px; flex: none;
        background: linear-gradient(180deg,#e21212,#b40707); display: flex; align-items: center; justify-content: center;
        box-shadow: 0 3px 10px rgba(213,16,7,0.32); }
      #hoq-discord .hoq-lf-logo svg { display: block; }
      #hoq-discord .hoq-lf-text { flex: 1; min-width: 0; }
      #hoq-discord .hoq-lf-state { color: #fff; font-weight: 700; font-size: 14.5px; }
      #hoq-discord .hoq-lf-sub { color: #8a8a8c; font-size: 12px; margin-top: 3px; line-height: 1.4; }
      #hoq-discord .hoq-lf-btn { border: 0; border-radius: 10px; padding: 9px 18px; cursor: pointer;
        font-weight: 700; font-size: 13px; background: #d51007; color: #fff; flex: none;
        transition: filter .12s ease, background .12s ease; }
      #hoq-discord .hoq-lf-btn:hover { filter: brightness(1.12); }
      #hoq-discord .hoq-lf-btn.is-off { background: rgba(255,255,255,0.08); color: #d8d8db;
        border: 1px solid rgba(255,255,255,0.12); }
      #hoq-discord .hoq-lf-btn.is-off:hover { background: rgba(255,255,255,0.14); filter: none; }
      /* Discord Rich Presence */
      #hoq-discord .hoq-rp { background: rgba(12,12,14,0.55); backdrop-filter: blur(20px) saturate(1.3);
        border: 1px solid rgba(255,255,255,0.09); border-radius: 12px; padding: 2px 14px; }
      #hoq-discord .hoq-rp-row { display: flex; align-items: center; justify-content: space-between;
        gap: 14px; padding: 11px 0; cursor: pointer; transition: opacity .15s ease; }
      #hoq-discord .hoq-rp-row + .hoq-rp-row { border-top: 1px solid rgba(255,255,255,0.06); }
      #hoq-discord .hoq-rp-static { cursor: default; }
      #hoq-discord .hoq-rp-row > span { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      #hoq-discord .hoq-rp-row b { color: #fff; font-size: 13.5px; font-weight: 700; }
      #hoq-discord .hoq-rp-row em { color: #8a8a8c; font-size: 12px; font-style: normal;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #hoq-discord .hoq-rp-preview { color: var(--sc-accent,#ff5500) !important; font-weight: 600; }
      #hoq-discord .hoq-rp.is-off .hoq-rp-row:not(:first-child) { opacity: .4; pointer-events: none; }
      /* switches: same look as the Settings palette toggles */
      #hoq-discord .hoq-rp-sw { appearance: none; -webkit-appearance: none; flex: none; cursor: pointer;
        box-sizing: border-box; width: 42px; height: 23px; border-radius: 23px; position: relative; margin: 0;
        background: rgba(255,255,255,0.04); border: 1.5px solid rgba(255,255,255,0.24);
        transition: background .2s ease, border-color .2s ease; }
      #hoq-discord .hoq-rp-sw:hover { border-color: rgba(255,255,255,0.44); background: rgba(255,255,255,0.07); }
      #hoq-discord .hoq-rp-sw::after { content: ''; position: absolute; top: 4px; left: 4px; width: 11px; height: 11px;
        border-radius: 50%; background: rgba(255,255,255,0.5);
        transition: transform .26s cubic-bezier(.34,1.55,.64,1), width .16s ease, height .16s ease,
          top .16s ease, left .16s ease, background .2s ease; }
      #hoq-discord .hoq-rp-sw:checked { background: var(--sc-accent,#ff5500); border-color: var(--sc-accent,#ff5500);
        box-shadow: 0 0 10px color-mix(in srgb, var(--sc-accent,#ff5500) 45%, transparent); }
      #hoq-discord .hoq-rp-sw:checked::after { width: 16px; height: 16px; top: 2px; left: 2px; background: #fff;
        box-shadow: 0 1px 3px rgba(0,0,0,0.5); transform: translateX(19px); }
      #hoq-discord .hoq-rp-sw:focus-visible { outline: 2px solid color-mix(in srgb, var(--sc-accent,#ff5500) 70%, transparent); outline-offset: 2px; }
      /* status-line segmented control */
      #hoq-discord .hoq-rp-seg { display: flex; flex: none; gap: 2px; padding: 3px; border-radius: 10px;
        background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.09); }
      #hoq-discord .hoq-rp-seg button { border: 0; border-radius: 7px; padding: 6px 12px; cursor: pointer;
        background: transparent; color: #b9b9bd; font-size: 12.5px; font-weight: 600;
        transition: background .12s ease, color .12s ease; }
      #hoq-discord .hoq-rp-seg button:hover { color: #fff; }
      #hoq-discord .hoq-rp-seg button.on { background: var(--sc-accent,#ff5500); color: #fff; }
      /* Discord webhook */
      #hoq-discord .hoq-hook-state.is-bad { color: #ffb4a8; }
      #hoq-discord .hoq-hook-edit { display: flex; gap: 8px; padding: 0 0 12px; }
      #hoq-discord .hoq-hook-input { flex: 1; min-width: 0; box-sizing: border-box; padding: 9px 12px; border-radius: 9px;
        border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.04); color: #e4e4e6;
        font-size: 13px; outline: none; }
      #hoq-discord .hoq-hook-input:focus { border-color: var(--sc-accent,#ff5500); }
      #hoq-discord .hoq-hook-save { border: 0; border-radius: 9px; padding: 9px 16px; cursor: pointer; flex: none;
        font-weight: 700; font-size: 12px; background: var(--sc-accent,#ff5500); color: #fff; }
      #hoq-discord .hoq-hook-save:disabled { opacity: .6; cursor: default; }
      #hoq-discord .hoq-hook-remove { flex: none; border: 1px solid rgba(255,255,255,0.12); border-radius: 8px;
        padding: 6px 12px; cursor: pointer; background: rgba(255,255,255,0.05); color: #c9c9d2; font-size: 12px; font-weight: 600; }
      #hoq-discord .hoq-hook-remove:hover { background: rgba(255,255,255,0.1); color: #fff; }
      #hoq-discord .hoq-pair-btn { flex: none; border: 0; border-radius: 9px; padding: 9px 16px; cursor: pointer;
        font-weight: 700; font-size: 12px; background: var(--sc-accent,#ff5500); color: #fff; }
      #hoq-discord .hoq-pair-btn:hover { filter: brightness(1.1); }
      #hoq-discord .hoq-hoq-sec > .hoq-dc-label { display: none; }
      /* Account card: picture | who + stats | buttons, profile switches as a
         footer row. One quiet card: no rings, no boxed chips, no glow. */
      #hoq-discord .hoq-hoq-bar { position: relative; overflow: hidden; display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; column-gap: 14px;
        padding: 14px 16px; margin-bottom: 6px; border-radius: 14px;
        background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); }
      #hoq-discord .hoq-hoq-bar > :not(.hoq-hoq-banner) { position: relative; z-index: 1; }
      /* their banner / page background / blurred picture, kept dim so text reads */
      #hoq-discord .hoq-hoq-banner { position: absolute; inset: 0; z-index: 0; opacity: 0; transition: opacity .4s ease;
        background-size: cover; background-position: center; }
      #hoq-discord .hoq-hoq-banner.is-blur { inset: -40px; filter: blur(30px) saturate(1.4); transform: scale(1.15); }
      #hoq-discord .hoq-hoq-banner::after { content: ''; position: absolute; inset: 0;
        background: linear-gradient(90deg, rgba(12,12,15,0.9) 0%, rgba(12,12,15,0.78) 55%, rgba(12,12,15,0.6) 100%); }
      #hoq-discord .hoq-hoq-bar.has-card .hoq-hoq-banner { opacity: 1; }
      #hoq-discord .hoq-hoq-pic { width: 52px; height: 52px; border-radius: 50%; object-fit: cover;
        background: rgba(255,255,255,0.06); box-shadow: 0 4px 14px rgba(0,0,0,.35); }
      #hoq-discord .hoq-hoq-pic.is-logo { object-fit: contain; padding: 9px; box-sizing: border-box; box-shadow: none; }
      #hoq-discord .hoq-hoq-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
      #hoq-discord .hoq-hoq-line1 { display: flex; align-items: center; gap: 8px; min-width: 0; }
      #hoq-discord .hoq-hoq-name { font-size: 15px; font-weight: 650; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #hoq-discord .hoq-hoq-badges { display: flex; gap: 4px; flex: none; }
      #hoq-discord .hoq-hoq-badge { font-size: 10.5px; font-weight: 600; line-height: 17px; padding: 0 6px; border-radius: 5px;
        color: #d4d4dc; background: rgba(255,255,255,0.09); white-space: nowrap; }
      #hoq-discord .hoq-hoq-badge:first-child { color: color-mix(in srgb, var(--sc-accent,#ff5500) 55%, #fff);
        background: color-mix(in srgb, var(--sc-accent,#ff5500) 18%, transparent); }
      #hoq-discord .hoq-hoq-sub { font-style: normal; font-size: 12px; color: #8e8e99; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #hoq-discord .hoq-hoq-sub.is-bad { color: #ff8a7a; white-space: normal; }
      #hoq-discord .hoq-hoq-bio { font-size: 12.5px; color: #d6d6dc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #hoq-discord .hoq-hoq-bio[hidden], #hoq-discord .hoq-hoq-mini[hidden], #hoq-discord .hoq-hoq-pub[hidden] { display: none; }
      /* stats: one line of text, numbers bright, dot-separated */
      #hoq-discord .hoq-hoq-mini { display: flex; min-width: 0; margin-top: 2px; font-size: 12px; color: #8e8e99;
        white-space: nowrap; overflow: hidden; }
      #hoq-discord .hoq-hoq-chip { flex: none; }
      #hoq-discord .hoq-hoq-chip:last-child { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
      #hoq-discord .hoq-hoq-chip + .hoq-hoq-chip::before { content: '·'; margin: 0 7px; color: #5c5c66; }
      #hoq-discord .hoq-hoq-chip b { color: #f0f0f4; font-weight: 600; }
      #hoq-discord .hoq-hoq-btns { display: flex; gap: 6px; }
      #hoq-discord .hoq-hoq-btns button { height: 30px; padding: 0 13px; border-radius: 8px; font-size: 12px; font-weight: 600; }
      #hoq-discord .hoq-hoq-bar.is-in .hoq-hoq-btn { background: transparent; color: #c9c9d2;
        border: 1px solid rgba(255,255,255,0.14); }
      #hoq-discord .hoq-hoq-bar.is-in .hoq-hoq-btn:hover { color: #fff; border-color: rgba(255,255,255,0.28); filter: none; }
      /* "On my profile" footer: two small toggle pills */
      #hoq-discord .hoq-hoq-pubs { grid-column: 1 / -1; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
        margin-top: 12px; padding-top: 11px; border-top: 1px solid rgba(255,255,255,0.07); font-size: 11.5px; color: #7d7d88; }
      #hoq-discord .hoq-hoq-pubs:not(:has(.hoq-hoq-pub:not([hidden]))) { display: none; }
      #hoq-discord .hoq-hoq-pubs > span { margin-right: 4px; }
      #hoq-discord .hoq-hoq-pub { position: relative; display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px;
        border-radius: 99px; background: rgba(255,255,255,0.06); color: #b4b4be; cursor: pointer; user-select: none;
        transition: background .14s ease, color .14s ease; }
      #hoq-discord .hoq-hoq-pub:hover { background: rgba(255,255,255,0.1); color: #fff; }
      #hoq-discord .hoq-hoq-pub input { position: absolute; opacity: 0; pointer-events: none; }
      #hoq-discord .hoq-hoq-pub::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: #5c5c66; transition: background .14s ease; }
      #hoq-discord .hoq-hoq-pub:has(input:checked) { background: color-mix(in srgb, var(--sc-accent,#ff5500) 16%, transparent);
        color: color-mix(in srgb, var(--sc-accent,#ff5500) 55%, #fff); }
      #hoq-discord .hoq-hoq-pub:has(input:checked)::before { background: var(--sc-accent,#ff5500); }
      #hoq-discord .hoq-hoq-pub:has(input:focus-visible) { outline: 2px solid var(--sc-accent,#ff5500); outline-offset: 2px; }
      #hoq-discord .hoq-hoq-sec { container-type: inline-size; }
      @container (max-width: 520px) { #hoq-discord .hoq-hoq-bar { grid-template-columns: auto minmax(0, 1fr); }
        #hoq-discord .hoq-hoq-btns { grid-column: 1 / -1; margin-top: 10px; } }
      #hoq-discord .hoq-pair-linkbtn { flex: none; border: 1px solid rgba(255,255,255,0.14); border-radius: 9px;
        padding: 8px 15px; cursor: pointer; font-weight: 700; font-size: 12px;
        background: rgba(255,255,255,0.05); color: #e4e4e6; }
      #hoq-discord .hoq-pair-linkbtn:hover { background: rgba(255,255,255,0.1); }
      #hoq-discord .hoq-pair-linkbtn:disabled { opacity: .6; cursor: default; }
      /* Accounts */
      #hoq-discord .hoq-acct-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
      #hoq-discord .hoq-acct-row { display: flex; align-items: center; gap: 10px; padding: 9px 11px;
        border-radius: 10px; background: rgba(12,12,14,0.5); backdrop-filter: blur(16px);
        border: 1px solid rgba(255,255,255,0.08); }
      #hoq-discord .hoq-acct-row b { flex: 1; color: #e4e4e6; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #hoq-discord .hoq-acct-sw { border: 0; border-radius: 7px; padding: 6px 12px; cursor: pointer;
        background: var(--sc-accent-bg,#5865F2); color: #fff; font-weight: 700; font-size: 12px; }
      #hoq-discord .hoq-acct-sw:hover { filter: brightness(1.1); }
      #hoq-discord .hoq-acct-rm { border: 0; background: transparent; color: #8a8a8c; cursor: pointer; font-size: 15px; }
      #hoq-discord .hoq-acct-rm:hover { color: #e81123; }
      #hoq-discord .hoq-acct-add { display: flex; gap: 8px; }
      #hoq-discord .hoq-acct-name { flex: 1; box-sizing: border-box; padding: 9px 12px; border-radius: 9px;
        border: 1px solid rgba(255,255,255,0.12); background: rgba(12,12,14,0.55);
        backdrop-filter: blur(16px); color: #e4e4e6; font-size: 13px; outline: none; }
      #hoq-discord .hoq-acct-name:focus { border-color: var(--sc-accent,#ff5500); }
      #hoq-discord .hoq-acct-save, #hoq-discord .hoq-acct-new { border: 0; border-radius: 9px; padding: 9px 14px;
        cursor: pointer; font-weight: 700; font-size: 12px; }
      #hoq-discord .hoq-acct-save { background: var(--sc-accent,#ff5500); color: #fff; }
      #hoq-discord .hoq-acct-new { width: 100%; margin-top: 8px; background: rgba(12,12,14,0.55);
        backdrop-filter: blur(16px); color: #e4e4e6; border: 1px solid rgba(255,255,255,0.12); }
      #hoq-discord .hoq-sub {
        display: flex; gap: 4px; margin: 0 0 16px;
        border-bottom: 1px solid rgba(255,255,255,0.09); padding-bottom: 0;
      }
      #hoq-discord .hoq-subtab {
        background: none; border: 0; cursor: pointer;
        padding: 7px 2px; margin-right: 18px;
        font: 700 12.5px/1 Inter, -apple-system, Arial, sans-serif;
        color: #8b8b8f; letter-spacing: .2px;
        border-bottom: 2px solid transparent; margin-bottom: -1px;
      }
      #hoq-discord .hoq-subtab:hover { color: #d2d2d6; }
      #hoq-discord .hoq-subtab.hoq-on {
        color: #fff; border-bottom-color: var(--sc-accent, #ff5500);
      }
      /* One pane at a time; sections are tagged in ensureDiscordPanel(). */
      #hoq-discord[data-pane="social"] .hoq-dc-sec.hoq-pane-set,
      #hoq-discord[data-pane="social"] .hoq-dc-sec.hoq-pane-feed,
      #hoq-discord[data-pane="social"] .hoq-dc-sec.hoq-pane-changes { display: none !important; }
      #hoq-discord[data-pane="settings"] .hoq-dc-sec:not(.hoq-pane-set) { display: none !important; }
      #hoq-discord[data-pane="feed"] .hoq-dc-sec:not(.hoq-pane-feed) { display: none !important; }
      #hoq-discord[data-pane="changes"] .hoq-dc-sec:not(.hoq-pane-changes) { display: none !important; }
      /* Changes: what's new, one card per update, newest first (HOQ_CHANGES) */
      #hoq-discord .hoq-chg-tab { position: relative; }
      #hoq-discord .hoq-chg-dot { position: absolute; top: 2px; right: -9px; width: 7px; height: 7px; border-radius: 50%;
        background: var(--sc-accent, #ff5500); box-shadow: 0 0 8px color-mix(in srgb, var(--sc-accent,#ff5500) 70%, transparent); }
      #hoq-discord .hoq-chg-dot[hidden] { display: none; }
      #hoq-discord .hoq-pane-changes { background: none; border: 0; padding: 0; box-shadow: none; }
      #hoq-discord .hoq-chg-list { display: flex; flex-direction: column; gap: 14px; }
      #hoq-discord .hoq-chg { padding: 16px 18px 8px; border-radius: 14px; background: rgba(255,255,255,0.035);
        border: 1px solid rgba(255,255,255,0.07); }
      #hoq-discord .hoq-chg.is-latest { border-color: color-mix(in srgb, var(--sc-accent,#ff5500) 45%, transparent);
        background: color-mix(in srgb, var(--sc-accent,#ff5500) 7%, rgba(255,255,255,0.03)); }
      #hoq-discord .hoq-chg-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
      #hoq-discord .hoq-chg-head b { color: #fff; font-size: 15px; font-weight: 800; letter-spacing: -.01em; }
      #hoq-discord .hoq-chg-head span { color: #8e8e99; font-size: 12px; white-space: nowrap; }
      #hoq-discord .hoq-chg ul { margin: 0; padding: 0; list-style: none; }
      #hoq-discord .hoq-chg li { display: flex; gap: 12px; align-items: flex-start; padding: 9px 0;
        border-top: 1px solid rgba(255,255,255,0.05); color: #cfcfd6; font-size: 13px; line-height: 1.5; }
      #hoq-discord .hoq-chg li:first-child { border-top: 0; }
      #hoq-discord .hoq-chg-tags { flex: none; display: flex; gap: 4px; width: 96px; padding-top: 1px; }
      #hoq-discord .hoq-chg-tags em { font-style: normal; font-size: 10.5px; font-weight: 800; letter-spacing: .05em;
        text-transform: uppercase; padding: 2px 6px; border-radius: 6px; line-height: 1.45; }
      #hoq-discord .hoq-chg-k.is-new { color: #fff; background: color-mix(in srgb, var(--sc-accent,#ff5500) 72%, transparent); }
      #hoq-discord .hoq-chg-k.is-fix { color: #a7ebc0; background: rgba(60,190,110,0.17); }
      #hoq-discord .hoq-chg-w { color: #c4c4cc; background: rgba(255,255,255,0.09); }
      #hoq-discord .hoq-chg-t { flex: 1 1 auto; min-width: 0; }
      #hoq-discord .hoq-acct-new:hover { background: color-mix(in srgb, var(--sc-accent,#ff5500) 22%, rgba(12,12,14,0.6)); }
      #hoq-discord .hoq-jam-pitch { color: #b9b9bd; font-size: 12.5px; line-height: 1.45; margin-bottom: 10px; }
      #hoq-discord .hoq-jam-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      #hoq-discord .hoq-jam-or { color: #8d8d94; font-size: 12px; margin: 0 2px 0 6px; }
      #hoq-discord .hoq-jam-input { width: 96px; height: 34px; box-sizing: border-box; padding: 0 10px; border-radius: 9px;
        border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.05); color: #fff; outline: none;
        text-transform: uppercase; letter-spacing: 2px; font: 700 13px/1 ui-monospace, Consolas, monospace; }
      #hoq-discord .hoq-jam-input:focus { border-color: var(--sc-accent,#ff5500); }
      #hoq-discord .hoq-jam-head { display: flex; align-items: center; gap: 12px; }
      #hoq-discord .hoq-jam-code { flex: none; padding: 9px 12px; border-radius: 10px; color: #fff; user-select: all; cursor: text;
        font: 800 18px/1 ui-monospace, Consolas, monospace; letter-spacing: 3px;
        background: color-mix(in srgb, var(--sc-accent,#ff5500) 24%, rgba(255,255,255,0.03));
        border: 1px solid color-mix(in srgb, var(--sc-accent,#ff5500) 45%, transparent); }
      #hoq-discord .hoq-jam-meta { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1 1 auto; }
      #hoq-discord .hoq-jam-meta b { color: #fff; font-size: 13.5px; }
      #hoq-discord .hoq-jam-meta span { color: #b7b7ba; font-size: 12px; }
      #hoq-discord .hoq-jam-btns { display: flex; gap: 6px; flex: none; }
      #hoq-discord .hoq-jam-back { border: 0; padding: 0; margin-left: 4px; background: none; cursor: pointer;
        color: var(--sc-accent,#ff5500); font: 700 12px system-ui, sans-serif; text-decoration: underline; }
      #hoq-discord .hoq-jam-people { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0 6px; }
      #hoq-discord .hoq-jam-chip { padding: 4px 10px; border-radius: 99px; font-size: 12px; color: #ddd;
        background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.08); }
      #hoq-discord .hoq-jam-chip em { font-style: normal; color: var(--sc-accent,#ff5500); margin-left: 5px; font-weight: 700; font-size: 11px; }
      #hoq-discord .hoq-jam-tag { flex: none; font-size: 11px; font-weight: 700; color: var(--sc-accent,#ff5500); }
      #hoq-discord .hoq-jam-sub { display: flex; align-items: center; justify-content: space-between; margin: 12px 0 4px;
        font-size: 11px; text-transform: uppercase; letter-spacing: 1.2px; color: #9a9aa2; }
      #hoq-discord .hoq-jam-skip { border: 0; background: none; cursor: pointer; color: var(--sc-accent,#ff5500);
        font: 700 11px system-ui, sans-serif; text-transform: none; letter-spacing: 0; }
      #hoq-discord .hoq-jam-q { display: flex; flex-direction: column; gap: 2px; max-height: 330px; overflow-y: auto; }
      #hoq-discord .hoq-jam-x { flex: none; width: 28px; height: 28px; border-radius: 99px; border: 0; background: transparent;
        color: #9a9aa2; cursor: pointer; font-size: 18px; line-height: 1; }
      #hoq-discord .hoq-jam-x:hover { background: rgba(255,255,255,0.1); color: #fff; }
      #hoq-discord .hoq-jam-add { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
      #hoq-discord .hoq-jam-open { display: flex; gap: 8px; align-items: center; margin-top: 10px; font-size: 12px; color: #b9b9bd; cursor: pointer; }
    </style>
    <div class="hoq-dc-card">
      <div class="hoq-dc-top">
        <img class="hoq-dc-logo" src="${HOQ_LOGO}">
        <div class="hoq-dc-titles"><span>holdonquietly</span></div>
        <div class="hoq-dc-accent" title="Current accent"><i class="a1"></i><i class="a2"></i></div>
      </div>
      <div class="hoq-sub">
        <button class="hoq-subtab hoq-on" data-pane="social">Social</button>
        <button class="hoq-subtab" data-pane="feed">Feed</button>
        <button class="hoq-subtab" data-pane="settings">Settings</button>
        <button class="hoq-subtab hoq-chg-tab" data-pane="changes">Changes<i class="hoq-chg-dot" hidden></i></button>
      </div>
      <div class="hoq-dc-body">
      <div class="hoq-dc-sec hoq-wide">
        <div class="hoq-dc-label">Your listening activity</div>
        <div class="hoq-dc-presence">
          <img class="hoq-dc-cover" src="${HOQ_LOGO}">
          <div class="hoq-dc-ptext">
            <b>Listening to holdonquietly</b>
            <span class="hoq-dc-title">Nothing playing</span>
            <span class="hoq-dc-artist"></span>
            <div class="hoq-dc-bar"><i></i></div>
            <div class="hoq-dc-times"><span class="hoq-dc-pos">0:00</span><span class="hoq-dc-dur">0:00</span></div>
          </div>
        </div>
        <div class="hoq-dc-quick">
          <button data-act="share">Share to Discord</button>
          <button data-act="play">Play in Discord</button>
          <button data-act="copy">Copy track link</button>
          <button data-act="server">Open server</button>
        </div>
      </div>
      <div class="hoq-dc-sec hoq-wide hoq-jam-sec">
        <div class="hoq-dc-label">Jam</div>
        <div class="hoq-jam"></div>
      </div>
      <div class="hoq-dc-sec hoq-wide hoq-feed-sec">
        <div class="hoq-dc-label">Feed</div>
        <div class="hoq-feed-composer">
          <img class="hoq-feed-avatar" src="${HOQ_LOGO}" alt="">
          <div class="hoq-feed-cwrap">
            <textarea class="hoq-feed-input" rows="1" maxlength="500" placeholder="Say something, or share what you’re playing…"></textarea>
            <div class="hoq-feed-attached" hidden></div>
            <div class="hoq-feed-crow">
              <button class="hoq-feed-attach" type="button">♪ Attach current track</button>
              <button class="hoq-feed-post" type="button">Post</button>
            </div>
          </div>
        </div>
        <div class="hoq-feed-list"><div class="hoq-dc-hint">Loading the feed…</div></div>
      </div>
      <div class="hoq-dc-sec hoq-hoq-sec hoq-wide">
        <div class="hoq-dc-label">holdonquietly account</div>
        <div class="hoq-hoq-bar">
          <div class="hoq-hoq-banner"></div>
          <img class="hoq-hoq-pic" alt="">
          <div class="hoq-hoq-text">
            <div class="hoq-hoq-line1"><b class="hoq-hoq-name">holdonquietly account</b><span class="hoq-hoq-badges"></span></div>
            <em class="hoq-hoq-sub">Not signed in · keeps your listening stats and settings with you</em>
            <span class="hoq-hoq-bio" hidden></span>
            <span class="hoq-hoq-mini" hidden></span>
          </div>
          <div class="hoq-hoq-btns">
            <button class="hoq-pair-linkbtn hoq-hoq-profile" type="button" hidden>Profile</button>
            <button class="hoq-pair-btn hoq-hoq-btn" type="button">Sign in</button>
          </div>
          <div class="hoq-hoq-pubs"><span>On my profile</span><label class="hoq-hoq-pub" hidden title="Show my listening stats on my profile"><input type="checkbox">Listening stats</label><label class="hoq-hoq-pub hoq-hoq-nowpub" hidden title="Show what I'm playing on my profile"><input type="checkbox">Now playing</label></div>
        </div>
      </div>
      <div class="hoq-dc-sec">
        <div class="hoq-dc-label">Last.fm scrobbling</div>
        <div class="hoq-lf">
          <div class="hoq-lf-logo">
            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3" y="10.5" width="3.4" height="8.5" rx="1.7" fill="#fff"/>
              <rect x="10.3" y="5" width="3.4" height="14" rx="1.7" fill="#fff"/>
              <rect x="17.6" y="13" width="3.4" height="6" rx="1.7" fill="#fff"/>
            </svg>
          </div>
          <div class="hoq-lf-text">
            <div class="hoq-lf-state">Not connected</div>
            <div class="hoq-lf-sub">Scrobble everything you play to Last.fm.</div>
          </div>
          <button class="hoq-lf-btn">Connect</button>
        </div>
      </div>
      <div class="hoq-dc-sec hoq-rp-sec">
        <div class="hoq-dc-label">Discord Rich Presence</div>
        <div class="hoq-rp">
          <label class="hoq-rp-row">
            <span><b>Show on Discord</b><em>Your profile shows what you're playing.</em></span>
            <input type="checkbox" class="hoq-rp-sw" data-k="hoqRpOn">
          </label>
          <div class="hoq-rp-row hoq-rp-static">
            <span><b>Status line</b><em class="hoq-rp-preview">Listening to …</em></span>
            <div class="hoq-rp-seg">
              <button type="button" data-v="artist">Artist</button>
              <button type="button" data-v="song">Song</button>
              <button type="button" data-v="app">App</button>
            </div>
          </div>
          <label class="hoq-rp-row">
            <span><b>Buttons</b><em>Listen on SoundCloud · Get holdonquietly</em></span>
            <input type="checkbox" class="hoq-rp-sw" data-k="hoqRpButtons">
          </label>
          <label class="hoq-rp-row">
            <span><b>Hide when paused</b><em>Steps off Discord after 5 minutes paused.</em></span>
            <input type="checkbox" class="hoq-rp-sw" data-k="hoqRpPauseHide">
          </label>
        </div>
        <div class="hoq-dc-hint">Discord never shows you your own buttons — friends see them. Private (secret-link) tracks never get a link.</div>
      </div>
      <div class="hoq-dc-sec hoq-desk-sec">
        <div class="hoq-dc-label">Desktop</div>
        <div class="hoq-rp">
          <label class="hoq-rp-row">
            <span><b>Song pop-up <button type="button" class="hoq-toast-test">Preview</button></b><em>A small card with the cover and title in the corner of your screen when the song changes, while you're in another app or game.</em></span>
            <input type="checkbox" class="hoq-rp-sw hoq-desk-sw" data-k="hoqToast">
          </label>
          <label class="hoq-rp-row">
            <span><b>Full Go+ songs</b><em>When a song would only play SoundCloud's 30-second Go+ preview, the full song plays in a small player instead.</em></span>
            <input type="checkbox" class="hoq-rp-sw hoq-desk-sw" data-k="hoqGoYT" data-def="1">
          </label>
        </div>
      </div>
      <div class="hoq-dc-sec hoq-hook-sec">
        <div class="hoq-dc-label">Discord webhook</div>
        <div class="hoq-rp">
          <div class="hoq-rp-row hoq-rp-static">
            <span><b class="hoq-hook-state">Checking…</b><em>Where Share and Play in Discord post to.</em></span>
            <button class="hoq-hook-remove" type="button" hidden>Remove</button>
          </div>
          <div class="hoq-hook-edit">
            <input class="hoq-hook-input" type="password" autocomplete="off" spellcheck="false" placeholder="Paste a Discord webhook URL">
            <button class="hoq-hook-save" type="button">Save</button>
          </div>
        </div>
        <div class="hoq-dc-hint">Saved on this PC by the app, never in the page. In Discord: Server Settings → Integrations → Webhooks → Copy Webhook URL.</div>
      </div>
      <div class="hoq-dc-sec hoq-pair-sec">
        <div class="hoq-dc-label">Phone</div>
        <div class="hoq-rp">
          <div class="hoq-rp-row hoq-rp-static">
            <span><b>Log in on your phone</b><em>Scan a code and holdonquietly opens on your phone, already signed in.</em></span>
            <button class="hoq-pair-btn" type="button">Show code</button>
          </div>
          <div class="hoq-rp-row hoq-rp-static">
            <span><b>Phone not nearby?</b><em class="hoq-pair-linkstate">Copy a link to send yourself. It works once, within 10 minutes.</em></span>
            <button class="hoq-pair-linkbtn" type="button">Copy link</button>
          </div>
        </div>
      </div>
      <div class="hoq-dc-sec">
        <div class="hoq-dc-label">Accounts</div>
        <div class="hoq-acct-list"></div>
        <div class="hoq-acct-add">
          <input class="hoq-acct-name" placeholder="Save current session as… (e.g. main)">
          <button class="hoq-acct-save">Save</button>
        </div>
        <button class="hoq-acct-new">＋ Log into another account</button>
        <div class="hoq-dc-hint">Save the current session, then add another.</div>
      </div>
      <div class="hoq-dc-sec">
        <div class="hoq-dc-label">Your info</div>
        <input class="hoq-dc-sc" placeholder="SoundCloud profile link  (e.g. soundcloud.com/you)">
        <input class="hoq-dc-name" placeholder="Discord name" style="margin-top:8px">
      </div>
      <div class="hoq-dc-sec hoq-wide">
        <div class="hoq-dc-label">Settings</div>
        <div class="hoq-settings-host"></div>
      </div>
      <div class="hoq-dc-sec hoq-wide">
        <div class="hoq-dc-label hoq-stat-head">Listening stats<span class="hoq-stat-tools"><button type="button" class="hoq-recap-btn">Recap</button><span class="hoq-stat-range"><button type="button" data-r="all">All time</button><button type="button" data-r="30">30 days</button></span></span></div>
        <div class="hoq-stat-row">
          <div class="hoq-stat"><b class="hoq-stat-plays">0</b><span>Tracks played</span></div>
          <div class="hoq-stat"><b class="hoq-stat-time">0m</b><span>Time listened</span></div>
          <div class="hoq-stat"><b class="hoq-stat-uniq">0</b><span>Different tracks</span></div>
          <div class="hoq-stat"><b class="hoq-stat-since">&mdash;</b><span class="hoq-stat-since-l">Counting since</span></div>
        </div>
        <div class="hoq-stat-cols">
          <div><div class="hoq-dc-label">Top artists</div><ol class="hoq-top hoq-top-artists"></ol></div>
          <div><div class="hoq-dc-label">Top tracks</div><ol class="hoq-top hoq-top-tracks"></ol></div>
        </div>
        <div class="hoq-dc-hint">Counted by the app &mdash; SoundCloud has no history to read. An account is optional, not needed. If you log in to holdonquietly.com, your stats stay linked to it, so they come back even if they're ever lost here. <button class="hoq-stat-reset">Reset</button></div>
      </div>
      <div class="hoq-dc-sec hoq-wide">
        <div class="hoq-dc-label">Friends listening</div>
        <div class="hoq-dc-friends"></div>
      </div>
      <div class="hoq-dc-sec">
        <div class="hoq-dc-label">Server</div>
        <div class="hoq-dc-embed" style="display:none">
          <img class="hoq-dc-eicon" src="${HOQ_LOGO}">
          <div class="hoq-dc-etext">
            <div class="hoq-dc-ename">holdonquietly</div>
            <div class="hoq-dc-eonline"><span class="hoq-dc-dot"></span><span class="hoq-dc-count">—</span></div>
          </div>
        </div>
        <button class="hoq-dc-open">Open Discord server</button>
      </div>
      <div class="hoq-dc-sec hoq-wide hoq-pane-changes"><div class="hoq-chg-list"></div></div>
      </div>
    </div>`;
  // Configuration lives behind the Settings sub-tab; everything else is Social.
  const SET_SECS = ['settings', 'holdonquietly account', 'accounts', 'last.fm scrobbling', 'discord rich presence', 'discord webhook', 'phone', 'your info'];
  p.querySelectorAll('.hoq-dc-sec').forEach((sec) => {
    const lab = sec.querySelector('.hoq-dc-label');
    const t = lab ? lab.textContent.trim().toLowerCase() : '';
    if (SET_SECS.indexOf(t) !== -1) sec.classList.add('hoq-pane-set');
    else if (sec.classList.contains('hoq-feed-sec')) sec.classList.add('hoq-pane-feed');
  });
  // The palette is the point of the Settings pane, so lead with it.
  const setSecs = [...p.querySelectorAll('.hoq-dc-sec.hoq-pane-set')];
  const palSec = setSecs.find((sec) => sec.querySelector('.hoq-settings-host'));
  if (palSec && setSecs[0] && palSec !== setSecs[0]) {
    setSecs[0].parentNode.insertBefore(palSec, setSecs[0]);
  }
  // The sub-tab already reads "Settings"; the card's own label just repeats it.
  if (palSec) {
    const dup = palSec.querySelector('.hoq-dc-label');
    if (dup) dup.remove();
  }
  // Same for the Feed pane — the sub-tab already says "Feed".
  const feedSec = p.querySelector('.hoq-dc-sec.hoq-pane-feed');
  if (feedSec) { const dl = feedSec.querySelector('.hoq-dc-label'); if (dl) dl.remove(); }
  // Rich Presence needs the desktop host, directly or (phone) through the server;
  // in the plain userscript the section would be dead controls.
  const rpSec = p.querySelector('.hoq-rp-sec');
  if (rpSec) {
    if (!hoqRelaysPresence()) rpSec.remove();
    else {
      if (!hoqHasHost()) {
        const hint = rpSec.querySelector('.hoq-dc-hint');
        if (hint) hint.textContent = 'Shows through the holdonquietly app on your PC — it needs to be open with Discord running. When both play, the PC wins.';
      }
      setupRpSettings(rpSec);
    }
  }
  // Jam goes through the desktop host; the phone builds have none.
  const jamSec = p.querySelector('.hoq-jam-sec');
  if (jamSec) { if (!hoqHasHost()) jamSec.remove(); else hoqJamRender(p); }
  // Desktop-only switches (the host draws the pop-up), sent along with presence.
  const deskSec = p.querySelector('.hoq-desk-sec');
  if (deskSec) {
    if (!hoqHasHost()) deskSec.remove();
    else deskSec.querySelectorAll('.hoq-desk-sw').forEach((sw) => {
      // data-def="1": on until switched off
      try { const v = localStorage.getItem(sw.dataset.k); sw.checked = v === null ? sw.dataset.def === '1' : v === '1'; } catch (e) {}
      sw.addEventListener('change', () => {
        try { localStorage.setItem(sw.dataset.k, sw.checked ? '1' : '0'); } catch (e) {}
        if (sw.dataset.k === 'hoqGoYT' && !sw.checked && _yt) { _goSkip = _yt.path; hoqYtStop(); }
        _lastRpc = ''; try { rpcTick(); } catch (e) {}
      });
    });
    const tt = deskSec.querySelector('.hoq-toast-test');
    if (tt) tt.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const np = currentNowPlaying();
      scPost('toast:test:' + JSON.stringify({ title: np.title || 'Nothing playing yet', artist: np.artist || 'holdonquietly', cover: np.cover || '' }));
    });
  }
  const hookSec = p.querySelector('.hoq-hook-sec');
  if (hookSec) { if (hoqHasHost()) setupHookSettings(hookSec); else hookSec.remove(); }
  const hoqSec = p.querySelector('.hoq-hoq-sec');
  if (hoqSec) {
    if (hoqHasHost()) {
      setupHoqAccount(hoqSec);
      // Lead the Settings pane with it — under the (long) palette nobody found it.
      const firstSet = p.querySelector('.hoq-dc-sec.hoq-pane-set');
      if (firstSet && firstSet !== hoqSec) firstSet.parentNode.insertBefore(hoqSec, firstSet);
    } else hoqSec.remove();
  }
  const pairSec = p.querySelector('.hoq-pair-sec');
  if (pairSec) {
    if (hoqHasHost()) setupPairSettings(pairSec);
    else if (window.__hoqProxyBuild && hoqProxyLogin().o) setupAppLinkSettings(pairSec);
    else pairSec.remove();
  }
  p.dataset.pane = 'social';
  // Changes: the list, and a dot on its tab until you've opened it since the
  // newest entry went in (hoqChangesSeen; html.hoq-chg-new also dots the way in).
  const chgList = p.querySelector('.hoq-chg-list');
  if (chgList) chgList.innerHTML = hoqChangesHtml();
  const chgDot = p.querySelector('.hoq-chg-dot');
  if (chgDot) chgDot.hidden = !document.documentElement.classList.contains('hoq-chg-new');
  p.querySelectorAll('.hoq-subtab').forEach((b) => {
    b.addEventListener('click', () => {
      p.dataset.pane = b.dataset.pane;
      p.querySelectorAll('.hoq-subtab').forEach((o) => o.classList.toggle('hoq-on', o === b));
      p.scrollTop = 0;
      if (b.dataset.pane === 'changes') hoqChangesSeen();
    });
  });
  document.body.appendChild(p);
  setupFeed(p);

  // Quick actions just drive the controls that already exist, so there's one
  // implementation of each behaviour rather than two.
  p.querySelectorAll('.hoq-dc-quick button').forEach((b) => {
    b.addEventListener('click', () => {
      const act = b.dataset.act;
      const flash = (txt) => {
        const was = b.textContent;
        b.textContent = txt; b.classList.add('done');
        setTimeout(() => { b.textContent = was; b.classList.remove('done'); }, 1400);
      };
      if (act === 'share') { const el = document.getElementById('hoq-share'); if (el) el.click(); flash('Shared'); }
      else if (act === 'play') { const el = document.getElementById('hoq-playbtn'); if (el) el.click(); flash('Queued'); }
      else if (act === 'server') { const el = p.querySelector('.hoq-dc-open'); if (el) el.click(); }
      else if (act === 'copy') {
        const href = hoqNowHref();
        if (href) { hoqCopy(href.startsWith('http') ? href : location.origin + href); flash('Copied'); }
        else flash('Nothing playing');
      }
    });
  });
  const recapBtn = p.querySelector('.hoq-recap-btn');
  if (recapBtn) { if (hoqHasHost()) recapBtn.addEventListener('click', () => hoqRecapOpen()); else recapBtn.remove(); }
  p.querySelectorAll('.hoq-stat-range button').forEach((b) => b.addEventListener('click', () => {
    try { localStorage.setItem('hoqStatsRange', b.dataset.r); } catch (e) {}
    renderHoqStats();
  }));
  const reset = p.querySelector('.hoq-stat-reset');
  if (reset) reset.addEventListener('click', () => {
    // Resets THIS PC's count (same device id, so the account copy is zeroed too
    // on the next sync); other PCs and restored stats on the account stay.
    try { localStorage.setItem('hoqStats', JSON.stringify({ device: hoqStatsRead().device })); } catch (e) {}
    _statsTitle = ''; _statsLastTick = 0;
    renderHoqStats();
    hoqCloudPush(true);
  });
  const name = p.querySelector('.hoq-dc-name');
  const sc = p.querySelector('.hoq-dc-sc');
  name.value = localStorage.getItem('hoqDiscord') || '';
  sc.value = localStorage.getItem('hoqSC') || '';
  name.addEventListener('change', () => localStorage.setItem('hoqDiscord', name.value.trim()));
  sc.addEventListener('change', () => localStorage.setItem('hoqSC', sc.value.trim()));
  p.querySelector('.hoq-dc-friends').innerHTML =
    '<div class="hoq-dc-hint">Checking who\'s listening…</div>';
  p.querySelector('.hoq-dc-open').addEventListener('click', () => scPost('open:https://discord.com/channels/' + HOQ_SERVER));

  // Last.fm connect/disconnect (auth + scrobbling handled in the C# host).
  const lfBtn = p.querySelector('.hoq-lf-btn');
  lfBtn.addEventListener('click', () => {
    if (lfBtn.dataset.connected === '1') { scPost('lastfm:disconnect'); }
    else {
      lfBtn.textContent = 'Waiting…'; lfBtn.disabled = true;
      p.querySelector('.hoq-lf-sub').textContent = 'Approve holdonquietly in the Last.fm tab that just opened…';
      scPost('lastfm:connect');
    }
  });
  scPost('lastfm:status'); // ask the host for the current connection state

  // Accounts: save current session / switch / add another.
  const acctName = p.querySelector('.hoq-acct-name');
  p.querySelector('.hoq-acct-save').addEventListener('click', () => {
    const n = (acctName.value || '').trim();
    if (n) { scPost('acct:save:' + n); acctName.value = ''; }
  });
  p.querySelector('.hoq-acct-new').addEventListener('click', () => scPost('acct:new'));
  scPost('acct:list');

  return p;
}

// The host reports the saved account names here.
window.__hoqAccounts = function (names) {
  const el = document.querySelector('.hoq-acct-list');
  if (!el) return;
  const arr = Array.isArray(names) ? names : [];
  if (!arr.length) { el.innerHTML = '<div class="hoq-dc-hint">No saved accounts yet — save your current one below.</div>'; return; }
  el.innerHTML = arr.map((n) =>
    '<div class="hoq-acct-row"><b>' + hoqEsc(n) + '</b>' +
    '<button class="hoq-acct-sw" data-n="' + hoqEsc(n) + '">Switch</button>' +
    '<button class="hoq-acct-rm" data-n="' + hoqEsc(n) + '" title="Remove">&#10005;</button></div>').join('');
  el.querySelectorAll('.hoq-acct-sw').forEach((b) => b.addEventListener('click', () => scPost('acct:switch:' + b.dataset.n)));
  el.querySelectorAll('.hoq-acct-rm').forEach((b) => b.addEventListener('click', () => scPost('acct:remove:' + b.dataset.n)));
};

// The C# host reports Last.fm connection status here.
window.__hoqLastfm = function (connected, user) {
  const p = document.getElementById('hoq-discord');
  if (!p) return;
  const btn = p.querySelector('.hoq-lf-btn');
  const state = p.querySelector('.hoq-lf-state');
  const sub = p.querySelector('.hoq-lf-sub');
  if (!btn) return;
  btn.disabled = false;
  if (connected) {
    btn.dataset.connected = '1';
    btn.textContent = 'Disconnect';
    btn.classList.add('is-off');
    state.textContent = 'Connected' + (user ? ' as ' + user : '');
    sub.textContent = 'Everything you play is scrobbled to your Last.fm.';
  } else {
    btn.dataset.connected = '0';
    btn.textContent = 'Connect';
    btn.classList.remove('is-off');
    state.textContent = 'Not connected';
    sub.textContent = 'Scrobble everything you play to your Last.fm.';
  }
};

// Auto-updater toasts. The C# host calls this with 'ready' (a new version has been
// downloaded in the background — offer to restart & finish) or 'done' (this launch
// is already running a freshly-applied update). Self-contained: builds its own
// styled toast, our own element so it's safe to mutate.
window.__hoqUpdate = function (state, ver) {
  try {
    if (!document.getElementById('hoq-upd-style')) {
      const st = document.createElement('style');
      st.id = 'hoq-upd-style';
      st.textContent =
        '#hoq-upd{position:fixed;right:18px;bottom:96px;z-index:2147483600;max-width:320px;' +
        'display:flex;gap:12px;align-items:center;padding:13px 15px;border-radius:14px;' +
        'background:rgba(20,20,24,0.72);backdrop-filter:blur(22px) saturate(160%);' +
        '-webkit-backdrop-filter:blur(22px) saturate(160%);border:1px solid rgba(255,255,255,0.12);' +
        'box-shadow:0 12px 40px rgba(0,0,0,0.5);color:#fff;font:500 13px/1.35 system-ui,sans-serif;' +
        'transform:translateY(14px);opacity:0;transition:transform .35s cubic-bezier(.2,.9,.3,1),opacity .35s}' +
        '#hoq-upd.show{transform:translateY(0);opacity:1}' +
        '#hoq-upd .ic{width:30px;height:30px;flex:0 0 auto;border-radius:9px;display:grid;place-items:center;' +
        'background:var(--sc-accent,#ff5500);color:#fff;font-size:16px}' +
        '#hoq-upd .tx{flex:1 1 auto;min-width:0}' +
        '#hoq-upd .tx b{display:block;font-weight:700;font-size:13px}' +
        '#hoq-upd .tx span{display:block;opacity:.7;font-size:11.5px;margin-top:1px}' +
        '#hoq-upd button{flex:0 0 auto;border:0;cursor:pointer;padding:7px 12px;border-radius:9px;' +
        'background:var(--sc-accent,#ff5500);color:#fff;font:700 12px system-ui;white-space:nowrap}' +
        '#hoq-upd .x{background:transparent;color:rgba(255,255,255,.5);padding:4px 6px;font-size:16px}';
      document.head.appendChild(st);
    }
    let el = document.getElementById('hoq-upd');
    if (el) el.remove();
    el = document.createElement('div');
    el.id = 'hoq-upd';
    const v = ver ? ('v' + String(ver).replace(/^v/i, '')) : '';
    if (state === 'ready') {
      el.innerHTML = '<div class="ic">↓</div><div class="tx"><b>Update ' + v + ' ready</b>' +
        '<span>Restart to finish installing.</span></div>' +
        '<button class="go">Restart</button><button class="x">×</button>';
      el.querySelector('.go').onclick = () => scPost('update:apply');
      const ub = document.getElementById('hoq-upd-btn');
      if (ub) { ub.classList.remove('is-busy'); ub.classList.add('has-upd'); ub.title = 'Update ' + v + ' ready: restart to install'; }
    } else if (state === 'downloading') {   // the header button found one
      el.innerHTML = '<div class="ic">↓</div><div class="tx"><b>Downloading ' + v + '…</b>' +
        '<span>It’ll ask to restart when it’s ready.</span></div><button class="x">×</button>';
    } else if (state === 'latest') {
      el.innerHTML = '<div class="ic">✓</div><div class="tx"><b>You’re up to date</b>' +
        '<span>' + v + ' is the latest version.</span></div><button class="x">×</button>';
      setTimeout(() => { try { el.classList.remove('show'); setTimeout(() => el.remove(), 400); } catch (e) {} }, 5000);
    } else if (state === 'notice') {   // (state, title, detail): a short heads-up
      el.innerHTML = '<div class="ic">!</div><div class="tx"><b>' + hoqEsc(ver) + '</b>' +
        '<span>' + hoqEsc(arguments[2] || '') + '</span></div><button class="x">×</button>';
      setTimeout(() => { try { el.classList.remove('show'); setTimeout(() => el.remove(), 400); } catch (e) {} }, 9000);
    } else { // 'done'
      el.innerHTML = '<div class="ic">✓</div><div class="tx"><b>Updated to ' + v + '</b>' +
        '<span>You’re on the latest version.</span></div><button class="x">×</button>';
      setTimeout(() => { try { el.classList.remove('show'); setTimeout(() => el.remove(), 400); } catch (e) {} }, 6000);
    }
    el.querySelector('.x').onclick = () => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); };
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
  } catch (e) {}
};

// What the header's "Check for updates" found (Updater.cs CheckAsync).
window.__hoqUpdCheck = function (state, ver) {
  try {
    const btn = document.getElementById('hoq-upd-btn');
    if (btn) btn.classList.toggle('is-busy', state === 'checking' || state === 'downloading');
    if (state === 'checking') return;
    if (state === 'downloading' || state === 'ready' || state === 'latest') window.__hoqUpdate(state, ver);
    else if (state === 'dev') window.__hoqUpdate('notice', 'This copy doesn’t update itself', 'It’s a test build. The released app gets its updates from GitHub.');
    else window.__hoqUpdate('notice', 'Couldn’t check for updates', 'Check your connection and try again.');
  } catch (e) {}
};

// Header button: check for an update now (it also checks by itself on launch).
// Desktop app only: the phone site is always the latest copy anyway.
function setupUpdateBtn() {
  if (document.documentElement.classList.contains('hoq-mobile') || !hoqHasHost()) return;
  if (document.getElementById('hoq-upd-btn')) return;
  if (!document.querySelector('.header__userNav') && !document.querySelector('.header__right')) return;
  hoqHdrIconCss();
  const btn = document.createElement('button');
  btn.id = 'hoq-upd-btn'; btn.type = 'button'; btn.className = 'hoq-hdr-icon';
  btn.title = 'Check for updates'; btn.setAttribute('aria-label', 'Check for updates');
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M20.5 3.5v5h-5"/></svg>';
  const mini = document.getElementById('hoq-mini-btn');
  if (mini && mini.parentElement) mini.insertAdjacentElement('afterend', btn);
  else if (!hoqPlaceHdrIcon(btn)) return;
  btn.addEventListener('click', () => {
    if (btn.classList.contains('is-busy')) return;
    btn.classList.add('is-busy');
    scPost('update:check');
    setTimeout(() => btn.classList.remove('is-busy'), 120000);   // a download that never reports back
  });
}

// The C# host delivers the Discord server widget (name + online count) here.
window.__hoqDcWidget = function (data) {
  const p = document.getElementById('hoq-discord');
  if (!p) return;
  const embed = p.querySelector('.hoq-dc-embed');
  if (!embed) return;
  if (!data || !data.name) { embed.style.display = 'none'; return; }
  embed.style.display = 'flex';
  p.querySelector('.hoq-dc-ename').textContent = data.name;
  const n = (data.presence_count != null) ? data.presence_count : (data.members ? data.members.length : 0);
  p.querySelector('.hoq-dc-count').textContent = n + ' online';
};

// Local listening stats. SoundCloud exposes no history API, so the tab keeps its
// own tally: the track-change detection we already run for Rich Presence doubles
// as the counter. Stored in localStorage, so it survives restarts.
function hoqStatsRead() {
  try {
    const s = JSON.parse(localStorage.getItem('hoqStats')) || {};
    s.plays = s.plays || 0; s.seconds = s.seconds || 0;
    s.artists = s.artists || {}; s.tracks = s.tracks || {};
    if (!s.since) s.since = Date.now();
    // Which PC this tally is. Lives INSIDE hoqStats on purpose: if the local
    // copy is ever wiped, a fresh id starts and the old tally on the account is
    // never overwritten by a smaller one.
    if (!s.device) s.device = 'd' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    return s;
  } catch (e) { return { plays: 0, seconds: 0, artists: {}, tracks: {}, since: Date.now(), device: 'd' + Date.now().toString(36) }; }
}
function hoqStatsWrite(s) { try { localStorage.setItem('hoqStats', JSON.stringify(s)); } catch (e) {} }

// ---- stats on the holdonquietly account ----
// Each PC uploads its own tally as "sc-stats:<device>". The app shows this PC's
// tally plus every other one on the account (cached, so it still shows after
// signing out). Listening while signed out is in this PC's tally, so it lands
// on the account at the next sign-in. Nothing is ever counted twice.
function hoqStatsAdd(a, b) {
  const out = { plays: (a.plays || 0) + (b.plays || 0), seconds: (a.seconds || 0) + (b.seconds || 0),
    artists: Object.assign({}, a.artists), tracks: Object.assign({}, a.tracks),
    since: Math.min(a.since || Infinity, b.since || Infinity) };
  // Same name in different capitals is one entry (Last.fm says "Serpuline",
  // SoundCloud "serpuline"); the first spelling seen is the one shown.
  const addInto = (dst, src) => {
    const low = {};
    for (const k in dst) low[k.toLowerCase()] = k;
    for (const k in (src || {})) {
      const key = low[k.toLowerCase()] || (low[k.toLowerCase()] = k);
      dst[key] = (dst[key] || 0) + (+src[k] || 0);
    }
  };
  addInto(out.artists, b.artists);
  addInto(out.tracks, b.tracks);
  // per-day counts, merged day by day (for the 30-day view)
  out.days = {};
  for (const src of [a.days, b.days]) {
    for (const k in (src || {})) {
      const d = src[k] || {};
      const o = out.days[k] || (out.days[k] = { plays: 0, seconds: 0, artists: {}, tracks: {} });
      o.plays += +d.plays || 0; o.seconds += +d.seconds || 0;
      addInto(o.artists, d.artists); addInto(o.tracks, d.tracks);
    }
  }
  if (!isFinite(out.since)) out.since = Date.now();
  return out;
}
// "2026-11-17" in local time
function hoqDayKey(t) { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
// Just the last n days (today included), built from the per-day counts.
function hoqStatsWindow(s, n) {
  const from = hoqDayKey(Date.now() - (n - 1) * 86400000);
  let w = { plays: 0, seconds: 0, artists: {}, tracks: {} };
  for (const k in (s.days || {})) if (k >= from) w = hoqStatsAdd(w, s.days[k]);
  const p = from.split('-');
  w.since = new Date(+p[0], +p[1] - 1, +p[2]).getTime();
  return w;
}
function hoqStatsCloud() { try { return JSON.parse(localStorage.getItem('hoqStatsCloud')) || null; } catch (e) { return null; } }
function hoqStatsShown() {
  const s = hoqStatsRead(), c = hoqStatsCloud(), u = window.__hoqAccountUser;
  return c && c.others && (!u || c.uid === u.id) ? hoqStatsAdd(s, c.others) : s;
}
// Keeps one PC's upload well under the account's 256 KB per key.
function hoqStatsTrim(s) {
  const top = (o, n) => Object.fromEntries(Object.entries(o || {}).sort((x, y) => y[1] - x[1]).slice(0, n).map(([k, v]) => [String(k).slice(0, 200), v]));
  // Shrink until it fits (the account takes 256 KB per entry); counts never change,
  // only how many of the least-played names come along.
  for (const f of [1, 0.6, 0.35, 0.2, 0.1]) {
    const days = {};
    for (const k in (s.days || {})) {
      const d = s.days[k];
      days[k] = { plays: d.plays || 0, seconds: d.seconds || 0, artists: top(d.artists, Math.ceil(60 * f)), tracks: top(d.tracks, Math.ceil(80 * f)) };
    }
    const out = { plays: s.plays, seconds: s.seconds, since: s.since, device: s.device, artists: top(s.artists, Math.ceil(1000 * f)), tracks: top(s.tracks, Math.ceil(1600 * f)), days };
    if (JSON.stringify(out).length < 230000) return out;
  }
  return { plays: s.plays, seconds: s.seconds, since: s.since, device: s.device, artists: top(s.artists, 50), tracks: top(s.tracks, 50), days: {} };
}
function hoqStatsCard(s) {
  const best = (o) => { let b = null; for (const k in o) if (b === null || o[k] > o[b]) b = k; return b; };
  const rows = [
    { label: 'plays', value: s.plays.toLocaleString() },
    { label: 'time listened', value: hoqFmtDur(s.seconds) },
    { label: 'different tracks', value: Object.keys(s.tracks).length.toLocaleString() },
  ];
  const ta = best(s.artists), tt = best(s.tracks);
  if (ta) rows.push({ label: 'top artist', value: ta });
  if (tt) rows.push({ label: 'top track', value: tt });
  rows.push({ label: 'counting since', value: new Date(s.since).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) });
  return rows;
}
let _cloudSig = '', _cardState = '';
function hoqCloudPush(force) {
  const u = window.__hoqAccountUser;
  if (!u || !u.id || !hoqHasHost()) return;
  const s = hoqStatsRead();
  hoqStatsWrite(s);   // pins the device id before it goes up
  const pub = localStorage.getItem('hoqStatsPublic') === '1';
  const sig = u.id + '|' + s.device + '|' + s.plays + '|' + s.seconds + '|' + pub;
  if (!force && sig === _cloudSig) return;
  _cloudSig = sig;
  const msg = { key: 'sc-stats:' + s.device, data: hoqStatsTrim(s) };
  if (pub) msg.card = hoqStatsCard(hoqStatsShown());
  else if (_cardState !== 'off') msg.card = [];
  _cardState = pub ? 'on' : 'off';
  scPost('hoqacct:stats:' + JSON.stringify(msg));
}
// The host answers 'hoqacct:pull' with everything this app keeps on the account.
window.__hoqCloudStats = function (resp) {
  const u = window.__hoqAccountUser;
  if (!u || !resp || !Array.isArray(resp.items)) return;
  const mine = 'sc-stats:' + hoqStatsRead().device;
  let others = null;
  for (const it of resp.items) {
    if (!it || typeof it.key !== 'string' || it.key.indexOf('sc-stats:') !== 0 || it.key === mine) continue;
    if (!it.data || typeof it.data !== 'object') continue;
    others = hoqStatsAdd(others || {}, it.data);
  }
  try { localStorage.setItem('hoqStatsCloud', JSON.stringify({ uid: u.id, others })); } catch (e) {}
  renderHoqStats();
  hoqCloudPush(true);   // this PC's tally (incl. anything played while signed out) goes up now
  hoqSettingsFromCloud(resp.items.find((it) => it && it.key === 'settings'));
};
setInterval(() => { try { hoqCloudPush(false); } catch (e) {} }, 120000);

// ---- settings follow the account ----
// The look and the switches (accent incl. "match song cover", background, effects,
// EQ, stats switches) live on the account as one "settings" entry; the newest one
// wins. A PC that's behind applies it and reloads once. Per-device things stay
// local: volume, the output device, and custom background pictures over 150 KB.
const HOQ_SYNC_KEYS = ['scAccent', 'scMatchCover', 'scCoverBg', 'scCustomBg', 'scZoom', 'hoqEQ', 'hoqEQOn',
  'hoqStatsRange', 'hoqStatsPublic', 'hoqNowPublic', 'hoqBoost', 'hoqLevel', 'hoqSpace', 'hoqSpaceAmt',
  'hoqMiniLayout', 'hoqMiniPin', 'hoqMiniFade', 'hoqSpeed', 'hoqXfade', 'hoqToast', 'hoqGoYT'];
function hoqSettingsSnap() {
  const o = {};
  for (const k of HOQ_SYNC_KEYS) {
    const v = localStorage.getItem(k);
    if (v !== null && !(k === 'scCustomBg' && v.length > 150000)) o[k] = v;
  }
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/^scFx_[a-z]+$/.test(k)) o[k] = localStorage.getItem(k); }
  return o;
}
const hoqSig = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
function hoqSyncState() { try { return JSON.parse(localStorage.getItem('hoqSettingsSync')) || {}; } catch (e) { return {}; } }
let _settingsReady = false;   // wait for the account's copy before sending ours
// Run `fn` once nothing is playing: straight away if nothing has played yet this
// session (the usual case, right after launch), else after half a minute paused.
// A newer job replaces one that is still waiting.
let _idleJob = null, _idleIv = 0;
function hoqWhenIdle(fn) {
  _idleJob = fn;
  if (_idleIv) return;
  let since = 0;
  const tick = () => {
    if (!playerProgress().paused) { since = 0; return; }
    if (!since) since = Date.now();
    if (window.__hoqEverPlayed && Date.now() - since < 30000) return;
    clearInterval(_idleIv); _idleIv = 0;
    const job = _idleJob; _idleJob = null;
    try { if (job) job(); } catch (e) {}
  };
  _idleIv = setInterval(tick, 1000);
  tick();
}
function hoqSettingsFromCloud(item) {
  const st = hoqSyncState(), snap = hoqSettingsSnap(), sig = hoqSig(snap);
  const remote = item && item.data && typeof item.data === 'object' && item.data.values && typeof item.data.values === 'object' ? item.data : null;
  _settingsReady = true;
  if (remote && (remote.ts || 0) > (st.ts || 0) && hoqSig(remote.values) !== sig) {
    // The account has newer settings than this PC: take them. That means a
    // reload, and this also runs on background pulls (the phone's stats
    // arriving), so it waits until nothing is playing instead of cutting a song.
    hoqWhenIdle(() => {
      if ((remote.ts || 0) <= (hoqSyncState().ts || 0)) return;   // changed here meanwhile: this PC is newer now
      const now = hoqSettingsSnap();
      for (const k of Object.keys(now)) if (!(k in remote.values) && !(k === 'scCustomBg' && now[k].length > 150000)) localStorage.removeItem(k);
      for (const [k, v] of Object.entries(remote.values)) if ((HOQ_SYNC_KEYS.includes(k) || /^scFx_[a-z]+$/.test(k)) && typeof v === 'string') localStorage.setItem(k, v);
      localStorage.setItem('hoqSettingsSync', JSON.stringify({ ts: remote.ts, sig: hoqSig(hoqSettingsSnap()) }));
      setTimeout(() => location.reload(), 300);
    });
    return;
  }
  if (remote && hoqSig(remote.values) === sig) { localStorage.setItem('hoqSettingsSync', JSON.stringify({ ts: remote.ts || 0, sig })); return; }
  hoqSettingsPush(true);
}
function hoqSettingsPush(force) {
  if (!window.__hoqAccountUser || !hoqHasHost() || !_settingsReady) return;
  const snap = hoqSettingsSnap(), sig = hoqSig(snap), st = hoqSyncState();
  if (!force && sig === st.sig) return;
  const ts = Date.now();
  localStorage.setItem('hoqSettingsSync', JSON.stringify({ ts, sig }));
  scPost('hoqacct:stats:' + JSON.stringify({ key: 'settings', data: { ts, values: snap } }));
}
setInterval(() => { try { hoqSettingsPush(false); } catch (e) {} }, 20000);

let _statsTitle = '', _statsLastTick = 0, _statsLastPos = 0;
function hoqStatsTick() {
  const np = currentNowPlaying();
  const pr = playerProgress();
  const s = hoqStatsRead();
  const now = Date.now();
  let addSec = 0;
  if (!pr.paused && np.title) {
    // Cap the delta so a backgrounded app or a long pause can't bank hours.
    if (_statsLastTick) addSec = Math.min(15, Math.round((now - _statsLastTick) / 1000));
    s.seconds += addSec;
    _statsLastTick = now;
  } else {
    _statsLastTick = 0;
  }
  // The last counted title is kept with the stats, so a restart or reload with the
  // same song still loaded isn't counted as another play.
  if (!_statsTitle && s.last) _statsTitle = s.last;
  // Per-day counts too (local date), for the "30 days" view and the monthly recap. Only the last 70
  // days are kept; the all-time totals above are separate and never trimmed.
  const dk = hoqDayKey(now);
  if (!s.days) {
    // Stats from before per-day counting: if they all started today, they all
    // belong to today; anything older can't be placed and stays all-time only.
    s.days = {};
    if (s.since && hoqDayKey(s.since) === dk && s.plays) {
      s.days[dk] = { plays: s.plays, seconds: s.seconds, artists: Object.assign({}, s.artists), tracks: Object.assign({}, s.tracks) };
    }
  }
  const day = s.days[dk] || (s.days[dk] = { plays: 0, seconds: 0, artists: {}, tracks: {} });
  day.seconds += addSec;
  // The same track again (repeat-one, or played once more) jumps back to the
  // start after a real listen: that's another play, not the same one.
  const replay = !!np.title && np.title === _statsTitle && _statsLastPos > 30 && pr.pos < 10 && pr.pos + 20 < _statsLastPos;
  _statsLastPos = np.title ? pr.pos : 0;
  if (np.title && (np.title !== _statsTitle || replay)) {
    _statsTitle = np.title;
    s.last = np.title;
    s.plays++;
    s.tracks[np.title] = (s.tracks[np.title] || 0) + 1;
    if (np.artist) s.artists[np.artist] = (s.artists[np.artist] || 0) + 1;
    // first / last time each artist was played (for the "You & <artist>" card)
    if (np.artist) {
      const ak = np.artist.toLowerCase(), af = s.af || (s.af = {});
      // 0 = played before this was tracked, so the first date is unknown
      af[ak] = [af[ak] ? af[ak][0] : (s.artists[np.artist] > 1 ? 0 : now), now];
    }
    day.plays++;
    day.tracks[np.title] = (day.tracks[np.title] || 0) + 1;
    if (np.artist) day.artists[np.artist] = (day.artists[np.artist] || 0) + 1;
  }
  const cutoff = hoqDayKey(now - 70 * 86400000);
  for (const k in s.days) if (k < cutoff) delete s.days[k];
  hoqStatsWrite(s);
}

// ---- monthly recap: a "your month" card from the per-day counts ----
function hoqMonthStats(ym) {
  const all = hoqStatsShown();
  let w = { plays: 0, seconds: 0, artists: {}, tracks: {} }, days = 0, topDay = '', topDayN = 0;
  for (const k in (all.days || {})) {
    if (k.slice(0, 7) !== ym) continue;
    const d = all.days[k];
    w = hoqStatsAdd(w, d);
    if (d.plays) days++;
    if ((d.plays || 0) > topDayN) { topDayN = d.plays; topDay = k; }
  }
  return Object.assign(w, { days, topDay, topDayN });
}
function hoqRecapDraw(ym) {
  const m = hoqMonthStats(ym);
  const [y, mo] = ym.split('-').map(Number);
  const monthName = new Date(y, mo - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const acc = getComputedStyle(document.documentElement).getPropertyValue('--sc-accent').trim() || '#ff5500';
  const u = window.__hoqAccountUser;
  const who = (u && (u.name || u.username)) || (hoqMe().name !== 'Someone' ? hoqMe().name : '');
  const W = 1200, H = 675, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const font = (px, w) => (w || 800) + ' ' + px + 'px Inter, "Segoe UI", Arial, sans-serif';
  const fit = (t, max) => { t = String(t); if (g.measureText(t).width <= max) return t; while (t.length > 1 && g.measureText(t + '…').width > max) t = t.slice(0, -1); return t + '…'; };
  // background: the accent fading into near-black, with a soft glow
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, acc); bg.addColorStop(0.55, '#141418'); bg.addColorStop(1, '#0a0a0c');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, 0, W, H);
  // header
  g.fillStyle = '#fff'; g.font = font(22, 700); g.globalAlpha = 0.8;
  g.fillText('holdonquietly · listening recap', 60, 70); g.globalAlpha = 1;
  g.font = font(58); g.fillText(fit((who ? who + '’s ' : 'My ') + monthName, W - 120), 60, 140);
  // big numbers
  const nums = [[m.plays.toLocaleString(), 'plays'], [hoqFmtDur(m.seconds), 'listened'], [String(m.days), m.days === 1 ? 'day listening' : 'days listening'],
    [m.topDay ? new Date(m.topDay + 'T12:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—', 'biggest day' + (m.topDayN ? ' (' + m.topDayN + ')' : '')]];
  nums.forEach(([v, l], i) => {
    const x = 60 + i * 275;
    g.fillStyle = 'rgba(255,255,255,0.07)'; g.beginPath(); g.roundRect(x, 180, 255, 110, 16); g.fill();
    g.fillStyle = acc; g.font = font(40); g.fillText(fit(v, 225), x + 20, 238);
    g.fillStyle = 'rgba(255,255,255,0.75)'; g.font = font(18, 600); g.fillText(fit(l, 225), x + 20, 270);
  });
  // top 5 lists
  const top = (o) => Object.entries(o || {}).sort((a, b) => b[1] - a[1]).slice(0, 5);
  [['Top artists', top(m.artists), 60], ['Top songs', top(m.tracks), 620]].forEach(([title, rows, x]) => {
    g.fillStyle = '#fff'; g.font = font(24); g.fillText(title, x, 345);
    if (!rows.length) { g.font = font(18, 600); g.fillStyle = 'rgba(255,255,255,0.6)'; g.fillText('nothing played yet', x, 385); }
    rows.forEach(([name, n], i) => {
      const yy = 385 + i * 46;
      g.fillStyle = acc; g.font = font(22); g.fillText(String(i + 1), x, yy);
      g.fillStyle = '#fff'; g.font = font(21, 700); g.fillText(fit(name, 400), x + 34, yy);
      g.fillStyle = 'rgba(255,255,255,0.6)'; g.font = font(17, 600); const t = n + (n === 1 ? ' play' : ' plays');
      g.fillText(t, x + 520 - g.measureText(t).width, yy);
    });
  });
  g.fillStyle = 'rgba(255,255,255,0.45)'; g.font = font(16, 600); g.fillText('holdonquietly SoundCloud', 60, H - 30);
  return { png: c.toDataURL('image/png'), monthName, plays: m.plays };
}
function hoqRecapOpen() {
  let ov = document.getElementById('hoq-recap');
  if (ov) ov.remove();
  ov = document.createElement('div');
  ov.id = 'hoq-recap';
  ov.innerHTML = '<style>#hoq-recap{position:fixed;inset:0;z-index:2147483100;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);' +
    'font-family:Inter,"Segoe UI",Arial,sans-serif}#hoq-recap .rc{width:min(860px,92vw);background:rgba(18,18,22,.96);border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:18px;' +
    'box-shadow:0 30px 80px rgba(0,0,0,.6);color:#eee}#hoq-recap img{width:100%;border-radius:12px;display:block}#hoq-recap .row{display:flex;gap:8px;align-items:center;margin-top:14px;flex-wrap:wrap}' +
    '#hoq-recap button{border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#eee;border-radius:10px;padding:9px 15px;font-weight:700;font-size:13px;cursor:pointer}' +
    '#hoq-recap button:hover{background:rgba(255,255,255,.12)}#hoq-recap button.on,#hoq-recap .go{background:var(--sc-accent,#ff5500);border-color:transparent;color:#fff}' +
    '#hoq-recap .st{margin-left:auto;font-size:12.5px;color:#bbb}#hoq-recap .sp{flex:1}</style>' +
    '<div class="rc"><img alt="Your listening recap"><div class="row"><button data-m="0">This month</button><button data-m="1">Last month</button><span class="sp"></span>' +
    '<button class="go" data-a="share">Share to Discord</button><button data-a="save">Save image</button><button data-a="close">Close</button></div><div class="row"><span class="st"></span></div></div>';
  document.body.appendChild(ov);
  const img = ov.querySelector('img'), st = ov.querySelector('.st');
  let cur = null;
  const show = (back) => {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - back);
    const ym = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    cur = Object.assign(hoqRecapDraw(ym), { ym });
    img.src = cur.png;
    ov.querySelectorAll('[data-m]').forEach((b) => b.classList.toggle('on', b.dataset.m === String(back)));
    st.textContent = cur.plays ? '' : 'No plays counted for ' + cur.monthName + ' yet.';
  };
  window.__hoqRecapResult = (ok, text) => { st.textContent = text; };
  ov.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (e.target === ov) { ov.remove(); return; }
    if (!b) return;
    if (b.dataset.m) show(Number(b.dataset.m));
    else if (b.dataset.a === 'close') ov.remove();
    else if (cur && (b.dataset.a === 'share' || b.dataset.a === 'save')) {
      st.textContent = b.dataset.a === 'share' ? 'Sharing…' : 'Saving…';
      scPost('recap:' + b.dataset.a + ':' + JSON.stringify({ png: cur.png, month: cur.ym, caption: 'my ' + cur.monthName + ' on holdonquietly' }));
    }
  });
  const esc = (e) => { if (e.key === 'Escape') { ov.remove(); document.removeEventListener('keydown', esc, true); } };
  document.addEventListener('keydown', esc, true);
  show(0);
}

function hoqFmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? h + 'h ' + m + 'm' : (m || Math.round(sec / 60)) + 'm';
}

function renderHoqStats() {
  const p = document.getElementById('hoq-discord');
  if (!p || !p.classList.contains('open')) return;
  // "All time" or "30 days" (the switch in the Listening stats header)
  const range = localStorage.getItem('hoqStatsRange') === '30' ? '30' : 'all';
  p.querySelectorAll('.hoq-stat-range button').forEach((b) => b.classList.toggle('hoq-on', b.dataset.r === range));
  const all = hoqStatsShown();
  const s = range === '30' ? hoqStatsWindow(all, 30) : all;
  const set = (sel, v) => { const el = p.querySelector(sel); if (el) el.textContent = v; };
  set('.hoq-stat-since-l', range === '30' ? 'Since' : 'Counting since');
  set('.hoq-stat-plays', s.plays.toLocaleString());
  set('.hoq-stat-time', hoqFmtDur(s.seconds));
  set('.hoq-stat-uniq', Object.keys(s.tracks).length.toLocaleString());
  set('.hoq-stat-since', new Date(s.since).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
  const top = (obj, n) => Object.keys(obj).map((k) => [k, obj[k]])
    .sort((a, b) => b[1] - a[1]).slice(0, n);
  const fill = (sel, rows, unit) => {
    const el = p.querySelector(sel);
    if (!el) return;
    el.innerHTML = rows.length
      ? rows.map((r) => '<li><b>' + hoqEsc(r[0]) + '</b><em>' + r[1] + ' ' + unit + (r[1] === 1 ? '' : 's') + '</em></li>').join('')
      : '<li><b style="color:#7a7a7c">Nothing yet — play something.</b></li>';
  };
  fill('.hoq-top-artists', top(s.artists, 5), 'play');
  fill('.hoq-top-tracks', top(s.tracks, 5), 'play');
}

function updateDiscordActivity() {
  const p = document.getElementById('hoq-discord');
  if (!p || !p.classList.contains('open')) return;
  const np = currentNowPlaying();
  // The card's header reads exactly what Discord's member list shows.
  if (hoqRelaysPresence()) {
    const line = rpStatusLine();
    const head = p.querySelector('.hoq-dc-ptext b');
    if (head) head.textContent = line;
    const prev = p.querySelector('.hoq-rp-preview');
    if (prev) prev.textContent = line;
  }
  p.querySelector('.hoq-dc-title').textContent = np.title || 'Nothing playing';
  p.querySelector('.hoq-dc-artist').textContent = np.artist || '';
  const cov = p.querySelector('.hoq-dc-cover');
  cov.src = np.cover || HOQ_LOGO;
  const pr = playerProgress();
  const bar = p.querySelector('.hoq-dc-bar i');
  if (bar) bar.style.width = (pr.dur > 0 ? Math.min(100, (pr.pos / pr.dur) * 100) : 0).toFixed(1) + '%';
  const t = (n) => Math.floor(n / 60) + ':' + String(Math.floor(n % 60)).padStart(2, '0');
  const pos = p.querySelector('.hoq-dc-pos'), dur = p.querySelector('.hoq-dc-dur');
  if (pos) pos.textContent = t(pr.pos || 0);
  if (dur) dur.textContent = t(pr.dur || 0);
  renderHoqStats();
}

// The tab occupies the same band SoundCloud's own content does — under the
// header, above the player. Both edges are measured rather than assumed: the
// titlebar is merged into the header (so it isn't 50px) and the player can be
// absent (so the bottom isn't always 0), which is what made it sit wrong and
// cover the play controls.
function hoqTabMetrics() {
  // Height is the only reliable signal here: SoundCloud leaves
  // visibility:hidden on the .playControls wrapper and turns a child visible, so
  // testing visibility measured the player as absent and let the tab run over it.
  const vis = (el) =>
    !!el && getComputedStyle(el).display !== 'none' &&
    el.getBoundingClientRect().height > 0;
  const hdr = document.querySelector('.header, .l-fixed-top');
  const ply = document.querySelector('.playControls');
  const top = vis(hdr) ? Math.round(hdr.getBoundingClientRect().bottom) : 50;
  const bot = vis(ply) ? Math.round(ply.getBoundingClientRect().height) : 0;
  const r = document.documentElement.style;
  r.setProperty('--hoq-tab-top', Math.max(0, top) + 'px');
  r.setProperty('--hoq-tab-bottom', Math.max(0, bot) + 'px');
}

function closeDiscord() {
  const p = document.getElementById('hoq-discord');
  const wasOpen = !!(p && p.classList.contains('open'));
  if (p) p.classList.remove('open');
  document.documentElement.classList.remove('hoq-tab');
  const tab = document.querySelector('.hoq-dc-tab');
  if (tab) tab.classList.remove('sc-selected', 'hoq-active');
  void wasOpen;
}

function toggleDiscord() {
  const p = ensureDiscordPanel();
  const opening = !p.classList.contains('open');
  p.classList.toggle('open', opening);
  const tab = document.querySelector('.hoq-dc-tab');
  if (tab) tab.classList.toggle('hoq-active', opening);
  document.documentElement.classList.toggle('hoq-tab', opening);
  if (opening) {
    // Re-parent the settings palette into the tab. appendChild MOVES the node,
    // so every listener wired in buildTitlebar() survives untouched — nothing
    // about the palette's behaviour is duplicated here.
    try {
      const pal = document.getElementById('sc-palette');
      const host = p.querySelector('.hoq-settings-host');
      if (pal && host && pal.parentElement !== host) host.appendChild(pal);
    } catch (e) {}
    hoqTabMetrics();
    // Deliberately NO pushState/hash here. Writing '#hoq' made SoundCloud's own
    // router react and rewrite history state, which fired popstate and closed the
    // tab a moment after it opened. The tab is client-side only.
    scPost('dcwidget');       // refresh the server embed
    scPost('lastfm:status');  // refresh Last.fm state
    scPost('acct:list');      // refresh saved accounts
  }
  updateDiscordActivity();
}

// One delegated listener instead of per-nav-item {once:true} handlers — React
// re-renders the header constantly, and those bindings died with it, which left
// the tab stuck open over whatever page you'd navigated to.
if (window.top === window) {
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('#hoq-discord') || t.closest('.hoq-dc-tab')) return;
    // NOTE: not .headerSearch — clicking the search box just focuses it to type;
    // closing the tab there dropped you onto the page underneath (discover). The
    // tab now closes on the actual route change when you submit a search.
    if (t.closest('.header__navMenuItem, .header__logo, a[href^="/"]')) closeDiscord();
  }, true);
  // Any real navigation should drop the tab, whichever way it was triggered.
  // SoundCloud navigates client-side with pushState (which doesn't fire
  // popstate), so patch those too — otherwise submitting a search left the
  // results hidden behind the still-open tab.
  (function () {
    let last = location.pathname + location.search;
    const check = () => {
      const now = location.pathname + location.search;
      if (now !== last) { last = now; if (document.documentElement.classList.contains('hoq-tab')) closeDiscord(); }
    };
    ['pushState', 'replaceState'].forEach((m) => {
      const orig = history[m];
      if (typeof orig === 'function') history[m] = function () { const r = orig.apply(this, arguments); try { check(); } catch (e) {} return r; };
    });
    window.addEventListener('popstate', check);
  })();
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDiscord(); });
  window.addEventListener('resize', () => {
    if (document.documentElement.classList.contains('hoq-tab')) hoqTabMetrics();
  });
}

function myId() {
  let id = localStorage.getItem('hoqId');
  if (!id) { id = 'u' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('hoqId', id); }
  return id;
}

// The social identity: the logged-in user's PUBLIC SoundCloud handle + avatar —
// no accounts, no private data (never an email or anything private). Pulled from
// the page and cached; a stable id is derived from the profile slug (or avatar
// token) so posts stay attributed across sessions.
function hoqMe() {
  const av = (typeof findUserAvatar === 'function' ? findUserAvatar() : '') || '';
  let name = '';
  const nb = document.querySelector('.userNav__usernameButton, .header__userNavUsernameButton, .profileMenu__username');
  if (nb) name = (nb.getAttribute('title') || nb.textContent || '').trim();
  // SoundCloud's newer header shows only the avatar (no username text): read the
  // name off the avatar's label ("devuandoru’s avatar"), else the profile link.
  if (!name) {
    const lab = document.querySelector('.header__userNavAvatar [aria-label], .header__userNav [aria-label$="avatar"]');
    const t = lab ? (lab.getAttribute('aria-label') || '') : '';
    name = t.replace(/[’']s avatar$/i, '').trim();
  }
  const navProf = document.querySelector('a.header__userNavUsernameButton[href^="/"]');
  if (!name && navProf) name = decodeURIComponent((navProf.getAttribute('href') || '').slice(1).split(/[/?#]/)[0]);
  if (!name) name = (localStorage.getItem('hoqDiscord') || '').trim();
  if (!name) name = 'Someone';
  let url = (localStorage.getItem('hoqSC') || '').trim();
  if ((!url || /\/you$/.test(url)) && navProf) { const h = navProf.getAttribute('href'); if (h && h !== '/you') url = 'https://soundcloud.com' + h; }
  if (!url || /\/you$/.test(url)) {
    const prof = document.querySelector('.profileMenu a.headerMenu__link[href^="/"]:not([href="/you"])');
    const href = prof ? prof.getAttribute('href') : '';
    if (href) url = 'https://soundcloud.com' + href;
  }
  let id = '';
  const slug = ((url || '').match(/soundcloud\.com\/([^\/?#]+)/) || [])[1];
  if (slug && slug !== 'you') id = 'sc_' + slug;
  if (!id) { const m = av.match(/avatars-([A-Za-z0-9]+)/); if (m) id = 'sc_' + m[1]; }
  if (!id) id = localStorage.getItem('hoqUid') || myId();
  if (id.indexOf('sc_') === 0) localStorage.setItem('hoqUid', id);
  url = (url || '').split('?')[0].split('#')[0]; // drop utm/share query junk
  return { id, name, avatar: av, url };
}

// Real song position / duration / play-state. A Go+ song playing from YouTube
// reports the YouTube player's (SoundCloud's own sits paused on the preview), so
// Discord, Last.fm, stats, jams and the seek bar all follow the music you hear.
function playerProgress() {
  return hoqYtProgress() || hoqScProgress();
}

// SoundCloud's own player, from the player UI.
function hoqScProgress() {
  const parseT = (sel) => {
    const el = document.querySelector(sel);
    // h:mm:ss for anything an hour or longer — a bare /(\d+):(\d+)/ read
    // "1:00:15" as 60 seconds, which broke the Discord progress bar and Last.fm
    // timing on long mixes and radio shows.
    const m = (el && el.textContent || '').trim().match(/(\d+):(\d{2})(?::(\d{2}))?/);
    if (!m) return 0;
    return m[3] !== undefined ? (+m[1] * 3600 + +m[2] * 60 + +m[3]) : (+m[1] * 60 + +m[2]);
  };
  const btn = document.querySelector('.playControls__play');
  const title = (btn && btn.getAttribute('title') || '').trim();
  // SoundCloud marks the active state with a `playing` class and flips the title
  // between "Play current" / "Pause current". Read the CLASS first: the title is
  // user-facing English, so matching /^play/i reported "paused" the whole time on
  // any non-English UI — and this flag drives the visualizer, Discord Rich
  // Presence and Last.fm scrobbling, not just the waveform.
  const paused = !btn ? true
    : btn.classList.contains('playing') ? false
    : /^pause/i.test(title) ? false
    : (/^play/i.test(title) || btn.classList.contains('sc-ico-play'));
  return { pos: parseT('.playbackTimeline__timePassed'), dur: parseT('.playbackTimeline__duration'), paused };
}

// Measure how far a too-long now-playing title has to slide so the hover marquee
// travels exactly the overflow and no further. Read-only on SoundCloud's DOM —
// only a class and two custom properties, no children touched (rule 1).
function tuneNowPlayingMarquee() {
  const link = document.querySelector('.playbackSoundBadge__titleLink');
  if (!link) return;
  const over = Math.round(link.scrollWidth - link.clientWidth);
  if (over > 6) {
    link.classList.add('hoq-mq');
    link.style.setProperty('--hoq-mq', (-over - 6) + 'px');
    link.style.setProperty('--hoq-mq-dur', Math.max(5, Math.min(16, over / 22)).toFixed(1) + 's');
  } else if (link.classList.contains('hoq-mq')) {
    link.classList.remove('hoq-mq');
    link.style.removeProperty('--hoq-mq');
    link.style.removeProperty('--hoq-mq-dur');
  }
}

// Discord Rich Presence preferences (Social/Settings → Settings → Discord Rich
// Presence). Sent with every tick; the host decides what Discord shows.
function rpPrefs() {
  const g = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } };
  return {
    on: g('hoqRpOn', '1') === '1',
    status: g('hoqRpStatus', 'artist'),
    buttons: g('hoqRpButtons', '1') === '1',
    pauseHide: g('hoqRpPauseHide', '1') === '1',
    toast: g('hoqToast', '0') === '1',   // desktop song pop-up (off by default)
  };
}

// A now-playing link that's safe to broadcast to everyone who can see your
// profile. The query is dropped ("?in=user/sets/…" names the playlist you're
// playing from, which can be private), and a secret link (…/s-XXXX) is never
// published at all.
// A Go+ song YouTube plays on its own (SoundCloud wouldn't start it, so its bar
// doesn't have it) answers for the bar's title and artist links.
function npPublicUrl(sel) {
  const s = hoqYtSolo();
  if (s) {
    if (sel === '.playbackSoundBadge__titleLink') return s.url;
    if (sel === '.playbackSoundBadge__lightLink') return s.userUrl;
  }
  return hoqBarHref(sel);
}
// The link as it is in SoundCloud's own player bar.
function hoqBarHref(sel) {
  const a = document.querySelector(sel);
  const h = ((a && a.getAttribute('href')) || '').split(/[?#]/)[0];
  if (!h) return '';
  let path = h;
  if (h.startsWith('http')) { try { path = new URL(h).pathname; } catch (e) { return ''; } }
  const seg = path.split('/').filter(Boolean);
  if (seg.length >= 3 && /^s-[A-Za-z0-9]+$/.test(seg[seg.length - 1])) return '';
  return h.startsWith('http') ? h : 'https://soundcloud.com' + h;
}

// What Discord's member list will read, e.g. "Listening to tazparis".
function rpStatusLine() {
  const rp = rpPrefs();
  if (!rp.on) return 'Rich Presence is off';
  const np = currentNowPlaying();
  const what = rp.status === 'app' ? 'holdonquietlySC'
    : rp.status === 'song' ? (np.title || 'a song')
    : (np.artist || np.title || 'an artist');
  return 'Listening to ' + what;
}

// Rich Presence goes through the C# host's Discord pipe; the phone and web
// builds have no host.
function hoqHasHost() {
  try { return !!(window.chrome && window.chrome.webview && window.chrome.webview.postMessage); } catch (e) { return false; }
}

// The phone build (the proxy) has no host either, but it relays now-playing
// through the server to the desktop app, which puts it on Discord.
function hoqRelaysPresence() {
  return hoqHasHost() || !!window.__hoqProxyBuild;
}

// Settings → Discord Rich Presence controls.
function setupRpSettings(sec) {
  const box = sec.querySelector('.hoq-rp');
  const store = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  const sync = () => {
    const rp = rpPrefs();
    const val = { hoqRpOn: rp.on, hoqRpButtons: rp.buttons, hoqRpPauseHide: rp.pauseHide };
    sec.querySelectorAll('.hoq-rp-sw').forEach((sw) => { sw.checked = !!val[sw.dataset.k]; });
    sec.querySelectorAll('.hoq-rp-seg button').forEach((b) => b.classList.toggle('on', b.dataset.v === rp.status));
    box.classList.toggle('is-off', !rp.on);
    const prev = sec.querySelector('.hoq-rp-preview');
    if (prev) prev.textContent = rpStatusLine();
  };
  // Apply straight away rather than on the next 3-second tick.
  const apply = () => {
    _lastRpc = '';
    try { rpcTick(); } catch (e) {}
    sync();
    try { updateDiscordActivity(); } catch (e) {}
  };
  sec.querySelectorAll('.hoq-rp-sw').forEach((sw) => sw.addEventListener('change', () => {
    store(sw.dataset.k, sw.checked ? '1' : '0'); apply();
  }));
  sec.querySelectorAll('.hoq-rp-seg button').forEach((b) => b.addEventListener('click', () => {
    store('hoqRpStatus', b.dataset.v); apply();
  }));
  sync();
}

// Settings → holdonquietly account: the hoq account (holdonquietly.com), which is
// separate from SoundCloud's sign-in. The host does the whole sign-in and keeps
// the tokens; the page only hears who's signed in (window.__hoqAccount).
// The hoq account state is kept here from the start; the Settings bar only draws
// it. So stats, settings and "listening now" sync even if Settings is never opened.
let _hoqAcct = { signedIn: false, busy: false, note: '' }, _hoqCard = null;
const _hoqAcctViews = [];
const _hoqAcctDraw = () => _hoqAcctViews.forEach((f) => { try { f(); } catch (e) {} });
window.__hoqAccount = (s) => {
  const was = !!window.__hoqAccountUser;
  _hoqAcct = s || _hoqAcct;
  window.__hoqAccountUser = _hoqAcct.signedIn ? (_hoqAcct.user || {}) : null;   // who's signed in, for other features
  // Just signed in (or the app started signed in): fetch the account's stats and
  // settings (which then sends this PC's tally up) and the profile card.
  if (_hoqAcct.signedIn && !was) { scPost('hoqacct:pull'); scPost('hoqacct:card'); }
  if (!_hoqAcct.signedIn) _hoqCard = null;
  _hoqAcctDraw();
};
window.__hoqAccountCard = (c) => { if (c && typeof c === 'object' && _hoqAcct.signedIn) { _hoqCard = c; _hoqAcctDraw(); } };

function setupHoqAccount(sec) {
  const pic = sec.querySelector('.hoq-hoq-pic');
  const name = sec.querySelector('.hoq-hoq-name');
  const sub = sec.querySelector('.hoq-hoq-sub');
  const btn = sec.querySelector('.hoq-hoq-btn');
  const prof = sec.querySelector('.hoq-hoq-profile');
  const pubRow = sec.querySelector('.hoq-hoq-pub');
  const nowRow = sec.querySelector('.hoq-hoq-nowpub');
  const nowBox = nowRow.querySelector('input');
  const pubBox = pubRow.querySelector('input');
  const bar = sec.querySelector('.hoq-hoq-bar');
  const banner = sec.querySelector('.hoq-hoq-banner');
  const badges = sec.querySelector('.hoq-hoq-badges');
  const bio = sec.querySelector('.hoq-hoq-bio');
  const mini = sec.querySelector('.hoq-hoq-mini');
  const blurb = sub.textContent;
  let st = { signedIn: false, busy: false, note: '' };
  let card = null;   // the profile card from holdonquietly.com (GET /me/card)

  // Signed in: banner, badges, a line about them and their listening numbers.
  const fmtMonth = (t) => new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  const best = (o) => { let b = null; for (const k in (o || {})) if (b === null || o[k] > o[b]) b = k; return b; };
  function drawCard() {
    const on = !!(st.signedIn && !st.busy);
    const c = on ? card : null;
    bar.classList.toggle('has-card', !!c);
    // banner: their profile banner, else a wash of their profile colours
    // banner: their profile banner; else their picture, blown up and blurred;
    // else their profile colours; else nothing (the accent wash shows)
    const pic2 = c && (hoqSafeUrl(c.avatar) || hoqSafeUrl((st.user || {}).picture));
    const art = c && (hoqSafeUrl(c.banner) || hoqSafeUrl(c.background));   // banner, else their page background pic
    banner.classList.toggle('is-blur', !!(c && !art && pic2));
    if (art) banner.style.backgroundImage = 'url("' + art + '")';
    else if (pic2) banner.style.backgroundImage = 'url("' + pic2 + '")';
    else if (c && c.colors && /^#[0-9a-f]{6}$/i.test(c.colors.bar || '') && /^#[0-9a-f]{6}$/i.test(c.colors.box || '')) banner.style.backgroundImage = 'linear-gradient(120deg,' + c.colors.bar + ',' + c.colors.box + ')';
    else banner.style.backgroundImage = '';
    badges.innerHTML = c && Array.isArray(c.badges) ? c.badges.slice(0, 6).map((x) => '<span class="hoq-hoq-badge">' + hoqEsc(x && x.label) + '</span>').join('') : '';
    if (c) {
      const u = st.user || {};
      const parts = ['@' + (c.username || u.username || '')];
      if (c.created_at) parts.push('joined ' + fmtMonth(c.created_at));
      if (typeof c.friend_count === 'number') parts.push(c.friend_count + (c.friend_count === 1 ? ' friend' : ' friends'));
      if (typeof c.views === 'number') parts.push(c.views.toLocaleString() + (c.views === 1 ? ' view' : ' views'));
      if (!c.profile_public) parts.push('profile is private');
      sub.textContent = parts.join(' · ');
      const moodTxt = c.mood && c.mood.text ? (c.mood.face ? c.mood.face + ' ' : '') + 'mood: ' + c.mood.text : '';
      const line = c.headline || c.status || c.bio || '';
      bio.textContent = [line, moodTxt].filter(Boolean).join('  ·  ');
      bio.hidden = !bio.textContent;
    } else bio.hidden = true;
    // listening numbers (this PC + the account), always the live ones
    if (on) {
      const all = hoqStatsShown(), m = hoqStatsWindow(all, 30);
      const chip = (n, l) => '<span class="hoq-hoq-chip"><b>' + hoqEsc(n) + '</b> ' + hoqEsc(l) + '</span>';
      const chips = [chip(all.plays.toLocaleString(), 'plays'), chip(hoqFmtDur(all.seconds), 'listened'), chip(m.plays.toLocaleString(), 'this month')];
      // (top artist goes last: it's the one that gets cut short if space runs out)
      const ta = best(m.artists) || best(all.artists);
      if (ta) chips.push(chip(ta, m.plays ? 'top this month' : 'top artist'));
      mini.innerHTML = chips.join('');
      mini.hidden = false;
    } else mini.hidden = true;
  }
  setInterval(() => { if (st.signedIn && document.getElementById('hoq-discord')?.classList.contains('open')) drawCard(); }, 30000);
  pubBox.checked = localStorage.getItem('hoqStatsPublic') === '1';
  pubBox.addEventListener('change', () => {
    try { localStorage.setItem('hoqStatsPublic', pubBox.checked ? '1' : '0'); } catch (e) {}
    hoqCloudPush(true);
  });
  nowBox.checked = localStorage.getItem('hoqNowPublic') === '1';
  nowBox.addEventListener('change', () => {
    try { localStorage.setItem('hoqNowPublic', nowBox.checked ? '1' : '0'); } catch (e) {}
    _nowSent = '__changed';   // re-send straight away (or take it down)
    try { const np = currentNowPlaying(), pr = playerProgress(); hoqNowPush(np.title, np.artist, npPublicUrl('.playbackSoundBadge__titleLink'), np.cover, pr.paused); } catch (e) {}
  });
  const render = () => {
    st = _hoqAcct; card = _hoqCard;
    const u = st.user || {};
    pubRow.hidden = !st.signedIn;
    nowRow.hidden = !st.signedIn;
    if (st.busy) {
      name.textContent = 'Finish signing in in your browser…';
      sub.textContent = 'Waiting for holdonquietly.com.';
      btn.textContent = 'Cancel';
    } else if (st.signedIn) {
      name.textContent = u.name || u.username || 'Signed in';
      sub.textContent = u.username ? '@' + u.username + (u.role && u.role !== 'user' ? ' · ' + u.role : '') : 'Signed in';
      btn.textContent = 'Sign out';
    } else {
      name.textContent = 'holdonquietly account';
      sub.textContent = st.note || blurb;
      btn.textContent = 'Sign in';
    }
    sub.classList.toggle('is-bad', !!st.note && !st.busy && !st.signedIn);
    prof.hidden = !(st.signedIn && u.profile);
    bar.classList.toggle('is-in', !!st.signedIn);
    // Their picture when signed in, else the hoq logo — the bar never has a hole.
    const src = st.signedIn && hoqSafeUrl(u.picture) ? hoqSafeUrl(u.picture) : HOQ_LOGO;
    pic.classList.toggle('is-logo', src === HOQ_LOGO);
    if (pic.getAttribute('src') !== src) pic.src = src;
    drawCard();
  };
  pic.addEventListener('error', () => { if (pic.getAttribute('src') !== HOQ_LOGO) { pic.src = HOQ_LOGO; pic.classList.add('is-logo'); } });
  btn.addEventListener('click', () => scPost(st.busy ? 'hoqacct:cancel' : st.signedIn ? 'hoqacct:signout' : 'hoqacct:signin'));
  prof.addEventListener('click', () => { const u = st.user; if (u && u.profile) scPost('open:' + u.profile); });
  _hoqAcctViews.push(render);
  render();   // the current state (signed out + logo until the host answers)
  scPost('hoqacct:status');
}

// Settings → Discord webhook. The URL goes straight to the host, which keeps
// it on disk; the page only ever learns whether one is set.
function setupHookSettings(sec) {
  const state = sec.querySelector('.hoq-hook-state');
  const input = sec.querySelector('.hoq-hook-input');
  const save = sec.querySelector('.hoq-hook-save');
  const remove = sec.querySelector('.hoq-hook-remove');
  window.__hoqHookStatus = (isSet, err) => {
    state.textContent = err || (isSet ? 'Webhook connected' : 'No webhook set');
    state.classList.toggle('is-bad', !!err || !isSet);
    remove.hidden = !isSet;
    save.textContent = isSet ? 'Replace' : 'Save';
    save.disabled = false;
  };
  save.addEventListener('click', () => {
    const v = input.value.trim();
    if (!v) { input.focus(); return; }
    save.textContent = 'Saving…'; save.disabled = true;
    scPost('hook:set:' + v);
    input.value = '';
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); });
  remove.addEventListener('click', () => { remove.hidden = true; scPost('hook:clear'); });
  scPost('hook:status');
}

// Settings → Phone → "Log in on your phone". The host makes a QR from this app's
// own SoundCloud login; it shows for a minute and is then wiped from the page.
// The phone site (proxy build): a Home Screen web app keeps its own cookies,
// apart from Safari's, so signing in one doesn't sign in the other. Settings ->
// "Home Screen app" hands the sign-in across with the same one-time link the
// PC's Copy link makes (POST /__hoq/pair, here same-origin), pasted into the
// other one's Sign in sheet. Its login cookies aren't HttpOnly (the pair
// service sets them that way, as SoundCloud does), so the page can read them.
function hoqProxyLogin() {
  const g = (n) => { const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')); return m ? m[1] : ''; };
  return { o: g('oauth_token'), s: g('sc_session') };
}
// "Copy page details" (phone site, Settings): how the page and SoundCloud's
// newer-app frames are built and painted, for a layout bug only a signed-in
// phone shows. Structure and colours only: no cookies, tokens, names or
// addresses beyond paths (query strings are dropped).
function hoqPageReport() {
  const cs = (el) => { try { return getComputedStyle(el); } catch (e) { return null; } };
  const bg = (el) => { const c = el && cs(el); return c ? c.backgroundColor + (c.backgroundImage && c.backgroundImage !== 'none' ? ' +img' : '') : '-'; };
  const scheme = (el) => { const c = el && cs(el); return c ? c.colorScheme : '-'; };
  const tag = (el) => el ? el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 4).join('.') : '') : '-';
  const path = (u) => { try { const x = new URL(u, location.href); return x.host + x.pathname; } catch (e) { return String(u || '').slice(0, 80); } };
  const H = document.documentElement;
  const out = {
    v: (HOQ_CHANGES[0] || {}).id, at: new Date().toISOString(), ua: navigator.userAgent, vw: innerWidth + 'x' + innerHeight,
    standalone: !!(navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches)),
    page: location.pathname, html: [...H.classList].filter((c) => /^(sc-|hoq-)/.test(c)).join(' '),
    meta: (document.querySelector('meta[name="color-scheme"]') || {}).content || '', scheme: scheme(H) + ' / ' + scheme(document.body),
    bg: bg(H) + ' / ' + bg(document.body), frames: [],
  };
  document.querySelectorAll('iframe').forEach((f) => {
    const r = f.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) return;
    const fi = { el: tag(f), src: path(f.getAttribute('src') || ''), box: Math.round(r.width) + 'x' + Math.round(r.height), scheme: scheme(f), bg: bg(f) };
    let d = null;
    try { d = f.contentDocument; } catch (e) {}
    if (!d || !d.documentElement) { fi.doc = 'cross-origin'; out.frames.push(fi); return; }
    const fh = d.documentElement, fw = f.contentWindow;
    const fcs = (el) => { try { return fw.getComputedStyle(el); } catch (e) { return null; } };
    const fbg = (el) => { const c = el && fcs(el); return c ? c.backgroundColor + (c.backgroundImage && c.backgroundImage !== 'none' ? ' +img' : '') : '-'; };
    fi.doc = path(fw.location.href);
    fi.html = [...fh.classList].join(' ').slice(0, 200);
    fi.themed = !!d.getElementById('sc-desktop-style') + '/' + !!d.getElementById('hoq-mobile-frame-css');
    fi.scheme2 = (fcs(fh) || {}).colorScheme + ' / ' + (d.body ? (fcs(d.body) || {}).colorScheme : '-');
    fi.bg2 = fbg(fh) + ' / ' + fbg(d.body);
    // the largest light-painted boxes inside: what is actually white
    const light = [];
    d.querySelectorAll('body *').forEach((el) => {
      if (light.length > 40) return;
      const c = fcs(el); if (!c) return;
      const m = (c.backgroundColor || '').match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
      if (!m || (m[4] !== undefined && +m[4] < 0.3)) return;
      if ((+m[1] + +m[2] + +m[3]) / 3 < 150) return;
      const b = el.getBoundingClientRect();
      if (b.width * b.height < 4000) return;
      light.push({ el: tag(el), bg: c.backgroundColor, box: Math.round(b.width) + 'x' + Math.round(b.height) });
    });
    light.sort((a, b2) => (+b2.box.split('x')[0] * +b2.box.split('x')[1]) - (+a.box.split('x')[0] * +a.box.split('x')[1]));
    fi.light = light.slice(0, 8);
    out.frames.push(fi);
  });
  return JSON.stringify(out, null, 1);
}

function setupAppLinkSettings(sec) {
  const inApp = !!(navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches));
  const hint = inApp
    ? 'Copy a one-time link, open sc.holdonquietly.com in Safari, tap Sign in and paste it. It works once, within 10 minutes.'
    : 'The Home Screen app keeps its own sign-in. Copy a one-time link, open the app, tap Sign in and paste it. It works once, within 10 minutes.';
  sec.querySelector('.hoq-dc-label').textContent = 'Home Screen app';
  sec.querySelector('.hoq-rp').innerHTML =
    '<div class="hoq-rp-row hoq-rp-static">' +
      '<span><b>' + (inApp ? 'Sign in Safari too' : 'Sign in the Home Screen app') + '</b><em class="hoq-applink-state" style="white-space:normal;overflow:visible;text-overflow:clip;"></em></span>' +
      '<button class="hoq-pair-btn hoq-applink-btn" type="button">Copy link</button>' +
    '</div>' +
    '<div class="hoq-rp-row hoq-rp-static">' +
      '<span><b>Page details</b><em class="hoq-diag-state" style="white-space:normal;overflow:visible;text-overflow:clip;">For a bug report: how this page is built and coloured. No sign-in or personal info.</em></span>' +
      '<button class="hoq-pair-btn hoq-diag-btn" type="button">Copy</button>' +
    '</div>' +
    '<input class="hoq-applink-box" readonly hidden aria-label="Sign-in link" style="display:block;width:100%;box-sizing:border-box;margin:0 0 12px;' +
      'padding:9px 12px;border-radius:9px;border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.05);color:#fff;font-size:16px;">';
  const state = sec.querySelector('.hoq-applink-state'), btn = sec.querySelector('.hoq-applink-btn'), box = sec.querySelector('.hoq-applink-box');
  state.textContent = hint;
  const diagBtn = sec.querySelector('.hoq-diag-btn'), diagState = sec.querySelector('.hoq-diag-state');
  diagBtn.addEventListener('click', () => {
    let txt = '';
    try { txt = hoqPageReport(); } catch (e) { txt = 'report failed: ' + (e && e.message); }
    const shown = () => { box.hidden = false; box.value = txt; box.focus(); box.setSelectionRange(0, txt.length); diagState.textContent = 'Copy the text in the box (tap it, Select All, Copy) and paste it where you are reporting the bug.'; };
    try { navigator.clipboard.writeText(txt).then(() => { diagState.textContent = 'Copied. Paste it in the chat.'; }, shown); } catch (e) { shown(); }
  });
  let back = 0;
  const done = (text) => {
    btn.disabled = false; btn.textContent = 'Copy link';
    state.textContent = text;
    clearTimeout(back);
    back = setTimeout(() => { state.textContent = hint; }, 20000);
  };
  const make = () => {
    const c = hoqProxyLogin();
    if (!c.o) return Promise.reject('out');
    return fetch('/__hoq/pair', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ o: c.o, s: c.s }),
    }).then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => {
        if (!d || !/^[A-Za-z0-9_-]{16,64}$/.test(d.id || '')) throw new Error('bad id');
        return location.origin + '/__hoq/pair/' + d.id;
      });
  };
  const failed = (s) => done(s === 'out' ? 'You’re not signed in here.'
    : s === 429 ? 'Too many sign-in links are waiting right now. Try again in a few minutes.'
      : 'Couldn’t make a link. Check your connection and try again.');
  const copied = () => { box.hidden = true; done('Copied. Now open ' + (inApp ? 'Safari' : 'the Home Screen app') + ', tap Sign in and paste it. It works once, within 10 minutes.'); };
  // A link copied by hand when the clipboard says no.
  const manual = (link) => {
    box.hidden = false; box.value = link; box.focus(); box.setSelectionRange(0, link.length);
    done('Copy the link in the box (tap it, Select All, Copy). It works once, within 10 minutes.');
  };
  btn.addEventListener('click', () => {
    btn.disabled = true; btn.textContent = 'Making…';
    const p = make();
    p.catch(failed);
    // Safari only copies during the tap itself: hand it the link as a promise
    // (ClipboardItem) so the wait for the server still counts as the tap.
    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      let item;
      try { item = new ClipboardItem({ 'text/plain': p.then((l) => new Blob([l], { type: 'text/plain' })) }); } catch (e) { item = null; }
      if (item) {
        navigator.clipboard.write([item]).then(copied, () => p.then(manual, () => {}));
        return;
      }
    }
    p.then((l) => {
      try { navigator.clipboard.writeText(l).then(copied, () => manual(l)); } catch (e) { manual(l); }
    }, () => {});
  });
}

function setupPairSettings(sec) {
  let modal = document.getElementById('hoq-pair-modal');
  if (!modal) {
    const st = document.createElement('style');
    st.id = 'hoq-pair-css';
    st.textContent = `
      #hoq-pair-modal { position: fixed; inset: 0; z-index: 2147483300; display: flex; align-items: center;
        justify-content: center; background: rgba(0,0,0,0.55); backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px); font-family: Inter,-apple-system,Arial,sans-serif; }
      #hoq-pair-modal[hidden] { display: none !important; }
      #hoq-pair-modal .hoq-pair-card { position: relative; width: 340px; max-width: calc(100vw - 32px);
        box-sizing: border-box; padding: 24px 24px 20px; border-radius: 18px; text-align: center; color: #e7e7ed;
        background: rgba(16,16,20,0.82); border: 1px solid rgba(255,255,255,0.10);
        box-shadow: 0 24px 70px rgba(0,0,0,0.6);
        backdrop-filter: blur(24px) saturate(1.5); -webkit-backdrop-filter: blur(24px) saturate(1.5); }
      #hoq-pair-modal .hoq-pair-x { position: absolute; top: 10px; right: 10px; width: 28px; height: 28px;
        border: 0; border-radius: 50%; background: rgba(255,255,255,0.08); color: #c9c9d2;
        font-size: 16px; line-height: 1; cursor: pointer; }
      #hoq-pair-modal .hoq-pair-x:hover { background: rgba(255,255,255,0.16); color: #fff; }
      #hoq-pair-modal .hoq-pair-title { font-size: 17px; font-weight: 800; color: #fff; }
      #hoq-pair-modal .hoq-pair-sub { font-size: 12.5px; color: #9a9aa3; margin-top: 4px; }
      #hoq-pair-modal .hoq-pair-qr { width: 240px; height: 240px; margin: 18px auto 14px; border-radius: 14px;
        background: #fff; display: flex; align-items: center; justify-content: center; overflow: hidden; }
      #hoq-pair-modal .hoq-pair-qr img { width: 100%; height: 100%; display: block; image-rendering: pixelated; }
      #hoq-pair-modal .hoq-pair-qr.is-empty { background: rgba(255,255,255,0.05); }
      #hoq-pair-modal .hoq-pair-qr.is-empty img { display: none; }
      #hoq-pair-modal .hoq-pair-status { display: none; padding: 16px; font-size: 13px; color: #c9c9d2; }
      #hoq-pair-modal .hoq-pair-qr.is-empty .hoq-pair-status { display: block; }
      #hoq-pair-modal .hoq-pair-who { font-size: 13px; color: #c9c9d2; }
      #hoq-pair-modal .hoq-pair-who b { color: var(--sc-accent,#ff5500); }
      #hoq-pair-modal .hoq-pair-warn { margin-top: 10px; font-size: 11.5px; line-height: 1.45; color: #ffb4a8; }
      #hoq-pair-modal .hoq-pair-timer { margin-top: 8px; font-size: 11px; color: #7f7f8a; font-variant-numeric: tabular-nums; }
    `;
    (document.head || document.documentElement).appendChild(st);
    modal = document.createElement('div');
    modal.id = 'hoq-pair-modal';
    modal.hidden = true;
    modal.innerHTML =
      '<div class="hoq-pair-card">' +
        '<button class="hoq-pair-x" type="button" aria-label="Close">×</button>' +
        '<div class="hoq-pair-title">Log in on your phone</div>' +
        '<div class="hoq-pair-sub">On your phone, open sc.holdonquietly.com and tap Sign in → Scan the code.</div>' +
        '<div class="hoq-pair-qr is-empty"><img alt="Login code"><span class="hoq-pair-status"></span></div>' +
        '<div class="hoq-pair-who">Signs in as <b></b></div>' +
        '<div class="hoq-pair-warn">This code is your login. Anyone who scans it gets into your SoundCloud, so don’t screenshot or share it.</div>' +
        '<div class="hoq-pair-timer"></div>' +
      '</div>';
    document.body.appendChild(modal);
  }
  const box = modal.querySelector('.hoq-pair-qr');
  const img = box.querySelector('img');
  const status = box.querySelector('.hoq-pair-status');
  const timer = modal.querySelector('.hoq-pair-timer');
  let tick = null;
  const close = () => {
    modal.hidden = true;
    img.removeAttribute('src');          // the code is a login — don't leave it in the page
    box.classList.add('is-empty');
    clearInterval(tick); tick = null;
  };
  const warn = modal.querySelector('.hoq-pair-warn');
  const WARN_LONG = warn.textContent;
  window.__hoqPairQr = (src, err, once) => {
    if (modal.hidden) return;
    if (err || !src) { status.textContent = err || 'Couldn’t make the code.'; return; }
    // a one-time link (the usual): small code, dead after one scan or 10 minutes
    warn.textContent = once ? 'Works once, within 10 minutes. Until it’s used it signs into your SoundCloud, so don’t screenshot or share it.' : WARN_LONG;
    img.src = src;
    box.classList.remove('is-empty');
    let left = 60;
    timer.textContent = 'Hides in ' + left + 's';
    clearInterval(tick);
    tick = setInterval(() => { left -= 1; timer.textContent = 'Hides in ' + left + 's'; if (left <= 0) close(); }, 1000);
  };
  const linkBtn = sec.querySelector('.hoq-pair-linkbtn');
  const linkState = sec.querySelector('.hoq-pair-linkstate');
  const linkHint = linkState.textContent;
  window.__hoqPairLink = (link, err) => {
    linkBtn.disabled = false;
    linkBtn.textContent = 'Copy link';
    if (err || !link) { linkState.textContent = err || 'Couldn’t make a link.'; return; }
    navigator.clipboard.writeText(link).then(
      () => { linkState.textContent = 'Copied. Send it to yourself — it works once, within 10 minutes.'; },
      () => { linkState.textContent = 'Couldn’t copy it — try again.'; });
    setTimeout(() => { linkState.textContent = linkHint; }, 15000);
  };
  linkBtn.addEventListener('click', () => {
    linkBtn.disabled = true;
    linkBtn.textContent = 'Making…';
    scPost('pair:link');
  });
  sec.querySelector('.hoq-pair-btn').addEventListener('click', () => {
    modal.querySelector('.hoq-pair-who b').textContent = hoqMe().name || 'your account';
    status.textContent = 'Making your code…';
    timer.textContent = '';
    img.removeAttribute('src');
    box.classList.add('is-empty');
    modal.hidden = false;
    scPost('pair:qr');
  });
  if (!modal.dataset.bound) {
    modal.dataset.bound = '1';
    modal.querySelector('.hoq-pair-x').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    window.addEventListener('keydown', (e) => { if (!modal.hidden && e.key === 'Escape') close(); });
  }
}

// Push now-playing to the C# host (Discord Rich Presence + friends backend).
let _lastRpc = '';
function rpcTick() {
  const np = currentNowPlaying();
  const pr = playerProgress();
  const rp = rpPrefs();
  const url = npPublicUrl('.playbackSoundBadge__titleLink');
  const jam = hoqJamAdvert();
  const key = [np.title, url, pr.paused, Math.round(pr.pos / 8),
    rp.on, rp.status, rp.buttons, rp.pauseHide, rp.toast, jam].join('|');
  if (key === _lastRpc) return;
  _lastRpc = key;
  const me = hoqMe(); // SoundCloud name/profile: the fallback when Discord isn't running
  scPost('rpc:' + JSON.stringify({
    id: myId(),
    name: localStorage.getItem('hoqDiscord') || '',
    scName: me.name === 'Someone' ? '' : me.name,
    sc: localStorage.getItem('hoqSC') || me.url || '',
    title: np.title, artist: np.artist, cover: np.cover,
    url, artistUrl: npPublicUrl('.playbackSoundBadge__lightLink'),
    pos: pr.pos, dur: pr.dur, paused: pr.paused, rate: (() => { try { return hoqFxState().speed; } catch (e) { return 1; } })(),
    rp, jam,
  }));
  hoqNowPush(np.title, np.artist, url, np.cover, pr.paused);
}

// "Listening now" on the person's holdonquietly profile (Settings switch). Sent on
// a new song, then every 2 min while it plays (the profile drops it after 6 min
// without one), and taken down on pause.
let _nowSent = '', _nowAt = 0;
function hoqNowPush(title, artist, url, cover, paused) {
  if (!window.__hoqAccountUser || !hoqHasHost()) return;
  const playing = localStorage.getItem('hoqNowPublic') === '1' && !!title && !paused;
  const sig = playing ? title + '|' + url : 'off';
  if (sig === _nowSent && (sig === 'off' || Date.now() - _nowAt < 120000)) return;
  _nowSent = sig; _nowAt = Date.now();
  scPost('hoqacct:now:' + JSON.stringify(playing ? { title, artist, url: hoqSafeUrl(url), cover: hoqSafeUrl(cover) } : { playing: false }));
}

// ---------------------------------------------------------------------------
// "Share to Discord" — a floating button that posts the current track to a
// Discord webhook. The webhook URL is read HOST-SIDE from a local config file
// (%LocalAppData%\SoundCloudApp\webhook.txt), never embedded in the page/repo,
// and the POST is done by the C# host (Discord webhooks don't send CORS headers,
// so a page fetch would be blocked). Our own element → safe to build/mutate.
// ---------------------------------------------------------------------------
// Who is sharing: the display name set in the hub (falls back to the SoundCloud
// username), plus their SoundCloud avatar (a public sndcdn URL Discord can load).
// Pull an image URL from an element (inline style, computed bg, or <img> src).
function _bgUrl(el) {
  if (!el) return '';
  if (el.tagName === 'IMG') return el.getAttribute('src') || el.src || '';
  const raw = (el.getAttribute && el.getAttribute('style')) || '';
  let m = raw.match(/url\(["']?(.*?)["']?\)/);
  if (m && m[1]) return m[1];
  m = (getComputedStyle(el).backgroundImage || '').match(/url\(["']?(.*?)["']?\)/);
  return (m && m[1]) ? m[1] : '';
}

// Find the logged-in user's avatar in the header (SoundCloud changes classes, so
// try several selectors, then fall back to scanning the header for a SoundCloud
// avatar URL — those are public i*.sndcdn.com/avatars-... images Discord can load).
function findUserAvatar() {
  const btn = document.querySelector(
    '.header__userNavButton, .userNav__usernameButton, .header a[href="/you"], .header a[href^="/you/"], .header [class*="userNav" i]'
  );
  if (btn) {
    const inner = btn.querySelector('img, .sc-artwork, [style*="url("], .image__full, span');
    const u = _bgUrl(inner) || _bgUrl(btn);
    if (u) return u;
  }
  const header = document.querySelector('.header') || document.body;
  const img = header.querySelector('img[src*="avatars-"], img[src*="sndcdn"]');
  if (img) return img.getAttribute('src') || img.src || '';
  const els = header.querySelectorAll('.sc-artwork, [style*="avatars-"], [style*="url("]');
  for (const el of els) { const b = _bgUrl(el); if (/avatars-|sndcdn/i.test(b)) return b; }
  return '';
}

function senderInfo() {
  let name = (localStorage.getItem('hoqDiscord') || '').trim();
  let sc = (localStorage.getItem('hoqSC') || '').trim();
  if (!name && sc) name = sc.replace(/[/?#].*$/, '').replace(/\/+$/, '').split('/').pop() || '';
  let avatar = findUserAvatar();
  // Bump SoundCloud thumbs to a crisp size (only when it's a recognizably sized URL).
  if (avatar && /(?:-|_)(?:t?\d+x\d+|badge|small|large|tiny|mini|original|crop)\.(?:jpe?g|png|webp|gif)/i.test(avatar)) {
    avatar = avatar.replace(/(?:-|_)(?:t?\d+x\d+|badge|small|large|tiny|mini|original|crop)\./i, '-t200x200.');
  }
  return { name, avatar };
}

// The current accent (cover-matched) as a Discord embed color int.
function accentInt() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--sc-accent').trim();
  const m = v.match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) return (+m[1] << 16) + (+m[2] << 8) + (+m[3]);
  const h = v.match(/#([0-9a-f]{6})/i);
  return h ? parseInt(h[1], 16) : null;
}

function shareCurrentSong() {
  const np = currentNowPlaying();
  const h = hoqNowHref();
  const url = h ? (h.startsWith('http') ? h : location.origin + h) : '';
  const s = senderInfo();
  const dur = playerProgress().dur;
  const length = dur > 0 ? (Math.floor(dur / 60) + ':' + String(dur % 60).padStart(2, '0')) : '';
  return { title: np.title, artist: np.artist, cover: np.cover, url, name: s.name, avatar: s.avatar, color: accentInt(), length };
}

// One share per track: once shared, the button locks to a "Shared" state and
// only re-enables when the track changes. In-memory, so it also resets on app
// restart (page reload re-injects preload).
let _hoqLastShared = '';

function startShareButton() {
  if (document.getElementById('hoq-share')) return;
  if (!document.getElementById('hoq-share-style')) {
    const st = document.createElement('style');
    st.id = 'hoq-share-style';
    st.textContent =
      // Lives in the player bar's action cluster, styled like SoundCloud's own
      // icon buttons there. Hidden while unmounted so it can never float loose.
      '#hoq-share{display:none}' +
      '.playbackSoundBadge__actions #hoq-share{display:inline-flex;align-items:center;justify-content:center;' +
      'width:30px;height:30px;margin-left:10px;padding:0;background:none;border:0;' +
      'border-radius:7px;cursor:pointer;color:#fff;flex:0 0 auto;' +
      'transition:color .15s ease,background .15s ease}' +
      '.playbackSoundBadge__actions #hoq-share:hover{color:var(--sc-accent,#ff5500);background:rgba(255,255,255,0.09)}' +
      '.playbackSoundBadge__actions #hoq-share svg{width:16px;height:16px;flex:0 0 auto}' +
      // The label becomes the tooltip once we're icon-only.
      '.playbackSoundBadge__actions #hoq-share span{display:none}' +
      '.playbackSoundBadge__actions #hoq-share.done{color:var(--sc-accent,#ff5500);cursor:default}' +
      '.playbackSoundBadge__actions #hoq-share.done:hover{background:none}';
    document.head.appendChild(st);
  }
  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg>';
  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  const btn = document.createElement('button');
  btn.id = 'hoq-share';

  // Unique-per-track key: the track link, else title|artist.
  const songKey = () => {
    const h = hoqNowHref();
    if (h) return h;
    const np = currentNowPlaying();
    return np.title ? (np.title + '|' + np.artist) : '';
  };
  // Paint the button for the current track's shared state (skips while a
  // transient message like "Nothing playing" is showing). Writes only when the
  // state flips: rewriting it every second kept the page's mutation observer,
  // and so removeClutter's full-page scan, busy for the whole session.
  let painted = '';
  const paint = (html) => { if (html !== painted) { painted = html; btn.innerHTML = html; } };
  const refresh = () => {
    if (btn.dataset.msg) return;
    const k = songKey(), shared = !!(k && k === _hoqLastShared);
    btn.classList.toggle('done', shared);
    paint((shared ? CHECK : ICON) + '<span>' + (shared ? 'Shared' : 'Share to Discord') + '</span>');
  };
  const flash = (txt) => {
    btn.dataset.msg = '1';
    paint(ICON + '<span>' + txt + '</span>');
    setTimeout(() => { delete btn.dataset.msg; refresh(); }, 1600);
  };

  btn.onclick = () => {
    const k = songKey();
    if (!k) { flash('Nothing playing'); return; }
    if (k === _hoqLastShared) return; // already shared this track — locked until it changes / restart
    const payload = shareCurrentSong();
    scPost('DBG share name=' + (payload.name || '(none)') + ' avatar=' + (payload.avatar || '(none)'));
    scPost('webhook:' + JSON.stringify(payload));
    _hoqLastShared = k;
    refresh(); // lock to "Shared" until the track changes
  };

  document.body.appendChild(btn);
  refresh();
  // Re-enables automatically when a new track starts. One timer for whichever
  // copy is current: mountDiscordActions rebuilds the button when React takes
  // the player bar with it, and each rebuild used to leave its old timer running.
  clearInterval(window.__hoqShareIv);
  window.__hoqShareIv = setInterval(refresh, 1000);
}

// "Play in Discord" — same payload as Share, but flagged so the host marks
// it as a play request. Sits above the Share button and shares its styling.
let _hoqLastQueued = '';
let _hoqLastRowBtn = null;   // the per-row queue button last clicked, so a failure can undo it

// The host answers every play request. Both buttons flip to "Queued" the moment
// they're clicked, so a request that never reached Discord (no webhook, Discord
// refused it) used to look like it worked — and the one-per-track lock then
// blocked a retry. A failure undoes the optimistic state and shows it in red.
window.__hoqPlayResult = function (ok, reason) {
  const row = _hoqLastRowBtn;
  _hoqLastRowBtn = null;
  if (ok) return;
  _hoqLastQueued = '';   // let the same track be tried again
  const msg = "Didn't send: " + reason;
  if (row) {
    row.classList.remove('done');
    row.classList.add('fail');
    row.innerHTML = HOQ_Q_PLAY;
    row.title = msg;
    setTimeout(() => { row.classList.remove('fail'); row.title = 'Play in Discord'; }, 4000);
  }
  const bar = document.getElementById('hoq-playbtn');
  if (bar) {
    bar.classList.add('fail');
    if (bar._hoqFlash) bar._hoqFlash(msg);
    setTimeout(() => bar.classList.remove('fail'), 4000);
  }
};

// ---------------------------------------------------------------------------
// Queue ANY track, not just the one playing. The bot resolves from the URL, so
// title/artist/cover here only decide what the embed shows.
// ---------------------------------------------------------------------------
// Discord mark + a label that slides out on hover, so it can't be mistaken for
// SoundCloud's own play button.
const HOQ_Q_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.865-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg><span>Play in Discord</span>';
const HOQ_Q_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg><span>Queued</span>';

// A track permalink is exactly /<user>/<track> — two segments, no reserved first
// segment, and not a /sets/ playlist.
function trackLinkInfo(link) {
  if (!link || !link.getAttribute) return null;
  let href = link.getAttribute('href') || '';
  if (!href) return null;
  if (!href.startsWith('http')) href = location.origin + href;
  let u;
  try { u = new URL(href); } catch (e) { return null; }
  if (!/(^|\.)soundcloud\.com$/i.test(u.hostname)) return null;
  const seg = u.pathname.split('/').filter(Boolean);
  if (seg.length !== 2 || NOT_A_TRACK.test(seg[0]) || seg[1] === 'sets') return null;
  const row = link.closest && link.closest(
    '[role="listitem"], .soundBadge, .trackItem, .soundList__item, .compactTrackListItem, li');
  const title = (link.textContent || '').trim() || seg[1].replace(/-/g, ' ');
  let artist = seg[0], cover = '';
  if (row) {
    // The uploader link in the same row is the one with a single path segment.
    const prof = [...row.querySelectorAll('a[href]')].find((a) => {
      // Parse it — these hrefs are absolute on the new page, so splitting the raw
      // attribute counted "https:" and the host as path segments.
      let h = a.getAttribute('href') || '';
      if (!h) return false;
      if (!h.startsWith('http')) h = location.origin + h;
      let pu;
      try { pu = new URL(h); } catch (e) { return false; }
      const p = pu.pathname.split('/').filter(Boolean);
      return p.length === 1 && !NOT_A_TRACK.test(p[0]);
    });
    if (prof && (prof.textContent || '').trim()) artist = prof.textContent.trim();
    const img = row.querySelector('img[src*="sndcdn"]');
    if (img && img.src) cover = img.src.replace(/-t\d+x\d+\./, '-t500x500.');
  }
  return { url: u.origin + u.pathname, title: title.slice(0, 140), artist, cover };
}

// The track this PAGE is about. When you're looking at a song you aren't playing,
// that's the one "Play in Discord" should queue.
function pageTrackInfo() {
  const seg = location.pathname.split('/').filter(Boolean);
  if (seg.length !== 2 || NOT_A_TRACK.test(seg[0]) || seg[1] === 'sets') return null;
  let title = '', artist = '';
  for (const f of document.querySelectorAll('iframe')) {     // new webi V2 page
    let d = null;
    try { d = f.contentDocument; } catch (e) { continue; }
    if (!d) continue;
    const h = d.querySelector('section[aria-label="Track header"] h1');
    if (!h) continue;
    title = (h.textContent || '').trim();
    const a = d.querySelector('section[aria-label="Track header"] a[href$="/' + seg[0] + '"]');
    if (a) artist = (a.textContent || '').trim();
    break;
  }
  if (!title) {                                               // legacy page
    const h = document.querySelector('.fullHero__title, .soundTitle__title');
    if (h) title = (h.textContent || '').trim();
    const a = document.querySelector('.soundTitle__username, .fullHero__uploader a');
    if (a) artist = (a.textContent || '').trim();
  }
  if (!title) return null;
  return {
    url: location.origin + '/' + seg[0] + '/' + seg[1],
    title: title.slice(0, 140),
    artist: artist || seg[0],
    cover: pageCoverUrl() || '',
  };
}

function queueTrack(info) {
  if (!info || !info.url) return false;
  const s = senderInfo();
  scPost('playreq:' + JSON.stringify({
    title: info.title, artist: info.artist, cover: info.cover, url: info.url,
    name: s.name, avatar: s.avatar, color: accentInt(), length: '',
  }));
  return true;
}

// Drop a hover-reveal queue button on every track row, in whichever document we
// are handed — the new track page's related tracks live in the webi iframe, the
// feed/search/legacy rows live in the top frame.
// Track rows that get the per-row buttons. Search results are their own kind
// (.searchItem__trackItem): left out, they never had a Play in Discord button.
const HOQ_TRACK_ROWS = '[role="listitem"], .soundBadge, .trackItem, .soundList__item, .compactTrackListItem, .searchItem__trackItem';
function addQueueButtons(d) {
  let rows;
  try { rows = d.querySelectorAll(HOQ_TRACK_ROWS); } catch (e) { return; }
  rows.forEach((row) => {
    if (row.querySelector('.hoq-q')) return;
    let info = null;
    for (const a of row.querySelectorAll('a[href]')) {
      info = trackLinkInfo(a);
      if (info) break;
    }
    if (!info) return;
    const b = d.createElement('button');
    // In the tile's own action row (like / repost / share / … ) as one more of
    // SoundCloud's icon buttons, so it never sits over the title or date. Rows
    // without that toolbar get the small floating version.
    const group = row.querySelector('.soundActions .sc-button-group');
    b.className = group ? 'hoq-q hoq-q-in sc-button sc-button-secondary sc-button-small sc-button-icon sc-button-responsive' : 'hoq-q';
    b.type = 'button';
    b.title = 'Play in Discord';
    b.innerHTML = HOQ_Q_PLAY;
    if (group) {
      b.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (b.classList.contains('done')) return;
        if (queueTrack(info)) { b.classList.add('done'); b.innerHTML = HOQ_Q_CHECK; b.title = 'Queued in Discord'; _hoqLastRowBtn = b; }
      });
      group.insertBefore(b, group.querySelector('.sc-button-more') || null);
      return;
    }
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();   // don't let the row navigate / start playback
      if (b.classList.contains('done')) return;
      if (queueTrack(info)) { b.classList.add('done'); b.innerHTML = HOQ_Q_CHECK; b.title = 'Queued'; _hoqLastRowBtn = b; }
    });
    try { if (d.defaultView.getComputedStyle(row).position === 'static') row.style.position = 'relative'; } catch (e) {}
    row.appendChild(b);
  });
}

// The Discord actions belong beside the other now-playing actions, not floating
// over the page — as fixed FABs they parked on top of whatever sat bottom-right
// (the Reposts stat on the new track page). appendChild MOVES them, so their
// handlers survive. The player bar unmounts with playback and React re-renders
// it, so this re-mounts (and rebuilds, if React took the container with it).
function mountDiscordActions() {
  const host = document.querySelector('.playbackSoundBadge__actions');
  if (!host) return;
  if (!document.getElementById('hoq-playbtn')) { try { startPlayButton(); } catch (e) {} }
  if (!document.getElementById('hoq-share')) { try { startShareButton(); } catch (e) {} }
  for (const id of ['hoq-playbtn', 'hoq-share']) {
    const b = document.getElementById(id);
    if (!b) continue;
    if (b.parentElement !== host) host.appendChild(b);
    // Keep the tooltip in step with the button's own label (Share/Shared, …).
    const label = b.querySelector('span');
    if (label) b.title = label.textContent.trim();
  }
}

function startPlayButton() {
  if (document.getElementById('hoq-playbtn')) return;
  if (!document.getElementById('hoq-playbtn-style')) {
    const st = document.createElement('style');
    st.id = 'hoq-playbtn-style';
    st.textContent =
      // Lives in the player bar's action cluster, styled like SoundCloud's own
      // icon buttons there. Hidden while unmounted so it can never float loose.
      '#hoq-playbtn{display:none}' +
      '.playbackSoundBadge__actions #hoq-playbtn{display:inline-flex;align-items:center;justify-content:center;' +
      'width:30px;height:30px;margin-left:10px;padding:0;background:none;border:0;' +
      'border-radius:7px;cursor:pointer;color:#fff;flex:0 0 auto;' +
      'transition:color .15s ease,background .15s ease}' +
      '.playbackSoundBadge__actions #hoq-playbtn:hover{color:var(--sc-accent,#ff5500);background:rgba(255,255,255,0.09)}' +
      // Hairline before the pair so the Discord actions read as ours rather than
      // as two more of SoundCloud's own buttons.
      '.playbackSoundBadge__actions #hoq-playbtn{position:relative;margin-left:17px}' +
      '.playbackSoundBadge__actions #hoq-playbtn::before{content:"";position:absolute;left:-9px;' +
      'top:5px;bottom:5px;width:1px;background:rgba(255,255,255,0.15)}' +
      '.playbackSoundBadge__actions #hoq-playbtn svg{width:16px;height:16px;flex:0 0 auto}' +
      // The label becomes the tooltip once we're icon-only.
      '.playbackSoundBadge__actions #hoq-playbtn span{display:none}' +
      '.playbackSoundBadge__actions #hoq-playbtn.done{color:var(--sc-accent,#ff5500);cursor:default}' +
      '.playbackSoundBadge__actions #hoq-playbtn.done:hover{background:none}' +
      // Set by __hoqPlayResult when a request didn't reach Discord.
      '#hoq-playbtn.fail,.hoq-q.fail{color:#e5484d !important}';
    document.head.appendChild(st);
  }

  // the Discord mark (same as the track rows), so it never reads as a second play button
  const PLAY  = HOQ_Q_PLAY.slice(0, HOQ_Q_PLAY.indexOf('<span>'));
  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

  const btn = document.createElement('button');
  btn.id = 'hoq-playbtn';

  // Viewing a track wins over what's playing, so this queues the song on screen
  // rather than whatever happens to be loaded in the player.
  const songKey = () => {
    const pt = pageTrackInfo();
    if (pt) return pt.url;
    const h = hoqNowHref();
    if (h) return h;
    const np = currentNowPlaying();
    return np.title ? (np.title + '|' + np.artist) : '';
  };

  // Writes only when the state flips (see startShareButton).
  let painted = '';
  const paint = (html) => { if (html !== painted) { painted = html; btn.innerHTML = html; } };
  const refresh = () => {
    if (btn.dataset.msg) return;
    const k = songKey(), queued = !!(k && k === _hoqLastQueued);
    btn.classList.toggle('done', queued);
    paint((queued ? CHECK : PLAY) + '<span>' + (queued ? 'Queued' : 'Play in Discord') + '</span>');
  };
  const flash = (txt) => {
    btn.dataset.msg = '1';
    paint(PLAY + '<span>' + txt + '</span>');
    setTimeout(() => { delete btn.dataset.msg; refresh(); }, 1600);
  };

  btn.onclick = () => {
    const k = songKey();
    if (!k) { flash('Nothing playing'); return; }
    // On a track page, queue THAT track; elsewhere fall back to now-playing.
    const pt = pageTrackInfo();
    let payload;
    if (pt) {
      const s = senderInfo();
      payload = {
        title: pt.title, artist: pt.artist, cover: pt.cover, url: pt.url,
        name: s.name, avatar: s.avatar, color: accentInt(), length: '',
      };
    } else {
      payload = shareCurrentSong();
    }
    // The bot needs a real track link to resolve; a title alone is no use.
    if (!payload.url) { flash('No track link'); return; }
    if (k === _hoqLastQueued) return;   // one request per track
    _hoqLastRowBtn = null;              // this request is the bar's, not a row's
    scPost('playreq:' + JSON.stringify(payload));
    // Optimistic: __hoqPlayResult undoes this if the host reports a failure.
    _hoqLastQueued = k;
    refresh();
  };
  btn._hoqFlash = flash;   // __hoqPlayResult shows the failure reason through this

  document.body.appendChild(btn);
  refresh();
  clearInterval(window.__hoqPlayIv);   // one timer, whichever copy is current (see startShareButton)
  window.__hoqPlayIv = setInterval(refresh, 1000);   // re-enables when the track changes
}

// Links/images that came from other people (feed, friends): plain https only, so a
// javascript: or data: URL can never run here (this page can command the app).
function hoqSafeUrl(u) { const t = String(u == null ? '' : u).trim(); return /^https:\/\/[^\s"'<>\\]+$/i.test(t) ? t : ''; }
function hoqEsc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }

// The C# host delivers everyone's presence here → render the friends feed.
window.__hoqFriends = function (list) {
  const el = document.querySelector('.hoq-dc-friends');
  if (!el) return;
  const me = myId();
  const all = (Array.isArray(list) ? list : []).filter((f) => f.title);
  const others = all.filter((f) => f.id !== me);
  const mine = all.filter((f) => f.id === me);
  // Show your own row too. "No friends listening" on its own is indistinguishable
  // from the feed being broken; seeing yourself in it proves presence is live.
  const rows = others.concat(mine);
  if (!rows.length) {
    el.innerHTML = '<div class="hoq-dc-hint">Nobody is reporting right now — not even you. ' +
      'Presence only posts while a track is playing.</div>';
    return;
  }
  // Rebuilt from scratch every poll. This used to `+=` onto whatever was there,
  // so with anyone else listening the whole list stacked up again every 15 s.
  hoqFollowTick(others);
  const fol = window.__hoqFollow, jamS = hoqJamSess();
  el.innerHTML = (mine.length && !mine[0].name ? '<div class="hoq-dc-hint">Your name isn’t reaching friends: log in to SoundCloud, open Discord, or set a name in Settings.</div>' : '') + (fol ? '<div class="hoq-dc-follow"><span>Listening along with <b>' + hoqEsc(fol.name) + '</b></span><button type="button" class="hoq-dc-unfollow">Stop</button></div>' : '') +
    (others.length ? '' : '<div class="hoq-dc-hint">Only you are on right now.</div>') + rows.map((f) => '<div class="hoq-dc-friend' + (f.id === me ? ' is-me' : '') + '">' +
    '<img class="hoq-dc-fcover" src="' + (hoqEsc(hoqSafeUrl(f.cover)) || HOQ_LOGO) + '">' +
    '<div class="hoq-dc-ftext"><b>' + hoqEsc(f.name || 'Someone') +
    (f.id === me ? '<em class="hoq-me">you</em>' : '') + '</b>' +
    '<span>' + hoqEsc(f.title) + (f.artist ? ' · ' + hoqEsc(f.artist) : '') + '</span>' +
    (hoqSafeUrl(f.sc) ? '<a class="hoq-dc-sclink" data-url="' + hoqEsc(hoqSafeUrl(f.sc)) + '">' + hoqEsc(hoqSafeUrl(f.sc).replace(/^https?:\/\//, '')) + '</a>' : '') +
    '</div>' +
    // Hosting a jam: join it. Otherwise listen along (needs their track link from
    // the server; not while you're in a jam, which already decides what plays).
    (f.id !== me && f.jam ? '<button type="button" class="hoq-dc-along hoq-dc-jamjoin' + (jamS && jamS.code === f.jam ? ' on' : '') + '" data-code="' + hoqEsc(f.jam) + '">' + (jamS && jamS.code === f.jam ? 'In their jam' : 'Join jam') + '</button>'
      : f.id !== me && !jamS && hoqTrackPath(f.url) ? '<button type="button" class="hoq-dc-along' + (fol && fol.id === f.id ? ' on' : '') + '" data-id="' + hoqEsc(f.id) + '" data-name="' + hoqEsc(f.name || 'Someone') + '">' + (fol && fol.id === f.id ? 'Listening' : 'Listen along') + '</button>' : '') +
    '</div>').join('');
  el.querySelectorAll('.hoq-dc-sclink').forEach((a) => a.addEventListener('click', () => scPost('open:' + a.dataset.url)));
  el.querySelectorAll('.hoq-dc-jamjoin').forEach((b) => b.addEventListener('click', () => {
    const s = hoqJamSess();
    if (!s || s.code !== b.dataset.code) hoqJamJoin(b.dataset.code);
  }));
  el.querySelectorAll('.hoq-dc-along:not(.hoq-dc-jamjoin)').forEach((b) => b.addEventListener('click', () => {
    const f = others.find((x) => x.id === b.dataset.id);
    if (!f) return;
    if (window.__hoqFollow && window.__hoqFollow.id === f.id) hoqFollowStop(''); else hoqFollowStart(f);
    window.__hoqFriends(window.__hoqFriendsLast || list);
  }));
  const un = el.querySelector('.hoq-dc-unfollow');
  if (un) un.addEventListener('click', () => { hoqFollowStop(''); window.__hoqFriends(window.__hoqFriendsLast || list); });
  window.__hoqFriendsLast = list;
};

// ---- Listen along ------------------------------------------------------------
// Follow a friend: play what they're playing, where they are in it, and keep
// following their next songs (checked each time the friends list refreshes, every
// 15 s). Changing the track yourself, or them going quiet, stops it.
function hoqTrackPath(u) {
  const t = hoqSafeUrl(u);
  if (!t) return '';
  try { const x = new URL(t); return /(^|\.)soundcloud\.com$/i.test(x.hostname) && x.pathname.split('/').filter(Boolean).length >= 2 ? x.pathname : ''; } catch (e) { return ''; }
}
function hoqFriendPos(f) {
  if (typeof f.pos !== 'number') return 0;
  return f.pos + (f.paused ? 0 : Math.max(0, +f.age || 0) / 1000 * (+f.rate || 1));
}
function hoqFollowStart(f) {
  window.__hoqFollow = { id: f.id, name: f.name || 'Someone', path: '' };
  try { window.__hoqUpdate && window.__hoqUpdate('notice', 'Listening along with ' + (f.name || 'Someone'), 'Their songs play here as they change. Change the track yourself to stop.'); } catch (e) {}
  hoqFollowTick([f]);
}
function hoqFollowStop(why) {
  const f = window.__hoqFollow; window.__hoqFollow = null;
  if (f && why) { try { window.__hoqUpdate && window.__hoqUpdate('notice', 'Stopped listening along', why); } catch (e) {} }
}
function hoqFollowTick(list) {
  const fol = window.__hoqFollow;
  if (!fol) return;
  const f = (list || []).find((x) => x.id === fol.id);
  // Gone from the list: stop. (This used to skip the stop whenever exactly one
  // other person was on, so following carried on after they'd left.)
  if (!f) { if (list) hoqFollowStop(fol.name + ' stopped listening.'); return; }
  const path = hoqTrackPath(f.url);
  if (!path) return;
  const mine = (() => { try { const h = npPublicUrl('.playbackSoundBadge__titleLink'); return h ? new URL(h).pathname : ''; } catch (e) { return ''; } })();
  const same = (a, b) => decodeURIComponent(a || '').toLowerCase() === decodeURIComponent(b || '').toLowerCase();
  // we'd already put their song on, and now something else is playing that they
  // aren't on: you picked a different track yourself
  if (fol.path && same(fol.path, path) && mine && !same(mine, path) && Date.now() - (fol.at || 0) > 20000) {
    hoqFollowStop('You changed the track.'); return;
  }
  if (!same(mine, path)) {
    fol.path = path; fol.at = Date.now();
    hoqPfOpenAndPlay(path, hoqFriendPos(f));
    return;
  }
  fol.path = path;
  // same song: pull our position back in line if it drifted
  const m = hoqMediaNow(), want = hoqFriendPos(f);
  if (m && m.playing && typeof f.pos === 'number' && Math.abs(m.pos - want) > 6 && m.dur > 0 && want < m.dur - 3) {
    hoqSeek(want);
  }
}

// ---- Jam ---------------------------------------------------------------------
// A shared listening session, like Spotify's Jam (server: proxy/friends-server.js
// /jam/*, reached through the host app, so desktop only). The host's app plays;
// everyone who joined follows its track, play/pause and seeks. Anyone in the jam
// adds songs to a shared queue, which the host's app plays in order as songs end.
// Joined with a 6-character code, or from Friends listening.
const HOQ_JQ_ADD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg><span>Add to Jam</span>';
const HOQ_JQ_DONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg><span>In the jam</span>';
let _jam = null, _jamAt = 0;                  // the jam's latest state, and when it arrived
let _jamRid = 0, _jamMsg = null, _jamRejoinAt = 0;
const _jamWait = new Map();
let _jamHost = { sent: '', sentAt: 0, adv: '', playingAt: 0, pending: null };
let _jamGuest = { applied: null, following: true, at: 0, fixAt: 0 };

function hoqJamSess() { try { const s = JSON.parse(localStorage.getItem('hoqJam')); return s && s.code && s.key ? s : null; } catch (e) { return null; } }
function hoqJamSave(s) { try { if (s) localStorage.setItem('hoqJam', JSON.stringify(s)); else localStorage.removeItem('hoqJam'); } catch (e) {} }
const hoqJamAuth = (s) => ({ code: s.code, id: s.id, key: s.key });
function hoqJamMe() {
  const me = hoqMe();
  return { id: myId(), name: (localStorage.getItem('hoqDiscord') || '').trim() || me.name || 'Someone', sc: hoqSafeUrl(localStorage.getItem('hoqSC') || me.url || '') };
}
// What friends see on your row: the jam you host, unless you've closed it to the list.
function hoqJamAdvert() { const s = hoqJamSess(); return s && s.host && localStorage.getItem('hoqJamOpen') !== '0' ? s.code : ''; }
const hoqSamePath = (a, b) => { try { return decodeURIComponent(a || '').toLowerCase() === decodeURIComponent(b || '').toLowerCase(); } catch (e) { return a === b; } };
function hoqJamMyUrl() { try { const h = npPublicUrl('.playbackSoundBadge__titleLink'); return h ? h.split(/[?#]/)[0] : ''; } catch (e) { return ''; } }
// Where the host is in the song right now: their report, plus how old it is.
function hoqJamWant(n) {
  if (!n || typeof n.pos !== 'number') return 0;
  return n.paused ? n.pos : n.pos + ((+n.age || 0) + (Date.now() - _jamAt)) / 1000 * (+n.rate || 1);
}

function hoqJamCall(op, body) {
  return new Promise((resolve) => {
    if (!hoqHasHost()) return resolve({ status: 0, body: null });
    const rid = 'j' + (++_jamRid);
    _jamWait.set(rid, resolve);
    setTimeout(() => { if (_jamWait.delete(rid)) resolve({ status: 0, body: null }); }, 15000);
    scPost('jam:req:' + JSON.stringify({ rid, op, body }));
  });
}
window.__hoqJamRes = function (rid, status, body) {
  const done = _jamWait.get(rid);
  if (done) { _jamWait.delete(rid); done({ status, body }); }
};

function hoqJamNote(msg, toast) {
  _jamMsg = msg ? { text: msg, until: Date.now() + 7000 } : null;
  const el = document.querySelector('#hoq-discord .hoq-jam-msg');
  if (el) el.textContent = msg || '';
  if (toast && msg) { try { window.__hoqUpdate && window.__hoqUpdate('notice', msg, typeof toast === 'string' ? toast : ''); } catch (e) {} }
}

async function hoqJamStart() {
  const old = hoqJamSess();
  if (old) await hoqJamLeave();
  const r = await hoqJamCall('start', hoqJamMe());
  if (r.status !== 200 || !r.body || !r.body.code) {
    return hoqJamNote(r.status === 429 ? 'Too many jams started just now. Try again in a few minutes.' : 'Couldn’t start a jam. Check your connection.');
  }
  hoqJamBegin({ code: r.body.code, key: r.body.key, id: myId(), host: true }, r.body.state);
}
async function hoqJamJoin(code, quiet) {
  code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 6) { if (!quiet) hoqJamNote('A jam code is 6 letters and numbers.'); return; }
  const old = hoqJamSess();
  if (old && old.code !== code) await hoqJamLeave();
  const r = await hoqJamCall('join', Object.assign({ code }, hoqJamMe()));
  if (r.status !== 200 || !r.body || !r.body.key) {
    if (quiet) return hoqJamClear('The jam ended.', true);
    return hoqJamNote(r.status === 404 ? 'No jam with that code. It may have ended.' : r.status === 409 ? 'That jam is full.' : r.status === 429 ? 'Slow down a sec, then try again.' : 'Couldn’t join. Check your connection.');
  }
  const st = r.body.state;
  hoqJamBegin({ code: r.body.code, key: r.body.key, id: myId(), host: !!(st && st.host === myId()) }, st);
}
function hoqJamBegin(sess, state) {
  if (window.__hoqFollow) hoqFollowStop('');   // a jam takes over from listening along
  hoqJamSave(sess);
  _jam = state || null; _jamAt = Date.now();
  _jamHost = { sent: '', sentAt: 0, adv: '', playingAt: 0, pending: null };
  _jamGuest = { applied: null, following: true, at: 0, fixAt: 0 };
  scPost('jam:watch:' + JSON.stringify(hoqJamAuth(sess)));
  _lastRpc = '';   // friends see the jam on your row with the next presence update
  hoqJamRender();
  if (!sess.host) hoqJamFollow(true);
}
async function hoqJamLeave() {
  const s = hoqJamSess();
  if (!s) return;
  hoqJamClear('');
  await hoqJamCall(s.host ? 'end' : 'leave', hoqJamAuth(s));
}
function hoqJamClear(msg, toast) {
  hoqJamSave(null);
  _jam = null;
  scPost('jam:unwatch');
  _lastRpc = '';
  hoqJamRender();
  if (msg) hoqJamNote(msg, toast);
}

// The host app's long-poll hands every change here.
window.__hoqJam = function (st) {
  const s = hoqJamSess();
  if (!s || !st || typeof st !== 'object') return;
  if (st.ended) {
    // Dropped while the PC slept past the guest timeout: try to get back in. At most
    // once in 5 minutes: the same account in the jam on two PCs knocks the other
    // out with every join, and a rejoin each time kept them at it forever.
    if (st.why === 'removed' && Date.now() - _jamRejoinAt > 5 * 60 * 1000) { _jamRejoinAt = Date.now(); hoqJamJoin(s.code, true); return; }
    return hoqJamClear(st.why === 'removed' ? 'You were dropped from the jam.' : s.host ? 'Your jam ended.' : 'The jam ended.', true);
  }
  if (st.code !== s.code) return;
  _jam = st; _jamAt = Date.now();
  hoqJamRender();
  hoqJamFollow(false);
};

async function hoqJamAdd(info) {
  const s = hoqJamSess();
  if (!s || !info || !info.url) return false;
  const r = await hoqJamCall('add', Object.assign(hoqJamAuth(s), {
    track: { url: info.url, title: info.title, artist: info.artist, cover: info.cover, dur: info.dur || 0 },
  }));
  if (r.status === 200 && r.body && r.body.code) {
    _jam = r.body; _jamAt = Date.now();
    hoqJamNote('Added “' + info.title + '” to the jam.');
    hoqJamRender();
    return true;
  }
  hoqJamNote(r.status === 409 ? 'The jam’s queue is full.' : r.status === 400 ? 'That one can’t go in the jam (only public SoundCloud tracks).' : 'Couldn’t add that one. Check your connection.', true);
  return false;
}
async function hoqJamRemove(qid) {
  const s = hoqJamSess();
  if (!s) return;
  const r = await hoqJamCall('remove', Object.assign(hoqJamAuth(s), { qid }));
  if (r.status === 200 && r.body && r.body.code) { _jam = r.body; _jamAt = Date.now(); hoqJamRender(); }
}
function hoqJamNowInfo() {
  const np = currentNowPlaying(), url = hoqJamMyUrl();
  return np.title && url ? { url, title: np.title, artist: np.artist, cover: np.cover, dur: playerProgress().dur } : null;
}

// Host: start a song from the jam's queue for everyone.
function hoqJamPlay(item) {
  const s = hoqJamSess(), path = item && hoqTrackPath(item.url);
  if (!s || !s.host || !path) return;
  _jamHost.pending = { url: item.url, until: Date.now() + 15000 };
  _jamHost.sent = ''; _jamHost.adv = '';
  hoqPfOpenAndPlay(path, 0);
  hoqJamCall('now', Object.assign(hoqJamAuth(s), {
    qid: item.qid, now: { url: item.url, title: item.title, artist: item.artist, cover: item.cover, pos: 0, dur: item.dur || 0, paused: false, rate: 1 },
  }));
}

// Host, every second: tell the jam what's playing (on any change, and every 8 s),
// and as a song ends, start the next one from the queue.
function hoqJamHostTick(s) {
  const H = _jamHost, now = Date.now();
  const np = currentNowPlaying(), pr = playerProgress(), url = hoqJamMyUrl();
  if (!pr.paused) H.playingAt = now;
  if (pr.pos < 5) H.adv = '';
  // a queued song we just started: wait for it, or the old one would be reported back
  if (H.pending) {
    if (url && hoqSamePath(hoqTrackPath(url), hoqTrackPath(H.pending.url))) H.pending = null;
    else if (now < H.pending.until) return;
    else H.pending = null;
  }
  const q = (_jam && _jam.queue) || [];
  if (q.length && url && pr.dur > 0 && pr.pos >= pr.dur - 3 && now - H.playingAt < 5000 && H.adv !== url) {
    H.adv = url;
    return hoqJamPlay(q[0]);
  }
  let rate = 1;
  try { rate = hoqFxState().speed || 1; } catch (e) {}
  const sig = url && np.title ? [url, pr.paused, rate].join('|') : 'none';
  if (sig === H.sent && now - H.sentAt < 8000) return;
  H.sent = sig; H.sentAt = now;
  hoqJamCall('now', Object.assign(hoqJamAuth(s), {
    now: sig === 'none' ? null : { url, title: np.title, artist: np.artist, cover: np.cover, pos: pr.pos, dur: pr.dur, paused: pr.paused, rate },
  }));
}

// Guest: act on what the host changed (another song, play/pause, a seek), once
// per change, so pausing or adjusting on your side isn't fought every second.
function hoqJamFollow(force) {
  const s = hoqJamSess();
  if (!s || s.host || !_jam) return;
  const G = _jamGuest, n = _jam.now;
  if (force) { G.following = true; G.applied = null; }
  if (!G.following || !n || !n.url) return;
  const path = hoqTrackPath(n.url);
  if (!path) return;
  const want = hoqJamWant(n), anchor = Date.now() - want * 1000 / (+n.rate || 1);
  const mine = hoqJamMyUrl(), onIt = !!mine && hoqSamePath(hoqTrackPath(mine), path);
  const pr = playerProgress();
  let A = G.applied;
  if (!A || A.url !== n.url || (!A.open && !n.paused)) {
    if (!onIt) {
      if (n.paused) { G.applied = { url: n.url, paused: true, anchor, open: false }; return; }   // starts when they press play
      hoqPfOpenAndPlay(path, want); G.at = Date.now();
      G.applied = { url: n.url, paused: false, anchor, open: true };
      return;
    }
    // already on that song (joining, or back to the jam): line up play/pause and position
    A = { url: n.url, paused: pr.paused, anchor: Infinity, open: true };
  }
  if (!onIt) return;
  if (n.paused !== A.paused) {
    if (pr.paused !== n.paused) { const b = document.querySelector('.playControls__play'); if (b) b.click(); }
  } else if (!n.paused && Math.abs(anchor - A.anchor) > 5000) {
    const m = hoqMediaNow();   // the host jumped within the song
    if (m && m.playing && m.dur > 0 && want < m.dur - 3) hoqSeek(want);
  }
  G.applied = { url: n.url, paused: n.paused, anchor, open: true };
}

// Guest, every second: notice when you've gone off on your own, and pull a
// drifting position back in line now and then.
function hoqJamGuestTick() {
  const G = _jamGuest, A = G.applied;
  if (!G.following || !A || !A.open || !_jam || !_jam.now) return;
  if (Date.now() - G.at < 20000) return;   // we only just put this song on
  const mine = hoqJamMyUrl();
  // Off on your own for 8 s straight. Shorter, and your own autoplay at the end
  // of a song (before the host's next one lands) looked like leaving.
  if (mine && !hoqSamePath(hoqTrackPath(mine), hoqTrackPath(A.url))) {
    if (!G.offSince) G.offSince = Date.now();
    if (Date.now() - G.offSince > 8000) { G.following = false; G.offSince = 0; hoqJamRender(); }
    return;
  }
  G.offSince = 0;
  const n = _jam.now, m = hoqMediaNow();
  if (!mine || n.paused || !m || !m.playing || Date.now() - G.fixAt < 30000) return;
  const want = hoqJamWant(n);
  if (Math.abs(m.pos - want) > 8 && m.dur > 0 && want < m.dur - 3) { G.fixAt = Date.now(); hoqSeek(want); }
}

function hoqJamTick() {
  const s = hoqJamSess();
  if (!s || !_jam) return;
  if (s.host) hoqJamHostTick(s); else hoqJamGuestTick();
}

// The Jam card in Social. `root`: the panel while it's still being built (not in
// the page yet, so a page-wide lookup finds nothing).
function hoqJamRender(root) {
  const box = (root || document).querySelector('.hoq-jam-sec .hoq-jam');
  if (!box) return;
  const s = hoqJamSess();
  const msg = _jamMsg && Date.now() < _jamMsg.until ? _jamMsg.text : '';
  if (!s) {
    if (!box.querySelector('.hoq-jam-idle')) {
      box.innerHTML = '<div class="hoq-jam-idle">' +
        '<div class="hoq-jam-pitch">Listen together, like Spotify’s Jam. Everyone who joins hears what you play, and anyone in it can add songs to the queue.</div>' +
        '<div class="hoq-jam-row"><button type="button" class="hoq-pair-btn hoq-jam-start">Start a jam</button>' +
        '<span class="hoq-jam-or">or join one</span><input class="hoq-jam-input" maxlength="7" placeholder="CODE" spellcheck="false" autocomplete="off">' +
        '<button type="button" class="hoq-pair-linkbtn hoq-jam-join">Join</button></div>' +
        '<div class="hoq-dc-hint hoq-jam-msg"></div></div>';
      const inp = box.querySelector('.hoq-jam-input');
      box.querySelector('.hoq-jam-start').addEventListener('click', () => hoqJamStart());
      box.querySelector('.hoq-jam-join').addEventListener('click', () => hoqJamJoin(inp.value));
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') hoqJamJoin(inp.value); });
    }
    box.querySelector('.hoq-jam-msg').textContent = msg;
    return;
  }
  if (!_jam) {
    box.innerHTML = '<div class="hoq-jam-head"><div class="hoq-jam-code">' + hoqEsc(s.code) + '</div><div class="hoq-jam-meta"><b>Jam</b><span>Connecting…</span></div>' +
      '<div class="hoq-jam-btns"><button type="button" class="hoq-pair-linkbtn hoq-jam-leave">' + (s.host ? 'End jam' : 'Leave') + '</button></div></div>';
    box.querySelector('.hoq-jam-leave').addEventListener('click', () => hoqJamLeave());
    return;
  }
  const me = myId(), J = _jam, members = J.members || [], queue = J.queue || [], n = J.now;
  const hostM = members.find((m) => m.host) || { name: 'Someone' };
  const others = members.length - 1;
  let status;
  if (s.host) status = others ? (others === 1 ? '1 person is listening with you' : others + ' people are listening with you') : 'Share the code, friends join with it';
  else if ((+J.hostAge || 0) > 45000) status = hoqEsc(hostM.name) + ' hasn’t been heard from in a bit…';
  else if (!_jamGuest.following) status = 'You’re playing something else. <button type="button" class="hoq-jam-back">Back to the jam</button>';
  else status = n ? (n.paused ? hoqEsc(hostM.name) + ' paused' : 'Listening with ' + hoqEsc(hostM.name)) : 'Waiting for ' + hoqEsc(hostM.name) + ' to play something';
  const cover = (u) => hoqEsc(hoqSafeUrl(u)) || HOQ_LOGO;
  const nowRow = n ? '<div class="hoq-dc-friend hoq-jam-now"><img class="hoq-dc-fcover" src="' + cover(n.cover) + '"><div class="hoq-dc-ftext"><b>' + hoqEsc(n.title) + '</b><span>' +
    hoqEsc(n.artist) + '</span></div><span class="hoq-jam-tag">' + (n.paused ? 'Paused' : 'Now playing') + '</span></div>' : '';
  const qRow = (q) => '<div class="hoq-dc-friend hoq-jam-item"><img class="hoq-dc-fcover" src="' + cover(q.cover) + '"><div class="hoq-dc-ftext"><b>' + hoqEsc(q.title) + '</b><span>' +
    hoqEsc(q.artist) + ' · added by ' + (q.byId === me ? 'you' : hoqEsc(q.by)) + '</span></div>' +
    (s.host ? '<button type="button" class="hoq-dc-along hoq-jam-playq" data-qid="' + (+q.qid) + '">Play now</button>' : '') +
    (s.host || q.byId === me ? '<button type="button" class="hoq-jam-x" data-qid="' + (+q.qid) + '" title="Take it out">×</button>' : '') + '</div>';
  const page = pageTrackInfo(), mineNow = hoqJamNowInfo();
  box.innerHTML =
    '<div class="hoq-jam-head"><div class="hoq-jam-code" title="Friends join with this code">' + hoqEsc(J.code) + '</div>' +
    '<div class="hoq-jam-meta"><b>' + (s.host ? 'Your jam' : hoqEsc(hostM.name) + '’s jam') + '</b><span>' + status + '</span></div>' +
    '<div class="hoq-jam-btns"><button type="button" class="hoq-pair-linkbtn hoq-jam-copy">Copy invite</button>' +
    '<button type="button" class="hoq-pair-linkbtn hoq-jam-leave">' + (s.host ? 'End jam' : 'Leave') + '</button></div></div>' +
    '<div class="hoq-jam-people">' + members.map((m) => '<span class="hoq-jam-chip">' + hoqEsc(m.id === me ? 'You' : m.name) + (m.host ? '<em>host</em>' : '') + '</span>').join('') + '</div>' +
    nowRow +
    '<div class="hoq-jam-sub"><span>Up next</span>' + (s.host && queue.length ? '<button type="button" class="hoq-jam-skip">Play next now</button>' : '') + '</div>' +
    '<div class="hoq-jam-q">' + (queue.length ? queue.map(qRow).join('') : '<div class="hoq-dc-hint">Nothing queued yet. Hit + on any track, or right-click it, to add it here.</div>') + '</div>' +
    '<div class="hoq-jam-add">' + (mineNow ? '<button type="button" class="hoq-pair-linkbtn hoq-jam-addnow">+ Add what’s playing</button>' : '') +
    (page && (!mineNow || page.url !== mineNow.url) ? '<button type="button" class="hoq-pair-linkbtn hoq-jam-addpage">+ Add this page’s track</button>' : '') + '</div>' +
    (s.host ? '<label class="hoq-jam-open"><input type="checkbox"' + (localStorage.getItem('hoqJamOpen') !== '0' ? ' checked' : '') + '>Friends can join from Friends listening</label>' : '') +
    '<div class="hoq-dc-hint hoq-jam-msg">' + hoqEsc(msg) + '</div>';
  const on = (sel, fn) => box.querySelectorAll(sel).forEach((b) => b.addEventListener('click', fn));
  on('.hoq-jam-copy', () => { hoqCopy('Join my jam on holdonquietly: Social, then Jam, code ' + J.code); hoqJamNote('Invite copied. Send it to your friends.'); });
  on('.hoq-jam-leave', () => hoqJamLeave());
  on('.hoq-jam-skip', () => { if (queue[0]) hoqJamPlay(queue[0]); });
  on('.hoq-jam-playq', (e) => { const q = queue.find((x) => x.qid === +e.currentTarget.dataset.qid); if (q) hoqJamPlay(q); });
  on('.hoq-jam-x', (e) => hoqJamRemove(+e.currentTarget.dataset.qid));
  on('.hoq-jam-addnow', () => hoqJamAdd(hoqJamNowInfo()));
  on('.hoq-jam-addpage', () => hoqJamAdd(pageTrackInfo()));
  on('.hoq-jam-back', () => { hoqJamFollow(true); hoqJamRender(); });
  const open = box.querySelector('.hoq-jam-open input');
  if (open) open.addEventListener('change', () => { try { localStorage.setItem('hoqJamOpen', open.checked ? '1' : '0'); } catch (e) {} _lastRpc = ''; });
}

// "+" on every track row while you're in a jam (gone again when you aren't).
function addJamButtons(d) {
  if (!hoqJamSess()) { d.querySelectorAll('.hoq-jq').forEach((b) => b.remove()); return; }
  let rows;
  try { rows = d.querySelectorAll(HOQ_TRACK_ROWS); } catch (e) { return; }
  rows.forEach((row) => {
    if (row.querySelector('.hoq-jq')) return;
    let info = null;
    for (const a of row.querySelectorAll('a[href]')) { info = trackLinkInfo(a); if (info) break; }
    if (!info) return;
    const b = d.createElement('button');
    const group = row.querySelector('.soundActions .sc-button-group');
    b.className = group ? 'hoq-jq hoq-jq-in sc-button sc-button-secondary sc-button-small sc-button-icon sc-button-responsive' : 'hoq-jq';
    b.type = 'button';
    b.title = 'Add to Jam';
    b.innerHTML = HOQ_JQ_ADD;
    b.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();   // don't let the row navigate or start playing
      if (b.classList.contains('done')) return;
      b.classList.add('done');
      if (await hoqJamAdd(info)) { b.innerHTML = HOQ_JQ_DONE; b.title = 'In the jam'; } else b.classList.remove('done');
    });
    if (group) { group.insertBefore(b, group.querySelector('.hoq-q') || group.querySelector('.sc-button-more') || null); return; }
    try { if (d.defaultView.getComputedStyle(row).position === 'static') row.style.position = 'relative'; } catch (e) {}
    row.appendChild(b);
  });
}

// ---------------------------------------------------------------------------
// Spotify-style horizontal volume slider (0-100), replacing SoundCloud's
// vertical hover popup. Drives every media element's volume directly.
// ---------------------------------------------------------------------------
function updateVolFill(sl) {
  sl.style.background = 'linear-gradient(to right, var(--sc-accent, #ff5500) ' +
    sl.value + '%, rgba(255,255,255,0.22) ' + sl.value + '%)';
}
function buildVolume() {
  const v = document.querySelector('.volume');
  if (!v || v.querySelector('.hoq-vol')) return;
  const sl = document.createElement('input');
  sl.type = 'range'; sl.className = 'hoq-vol'; sl.min = '0'; sl.max = '100'; sl.step = '1';
  sl.value = String(Math.round((window.__scGetVolume ? window.__scGetVolume() : 1) * 100));

  // Live percent readout — always visible, updates as you move (no hover needed).
  const pct = document.createElement('span');
  pct.className = 'hoq-vol-pct';
  pct.textContent = sl.value + '%';

  // Popup that appears from the speaker icon; holds the slider + live percent.
  const pop = document.createElement('div');
  pop.className = 'hoq-vol-pop';
  pop.appendChild(sl);
  pop.appendChild(pct);

  const apply = () => {
    if (window.__scSetVolume) window.__scSetVolume(sl.value / 100);
    pct.textContent = sl.value + '%';
    updateVolFill(sl);
  };
  updateVolFill(sl);
  sl.addEventListener('input', apply);

  // Keep the popup open while dragging even if the cursor slips out of the icon.
  sl.addEventListener('pointerdown', () => pop.classList.add('hoq-show'));
  window.addEventListener('pointerup', () => pop.classList.remove('hoq-show'));

  // Scroll anywhere over the volume control (icon or popup) to nudge it, and
  // briefly flash the popup so you can see the %.
  let hideT;
  const flash = () => { pop.classList.add('hoq-show'); clearTimeout(hideT); hideT = setTimeout(() => pop.classList.remove('hoq-show'), 1000); };
  const wheel = (e) => {
    e.preventDefault();
    sl.value = String(Math.max(0, Math.min(100, +sl.value + (e.deltaY < 0 ? 3 : -3))));
    apply();
    flash();
  };
  v.addEventListener('wheel', wheel, { passive: false });

  // Grace period so the popup doesn't vanish the instant the cursor leaves the
  // icon on its way up to the slider (pure CSS :hover was too twitchy).
  let leaveT;
  const showPop = () => { clearTimeout(leaveT); pop.classList.add('hoq-show'); };
  const hidePop = () => { clearTimeout(leaveT); leaveT = setTimeout(() => pop.classList.remove('hoq-show'), 550); };
  v.addEventListener('mouseenter', showPop);
  v.addEventListener('mouseleave', hidePop);
  pop.addEventListener('mouseenter', showPop);
  pop.addEventListener('mouseleave', hidePop);

  v.appendChild(pop);
}

// ---------------------------------------------------------------------------
// Text/DOM fallbacks for clutter whose class names are randomized
// ---------------------------------------------------------------------------
function removeClutter() {
  try { buildDiscordTab(); } catch (e) {}
  try { setupOutputPicker(); } catch (e) {}
  try { setupEqPicker(); } catch (e) {}
  try { setupMiniMode(); } catch (e) {}
  try { setupUpdateBtn(); } catch (e) {}
  try { setupProfileExtras(); } catch (e) {}
  try { buildVolume(); } catch (e) {}
  try { moveFans(); } catch (e) {}
  document.documentElement.classList.toggle('hoq-feed', /\/feed/i.test(location.pathname));
  // GO MOBILE heading
  document
    .querySelectorAll('h1,h2,h3,h4,.sidebarHeader__title,.sc-type-h5')
    .forEach((h) => {
      const t = (h.textContent || '').trim().toLowerCase();
      if (t === 'go mobile' || t === 'get the app') {
        const box = h.closest('.sidebarModule, section') || h.parentElement;
        if (box) box.style.display = 'none';
      }
    });
  // Footer legal links
  const legal = Array.from(document.querySelectorAll('a')).find(
    (a) => (a.textContent || '').trim().toLowerCase() === 'legal'
  );
  if (legal) {
    const foot = legal.closest('footer, .footer, nav, ul') || legal.parentElement;
    if (foot) foot.style.display = 'none';
  }

  // Run each removal isolated so one failure can't stop the others.
  const safe = (fn) => { try { fn(); } catch (e) {} };
  // Structural containers we must NEVER hide (hiding these breaks whole pages,
  // e.g. the profile header lives in an .l-container).
  const STRUCT_SEL =
    '.l-container, .l-content, #content, main, .header, .l-fixed-top, ' +
    '.l-listen-wrapper, .l-about, .l-user, .userInfoBar, ' +
    '.l-user-hero, .profileHeader, .profileHeaderBackground, .profileHeaderInfo';
  const isStruct = (el) => !!(el && el.matches && el.matches(STRUCT_SEL));
  // A user's own "Artist Pro" / "Next Pro" BADGE is not an upsell. The text
  // match below used to hit it and climb up to the profile header's name block
  // (name, city, badge all gone). Never hide anything that is, sits inside, or
  // holds a profile header / creator badge / user card.
  const PROTECT_IN = '.l-user-hero, .profileHeader, .creatorBadge, .sc-status-label, .userBadge, .userBadgeListItem, .soundTitle, .userInfoBar';
  const PROTECT_HAS = '.creatorBadge, .sc-status-label, .profileHeaderInfo__userName, .userBadge__usernameLink';
  const isProtected = (el) => !!(el.closest(PROTECT_IN) || el.querySelector(PROTECT_HAS));
  // undo earlier hides that hit protected things
  document.querySelectorAll('[data-schid]').forEach((el) => {
    if (isProtected(el)) { el.style.display = ''; el.removeAttribute('data-schid'); }
  });
  // Hide + tag so diagnostics can tell OUR hides from SoundCloud's own.
  const kill = (el) => {
    if (!el || isStruct(el) || isProtected(el)) return;
    el.style.display = 'none';
    el.setAttribute('data-schid', '1');
  };

  // Repaint leftover SoundCloud-orange badges/dots/text to the accent color.
  safe(recolorOrange);

  // 0) Kill embedded-module + ad IFRAMES (Artist Tools = the "credit-tracker"
  //    iframe; ad banners = velvetcake / google). Our code can't reach inside a
  //    cross-origin iframe, but we CAN hide the iframe element + its wrapper.
  safe(() => {
    // NOTE: velvetcake/banner? is the PROFILE HEADER banner — never block it.
    const KILL_FRAMES = [
      'credit-tracker', 'adtrafficquality',
      'googlesyndication', 'doubleclick', '/promoted',
    ];
    document.querySelectorAll('iframe').forEach((f) => {
      const src = f.src || '';
      if (!KILL_FRAMES.some((k) => src.includes(k))) return;
      // Climb up through wrappers that exist only to hold this iframe.
      let n = f;
      while (
        n.parentElement &&
        n.parentElement !== document.body &&
        n.parentElement.children.length === 1
      ) {
        n = n.parentElement;
      }
      kill(n);
      kill(f);
    });
  });

  // Leaf-ish elements whose trimmed text includes any phrase (<= maxLen chars).
  const findByText = (phrases, maxLen) =>
    Array.from(
      document.querySelectorAll('a,button,span,strong,div,h1,h2,h3,h4,li,p')
    ).filter((el) => {
      const t = (el.textContent || '').trim().toLowerCase();
      return t && t.length <= maxLen && phrases.some((p) => t.includes(p));
    });

  // Climb up while the container stays "just this thing" (text stays short),
  // so we hide the whole banner/module box without swallowing the sidebar.
  const hideBox = (el, limit) => {
    let n = el;
    for (let i = 0; i < 6 && n.parentElement; i++) {
      const p = n.parentElement;
      if (p === document.body || isStruct(p)) break; // never climb into page structure
      if ((p.textContent || '').trim().length > limit) break;
      n = p;
    }
    kill(n);
  };

  // 1) ARTIST TOOLS module (label shares its row with an "in 15 days" pill, so
  //    match by "includes" then climb until the block also contains the tools).
  safe(() => {
    const label = findByText(['artist tools', 'artist shortcuts'], 30)[0];
    if (!label) return;
    let n = label;
    for (let i = 0; i < 9 && n.parentElement; i++) {
      n = n.parentElement;
      const tt = (n.textContent || '').toLowerCase();
      if (tt.includes('distribute') && tt.includes('master')) {
        kill(n);
        return;
      }
    }
    hideBox(label, 80); // fallback
  });

  // 2) Artist Pro / upgrade / creator upsell banners (sidebar + inline).
  safe(() => {
    findByText(
      ['artist pro', 'go pro', 'upgrade now', 'fuel your growth',
       'creator benefits', 'get unlimited access', 'unlimited access with',
       'climb the leaderboard', 'complete the steps'],
      90
    ).forEach((el) => hideBox(el, 160));
  });

  // 3) Full-width promo/notification bars near the very top (incl. their X),
  //    and any empty leftover bar with just a close button.
  safe(() => {
    document.querySelectorAll('div,section,aside').forEach((el) => {
      if (el.id === 'sc-titlebar') return;
      const r = el.getBoundingClientRect();
      if (r.top > 150 || r.width < window.innerWidth * 0.5) return;
      if (r.height < 20 || r.height > 130) return;
      if (el.querySelector('input')) return; // never touch the search bar
      const hasClose = el.querySelector(
        'button[aria-label*="lose" i], [title*="lose" i], .g-icon-close, .close'
      );
      if (!hasClose) return;
      const txt = (el.textContent || '').replace(/\s/g, '').toLowerCase();
      const isPromo = /upgrade|artistpro|fuelyourgrowth|get\$|creatorbenefits|unlimited/.test(txt);
      if (isPromo) kill(el); // only clear promo bars, never blank ones
    });
  });

  // 5) Onboarding coachmark bubbles ("Tap the heart…", "OK, got it").
  safe(() => {
    const btn = Array.from(document.querySelectorAll('button, a')).find((b) => {
      const t = (b.textContent || '').trim().toLowerCase();
      return t === 'ok, got it' || t === 'got it' || t === 'ok got it';
    });
    if (btn) hideBox(btn, 160);
    findByText(['tap the heart', 'tap the button to'], 90).forEach((el) => hideBox(el, 160));
  });

  // 6) "Connect with artists in your scene" collaborator-promo module.
  safe(() => {
    const label = findByText(
      ['connect with artists in your scene', 'exchange feedback and find'], 60
    )[0];
    if (!label) return;
    let n = label;
    for (let i = 0; i < 7 && n.parentElement; i++) {
      n = n.parentElement;
      if (/module|section|lazyLoad|lazyLoadingList/i.test(n.className || '')) {
        kill(n);
        return;
      }
    }
    hideBox(label, 200);
  });

  // 4) Header promo links: "Get $15", "Artist Studio", "Go Pro".
  safe(() => {
    document
      .querySelectorAll('.header a, .header button, header a, header button, nav a')
      .forEach((a) => {
        const t = (a.textContent || '').trim().toLowerCase();
        if (t.startsWith('get $') || t === 'artist studio' || t === 'go pro' || t === 'try artist pro') {
          kill(a);
        }
      });
  });
  // Push SoundCloud's fixed top bar below our titlebar so nothing (e.g. the
  // Upload button) tucks under it. Detect ANY fixed, full-width, top-anchored
  // bar — not just .header — but never our own injected UI.
  safe(() => {
    document.querySelectorAll('header, nav, div').forEach((el) => {
      // (our own UI too: the compact player's Bar/Name layouts are exactly a
      // short full-width fixed bar and got shoved 34px down)
      if (el.closest('#sc-titlebar, #sc-palette, #sc-ad-badge, [id^="hoq-"]')) return;
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed') return;
      const r = el.getBoundingClientRect();
      if (r.top < TITLEBAR_H && r.width > window.innerWidth * 0.8 &&
          r.height > 30 && r.height < 90) {
        el.style.top = TITLEBAR_H + 'px';
      }
    });
  });
}

// ---------------------------------------------------------------------------
// 3D tilt: home tiles lean toward the cursor for a "3D site" feel.
// Event-delegated (tiles load lazily) + only on the home/discover pages.
// ---------------------------------------------------------------------------
// Ctrl+Shift+C forwards to the host, which opens the real DevTools and turns on
// its element inspector (Overlay.setInspectMode) so hover/click selects nodes in
// the Elements panel. (Ctrl+Shift+E was dropped — it's AMD ReLive's record key.)
function setupInspectKey() {
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && !e.altKey && (e.key === 'C' || e.key === 'c')) {
      e.preventDefault(); e.stopPropagation(); scPost('inspect');
    }
  }, true);
}

// Header "play SoundCloud out of <device>" picker. Routes the whole app's audio
// to a chosen output (e.g. your headphones) via setSinkId on SoundCloud's own
// AudioContext — independent of the Windows default device. Listing devices by
// name needs a one-time audio permission (a Chromium rule); the mic stream is
// requested only to unlock the labels and stopped immediately, never read.
function setupOutputPicker() {
  const supported = !!(window.AudioContext && window.AudioContext.prototype &&
    typeof window.AudioContext.prototype.setSinkId === 'function');
  if (!supported) return;                                   // no sink switching here
  if (document.documentElement.classList.contains('hoq-mobile')) return; // phones route at the OS level
  if (document.getElementById('hoq-out-btn')) return;       // idempotent

  const nav = document.querySelector('.header__userNav');
  const anchor = nav || document.querySelector('.header__right');
  if (!anchor) return;                                      // header not ready yet — caller retries

  if (!document.getElementById('hoq-out-css')) {
    const st = document.createElement('style');
    st.id = 'hoq-out-css';
    st.textContent = `
      /* Sized + coloured to match SoundCloud's own header icons (notifications /
         messages): 38x46, rgb(153,153,153), 22px glyph, recolour-only on hover
         (no hover box), so it reads as native. Accent when a device is pinned. */
      #hoq-out-btn { display:inline-flex; align-items:center; justify-content:center;
        width:38px; height:46px; margin:0; padding:0; border:0;
        background:transparent; color:rgb(153,153,153); cursor:pointer;
        transition:color .14s ease; }
      #hoq-out-btn:hover { color:#fff; }
      #hoq-out-btn.on { color:var(--sc-accent,#ff5500); }
      #hoq-out-btn svg { width:22px; height:22px; }
      #hoq-out-menu { position:fixed; z-index:2147483000; width:310px; max-height:calc(100vh - 80px); overflow-y:auto;
        padding:6px; border-radius:14px; box-sizing:border-box;
        background:rgba(12,12,16,0.78); border:1px solid rgba(255,255,255,0.09);
        box-shadow:0 18px 52px rgba(0,0,0,0.55);
        backdrop-filter:blur(24px) saturate(1.5); -webkit-backdrop-filter:blur(24px) saturate(1.5);
        color:#e7e7ed; font-family:Inter,-apple-system,Arial,sans-serif;
        opacity:0; transform:translateY(-6px) scale(.98); pointer-events:none;
        transition:opacity .13s ease, transform .13s ease; }
      #hoq-out-menu.show { opacity:1; transform:none; pointer-events:auto; }
      #hoq-out-menu button { font-family:inherit; }
      .hoq-out-head { padding:8px 10px 8px; font-size:13px; font-weight:600; color:#ececf1; }
      .hoq-out-group { padding:10px 10px 4px; font-size:11px; font-weight:500; color:#7d7d88; }
      .hoq-out-sep { height:1px; margin:4px 6px; background:rgba(255,255,255,0.07); }
      .hoq-out-item { display:flex; align-items:center; gap:10px; width:100%; box-sizing:border-box; min-height:44px;
        padding:6px 10px 6px 7px; border:0; border-radius:9px; background:transparent; color:#e2e2e8;
        text-align:left; cursor:pointer; transition:background .12s ease; }
      .hoq-out-item:hover { background:rgba(255,255,255,0.06); }
      .hoq-out-ic { flex:0 0 30px; width:30px; height:30px; border-radius:8px; display:grid; place-items:center;
        background:rgba(255,255,255,0.06); color:#a6a6b0; transition:background .12s ease, color .12s ease; }
      .hoq-out-ic svg { width:16px; height:16px; }
      .hoq-out-txt { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:1px; }
      .hoq-out-txt b, .hoq-out-txt small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .hoq-out-txt b { font-size:13px; font-weight:500; color:#ececf1; }
      .hoq-out-txt small { font-size:11px; color:#7d7d88; }
      .hoq-out-item .tick { width:14px; height:14px; flex:0 0 14px; color:var(--sc-accent,#ff5500); opacity:0; }
      .hoq-out-item.sel { background:color-mix(in srgb, var(--sc-accent,#ff5500) 13%, transparent); }
      .hoq-out-item.sel .tick { opacity:1; }
      .hoq-out-item.sel .hoq-out-txt b { color:#fff; font-weight:600; }
      .hoq-out-item.sel .hoq-out-ic { background:color-mix(in srgb, var(--sc-accent,#ff5500) 22%, transparent); color:var(--sc-accent,#ff5500); }
      .hoq-out-locked { padding:6px 10px 4px; }
      .hoq-out-enable { display:inline-flex; align-items:center; height:30px; padding:0 13px; border:0; border-radius:8px;
        cursor:pointer; font-size:12.5px; font-weight:600; color:#fff; background:var(--sc-accent,#ff5500); }
      .hoq-out-note { padding:8px 10px 6px; font-size:11px; line-height:1.45; color:#7d7d88; }
      .hoq-out-msg { padding:6px 10px 4px; font-size:11.5px; color:color-mix(in srgb, var(--sc-accent,#ff5500) 60%, #fff); }
      .hoq-out-msg:empty { display:none; }
      html.hoq-lowend #hoq-out-menu, html.hoq-no-frost #hoq-out-menu {
        background:rgba(16,16,20,0.98); backdrop-filter:none; -webkit-backdrop-filter:none; }
    `;
    (document.head || document.documentElement).appendChild(st);
  }

  const TICK = '<svg class="tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

  const btn = document.createElement('button');
  btn.id = 'hoq-out-btn';
  btn.type = 'button';
  btn.title = 'Audio output device';
  btn.setAttribute('aria-label', 'Choose audio output device');
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14v-3a8 8 0 0 1 16 0v3"/><rect x="2.5" y="13.5" width="4" height="6.5" rx="1.6"/><rect x="17.5" y="13.5" width="4" height="6.5" rx="1.6"/></svg>';
  // Group it with SoundCloud's own header icons (notifications / messages) so it
  // reads as native. Falls back to the right cluster if the nav shape changes.
  const beforeIcon = nav && (nav.querySelector('.header__userNavActivitiesButton') ||
                             nav.querySelector('.header__userNavItem'));
  if (nav && beforeIcon) nav.insertBefore(btn, beforeIcon);
  else anchor.insertBefore(btn, anchor.firstChild);

  let menu = document.getElementById('hoq-out-menu');
  if (!menu) { menu = document.createElement('div'); menu.id = 'hoq-out-menu'; document.body.appendChild(menu); }

  const reflectBtn = () => { btn.classList.toggle('on', !!(window.__hoqSinkId)); };
  reflectBtn();

  const msg = (t) => {
    let m = menu.querySelector('.hoq-out-msg');
    if (!m) { m = document.createElement('div'); m.className = 'hoq-out-msg'; menu.appendChild(m); }
    m.textContent = t || '';
  };

  const select = async (id, label) => {
    window.__hoqSinkId = id || '';
    try { localStorage.setItem('hoqSinkId', window.__hoqSinkId); } catch (e) {}
    reflectBtn();
    const hadCtx = !!window.__hoqSCAC;
    const ok = await window.__hoqApplySink();
    if (id && hadCtx && !ok) {
      // The device is gone or refused — don't leave the app silently misrouted.
      window.__hoqSinkId = ''; try { localStorage.setItem('hoqSinkId', ''); } catch (e) {}
      await window.__hoqApplySink(); reflectBtn(); render(); msg('Could not switch to ' + (label || 'that device') + '.');
      return;
    }
    render();
    msg(id && !hadCtx ? 'Set — starts when you play a track.' : '');
    if (ok || !id) setTimeout(close, 650);
  };

  const unlock = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());          // labels are unlocked now; drop the stream
      await render();
    } catch (e) { msg('Audio permission is needed to list device names.'); }
  };

  // "Speakers (2- Focusrite USB Audio)" -> { name: 'Speakers', sub: 'Focusrite USB Audio' }
  const splitLabel = (label) => {
    const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(label || '');
    const name = (m ? m[1] : label || '').trim(), sub = m ? m[2].replace(/^\d+\s*-\s*/, '').trim() : '';
    return name ? { name, sub } : { name: sub || label || 'Device', sub: '' };
  };
  const IC = {
    speaker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2.5" width="14" height="19" rx="2.5"/><circle cx="12" cy="14.5" r="3.5"/><circle cx="12" cy="7" r="1"/></svg>',
    display: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="12.5" rx="2"/><path d="M8.5 20.5h7M12 16.5v4"/></svg>',
    phones: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="2.5" y="14" width="4.5" height="7" rx="1.8"/><rect x="17" y="14" width="4.5" height="7" rx="1.8"/></svg>',
    virtual: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7V3M15 7V3"/><path d="M6.5 7h11v4a5.5 5.5 0 0 1-11 0z"/><path d="M12 16.5V21"/></svg>',
    system: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M7 20h10"/><path d="M9.5 10.5 11.5 12.5 15 8.5"/></svg>',
  };
  const kindOf = (label) => {
    if (/VB-Audio|Virtual|\bCABLE\b|Voicemeeter|Steam Streaming|NVIDIA Broadcast|Voicemod|SteelSeries Sonar/i.test(label)) return 'virtual';
    if (/High Definition Audio Device|HDMI|DisplayPort|Display Audio|NVIDIA High Definition|Intel.*Display/i.test(label)) return 'display';
    if (/head(phone|set)|earbuds?|airpods|buds|arctis|hyperx|wh-1000|bluetooth/i.test(label)) return 'phones';
    return 'speaker';
  };

  async function render() {
    let outs = [];
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      outs = devs.filter((d) => d.kind === 'audiooutput');
    } catch (e) {}
    // Labels are blank until an audio permission is granted once.
    const named = outs.filter((d) => d.deviceId && d.label);
    const locked = named.length === 0;
    const cur = window.__hoqSinkId || '';
    // "default" / "communications" are Windows aliases of real devices: show the
    // default's name under "System default" and drop the duplicates.
    const defDev = named.find((d) => d.deviceId === 'default');
    const defLbl = defDev ? splitLabel(defDev.label.replace(/^Default\s*-\s*/i, '')) : null;
    const real = named.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications');

    const row = (id, kind, name, sub) =>
      `<button class="hoq-out-item${(cur === id) ? ' sel' : ''}" data-id="${id.replace(/"/g, '&quot;')}" title="${hoqEsc(sub ? name + ' (' + sub + ')' : name)}">` +
      `<span class="hoq-out-ic">${IC[kind]}</span><span class="hoq-out-txt"><b>${hoqEsc(name)}</b>${sub ? '<small>' + hoqEsc(sub) + '</small>' : ''}</span>${TICK}</button>`;
    let html = '<div class="hoq-out-head">Play SoundCloud out of</div>';
    html += row('', 'system', 'System default', defLbl ? 'Now: ' + defLbl.name + (defLbl.sub ? ' · ' + defLbl.sub : '') : 'Follows Windows');
    const devRows = real.filter((d) => kindOf(d.label) !== 'virtual');
    const virt = real.filter((d) => kindOf(d.label) === 'virtual');
    if (devRows.length) html += '<div class="hoq-out-sep"></div>';
    devRows.forEach((d) => { const l = splitLabel(d.label); html += row(d.deviceId, kindOf(d.label), l.name, l.sub); });
    if (virt.length) {
      html += '<div class="hoq-out-group">Virtual</div>';
      virt.forEach((d) => { const l = splitLabel(d.label); html += row(d.deviceId, 'virtual', l.name, l.sub); });
    }
    if (locked) {
      html += '<div class="hoq-out-locked">' +
        '<button class="hoq-out-enable" type="button">Show my devices</button></div>' +
        '<div class="hoq-out-note">Windows only shares device names after a one-time audio permission. Nothing is recorded: the mic opens to unlock the list and closes straight away.</div>';
    }
    menu.innerHTML = html;
    menu.querySelectorAll('.hoq-out-item').forEach((el) => {
      el.addEventListener('click', () => select(el.getAttribute('data-id'), el.querySelector('.hoq-out-txt b').textContent));
    });
    const en = menu.querySelector('.hoq-out-enable');
    if (en) en.addEventListener('click', unlock);
  }

  const place = () => {
    const b = document.getElementById('hoq-out-btn'); if (!b) return;
    const r = b.getBoundingClientRect();
    menu.style.top = (r.bottom + 8) + 'px';
    // right-align to the button, clamped to the viewport
    menu.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
    menu.style.left = 'auto';
  };
  const isOpen = () => menu.classList.contains('show');
  // one header menu at a time (the buttons stop their click, so the other menu's
  // click-outside never fires)
  const show = async () => { document.querySelectorAll('#hoq-out-menu.show, #hoq-eq-menu.show').forEach((m) => { if (m !== menu) m.classList.remove('show'); }); place(); await render(); menu.classList.add('show'); };
  const close = () => { menu.classList.remove('show'); };
  btn.addEventListener('click', (e) => { e.stopPropagation(); isOpen() ? close() : show(); });
  // Global listeners survive header re-renders (which can drop + re-add the button),
  // so bind them exactly once and drive open-state off the menu's own class.
  if (!window.__hoqOutBound) {
    window.__hoqOutBound = true;
    document.addEventListener('click', (e) => {
      const b = document.getElementById('hoq-out-btn');
      const p = e.composedPath ? e.composedPath() : [e.target];   // the menu re-renders on pick: target may be detached
      if (isOpen() && !p.includes(menu) && (!b || !p.includes(b))) close();
    });
    window.addEventListener('keydown', (e) => { if (isOpen() && e.key === 'Escape') close(); });
    window.addEventListener('resize', () => { if (isOpen()) place(); });
    try { navigator.mediaDevices.addEventListener('devicechange', () => { if (isOpen()) render(); }); } catch (e) {}
  }
}

// Shared CSS for our header icon buttons (output / EQ / mini), matched to
// SoundCloud's native header icons: 38x46, rgb(153,153,153), 22px glyph, recolour
// on hover only, accent when active. Injected once.
function hoqHdrIconCss() {
  if (document.getElementById('hoq-hdr-icon-css')) return;
  const st = document.createElement('style');
  st.id = 'hoq-hdr-icon-css';
  st.textContent = `
    .hoq-hdr-icon { display:inline-flex; align-items:center; justify-content:center;
      width:38px; height:46px; margin:0; padding:0; border:0; background:transparent;
      color:rgb(153,153,153); cursor:pointer; transition:color .14s ease; }
    .hoq-hdr-icon:hover { color:#fff; }
    .hoq-hdr-icon.on { color:var(--sc-accent,#ff5500); }
    .hoq-hdr-icon svg { width:22px; height:22px; }
    .hoq-pop { position:fixed; z-index:2147483000; padding:10px; border-radius:14px;
      background:rgba(12,12,16,0.72); border:1px solid rgba(255,255,255,0.10);
      box-shadow:0 18px 52px rgba(0,0,0,0.55);
      backdrop-filter:blur(24px) saturate(1.5); -webkit-backdrop-filter:blur(24px) saturate(1.5);
      color:#e7e7ed; font-family:Inter,-apple-system,Arial,sans-serif;
      opacity:0; transform:translateY(-6px) scale(.98); pointer-events:none;
      transition:opacity .13s ease, transform .13s ease; }
    .hoq-pop.show { opacity:1; transform:none; pointer-events:auto; }
    html.hoq-lowend .hoq-pop, html.hoq-no-frost .hoq-pop {
      background:rgba(16,16,20,0.98); backdrop-filter:none; -webkit-backdrop-filter:none; }
  `;
  (document.head || document.documentElement).appendChild(st);
}
// Insert one of our header icon buttons into the userNav cluster, grouped just
// after the output-device button (falling back sensibly if the nav shape shifts).
function hoqPlaceHdrIcon(btn) {
  const out = document.getElementById('hoq-out-btn');
  const eq = document.getElementById('hoq-eq-btn');
  const nav = document.querySelector('.header__userNav');
  const after = eq || out;                                   // keep our icons together, in order
  if (after && after.parentElement) { after.insertAdjacentElement('afterend', btn); return true; }
  if (nav) {
    const bell = nav.querySelector('.header__userNavActivitiesButton') || nav.querySelector('.header__userNavItem');
    if (bell) nav.insertBefore(btn, bell); else nav.appendChild(btn);
    return true;
  }
  const right = document.querySelector('.header__right');
  if (right) { right.insertBefore(btn, right.firstChild); return true; }
  return false;
}

// Header equalizer: a 6-band graphic EQ with presets, wired to the audio chain
// spliced in near the top of this file (window.__hoqEQ).
function setupEqPicker() {
  if (!window.AudioContext) return;
  if (document.documentElement.classList.contains('hoq-mobile')) return;
  if (document.getElementById('hoq-eq-btn')) return;
  if (!document.querySelector('.header__userNav') && !document.querySelector('.header__right')) return;
  hoqHdrIconCss();

  if (!document.getElementById('hoq-eq-css')) {
    const st = document.createElement('style');
    st.id = 'hoq-eq-css';
    st.textContent = `
      #hoq-eq-menu { width:300px; padding:8px; max-height:calc(100vh - 90px); overflow-y:auto; overflow-x:hidden;
        --eq-a: var(--sc-accent,#ff5500); --eq-tint: color-mix(in srgb, var(--eq-a) 20%, transparent);
        --eq-on: color-mix(in srgb, var(--eq-a) 65%, #fff); --eq-track: rgba(255,255,255,0.12); }
      #hoq-eq-menu button { font-family:inherit; }
      .hoq-eq-tabs { display:flex; padding:2px; margin:0 0 10px; border-radius:9px; background:rgba(255,255,255,0.06); }
      .hoq-eq-tab { flex:1 1 0; position:relative; height:26px; border:0; border-radius:7px; background:transparent;
        color:#9a9aa6; font-size:12px; font-weight:500; cursor:pointer; transition:background .15s ease, color .15s ease; }
      .hoq-eq-tab:hover { color:#e6e6ec; }
      .hoq-eq-tab.sel { background:rgba(255,255,255,0.11); color:#fff; box-shadow:0 1px 2px rgba(0,0,0,.25); }
      .hoq-eq-tab i { display:inline-block; vertical-align:middle; margin:-2px 0 0 6px; width:5px; height:5px; border-radius:50%; background:var(--eq-a); }
      .hoq-eq-sec { padding:4px 6px; }
      .hoq-eq-sec + .hoq-eq-sec { margin-top:6px; padding-top:12px; border-top:1px solid rgba(255,255,255,0.07); }
      .hoq-eq-h { display:flex; align-items:center; justify-content:space-between; gap:10px; min-height:22px; margin-bottom:10px;
        font-size:13px; font-weight:600; color:#ececf1; }
      .hoq-eq-h b { font-weight:500; color:#9a9aa6; font-variant-numeric:tabular-nums; }
      .hoq-eq-h small { display:block; margin-top:2px; font-size:11px; font-weight:400; color:#7d7d88; }
      .hoq-eq-sec > .hoq-eq-h:last-child { margin-bottom:0; }
      .hoq-eq-sw { position:relative; width:34px; height:20px; flex:0 0 34px; border-radius:99px; cursor:pointer;
        background:rgba(255,255,255,0.14); transition:background .18s ease; }
      .hoq-eq-sw::after { content:''; position:absolute; top:2px; left:2px; width:16px; height:16px; border-radius:50%;
        background:#fff; box-shadow:0 1px 3px rgba(0,0,0,.35); transition:transform .2s cubic-bezier(.3,1.4,.6,1); }
      .hoq-eq-sw.on { background:var(--eq-a); }
      .hoq-eq-sw.on::after { transform:translateX(14px); }
      /* chips: quiet by default, tinted (not solid) when picked */
      .hoq-eq-chips { display:grid; grid-template-columns:repeat(4, 1fr); gap:4px; }
      .hoq-eq-chips.c3 { grid-template-columns:repeat(3, 1fr); }
      .hoq-eq-chips.c2 { grid-template-columns:repeat(2, 1fr); }
      .hoq-eq-preset, .hoq-eq-space { height:28px; padding:0 4px; border:0; border-radius:7px; background:rgba(255,255,255,0.05);
        color:#b9b9c3; font-size:12px; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
        transition:background .12s ease, color .12s ease; }
      .hoq-eq-preset:hover, .hoq-eq-space:hover { background:rgba(255,255,255,0.10); color:#fff; }
      .hoq-eq-preset.sel, .hoq-eq-space.sel { background:var(--eq-tint); color:var(--eq-on);
        box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--eq-a) 40%, transparent); }
      /* segmented steps (boost) */
      .hoq-eq-seg { display:flex; margin-top:12px; padding:2px; border-radius:8px; background:rgba(255,255,255,0.05); }
      .hoq-eq-seg .hoq-eq-preset { flex:1 1 0; height:24px; background:transparent; font-size:11.5px; font-variant-numeric:tabular-nums; }
      .hoq-eq-seg .hoq-eq-preset.sel { background:rgba(255,255,255,0.11); color:#fff; box-shadow:none; }
      /* sliders: thin filled track + white thumb */
      #hoq-eq-menu input[type=range] { -webkit-appearance:none; appearance:none; margin:0; outline:none; cursor:pointer;
        height:4px; border-radius:99px; background:linear-gradient(to right, var(--eq-a) var(--p,0%), var(--eq-track) var(--p,0%)); }
      #hoq-eq-menu input[type=range]::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; width:14px; height:14px;
        border-radius:50%; background:#fff; box-shadow:0 1px 4px rgba(0,0,0,.45); transition:transform .1s ease; }
      #hoq-eq-menu input[type=range]:active::-webkit-slider-thumb { transform:scale(1.15); }
      #hoq-eq-menu input[type=range]:disabled { opacity:.35; cursor:default; }
      .hoq-eq-line { display:flex; align-items:center; gap:10px; }
      .hoq-eq-line input { flex:1 1 auto; }
      .hoq-eq-line span { font-size:11px; color:#7d7d88; font-variant-numeric:tabular-nums; min-width:30px; text-align:right; }
      /* EQ faders: vertical, filled from the 0 dB centre line */
      .hoq-eq-faders { position:relative; display:grid; grid-template-columns:repeat(6, 1fr); padding:2px 0 0; margin-bottom:12px; }
      .hoq-eq-faders::before { content:''; position:absolute; left:8px; right:8px; top:75px; height:1px; background:rgba(255,255,255,0.08); }
      .hoq-eq-fader { display:flex; flex-direction:column; align-items:center; gap:6px; }
      .hoq-eq-fader .v { height:12px; font-size:10.5px; color:#9a9aa6; font-variant-numeric:tabular-nums; }
      .hoq-eq-fader .f { font-size:10.5px; color:#7d7d88; }
      #hoq-eq-menu .hoq-eq-fader input[type=range] { writing-mode:vertical-lr; direction:rtl; width:4px; height:110px;
        background:linear-gradient(to top, var(--eq-track) min(50%, var(--p,50%)), var(--eq-a) min(50%, var(--p,50%)),
          var(--eq-a) max(50%, var(--p,50%)), var(--eq-track) max(50%, var(--p,50%))); }
      .hoq-eq-off .hoq-eq-faders { opacity:.45; }
      .hoq-eq-tip { margin-top:10px; font-size:11px; color:#7d7d88; line-height:1.4; }
    `;
    (document.head || document.documentElement).appendChild(st);
  }

  const btn = document.createElement('button');
  btn.id = 'hoq-eq-btn'; btn.type = 'button'; btn.title = 'Equalizer'; btn.className = 'hoq-hdr-icon';
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="4" x2="6" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/><line x1="18" y1="4" x2="18" y2="20"/><circle cx="6" cy="9" r="2.4" fill="currentColor" stroke="none"/><circle cx="12" cy="15" r="2.4" fill="currentColor" stroke="none"/><circle cx="18" cy="8" r="2.4" fill="currentColor" stroke="none"/></svg>';
  if (!hoqPlaceHdrIcon(btn)) return;

  let menu = document.getElementById('hoq-eq-menu');
  if (!menu) { menu = document.createElement('div'); menu.id = 'hoq-eq-menu'; menu.className = 'hoq-pop'; document.body.appendChild(menu); }

  const PRESETS = {
    Flat: [0, 0, 0, 0, 0, 0],
    Bass: [7, 5, 2, 0, 0, 0],
    Warm: [4, 3, 1, 0, -1, -2],
    Vocal: [-2, -1, 2, 4, 3, 1],
    Treble: [0, 0, 0, 2, 4, 6],
    Punch: [5, 2, -1, 0, 2, 4],
    // tiny/old PC speakers can't move air below ~100 Hz: cut it (it only distorts)
    // and lift the upper-bass + presence instead so it still sounds full and loud
    'Old PC': [-6, 5, 3, 1, 3, 2],
    Night: [-3, -1, 1, 2, 1, -2],
  };
  const FX = window.__hoqFX;
  const reflectBtn = () => btn.classList.toggle('on', window.__hoqEQ.isOn() || (FX && FX.active()));
  let tab = 'eq'; try { tab = localStorage.getItem('hoqEqTab') || 'eq'; } catch (e) {}
  if (!FX && tab !== 'eq') tab = 'eq';

  function tabsHtml() {
    if (!FX) return '';
    const s = FX.get();
    const dot = { eq: window.__hoqEQ.isOn(), vol: s.boost > 0 || s.level || s.xfade > 0, space: !!s.space, speed: s.speed !== 1 };
    return '<div class="hoq-eq-tabs">' + [['eq', 'EQ'], ['vol', 'Volume'], ['space', 'Space'], ['speed', 'Speed']].map(([k, l]) =>
      '<button class="hoq-eq-tab' + (tab === k ? ' sel' : '') + '" data-t="' + k + '">' + l + (dot[k] ? '<i></i>' : '') + '</button>').join('') + '</div>';
  }
  function bindTabs() {
    menu.querySelectorAll('.hoq-eq-tab').forEach((el) => el.addEventListener('click', (e) => {
      e.stopPropagation(); tab = el.getAttribute('data-t'); try { localStorage.setItem('hoqEqTab', tab); } catch (er) {} render(); place();
    }));
  }
  // range fill: --p = how far along the track the value sits
  const fill = (el) => { const mn = +el.min, mx = +el.max; el.style.setProperty('--p', ((+el.value - mn) / (mx - mn) * 100) + '%'); };
  const dbTxt = (v) => (v > 0 ? '+' : '') + v;

  function renderVol() {
    const s = FX.get();
    let h = tabsHtml();
    h += '<div class="hoq-eq-sec"><div class="hoq-eq-h">Boost<b class="hoq-eq-big">' + (s.boost > 0 ? '+' + s.boost + ' dB' : 'Off') + '</b></div>';
    h += '<div class="hoq-eq-line"><input type="range" class="hoq-boost" min="0" max="12" step="1" value="' + s.boost + '"></div>';
    h += '<div class="hoq-eq-seg">' + [0, 3, 6, 9, 12].map((v) =>
      '<button class="hoq-eq-preset' + (s.boost === v ? ' sel' : '') + '" data-b="' + v + '">' + (v ? '+' + v : 'Off') + '</button>').join('') + '</div></div>';
    h += '<div class="hoq-eq-sec"><div class="hoq-eq-h"><div>Even out volume<small>Every song plays at the same loudness</small></div>' +
      '<div class="hoq-eq-sw hoq-lvl' + (s.level ? ' on' : '') + '" role="switch" aria-checked="' + s.level + '"></div></div></div>';
    h += '<div class="hoq-eq-sec hoq-eq-tip" style="border:0;margin:0;padding-top:0">For quiet tracks or weak speakers. A limiter keeps it from crackling.</div>';
    h += '<div class="hoq-eq-sec"><div class="hoq-eq-h"><div>Crossfade<small>Each song fades out into the next</small></div><b class="hoq-xf-v">' + (s.xfade ? s.xfade + ' s' : 'Off') + '</b></div>' +
      '<div class="hoq-eq-line"><input type="range" class="hoq-xf" min="0" max="8" step="1" value="' + s.xfade + '"></div></div>';
    menu.innerHTML = h; bindTabs();
    const xr = menu.querySelector('.hoq-xf'), xv = menu.querySelector('.hoq-xf-v'); fill(xr);
    xr.addEventListener('input', () => { fill(xr); FX.set({ xfade: +xr.value }); xv.textContent = +xr.value ? xr.value + ' s' : 'Off'; reflectBtn(); });
    const big = menu.querySelector('.hoq-eq-big');
    const r = menu.querySelector('.hoq-boost'); fill(r);
    r.addEventListener('input', () => {
      fill(r); FX.set({ boost: +r.value }); big.textContent = +r.value > 0 ? '+' + r.value + ' dB' : 'Off'; reflectBtn();
      menu.querySelectorAll('[data-b]').forEach((p) => p.classList.toggle('sel', +p.getAttribute('data-b') === +r.value));
    });
    r.addEventListener('change', () => render());
    menu.querySelectorAll('[data-b]').forEach((el) => el.addEventListener('click', () => { FX.set({ boost: +el.getAttribute('data-b') }); reflectBtn(); render(); }));
    menu.querySelector('.hoq-lvl').addEventListener('click', () => { FX.set({ level: !FX.get().level }); reflectBtn(); render(); });
  }
  function renderSpace() {
    const s = FX.get(), sp = FX.spaces;
    let h = tabsHtml();
    h += '<div class="hoq-eq-sec"><div class="hoq-eq-h">Space<b>' + (s.space ? hoqEsc(sp[s.space].label) : 'Off') + '</b></div>';
    h += '<div class="hoq-eq-chips c3"><button class="hoq-eq-space' + (!s.space ? ' sel' : '') + '" data-s="">Off</button>' +
      Object.keys(sp).map((k) => '<button class="hoq-eq-space' + (s.space === k ? ' sel' : '') + '" data-s="' + k + '" title="' + hoqEsc(sp[k].tip || '') + '">' + hoqEsc(sp[k].label) + '</button>').join('') + '</div>';
    h += '<div class="hoq-eq-tip">' + (s.space ? hoqEsc(sp[s.space].tip || '') : 'Put the music somewhere. Stacks with the EQ.') + '</div></div>';
    h += '<div class="hoq-eq-sec"><div class="hoq-eq-h">Amount<b class="hoq-amt-v">' + (s.space ? s.amount + '%' : '–') + '</b></div>' +
      '<div class="hoq-eq-line"><input type="range" class="hoq-amt" min="0" max="100" step="5" value="' + s.amount + '"' + (s.space ? '' : ' disabled') + '></div></div>';
    menu.innerHTML = h; bindTabs();
    menu.querySelectorAll('.hoq-eq-space').forEach((el) => el.addEventListener('click', () => { FX.set({ space: el.getAttribute('data-s') }); reflectBtn(); render(); }));
    const r = menu.querySelector('.hoq-amt'), v = menu.querySelector('.hoq-amt-v'); fill(r);
    r.addEventListener('input', () => { fill(r); FX.set({ amount: +r.value }); v.textContent = r.value + '%'; });
  }

  // Speed: speed + pitch together (a resample, like a record), with the usual presets
  const SPEEDS = [['Normal', 1, ''], ['Slowed', 0.85, ''], ['Slowed + reverb', 0.85, 'hall'], ['Daycore', 0.75, ''], ['Sped up', 1.15, ''], ['Nightcore', 1.25, '']];
  function renderSpeed() {
    const s = FX.get();
    const semi = (r) => { const v = Math.round(12 * Math.log2(r) * 10) / 10; return (v > 0 ? '+' : '') + v; };
    const pick = SPEEDS.find(([, r, sp]) => Math.abs(r - s.speed) < 0.001 && (sp ? s.space === sp : !(r === 0.85 && s.space === 'hall')));
    let h = tabsHtml();
    h += '<div class="hoq-eq-sec"><div class="hoq-eq-h">Speed<b class="hoq-sp-v">' + s.speed.toFixed(2) + '×' + (s.speed !== 1 ? ' · ' + semi(s.speed) + ' st' : '') + '</b></div>';
    h += '<div class="hoq-eq-chips c2">' + SPEEDS.map(([l], i) => '<button class="hoq-eq-preset' + (pick && pick[0] === l ? ' sel' : '') + '" data-sp="' + i + '">' + l + '</button>').join('') + '</div></div>';
    h += '<div class="hoq-eq-sec"><div class="hoq-eq-line"><input type="range" class="hoq-sp" min="0.5" max="1.5" step="0.01" value="' + s.speed + '"></div>' +
      '<div class="hoq-eq-tip">Speed and pitch move together, like speeding up a record: no warble. Slowed + reverb also turns on Concert hall in Space.</div></div>';
    menu.innerHTML = h; bindTabs();
    const r = menu.querySelector('.hoq-sp'), v = menu.querySelector('.hoq-sp-v'); fill(r);
    r.addEventListener('input', () => { fill(r); FX.set({ speed: +r.value }); v.textContent = (+r.value).toFixed(2) + '×' + (+r.value !== 1 ? ' · ' + semi(+r.value) + ' st' : ''); reflectBtn(); });
    r.addEventListener('change', () => render());
    menu.querySelectorAll('[data-sp]').forEach((el) => el.addEventListener('click', () => {
      const [, rate, sp] = SPEEDS[+el.getAttribute('data-sp')];
      const patch = { speed: rate };
      if (sp) { patch.space = sp; patch.amount = 60; }
      else if (FX.get().space === 'hall' && FX.get().speed === 0.85) patch.space = '';   // leaving Slowed + reverb takes its reverb with it
      FX.set(patch); reflectBtn(); render();
    }));
  }

  function render() {
    if (tab === 'vol') return renderVol();
    if (tab === 'space') return renderSpace();
    if (tab === 'speed') return renderSpeed();
    const gains = window.__hoqEQ.get();
    const on = window.__hoqEQ.isOn();
    const presetName = Object.keys(PRESETS).find((k) => PRESETS[k].every((v, i) => v === (gains[i] || 0)));
    let h = tabsHtml() + '<div class="hoq-eq-sec' + (on ? '' : ' hoq-eq-off') + '"><div class="hoq-eq-h">Equalizer<div class="hoq-eq-sw' + (on ? ' on' : '') + '" role="switch" aria-checked="' + on + '"></div></div>';
    h += '<div class="hoq-eq-faders">' + window.__hoqEQ.freqs.map((f, i) =>
      '<div class="hoq-eq-fader"><span class="v" data-v="' + i + '">' + dbTxt(gains[i] || 0) + '</span>' +
      '<input type="range" min="-12" max="12" step="1" value="' + (gains[i] || 0) + '" data-i="' + i + '" title="' + window.__hoqEQ.labels[i] + ' Hz">' +
      '<span class="f">' + window.__hoqEQ.labels[i] + '</span></div>').join('') + '</div>';
    h += '<div class="hoq-eq-chips">' + Object.keys(PRESETS).map((k) =>
      '<button class="hoq-eq-preset' + (presetName === k ? ' sel' : '') + '" data-p="' + k + '">' + k + '</button>').join('') + '</div></div>';
    menu.innerHTML = h; bindTabs();
    menu.querySelector('.hoq-eq-sw').addEventListener('click', () => { window.__hoqEQ.set(window.__hoqEQ.get(), !window.__hoqEQ.isOn()); reflectBtn(); render(); });
    menu.querySelectorAll('.hoq-eq-preset').forEach((el) => el.addEventListener('click', () => {
      window.__hoqEQ.set(PRESETS[el.getAttribute('data-p')].slice(), true); reflectBtn(); render();
    }));
    menu.querySelectorAll('.hoq-eq-fader input[type=range]').forEach((el) => {
      fill(el);
      el.addEventListener('input', () => {
        fill(el);
        const g = window.__hoqEQ.get(); g[+el.getAttribute('data-i')] = +el.value;
        window.__hoqEQ.set(g, true);
        const v = menu.querySelector('.v[data-v="' + el.getAttribute('data-i') + '"]'); if (v) v.textContent = dbTxt(+el.value);
        reflectBtn();
        menu.querySelector('.hoq-eq-sec').classList.remove('hoq-eq-off');
        const sw = menu.querySelector('.hoq-eq-sw'); if (sw) sw.classList.add('on');
        // update preset highlight without a full re-render (keeps slider focus)
        const gg = window.__hoqEQ.get(); const pn = Object.keys(PRESETS).find((k) => PRESETS[k].every((vv, i) => vv === (gg[i] || 0)));
        menu.querySelectorAll('.hoq-eq-preset').forEach((p) => p.classList.toggle('sel', p.getAttribute('data-p') === pn));
      });
    });
  }
  const place = () => { const b = document.getElementById('hoq-eq-btn'); if (!b) return; const r = b.getBoundingClientRect(); menu.style.top = (r.bottom + 8) + 'px'; menu.style.right = Math.max(8, window.innerWidth - r.right) + 'px'; menu.style.left = 'auto'; };
  const isOpen = () => menu.classList.contains('show');
  const show = () => { document.querySelectorAll('#hoq-out-menu.show, #hoq-eq-menu.show').forEach((m) => { if (m !== menu) m.classList.remove('show'); }); render(); place(); menu.classList.add('show'); };
  const close = () => menu.classList.remove('show');
  reflectBtn();
  btn.addEventListener('click', (e) => { e.stopPropagation(); isOpen() ? close() : show(); });
  if (!window.__hoqEqBound) {
    window.__hoqEqBound = true;
    // composedPath, not contains(): clicking a chip re-renders the menu, so the
    // target is already detached by the time this runs.
    document.addEventListener('click', (e) => { const b = document.getElementById('hoq-eq-btn'); const p = e.composedPath ? e.composedPath() : [e.target]; if (isOpen() && !p.includes(menu) && (!b || !p.includes(b))) close(); });
    window.addEventListener('keydown', (e) => { if (isOpen() && e.key === 'Escape') close(); });
    window.addEventListener('resize', () => { if (isOpen()) place(); });
  }
}

// Compact / mini player mode: shrinks the window to a small always-on-top widget
// (handled host-side on mini:on/off) and swaps the page to a minimal now-playing
// card with transport controls.
function setupMiniMode() {
  if (document.documentElement.classList.contains('hoq-mobile')) return;
  // Mini mode shrinks the OS window, which only the C# host can do. On the web
  // proxy (no host) the widget would just fill the browser tab, so hide it there.
  try { if (!(window.chrome && window.chrome.webview && window.chrome.webview.postMessage)) return; } catch (e) { return; }
  if (document.getElementById('hoq-mini-btn')) return;
  if (!document.querySelector('.header__userNav') && !document.querySelector('.header__right')) return;
  hoqHdrIconCss();

  if (!document.getElementById('hoq-mini-css')) {
    const st = document.createElement('style');
    st.id = 'hoq-mini-css';
    st.textContent = `
      html.hoq-mini, html.hoq-mini body { overflow:hidden !important; background:#0b0b0e !important; }
      html.hoq-mini body > *:not(#hoq-mini):not(#hoq-discord):not(script):not(style) { display:none !important; }
      html.hoq-mini #hoq-discord { display:none !important; }
      /* Compact player. Three layouts (data-layout): player 380x112, bar 340x56,
         name 290x34. A tools pill (layout / pin / fade / back) appears on hover;
         the host fades the whole window when the mouse is away (overlay style). */
      #hoq-mini { position:fixed; inset:0; z-index:2147483200; display:none; align-items:center;
        box-sizing:border-box; background:#0d0d10; color:#ececf1; overflow:hidden;
        font-family:Inter,-apple-system,Arial,sans-serif; -webkit-user-select:none; user-select:none; }
      html.hoq-mini #hoq-mini { display:flex; }
      #hoq-mini .mn-bg { position:absolute; inset:-30px; z-index:0; background-size:cover; background-position:center;
        filter:blur(30px) saturate(1.3) brightness(.4); transform:scale(1.1); }
      #hoq-mini .mn-bg::after { content:''; position:absolute; inset:0; background:rgba(10,10,13,.35); }
      #hoq-mini > :not(.mn-bg) { position:relative; z-index:1; }
      #hoq-mini .mn-art { flex:none; border-radius:8px; background:#1c1c22 center/cover no-repeat; cursor:pointer;
        box-shadow:0 4px 14px rgba(0,0,0,.4); transition:filter .15s ease; }
      #hoq-mini .mn-art:hover { filter:brightness(1.1); }
      #hoq-mini .mn-body { flex:1 1 auto; min-width:0; height:100%; display:flex; flex-direction:column; justify-content:center; gap:6px; }
      #hoq-mini .mn-head { display:flex; align-items:center; gap:4px; min-width:0; }
      #hoq-mini .mn-meta { flex:1 1 auto; min-width:0; }
      #hoq-mini .mn-title, #hoq-mini .mn-artist, #hoq-mini .mn-line { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      #hoq-mini .mn-title { font-size:13px; font-weight:600; color:#fff; }
      #hoq-mini .mn-artist { margin-top:1px; font-size:11.5px; color:#a6a6b0; }
      #hoq-mini .mn-line { flex:1 1 auto; min-width:0; font-size:12.5px; color:#fff; font-weight:600; }
      #hoq-mini .mn-line span { color:#a6a6b0; font-weight:400; }
      /* sliders: thin track, near-white fill (an accent from a dark cover can be as
         dark as the track itself), thumb only on hover */
      #hoq-mini input.mn-range { -webkit-appearance:none; appearance:none; display:block; margin:0; height:3px; border-radius:99px; outline:none; cursor:pointer;
        background:linear-gradient(to right, rgba(255,255,255,.88) var(--p,0%), rgba(255,255,255,.16) var(--p,0%)); }
      #hoq-mini input.mn-range::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; width:10px; height:10px; border-radius:50%;
        background:#fff; box-shadow:0 1px 3px rgba(0,0,0,.5); opacity:0; transition:opacity .12s ease; }
      #hoq-mini input.mn-range:hover::-webkit-slider-thumb, #hoq-mini input.mn-range:active::-webkit-slider-thumb { opacity:1; }
      #hoq-mini input.mn-range:disabled { opacity:.4; cursor:default; }
      #hoq-mini .mn-seek { display:flex; align-items:center; gap:7px; font-size:10px; color:#8e8e99; font-variant-numeric:tabular-nums; }
      #hoq-mini .mn-seek input { flex:1 1 auto; min-width:0; }
      #hoq-mini .mn-ctrls { display:flex; align-items:center; gap:0; margin-left:-5px; }
      #hoq-mini .mn-btn { display:inline-flex; align-items:center; justify-content:center; flex:0 0 auto; position:relative;
        width:26px; height:26px; padding:0; border:0; border-radius:7px; background:transparent; color:#c9c9d2; cursor:pointer;
        transition:background .12s ease, color .12s ease; }
      #hoq-mini .mn-btn:hover { background:rgba(255,255,255,.1); color:#fff; }
      #hoq-mini .mn-btn svg { width:15px; height:15px; }
      #hoq-mini .mn-btn.on { color:var(--sc-accent,#ff5500); }
      #hoq-mini .mn-play { width:30px; height:30px; margin:0 2px; border-radius:50%; background:#fff !important; color:#0d0d10 !important; }
      #hoq-mini .mn-play svg { width:14px; height:14px; }
      #hoq-mini .mn-like svg { fill:none; stroke:currentColor; }
      #hoq-mini .mn-like.on { color:var(--sc-accent,#ff5500); }
      #hoq-mini .mn-like.on svg { fill:currentColor; }
      #hoq-mini .mn-repeat.one::after { content:'1'; position:absolute; top:2px; right:2px; font-size:8px; font-weight:800; line-height:1; }
      #hoq-mini .mn-vol { display:flex; align-items:center; gap:5px; margin-left:auto; color:#8e8e99; }
      #hoq-mini .mn-vol svg { width:14px; height:14px; flex:none; }
      #hoq-mini input.mn-volrange { width:48px; }
      /* hover tools pill (top-right) */
      /* tools sit in the title row (left of like) and only show on hover: they
         take room from the title, never cover a control */
      #hoq-mini .mn-tools { display:none; flex:none; gap:0; padding:1px; margin-right:2px; border-radius:8px; background:rgba(255,255,255,.07); }
      #hoq-mini:hover .mn-tools { display:flex; }
      #hoq-mini .mn-tools .mn-btn { width:22px; height:22px; color:#a6a6b0; }
      #hoq-mini .mn-tools .mn-btn svg { width:13px; height:13px; }
      #hoq-mini .mn-tools .mn-btn.on { color:var(--sc-accent,#ff5500); }
      #hoq-mini .mn-flash { position:absolute; left:10px; bottom:10px; z-index:4; padding:3px 9px; border-radius:99px; max-width:calc(100% - 20px); overflow:hidden; text-overflow:ellipsis;
        background:rgba(14,14,18,.9); font-size:11px; color:#fff; white-space:nowrap; opacity:0; transition:opacity .15s ease; pointer-events:none; }
      #hoq-mini .mn-flash.show { opacity:1; }
      /* layouts */
      #hoq-mini[data-layout="player"] { padding:12px; gap:12px; }
      #hoq-mini[data-layout="player"] .mn-art { width:88px; height:88px; }
      #hoq-mini[data-layout="bar"] { padding:8px 10px 8px 8px; gap:10px; }
      #hoq-mini[data-layout="bar"] .mn-art { width:40px; height:40px; border-radius:6px; }
      #hoq-mini[data-layout="name"] { padding:5px 8px 5px 5px; gap:8px; }
      #hoq-mini[data-layout="name"] .mn-art { width:24px; height:24px; border-radius:5px; box-shadow:none; }
      #hoq-mini:not([data-layout="player"]) .mn-flash { bottom:auto; top:50%; left:6px; transform:translateY(-50%); }
      #hoq-mini[data-layout="name"] .mn-tools .mn-btn { width:20px; height:20px; }
      #hoq-mini:not([data-layout="player"]) .mn-body > :not(.mn-head) { display:none; }
      #hoq-mini:not([data-layout="player"]) .mn-head .mn-mini-ctrls { display:flex; }
      #hoq-mini .mn-mini-ctrls { display:none; align-items:center; }
      #hoq-mini[data-layout="name"] .mn-mini-ctrls, #hoq-mini[data-layout="name"] .mn-meta { display:none !important; }
      #hoq-mini:not([data-layout="name"]) .mn-line { display:none; }
      #hoq-mini[data-layout="name"] .mn-like { width:22px; height:22px; }
    `;
    (document.head || document.documentElement).appendChild(st);
  }

  const btn = document.createElement('button');
  btn.id = 'hoq-mini-btn'; btn.type = 'button'; btn.title = 'Compact player'; btn.className = 'hoq-hdr-icon';
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><rect x="12" y="12" width="7" height="5" rx="1.2" fill="currentColor" stroke="none"/></svg>';
  if (!hoqPlaceHdrIcon(btn)) return;

  const SVG = {
    prev: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
    shuffle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M3 4l5 5"/></svg>',
    repeat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
    like: '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>',
    vol: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 9v6h4l5 5V4L8 9H4z"/><path d="M16 8.5a4 4 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    exit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>',
    layout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/></svg>',
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6l-1 6 3 3v2H7v-2l3-3z"/><path d="M12 15v6"/></svg>',
    fade: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none"/></svg>',
  };
  const fmt = (s) => { if (!isFinite(s) || s < 0) s = 0; s = Math.floor(s); const m = Math.floor(s / 60); const ss = s % 60; return m + ':' + (ss < 10 ? '0' : '') + ss; };
  const fillR = (r) => r.style.setProperty('--p', (r.value - r.min) / (r.max - r.min) * 100 + '%');
  let scrubbing = false, adjustingVol = false;

  // Settings (synced with the account like the rest): layout, always on top,
  // and how see-through the window gets while the mouse is away.
  const LAYOUTS = { player: [380, 112], bar: [340, 56], name: [290, 34] };
  const LAYOUT_NAMES = { player: 'Player', bar: 'Bar', name: 'Name only' };
  const FADES = [100, 70, 50, 30];
  const pref = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } };
  const setPref = (k, v) => { try { localStorage.setItem(k, String(v)); } catch (e) {} };
  const layout = () => { const l = pref('hoqMiniLayout', 'player'); return LAYOUTS[l] ? l : 'player'; };
  const pinned = () => pref('hoqMiniPin', '1') !== '0';
  const fade = () => { const f = +pref('hoqMiniFade', '100'); return FADES.includes(f) ? f : 100; };

  let widget = document.getElementById('hoq-mini');
  if (!widget) {
    widget = document.createElement('div');
    widget.id = 'hoq-mini';
    widget.innerHTML =
      '<div class="mn-bg"></div>' +
      '<div class="mn-art" title="Back to full app"></div>' +
      '<div class="mn-body">' +
        '<div class="mn-head">' +
          '<div class="mn-meta"><div class="mn-title">Not playing</div><div class="mn-artist"></div></div>' +
          '<div class="mn-line"></div>' +
          '<span class="mn-mini-ctrls">' +
            '<button class="mn-btn mn-play" title="Play/pause">' + SVG.play + '</button>' +
            '<button class="mn-btn mn-next" title="Next">' + SVG.next + '</button>' +
          '</span>' +
          '<span class="mn-tools">' +
            '<button class="mn-btn mn-t-layout" title="Layout">' + SVG.layout + '</button>' +
            '<button class="mn-btn mn-t-pin" title="Keep on top">' + SVG.pin + '</button>' +
            '<button class="mn-btn mn-t-fade" title="Fade when the mouse is away">' + SVG.fade + '</button>' +
            '<button class="mn-btn mn-t-exit" title="Back to full app">' + SVG.exit + '</button>' +
          '</span>' +
          '<button class="mn-btn mn-like" title="Like">' + SVG.like + '</button>' +
        '</div>' +
        '<div class="mn-seek"><span class="mn-t0">0:00</span><input type="range" class="mn-range mn-prog" min="0" max="1000" value="0"><span class="mn-t1">0:00</span></div>' +
        '<div class="mn-ctrls">' +
          '<button class="mn-btn mn-shuffle" title="Shuffle">' + SVG.shuffle + '</button>' +
          '<button class="mn-btn mn-prev" title="Previous">' + SVG.prev + '</button>' +
          '<button class="mn-btn mn-play" title="Play/pause">' + SVG.play + '</button>' +
          '<button class="mn-btn mn-next" title="Next">' + SVG.next + '</button>' +
          '<button class="mn-btn mn-repeat" title="Repeat">' + SVG.repeat + '</button>' +
          '<span class="mn-vol" title="Volume (or scroll anywhere)">' + SVG.vol + '<input type="range" class="mn-range mn-volrange" min="0" max="100" value="100"></span>' +
        '</div>' +
      '</div>' +
      '<div class="mn-flash"></div>';
    document.body.appendChild(widget);
    // Dragging the card body moves the OS window (frameless), except on controls
    // and the cover art (which is a click target — "back to full app").
    widget.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('button, input, .mn-art')) return;
      scPost('win:drag');
    });
    const clickSc = (sel) => { const el = document.querySelector(sel); if (el) el.click(); setTimeout(update, 60); };
    const on = (sel, fn) => widget.querySelectorAll(sel).forEach((b) => b.addEventListener('click', fn));
    on('.mn-prev', () => window.__hoqMedia('prev'));
    on('.mn-next', () => window.__hoqMedia('next'));
    on('.mn-play', () => { window.__hoqMedia('playpause'); setTimeout(update, 80); });
    on('.mn-shuffle', () => clickSc('.shuffleControl'));
    on('.mn-repeat', () => clickSc('.repeatControl'));
    on('.mn-like', () => clickSc('.playbackSoundBadge__like'));
    on('.mn-art', () => exitMini());
    on('.mn-t-exit', () => exitMini());
    let flashT = 0;
    const flash = (t) => { const f = widget.querySelector('.mn-flash'); f.textContent = t; f.classList.add('show'); clearTimeout(flashT); flashT = setTimeout(() => f.classList.remove('show'), 1300); };
    on('.mn-t-layout', () => {
      const keys = Object.keys(LAYOUTS), next = keys[(keys.indexOf(layout()) + 1) % keys.length];
      setPref('hoqMiniLayout', next); applyLayout(true); flash(LAYOUT_NAMES[next]);
    });
    on('.mn-t-pin', () => { setPref('hoqMiniPin', pinned() ? '0' : '1'); scPost('mini:pin:' + (pinned() ? '1' : '0')); reflectTools(); flash(pinned() ? 'Kept on top' : 'Not on top'); });
    on('.mn-t-fade', () => {
      const next = FADES[(FADES.indexOf(fade()) + 1) % FADES.length];
      setPref('hoqMiniFade', next); reflectTools(); flash(next === 100 ? 'Fade off' : 'Fades to ' + next + '% when the mouse is away');
    });
    // Overlay fade: see-through while the mouse is away, solid on hover.
    document.documentElement.addEventListener('mouseleave', () => { if (miniOn() && fade() < 100) scPost('mini:alpha:' + fade()); });
    document.documentElement.addEventListener('mouseenter', () => { if (miniOn()) scPost('mini:alpha:100'); });
    const prog = widget.querySelector('.mn-prog');
    const durNow = () => { const m = hoqMediaNow(); return m && m.dur > 0 ? m.dur : 0; };   // SoundCloud's audio, or a Go+ song's YouTube player
    prog.addEventListener('input', () => { scrubbing = true; fillR(prog); const d = durNow(); if (d) widget.querySelector('.mn-t0').textContent = fmt(prog.value / 1000 * d); });
    prog.addEventListener('change', () => { const d = durNow(); if (d) hoqSeek(prog.value / 1000 * d); scrubbing = false; });
    const vol = widget.querySelector('.mn-volrange');
    // Through the app's own volume, like the main slider: setting the element
    // alone was undone by the next play() (which re-applies the saved level) and
    // left the main slider showing the old one.
    const setVol = () => {
      fillR(vol);
      const v = Math.min(1, Math.max(0, vol.value / 100));
      if (window.__scSetVolume) window.__scSetVolume(v);
      else { const el = window.__hoqMediaEl; if (el) { try { el.muted = false; el.volume = v; } catch (e) {} } }
      const main = document.querySelector('.hoq-vol');
      if (main) {
        main.value = String(Math.round(v * 100)); updateVolFill(main);
        const pct = main.parentElement && main.parentElement.querySelector('.hoq-vol-pct');
        if (pct) pct.textContent = main.value + '%';
      }
    };
    vol.addEventListener('input', () => { adjustingVol = true; setVol(); });
    vol.addEventListener('change', () => { adjustingVol = false; });
    // scroll anywhere on the player = volume
    widget.addEventListener('wheel', (e) => { e.preventDefault(); vol.value = Math.max(0, Math.min(100, +vol.value + (e.deltaY < 0 ? 5 : -5))); setVol(); flash('Volume ' + vol.value + '%'); }, { passive: false });
  }
  const miniOn = () => document.documentElement.classList.contains('hoq-mini');
  function reflectTools() {
    widget.querySelector('.mn-t-pin').classList.toggle('on', pinned());
    widget.querySelector('.mn-t-fade').classList.toggle('on', fade() < 100);
  }
  function applyLayout(resize) {
    const l = layout();
    widget.setAttribute('data-layout', l);
    if (resize && miniOn()) scPost('mini:size:' + LAYOUTS[l][0] + 'x' + LAYOUTS[l][1]);
    reflectTools();
  }

  function np() {
    const g = (s) => document.querySelector(s);
    const t = g('.playbackSoundBadge__titleLink');
    const a = g('.playbackSoundBadge__lightLink');
    let cover = '';
    const art = g('.playControls .playbackSoundBadge__avatar span.sc-artwork, .playControls .playbackSoundBadge span.sc-artwork, .playControls__soundBadge span.sc-artwork');
    if (art) { const bg = getComputedStyle(art).backgroundImage; if (bg && bg !== 'none') cover = bg; }
    const playBtn = g('.playControls__play');
    // aria-label is the real play state ("Pause current" = playing); the class is
    // a permanent style hook, not a state flag.
    const yt = hoqYtProgress();   // a Go+ song playing from YouTube
    const paused = yt ? yt.paused : playBtn ? (playBtn.getAttribute('aria-label') || '').toLowerCase().indexOf('play') === 0 : true;
    // The link's text has a visually-hidden "Current track: …" duplicate; its
    // title attribute is the clean value.
    let title = '';
    if (t) {
      title = t.getAttribute('title') || '';
      if (!title) { const vis = [...t.children].find((c) => !c.classList.contains('sc-visuallyhidden')); title = vis ? vis.textContent.trim() : t.textContent.replace(/^\s*Current track:\s*/i, '').trim(); }
    }
    let artist = a ? (a.getAttribute('title') || a.textContent.trim()) : '';
    // a Go+ song YouTube plays on its own isn't in SoundCloud's bar
    const solo = hoqYtSolo();
    if (solo) { title = solo.title; artist = solo.artist; cover = solo.cover ? 'url("' + solo.cover + '")' : cover; }
    const like = g('.playbackSoundBadge__like');
    const liked = like ? (like.getAttribute('aria-label') || '').toLowerCase() === 'unlike' : false;
    const sh = g('.shuffleControl'); const rp = g('.repeatControl');
    const shuffling = !!(sh && sh.classList.contains('m-shuffling'));
    const repeat = rp ? (rp.classList.contains('m-one') ? 'one' : rp.classList.contains('m-all') ? 'all' : 'none') : 'none';
    return { title, artist, cover, paused, liked, shuffling, repeat };
  }
  function update() {
    if (!miniOn()) return;
    const s = np();
    const set = (sel, txt) => { const el = widget.querySelector(sel); if (el && el.textContent !== txt) el.textContent = txt; };
    set('.mn-title', s.title || 'Not playing');
    set('.mn-artist', s.artist || '');
    const line = widget.querySelector('.mn-line');
    const lineHtml = hoqEsc(s.title || 'Not playing') + (s.artist ? ' <span>· ' + hoqEsc(s.artist) + '</span>' : '');
    if (line.innerHTML !== lineHtml) line.innerHTML = lineHtml;
    const art = widget.querySelector('.mn-art'); const bg = widget.querySelector('.mn-bg');
    // the player badge only carries a 50px thumbnail: ask for the 500px one
    const big = s.cover ? s.cover.replace(/-(t\d+x\d+|large|small|badge|tiny)\.(jpg|png|jpeg)/i, '-t500x500.$2') : '';
    if (big && art.style.backgroundImage !== big) { art.style.backgroundImage = big; bg.style.backgroundImage = big; }
    widget.querySelectorAll('.mn-play').forEach((pb) => { const h = s.paused ? SVG.play : SVG.pause; if (pb.innerHTML !== h) pb.innerHTML = h; });
    widget.querySelector('.mn-like').classList.toggle('on', s.liked);
    widget.querySelector('.mn-shuffle').classList.toggle('on', s.shuffling);
    const rpBtn = widget.querySelector('.mn-repeat');
    rpBtn.classList.toggle('on', s.repeat !== 'none');
    rpBtn.classList.toggle('one', s.repeat === 'one');
    // progress + time + volume from the actual audio element
    const el = window.__hoqMediaEl, m = hoqMediaNow();
    const prog = widget.querySelector('.mn-prog'); const vol = widget.querySelector('.mn-volrange');
    const dur = m ? m.dur : 0;
    const cur = m ? m.pos : 0;
    prog.disabled = !dur;
    if (!scrubbing) { prog.value = dur ? Math.round(cur / dur * 1000) : 0; fillR(prog); set('.mn-t0', fmt(cur)); set('.mn-t1', fmt(dur)); }
    if (!adjustingVol && el) { vol.value = Math.round((el.muted ? 0 : el.volume) * 100); fillR(vol); }
  }
  function enterMini() {
    document.documentElement.classList.add('hoq-mini');
    applyLayout(false);
    const sz = LAYOUTS[layout()];
    scPost('mini:on:' + sz[0] + 'x' + sz[1] + ':' + (pinned() ? '1' : '0'));
    update();
    // Tighter cadence so the progress bar moves smoothly.
    if (!window.__hoqMiniTimer) window.__hoqMiniTimer = setInterval(update, 500);
  }
  function exitMini() {
    document.documentElement.classList.remove('hoq-mini');
    scPost('mini:off');
    if (window.__hoqMiniTimer) { clearInterval(window.__hoqMiniTimer); window.__hoqMiniTimer = null; }
  }
  window.__hoqExitMini = exitMini;   // let the host force-exit if needed
  btn.addEventListener('click', () => { miniOn() ? exitMini() : enterMini(); });
}

// ---- Profile extras -------------------------------------------------------
// On any artist profile: Play all / Shuffle, a "Find a track" box that searches
// their whole catalogue, a "You & <artist>" card from the local listening stats,
// and "New" tags on tracks posted since you last opened their page. The track
// list comes from SoundCloud's own API (same client_id the page itself uses),
// fetched once per profile per session.
const __hoqPf = { cache: {}, prev: {}, slug: '', cid: '' };
function hoqPfClientId() {
  if (__hoqPf.cid) return __hoqPf.cid;
  const n = performance.getEntriesByType('resource').map((e) => e.name).reverse().find((x) => /[?&]client_id=/.test(x));
  __hoqPf.cid = n ? ((n.match(/client_id=([^&]+)/) || [])[1] || '') : '';
  return __hoqPf.cid;
}
function hoqPfData(slug) {
  if (__hoqPf.cache[slug]) return __hoqPf.cache[slug];
  const p = (async () => {
    const cid = hoqPfClientId();
    if (!cid) throw new Error('no client id yet');
    const api = 'https://api-v2.soundcloud.com';
    const u = await fetch(api + '/resolve?url=' + encodeURIComponent('https://soundcloud.com/' + slug) + '&client_id=' + cid).then((r) => r.json());
    if (!u || u.kind !== 'user') throw new Error('not a user');
    const tracks = [];
    let next = api + '/users/' + u.id + '/tracks?limit=200&linked_partitioning=1&client_id=' + cid;
    for (let i = 0; next && i < 8; i++) {
      const j = await fetch(next).then((r) => r.json());
      (j.collection || []).forEach((t) => {
        if (!t || t.kind !== 'track') return;
        tracks.push({
          title: t.title || '', path: (t.permalink_url || '').replace(/^https?:\/\/[^/]+/, ''),
          date: Date.parse(t.display_date || t.created_at || '') || 0, dur: t.duration || 0, plays: t.playback_count || 0,
          art: (t.artwork_url || (u.avatar_url || '')).replace('-large.', '-t50x50.'),
        });
      });
      next = j.next_href ? j.next_href + (/[?&]client_id=/.test(j.next_href) ? '' : '&client_id=' + cid) : '';
    }
    return { user: u, tracks };
  })();
  __hoqPf.cache[slug] = p;
  p.catch(() => { delete __hoqPf.cache[slug]; });
  return p;
}
const hoqPfDate = (t) => {
  if (!t) return '';
  const d = new Date(t), now = new Date();
  return d.toLocaleDateString(undefined, d.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
};
const hoqPfDur = (ms) => { const s = Math.round(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const hoqPfSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Open a track page through SoundCloud's own router (the player keeps going),
// then press its play button once it shows up.
function hoqPfOpenAndPlay(path, seek) {
  try { sessionStorage.setItem('hoqPfAuto', JSON.stringify({ path, t: Date.now(), seek: seek > 0 ? seek : 0 })); } catch (e) {}
  // a Go+ song that ends up playing from YouTube starts there too (listen along, jams)
  window.__hoqWantPos = seek > 0 ? { path, sec: seek, t: Date.now() } : null;
  const a = document.createElement('a');
  a.href = path; a.style.display = 'none';
  document.body.appendChild(a); a.click(); a.remove();
}
function hoqPfAutoPlay() {
  let job = null; try { job = JSON.parse(sessionStorage.getItem('hoqPfAuto')); } catch (e) {}
  if (!job) return;
  if (Date.now() - job.t > 15000) { sessionStorage.removeItem('hoqPfAuto'); return; }
  if (decodeURIComponent(location.pathname).toLowerCase() !== decodeURIComponent(job.path).toLowerCase()) return;
  const b = document.querySelector('.fullHero__title .soundTitle__playButton .sc-button-play, .fullListenHero .sc-button-play');
  if (!b) return;
  sessionStorage.removeItem('hoqPfAuto');
  if (!b.classList.contains('sc-button-pause')) b.click();
  if (job.seek > 0) {
    // once this track is actually playing, jump to the position (listen along)
    const want = job.seek + 1, t0 = Date.now();
    const iv = setInterval(() => {
      const el = window.__hoqMediaEl;
      if (Date.now() - t0 > 20000) { clearInterval(iv); return; }
      if (el && !el.paused && el.currentTime > 4 && el.readyState >= 3 && isFinite(el.duration) && want < el.duration - 3) {
        clearInterval(iv); hoqSeek(want + (Date.now() - t0) / 1000);
      }
    }, 250);
  }
}

// Play the artist's Tracks tab from the top, or a random track with shuffle on.
async function hoqPfPlayAll(slug, shuffle) {
  const onTracks = () => new RegExp('^/' + slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/tracks/?$', 'i').test(location.pathname);
  if (!onTracks()) {
    const a = document.querySelector('.userInfoBar__tabs a[href$="/tracks"]');
    if (a) a.click(); else return;
  }
  let btns = [];
  for (let i = 0; i < 50; i++) {
    btns = onTracks() ? [...document.querySelectorAll('.soundList__item .soundTitle__playButton .sc-button-play')] : [];
    if (btns.length) break;
    await hoqPfSleep(150);
  }
  if (!btns.length) return;
  const sh = document.querySelector('.playControls .shuffleControl');
  const shOn = () => !!(sh && /m-shuffling|sc-button-selected/.test(sh.className));
  if (!shuffle && shOn()) sh.click();
  const b = shuffle ? btns[Math.floor(Math.random() * btns.length)] : btns[0];
  if (!b.classList.contains('sc-button-pause')) b.click();
  if (shuffle) { await hoqPfSleep(400); if (sh && !shOn()) sh.click(); }
}

// ---- Search: Best match + Lyrics ----------------------------------------------
// SoundCloud's ranking often puts a stranger's upload or a profile above the song
// you typed. Two switches in the search sidebar put a ranked block on top of its
// results. Its own list stays below: a hidden lazy list keeps loading forever.
//   Best match: its tracks for what you typed, re-ranked so the title you typed
//     comes first (the exact title, then the whole phrase, then all the words;
//     plays break ties).
//   Lyrics: type a line you remember. Genius names the song (through the host
//     app), and its best SoundCloud upload is found the same way.
// A switch stays on for later searches until it's turned off.
const hoqNorm = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const HOQ_OTHER_VERSION = /\b(remix|sped up|speed up|slowed|reverb|nightcore|cover|bootleg|instrumental|8d|mashup|type beat)\b/;
function hoqMatchScore(t, q) {
  const title = hoqNorm(t.title);
  const bare = String(t.title || '').replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');   // without (feat …) and [tags]
  const full = hoqNorm(bare);                                                 // "Artist - Song" kept
  const core = hoqNorm(bare.replace(/^[^-–—]*\s[-–—]\s/, ''));                // and without the "Artist - "
  const user = hoqNorm(t.user && t.user.username);
  const who = user + ' ' + hoqNorm(t.publisher_metadata && t.publisher_metadata.artist);
  const words = q.split(' ').filter(Boolean), hay = ' ' + title + ' ' + who + ' ';
  let s = 0;
  if (q && (core === q || full === q || title === q || (user && user + ' ' + core === q))) s += 160;
  else if (q && (' ' + full + ' ').includes(' ' + q + ' ')) s += 120;
  else if (q && (' ' + title + ' ').includes(' ' + q + ' ')) s += 100;
  const found = words.filter((w) => hay.includes(' ' + w + ' ')).length;
  if (words.length) s += 60 * found / words.length + (found === words.length ? 20 : 0);
  // a remix, sped-up, cover… of it, unless that's what was typed
  if (HOQ_OTHER_VERSION.test(String(t.title || '').toLowerCase()) && !HOQ_OTHER_VERSION.test(q)) s -= 30;
  return s + Math.log10((t.playback_count || 0) + 1) * 4;
}
const _hoqSrchCache = new Map();
function hoqScTracks(q, limit) {
  const key = limit + '|' + q;
  if (_hoqSrchCache.has(key)) return _hoqSrchCache.get(key);
  const cid = hoqPfClientId();
  if (!cid) return Promise.reject(new Error('no client id yet'));
  const p = fetch('https://api-v2.soundcloud.com/search/tracks?q=' + encodeURIComponent(q) + '&limit=' + limit + '&client_id=' + cid)
    .then((r) => { if (!r.ok) throw new Error('search answered ' + r.status); return r.json(); })
    .then((j) => (j.collection || []).filter((t) => t && t.kind === 'track' && t.permalink_url));
  _hoqSrchCache.set(key, p);
  p.catch(() => _hoqSrchCache.delete(key));
  if (_hoqSrchCache.size > 80) _hoqSrchCache.delete(_hoqSrchCache.keys().next().value);
  return p;
}
let _lyrRid = 0;
const _lyrWait = new Map();
function hoqLyricsSongs(q) {
  return new Promise((resolve) => {
    if (!hoqHasHost()) return resolve(null);
    const rid = 'l' + (++_lyrRid);
    _lyrWait.set(rid, resolve);
    setTimeout(() => { if (_lyrWait.delete(rid)) resolve(null); }, 15000);
    scPost('lyrics:search:' + JSON.stringify({ rid, q }));
  });
}
window.__hoqLyricsRes = function (rid, list) {
  const done = _lyrWait.get(rid);
  if (done) { _lyrWait.delete(rid); done(Array.isArray(list) ? list : null); }
};
const hoqPlays = (n) => !n ? '' : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M plays' : n >= 1e3 ? Math.round(n / 1e3) + 'K plays' : n + ' plays';
// One result. `extra` is HTML the caller has already escaped.
function hoqSrchRow(t, extra) {
  const path = String(t.permalink_url || '').replace(/^https?:\/\/[^/]+/, '');
  const art = hoqSafeUrl(String(t.artwork_url || (t.user && t.user.avatar_url) || '').replace('-large.', '-t200x200.'));
  const meta = [hoqPlays(t.playback_count), t.duration ? hoqPfDur(t.duration) : ''].filter(Boolean).join(' · ');
  return '<div class="hoq-srch-row" data-path="' + hoqEsc(path) + '" title="Play">' +
    '<span class="hoq-srch-art"' + (art ? ' style="background-image:url(' + hoqEsc(JSON.stringify(art)) + ')"' : '') + '><i>▶</i></span>' +
    '<span class="hoq-srch-t"><b>' + hoqEsc(t.title) + '</b><span>' + hoqEsc((t.user && t.user.username) || '') + (extra ? ' · ' + extra : '') + '</span></span>' +
    (t.policy === 'SNIP' ? '<em class="hoq-srch-go">Go+ preview</em>' : '') +
    '<span class="hoq-srch-meta">' + hoqEsc(meta) + '</span></div>';
}
function hoqSrchBind(box) {
  box.querySelectorAll('.hoq-srch-row[data-path]').forEach((r) => r.addEventListener('click', () => { if (r.dataset.path) hoqPfOpenAndPlay(r.dataset.path, 0); }));
  box.querySelectorAll('.hoq-srch-find').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const a = document.createElement('a');
    a.href = '/search/sounds?q=' + encodeURIComponent(b.dataset.q);
    document.body.appendChild(a); a.click(); a.remove();
  }));
  const off = box.querySelector('.hoq-srch-off');
  if (off) off.addEventListener('click', () => { try { localStorage.removeItem('hoqSearchMode'); } catch (e) {} hoqSearchTick(); });
  const more = box.querySelector('.hoq-srch-more');
  if (more) more.addEventListener('click', () => { box.classList.add('all'); more.remove(); });
}
// A failed search is tried again on a later tick, not every 0.7 s.
function hoqSrchFailed(box, key, head, msg) {
  box.innerHTML = head + '<div class="hoq-srch-msg">' + msg + '</div>';
  hoqSrchBind(box);
  box.dataset.key = key + '|failed';
  setTimeout(() => { if (box.dataset.key === key + '|failed') box.dataset.key = ''; }, 6000);
}
const hoqSrchHead = (title, sub) => '<div class="hoq-srch-head"><b>' + title + '</b><span>' + sub + '</span><button type="button" class="hoq-srch-off" title="Turn off">×</button></div>';
async function hoqRenderBest(box, q, key) {
  const head = hoqSrchHead('Best match', 'The track called what you typed comes first');
  box.innerHTML = head + '<div class="hoq-srch-msg">Looking…</div>';
  let list = null;
  try { list = await hoqScTracks(q, 50); } catch (e) {}
  if (box.dataset.key !== key) return;   // the search changed meanwhile
  if (!list) return hoqSrchFailed(box, key, head, 'Couldn’t search right now. Trying again in a moment…');
  const nq = hoqNorm(q);
  const ranked = list.map((t) => ({ t, s: hoqMatchScore(t, nq) })).sort((a, b) => b.s - a.s).slice(0, 20);
  box.innerHTML = head + (ranked.length
    ? '<div class="hoq-srch-list">' + ranked.map((r, i) => hoqSrchRow(r.t, i === 0 && r.s >= 100 ? '<em class="hoq-srch-top">Top match</em>' : '')).join('') + '</div>' +
      (ranked.length > 5 ? '<button type="button" class="hoq-srch-more">Show more</button>' : '')
    : '<div class="hoq-srch-msg">No tracks called that.</div>');
  hoqSrchBind(box);
}
async function hoqRenderLyrics(box, q, key) {
  const head = hoqSrchHead('Lyrics', 'Songs with that line in them (found on Genius), on SoundCloud');
  box.innerHTML = head + '<div class="hoq-srch-msg">Looking…</div>';
  const songs = await hoqLyricsSongs(q);
  if (box.dataset.key !== key) return;
  if (!songs) return hoqSrchFailed(box, key, head, 'Couldn’t reach the lyrics search right now. Trying again in a moment…');
  if (!songs.length) { box.innerHTML = head + '<div class="hoq-srch-msg">No song with that line.</div>'; return hoqSrchBind(box); }
  const rows = await Promise.all(songs.slice(0, 5).map(async (g) => {
    let list = [];
    try { list = await hoqScTracks(g.title + ' ' + g.artist, 15); } catch (e) {}
    const nt = hoqNorm(g.title), aw = hoqNorm(g.artist).split(' ').filter((w) => w.length >= 3);
    const best = list.map((t) => {
      const hay = ' ' + hoqNorm((t.user && t.user.username) + ' ' + t.title + ' ' + ((t.publisher_metadata && t.publisher_metadata.artist) || '')) + ' ';
      return { t, s: hoqMatchScore(t, nt) + (aw.some((w) => hay.includes(' ' + w + ' ')) ? 40 : 0) };
    }).sort((a, b) => b.s - a.s)[0];
    return { g, t: best && best.s >= 100 ? best.t : null };
  }));
  if (box.dataset.key !== key) return;
  box.innerHTML = head + '<div class="hoq-srch-list">' + rows.map((r) => r.t
    ? hoqSrchRow(r.t, '<em class="hoq-srch-lyr">“' + hoqEsc(r.g.title) + '” by ' + hoqEsc(r.g.artist) + '</em>')
    : '<div class="hoq-srch-row off"><span class="hoq-srch-art"></span><span class="hoq-srch-t"><b>' + hoqEsc(r.g.title) + '</b><span>' + hoqEsc(r.g.artist) +
      ' · not found on SoundCloud</span></span><button type="button" class="hoq-srch-find" data-q="' + hoqEsc(r.g.title + ' ' + r.g.artist) + '">Search for it</button></div>').join('') + '</div>';
  hoqSrchBind(box);
}

const HOQ_SRCH_ROUTES = /^\/search(\/sounds|\/go)?\/?$/;   // Everything, Tracks, Go+ (not people, albums, playlists)
const _srchNavs = new WeakSet();
function hoqSearchTick() {
  // Desktop only: the phone builds run on the proxy's domain, which SoundCloud's
  // API doesn't answer cross-origin, and Lyrics needs the host app anyway.
  if (!hoqHasHost()) return;
  const nav = /^\/search/.test(location.pathname) && document.querySelector('.searchOptions__navigation');
  const box0 = document.getElementById('hoq-srch');
  if (!nav) { if (box0) box0.remove(); return; }
  if (!document.getElementById('hoq-srch-css')) {
    const icon = (svg) => 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
    const st = document.createElement('style');
    st.id = 'hoq-srch-css';
    st.textContent =
      '.hoq-snav.hoq-snav-best { --hoq-ni: ' + icon("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2'><circle cx='12' cy='12' r='8'/><circle cx='12' cy='12' r='4'/><circle cx='12' cy='12' r='1' fill='black'/></svg>") + '; }' +
      '.hoq-snav.hoq-snav-lyrics { --hoq-ni: ' + icon("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M4 6h10M4 11h10M4 16h6'/><path d='M17.5 17.5V8l3.5-1'/><circle cx='15.5' cy='17.5' r='2'/></svg>") + '; }' +
      '.hoq-snav .searchOptions__navigationLink { cursor: pointer; }' +
      '.hoq-snav.active .searchOptions__navigationLink::after { content: "On"; margin-left: auto; padding: 3px 7px; border-radius: 99px; font-size: 10.5px; font-weight: 700; line-height: 1; background: var(--sc-accent, #ff5500); color: #fff; -webkit-text-fill-color: #fff; }' +
      '#hoq-srch { margin: 0 0 18px; padding: 14px; border-radius: 14px; background: rgba(20,20,24,0.55); border: 1px solid rgba(255,255,255,0.08); }' +
      '#hoq-srch .hoq-srch-head { display: flex; align-items: baseline; gap: 10px; margin: 0 4px 8px; }' +
      '#hoq-srch .hoq-srch-head b { color: #fff; font-size: 15px; }' +
      '#hoq-srch .hoq-srch-head span { color: #9a9aa2; font-size: 12px; flex: 1 1 auto; }' +
      '#hoq-srch .hoq-srch-off { border: 0; background: none; color: #9a9aa2; font-size: 18px; line-height: 1; cursor: pointer; }' +
      '#hoq-srch .hoq-srch-off:hover { color: #fff; }' +
      '#hoq-srch .hoq-srch-row { display: flex; align-items: center; gap: 12px; padding: 7px 8px; border-radius: 10px; cursor: pointer; }' +
      '#hoq-srch .hoq-srch-row:hover { background: rgba(255,255,255,0.06); }' +
      '#hoq-srch:not(.all) .hoq-srch-row:nth-child(n+6) { display: none; }' +
      '#hoq-srch .hoq-srch-art { position: relative; flex: none; width: 44px; height: 44px; border-radius: 8px; background: rgba(255,255,255,0.08) center / cover no-repeat; }' +
      '#hoq-srch .hoq-srch-art i { position: absolute; inset: 0; display: grid; place-items: center; font-style: normal; color: #fff; background: rgba(0,0,0,0.45); border-radius: 8px; opacity: 0; transition: opacity .12s; }' +
      '#hoq-srch .hoq-srch-row:not(.off):hover .hoq-srch-art i { opacity: 1; }' +
      '#hoq-srch .hoq-srch-t { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }' +
      '#hoq-srch .hoq-srch-t b { color: #fff; font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }' +
      '#hoq-srch .hoq-srch-t span { color: #a8a8b0; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }' +
      '#hoq-srch .hoq-srch-meta { flex: none; color: #8d8d94; font-size: 12px; }' +
      '#hoq-srch .hoq-srch-top, #hoq-srch .hoq-srch-lyr { font-style: normal; color: var(--sc-accent, #ff5500); font-weight: 600; }' +
      '#hoq-srch .hoq-srch-go { flex: none; font-style: normal; font-size: 11px; color: #d6b04a; }' +
      '#hoq-srch .hoq-srch-msg { color: #a8a8b0; font-size: 13px; padding: 8px; }' +
      '#hoq-srch .hoq-srch-more, #hoq-srch .hoq-srch-find { flex: none; margin-top: 6px; border: 1px solid rgba(255,255,255,0.14); background: transparent; color: #ddd; border-radius: 9px; padding: 6px 12px; cursor: pointer; font: 600 12px system-ui, sans-serif; }' +
      '#hoq-srch .hoq-srch-find { margin-top: 0; }' +
      '#hoq-srch .hoq-srch-row.off { cursor: default; }';
    (document.head || document.documentElement).appendChild(st);
  }
  let mode = '';
  try { mode = localStorage.getItem('hoqSearchMode') || ''; } catch (e) {}
  if (!nav.querySelector('.hoq-snav')) {
    const mk = (m, label, tip) => '<li class="g-nav-item searchOptions__navigationItem hoq-snav hoq-snav-' + m + '" data-mode="' + m + '" title="' + tip + '">' +
      '<a class="g-nav-link sc-link-primary searchOptions__navigationLink sc-text-h4" role="button" tabindex="0">' + label + '</a></li>';
    const html = mk('best', 'Best match', 'Put the track called what you typed on top') + mk('lyrics', 'Lyrics', 'Find a song from a line of its lyrics');
    const first = nav.firstElementChild;
    if (first) first.insertAdjacentHTML('afterend', html); else nav.insertAdjacentHTML('afterbegin', html);
  }
  if (!_srchNavs.has(nav)) {
    _srchNavs.add(nav);
    nav.addEventListener('click', (e) => {
      const li = e.target.closest && e.target.closest('.hoq-snav');
      if (!li) return;
      e.preventDefault(); e.stopPropagation();
      let cur = '';
      try { cur = localStorage.getItem('hoqSearchMode') || ''; } catch (e2) {}
      try { if (cur === li.dataset.mode) localStorage.removeItem('hoqSearchMode'); else localStorage.setItem('hoqSearchMode', li.dataset.mode); } catch (e2) {}
      hoqSearchTick();
    }, true);
  }
  nav.querySelectorAll('.hoq-snav').forEach((li) => li.classList.toggle('active', li.dataset.mode === mode));
  const q = (new URLSearchParams(location.search).get('q') || '').trim();
  const wrap = document.querySelector('.search__listWrapper');
  if (!mode || !q || !wrap || !HOQ_SRCH_ROUTES.test(location.pathname)) { if (box0) box0.remove(); return; }
  let box = box0;
  if (!box || box.parentElement !== wrap) {
    if (box) box.remove();
    box = document.createElement('div');
    box.id = 'hoq-srch';
    wrap.insertBefore(box, wrap.firstChild);
  }
  const key = mode + '|' + q;
  if (box.dataset.key === key || box.dataset.key === key + '|failed') return;
  box.dataset.key = key;
  box.classList.remove('all');
  (mode === 'lyrics' ? hoqRenderLyrics : hoqRenderBest)(box, q, key);
}

// ---- Go+ songs from YouTube -------------------------------------------------------
// Without Go+, SoundCloud plays only a 30-second preview of a Go+ track. When one
// starts, the app finds the same recording on YouTube (the host fetches YouTube's
// results page with a plain HTTPS request: through the WebView, as Lyrics does it,
// YouTube answers "No results found") and plays it in YouTube's embedded
// player, in a small card while it plays: YouTube's rules want its player on screen,
// at least 200x200, never a hidden background one. SoundCloud keeps the track and
// the queue. Its play button, Space, the media keys, the seek bar and the compact
// player work the YouTube player; Discord, Last.fm, stats and jams read its progress
// (playerProgress); when the video ends SoundCloud moves on. Nothing is pulled out
// of either site: SoundCloud's preview sits paused, YouTube's player plays YouTube's
// video. A Go+ subscriber gets full streams and never sees any of it.
// Desktop only (the search needs the host). Switch: Social → Settings → Desktop.
// `var`, not `let`: playerProgress() and the media keys reach these from code above.
var _yt = null;          // the YouTube stand-in for the current Go+ track (hoqYtStart)
var _ytBypass = false;   // our own presses on SoundCloud's play button go through
var _goSkip = '';        // a track whose YouTube card was closed: SoundCloud's preview it is
var _goNoAuth = false;   // SoundCloud refused the signed-in ask once: ask anonymously
var _goNoPathSince = 0;  // when the player bar last lost its song link
var _scPressAt = 0, _ytRid = 0, _ytVarRule = null;
const HOQ_YT_HOST = 'https://www.youtube-nocookie.com';
const _goInfo = new Map();   // track path → { snip, want } | null (not a track) | 'wait'
const _ytWait = new Map();

function hoqGoOn() { try { return localStorage.getItem('hoqGoYT') !== '0'; } catch (e) { return true; } }
// The song in SoundCloud's own bar (npPublicUrl would answer with a refused Go+ song
// playing from YouTube, and then a song you start yourself would go unnoticed).
function hoqGoPath() { try { const h = hoqBarHref('.playbackSoundBadge__titleLink'); return h ? hoqTrackPath(h.split(/[?#]/)[0]) : ''; } catch (e) { return ''; } }
function hoqScAuth() {
  if (_goNoAuth) return '';
  try { const m = document.cookie.match(/(?:^|;\s*)oauth_token=([^;]+)/); return m ? decodeURIComponent(m[1]) : ''; } catch (e) { return ''; }
}

// Is this track only a preview for whoever is signed in? Its streams say so: all of
// them "snipped" (a Go+ subscriber gets full ones for the same track). Asked with the
// page's own sign-in, the way SoundCloud's page asks. undefined: not known yet.
function hoqGoLookup(path) {
  const v = _goInfo.get(path);
  if (v !== undefined) return v === 'wait' ? undefined : v;
  const cid = hoqPfClientId();
  if (!cid) return undefined;
  _goInfo.set(path, 'wait');
  const tok = hoqScAuth();
  const opts = tok ? { headers: { Authorization: 'OAuth ' + tok } } : {};
  // a stalled request would leave this song on 'wait' for the whole session
  try { opts.signal = AbortSignal.timeout(10000); } catch (e) {}
  fetch('https://api-v2.soundcloud.com/resolve?url=' + encodeURIComponent('https://soundcloud.com' + path) + '&client_id=' + cid, opts)
    .then((r) => {
      if (r.status === 401 && tok) { _goNoAuth = true; _goInfo.delete(path); throw new Error('sign-in refused'); }
      if (!r.ok) throw new Error('resolve answered ' + r.status);
      return r.json();
    })
    .then((t) => {
      let res = null;
      if (t && t.kind === 'track') {
        const tc = (t.media && t.media.transcodings) || [];
        res = { snip: tc.length ? tc.every((x) => x && x.snipped) : t.policy === 'SNIP', want: hoqGoWant(t) };
      }
      _goInfo.set(path, res);
      if (_goInfo.size > 300) _goInfo.delete(_goInfo.keys().next().value);
    })
    .catch(() => setTimeout(() => { if (_goInfo.get(path) === 'wait') _goInfo.delete(path); }, 15000));
  return undefined;
}

// "Snooze (Acoustic) [feat. Justin Bieber]" by SZA → what to search YouTube for, the
// song's own name, which version it is, and how long the full song runs.
const HOQ_YT_VERS = /\b(acoustic|remix|live|sped up|speed up|slowed|reverb|nightcore|instrumental|acapella|a cappella|demo|unplugged|reprise|extended|remaster|remastered|cover|clean|8d|bass boosted|karaoke|mashup|bootleg|radio edit|version|session)\b/g;
const hoqYtVers = (s) => new Set((hoqNorm(s).match(HOQ_YT_VERS) || []).map((w) => w === 'remastered' ? 'remaster' : w === 'speed up' ? 'sped up' : w === 'a cappella' ? 'acapella' : w));
function hoqGoWant(t) {
  const pm = t.publisher_metadata || {};
  const artist = String(pm.artist || (t.user && t.user.username) || '').trim();
  const title = String(t.title || '').trim();
  const an = hoqNorm(artist);
  // what to type into YouTube: no producer tags, the artist in front unless it's there already
  const clean = title.replace(/[(\[]\s*(prod|produced)\b[^)\]]*[)\]]/ig, ' ').replace(/\s+/g, ' ').trim();
  const q = (an && !(' ' + hoqNorm(clean) + ' ').includes(' ' + an + ' ') ? artist + ' ' : '') + clean;
  // the song's own name: no (feat …) or [tags], and no "Artist - " in front
  let core = title.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  const dash = core.match(/^\s*(.+?)\s[-–—]\s(.+)$/);
  if (dash) { const pre = hoqNorm(dash[1]); core = !an || !pre || pre.includes(an) || an.includes(pre) ? dash[2] : dash[1]; }
  // and no "feat. X" outside brackets: YouTube writes it ft., (feat. …) or not at all.
  // ("with" stays: it's in too many real titles, like "Stay With Me".)
  const coreN = (hoqNorm(core) || hoqNorm(title)).replace(/ (feat|ft|featuring) .*$/, '').trim();
  const artRaw = String(t.artwork_url || (t.user && t.user.avatar_url) || '').replace('-large.', '-t300x300.');
  const art = hoqSafeUrl(artRaw);   // plain https only (it goes into a CSS url())
  const userUrl = hoqSafeUrl(String((t.user && t.user.permalink_url) || ''));   // the uploader, for Discord's artist link
  return { q: q.slice(0, 150), title, artist, an, art, userUrl, core: coreN || hoqNorm(title), vers: hoqYtVers(title),
    sec: Math.round((t.full_duration || t.duration || 0) / 1000) };
}

// How surely a YouTube result is this recording. The length counts most (a music
// video with a long intro drops back behind the plain audio); then the title, the
// artist's own channel, and no remix / live take / sped-up… unless that's the track.
function hoqYtScore(v, w) {
  const vt = hoqNorm(v.t), ch = hoqNorm(v.ch), hay = ' ' + vt + ' ' + ch + ' ';
  const words = w.core.split(' ').filter(Boolean);
  const found = words.filter((x) => hay.includes(' ' + x + ' ')).length;
  if (words.length && found / words.length < 0.75) return -1;   // another song
  let s = words.length ? 50 * found / words.length : 0;
  if (w.core && (' ' + vt + ' ').includes(' ' + w.core + ' ')) s += 25;
  const a = w.an, aw = a.split(' ').filter((x) => x.length > 1);
  if (a && (ch === a || ch === a + ' topic' || ch.replace(/ (vevo|official|music|records)$/, '') === a || ch.replace(/vevo$/, '') === a.replace(/ /g, ''))) s += 40;
  else if (aw.length && aw.every((x) => hay.includes(' ' + x + ' '))) s += 20;
  if (v.art) s += 15; else if (v.ver) s += 5;
  if (w.sec && v.sec) { const d = Math.abs(v.sec - w.sec); s += d <= 3 ? 45 : d <= 8 ? 30 : d <= 20 ? 5 : d <= 60 ? -25 : -60; }
  const vv = hoqYtVers(v.t);
  vv.forEach((x) => { if (!w.vers.has(x)) s -= 45; });   // a version this track isn't
  w.vers.forEach((x) => { if (!vv.has(x)) s -= 30; });   // or not the version it is
  if (/\blyrics?\b/.test(vt)) s -= 8;                     // fan lyric videos last among equals
  return s + Math.log10((+v.views || 0) + 1) * 2;
}

function hoqYtSearch(q) {
  return new Promise((resolve) => {
    if (!hoqHasHost()) return resolve(null);
    const rid = 'y' + (++_ytRid);
    _ytWait.set(rid, resolve);
    setTimeout(() => { if (_ytWait.delete(rid)) resolve(null); }, 20000);
    scPost('yt:search:' + JSON.stringify({ rid, q }));
  });
}
window.__hoqYtRes = function (rid, list) {
  const done = _ytWait.get(rid);
  if (done) { _ytWait.delete(rid); done(Array.isArray(list) ? list : null); }
};

function hoqYtStart(path, want) {
  // listen along / a jam opened it partway through: start there
  const h = window.__hoqWantPos;
  const startAt = h && hoqSamePath(h.path, path) && Date.now() - h.t < 30000 ? h.sec + (Date.now() - h.t) / 1000 : 0;
  const y = _yt = { path, want, cands: null, idx: -1, vid: '', wid: 0, frame: null, heard: false, ready: false, state: -1,
    pos: startAt, at: Date.now(), dur: want.sec || 0, wantPlay: true, t0: Date.now(), startAt, loadAt: 0, vol: -1,
    endedFor: '', advancing: false, real: null };
  hoqScPause();
  hoqYtCard();
  hoqYtPaint();
  const ask = (tries) => hoqYtSearch(want.q).then((list) => {
    if (_yt !== y) return;
    if ((!list || !list.length) && tries < 1) return ask(tries + 1);   // YouTube's answer varies request to request: once more
    y.cands = (list || []).map((v) => ({ v, s: hoqYtScore(v, want) })).filter((r) => r.s >= 60)
      .sort((a, b) => b.s - a.s).slice(0, 6).map((r) => r.v);
    if (!y.cands.length) return hoqYtGiveUp(list ? 'Couldn’t find the full song.' : 'Couldn’t look for the full song right now.');
    hoqYtLoad(0);
  });
  ask(0);
}

// Put match i in the card: YouTube's own embed, controlled the way its IFrame API
// script does it (postMessage: "listening", then commands; it answers with its state).
function hoqYtLoad(i) {
  const y = _yt;
  if (!y || !y.cands) return;
  if (i >= y.cands.length) return hoqYtGiveUp(y.cands.length > 1 ? 'None of the versions found would play here.' : 'The version found won’t play here.');
  const v = y.cands[i];
  Object.assign(y, { idx: i, vid: v.id, wid: y.wid + 1, heard: false, ready: false, state: -1, pos: y.startAt, at: Date.now(),
    dur: v.sec || y.want.sec || 0, loadAt: Date.now(), vol: -1, endedFor: '', real: null, seekOnReady: null });
  const box = hoqYtCard(), holder = box.querySelector('.hoq-yt-vid');
  if (y.frame) y.frame.remove();
  const f = document.createElement('iframe');
  f.title = 'Video player';
  f.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
  f.setAttribute('allowfullscreen', '');
  f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');   // YouTube refuses an embed that sends no referrer
  f.src = HOQ_YT_HOST + '/embed/' + encodeURIComponent(v.id) + '?enablejsapi=1&playsinline=1&rel=0&iv_load_policy=3&controls=0&disablekb=1&fs=0' +
    '&autoplay=' + (y.wantPlay ? 1 : 0) + (y.startAt >= 1 ? '&start=' + Math.floor(y.startAt) : '') +
    '&origin=' + encodeURIComponent(location.origin) + '&widgetid=' + y.wid;
  const wid = y.wid;
  f.addEventListener('load', () => {
    let n = 0;
    const iv = setInterval(() => {
      if (_yt !== y || y.wid !== wid || y.heard || ++n > 40) { clearInterval(iv); return; }
      hoqYtListen(y);
    }, 250);
  });
  holder.appendChild(f);
  y.frame = f;
  hoqYtRenderHead();
}
// "Someone is listening": after that the player sends its events and state.
function hoqYtListen(y) {
  try { y.frame.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: y.wid, channel: 'widget' }), HOQ_YT_HOST); } catch (e) {}
}

function hoqYtCmd(func, args) {
  const y = _yt;
  if (!y || !y.frame || !y.frame.contentWindow) return;
  try { y.frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args: args || [], id: y.wid, channel: 'widget' }), HOQ_YT_HOST); } catch (e) {}
}

function hoqYtOnMsg(e) {
  const y = _yt;
  if (!y || !y.frame || e.source !== y.frame.contentWindow || e.origin !== HOQ_YT_HOST) return;
  let d = e.data;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch (x) { return; } }
  if (!d || typeof d !== 'object') return;
  // The player says when it can hear us; a "listening" sent before that is lost.
  if (d.event === 'readyToListen') { hoqYtListen(y); return; }
  if (!y.heard) { y.heard = true; hoqYtCmd('addEventListener', ['onStateChange']); hoqYtCmd('addEventListener', ['onError']); }
  if (d.event === 'onReady') {
    y.ready = true; y.vol = -1; hoqYtVolume();
    // a seek that came while it loaded (its start= was already set)
    if (y.seekOnReady != null) { hoqYtCmd('seekTo', [y.seekOnReady, true]); y.pos = y.seekOnReady; y.at = Date.now(); y.seekOnReady = null; }
    hoqYtCmd(y.wantPlay ? 'playVideo' : 'pauseVideo');
  } else if (d.event === 'infoDelivery' || d.event === 'initialDelivery') {
    const i = d.info;
    if (!i || typeof i !== 'object') return;
    if (typeof i.currentTime === 'number') { y.pos = i.currentTime; y.at = Date.now(); }
    if (typeof i.duration === 'number' && i.duration > 0) y.dur = i.duration;
    if (i.videoData && typeof i.videoData === 'object' && i.videoData.title) y.real = { title: String(i.videoData.title), author: String(i.videoData.author || '') };
    if (typeof i.playerState === 'number') hoqYtState(y, i.playerState);
  } else if (d.event === 'onStateChange') {
    if (typeof d.info === 'number') hoqYtState(y, d.info);
  } else if (d.event === 'onError') {
    // 100: gone; 101/150: its owner keeps it off other apps; 2/5/152/153: it won't load here. The next match.
    hoqYtLoad(y.idx + 1);
  }
}

// YouTube's states: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued.
function hoqYtState(y, st) {
  if (st === y.state) return;
  const was = y.state;
  y.state = st;
  if (st === 1 || st === 3) {
    y.ready = true;
    if (st === 1) window.__hoqEverPlayed = true;   // hoqWhenIdle: music has played, so wait for a real pause
    // it autoplayed after you'd paused from the bar while it loaded; later, you pressed play on the video
    if (!y.wantPlay) { if (Date.now() - y.loadAt < 15000) hoqYtCmd('pauseVideo'); else y.wantPlay = true; }
  } else if (st === 2 && (was === 1 || was === 3)) y.wantPlay = false;   // paused on the video itself
  else if (st === 0) hoqYtEnded(y);
  hoqYtPaint();
  hoqYtRenderHead();
}

function hoqYtEnded(y) {
  if (y.endedFor === y.vid) return;
  y.endedFor = y.vid;
  const rp = document.querySelector('.playControls .repeatControl');
  if (rp && rp.classList.contains('m-one')) { y.endedFor = ''; y.wantPlay = true; hoqYtCmd('seekTo', [0, true]); hoqYtCmd('playVideo'); return; }
  y.wantPlay = false;
  if (hoqYtJamDrives()) return;   // the jam's queue says what plays next
  if (y.manual) {
    // SoundCloud's queue never had this song: go on down the list it was pressed in
    // (another Go+ song comes back here; anything else SoundCloud plays itself)
    const nb = hoqGoNextBtn(y.btn);
    if (nb) { y.advancing = true; nb.click(); }
    return;
  }
  const nx = document.querySelector('.playControls__next, .skipControl__next');
  if (nx) { y.advancing = true; nx.click(); }
}
// The play button after this one in the same page (the next row of the list).
function hoqGoNextBtn(btn) {
  if (!btn || !btn.isConnected) return null;
  const me = btn.matches('.sc-button-play') ? btn : btn.querySelector('.sc-button-play');
  if (!me) return null;
  const all = [...btn.ownerDocument.querySelectorAll('.sc-button-play')].filter((b) => !b.closest('.playControls, #hoq-yt'));
  const i = all.indexOf(me);
  return i >= 0 ? all[i + 1] || null : null;
}
function hoqYtJamDrives() {
  try { const s = hoqJamSess(); return !!(s && _jam && (s.host ? (_jam.queue || []).length > 0 : _jamGuest.following)); } catch (e) { return false; }
}

// A Go+ song SoundCloud refused outright (pressed, never in its player bar, which may
// still show the song before): what's playing is ours to say, for Discord, Last.fm,
// stats, jams, the compact player and the player bar. null otherwise.
function hoqYtSolo() {
  const y = _yt;
  if (!y || !y.manual || !y.want) return null;
  const w = y.want;
  return { url: 'https://soundcloud.com' + y.path, title: w.title || '', artist: w.artist || '', cover: w.art || '', userUrl: w.userUrl || '' };
}

function hoqYtPos() {
  const y = _yt;
  if (!y) return 0;
  const p = y.pos + (y.state === 1 ? (Date.now() - y.at) / 1000 : 0);
  return y.dur > 0 ? Math.min(y.dur, p) : p;
}
// playerProgress() for a Go+ song on YouTube (null otherwise).
function hoqYtProgress() {
  const y = _yt;
  if (!y) return null;
  // still finding or loading it counts as playing, so a jam or Discord doesn't flicker to paused
  const starting = !y.ready && Date.now() - y.t0 < 12000;
  return { pos: Math.floor(hoqYtPos()), dur: Math.round(y.dur || 0), paused: !y.wantPlay || !(y.state === 1 || y.state === 3 || starting) };
}
// Whatever is actually playing, from whichever player has it.
function hoqMediaNow() {
  if (_yt) { const p = hoqYtProgress(); return { playing: !p.paused && _yt.ready, pos: hoqYtPos(), dur: _yt.dur || 0 }; }
  const el = window.__hoqMediaEl;
  return el ? { playing: !el.paused, pos: el.currentTime || 0, dur: isFinite(el.duration) ? el.duration : 0 } : null;
}

function hoqYtPlay() {
  const y = _yt;
  if (!y) return;
  y.wantPlay = true;
  if (y.state === 0) { y.endedFor = ''; hoqYtCmd('seekTo', [0, true]); }
  hoqYtCmd('playVideo');
  hoqYtPaint();
}
function hoqYtPause() { const y = _yt; if (!y) return; y.wantPlay = false; hoqYtCmd('pauseVideo'); hoqYtPaint(); }
function hoqYtToggle() { const p = hoqYtProgress(); if (!p) return; if (p.paused) hoqYtPlay(); else hoqYtPause(); }
// window.__hoqMedia (media keys, compact player): true when the YouTube player took it.
function hoqYtMedia(action) {
  if (!_yt) return false;
  if (action === 'next' || action === 'prev') return false;   // SoundCloud's queue
  if (action === 'stop' || action === 'pause') hoqYtPause();
  else if (action === 'play') hoqYtPlay();
  else hoqYtToggle();
  return true;
}
// hoqSeek(): true when the YouTube player took it.
function hoqYtSeek(sec) {
  const y = _yt;
  if (!y) return false;
  if (!(sec >= 0)) return true;
  if (y.ready) { hoqYtCmd('seekTo', [sec, true]); y.pos = sec; y.at = Date.now(); hoqYtPaint(); }
  else {
    // still finding it: it starts there. Already loading: there once it's ready.
    y.startAt = sec; y.pos = sec;
    if (y.frame) y.seekOnReady = sec;
  }
  return true;
}
// The app's own volume (the slider, the compact player) on the YouTube player too.
function hoqYtVolume() {
  const y = _yt;
  if (!y || !y.ready) return;
  let v = 1;
  try { if (window.__scGetVolume) v = window.__scGetVolume(); } catch (e) {}
  const want = Math.round(Math.max(0, Math.min(1, +v || 0)) * 100);
  if (want === y.vol) return;
  y.vol = want;
  hoqYtCmd('setVolume', [want]);
  hoqYtCmd(want === 0 ? 'mute' : 'unMute');
}

// Our presses on SoundCloud's own play button (pause its preview, play the next song).
function hoqScPress() {
  const b = document.querySelector('.playControls__play');
  if (!b) return;
  _scPressAt = Date.now();
  _ytBypass = true;
  try { b.click(); } finally { _ytBypass = false; }
}
// once per 1.5 s: the button's state lags a press, and a second press would undo it
function hoqScPause() { if (Date.now() - _scPressAt > 1500 && !hoqScProgress().paused) hoqScPress(); }
function hoqScPlay() { if (Date.now() - _scPressAt > 1500 && hoqScProgress().paused) hoqScPress(); }

function hoqYtStop(keepCard) {
  const y = _yt;
  _yt = null;
  if (y && y.frame) { try { y.frame.remove(); } catch (e) {} }
  const box = document.getElementById('hoq-yt');
  if (box && !keepCard) box.remove();
  hoqYtPaint();
}
// Nothing on YouTube would do: say so for a moment, and SoundCloud's preview plays.
function hoqYtGiveUp(msg) {
  const y = _yt;
  if (!y) return;
  _goSkip = y.path;
  const resume = y.wantPlay, path = y.path;
  hoqYtStop(true);
  const box = document.getElementById('hoq-yt');
  if (box) {
    box.classList.add('gone');
    box.querySelector('.hoq-yt-sub').textContent = 'The 30-second preview plays instead';
    box.querySelector('.hoq-yt-vid').innerHTML = '<div class="hoq-yt-msg">' + hoqEsc(msg) + '</div>';
    box.querySelectorAll('.hoq-yt-next').forEach((b) => { b.hidden = true; });
    setTimeout(() => { if (!_yt && box.isConnected) box.remove(); }, 7000);
  }
  // (still this song: you may have moved on, or paused something else, meanwhile)
  if (resume) setTimeout(() => { if (!_yt && hoqSamePath(hoqGoPath(), path)) hoqScPlay(); }, 1600);
}

// The card: our own little player around the video. The song's cover, title and
// artist (SoundCloud's), our play / seek controls in the accent, "wrong song" and
// close. The video itself stays fully on screen, uncovered (the embed's terms want
// that), with its own controls hidden in favour of ours. Dragged by its top row;
// where you leave it is kept.
const HOQ_YT_IC = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.7v12.6c0 .8.9 1.3 1.6.9l9.9-6.3c.6-.4.6-1.4 0-1.8L9.6 4.8C8.9 4.4 8 4.9 8 5.7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>',
  swap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3l4 4-4 4"/><path d="M21 7H9a4 4 0 0 0-4 4"/><path d="M7 21l-4-4 4-4"/><path d="M3 17h12a4 4 0 0 0 4-4"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};
function hoqYtCard() {
  let box = document.getElementById('hoq-yt');
  if (box && box.classList.contains('gone')) { box.remove(); box = null; }
  if (!box) {
    hoqYtCss();
    box = document.createElement('div');
    box.id = 'hoq-yt';
    box.innerHTML =
      '<div class="hoq-yt-vid"><div class="hoq-yt-msg">Finding the full song…</div></div>' +
      '<div class="hoq-yt-top" title="Drag to move">' +
        '<i class="hoq-yt-art"></i>' +
        '<span class="hoq-yt-t"><b class="hoq-yt-title">Full song</b><span class="hoq-yt-sub">Finding it…</span></span>' +
        '<button type="button" class="hoq-yt-btn hoq-yt-next" title="Not this song? Try the next one" hidden>' + HOQ_YT_IC.swap + '</button>' +
        '<button type="button" class="hoq-yt-btn hoq-yt-x" title="Close (back to the 30-second preview)">' + HOQ_YT_IC.x + '</button>' +
      '</div>' +
      '<div class="hoq-yt-ctl">' +
        '<button type="button" class="hoq-yt-pp" title="Play / pause"><span class="i-play">' + HOQ_YT_IC.play + '</span><span class="i-pause">' + HOQ_YT_IC.pause + '</span></button>' +
        '<span class="hoq-yt-t0"></span>' +
        '<div class="hoq-yt-seek"><div class="hoq-yt-fill"></div><div class="hoq-yt-knob"></div></div>' +
        '<span class="hoq-yt-t1"></span>' +
      '</div>';
    document.body.appendChild(box);
    box.querySelector('.hoq-yt-next').addEventListener('click', () => { if (_yt && _yt.cands) { _yt.startAt = 0; hoqYtLoad(_yt.idx + 1); } });
    box.querySelector('.hoq-yt-x').addEventListener('click', () => { if (_yt) { _goSkip = _yt.path; hoqYtStop(); } else box.remove(); });
    box.querySelector('.hoq-yt-pp').addEventListener('click', () => hoqYtToggle());
    // seek: press or drag along the bar
    const seek = box.querySelector('.hoq-yt-seek');
    const seekAt = (x) => { const r = seek.getBoundingClientRect(); if (_yt && _yt.dur > 0 && r.width > 0) hoqYtSeek(Math.max(0, Math.min(1, (x - r.left) / r.width)) * _yt.dur); };
    seek.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      seekAt(e.clientX);
      box.classList.add('drag');
      const mv = (ev) => seekAt(ev.clientX);
      const up = () => { window.removeEventListener('mousemove', mv, true); window.removeEventListener('mouseup', up, true); box.classList.remove('drag'); };
      window.addEventListener('mousemove', mv, true);
      window.addEventListener('mouseup', up, true);
    });
    hoqYtDrag(box);
  }
  hoqYtPlace(box);
  return box;
}
function hoqYtPlace(box) {
  let p = null;
  try { p = JSON.parse(localStorage.getItem('hoqYtPos') || 'null'); } catch (e) {}
  if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return;   // bottom left, above the player bar
  const w = box.offsetWidth || 372, h = box.offsetHeight || 300;
  box.style.left = Math.round(Math.max(0, Math.min(innerWidth - w, p.x))) + 'px';
  box.style.top = Math.round(Math.max(40, Math.min(innerHeight - h - 4, p.y))) + 'px';
  box.style.bottom = 'auto';
}
function hoqYtDrag(box) {
  box.querySelector('.hoq-yt-top').addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const r = box.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    box.classList.add('drag');   // the video can't swallow the mouse halfway
    const move = (ev) => {
      box.style.left = Math.round(Math.max(0, Math.min(innerWidth - r.width, ev.clientX - dx))) + 'px';
      box.style.top = Math.round(Math.max(40, Math.min(innerHeight - r.height - 4, ev.clientY - dy))) + 'px';
      box.style.bottom = 'auto';
    };
    const up = () => {
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', up, true);
      box.classList.remove('drag');
      try { localStorage.setItem('hoqYtPos', JSON.stringify({ x: parseFloat(box.style.left) || 0, y: parseFloat(box.style.top) || 0 })); } catch (e2) {}
    };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up, true);
  });
}
function hoqYtRenderHead() {
  const y = _yt, box = document.getElementById('hoq-yt');
  if (!y || !box) return;
  const w = y.want || {};
  const title = w.title || 'Full song', artist = w.artist || '';
  const tEl = box.querySelector('.hoq-yt-title');
  if (tEl.textContent !== title) { tEl.textContent = title; tEl.title = title; }
  let sub = artist;
  const v = y.cands && y.cands[y.idx];
  if (!v) sub = 'Finding the full song…';
  // the browser held back autoplay (no click in the app yet this session)
  else if (y.ready && y.wantPlay && (y.state === -1 || y.state === 5) && Date.now() - y.loadAt > 8000) sub = 'Press play to start';
  const sEl = box.querySelector('.hoq-yt-sub');
  if (sEl.textContent !== sub) sEl.textContent = sub;
  const art = box.querySelector('.hoq-yt-art'), au = w.art ? 'url("' + w.art + '")' : '';
  if (art.style.backgroundImage !== au) art.style.backgroundImage = au;
  const nx = box.querySelector('.hoq-yt-next'), more = !!(y.cands && y.idx + 1 < y.cands.length);
  if (nx.hidden === more) nx.hidden = !more;
  const msg = box.querySelector('.hoq-yt-msg');
  if (msg && msg.hidden !== !!y.frame) msg.hidden = !!y.frame;
}

const hoqYtFmt = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = String(s % 60).padStart(2, '0');
  return h ? h + ':' + String(m).padStart(2, '0') + ':' + x : m + ':' + x;
};
// SoundCloud's bar shows the YouTube player's time and play state. The numbers go
// through a stylesheet rule (CSSOM): no DOM writes, so no page observer wakes 4×/s.
function hoqYtVars() {
  const sh = _ytVarRule && _ytVarRule.parentStyleSheet;
  if (sh && sh.ownerNode && sh.ownerNode.isConnected) return _ytVarRule.style;
  hoqYtCss();
  const st = document.getElementById('hoq-yt-css');
  if (!st || !st.sheet) return null;
  _ytVarRule = st.sheet.cssRules[st.sheet.insertRule(':root {}', st.sheet.cssRules.length)];
  return _ytVarRule.style;
}
function hoqYtPaint() {
  const de = document.documentElement, y = _yt, p = y ? hoqYtProgress() : null;
  const solo = hoqYtSolo();
  de.classList.toggle('hoq-yt-on', !!y);
  de.classList.toggle('hoq-yt-playing', !!(p && !p.paused));
  de.classList.toggle('hoq-yt-solo', !!solo);
  const vs = (y || _ytVarRule) ? hoqYtVars() : null;
  if (!vs) return;
  if (!y) { ['--hoq-yt-p', '--hoq-yt-t0', '--hoq-yt-t1', '--hoq-yt-cover', '--hoq-yt-label'].forEach((k) => vs.removeProperty(k)); return; }
  const pos = hoqYtPos(), dur = y.dur || 0;
  vs.setProperty('--hoq-yt-p', dur > 0 ? Math.min(1, pos / dur).toFixed(4) : '0');
  vs.setProperty('--hoq-yt-t0', JSON.stringify(hoqYtFmt(pos)));
  vs.setProperty('--hoq-yt-t1', JSON.stringify(hoqYtFmt(dur)));
  // a song SoundCloud refused: its bar may still show the song before, so it shows this one
  if (solo) {
    const label = JSON.stringify(solo.title) + ' "\\A " ' + JSON.stringify(solo.artist);
    if (vs.getPropertyValue('--hoq-yt-label') !== label) vs.setProperty('--hoq-yt-label', label);
    const cov = solo.cover ? 'url(' + JSON.stringify(solo.cover) + ')' : 'none';
    if (vs.getPropertyValue('--hoq-yt-cover') !== cov) vs.setProperty('--hoq-yt-cover', cov);
  }
}

function hoqYtCss() {
  if (document.getElementById('hoq-yt-css')) return;
  const st = document.createElement('style');
  st.id = 'hoq-yt-css';
  st.textContent = `
    #hoq-yt { position: fixed; left: 16px; bottom: 66px; z-index: 99990; width: 372px; box-sizing: border-box; padding: 8px;
      border-radius: 16px; overflow: hidden; color: #ececf1;
      background: linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0) 120px), rgba(14,14,19,0.84);
      border: 1px solid rgba(255,255,255,0.1); box-shadow: 0 16px 44px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.06);
      backdrop-filter: blur(30px) saturate(1.7); -webkit-backdrop-filter: blur(30px) saturate(1.7);
      font: 500 12px Inter,-apple-system,"Segoe UI",Arial,sans-serif; }
    #hoq-yt .hoq-yt-vid { position: relative; width: 356px; height: 200px; border-radius: 10px; overflow: hidden; background: #000; }
    #hoq-yt .hoq-yt-vid iframe { display: block; width: 356px; height: 200px; border: 0; }
    #hoq-yt.drag iframe { pointer-events: none; }
    #hoq-yt .hoq-yt-msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 0 28px;
      text-align: center; color: #a8a8b2; font-size: 12.5px; line-height: 1.4;
      background: radial-gradient(120% 90% at 50% 40%, color-mix(in srgb, var(--sc-accent, #ff5500) 22%, #0d0d10), #0b0b0e); }
    #hoq-yt .hoq-yt-msg[hidden] { display: none; }
    #hoq-yt .hoq-yt-top { display: flex; align-items: center; gap: 10px; padding: 10px 2px 2px 2px; cursor: move; user-select: none; }
    #hoq-yt .hoq-yt-art { flex: none; width: 40px; height: 40px; border-radius: 8px; background: #22222a center / cover no-repeat;
      box-shadow: 0 2px 8px rgba(0,0,0,0.35); }
    #hoq-yt .hoq-yt-t { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; line-height: 1.25; }
    #hoq-yt .hoq-yt-title { color: #fff; font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #hoq-yt .hoq-yt-sub { color: #9a9aa6; font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #hoq-yt .hoq-yt-btn { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 0;
      border: 0; border-radius: 9px; background: transparent; color: #a6a6b0; cursor: pointer; transition: background .12s ease, color .12s ease; }
    #hoq-yt .hoq-yt-btn:hover { background: rgba(255,255,255,0.09); color: #fff; }
    #hoq-yt .hoq-yt-btn svg { width: 15px; height: 15px; }
    #hoq-yt .hoq-yt-btn[hidden] { display: none; }
    #hoq-yt .hoq-yt-ctl { display: flex; align-items: center; gap: 10px; padding: 8px 4px 2px 2px; }
    #hoq-yt .hoq-yt-pp { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; padding: 0;
      border: 0; border-radius: 50%; cursor: pointer; color: #fff;
      background: var(--sc-accent-bg, var(--sc-accent, #ff5500)); box-shadow: 0 3px 10px rgba(0,0,0,0.4); transition: filter .12s ease, transform .1s ease; }
    #hoq-yt .hoq-yt-pp:hover { filter: brightness(1.1); }
    #hoq-yt .hoq-yt-pp:active { transform: scale(.94); }
    #hoq-yt .hoq-yt-pp svg { width: 15px; height: 15px; display: block; }
    #hoq-yt .hoq-yt-pp .i-pause { display: none; }
    html.hoq-yt-playing #hoq-yt .hoq-yt-pp .i-play { display: none; }
    html.hoq-yt-playing #hoq-yt .hoq-yt-pp .i-pause { display: block; }
    #hoq-yt .hoq-yt-t0, #hoq-yt .hoq-yt-t1 { flex: none; min-width: 30px; font-size: 11px; color: #8e8e99; font-variant-numeric: tabular-nums; }
    #hoq-yt .hoq-yt-t1 { text-align: right; }
    #hoq-yt .hoq-yt-t0::after { content: var(--hoq-yt-t0, "0:00"); color: #c9c9d2; }
    #hoq-yt .hoq-yt-t1::after { content: var(--hoq-yt-t1, "0:00"); }
    #hoq-yt .hoq-yt-seek { position: relative; flex: 1 1 auto; height: 16px; cursor: pointer; }
    #hoq-yt .hoq-yt-seek::before { content: ''; position: absolute; left: 0; right: 0; top: 6px; height: 4px; border-radius: 99px; background: rgba(255,255,255,0.14); }
    #hoq-yt .hoq-yt-fill { position: absolute; left: 0; top: 6px; height: 4px; border-radius: 99px; width: calc(var(--hoq-yt-p, 0) * 100%);
      background: var(--sc-accent-bg, var(--sc-accent, #ff5500)); }
    #hoq-yt .hoq-yt-knob { position: absolute; top: 3px; left: calc(var(--hoq-yt-p, 0) * 100%); width: 10px; height: 10px; margin-left: -5px;
      border-radius: 50%; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,0.5); opacity: 0; transition: opacity .12s ease; }
    #hoq-yt .hoq-yt-seek:hover .hoq-yt-knob, #hoq-yt.drag .hoq-yt-knob { opacity: 1; }
    #hoq-yt.gone .hoq-yt-vid { height: auto; background: none; }
    #hoq-yt.gone .hoq-yt-msg { position: static; padding: 14px 12px; background: none; justify-content: flex-start; text-align: left; }
    #hoq-yt.gone .hoq-yt-ctl { display: none; }
    html.hoq-yt-on .playControls .playbackTimeline__progressBar { width: calc(var(--hoq-yt-p, 0) * 100%) !important; transition: none !important; }
    html.hoq-yt-on .playControls .playbackTimeline__progressHandle { left: calc(var(--hoq-yt-p, 0) * 100%) !important; transition: none !important; }
    html.hoq-yt-on .playControls .playbackTimeline__timePassed > *, html.hoq-yt-on .playControls .playbackTimeline__duration > * { display: none !important; }
    html.hoq-yt-on .playControls .playbackTimeline__timePassed::after { content: var(--hoq-yt-t0, ""); color: #c9c9d2; }
    html.hoq-yt-on .playControls .playbackTimeline__duration::after { content: var(--hoq-yt-t1, ""); }
    html.hoq-yt-playing .playControls .playControls__play { background-image: none !important; position: relative !important; }
    html.hoq-yt-playing .playControls .playControls__play svg { visibility: hidden !important; }
    html.hoq-yt-playing .playControls .playControls__play::after { content: ''; position: absolute; left: 50%; top: 50%; width: 11px; height: 12px;
      transform: translate(-50%, -50%); box-sizing: border-box; border-left: 4px solid #fff; border-right: 4px solid #fff; pointer-events: none; }
    /* a song SoundCloud refused isn't in its bar: the bar's song slot shows it instead
       of whatever was there before (that one's links can't be clicked meanwhile) */
    html.hoq-yt-solo .playControls .playbackSoundBadge { position: relative !important; }
    html.hoq-yt-solo .playControls .playbackSoundBadge > * { visibility: hidden !important; }
    html.hoq-yt-solo .playControls .playbackSoundBadge::before { content: ''; position: absolute; left: 0; top: 50%; width: 30px; height: 30px;
      transform: translateY(-50%); border-radius: 4px; background: #22222a var(--hoq-yt-cover, none) center / cover no-repeat; visibility: visible; }
    html.hoq-yt-solo .playControls .playbackSoundBadge::after { content: var(--hoq-yt-label, ""); position: absolute; left: 40px; right: 4px; top: 50%;
      transform: translateY(-50%); white-space: pre; overflow: hidden; text-overflow: ellipsis; visibility: visible;
      font: 600 12px/1.4 Inter,-apple-system,"Segoe UI",Arial,sans-serif; color: #ececf1; }
  `;
  (document.head || document.documentElement).appendChild(st);
}

// Each tick while YouTube has the song: a player that never answered gets the next
// match, the app's volume follows, the card's text stays current.
function hoqYtKeep() {
  const y = _yt;
  if (!y) return;
  if (y.frame && !y.heard && Date.now() - y.loadAt > 15000) hoqYtLoad(y.idx + 1);
  hoqYtVolume();
  hoqYtRenderHead();
}

// Every half second: a Go+ preview just started → YouTube; the song changed → back to SoundCloud.
function hoqGoTick() {
  if (!hoqHasHost() || window.top !== window) return;
  const path = hoqGoPath();
  // No song in the bar: SoundCloud redrawing it, most likely. Only a bar that stays
  // empty ends the YouTube song; a blink mustn't stop it or forget a closed card.
  if (!path) {
    if (!_goNoPathSince) _goNoPathSince = Date.now();
    if (_yt && !_yt.manual && Date.now() - _goNoPathSince > 5000) hoqYtStop();
    // a song SoundCloud refused never reaches its bar: an empty bar is normal then,
    // and the player still needs looking after
    if (_yt && _yt.manual) hoqYtKeep();
    return;
  }
  _goNoPathSince = 0;
  const y = _yt;
  if (y && !hoqSamePath(path, y.path) && !(y.manual && hoqSamePath(path, y.barAt))) {
    // you moved on (Next, another song): that one plays, even after a paused preview
    const go = y.wantPlay || y.advancing;
    hoqYtStop();
    if (go) setTimeout(() => { if (!_yt && hoqSamePath(hoqGoPath(), path)) hoqScPlay(); }, 900);
  }
  if (_goSkip && !hoqSamePath(path, _goSkip)) _goSkip = '';
  const scOn = !hoqScProgress().paused;
  if (_yt) {
    // SoundCloud's preview started up again (a play button we don't catch): the video plays instead
    if (scOn) { hoqScPause(); hoqYtPlay(); }
    hoqYtKeep();
    return;
  }
  if (!hoqGoOn() || (_goSkip && hoqSamePath(path, _goSkip))) return;
  const info = hoqGoLookup(path);   // asked once a song is in the bar, so it's known by the time it plays
  if (!scOn || !info || !info.snip) return;
  // SoundCloud is playing it in full after all (a Go+ account whose sign-in the page
  // couldn't read): leave it. A preview's stream is 30 s long.
  const el = window.__hoqMediaEl;
  if (el && !el.paused && isFinite(el.duration) && el.duration > 45) return;
  hoqYtStart(path, info.want);
}

// ---- Phone site: soundcloud.com links stay in the app -------------------------
// On sc.holdonquietly.com a link to soundcloud.com itself (the new app's frames
// build some from SoundCloud's own data, and our own rows link the public page)
// left the site, and from the Home Screen app iOS hands soundcloud.com to the
// SoundCloud app. On the proxy such a link goes through this page's own router
// instead: a relative link clicked in the top page, which SoundCloud's app
// navigates to without a reload, so the music keeps playing.
const HOQ_SC_HOST = /^(www\.|m\.)?soundcloud\.com$/i;
const hoqOnProxy = () => /(^|\.)holdonquietly\.com$/i.test(location.hostname);
function hoqScPath(href) {
  try {
    const u = new URL(href, location.href);
    return HOQ_SC_HOST.test(u.hostname) ? (u.pathname + u.search + u.hash) || '/' : null;
  } catch (e) { return null; }
}
function hoqSoftNav(path) {
  try {
    const d = window.top.document;
    const a = d.createElement('a');
    a.href = path;
    a.style.display = 'none';
    d.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e) { try { window.top.location.assign(path); } catch (er) {} }
}
function attachScLinkGuard(doc) {
  if (!hoqOnProxy() || !doc || doc.__hoqScGuard) return;
  doc.__hoqScGuard = true;
  const w = doc.defaultView || window;
  w.addEventListener('click', (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    const p = hoqScPath(a.getAttribute('href'));
    if (p == null) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    hoqSoftNav(p);
  }, true);
  if (typeof w.open === 'function' && !w.open.__hoq) {
    const open0 = w.open;
    const open1 = function (u) {
      const p = hoqScPath(String(u || ''));
      if (p != null) { hoqSoftNav(p); return null; }
      return open0.apply(this, arguments);
    };
    open1.__hoq = true;
    w.open = open1;
  }
}
if (window.top === window) attachScLinkGuard(document);

// ---- A play press that SoundCloud answers with its Go+ sales page ----------------
// A track only Go+ can play doesn't even get a 30-second preview: pressing play
// opens SoundCloud's Go+ checkout instead (the host stops that page loading and
// calls __hoqGoAd). So nothing ever reaches the player bar for hoqGoTick to catch.
// Remember which track's play button was just pressed (in the page and in the
// new-app frames: Home, the new track page) and play that one in full here.
var _goPress = null;   // { path, t }
const HOQ_NOT_TRACK = /^\/(discover|search|you|stream|feed|charts|tags|pages|upload|settings|messages|notifications|people|terms-of-use|imprint)(\/|$)/;
function hoqPressedPath(btn, doc) {
  const row = btn.closest('.soundList__item, .soundBadge, .trackItem, .compactTrackListItem, .queueItemView, [role="listitem"], .MuiCard-root, .sound, li, article');
  for (const a of (row ? row.querySelectorAll('a[href]') : [])) {
    const p = hoqTrackPath(a.href || '');
    if (p && p.split('/').filter(Boolean).length === 2 && !HOQ_NOT_TRACK.test(p)) return p;
  }
  // the big play button on a track's own page
  if (btn.closest('.fullHero, .fullListenHero, .listenHero, section[aria-label="Track header"]')) {
    const p = (doc.defaultView || window).location.pathname.replace(/^\/n\//, '/');
    if (p.split('/').filter(Boolean).length === 2 && !HOQ_NOT_TRACK.test(p)) return p;
  }
  return '';
}
function attachGoPress(doc) {
  if (!doc || doc.__hoqGoPress) return;
  doc.__hoqGoPress = true;
  // on the window, capturing: SoundCloud stops a press on a Go+ play button there,
  // before it ever reaches the document
  (doc.defaultView || window).addEventListener('click', (e) => {
    if (_ytBypass) return;
    const b = e.target && e.target.closest && e.target.closest('.sc-button-play, .playButton, .soundTitle__playButton, .entity-card__play-button, button[aria-label="Play"], [role="button"][aria-label="Play"]');
    if (!b) return;
    const path = hoqPressedPath(b, doc);
    if (!path) return;
    _goPress = { path, t: Date.now(), btn: b };
    // Signed out (and on some pages signed in) SoundCloud greys the button out
    // ("Unavailable") and a press does nothing at all, not even the sales page.
    // That press is ours: play it right away.
    if (hoqGoOn() && hoqHasHost() && (b.matches('.sc-button-disabled') || b.querySelector('.sc-button-disabled'))) {
      e.preventDefault(); e.stopImmediatePropagation();
      _goPress = null;
      hoqGoManual(path, b, true);
    }
  }, true);
}
window.__hoqGoAd = function (url) {
  const p = _goPress;
  _goPress = null;
  if (!p || Date.now() - p.t > 6000) return;
  hoqGoManual(p.path, p.btn, false);
};
// Play a track SoundCloud refused outright, in full from YouTube. `press`: straight
// from its play button, so pressing it again while it plays pauses / plays it.
var _goManualFor = '';
function hoqGoManual(path, btn, press) {
  if (!hoqGoOn() || !hoqHasHost()) return;
  if (_yt && hoqSamePath(_yt.path, path)) { if (press) hoqYtToggle(); return; }
  if (hoqSamePath(_goManualFor, path)) return;   // already being looked up
  _goManualFor = path;
  _goSkip = '';
  let n = 0;
  const go = () => {
    const info = hoqGoLookup(path);
    if (info === undefined && ++n < 40) { setTimeout(go, 250); return; }
    _goManualFor = '';
    if (!info || !info.want) {
      try { window.__hoqUpdate && window.__hoqUpdate('notice', 'Couldn’t play that one', 'SoundCloud didn’t answer about it. Try again in a moment.'); } catch (e) {}
      return;
    }
    if (_yt) hoqYtStop();
    hoqYtStart(path, info.want);
    // The player bar never got this track (SoundCloud refused it): it may still show
    // the song before. That isn't "you moved on", so the tick leaves this one be.
    if (_yt) { _yt.manual = true; _yt.barAt = hoqGoPath(); _yt.btn = btn || null; hoqYtPaint(); }
  };
  go();
}
if (window.top === window) attachGoPress(document);

// While YouTube has the song: SoundCloud's play button (and the song's own big one on
// its page), its seek bar and Space work the YouTube player. Capture on window, ahead
// of every listener SoundCloud has; our own presses (_ytBypass) go through.
if (window.top === window) {
  window.addEventListener('message', hoqYtOnMsg);
  window.addEventListener('click', (e) => {
    if (!_yt || _ytBypass) return;
    const t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    let hit = !!t.closest('.playControls__play');
    if (!hit && t.closest('.fullHero .sc-button-play, .fullListenHero .sc-button-play, .listenHero .sc-button-play')) hit = hoqSamePath(location.pathname, _yt.path);
    if (hit) { e.preventDefault(); e.stopImmediatePropagation(); hoqYtToggle(); return; }
    if (t.closest('.playControls .playbackTimeline__progressWrapper')) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  window.addEventListener('mousedown', (e) => {
    if (!_yt || _ytBypass || e.button !== 0) return;
    const w = e.target && e.target.closest && e.target.closest('.playControls .playbackTimeline__progressWrapper');
    if (!w) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const r = w.getBoundingClientRect();
    if (r.width > 0 && _yt.dur > 0) hoqYtSeek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * _yt.dur);
  }, true);
  window.addEventListener('keydown', (e) => {
    if (!_yt || e.repeat || e.ctrlKey || e.metaKey || e.altKey || (e.code !== 'Space' && e.key !== ' ')) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName || ''))) return;
    e.preventDefault(); e.stopImmediatePropagation();
    hoqYtToggle();
  }, true);
  window.addEventListener('resize', () => { const b = document.getElementById('hoq-yt'); if (b) hoqYtPlace(b); });
}
// For tests and DevTools: what the YouTube stand-in is doing.
window.__hoqYtInfo = () => (_yt ? {
  path: _yt.path, q: _yt.want.q, vid: _yt.vid, idx: _yt.idx, state: _yt.state, ready: _yt.ready, heard: _yt.heard,
  wantPlay: _yt.wantPlay, pos: Math.round(hoqYtPos()), dur: Math.round(_yt.dur), real: _yt.real, manual: !!_yt.manual, solo: hoqYtSolo(),
  cands: (_yt.cands || []).map((c) => c.id + ' ' + c.sec + 's ' + c.t + ' / ' + c.ch),
} : null);

function setupProfileExtras() {
  hoqPfAutoPlay();
  const bar = document.querySelector('.l-user-hero') && document.querySelector('.userInfoBar__buttons');
  if (!bar) { const r = document.getElementById('hoq-pf-res'); if (r) r.remove(); return; }
  const slug = (location.pathname.split('/')[1] || '').toLowerCase();
  if (!slug || /^(you|discover|search|stream|feed|charts|upload|settings|messages|notifications|pages|terms-of-use|people)$/.test(slug)) return;

  // When did you last open this profile? Kept per profile; this visit's "since"
  // stays fixed until the app restarts, so the New tags don't vanish on a re-render.
  if (!(slug in __hoqPf.prev)) {
    let seen = {}; try { seen = JSON.parse(localStorage.getItem('hoqProfSeen')) || {}; } catch (e) {}
    __hoqPf.prev[slug] = seen[slug] || 0;
    seen[slug] = Date.now();
    const keys = Object.keys(seen);
    if (keys.length > 600) keys.sort((a, b) => seen[a] - seen[b]).slice(0, keys.length - 600).forEach((k) => delete seen[k]);
    try { localStorage.setItem('hoqProfSeen', JSON.stringify(seen)); } catch (e) {}
  }
  const prev = __hoqPf.prev[slug];

  if (!document.getElementById('hoq-pf-css')) {
    const st = document.createElement('style');
    st.id = 'hoq-pf-css';
    st.textContent = `
      /* on the banner's bottom-right (empty space), not in the tab bar: there it
         pushed the tabs and SoundCloud's own buttons onto a second line */
      .profileHeader { position:relative !important; }
      #hoq-pf-tools { position:absolute; right:20px; bottom:20px; z-index:5; display:flex; align-items:center; gap:8px;
        padding:6px; border-radius:14px; background:rgba(12,12,16,.55); border:1px solid rgba(255,255,255,.1);
        box-shadow:0 8px 28px rgba(0,0,0,.35); backdrop-filter:blur(18px) saturate(1.4); -webkit-backdrop-filter:blur(18px) saturate(1.4); }
      /* some artists have SoundCloud's "Featured profiles" down there, and the bar
         sat on top of it: top-right on those banners */
      .profileHeader:has(.featuredProfiles) #hoq-pf-tools { bottom:auto; top:20px; }
      #hoq-pf-tools .hoq-pf-btn, #hoq-pf-tools .hoq-pf-find { height:32px; }
      /* tabs stay on one line (scroll sideways if they ever run out of room) */
      .userInfoBar__tabs { min-width:0 !important; overflow-x:auto !important; scrollbar-width:none !important; }
      .userInfoBar__tabs .g-tabs { flex-wrap:nowrap !important; white-space:nowrap !important; }
      .userInfoBar__buttons .sc-button-group { flex-wrap:nowrap !important; }
      #hoq-pf-tools .hoq-pf-btn { display:inline-flex; align-items:center; gap:7px; height:34px; padding:0 13px; border-radius:10px;
        border:1px solid rgba(255,255,255,.14); background:rgba(255,255,255,.04); color:#e8e8ee; font:600 13px/1 Inter,-apple-system,Arial,sans-serif;
        cursor:pointer; transition:background .12s ease, border-color .12s ease; white-space:nowrap; }
      #hoq-pf-tools .hoq-pf-btn:hover { background:rgba(255,255,255,.09); border-color:rgba(255,255,255,.22); color:#fff; }
      #hoq-pf-tools .hoq-pf-btn svg { width:14px; height:14px; flex:none; }
      #hoq-pf-tools .hoq-pf-play { background:color-mix(in srgb, var(--sc-accent,#ff5500) 22%, transparent); border-color:color-mix(in srgb, var(--sc-accent,#ff5500) 40%, transparent); }
      #hoq-pf-tools .hoq-pf-play:hover { background:color-mix(in srgb, var(--sc-accent,#ff5500) 34%, transparent); }
      #hoq-pf-tools .hoq-pf-shuf { width:34px; padding:0; justify-content:center; }
      .hoq-pf-find { position:relative; display:flex; align-items:center; height:34px; width:190px; padding:0 10px; box-sizing:border-box;
        border-radius:10px; border:1px solid rgba(255,255,255,.12); background:rgba(255,255,255,.04); color:#8e8e99; transition:border-color .12s ease, width .18s ease; }
      .hoq-pf-find:focus-within { border-color:color-mix(in srgb, var(--sc-accent,#ff5500) 55%, transparent); width:240px; }
      .hoq-pf-find svg { width:14px; height:14px; flex:none; }
      .hoq-pf-find input { flex:1; min-width:0; height:100%; margin:0 0 0 7px; padding:0; border:0 !important; outline:0 !important; background:none !important;
        box-shadow:none !important; color:#ececf1; font:500 13px Inter,-apple-system,Arial,sans-serif; }
      .hoq-pf-find input::placeholder { color:#7d7d88; }
      .hoq-pf-res { position:fixed; top:0; left:0; z-index:2147483000; width:380px; max-height:420px; overflow-y:auto; padding:6px;
        box-sizing:border-box; border-radius:14px; border:1px solid rgba(255,255,255,.09) !important; background:#141418 !important; opacity:1 !important; backdrop-filter:none !important;
        box-shadow:0 18px 52px rgba(0,0,0,.55); display:none; scrollbar-width:none; }
      .hoq-pf-res.show { display:block; }
      .hoq-pf-r { display:flex; align-items:center; gap:10px; padding:6px 8px; border-radius:9px; color:#ececf1 !important; text-decoration:none !important; cursor:pointer; }
      .hoq-pf-r:hover, .hoq-pf-r.sel { background:rgba(255,255,255,.07); }
      .hoq-pf-r i { flex:none; width:36px; height:36px; border-radius:6px; background:#1c1c22 center/cover no-repeat; }
      .hoq-pf-r div { flex:1; min-width:0; }
      .hoq-pf-r b { display:block; font-size:13px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:#ececf1; }
      .hoq-pf-r b mark { background:none; color:color-mix(in srgb, var(--sc-accent,#ff5500) 60%, #fff); }
      .hoq-pf-r span { display:block; margin-top:2px; font-size:11.5px; color:#8e8e99; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .hoq-pf-msg { padding:14px 10px; font-size:12.5px; color:#8e8e99; text-align:center; }
      /* You & <artist> */
      #hoq-pf-you { margin:0 0 18px; padding:14px; border-radius:14px; border:1px solid rgba(255,255,255,.07); background:rgba(255,255,255,.035);
        font-family:Inter,-apple-system,Arial,sans-serif; color:#ececf1; }
      #hoq-pf-you .hd { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:12px; font-size:13px; font-weight:600; }
      #hoq-pf-you .hd span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      #hoq-pf-you .new { flex:none; font-style:normal; padding:3px 9px; border-radius:99px; font-size:11px; font-weight:700; cursor:pointer; white-space:nowrap;
        background:color-mix(in srgb, var(--sc-accent,#ff5500) 22%, transparent); color:color-mix(in srgb, var(--sc-accent,#ff5500) 55%, #fff); }
      #hoq-pf-you .nums { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; }
      #hoq-pf-you .nums div { padding:9px 10px; border-radius:10px; background:rgba(255,255,255,.04); min-width:0; }
      #hoq-pf-you .nums b { display:block; font-size:17px; font-weight:700; color:#fff; font-variant-numeric:tabular-nums; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      #hoq-pf-you .nums span { display:block; margin-top:2px; font-size:10.5px; color:#8e8e99; }
      #hoq-pf-you .lbl { margin:14px 0 6px; font-size:11px; font-weight:600; color:#8e8e99; }
      #hoq-pf-you ol { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:2px; }
      #hoq-pf-you ol .hoq-pf-r { padding:5px 6px; }
      #hoq-pf-you ol .hoq-pf-r i { width:30px; height:30px; border-radius:5px; }
      #hoq-pf-you .foot, #hoq-pf-you .empty { margin-top:12px; font-size:11.5px; color:#7d7d88; }
      #hoq-pf-you .empty { margin-top:0; font-size:12.5px; color:#a6a6b0; }
      /* New since your last visit */
      .soundList__item .hoq-pf-newtag { display:inline-flex !important; align-items:center; height:18px; padding:0 7px !important; margin-left:8px; border-radius:99px; vertical-align:middle;
        background:var(--sc-accent,#ff5500) !important; color:#fff !important; -webkit-text-fill-color:#fff !important; font:700 10.5px/1 Inter,-apple-system,Arial,sans-serif !important; letter-spacing:.02em; text-shadow:none !important; }
    `;
    (document.head || document.documentElement).appendChild(st);
  }

  // --- toolbar: Find a track · Play all · Shuffle ---
  let tools = document.getElementById('hoq-pf-tools');
  if (tools && tools.dataset.slug !== slug) { tools.remove(); tools = null; }
  if (!tools) {
    tools = document.createElement('div');
    tools.id = 'hoq-pf-tools';
    tools.dataset.slug = slug;
    tools.innerHTML =
      '<label class="hoq-pf-find"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></svg>' +
      '<input type="text" placeholder="Find a track" spellcheck="false" autocomplete="off"></label>' +
      '<button type="button" class="hoq-pf-btn hoq-pf-play" title="Play their tracks from the newest"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 2.8v10.4a.6.6 0 0 0 .9.5l8.3-5.2a.6.6 0 0 0 0-1L5.4 2.3a.6.6 0 0 0-.9.5z"/></svg>Play all</button>' +
      '<button type="button" class="hoq-pf-btn hoq-pf-shuf" title="Shuffle their tracks"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h4v4M4 20L20 4M20 16v4h-4M15 15l5 5M4 4l5 5"/></svg></button>';
    (document.querySelector('.l-user-hero .profileHeader') || bar).appendChild(tools);
    tools.querySelector('.hoq-pf-play').addEventListener('click', () => hoqPfPlayAll(slug, false));
    tools.querySelector('.hoq-pf-shuf').addEventListener('click', () => hoqPfPlayAll(slug, true));

    const inp = tools.querySelector('input');
    // results live on <body>: the banner clips its children, and the tools' blur
    // would trap a fixed-position child inside it
    const old = document.getElementById('hoq-pf-res'); if (old) old.remove();   // one per toolbar (fresh handlers)
    const res = document.createElement('div'); res.id = 'hoq-pf-res'; res.className = 'hoq-pf-res'; document.body.appendChild(res);
    const place = () => { const r = inp.closest('.hoq-pf-find').getBoundingClientRect(); res.style.top = (r.bottom + 8) + 'px'; res.style.left = Math.max(8, Math.min(r.right - 380, window.innerWidth - 388)) + 'px'; };
    window.addEventListener('scroll', () => { if (res.isConnected && res.classList.contains('show')) place(); }, { passive: true });
    let sel = 0, hits = [];
    const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const mark = (t, q) => { const i = t.toLowerCase().indexOf(q); return i < 0 ? esc(t) : esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + q.length)) + '</mark>' + esc(t.slice(i + q.length)); };
    const render = async () => {
      const q = inp.value.trim().toLowerCase();
      place(); res.classList.add('show');
      let data;
      try { data = await hoqPfData(slug); } catch (e) { res.innerHTML = '<div class="hoq-pf-msg">Couldn’t load their tracks. Try again in a moment.</div>'; return; }
      if (inp.value.trim().toLowerCase() !== q) return;   // typed on meanwhile
      hits = (q ? data.tracks.filter((t) => t.title.toLowerCase().includes(q)) : data.tracks).slice(0, 40);
      sel = 0;
      if (!hits.length) { res.innerHTML = '<div class="hoq-pf-msg">' + (q ? 'No track called “' + esc(inp.value.trim()) + '”' : 'No tracks yet') + '</div>'; return; }
      res.innerHTML = hits.map((t, i) => '<a class="hoq-pf-r' + (i === 0 ? ' sel' : '') + '" data-i="' + i + '"><i style="background-image:url(' + esc(JSON.stringify(t.art)) + ')"></i><div><b>' + mark(t.title, q) + '</b><span>' +
        [hoqPfDate(t.date), hoqPfDur(t.dur), t.plays ? t.plays.toLocaleString() + ' plays' : ''].filter(Boolean).join(' · ') + '</span></div></a>').join('') +
        (q ? '' : '<div class="hoq-pf-msg">' + data.tracks.length + ' tracks · type to search them all</div>');
    };
    const pick = (i) => { const t = hits[i]; if (!t) return; res.classList.remove('show'); inp.value = ''; inp.blur(); hoqPfOpenAndPlay(t.path); };
    let deb = 0;
    inp.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(render, 90); });
    inp.addEventListener('focus', render);
    inp.addEventListener('keydown', (e) => {
      const rows = res.querySelectorAll('.hoq-pf-r');
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); if (!rows.length) return;
        sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
        rows.forEach((r, i) => r.classList.toggle('sel', i === sel)); rows[sel].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') { e.preventDefault(); pick(sel); }
      else if (e.key === 'Escape') { res.classList.remove('show'); inp.blur(); }
    });
    res.addEventListener('mousedown', (e) => { const r = e.target.closest('.hoq-pf-r'); if (r) { e.preventDefault(); pick(+r.dataset.i); } });
    inp.addEventListener('blur', () => setTimeout(() => res.classList.remove('show'), 120));
  }

  // --- "You & <artist>" card at the top of the sidebar ---
  const side = document.querySelector('.userSidebar');
  let card = document.getElementById('hoq-pf-you');
  if (card && card.dataset.slug !== slug) { card.remove(); card = null; }
  if (side && !card) {
    card = document.createElement('section');
    card.id = 'hoq-pf-you';
    card.dataset.slug = slug;
    side.insertBefore(card, side.querySelector('.infoStats') || side.firstChild);
    hoqPfData(slug).then((data) => {
      if (!card.isConnected) return;
      const name = data.user.username || slug, nl = name.toLowerCase();
      const s = hoqStatsShown(), local = hoqStatsRead();
      const cnt = (o) => { let n = 0; for (const k in (o || {})) if (k.toLowerCase() === nl) n += +o[k] || 0; return n; };
      const plays = cnt(s.artists);
      const ym = hoqDayKey(Date.now()).slice(0, 7);
      let month = 0, lastDay = '';
      for (const k in (s.days || {})) { const n = cnt(s.days[k].artists); if (!n) continue; if (k.slice(0, 7) === ym) month += n; if (k > lastDay) lastDay = k; }
      const af = (local.af || {})[nl];
      const last = af ? af[1] : (lastDay ? new Date(+lastDay.slice(0, 4), +lastDay.slice(5, 7) - 1, +lastDay.slice(8, 10)).getTime() : 0);
      const first = af && af[0] ? af[0] : 0;
      // your most-played tracks of theirs: your per-title counts matched to their catalogue
      const byTitle = {};
      for (const k in (s.tracks || {})) byTitle[k.toLowerCase()] = (byTitle[k.toLowerCase()] || 0) + (+s.tracks[k] || 0);
      const top = data.tracks.map((t) => ({ t, n: byTitle[t.title.toLowerCase()] || 0 })).filter((x) => x.n).sort((a, b) => b.n - a.n).slice(0, 3);
      const fresh = prev ? data.tracks.filter((t) => t.date > prev).length : 0;
      const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      card.innerHTML = '<div class="hd"><span>You &amp; ' + esc(name) + '</span>' +
        (fresh ? '<em class="new" title="Posted since you last opened this page (' + esc(hoqPfDate(prev)) + ')">' + fresh + ' new</em>' : '') + '</div>' +
        (plays ? '<div class="nums"><div><b>' + plays.toLocaleString() + '</b><span>plays</span></div><div><b>' + month + '</b><span>this month</span></div>' +
          '<div><b>' + (last ? esc(hoqPfDate(last)) : '—') + '</b><span>last played</span></div></div>' +
          (top.length ? '<div class="lbl">Your most played</div><ol>' + top.map(({ t, n }) => '<li class="hoq-pf-r" data-path="' + esc(t.path) + '"><i style="background-image:url(' + esc(JSON.stringify(t.art)) + ')"></i><div><b>' + esc(t.title) + '</b><span>' + n + (n === 1 ? ' play' : ' plays') + '</span></div></li>').join('') + '</ol>' : '') +
          (first ? '<div class="foot">First played ' + esc(hoqPfDate(first)) + '</div>' : '')
          : '<div class="empty">You haven’t played ' + esc(name) + ' in the app yet.</div>');
      card.querySelectorAll('li.hoq-pf-r').forEach((li) => li.addEventListener('click', () => hoqPfOpenAndPlay(li.dataset.path)));
      const nw = card.querySelector('.new');
      if (nw) nw.addEventListener('click', () => { const a = document.querySelector('.userInfoBar__tabs a[href$="/tracks"]'); if (a) a.click(); });
    }).catch(() => { if (card.isConnected) card.remove(); });
  }

  // --- "New" tag on their tracks posted since your last visit ---
  if (prev) {
    document.querySelectorAll('.soundList__item').forEach((it) => {
      if (it.dataset.hoqNv === slug) return;
      it.dataset.hoqNv = slug;
      const by = it.querySelector('.soundTitle__username');
      if (!by || (by.getAttribute('href') || '').toLowerCase() !== '/' + slug) return;
      const tm = it.querySelector('time[datetime]');
      if (!tm || Date.parse(tm.getAttribute('datetime')) <= prev) return;
      const title = it.querySelector('.soundTitle__title');
      if (title && !it.querySelector('.hoq-pf-newtag')) title.insertAdjacentHTML('afterend', '<span class="hoq-pf-newtag" title="Posted since you last opened this page">New</span>');
    });
  }
}

// The profile-tab bar and the library/collection nav lean toward the cursor
// with a lit accent lift. Same resilient closest()-based pattern as setupTilt so
// it survives SoundCloud's re-renders; gated by the "3D tab bars" toggle.
function setupTabTilt() {
  const SEL = '.userInfoBar__tabs .g-tabs-link';
  const MAX_Y = 12, MAX_X = 7, LIFT = 12;
  let cur = null, px = 0, py = 0, raf = 0;
  const reset = (t) => { if (!t) return; t.style.transform = ''; t.style.transition = 'transform .3s ease'; t.classList.remove('hoq-tt'); };
  const apply = () => {
    raf = 0; if (!cur) return;
    cur.style.transform = 'perspective(700px) rotateX(' + (-py * MAX_X).toFixed(2) + 'deg) rotateY(' +
      (px * MAX_Y).toFixed(2) + 'deg) translateZ(' + LIFT + 'px)';
  };
  document.addEventListener('mousemove', (e) => {
    if (!effectOn('tabtilt')) { if (cur) { reset(cur); cur = null; } return; }
    const t = e.target.closest && e.target.closest(SEL);
    if (t !== cur) { reset(cur); cur = t; if (cur) { cur.classList.add('hoq-tt'); cur.style.transition = 'transform .05s linear'; } }
    if (!cur) return;
    const r = cur.getBoundingClientRect(); if (!r.width) return;
    px = (e.clientX - r.left) / r.width - 0.5;
    py = (e.clientY - r.top) / r.height - 0.5;
    if (!raf) raf = requestAnimationFrame(apply);
  }, { passive: true });
  document.addEventListener('mouseleave', () => { if (cur) { reset(cur); cur = null; } if (raf) { cancelAnimationFrame(raf); raf = 0; } }, true);
}
function setupTilt() {
  const SEL = '.playableTile, .audibleTile, .homeShortcutsModule__item, .mixedSelectionModule__item';
  const MAX_Y = 20; // strong left/right lean (very visible, doesn't overflow the top)
  const MAX_X = 7;  // gentle up/down (kept small so tiles don't poke over the row above)
  const onHome = () => /^\/(discover|stream|home)?$/.test(location.pathname) || location.pathname === '/';
  let cur = null, px = 0, py = 0, raf = 0;
  const reset = (t) => { if (!t) return; t.style.transform = ''; t.style.transition = 'transform .35s ease'; t.classList.remove('hoq-tilt'); };
  // Write the transform at most once per frame. The old code set it synchronously
  // on every mousemove event (dozens/sec), thrashing layout+paint on the whole
  // tile subtree — that was the lag. rAF coalesces it to one write per frame.
  const apply = () => {
    raf = 0;
    if (!cur) return;
    cur.style.transform =
      'perspective(700px) rotateX(' + (-py * MAX_X).toFixed(2) + 'deg) rotateY(' +
      (px * MAX_Y).toFixed(2) + 'deg)';
  };

  document.addEventListener('mousemove', (e) => {
    if (!effectOn('tilt')) { if (cur) { reset(cur); cur = null; } return; }
    if (!onHome()) { if (cur) { reset(cur); cur = null; } return; }
    const tile = e.target.closest && e.target.closest(SEL);
    if (tile !== cur) {
      reset(cur);
      cur = tile;
      // Class + transition change only when the hovered tile changes, not every move.
      if (cur) { cur.classList.add('hoq-tilt'); cur.style.transition = 'transform .05s linear'; }
    }
    if (!cur) return;
    const r = cur.getBoundingClientRect();
    if (!r.width) return;
    px = (e.clientX - r.left) / r.width - 0.5;
    py = (e.clientY - r.top) / r.height - 0.5;
    if (!raf) raf = requestAnimationFrame(apply);
  }, { passive: true });

  document.addEventListener('mouseleave', () => {
    if (cur) { reset(cur); cur = null; }
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }, true);
}

// Track-page cover: follows the mouse in 3D. Only sets transform/transition — no
// position or z-index changes (those broke the layout last time).
function setupCoverTilt() {
  let art = null, px = 0, py = 0, raf = 0;
  const apply = () => {
    raf = 0;
    if (art) art.style.transform =
      'perspective(1000px) rotateY(' + (px * 17).toFixed(2) + 'deg) rotateX(' + (-py * 12).toFixed(2) + 'deg)';
  };
  document.addEventListener('mousemove', (e) => {
    if (!effectOn('tilt')) { if (art) { art.style.transition = 'transform .4s ease'; art.style.transform = ''; art = null; } return; }
    const a = e.target.closest && e.target.closest('.fullHero__artwork');
    if (a !== art) {
      if (art) { art.style.transition = 'transform .4s ease'; art.style.transform = ''; }
      art = a;
      if (art) art.style.transition = 'transform .1s ease';
    }
    if (!art) return;
    const r = art.getBoundingClientRect();
    px = (e.clientX - r.left) / r.width - 0.5;
    py = (e.clientY - r.top) / r.height - 0.5;
    if (!raf) raf = requestAnimationFrame(apply);
  }, { passive: true });
}

// Ambient mode: a big Spotify-style now-playing view. Reads the current track
// from the real player bar and mirrors it; controls call the real transport
// buttons so we never touch playback state directly. Toggled by a button we add
// into the player bar (and Esc to close).
function setupAmbientMode() {
  if (window.__hoqNp) return;
  window.__hoqNp = true;
  const big = (u) => u ? u.replace(/-t\d+x\d+\./, '-t500x500.') : '';
  const artUrl = () => {
    const el = document.querySelector('.playbackSoundBadge__avatar span.sc-artwork')
            || document.querySelector('.playControls .playbackSoundBadge__avatar span')
            || document.querySelector('.playControls .sc-artwork span');
    if (!el) return '';
    const bi = getComputedStyle(el).backgroundImage || '';
    const m = bi.match(/url\(["']?(.*?)["']?\)/);
    return m ? m[1] : '';
  };
  const txt = (sel, attr) => { const e = document.querySelector(sel); return e ? (attr ? (e.getAttribute(attr) || '') : e.textContent || '') : ''; };

  const np = document.createElement('div');
  np.id = 'hoq-np';
  np.innerHTML =
    '<canvas id="hoq-np-gl"></canvas>' +
    '<div class="np-bg"></div><div class="np-scrim"></div>' +
    '<button class="np-close" title="Close (Esc)">✕</button>' +
    '<div class="np-art"></div>' +
    '<div class="np-side"><div class="np-eyebrow">Now playing</div><h1 class="np-title"></h1><div class="np-artist"></div>' +
    '<div class="np-bar"><i></i></div><div class="np-times"><span class="np-cur">0:00</span><span class="np-dur">0:00</span></div>' +
    '<div class="np-ctrls">' +
      '<button class="np-prev" title="Previous"><svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg></button>' +
      '<button class="np-play" title="Play/Pause"></button>' +
      '<button class="np-next" title="Next"><svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/></svg></button>' +
      '<button class="np-like" title="Like"><svg viewBox="0 0 16 16" width="24" height="24" fill="currentColor"><path d="M7.978 5c.653-1.334 1.644-2 2.972-2 1.992 0 3.405 1.657 2.971 4-.289 1.561-2.27 3.895-5.943 7C4.19 10.895 2.21 8.561 2.035 7c-.26-2.343.947-4 2.972-4 1.35 0 2.34.666 2.971 2z"/></svg></button>' +
    '</div></div>';
  (document.body || document.documentElement).appendChild(np);

  let lastArt = '';
  const sync = () => {
    const solo = hoqYtSolo();   // a Go+ song YouTube plays on its own
    const u = solo ? solo.cover : big(artUrl());
    if (u && u !== lastArt) { lastArt = u; np.querySelector('.np-art').style.backgroundImage = 'url("' + u + '")'; np.querySelector('.np-bg').style.backgroundImage = 'url("' + u + '")'; }
    np.querySelector('.np-title').textContent = solo ? solo.title : (txt('.playbackSoundBadge__titleLink', 'title') || txt('.playbackSoundBadge__titleLink')).trim();
    np.querySelector('.np-artist').textContent = solo ? solo.artist : (txt('.playbackSoundBadge__lightLink', 'title') || txt('.playbackSoundBadge__lightLink')).trim();
    const ytp = hoqYtProgress();   // a Go+ song on YouTube: its time, not SoundCloud's paused preview
    np.querySelector('.np-bar i').style.width = ytp ? (ytp.dur > 0 ? Math.min(100, ytp.pos / ytp.dur * 100).toFixed(2) + '%' : '0%')
      : (document.querySelector('.playbackTimeline__progressBar') || {}).style && document.querySelector('.playbackTimeline__progressBar').style.width || '0%';
    np.querySelector('.np-cur').textContent = ytp ? hoqYtFmt(ytp.pos) : txt('.playbackTimeline__timePassed span[aria-hidden]');
    np.querySelector('.np-dur').textContent = ytp ? hoqYtFmt(ytp.dur) : txt('.playbackTimeline__duration span[aria-hidden]');
    const playing = ytp ? !ytp.paused : !!document.querySelector('.playControls__play.playing');
    np.querySelector('.np-play').innerHTML = playing
      ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    // reflect like state: accent + full opacity when the track is liked
    const liked = !!document.querySelector('.playbackSoundBadge__like.sc-button-selected');
    const lk = np.querySelector('.np-like');
    lk.style.color = liked ? 'var(--sc-accent, #ff5500)' : '#fff';
    lk.style.opacity = liked ? '1' : '.85';
    // match the real Like button's accent glow when liked
    lk.style.filter = liked ? 'drop-shadow(0 0 5px color-mix(in srgb, var(--sc-accent,#ff5500) 55%, transparent))' : 'none';
  };
  const click = (sel) => { const b = document.querySelector(sel); if (b) b.click(); setTimeout(sync, 120); };
  np.querySelector('.np-play').onclick = () => click('.playControls__play');
  np.querySelector('.np-prev').onclick = () => click('.skipControl__previous');
  np.querySelector('.np-next').onclick = () => click('.skipControl__next');
  np.querySelector('.np-like').onclick = () => click('.playbackSoundBadge__like');
  np.querySelector('.np-close').onclick = () => close();
  // click the empty backdrop (not the art/controls) to close
  np.querySelector('.np-scrim').onclick = () => close();
  np.querySelector('.np-bg').onclick = () => close();
  // seek: click the overlay bar → click the same fraction on the real timeline
  np.querySelector('.np-bar').onclick = (e) => {
    const wrap = document.querySelector('.playbackTimeline__progressWrapper');
    if (!wrap) return;
    const r = e.currentTarget.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const wr = wrap.getBoundingClientRect();
    wrap.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: wr.left + frac * wr.width, clientY: wr.top + wr.height / 2 }));
    wrap.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, clientX: wr.left + frac * wr.width, clientY: wr.top + wr.height / 2 }));
    setTimeout(sync, 150);
  };

  // Subtle 3D: the art tilts toward the cursor and the blurred background
  // parallaxes the other way for depth. rAF-throttled; honours the tilt effect.
  let tpx = 0, tpy = 0, traf = 0;
  const tiltApply = () => {
    traf = 0;
    const art = np.querySelector('.np-art'), bg = np.querySelector('.np-bg');
    if (art) art.style.transform = 'perspective(900px) rotateY(' + (tpx * 14).toFixed(1) + 'deg) rotateX(' + (-tpy * 10).toFixed(1) + 'deg)';
    if (bg) bg.style.transform = 'scale(1.15) translate(' + (-tpx * 2.4).toFixed(1) + '%,' + (-tpy * 2.4).toFixed(1) + '%)';
  };
  np.addEventListener('mousemove', (e) => {
    if (typeof effectOn === 'function' && !effectOn('tilt')) return;
    const r = np.getBoundingClientRect();
    tpx = (e.clientX - r.left) / r.width - 0.5;
    tpy = (e.clientY - r.top) / r.height - 0.5;
    if (!traf) traf = requestAnimationFrame(tiltApply);
  }, { passive: true });
  np.addEventListener('mouseleave', () => { const art = np.querySelector('.np-art'); if (art) art.style.transform = ''; });

  // --- WebGL 3D backdrop (Three.js, lazy-loaded on first open) -----------------
  // A flowing particle nebula in the track's accent colour: a soft cloud of
  // additive-blended points that breathe and drift, over a faint far starfield,
  // with the camera parallaxing to the cursor. If Three.js can't load, the
  // blurred-cover background stays and nothing breaks.
  let gl = null, glRaf = 0, glAccent = '', glBusy = false;
  const loadThree = () => new Promise((res) => {
    if (window.THREE) return res(true);
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
    s.onload = () => res(!!window.THREE); s.onerror = () => res(false);
    document.head.appendChild(s);
  });
  const accentColor = () => (getComputedStyle(document.documentElement).getPropertyValue('--sc-accent') || '#ff5500').trim() || '#ff5500';
  const recolorGL = () => {
    if (!gl) return; const acc = accentColor(); if (acc === glAccent) return; glAccent = acc;
    const T = gl.T; let col; try { col = new T.Color(acc); } catch (e) { return; }
    const hsl = {}; col.getHSL(hsl);
    gl.cloudMat.color = col.clone();
    gl.coreMat.color = new T.Color().setHSL(hsl.h, Math.min(1, hsl.s + 0.1), Math.min(0.85, hsl.l + 0.35));
    gl.starMat.color = new T.Color().setHSL(hsl.h, 0.4, 0.7);
  };
  const buildGL = () => {
    const T = window.THREE, cv = np.querySelector('#hoq-np-gl');
    const renderer = new T.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setSize(np.clientWidth, np.clientHeight);
    const scene = new T.Scene();
    const camera = new T.PerspectiveCamera(55, np.clientWidth / np.clientHeight, 0.1, 100); camera.position.z = 4.6;
    // soft round glowing dot texture so particles read as a nebula, not squares
    const dc = document.createElement('canvas'); dc.width = dc.height = 64;
    const dx = dc.getContext('2d'); const rg = dx.createRadialGradient(32, 32, 0, 32, 32, 32);
    rg.addColorStop(0, 'rgba(255,255,255,1)'); rg.addColorStop(0.35, 'rgba(255,255,255,0.55)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
    dx.fillStyle = rg; dx.fillRect(0, 0, 64, 64);
    const dot = new T.CanvasTexture(dc);
    // nebula: N particles in a soft flattened cloud; keep base positions to flow from
    const N = 3600, pos = new Float32Array(N * 3), base = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const r = Math.pow(Math.random(), 0.55) * 2.9;
      const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
      const x = r * Math.sin(ph) * Math.cos(th), y = r * Math.sin(ph) * Math.sin(th) * 0.62, z = r * Math.cos(ph);
      pos[i*3] = base[i*3] = x; pos[i*3+1] = base[i*3+1] = y; pos[i*3+2] = base[i*3+2] = z;
    }
    const cg = new T.BufferGeometry(); cg.setAttribute('position', new T.BufferAttribute(pos, 3));
    const cloudMat = new T.PointsMaterial({ size: 0.13, map: dot, transparent: true, opacity: 0.85, blending: T.AdditiveBlending, depthWrite: false });
    const cloud = new T.Points(cg, cloudMat); scene.add(cloud);
    // a small bright core for a glowing centre
    const coreMat = new T.PointsMaterial({ size: 0.3, map: dot, transparent: true, opacity: 0.8, blending: T.AdditiveBlending, depthWrite: false });
    const coreN = 300, cpos = new Float32Array(coreN * 3);
    for (let i = 0; i < coreN * 3; i++) cpos[i] = (Math.random() - 0.5) * 1.1;
    const coreG = new T.BufferGeometry(); coreG.setAttribute('position', new T.BufferAttribute(cpos, 3));
    const core = new T.Points(coreG, coreMat); scene.add(core);
    // faint far starfield for depth
    const sN = 600, spos = new Float32Array(sN * 3); for (let i = 0; i < sN * 3; i++) spos[i] = (Math.random() - 0.5) * 44;
    const sg = new T.BufferGeometry(); sg.setAttribute('position', new T.BufferAttribute(spos, 3));
    const starMat = new T.PointsMaterial({ size: 0.12, map: dot, transparent: true, opacity: 0.5, blending: T.AdditiveBlending, depthWrite: false });
    const stars = new T.Points(sg, starMat); scene.add(stars);
    gl = { renderer, scene, camera, cloud, cloudMat, core, coreMat, base, stars, starMat, clock: new T.Clock(), T };
    recolorGL();
    addEventListener('resize', () => { if (!gl) return; gl.camera.aspect = np.clientWidth / np.clientHeight; gl.camera.updateProjectionMatrix(); gl.renderer.setSize(np.clientWidth, np.clientHeight); });
  };
  const glFrame = () => {
    if (!gl) return; const t = gl.clock.getElapsedTime();
    // real audio: bass energy drives the pulse; smoothed, with a gentle idle
    // fallback when there's no analyser yet.
    let bass = 0, lvl = 0;
    const an = window.__hoqAudioAnalyser;
    if (an) {
      if (!gl.freq) gl.freq = new Uint8Array(an.frequencyBinCount);
      an.getByteFrequencyData(gl.freq);
      let bs = 0; for (let i = 1; i < 10; i++) bs += gl.freq[i]; bass = bs / (9 * 255);
      let s = 0; for (let i = 0; i < gl.freq.length; i++) s += gl.freq[i]; lvl = s / (gl.freq.length * 255);
    }
    gl.bass = (gl.bass || 0) + (bass - (gl.bass || 0)) * 0.25;      // fast attack
    gl.lvl  = (gl.lvl  || 0) + (lvl  - (gl.lvl  || 0)) * 0.1;
    const beat = an ? gl.bass : (0.35 + Math.sin(t * 1.4) * 0.12);   // idle pulse w/o audio
    const spread = 0.14 + beat * 0.34;
    // flow: displace each particle from its base along a drifting field, pushed
    // outward on the beat
    const p = gl.cloud.geometry.attributes.position.array, b = gl.base, n = b.length / 3;
    for (let i = 0; i < n; i++) {
      const bx = b[i*3], by = b[i*3+1], bz = b[i*3+2];
      p[i*3]   = bx * (1 + beat * 0.16) + Math.sin(t * 0.5 + by * 1.5) * spread;
      p[i*3+1] = by * (1 + beat * 0.16) + Math.cos(t * 0.4 + bx * 1.5) * spread;
      p[i*3+2] = bz * (1 + beat * 0.16) + Math.sin(t * 0.45 + bx * 1.2 + by * 0.8) * spread;
    }
    gl.cloud.geometry.attributes.position.needsUpdate = true;
    gl.cloud.rotation.y = t * 0.05;
    gl.cloudMat.opacity = 0.7 + Math.min(0.3, (an ? gl.lvl : 0.2) * 0.9);
    gl.core.rotation.y = -t * 0.15;
    gl.core.scale.setScalar(1 + beat * 0.9);
    gl.coreMat.opacity = 0.55 + beat * 0.45;
    gl.camera.position.x += (tpx * 0.9 - gl.camera.position.x) * 0.05;
    gl.camera.position.y += (-tpy * 0.9 - gl.camera.position.y) * 0.05;
    gl.camera.lookAt(0, 0, 0);
    gl.stars.rotation.y = t * 0.015;
    gl.renderer.render(gl.scene, gl.camera);
  };
  const ensureGL = async () => {
    if (gl || glBusy) return;
    if (typeof lowEndOn === 'function' && lowEndOn()) return; // no WebGL nebula on low-end
    glBusy = true;
    const ok = await loadThree();
    if (ok) { try {
      buildGL(); document.documentElement.classList.add('hoq-np-gl');
      const loop = () => { if (np.classList.contains('on') && !document.documentElement.classList.contains('hoq-no-anim')) glFrame(); glRaf = requestAnimationFrame(loop); };
      loop();
    } catch (e) {} }
    glBusy = false;
  };

  let iv = 0;
  const open = () => { sync(); np.classList.add('on'); document.documentElement.classList.add('hoq-np-open'); ensureGL(); if (!iv) iv = setInterval(() => { if (np.classList.contains('on')) { sync(); recolorGL(); } }, 500); };
  const close = () => { np.classList.remove('on'); document.documentElement.classList.remove('hoq-np-open'); };
  window.__hoqNpToggle = () => (np.classList.contains('on') ? close() : open());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && np.classList.contains('on')) close(); });

  // Add the trigger button into the player bar; re-add on the interval since the
  // badge re-renders per track.
  const addBtn = () => {
    const actions = document.querySelector('.playbackSoundBadge__actions');
    if (!actions || actions.querySelector('#hoq-ambient-btn')) return;
    const b = document.createElement('button');
    b.id = 'hoq-ambient-btn'; b.title = 'Ambient mode';
    b.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M4 4h7v2H6v5H4V4zm9 0h7v7h-2V6h-5V4zM6 13v5h5v2H4v-7h2zm12 0h2v7h-7v-2h5v-5z"/></svg>';
    b.onclick = () => window.__hoqNpToggle();
    actions.appendChild(b);
  };
  addBtn();
  setInterval(addBtn, 1200);
}

// Push the "FANS / leaderboard" module to the BOTTOM of the right sidebar (under
// Related Tracks / In Playlists / Reposts) so it's out of the way.

// ---------------------------------------------------------------------------
// Custom right-click menu (the native browser one is disabled in the host).
// Context-aware: link / image / selection actions + Back / Forward / Reload.
// ---------------------------------------------------------------------------
function hoqCopy(t) {
  try { navigator.clipboard.writeText(t); }
  catch (e) {
    const ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e2) {}
    ta.remove();
  }
}

// Inspect: show the clicked element's ancestor chain + each one's background /
// box-shadow / text-shadow (so we can find boxes fast), and log it to the host.
function hoqInspect(el) {
  if (!el) return;
  const lines = [];
  let n = el;
  for (let i = 0; i < 8 && n && n !== document.body; i++) {
    const cls = n.className ? '.' + String(n.className).trim().replace(/\s+/g, '.') : '';
    const cs = getComputedStyle(n);
    lines.push(n.tagName.toLowerCase() + cls +
      '\n    bg:' + cs.backgroundColor +
      ' | box:' + (cs.boxShadow === 'none' ? 'none' : cs.boxShadow.slice(0, 44)) +
      ' | txt-sh:' + (cs.textShadow === 'none' ? 'none' : cs.textShadow.slice(0, 44)));
    n = n.parentElement;
  }
  const text = lines.join('\n');
  scPost('DBG INSPECT:\n' + text);

  let p = document.getElementById('hoq-inspect');
  if (!p) {
    p = document.createElement('div');
    p.id = 'hoq-inspect';
    p.style.cssText = 'position:fixed;top:56px;right:18px;z-index:2147483600;max-width:540px;max-height:70vh;overflow:auto;' +
      'background:rgba(14,14,18,0.98);color:#e4e4e6;border:1px solid rgba(255,255,255,0.15);border-radius:12px;padding:14px;' +
      'font:11.5px/1.55 ui-monospace,Consolas,monospace;box-shadow:0 22px 66px rgba(0,0,0,0.65);white-space:pre-wrap;word-break:break-all;backdrop-filter:blur(20px);';
    document.body.appendChild(p);
  }
  p.textContent = '';
  const pre = document.createElement('div');
  pre.textContent = text;
  const row = document.createElement('div');
  row.style.cssText = 'margin-top:11px;display:flex;gap:8px;';
  const copy = document.createElement('button');
  copy.textContent = 'Copy';
  copy.style.cssText = 'padding:6px 14px;border:0;border-radius:7px;background:var(--sc-accent,#ff5500);color:#fff;font-weight:700;cursor:pointer;';
  copy.onclick = () => { hoqCopy(text); copy.textContent = 'Copied!'; };
  const close = document.createElement('button');
  close.textContent = 'Close';
  close.style.cssText = 'padding:6px 14px;border:0;border-radius:7px;background:rgba(255,255,255,0.1);color:#ccc;cursor:pointer;';
  close.onclick = () => p.remove();
  row.appendChild(copy); row.appendChild(close);
  p.appendChild(pre); p.appendChild(row);
}

function buildContextMenu() {
  if (document.getElementById('hoq-ctx')) return;
  const st = document.createElement('style');
  st.textContent = `
    #hoq-ctx { position: fixed; z-index: 2147483000; min-width: 158px; display: none;
      background: rgba(19,19,22,0.98); backdrop-filter: blur(22px) saturate(1.2);
      border: 1px solid rgba(255,255,255,0.09); border-radius: 10px; padding: 4px;
      box-shadow: 0 14px 40px rgba(0,0,0,0.6); font-family: Inter,-apple-system,Arial,sans-serif;
      user-select: none; -webkit-user-select: none; }
    #hoq-ctx.open { display: block; animation: hoqCtx .11s ease; }
    @keyframes hoqCtx { from { opacity: 0; transform: scale(.97); } to { opacity: 1; transform: none; } }
    #hoq-ctx .hoq-ci { display: flex; align-items: center; gap: 10px; padding: 6px 9px;
      border-radius: 7px; color: #d4d4d7; font-size: 12.5px; cursor: pointer; white-space: nowrap; }
    #hoq-ctx .hoq-ci:hover { background: var(--sc-accent,#ff5500); color: #fff; }
    #hoq-ctx .hoq-ci .ico { width: 14px; text-align: center; opacity: .82; font-size: 12px; }
    #hoq-ctx .hoq-sep { height: 1px; margin: 4px 6px; background: rgba(255,255,255,0.08); }
  `;
  (document.head || document.documentElement).appendChild(st);
  const menu = document.createElement('div');
  menu.id = 'hoq-ctx';
  document.body.appendChild(menu);

  const hide = () => menu.classList.remove('open');
  window.addEventListener('mousedown', (e) => { if (!menu.contains(e.target)) hide(); });
  window.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
  window.addEventListener('resize', hide);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });

  // Extracted from the listener so the SAME menu can be opened from inside the
  // webi iframe: contextmenu events raised in a child document never reach this
  // one, which is why right-click did nothing on the new track page.
  // `doc` is the document the target belongs to; the player controls it drives
  // always live in the top frame.
  window.__hoqOpenCtx = (t, clientX, clientY, doc) => {
    doc = doc || document;
    const view = doc.defaultView || window;
    // Right-clicking dead space can target the document itself, and
    // getComputedStyle() throws on a non-element — fall back to <body>.
    if (!t || t.nodeType !== 1) t = doc.body;
    if (!t) return;
    const link = t.closest && t.closest('a[href]');
    const sel = ((view.getSelection && String(view.getSelection())) || '').trim();
    const clickSel = (s) => { const el = document.querySelector(s); if (el) el.click(); };
    const pr = playerProgress();

    // App-relevant actions first: playback + like.
    const items = [
      { ico: '⏮', label: 'Previous', act: () => clickSel('.skipControl__previous') },
      { ico: pr.paused ? '▶' : '⏸', label: pr.paused ? 'Play' : 'Pause', act: () => clickSel('.playControls__play') },
      { ico: '⏭', label: 'Next', act: () => clickSel('.skipControl__next') },
      { ico: '♥', label: 'Like / Unlike', act: () => clickSel('.playbackSoundBadge__like, .playControls__like') },
    ];
    // Image under the cursor: a real <img>, or an element with a CSS background
    // image (SoundCloud draws artwork that way).
    let imgUrl = '';
    const imgEl = t.closest && t.closest('img[src]');
    if (imgEl) imgUrl = imgEl.src;
    else {
      let n = t;
      for (let i = 0; i < 4 && n; i++) {
        const m = (view.getComputedStyle(n).backgroundImage || '').match(/url\(["']?(https?:[^"')]+)["']?\)/);
        if (m) { imgUrl = m[1]; break; }
        n = n.parentElement;
      }
    }
    if (imgUrl) imgUrl = imgUrl.replace(/-t\d+x\d+\./, '-t500x500.'); // bump SC thumbs to a bigger size

    if (sel || link || imgUrl) {
      items.push({ sep: true });
      if (sel) items.push({ ico: '❝', label: 'Copy', act: () => hoqCopy(sel) });
      const qInfo = trackLinkInfo(link);
      if (qInfo) items.push({ ico: '▶', label: 'Play in Discord', act: () => queueTrack(qInfo) });
      if (qInfo && hoqJamSess()) items.push({ ico: '+', label: 'Add to Jam', act: () => hoqJamAdd(qInfo) });
      if (link) items.push({ ico: '🔗', label: 'Copy link', act: () => hoqCopy(link.href) });
      if (imgUrl) items.push({ ico: '🖼', label: 'Save image', act: () => scPost('saveimg:' + imgUrl) });
    }
    items.push({ sep: true });
    items.push({ ico: '⟳', label: 'Reload', act: () => location.reload() });
    items.push({ ico: '🔍', label: 'Inspect element', act: () => scPost('opendevtools') });

    menu.innerHTML = items.map((it, i) => it.sep
      ? '<div class="hoq-sep"></div>'
      : '<div class="hoq-ci" data-i="' + i + '"><span class="ico">' + it.ico + '</span><span>' + it.label + '</span></div>').join('');
    menu.querySelectorAll('.hoq-ci').forEach((el) => {
      const it = items[+el.dataset.i];
      el.addEventListener('click', (ev) => { ev.stopPropagation(); hide(); try { it.act(); } catch (er) {} });
    });

    menu.style.left = '-9999px'; menu.style.top = '0';
    menu.classList.add('open');
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let x = clientX, y = clientY;
    if (x + mw > window.innerWidth - 8) x = window.innerWidth - mw - 8;
    if (y + mh > window.innerHeight - 8) y = window.innerHeight - mh - 8;
    menu.style.left = Math.max(8, x) + 'px';
    menu.style.top = Math.max(8, y) + 'px';
  };

  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.__hoqOpenCtx(e.target, e.clientX, e.clientY, document);
  });
}

// Full-screen pop-ups in the new SoundCloud app (the Upload page is one) come
// with hashed class names, so they're recognised by shape: a MUI modal that
// fills the window with a solid fill. Its #212121 cards get the frosted look.
function tagFullPage(d) {
  const w = d.defaultView;
  // Page-sized boxes painted SoundCloud's flat #121212 hide the blurred cover.
  d.querySelectorAll('.MuiBox-root:not(.hoq-clear)').forEach((e) => {
    const r = e.getBoundingClientRect();
    if (r.width < w.innerWidth * 0.9 || r.height < w.innerHeight * 0.6) return;
    if (w.getComputedStyle(e).backgroundColor === 'rgb(18, 18, 18)') e.classList.add('hoq-clear');
  });
  d.querySelectorAll('.MuiModal-root').forEach((m) => {
    if (!m.classList.contains('hoq-fullpage')) {
      const r = m.getBoundingClientRect();
      if (r.width < w.innerWidth - 4 || r.height < w.innerHeight - 4) return;
      if (w.getComputedStyle(m).backgroundColor === 'rgba(0, 0, 0, 0)') return;
      m.classList.add('hoq-fullpage');
    }
    m.querySelectorAll('div:not(.hoq-surf), section:not(.hoq-surf)').forEach((e) => {
      if (w.getComputedStyle(e).backgroundColor === 'rgb(33, 33, 33)') e.classList.add('hoq-surf');
    });
  });
  return !!d.querySelector('.MuiModal-root.hoq-fullpage');
}

// Right-click inside the webi iframe: reuse the top frame's menu, shifting the
// coordinates by the iframe's position so it lands under the cursor.
function attachFrameContextMenu(d, frameEl) {
  if (d.__hoqCtx) return;
  d.__hoqCtx = true;
  d.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (typeof window.__hoqOpenCtx !== 'function') return;
    const r = frameEl.getBoundingClientRect();
    window.__hoqOpenCtx(e.target, e.clientX + r.left, e.clientY + r.top, d);
  });
}

// TEMP (4 min): as the user browses, log the class chains of every popover /
// modal / dropdown / notable section so we can style them precisely afterward.
function DBGwalk() {
  const seen = new Set();
  const post = (tag, s) => { const m = 'DBG ' + tag + ': ' + s; if (s && !seen.has(m)) { seen.add(m); scPost(m); } };
  const sig = (el, depth) => {
    let n = el, chain = [];
    for (let i = 0; i < (depth || 5) && n && n !== document.body; i++) {
      const c = (n.className || '').toString().trim().replace(/\s+/g, '.').slice(0, 150);
      chain.push(n.tagName.toLowerCase() + (c ? '.' + c : ''));
      n = n.parentElement;
    }
    return chain.join(' > ');
  };
  const OVERLAY = '[role="dialog"],[role="listbox"],[role="menu"],[role="tooltip"],'
    + '.modal,[class*="modal" i],[class*="dialog" i],[class*="popover" i],'
    + '[class*="dropdown" i],[class*="shareSheet" i],[class*="share" i],[class*="select__" i]';
  const TEXT = ['Climb the leaderboard', 'Fans who have played', 'FANS', 'Top', 'Share', 'Related tracks'];
  const scan = () => {
    try {
      // one-off state + hero/fans element capture
      post('STATE', 'html=' + document.documentElement.className.slice(0, 50) +
        ' | body=' + getComputedStyle(document.body).backgroundColor +
        ' | scbg=' + (document.getElementById('sc-bg') ? getComputedStyle(document.getElementById('sc-bg')).display : 'na'));
      document.querySelectorAll('.fullHero,.fullHero__background,.listenArtworkWall,.listenHero,.l-listen,[class*="artworkWall" i]').forEach((el) => {
        const cs = getComputedStyle(el);
        post('HERO2', (el.className || el.tagName).toString().slice(0, 70) + ' :: img=' + cs.backgroundImage.slice(0, 45) + ' col=' + cs.backgroundColor);
      });
      // the big square cover on the right of the hero — capture its class for tilt
      document.querySelectorAll('.fullListenHero *, .fullHero *').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 180 && r.width < 520 && Math.abs(r.width - r.height) < 55 && r.top < 430)
          post('ART', (el.className || el.tagName).toString().slice(0, 90));
      });
      const fansH = Array.from(document.querySelectorAll('h1,h2,h3,h4,span,div')).find((e) => /^FANS\b/.test((e.textContent || '').trim()) && (e.textContent || '').trim().length < 12 && e.offsetParent);
      if (fansH) {
        post('FANSSEC', sig(fansH, 7));
        let n = fansH;
        for (let i = 0; i < 6 && n; i++) { const cs = getComputedStyle(n); if (cs.backgroundColor && !/rgba\(0, 0, 0, 0\)/.test(cs.backgroundColor)) post('FANSBG', (n.className || n.tagName).toString().slice(0, 70) + ' col=' + cs.backgroundColor); n = n.parentElement; }
      }
      document.querySelectorAll(OVERLAY).forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 60 || r.height < 24) return;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') return;
        post('OVL', sig(el));
      });
      TEXT.forEach((t) => {
        const el = Array.from(document.querySelectorAll('h1,h2,h3,h4,span,div,a,button'))
          .find((e) => (e.textContent || '').trim().toLowerCase().startsWith(t.toLowerCase()) && e.offsetParent);
        if (el) post('TXT[' + t + ']', sig(el, 6));
      });
      // Big BACKGROUND FILLS anywhere in the content (the reddish hero) — skip
      // gradient-text elements (background-clip:text) which aren't real fills.
      document.querySelectorAll('.l-listen-wrapper div, .l-listen-wrapper section, .l-listen-wrapper header, .l-listen-wrapper aside').forEach((el) => {
        const cs = getComputedStyle(el);
        if ((cs.backgroundClip || cs.webkitBackgroundClip) === 'text') return;
        const hasImg = cs.backgroundImage && cs.backgroundImage !== 'none';
        const hasCol = cs.backgroundColor && !/rgba\(0, 0, 0, 0\)/.test(cs.backgroundColor);
        if (!hasImg && !hasCol) return;
        const r = el.getBoundingClientRect();
        if (r.width < window.innerWidth * 0.35 || r.height < 110) return;
        post('FILL', (el.className || el.tagName).toString().slice(0, 85) +
          ' :: img=' + cs.backgroundImage.slice(0, 38) + ' col=' + cs.backgroundColor);
      });
    } catch (e) {}
  };
  const iv = setInterval(scan, 900);
  setTimeout(() => { clearInterval(iv); scPost('DBG PROBE DONE'); }, 4 * 60 * 1000);
}

// Move the "Fans" embedded iframe to the BOTTOM of the .listenNetworkSidebar
// (below Related Tracks / In Playlists / Likes / Reposts).
function moveFans() {
  const sidebar = document.querySelector('.listenNetworkSidebar');
  if (sidebar) {
    const embed = sidebar.querySelector('.sidebarModule__webiEmbeddedModule');
    if (embed) {
      let node = embed;
      while (node.parentElement && node.parentElement !== sidebar) node = node.parentElement;
      if (node.parentElement === sidebar && sidebar.lastElementChild !== node) sidebar.appendChild(node);
    }
  }
  styleFansIframe();
}

// The Fans widget lives in a same-origin <iframe>, so reach into its document
// and make the MUI cards/paper transparent (can't be done from the top-frame CSS).
function styleFansIframe() {
  document.querySelectorAll('iframe.webiEmbeddedModuleIframe, iframe[src*="right-hand-rail"]').forEach((f) => {
    try {
      const doc = f.contentDocument;
      if (!doc || doc.getElementById('hoq-fans-style')) return;
      const s = doc.createElement('style');
      s.id = 'hoq-fans-style';
      s.textContent =
        'html,body{background:transparent!important;background-color:transparent!important}' +
        '.MuiPaper-root,.MuiCard-root{background:transparent!important;background-color:transparent!important;box-shadow:none!important}' +
        '.MuiCard-root{border:1px solid rgba(255,255,255,0.12)!important}';
      (doc.head || doc.documentElement).appendChild(s);
    } catch (e) {}
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function boot() {
  // Inject theming + apply the accent in EVERY frame. SoundCloud's Artist Studio /
  // Insights are a separate "webi" (Next.js/MUI) app that renders in an iframe, so
  // top-frame-only injection left those pages un-themed. CSS is cheap + its selectors
  // simply don't match in unrelated frames, so this is safe. localStorage is shared
  // for same-origin frames, so the saved accent carries over.
  try { injectBaseCSS(); } catch (e) {}
  try { applyAccent(readAccent()); } catch (e) {}
  // The titlebar, interactions, panels and context menu are top-frame ONLY.
  if (window.top !== window) return;
  buildTitlebar();
  setupResize();
  applyCoverBgState(); // create #sc-bg + apply saved cover-background state
  ensureAdBadge(); // the page-world __scAdKiller toggles this
  buildContextMenu();   // custom right-click menu (native one is off)
  setupTilt();          // 3D tilt on home tiles
  setupTabTilt();       // 3D lift on profile/library tab bars
  setupInspectKey();    // Ctrl+Shift+C -> real DevTools element inspector
  setupWaveInteract();  // waveform bars rise toward the cursor
  setupCoverTilt();     // track cover follows the mouse in 3D
  setupAmbientMode();   // big now-playing view (button in the player bar)
  removeClutter();
  // Debounced + on a gentle interval instead of firing on every mutation — a
  // constant stream of DOM writes looks like bot activity to SoundCloud.
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    // Lazily mounted tiles land with SoundCloud's orange still on them, and at
    // the gentle cadence that stayed visible for ~2s on a cold start. React fast
    // while the page is settling, then back off to the slow cadence.
    setTimeout(() => {
      pending = false;
      removeClutter();
    }, performance.now() < 5000 ? 150 : 800);
  };
  // The "Next up" queue is a plain class toggle on SC's side; mirror it onto
  // <html> so our CSS can lift the player bar above the page while it's open
  // (the right sidebar otherwise overlaps the queue and steals its clicks).
  const syncQueueOpen = () => { try { document.documentElement.classList.toggle('hoq-queue-open', !!document.querySelector('.queue.m-visible')); } catch (e) {} };
  // The queue shows/hides by toggling `m-visible` on the existing .queue node —
  // an attribute change, which a childList observer misses. Attach a narrow
  // attribute observer to the queue container once it mounts.
  let queueAttrObs = null;
  const watchQueue = () => {
    const q = document.querySelector('.playControls__queue');
    if (q && !queueAttrObs) {
      queueAttrObs = new MutationObserver(syncQueueOpen);
      queueAttrObs.observe(q, { attributes: true, attributeFilter: ['class'], subtree: true });
      syncQueueOpen();
    }
  };
  // Changes inside the app's own UI, and the player's ticking clock, can't bring
  // clutter. Counting them kept removeClutter's full-page scan running every
  // 0.8 s for the whole session, playing or idle.
  const QUIET = '[id^="hoq-"], #sc-titlebar, #sc-palette, .hoq-wave, .playbackTimeline__timePassed, .playbackTimeline__duration';
  const obs = new MutationObserver((recs) => {
    watchQueue(); syncQueueOpen();
    for (let i = 0; i < recs.length; i++) {
      const t = recs[i].target;
      if (!(t && t.nodeType === 1 && t.closest(QUIET))) { schedule(); return; }
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
  watchQueue(); syncQueueOpen();
  // Cold load shows a burst of SoundCloud orange (follow buttons, badges) before
  // the first debounced pass lands. These few extra early passes close that window
  // without turning into the sustained write stream the debounce exists to avoid.
  [120, 350, 700, 1400, 2500].forEach((ms) => {
    setTimeout(() => { try { removeClutter(); } catch (e) {} }, ms);
  });
  // Watch the now-playing cover for the "Match song cover" theme mode.
  setInterval(matchTick, 500);   // cheap when nothing changed: it stops at the same URL
  // Keep the webi V2 track-page iframe themed: it mounts late and re-navigates
  // on every track, so a one-shot push at boot would miss it.
  themeFrames();
  setInterval(() => { try { themeFrames(); } catch (e) {} }, 1000);
  // Same cadence for the top frame's own rows (feed, search, library, legacy pages).
  addQueueButtons(document);
  setInterval(() => { try { addQueueButtons(document); addJamButtons(document); } catch (e) {} }, 1200);
  setInterval(() => { try { tuneNowPlayingMarquee(); } catch (e) {} }, 1500);
  setInterval(() => { try { hoqStatsTick(); } catch (e) {} }, 4000);
  // ask who's signed in to the hoq account at boot (the Settings bar may never open)
  if (hoqHasHost()) setTimeout(() => scPost('hoqacct:status'), 1200);
  // and for any update toast: the host can't show one before this page exists
  if (hoqHasHost()) setTimeout(() => scPost('update:status'), 1500);
  // Back into the jam this app was in (a reload or restart): the first state
  // either picks it up or says it ended.
  if (hoqHasHost()) setTimeout(() => { const s = hoqJamSess(); if (s) scPost('jam:watch:' + JSON.stringify(hoqJamAuth(s))); }, 1400);
  setInterval(() => { try { hoqJamTick(); } catch (e) {} }, 1000);
  setInterval(() => { try { hoqSearchTick(); } catch (e) {} }, 700);   // Best match / Lyrics in search
  setInterval(() => { try { hoqGoTick(); } catch (e) {} }, 500);       // Go+ songs from YouTube
  setInterval(() => { try { if (_yt) hoqYtPaint(); } catch (e) {} }, 250);   // its time on SoundCloud's bar
  // The player bar appears/disappears with playback, so keep the tab's bottom
  // edge honest while it's open.
  setInterval(() => {
    try { if (document.documentElement.classList.contains('hoq-tab')) hoqTabMetrics(); } catch (e) {}
  }, 1000);
  setInterval(() => { try { buildCustomWave(); } catch (e) {} }, 600); // our waveform + playhead
  applyVizState();  // apply saved "song visualizer bar" on/off before it draws
  // Ambient-glow layer (opt-in effect): one fixed div the CSS lights up when
  // html.hoq-ambient is set. Created once; the accent it uses is the live var.
  if (!document.getElementById('hoq-ambient')) {
    const amb = document.createElement('div'); amb.id = 'hoq-ambient';
    (document.body || document.documentElement).appendChild(amb);
  }
  applyFxClasses(); // apply saved CSS-gated optional effects
  startPlayerViz(); // bottom-player seek bar → flowing bouncy accent visualizer
  startOverlayScrollbar(); // custom floating accent scrollbar (no side gutter)
  startShareButton(); // "Share to Discord" → posts the current track to the webhook
  startPlayButton(); // "Play in Discord" → asks the bot to queue it
  mountDiscordActions();
  setInterval(() => { try { mountDiscordActions(); } catch (e) {} }, 1000);
  // Discord Rich Presence + live activity-card updates.
  setInterval(() => { try { rpcTick(); updateDiscordActivity(); } catch (e) {} }, 3000);
}

// ---------------------------------------------------------------------------
// Custom OVERLAY scrollbar — floats over the content on the right (no reserved
// gutter), invisible until you scroll or move to the edge, accent-gradient,
// draggable. Native bars are hidden in CSS. Handles the main window scroll.
// ---------------------------------------------------------------------------
function startOverlayScrollbar() {
  if (window.__hoqSB) return; window.__hoqSB = true;
  const bar = document.createElement('div'); bar.id = 'hoq-scroll';
  const thumb = document.createElement('div'); thumb.id = 'hoq-scroll-thumb';
  bar.appendChild(thumb);
  const se = () => document.scrollingElement || document.documentElement;
  const host = () => document.body || document.documentElement;
  host().appendChild(bar);

  let hideTO = 0, dragging = false, startY = 0, startScroll = 0;
  const geom = () => {
    const s = se(), vh = window.innerHeight, sh = s.scrollHeight;
    const trackH = bar.clientHeight || (vh - 52); // actual track height (matches CSS offsets)
    const th = Math.max(30, trackH * vh / sh), maxTop = Math.max(0, trackH - th);
    return { s, vh, sh, trackH, th, maxTop, scrollable: sh > vh + 4 };
  };
  function layout() {
    if (!bar.isConnected) host().appendChild(bar);
    const g = geom();
    if (!g.scrollable) { bar.classList.remove('show'); thumb.style.height = '0'; return; }
    thumb.style.height = g.th + 'px';
    thumb.style.transform = 'translateY(' + (g.maxTop * (g.s.scrollTop / (g.sh - g.vh))) + 'px)';
  }
  const hide = () => { if (!dragging && !bar.matches(':hover')) bar.classList.remove('show'); };
  function reveal() { if (!geom().scrollable) return; bar.classList.add('show'); clearTimeout(hideTO); hideTO = setTimeout(hide, 1200); }

  window.addEventListener('scroll', () => { layout(); reveal(); }, { passive: true, capture: true });
  window.addEventListener('resize', layout);
  // At most once a frame, as part of it: called straight from the observer, every
  // DOM change forced a synchronous layout just to read scrollHeight.
  let layoutRaf = 0;
  new MutationObserver(() => { if (!layoutRaf) layoutRaf = requestAnimationFrame(() => { layoutRaf = 0; layout(); }); })
    .observe(document.documentElement, { childList: true, subtree: true });
  thumb.addEventListener('mousedown', (e) => { dragging = true; startY = e.clientY; startScroll = se().scrollTop; document.body.style.userSelect = 'none'; bar.classList.add('show'); e.preventDefault(); });
  window.addEventListener('mousemove', (e) => {
    if (dragging) {
      const g = geom(); if (g.maxTop <= 0) return;
      se().scrollTop = startScroll + (e.clientY - startY) * ((g.sh - g.vh) / g.maxTop);
      return;
    }
    if (window.innerWidth - e.clientX < 24) reveal();
  });
  window.addEventListener('mouseup', () => { if (dragging) { dragging = false; document.body.style.userSelect = ''; clearTimeout(hideTO); hideTO = setTimeout(hide, 1200); } });

  layout();
  setInterval(layout, 500); // cheap catch for content-height / route changes
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}


/* =========================== mobile shim ============================ */
(() => {
  const H = document.documentElement;
  H.classList.add('hoq-mobile');

  // The titlebar only exists because the desktop window is frameless. On a
  // phone it is a dead 34px strip with non-functional window buttons.
  const css = document.createElement('style');
  css.textContent =
    '#sc-titlebar{display:none!important}' +
    'html.hoq-mobile .header{top:0!important}' +
    'html.hoq-mobile .header .header__inner{padding-right:12px!important}' +
    'html.hoq-mobile .sc-tb-btn{display:none!important}';
  (document.head || H).appendChild(css);

  // Mobile layout, against the containers SoundCloud actually uses:
  //   .l-container / .header__inner   fixed 1240px
  //   .l-fluid-fixed                  .l-main 880 + .l-sidebar-right 360
  //   .tileGallery                    horizontal carousels of 159px tiles
  const mob = document.createElement('style');
  mob.id = 'hoq-mobile-css';
  mob.textContent = "/* holdonquietly — phone layout.\n   Built into every phone version by tools/build-userscript.js (the mobile shim\n   injects it as <style id=\"hoq-mobile-css\">). SoundCloud only ships its desktop\n   DOM here: the proxy forces a desktop UA upstream, because otherwise it sends\n   phones to m.soundcloud.com, which the theme does not target. So this reflows\n   that desktop page for a phone. Selectors were checked against the live site\n   at 375-430px wide, signed in and signed out.\n\n   Shell, top to bottom:\n     .header        a 56px top bar: logo, search, (signed in) bell, messages, you\n     page content   padded so nothing hides under the bars\n     #hoq-pill      the floating player (tools/mobile-ui.js)\n     #hoq-tabs      the bottom tab bar (tools/mobile-ui.js)\n   #hoq-mnp is the full-screen player, #hoq-acts the action sheet. */\n\n/* Our own elements stay out of the way unless the phone layout is on. */\n#hoq-pill, #hoq-tabs, #hoq-mnp, #hoq-qdim { display: none; }\n\n/* SoundCloud's newer-app frames (Home's sections, the new track page) are made\n   see-through so the theme's background shows behind them; for that preload\n   sets their root to color-scheme: normal (html.hoq-webi). This page declares\n   color-scheme: dark (the meta tag in tools/mobile-ui.js), and when a frame's\n   root and its iframe element differ, the browser paints an opaque canvas under\n   the frame: white. Light on the element matches the frame, so it stays\n   see-through. (The desktop app declares no scheme, so it never hit this.) */\niframe.webiEmbeddedModuleIframe, iframe[class*=\"webiIframe\"], .webiIframeV2Layout iframe { color-scheme: light !important; }\n\n@media (max-width: 820px), (pointer: coarse) and (max-height: 500px) {\n\n  /* ======================================================================\n     1. Shell\n     ====================================================================== */\n  html.hoq-mobile {\n    --hoq-safe-t: env(safe-area-inset-top, 0px);\n    --hoq-safe-b: env(safe-area-inset-bottom, 0px);\n    /* the sides matter in landscape, where the notch is on one of them */\n    --hoq-safe-l: env(safe-area-inset-left, 0px);\n    --hoq-safe-r: env(safe-area-inset-right, 0px);\n    --hoq-top: calc(56px + var(--hoq-safe-t));\n    --hoq-tabs: calc(56px + var(--hoq-safe-b));\n    --hoq-pill-h: 62px;\n    /* what the fixed bottom stack covers: tab bar, plus the player when it's up */\n    --hoq-pad-b: calc(var(--hoq-tabs) + 18px);\n  }\n  html.hoq-mobile.hoq-pill-on { --hoq-pad-b: calc(var(--hoq-tabs) + var(--hoq-pill-h) + 26px); }\n  /* SoundCloud's own bar showing instead of the floating player (see 4.) */\n  html.hoq-mobile.hoq-bar-on { --hoq-pad-b: calc(var(--hoq-tabs) + 74px); }\n\n  html.hoq-mobile, html.hoq-mobile body {\n    overflow-x: hidden !important;\n    /* WebKit inflates text on wide-layout pages; the nav came out ~1.7x. */\n    -webkit-text-size-adjust: 100% !important; text-size-adjust: 100% !important;\n  }\n  html.hoq-mobile body {\n    padding-top: var(--hoq-top) !important;\n    padding-bottom: var(--hoq-pad-b) !important;\n    -webkit-tap-highlight-color: transparent;\n  }\n  /* Things scrolled into view (a focused field, a jump to an element) land\n     between the bars, not under them. */\n  html.hoq-mobile { scroll-padding-top: calc(var(--hoq-top) + 8px); scroll-padding-bottom: var(--hoq-pad-b); color-scheme: dark; }\n  /* Our own controls: no iOS long-press callout (copy / open link) on a tap\n     that lingers. */\n  html.hoq-mobile #hoq-tabs, html.hoq-mobile #hoq-pill, html.hoq-mobile #hoq-mnp { -webkit-touch-callout: none; }\n  /* With the newer-app frame up, SoundCloud makes body a 100vh grid with no\n     padding; ours would make the page ~170px taller than the screen, and it\n     scrolled under the (fixed) frame. */\n  html.hoq-mobile body:has(> .webiIframeV2Layout:not(.fullScreen):not(.sc-hidden)) {\n    padding-top: 0 !important; padding-bottom: 0 !important;\n  }\n  html.hoq-mobile .l-content, html.hoq-mobile #content { padding-top: 0 !important; margin-top: 0 !important; }\n\n  /* Fixed-width containers -> fluid (desktop is a 1240px canvas). */\n  html.hoq-mobile .l-container,\n  html.hoq-mobile .l-content,\n  html.hoq-mobile .l-inner-fullwidth {\n    max-width: 100% !important; width: 100% !important; min-width: 0 !important;\n    padding-left: max(14px, var(--hoq-safe-l)) !important; padding-right: max(14px, var(--hoq-safe-r)) !important;\n    box-sizing: border-box !important;\n  }\n  /* SoundCloud nests .l-content inside .l-container.l-content: pad once. */\n  html.hoq-mobile .l-container .l-content,\n  html.hoq-mobile .l-content .l-content { padding-left: 0 !important; padding-right: 0 !important; }\n\n  /* Two columns -> one. The 360px right rail is noise on a phone. */\n  html.hoq-mobile .l-fluid-fixed { display: block !important; }\n  html.hoq-mobile .l-main {\n    width: 100% !important; float: none !important; margin: 0 !important;\n    padding-right: 0 !important; border-right: 0 !important; box-sizing: border-box !important;\n  }\n  html.hoq-mobile .l-fluid-fixed > .sc-border-light-right { padding-right: 0 !important; border-right: 0 !important; }\n  html.hoq-mobile .l-sidebar-right,\n  html.hoq-mobile .l-fluid-fixed > aside { display: none !important; }\n\n  /* A full-width promo block is a lot of nothing on a phone. */\n  html.hoq-mobile .l-product-banners, html.hoq-mobile .banner { display: none !important; }\n  /* the desktop scroll indicator and the landing page's second search box */\n  html.hoq-mobile #hoq-scroll, html.hoq-mobile .frontContent__search { display: none !important; }\n\n  /* ======================================================================\n     2. Top bar: logo · search · bell, messages, you\n     ====================================================================== */\n  html.hoq-mobile .header {\n    position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important;\n    width: auto !important; height: var(--hoq-top) !important; min-height: 0 !important;\n    padding: var(--hoq-safe-t) 0 0 !important; margin: 0 !important; box-sizing: border-box !important;\n    z-index: 1500 !important; transform: none !important;\n    background: rgba(13,13,16,.8) !important;\n    -webkit-backdrop-filter: blur(20px) saturate(1.5) !important; backdrop-filter: blur(20px) saturate(1.5) !important;\n    border: 0 !important; border-bottom: 1px solid rgba(255,255,255,.07) !important; box-shadow: none !important;\n  }\n  html.hoq-mobile .header .header__inner {\n    display: flex !important; flex-wrap: nowrap !important; align-items: center !important; gap: 10px !important;\n    width: 100% !important; max-width: none !important; height: 56px !important; min-height: 0 !important;\n    margin: 0 !important; box-sizing: border-box !important;\n    padding: 0 max(6px, var(--hoq-safe-r)) 0 max(12px, var(--hoq-safe-l)) !important;\n  }\n  html.hoq-mobile .header__left {\n    display: flex !important; flex: 0 0 auto !important; align-items: center !important;\n    width: auto !important; height: auto !important; margin: 0 !important; float: none !important;\n  }\n  html.hoq-mobile .header__logo {\n    flex: 0 0 auto !important; width: 34px !important; height: 34px !important; max-width: none !important;\n    margin: 0 !important; padding: 0 !important; overflow: hidden !important; float: none !important;\n  }\n  html.hoq-mobile .header__logoLink { width: 34px !important; height: 34px !important; margin: 0 !important; padding: 0 !important; }\n  /* The tabs live in the bottom bar now (#hoq-tabs presses these links). */\n  html.hoq-mobile .header__navWrapper { display: none !important; }\n\n  html.hoq-mobile .header__middle {\n    flex: 1 1 auto !important; order: 0 !important; min-width: 0 !important; width: auto !important;\n    margin: 0 !important; padding: 0 !important; float: none !important;\n  }\n  html.hoq-mobile .header .header__search { width: 100% !important; height: 38px !important; margin: 0 !important; }\n  /* The form is the visible pill; the input inside it is see-through (the theme\n     gives both a box, which drew a box inside a box). */\n  html.hoq-mobile .header .header__search .headerSearch {\n    position: relative !important; width: 100% !important; height: 38px !important; margin: 0 !important;\n    box-sizing: border-box !important; border-radius: 19px !important; overflow: hidden !important;\n    background: rgba(255,255,255,.08) !important; border: 1px solid rgba(255,255,255,.09) !important; box-shadow: none !important;\n  }\n  html.hoq-mobile .header .header__search .headerSearch:focus-within {\n    border-color: color-mix(in srgb, var(--sc-accent, #ff5500) 60%, transparent) !important;\n    background: rgba(255,255,255,.11) !important;\n  }\n  html.hoq-mobile .header .header__search .headerSearch__input {\n    position: absolute !important; inset: 0 !important; width: 100% !important; height: 100% !important;\n    box-sizing: border-box !important; margin: 0 !important; padding: 0 40px 0 15px !important;\n    border: 0 !important; border-radius: 19px !important; background: transparent !important; box-shadow: none !important;\n    font-size: 16px !important;   /* under 16px, iOS zooms the whole page in on focus */\n  }\n  html.hoq-mobile .header .header__search .headerSearch__submit {\n    top: 2px !important; right: 6px !important; height: 32px !important; margin: 0 !important;\n  }\n\n  html.hoq-mobile .header__right {\n    display: flex !important; flex: 0 0 auto !important; align-items: center !important;\n    width: auto !important; margin: 0 !important; padding: 0 !important; float: none !important; gap: 0 !important;\n  }\n  /* No room, and all desktop-shaped (upload, artist tools, the \"more\" menu). */\n  html.hoq-mobile .header__right > .header__navMenu,\n  html.hoq-mobile .header__upsellWrapper,\n  html.hoq-mobile .header__soundInput,\n  html.hoq-mobile .uploadButton,\n  html.hoq-mobile .header__forArtistsButton,\n  html.hoq-mobile .header__moreButton { display: none !important; }\n  html.hoq-mobile .header__userNav { display: flex !important; align-items: center !important; gap: 0 !important; }\n  /* 44x44: Apple's minimum for something you tap */\n  html.hoq-mobile .header__userNavButton {\n    display: flex !important; align-items: center !important; justify-content: center !important;\n    min-width: 44px !important; height: 44px !important; margin: 0 !important; padding: 0 !important;\n    border: 0 !important; float: none !important;\n  }\n  html.hoq-mobile .header__userNavButton::before { display: none !important; }   /* the desktop dividers */\n  html.hoq-mobile .header__userNavActivitiesButton { order: 1 !important; }\n  html.hoq-mobile .header__userNavMessagesButton { order: 2 !important; }\n  html.hoq-mobile .header__userNavUsernameButton { order: 3 !important; width: 44px !important; }\n  html.hoq-mobile .header__userNavUsernameButtonIcon,\n  html.hoq-mobile .header__userNavUsername { display: none !important; }\n  html.hoq-mobile .header__userNavAvatar, html.hoq-mobile .header__userNavAvatar span {\n    width: 30px !important; height: 30px !important; margin: 0 !important; border-radius: 50% !important;\n  }\n\n  /* SoundCloud's dropdowns (you, notifications, messages) open from the top bar:\n     keep them on screen. */\n  html.hoq-mobile .dropdownMenu, html.hoq-mobile .headerMenu {\n    max-width: calc(100vw - 16px) !important; box-sizing: border-box !important;\n  }\n\n  /* ======================================================================\n     3. Bottom tab bar (tools/mobile-ui.js)\n     ====================================================================== */\n  html.hoq-mobile #hoq-tabs {\n    display: flex; position: fixed; left: 0; right: 0; bottom: 0; z-index: 1600;\n    height: var(--hoq-tabs); box-sizing: border-box;\n    padding: 0 max(4px, var(--hoq-safe-r)) var(--hoq-safe-b) max(4px, var(--hoq-safe-l));\n    background: rgba(13,13,16,.88);\n    -webkit-backdrop-filter: blur(22px) saturate(1.5); backdrop-filter: blur(22px) saturate(1.5);\n    border-top: 1px solid rgba(255,255,255,.07);\n    font-family: -apple-system, Inter, 'Helvetica Neue', Arial, sans-serif;\n    -webkit-user-select: none; user-select: none;\n  }\n  html.hoq-mobile.hoq-mnp-open #hoq-tabs { visibility: hidden; }\n  #hoq-tabs button {\n    -webkit-appearance: none; appearance: none; flex: 1 1 0; min-width: 0; height: 56px;\n    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;\n    margin: 0; padding: 0; border: 0; background: none; cursor: pointer; color: #8f8f99;\n    touch-action: manipulation;   /* a quick second tap is a tap, not iOS double-tap zoom */\n    font: 600 10.5px/1 -apple-system, Inter, 'Helvetica Neue', Arial, sans-serif; letter-spacing: .01em;\n    -webkit-tap-highlight-color: transparent;\n  }\n  #hoq-tabs button[hidden] { display: none; }\n  #hoq-tabs button svg {\n    width: 25px; height: 25px; fill: none; stroke: currentColor; stroke-width: 1.85;\n    stroke-linecap: round; stroke-linejoin: round; transition: transform .15s ease;\n  }\n  #hoq-tabs button svg .f { fill: currentColor; stroke: none; }\n  #hoq-tabs button:active svg { transform: scale(.88); }\n  #hoq-tabs button.on { color: #fff; }\n  #hoq-tabs button.on svg { stroke: var(--sc-accent, #ff5500); stroke-width: 2.1;\n    filter: drop-shadow(0 0 6px color-mix(in srgb, var(--sc-accent, #ff5500) 45%, transparent)); }\n\n  /* ======================================================================\n     4. Floating player (tools/mobile-ui.js). SoundCloud's own bar stays in\n     the page, invisible, doing the real work (and feeding the lock screen);\n     html.hoq-pill-on goes on only once this is live, so a failure leaves the\n     old bar.\n     ====================================================================== */\n  html.hoq-mobile.hoq-pill-on #hoq-pill {\n    display: flex; position: fixed; z-index: 1700; box-sizing: border-box;\n    left: max(8px, var(--hoq-safe-l)); right: max(8px, var(--hoq-safe-r)); bottom: calc(var(--hoq-tabs) + 8px);\n    height: var(--hoq-pill-h); align-items: center; gap: 9px; padding: 0 4px 0 5px; border-radius: 31px;\n    background: rgba(30,30,34,.9);\n    -webkit-backdrop-filter: blur(22px) saturate(1.6); backdrop-filter: blur(22px) saturate(1.6);\n    border: 1px solid rgba(255,255,255,.12);\n    box-shadow: 0 12px 34px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.06);\n    font-family: -apple-system, Inter, 'Helvetica Neue', Arial, sans-serif; color: #fff;\n    touch-action: pan-y; -webkit-tap-highlight-color: transparent;\n    -webkit-user-select: none; user-select: none;\n  }\n  html.hoq-mnp-open #hoq-pill, html.hoq-np-open #hoq-pill { display: none !important; }\n  /* The real bar: still laid out (its timeline drives seeking and the lock\n     screen, its buttons take our presses), never seen or touched. opacity, not\n     visibility: the theme forces some children visible. */\n  html.hoq-mobile .playControls { bottom: var(--hoq-tabs) !important; }\n  html.hoq-mobile.hoq-pill-on .playControls { opacity: 0 !important; }\n  html.hoq-mobile.hoq-pill-on .playControls,\n  html.hoq-mobile.hoq-pill-on .playControls * { pointer-events: none !important; }\n  /* Squeezed to 0px, the timeline made every seek land on 0:00. Give it room. */\n  html.hoq-mobile.hoq-pill-on .playControls__timeline { flex: 1 1 auto !important; min-width: 140px !important; margin: 0 6px !important; }\n  html.hoq-mobile.hoq-pill-on .playbackTimeline { width: 100% !important; }\n  html.hoq-mobile.hoq-pill-on .playbackTimeline__progressWrapper { flex: 1 1 auto !important; min-width: 100px !important; }\n  html.hoq-mobile.hoq-pill-on .playControls__soundBadge { flex: 0 1 auto !important; min-width: 0 !important; max-width: 30% !important; overflow: hidden !important; }\n  /* If the floating player can't go live, SoundCloud's bar is what shows: fit\n     it (transport, timeline, title), it ran to 445px wide at 390px. */\n  html.hoq-mobile:not(.hoq-pill-on) .playControls__inner { padding: 0 8px !important; }\n  /* Nothing loaded: SoundCloud slides the empty bar away by 48px, and the rest\n     peeked out above the tab bar as a grey strip. */\n  html.hoq-mobile .playControls:not(.m-visible) { opacity: 0 !important; }\n  html.hoq-mobile .playControls:not(.m-visible),\n  html.hoq-mobile .playControls:not(.m-visible) * { pointer-events: none !important; }\n  html.hoq-mobile:not(.hoq-pill-on) .playControls__elements { width: 100% !important; }\n  html.hoq-mobile:not(.hoq-pill-on) .volume,\n  html.hoq-mobile:not(.hoq-pill-on) .playControls__shuffle,\n  html.hoq-mobile:not(.hoq-pill-on) .playControls__repeat,\n  html.hoq-mobile:not(.hoq-pill-on) .playbackSoundBadge__follow,\n  html.hoq-mobile:not(.hoq-pill-on) .playbackSoundBadge__showQueue,\n  html.hoq-mobile:not(.hoq-pill-on) .playbackSoundBadge__like { display: none !important; }\n  html.hoq-mobile:not(.hoq-pill-on) .playbackTimeline { flex: 1 1 auto !important; min-width: 0 !important; }\n  html.hoq-mobile:not(.hoq-pill-on) .playbackSoundBadge__titleContextContainer { min-width: 0 !important; }\n  html.hoq-mobile:not(.hoq-pill-on) .playControls__soundBadge { margin-left: 2px !important; }\n  html.hoq-mobile:not(.hoq-pill-on) .playbackSoundBadge__actions { margin-left: 4px !important; }\n  html.hoq-mobile:not(.hoq-pill-on) .playControls__timeline { margin-left: 8px !important; margin-right: 4px !important; }\n  html.hoq-mobile:not(.hoq-pill-on) .playbackSoundBadge__avatar { margin-right: 6px !important; }\n\n  #hoq-pill button {\n    -webkit-appearance: none; appearance: none; border: 0; background: none; margin: 0; padding: 0;\n    color: inherit; cursor: pointer; flex: none; display: flex; align-items: center; justify-content: center;\n    -webkit-tap-highlight-color: transparent;\n  }\n  #hoq-pill svg { fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }\n  #hoq-pill svg .f { fill: currentColor; stroke: none; }\n  #hoq-pill .pl-play { position: relative; width: 52px; height: 52px; }\n  #hoq-pill .pl-ring { position: absolute; inset: 0; width: 52px; height: 52px; transform: rotate(-90deg); }\n  #hoq-pill .pl-ring circle { fill: none; stroke-width: 3.5; }\n  #hoq-pill .pl-track { stroke: rgba(255,255,255,.14); }\n  #hoq-pill .pl-prog {\n    stroke: var(--sc-accent, #ff5500); stroke-linecap: round;\n    stroke-dasharray: 144.51; stroke-dashoffset: 144.51; transition: stroke-dashoffset .25s linear;\n  }\n  #hoq-pill .pl-disc {\n    width: 40px; height: 40px; border-radius: 50%; background: #fff; color: #121214;\n    display: flex; align-items: center; justify-content: center;\n    box-shadow: 0 2px 8px rgba(0,0,0,.35); transition: transform .12s ease;\n  }\n  #hoq-pill .pl-disc svg { width: 19px; height: 19px; }\n  #hoq-pill .pl-disc.has-art { position: relative; background: #222 center / cover no-repeat; color: #fff; }\n  #hoq-pill .pl-disc.has-art::before { content: ''; position: absolute; inset: 0; border-radius: 50%; background: rgba(0,0,0,.42); }\n  #hoq-pill .pl-disc.has-art svg { position: relative; z-index: 1; filter: drop-shadow(0 1px 2px rgba(0,0,0,.5)); }\n  #hoq-pill .pl-play:active .pl-disc { transform: scale(.9); }\n  #hoq-pill .pl-meta {\n    flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 2px;\n    cursor: pointer; align-self: stretch;\n  }\n  #hoq-pill .pl-title {\n    font-size: 15px; font-weight: 700; letter-spacing: -.01em;\n    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;\n  }\n  #hoq-pill .pl-artist { font-size: 13px; color: #a0a0a8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n  #hoq-pill .pl-meta.sw-l { animation: hoqPillSwL .3s ease; }\n  #hoq-pill .pl-meta.sw-r { animation: hoqPillSwR .3s ease; }\n  @keyframes hoqPillSwL { 0% { transform: translateX(0); opacity: 1; } 45% { transform: translateX(-24px); opacity: 0; }\n    55% { transform: translateX(24px); opacity: 0; } 100% { transform: translateX(0); opacity: 1; } }\n  @keyframes hoqPillSwR { 0% { transform: translateX(0); opacity: 1; } 45% { transform: translateX(24px); opacity: 0; }\n    55% { transform: translateX(-24px); opacity: 0; } 100% { transform: translateX(0); opacity: 1; } }\n  #hoq-pill .pl-btns { display: flex; align-items: center; flex: none; }\n  /* 42x48 targets (Apple asks 44; four of them plus a title fit at 375px this way) */\n  #hoq-pill .pl-btns button { width: 42px; height: 48px; border-radius: 12px; color: #ececf0; }\n  #hoq-pill .pl-btns button:active { background: rgba(255,255,255,.08); }\n  #hoq-pill .pl-btns button[hidden] { display: none; }\n  #hoq-pill .pl-prev svg, #hoq-pill .pl-next svg { width: 21px; height: 21px; }\n  #hoq-pill .pl-like svg { width: 23px; height: 23px; }\n  #hoq-pill .pl-dc svg { width: 20px; height: 20px; }\n  #hoq-pill .pl-like.on svg { fill: var(--sc-accent, #ff5500); stroke: var(--sc-accent, #ff5500); }\n  #hoq-pill .pl-like.pop svg { animation: hoqPillPop .32s ease; }\n  @keyframes hoqPillPop { 40% { transform: scale(1.28); } }\n  html.hoq-anon #hoq-pill .pl-like, html.hoq-anon #hoq-mnp .mnp-like { display: none !important; }\n  @media (max-width: 390px) { #hoq-pill .pl-btns button { width: 40px; } }\n  @media (max-width: 359px) { #hoq-pill .pl-prev { display: none; } }\n\n  /* ======================================================================\n     5. Full-screen player (tools/mobile-ui.js)\n     ====================================================================== */\n  html.hoq-mobile #hoq-mnp {\n    display: block; position: fixed; inset: 0; z-index: 2000; overflow: hidden;\n    background: #0e0e11; color: #fff;\n    font-family: -apple-system, Inter, 'Helvetica Neue', Arial, sans-serif;\n    transform: translateY(100%); visibility: hidden;\n    transition: transform .34s cubic-bezier(.2,.8,.2,1), visibility 0s linear .34s;\n    -webkit-user-select: none; user-select: none; -webkit-tap-highlight-color: transparent;\n  }\n  html.hoq-mobile #hoq-mnp.on { transform: none; visibility: visible; transition: transform .34s cubic-bezier(.2,.8,.2,1); }\n  /* (outranks html.hoq-anon body { overflow: auto } below) */\n  html.hoq-mobile.hoq-mnp-open body { overflow: hidden !important; }\n  #hoq-mnp .mnp-bg {\n    position: absolute; inset: -60px; background: #222 center / cover no-repeat;\n    filter: blur(44px) saturate(1.5) brightness(.6); transform: scale(1.15); opacity: .95;\n  }\n  #hoq-mnp .mnp-shade {\n    position: absolute; inset: 0;\n    background: linear-gradient(180deg, rgba(10,10,12,.25) 0%, rgba(10,10,12,.5) 45%, rgba(10,10,12,.86) 100%);\n  }\n  #hoq-mnp .mnp-in {\n    position: relative; z-index: 1; height: 100%; box-sizing: border-box;\n    display: flex; flex-direction: column; overflow-x: hidden; overflow-y: auto;\n    padding: calc(var(--hoq-safe-t) + 4px) max(24px, var(--hoq-safe-r)) calc(var(--hoq-safe-b) + 16px) max(24px, var(--hoq-safe-l));\n    overscroll-behavior: contain;\n  }\n  #hoq-mnp button {\n    -webkit-appearance: none; appearance: none; border: 0; background: none; margin: 0; padding: 0;\n    color: inherit; cursor: pointer; display: flex; align-items: center; justify-content: center;\n    font: inherit; -webkit-tap-highlight-color: transparent; touch-action: manipulation;\n  }\n  #hoq-mnp svg { fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }\n  #hoq-mnp svg .f { fill: currentColor; stroke: none; }\n  #hoq-mnp .mnp-top { flex: none; display: flex; align-items: center; justify-content: space-between; height: 52px; margin: 0 -10px; }\n  #hoq-mnp .mnp-top button { width: 44px; height: 44px; border-radius: 50%; }\n  #hoq-mnp .mnp-top button:active { background: rgba(255,255,255,.1); }\n  #hoq-mnp .mnp-x svg { width: 28px; height: 28px; stroke-width: 2.2; }\n  #hoq-mnp .mnp-sp { visibility: hidden; }\n  #hoq-mnp .mnp-ctx { font-size: 11.5px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; color: rgba(255,255,255,.78); }\n  /* auto margins: the cover sits centred in whatever room the controls leave */\n  #hoq-mnp .mnp-art {\n    flex: none; width: min(100%, 44vh); aspect-ratio: 1 / 1; margin: auto; border-radius: 14px;\n    background: #26262b center / cover no-repeat;\n    box-shadow: 0 24px 60px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.06);\n    transition: transform .3s cubic-bezier(.2,.8,.2,1);\n  }\n  #hoq-mnp.paused .mnp-art { transform: scale(.93); }\n  #hoq-mnp .mnp-info { flex: none; display: flex; align-items: center; gap: 12px; padding-top: 22px; }\n  #hoq-mnp .mnp-meta { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 3px; }\n  #hoq-mnp .mnp-title, #hoq-mnp .mnp-artist {\n    display: block; max-width: 100%; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;\n  }\n  #hoq-mnp .mnp-title { font-size: 22px; font-weight: 800; letter-spacing: -.02em; line-height: 1.2; }\n  #hoq-mnp .mnp-artist { font-size: 15.5px; color: rgba(255,255,255,.72); }\n  #hoq-mnp .mnp-like { flex: none; width: 46px; height: 46px; border-radius: 50%; color: #fff; }\n  #hoq-mnp .mnp-like svg { width: 28px; height: 28px; }\n  #hoq-mnp .mnp-like.on svg { fill: var(--sc-accent, #ff5500); stroke: var(--sc-accent, #ff5500);\n    filter: drop-shadow(0 0 7px color-mix(in srgb, var(--sc-accent, #ff5500) 55%, transparent)); }\n  #hoq-mnp .mnp-like.pop svg { animation: hoqPillPop .32s ease; }\n  #hoq-mnp .mnp-seek { flex: none; height: 30px; margin-top: 16px; display: flex; align-items: center; cursor: pointer; touch-action: none; }\n  #hoq-mnp .mnp-rail { position: relative; width: 100%; height: 4px; border-radius: 3px; background: rgba(255,255,255,.22); transition: height .12s ease; }\n  #hoq-mnp .mnp-fill { position: absolute; left: 0; top: 0; bottom: 0; width: 0; border-radius: 3px;\n    background: var(--sc-accent-bg, var(--sc-accent, #ff5500)); }\n  #hoq-mnp .mnp-knob {\n    position: absolute; top: 50%; left: 0; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%;\n    background: #fff; box-shadow: 0 1px 5px rgba(0,0,0,.45); transition: transform .12s ease;\n  }\n  #hoq-mnp .mnp-seek.drag .mnp-rail { height: 6px; }\n  #hoq-mnp .mnp-seek.drag .mnp-knob { transform: scale(1.35); }\n  #hoq-mnp .mnp-times { flex: none; display: flex; justify-content: space-between; margin-top: 1px;\n    font-size: 12px; color: rgba(255,255,255,.66); font-variant-numeric: tabular-nums; }\n  #hoq-mnp .mnp-ctrls { flex: none; display: flex; align-items: center; justify-content: space-between; margin: 12px -6px 0; }\n  #hoq-mnp .mnp-ctrls button { position: relative; width: 52px; height: 52px; border-radius: 50%; color: #fff; }\n  #hoq-mnp .mnp-ctrls button:active { background: rgba(255,255,255,.08); }\n  #hoq-mnp .mnp-prev svg, #hoq-mnp .mnp-next svg { width: 34px; height: 34px; }\n  #hoq-mnp .mnp-shuf svg, #hoq-mnp .mnp-rep svg { width: 24px; height: 24px; }\n  #hoq-mnp .mnp-shuf, #hoq-mnp .mnp-rep { color: rgba(255,255,255,.7); }\n  #hoq-mnp .mnp-shuf.on, #hoq-mnp .mnp-rep.on { color: var(--sc-accent, #ff5500); }\n  #hoq-mnp .mnp-shuf.on::after, #hoq-mnp .mnp-rep.on::after {\n    content: ''; position: absolute; left: 50%; bottom: 7px; width: 4px; height: 4px; margin-left: -2px;\n    border-radius: 50%; background: currentColor;\n  }\n  #hoq-mnp .mnp-rep i { display: none; position: absolute; top: 12px; right: 9px; font: 800 9px/1 -apple-system, Inter, Arial, sans-serif; font-style: normal; }\n  #hoq-mnp .mnp-rep.one i { display: block; }\n  #hoq-mnp .mnp-ctrls .mnp-play {\n    width: 74px; height: 74px; color: #fff;\n    background: var(--sc-accent-bg, var(--sc-accent, #ff5500));\n    box-shadow: 0 10px 28px color-mix(in srgb, var(--sc-accent, #ff5500) 45%, transparent), inset 0 1px 0 rgba(255,255,255,.2);\n    transition: transform .12s ease;\n  }\n  #hoq-mnp .mnp-ctrls .mnp-play:active { transform: scale(.93); background: var(--sc-accent-bg, var(--sc-accent, #ff5500)); }\n  #hoq-mnp .mnp-play svg { width: 32px; height: 32px; }\n  #hoq-mnp .mnp-foot { flex: none; display: flex; justify-content: space-between; gap: 10px; margin-top: 18px; }\n  #hoq-mnp .mnp-foot button {\n    flex: 1 1 0; min-width: 0; height: 44px; gap: 7px; border-radius: 22px;\n    background: rgba(255,255,255,.09); border: 1px solid rgba(255,255,255,.08);\n    font-size: 13px; font-weight: 600; color: #ececf0;\n  }\n  #hoq-mnp .mnp-foot button:active { background: rgba(255,255,255,.16); }\n  #hoq-mnp .mnp-foot button[hidden] { display: none; }\n  #hoq-mnp .mnp-foot svg { width: 18px; height: 18px; flex: none; }\n  /* Short screens (iPhone SE): a smaller cover so the controls still fit. */\n  @media (max-height: 700px) {\n    #hoq-mnp .mnp-art { width: min(100%, 38vh); }\n    #hoq-mnp .mnp-info { padding-top: 14px; }\n    #hoq-mnp .mnp-foot { margin-top: 12px; }\n  }\n\n  /* SoundCloud's own queue (\"Next up\"), opened from the player: a sheet. */\n  html.hoq-mobile .playControls__queue {\n    position: fixed !important; left: 0 !important; right: 0 !important; bottom: 0 !important;\n    top: calc(var(--hoq-safe-t) + 34px) !important; width: auto !important; height: auto !important;\n    max-height: none !important; margin: 0 !important;\n  }\n  html.hoq-mobile .playControls__queue .queue {\n    width: 100% !important; height: 100% !important; box-sizing: border-box !important;\n    border-radius: 18px 18px 0 0 !important; overflow: hidden !important;\n    background: #15151a !important; border: 1px solid rgba(255,255,255,.08) !important; border-bottom: 0 !important;\n    box-shadow: 0 -12px 40px rgba(0,0,0,.5) !important;\n  }\n  html.hoq-mobile .playControls__queue .queue__panel { padding: 14px 14px 8px 18px !important; }\n  html.hoq-mobile .playControls__queue .queue__scrollable {\n    top: 62px !important; bottom: 0 !important; height: auto !important; width: 100% !important;\n    padding-bottom: var(--hoq-safe-b) !important; box-sizing: border-box !important;\n  }\n  html.hoq-mobile .playControls__queue .queue__hide { width: 36px !important; height: 36px !important; }\n  html.hoq-mobile.hoq-pill-on.hoq-q-open .playControls { opacity: 1 !important; z-index: 2100 !important; }\n  /* The bar's (identity) transform made it the box \"fixed\" is measured from, so\n     the sheet came out 12px tall inside the 48px bar. Only while it's open:\n     SoundCloud slides the empty bar away with that transform. */\n  html.hoq-mobile.hoq-q-open .playControls__inner { transform: none !important; }\n  html.hoq-mobile.hoq-pill-on.hoq-q-open .playControls,\n  html.hoq-mobile.hoq-pill-on.hoq-q-open .playControls__inner,\n  html.hoq-mobile.hoq-pill-on.hoq-q-open .playControls__wrapper {\n    background: transparent !important; border: 0 !important; box-shadow: none !important;\n    -webkit-backdrop-filter: none !important; backdrop-filter: none !important;\n  }\n  html.hoq-mobile.hoq-pill-on.hoq-q-open .playControls__bg,\n  html.hoq-mobile.hoq-pill-on.hoq-q-open .playControls__elements,\n  html.hoq-mobile.hoq-pill-on.hoq-q-open .playControls__panel { opacity: 0 !important; }\n  html.hoq-mobile.hoq-pill-on.hoq-q-open .playControls__queue,\n  html.hoq-mobile.hoq-pill-on.hoq-q-open .playControls__queue * { pointer-events: auto !important; }\n  html.hoq-mobile.hoq-q-open #hoq-qdim {\n    display: block; position: fixed; inset: 0; z-index: 2050; background: rgba(0,0,0,.55);\n    -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px);\n  }\n\n  /* Action sheet (Discord, ...) and the little status toast. */\n  #hoq-acts {\n    position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: flex-end; justify-content: center;\n    background: rgba(0,0,0,.5); -webkit-backdrop-filter: blur(5px); backdrop-filter: blur(5px);\n    font-family: -apple-system, Inter, 'Helvetica Neue', Arial, sans-serif; animation: hoqFade .18s ease;\n  }\n  #hoq-acts[hidden] { display: none; }\n  #hoq-acts .ac-box {\n    width: 100%; max-width: 520px; box-sizing: border-box;\n    padding: 8px max(10px, var(--hoq-safe-r)) calc(10px + var(--hoq-safe-b)) max(10px, var(--hoq-safe-l));\n    animation: hoqUp .26s cubic-bezier(.2,.8,.2,1);\n  }\n  #hoq-acts .ac-list { border-radius: 16px; overflow: hidden; background: rgba(36,36,41,.97); }\n  #hoq-acts .ac-title { padding: 12px 16px 10px; font-size: 12.5px; color: #9a9aa4; text-align: center;\n    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; background: rgba(36,36,41,.97);\n    border-radius: 16px 16px 0 0; border-bottom: 1px solid rgba(255,255,255,.07); }\n  #hoq-acts .ac-title:empty { display: none; }\n  #hoq-acts .ac-title:not(:empty) + .ac-list { border-radius: 0 0 16px 16px; }\n  #hoq-acts button {\n    -webkit-appearance: none; appearance: none; display: block; width: 100%; margin: 0; padding: 16px;\n    border: 0; background: none; color: #fff; font: 600 16.5px -apple-system, Inter, Arial, sans-serif;\n    cursor: pointer; -webkit-tap-highlight-color: transparent; touch-action: manipulation;\n  }\n  #hoq-acts .ac-list button + button { border-top: 1px solid rgba(255,255,255,.07); }\n  #hoq-acts .ac-sub { display: block; margin-top: 4px; padding: 0 8px; font-size: 12.5px; font-weight: 400; line-height: 1.35; color: #9a9aa4; }\n  #hoq-acts .ac-list button:active { background: rgba(255,255,255,.08); }\n  #hoq-acts .ac-cancel { margin-top: 8px; border-radius: 16px; background: rgba(36,36,41,.97); font-weight: 700; }\n  #hoq-mtoast {\n    position: fixed; left: 50%; top: calc(var(--hoq-top) + 10px); z-index: 2147483001; max-width: 80vw;\n    transform: translate(-50%, -8px); opacity: 0; pointer-events: none; transition: opacity .2s ease, transform .2s ease;\n    padding: 10px 16px; border-radius: 20px; background: rgba(36,36,41,.96); color: #fff;\n    border: 1px solid rgba(255,255,255,.1); box-shadow: 0 10px 28px rgba(0,0,0,.45);\n    font: 600 13.5px -apple-system, Inter, Arial, sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;\n  }\n  #hoq-mtoast.on { opacity: 1; transform: translate(-50%, 0); }\n  @keyframes hoqFade { from { opacity: 0; } to { opacity: 1; } }\n  @keyframes hoqUp { from { transform: translateY(40px); opacity: 0; } to { transform: none; opacity: 1; } }\n\n  /* ======================================================================\n     6. Social / Settings panel: a page between the bars\n     ====================================================================== */\n  html.hoq-mobile #hoq-discord {\n    top: var(--hoq-top) !important; bottom: 0 !important; z-index: 1400 !important;\n    padding: 14px max(14px, var(--hoq-safe-r)) var(--hoq-pad-b) max(14px, var(--hoq-safe-l)) !important;\n  }\n  /* Social / Feed / Settings / Changes: tabs you can hit, in one row */\n  html.hoq-mobile #hoq-discord .hoq-dc-card .hoq-sub { flex-wrap: nowrap !important; overflow-x: auto !important; scrollbar-width: none !important; }\n  html.hoq-mobile #hoq-discord .hoq-dc-card .hoq-sub::-webkit-scrollbar { display: none !important; }\n  html.hoq-mobile #hoq-discord .hoq-subtab {\n    flex: 0 0 auto !important; min-height: 44px !important; padding-top: 0 !important; padding-bottom: 0 !important;\n    margin-right: 16px !important; font-size: 14px !important;\n  }\n  /* Changes: the tags above the text, the text the full width */\n  html.hoq-mobile #hoq-discord .hoq-chg { padding: 14px 14px 6px !important; }\n  html.hoq-mobile #hoq-discord .hoq-chg li { flex-direction: column !important; gap: 5px !important; font-size: 14px !important; }\n  html.hoq-mobile #hoq-discord .hoq-chg-tags { width: auto !important; }\n  /* the Social tab in the tab bar gets the same dot while something's unseen */\n  #hoq-tabs button { position: relative; }\n  html.hoq-chg-new #hoq-tabs button[data-k=\"social\"]::after {\n    content: ''; position: absolute; top: 9px; left: 50%; margin-left: 10px; width: 8px; height: 8px; border-radius: 50%;\n    background: var(--sc-accent, #ff5500); box-shadow: 0 0 0 2px rgba(13,13,16,.9);\n  }\n  /* The panel is see-through over the page background, and the sign-in banner\n     isn't part of the page it hides, so the two printed over each other. */\n  html.hoq-mobile.hoq-tab #hoq-signin-cta { display: none !important; }\n  html.hoq-mobile #hoq-discord .hoq-dc-top { margin-bottom: 12px !important; gap: 10px !important; }\n  html.hoq-mobile #hoq-discord .hoq-dc-logo { width: 32px !important; height: 32px !important; }\n  html.hoq-mobile #hoq-discord .hoq-dc-top span { font-size: 21px !important; }\n  html.hoq-mobile #hoq-discord .hoq-dc-body { display: block !important; }\n  html.hoq-mobile #hoq-discord .hoq-dc-sec { width: 100% !important; }\n  html.hoq-mobile #sc-palette .pal-grid { grid-template-columns: 1fr !important; }\n  html.hoq-mobile #sc-palette > .row,\n  html.hoq-mobile #sc-palette > .bgurl,\n  html.hoq-mobile #sc-palette > .btn-2up { max-width: 100% !important; }\n  /* Anything you type into: under 16px, iOS zooms the page in when you tap it\n     (the Feed composer was 13px). */\n  html.hoq-mobile input:not([type='checkbox']):not([type='radio']):not([type='color']):not([type='range']):not([type='button']):not([type='submit']),\n  html.hoq-mobile textarea, html.hoq-mobile select { font-size: 16px !important; }\n  /* the Feed composer's placeholder takes two lines at this width */\n  html.hoq-mobile #hoq-discord .hoq-feed-input { min-height: 64px !important; }\n  /* Mouse-only effects. The shim switches them off on touch screens at every\n     load, so their switches would only ever lie. */\n  html.hoq-mobile #sc-palette label.row:has(#sc-fx-wave),\n  html.hoq-mobile #sc-palette label.row:has(#sc-fx-tilt),\n  html.hoq-mobile #sc-palette label.row:has(#sc-fx-pulse),\n  html.hoq-mobile #sc-palette label.row:has(#sc-fx-hover) { display: none !important; }\n\n  /* ======================================================================\n     7. Discover tiles: a 2-up grid instead of sideways carousels\n     ====================================================================== */\n  /* The gallery containers kept the carousel's fixed single-row height, so a\n     grid with multiple rows overflowed and the next section rendered over it. */\n  html.hoq-mobile .tileGallery,\n  html.hoq-mobile [class*='tileGallery'],\n  html.hoq-mobile .mixedSelectionModule,\n  html.hoq-mobile .mixedSelectionGallery { width: 100% !important; height: auto !important; }\n  html.hoq-mobile .tileGallery__slider {\n    overflow: visible !important; width: auto !important; height: auto !important; margin: 0 !important; padding: 0 !important;\n  }\n  html.hoq-mobile .tileGallery__sliderPeekContainer {\n    overflow: visible !important; width: auto !important; height: auto !important;\n  }\n  html.hoq-mobile .tileGallery__sliderPanel {\n    display: flex !important; flex-wrap: wrap !important; align-content: flex-start !important;\n    gap: 18px 12px !important; width: auto !important; height: auto !important; min-height: 0 !important;\n    /* SoundCloud clamps this shelf with max-height: 208px (one carousel row)\n       via a :has() selector that outranks a plain class. */\n    max-height: none !important;\n    overflow: visible !important; transform: none !important;\n  }\n  html.hoq-mobile .tileGallery__sliderPanelSlide {\n    flex: 0 0 calc(50% - 6px) !important; width: calc(50% - 6px) !important;\n    max-width: calc(50% - 6px) !important; margin: 0 !important; padding: 0 !important;\n  }\n  html.hoq-mobile .playableTile {\n    width: 100% !important; min-width: 0 !important; margin: 0 !important;\n    display: flex !important; flex-direction: column !important;\n  }\n  /* SoundCloud squares the artwork with padding-bottom: 100%. Just clip and round. */\n  html.hoq-mobile .playableTile__artwork {\n    width: 100% !important; height: auto !important; position: relative !important;\n    overflow: hidden !important; border-radius: 10px !important; margin: 0 !important;\n  }\n  html.hoq-mobile .playableTile__artwork > * {\n    position: absolute !important; top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important;\n    width: auto !important; height: auto !important; margin: 0 !important;\n  }\n  html.hoq-mobile .playableTile__playButton,\n  html.hoq-mobile .playableTile__actions { height: auto !important; width: auto !important; }\n  /* No hover on a phone: a small, always-on play button in the cover's corner. */\n  html.hoq-mobile .playableTile__artwork > .playableTile__playButton {\n    top: auto !important; left: auto !important; right: 8px !important; bottom: 8px !important;\n    width: 36px !important; height: 36px !important; transform: none !important;\n    opacity: 1 !important; visibility: visible !important; z-index: 3 !important;\n  }\n  html.hoq-mobile .playableTile__playButton .sc-button-play {\n    width: 36px !important; height: 36px !important; min-width: 0 !important; border-radius: 50% !important;\n    box-shadow: 0 2px 10px rgba(0,0,0,.45) !important;\n  }\n  html.hoq-mobile .playableTile__description { margin-top: 8px !important; }\n  html.hoq-mobile .playableTile__heading, html.hoq-mobile .sc-text-h4 { font-size: 13px !important; }\n  /* Overlay arrows are meaningless in a grid. */\n  html.hoq-mobile .tileGallery__sliderButton,\n  html.hoq-mobile .tileGallery__sliderPeek,\n  html.hoq-mobile .tileGallery__leftButton,\n  html.hoq-mobile .tileGallery__rightButton { display: none !important; }\n  html.hoq-mobile .mixedSelectionModule__title { margin-left: 0 !important; padding-left: 0 !important; }\n\n  html.hoq-mobile h1 { font-size: 21px !important; }\n  html.hoq-mobile .l-content h2, html.hoq-mobile .sectionHead__title { font-size: 18px !important; }\n\n  /* ======================================================================\n     8. Track rows (Feed, artist pages, search, playlists): cover with the\n     play button on it, artist and title beside it, one row of actions.\n     ====================================================================== */\n  html.hoq-mobile .soundList__item,\n  html.hoq-mobile .searchList__item .searchItem {\n    margin: 0 !important; padding: 12px 0 !important; border-bottom: 1px solid rgba(255,255,255,.06) !important;\n  }\n  /* The divider sits on the result, not the row: SoundCloud leaves some rows\n     empty (ad slots), and those now draw nothing. */\n  html.hoq-mobile .searchList__item { margin: 0 !important; padding: 0 !important; border: 0 !important; }\n  html.hoq-mobile .sound, html.hoq-mobile .activity { padding: 0 !important; margin: 0 !important; }\n  html.hoq-mobile .soundContext {\n    display: flex !important; align-items: center !important; gap: 8px !important;\n    height: auto !important; min-height: 0 !important; margin: 0 0 9px !important; padding: 0 !important;\n  }\n  html.hoq-mobile .soundContext__userAvatar,\n  html.hoq-mobile .soundContext__userAvatar .g-avatar-badge-body,\n  html.hoq-mobile .soundContext__userAvatar .g-avatar-badge-avatar,\n  html.hoq-mobile .soundContext__userAvatar .image,\n  html.hoq-mobile .soundContext__userAvatar .sc-artwork { width: 22px !important; height: 22px !important; margin: 0 !important; }\n  html.hoq-mobile .soundContext__line {\n    display: block !important; min-width: 0 !important; font-size: 12.5px !important; line-height: 1.35 !important;\n    white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important;\n  }\n  html.hoq-mobile .soundContext__line .sc-text-h4, html.hoq-mobile .soundContext__usernameLink { font-size: 12.5px !important; }\n  html.hoq-mobile .soundContext .relativeTime { display: inline !important; color: #8a8a94 !important; }\n\n  html.hoq-mobile .sound__body,\n  html.hoq-mobile .userItem.sc-media {\n    display: flex !important; align-items: flex-start !important; gap: 12px !important;\n    position: relative !important; margin: 0 !important; padding: 0 !important;\n  }\n  html.hoq-mobile .sound__artwork,\n  html.hoq-mobile .userItem__coverArt {\n    flex: 0 0 78px !important; width: 78px !important; height: 78px !important;\n    margin: 0 !important; float: none !important; position: relative !important;\n  }\n  html.hoq-mobile .sound__coverArt,\n  html.hoq-mobile .sound__coverArt .image,\n  html.hoq-mobile .sound__coverArt .sc-artwork,\n  html.hoq-mobile .userItem__coverArt .image,\n  html.hoq-mobile .userItem__coverArt .sc-artwork {\n    width: 78px !important; height: 78px !important; border-radius: 9px !important; overflow: hidden !important;\n  }\n  html.hoq-mobile .userItem__coverArt .image, html.hoq-mobile .userItem__coverArt .sc-artwork { border-radius: 50% !important; }\n  html.hoq-mobile .sound__content,\n  html.hoq-mobile .userItem .sc-media-content {\n    flex: 1 1 auto !important; width: auto !important; min-width: 0 !important; margin: 0 !important; padding: 0 !important;\n  }\n  /* static, so the play button below can sit on the cover (.sound__body) */\n  html.hoq-mobile .sound__header {\n    position: static !important; min-width: 0 !important; margin: 0 0 4px !important; padding: 0 !important;\n  }\n  html.hoq-mobile .sound__header .soundTitle { width: auto !important; }\n  html.hoq-mobile .soundTitle__titleContainer {\n    display: block !important; position: static !important; width: auto !important; min-width: 0 !important;\n  }\n  html.hoq-mobile .sound__body .soundTitle__playButton {\n    position: absolute !important; left: 44px !important; top: 44px !important; z-index: 2 !important;\n    width: 30px !important; height: 30px !important; margin: 0 !important; float: none !important;\n  }\n  html.hoq-mobile .sound__body .soundTitle__playButton .sc-button-play {\n    width: 30px !important; height: 30px !important; min-width: 0 !important; margin: 0 !important;\n    border-radius: 50% !important; box-shadow: 0 2px 8px rgba(0,0,0,.55) !important; filter: none !important;\n  }\n  html.hoq-mobile .soundTitle__usernameTitleContainer {\n    display: block !important; width: auto !important; min-width: 0 !important; margin: 0 !important; float: none !important;\n  }\n  html.hoq-mobile .soundTitle__secondary, html.hoq-mobile .soundTitle__username {\n    display: block !important; font-size: 12.5px !important; line-height: 1.3 !important; color: #9a9aa4 !important;\n    white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important;\n  }\n  html.hoq-mobile .soundTitle__secondary .soundTitle__usernameText, html.hoq-mobile .soundTitle__usernameText {\n    font-size: 12.5px !important; white-space: nowrap !important;\n  }\n  html.hoq-mobile .soundTitle__title {\n    display: -webkit-box !important; -webkit-box-orient: vertical !important; -webkit-line-clamp: 2 !important;\n    overflow: hidden !important; white-space: normal !important; overflow-wrap: anywhere !important;\n    font-size: 14.5px !important; line-height: 1.28 !important; margin-top: 1px !important;\n  }\n  html.hoq-mobile .soundTitle__title span { font-size: inherit !important; }\n  /* date + genre tag: a quiet line, not a right-hand column */\n  html.hoq-mobile .soundTitle__additionalContainer {\n    display: flex !important; align-items: center !important; gap: 8px !important; float: none !important;\n    margin: 3px 0 0 !important; padding: 0 !important; width: auto !important; height: auto !important;\n  }\n  html.hoq-mobile .soundTitle__uploadTime, html.hoq-mobile .sound__header .sc-text-secondary {\n    float: none !important; display: inline !important; font-size: 11.5px !important; color: #7f7f8a !important;\n  }\n  html.hoq-mobile .soundTitle__tagContainer { display: none !important; }\n  /* unusable at this size */\n  html.hoq-mobile .sound__waveform, html.hoq-mobile .commentForm { display: none !important; }\n\n  html.hoq-mobile .sound__footer {\n    display: flex !important; align-items: center !important; justify-content: space-between !important;\n    gap: 6px !important; position: static !important; margin: 0 !important; padding: 0 !important; min-height: 0 !important;\n  }\n  html.hoq-mobile .sound__soundActions {\n    float: none !important; flex: 0 1 auto !important; min-width: 0 !important; margin: 0 !important; padding: 0 !important;\n  }\n  html.hoq-mobile .sound__soundActions .soundActions,\n  html.hoq-mobile .sound__soundActions .sc-button-group {\n    display: flex !important; flex-wrap: nowrap !important; align-items: center !important; gap: 2px !important;\n    margin: 0 !important; padding: 0 !important; float: none !important;\n  }\n  html.hoq-mobile .sound__soundActions .sc-button {\n    float: none !important; margin: 0 !important; width: 40px !important; height: 40px !important; min-width: 0 !important;\n    padding: 0 !important; justify-content: center !important; font-size: 0 !important;\n    background: transparent !important; border: 0 !important; box-shadow: none !important;\n  }\n  html.hoq-mobile .sound__soundActions .sc-button-copylink,\n  html.hoq-mobile .sound__soundActions .purchaseLink__container,\n  html.hoq-mobile .sound__soundActions .sc-button-group > div:empty { display: none !important; }\n  html.hoq-mobile .sound__footerRight {\n    position: static !important; flex: 0 0 auto !important; margin: 0 !important; padding: 0 !important;\n  }\n  html.hoq-mobile .sound__soundStats .soundStats { display: flex !important; gap: 10px !important; margin: 0 !important; }\n  html.hoq-mobile .sound__soundStats .sc-ministats-item { margin: 0 !important; padding: 0 !important; float: none !important; }\n  html.hoq-mobile .sound__soundStats .sc-ministats { font-size: 11.5px !important; color: #8a8a94 !important; }\n  html.hoq-mobile .sound__soundStats .sc-ministats-comments { display: none !important; }\n\n  /* Playlists in a list: their track list sits under the row. */\n  html.hoq-mobile .sound.playlist .sound__trackList,\n  html.hoq-mobile .compactTrackList { margin: 8px 0 0 !important; width: auto !important; }\n  html.hoq-mobile .compactTrackList__item { min-width: 0 !important; }\n\n  /* ======================================================================\n     9. Search: filters as a row of chips above the results\n     ====================================================================== */\n  html.hoq-mobile .l-search, html.hoq-mobile .l-fixed-fluid { padding: 0 !important; }\n  html.hoq-mobile .l-search .l-fixed-top,\n  html.hoq-mobile .l-search .l-fixed-left {\n    position: static !important; width: auto !important; height: auto !important; margin: 0 !important; padding: 0 !important;\n  }\n  html.hoq-mobile .searchTitle { width: auto !important; padding: 10px 0 4px !important; }\n  html.hoq-mobile .searchTitle__text { padding: 0 !important; font-size: 19px !important; white-space: normal !important; }\n  html.hoq-mobile .searchTitle__textContent { float: none !important; display: inline !important; }\n  html.hoq-mobile .searchOptions, html.hoq-mobile .searchOptions__container,\n  html.hoq-mobile .searchOptions__scrollableInner {\n    width: auto !important; height: auto !important; background: none !important; border: 0 !important;\n    box-shadow: none !important; -webkit-backdrop-filter: none !important; backdrop-filter: none !important;\n  }\n  /* display: block, not SoundCloud's inline-block: shrink-wrapped to the chips\n     (779px) the row never had to scroll, and the last filters sat off screen. */\n  html.hoq-mobile .searchOptions__scrollable {\n    display: block !important;\n    position: static !important; width: auto !important; height: auto !important; max-height: none !important;\n    margin: 6px -14px 4px !important; padding: 0 !important; overflow: visible !important;\n    background: none !important; border: 0 !important; border-radius: 0 !important; box-shadow: none !important;\n    -webkit-backdrop-filter: none !important; backdrop-filter: none !important;\n  }\n  html.hoq-mobile .searchOptions__navigation {\n    display: flex !important; flex-direction: row !important; flex-wrap: nowrap !important; gap: 8px !important;\n    overflow-x: auto !important; -webkit-overflow-scrolling: touch !important; scrollbar-width: none !important;\n    margin: 0 !important; padding: 4px 14px 8px !important; position: static !important;\n    background: none !important; border: 0 !important; box-shadow: none !important;\n  }\n  html.hoq-mobile .searchOptions__navigation::-webkit-scrollbar { display: none !important; }\n  html.hoq-mobile .searchOptions__navigation > li {\n    flex: 0 0 auto !important; width: auto !important; margin: 0 !important; padding: 0 !important; position: static !important;\n  }\n  html.hoq-mobile .searchOptions__navigation > li > a {\n    display: flex !important; align-items: center !important; gap: 6px !important; height: 40px !important;\n    margin: 0 !important; padding: 0 15px !important; border-radius: 20px !important; white-space: nowrap !important;\n    font-size: 13.5px !important; background: rgba(255,255,255,.07) !important; border: 1px solid rgba(255,255,255,.08) !important;\n    box-shadow: none !important; transform: none !important;\n  }\n  html.hoq-mobile .searchOptions__navigation > li > a.active,\n  html.hoq-mobile .searchOptions__navigation > li.active > a,\n  html.hoq-mobile .searchOptions__navigation > li > a[aria-current] {\n    background: color-mix(in srgb, var(--sc-accent, #ff5500) 24%, transparent) !important;\n    border-color: color-mix(in srgb, var(--sc-accent, #ff5500) 60%, transparent) !important; color: #fff !important;\n  }\n  html.hoq-mobile .searchOptions__footer { display: none !important; }\n  html.hoq-mobile .l-search .l-main { margin: 0 !important; padding: 0 !important; width: auto !important; }\n  html.hoq-mobile .searchResultGroupHeading { margin: 6px 0 0 !important; }\n  html.hoq-mobile .resultCounts { font-size: 12.5px !important; }\n  html.hoq-mobile .searchItem { width: auto !important; }\n  /* People in the results */\n  html.hoq-mobile .userItem__title, html.hoq-mobile .userItem__username {\n    white-space: normal !important; overflow-wrap: anywhere !important; font-size: 15px !important;\n  }\n  html.hoq-mobile .userItem__details, html.hoq-mobile .userItem__stats { font-size: 12.5px !important; }\n  html.hoq-mobile .userItem .sc-button-follow { margin-top: 6px !important; }\n\n  /* ======================================================================\n     10. Track page (signed out: the classic page). Signed in, SoundCloud\n     shows its newer track page in a frame: tools/mobile-frame.css.\n     ====================================================================== */\n  html.hoq-mobile .l-listen-hero,\n  html.hoq-mobile .fullListenHero,\n  html.hoq-mobile .fullHero { height: auto !important; margin-left: 0 !important; margin-right: 0 !important; }\n  html.hoq-mobile .fullHero__foreground {\n    display: flex !important; flex-direction: column !important; align-items: stretch !important;\n    width: auto !important; max-width: 100% !important; position: static !important;\n    padding: 12px 0 4px !important; box-sizing: border-box !important;\n  }\n  html.hoq-mobile .fullHero__artwork {\n    position: static !important; order: -1 !important; float: none !important;\n    width: 100% !important; max-width: none !important; height: auto !important; aspect-ratio: 1 / 1 !important;\n    margin: 0 0 16px !important;\n  }\n  html.hoq-mobile .fullHero__artwork .listenArtworkWrapper,\n  html.hoq-mobile .fullHero__artwork .listenArtworkWrapper__artwork,\n  html.hoq-mobile .fullHero__artwork .image,\n  html.hoq-mobile .fullHero__artwork .sc-artwork {\n    width: 100% !important; height: 100% !important; max-width: none !important; border-radius: 14px !important;\n  }\n  html.hoq-mobile .fullHero__title {\n    width: auto !important; min-width: 0 !important; height: auto !important; margin: 0 !important;\n    position: static !important; float: none !important;\n  }\n  html.hoq-mobile .fullHero__title .soundTitle { width: 100% !important; min-width: 0 !important; }\n  html.hoq-mobile .fullHero__title .soundTitle__titleContainer {\n    display: flex !important; align-items: center !important; gap: 14px !important; width: 100% !important; min-width: 0 !important;\n  }\n  html.hoq-mobile .fullHero__title .soundTitle__playButton { margin: 0 !important; flex: none !important; position: static !important; }\n  html.hoq-mobile .fullHero .soundTitle__playButton .sc-button-play {\n    width: 56px !important; height: 56px !important; margin: 0 !important; border-radius: 50% !important;\n  }\n  html.hoq-mobile .fullHero .soundTitle__playButton .sc-button-play svg { width: 24px !important; height: 24px !important; }\n  html.hoq-mobile .fullHero__title .soundTitle__usernameTitleContainer {\n    flex: 1 1 auto !important; min-width: 0 !important; margin: 0 !important;\n    display: flex !important; flex-direction: column !important; gap: 4px !important;\n  }\n  html.hoq-mobile .fullHero .soundTitle__title, html.hoq-mobile .fullHero .soundTitle__title span {\n    display: block !important; -webkit-line-clamp: unset !important;\n    white-space: normal !important; overflow-wrap: anywhere !important;\n    font-size: 21px !important; line-height: 1.18 !important; padding: 0 !important; margin: 0 !important;\n    background: none !important;\n  }\n  html.hoq-mobile .fullHero .soundTitle__username, html.hoq-mobile .fullHero .soundTitle__usernameHeroLink {\n    font-size: 15px !important; padding: 0 !important; margin: 0 !important; background: none !important;\n  }\n  html.hoq-mobile .fullHero__info {\n    width: auto !important; position: static !important; float: none !important;\n    display: flex !important; flex-direction: row !important; flex-wrap: wrap !important;\n    justify-content: flex-start !important; align-items: center !important; gap: 10px !important;\n    margin: 12px 0 0 !important; text-align: left !important;\n  }\n  html.hoq-mobile .fullHero__uploadTime { order: 2; display: inline-block !important; text-align: left !important; }\n  html.hoq-mobile .fullHero__playerArea, html.hoq-mobile .fullHero__waveform {\n    width: 100% !important; position: static !important; float: none !important; min-height: 0 !important;\n  }\n  html.hoq-mobile .fullHero__playerArea { margin-top: 12px !important; height: auto !important; }\n  html.hoq-mobile .fullHero__waveform { height: 64px !important; margin-bottom: 6px !important; }\n  html.hoq-mobile .backgroundGradient { width: 100% !important; }\n  html.hoq-mobile .l-listen-hero { margin-bottom: 8px !important; }\n\n  /* Below the hero: like/repost/share..., the uploader, the description and the\n     comments. Desktop puts the uploader in a 160px column beside the text; at\n     phone width it was printed on top of the description. Stack everything. */\n  html.hoq-mobile .l-listen-wrapper { display: block !important; }\n  html.hoq-mobile .listenEngagement { padding: 2px 0 8px !important; }\n  html.hoq-mobile .listenEngagement__footer { display: flex !important; flex-wrap: wrap !important; align-items: center !important; gap: 10px !important; }\n  html.hoq-mobile .listenEngagement__actions,\n  html.hoq-mobile .listenEngagement__footer .soundActions { flex-wrap: wrap !important; gap: 8px !important; float: none !important; }\n  html.hoq-mobile .listenEngagement__stats, html.hoq-mobile .listenEngagement__footer .soundStats { float: none !important; margin: 0 !important; }\n  html.hoq-mobile [class*='l-about-'] {\n    width: 100% !important; max-width: 100% !important; min-width: 0 !important;\n    float: none !important; display: block !important; position: static !important;\n    margin-left: 0 !important; padding-left: 0 !important; box-sizing: border-box !important;\n  }\n  html.hoq-mobile .l-listen__mainContent, html.hoq-mobile .l-about-row { display: block !important; }\n  /* The uploader: avatar, name and stats in one row (desktop stacks them in a\n     centred column with a full-width Report button under it). */\n  html.hoq-mobile .l-about-left { display: block !important; margin: 6px 0 12px !important; }\n  html.hoq-mobile .l-about-left-content { padding: 0 !important; }\n  html.hoq-mobile .listenArtistInfo .userBadge.m-vertical {\n    display: flex !important; flex-direction: row !important; flex-wrap: wrap !important; align-items: center !important;\n    gap: 4px 12px !important; width: auto !important; text-align: left !important; margin: 0 !important;\n  }\n  html.hoq-mobile .listenArtistInfo .userBadge__avatar { margin: 0 !important; flex: none !important; width: 56px !important; height: 56px !important; }\n  html.hoq-mobile .listenArtistInfo .userBadge__avatar .g-avatar-badge,\n  html.hoq-mobile .listenArtistInfo .userBadge__avatar .g-avatar-badge-body,\n  html.hoq-mobile .listenArtistInfo .userBadge__avatar .g-avatar-badge-avatar-link,\n  html.hoq-mobile .listenArtistInfo .userBadge__avatar .g-avatar-badge-avatar,\n  html.hoq-mobile .listenArtistInfo .userBadge__avatar .image,\n  html.hoq-mobile .listenArtistInfo .userBadge__avatar .sc-artwork { width: 56px !important; height: 56px !important; }\n  html.hoq-mobile .listenArtistInfo .userBadge__content { flex: 1 1 auto !important; min-width: 0 !important; width: auto !important; text-align: left !important; margin: 0 !important; }\n  html.hoq-mobile .listenArtistInfo .userBadge__username { justify-content: flex-start !important; }\n  html.hoq-mobile .listenArtistInfo .userBadge__meta,\n  html.hoq-mobile .listenArtistInfo .userBadge__stats,\n  html.hoq-mobile .listenArtistInfo .userStats {\n    display: flex !important; justify-content: flex-start !important; gap: 10px !important;\n    text-align: left !important; margin: 2px 0 0 !important; padding: 0 !important; width: auto !important;\n  }\n  html.hoq-mobile .listenArtistInfo .userBadge__actions { flex: 0 0 auto !important; width: auto !important; margin: 0 !important; }\n  html.hoq-mobile .listenArtistInfo .userBadge__actions > div:empty { display: none !important; }\n  html.hoq-mobile .listenArtistInfo__report { display: none !important; }\n  html.hoq-mobile .listenDetails,\n  html.hoq-mobile .listenDetails > *,\n  html.hoq-mobile .commentsList,\n  html.hoq-mobile .commentsList__item,\n  html.hoq-mobile .listenDetails__partialInfo,\n  html.hoq-mobile .listenDetails__login {\n    position: static !important; float: none !important; display: block !important;\n    width: 100% !important; max-width: 100% !important; box-sizing: border-box !important; margin-left: 0 !important;\n  }\n  html.hoq-mobile .commentsList__item { padding-left: 0 !important; padding-right: 0 !important; }\n  html.hoq-mobile .commentItem__message, html.hoq-mobile .commentItem__body {\n    white-space: normal !important; overflow-wrap: anywhere !important;\n  }\n  html.hoq-mobile .commentsList__header, html.hoq-mobile .commentsList__top {\n    display: flex !important; flex-wrap: wrap !important; align-items: center !important; justify-content: space-between !important; gap: 8px !important;\n  }\n  html.hoq-mobile .commentsList__sortSelect, html.hoq-mobile .select__wrapper { max-width: 100% !important; }\n  html.hoq-mobile .commentItem__avatar, html.hoq-mobile .commentItem__avatar .image,\n  html.hoq-mobile .commentItem__avatar .sc-artwork { width: 36px !important; height: 36px !important; }\n\n  /* ======================================================================\n     11. Artist / profile pages\n     ====================================================================== */\n  /* Desktop lays a 198px avatar beside the name over an opaque banner. Stack\n     it over a soft frosted backdrop. */\n  html.hoq-mobile .l-user-hero { position: relative !important; padding: 0 !important; overflow: hidden !important; border-radius: 0 0 16px 16px; }\n  html.hoq-mobile .profileHeader {\n    position: relative !important; width: 100% !important; min-height: 0 !important; height: auto !important;\n    display: flex !important; flex-direction: column !important;\n  }\n  html.hoq-mobile .profileHeaderBackground { position: absolute !important; inset: 0 !important; z-index: 0 !important; }\n  html.hoq-mobile .profileHeaderBackground__visual {\n    position: absolute !important; inset: 0 !important; width: 100% !important; height: 100% !important;\n    background-size: cover !important; background-position: center !important;\n    filter: blur(18px) saturate(1.2) brightness(.55) !important; transform: scale(1.15) !important; opacity: .5 !important;\n  }\n  html.hoq-mobile .profileHeader::after {\n    content: '' !important; position: absolute !important; inset: 0 !important; z-index: 1 !important;\n    background: linear-gradient(180deg, rgba(0,0,0,.15) 0%, rgba(0,0,0,.35) 55%, rgba(10,10,12,.9) 100%) !important;\n    pointer-events: none !important;\n  }\n  html.hoq-mobile .profileHeader__info { position: relative !important; z-index: 2 !important; width: auto !important; padding: 0 !important; }\n  html.hoq-mobile .profileHeaderInfo {\n    display: flex !important; flex-direction: column !important; align-items: center !important;\n    text-align: center !important; padding: 22px 12px 14px !important; gap: 8px !important; height: auto !important;\n  }\n  html.hoq-mobile .profileHeaderInfo__avatar { margin: 0 !important; float: none !important; }\n  html.hoq-mobile .profileHeaderInfo__avatar .image,\n  html.hoq-mobile .profileHeaderInfo__avatar .sc-artwork,\n  html.hoq-mobile .profileHeaderInfo__avatar > div {\n    width: 104px !important; height: 104px !important;\n    box-shadow: 0 6px 22px rgba(0,0,0,.5), 0 0 0 3px color-mix(in srgb, var(--sc-accent, #ff5500) 55%, transparent) !important;\n  }\n  html.hoq-mobile .profileHeaderInfo__content { width: 100% !important; min-width: 0 !important; padding: 0 !important; }\n  html.hoq-mobile .profileHeaderInfo__userName {\n    font-size: 23px !important; white-space: normal !important; overflow-wrap: anywhere !important;\n    text-shadow: 0 2px 8px rgba(0,0,0,.6) !important; margin: 0 !important; padding: 0 !important; background: none !important;\n  }\n  html.hoq-mobile .profileHeaderInfo__additional {\n    font-size: 13px !important; white-space: normal !important; text-shadow: 0 1px 4px rgba(0,0,0,.6) !important;\n    padding: 0 !important; background: none !important;\n  }\n  html.hoq-mobile .profileHeaderInfo__content br { display: none !important; }\n  /* \"Featured profiles\" is a desktop strip beside the banner. */\n  html.hoq-mobile .profileHeader .featuredProfiles { display: none !important; }\n  /* The app's Find a track / Play all / Shuffle bar sat over the avatar\n     (absolute, top of the banner). Put it under the name instead. */\n  html.hoq-mobile #hoq-pf-tools {\n    position: relative !important; z-index: 2 !important; order: 5 !important;\n    top: auto !important; left: auto !important; right: auto !important; bottom: auto !important;\n    display: flex !important; align-items: center !important; gap: 8px !important;\n    width: auto !important; margin: 0 12px 14px !important; padding: 0 !important; transform: none !important;\n    background: none !important; border: 0 !important; box-shadow: none !important;\n  }\n  html.hoq-mobile #hoq-pf-tools .hoq-pf-find { flex: 1 1 auto !important; min-width: 0 !important; width: auto !important; }\n  html.hoq-mobile #hoq-pf-tools .hoq-pf-find input { font-size: 16px !important; width: 100% !important; min-width: 0 !important; }\n  html.hoq-mobile #hoq-pf-tools .hoq-pf-btn { flex: none !important; }\n  /* Tabs and buttons: buttons first (Follow, Station, share...), then the tabs\n     as one row that scrolls sideways. */\n  html.hoq-mobile .l-vertical-bar { margin: 0 !important; }\n  html.hoq-mobile .userInfoBar {\n    display: flex !important; flex-direction: column-reverse !important; align-items: stretch !important;\n    gap: 10px !important; height: auto !important; padding: 12px 0 0 !important; border: 0 !important;\n  }\n  html.hoq-mobile .userInfoBar__buttons {\n    display: flex !important; justify-content: center !important; width: auto !important;\n    margin: 0 !important; padding: 0 !important; float: none !important; position: static !important;\n  }\n  html.hoq-mobile .userInfoBar__buttons .sc-button-group {\n    display: flex !important; flex-wrap: wrap !important; justify-content: center !important; gap: 8px !important; float: none !important;\n  }\n  html.hoq-mobile .userInfoBar__buttons .sc-button { float: none !important; margin: 0 !important; }\n  html.hoq-mobile .userInfoBar__tabs { width: auto !important; min-width: 0 !important; margin: 0 -14px !important; float: none !important; }\n  html.hoq-mobile .profileTabs.g-tabs {\n    display: flex !important; flex-wrap: nowrap !important; gap: 4px !important; width: auto !important;\n    overflow-x: auto !important; -webkit-overflow-scrolling: touch !important; scrollbar-width: none !important;\n    margin: 0 !important; padding: 0 14px !important; height: auto !important;\n  }\n  html.hoq-mobile .profileTabs.g-tabs::-webkit-scrollbar { display: none !important; }\n  html.hoq-mobile .profileTabs .g-tabs-item { flex: 0 0 auto !important; float: none !important; margin: 0 !important; }\n  html.hoq-mobile .profileTabs .g-tabs-link { padding: 12px 10px !important; margin: 0 !important; white-space: nowrap !important; font-size: 15px !important; }\n  /* The name bar that drops in when you scroll: a desktop 960px strip. */\n  html.hoq-mobile .dropbar { display: none !important; }\n  /* Followers / Following / Likes / Reposts lists: the person and the tabs were\n     pinned under the old header (fixed, 182px of a 844px screen, 14px off the\n     edge) over 112px of padding kept free for them. They scroll with the page. */\n  html.hoq-mobile .l-top {\n    position: static !important; top: auto !important; left: auto !important; right: auto !important;\n    width: auto !important; height: auto !important; z-index: auto !important; margin: 0 0 6px !important;\n  }\n  html.hoq-mobile .l-fixed-top-one-column { padding-top: 0 !important; }\n  html.hoq-mobile .userMain__content { padding: 0 !important; }\n  html.hoq-mobile .userStream__header, html.hoq-mobile .userMain .sectionHead { margin: 16px 0 4px !important; }\n\n  /* ======================================================================\n     12. Library (\"Collection\")\n     ====================================================================== */\n  /* The tab bar (Recently played / Likes / Playlists / ...): one sideways row. */\n  html.hoq-mobile .collectionNav,\n  html.hoq-mobile .collectionNav.g-tabs {\n    display: flex !important; flex-wrap: nowrap !important;\n    overflow-x: auto !important; -webkit-overflow-scrolling: touch !important;\n    scrollbar-width: none !important;\n  }\n  html.hoq-mobile .collectionNav::-webkit-scrollbar { display: none !important; }\n  html.hoq-mobile .collectionNav > li { flex: 0 0 auto !important; }\n  /* Section headers pack heading + Clear all + a filter into one row. */\n  html.hoq-mobile .playHistory__top,\n  html.hoq-mobile .collectionSection__top,\n  html.hoq-mobile .collectionSection__header { flex-wrap: wrap !important; gap: 6px 10px !important; }\n  html.hoq-mobile .collectionSection__flexFill { display: none !important; }\n  html.hoq-mobile .collectionSection__filters { flex: 1 1 100% !important; }\n  html.hoq-mobile .collectionSection__filterText,\n  html.hoq-mobile .collectionSection__filters .textfield { width: 100% !important; }\n  html.hoq-mobile .collectionSection__filters input { font-size: 16px !important; }\n  html.hoq-mobile .collectionSection__subHeading,\n  html.hoq-mobile .playHistory__subHeading { font-size: 18px !important; }\n  /* The Library OVERVIEW keeps one-row sideways shelves. Likes / Playlists /\n     Albums / ... use the same markup for the whole page, so they key off the\n     route tag the shim puts on <html>. */\n  html.hoq-mobile[data-hoq-route='/you/library'] .collection .lazyLoadingList__list {\n    display: flex !important; flex-wrap: nowrap !important; gap: 12px !important;\n    overflow-x: auto !important; -webkit-overflow-scrolling: touch !important;\n    scrollbar-width: none !important; scroll-snap-type: x proximity !important;\n    margin: 0 -14px !important; padding: 0 14px !important;\n  }\n  html.hoq-mobile[data-hoq-route='/you/library'] .collection .lazyLoadingList__list::-webkit-scrollbar { display: none !important; }\n  html.hoq-mobile[data-hoq-route='/you/library'] .collection .lazyLoadingList__list > .badgeList__item {\n    flex: 0 0 140px !important; width: 140px !important; margin: 0 !important; padding: 0 !important;\n    float: none !important; scroll-snap-align: start !important;\n  }\n  /* Everywhere else in the Library it's the whole list: two columns. */\n  html.hoq-mobile:not([data-hoq-route='/you/library']) .l-collection .lazyLoadingList__list:has(> .badgeList__item) {\n    display: grid !important; grid-template-columns: repeat(2, minmax(0, 1fr)) !important;\n    gap: 18px 12px !important; width: auto !important; overflow: visible !important;\n  }\n  html.hoq-mobile:not([data-hoq-route='/you/library']) .l-collection .lazyLoadingList__list:has(> .badgeList__item)::before,\n  html.hoq-mobile:not([data-hoq-route='/you/library']) .l-collection .lazyLoadingList__list:has(> .badgeList__item)::after { display: none !important; }\n  html.hoq-mobile:not([data-hoq-route='/you/library']) .l-collection .lazyLoadingList__list > .badgeList__item {\n    width: auto !important; min-width: 0 !important; margin: 0 !important; padding: 0 !important; float: none !important;\n  }\n  html.hoq-mobile .l-collection .badgeList__item .audibleTile,\n  html.hoq-mobile .l-collection .badgeList__item .playableTile { width: 100% !important; min-width: 0 !important; }\n  html.hoq-mobile .l-collection .badgeList { width: auto !important; max-width: 100% !important; }\n  /* The theme turns the Library tabs into a 172px side panel; stack it: the\n     tabs become a scrolling pill row above the content. */\n  html.hoq-mobile .l-collection:has(.collectionNav) { display: block !important; }\n  html.hoq-mobile .l-collection:has(.collectionNav) .l-nav {\n    position: static !important; width: 100% !important; flex: none !important; margin: 4px 0 14px !important;\n  }\n  html.hoq-mobile .l-collection:has(.collectionNav) .l-main { width: 100% !important; }\n  html.hoq-mobile .l-nav .collectionNav.g-tabs {\n    flex-direction: row !important; gap: 4px !important; padding: 5px !important;\n    border-radius: 14px !important; box-shadow: none !important;\n  }\n  html.hoq-mobile .l-nav .collectionNav.g-tabs li,\n  html.hoq-mobile .l-nav .collectionNav.g-tabs .g-tabs-item { width: auto !important; flex: 0 0 auto !important; }\n  html.hoq-mobile .l-nav .collectionNav.g-tabs a {\n    width: auto !important; white-space: nowrap !important; transform: none !important;\n    display: flex !important; align-items: center !important; min-height: 40px !important; box-sizing: border-box !important;\n    padding: 0 14px !important; font-size: 13.5px !important; border-radius: 10px !important;\n  }\n  /* The side panel's left accent bar reads wrong on a pill: a ring instead. */\n  html.hoq-mobile .l-nav .collectionNav.g-tabs .active a, html.hoq-mobile .l-nav .collectionNav.g-tabs a.active,\n  html.hoq-mobile .l-nav .collectionNav.g-tabs li.active a, html.hoq-mobile .l-nav .collectionNav.g-tabs [aria-current] a,\n  html.hoq-mobile .l-nav .collectionNav.g-tabs a[aria-current] {\n    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sc-accent, #ff5500) 45%, transparent) !important;\n  }\n  html.hoq-mobile .collection { padding: 0 !important; }\n  html.hoq-mobile .collection__section { margin-bottom: 18px !important; }\n\n  /* ======================================================================\n     13. Feed (\"Stream\") page furniture\n     ====================================================================== */\n  html.hoq-mobile .stream__header, html.hoq-mobile .streamHeader,\n  html.hoq-mobile .stream .sectionHead { margin: 8px 0 !important; }\n  html.hoq-mobile .stream__header h1, html.hoq-mobile .streamHeader__title { font-size: 19px !important; }\n  html.hoq-mobile .stream .emptyNetworkPage, html.hoq-mobile .streamOnboarding { padding: 14px !important; }\n\n  /* ======================================================================\n     14. Landing page (signed out, soundcloud.com/)\n     ====================================================================== */\n  html.hoq-mobile .frontMobileTeaser { display: block !important; width: auto !important; height: auto !important; min-height: 0 !important;\n    padding: 36px 18px !important; box-sizing: border-box !important; }\n  html.hoq-mobile .frontMobileTeaser .frontMobileTeaser__info { display: block !important; width: auto !important; max-width: none !important; margin: 0 !important; padding: 0 !important; }\n  html.hoq-mobile .frontMobileTeaser .frontMobileTeaser__info .g-type-marketing-header { display: block !important; width: auto !important; max-width: none !important;\n    margin: 0 !important; padding: 0 !important; font-size: 44px !important; line-height: .95 !important; }\n  html.hoq-mobile .frontMobileTeaser__qrRow { display: block !important; width: auto !important; margin-top: 16px !important; }\n  html.hoq-mobile .frontMobileTeaser__qrCode, html.hoq-mobile .frontMobileTeaser__devices { display: none !important; }\n  html.hoq-mobile .frontMobileTeaser__qrInfo { display: block !important; width: auto !important; max-width: none !important; margin: 0 !important; font-size: 16px !important; line-height: 1.4 !important; }\n  html.hoq-mobile .onSoundCloudTeaser { display: flex !important; flex-direction: column !important; gap: 18px !important; width: auto !important;\n    padding: 28px 18px !important; box-sizing: border-box !important; }\n  html.hoq-mobile .onSoundCloudTeaser__image { width: 100% !important; height: 240px !important; margin: 0 !important; border-radius: 16px !important;\n    background-size: cover !important; background-position: center !important; }\n  html.hoq-mobile .onSoundCloudTeaser__wrapper { width: auto !important; max-width: none !important; margin: 0 !important; padding: 0 !important; }\n  html.hoq-mobile .onSoundCloudTeaser__title { width: auto !important; font-size: 38px !important; line-height: 1 !important; }\n  html.hoq-mobile .onSoundCloudTeaser__text, html.hoq-mobile .onSoundCloudTeaser__wrapper > div { width: auto !important; max-width: none !important; }\n\n  /* ======================================================================\n     15. Signed-in pages from SoundCloud's newer app, in a frame (Home\n     modules, track pages). The frame itself sits between the bars; what's\n     inside it is tools/mobile-frame.css.\n     ====================================================================== */\n  /* Home's modules: edge to edge, so their sideways shelves run off the screen\n     edge instead of stopping 28px short of it. */\n  html.hoq-mobile .webiEmbeddedModuleContainer { margin-left: -14px !important; margin-right: -14px !important; }\n  /* An iframe doesn't stretch between top and bottom (it falls back to 150px\n     tall), so it gets an explicit height. dvh where iOS has it (15.4+).\n     Only SoundCloud's in-page frame (what its own CSS lays out as a page):\n     its .fullScreen pages (Upload ...) keep covering everything. */\n  html.hoq-mobile body > .webiIframeV2Layout:not(.fullScreen):not(.sc-hidden) {\n    position: fixed !important; top: var(--hoq-top) !important; left: 0 !important; right: auto !important; bottom: auto !important;\n    width: 100% !important; margin: 0 !important; z-index: 1 !important;\n    height: calc(100vh - var(--hoq-top) - var(--hoq-tabs)) !important;\n    height: calc(100dvh - var(--hoq-top) - var(--hoq-tabs)) !important;\n  }\n\n  /* Our own surfaces from the desktop theme, at phone width. */\n  html.hoq-mobile #hoq-discord .hoq-dc-quick button { padding: 9px 14px !important; min-height: 40px !important; }\n\n  /* Reduce Motion (iOS Settings -> Accessibility -> Motion): no slides, pops\n     or swipes, things just appear. */\n  @media (prefers-reduced-motion: reduce) {\n    html.hoq-mobile #hoq-mnp, html.hoq-mobile #hoq-mnp.on,\n    #hoq-mnp .mnp-art, #hoq-mnp .mnp-rail, #hoq-mnp .mnp-knob, #hoq-pill .pl-prog,\n    #hoq-tabs button svg, #hoq-mtoast { transition: none !important; }\n    #hoq-pill .pl-meta.sw-l, #hoq-pill .pl-meta.sw-r, #hoq-pill .pl-like.pop svg, #hoq-mnp .mnp-like.pop svg,\n    #hoq-acts, #hoq-acts .ac-box { animation: none !important; }\n  }\n}\n\n/* ========================================================================\n   Signed out. The proxy cannot complete a sign-in (SoundCloud's bot\n   protection challenges it), so every account control is a dead end: tapping\n   Like or Follow opens a sign-in modal that cannot succeed. Applied only when\n   actually signed out, so this all comes back once a session is present.\n   ======================================================================== */\nhtml.hoq-anon .header__userNav,\nhtml.hoq-anon .header__soundInput,\nhtml.hoq-anon .uploadButton,\nhtml.hoq-anon .header__forArtistsButton,\nhtml.hoq-anon .header__upsellWrapper,\nhtml.hoq-anon .header__moreButton { display: none !important; }\n/* Sign in / Create account sit together in .header__loginMenu. */\nhtml.hoq-anon .header__loginMenu,\nhtml.hoq-anon .loginButton,\nhtml.hoq-anon .signupButton { display: none !important; }\n/* The auth modal and whatever backdrop carries it. */\nhtml.hoq-anon div:has(> iframe[src*='web-auth']),\nhtml.hoq-anon div:has(> iframe[src*='one-tap']),\nhtml.hoq-anon .modal, html.hoq-anon .modal__modal,\nhtml.hoq-anon [class*='authModal' i],\nhtml.hoq-anon .g-modal-overlay { display: none !important; }\nhtml.hoq-anon body { overflow: auto !important; }\n/* Actions that need an account. */\nhtml.hoq-anon .sc-button-like,\nhtml.hoq-anon .sc-button-follow,\nhtml.hoq-anon .sc-button-repost,\nhtml.hoq-anon .playableTile__actionButton,\nhtml.hoq-anon .playbackSoundBadge__follow,\nhtml.hoq-anon .playbackSoundBadge__like { display: none !important; }\n/* Promos and upsells: all of them lead to signup. */\nhtml.hoq-anon .l-product-banners,\nhtml.hoq-anon .banner,\nhtml.hoq-anon [class*='upsell' i],\nhtml.hoq-anon [class*='Upsell' i] { display: none !important; }\n/* Stream and Collection are account-only: signed out they redirect to a wall. */\nhtml.hoq-anon .header__navMenuItem[data-menu-name='stream'],\nhtml.hoq-anon .header__navMenuItem[data-menu-name='library'] { display: none !important; }\nhtml.hoq-anon .header__navMenu > li:has(> [data-menu-name='stream']),\nhtml.hoq-anon .header__navMenu > li:has(> [data-menu-name='library']) { display: none !important; }\n\n/* Signed out on the proxy: SoundCloud's own Sign in can't complete here, so a\n   clear way in -- the desktop app hands its session over (Settings -> Phone). */\n#hoq-signin-cta {\n  display: none; align-items: center; gap: 12px; box-sizing: border-box;\n  margin: 12px 14px 4px; padding: 12px 12px 12px 14px; border-radius: 16px;\n  background: linear-gradient(135deg, color-mix(in srgb, var(--sc-accent, #ff5500) 24%, #15151a), #15151a 80%);\n  border: 1px solid color-mix(in srgb, var(--sc-accent, #ff5500) 50%, transparent);\n  box-shadow: 0 8px 26px color-mix(in srgb, var(--sc-accent, #ff5500) 18%, transparent);\n  font: 13px/1.35 -apple-system, Inter, Arial, sans-serif; color: #d6d6dc;\n}\nhtml.hoq-anon #hoq-signin-cta { display: flex; }\n/* Wider than a phone (an iPad, a computer's browser) SoundCloud's own fixed\n   47px header is back and the page below keeps a 46px gap for it: the banner\n   clears the header, lines up with the 1240px page, and takes that gap back. */\n/* (the exact opposite of the phone layout's query: not a phone turned sideways) */\n@media (min-width: 821px) and (min-height: 501px), (min-width: 821px) and (pointer: fine), (min-width: 821px) and (pointer: none) {\n  html.hoq-anon #hoq-signin-cta { width: calc(100% - 28px); max-width: 1240px; margin: 59px auto -34px; }\n}\n#hoq-signin-cta .cta-txt { flex: 1 1 auto; min-width: 0; }\n#hoq-signin-cta .cta-txt b { display: block; color: #fff; font-size: 14px; margin-bottom: 1px; }\n#hoq-signin-cta button, #hoq-signin-sheet .sh-go {\n  flex: none; border: 0; border-radius: 11px; padding: 10px 14px; cursor: pointer;\n  background: var(--sc-accent, #ff5500); color: #fff; font: 700 13px -apple-system, Inter, Arial, sans-serif;\n  box-shadow: 0 0 18px color-mix(in srgb, var(--sc-accent, #ff5500) 45%, transparent);\n}\n#hoq-signin-sheet {\n  position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: flex-end; justify-content: center;\n  background: rgba(0,0,0,.55); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);\n}\n#hoq-signin-sheet[hidden] { display: none; }\n#hoq-signin-sheet .sh {\n  width: 100%; max-width: 520px; max-height: 88vh; max-height: 88dvh; overflow-y: auto; box-sizing: border-box;\n  background: #141418; border: 1px solid rgba(255,255,255,.1); border-bottom: 0;\n  border-radius: 20px 20px 0 0;\n  padding: 20px max(18px, env(safe-area-inset-right)) calc(22px + env(safe-area-inset-bottom)) max(18px, env(safe-area-inset-left));\n  font: 14px/1.45 -apple-system, Inter, Arial, sans-serif; color: #c9c9d2;\n  overscroll-behavior: contain;\n  /* lifted above the iOS keyboard while you paste a link (tools/mobile-ui.js\n     keeps --hoq-kb at the keyboard's height) */\n  margin-bottom: var(--hoq-kb, 0px); transition: margin-bottom .2s ease;\n}\n/* Scan the code: the main way in, so the big button. */\n#hoq-signin-sheet .sh-scan {\n  display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; min-height: 52px; margin: 2px 0 16px;\n  border: 0; border-radius: 14px; cursor: pointer; background: var(--sc-accent, #ff5500); color: #fff;\n  font: 700 16px -apple-system, Inter, Arial, sans-serif; touch-action: manipulation; -webkit-tap-highlight-color: transparent;\n  box-shadow: 0 6px 22px color-mix(in srgb, var(--sc-accent, #ff5500) 40%, transparent);\n}\n#hoq-signin-sheet .sh-scan:active { transform: scale(.98); }\n#hoq-signin-sheet .sh-scan svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linejoin: round; }\n#hoq-signin-sheet .sh-go, #hoq-signin-sheet .sh-close { min-height: 44px; touch-action: manipulation; }\n\n/* The QR scanner (tools/mobile-signin.js): the camera, full screen, a guide\n   square in the middle with everything around it dimmed. */\n#hoq-scan {\n  position: fixed; inset: 0; z-index: 2147483100; overflow: hidden; background: #000; color: #fff;\n  font: 14px/1.4 -apple-system, Inter, 'Helvetica Neue', Arial, sans-serif;\n  -webkit-user-select: none; user-select: none; touch-action: none; overscroll-behavior: contain;\n}\n#hoq-scan[hidden] { display: none; }\n#hoq-scan video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }\n#hoq-scan .sc-frame {\n  position: absolute; left: 50%; top: 50%; width: min(74vw, 56vh, 360px); aspect-ratio: 1 / 1;\n  transform: translate(-50%, -50%); border-radius: 24px; box-shadow: 0 0 0 100vmax rgba(0,0,0,.55);\n}\n#hoq-scan .sc-frame i { position: absolute; width: 38px; height: 38px; border: 4px solid var(--sc-accent, #ff5500); }\n#hoq-scan .sc-frame i:nth-child(1) { left: -2px; top: -2px; border-right: 0; border-bottom: 0; border-top-left-radius: 24px; }\n#hoq-scan .sc-frame i:nth-child(2) { right: -2px; top: -2px; border-left: 0; border-bottom: 0; border-top-right-radius: 24px; }\n#hoq-scan .sc-frame i:nth-child(3) { left: -2px; bottom: -2px; border-right: 0; border-top: 0; border-bottom-left-radius: 24px; }\n#hoq-scan .sc-frame i:nth-child(4) { right: -2px; bottom: -2px; border-left: 0; border-top: 0; border-bottom-right-radius: 24px; }\n#hoq-scan .sc-top, #hoq-scan .sc-bottom { position: absolute; left: 0; right: 0; text-align: center; box-sizing: border-box;\n  padding-left: max(22px, env(safe-area-inset-left)); padding-right: max(22px, env(safe-area-inset-right)); }\n#hoq-scan .sc-top { top: 0; padding-top: calc(env(safe-area-inset-top, 0px) + 24px); }\n#hoq-scan .sc-top b { display: block; margin-bottom: 6px; font-size: 20px; }\n#hoq-scan .sc-top span { display: block; color: rgba(255,255,255,.78); font-size: 13.5px; }\n#hoq-scan .sc-bottom { bottom: 0; padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 22px); }\n#hoq-scan .sc-msg { min-height: 20px; margin: 0 auto 14px; max-width: 420px; text-shadow: 0 1px 4px rgba(0,0,0,.8); }\n#hoq-scan .sc-cancel {\n  width: 100%; max-width: 420px; min-height: 52px; border-radius: 14px; cursor: pointer;\n  border: 1px solid rgba(255,255,255,.28); background: rgba(18,18,22,.72);\n  -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);\n  color: #fff; font: 700 16px -apple-system, Inter, Arial, sans-serif; touch-action: manipulation;\n}\n#hoq-signin-sheet h3 { margin: 0 0 4px; color: #fff; font-size: 19px; }\n#hoq-signin-sheet .sh-sub { margin: 0 0 14px; color: #9a9aa4; font-size: 13px; }\n#hoq-signin-sheet ol { margin: 0 0 14px; padding: 0; list-style: none; counter-reset: s; }\n#hoq-signin-sheet li { position: relative; padding: 0 0 12px 36px; counter-increment: s; }\n#hoq-signin-sheet li::before {\n  content: counter(s); position: absolute; left: 0; top: -1px; width: 24px; height: 24px; border-radius: 50%;\n  display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 12px;\n  background: color-mix(in srgb, var(--sc-accent, #ff5500) 22%, transparent); color: var(--sc-accent, #ff5500);\n}\n#hoq-signin-sheet li b, #hoq-signin-sheet .sh-k { color: #fff; }\n#hoq-signin-sheet .sh-k { font-weight: 700; }\n#hoq-signin-sheet .sh-paste { margin-top: 4px; padding-top: 14px; border-top: 1px solid rgba(255,255,255,.08); }\n#hoq-signin-sheet .sh-paste p { margin: 0 0 8px; font-size: 13px; color: #9a9aa4; }\n#hoq-signin-sheet .sh-row { display: flex; gap: 8px; }\n#hoq-signin-sheet input {\n  flex: 1 1 auto; min-width: 0; box-sizing: border-box; padding: 10px 12px; border-radius: 10px;\n  border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.05); color: #fff;\n  font: 16px -apple-system, Inter, Arial, sans-serif;   /* 16px: iOS won't zoom the page on focus */\n}\n#hoq-signin-sheet .sh-msg { min-height: 18px; margin-top: 8px; font-size: 13px; color: #ff8a7a; }\n#hoq-signin-sheet .sh-close {\n  display: block; width: 100%; margin-top: 14px; padding: 11px; border-radius: 10px; cursor: pointer;\n  border: 1px solid rgba(255,255,255,.12); background: transparent; color: #c9c9d2; font: 600 14px -apple-system, Inter, Arial, sans-serif;\n}\n/* No PC (for now): sign in on soundcloud.com and carry it over with a bookmark\n   (tools/mobile-signin.js). Folded away under the PC ways in. */\n#hoq-signin-sheet .sh-nopc { margin-top: 14px; padding-top: 14px; border-top: 1px solid rgba(255,255,255,.08); }\n#hoq-signin-sheet .sh-nopc summary {\n  display: flex; align-items: center; justify-content: space-between; min-height: 44px; cursor: pointer;\n  list-style: none; color: #fff; font-weight: 700; font-size: 14.5px; -webkit-tap-highlight-color: transparent;\n}\n#hoq-signin-sheet .sh-nopc summary::-webkit-details-marker { display: none; }\n#hoq-signin-sheet .sh-nopc summary::after { content: '+'; color: var(--sc-accent, #ff5500); font-size: 22px; font-weight: 600; }\n#hoq-signin-sheet .sh-nopc[open] summary::after { content: '\\2212'; }\n#hoq-signin-sheet .sh-nopc h4 { margin: 14px 0 10px; color: #fff; font-size: 13px; text-transform: uppercase; letter-spacing: .06em; }\n#hoq-signin-sheet .sh-nopc .sh-note, #hoq-signin-sheet .sh-nopc .sh-app-note { margin: 4px 0 0; font-size: 13px; color: #9a9aa4; }\n#hoq-signin-sheet .sh-nopc .sh-app-note {\n  margin-top: 10px; padding: 10px 12px; border-radius: 10px; color: #e7e7ed;\n  background: color-mix(in srgb, var(--sc-accent, #ff5500) 14%, transparent);\n}\n#hoq-signin-sheet .sh-nopc .sh-app-note[hidden] { display: none; }\n#hoq-signin-sheet .sh-nopc li { font-size: 13.5px; }\n#hoq-signin-sheet .sh-copybm {\n  display: block; width: 100%; min-height: 44px; margin-top: 8px; border-radius: 11px; cursor: pointer;\n  border: 1px solid color-mix(in srgb, var(--sc-accent, #ff5500) 60%, transparent);\n  background: color-mix(in srgb, var(--sc-accent, #ff5500) 16%, transparent); color: #fff;\n  font: 700 14px -apple-system, Inter, Arial, sans-serif; touch-action: manipulation;\n}\n#hoq-signin-sheet .sh-bmcode {\n  display: block; width: 100%; box-sizing: border-box; margin-top: 8px; padding: 8px 10px; border-radius: 10px; resize: none;\n  border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.05); color: #fff;\n  font: 16px ui-monospace, Menlo, monospace;   /* 16px: no zoom on focus */\n}\n#hoq-signin-sheet .sh-bmcode[hidden] { display: none; }\n#hoq-signin-sheet .sh-bmmsg { min-height: 0; margin-top: 6px; font-size: 12.5px; color: #9ee6a8; }\n#hoq-signin-sheet .sh-bmmsg:empty { display: none; }\n";
  (document.head || H).appendChild(mob);

  // Keep the desktop layout legible instead of letting the browser scale it
  // down. You still need the browser's "Request Desktop Website" — a
  // userscript cannot change the UA of a request that already happened.
  let vWrites = 0;
  const setViewport = () => {
    // Circuit breaker. A runaway viewport loop blocks the main thread and the
    // page never finishes loading -- it took the whole site down once. No
    // legitimate reason to write this more than a handful of times. It counts
    // writes, not calls: SoundCloud adds to <head> all the time, and counting
    // every one used up the guard within seconds of loading.
    if (vWrites > 60) return;
    let m = document.querySelector('meta[name="viewport"]');
    if (!m) { vWrites++; m = document.createElement('meta'); m.name = 'viewport'; (document.head || H).appendChild(m); }
    const want = 'width=device-width, initial-scale=1, viewport-fit=cover';
    // Only write when it actually differs. The observer below watches head
    // attributes, so an unconditional setAttribute retriggers it forever and
    // the page never finishes loading.
    if (m.getAttribute('content') !== want) { vWrites++; m.setAttribute('content', want); }
  };
  setViewport();
  window.addEventListener('orientationchange', () => setTimeout(setViewport, 150));

  // Keep asserting it. The whole mobile layout hangs off a media query, so if
  // anything rewrites this meta the page snaps back to the 1280px desktop
  // canvas and every rule silently stops matching.
  try {
    new MutationObserver(setViewport).observe(document.head || H, { childList: true });
  } catch (e) {}
  let vTicks = 0;
  const vTimer = setInterval(() => { setViewport(); if (++vTicks > 20) clearInterval(vTimer); }, 500);

  // Touch has no hover, so these cost frame time and give nothing back (and
  // a row hover highlight sticks after a tap). The keys are effectOn()'s
  // 'scFx_' + name: this wrote 'scFxTilt' etc. for years, which nothing read.
  try {
    if (matchMedia('(hover: none)').matches) {
      ['tilt', 'wave', 'pulse', 'hover'].forEach((k) => localStorage.setItem('scFx_' + k, '0'));
    }
  } catch (e) {}

  // Features with no mobile equivalent. Hiding them beats showing a control
  // that silently does nothing.
  const DEAD = ['accounts', 'last.fm scrobbling'];
  // The Social/Settings page is only built the first time it opens, which can
  // be long after load: keep checking (each section once) rather than giving
  // up after a few seconds, which left these showing.
  const prune = () => {
    document.querySelectorAll('#hoq-discord .hoq-dc-sec:not([data-hoq-pruned])').forEach((sec) => {
      sec.dataset.hoqPruned = '1';
      const l = sec.querySelector('.hoq-dc-label');
      if (l && DEAD.indexOf(l.textContent.trim().toLowerCase()) !== -1) sec.style.display = 'none';
    });
  };
  prune();
  setInterval(() => { if (!document.hidden) prune(); }, 700);

  // Signed out? Then hide the account controls (see hoq-anon in the CSS).
  // Detected from the DOM rather than a cookie, because the proxy forwards
  // SoundCloud's own cookies and an anonymous session still sets several.
  const anonTick = () => {
    const signedIn = !!document.querySelector(".header__userNavUsernameButton, .header__userNav a[href^='/you']");
    const signInBtn = [...document.querySelectorAll(".header__right a, .header__right button")]
      .some((b) => /sign in|create account/i.test(b.textContent || ""));
    if (!signedIn && signInBtn) H.classList.add("hoq-anon");
    else if (signedIn) H.classList.remove("hoq-anon");
    // The auth iframe is injected on demand; drop its container outright so a
    // hidden-but-present modal cannot still trap scroll or taps.
    if (H.classList.contains("hoq-anon")) {
      document.querySelectorAll("iframe[src*='web-auth'], iframe[src*='one-tap']").forEach((f) => {
        const box = f.closest("div[class]") || f.parentElement;
        if (box && box !== document.body) box.remove(); else f.remove();
      });
    }
  };
  anonTick();
  setInterval(() => { if (!document.hidden) anonTick(); }, 1200);   // idle while the page is hidden (battery)

  // ---- route tag + Library pill row -----------------------------------
  // CSS that differs by page keys off html[data-hoq-route]: the Library
  // overview keeps its one-row shelves, Likes / Playlists / … get a grid.
  let pillRoute = '';
  const tagRoute = () => {
    const p = location.pathname.replace(/\/+$/, '') || '/';
    if (H.dataset.hoqRoute !== p) H.dataset.hoqRoute = p;
    // The Library tabs scroll sideways on a phone; keep the current one in view.
    if (pillRoute === p) return;
    const nav = document.querySelector('.l-nav .collectionNav');
    const cur = nav && nav.querySelector('a.active, .active a, a[aria-current], [aria-current] a');
    if (!cur) return;
    pillRoute = p;
    const nr = nav.getBoundingClientRect(), cr = cur.getBoundingClientRect();
    if (cr.left < nr.left || cr.right > nr.right) nav.scrollLeft += cr.left - nr.left - (nr.width - cr.width) / 2;
  };
  ['pushState', 'replaceState'].forEach((k) => {
    const orig = history[k];
    history[k] = function () {
      const r = orig.apply(this, arguments);
      setTimeout(tagRoute, 0); setTimeout(tagRoute, 700);
      return r;
    };
  });
  window.addEventListener('popstate', () => setTimeout(tagRoute, 0));
  tagRoute();
  setInterval(() => { if (!document.hidden) tagRoute(); }, 1500);

  // ---- signed out: sign in on the phone (proxy only) -------------------
  // SoundCloud's own Sign in can't finish through the proxy (hoq-anon hides it),
  // so the desktop app hands its session over (Social/Settings -> Settings ->
  // Phone). Its code is scanned right here, with this page's own camera: the
  // iPhone camera app opens Safari, which is not where a Home Screen web app
  // keeps its sign-in, so that needed a new tab or a pasted link. Shown only
  // while signed out (CSS: html.hoq-anon). Styles: tools/mobile.css.
  // tools/build-userscript.js puts this inside the mobile shim (H in scope).
  if (window.__hoqProxyBuild) (() => {
    let cta = null, sheet = null, scan = null;
    // A full load, so the redeem block at the top of preload runs (a hash-only
    // change wouldn't reload the page).
    const signInWith = (hash) => {
      location.href = location.origin + (location.pathname === '/discover' ? '/' : '/discover') + hash;
    };
    // What a code or a pasted link can be: the QR's link, which carries the
    // login after #hoq-login=, or a one-time /__hoq/pair/<id> link.
    const parse = (v) => {
      v = String(v || '').trim();
      const at = v.indexOf('#hoq-login=');
      if (at >= 0 && /^#hoq-login=[A-Za-z0-9_-]{16,}$/.test(v.slice(at))) return { hash: v.slice(at) };
      const m = v.match(/\/__hoq\/pair\/([A-Za-z0-9_-]{16,64})(?:[?#]|$)/) || v.match(/^([A-Za-z0-9_-]{16,64})$/);
      return m ? { id: m[1] } : null;
    };
    // Returns a promise that only settles on failure (success leaves the page).
    const redeem = (p) => {
      if (p.hash) { signInWith(p.hash); return new Promise(() => {}); }
      return fetch('/__hoq/pair/' + p.id, { method: 'POST' })
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((d) => { signInWith('#hoq-login=' + d.frag); return new Promise(() => {}); });
    };
    const failText = (s) => (s === 410
      ? 'That link was already used or has expired. Make a new one on your PC.'
      : 'Couldn’t sign in. Check your connection and try again.');

    // ---- no PC (for now): carry a soundcloud.com sign-in over -------------
    // Until there's a direct way in, a phone with no PC signs in on soundcloud.com
    // itself and runs this bookmark there. It reads SoundCloud's two login
    // cookies (neither is HttpOnly) and opens this site with them after
    // #hoq-login=, the same hand-over the PC code's long link does; the redeem
    // block at the top of preload sets them, year-long. SoundCloud's mobile site
    // (m.soundcloud.com, where an iPhone is sent) keeps its login out of reach,
    // so it asks for the desktop site there.
    // Built from a function so it needs no escaping. Inside it: no comments (the
    // lines get joined), no '%' (a javascript: URL is percent-decoded first) and
    // no '#' (char 35 instead, so nothing reads it as the URL's fragment).
    const handOver = function () {
      var h = location.hostname;
      var g = function (n) { var m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')); return m ? m[1] : ''; };
      if (!/(^|\.)soundcloud\.com$/.test(h)) { alert('Open soundcloud.com first and sign in there, then tap this bookmark again.'); return; }
      var o = g('oauth_token');
      if (!o) {
        alert(h.indexOf('m.') === 0
          ? 'This is SoundCloud\'s mobile site. Switch to the desktop site first: open the page menu in the address bar (aA) and tap Request Desktop Website. Sign in if it asks, then tap this bookmark again.'
          : 'You\'re not signed in on soundcloud.com yet. Sign in there, then tap this bookmark again.');
        return;
      }
      var b = btoa(JSON.stringify({ o: o, s: g('sc_session') })).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
      location.href = 'https://sc.holdonquietly.com/discover' + String.fromCharCode(35) + 'hoq-login=' + b;
    };
    const BOOKMARK = 'javascript:(' + String(handOver).replace(/\s*[\r\n]+\s*/g, ' ') + ')();';
    window.__hoqHandOverBookmark = BOOKMARK;   // for tests and the guide
    // Copy, or failing that select it in a box to copy by hand.
    const copyText = (text, box, onDone) => {
      const manual = () => { box.hidden = false; box.value = text; box.focus(); box.select(); box.setSelectionRange(0, text.length); onDone(false); };
      try { navigator.clipboard.writeText(text).then(() => onDone(true), manual); } catch (e) { manual(); }
    };
    const standalone = () => !!(navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches));
    const NOPC_HTML =
      '<details class="sh-nopc">' +
        '<summary>No PC? Sign in on soundcloud.com instead</summary>' +
        '<p class="sh-note">A stand-in until there&rsquo;s a direct way to sign in here. You set up a bookmark once, then sign in on SoundCloud&rsquo;s own site and the bookmark brings you back here signed in. Your password only ever goes into soundcloud.com. Do these steps in <b>Safari</b>.</p>' +
        '<p class="sh-app-note">You&rsquo;re in the Home Screen app, which keeps its own sign-in, separate from Safari&rsquo;s. Do steps 1 to 7 in Safari, then step 8 brings the sign-in into this app.</p>' +
        '<h4>Set up the bookmark (once)</h4>' +
        '<ol>' +
          '<li>Tap <span class="sh-k">Copy the bookmark</span> below. It copies a short piece of code.' +
            '<button class="sh-copybm" type="button">Copy the bookmark</button>' +
            '<textarea class="sh-bmcode" readonly hidden rows="3" aria-label="Bookmark code"></textarea>' +
            '<div class="sh-bmmsg" aria-live="polite"></div></li>' +
          '<li>Bookmark any page: tap the <b>Share</b> button (the square with an arrow), then <b>Add Bookmark</b>. Name it <b>hoq sign-in</b> and tap <b>Save</b>.</li>' +
          '<li>Open your bookmarks (the <b>book</b> icon), tap <b>Edit</b>, then tap <b>hoq sign-in</b>. Clear the address under the name (the &#9447; button), paste the code there, and tap <b>Done</b>.</li>' +
        '</ol>' +
        '<h4>Sign in</h4>' +
        '<ol style="counter-reset: s 3">' +
          '<li>Go to <b>soundcloud.com</b> in Safari.</li>' +
          '<li>Open the page menu in the address bar (<b>aA</b>) and tap <b>Request Desktop Website</b>. SoundCloud&rsquo;s mobile site hides its sign-in from the bookmark.</li>' +
          '<li>Sign in to SoundCloud there, the normal way.</li>' +
          '<li>Still on soundcloud.com, tap the address bar, type <b>hoq sign-in</b> and tap the bookmark when it shows up. (Tapping it in your bookmarks works too.) You&rsquo;re brought back here, signed in.</li>' +
          '<li><b>Home Screen app only:</b> in Safari, signed in here, open <b>Social</b> &rarr; <b>Settings</b> &rarr; <b>Home Screen app</b> and tap <b>Copy link</b>. Then open the app, tap <b>Sign in</b> and paste the link into the box above. It works once, within 10 minutes.</li>' +
        '</ol>' +
        '<p class="sh-note">Afterwards you can turn <b>Request Desktop Website</b> back off for soundcloud.com. You only need the bookmark again if you&rsquo;re ever signed out.</p>' +
      '</details>';
    const setupNoPc = (root) => {
      root.querySelector('.sh-app-note').hidden = !standalone();
      const btn = root.querySelector('.sh-copybm'), box = root.querySelector('.sh-bmcode'), msg = root.querySelector('.sh-bmmsg');
      btn.addEventListener('click', () => {
        copyText(BOOKMARK, box, (ok) => {
          msg.textContent = ok ? 'Copied. Now do step 2.' : 'Copy the code in the box (tap it, Select All, Copy), then do step 2.';
        });
      });
    };

    // ---- the QR scanner -----------------------------------------------------
    // iOS has no BarcodeDetector (Safari keeps it switched off), so the decoder
    // is jsQR, fetched only when you open the scanner, pinned by its hash.
    const JSQR = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
    const JSQR_SRI = 'sha384-b5Ya4Bq3qCyz39m2ISh+4DxjAIljdeFwK/BsXLuj9gugaNwAcj/ia15fxNZL9Nlx';
    let jsqrP = null;
    const loadJsQR = () => jsqrP || (jsqrP = new Promise((res, rej) => {
      if (typeof window.jsQR === 'function') { res(window.jsQR); return; }
      // It registers as an AMD module if the page has a define(): hide that
      // while it loads, so it lands on window.jsQR.
      const amd = window.define;
      if (amd && amd.amd) window.define = undefined;
      const s = document.createElement('script');
      s.src = JSQR; s.integrity = JSQR_SRI; s.crossOrigin = 'anonymous'; s.async = true;
      const done = () => { if (amd && amd.amd) window.define = amd; };
      s.onload = () => { done(); typeof window.jsQR === 'function' ? res(window.jsQR) : rej(new Error('no decoder')); };
      s.onerror = () => { done(); jsqrP = null; rej(new Error('decoder failed to load')); };
      document.head.appendChild(s);
    }));
    let detector = null;   // the native one, where there is one (Android Chrome)
    try {
      if ('BarcodeDetector' in window) {
        window.BarcodeDetector.getSupportedFormats()
          .then((f) => { if (f.indexOf('qr_code') >= 0) detector = new window.BarcodeDetector({ formats: ['qr_code'] }); })
          .catch(() => {});
      }
    } catch (e) {}

    const CAM = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.6l1.2-1.8c.3-.4.7-.7 1.2-.7h3c.5 0 .9.3 1.2.7L15.9 6h1.6A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z"/><circle cx="12" cy="12.4" r="3.4"/></svg>';
    const closeScan = () => {
      if (!scan) return;
      scan.open = false;
      clearTimeout(scan.timer);
      if (scan.stream) scan.stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
      scan.stream = null;
      try { scan.video.srcObject = null; } catch (e) {}
      scan.el.hidden = true;
    };
    const openScan = () => {
      if (scan && scan.open) return;   // a quick second tap: one camera, not two
      if (!scan) {
        const el = document.createElement('div');
        el.id = 'hoq-scan';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'true');
        el.setAttribute('aria-label', 'Scan the sign-in code');
        el.innerHTML =
          '<video playsinline muted autoplay></video>' +
          '<div class="sc-frame" aria-hidden="true"><i></i><i></i><i></i><i></i></div>' +
          '<div class="sc-top"><b>Scan the code on your PC</b>' +
            '<span>holdonquietly on your PC &rarr; Social/Settings &rarr; Settings &rarr; Phone &rarr; Show code</span></div>' +
          '<div class="sc-bottom"><div class="sc-msg" aria-live="polite">Starting the camera…</div>' +
            '<button class="sc-cancel" type="button">Cancel</button></div>';
        document.body.appendChild(el);
        scan = { el, video: el.querySelector('video'), msg: el.querySelector('.sc-msg'), stream: null, timer: 0, open: false };
        scan.video.muted = true;   // iOS: a playsinline, muted video can start without a tap
        el.querySelector('.sc-cancel').addEventListener('click', closeScan);
        // A camera left running in the background would keep the green dot on.
        document.addEventListener('visibilitychange', () => { if (document.hidden) closeScan(); });
        window.addEventListener('pagehide', closeScan);
      }
      const say = (t) => { scan.msg.textContent = t; };
      scan.el.hidden = false;
      scan.open = true;
      say('Starting the camera…');
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        say('This browser can’t use the camera here. Paste the link instead.');
        return;
      }
      loadJsQR().catch(() => {});   // fetch the decoder while the camera starts
      navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      }).then((stream) => {
        if (!scan.open) { stream.getTracks().forEach((t) => t.stop()); return; }
        scan.stream = stream;
        scan.video.srcObject = stream;
        const p = scan.video.play();
        if (p && p.catch) p.catch(() => {});
        say('Point it at the code.');
        loop();
      }).catch((err) => {
        const n = err && err.name;
        say(n === 'NotAllowedError' || n === 'SecurityError'
          ? 'Camera access is off for this site. Allow it in Settings (Safari → Camera, or this app’s own settings), or paste the link.'
          : n === 'NotFoundError' || n === 'OverconstrainedError'
            ? 'No camera found. Paste the link instead.'
            : 'Couldn’t start the camera. Paste the link instead.');
      });
    };
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let wrongAt = 0;
    const found = (text) => {
      const p = parse(text);
      if (!p) {
        // Some other QR code: say so, keep looking.
        if (Date.now() - wrongAt > 2500) { wrongAt = Date.now(); scan.msg.textContent = 'That’s not a holdonquietly sign-in code.'; }
        return false;
      }
      closeScan();
      if (sheet) { sheet.querySelector('.sh-msg').textContent = 'Signing you in…'; }
      redeem(p).catch((s) => { if (sheet) sheet.querySelector('.sh-msg').textContent = failText(s); });
      return true;
    };
    const loop = () => {
      if (!scan || !scan.open) return;
      const v = scan.video;
      const next = () => { if (scan && scan.open) scan.timer = setTimeout(loop, 140); };
      if (v.readyState < 2 || !v.videoWidth) { next(); return; }
      const read = detector
        ? detector.detect(v).then((r) => (r && r[0] && r[0].rawValue) || '')
        : loadJsQR().then((jsQR) => {
          // The middle square of the frame (where the guide is), at most 960px
          // a side: the code is dense (the login is in it), so not much less.
          const vw = v.videoWidth, vh = v.videoHeight, side = Math.min(vw, vh), size = Math.min(side, 960);
          canvas.width = canvas.height = size;
          ctx.drawImage(v, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, size, size);
          const code = jsQR(ctx.getImageData(0, 0, size, size).data, size, size, { inversionAttempts: 'dontInvert' });
          return (code && code.data) || '';
        });
      read.then((text) => { if (!(text && found(text))) next(); })
        .catch(() => {
          // The native detector failing: carry on with jsQR instead.
          if (detector) { detector = null; next(); return; }
          scan.msg.textContent = 'Couldn’t load the code reader. Check your connection, or paste the link.';
        });
    };

    // ---- the "Sign in" sheet ------------------------------------------------
    const buildSheet = () => {
      sheet = document.createElement('div');
      sheet.id = 'hoq-signin-sheet';
      sheet.hidden = true;
      sheet.innerHTML =
        '<div class="sh" role="dialog" aria-modal="true" aria-label="Sign in">' +
          '<h3>Sign in</h3>' +
          '<p class="sh-sub">SoundCloud blocks signing in through this site, so the holdonquietly app on your PC signs you in. No PC? See the end of this sheet.</p>' +
          '<button class="sh-scan" type="button">' + CAM + 'Scan the code</button>' +
          '<ol>' +
            '<li>On your PC, open <b>holdonquietly</b> (signed in to SoundCloud).</li>' +
            '<li>Go to <b>Social/Settings</b> &rarr; <b>Settings</b> &rarr; <b>Phone</b> and tap <b>Show code</b>.</li>' +
            '<li>Tap <b>Scan the code</b> above and point your phone at it. That&rsquo;s it, right here.</li>' +
          '</ol>' +
          '<div class="sh-paste">' +
            '<p>No camera? On your PC tap <span class="sh-k">Copy link</span>, send it to yourself and paste it here. A link works once, within 10 minutes.</p>' +
            '<div class="sh-row">' +
              '<input type="url" inputmode="url" enterkeyhint="go" placeholder="Paste your sign-in link" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">' +
              '<button class="sh-go" type="button">Sign in</button>' +
            '</div>' +
            '<div class="sh-msg" aria-live="polite"></div>' +
          '</div>' +
          NOPC_HTML +
          '<button class="sh-close" type="button">Close</button>' +
        '</div>';
      document.body.appendChild(sheet);
      setupNoPc(sheet);
      const input = sheet.querySelector('input'), msg = sheet.querySelector('.sh-msg'), go = sheet.querySelector('.sh-go');
      sheet.addEventListener('click', (e) => { if (e.target === sheet || e.target.closest('.sh-close')) sheet.hidden = true; });
      sheet.querySelector('.sh-scan').addEventListener('click', openScan);
      const pasted = () => {
        msg.textContent = '';
        const p = parse(input.value);
        if (!p) { msg.textContent = 'That doesn’t look like a sign-in link. Copy it again from the app on your PC.'; return; }
        go.disabled = true; go.textContent = 'Signing in…';
        redeem(p).catch((s) => { go.disabled = false; go.textContent = 'Sign in'; msg.textContent = failText(s); });
      };
      go.addEventListener('click', pasted);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') pasted(); });
    };
    const ensureCta = () => {
      if (cta && cta.isConnected) return;
      if (!document.body) return;
      if (!cta) {
        cta = document.createElement('div');
        cta.id = 'hoq-signin-cta';
        cta.innerHTML = '<div class="cta-txt"><b>You’re not signed in</b>Scan the code from the app on your PC, or sign in on soundcloud.com.</div>' +
          '<button type="button">Sign in</button>';
        cta.querySelector('button').addEventListener('click', () => {
          if (!sheet) buildSheet();
          sheet.hidden = false;
        });
      }
      const hdr = document.querySelector('header.header, .header');
      if (hdr && hdr.parentNode) hdr.insertAdjacentElement('afterend', cta);
      else document.body.insertBefore(cta, document.body.firstChild);
    };
    ensureCta();
    setInterval(() => { if (!document.hidden) ensureCta(); }, 1200);
  })();


  // ---- community feed, straight from the page --------------------------
  (() => {
    const FB = window.__hoqProxyBuild ? '/__hoq/fb' : 'https://sc.holdonquietly.com/__hoq/fb';
    const pull = () => fetch(FB + '/feed', { credentials: 'omit', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((list) => { if (window.__hoqFeed) window.__hoqFeed(Array.isArray(list) ? list : []); })
      .catch(() => { try { if (window.__hoqFeedOffline) window.__hoqFeedOffline(); } catch (e) {} });
    window.__hoqFeedNet = {
      get: pull,
      post: (json) => fetch(FB + '/feed', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json, credentials: 'omit',
      }).catch(() => {}).then(pull),
    };
    // fresh while the tab is open, the way the app polls it
    setInterval(() => { if (!document.hidden && document.querySelector('#hoq-discord.open')) pull(); }, 30000);
  })();

  const HOQ_FRAME_CSS = "/* holdonquietly — phone rules inside SoundCloud's newer-app frames.\n   Signed in, SoundCloud shows Home's modules and the track page from its newer\n   app, in same-origin frames (/n/...). That app has its own phone layout; this\n   only fixes what the floating player and the theme get in the way of. The\n   phone UI (tools/mobile-ui.js) puts it in each frame as\n   <style id=\"hoq-mobile-frame-css\">; the frame's <html> carries our classes\n   (preload's themeFrames copies them across). */\n/* Put in only while the page around it is in its phone layout (tools/mobile-ui.js,\n   styleFrames): a media query here would measure the frame, not the screen. */\n@media all {\n  /* The track page scrolls inside this box: leave room under the last comment\n     for the floating player. */\n  html.hoq-webi #navigation-shell-right-side-container { padding-bottom: 104px !important; box-sizing: border-box !important; }\n\n  /* The title was cut to one line (\"SZA - SNOOZE (YO-ZU EDIT\"). */\n  html.hoq-webi section[aria-label=\"Track header\"] h1 {\n    display: -webkit-box !important; -webkit-box-orient: vertical !important; -webkit-line-clamp: 3 !important;\n    white-space: normal !important; overflow: hidden !important; text-overflow: clip !important;\n    overflow-wrap: anywhere !important; text-align: center !important; line-height: 1.2 !important;\n    color: #fff !important;\n  }\n  html.hoq-webi section[aria-label=\"Track header\"] h1 + * { justify-content: center !important; }\n  html.hoq-webi section[aria-label=\"Track header\"] [aria-label*=\" by \"] {\n    width: auto !important; max-width: calc(100vw - 40px) !important; align-items: center !important;\n  }\n\n  /* Like, share, copy link, repost, add to playlist, buy, more: seven buttons\n     in a row that ran off the right edge. Tighter, they all fit. */\n  html.hoq-webi section[aria-label=\"Track header\"] div:has(> button[aria-label=\"Share\"]) {\n    gap: 2px !important; justify-content: space-between !important; flex: 1 1 auto !important;\n    min-width: 0 !important; margin-left: 10px !important; padding-left: 0 !important; overflow: visible !important;\n  }\n  /* (not Like: it carries the like count and keeps its own width) */\n  html.hoq-webi section[aria-label=\"Track header\"] div:has(> button[aria-label=\"Share\"]) .MuiIconButton-root:not([aria-label=\"Like\"]) {\n    width: 37px !important; height: 37px !important; min-width: 37px !important; padding: 7px !important;\n  }\n  html.hoq-webi section[aria-label=\"Track header\"] div:has(> button[aria-label=\"Share\"]) .MuiIconButton-root:not([aria-label=\"Like\"]) svg {\n    width: 21px !important; height: 21px !important;\n  }\n  html.hoq-webi section[aria-label=\"Track header\"] button[aria-label=\"Like\"].MuiIconButton-root { height: 37px !important; }\n  /* The page starts with a 16px dark band above the cover's colour block. */\n  html.hoq-webi section[aria-label=\"Track header\"] { margin-top: -16px !important; }\n\n  /* Text you type in here would zoom the page in on iOS under 16px. */\n  html.hoq-webi input, html.hoq-webi textarea { font-size: 16px !important; }\n}\n";
  // ---- phone UI: tab bar, floating player, full-screen player, queue ----
  // tools/build-userscript.js puts this inside the mobile shim, so H
  // (document.documentElement), HOQ_FRAME_CSS and preload.js's functions are in
  // scope. Everything here is our own DOM: each button presses SoundCloud's real
  // control (kept in the page, invisible), so playback state is always
  // SoundCloud's. Styles: tools/mobile.css.
  (() => {
    const SV = (d) => '<svg viewBox="0 0 24 24" aria-hidden="true">' + d + '</svg>';
    const IC = {
      play: SV('<path class="f" d="M8 5.7v12.6c0 .8.9 1.3 1.6.9l9.9-6.3c.6-.4.6-1.4 0-1.8L9.6 4.8C8.9 4.4 8 4.9 8 5.7z"/>'),
      pause: SV('<rect class="f" x="6.5" y="5" width="4" height="14" rx="1.2"/><rect class="f" x="13.5" y="5" width="4" height="14" rx="1.2"/>'),
      prev: SV('<rect class="f" x="4.8" y="5.5" width="2.4" height="13" rx="1"/><path class="f" d="M19 6.8v10.4c0 .9-1 1.4-1.7.9l-7.4-5.2a1.1 1.1 0 0 1 0-1.8l7.4-5.2c.7-.5 1.7 0 1.7.9z"/>'),
      next: SV('<rect class="f" x="16.8" y="5.5" width="2.4" height="13" rx="1"/><path class="f" d="M5 6.8v10.4c0 .9 1 1.4 1.7.9l7.4-5.2a1.1 1.1 0 0 0 0-1.8L6.7 5.9C6 5.4 5 5.9 5 6.8z"/>'),
      heart: SV('<path d="M12 20.3s-7.3-4.4-9.2-8.9C1.4 8 3.5 4.6 7.1 4.6c2.1 0 3.6 1.1 4.9 2.8 1.3-1.7 2.8-2.8 4.9-2.8 3.6 0 5.7 3.4 4.3 6.8-1.9 4.5-9.2 8.9-9.2 8.9z"/>'),
      send: SV('<path d="M21 3 10.2 13.8"/><path d="M21 3 14.4 21l-4.2-7.2L3 9.6z"/>'),
      discord: SV('<path class="f" d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.865-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>'),   // the Discord logo
      shuffle: SV('<path d="M16 4h4v4"/><path d="M4 20 20 4"/><path d="M20 16v4h-4"/><path d="m14.5 14.5 5.5 5.5"/><path d="m4 4 5 5"/>'),
      repeat: SV('<path d="m17 2 3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="m7 22-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/>'),
      queue: SV('<path d="M4 6h12M4 11h12M4 16h7"/><path class="f" d="M15 14.2v5.6c0 .5.5.8.9.5l4.3-2.8a.6.6 0 0 0 0-1l-4.3-2.8c-.4-.3-.9 0-.9.5z"/>'),
      share: SV('<path d="M12 3.5v11"/><path d="m7.5 8 4.5-4.5L16.5 8"/><path d="M5 12.5v6A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5v-6"/>'),
      down: SV('<path d="m6 9 6 6 6-6"/>'),
      home: SV('<path d="M3.5 10.6 12 3.8l8.5 6.8"/><path d="M5.6 9.2V20h4.6v-5.6h3.6V20h4.6V9.2"/>'),
      feed: SV('<rect x="4" y="3.8" width="16" height="7" rx="2"/><rect x="4" y="13.2" width="16" height="7" rx="2"/>'),
      library: SV('<path d="M5 4v16M9.8 4v16"/><path d="m14 4.6 5.2 15"/>'),
      search: SV('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.3-4.3"/>'),
      settings: SV('<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
      social: SV('<circle cx="9" cy="8" r="3.4"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M15.6 4.9a3.3 3.3 0 0 1 0 6.2"/><path d="M18.2 14.3A6 6 0 0 1 21 20"/>'),
    };

    const q = (s, r) => (r || document).querySelector(s);
    const press = (sel) => { const b = q(sel); if (b) b.click(); return !!b; };
    const now = () => { try { return (typeof currentNowPlaying === 'function' && currentNowPlaying()) || {}; } catch (e) { return {}; } };
    const prog = () => { try { return playerProgress(); } catch (e) { return { pos: 0, dur: 0, paused: true }; } };
    const isLiked = () => { const b = q('.playbackSoundBadge__like'); return !!(b && b.classList.contains('sc-button-selected')); };
    const fmt = (s) => {
      s = Math.max(0, Math.floor(s || 0));
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, '0');
      return h ? h + ':' + String(m).padStart(2, '0') + ':' + x : m + ':' + x;
    };
    // The song's public soundcloud.com link (never this site's address).
    const songUrl = () => {
      let h = '';
      try { h = typeof hoqNowHref === 'function' ? hoqNowHref() : ''; } catch (e) {}
      if (!h) return '';
      if (/^https?:/i.test(h) && !/^https?:\/\/([^/]*\.)?(soundcloud|holdonquietly)\.com\//i.test(h)) return h;
      return 'https://soundcloud.com' + h.replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0];
    };
    const big = (u) => (u || '').replace(/-t\d+x\d+\./, '-t500x500.').replace(/-(large|crop)\./, '-t500x500.');
    const safeImg = (u) => (typeof hoqSafeUrl === 'function' ? hoqSafeUrl(u) : '');   // preload's https-only guard

    // ---- toast + action sheet ----------------------------------------------
    let toastEl = null, toastT = 0;
    const toast = (msg) => {
      if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.id = 'hoq-mtoast';
        toastEl.setAttribute('role', 'status');
        document.body.appendChild(toastEl);
      }
      toastEl.textContent = msg;
      toastEl.classList.add('on');
      clearTimeout(toastT);
      toastT = setTimeout(() => toastEl.classList.remove('on'), 1900);
    };
    let acts = null;
    const actionSheet = (title, items) => {
      if (!acts) {
        acts = document.createElement('div');
        acts.id = 'hoq-acts';
        acts.addEventListener('click', (e) => { if (e.target === acts) acts.hidden = true; });
        document.body.appendChild(acts);
      }
      acts.innerHTML = '<div class="ac-box" role="menu"><div class="ac-title"></div><div class="ac-list"></div>' +
        '<button class="ac-cancel" type="button">Cancel</button></div>';
      q('.ac-title', acts).textContent = title || '';
      const list = q('.ac-list', acts);
      items.forEach((it) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        b.textContent = it.label;
        if (it.sub) {   // a line under it saying what it does
          const sm = document.createElement('small');
          sm.className = 'ac-sub';
          sm.textContent = it.sub;
          b.appendChild(sm);
        }
        b.addEventListener('click', () => { acts.hidden = true; try { it.run(); } catch (e) {} });
        list.appendChild(b);
      });
      q('.ac-cancel', acts).addEventListener('click', () => { acts.hidden = true; });
      acts.hidden = false;
    };
    const songLine = () => { const n = now(); return n.title ? n.title + (n.artist ? ' · ' + n.artist : '') : ''; };
    const discordMenu = () => {
      const items = [];
      if (document.getElementById('hoq-playbtn')) items.push({ label: 'Play in Discord', sub: 'The bot plays it in your voice channel, and it’s posted in the text channel too.', run: () => press('#hoq-playbtn') });
      if (document.getElementById('hoq-share')) items.push({ label: 'Share to Discord', sub: 'Posts it in the text channel, without playing it.', run: () => press('#hoq-share') });
      if (!items.length) { toast('Discord isn’t ready yet'); return; }
      actionSheet(songLine(), items);
    };
    const shareSong = () => {
      const url = songUrl(), n = now();
      if (!url) { toast('Nothing playing'); return; }
      if (navigator.share) {
        navigator.share({ title: n.title || 'SoundCloud', text: songLine(), url: url }).catch(() => {});
        return;
      }
      try { hoqCopy(url); toast('Link copied'); } catch (e) { toast(url); }
    };
    let likeHold = 0;   // SoundCloud takes a moment to flip its button; don't flip ours back meanwhile
    const like = (btn) => {
      if (!press('.playbackSoundBadge__like')) return;
      likeHold = performance.now() + 1500;
      const on = !btn.classList.contains('on');
      [likeBtn, mLike].forEach((b) => { b.classList.toggle('on', on); b.setAttribute('aria-label', on ? 'Unlike' : 'Like'); });
      btn.classList.remove('pop'); void btn.offsetWidth; btn.classList.add('pop');
    };
    // The queue is SoundCloud's own "Next up" panel, styled as a sheet.
    const queueOpen = () => !!q('.playControls .queue.m-visible');
    const toggleQueue = () => {
      if (!press('.playbackSoundBadge__showQueue')) return;
      // SoundCloud draws only the rows that fit the panel's old (desktop) size;
      // a resize, and a real scroll of its list, make it draw the rest of the
      // taller sheet. (.queue__scrollableInner is the element that scrolls.)
      [80, 400].forEach((ms) => setTimeout(() => {
        if (!queueOpen()) return;
        try {
          window.dispatchEvent(new Event('resize'));
          const sc = q('.playControls .queue__scrollableInner');
          if (sc) { const t = sc.scrollTop; sc.scrollTop = t + 1; sc.scrollTop = t; sc.dispatchEvent(new Event('scroll')); }
        } catch (e) {}
      }, ms));
    };

    // ---- bottom tab bar ------------------------------------------------------
    const TABS = [
      { k: 'home', label: 'Home', icon: IC.home },
      { k: 'feed', label: 'Feed', icon: IC.feed, auth: 1 },
      { k: 'library', label: 'Library', icon: IC.library, auth: 1 },
      { k: 'search', label: 'Search', icon: IC.search, anon: 1 },
      { k: 'social', label: 'Social', icon: IC.social },
      { k: 'settings', label: 'Settings', icon: IC.settings },
    ];
    const tabs = document.createElement('nav');
    tabs.id = 'hoq-tabs';
    tabs.setAttribute('aria-label', 'Main');
    tabs.innerHTML = TABS.map((t) => '<button type="button" data-k="' + t.k + '"' + (t.auth ? ' data-auth' : '') +
      (t.anon ? ' data-anon hidden' : '') + '>' + t.icon + '<span>' + t.label + '</span></button>').join('');
    const HREF = { home: '/discover', feed: '/feed', library: '/you/library' };
    // SoundCloud's own nav links (hidden on the phone): pressing them keeps its
    // router doing the navigating.
    const realLink = (k) => {
      const nav = '.header__navMenu a.header__navMenuItem';
      if (k === 'home') return q(nav + '[href="/discover"]') || q(nav + '[href="/"]') || q('.header__logoLink');
      if (k === 'feed') return q(nav + '[href="/feed"]') || q(nav + '[data-menu-name="stream"]');
      if (k === 'library') return q(nav + '[href="/you/library"]') || q(nav + '[data-menu-name="library"]');
      return null;
    };
    const curTab = () => {
      if (H.classList.contains('hoq-tab')) { const dp = document.getElementById('hoq-discord'); return dp && dp.dataset.pane === 'settings' ? 'settings' : 'social'; }
      const p = location.pathname;
      if (/^\/(discover|home)?\/?$/.test(p)) return 'home';
      if (/^\/(feed|stream)(\/|$)/.test(p)) return 'feed';
      if (/^\/you(\/|$)/.test(p)) return 'library';
      if (/^\/search(\/|$)/.test(p)) return 'search';
      return '';
    };
    let tabKey = '';
    const syncTabs = () => {
      // Account-only tabs wait for the header to show you're signed in (the
      // shim's hoq-anon only appears once it has rendered), and signed-out ones
      // for hoq-anon, so a signed-out phone never flashes Feed and Library.
      const anon = H.classList.contains('hoq-anon');
      const signed = !anon && !!q(".header__userNavUsernameButton, .header__userNav a[href^='/you']");
      const c = curTab(), key = c + '|' + anon + '|' + signed;
      if (key === tabKey) return;
      tabKey = key;
      tabs.querySelectorAll('button').forEach((b) => {
        b.hidden = (b.hasAttribute('data-auth') && !signed) || (b.hasAttribute('data-anon') && !anon);
        const on = b.dataset.k === c;
        b.classList.toggle('on', on);
        if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
      });
    };
    tabs.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-k]');
      if (!b) return;
      const k = b.dataset.k, was = curTab();
      if (k === 'social' || k === 'settings') {
        // Social/Settings is one page with sub-tabs: Settings opens it on its
        // Settings tab, Social on the rest. The tab you're on again closes it.
        if (was === k) { if (typeof toggleDiscord === 'function') toggleDiscord(); }
        else {
          if (!H.classList.contains('hoq-tab') && typeof toggleDiscord === 'function') toggleDiscord();
          const p = document.getElementById('hoq-discord');
          if (p) {
            const want = k === 'settings' ? 'settings' : 'social';
            if (k === 'settings' || p.dataset.pane === 'settings') {
              const st = p.querySelector('.hoq-subtab[data-pane="' + want + '"]');
              if (st) st.click();
            }
            p.scrollTop = 0;
          }
        }
      } else {
        if (H.classList.contains('hoq-tab') && typeof closeDiscord === 'function') closeDiscord();
        if (k === 'search') {
          const i = q('.headerSearch__input');
          if (i) { i.focus(); try { i.select(); } catch (er) {} }
        } else if (was === k) {
          window.scrollTo({ top: 0, behavior: 'smooth' });   // tapping the tab you're on: back to the top
        } else {
          const a = realLink(k);
          if (a) a.click(); else location.assign(HREF[k]);
        }
      }
      tabKey = '';
      syncTabs();
    });

    // ---- floating player -----------------------------------------------------
    // Ring-progress play button with the cover in it, title and artist (tap: the
    // full player), previous / next, like, Discord. Swipe it to skip.
    const RING = 144.51;   // circumference, r = 23
    const pill = document.createElement('div');
    pill.id = 'hoq-pill';
    pill.innerHTML =
      '<button class="pl-play" type="button" aria-label="Play">' +
        '<svg class="pl-ring" viewBox="0 0 52 52" aria-hidden="true"><circle class="pl-track" cx="26" cy="26" r="23"/><circle class="pl-prog" cx="26" cy="26" r="23"/></svg>' +
        '<span class="pl-disc">' + IC.play + '</span>' +
      '</button>' +
      '<div class="pl-meta" role="button" tabindex="0" aria-label="Open the player"><b class="pl-title"></b><span class="pl-artist"></span></div>' +
      '<div class="pl-btns">' +
        '<button class="pl-prev" type="button" aria-label="Previous">' + IC.prev + '</button>' +
        '<button class="pl-next" type="button" aria-label="Next">' + IC.next + '</button>' +
        '<button class="pl-like" type="button" aria-label="Like">' + IC.heart + '</button>' +
        '<button class="pl-dc" type="button" aria-label="Discord" aria-haspopup="menu">' + IC.discord + '</button>' +
      '</div>';
    const P = (s) => q(s, pill);
    const playBtn = P('.pl-play'), disc = P('.pl-disc'), ring = P('.pl-prog'), meta = P('.pl-meta'),
      titleEl = P('.pl-title'), artistEl = P('.pl-artist'), likeBtn = P('.pl-like'), dcBtn = P('.pl-dc');

    // ---- full-screen player --------------------------------------------------
    const mnp = document.createElement('div');
    mnp.id = 'hoq-mnp';
    mnp.setAttribute('role', 'dialog');
    mnp.setAttribute('aria-modal', 'true');
    mnp.setAttribute('aria-label', 'Now playing');
    mnp.setAttribute('aria-hidden', 'true');
    mnp.innerHTML =
      '<div class="mnp-bg"></div><div class="mnp-shade"></div>' +
      '<div class="mnp-in">' +
        '<div class="mnp-top">' +
          '<button class="mnp-x" type="button" aria-label="Close the player">' + IC.down + '</button>' +
          '<div class="mnp-ctx">Now playing</div>' +
          '<button class="mnp-sp" type="button" tabindex="-1" aria-hidden="true">' + IC.down + '</button>' +
        '</div>' +
        '<div class="mnp-art" role="img" aria-label="Cover"></div>' +
        '<div class="mnp-info">' +
          '<div class="mnp-meta">' +
            '<button class="mnp-title" type="button" aria-label="Go to the song"></button>' +
            '<button class="mnp-artist" type="button" aria-label="Go to the artist"></button>' +
          '</div>' +
          '<button class="mnp-like" type="button" aria-label="Like">' + IC.heart + '</button>' +
        '</div>' +
        '<div class="mnp-seek" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0">' +
          '<div class="mnp-rail"><i class="mnp-fill"></i><b class="mnp-knob"></b></div>' +
        '</div>' +
        '<div class="mnp-times"><span class="mnp-cur">0:00</span><span class="mnp-dur">0:00</span></div>' +
        '<div class="mnp-ctrls">' +
          '<button class="mnp-shuf" type="button" aria-label="Shuffle" aria-pressed="false">' + IC.shuffle + '</button>' +
          '<button class="mnp-prev" type="button" aria-label="Previous">' + IC.prev + '</button>' +
          '<button class="mnp-play" type="button" aria-label="Play">' + IC.play + '</button>' +
          '<button class="mnp-next" type="button" aria-label="Next">' + IC.next + '</button>' +
          '<button class="mnp-rep" type="button" aria-label="Repeat: off">' + IC.repeat + '<i>1</i></button>' +
        '</div>' +
        '<div class="mnp-foot">' +
          '<button class="mnp-dc" type="button">' + IC.discord + '<span>Discord</span></button>' +
          '<button class="mnp-share" type="button">' + IC.share + '<span>Share</span></button>' +
          '<button class="mnp-q" type="button">' + IC.queue + '<span>Queue</span></button>' +
        '</div>' +
      '</div>';
    const M = (s) => q(s, mnp);
    const mIn = M('.mnp-in'), mArt = M('.mnp-art'), mBg = M('.mnp-bg'), mTitle = M('.mnp-title'), mArtist = M('.mnp-artist'),
      mLike = M('.mnp-like'), mSeek = M('.mnp-seek'), mFill = M('.mnp-fill'), mKnob = M('.mnp-knob'),
      mCur = M('.mnp-cur'), mDur = M('.mnp-dur'), mPlay = M('.mnp-play'), mShuf = M('.mnp-shuf'), mRep = M('.mnp-rep'),
      mDc = M('.mnp-dc');
    const qdim = document.createElement('div');
    qdim.id = 'hoq-qdim';
    qdim.addEventListener('click', () => { if (queueOpen()) toggleQueue(); });

    const isOpen = () => mnp.classList.contains('on');
    const openSheet = () => {
      if (!H.classList.contains('hoq-pill-on')) return;
      mnp.classList.add('on');
      mnp.setAttribute('aria-hidden', 'false');
      H.classList.add('hoq-mnp-open');
      mIn.scrollTop = 0;
      lastSheetKey = '';
      sync();
    };
    const closeSheet = () => {
      mnp.classList.remove('on');
      mnp.setAttribute('aria-hidden', 'true');
      H.classList.remove('hoq-mnp-open');
    };

    // ---- shared state, painted on a short timer ------------------------------
    let shownPaused = null, baseP = -1, baseT = 0, lastKey = '', lastCover = null, lastSheetKey = '';
    // One play/pause state, painted on both players (each used to keep its own,
    // so pressing play in one left the other showing the wrong icon).
    const paintPlay = (paused) => {
      shownPaused = paused;
      const ic = paused ? IC.play : IC.pause, label = paused ? 'Play' : 'Pause';
      disc.innerHTML = ic;
      playBtn.setAttribute('aria-label', label);
      mPlay.innerHTML = ic;
      mPlay.setAttribute('aria-label', label);
      mnp.classList.toggle('paused', paused);
    };
    const togglePlay = () => {
      if (!press('.playControls__play')) return;
      if (shownPaused !== null) paintPlay(!shownPaused);   // flip at once; the next sync confirms it
    };
    let drag = null, hold = null;   // seek: fraction while dragging; target until the clock catches up
    const glidePos = (pr) => {
      // SoundCloud's clock only reads whole seconds; glide between them.
      if (pr.pos !== baseP) { baseP = pr.pos; baseT = performance.now(); }
      return baseP + (pr.paused ? 0 : Math.min(1, (performance.now() - baseT) / 1000));
    };
    const paintSeek = (frac, pos, dur) => {
      const pc = (Math.max(0, Math.min(1, frac)) * 100).toFixed(2) + '%';
      mFill.style.width = pc;
      mKnob.style.left = pc;
      mCur.textContent = fmt(pos);
      mDur.textContent = fmt(dur);
      mSeek.setAttribute('aria-valuemax', String(Math.round(dur)));
      mSeek.setAttribute('aria-valuenow', String(Math.round(pos)));
      mSeek.setAttribute('aria-valuetext', fmt(pos) + ' of ' + fmt(dur));
    };
    let deadSince = 0;
    const sync = () => {
      try {
        const n = now();
        let live = !!n.title && typeof playerProgress === 'function';
        // Between songs (Next, or one ending) SoundCloud's bar is blank for a
        // moment: that blink closed the full player. Only a bar that stays empty
        // for 3 s counts as nothing playing.
        if (live) deadSince = 0;
        else if (H.classList.contains('hoq-pill-on')) {
          if (!deadSince) deadSince = Date.now();
          if (Date.now() - deadSince < 3000) return;
        }
        H.classList.toggle('hoq-pill-on', live);
        H.classList.toggle('hoq-q-open', live && queueOpen());
        // SoundCloud's own bar on screen instead (the floating player isn't up):
        // the page keeps room for it (mobile.css: hoq-bar-on).
        H.classList.toggle('hoq-bar-on', !live && !!q('.playControls.m-visible'));
        syncTabs();
        if (!live) { if (isOpen()) closeSheet(); return; }
        const pr = prog();
        const key = n.title + '|' + n.artist;
        const cover = safeImg(n.cover);
        if (key !== lastKey) {
          lastKey = key;
          titleEl.textContent = n.title;
          artistEl.textContent = n.artist || '';
          baseP = -1; hold = null;
        }
        if (cover !== lastCover) {   // apart from the title: the cover often loads a moment later
          lastCover = cover;
          disc.style.backgroundImage = cover ? 'url("' + cover + '")' : '';
          disc.classList.toggle('has-art', !!cover);
        }
        if (pr.paused !== shownPaused) paintPlay(pr.paused);
        if (performance.now() > likeHold) {
          const liked = isLiked();
          [likeBtn, mLike].forEach((b) => {
            if (b.classList.contains('on') === liked) return;
            b.classList.toggle('on', liked);
            b.setAttribute('aria-label', liked ? 'Unlike' : 'Like');
          });
        }
        const canDc = !!(document.getElementById('hoq-playbtn') || document.getElementById('hoq-share'));
        dcBtn.hidden = !canDc;
        mDc.hidden = !canDc;
        let pos = glidePos(pr);
        if (hold) {
          if (Math.abs(pr.pos - hold.pos) <= 2 || performance.now() > hold.until) hold = null;
          else pos = hold.pos;
        }
        const frac = pr.dur > 0 ? Math.max(0, Math.min(1, pos / pr.dur)) : 0;
        ring.style.strokeDashoffset = (RING * (1 - frac)).toFixed(2);
        if (!isOpen()) return;
        // ---- the full player ----
        if (key + cover !== lastSheetKey) {
          lastSheetKey = key + cover;
          mTitle.textContent = n.title;
          mArtist.textContent = n.artist || '';
          const art = big(cover);
          mArt.style.backgroundImage = art ? 'url("' + art + '")' : '';
          mBg.style.backgroundImage = art ? 'url("' + art + '")' : '';
        }
        if (drag === null) paintSeek(frac, pos, pr.dur);
        const sh = !!q('.shuffleControl.m-shuffling');
        mShuf.classList.toggle('on', sh);
        mShuf.setAttribute('aria-pressed', String(sh));
        const rc = q('.repeatControl');
        const rep = rc ? (rc.classList.contains('m-one') ? 'one' : rc.classList.contains('m-all') ? 'all' : 'off') : 'off';
        mRep.classList.toggle('on', rep !== 'off');
        mRep.classList.toggle('one', rep === 'one');
        mRep.setAttribute('aria-label', 'Repeat: ' + (rep === 'one' ? 'this song' : rep === 'all' ? 'all' : 'off'));
      } catch (e) {}
    };

    // ---- floating player: wiring ---------------------------------------------
    playBtn.addEventListener('click', togglePlay);
    meta.addEventListener('click', openSheet);
    meta.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSheet(); } });
    P('.pl-prev').addEventListener('click', () => press('.skipControl__previous'));
    P('.pl-next').addEventListener('click', () => press('.skipControl__next'));
    likeBtn.addEventListener('click', () => like(likeBtn));
    dcBtn.addEventListener('click', discordMenu);
    // Swipe the pill: left = next track, right = previous.
    let sx = 0, sy = 0, st = 0;
    pill.addEventListener('touchstart', (e) => { const t = e.touches[0]; sx = t.clientX; sy = t.clientY; st = Date.now(); }, { passive: true });
    pill.addEventListener('touchend', (e) => {
      const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) < 50 || Math.abs(dy) > 40 || Date.now() - st > 700) return;
      const next = dx < 0;
      if (!press(next ? '.skipControl__next' : '.skipControl__previous')) return;
      meta.classList.remove('sw-l', 'sw-r'); void meta.offsetWidth; meta.classList.add(next ? 'sw-l' : 'sw-r');
    }, { passive: true });

    // ---- full player: wiring -------------------------------------------------
    M('.mnp-x').addEventListener('click', closeSheet);
    mPlay.addEventListener('click', togglePlay);
    M('.mnp-prev').addEventListener('click', () => { press('.skipControl__previous'); hold = null; });
    M('.mnp-next').addEventListener('click', () => { press('.skipControl__next'); hold = null; });
    mShuf.addEventListener('click', () => { press('.shuffleControl'); setTimeout(sync, 60); });
    mRep.addEventListener('click', () => { press('.repeatControl'); setTimeout(sync, 60); });
    mLike.addEventListener('click', () => like(mLike));
    mDc.addEventListener('click', discordMenu);
    M('.mnp-share').addEventListener('click', shareSong);
    M('.mnp-q').addEventListener('click', toggleQueue);
    // Title and artist go to their pages, through SoundCloud's own links.
    mTitle.addEventListener('click', () => { closeSheet(); press('.playbackSoundBadge__titleLink'); });
    mArtist.addEventListener('click', () => { closeSheet(); press('.playbackSoundBadge__lightLink') || press('.playbackSoundBadge__usernameLink'); });

    // Seek: drag along the bar; the jump happens when you let go.
    const fracAt = (x) => { const r = mSeek.getBoundingClientRect(); return r.width ? Math.max(0, Math.min(1, (x - r.left) / r.width)) : 0; };
    const showDrag = () => { const d = prog().dur; paintSeek(drag, drag * d, d); };
    const seekTo = (sec) => {
      const d = prog().dur;
      if (!(d > 0) || typeof hoqSeek !== 'function') return;
      sec = Math.max(0, Math.min(d - 1, sec));
      if (hoqSeek(sec)) { hold = { pos: sec, until: performance.now() + 2500 }; baseP = -1; }
    };
    mSeek.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      drag = fracAt(e.clientX);
      mSeek.classList.add('drag');
      try { mSeek.setPointerCapture(e.pointerId); } catch (er) {}
      showDrag();
      e.preventDefault();
    });
    mSeek.addEventListener('pointermove', (e) => { if (drag === null) return; drag = fracAt(e.clientX); showDrag(); });
    const endDrag = (commit) => {
      if (drag === null) return;
      const f = drag;
      drag = null;
      mSeek.classList.remove('drag');
      if (commit) seekTo(f * prog().dur);
      sync();
    };
    mSeek.addEventListener('pointerup', () => endDrag(true));
    mSeek.addEventListener('pointercancel', () => endDrag(false));
    mSeek.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowRight' ? 5 : e.key === 'ArrowLeft' ? -5 : 0;
      if (!step) return;
      e.preventDefault();
      seekTo((hold ? hold.pos : prog().pos) + step);
    });

    // Swipe the full player down to close it.
    let ty0 = 0, tx0 = 0, tdy = 0, tdrag = false;
    mnp.addEventListener('touchstart', (e) => {
      if (e.target.closest('.mnp-seek') || mIn.scrollTop > 0) { tdrag = false; return; }
      const t = e.touches[0];
      ty0 = t.clientY; tx0 = t.clientX; tdy = 0; tdrag = true;
    }, { passive: true });
    mnp.addEventListener('touchmove', (e) => {
      if (!tdrag) return;
      const t = e.touches[0];
      tdy = Math.max(0, t.clientY - ty0);
      if (Math.abs(t.clientX - tx0) > 40 && tdy < 24) { tdrag = false; mnp.style.transition = ''; mnp.style.transform = ''; return; }
      if (tdy > 4) { mnp.style.transition = 'none'; mnp.style.transform = 'translateY(' + tdy + 'px)'; }
    }, { passive: true });
    const endSwipe = () => {
      if (!tdrag) return;
      tdrag = false;
      mnp.style.transition = '';
      if (tdy > 110) {
        // slide on down from where the finger let go, not back up first
        mnp.style.transform = 'translateY(100%)';
        closeSheet();
        setTimeout(() => { if (!isOpen()) mnp.style.transform = ''; }, 380);
      } else {
        mnp.style.transform = '';
      }
    };
    mnp.addEventListener('touchend', endSwipe, { passive: true });
    mnp.addEventListener('touchcancel', endSwipe, { passive: true });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen() && !queueOpen()) closeSheet(); });
    // SoundCloud navigating (a link in the queue, say) closes the full player
    // and the queue sheet, so you land on the page you picked.
    let lastPath = location.pathname;
    const routeCheck = () => {
      if (location.pathname === lastPath) return;
      lastPath = location.pathname;
      if (queueOpen()) toggleQueue();
      if (isOpen()) closeSheet();
      tabKey = '';
      syncTabs();
    };
    window.addEventListener('popstate', () => setTimeout(routeCheck, 0));

    // ---- phone CSS inside SoundCloud's newer-app frames ----------------------
    // Signed in, Home's modules and the track page are SoundCloud's new app in
    // same-origin frames; the theme already styles them (themeFrames), this adds
    // the phone layout (tools/mobile-frame.css).
    // Only while this page is in its phone layout: a media query inside a frame
    // measures the frame, and Home's section frames are under 820px wide on any
    // screen, so the frame rules would land in the desktop layout too. Same
    // query as tools/mobile.css (a phone turned sideways keeps the phone layout).
    const PHONE_MQ = window.matchMedia ? matchMedia('(max-width: 820px), (pointer: coarse) and (max-height: 500px)') : null;
    const styleFrames = () => {
      const phone = !PHONE_MQ || PHONE_MQ.matches;
      document.querySelectorAll('iframe').forEach((f) => {
        let d = null;
        try { d = f.contentDocument; } catch (e) { return; }   // cross-origin: not ours
        if (!d || !d.documentElement) return;
        const had = d.getElementById('hoq-mobile-frame-css');
        if (!phone) { if (had) had.remove(); return; }
        if (had) return;
        try {
          const st = d.createElement('style');
          st.id = 'hoq-mobile-frame-css';
          st.textContent = HOQ_FRAME_CSS;
          (d.head || d.documentElement).appendChild(st);
        } catch (e) {}
      });
    };
    if (PHONE_MQ) try { PHONE_MQ.addEventListener('change', styleFrames); } catch (e) {}

    // ---- <head>: what Safari and a Home Screen web app read ----------------
    // SoundCloud's own say #333 for the browser bars (grey over our near-black),
    // "SoundCloud" for the app's name and an orange splash. Kept asserted: its
    // React rewrites head tags as you move around.
    const HEAD = [
      ['theme-color', '#0d0d10'],                        // Safari's bars match the top bar
      ['color-scheme', 'dark'],
      ['format-detection', 'telephone=no'],              // a long play count isn't a phone number
      ['apple-mobile-web-app-title', 'holdonquietly'],
      ['apple-mobile-web-app-capable', 'yes'],           // older iOS: open from the Home Screen as an app
      ['mobile-web-app-capable', 'yes'],
      ['apple-mobile-web-app-status-bar-style', 'black-translucent'],   // the top bar runs under the clock
    ];
    // The proxy serves the web app's own manifest and icons (proxy/app/).
    const APP = window.__hoqProxyBuild ? '/__hoq/app/' : '';
    const headTags = () => {
      const head = document.head;
      if (!head) return;
      HEAD.forEach(([name, content]) => {
        let m = head.querySelector('meta[name="' + name + '"]');
        if (!m) { m = document.createElement('meta'); m.name = name; head.appendChild(m); }
        if (m.content !== content) m.content = content;
      });
      if (!APP) return;
      const link = (rel, href) => {
        let l = head.querySelector('link[rel="' + rel + '"]');
        if (!l) { l = document.createElement('link'); l.rel = rel; head.appendChild(l); }
        if (l.getAttribute('href') !== href) l.setAttribute('href', href);
        return l;
      };
      const man = link('manifest', APP + 'manifest.webmanifest');
      if (man.hasAttribute('crossorigin')) man.removeAttribute('crossorigin');
      link('apple-touch-icon', APP + 'apple-touch-icon.png');
    };

    // ---- the on-screen keyboard -------------------------------------------
    // iOS keeps the page's size and slides the keyboard over it: --hoq-kb is
    // how much of the bottom it covers, so a sheet with a field can lift.
    const vv = window.visualViewport;
    if (vv) {
      const kb = () => {
        const h = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
        H.style.setProperty('--hoq-kb', (h > 80 ? h : 0) + 'px');   // ignore the toolbar sliding
      };
      vv.addEventListener('resize', kb);
      vv.addEventListener('scroll', kb);
    }

    const mount = () => {
      if (!document.body) { setTimeout(mount, 150); return; }
      headTags();
      document.body.appendChild(tabs);
      document.body.appendChild(pill);
      document.body.appendChild(qdim);
      document.body.appendChild(mnp);
      sync();
      styleFrames();
      let tick = 0;
      setInterval(() => {   // idle while the page is hidden (battery)
        if (document.hidden) return;
        sync();
        routeCheck();
        if (++tick % 4 === 0) { styleFrames(); headTags(); }
      }, 250);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
    };
    mount();
  })();


  // ---- session transplant (receiving end) -----------------------------
  // SoundCloud will not let a sign-in complete through this proxy: its bot
  // protection challenges the request. But a session created normally on the
  // desktop app can be carried over -- same person, same real session, just
  // used from another device.
  //
  // The token arrives in the URL FRAGMENT, which browsers never send to the
  // server. It therefore never appears in nginx logs or any upstream request
  // that did not already need it.
  try {
    const HASH = "#hoqs=";
    if (location.hash.indexOf(HASH) === 0) {
      const raw = decodeURIComponent(location.hash.slice(HASH.length));
      const jar = JSON.parse(atob(raw));
      const host = location.hostname.replace(/^[^.]+./, "");
      Object.keys(jar).forEach(function (k) {
        document.cookie = k + "=" + jar[k] + "; path=/; domain=." + host +
          "; max-age=31536000; secure; samesite=lax";
      });
      // Drop the token out of the address bar before anything can screenshot
      // or share it, then reload so the app boots authenticated.
      history.replaceState(null, "", location.pathname + location.search);
      location.reload();
    }
  } catch (e) {}

  // Signed out, /signin and /feed are walls with nothing on them. Bounce back
  // to Discover rather than stranding the user on an empty page they cannot
  // get past. replace() so Back does not land on the wall again.
  const WALLS = new RegExp("^/(signin|feed|you|upload|notifications|messages)(/|$)");
  const bounce = () => {
    if (!H.classList.contains("hoq-anon")) return;
    if (WALLS.test(location.pathname)) location.replace("/discover");
  };
  setTimeout(bounce, 1500);
  setInterval(bounce, 1500);

  // Replies from the sandbox.
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.__hoqReply !== 1) return;
    if (d.kind === 'cover' && d.dataUrl) {
      // A data: URL is same-origin, so the canvas is untainted and preload's
      // own extractor can run — this replaces the desktop C# sampler.
      try {
        coverColors(d.dataUrl, (c) => {
          if (c && window.__scCoverColors) window.__scCoverColors(c.c1, c.c2);
        });
      } catch (err) {}
    } else if (d.kind === 'friends' && d.list) {
      try { window.__hoqFriends && window.__hoqFriends(d.list); } catch (err) {}
    } else if (d.kind === 'dcwidget') {
      try { window.__hoqDcWidget && window.__hoqDcWidget(d.data); } catch (err) {}
    } else if (d.kind === 'toast') {
      try { console.log('[hoq]', d.text); } catch (err) {}
    }
  });
})();

  }

  const el = document.createElement('script');
  el.textContent = '(' + __hoqPayload.toString() + ')();';
  (document.head || document.documentElement).appendChild(el);
  el.remove();
})();
