// Hell/Dunkel für die slxt-Seiten. Standard: dunkel (seit 03.11.2026 abends). Die Wahl bleibt im Browser (localStorage „modus“).
// Muss im <head> NACH <meta name="theme-color"> und VOR dem Stylesheet-Rendern laden (ohne defer/async),
// damit nichts im falschen Modus aufblitzt. Externe Datei statt Inline-Skript wegen CSP (script-src 'self').
// Schalter: jedes Element mit data-modus-schalter (Klick wechselt; ist es leer, setzt das Skript Symbol + Text).
// Andere Skripte: window.slxtModus.get() → 'hell' | 'dunkel'; Ereignis 'modus' auf window bei jedem Wechsel.
// Seit 05.11.2026: Schalter blendet die Seite in 1,2 s über (slxtModus.sanft()).
// QUELLE: ~/bin/modus/quelle.js – nicht hier ändern, sondern dort und dann ~/bin/modus/verteilen.py ausführen.
(() => {
  'use strict';
  const d = document.documentElement;
  const FARBE = { hell: '#f4f1fb', dunkel: '#0b0e2a' };
  const SONNE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/></svg>';
  const MOND = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7z"/></svg>';
  let modus = 'dunkel';
  try { if (localStorage.getItem('modus') === 'hell') modus = 'hell'; } catch (e) { /* privat/gesperrt: dunkel */ }
  // Seit 10.11.2026: eingebettet im Linux Command Center (iframe-Sandbox, kein eigener Speicher). Dann kommt der Modus
  // aus ?modus= und per Nachricht vom Elternfenster, und der eigene Schalter ist ausgeblendet (das CC schaltet).
  const eingebettet = window.parent !== window;
  try { const q = new URLSearchParams(location.search).get('modus'); if (q === 'hell' || q === 'dunkel') modus = q; } catch (e) { /* egal */ }

  function schalterAktualisieren() {
    document.querySelectorAll('[data-modus-schalter]').forEach((b) => {
      const en = /^en/i.test(d.lang); const ziel = modus === 'dunkel' ? (en ? 'Switch to light mode' : 'Hellen Modus einschalten') : (en ? 'Switch to dark mode' : 'Dunklen Modus einschalten');
      b.setAttribute('aria-label', ziel);
      b.setAttribute('title', ziel);
      if (b.dataset.modusSchalter !== 'eigen') b.innerHTML = modus === 'dunkel' ? SONNE : MOND;
      if (eingebettet) b.hidden = true;
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
  // Wechsel per Schalter: die ganze Seite blendet langsam (1,2 s) in den anderen Modus über (View Transitions,
  // Crossfade aus zwei Momentaufnahmen auf der GPU). Währenddessen sind Dauer-Animationen und Übergänge angehalten
  // (Klasse „modus-wechsel“ am <html>), damit nichts ruckelt. Ohne Unterstützung / „Bewegung reduzieren“: sofort.
  const ruhig = matchMedia('(prefers-reduced-motion: reduce)');
  if (document.startViewTransition) {
    const css = '::view-transition-group(root){animation-duration:1.2s}' +
      '::view-transition-old(root),::view-transition-new(root){animation-duration:1.2s;animation-timing-function:cubic-bezier(.4,0,.2,1)}' +
      '.modus-wechsel *,.modus-wechsel *::before,.modus-wechsel *::after{transition:none!important;animation-play-state:paused!important}';
    try { const s = new CSSStyleSheet(); s.replaceSync(css); document.adoptedStyleSheets = [...document.adoptedStyleSheets, s]; }
    catch (e) { const st = document.createElement('style'); st.textContent = css; document.head.append(st); }
  }
  // Doppelklick: die zweite Transition bricht die erste ab – die Pause-Klasse erst entfernen, wenn die LETZTE fertig ist
  let laufend = null;
  function sanftWechseln() {
    if (!document.startViewTransition || ruhig.matches) { window.slxtModus.wechseln(); return; }
    d.classList.add('modus-wechsel');
    const vt = document.startViewTransition(() => window.slxtModus.wechseln());
    laufend = vt;
    vt.finished.catch(() => {}).finally(() => {
      if (laufend !== vt) return;
      laufend = null;
      requestAnimationFrame(() => { if (!laufend) d.classList.remove('modus-wechsel'); });
    });
  }
  window.slxtModus.sanft = sanftWechseln;
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-modus-schalter]');
    if (b) { e.preventDefault(); sanftWechseln(); }
  });
  if (eingebettet) {
    addEventListener('message', (e) => {
      const m = e.source === window.parent && e.data && e.data.slxtModus;
      if (m === 'hell' || m === 'dunkel') { modus = m; anwenden(); dispatchEvent(new CustomEvent('modus', { detail: modus })); }
    });
  }
  // Andere Tabs derselben Seite ziehen mit
  addEventListener('storage', (e) => { if (e.key === 'modus') { modus = e.newValue === 'dunkel' ? 'dunkel' : 'hell'; anwenden(); dispatchEvent(new CustomEvent('modus', { detail: modus })); } });
})();
