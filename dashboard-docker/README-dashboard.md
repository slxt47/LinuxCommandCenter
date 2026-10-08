# Linux Command Center

Ein selbst entwickeltes Linux-Server-Administrations-Webinterface mit dunklem Design, das als Docker-Container läuft und vollen Zugriff auf den Host-Systembekommt.

Erreichbar unter: **https://home.jokerdev.tech** (via Nginx Reverse Proxy + Cloudflare)

---

## Übersicht

Der **Linux Command Center** ist ein browserbasiiertes Dashboard zur Verwaltung eines Linux-Servers. Es ersetzt Tools wie Cockpit durch eine vollständig eigene, moderne Oberfläche (dunkles Theme, JetBrains Mono / Space Grotesk Fonts, Emerald-Neon-Akzentfarbe).

---

## Projektstruktur

```
linux-dashboard-docker/
├── server.py              # Einstiegspunkt (Threaded HTTP-Server, ~100 Zeilen)
├── dashboard/             # Backend-Paket (aus dem früheren Monolithen aufgeteilt)
│   ├── base.py            # Konstanten, Pfade, nsenter-Helfer
│   ├── auth.py            # Sitzungen, Rollen, Rate-Limits, Host-Benutzer
│   ├── sysinfo.py         # CPU / RAM / Platten / Netz / Dienste / Updates
│   ├── vms.py             # libvirt-VMs
│   ├── networks.py        # libvirt-Netzwerke
│   ├── storage.py         # Pools, Volumes, ISO-Verwaltung
│   ├── docker.py          # Docker-Verwaltung (Container, Images, Netze,
│   │                      #   Volumes, Stacks, Streams, Aufträge)
│   ├── consoles.py        # websockify-Proxys, WebSocket-Helfer, _docker_api
│   ├── browsers.py        # kasmweb-Browser-Sessions
│   ├── extconn.py         # Externe VNC/SPICE/SSH/RDP-Verbindungen
│   ├── terminal.py        # Zustandsbehaftetes Host-Terminal (PTY)
│   └── handler.py         # HTTP-Routing (do_GET / do_POST / WebSockets)
├── static/
│   ├── index.html         # Frontend-SPA (Seiten + Modale)
│   ├── app.js             # Gesamte Frontend-Logik (Vanilla JS)
│   ├── app.css            # Dark-Theme, Komponenten, Responsive-Regeln
│   └── ssh_terminal.html  # Dedizierte SSH-Terminal-Seite
├── console-pages/
│   ├── vnc_cmd.html       # Wird nach /usr/share/novnc/ kopiert
│   └── spice_cmd.html     # Wird nach /usr/share/spice-html5/ kopiert
├── backups/               # Zeitgestempelte Sicherungen vor jeder Änderung
├── Dockerfile
└── docker-compose.yml
```

> **Hinweis:** `server.py`, `dashboard/` und `static/` sind Volume-Mounts.
> Backend-Änderungen greifen mit `docker compose restart` (kein Image-Neubau),
> reine Frontend-Änderungen brauchen gar keinen Neustart.

---

## Technologie-Stack

| Komponente | Technologie |
|---|---|
| Backend | Python 3 (stdlib only, kein Framework) |
| Frontend | Vanilla HTML/CSS/JavaScript (Single Page App) |
| Containerisierung | Docker (Debian Bookworm Slim) |
| VNC-Proxy | websockify + noVNC |
| SPICE-Proxy | websockify + spice-html5 |
| Browser-Isolation | kasmweb/firefox + kasmweb/chrome via Docker |
| VM-Verwaltung | libvirt / virsh |
| Reverse Proxy | Nginx → Port 8420 |
| TLS | Let's Encrypt (home.jokerdev.tech) |
| CDN | Cloudflare |

---

## Features

### Authentifizierung
- Login gegen echte Linux-Systembenutzer (liest `/etc/shadow` read-only)
- Unterstützt moderne Hash-Algorithmen (yescrypt `$y$`) via `nsenter` auf den Host
- Session-Tokens (24h Laufzeit, `secrets.token_urlsafe`)
- Rollen: `admin` / normaler Benutzer (Multi-User-fähig)

### System-Monitoring
- **CPU**: Auslastung gesamt + pro Kern, Taktfrequenz, Modell, Load Average
- **RAM**: Gesamt, belegt, frei, Swap
- **Festplatten**: Alle Mounts, Nutzung, Dateisystem-Typ
- **Netzwerk**: Interface-Liste, Bandbreite, IP-Adressen
- **Prozesse**: Liste aller laufenden Prozesse, Kill-Funktion

### Paket-Verwaltung
- Anzeige verfügbarer Updates (`apt list --upgradable`)
- System-Update direkt aus dem Browser (`apt update && apt upgrade -y`)
- Läuft via `nsenter` im Host-Mount-Namespace

### Terminal
- **Stateful PTY-Terminal** im Browser (bash, mit vollem interaktiven Support)
- Unterstützt `sudo`, `nano`, `vim`, `htop` etc.
- Persistenter CWD-Status über Requests hinweg
- WebSocket-basierter Live-Terminal (`/api/terminal/ws`)
- Dedizierte SSH-Terminal-Seite für externe Server

### VM-Verwaltung (libvirt / KVM)
- Auflistung aller VMs (`virsh list --all`)
- VM-Aktionen: Start, Stop, Reboot, Suspend, Resume, Force-Off
- VM erstellen / löschen / klonen
- VM-Details: CPU, RAM, Disks, NICs, Zustand
- Snapshots: Erstellen, Löschen, Revert
- Disks: Attach / Detach
- NICs: Attach / Detach
- Keymap setzen
- **Browser-Konsole direkt im Dashboard**:
  - VNC via noVNC
  - SPICE via spice-html5
  - WebSocket-Proxy (`ProxyManager`) mit Token-basierter Authentifizierung

### Netzwerk-Verwaltung
- Virtuelle Netzwerke auflisten (`virsh net-list`)
- Netzwerk erstellen / starten / stoppen / löschen

### Storage-Verwaltung
- Storage Pools auflisten
- Volumes auflisten / erstellen / löschen
- ISO-Dateien finden und verwalten

### Docker-Verwaltung
Eigener Reiter **Docker** (nur für Admins sichtbar), Zugriff ausschließlich über
den gemounteten Socket `/var/run/docker.sock` — im Container ist kein
`docker`-CLI installiert.

- **Container:** Liste mit Status, Image, Ports, Laufzeit, Neustart-Regel,
  Compose-Projekt, Health und Live-CPU/RAM
  - Start / Stop / Neustart / Pause / Fortsetzen / Kill (mit Signalwahl)
  - Entfernen (erzwungen und wahlweise mit anonymen Volumes), Umbenennen
  - Neustart-Regel und Ressourcen-Limits (Speicher, CPUs, Shares, CPU-Set) ändern
  - Erstellungsassistent: Image, Name, Kommando/Entrypoint, Ports, Volumes,
    Umgebungsvariablen, Netzwerk, Neustart-Regel, Labels, Limits, Privileged,
    Capabilities, Benutzer, Arbeitsverzeichnis, Autostart
  - Als Image festschreiben (`commit`), Dateien hoch- und herunterladen (`/archive`)
- **Detailansicht** mit Reitern: Übersicht (inkl. Mounts, Netzwerken,
  Umgebungsvariablen, Labels, Health-Verlauf), **Logs** (live folgen, Tail-Wahl,
  Zeitstempel, Textfilter, Download), **Stats** (CPU, RAM, Netz, Block-I/O),
  **Konsole** (interaktive Shell im Browser, sh/bash/ash/zsh), **Inspect**,
  **Prozesse** (`/top`), **Dateiänderungen** (`/changes`)
- **Images:** Liste mit Größe, Alter, Verwendung; Entfernen, Tag setzen,
  History, Inspect, Export als Tar, **Pull mit Layer-Fortschritt**,
  **Docker-Hub-Suche** (Sterne, Official-/Verified-Kennzeichen, Tag-Liste,
  direkt pullen oder Container daraus erstellen), **Build aus Dockerfile**
  (Build-Kontext vom Host, Live-Build-Log)
- **Netzwerke:** Liste mit Treiber, Subnetz, Gateway und verbundenen Containern;
  Anlegen (bridge / macvlan / ipvlan / overlay, Subnetz, Gateway, IP-Bereich,
  internal, IPv6), Entfernen, Inspect, Container verbinden/trennen (mit
  optionaler fester IP und Alias)
- **Volumes:** Liste mit Größe (`/system/df`) und Nutzern, Anlegen, Entfernen, Inspect
- **Compose-Stacks:** Gruppierung über `com.docker.compose.project`, Start/Stop/
  Neustart aller Container eines Stacks (parallel), Anzeige der Compose-Datei
- **System:** Version und Eckdaten der Engine, Speicherbelegung nach Typ,
  **Ereignis-Live-Strom**, Aufräum-Dialog mit **verpflichtendem Trockenlauf**
  (listet namentlich auf, was gelöscht würde)

