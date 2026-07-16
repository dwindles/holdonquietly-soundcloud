<h1><img src=".github/icons/star.svg" width="26" align="absmiddle" alt=""> holdonquietly</h1>

A SoundCloud desktop client for Windows. Frameless, fully themed, and it plays the
major-label tracks other wrappers choke on.

It runs on WebView2 — Edge's engine ships a provisioned Widevine/PlayReady stack,
which is the only reason DRM'd tracks decode here at all. Stock Electron can't.

---

## <img src=".github/icons/planet.svg" width="18" align="absmiddle" alt=""> Install

Download **`holdonquietly.exe`** from [Releases](../../releases/latest) and run it.
One file. No installer, no dependencies — the .NET runtime is baked in. It updates
itself from then on.

Requires the [Evergreen WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/)
(already present on Windows 11 and most Windows 10).

> <img src=".github/icons/caution.svg" width="15" align="absmiddle" alt=""> Unsigned indie build — SmartScreen will flag it on first run. **More info → Run anyway**, or right-click the exe → Properties → Unblock.

## <img src=".github/icons/biohazard.svg" width="18" align="absmiddle" alt=""> What it does

- **Cover-matched theming** — the whole UI recolors to the two dominant colours of the
  current artwork, or pin your own accent from the palette.
- **Live visualizer** — the seek bar becomes a waveform driven by the real audio signal
  (Web Audio, MSE sources only); custom bar-waveforms render over the track.
- **DRM playback** — monetized / major-label tracks actually decode.
- **Discord Rich Presence** — now-playing on your profile, real progress, cover art.
- **Friends feed** — what other holdonquietly users are playing, live.
- **Last.fm scrobbling** — done host-side; credentials never touch the page.
- **Multi-account** — save and hot-swap SoundCloud sessions without logging out.
- **Share to Discord** — push the current track to a webhook, once per track.
- **Silent auto-update** — checks Releases on launch, swaps itself on restart.
- **Ad-block** — optional, local (see below).

## <img src=".github/icons/helix.svg" width="18" align="absmiddle" alt=""> How it's built

Two files carry effectively the whole app.

| file | role |
|---|---|
| `Program.cs` | C# host. Frameless WPF window around WebView2, window controls, network ad-host blocking, cover colour extraction, Discord IPC, the friends/Last.fm bridges, webhook posting. |
| `preload.js` | Everything page-side. Injected before SoundCloud's own scripts; builds the entire custom UI — themes, visualizer, waveforms, titlebar, panels. |

Plus `Updater.cs` (GitHub-Releases self-update), `LastFm.cs` (host-side scrobbler),
`ShortcutHelper.cs` (Windows media identity).

`preload.js` never mutates SoundCloud's React DOM — doing so tears the tree apart on
the next reconcile. Icons are swapped with CSS `mask-image`; only our own injected
elements get touched.

### Build

```powershell
git clone https://github.com/dwindles/holdonquietly-soundcloud.git
cd holdonquietly-soundcloud
dotnet build -c Release
bin\Release\net9.0-windows\holdonquietly.exe
```

Distributable single file:

```powershell
dotnet publish SoundCloudWV2.csproj -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o dist
```

## Ad-block

The app loads an unpacked Chromium ad-blocker from `extensions/` beside the exe.
It isn't vendored here — drop an [uBlock Origin](https://github.com/gorhill/uBlock)
build into `extensions/holdonquietly-blocker/`. Without it everything still runs;
SoundCloud's own audio ads are muted separately.

## Notes

Not affiliated with, endorsed by, or sponsored by SoundCloud. "SoundCloud" is a
trademark of SoundCloud Ltd. This is an independent client that renders soundcloud.com.

Made by **[dwindles](https://github.com/dwindles)**.
