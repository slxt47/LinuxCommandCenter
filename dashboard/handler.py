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

from dashboard.auth import _LOGIN_HTML, _action_rate_limited, _login_rate_limited, _session_mgr, authenticate_user, create_user, delete_user, is_sudo_user, list_users, update_user
from dashboard.base import NOVNC_DIR, SPICE_DIR, STATIC_DIR, _ns
from dashboard.browsers import _browser_mgr
from dashboard.consoles import _console_url, _kasm_client_inject, _proxy_mgr, _vmkasm_mgr, _ws_handshake_response, _ws_owner_for, _ws_port_for, _ws_recv, _ws_register, _ws_send
from dashboard.extconn import ExtConnManager, _ext_mgr, _ssrf_blocked
from dashboard.networks import list_networks, net_action, net_add_dhcp_host, net_create, net_dhcp_hosts, net_edit, net_get_xml, net_leases, net_remove_dhcp_host, net_set_xml
from dashboard.storage import iso_delete, iso_download, iso_download_status, iso_list, list_isos, list_pools, list_volumes, vol_create, vol_delete
from dashboard.sysinfo import get_cpu_info, get_disk_info, get_memory_info, get_network_info, get_services, get_system_info, get_top_processes, get_updates, run_update
from dashboard.terminal import _pty_session, get_terminal_info
from dashboard.vms import get_vm_display, get_vm_full, get_vms, list_host_devices, set_kasmvnc_pref, set_vm_vnc_keymap, vm_action, vm_add_device, vm_clone, vm_create, vm_delete, vm_device_list, vm_disk_attach, vm_disk_detach, vm_get_xml, vm_nic_attach, vm_nic_detach, vm_remove_device, vm_set_graphics, vm_set_xml, vm_snapshot_create, vm_snapshot_delete, vm_snapshot_list, vm_snapshot_revert, vm_stats, vm_update

class DashboardHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def log_message(self, format, *args):
        if "/api/" in str(args[0] if args else ""):
            return
        super().log_message(format, *args)

    # ── Auth helpers ────────────────────────────────────────────────────────

    def _get_session_token(self):
        sc = SimpleCookie()
        try:
            sc.load(self.headers.get("Cookie", ""))
        except Exception:
            pass
        return sc["session"].value if "session" in sc else None

    def _is_authenticated(self):
        return _session_mgr.validate(self._get_session_token()) is not None

    def _get_session_user(self):
        return _session_mgr.validate(self._get_session_token()) or ""

    def _get_session_role(self):
        return _session_mgr.get_role(self._get_session_token())

    def _require_admin(self):
        """Send 403 and return True if current session is not admin."""
        if self._get_session_role() != "admin":
            self.send_json({"error": "Keine Berechtigung"}, 403)
            return True
        return False

    def _redirect(self, location, status=302):
        self.send_response(status)
        self.send_header("Location", location)
        self.end_headers()

    def _serve_login(self, error=""):
        error_html = f'<div class="error">{error}</div>' if error else ""
        body = _LOGIN_HTML.replace("%ERROR%", error_html).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ── Response helpers ─────────────────────────────────────────────────────

    def end_headers(self):
        # Verhindert, dass Konsolen-Tokens in URLs via Referer nach außen lecken.
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def send_json(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    # ── IP access control ────────────────────────────────────────────────────
    # Only allow requests from localhost or Docker bridge networks (172.x / 10.x).
    # Direct LAN / public-IP access is blocked — traffic must come through the
    # Cloudflare tunnel (cloudflared container at 172.x).

    _ALLOWED_NETS = ('127.', '172.', '10.', '::1', '::ffff:127.', '::ffff:172.')

    # Zusätzliche erlaubte IP-Präfixe (kommagetrennt) über DASHBOARD_ALLOWED_NETS.
    # "*" = jeden Zugriff erlauben (z. B. für direkten LAN-Zugriff auf einem
    # neuen System ohne Cloudflare-Tunnel). Standardmäßig leer → altes Verhalten.
    _EXTRA_NETS = tuple(
        p.strip() for p in os.environ.get("DASHBOARD_ALLOWED_NETS", "").split(",") if p.strip()
    )
    _ALLOW_ALL = "*" in _EXTRA_NETS

    def _is_allowed_ip(self) -> bool:
        if self._ALLOW_ALL:
            return True
        ip = self.client_address[0]
        return any(ip.startswith(p) for p in self._ALLOWED_NETS + self._EXTRA_NETS)

    def _deny_direct_access(self):
        body = (
            b"<html><body style='font-family:monospace;background:#06080d;color:#ef4444;"
            b"display:flex;align-items:center;justify-content:center;height:100vh;margin:0'>"
            b"<div style='text-align:center'>"
            b"<div style='font-size:48px;margin-bottom:16px'>&#128274;</div>"
            b"<b>Direktzugriff gesperrt</b><br><br>"
            b"Bitte verwende <a href='https://home.jokerdev.tech' "
            b"style='color:#00e87b'>https://home.jokerdev.tech</a></div></body></html>"
        )
        self.send_response(403)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ── Static file from arbitrary directory ─────────────────────────────────

    def _serve_dir_file(self, base_dir: str, rel_path: str):
        import mimetypes
        base = os.path.realpath(base_dir)
        full = os.path.realpath(os.path.join(base_dir, rel_path.lstrip("/")))
        if full != base and not full.startswith(base + os.sep):
            self.send_error(403)
            return
        if not os.path.isfile(full):
            self.send_error(404)
            return
        mime, _ = mimetypes.guess_type(full)
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", mime or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "max-age=3600")
        self.end_headers()
        self.wfile.write(data)

    # ── Console HTML serving (patches WebSocket URL at serve time) ────────────

    def _serve_console(self, console_type: str, session_token: str):
        if console_type == "vnc":
            src = os.path.join(NOVNC_DIR, "vnc_cmd.html")
            html = open(src, encoding="utf-8").read()
            # Redirect WS to go through the main server proxy
            html = html.replace(
                "loc.host+'/websockify'",
                f"loc.host+'/ws/{session_token}'"
            )
            # Fix relative ES module import so it works from any path
            html = html.replace("from './core/rfb.js'", "from '/novnc/core/rfb.js'")
        elif console_type == "spice":
            src = os.path.join(SPICE_DIR, "spice_cmd.html")
            html = open(src, encoding="utf-8").read()
            html = html.replace(
                "loc.host + '/websockify'",
                f"loc.host + '/ws/{session_token}'"
            )
            # Fix relative asset paths
            html = html.replace('href="spice.css"', 'href="/spice-html5/spice.css"')
            html = html.replace("from './main.js'",    "from '/spice-html5/main.js'")
            html = html.replace("from './spicemsg.js'","from '/spice-html5/spicemsg.js'")
            html = html.replace("from './enums.js'",   "from '/spice-html5/enums.js'")
        else:
            self.send_error(400)
            return
        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ── KasmVNC VM proxy (reverse proxy to the per-VM KasmVNC server) ─────────

    def _kasmvnc_vm_proxy(self, token: str, subpath: str):
        """Reverse-proxy to the per-VM Xkasmvnc instance.

        Der Browser spricht mit einem echten KasmVNC-Server (gleiche Erfahrung
        wie kasmweb-Browser-Sessions) — kein Protokoll-Filter-Hack mehr nötig.
        """
        port = _ws_port_for(token)
        if port is None:
            self.send_error(404, "Session nicht gefunden")
            return
        _vmkasm_mgr.touch_port(port)

        _ua = self.headers.get("User-Agent", "")
        _is_mobile = bool(re.search(r"Mobi|Android|iPhone|iPad|iPod", _ua, re.I))

        query  = urlparse(self.path).query
        target = "/" + (subpath.lstrip("/") or "vnc.html") + (f"?{query}" if query else "")
        try:
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
            fwd_headers = {
                "Host": f"127.0.0.1:{port}",
                "Accept-Encoding": "identity",   # unkomprimiert, damit wir patchen können
            }
            for k, v in self.headers.items():
                if k.lower() not in ("host", "accept-encoding", "connection", "upgrade"):
                    fwd_headers[k] = v
            conn.request("GET", target, headers=fwd_headers)
            resp = conn.getresponse()
            body = resp.read()
            ct = resp.getheader("Content-Type", "") or ""
            conn.close()
        except Exception:
            self.send_error(502, "KasmVNC-Server nicht erreichbar")
            return

        # Mobile: dieselben KasmVNC-JS-Bundle-Patches wie bei Browser-Sessions
        # (CSS-Cursor statt eingefrorenem Overlay-Cursor)
        if _is_mobile and "javascript" in ct and body:
            body = body.replace(
                b'let wl="ontouchstart"in document.documentElement||document.ontouchstart!==void 0||navigator.maxTouchPoints>0||navigator.msMaxTouchPoints>0;',
                b'let wl=false;', 1)
            body = body.replace(
                b'addEventListener("touchstart",function n(){wl=!0,window.removeEventListener("touchstart",n,!1)},!1);',
                b'addEventListener("touchstart",function n(){window.removeEventListener("touchstart",n,!1)},!1);', 1)
            body = body.replace(b'const tn=!zR||wl;', b'const tn=false;', 1)

        # HTML: identische Injection wie bei Browser-Sessions (Trackpad-Cursor
        # mit Fadenkreuz, Tastatur-Button, Quality-Presets) + VM-spezifische
        # Voreinstellungen (Auto-Connect, dynamisches Resize)
        if "text/html" in ct and body:
            presets = (
                b'<script>(function(){'
                b'localStorage.setItem("autoconnect","true");'
                b'localStorage.setItem("path","websockify");'
                # echter KasmVNC-Server -> Resize "remote" funktioniert; ueberschreibt
                # auch ein evtl. gespeichertes "scale" der alten VM-Konsole
                b'localStorage.setItem("resize","remote");'
                b'})();</script>'
            )
            _stop_js = (
                'try{window.close();}catch(x){}'
                'setTimeout(function(){window.location.href="/";},200);'
            )
            inject = presets + _kasm_client_inject(f"/ws/{token}", _stop_js)
            if b"</head>" in body:
                body = body.replace(b"</head>", inject + b"</head>", 1)
            else:
                body = inject + body

        self.send_response(resp.status)
        self.send_header("Content-Type", ct or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        # Nie cachen — HTML/JS wird pro Geraet/Token gepatcht
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ── TCP-level WebSocket splice to internal websockify ────────────────────

    def _ws_splice(self, backend_port: int):
        """Forward the current WebSocket connection to 127.0.0.1:backend_port."""
        try:
            backend = socket.create_connection(("127.0.0.1", backend_port), timeout=5)
        except OSError:
            self.send_error(502)
            return

        # Disable Nagle's algorithm on both sockets.
        # Without this, TCP may batch small writes with a 40 ms delay, causing
        # visible stuttering in VNC/SPICE even on fast connections.
        for s in (self.connection, backend):
            try: s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except OSError: pass
            try: s.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 256 * 1024)
            except OSError: pass

        # Reconstruct and forward the HTTP upgrade request to websockify
        req = "GET /websockify HTTP/1.1\r\n"
        for k, v in self.headers.items():
            if k.lower() == "host":
                req += f"Host: 127.0.0.1:{backend_port}\r\n"
            else:
                req += f"{k}: {v}\r\n"
        req += "\r\n"
        backend.sendall(req.encode())

        # Read websockify's 101 response and forward to the browser
        buf = b""
        backend.settimeout(10)
        try:
            while b"\r\n\r\n" not in buf:
                chunk = backend.recv(4096)
                if not chunk:
                    break
                buf += chunk
        except OSError:
            backend.close()
            return
        finally:
            backend.settimeout(None)

        self.connection.sendall(buf)
        self.close_connection = True

        # Bidirectional raw-byte relay (no WebSocket framing needed — both sides
        # have already exchanged 101, we just pass bytes through)
        def pump(src, dst):
            try:
                while True:
                    data = src.recv(262144)
                    if not data:
                        break
                    dst.sendall(data)
            except Exception:
                pass
            finally:
                try:
                    dst.shutdown(socket.SHUT_WR)
                except Exception:
                    pass

        t = threading.Thread(target=pump, args=(backend, self.connection), daemon=True)
        t.start()
        pump(self.connection, backend)
        t.join(timeout=2)
        backend.close()

    # ── KasmVNC reverse proxy ─────────────────────────────────────────────────

    def _kasmvnc_http_proxy(self, sid, subpath, query):
        """Reverse-proxy HTTP request to a kasmweb container (HTTPS, self-signed cert)."""
        import ssl as _ssl
        session = _browser_mgr.get_raw(sid)
        if not session:
            self.send_error(404, "Session nicht gefunden")
            return
        if self._get_session_role() != "admin" and \
           session.get("owner") != self._get_session_user():
            self.send_error(403, "Keine Berechtigung")
            return
        port = session["port"]
        pw   = session.get("vnc_password", "")
        auth = base64.b64encode(f"kasm_user:{pw}".encode()).decode()

        _ua = self.headers.get("User-Agent", "")
        _is_mobile = bool(re.search(r"Mobi|Android|iPhone|iPad|iPod", _ua, re.I))

        ctx = _ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = _ssl.CERT_NONE

        target = f"/{subpath}{'?' + query if query else ''}"
        try:
            conn = http.client.HTTPSConnection("127.0.0.1", port, context=ctx, timeout=15)
            fwd_headers = {
                "Host": f"127.0.0.1:{port}",
                "Authorization": f"Basic {auth}",
                "Accept-Encoding": "identity",   # ask for uncompressed so we can inject
            }
            for k, v in self.headers.items():
                kl = k.lower()
                if kl not in ("host", "accept-encoding", "connection", "upgrade", "authorization"):
                    fwd_headers[k] = v
            body_data = None
            if self.command in ("POST", "PUT", "PATCH"):
                clen = int(self.headers.get("Content-Length", 0))
                body_data = self.rfile.read(clen) if clen > 0 else b""
            conn.request(self.command, target, body=body_data, headers=fwd_headers)
            resp = conn.getresponse()
            body = resp.read()
            ct = resp.getheader("Content-Type", "")

            # On mobile: patch KasmVNC JS bundle for proper mouse-cursor mode
            if _is_mobile and "javascript" in ct and body:
                # 1. Force wl=false so the noVNC_touch CSS class is never added
                body = body.replace(
                    b'let wl="ontouchstart"in document.documentElement||document.ontouchstart!==void 0||navigator.maxTouchPoints>0||navigator.msMaxTouchPoints>0;',
                    b'let wl=false;',
                    1
                )
                # 2. Remove the touchstart listener that would reset wl back to true
                body = body.replace(
                    b'addEventListener("touchstart",function n(){wl=!0,window.removeEventListener("touchstart",n,!1)},!1);',
                    b'addEventListener("touchstart",function n(){window.removeEventListener("touchstart",n,!1)},!1);',
                    1
                )
                # 3. Force tn=false so the CSS-cursor path is used instead of the
                #    fallback canvas-overlay cursor.  Mobile browsers don't support
                #    CSS cursor:url(data:…), so zR ends up false → tn would be true
                #    → the overlay cursor is used.  The overlay only tracks mousemove
                #    events (not touch events), so it never moves and the cursor looks
                #    frozen ("touch mode").  With tn=false KasmVNC tries the CSS cursor
                #    (which silently fails on mobile, showing the default arrow), but
                #    the remote cursor in the video stream is still shown correctly and
                #    dragging the finger moves it as expected.
                body = body.replace(
                    b'const tn=!zR||wl;',
                    b'const tn=false;',
                    1
                )

            # Inject WebSocket redirect + mobile UX fixes into HTML
            if "text/html" in ct and body:
                _stop_js = (
                    f'fetch("/api/browser/stop",{{method:"POST",credentials:"same-origin",'
                    f'headers:{{"Content-Type":"application/json"}},body:JSON.stringify({{id:"{sid}"}})}})'
                    '.then(function(){try{window.close();}catch(x){}setTimeout(function(){window.location.href="/";},200);})'
                    '.catch(function(){window.location.href="/";});'
                )
                inject = _kasm_client_inject(f"/kasmvnc-ws/{sid}", _stop_js)
                if b"</head>" in body:
                    body = body.replace(b"</head>", inject + b"</head>", 1)
                else:
                    body = inject + body

            self.send_response(resp.status)
            for k, v in resp.getheaders():
                kl = k.lower()
                if kl in ("transfer-encoding", "content-encoding", "content-length",
                          "content-security-policy", "x-frame-options",
                          "cache-control", "pragma", "expires", "etag", "last-modified"):
                    continue   # strip cache + CSP/framing headers; we control caching
                self.send_header(k, v)
            # Never let the browser cache proxied KasmVNC assets — we patch the JS bundle
            # and caching would serve the unpatched version after a redeploy.
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            try:
                self.send_error(502, str(e))
            except Exception:
                pass
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def _kasmvnc_ws_proxy(self, sid):
        """Proxy WebSocket from browser → kasmweb container's WSS /websockify endpoint."""
        import ssl as _ssl, select as _select
        session = _browser_mgr.get_raw(sid)
        if not session:
            self.send_error(404, "Session nicht gefunden")
            return
        if self._get_session_role() != "admin" and \
           session.get("owner") != self._get_session_user():
            self.send_error(403, "Keine Berechtigung")
            return
        port = session["port"]

        # Complete handshake with browser — must echo Sec-WebSocket-Protocol or
        # strict browsers (Chrome/Firefox) close the connection immediately.
        ws_key   = self.headers.get("Sec-WebSocket-Key", "")
        ws_proto = self.headers.get("Sec-WebSocket-Protocol", "")
        self.connection.sendall(_ws_handshake_response(ws_key, ws_proto))
        self.close_connection = True

        # Open SSL connection to kasmweb container
        ctx = _ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = _ssl.CERT_NONE
        try:
            raw = socket.create_connection(("127.0.0.1", port), timeout=5)
            backend = ctx.wrap_socket(raw, server_hostname="127.0.0.1")
        except OSError:
            return

        # WebSocket handshake with kasmweb
        pw    = session.get("vnc_password", "")
        auth  = base64.b64encode(f"kasm_user:{pw}".encode()).decode()
        nonce = base64.b64encode(secrets.token_bytes(16)).decode()
        origin = self.headers.get("Origin", f"https://{self.headers.get('Host', 'localhost')}")
        backend.sendall((
            f"GET / HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{port}\r\n"
            f"Authorization: Basic {auth}\r\n"
            f"Origin: {origin}\r\n"
            f"Connection: Upgrade\r\n"
            f"Upgrade: websocket\r\n"
            f"Sec-WebSocket-Key: {nonce}\r\n"
            f"Sec-WebSocket-Version: 13\r\n"
            f"Sec-WebSocket-Protocol: binary, base64\r\n"
            f"\r\n"
        ).encode())

        buf = b""
        try:
            backend.settimeout(10)
            while b"\r\n\r\n" not in buf:
                chunk = backend.recv(4096)
                if not chunk:
                    backend.close()
                    return
                buf += chunk
            backend.settimeout(None)
        except OSError:
            backend.close()
            return

        # Forward any VNC data that arrived with the 101 headers
        leftover = buf[buf.find(b"\r\n\r\n") + 4:]
        if leftover:
            self.connection.sendall(leftover)

        # Tune sockets for low-latency interactive VNC
        _TCP_QUICKACK = 12  # Linux: send ACKs immediately, no 40ms delay
        for s in (self.connection, backend):
            try: s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except: pass
            try: s.setsockopt(socket.IPPROTO_TCP, _TCP_QUICKACK, 1)
            except: pass
            try: s.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 1 * 1024 * 1024)
            except: pass
            try: s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1 * 1024 * 1024)
            except: pass

        def pump_backend_to_browser(src, dst):
            """Screen-update relay (SSL backend → plain browser socket).
            Uses ssl.pending() to batch multiple decoded SSL records into one
            sendall(), reducing TCP segments to the browser without toggling
            blocking mode (which can corrupt SSL state under concurrent load)."""
            try:
                while True:
                    data = src.recv(262144)
                    if not data:
                        break
                    parts = [data]
                    # pending() returns bytes already decrypted in the SSL buffer —
                    # safe to read non-blocking without changing socket state.
                    while src.pending() > 0:
                        more = src.recv(min(src.pending(), 262144))
                        if not more:
                            break
                        parts.append(more)
                    dst.sendall(b"".join(parts))
            except Exception:
                pass
            finally:
                try: dst.shutdown(socket.SHUT_WR)
                except: pass

        def pump_browser_to_backend(src, dst):
            """Input-event relay (plain browser socket → SSL backend).
            Batches bursts of small events (keypresses, mouse moves) into one
            SSL sendall() to avoid creating a separate TLS record per keystroke."""
            try:
                while True:
                    data = src.recv(65536)
                    if not data:
                        break
                    # Drain any additional input already queued in the OS buffer
                    # (non-blocking is fine here because src is a plain TCP socket)
                    parts = [data]
                    src.setblocking(False)
                    try:
                        while True:
                            more = src.recv(65536)
                            if not more:
                                break
                            parts.append(more)
                    except (BlockingIOError, OSError):
                        pass
                    finally:
                        src.setblocking(True)
                    dst.sendall(b"".join(parts))
            except Exception:
                pass
            finally:
                try: dst.shutdown(socket.SHUT_WR)
                except: pass

        t = threading.Thread(target=pump_backend_to_browser, args=(backend, self.connection), daemon=True)
        t.start()
        pump_browser_to_backend(self.connection, backend)
        t.join(timeout=2)
        backend.close()

    # ── GET ──────────────────────────────────────────────────────────────────

    def do_DELETE(self):
        if not self._is_allowed_ip():
            self._deny_direct_access()
            return
        self.send_response(405)
        self.end_headers()

    def do_GET(self):
        # Block direct LAN / public-IP access — only Cloudflare tunnel IPs allowed
        if not self._is_allowed_ip():
            self._deny_direct_access()
            return

        parsed = urlparse(self.path)
        path = parsed.path

        # Login/logout endpoints are always accessible
        if path == "/login":
            self._serve_login()
            return
        if path == "/logout":
            token = self._get_session_token()
            if token:
                _session_mgr.invalidate(token)
            self.send_response(302)
            self.send_header("Location", "/login")
            self.send_header("Set-Cookie", "session=; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=0")
            self.end_headers()
            return

        # Token-Pfade: überspringen die generische Auth hier und prüfen im jeweiligen
        # Handler selbst Session + Token-Owner (siehe /ws/ und /kasmvnc-vm/ unten).
        if path.startswith("/ws/") or path.startswith("/kasmvnc-vm/"):
            pass  # handled later in the elif chain without auth
        # All other paths require authentication
        elif not self._is_authenticated():
            if path.startswith("/api/"):
                self.send_json({"error": "Nicht authentifiziert"}, 401)
            else:
                self._redirect("/login")
            return

        # Lesende VM-/Infrastruktur-Endpunkte (inkl. Konsolen-Zugriff) sind
        # ebenfalls Admin-only — ein Nicht-Admin hat hier nichts zu suchen.
        if path.startswith(("/api/vm", "/api/network", "/api/storage", "/api/user")):
            if self._require_admin():
                return

        if path == "/api/me":
            token = self._get_session_token()
            self.send_json({
                "username": _session_mgr.validate(token),
                "role": _session_mgr.get_role(token),
            })

        elif path == "/api/ping":
            self.send_json({"ok": True})

        elif path == "/api/setkbmap":
            layout = parse_qs(parsed.query).get("layout", [""])[0]
            if not re.match(r'^[a-z]{1,6}(-[a-z]{2,3})?$', layout):
                self.send_json({"error": "Ungültiges Layout"}, 400)
                return
            # setxkbmap uses short codes like "de", "fr", "us" — strip "-XX" suffix
            xkb_layout = layout.split("-")[0]
            try:
                subprocess.run(
                    _ns(["sh", "-c", f"DISPLAY=:0 setxkbmap {shlex.quote(xkb_layout)} 2>/dev/null; true"]),
                    timeout=4, capture_output=True,
                )
            except Exception:
                pass
            self.send_json({"ok": True, "layout": layout})
        elif path == "/api/system":
            self.send_json(get_system_info())
        elif path == "/api/cpu":
            self.send_json(get_cpu_info())
        elif path == "/api/memory":
            self.send_json(get_memory_info())
        elif path == "/api/disks":
            self.send_json(get_disk_info())
        elif path == "/api/network":
            self.send_json(get_network_info())
        elif path == "/api/processes":
            if self._require_admin(): return
            self.send_json(get_top_processes())
        elif path == "/api/services":
            if self._require_admin(): return
            self.send_json(get_services())
        elif path == "/api/users":
            if self._require_admin(): return
            self.send_json(list_users())
        elif path == "/api/terminal/info":
            if self._require_admin(): return
            self.send_json(get_terminal_info())
        elif path == "/api/updates":
            if self._require_admin(): return
            self.send_json(get_updates())
        elif path == "/api/vms":
            self.send_json(get_vms())
        elif path == "/api/vm/details":
            params = parse_qs(parsed.query)
            name = params.get("name", [""])[0]
            if not name:
                self.send_json({"error": "name parameter erforderlich"}, 400)
                return
            self.send_json(get_vm_full(name))

        elif path == "/api/vm/stats":
            params = parse_qs(parsed.query)
            name = params.get("name", [""])[0]
            if not name:
                self.send_json({"error": "name parameter erforderlich"}, 400)
                return
            self.send_json(vm_stats(name))

        elif path == "/api/vm/xml":
            name = parse_qs(parsed.query).get("name", [""])[0]
            if not name:
                self.send_json({"error": "name parameter erforderlich"}, 400)
                return
            self.send_json(vm_get_xml(name))

        elif path == "/api/vm/devices":
            name = parse_qs(parsed.query).get("name", [""])[0]
            if not name:
                self.send_json({"error": "name parameter erforderlich"}, 400)
                return
            self.send_json(vm_device_list(name))

        elif path == "/api/vm/hostdevices":
            self.send_json(list_host_devices())

        elif path == "/api/vm/snapshots":
            params = parse_qs(parsed.query)
            name = params.get("name", [""])[0]
            if not name:
                self.send_json({"error": "name erforderlich"}, 400)
                return
            self.send_json(vm_snapshot_list(name))

        elif path == "/api/networks":
            self.send_json({"networks": list_networks()})

        elif path == "/api/network/leases":
            name = parse_qs(parsed.query).get("name", [""])[0]
            if not name:
                self.send_json({"error": "name parameter erforderlich"}, 400)
                return
            self.send_json(net_leases(name))

        elif path == "/api/network/xml":
            name = parse_qs(parsed.query).get("name", [""])[0]
            if not name:
                self.send_json({"error": "name parameter erforderlich"}, 400)
                return
            self.send_json(net_get_xml(name))

        elif path == "/api/network/dhcp-hosts":
            name = parse_qs(parsed.query).get("name", [""])[0]
            if not name:
                self.send_json({"error": "name parameter erforderlich"}, 400)
                return
            self.send_json(net_dhcp_hosts(name))

        elif path == "/api/storage/pools":
            self.send_json({"pools": list_pools()})

        elif path == "/api/storage/volumes":
            params = parse_qs(parsed.query)
            pool = params.get("pool", [""])[0]
            if not pool:
                self.send_json({"error": "pool parameter erforderlich"}, 400)
                return
            self.send_json({"volumes": list_volumes(pool)})

        elif path == "/api/storage/isos":
            self.send_json({"isos": list_isos()})

        elif path == "/api/storage/iso/list":
            self.send_json({"isos": iso_list()})

        elif path == "/api/storage/iso/downloads":
            self.send_json(iso_download_status())

        elif path == "/api/vm/console":
            params = parse_qs(parsed.query)
            name  = params.get("name",  [""])[0]
            dtype = params.get("type",  ["auto"])[0]  # "vnc", "spice", "kasmvnc" or "auto"
            if not name:
                self.send_json({"error": "name parameter erforderlich"}, 400)
                return
            if dtype == "kasmvnc":
                # Echter KasmVNC-Server pro VM (gleicher Stack wie Browser-Sessions):
                # VM-Display → remote-viewer → Xkasmvnc → Token-Proxy → Browser.
                # SPICE bevorzugen (spice-vdagent passt die ECHTE VM-Auflösung an die
                # Browsergröße an; QEMU-VNC lehnt SetDesktopSize ab → nur Letterbox),
                # VNC als Fallback. Auch SPICE-only-VMs funktionieren so.
                if not (os.path.exists("/usr/bin/Xkasmvnc15") or os.path.exists("/usr/bin/Xkasmvnc")):
                    self.send_json({"error": "KasmVNC-Server nicht installiert (Image neu bauen)"})
                    return
                spice = get_vm_display(name, "spice")
                vnc   = get_vm_display(name, "vnc")
                if "error" not in spice and spice.get("port"):
                    viewer_target = f"spice://{spice['listen']}:{spice['port']}"
                elif "error" not in vnc and vnc.get("port"):
                    viewer_target = f"vnc://{vnc['listen']}:{vnc['port']}"
                else:
                    self.send_json({"error": "VM hat keine VNC/SPICE-Konsole"})
                    return
                try:
                    ws_port = _vmkasm_mgr.get_or_start(name, viewer_target)
                    token   = _ws_register(ws_port, self._get_session_user())
                    proto   = self.headers.get("X-Forwarded-Proto", "http")
                    host    = self.headers.get("Host", "localhost")
                    self.send_json({
                        "type": "kasmvnc",
                        "url":  f"{proto}://{host}/kasmvnc-vm/{token}/",
                    })
                except Exception as e:
                    self.send_json({"error": str(e)})
                return
            # Einfache VNC/SPICE-Konsole über websockify
            display = get_vm_display(name, dtype)
            if "error" in display:
                self.send_json(display)
                return
            target = f"{display['listen']}:{display['port']}"
            if display["type"] == "vnc":
                web_dir   = NOVNC_DIR
                html_page = "vnc_cmd.html"
            elif display["type"] == "spice":
                web_dir   = SPICE_DIR
                html_page = "spice_cmd.html"
            else:
                self.send_json({"error": f"Unbekannter Typ: {display['type']}"})
                return
            try:
                ws_port = _proxy_mgr.get_or_start(f"{display['type']}_{name}", target, web_dir)
                token   = _ws_register(ws_port, self._get_session_user())
                ctype   = display["type"]   # "vnc" or "spice"
                keymap  = display.get("keymap", "us")
                self.send_json({
                    "type": ctype,
                    "url":  _console_url(self.headers, ctype, token) + f"&keymap={keymap}",
                })
            except FileNotFoundError:
                self.send_json({"error": "websockify nicht installiert"})
            except Exception as e:
                self.send_json({"error": str(e)})
        # ── Browser sessions ──────────────────────────────────────────────────
        elif path == "/api/browser/list":
            _u = self._get_session_user()
            _admin = self._get_session_role() == "admin"
            sessions = _browser_mgr.list_all(owner=_u, is_admin=_admin)
            proto = self.headers.get("X-Forwarded-Proto", "http")
            host  = self.headers.get("Host", "localhost")
            for s in sessions:
                # kasmweb sessions are accessed via our built-in HTTP proxy
                if s.get("port"):
                    s["url"] = f"{proto}://{host}/kasmvnc/{s['id']}/"
                s.pop("vnc_password", None)   # never send password to frontend
            self.send_json({"sessions": sessions})

        # ── External connections ──────────────────────────────────────────────
        elif path == "/api/ext/list":
            _u = self._get_session_user()
            _admin = self._get_session_role() == "admin"
            self.send_json({"connections": _ext_mgr.list_all(owner=_u, is_admin=_admin)})

        elif path == "/api/terminal/ws":
            if self._require_admin(): return
            if self.headers.get("Upgrade", "").lower() != "websocket":
                self.send_json({"error": "WebSocket upgrade required"}, 426)
                return
            ws_key = self.headers.get("Sec-WebSocket-Key", "")
            self.connection.sendall(_ws_handshake_response(ws_key))
            self.close_connection = True
            self._handle_local_pty_ws()

        elif path.startswith("/api/ext/ssh/ws/"):
            cid = path[len("/api/ext/ssh/ws/"):]
            conn = _ext_mgr.get(cid, with_password=True,
                                owner=self._get_session_user(),
                                is_admin=self._get_session_role() == "admin")
            if not conn:
                self.send_json({"error": "Verbindung nicht gefunden"}, 404)
                return
            if self.headers.get("Upgrade", "").lower() != "websocket":
                self.send_json({"error": "WebSocket upgrade required"}, 426)
                return
            ws_key = self.headers.get("Sec-WebSocket-Key", "")
            self.connection.sendall(_ws_handshake_response(ws_key))
            self.close_connection = True
            self._handle_ssh_ws(conn)

        elif path == "/api/all":
            self.send_json({
                "system": get_system_info(),
                "cpu": get_cpu_info(),
                "memory": get_memory_info(),
                "disks": get_disk_info(),
                "network": get_network_info(),
                "processes": get_top_processes(10),
            })
        # ── WebSocket proxy (VNC / SPICE through main port) ──────────────────
        elif path.startswith("/ws/"):
            token = path[4:]
            port  = _ws_port_for(token)
            if port is None:
                self.send_error(404, "Unknown session")
                return
            # F2: gültige Session nötig — Token allein reicht nicht mehr.
            if not self._is_authenticated():
                self.send_error(401, "Nicht authentifiziert")
                return
            # F1: Token ist an den Besitzer gebunden (Nicht-Admin nur eigene).
            _owner = _ws_owner_for(token)
            if _owner and self._get_session_role() != "admin" \
                      and _owner != self._get_session_user():
                self.send_error(403, "Keine Berechtigung")
                return
            # Verbindungszähler für VM-KasmVNC-Sessions (No-Op für andere Ports),
            # damit die Idle-GC keine aktiven Sessions beendet
            _vmkasm_mgr.ws_delta(port, +1)
            try:
                self._ws_splice(port)
            finally:
                _vmkasm_mgr.ws_delta(port, -1)

        # ── Console HTML pages ────────────────────────────────────────────────
        elif path == "/console/vnc":
            token = parse_qs(parsed.query).get("session", [""])[0]
            self._serve_console("vnc", token)

        elif path == "/console/spice":
            token = parse_qs(parsed.query).get("session", [""])[0]
            self._serve_console("spice", token)

        # ── KasmVNC VM viewer ─────────────────────────────────────────────────
        elif path.startswith("/kasmvnc-vm/"):
            # /kasmvnc-vm/{token}/{subpath}
            if not self._is_authenticated():
                self.send_error(401, "Nicht authentifiziert")
                return
            rest  = path[len("/kasmvnc-vm/"):]
            parts = rest.split("/", 1)
            token   = parts[0]
            subpath = parts[1] if len(parts) > 1 else ""
            _owner = _ws_owner_for(token)
            if _owner and self._get_session_role() != "admin" \
                      and _owner != self._get_session_user():
                self.send_error(403, "Keine Berechtigung")
                return
            self._kasmvnc_vm_proxy(token, subpath)

        # ── noVNC / spice-html5 static assets ────────────────────────────────
        elif path.startswith("/novnc/"):
            self._serve_dir_file(NOVNC_DIR, path[7:])

        elif path.startswith("/spice-html5/"):
            self._serve_dir_file(SPICE_DIR, path[13:])

        # ── KasmVNC WebSocket proxy ───────────────────────────────────────────
        elif path.startswith("/kasmvnc-ws/"):
            if not self._is_authenticated():
                self.send_error(401)
                return
            sid = path[len("/kasmvnc-ws/"):]
            if self.headers.get("Upgrade", "").lower() == "websocket":
                self._kasmvnc_ws_proxy(sid)
            else:
                self.send_error(426, "WebSocket required")

        # ── KasmVNC HTTP proxy ────────────────────────────────────────────────
        elif path.startswith("/kasmvnc/"):
            if not self._is_authenticated():
                self._redirect("/login")
                return
            parts = path[len("/kasmvnc/"):].split("/", 1)
            sid     = parts[0]
            subpath = parts[1] if len(parts) > 1 else ""
            self._kasmvnc_http_proxy(sid, subpath, parsed.query)

        else:
            if path == "/":
                self.path = "/index.html"
            super().do_GET()

    # ── POST ─────────────────────────────────────────────────────────────────

    def do_POST(self):
        if not self._is_allowed_ip():
            self._deny_direct_access()
            return

        parsed = urlparse(self.path)
        path = parsed.path

        content_len = int(self.headers.get("Content-Length", 0))
        if content_len > 10 * 1024 * 1024:   # 10 MB Obergrenze gegen Speicher-DoS
            self.send_json({"error": "Request-Body zu groß"}, 413)
            return
        raw_body = self.rfile.read(content_len) if content_len > 0 else b""

        # Login form (no auth needed)
        if path == "/login":
            if _login_rate_limited(self.client_address[0]):
                self._serve_login("Zu viele Login-Versuche — bitte kurz warten.")
                return
            params = parse_qs(raw_body.decode("utf-8", errors="replace"))
            username = params.get("username", [""])[0].strip()
            password = params.get("password", [""])[0]

            if not username or not password:
                self._serve_login("Benutzername und Passwort erforderlich")
                return

            result = authenticate_user(username, password)
            if result is None:
                self._serve_login(
                    "/etc/shadow nicht lesbar — Volume-Mount prüfen:<br>"
                    "<code>- /etc/shadow:/etc/shadow:ro</code>"
                )
                return
            if not result:
                self._serve_login("Ungültiger Benutzername oder Passwort")
                return

            role = "admin" if is_sudo_user(username) else "user"
            token = _session_mgr.create(username, role)
            self.send_response(302)
            self.send_header("Location", "/")
            self.send_header(
                "Set-Cookie",
                f"session={token}; HttpOnly; Secure; Path=/; SameSite=Strict"
            )
            self.end_headers()
            return

        # All other POST endpoints require authentication
        if not self._is_authenticated():
            self.send_json({"error": "Nicht authentifiziert"}, 401)
            return

        # Host-verändernde Endpunkte (VMs, Netzwerke, Storage, Dienste, Prozesse)
        # erfordern Admin-Rechte. Bisher waren nur Terminal/Update/Keymap geschützt,
        # sodass jeder Nicht-Admin-Login VMs anlegen/löschen, Dienste stoppen,
        # Prozesse killen usw. konnte (Privilege Escalation).
        if path.startswith(("/api/vm/", "/api/network/", "/api/storage/",
                             "/api/service/", "/api/process/", "/api/user/")):
            if self._require_admin():
                return

        # Sensible, nicht gepollte Aktion: Benutzerverwaltung zusätzlich pro IP
        # drosseln (Missbrauch/Automatisierung). Großzügiges Limit, normaler
        # Admin-Betrieb wird nie gebremst.
        if path.startswith("/api/user/"):
            if _action_rate_limited("user", self.client_address[0]):
                self.send_json({"error": "Zu viele Aktionen — bitte kurz warten."}, 429)
                return

        try:
            data = json.loads(raw_body) if raw_body else {}
        except Exception:
            data = {}

        if path == "/api/terminal":
            if self._require_admin(): return
            cmd = data.get("command", "")
            timeout = min(data.get("timeout", 30), 120)
            if not cmd:
                self.send_json({"success": False, "returncode": 1, "stdout": "", "stderr": "Kein Befehl angegeben"}, 400)
            else:
                self.send_json(_pty_session.execute(cmd, timeout))

        elif path == "/api/terminal/stdin":
            if self._require_admin(): return
            reply   = data.get("reply", "")
            timeout = min(data.get("timeout", 30), 120)
            self.send_json(_pty_session.send_reply(reply, timeout))

        elif path == "/api/terminal/interrupt":
            if self._require_admin(): return
            _pty_session.interrupt()
            self.send_json({"ok": True})

        elif path == "/api/update":
            if self._require_admin(): return
            self.send_json(run_update())

        # ── External connections ──────────────────────────────────────────────
        elif path == "/api/ext/save":
            proto    = data.get("proto", "").lower().strip()
            host     = data.get("host", "").strip()
            port     = data.get("port")
            username = data.get("username", "").strip()
            password = data.get("password", "")
            label    = data.get("label", "").strip()
            if not proto or not host or not port:
                self.send_json({"error": "proto, host und port erforderlich"}, 400)
                return
            if proto not in ExtConnManager.PROTO_DEFAULTS:
                self.send_json({"error": f"Unbekanntes Protokoll: {proto}"}, 400)
                return
            if _ssrf_blocked(host):
                self.send_json({"error": "Zielhost nicht erlaubt (Loopback/Metadaten)"}, 400)
                return
            cid = _ext_mgr.save(proto, host, int(port), username, password, label,
                                owner=self._get_session_user())
            self.send_json({"id": cid, "success": True})

        elif path == "/api/ext/delete":
            cid = data.get("id", "")
            if not cid:
                self.send_json({"error": "id erforderlich"}, 400)
                return
            try:
                _ext_mgr.delete(cid, owner=self._get_session_user(),
                                is_admin=self._get_session_role() == "admin")
                self.send_json({"success": True})
            except PermissionError:
                self.send_json({"error": "Keine Berechtigung"}, 403)

        elif path == "/api/ext/connect":
            _u = self._get_session_user()
            _admin = self._get_session_role() == "admin"
            cid = data.get("id", "")
            conn = _ext_mgr.get(cid, with_password=False, owner=_u, is_admin=_admin)
            if not conn:
                self.send_json({"error": "Verbindung nicht gefunden"}, 404)
                return
            proto = conn["proto"]
            if proto == "vnc":
                try:
                    port  = _ext_mgr.start_proxy(cid, NOVNC_DIR, owner=_u, is_admin=_admin)
                    token = _ws_register(port, _u)
                    self.send_json({"url": _console_url(self.headers, "vnc", token)})
                except Exception as e:
                    self.send_json({"error": str(e)})
            elif proto == "spice":
                try:
                    port  = _ext_mgr.start_proxy(cid, SPICE_DIR, owner=_u, is_admin=_admin)
                    token = _ws_register(port, _u)
                    self.send_json({"url": _console_url(self.headers, "spice", token)})
                except Exception as e:
                    self.send_json({"error": str(e)})
            elif proto in ("ssh", "scp"):
                self.send_json({"url": f"/ssh_terminal.html?id={cid}"})
            elif proto == "rdp":
                self.send_json({"error": "RDP benötigt Guacamole oder FreeRDP — nicht direkt im Browser unterstützt"})
            else:
                self.send_json({"error": f"Protokoll '{proto}' nicht unterstützt"})

        # ── Browser sessions ──────────────────────────────────────────────────
        elif path == "/api/browser/start":
            image_key = data.get("image", "firefox").strip()
            label     = data.get("label", "").strip()
            audio     = bool(data.get("audio", False))
            try:
                session = _browser_mgr.start(image_key, label, owner=self._get_session_user(), audio=audio)
                proto = self.headers.get("X-Forwarded-Proto", "http")
                host  = self.headers.get("Host", "localhost")
                session["url"] = f"{proto}://{host}/kasmvnc/{session['id']}/"
                session.pop("vnc_password", None)   # never send password to frontend
                self.send_json({"session": session})
            except Exception as e:
                self.send_json({"error": str(e)})

        elif path == "/api/browser/stop":
            sid = data.get("id", "")
            if not sid:
                self.send_json({"error": "id erforderlich"}, 400)
                return
            try:
                _browser_mgr.stop(sid, owner=self._get_session_user(),
                                  is_admin=self._get_session_role() == "admin")
                self.send_json({"success": True})
            except PermissionError:
                self.send_json({"error": "Keine Berechtigung"}, 403)

        elif path == "/api/vm/action":
            name = data.get("name", "")
            action = data.get("action", "")
            if not name or not action:
                self.send_json({"success": False, "error": "name und action erforderlich"}, 400)
            else:
                self.send_json(vm_action(name, action))

        elif path == "/api/vm/create":
            name = data.get("name", "")
            vcpus = int(data.get("vcpus", 2))
            memory_mib = int(data.get("memory_mib", 2048))
            pool = data.get("pool", "default")
            disk_size_gib = int(data.get("disk_size_gib", 20))
            iso_path = data.get("iso_path", "")
            network = data.get("network", "default")
            machine = data.get("machine", "q35")
            os_type = data.get("os_type", "linux")
            virtio_iso = data.get("virtio_iso", "")
            if not name:
                self.send_json({"error": "name erforderlich"}, 400)
            else:
                self.send_json(vm_create(name, vcpus, memory_mib, pool,
                                         disk_size_gib, iso_path, network, machine,
                                         os_type=os_type, virtio_iso=virtio_iso))

        elif path == "/api/vm/delete":
            name = data.get("name", "")
            if not name:
                self.send_json({"error": "name erforderlich"}, 400)
            else:
                self.send_json(vm_delete(name, data.get("delete_volumes", False)))

        elif path == "/api/vm/update":
            name = data.get("name", "")
            if not name:
                self.send_json({"error": "name erforderlich"}, 400)
            else:
                self.send_json(vm_update(
                    name,
                    vcpus=data.get("vcpus"),
                    memory_mib=data.get("memory_mib"),
                    autostart=data.get("autostart"),
                    boot_order=data.get("boot_order"),
                    cpu_sockets=data.get("cpu_sockets"),
                    cpu_cores=data.get("cpu_cores"),
                    cpu_threads=data.get("cpu_threads"),
                    cpu_mode=data.get("cpu_mode"),
                    video_type=data.get("video_type"),
                    video_vram=data.get("video_vram"),
                    add_sound=data.get("add_sound"),
                    remove_sound=data.get("remove_sound"),
                    firmware=data.get("firmware"),
                    secure_boot=data.get("secure_boot"),
                    add_tpm=data.get("add_tpm"),
                    remove_tpm=data.get("remove_tpm"),
                    boot_menu=data.get("boot_menu"),
                ))

        elif path == "/api/vm/device/add":
            name = data.get("name", "")
            kind = data.get("kind", "")
            if not name or not kind:
                self.send_json({"error": "name und kind erforderlich"}, 400)
            else:
                self.send_json(vm_add_device(name, kind, data.get("params") or {}))

        elif path == "/api/vm/device/remove":
            name = data.get("name", "")
            if not name or data.get("index") is None:
                self.send_json({"error": "name und index erforderlich"}, 400)
            else:
                self.send_json(vm_remove_device(name, data.get("index")))

        elif path == "/api/vm/xml":
            name = data.get("name", "")
            xml = data.get("xml", "")
            if not name or not xml:
                self.send_json({"error": "name und xml erforderlich"}, 400)
            else:
                self.send_json(vm_set_xml(name, xml))

        elif path == "/api/vm/snapshot/create":
            name = data.get("name", "")
            snap = data.get("snapshot_name", "").strip()
            if not name or not snap:
                self.send_json({"error": "name und snapshot_name erforderlich"}, 400)
            else:
                self.send_json(vm_snapshot_create(name, snap, data.get("description", "")))

        elif path == "/api/vm/snapshot/delete":
            name = data.get("name", "")
            snap = data.get("snapshot_name", "")
            if not name or not snap:
                self.send_json({"error": "name und snapshot_name erforderlich"}, 400)
            else:
                self.send_json(vm_snapshot_delete(name, snap))

        elif path == "/api/vm/snapshot/revert":
            name = data.get("name", "")
            snap = data.get("snapshot_name", "")
            if not name or not snap:
                self.send_json({"error": "name und snapshot_name erforderlich"}, 400)
            else:
                self.send_json(vm_snapshot_revert(name, snap))

        elif path == "/api/vm/clone":
            src = data.get("name", "")
            dst = data.get("new_name", "").strip()
            if not src or not dst:
                self.send_json({"error": "name und new_name erforderlich"}, 400)
            else:
                self.send_json(vm_clone(src, dst))

        elif path == "/api/vm/keymap":
            if self._require_admin(): return
            name   = data.get("name", "")
            keymap = data.get("keymap", "").strip()
            if not name or not keymap:
                self.send_json({"error": "name und keymap erforderlich"}, 400)
            elif not re.match(r'^[a-z]{1,6}(-[a-z]{2,3})?$', keymap):
                self.send_json({"error": "Ungültiges Tastaturlayout"}, 400)
            else:
                self.send_json(set_vm_vnc_keymap(name, keymap))

        elif path == "/api/vm/disk/attach":
            name = data.get("name", "")
            if not name:
                self.send_json({"error": "name erforderlich"}, 400)
            else:
                self.send_json(vm_disk_attach(
                    name,
                    data.get("source_path", ""),
                    data.get("target_dev", ""),
                    data.get("bus", "virtio"),
                    data.get("format", "qcow2"),
                    data.get("readonly", False),
                    device=data.get("device", "disk")
                ))

        elif path == "/api/vm/disk/detach":
            name = data.get("name", "")
            target_dev = data.get("target_dev", "")
            if not name or not target_dev:
                self.send_json({"error": "name und target_dev erforderlich"}, 400)
            else:
                self.send_json(vm_disk_detach(name, target_dev,
                                              delete_storage=bool(data.get("delete_storage"))))

        elif path == "/api/vm/nic/attach":
            name = data.get("name", "")
            if not name:
                self.send_json({"error": "name erforderlich"}, 400)
            else:
                self.send_json(vm_nic_attach(
                    name,
                    data.get("network", "default"),
                    data.get("model", "virtio")
                ))

        elif path == "/api/vm/nic/detach":
            name = data.get("name", "")
            mac = data.get("mac", "")
            if not name or not mac:
                self.send_json({"error": "name und mac erforderlich"}, 400)
            else:
                self.send_json(vm_nic_detach(name, mac))

        elif path == "/api/network/create":
            net_name = data.get("name", "")
            ip_cidr = data.get("ip_cidr", "")
            forward_mode = data.get("forward_mode", "nat")
            if not net_name or not ip_cidr:
                self.send_json({"error": "name und ip_cidr erforderlich"}, 400)
            else:
                self.send_json(net_create(net_name, ip_cidr, forward_mode))

        elif path == "/api/network/action":
            net_name = data.get("name", "")
            action = data.get("action", "")
            if not net_name or not action:
                self.send_json({"error": "name und action erforderlich"}, 400)
            else:
                self.send_json(net_action(net_name, action))

        elif path == "/api/network/xml":
            net_name = data.get("name", "")
            xml = data.get("xml", "")
            if not net_name or not xml:
                self.send_json({"error": "name und xml erforderlich"}, 400)
            else:
                self.send_json(net_set_xml(net_name, xml))

        elif path == "/api/network/edit":
            net_name = data.get("name", "")
            if not net_name:
                self.send_json({"error": "name erforderlich"}, 400)
            else:
                self.send_json(net_edit(
                    net_name,
                    forward_mode=data.get("forward_mode"),
                    ip=data.get("ip"),
                    prefix=data.get("prefix"),
                    dhcp_start=data.get("dhcp_start"),
                    dhcp_end=data.get("dhcp_end"),
                    dhcp_enabled=data.get("dhcp_enabled"),
                ))

        elif path == "/api/network/dhcp-host/add":
            net_name = data.get("name", "")
            if not net_name:
                self.send_json({"error": "name erforderlich"}, 400)
            else:
                self.send_json(net_add_dhcp_host(net_name, data.get("mac", ""),
                                                 data.get("ip", ""), data.get("hostname", "")))

        elif path == "/api/network/dhcp-host/remove":
            net_name = data.get("name", "")
            mac = data.get("mac", "")
            if not net_name or not mac:
                self.send_json({"error": "name und mac erforderlich"}, 400)
            else:
                self.send_json(net_remove_dhcp_host(net_name, mac))

        elif path == "/api/vm/graphics":
            name = data.get("name", "")
            if not name:
                self.send_json({"error": "name erforderlich"}, 400)
            else:
                self.send_json(vm_set_graphics(name, vnc=data.get("vnc"),
                                               spice=data.get("spice")))

        elif path == "/api/vm/kasmvnc":
            name = data.get("name", "")
            if not name or data.get("enabled") is None:
                self.send_json({"error": "name und enabled erforderlich"}, 400)
            else:
                self.send_json(set_kasmvnc_pref(name, bool(data.get("enabled"))))

        elif path == "/api/storage/volume/create":
            pool = data.get("pool", "")
            vol_name = data.get("vol_name", "")
            size_gib = int(data.get("size_gib", 10))
            fmt = data.get("format", "qcow2")
            if not pool or not vol_name:
                self.send_json({"error": "pool und vol_name erforderlich"}, 400)
            else:
                self.send_json(vol_create(pool, vol_name, size_gib, fmt))

        elif path == "/api/storage/volume/delete":
            pool = data.get("pool", "")
            vol_name = data.get("vol_name", "")
            if not pool or not vol_name:
                self.send_json({"error": "pool und vol_name erforderlich"}, 400)
            else:
                self.send_json(vol_delete(pool, vol_name))

        elif path == "/api/storage/iso/download":
            url = data.get("url", "")
            if not url:
                self.send_json({"error": "url erforderlich"}, 400)
            else:
                self.send_json(iso_download(url, data.get("filename", "")))

        elif path == "/api/storage/iso/delete":
            p = data.get("path", "")
            if not p:
                self.send_json({"error": "path erforderlich"}, 400)
            else:
                self.send_json(iso_delete(p))

        elif path == "/api/user/create":
            self.send_json(create_user(
                data.get("username", ""), data.get("password", ""),
                is_admin=bool(data.get("is_admin")),
                shell=data.get("shell", "/bin/bash")))

        elif path == "/api/user/update":
            uname = data.get("username", "")
            cur = self._get_session_user()
            is_admin = data.get("is_admin")
            # Selbst-Aussperr-Schutz: eigene Admin-Rechte nicht entziehen
            if uname == cur and is_admin is False:
                self.send_json({"error": "Sie können sich nicht selbst die Admin-Rechte entziehen"}, 400)
            else:
                self.send_json(update_user(uname, password=data.get("password"),
                                           is_admin=is_admin))

        elif path == "/api/user/delete":
            uname = data.get("username", "")
            if uname == self._get_session_user():
                self.send_json({"error": "Sie können sich nicht selbst löschen"}, 400)
            else:
                self.send_json(delete_user(uname, remove_home=bool(data.get("remove_home", True))))

        elif path == "/api/service/action":
            name = data.get("name", "")
            action = data.get("action", "")
            allowed = ["start", "stop", "restart", "enable", "disable"]
            if action not in allowed:
                self.send_json({"success": False, "error": f"Erlaubt: {', '.join(allowed)}"}, 400)
            else:
                cmd = ["systemctl", action, name]
                success = False
                output = ""
                for full_cmd in [_ns(cmd), cmd]:
                    try:
                        result = subprocess.run(full_cmd, capture_output=True, text=True, timeout=30)
                        success = result.returncode == 0
                        output = result.stdout + result.stderr
                        break
                    except FileNotFoundError:
                        continue
                    except Exception as e:
                        output = str(e)
                        break
                self.send_json({"success": success, "output": output})

        elif path == "/api/process/kill":
            pid = data.get("pid")
            sig = data.get("signal", "TERM")
            if not pid:
                self.send_json({"success": False, "error": "pid erforderlich"}, 400)
            else:
                try:
                    os.kill(int(pid), getattr(signal, f"SIG{sig}", signal.SIGTERM))
                    self.send_json({"success": True})
                except Exception as e:
                    self.send_json({"success": False, "error": str(e)})

        # ── KasmVNC POST proxy (API calls from kasmweb JS) ───────────────────
        elif path.startswith("/kasmvnc/"):
            if not self._is_authenticated():
                self.send_json({"error": "Nicht authentifiziert"}, 401)
                return
            parts = path[len("/kasmvnc/"):].split("/", 1)
            sid     = parts[0]
            subpath = parts[1] if len(parts) > 1 else ""
            self._kasmvnc_http_proxy(sid, subpath, parsed.query)

        else:
            self.send_json({"error": "Not found"}, 404)

    def _handle_local_pty_ws(self):
        """Serve a dedicated bash PTY over an already-upgraded WebSocket.
        Each browser connection gets its own PTY — supports nano, vim, htop, etc."""
        sock = self.connection
        sock.settimeout(None)

        try:
            master, slave = pty.openpty()
        except OSError as exc:
            _ws_send(sock, f"\r\nFehler: PTY konnte nicht erstellt werden: {exc}\r\n".encode())
            return

        try:
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
        except OSError:
            pass

        env = dict(os.environ)
        env['TERM']      = 'xterm-256color'
        env['COLORTERM'] = 'truecolor'
        env.setdefault('LANG', 'en_US.UTF-8')

        def _child_setup():
            os.setsid()
            # Make the slave PTY the controlling terminal of the new session so that
            # VINTR (Ctrl+C / 0x03) on the master is converted to SIGINT by the kernel
            # and delivered to the foreground process group (e.g. top, vim, nano).
            try:
                fcntl.ioctl(0, termios.TIOCSCTTY, 0)
            except OSError:
                pass

        proc = None
        for cmd in [_ns(['bash', '-i']), ['bash', '-i']]:
            try:
                proc = subprocess.Popen(
                    cmd, stdin=slave, stdout=slave, stderr=slave,
                    env=env, close_fds=True, preexec_fn=_child_setup,
                )
                break
            except (FileNotFoundError, OSError):
                continue

        try:
            os.close(slave)
        except OSError:
            pass

        if proc is None:
            _ws_send(sock, b"\r\nFehler: bash konnte nicht gestartet werden.\r\n")
            try: os.close(master)
            except OSError: pass
            return

        fl = fcntl.fcntl(master, fcntl.F_GETFL)
        fcntl.fcntl(master, fcntl.F_SETFL, fl | os.O_NONBLOCK)

        alive = threading.Event()
        alive.set()

        def pty_to_ws():
            while alive.is_set():
                try:
                    r, _, _ = select.select([master], [], [], 0.04)
                    if r:
                        try:
                            data = os.read(master, 8192)
                            if not data:
                                break
                            if not _ws_send(sock, data, opcode=0x02):
                                break
                        except (OSError, BlockingIOError):
                            if not alive.is_set():
                                break
                except (OSError, ValueError):
                    break
            alive.clear()

        reader = threading.Thread(target=pty_to_ws, daemon=True)
        reader.start()

        try:
            while alive.is_set():
                opcode, data = _ws_recv(sock)
                if opcode is None or opcode == 0x08:
                    break
                if opcode == 0x01 and data:  # text frame: resize message
                    try:
                        msg = json.loads(data.decode('utf-8', errors='replace'))
                        if msg.get('type') == 'resize':
                            cols = max(10, min(500, int(msg.get('cols', 80))))
                            rows = max(2,  min(200, int(msg.get('rows', 24))))
                            fcntl.ioctl(master, termios.TIOCSWINSZ,
                                        struct.pack('HHHH', rows, cols, 0, 0))
                    except Exception:
                        pass
                elif opcode == 0x02 and data:  # binary frame: raw PTY input
                    try:
                        os.write(master, data)
                    except OSError:
                        pass
        except Exception:
            pass
        finally:
            alive.clear()
            try: proc.terminate()
            except Exception: pass
            try: proc.wait(timeout=2)
            except Exception:
                try: proc.kill()
                except Exception: pass
            try: os.close(master)
            except OSError: pass

    def _handle_ssh_ws(self, conn):
        """Run an SSH session over an already-upgraded WebSocket (self.connection)."""
        sock = self.connection
        sock.settimeout(None)

        try:
            import paramiko
        except ImportError:
            _ws_send(sock, b"\r\nFehler: python3-paramiko ist nicht installiert.\r\n")
            return

        try:
            ssh = paramiko.SSHClient()
            ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            ssh.connect(
                conn["host"], port=conn["port"],
                username=conn["username"], password=conn["_password"],
                timeout=15, look_for_keys=False, allow_agent=False,
            )
            channel = ssh.invoke_shell(term="xterm-256color", width=220, height=50)
            channel.settimeout(0.0)
        except Exception as e:
            _ws_send(sock, f"\r\nSSH Fehler: {e}\r\n".encode())
            return

        _ext_mgr.set_status(conn["id"], "connected")
        alive = threading.Event()
        alive.set()

        def ssh_to_ws():
            while alive.is_set():
                try:
                    r, _, _ = select.select([channel], [], [], 0.2)
                    if r:
                        data = channel.recv(8192)
                        if not data:
                            break
                        if not _ws_send(sock, data, opcode=0x02):
                            break
                except Exception:
                    break
            alive.clear()

        reader = threading.Thread(target=ssh_to_ws, daemon=True)
        reader.start()

        try:
            while alive.is_set():
                opcode, data = _ws_recv(sock)
                if opcode is None or opcode == 0x08:
                    break
                if opcode in (0x01, 0x02) and data:
                    channel.send(data)
        except Exception:
            pass
        finally:
            alive.clear()
            try:
                channel.close()
                ssh.close()
            except Exception:
                pass
            _ext_mgr.set_status(conn["id"], "idle")

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()


