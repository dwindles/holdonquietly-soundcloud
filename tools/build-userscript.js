/* Build a mobile userscript from preload.js.
 *
 * WHY A BUILD STEP: preload.js is ~5,000 lines and still moving. Forking it for
 * mobile would rot within a week, so the userscript is GENERATED — every desktop
 * change flows here for free. Only the host bridge and a small shim differ.
 *
 * WHY TWO WORLDS: GM_xmlhttpRequest is the only reason we can reach the Discord
 * webhook and the artwork CDN at all (SoundCloud's CSP blocks both from the
 * page). But asking for a GM_* grant puts the script in the manager's sandbox,
 * and the ad-killer needs the page's real media engine. So the GM calls stay in
 * the sandbox, the payload is injected into the page, and window.postMessage
 * bridges them.
 *
 * usage: node tools/build-userscript.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// preload.js is CRLF (and mixed in places). Normalise so the transforms below
// are line-ending agnostic; the userscript itself is written LF.
const CRLF = String.fromCharCode(13, 10);
const LF = String.fromCharCode(10);
const src = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8').split(CRLF).join(LF);

/* ---- 1. Re-point the host bridge at the sandbox ------------------------- */
const OLD_POST = [
  'function scPost(cmd) {',
  '  try { window.chrome.webview.postMessage(cmd); } catch (e) {}',
  '}',
].join('\n');

if (!src.includes(OLD_POST)) {
  console.error('FAIL: scPost() no longer matches preload.js.');
  console.error('The host bridge moved — update OLD_POST here rather than shipping a stale build.');
  process.exit(1);
}

const NEW_POST = [
  'function scPost(cmd) {',
  '  // No C# host on mobile. Window/native commands are dropped by the sandbox;',
  '  // the rest are relayed to it, since it owns the GM_* APIs.',
  '  try { window.postMessage({ __hoq: 1, cmd: String(cmd) }, location.origin); } catch (e) {}',
  '}',
].join('\n');

let payload = src.replace(OLD_POST, NEW_POST);

