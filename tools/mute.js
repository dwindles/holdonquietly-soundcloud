(() => {
  const out = { docs: 0, media: 0, paused: 0 };
  const hit = (d) => {
    if (!d) return;
    out.docs++;
    d.querySelectorAll('audio,video').forEach((m) => {
      out.media++;
      try { if (!m.paused) { m.pause(); out.paused++; } } catch (e) {}
      try { m.muted = true; m.volume = 0; } catch (e) {}
    });
  };
  hit(document);
  document.querySelectorAll('iframe').forEach((f) => { try { hit(f.contentDocument); } catch (e) {} });
  // app's own volume hook + SoundCloud's UI volume
  try { if (window.__scSetVolume) window.__scSetVolume(0); } catch (e) {}
  // keep anything that mounts later muted too
  if (!window.__hoqMuteGuard) {
    window.__hoqMuteGuard = setInterval(() => {
      const mute = (d) => { try { d.querySelectorAll('audio,video').forEach((m) => { m.muted = true; m.volume = 0; if (!m.paused) m.pause(); }); } catch (e) {} };
      mute(document);
      document.querySelectorAll('iframe').forEach((f) => { try { if (f.contentDocument) mute(f.contentDocument); } catch (e) {} });
    }, 700);
  }
  return JSON.stringify(out);
})()
