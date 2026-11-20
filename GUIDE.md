# holdonquietly: the whole app

Everything in one place: what the app does, how it's built, how to ship it, and
the traps found along the way. The shorter docs go deeper on one area each:

| Doc | Covers |
| --- | --- |
| [README.md](README.md) | the short pitch + install |
| [HANDOFF.md](HANDOFF.md) | dev notes: build/run, the iframe split, the theming system |
| [NEW-HOME.md](NEW-HOME.md) | SoundCloud's new Home page and how it's themed |
| [MOBILE.md](MOBILE.md) | the phone versions (userscript, Shortcuts, bookmarklet, proxy) |
| [PLAY-IN-DISCORD.md](PLAY-IN-DISCORD.md) | Play in Discord → the Quiet bot |
| [DEPLOY.md](DEPLOY.md) | the friends / feed server |
| [IDEAS.md](IDEAS.md) | the feature wish list |

---

## 1. What it is

A SoundCloud app for Windows. It's soundcloud.com running inside WebView2 (Edge
in a window) with no window frame, and everything around it is restyled and
extended. Because it's Edge, the DRM pieces major-label tracks need (Widevine /
PlayReady) are built in, so tracks that won't play in other SoundCloud apps play here.

- **Host:** C# / .NET 9 / WPF, a frameless window around one WebView2.
- **Page side:** one big script, `preload.js`, injected into every page. It holds
  the whole theme, every panel, and all the features.
- They talk through one function: the page calls `scPost('message')`, and the host
  answers by running JavaScript in the page.

---

## 2. Install and updates

- Download `holdonquietly.exe` from the GitHub releases. One file, no installer,
  .NET built in. It needs the WebView2 runtime, which Windows 11 already has.
- It isn't code-signed, so SmartScreen warns the first time (More info → Run anyway).
- **Updates:** about 6 s after opening, the app checks the latest GitHub release.
  If it's newer, it downloads it quietly (about 175 MB) and shows a small "Update
  ready, Restart" note. The new version only swaps in when you click Restart or
  Quit from the tray, so playback is never cut off. Closing the window only hides it
  to the tray.

---

## 3. Features

### Look and theme

- **Colours from the cover.** The whole app recolours to the two main colours of
  the playing track's artwork ("Match song cover"), or a fixed accent / gradient
  you pick. Everything reads `--sc-accent` / `--sc-accent-bg`.
- **Cover background.** The page sits on a blurred, dimmed copy of the current
  cover (or a custom image), with a soft vignette. Panels are translucent over it.
- **One calm style.** Grey icon buttons with a soft hover tile, accent used for
  active states only, small dots for unread / "on". It covers the header, window
  controls, player bar, menus, queue, notices, search filters and Library nav.
