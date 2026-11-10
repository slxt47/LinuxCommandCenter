// Login-Seite: Direktlink-Ziel (#konten/hetzner …) über die Anmeldung retten; app.js öffnet danach den Reiter.
try { if (/^#[a-z]+(\/[a-z]+)?$/.test(location.hash)) sessionStorage.setItem('cc-ziel', location.hash); } catch (e) { /* egal */ }
