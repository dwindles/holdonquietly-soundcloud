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
const BASE_CSS = `
  /* Merged bar: the SoundCloud header IS the top bar (our window controls overlay
     its right side), so no separate titlebar strip to reserve room for. */
  html { padding-top: 0 !important; box-sizing: border-box !important; }

  /* Ambient blurred song-cover background (toggle in palette) */
  #sc-bg {
    position: fixed; inset: -80px; z-index: -2; display: none;
    background-size: cover; background-position: center;
    filter: blur(100px) saturate(1.5) brightness(0.5); transform: scale(1.25);
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
    background:
      radial-gradient(135% 95% at 50% 32%, rgba(10,10,12,0) 34%, rgba(10,10,12,0.55) 100%),
      linear-gradient(180deg, rgba(10,10,12,0.3), rgba(10,10,12,0.6));
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
    backdrop-filter: blur(26px) saturate(1.4) !important;
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
    background: url("https://holdonquietly.app/logo.png") center/contain no-repeat !important;
    filter: drop-shadow(0 0 4px rgba(90,160,255,0.3)) !important;
  }

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
    backdrop-filter: blur(42px) saturate(1.4) !important;
    -webkit-backdrop-filter: blur(42px) saturate(1.4) !important;
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
    backdrop-filter: blur(46px) saturate(1.5) !important;
    -webkit-backdrop-filter: blur(46px) saturate(1.5) !important;
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
  .collectionNav.g-tabs .active a, .collectionNav.g-tabs a.active,
  .collectionNav.g-tabs li.active a, .collectionNav.g-tabs [aria-current] a,
  .collectionNav.g-tabs a[aria-current] {
    background: color-mix(in srgb, var(--sc-accent, #ff5500) 24%, transparent) !important;
    color: var(--sc-accent, #ff5500) !important; font-weight: 800 !important;
    border: 1px solid color-mix(in srgb, var(--sc-accent, #ff5500) 45%, transparent) !important;
    box-shadow: inset 3px 0 0 var(--sc-accent, #ff5500),
                0 0 16px color-mix(in srgb, var(--sc-accent, #ff5500) 42%, transparent) !important;
    text-shadow: 0 0 10px color-mix(in srgb, var(--sc-accent, #ff5500) 60%, transparent) !important;
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
    backdrop-filter: blur(46px) saturate(1.5) !important; -webkit-backdrop-filter: blur(46px) saturate(1.5) !important;
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
    backdrop-filter: blur(42px) saturate(1.5) !important; -webkit-backdrop-filter: blur(42px) saturate(1.5) !important;
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
    backdrop-filter: blur(46px) saturate(1.5) !important;
    -webkit-backdrop-filter: blur(46px) saturate(1.5) !important;
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
    backdrop-filter: blur(46px) saturate(1.5) !important;
    -webkit-backdrop-filter: blur(46px) saturate(1.5) !important;
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
    backdrop-filter: blur(48px) saturate(1.45) !important;
    -webkit-backdrop-filter: blur(48px) saturate(1.45) !important;
  }
  /* dim + blur the page behind the modal */
  .modal__background, .modalBackground, .g-modal-overlay, .modal__overlay {
    background: rgba(0,0,0,0.5) !important;
    backdrop-filter: blur(5px) !important; -webkit-backdrop-filter: blur(5px) !important;
  }
`;

function injectBaseCSS() {
  if (document.getElementById('sc-desktop-style')) return;
  const style = document.createElement('style');
  style.id = 'sc-desktop-style';
  style.textContent = BASE_CSS;
  (document.head || document.documentElement).appendChild(style);
}

// ---------------------------------------------------------------------------
// Accent (color / gradient) — persisted in localStorage
// ---------------------------------------------------------------------------
const DEFAULT_ACCENT = { c1: '#ff5500', c2: '#ff8800', grad: false };

