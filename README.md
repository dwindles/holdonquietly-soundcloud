<h1><img src=".github/icons/star.svg" width="26" align="absmiddle" alt=""> holdonquietly</h1>

a soundcloud app for windows. no window frame, the colours follow the song ur playing, n it plays the major label tracks other soundcloud apps cant

it runs on webview2, which is edge inside an app. edge comes w the drm parts (widevine n playready) those tracks need, thats why they play here n not in a normal electron app

## install

grab **`holdonquietly.exe`** from [releases](../../releases/latest) n run it. its one file, no installer, n .net is built in. it updates itself after that

it needs the [webview2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/), which windows 11 n most windows 10 pcs already have

> its not signed, so smartscreen flags it the first time. click **more info**, then **run anyway**, or right click the exe, go to properties n tick unblock

## what it does

- **colours from the cover:** the whole app recolours to the 2 main colours of the cover art, or u pick ur own accent
- **visualizer:** the seek bar turns into a waveform that moves w the real audio (web audio, mse sources only), n custom bar waveforms draw over the track
- **drm tracks:** monetized n major label songs actually play
- **discord rich presence:** whats playing shows on ur profile w the progress n cover art
- **friends feed:** see what other holdonquietly users are listening to, live
- **last.fm scrobbling:** done by the app itself, so ur login never touches the page
- **more than 1 account:** save soundcloud logins n swap between them without logging out
- **share to discord:** send the current song to a webhook, once per song
- **updates itself:** checks releases when it opens n swaps itself on restart
- **ad block:** optional n local, see below

## everything

the whole app in 1 doc (every feature, how its built, how to ship it, the traps): [GUIDE.md](GUIDE.md)

## how its built

nearly the whole app is 2 files

| file | what it does |
|---|---|
| `Program.cs` | the c# side: the frameless wpf window around webview2, the window buttons, blocking ad hosts, pulling colours from the cover, discord ipc, the friends n last.fm bridges n webhook posts |
| `preload.js` | everything on the page. it loads before soundclouds own scripts n builds the custom ui: themes, visualizer, waveforms, title bar n panels |

plus `Updater.cs` (updates from github releases), `LastFm.cs` (scrobbling) n `ShortcutHelper.cs` (so windows media controls know its holdonquietly)

`preload.js` never edits soundclouds react dom, cuz that breaks the page the next time react redraws. icons get swapped w css `mask-image`, n only the elements the app adds itself get touched

### build

```powershell
git clone https://github.com/dwindles/holdonquietly-soundcloud.git
cd holdonquietly-soundcloud
dotnet build -c Release
bin\Release\net9.0-windows\holdonquietly.exe
```

one file to hand out:

```powershell
dotnet publish SoundCloudWV2.csproj -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o dist
```

## ad block

the app loads an unpacked chromium ad blocker from `extensions/` next to the exe. its not in this repo, so drop a [ublock origin](https://github.com/gorhill/uBlock) build into `extensions/holdonquietly-blocker/`. without it everything still works, n soundclouds own audio ads get muted separately

## notes

Not affiliated with, endorsed by, or sponsored by SoundCloud. "SoundCloud" is a trademark of SoundCloud Ltd. This is an independent app that shows soundcloud.com.

made by **[dwindles](https://github.com/dwindles)**
