# Zero-Knowledge Vault (Passwort-Manager)

Hochsicherer, Zero-Knowledge Passwort-Manager. Wird später als eigener Tab in das
Linux Command Center Dashboard eingebaut. Der Server speichert **ausschließlich
Ciphertext** — Master-Passwort, Vault-Key & Co. verlassen niemals das Gerät.

## Status

- [x] **Backend-Gerüst** (`vault_backend.py`) — krypto-frei, SQLite, lauffähig + getestet (25/25)
- [x] SQLite-Schema (`schema.sql`)
- [x] Geräte-Approval mit echter Signatur-Verifikation (Ed25519 / ECDSA P-256)
- [x] Notfall-Code mit atomarer Single-Use-Rotation (Versions-Check)
- [x] **Client-Krypto-Modul** (`static/crypto.js`) — Argon2id → VK-Wrap → AES-256-GCM, getestet (15/15)
- [x] **Cross-Language-Nachweis**: JS-Signatur verifiziert in Python (`test/test_xlang.py`)
- [x] **Vault-UI** (`static/index.html` + `app.js` + `api.js`) — Onboarding, Login mit
  Freigabe-Polling, Tresor-CRUD, Passwort-Generator, Auto-Lock. hash-wasm vendored (offline)
- [x] **Browser-E2E** (`static/selftest.html`) — voller Flow in echtem Chrome, 11/11
- [x] **iPhone-PWA** (`static/phone.html` + `phone.js` + `manifest`/`sw`/`icon`) —
  Kopplung per Code, persistenter Device-Key (IndexedDB, non-extractable),
  Approval-Polling, Approve/Deny mit Signatur. Kopplungs-Flow browser-E2E getestet (9/9)
- [ ] Push statt Polling: „Login-Versuch" via vorhandenen ntfy-Server (ntfy.jokerdev.tech)
- [x] **LIVE deployed** als eigener unprivilegierter Dienst + Dashboard-Tab (iframe, strenge CSP)

## Deployment (produktiv, 2026-07-22)

Läuft als **eigener unprivilegierter systemd-Dienst** (nicht im privilegierten Dashboard-Container):

- **Dienst:** `vault.service` → `python3 /opt/vault-manager/vault_backend.py --db /var/lib/vault/vault.db --port 8099 --host 127.0.0.1` (User `vault`, gehärtet: ProtectSystem=strict, NoNewPrivileges, CapabilityBoundingSet leer)
- **Runtime:** `/opt/vault-manager/` (Web-Dateien unter `static/vault-app/`, ohne Selbsttests) — Quelle bleibt `/home/jokergame/vault-manager/`
- **Daten:** `/var/lib/vault/vault.db` (nur Ciphertext, 0700, owner `vault`)
- **nginx:** `home.jokerdev.tech` → `location /vault-app/` + `/api/vault/` proxyen auf `127.0.0.1:8099` (Backup: `cockpit.bak-vault-*`)
- **Dashboard-Tab:** Nav-Button `nav-btn-vault` + `page-vault` (iframe `/vault-app/index.html`) in `static/index.html` (Host-Quelle aktualisiert + live via `docker cp` in den Container; `server.py` unverändert)
- **URLs:** UI `https://home.jokerdev.tech/vault-app/index.html`, iPhone `…/vault-app/phone.html`

### Sicherheit / offener Punkt: echte Origin-Isolation
Aktuell teilt sich der Vault den Origin `home.jokerdev.tech` mit dem Admin-Panel → ein XSS im
Panel könnte per Same-Origin auf das iframe zugreifen. **Prozess-Isolation ist erreicht**
(eigener unprivilegierter Dienst), **Origin-Isolation noch nicht.** Upgrade: Subdomain
`vault.jokerdev.tech` (1 Cloudflare-DNS-Record + eigener nginx `server`-Block auf `:8099`),
dann iframe-`src` + CSP `frame-ancestors` darauf umstellen.

## UI lokal ansehen (Entwicklung)

## UI lokal ansehen

```bash
python3 vault_backend.py --db /tmp/vault.db --port 8099
# Browser: http://127.0.0.1:8099/index.html   (UI)
#          http://127.0.0.1:8099/selftest.html (Browser-E2E-Test)
```

## Architektur (Kurzfassung)

**Authentifizierung ≠ Verschlüsselung.** Der Server entscheidet nur *ob* eingeloggt
werden darf; den Schlüssel zum Entschlüsseln sieht er nie.