/* ---- Mobile stylesheet (injected by the shim) --------------------------- */
const MOBILE_CSS = "/* holdonquietly — mobile layout.\n   SoundCloud only ships a desktop DOM here: we force a desktop UA upstream,\n   because otherwise it 307s phones to m.soundcloud.com, which the theme does\n   not target. Scaling that 1280px canvas to fit put it at ~29% on a phone —\n   present but unreadable. So reflow it properly.\n   Every selector below was measured against the live DOM, not guessed. */\n@media (max-width: 820px) {\n  html.hoq-mobile, html.hoq-mobile body {\n    overflow-x: hidden !important;\n    /* WebKit inflates text on wide-layout pages — nav came out ~1.7x. */\n    -webkit-text-size-adjust: 100% !important;\n    text-size-adjust: 100% !important;\n  }\n\n  /* Fixed-width containers -> fluid. These are the 1240px culprits. */\n  html.hoq-mobile .l-container,\n  html.hoq-mobile .header__inner,\n  html.hoq-mobile .l-content,\n  html.hoq-mobile .l-inner-fullwidth {\n    max-width: 100% !important; width: 100% !important;\n    padding-left: 12px !important; padding-right: 12px !important;\n    box-sizing: border-box !important;\n  }\n\n  /* Two columns -> one. The 360px right rail is pure noise on a phone. */\n  html.hoq-mobile .l-fluid-fixed { display: block !important; }\n  html.hoq-mobile .l-main {\n    width: 100% !important; float: none !important; margin: 0 !important;\n    box-sizing: border-box !important;\n  }\n  html.hoq-mobile .l-sidebar-right,\n  html.hoq-mobile .l-fluid-fixed > aside { display: none !important; }\n\n  /* The header is ~195px fixed — half the screen, and it covered the page\n     heading. Let it scroll away; a phone has no room for a persistent bar. */\n  html.hoq-mobile .header { position: static !important; height: auto !important; }\n  html.hoq-mobile body { padding-top: 0 !important; }\n  html.hoq-mobile .l-content, html.hoq-mobile #content {\n    padding-top: 0 !important; margin-top: 0 !important;\n  }\n  html.hoq-mobile .header__inner {\n    flex-wrap: wrap !important; height: auto !important; align-items: center !important;\n    padding-top: 4px !important; padding-bottom: 4px !important;\n    gap: 6px !important; row-gap: 4px !important;\n  }\n  html.hoq-mobile .header__left { flex: 1 1 100% !important; flex-wrap: wrap !important; display: flex !important; align-items: center !important; }\n  html.hoq-mobile .header__logo { flex: 0 0 auto !important; max-width: 44vw !important; overflow: hidden !important; }\n  html.hoq-mobile .header__right { flex: 0 0 auto !important; gap: 4px !important; }\n  html.hoq-mobile .header__right .sc-button,\n  html.hoq-mobile .header__right a { font-size: 12px !important; padding: 4px 10px !important; height: auto !important; }\n\n  /* Nav must never wrap — a half row of tabs reads as broken. Scroll it. */\n  html.hoq-mobile .header__navWrapper {\n    flex: 1 1 100% !important; order: 5 !important;\n    overflow-x: auto !important; overflow-y: hidden !important;\n    -webkit-overflow-scrolling: touch !important; scrollbar-width: none !important;\n  }\n  html.hoq-mobile .header__navWrapper::-webkit-scrollbar { display: none !important; }\n  html.hoq-mobile .header__navMenu {\n    display: flex !important; flex-wrap: nowrap !important;\n    white-space: nowrap !important; width: max-content !important;\n  }\n  html.hoq-mobile .header__navMenu > li { flex: 0 0 auto !important; margin-right: 0 !important; }\n  /* Zeroing the item padding also killed SoundCloud's own margin, so labels\n     ran together as 'CollectionSocial/Settings'. Flex gap rather than a\n     margin: the injected Social/Settings <li> is a clone of Library's and\n     did not pick the margin up, leaving that one pair still touching. */\n  html.hoq-mobile .header__navMenu { gap: 18px !important; }\n  html.hoq-mobile .header__navMenuItem { padding: 6px 0 !important; margin-right: 0 !important; }\n\n  html.hoq-mobile .header__middle { order: 10 !important; flex: 1 1 100% !important; }\n  /* The form carries margin-left: 24px / right: 16px from the desktop layout,\n     which pushed it 12px past the right edge of a 390px viewport. */\n  html.hoq-mobile .headerSearch {\n    width: 100% !important; height: 32px !important;\n    margin: 0 !important; box-sizing: border-box !important;\n  }\n  html.hoq-mobile .header__search { width: 100% !important; }\n  html.hoq-mobile .headerSearch__input { font-size: 13px !important; height: 30px !important; }\n  /* No room, and all desktop-shaped. */\n  html.hoq-mobile .header__soundInput,\n  html.hoq-mobile .uploadButton,\n  html.hoq-mobile .header__forArtistsButton,\n  html.hoq-mobile .header__moreButton { display: none !important; }\n  /* A full-width promo block is a lot of nothing on a phone. */\n  html.hoq-mobile .l-product-banners, html.hoq-mobile .banner { display: none !important; }\n\n  /* Tiles: 159px is a desktop size. Two per row reads properly at 390px. */\n  html.hoq-mobile .tileGallery, html.hoq-mobile [class*='tileGallery'] { width: 100% !important; }\n  html.hoq-mobile .tileGallery__sliderPanel {\n    display: flex !important; gap: 10px !important;\n    overflow-x: auto !important; -webkit-overflow-scrolling: touch !important;\n  }\n  html.hoq-mobile .tileGallery__sliderPanelSlide { flex: 0 0 auto !important; width: auto !important; }\n  html.hoq-mobile .playableTile { width: 44vw !important; min-width: 44vw !important; margin-right: 0 !important; }\n  html.hoq-mobile .playableTile__artworkWrapper,\n  html.hoq-mobile .playableTile__artwork,\n  html.hoq-mobile .playableTile__image { width: 44vw !important; height: 44vw !important; }\n  /* Overlay arrows sit on the artwork and are too small to hit; swipe works. */\n  html.hoq-mobile .tileGallery__sliderButton,\n  html.hoq-mobile .tileGallery__sliderPeek { display: none !important; }\n\n  /* Type that survives the reflow. */\n  html.hoq-mobile .playableTile__heading, html.hoq-mobile .sc-text-h4 { font-size: 13px !important; }\n  html.hoq-mobile h1 { font-size: 20px !important; }\n  html.hoq-mobile .l-content h2, html.hoq-mobile .sectionHead__title { font-size: 17px !important; }\n\n  /* Player bar: keep transport + title, drop what a thumb cannot use anyway. */\n  html.hoq-mobile .playControls { height: 56px !important; }\n  html.hoq-mobile .playControls__inner { padding: 0 8px !important; }\n  html.hoq-mobile .playControls__elements { width: 100% !important; }\n  html.hoq-mobile .volume,\n  html.hoq-mobile .playControls__shuffle,\n  html.hoq-mobile .playControls__repeat,\n  html.hoq-mobile .playbackSoundBadge__follow { display: none !important; }\n  html.hoq-mobile .playbackTimeline { flex: 1 1 auto !important; min-width: 0 !important; }\n  html.hoq-mobile .playbackSoundBadge__titleContextContainer { min-width: 0 !important; }\n\n  /* Our own surfaces, also built for a wide window. */\n  html.hoq-mobile #hoq-discord .hoq-dc-body { display: block !important; }\n  html.hoq-mobile #hoq-discord .hoq-dc-sec { width: 100% !important; }\n  html.hoq-mobile #sc-palette .pal-grid { grid-template-columns: 1fr !important; }\n  html.hoq-mobile #sc-palette > .row,\n  html.hoq-mobile #sc-palette > .bgurl,\n  html.hoq-mobile #sc-palette > .btn-2up { max-width: 100% !important; }\n  /* ---- list + search rows ------------------------------------------------\n     A 160px artwork beside a 182px column squeezed titles to one character\n     per line and made rows 596px tall. Shrink the art, give the text the\n     rest, and drop the waveform and comment box, which are unusable here. */\n  html.hoq-mobile .sound__body,\n  html.hoq-mobile .userItem.sc-media { display: flex !important; align-items: flex-start !important; }\n  html.hoq-mobile .sound__artwork,\n  html.hoq-mobile .userItem__coverArt {\n    flex: 0 0 92px !important; width: 92px !important; height: 92px !important;\n    margin-right: 10px !important;\n  }\n  html.hoq-mobile .sound__coverArt,\n  html.hoq-mobile .userItem__coverArt .image,\n  html.hoq-mobile .userItem__coverArt .sc-artwork { width: 92px !important; height: 92px !important; }\n  html.hoq-mobile .sound__content,\n  html.hoq-mobile .userItem .sc-media-content {\n    flex: 1 1 auto !important; width: auto !important; min-width: 0 !important;\n  }\n  html.hoq-mobile .sound__header { min-width: 0 !important; }\n  html.hoq-mobile .soundTitle__title,\n  html.hoq-mobile .soundTitle__usernameText,\n  html.hoq-mobile .userItem__title {\n    white-space: normal !important; word-break: normal !important; overflow-wrap: anywhere !important;\n  }\n  html.hoq-mobile .sound__waveform, html.hoq-mobile .commentForm { display: none !important; }\n\n  /* The play button is an inline 40px block before the title; at this width it\n     crowds the text, and the accent glow makes it read as an overlay. */\n  html.hoq-mobile .soundTitle__titleContainer {\n    display: flex !important; align-items: flex-start !important; gap: 8px !important;\n  }\n  html.hoq-mobile .soundTitle__playButton { flex: 0 0 30px !important; margin: 0 !important; }\n  html.hoq-mobile .soundTitle__playButton .sc-button-play,\n  html.hoq-mobile .soundTitle__playButton > * { width: 30px !important; height: 30px !important; }\n  html.hoq-mobile .soundTitle__usernameTitleContainer,\n  html.hoq-mobile .soundTitle__additionalContainer { flex: 1 1 auto !important; min-width: 0 !important; }\n  html.hoq-mobile .sound__header .sc-button-play { box-shadow: none !important; filter: none !important; }\n  html.hoq-mobile .sound__header .sc-text-secondary,\n  html.hoq-mobile .soundTitle__uploadTime { float: none !important; display: block !important; font-size: 11px !important; }\n\n  /* Search filter tabs were stacking on top of each other. */\n  html.hoq-mobile .searchOptions__tabs,\n  html.hoq-mobile [class*='searchOptions'] ul {\n    display: flex !important; flex-wrap: nowrap !important; overflow-x: auto !important;\n    gap: 14px !important; position: static !important;\n  }\n  html.hoq-mobile [class*='searchOptions'] li { position: static !important; flex: 0 0 auto !important; }\n  /* ---- track page hero ---------------------------------------------------\n     Desktop floats a 320px artwork right and lets the title fill the rest. At\n     390px the foreground came out 606px wide, the artwork sat at x=282 off\n     screen, and the title collapsed to ZERO width -- printing the track name\n     one character per line down the page. Stack it instead. */\n  html.hoq-mobile .l-listen-hero,\n  html.hoq-mobile .fullListenHero,\n  html.hoq-mobile .fullHero { height: auto !important; }\n  html.hoq-mobile .fullHero__foreground {\n    display: flex !important; flex-direction: column !important; align-items: stretch !important;\n    width: 100% !important; max-width: 100% !important; position: static !important;\n    padding: 12px 12px 4px !important; box-sizing: border-box !important;\n  }\n  html.hoq-mobile .fullHero__artwork {\n    position: static !important; order: -1 !important; float: none !important;\n    width: 100% !important; max-width: 260px !important; height: auto !important;\n    margin: 0 auto 14px !important;\n  }\n  html.hoq-mobile .listenArtworkWrapper,\n  html.hoq-mobile .fullHero__artwork .image,\n  html.hoq-mobile .fullHero__artwork .sc-artwork {\n    width: 100% !important; max-width: 260px !important; height: auto !important; aspect-ratio: 1 !important;\n  }\n  html.hoq-mobile .fullHero__title {\n    width: 100% !important; min-width: 0 !important; height: auto !important;\n    position: static !important; float: none !important;\n  }\n  html.hoq-mobile .fullHero__title .soundTitle,\n  html.hoq-mobile .fullHero__title .soundTitle__titleContainer { width: 100% !important; min-width: 0 !important; }\n  html.hoq-mobile .fullHero__title .soundTitle__title {\n    white-space: normal !important; overflow-wrap: anywhere !important; font-size: 19px !important;\n  }\n  html.hoq-mobile .fullHero__info,\n  html.hoq-mobile .fullHero__playerArea,\n  html.hoq-mobile .fullHero__waveform {\n    width: 100% !important; position: static !important; float: none !important;\n  }\n  html.hoq-mobile .fullHero__info { text-align: left !important; margin-top: 6px !important; }\n  html.hoq-mobile .fullHero__uploadTime { display: inline-block !important; margin-right: 8px !important; }\n  html.hoq-mobile .fullHero__playerArea { margin-top: 10px !important; min-height: 0 !important; }\n  html.hoq-mobile .fullHero__waveform { height: 64px !important; min-height: 0 !important; }\n  html.hoq-mobile .backgroundGradient { width: 100% !important; }\n  html.hoq-mobile .l-listen-hero { margin-bottom: 8px !important; }\n  html.hoq-mobile .listenEngagement__actions,\n  html.hoq-mobile .soundActions { flex-wrap: wrap !important; gap: 8px !important; }\n  /* ---- Collection / Library ----------------------------------------------\n     Built from the logged-in DOM. Tiles are already handled; this fixes the\n     page furniture around them at 390px. */\n  /* The tab bar (Recently played / Likes / Playlists / …) is a wide g-tabs row\n     that overflowed. Let it scroll sideways. */\n  html.hoq-mobile .collectionNav,\n  html.hoq-mobile .collectionNav.g-tabs {\n    display: flex !important; flex-wrap: nowrap !important;\n    overflow-x: auto !important; -webkit-overflow-scrolling: touch !important;\n    scrollbar-width: none !important;\n  }\n  html.hoq-mobile .collectionNav::-webkit-scrollbar { display: none !important; }\n  html.hoq-mobile .collectionNav > li { flex: 0 0 auto !important; }\n\n  /* Each section header packs a heading + spacer + Clear-all button + a filter\n     input into one row (g-flex-row-centered-spread). At 390px that overflows,\n     so wrap it and let the filter take its own line. */\n  html.hoq-mobile .playHistory__top,\n  html.hoq-mobile .collectionSection__header {\n    flex-wrap: wrap !important; gap: 6px 10px !important;\n  }\n  html.hoq-mobile .collectionSection__flexFill { display: none !important; }\n  html.hoq-mobile .collectionSection__filters { flex: 1 1 100% !important; }\n  html.hoq-mobile .collectionSection__filterText,\n  html.hoq-mobile .collectionSection__filters .textfield { width: 100% !important; }\n  html.hoq-mobile .collectionSection__subHeading,\n  html.hoq-mobile .playHistory__subHeading { font-size: 17px !important; }\n\n  /* The one-row horizontal scrollers (badgeList / lazyLoadingList). */\n  html.hoq-mobile .collection__oneRowSection .badgeList,\n  html.hoq-mobile .collection .lazyLoadingList__list {\n    overflow-x: auto !important; -webkit-overflow-scrolling: touch !important;\n    flex-wrap: nowrap !important;\n  }\n  html.hoq-mobile .collection { padding: 0 !important; }\n  html.hoq-mobile .collection__section { margin-bottom: 18px !important; }\n}\n\n/* Logged-out mode. The proxy cannot complete a sign-in (SoundCloud's bot\n   protection challenges it), so every account control is a dead end: tapping\n   Like or Follow opens a sign-in modal that cannot succeed. Hiding them is a\n   better experience than leaving traps. Applied only when actually signed out,\n   so this all comes back if a session is ever present. */\nhtml.hoq-anon .header__userNav,\nhtml.hoq-anon .header__soundInput,\nhtml.hoq-anon .uploadButton,\nhtml.hoq-anon .header__forArtistsButton,\nhtml.hoq-anon .header__upsellWrapper,\nhtml.hoq-anon .header__moreButton { display: none !important; }\n\n/* Sign in / Create account sit together in .header__loginMenu. Matching the\n   container is exact; matching the buttons is not, since they carry only\n   generic sc-button classes shared with controls we want to keep. */\nhtml.hoq-anon .header__loginMenu,\nhtml.hoq-anon .loginButton,\nhtml.hoq-anon .signupButton { display: none !important; }\n\n/* The auth modal and whatever backdrop carries it. */\nhtml.hoq-anon div:has(> iframe[src*='web-auth']),\nhtml.hoq-anon div:has(> iframe[src*='one-tap']),\nhtml.hoq-anon .modal, html.hoq-anon .modal__modal,\nhtml.hoq-anon [class*='authModal' i],\nhtml.hoq-anon .g-modal-overlay { display: none !important; }\nhtml.hoq-anon body { overflow: auto !important; }\n\n/* Actions that need an account. Leaving them visible means a tap that opens a\n   modal we have just hidden — nothing happens, which reads as broken. */\nhtml.hoq-anon .sc-button-like,\nhtml.hoq-anon .sc-button-follow,\nhtml.hoq-anon .sc-button-repost,\nhtml.hoq-anon .playableTile__actionButton,\nhtml.hoq-anon .playbackSoundBadge__follow,\nhtml.hoq-anon .playbackSoundBadge__like { display: none !important; }\n\n/* Promos and upsells: all of them lead to signup. */\nhtml.hoq-anon .l-product-banners,\nhtml.hoq-anon .banner,\nhtml.hoq-anon [class*='upsell' i],\nhtml.hoq-anon [class*='Upsell' i] { display: none !important; }\n\n/* With the account row gone the header is two compact rows, so give the\n   search its full width. */\nhtml.hoq-anon.hoq-mobile .header__middle { flex: 1 1 100% !important; }\nhtml.hoq-anon.hoq-mobile .headerSearch { width: 100% !important; }\n\n/* Stream and Collection are account-only: signed out they redirect straight to\n   a sign-in wall. Leaving them in the nav is a tab that always dead-ends. */\nhtml.hoq-anon .header__navMenuItem[data-menu-name='stream'],\nhtml.hoq-anon .header__navMenuItem[data-menu-name='library'] { display: none !important; }\nhtml.hoq-anon .header__navMenu > li:has(> [data-menu-name='stream']),\nhtml.hoq-anon .header__navMenu > li:has(> [data-menu-name='library']) { display: none !important; }";

