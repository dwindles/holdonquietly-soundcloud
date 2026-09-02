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
  '  const req = (opts) => {',
  '    try { GM_xmlhttpRequest(opts); }',
  "    catch (e) { reply('toast', { text: 'request failed: ' + e.message }); }",
  '  };',
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
