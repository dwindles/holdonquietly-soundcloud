<h1 align="center">🎧 holdonquietly</h1>

<p align="center">
  <b>A beautiful, fully-themed SoundCloud desktop client for Windows — SoundCloud, evolved.</b><br>
  <sub>Native window · real DRM playback · live audio visualizer · custom themes · Discord Rich Presence · Last.fm scrobbling · auto-updating</sub>
</p>

<p align="center">
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%2010%2F11-0b0b0c">
  <img alt="tech" src="https://img.shields.io/badge/built%20with-C%23%20%2B%20WebView2-512bd4">
  <img alt="dotnet" src="https://img.shields.io/badge/.NET-9.0-512bd4">
  <img alt="status" src="https://img.shields.io/badge/auto--update-enabled-ff5500">
</p>

---

## What is holdonquietly?

**holdonquietly** is a hand-crafted **desktop app for SoundCloud** — think of it as a *SoundCloud v2*. It wraps SoundCloud in a frameless, blurred-acrylic native Windows shell and layers on the features the website never had: a reactive audio visualizer, one-click cover-matched color themes, a custom waveform on every track, Discord Rich Presence, Last.fm scrobbling, a friends-listening feed, and more — all while playing **major-label / DRM-protected tracks that other desktop wrappers can't** (it runs on Microsoft's WebView2 engine, which ships a fully-provisioned Widevine/PlayReady stack).

> If you've ever wanted a real **SoundCloud desktop app** for Windows that looks and feels like a first-class music player instead of a browser tab — this is it.

## ✨ Features

- 🎨 **Cover-matched theming** — the whole UI recolors to the two dominant colors of the current track's artwork (or pick your own accent from a built-in palette).
- 🌊 **Live audio visualizer** — the seek bar becomes a flowing glow-waveform that reacts to the real audio signal, and a custom bar-waveform renders over every track.
- 🖼️ **Frameless acrylic UI** — blurred glass top/bottom bars, mac-style window controls, custom overlay scrollbar, 3D tilt on tiles and cover art.
- 🔒 **Real DRM playback** — plays the monetized / major-label tracks that break on stock Electron wrappers.
- 🟣 **Discord Rich Presence** — shows what you're listening to on your Discord profile, with real progress + cover art.
- 📡 **Friends feed** — see what your friends on holdonquietly are playing right now.
- 🎵 **Last.fm scrobbling** — scrobble everything you play, host-side (your credentials never touch the page).
- 👥 **Multi-account switcher** — save and hot-swap multiple SoundCloud logins.
- 🛡️ **Optional ad-blocking** — bundle a local blocker extension (see below).
- 🔔 **Media integration** — hooks into the Windows "now playing" flyout.
- ⬆️ **Silent auto-update** — the app checks GitHub Releases on launch, downloads new versions in the background, and installs them on restart.

## 🚀 Install

1. Download the latest **`holdonquietly.exe`** from the [**Releases**](../../releases/latest) page.
2. Run it. That's it — the single `.exe` is fully self-contained (the .NET runtime and all UI are embedded).
3. From then on it **auto-updates itself** silently.

> **Requirements:** Windows 10/11 with the [Evergreen WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (already preinstalled on Windows 11 and most Windows 10).

<sub>⚠️ Because the app is a new, unsigned indie build, Windows SmartScreen / Smart App Control may warn on first run. Choose **More info → Run anyway**, or right-click the exe → **Properties → Unblock**.</sub>

## 🛠️ Build from source

```powershell
git clone https://github.com/dwindles/holdonquietly-soundcloud.git
cd holdonquietly-soundcloud
dotnet build -c Release
# run:
bin\Release\net9.0-windows\holdonquietly.exe
```

Produce a distributable single-file exe:

```powershell
dotnet publish SoundCloudWV2.csproj -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o dist
```

## 🧱 How it's built

Two files carry the whole app:

| File | Role |
|------|------|
| `Program.cs` | The C# host — a frameless WPF window hosting **WebView2**, window controls, ad-host blocking, cover-color extraction, Discord IPC, the friends/Last.fm bridges, and the auto-updater. |
| `preload.js` | Everything page-side — injected before SoundCloud's own scripts, it builds the entire custom UI (themes, visualizer, waveforms, titlebar, panels) **without ever mutating SoundCloud's React DOM**. |

Plus `Updater.cs` (silent GitHub-Releases auto-update), `LastFm.cs` (host-side scrobbler), and `ShortcutHelper.cs` (Windows media identity).

## 🧩 Ad-blocking (optional)

The app can load a local Chromium ad-block extension from an `extensions/` folder beside the exe. It's **not** included in this repo — grab [uBlock Origin](https://github.com/gorhill/uBlock) and drop its unpacked build into `extensions/holdonquietly-blocker/`. Without it the app runs fine (SoundCloud's own audio-ads are muted separately).

## 📄 License & credits

Made by **[@devuandoru](https://soundcloud.com/)**. Not affiliated with, endorsed by, or sponsored by SoundCloud — "SoundCloud" is a trademark of SoundCloud Ltd. This is an independent client that renders soundcloud.com. Bundled ad-block, if used, is uBlock Origin (GPLv3).

---

<p align="center"><sub>SoundCloud desktop client · SoundCloud for Windows · SoundCloud player app · themed SoundCloud · SoundCloud v2</sub></p>