/* ---- 2. Page-side shim, appended after preload ------------------------- */
const SHIM = [
  '',
  '/* =========================== mobile shim ============================ */',
  '(() => {',
  '  const H = document.documentElement;',
  "  H.classList.add('hoq-mobile');",
  '',
  '  // The titlebar only exists because the desktop window is frameless. On a',
  '  // phone it is a dead 34px strip with non-functional window buttons.',
  "  const css = document.createElement('style');",
  '  css.textContent =',
  "    '#sc-titlebar{display:none!important}' +",
  "    'html.hoq-mobile .header{top:0!important}' +",
  "    'html.hoq-mobile .header .header__inner{padding-right:12px!important}' +",
  "    'html.hoq-mobile .sc-tb-btn{display:none!important}';",
  '  (document.head || H).appendChild(css);',
  '',
  '  // Mobile layout, against the containers SoundCloud actually uses:',
  '  //   .l-container / .header__inner   fixed 1240px',
  '  //   .l-fluid-fixed                  .l-main 880 + .l-sidebar-right 360',
  '  //   .tileGallery                    horizontal carousels of 159px tiles',
  "  const mob = document.createElement('style');",
  "  mob.id = 'hoq-mobile-css';",
  '  mob.textContent = ' + JSON.stringify(MOBILE_CSS) + ';',
  '  (document.head || H).appendChild(mob);',
  '',
  '  // Keep the desktop layout legible instead of letting the browser scale it',
  '  // down. You still need the browser\'s "Request Desktop Website" — a',
  '  // userscript cannot change the UA of a request that already happened.',
  "  let vCalls = 0;",
  "  const setViewport = () => {",
  "    // Circuit breaker. A runaway viewport loop blocks the main thread and the",
  "    // page never finishes loading -- it took the whole site down once. No",
  "    // legitimate reason to write this more than a handful of times.",
  "    if (++vCalls > 60) return;",
  '    let m = document.querySelector(\'meta[name="viewport"]\');',
  "    if (!m) { m = document.createElement('meta'); m.name = 'viewport'; (document.head || H).appendChild(m); }",
  "    const want = 'width=device-width, initial-scale=1, viewport-fit=cover';",
  "    // Only write when it actually differs. The observer below watches head",
  "    // attributes, so an unconditional setAttribute retriggers it forever and",
  "    // the page never finishes loading.",
  "    if (m.getAttribute('content') !== want) m.setAttribute('content', want);",
  '  };',
  '  setViewport();',
  "  window.addEventListener('orientationchange', () => setTimeout(setViewport, 150));",
  "",
  "  // Keep asserting it. The whole mobile layout hangs off a media query, so if",
  "  // anything rewrites this meta the page snaps back to the 1280px desktop",
  "  // canvas and every rule silently stops matching.",
  "  try {",
  "    new MutationObserver(setViewport).observe(document.head || H, { childList: true });",
  "  } catch (e) {}",
  "  let vTicks = 0;",
  "  const vTimer = setInterval(() => { setViewport(); if (++vTicks > 20) clearInterval(vTimer); }, 500);",
  '',
  '  // Touch has no hover, so these cost frame time and give nothing back.',
  '  try {',
  "    if (matchMedia('(hover: none)').matches) {",
  "      ['scFxTilt', 'scFxWave', 'scFxPulse'].forEach((k) => localStorage.setItem(k, '0'));",
  '    }',
  '  } catch (e) {}',
  '',
  '  // Features with no mobile equivalent. Hiding them beats showing a control',
  '  // that silently does nothing.',
  "  const DEAD = ['accounts', 'last.fm scrobbling'];",
  '  let ticks = 0;',
  '  const prune = () => {',
  "    document.querySelectorAll('#hoq-discord .hoq-dc-sec').forEach((sec) => {",
  "      const l = sec.querySelector('.hoq-dc-label');",
  "      if (l && DEAD.indexOf(l.textContent.trim().toLowerCase()) !== -1) sec.style.display = 'none';",
  '    });',
  '    if (++ticks < 20) setTimeout(prune, 700);',
  '  };',
  '  prune();',
  "",
  "  // Signed out? Then hide the account controls (see hoq-anon in the CSS).",
  "  // Detected from the DOM rather than a cookie, because the proxy forwards",
  "  // SoundCloud's own cookies and an anonymous session still sets several.",
  "  const anonTick = () => {",
  "    const signedIn = !!document.querySelector(\".header__userNavUsernameButton, .header__userNav a[href^='/you']\");",
  "    const signInBtn = [...document.querySelectorAll(\".header__right a, .header__right button\")]",
  "      .some((b) => /sign in|create account/i.test(b.textContent || \"\"));",
  "    if (!signedIn && signInBtn) H.classList.add(\"hoq-anon\");",
  "    else if (signedIn) H.classList.remove(\"hoq-anon\");",
  "    // The auth iframe is injected on demand; drop its container outright so a",
  "    // hidden-but-present modal cannot still trap scroll or taps.",
  "    if (H.classList.contains(\"hoq-anon\")) {",
  "      document.querySelectorAll(\"iframe[src*='web-auth'], iframe[src*='one-tap']\").forEach((f) => {",
  "        const box = f.closest(\"div[class]\") || f.parentElement;",
  "        if (box && box !== document.body) box.remove(); else f.remove();",
  "      });",
  "    }",
  "  };",
  "  anonTick();",
  "  setInterval(anonTick, 1200);",
  "",
  "  // ---- session transplant (receiving end) -----------------------------",
  "  // SoundCloud will not let a sign-in complete through this proxy: its bot",
  "  // protection challenges the request. But a session created normally on the",
  "  // desktop app can be carried over -- same person, same real session, just",
  "  // used from another device.",
  "  //",
  "  // The token arrives in the URL FRAGMENT, which browsers never send to the",
  "  // server. It therefore never appears in nginx logs or any upstream request",
  "  // that did not already need it.",
  "  try {",
  "    const HASH = \"#hoqs=\";",
  "    if (location.hash.indexOf(HASH) === 0) {",
  "      const raw = decodeURIComponent(location.hash.slice(HASH.length));",
  "      const jar = JSON.parse(atob(raw));",
  "      const host = location.hostname.replace(/^[^.]+./, \"\");",
  "      Object.keys(jar).forEach(function (k) {",
  "        document.cookie = k + \"=\" + jar[k] + \"; path=/; domain=.\" + host +",
  "          \"; max-age=31536000; secure; samesite=lax\";",
  "      });",
  "      // Drop the token out of the address bar before anything can screenshot",
  "      // or share it, then reload so the app boots authenticated.",
  "      history.replaceState(null, \"\", location.pathname + location.search);",
  "      location.reload();",
  "    }",
  "  } catch (e) {}",
  "",
  "  // Signed out, /signin and /feed are walls with nothing on them. Bounce back",
  "  // to Discover rather than stranding the user on an empty page they cannot",
  "  // get past. replace() so Back does not land on the wall again.",
  "  const WALLS = new RegExp(\"^/(signin|feed|you|upload|notifications|messages)(/|$)\");",
  "  const bounce = () => {",
  "    if (!H.classList.contains(\"hoq-anon\")) return;",
  "    if (WALLS.test(location.pathname)) location.replace(\"/discover\");",
  "  };",
  "  setTimeout(bounce, 1500);",
  "  setInterval(bounce, 1500);",
  '',
  '  // Replies from the sandbox.',
  "  window.addEventListener('message', (e) => {",
  '    const d = e.data;',
  '    if (!d || d.__hoqReply !== 1) return;',
  "    if (d.kind === 'cover' && d.dataUrl) {",
  '      // A data: URL is same-origin, so the canvas is untainted and preload\'s',
  '      // own extractor can run — this replaces the desktop C# sampler.',
  '      try {',
  '        coverColors(d.dataUrl, (c) => {',
  '          if (c && window.__scCoverColors) window.__scCoverColors(c.c1, c.c2);',
  '        });',
  '      } catch (err) {}',
  "    } else if (d.kind === 'friends' && d.list) {",
  '      try { window.__hoqFriends && window.__hoqFriends(d.list); } catch (err) {}',
  "    } else if (d.kind === 'dcwidget') {",
  '      try { window.__hoqDcWidget && window.__hoqDcWidget(d.data); } catch (err) {}',
  "    } else if (d.kind === 'toast') {",
  "      try { console.log('[hoq]', d.text); } catch (err) {}",
  '    }',
  '  });',
  '})();',
].join('\n');

