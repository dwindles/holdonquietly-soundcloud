/* Build a mobile userscript from preload.js.
 *
 * WHY A BUILD STEP: preload.js is ~5,000 lines and still moving. Forking it for
 * mobile would rot within a week, so the userscript is GENERATED — every desktop
 * change flows here for free. Only the host bridge and a small shim differ.
 *
 * WHY TWO WORLDS: GM_xmlhttpRequest is the only reason we can reach the Discord
 * webhook and the artwork CDN at all (SoundCloud's CSP blocks both from the
 * page). But asking for a GM_* grant puts the script in the manager's sandbox,
 * and the ad-killer needs the page's real media engine. So the GM calls stay in
 * the sandbox, the payload is injected into the page, and window.postMessage
 * bridges them.
 *
 * usage: node tools/build-userscript.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// preload.js is CRLF (and mixed in places). Normalise so the transforms below
// are line-ending agnostic; the userscript itself is written LF.
const CRLF = String.fromCharCode(13, 10);
const LF = String.fromCharCode(10);
const src = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8').split(CRLF).join(LF);

/* ---- 1. Re-point the host bridge at the sandbox ------------------------- */
const OLD_POST = [
  'function scPost(cmd) {',
  '  try { window.chrome.webview.postMessage(cmd); } catch (e) {}',
  '}',
].join('\n');

if (!src.includes(OLD_POST)) {
  console.error('FAIL: scPost() no longer matches preload.js.');
  console.error('The host bridge moved — update OLD_POST here rather than shipping a stale build.');
  process.exit(1);
}

const NEW_POST = [
  'function scPost(cmd) {',
  '  // No C# host on mobile. Window/native commands are dropped by the sandbox;',
  '  // the rest are relayed to it, since it owns the GM_* APIs. The community feed',
  '  // goes from the page itself (the shim\'s __hoqFeedNet).',
  '  try {',
  '    cmd = String(cmd);',
  "    if (cmd === 'feed:get' && window.__hoqFeedNet) { window.__hoqFeedNet.get(); return; }",
  "    if (cmd.indexOf('feed:post:') === 0 && window.__hoqFeedNet) { window.__hoqFeedNet.post(cmd.slice(10)); return; }",
  '    window.postMessage({ __hoq: 1, cmd: cmd }, location.origin);',
  '  } catch (e) {}',
  '}',
].join('\n');

let payload = src.replace(OLD_POST, NEW_POST);

/* ---- Mobile stylesheet (injected by the shim) --------------------------- */
// The phone layout lives in its own files (plain CSS / JS, so they can be read
// and diffed). Normalised to LF like preload.js above.
const readTool = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8').split(CRLF).join(LF);
const MOBILE_CSS = readTool('mobile.css');
// Inside SoundCloud's newer-app frames (signed-in Home modules, track pages).
const MOBILE_FRAME_CSS = readTool('mobile-frame.css');
// Tab bar, floating player, full-screen player, queue (styles: mobile.css).
const MOBILE_UI = readTool('mobile-ui.js');
// Signed out on the proxy: the Sign in sheet and its QR scanner.
const MOBILE_SIGNIN = readTool('mobile-signin.js');

/* Route tag and the Library pill row. Raw template: it's plain page JS, kept
   free of backticks and ${. (The sign-in sheet is tools/mobile-signin.js.) */
const ROUTE_SIGNIN = String.raw`
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
`;

/* The community feed (Social -> Feed). On the desktop the C# host fetches and
   posts it for the page (feed:get / feed:post:); a phone build has no host, and
   the tab sat on "Loading the feed..." for good. The page talks to the friends
   server itself, over the proxy's https route: same origin on the proxy, CORS *
   from soundcloud.com (userscript, bookmarklet). Each build's scPost routes the
   two commands here. Raw template: plain page JS. */
const FEED_NET = String.raw`
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
`;

