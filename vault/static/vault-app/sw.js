/*
 * Service Worker fuer die Approver-PWA.
 * Zweck jetzt: installierbar machen + App-Shell offline cachen.
 * Spaeter: Web Push (iOS 16.4+) fuer "Login-Versuch"-Benachrichtigungen.
 *
 * WICHTIG: KEINE API-Antworten cachen (Freigaben muessen immer live sein).
 */
const CACHE = "vault-approver-v1";
const SHELL = [
  "./phone.html", "./phone.js", "./api.js", "./crypto.js",
  "./vendor/hash-wasm.esm.js", "./manifest.webmanifest", "./icon.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // API immer aus dem Netz — niemals cachen.
  if (url.pathname.startsWith("/api/")) return;
  // App-Shell: Cache-first, sonst Netz.
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
