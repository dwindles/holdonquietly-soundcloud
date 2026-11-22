<h1><img src=".github/icons/star.svg" width="26" align="absmiddle" alt=""> holdonquietly</h1>

my soundcloud app for windows. no window frame, the whole thing recolours to whatever song ur playing, n it plays the major label tracks other soundcloud apps cant

it runs on webview2, which is basically edge inside an app. edge comes w the drm stuff (widevine n playready) those tracks need, thats why they play here n not in a normal electron app

## heads up

i didnt perfectly understand everything about this app while making it, so some of it was vibe coded (built w ai). i use it every day n it works, but if something in the code looks off thats probably why. if u find a bug open an issue n ill look at it

## install

grab **`holdonquietly.exe`** from [releases](../../releases/latest) n run it. its 1 file, no installer, n .net is built in. it updates itself after that

u need the [webview2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/), which windows 11 n most windows 10 pcs already have

> its not signed so smartscreen flags it the first time. click **more info** then **run anyway**, or right click the exe, go to properties n tick unblock

## what it does

- **colours from the cover:** the app recolours to the 2 main colours of the cover art, or u pick ur own
- **visualizer:** the seek bar turns into a waveform that moves w the actual audio, n custom waveform bars draw over the track
- **drm tracks:** monetized n major label songs actually play
- **discord rich presence:** whats playing shows on ur discord profile w the progress n cover
- **friends feed:** see what other people using the app are listening to, live
- **last.fm scrobbling:** the app does it itself so ur login never touches the page
- **more than 1 account:** save soundcloud logins n switch between them without logging out (theyre saved encrypted)
- **share to discord:** send the song ur on to a webhook, once per song
- **compact player:** a small always on top player
- **listening stats:** ur plays n listening time, counted by the app
- **updates itself:** checks for a new release when it opens n swaps itself on restart
- **ad block:** blocks ad n tracker sites, mutes soundclouds audio ads, n can load ublock too (see below)

## everything

the whole app in 1 doc, every feature, how its built, how to ship it, n the stuff that broke before: [GUIDE.md](GUIDE.md)

## how its built

pretty much the whole app is 2 files

| file | what it does |
|---|---|
| `Program.cs` | the c# side: the frameless window around webview2, the window buttons, blocking ad sites, pulling colours from the cover, discord, the friends n last.fm stuff, webhook posts |
| `preload.js` | everything on the page. it loads before soundclouds own scripts n builds all the custom ui: themes, visualizer, waveforms, title bar, panels |

plus `Updater.cs` (updates from github releases), `HoqAccount.cs` (the optional holdonquietly.com account), `LastFm.cs` (scrobbling), `Desktop.cs` (the song pop up n taskbar buttons) n `ShortcutHelper.cs` (so windows media controls know its holdonquietly)

`preload.js` doesnt edit soundclouds react dom cuz that breaks the page the next time react redraws. icons get swapped w css `mask-image`, n it only touches stuff the app added itself

### build

```powershell
git clone https://github.com/dwindles/holdonquietly-soundcloud.git
cd holdonquietly-soundcloud
dotnet build -c Release
bin\Release\net9.0-windows\holdonquietly.exe
```

1 file to hand out:

```powershell
dotnet publish SoundCloudWV2.csproj -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o dist
```

## ad block

the app blocks a list of ad n tracker sites by itself n mutes soundclouds audio ads. on top of that it can load an unpacked chromium ad blocker from `extensions/` next to the exe. thats not in this repo, so drop a [ublock origin](https://github.com/gorhill/uBlock) build in `extensions/holdonquietly-blocker/` if u want it. without it everything still works

## notes

Not affiliated with, endorsed by, or sponsored by SoundCloud. "SoundCloud" is a trademark of SoundCloud Ltd. This is an independent app that shows soundcloud.com.

made by **[dwindles](https://github.com/dwindles)**
