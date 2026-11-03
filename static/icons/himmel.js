// Sternenhimmel und Sternschnuppen wie auf slxt.org (Sterne nur im dunklen Modus; ohne Bewegung bei "Bewegung reduzieren"). Liegt unter /icons/, weil die Login-Seite ihn ohne Anmeldung braucht.
(() => {
  'use strict';
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const himmel = document.createElement('div');
  himmel.className = 'himmel'; himmel.setAttribute('aria-hidden', 'true');
  himmel.innerHTML = '<canvas></canvas><div class="sternschnuppen"></div>';
  document.body.prepend(himmel);
  const cv = himmel.querySelector('canvas'), ctx = cv.getContext('2d'), box = himmel.lastChild;
  function sterne() {
    const dpr = Math.min(2, devicePixelRatio || 1), w = innerWidth, h = innerHeight;
    cv.width = w * dpr; cv.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    for (let i = 0, n = Math.round(w * h / 5200); i < n; i++) {
      ctx.globalAlpha = 0.25 + Math.random() * 0.65;
      ctx.fillStyle = Math.random() < 0.15 ? '#cdd8ff' : '#ffffff';
      ctx.beginPath(); ctx.arc(Math.random() * w, Math.random() * h * 0.92, Math.random() < 0.08 ? 1.3 : Math.random() * 0.8 + 0.3, 0, Math.PI * 2); ctx.fill();
    }
  }
  sterne();
  let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(sterne, 200); });
  function meteor() {
    if (reduce) return;
    const W = innerWidth, H = innerHeight, len = 80 + Math.random() * 150, dir = Math.random() < 0.5 ? 1 : -1;
    const ang = (14 + Math.random() * 26) * Math.PI / 180, dist = Math.max(W, H) * (0.22 + Math.random() * 0.25);
    const x0 = dir > 0 ? Math.random() * W * 0.65 : W * 0.35 + Math.random() * W * 0.65, y0 = Math.random() * H * 0.42;
    const x1 = x0 + dir * Math.cos(ang) * dist, y1 = y0 + Math.sin(ang) * dist, deg = Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI;
    const el = document.createElement('i'); el.className = 'meteor'; el.style.width = `${len}px`; box.append(el);
    const at = (x, y, s) => `translate(${x - len}px, ${y - 1}px) rotate(${deg}deg) scaleX(${s})`;
    const a = el.animate([{ transform: at(x0, y0, 0.3), opacity: 0 }, { opacity: 1, offset: 0.12 }, { opacity: 0.9, offset: 0.65 }, { transform: at(x1, y1, 1), opacity: 0 }],
      { duration: 650 + Math.random() * 700, easing: 'cubic-bezier(.3, .55, .55, 1)' });
    a.onfinish = a.oncancel = () => el.remove();
  }
  (function plan(erst) {
    setTimeout(() => { if (!document.hidden) meteor(); plan(false); }, erst ? 2000 + Math.random() * 3000 : 5000 + Math.random() * 10000);
  })(true);
})();
