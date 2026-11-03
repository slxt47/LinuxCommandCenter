// Hell/Dunkel für die slxt-Seiten. Standard: dunkel (seit 03.11.2026 abends). Die Wahl bleibt im Browser (localStorage „modus“).
// Muss im <head> NACH <meta name="theme-color"> und VOR dem Stylesheet-Rendern laden (ohne defer/async),
// damit nichts im falschen Modus aufblitzt. Externe Datei statt Inline-Skript wegen CSP (script-src 'self').
// Schalter: jedes Element mit data-modus-schalter (Klick wechselt; ist es leer, setzt das Skript Symbol + Text).
// Andere Skripte: window.slxtModus.get() → 'hell' | 'dunkel'; Ereignis 'modus' auf window bei jedem Wechsel.
(() => {
  'use strict';
  const d = document.documentElement;
  const FARBE = { hell: '#f4f1fb', dunkel: '#0b0e2a' };
  const SONNE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/></svg>';
  const MOND = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7z"/></svg>';
  let modus = 'dunkel';
  try { if (localStorage.getItem('modus') === 'hell') modus = 'hell'; } catch (e) { /* privat/gesperrt: dunkel */ }

  function schalterAktualisieren() {
    document.querySelectorAll('[data-modus-schalter]').forEach((b) => {
      const ziel = modus === 'dunkel' ? 'Hellen Modus einschalten' : 'Dunklen Modus einschalten';
      b.setAttribute('aria-label', ziel);
      b.setAttribute('title', ziel);
      if (b.dataset.modusSchalter !== 'eigen') b.innerHTML = modus === 'dunkel' ? SONNE : MOND;
    });
  }
  function anwenden() {
    d.dataset.modus = modus;
    d.style.colorScheme = modus === 'dunkel' ? 'dark' : 'light';
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => { m.content = FARBE[modus]; m.removeAttribute('media'); });
    schalterAktualisieren();
  }
  window.slxtModus = {
    get: () => modus,
    setzen(neu) {
      modus = neu === 'dunkel' ? 'dunkel' : 'hell';
      try { localStorage.setItem('modus', modus); } catch (e) { /* egal */ }
      anwenden();
      dispatchEvent(new CustomEvent('modus', { detail: modus }));
    },
    wechseln() { this.setzen(modus === 'dunkel' ? 'hell' : 'dunkel'); },
  };
  anwenden();
  document.addEventListener('DOMContentLoaded', schalterAktualisieren);
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-modus-schalter]');
    if (b) { e.preventDefault(); window.slxtModus.wechseln(); }
  });
  // Andere Tabs derselben Seite ziehen mit
  addEventListener('storage', (e) => { if (e.key === 'modus') { modus = e.newValue === 'dunkel' ? 'dunkel' : 'hell'; anwenden(); dispatchEvent(new CustomEvent('modus', { detail: modus })); } });
})();
