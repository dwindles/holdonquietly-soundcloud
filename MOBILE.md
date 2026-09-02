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

## Install

**iPhone** — install [Userscripts](https://apps.apple.com/app/userscripts/id1463298887)
(free, open source), enable it in Settings → Safari → Extensions, then add
`dist/holdonquietly.user.js` to its scripts folder.

**Android** — Kiwi Browser or Firefox, install Tampermonkey, then open the
`.user.js` file and accept the install prompt.

Then, on `soundcloud.com`, turn on **Request Desktop Website**. This is not
optional: SoundCloud serves a completely different DOM to phones, and the theme
binds to desktop selectors (`playbackSoundBadge` ×36, `playControls` ×27,
`headerSearch` ×12). Without desktop mode almost nothing will match.

First time you tap Share to Discord it asks once for your webhook URL and stores
it on the device.

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

The build fails loudly if `scPost()` in `preload.js` stops matching, rather than
silently shipping a stale bridge.

## Status

Built and syntax-verified at both layers (the outer userscript, and the payload
string that `Function.toString()` produces at runtime), with every host callback
— `__scCoverColors`, `__hoqFriends`, `__hoqDcWidget` — wired to a replacement.

**It has not been run on a phone.** Everything else in this repo was verified
against the running app; this was not, because there is no device here. Expect
the first real problem to be layout, not logic: it is a desktop layout on a
phone screen, and no amount of porting fixes that without a mobile stylesheet.
