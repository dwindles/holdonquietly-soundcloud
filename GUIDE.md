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
- **Go+ songs from YouTube** (desktop, Settings → Desktop, on by default): when a
  song would only play SoundCloud's 30-second Go+ preview, the app finds the same
  recording on YouTube and plays it in YouTube's own embedded player, a small card
  (bottom left, drag it anywhere) while it plays.
  - **Picking the video:** the length counts most (a music video with a long intro
    loses to the plain audio), then the title, the artist's own channel, and the
    right version (an acoustic track gets the acoustic recording; remixes, live
    takes and sped-up uploads drop back). "Not it" plays the next match, ↗ opens it
    on YouTube, × goes back to the preview.
  - **Controls:** SoundCloud's play button, Space, the media keys, the seek bar and
    the compact player work the YouTube player, and the bar shows its time. When the
    video ends, SoundCloud plays the next song. Discord, Last.fm, stats, jams and
    listen along follow the YouTube player's progress.
  - **Songs SoundCloud won't start at all:** usually SoundCloud gives no preview.
    Either the play button is greyed out ("Unavailable", nothing happens), or
    pressing it opens SoundCloud's Go+ checkout, which the host stops from loading.
    The app catches both presses and plays the song from YouTube straight away.
    SoundCloud's bar never gets that song, so the app says what's playing:
    - The bar's song slot, Discord, Last.fm, stats, jams and the compact player
      all show the pressed song.
    - Pressing its button again pauses or plays it.
    - When it ends, the next row of the list it was pressed in plays.
    - Starting any song SoundCloud can play ends it.
  - **No match:** the card says so and the preview plays.
  - **Doesn't reach YouTube:** the EQ and effects, speed and the output-device
    picker. Its audio plays through the Windows default device.
  - **Go+ subscribers:** SoundCloud gives a signed-in Go+ account full streams, so
    the card never shows up for them.

### Pages

- **Home (new design):** shelf tiles are bare rounded artwork, rows are soft
  panels, headings take the accent, genre chips use the tag style, hover keeps the
  cover bright with a small play button in the corner.
- **Profiles:** Find a track (searches the artist's whole catalogue through
  SoundCloud's API), Play all, Shuffle, a "You & <artist>" card from your listening
  stats (plays, this month, last played, your most-played tracks of theirs), "New"
  tags on tracks posted since your last visit, and a cleaner header. The tools sit
  on the banner, not in the tab bar.
- **Search:** filters as an icon list like the Library nav, plus two switches of
  the app's own (desktop only; each stays on for later searches until turned off).
  Both put a ranked block on top of SoundCloud's results, whose own list stays
  below (§7: a hidden lazy list loads forever).
  - **Best match:** SoundCloud's tracks for the query, re-ranked: the exact title
    first ("Artist - Title" and "artist title" count), then the whole phrase, then
    all the words; plays break ties; remixes, sped-up, covers and the like drop
    back unless the query asks for them.
  - **Lyrics:** a line you remember → Genius's site search names the song (fetched
    by the host through the WebView's own network stack, see §7) → its best
    SoundCloud upload is found the same way.
- **Notifications / messages / "…" menu:** same card style as the other menus.
  The "…" menu scrolls instead of running off small windows.

### Friends and Discord

- **Friends listening (Social/Settings):** everyone who has the app open and a track
  loaded, live (polled every 15 s from the friends server). Names come from the
  name set in Settings, else Discord, else the SoundCloud account.
- **Listen along:** follow someone's playback (same track, same spot, keeps
  following). Not while you're in a jam.
- **Jam** (Social, desktop only): a shared session like Spotify's Jam. One person
  starts it and gets a 6-character code; friends join with the code, or with
  **Join jam** on the host's row in Friends listening (a host can switch that off).
  The host's app plays: guests follow its song, play/pause and seeks, each change
  applied once so a guest pausing on their side isn't fought. Anyone in the jam
  adds songs to a shared queue (the **+** on any track row, right-click → Add to
  Jam, or "Add what's playing"), and the host's app plays the queue in order as
  songs end (or **Play now** / **Play next now**). A guest who plays something
  else for 8 s straight drops out of following and gets **Back to the jam**. A
  guest dropped by the server (PC asleep past 90 s) rejoins by itself, at most
  once in 5 minutes: joining hands out a new key, so the same account in one jam
  on two PCs would otherwise knock each other out forever. The
  server side is `/jam/*` in `proxy/friends-server.js`: a key per person, 50
  people, 100 queued songs, ends 10 min after the host's app goes quiet.