payload += '\n' + SHIM + '\n';

/* ---- 3. Metadata ------------------------------------------------------- */
const META = [
  '// ==UserScript==',
  '// @name         holdonquietly for SoundCloud',
  '// @namespace    https://github.com/dwindles/holdonquietly-soundcloud',
  '// @version      ' + new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
  '// @description  The holdonquietly theme for SoundCloud, on mobile.',
  '// @author       dwindles',
  '// @match        https://soundcloud.com/*',
  '// @match        https://*.soundcloud.com/*',
  '// @downloadURL  https://raw.githubusercontent.com/dwindles/holdonquietly-soundcloud/master/dist/holdonquietly.user.js',
  '// @updateURL    https://raw.githubusercontent.com/dwindles/holdonquietly-soundcloud/master/dist/holdonquietly.user.js',
  '// @run-at       document-start',
  '// @inject-into  auto',
  '// @grant        GM_xmlhttpRequest',
  '// @grant        GM.xmlHttpRequest',
  '// @grant        GM_getValue',
  '// @grant        GM_setValue',
  '// @connect      discord.com',
  '// @connect      discordapp.com',
  '// @connect      155.138.222.253',
  '// @connect      sndcdn.com',
  '// ==/UserScript==',
  '',
  '',
];

/* ---- 4. Sandbox half --------------------------------------------------- */
const BRIDGE_HEAD = [
  '(function () {',
  "  'use strict';",
  '',
  "  const BACKEND = 'http://155.138.222.253:8790';",
  "  const KEY = 'hoqWebhook';",
  '',
  '  const store = {',
  '    get: (k, d) => {',
  '      try { return GM_getValue(k, d); }',
  '      catch (e) { try { return localStorage.getItem(k) || d; } catch (e2) { return d; } }',
  '    },',
  '    set: (k, v) => {',
  '      try { GM_setValue(k, v); }',
  '      catch (e) { try { localStorage.setItem(k, v); } catch (e2) {} }',
  '    },',
  '  };',
  '',
  '  const reply = (kind, extra) => {',
  '    try {',
  '      window.postMessage(Object.assign({ __hoqReply: 1, kind: kind }, extra), location.origin);',
  '    } catch (e) {}',
  '  };',
  '',
  '  // Managers disagree on this one. Tampermonkey (Android) has the classic',
  '  // sync GM_xmlhttpRequest; the iOS Userscripts app implements the newer',
  '  // promise-style GM.xmlHttpRequest instead. Resolve whichever exists, and',
  '  // fall back to plain fetch — SoundCloud ships no script-src/connect-src CSP,',
  '  // so fetch reaches the webhook fine. It cannot read the artwork CDN (that is',
  '  // a CORS wall, which is the whole reason GM is preferred).',
  '  function req(opts) {',
  '    try {',
  "      if (typeof GM_xmlhttpRequest === 'function') return GM_xmlhttpRequest(opts);",
  '    } catch (e) {}',
  '    try {',
  "      if (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') {",
  '        return GM.xmlHttpRequest(opts);',
  '      }',
  '    } catch (e) {}',
  '    try {',
  '      fetch(opts.url, {',
  "        method: opts.method || 'GET',",
  '        headers: opts.headers || undefined,',
  '        body: opts.data || undefined,',
  '      })',
  '        .then((r) => (',
  "          opts.responseType === 'blob'",
  "            ? r.blob().then((b) => ({ status: r.status, response: b, responseText: '' }))",
  '            : r.text().then((t) => ({ status: r.status, responseText: t }))',
  '        ))',
  '        .then((res) => { if (opts.onload) opts.onload(res); })',
  '        .catch((err) => {',
  '          if (opts.onerror) opts.onerror(err);',
  "          reply('toast', { text: 'request failed: ' + err.message });",
  '        });',
  "    } catch (e) { reply('toast', { text: 'no transport available: ' + e.message }); }",
  '  }',
  '',
  '  // Byte-for-byte the embed the C# host builds, so the Quiet bot sees an',
  '  // identical message (it keys off embed.url and the "hoq-play" footer).',
  '  function sendEmbed(json, play) {',
  "    let wh = store.get(KEY, '');",
  '    if (!wh) {',
  "      wh = prompt('Paste your Discord webhook URL (kept on this device only):') || '';",
  '      if (!/^https?:/.test(wh)) {',
  "        reply('toast', { text: 'no webhook configured' });",
  '        return;',
  '      }',
  '      store.set(KEY, wh.trim());',
  '    }',
  '    let r;',
  '    try { r = JSON.parse(json); } catch (e) { return; }',
  "    if (!r.title) { reply('toast', { text: 'payload had no title' }); return; }",
  '',
  '    const author = {',
  "      name: r.name ? (r.name + (play ? ' wants to play this' : ' shared a track'))",
  "                   : (play ? 'Play request' : 'Now playing'),",
  '    };',
  '    if (r.avatar) author.icon_url = r.avatar;',
  '',
  '    const embed = {',
  '      author: author,',
  '      title: r.title,',
  "      color: typeof r.color === 'number' ? r.color : 0xff5500,",
  '      timestamp: new Date().toISOString(),',
  "      footer: { text: play ? 'hoq-play' : 'via holdonquietly' },",
  '    };',
  '    if (r.url) embed.url = r.url;',
  "    if (r.artist) embed.description = 'by **' + r.artist + '**';",
  '    if (r.cover) embed.thumbnail = { url: r.cover };',
  '',
  '    const fields = [];',
  "    if (r.length) fields.push({ name: 'Length', value: r.length, inline: true });",
  "    if (r.url) fields.push({ name: 'Listen', value: '[Open in SoundCloud](' + r.url + ')', inline: true });",
  '    if (fields.length) embed.fields = fields;',
  '',
  "    const body = { username: r.name || 'holdonquietly', embeds: [embed] };",
  '    if (r.avatar) body.avatar_url = r.avatar;',
  '',
  '    req({',
  "      method: 'POST',",
  "      url: store.get(KEY, ''),",
  "      headers: { 'Content-Type': 'application/json' },",
  '      data: JSON.stringify(body),',
  "      onload: (res) => reply('toast', { text: (play ? 'playreq' : 'share') + ' <- HTTP ' + res.status }),",
  "      onerror: () => reply('toast', { text: (play ? 'playreq' : 'share') + ' failed' }),",
  '    });',
  '  }',
  '',
  "  // SoundCloud's CDN taints the canvas, which is why the desktop build samples",
  '  // artwork in C#. GM_xmlhttpRequest is not bound by that, so re-serve the',
  '  // bytes as a data: URL and let preload\'s own extractor do the work.',
  '  function cover(url) {',
  '    req({',
  "      method: 'GET', url: url, responseType: 'blob',",
  '      onload: (res) => {',
  '        try {',
  '          const fr = new FileReader();',
  "          fr.onload = () => reply('cover', { dataUrl: fr.result });",
  '          fr.readAsDataURL(res.response);',
  '        } catch (e) {}',
  '      },',
  '    });',
  '  }',
  '',
  '  function friends() {',
  '    req({',
  "      method: 'GET', url: BACKEND + '/friends',",
  "      onload: (res) => { try { reply('friends', { list: JSON.parse(res.responseText) }); } catch (e) {} },",
  '    });',
  '  }',
  '',
  '  // The desktop host polls this on its own loop (FriendsLoop) — nothing in the',
  '  // page ever asks for it — so the sandbox has to drive it here too. The first',
  '  // call is delayed so the page-side listener exists to receive the reply.',
  '  setTimeout(friends, 3000);',
  '  setInterval(friends, 60000);',
  '',
  '  function dcWidget() {',
  '    req({',
  "      method: 'GET',",
  "      url: 'https://discord.com/api/guilds/795316631655546900/widget.json',",
  '      onload: (res) => {',
  '        let j = null;',
  '        try { j = JSON.parse(res.responseText); } catch (e) {}',
  "        reply('dcwidget', { data: j });",
  '      },',
  "      onerror: () => reply('dcwidget', { data: null }),",
  '    });',
  '  }',
  '',
  "  window.addEventListener('message', (e) => {",
  '    if (e.source !== window) return;',
  '    const d = e.data;',
  '    if (!d || d.__hoq !== 1) return;',
  "    const cmd = String(d.cmd || '');",
  "    if (cmd.indexOf('webhook:') === 0) sendEmbed(cmd.slice(8), false);",
  "    else if (cmd.indexOf('playreq:') === 0) sendEmbed(cmd.slice(8), true);",
  "    else if (cmd.indexOf('cover:') === 0) cover(cmd.slice(6));",
  "    else if (cmd === 'dcwidget') dcWidget();",
  "    else if (cmd.indexOf('open:') === 0) { try { window.open(cmd.slice(5), '_blank'); } catch (er) {} }",
  '    // Everything else (win:*, rpc:, acct:*, lastfm:*, update:apply, DBG…) has',
  '    // no mobile equivalent and is intentionally dropped.',
  '  });',
  '',
  '  // Inject the payload into the PAGE world. Function.toString() carries the',
  '  // source verbatim, so none of preload.js needs escaping.',
  '  function __hoqPayload() {',
].join('\n');