/* ---- 2. Page-side shim, appended after preload ------------------------- */
const SHIM = [
  '',
  '/* =========================== mobile shim ============================ */',
  '(() => {',
  '  const H = document.documentElement;',
  "  H.classList.add('hoq-mobile');",
  '',
  '  // The titlebar only exists because the desktop window is frameless. On a',
  '  // phone it is a dead 34px strip with non-functional window buttons.',
  "  const css = document.createElement('style');",
  '  css.textContent =',
  "    '#sc-titlebar{display:none!important}' +",
  "    'html.hoq-mobile .header{top:0!important}' +",
  "    'html.hoq-mobile .header .header__inner{padding-right:12px!important}' +",
  "    'html.hoq-mobile .sc-tb-btn{display:none!important}';",
  '  (document.head || H).appendChild(css);',
  '',
  '  // Mobile layout, against the containers SoundCloud actually uses:',
  '  //   .l-container / .header__inner   fixed 1240px',
  '  //   .l-fluid-fixed                  .l-main 880 + .l-sidebar-right 360',
  '  //   .tileGallery                    horizontal carousels of 159px tiles',
  "  const mob = document.createElement('style');",
  "  mob.id = 'hoq-mobile-css';",
  '  mob.textContent = ' + JSON.stringify(MOBILE_CSS) + ';',
  '  (document.head || H).appendChild(mob);',
  '',
  '  // Keep the desktop layout legible instead of letting the browser scale it',
  '  // down. You still need the browser\'s "Request Desktop Website" — a',
  '  // userscript cannot change the UA of a request that already happened.',
  "  let vWrites = 0;",
  "  const setViewport = () => {",
  "    // Circuit breaker. A runaway viewport loop blocks the main thread and the",
  "    // page never finishes loading -- it took the whole site down once. No",
  "    // legitimate reason to write this more than a handful of times. It counts",
  "    // writes, not calls: SoundCloud adds to <head> all the time, and counting",
  "    // every one used up the guard within seconds of loading.",
  "    if (vWrites > 60) return;",
  '    let m = document.querySelector(\'meta[name="viewport"]\');',
  "    if (!m) { vWrites++; m = document.createElement('meta'); m.name = 'viewport'; (document.head || H).appendChild(m); }",
  "    const want = 'width=device-width, initial-scale=1, viewport-fit=cover';",
  "    // Only write when it actually differs. The observer below watches head",
  "    // attributes, so an unconditional setAttribute retriggers it forever and",
  "    // the page never finishes loading.",
  "    if (m.getAttribute('content') !== want) { vWrites++; m.setAttribute('content', want); }",
  '  };',
  '  setViewport();',
  "  window.addEventListener('orientationchange', () => setTimeout(setViewport, 150));",
  "",
  "  // Keep asserting it. The whole mobile layout hangs off a media query, so if",
  "  // anything rewrites this meta the page snaps back to the 1280px desktop",
  "  // canvas and every rule silently stops matching.",
  "  try {",
  "    new MutationObserver(setViewport).observe(document.head || H, { childList: true });",
  "  } catch (e) {}",
  "  let vTicks = 0;",
  "  const vTimer = setInterval(() => { setViewport(); if (++vTicks > 20) clearInterval(vTimer); }, 500);",
  '',
  '  // Touch has no hover, so these cost frame time and give nothing back (and',
  '  // a row hover highlight sticks after a tap). The keys are effectOn()\'s',
  "  // 'scFx_' + name: this wrote 'scFxTilt' etc. for years, which nothing read.",
  '  try {',
  "    if (matchMedia('(hover: none)').matches) {",
  "      ['tilt', 'wave', 'pulse', 'hover'].forEach((k) => localStorage.setItem('scFx_' + k, '0'));",
  '    }',
  '  } catch (e) {}',
  '',
  '  // Features with no mobile equivalent. Hiding them beats showing a control',
  '  // that silently does nothing.',
  "  const DEAD = ['accounts', 'last.fm scrobbling'];",
  '  // The Social/Settings page is only built the first time it opens, which can',
  '  // be long after load: keep checking (each section once) rather than giving',
  '  // up after a few seconds, which left these showing.',
  '  const prune = () => {',
  "    document.querySelectorAll('#hoq-discord .hoq-dc-sec:not([data-hoq-pruned])').forEach((sec) => {",
  "      sec.dataset.hoqPruned = '1';",
  "      const l = sec.querySelector('.hoq-dc-label');",
  "      if (l && DEAD.indexOf(l.textContent.trim().toLowerCase()) !== -1) sec.style.display = 'none';",
  '    });',
  '  };',
  '  prune();',
  '  setInterval(() => { if (!document.hidden) prune(); }, 700);',
  "",
  "  // Signed out? Then hide the account controls (see hoq-anon in the CSS).",
  "  // Detected from the DOM rather than a cookie, because the proxy forwards",
  "  // SoundCloud's own cookies and an anonymous session still sets several.",
  "  const anonTick = () => {",
  "    const signedIn = !!document.querySelector(\".header__userNavUsernameButton, .header__userNav a[href^='/you']\");",
  "    const signInBtn = [...document.querySelectorAll(\".header__right a, .header__right button\")]",
  "      .some((b) => /sign in|create account/i.test(b.textContent || \"\"));",
  "    if (!signedIn && signInBtn) H.classList.add(\"hoq-anon\");",
  "    else if (signedIn) H.classList.remove(\"hoq-anon\");",
  "    // The auth iframe is injected on demand; drop its container outright so a",
  "    // hidden-but-present modal cannot still trap scroll or taps.",
  "    if (H.classList.contains(\"hoq-anon\")) {",
  "      document.querySelectorAll(\"iframe[src*='web-auth'], iframe[src*='one-tap']\").forEach((f) => {",
  "        const box = f.closest(\"div[class]\") || f.parentElement;",
  "        if (box && box !== document.body) box.remove(); else f.remove();",
  "      });",
  "    }",
  "  };",
  "  anonTick();",
  "  setInterval(() => { if (!document.hidden) anonTick(); }, 1200);   // idle while the page is hidden (battery)",
  ROUTE_SIGNIN,
  MOBILE_SIGNIN,
  FEED_NET,
  '  const HOQ_FRAME_CSS = ' + JSON.stringify(MOBILE_FRAME_CSS) + ';',
  MOBILE_UI,
  "",
  "  // ---- session transplant (receiving end) -----------------------------",
  "  // SoundCloud will not let a sign-in complete through this proxy: its bot",
  "  // protection challenges the request. But a session created normally on the",
  "  // desktop app can be carried over -- same person, same real session, just",
  "  // used from another device.",
  "  //",
  "  // The token arrives in the URL FRAGMENT, which browsers never send to the",
  "  // server. It therefore never appears in nginx logs or any upstream request",
  "  // that did not already need it.",
  "  try {",
  "    const HASH = \"#hoqs=\";",
  "    if (location.hash.indexOf(HASH) === 0) {",
  "      const raw = decodeURIComponent(location.hash.slice(HASH.length));",
  "      const jar = JSON.parse(atob(raw));",
  "      const host = location.hostname.replace(/^[^.]+./, \"\");",
  "      Object.keys(jar).forEach(function (k) {",
  "        document.cookie = k + \"=\" + jar[k] + \"; path=/; domain=.\" + host +",
  "          \"; max-age=31536000; secure; samesite=lax\";",
  "      });",
  "      // Drop the token out of the address bar before anything can screenshot",
  "      // or share it, then reload so the app boots authenticated.",
  "      history.replaceState(null, \"\", location.pathname + location.search);",
  "      location.reload();",
  "    }",
  "  } catch (e) {}",
  "",
  "  // Signed out, /signin and /feed are walls with nothing on them. Bounce back",
  "  // to Discover rather than stranding the user on an empty page they cannot",
  "  // get past. replace() so Back does not land on the wall again.",
  "  const WALLS = new RegExp(\"^/(signin|feed|you|upload|notifications|messages)(/|$)\");",
  "  const bounce = () => {",
  "    if (!H.classList.contains(\"hoq-anon\")) return;",
  "    if (WALLS.test(location.pathname)) location.replace(\"/discover\");",
  "  };",
  "  setTimeout(bounce, 1500);",
  "  setInterval(bounce, 1500);",
  '',
  '  // Replies from the sandbox.',
  "  window.addEventListener('message', (e) => {",
  '    const d = e.data;',
  '    if (!d || d.__hoqReply !== 1) return;',
  "    if (d.kind === 'cover' && d.dataUrl) {",
  '      // A data: URL is same-origin, so the canvas is untainted and preload\'s',
  '      // own extractor can run — this replaces the desktop C# sampler.',
  '      try {',
  '        coverColors(d.dataUrl, (c) => {',
  '          if (c && window.__scCoverColors) window.__scCoverColors(c.c1, c.c2);',
  '        });',
  '      } catch (err) {}',
  "    } else if (d.kind === 'friends' && d.list) {",
  '      try { window.__hoqFriends && window.__hoqFriends(d.list); } catch (err) {}',
  "    } else if (d.kind === 'dcwidget') {",
  '      try { window.__hoqDcWidget && window.__hoqDcWidget(d.data); } catch (err) {}',
  "    } else if (d.kind === 'toast') {",
  "      try { console.log('[hoq]', d.text); } catch (err) {}",
  '    }',
  '  });',
  '})();',
].join('\n');

