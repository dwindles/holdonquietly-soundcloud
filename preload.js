// Preload runs in the SoundCloud page context. It:
//  - injects a slim custom titlebar (SoundCloud wordmark + palette + window btns)
//  - injects a color / gradient picker that recolors SoundCloud's orange accent
//  - hides clutter (GO MOBILE, footer legal links, upsell / cookie popups)
//  - styles the scrollbar
// Window controls talk to the main process over IPC (exposed via contextBridge).

// WebView2 injects this whole file before page scripts (CSP-exempt), so code
// here runs directly in the page's main world. Window controls + drag talk to
// the C# host via window.chrome.webview.postMessage.
function scPost(cmd) {
  try { window.chrome.webview.postMessage(cmd); } catch (e) {}
}

// --- Anti-bot-detection (does NOT clobber chrome.webview) ---
(() => {
  try { Object.defineProperty(navigator, 'webdriver', { get: () => false }); } catch (e) {}
  try { if (window.chrome && !window.chrome.runtime) window.chrome.runtime = {}; } catch (e) {}
  try {
    const orig = navigator.permissions && navigator.permissions.query;
    if (orig) navigator.permissions.query = (p) =>
      p && p.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : orig(p);
  } catch (e) {}
})();

// --- Audio-ad killer: hooks the media engine (SoundCloud uses detached media
// objects, not <audio> in the DOM), detects adswizz ads, mutes + fast-forwards. ---
(() => {
  if (window.__scAdKiller) return; window.__scAdKiller = true;
  var media = new Set();
  function watch(el){ if (el.__scWatched) return; el.__scWatched = true; }
  // --- Custom volume: our own 0..1 level applied to every media element ---
  var vol = parseFloat(localStorage.getItem('scVol'));
  if (isNaN(vol)) vol = 1;
  window.__scGetVolume = function(){ return vol; };
  window.__scSetVolume = function(v){
    v = Math.max(0, Math.min(1, v)); vol = v;
    try { localStorage.setItem('scVol', String(v)); } catch(e){}
    media.forEach(function(el){ try { el.volume = v; el.muted = v <= 0; } catch(e){} });
  };
  try {
    var P = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function(){ media.add(this); watch(this); try { this.volume = vol; } catch(e){} return P.apply(this, arguments); };
  } catch(e){}
  try {
    var A = window.Audio;
    if (A) { window.Audio = function(){ var el = new A(arguments[0]); media.add(el); return el; }; window.Audio.prototype = A.prototype; }
  } catch(e){}
  function badge(on){ var b = document.getElementById('sc-ad-badge'); if (b) b.style.display = on ? 'block' : 'none'; }
  function apply(mute, rate){ media.forEach(function(el){ try { el.muted = mute; el.playbackRate = rate; } catch(e){} }); }
  var AD_SRC = /adswizz|doubleclick\.net|googlesyndication/i;
  function isAd(){
    try {
      var hit = false;
      media.forEach(function(el){ if (!el.paused && AD_SRC.test(el.currentSrc || '')) hit = true; });
      if (hit) return true;
      var pc = document.querySelector('.playControls');
      if (/\bm-ad\b|advertisement/i.test((pc && pc.className) || '')) return true;
    } catch(e){}
    return false;
  }
  var active = false, force = 0;
  setInterval(function(){
    var ad = isAd();
    if (ad || force > 0){
      apply(true, 16);
      if (!active && ad){ active = true; badge(true); }
    } else if (active){ active = false; apply(false, 1); badge(false); }
    if (force > 0){ force--; if (force === 0 && !ad){ apply(false, 1); badge(false); } }
  }, 350);
  document.addEventListener('sc-kill-ad', function(){ force = 16; badge(true); });
})();

const TITLEBAR_H = 34; // px

window.scDesktop = {
  minimize: () => scPost('win:minimize'),
  maximize: () => scPost('win:maximize'),
  close: () => scPost('win:close'),
  reset: () => scPost('app:reset'),
};

// Resize the frameless window by dragging near its edges (WebView2 covers the
// window edges, so WPF can't resize — we detect edges and trigger native resize).
function setupResize() {
  if (window.top !== window) return;
  const EDGE = 6;
  const curFor = {
    top: 'ns-resize', bottom: 'ns-resize', left: 'ew-resize', right: 'ew-resize',
    topleft: 'nwse-resize', bottomright: 'nwse-resize', topright: 'nesw-resize', bottomleft: 'nesw-resize',
  };
  const dirAt = (x, y) => {
    let d = '';
    if (y <= EDGE) d += 'top'; else if (y >= innerHeight - EDGE) d += 'bottom';
    if (x <= EDGE) d += 'left'; else if (x >= innerWidth - EDGE) d += 'right';
    return d;
  };
  let edged = null;
  window.addEventListener('mousemove', (e) => {
    const d = dirAt(e.clientX, e.clientY);
    if (d && d !== edged) {
      document.documentElement.style.setProperty('cursor', curFor[d], 'important');
      edged = d;
    } else if (!d && edged) {
      document.documentElement.style.removeProperty('cursor');
      edged = null;
    }
  }, true);
  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest && e.target.closest('.sc-tb-btn, .sc-light')) return; // let window buttons work
    const d = dirAt(e.clientX, e.clientY);
    if (d) { e.preventDefault(); e.stopPropagation(); scPost('win:resize:' + d); }
  }, true);
}

// ---------------------------------------------------------------------------
// Base stylesheet (clutter removal + scrollbar + accent hooks + titlebar offset)
// ---------------------------------------------------------------------------
// The app logo, inlined. It used to load from the holdonquietly.app virtual
// host, but soundcloud.com's CSP blocks that origin outright, so every place
// the logo appeared (tab header, Discord embed, friends fallback cover, the
// injected CSS mark) rendered as a broken image. data: URIs are permitted.
const HOQ_LOGO = 'data:image/png;base64,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';