const BRIDGE_TAIL = [
  '  }',
  '',
  "  const el = document.createElement('script');",
  "  el.textContent = '(' + __hoqPayload.toString() + ')();';",
  '  (document.head || document.documentElement).appendChild(el);',
  '  el.remove();',
  '})();',
  '',
].join('\n');

/* Assembled by concatenation, never template interpolation: preload.js is full
   of its own backticks and ${...} and would not survive being interpolated. */
const out = META.join('\n') + BRIDGE_HEAD + '\n' + payload + '\n' + BRIDGE_TAIL;

const dir = path.join(ROOT, 'dist');
fs.mkdirSync(dir, { recursive: true });
const dest = path.join(dir, 'holdonquietly.user.js');
fs.writeFileSync(dest, out, 'utf8');
console.log('wrote ' + dest);
console.log('  ' + Math.round(out.length / 1024) + ' KB, ' + out.split('\n').length + ' lines');

/* =======================================================================
   Second output: a bookmarklet build, for a phone that cannot install an
   extension at all.

   It gives up less than you would expect, because two things checked out:
     - SoundCloud ships no script-src/connect-src CSP, so an injected
       <script src> runs and plain fetch reaches the Discord webhook.
     - i1.sndcdn.com sends Access-Control-Allow-Origin: *, so preload's own
       canvas extractor reads artwork fine. Cover accent needs no host at all;
       the 'cover:' fallback that exists for the desktop build never fires.

   What it does lose: the friends feed. That backend is plain http://, and a
   fetch to http from an https page is mixed content and blocked. GM_xmlhttp-
   Request is exempt, which is why the userscript build keeps it.
   ======================================================================= */
