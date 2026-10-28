# Changelog

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