payload += '\n' + SHIM + '\n';

/* ---- 3. Metadata ------------------------------------------------------- */
const META = [
  '// ==UserScript==',
  '// @name         holdonquietly for SoundCloud',
  '// @namespace    https://github.com/dwindles/holdonquietly-soundcloud',
  '// @version      ' + new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
  '// @description  The holdonquietly theme for SoundCloud, on mobile.',
  '// @author       dwindles',
  '// @match        https://soundcloud.com/*',
  '// @match        https://*.soundcloud.com/*',
  '// @downloadURL  https://raw.githubusercontent.com/dwindles/holdonquietly-soundcloud/master/dist/holdonquietly.user.js',
  '// @updateURL    https://raw.githubusercontent.com/dwindles/holdonquietly-soundcloud/master/dist/holdonquietly.user.js',
  '// @run-at       document-start',
  '// @inject-into  auto',
  '// @grant        GM_xmlhttpRequest',
  '// @grant        GM.xmlHttpRequest',
  '// @grant        GM_getValue',
  '// @grant        GM_setValue',
  '// @connect      discord.com',
  '// @connect      discordapp.com',
  '// @connect      155.138.222.253',
  '// @connect      sndcdn.com',
  '// ==/UserScript==',
  '',
  '',
];

/* ---- 4. Sandbox half --------------------------------------------------- */
const BRIDGE_HEAD = [
  '(function () {',
  "  'use strict';",
  '',
  "  const BACKEND = 'http://155.138.222.253:8790';",
  "  const KEY = 'hoqWebhook';",
  '',
  '  const store = {',
  '    get: (k, d) => {',
  '      try { return GM_getValue(k, d); }',
  '      catch (e) { try { return localStorage.getItem(k) || d; } catch (e2) { return d; } }',
  '    },',
  '    set: (k, v) => {',
  '      try { GM_setValue(k, v); }',
  '      catch (e) { try { localStorage.setItem(k, v); } catch (e2) {} }',
  '    },',
  '  };',
  '',
  '  const reply = (kind, extra) => {',
  '    try {',
  '      window.postMessage(Object.assign({ __hoqReply: 1, kind: kind }, extra), location.origin);',
  '    } catch (e) {}',
  '  };',
  '',
  '  // Managers disagree on this one. Tampermonkey (Android) has the classic',
  '  // sync GM_xmlhttpRequest; the iOS Userscripts app implements the newer',
  '  // promise-style GM.xmlHttpRequest instead. Resolve whichever exists, and',
  '  // fall back to plain fetch — SoundCloud ships no script-src/connect-src CSP,',
  '  // so fetch reaches the webhook fine. It cannot read the artwork CDN (that is',
  '  // a CORS wall, which is the whole reason GM is preferred).',
  '  function req(opts) {',
  '    try {',
  "      if (typeof GM_xmlhttpRequest === 'function') return GM_xmlhttpRequest(opts);",
  '    } catch (e) {}',
  '    try {',
  "      if (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') {",
  '        return GM.xmlHttpRequest(opts);',
  '      }',
  '    } catch (e) {}',
  '    try {',
  '      fetch(opts.url, {',
  "        method: opts.method || 'GET',",
  '        headers: opts.headers || undefined,',
  '        body: opts.data || undefined,',
  '      })',
  '        .then((r) => (',
  "          opts.responseType === 'blob'",
  "            ? r.blob().then((b) => ({ status: r.status, response: b, responseText: '' }))",
  '            : r.text().then((t) => ({ status: r.status, responseText: t }))',
  '        ))',
  '        .then((res) => { if (opts.onload) opts.onload(res); })',
  '        .catch((err) => {',
  '          if (opts.onerror) opts.onerror(err);',
  "          reply('toast', { text: 'request failed: ' + err.message });",
  '        });',
  "    } catch (e) { reply('toast', { text: 'no transport available: ' + e.message }); }",
  '  }',
  '',
  '  // Byte-for-byte the embed the C# host builds, so the Quiet bot sees an',
  '  // identical message (it keys off embed.url and the "hoq-play" footer).',
  '  function sendEmbed(json, play) {',
  "    let wh = store.get(KEY, '');",
  '    if (!wh) {',
  "      wh = prompt('Paste your Discord webhook URL (kept on this device only):') || '';",
  '      if (!/^https?:/.test(wh)) {',
  "        reply('toast', { text: 'no webhook configured' });",
  '        return;',
  '      }',
  '      store.set(KEY, wh.trim());',
  '    }',
  '    let r;',
  '    try { r = JSON.parse(json); } catch (e) { return; }',
  "    if (!r.title) { reply('toast', { text: 'payload had no title' }); return; }",
  '',
  '    const author = {',
  "      name: r.name ? (r.name + (play ? ' wants to play this' : ' shared a track'))",
  "                   : (play ? 'Play request' : 'Now playing'),",
  '    };',
  '    if (r.avatar) author.icon_url = r.avatar;',
  '',
  '    const embed = {',
  '      author: author,',
  '      title: r.title,',
  "      color: typeof r.color === 'number' ? r.color : 0xff5500,",
  '      timestamp: new Date().toISOString(),',
  "      footer: { text: play ? 'hoq-play' : 'via holdonquietly' },",
  '    };',
  '    if (r.url) embed.url = r.url;',
  "    if (r.artist) embed.description = 'by **' + r.artist + '**';",
  '    if (r.cover) embed.thumbnail = { url: r.cover };',
  '',
  '    const fields = [];',
  "    if (r.length) fields.push({ name: 'Length', value: r.length, inline: true });",
  "    if (r.url) fields.push({ name: 'Listen', value: '[Open in SoundCloud](' + r.url + ')', inline: true });",
  '    if (fields.length) embed.fields = fields;',
  '',
  "    const body = { username: r.name || 'holdonquietly', embeds: [embed] };",
  '    if (r.avatar) body.avatar_url = r.avatar;',
  '',
  '    req({',
  "      method: 'POST',",
  "      url: store.get(KEY, ''),",
  "      headers: { 'Content-Type': 'application/json' },",
  '      data: JSON.stringify(body),',
  "      onload: (res) => reply('toast', { text: (play ? 'playreq' : 'share') + ' <- HTTP ' + res.status }),",
  "      onerror: () => reply('toast', { text: (play ? 'playreq' : 'share') + ' failed' }),",
  '    });',
  '  }',
  '',
  "  // SoundCloud's CDN taints the canvas, which is why the desktop build samples",
  '  // artwork in C#. GM_xmlhttpRequest is not bound by that, so re-serve the',
  '  // bytes as a data: URL and let preload\'s own extractor do the work.',
  '  function cover(url) {',
  '    req({',
  "      method: 'GET', url: url, responseType: 'blob',",
  '      onload: (res) => {',
  '        try {',
  '          const fr = new FileReader();',
  "          fr.onload = () => reply('cover', { dataUrl: fr.result });",
  '          fr.readAsDataURL(res.response);',
  '        } catch (e) {}',
  '      },',
  '    });',
  '  }',
  '',
  '  function friends() {',
  '    req({',
  "      method: 'GET', url: BACKEND + '/friends',",
  "      onload: (res) => { try { reply('friends', { list: JSON.parse(res.responseText) }); } catch (e) {} },",
  '    });',
  '  }',
  '',
  '  // The desktop host polls this on its own loop (FriendsLoop) — nothing in the',
  '  // page ever asks for it — so the sandbox has to drive it here too. The first',
  '  // call is delayed so the page-side listener exists to receive the reply.',
  '  setTimeout(friends, 3000);',
  '  setInterval(friends, 60000);',
  '',
  '  function dcWidget() {',
  '    req({',
  "      method: 'GET',",
  "      url: 'https://discord.com/api/guilds/795316631655546900/widget.json',",
  '      onload: (res) => {',
  '        let j = null;',
  '        try { j = JSON.parse(res.responseText); } catch (e) {}',
  "        reply('dcwidget', { data: j });",
  '      },',
  "      onerror: () => reply('dcwidget', { data: null }),",
  '    });',
  '  }',
  '',
  "  window.addEventListener('message', (e) => {",
  '    if (e.source !== window) return;',
  '    const d = e.data;',
  '    if (!d || d.__hoq !== 1) return;',
  "    const cmd = String(d.cmd || '');",
  "    if (cmd.indexOf('webhook:') === 0) sendEmbed(cmd.slice(8), false);",
  "    else if (cmd.indexOf('playreq:') === 0) sendEmbed(cmd.slice(8), true);",
  "    else if (cmd.indexOf('cover:') === 0) cover(cmd.slice(6));",
  "    else if (cmd === 'dcwidget') dcWidget();",
  "    else if (cmd.indexOf('open:') === 0) { if (/^https?:\\/\\//i.test(cmd.slice(5))) try { window.open(cmd.slice(5), '_blank', 'noopener'); } catch (er) {} }   // web links only, as on the desktop",
  '    // Everything else (win:*, rpc:, acct:*, lastfm:*, update:apply, DBG…) has',
  '    // no mobile equivalent and is intentionally dropped.',
  '  });',
  '',
  '  // Inject the payload into the PAGE world. Function.toString() carries the',
  '  // source verbatim, so none of preload.js needs escaping.',
  '  function __hoqPayload() {',
].join('\n');