### Browser-Sessions (kasmweb)
- Isolierte Browser-Container (Firefox / Chromium) starten
- Basiert auf kasmweb Docker-Images
- Port-Range 7000–7099 für Container
- Sessions werden persistent gespeichert (`/data/browser_sessions.json`)
- Orphan-Container werden beim Neustart aufgeräumt

### Externe Verbindungen
- Externe VNC / SPICE / SSH / RDP-Verbindungen speichern und öffnen
- Proxy via websockify
- Browser-basierte Konsolen (noVNC / spice-html5)
- SSH-Terminal im Browser via dedizierter Seite + paramiko

---

## Setup & Betrieb

### Voraussetzungen
- Docker + Docker Compose
- libvirt/KVM (optional, für VM-Verwaltung)
- Nginx (Reverse Proxy)
- Let's Encrypt Zertifikat

### Starten

```bash
cd /home/jokergame/linux-dashboard-docker
docker compose up -d
```

### Stoppen

```bash
docker compose down
```

### Logs anzeigen

```bash
docker compose logs -f
```

### Status prüfen

```bash
docker compose ps
```

---

## Konfiguration

Alle Konfiguration direkt in `server.py` oben:

```python
HOST = "0.0.0.0"
PORT = 8420
DATA_DIR = Path("/data")        # Persistente Daten (Sessions etc.)
```

Optionaler Umgebungsvariablen-Token-Schutz:
```yaml
# docker-compose.yml
environment:
  - DASHBOARD_TOKEN=geheim123   # (auskommentiert = deaktiviert)
```

---

## Nginx-Konfiguration

```nginx
# /etc/nginx/sites-available/cockpit
server {
    listen 443 ssl;
    server_name home.jokerdev.tech;

    location / {
        proxy_pass http://127.0.0.1:8420;   # Zum Command Center
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }
}
```

> **Hinweis:** Der aktuelle nginx-Config zeigt auf Port 9090 (Standard-Cockpit). Das muss auf `http://127.0.0.1:8420` geändert werden, damit das Command Center über die Domain erreichbar ist.

---

## Sicherheitskonzept

- Container läuft **privileged** mit `network_mode: host` und `pid: host` für vollen Host-Zugriff via `nsenter`
- `/etc/shadow` ist read-only gemountet (Authentifizierung gegen echte Systembenutzer)
- `/var/run/docker.sock` gemountet (Docker-API-Zugriff)
- **Rollenbasierte Autorisierung:** host-verändernde Operationen (VM-, Netzwerk-,
  Storage-, **Docker-**, Dienst-, Prozess-Verwaltung, Terminal, System-Update)
  erfordern die Rolle **admin** (Mitglied der `sudo`/`wheel`-Gruppe).
  Nicht-Admin-Logins können nur eigene Browser-Sessions/externe Verbindungen nutzen.
- **Docker ist vollständig admin-only** — *lesend wie schreibend*. Wer den Socket
  bedienen kann, kann sich Root auf dem Host verschaffen (Bind-Mount von `/`),
  deshalb sind die Prefixe `/api/docker` (GET) und `/api/docker/` (POST) beide
  hinter `_require_admin()`. Der Nav-Reiter wird Nicht-Admins gar nicht erst gezeigt.
- **Selbstschutz:** Der eigene Container `linux-dashboard` kann über die Oberfläche
  nicht gestoppt, gekillt, neu gestartet, umbenannt, verändert oder gelöscht werden
  (**HTTP 403**). Die Sperre greift für Name, Id-Präfix und volle Id — die eigene Id
  wird beim Start einmalig über die Docker-API aufgelöst, nicht über `$HOSTNAME`
  (wegen `network_mode: host` wäre das der Hostname des Wirts).
- **Kritische Infrastruktur:** `cloudflared` ist der einzige Zugangsweg (der
  IP-Filter sperrt direkten LAN-Zugriff). Er bleibt bedienbar, wird aber als
  `critical` markiert und der Bestätigungsdialog warnt ausdrücklich.
- **Vom Dashboard verwaltete Container** (`lcc-browser-*`) werden gekennzeichnet;
  ihr Löschen läuft über den `BrowserSessionManager`, damit
  `/data/browser_sessions.json` konsistent bleibt.
- **Pfad-Absicherung:** Build-Kontexte und gelesene Compose-Pfade müssen absolut
  sein; `/`, `/proc`, `/sys`, `/dev`, `/boot`, `/etc`, `/root`, `/run`,
  `/var/run` und `/var/lib/docker` sind gesperrt. Pfade wandern als argv-Element
  an `nsenter … tar` — **niemals** in eine Shell.
- **Aufräumen (Prune)** erfordert einen Trockenlauf mit namentlicher Auflistung
  plus eine zweite, ausdrückliche Bestätigung; Volumes und „alle ungenutzten
  Images“ sind gesondert zu aktivieren.
- Schreibende Docker-Endpunkte hängen an der Pro-IP-Drossel
  (`_action_rate_limited("docker", ip, max_hits=60)`); lesende Endpunkte sind
  ausschließlich GETs und werden nicht gedrosselt.
- Session-Cookies: `HttpOnly; SameSite=Strict`, 24 h Laufzeit, `secrets.token_urlsafe(32)`
- WebSocket-Proxy-Sessions sind token-basiert: **an den Besitzer gebunden**,
  30-min-TTL, **sofortige Invalidierung** bei Teardown des Proxys; `/ws/` und
  `/kasmvnc-vm/` verlangen zusätzlich eine gültige Session
- Login mit Pro-IP-Rate-Limit (8 Versuche / 60 s) gegen Brute-Force
- Alle API-Endpoints erfordern gültige Session-Cookies

> ⚠️ **Betriebshinweis:** `/etc/shadow` ist ein **Datei**-Bind-Mount. Werden auf
> dem Host nach Container-Start Benutzer angelegt/geändert (`useradd`/`passwd`
> ersetzen die Datei atomar → neuer Inode), sieht der Container die Änderung erst
> nach `docker compose restart`.

---

## Ports

| Port | Dienst |
|---|---|
| 8420 | Command Center Backend (HTTP) |
| 6900–6999 | Dynamische WebSocket-Proxies (VNC/SPICE) |
| 7000–7099 | kasmweb Browser-Container |

Der Docker-Reiter belegt **keine** zusätzlichen Ports: Logs, Konsole, Statistik
und Ereignisse laufen über den bestehenden Port 8420 (WebSocket bzw. Polling),
der Docker-Zugriff selbst über den Unix-Socket `/var/run/docker.sock`.

---

## Datenpersistenz

| Pfad | Inhalt |
|---|---|
| `/var/lib/linux-dashboard/` | Persistente Daten auf dem Host |
| `/data/browser_sessions.json` | Gespeicherte Browser-Sessions |
| `/var/lib/linux-dashboard/kasmvnc.yaml` | KasmVNC-Konfiguration (Framerate etc.) |

---

## Changelog

### 2026-08-15 — Docker-Reiter 1.4: Container mit geteiltem Netzwerk-Stack

**Symptom (vom Nutzer gemeldet, mit Screenshot):** Beim Verbinden von `pxe-gui`
mit `jellyfin_net` erschien der rote englische Rohtext
`container sharing network namespace with another container or host cannot be
connected to any other network`.

**Ursache — zwei Fehler übereinander:**
1. Fünf `pxe-*`-Container laufen mit `network_mode: container:<id>`, teilen sich
   also den Netzwerk-Stack von `pxe-net`. Docker erlaubt ihnen kein eigenes Netz.
   Der Filter im Verbinden-Dialog kannte nur `host` und `none`.
2. Gravierender: `docker_containers()` lieferte **`network_mode` überhaupt nicht
   mit**. Der Filter im Netzwerke-Dialog prüfte also gegen `undefined` und hat
   noch nie irgendetwas ausgefiltert — auch `host` und `none` nicht. Der Fehler
   aus 1.1 war damit nur auf der Container-Detailseite behoben, nicht im
   Netzwerke-Tab.

**Fix:**
- Neuer Helfer `_net_mode_info()` liefert den Modus **lesbar** (`container:pxe-net`
  statt `container:6566049c554b…`), ein Kennzeichen `net_attachable` und den Namen
  des Containers, dessen Stack geteilt wird.
- Container-Liste **und** Detailansicht liefern `network_mode`, `net_attachable`
  und `net_shares_with`. Beide Dialoge filtern jetzt über `net_attachable`.
- Der Verbinden-Dialog erklärt, **warum** Container fehlen, statt sie kommentarlos
  wegzulassen: „5 Container werden nicht angeboten, weil sie den Netzwerk-Stack
  teilen (host, none oder container:…): pxe-dnsmasq, pxe-gui, …“
- Auf der Detailseite nennt der Hinweistext den konkreten Ausweg: „Dieser Container
  teilt sich den Netzwerk-Stack von „pxe-net“ — weise das Netz stattdessen
  „pxe-net“ zu, dann gilt es für beide.“
