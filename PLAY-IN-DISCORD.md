# Play in Discord — send the current track to Quiet

A floating button in the app that asks the **Quiet** Discord bot to queue whatever
you're listening to. Sits above the existing "Share to Discord" button and reuses
its styling and payload.

Share posts an embed that *announces* a track. This one asks the bot to *play* it.

---

## How it gets there

There is no HTTP endpoint and no open port. The app already posts host-side to a
private Discord webhook, and the bot is already sitting in that channel — so a
play request is just a webhook post carrying a marker the bot recognises.

```
preload.js                Program.cs                    Discord              Quiet bot
──────────                ──────────                    ───────              ─────────
#hoq-playbtn click
  → scPost('playreq:…') → PostWebhook(json, play:true)
                           footer = "hoq-play"        → webhook message   → hoqPlayRequest.js
                                                                             reads embed.url
                                                                             → queues it
```

The webhook URL lives in `%LocalAppData%\SoundCloudApp\webhook.txt` and is never
in the page or the repo, same as Share. The POST is host-side because Discord
webhook endpoints send no CORS headers.

---

## The three pieces

### 1. `preload.js` — `startPlayButton()`

Renders `#hoq-playbtn`, started from the same place as the share button:

```js
startShareButton(); // floating "Share to Discord" button → posts current track to webhook
startPlayButton();  // floating "Play in Discord" button → asks the bot to queue it
```

- Reuses `shareCurrentSong()` for the payload and `currentNowPlaying()` for state.
- **Requires a real track link.** A title alone is no use to the bot, so if
  `payload.url` is empty the button flashes *No track link* and sends nothing.
- One request per track: locks to **Queued** until the song changes, tracked in
  `_hoqLastQueued` (in memory, so it also resets on restart).
- Positioned at `bottom:146px`, directly above Share at `bottom:96px`.

### 2. `Program.cs` — `PostWebhook(json, play = false)`

```csharp
if (m != null && m.StartsWith("playreq:")) { await PostWebhook(m.Substring(8), true); return; }
```

Same embed as a share, with two differences when `play` is true:

| Field | Share | Play request |
| --- | --- | --- |
| `footer.text` | `via holdonquietly` | **`hoq-play`** |
| `author.name` | `<name> shared a track` | `<name> wants to play this` |

The footer is the marker. Nothing else about the payload changes.

### 3. Bot — `src/events/messageCreate/hoqPlayRequest.js`

Acts only when **all** of these hold:

- the message came from a webhook (`message.webhookId`)
- it has an embed whose `footer.text` is exactly `hoq-play`
- `embed.url` is an `http(s)` URL

Then it resolves a voice channel, queues the track, and posts the normal
now-playing or added-to-queue card.

---

## Which voice channel it plays into

In order:

1. **The requester's channel** — matched from the embed author against guild
   members by display name or username.
2. **Wherever the bot is already connected** — covers the common case of you
   already listening in Discord.
3. **Neither** → it replies that nobody is in a VC and does nothing else.

A matched member becomes the track's `requester`, so skip permissions and
vote-skip behave exactly as they would for a `/play`. An unmatched name still
queues, just unattributed (anyone can skip it).

---

## Setup

1. `%LocalAppData%\SoundCloudApp\webhook.txt` → a webhook URL for a channel the
   **bot can read**. If Share already works, this is done.
2. The bot needs `View Channel` + `Read Message History` on that channel.
3. Rebuild the app — see below.

---

## Rebuilding

`preload.js` is an **embedded resource**, and the footer marker is written
host-side in `Program.cs`, so a preload-only edit is not enough:

```powershell
Get-Process holdonquietly -EA SilentlyContinue | Stop-Process -Force
dotnet build -c Release
```

The exe is locked while running — kill it first or the build fails.

---

## Gotchas

- **The marker is the whole security model.** Only webhook messages with footer
  `hoq-play` are acted on, so an ordinary member cannot trigger playback by
  posting a lookalike embed. If you change that string, change it in both
  `Program.cs` and `hoqPlayRequest.js` or requests silently stop working.
- **Personalised SoundCloud links don't resolve.** URLs like
  `soundcloud.com/discover/sets/personalized-tracks::user:id` 404 for play-dl,
  yt-dlp and the SoundCloud API alike — they only work inside a logged-in
  browser session. Share a normal track link.
- **Silence is by design.** Every failure path (no embed, wrong footer, bad URL)
  returns without a message, because the handler sees every webhook post in the
  channel. Only a genuine request with nowhere to play produces a reply.
- **Display-name matching is best-effort.** Two members with the same display
  name resolve to whichever the member cache returns first. It only affects
  attribution, never whether the track plays.

---

## Verifying

```powershell
dotnet build          # 0 errors (CS1998 at Program.cs:462 is pre-existing)
node --check preload.js
```

Bot side: `scratchpad/test_hoqplay.js` — 13 checks covering every ignore path
(non-webhook, ordinary share, missing footer, bad URL, no embed), requester
attribution, and the no-VC case.
