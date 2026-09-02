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
  '  // the rest are relayed to it, since it owns the GM_* APIs.',
  '  try { window.postMessage({ __hoq: 1, cmd: String(cmd) }, location.origin); } catch (e) {}',
  '}',
].join('\n');

let payload = src.replace(OLD_POST, NEW_POST);

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
  '  // Keep the desktop layout legible instead of letting the browser scale it',
  '  // down. You still need the browser\'s "Request Desktop Website" — a',
  '  // userscript cannot change the UA of a request that already happened.',
  '  const setViewport = () => {',
  '    let m = document.querySelector(\'meta[name="viewport"]\');',
  "    if (!m) { m = document.createElement('meta'); m.name = 'viewport'; (document.head || H).appendChild(m); }",
  "    m.setAttribute('content', 'width=1280, initial-scale=' + (window.screen.width / 1280).toFixed(3));",
  '  };',
  '  setViewport();',
  "  window.addEventListener('orientationchange', () => setTimeout(setViewport, 150));",
  '',
  '  // Touch has no hover, so these cost frame time and give nothing back.',
  '  try {',
  "    if (matchMedia('(hover: none)').matches) {",
  "      ['scFxTilt', 'scFxWave', 'scFxPulse'].forEach((k) => localStorage.setItem(k, '0'));",
  '    }',
  '  } catch (e) {}',
  '',
  '  // Features with no mobile equivalent. Hiding them beats showing a control',
  '  // that silently does nothing.',
  "  const DEAD = ['accounts', 'last.fm scrobbling'];",
  '  let ticks = 0;',
  '  const prune = () => {',
  "    document.querySelectorAll('#hoq-discord .hoq-dc-sec').forEach((sec) => {",
  "      const l = sec.querySelector('.hoq-dc-label');",
  "      if (l && DEAD.indexOf(l.textContent.trim().toLowerCase()) !== -1) sec.style.display = 'none';",
  '    });',
  '    if (++ticks < 20) setTimeout(prune, 700);',
  '  };',
  '  prune();',
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
  "    else if (cmd.indexOf('open:') === 0) { try { window.open(cmd.slice(5), '_blank'); } catch (er) {} }",
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
  "    else if (cmd.indexOf('open:') === 0) window.open(cmd.slice(5), '_blank');",
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

   So this is the most capable mobile build, not the least. Only Rich Presence
   (Discord's local IPC) and account switching (a WebView2 profile thing) stay
   out of reach.
   ======================================================================= */
const PROXY_POST = [
  'function scPost(cmd) {',
  '  // Reverse-proxy build: same-origin, so plain fetch is enough.',
  '  try {',
  '    cmd = String(cmd);',
  "    if (cmd.indexOf('webhook:') === 0) window.__hoqSend(cmd.slice(8), false);",
  "    else if (cmd.indexOf('playreq:') === 0) window.__hoqSend(cmd.slice(8), true);",
  "    else if (cmd.indexOf('open:') === 0) window.open(cmd.slice(5), '_blank');",
  '  } catch (e) {}',
  '}',
].join('\n');

const PROXY_EXTRA = [
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
].join('\n');

let proxyPayload = src.replace(OLD_POST, PROXY_POST) + '\n' + SHIM + '\n' + BOOT_SEND + '\n' + PROXY_EXTRA + '\n';

const PROXY_OUT = [
  '/* holdonquietly — reverse-proxy build. GENERATED by tools/build-userscript.js.',
  '   Served as /hoq.js by proxy/hoq-proxy.conf and injected into </head>. */',
  '(function () {',
  '  if (window.__hoqLoaded) return;',
  '  window.__hoqLoaded = true;',
  '',
].join('\n') + proxyPayload + '\n})();\n';

const proxyDest = path.join(dir, 'holdonquietly.proxy.js');
fs.writeFileSync(proxyDest, PROXY_OUT, 'utf8');
console.log('wrote ' + proxyDest);
console.log('  ' + Math.round(PROXY_OUT.length / 1024) + ' KB, ' + PROXY_OUT.split('\n').length + ' lines');