// Elements already repainted (so we don't re-scan them every tick).
const _seenOrange = new WeakSet();
// Is a computed color SoundCloud-orange? (matches #ff5500/#ff3300/#ff7700-ish,
// but not the red close button or ambers/yellows.)
function isOrange(str) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(str || '');
  if (!m) return false;
  const r = +m[1], g = +m[2], b = +m[3];
  return r >= 235 && g >= 30 && g <= 140 && b <= 30;
}
// Repaint any orange badge/dot/text to the current accent.
function recolorOrange() {
  const els = document.querySelectorAll('*');
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    if (_seenOrange.has(el) || el.id === 'sc-titlebar' || el.closest('#sc-titlebar, #sc-palette')) {
      continue;
    }
    _seenOrange.add(el);
    const cs = getComputedStyle(el);
    if (isOrange(cs.backgroundColor)) {
      el.style.setProperty('background-color', 'var(--sc-accent, #ff5500)', 'important');
    }
    if (isOrange(cs.color)) {
      el.style.setProperty('color', 'var(--sc-accent, #ff5500)', 'important');
    }
    if (isOrange(cs.borderTopColor)) {
      el.style.setProperty('border-color', 'var(--sc-accent, #ff5500)', 'important');
    }
  }
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
  if (!dontSave) localStorage.setItem('scAccent', JSON.stringify(a));
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
const HOQ_OPTIN_FX = ['gray'];
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
        if (avg.n) { const c = { r: avg.r / avg.n, g: avg.g / avg.n, b: avg.b / avg.n }; cb({ c1: _toHex(c), c2: _toHex(c) }); }
        else cb(null);
        return;
      }
      cb({ c1: _toHex(arr[0]), c2: _toHex(arr[1] || arr[0]) });
    } catch (e) { cb(null); } // CORS-tainted canvas
  };
  img.onerror = () => cb(null);
  img.src = url;
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
  setWaveHue(c1); // waveform always tracks the cover
  if (localStorage.getItem('scMatchCover') === '1') {
    applyAccent({ c1: c1, c2: c2, grad: true }, true);
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
  const url = currentCoverUrl();
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
      setWaveHue(cols.c1);
      if (matchOn) applyAccent({ c1: cols.c1, c2: cols.c2, grad: true }, true);
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
      #sc-titlebar .sc-tb-palette:hover { color: var(--sc-accent, #ff5500); }
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
        backdrop-filter: blur(46px) saturate(1.5); -webkit-backdrop-filter: blur(46px) saturate(1.5);
        border: 1px solid rgba(255,255,255,0.10); border-radius: 16px;
        padding: 14px; width: 470px; display: none;
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
      #sc-palette h4 {
        margin: 2px 0 12px; font-size: 10.5px; font-weight: 700; color: #fff;
        letter-spacing: 1.3px; text-transform: uppercase; display: flex; align-items: center; gap: 7px;
      }
      #sc-palette h4::before {
        content: ''; width: 7px; height: 7px; border-radius: 50%;
        background: var(--sc-accent, #ff5500); box-shadow: 0 0 8px var(--sc-accent, #ff5500);
      }
      #sc-palette .row {
        display: flex; align-items: center; justify-content: space-between;
        margin: 4px 0; padding: 5px 9px; background: rgba(255,255,255,0.035);
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
        width: 100%; box-sizing: border-box; margin: 2px 0 8px; padding: 8px 10px;
        border-radius: 8px; border: 1px solid rgba(255,255,255,0.1);
        background: rgba(255,255,255,0.05); color: #e4e4e6; font-size: 12px; outline: none;
      }
      #sc-palette .bgurl:focus { border-color: var(--sc-accent, #ff5500); }
      #sc-palette button.bgpick, #sc-palette button.bgclear {
        width: 100%; margin-top: 6px; padding: 8px; border-radius: 8px; cursor: pointer;
        font-size: 12px; font-weight: 600; border: 1px solid rgba(255,255,255,0.09);
        background: rgba(255,255,255,0.06); color: #ccc; transition: all .12s ease;
      }
      #sc-palette button.bgpick:hover { background: rgba(255,255,255,0.12); color: #fff; }
      #sc-palette button.bgclear { background: rgba(255,90,90,0.08); color: #ff9a9a; border-color: rgba(255,90,90,0.25); }
      #sc-palette button.bgclear:hover { background: rgba(255,90,90,0.18); color: #fff; }
      #sc-palette button.reset, #sc-palette button.fixblock {
        width: 100%; margin-top: 10px; padding: 9px; border-radius: 9px; cursor: pointer;
        font-size: 12px; font-weight: 600; transition: all .12s ease;
      }
      #sc-palette button.reset { background: rgba(255,255,255,0.06); color: #ccc; border: 1px solid rgba(255,255,255,0.09); }
      #sc-palette button.reset:hover { background: rgba(255,255,255,0.11); color: #fff; }
      #sc-palette button.fixblock {
        margin-top: 8px; background: rgba(255,120,40,0.1); color: #ffb37a; border: 1px solid rgba(255,120,40,0.28);
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
        color: #7a7a7c; margin: 13px 2px 7px; font-weight: 700;
      }
      #sc-palette .section-label:first-of-type { margin-top: 4px; }
    </style>
    <div class="sc-tb-brand">holdonquietly</div>
    <div class="sc-tb-spacer"></div>
    <button class="sc-tb-btn sc-tb-skipad" title="Kill current ad (mute + fast-forward)">
      <svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 4v16"/><path d="M6.029 4.285A2 2 0 0 0 3 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z"/></svg></button>
    <button class="sc-tb-btn sc-tb-palette" title="Theme color">
      <svg class="lucide sc-tb-accentdot" viewBox="0 0 24 24" fill="none" stroke="var(--sc-accent, #ff5500)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/></svg></button>
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
    <h4>Theme color</h4>
    <div class="pal-grid">
      <label class="row"><span>Match cover</span><input type="checkbox" id="sc-match"></label>
      <label class="row"><span>Blurred bg</span><input type="checkbox" id="sc-coverbg"></label>
    </div>
    <div class="section-label">Effects</div>
    <div class="pal-grid">
      <label class="row"><span>Visualizer</span><input type="checkbox" id="sc-fx-viz"></label>
      <label class="row"><span>3D tilt</span><input type="checkbox" id="sc-fx-tilt"></label>
      <label class="row"><span>Interactive wave</span><input type="checkbox" id="sc-fx-wave"></label>
      <label class="row"><span>Accent glow</span><input type="checkbox" id="sc-fx-glow"></label>
      <label class="row"><span>Speaker pulse</span><input type="checkbox" id="sc-fx-pulse"></label>
      <label class="row"><span>Rounded</span><input type="checkbox" id="sc-fx-round"></label>
      <label class="row"><span>Row hover</span><input type="checkbox" id="sc-fx-hover"></label>
      <label class="row"><span>Frosted bars</span><input type="checkbox" id="sc-fx-frost"></label>
      <label class="row"><span>Animations</span><input type="checkbox" id="sc-fx-anim"></label>
      <label class="row"><span>Grayscale</span><input type="checkbox" id="sc-fx-gray"></label>
    </div>
    <div class="section-label">Theme</div>
    <div class="row"><span>Song list zoom</span><span class="zoomctl">
      <button class="zmb" data-z="-1">&minus;</button><b id="sc-zoomval">100%</b><button class="zmb" data-z="1">+</button>
    </span></div>
    <div class="pal-grid">
      <div class="row"><span>Primary</span><input type="color" id="sc-c1"></div>
      <div class="row"><span>Gradient</span><span class="gradctl">
        <input type="color" id="sc-c2"><input type="checkbox" id="sc-grad"></span></div>
    </div>
    <div class="section-label">Background</div>
    <input type="text" id="sc-bgurl" class="bgurl" placeholder="Paste image / GIF URL…">
    <button class="bgpick">Choose image / GIF</button>
    <button class="bgclear">Clear background</button>
    <div class="section-label" style="margin-top:14px">Reset</div>
    <button class="reset">Reset to SoundCloud orange</button>
    <button class="fixblock" title="Clears cookies / Cloudflare block state and reloads">Fix &quot;blocked&quot; / clear data</button>
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
  bar.querySelector('.sc-tb-palette').addEventListener('click', (e) => {
    e.stopPropagation();
    panel.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target) && !e.target.closest('.sc-tb-palette')) {
      panel.classList.remove('open');
    }
  });

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
   ['gray', 'sc-fx-gray']].forEach(([name, id]) => {
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
  tab.textContent = 'hoq';
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
      #hoq-discord { position: fixed; top: 50px; left: 0; right: 0; bottom: 0;
        z-index: 2147482000; display: none; background: rgba(8,8,10,0.72);
        backdrop-filter: blur(34px) saturate(1.3); padding: 44px 24px; overflow-y: auto;
        font-family: Inter, -apple-system, Arial, sans-serif; }
      #hoq-discord.open { display: block; animation: hoqIn .18s ease; }
      @keyframes hoqIn { from { opacity: 0; } to { opacity: 1; } }
      #hoq-discord .hoq-dc-card { max-width: 540px; margin: 0 auto;
        background: linear-gradient(180deg,#1b1b1f,#141417); border: 1px solid rgba(255,255,255,0.08);
        border-radius: 18px; padding: 22px; box-shadow: 0 24px 64px rgba(0,0,0,0.6); }
      #hoq-discord .hoq-dc-top { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; }
      #hoq-discord .hoq-dc-logo { width: 30px; height: 30px; object-fit: contain;
        filter: drop-shadow(0 0 5px rgba(90,160,255,0.4)); }
      #hoq-discord .hoq-dc-top span { font-weight: 800; font-size: 18px; color: #fff; flex: 1; }
      #hoq-discord .hoq-dc-x { background: rgba(255,255,255,0.06); border: 0; color: #ccc;
        width: 30px; height: 30px; border-radius: 8px; cursor: pointer; font-size: 14px; }
      #hoq-discord .hoq-dc-x:hover { background: #e81123; color: #fff; }
      #hoq-discord .hoq-dc-sec { margin-bottom: 18px; }
      #hoq-discord .hoq-dc-label { font-size: 11px; text-transform: uppercase; letter-spacing: 1.2px;
        color: #8a8a8c; font-weight: 700; margin-bottom: 9px; }
      #hoq-discord .hoq-dc-presence { display: flex; gap: 14px; align-items: center;
        background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06);
        border-radius: 12px; padding: 14px; }
      #hoq-discord .hoq-dc-cover { width: 62px; height: 62px; border-radius: 10px; object-fit: cover;
        box-shadow: 0 2px 8px rgba(0,0,0,0.4); }
      #hoq-discord .hoq-dc-ptext { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
      #hoq-discord .hoq-dc-ptext b { color: var(--sc-accent,#ff5500); font-size: 12px; }
      #hoq-discord .hoq-dc-title { color: #fff; font-weight: 700; font-size: 15px; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis; }
      #hoq-discord .hoq-dc-artist { color: #b7b7ba; font-size: 13px; }
      #hoq-discord .hoq-dc-hint { color: #7a7a7c; font-size: 12px; margin-top: 8px; }
      #hoq-discord .hoq-dc-name, #hoq-discord .hoq-dc-sc { width: 100%; box-sizing: border-box; padding: 10px 12px;
        border-radius: 9px; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.05);
        color: #e4e4e6; font-size: 13px; outline: none; }
      #hoq-discord .hoq-dc-name:focus, #hoq-discord .hoq-dc-sc:focus { border-color: var(--sc-accent,#ff5500); }
      #hoq-discord .hoq-dc-friends { min-height: 20px; display: flex; flex-direction: column; gap: 6px; }
      #hoq-discord .hoq-dc-friend { display: flex; gap: 12px; align-items: center; padding: 8px;
        border-radius: 10px; background: rgba(255,255,255,0.035); border: 1px solid rgba(255,255,255,0.05); }
      #hoq-discord .hoq-dc-fcover { width: 42px; height: 42px; border-radius: 8px; object-fit: cover; flex: none; }
      #hoq-discord .hoq-dc-ftext { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      #hoq-discord .hoq-dc-ftext b { color: #fff; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #hoq-discord .hoq-dc-ftext span { color: #b7b7ba; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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
        background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06);
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
        border-radius: 10px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06); }
      #hoq-discord .hoq-acct-row b { flex: 1; color: #e4e4e6; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #hoq-discord .hoq-acct-sw { border: 0; border-radius: 7px; padding: 6px 12px; cursor: pointer;
        background: var(--sc-accent-bg,#5865F2); color: #fff; font-weight: 700; font-size: 12px; }
      #hoq-discord .hoq-acct-sw:hover { filter: brightness(1.1); }
      #hoq-discord .hoq-acct-rm { border: 0; background: transparent; color: #8a8a8c; cursor: pointer; font-size: 15px; }
      #hoq-discord .hoq-acct-rm:hover { color: #e81123; }
      #hoq-discord .hoq-acct-add { display: flex; gap: 8px; }
      #hoq-discord .hoq-acct-name { flex: 1; box-sizing: border-box; padding: 9px 12px; border-radius: 9px;
        border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.05); color: #e4e4e6; font-size: 13px; outline: none; }
      #hoq-discord .hoq-acct-name:focus { border-color: var(--sc-accent,#ff5500); }
      #hoq-discord .hoq-acct-save, #hoq-discord .hoq-acct-new { border: 0; border-radius: 9px; padding: 9px 14px;
        cursor: pointer; font-weight: 700; font-size: 12px; }
      #hoq-discord .hoq-acct-save { background: var(--sc-accent,#ff5500); color: #fff; }
      #hoq-discord .hoq-acct-new { width: 100%; margin-top: 8px; background: rgba(255,255,255,0.08); color: #e4e4e6;
        border: 1px solid rgba(255,255,255,0.12); }
      #hoq-discord .hoq-acct-new:hover { background: rgba(255,255,255,0.14); }
    </style>
    <div class="hoq-dc-card">
      <div class="hoq-dc-top"><img class="hoq-dc-logo" src="https://holdonquietly.app/logo.png"><span>hoq</span><button class="hoq-dc-x">&#10005;</button></div>
      <div class="hoq-dc-sec">
        <div class="hoq-dc-label">Your listening activity</div>
        <div class="hoq-dc-presence">
          <img class="hoq-dc-cover" src="https://holdonquietly.app/logo.png">
          <div class="hoq-dc-ptext">
            <b>Listening to holdonquietly</b>
            <span class="hoq-dc-title">Nothing playing</span>
            <span class="hoq-dc-artist"></span>
          </div>
        </div>
        <div class="hoq-dc-hint">This is what your friends will see on Discord.</div>
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
        <div class="hoq-dc-hint">Switch between SoundCloud accounts without logging out. Save your current session, then add another.</div>
      </div>
      <div class="hoq-dc-sec">
        <div class="hoq-dc-label">Your info</div>
        <input class="hoq-dc-sc" placeholder="SoundCloud profile link  (e.g. soundcloud.com/you)">
        <input class="hoq-dc-name" placeholder="Discord name" style="margin-top:8px">
      </div>
      <div class="hoq-dc-sec">
        <div class="hoq-dc-label">Friends listening</div>
        <div class="hoq-dc-friends"></div>
      </div>
      <div class="hoq-dc-sec">
        <div class="hoq-dc-label">Server</div>
        <div class="hoq-dc-embed" style="display:none">
          <img class="hoq-dc-eicon" src="https://holdonquietly.app/logo.png">
          <div class="hoq-dc-etext">
            <div class="hoq-dc-ename">holdonquietly</div>
            <div class="hoq-dc-eonline"><span class="hoq-dc-dot"></span><span class="hoq-dc-count">—</span></div>
          </div>
        </div>
        <button class="hoq-dc-open">Open Discord server</button>
      </div>
    </div>`;
  document.body.appendChild(p);
  p.querySelector('.hoq-dc-x').addEventListener('click', () => p.classList.remove('open'));
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

function updateDiscordActivity() {
  const p = document.getElementById('hoq-discord');
  if (!p || !p.classList.contains('open')) return;
  const np = currentNowPlaying();
  p.querySelector('.hoq-dc-title').textContent = np.title || 'Nothing playing';
  p.querySelector('.hoq-dc-artist').textContent = np.artist || '';
  const cov = p.querySelector('.hoq-dc-cover');
  cov.src = np.cover || 'https://holdonquietly.app/logo.png';
}

function closeDiscord() {
  const p = document.getElementById('hoq-discord');
  if (p) p.classList.remove('open');
  const tab = document.querySelector('.hoq-dc-tab');
  if (tab) tab.classList.remove('sc-selected', 'hoq-active');
}

function toggleDiscord() {
  const p = ensureDiscordPanel();
  const opening = !p.classList.contains('open');
  p.classList.toggle('open', opening);
  const tab = document.querySelector('.hoq-dc-tab');
  if (tab) tab.classList.toggle('hoq-active', opening);
  if (opening) {
    // Close the panel + clear active state as soon as you click any other nav tab.
    document.querySelectorAll('.header__navMenuItem:not(.hoq-dc-tab)').forEach((a) =>
      a.addEventListener('click', closeDiscord, { once: true }));
    scPost('dcwidget');       // refresh the server embed
    scPost('lastfm:status');  // refresh Last.fm state
    scPost('acct:list');      // refresh saved accounts
  }
  updateDiscordActivity();
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
  const paused = !btn || /^play/i.test(title) || btn.classList.contains('sc-ico-play');
  return { pos: parseT('.playbackTimeline__timePassed'), dur: parseT('.playbackTimeline__duration'), paused };
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

function hoqEsc(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }

// The C# host delivers everyone's presence here → render the friends feed.
window.__hoqFriends = function (list) {
  const el = document.querySelector('.hoq-dc-friends');
  if (!el) return;
  const me = myId();
  const others = (Array.isArray(list) ? list : []).filter((f) => f.id !== me && f.title);
  if (!others.length) { el.innerHTML = '<div class="hoq-dc-hint">No friends listening right now.</div>'; return; }
  el.innerHTML = others.map((f) => '<div class="hoq-dc-friend">' +
    '<img class="hoq-dc-fcover" src="' + (hoqEsc(f.cover) || 'https://holdonquietly.app/logo.png') + '">' +
    '<div class="hoq-dc-ftext"><b>' + hoqEsc(f.name || 'Someone') + '</b>' +
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
    '.l-listen-wrapper, .l-about, .l-user, .userInfoBar, [class*="profileHead" i]';
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
  let cur = null;
  const reset = (t) => { if (!t) return; t.style.transform = ''; t.style.transition = 'transform .35s ease'; t.classList.remove('hoq-tilt'); };

  document.addEventListener('mousemove', (e) => {
    if (!effectOn('tilt')) { if (cur) { reset(cur); cur = null; } return; }
    if (!onHome()) { if (cur) { reset(cur); cur = null; } return; }
    const tile = e.target.closest && e.target.closest(SEL);
    if (tile !== cur) { reset(cur); cur = tile; }
    if (!tile) return;
    const r = tile.getBoundingClientRect();
    if (!r.width) return;
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    tile.classList.add('hoq-tilt');
    tile.style.transition = 'transform .05s linear';
    tile.style.transform =
      'perspective(700px) rotateX(' + (-py * MAX_X).toFixed(2) + 'deg) rotateY(' +
      (px * MAX_Y).toFixed(2) + 'deg)';
  }, { passive: true });

  document.addEventListener('mouseleave', () => { if (cur) { reset(cur); cur = null; } }, true);
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

  document.addEventListener('contextmenu', (e) => {
    // Let our own inputs (Discord/Last.fm fields) use a normal caret menu-less right-click.
    e.preventDefault();
    const t = e.target;
    const link = t.closest && t.closest('a[href]');
    const sel = ((window.getSelection && String(window.getSelection())) || '').trim();
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
        const m = (getComputedStyle(n).backgroundImage || '').match(/url\(["']?(https?:[^"')]+)["']?\)/);
        if (m) { imgUrl = m[1]; break; }
        n = n.parentElement;
      }
    }
    if (imgUrl) imgUrl = imgUrl.replace(/-t\d+x\d+\./, '-t500x500.'); // bump SC thumbs to a bigger size

    if (sel || link || imgUrl) {
      items.push({ sep: true });
      if (sel) items.push({ ico: '❝', label: 'Copy', act: () => hoqCopy(sel) });
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
    let x = e.clientX, y = e.clientY;
    if (x + mw > window.innerWidth - 8) x = window.innerWidth - mw - 8;
    if (y + mh > window.innerHeight - 8) y = window.innerHeight - mh - 8;
    menu.style.left = Math.max(8, x) + 'px';
    menu.style.top = Math.max(8, y) + 'px';
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
  // Only run in the top frame — SoundCloud has iframes we don't want a titlebar in.
  if (window.top !== window) return;
  injectBaseCSS();
  applyAccent(readAccent());
  buildTitlebar();
  setupResize();
  applyCoverBgState(); // create #sc-bg + apply saved cover-background state
  ensureAdBadge(); // the page-world __scAdKiller toggles this
  buildContextMenu();   // custom right-click menu (native one is off)
  setupTilt();          // 3D tilt on home tiles
  setupWaveInteract();  // waveform bars rise toward the cursor
  setupCoverTilt();     // track cover follows the mouse in 3D
  removeClutter();
  // Debounced + on a gentle interval instead of firing on every mutation — a
  // constant stream of DOM writes looks like bot activity to SoundCloud.
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      removeClutter();
    }, 800);
  };
  const obs = new MutationObserver(schedule);
  obs.observe(document.body, { childList: true, subtree: true });
  // Watch the now-playing cover for the "Match song cover" theme mode.
  setInterval(matchTick, 1500);
  setInterval(() => { try { buildCustomWave(); } catch (e) {} }, 600); // our waveform + playhead
  applyVizState();  // apply saved "song visualizer bar" on/off before it draws
  applyFxClasses(); // apply saved CSS-gated optional effects
  startPlayerViz(); // bottom-player seek bar → flowing bouncy accent visualizer
  startOverlayScrollbar(); // custom floating accent scrollbar (no side gutter)
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