const BASE_CSS = `
  /* Merged bar: the SoundCloud header IS the top bar (our window controls overlay
     its right side), so no separate titlebar strip to reserve room for. */
  html { padding-top: 0 !important; box-sizing: border-box !important; }

  /* Ambient blurred song-cover background (toggle in palette) */
  #sc-bg {
    position: fixed; inset: -80px; z-index: -2; display: none;
    background-size: cover; background-position: center;
    /* brightness was 0.5, which crushed the art to near-black once the scrim
       below was layered on top — the cover has to actually read as the page.
       blur was 100px, which is past the point where an image is "blurred" and
       into a flat colour field: no shape of the artwork survived it. 52px keeps
       it soft but you can still tell what you're looking at — same reasoning as
       the custom-background rule below. */
    filter: blur(52px) saturate(1.5) brightness(var(--sc-bg-bright, 0.66)); transform: scale(1.18);
    transition: background-image .7s ease, opacity .5s ease; pointer-events: none;
  }
  html.sc-coverbg #sc-bg { display: block; }
  /* custom image/GIF background: lighter blur so it's actually visible */
  html.sc-custombg #sc-bg { filter: blur(16px) brightness(0.55) saturate(1.15) !important; transform: scale(1.1) !important; }
  html.sc-coverbg, html.sc-coverbg body { background: transparent !important; }
  html.sc-coverbg .l-container, html.sc-coverbg #content, html.sc-coverbg .l-content,
  html.sc-coverbg .stream, html.sc-coverbg .l-listen-wrapper, html.sc-coverbg .l-about,
  html.sc-coverbg [class*="l-container"] { background-color: transparent !important; }
  /* soft scrim so text stays readable over the art */
  html.sc-coverbg body::before {
    content: ''; position: fixed; inset: 0; z-index: -1; pointer-events: none;
    /* radial vignette fades the cover-bg into dark at the edges (cleaner) */
    /* Kept deliberately light. setBgBrightness() already normalises the wash to a
       constant level, so a heavy scrim here just cancels it out — that is what
       kept the page reading black however much brightness was added. */
    background:
      radial-gradient(140% 100% at 50% 30%, rgba(10,10,12,0) 48%, rgba(10,10,12,0.34) 100%),
      linear-gradient(180deg, rgba(10,10,12,0.10), rgba(10,10,12,0.26));
  }
  /* Frosted translucent bars so the top + bottom blend with the cover bg.
     (Titlebar is a transparent overlay merged into the header now — keep it
     see-through; the header itself carries the frosted bg below.) */
  html.sc-coverbg #sc-titlebar { background: transparent !important; border: 0 !important; }
  html.sc-coverbg .header, html.sc-coverbg .l-fixed-top {
    background: rgba(12,12,14,0.32) !important;
    backdrop-filter: blur(20px) saturate(1.3) !important;
  }
  html.sc-coverbg .playControls {
    background: rgba(12,12,14,0.5) !important;
    backdrop-filter: blur(24px) saturate(1.4) !important;
    border-top: 1px solid rgba(255,255,255,0.06) !important;
  }
  html.sc-coverbg .playControls::before,
  html.sc-coverbg .playControls__inner,
  html.sc-coverbg .playControls__bg { background: transparent !important; }

  /* ===== Scrollbar =====
     Hide EVERY native scrollbar (no reserved gutter on the window edge — that was
     the "thing off to the side"). A custom overlay bar (#hoq-scroll, built in JS)
     floats OVER the content on the right, invisible until you scroll or move to
     the edge, colored in the playing song's accent gradient. */
  * { scrollbar-width: none !important; }
  ::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }
  #hoq-scroll {
    position: fixed !important; top: 56px !important; right: 3px !important; bottom: 8px !important;
    width: 12px !important; z-index: 2147483000 !important; pointer-events: none !important;
    opacity: 0 !important; transition: opacity .25s ease !important;
  }
  #hoq-scroll.show { opacity: 1 !important; }
  #hoq-scroll-thumb {
    position: absolute !important; left: 3px !important; width: 6px !important; top: 0 !important;
    border-radius: 6px !important; cursor: grab !important; pointer-events: auto !important;
    background: linear-gradient(180deg, var(--sc-accent,#ff5500),
                color-mix(in srgb, var(--sc-accent,#ff5500) 55%, #000)) !important;
    box-shadow: 0 0 9px color-mix(in srgb, var(--sc-accent,#ff5500) 55%, transparent) !important;
    transition: width .12s ease, left .12s ease !important;
  }
  #hoq-scroll:not(.show) #hoq-scroll-thumb { pointer-events: none !important; }
  #hoq-scroll:hover #hoq-scroll-thumb, #hoq-scroll-thumb:active { width: 9px !important; left: 1px !important; }

  /* Never allow HORIZONTAL document scrolling. The hero's cover wash bleeds a few
     px past the viewport (blur + scale to feather its edges); clip it here at the
     document level so it can't ever produce a bottom scrollbar. Vertical scroll
     and the hero's soft look are unaffected. */
  html, body { overflow-x: hidden !important; max-width: 100% !important; }

  /* Kill GO MOBILE / get-the-app clutter */
  .mobileApps, .downloadButtons, .m-mobileApps, .mobileHeader,
  .sidebarModule.mobileApps, .smartBanner, .l-mobile-banner,
  a[href*="app-store"], a[href*="play.google"],
  a[href*="itunes.apple"], a[href*="apps.apple"] { display: none !important; }

  /* Kill legal / language footer */
  .footer, .l-footer, .footer__wrapper, .footer__links,
  .sidebarFooter, .footer-links, .footerNav, .footerLinks { display: none !important; }

  /* Auto-kill upsell / promo / cookie popups (the ones with an X) */
  .upsell, [class*="upsell"], .playlistUpsell, .g-branded-box .upsell,
  #onetrust-banner-sdk, #onetrust-consent-sdk, .cookiePolicy,
  .cookieBanner, .smartBanner__button, .interstitial,
  .modal--upsell, [data-testid*="upsell"] { display: none !important; }

  /* Custom touches */
  .sound__artwork .image, .image__full, .sc-artwork,
  .fullHero__artwork .image { border-radius: 10px !important; overflow: hidden !important; }

  /* ---- Accent recolor (driven by the palette) ---- */
  :root { accent-color: var(--sc-accent, #ff5500) !important; }

  /* MUI-based pages (Artist Studio, Insights, track table, checkout) drive all
     their "primary" color off --mui-palette-primary-main (SoundCloud orange).
     Repoint it at the accent so buttons, chips, tab indicators, meters, progress
     rings AND the insights chart bars/fills all recolor in one shot. */
  :root, html, [data-mui-color-scheme], .mui-theme-light, .mui-theme-dark {
    --mui-palette-primary-main: var(--sc-accent, #ff5500) !important;
    --mui-palette-primary-dark: color-mix(in srgb, var(--sc-accent, #ff5500) 78%, #000) !important;
    --mui-palette-primary-light: color-mix(in srgb, var(--sc-accent, #ff5500) 72%, #fff) !important;
    --mui-palette-primary-mainChannel: var(--sc-accent, #ff5500) !important;
    --mui-palette-Chip-defaultBorder: color-mix(in srgb, var(--sc-accent, #ff5500) 40%, transparent) !important;
    /* New MUI track page waveform: bars are one static tone (light=top, dark=bottom
       of each bar) with a cursor line in contrastText. Repoint all three so the
       whole waveform reads as an accent monochrome with vertical depth. */
    --mui-palette-contrast-light: color-mix(in srgb, var(--sc-accent, #ff5500) 88%, #fff) !important;
    --mui-palette-contrast-dark: color-mix(in srgb, var(--sc-accent, #ff5500) 44%, #000) !important;
    --mui-palette-contrast-contrastText: #ffffff !important;
  }
  /* MUI contained-primary buttons + primary chips: force accent fill (some inline
     styles win over the var, so back it with a direct rule at higher specificity). */
  .MuiButton-containedPrimary, .MuiChip-filledPrimary,
  button.MuiButton-containedPrimary, .MuiChip-colorPrimary.MuiChip-filled {
    background-color: var(--sc-accent, #ff5500) !important;
    background-image: none !important;
  }
  .MuiTabs-indicator { background-color: var(--sc-accent, #ff5500) !important; }
  /* New track page: selected tab label (Fans "Top"/"First") → accent. */
  .MuiTab-root.Mui-selected { color: var(--sc-accent, #ff5500) !important; }
  /* Comment-position slider + any primary slider (track fill + thumb) → accent. */
  .MuiSlider-colorPrimary .MuiSlider-track { background-color: var(--sc-accent, #ff5500) !important; border-color: var(--sc-accent, #ff5500) !important; }
  .MuiSlider-colorPrimary .MuiSlider-thumb { color: var(--sc-accent, #ff5500) !important; }
  /* Track-page timestamp "jump to" chips: accent tint on hover instead of grey. */
  .MuiChip-clickable.MuiChip-colorSecondary:hover {
    background-color: color-mix(in srgb, var(--sc-accent, #ff5500) 26%, transparent) !important;
    color: var(--sc-accent, #ff5500) !important;
  }
  /* Related-track / playlist title links: accent on hover. */
  a.MuiLink-underlineNone.MuiTypography-h4:hover { color: var(--sc-accent, #ff5500) !important; }

  /* Promo / upsell banners ("Go everywhere: Distribute Now" etc.) → match the app:
     recolor the hard-coded #F50 orange star to the accent, frost the bar, accent link. */
  .banner__UiEvoIcon path[fill="#F50"], .banner__UiEvoIcon path[fill="#f50"] {
    fill: var(--sc-accent, #ff5500) !important;
  }
  .banner.m-promotion, .banner.primary, .banner.m-promotion.primary {
    background: rgba(20,20,24,0.5) !important; background-image: none !important;
    border: 1px solid color-mix(in srgb, var(--sc-accent, #ff5500) 30%, rgba(255,255,255,0.09)) !important;
    border-radius: 10px !important;
    backdrop-filter: blur(16px) saturate(1.3); -webkit-backdrop-filter: blur(16px) saturate(1.3);
  }
  .banner a, .targetedProUpsellBanner__link {
    color: var(--sc-accent, #ff5500) !important; font-weight: 600;
  }

  /* Upload / track-edit tag input tokens (the "Pop" pills) → accent tint. */
  .tagInput__token, .tokenInput__token {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 24%, transparent) !important;
    border: 1px solid color-mix(in srgb, var(--sc-accent, #ff5500) 42%, transparent) !important;
    color: #fff !important;
  }
  .tagInput__input, .tokenInput__input { color: #fff !important; }
  /* Auto-tagger suggestion panel: kill SC's opaque light box, use our frosted glass. */
  .autoTagger__content, .autoTagger {
    background: rgba(255,255,255,0.05) !important;
    background-image: none !important;
    border: 1px solid rgba(255,255,255,0.08) !important;
    border-radius: 12px !important;
  }
  .autoTagger__title { color: #fff !important; }
  .sc-button-cta, .sc-button-primary, .sc-classic .sc-button-cta,
  .g-branded-box .sc-button-cta, button.sc-button-cta,
  .sc-button-small.sc-button-cta, .sc-button-medium.sc-button-cta,
  .sc-button-small.sc-button-primary, .followButton.sc-button-cta {
    background: var(--sc-accent-bg, #ff5500) !important;
    border-color: transparent !important;
    color: #fff !important;
  }
  /* Blue text/links -> accent (gradient-aware via background-clip:text) */
  a.sc-link-primary, .sc-link-primary,
  .trackItem__trackTitle, .audibleTile__title a, .playableTile__mainHeading a,
  .userBadge__usernameLink, a.sc-text-primary, .sc-text-primary,
  .sectionNav__link.active, .g-link-primary, a.g-link-primary {
    background: var(--sc-accent-bg, #ff5500) !important;
    -webkit-background-clip: text !important;
    background-clip: text !important;
    -webkit-text-fill-color: transparent !important;
    color: var(--sc-accent, #ff5500) !important;
  }
  /* The big track-page title: solid WHITE with an accent glow, and NO dark box
     behind it/the uploader (SoundCloud paints one for contrast over artwork). */
  .fullListenHero .soundTitle *, .fullHero .soundTitle *,
  .soundTitle__title, .soundTitle__title *, .fullHero__title, .fullHero__title *,
  .soundTitle__usernameHeroLink, .soundTitle__secondary {
    background: none !important; background-color: transparent !important; box-shadow: none !important;
  }
  .soundTitle__title, .soundTitle__title a, .soundTitle__title span, .fullHero__title {
    color: #fff !important; -webkit-text-fill-color: #fff !important;
    -webkit-background-clip: border-box !important; background-clip: border-box !important;
  }
  /* Kill SoundCloud's heavy .g-dark-txt-shadow (the dark halo that reads as a
     black box on the light cover) and replace with a clean accent glow. */
  .g-dark-txt-shadow, .fullHero__title, .fullHero__title *,
  .soundTitle, .soundTitle *, .sc-link-dark,
  .soundTitle__usernameTitleContainer, .soundTitle__usernameTitleContainer *,
  .soundTitle__username, .soundTitle__secondary {
    text-shadow: 0 0 12px color-mix(in srgb, var(--sc-accent, #ff5500) 50%, transparent),
                 0 1px 4px rgba(0,0,0,0.5) !important;
    background: none !important; background-color: transparent !important; box-shadow: none !important;
  }
  /* nuke any pseudo-element box behind the title AND the artist/username */
  .fullHero__title::before, .fullHero__title::after,
  .soundTitle::before, .soundTitle::after,
  .soundTitle *::before, .soundTitle *::after {
    content: none !important; display: none !important; background: none !important;
  }

  /* ===== Custom hero play button — gradient accent, rounded, glow ===== */
  .fullHero .sc-button-play, .fullListenHero .sc-button-play, .sound__header .sc-button-play,
  .l-listen-hero .sc-button-play {
    background: linear-gradient(145deg, var(--sc-accent, #ff5500),
                color-mix(in srgb, var(--sc-accent, #ff5500) 65%, #000)) !important;
    border: 0 !important; border-radius: 16px !important;
    box-shadow: 0 10px 26px color-mix(in srgb, var(--sc-accent, #ff5500) 50%, transparent),
                inset 0 1px 0 rgba(255,255,255,0.35) !important;
    transition: transform .15s ease, box-shadow .2s ease !important;
  }
  .fullHero .sc-button-play:hover, .fullListenHero .sc-button-play:hover,
  .sound__header .sc-button-play:hover, .l-listen-hero .sc-button-play:hover {
    transform: scale(1.07) !important;
    box-shadow: 0 14px 34px color-mix(in srgb, var(--sc-accent, #ff5500) 65%, transparent),
                inset 0 1px 0 rgba(255,255,255,0.45) !important;
  }
  /* Sit the title/artist block up next to the play button (top-aligned) instead
     of dropping it to the row's vertical center when the title wraps 2+ lines.
     The play button + the title/username column are siblings inside
     .soundTitle__titleContainer — that's the flex row to align. */
  .soundTitle__titleContainer {
    align-items: flex-start !important;
  }
  .soundTitle__titleContainer .soundTitle__usernameTitleContainer {
    margin-top: 0 !important;
  }
  /* Play buttons: SOLID accent by default (e.g. the track-page play button) */
  .sc-button-play, .sc-button.sc-button-play, .playButton {
    background-color: var(--sc-accent, #ff5500) !important;
    background-image: none !important;
    border-color: transparent !important;
    color: #fff !important;
    transition: background-color .15s ease !important;
  }
  /* ...but TRANSLUCENT only when overlaid on a song cover, so art shows through */
  .sound__artwork .sc-button-play, .audibleTile__artwork .sc-button-play,
  .sound__coverArt .sc-button-play, .fullListenHero__artwork .sc-button-play,
  .listenArtworkWall .sc-button-play, .fullHero__artwork .sc-button-play,
  .playableTile__artwork .sc-button-play, .playableTile__actions .sc-button-play {
    background-color: color-mix(in srgb, var(--sc-accent, #ff5500) 55%, transparent) !important;
    backdrop-filter: blur(2px) !important;
  }
  .sound__artwork .sc-button-play:hover, .audibleTile__artwork .sc-button-play:hover,
  .sound__coverArt .sc-button-play:hover, .fullListenHero__artwork .sc-button-play:hover,
  .playableTile__artwork .sc-button-play:hover {
    background-color: color-mix(in srgb, var(--sc-accent, #ff5500) 80%, transparent) !important;
  }
  /* Header buttons (Upload / Create account): SOLID accent, compact + centered */
  .header .sc-button-cta, a.uploadButton, a[href="/upload"] {
    background: var(--sc-accent-bg, #ff5500) !important;
    background-color: var(--sc-accent, #ff5500) !important;
    border-color: transparent !important;
    color: #fff !important;
    border-radius: 7px !important;
    height: 30px !important;
    padding: 0 16px !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    align-self: center !important;
    flex: 0 0 auto !important;
    width: auto !important;
    min-width: 0 !important;
    max-width: max-content !important;
    margin: 0 4px !important;
    line-height: 1 !important;
    font-size: 13px !important;
    font-weight: 700 !important;
  }

  /* Keep the header nav inline so the Discord tab sits next to Library */
  .header__navMenu, .header__nav, ul.header__navMenu, .header nav > ul {
    display: flex !important; flex-wrap: nowrap !important; white-space: nowrap !important;
  }
  .hoq-dc-tab { display: inline-flex !important; align-items: center !important; white-space: nowrap !important; cursor: pointer !important; }
  .hoq-dc-tab.hoq-active { color: #fff !important; font-weight: 700 !important; box-shadow: inset 0 -2px 0 #fff !important; }

  /* Cleaner header that matches the titlebar tone (frosted variant in cover-bg) */
  .header {
    top: 0 !important; /* merged: header is the top bar (window controls overlay it) */
    background: linear-gradient(180deg, #0f0f11 0%, #0b0b0d 100%) !important;
    border-bottom: 1px solid rgba(255,255,255,0.05) !important;
    box-shadow: none !important;
  }
  /* Reserve space on the header's right for our overlaid window controls
     (skip / settings / traffic lights) so SC's usernav never sits under them. */
  .header .header__inner { padding-right: 158px !important; }
  /* Replace SoundCloud's corner logo with the holdonquietly logo + name.
     .header__logo holds two links (icon-only + wordmark); keep icon-only as the
     clickable home link, hide the wordmark, and rebuild it as our brand. */
  .header__logo .header__logoLink-wordmark { display: none !important; }
  .header__logo .header__logoLink-iconOnly svg { display: none !important; }
  .header__logo {
    display: inline-flex !important; align-items: center !important; height: 46px !important;
    padding-left: 6px !important;
  }
  .header__logo .header__logoLink-iconOnly {
    display: inline-flex !important; align-items: center !important; height: 100% !important;
    width: auto !important; text-decoration: none !important;
  }
  .header__logo .header__logoLink-iconOnly::before {
    content: '' !important; flex: none !important; width: 30px !important; height: 30px !important;
    background: url("${HOQ_LOGO}") center/contain no-repeat !important;
    filter: drop-shadow(0 0 4px rgba(90,160,255,0.3)) !important;
  }
  /* Nav labels, renamed the same way. Scoped by data-menu-name so the injected
     Social/Settings tab (no such attribute) is left alone. */
  .header__navMenuItem[data-menu-name="home"],
  .header__navMenuItem[data-menu-name="stream"],
  .header__navMenuItem[data-menu-name="library"] { font-size: 0 !important; }
  .header__navMenuItem[data-menu-name]::after {
    font-size: 14px !important; font-weight: inherit !important; letter-spacing: normal !important;
  }
  .header__navMenuItem[data-menu-name="home"]::after { content: 'Discover' !important; }
  .header__navMenuItem[data-menu-name="stream"]::after { content: 'Stream' !important; }
  .header__navMenuItem[data-menu-name="library"]::after { content: 'Collection' !important; }

  /* SoundCloud's "new items" dot is always its brand orange, and recolorOrange
     only reaches it after the 800ms debounce — long enough to see it flash.
     It's unambiguously an accent dot, so paint it statically from frame one. */
  .newItemBadge { background-color: var(--sc-accent, #ff5500) !important; }

  /* Upsells: hidden for good rather than left in the row to flash on load. */
  .header__upsellWrapper, .header__fanUpsell, .creatorSubscriptionsButton,
  .header__forArtistsButton { display: none !important; }

  /* Vertically center the Upload button with the rest of the header row */
  .header__inner, .header__soundInput, .header__soundInput.left {
    display: flex !important; align-items: center !important;
  }
  a.uploadButton {
    align-self: center !important;
    margin: auto 18px auto 4px !important; /* extra right gap so it isn't crammed against the pfp */
    box-shadow: 0 0 12px color-mix(in srgb, var(--sc-accent, #ff5500) 45%, transparent) !important;
    transition: box-shadow .18s ease, filter .18s ease !important;
  }
  a.uploadButton:hover { box-shadow: 0 0 18px var(--sc-accent, #ff5500) !important; }

  /* Header avatar + icon buttons: subtle accent glow so they don't look plain */
  .header__userNav img, .userNavButton__avatar, .userBadge__image .sc-artwork {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--sc-accent, #ff5500) 55%, transparent),
                0 0 10px color-mix(in srgb, var(--sc-accent, #ff5500) 32%, transparent) !important;
    border-radius: 50% !important;
  }
  .header a[title*="notification" i], .header a[title*="message" i],
  .header .sc-button-icon, .header__userNav .sc-button {
    transition: filter .18s ease, color .18s ease !important;
  }
  .header a[title*="notification" i]:hover, .header a[title*="message" i]:hover,
  .header .sc-button-icon:hover, .header__userNav .sc-button:hover {
    filter: drop-shadow(0 0 6px var(--sc-accent, #ff5500)) !important;
    color: var(--sc-accent, #ff5500) !important;
  }
  /* Search bar to match the app: ONE clean box, compact height */
  .headerSearch, .header__soundInput .headerSearch, .header form.headerSearch {
    background: rgba(255,255,255,0.05) !important;
    border: 1px solid rgba(255,255,255,0.08) !important;
    border-radius: 8px !important; box-shadow: none !important; overflow: hidden !important;
    height: 34px !important; display: flex !important; align-items: center !important;
  }
  .headerSearch__input, .header__soundInput input, .header form input,
  input.headerSearch__input {
    background: transparent !important; border: 0 !important; height: 32px !important;
    box-shadow: none !important; outline: none !important; color: #e4e4e6 !important;
    font-size: 14px !important;
  }
  .headerSearch__input::placeholder, .header__soundInput input::placeholder { color: #8a8a8c !important; }
  .headerSearch:focus-within {
    border-color: var(--sc-accent, #ff5500) !important; background: rgba(255,255,255,0.07) !important;
  }
  .headerSearch__icon, .headerSearch svg { color: #9a9a9c !important; fill: #9a9a9c !important; }
  /* center the magnifier icon/button vertically in the compact bar */
  .headerSearch__icon, .headerSearch button, .headerSearch__submit,
  .headerSearch [type="submit"], .headerSearch a {
    display: flex !important; align-items: center !important; justify-content: center !important;
    height: 32px !important; top: auto !important; margin: 0 !important;
  }

  /* Kill embedded-module + ad iframes (Artist Tools, ad networks).
     NOTE: do NOT block velvetcake/banner — that's the profile header banner. */
  iframe[src*="credit-tracker"],
  iframe[src*="adtrafficquality"], iframe[src*="googlesyndication"],
  iframe[src*="doubleclick"], iframe[src*="/promoted"] { display: none !important; }
  /* Seek bar → animated audio-style visualizer (canvas overlay in .hoq-viz).
     Hide SoundCloud's plain line + handle but keep the wrapper fully clickable
     for seeking; the flowing waveform + playhead are drawn on our canvas. */
  .playbackTimeline__progressBackground,
  .playbackTimeline__progressBar,
  .playControls__progress .sc-slider-progress,
  .sc-slider-progress, .sc-slider-orange .sc-slider-progress,
  .sc-slider-background {
    background: transparent !important;
  }
  .playbackTimeline__progressWrapper, .playControls__progress {
    position: relative !important; overflow: visible !important;
  }
  .playbackTimeline__progressHandle { opacity: 0 !important; } /* invisible but still draggable */
  .hoq-viz {
    position: absolute !important; left: 0 !important; right: 0 !important;
    top: 50% !important; transform: translateY(-50%) !important;
    width: 100% !important; height: 34px !important;
    pointer-events: none !important; z-index: 6 !important;
  }
  /* Visualizer OFF (palette "Song visualizer bar" toggle) → restore SC's plain
     seek bar: dim track, accent played portion, visible handle. */
  html.hoq-noviz .hoq-viz { display: none !important; }
  html.hoq-noviz .playbackTimeline__progressBackground,
  html.hoq-noviz .sc-slider-background { background: rgba(255,255,255,0.14) !important; }
  html.hoq-noviz .playbackTimeline__progressBar,
  html.hoq-noviz .playControls__progress .sc-slider-progress,
  html.hoq-noviz .sc-slider-progress,
  html.hoq-noviz .sc-slider-orange .sc-slider-progress { background: var(--sc-accent-bg, #ff5500) !important; }
  html.hoq-noviz .playbackTimeline__progressHandle { opacity: 1 !important; }

  /* ===== Optional-effect toggles (palette → Effects) ===== */
  /* Speaker glow pulse OFF */
  html.hoq-no-pulse .volume__button, html.hoq-no-pulse .volume > button,
  html.hoq-no-pulse .volume .sc-ico-volume, html.hoq-no-pulse .volume .volumeIcon { animation: none !important; }
  /* Rounded corners OFF → square artwork */
  html.hoq-no-round .image, html.hoq-no-round .sc-artwork, html.hoq-no-round .image__full,
  html.hoq-no-round .fullHero__artwork, html.hoq-no-round .playableTile__image .image,
  html.hoq-no-round .soundBadge__artwork .image { border-radius: 0 !important; }
  /* Row hover highlight OFF */
  html.hoq-no-hover .soundList__item:hover, html.hoq-no-hover .trackList__item:hover,
  html.hoq-no-hover .compactTrackList__item:hover { background: transparent !important; }
  /* Frosted bars OFF → solid */
  html.hoq-no-frost.sc-coverbg .header, html.hoq-no-frost.sc-coverbg .l-fixed-top,
  html.hoq-no-frost.sc-coverbg .playControls, html.hoq-no-frost .dropdownMenu,
  html.hoq-no-frost .linkMenu, html.hoq-no-frost #sc-palette {
    backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
  }
  /* UI animations OFF → reduce motion */
  html.hoq-no-anim *, html.hoq-no-anim *::before, html.hoq-no-anim *::after {
    animation: none !important; transition: none !important;
  }
  /* Accent glow OFF → drop the halos/glows on the prominent elements */
  html.hoq-no-glow .sc-button-like.sc-button-selected,
  html.hoq-no-glow .volume__button, html.hoq-no-glow .volume > button { filter: none !important; }
  html.hoq-no-glow .fullHero__title, html.hoq-no-glow .soundTitle__title,
  html.hoq-no-glow .mixedSelectionModule__titleText, html.hoq-no-glow .lazyLoadingList__header,
  html.hoq-no-glow .sectionHead__title { text-shadow: none !important; }
  html.hoq-no-glow .collectionNav.g-tabs .active a { box-shadow: inset 3px 0 0 var(--sc-accent, #ff5500) !important; }
  /* Grayscale covers ON (opt-in) */
  html.hoq-gray .image span, html.hoq-gray .sc-artwork, html.hoq-gray .sound__coverArt span,
  html.hoq-gray .fullHero__artwork span, html.hoq-gray .playableTile__image span { filter: grayscale(1) !important; }

  /* Ambient glow ON (opt-in): a soft bloom of the current track's accent light,
     screen-blended over the UI, drifting up from the player + bottom corners. */
  #hoq-ambient { position: fixed; inset: 0; z-index: 9998; pointer-events: none; opacity: 0;
    transition: opacity .6s ease; mix-blend-mode: screen; }
  html.hoq-ambient #hoq-ambient { opacity: 1; }
  #hoq-ambient::before, #hoq-ambient::after { content: ''; position: absolute; inset: -15%; }
  #hoq-ambient::before {
    background:
      radial-gradient(30% 34% at 8% 104%,  color-mix(in srgb, var(--sc-accent,#ff5500) 85%, transparent), transparent 66%),
      radial-gradient(34% 38% at 92% 104%, color-mix(in srgb, var(--sc-accent,#ff5500) 70%, transparent), transparent 68%),
      radial-gradient(46% 40% at 50% 116%, color-mix(in srgb, var(--sc-accent,#ff5500) 62%, transparent), transparent 70%);
    filter: blur(50px) saturate(1.4); animation: hoqAmb 15s ease-in-out infinite alternate;
  }
  #hoq-ambient::after {
    background:
      radial-gradient(40% 34% at 10% -8%, color-mix(in srgb, var(--sc-accent,#ff5500) 34%, transparent), transparent 66%),
      radial-gradient(40% 34% at 90% -8%, color-mix(in srgb, var(--sc-accent,#ff5500) 30%, transparent), transparent 66%);
    filter: blur(60px); animation: hoqAmb2 21s ease-in-out infinite alternate;
  }
  html.hoq-no-anim #hoq-ambient::before, html.hoq-no-anim #hoq-ambient::after { animation: none !important; }
  @keyframes hoqAmb  { from { transform: translateY(0) scale(1); } to { transform: translateY(-3%) scale(1.06); } }
  @keyframes hoqAmb2 { from { transform: translate(0,0); }        to { transform: translate(3%,2%); } }

  /* ===== Ambient mode — a big now-playing view (Spotify-ish), toggled from the
     player bar. Sits above the content but leaves the real player bar visible at
     the bottom, and mirrors the current track (art/title/artist/progress) with
     controls wired to the real transport buttons. ===== */
  #hoq-np { position: fixed; inset: 0; z-index: 9990; display: none; overflow: hidden;
    color: #fff; background: #0b0b0e; }
  #hoq-np.on { display: flex; align-items: center; justify-content: center; gap: 64px; }
  /* keep the real player bar visible on top of the full-screen overlay */
  html.hoq-np-open .playControls { z-index: 9995 !important; }
  #hoq-np .np-bg { position: absolute; inset: -10%; background-size: cover; background-position: center;
    filter: blur(72px) saturate(1.7) brightness(.72); transform: scale(1.15); }
  #hoq-np .np-scrim { position: absolute; inset: 0;
    background:
      radial-gradient(60% 60% at 50% 42%, transparent 30%, rgba(8,8,11,.55) 100%),
      radial-gradient(45% 50% at 50% 120%, color-mix(in srgb, var(--sc-accent,#ff5500) 40%, transparent), transparent 70%); }
  #hoq-np .np-art { position: relative; width: 380px; height: 380px; border-radius: 20px;
    background-size: cover; background-position: center; background-color: rgba(255,255,255,.04);
    box-shadow: 0 40px 90px rgba(0,0,0,.55),
      0 0 90px color-mix(in srgb, var(--sc-accent,#ff5500) 45%, transparent),
      0 0 0 1px rgba(255,255,255,.1); }
  #hoq-np .np-side { position: relative; width: 460px; max-width: 46vw; }
  #hoq-np .np-eyebrow { font-size: 12px; letter-spacing: .22em; font-weight: 700; text-transform: uppercase;
    color: var(--sc-accent, #ff5500); margin: 0 0 14px; opacity: .95; }
  #hoq-np .np-title { font-size: 40px; font-weight: 800; line-height: 1.12; letter-spacing: -.01em;
    margin: 0 0 10px; max-height: 4.6em; overflow: hidden; }
  #hoq-np .np-artist { font-size: 18px; opacity: .72; margin: 0 0 30px; }
  #hoq-np .np-bar { height: 7px; border-radius: 4px; background: rgba(255,255,255,.16); overflow: hidden; cursor: pointer; }
  #hoq-np .np-bar i { display: block; height: 100%; background: var(--sc-accent, #ff5500); width: 0%;
    box-shadow: 0 0 12px color-mix(in srgb, var(--sc-accent,#ff5500) 70%, transparent); }
  #hoq-np .np-times { display: flex; justify-content: space-between; font-size: 12px; opacity: .7; margin-top: 8px; }
  #hoq-np .np-ctrls { display: flex; align-items: center; gap: 26px; margin-top: 30px; }
  #hoq-np .np-ctrls button { background: none; border: 0; color: #fff; cursor: pointer; opacity: .85; padding: 0; display: flex; }
  #hoq-np .np-ctrls button:hover { opacity: 1; }
  #hoq-np .np-play { width: 62px; height: 62px; border-radius: 50%; background: #fff !important; color: #111 !important;
    align-items: center; justify-content: center; }
  #hoq-np .np-play svg { width: 26px; height: 26px; }
  #hoq-np .np-like { margin-left: 8px; }
  #hoq-np .np-like svg { width: 24px; height: 24px; }
  #hoq-np .np-close { position: absolute; top: 44px; left: 24px; width: 40px; height: 40px; border-radius: 50%;
    background: rgba(255,255,255,.1); border: 0; color: #fff; cursor: pointer; font-size: 20px; line-height: 40px; }
  #hoq-np .np-close:hover { background: rgba(255,255,255,.2); }
  /* trigger button in the player bar — matched to our Discord play/share buttons
     (and SoundCloud's own icon buttons): 26x26 box, 15px icon, secondary grey,
     accent on hover. */
  #hoq-ambient-btn { display: none; }
  .playbackSoundBadge__actions #hoq-ambient-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 30px; height: 30px; margin-left: 10px; padding: 0; background: none; border: 0;
    border-radius: 7px; cursor: pointer; color: #b4b4b8; flex: 0 0 auto;
    transition: color .15s ease, background .15s ease; }
  .playbackSoundBadge__actions #hoq-ambient-btn:hover { color: var(--sc-accent, #ff5500); background: rgba(255,255,255,0.09); }
  .playbackSoundBadge__actions #hoq-ambient-btn svg { width: 16px; height: 16px; flex: 0 0 auto; }
  #hoq-np .np-art { transition: transform .14s ease; }
  html.hoq-no-anim #hoq-np .np-art { transition: none !important; }
  /* WebGL 3D backdrop (Three.js): a rotating accent crystal + starfield behind
     the card. Sits at the back; the cover wash dims when it's live. */
  #hoq-np-gl { position: absolute; inset: 0; z-index: 0; }
  #hoq-np .np-bg { z-index: 0; }
  html.hoq-np-gl #hoq-np .np-bg { opacity: .16 !important; }
  #hoq-np .np-scrim { z-index: 1; }
  #hoq-np .np-art, #hoq-np .np-side, #hoq-np .np-close { position: relative; z-index: 3; }

  a.sc-link-primary, .sc-link-primary:hover { color: var(--sc-accent, #ff5500) !important; }

  /* Waveform is a <canvas> (orange played + grey unplayed). Hue-rotate just the
     canvas so orange shifts to the accent while grey stays grey. Comment
     avatars are separate <img>s, so they're untouched. Default = 0deg (orange). */
  /* ===== Our own waveform: bars we fully control, overlaid on SC's canvas
     (which we hide but keep beneath for click-to-seek + comments). ===== */
  .waveform.hoq-cw > *:not(.hoq-wave) { opacity: 0 !important; }
  .hoq-wave { position: absolute; inset: 0; z-index: 6; pointer-events: none; perspective: 700px; }
  .hoq-wave .bars {
    position: absolute; inset: 0; display: flex; align-items: center; gap: 2px; box-sizing: border-box;
    /* the waveform's OWN 3D: bars stand up on a plane tilted away from you */
    transform: rotateX(28deg); transform-origin: center 76%;
  }
  .hoq-wave .bars i {
    flex: 1 1 0; min-width: 0; border-radius: 3px; align-self: center;
    transition: transform .12s ease; transform-origin: center; /* smooth cursor-wave */
    /* glossy cylinder shading so each bar reads as a 3D rod */
    box-shadow:
      inset 1.5px 0 1px rgba(255,255,255,0.30),
      inset -1.5px 0 1px rgba(0,0,0,0.30),
      inset 0 2px 0 rgba(255,255,255,0.38),
      0 2px 4px rgba(0,0,0,0.45);
  }
  .hoq-wave .bars.un i { background: rgba(255,255,255,0.26); }
  .hoq-wave .bars.pl i {
    background: var(--wave-color, var(--sc-accent, #ff5500));
    box-shadow: inset 1.5px 0 1px rgba(255,255,255,0.30), inset -1.5px 0 1px rgba(0,0,0,0.28),
                inset 0 2px 0 rgba(255,255,255,0.4), 0 0 3px color-mix(in srgb, var(--wave-color, var(--sc-accent,#ff5500)) 60%, transparent);
  }
  .hoq-wave .bars.pl { clip-path: inset(0 calc(100% - var(--wave-prog, 0%)) 0 0); }

  /* ===== Track page hero: fade into the app bg instead of the grey box ===== */
  .fullHero, .fullListenHero, .l-listen-hero, .listenHero, .sound__header,
  .fullHero__foreground, .fullHero__overlay, .listenHero__inner,
  .l-listen-wrapper > .fullHero, .listenEngagement,
  .fullListenHero > div, .fullListenHero > div > div {
    background: transparent !important; box-shadow: none !important;
    border: 0 !important; border-radius: 0 !important;
    outline: 0 !important; overflow: visible !important;
  }
  /* the desaturated artwork gradient SoundCloud paints behind the hero */
  .fullHero__background, .listenHero__background, .fullHero__artworkBackground,
  .fullHero__gradient, .listenHero__gradient {
    display: none !important;
  }
  /* The cover-colored hero gradient (SoundCloud's .backgroundGradient) — fade its
     edges into the app so it's a clean blended wash instead of a hard-edged block. */
  .backgroundGradient {
    /* Fade to transparent WELL INSIDE the box on every side so no hard edge is
       left for the container to clip into a rounded-rect outline. */
    -webkit-mask-image: radial-gradient(78% 78% at 50% 30%, #000 0%, rgba(0,0,0,0.45) 46%, transparent 82%) !important;
    mask-image: radial-gradient(78% 78% at 50% 30%, #000 0%, rgba(0,0,0,0.45) 46%, transparent 82%) !important;
    opacity: 0.8 !important;
    filter: blur(38px) !important;         /* feather the edges so it blends in/out */
    transform: scale(1.1) !important;      /* hide the blur's own soft border */
    overflow: visible !important;          /* don't hard-clip the blurred wash */
    border-radius: 0 !important;
  }
  .backgroundGradient, .backgroundGradient__buffer, .backgroundGradient__imageOverlay {
    border-radius: 0 !important;
  }
  .backgroundGradient__imageOverlay { opacity: 0.5 !important; }
  /* drop the dark readability boxes behind the title / uploader / tags; keep a
     soft text-shadow so it stays legible against the app background */
  .fullHero__title, .fullHero__uploader, .soundTitle__title, .soundTitle__info,
  .soundTitle__usernameHeroLink, .fullHero .sc-tagList, .fullHero__tag,
  .soundTitle__additionalContainer, .sc-media-content .soundTitle__title {
    background: transparent !important; box-shadow: none !important;
    text-shadow: 0 1px 8px rgba(0,0,0,0.55) !important;
  }

  /* ===== Library "All / Created / Liked" filter dropdown (SoundCloud .select) ===== */
  .collectionSection__filterSelect .select__list,
  .select .select__list, ul.select__list, .select__menu,
  .commentsList__sortSelect .select__list, [class*="sortSelect" i] .select__list,
  .collectionSection__filterSelect [role="listbox"], .select [role="listbox"] {
    background: rgba(14,14,18,0.6) !important;
    border: 1px solid rgba(255,255,255,0.10) !important;
    border-radius: 12px !important;
    box-shadow: 0 16px 44px rgba(0,0,0,0.55) !important;
    backdrop-filter: blur(24px) saturate(1.4) !important;
    -webkit-backdrop-filter: blur(24px) saturate(1.4) !important;
    overflow: hidden !important; padding: 5px !important;
  }
  .select__list li, .select__option, .select__list a, .select__list button,
  .collectionSection__filterSelect [role="option"] {
    border-radius: 8px !important; color: #d4d4d7 !important;
    padding: 8px 11px !important; background: transparent !important; border: 0 !important;
  }
  .select__list li:hover, .select__option:hover, .select__list a:hover,
  .collectionSection__filterSelect [role="option"]:hover,
  .collectionSection__filterSelect [role="option"][aria-selected="true"] {
    background: var(--sc-accent, #ff5500) !important; color: #fff !important;
  }

  /* ---- Bottom player: color-only polish (NO layout changes) ---- */
  .playControls {
    background: linear-gradient(180deg, #181818 0%, #0b0b0b 100%) !important;
    border-top: 1px solid rgba(255,255,255,0.06) !important;
  }
  /* Never show a horizontal scrollbar on the bottom player bar. Use overflow-x:
     CLIP (not hidden) — hidden forces overflow-y to compute to auto, which was
     clipping the upward-opening volume popup. clip leaves overflow-y visible. */
  .playControls, .playControls__inner {
    overflow-x: clip !important;
    scrollbar-width: none !important;
    -ms-overflow-style: none !important;
  }
  .playControls::-webkit-scrollbar, .playControls__inner::-webkit-scrollbar {
    display: none !important; width: 0 !important; height: 0 !important;
  }
  /* Text carets match the theme accent (was SoundCloud orange). */
  input, textarea, .sc-input, .headerSearch__input { caret-color: var(--sc-accent, #ff5500) !important; }
  /* Player control buttons: transparent (no boxes) so they blend with the bar */
  .playControls button:not(.playControls__play):not(.sc-button-play),
  .playControls .sc-button:not(.playControls__play):not(.sc-button-play),
  .playbackSoundBadge button, .playbackSoundBadge .sc-button {
    background: transparent !important;
    background-color: transparent !important;
    box-shadow: none !important;
    border-color: transparent !important;
  }
  .playControls button:not(.playControls__play):hover,
  .playbackSoundBadge button:hover {
    background: rgba(255,255,255,0.08) !important;
  }
  /* Soft fade so page content melts into the bar instead of a hard edge */
  .playControls::before {
    content: '' !important;
    position: absolute !important;
    left: 0 !important; right: 0 !important; bottom: 100% !important;
    height: 44px !important;
    background: linear-gradient(to top, rgba(11,11,11,0.95) 0%, rgba(11,11,11,0) 100%) !important;
    pointer-events: none !important;
  }
  /* Play/pause: just tint it the accent + soft glow, keep SoundCloud's shape */
  .playControls__play {
    background-color: var(--sc-accent, #ff5500) !important;
    box-shadow: 0 0 10px -3px var(--sc-accent, #ff5500) !important;
  }
  /* Prev / next / shuffle / repeat: accent on hover/active (color only) */
  .playControls__prev:hover, .playControls__next:hover,
  .shuffleControl.m-shuffling, .repeatControl.m-one, .repeatControl.m-all {
    color: var(--sc-accent, #ff5500) !important;
  }
  /* Rounded now-playing artwork thumbnail */
  /* Now-playing title: the badge is content-sized, so the title link was pinned
     to ~136px inside a 328px badge and truncated titles that had room to spare.
     Let the badge take the slack in the bar and the title take the slack in the
     badge. */
  /* 430 is the balance point: the title roughly doubles its visible length while
     the timeline keeps enough width for the seek-bar visualiser to read. */
  .playControls__soundBadge { flex: 1 1 auto !important; max-width: 430px !important; min-width: 0 !important; }
  .playbackSoundBadge { min-width: 0 !important; }
  .playbackSoundBadge__titleContextContainer,
  .playbackSoundBadge__title { min-width: 0 !important; flex: 1 1 auto !important; }
  .playbackSoundBadge__titleLink { max-width: 100% !important; }
  /* Still too long? Slide it on hover instead of stopping at an ellipsis. The
     parent clips, the link itself slides — no DOM is touched, only styles, so
     React keeps ownership of the markup. Distance is measured into --hoq-mq. */
  .playbackSoundBadge__title { overflow: hidden !important; }
  .playbackSoundBadge:hover .playbackSoundBadge__titleLink.hoq-mq {
    width: max-content !important; max-width: none !important;
    text-overflow: clip !important; will-change: transform;
    animation: hoqMarquee var(--hoq-mq-dur, 8s) ease-in-out infinite alternate;
  }
  @keyframes hoqMarquee {
    0%, 12% { transform: translateX(0); }
    88%, 100% { transform: translateX(var(--hoq-mq, 0px)); }
  }
  html.hoq-no-anim .playbackSoundBadge__titleLink.hoq-mq { animation: none !important; }

  .playbackSoundBadge__avatar .image {
    border-radius: 6px !important; overflow: hidden !important;
  }
  /* Like/heart button turns accent when active */
  .playbackSoundBadge .sc-button-like.sc-button-selected {
    color: var(--sc-accent, #ff5500) !important;
  }

  /* ===== Spotify-style horizontal volume (0-100) ===== */
  .volume__sliderWrapper, .volume__sliderBackground, .volume__sliderProgress,
  .volume .sc-slider, .volume__sliderHandle { display: none !important; }
  .volume { display: flex !important; align-items: center !important; overflow: visible !important;
    width: auto !important; position: relative !important; }
  /* Colored + glowing speaker icon */
  .volume__button, .volume > button, .volume .sc-ico-volume, .volume .volumeIcon,
  .volume__button *, .volume .sc-ico-volume::before {
    color: var(--sc-accent, #ff5500) !important;
    fill: var(--sc-accent, #ff5500) !important;
  }
  .volume__button, .volume > button, .volume .sc-ico-volume, .volume .volumeIcon {
    filter: drop-shadow(0 0 5px color-mix(in srgb, var(--sc-accent, #ff5500) 60%, transparent)) !important;
    animation: hoqVolGlow 5.5s ease-in-out infinite !important;
    transition: filter .2s ease !important;
  }
  .volume:hover .volume__button, .volume:hover > button,
  .volume:hover .sc-ico-volume, .volume:hover .volumeIcon {
    filter: drop-shadow(0 0 10px var(--sc-accent, #ff5500)) !important;
    animation: none !important;
  }
  @keyframes hoqVolGlow {
    0%, 100% { filter: drop-shadow(0 0 4px color-mix(in srgb, var(--sc-accent, #ff5500) 45%, transparent)); }
    50%      { filter: drop-shadow(0 0 9px color-mix(in srgb, var(--sc-accent, #ff5500) 95%, transparent)); }
  }
  /* Slider + % sit inline in the player bar, ALWAYS visible (no popup to fight). */
  .hoq-vol-pop {
    position: static !important; transform: none !important;
    display: inline-flex !important; align-items: center; gap: 8px;
    background: transparent !important; border: 0 !important; box-shadow: none !important;
    backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
    padding: 0 2px 0 8px !important; white-space: nowrap;
    opacity: 1 !important; visibility: visible !important; pointer-events: auto !important;
    z-index: 2147483000;
  }
  .hoq-vol-pop::after, .hoq-vol-pop::before { display: none !important; content: none !important; }
  .hoq-vol {
    -webkit-appearance: none; appearance: none; width: 92px; height: 5px;
    border-radius: 999px; outline: none; cursor: pointer; margin: 0; padding: 0;
    vertical-align: middle;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.05);
  }
  .hoq-vol::-webkit-slider-thumb {
    -webkit-appearance: none; width: 13px; height: 13px; border-radius: 50%;
    background: #fff; cursor: pointer;
    box-shadow: 0 0 7px color-mix(in srgb, var(--sc-accent, #ff5500) 90%, transparent),
                0 0 2px rgba(0,0,0,0.45);
    transition: transform .1s ease, box-shadow .15s ease;
  }
  .hoq-vol:hover::-webkit-slider-thumb {
    transform: scale(1.18);
    box-shadow: 0 0 13px var(--sc-accent, #ff5500),
                0 0 4px color-mix(in srgb, var(--sc-accent, #ff5500) 70%, transparent),
                0 0 2px rgba(0,0,0,0.5);
  }
  /* Always-visible live volume % (updates as you drag/scroll, not on hover) */
  .hoq-vol-pct {
    display: inline-block; min-width: 32px; margin: 0 4px 0 2px;
    font-family: Inter, -apple-system, Arial, sans-serif;
    font-size: 11px; font-weight: 700; color: #c9c9cc; letter-spacing: .2px;
    font-variant-numeric: tabular-nums; text-align: left; vertical-align: middle;
    user-select: none; cursor: default;
  }

  /* =====================  CLEANER UI PASS  ===================== */
  /* Rounded artwork everywhere */
  .image, .sc-artwork, .audibleTile__artwork .image, .badgeList__item .image,
  .systemPlaylistBadge__artwork .image, .compactTrackList .image,
  .sound__coverArt .image, .trackItem__image .image {
    border-radius: 8px !important;
  }
  /* ===== Unique track tiles (rounded, framed, zoom-on-hover) ===== */
  .audibleTile, .badgeList__item, .systemPlaylistBadge, .sound__coverArt,
  .playableTile {
    transition: transform .18s ease !important;
  }
  .audibleTile__artwork, .playableTile__artwork, .sound__coverArt,
  .systemPlaylistBadge__artwork, .badgeList__item .image {
    border-radius: 14px !important; overflow: hidden !important; position: relative !important;
    box-shadow: 0 6px 18px rgba(0,0,0,0.4), inset 0 0 0 1px rgba(255,255,255,0.05) !important;
    transition: transform .2s ease, box-shadow .2s ease !important;
  }
  /* subtle accent sheen from the top corner */
  .audibleTile__artwork::after, .playableTile__artwork::after {
    content: '' !important; position: absolute !important; inset: 0 !important; pointer-events: none !important;
    background: linear-gradient(135deg, color-mix(in srgb, var(--sc-accent, #ff5500) 22%, transparent), transparent 45%) !important;
    opacity: 0 !important; transition: opacity .2s ease !important; border-radius: 14px !important;
  }
  .audibleTile:hover .audibleTile__artwork, .playableTile:hover .playableTile__artwork,
  .audibleTile:hover .sound__coverArt, .badgeList__item:hover .image {
    transform: translateY(-5px) !important;
    box-shadow: 0 14px 30px rgba(0,0,0,0.55), 0 0 0 2px var(--sc-accent, #ff5500),
                inset 0 0 0 1px rgba(255,255,255,0.08) !important;
  }
  .audibleTile:hover .audibleTile__artwork::after, .playableTile:hover .playableTile__artwork::after { opacity: 1 !important; }
  /* zoom the cover image inside its rounded frame on hover */
  .audibleTile__artwork .image, .playableTile__artwork .image, .sound__coverArt .image {
    transition: transform .35s ease !important;
  }
  .audibleTile:hover .image, .playableTile:hover .image, .sound__coverArt:hover .image {
    transform: scale(1.07) !important;
  }
  /* Consistent rounded buttons */
  .sc-button, .sc-button-small, .sc-button-medium, .sc-button-large {
    border-radius: 6px !important;
  }
  /* Track/list rows: rounded + subtle hover highlight */
  .soundList__item, .trackList__item, .searchList__item, .soundBadgeList__item {
    border-radius: 8px !important;
    transition: background .12s ease !important;
  }
  .soundList__item:hover, .trackList__item:hover, .searchList__item:hover {
    background: rgba(255,255,255,0.035) !important;
  }
  /* Cleaner section headers */
  .soundList__header, .lazyLoadingList__header, .sectionHead, .soundTitle__title,
  h2.soundTitle__title { letter-spacing: .2px !important; }
  /* Tame harsh borders / dividers */
  hr, .divider, .g-hr, .divider--default { opacity: .35 !important; border-color: rgba(255,255,255,0.08) !important; }
  .sound, .sound__body { border: 0 !important; }

  /* User-adjustable song-list zoom (density). Default 1 = normal. */
  .soundList, .trackList, .lazyLoadingList__list, .systemPlaylistTrackList,
  .soundBadgeList, .searchList__results, .stream__list {
    zoom: var(--sc-list-zoom, 1) !important;
  }

  /* ===== Library: convert horizontal tabs into a vertical SIDE TAB ===== */
  .l-collection:has(.collectionNav) {
    display: flex !important; align-items: flex-start !important; gap: 24px !important;
  }
  .l-collection:has(.collectionNav) .l-nav {
    flex: 0 0 172px !important; width: 172px !important; margin: 0 !important;
    position: sticky !important; top: ${66}px !important; float: none !important;
  }
  .l-collection:has(.collectionNav) .l-main {
    flex: 1 1 auto !important; min-width: 0 !important; margin: 0 !important;
  }
  .collectionNav.g-tabs {
    display: flex !important; flex-direction: column !important;
    align-items: stretch !important; gap: 3px !important;
    background: rgba(12,12,16,0.42) !important; border: 1px solid rgba(255,255,255,0.10) !important;
    border-radius: 14px !important; padding: 8px !important;
    overflow: visible !important; box-sizing: border-box !important;
    backdrop-filter: blur(24px) saturate(1.5) !important;
    -webkit-backdrop-filter: blur(24px) saturate(1.5) !important;
    box-shadow: 0 18px 52px rgba(0,0,0,0.5) !important;
  }
  .collectionNav.g-tabs li, .collectionNav.g-tabs .g-tabs-item {
    display: block !important; width: 100% !important; max-width: 100% !important;
    margin: 0 !important; border: 0 !important; box-sizing: border-box !important;
  }
  /* Kill SoundCloud's horizontal active-underline indicator (stray line when vertical) */
  .collectionNav.g-tabs a::before, .collectionNav.g-tabs a::after,
  .collectionNav.g-tabs li::before, .collectionNav.g-tabs li::after,
  .collectionNav.g-tabs .active::after { display: none !important; content: none !important; }
  .collectionNav.g-tabs a {
    display: block !important; width: 100% !important; max-width: 100% !important; text-align: left !important;
    padding: 10px 14px !important; border-radius: 9px !important; border: 0 !important;
    box-sizing: border-box !important; color: #b7b7ba !important;
    font-weight: 600 !important; font-size: 14px !important;
    box-shadow: none !important; transition: background .12s ease, color .12s ease !important;
  }
  .collectionNav.g-tabs a:hover {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 10%, rgba(255,255,255,0.05)) !important;
    color: #fff !important;
    box-shadow: 0 0 13px color-mix(in srgb, var(--sc-accent, #ff5500) 24%, transparent) !important;
  }
  /* Selected item: ONE clear indicator instead of bg + border + inset bar +
     outer glow + text glow all stacked (which read as boxy). A soft accent
     wash, the left accent bar, and accent text — nothing else. */
  .collectionNav.g-tabs .active a, .collectionNav.g-tabs a.active,
  .collectionNav.g-tabs li.active a, .collectionNav.g-tabs [aria-current] a,
  .collectionNav.g-tabs a[aria-current] {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 14%, transparent) !important;
    color: color-mix(in srgb, var(--sc-accent, #ff5500) 70%, #ffffff) !important;
    font-weight: 700 !important; border: 0 !important;
    box-shadow: inset 3px 0 0 var(--sc-accent, #ff5500) !important;
    text-shadow: none !important;
  }

  /* ===== Library "Filter" input — themed field with accent focus glow ===== */
  .textfield__inputWrapper .textfield__input, .collectionSection .textfield__input {
    background: rgba(255,255,255,0.05) !important; border: 1px solid rgba(255,255,255,0.12) !important;
    border-radius: 9px !important; color: #e4e4e6 !important; box-shadow: none !important;
    transition: border-color .12s ease, box-shadow .12s ease !important;
  }
  .textfield__inputWrapper .textfield__input:focus {
    border-color: var(--sc-accent, #ff5500) !important;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--sc-accent, #ff5500) 22%, transparent),
                0 0 12px color-mix(in srgb, var(--sc-accent, #ff5500) 26%, transparent) !important;
  }
  .textfield__inputWrapper .textfield__input::placeholder { color: #8a8a8c !important; }
  .textfield__clear { color: #b7b7ba !important; }
  .textfield__clearContainer:hover .textfield__clear { color: var(--sc-accent, #ff5500) !important; }

  /* ===== Library "View" (Badges / List) toggle — accent selection with glow ===== */
  .listDisplayToggle__title { color: #8a8a8c !important; }
  .listDisplayToggle__options .sc-button {
    background: transparent !important; border: 1px solid rgba(255,255,255,0.10) !important;
    border-radius: 9px !important; color: #b7b7ba !important; box-shadow: none !important;
    transition: background .12s ease, border-color .12s ease, color .12s ease, box-shadow .12s ease !important;
  }
  .listDisplayToggle__options .sc-button:hover {
    background: rgba(255,255,255,0.06) !important; color: #fff !important;
  }
  .listDisplayToggle__options .sc-button.sc-button-selected {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 18%, transparent) !important;
    border-color: color-mix(in srgb, var(--sc-accent, #ff5500) 45%, transparent) !important;
    color: var(--sc-accent, #ff5500) !important;
    box-shadow: 0 0 12px color-mix(in srgb, var(--sc-accent, #ff5500) 32%, transparent) !important;
  }

  /* ===== Library "All / Created / Liked" filter BUTTON — acrylic glass ===== */
  .collectionSection__filterSelect .sc-button-dropdown {
    background: rgba(255,255,255,0.05) !important;
    border: 1px solid rgba(255,255,255,0.12) !important;
    border-radius: 10px !important; color: #d6d6db !important; box-shadow: none !important;
    backdrop-filter: blur(22px) saturate(1.4) !important;
    -webkit-backdrop-filter: blur(22px) saturate(1.4) !important;
    transition: background .15s ease, border-color .15s ease, box-shadow .15s ease, color .15s ease !important;
  }
  .collectionSection__filterSelect .sc-button-dropdown:hover {
    color: #fff !important;
    border-color: color-mix(in srgb, var(--sc-accent, #ff5500) 55%, transparent) !important;
    box-shadow: 0 0 15px color-mix(in srgb, var(--sc-accent, #ff5500) 30%, transparent) !important;
  }
  .collectionSection__filterSelect .sc-button-dropdown.sc-button-selected,
  .collectionSection__filterSelect .sc-button-dropdown[aria-expanded="true"] {
    color: var(--sc-accent, #ff5500) !important;
    border-color: color-mix(in srgb, var(--sc-accent, #ff5500) 50%, transparent) !important;
    box-shadow: 0 0 12px color-mix(in srgb, var(--sc-accent, #ff5500) 28%, transparent) !important;
  }
  .collectionSection__filterSelect .sc-button-dropdown svg { fill: currentColor !important; }

  /* ===== Profile page (userInfoBar) action buttons → acrylic ===== */
  .userInfoBar__buttons .sc-button {
    background: rgba(255,255,255,0.05) !important;
    border: 1px solid rgba(255,255,255,0.12) !important; border-radius: 10px !important;
    color: #d6d6db !important; box-shadow: none !important;
    backdrop-filter: blur(22px) saturate(1.4) !important; -webkit-backdrop-filter: blur(22px) saturate(1.4) !important;
    transition: background .15s ease, border-color .15s ease, box-shadow .15s ease, color .15s ease !important;
  }
  .userInfoBar__buttons .sc-button:hover {
    color: #fff !important;
    border-color: color-mix(in srgb, var(--sc-accent, #ff5500) 55%, transparent) !important;
    box-shadow: 0 0 14px color-mix(in srgb, var(--sc-accent, #ff5500) 30%, transparent) !important;
  }
  .userInfoBar__buttons .sc-button-cta, .userInfoBar__buttons .sc-button-insights {
    background: var(--sc-accent, #ff5500) !important; color: #fff !important; border-color: transparent !important;
    box-shadow: 0 0 14px color-mix(in srgb, var(--sc-accent, #ff5500) 40%, transparent) !important;
  }
  .userInfoBar__buttons .sc-button svg { fill: currentColor !important; }

  /* ===== Profile hero — bottom fade =====
     Full-bleed (width:100vw + negative margins) was destabilising some profiles:
     on open, their content column collapsed to 0 height (a SoundCloud layout
     timing bug the extra reflow tipped over). So keep the banner at its normal
     width and only fade its bottom. Everything is scoped to .m-visualLoaded so
     profiles with no banner — and the brief pre-load state — are left untouched. */
  .l-user-hero .profileHeaderBackground.m-visualLoaded {
    background-color: transparent !important;
    -webkit-mask-image: linear-gradient(180deg,#000 0%,#000 68%,transparent 100%) !important;
    mask-image: linear-gradient(180deg,#000 0%,#000 68%,transparent 100%) !important;
  }
  /* Cover the width — the visual defaults to auto 100%, leaving a small grey gap
     on the right otherwise. */
  .l-user-hero .profileHeaderBackground.m-visualLoaded .profileHeaderBackground__visual {
    background-size: cover !important; background-position: center !important;
  }

  /* ===== Profile tabs (All / Popular tracks / Tracks / …) — accent active + hover glow ===== */
  .profileTabs.g-tabs .g-tabs-link {
    color: #b7b7ba !important; border: 0 !important; box-shadow: none !important;
    transition: color .12s ease, box-shadow .12s ease, text-shadow .12s ease !important;
  }
  .profileTabs.g-tabs .g-tabs-item::after, .profileTabs.g-tabs .g-tabs-link::after { display: none !important; content: none !important; }
  .profileTabs.g-tabs .g-tabs-link:hover {
    color: #fff !important; text-shadow: 0 0 10px color-mix(in srgb, var(--sc-accent, #ff5500) 40%, transparent) !important;
  }
  .profileTabs.g-tabs .g-tabs-link.active {
    color: var(--sc-accent, #ff5500) !important;
    box-shadow: inset 0 -2px 0 var(--sc-accent, #ff5500) !important;
    text-shadow: 0 0 10px color-mix(in srgb, var(--sc-accent, #ff5500) 45%, transparent) !important;
  }

  /* ===== Edit Spotlight button group → theme ===== */
  .editSpotlight .sc-button {
    background: rgba(255,255,255,0.05) !important; border: 1px solid rgba(255,255,255,0.12) !important;
    border-radius: 9px !important; color: #d6d6db !important; box-shadow: none !important;
  }
  .editSpotlight .sc-button:hover {
    color: #fff !important; border-color: color-mix(in srgb, var(--sc-accent, #ff5500) 50%, transparent) !important;
  }
  .editSpotlight .sc-button-cta, .editSpotlight__saveButton {
    background: var(--sc-accent, #ff5500) !important; color: #fff !important; border-color: transparent !important;
  }

  /* ===== Search left panel (.l-fixed-left) → real acrylic side panel ===== */
  /* The outer .searchOptions + SC's scroll wrappers get sized to the full
     viewport by SC's JS — so keep them TRANSPARENT and let content flow, then
     put the acrylic box on the nav <ul> itself (it naturally wraps the 6 items). */
  .l-fixed-left .searchOptions,
  .l-fixed-left .searchOptions__scrollable,
  .l-fixed-left .searchOptions__scrollableInner,
  .l-fixed-left .searchOptions__container {
    background: transparent !important; border: 0 !important; box-shadow: none !important;
    backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
    padding: 0 !important; height: auto !important; max-height: none !important; overflow: visible !important;
  }
  .l-fixed-left .searchOptions__navigation {
    background: rgba(12,12,16,0.42) !important;
    border: 1px solid rgba(255,255,255,0.10) !important; border-radius: 14px !important;
    box-shadow: 0 18px 52px rgba(0,0,0,0.5) !important;
    backdrop-filter: blur(24px) saturate(1.5) !important; -webkit-backdrop-filter: blur(24px) saturate(1.5) !important;
    padding: 8px !important;
  }
  /* "Search results for …" title bar — was a solid black block; make it see-through. */
  .l-search .l-fixed-top, .l-search .searchTitle, .l-search .searchTitle__text {
    background: transparent !important; background-color: transparent !important;
    box-shadow: none !important; border: 0 !important;
    backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
  }
  .l-search .searchTitle__text { text-shadow: 0 1px 8px rgba(0,0,0,0.55) !important; }

  .searchOptions__navigationItem { border-radius: 9px !important; transition: background .12s ease !important; }
  .searchOptions__navigationItem .searchOptions__navigationLink { color: #b7b7ba !important; }
  .searchOptions__navigationItem:hover { background: rgba(255,255,255,0.06) !important; }
  .searchOptions__navigationItem:hover .searchOptions__navigationLink { color: #fff !important; }
  .searchOptions__navigationItem.active {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 20%, transparent) !important;
    box-shadow: inset 3px 0 0 var(--sc-accent, #ff5500) !important;
  }
  .searchOptions__navigationItem.active .searchOptions__navigationLink { color: var(--sc-accent, #ff5500) !important; }

  /* ===== Search suggestions dropdown → acrylic, see-through (was solid black) ===== */
  :has(> #searchMenuList), .headerSearch__autosuggests, .searchAutosuggests,
  .autosuggests, .header__search .autocomplete {
    background: rgba(12,12,16,0.5) !important;
    border: 1px solid rgba(255,255,255,0.10) !important; border-radius: 12px !important;
    box-shadow: 0 18px 52px rgba(0,0,0,0.55) !important;
    backdrop-filter: blur(24px) saturate(1.5) !important; -webkit-backdrop-filter: blur(24px) saturate(1.5) !important;
    overflow: hidden !important;
  }
  #searchMenuList, #searchMenuList li, .autosuggests li { background: transparent !important; }
  #searchMenuList li a, #searchMenuList li { color: #d4d4d7 !important; }
  #searchMenuList li:hover, #searchMenuList li.selected, #searchMenuList li[aria-selected="true"] {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 22%, transparent) !important;
  }

  /* ===== GO+ tier badge on covers → more visible / legible ===== */
  .tierIndicator__artwork { transform: scale(1.12) !important; z-index: 3 !important; }
  .tierIndicator__artwork svg { filter: drop-shadow(0 1px 4px rgba(0,0,0,0.9)) !important; }

  /* ===== Feed / stream track cards → subtle acrylic + flat themed action buttons ===== */
  .sound.streamContext .soundActions .sc-button, .soundList__item .soundActions .sc-button {
    background: transparent !important; border: 0 !important; box-shadow: none !important; border-radius: 8px !important;
  }
  .sound.streamContext .soundActions .sc-button:hover, .soundList__item .soundActions .sc-button:hover {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 15%, transparent) !important;
  }

  /* ===== Denser track lists (Library / Likes) — more music, less space ===== */
  .soundList__item, .trackList__item, .soundBadgeList__item, .systemPlaylistTrackList__item {
    padding-top: 5px !important; padding-bottom: 5px !important;
    margin-bottom: 4px !important; /* keeps a gap so rows never touch when zoomed out */
    border-radius: 8px !important; transition: background .1s ease !important;
  }
  .soundList__item:hover, .trackList__item:hover { background: rgba(255,255,255,0.04) !important; }
  .soundBadge, .sound__body, .soundBadge__additionalContent { min-height: 0 !important; }
  /* Hide the bulky per-row waveform in list views so rows are compact */
  .soundList__item .waveform, .soundList__item .sound__waveform,
  .trackList__item .waveform, .compactTrackListItem .waveform { display: none !important; }
  .soundList__item .image, .trackList__item .image { border-radius: 6px !important; }

  /* No white wash on artwork hover. The real image (.image__full) fades on hover
     revealing a light placeholder behind it — so keep it fully opaque, drop the
     placeholder background + light outline, and kill any hover overlay. */
  .image__full, .sc-artwork.image__full { opacity: 1 !important; }
  [class*="sc-artwork-placeholder"], .image__lightOutline {
    background-color: transparent !important;
  }
  .image__lightOutline { box-shadow: none !important; }
  .sound__artwork:hover .image, .audibleTile__artwork:hover .image,
  .sound__coverArt:hover .image, .image:hover, .sc-artwork:hover {
    filter: none !important; opacity: 1 !important;
  }
  .image__hover, .image__hoverBox, .imageOverlay, .artwork__overlay,
  .sound__coverArt::after, .sound__coverArt::before,
  .sound__artwork:hover::after, .sound__artwork:hover::before {
    background: none !important; box-shadow: none !important; opacity: 0 !important;
  }
  /* THE actual home-card wash: SoundCloud's .playableTile__imageOverlay */
  .playableTile__imageOverlay,
  .playableTile__artwork:hover .playableTile__imageOverlay,
  .playableTile.m-overlayOpen .playableTile__imageOverlay {
    background: none !important; background-color: transparent !important;
    box-shadow: none !important; opacity: 0 !important;
  }

  /* The "Fans" leaderboard is an <iframe> (webi embedded module) — keep it, make
     it transparent so it blends (JS moves it to the bottom of the sidebar). */
  .sidebarModule__webiEmbeddedModule, .webiEmbeddedModule,
  .webiEmbeddedModuleContainer, .webiEmbeddedModuleIframe {
    background: transparent !important; background-color: transparent !important;
    border: 0 !important; box-shadow: none !important;
  }

  /* Remove the "Insights / X plays / View your Insights" nag everywhere */
  .insightsSidebarModule { display: none !important; }
  /* Same treatment for the "ON TOUR" module — it is an Artist Pro upsell, not a
     tour listing. It is also the one sidebar frame that genuinely cannot be
     themed: artist-events.soundcloud.com is a DIFFERENT ORIGIN, so
     contentDocument is null and themeFrames() can never reach it. ?theme=dark
     makes the child declare color-scheme: dark, so Chromium paints an opaque
     canvas under it (hard rule 7) and it renders as a black rectangle punched
     through the cover background. mix-blend-mode does not rescue it either —
     cross-origin frames composite on their own layer, so the black survives.
     Nothing to theme, so drop the module. */
  .sidebarModule:has(> .sidebarContent > iframe.velvetCakeIframe) {
    display: none !important;
  }
  /* Feed should be just the feed — drop the whole right sidebar there */
  html.hoq-feed .l-sidebar-right { display: none !important; }
  html.hoq-feed .l-fluid-fixed .l-fluid, html.hoq-feed .l-fluid-fixed .stream,
  html.hoq-feed .l-fluid-fixed > div:not(.l-sidebar-right) {
    width: 100% !important; max-width: 100% !important; float: none !important;
  }

  /* ---- Kill Artist Pro / upgrade / creator upsell banners ---- */
  .tierBanner, .artistProUpsell, .upsellBanner, .proUpsell,
  .g-promo, .promoBanner, .creatorSubscriptions__upsell,
  [class*="Upsell"], [class*="upsell"], [data-testid*="upsell"] { display: none !important; }

  /* Onboarding coachmarks / hint bubbles ("Tap the heart…", "OK, got it") */
  [class*="oachmark" i], [class*="ntroBubble" i], [class*="onboardingTip" i],
  .tooltip.onboarding, .g-tooltip--onboarding { display: none !important; }

  /* ---- Kill Artist Tools / Insights / creator clutter (sidebar) ---- */
  .artistTools, .g-artist-tools, .creatorSubscriptions, .artistShortcuts,
  .artistProSection, .userInsights, .insightsModule { display: none !important; }

  /* ---- Kill header promo junk (Get $15, Artist Studio, Go Pro) ---- */
  .header a[href*="refer"], .header a[href*="invite"],
  .header a[href*="/pro"], .header a[href*="artist-studio"],
  .header a[href*="artist.soundcloud"], .header a[href*="creators"],
  .header .header__proLink, .header .header__link--pro { display: none !important; }

  /* ---- Recolor any leftover SoundCloud orange to your accent ---- */
  .sc-text-orange, .g-text-orange, [class*="orange" i] {
    color: var(--sc-accent, #ff5500) !important;
  }

  /* ===== Home polish — accent section headers, matching the library's clean look ===== */
  .lazyLoadingList { margin-bottom: 26px !important; }
  .lazyLoadingList__header, .sectionHead__title,
  .soundList > .soundList__header .soundTitle__title {
    font-weight: 800 !important; letter-spacing: .2px !important; color: #fff !important;
    padding-left: 13px !important; position: relative !important;
  }
  .lazyLoadingList__header::before, .sectionHead__title::before {
    content: '' !important; position: absolute !important; left: 0 !important;
    top: 16% !important; bottom: 16% !important;
    width: 4px !important; border-radius: 3px !important;
    background: var(--sc-accent, #ff5500) !important;
  }
  /* framed home shortcut / mix modules so they read as cards like the library */
  .homeShortcutsModule__item, .mixedSelectionModule__item {
    border-radius: 14px !important;
  }

  /* Lucide (stroke) icons we inject — force outline rendering */
  svg.lucide { fill: none !important; }
  svg.lucide path, svg.lucide circle, svg.lucide line, svg.lucide rect,
  svg.lucide polyline, svg.lucide polygon { fill: none !important; }
  /* Swap SC's header notification (bell) + messages icons via CSS MASK only —
     NO DOM writes (mutating SC's React DOM tore out the header buttons). Hide the
     real svg and paint the holder div in currentColor, masked to the new shape. */
  .notificationIcon.activities > div > svg,
  .notificationIcon.messages > div > svg { display: none !important; }
  .notificationIcon.activities > div,
  .notificationIcon.messages > div {
    display: inline-block !important; width: 22px !important; height: 22px !important;
    background-color: currentColor !important;
    -webkit-mask-repeat: no-repeat !important; mask-repeat: no-repeat !important;
    -webkit-mask-position: center !important; mask-position: center !important;
    -webkit-mask-size: 22px 22px !important; mask-size: 22px 22px !important;
  }
  .notificationIcon.activities > div {
    -webkit-mask-image: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M10.268 21a2 2 0 0 0 3.464 0'/><path d='M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326'/></svg>") !important;
    mask-image: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M10.268 21a2 2 0 0 0 3.464 0'/><path d='M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326'/></svg>") !important;
  }
  .notificationIcon.messages > div {
    -webkit-mask-image: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M12.7 3H4a2 2 0 0 0-2 2v16.286a.71.71 0 0 0 1.212.502l2.202-2.202A2 2 0 0 1 6.828 19H20a2 2 0 0 0 2-2v-4.7'/><circle cx='19' cy='6' r='3'/></svg>") !important;
    mask-image: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M12.7 3H4a2 2 0 0 0-2 2v16.286a.71.71 0 0 0 1.212.502l2.202-2.202A2 2 0 0 1 6.828 19H20a2 2 0 0 0 2-2v-4.7'/><circle cx='19' cy='6' r='3'/></svg>") !important;
  }

  /* Sidebar related-tracks badges: pop out in 3D on hover */
  .soundBadgeList .soundBadge, .sidebarContent .soundBadge {
    border-radius: 10px !important;
    transition: transform .16s ease, box-shadow .16s ease, background .16s ease !important;
  }
  .soundBadgeList .soundBadge:hover, .sidebarContent .soundBadge:hover {
    transform: translateY(-2px) scale(1.02) !important;
    box-shadow: none !important;
    z-index: 5 !important; position: relative !important;
  }
  /* Flatten the badge's ♥/⋯ action toolbar so it doesn't read as a box inside the
     row (the "double layer"). SoundCloud's CSS loads AFTER ours, so we need HIGHER
     specificity than their .soundActions__small.m-my-controls-active / .sc-button-selected
     rules — hence the extra class qualifiers below. */
  .soundBadge .soundBadge__additional, .soundBadge .soundBadge__actions,
  .soundBadge .soundBadge__actions .soundActions,
  .soundBadge .soundActions.soundActions__small,
  .soundBadge .soundActions.soundActions__small.m-my-controls-active,
  .soundBadge .soundBadge__actions .sc-button-toolbar,
  .soundBadge .soundBadge__actions .sc-button-group {
    background: transparent !important; background-color: transparent !important;
    background-image: none !important; /* kill the 270deg surface-color fade box */
    box-shadow: none !important; border: 0 !important;
  }
  .soundBadge .soundBadge__actions .sc-button.sc-button-secondary,
  .soundBadge .soundBadge__actions .sc-button-group .sc-button {
    background: transparent !important; background-color: transparent !important;
    border: 0 !important; box-shadow: none !important;
    border-radius: 7px !important; transition: background .12s ease, color .12s ease !important;
  }
  .soundBadge .soundBadge__actions .sc-button-group .sc-button:hover,
  .soundBadge .soundBadge__actions .sc-button-group .sc-button.sc-button-selected,
  .soundBadge .soundBadge__actions .sc-button.sc-button-more.sc-button-selected {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 18%, transparent) !important;
    background-color: color-mix(in srgb, var(--sc-accent, #ff5500) 18%, transparent) !important;
    color: var(--sc-accent, #ff5500) !important;
  }
  /* Kill SoundCloud's own background box on the badge itself (the OUTER layer) —
     our pop-out is shadow-only, so the badge fill must stay transparent in every
     state (hover / m-my-controls-active). */
  .soundBadgeList .soundBadge.compact, .soundBadgeList .soundBadge.m-interactive,
  .soundBadgeList__item .soundBadge, .sidebarContent .soundBadge.compact,
  .soundBadgeList .soundBadge.compact:hover, .soundBadgeList__item:hover .soundBadge {
    background: transparent !important; background-color: transparent !important;
  }
  .soundBadgeList .soundBadge__artwork .image, .sidebarContent .soundBadge__artwork .image {
    border-radius: 9px !important; overflow: hidden !important;
  }

  /* Tags (e.g. "Dance & EDM") — themed accent pill with glow on hover */
  .sc-tag {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 12%, rgba(255,255,255,0.05)) !important;
    border: 1px solid color-mix(in srgb, var(--sc-accent, #ff5500) 30%, transparent) !important;
    color: color-mix(in srgb, var(--sc-accent, #ff5500) 55%, #e2e2e5) !important;
    border-radius: 8px !important;
    transition: background .12s ease, border-color .12s ease, color .12s ease, box-shadow .12s ease !important;
  }
  .sc-tag:hover {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 22%, transparent) !important;
    border-color: color-mix(in srgb, var(--sc-accent, #ff5500) 55%, transparent) !important;
    color: #fff !important;
    box-shadow: 0 0 12px color-mix(in srgb, var(--sc-accent, #ff5500) 28%, transparent) !important;
  }

  /* Toggles (Reposts etc.) — accent TRACK (not SoundCloud orange); knob stays white */
  .sc-toggle.sc-toggle-active, .sc-toggle.sc-toggle-on {
    background-color: var(--sc-accent, #ff5500) !important;
    border-color: var(--sc-accent, #ff5500) !important;
    box-shadow: 0 0 8px color-mix(in srgb, var(--sc-accent, #ff5500) 40%, transparent) !important;
  }
  .sc-toggle.sc-toggle-active::before, .sc-toggle.sc-toggle-on::before {
    background-color: var(--sc-accent, #ff5500) !important;
  }
  .sc-toggle.sc-toggle-active .sc-toggle-handle { background-color: #fff !important; }

  /* Discover tile carousel: snappier tile animation + slightly rounder artwork */
  .tileGallery__sliderPanelSlide .playableTile { transition: transform .12s ease !important; }
  /* carousel forward/back arrows → themed acrylic, accent glow on hover */
  .tileGallery__sliderButton {
    background: rgba(255,255,255,0.06) !important; border: 1px solid rgba(255,255,255,0.12) !important;
    color: #d6d6db !important; box-shadow: none !important; border-radius: 50% !important;
    backdrop-filter: blur(14px) saturate(1.3) !important; -webkit-backdrop-filter: blur(14px) saturate(1.3) !important;
    transition: background .15s ease, color .15s ease, border-color .15s ease, box-shadow .15s ease !important;
  }
  .tileGallery__sliderButton:hover {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 22%, transparent) !important;
    border-color: color-mix(in srgb, var(--sc-accent, #ff5500) 55%, transparent) !important;
    color: #fff !important;
    box-shadow: 0 0 14px color-mix(in srgb, var(--sc-accent, #ff5500) 32%, transparent) !important;
  }
  .tileGallery__sliderButton svg { fill: currentColor !important; }
  .tileGallery .playableTile__image .image, .playableTile__image .image {
    border-radius: 12px !important; overflow: hidden !important;
  }
  /* Home "More of what you like" (+ similar) headers: a soft accent glow so the
     white text feels part of the themed/blended page instead of a harsh label
     floating over the wash. */
  .mixedSelectionModule__titleText, .mixedSelectionModule__title,
  .selectionTitle__title, .selectionTitle {
    /* dim, but tinted toward the playing song's accent so it feels themed */
    color: color-mix(in srgb, var(--sc-accent, #ff5500) 34%, #b4b4bc) !important;
    text-shadow: 0 0 15px color-mix(in srgb, var(--sc-accent, #ff5500) 45%, transparent),
                 0 1px 3px rgba(0,0,0,0.5) !important;
  }
  /* the descriptive sub-header line under those titles: mute it so it recedes */
  .mixedSelectionModule__subtitle, .mixedSelectionModule__descriptionText,
  .mixedSelectionModule__subtitleText, .selectionTitle__secondary,
  .mixedSelectionModule__secondaryText {
    color: rgba(214,214,220,0.62) !important;
    text-shadow: 0 1px 3px rgba(0,0,0,0.4) !important;
  }
  /* give the existing library-style headers the same gentle glow for consistency */
  .lazyLoadingList__header, .sectionHead__title {
    text-shadow: 0 0 15px color-mix(in srgb, var(--sc-accent, #ff5500) 40%, transparent),
                 0 1px 3px rgba(0,0,0,0.5) !important;
  }

  /* ===== 3D tilt on home tiles (JS sets a self-contained perspective() per tile,
     so we DON'T set transform-style:preserve-3d on the list — that created a 3D
     context that clipped the tile titles when zoomed out) ===== */
  .playableTile.hoq-tilt, .audibleTile.hoq-tilt,
  .homeShortcutsModule__item.hoq-tilt, .mixedSelectionModule__item.hoq-tilt {
    will-change: transform; position: relative !important; z-index: 20 !important;
  }

  /* ===== Track-page cover: dynamic 3D that follows the mouse (JS sets transform;
     we only ever touch transform/box-shadow so the layout can't break) ===== */
  .fullHero__artwork {
    transition: transform .12s ease, box-shadow .35s ease !important;
    transform-style: preserve-3d !important; will-change: transform;
  }
  .fullHero__artwork:hover { box-shadow: 0 26px 46px rgba(0,0,0,0.45) !important; }

  /* ===== Like state ===== */
  .sc-button-like { transition: transform .12s ease, box-shadow .12s ease, background .12s ease !important; }
  .sc-button-like:not(.sc-button-selected) { opacity: .8 !important; }
  .sc-button-like:not(.sc-button-selected):hover { opacity: 1 !important; }
  /* liked: accent heart with a soft glow (default) */
  .sc-button-like.sc-button-selected {
    color: var(--sc-accent, #ff5500) !important; fill: var(--sc-accent, #ff5500) !important;
    filter: drop-shadow(0 0 2px color-mix(in srgb, var(--sc-accent, #ff5500) 45%, transparent)) !important;
  }
  /* Some hearts (esp. comment likes) hard-code fill="#f50" as a presentation
     attribute on the <path>, which beats CSS fill on the button — override the
     path/svg directly so the heart follows the song accent. */
  .sc-button-like.sc-button-selected svg,
  .sc-button-like.sc-button-selected svg path,
  .sc-button-like.sc-button-selected svg * {
    fill: var(--sc-accent, #ff5500) !important;
  }
  /* strong glow ONLY on the real like TOGGLE (action bar + player bar) */
  .soundActions .sc-button-like.sc-button-selected,
  .sound__soundActions .sc-button-like.sc-button-selected,
  .listenEngagement__actions .sc-button-like.sc-button-selected,
  .playControls .sc-button-like.sc-button-selected,
  .playbackSoundBadge__like.sc-button-selected {
    filter: drop-shadow(0 0 6px var(--sc-accent, #ff5500))
            drop-shadow(0 0 2px var(--sc-accent, #ff5500)) !important;
  }
  /* engagement STAT counts (10.7K / 479 / 20): just color, NEVER a glow/box
     (that double-glow on the count was the bugged red box) */
  .sc-ministats .sc-button-like, [class*="ministat" i] .sc-button-like,
  .listenEngagement__stats .sc-button-like, .soundStats .sc-button-like,
  .sound__footer .sc-ministats, .sound__footer .sc-ministats * {
    filter: none !important; box-shadow: none !important;
    background: transparent !important; border: 0 !important;
  }
  /* tiles: minimal glow */
  .playableTile .sc-button-like.sc-button-selected,
  .audibleTile .sc-button-like.sc-button-selected,
  .sound__coverArt .sc-button-like.sc-button-selected,
  .mixedSelectionModule__item .sc-button-like.sc-button-selected,
  .homeShortcutsModule__item .sc-button-like.sc-button-selected {
    filter: drop-shadow(0 0 1.5px color-mix(in srgb, var(--sc-accent, #ff5500) 40%, transparent)) !important;
  }
  /* Action toolbar (Repost / Share / Copy / Add / More) — flat + clean, accent hover */
  .soundActions .sc-button, .sound__soundActions .sc-button, .listenEngagement__actions .sc-button {
    background: transparent !important; border: 0 !important; box-shadow: none !important;
    border-radius: 8px !important; transition: background .12s ease, filter .12s ease !important;
  }
  .soundActions .sc-button:hover, .sound__soundActions .sc-button:hover,
  .listenEngagement__actions .sc-button:hover {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 15%, transparent) !important;
  }

  /* ===== Track-row hover actions (heart / repost / "...") — no dark box, flat ===== */
  .soundActions__small, .soundActions__medium, .trackItem__actions, .trackItem__additional,
  .soundBadge__actions, .compactTrackListItem__additional,
  .sound__soundActions .sc-button-toolbar, .trackItem__actions .sc-button-group {
    background: transparent !important; box-shadow: none !important; border: 0 !important;
  }
  .soundActions__small .sc-button, .soundActions__medium .sc-button,
  .trackItem__actions .sc-button, .soundBadge__actions .sc-button {
    background: transparent !important; border: 0 !important; box-shadow: none !important;
    border-radius: 7px !important; transition: background .12s ease !important;
  }
  .soundActions__small .sc-button:hover, .soundActions__medium .sc-button:hover,
  .trackItem__actions .sc-button:hover, .soundBadge__actions .sc-button:hover {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 15%, transparent) !important;
  }

  /* ===== Comments: like button (was a black box) + "Write a comment" bar ===== */
  .commentsList .sc-button-like, .commentItem .sc-button-like, .comment .sc-button-like,
  .commentActions .sc-button, .commentItem__actions .sc-button, .comment__actions .sc-button {
    background: transparent !important; border: 0 !important; box-shadow: none !important;
    border-radius: 8px !important;
  }
  .commentsList .sc-button-like:hover, .commentItem .sc-button-like:hover {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 14%, transparent) !important;
  }
  /* Write-a-comment box → match the app. Only the INPUT gets the box; the form
     wrapper stays transparent (styling both = the double layer). */
  .commentForm, .addCommentForm, .commentForm__inner { background: transparent !important; border: 0 !important; box-shadow: none !important; }
  .commentForm__input, .comment__input, .commentInput,
  .commentForm .sc-input, .commentForm textarea,
  .commentForm input[type="text"], .commentForm [contenteditable] {
    background: rgba(255,255,255,0.05) !important;
    border: 1px solid rgba(255,255,255,0.08) !important;
    border-radius: 10px !important; color: #e4e4e6 !important; box-shadow: none !important;
  }
  .commentForm__input:focus, .commentForm .sc-input:focus,
  .commentForm textarea:focus, .commentForm [contenteditable]:focus {
    border-color: var(--sc-accent, #ff5500) !important; outline: none !important;
  }

  /* ===== Clean song-row hover — subtle accent wash + soft glow (not flat black) ===== */
  .soundList__item:hover, .trackList__item:hover, .searchList__item:hover,
  .soundBadgeList__item:hover, .systemPlaylistTrackList__item:hover,
  .trackItem:hover, .queueItemView:hover, .listenNetworkItem:hover,
  .compactTrackListItem:hover {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 8%, rgba(255,255,255,0.02)) !important;
    border-radius: 10px !important;
    box-shadow: none !important;
    transition: background .14s ease !important;
  }
  /* kill SoundCloud's own darker hover layer underneath so ours is the only one */
  .trackList__item:hover .trackItem, .systemPlaylistTrackList__item:hover .trackItem,
  .soundList__item:hover > .sound, .trackList__item:hover > * {
    background: transparent !important;
  }

  /* ===== Frosted "acrylic" header popovers ("..." menu, Notifications, DMs) =====
     Everything lives inside .dropdownMenu; give THAT the single glass pane and
     make SoundCloud's inner solid wrappers transparent so it isn't double-layered. */
  .dropdownMenu {
    background: rgba(12,12,16,0.42) !important;
    border: 1px solid rgba(255,255,255,0.10) !important;
    border-radius: 14px !important;
    box-shadow: 0 18px 52px rgba(0,0,0,0.5) !important;
    backdrop-filter: blur(24px) saturate(1.5) !important;
    -webkit-backdrop-filter: blur(24px) saturate(1.5) !important;
    overflow: hidden !important;
  }
  /* clear the inner solid wrappers SoundCloud paints (the "double layer") */
  .dropdownMenu > *, .dropdownMenu .dropdownContent, .dropdownMenu .dropdownContent__container,
  .dropdownMenu .dropdownContent__header, .dropdownMenu .dropdownContent__list,
  .dropdownMenu .moreActions, .dropdownMenu .moreActions__list {
    background: transparent !important; border: 0 !important; box-shadow: none !important;
    backdrop-filter: none !important;
  }
  /* When a dropdownMenu wraps a .linkMenu (comment-sort AND the Library
     "All / Created / Liked" filter), let the .linkMenu be the SINGLE acrylic pane
     — make the outer shell + its scrollable wrappers transparent (no double glass). */
  .dropdownMenu:has(.linkMenu) {
    background: transparent !important; border: 0 !important; box-shadow: none !important;
    backdrop-filter: none !important; -webkit-backdrop-filter: none !important; overflow: visible !important;
  }
  .linkMenu .g-scrollable, .linkMenu .g-scrollable-inner, .linkMenu__scrollable {
    background: transparent !important; border: 0 !important;
  }
  /* No scrollbars in these panels (wheel still scrolls) */
  .dropdownMenu, .dropdownMenu * { scrollbar-width: none !important; -ms-overflow-style: none !important; }
  .dropdownMenu::-webkit-scrollbar, .dropdownMenu *::-webkit-scrollbar {
    width: 0 !important; height: 0 !important; display: none !important;
  }
  /* Style ONLY the action-menu rows (Repost / Share / Add to Playlist…). Those
     dropdowns have no .dropdownContent, unlike Notifications/DMs — so this leaves
     the notification + message layouts completely alone. */
  .dropdownMenu:not(:has(.dropdownContent)) .sc-button,
  .dropdownMenu:not(:has(.dropdownContent)) button,
  .dropdownMenu:not(:has(.dropdownContent)) a[role="menuitem"] {
    display: flex !important; align-items: center !important; gap: 10px !important;
    width: 100% !important; justify-content: flex-start !important; text-align: left !important;
    background: transparent !important; border: 0 !important; box-shadow: none !important;
    border-radius: 8px !important; color: #d4d4d7 !important; font-weight: 600 !important;
    padding: 8px 11px !important; transition: background .12s ease, color .12s ease !important;
  }
  .dropdownMenu:not(:has(.dropdownContent)) .sc-button:hover,
  .dropdownMenu:not(:has(.dropdownContent)) button:hover,
  .dropdownMenu:not(:has(.dropdownContent)) a[role="menuitem"]:hover {
    background: var(--sc-accent, #ff5500) !important; color: #fff !important;
  }
  .dropdownMenu:not(:has(.dropdownContent)) .sc-button:hover * { color: #fff !important; }

  /* ===== Comment-sort dropdown (.linkMenu: Newest / Oldest / Track Time) =====
     Same acrylic glass as the header popovers (.dropdownMenu) — low-alpha fill so
     the frost actually shows, slim rows. */
  /* The popover wrapper SoundCloud renders AROUND .linkMenu is solid — clear it
     (and any solid ancestor between it and the page) so the glass pane can
     actually frost the content behind it instead of blurring a solid slab. */
  :has(> .linkMenu) {
    background: transparent !important; background-color: transparent !important;
    box-shadow: none !important; border: 0 !important; backdrop-filter: none !important;
  }
  .linkMenu {
    /* light-topped gradient so it reads as glass even over dark comment area */
    background: linear-gradient(180deg, rgba(46,46,54,0.5) 0%, rgba(18,18,24,0.42) 100%) !important;
    border: 1px solid rgba(255,255,255,0.12) !important;
    border-radius: 14px !important;
    box-shadow: 0 18px 52px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.10) !important;
    backdrop-filter: blur(24px) saturate(1.5) !important;
    -webkit-backdrop-filter: blur(24px) saturate(1.5) !important;
    overflow: hidden !important;
    padding: 5px !important;
  }
  /* clear any solid inner wrappers so the single glass pane shows through */
  .linkMenu > *, .linkMenu__list, .linkMenu__group, .linkMenu__item {
    background: transparent !important; border: 0 !important;
    margin: 0 !important; padding: 0 !important; box-shadow: none !important;
    backdrop-filter: none !important;
  }
  /* Rounded, inset pills — the fill lives on the link, not the full-width row, so
     it doesn't bleed to the menu edges as a hard rectangle. Slim padding. */
  .linkMenu__link {
    display: block !important; border-radius: 8px !important;
    padding: 6px 12px !important; margin: 1px 0 !important;
    color: #d4d4d7 !important; font-weight: 600 !important; min-height: 0 !important;
    transition: background .12s ease, color .12s ease !important;
  }
  .linkMenu__item:hover .linkMenu__link {
    background: rgba(255,255,255,0.08) !important; color: #fff !important;
  }
  .linkMenu__activeItem .linkMenu__link {
    background: var(--sc-accent, #ff5500) !important; color: #fff !important;
  }
  /* The "Sorted by: Newest" button that opens the menu — transparent + accent
     glow so it matches the themed dropdown instead of SC's grey pill. */
  .commentsList__sortSelect .select__dropdownButton,
  .commentsList__sortSelect .sc-button-dropdown {
    background: transparent !important; background-color: transparent !important;
    border: 1px solid rgba(255,255,255,0.12) !important; border-radius: 10px !important;
    color: color-mix(in srgb, var(--sc-accent, #ff5500) 30%, #d6d6db) !important;
    box-shadow: none !important;
    text-shadow: 0 0 10px color-mix(in srgb, var(--sc-accent, #ff5500) 35%, transparent) !important;
    transition: border-color .15s ease, box-shadow .15s ease, color .15s ease !important;
  }
  .commentsList__sortSelect .select__dropdownButton:hover,
  .commentsList__sortSelect .sc-button-dropdown:hover {
    color: #fff !important;
    border-color: color-mix(in srgb, var(--sc-accent, #ff5500) 55%, transparent) !important;
    box-shadow: 0 0 15px color-mix(in srgb, var(--sc-accent, #ff5500) 32%, transparent) !important;
  }
  .commentsList__sortSelect .select__dropdownButton svg { fill: currentColor !important; }

  /* ===== Modals incl. the Share popup — acrylic glass ===== */
  .modal__modal, .g-modal, .shareSheet, .sharePanel, .share__inner,
  [class*="shareModal" i], [class*="ShareModal"], .modal[aria-modal] > div {
    background: rgba(14,14,18,0.72) !important;
    border: 1px solid rgba(255,255,255,0.10) !important;
    border-radius: 16px !important;
    box-shadow: 0 26px 74px rgba(0,0,0,0.62) !important;
    backdrop-filter: blur(24px) saturate(1.45) !important;
    -webkit-backdrop-filter: blur(24px) saturate(1.45) !important;
  }
  /* dim + blur the page behind the modal */
  .modal__background, .modalBackground, .g-modal-overlay, .modal__overlay {
    background: rgba(0,0,0,0.5) !important;
    backdrop-filter: blur(5px) !important; -webkit-backdrop-filter: blur(5px) !important;
  }
`;