- **1. Faktor (Wissen):** Master-Passwort → `Argon2id` → Master-Key → HKDF → SEK + auth_proof.
  Der Server prüft nur `scrypt(auth_proof)` (Zugriffs-Gate), sieht das Passwort nie.
- **2. Faktor (Besitz):** iPhone als gerätegebundener Signatur-Schlüssel. Kein Face ID,
  kein Bluetooth, kein WebAuthn-QR. Out-of-Band Challenge-Response, Zustellung per
  PWA-Polling über Tailscale.
- **Datenschlüssel:** zufälliger Vault-Key (VK), mit SEK gewrappt → `protected_vault_key`.
  Einträge einzeln AES-256-GCM (96-bit Zufalls-Nonce, AAD = Item-UUID).
- **Notfall-Code:** 24-stellig, ist ein zweiter gewrappter VK. Single-Use via
  Versions-Check; bei Nutzung wird atomar ein neuer Code aktiviert.

Vollständige Spezifikation: Krypto-Contract siehe Projektgedächtnis / Konzeptdokument.

## Projektstruktur

```
vault-manager/
├── schema.sql          SQLite-Schema (nur Ciphertext + öffentliche Parameter)
├── vault_backend.py    Backend: Blob-Speicher + Auth-Gate + Signatur-Prüfung
│                       (importierbar in server.py ODER Standalone-Dev-Server)
├── static/             (folgt) Vault-UI + Client-Krypto
└── test/
    └── test_backend.py End-to-End-Test (simuliert Client + iPhone)
```

## Entwickeln & Testen

```bash
# Tests (kein HTTP nötig, simuliert echten Ed25519-Geräteschlüssel)
python3 test/test_backend.py

# Standalone-Dev-Server (nur zum Ausprobieren; im Dashboard entfällt das)
python3 vault_backend.py --db /tmp/vault.db --port 8099
```

## Dashboard-Integration (geplant)

`server.py` importiert `VaultBackend` und leitet die `/api/vault/*`-Pfade in
`do_GET`/`do_POST`/`do_DELETE` an `backend.handle(method, path, body, ctx)` weiter.
`ctx` liefert `ip`, `user_agent`, `iso_time`, `session_token` (Bearer) und
`device_token` (Header `X-Device-Token`). DB unter `/var/lib/linux-dashboard/vault.db`.

**Voraussetzung im Container:** `cryptography` (für Signatur-Prüfung) muss installiert
sein — im Dashboard-Image via `pip install cryptography` ergänzen, falls nicht vorhanden.

## Sicherheits-Hinweise

- **Eigenes Vault-Master-Passwort** — niemals identisch zum Linux-/Dashboard-Login.
- Läuft im selben Origin wie ein privilegiertes Admin-Panel → **XSS ist das größte
  Restrisiko**. Vault-UI in isoliertes iframe + strenge CSP (folgt).
- `vault.db` enthält nur Ciphertext, ist aber restriktiv zu halten (0600).
- Kein „Passwort vergessen" — nur der 24-stellige Notfall-Code stellt den Zugang wieder her.

## Endpunkte (Backend)

| Methode | Pfad | Zweck |
|---|---|---|
| POST | `/api/vault/account/setup` | Konto anlegen, liefert Bootstrap-Session |
| POST | `/api/vault/auth/start` | Login Schritt 1: Salt/Params + Freigabe anfordern |
| POST | `/api/vault/auth/finish` | Login Schritt 2: auth_proof + Freigabe → Session |
| GET | `/api/vault/bundle` | verschlüsselten Tresor laden (nur Ciphertext) |
| POST | `/api/vault/item` | Eintrag anlegen/aktualisieren (Upsert) |
| DELETE | `/api/vault/item/{id}` | Eintrag löschen |
| POST | `/api/vault/device/register/start` | Geräte-Registrierung: Challenge |
| POST | `/api/vault/device/register/finish` | Geräte-Registrierung: Public-Key + Signatur |
| GET | `/api/vault/approval/pending` | iPhone: offene Freigaben (Polling) |
| POST | `/api/vault/approval/{id}` | iPhone: Freigabe erteilen/ablehnen (signiert) |
| POST | `/api/vault/recovery/start` | Notfall: Recovery-Blob + Salt laden |
| POST | `/api/vault/recovery/rotate` | Notfall: neues Master-PW + Code atomar setzen |
