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

from dashboard.consoles import _proxy_mgr, _ws_unregister_port

class ExtConnManager:
    """Manages user-defined external VNC/SPICE/SSH connections."""

    PROTO_DEFAULTS = {"vnc": 5900, "spice": 5900, "ssh": 22, "rdp": 3389, "scp": 22}

    def __init__(self):
        self._conns = {}
        self._lock  = threading.Lock()

    def save(self, proto, host, port, username="", password="", label="", owner=""):
        cid = secrets.token_urlsafe(12)
        with self._lock:
            self._conns[cid] = {
                "id":       cid,
                "proto":    proto,
                "host":     host,
                "port":     int(port),
                "username": username,
                "_password": password,
                "label":    label or f"{proto.upper()} — {host}:{port}",
                "status":   "idle",
                "_proxy_port": None,
                "_proxy_proc": None,
                "owner":    owner,
            }
        return cid

    def _public(self, c):
        return {k: v for k, v in c.items() if not k.startswith("_")}

    def get(self, cid, with_password=False, owner="", is_admin=False):
        with self._lock:
            c = self._conns.get(cid)
            if not c:
                return None
            if not is_admin and c.get("owner") != owner:
                return None
            if c.get("_proxy_proc") and c["_proxy_proc"].poll() is not None:
                c["status"] = "idle"
            if with_password:
                return dict(c)
            return self._public(c)

    def list_all(self, owner="", is_admin=False):
        result = []
        with self._lock:
            for c in self._conns.values():
                if not is_admin and c.get("owner") != owner:
                    continue
                if c.get("_proxy_proc") and c["_proxy_proc"].poll() is not None:
                    c["status"] = "idle"
                result.append(self._public(c))
        return result

    def start_proxy(self, cid, web_dir, owner="", is_admin=False):
        with self._lock:
            c = self._conns.get(cid)
            if not c:
                raise ValueError("Verbindung nicht gefunden")
            if not is_admin and c.get("owner") != owner:
                raise PermissionError("Keine Berechtigung")
            if c.get("_proxy_proc") and c["_proxy_proc"].poll() is None:
                return c["_proxy_port"]
            target = f"{c['host']}:{c['port']}"
            port = _proxy_mgr._free_port()
            proc = subprocess.Popen(
                ["websockify", "--web", web_dir, f"127.0.0.1:{port}", target],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
            for _ in range(30):
                time.sleep(0.1)
                try:
                    with socket.socket() as s:
                        s.settimeout(0.05)
                        s.connect(("127.0.0.1", port))
                        break
                except Exception:
                    pass
            c["_proxy_port"] = port
            c["_proxy_proc"] = proc
            c["status"] = "connected"
            return port

    def delete(self, cid, owner="", is_admin=False):
        with self._lock:
            c = self._conns.get(cid)
            if not c:
                return
            if not is_admin and c.get("owner") != owner:
                raise PermissionError("Keine Berechtigung")
            self._conns.pop(cid)
            _ws_unregister_port(c.get("_proxy_port"))
            if c.get("_proxy_proc"):
                try:
                    c["_proxy_proc"].terminate()
                except Exception:
                    pass

    def set_status(self, cid, status):
        with self._lock:
            if cid in self._conns:
                self._conns[cid]["status"] = status


_ext_mgr = ExtConnManager()


def _ssrf_blocked(host):
    """True, wenn host auf Loopback / Link-Local / Cloud-Metadaten zeigt.
    LAN-Adressen (RFC1918) bleiben erlaubt — das ist der Zweck des Features."""
    import ipaddress, socket as _s
    try:
        infos = _s.getaddrinfo(host, None)
    except Exception:
        return False  # nicht auflösbar → später ohnehin Verbindungsfehler
    for info in infos:
        addr = info[4][0]
        try:
            ip = ipaddress.ip_address(addr.split('%')[0])
        except ValueError:
            continue
        if ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified:
            return True
        if str(ip) in ("169.254.169.254", "::ffff:169.254.169.254"):
            return True
    return False


# ─── Stateful Terminal ───────────────────────────────────────────────────────

