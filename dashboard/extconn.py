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

from dashboard.base import DATA_DIR
from dashboard.consoles import _proxy_mgr, _ws_unregister_port

# Verbindungen ueberleben Neustarts (seit 19.10.2026). Enthaelt Passwoerter/Schluessel -> 0600.
CONN_FILE = DATA_DIR / "ext_connections.json"
_PERSIST_KEYS = ("id", "proto", "host", "port", "username", "_password", "_private_key",
                 "_passphrase", "use_default", "label", "owner")


def load_pkey(text, passphrase=None):
    """Privaten SSH-Schluessel (OpenSSH/PEM: Ed25519, ECDSA, RSA) laden.
    Liefert (pkey, fehlertext)."""
    import io
    import paramiko
    last = "Unbekanntes Schlüsselformat"
    for cls in (paramiko.Ed25519Key, paramiko.ECDSAKey, paramiko.RSAKey):
        try:
            return cls.from_private_key(io.StringIO(text), password=passphrase or None), None
        except paramiko.PasswordRequiredException:
            return None, "Schlüssel ist verschlüsselt – Passphrase angeben"
        except paramiko.SSHException as e:
            last = str(e) or last
        except Exception as e:
            last = str(e) or last
    if any(w in last.lower() for w in ("passphrase", "password", "checkints", "decrypt")):
        return None, "Passphrase falsch oder fehlt"
    return None, f"Schlüssel ungültig: {last}"

class ExtConnManager:
    """Manages user-defined external VNC/SPICE/SSH connections."""

    PROTO_DEFAULTS = {"vnc": 5900, "spice": 5900, "ssh": 22, "rdp": 3389, "scp": 22}

    def __init__(self):
        self._conns = {}
        self._lock  = threading.Lock()
        self._load()

    def _load(self):
        try:
            with open(CONN_FILE, encoding="utf-8") as fh:
                for c in json.load(fh):
                    c.update(status="idle", _proxy_port=None, _proxy_proc=None)
                    self._conns[c["id"]] = c
        except (OSError, ValueError, KeyError, TypeError):
            pass

    def _persist(self):
        """Nur unter self._lock aufrufen."""
        data = [{k: c.get(k) for k in _PERSIST_KEYS} for c in self._conns.values()]
        tmp = f"{CONN_FILE}.tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=1)
        os.replace(tmp, CONN_FILE)

    def save(self, proto, host, port, username="", password="", label="", owner="",
             private_key="", passphrase="", use_default=False):
        cid = secrets.token_urlsafe(12)
        with self._lock:
            self._conns[cid] = {
                "id":       cid,
                "proto":    proto,
                "host":     host,
                "port":     int(port),
                "username": username,
                "_password": password,
                "_private_key": private_key,
                "_passphrase": passphrase,
                "use_default": bool(use_default),
                "label":    label or f"{proto.upper()} — {host}:{port}",
                "status":   "idle",
                "_proxy_port": None,
                "_proxy_proc": None,
                "owner":    owner,
            }
            self._persist()
        return cid

    def _public(self, c):
        pub = {k: v for k, v in c.items() if not k.startswith("_")}
        pub["has_key"] = bool(c.get("_private_key"))
        pub["has_password"] = bool(c.get("_password"))
        return pub

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
            self._persist()
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