- `_connect_error_de()` übersetzt die Namensraum-Meldung, falls sie doch einmal
  über die API auftritt.
- Gestoppte Container sind in der Auswahl als „(gestoppt)“ gekennzeichnet.

**Verifiziert** (echte Klicks, Desktop und 390 px): Von 25 Containern sind 19
verbindbar; `pxe-dnsmasq`, `pxe-gui`, `pxe-mcast`, `pxe-nfs`, `pxe-nginx` und
`linux-dashboard` werden nicht mehr angeboten, der Hinweis nennt sie namentlich.
Das Verbinden eines zulässigen Containers mit `jellyfin_net` funktioniert
(`docker inspect` bestätigt `172.19.0.7`). Layout-Viewport mobil weiterhin 390 px.

**Rollback:** `backups/docker.py.bak-netmode-*` und `backups/app.js.bak-netmode-*`
zurückkopieren, danach `docker compose restart`.


### 2026-08-15 — Docker-Reiter 1.3: verwaiste Shells und Zustandsfehler aus dem Agenten-Test

Zweiter Teil der Agenten-Befunde (Container-Aktionen und Streams). Alle Punkte
wurden vor der Korrektur einzeln nachgestellt.

**HOCH — Jede Konsole ließ eine Shell im Zielcontainer zurück.**
Docker beendet einen Exec-Prozess **nicht**, wenn die Verbindung abreißt. Die
Oberfläche trennt beim Tab-Wechsel aber die Verbindung, statt `exit` zu tippen —
also blieb bei praktisch jeder Konsolen-Nutzung eine laufende Shell im Container
zurück. Gemessen: 5 Sitzungen → 5 verwaiste `sh`-Prozesse; in einem längeren
Testlauf 36 Stück. Das hätte sich in produktiven Containern angesammelt.
*Fix:* `docker_exec_cleanup()` holt nach dem Trennen die Pid über
`GET /exec/{id}/json` und beendet sie (SIGTERM, nach 0,6 s SIGKILL). Der
Dashboard-Container läuft mit `pid: host`, die Pid ist also direkt adressierbar.
Verifiziert: 5 Sitzungen (2× sauber getrennt, 2× harter TCP-Abriss, 1× `exit`)
→ **0 verwaiste Prozesse**, Konsole weiterhin voll funktionsfähig.

**`stop` mit `timeout: 0` wartete trotzdem 10 Sekunden.**
`int(timeout or 10)` verschluckte die Null — `0 or 10` ergibt 10. „Sofort hart
stoppen“ war damit unmöglich (gemessen 10,5 s). Jetzt 0,4 s.

**Zustandsfehler kamen als englischer Rohtext mit 64-stelliger Id.**
Docker liefert bei HTTP 409 immer ein `message`-Feld, weshalb der eigene deutsche
Rückfalltext nie zum Zug kam. Neu: `_action_error_de()` übersetzt die häufigen
Fälle (bereits pausiert, nicht pausiert, läuft nicht, läuft bereits, gleicher
Name, CPU-Set nicht verfügbar) und kürzt unbekannte Meldungen wenigstens auf
12-stellige Ids. Ebenso `docker_exec_message_de()` für OCI-Fehler im
Exec-Strom — eine fehlende Shell meldet jetzt „Die Shell „bash“ ist in diesem
Container nicht vorhanden“ statt `OCI runtime exec failed: … $PATH`.

**Pausierte Container hatten die falschen Knöpfe.**
Die Karte zeigte „▶ Start“ (führt bei `paused` immer zu einem Fehler) und
**keinen** Stop-Knopf. Jetzt: Stop bei `running` **und** `paused`, Neustart und
Pause nur bei `running`, Fortsetzen nur bei `paused`. Der Filter „Gestoppt“
zählte pausierte Container mit — sie gehören unter „Laufend“.

**Limits ließen sich nicht entfernen, die Oberfläche meldete trotzdem Erfolg.**
`memory_mb: 0` liefert `{"success": true}`, das Limit bleibt aber bestehen — das
ist Verhalten der Engine (`docker update --memory 0` tut dasselbe). Der Fehler war
die Rückmeldung. Jetzt kommt eine Warnung: „Docker kann gesetzte Limits im
laufenden Betrieb nicht entfernen — dafür muss der Container neu erstellt werden.“

**Weitere Korrekturen**
- Scheiterte der Start eines neu erstellten Containers (z. B. Port belegt), blieb
  eine Leiche im Zustand `created` liegen, ohne dass die Oberfläche das erwähnte.
- Der Ereignis-Leser prüfte den Leerlauf **vor** dem blockierenden `readline()`.
  Auf einem ruhigen Docker-Daemon wäre der Thread nie beendet worden (samt
  offenem Socket). Ein Wachhund weckt ihn jetzt durch Schließen der Verbindung.
- `/container/archive` meldete bei unbekanntem Container „Pfad nicht gefunden“.
- Fehlermeldungen von `/container/update` liefen nicht durch die Übersetzung —
  ein ungültiges CPU-Set antwortete englisch.
- `tail=0` wurde auf 1 hochgeklemmt und lieferte eine Zeile statt keiner.

**Vom Agenten unabhängig bestätigt:** Die Selbstschutz-Lücke aus Version 1.2 war
real — mit einem **4-stelligen** Id-Präfix wurde eine Datei in den geschützten
Container `linux-dashboard` geschrieben. Der Fix wurde nach dem Ausrollen
gegengeprüft: Präfixe der Länge 2, 4, 8, 12 und 64 liefern jetzt alle 403.

**Als korrekt bestätigt (keine Änderung):** Der Dashboard-Prozess selbst ist in
allen Abbauwegen leckfrei — je Stream exakt +2 Threads/+2 fds, Rückkehr auf die
Grundlinie 2 Threads / 5 fds binnen 0,1–2,2 s, auch bei hartem TCP-Abriss ohne
Close-Frame. Obergrenzen (8 Log-Streams, 4 Konsolen) greifen und geben nach dem
Schließen wieder frei. Erstellungsassistent 28/28 Positiv- und 25/25 Fehlerfälle.
Upload/Archiv inklusive 7-MB-Grenze, Traversal-Abwehr und Selbstschutz. Statistik
0,7–3,3 ms Antwortzeit, RAM- und PID-Werte deckungsgleich mit `docker stats`.

**Rollback:** `backups/*.bak-ctr-*` und `backups/*.bak-exec-*` zurückkopieren,
danach `docker compose restart`.


### 2026-08-15 — Docker-Reiter 1.2: Sicherheitslücken und Falschmeldungen aus dem Agenten-Test

Fünf parallele Test-Agenten haben den Reiter systematisch geprüft. Die Befunde
wurden alle einzeln nachgestellt, bevor sie behoben wurden.

**KRITISCH — Symlink umging die Pfad-Sperre beim Build-Kontext.**
`_path_denied` prüfte nur den mit `os.path.normpath` normalisierten Pfad-String;
`normpath` folgt aber keinen Symlinks. Ein Symlink an erlaubter Stelle
(`/tmp/x -> /etc`) passierte die Sperre, und `nsenter tar -C /tmp/x .` packte
anschließend auf dem Host `/etc` **inklusive `/etc/shadow`** in den Build-Kontext
und damit in ein Image. *Fix:* Der Pfad wird jetzt zusätzlich im Mount-Namespace
des Wirts real aufgelöst (`nsenter realpath -m`) und das Ergebnis mitgeprüft;
die Fehlermeldung nennt das Symlink-Ziel. Gilt auch für Bind-Mount-Quellen im
Erstellungsassistenten.

**SICHERHEIT — Doppelter Schrägstrich umging dieselbe Sperre.**
`os.path.normpath("//etc")` liefert nach POSIX `"//etc"` (genau zwei führende
Slashes bleiben erhalten), der Präfixvergleich gegen `/etc` lief ins Leere.
`//etc/nginx` startete tatsächlich einen Build. *Fix:* führende Mehrfach-Slashes
werden vor der Normalisierung zusammengefasst.

**HOCH — Selbstschutz mit kurzem Id-Präfix umgehbar.**
`_is_self` erkannte Id-Präfixe erst ab 12 Zeichen. Docker löst aber auch
`b2b25fd1` (8 Zeichen) auf den eigenen Container auf — ein `stop` damit hätte das
Dashboard mitten in der Anfrage beendet. *Fix:* Die Längenschranke ist weg, der
Vergleich ist case-insensitiv, und im Zweifel kanonisiert Docker die Referenz
selbst (`_resolve_cid`). Verifiziert mit 2, 4, 8, 10, 12 und 64 Zeichen: **alle 403**.

**SCHWER — Fehlgeschlagene Pull- und Build-Aufträge meldeten Erfolg.**
Docker meldet Fehler *vor* dem Datenstrom als HTTP-Status mit `{"message": …}`,
nicht als `error`-Zeile im Strom. `_docker_json_stream` prüfte den Status nie, also
blieb `got_error` leer und der Auftrag endete mit `status:"done"` — samt grünem
Toast „Geladen", obwohl kein Image existierte. *Fix:* Statusprüfung in
`_docker_json_stream` und im Build-Zweig.

