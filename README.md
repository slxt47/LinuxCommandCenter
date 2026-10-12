# Linux Command Center

Selbst entwickeltes Server-Verwaltungs-Dashboard (Docker-Container mit Zugriff
auf den Host) – jetzt mit eingebautem **Schutz-Paket**: fail2ban, IDS-Wächter
(Suricata) und Firewall-Sperrlisten. Läuft **ohne Cloudflare**; Cloudflare ist
nur noch eine Option.

| | |
|---|---|
| Version | siehe `VERSION` (aktuell 2.0.0), Änderungen in `CHANGELOG.md` |
| Systeme | Debian 12, Ubuntu 22.04 / 24.04 (Schutz-Paket: nur apt-basiert) |
| Dashboard | Docker-Container `linux-dashboard`, Port 8420 |

---

## Installation auf einem neuen Server

```bash
git clone https://github.com/JokerGame200/linux-dashboard.git /opt/linux-dashboard
cd /opt/linux-dashboard
sudo ./install.sh
```

Das Skript fragt nur das Nötigste ab:

1. **Erlaubte Netze** für den direkten Zugriff aufs Dashboard (Standard: LAN +
   Tailscale; `localhost` geht immer). Das Dashboard hat Root-Rechte am Host –
   nie ungeschützt ins Internet stellen.
2. **Superadmins** (Standard: `root` + der Benutzer, der `sudo` aufgerufen hat).
3. **Eigene IPs** (Admin-Anschlüsse) – werden nie gesperrt. Die SSH-Adresse,
   von der aus installiert wird, wird vorgeschlagen.
4. **IDS-Wächter** ja/nein und Modus `melden` (nur protokollieren, empfohlen für
   die ersten Tage) oder `sperren`.
5. **ntfy** für Push-Meldungen (optional, leer = keine Pushes).

Ohne Rückfragen, z. B. per Skript:

```bash
sudo ./install.sh --ja --trusted "203.0.113.7" --ids-modus melden \
     --erlaubte-netze "192.168.0.0/16,100.64.0.0/10" --superadmins "root,david" \
     --ntfy-url https://ntfy.sh --ntfy-topic mein-server
```

Weitere Varianten:

| Aufruf | Wirkung |
|---|---|
| `./install.sh --ohne-schutz` | nur das Dashboard |
| `./install.sh --nur-schutz` | nur fail2ban/IDS (Server ohne Dashboard) |
| `./install.sh --ohne-ids` | fail2ban + Firewall, kein Suricata (spart 1–2 GB RAM) |
| `./install.sh --cloudflare` | Web-Apps liegen hinter Cloudflare: zusätzlich Sperre am Cloudflare-Rand |
| `./install.sh --status` | installierte Versionen |

## Update

```bash
cd /opt/linux-dashboard
git pull
sudo ./install.sh --update
```

- Erkennt die installierte Version (`/etc/linux-dashboard/version`,
  `/etc/linux-dashboard/schutz-version`). Ein älteres Repository wird nicht
  über ein neueres installiert (`--force` erzwingt es).
- **Versionen vor 2.0** (die portable Fassung ohne Versionsdatei) werden
  erkannt: Einstellungen aus dem laufenden Container (`DASHBOARD_ALLOWED_NETS`,
  Port, Superadmins …) wandern nach `/etc/linux-dashboard/dashboard.env`, das
  bisherige Verhalten bleibt erhalten.
- Deine Einstellungsdateien werden nie überschrieben, neue Schlüssel nur
  angehängt. Ersetzte Paket-Dateien landen vorher in
  `/var/backups/linux-dashboard-schutz/<zeit>/`.
- Nach dem Ändern der fail2ban-Dateien prüft der Installer die Konfiguration
  mit `fail2ban-client -t`; bei einem Fehler stellt er den vorherigen Stand
  wieder her.

## Einstellungen

| Datei | Inhalt |
|---|---|
| `/etc/linux-dashboard/dashboard.env` | Dashboard: Port, erlaubte Netze, vertrauenswürdige Proxys, Superadmins (wirksam mit `sudo ./install.sh --update` oder `docker compose up -d`) |
| `/etc/linux-dashboard/schutz.conf` | Schutz: eigene IPs, Netze, ntfy, IDS an/aus, Sperrdauern, Cloudflare (wirksam mit `waechter config-anwenden`) |
| `/etc/ids-watch.conf` | IDS-Laufzeit: Modus, Schwellen, Notbremse (wirkt binnen 1 min) |
| `/etc/ids-watch.whitelist` | Gegenstellen, die das IDS nie sperrt |
| `/etc/fail2ban/jail.d/waechter.local` | eigene Jails / Anpassungen (Vorlagen für Nextcloud, Mail, eigene Apps) |
| `/etc/linux-dashboard/blk_net4.txt` | statische Netzsperren |

