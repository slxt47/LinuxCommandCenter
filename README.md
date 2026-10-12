# Linux Command Center — Portable (ohne Vault/Passwort-Tresor)

Eigenständige, portable Kopie des Dashboard-Containers. Der **Passwort-Tresor
(Vault) wurde vollständig entfernt** — sowohl die UI (Nav-Button + Tresor-Seite)
als auch der Reverse-Proxy auf den separaten Vault-Dienst (Port 8099). Diese
Kopie hat keinerlei Abhängigkeit mehr auf den externen `vault.service`.

## Schnellstart

```bash
sudo ./install.sh
```

Das Script:
1. installiert Docker Engine + Compose-Plugin (falls nicht vorhanden),
2. legt das Datenverzeichnis `/var/lib/linux-dashboard` an,
3. baut das Image und startet den Container.

Danach erreichbar unter `http://<server-ip>:8420`.
**Login:** ein lokaler Systembenutzer des Host-Systems (Auth via `/etc/shadow`).

## Was ist enthalten

| Datei / Ordner        | Zweck                                             |
|-----------------------|---------------------------------------------------|
| `Dockerfile`          | Image-Definition (Debian + Python + KasmVNC-Stack)|
| `docker-compose.yml`  | Container-Konfiguration (host-network, Volumes)   |
| `install.sh`          | Abhängigkeiten + Build + Start                    |
| `server.py`           | Einstiegspunkt                                    |
| `dashboard/`          | App-Module (Handler, Auth, VMs, Terminal, …)      |
| `static/`             | Frontend (HTML/CSS/JS, Icons)                     |
| `console-pages/`      | VNC/SPICE-Konsolenseiten                           |

## Zugriffskontrolle

Standardmäßig erlaubte der Original-Container nur Zugriff über den
Cloudflare-Tunnel (IP-Präfixe `127./172./10.`). Für ein neues System ohne
Cloudflare ist in `docker-compose.yml` deshalb gesetzt:

```yaml
environment:
  - DASHBOARD_ALLOWED_NETS=*      # jeden Zugriff erlauben
```

Enger fassen (empfohlen, wenn nur aus dem lokalen Netz erreichbar):

```yaml
  - DASHBOARD_ALLOWED_NETS=192.168.,100.
```

## Nützliche Kommandos

```bash
docker compose logs -f      # Logs ansehen
docker compose down         # stoppen
docker compose up -d        # starten
sudo ./install.sh --update  # Code-Update: neu bauen + neu starten
```

## Hinweise zu Funktionen / Volumes

Der Container läuft mit `network_mode: host`, `pid: host` und einigen
Zusatz-Capabilities, um Host-System-Verwaltung (Prozesse, Updates, Terminal,
VMs) zu ermöglichen. Einige Features hängen von Host-Komponenten ab:

- **VM-Konsolen** brauchen `libvirt`/QEMU auf dem Host (`/run/libvirt`). Fehlt
  libvirt, bleiben die VM-Funktionen inaktiv, der Rest läuft normal.
- **Browser-Sessions** brauchen den Docker-Socket (`/var/run/docker.sock`).
- **Login** nutzt die Host-Benutzer (`/etc/passwd`, `/etc/shadow`).

Diese Mounts sind in `docker-compose.yml` dokumentiert und können bei Bedarf
angepasst werden.