const BRIDGE_TAIL = [
  '  }',
  '',
  "  const el = document.createElement('script');",
  "  el.textContent = '(' + __hoqPayload.toString() + ')();';",
  '  (document.head || document.documentElement).appendChild(el);',
  '  el.remove();',
  '})();',
  '',
].join('\n');

/* Assembled by concatenation, never template interpolation: preload.js is full
   of its own backticks and ${...} and would not survive being interpolated. */
const out = META.join('\n') + BRIDGE_HEAD + '\n' + payload + '\n' + BRIDGE_TAIL;

const dir = path.join(ROOT, 'dist');
fs.mkdirSync(dir, { recursive: true });
const dest = path.join(dir, 'holdonquietly.user.js');
fs.writeFileSync(dest, out, 'utf8');
console.log('wrote ' + dest);
console.log('  ' + Math.round(out.length / 1024) + ' KB, ' + out.split('\n').length + ' lines');

/* =======================================================================
   Second output: a bookmarklet build, for a phone that cannot install an
   extension at all.

   It gives up less than you would expect, because two things checked out:
     - SoundCloud ships no script-src/connect-src CSP, so an injected
       <script src> runs and plain fetch reaches the Discord webhook.
     - i1.sndcdn.com sends Access-Control-Allow-Origin: *, so preload's own
       canvas extractor reads artwork fine. Cover accent needs no host at all;
       the 'cover:' fallback that exists for the desktop build never fires.

   What it does lose: the friends feed. That backend is plain http://, and a
   fetch to http from an https page is mixed content and blocked. GM_xmlhttp-
   Request is exempt, which is why the userscript build keeps it.
   ======================================================================= */