// ---------------------------------------------------------------------------
// NEW ("webi V2") track page. It renders inside a same-origin iframe
// (soundcloud.com/n/<user>/<track>?v2_layout=true, class .webiIframeV2Layout)
// and is built entirely from MUI components, so none of the BEM selectors above
// reach it. Everything here is token-first: MUI reads its own CSS variables, so
// repointing the tokens themes whole component families at once.
// ---------------------------------------------------------------------------
const MUI_CSS = `
  /* --- design tokens -------------------------------------------------------
     SoundCloud ships these as a near-white ramp (#FAFAFA, then 0.6 / 0.16
     alphas). Repoint the whole ramp at the accent and every MUI surface that
     consumes it follows: buttons, chips, tabs, sliders, the waveform. */
  :root, html, [data-mui-color-scheme] {
    --mui-palette-primary-main: var(--sc-accent, #ff5500) !important;
    --mui-palette-primary-dark: color-mix(in srgb, var(--sc-accent, #ff5500) 78%, #000) !important;
    --mui-palette-primary-light: color-mix(in srgb, var(--sc-accent, #ff5500) 72%, #fff) !important;
    --mui-palette-primary-mainChannel: var(--sc-accent-ch, 255 85 0) !important;
    --mui-palette-primary-contrastText: #fff !important;

  }

  /* The track waveform is an <svg> of <rect>s painted straight from the
     "contrast" palette:
         contrastText -> played bars (and the playhead line)
         light        -> unplayed bars
         dark         -> the mirrored reflection under the centre line
     contrastTextChannel is consumed as rgba(var(--...) / .5) for the centre
     rule, so it MUST be space-separated channels — a hex can't satisfy it
     (applyAccent keeps --sc-accent-ch in sync).

     These have to stay SCOPED TO THE WAVEFORM. MUI paints the track header's
     text out of contrast-contrastText as well — the title, the artist/tag/date
     caption, the elapsed time, the like count — so repointing it on :root
     turned the whole header monochrome accent instead of white. The slider
     element wraps the bars AND both presentation rules (centre line, playhead),
     so scoping it here still reaches everything the waveform draws. */
  [aria-label="Waveform"] {
    --mui-palette-contrast-contrastText: var(--sc-accent, #ff5500) !important;
    --mui-palette-contrast-contrastTextChannel: var(--sc-accent-ch, 255 85 0) !important;
    --mui-palette-contrast-light: color-mix(in srgb, var(--sc-accent, #ff5500) 52%, transparent) !important;
    --mui-palette-contrast-dark: color-mix(in srgb, var(--sc-accent, #ff5500) 28%, transparent) !important;
  }

  /* Top-frame side of the same fix: the <iframe> element itself must not paint
     an opaque box over #sc-bg either. */
  .webiIframe, .webiIframeV2Layout { background: transparent !important; }

  /* --- buttons ------------------------------------------------------------- */
  .MuiButton-contained.MuiButton-colorPrimary {
    background: var(--sc-accent-bg, #ff5500) !important;
    background-color: var(--sc-accent, #ff5500) !important;
    color: #fff !important;
  }
  .MuiButton-contained.MuiButton-colorPrimary:hover { filter: brightness(1.12); }
  /* Hero play button: outlined + colorContrast. Fill it so it reads as the
     primary action the way the old .sc-button-play did. */
  .MuiButton-outlined.MuiButton-colorContrast {
    border-color: color-mix(in srgb, var(--sc-accent, #ff5500) 55%, transparent) !important;
    color: var(--sc-accent, #ff5500) !important;
  }
  .MuiButton-outlined.MuiButton-colorContrast:hover {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 16%, transparent) !important;
    border-color: var(--sc-accent, #ff5500) !important;
  }
  .MuiButton-text.MuiButton-colorPrimary { color: var(--sc-accent, #ff5500) !important; }

  /* --- icon buttons (share / link / repost / add / more / like) ------------- */
  .MuiIconButton-colorContrast {
    border: 1px solid color-mix(in srgb, var(--sc-accent, #ff5500) 26%, rgba(255,255,255,0.10)) !important;
  }
  .MuiIconButton-colorContrast:hover {
    color: var(--sc-accent, #ff5500) !important;
    border-color: var(--sc-accent, #ff5500) !important;
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 14%, transparent) !important;
  }
  .MuiIconButton-colorPrimary:hover { color: var(--sc-accent, #ff5500) !important; }

  /* --- chips: comment timestamps + tag pills -------------------------------- */
  .MuiChip-filled.MuiChip-colorSecondary {
    background-color: color-mix(in srgb, var(--sc-accent, #ff5500) 20%, transparent) !important;
    color: var(--sc-accent, #ff5500) !important;
    border: 1px solid color-mix(in srgb, var(--sc-accent, #ff5500) 32%, transparent) !important;
  }
  .MuiChip-filled.MuiChip-colorSecondary:hover {
    background-color: color-mix(in srgb, var(--sc-accent, #ff5500) 34%, transparent) !important;
  }
  .MuiChip-filled.MuiChip-colorSecondary .MuiChip-label,
  .MuiChip-filled.MuiChip-colorSecondary .MuiTypography-root { color: inherit !important; }

  /* --- tabs (Fans "Top" / "First") ------------------------------------------ */
  .MuiTab-root.Mui-selected { color: var(--sc-accent, #ff5500) !important; }
  .MuiTabs-indicator { background-color: var(--sc-accent, #ff5500) !important; }

  /* --- sliders (comment-position handle over the waveform) ------------------ */
  .MuiSlider-colorPrimary .MuiSlider-track {
    background-color: var(--sc-accent, #ff5500) !important;
    border-color: var(--sc-accent, #ff5500) !important;
  }
  .MuiSlider-colorPrimary .MuiSlider-thumb { color: var(--sc-accent, #ff5500) !important; }

  /* --- links ---------------------------------------------------------------- */
  .MuiLink-root:hover { color: var(--sc-accent, #ff5500) !important; }
  /* Links inside track descriptions / comment bodies are plain <a>, not MuiLink,
     so they keep MUI's default blue unless we claim them here. */
  .MuiTypography-body a, .MuiTypography-body2 a, .MuiTypography-caption a[href] {
    color: var(--sc-accent, #ff5500) !important;
  }

  /* --- comment box ---------------------------------------------------------- */
  .MuiOutlinedInput-root .MuiOutlinedInput-notchedOutline {
    border-color: rgba(255,255,255,0.10) !important;
  }
  .MuiOutlinedInput-root:hover .MuiOutlinedInput-notchedOutline {
    border-color: color-mix(in srgb, var(--sc-accent, #ff5500) 45%, transparent) !important;
  }
  .MuiOutlinedInput-root.Mui-focused .MuiOutlinedInput-notchedOutline {
    border-color: var(--sc-accent, #ff5500) !important; border-width: 1px !important;
  }
  .MuiInputBase-input { caret-color: var(--sc-accent, #ff5500) !important; }

  /* --- surfaces: cards + dividers match the app's frosted look -------------- */
  .MuiCard-root, .MuiPaper-contained {
    background: rgba(255,255,255,0.035) !important;
    border: 1px solid color-mix(in srgb, var(--sc-accent, #ff5500) 16%, rgba(255,255,255,0.07)) !important;
    border-radius: 12px !important; background-image: none !important;
  }
  .MuiDivider-root { border-color: rgba(255,255,255,0.08) !important; }

  /* --- per-row "Play in Discord" (addQueueButtons) --------------------------
     Lives in both documents, so it is defined outside the .hoq-webi scope. */
  .hoq-q {
    position: absolute; top: 6px; right: 6px; z-index: 20;
    width: 26px; height: 26px; padding: 0; border-radius: 999px;
    display: flex; align-items: center; justify-content: center;
    border: 1px solid color-mix(in srgb, var(--sc-accent, #ff5500) 42%, transparent);
    background: rgba(16,16,20,0.72);
    backdrop-filter: blur(10px) saturate(150%); -webkit-backdrop-filter: blur(10px) saturate(150%);
    color: var(--sc-accent, #ff5500); cursor: pointer;
    opacity: 0; transform: translateY(-3px);
    transition: opacity .15s ease, transform .15s ease, background .15s ease;
  }
  *:hover > .hoq-q, .hoq-q:focus-visible { opacity: 1; transform: none; }
  .hoq-q:hover { background: rgba(28,28,34,0.9); }
  .hoq-q svg { width: 13px; height: 13px; }
  .hoq-q.done {
    background: var(--sc-accent, #ff5500); color: #fff; opacity: 1;
    transform: none; border-color: transparent; cursor: default;
  }

  /* --- webi V2 frame only --------------------------------------------------
     themeFrames() tags the iframe's document with .hoq-webi so these can't leak
     into the top frame (which paints its own background and would go see-through). */

  /* The iframe paints an opaque canvas over #sc-bg, which is why the cover
     background never showed behind the new page. Make it see-through so the
     frosted panels below have something to actually blur. */
  html.hoq-webi, html.hoq-webi body,
  html.hoq-webi #navigation-shell-right-side-container, html.hoq-webi #main {
    background: transparent !important; background-image: none !important;
  }
  /* THE reason the frame stayed black. With color-scheme:dark on an iframe's
     ROOT element, Chromium paints its own opaque dark canvas underneath the
     document — transparent backgrounds on html/body do not defeat it. Clearing
     it on the root lets #sc-bg show through; re-declaring it on <body> keeps
     form controls and scrollbars dark, since that only needs an ancestor. */
  html.hoq-webi { color-scheme: normal !important; }
  html.hoq-webi body { color-scheme: dark; }

  /* Panels pick up the same acrylic as the rest of the app. */
  html.hoq-webi.sc-coverbg section[aria-label="Track header"],
  html.hoq-webi.sc-coverbg aside[aria-label="Track sidebar"] .MuiCard-root,
  html.hoq-webi.sc-coverbg aside[aria-label="Track sidebar"] .MuiPaper-contained {
    background: rgba(12,12,14,0.3) !important;
    backdrop-filter: blur(24px) saturate(1.35) !important;
    -webkit-backdrop-filter: blur(24px) saturate(1.35) !important;
    border: 1px solid color-mix(in srgb, var(--sc-accent, #ff5500) 16%, rgba(255,255,255,0.08)) !important;
    border-radius: 14px !important;
  }
  /* Inner wrappers ship their own solid fills that would sit on top of the blur. */
  html.hoq-webi section[aria-label="Track header"] > .MuiStack-root,
  html.hoq-webi section[aria-label="Track header"] .MuiStack-root > .MuiStack-root {
    background: transparent !important; background-image: none !important;
  }

  /* --- waveform: SVG <rect>s, not the legacy <canvas> ----------------------
     buildCustomWave() can't reach these (it reads canvas pixels), so instead of
     replacing the bars we restyle them to read like .hoq-wave: capsule caps and
     an accent glow. Keeping SC's own SVG means seeking and the comment markers
     keep working. The glow goes on the parent <g>, not per-rect — there are 500+
     rects and a filter on each one is a separate composite. */
  html.hoq-webi [aria-label="Waveform"] rect {
    rx: 1.2px; ry: 1.2px;
    /* fill-box so the hover ripple's scaleY pivots on each bar's own centre */
    transform-box: fill-box; transform-origin: center;
    transition: transform .12s ease;
  }
  html.hoq-webi [aria-label="Waveform"] svg > g {
    filter: drop-shadow(0 0 2.5px color-mix(in srgb, var(--sc-accent, #ff5500) 42%, transparent));
  }
  html.hoq-no-wave [aria-label="Waveform"] rect { transform: none !important; }

  /* --- hero play button: the same moulded accent lozenge as the legacy page --- */
  html.hoq-webi section[aria-label="Track header"] .MuiButton-outlined.MuiButton-colorContrast {
    background: linear-gradient(145deg, var(--sc-accent, #ff5500),
                color-mix(in srgb, var(--sc-accent, #ff5500) 65%, #000)) !important;
    border: 0 !important; border-radius: 16px !important; color: #fff !important;
    box-shadow: 0 10px 26px color-mix(in srgb, var(--sc-accent, #ff5500) 50%, transparent),
                inset 0 1px 0 rgba(255,255,255,0.35) !important;
    transition: transform .14s ease, box-shadow .14s ease !important;
  }
  html.hoq-webi section[aria-label="Track header"] .MuiButton-outlined.MuiButton-colorContrast:hover {
    transform: scale(1.07) !important;
    box-shadow: 0 14px 34px color-mix(in srgb, var(--sc-accent, #ff5500) 65%, transparent),
                inset 0 1px 0 rgba(255,255,255,0.45) !important;
  }

  /* --- section headings: accent rule + glow, matching .sectionHead__title ----- */
  html.hoq-webi h2.MuiTypography-h5 {
    font-weight: 800 !important; letter-spacing: .2px !important; color: #fff !important;
    padding-left: 13px !important; position: relative !important;
    text-shadow: 0 0 18px color-mix(in srgb, var(--sc-accent, #ff5500) 45%, transparent);
  }
  html.hoq-webi h2.MuiTypography-h5::before {
    content: '' !important; position: absolute !important; left: 0 !important;
    top: 16% !important; bottom: 16% !important;
    width: 4px !important; border-radius: 3px !important;
    background: var(--sc-accent, #ff5500) !important;
  }
  html.hoq-no-glow h2.MuiTypography-h5 { text-shadow: none !important; }

  /* --- sidebar: stat numbers + support heading carry the accent -------------- */
  html.hoq-webi aside[aria-label="Track sidebar"] .MuiTypography-h2 {
    color: var(--sc-accent, #ff5500) !important;
  }

  /* --- rows lift toward the cursor like the legacy sound badges -------------- */
  html.hoq-webi [role="listitem"] {
    border-radius: 12px !important;
    transition: transform .14s ease, background-color .14s ease !important;
  }
  html.hoq-webi:not(.hoq-no-hover) [role="listitem"]:hover {
    transform: translateY(-2px) !important;
    background-color: color-mix(in srgb, var(--sc-accent, #ff5500) 10%, transparent) !important;
  }

  /* --- cover wash: bleed the artwork's colour into the hero, radially masked
         so it fades out instead of ending on a hard rounded edge --------------- */
  html.hoq-webi.sc-coverbg section[aria-label="Track header"] { position: relative !important; }
  html.hoq-webi.sc-coverbg section[aria-label="Track header"]::before {
    content: ''; position: absolute; inset: 0; pointer-events: none; z-index: 0;
    border-radius: inherit;
    background: radial-gradient(78% 78% at 50% 30%,
      color-mix(in srgb, var(--sc-accent, #ff5500) 26%, transparent), transparent 70%);
  }
  html.hoq-webi section[aria-label="Track header"] > * { position: relative; z-index: 1; }

  /* --- track header polish -------------------------------------------------
     Anchored on aria-label and MUI's stable API classes; the mui-xxxxx hashes
     are emotion-generated and already changed once between SoundCloud builds. */
  html.hoq-webi section[aria-label="Track header"] {
    border-radius: 16px !important;
    padding: 20px 22px !important;
  }
  /* The frame begins flush under the app's top bar, so the header card's top
     edge and border collided with the chrome. Gap it off, matching the 20px the
     layout already leaves down each side. #main sits inside the scroll
     container, so the gap scrolls away with the content.
     SoundCloud is migrating more pages into these frames, so the gap is keyed
     to a header actually being there. The bounded "> * >" keeps the :has() off
     a whole-subtree scan. */
  html.hoq-webi #main:has(> * > section[aria-label="Track header"]) {
    padding-top: 16px !important;
  }
  html.hoq-webi section[aria-label="Track header"] h1.MuiTypography-h1 {
    line-height: 1.14 !important;
    letter-spacing: -0.2px !important;
    text-shadow: 0 2px 16px rgba(0,0,0,0.5);
  }
  /* The comment markers sit right under the waveform; give the pair room so the
     header doesn't read as one cramped block. */
  html.hoq-webi section[aria-label="Track header"] [aria-label="Waveform"] {
    margin-top: 4px !important;
  }
  /* Comment box: match the pill shape of the action buttons beside it. */
  html.hoq-webi section[aria-label="Track header"] .MuiOutlinedInput-root {
    border-radius: 999px !important;
    background: rgba(255,255,255,0.05) !important;
  }
  /* Give the like count and action circles a consistent weight. */
  html.hoq-webi section[aria-label="Track header"] .MuiIconButton-colorContrast {
    background: rgba(255,255,255,0.04) !important;
  }

  /* --- artwork: let the 3D tilt actually show ------------------------------
     The wrapper chain clips and flattens by default, so the rotate would be
     sheared off at the card edge. overflow:visible has to go on the GRANDparent
     — putting it on the frame that holds the <img> is what let the artwork
     spill past its own rounded corners. */
  html.hoq-webi section[aria-label="Track header"] .MuiBox-root:has(> .MuiBox-root > img[src*="artworks-"]) {
    overflow: visible !important;
  }
  /* The frame itself keeps clipping; the shadow still paints outside it. */
  html.hoq-webi section[aria-label="Track header"] .MuiBox-root:has(> img[src*="artworks-"]) {
    overflow: hidden !important; border-radius: 12px;
    transform-style: preserve-3d; will-change: transform;
    box-shadow: 0 18px 44px rgba(0,0,0,0.55),
                0 0 0 1px color-mix(in srgb, var(--sc-accent, #ff5500) 22%, transparent);
  }
  html.hoq-webi section[aria-label="Track header"] img[src*="artworks-"] {
    border-radius: 12px; cursor: pointer;
  }

  /* --- track sidebar panels ------------------------------------------------
     The artist card and the three stat tiles are plain MuiStack/MuiBox, NOT
     MuiCard/MuiPaper, so the acrylic rule further up never reached them: they
     stayed on SoundCloud's flat #212121 while the header went frosted. Anchor
     on what each panel actually contains. The 64px on the avatar is load
     bearing — without it the same shape also matches the "N others like this"
     row, which is transparent by design and should stay that way. */
  html.hoq-webi.sc-coverbg aside[aria-label="Track sidebar"] .MuiStack-root:has(> .MuiStack-root > a > img[sizes="64px"]),
  html.hoq-webi.sc-coverbg aside[aria-label="Track sidebar"] .MuiStack-root:has(> .MuiTypography-h2) {
    background: rgba(12,12,14,0.3) !important;
    backdrop-filter: blur(24px) saturate(1.35) !important;
    -webkit-backdrop-filter: blur(24px) saturate(1.35) !important;
    border: 1px solid color-mix(in srgb, var(--sc-accent, #ff5500) 16%, rgba(255,255,255,0.08)) !important;
    border-radius: 14px !important;
  }

  /* --- track header action row ---------------------------------------------
     Like / comment field / share / copy / repost / playlist / more. The circles
     are 42px with a 1px accent edge, but MUI draws the comment field's border
     on its <fieldset>, not on the input root — so the field rendered 40px tall
     and apparently borderless beside them. Two pixels out and one missing edge
     reads as a mistake rather than a choice; put the row on one height and one
     edge. */
  html.hoq-webi section[aria-label="Track header"] .MuiOutlinedInput-root {
    min-height: 42px !important;
  }
  html.hoq-webi section[aria-label="Track header"] .MuiOutlinedInput-notchedOutline {
    border-color: color-mix(in srgb, var(--sc-accent, #ff5500) 26%, rgba(255,255,255,0.10)) !important;
  }
  /* Liked reads as accent, the way the player bar's heart already does. */
  html.hoq-webi section[aria-label="Track header"] button[aria-label="Unlike"] {
    color: var(--sc-accent, #ff5500) !important;
    border-color: color-mix(in srgb, var(--sc-accent, #ff5500) 55%, transparent) !important;
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 12%, transparent) !important;
  }
`;