- **Discord Rich Presence:** what you're playing, progress and cover on your
  Discord profile. The status line can show the artist, the song, or
  "holdonquietlySC". Optional buttons, and it hides after 5 min paused.
- **Play in Discord:** asks the Quiet bot to play a track (per-row icon in each
  track's action row, and in the player bar). See PLAY-IN-DISCORD.md.
- **Share to Discord:** posts the current track to your webhook (kept locally in
  `webhook.txt`, never in the page or the repo).
- **Community feed:** short posts + shared tracks from other app users. A post's
  SoundCloud links open in the app; any other link opens in the browser.

### Stats and accounts

- **Listening stats:** counted by the app itself (SoundCloud has no history to
  read). Plays, time, top artists / tracks, all time or 30 days, plus a monthly
  **Recap** card you can save or share.
- **holdonquietly account (optional):** log in to holdonquietly.com and your stats
  and settings sync across PCs. The stats can come back if lost locally, and can show
  on your holdonquietly profile along with "Listening now". Not needed to use the app.
- **Last.fm scrobbling:** done by the host, so the login never touches the page.
- **Several SoundCloud accounts:** save logins and switch without logging out. Saved
  logins are DPAPI-sealed (`accounts\<name>.acct`), like the Last.fm and holdonquietly ones.

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
  the theme injected. No install. Your PC can pair to sign it in. It has its own
  phone layout, laid out like a phone app:
  - **Top bar:** logo, search, and (signed in) notifications, messages and you.
  - **Tab bar at the bottom:** Home, Feed, Library, Social (signed out: Home,
    Search, Social). Social opens the Social/Settings page.
  - **Floating player** above the tabs: cover in the play button with a progress
    ring, title and artist, previous, next, like and Discord. Swipe it to skip.
  - **Full-screen player** (tap the floating player): big cover, a seek bar you can
    drag, shuffle, previous, play, next, repeat, like, Discord, Share (the phone's
    share sheet) and Queue. The queue is SoundCloud's own "Next up" as a sheet.
    Title and artist take you to their pages. Swipe down to close.
  - Track rows are compact (cover with the play button on it, one row of actions),
    search filters are a row of chips, and artist pages, the classic track page and
    signed-in pages from SoundCloud's newer app (Home modules, track pages) are
    reflowed for the width. Mouse-only settings are hidden.
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
| `tools/build-userscript.js` | builds the phone versions into `dist/` from `preload.js` and the three files below |
| `tools/mobile.css` | the phone layout (top bar, tab bar, players, every page at phone width) |
| `tools/mobile-ui.js` | the phone UI: tab bar, floating player, full-screen player, queue |
| `tools/mobile-frame.css` | phone rules inside SoundCloud's newer-app frames (signed-in Home modules, track pages) |
| `tools/phone-preview.js` | headless Chrome at iPhone size on sc.holdonquietly.com with your local build swapped in (§6) |
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

A tiny Node server (`proxy/friends-server.js`, pm2 `hoq-friends` at
`/opt/hoq/server.js`, port 8790, behind nginx at `sc.holdonquietly.com/__hoq/fb`).
The app POSTs `/presence` and GETs `/friends` and `/feed`. People drop off after
5 min of silence. Jams live at `/jam/*`: POST `start`, `join`, `add`, `remove`,
`now` (host only), `leave`, `end`, and GET `/jam/state?code&id&key&v`, which holds
the request up to 20 s until something changes. The host app makes every call
(page → `jam:req:` / `jam:watch:`), like presence and the feed. Test copies never
post, unless `HOQ_BACKEND` points them at a local copy (§6). The phone versions have
no host: their page reads and posts the feed itself at `/__hoq/fb/feed` (the
shim's `__hoqFeedNet`; the server sends CORS `*`). Profile and track links in
presence, jams and posts must be soundcloud.com links (`scProfile`, `scUrl`).

### Go+ songs from YouTube

1. **Is it a preview?** `hoqGoTick()` (every 0.5 s) looks the song in the player bar
   up with api-v2 `/resolve` and the page's own sign-in (the `oauth_token` cookie).
   It's a preview when every stream is `snipped`; the track also gives `full_duration`
   and `publisher_metadata.artist`.
2. **Find it.** The page asks the host (`yt:search:{rid,q}` → `window.__hoqYtRes`).
   The host fetches YouTube's results page with a plain HTTPS request (§7) and
   reads its `ytInitialData`:
   - A video there is a `videoRenderer`, or, in the layout YouTube tries out on
     about 1 request in 6, a `lockupViewModel`. Both give the same fields.
   - It returns id, title, channel, length, badges and views.
   - An empty answer is asked once more.

   `hoqYtScore()` ranks the results.
3. **Play it.** A `youtube-nocookie.com/embed/<id>?enablejsapi=1` iframe in
   `#hoq-yt`, driven by YouTube's postMessage widget protocol, the one its own IFrame
   API script speaks:
   - The player sends `readyToListen`; the page answers `listening`.
   - The player then sends `onReady`, `infoDelivery` (time, length, state, title)
     and `onStateChange` / `onError`.
   - The page sends `command` messages: `playVideo`, `pauseVideo`, `seekTo`,
     `setVolume`.
4. **Hand control to YouTube.** SoundCloud's preview is paused. While `_yt` is set:
   - **Readers:** `playerProgress()` returns the YouTube player's state, and
     `hoqMediaNow()` replaces direct `__hoqMediaEl` reads.
   - **Controls:** `hoqSeek()` and `window.__hoqMedia()` go to it. Capture-phase
     listeners on `window` take SoundCloud's play button, seek bar and Space.
   - **Player bar:** the times and play icon come from a CSSOM rule, never DOM
     writes, so no page observer wakes four times a second.
5. **Stay out of its frame.** The host's preload wrapper skips youtube(-nocookie)
   frames.
6. **Songs SoundCloud refuses outright ("manual").** These never reach the player
   bar, so `hoqGoTick` can't see them.
   - **Catching the press:** `attachGoPress` (the page and the new-app frames)
     notes every play-button press.
     - A greyed-out button (`.sc-button-disabled`, title "Unavailable") is taken
       on the spot: `hoqGoManual(path, btn, true)`.
     - A press that opens the Go+ checkout instead comes back through the host:
       `IsGoAd` cancels the load, `GoAdBlocked` calls `window.__hoqGoAd`.
   - **What `_yt.manual` changes:**
     - `hoqYtSolo()` answers `currentNowPlaying()`, `npPublicUrl()` and
       `hoqNowHref()`.
     - `hoqGoPath()` reads the real bar through `hoqBarHref()`, so a song you start
       yourself is still noticed.
     - `html.hoq-yt-solo` lays the song over the bar's song slot.
     - At the end, `hoqGoNextBtn` presses the next play button in the list.
6. **Open links outside.** NewWindowRequested sends youtube.com links to the
   default browser.

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

pm2 `hoq-friends` runs `/opt/hoq/server.js` (DEPLOY.md is out of date on the name).
Back up the old file as `server.js.bak-<date>`, check the new one with
`node --check` (it must end in `.js`: Node won't check another extension), put it
in place, `pm2 restart hoq-friends --update-env`, `pm2 save`, then
`curl http://127.0.0.1:8790/health`. Its feed lives in `/opt/hoq/feed.json`.
From Windows use `C:\Windows\System32\OpenSSH\ssh.exe` / `scp.exe` with
`-i ~/.ssh/root_155_138_222_253_ballerina -p 2222`, and send multi-line commands
as a script file (PowerShell mangles quotes on the way to ssh).

---

## 6. Testing

- **Test copy:** build to a separate folder and start it with
  `HOQ_DATADIR=<folder>` (its own data, settings and logins) and
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 --mute-audio`.
  A test copy is silent toward the outside world: no Discord status, no friends
  list, no phone relay, no Last.fm, and it leaves the shared Discord webhook in the
  registry alone. It logs to `<folder>\scwv2.log`; the real app logs to `%TEMP%\scwv2.log`.
- **Friends, feed and jams on a test copy:** run a local friends server
  (`PORT=18790 node proxy/friends-server.js`) and start the copy with
  `HOQ_BACKEND=http://127.0.0.1:18790` too. Two copies (own `HOQ_DATADIR` and
  debug port each) make a host and a guest.
- **Logged-out copies can't play audio**: not even a real click on SoundCloud's own
  play button starts anything. To test playback logic (a jam's follow, pause and
  queue), put a stand-in player first in `<body>`: a `.playbackSoundBadge__titleLink`,
  a `.playControls__play` (class `playing` and title "Pause current" / "Play
  current") and the two `.playbackTimeline__*` times. The app reads the first match.
- **Go+ from YouTube on a test copy:** the same stand-in, with its title link on a
  Go+ track (e.g. `/szababy2/snooze-1`) and the button set to playing. YouTube's
  player really plays (muted by `--mute-audio`) once the page has had a click (CDP
  `Runtime.evaluate` with `userGesture`). `window.__hoqYtInfo()` shows the matches
  and the player's state.
- **Live app inspection:** start the real app with `--remote-debugging-port=9222`,
  then `node tools/cdp.js -e "<js>"` / `node tools/shot.js out.png`.
- **Phone layout:** `node tools/build-userscript.js`, then `node tools/phone-preview.js`
  (headless Chrome at 390x844 with an iPhone user agent, its own profile in the temp
  folder). It serves `dist/holdonquietly.proxy.js` in place of the live `/hoq.js`
  (`/mode?m=live` for the live one), so nothing is uploaded. Drive it over HTTP:
  `/nav?u=<url>`, `/shot?f=<name>` (PNGs next to its profile), `/tap?x=&y=`,
  `/size?w=&h=`, `POST /eval`, `/logs`. Signed out it can't play; to test signed
  in, start it once headed (`--headed`) and sign it in with a link from the
  app's Settings → Phone yourself, then run it headless on the same profile.
- **Sign-in by hand:** `HOQ_ACCOUNTS_NO_BROWSER=1` logs the holdonquietly.com sign-in
  link instead of opening a browser, so a test can call the loopback callback itself.
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
- **Phone: the hidden player bar still has to be laid out.** `hoqSeek()` presses
  SoundCloud's timeline, and squeezed to 0px wide every seek (and every lock-screen
  seek) landed on 0:00. `tools/mobile.css` keeps it at least 100px wide.
- **Phone: `.playControls__inner` has a (do-nothing) transform**, which makes it the
  box `position: fixed` is measured from. The queue sheet came out 12px tall
  inside the bar until the transform is dropped while the queue is open.
- **Phone: an iframe ignores top + bottom** and falls back to 150px tall. The newer
  app's track-page frame gets an explicit `100dvh` height minus the bars.
- **Phone: `recolorOrange()` repaints anything SoundCloud-orange inline**, our own
  accent-coloured elements included, and the inline colour sticks (a tab stayed
  lit, a heart stayed filled). The phone UI's elements are on its skip list.
- **Phone: inputs under 16px make iOS zoom the page** when you tap them.
- **Phone: the Social/Settings page is built the first time it opens**, which can
  be minutes after load. Anything the shim changes in it has to keep looking (the
  desktop-only sections reappeared when the page opened late).
- **A `display:` rule beats the `hidden` attribute.** An element styled
  `display: flex` stays on screen with `hidden` set; give it a
  `[hidden] { display: none }` rule (the Feed composer showed an empty box).
- **Feed posts carry links from strangers.** Opening one in the app window could
  show a look-alike sign-in page with no address bar: only SoundCloud links open
  in the app, the rest go to the browser, and the server keeps SoundCloud links only.
- **The updater swaps into the running exe's own name.** A browser saves a second
  download as `holdonquietly (1).exe`; a fixed name updated a file nobody launched.
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
- **Permission grants stick.** WebView2 saves what the host allows in the profile,
  and links open other sites in the main window. Only soundcloud.com gets the
  microphone (to unlock device names); mic grants older builds gave other sites are
  reset at startup.
- **The host can't reach the page at startup.** WebView2 begins on a blank document,
  so anything sent right after `Navigate` is lost. The page asks instead
  (`update:status` for the update toasts).
- **Never clear localStorage.** The stats and every setting live only there. "Fix
  blocked" clears cookies and caches, and the page drops just SoundCloud's own keys.
- **Mutation-driven work must ignore our own UI** (and the player's clock). A button
  rewriting itself every second kept the full-page clutter scan running all session.
- **SoundCloud's service worker takes over the page** about 10 s after load, and from
  then on requests come from it. A `WebResourceRequested` filter has to include the
  worker source kinds, or the ad blocking quietly stops ~10 s after every launch.
- **Guard every localStorage read that runs while preload loads.** On a sandboxed page
  it throws, and one throw stops the whole file: no titlebar on a frameless window.
- **A `catch { }` around P/Invoke hides a missing export forever.** The Start Menu
  shortcut called `InitPropVariantFromString`, an inline header helper rather than a
  propsys.dll export, so no shortcut was ever saved, and nothing said so.
- **Some sites refuse .NET's HTTPS client by its handshake.** Genius answers 403
  to `HttpClient` whatever the headers, and 200 to the browser. `BrowserGet` in
  Program.cs fetches through the WebView itself (`Network.loadNetworkResource`).
- **Build panel parts against the panel, not the page.** The Social panel is
  filled in before it's attached, so `document.querySelector` finds nothing then:
  the Jam card stayed empty until it rendered into the panel it was given.
- **Never hide SoundCloud's own result lists.** A hidden lazy list counts as
  scrolled to the bottom and loads page after page. Add above them instead.
- **YouTube's search answers a WebView fetch with "No results found".** The same
  URL through `BrowserGet` comes back empty (a `backgroundPromoRenderer`), filters
  or not. The host fetches it with its own `HttpClient`, which YouTube doesn't turn
  away. Genius is the other way round.
- **YouTube's embedded player has to be told someone is listening, after it says
  so.** It posts `readyToListen` first. A `listening` sent before that is lost, and
  taking `readyToListen` as the answer left the player silent forever.
- **The preload runs in every frame, including other sites' players.** Anything
  embedded gets the audio hooks and the theme unless the wrapper in Program.cs
  skips its host, as it does for youtube(-nocookie).com.
- **Read play state through `playerProgress()` / `hoqMediaNow()`.** Reading
  `__hoqMediaEl` directly reads SoundCloud's paused preview while YouTube plays a
  Go+ song.
- **A Go+ song you can't play never reaches the player.** SoundCloud gives no 30-s
  preview to start from: the play button is greyed out, or opens its checkout. Any
  feature that waits for the player bar never sees it, so catch the press instead.
  A signed-out test copy shows the greyed-out case. It won't load songs into the
  bar after a while either, so test the "you started another song" side with the
  stand-in bar.
- **An empty player-bar link isn't a new song.** SoundCloud redraws the bar, and
  one tick without a link stopped the YouTube song mid-play and brought a closed
  card back. Only a bar that stays empty for 5 s counts.
- **Logged-out test copies get sent to checkout.soundcloud.com/go** when a
  major-label song is opened, and then the test runs against that page. Use free
  uploads in tests (policy `ALLOW`), and start from the full
  `https://soundcloud.com/...` URL.

---

## 8. Open items

- **Jam, Best match, Lyrics and Go+ from YouTube are desktop only.** The phone
  builds have no host app for the jam server, Genius or YouTube's search, and
  SoundCloud's API doesn't answer the proxy's origin for the search.
- **Pick up where you left off** is switched off: jumping back the moment a song
  starts stalled playback on signed-in accounts. The position is still saved.
- **holdonquietlySC bot** shows offline in Discord because nothing signs in as it.
  Rich Presence only uses the app ID. Making it online needs a small always-on bot
  with its token on the server.
- **Go+ tracks** play in full on SoundCloud only with a Go+ subscription. The app
  doesn't get around that: it plays the song's YouTube upload in YouTube's own
  player instead (§3). YouTube's rules keep that player on screen (at least
  200×200, no hidden background player), so it's a card, not invisible. SoundCloud's
  Go+ checkout never loads in the app (`IsGoAd`), so subscribing to Go+ has to happen
  in a browser. Like a
  browser tab, it keeps playing if you minimize the app or switch to the compact
  player.