const BOOT_POST = [
  'function scPost(cmd) {',
  '  // Bookmarklet build: no host, no GM. Handle what a plain page can do and',
  '  // drop the rest (win:*, rpc:, acct:*, lastfm:*, update:apply, DBG…).',
  '  try {',
  '    cmd = String(cmd);',
  "    if (cmd.indexOf('webhook:') === 0) window.__hoqSend(cmd.slice(8), false);",
  "    else if (cmd.indexOf('playreq:') === 0) window.__hoqSend(cmd.slice(8), true);",
  "    else if (cmd.indexOf('open:') === 0) { if (/^https?:\\/\\//i.test(cmd.slice(5))) window.open(cmd.slice(5), '_blank', 'noopener'); }   // web links only",
  "    else if (cmd === 'feed:get') window.__hoqFeedNet && window.__hoqFeedNet.get();   // the community feed (shim)",
  "    else if (cmd.indexOf('feed:post:') === 0) window.__hoqFeedNet && window.__hoqFeedNet.post(cmd.slice(10));",
  '  } catch (e) {}',
  '}',
].join('\n');

const BOOT_SEND = [
  '',
  '/* ---------------- bookmarklet: webhook over plain fetch ---------------- */',
  '(() => {',
  "  const KEY = 'hoqWebhook';",
  '  window.__hoqSend = function (json, play) {',
  '    let wh;',
  "    try { wh = localStorage.getItem(KEY) || ''; } catch (e) { wh = ''; }",
  '    if (!wh) {',
  "      wh = prompt('Paste your Discord webhook URL (kept on this device only):') || '';",
  '      if (!/^https?:/.test(wh)) return;',
  '      try { localStorage.setItem(KEY, wh.trim()); } catch (e) {}',
  '    }',
  '    let r;',
  '    try { r = JSON.parse(json); } catch (e) { return; }',
  '    if (!r.title) return;',
  '',
  '    const author = {',
  "      name: r.name ? (r.name + (play ? ' wants to play this' : ' shared a track'))",
  "                   : (play ? 'Play request' : 'Now playing'),",
  '    };',
  '    if (r.avatar) author.icon_url = r.avatar;',
  '    const embed = {',
  '      author: author,',
  '      title: r.title,',
  "      color: typeof r.color === 'number' ? r.color : 0xff5500,",
  '      timestamp: new Date().toISOString(),',
  "      footer: { text: play ? 'hoq-play' : 'via holdonquietly' },",
  '    };',
  '    if (r.url) embed.url = r.url;',
  "    if (r.artist) embed.description = 'by **' + r.artist + '**';",
  '    if (r.cover) embed.thumbnail = { url: r.cover };',
  '    const fields = [];',
  "    if (r.length) fields.push({ name: 'Length', value: r.length, inline: true });",
  "    if (r.url) fields.push({ name: 'Listen', value: '[Open in SoundCloud](' + r.url + ')', inline: true });",
  '    if (fields.length) embed.fields = fields;',
  "    const body = { username: r.name || 'holdonquietly', embeds: [embed] };",
  '    if (r.avatar) body.avatar_url = r.avatar;',
  '',
  '    try {',
  '      fetch(wh, {',
  "        method: 'POST',",
  "        headers: { 'Content-Type': 'application/json' },",
  '        body: JSON.stringify(body),',
  "      }).then((res) => console.log('[hoq] ' + (play ? 'playreq' : 'share') + ' <- HTTP ' + res.status))",
  "        .catch((e) => console.log('[hoq] send failed: ' + e.message));",
  '    } catch (e) {}',
  '  };',
  '})();',
].join('\n');