**Weitere Korrekturen**
- Gestoppte Container waren netzseitig **unsichtbar**: `docker_networks` nutzte
  `all=false`, und `/networks/{id}` listet ohnehin nur Laufende. Mitgliederzahl
  zeigte 0, es gab keinen Trennen-Knopf. Jetzt werden sie aus der Containerliste
  ergänzt und in der Oberfläche als „gestoppt“ gekennzeichnet.
- Beim Entfernen eines belegten Netzes erschien **immer** „Eingebautes Netzwerk“:
  Docker antwortet auf aktive Endpunkte mit 403, und der 403-Zweig war für
  eingebaute Netze gedacht — die aber schon vorher per Namen abgefangen werden.
  Die Meldung war damit durchgängig falsch.
- Eingebaute Netze waren nur über den **Namen** geschützt; mit der Id kam man
  daran vorbei. Jetzt wird die Referenz zuerst zum Namen aufgelöst.
- Englische Docker-Rohtexte beim Verbinden werden übersetzt (`_connect_error_de`):
  bereits verbunden, Modus `none`/`host`, IP außerhalb des Subnetzes, IP vergeben.
- Netzwerk-Modus `none` wird in der Oberfläche abgefangen (vorher nur `host`);
  bei `host`/`none` erscheint gar kein Verbinden-Knopf mehr, dafür eine Erklärung.
- Pull-Fortschritt blieb bei 0 %: `„Pulling from …“` trägt den **Tag** als `id` und
  erzeugte eine Phantomschicht, die nie fertig wurde. Jetzt 1/1 statt 1/2.
- Ein bereits vorhandenes Volume meldete „angelegt“ (Docker ist hier idempotent) —
  man hätte auf alten Daten weitergearbeitet. Jetzt eindeutige Meldung.
- `/hub/tags` unterscheidet „nicht gefunden“ von „nicht öffentlich abrufbar“.
- Kartenzähler im Netzwerke-Tab blieb nach dem Trennen veraltet.
- Ein nicht-numerischer `Content-Length` („abc“) warf eine `ValueError` und beendete
  den Request-Thread **ohne HTTP-Antwort** — an drei Stellen abgesichert, liefert
  jetzt 400.

**Bereits vorher als korrekt bestätigt** (keine Änderung nötig): Rollenprüfung
(Nicht-Admin 403 auf allen Pfaden, unauthentifiziert 401, auch für beide
WebSockets), Prefix-Gate gegen Umgehungsversuche (`%2f`, `//`, `/./`, Groß-/
Kleinschreibung), Eingabevalidierung gegen Shell-Metazeichen und Traversal,
Drossel inklusive „GETs bleiben frei“, 10-MB-Body-Grenze, HTML-Escaping im
Frontend (XSS-Versuch über einen Label-Wert blieb wirkungslos), sowie das
Abbau-Verhalten der Streams.

**Verifiziert:** Symlink- und `//`-Umgehung abgelehnt (7 Varianten), Selbstschutz
403 bei 6 Präfixlängen, fehlgeschlagener Pull → `status:"error"` mit Docker-Text,
Build mit fehlendem Dockerfile → `error`, gestoppter Container netzseitig sichtbar
mit „gestoppt“-Kennzeichen, belegtes Netz mit korrekter Meldung abgelehnt, `bridge`
per Id abgelehnt und weiterhin vorhanden, Pull-Fortschritt 1/1, doppeltes Volume
abgelehnt, `Content-Length: abc` → HTTP 400. Smoke-Test unverändert.


### 2026-08-15 — Docker-Reiter 1.1: Netzwerke lassen sich jetzt beim Container zuweisen

**Symptom (vom Nutzer gemeldet):** „Ich kann einem Docker-Container kein Netzwerk
zuweisen."

**Ursache:** Die Funktion gab es nur in *einer* Richtung. Auf der
Container-Detailseite war der Abschnitt „Netzwerke" rein lesend (kein einziger
Knopf), und die Aktionsleiste kannte nur Start/Stop/Kill/Umbenennen/Limits.
Zuweisen ging ausschließlich über den Umweg Netzwerke → Netz auswählen →
„Container verbinden" — also vom Netz aus gedacht statt vom Container. Die API
(`/api/docker/network/connect`) funktionierte die ganze Zeit korrekt; es fehlte
schlicht der Bedienweg an der Stelle, an der man ihn sucht.

**Fix** (`static/app.js`, `static/index.html`, `static/app.css`):
- Im Netzwerk-Abschnitt der Container-Übersicht gibt es jetzt „**+ Netzwerk
  verbinden**" sowie je verbundenem Netz einen „**Trennen**"-Knopf.
- Neuer Dialog `#dk-ctrconnect-modal` mit Netzauswahl, optionaler fester IPv4 und
  Alias. Die Auswahl blendet bereits verbundene Netze sowie `host` und `none` aus;
  gibt es nichts mehr zu verbinden, erscheint ein Hinweis statt eines leeren Felds.
- Container im Netzwerk-Modus **host** bekommen eine Erklärung statt eines Knopfes
  (sie teilen sich den Stack des Wirts und können keinem weiteren Netz beitreten).
- Beim geschützten Container `linux-dashboard` erscheinen weder Verbinden- noch
  Trennen-Knopf; die Trennung wäre backendseitig ohnehin mit 403 abgelehnt worden.
- Nach Verbinden/Trennen wird der Netzwerk-Cache verworfen, damit die
  Mitgliederzahlen im Netzwerke-Tab nicht veralten.

**Verifiziert** (Headless-Chrome, echte Klicks): Auf der Detailseite von
`dash-uitest` erscheint der Knopf, der Dialog listet 18 zuweisbare Netze (bereits
verbundene und `host`/`none` fehlen korrekt), Verbinden mit fester IP `10.99.9.77`
wird von `docker inspect` bestätigt, die Übersicht zeigt danach beide Netze mit
IP und Gateway. Trennen fragt nach und entfernt das Netz. Bei `linux-dashboard`
(geschützt, `host`): kein Verbinden-Knopf, kein Trennen-Knopf, Hinweistext zum
host-Modus vorhanden, Container läuft unverändert weiter.

**Rollback:** `backups/app.js.bak-ctrnet-*`, `backups/index.html.bak-ctrnet-*`,
`backups/docker.py.bak-ctrnet-*` zurückkopieren; reine Frontend-Dateien brauchen
keinen Neustart, für `docker.py` genügt `docker compose restart`.


### 2026-08-15 — Neue Oberfläche erschien erst Tage später (statischer Cache)

**Symptom:** Nach dem Deploy des Docker-Reiters war der neue Navigationspunkt im
Browser nicht zu sehen, obwohl Server und Cloudflare nachweislich die neue
`index.html` und `app.js` auslieferten (`cf-cache-status: MISS`, gleiche
Dateigröße, neue Symbole enthalten).

**Ursache:** `static/` wird über `SimpleHTTPRequestHandler` ausgeliefert und sendet
nur `Last-Modified` — **kein** `Cache-Control`. Browser leiten daraus eine eigene
Haltbarkeit ab (Faustregel: 10 % des Dateialters) und fragen in dieser Zeit gar
nicht erst nach. `index.html` war zuletzt am 27.07. geändert, war also 19 Tage alt
→ rund **2 Tage** heuristische Frische. In dieser Zeit sah man die alte Oberfläche,
ohne dass ein Reload etwas geändert hätte.

**Fix** (`dashboard/handler.py`): Der statische Fallback in `do_GET` setzt jetzt
`self._static_asset = True`, und `end_headers()` hängt für diese Antworten
`Cache-Control: no-cache, must-revalidate` an. Das Flag wird zu Beginn jeder
Anfrage zurückgesetzt (der Handler wird bei Keep-Alive wiederverwendet) und greift
ausschließlich im Datei-Zweig — JSON-Antworten setzen ihren Header unverändert
selbst, es entsteht kein doppelter `Cache-Control`.

**Verifiziert:** `/`, `/index.html`, `/app.js` und `/app.css` liefern den neuen
Header; `/api/docker/system` hat weiterhin genau **eine** `Cache-Control`-Zeile;
eine Anfrage mit `If-Modified-Since` antwortet mit **304 / 0 Bytes** — die
Revalidierung kostet also keine Bandbreite. Smoke-Test unverändert.

**Hinweis:** Einmalig ist noch ein harter Reload nötig (Strg+Shift+R bzw.
Cmd+Shift+R), weil die *bereits* gecachte Kopie im Browser den neuen Header noch
nicht kennt. Ab dann greift die Revalidierung automatisch.


### 2026-08-15 — Neuer Reiter „Docker“: vollständige Container-Verwaltung im Browser

