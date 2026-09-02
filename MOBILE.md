# holdonquietly on mobile

The desktop app is a WPF window wrapping WebView2. None of that shell can go to a
phone — but it turns out almost nothing of value lives there. The theme is
`preload.js` (~5,000 lines), and the page only ever asks the C# host for six
things through a single function, `scPost()`.

So the mobile build is a **userscript**, generated from the same `preload.js`.

```bash
node tools/build-userscript.js
```

That writes `dist/holdonquietly.user.js`. **Do not edit that file** — it is
overwritten on every build. Change `preload.js` (or the shim inside
`tools/build-userscript.js`) and rebuild, so desktop and mobile never drift.

## Install — iPhone

Userscripts has no "install from URL" prompt like Tampermonkey. It watches a
folder, so the file has to land in that folder.

1. App Store → **Userscripts** (free, open source).
2. Open it and pick a scripts directory when asked — e.g. iCloud Drive →
   `Userscripts`.
3. Settings → Apps → Safari → Extensions → **Userscripts** → on, and set
   soundcloud.com to **Allow**.
4. In Safari open the raw file:
   `https://raw.githubusercontent.com/dwindles/holdonquietly-soundcloud/master/dist/holdonquietly.user.js`
   then Share → **Save to Files** → the directory from step 2. The name must
   still end in `.user.js`.
5. Reopen Userscripts; the script should be listed and enabled.
6. On soundcloud.com tap **aA** → Request Desktop Website. Use *Website
   Settings* → Request Desktop Website so it sticks across visits.

Step 6 is not optional: SoundCloud serves a completely different DOM to phones,
and the theme binds to desktop selectors (`playbackSoundBadge` ×36,
`playControls` ×27, `headerSearch` ×12). Without desktop mode almost nothing
matches.

First Share to Discord asks once for your webhook URL and keeps it on the device.

## No-install option — bookmarklet

If you can't install a userscript manager, a `javascript:` bookmark is the only
remaining way to get code onto the page. It gives up less than you'd think — see
"How it is built" for why.

The bookmark is a 242-char loader (a 284 KB `javascript:` URL is not a thing).
It is in `dist/bookmarklet.txt`:

```
javascript:(function(){if(window.__hoqLoaded)return;var s=document.createElement('script');s.src='https://cdn.jsdelivr.net/gh/dwindles/holdonquietly-soundcloud@master/dist/holdonquietly.boot.js?v='+Date.now();document.body.appendChild(s);})()
```

Adding it on iOS, which is fiddly:

1. In Safari bookmark any page (Share → Add Bookmark → Favorites).
2. Copy the line above.
3. Bookmarks → **Edit** → tap that bookmark → clear the URL field and **paste**.
   Rename it something short like `hoq`. Paste rather than type — Safari strips a
   typed `javascript:` prefix.
4. Open soundcloud.com (with Request Desktop Website on), then tap the bookmark.

You tap it **once per page load**. SoundCloud is a single-page app, so it
survives normal navigation within a session — but a hard reload needs another
tap. That is the real cost of this route versus the extension.

It loads from jsDelivr, not GitHub raw: raw sends `text/plain` with `nosniff`, so
a browser refuses to execute it as a script.

### What the bookmarklet keeps and loses

Keeps the full theme, the cover-matched accent, and Discord share/queue.

Loses the **friends feed** — that backend is plain `http://`, and fetching http
from an https page is mixed content and blocked. `GM_xmlhttpRequest` is exempt
from that rule, which is the one real reason to prefer the extension.

## Install — Android

Kiwi Browser or Firefox, install Tampermonkey, open the raw URL above and accept
the install prompt. Same Request Desktop Site requirement.

## What works, and what can't

| Works | Why it can't |
|---|---|
| The whole theme — accent, cover background, blur, waveform, webi V2 track page | |
| Cover colour extraction | via `GM_xmlhttpRequest`, see below |
| Share to Discord / Play in Discord | |
| Friends list, server widget | |
| **Discord Rich Presence** | needs Discord desktop's local IPC socket; no mobile equivalent exists |
| **Account switching** | swaps WebView2 user-data directories — a process-level thing a userscript cannot do |
| **Last.fm scrobbling** | OAuth flow + app secret living in the host; portable, but not ported |
| **Window controls / titlebar** | the desktop window is frameless; meaningless on a phone. Hidden by the shim |

The dead Settings sections (Accounts, Last.fm) are hidden rather than left as
controls that silently do nothing.

## How it is built

Two details are load-bearing:

**The script runs in two worlds.** `GM_xmlhttpRequest` is the only reason we can
reach the Discord webhook and the artwork CDN at all — SoundCloud's CSP blocks
both from the page. But asking for a `GM_*` grant puts the script in the
manager's sandbox, and the ad-killer needs the page's real media engine. So the
GM calls stay in the sandbox, the payload is injected into the page, and
`window.postMessage` bridges them. `scPost()` is the only seam that changes.

**Cover colours no longer need C#.** The desktop build samples artwork in the
host because SoundCloud's CDN taints the canvas. `GM_xmlhttpRequest` is not bound
by CORS, so the sandbox refetches the image, hands back a `data:` URL — which is
same-origin, so untainted — and `preload.js`'s own extractor runs unchanged.

**Managers disagree about `GM_*`, so nothing is assumed.** Tampermonkey has the
classic synchronous `GM_xmlhttpRequest`; the iOS Userscripts app implements the
promise-style `GM.xmlHttpRequest` and largely cannot offer the sync
`GM_getValue`/`GM_setValue` at all, since its values come from an async native
call. So the bridge resolves whichever transport exists and falls back to plain
`fetch`, and storage falls back to `localStorage`. Both paths are unit-tested in
this repo with no `GM_*` present at all.

The `fetch` fallback is viable because **SoundCloud ships no `script-src` or
`connect-src` CSP** — the only policy anywhere is `frame-ancestors 'self'` on the
webi route, which governs framing, not scripts. That is also why injecting the
payload as an inline `<script>` is safe. What `fetch` *cannot* do is read the
artwork CDN: that is a CORS wall, and getting past it is the whole reason
`GM.xmlHttpRequest` is preferred when available.

The build fails loudly if `scPost()` in `preload.js` stops matching, rather than
silently shipping a stale bridge.

## Status

**The bookmarklet build has been run for real** — loaded from jsDelivr into a
desktop Chromium on soundcloud.com. It executed clean: `hoq-mobile` applied, our
stylesheets injected, the `#sc-bg` layer created, the titlebar hidden, the
viewport rewritten, `__scCoverColors` and `__hoqSend` both live, the nav renamed
to Discover / Stream / Collection / Social/Settings, and **no console errors from
our code** (only SoundCloud's own logged-out Google-auth noise).

The **userscript** build is syntax-verified at both layers (the outer script, and
the payload string `Function.toString()` produces at runtime), with the transport
and storage fallbacks unit-tested with no `GM_*` defined at all. Its GM bridge
specifically has not been exercised, since that needs a real manager.

**Neither has been run on a phone.** The desktop Chromium run proves the code
executes and binds; it says nothing about how a 1280px layout feels at 390px.
Expect the first real problem to be layout, not logic — and that needs a mobile
stylesheet, not more porting.
