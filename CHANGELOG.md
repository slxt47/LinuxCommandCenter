# Changelog

## 2.1.0 – 2026-11-03

**Design wie die slxt-Seiten** (dash.slxt.dev, shop.slxt.org, Nexus, slxt.org; Apple HIG)
- Hell/dunkel nach System, Himmel-Verlauf mit Sternen und Sternschnuppen (`static/icons/himmel.js`, öffentlich wie die Icons, weil die Anmeldeseite ihn braucht).
- Systemschrift statt Google Fonts (keine Anfragen an fremde Server mehr), Kennzahlen in gerundeter Anzeige-Schrift.
- Seitenleiste als Glas, aktiver Reiter als Akzent-Fläche; Karten mit 22 px Radius und weichem Schatten; Pillen-Knöpfe; Dialoge mit fester Fläche.
- Terminal bleibt in beiden Modi dunkel (ANSI-Farben).
- Neues Logo (Terminal-Prompt im Nachtquadrat mit Komet und Farbpunkt), App-Icons und Favicon neu; neue Anmeldeseite.
- Nur Darstellung: alle Variablennamen in `app.css` bleiben, neue Werte stehen oben in `:root`, Feinschliff am Ende der Datei.

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