**Was:** Ein neuer, admin-only Navigationsreiter **Docker** mit sechs Unterreitern
(Container, Images, Netzwerke, Volumes, Stacks, System) und einer Detail-Unterseite
je Container (Übersicht, Logs, Stats, Konsole, Inspect, Prozesse, Dateiänderungen).
Funktionsumfang vergleichbar mit Portainer, aber in der Architektur und Optik des
Dashboards.

**Warum:** Auf diesem Host laufen 25 Container produktiv (yoga-*, nextcloud, ntfy,
pxe-*, casino, cloudflared …). Für jeden Handgriff musste man bisher auf Portainer
(`127.0.0.1:9443`) oder SSH ausweichen — obwohl das Dashboard den Docker-Socket
längst gemountet hat und für VMs, Netze und Storage bereits die passende Oberfläche
mitbringt.

**Umsetzung:**
- Neues Modul `dashboard/docker.py` (~2650 Zeilen). Routing in `handler.py`
  (GET-/POST-Ketten, zwei WebSocket-Routen); `_docker_api` aus `consoles.py` wird
  weiterverwendet, im Container gibt es weiterhin kein `docker`-CLI.
- **Streams:** `_docker_stream` / `_docker_frames` / `_docker_json_stream` /
  `_docker_hijack`. Wichtig: Docker-Antworten sind HTTP-**chunked**, der 8-Byte-
  Multiplex-Header liegt *darunter* — es wird deshalb immer aus der `HTTPResponse`
  gelesen, nie aus `conn.sock`. Für `exec` wird der Upgrade von Hand gesprochen,
  weil `http.client` bei 1xx die Länge auf 0 setzt und bereits gepufferte Nutzdaten
  (die erste Shell-Ausgabe) verschluckt.
- **Transportwahl:** WebSocket nur für Logs-Folgen und Konsole. Statistik und
  Ereignisse laufen über je *einen* prozessweiten Hintergrund-Thread mit
  Poll-Endpunkt; Pull und Build sind Hintergrund-Aufträge nach dem Muster von
  `iso_download` — sie laufen weiter, wenn der Reiter gewechselt wird.
- **Statistik:** `/stats?stream=false` braucht **1,01 s pro Container** (Doppel-
  Messung) — für 25 Container unbrauchbar. Mit `one-shot=true` antwortet Docker in
  **2 ms**, liefert dafür kein `precpu_stats.system_cpu_usage`; der Sampler hält
  das vorige Sample selbst und rechnet die Deltas. Er stoppt 15 s nach der letzten
  Anfrage von allein, der Ereignis-Leser nach 60 s.
- **Konsole:** nutzt den vorhandenen VT100-Emulator `class TermScreen` aus
  `app.js` als zweite Instanz — kein xterm.js, keine neue Abhängigkeit, gleiche
  Optik und Mobil-Tastenleiste wie das Host-Terminal.
- **Selbstschutz und Leitplanken:** siehe Abschnitt „Sicherheitskonzept“.
- Mobil brechen die Reiter unter 768 px um, statt horizontal zu scrollen:
  `overflow-x:auto` allein verhindert **nicht**, dass die min-content-Breite der
  sechs Reiter (508 px) das Layout-Viewport auf 560 px aufbläht.

**Verifiziert** (alles gegen den laufenden Host, mit Wegwerf-Objekten
`dash-docker-test*`, `dash-test-net`, `dash-test-vol*`, `dash-teststack`):
- **Selbstschutz:** `stop`, `kill`, `restart`, `rename`, `update` und `remove` auf
  `linux-dashboard` → jeweils **HTTP 403**, geprüft mit Name, `/name`, 12-stelligem
  Id-Präfix und voller 64-Hex-Id; Container blieb durchgehend `Up`, `/api/ping` 200.
- **Container:** Start/Stop/Neustart/Pause/Fortsetzen/Kill inkl. Signalwahl,
  Umbenennen (auch Konflikt auf `ntfy` → saubere Fehlermeldung), Neustart-Regel und
  Limits (64 MB/0,5 CPU → 128 MB/1 CPU, gegen `docker inspect` gegengeprüft),
  Entfernen mit und ohne `force`. Erstellungsassistent mit Ports, Bind, Volume,
  Env, Labels, Limits, Workdir — Ergebnis gegen `docker inspect` verglichen.
- **Streams:** Log-Folgen live (Zeilen wachsen, Filter, Zeitstempel-Umschaltung mit
  Reconnect), Konsole mit `uname -a`, `ls -la /`, `id`, Ctrl-Tasten und Resize
  (`stty size` meldet exakt die gesendeten 40×120).
- **Abbau ohne Reste:** 3 Log- + 3 Konsolen-Streams → fd-Zahl des Prozesses
  5 → 17 → **5**, Threads 2 → 14 → **2**; auch bei hartem TCP-Abriss ohne
  Close-Frame. Obergrenzen greifen (9. Log-Stream und 5. Konsole werden mit
  deutscher Meldung abgewiesen und nach dem Schließen wieder freigegeben).
  Sampler- und Ereignis-Thread beenden sich nach Leerlauf selbst.
- **Aufträge:** Pull `hello-world` mit Layer-Fortschritt; Build eines Dockerfiles
  mit Build-Argument (`docker run` gibt den erwarteten Inhalt aus).
- **Docker Hub:** Suche „nginx“/„redis“ mit Official-/Verified-Kennzeichen,
  Tag-Liste (50 Tags für `redis`); nicht öffentlich gelistete Repositories
  (`dhi/redis`) liefern eine verständliche Meldung statt eines leeren Kastens.
- **Eingabeprüfung:** abgewiesen wurden u. a. `;rm -rf /` als Container-Id,
  `../../etc/passwd` als Dockerfile, `/etc`, `/root`, `/proc/1/root`, `/` und
  `/../etc` als Build-Kontext, `/etc:/host-etc` als Bind, Port 99999, Protokoll
  `quux`, Capability `;id`, CPU-Set `;id`, Umgebungsvariable ohne `=`.
- **Rechte:** Nicht-Admin (`dashnoadm`) erhält auf **jedem** `/api/docker*`-Pfad
  403, unauthentifiziert 401.
- **Regression:** `/root/smoke.py` byte-identisch zur vor Beginn aufgenommenen
  Grundlinie. `/root/mobile_culprit.py docker` → Layout-Viewport **390 px**
  (vor der Reiter-Korrektur 560 px), `vms` unverändert 390 px. Desktop
  (`/root/desk_shot.py`) für Docker, VMs und Dashboard ohne horizontalen Überlauf.
  Alle Testobjekte wurden anschließend entfernt; die 25 produktiven Container sind
  unverändert (19 laufend).

**Noch offen / bewusst nicht ausgeführt:**
- Das **tatsächliche Löschen** per Prune wurde auf diesem Host **nicht** ausgeführt
  — der Trockenlauf meldet 156 ungenutzte Images, 2 Volumes, 5 Netzwerke und
  ~74 GB. Geprüft sind Trockenlauf, Auswahl, Neuberechnung und beide
  Bestätigungsstufen; der eigentliche `POST /api/docker/prune` ist ungetestet.
- **Registry-Login** für private Registries ist nicht enthalten.
- Ein Trockenlauf-Fehler wurde dabei gefunden und behoben: `/networks` liefert
  `Containers: null`, wodurch **jedes** Netz als ungenutzt galt — auch `ntfy_net`,
  `yoga_yoga`, `jellyfin_net` und `portainer_network`. Die Mitgliedschaft wird
  jetzt aus der Containerliste abgeleitet (11 vermeintlich ungenutzte Netze → 5
  tatsächlich ungenutzte).

**Rollback:** Die Sicherungen liegen unter `backups/` mit dem Stempel
`*.bak-docker-20260815-*`. Zurückspielen:
```bash
cd /home/jokergame/linux-dashboard-docker
cp backups/handler.py.bak-docker-20260815-131858  dashboard/handler.py
cp backups/storage.py.bak-docker-20260815-131858  dashboard/storage.py
cp backups/index.html.bak-docker-20260815-132442  static/index.html
cp backups/app.js.bak-docker-20260815-132442      static/app.js
cp backups/app.css.bak-docker-20260815-132442     static/app.css
rm dashboard/docker.py
docker compose restart
```
`dashboard/docker.py` ist neu und hat keine Vorgängerversion — Löschen genügt.
Ohne den Import in `handler.py` wird das Modul nicht mehr geladen.


### 2026-08-12 — Mobil: VM-Seite wurde „zu groß" dargestellt

**Symptom:** Auf dem iPhone wirkte die VM-Sektion überdimensioniert; der Browser
zeigte die Seite herausgezoomt (Netzwerk-Karten dreispaltig und winzig).

**Ursache:** Nicht die VM-Karten — die **ISO-Liste** darunter. Deren Zeilen sind
Flex-Container; der Pfad-Span hatte `white-space:nowrap` **ohne** `min-width:0`
(Flex-Default `min-width:auto` schlägt `max-width:40%`). Lange Pfade wie
`/mnt/hetzner/ISO/AcronisCyberProtectHomeOffice_39620_2021.iso` erzwangen so eine
min-content-Breite von bis zu **780 px** → das Layout-Viewport blähte sich auf
**857 px** auf → mobile Browser zoomen die *gesamte* Seite heraus, VM-Karten wurden
auf 780 px gestreckt.

