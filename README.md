# Linux Command Center + Passwort-Tresor — v2.0.0

Portables Komplettpaket: das Server-Verwaltungs-Dashboard **inklusive**
Zero-Knowledge-Passwort-Tresor (Vault), installierbar auf einem frischen
Linux-System mit einem Befehl.

```bash
tar -xzf linux-command-center-v2.0.0-2026-08-17.tar.gz
cd linux-command-center
sudo ./install.sh
```

Danach: **http://\<server-ip\>:8420** — Login mit einem lokalen Systembenutzer
des Hosts. Der Tresor liegt im Reiter „Tresor“.

---

## Was wird installiert

| Komponente | Wohin | Wie |
|---|---|---|
| Dashboard | Docker-Container `linux-dashboard`, Port **8420** | `docker compose` (host-network, pid host) |
| Dashboard-Daten | `/var/lib/linux-dashboard` | Sessions, Browser-Sitzungen, Einstellungen |
| Vault-Backend | `/opt/vault-manager` | systemd-Dienst `vault.service`, **127.0.0.1:8099** |
| Vault-Daten | `/var/lib/vault/vault.db` | SQLite, nur für Benutzer `vault` lesbar (Mode 700) |

Der Vault lauscht **ausschließlich auf localhost**. Erreichbar wird er nur über
den Reverse-Proxy im Dashboard (`/vault-app`, `/api/vault/`) — deshalb muss der
Container `network_mode: host` behalten.

### Abhängigkeiten, die der Installer selbst erledigt

- Docker Engine + Compose-Plugin (apt / dnf / yum / pacman / zypper)
- `python3` und das Python-Modul `cryptography` auf dem **Host**
  (Signaturprüfung der Geräte-Freigabe; Distro-Paket, sonst pip-Fallback)
- Systembenutzer `vault` (unprivilegiert, kein Login), Datenverzeichnisse

## Optionen

```bash
sudo ./install.sh                 # installieren bzw. aktualisieren
sudo ./install.sh --update        # dito (Alias)
sudo ./install.sh --check         # Status aller Teile prüfen
sudo ./install.sh --dashboard-only
sudo ./install.sh --vault-only
sudo ./install.sh --no-start      # nur einrichten/bauen, nicht starten
sudo ./install.sh --port 9000     # anderer Dashboard-Port
sudo ./install.sh --uninstall     # Container + Dienst entfernen (Daten bleiben)
```

**Updates sind datenerhaltend.** Der Installer ersetzt nur Programmcode
(`/opt/vault-manager`, Container-Image). `/var/lib/vault/vault.db` und
`/var/lib/linux-dashboard` werden nie angefasst.

## Erste Schritte im Tresor

1. Dashboard öffnen → Reiter **Tresor**.
2. Konto anlegen: Master-Passwort setzen (unabhängig vom Linux-Login!).
3. **24-stelligen Notfall-Code sofort notieren** — er ist der einzige zweite
   Weg zum Vault-Key. Ohne Master-Passwort und ohne Notfall-Code sind die
   Daten unwiederbringlich verloren (Zero-Knowledge: der Server kann nicht helfen).
4. iPhone koppeln: `https://<host>:8420/vault-app/phone.html` auf dem Handy
   öffnen, „Zum Home-Bildschirm“ hinzufügen, im Dashboard „Gerät koppeln“
   → Kopplungs-Code eingeben. Max. 3 Geräte.
5. Login danach = Master-Passwort **+** Freigabe auf dem gekoppelten Gerät.

## Zugriffskontrolle

Das Original lief hinter einem Cloudflare-Tunnel und erlaubte deshalb nur
Zugriffe von `127.` / `172.` / `10.`. Für ein neues System steht in
`dashboard-docker/docker-compose.yml` deshalb:

```yaml
environment:
  - DASHBOARD_ALLOWED_NETS=*      # jeden Zugriff erlauben
```

Enger fassen (empfohlen):

```yaml
  - DASHBOARD_ALLOWED_NETS=192.168.,100.
```

> **Achtung:** Das Dashboard bietet Root-Terminal, Docker- und VM-Verwaltung des
> Hosts. Niemals ungeschützt ins offene Internet stellen — nur LAN/VPN
> (z. B. Tailscale) oder Reverse-Proxy mit TLS und Zugriffsschutz davor.

## Host-Voraussetzungen für einzelne Features

| Feature | Braucht auf dem Host |
|---|---|
| Login / Benutzerverwaltung | echte Systembenutzer (`/etc/shadow`) — Admin = Gruppe `sudo` |
| VM-Verwaltung + Konsolen | `libvirt` / QEMU (`/run/libvirt`), für SPICE-Konsolen `virt-viewer` |
| Browser-Sessions, Docker-Reiter | Docker-Socket (`/var/run/docker.sock`) |
| Paket-Updates, Dienste, Terminal | `nsenter`-Zugriff auf PID 1 (durch `pid: host` gegeben) |

Fehlt libvirt, bleiben nur die VM-Funktionen inaktiv; alles andere läuft.

## Verzeichnisse im Paket

```
linux-command-center/
├── install.sh              Installer (Dashboard + Vault)
├── VERSION                 2.0.0
├── README.md               diese Datei
├── dashboard-docker/       Docker-Build-Kontext des Dashboards
│   ├── Dockerfile, docker-compose.yml
│   ├── server.py           Entry-Point
│   ├── dashboard/          App-Module (handler, auth, vms, docker, terminal …)
│   ├── static/             Frontend (index.html, app.js, app.css, Icons)
│   ├── console-pages/      VNC-/SPICE-Konsolenseiten
│   └── README-dashboard.md ausführliche Dashboard-Doku + Changelog
└── vault/                  Passwort-Tresor
    ├── vault_backend.py    Backend (krypto-frei, nur Blob-Speicher)
    ├── schema.sql          SQLite-Schema
    ├── vault.service       systemd-Unit (gehärtet)
    ├── static/vault-app/   Tresor-Web-App + iPhone-PWA (phone.html)
    └── README-vault.md     Krypto-Contract + Architektur
```

## Betrieb

```bash
docker logs -f linux-dashboard      # Dashboard-Logs
journalctl -u vault -f              # Vault-Logs
docker compose -f dashboard-docker/docker-compose.yml restart
systemctl restart vault.service
sudo ./install.sh --check           # Gesamtstatus
```

## Backup

Zwei Pfade sichern, mehr nicht:

```bash
systemctl stop vault.service
cp /var/lib/vault/vault.db /pfad/zum/backup/     # Tresor (nur Ciphertext)
tar -czf dashboard-daten.tar.gz /var/lib/linux-dashboard
systemctl start vault.service
```

Die Vault-DB enthält ausschließlich verschlüsselte Blobs — ohne Master-Passwort
bzw. Notfall-Code ist sie wertlos. Das gilt auch für dich: **Notfall-Code
getrennt aufbewahren.**

## Bekannte Einschränkungen

- Der Tresor teilt sich den Origin mit dem Admin-Panel (Prozess-, nicht
  Origin-Isolation). Härter wird es mit einer eigenen Subdomain +
  Reverse-Proxy auf `127.0.0.1:8099`.
- Der iPhone-Device-Key liegt im WebKit-Keystore der PWA (nicht in der Secure
  Enclave). PWA-Daten löschen ⇒ Gerät neu koppeln.
- Freigaben werden per Polling geholt (kein Push).
- KasmVNC-VM-Konsolen brauchen die im Dockerfile gepinnten Versionen — beim
  Anpassen Client- und Server-Version synchron halten.