- **Settings palette** (the app's own settings panel): Colour, Background,
  Display (zoom, brightness), Look, Motion, Performance, Trouble. It also holds the
  optional effects: song visualizer, 3D tile tilt, tab tilt, pulse, glow, frosted
  glass, rounded corners, hover lifts, marquee titles, hero fade, greyscale,
  ambient glow, and **Low-end mode** (turns all the heavy ones off).
- **SoundCloud's new pages.** SoundCloud is moving pages onto a new app that
  renders inside a frame: the new track page, and Home since November 2026. These
  are themed to match the classic pages (see §4 and NEW-HOME.md).

### Playing

- **Player bar:** quiet grey times and icons, white title, the play button in the
  accent. The seek bar can be a live audio visualizer.
- **Waveform:** custom bars drawn over SoundCloud's, coloured by the cover. They
  rise toward the cursor, with the playhead.
- **Next up queue:** acrylic panel, title over artist, actions on hover, played
  tracks faded, the playing one tinted. Rows stay 56 px tall because SoundCloud
  positions them in 56 px steps.
- **Ambient mode:** a big full-window now-playing view (button in the player bar).
- **Compact player:** a small always-on-top window. Three layouts (player / bar /
  name only), pin on top, and fade when the mouse leaves (like a Discord overlay).
- **Audio menu (EQ button in the header):**
  - **EQ:** 6 bands plus presets (Bass, Warm, Vocal, Treble, Punch, Old PC, Night…).
  - **Volume:** boost up to +12 dB (with a limiter so it doesn't crackle),
    "Even out volume" (auto level), and **Crossfade** (1–8 s; the song fades out
    into the next. SoundCloud plays one track at a time, so two can't overlap).
  - **Space:** 14 rooms (Bathroom, Shower, Concert hall, Church, Cave, Car outside,
    Underwater, Old radio, Phone speaker, Tunnel, 8D…) with an amount slider.
  - **Speed:** Normal / Slowed / Slowed + reverb / Daycore / Sped up / Nightcore, or
    any speed 0.5–1.5×. Speed and pitch move together like a record (no warble).
  - At rest the whole chain passes audio through untouched.
- **Audio output picker (headphones button):** send SoundCloud to any output device
  without changing the Windows default. A watchdog falls back to the default device
  if the chosen one stops responding (asleep monitor, unplugged headset), and tries
  it again when it reconnects.
- **Volume:** a horizontal slider instead of SoundCloud's vertical pop-up.

### Pages

- **Home (new design):** shelf tiles are bare rounded artwork, rows are soft
  panels, headings take the accent, genre chips use the tag style, hover keeps the
  cover bright with a small play button in the corner.
- **Profiles:** Find a track (searches the artist's whole catalogue through
  SoundCloud's API), Play all, Shuffle, a "You & <artist>" card from your listening
  stats (plays, this month, last played, your most-played tracks of theirs), "New"
  tags on tracks posted since your last visit, and a cleaner header. The tools sit
  on the banner, not in the tab bar.
- **Search:** filters as an icon list like the Library nav.
- **Notifications / messages / "…" menu:** same card style as the other menus.
  The "…" menu scrolls instead of running off small windows.

### Friends and Discord

- **Friends listening (Social/Settings):** everyone who has the app open and a track
  loaded, live (polled every 15 s from the friends server). Names come from the
  name set in Settings, else Discord, else the SoundCloud account.
- **Listen along:** follow someone's playback (same track, same spot, keeps
  following). The app side is built. It needs the updated friends server (see §8).
- **Discord Rich Presence:** what you're playing, progress and cover on your
  Discord profile. The status line can show the artist, the song, or
  "holdonquietlySC". Optional buttons, and it hides after 5 min paused.
- **Play in Discord:** asks the Quiet bot to play a track (per-row icon in each
  track's action row, and in the player bar). See PLAY-IN-DISCORD.md.
- **Share to Discord:** posts the current track to your webhook (kept locally in
  `webhook.txt`, never in the page or the repo).
- **Community feed:** short posts + shared tracks from other app users.

### Stats and accounts

- **Listening stats:** counted by the app itself (SoundCloud has no history to
  read). Plays, time, top artists / tracks, all time or 30 days, plus a monthly
  **Recap** card you can save or share.
- **holdonquietly account (optional):** log in to holdonquietly.com and your stats
  and settings sync across PCs. The stats can come back if lost locally, and can show
  on your holdonquietly profile along with "Listening now". Not needed to use the app.
- **Last.fm scrobbling:** done by the host, so the login never touches the page.
- **Several SoundCloud accounts:** save logins and switch without logging out.

### Desktop

- **Frameless window** with its own titlebar (macOS-style dots: grey at rest,
  coloured on hover), edge resizing, and a maximize that fills the work area of
  whichever monitor the window is on.
- **Small windows:** below 1280 px wide the page zooms out to fit, like browser
  zoom, so the layout never breaks. The compact player is never zoomed.
- **Tray icon:** closing hides to the tray. Quit from the tray menu.
- **Taskbar buttons:** previous / play / next on the taskbar thumbnail.
- **Song pop-up** (Settings → Desktop, off by default): a small cover-and-title card
  in the corner of whatever screen you're on when the song changes. It never takes
  focus and clicks go through it. There's a Preview button.
- **Right-click menu:** Copy, Copy link, Save image, Like, Play in Discord,
  Previous / Next, Reload, Inspect element. Ctrl+Shift+C opens the real element
  inspector.
- **Ad skipper:** mutes and fast-forwards audio ads (titlebar button). Local, optional.

### Phone

Three ways to get the theme on a phone, all built from the same `preload.js` by
`tools/build-userscript.js`. Details in MOBILE.md.

- **sc.holdonquietly.com (proxy):** SoundCloud served through your own domain with
  the theme injected. No install. It has its own phone layout and a floating
  now-playing pill (cover in the play button, progress ring, swipe to skip). Your
  PC can pair to sign it in.
- **Userscript** (iPhone *Userscripts* app / Tampermonkey), **Shortcuts** action,
  and a **bookmarklet**.

---

## 4. How it's built

### Files

| File | What it is |
| --- | --- |
| `Program.cs` | the host: window, WebView2, messages from the page, Discord RPC, friends server calls, webhooks, accounts, mini player, multi-monitor, zoom-to-fit, updater wiring, tray |
| `preload.js` | everything page-side: CSS (`BASE_CSS`, `MUI_CSS`), theming, panels, features |
| `Desktop.cs` | song pop-up window + taskbar thumbnail buttons |
| `Updater.cs` | GitHub-release self-updater (download, swap on quit) |
| `HoqAccount.cs` | holdonquietly.com account (login, stats/settings sync) |
| `LastFm.cs` | Last.fm auth + scrobbling |
| `ShortcutHelper.cs` | Start-menu shortcut / app identity |
| `tools/build-userscript.js` | builds the phone versions into `dist/` (`MOBILE_CSS`, the pill) |
| `tools/cdp.js`, `tools/shot.js` | inspect / screenshot a running app over the debug port |
| `proxy/` | nginx config + the friends server (`friends-server.js`) for sc.holdonquietly.com |

### Page ↔ host

The page sends string messages with `scPost(...)`: `rpc:{…}` (now playing),
`playreq:` / `webhook:` (Discord), `mini:on|off|size|pin|alpha`, `win:*`,
`acct:*`, `hoqacct:*`, `toast:test:`, `feed:*`, `recap:*`, `open:`, `saveimg:`…
The host replies with `ExecuteScriptAsync` calls to `window.__hoq*` functions
(friends list, update notices, Discord widget, account state…). Anything that comes
from a server is checked as JSON before it reaches the page, so it can't become code.

### Two generations of SoundCloud at once

- **Classic pages** (header, player, Library, profiles, search, your own tracks):
  plain markup, themed by `BASE_CSS` with SoundCloud's class names.
- **New pages** render as a separate MUI app in a **same-origin iframe**: other
  people's track pages (`.webiIframeV2Layout`), Home (`.webiEmbeddedModuleIframe`,
  `home-sdui`), Artist Studio. `themeFrames()` runs every second and, for each frame,
  injects `BASE_CSS + MUI_CSS`, copies the accent variables, mirrors our `<html>`
  classes and adds `hoq-webi`. New-page rules are in `MUI_CSS` and work mostly by
  repointing MUI's own colour tokens (`--mui-palette-*`) at the accent.
- **Orange repaint:** SoundCloud orange that CSS can't reach gets repainted with
  inline accent styles by `recolorOrange()`. It has a skip list for things that get
  their colour from CSS instead (header icons, player bar text, our own buttons).
  Inline `!important` beats any stylesheet, so anything on that list must stay off it.

### Audio

SoundCloud plays through Web Audio. The app hooks `createMediaElementSource` (to
find SoundCloud's AudioContext and audio element) and `AudioNode.connect` (to splice
its chain in before the speakers):

```
EQ bands → pre ─┬→ dry ──────────────────┐
                ├→ convolver (rooms) → wet ┼→ sum → HP → LP → pan (8D) → level → crossfade → boost → limiter → soft clip → out
                └→ delay ⇄ feedback (echo) ┘
```

Rooms are synthesized impulse responses (no downloaded files). A 100 ms ticker
handles speed (`playbackRate` with `preservesPitch` off) and the crossfade envelope.

### Stats

Counted locally from the now-playing tick and stored in `localStorage.hoqStats`:
totals, per-artist / per-title counts, per-day counts for 70 days, and first/last
play per artist. With an account, each PC uploads its own tally and the app shows
the sum, so nothing is counted twice.

### Friends server

A tiny Node server (`proxy/friends-server.js`, port 8790, behind nginx at
`sc.holdonquietly.com/__hoq/fb`). The app POSTs `/presence` and GETs `/friends`.
People drop off after 5 min of silence. Test copies never post.

---

## 5. Build, release, deploy

### Desktop release

1. Bump `<Version>` in `SoundCloudWV2.csproj`.
2. Commit and push (authored as **dwindles**). First check incoming commits
   (`git fetch` then `git log HEAD..origin/master`) and scrub any messages that
   shouldn't be in the repo before building on them.
3. `dotnet publish SoundCloudWV2.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o <out>`
4. Check the exe's FileVersion, then `gh release create vX.Y.Z <out>\holdonquietly.exe --notes-file notes.md`.
5. Everyone's app picks it up on its next launch.

### Phone (proxy)

`node tools/build-userscript.js` → copy `dist/holdonquietly.proxy.js` to the server
as `/var/www/hoq/holdonquietly.proxy.js` (keep a dated `.bak` of the old one).
nginx serves it as `/hoq.js` with revalidation, so reloading the page picks it up.
`dist/holdonquietly.user.js` updates through the repo (GitHub raw).

### Friends server

Copy `proxy/friends-server.js` to the box and restart its pm2 process (DEPLOY.md).

---

## 6. Testing

- **Test copy:** build to a separate folder and start it with
  `HOQ_DATADIR=<folder>` (its own data, settings and logins) and
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 --mute-audio`.
  A test copy is silent toward the outside world: no Discord status, no friends
  list, no phone relay, no Last.fm.
- **Live app inspection:** start the real app with `--remote-debugging-port=9222`,
  then `node tools/cdp.js -e "<js>"` / `node tools/shot.js out.png`.
- **Saved pages:** copy a frame's outerHTML from DevTools and render it in headless
  Edge with the current CSS injected (useful for signed-in-only pages).
- Logged out, SoundCloud shows sign-in walls after a few plays and never shows the
  new Home. A synthetic `.click()` doesn't count as a real tap for starting audio.

---

## 7. Traps (each one cost a bug)

- **Never set the audio element's `currentTime` directly.** Signed-in playback is
  SoundCloud's own chunked stream, and an outside seek leaves it buffering forever.
  Seek with `hoqSeek()`, which presses SoundCloud's progress bar at the right spot.
  Even that stalls if fired the instant a song starts.
- **Lazy lists load everything** if the list's bottom is always on screen (a
  sideways shelf). That froze the app once.
- **`backdrop-filter` on a parent** blocks blur inside it. The player bar's blur
  lives on a layer behind it so the queue can be acrylic.
- **Queue rows** sit in `.queue__itemWrapper`, which SoundCloud paints solid.
- **Custom waveform:** only copy SoundCloud's waveform once `.waveform` has `.loaded`.
  Before that it's a flat placeholder.
- **Window-edge resize handler** eats synthetic mousedowns at (0,0). Give test
  events real coordinates.
- **Frames inherit our classes**, including `sc-coverbg`. Any `body::before` effect
  draws twice unless it's turned off under `html.hoq-webi`.
- **Hashed class names** (`mui-xxxx`) change every SoundCloud deploy. Target `Mui*`
  classes, `aria-label`s and image `sizes` instead.
- **Header username:** SoundCloud's new header shows only the avatar. The name is
  read from the avatar's label.
- **Transitions** make `getComputedStyle` return the old value right after a change.
- **Installing over the running app** (`Stop-Process holdonquietly`) also kills any
  test copy.
- **The install folder's name is a hidden left-to-right mark.** PowerShell file
  cmdlets trim it, so use .NET calls with a `\\?\` path.

---

## 8. Open items

- **Listen along** needs `proxy/friends-server.js` deployed (it keeps track link,
  position, paused and speed). Until then the button doesn't appear.
- **Pick up where you left off** is switched off: jumping back the moment a song
  starts stalled playback on signed-in accounts. The position is still saved.
- **holdonquietlySC bot** shows offline in Discord because nothing signs in as it.
  Rich Presence only uses the app ID. Making it online needs a small always-on bot
  with its token on the server.
- **Go+ tracks** play in full only with a Go+ subscription. The app doesn't get
  around that.
