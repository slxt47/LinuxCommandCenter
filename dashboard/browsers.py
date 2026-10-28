import json
import os
import re
import shlex
import subprocess
import signal
import sys
import time
import threading
import socket
import secrets
import hashlib
import base64
import struct
import select
import pty
import fcntl
import termios
import http.client
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape as _xml_escape, quoteattr as _xml_attr
from http.server import HTTPServer, SimpleHTTPRequestHandler
from http.cookies import SimpleCookie
from socketserver import ThreadingMixIn
from urllib.parse import urlparse, parse_qs
from pathlib import Path

from dashboard.base import SESSIONS_FILE
from dashboard.consoles import _docker_api


# ─── Automatische Idle-Pause ─────────────────────────────────────────────────
# Ein kasmweb-Container läuft weiter, auch wenn niemand hinschaut: der Browser
# darin rendert Seiten, spielt Videos, führt JS-Timer aus — dauerhafte CPU-Last
# pro offener Session. Sessions ohne sichtbaren Client werden deshalb nach
# BROWSER_IDLE_PAUSE_MIN Minuten per `docker pause` eingefroren.
#
# `docker pause` nutzt den cgroup-Freezer: ALLE Prozesse im Container werden
# angehalten (wie SIGSTOP), RAM-Inhalt, offene Dateien und TCP-Verbindungen
# bleiben unangetastet. CPU-Verbrauch geht auf 0. Beim `unpause` läuft alles
# exakt dort weiter, wo es angehalten wurde — gleiche Tabs, gleiche
# Scrollposition, gleiche Anmeldungen. Genau das gewünschte „beim Ursprung".
#
# Aktivität wird an drei Stellen registriert (siehe handler.py):
#   1. HTTP-Zugriff auf /kasmvnc/<sid>/…      (Seite wird geöffnet)
#   2. WebSocket-Verbindung /kasmvnc-ws/<sid> (Client verbindet sich)
#   3. Heartbeat /api/browser/ping             (Tab ist sichtbar, alle 60 s)
# Ein Tab im Hintergrund oder ein geschlossener Tab sendet keinen Heartbeat →
# die Session gilt als unbenutzt. Ein sichtbarer Tab hält sie wach, auch wenn
# gerade nur zugesehen wird (Video).
_DEFAULT_IDLE_MIN = 15


def _idle_pause_minutes():
    """Leerlauf-Minuten bis zur Pause. 0 = Automatik deaktiviert."""
    try:
        return max(0, int(os.environ.get("BROWSER_IDLE_PAUSE_MIN", _DEFAULT_IDLE_MIN)))
    except (TypeError, ValueError):
        return _DEFAULT_IDLE_MIN



BROWSER_MEM_LIMIT = 6 * 1024 ** 3     # 6 GiB RAM je Browser-Container
BROWSER_SWAP_EXTRA = 4 * 1024 ** 3    # zusätzlich erlaubter Swap
# CPU-Deckel: ein einzelner Tab mit Endlos-Videodekodierung (Decoder-Neustart-
# Schleife auf einer Konfigurator-Seite) zog am 06.10.2026 ~6,5 Kerne über
# Stunden. Mehr als 4 Kerne braucht eine Browser-Session nie.
BROWSER_CPU_LIMIT = 4                 # Kerne je Browser-Container
# Firefox-Policy (Autoplay für Audio+Video blockieren), Host-Pfad für den Bind.
BROWSER_FF_POLICIES = "/var/lib/linux-dashboard/firefox-policies.json"
# KasmVNC-Konfiguration (legt install.sh aus config/kasmvnc.yaml an), Host-Pfad für den Bind.
BROWSER_KASMVNC_YAML = "/var/lib/linux-dashboard/kasmvnc.yaml"

# ─── Runaway-Tab-Wächter ─────────────────────────────────────────────────────
# Ein Tab-Prozess (firefox -contentproc -isForBrowser), der über RUNAWAY_WINDOW
# Sekunden im Schnitt mehr als RUNAWAY_CORES Kerne verbraucht, wird per SIGTERM
# beendet. Firefox zeigt dann nur für diesen Tab „Tab abgestürzt" (Neu laden
# genügt), Session und andere Tabs bleiben unberührt. 0 = Wächter aus.
def _env_float(name, default):
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default