function injectBaseCSS() {
  if (document.getElementById('sc-desktop-style')) return;
  const style = document.createElement('style');
  style.id = 'sc-desktop-style';
  style.textContent = BASE_CSS + MUI_CSS;
  (document.head || document.documentElement).appendChild(style);
}

// The legacy waveform's signature hover ripple, ported onto the SVG bars. Only
// the bars inside the ripple window get written to — there are 500+ rects, so
// transforming all of them every frame would be pure waste — and the previous
// window is cleared as the cursor moves on. Bars come in top/bottom pairs, so
// adjacent indices scale together, which is exactly the mirrored look we want.
function attachWaveRipple(d) {
  if (d.__hoqRipple) return;
  d.__hoqRipple = true;
  const view = d.defaultView || window;
  const W = 0.08; // ripple reaches ~8% of the waveform either side of the cursor
  let raf = 0, mx = -1, prev = null;
  const run = () => {
    raf = 0;
    const svg = d.querySelector('[aria-label="Waveform"] svg');
    if (!svg) return;
    const rects = svg.querySelectorAll('rect');
    const N = rects.length;
    if (!N) return;
    const clear = (r) => { if (r) for (let i = r[0]; i <= r[1] && i < N; i++) rects[i].style.transform = ''; };
    if (mx < 0 || !effectOn('wave')) { clear(prev); prev = null; return; }
    const lo = Math.max(0, Math.floor((mx - W) * N));
    const hi = Math.min(N - 1, Math.ceil((mx + W) * N));
    clear(prev);
    for (let i = lo; i <= hi; i++) {
      const boost = 1 - Math.min(1, Math.abs(i / N - mx) / W);
      rects[i].style.transform = boost > 0 ? 'scaleY(' + (1 + boost * 0.5).toFixed(3) + ')' : '';
    }
    prev = [lo, hi];
  };
  const schedule = () => { if (!raf) raf = view.requestAnimationFrame(run); };
  d.addEventListener('mousemove', (e) => {
    const wf = d.querySelector('[aria-label="Waveform"]');
    if (!wf) { if (mx !== -1) { mx = -1; schedule(); } return; }
    const r = wf.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right &&
                   e.clientY >= r.top && e.clientY <= r.bottom;
    const nx = inside ? (e.clientX - r.left) / r.width : -1;
    if (nx !== mx) { mx = nx; schedule(); }
  }, { passive: true });
  d.addEventListener('mouseleave', () => { mx = -1; schedule(); }, { passive: true });
}

// setupCoverTilt() only listens in the top frame and only knows the legacy
// .fullHero__artwork, so the new page's cover sat there inert. Same 3D follow,
// re-bound inside the frame and hung off the artwork's wrapper so the whole card
// tilts rather than just the <img>.
function attachCoverTilt(d) {
  if (d.__hoqTilt) return;
  d.__hoqTilt = true;
  const view = d.defaultView || window;
  let art = null, px = 0, py = 0, raf = 0;
  const apply = () => {
    raf = 0;
    if (art) {
      art.style.transform =
        'perspective(1000px) rotateY(' + (px * 17).toFixed(2) + 'deg) rotateX(' +
        (-py * 12).toFixed(2) + 'deg) scale(1.02)';
    }
  };
  d.addEventListener('mousemove', (e) => {
    if (!effectOn('tilt')) {
      if (art) { art.style.transition = 'transform .4s ease'; art.style.transform = ''; art = null; }
      return;
    }
    const img = e.target.closest && e.target.closest(
      'section[aria-label="Track header"] img[fetchpriority="high"][crossorigin], ' +
      'section[aria-label="Track header"] img[src*="artworks-"]');
    const a = img ? img.parentElement : null;
    if (a !== art) {
      if (art) { art.style.transition = 'transform .4s ease'; art.style.transform = ''; }
      art = a;
      if (art) { art.style.transition = 'transform .1s ease'; art.style.willChange = 'transform'; }
    }
    if (!art) return;
    const r = art.getBoundingClientRect();
    px = (e.clientX - r.left) / r.width - 0.5;
    py = (e.clientY - r.top) / r.height - 0.5;
    if (!raf) raf = view.requestAnimationFrame(apply);
  }, { passive: true });
  d.addEventListener('mouseleave', () => {
    if (art) { art.style.transition = 'transform .4s ease'; art.style.transform = ''; art = null; }
  }, { passive: true });
}

// The webi V2 iframe does not reliably receive the injected preload, and even
// when it does it reads the SAVED accent from localStorage — so cover-match
// never reaches it. Pushing the stylesheet and the live accent vars in from the
// top frame fixes both at once, and survives the iframe re-navigating.
function themeFrames() {
  if (window.top !== window) return;
  const cs = getComputedStyle(document.documentElement);
  const vars = ['--sc-accent', '--sc-accent-bg', '--sc-accent-ch', '--wave-color'];
  document.querySelectorAll('iframe').forEach((f) => {
    let d = null;
    try { d = f.contentDocument; } catch (e) { return; } // cross-origin: not ours
    if (!d || !d.documentElement) return;
    try {
      if (!d.getElementById('sc-desktop-style')) {
        const st = d.createElement('style');
        st.id = 'sc-desktop-style';
        st.textContent = BASE_CSS + MUI_CSS;
        (d.head || d.documentElement).appendChild(st);
      }
      vars.forEach((v) => {
        const val = cs.getPropertyValue(v);
        if (val) d.documentElement.style.setProperty(v, val.trim(), 'important');
      });
      // Mirror OUR html classes across. The frosted-glass rules are gated on
      // .sc-coverbg and the optional effects on .hoq-*, and the iframe's own
      // <html> never gets them — which is why the new page stayed unfrosted.
      // Only our own tokens move; SoundCloud's classes on that element stay put.
      const mine = [...document.documentElement.classList].filter((c) => /^(sc-|hoq-)/.test(c));
      [...d.documentElement.classList].forEach((c) => {
        if (/^(sc-|hoq-)/.test(c) && c !== 'hoq-webi' && !mine.includes(c)) {
          d.documentElement.classList.remove(c);
        }
      });
      mine.forEach((c) => d.documentElement.classList.add(c));
      d.documentElement.classList.add('hoq-webi'); // scopes the frame-only rules
      attachWaveRipple(d);
      attachCoverTilt(d);
      addQueueButtons(d);
      attachFrameContextMenu(d, f);
    } catch (e) {}
  });
}

// ---------------------------------------------------------------------------
// Accent (color / gradient) — persisted in localStorage
// ---------------------------------------------------------------------------
const DEFAULT_ACCENT = { c1: '#ff5500', c2: '#ff8800', grad: false };

const ACCENT_VAR = 'var(--sc-accent, #ff5500)';

// Elements already repainted (so we don't re-scan them every tick). NOT permanent:
// SoundCloud is an SPA and its newer MUI surfaces resolve their theme tokens AFTER
// hydration, so an element can turn orange long after we first walked past it. We
// forget the whole cache on navigation, and forget individual elements when their
// class/style changes (see the attribute observer below).
let _seenOrange = new WeakSet();
let _seenPath = location.pathname;

// Is a computed value SoundCloud-orange? (matches #ff5500/#ff3300/#ff7700-ish, but
// not the red close button, reds, or ambers/yellows.) Scans EVERY color in the
// string, not just the first — gradients and box-shadows carry several.
//   b <= 90 (was 30) picks up the newer MUI tokens and color-mix() results whose
//   blue channel drifts up, while g - b > 35 is what keeps red out: SC orange has
//   green well above blue (#ff5500 -> 85), the red close button does not
//   (#ff5f57 -> 8).
function isOrange(str) {
  const re = /rgba?\((\d+),\s*(\d+),\s*(\d+)/g;
  let m;
  while ((m = re.exec(str || ''))) {
    const r = +m[1], g = +m[2], b = +m[3];
    if (r >= 235 && g >= 30 && g <= 140 && b <= 90 && g - b > 35) return true;
  }
  return false;
}

// Map one orange stop onto the accent while PRESERVING its lightness relative to
// SoundCloud's base #ff5500. Without this a two-tone orange gradient collapses to
// one flat accent and the badge/pill loses its depth.
function accentStop(r, g, b, a) {
  const lum = (rr, gg, bb) => (0.2126 * rr + 0.7152 * gg + 0.0722 * bb) / 255;
  const d = lum(r, g, b) - lum(255, 85, 0);
  let col = ACCENT_VAR;
  if (d > 0.04) col = 'color-mix(in srgb, ' + ACCENT_VAR + ' ' + Math.max(35, Math.round(100 - d * 160)) + '%, #fff)';
  else if (d < -0.04) col = 'color-mix(in srgb, ' + ACCENT_VAR + ' ' + Math.max(35, Math.round(100 + d * 160)) + '%, #000)';
  // Keep any alpha the original stop carried (shadows lean on it heavily).
  if (a != null && a < 1) col = 'color-mix(in srgb, ' + col + ' ' + Math.round(a * 100) + '%, transparent)';
  return col;
}

// Swap only the orange stops of a gradient/shadow, keeping its shape intact.
function accentize(value) {
  return value.replace(/rgba?\(([^)]*)\)/g, (whole, inner) => {
    if (!isOrange(whole)) return whole;
    const p = inner.split(',').map((n) => parseFloat(n));
    return accentStop(p[0], p[1], p[2], p.length > 3 ? p[3] : null);
  });
}

// Repaint any orange badge/dot/text to the current accent.
function recolorOrange() {
  if (_seenPath !== location.pathname) { _seenPath = location.pathname; _seenOrange = new WeakSet(); }
  const els = document.querySelectorAll('*');
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    if (_seenOrange.has(el) || el.id === 'sc-titlebar' || el.closest('#sc-titlebar, #sc-palette, .header__upsellWrapper, .header__forArtistsButton')) {
      continue;
    }
    _seenOrange.add(el);
    const cs = getComputedStyle(el);
    let painted = false;
    const paint = (prop, val) => { el.style.setProperty(prop, val, 'important'); painted = true; };
    if (isOrange(cs.backgroundColor)) paint('background-color', ACCENT_VAR);
    if (isOrange(cs.color)) paint('color', ACCENT_VAR);
    if (isOrange(cs.borderTopColor)) paint('border-color', ACCENT_VAR);
    // SVG icons: SoundCloud paints a lot of them with an inline fill="#f50", which
    // no stylesheet rule of ours reaches without a bespoke per-icon selector.
    if (isOrange(cs.fill)) paint('fill', ACCENT_VAR);
    if (isOrange(cs.stroke)) paint('stroke', ACCENT_VAR);
    // Gradients live in background-image, so background-color never sees them —
    // this is what left the Go+ tier badge (.tierIndicator__*) orange.
    if (cs.backgroundImage && cs.backgroundImage !== 'none' && isOrange(cs.backgroundImage)) {
      paint('background-image', accentize(cs.backgroundImage));
    }
    if (isOrange(cs.boxShadow)) paint('box-shadow', accentize(cs.boxShadow));
    if (painted) el.dataset.hoqPaint = '1';
  }
}

// Re-queue elements whose class/style changed so a late theme pass can't leave
// orange behind. Our own repaint writes to style, so ignore those or an element
// we just painted would loop back in forever. Top frame only — recolorOrange()
// runs from removeClutter(), which boot() skips in subframes.
if (window.top === window) {
  try {
    new MutationObserver((muts) => {
      for (let i = 0; i < muts.length; i++) {
        const t = muts[i].target;
        if (!t || t.nodeType !== 1) continue;
        if (muts[i].attributeName === 'style' && t.dataset && t.dataset.hoqPaint) continue;
        _seenOrange.delete(t);
      }
    }).observe(document.documentElement, {
      attributes: true, subtree: true, attributeFilter: ['class', 'style'],
    });
  } catch (e) {}
}

function readAccent() {
  try {
    return { ...DEFAULT_ACCENT, ...JSON.parse(localStorage.getItem('scAccent')) };
  } catch {
    return { ...DEFAULT_ACCENT };
  }
}

// Hue (degrees) of a hex color — used to hue-rotate the canvas waveform.
function hexToHue(hex) {
  let h = (hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  let hue;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  hue *= 60;
  return hue < 0 ? hue + 360 : hue;
}

function applyAccent(a, dontSave) {
  const bg = a.grad ? `linear-gradient(135deg, ${a.c1}, ${a.c2})` : a.c1;
  const root = document.documentElement;
  root.style.setProperty('--sc-accent', a.c1);
  root.style.setProperty('--sc-accent-bg', bg);
  // MUI's newer tokens are consumed as rgba(var(--...Channel) / alpha), which a
  // hex value cannot satisfy — keep space-separated channels alongside.
  try { root.style.setProperty('--sc-accent-ch', _hexToRgb(a.c1).join(' ')); } catch (e) {}
  if (!dontSave) localStorage.setItem('scAccent', JSON.stringify(a));
  try { themeFrames(); } catch (e) {}
}

// The waveform's played color follows the CURRENTLY PLAYING song's cover (not the
// selected accent) — hue-rotate SoundCloud's ~19° orange toward the cover's hue.
function setWaveHue(hex) {
  // our waveform's played bars follow the current cover color
  if (hex) document.documentElement.style.setProperty('--wave-color', hex);
}

// Build our OWN waveform: read the bar shape from SoundCloud's canvas, render our
// own bars over it (colored by the accent), and hide SC's canvas (kept beneath so
// clicks still seek). Rebuilds on track change; progress updates on a tick.
function buildCustomWave() {
  // The main track-page waveform on ANY layout (newer "webi" or classic A/B group):
  // pick the widest .waveform that isn't a comment/modal/dropdown/share popup.
  const wf = document.querySelector('.fullListenHero .waveform, .fullHero .waveform') ||
    Array.from(document.querySelectorAll('.waveform'))
      .filter((w) => !w.closest('.modal, .dropdownMenu, .commentPopover, [class*="share" i]') &&
        w.getBoundingClientRect().width > 400)
      .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
  if (!wf) return;
  if (wf.getBoundingClientRect().width < 300) return;
  const canvas = wf.querySelector('canvas');
  if (!canvas || !canvas.width) return;

  const key = (currentCoverUrl() || location.pathname) + ':' + canvas.width;
  const existing = wf.querySelector(':scope > .hoq-wave');
  if (existing && existing.dataset.key === key) { updateWaveProgress(); return; }

  let heights;
  try {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height, half = h / 2;
    const data = ctx.getImageData(0, 0, w, h).data;
    const N = Math.min(220, Math.max(64, Math.floor(wf.getBoundingClientRect().width / 4)));
    heights = [];
    const step = w / N;
    for (let i = 0; i < N; i++) {
      const x = Math.min(w - 1, Math.floor(i * step + step / 2));
      let top = half;
      for (let y = 0; y < half; y++) { if (data[(y * w + x) * 4 + 3] > 24) { top = y; break; } }
      heights.push(Math.max(0.08, (half - top) / half));
    }
  } catch (e) { return; } // canvas not ready / unreadable → leave SC's waveform visible

  const barsHtml = heights.map((a) => '<i style="height:' + (a * 100).toFixed(1) + '%"></i>').join('');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = 'hoq-wave';
  el.dataset.key = key;
  el.innerHTML = '<div class="bars un">' + barsHtml + '</div><div class="bars pl">' + barsHtml + '</div>';
  wf.appendChild(el);
  wf.classList.add('hoq-cw');
  updateWaveProgress();
}

function updateWaveProgress() {
  const el = document.querySelector('.hoq-wave');
  if (!el) return;
  const pr = playerProgress();
  const frac = pr.dur > 0 ? Math.min(1, Math.max(0, pr.pos / pr.dur)) : 0;
  el.style.setProperty('--wave-prog', (frac * 100).toFixed(2) + '%');
}

// ---------------------------------------------------------------------------
// Bottom-player VISUALIZER — the seek bar rendered as a flowing glow waveform
// that REACTS to the actual audio (oscilloscope of the live signal) when SC is
// playing via MSE (a same-origin blob: audio element — safe to tap with Web
// Audio). Falls back to a procedural flowing line for the rarer cross-origin
// progressive streams (tapping those would mute playback). Played portion glows
// in the song accent; ends taper to the midline so they aren't cut off. Canvas
// is pointer-events:none so SoundCloud's seek/drag still works.
// ---------------------------------------------------------------------------
// Optional visual effects, toggled from the palette. Default ON (return true
// unless explicitly saved '0'). Effects: 'viz' (song bar), 'tilt' (3D tilt),
// 'wave' (interactive waveform).
function effectOn(name) { return localStorage.getItem('scFx_' + name) !== '0'; }
function applyVizState() {
  const on = effectOn('viz');
  window.__hoqVizOn = on;
  document.documentElement.classList.toggle('hoq-noviz', !on);
}
// CSS-gated optional effects. Default-ON ones: OFF adds html.hoq-no-<name> to
// revert. Opt-in ones (default OFF): ON adds html.hoq-<name> to apply.
const HOQ_CSS_FX = ['pulse', 'round', 'hover', 'anim', 'frost', 'glow'];
const HOQ_OPTIN_FX = ['gray', 'ambient'];
function applyFxClasses() {
  HOQ_CSS_FX.forEach((n) => document.documentElement.classList.toggle('hoq-no-' + n, !effectOn(n)));
  HOQ_OPTIN_FX.forEach((n) => document.documentElement.classList.toggle('hoq-' + n, localStorage.getItem('scFx_' + n) === '1'));
}

function startPlayerViz() {
  if (window.__hoqViz) return;
  window.__hoqViz = true;
  let canvas = null, ctx = null, wrap = null, amp = 0, accent = '#ff5500', accentTick = 0;
  // Web Audio analyser (real reactivity) — bound lazily to the playing element.
  let actx = null, analyser = null, boundEl = null, td = null;
  const tried = new WeakSet();
  function ensureAnalyser() {
    const els = Array.from(document.querySelectorAll('audio, video'));
    const el = els.find((e) => (e.currentSrc || e.src || '').startsWith('blob:')) || null;
    if (!el) return null;                       // no MSE element → procedural
    if (boundEl === el && analyser) return analyser;
    if (tried.has(el)) return boundEl === el ? analyser : null;
    tried.add(el);
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const a = actx.createAnalyser();
      a.fftSize = 1024; a.smoothingTimeConstant = 0.72;
      const src = actx.createMediaElementSource(el); // routes audio through the graph…
      src.connect(a); a.connect(actx.destination);   // …then back out so it stays audible
      analyser = a; boundEl = el; td = new Uint8Array(a.fftSize);
      return analyser;
    } catch (e) { analyser = null; return null; }   // fall back to procedural, never break audio
  }

  function ensure() {
    wrap = document.querySelector('.playbackTimeline__progressWrapper') ||
           document.querySelector('.playControls__progress');
    if (!wrap) { canvas = ctx = null; return false; }
    if (!canvas || !canvas.isConnected || canvas.parentElement !== wrap) {
      canvas = wrap.querySelector(':scope > .hoq-viz');
      if (!canvas) { canvas = document.createElement('canvas'); canvas.className = 'hoq-viz'; wrap.appendChild(canvas); }
      ctx = canvas.getContext('2d');
    }
    return true;
  }

  function frame(t) {
    requestAnimationFrame(frame);
    try {
      if (window.__hoqVizOn === false) return; // disabled via palette → SC's plain bar shows
      if (!ensure()) return;
      const r = wrap.getBoundingClientRect();
      if (r.width < 24) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = Math.round(r.width), H = 34;
      if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
        canvas.width = W * dpr; canvas.height = H * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      // refresh the song accent occasionally (cheap-ish getComputedStyle)
      if (!(accentTick++ % 30)) {
        const c = getComputedStyle(document.documentElement).getPropertyValue('--sc-accent').trim();
        if (c) accent = c;
      }
      // played fraction straight from SC's own progress (follows the track exactly)
      const bar = document.querySelector('.playbackTimeline__progressBar');
      let frac = bar ? bar.getBoundingClientRect().width / r.width : 0;
      if (!isFinite(frac)) frac = 0;
      frac = Math.min(1, Math.max(0, frac));

      const pr = playerProgress();
      const an = ensureAnalyser();
      if (an && actx && actx.state === 'suspended') { try { actx.resume(); } catch (e) {} }
      let live = false;
      if (an && !pr.paused) { an.getByteTimeDomainData(td); live = true; }
      amp += ((pr.paused ? 0.04 : 1) - amp) * 0.08; // ease in/out (flat when paused)

      const pad = 3, IW = Math.max(1, W - pad * 2), midY = H / 2, maxA = H * 0.40;
      // taper: 0 at both ends → the line meets the midline cleanly (no cut edges)
      const win = (nx) => Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, nx))), 0.7);
      const sample = (nx) => live
        ? ((td[Math.min(td.length - 1, Math.round(nx * (td.length - 1)))] - 128) / 128) * 1.5
        : (Math.sin(nx * 6.3 + t * 0.0016) * 0.60 +
           Math.sin(nx * 13.1 - t * 0.0023) * 0.28 +
           Math.sin(nx * 21.0 + t * 0.0034) * 0.16);
      const yAt = (x) => {
        const nx = (x - pad) / IW;
        let v = sample(nx) * win(nx) * amp * maxA;
        if (v > maxA) v = maxA; else if (v < -maxA) v = -maxA;
        return midY + v;
      };
      const path = () => {
        ctx.beginPath();
        for (let x = pad; x <= W - pad; x += 2) { const y = yAt(x); x === pad ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
      };
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';

      // unplayed: dim, full span
      path();
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.20)'; ctx.shadowBlur = 0; ctx.stroke();

      // played: bright accent + glow, clipped to the progress region
      const pplayed = pad + frac * IW;
      if (frac > 0.001) {
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, pplayed, H); ctx.clip();
        path();
        ctx.lineWidth = 2.4; ctx.strokeStyle = accent;
        ctx.shadowColor = accent; ctx.shadowBlur = 9; ctx.stroke();
        ctx.restore();
      }
      // playhead dot sitting on the line
      const py = yAt(pplayed);
      ctx.beginPath(); ctx.arc(pplayed, py, 3.4, 0, 6.2832);
      ctx.fillStyle = '#fff'; ctx.shadowColor = accent; ctx.shadowBlur = 11; ctx.fill();
    } catch (e) { /* keep the loop alive */ }
  }
  requestAnimationFrame(frame);
}

// Interactive waveform: bars near the cursor rise up (a wave that follows the
// mouse). Overlay is pointer-events:none, so this never affects click-to-seek.
function setupWaveInteract() {
  let mx = -1, raf = 0;
  const schedule = () => { if (!raf) raf = requestAnimationFrame(apply); };
  function apply() {
    raf = 0;
    if (!effectOn('wave')) { document.querySelectorAll('.hoq-wave .bars i').forEach((b) => b.style.transform = ''); return; }
    document.querySelectorAll('.hoq-wave .bars').forEach((layer) => {
      const bars = layer.children, N = bars.length;
      for (let i = 0; i < N; i++) {
        if (mx < 0) { bars[i].style.transform = ''; continue; }
        const d = Math.abs(i / N - mx);
        const boost = d < 0.08 ? (1 - d / 0.08) : 0;   // ripple within ~8% of the cursor
        // LIFT the bars toward the cursor (a travelling crest) instead of scaling
        // their height — scaling made tall bars clip into a solid block.
        bars[i].style.transform = boost > 0 ? 'translateY(' + (-boost * 13).toFixed(1) + 'px)' : '';
      }
    });
  }
  document.addEventListener('mousemove', (e) => {
    const w = document.querySelector('.fullListenHero .waveform, .fullHero .waveform');
    if (!w) { if (mx !== -1) { mx = -1; schedule(); } return; }
    const r = w.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    const nx = inside ? (e.clientX - r.left) / r.width : -1;
    if (nx !== mx) { mx = nx; schedule(); }
  }, { passive: true });
}

function readZoom() { const z = parseFloat(localStorage.getItem('scZoom')); return isNaN(z) ? 1 : z; }
function applyZoom(z) {
  const v = Math.max(0.6, Math.min(1.4, Math.round(z * 20) / 20));
  document.documentElement.style.setProperty('--sc-list-zoom', v);
  localStorage.setItem('scZoom', String(v));
  const lbl = document.getElementById('sc-zoomval');
  if (lbl) lbl.textContent = Math.round(v * 100) + '%';
  return v;
}

// ---------------------------------------------------------------------------
// "Match song cover": pull the two dominant colors from the now-playing artwork
// and use them as the accent gradient, updating on each track change.
// ---------------------------------------------------------------------------
const _toHex = (c) => '#' + [c.r, c.g, c.b].map((x) => ('0' + Math.round(x).toString(16)).slice(-2)).join('');

// HSL helpers (hexToHue above only ever needed the hue).
function _hexToRgb(h) {
  h = (h || '').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function _rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return [h < 0 ? h + 360 : h, s, l];
}
function _hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const seg = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h / 60) % 6];
  return _toHex({ r: (seg[0] + m) * 255, g: (seg[1] + m) * 255, b: (seg[2] + m) * 255 });
}

// Greyscale artwork (pencil sketches, b&w photos) has no pixel that clears the
// chroma gate above, so extraction falls back to the flat image average — that is
// what washed the whole app grey and collapsed the gradient into one repeated
// stop. Lift weak colors to a saturation floor so they still read as a tint, keep
// the two stops apart so the gradient keeps its depth, and for genuinely
// achromatic art fall back to the accent the user actually picked rather than
// inventing a hue that isn't in the image.
const COVER_MIN_SAT = 0.42, COVER_MIN_L = 0.34, COVER_MAX_L = 0.72;
// The cover IS the page background, so a fixed brightness() is wrong: dark art
// blurs down to black and bright art washes out to haze. Aim the wash at a
// constant perceived lightness by dividing the target by the artwork's own
// luminance, so every cover lands in the same readable band.
function setBgBrightness(hex) {
  try {
    const rgb = _hexToRgb(hex);
    const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
    const v = Math.max(0.5, Math.min(2.0, 0.36 / Math.max(0.06, lum)));
    document.documentElement.style.setProperty('--sc-bg-bright', v.toFixed(2));
  } catch (e) {}
}

