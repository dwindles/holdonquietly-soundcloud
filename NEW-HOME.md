# The new Home page

In November 2026 SoundCloud moved **Home** (`/discover`) onto their new app.
It no longer renders as classic page markup. It's a same-origin iframe inside the
classic shell, so the header, player and right sidebar are still the old page
and keep their old theme. Only the Home content changed.

```
classic page (top frame)                      themed by BASE_CSS (classic selectors)
└─ .l-main
   └─ iframe.webiEmbeddedModuleIframe         src=/n/embeds/home-sdui?...
      └─ <html class="hoq-webi sc-coverbg">   our classes, mirrored in by themeFrames()
         └─ [aria-label="Home"]               every Home section lives in here
```

`themeFrames()` (top frame, runs every second) injects `BASE_CSS + MUI_CSS`
into every same-origin iframe, copies the accent variables across
(`--sc-accent`, `--sc-accent-bg`, `--sc-accent-ch`, `--wave-color`) and tags the
frame's `<html>` with `hoq-webi`. **All Home rules are in `MUI_CSS`, scoped
`html.hoq-webi [aria-label="Home"]`.**

## What's styled, and how to find it

SoundCloud's own class names on this page are generated (`mui-1hziaow`) and
change with every deploy. Don't use them. Use MUI's stable `Mui*` classes,
`aria-label`s, and the `sizes` attribute on the artwork images, which says what
kind of tile you're looking at:

| Element | Selector | Look |
| --- | --- | --- |
| Section headings | `h2.MuiTypography-root` | accent mixed with white, soft accent glow (like the classic page headings) |
| Shelf tiles (More of what you like, mixes, albums) | `.MuiCard-root:has(img[sizes*="200px"])` | no box. Rounded art, grey caption, title in the accent |
| Compact rows (Trending by genre, Liked by people you follow) | `.MuiCard-root:has(img[sizes="48px"])` | soft panel. Their grid gets `row-gap: 10px` (SoundCloud ships 0) |
| Quick-pick row (Your likes, Related tracks) | `.MuiCard-root:has(img[sizes="64px"])` | soft panel |
| Feature cards (Hot For You, Your Favorites, reposts) | any other `.MuiCard-root` | soft panel |
| Genre chips | `.MuiChip-root` (`.MuiChip-filled` when picked) | the `.sc-tag` look ("# Trap") |
| "New release" cards | `li:has(img[sizes="320px"]) > div > div:last-child` | that layer is SoundCloud's orange-pink-purple brand gradient. Repainted with the accent |
| Tile hover | `.entity-card__play-overlay`, `.entity-card__play-button` | light gradient at the bottom, 40px play button in `--sc-accent-bg`, pinned bottom-right |

"Soft panel" = `rgba(255,255,255,.04)` fill, `rgba(255,255,255,.06)` border,
12px radius, no blur, no accent border.

## Things that bit

- **The generic card rule.** `MUI_CSS` gives every `.MuiCard-root` an
  accent-tinted border (it was written for the new track page's sidebar). On Home,
  that boxed all 127 cards. The Home rules override it.
- **Double scrim.** `html.sc-coverbg body::before` is the cover vignette. The
  frame gets `sc-coverbg` mirrored in, so it drew the vignette a second time,
  making a darker rectangle exactly the size of the Home frame.
  `html.hoq-webi.sc-coverbg body::before { display: none }` stops it.
- **Hover lift.** Lifting only the artwork left the play overlay behind, and its
  bottom 3px stuck out under the cover. The lift, radius and shadow go on the box
  that holds both: `div:has(> .entity-card__play-overlay)`.
- **SoundCloud's own hover motion** slides the play button in from below.
  Left alone, it sat half off the cover. All `transform`/`translate` on the overlay,
  its `span` and `.entity-card__play-button` is cancelled.
- **Wrappers in the top frame.** Anything in `.l-main` that contains a
  `webi*` iframe is forced transparent, so nothing lays a shade over the cover
  background.

## Testing it

The Home frame only exists when you're signed in, and opening
`/n/embeds/home-sdui` directly without a login gives a 404. Two ways:

1. **A saved copy.** In the app, DevTools → right-click the frame's `<html>` →
   Copy outerHTML → save it. Load it in headless Edge and inject the current
   `MUI_CSS`. Two gotchas: SoundCloud's scripts reload and strip our `<html>`
   classes, so add `hoq-webi sc-coverbg` back before injecting. And cards have a
   0.14s transition, so wait about a second before reading styles or taking a
   screenshot.
2. **The live app.** Start it with
   `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`, then
   `node tools/cdp.js -e "<js>"` to inspect and `node tools/shot.js out.png` for a
   screenshot. Hover can be tested with a CDP `Input.dispatchMouseEvent` over a tile.

The phone version (`dist/holdonquietly.proxy.js`) carries the same CSS. Rebuild
with `node tools/build-userscript.js` and copy it to the server
(`/var/www/hoq/holdonquietly.proxy.js`) after a change here.
