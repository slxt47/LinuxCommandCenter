# Changelog

## 2.2.0 – 2026-11-10

**Neuer Reiter „Startseite“** (nur Superadmins, in den Einstellungen ausblendbar)
- Zeigt alle Gruppen und Kacheln des eigenen Dashboards (dash.slxt.dev) mit Icons, Sichtbarkeit und Online-Status, mit Suche.
- Der Server holt die Daten über `GET /api/startseite` vom Startseiten-Container (`http://127.0.0.1:9310/api/intern/start`, Admin-Sicht, nur lesend, 30 s Zwischenspeicher). Der Browser spricht nie direkt mit der Startseite; dash.slxt.dev bleibt unverändert.
- Token in `/data/startseite-token` (0600), Adresse änderbar über `STARTSEITE_INTERN_URL`. Ohne Token zeigt der Reiter einen Hinweis.
- Icons kommen eingebettet (Font-Awesome-Pfade bzw. `data:`-Bilder) und werden nur als Attribut/Text gesetzt, nie als HTML.

## 2.1.2 – 2026-11-09

Übernimmt die Änderungen aus 2.0.1 (unten) in das neue Design: Entsperren mehrerer IPs, Browser-Sessions nur auf `127.0.0.1`, ARM64. Favicon und Login-Seite kommen aus 2.1.x.

## 2.1.1 – 2026-11-03

**Als App auf dem Home-Bildschirm (iOS/Android)**
- Manifest: Name „Command Center“, helle Farben (Standard hell), eigenes maskierbares Symbol (`icons/icon-maskable-512.png`, Inhalt in der sicheren Zone) für Android.
- Anmeldeseite mit Manifest und iOS-Tags (Vollbild, Titel, Statusleiste) – auch von dort aus hinzufügbar.
- Vollbild-Modus: Streifen in Logo-Nachtfarbe hinter der iOS-Statusleiste, Seitenleiste/Inhalt/Dialoge rücken unter Uhr und Notch hervor. Markieren bleibt erlaubt (Terminal).

## 2.1.0 – 2026-11-03

**Design wie die slxt-Seiten** (dash.slxt.dev, shop.slxt.org, Nexus, slxt.org; Apple HIG)
- Hell/dunkel nach System, Himmel-Verlauf mit Sternen und Sternschnuppen (`static/icons/himmel.js`, öffentlich wie die Icons, weil die Anmeldeseite ihn braucht).
- Systemschrift statt Google Fonts (keine Anfragen an fremde Server mehr), Kennzahlen in gerundeter Anzeige-Schrift.
- Seitenleiste als Glas, aktiver Reiter als Akzent-Fläche; Karten mit 22 px Radius und weichem Schatten; Pillen-Knöpfe; Dialoge mit fester Fläche.
- Terminal bleibt in beiden Modi dunkel (ANSI-Farben).
- Neues Logo (Terminal-Prompt im Nachtquadrat mit Komet und Farbpunkt), App-Icons und Favicon neu; neue Anmeldeseite.
- Nur Darstellung: alle Variablennamen in `app.css` bleiben, neue Werte stehen oben in `:root`, Feinschliff am Ende der Datei.

## 2.0.1 – 2026-10-28

**Entsperren leichter**
- Eingabefeld „IP(s) entsperren“ im Reiter Sicherheit: eine oder mehrere IPs einfügen, auch solche,
  die nur noch auf der Cloudflare-Liste stehen.
- Mehrfachauswahl in der Sperrenliste mit „Ausgewählte entsperren“ und „Alle angezeigten entsperren“
  (zusammen mit den Anwendungs-Filtern, z. B. alle Nextcloud-Sperren).
- „Meine IP entsperren“ direkt im Hinweis, wenn die eigene IP gesperrt ist.
- Neuer Endpunkt `POST /api/security/unban-many` (nur Superadmins, höchstens 50 IPs, zählt als eine Aktion).

**Favicon**
- `favicon.svg`/`favicon.ico` im Stil des App-Icons, auch auf der Login-Seite. Favicon, App-Icons und
  Manifest sind ohne Anmeldung abrufbar (ohne `..`/`%` im Pfad).

**Sicherheit**
- Browser-Sessions (KasmVNC) lauschen nur noch auf `127.0.0.1`. Vorher fehlte
  `HostIp`, Docker band den Port an `0.0.0.0` – eine Session war dann ohne
  Dashboard-Login aus dem Netz erreichbar.

**ARM64**
- Das Image lädt das KasmVNC-Paket passend zur Architektur (`dpkg --print-architecture`)
  statt fest `amd64` – läuft jetzt auch auf ARM-Servern (z. B. Hetzner CAX).

**Doku**
- Installationsbefehl im README zeigt auf dieses Repo.

## 2.0.0 – 2026-10-12

**Dashboard auf aktuellem Stand**
- Code-Stand des Produktivsystems vom 12.10.2026: Docker-Reiter, Reiter
  Sicherheit (fail2ban-Meldungen, aktive Sperren, Entsperren), Kachel
  „IDS-Wächter live“, VM-Freigabe per Gast-Link mit Netzisolation,
  Drei-Stufen-Rollen (Superadmin/Admin/Benutzer), Browser-Sessions mit
  CPU-Deckel und Leerlauf-Einfrieren u. v. m.
- Passwort-Tresor (Vault) entfernt.

**Portabel, ohne Cloudflare**
- Einstellungen in `/etc/linux-dashboard/dashboard.env` statt im Code:
  `DASHBOARD_ALLOWED_NETS` (jetzt auch CIDR), `DASHBOARD_TRUSTED_PROXIES`,
  `DASHBOARD_PUBLIC_URL`, `DASH_SUPERADMINS`, `DASHBOARD_WAN_IF`,
  `DASH_HOST_PUBLIC_IPS`.
- Host-Adressen und Internet-Interface werden automatisch erkannt.
- Reiter Sicherheit zeigt nur Anwendungen, deren Jails auf dem Server laufen;
  Cloudflare-Kennzeichnung nur, wenn eine Jail wirklich `cf-block` nutzt.

**Neu: Schutz-Paket (`schutz/`)**
- fail2ban (SSH, Dashboard-Login, Dauersperre, vorbereitete Mail-/Web-Jails),
  IDS-Wächter (Suricata passiv + ids-watch + Gesundheitsprüfung +
  Tagesbericht), Firewall-Sperrlisten in eigenen Ketten, ntfy-Pushes,
  Werkzeug `waechter`.
- Cloudflare-Rand-Sperre nur optional (`CLOUDFLARE=1`).
- Installer mit Versionserkennung, Update ohne Datenverlust, Sicherung,
  Konfig-Prüfung mit Rückrollen, Übernahme einer manuellen Vorversion,
  Deinstallation.

**Installer**
- `install.sh` erkennt Erstinstallation, Update und Versionen vor 2.0 und
  übernimmt deren Einstellungen.

## 1.0 – 2026-07-28

- Erste portable Fassung (ohne Tresor), `install.sh` installiert Docker und
  startet den Container.
