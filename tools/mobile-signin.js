  // ---- signed out: sign in on the phone (proxy only) -------------------
  // SoundCloud's own Sign in can't finish through the proxy (hoq-anon hides it),
  // so the desktop app hands its session over (Social/Settings -> Settings ->
  // Phone). Its code is scanned right here, with this page's own camera: the
  // iPhone camera app opens Safari, which is not where a Home Screen web app
  // keeps its sign-in, so that needed a new tab or a pasted link. Shown only
  // while signed out (CSS: html.hoq-anon). Styles: tools/mobile.css.
  // tools/build-userscript.js puts this inside the mobile shim (H in scope).
  if (window.__hoqProxyBuild) (() => {
    let cta = null, sheet = null, scan = null;
    // A full load, so the redeem block at the top of preload runs (a hash-only
    // change wouldn't reload the page).
    const signInWith = (hash) => {
      location.href = location.origin + (location.pathname === '/discover' ? '/' : '/discover') + hash;
    };
    // What a code or a pasted link can be: the QR's link, which carries the
    // login after #hoq-login=, or a one-time /__hoq/pair/<id> link.
    const parse = (v) => {
      v = String(v || '').trim();
      const at = v.indexOf('#hoq-login=');
      if (at >= 0 && /^#hoq-login=[A-Za-z0-9_-]{16,}$/.test(v.slice(at))) return { hash: v.slice(at) };
      const m = v.match(/\/__hoq\/pair\/([A-Za-z0-9_-]{16,64})(?:[?#]|$)/) || v.match(/^([A-Za-z0-9_-]{16,64})$/);
      return m ? { id: m[1] } : null;
    };
    // Returns a promise that only settles on failure (success leaves the page).
    const redeem = (p) => {
      if (p.hash) { signInWith(p.hash); return new Promise(() => {}); }
      return fetch('/__hoq/pair/' + p.id, { method: 'POST' })
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((d) => { signInWith('#hoq-login=' + d.frag); return new Promise(() => {}); });
    };
    const failText = (s) => (s === 410
      ? 'That link was already used or has expired. Make a new one on your PC.'
      : 'Couldn’t sign in. Check your connection and try again.');

    // ---- no PC (for now): carry a soundcloud.com sign-in over -------------
    // Until there's a direct way in, a phone with no PC signs in on soundcloud.com
    // itself and runs this bookmark there. It reads SoundCloud's two login
    // cookies (neither is HttpOnly) and opens this site with them after
    // #hoq-login=, the same hand-over the PC code's long link does; the redeem
    // block at the top of preload sets them, year-long. SoundCloud's mobile site
    // (m.soundcloud.com, where an iPhone is sent) keeps its login out of reach,
    // so it asks for the desktop site there.
    // Built from a function so it needs no escaping. Inside it: no comments (the
    // lines get joined), no '%' (a javascript: URL is percent-decoded first) and
    // no '#' (char 35 instead, so nothing reads it as the URL's fragment).
    const handOver = function () {
      var h = location.hostname;
      var g = function (n) { var m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')); return m ? m[1] : ''; };
      if (!/(^|\.)soundcloud\.com$/.test(h)) { alert('Open soundcloud.com first and sign in there, then tap this bookmark again.'); return; }
      var o = g('oauth_token');
      if (!o) {
        alert(h.indexOf('m.') === 0
          ? 'This is SoundCloud\'s mobile site. Switch to the desktop site first: open the page menu in the address bar (aA) and tap Request Desktop Website. Sign in if it asks, then tap this bookmark again.'
          : 'You\'re not signed in on soundcloud.com yet. Sign in there, then tap this bookmark again.');
        return;
      }
      var b = btoa(JSON.stringify({ o: o, s: g('sc_session') })).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
      location.href = 'https://sc.holdonquietly.com/discover' + String.fromCharCode(35) + 'hoq-login=' + b;
    };
    const BOOKMARK = 'javascript:(' + String(handOver).replace(/\s*[\r\n]+\s*/g, ' ') + ')();';
    window.__hoqHandOverBookmark = BOOKMARK;   // for tests and the guide
    // Copy, or failing that select it in a box to copy by hand.
    const copyText = (text, box, onDone) => {
      const manual = () => { box.hidden = false; box.value = text; box.focus(); box.select(); box.setSelectionRange(0, text.length); onDone(false); };
      try { navigator.clipboard.writeText(text).then(() => onDone(true), manual); } catch (e) { manual(); }
    };
    const standalone = () => !!(navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches));
    const NOPC_HTML =
      '<details class="sh-nopc">' +
        '<summary>No PC? Sign in on soundcloud.com instead</summary>' +
        '<p class="sh-note">A stand-in until there&rsquo;s a direct way to sign in here. You set up a bookmark once, then sign in on SoundCloud&rsquo;s own site and the bookmark brings you back here signed in. Your password only ever goes into soundcloud.com. Do these steps in <b>Safari</b>.</p>' +
        '<p class="sh-app-note">You&rsquo;re in the Home Screen app, which keeps its own sign-in, separate from Safari&rsquo;s. Do steps 1 to 7 in Safari, then step 8 brings the sign-in into this app.</p>' +
        '<h4>Set up the bookmark (once)</h4>' +
        '<ol>' +
          '<li>Tap <span class="sh-k">Copy the bookmark</span> below. It copies a short piece of code.' +
            '<button class="sh-copybm" type="button">Copy the bookmark</button>' +
            '<textarea class="sh-bmcode" readonly hidden rows="3" aria-label="Bookmark code"></textarea>' +
            '<div class="sh-bmmsg" aria-live="polite"></div></li>' +
          '<li>Bookmark any page: tap the <b>Share</b> button (the square with an arrow), then <b>Add Bookmark</b>. Name it <b>hoq sign-in</b> and tap <b>Save</b>.</li>' +
          '<li>Open your bookmarks (the <b>book</b> icon), tap <b>Edit</b>, then tap <b>hoq sign-in</b>. Clear the address under the name (the &#9447; button), paste the code there, and tap <b>Done</b>.</li>' +
        '</ol>' +
        '<h4>Sign in</h4>' +
        '<ol style="counter-reset: s 3">' +
          '<li>Go to <b>soundcloud.com</b> in Safari.</li>' +
          '<li>Open the page menu in the address bar (<b>aA</b>) and tap <b>Request Desktop Website</b>. SoundCloud&rsquo;s mobile site hides its sign-in from the bookmark.</li>' +
          '<li>Sign in to SoundCloud there, the normal way.</li>' +
          '<li>Still on soundcloud.com, tap the address bar, type <b>hoq sign-in</b> and tap the bookmark when it shows up. (Tapping it in your bookmarks works too.) You&rsquo;re brought back here, signed in.</li>' +
          '<li><b>Home Screen app only:</b> in Safari, signed in here, open <b>Social</b> &rarr; <b>Settings</b> &rarr; <b>Home Screen app</b> and tap <b>Copy link</b>. Then open the app, tap <b>Sign in</b> and paste the link into the box above. It works once, within 10 minutes.</li>' +
        '</ol>' +
        '<p class="sh-note">Afterwards you can turn <b>Request Desktop Website</b> back off for soundcloud.com. You only need the bookmark again if you&rsquo;re ever signed out.</p>' +
      '</details>';
    const setupNoPc = (root) => {
      root.querySelector('.sh-app-note').hidden = !standalone();
      const btn = root.querySelector('.sh-copybm'), box = root.querySelector('.sh-bmcode'), msg = root.querySelector('.sh-bmmsg');
      btn.addEventListener('click', () => {
        copyText(BOOKMARK, box, (ok) => {
          msg.textContent = ok ? 'Copied. Now do step 2.' : 'Copy the code in the box (tap it, Select All, Copy), then do step 2.';
        });
      });
    };

    // ---- the QR scanner -----------------------------------------------------
    // iOS has no BarcodeDetector (Safari keeps it switched off), so the decoder
    // is jsQR, fetched only when you open the scanner, pinned by its hash.
    const JSQR = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
    const JSQR_SRI = 'sha384-b5Ya4Bq3qCyz39m2ISh+4DxjAIljdeFwK/BsXLuj9gugaNwAcj/ia15fxNZL9Nlx';
    let jsqrP = null;
    const loadJsQR = () => jsqrP || (jsqrP = new Promise((res, rej) => {
      if (typeof window.jsQR === 'function') { res(window.jsQR); return; }
      // It registers as an AMD module if the page has a define(): hide that
      // while it loads, so it lands on window.jsQR.
      const amd = window.define;
      if (amd && amd.amd) window.define = undefined;
      const s = document.createElement('script');
      s.src = JSQR; s.integrity = JSQR_SRI; s.crossOrigin = 'anonymous'; s.async = true;
      const done = () => { if (amd && amd.amd) window.define = amd; };
      s.onload = () => { done(); typeof window.jsQR === 'function' ? res(window.jsQR) : rej(new Error('no decoder')); };
      s.onerror = () => { done(); jsqrP = null; rej(new Error('decoder failed to load')); };
      document.head.appendChild(s);
    }));
    let detector = null;   // the native one, where there is one (Android Chrome)
    try {
      if ('BarcodeDetector' in window) {
        window.BarcodeDetector.getSupportedFormats()
          .then((f) => { if (f.indexOf('qr_code') >= 0) detector = new window.BarcodeDetector({ formats: ['qr_code'] }); })
          .catch(() => {});
      }
    } catch (e) {}

    const CAM = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.6l1.2-1.8c.3-.4.7-.7 1.2-.7h3c.5 0 .9.3 1.2.7L15.9 6h1.6A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z"/><circle cx="12" cy="12.4" r="3.4"/></svg>';
    const closeScan = () => {
      if (!scan) return;
      scan.open = false;
      clearTimeout(scan.timer);
      if (scan.stream) scan.stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
      scan.stream = null;
      try { scan.video.srcObject = null; } catch (e) {}
      scan.el.hidden = true;
    };
    const openScan = () => {
      if (scan && scan.open) return;   // a quick second tap: one camera, not two
      if (!scan) {
        const el = document.createElement('div');
        el.id = 'hoq-scan';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'true');
        el.setAttribute('aria-label', 'Scan the sign-in code');
        el.innerHTML =
          '<video playsinline muted autoplay></video>' +
          '<div class="sc-frame" aria-hidden="true"><i></i><i></i><i></i><i></i></div>' +
          '<div class="sc-top"><b>Scan the code on your PC</b>' +
            '<span>holdonquietly on your PC &rarr; Social/Settings &rarr; Settings &rarr; Phone &rarr; Show code</span></div>' +
          '<div class="sc-bottom"><div class="sc-msg" aria-live="polite">Starting the camera…</div>' +
            '<button class="sc-cancel" type="button">Cancel</button></div>';
        document.body.appendChild(el);
        scan = { el, video: el.querySelector('video'), msg: el.querySelector('.sc-msg'), stream: null, timer: 0, open: false };
        scan.video.muted = true;   // iOS: a playsinline, muted video can start without a tap
        el.querySelector('.sc-cancel').addEventListener('click', closeScan);
        // A camera left running in the background would keep the green dot on.
        document.addEventListener('visibilitychange', () => { if (document.hidden) closeScan(); });
        window.addEventListener('pagehide', closeScan);
      }
      const say = (t) => { scan.msg.textContent = t; };
      scan.el.hidden = false;
      scan.open = true;
      say('Starting the camera…');
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        say('This browser can’t use the camera here. Paste the link instead.');
        return;
      }
      loadJsQR().catch(() => {});   // fetch the decoder while the camera starts
      navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      }).then((stream) => {
        if (!scan.open) { stream.getTracks().forEach((t) => t.stop()); return; }
        scan.stream = stream;
        scan.video.srcObject = stream;
        const p = scan.video.play();
        if (p && p.catch) p.catch(() => {});
        say('Point it at the code.');
        loop();
      }).catch((err) => {
        const n = err && err.name;
        say(n === 'NotAllowedError' || n === 'SecurityError'
          ? 'Camera access is off for this site. Allow it in Settings (Safari → Camera, or this app’s own settings), or paste the link.'
          : n === 'NotFoundError' || n === 'OverconstrainedError'
            ? 'No camera found. Paste the link instead.'
            : 'Couldn’t start the camera. Paste the link instead.');
      });
    };
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let wrongAt = 0;
    const found = (text) => {
      const p = parse(text);
      if (!p) {
        // Some other QR code: say so, keep looking.
        if (Date.now() - wrongAt > 2500) { wrongAt = Date.now(); scan.msg.textContent = 'That’s not a holdonquietly sign-in code.'; }
        return false;
      }
      closeScan();
      if (sheet) { sheet.querySelector('.sh-msg').textContent = 'Signing you in…'; }
      redeem(p).catch((s) => { if (sheet) sheet.querySelector('.sh-msg').textContent = failText(s); });
      return true;
    };
    const loop = () => {
      if (!scan || !scan.open) return;
      const v = scan.video;
      const next = () => { if (scan && scan.open) scan.timer = setTimeout(loop, 140); };
      if (v.readyState < 2 || !v.videoWidth) { next(); return; }
      const read = detector
        ? detector.detect(v).then((r) => (r && r[0] && r[0].rawValue) || '')
        : loadJsQR().then((jsQR) => {
          // The middle square of the frame (where the guide is), at most 960px
          // a side: the code is dense (the login is in it), so not much less.
          const vw = v.videoWidth, vh = v.videoHeight, side = Math.min(vw, vh), size = Math.min(side, 960);
          canvas.width = canvas.height = size;
          ctx.drawImage(v, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, size, size);
          const code = jsQR(ctx.getImageData(0, 0, size, size).data, size, size, { inversionAttempts: 'dontInvert' });
          return (code && code.data) || '';
        });
      read.then((text) => { if (!(text && found(text))) next(); })
        .catch(() => {
          // The native detector failing: carry on with jsQR instead.
          if (detector) { detector = null; next(); return; }
          scan.msg.textContent = 'Couldn’t load the code reader. Check your connection, or paste the link.';
        });
    };

    // ---- the "Sign in" sheet ------------------------------------------------
    const buildSheet = () => {
      sheet = document.createElement('div');
      sheet.id = 'hoq-signin-sheet';
      sheet.hidden = true;
      sheet.innerHTML =
        '<div class="sh" role="dialog" aria-modal="true" aria-label="Sign in">' +
          '<h3>Sign in</h3>' +
          '<p class="sh-sub">SoundCloud blocks signing in through this site, so the holdonquietly app on your PC signs you in. No PC? See the end of this sheet.</p>' +
          '<button class="sh-scan" type="button">' + CAM + 'Scan the code</button>' +
          '<ol>' +
            '<li>On your PC, open <b>holdonquietly</b> (signed in to SoundCloud).</li>' +
            '<li>Go to <b>Social/Settings</b> &rarr; <b>Settings</b> &rarr; <b>Phone</b> and tap <b>Show code</b>.</li>' +
            '<li>Tap <b>Scan the code</b> above and point your phone at it. That&rsquo;s it, right here.</li>' +
          '</ol>' +
          '<div class="sh-paste">' +
            '<p>No camera? On your PC tap <span class="sh-k">Copy link</span>, send it to yourself and paste it here. A link works once, within 10 minutes.</p>' +
            '<div class="sh-row">' +
              '<input type="url" inputmode="url" enterkeyhint="go" placeholder="Paste your sign-in link" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">' +
              '<button class="sh-go" type="button">Sign in</button>' +
            '</div>' +
            '<div class="sh-msg" aria-live="polite"></div>' +
          '</div>' +
          NOPC_HTML +
          '<button class="sh-close" type="button">Close</button>' +
        '</div>';
      document.body.appendChild(sheet);
      setupNoPc(sheet);
      const input = sheet.querySelector('input'), msg = sheet.querySelector('.sh-msg'), go = sheet.querySelector('.sh-go');
      sheet.addEventListener('click', (e) => { if (e.target === sheet || e.target.closest('.sh-close')) sheet.hidden = true; });
      sheet.querySelector('.sh-scan').addEventListener('click', openScan);
      const pasted = () => {
        msg.textContent = '';
        const p = parse(input.value);
        if (!p) { msg.textContent = 'That doesn’t look like a sign-in link. Copy it again from the app on your PC.'; return; }
        go.disabled = true; go.textContent = 'Signing in…';
        redeem(p).catch((s) => { go.disabled = false; go.textContent = 'Sign in'; msg.textContent = failText(s); });
      };
      go.addEventListener('click', pasted);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') pasted(); });
    };
    const ensureCta = () => {
      if (cta && cta.isConnected) return;
      if (!document.body) return;
      if (!cta) {
        cta = document.createElement('div');
        cta.id = 'hoq-signin-cta';
        cta.innerHTML = '<div class="cta-txt"><b>You’re not signed in</b>Scan the code from the app on your PC, or sign in on soundcloud.com.</div>' +
          '<button type="button">Sign in</button>';
        cta.querySelector('button').addEventListener('click', () => {
          if (!sheet) buildSheet();
          sheet.hidden = false;
        });
      }
      const hdr = document.querySelector('header.header, .header');
      if (hdr && hdr.parentNode) hdr.insertAdjacentElement('afterend', cta);
      else document.body.insertBefore(cta, document.body.firstChild);
    };
    ensureCta();
    setInterval(() => { if (!document.hidden) ensureCta(); }, 1200);
  })();
