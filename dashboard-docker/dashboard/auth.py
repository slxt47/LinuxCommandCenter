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

from dashboard.base import _ns

class SessionManager:
    def __init__(self, lifetime=86400):  # 24 hours
        self._sessions = {}
        self._lock = threading.Lock()
        self._lifetime = lifetime

    def create(self, username, role="admin"):
        token = secrets.token_urlsafe(32)
        with self._lock:
            self._sessions[token] = {
                "username": username,
                "role": role,
                "expires": time.time() + self._lifetime,
            }
        return token

    def validate(self, token):
        if not token:
            return None
        with self._lock:
            session = self._sessions.get(token)
            if not session:
                return None
            now = time.time()
            if now > session["expires"]:
                del self._sessions[token]
                return None
            # Sliding-Expiry: eine aktive Sitzung verlängert sich fortlaufend.
            # Ausgeloggt wird erst nach `lifetime` INAKTIVITÄT statt nach hartem 24h-Cut
            # — damit bleibt die App/der Browser bei Nutzung dauerhaft eingeloggt.
            session["expires"] = now + self._lifetime
            return session["username"]

    def get_role(self, token):
        if not token:
            return None
        with self._lock:
            session = self._sessions.get(token)
            if not session:
                return None
            if time.time() > session["expires"]:
                return None
            return session.get("role", "admin")

    def invalidate(self, token):
        with self._lock:
            self._sessions.pop(token, None)

    def invalidate_user(self, username):
        """Alle Sitzungen eines Benutzers beenden (z. B. wenn er gelöscht wird)."""
        with self._lock:
            for tok in [t for t, s in self._sessions.items()
                        if s.get("username") == username]:
                self._sessions.pop(tok, None)


_session_mgr = SessionManager()


# ─── Authentication ──────────────────────────────────────────────────────────

def _verify_hash_on_host(password: str, stored_hash: str) -> bool:
    """Verify a password hash using the host's libxcrypt via nsenter.
    Used as fallback when the container's crypt library doesn't support the
    hash algorithm (e.g. yescrypt $y$ on Ubuntu hosts).
    Tries the host's Python crypt module first, then falls back to ctypes."""
    payload = json.dumps({'p': password, 'h': stored_hash}).encode()
    # Primary: host Python crypt (works on Python < 3.13)
    script_crypt = (
        "import crypt,sys,json;"
        "d=json.load(sys.stdin);"
        "print('ok' if crypt.crypt(d['p'],d['h'])==d['h'] else 'fail')"
    )
    try:
        r = subprocess.run(_ns(['python3', '-c', script_crypt]),
                           input=payload, capture_output=True, timeout=8)
        if r.returncode == 0 and r.stdout.strip() in (b'ok', b'fail'):
            return r.stdout.strip() == b'ok'
    except Exception:
        pass
    # Fallback: host libcrypt via ctypes (works even if crypt module is gone)
    script_ctypes = (
        "import ctypes,sys,json;"
        "d=json.load(sys.stdin);"
        "lib=ctypes.CDLL('libcrypt.so.1');"
        "lib.crypt.restype=ctypes.c_char_p;"
        "r=lib.crypt(d['p'].encode(),d['h'].encode());"
        "print('ok' if r and r.decode()==d['h'] else 'fail')"
    )
    try:
        r = subprocess.run(_ns(['python3', '-c', script_ctypes]),
                           input=payload, capture_output=True, timeout=8)
        return r.stdout.strip() == b'ok'
    except Exception:
        return False


# Pro-IP-Login-Drossel gegen Brute-Force und Fork-DoS (yescrypt via nsenter)
_login_attempts = {}          # ip -> [timestamps]
_login_lock     = threading.Lock()
_LOGIN_MAX      = 8           # erlaubte Versuche pro Fenster
_LOGIN_WINDOW   = 60          # Sekunden


def _login_rate_limited(ip):
    """True, wenn diese IP das Login-Limit im Zeitfenster überschritten hat."""
    now = time.time()
    with _login_lock:
        hits = [t for t in _login_attempts.get(ip, []) if now - t < _LOGIN_WINDOW]
        hits.append(now)
        _login_attempts[ip] = hits
        # alte IPs gelegentlich aufräumen
        if len(_login_attempts) > 1000:
            for k in [k for k, v in _login_attempts.items()
                      if all(now - t >= _LOGIN_WINDOW for t in v)]:
                _login_attempts.pop(k, None)
        return len(hits) > _LOGIN_MAX


# Generische Pro-IP-Drossel für sensible, NICHT gepollte Endpunkte (z. B.
# Benutzerverwaltung). Bewusst großzügig, damit normaler Admin-Betrieb nie
# gebremst wird — sie greift nur bei Missbrauch/Automatisierung.
_action_attempts = {}             # (bucket, ip) -> [timestamps]
_action_lock     = threading.Lock()