let bootPayload = src.replace(OLD_POST, BOOT_POST) + '\n' + SHIM + '\n' + BOOT_SEND + '\n';

const BOOT = [
  '/* holdonquietly — bookmarklet build. GENERATED by tools/build-userscript.js.',
  '   For a phone that cannot install a userscript manager: load it from a',
  '   javascript: bookmark. See MOBILE.md. */',
  '(function () {',
  '  if (window.__hoqLoaded) return;',
  '  window.__hoqLoaded = true;',
  '',
].join('\n') + bootPayload + '\n})();\n';

const bootDest = path.join(dir, 'holdonquietly.boot.js');
fs.writeFileSync(bootDest, BOOT, 'utf8');
console.log('wrote ' + bootDest);
console.log('  ' + Math.round(BOOT.length / 1024) + ' KB, ' + BOOT.split('\n').length + ' lines');

/* The bookmark itself: a loader, because a 290 KB javascript: URL is not a
   thing. jsDelivr is required — GitHub raw serves text/plain with nosniff, so
   the browser refuses to execute it as a script. */
const LOADER =
  "javascript:(function(){if(window.__hoqLoaded)return;var s=document.createElement('script');" +
  "s.src='https://cdn.jsdelivr.net/gh/dwindles/holdonquietly-soundcloud@master/dist/holdonquietly.boot.js?v='+Date.now();" +
  'document.body.appendChild(s);})()';
fs.writeFileSync(path.join(dir, 'bookmarklet.txt'), LOADER + '\n', 'utf8');
console.log('wrote ' + path.join(dir, 'bookmarklet.txt') + '  (' + LOADER.length + ' chars)');

