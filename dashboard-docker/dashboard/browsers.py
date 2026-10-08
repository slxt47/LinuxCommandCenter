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
import crypt
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

class BrowserSessionManager:
    """Launches and manages browser containers (kasmweb/firefox, etc.) via Docker."""

    IMAGES = {
        "firefox":  "kasmweb/firefox:1.19.0-rolling-weekly",
        "chromium": "kasmweb/chrome:1.19.0-rolling-weekly",
    }
    _CONTAINER_PORT = 6901   # kasmweb HTTPS port inside container
    _PORT_RANGE = range(7000, 7100)

    def __init__(self):
        self._sessions = {}
        self._lock = threading.Lock()

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

    def _container_running(self, container_name):
        """Return True if the named container exists and is running."""
        try:
            status, info = _docker_api("GET", f"/containers/{container_name}/json")
            if status == 200:
                return info.get("State", {}).get("Running", False)
        except Exception:
            pass
        return False

    def recover(self):
        """On startup: load saved sessions, drop containers that are no longer running,
        delete orphaned lcc-browser-* containers not in the session list."""
        if not SESSIONS_FILE.exists():
            _cleanup_orphan_browser_containers(set())
            return

        try:
            saved = json.loads(SESSIONS_FILE.read_text())
        except Exception:
            _cleanup_orphan_browser_containers(set())
            return

        recovered = {}
        for s in saved:
            sid = s.get("id")
            cname = s.get("container_name")
            if not sid or not cname:
                continue
            if self._container_running(cname):
                s["status"] = "running"
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
                "PortBindings": {"6901/tcp": [{"HostPort": str(port)}]},
                "ShmSize": 2 * 1024 * 1024 * 1024,
                # Mount our kasmvnc.yaml so it takes precedence over the container defaults,
                # fixing the FrameRate/DynamicQualityMax overrides from the vncserver wrapper.
                "Binds": ["/var/lib/linux-dashboard/kasmvnc.yaml:/etc/kasmvnc/kasmvnc.yaml:ro"],
            },
        }

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
                _docker_api("DELETE", f"/containers/{cname}?force=true")
            except Exception:
                pass

    def list_all(self, owner="", is_admin=False):
        with self._lock:
            sessions = list(self._sessions.values())
        if is_admin:
            return [dict(s) for s in sessions]
        return [dict(s) for s in sessions if s.get("owner") == owner]

    def get(self, sid, owner="", is_admin=False):
        with self._lock:
            s = self._sessions.get(sid)
            if not s:
                return None
            if not is_admin and s.get("owner") != owner:
                return None
            return dict(s)


def _cleanup_orphan_browser_containers(known_names: set):
    """Remove STOPPED lcc-browser-* containers that are not in known_names.
    Laufende Container werden NIE automatisch entfernt — das könnten echte
    (nach Neustart bzw. bei kaputter/fehlender Persistenzdatei verwaiste)
    Nutzer-Sessions sein. Nur gestoppte Leichen werden aufgeräumt."""
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
            if c.get("State") == "running":
                continue   # laufende Session niemals löschen
            cid = c.get("Id", "")
            if cid:
                _docker_api("DELETE", f"/containers/{cid}?force=true")
    except Exception:
        pass


_browser_mgr = BrowserSessionManager()


# ─── External Connection Manager ─────────────────────────────────────────────