const BOOT_POST = [
  'function scPost(cmd) {',
  '  // Bookmarklet build: no host, no GM. Handle what a plain page can do and',
  '  // drop the rest (win:*, rpc:, acct:*, lastfm:*, update:apply, DBG…).',
  '  try {',
  '    cmd = String(cmd);',
  "    if (cmd.indexOf('webhook:') === 0) window.__hoqSend(cmd.slice(8), false);",
  "    else if (cmd.indexOf('playreq:') === 0) window.__hoqSend(cmd.slice(8), true);",
  "    else if (cmd.indexOf('open:') === 0) window.open(cmd.slice(5), '_blank');",
  '  } catch (e) {}',
  '}',
].join('\n');

const BOOT_SEND = [
  '',
  '/* ---------------- bookmarklet: webhook over plain fetch ---------------- */',
  '(() => {',
  "  const KEY = 'hoqWebhook';",
  '  window.__hoqSend = function (json, play) {',
  '    let wh;',
  "    try { wh = localStorage.getItem(KEY) || ''; } catch (e) { wh = ''; }",
  '    if (!wh) {',
  "      wh = prompt('Paste your Discord webhook URL (kept on this device only):') || '';",
  '      if (!/^https?:/.test(wh)) return;',
  '      try { localStorage.setItem(KEY, wh.trim()); } catch (e) {}',
  '    }',
  '    let r;',
  '    try { r = JSON.parse(json); } catch (e) { return; }',
  '    if (!r.title) return;',
  '',
  '    const author = {',
  "      name: r.name ? (r.name + (play ? ' wants to play this' : ' shared a track'))",
  "                   : (play ? 'Play request' : 'Now playing'),",
  '    };',
  '    if (r.avatar) author.icon_url = r.avatar;',
  '    const embed = {',
  '      author: author,',
  '      title: r.title,',
  "      color: typeof r.color === 'number' ? r.color : 0xff5500,",
  '      timestamp: new Date().toISOString(),',
  "      footer: { text: play ? 'hoq-play' : 'via holdonquietly' },",
  '    };',
  '    if (r.url) embed.url = r.url;',
  "    if (r.artist) embed.description = 'by **' + r.artist + '**';",
  '    if (r.cover) embed.thumbnail = { url: r.cover };',
  '    const fields = [];',
  "    if (r.length) fields.push({ name: 'Length', value: r.length, inline: true });",
  "    if (r.url) fields.push({ name: 'Listen', value: '[Open in SoundCloud](' + r.url + ')', inline: true });",
  '    if (fields.length) embed.fields = fields;',
  "    const body = { username: r.name || 'holdonquietly', embeds: [embed] };",
  '    if (r.avatar) body.avatar_url = r.avatar;',
  '',
  '    try {',
  '      fetch(wh, {',
  "        method: 'POST',",
  "        headers: { 'Content-Type': 'application/json' },",
  '        body: JSON.stringify(body),',
  "      }).then((res) => console.log('[hoq] ' + (play ? 'playreq' : 'share') + ' <- HTTP ' + res.status))",
  "        .catch((e) => console.log('[hoq] send failed: ' + e.message));",
  '    } catch (e) {}',
  '  };',
  '})();',
].join('\n');