function normalizeCoverColors(c1, c2) {
  const [h1, s1, l1] = _rgbToHsl(..._hexToRgb(c1));
  if (s1 < 0.06) {
    const saved = readAccent();
    return { c1: saved.c1, c2: saved.c2, grad: saved.grad };
  }
  const clampL = (l) => Math.min(COVER_MAX_L, Math.max(COVER_MIN_L, l));
  const a1 = _hslToHex(h1, Math.max(s1, COVER_MIN_SAT), clampL(l1));
  const [h2, s2, l2] = _rgbToHsl(..._hexToRgb(c2 || c1));
  let dh = Math.abs(h2 - h1);
  if (dh > 180) dh = 360 - dh;
  const a2 = (dh < 12 && Math.abs(l2 - l1) < 0.1)
    ? _hslToHex(h1 + 28, Math.max(s1, COVER_MIN_SAT), clampL(l1 + 0.14))
    : _hslToHex(h2, Math.max(s2, COVER_MIN_SAT * 0.8), clampL(l2));
  return { c1: a1, c2: a2, grad: true };
}

function coverColors(url, cb) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      const S = 28;
      const cv = document.createElement('canvas');
      cv.width = S; cv.height = S;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0, S, S);
      const d = ctx.getImageData(0, 0, S, S).data; // throws if CORS-tainted
      const buckets = {};
      let avg = { r: 0, g: 0, b: 0, n: 0 };
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
        if (a < 200) continue;
        avg.r += r; avg.g += g; avg.b += b; avg.n++;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const sat = mx - mn, light = (mx + mn) / 2;
        if (sat < 42 || light < 28 || light > 235) continue; // skip greys / extremes
        const key = (r >> 5) + '_' + (g >> 5) + '_' + (b >> 5);
        const bk = buckets[key] || (buckets[key] = { r: 0, g: 0, b: 0, n: 0, sat: 0 });
        bk.r += r; bk.g += g; bk.b += b; bk.n++; bk.sat += sat;
      }
      const arr = Object.values(buckets).map((bk) => ({
        r: bk.r / bk.n, g: bk.g / bk.n, b: bk.b / bk.n, score: bk.sat,
      })).sort((x, y) => y.score - x.score);
      if (arr.length === 0) {
        if (avg.n) { const c = { r: avg.r / avg.n, g: avg.g / avg.n, b: avg.b / avg.n }; cb({ c1: _toHex(c), c2: _toHex(c), avg: _toHex(c) }); }
        else cb(null);
        return;
      }
      // `avg` is every pixel, not just the chromatic ones — it's the honest
      // measure of how dark the artwork actually is, which is what the blurred
      // background needs (the dominant colour is picked for chroma, not lightness).
      const avgHex = avg.n ? _toHex({ r: avg.r / avg.n, g: avg.g / avg.n, b: avg.b / avg.n }) : null;
      cb({ c1: _toHex(arr[0]), c2: _toHex(arr[1] || arr[0]), avg: avgHex });
    } catch (e) { cb(null); } // CORS-tainted canvas
  };
  img.onerror = () => cb(null);
  img.src = url;
}

// The cover of the track page you are LOOKING at, which is not necessarily the
// one playing — opening a song should hand the whole app that song's colors even
// before you hit play. On the new webi V2 page the hero artwork lives inside the
// same-origin iframe, so we have to reach in for it; the legacy hero is a plain
// background-image on a span.
const NOT_A_TRACK = /^(you|discover|feed|search|stream|library|upload|settings|pages|tags|n|messages|notifications)$/i;
function pageCoverUrl() {
  const seg = location.pathname.split('/').filter(Boolean);
  if (seg.length !== 2 || NOT_A_TRACK.test(seg[0]) || seg[1] === 'sets') return null;
  const big = (u) => u.replace(/-t\d+x\d+\./, '-t500x500.').replace(/-large\./, '-t500x500.');
  // Order matters: the track header also holds the commenter avatars pinned over
  // the waveform and the comment-box avatar, and both sit BEFORE the artwork in
  // DOM order. The artwork is the one SoundCloud marks high-priority and loads
  // with crossorigin (it feeds their own colour sampling); "artworks-" in the
  // path is the fallback tell.
  const HERO = [
    'section[aria-label="Track header"] img[fetchpriority="high"][crossorigin]',
    'section[aria-label="Track header"] img[src*="artworks-"]',
    'img[fetchpriority="high"][crossorigin][src*="sndcdn"]',
  ];
  for (const f of document.querySelectorAll('iframe')) {
    let d = null;
    try { d = f.contentDocument; } catch (e) { continue; } // cross-origin
    if (!d) continue;
    for (const sel of HERO) {
      const img = d.querySelector(sel);
      if (img && img.src) return big(img.src);
    }
  }
  const hero = document.querySelector(
    '.fullHero__artwork span, .fullListenHero .image__full span, .listenArtworkWall span');
  if (hero) {
    const m = (getComputedStyle(hero).backgroundImage || '').match(/url\(["']?(https?:[^"')]+)/);
    if (m) return big(m[1]);
  }
  return null;
}

function currentCoverUrl() {
  const scope = document.querySelector('.playbackSoundBadge, .playControls');
  if (!scope) return null;
  const els = scope.querySelectorAll('span, div, a, .sc-artwork, .image');
  for (const el of els) {
    const bg = getComputedStyle(el).backgroundImage || '';
    const m = bg.match(/url\(["']?(https?:[^"')]+)["']?\)/);
    if (m) return m[1].replace(/-t\d+x\d+\./, '-t200x200.').replace(/-large\./, '-t200x200.');
  }
  return null;
}

// The C# host delivers colors here when JS can't read the pixels (CORS).
window.__scCoverColors = function (c1, c2) {
  setBgBrightness(c1);                 // raw colour: reflects the actual artwork
  const n = normalizeCoverColors(c1, c2);
  setWaveHue(n.c1); // waveform always tracks the cover
  if (localStorage.getItem('scMatchCover') === '1') {
    applyAccent(n, true);
  }
};

function ensureBg() {
  let bg = document.getElementById('sc-bg');
  if (!bg) { bg = document.createElement('div'); bg.id = 'sc-bg'; document.body.appendChild(bg); }
  return bg;
}

function applyCoverBgState() {
  const custom = localStorage.getItem('scCustomBg');
  const coverOn = localStorage.getItem('scCoverBg') === '1';
  const on = coverOn || !!custom;
  document.documentElement.classList.toggle('sc-coverbg', on);
  document.documentElement.classList.toggle('sc-custombg', !!custom);
  const bg = ensureBg();
  if (custom) bg.style.backgroundImage = 'url("' + custom + '")';
}

// Set (or clear) a custom image/GIF background.
function setCustomBg(val) {
  if (val) {
    try { localStorage.setItem('scCustomBg', val); } catch (e) { /* too big to persist */ }
    document.documentElement.classList.add('sc-coverbg', 'sc-custombg');
    ensureBg().style.backgroundImage = 'url("' + val + '")';
  } else {
    localStorage.removeItem('scCustomBg');
    document.documentElement.classList.remove('sc-custombg');
    applyCoverBgState();
    _lastCover = null; matchTick();
  }
}

let _lastCover = null;
function matchTick() {
  const matchOn = localStorage.getItem('scMatchCover') === '1';
  const bgOn = localStorage.getItem('scCoverBg') === '1';
  // What's PLAYING owns the accent — clicking into a song shouldn't repaint the
  // app away from the track you're actually listening to. Only when nothing is
  // playing does the page you're looking at decide the colours.
  const url = currentCoverUrl() || pageCoverUrl();
  if (!url || url === _lastCover) return;
  _lastCover = url;
  if (bgOn && !localStorage.getItem('scCustomBg')) {
    const bg = document.getElementById('sc-bg');
    if (bg) bg.style.backgroundImage = 'url("' + url + '")'; // CSS bg = no CORS issue
  }
  // Always sample the cover: drives the waveform hue, and the accent too when
  // match-cover mode is on. (CORS-tainted → C# host samples + calls __scCoverColors.)
  coverColors(url, (cols) => {
    if (cols) {
      setBgBrightness(cols.avg || cols.c1);   // whole-image average when we have it
      const n = normalizeCoverColors(cols.c1, cols.c2);
      setWaveHue(n.c1);
      if (matchOn) applyAccent(n, true);
    } else {
      scPost('cover:' + url);
    }
  });
}

// ---------------------------------------------------------------------------
// Audio-ad UI. The actual muting/fast-forwarding runs in the injected page-world
// __scAdKiller script (it can reach SoundCloud's detached media objects — there
// are no <audio> elements in the DOM). Here we just create the badge it toggles
// and let the manual button signal it via a shared-DOM CustomEvent.
// ---------------------------------------------------------------------------
function ensureAdBadge() {
  let b = document.getElementById('sc-ad-badge');
  if (b) return b;
  b = document.createElement('div');
  b.id = 'sc-ad-badge';
  b.textContent = '⏩ Skipping ad…';
  b.style.cssText =
    'position:fixed;bottom:72px;left:50%;transform:translateX(-50%);' +
    'z-index:2147483646;background:var(--sc-accent,#ff5500);color:#fff;' +
    'font:600 12px Inter,Arial,sans-serif;padding:6px 13px;border-radius:20px;' +
    'box-shadow:0 4px 16px rgba(0,0,0,.5);display:none;pointer-events:none;';
  document.body.appendChild(b);
  return b;
}

// Manual "kill the ad now" — signals the page-world killer to force mute + 16x.
function skipAdManual() {
  document.dispatchEvent(new CustomEvent('sc-kill-ad'));
}

// ---------------------------------------------------------------------------
// Custom titlebar + palette panel
// ---------------------------------------------------------------------------
function buildTitlebar() {
  if (document.getElementById('sc-titlebar')) return;

  const bar = document.createElement('div');
  bar.id = 'sc-titlebar';
  bar.innerHTML = `
    <style>
      /* Merged with the SC header: transparent overlay, only our controls are
         visible + clickable; the rest lets header clicks through. */
      #sc-titlebar {
        position: fixed; top: 0; left: 0; right: 0; height: 48px;
        background: transparent; border: 0;
        display: flex; align-items: center; z-index: 2147483647; pointer-events: none;
        font-family: Inter, -apple-system, Segoe UI, Arial, sans-serif; color: #ddd;
        user-select: none;
      }
      #sc-titlebar .sc-tb-btn, #sc-titlebar .sc-tb-lights,
      #sc-titlebar .sc-tb-lights .sc-light { pointer-events: auto; }
      #sc-titlebar .sc-tb-brand { display: none; } /* SC logo is the brand now */
      #sc-titlebar .sc-tb-logo {
        width: 22px; height: 22px; object-fit: contain; display: block;
        filter: drop-shadow(0 0 5px rgba(90,160,255,0.4));
      }
      #sc-titlebar .sc-tb-spacer { flex: 1; }
      #sc-titlebar .sc-tb-btn {
        width: 40px; height: 48px; padding: 0;
        display: flex; align-items: center; justify-content: center;
        background: transparent; border: 0; color: #9a9a9c; cursor: pointer;
        transition: background .12s ease, color .12s ease;
      }
      #sc-titlebar .sc-tb-btn svg { width: 15px; height: 15px; display: block; }
      #sc-titlebar .sc-tb-btn:hover { background: rgba(255,255,255,0.09); color: #fff; }
      #sc-titlebar .sc-tb-skipad:hover { color: var(--sc-accent, #ff5500); }
      #sc-titlebar .sc-tb-accentdot { fill: var(--sc-accent, #ff5500); }
      /* macOS traffic-light window controls */
      #sc-titlebar .sc-tb-lights { display: flex; align-items: center; gap: 8px; padding: 0 14px 0 8px; }
      #sc-titlebar .sc-light {
        width: 13px; height: 13px; border-radius: 50%; border: 0; padding: 0; cursor: pointer;
        display: flex; align-items: center; justify-content: center; position: relative;
        box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.15);
      }
      #sc-titlebar .sc-tb-close.sc-light { background: #ff5f57; }
      #sc-titlebar .sc-tb-min.sc-light { background: #febc2e; }
      #sc-titlebar .sc-tb-max.sc-light { background: #28c840; }
      #sc-titlebar .sc-light span {
        font-size: 9px; line-height: 0; font-weight: 800; color: rgba(0,0,0,0.6);
        display: flex; align-items: center; justify-content: center;
        opacity: 0; transition: opacity .1s ease;
      }
      #sc-titlebar .sc-light span svg { width: 9px; height: 9px; display: block; }
      #sc-titlebar .sc-tb-lights:hover .sc-light span { opacity: 1; }

      #sc-palette {
        position: fixed; top: 52px; right: 12px; z-index: 2147483647;
        background: rgba(14,14,18,0.55);
        backdrop-filter: blur(24px) saturate(1.5); -webkit-backdrop-filter: blur(24px) saturate(1.5);
        border: 1px solid rgba(255,255,255,0.10); border-radius: 16px;
        padding: 12px 14px; width: 470px; display: none;
        max-height: calc(100vh - 66px); overflow-y: auto; overscroll-behavior: contain;
        scrollbar-width: thin !important;
        scrollbar-color: color-mix(in srgb, var(--sc-accent, #ff5500) 55%, transparent) transparent !important;
        box-shadow: 0 22px 60px rgba(0,0,0,.6);
        font-family: Inter, -apple-system, Arial, sans-serif; color: #e8e8ea; font-size: 12px;
        -webkit-app-region: no-drag;
        animation: scPalIn .16s ease;
      }
      @keyframes scPalIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
      #sc-palette.open { display: block; }
      /* Rows carry padding + a 1px border; without border-box each one renders
         wider than its grid track and bleeds into the neighbouring column. */
      #sc-palette, #sc-palette *, #sc-palette *::before, #sc-palette *::after {
        box-sizing: border-box;
      }

      /* --- Palette adopted by the Social/Settings tab ---------------------
         Same element, same handlers; it just stops being a floating popup and
         becomes an inline block that can breathe. The tab scrolls, so none of
         the popup's height clamping is needed (that was what clipped rows). */
      #hoq-discord .hoq-settings-host #sc-palette {
        position: static !important; display: block !important;
        width: auto !important; max-width: none !important;
        max-height: none !important; overflow: visible !important;
        background: transparent !important;
        backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
        border: 0 !important; border-radius: 0 !important;
        box-shadow: none !important; padding: 0 !important;
        animation: none !important; font-size: 12px;
      }
      /* The card already has a "Settings" label above it. */
      #hoq-discord .hoq-settings-host #sc-palette > h4 { display: none !important; }
      #hoq-discord .hoq-settings-host #sc-palette .section-label {
        margin: 16px 0 7px !important;
        /* The tab sits on the cover wash, which can be light — the popup's mid
           grey vanished on bright artwork, so lift it and anchor it with a shadow. */
        font-size: 10px !important;
        color: rgba(255,255,255,0.74) !important;
        text-shadow: 0 1px 3px rgba(0,0,0,0.55) !important;
      }
      #hoq-discord .hoq-settings-host #sc-palette .section-label:first-of-type { margin-top: 2px !important; }
      /* Fill the tab's width instead of forcing two cramped columns. */
      #hoq-discord .hoq-settings-host #sc-palette .pal-grid {
        grid-template-columns: repeat(3, 1fr) !important;
        gap: 8px 18px !important;
      }
      #hoq-discord .hoq-settings-host #sc-palette .row {
        padding: 7px 11px !important;
      }
      #hoq-discord .hoq-settings-host #sc-palette .pal-grid .row { margin: 0 !important; }
      /* Keep the full-width singles on the same column rhythm as the grids
         (2 cols = 232+232+18) instead of stretching across the whole tab. */
      #hoq-discord .hoq-settings-host #sc-palette > .row,
      #hoq-discord .hoq-settings-host #sc-palette > .bgurl,
      #hoq-discord .hoq-settings-host #sc-palette > .btn-2up { max-width: calc(66.667% - 6px); }
      #sc-palette h4 {
        margin: 1px 0 8px; font-size: 10.5px; font-weight: 700; color: #fff;
        letter-spacing: 1.3px; text-transform: uppercase; display: flex; align-items: center; gap: 7px;
      }
      #sc-palette h4::before {
        content: ''; width: 7px; height: 7px; border-radius: 50%;
        background: var(--sc-accent, #ff5500); box-shadow: 0 0 8px var(--sc-accent, #ff5500);
      }
      #sc-palette .row {
        display: flex; align-items: center; justify-content: space-between;
        margin: 3px 0; padding: 4px 9px; background: rgba(255,255,255,0.035);
        border: 1px solid rgba(255,255,255,0.05);
        border-radius: 8px; font-weight: 500; font-size: 11px;
      }
      /* two-up (side by side) grid for the toggles */
      #sc-palette .pal-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 20px; }
      #sc-palette .pal-grid .row { margin: 0; gap: 10px; padding: 5px 9px; }
      #sc-palette .pal-grid .row span {
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0;
      }
      /* slightly smaller switches so label + toggle never touch in a cell */
      #sc-palette .pal-grid input[type=checkbox] { width: 32px; height: 18px; flex: none; }
      #sc-palette .pal-grid input[type=checkbox]::after { width: 14px; height: 14px; }
      #sc-palette .pal-grid input[type=checkbox]:checked::after { transform: translateX(14px); }
      #sc-palette input[type=color] {
        width: 34px; height: 24px; border: 1px solid rgba(255,255,255,0.15);
        border-radius: 6px; background: none; cursor: pointer; padding: 0;
      }
      #sc-palette input[type=color]::-webkit-color-swatch { border: 0; border-radius: 5px; }
      #sc-palette input[type=color]::-webkit-color-swatch-wrapper { padding: 2px; }
      #sc-palette label { display: flex; align-items: center; gap: 7px; cursor: pointer; }
      #sc-palette label { justify-content: space-between; width: 100%; }
      #sc-palette input[type=checkbox] {
        appearance: none; -webkit-appearance: none; flex: none; cursor: pointer;
        width: 36px; height: 20px; border-radius: 20px; position: relative; margin: 0;
        background: rgba(255,255,255,0.16); transition: background .18s ease;
      }
      #sc-palette input[type=checkbox]::after {
        content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
        border-radius: 50%; background: #fff; transition: transform .18s ease;
        box-shadow: 0 1px 3px rgba(0,0,0,0.4);
      }
      #sc-palette input[type=checkbox]:checked { background: var(--sc-accent-bg, #ff5500); }
      #sc-palette input[type=checkbox]:checked::after { transform: translateX(16px); }
      #sc-palette .swatches {
        display: grid; grid-template-columns: repeat(8, 1fr); gap: 7px; margin: 14px 2px 6px;
      }
      #sc-palette .sw {
        width: 20px; height: 20px; border-radius: 50%; cursor: pointer;
        border: 2px solid transparent; box-shadow: 0 0 0 1px rgba(255,255,255,0.12);
        transition: transform .12s ease, box-shadow .12s ease;
      }
      #sc-palette .sw:hover { transform: scale(1.18); }
      #sc-palette .sw.sel { border-color: #fff; box-shadow: 0 0 0 2px var(--sc-accent, #ff5500); }
      #sc-palette .bgurl {
        width: 100%; box-sizing: border-box; margin: 3px 0 0; padding: 7px 10px;
        border-radius: 8px; border: 1px solid rgba(255,255,255,0.1);
        background: rgba(255,255,255,0.05); color: #e4e4e6; font-size: 12px; outline: none;
      }
      #sc-palette .bgurl:focus { border-color: var(--sc-accent, #ff5500); }
      /* two buttons side-by-side (background + reset rows) to save vertical space */
      #sc-palette .btn-2up { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 6px; }
      #sc-palette .btn-2up button { width: 100% !important; margin: 0 !important; }
      #sc-palette button.bgpick, #sc-palette button.bgclear {
        width: 100%; padding: 7px 8px; border-radius: 8px; cursor: pointer;
        font-size: 12px; font-weight: 600; border: 1px solid rgba(255,255,255,0.09);
        background: rgba(255,255,255,0.06); color: #ccc; transition: all .12s ease;
      }
      #sc-palette button.bgpick:hover { background: rgba(255,255,255,0.12); color: #fff; }
      #sc-palette button.bgclear { background: rgba(255,90,90,0.08); color: #ff9a9a; border-color: rgba(255,90,90,0.25); }
      #sc-palette button.bgclear:hover { background: rgba(255,90,90,0.18); color: #fff; }
      #sc-palette button.reset, #sc-palette button.fixblock {
        width: 100%; padding: 8px; border-radius: 9px; cursor: pointer;
        font-size: 12px; font-weight: 600; transition: all .12s ease;
      }
      #sc-palette button.reset { background: rgba(255,255,255,0.06); color: #ccc; border: 1px solid rgba(255,255,255,0.09); }
      #sc-palette button.reset:hover { background: rgba(255,255,255,0.11); color: #fff; }
      #sc-palette button.fixblock {
        background: rgba(255,120,40,0.1); color: #ffb37a; border: 1px solid rgba(255,120,40,0.28);
      }
      #sc-palette button.fixblock:hover { background: rgba(255,120,40,0.2); color: #fff; }
      #sc-palette .zoomctl { display: flex; align-items: center; gap: 8px; }
      #sc-palette .zmb {
        width: 24px; height: 24px; border-radius: 6px; cursor: pointer; font-size: 14px;
        border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.06); color: #ddd;
        display: flex; align-items: center; justify-content: center; line-height: 1;
      }
      #sc-palette .zmb:hover { background: rgba(255,255,255,0.15); color: #fff; }
      #sc-palette #sc-zoomval { min-width: 42px; text-align: center; font-size: 12px; font-weight: 600; }
      #sc-palette .gradctl { display: flex; align-items: center; gap: 10px; }
      #sc-palette .section-label {
        font-size: 9.5px; text-transform: uppercase; letter-spacing: 1.4px;
        color: #7a7a7c; margin: 9px 2px 5px; font-weight: 700;
      }
      #sc-palette .section-label:first-of-type { margin-top: 4px; }
    </style>
    <div class="sc-tb-brand">holdonquietly</div>
    <div class="sc-tb-spacer"></div>
    <button class="sc-tb-btn sc-tb-skipad" title="Kill current ad (mute + fast-forward)">
      <svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 4v16"/><path d="M6.029 4.285A2 2 0 0 0 3 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z"/></svg></button>
    <div class="sc-tb-lights">
      <button class="sc-light sc-tb-close" title="Close"><span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></span></button>
      <button class="sc-light sc-tb-min" title="Minimize"><span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12h14"/></svg></span></button>
      <button class="sc-light sc-tb-max" title="Maximize"><span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3m8 0h3a2 2 0 0 0 2-2v-3"/></svg></span></button>
    </div>
  `;
  document.body.appendChild(bar);

  const panel = document.createElement('div');
  panel.id = 'sc-palette';
  const presets = ['#ff5500', '#1db954', '#3b82f6', '#a855f7', '#ef4444', '#eab308', '#ec4899', '#14b8a6'];
  panel.innerHTML = `
    <h4>Appearance</h4>

    <div class="section-label">Color</div>
    <div class="pal-grid">
      <div class="row"><span>Primary</span><input type="color" id="sc-c1"></div>
      <div class="row"><span>Gradient</span><span class="gradctl">
        <input type="color" id="sc-c2"><input type="checkbox" id="sc-grad"></span></div>
    </div>
    <label class="row"><span>Match song cover</span><input type="checkbox" id="sc-match"></label>

    <div class="section-label">Background</div>
    <label class="row"><span>Blurred cover</span><input type="checkbox" id="sc-coverbg"></label>
    <input type="text" id="sc-bgurl" class="bgurl" placeholder="…or paste an image / GIF URL">
    <div class="btn-2up">
      <button class="bgpick">Choose image</button>
      <button class="bgclear">Clear bg</button>
    </div>

    <div class="section-label">Motion</div>
    <div class="pal-grid">
      <label class="row"><span>Visualizer</span><input type="checkbox" id="sc-fx-viz"></label>
      <label class="row"><span>Interactive wave</span><input type="checkbox" id="sc-fx-wave"></label>
      <label class="row"><span>3D tilt</span><input type="checkbox" id="sc-fx-tilt"></label>
      <label class="row"><span>Speaker pulse</span><input type="checkbox" id="sc-fx-pulse"></label>
      <label class="row"><span>Animations</span><input type="checkbox" id="sc-fx-anim"></label>
    </div>

    <div class="section-label">Look</div>
    <div class="pal-grid">
      <label class="row"><span>Accent glow</span><input type="checkbox" id="sc-fx-glow"></label>
      <label class="row"><span>Rounded</span><input type="checkbox" id="sc-fx-round"></label>
      <label class="row"><span>Row hover</span><input type="checkbox" id="sc-fx-hover"></label>
      <label class="row"><span>Frosted bars</span><input type="checkbox" id="sc-fx-frost"></label>
      <label class="row"><span>Grayscale covers</span><input type="checkbox" id="sc-fx-gray"></label>
      <label class="row"><span>Room glow</span><input type="checkbox" id="sc-fx-ambient"></label>
    </div>

    <div class="section-label">Display</div>
    <div class="row"><span>Song list zoom</span><span class="zoomctl">
      <button class="zmb" data-z="-1">&minus;</button><b id="sc-zoomval">100%</b><button class="zmb" data-z="1">+</button>
    </span></div>

    <div class="section-label">Trouble</div>
    <div class="btn-2up">
      <button class="reset" title="Put the accent back to SoundCloud orange">Reset color</button>
      <button class="fixblock" title="Clears cookies and Cloudflare block state, then reloads">Fix &quot;blocked&quot;</button>
    </div>
  `;
  document.body.appendChild(panel);

  // Manual ad-kill
  bar.querySelector('.sc-tb-skipad').addEventListener('click', () => skipAdManual());

  // Drag the frameless window by the titlebar (WebView2 has no app-region drag).
  bar.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.sc-tb-btn, .sc-light, #sc-palette')) return; // not on buttons
    scPost('win:drag');
  });
  bar.addEventListener('dblclick', (e) => {
    if (e.target.closest('.sc-tb-btn, .sc-light, #sc-palette')) return;
    window.scDesktop.maximize();
  });
  // Merged bar: drag / maximize by empty areas of the SC header too (event
  // listeners only — never mutate SC's React DOM).
  const hdrNoDrag = 'a, button, input, textarea, select, [role="button"], .headerSearch, .header__userNav, #sc-titlebar, #sc-palette';
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !e.target.closest('.header')) return;
    if (e.target.closest(hdrNoDrag)) return;
    scPost('win:drag');
  });
  document.addEventListener('dblclick', (e) => {
    if (!e.target.closest('.header') || e.target.closest(hdrNoDrag)) return;
    window.scDesktop.maximize();
  });

  // Window controls
  bar.querySelector('.sc-tb-min').addEventListener('click', () => window.scDesktop.minimize());
  bar.querySelector('.sc-tb-max').addEventListener('click', () => window.scDesktop.maximize());
  bar.querySelector('.sc-tb-close').addEventListener('click', () => window.scDesktop.close());
  // Settings live in the Social/Settings tab now, so the gear is just a shortcut
  // to it rather than a second place the same controls can appear.
  // No titlebar gear any more — the Social/Settings tab is the single entry
  // point, so the palette is never a floating panel and needs no dismiss logic.

  // Palette wiring
  const c1 = panel.querySelector('#sc-c1');
  const c2 = panel.querySelector('#sc-c2');
  const grad = panel.querySelector('#sc-grad');
  const state = readAccent();
  c1.value = state.c1;
  c2.value = state.c2;
  grad.checked = state.grad;

  const match = panel.querySelector('#sc-match');
  match.checked = localStorage.getItem('scMatchCover') === '1';

  const markSel = () => panel.querySelectorAll('.sw').forEach((sw) =>
    sw.classList.toggle('sel', sw.dataset.c.toLowerCase() === c1.value.toLowerCase()));
  // Manual change -> turn OFF match-cover mode.
  const push = () => {
    if (match.checked) { match.checked = false; localStorage.setItem('scMatchCover', '0'); }
    applyAccent({ c1: c1.value, c2: c2.value, grad: grad.checked });
    markSel();
  };
  c1.addEventListener('input', push);
  c2.addEventListener('input', push);
  grad.addEventListener('change', push);
  panel.querySelectorAll('.sw').forEach((sw) =>
    sw.addEventListener('click', () => {
      c1.value = sw.dataset.c;
      push();
    })
  );
  markSel();

  // Match-song-cover toggle.
  match.addEventListener('change', () => {
    localStorage.setItem('scMatchCover', match.checked ? '1' : '0');
    if (match.checked) { _lastCover = null; matchTick(); }
    else applyAccent(readAccent()); // restore saved manual color
  });

  // Blurred-cover-background toggle.
  const coverbg = panel.querySelector('#sc-coverbg');
  coverbg.checked = localStorage.getItem('scCoverBg') === '1';
  coverbg.addEventListener('change', () => {
    localStorage.setItem('scCoverBg', coverbg.checked ? '1' : '0');
    applyCoverBgState();
    _lastCover = null; matchTick();
  });

  // Optional-effects toggles. viz/tilt/wave are JS-gated; the rest are CSS-gated
  // via html.hoq-no-<name> (see applyFxClasses).
  [['viz', 'sc-fx-viz'], ['tilt', 'sc-fx-tilt'], ['wave', 'sc-fx-wave'],
   ['pulse', 'sc-fx-pulse'], ['round', 'sc-fx-round'], ['hover', 'sc-fx-hover'],
   ['anim', 'sc-fx-anim'], ['frost', 'sc-fx-frost'], ['glow', 'sc-fx-glow'],
   ['gray', 'sc-fx-gray'], ['ambient', 'sc-fx-ambient']].forEach(([name, id]) => {
    const cb = panel.querySelector('#' + id);
    if (!cb) return;
    // opt-in effects default OFF; everything else defaults ON.
    cb.checked = HOQ_OPTIN_FX.includes(name) ? (localStorage.getItem('scFx_' + name) === '1') : effectOn(name);
    cb.addEventListener('change', () => {
      localStorage.setItem('scFx_' + name, cb.checked ? '1' : '0');
      if (name === 'viz') applyVizState();
      if (name === 'wave' && !cb.checked) document.querySelectorAll('.hoq-wave .bars i').forEach((b) => b.style.transform = '');
      applyFxClasses();
    });
  });

  panel.querySelector('.reset').addEventListener('click', () => {
    match.checked = false; localStorage.setItem('scMatchCover', '0');
    c1.value = DEFAULT_ACCENT.c1;
    c2.value = DEFAULT_ACCENT.c2;
    grad.checked = false;
    push();
  });
  panel.querySelector('.fixblock').addEventListener('click', () => {
    window.scDesktop.reset();
  });

  // Song-list zoom buttons.
  applyZoom(readZoom()); // sets the label
  panel.querySelectorAll('.zmb').forEach((b) =>
    b.addEventListener('click', () => applyZoom(readZoom() + parseInt(b.dataset.z, 10) * 0.05)));

  // Custom background (image / GIF via URL or file).
  const bgurl = panel.querySelector('#sc-bgurl');
  const savedBg = localStorage.getItem('scCustomBg') || '';
  bgurl.value = savedBg.startsWith('data:') ? '' : savedBg;
  bgurl.addEventListener('change', () => setCustomBg(bgurl.value.trim()));
  const fileInput = document.createElement('input');
  fileInput.type = 'file'; fileInput.accept = 'image/*'; fileInput.style.display = 'none';
  panel.appendChild(fileInput);
  panel.querySelector('.bgpick').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => setCustomBg(r.result);
    r.readAsDataURL(f);
  });
  panel.querySelector('.bgclear').addEventListener('click', () => { bgurl.value = ''; setCustomBg(''); });
}

// ---------------------------------------------------------------------------
// Discord tab: a hub next to Library — your live listening-activity card, a
// display-name setting, and a link to the server. (Rich Presence to friends
// wires up in the C# host once a public Client ID is provided.)
// ---------------------------------------------------------------------------
const HOQ_SERVER = '795316631655546900';

function cleanNP(s) {
  s = (s || '').replace(/[⠀]/g, '').replace(/^current track:\s*/i, '').trim();
  // SoundCloud duplicates the text (visible + a11y) — collapse exact doubles.
  const h = Math.floor(s.length / 2);
  if (s.length % 2 === 0 && s.slice(0, h).trim() === s.slice(h).trim()) s = s.slice(0, h);
  return s.trim();
}

function currentNowPlaying() {
  const t = document.querySelector('.playbackSoundBadge__titleLink');
  const a = document.querySelector('.playbackSoundBadge__lightLink, .playbackSoundBadge__usernameLink');
  return {
    title: cleanNP(t && (t.getAttribute('title') || t.textContent)),
    artist: cleanNP(a && (a.getAttribute('title') || a.textContent)),
    cover: currentCoverUrl() || '',
  };
}

function buildDiscordTab() {
  if (document.querySelector('.hoq-dc-tab')) return;
  const lib = Array.from(document.querySelectorAll('.header__navMenuItem'))
    .find((a) => (a.textContent || '').trim() === 'Library' || a.getAttribute('href') === '/you/library');
  if (!lib) return;
  const libLi = lib.closest('li') || lib.parentElement;
  if (!libLi || !libLi.parentElement) return;
  // Give Discord its OWN <li> wrapper (matching Library's) so it sits inline.
  const li = libLi.cloneNode(false); // empty <li> with the same class
  const tab = document.createElement('a');
  tab.className = (lib.className || '').toString().replace(/\b(selected|active|m-selected)\b/g, '').trim() + ' hoq-dc-tab';
  tab.textContent = 'Social/Settings';
  tab.style.cursor = 'pointer';
  tab.addEventListener('click', (e) => { e.preventDefault(); toggleDiscord(); });
  li.appendChild(tab);
  libLi.insertAdjacentElement('afterend', li);
}