**Fix:** ISO-Zeile von Inline-Styles auf Klassen umgestellt (`.iso-row`,
`.iso-name`, `.iso-path`, `.iso-del`, `.iso-list-grid`) mit konsequentem
`min-width:0` + `flex-basis:0` beim Namen. Mobil (≤768 px) bricht der Pfad unter den
Namen um, der ✕-Button bleibt in der ersten Zeile. Zusätzlich: der Zahnrad-Button in
`.vm-actions` wird ≤430 px nicht mehr auf halbe Kartenbreite gestreckt (44 px-Quadrat).

**Verifiziert** (Headless-Chrome, 390×844, `deviceScaleFactor` 3): Layout-Viewport
390 px statt 857 px, kein horizontaler Überlauf, VM-Karte 314×173 px; Desktop
(1440 px) optisch unverändert. **Kein Container-Neustart nötig** (`static/` ist
Volume-Mount).

**Noch offen (gleiche Ursache, andere Seiten):** Prozesse (645 px), Dienste (746 px)
und Terminal (927 px) blähen das Layout mobil weiterhin auf.
Diagnose-Werkzeuge: `/root/mobile_culprit.py <seite>` (misst je Element die
min-content-Breite), `/root/mobile_shot.py <seite> <datei> [scrollY]`,
`/root/desk_shot.py` (Desktop-Regression).

### 2026-08-12 — Benutzerverwaltung: Änderungen wirkten erst nach Container-Neustart

**Symptom:** Ein im Dashboard angelegter/geänderter Benutzer konnte sich nicht
anmelden — erst nach `docker compose restart` ging es.

**Ursache:** `/etc/shadow`, `/etc/passwd` und `/etc/group` sind *Datei*-Bind-Mounts.
`useradd`/`chpasswd`/`userdel` schreiben die Datei am Host atomar neu (neuer Inode),
der Container behält den Inode vom Container-Start. Die Anmeldung las **zuerst** die
gemountete (veraltete) Datei und nutzte den Host nur als Fallback, wenn der Benutzer
dort gar nicht stand. Folge: Passwortänderungen und Rechte-Entzug wurden ignoriert,
gelöschte Benutzer konnten sich weiter anmelden — bis zum Neustart.

**Fix** (`dashboard/auth.py`): Die Anmeldung fragt jetzt **immer zuerst den laufenden
Host** ab (`getent shadow` bzw. `id -nG` via `nsenter`); die gemounteten Dateien sind
nur noch Notfall-Fallback, falls der Host-Namespace nicht erreichbar ist. Damit ein
kaputter `nsenter`-Aufruf niemanden aussperrt, gilt „Benutzer existiert nicht" nur,
wenn der Host ihn auch in `passwd` nicht kennt. Zusätzlich beendet `delete_user` alle
offenen Sitzungen des gelöschten Benutzers (`SessionManager.invalidate_user`).

**Verifiziert** (ohne Neustart, über echtes HTTP): Neuanlage → sofort Login; Passwort
ändern → neues gültig, altes ungültig; Admin-Recht entziehen → sofort wirksam; Löschen
→ Login sofort gesperrt; Fallback-Pfad bei simuliert kaputtem `nsenter` funktioniert;
Smoke-Test (26 Endpunkte) unverändert.

### 2026-07-22 — KasmVNC: erste Mausklicks nach Verbinden verloren

Beim Öffnen einer KasmVNC-VM-Konsole waren die ersten Klicks wirkungslos.
Ursache (code-gestützt): der Browser setzt via `resize=remote` direkt nach dem
Verbinden eine neue Displaygröße; `remote-viewer` übernimmt Größen aber nur beim
Verbinden → `_viewer_loop` startete ihn sofort neu, und in diesem Fenster gingen
die ersten Mausklicks verloren. Fix: `remote-viewer` wird beim ERSTEN Mal erst
gestartet, wenn ein Client verbunden und die Displaygröße ~1,5 s stabil ist (max.
8 s Fallback) → kein sofortiger Neustart mehr, Klicks funktionieren von Anfang an.
(Kurze „Verbinde…"-Phase statt Dead-Zone.)

### 2026-07-22 — Neuer Reiter: Benutzerverwaltung

Neuer Nav-Tab **Benutzer** (nur für Admins sichtbar) zum Verwalten der echten
Linux-Host-Benutzer: **erstellen / bearbeiten / löschen**, **Passwort setzen**,
**Anmelde-Shell** und **Admin-Rechte** (= `sudo`-Gruppe = voller Dashboard-Zugriff)
umschalten. Backend `list_users`/`create_user`/`update_user`/`delete_user` via
`useradd`/`usermod`/`gpasswd`/`chpasswd`/`userdel` (nsenter, Passwort über stdin).
Endpunkte `/api/users` + `/api/user/create|update|delete` (admin-gated).

Sicherheit: strenge Namensvalidierung, root nicht löschbar/degradierbar,
System-User (UID < 1000) geschützt, **Selbst-Aussperr-Schutz** (eigene Admin-Rechte
nicht entziehbar, sich selbst nicht löschbar). Wichtig: `authenticate_user`/
`is_sudo_user` lesen jetzt bei Bedarf den **Host live** (`getent`/`id -nG` via
nsenter) — dadurch funktionieren neu angelegte Benutzer/Rechte **sofort**, ohne den
Container neu zu starten (der `/etc/shadow`-Bind-Mount zeigt sonst auf den alten
Inode). Verifiziert: neuer User loggt sich sofort ein.

### 2026-07-20 — ISO als CD-ROM anhängen (Windows sieht virtio-Treiber)

Eine per „Datenträger hinzufügen" angehängte ISO wurde immer als **Festplatte**
(`device='disk'`) angehängt — Windows sieht dann eine rohe Platte statt einer CD
und findet z. B. die virtio-Treiber nicht. Neu: Typ-Auswahl **Datenträger / CD-ROM
(ISO)** im Dialog + ISO-Dropdown; CD-ROM nutzt `attach-disk --type cdrom --mode
readonly` auf SATA. `vm_disk_attach` um `device` erweitert. Verifiziert: virtio-ISO
als CD-ROM → VM startet, Windows sieht die CD.

Außerdem: Existenzprüfung beim Anhängen unterscheidet jetzt „Datei fehlt wirklich"
(Verzeichnis erreichbar → klarer Fehler) von „Mount offline" (`/mnt/hetzner` ist
eine CIFS-Storagebox → nur Warnung, kein Block).

### 2026-07-20 — „Nichts passiert" beim Löschen: eigener Bestätigungsdialog

