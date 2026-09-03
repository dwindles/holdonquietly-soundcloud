# holdonquietly — feature ideas

Brainstorm list (from the ideasschoq.txt ask). Grouped by effort. Nothing here
is built yet except where noted; this is a menu to pick from.

## Quick wins (an evening each)
- **Sleep timer** — "stop after this track" / "in 20/30/60 min", set from the
  player bar or palette. Pause playback + optionally quit.
- **Now-playing mini view** — a compact always-on-top window (WPF child window)
  showing art + title + transport, for when the main window is behind others.
- **Global media keys** — make sure play/pause/next/prev hardware keys work even
  when unfocused (register OS media-transport controls in the host).
- **Copy/share improvements** — "copy track link", "copy embed", "copy artwork
  URL" already partly there; add "copy as Markdown" and "download artwork".
- **Queue tools** — "clear played", "shuffle rest", "save queue as playlist".
- **Keyboard shortcuts sheet** — a `?` overlay listing shortcuts; add j/k/l,
  number-seek, L to like, etc.

## Medium (a weekend)
- **Bulk playlist tools** — add/remove/reorder/dedupe many tracks at once.
  (Bulk-add is being built now — see the palette.) Natural follow-ups:
  de-dupe a playlist, remove dead/blocked tracks, sort by plays/date.
- **Last.fm scrobbling** — scrobble now-playing to a Last.fm account (token in
  settings). Pairs well with the existing stats tick.
- **Discord Rich Presence** — show the current track as your Discord status
  (the widget project already does presence; reuse that pattern here).
- **Lyrics panel** — a side panel that pulls time-synced lyrics (LRCLIB is free,
  no key) and highlights the current line against the waveform.
- **Focus / ambient fullscreen** — a "now playing" fullscreen mode: big art, the
  visualizer, the new ambient glow, minimal chrome — a screensaver you can play.
- **Per-artist saved themes** — remember a chosen accent per artist/profile so a
  favourite artist always themes the app their way.

## Bigger (a real project)
- **Update-blocking / version pinning** — keep the app on a known-good SoundCloud
  bundle so a SoundCloud deploy can't break the theme. This is genuinely hard and
  risky (see notes in the update-blocking work); a safer middle path is a
  "theme health check" that detects when key selectors vanish and warns you,
  plus fast selector fallbacks, rather than freezing SoundCloud's own JS.
- **Offline cache of liked tracks** — for your own uploads / allowed tracks,
  cache audio for offline play (respect what's downloadable).
- **Local library backup** — export likes / playlists / following to JSON on a
  schedule, so nothing's lost if an account goes sideways.
- **Cross-fade / gapless** — real cross-fade between queue items (needs tapping
  the audio graph; non-trivial in a WebView).

## Polish ideas
- Ambient glow intensity slider (currently one fixed level).
- Ambient "source" option: accent-only vs sampled-from-cover palette (2–3 colors).
- Let the visualizer react to real audio (Web Audio analyser) instead of the seek
  bar, when playing your own/allowed streams.