def _action_rate_limited(bucket, ip, max_hits=30, window=60):
    """True, wenn (bucket, ip) das Limit im Zeitfenster überschritten hat."""
    now = time.time()
    key = (bucket, ip)
    with _action_lock:
        hits = [t for t in _action_attempts.get(key, []) if now - t < window]
        hits.append(now)
        _action_attempts[key] = hits
        if len(_action_attempts) > 2000:
            for k in [k for k, v in _action_attempts.items()
                      if all(now - t >= window for t in v)]:
                _action_attempts.pop(k, None)
        return len(hits) > max_hits


def _host_shadow_hash(username):
    """Liest den Passwort-Hash LIVE vom Host (nsenter/getent).

    Muss VOR der gemounteten /etc/shadow abgefragt werden: der Bind-Mount der
    einzelnen Datei hängt nach useradd/chpasswd/userdel auf dem alten Inode
    fest, d. h. der Container sieht bis zum Neustart den Stand von damals.

    Rückgabe (hash, authoritative):
      (hash, True)  – Hash vom Host gelesen
      (None, True)  – Host kennt den Benutzer sicher nicht (auch nicht in passwd)
      (None, False) – Host-Abfrage nicht möglich → Aufrufer nimmt den Mount
    """
    try:
        r = subprocess.run(_ns(["getent", "shadow", username]),
                           capture_output=True, text=True, timeout=6)
        if r.returncode == 0 and ":" in r.stdout:
            return r.stdout.strip().split(":")[1], True
        # Kein Shadow-Eintrag: nur dann autoritativ „gibt es nicht", wenn der
        # Host den Benutzer auch in passwd nicht kennt (getent: 2 = not found).
        # Sonst könnte ein kaputter nsenter-Aufruf alle Logins aussperren.
        p = subprocess.run(_ns(["getent", "passwd", username]),
                           capture_output=True, text=True, timeout=6)
        if p.returncode == 2 and not p.stdout.strip():
            return None, True
    except Exception:
        pass
    return None, False


def _mounted_shadow_hash(username):
    """Fallback: Hash aus der gemounteten /etc/shadow. (hash, readable)."""
    try:
        with open("/etc/shadow", "r") as f:
            for line in f:
                parts = line.strip().split(":")
                if len(parts) >= 2 and parts[0] == username:
                    return parts[1], True
        return None, True
    except OSError:
        return None, False


def authenticate_user(username, password):
    """Verify username/password against the host's shadow database.

    Quelle ist IMMER zuerst der laufende Host (nsenter/getent), damit im
    Dashboard angelegte/geänderte/gelöschte Benutzer sofort wirken. Die
    gemountete /etc/shadow dient nur noch als Notfall-Fallback, falls der
    Host-Namespace nicht erreichbar ist."""
    stored_hash, authoritative = _host_shadow_hash(username)
    readable = authoritative
    if not authoritative:
        stored_hash, readable = _mounted_shadow_hash(username)
    if stored_hash is None:
        return False if readable else None
    # Locked / disabled / passwordless accounts ('!' prefix = locked)
    if not stored_hash or stored_hash.startswith('!') or stored_hash in ("*", "x"):
        return False
    # Fast path: Python-crypt für bekannte Algorithmen ($1$/$5$/$6$/$2b$ …)
    try:
        result = crypt.crypt(password, stored_hash)
        if not result.startswith('*'):
            return result == stored_hash
    except Exception:
        pass
    # Fallback: Host-Python/libcrypt (yescrypt $y$ etc.)
    return _verify_hash_on_host(password, stored_hash)


def is_sudo_user(username):
    """Return True if username is in the sudo or wheel group.

    Fragt zuerst den Host live ab (`id -nG` via nsenter) — die gemountete
    /etc/group ist wie /etc/shadow nach jeder Änderung veraltet und würde
    sonst z. B. entzogene Admin-Rechte bis zum Container-Neustart behalten.
    Der Datei-Fallback greift nur, wenn der Host nicht erreichbar ist."""
    if username == "root":
        return True
    try:
        r = subprocess.run(_ns(["id", "-nG", username]),
                           capture_output=True, text=True, timeout=6)
        if r.returncode == 0:
            groups = r.stdout.split()
            return "sudo" in groups or "wheel" in groups
    except Exception:
        pass
    try:
        with open("/etc/group", "r") as f:
            for line in f:
                parts = line.strip().split(":")
                if len(parts) >= 4 and parts[0] in ("sudo", "wheel"):
                    members = [m.strip() for m in parts[3].split(",") if m.strip()]
                    if username in members:
                        return True
    except OSError:
        pass
    return False


# ─── Host-Benutzerverwaltung (useradd/usermod/userdel via nsenter) ───────────