Wurzelursache gefunden (per Headless-Chrome-Diagnose): destruktive Aktionen nutzten
das native `confirm()`. Wenn der Browser Dialoge unterdrückt (z. B. „Diese Seite
daran hindern, weitere Dialoge zu erzeugen"), gibt `confirm()` **immer false**
zurück — die Aktion tut dann lautlos nichts (Button/Handler/Backend waren korrekt).
Fix: neuer, nicht unterdrückbarer In-App-Dialog `uiConfirm()` (Promise-basiert);
**alle** destruktiven Bestätigungen (Disk/NIC/Gerät entfernen, VM/Snapshot/Volume/
ISO/Netzwerk/Reservierung/Verbindung löschen, XML übernehmen, Prozess killen,
System-Update) darauf umgestellt. Per echtem Klick-Test verifiziert: Disk-Entfernen
öffnet den Dialog und entfernt die Disk.

### 2026-07-19 — ISO-Verwaltung + Disk-Löschen (Speicherdatei)

- **ISO-Verwaltung** (Storage-Bereich, VMs-Seite): Liste aller ISOs mit Größe,
  **ISO von URL laden** (serverseitig via `curl`/nsenter im Hintergrund — auch
  mehrere GB, mit Status-Anzeige) und **ISO löschen**. Backend `iso_list`,
  `iso_download` (Background-Thread + `iso_download_status`), `iso_delete`,
  `_iso_dir` (erstes beschreibbares Ziel, hier `/mnt/hetzner/ISO`). Endpunkte
  `/api/storage/iso/list|downloads|download|delete`.
- **Datenträger löschen**: `vm_disk_detach` bietet jetzt optional
  `delete_storage` — entfernt die Disk aus der VM **und** löscht die zugehörige
  Image-Datei (wie virt-manager „Delete associated storage"). Das Frontend fragt
  bei Disks mit Datei nach, ob die Datei mitgelöscht werden soll, und zeigt die
  Hotplug-Warnung („gilt nach Neustart") an. (Das reine Entfernen aus der VM
  funktionierte bereits; neu ist die Dateilöschung + klare Rückmeldung.)

### 2026-07-19 — Mobile VM-Konsole: Tastatur (IME) Bugfix

Die mobile Bildschirmtastatur in der VM-Konsole (KasmVNC) funktionierte nicht
richtig (fehlende/falsche Zeichen, Layout). Ursache: der KasmVNC-Client setzt
`enable_ime` per Default auf **false** → er nutzt `_screenInput` (erwartet
physische keydown-Events, die Soft-Keyboards nicht zuverlässig liefern) statt des
IME-`_touchInput`. Fix: `_kasm_client_inject` erzwingt jetzt auf Mobilgeräten
`enable_ime=true` (analog zu `resize`/`clipboard`), sodass der IME-Pfad genutzt
wird und der Tastatur-Button den richtigen Eingabe-Fokus setzt. (Die
Zwischenablage-Richtungen wurden bereits zuvor via `clipboard_up/_down=true`
erzwungen.) Gilt nur für Mobile; Desktop nutzt weiter die physische Tastatur.

### 2026-07-19 — Bugfixes: Netz-Status, Disk/NIC-Hotplug, Windows-VM-Erstellung

- **Netzwerke wurden immer als „inaktiv" angezeigt** — `list_networks` verglich die
  `State`-Spalte (`active`/`inactive`) fälschlich mit `yes`. Jetzt korrekt.
- **Disk/NIC entfernen wirkte bei laufenden VMs nicht sofort** — Attach/Detach
  liefen nur mit `--config` (erst nach Neustart). Neuer `_hotplug`-Helfer:
  laufende VM → `--live --config` (sofort), Fallback `--config` mit Hinweis
  (z.B. SATA/IDE ohne Hotplug); ausgeschaltete VM → `--config`.
- **VM-Erstellung für Windows** — Windows kennt virtio-Disk/-NIC ohne Treiber nicht
  (Festplatte/Netzwerkkarte „fehlten"). Neu: **Betriebssystem-Auswahl** (Linux/
  Windows, mit Auto-Erkennung am ISO-Namen). Windows → **SATA-Disk + e1000e-NIC**
  (nativ unterstützt) und optional die **virtio-win-Treiber-ISO** als zweites
  CD-ROM (im Dialog wählbar). `vm_create` um `os_type`/`virtio_iso` erweitert.
  Verifiziert: Windows-VM (SATA/e1000e/virtio-CD) startet real; Linux bleibt virtio.

### 2026-07-19 — Netzwerke &#252;berarbeitet + VM-Konsolen (VNC/SPICE/kasmVNC) schaltbar

**Globale Netzwerke** (gelten für alle VMs): Karten zeigen jetzt Bridge-Name und
Anzahl verbundener Gäste. Neu pro Netzwerk: „Verbundene" (DHCP-Leases: IP/Hostname/
MAC) und „XML" (roher Netzwerk-XML-Editor). Backend: `list_networks` um
`bridge`/`leases` erweitert; `net_leases`, `net_get_xml`, `net_set_xml`; Endpunkte
`/api/network/leases|xml`. GET-Admin-Gate deckt jetzt `/api/network/*`.

Zusätzlich: **geführter „Bearbeiten"-Dialog** (Forward-Modus, Gateway-IP/Prefix,
DHCP-Range an/aus — `net_edit`, `net-define`, gilt nach Netz-Neustart) und
**statische DHCP-Reservierungen** (MAC→IP+Hostname — `net_add_dhcp_host`/
`net_remove_dhcp_host` via `net-update --live --config`, sofort wirksam;
`net_dhcp_hosts` listet sie). Endpunkte `/api/network/edit`,
`/api/network/dhcp-host/add|remove`, `/api/network/dhcp-hosts`. Netz-Config-
Funktionen lesen die **persistente** Config (`net-dumpxml --inactive`).

**VM-Konsolen-Verbindungen** (Hardware-Tab, „Konsolen-Verbindungen"):
- **VNC** an/aus — fügt/entfernt `<graphics type='vnc'>`.
- **SPICE** an/aus — fügt/entfernt `<graphics type='spice'>` + SPICE-Agent-Kanal
  (`com.redhat.spice.0`) für Clipboard/Auto-Resize.
- **kasmVNC** an/aus — Dashboard-Präferenz (Viewer über VNC/SPICE), persistent in
  `vm_kasmvnc_off.json`; steuert die Sichtbarkeit des KasmVNC-Konsolen-Buttons.

Backend: `vm_set_graphics`, `set_kasmvnc_pref`; `get_vm_full` liefert
`has_vnc`/`has_spice`/`kasmvnc_enabled`; Endpunkte `/api/vm/graphics|kasmvnc`.
Verifiziert: VM mit umgeschalteten VNC+SPICE startet real.

### 2026-07-19 — VM: „Hardware hinzuf&#252;gen" (alle Ger&#228;tetypen) + XML-Editor

Volle virt-manager-artige Ger&#228;teverwaltung. Zwei neue Tabs auf der VM-Detailseite:

- **Ger&#228;te**: Liste aller Geräte (aus `<devices>`) mit Entfernen-Button, plus
  „Hardware hinzufügen" für: QEMU-Gast-Agent-/SPICE-Kanal, Tablet/Tastatur,
  USB-3-Controller, **USB-Passthrough** & **PCI-Passthrough** (Host-Geräte-Auswahl),
  **virtiofs-Shared-Folder**, Datenträger (Image, Bus/Format/CD-ROM/RO),
  Netzwerkkarte, Sound, RNG, USB-Redirection, Smartcard, Watchdog, VSOCK,
  Panic-Notifier, serielle Konsole.
- **XML** (Experten-Modus): rohes Domain-XML anzeigen/bearbeiten/`define` — der
  Catch-all für *jegliche* Konfiguration (mit Schutz: `<name>` muss erhalten bleiben).

Backend: `vm_add_device`/`vm_remove_device` (per-Index, ElementTree),
`vm_device_list`, `vm_get_xml`/`vm_set_xml`, `list_host_devices` (USB/PCI via
lsusb/lspci). Endpunkte `/api/vm/device/add|remove`, `/api/vm/xml`,
`/api/vm/devices`, `/api/vm/hostdevices` (alle admin-gated). Eingaben streng
validiert (Hex-IDs, absolute Pfade, Mount-Tags). virtiofs erg&#228;nzt automatisch
`<memoryBacking>` (shared/memfd). Verifiziert: VM mit 6 Geräten inkl. virtiofs
startet real.

### 2026-07-19 — VM-Bearbeitung: virt-manager-Funktionen + Live-Auslastung

Die VM-Detailseite deutlich erweitert (Design/Tabs beibehalten, mobil zugänglich):

- **Live-Auslastung** (Overview-Tab): CPU% und RAM% als Balken, Poll alle 2,5 s bei
  laufender VM. Backend `vm_stats()` misst CPU aus zwei `cpu.time`-Samples und RAM
  aus `balloon`-Statistiken (Gast-Agent) mit Host-RSS-Fallback. Endpunkt
  `GET /api/vm/stats` (admin-gated). Poll stoppt automatisch bei Tab-/Seitenwechsel.
- **Secure Boot** an/aus (Hardware-Tab): setzt `<os firmware='efi'>` +
  `<firmware><feature name='secure-boot'…></firmware>` + `<smm state='on'/>`; nutzt
  die libvirt-Auto-Firmware (OVMF-Secboot).
- **TPM 2.0** (emuliert via swtpm) hinzufügen/entfernen — Pflicht für Windows 11.
- **Firmware BIOS/UEFI** klar umschaltbar; Secure-Boot-Checkbox nur bei UEFI aktiv.
- **Boot-Menü** (F12) an/aus (Boot-Tab), zusätzlich zur Boot-Reihenfolge.
- **CPU** (Sockets/Cores/Threads, Modus) und **RAM (max)** editierbar (schon
  vorhanden, jetzt neben den neuen Optionen gebündelt).
- Overview zeigt Secure-Boot-/TPM-Status.

`vm_update` um `secure_boot`, `add_tpm`/`remove_tpm`, `boot_menu` erweitert;
`get_vm_full` erkennt die Zustände. Verifiziert gegen echte libvirt inkl.
kombiniertem „Windows-11-Ready" (UEFI+SecureBoot+TPM+Bootmenü+CPU/RAM in einem
Schritt) — die VM startet damit real.

### 2026-07-18 — Zwischenablage (VM-Konsolen + Browser-Sessions): Bugfix