### Zugriff ohne Tunnel

Das Dashboard kann nur HTTP. Empfohlen:

- **Tailscale/VPN**: `DASHBOARD_ALLOWED_NETS=100.64.0.0/10,fd7a:115c:a1e0::/48`
- **Reverse-Proxy mit HTTPS** (nginx/Caddy) auf demselben Host:
  `DASHBOARD_ALLOWED_NETS` leer lassen (localhost ist immer erlaubt),
  `DASHBOARD_TRUSTED_PROXIES=127.0.0.0/8,::1/128`; der Proxy muss
  `X-Real-IP` setzen.

`DASHBOARD_TRUSTED_PROXIES` legt fest, von wem Proxy-Header geglaubt werden.
Bei direktem LAN-Zugriff **muss** dort nur loopback stehen, sonst könnte ein
LAN-Client per Header eine fremde IP sperren lassen.

---

## Das Schutz-Paket

```
                 ┌────────────── fail2ban ──────────────┐
SSH (journald) ─▶│ sshd, sshd-invalid                    │
Dashboard-Login ▶│ dashboard-auth  (/var/lib/linux-      │──▶ ipset ssh_ban4/6 ─┐
                 │                  dashboard/auth.log)  │                       │
Mail/Web-Apps  ─▶│ optional: dovecot, nextcloud, …       │                       ▼
                 │ dauersperre(-web): 3. Sperre = dauerhaft ─▶ perm_ban4/6 ─▶ Firewall
                 └───────────────────────────────────────┘                  WAECHTER-IN/OUT/FWD
Netzwerk ─(Kopie)─▶ Suricata ─▶ ids-watch.py ─▶ ids-angriff / ids-ausgang ─▶ ids_ban4/6   + DOCKER-USER
```

**fail2ban**

- `sshd` (3 Fehlversuche/1 h) und `sshd-invalid` (unbekannte Benutzer –
  **ein** Versuch) sperren 1 Woche. Deshalb die eigenen IPs eintragen.
- `dashboard-auth`: 3 Fehlanmeldungen am Dashboard/1 h → 1 h, verdoppelnd bis
  1 Woche. Die echte Besucher-IP schreibt das Dashboard nach
  `/var/lib/linux-dashboard/auth.log`.
- `dauersperre` / `dauersperre-web`: dritte Sperre einer IP binnen 90 Tagen →
  dauerhaft (ipset `perm_ban4/6`).
- Mail (docker-mailserver/Postfix+Dovecot) und Web-Apps (Nextcloud, Roundcube,
  ntfy, eigene Apps im `AUTHFAIL`-Format) sind vorbereitet, aber aus –
  einschalten in `/etc/fail2ban/jail.d/waechter.local` (Vorlagen stehen drin).
- Gesperrt wird per **ipset** direkt am Server. Damit wirkt die Sperre auch,
  wenn eine andere Firewall Port 22 vorne freigibt.

**IDS-Wächter**

- Suricata liest den Verkehr des Internet-Interfaces **passiv** mit (keine
  Inline-Filterung: stürzt Suricata ab, läuft der Verkehr normal weiter).
- `ids-watch.py` entscheidet je Alarm: Angriff von außen (Scan, Exploit,
  Reputationsliste …, Schwere ≤ 2) → Quelle 1 Tag gesperrt, verdoppelnd bis
  4 Wochen. Eigener Server/Container baut Verbindung zu Malware/C2/Mining auf
  → Ziel 1 Woche gesperrt + dringender Push. DNS-Abfrage einer Malware-Domain
  → Push, keine Sperre. Reputations-Treffer auf selbst aufgebaute
  Verbindungen (z. B. Mailzustellung) werden nur notiert.
- Nie gesperrt: eigene und interne Netze, `TRUSTED_IPS`, System-Resolver,
  große öffentliche Resolver, `/etc/ids-watch.whitelist`.
- Notbremse: mehr als 1500 Sperren/h → nur noch melden + Push.
- Regeln (ET Open) täglich per `suricata-update-waechter.timer`.
- `ids-gesundheit.timer` prüft alle 5 min Dienste, Paketzähler, Regelalter und
  Firewall-Regeln, startet Gestopptes neu bzw. baut fehlende Firewall-Regeln
  wieder auf und meldet bleibende Probleme per Push.