_USERNAME_RE = re.compile(r'^[a-z_][a-z0-9_-]{0,31}$')
_ALLOWED_SHELLS = ("/bin/bash", "/bin/sh", "/bin/zsh", "/usr/sbin/nologin")


def list_users():
    """Menschliche Host-Benutzer (root + UID 1000–64999) mit Admin-/Sperr-Status."""
    try:
        admins = set()
        rg = subprocess.run(_ns(["getent", "group", "sudo", "wheel"]),
                            capture_output=True, text=True, timeout=8)
        for line in rg.stdout.splitlines():
            p = line.split(":")
            if len(p) >= 4:
                admins.update(m.strip() for m in p[3].split(",") if m.strip())
        locked = {}
        rs = subprocess.run(_ns(["getent", "shadow"]), capture_output=True, text=True, timeout=8)
        for line in rs.stdout.splitlines():
            p = line.split(":")
            if len(p) >= 2:
                h = p[1]
                locked[p[0]] = (not h) or h.startswith("!") or h in ("*", "x")
        users = []
        rp = subprocess.run(_ns(["getent", "passwd"]), capture_output=True, text=True, timeout=8)
        for line in rp.stdout.splitlines():
            p = line.split(":")
            if len(p) < 7:
                continue
            name, uid, shell = p[0], p[2], p[6]
            try:
                uidn = int(uid)
            except ValueError:
                continue
            if not (uidn == 0 or 1000 <= uidn < 65000):
                continue
            users.append({
                "username": name, "uid": uidn, "shell": shell,
                "is_admin": name == "root" or name in admins,
                "locked": locked.get(name, False),
                "system": uidn == 0,
            })
        return {"users": sorted(users, key=lambda u: u["uid"])}
    except Exception as e:
        return {"error": str(e), "users": []}


def create_user(username, password, is_admin=False, shell="/bin/bash"):
    if not _USERNAME_RE.match(username or ""):
        return {"error": "Ungültiger Benutzername (a-z, 0-9, _-, klein, max. 32)"}
    if not password or len(password) < 4:
        return {"error": "Passwort erforderlich (min. 4 Zeichen)"}
    if shell not in _ALLOWED_SHELLS:
        shell = "/bin/bash"
    if subprocess.run(_ns(["id", "-u", username]), capture_output=True, timeout=6).returncode == 0:
        return {"error": "Benutzer existiert bereits"}
    r = subprocess.run(_ns(["useradd", "-m", "-s", shell, username]),
                       capture_output=True, text=True, timeout=20)
    if r.returncode != 0:
        return {"error": r.stderr.strip() or "useradd fehlgeschlagen"}
    cp = subprocess.run(_ns(["chpasswd"]), input=f"{username}:{password}",
                        capture_output=True, text=True, timeout=15)
    if cp.returncode != 0:
        return {"error": "Benutzer angelegt, aber Passwort setzen fehlgeschlagen: " + cp.stderr.strip()}
    if is_admin:
        subprocess.run(_ns(["usermod", "-aG", "sudo", username]), capture_output=True, timeout=10)
    return {"success": True}


def update_user(username, password=None, is_admin=None):
    if not _USERNAME_RE.match(username or ""):
        return {"error": "Ungültiger Benutzername"}
    if subprocess.run(_ns(["id", "-u", username]), capture_output=True, timeout=6).returncode != 0:
        return {"error": "Benutzer nicht gefunden"}
    if password is not None and password != "":
        if len(password) < 4:
            return {"error": "Passwort min. 4 Zeichen"}
        cp = subprocess.run(_ns(["chpasswd"]), input=f"{username}:{password}",
                            capture_output=True, text=True, timeout=15)
        if cp.returncode != 0:
            return {"error": cp.stderr.strip() or "Passwort setzen fehlgeschlagen"}
    if is_admin is not None:
        if is_admin:
            subprocess.run(_ns(["usermod", "-aG", "sudo", username]), capture_output=True, timeout=10)
        else:
            for grp in ("sudo", "wheel"):
                subprocess.run(_ns(["gpasswd", "-d", username, grp]), capture_output=True, timeout=10)
    return {"success": True}


def delete_user(username, remove_home=True):
    if not _USERNAME_RE.match(username or ""):
        return {"error": "Ungültiger Benutzername"}
    if username == "root":
        return {"error": "root kann nicht gelöscht werden"}
    r = subprocess.run(_ns(["id", "-u", username]), capture_output=True, text=True, timeout=6)
    if r.returncode != 0:
        return {"error": "Benutzer nicht gefunden"}
    try:
        uid = int(r.stdout.strip())
    except ValueError:
        uid = -1
    if uid < 1000:
        return {"error": "Systembenutzer (UID < 1000) sind geschützt"}
    args = ["userdel"] + (["-r"] if remove_home else []) + [username]
    d = subprocess.run(_ns(args), capture_output=True, text=True, timeout=25)
    if d.returncode != 0 and "not found" not in (d.stderr or "").lower():
        return {"error": d.stderr.strip() or "userdel fehlgeschlagen"}
    # Offene Sitzungen des gelöschten Benutzers sofort beenden.
    _session_mgr.invalidate_user(username)
    return {"success": True}