Copy/Paste zwischen Browser und VM/Browser-Session funktionierte je nach Client
nicht (v. a. Richtung **„Von VM"**). Ursache: Der KasmVNC-Client initialisiert die
Settings `clipboard_up`/`clipboard_down` **konditional** — auf manchen Browsern/
Kontexten mit Default **false**. Die Empfangs-Logik (`clipboardReceive`) ist an
`rfb.clipboardDown`, die Seamless-Sende-Logik an `rfb.clipboardUp` gekoppelt; standen
sie auf false, wurde der Gast-Clipboard-Text nie in die Textarea übernommen.

Fix: `_kasm_client_inject` erzwingt jetzt (wie schon `resize=remote`)
`clipboard_up=true` und `clipboard_down=true` in `localStorage`, bevor der Client
die Settings liest. Wirkt zentral für **beide** Pfade (VM-Konsolen `/kasmvnc-vm/…`
und Browser-Sessions `/kasmvnc/…`). Die serverseitige VM-Kette (`vncconfig -nowin`
→ X-CLIPBOARD → remote-viewer/SPICE → Gast-vdagent) war bereits korrekt aufgesetzt.

### 2026-07-16 — Host-Terminal: Test + Bugfixes

Ausführlicher Test beider Terminals. Das **interaktive WS-PTY** (`/api/terminal/ws`,
xterm.js) arbeitet einwandfrei: top (Vollbild-UI), nano (inkl. echtem Speichern),
less (Paging/`G`/`q`), vim, Ctrl+C→SIGINT und Resize (`stty size` folgt) alle
verifiziert.

Im **REST-Terminal** (`/api/terminal`, `_PtySession`) 3 Bugs behoben:
- **Returncode war immer 0** — `export PS1="…$?…"` (Doppel-Quotes) expandierte `$?`
  schon beim `export`. Jetzt Einfach-Quotes → `$?` expandiert zur Prompt-Zeit;
  cwd-Regex an das Prompt-Zeichen (`#`/`$`) angepasst.
- **Ctrl+C/`interrupt()` wirkungslos** — das PTY war nicht Controlling-Terminal
  (kein `TIOCSCTTY`), `\x03` erzeugte kein SIGINT. Jetzt gesetzt (wie im WS-PTY).
- **Escape-Reste in der Ausgabe** — `_strip_ansi` entfernte private CSI-Sequenzen
  (Bracketed-Paste `\x1b[?2004h/l`) nicht. Regex um `?` erweitert.

### 2026-07-16 — Browser-Sessions: Test + Robustheits-Härtung

Erschöpfender Test der kasmweb-Browser-Sessions (Start/Stop, Image-Allowlist,
Owner-Filter/IDOR, kasmweb-HTTPS + Basic-Auth, audio-Flag, Proxy-Owner-Check,
Mobile-/Desktop-Injection). **Keine funktionalen Bugs** — Kern arbeitet korrekt
und sicher (u. a. `vnc_password` wird an beiden Endpoints entfernt, Owner-Checks
in `_kasmvnc_http_proxy`/`_kasmvnc_ws_proxy` greifen).

Zwei **Robustheits-Bugs** (Datenverlust-Vektor) behoben:
- **`_save` war nicht atomar** (`write_text`) → ein Crash mitten im Schreiben
  konnte `browser_sessions.json` abschneiden. Jetzt atomar (temp + `os.replace`).
- **`_cleanup_orphan_browser_containers` löschte laufende Container**, wenn die
  Persistenzdatei fehlte/kaputt war (bei `recover()` mit leerem Known-Set →
  **alle** Nutzer-Sessions weg). Jetzt werden **laufende** Container niemals
  automatisch entfernt (nur gestoppte Leichen), in allen Codepfaden.

### 2026-07-15 — VM-Konsolen (VNC/SPICE/KasmVNC): Bugfixes

Erschöpfender Test der Konsolen-Pipeline (websockify-Proxy, per-VM-KasmVNC,
Token-Proxy, Mobile-/Desktop-HTML-Injection) gegen echte VM. Kern-Pipeline
verifiziert korrekt (VNC/SPICE/KasmVNC end-to-end, Mobile-Patches valide);
4 Bugs behoben:

- **Popup-Blocker (v. a. Mobile/iOS):** `openConsole`/`openConsoleByName` riefen
  `window.open` erst **nach** dem `await` → Browser blockierten das Fenster. Jetzt
  wird das Fenster synchron in der Klick-Geste geöffnet und danach navigiert;
  Fallback in denselben Tab, falls dennoch blockiert.
- **KasmVNC nur mit VNC nutzbar:** Der Handler erzwang ein VNC-Display, obwohl er
  SPICE bevorzugt → SPICE-only-VMs konnten kein KasmVNC. Jetzt genügt SPICE **oder**
  VNC (Backend + Button-Gating).
- **Falscher Binär-Check:** Install-Prüfung testete nur `/usr/bin/Xkasmvnc`, der
  Manager nutzt aber `Xkasmvnc15`. Prüft jetzt beide.
- **Irreführende Fehlermeldung:** `get_vm_display` meldete für nicht existente VMs
  „virsh nicht verfügbar" statt des echten virsh-Fehlers.

### 2026-07-15 — VM-Verwaltung: Bugfixes

Systematischer Test aller VM-Funktionen (create/update/delete/clone/snapshots/
disk/nic) gegen echte libvirt-Umgebung; 7 Bugs gefunden und behoben:

- **`vm_disk_attach`** prüfte die Datei-Existenz im Container-FS statt im
  Host-Namespace → jedes reale Volume wurde abgelehnt. Jetzt Existenzprüfung
  auf dem Host via `nsenter` (Guards gegen `/dev`,`/etc`,… bleiben erhalten).
- **`vm_snapshot_list`** parste `snapshot-list --tree` (Baum) spaltenweise →
  Müll-Namen. Jetzt Spaltenformat.
- **`vm_update(remove_sound)`** nutzte `Element.find("..")` (in ElementTree
  nicht unterstützt) → entfernte nie etwas. Jetzt Entfernung aus `<devices>`.
- **`vm_update(cpu_mode)`** scheiterte für `host-model`/`custom` (übrig
  gebliebenes `migratable`-Attribut). Wird jetzt beim Moduswechsel entfernt.
- **`vm_update(firmware="uefi")`** scheiterte (fehlendes ACPI/nvram). Nutzt jetzt
  libvirt-Auto-Firmware (`<os firmware='efi'>`) + ACPI; `get_vm_full` erkennt den
  Modus korrekt. Neue VMs erhalten `<features><acpi/><apic/></features>`.
- **`vm_update(vcpus)`** scheiterte, wenn bereits eine CPU-Topologie gesetzt war.
  Die Topologie wird jetzt vor dem Setzen der vCPU-Zahl entfernt.
- **`vm_delete`** scheiterte an VMs **mit Snapshots** und an per-Pfad angehängten
  Volumes. Jetzt `undefine --snapshots-metadata --managed-save --nvram` mit
  Fallback ohne Storage-Removal.

Verifiziert: 17/17 Prüfpunkte grün gegen echte libvirt, Testumgebung restlos
aufgeräumt.

### 2026-07-15 — Sicherheits-Härtung

Vollständige Sicherheitsprüfung von Backend (`server.py`) und Frontend
(`static/index.html`); alle gefundenen Lücken behoben und getestet.

**Autorisierung (kritisch)**
- Rollenbasiertes Admin-Gate für **alle** host-verändernden Endpunkte
  (`/api/vm/*`, `/api/network/*`, `/api/storage/*`, `/api/service/*`,
  `/api/process/*`) in `do_GET` und `do_POST`. Zuvor waren nur Terminal/Update/
  Keymap geschützt — ein Nicht-Admin-Login konnte VMs anlegen/löschen, Dienste
  stoppen und Prozesse killen (Privilege Escalation).
- `is_sudo_user` schlägt jetzt **fail-closed** (kein Admin bei unlesbarer Gruppendatei).

**Injection**
- `vm_create` / `net_create`: strenge Namensvalidierung + XML-Escaping
  (`quoteattr`/`escape`) → keine Domain-/Netzwerk-XML-Injection mehr.
- `vm_disk_attach`: Guard gegen Host-Blockgeräte/Systempfade (`/dev`, `/etc`, …).
- Browser-Sessions: striktes Image-Allowlisting (kein Roh-Image-Fallback).

**WebSocket-Token-Lifecycle**
- Tokens an Besitzer gebunden, TTL 12 h → 30 min, sofortige Invalidierung bei
  Proxy-Teardown; `/ws/` und `/kasmvnc-vm/` erfordern gültige Session + Owner-Match.

**Weitere**
- SSRF-Schutz für externe Verbindungen (Loopback/Metadaten geblockt, LAN erlaubt).
- Browser-Session-IDOR behoben (Owner-Prüfung im Proxy).
- Login-Rate-Limit (8/60 s), 10-MB-Body-Cap, `Referrer-Policy: no-referrer`.
- Frontend: `escHtml` escaped jetzt `'`/`` ` ``; alle roh gerenderten Backend-Daten
  (Prozesse, Services, System, Netzwerk, Disks, Updates) abgesichert → Stored-XSS
  geschlossen. `index.html.bak` aus dem Webroot entfernt.

**Getestet:** alle Lese-/Info-Funktionen, Validierungs-/Guard-Zweige, End-to-End-
Autorisierungsmatrix (admin vs. non-admin), Login/Rate-Limit, Token-Lifecycle sowie
schreibende Pfade (VM/Netzwerk/Volume create→verify→delete) — alle grün.

> Backups vor der Härtung: `server.py.sec-backup-20260715`, `backups/index.html.bak.*`