RUNAWAY_CORES = _env_float("BROWSER_RUNAWAY_CORES", 2.5)
RUNAWAY_WINDOW = 600
_CLK_TCK = os.sysconf("SC_CLK_TCK")

class BrowserSessionManager:
    """Launches and manages browser containers (kasmweb/firefox, etc.) via Docker."""

    IMAGES = {
        "firefox":  "kasmweb/firefox:1.19.0-rolling-weekly",
        "chromium": "kasmweb/chrome:1.19.0-rolling-weekly",
    }
    _CONTAINER_PORT = 6901   # kasmweb HTTPS port inside container
    _PORT_RANGE = range(7000, 7100)
    _WATCH_INTERVAL = 30     # Sekunden zwischen zwei Leerlauf-Prüfungen

    def __init__(self):
        self._sessions = {}
        self._lock = threading.Lock()
        self._watcher = None
        self._last_touch_save = 0.0
        self._cpu_samples = {}   # pid -> [(zeit, cpu_ticks, starttime), ...]

    def _free_port(self):
        with self._lock:
            used = {s["port"] for s in self._sessions.values()}
        for port in self._PORT_RANGE:
            if port in used:
                continue
            try:
                with socket.socket() as s:
                    s.bind(("", port))
                    return port
            except OSError:
                continue
        raise RuntimeError("Kein freier Port im Bereich 7000-7099")

    def _save(self):
        """Persist current sessions to disk (call while holding _lock)."""
        data = list(self._sessions.values())
        try:
            # Atomar schreiben: temp + os.replace — sonst kann ein Crash mitten im
            # Schreiben die Datei abschneiden, was recover() beim nächsten Start als
            # „keine Sessions" interpretieren und laufende Container löschen würde.
            tmp = SESSIONS_FILE.with_name(SESSIONS_FILE.name + ".tmp")
            tmp.write_text(json.dumps(data))
            os.replace(tmp, SESSIONS_FILE)
        except Exception:
            pass

    def _container_state(self, container_name):
        """'running' | 'paused' | 'stopped' | None (Container existiert nicht)."""
        try:
            status, info = _docker_api("GET", f"/containers/{container_name}/json")
            if status == 200:
                state = info.get("State", {})
                # Achtung: bei einem pausierten Container ist Running WEITERHIN true —
                # Paused deshalb zuerst prüfen.
                if state.get("Paused"):
                    return "paused"
                if state.get("Running"):
                    return "running"
                return "stopped"
        except Exception:
            pass
        return None

    def _container_running(self, container_name):
        """Return True if the named container exists and is running (auch pausiert)."""
        return self._container_state(container_name) in ("running", "paused")

    def _start_container(self, container_name):
        """docker start. True bei Erfolg (304 = läuft bereits)."""
        if not container_name:
            return False
        try:
            status, _resp = _docker_api("POST", f"/containers/{container_name}/start")
        except Exception:
            return False
        return status in (200, 204, 304)

    def recover(self):
        """On startup: load saved sessions, restart stopped containers, drop sessions
        whose container no longer exists, delete orphaned lcc-browser-* containers
        not in the session list."""
        if not SESSIONS_FILE.exists():
            _cleanup_orphan_browser_containers(set())
            return

        try:
            saved = json.loads(SESSIONS_FILE.read_text())
        except Exception:
            _cleanup_orphan_browser_containers(set())
            return

        recovered = {}
        now = time.time()
        for s in saved:
            sid = s.get("id")
            cname = s.get("container_name")
            if not sid or not cname:
                continue
            state = self._container_state(cname)
            if state == "stopped":
                # Nach einem Host-Neustart liegen Container ohne Restart-Policy
                # gestoppt da. Das ist weiterhin die Session des Nutzers (Profil,
                # Lesezeichen, Logins liegen im Container) — wieder starten statt
                # sie zu verwerfen und vom Orphan-Cleanup löschen zu lassen.
                if self._start_container(cname):
                    state = "running"
                    print(f"[browser] Session {sid}: gestoppten Container wieder gestartet",
                          file=sys.stderr, flush=True)
                else:
                    # Start gescheitert (z. B. Docker beim Boot noch nicht so weit):
                    # Session behalten, ensure_running() versucht es beim Zugriff erneut.
                    print(f"[browser] Session {sid}: Container gestoppt, Start fehlgeschlagen"
                          " — bleibt erhalten", file=sys.stderr, flush=True)
                    s["status"] = "stopped"
                    s.pop("paused_at", None)
                    s.pop("paused_auto", None)
                    recovered[sid] = s
                    continue
            if state in ("running", "paused"):
                # Echten Container-Zustand übernehmen: eine vor dem Neustart
                # pausierte Session bleibt pausiert (und wird beim nächsten
                # Zugriff wieder aufgetaut).
                s["status"] = state
                # Nach einem Dashboard-Neustart ist die letzte Aktivität unbekannt.
                # Frisch stempeln, damit laufende Sessions eine volle Karenzzeit
                # bekommen statt sofort pausiert zu werden.
                if state == "running":
                    s["last_active"] = now
                    s.pop("paused_at", None)
                    s.pop("paused_auto", None)
                else:
                    s.setdefault("last_active", now)
                recovered[sid] = s

        with self._lock:
            self._sessions = recovered
            self._save()

        known_names = {s["container_name"] for s in recovered.values()}
        _cleanup_orphan_browser_containers(known_names)

    def start(self, image_key, label="", owner="", audio=False):
        """Start a kasmweb browser container. Pulls image if not present. Returns session dict."""
        # Nur freigegebene Images — kein Roh-Fallback auf beliebige Registry-Images.
        if image_key not in self.IMAGES:
            raise RuntimeError(f"Unbekanntes Image: {image_key}")
        image = self.IMAGES[image_key]
        port = self._free_port()
        sid = secrets.token_urlsafe(8)
        container_name = f"lcc-browser-{sid}"
        vnc_password = secrets.token_urlsafe(12)

        env = [
            f"VNC_PW={vnc_password}",
            "VNC_RESOLUTION=1280x720",
            "MAX_FRAME_RATE=24",
            "VNCOPTIONS=-PreferBandwidth -DynamicQualityMin=3 -DynamicQualityMax=6 -DLP_ClipDelay=0 -RectThreads=4",
            "KASM_SVC_PRINTER=0",
            "KASM_SVC_SMARTCARD=0",
            "KASM_SVC_GAMEPAD=0",
        ]
        if not audio:
            env += ["KASM_SVC_AUDIO=0", "KASM_SVC_AUDIO_INPUT=0"]

        body = {
            "Image": image,
            "Env": env,
            "ExposedPorts": {"6901/tcp": {}},
            "HostConfig": {
                # Nur lokal: das Dashboard (Host-Netz) spricht 127.0.0.1 an; ohne
                # HostIp lauschte der Browser auf 0.0.0.0 (Audit 2026-10-20).
                "PortBindings": {"6901/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(port)}]},
                "ShmSize": 2 * 1024 * 1024 * 1024,
                "Binds": [],
                # Ohne Restart-Policy bleibt der Container nach einem Host-Neustart
                # gestoppt liegen (und wurde früher von recover() samt Profil gelöscht).
                "RestartPolicy": {"Name": "unless-stopped"},
                # RAM-Deckel: ohne Limit wuchs ein einzelner Firefox-Tab über Tage auf
                # >13 GiB. Darüber hinaus darf der Container noch 4 GiB swappen, bevor
                # der OOM-Killer (nur den größten Tab-Prozess) trifft.
                "Memory": BROWSER_MEM_LIMIT,
                "MemorySwap": BROWSER_MEM_LIMIT + BROWSER_SWAP_EXTRA,
                "NanoCpus": BROWSER_CPU_LIMIT * 10 ** 9,
            },
        }
        # Mount our kasmvnc.yaml so it takes precedence over the container defaults,
        # fixing the FrameRate/DynamicQualityMax overrides from the vncserver wrapper.
        # Nur wenn sie als Datei existiert: Fehlt sie, legt Docker an ihrer Stelle ein
        # Verzeichnis an und der Container-Start scheitert mit HTTP 400.
        if os.path.isfile("/data/" + os.path.basename(BROWSER_KASMVNC_YAML)):
            body["HostConfig"]["Binds"].append(
                f"{BROWSER_KASMVNC_YAML}:/etc/kasmvnc/kasmvnc.yaml:ro")
        if os.path.exists("/data/" + os.path.basename(BROWSER_FF_POLICIES)):
            body["HostConfig"]["Binds"].append(
                f"{BROWSER_FF_POLICIES}:/etc/firefox/policies/policies.json:ro")

        status, resp = _docker_api("POST", f"/containers/create?name={container_name}", body)

        if status == 404:
            # Image not present — pull it (blocks until complete)
            _img_name, _, _img_tag = image.partition(":")
            _img_tag = _img_tag or "latest"
            pull_status, pull_resp = _docker_api(
                "POST", f"/images/create?fromImage={_img_name}&tag={_img_tag}"
            )
            if pull_status not in (200, 201):
                raise RuntimeError(f"Image '{image}' konnte nicht heruntergeladen werden")
            status, resp = _docker_api("POST", f"/containers/create?name={container_name}", body)

        if status not in (200, 201):
            raise RuntimeError(resp.get("message", f"Container-Fehler (HTTP {status})"))

        container_id = resp["Id"]
        start_status, _ = _docker_api("POST", f"/containers/{container_id}/start")
        if start_status not in (200, 204):
            _docker_api("DELETE", f"/containers/{container_id}?force=true")
            raise RuntimeError(f"Container konnte nicht gestartet werden (HTTP {start_status})")

        # Wait up to 20 s for kasmweb's HTTPS server to be ready
        for _ in range(40):
            time.sleep(0.5)
            try:
                import ssl as _ssl
                _ctx = _ssl.create_default_context()
                _ctx.check_hostname = False
                _ctx.verify_mode = _ssl.CERT_NONE
                with socket.create_connection(("127.0.0.1", port), timeout=0.3) as _s:
                    _ctx.wrap_socket(_s, server_hostname="127.0.0.1")
                    break
            except Exception:
                pass

        session = {
            "id":             sid,
            "image":          image,
            "image_key":      image_key,
            "label":          label or image_key.capitalize(),
            "port":           port,           # host port mapped to container's 6901
            "vnc_password":   vnc_password,   # kasmweb login password
            "container_id":   container_id,
            "container_name": container_name,
            "status":         "running",
            "owner":          owner,
            "viewers":        [],            # von Superadmins freigegebene Benutzer
            "last_active":    time.time(),
        }
        with self._lock:
            self._sessions[sid] = session
            self._save()
        return dict(session)

    def get_raw(self, sid):
        """Return session dict without permission check (for internal proxy use)."""
        with self._lock:
            s = self._sessions.get(sid)
            return dict(s) if s else None

    # ── Aktivität / Idle-Pause ───────────────────────────────────────────────

    def touch(self, sid, save=False):
        """Session als „gerade benutzt" markieren (Heartbeat, HTTP- oder WS-Zugriff)."""
        now = time.time()
        with self._lock:
            s = self._sessions.get(sid)
            if not s:
                return
            s["last_active"] = now
            # Heartbeats kommen im Minutentakt pro Session — nicht bei jedem
            # Stempel auf die Platte schreiben, höchstens einmal pro Minute.
            if save or now - self._last_touch_save > 60:
                self._last_touch_save = now
                self._save()

    def _set_container_pause(self, container_name, pause):
        """docker pause/unpause. True bei Erfolg (409 = bereits im Zielzustand)."""
        if not container_name:
            return False
        action = "pause" if pause else "unpause"
        try:
            status, _resp = _docker_api("POST", f"/containers/{container_name}/{action}")
        except Exception:
            return False
        return 200 <= status < 300 or status == 409

    def _apply_pause(self, sid, pause, auto=False):
        """Zustand umschalten und persistieren. Gibt den neuen Status zurück."""
        with self._lock:
            s = self._sessions.get(sid)
            if not s:
                return None
            cname = s.get("container_name")
            target = "paused" if pause else "running"
            if s.get("status") == target:
                if not pause:
                    s["last_active"] = time.time()
                    self._save()
                return target
        if not self._set_container_pause(cname, pause):
            return None
        with self._lock:
            s = self._sessions.get(sid)
            if not s:
                return None
            s["status"] = target
            if pause:
                s["paused_at"]  = time.time()
                s["paused_auto"] = bool(auto)
            else:
                s.pop("paused_at", None)
                s.pop("paused_auto", None)
                s["last_active"] = time.time()
            self._save()
        return target

    def pause(self, sid, owner="", is_admin=False):
        """Session manuell einfrieren (Berechtigung wird geprüft)."""
        s = self.get(sid, owner=owner, is_admin=is_admin)
        if not s:
            raise PermissionError("Keine Berechtigung")
        return self._apply_pause(sid, True) == "paused"

    def resume(self, sid, owner="", is_admin=False):
        """Session manuell auftauen (Berechtigung wird geprüft)."""
        s = self.get(sid, owner=owner, is_admin=is_admin)
        if not s:
            raise PermissionError("Keine Berechtigung")
        return self._apply_pause(sid, False) == "running"

    def ensure_running(self, sid):
        """Vor dem Zugriff: pausierte Session auftauen. True, wenn aufgetaut wurde.

        Ohne Berechtigungsprüfung — die Aufrufer (Proxy-Endpunkte) haben den
        Zugriff bereits geprüft."""
        with self._lock:
            s = self._sessions.get(sid)
            status = s.get("status") if s else None
            cname = s.get("container_name") if s else None
        if status == "stopped":
            # Beim Start nicht wieder angelaufener Container (siehe recover()).
            if not self._start_container(cname):
                return False
            with self._lock:
                s = self._sessions.get(sid)
                if s:
                    s["status"] = "running"
                    s["last_active"] = time.time()
                    self._save()
            return True
        if status != "paused":
            return False
        return self._apply_pause(sid, False) == "running"

    def _pause_idle_sessions(self):
        """Alle Sessions einfrieren, die länger als das Limit unbenutzt sind."""
        minutes = _idle_pause_minutes()
        if minutes <= 0:
            return []
        limit = minutes * 60
        now = time.time()
        with self._lock:
            due = [s["id"] for s in self._sessions.values()
                   if s.get("status", "running") == "running"
                   and now - s.get("last_active", now) >= limit]
        paused = []
        for sid in due:
            if self._apply_pause(sid, True, auto=True) == "paused":
                paused.append(sid)
                print(f"[browser] Session {sid} nach {minutes} min Leerlauf pausiert",
                      file=sys.stderr, flush=True)
        return paused

    @staticmethod
    def _proc_cpu(pid):
        """(utime+stime in Ticks, starttime) aus /proc/<pid>/stat oder None."""
        try:
            with open(f"/proc/{pid}/stat") as f:
                rest = f.read().rsplit(")", 1)[1].split()
            return int(rest[11]) + int(rest[12]), int(rest[19])
        except (OSError, IndexError, ValueError):
            return None

    def _kill_runaway_tabs(self):
        """Tab-Prozesse beenden, die dauerhaft zu viel CPU fressen."""
        if RUNAWAY_CORES <= 0:
            return []
        with self._lock:
            running = [(s["id"], s.get("container_name") or f"lcc-browser-{s['id']}")
                       for s in self._sessions.values()
                       if s.get("status", "running") == "running"]
        now = time.monotonic()
        seen, killed = set(), []
        for sid, cname in running:
            try:
                status, top = _docker_api(
                    "GET", f"/containers/{cname}/top?ps_args=-eo%20pid,args")
            except Exception:
                continue
            if status != 200 or not isinstance(top, dict):
                continue
            for proc in top.get("Processes") or []:
                if len(proc) < 2:
                    continue
                args = proc[-1]
                if "-contentproc" not in args or "-isForBrowser" not in args:
                    continue
                try:
                    pid = int(proc[0])
                except ValueError:
                    continue
                cur = self._proc_cpu(pid)
                if cur is None:
                    continue
                seen.add(pid)
                hist = self._cpu_samples.setdefault(pid, [])
                if hist and hist[-1][2] != cur[1]:      # PID wiederverwendet
                    hist.clear()
                hist.append((now, cur[0], cur[1]))
                while hist and now - hist[0][0] > RUNAWAY_WINDOW + self._WATCH_INTERVAL:
                    hist.pop(0)
                span = now - hist[0][0]
                if span < RUNAWAY_WINDOW:
                    continue
                cores = (cur[0] - hist[0][1]) / _CLK_TCK / span
                if cores < RUNAWAY_CORES:
                    continue
                try:
                    os.kill(pid, signal.SIGTERM)
                except OSError:
                    continue
                self._cpu_samples.pop(pid, None)
                killed.append((sid, pid))
                print(f"[browser] Session {sid}: Tab-Prozess {pid} beendet "
                      f"({cores:.1f} Kerne über {int(span / 60)} min)",
                      file=sys.stderr, flush=True)
        for pid in list(self._cpu_samples):
            if pid not in seen:
                del self._cpu_samples[pid]
        return killed

    def _idle_loop(self):
        while True:
            time.sleep(self._WATCH_INTERVAL)
            try:
                self._pause_idle_sessions()
            except Exception:
                pass
            try:
                self._kill_runaway_tabs()
            except Exception:
                pass

    def start_idle_watcher(self):
        """Hintergrund-Thread starten, der unbenutzte Sessions pausiert."""
        if self._watcher and self._watcher.is_alive():
            return
        if _idle_pause_minutes() <= 0:
            print("[browser] Idle-Pause deaktiviert (BROWSER_IDLE_PAUSE_MIN=0)",
                  file=sys.stderr, flush=True)
            if RUNAWAY_CORES <= 0:
                return
        self._watcher = threading.Thread(target=self._idle_loop, daemon=True,
                                         name="browser-idle-watcher")
        self._watcher.start()
        print(f"[browser] Idle-Pause aktiv: Sessions werden nach "
              f"{_idle_pause_minutes()} min ohne Nutzung eingefroren",
              file=sys.stderr, flush=True)

    def stop(self, sid, owner="", is_admin=False):
        with self._lock:
            session = self._sessions.get(sid)
            if not session:
                return
            if not is_admin and session.get("owner") != owner:
                raise PermissionError("Keine Berechtigung")
            self._sessions.pop(sid)
            self._save()
        cname = session.get("container_name")
        if cname:
            try:
                # Einen pausierten Container erst auftauen: sonst kann das
                # Entfernen am eingefrorenen cgroup hängen bleiben.
                if session.get("status") == "paused":
                    self._set_container_pause(cname, False)
                _docker_api("DELETE", f"/containers/{cname}?force=true")
            except Exception:
                pass

    def _with_idle_info(self, s):
        """Kopie der Session mit abgeleiteten Feldern für die Oberfläche."""
        d = dict(s)
        now = time.time()
        d.setdefault("status", "running")
        d["idle_seconds"] = int(max(0, now - d.get("last_active", now)))
        minutes = _idle_pause_minutes()
        d["pause_after_min"] = minutes
        if d["status"] == "running" and minutes > 0:
            d["pause_in_seconds"] = max(0, minutes * 60 - d["idle_seconds"])
        return d

    @staticmethod
    def can_view(s, owner):
        """Besitzer oder freigegebener Benutzer (viewers) darf die Session sehen/öffnen."""
        return s.get("owner") == owner or (owner and owner in (s.get("viewers") or []))

    def list_all(self, owner="", is_admin=False):
        with self._lock:
            sessions = list(self._sessions.values())
        if not is_admin:
            sessions = [s for s in sessions if self.can_view(s, owner)]
        return [self._with_idle_info(s) for s in sessions]

    def get(self, sid, owner="", is_admin=False):
        with self._lock:
            s = self._sessions.get(sid)
            if not s:
                return None
            if not is_admin and not self.can_view(s, owner):
                return None
            return dict(s)

    def set_viewers(self, sid, users):
        """Sichtbarkeitsliste einer Session setzen (nur Superadmin, Handler prüft)."""
        users = sorted({u for u in (users or []) if u})
        with self._lock:
            s = self._sessions.get(sid)
            if not s:
                return None
            s["viewers"] = users
            self._save()
            return dict(s)


def _cleanup_orphan_browser_containers(known_names: set):
    """Remove STOPPED lcc-browser-* containers that are not in known_names.
    Laufende UND pausierte Container werden NIE automatisch entfernt — das
    könnten echte (nach Neustart bzw. bei kaputter/fehlender Persistenzdatei
    verwaiste) Nutzer-Sessions sein. Nur gestoppte Leichen werden aufgeräumt."""
    try:
        status, containers = _docker_api(
            "GET", "/containers/json?all=true&filters=%7B%22name%22%3A%5B%22lcc-browser-%22%5D%7D"
        )
        if status != 200 or not isinstance(containers, list):
            return
        for c in containers:
            names = [n.lstrip("/") for n in c.get("Names", [])]
            if any(n in known_names for n in names):
                continue
            if c.get("State") in ("running", "paused"):
                continue   # laufende oder eingefrorene Session niemals löschen
            cid = c.get("Id", "")
            if cid:
                _docker_api("DELETE", f"/containers/{cid}?force=true")
    except Exception:
        pass


_browser_mgr = BrowserSessionManager()


# ─── External Connection Manager ─────────────────────────────────────────────