let bootPayload = src.replace(OLD_POST, BOOT_POST) + '\n' + SHIM + '\n' + BOOT_SEND + '\n';

const BOOT = [
  '/* holdonquietly — bookmarklet build. GENERATED by tools/build-userscript.js.',
  '   For a phone that cannot install a userscript manager: load it from a',
  '   javascript: bookmark. See MOBILE.md. */',
  '(function () {',
  '  if (window.__hoqLoaded) return;',
  '  window.__hoqLoaded = true;',
  '',
].join('\n') + bootPayload + '\n})();\n';

const bootDest = path.join(dir, 'holdonquietly.boot.js');
fs.writeFileSync(bootDest, BOOT, 'utf8');
console.log('wrote ' + bootDest);
console.log('  ' + Math.round(BOOT.length / 1024) + ' KB, ' + BOOT.split('\n').length + ' lines');

/* The bookmark itself: a loader, because a 290 KB javascript: URL is not a
   thing. jsDelivr is required — GitHub raw serves text/plain with nosniff, so
   the browser refuses to execute it as a script. */
const LOADER =
  "javascript:(function(){if(window.__hoqLoaded)return;var s=document.createElement('script');" +
  "s.src='https://cdn.jsdelivr.net/gh/dwindles/holdonquietly-soundcloud@master/dist/holdonquietly.boot.js?v='+Date.now();" +
  'document.body.appendChild(s);})()';