# ─── Login Page HTML ─────────────────────────────────────────────────────────

_LOGIN_HTML = """\
<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Linux Command Center — Anmelden</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Space+Grotesk:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{
  --bg-void:#06080d;--bg-card:#151d2e;--bg-input:#0d1320;
  --border-mid:#2a3a52;--border-glow:#334766;
  --text-primary:#e2e8f0;--text-secondary:#8b9dc3;--text-muted:#4a5e80;
  --accent:#00e87b;--accent-dim:#00c968;--accent-glow:rgba(0,232,123,.15);
  --red:#ef4444;--red-glow:rgba(239,68,68,.12);
  --font-mono:'JetBrains Mono',monospace;
  --font-sans:'Space Grotesk',system-ui,sans-serif;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:var(--font-sans);background:var(--bg-void);color:var(--text-primary);
  min-height:100vh;display:flex;align-items:center;justify-content:center;
}
body::before{
  content:'';position:fixed;inset:0;pointer-events:none;
  background-image:linear-gradient(rgba(0,232,123,.03) 1px,transparent 1px),
    linear-gradient(90deg,rgba(0,232,123,.03) 1px,transparent 1px);
  background-size:60px 60px;
}
.box{
  position:relative;z-index:1;background:var(--bg-card);
  border:1px solid var(--border-mid);border-radius:20px;
  padding:48px 40px 40px;width:100%;max-width:420px;
}
.box::before{
  content:'';position:absolute;top:0;left:40px;right:40px;height:1px;
  background:linear-gradient(90deg,transparent,var(--accent),transparent);opacity:.5;
}
.logo{display:flex;align-items:center;gap:16px;margin-bottom:36px}
.logo-icon{
  width:48px;height:48px;border-radius:12px;flex-shrink:0;
  background:linear-gradient(135deg,var(--accent),#00d4ff);
  display:flex;align-items:center;justify-content:center;
  font-family:var(--font-mono);font-weight:700;font-size:20px;color:#06080d;
  box-shadow:0 0 24px var(--accent-glow);
}
.logo-title{font-size:18px;font-weight:600;letter-spacing:-.3px}
.logo-sub{font-size:11px;color:var(--text-muted);font-family:var(--font-mono);margin-top:2px}
.error{
  background:var(--red-glow);border:1px solid rgba(239,68,68,.3);
  border-radius:8px;padding:10px 16px;color:var(--red);
  font-size:13px;font-family:var(--font-mono);margin-bottom:20px;
}
.field{margin-bottom:20px}
.label{
  display:block;font-size:11px;font-weight:500;color:var(--text-secondary);
  text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px;
  font-family:var(--font-mono);
}
.input{
  width:100%;background:var(--bg-input);border:1px solid var(--border-mid);
  border-radius:8px;padding:12px 16px;color:var(--text-primary);
  font-family:var(--font-mono);font-size:14px;outline:none;
  transition:border-color .15s,box-shadow .15s;
}
.input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-glow)}
.input::placeholder{color:var(--text-muted)}
.btn{
  width:100%;background:var(--accent);color:#06080d;border:none;
  border-radius:8px;padding:13px;font-family:var(--font-sans);
  font-size:15px;font-weight:600;cursor:pointer;
  transition:background .15s,box-shadow .15s;margin-top:8px;
}
.btn:hover{background:var(--accent-dim);box-shadow:0 0 24px var(--accent-glow)}
.note{
  margin-top:24px;text-align:center;font-size:11px;
  color:var(--text-muted);font-family:var(--font-mono);
}
</style>
</head>
<body>
<div class="box">
  <div class="logo">
    <div class="logo-icon">CC</div>
    <div>
      <div class="logo-title">Command Center</div>
      <div class="logo-sub">Linux Dashboard</div>
    </div>
  </div>
  %ERROR%
  <form method="POST" action="/login">
    <div class="field">
      <label class="label" for="u">Benutzername</label>
      <input class="input" type="text" id="u" name="username"
             placeholder="root" autocomplete="username" autofocus>
    </div>
    <div class="field">
      <label class="label" for="p">Passwort</label>
      <input class="input" type="password" id="p" name="password"
             placeholder="••••••••" autocomplete="current-password">
    </div>
    <button class="btn" type="submit">Anmelden</button>
  </form>
  <div class="note">Authentifizierung gegen lokale System-Benutzer</div>
</div>
</body>
</html>
"""


# ─── System Info Helpers ─────────────────────────────────────────────────────