function ensureDiscordPanel() {
  let p = document.getElementById('hoq-discord');
  if (p) return p;
  p = document.createElement('div');
  p.id = 'hoq-discord';
  p.innerHTML = `
    <style>
      /* A PAGE, not a modal: it fills the same region SoundCloud's own content
         occupies — under the header, above the player — so the header stays
         usable and the play controls are never covered. Offsets are measured
         (hoqTabMetrics) because the titlebar is merged into the header and the
         player can be hidden, so 50px/0 were wrong on both edges. */
      #hoq-discord { position: fixed; top: var(--hoq-tab-top, 50px); left: 0; right: 0;
        bottom: var(--hoq-tab-bottom, 0px);
        /* No scrim and no backdrop blur: a scrim is what made this read as a
           modal floating over the page. SoundCloud's own content is hidden while
           the tab is active (rule below), so this sits on the app background
           exactly like Home or Library does. */
        z-index: 30; display: none; background: transparent;
        padding: 30px 24px 48px; overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-width: thin;
        scrollbar-color: color-mix(in srgb, var(--sc-accent, #ff5500) 55%, transparent) transparent;
        font-family: Inter, -apple-system, Arial, sans-serif; }
      #hoq-discord::-webkit-scrollbar { width: 10px; }
      #hoq-discord::-webkit-scrollbar-thumb {
        background: color-mix(in srgb, var(--sc-accent, #ff5500) 55%, transparent);
        border-radius: 99px; border: 3px solid transparent; background-clip: content-box; }
      #hoq-discord::-webkit-scrollbar-track { background: transparent; }
      #hoq-discord.open { display: block; animation: hoqIn .18s ease; }
      /* Selected-tab styling so "hoq" reads as the current page, like Home/Feed.
         Use SoundCloud's OWN mechanism — .selected draws border-bottom: 2px solid
         — just in the accent, so the underline sits at exactly the same height as
         the other tabs. The previous ::after sat 6px lower and something already
         paints an inset white line on the item, so the two together read as a
         doubled underline. */
      .hoq-dc-tab.hoq-active {
        color: #fff !important;
        border-bottom: 2px solid var(--sc-accent, #ff5500) !important;
        box-shadow: none !important;
      }
      .hoq-dc-tab.hoq-active::after { content: none !important; }
      /* Only one tab can be current. SoundCloud keeps its 'selected' class on whatever route
         is still mounted underneath, which left Home/Feed lit at the same time. */
      html.hoq-tab .header__navMenuItem.selected:not(.hoq-dc-tab) {
        border-bottom-color: transparent !important;
        color: #999 !important;
      }
      @keyframes hoqIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
      /* Page-width, and on a wide window the sections flow in two columns like a
         real settings page instead of one long 540px ribbon. */
      /* Page content, not a dialog — no panel gradient, border or drop shadow.
         The individual sections keep their own surfaces, same as SoundCloud's. */
      #hoq-discord .hoq-dc-card { max-width: 940px; margin: 0 auto;
        background: transparent; border: 0; border-radius: 0; padding: 0; box-shadow: none; }
      /* While the tab is the current page, SoundCloud's content is not on screen
         (this is what a route swap does); the header and player stay untouched. */
      html.hoq-tab #content,
      html.hoq-tab .l-listen-wrapper,
      html.hoq-tab .webiIframe,
      html.hoq-tab .l-collection,
      html.hoq-tab .stream { display: none !important; }
      @media (min-width: 900px) {
        #hoq-discord .hoq-dc-card { padding: 28px 30px; }
        #hoq-discord .hoq-dc-body { display: grid; grid-template-columns: 1fr 1fr; gap: 0 26px; align-items: start; }
        #hoq-discord .hoq-dc-body > .hoq-dc-sec.hoq-wide { grid-column: 1 / -1; }
      }
      #hoq-discord .hoq-dc-top { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; }
      /* Page header, not a dialog title bar — a tab has no close button; you
         leave it by picking another tab, the same as Home or Library. */
      #hoq-discord .hoq-dc-logo { width: 42px; height: 42px; object-fit: contain;
        filter: drop-shadow(0 0 8px color-mix(in srgb, var(--sc-accent,#ff5500) 55%, transparent)); }
      #hoq-discord .hoq-dc-titles { flex: 1; display: flex; flex-direction: column; gap: 2px; }
      #hoq-discord .hoq-dc-top span { font-weight: 800; font-size: 26px; color: #fff; letter-spacing: -.3px;
        text-shadow: 0 2px 14px rgba(0,0,0,0.55); }
      #hoq-discord .hoq-dc-top small { color: #c4c4c8; font-size: 12.5px; text-shadow: 0 1px 6px rgba(0,0,0,0.6); }
      #hoq-discord .hoq-dc-accent { display: flex; gap: 5px; }
      #hoq-discord .hoq-dc-accent i { width: 16px; height: 16px; border-radius: 5px; display: block;
        border: 1px solid rgba(255,255,255,0.18); }
      #hoq-discord .hoq-dc-accent .a1 { background: var(--sc-accent,#ff5500); }
      #hoq-discord .hoq-dc-accent .a2 { background: var(--sc-accent-bg,#ff5500); }

      /* now-playing hero */
      #hoq-discord .hoq-dc-bar { height: 4px; border-radius: 99px; margin-top: 8px;
        background: rgba(255,255,255,0.12); overflow: hidden; }
      #hoq-discord .hoq-dc-bar i { display: block; height: 100%; width: 0%;
        background: var(--sc-accent-bg, var(--sc-accent,#ff5500)); border-radius: 99px;
        transition: width .4s linear; }
      #hoq-discord .hoq-dc-times { display: flex; justify-content: space-between;
        color: #8a8a8c; font-size: 11px; margin-top: 4px; font-variant-numeric: tabular-nums; }

      /* quick actions */
      #hoq-discord .hoq-dc-quick { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
      #hoq-discord .hoq-dc-quick button { border: 1px solid rgba(255,255,255,0.12);
        background: rgba(12,12,14,0.55); backdrop-filter: blur(16px); color: #e4e4e6; border-radius: 999px;
        padding: 8px 14px; font-size: 12.5px; font-weight: 600; cursor: pointer;
        transition: background .12s ease, border-color .12s ease, color .12s ease; }
      #hoq-discord .hoq-dc-quick button:hover {
        background: color-mix(in srgb, var(--sc-accent,#ff5500) 20%, transparent);
        border-color: color-mix(in srgb, var(--sc-accent,#ff5500) 55%, transparent); color: #fff; }
      #hoq-discord .hoq-dc-quick button.done {
        background: var(--sc-accent,#ff5500); border-color: transparent; color: #fff; }

      /* listening stats */
      #hoq-discord .hoq-stat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
      #hoq-discord .hoq-stat { background: rgba(12,12,14,0.55); backdrop-filter: blur(20px) saturate(1.3);
        border: 1px solid rgba(255,255,255,0.09); border-radius: 12px; padding: 12px 13px;
        display: flex; flex-direction: column; gap: 2px; }
      #hoq-discord .hoq-stat b { color: var(--sc-accent,#ff5500); font-size: 21px; font-weight: 800;
        font-variant-numeric: tabular-nums; }
      #hoq-discord .hoq-stat span { color: #8a8a8c; font-size: 11px; text-transform: uppercase;
        letter-spacing: 1px; font-weight: 700; }
      #hoq-discord .hoq-stat-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-top: 16px; }
      #hoq-discord .hoq-top { list-style: none; margin: 0; padding: 0; display: flex;
        flex-direction: column; gap: 5px; counter-reset: hoqrank; }
      #hoq-discord .hoq-top li { counter-increment: hoqrank; display: flex; align-items: center; gap: 9px;
        background: rgba(12,12,14,0.5); backdrop-filter: blur(16px);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 9px; padding: 7px 10px; color: #e4e4e6; font-size: 12.5px; }
      #hoq-discord .hoq-top li::before { content: counter(hoqrank); color: var(--sc-accent,#ff5500);
        font-weight: 800; font-size: 11px; min-width: 12px; }
      #hoq-discord .hoq-top li em { margin-left: auto; font-style: normal; color: #8a8a8c; font-size: 11px; }
      #hoq-discord .hoq-top li b { flex: 1; font-weight: 500; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis; }
      #hoq-discord .hoq-stat-reset { background: none; border: 0; color: #8a8a8c; cursor: pointer;
        text-decoration: underline; font-size: 12px; padding: 0 2px; }
      #hoq-discord .hoq-stat-reset:hover { color: #ff9a9a; }
      #hoq-discord .hoq-dc-sec { margin-bottom: 18px; }
      #hoq-discord .hoq-dc-label { font-size: 11px; text-transform: uppercase; letter-spacing: 1.2px;
        color: #c9c9cc; font-weight: 700; margin-bottom: 9px;
        text-shadow: 0 1px 6px rgba(0,0,0,0.6); }
      #hoq-discord .hoq-dc-presence { display: flex; gap: 14px; align-items: center;
        background: rgba(12,12,14,0.55); backdrop-filter: blur(20px) saturate(1.3);
        border: 1px solid rgba(255,255,255,0.09);
        border-radius: 12px; padding: 14px; }
      #hoq-discord .hoq-dc-cover { width: 62px; height: 62px; border-radius: 10px; object-fit: cover;
        box-shadow: 0 2px 8px rgba(0,0,0,0.4); }
      #hoq-discord .hoq-dc-ptext { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
      #hoq-discord .hoq-dc-ptext b { color: var(--sc-accent,#ff5500); font-size: 12px; }
      #hoq-discord .hoq-dc-title { color: #fff; font-weight: 700; font-size: 15px; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis; }
      #hoq-discord .hoq-dc-artist { color: #b7b7ba; font-size: 13px; }
      #hoq-discord .hoq-dc-hint { color: #b9b9bd; font-size: 12px; margin-top: 8px;
        text-shadow: 0 1px 6px rgba(0,0,0,0.6); }
      #hoq-discord .hoq-dc-name, #hoq-discord .hoq-dc-sc { width: 100%; box-sizing: border-box; padding: 10px 12px;
        border-radius: 9px; border: 1px solid rgba(255,255,255,0.12); background: rgba(12,12,14,0.55);
        color: #e4e4e6; font-size: 13px; outline: none; }
      #hoq-discord .hoq-dc-name:focus, #hoq-discord .hoq-dc-sc:focus { border-color: var(--sc-accent,#ff5500); }
      #hoq-discord .hoq-dc-friends { min-height: 20px; display: flex; flex-direction: column; gap: 6px; }
      #hoq-discord .hoq-dc-friend { display: flex; gap: 12px; align-items: center; padding: 8px;
        border-radius: 10px; background: rgba(12,12,14,0.5); backdrop-filter: blur(16px);
        border: 1px solid rgba(255,255,255,0.08); }
      #hoq-discord .hoq-dc-fcover { width: 42px; height: 42px; border-radius: 8px; object-fit: cover; flex: none; }
      #hoq-discord .hoq-dc-ftext { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      #hoq-discord .hoq-dc-ftext b { color: #fff; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #hoq-discord .hoq-dc-ftext span { color: #b7b7ba; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #hoq-discord .hoq-me { font-style: normal; font-size: 10px; font-weight: 700; margin-left: 7px;
        padding: 1px 6px; border-radius: 99px; text-transform: uppercase; letter-spacing: .6px;
        color: #fff; background: color-mix(in srgb, var(--sc-accent,#ff5500) 60%, transparent); }
      #hoq-discord .hoq-dc-friend.is-me { border-color: color-mix(in srgb, var(--sc-accent,#ff5500) 35%, transparent); }
      #hoq-discord .hoq-dc-sclink { color: var(--sc-accent,#ff5500); font-size: 11px; cursor: pointer; text-decoration: none; }
      #hoq-discord .hoq-dc-sclink:hover { text-decoration: underline; }
      #hoq-discord .hoq-dc-open { width: 100%; padding: 11px; border-radius: 10px; cursor: pointer;
        border: 0; background: var(--sc-accent-bg,#5865F2); color: #fff; font-weight: 700; font-size: 14px; }
      #hoq-discord .hoq-dc-open:hover { filter: brightness(1.1); }
      /* Discord server embed */
      #hoq-discord .hoq-dc-embed { display: flex; gap: 13px; align-items: center; margin-bottom: 10px;
        background: rgba(88,101,242,0.10); border: 1px solid rgba(88,101,242,0.35);
        border-radius: 12px; padding: 13px; }
      #hoq-discord .hoq-dc-embed .hoq-dc-eicon { width: 46px; height: 46px; border-radius: 12px; object-fit: cover;
        background: #5865F2; flex: none; }
      #hoq-discord .hoq-dc-embed .hoq-dc-etext { min-width: 0; flex: 1; }
      #hoq-discord .hoq-dc-embed .hoq-dc-ename { color: #fff; font-weight: 800; font-size: 15px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #hoq-discord .hoq-dc-embed .hoq-dc-eonline { color: #b7f7c0; font-size: 12px; margin-top: 2px; display: flex; align-items: center; gap: 6px; }
      #hoq-discord .hoq-dc-embed .hoq-dc-dot { width: 8px; height: 8px; border-radius: 50%; background: #3ba55d; display: inline-block; }
      /* Last.fm scrobbler */
      #hoq-discord .hoq-lf { display: flex; gap: 14px; align-items: center;
        background: rgba(12,12,14,0.55); backdrop-filter: blur(20px) saturate(1.3);
        border: 1px solid rgba(255,255,255,0.09);
        border-radius: 12px; padding: 14px; }
      #hoq-discord .hoq-lf-logo { width: 44px; height: 44px; border-radius: 12px; flex: none;
        background: linear-gradient(180deg,#e21212,#b40707); display: flex; align-items: center; justify-content: center;
        box-shadow: 0 3px 10px rgba(213,16,7,0.32); }
      #hoq-discord .hoq-lf-logo svg { display: block; }
      #hoq-discord .hoq-lf-text { flex: 1; min-width: 0; }
      #hoq-discord .hoq-lf-state { color: #fff; font-weight: 700; font-size: 14.5px; }
      #hoq-discord .hoq-lf-sub { color: #8a8a8c; font-size: 12px; margin-top: 3px; line-height: 1.4; }
      #hoq-discord .hoq-lf-btn { border: 0; border-radius: 10px; padding: 9px 18px; cursor: pointer;
        font-weight: 700; font-size: 13px; background: #d51007; color: #fff; flex: none;
        transition: filter .12s ease, background .12s ease; }
      #hoq-discord .hoq-lf-btn:hover { filter: brightness(1.12); }
      #hoq-discord .hoq-lf-btn.is-off { background: rgba(255,255,255,0.08); color: #d8d8db;
        border: 1px solid rgba(255,255,255,0.12); }
      #hoq-discord .hoq-lf-btn.is-off:hover { background: rgba(255,255,255,0.14); filter: none; }
      /* Accounts */
      #hoq-discord .hoq-acct-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
      #hoq-discord .hoq-acct-row { display: flex; align-items: center; gap: 10px; padding: 9px 11px;
        border-radius: 10px; background: rgba(12,12,14,0.5); backdrop-filter: blur(16px);
        border: 1px solid rgba(255,255,255,0.08); }
      #hoq-discord .hoq-acct-row b { flex: 1; color: #e4e4e6; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #hoq-discord .hoq-acct-sw { border: 0; border-radius: 7px; padding: 6px 12px; cursor: pointer;
        background: var(--sc-accent-bg,#5865F2); color: #fff; font-weight: 700; font-size: 12px; }
      #hoq-discord .hoq-acct-sw:hover { filter: brightness(1.1); }
      #hoq-discord .hoq-acct-rm { border: 0; background: transparent; color: #8a8a8c; cursor: pointer; font-size: 15px; }
      #hoq-discord .hoq-acct-rm:hover { color: #e81123; }
      #hoq-discord .hoq-acct-add { display: flex; gap: 8px; }
      #hoq-discord .hoq-acct-name { flex: 1; box-sizing: border-box; padding: 9px 12px; border-radius: 9px;
        border: 1px solid rgba(255,255,255,0.12); background: rgba(12,12,14,0.55);
        backdrop-filter: blur(16px); color: #e4e4e6; font-size: 13px; outline: none; }
      #hoq-discord .hoq-acct-name:focus { border-color: var(--sc-accent,#ff5500); }
      #hoq-discord .hoq-acct-save, #hoq-discord .hoq-acct-new { border: 0; border-radius: 9px; padding: 9px 14px;
        cursor: pointer; font-weight: 700; font-size: 12px; }
      #hoq-discord .hoq-acct-save { background: var(--sc-accent,#ff5500); color: #fff; }
      #hoq-discord .hoq-acct-new { width: 100%; margin-top: 8px; background: rgba(12,12,14,0.55);
        backdrop-filter: blur(16px); color: #e4e4e6; border: 1px solid rgba(255,255,255,0.12); }
      #hoq-discord .hoq-sub {
        display: flex; gap: 4px; margin: 0 0 16px;
        border-bottom: 1px solid rgba(255,255,255,0.09); padding-bottom: 0;
      }
      #hoq-discord .hoq-subtab {
        background: none; border: 0; cursor: pointer;
        padding: 7px 2px; margin-right: 18px;
        font: 700 12.5px/1 Inter, -apple-system, Arial, sans-serif;
        color: #8b8b8f; letter-spacing: .2px;
        border-bottom: 2px solid transparent; margin-bottom: -1px;
      }
      #hoq-discord .hoq-subtab:hover { color: #d2d2d6; }
      #hoq-discord .hoq-subtab.hoq-on {
        color: #fff; border-bottom-color: var(--sc-accent, #ff5500);
      }
      /* One pane at a time; sections are tagged in ensureDiscordPanel(). */
      #hoq-discord[data-pane="social"] .hoq-pane-set { display: none !important; }
      #hoq-discord[data-pane="settings"] .hoq-dc-sec:not(.hoq-pane-set) { display: none !important; }
      #hoq-discord .hoq-acct-new:hover { background: color-mix(in srgb, var(--sc-accent,#ff5500) 22%, rgba(12,12,14,0.6)); }
    </style>
    <div class="hoq-dc-card">
      <div class="hoq-dc-top">
        <img class="hoq-dc-logo" src="${HOQ_LOGO}">
        <div class="hoq-dc-titles"><span>hoq</span></div>
        <div class="hoq-dc-accent" title="Current accent"><i class="a1"></i><i class="a2"></i></div>
      </div>
      <div class="hoq-sub">
        <button class="hoq-subtab hoq-on" data-pane="social">Social</button>
        <button class="hoq-subtab" data-pane="settings">Settings</button>
      </div>
      <div class="hoq-dc-body">
      <div class="hoq-dc-sec hoq-wide">
        <div class="hoq-dc-label">Your listening activity</div>
        <div class="hoq-dc-presence">
          <img class="hoq-dc-cover" src="${HOQ_LOGO}">
          <div class="hoq-dc-ptext">
            <b>Listening to holdonquietly</b>
            <span class="hoq-dc-title">Nothing playing</span>
            <span class="hoq-dc-artist"></span>
            <div class="hoq-dc-bar"><i></i></div>
            <div class="hoq-dc-times"><span class="hoq-dc-pos">0:00</span><span class="hoq-dc-dur">0:00</span></div>
          </div>
        </div>
        <div class="hoq-dc-quick">
          <button data-act="share">Share to Discord</button>
          <button data-act="play">Play in Discord</button>
          <button data-act="copy">Copy track link</button>
          <button data-act="server">Open server</button>
        </div>
      </div>
      <div class="hoq-dc-sec">
        <div class="hoq-dc-label">Last.fm scrobbling</div>
        <div class="hoq-lf">
          <div class="hoq-lf-logo">
            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3" y="10.5" width="3.4" height="8.5" rx="1.7" fill="#fff"/>
              <rect x="10.3" y="5" width="3.4" height="14" rx="1.7" fill="#fff"/>
              <rect x="17.6" y="13" width="3.4" height="6" rx="1.7" fill="#fff"/>
            </svg>
          </div>
          <div class="hoq-lf-text">
            <div class="hoq-lf-state">Not connected</div>
            <div class="hoq-lf-sub">Scrobble everything you play to Last.fm.</div>
          </div>
          <button class="hoq-lf-btn">Connect</button>
        </div>
      </div>
      <div class="hoq-dc-sec">
        <div class="hoq-dc-label">Accounts</div>
        <div class="hoq-acct-list"></div>
        <div class="hoq-acct-add">
          <input class="hoq-acct-name" placeholder="Save current session as… (e.g. main)">
          <button class="hoq-acct-save">Save</button>
        </div>
        <button class="hoq-acct-new">＋ Log into another account</button>
        <div class="hoq-dc-hint">Save the current session, then add another.</div>
      </div>
      <div class="hoq-dc-sec">
        <div class="hoq-dc-label">Your info</div>
        <input class="hoq-dc-sc" placeholder="SoundCloud profile link  (e.g. soundcloud.com/you)">
        <input class="hoq-dc-name" placeholder="Discord name" style="margin-top:8px">
      </div>
      <div class="hoq-dc-sec hoq-wide">
        <div class="hoq-dc-label">Settings</div>
        <div class="hoq-settings-host"></div>
      </div>
      <div class="hoq-dc-sec hoq-wide">
        <div class="hoq-dc-label">Listening stats</div>
        <div class="hoq-stat-row">
          <div class="hoq-stat"><b class="hoq-stat-plays">0</b><span>Tracks played</span></div>
          <div class="hoq-stat"><b class="hoq-stat-time">0m</b><span>Time listened</span></div>
          <div class="hoq-stat"><b class="hoq-stat-uniq">0</b><span>Different tracks</span></div>
          <div class="hoq-stat"><b class="hoq-stat-since">&mdash;</b><span>Counting since</span></div>
        </div>
        <div class="hoq-stat-cols">
          <div><div class="hoq-dc-label">Top artists</div><ol class="hoq-top hoq-top-artists"></ol></div>
          <div><div class="hoq-dc-label">Top tracks</div><ol class="hoq-top hoq-top-tracks"></ol></div>
        </div>
        <div class="hoq-dc-hint">Counted locally by the app &mdash; SoundCloud exposes no history API. <button class="hoq-stat-reset">Reset</button></div>
      </div>
      <div class="hoq-dc-sec hoq-wide">
        <div class="hoq-dc-label">Friends listening</div>
        <div class="hoq-dc-friends"></div>
      </div>
      <div class="hoq-dc-sec">
        <div class="hoq-dc-label">Server</div>
        <div class="hoq-dc-embed" style="display:none">
          <img class="hoq-dc-eicon" src="${HOQ_LOGO}">
          <div class="hoq-dc-etext">
            <div class="hoq-dc-ename">holdonquietly</div>
            <div class="hoq-dc-eonline"><span class="hoq-dc-dot"></span><span class="hoq-dc-count">—</span></div>
          </div>
        </div>
        <button class="hoq-dc-open">Open Discord server</button>
      </div>
      </div>
    </div>`;
  // Configuration lives behind the Settings sub-tab; everything else is Social.
  const SET_SECS = ['settings', 'accounts', 'last.fm scrobbling', 'your info'];
  p.querySelectorAll('.hoq-dc-sec').forEach((sec) => {
    const lab = sec.querySelector('.hoq-dc-label');
    const t = lab ? lab.textContent.trim().toLowerCase() : '';
    if (SET_SECS.indexOf(t) !== -1) sec.classList.add('hoq-pane-set');
  });
  // The palette is the point of the Settings pane, so lead with it.
  const setSecs = [...p.querySelectorAll('.hoq-dc-sec.hoq-pane-set')];
  const palSec = setSecs.find((sec) => sec.querySelector('.hoq-settings-host'));
  if (palSec && setSecs[0] && palSec !== setSecs[0]) {
    setSecs[0].parentNode.insertBefore(palSec, setSecs[0]);
  }
  // The sub-tab already reads "Settings"; the card's own label just repeats it.
  if (palSec) {
    const dup = palSec.querySelector('.hoq-dc-label');
    if (dup) dup.remove();
  }
  p.dataset.pane = 'social';
  p.querySelectorAll('.hoq-subtab').forEach((b) => {
    b.addEventListener('click', () => {
      p.dataset.pane = b.dataset.pane;
      p.querySelectorAll('.hoq-subtab').forEach((o) => o.classList.toggle('hoq-on', o === b));
      p.scrollTop = 0;
    });
  });
  document.body.appendChild(p);

  // Quick actions just drive the controls that already exist, so there's one
  // implementation of each behaviour rather than two.
  p.querySelectorAll('.hoq-dc-quick button').forEach((b) => {
    b.addEventListener('click', () => {
      const act = b.dataset.act;
      const flash = (txt) => {
        const was = b.textContent;
        b.textContent = txt; b.classList.add('done');
        setTimeout(() => { b.textContent = was; b.classList.remove('done'); }, 1400);
      };
      if (act === 'share') { const el = document.getElementById('hoq-share'); if (el) el.click(); flash('Shared'); }
      else if (act === 'play') { const el = document.getElementById('hoq-playbtn'); if (el) el.click(); flash('Queued'); }
      else if (act === 'server') { const el = p.querySelector('.hoq-dc-open'); if (el) el.click(); }
      else if (act === 'copy') {
        const link = document.querySelector('.playbackSoundBadge__titleLink');
        const href = link && link.getAttribute('href');
        if (href) { hoqCopy(href.startsWith('http') ? href : location.origin + href); flash('Copied'); }
        else flash('Nothing playing');
      }
    });
  });
  const reset = p.querySelector('.hoq-stat-reset');
  if (reset) reset.addEventListener('click', () => {
    try { localStorage.removeItem('hoqStats'); } catch (e) {}
    _statsTitle = ''; _statsLastTick = 0;
    renderHoqStats();
  });
  const name = p.querySelector('.hoq-dc-name');
  const sc = p.querySelector('.hoq-dc-sc');
  name.value = localStorage.getItem('hoqDiscord') || '';
  sc.value = localStorage.getItem('hoqSC') || '';
  name.addEventListener('change', () => localStorage.setItem('hoqDiscord', name.value.trim()));
  sc.addEventListener('change', () => localStorage.setItem('hoqSC', sc.value.trim()));
  p.querySelector('.hoq-dc-friends').innerHTML =
    '<div class="hoq-dc-hint">No one else is sharing yet. A shared friends feed (everyone\'s now-playing here) needs a small shared server — say the word and I\'ll set it up.</div>';
  p.querySelector('.hoq-dc-open').addEventListener('click', () => scPost('open:https://discord.com/channels/' + HOQ_SERVER));

  // Last.fm connect/disconnect (auth + scrobbling handled in the C# host).
  const lfBtn = p.querySelector('.hoq-lf-btn');
  lfBtn.addEventListener('click', () => {
    if (lfBtn.dataset.connected === '1') { scPost('lastfm:disconnect'); }
    else {
      lfBtn.textContent = 'Waiting…'; lfBtn.disabled = true;
      p.querySelector('.hoq-lf-sub').textContent = 'Approve holdonquietly in the Last.fm tab that just opened…';
      scPost('lastfm:connect');
    }
  });
  scPost('lastfm:status'); // ask the host for the current connection state

  // Accounts: save current session / switch / add another.
  const acctName = p.querySelector('.hoq-acct-name');
  p.querySelector('.hoq-acct-save').addEventListener('click', () => {
    const n = (acctName.value || '').trim();
    if (n) { scPost('acct:save:' + n); acctName.value = ''; }
  });
  p.querySelector('.hoq-acct-new').addEventListener('click', () => scPost('acct:new'));
  scPost('acct:list');

  return p;
}

// The host reports the saved account names here.
window.__hoqAccounts = function (names) {
  const el = document.querySelector('.hoq-acct-list');
  if (!el) return;
  const arr = Array.isArray(names) ? names : [];
  if (!arr.length) { el.innerHTML = '<div class="hoq-dc-hint">No saved accounts yet — save your current one below.</div>'; return; }
  el.innerHTML = arr.map((n) =>
    '<div class="hoq-acct-row"><b>' + hoqEsc(n) + '</b>' +
    '<button class="hoq-acct-sw" data-n="' + hoqEsc(n) + '">Switch</button>' +
    '<button class="hoq-acct-rm" data-n="' + hoqEsc(n) + '" title="Remove">&#10005;</button></div>').join('');
  el.querySelectorAll('.hoq-acct-sw').forEach((b) => b.addEventListener('click', () => scPost('acct:switch:' + b.dataset.n)));
  el.querySelectorAll('.hoq-acct-rm').forEach((b) => b.addEventListener('click', () => scPost('acct:remove:' + b.dataset.n)));
};

// The C# host reports Last.fm connection status here.
window.__hoqLastfm = function (connected, user) {
  const p = document.getElementById('hoq-discord');
  if (!p) return;
  const btn = p.querySelector('.hoq-lf-btn');
  const state = p.querySelector('.hoq-lf-state');
  const sub = p.querySelector('.hoq-lf-sub');
  if (!btn) return;
  btn.disabled = false;
  if (connected) {
    btn.dataset.connected = '1';
    btn.textContent = 'Disconnect';
    btn.classList.add('is-off');
    state.textContent = 'Connected' + (user ? ' as ' + user : '');
    sub.textContent = 'Everything you play is scrobbled to your Last.fm.';
  } else {
    btn.dataset.connected = '0';
    btn.textContent = 'Connect';
    btn.classList.remove('is-off');
    state.textContent = 'Not connected';
    sub.textContent = 'Scrobble everything you play to your Last.fm.';
  }
};

// Auto-updater toasts. The C# host calls this with 'ready' (a new version has been
// downloaded in the background — offer to restart & finish) or 'done' (this launch
// is already running a freshly-applied update). Self-contained: builds its own
// styled toast, our own element so it's safe to mutate.
window.__hoqUpdate = function (state, ver) {
  try {
    if (!document.getElementById('hoq-upd-style')) {
      const st = document.createElement('style');
      st.id = 'hoq-upd-style';
      st.textContent =
        '#hoq-upd{position:fixed;right:18px;bottom:96px;z-index:2147483600;max-width:320px;' +
        'display:flex;gap:12px;align-items:center;padding:13px 15px;border-radius:14px;' +
        'background:rgba(20,20,24,0.72);backdrop-filter:blur(22px) saturate(160%);' +
        '-webkit-backdrop-filter:blur(22px) saturate(160%);border:1px solid rgba(255,255,255,0.12);' +
        'box-shadow:0 12px 40px rgba(0,0,0,0.5);color:#fff;font:500 13px/1.35 system-ui,sans-serif;' +
        'transform:translateY(14px);opacity:0;transition:transform .35s cubic-bezier(.2,.9,.3,1),opacity .35s}' +
        '#hoq-upd.show{transform:translateY(0);opacity:1}' +
        '#hoq-upd .ic{width:30px;height:30px;flex:0 0 auto;border-radius:9px;display:grid;place-items:center;' +
        'background:var(--sc-accent,#ff5500);color:#fff;font-size:16px}' +
        '#hoq-upd .tx{flex:1 1 auto;min-width:0}' +
        '#hoq-upd .tx b{display:block;font-weight:700;font-size:13px}' +
        '#hoq-upd .tx span{display:block;opacity:.7;font-size:11.5px;margin-top:1px}' +
        '#hoq-upd button{flex:0 0 auto;border:0;cursor:pointer;padding:7px 12px;border-radius:9px;' +
        'background:var(--sc-accent,#ff5500);color:#fff;font:700 12px system-ui;white-space:nowrap}' +
        '#hoq-upd .x{background:transparent;color:rgba(255,255,255,.5);padding:4px 6px;font-size:16px}';
      document.head.appendChild(st);
    }
    let el = document.getElementById('hoq-upd');
    if (el) el.remove();
    el = document.createElement('div');
    el.id = 'hoq-upd';
    const v = ver ? ('v' + String(ver).replace(/^v/i, '')) : '';
    if (state === 'ready') {
      el.innerHTML = '<div class="ic">↓</div><div class="tx"><b>Update ' + v + ' ready</b>' +
        '<span>Restart to finish installing.</span></div>' +
        '<button class="go">Restart</button><button class="x">×</button>';
      el.querySelector('.go').onclick = () => scPost('update:apply');
    } else { // 'done'
      el.innerHTML = '<div class="ic">✓</div><div class="tx"><b>Updated to ' + v + '</b>' +
        '<span>You’re on the latest version.</span></div><button class="x">×</button>';
      setTimeout(() => { try { el.classList.remove('show'); setTimeout(() => el.remove(), 400); } catch (e) {} }, 6000);
    }
    el.querySelector('.x').onclick = () => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); };
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
  } catch (e) {}
};

// The C# host delivers the Discord server widget (name + online count) here.
window.__hoqDcWidget = function (data) {
  const p = document.getElementById('hoq-discord');
  if (!p) return;
  const embed = p.querySelector('.hoq-dc-embed');
  if (!embed) return;
  if (!data || !data.name) { embed.style.display = 'none'; return; }
  embed.style.display = 'flex';
  p.querySelector('.hoq-dc-ename').textContent = data.name;
  const n = (data.presence_count != null) ? data.presence_count : (data.members ? data.members.length : 0);
  p.querySelector('.hoq-dc-count').textContent = n + ' online';
};

// Local listening stats. SoundCloud exposes no history API, so the tab keeps its
// own tally: the track-change detection we already run for Rich Presence doubles
// as the counter. Stored in localStorage, so it survives restarts.
function hoqStatsRead() {
  try {
    const s = JSON.parse(localStorage.getItem('hoqStats')) || {};
    s.plays = s.plays || 0; s.seconds = s.seconds || 0;
    s.artists = s.artists || {}; s.tracks = s.tracks || {};
    if (!s.since) s.since = Date.now();
    return s;
  } catch (e) { return { plays: 0, seconds: 0, artists: {}, tracks: {}, since: Date.now() }; }
}
function hoqStatsWrite(s) { try { localStorage.setItem('hoqStats', JSON.stringify(s)); } catch (e) {} }

let _statsTitle = '', _statsLastTick = 0;
function hoqStatsTick() {
  const np = currentNowPlaying();
  const pr = playerProgress();
  const s = hoqStatsRead();
  const now = Date.now();
  if (!pr.paused && np.title) {
    // Cap the delta so a backgrounded app or a long pause can't bank hours.
    if (_statsLastTick) s.seconds += Math.min(15, Math.round((now - _statsLastTick) / 1000));
    _statsLastTick = now;
  } else {
    _statsLastTick = 0;
  }
  if (np.title && np.title !== _statsTitle) {
    _statsTitle = np.title;
    s.plays++;
    s.tracks[np.title] = (s.tracks[np.title] || 0) + 1;
    if (np.artist) s.artists[np.artist] = (s.artists[np.artist] || 0) + 1;
  }
  hoqStatsWrite(s);
}

function hoqFmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? h + 'h ' + m + 'm' : (m || Math.round(sec / 60)) + 'm';
}

function renderHoqStats() {
  const p = document.getElementById('hoq-discord');
  if (!p || !p.classList.contains('open')) return;
  const s = hoqStatsRead();
  const set = (sel, v) => { const el = p.querySelector(sel); if (el) el.textContent = v; };
  set('.hoq-stat-plays', s.plays.toLocaleString());
  set('.hoq-stat-time', hoqFmtDur(s.seconds));
  set('.hoq-stat-uniq', Object.keys(s.tracks).length.toLocaleString());
  set('.hoq-stat-since', new Date(s.since).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
  const top = (obj, n) => Object.keys(obj).map((k) => [k, obj[k]])
    .sort((a, b) => b[1] - a[1]).slice(0, n);
  const fill = (sel, rows, unit) => {
    const el = p.querySelector(sel);
    if (!el) return;
    el.innerHTML = rows.length
      ? rows.map((r) => '<li><b>' + hoqEsc(r[0]) + '</b><em>' + r[1] + ' ' + unit + (r[1] === 1 ? '' : 's') + '</em></li>').join('')
      : '<li><b style="color:#7a7a7c">Nothing yet — play something.</b></li>';
  };
  fill('.hoq-top-artists', top(s.artists, 5), 'play');
  fill('.hoq-top-tracks', top(s.tracks, 5), 'play');
}

function updateDiscordActivity() {
  const p = document.getElementById('hoq-discord');
  if (!p || !p.classList.contains('open')) return;
  const np = currentNowPlaying();
  p.querySelector('.hoq-dc-title').textContent = np.title || 'Nothing playing';
  p.querySelector('.hoq-dc-artist').textContent = np.artist || '';
  const cov = p.querySelector('.hoq-dc-cover');
  cov.src = np.cover || HOQ_LOGO;
  const pr = playerProgress();
  const bar = p.querySelector('.hoq-dc-bar i');
  if (bar) bar.style.width = (pr.dur > 0 ? Math.min(100, (pr.pos / pr.dur) * 100) : 0).toFixed(1) + '%';
  const t = (n) => Math.floor(n / 60) + ':' + String(Math.floor(n % 60)).padStart(2, '0');
  const pos = p.querySelector('.hoq-dc-pos'), dur = p.querySelector('.hoq-dc-dur');
  if (pos) pos.textContent = t(pr.pos || 0);
  if (dur) dur.textContent = t(pr.dur || 0);
  renderHoqStats();
}

// The tab occupies the same band SoundCloud's own content does — under the
// header, above the player. Both edges are measured rather than assumed: the
// titlebar is merged into the header (so it isn't 50px) and the player can be
// absent (so the bottom isn't always 0), which is what made it sit wrong and
// cover the play controls.
function hoqTabMetrics() {
  // Height is the only reliable signal here: SoundCloud leaves
  // visibility:hidden on the .playControls wrapper and turns a child visible, so
  // testing visibility measured the player as absent and let the tab run over it.
  const vis = (el) =>
    !!el && getComputedStyle(el).display !== 'none' &&
    el.getBoundingClientRect().height > 0;
  const hdr = document.querySelector('.header, .l-fixed-top');
  const ply = document.querySelector('.playControls');
  const top = vis(hdr) ? Math.round(hdr.getBoundingClientRect().bottom) : 50;
  const bot = vis(ply) ? Math.round(ply.getBoundingClientRect().height) : 0;
  const r = document.documentElement.style;
  r.setProperty('--hoq-tab-top', Math.max(0, top) + 'px');
  r.setProperty('--hoq-tab-bottom', Math.max(0, bot) + 'px');
}

function closeDiscord() {
  const p = document.getElementById('hoq-discord');
  const wasOpen = !!(p && p.classList.contains('open'));
  if (p) p.classList.remove('open');
  document.documentElement.classList.remove('hoq-tab');
  const tab = document.querySelector('.hoq-dc-tab');
  if (tab) tab.classList.remove('sc-selected', 'hoq-active');
  void wasOpen;
}

function toggleDiscord() {
  const p = ensureDiscordPanel();
  const opening = !p.classList.contains('open');
  p.classList.toggle('open', opening);
  const tab = document.querySelector('.hoq-dc-tab');
  if (tab) tab.classList.toggle('hoq-active', opening);
  document.documentElement.classList.toggle('hoq-tab', opening);
  if (opening) {
    // Re-parent the settings palette into the tab. appendChild MOVES the node,
    // so every listener wired in buildTitlebar() survives untouched — nothing
    // about the palette's behaviour is duplicated here.
    try {
      const pal = document.getElementById('sc-palette');
      const host = p.querySelector('.hoq-settings-host');
      if (pal && host && pal.parentElement !== host) host.appendChild(pal);
    } catch (e) {}
    hoqTabMetrics();
    // Deliberately NO pushState/hash here. Writing '#hoq' made SoundCloud's own
    // router react and rewrite history state, which fired popstate and closed the
    // tab a moment after it opened. The tab is client-side only.
    scPost('dcwidget');       // refresh the server embed
    scPost('lastfm:status');  // refresh Last.fm state
    scPost('acct:list');      // refresh saved accounts
  }
  updateDiscordActivity();
}

// One delegated listener instead of per-nav-item {once:true} handlers — React
// re-renders the header constantly, and those bindings died with it, which left
// the tab stuck open over whatever page you'd navigated to.
if (window.top === window) {
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('#hoq-discord') || t.closest('.hoq-dc-tab')) return;
    if (t.closest('.header__navMenuItem, .header__logo, .headerSearch, a[href^="/"]')) closeDiscord();
  }, true);
  // Any real navigation should drop the tab, whichever way it was triggered.
  window.addEventListener('popstate', () => closeDiscord());
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDiscord(); });
  window.addEventListener('resize', () => {
    if (document.documentElement.classList.contains('hoq-tab')) hoqTabMetrics();
  });
}