/* Same loader again, shaped for the iOS Shortcuts "Run JavaScript on Web Page"
   action. Shortcuts is preinstalled, so this is the one route that needs no
   App Store and no bookmark editing. That action requires calling completion()
   to hand a result back, or the shortcut just hangs. */
const SHORTCUT = [
  'var s = document.createElement("script");',
  "s.src = 'https://cdn.jsdelivr.net/gh/dwindles/holdonquietly-soundcloud@master/dist/holdonquietly.boot.js?v=' + Date.now();",
  'document.body.appendChild(s);',
  'completion("hoq loaded");',
].join('\n');
fs.writeFileSync(path.join(dir, 'shortcut.js'), SHORTCUT + '\n', 'utf8');
console.log('wrote ' + path.join(dir, 'shortcut.js') + '  (' + SHORTCUT.split('\n').length + ' lines)');

/* =======================================================================
   Third output: the reverse-proxy build (see proxy/hoq-proxy.conf).

   Served from the proxy's own origin, so it is same-origin with the app.
   That removes every constraint the other two builds work around:
     - no CSP and no CORS, because there is only one origin
     - artwork is proxied through us, so the canvas is never tainted
     - the friends backend is reachable at /__hoq/friends — it is plain http,
       which an https page cannot fetch directly, but nginx can

   So this is the most capable mobile build, not the least. Rich Presence (local
   Discord IPC) goes the long way round: phone -> /__hoq/np -> the desktop app ->
   Discord. Only account switching (a WebView2 profile thing) stays out of reach.
   ======================================================================= */
const PROXY_POST = [
  'function scPost(cmd) {',
  '  // Reverse-proxy build: same-origin, so plain fetch is enough.',
  '  try {',
  '    cmd = String(cmd);',
  "    if (cmd.indexOf('webhook:') === 0) window.__hoqSend(cmd.slice(8), false);",
  "    else if (cmd.indexOf('playreq:') === 0) window.__hoqSend(cmd.slice(8), true);",
  "    else if (cmd.indexOf('open:') === 0) { if (/^https?:\\/\\//i.test(cmd.slice(5))) window.open(cmd.slice(5), '_blank', 'noopener'); }   // web links only",
  "    else if (cmd.indexOf('rpc:') === 0) window.__hoqNpRelay && window.__hoqNpRelay(cmd.slice(4));",
  "    else if (cmd === 'feed:get') window.__hoqFeedNet && window.__hoqFeedNet.get();   // the community feed (shim)",
  "    else if (cmd.indexOf('feed:post:') === 0) window.__hoqFeedNet && window.__hoqFeedNet.post(cmd.slice(10));",
  '  } catch (e) {}',
  '}',
].join('\n');

