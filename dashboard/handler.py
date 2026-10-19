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

from dashboard.auth import _LOGIN_HTML, _action_rate_limited, _login_rate_limited, _session_mgr, authenticate_user, client_ip, create_user, delete_user, invalidate_role_cache, is_sudo_user, list_users, live_role, log_auth_event, resolve_role, role_at_least, update_user
from dashboard.base import NOVNC_DIR, SPICE_DIR, STATIC_DIR, _ns
from dashboard.browsers import _browser_mgr
from dashboard.consoles import _console_url, _kasm_client_inject, _proxy_mgr, _vmkasm_mgr, _ws_handshake_response, _ws_owner_for, _ws_port_for, _ws_recv, _ws_register, _ws_send
from dashboard.docker import _docker_frames, _docker_stream_close, _ws_slot_free, _ws_slot_take, docker_changes, docker_container, docker_container_action, docker_container_remove, docker_container_rename, docker_container_update, docker_containers, docker_df, docker_events, docker_exec_cleanup, docker_exec_message_de, docker_exec_open, docker_exec_resize, docker_archive_open, docker_archive_put, docker_container_commit, docker_container_create, docker_hub_search, docker_hub_tags, docker_image_build, docker_image_history, docker_image_inspect, docker_image_pull, docker_image_remove, docker_image_save_open, docker_image_tag, docker_images, docker_inspect, docker_job, docker_jobs, docker_logs, docker_logs_open, docker_network, docker_network_connect, docker_network_create, docker_network_disconnect, docker_network_remove, docker_networks, docker_prune, docker_prune_dryrun, docker_stack_action, docker_stack_compose, docker_stacks, docker_stats, docker_system, docker_top, docker_volume, docker_volume_create, docker_volume_remove, docker_volumes
from dashboard.extconn import ExtConnManager, _ext_mgr, _ssrf_blocked, load_pkey
from dashboard.prefs import get_prefs, set_prefs, ssh_default_secret
from dashboard.networks import list_networks, net_action, net_add_dhcp_host, net_create, net_dhcp_hosts, net_edit, net_get_xml, net_leases, net_remove_dhcp_host, net_set_xml
from dashboard.storage import iso_delete, iso_download, iso_download_status, iso_list, list_isos, list_pools, list_volumes, vol_create, vol_delete
from dashboard.security import security_ban, security_bans, security_events, security_unban
from dashboard.notify import ntfy_messages
from dashboard.ids import ids_live
from dashboard.sysinfo import get_cpu_info, get_disk_info, get_memory_info, get_network_info, get_services, get_system_info, get_top_processes, get_updates, run_update
from dashboard.terminal import _pty_session, get_terminal_info
from dashboard.vms import vm_ensure_absolute_pointer, vm_owner_get, vm_owner_set, vm_owner_remove, vm_names_owned_by, vm_viewers_get, vm_viewers_set, vm_viewers_remove, vm_names_visible_to
from dashboard.vms import _v as _virsh
from dashboard.vmshare import SHARE_COOKIE, _share_mgr, share_guest_inject, share_page, _esc as _share_esc
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
        """Rolle der aktuellen Sitzung — live vom Host, nicht die beim Login
        eingefrorene. Sonst wirkt ein nachträglich vergebenes (oder entzogenes)
        Admin-Recht (Gruppe dashadmin) erst beim nächsten Login. Die Session-Rolle bleibt Fallback,
        falls der Benutzer nicht mehr auflösbar ist."""
        token = self._get_session_token()
        user = _session_mgr.validate(token)
        if not user:
            return None
        return live_role(user, _session_mgr.get_role(token))

    def _is_superadmin(self):
        return self._get_session_role() == "superadmin"

    def _require_admin(self):
        """403 + True, wenn die Sitzung weder admin noch superadmin ist."""
        if not role_at_least(self._get_session_role(), "admin"):
            self.send_json({"error": "Keine Berechtigung"}, 403)
            return True
        return False

    def _require_superadmin(self):
        """403 + True, wenn die Sitzung kein superadmin ist (root/jokergame)."""
        if not self._is_superadmin():
            self.send_json({"error": "Nur für Superadmins"}, 403)
            return True
        return False

    def _vm_denied(self, name, need="full"):
        """Besitz-/Sichtbarkeitsprüfung. need="full": Superadmin oder Besitzer;
        need="view": zusätzlich von Superadmins freigegebene Benutzer (Konsole,
        Power-Aktionen, Lesen). Sendet 403 und liefert True bei Verweigerung."""
        if self._is_superadmin():
            return False
        user = self._get_session_user()
        if name and vm_owner_get(name) == user:
            return False
        if need == "view" and name and user in vm_viewers_get(name):
            return False
        self.send_json({"error": "VM nicht gefunden oder keine Berechtigung"}, 403)
        return True

    def _vm_access_level(self, name):
        if self._is_superadmin() or vm_owner_get(name) == self._get_session_user():
            return "full"
        return "view"

    def _browser_denied(self, session):
        """Browser-Session: Superadmin, Besitzer oder freigegebener Benutzer."""
        if self._is_superadmin():
            return False
        return not _browser_mgr.can_view(session, self._get_session_user())

    def _admin_owns_path(self, path_or_name):
        """Admins dürfen nur Volumes anhängen/anlegen/löschen, deren Dateiname mit
        dem Namen einer eigenen VM beginnt (z. B. meinevm.qcow2, meinevm-data.qcow2).
        Verhindert das Einbinden fremder VM-Disks oder beliebiger Host-Images."""
        base = os.path.basename(str(path_or_name or ""))
        owned = vm_names_owned_by(self._get_session_user())
        return any(base == n or base.startswith(n + ".") or base.startswith(n + "-")
                   or base.startswith(n + "_") for n in owned)

    # ── Öffentliche VM-Freigaben (Gast-Links, siehe dashboard/vmshare.py) ────

    def _share_from_cookie(self):
        """Gültige Freigabe aus dem Gast-Cookie — None, wenn keins oder abgelaufen."""
        sc = SimpleCookie()
        try:
            sc.load(self.headers.get("Cookie", ""))
        except Exception:
            return None
        if SHARE_COOKIE not in sc:
            return None
        return _share_mgr.get_valid(sc[SHARE_COOKIE].value)

    def _share_for_ws_token(self, token):
        """(share, is_share_token) für ein Konsolen-Token.

        Gast-Tokens tragen den Besitzer "share:<id>". is_share_token=True und
        share=None bedeutet: Freigabe inzwischen abgelaufen/widerrufen.
        """
        owner = _ws_owner_for(token) or ""
        if not owner.startswith("share:"):
            return None, False
        return _share_mgr.get_valid(owner[len("share:"):]), True

    def _send_html(self, body: bytes, status=200, extra_headers=None):
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra_headers or []):
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _serve_share(self, sid: str, params):
        """Einstieg für Gäste: /share/vm/<id> → Konsole der freigegebenen VM."""
        share = _share_mgr.get_valid(sid)
        if not share:
            self._send_html(share_page(
                "Link ungültig oder abgelaufen",
                "Diese VM-Freigabe existiert nicht mehr. Bitte den Administrator um einen neuen Link.",
                icon="&#128274;"), 410)
            return
        vm  = share["vm"]
        url = f"/share/vm/{sid}"
        if params.get("closed", [""])[0]:
            self._send_html(share_page(
                "Verbindung beendet",
                f"Die Konsole von <b>{_share_esc(vm)}</b> wurde geschlossen. Die Freigabe ist "
                "weiterhin gültig — du kannst dich erneut verbinden.",
                icon="&#128075;", button=("Erneut verbinden", url)))
            return
        # Die VM muss laufen — ein Gast darf sie weder starten noch sonst verändern.
        r = _virsh("domstate", vm)
        if r.returncode != 0 or "running" not in (r.stdout or "").lower():
            self._send_html(share_page(
                "VM ist nicht eingeschaltet",
                f"<b>{_share_esc(vm)}</b> läuft gerade nicht. Bitte später erneut versuchen "
                "oder den Administrator informieren.",
                icon="&#9208;", button=("Erneut versuchen", url)), 503)
            return
        ttl = max(60, int(float(share["expires"]) - time.time()))
        res = self._console_session(vm, share.get("type", "kasmvnc"), f"share:{sid}", ttl=ttl)
        if res.get("error"):
            self._send_html(share_page(
                "Konsole nicht verfügbar", _share_esc(res["error"]),
                icon="&#9888;", button=("Erneut versuchen", url)), 503)
            return
        ip = client_ip(self)
        _share_mgr.touch(sid, ip)
        print(f"[vmshare] Gast-Zugriff auf VM {vm} ({share.get('type')}) von {ip}", flush=True)
        # Cookie erlaubt dem Gast NUR die Konsolen-Seiten + deren statische Dateien
        # (Gate in do_GET); SameSite=Lax, weil der Einstieg von extern kommt.
        cookie = (f"{SHARE_COOKIE}={sid}; HttpOnly;{self._cookie_secure()} Path=/; SameSite=Lax; "
                  f"Max-Age={ttl}")
        self.send_response(302)
        self.send_header("Location", res["url"])
        self.send_header("Set-Cookie", cookie)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def _console_session(self, name: str, dtype: str, owner: str, ttl: int = 1800) -> dict:
        """Konsole für eine VM bereitstellen (Proxy starten, Token registrieren).

        Liefert {"type", "url", "notice"} oder {"error"}. Wird von /api/vm/console
        (Admin) und /share/vm/<id> (Gast, owner="share:<id>") gemeinsam genutzt.
        """
        # Absolutes Zeigegerät sicherstellen (USB-Tablet, live per Hotplug):
        # nur so liegt der Gast-Mauszeiger exakt unter dem Fadenkreuz/Cursor
        # der Konsole — gilt für VNC, SPICE und KasmVNC gleichermaßen.
        notice = ""
        try:
            _ptr = vm_ensure_absolute_pointer(name)
            if _ptr.get("attached"):
                notice = "USB-Tablet (absoluter Mauszeiger) zur VM hinzugefügt"
                if _ptr.get("warnings"):
                    notice += " — " + "; ".join(_ptr["warnings"])
            elif _ptr.get("error"):
                print(f"[console] Tablet-Hotplug für {name} nicht möglich: {_ptr['error']}", flush=True)
        except Exception as _e:
            print(f"[console] Tablet-Hotplug für {name} fehlgeschlagen: {_e}", flush=True)
        if dtype == "kasmvnc":
            # Echter KasmVNC-Server pro VM (gleicher Stack wie Browser-Sessions):
            # VM-Display → remote-viewer → Xkasmvnc → Token-Proxy → Browser.
            # SPICE bevorzugen (spice-vdagent passt die ECHTE VM-Auflösung an die
            # Browsergröße an; QEMU-VNC lehnt SetDesktopSize ab → nur Letterbox),
            # VNC als Fallback. Auch SPICE-only-VMs funktionieren so.
            if not (os.path.exists("/usr/bin/Xkasmvnc15") or os.path.exists("/usr/bin/Xkasmvnc")):
                return {"error": "KasmVNC-Server nicht installiert (Image neu bauen)"}
            spice = get_vm_display(name, "spice")
            vnc   = get_vm_display(name, "vnc")
            if "error" not in spice and spice.get("port"):
                viewer_target = f"spice://{spice['listen']}:{spice['port']}"
            elif "error" not in vnc and vnc.get("port"):
                viewer_target = f"vnc://{vnc['listen']}:{vnc['port']}"
            else:
                return {"error": "VM hat keine VNC/SPICE-Konsole"}
            try:
                ws_port = _vmkasm_mgr.get_or_start(name, viewer_target)
                token   = _ws_register(ws_port, owner, ttl=ttl)
                proto   = self.headers.get("X-Forwarded-Proto", "http")
                host    = self.headers.get("Host", "localhost")
                return {
                    "type": "kasmvnc",
                    "url":  f"{proto}://{host}/kasmvnc-vm/{token}/",
                    "notice": notice,
                }
            except Exception as e:
                return {"error": str(e)}
        # Einfache VNC/SPICE-Konsole über websockify
        display = get_vm_display(name, dtype)
        if "error" in display:
            return display
        target = f"{display['listen']}:{display['port']}"
        if display["type"] == "vnc":
            web_dir   = NOVNC_DIR
            html_page = "vnc_cmd.html"
        elif display["type"] == "spice":
            web_dir   = SPICE_DIR
            html_page = "spice_cmd.html"
        else:
            return {"error": f"Unbekannter Typ: {display['type']}"}
        try:
            ws_port = _proxy_mgr.get_or_start(f"{display['type']}_{name}", target, web_dir)
            token   = _ws_register(ws_port, owner, ttl=ttl)
            ctype   = display["type"]   # "vnc" or "spice"
            keymap  = display.get("keymap", "us")
            return {
                "type": ctype,
                "url":  _console_url(self.headers, ctype, token) + f"&keymap={keymap}",
                "notice": notice,
            }
        except FileNotFoundError:
            return {"error": "websockify nicht installiert"}
        except Exception as e:
            return {"error": str(e)}

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
        # Statische Dateien gingen bisher nur mit Last-Modified raus, ohne
        # Cache-Control. Browser leiten daraus eine eigene Haltbarkeit ab
        # (Faustregel: 10 % des Dateialters) und fragen in der Zeit gar nicht
        # erst nach — nach einem Deploy sah man tagelang die alte Oberfläche.
        # Revalidierung erzwingen: die Dateien sind klein, und mit
        # If-Modified-Since bleibt es bei einem 304, solange sich nichts ändert.
        if getattr(self, "_static_asset", False):
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        super().end_headers()

    def send_json(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    # ── IP access control ────────────────────────────────────────────────────
    # Standard: nur localhost und Docker-Bridges (10/8, 172.16/12) - also nur
    # ueber einen lokalen Reverse-Proxy oder einen Tunnel-Container.
    #
    # DASHBOARD_ALLOWED_NETS (Komma-getrennt, /etc/linux-dashboard/dashboard.env)
    # erweitert die Liste fuer Systeme OHNE Tunnel:
    #   "*"                         = jeder Zugriff erlaubt (nur hinter Firewall!)
    #   "192.168.0.0/16,100.64.0.0/10" = CIDR-Netze
    #   "192.168.,100."             = IP-Praefixe (alte Schreibweise)
    # DASHBOARD_PUBLIC_URL: Adresse, auf die die Sperrseite verweist (optional).

    import ipaddress as _ipa
    _ALLOWED_NETS = ('127.', '::1', '::ffff:127.')
    _EXTRA_PREFIXES = []
    # Docker-Bridges / Tunnel-Container (frueher Praefix '172.', das auch
    # oeffentliche 172.x-Adressen traf)
    _EXTRA_CIDRS = [_ipa.ip_network('10.0.0.0/8'), _ipa.ip_network('172.16.0.0/12')]
    for _entry in os.environ.get("DASHBOARD_ALLOWED_NETS", "").split(","):
        _entry = _entry.strip()
        if not _entry:
            continue
        if "/" in _entry:
            try:
                _EXTRA_CIDRS.append(_ipa.ip_network(_entry, strict=False))
            except ValueError:
                print(f"[dashboard] DASHBOARD_ALLOWED_NETS: ungueltiges Netz {_entry!r}", flush=True)
        else:
            _EXTRA_PREFIXES.append(_entry)
    _ALLOW_ALL = "*" in _EXTRA_PREFIXES
    _PUBLIC_URL = os.environ.get("DASHBOARD_PUBLIC_URL", "").strip()

    def _is_allowed_ip(self) -> bool:
        if self._ALLOW_ALL:
            return True
        ip = self.client_address[0]
        if any(ip.startswith(p) for p in self._ALLOWED_NETS) or \
           any(ip.startswith(p) for p in self._EXTRA_PREFIXES):
            return True
        if self._EXTRA_CIDRS:
            try:
                addr = self._ipa.ip_address(ip)
                if addr.version == 6 and addr.ipv4_mapped:
                    addr = addr.ipv4_mapped
            except ValueError:
                return False
            return any(addr.version == n.version and addr in n for n in self._EXTRA_CIDRS)
        return False

    def _deny_direct_access(self):
        from html import escape as _esc
        if self._PUBLIC_URL.startswith(("http://", "https://")):
            u = _esc(self._PUBLIC_URL, quote=True)
            hint = f"Bitte verwende <a href='{u}' style='color:#3d9bff'>{u}</a>"
        else:
            hint = "Zugriff von dieser Adresse ist nicht freigegeben (DASHBOARD_ALLOWED_NETS)."
        body = (
            "<html><body style='font-family:monospace;background:#06080d;color:#ef4444;"
            "display:flex;align-items:center;justify-content:center;height:100vh;margin:0'>"
            "<div style='text-align:center'>"
            "<div style='font-size:48px;margin-bottom:16px'>&#128274;</div>"
            f"<b>Direktzugriff gesperrt</b><br><br>{hint}</div></body></html>"
        ).encode()
        self.send_response(403)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _cookie_secure(self) -> str:
        """" Secure;" fuer Cookies, wenn der Browser per HTTPS kommt.
        Hinter Tunnel/Reverse-Proxy (Proxy-Header vorhanden) immer, bei direktem
        HTTP-Zugriff (Server ohne Cloudflare/HTTPS) nicht - sonst schickt der
        Browser das Sitzungs-Cookie nie zurueck und der Login scheitert still.
        DASHBOARD_COOKIE_SECURE=1/0 erzwingt bzw. verbietet das Flag."""
        mode = os.environ.get("DASHBOARD_COOKIE_SECURE", "auto").strip().lower()
        if mode in ("1", "true", "yes", "ja"):
            return " Secure;"
        if mode in ("0", "false", "no", "nein"):
            return ""
        h = self.headers
        if (h.get("X-Forwarded-Proto") or "").lower() == "https" or h.get("CF-Connecting-IP") \
           or h.get("X-Real-IP") or h.get("X-Forwarded-For"):
            return " Secure;"
        return ""

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

    def _serve_console(self, console_type: str, session_token: str, share=None):
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
        if share:
            # Gast-Link: Badge mit Restlaufzeit + Sperrbild bei Ablauf
            inject = share_guest_inject(share, console_type)
            body = body.replace(b"</body>", inject + b"</body>", 1) if b"</body>" in body else body + inject
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ── KasmVNC VM proxy (reverse proxy to the per-VM KasmVNC server) ─────────

    def _kasmvnc_vm_proxy(self, token: str, subpath: str, share=None):
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
            _after = f"/share/vm/{share['id']}?closed=1" if share else "/"
            _stop_js = (
                'try{window.close();}catch(x){}'
                'setTimeout(function(){window.location.href=' + json.dumps(_after) + ';},200);'
            )
            inject = presets + _kasm_client_inject(f"/ws/{token}", _stop_js)
            if share:
                # Gast-Link: KasmVNC-Steuerleiste (Verbindungs-/Anzeige-Einstellungen,
                # Trennen) ausblenden + Badge mit Restlaufzeit
                inject += share_guest_inject(share, "kasmvnc")
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

    def _ws_splice(self, backend_port: int, share_id: str = None):
        """Forward the current WebSocket connection to 127.0.0.1:backend_port.

        share_id — bei Gast-Links: beide Sockets werden beim VMShareManager
        registriert, der sie bei Ablauf/Widerruf der Freigabe sofort schließt.
        """
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
        if share_id:
            _share_mgr.register_conn(share_id, self.connection, backend)

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
        if share_id:
            _share_mgr.unregister_conn(share_id, self.connection, backend)

    # ── KasmVNC reverse proxy ─────────────────────────────────────────────────

    def _kasmvnc_http_proxy(self, sid, subpath, query):
        """Reverse-proxy HTTP request to a kasmweb container (HTTPS, self-signed cert)."""
        import ssl as _ssl
        session = _browser_mgr.get_raw(sid)
        if not session:
            self.send_error(404, "Session nicht gefunden")
            return
        if self._browser_denied(session):
            self.send_error(403, "Keine Berechtigung")
            return
        # Eingefrorene Session (Idle-Pause) beim Öffnen wieder auftauen — sie
        # läuft danach exakt im vorherigen Zustand weiter.
        if _browser_mgr.ensure_running(sid):
            time.sleep(0.3)   # kurz warten, bis der HTTPS-Server wieder antwortet
        _browser_mgr.touch(sid, save=True)
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
                # Nicht-numerischer Header darf den Thread nicht abbrechen.
                try:
                    clen = int(self.headers.get("Content-Length", 0) or 0)
                except (TypeError, ValueError):
                    clen = 0
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

            # Inject WebSocket redirect + mobile UX fixes into HTML.
            # Kein ✕-Button in der Session: das Beenden läuft ausschließlich über die
            # Sessionverwaltung im Dashboard (mit Rückfrage) — auf dem Handy lag der
            # Knopf direkt neben der Tastatur und löschte die Session versehentlich.
            if "text/html" in ct and body:
                inject = _kasm_client_inject(f"/kasmvnc-ws/{sid}", "", beacon_sid=sid)
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
        if self._browser_denied(session):
            self.send_error(403, "Keine Berechtigung")
            return
        # Auch hier auftauen: der Client verbindet sich direkt per WebSocket neu,
        # ohne die HTML-Seite erneut zu laden (z. B. nach Reconnect).
        if _browser_mgr.ensure_running(sid):
            time.sleep(0.3)
        _browser_mgr.touch(sid, save=True)
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
        self._static_asset = False
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
            self.send_header("Set-Cookie", f"session=; HttpOnly;{self._cookie_secure()} Path=/; SameSite=Strict; Max-Age=0")
            self.end_headers()
            return

        # Token-Pfade: überspringen die generische Auth hier und prüfen im jeweiligen
        # Handler selbst Session + Token-Owner (siehe /ws/ und /kasmvnc-vm/ unten).
        if path.startswith(("/ws/", "/kasmvnc-vm/", "/share/vm/")):
            pass  # handled later in the elif chain without auth
        # Gast einer öffentlichen VM-Freigabe (Cookie aus /share/vm/<id>): nur die
        # Konsolen-Seiten und deren statische Client-Dateien — sonst nichts. Die
        # Konsolen-Tokens selbst sind zusätzlich an die Freigabe gebunden (/ws/).
        elif path.startswith(("/console/", "/novnc/", "/spice-html5/")) and self._share_from_cookie():
            pass
        # All other paths require authentication
        elif not self._is_authenticated():
            if path.startswith("/api/"):
                self.send_json({"error": "Nicht authentifiziert"}, 401)
            else:
                self._redirect("/login")
            return

        # Rollen-Gates (lesend): Benutzer-/Docker-Verwaltung, Host-Geräteliste und
        # rohes Domain-XML nur für Superadmins; VM-/Netz-/Storage-Lesezugriff
        # (VM-Assistent braucht Netze, Pools, Volumes, ISOs) ab Rolle admin.
        if path.startswith(("/api/user", "/api/docker", "/api/security")) or \
           path in ("/api/vm/hostdevices", "/api/vm/xml", "/api/vm/access"):
            if self._require_superadmin():
                return
        # Lesend/Konsole für eigene UND freigegebene VMs — jede Rolle (auch "user",
        # sofern ein Superadmin ihm eine VM sichtbar gemacht hat).
        _VM_VIEW_GET = ("/api/vm/details", "/api/vm/stats", "/api/vm/console",
                        "/api/vm/snapshots", "/api/vm/devices")
        if path == "/api/vms":
            pass
        elif path in _VM_VIEW_GET:
            if not self._is_superadmin():
                _vmname = parse_qs(parsed.query).get("name", [""])[0]
                if self._vm_denied(_vmname, "view"):
                    return
        elif path.startswith(("/api/vm", "/api/network", "/api/storage")):
            if self._require_admin():
                return
            # Admins: übrige VM-Einzelendpunkte (?name=…) nur für eigene VMs
            if path.startswith("/api/vm/") and not self._is_superadmin():
                _vmname = parse_qs(parsed.query).get("name", [""])[0]
                if self._vm_denied(_vmname):
                    return

        if path == "/api/prefs":
            self.send_json(get_prefs(self._get_session_user()))
            return
        if path == "/api/me":
            token = self._get_session_token()
            _me = _session_mgr.validate(token)
            self.send_json({
                "username": _me,
                "role": self._get_session_role(),
                # Anzahl eigener/freigegebener VMs → Frontend zeigt "user" den VM-Reiter
                "vm_access": len(vm_names_visible_to(_me)) if _me else 0,
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
            if self._require_superadmin(): return
            self.send_json(get_top_processes())
        elif path == "/api/services":
            if self._require_superadmin(): return
            self.send_json(get_services())
        elif path == "/api/users":
            if self._require_superadmin(): return
            self.send_json(list_users())
        elif path == "/api/terminal/info":
            if self._require_superadmin(): return
            self.send_json(get_terminal_info())
        elif path == "/api/security/events":
            if self._require_superadmin(): return
            _q = parse_qs(parsed.query)
            _g = lambda k, d="": _q.get(k, [d])[0]
            self.send_json(security_events(
                q=_g("q")[:200],
                kinds=[k for k in _g("kinds").split(",") if k],
                sources=[k for k in _g("sources").split(",") if k],
                apps=[k for k in _g("apps").split(",") if k],
                sort=_g("sort", "ts"), desc=_g("dir", "desc") != "asc",
                limit=_g("limit", "200"), offset=_g("offset", "0")))
        elif path == "/api/security/ids":
            if self._require_superadmin(): return
            _q = parse_qs(parsed.query)
            self.send_json(ids_live(_q.get("range", ["60"])[0][:5], _q.get("since", ["0"])[0][:20]))
        elif path == "/api/security/bans":
            if self._require_superadmin(): return
            self.send_json(security_bans(client_ip(self)))
        elif path == "/api/notifications":
            if self._require_superadmin(): return
            _q = parse_qs(parsed.query)
            self.send_json(ntfy_messages(since=_q.get("since", ["24h"])[0][:4],
                                         limit=_q.get("limit", ["200"])[0][:4]))
        elif path == "/api/updates":
            if self._require_superadmin(): return
            self.send_json(get_updates())
        elif path == "/api/vms":
            _d = get_vms()
            _u = self._get_session_user()
            if not self._is_superadmin():
                _vis = vm_names_visible_to(_u)
                _d["vms"] = [v for v in _d.get("vms", []) if v.get("name") in _vis]
            for _vm in _d.get("vms", []):
                _vm["access"] = "full" if (self._is_superadmin() or _vm.get("owner") == _u) else "view"
            for _vm in _d.get("vms", []):
                _vm["public_shares"] = _share_mgr.count_active(_vm.get("name", ""))
            self.send_json(_d)
        elif path == "/api/vm/details":
            params = parse_qs(parsed.query)
            name = params.get("name", [""])[0]
            if not name:
                self.send_json({"error": "name parameter erforderlich"}, 400)
                return
            _res = get_vm_full(name)
            if isinstance(_res, dict) and "error" not in _res:
                _res["owner"] = vm_owner_get(name)
                _res["viewers"] = vm_viewers_get(name)
                _res["access"] = self._vm_access_level(name)
            self.send_json(_res)

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

        elif path == "/api/vm/access":
            name = parse_qs(parsed.query).get("name", [""])[0]
            if not name:
                self.send_json({"error": "name parameter erforderlich"}, 400)
                return
            self.send_json({"owner": vm_owner_get(name), "viewers": vm_viewers_get(name)})

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

        elif path == "/api/vm/shares":
            name = parse_qs(parsed.query).get("name", [""])[0]
            if not name:
                self.send_json({"error": "name parameter erforderlich"}, 400)
                return
            proto = self.headers.get("X-Forwarded-Proto", "http")
            host  = self.headers.get("Host", "localhost")
            shares = _share_mgr.list_for_vm(name)
            for _s in shares:
                _s["url"] = f"{proto}://{host}/share/vm/{_s['id']}"
            self.send_json({"shares": shares})

        elif path == "/api/vm/console":
            params = parse_qs(parsed.query)
            name  = params.get("name",  [""])[0]
            dtype = params.get("type",  ["auto"])[0]  # "vnc", "spice", "kasmvnc" or "auto"
            if not name:
                self.send_json({"error": "name parameter erforderlich"}, 400)
                return
            self.send_json(self._console_session(name, dtype, self._get_session_user()))
        # ── Browser sessions ──────────────────────────────────────────────────
        elif path == "/api/browser/list":
            _u = self._get_session_user()
            _admin = self._is_superadmin()
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
            _admin = self._is_superadmin()
            self.send_json({"connections": _ext_mgr.list_all(owner=_u, is_admin=_admin)})

        elif path == "/api/terminal/ws":
            if self._require_superadmin(): return
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
                                is_admin=self._is_superadmin())
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
            _share, _is_share = self._share_for_ws_token(token)
            if _is_share:
                # Gast-Link: kein Login, aber die Freigabe muss noch gelten.
                if not _share:
                    self.send_error(410, "Freigabe abgelaufen")
                    return
                _vmkasm_mgr.ws_delta(port, +1)
                try:
                    self._ws_splice(port, share_id=_share["id"])
                finally:
                    _vmkasm_mgr.ws_delta(port, -1)
                return
            # F2: gültige Session nötig — Token allein reicht nicht mehr.
            if not self._is_authenticated():
                self.send_error(401, "Nicht authentifiziert")
                return
            # F1: Token ist an den Besitzer gebunden (Nicht-Admin nur eigene).
            _owner = _ws_owner_for(token)
            if _owner and not self._is_superadmin() \
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
        elif path in ("/console/vnc", "/console/spice"):
            token = parse_qs(parsed.query).get("session", [""])[0]
            _share, _is_share = self._share_for_ws_token(token)
            if _is_share and not _share:
                self._send_html(share_page(
                    "Freigabe abgelaufen",
                    "Der Zugriff auf diese VM wurde beendet.", icon="&#9203;"), 410)
                return
            self._serve_console(path.rsplit("/", 1)[1], token, share=_share)

        # ── Öffentliche VM-Freigabe (Gast-Link, ohne Login) ──────────────────
        elif path.startswith("/share/vm/"):
            sid = path[len("/share/vm/"):].strip("/").split("/", 1)[0]
            self._serve_share(sid, parse_qs(parsed.query))

        # ── KasmVNC VM viewer ─────────────────────────────────────────────────
        elif path.startswith("/kasmvnc-vm/"):
            # /kasmvnc-vm/{token}/{subpath}
            rest  = path[len("/kasmvnc-vm/"):]
            parts = rest.split("/", 1)
            token   = parts[0]
            subpath = parts[1] if len(parts) > 1 else ""
            _share, _is_share = self._share_for_ws_token(token)
            if _is_share:
                if not _share:
                    self._send_html(share_page(
                        "Freigabe abgelaufen",
                        "Der Zugriff auf diese VM wurde beendet.", icon="&#9203;"), 410)
                    return
                self._kasmvnc_vm_proxy(token, subpath, share=_share)
                return
            if not self._is_authenticated():
                self.send_error(401, "Nicht authentifiziert")
                return
            _owner = _ws_owner_for(token)
            if _owner and not self._is_superadmin() \
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

        # ── Docker-Verwaltung (lesend) ────────────────────────────────────────
        # Admin-Gate greift bereits oben über das Prefix "/api/docker".
        elif path == "/api/docker/containers":
            self.send_json({"containers": docker_containers()})

        elif path == "/api/docker/container":
            cid = parse_qs(parsed.query).get("id", [""])[0]
            if not cid:
                self.send_json({"error": "id parameter erforderlich"}, 400)
                return
            self.send_json(docker_container(cid))

        elif path == "/api/docker/container/inspect":
            cid = parse_qs(parsed.query).get("id", [""])[0]
            if not cid:
                self.send_json({"error": "id parameter erforderlich"}, 400)
                return
            self.send_json(docker_inspect(cid))

        elif path == "/api/docker/container/top":
            params = parse_qs(parsed.query)
            cid = params.get("id", [""])[0]
            if not cid:
                self.send_json({"error": "id parameter erforderlich"}, 400)
                return
            self.send_json(docker_top(cid, params.get("ps_args", ["-ef"])[0]))

        elif path == "/api/docker/container/changes":
            cid = parse_qs(parsed.query).get("id", [""])[0]
            if not cid:
                self.send_json({"error": "id parameter erforderlich"}, 400)
                return
            self.send_json(docker_changes(cid))

        elif path == "/api/docker/container/logs":
            params = parse_qs(parsed.query)
            cid = params.get("id", [""])[0]
            if not cid:
                self.send_json({"error": "id parameter erforderlich"}, 400)
                return
            self.send_json(docker_logs(cid,
                                       tail=params.get("tail", ["200"])[0],
                                       timestamps=params.get("timestamps", ["0"])[0] == "1",
                                       since=params.get("since", ["0"])[0]))

        elif path == "/api/docker/images":
            self.send_json({"images": docker_images()})

        elif path == "/api/docker/image/inspect":
            ref = parse_qs(parsed.query).get("id", [""])[0]
            if not ref:
                self.send_json({"error": "id parameter erforderlich"}, 400)
                return
            self.send_json(docker_image_inspect(ref))

        elif path == "/api/docker/image/history":
            ref = parse_qs(parsed.query).get("id", [""])[0]
            if not ref:
                self.send_json({"error": "id parameter erforderlich"}, 400)
                return
            self.send_json(docker_image_history(ref))

        elif path == "/api/docker/networks":
            self.send_json({"networks": docker_networks()})

        elif path == "/api/docker/network":
            nid = parse_qs(parsed.query).get("id", [""])[0]
            if not nid:
                self.send_json({"error": "id parameter erforderlich"}, 400)
                return
            self.send_json(docker_network(nid))

        elif path == "/api/docker/volumes":
            self.send_json({"volumes": docker_volumes()})

        elif path == "/api/docker/volume":
            name = parse_qs(parsed.query).get("name", [""])[0]
            if not name:
                self.send_json({"error": "name parameter erforderlich"}, 400)
                return
            self.send_json(docker_volume(name))

        elif path == "/api/docker/stacks":
            self.send_json({"stacks": docker_stacks()})

        elif path == "/api/docker/stack/compose":
            proj = parse_qs(parsed.query).get("project", [""])[0]
            if not proj:
                self.send_json({"error": "project parameter erforderlich"}, 400)
                return
            self.send_json(docker_stack_compose(proj))

        elif path == "/api/docker/system":
            self.send_json(docker_system())

        elif path == "/api/docker/df":
            self.send_json(docker_df())

        elif path.startswith("/api/docker/ws/logs/"):
            cid = path[len("/api/docker/ws/logs/"):]
            if self.headers.get("Upgrade", "").lower() != "websocket":
                self.send_json({"error": "WebSocket upgrade required"}, 426)
                return
            det = docker_container(cid)
            if det.get("error"):
                self.send_json({"error": det["error"]}, 404)
                return
            ws_key = self.headers.get("Sec-WebSocket-Key", "")
            self.connection.sendall(_ws_handshake_response(ws_key))
            self.close_connection = True
            params = parse_qs(parsed.query)
            self._handle_docker_logs_ws(cid,
                                        tail=params.get("tail", ["200"])[0],
                                        timestamps=params.get("timestamps", ["0"])[0] == "1")

        elif path.startswith("/api/docker/ws/exec/"):
            cid = path[len("/api/docker/ws/exec/"):]
            if self.headers.get("Upgrade", "").lower() != "websocket":
                self.send_json({"error": "WebSocket upgrade required"}, 426)
                return
            det = docker_container(cid)
            if det.get("error"):
                self.send_json({"error": det["error"]}, 404)
                return
            ws_key = self.headers.get("Sec-WebSocket-Key", "")
            self.connection.sendall(_ws_handshake_response(ws_key))
            self.close_connection = True
            params = parse_qs(parsed.query)
            self._handle_docker_exec_ws(cid,
                                        shell=params.get("shell", ["sh"])[0],
                                        user=params.get("user", [""])[0],
                                        workdir=params.get("cwd", [""])[0])

        elif path == "/api/docker/container/logs/download":
            params = parse_qs(parsed.query)
            cid = params.get("id", [""])[0]
            if not cid:
                self.send_json({"error": "id parameter erforderlich"}, 400)
                return
            self._send_docker_logfile(cid,
                                      tail=params.get("tail", ["5000"])[0],
                                      timestamps=params.get("timestamps", ["1"])[0] == "1")

        elif path == "/api/docker/stats":
            self.send_json(docker_stats())

        elif path == "/api/docker/job":
            jid = parse_qs(parsed.query).get("id", [""])[0]
            if not jid:
                self.send_json({"error": "id parameter erforderlich"}, 400)
                return
            self.send_json(docker_job(jid))

        elif path == "/api/docker/hub/search":
            params = parse_qs(parsed.query)
            q = params.get("q", [""])[0]
            if not q:
                self.send_json({"error": "q parameter erforderlich"}, 400)
                return
            self.send_json(docker_hub_search(q, params.get("page", ["1"])[0]))

        elif path == "/api/docker/hub/tags":
            repo = parse_qs(parsed.query).get("repo", [""])[0]
            if not repo:
                self.send_json({"error": "repo parameter erforderlich"}, 400)
                return
            self.send_json(docker_hub_tags(repo))

        elif path == "/api/docker/prune/dryrun":
            params = parse_qs(parsed.query)
            types = [t for t in params.get("types", [""])[0].split(",") if t]
            if not types:
                self.send_json({"error": "types parameter erforderlich"}, 400)
                return
            self.send_json(docker_prune_dryrun(
                types, images_all=params.get("images_all", ["0"])[0] == "1"))

        elif path == "/api/docker/image/save":
            ref = parse_qs(parsed.query).get("id", [""])[0]
            if not ref:
                self.send_json({"error": "id parameter erforderlich"}, 400)
                return
            self._send_docker_tar(lambda: docker_image_save_open(ref),
                                  f"image-{ref}.tar")

        elif path == "/api/docker/container/archive":
            params = parse_qs(parsed.query)
            cid  = params.get("id", [""])[0]
            cpath = params.get("path", [""])[0]
            if not cid or not cpath:
                self.send_json({"error": "id und path erforderlich"}, 400)
                return
            self._send_docker_tar(lambda: docker_archive_open(cid, cpath),
                                  f"{cid}-{cpath.rstrip('/').split('/')[-1] or 'root'}.tar")

        elif path == "/api/docker/jobs":
            self.send_json({"jobs": docker_jobs()})

        elif path == "/api/docker/events":
            self.send_json(docker_events(parse_qs(parsed.query).get("since", ["0"])[0]))

        elif path in ("/", "/index.html"):
            # index.html mit Cache-Busting ausliefern: app.js/app.css bekommen
            # ?v=<mtime>. Clients, die app.js noch mit alten (Cache-Control-losen)
            # Headern gespeichert hatten, fragten es nach Deploys gar nicht mehr an
            # und liefen mit veraltetem Frontend (z. B. unbekannte Rolle
            # "superadmin" → alle Admin-Reiter versteckt). Eine neue URL umgeht
            # jeden Browser-/WebView-Cache zuverlässig.
            try:
                html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
                for asset in ("app.js", "app.css"):
                    try:
                        ver = int((STATIC_DIR / asset).stat().st_mtime)
                    except OSError:
                        ver = 0
                    html = html.replace(f'"/{asset}"', f'"/{asset}?v={ver}"')
                body = html.encode("utf-8")
            except OSError:
                self.send_json({"error": "index.html nicht gefunden"}, 404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.end_headers()
            self.wfile.write(body)

        else:
            self._static_asset = True
            super().do_GET()

    # ── POST ─────────────────────────────────────────────────────────────────

    def do_POST(self):
        if not self._is_allowed_ip():
            self._deny_direct_access()
            return

        parsed = urlparse(self.path)
        path = parsed.path

        # Ein nicht-numerischer Content-Length ("abc", "1e6") warf bisher eine
        # ValueError, die den Thread ohne HTTP-Antwort beendete.
        try:
            content_len = int(self.headers.get("Content-Length", 0) or 0)
        except (TypeError, ValueError):
            self.send_json({"error": "Ungültiger Content-Length-Header"}, 400)
            return
        if content_len < 0:
            self.send_json({"error": "Ungültiger Content-Length-Header"}, 400)
            return
        if content_len > 10 * 1024 * 1024:   # 10 MB Obergrenze gegen Speicher-DoS
            self.send_json({"error": "Request-Body zu groß"}, 413)
            return
        raw_body = self.rfile.read(content_len) if content_len > 0 else b""

        # Login form (no auth needed)
        if path == "/login":
            # Echte Besucher-IP statt der Proxy-Adresse: hinter dem Cloudflare
            # Tunnel ist client_address immer der cloudflared-Container. Der
            # Ratelimiter zaehlte dadurch alle Besucher gemeinsam, und fail2ban
            # haette nichts Sperrbares im Protokoll gefunden.
            peer_ip = client_ip(self)
            params = parse_qs(raw_body.decode("utf-8", errors="replace"))
            username = params.get("username", [""])[0].strip()
            password = params.get("password", [""])[0]

            if _login_rate_limited(peer_ip):
                log_auth_event("AUTHFAIL", username, peer_ip, "ratelimit")
                self._serve_login("Zu viele Login-Versuche — bitte kurz warten.")
                return

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
                log_auth_event("AUTHFAIL", username, peer_ip, "badcreds")
                self._serve_login("Ungültiger Benutzername oder Passwort")
                return

            log_auth_event("AUTHOK", username, peer_ip, "login")
            role = resolve_role(username)
            token = _session_mgr.create(username, role)
            self.send_response(302)
            self.send_header("Location", "/")
            self.send_header(
                "Set-Cookie",
                f"session={token}; HttpOnly;{self._cookie_secure()} Path=/; SameSite=Strict"
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
                             "/api/service/", "/api/process/", "/api/user/",
                             "/api/docker/")) and path != "/api/vm/action":
            if self._require_admin():
                return
        # Rollenmodell: Host-Verwaltung (Netze, Storage, Dienste, Prozesse,
        # Benutzer, Docker) und rohes VM-XML nur für Superadmins. Ausnahme:
        # Volumes anlegen/löschen dürfen Admins für eigene VMs (Prefix-Regel,
        # geprüft unten nach dem JSON-Parsing).
        if path.startswith(("/api/network/", "/api/service/", "/api/process/",
                             "/api/user/", "/api/docker/", "/api/security/")) \
           or path in ("/api/vm/xml", "/api/vm/access", "/api/browser/access") \
           or (path.startswith("/api/storage/")
               and path not in ("/api/storage/volume/create", "/api/storage/volume/delete")):
            if self._require_superadmin():
                return

        # Sensible, nicht gepollte Aktion: Benutzerverwaltung zusätzlich pro IP
        # drosseln (Missbrauch/Automatisierung). Großzügiges Limit, normaler
        # Admin-Betrieb wird nie gebremst.
        if path.startswith("/api/user/"):
            if _action_rate_limited("user", self.client_address[0]):
                self.send_json({"error": "Zu viele Aktionen — bitte kurz warten."}, 429)
                return

        # Docker-Aktionen ebenso drosseln. Etwas großzügiger als bei Benutzern,
        # weil der Erstellungsassistent und Stack-Aktionen mehrere Aufrufe kurz
        # hintereinander auslösen. Gelesen wird ausschließlich per GET, die
        # Drossel bremst also keine Aktualisierung.
        if path.startswith("/api/docker/"):
            if _action_rate_limited("docker", self.client_address[0], max_hits=60):
                self.send_json({"error": "Zu viele Aktionen — bitte kurz warten."}, 429)
                return

        try:
            data = json.loads(raw_body) if raw_body else {}
        except Exception:
            data = {}

        # Admins (nicht Superadmins): nur eigene VMs, keine Host-Durchreichung
        # (USB/PCI/virtiofs/beliebige Image-Pfade) und nur eigene Volumes.
        if not self._is_superadmin():
            if path == "/api/vm/action":
                # Power-Aktionen auch für freigegebene Benutzer (Rolle egal)
                if self._vm_denied(data.get("name", ""), "view"):
                    return
            elif path.startswith("/api/vm/") and path != "/api/vm/create":
                _vmname = data.get("name", "")
                if path in ("/api/vm/share/revoke", "/api/vm/share/extend"):
                    _sh = _share_mgr.get_valid(data.get("id", ""))
                    _vmname = _sh.get("vm", "") if _sh else ""
                if self._vm_denied(_vmname):
                    return
            if path == "/api/vm/device/add" and \
               data.get("kind") in ("usb_host", "pci_host", "filesystem", "disk"):
                self.send_json({"error": "Host-Geräte/Ordner/Image-Pfade dürfen nur "
                                         "Superadmins durchreichen"}, 403)
                return
            if path == "/api/vm/disk/attach" and data.get("device", "disk") != "cdrom" \
               and not self._admin_owns_path(data.get("source_path", "")):
                self.send_json({"error": "Nur eigene Volumes erlaubt (Dateiname muss mit "
                                         "dem Namen einer eigenen VM beginnen)"}, 403)
                return
            if path in ("/api/storage/volume/create", "/api/storage/volume/delete") \
               and not self._admin_owns_path(data.get("vol_name", "")):
                self.send_json({"error": "Volume-Name muss mit dem Namen einer eigenen VM "
                                         "beginnen (z. B. meinevm-data)"}, 403)
                return

        if path == "/api/terminal":
            if self._require_superadmin(): return
            cmd = data.get("command", "")
            timeout = min(data.get("timeout", 30), 120)
            if not cmd:
                self.send_json({"success": False, "returncode": 1, "stdout": "", "stderr": "Kein Befehl angegeben"}, 400)
            else:
                self.send_json(_pty_session.execute(cmd, timeout))

        elif path == "/api/terminal/stdin":
            if self._require_superadmin(): return
            reply   = data.get("reply", "")
            timeout = min(data.get("timeout", 30), 120)
            self.send_json(_pty_session.send_reply(reply, timeout))

        elif path == "/api/terminal/interrupt":
            if self._require_superadmin(): return
            _pty_session.interrupt()
            self.send_json({"ok": True})

        elif path == "/api/update":
            if self._require_superadmin(): return
            self.send_json(run_update())

        # ── External connections ──────────────────────────────────────────────
        elif path == "/api/prefs":
            def _check_key(text, pp):
                return load_pkey(text, pp)[1]
            self.send_json(set_prefs(self._get_session_user(), data, validate_key=_check_key))

        elif path == "/api/ext/save":
            proto    = data.get("proto", "").lower().strip()
            host     = data.get("host", "").strip()
            port     = data.get("port")
            username = data.get("username", "").strip()
            password = data.get("password", "")
            label    = data.get("label", "").strip()
            private_key = (data.get("private_key") or "").strip()
            passphrase  = data.get("passphrase") or ""
            use_default = bool(data.get("use_default"))
            if private_key:
                if len(private_key) > 16384:
                    self.send_json({"error": "Schlüssel zu lang"}, 400)
                    return
                _err = load_pkey(private_key, passphrase or None)[1]
                if _err:
                    self.send_json({"error": _err}, 400)
                    return
                private_key += "\n"
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
                                owner=self._get_session_user(), private_key=private_key,
                                passphrase=passphrase, use_default=use_default)
            self.send_json({"id": cid, "success": True})

        elif path == "/api/ext/delete":
            cid = data.get("id", "")
            if not cid:
                self.send_json({"error": "id erforderlich"}, 400)
                return
            try:
                _ext_mgr.delete(cid, owner=self._get_session_user(),
                                is_admin=self._is_superadmin())
                self.send_json({"success": True})
            except PermissionError:
                self.send_json({"error": "Keine Berechtigung"}, 403)

        elif path == "/api/ext/connect":
            _u = self._get_session_user()
            _admin = self._is_superadmin()
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
                                  is_admin=self._is_superadmin())
                self.send_json({"success": True})
            except PermissionError:
                self.send_json({"error": "Keine Berechtigung"}, 403)

        # Heartbeat des KasmVNC-Clients: solange der Tab sichtbar ist, meldet er
        # sich im Minutentakt. Bleibt er aus (Tab geschlossen oder im
        # Hintergrund), pausiert der Idle-Wächter die Session. Kehrt der Nutzer
        # zurück, taut derselbe Aufruf sie sofort wieder auf.
        elif path == "/api/browser/ping":
            sid = data.get("id", "")
            session = _browser_mgr.get(sid, owner=self._get_session_user(),
                                       is_admin=self._is_superadmin())
            if not session:
                self.send_json({"error": "Session nicht gefunden"}, 404)
                return
            resumed = _browser_mgr.ensure_running(sid)
            _browser_mgr.touch(sid)
            self.send_json({"ok": True, "resumed": resumed})

        elif path in ("/api/browser/pause", "/api/browser/resume"):
            sid = data.get("id", "")
            if not sid:
                self.send_json({"error": "id erforderlich"}, 400)
                return
            want_pause = path.endswith("/pause")
            try:
                if want_pause:
                    ok = _browser_mgr.pause(sid, owner=self._get_session_user(),
                                            is_admin=self._is_superadmin())
                else:
                    ok = _browser_mgr.resume(sid, owner=self._get_session_user(),
                                             is_admin=self._is_superadmin())
            except PermissionError:
                self.send_json({"error": "Keine Berechtigung"}, 403)
                return
            if not ok:
                self.send_json({"error": "Container reagiert nicht auf "
                                         + ("Pause" if want_pause else "Fortsetzen")}, 502)
                return
            self.send_json({"success": True,
                            "status": "paused" if want_pause else "running"})

        elif path == "/api/vm/access":
            # Superadmin: Besitzer und Sichtbarkeitsliste einer VM setzen
            name = data.get("name", "")
            if not name:
                self.send_json({"error": "name erforderlich"}, 400)
                return
            _ure = re.compile(r'^[a-z_][a-z0-9_-]{0,31}$')
            viewers = data.get("viewers")
            if viewers is not None:
                if not isinstance(viewers, list) or not all(isinstance(u, str) and _ure.match(u) for u in viewers):
                    self.send_json({"error": "viewers muss eine Liste gültiger Benutzernamen sein"}, 400)
                    return
            if "owner" in data:
                owner = (data.get("owner") or "").strip()
                if owner and not _ure.match(owner):
                    self.send_json({"error": "Ungültiger Besitzer"}, 400)
                    return
                vm_owner_set(name, owner or None)
            cur_owner = vm_owner_get(name)
            if viewers is not None:
                vm_viewers_set(name, [u for u in viewers if u != cur_owner])
            self.send_json({"success": True, "owner": cur_owner, "viewers": vm_viewers_get(name)})

        elif path == "/api/browser/access":
            # Superadmin: Sichtbarkeitsliste einer Browser-Session setzen
            sid = data.get("id", "")
            viewers = data.get("viewers")
            _ure = re.compile(r'^[a-z_][a-z0-9_-]{0,31}$')
            if not sid or not isinstance(viewers, list) or \
               not all(isinstance(u, str) and _ure.match(u) for u in viewers):
                self.send_json({"error": "id und viewers (Liste gültiger Benutzernamen) erforderlich"}, 400)
                return
            sess = _browser_mgr.set_viewers(sid, viewers)
            if not sess:
                self.send_json({"error": "Session nicht gefunden"}, 404)
                return
            self.send_json({"success": True, "viewers": sess.get("viewers", [])})

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
                res = vm_create(name, vcpus, memory_mib, pool,
                                disk_size_gib, iso_path, network, machine,
                                os_type=os_type, virtio_iso=virtio_iso)
                if res.get("success"):
                    vm_owner_set(name, self._get_session_user())
                self.send_json(res)

        elif path == "/api/vm/delete":
            name = data.get("name", "")
            if not name:
                self.send_json({"error": "name erforderlich"}, 400)
            else:
                _r = vm_delete(name, data.get("delete_volumes", False))
                if _r.get("success"):
                    _share_mgr.revoke_vm(name)
                    vm_owner_remove(name)
                    vm_viewers_remove(name)
                self.send_json(_r)

        elif path == "/api/vm/share/create":
            name = data.get("name", "")
            if not name:
                self.send_json({"error": "name erforderlich"}, 400)
                return
            _r = _share_mgr.create(name, self._get_session_user(), data.get("minutes"),
                                   data.get("type", "kasmvnc"), data.get("note", ""))
            if _r.get("share"):
                proto = self.headers.get("X-Forwarded-Proto", "http")
                host  = self.headers.get("Host", "localhost")
                _r["share"]["url"] = f"{proto}://{host}/share/vm/{_r['share']['id']}"
                print(f"[vmshare] {self._get_session_user()} hat VM {name} für "
                      f"{_r['share']['minutes']} min freigegeben ({_r['share']['type']})", flush=True)
            self.send_json(_r)

        elif path == "/api/vm/share/revoke":
            _r = _share_mgr.revoke(data.get("id", ""))
            if _r.get("success"):
                print(f"[vmshare] Freigabe widerrufen durch {self._get_session_user()}", flush=True)
            self.send_json(_r)

        elif path == "/api/vm/share/extend":
            _r = _share_mgr.extend(data.get("id", ""), data.get("minutes"))
            if _r.get("share"):
                proto = self.headers.get("X-Forwarded-Proto", "http")
                host  = self.headers.get("Host", "localhost")
                _r["share"]["url"] = f"{proto}://{host}/share/vm/{_r['share']['id']}"
            self.send_json(_r)

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
                res = vm_clone(src, dst)
                if res.get("success"):
                    vm_owner_set(dst, self._get_session_user())
                self.send_json(res)

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
            invalidate_role_cache(data.get("username", ""))
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
                r = update_user(uname, password=data.get("password"),
                                is_admin=is_admin)
                # Admin-Recht sofort wirksam machen (sonst bis zu _ROLE_TTL alt)
                invalidate_role_cache(uname)
                self.send_json(r)

        elif path == "/api/user/delete":
            uname = data.get("username", "")
            if uname == self._get_session_user():
                self.send_json({"error": "Sie können sich nicht selbst löschen"}, 400)
            else:
                r = delete_user(uname, remove_home=bool(data.get("remove_home", True)))
                invalidate_role_cache(uname)
                self.send_json(r)

        elif path == "/api/security/ban":
            if self._require_superadmin(): return
            if _action_rate_limited("security", client_ip(self), max_hits=20):
                self.send_json({"success": False, "error": "Zu viele Aktionen — bitte kurz warten."}, 429)
                return
            self.send_json(security_ban(data.get("ip", ""), self._get_session_user(), client_ip(self)))

        elif path == "/api/security/unban":
            if self._require_superadmin(): return
            if _action_rate_limited("security", client_ip(self), max_hits=20):
                self.send_json({"success": False, "error": "Zu viele Aktionen — bitte kurz warten."}, 429)
                return
            self.send_json(security_unban(data.get("ip", ""), self._get_session_user()))

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

        # ── Docker-Verwaltung (schreibend) ────────────────────────────────────
        # Admin-Gate und Drossel greifen bereits oben über das Prefix.
        elif path == "/api/docker/container/action":
            cid    = data.get("id", "")
            action = data.get("action", "")
            if not cid or not action:
                self.send_json({"error": "id und action erforderlich"}, 400)
            else:
                self._dk_send(docker_container_action(
                    cid, action,
                    signal=data.get("signal", ""),
                    timeout=data.get("timeout", 10)))

        elif path == "/api/docker/container/create":
            image = data.get("image", "")
            if not image:
                self.send_json({"error": "image erforderlich"}, 400)
            else:
                self.send_json(docker_container_create(
                    image, name=data.get("name", ""), cmd=data.get("cmd", ""),
                    entrypoint=data.get("entrypoint", ""),
                    ports=data.get("ports") or [], volumes=data.get("volumes") or [],
                    env=data.get("env") or [], labels=data.get("labels") or [],
                    network=data.get("network", ""),
                    restart=data.get("restart", "no"),
                    memory_mb=data.get("memory_mb"), cpus=data.get("cpus"),
                    user=data.get("user", ""), workdir=data.get("workdir", ""),
                    privileged=bool(data.get("privileged", False)),
                    tty=bool(data.get("tty", False)),
                    cap_add=data.get("cap_add") or [],
                    start=bool(data.get("start", True))))

        elif path == "/api/docker/container/remove":
            cid = data.get("id", "")
            if not cid:
                self.send_json({"error": "id erforderlich"}, 400)
            else:
                self._dk_send(docker_container_remove(
                    cid,
                    force=bool(data.get("force", False)),
                    volumes=bool(data.get("volumes", False))))

        elif path == "/api/docker/container/rename":
            cid  = data.get("id", "")
            name = data.get("name", "")
            if not cid or not name:
                self.send_json({"error": "id und name erforderlich"}, 400)
            else:
                self._dk_send(docker_container_rename(cid, name))

        elif path == "/api/docker/container/update":
            cid = data.get("id", "")
            if not cid:
                self.send_json({"error": "id erforderlich"}, 400)
            else:
                self._dk_send(docker_container_update(
                    cid,
                    policy=data.get("policy"),
                    max_retry=data.get("max_retry", 0),
                    memory_mb=data.get("memory_mb"),
                    memory_swap_mb=data.get("memory_swap_mb"),
                    cpus=data.get("cpus"),
                    cpu_shares=data.get("cpu_shares"),
                    cpuset=data.get("cpuset")))

        elif path == "/api/docker/image/pull":
            repo = data.get("repo", "")
            if not repo:
                self.send_json({"error": "repo erforderlich"}, 400)
            else:
                self.send_json(docker_image_pull(repo, data.get("tag", "latest")))

        elif path == "/api/docker/image/build":
            ctx = data.get("context", "")
            tag = data.get("tag", "")
            if not ctx or not tag:
                self.send_json({"error": "context und tag erforderlich"}, 400)
            else:
                self.send_json(docker_image_build(
                    ctx, tag,
                    dockerfile=data.get("dockerfile", "Dockerfile"),
                    nocache=bool(data.get("nocache", False)),
                    buildargs=data.get("buildargs") or {}))

        elif path == "/api/docker/image/remove":
            ref = data.get("id", "")
            if not ref:
                self.send_json({"error": "id erforderlich"}, 400)
            else:
                self.send_json(docker_image_remove(
                    ref, force=bool(data.get("force", False)),
                    noprune=bool(data.get("noprune", False))))

        elif path == "/api/docker/image/tag":
            ref  = data.get("id", "")
            repo = data.get("repo", "")
            if not ref or not repo:
                self.send_json({"error": "id und repo erforderlich"}, 400)
            else:
                self.send_json(docker_image_tag(ref, repo, data.get("tag", "latest")))

        elif path == "/api/docker/network/create":
            name = data.get("name", "")
            if not name:
                self.send_json({"error": "name erforderlich"}, 400)
            else:
                self.send_json(docker_network_create(
                    name, driver=data.get("driver", "bridge"),
                    subnet=data.get("subnet", ""), gateway=data.get("gateway", ""),
                    ip_range=data.get("ip_range", ""),
                    internal=bool(data.get("internal", False)),
                    ipv6=bool(data.get("ipv6", False)),
                    parent=data.get("parent", ""),
                    options=data.get("options") or {},
                    labels=data.get("labels") or {}))

        elif path == "/api/docker/network/remove":
            nid = data.get("id", "")
            if not nid:
                self.send_json({"error": "id erforderlich"}, 400)
            else:
                self.send_json(docker_network_remove(nid))

        elif path == "/api/docker/network/connect":
            nid = data.get("id", "")
            ctr = data.get("container", "")
            if not nid or not ctr:
                self.send_json({"error": "id und container erforderlich"}, 400)
            else:
                self._dk_send(docker_network_connect(
                    nid, ctr, ipv4=data.get("ipv4", ""), ipv6=data.get("ipv6", ""),
                    aliases=data.get("aliases") or []))

        elif path == "/api/docker/network/disconnect":
            nid = data.get("id", "")
            ctr = data.get("container", "")
            if not nid or not ctr:
                self.send_json({"error": "id und container erforderlich"}, 400)
            else:
                self._dk_send(docker_network_disconnect(
                    nid, ctr, force=bool(data.get("force", False))))

        elif path == "/api/docker/volume/create":
            name = data.get("name", "")
            if not name:
                self.send_json({"error": "name erforderlich"}, 400)
            else:
                self.send_json(docker_volume_create(
                    name, driver=data.get("driver", "local"),
                    options=data.get("options") or {},
                    labels=data.get("labels") or {}))

        elif path == "/api/docker/volume/remove":
            name = data.get("name", "")
            if not name:
                self.send_json({"error": "name erforderlich"}, 400)
            else:
                self.send_json(docker_volume_remove(
                    name, force=bool(data.get("force", False))))

        elif path == "/api/docker/prune":
            types = data.get("types") or []
            if not types:
                self.send_json({"error": "types erforderlich"}, 400)
            else:
                self.send_json(docker_prune(
                    types, images_all=bool(data.get("images_all", False))))

        elif path == "/api/docker/container/commit":
            cid  = data.get("id", "")
            repo = data.get("repo", "")
            if not cid or not repo:
                self.send_json({"error": "id und repo erforderlich"}, 400)
            else:
                self.send_json(docker_container_commit(
                    cid, repo, tag=data.get("tag", "latest"),
                    message=data.get("message", ""), author=data.get("author", ""),
                    pause=bool(data.get("pause", True))))

        elif path == "/api/docker/container/upload":
            cid = data.get("id", "")
            if not cid:
                self.send_json({"error": "id erforderlich"}, 400)
            else:
                self._dk_send(docker_archive_put(
                    cid, data.get("path", ""), data.get("name", ""),
                    data.get("data_b64", "")))

        elif path == "/api/docker/stack/action":
            proj   = data.get("project", "")
            action = data.get("action", "")
            if not proj or not action:
                self.send_json({"error": "project und action erforderlich"}, 400)
            else:
                self.send_json(docker_stack_action(proj, action))

        else:
            self.send_json({"error": "Not found"}, 404)

    def _handle_docker_logs_ws(self, cid, tail=200, timestamps=False):
        """Container-Logs über einen bereits aufgerüsteten WebSocket folgen.

        Aufbau wie `_handle_ssh_ws`: ein Lese-Thread schiebt die Docker-Frames
        als Binärframes zum Browser, die Hauptschleife wartet auf das
        Close-Frame. Ein in `resp.read()` geparkter Leser wird über
        `_docker_stream_close` (socket shutdown) geweckt — ohne das bliebe der
        Thread bis zum TCP-Timeout hängen."""
        sock = self.connection
        sock.settimeout(None)

        if not _ws_slot_take("log"):
            _ws_send(sock, "\r\nZu viele offene Log-Ansichten — bitte eine andere "
                           "schließen.\r\n", opcode=0x01)
            return

        conn = None
        try:
            conn, resp = docker_logs_open(cid, tail=tail, timestamps=timestamps,
                                          follow=True)
        except Exception as e:
            _ws_send(sock, f"\r\nFehler: {e}\r\n", opcode=0x01)
            _ws_slot_free("log")
            return

        alive = threading.Event()
        alive.set()

        def docker_to_ws():
            try:
                for _sid, payload in _docker_frames(resp):
                    if not alive.is_set():
                        break
                    if not _ws_send(sock, payload, opcode=0x02):
                        break
            except Exception:
                pass
            finally:
                alive.clear()
                try:
                    _ws_send(sock, b"", opcode=0x08)
                except Exception:
                    pass

        reader = threading.Thread(target=docker_to_ws, daemon=True)
        reader.start()

        try:
            while alive.is_set():
                opcode, data = _ws_recv(sock)
                if opcode is None or opcode == 0x08:
                    break
                # Textframes sind für spätere Steuerbefehle reserviert; der
                # Client baut für Tail-/Timestamp-Wechsel neu auf.
        except Exception:
            pass
        finally:
            alive.clear()
            _docker_stream_close(conn)
            reader.join(timeout=2)
            _ws_slot_free("log")

    def _handle_docker_exec_ws(self, cid, shell="sh", user="", workdir=""):
        """Interaktive Container-Shell über einen aufgerüsteten WebSocket.

        Gleiches Protokoll wie das Host-Terminal (`_handle_local_pty_ws`):
        Binärframes tragen rohe Terminal-Bytes, ein Textframe mit
        {"type":"resize"} zieht die Fenstergröße nach."""
        sock = self.connection
        sock.settimeout(None)

        if not _ws_slot_take("exec"):
            _ws_send(sock, "\r\nZu viele offene Konsolen — bitte eine andere "
                           "schließen.\r\n", opcode=0x02)
            return

        try:
            eid, dsock, leftover = docker_exec_open(cid, shell=shell, user=user,
                                                    workdir=workdir)
        except Exception as e:
            _ws_send(sock, f"\r\nFehler: {e}\r\n".encode(), opcode=0x02)
            _ws_slot_free("exec")
            return

        # Beim Hijack können bereits Nutzdaten hinter den Headern liegen —
        # ohne diese Zeile fehlte die erste Ausgabe der Shell.
        # Scheitert der Start (fehlende Shell, falsches Verzeichnis), steht die
        # englische OCI-Meldung genau hier — die wird übersetzt.
        _erste_daten = [True]
        if leftover:
            de = docker_exec_message_de(leftover, shell, workdir, user)
            _ws_send(sock, de or leftover, opcode=0x02)
            if de:
                _erste_daten[0] = False

        alive = threading.Event()
        alive.set()

        def docker_to_ws():
            while alive.is_set():
                try:
                    r, _, _ = select.select([dsock], [], [], 0.04)
                    if r:
                        data = dsock.recv(8192)
                        if not data:
                            break
                        if _erste_daten[0]:
                            _erste_daten[0] = False
                            de = docker_exec_message_de(data, shell, workdir, user)
                            if de:
                                data = de
                        if not _ws_send(sock, data, opcode=0x02):
                            break
                except (OSError, ValueError):
                    break
                except Exception:
                    break
            alive.clear()
            try:
                _ws_send(sock, b"", opcode=0x08)
            except Exception:
                pass

        reader = threading.Thread(target=docker_to_ws, daemon=True)
        reader.start()

        try:
            while alive.is_set():
                opcode, data = _ws_recv(sock)
                if opcode is None or opcode == 0x08:
                    break
                if opcode == 0x01 and data:          # Steuerframe (JSON)
                    try:
                        msg = json.loads(data.decode("utf-8", errors="replace"))
                        if msg.get("type") == "resize":
                            docker_exec_resize(eid, msg.get("rows", 24),
                                               msg.get("cols", 80))
                    except Exception:
                        pass
                elif opcode == 0x02 and data:        # rohe Tastatureingabe
                    try:
                        dsock.sendall(data)
                    except OSError:
                        break
        except Exception:
            pass
        finally:
            alive.clear()
            try:
                dsock.shutdown(socket.SHUT_RDWR)
            except Exception:
                pass
            try:
                dsock.close()
            except Exception:
                pass
            reader.join(timeout=2)
            # Docker lässt die Shell im Zielcontainer weiterlaufen, wenn die
            # Verbindung abreißt. Ohne dieses Aufräumen bliebe bei jedem
            # Tab-Wechsel eine Shell in einem produktiven Container zurück.
            try:
                docker_exec_cleanup(eid)
            except Exception:
                pass
            _ws_slot_free("exec")

    def _send_docker_tar(self, opener, filename):
        """Einen Tar-Strom von Docker an den Browser durchreichen.

        Bewusst gestreamt statt komplett gepuffert: ein Image-Export kann
        mehrere Hundert MB groß sein."""
        conn = None
        try:
            conn, resp = opener()
        except Exception as e:
            self.send_json({"error": str(e)}, 404)
            return
        safe = re.sub(r'[^A-Za-z0-9_.-]', '_', str(filename))[:96] or "export.tar"
        try:
            self.send_response(200)
            self.send_header("Content-Type", "application/x-tar")
            self.send_header("Content-Disposition", f'attachment; filename="{safe}"')
            clen = resp.getheader("Content-Length")
            if clen:
                self.send_header("Content-Length", clen)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except Exception:
            self.close_connection = True
        finally:
            if conn is not None:
                _docker_stream_close(conn)

    def _send_docker_logfile(self, cid, tail=5000, timestamps=True):
        """Logs als Textdatei zum Herunterladen ausliefern."""
        conn = None
        try:
            conn, resp = docker_logs_open(cid, tail=tail, timestamps=timestamps,
                                          follow=False)
        except Exception as e:
            self.send_json({"error": str(e)}, 404)
            return
        try:
            parts, total = [], 0
            for _sid, payload in _docker_frames(resp):
                parts.append(payload)
                total += len(payload)
                if total > 16 * 1024 * 1024:
                    parts.append(b"\n[... gekuerzt bei 16 MB ...]\n")
                    break
            body = b"".join(parts)
            safe = re.sub(r'[^A-Za-z0-9_.-]', '_', str(cid))[:64]
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Disposition",
                             f'attachment; filename="docker-{safe}.log"')
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except Exception:
            pass
        finally:
            if conn is not None:
                _docker_stream_close(conn)

    def _dk_send(self, result):
        """Docker-Antwort senden. Der Selbstschutz (`protected`) geht als 403
        raus, alles andere folgt der Hauskonvention: HTTP 200 + `.error`."""
        self.send_json(result, 403 if isinstance(result, dict)
                               and result.get("protected") else 200)

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

        # Fenstergröße des Browsers abwarten, BEVOR bash startet: sonst zeichnet
        # die Shell ihre erste Ausgabe (Prompt, Motd) in 80x24 und alles, was
        # schon gedruckt ist, bleibt falsch umbrochen stehen.
        cols, rows = 80, 24
        pending_input = b""
        try:
            ready, _, _ = select.select([sock], [], [], 1.5)
            if ready:
                op, first = _ws_recv(sock)
                if op == 0x01 and first:
                    try:
                        msg = json.loads(first.decode('utf-8', errors='replace'))
                        if msg.get('type') == 'resize':
                            cols = max(10, min(500, int(msg.get('cols', 80))))
                            rows = max(2,  min(200, int(msg.get('rows', 24))))
                    except Exception:
                        pass
                elif op == 0x02 and first:
                    pending_input = first
                elif op is None or op == 0x08:
                    try: os.close(master); os.close(slave)
                    except OSError: pass
                    return
        except Exception:
            pass

        try:
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        except OSError:
            pass

        env = dict(os.environ)
        env['TERM']      = 'xterm-256color'
        env['COLORTERM'] = 'truecolor'
        env['SHELL']     = '/bin/bash'
        env['HOME']      = '/root'
        env['USER']      = 'root'
        env['LOGNAME']   = 'root'
        env['PWD']       = '/root'
        # Ohne UTF-8-Locale liefern ls/ncurses ASCII-Ersatzzeichen statt Rahmen
        # und Umlauten. en_US.UTF-8 ist NICHT überall erzeugt, C.UTF-8 schon —
        # eine vorhandene UTF-8-Einstellung bleibt unangetastet.
        if 'UTF-8' not in env.get('LANG', '').upper().replace('UTF8', 'UTF-8'):
            env['LANG'] = 'C.UTF-8'
        env.pop('LC_ALL', None)
        for _v in ('PYTHONPATH', 'PYTHONUNBUFFERED', 'PYTHON_VERSION', 'GPG_KEY', 'DASH_PORT'):
            env.pop(_v, None)

        def _child_setup():
            os.setsid()
            # Make the slave PTY the controlling terminal of the new session so that
            # VINTR (Ctrl+C / 0x03) on the master is converted to SIGINT by the kernel
            # and delivered to the foreground process group (e.g. top, vim, nano).
            try:
                fcntl.ioctl(0, termios.TIOCSCTTY, 0)
            except OSError:
                pass

        # `env --chdir` wechselt das Verzeichnis ERST, nachdem nsenter den
        # Namensraum gewechselt hat. Ohne das erbt bash das Container-Verzeichnis
        # (/app), das im Host-Namensraum nicht existiert — die Sitzung begrüßt
        # den Benutzer dann mit »getcwd() failed« und `pwd`, Tab-Vervollständigung
        # sowie relative Pfade schlagen fehl. (nsenter --wd=… hilft nicht: es
        # wechselt VOR dem Namensraum-Wechsel.)
        proc = None
        candidates = [
            _ns(['env', '--chdir=/root', 'bash', '-i']),
            _ns(['bash', '-i']),
            ['bash', '-i'],
        ]
        for cmd in candidates:
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

        if pending_input:
            try: os.write(master, pending_input)
            except OSError: pass

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
            # Die ganze Sitzung (bash + alles, was es gestartet hat) beenden —
            # `terminate()` allein lässt Kindprozesse wie top/tail als Waisen zurück.
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGHUP)
            except Exception:
                try: proc.terminate()
                except Exception: pass
            try: proc.wait(timeout=2)
            except Exception:
                try: os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
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

        username = conn.get("username") or ""
        password = conn.get("_password") or ""
        key_text = conn.get("_private_key") or ""
        key_pass = conn.get("_passphrase") or ""
        if conn.get("use_default"):
            d = ssh_default_secret(conn.get("owner", ""))
            username = username or d.get("username", "")
            password = password or d.get("password", "")
            if not key_text:
                key_text, key_pass = d.get("private_key", ""), d.get("passphrase", "")
        pkey = None
        if key_text:
            pkey, _kerr = load_pkey(key_text, key_pass or None)
            if _kerr:
                _ws_send(sock, f"\r\nSSH Fehler: {_kerr}\r\n".encode())
                return
        if not username:
            _ws_send(sock, b"\r\nSSH Fehler: kein Benutzername (Verbindung oder Standard-Zugangsdaten)\r\n")
            return
        try:
            ssh = paramiko.SSHClient()
            ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            ssh.connect(
                conn["host"], port=conn["port"],
                username=username, password=password or None, pkey=pkey,
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