function myId() {
  let id = localStorage.getItem('hoqId');
  if (!id) { id = 'u' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('hoqId', id); }
  return id;
}

// Real song position / duration / play-state from the player UI.
function playerProgress() {
  const parseT = (sel) => {
    const el = document.querySelector(sel);
    const m = (el && el.textContent || '').trim().match(/(\d+):(\d+)/);
    return m ? (+m[1] * 60 + +m[2]) : 0;
  };
  const btn = document.querySelector('.playControls__play');
  const title = (btn && btn.getAttribute('title') || '').trim();
  // SoundCloud marks the active state with a `playing` class and flips the title
  // between "Play current" / "Pause current". Read the CLASS first: the title is
  // user-facing English, so matching /^play/i reported "paused" the whole time on
  // any non-English UI — and this flag drives the visualizer, Discord Rich
  // Presence and Last.fm scrobbling, not just the waveform.
  const paused = !btn ? true
    : btn.classList.contains('playing') ? false
    : /^pause/i.test(title) ? false
    : (/^play/i.test(title) || btn.classList.contains('sc-ico-play'));
  return { pos: parseT('.playbackTimeline__timePassed'), dur: parseT('.playbackTimeline__duration'), paused };
}

// Measure how far a too-long now-playing title has to slide so the hover marquee
// travels exactly the overflow and no further. Read-only on SoundCloud's DOM —
// only a class and two custom properties, no children touched (rule 1).
function tuneNowPlayingMarquee() {
  const link = document.querySelector('.playbackSoundBadge__titleLink');
  if (!link) return;
  const over = Math.round(link.scrollWidth - link.clientWidth);
  if (over > 6) {
    link.classList.add('hoq-mq');
    link.style.setProperty('--hoq-mq', (-over - 6) + 'px');
    link.style.setProperty('--hoq-mq-dur', Math.max(5, Math.min(16, over / 22)).toFixed(1) + 's');
  } else if (link.classList.contains('hoq-mq')) {
    link.classList.remove('hoq-mq');
    link.style.removeProperty('--hoq-mq');
    link.style.removeProperty('--hoq-mq-dur');
  }
}

// Push now-playing to the C# host (Discord Rich Presence + friends backend).
let _lastRpc = '';
function rpcTick() {
  const np = currentNowPlaying();
  const pr = playerProgress();
  const key = np.title + '|' + pr.paused + '|' + Math.round(pr.pos / 8);
  if (key === _lastRpc) return;
  _lastRpc = key;
  scPost('rpc:' + JSON.stringify({
    id: myId(),
    name: localStorage.getItem('hoqDiscord') || '',
    sc: localStorage.getItem('hoqSC') || '',
    title: np.title, artist: np.artist, cover: np.cover,
    pos: pr.pos, dur: pr.dur, paused: pr.paused,
  }));
}

// ---------------------------------------------------------------------------
// "Share to Discord" — a floating button that posts the current track to a
// Discord webhook. The webhook URL is read HOST-SIDE from a local config file
// (%LocalAppData%\SoundCloudApp\webhook.txt), never embedded in the page/repo,
// and the POST is done by the C# host (Discord webhooks don't send CORS headers,
// so a page fetch would be blocked). Our own element → safe to build/mutate.
// ---------------------------------------------------------------------------
// Who is sharing: the display name set in the hub (falls back to the SoundCloud
// username), plus their SoundCloud avatar (a public sndcdn URL Discord can load).
// Pull an image URL from an element (inline style, computed bg, or <img> src).
function _bgUrl(el) {
  if (!el) return '';
  if (el.tagName === 'IMG') return el.getAttribute('src') || el.src || '';
  const raw = (el.getAttribute && el.getAttribute('style')) || '';
  let m = raw.match(/url\(["']?(.*?)["']?\)/);
  if (m && m[1]) return m[1];
  m = (getComputedStyle(el).backgroundImage || '').match(/url\(["']?(.*?)["']?\)/);
  return (m && m[1]) ? m[1] : '';
}

// Find the logged-in user's avatar in the header (SoundCloud changes classes, so
// try several selectors, then fall back to scanning the header for a SoundCloud
// avatar URL — those are public i*.sndcdn.com/avatars-... images Discord can load).
function findUserAvatar() {
  const btn = document.querySelector(
    '.header__userNavButton, .userNav__usernameButton, .header a[href="/you"], .header a[href^="/you/"], .header [class*="userNav" i]'
  );
  if (btn) {
    const inner = btn.querySelector('img, .sc-artwork, [style*="url("], .image__full, span');
    const u = _bgUrl(inner) || _bgUrl(btn);
    if (u) return u;
  }
  const header = document.querySelector('.header') || document.body;
  const img = header.querySelector('img[src*="avatars-"], img[src*="sndcdn"]');
  if (img) return img.getAttribute('src') || img.src || '';
  const els = header.querySelectorAll('.sc-artwork, [style*="avatars-"], [style*="url("]');
  for (const el of els) { const b = _bgUrl(el); if (/avatars-|sndcdn/i.test(b)) return b; }
  return '';
}

function senderInfo() {
  let name = (localStorage.getItem('hoqDiscord') || '').trim();
  let sc = (localStorage.getItem('hoqSC') || '').trim();
  if (!name && sc) name = sc.replace(/[/?#].*$/, '').replace(/\/+$/, '').split('/').pop() || '';
  let avatar = findUserAvatar();
  // Bump SoundCloud thumbs to a crisp size (only when it's a recognizably sized URL).
  if (avatar && /(?:-|_)(?:t?\d+x\d+|badge|small|large|tiny|mini|original|crop)\.(?:jpe?g|png|webp|gif)/i.test(avatar)) {
    avatar = avatar.replace(/(?:-|_)(?:t?\d+x\d+|badge|small|large|tiny|mini|original|crop)\./i, '-t200x200.');
  }
  return { name, avatar };
}

// The current accent (cover-matched) as a Discord embed color int.
function accentInt() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--sc-accent').trim();
  const m = v.match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) return (+m[1] << 16) + (+m[2] << 8) + (+m[3]);
  const h = v.match(/#([0-9a-f]{6})/i);
  return h ? parseInt(h[1], 16) : null;
}

function shareCurrentSong() {
  const np = currentNowPlaying();
  const linkEl = document.querySelector('.playbackSoundBadge__titleLink');
  let url = '';
  if (linkEl) { const h = linkEl.getAttribute('href') || ''; url = h ? (h.startsWith('http') ? h : location.origin + h) : ''; }
  const s = senderInfo();
  const dur = playerProgress().dur;
  const length = dur > 0 ? (Math.floor(dur / 60) + ':' + String(dur % 60).padStart(2, '0')) : '';
  return { title: np.title, artist: np.artist, cover: np.cover, url, name: s.name, avatar: s.avatar, color: accentInt(), length };
}

// One share per track: once shared, the button locks to a "Shared" state and
// only re-enables when the track changes. In-memory, so it also resets on app
// restart (page reload re-injects preload).
let _hoqLastShared = '';

function startShareButton() {
  if (document.getElementById('hoq-share')) return;
  if (!document.getElementById('hoq-share-style')) {
    const st = document.createElement('style');
    st.id = 'hoq-share-style';
    st.textContent =
      // Lives in the player bar's action cluster, styled like SoundCloud's own
      // icon buttons there. Hidden while unmounted so it can never float loose.
      '#hoq-share{display:none}' +
      '.playbackSoundBadge__actions #hoq-share{display:inline-flex;align-items:center;justify-content:center;' +
      'width:30px;height:30px;margin-left:10px;padding:0;background:none;border:0;' +
      'border-radius:7px;cursor:pointer;color:#b4b4b8;flex:0 0 auto;' +
      'transition:color .15s ease,background .15s ease}' +
      '.playbackSoundBadge__actions #hoq-share:hover{color:var(--sc-accent,#ff5500);background:rgba(255,255,255,0.09)}' +
      '.playbackSoundBadge__actions #hoq-share svg{width:16px;height:16px;flex:0 0 auto}' +
      // The label becomes the tooltip once we're icon-only.
      '.playbackSoundBadge__actions #hoq-share span{display:none}' +
      '.playbackSoundBadge__actions #hoq-share.done{color:var(--sc-accent,#ff5500);cursor:default}' +
      '.playbackSoundBadge__actions #hoq-share.done:hover{background:none}';
    document.head.appendChild(st);
  }
  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg>';
  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  const btn = document.createElement('button');
  btn.id = 'hoq-share';

  // Unique-per-track key: the track link, else title|artist.
  const songKey = () => {
    const linkEl = document.querySelector('.playbackSoundBadge__titleLink');
    const h = linkEl ? (linkEl.getAttribute('href') || '') : '';
    if (h) return h;
    const np = currentNowPlaying();
    return np.title ? (np.title + '|' + np.artist) : '';
  };
  // Paint the button for the current track's shared state (skips while a
  // transient message like "Nothing playing" is showing).
  const refresh = () => {
    if (btn.dataset.msg) return;
    const shared = songKey() && songKey() === _hoqLastShared;
    btn.classList.toggle('done', !!shared);
    btn.innerHTML = (shared ? CHECK : ICON) + '<span>' + (shared ? 'Shared' : 'Share to Discord') + '</span>';
  };
  const flash = (txt) => {
    btn.dataset.msg = '1';
    btn.innerHTML = ICON + '<span>' + txt + '</span>';
    setTimeout(() => { delete btn.dataset.msg; refresh(); }, 1600);
  };

  btn.onclick = () => {
    const k = songKey();
    if (!k) { flash('Nothing playing'); return; }
    if (k === _hoqLastShared) return; // already shared this track — locked until it changes / restart
    const payload = shareCurrentSong();
    scPost('DBG share name=' + (payload.name || '(none)') + ' avatar=' + (payload.avatar || '(none)'));
    scPost('webhook:' + JSON.stringify(payload));
    _hoqLastShared = k;
    refresh(); // lock to "Shared" until the track changes
  };

  document.body.appendChild(btn);
  refresh();
  setInterval(refresh, 1000); // re-enables automatically when a new track starts
}

// "Play in Discord" — same payload as Share, but flagged so the host marks
// it as a play request. Sits above the Share button and shares its styling.
let _hoqLastQueued = '';

// ---------------------------------------------------------------------------
// Queue ANY track, not just the one playing. The bot resolves from the URL, so
// title/artist/cover here only decide what the embed shows.
// ---------------------------------------------------------------------------
const HOQ_Q_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const HOQ_Q_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

// A track permalink is exactly /<user>/<track> — two segments, no reserved first
// segment, and not a /sets/ playlist.
function trackLinkInfo(link) {
  if (!link || !link.getAttribute) return null;
  let href = link.getAttribute('href') || '';
  if (!href) return null;
  if (!href.startsWith('http')) href = location.origin + href;
  let u;
  try { u = new URL(href); } catch (e) { return null; }
  if (!/(^|\.)soundcloud\.com$/i.test(u.hostname)) return null;
  const seg = u.pathname.split('/').filter(Boolean);
  if (seg.length !== 2 || NOT_A_TRACK.test(seg[0]) || seg[1] === 'sets') return null;
  const row = link.closest && link.closest(
    '[role="listitem"], .soundBadge, .trackItem, .soundList__item, .compactTrackListItem, li');
  const title = (link.textContent || '').trim() || seg[1].replace(/-/g, ' ');
  let artist = seg[0], cover = '';
  if (row) {
    // The uploader link in the same row is the one with a single path segment.
    const prof = [...row.querySelectorAll('a[href]')].find((a) => {
      // Parse it — these hrefs are absolute on the new page, so splitting the raw
      // attribute counted "https:" and the host as path segments.
      let h = a.getAttribute('href') || '';
      if (!h) return false;
      if (!h.startsWith('http')) h = location.origin + h;
      let pu;
      try { pu = new URL(h); } catch (e) { return false; }
      const p = pu.pathname.split('/').filter(Boolean);
      return p.length === 1 && !NOT_A_TRACK.test(p[0]);
    });
    if (prof && (prof.textContent || '').trim()) artist = prof.textContent.trim();
    const img = row.querySelector('img[src*="sndcdn"]');
    if (img && img.src) cover = img.src.replace(/-t\d+x\d+\./, '-t500x500.');
  }
  return { url: u.origin + u.pathname, title: title.slice(0, 140), artist, cover };
}

// The track this PAGE is about. When you're looking at a song you aren't playing,
// that's the one "Play in Discord" should queue.
function pageTrackInfo() {
  const seg = location.pathname.split('/').filter(Boolean);
  if (seg.length !== 2 || NOT_A_TRACK.test(seg[0]) || seg[1] === 'sets') return null;
  let title = '', artist = '';
  for (const f of document.querySelectorAll('iframe')) {     // new webi V2 page
    let d = null;
    try { d = f.contentDocument; } catch (e) { continue; }
    if (!d) continue;
    const h = d.querySelector('section[aria-label="Track header"] h1');
    if (!h) continue;
    title = (h.textContent || '').trim();
    const a = d.querySelector('section[aria-label="Track header"] a[href$="/' + seg[0] + '"]');
    if (a) artist = (a.textContent || '').trim();
    break;
  }
  if (!title) {                                               // legacy page
    const h = document.querySelector('.fullHero__title, .soundTitle__title');
    if (h) title = (h.textContent || '').trim();
    const a = document.querySelector('.soundTitle__username, .fullHero__uploader a');
    if (a) artist = (a.textContent || '').trim();
  }
  if (!title) return null;
  return {
    url: location.origin + '/' + seg[0] + '/' + seg[1],
    title: title.slice(0, 140),
    artist: artist || seg[0],
    cover: pageCoverUrl() || '',
  };
}

function queueTrack(info) {
  if (!info || !info.url) return false;
  const s = senderInfo();
  scPost('playreq:' + JSON.stringify({
    title: info.title, artist: info.artist, cover: info.cover, url: info.url,
    name: s.name, avatar: s.avatar, color: accentInt(), length: '',
  }));
  return true;
}

// Drop a hover-reveal queue button on every track row, in whichever document we
// are handed — the new track page's related tracks live in the webi iframe, the
// feed/search/legacy rows live in the top frame.
function addQueueButtons(d) {
  const ROWS = '[role="listitem"], .soundBadge, .trackItem, .soundList__item, .compactTrackListItem';
  let rows;
  try { rows = d.querySelectorAll(ROWS); } catch (e) { return; }
  rows.forEach((row) => {
    if (row.querySelector(':scope > .hoq-q')) return;
    let info = null;
    for (const a of row.querySelectorAll('a[href]')) {
      info = trackLinkInfo(a);
      if (info) break;
    }
    if (!info) return;
    const b = d.createElement('button');
    b.className = 'hoq-q';
    b.type = 'button';
    b.title = 'Play in Discord';
    b.innerHTML = HOQ_Q_PLAY;
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();   // don't let the row navigate / start playback
      if (b.classList.contains('done')) return;
      if (queueTrack(info)) { b.classList.add('done'); b.innerHTML = HOQ_Q_CHECK; b.title = 'Queued'; }
    });
    try { if (d.defaultView.getComputedStyle(row).position === 'static') row.style.position = 'relative'; } catch (e) {}
    row.appendChild(b);
  });
}

// The Discord actions belong beside the other now-playing actions, not floating
// over the page — as fixed FABs they parked on top of whatever sat bottom-right
// (the Reposts stat on the new track page). appendChild MOVES them, so their
// handlers survive. The player bar unmounts with playback and React re-renders
// it, so this re-mounts (and rebuilds, if React took the container with it).
function mountDiscordActions() {
  const host = document.querySelector('.playbackSoundBadge__actions');
  if (!host) return;
  if (!document.getElementById('hoq-playbtn')) { try { startPlayButton(); } catch (e) {} }
  if (!document.getElementById('hoq-share')) { try { startShareButton(); } catch (e) {} }
  for (const id of ['hoq-playbtn', 'hoq-share']) {
    const b = document.getElementById(id);
    if (!b) continue;
    if (b.parentElement !== host) host.appendChild(b);
    // Keep the tooltip in step with the button's own label (Share/Shared, …).
    const label = b.querySelector('span');
    if (label) b.title = label.textContent.trim();
  }
}

function startPlayButton() {
  if (document.getElementById('hoq-playbtn')) return;
  if (!document.getElementById('hoq-playbtn-style')) {
    const st = document.createElement('style');
    st.id = 'hoq-playbtn-style';
    st.textContent =
      // Lives in the player bar's action cluster, styled like SoundCloud's own
      // icon buttons there. Hidden while unmounted so it can never float loose.
      '#hoq-playbtn{display:none}' +
      '.playbackSoundBadge__actions #hoq-playbtn{display:inline-flex;align-items:center;justify-content:center;' +
      'width:30px;height:30px;margin-left:10px;padding:0;background:none;border:0;' +
      'border-radius:7px;cursor:pointer;color:#b4b4b8;flex:0 0 auto;' +
      'transition:color .15s ease,background .15s ease}' +
      '.playbackSoundBadge__actions #hoq-playbtn:hover{color:var(--sc-accent,#ff5500);background:rgba(255,255,255,0.09)}' +
      // Hairline before the pair so the Discord actions read as ours rather than
      // as two more of SoundCloud's own buttons.
      '.playbackSoundBadge__actions #hoq-playbtn{position:relative;margin-left:17px}' +
      '.playbackSoundBadge__actions #hoq-playbtn::before{content:"";position:absolute;left:-9px;' +
      'top:5px;bottom:5px;width:1px;background:rgba(255,255,255,0.15)}' +
      '.playbackSoundBadge__actions #hoq-playbtn svg{width:16px;height:16px;flex:0 0 auto}' +
      // The label becomes the tooltip once we're icon-only.
      '.playbackSoundBadge__actions #hoq-playbtn span{display:none}' +
      '.playbackSoundBadge__actions #hoq-playbtn.done{color:var(--sc-accent,#ff5500);cursor:default}' +
      '.playbackSoundBadge__actions #hoq-playbtn.done:hover{background:none}';
    document.head.appendChild(st);
  }

  const PLAY  = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

  const btn = document.createElement('button');
  btn.id = 'hoq-playbtn';

  // Viewing a track wins over what's playing, so this queues the song on screen
  // rather than whatever happens to be loaded in the player.
  const songKey = () => {
    const pt = pageTrackInfo();
    if (pt) return pt.url;
    const linkEl = document.querySelector('.playbackSoundBadge__titleLink');
    const h = linkEl ? (linkEl.getAttribute('href') || '') : '';
    if (h) return h;
    const np = currentNowPlaying();
    return np.title ? (np.title + '|' + np.artist) : '';
  };

  const refresh = () => {
    if (btn.dataset.msg) return;
    const queued = songKey() && songKey() === _hoqLastQueued;
    btn.classList.toggle('done', !!queued);
    btn.innerHTML = (queued ? CHECK : PLAY) + '<span>' + (queued ? 'Queued' : 'Play in Discord') + '</span>';
  };
  const flash = (txt) => {
    btn.dataset.msg = '1';
    btn.innerHTML = PLAY + '<span>' + txt + '</span>';
    setTimeout(() => { delete btn.dataset.msg; refresh(); }, 1600);
  };

  btn.onclick = () => {
    const k = songKey();
    if (!k) { flash('Nothing playing'); return; }
    // On a track page, queue THAT track; elsewhere fall back to now-playing.
    const pt = pageTrackInfo();
    let payload;
    if (pt) {
      const s = senderInfo();
      payload = {
        title: pt.title, artist: pt.artist, cover: pt.cover, url: pt.url,
        name: s.name, avatar: s.avatar, color: accentInt(), length: '',
      };
    } else {
      payload = shareCurrentSong();
    }
    // The bot needs a real track link to resolve; a title alone is no use.
    if (!payload.url) { flash('No track link'); return; }
    if (k === _hoqLastQueued) return;   // one request per track
    scPost('playreq:' + JSON.stringify(payload));
    _hoqLastQueued = k;
    refresh();
  };

  document.body.appendChild(btn);
  refresh();
  setInterval(refresh, 1000);   // re-enables when the track changes
}

function hoqEsc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }

// The C# host delivers everyone's presence here → render the friends feed.
window.__hoqFriends = function (list) {
  const el = document.querySelector('.hoq-dc-friends');
  if (!el) return;
  const me = myId();
  const all = (Array.isArray(list) ? list : []).filter((f) => f.title);
  const others = all.filter((f) => f.id !== me);
  const mine = all.filter((f) => f.id === me);
  // Show your own row too. "No friends listening" on its own is indistinguishable
  // from the feed being broken; seeing yourself in it proves presence is live.
  const rows = others.concat(mine);
  if (!rows.length) {
    el.innerHTML = '<div class="hoq-dc-hint">Nobody is reporting right now — not even you. ' +
      'Presence only posts while a track is playing.</div>';
    return;
  }
  if (!others.length) {
    el.innerHTML = '<div class="hoq-dc-hint">Only you are on right now.</div>';
  }
  el.innerHTML += rows.map((f) => '<div class="hoq-dc-friend' + (f.id === me ? ' is-me' : '') + '">' +
    '<img class="hoq-dc-fcover" src="' + (hoqEsc(f.cover) || HOQ_LOGO) + '">' +
    '<div class="hoq-dc-ftext"><b>' + hoqEsc(f.name || 'Someone') +
    (f.id === me ? '<em class="hoq-me">you</em>' : '') + '</b>' +
    '<span>' + hoqEsc(f.title) + (f.artist ? ' · ' + hoqEsc(f.artist) : '') + '</span>' +
    (f.sc ? '<a class="hoq-dc-sclink" data-url="' + hoqEsc(f.sc) + '">' + hoqEsc(f.sc.replace(/^https?:\/\//, '')) + '</a>' : '') +
    '</div></div>').join('');
  el.querySelectorAll('.hoq-dc-sclink').forEach((a) => a.addEventListener('click', () => scPost('open:' + a.dataset.url)));
};

// ---------------------------------------------------------------------------
// Spotify-style horizontal volume slider (0-100), replacing SoundCloud's
// vertical hover popup. Drives every media element's volume directly.
// ---------------------------------------------------------------------------
function updateVolFill(sl) {
  sl.style.background = 'linear-gradient(to right, var(--sc-accent, #ff5500) ' +
    sl.value + '%, rgba(255,255,255,0.22) ' + sl.value + '%)';
}
function buildVolume() {
  const v = document.querySelector('.volume');
  if (!v || v.querySelector('.hoq-vol')) return;
  const sl = document.createElement('input');
  sl.type = 'range'; sl.className = 'hoq-vol'; sl.min = '0'; sl.max = '100'; sl.step = '1';
  sl.value = String(Math.round((window.__scGetVolume ? window.__scGetVolume() : 1) * 100));

  // Live percent readout — always visible, updates as you move (no hover needed).
  const pct = document.createElement('span');
  pct.className = 'hoq-vol-pct';
  pct.textContent = sl.value + '%';

  // Popup that appears from the speaker icon; holds the slider + live percent.
  const pop = document.createElement('div');
  pop.className = 'hoq-vol-pop';
  pop.appendChild(sl);
  pop.appendChild(pct);

  const apply = () => {
    if (window.__scSetVolume) window.__scSetVolume(sl.value / 100);
    pct.textContent = sl.value + '%';
    updateVolFill(sl);
  };
  updateVolFill(sl);
  sl.addEventListener('input', apply);

  // Keep the popup open while dragging even if the cursor slips out of the icon.
  sl.addEventListener('pointerdown', () => pop.classList.add('hoq-show'));
  window.addEventListener('pointerup', () => pop.classList.remove('hoq-show'));

  // Scroll anywhere over the volume control (icon or popup) to nudge it, and
  // briefly flash the popup so you can see the %.
  let hideT;
  const flash = () => { pop.classList.add('hoq-show'); clearTimeout(hideT); hideT = setTimeout(() => pop.classList.remove('hoq-show'), 1000); };
  const wheel = (e) => {
    e.preventDefault();
    sl.value = String(Math.max(0, Math.min(100, +sl.value + (e.deltaY < 0 ? 3 : -3))));
    apply();
    flash();
  };
  v.addEventListener('wheel', wheel, { passive: false });

  // Grace period so the popup doesn't vanish the instant the cursor leaves the
  // icon on its way up to the slider (pure CSS :hover was too twitchy).
  let leaveT;
  const showPop = () => { clearTimeout(leaveT); pop.classList.add('hoq-show'); };
  const hidePop = () => { clearTimeout(leaveT); leaveT = setTimeout(() => pop.classList.remove('hoq-show'), 550); };
  v.addEventListener('mouseenter', showPop);
  v.addEventListener('mouseleave', hidePop);
  pop.addEventListener('mouseenter', showPop);
  pop.addEventListener('mouseleave', hidePop);

  v.appendChild(pop);
}

// ---------------------------------------------------------------------------
// Text/DOM fallbacks for clutter whose class names are randomized
// ---------------------------------------------------------------------------
function removeClutter() {
  try { buildDiscordTab(); } catch (e) {}
  try { buildVolume(); } catch (e) {}
  try { moveFans(); } catch (e) {}
  document.documentElement.classList.toggle('hoq-feed', /\/feed/i.test(location.pathname));
  // GO MOBILE heading
  document
    .querySelectorAll('h1,h2,h3,h4,.sidebarHeader__title,.sc-type-h5')
    .forEach((h) => {
      const t = (h.textContent || '').trim().toLowerCase();
      if (t === 'go mobile' || t === 'get the app') {
        const box = h.closest('.sidebarModule, section') || h.parentElement;
        if (box) box.style.display = 'none';
      }
    });
  // Footer legal links
  const legal = Array.from(document.querySelectorAll('a')).find(
    (a) => (a.textContent || '').trim().toLowerCase() === 'legal'
  );
  if (legal) {
    const foot = legal.closest('footer, .footer, nav, ul') || legal.parentElement;
    if (foot) foot.style.display = 'none';
  }

  // Run each removal isolated so one failure can't stop the others.
  const safe = (fn) => { try { fn(); } catch (e) {} };
  // Structural containers we must NEVER hide (hiding these breaks whole pages,
  // e.g. the profile header lives in an .l-container).
  const STRUCT_SEL =
    '.l-container, .l-content, #content, main, .header, .l-fixed-top, ' +
    '.l-listen-wrapper, .l-about, .l-user, .userInfoBar, ' +
    '.l-user-hero, .profileHeader, .profileHeaderBackground, .profileHeaderInfo';
  const isStruct = (el) => !!(el && el.matches && el.matches(STRUCT_SEL));
  // Hide + tag so diagnostics can tell OUR hides from SoundCloud's own.
  const kill = (el) => {
    if (!el || isStruct(el)) return;
    el.style.display = 'none';
    el.setAttribute('data-schid', '1');
  };

  // Repaint leftover SoundCloud-orange badges/dots/text to the accent color.
  safe(recolorOrange);

  // 0) Kill embedded-module + ad IFRAMES (Artist Tools = the "credit-tracker"
  //    iframe; ad banners = velvetcake / google). Our code can't reach inside a
  //    cross-origin iframe, but we CAN hide the iframe element + its wrapper.
  safe(() => {
    // NOTE: velvetcake/banner? is the PROFILE HEADER banner — never block it.
    const KILL_FRAMES = [
      'credit-tracker', 'adtrafficquality',
      'googlesyndication', 'doubleclick', '/promoted',
    ];
    document.querySelectorAll('iframe').forEach((f) => {
      const src = f.src || '';
      if (!KILL_FRAMES.some((k) => src.includes(k))) return;
      // Climb up through wrappers that exist only to hold this iframe.
      let n = f;
      while (
        n.parentElement &&
        n.parentElement !== document.body &&
        n.parentElement.children.length === 1
      ) {
        n = n.parentElement;
      }
      kill(n);
      kill(f);
    });
  });

  // Leaf-ish elements whose trimmed text includes any phrase (<= maxLen chars).
  const findByText = (phrases, maxLen) =>
    Array.from(
      document.querySelectorAll('a,button,span,strong,div,h1,h2,h3,h4,li,p')
    ).filter((el) => {
      const t = (el.textContent || '').trim().toLowerCase();
      return t && t.length <= maxLen && phrases.some((p) => t.includes(p));
    });

  // Climb up while the container stays "just this thing" (text stays short),
  // so we hide the whole banner/module box without swallowing the sidebar.
  const hideBox = (el, limit) => {
    let n = el;
    for (let i = 0; i < 6 && n.parentElement; i++) {
      const p = n.parentElement;
      if (p === document.body || isStruct(p)) break; // never climb into page structure
      if ((p.textContent || '').trim().length > limit) break;
      n = p;
    }
    kill(n);
  };

  // 1) ARTIST TOOLS module (label shares its row with an "in 15 days" pill, so
  //    match by "includes" then climb until the block also contains the tools).
  safe(() => {
    const label = findByText(['artist tools', 'artist shortcuts'], 30)[0];
    if (!label) return;
    let n = label;
    for (let i = 0; i < 9 && n.parentElement; i++) {
      n = n.parentElement;
      const tt = (n.textContent || '').toLowerCase();
      if (tt.includes('distribute') && tt.includes('master')) {
        kill(n);
        return;
      }
    }
    hideBox(label, 80); // fallback
  });

  // 2) Artist Pro / upgrade / creator upsell banners (sidebar + inline).
  safe(() => {
    findByText(
      ['artist pro', 'go pro', 'upgrade now', 'fuel your growth',
       'creator benefits', 'get unlimited access', 'unlimited access with',
       'climb the leaderboard', 'complete the steps'],
      90
    ).forEach((el) => hideBox(el, 160));
  });

  // 3) Full-width promo/notification bars near the very top (incl. their X),
  //    and any empty leftover bar with just a close button.
  safe(() => {
    document.querySelectorAll('div,section,aside').forEach((el) => {
      if (el.id === 'sc-titlebar') return;
      const r = el.getBoundingClientRect();
      if (r.top > 150 || r.width < window.innerWidth * 0.5) return;
      if (r.height < 20 || r.height > 130) return;
      if (el.querySelector('input')) return; // never touch the search bar
      const hasClose = el.querySelector(
        'button[aria-label*="lose" i], [title*="lose" i], .g-icon-close, .close'
      );
      if (!hasClose) return;
      const txt = (el.textContent || '').replace(/\s/g, '').toLowerCase();
      const isPromo = /upgrade|artistpro|fuelyourgrowth|get\$|creatorbenefits|unlimited/.test(txt);
      if (isPromo) kill(el); // only clear promo bars, never blank ones
    });
  });

  // 5) Onboarding coachmark bubbles ("Tap the heart…", "OK, got it").
  safe(() => {
    const btn = Array.from(document.querySelectorAll('button, a')).find((b) => {
      const t = (b.textContent || '').trim().toLowerCase();
      return t === 'ok, got it' || t === 'got it' || t === 'ok got it';
    });
    if (btn) hideBox(btn, 160);
    findByText(['tap the heart', 'tap the button to'], 90).forEach((el) => hideBox(el, 160));
  });

  // 6) "Connect with artists in your scene" collaborator-promo module.
  safe(() => {
    const label = findByText(
      ['connect with artists in your scene', 'exchange feedback and find'], 60
    )[0];
    if (!label) return;
    let n = label;
    for (let i = 0; i < 7 && n.parentElement; i++) {
      n = n.parentElement;
      if (/module|section|lazyLoad|lazyLoadingList/i.test(n.className || '')) {
        kill(n);
        return;
      }
    }
    hideBox(label, 200);
  });

  // 4) Header promo links: "Get $15", "Artist Studio", "Go Pro".
  safe(() => {
    document
      .querySelectorAll('.header a, .header button, header a, header button, nav a')
      .forEach((a) => {
        const t = (a.textContent || '').trim().toLowerCase();
        if (t.startsWith('get $') || t === 'artist studio' || t === 'go pro' || t === 'try artist pro') {
          kill(a);
        }
      });
  });
  // Push SoundCloud's fixed top bar below our titlebar so nothing (e.g. the
  // Upload button) tucks under it. Detect ANY fixed, full-width, top-anchored
  // bar — not just .header — but never our own injected UI.
  safe(() => {
    document.querySelectorAll('header, nav, div').forEach((el) => {
      if (el.closest('#sc-titlebar, #sc-palette, #sc-ad-badge')) return;
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed') return;
      const r = el.getBoundingClientRect();
      if (r.top < TITLEBAR_H && r.width > window.innerWidth * 0.8 &&
          r.height > 30 && r.height < 90) {
        el.style.top = TITLEBAR_H + 'px';
      }
    });
  });
}

// ---------------------------------------------------------------------------
// 3D tilt: home tiles lean toward the cursor for a "3D site" feel.
// Event-delegated (tiles load lazily) + only on the home/discover pages.
// ---------------------------------------------------------------------------
function setupTilt() {
  const SEL = '.playableTile, .audibleTile, .homeShortcutsModule__item, .mixedSelectionModule__item';
  const MAX_Y = 20; // strong left/right lean (very visible, doesn't overflow the top)
  const MAX_X = 7;  // gentle up/down (kept small so tiles don't poke over the row above)
  const onHome = () => /^\/(discover|stream|home)?$/.test(location.pathname) || location.pathname === '/';
  let cur = null, px = 0, py = 0, raf = 0;
  const reset = (t) => { if (!t) return; t.style.transform = ''; t.style.transition = 'transform .35s ease'; t.classList.remove('hoq-tilt'); };
  // Write the transform at most once per frame. The old code set it synchronously
  // on every mousemove event (dozens/sec), thrashing layout+paint on the whole
  // tile subtree — that was the lag. rAF coalesces it to one write per frame.
  const apply = () => {
    raf = 0;
    if (!cur) return;
    cur.style.transform =
      'perspective(700px) rotateX(' + (-py * MAX_X).toFixed(2) + 'deg) rotateY(' +
      (px * MAX_Y).toFixed(2) + 'deg)';
  };

  document.addEventListener('mousemove', (e) => {
    if (!effectOn('tilt')) { if (cur) { reset(cur); cur = null; } return; }
    if (!onHome()) { if (cur) { reset(cur); cur = null; } return; }
    const tile = e.target.closest && e.target.closest(SEL);
    if (tile !== cur) {
      reset(cur);
      cur = tile;
      // Class + transition change only when the hovered tile changes, not every move.
      if (cur) { cur.classList.add('hoq-tilt'); cur.style.transition = 'transform .05s linear'; }
    }
    if (!cur) return;
    const r = cur.getBoundingClientRect();
    if (!r.width) return;
    px = (e.clientX - r.left) / r.width - 0.5;
    py = (e.clientY - r.top) / r.height - 0.5;
    if (!raf) raf = requestAnimationFrame(apply);
  }, { passive: true });

  document.addEventListener('mouseleave', () => {
    if (cur) { reset(cur); cur = null; }
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }, true);
}

// Track-page cover: follows the mouse in 3D. Only sets transform/transition — no
// position or z-index changes (those broke the layout last time).
function setupCoverTilt() {
  let art = null, px = 0, py = 0, raf = 0;
  const apply = () => {
    raf = 0;
    if (art) art.style.transform =
      'perspective(1000px) rotateY(' + (px * 17).toFixed(2) + 'deg) rotateX(' + (-py * 12).toFixed(2) + 'deg)';
  };
  document.addEventListener('mousemove', (e) => {
    if (!effectOn('tilt')) { if (art) { art.style.transition = 'transform .4s ease'; art.style.transform = ''; art = null; } return; }
    const a = e.target.closest && e.target.closest('.fullHero__artwork');
    if (a !== art) {
      if (art) { art.style.transition = 'transform .4s ease'; art.style.transform = ''; }
      art = a;
      if (art) art.style.transition = 'transform .1s ease';
    }
    if (!art) return;
    const r = art.getBoundingClientRect();
    px = (e.clientX - r.left) / r.width - 0.5;
    py = (e.clientY - r.top) / r.height - 0.5;
    if (!raf) raf = requestAnimationFrame(apply);
  }, { passive: true });
}

// Ambient mode: a big Spotify-style now-playing view. Reads the current track
// from the real player bar and mirrors it; controls call the real transport
// buttons so we never touch playback state directly. Toggled by a button we add
// into the player bar (and Esc to close).
function setupAmbientMode() {
  if (window.__hoqNp) return;
  window.__hoqNp = true;
  const big = (u) => u ? u.replace(/-t\d+x\d+\./, '-t500x500.') : '';
  const artUrl = () => {
    const el = document.querySelector('.playbackSoundBadge__avatar span.sc-artwork')
            || document.querySelector('.playControls .playbackSoundBadge__avatar span')
            || document.querySelector('.playControls .sc-artwork span');
    if (!el) return '';
    const bi = getComputedStyle(el).backgroundImage || '';
    const m = bi.match(/url\(["']?(.*?)["']?\)/);
    return m ? m[1] : '';
  };
  const txt = (sel, attr) => { const e = document.querySelector(sel); return e ? (attr ? (e.getAttribute(attr) || '') : e.textContent || '') : ''; };

  const np = document.createElement('div');
  np.id = 'hoq-np';
  np.innerHTML =
    '<canvas id="hoq-np-gl"></canvas>' +
    '<div class="np-bg"></div><div class="np-scrim"></div>' +
    '<button class="np-close" title="Close (Esc)">✕</button>' +
    '<div class="np-art"></div>' +
    '<div class="np-side"><div class="np-eyebrow">Now playing</div><h1 class="np-title"></h1><div class="np-artist"></div>' +
    '<div class="np-bar"><i></i></div><div class="np-times"><span class="np-cur">0:00</span><span class="np-dur">0:00</span></div>' +
    '<div class="np-ctrls">' +
      '<button class="np-prev" title="Previous"><svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg></button>' +
      '<button class="np-play" title="Play/Pause"></button>' +
      '<button class="np-next" title="Next"><svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/></svg></button>' +
      '<button class="np-like" title="Like"><svg viewBox="0 0 16 16" width="24" height="24" fill="currentColor"><path d="M7.978 5c.653-1.334 1.644-2 2.972-2 1.992 0 3.405 1.657 2.971 4-.289 1.561-2.27 3.895-5.943 7C4.19 10.895 2.21 8.561 2.035 7c-.26-2.343.947-4 2.972-4 1.35 0 2.34.666 2.971 2z"/></svg></button>' +
    '</div></div>';
  (document.body || document.documentElement).appendChild(np);

  let lastArt = '';
  const sync = () => {
    const u = big(artUrl());
    if (u && u !== lastArt) { lastArt = u; np.querySelector('.np-art').style.backgroundImage = 'url("' + u + '")'; np.querySelector('.np-bg').style.backgroundImage = 'url("' + u + '")'; }
    np.querySelector('.np-title').textContent = (txt('.playbackSoundBadge__titleLink', 'title') || txt('.playbackSoundBadge__titleLink')).trim();
    np.querySelector('.np-artist').textContent = (txt('.playbackSoundBadge__lightLink', 'title') || txt('.playbackSoundBadge__lightLink')).trim();
    np.querySelector('.np-bar i').style.width = (document.querySelector('.playbackTimeline__progressBar') || {}).style && document.querySelector('.playbackTimeline__progressBar').style.width || '0%';
    np.querySelector('.np-cur').textContent = txt('.playbackTimeline__timePassed span[aria-hidden]');
    np.querySelector('.np-dur').textContent = txt('.playbackTimeline__duration span[aria-hidden]');
    const playing = !!document.querySelector('.playControls__play.playing');
    np.querySelector('.np-play').innerHTML = playing
      ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    // reflect like state: accent + full opacity when the track is liked
    const liked = !!document.querySelector('.playbackSoundBadge__like.sc-button-selected');
    const lk = np.querySelector('.np-like');
    lk.style.color = liked ? 'var(--sc-accent, #ff5500)' : '#fff';
    lk.style.opacity = liked ? '1' : '.85';
    // match the real Like button's accent glow when liked
    lk.style.filter = liked ? 'drop-shadow(0 0 5px color-mix(in srgb, var(--sc-accent,#ff5500) 55%, transparent))' : 'none';
  };
  const click = (sel) => { const b = document.querySelector(sel); if (b) b.click(); setTimeout(sync, 120); };
  np.querySelector('.np-play').onclick = () => click('.playControls__play');
  np.querySelector('.np-prev').onclick = () => click('.skipControl__previous');
  np.querySelector('.np-next').onclick = () => click('.skipControl__next');
  np.querySelector('.np-like').onclick = () => click('.playbackSoundBadge__like');
  np.querySelector('.np-close').onclick = () => close();
  // click the empty backdrop (not the art/controls) to close
  np.querySelector('.np-scrim').onclick = () => close();
  np.querySelector('.np-bg').onclick = () => close();
  // seek: click the overlay bar → click the same fraction on the real timeline
  np.querySelector('.np-bar').onclick = (e) => {
    const wrap = document.querySelector('.playbackTimeline__progressWrapper');
    if (!wrap) return;
    const r = e.currentTarget.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const wr = wrap.getBoundingClientRect();
    wrap.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: wr.left + frac * wr.width, clientY: wr.top + wr.height / 2 }));
    wrap.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, clientX: wr.left + frac * wr.width, clientY: wr.top + wr.height / 2 }));
    setTimeout(sync, 150);
  };

  // Subtle 3D: the art tilts toward the cursor and the blurred background
  // parallaxes the other way for depth. rAF-throttled; honours the tilt effect.
  let tpx = 0, tpy = 0, traf = 0;
  const tiltApply = () => {
    traf = 0;
    const art = np.querySelector('.np-art'), bg = np.querySelector('.np-bg');
    if (art) art.style.transform = 'perspective(900px) rotateY(' + (tpx * 14).toFixed(1) + 'deg) rotateX(' + (-tpy * 10).toFixed(1) + 'deg)';
    if (bg) bg.style.transform = 'scale(1.15) translate(' + (-tpx * 2.4).toFixed(1) + '%,' + (-tpy * 2.4).toFixed(1) + '%)';
  };
  np.addEventListener('mousemove', (e) => {
    if (typeof effectOn === 'function' && !effectOn('tilt')) return;
    const r = np.getBoundingClientRect();
    tpx = (e.clientX - r.left) / r.width - 0.5;
    tpy = (e.clientY - r.top) / r.height - 0.5;
    if (!traf) traf = requestAnimationFrame(tiltApply);
  }, { passive: true });
  np.addEventListener('mouseleave', () => { const art = np.querySelector('.np-art'); if (art) art.style.transform = ''; });

  // --- WebGL 3D backdrop (Three.js, lazy-loaded on first open) -----------------
  // A flowing particle nebula in the track's accent colour: a soft cloud of
  // additive-blended points that breathe and drift, over a faint far starfield,
  // with the camera parallaxing to the cursor. If Three.js can't load, the
  // blurred-cover background stays and nothing breaks.
  let gl = null, glRaf = 0, glAccent = '', glBusy = false;
  const loadThree = () => new Promise((res) => {
    if (window.THREE) return res(true);
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
    s.onload = () => res(!!window.THREE); s.onerror = () => res(false);
    document.head.appendChild(s);
  });
  const accentColor = () => (getComputedStyle(document.documentElement).getPropertyValue('--sc-accent') || '#ff5500').trim() || '#ff5500';
  const recolorGL = () => {
    if (!gl) return; const acc = accentColor(); if (acc === glAccent) return; glAccent = acc;
    const T = gl.T; let col; try { col = new T.Color(acc); } catch (e) { return; }
    const hsl = {}; col.getHSL(hsl);
    gl.cloudMat.color = col.clone();
    gl.coreMat.color = new T.Color().setHSL(hsl.h, Math.min(1, hsl.s + 0.1), Math.min(0.85, hsl.l + 0.35));
    gl.starMat.color = new T.Color().setHSL(hsl.h, 0.4, 0.7);
  };
  const buildGL = () => {
    const T = window.THREE, cv = np.querySelector('#hoq-np-gl');
    const renderer = new T.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setSize(np.clientWidth, np.clientHeight);
    const scene = new T.Scene();
    const camera = new T.PerspectiveCamera(55, np.clientWidth / np.clientHeight, 0.1, 100); camera.position.z = 4.6;
    // soft round glowing dot texture so particles read as a nebula, not squares
    const dc = document.createElement('canvas'); dc.width = dc.height = 64;
    const dx = dc.getContext('2d'); const rg = dx.createRadialGradient(32, 32, 0, 32, 32, 32);
    rg.addColorStop(0, 'rgba(255,255,255,1)'); rg.addColorStop(0.35, 'rgba(255,255,255,0.55)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
    dx.fillStyle = rg; dx.fillRect(0, 0, 64, 64);
    const dot = new T.CanvasTexture(dc);
    // nebula: N particles in a soft flattened cloud; keep base positions to flow from
    const N = 3600, pos = new Float32Array(N * 3), base = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const r = Math.pow(Math.random(), 0.55) * 2.9;
      const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
      const x = r * Math.sin(ph) * Math.cos(th), y = r * Math.sin(ph) * Math.sin(th) * 0.62, z = r * Math.cos(ph);
      pos[i*3] = base[i*3] = x; pos[i*3+1] = base[i*3+1] = y; pos[i*3+2] = base[i*3+2] = z;
    }
    const cg = new T.BufferGeometry(); cg.setAttribute('position', new T.BufferAttribute(pos, 3));
    const cloudMat = new T.PointsMaterial({ size: 0.13, map: dot, transparent: true, opacity: 0.85, blending: T.AdditiveBlending, depthWrite: false });
    const cloud = new T.Points(cg, cloudMat); scene.add(cloud);
    // a small bright core for a glowing centre
    const coreMat = new T.PointsMaterial({ size: 0.3, map: dot, transparent: true, opacity: 0.8, blending: T.AdditiveBlending, depthWrite: false });
    const coreN = 300, cpos = new Float32Array(coreN * 3);
    for (let i = 0; i < coreN * 3; i++) cpos[i] = (Math.random() - 0.5) * 1.1;
    const coreG = new T.BufferGeometry(); coreG.setAttribute('position', new T.BufferAttribute(cpos, 3));
    const core = new T.Points(coreG, coreMat); scene.add(core);
    // faint far starfield for depth
    const sN = 600, spos = new Float32Array(sN * 3); for (let i = 0; i < sN * 3; i++) spos[i] = (Math.random() - 0.5) * 44;
    const sg = new T.BufferGeometry(); sg.setAttribute('position', new T.BufferAttribute(spos, 3));
    const starMat = new T.PointsMaterial({ size: 0.12, map: dot, transparent: true, opacity: 0.5, blending: T.AdditiveBlending, depthWrite: false });
    const stars = new T.Points(sg, starMat); scene.add(stars);
    gl = { renderer, scene, camera, cloud, cloudMat, core, coreMat, base, stars, starMat, clock: new T.Clock(), T };
    recolorGL();
    addEventListener('resize', () => { if (!gl) return; gl.camera.aspect = np.clientWidth / np.clientHeight; gl.camera.updateProjectionMatrix(); gl.renderer.setSize(np.clientWidth, np.clientHeight); });
  };
  const glFrame = () => {
    if (!gl) return; const t = gl.clock.getElapsedTime();
    // flow: displace each particle from its base along a smooth drifting field
    const p = gl.cloud.geometry.attributes.position.array, b = gl.base, n = b.length / 3;
    for (let i = 0; i < n; i++) {
      const bx = b[i*3], by = b[i*3+1], bz = b[i*3+2];
      p[i*3]   = bx + Math.sin(t * 0.5 + by * 1.5) * 0.16;
      p[i*3+1] = by + Math.cos(t * 0.4 + bx * 1.5) * 0.16;
      p[i*3+2] = bz + Math.sin(t * 0.45 + bx * 1.2 + by * 0.8) * 0.16;
    }
    gl.cloud.geometry.attributes.position.needsUpdate = true;
    gl.cloud.rotation.y = t * 0.05;
    gl.core.rotation.y = -t * 0.15;
    gl.core.scale.setScalar(1 + Math.sin(t * 1.4) * 0.12);
    gl.camera.position.x += (tpx * 0.9 - gl.camera.position.x) * 0.05;
    gl.camera.position.y += (-tpy * 0.9 - gl.camera.position.y) * 0.05;
    gl.camera.lookAt(0, 0, 0);
    gl.stars.rotation.y = t * 0.015;
    gl.renderer.render(gl.scene, gl.camera);
  };
  const ensureGL = async () => {
    if (gl || glBusy) return; glBusy = true;
    const ok = await loadThree();
    if (ok) { try {
      buildGL(); document.documentElement.classList.add('hoq-np-gl');
      const loop = () => { if (np.classList.contains('on') && !document.documentElement.classList.contains('hoq-no-anim')) glFrame(); glRaf = requestAnimationFrame(loop); };
      loop();
    } catch (e) {} }
    glBusy = false;
  };

  let iv = 0;
  const open = () => { sync(); np.classList.add('on'); document.documentElement.classList.add('hoq-np-open'); ensureGL(); if (!iv) iv = setInterval(() => { if (np.classList.contains('on')) { sync(); recolorGL(); } }, 500); };
  const close = () => { np.classList.remove('on'); document.documentElement.classList.remove('hoq-np-open'); };
  window.__hoqNpToggle = () => (np.classList.contains('on') ? close() : open());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && np.classList.contains('on')) close(); });

  // Add the trigger button into the player bar; re-add on the interval since the
  // badge re-renders per track.
  const addBtn = () => {
    const actions = document.querySelector('.playbackSoundBadge__actions');
    if (!actions || actions.querySelector('#hoq-ambient-btn')) return;
    const b = document.createElement('button');
    b.id = 'hoq-ambient-btn'; b.title = 'Ambient mode';
    b.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M4 4h7v2H6v5H4V4zm9 0h7v7h-2V6h-5V4zM6 13v5h5v2H4v-7h2zm12 0h2v7h-7v-2h5v-5z"/></svg>';
    b.onclick = () => window.__hoqNpToggle();
    actions.appendChild(b);
  };
  addBtn();
  setInterval(addBtn, 1200);
}

// Push the "FANS / leaderboard" module to the BOTTOM of the right sidebar (under
// Related Tracks / In Playlists / Reposts) so it's out of the way.

// ---------------------------------------------------------------------------
// Custom right-click menu (the native browser one is disabled in the host).
// Context-aware: link / image / selection actions + Back / Forward / Reload.
// ---------------------------------------------------------------------------
function hoqCopy(t) {
  try { navigator.clipboard.writeText(t); }
  catch (e) {
    const ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e2) {}
    ta.remove();
  }
}