fs.writeFileSync(path.join(dir, 'bookmarklet.txt'), LOADER + '\n', 'utf8');
console.log('wrote ' + path.join(dir, 'bookmarklet.txt') + '  (' + LOADER.length + ' chars)');

/* Same loader again, shaped for the iOS Shortcuts "Run JavaScript on Web Page"
   action. Shortcuts is preinstalled, so this is the one route that needs no
   App Store and no bookmark editing. That action requires calling completion()
   to hand a result back, or the shortcut just hangs. */
const SHORTCUT = [
  'var s = document.createElement("script");',
  "s.src = 'https://cdn.jsdelivr.net/gh/dwindles/holdonquietly-soundcloud@master/dist/holdonquietly.boot.js?v=' + Date.now();",
  'document.body.appendChild(s);',
  'completion("hoq loaded");',
].join('\n');
fs.writeFileSync(path.join(dir, 'shortcut.js'), SHORTCUT + '\n', 'utf8');
console.log('wrote ' + path.join(dir, 'shortcut.js') + '  (' + SHORTCUT.split('\n').length + ' lines)');

/* =======================================================================
   Third output: the reverse-proxy build (see proxy/hoq-proxy.conf).

   Served from the proxy's own origin, so it is same-origin with the app.
   That removes every constraint the other two builds work around:
     - no CSP and no CORS, because there is only one origin
     - artwork is proxied through us, so the canvas is never tainted
     - the friends backend is reachable at /__hoq/friends — it is plain http,
       which an https page cannot fetch directly, but nginx can

   So this is the most capable mobile build, not the least. Only Rich Presence
   (Discord's local IPC) and account switching (a WebView2 profile thing) stay
   out of reach.
   ======================================================================= */
const PROXY_POST = [
  'function scPost(cmd) {',
  '  // Reverse-proxy build: same-origin, so plain fetch is enough.',
  '  try {',
  '    cmd = String(cmd);',
  "    if (cmd.indexOf('webhook:') === 0) window.__hoqSend(cmd.slice(8), false);",
  "    else if (cmd.indexOf('playreq:') === 0) window.__hoqSend(cmd.slice(8), true);",
  "    else if (cmd.indexOf('open:') === 0) window.open(cmd.slice(5), '_blank');",
  '  } catch (e) {}',
  '}',
].join('\n');

const PROXY_EXTRA = [
  '',
  '/* -------- reverse-proxy build: friends feed over the local hop -------- */',
  '(() => {',
  '  // nginx proxies this to the plain-http backend on the same box, which is',
  '  // the only reason an https page can reach it at all.',
  '  const pull = () => {',
  "    fetch('/__hoq/friends', { credentials: 'omit' })",
  '      .then((r) => r.json())',
  '      .then((list) => { try { window.__hoqFriends && window.__hoqFriends(list); } catch (e) {} })',
  '      .catch(() => {});',
  '  };',
  '  setTimeout(pull, 3000);',
  '  setInterval(pull, 60000);',
  '})();',
].join('\n');

let proxyPayload = src.replace(OLD_POST, PROXY_POST) + '\n' + SHIM + '\n' + BOOT_SEND + '\n' + PROXY_EXTRA + '\n';

const PROXY_OUT = [
  '/* holdonquietly — reverse-proxy build. GENERATED by tools/build-userscript.js.',
  '   Served as /hoq.js by proxy/hoq-proxy.conf and injected into </head>. */',
  '(function () {',
  '  if (window.__hoqLoaded) return;',
  '  window.__hoqLoaded = true;',
  '',
].join('\n') + proxyPayload + '\n})();\n';

const proxyDest = path.join(dir, 'holdonquietly.proxy.js');
fs.writeFileSync(proxyDest, PROXY_OUT, 'utf8');
console.log('wrote ' + proxyDest);
console.log('  ' + Math.round(PROXY_OUT.length / 1024) + ' KB, ' + PROXY_OUT.split('\n').length + ' lines');
