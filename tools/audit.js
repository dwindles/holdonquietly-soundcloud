/* holdonquietly — theme/DOM audit harness.
 *
 * WHY THIS EXISTS: SoundCloud ships DOM changes behind login + A/B flags, so the
 * new UI is invisible from a logged-out browser. This runs inside the app, where
 * the real (logged-in, flagged) DOM lives, and reports exactly which parts of the
 * theme still bind and which have gone dead.
 *
 * USE:
 *   1. Set the accent to something clearly NOT orange (blue/green) in the palette.
 *      The leak detector finds leftover SoundCloud orange — with an orange accent
 *      every correctly-themed element looks like a leak.
 *   2. F12 -> Console -> paste this whole file.
 *   3. Browse normally: home / a track / a profile / library / search. It
 *      auto-scans on each route change.
 *   4. HOQAUDIT.report()   -> prints + copies the JSON report to the clipboard.
 *
 * Extra: HOQAUDIT.dump('.someSelector', 3) -> compact DOM skeleton of a subtree.
 */
(function () {
  const PREV = window.HOQAUDIT;
  const S = (PREV && PREV._state) || { pages: {}, started: new Date().toISOString() };

  const cls = (el) => {
    const c = el.className;
    return (typeof c === 'string' ? c : (c && c.baseVal) || '').trim();
  };
  const tokens = (el) => cls(el).split(/\s+/).filter(Boolean);
  const OURS = /^(sc-|hoq-|pal-)/;
  const isOurs = (el) => !!(el.closest &&
    el.closest('#sc-titlebar, #sc-palette, #sc-bg, #hoq-scroll, [id^="sc-"], [class^="hoq-"]'));

  // --- 1. What the theme actually targets ----------------------------------
  // Our own injected <style> is same-origin, so its rules are readable. Its
  // selector list IS the theme's contract with SoundCloud's DOM — reading it
  // here keeps the audit in sync with preload.js automatically.
  function walkRules(rules, out) {
    for (const r of rules) {
      if (r.selectorText) r.selectorText.split(',').forEach((s) => out.add(s.trim()));
      if (r.cssRules) walkRules(r.cssRules, out); // @media / @supports / @layer
    }
  }
  function themeSelectors() {
    const out = new Set();
    for (const sheet of document.styleSheets) {
      const o = sheet.ownerNode;
      if (!o || o.id !== 'sc-desktop-style') continue;
      try { walkRules(sheet.cssRules, out); } catch (e) {}
    }
    return [...out];
  }

  // --- 2. Orange-leak detector ---------------------------------------------
  // The version-agnostic check: regardless of class names, find anything still
  // painted SoundCloud orange while the accent is something else. This finds
  // breakage selector-matching cannot — a selector that matches but loses the
  // cascade, or a brand-new orange element SoundCloud just introduced.
  const RGB = /rgba?\((\d+),\s*(\d+),\s*(\d+)/g;
  function accentRGB() {
    const probe = document.createElement('span');
    probe.style.color = 'var(--sc-accent, #ff5500)';
    document.body.appendChild(probe);
    const v = getComputedStyle(probe).color;
    probe.remove();
    RGB.lastIndex = 0;
    const m = RGB.exec(v);
    return m ? [+m[1], +m[2], +m[3]] : [255, 85, 0];
  }
  function isOrangeFamily(r, g, b) {
    // Red-dominant, mid green, low-ish blue, genuinely saturated. Deliberately
    // wider than preload's isOrange(): catches the newer MUI tokens, gradient
    // stops and color-mix() results whose blue channel drifts up to ~90.
    return r >= 200 && g >= 40 && g <= 165 && b <= 90 && r - b > 110 && r - g > 55;
  }
  const PROPS = [
    'color', 'backgroundColor', 'backgroundImage', 'borderTopColor', 'borderRightColor',
    'borderBottomColor', 'borderLeftColor', 'outlineColor', 'fill', 'stroke',
    'boxShadow', 'caretColor', 'textDecorationColor', 'columnRuleColor',
  ];
  function sig(el) {
    const c = tokens(el).filter((t) => !OURS.test(t)).slice(0, 4);
    return el.tagName.toLowerCase() + (c.length ? '.' + c.join('.') : '');
  }
  function ancestry(el, n) {
    const out = [];
    let p = el.parentElement;
    while (p && out.length < n && p !== document.body) {
      if (tokens(p).length) out.push(sig(p));
      p = p.parentElement;
    }
    return out.join(' < ');
  }
  function orangeLeaks(accent) {
    const ar = accent[0], ag = accent[1], ab = accent[2];
    const accentIsOrange = isOrangeFamily(ar, ag, ab);
    const hits = new Map();
    for (const el of document.querySelectorAll('*')) {
      if (isOurs(el)) continue;
      const cs = getComputedStyle(el);
      for (const p of PROPS) {
        const v = cs[p];
        if (!v || v === 'none' || v === 'rgba(0, 0, 0, 0)') continue;
        RGB.lastIndex = 0;
        let m, bad = null;
        while ((m = RGB.exec(v))) {
          const r = +m[1], g = +m[2], b = +m[3];
          if (r === ar && g === ag && b === ab) continue; // that IS the accent
          if (isOrangeFamily(r, g, b)) { bad = 'rgb(' + r + ', ' + g + ', ' + b + ')'; break; }
        }
        if (!bad) continue;
        const k = sig(el) + ' | ' + p;
        if (!hits.has(k)) {
          hits.set(k, { sel: sig(el), prop: p, value: bad, count: 0, under: ancestry(el, 3) });
        }
        hits.get(k).count++;
      }
    }
    return {
      accentIsOrange,
      note: accentIsOrange
        ? 'ACCENT IS ORANGE — leaks unreliable, re-run with a blue/green accent'
        : 'ok',
      leaks: [...hits.values()].sort((a, b) => b.count - a.count).slice(0, 60),
    };
  }

  // --- 3. Vocabulary diff ---------------------------------------------------
  function vocabulary(themeSels) {
    const known = new Set();
    themeSels.forEach((s) => {
      for (const m of s.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) known.add(m[1]);
    });
    const seen = new Map();
    document.querySelectorAll('*').forEach((el) => {
      if (isOurs(el)) return;
      tokens(el).forEach((t) => {
        if (OURS.test(t)) return;
        seen.set(t, (seen.get(t) || 0) + 1);
      });
    });
    const unknown = [...seen.entries()]
      .filter((e) => !known.has(e[0]))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 120)
      .map((e) => e[0] + '×' + e[1]);
    const present = new Set(seen.keys());
    return { unknown, deadHere: [...known].filter((k) => !present.has(k)).sort() };
  }

  // --- 4. MUI inventory -----------------------------------------------------
  function mui() {
    const names = new Map();
    document.querySelectorAll('[class*="Mui"]').forEach((el) => {
      tokens(el).forEach((t) => { if (/^Mui/.test(t)) names.set(t, (names.get(t) || 0) + 1); });
    });
    const rootCS = getComputedStyle(document.documentElement);
    const vars = [];
    try {
      for (const p of rootCS) {
        if (/^--mui-/.test(p)) vars.push(p + ': ' + rootCS.getPropertyValue(p).trim());
      }
    } catch (e) {}
    return {
      classCount: names.size,
      classes: [...names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 80)
        .map((e) => e[0] + '×' + e[1]),
      emotionStyleTags: document.querySelectorAll('style[data-emotion]').length,
      colorSchemeAttr: document.documentElement.getAttribute('data-mui-color-scheme'),
      muiVars: vars.slice(0, 90),
    };
  }

  // --- 5. Theme anchors -----------------------------------------------------
  // Each anchor is a concept the theme depends on, probed with old AND new
  // candidates so we can see which generation this page is serving.
  const ANCHORS = {
    waveform: ['.waveform', '.waveform__layer', '[class*="Waveform" i]',
      '[data-testid*="wave" i]', 'canvas[class*="wave" i]'],
    trackHero: ['.fullListenHero', '.fullHero', '.listenHero', '.l-listen-hero',
      '[class*="TrackHero" i]', '[class*="Hero" i]'],
    coverArt: ['.fullHero__artwork', '.listenArtworkWall', '.image__full', '[class*="Artwork" i]'],
    playerBar: ['.playControls', '.playControls__inner', '[class*="PlayControls" i]'],
    progressBar: ['.playbackTimeline__progressBar', '.playbackTimeline__progressWrapper',
      '[class*="Progress" i]'],
    tabs: ['.g-tabs', '.g-tabs-item', '.MuiTabs-root', '.MuiTab-root', '[role="tablist"]'],
    sliders: ['.MuiSlider-root', '.MuiSlider-track', 'input[type="range"]'],
    chips: ['.MuiChip-root', '.MuiChip-clickable', '.sc-tag', '[class*="Chip" i]'],
    banners: ['.banner', '.banner.m-promotion', '.banner__UiEvoIcon', '[class*="Banner" i]',
      '[class*="Upsell" i]'],
    comments: ['.commentsList', '.commentItem', '.commentForm', '[class*="Comment" i]'],
    relatedLinks: ['.soundBadge', '.MuiLink-underlineNone', '[class*="Link" i][class*="Mui" i]'],
    buttons: ['.sc-button', '.MuiButton-root', '.MuiButton-containedPrimary'],
    header: ['.header', '.header__inner', '.header__userNav', '[class*="Header" i]'],
  };
  function anchors() {
    const out = {};
    for (const name of Object.keys(ANCHORS)) {
      const found = [];
      for (const s of ANCHORS[name]) {
        let n = 0;
        try { n = document.querySelectorAll(s).length; } catch (e) { n = -1; }
        if (n > 0) found.push(s + '×' + n);
      }
      out[name] = found.length ? found : ['NONE'];
    }
    return out;
  }

  // --- 6. Compact DOM skeleton ---------------------------------------------
  function skeleton(el, depth, maxKids) {
    if (!el || depth < 0) return null;
    const kids = [].slice.call(el.children, 0, maxKids)
      .map((k) => skeleton(k, depth - 1, maxKids)).filter(Boolean);
    const node = { t: sig(el) };
    const r = el.getBoundingClientRect();
    if (r.width || r.height) node.box = Math.round(r.width) + 'x' + Math.round(r.height);
    if (kids.length) node.c = kids;
    return node;
  }

  // --- scan / report --------------------------------------------------------
  function scan() {
    const themeSels = themeSelectors();
    const accent = accentRGB();
    const scSels = themeSels.filter((s) => !/#sc-|\.hoq-|\.pal-/.test(s));
    const unmatched = [];
    for (const s of scSels) {
      try { if (!document.querySelector(s)) unmatched.push(s); } catch (e) { unmatched.push('INVALID: ' + s); }
    }
    const page = {
      url: location.pathname + location.search,
      at: new Date().toISOString(),
      accent: 'rgb(' + accent.join(', ') + ')',
      themeSelectorCount: themeSels.length,
      unmatchedCount: unmatched.length,
      unmatched: unmatched.slice(0, 200),
      anchors: anchors(),
      mui: mui(),
      vocab: vocabulary(themeSels),
      orange: orangeLeaks(accent),
    };
    S.pages[page.url] = page;
    console.log('%c[HOQAUDIT] scanned ' + page.url,
      'color:#0af;font-weight:700',
      '| unmatched ' + unmatched.length + '/' + scSels.length,
      '| MUI ' + page.mui.classCount,
      '| orange leaks ' + page.orange.leaks.length);
    return page;
  }

  function report() {
    const out = JSON.stringify(
      { started: S.started, pageCount: Object.keys(S.pages).length, pages: S.pages }, null, 1);
    console.log(out);
    try {
      navigator.clipboard.writeText(out).then(
        () => console.log('%c[HOQAUDIT] report copied (' + out.length + ' chars)',
          'color:#0f0;font-weight:700'),
        () => console.log('[HOQAUDIT] clipboard blocked — copy the JSON above')
      );
    } catch (e) {}
    return '(report above)';
  }

  // Auto-scan on SPA route change: SoundCloud never reloads, so hook history.
  if (!PREV) {
    let t = null;
    const bump = () => { clearTimeout(t); t = setTimeout(scan, 1800); };
    const wrap = (fn) => function () { const r = fn.apply(this, arguments); bump(); return r; };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
    addEventListener('popstate', bump);
  }

  window.HOQAUDIT = {
    _state: S,
    scan,
    report,
    dump: (sel, depth) => {
      const el = document.querySelector(sel);
      if (!el) return 'no match: ' + sel;
      const s = JSON.stringify(skeleton(el, depth == null ? 3 : depth, 12), null, 1);
      console.log(s);
      try { navigator.clipboard.writeText(s); } catch (e) {}
      return '(skeleton above, copied)';
    },
  };
  console.log('%c[HOQAUDIT] ready', 'color:#0af;font-weight:700',
    '— browse SoundCloud, then run HOQAUDIT.report()');
  scan();
})();