const PROXY_EXTRA = [
  '',
  '/* -------- reverse-proxy build: now playing -> Discord, via the desktop app -------- */',
  '(() => {',
  '  // Discord only takes Rich Presence from a program beside its desktop client,',
  '  // so the phone reports to proxy/pair-server.js and the holdonquietly app on',
  '  // the PC (signed into the same account) puts it on Discord.',
  '  const post = (body) => {',
  "    if (document.cookie.indexOf('oauth_token=') < 0) return;   // signed out: nobody to show it for",
  "    fetch('/__hoq/np', { method: 'POST', headers: { 'Content-Type': 'application/json' },",
  "      body, keepalive: true, credentials: 'same-origin' }).catch(() => {});",
  '  };',
  '  window.__hoqNpRelay = (json) => {',
  '    let d;',
  '    try { d = JSON.parse(json); } catch (e) { return; }',
  '    // Only what Discord shows: not the friends-feed identity fields.',
  '    post(JSON.stringify({ title: d.title, artist: d.artist, cover: d.cover, url: d.url,',
  '      artistUrl: d.artistUrl, pos: d.pos, dur: d.dur, paused: d.paused, rp: d.rp }));',
  '  };',
  '  // Closing the tab stops the music, so take the presence down with it.',
  "  window.addEventListener('pagehide', (e) => { if (!e.persisted) post(JSON.stringify({ title: '' })); });",
  '})();',
  '',
  '/* -------- reverse-proxy build: listening stats -> the desktop app -> hoq account -------- */',
  '(() => {',
  '  // The phone counts plays like the app does. Its whole tally goes to the',
  '  // server every couple of minutes (and on load); the holdonquietly app on the PC',
  '  // picks it up and adds it to the person\'s hoq account as this phone\'s entry.',
  "  let sent = '';",
  '  const push = () => {',
  "    if (document.cookie.indexOf('oauth_token=') < 0) return;",
  '    let s; try { s = hoqStatsRead(); } catch (e) { return; }',
  "    const sig = s.device + '|' + s.plays + '|' + s.seconds;",
  '    if (!s.plays || sig === sent) return;',
  '    sent = sig;',
  "    fetch('/__hoq/stats', { method: 'POST', headers: { 'Content-Type': 'application/json' },",
  "      body: JSON.stringify(Object.assign(hoqStatsTrim(s), { source: 'phone' })), credentials: 'same-origin' }).catch(() => { sent = ''; });",
  '  };',
  '  setTimeout(push, 15000);',
  '  setInterval(push, 120000);',
  "  document.addEventListener('visibilitychange', () => { if (document.hidden) push(); });",
  '})();',
  '',
  '/* -------- reverse-proxy build: friends feed over the local hop -------- */',
  '(() => {',
  '  // nginx proxies this to the plain-http backend on the same box, which is',
  '  // the only reason an https page can reach it at all.',
  '  const pull = () => {',
  "    fetch('/__hoq/friends', { credentials: 'omit' })",
  '      .then((r) => r.json())',
  '      .then((list) => { try { window.__hoqFriends && window.__hoqFriends(list); } catch (e) {} })',
  '      .catch(() => {});',
  '  };',
  '  setTimeout(pull, 3000);',
  '  setInterval(pull, 60000);',
  '})();',
  '',
  '/* -------- reverse-proxy build: keep the sign-in from running out -------- */',
  '(() => {',
  '  // Safari caps a cookie set from script at 7 days, Home Screen web apps',
  '  // included, and phones signed in before this got theirs that way, so they',
  '  // were signed out every week. About once a day, hand the same login to the',
  '  // pair service, which sets it back as a server cookie good for a year (and',
  '  // puts it right again if anything rewrites it from script).',
  "  const KEY = 'hoqLoginRenewedAt';",
  "  const get = (n) => { const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')); return m ? m[1] : ''; };",
  '  const renew = () => {',
  "    const o = get('oauth_token');",
  '    if (!o) return;',
  '    let last = 0;',
  '    try { last = +localStorage.getItem(KEY) || 0; } catch (e) {}',
  '    if (Date.now() - last < 20 * 3600 * 1000) return;',
  "    fetch('/__hoq/pair/login', {",
  "      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },",
  "      body: JSON.stringify({ o, s: get('sc_session'), h: location.hostname }),",
  '    }).then((r) => { if (r.ok) { try { localStorage.setItem(KEY, String(Date.now())); } catch (e) {} } }).catch(() => {});',
  '  };',
  '  setTimeout(renew, 8000);',
  "  document.addEventListener('visibilitychange', () => { if (!document.hidden) renew(); });",
  '})();',
].join('\n');

// The webi bridge (preload, between the <hoq-webi-bridge> markers) runs first and
// on its own. Signed-in track pages are SoundCloud's new React app in an iframe on
// our host, so nginx injects this script there too — and the theme's UI editing
// that page before React hydrated it made React give up ("Oops. Something went
// wrong."). Inside that frame: the bridge, then stop.
const BRIDGE_RE = /\/\/ <hoq-webi-bridge>\n[\s\S]*?\/\/ <\/hoq-webi-bridge>\n/;
const BRIDGE = (src.match(BRIDGE_RE) || [''])[0];
if (!BRIDGE) { console.error('FAIL: <hoq-webi-bridge> markers missing from preload.js.'); process.exit(1); }
let proxyPayload = src.replace(BRIDGE_RE, '').replace(OLD_POST, PROXY_POST) + '\n' + SHIM + '\n' + BOOT_SEND + '\n' + PROXY_EXTRA + '\n';

const PROXY_OUT = [
  '/* holdonquietly — reverse-proxy build. GENERATED by tools/build-userscript.js.',
  '   Served as /hoq.js by proxy/hoq-proxy.conf and injected into </head>. */',
  '(function () {',
  '  if (window.__hoqLoaded) return;',
  '  window.__hoqLoaded = true;',
  '  window.__hoqProxyBuild = true;   // presence relays through the server (preload: hoqRelaysPresence)',
  '',
  '  // iPhone/iPad: play the way iOS wants it — Safari\'s own HLS player on a plain',
  '  // <audio> element, no Web Audio in the path (flags read by the player code via',
  '  // proxy/hoq-rewrites.conf). localStorage hoqNativeIOS = "0" falls back.',
  '  (function () {',
  '    var ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);',
  '    var off = false;',
  '    try { off = localStorage.getItem("hoqNativeIOS") === "0"; } catch (e) {}',
  '    window.__hoqNativeHls = window.__hoqNoFades = ios && !off;',
  '  })();',
  '',
].join('\n') + BRIDGE +
  '\n  // SoundCloud\'s new-app frame (track pages): bridge only, never the theme UI.\n' +
  '  if (window !== window.top && /^\\/n\\//.test(location.pathname)) return;\n\n' +
  proxyPayload + '\n})();\n';

const proxyDest = path.join(dir, 'holdonquietly.proxy.js');
fs.writeFileSync(proxyDest, PROXY_OUT, 'utf8');
console.log('wrote ' + proxyDest);
console.log('  ' + Math.round(PROXY_OUT.length / 1024) + ' KB, ' + PROXY_OUT.split('\n').length + ' lines');