// Inspect: show the clicked element's ancestor chain + each one's background /
// box-shadow / text-shadow (so we can find boxes fast), and log it to the host.
function hoqInspect(el) {
  if (!el) return;
  const lines = [];
  let n = el;
  for (let i = 0; i < 8 && n && n !== document.body; i++) {
    const cls = n.className ? '.' + String(n.className).trim().replace(/\s+/g, '.') : '';
    const cs = getComputedStyle(n);
    lines.push(n.tagName.toLowerCase() + cls +
      '\n    bg:' + cs.backgroundColor +
      ' | box:' + (cs.boxShadow === 'none' ? 'none' : cs.boxShadow.slice(0, 44)) +
      ' | txt-sh:' + (cs.textShadow === 'none' ? 'none' : cs.textShadow.slice(0, 44)));
    n = n.parentElement;
  }
  const text = lines.join('\n');
  scPost('DBG INSPECT:\n' + text);

  let p = document.getElementById('hoq-inspect');
  if (!p) {
    p = document.createElement('div');
    p.id = 'hoq-inspect';
    p.style.cssText = 'position:fixed;top:56px;right:18px;z-index:2147483600;max-width:540px;max-height:70vh;overflow:auto;' +
      'background:rgba(14,14,18,0.98);color:#e4e4e6;border:1px solid rgba(255,255,255,0.15);border-radius:12px;padding:14px;' +
      'font:11.5px/1.55 ui-monospace,Consolas,monospace;box-shadow:0 22px 66px rgba(0,0,0,0.65);white-space:pre-wrap;word-break:break-all;backdrop-filter:blur(20px);';
    document.body.appendChild(p);
  }
  p.textContent = '';
  const pre = document.createElement('div');
  pre.textContent = text;
  const row = document.createElement('div');
  row.style.cssText = 'margin-top:11px;display:flex;gap:8px;';
  const copy = document.createElement('button');
  copy.textContent = 'Copy';
  copy.style.cssText = 'padding:6px 14px;border:0;border-radius:7px;background:var(--sc-accent,#ff5500);color:#fff;font-weight:700;cursor:pointer;';
  copy.onclick = () => { hoqCopy(text); copy.textContent = 'Copied!'; };
  const close = document.createElement('button');
  close.textContent = 'Close';
  close.style.cssText = 'padding:6px 14px;border:0;border-radius:7px;background:rgba(255,255,255,0.1);color:#ccc;cursor:pointer;';
  close.onclick = () => p.remove();
  row.appendChild(copy); row.appendChild(close);
  p.appendChild(pre); p.appendChild(row);
}

function buildContextMenu() {
  if (document.getElementById('hoq-ctx')) return;
  const st = document.createElement('style');
  st.textContent = `
    #hoq-ctx { position: fixed; z-index: 2147483000; min-width: 158px; display: none;
      background: rgba(19,19,22,0.98); backdrop-filter: blur(22px) saturate(1.2);
      border: 1px solid rgba(255,255,255,0.09); border-radius: 10px; padding: 4px;
      box-shadow: 0 14px 40px rgba(0,0,0,0.6); font-family: Inter,-apple-system,Arial,sans-serif;
      user-select: none; -webkit-user-select: none; }
    #hoq-ctx.open { display: block; animation: hoqCtx .11s ease; }
    @keyframes hoqCtx { from { opacity: 0; transform: scale(.97); } to { opacity: 1; transform: none; } }
    #hoq-ctx .hoq-ci { display: flex; align-items: center; gap: 10px; padding: 6px 9px;
      border-radius: 7px; color: #d4d4d7; font-size: 12.5px; cursor: pointer; white-space: nowrap; }
    #hoq-ctx .hoq-ci:hover { background: var(--sc-accent,#ff5500); color: #fff; }
    #hoq-ctx .hoq-ci .ico { width: 14px; text-align: center; opacity: .82; font-size: 12px; }
    #hoq-ctx .hoq-sep { height: 1px; margin: 4px 6px; background: rgba(255,255,255,0.08); }
  `;
  (document.head || document.documentElement).appendChild(st);
  const menu = document.createElement('div');
  menu.id = 'hoq-ctx';
  document.body.appendChild(menu);

  const hide = () => menu.classList.remove('open');
  window.addEventListener('mousedown', (e) => { if (!menu.contains(e.target)) hide(); });
  window.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
  window.addEventListener('resize', hide);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });

  // Extracted from the listener so the SAME menu can be opened from inside the
  // webi iframe: contextmenu events raised in a child document never reach this
  // one, which is why right-click did nothing on the new track page.
  // `doc` is the document the target belongs to; the player controls it drives
  // always live in the top frame.
  window.__hoqOpenCtx = (t, clientX, clientY, doc) => {
    doc = doc || document;
    const view = doc.defaultView || window;
    // Right-clicking dead space can target the document itself, and
    // getComputedStyle() throws on a non-element — fall back to <body>.
    if (!t || t.nodeType !== 1) t = doc.body;
    if (!t) return;
    const link = t.closest && t.closest('a[href]');
    const sel = ((view.getSelection && String(view.getSelection())) || '').trim();
    const clickSel = (s) => { const el = document.querySelector(s); if (el) el.click(); };
    const pr = playerProgress();

    // App-relevant actions first: playback + like.
    const items = [
      { ico: '⏮', label: 'Previous', act: () => clickSel('.skipControl__previous') },
      { ico: pr.paused ? '▶' : '⏸', label: pr.paused ? 'Play' : 'Pause', act: () => clickSel('.playControls__play') },
      { ico: '⏭', label: 'Next', act: () => clickSel('.skipControl__next') },
      { ico: '♥', label: 'Like / Unlike', act: () => clickSel('.playbackSoundBadge__like, .playControls__like') },
    ];
    // Image under the cursor: a real <img>, or an element with a CSS background
    // image (SoundCloud draws artwork that way).
    let imgUrl = '';
    const imgEl = t.closest && t.closest('img[src]');
    if (imgEl) imgUrl = imgEl.src;
    else {
      let n = t;
      for (let i = 0; i < 4 && n; i++) {
        const m = (view.getComputedStyle(n).backgroundImage || '').match(/url\(["']?(https?:[^"')]+)["']?\)/);
        if (m) { imgUrl = m[1]; break; }
        n = n.parentElement;
      }
    }
    if (imgUrl) imgUrl = imgUrl.replace(/-t\d+x\d+\./, '-t500x500.'); // bump SC thumbs to a bigger size

    if (sel || link || imgUrl) {
      items.push({ sep: true });
      if (sel) items.push({ ico: '❝', label: 'Copy', act: () => hoqCopy(sel) });
      const qInfo = trackLinkInfo(link);
      if (qInfo) items.push({ ico: '▶', label: 'Play in Discord', act: () => queueTrack(qInfo) });
      if (link) items.push({ ico: '🔗', label: 'Copy link', act: () => hoqCopy(link.href) });
      if (imgUrl) items.push({ ico: '🖼', label: 'Save image', act: () => scPost('saveimg:' + imgUrl) });
    }
    items.push({ sep: true });
    items.push({ ico: '⟳', label: 'Reload', act: () => location.reload() });
    items.push({ ico: '🔍', label: 'Inspect element', act: () => scPost('opendevtools') });

    menu.innerHTML = items.map((it, i) => it.sep
      ? '<div class="hoq-sep"></div>'
      : '<div class="hoq-ci" data-i="' + i + '"><span class="ico">' + it.ico + '</span><span>' + it.label + '</span></div>').join('');
    menu.querySelectorAll('.hoq-ci').forEach((el) => {
      const it = items[+el.dataset.i];
      el.addEventListener('click', (ev) => { ev.stopPropagation(); hide(); try { it.act(); } catch (er) {} });
    });

    menu.style.left = '-9999px'; menu.style.top = '0';
    menu.classList.add('open');
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let x = clientX, y = clientY;
    if (x + mw > window.innerWidth - 8) x = window.innerWidth - mw - 8;
    if (y + mh > window.innerHeight - 8) y = window.innerHeight - mh - 8;
    menu.style.left = Math.max(8, x) + 'px';
    menu.style.top = Math.max(8, y) + 'px';
  };

  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.__hoqOpenCtx(e.target, e.clientX, e.clientY, document);
  });
}

// Right-click inside the webi iframe: reuse the top frame's menu, shifting the
// coordinates by the iframe's position so it lands under the cursor.
function attachFrameContextMenu(d, frameEl) {
  if (d.__hoqCtx) return;
  d.__hoqCtx = true;
  d.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (typeof window.__hoqOpenCtx !== 'function') return;
    const r = frameEl.getBoundingClientRect();
    window.__hoqOpenCtx(e.target, e.clientX + r.left, e.clientY + r.top, d);
  });
}

// TEMP (4 min): as the user browses, log the class chains of every popover /
// modal / dropdown / notable section so we can style them precisely afterward.
function DBGwalk() {
  const seen = new Set();
  const post = (tag, s) => { const m = 'DBG ' + tag + ': ' + s; if (s && !seen.has(m)) { seen.add(m); scPost(m); } };
  const sig = (el, depth) => {
    let n = el, chain = [];
    for (let i = 0; i < (depth || 5) && n && n !== document.body; i++) {
      const c = (n.className || '').toString().trim().replace(/\s+/g, '.').slice(0, 150);
      chain.push(n.tagName.toLowerCase() + (c ? '.' + c : ''));
      n = n.parentElement;
    }
    return chain.join(' > ');
  };
  const OVERLAY = '[role="dialog"],[role="listbox"],[role="menu"],[role="tooltip"],'
    + '.modal,[class*="modal" i],[class*="dialog" i],[class*="popover" i],'
    + '[class*="dropdown" i],[class*="shareSheet" i],[class*="share" i],[class*="select__" i]';
  const TEXT = ['Climb the leaderboard', 'Fans who have played', 'FANS', 'Top', 'Share', 'Related tracks'];
  const scan = () => {
    try {
      // one-off state + hero/fans element capture
      post('STATE', 'html=' + document.documentElement.className.slice(0, 50) +
        ' | body=' + getComputedStyle(document.body).backgroundColor +
        ' | scbg=' + (document.getElementById('sc-bg') ? getComputedStyle(document.getElementById('sc-bg')).display : 'na'));
      document.querySelectorAll('.fullHero,.fullHero__background,.listenArtworkWall,.listenHero,.l-listen,[class*="artworkWall" i]').forEach((el) => {
        const cs = getComputedStyle(el);
        post('HERO2', (el.className || el.tagName).toString().slice(0, 70) + ' :: img=' + cs.backgroundImage.slice(0, 45) + ' col=' + cs.backgroundColor);
      });
      // the big square cover on the right of the hero — capture its class for tilt
      document.querySelectorAll('.fullListenHero *, .fullHero *').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 180 && r.width < 520 && Math.abs(r.width - r.height) < 55 && r.top < 430)
          post('ART', (el.className || el.tagName).toString().slice(0, 90));
      });
      const fansH = Array.from(document.querySelectorAll('h1,h2,h3,h4,span,div')).find((e) => /^FANS\b/.test((e.textContent || '').trim()) && (e.textContent || '').trim().length < 12 && e.offsetParent);
      if (fansH) {
        post('FANSSEC', sig(fansH, 7));
        let n = fansH;
        for (let i = 0; i < 6 && n; i++) { const cs = getComputedStyle(n); if (cs.backgroundColor && !/rgba\(0, 0, 0, 0\)/.test(cs.backgroundColor)) post('FANSBG', (n.className || n.tagName).toString().slice(0, 70) + ' col=' + cs.backgroundColor); n = n.parentElement; }
      }
      document.querySelectorAll(OVERLAY).forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 60 || r.height < 24) return;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') return;
        post('OVL', sig(el));
      });
      TEXT.forEach((t) => {
        const el = Array.from(document.querySelectorAll('h1,h2,h3,h4,span,div,a,button'))
          .find((e) => (e.textContent || '').trim().toLowerCase().startsWith(t.toLowerCase()) && e.offsetParent);
        if (el) post('TXT[' + t + ']', sig(el, 6));
      });
      // Big BACKGROUND FILLS anywhere in the content (the reddish hero) — skip
      // gradient-text elements (background-clip:text) which aren't real fills.
      document.querySelectorAll('.l-listen-wrapper div, .l-listen-wrapper section, .l-listen-wrapper header, .l-listen-wrapper aside').forEach((el) => {
        const cs = getComputedStyle(el);
        if ((cs.backgroundClip || cs.webkitBackgroundClip) === 'text') return;
        const hasImg = cs.backgroundImage && cs.backgroundImage !== 'none';
        const hasCol = cs.backgroundColor && !/rgba\(0, 0, 0, 0\)/.test(cs.backgroundColor);
        if (!hasImg && !hasCol) return;
        const r = el.getBoundingClientRect();
        if (r.width < window.innerWidth * 0.35 || r.height < 110) return;
        post('FILL', (el.className || el.tagName).toString().slice(0, 85) +
          ' :: img=' + cs.backgroundImage.slice(0, 38) + ' col=' + cs.backgroundColor);
      });
    } catch (e) {}
  };
  const iv = setInterval(scan, 900);
  setTimeout(() => { clearInterval(iv); scPost('DBG PROBE DONE'); }, 4 * 60 * 1000);
}

// Move the "Fans" embedded iframe to the BOTTOM of the .listenNetworkSidebar
// (below Related Tracks / In Playlists / Likes / Reposts).
function moveFans() {
  const sidebar = document.querySelector('.listenNetworkSidebar');
  if (sidebar) {
    const embed = sidebar.querySelector('.sidebarModule__webiEmbeddedModule');
    if (embed) {
      let node = embed;
      while (node.parentElement && node.parentElement !== sidebar) node = node.parentElement;
      if (node.parentElement === sidebar && sidebar.lastElementChild !== node) sidebar.appendChild(node);
    }
  }
  styleFansIframe();
}

// The Fans widget lives in a same-origin <iframe>, so reach into its document
// and make the MUI cards/paper transparent (can't be done from the top-frame CSS).
function styleFansIframe() {
  document.querySelectorAll('iframe.webiEmbeddedModuleIframe, iframe[src*="right-hand-rail"]').forEach((f) => {
    try {
      const doc = f.contentDocument;
      if (!doc || doc.getElementById('hoq-fans-style')) return;
      const s = doc.createElement('style');
      s.id = 'hoq-fans-style';
      s.textContent =
        'html,body{background:transparent!important;background-color:transparent!important}' +
        '.MuiPaper-root,.MuiCard-root{background:transparent!important;background-color:transparent!important;box-shadow:none!important}' +
        '.MuiCard-root{border:1px solid rgba(255,255,255,0.12)!important}';
      (doc.head || doc.documentElement).appendChild(s);
    } catch (e) {}
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function boot() {
  // Inject theming + apply the accent in EVERY frame. SoundCloud's Artist Studio /
  // Insights are a separate "webi" (Next.js/MUI) app that renders in an iframe, so
  // top-frame-only injection left those pages un-themed. CSS is cheap + its selectors
  // simply don't match in unrelated frames, so this is safe. localStorage is shared
  // for same-origin frames, so the saved accent carries over.
  try { injectBaseCSS(); } catch (e) {}
  try { applyAccent(readAccent()); } catch (e) {}
  // The titlebar, interactions, panels and context menu are top-frame ONLY.
  if (window.top !== window) return;
  buildTitlebar();
  setupResize();
  applyCoverBgState(); // create #sc-bg + apply saved cover-background state
  ensureAdBadge(); // the page-world __scAdKiller toggles this
  buildContextMenu();   // custom right-click menu (native one is off)
  setupTilt();          // 3D tilt on home tiles
  setupWaveInteract();  // waveform bars rise toward the cursor
  setupCoverTilt();     // track cover follows the mouse in 3D
  setupAmbientMode();   // big now-playing view (button in the player bar)
  removeClutter();
  // Debounced + on a gentle interval instead of firing on every mutation — a
  // constant stream of DOM writes looks like bot activity to SoundCloud.
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    // Lazily mounted tiles land with SoundCloud's orange still on them, and at
    // the gentle cadence that stayed visible for ~2s on a cold start. React fast
    // while the page is settling, then back off to the slow cadence.
    setTimeout(() => {
      pending = false;
      removeClutter();
    }, performance.now() < 5000 ? 150 : 800);
  };
  const obs = new MutationObserver(schedule);
  obs.observe(document.body, { childList: true, subtree: true });
  // Cold load shows a burst of SoundCloud orange (follow buttons, badges) before
  // the first debounced pass lands. These few extra early passes close that window
  // without turning into the sustained write stream the debounce exists to avoid.
  [120, 350, 700, 1400, 2500].forEach((ms) => {
    setTimeout(() => { try { removeClutter(); } catch (e) {} }, ms);
  });
  // Watch the now-playing cover for the "Match song cover" theme mode.
  setInterval(matchTick, 1500);
  // Keep the webi V2 track-page iframe themed: it mounts late and re-navigates
  // on every track, so a one-shot push at boot would miss it.
  themeFrames();
  setInterval(() => { try { themeFrames(); } catch (e) {} }, 1000);
  // Same cadence for the top frame's own rows (feed, search, library, legacy pages).
  addQueueButtons(document);
  setInterval(() => { try { addQueueButtons(document); } catch (e) {} }, 1200);
  setInterval(() => { try { tuneNowPlayingMarquee(); } catch (e) {} }, 1500);
  setInterval(() => { try { hoqStatsTick(); } catch (e) {} }, 4000);
  // The player bar appears/disappears with playback, so keep the tab's bottom
  // edge honest while it's open.
  setInterval(() => {
    try { if (document.documentElement.classList.contains('hoq-tab')) hoqTabMetrics(); } catch (e) {}
  }, 1000);
  setInterval(() => { try { buildCustomWave(); } catch (e) {} }, 600); // our waveform + playhead
  applyVizState();  // apply saved "song visualizer bar" on/off before it draws
  // Ambient-glow layer (opt-in effect): one fixed div the CSS lights up when
  // html.hoq-ambient is set. Created once; the accent it uses is the live var.
  if (!document.getElementById('hoq-ambient')) {
    const amb = document.createElement('div'); amb.id = 'hoq-ambient';
    (document.body || document.documentElement).appendChild(amb);
  }
  applyFxClasses(); // apply saved CSS-gated optional effects
  startPlayerViz(); // bottom-player seek bar → flowing bouncy accent visualizer
  startOverlayScrollbar(); // custom floating accent scrollbar (no side gutter)
  startShareButton(); // "Share to Discord" → posts the current track to the webhook
  startPlayButton(); // "Play in Discord" → asks the bot to queue it
  mountDiscordActions();
  setInterval(() => { try { mountDiscordActions(); } catch (e) {} }, 1000);
  // Discord Rich Presence + live activity-card updates.
  setInterval(() => { try { rpcTick(); updateDiscordActivity(); } catch (e) {} }, 3000);
}

// ---------------------------------------------------------------------------
// Custom OVERLAY scrollbar — floats over the content on the right (no reserved
// gutter), invisible until you scroll or move to the edge, accent-gradient,
// draggable. Native bars are hidden in CSS. Handles the main window scroll.
// ---------------------------------------------------------------------------
function startOverlayScrollbar() {
  if (window.__hoqSB) return; window.__hoqSB = true;
  const bar = document.createElement('div'); bar.id = 'hoq-scroll';
  const thumb = document.createElement('div'); thumb.id = 'hoq-scroll-thumb';
  bar.appendChild(thumb);
  const se = () => document.scrollingElement || document.documentElement;
  const host = () => document.body || document.documentElement;
  host().appendChild(bar);

  let hideTO = 0, dragging = false, startY = 0, startScroll = 0;
  const geom = () => {
    const s = se(), vh = window.innerHeight, sh = s.scrollHeight;
    const trackH = bar.clientHeight || (vh - 52); // actual track height (matches CSS offsets)
    const th = Math.max(30, trackH * vh / sh), maxTop = Math.max(0, trackH - th);
    return { s, vh, sh, trackH, th, maxTop, scrollable: sh > vh + 4 };
  };
  function layout() {
    if (!bar.isConnected) host().appendChild(bar);
    const g = geom();
    if (!g.scrollable) { bar.classList.remove('show'); thumb.style.height = '0'; return; }
    thumb.style.height = g.th + 'px';
    thumb.style.transform = 'translateY(' + (g.maxTop * (g.s.scrollTop / (g.sh - g.vh))) + 'px)';
  }
  const hide = () => { if (!dragging && !bar.matches(':hover')) bar.classList.remove('show'); };
  function reveal() { if (!geom().scrollable) return; bar.classList.add('show'); clearTimeout(hideTO); hideTO = setTimeout(hide, 1200); }

  window.addEventListener('scroll', () => { layout(); reveal(); }, { passive: true, capture: true });
  window.addEventListener('resize', layout);
  new MutationObserver(layout).observe(document.documentElement, { childList: true, subtree: true });
  thumb.addEventListener('mousedown', (e) => { dragging = true; startY = e.clientY; startScroll = se().scrollTop; document.body.style.userSelect = 'none'; bar.classList.add('show'); e.preventDefault(); });
  window.addEventListener('mousemove', (e) => {
    if (dragging) {
      const g = geom(); if (g.maxTop <= 0) return;
      se().scrollTop = startScroll + (e.clientY - startY) * ((g.sh - g.vh) / g.maxTop);
      return;
    }
    if (window.innerWidth - e.clientX < 24) reveal();
  });
  window.addEventListener('mouseup', () => { if (dragging) { dragging = false; document.body.style.userSelect = ''; clearTimeout(hideTO); hideTO = setTimeout(hide, 1200); } });

  layout();
  setInterval(layout, 500); // cheap catch for content-height / route changes
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