- Tagesbericht per Push um 05:50 UTC.
- Die Kachel „IDS-Wächter live“ im Reiter **Sicherheit** zeigt alles live.

**Firewall**

`waechter-firewall.service` legt eigene Ketten `WAECHTER-*` an Position 1 von
INPUT/OUTPUT/FORWARD an und ergänzt `DOCKER-USER`. Die Ketten verwerfen nur
gesperrte Adressen und lassen alles andere mit `RETURN` weiterlaufen – sie
öffnen nie etwas, was ufw/firewalld geschlossen haben. `lo`, `tailscale0`,
Docker- und libvirt-Bridges sowie `TRUSTED_IPS` werden vor jeder Sperre
durchgelassen. Wer eine eigene Firewall pflegt: `FIREWALL="aus"` in
`schutz.conf`, dann werden nur die ipsets angelegt.

### Bedienung

```bash
waechter status                  # Dienste, Jails, Sperrlisten, Netze
waechter sperren                 # alle aktiven Sperren
waechter freigeben 203.0.113.9   # IP überall entsperren (Jails, ipsets, ggf. Cloudflare)
waechter ids-modus sperren       # IDS von "melden" auf "sperren" umstellen
waechter config-anwenden         # nach Änderungen an schutz.conf
waechter test-push               # ntfy prüfen
tail -f /var/log/ids-watch.log   # IDS live
```

Entsperren geht auch im Dashboard (Reiter **Sicherheit**).

**Selbst ausgesperrt?** Über einen anderen Anschluss bzw. Tailscale (wird nie
gesperrt) einloggen und `waechter freigeben <ip>`. Danach die Adresse in
`TRUSTED_IPS` eintragen und `waechter config-anwenden`.

### Optional: Cloudflare

Liegen Web-Apps hinter einem Cloudflare-Tunnel, erreicht der Angreifer den
Server nie mit eigener Adresse – ein ipset trifft ihn dort nicht.
`CLOUDFLARE="1"` in `schutz.conf` (oder `--cloudflare`) installiert dafür
`cf-ban.sh` und die Action `cf-block`: gesperrte IPs landen zusätzlich in einer
Cloudflare-IP-Liste mit WAF-Regel. Token in `/etc/fail2ban/cloudflare.local`
eintragen, dann `cf-ban-setup.sh`. Das IDS sperrt dann außerdem nie
Cloudflare-Netze.

### Übernahme einer manuell eingerichteten Vorversion

Findet der Installer fail2ban-/IDS-Dateien, die nicht aus diesem Paket stammen
(z. B. `/usr/local/sbin/ids-watch.py`), bricht er ab. Mit `--uebernehmen`
werden ntfy-Zugang, Interface, eigene IPs und Cloudflare-Nutzung aus dem
Altbestand übernommen, gleichnamige Dateien ersetzt (Sicherung unter
`/var/backups/linux-dashboard-schutz/`) und eigene Jail-Dateien in
`/etc/fail2ban/jail.d/` gelten unverändert weiter. Eine vorhandene eigene
Firewall (`audit-firewall.sh`) wird erkannt (`FIREWALL="aus"`).

### Deinstallation

```bash
sudo ./schutz/install-schutz.sh --deinstallieren          # Einstellungen bleiben
sudo ./schutz/install-schutz.sh --deinstallieren --alles  # inkl. Einstellungen
```

---

## Projektstruktur

```
├── install.sh            # Installation/Update (Dashboard + Schutz)
├── VERSION, CHANGELOG.md
├── config/               # Vorlage dashboard.env
├── server.py             # Einstiegspunkt
├── dashboard/            # Backend (auth, vms, docker, security, ids, …)
├── static/               # Frontend (index.html, app.js, app.css)
├── console-pages/        # VNC/SPICE-Konsolen
├── Dockerfile, docker-compose.yml
└── schutz/               # Schutz-Paket
    ├── install-schutz.sh # Installation/Update/Übernahme/Deinstallation
    ├── config/           # Vorlagen schutz.conf, ids-watch.conf, waechter.local …
    ├── fail2ban/         # action.d, filter.d, jail.d (Vorlage), fail2ban.d
    ├── sbin/             # waechter, waechter-firewall.sh, ids-watch.py, …
    ├── systemd/          # Units und Timer
    ├── logrotate/
    └── lib/schutz.py     # Netze erkennen, Vorlagen füllen, Konfig zusammenführen
```

Der Container läuft mit `network_mode: host`, `pid: host` und Zusatz-
Capabilities (nsenter in den Host). VM-Funktionen brauchen libvirt auf dem
Host, Browser-Sessions den Docker-Socket, der Login nutzt die Host-Benutzer.
