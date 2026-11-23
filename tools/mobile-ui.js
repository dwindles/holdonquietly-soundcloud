  // ---- phone UI: tab bar, floating player, full-screen player, queue ----
  // tools/build-userscript.js puts this inside the mobile shim, so H
  // (document.documentElement), HOQ_FRAME_CSS and preload.js's functions are in
  // scope. Everything here is our own DOM: each button presses SoundCloud's real
  // control (kept in the page, invisible), so playback state is always
  // SoundCloud's. Styles: tools/mobile.css.
  (() => {
    const SV = (d) => '<svg viewBox="0 0 24 24" aria-hidden="true">' + d + '</svg>';
    const IC = {
      play: SV('<path class="f" d="M8 5.7v12.6c0 .8.9 1.3 1.6.9l9.9-6.3c.6-.4.6-1.4 0-1.8L9.6 4.8C8.9 4.4 8 4.9 8 5.7z"/>'),
      pause: SV('<rect class="f" x="6.5" y="5" width="4" height="14" rx="1.2"/><rect class="f" x="13.5" y="5" width="4" height="14" rx="1.2"/>'),
      prev: SV('<rect class="f" x="4.8" y="5.5" width="2.4" height="13" rx="1"/><path class="f" d="M19 6.8v10.4c0 .9-1 1.4-1.7.9l-7.4-5.2a1.1 1.1 0 0 1 0-1.8l7.4-5.2c.7-.5 1.7 0 1.7.9z"/>'),
      next: SV('<rect class="f" x="16.8" y="5.5" width="2.4" height="13" rx="1"/><path class="f" d="M5 6.8v10.4c0 .9 1 1.4 1.7.9l7.4-5.2a1.1 1.1 0 0 0 0-1.8L6.7 5.9C6 5.4 5 5.9 5 6.8z"/>'),
      heart: SV('<path d="M12 20.3s-7.3-4.4-9.2-8.9C1.4 8 3.5 4.6 7.1 4.6c2.1 0 3.6 1.1 4.9 2.8 1.3-1.7 2.8-2.8 4.9-2.8 3.6 0 5.7 3.4 4.3 6.8-1.9 4.5-9.2 8.9-9.2 8.9z"/>'),
      send: SV('<path d="M21 3 10.2 13.8"/><path d="M21 3 14.4 21l-4.2-7.2L3 9.6z"/>'),
      discord: SV('<path class="f" d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.865-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>'),   // the Discord logo
      shuffle: SV('<path d="M16 4h4v4"/><path d="M4 20 20 4"/><path d="M20 16v4h-4"/><path d="m14.5 14.5 5.5 5.5"/><path d="m4 4 5 5"/>'),
      repeat: SV('<path d="m17 2 3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="m7 22-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/>'),
      queue: SV('<path d="M4 6h12M4 11h12M4 16h7"/><path class="f" d="M15 14.2v5.6c0 .5.5.8.9.5l4.3-2.8a.6.6 0 0 0 0-1l-4.3-2.8c-.4-.3-.9 0-.9.5z"/>'),
      share: SV('<path d="M12 3.5v11"/><path d="m7.5 8 4.5-4.5L16.5 8"/><path d="M5 12.5v6A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5v-6"/>'),
      down: SV('<path d="m6 9 6 6 6-6"/>'),
      home: SV('<path d="M3.5 10.6 12 3.8l8.5 6.8"/><path d="M5.6 9.2V20h4.6v-5.6h3.6V20h4.6V9.2"/>'),
      feed: SV('<rect x="4" y="3.8" width="16" height="7" rx="2"/><rect x="4" y="13.2" width="16" height="7" rx="2"/>'),
      library: SV('<path d="M5 4v16M9.8 4v16"/><path d="m14 4.6 5.2 15"/>'),
      search: SV('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.3-4.3"/>'),
      settings: SV('<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
      social: SV('<circle cx="9" cy="8" r="3.4"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M15.6 4.9a3.3 3.3 0 0 1 0 6.2"/><path d="M18.2 14.3A6 6 0 0 1 21 20"/>'),
    };

    const q = (s, r) => (r || document).querySelector(s);
    const press = (sel) => { const b = q(sel); if (b) b.click(); return !!b; };
    const now = () => { try { return (typeof currentNowPlaying === 'function' && currentNowPlaying()) || {}; } catch (e) { return {}; } };
    const prog = () => { try { return playerProgress(); } catch (e) { return { pos: 0, dur: 0, paused: true }; } };
    const isLiked = () => { const b = q('.playbackSoundBadge__like'); return !!(b && b.classList.contains('sc-button-selected')); };
    const fmt = (s) => {
      s = Math.max(0, Math.floor(s || 0));
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, '0');
      return h ? h + ':' + String(m).padStart(2, '0') + ':' + x : m + ':' + x;
    };
    // The song's public soundcloud.com link (never this site's address).
    const songUrl = () => {
      let h = '';
      try { h = typeof hoqNowHref === 'function' ? hoqNowHref() : ''; } catch (e) {}
      if (!h) return '';
      if (/^https?:/i.test(h) && !/^https?:\/\/([^/]*\.)?(soundcloud|holdonquietly)\.com\//i.test(h)) return h;
      return 'https://soundcloud.com' + h.replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0];
    };
    const big = (u) => (u || '').replace(/-t\d+x\d+\./, '-t500x500.').replace(/-(large|crop)\./, '-t500x500.');
    const safeImg = (u) => (typeof hoqSafeUrl === 'function' ? hoqSafeUrl(u) : '');   // preload's https-only guard

    // ---- toast + action sheet ----------------------------------------------
    let toastEl = null, toastT = 0;
    const toast = (msg) => {
      if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.id = 'hoq-mtoast';
        toastEl.setAttribute('role', 'status');
        document.body.appendChild(toastEl);
      }
      toastEl.textContent = msg;
      toastEl.classList.add('on');
      clearTimeout(toastT);
      toastT = setTimeout(() => toastEl.classList.remove('on'), 1900);
    };
    let acts = null;
    const actionSheet = (title, items) => {
      if (!acts) {
        acts = document.createElement('div');
        acts.id = 'hoq-acts';
        acts.addEventListener('click', (e) => { if (e.target === acts) acts.hidden = true; });
        document.body.appendChild(acts);
      }
      acts.innerHTML = '<div class="ac-box" role="menu"><div class="ac-title"></div><div class="ac-list"></div>' +
        '<button class="ac-cancel" type="button">Cancel</button></div>';
      q('.ac-title', acts).textContent = title || '';
      const list = q('.ac-list', acts);
      items.forEach((it) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        b.textContent = it.label;
        if (it.sub) {   // a line under it saying what it does
          const sm = document.createElement('small');
          sm.className = 'ac-sub';
          sm.textContent = it.sub;
          b.appendChild(sm);
        }
        b.addEventListener('click', () => { acts.hidden = true; try { it.run(); } catch (e) {} });
        list.appendChild(b);
      });
      q('.ac-cancel', acts).addEventListener('click', () => { acts.hidden = true; });
      acts.hidden = false;
    };
    const songLine = () => { const n = now(); return n.title ? n.title + (n.artist ? ' · ' + n.artist : '') : ''; };
    const discordMenu = () => {
      const items = [];
      if (document.getElementById('hoq-playbtn')) items.push({ label: 'Play in Discord', sub: 'The bot plays it in your voice channel, and it’s posted in the text channel too.', run: () => press('#hoq-playbtn') });
      if (document.getElementById('hoq-share')) items.push({ label: 'Share to Discord', sub: 'Posts it in the text channel, without playing it.', run: () => press('#hoq-share') });
      if (!items.length) { toast('Discord isn’t ready yet'); return; }
      actionSheet(songLine(), items);
    };
    const shareSong = () => {
      const url = songUrl(), n = now();
      if (!url) { toast('Nothing playing'); return; }
      if (navigator.share) {
        navigator.share({ title: n.title || 'SoundCloud', text: songLine(), url: url }).catch(() => {});
        return;
      }
      try { hoqCopy(url); toast('Link copied'); } catch (e) { toast(url); }
    };
    let likeHold = 0;   // SoundCloud takes a moment to flip its button; don't flip ours back meanwhile
    const like = (btn) => {
      if (!press('.playbackSoundBadge__like')) return;
      likeHold = performance.now() + 1500;
      const on = !btn.classList.contains('on');
      [likeBtn, mLike].forEach((b) => { b.classList.toggle('on', on); b.setAttribute('aria-label', on ? 'Unlike' : 'Like'); });
      btn.classList.remove('pop'); void btn.offsetWidth; btn.classList.add('pop');
    };
    // The queue is SoundCloud's own "Next up" panel, styled as a sheet.
    const queueOpen = () => !!q('.playControls .queue.m-visible');
    const toggleQueue = () => {
      if (!press('.playbackSoundBadge__showQueue')) return;
      // SoundCloud draws only the rows that fit the panel's old (desktop) size;
      // a resize, and a real scroll of its list, make it draw the rest of the
      // taller sheet. (.queue__scrollableInner is the element that scrolls.)
      [80, 400].forEach((ms) => setTimeout(() => {
        if (!queueOpen()) return;
        try {
          window.dispatchEvent(new Event('resize'));
          const sc = q('.playControls .queue__scrollableInner');
          if (sc) { const t = sc.scrollTop; sc.scrollTop = t + 1; sc.scrollTop = t; sc.dispatchEvent(new Event('scroll')); }
        } catch (e) {}
      }, ms));
    };

    // ---- bottom tab bar ------------------------------------------------------
    const TABS = [
      { k: 'home', label: 'Home', icon: IC.home },
      { k: 'feed', label: 'Feed', icon: IC.feed, auth: 1 },
      { k: 'library', label: 'Library', icon: IC.library, auth: 1 },
      { k: 'search', label: 'Search', icon: IC.search, anon: 1 },
      { k: 'social', label: 'Social', icon: IC.social },
      { k: 'settings', label: 'Settings', icon: IC.settings },
    ];
    const tabs = document.createElement('nav');
    tabs.id = 'hoq-tabs';
    tabs.setAttribute('aria-label', 'Main');
    tabs.innerHTML = TABS.map((t) => '<button type="button" data-k="' + t.k + '"' + (t.auth ? ' data-auth' : '') +
      (t.anon ? ' data-anon hidden' : '') + '>' + t.icon + '<span>' + t.label + '</span></button>').join('');
    const HREF = { home: '/discover', feed: '/feed', library: '/you/library' };
    // SoundCloud's own nav links (hidden on the phone): pressing them keeps its
    // router doing the navigating.
    const realLink = (k) => {
      const nav = '.header__navMenu a.header__navMenuItem';
      if (k === 'home') return q(nav + '[href="/discover"]') || q(nav + '[href="/"]') || q('.header__logoLink');
      if (k === 'feed') return q(nav + '[href="/feed"]') || q(nav + '[data-menu-name="stream"]');
      if (k === 'library') return q(nav + '[href="/you/library"]') || q(nav + '[data-menu-name="library"]');
      return null;
    };
    const curTab = () => {
      if (H.classList.contains('hoq-tab')) { const dp = document.getElementById('hoq-discord'); return dp && dp.dataset.pane === 'settings' ? 'settings' : 'social'; }
      const p = location.pathname;
      if (/^\/(discover|home)?\/?$/.test(p)) return 'home';
      if (/^\/(feed|stream)(\/|$)/.test(p)) return 'feed';
      if (/^\/you(\/|$)/.test(p)) return 'library';
      if (/^\/search(\/|$)/.test(p)) return 'search';
      return '';
    };
    let tabKey = '';
    const syncTabs = () => {
      // Account-only tabs wait for the header to show you're signed in (the
      // shim's hoq-anon only appears once it has rendered), and signed-out ones
      // for hoq-anon, so a signed-out phone never flashes Feed and Library.
      const anon = H.classList.contains('hoq-anon');
      const signed = !anon && !!q(".header__userNavUsernameButton, .header__userNav a[href^='/you']");
      const c = curTab(), key = c + '|' + anon + '|' + signed;
      if (key === tabKey) return;
      tabKey = key;
      tabs.querySelectorAll('button').forEach((b) => {
        b.hidden = (b.hasAttribute('data-auth') && !signed) || (b.hasAttribute('data-anon') && !anon);
        const on = b.dataset.k === c;
        b.classList.toggle('on', on);
        if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
      });
    };
    tabs.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-k]');
      if (!b) return;
      const k = b.dataset.k, was = curTab();
      if (k === 'social' || k === 'settings') {
        // Social/Settings is one page with sub-tabs: Settings opens it on its
        // Settings tab, Social on the rest. The tab you're on again closes it.
        if (was === k) { if (typeof toggleDiscord === 'function') toggleDiscord(); }
        else {
          if (!H.classList.contains('hoq-tab') && typeof toggleDiscord === 'function') toggleDiscord();
          const p = document.getElementById('hoq-discord');
          if (p) {
            const want = k === 'settings' ? 'settings' : 'social';
            if (k === 'settings' || p.dataset.pane === 'settings') {
              const st = p.querySelector('.hoq-subtab[data-pane="' + want + '"]');
              if (st) st.click();
            }
            p.scrollTop = 0;
          }
        }
      } else {
        if (H.classList.contains('hoq-tab') && typeof closeDiscord === 'function') closeDiscord();
        if (k === 'search') {
          const i = q('.headerSearch__input');
          if (i) { i.focus(); try { i.select(); } catch (er) {} }
        } else if (was === k) {
          window.scrollTo({ top: 0, behavior: 'smooth' });   // tapping the tab you're on: back to the top
        } else {
          const a = realLink(k);
          if (a) a.click(); else location.assign(HREF[k]);
        }
      }
      tabKey = '';
      syncTabs();
    });

    // ---- floating player -----------------------------------------------------
    // Ring-progress play button with the cover in it, title and artist (tap: the
    // full player), previous / next, like, Discord. Swipe it to skip.
    const RING = 144.51;   // circumference, r = 23
    const pill = document.createElement('div');
    pill.id = 'hoq-pill';
    pill.innerHTML =
      '<button class="pl-play" type="button" aria-label="Play">' +
        '<svg class="pl-ring" viewBox="0 0 52 52" aria-hidden="true"><circle class="pl-track" cx="26" cy="26" r="23"/><circle class="pl-prog" cx="26" cy="26" r="23"/></svg>' +
        '<span class="pl-disc">' + IC.play + '</span>' +
      '</button>' +
      '<div class="pl-meta" role="button" tabindex="0" aria-label="Open the player"><b class="pl-title"></b><span class="pl-artist"></span></div>' +
      '<div class="pl-btns">' +
        '<button class="pl-prev" type="button" aria-label="Previous">' + IC.prev + '</button>' +
        '<button class="pl-next" type="button" aria-label="Next">' + IC.next + '</button>' +
        '<button class="pl-like" type="button" aria-label="Like">' + IC.heart + '</button>' +
        '<button class="pl-dc" type="button" aria-label="Discord" aria-haspopup="menu">' + IC.discord + '</button>' +
      '</div>';
    const P = (s) => q(s, pill);
    const playBtn = P('.pl-play'), disc = P('.pl-disc'), ring = P('.pl-prog'), meta = P('.pl-meta'),
      titleEl = P('.pl-title'), artistEl = P('.pl-artist'), likeBtn = P('.pl-like'), dcBtn = P('.pl-dc');

    // ---- full-screen player --------------------------------------------------
    const mnp = document.createElement('div');
    mnp.id = 'hoq-mnp';
    mnp.setAttribute('role', 'dialog');
    mnp.setAttribute('aria-modal', 'true');
    mnp.setAttribute('aria-label', 'Now playing');
    mnp.setAttribute('aria-hidden', 'true');
    mnp.innerHTML =
      '<div class="mnp-bg"></div><div class="mnp-shade"></div>' +
      '<div class="mnp-in">' +
        '<div class="mnp-top">' +
          '<button class="mnp-x" type="button" aria-label="Close the player">' + IC.down + '</button>' +
          '<div class="mnp-ctx">Now playing</div>' +
          '<button class="mnp-sp" type="button" tabindex="-1" aria-hidden="true">' + IC.down + '</button>' +
        '</div>' +
        '<div class="mnp-art" role="img" aria-label="Cover"></div>' +
        '<div class="mnp-info">' +
          '<div class="mnp-meta">' +
            '<button class="mnp-title" type="button" aria-label="Go to the song"></button>' +
            '<button class="mnp-artist" type="button" aria-label="Go to the artist"></button>' +
          '</div>' +
          '<button class="mnp-like" type="button" aria-label="Like">' + IC.heart + '</button>' +
        '</div>' +
        '<div class="mnp-seek" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0">' +
          '<div class="mnp-rail"><i class="mnp-fill"></i><b class="mnp-knob"></b></div>' +
        '</div>' +
        '<div class="mnp-times"><span class="mnp-cur">0:00</span><span class="mnp-dur">0:00</span></div>' +
        '<div class="mnp-ctrls">' +
          '<button class="mnp-shuf" type="button" aria-label="Shuffle" aria-pressed="false">' + IC.shuffle + '</button>' +
          '<button class="mnp-prev" type="button" aria-label="Previous">' + IC.prev + '</button>' +
          '<button class="mnp-play" type="button" aria-label="Play">' + IC.play + '</button>' +
          '<button class="mnp-next" type="button" aria-label="Next">' + IC.next + '</button>' +
          '<button class="mnp-rep" type="button" aria-label="Repeat: off">' + IC.repeat + '<i>1</i></button>' +
        '</div>' +
        '<div class="mnp-foot">' +
          '<button class="mnp-dc" type="button">' + IC.discord + '<span>Discord</span></button>' +
          '<button class="mnp-share" type="button">' + IC.share + '<span>Share</span></button>' +
          '<button class="mnp-q" type="button">' + IC.queue + '<span>Queue</span></button>' +
        '</div>' +
      '</div>';
    const M = (s) => q(s, mnp);
    const mIn = M('.mnp-in'), mArt = M('.mnp-art'), mBg = M('.mnp-bg'), mTitle = M('.mnp-title'), mArtist = M('.mnp-artist'),
      mLike = M('.mnp-like'), mSeek = M('.mnp-seek'), mFill = M('.mnp-fill'), mKnob = M('.mnp-knob'),
      mCur = M('.mnp-cur'), mDur = M('.mnp-dur'), mPlay = M('.mnp-play'), mShuf = M('.mnp-shuf'), mRep = M('.mnp-rep'),
      mDc = M('.mnp-dc');
    const qdim = document.createElement('div');
    qdim.id = 'hoq-qdim';
    qdim.addEventListener('click', () => { if (queueOpen()) toggleQueue(); });

    const isOpen = () => mnp.classList.contains('on');
    const openSheet = () => {
      if (!H.classList.contains('hoq-pill-on')) return;
      mnp.classList.add('on');
      mnp.setAttribute('aria-hidden', 'false');
      H.classList.add('hoq-mnp-open');
      mIn.scrollTop = 0;
      lastSheetKey = '';
      sync();
    };
    const closeSheet = () => {
      mnp.classList.remove('on');
      mnp.setAttribute('aria-hidden', 'true');
      H.classList.remove('hoq-mnp-open');
    };

    // ---- shared state, painted on a short timer ------------------------------
    let shownPaused = null, baseP = -1, baseT = 0, lastKey = '', lastCover = null, lastSheetKey = '';
    // One play/pause state, painted on both players (each used to keep its own,
    // so pressing play in one left the other showing the wrong icon).
    const paintPlay = (paused) => {
      shownPaused = paused;
      const ic = paused ? IC.play : IC.pause, label = paused ? 'Play' : 'Pause';
      disc.innerHTML = ic;
      playBtn.setAttribute('aria-label', label);
      mPlay.innerHTML = ic;
      mPlay.setAttribute('aria-label', label);
      mnp.classList.toggle('paused', paused);
    };
    const togglePlay = () => {
      if (!press('.playControls__play')) return;
      if (shownPaused !== null) paintPlay(!shownPaused);   // flip at once; the next sync confirms it
    };
    let drag = null, hold = null;   // seek: fraction while dragging; target until the clock catches up
    const glidePos = (pr) => {
      // SoundCloud's clock only reads whole seconds; glide between them.
      if (pr.pos !== baseP) { baseP = pr.pos; baseT = performance.now(); }
      return baseP + (pr.paused ? 0 : Math.min(1, (performance.now() - baseT) / 1000));
    };
    const paintSeek = (frac, pos, dur) => {
      const pc = (Math.max(0, Math.min(1, frac)) * 100).toFixed(2) + '%';
      mFill.style.width = pc;
      mKnob.style.left = pc;
      mCur.textContent = fmt(pos);
      mDur.textContent = fmt(dur);
      mSeek.setAttribute('aria-valuemax', String(Math.round(dur)));
      mSeek.setAttribute('aria-valuenow', String(Math.round(pos)));
      mSeek.setAttribute('aria-valuetext', fmt(pos) + ' of ' + fmt(dur));
    };
    let deadSince = 0;
    const sync = () => {
      try {
        const n = now();
        let live = !!n.title && typeof playerProgress === 'function';
        // Between songs (Next, or one ending) SoundCloud's bar is blank for a
        // moment: that blink closed the full player. Only a bar that stays empty
        // for 3 s counts as nothing playing.
        if (live) deadSince = 0;
        else if (H.classList.contains('hoq-pill-on')) {
          if (!deadSince) deadSince = Date.now();
          if (Date.now() - deadSince < 3000) return;
        }
        H.classList.toggle('hoq-pill-on', live);
        H.classList.toggle('hoq-q-open', live && queueOpen());
        // SoundCloud's own bar on screen instead (the floating player isn't up):
        // the page keeps room for it (mobile.css: hoq-bar-on).
        H.classList.toggle('hoq-bar-on', !live && !!q('.playControls.m-visible'));
        syncTabs();
        if (!live) { if (isOpen()) closeSheet(); return; }
        const pr = prog();
        const key = n.title + '|' + n.artist;
        const cover = safeImg(n.cover);
        if (key !== lastKey) {
          lastKey = key;
          titleEl.textContent = n.title;
          artistEl.textContent = n.artist || '';
          baseP = -1; hold = null;
        }
        if (cover !== lastCover) {   // apart from the title: the cover often loads a moment later
          lastCover = cover;
          disc.style.backgroundImage = cover ? 'url("' + cover + '")' : '';
          disc.classList.toggle('has-art', !!cover);
        }
        if (pr.paused !== shownPaused) paintPlay(pr.paused);
        if (performance.now() > likeHold) {
          const liked = isLiked();
          [likeBtn, mLike].forEach((b) => {
            if (b.classList.contains('on') === liked) return;
            b.classList.toggle('on', liked);
            b.setAttribute('aria-label', liked ? 'Unlike' : 'Like');
          });
        }
        const canDc = !!(document.getElementById('hoq-playbtn') || document.getElementById('hoq-share'));
        dcBtn.hidden = !canDc;
        mDc.hidden = !canDc;
        let pos = glidePos(pr);
        if (hold) {
          if (Math.abs(pr.pos - hold.pos) <= 2 || performance.now() > hold.until) hold = null;
          else pos = hold.pos;
        }
        const frac = pr.dur > 0 ? Math.max(0, Math.min(1, pos / pr.dur)) : 0;
        ring.style.strokeDashoffset = (RING * (1 - frac)).toFixed(2);
        if (!isOpen()) return;
        // ---- the full player ----
        if (key + cover !== lastSheetKey) {
          lastSheetKey = key + cover;
          mTitle.textContent = n.title;
          mArtist.textContent = n.artist || '';
          const art = big(cover);
          mArt.style.backgroundImage = art ? 'url("' + art + '")' : '';
          mBg.style.backgroundImage = art ? 'url("' + art + '")' : '';
        }
        if (drag === null) paintSeek(frac, pos, pr.dur);
        const sh = !!q('.shuffleControl.m-shuffling');
        mShuf.classList.toggle('on', sh);
        mShuf.setAttribute('aria-pressed', String(sh));
        const rc = q('.repeatControl');
        const rep = rc ? (rc.classList.contains('m-one') ? 'one' : rc.classList.contains('m-all') ? 'all' : 'off') : 'off';
        mRep.classList.toggle('on', rep !== 'off');
        mRep.classList.toggle('one', rep === 'one');
        mRep.setAttribute('aria-label', 'Repeat: ' + (rep === 'one' ? 'this song' : rep === 'all' ? 'all' : 'off'));
      } catch (e) {}
    };

    // ---- floating player: wiring ---------------------------------------------
    playBtn.addEventListener('click', togglePlay);
    meta.addEventListener('click', openSheet);
    meta.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSheet(); } });
    P('.pl-prev').addEventListener('click', () => press('.skipControl__previous'));
    P('.pl-next').addEventListener('click', () => press('.skipControl__next'));
    likeBtn.addEventListener('click', () => like(likeBtn));
    dcBtn.addEventListener('click', discordMenu);
    // Swipe the pill: left = next track, right = previous.
    let sx = 0, sy = 0, st = 0;
    pill.addEventListener('touchstart', (e) => { const t = e.touches[0]; sx = t.clientX; sy = t.clientY; st = Date.now(); }, { passive: true });
    pill.addEventListener('touchend', (e) => {
      const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) < 50 || Math.abs(dy) > 40 || Date.now() - st > 700) return;
      const next = dx < 0;
      if (!press(next ? '.skipControl__next' : '.skipControl__previous')) return;
      meta.classList.remove('sw-l', 'sw-r'); void meta.offsetWidth; meta.classList.add(next ? 'sw-l' : 'sw-r');
    }, { passive: true });

    // ---- full player: wiring -------------------------------------------------
    M('.mnp-x').addEventListener('click', closeSheet);
    mPlay.addEventListener('click', togglePlay);
    M('.mnp-prev').addEventListener('click', () => { press('.skipControl__previous'); hold = null; });
    M('.mnp-next').addEventListener('click', () => { press('.skipControl__next'); hold = null; });
    mShuf.addEventListener('click', () => { press('.shuffleControl'); setTimeout(sync, 60); });
    mRep.addEventListener('click', () => { press('.repeatControl'); setTimeout(sync, 60); });
    mLike.addEventListener('click', () => like(mLike));
    mDc.addEventListener('click', discordMenu);
    M('.mnp-share').addEventListener('click', shareSong);
    M('.mnp-q').addEventListener('click', toggleQueue);
    // Title and artist go to their pages, through SoundCloud's own links.
    mTitle.addEventListener('click', () => { closeSheet(); press('.playbackSoundBadge__titleLink'); });
    mArtist.addEventListener('click', () => { closeSheet(); press('.playbackSoundBadge__lightLink') || press('.playbackSoundBadge__usernameLink'); });

    // Seek: drag along the bar; the jump happens when you let go.
    const fracAt = (x) => { const r = mSeek.getBoundingClientRect(); return r.width ? Math.max(0, Math.min(1, (x - r.left) / r.width)) : 0; };
    const showDrag = () => { const d = prog().dur; paintSeek(drag, drag * d, d); };
    const seekTo = (sec) => {
      const d = prog().dur;
      if (!(d > 0) || typeof hoqSeek !== 'function') return;
      sec = Math.max(0, Math.min(d - 1, sec));
      if (hoqSeek(sec)) { hold = { pos: sec, until: performance.now() + 2500 }; baseP = -1; }
    };
    mSeek.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      drag = fracAt(e.clientX);
      mSeek.classList.add('drag');
      try { mSeek.setPointerCapture(e.pointerId); } catch (er) {}
      showDrag();
      e.preventDefault();
    });
    mSeek.addEventListener('pointermove', (e) => { if (drag === null) return; drag = fracAt(e.clientX); showDrag(); });
    const endDrag = (commit) => {
      if (drag === null) return;
      const f = drag;
      drag = null;
      mSeek.classList.remove('drag');
      if (commit) seekTo(f * prog().dur);
      sync();
    };
    mSeek.addEventListener('pointerup', () => endDrag(true));
    mSeek.addEventListener('pointercancel', () => endDrag(false));
    mSeek.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowRight' ? 5 : e.key === 'ArrowLeft' ? -5 : 0;
      if (!step) return;
      e.preventDefault();
      seekTo((hold ? hold.pos : prog().pos) + step);
    });

    // Swipe the full player down to close it.
    let ty0 = 0, tx0 = 0, tdy = 0, tdrag = false;
    mnp.addEventListener('touchstart', (e) => {
      if (e.target.closest('.mnp-seek') || mIn.scrollTop > 0) { tdrag = false; return; }
      const t = e.touches[0];
      ty0 = t.clientY; tx0 = t.clientX; tdy = 0; tdrag = true;
    }, { passive: true });
    mnp.addEventListener('touchmove', (e) => {
      if (!tdrag) return;
      const t = e.touches[0];
      tdy = Math.max(0, t.clientY - ty0);
      if (Math.abs(t.clientX - tx0) > 40 && tdy < 24) { tdrag = false; mnp.style.transition = ''; mnp.style.transform = ''; return; }
      if (tdy > 4) { mnp.style.transition = 'none'; mnp.style.transform = 'translateY(' + tdy + 'px)'; }
    }, { passive: true });
    const endSwipe = () => {
      if (!tdrag) return;
      tdrag = false;
      mnp.style.transition = '';
      if (tdy > 110) {
        // slide on down from where the finger let go, not back up first
        mnp.style.transform = 'translateY(100%)';
        closeSheet();
        setTimeout(() => { if (!isOpen()) mnp.style.transform = ''; }, 380);
      } else {
        mnp.style.transform = '';
      }
    };
    mnp.addEventListener('touchend', endSwipe, { passive: true });
    mnp.addEventListener('touchcancel', endSwipe, { passive: true });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen() && !queueOpen()) closeSheet(); });
    // SoundCloud navigating (a link in the queue, say) closes the full player
    // and the queue sheet, so you land on the page you picked.
    let lastPath = location.pathname;
    const routeCheck = () => {
      if (location.pathname === lastPath) return;
      lastPath = location.pathname;
      if (queueOpen()) toggleQueue();
      if (isOpen()) closeSheet();
      tabKey = '';
      syncTabs();
    };
    window.addEventListener('popstate', () => setTimeout(routeCheck, 0));

    // ---- phone CSS inside SoundCloud's newer-app frames ----------------------
    // Signed in, Home's modules and the track page are SoundCloud's new app in
    // same-origin frames; the theme already styles them (themeFrames), this adds
    // the phone layout (tools/mobile-frame.css).
    // Only while this page is in its phone layout: a media query inside a frame
    // measures the frame, and Home's section frames are under 820px wide on any
    // screen, so the frame rules would land in the desktop layout too. Same
    // query as tools/mobile.css (a phone turned sideways keeps the phone layout).
    const PHONE_MQ = window.matchMedia ? matchMedia('(max-width: 820px), (pointer: coarse) and (max-height: 500px)') : null;
    const styleFrames = () => {
      const phone = !PHONE_MQ || PHONE_MQ.matches;
      document.querySelectorAll('iframe').forEach((f) => {
        let d = null;
        try { d = f.contentDocument; } catch (e) { return; }   // cross-origin: not ours
        if (!d || !d.documentElement) return;
        const had = d.getElementById('hoq-mobile-frame-css');
        if (!phone) { if (had) had.remove(); return; }
        if (had) return;
        try {
          const st = d.createElement('style');
          st.id = 'hoq-mobile-frame-css';
          st.textContent = HOQ_FRAME_CSS;
          (d.head || d.documentElement).appendChild(st);
        } catch (e) {}
      });
    };
    if (PHONE_MQ) try { PHONE_MQ.addEventListener('change', styleFrames); } catch (e) {}

    // ---- <head>: what Safari and a Home Screen web app read ----------------
    // SoundCloud's own say #333 for the browser bars (grey over our near-black),
    // "SoundCloud" for the app's name and an orange splash. Kept asserted: its
    // React rewrites head tags as you move around.
    const HEAD = [
      ['theme-color', '#0d0d10'],                        // Safari's bars match the top bar
      ['color-scheme', 'dark'],
      ['format-detection', 'telephone=no'],              // a long play count isn't a phone number
      ['apple-mobile-web-app-title', 'holdonquietly'],
      ['apple-mobile-web-app-capable', 'yes'],           // older iOS: open from the Home Screen as an app
      ['mobile-web-app-capable', 'yes'],
      ['apple-mobile-web-app-status-bar-style', 'black-translucent'],   // the top bar runs under the clock
    ];
    // The proxy serves the web app's own manifest and icons (proxy/app/).
    const APP = window.__hoqProxyBuild ? '/__hoq/app/' : '';
    const headTags = () => {
      const head = document.head;
      if (!head) return;
      HEAD.forEach(([name, content]) => {
        let m = head.querySelector('meta[name="' + name + '"]');
        if (!m) { m = document.createElement('meta'); m.name = name; head.appendChild(m); }
        if (m.content !== content) m.content = content;
      });
      if (!APP) return;
      const link = (rel, href) => {
        let l = head.querySelector('link[rel="' + rel + '"]');
        if (!l) { l = document.createElement('link'); l.rel = rel; head.appendChild(l); }
        if (l.getAttribute('href') !== href) l.setAttribute('href', href);
        return l;
      };
      const man = link('manifest', APP + 'manifest.webmanifest');
      if (man.hasAttribute('crossorigin')) man.removeAttribute('crossorigin');
      link('apple-touch-icon', APP + 'apple-touch-icon.png');
    };

    // ---- the on-screen keyboard -------------------------------------------
    // iOS keeps the page's size and slides the keyboard over it: --hoq-kb is
    // how much of the bottom it covers, so a sheet with a field can lift.
    const vv = window.visualViewport;
    if (vv) {
      const kb = () => {
        const h = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
        H.style.setProperty('--hoq-kb', (h > 80 ? h : 0) + 'px');   // ignore the toolbar sliding
      };
      vv.addEventListener('resize', kb);
      vv.addEventListener('scroll', kb);
    }

    const mount = () => {
      if (!document.body) { setTimeout(mount, 150); return; }
      headTags();
      document.body.appendChild(tabs);
      document.body.appendChild(pill);
      document.body.appendChild(qdim);
      document.body.appendChild(mnp);
      sync();
      styleFrames();
      let tick = 0;
      setInterval(() => {   // idle while the page is hidden (battery)
        if (document.hidden) return;
        sync();
        routeCheck();
        if (++tick % 4 === 0) { styleFrames(); headTags(); }
      }, 250);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
    };
    mount();
  })();
