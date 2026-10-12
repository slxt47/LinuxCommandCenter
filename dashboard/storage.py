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

from dashboard.base import _ns
from dashboard.vms import _v

def list_pools():
    """List all storage pools with capacity info."""
    try:
        r = _v("pool-list", "--all")
        if r.returncode != 0:
            return []
        pools = []
        for line in r.stdout.strip().split("\n")[2:]:
            parts = line.split()
            if len(parts) < 3:
                continue
            pool_name = parts[0]
            active = parts[1].lower() == "active"
            info = {"name": pool_name, "active": active, "path": "",
                    "capacity": "", "available": "", "allocation": ""}
            try:
                ir = _v("pool-info", pool_name)
                if ir.returncode == 0:
                    for ln in ir.stdout.split("\n"):
                        if ":" not in ln:
                            continue
                        k, v = ln.split(":", 1)
                        k, v = k.strip().lower(), v.strip()
                        if k == "capacity":
                            info["capacity"] = v
                        elif k == "available":
                            info["available"] = v
                        elif k == "allocation":
                            info["allocation"] = v
                xr = _v("pool-dumpxml", pool_name)
                if xr.returncode == 0:
                    root = ET.fromstring(xr.stdout)
                    path_elem = root.find(".//target/path")
                    if path_elem is not None:
                        info["path"] = path_elem.text or ""
            except Exception:
                pass
            pools.append(info)
        return pools
    except Exception:
        return []


def list_volumes(pool):
    """List volumes in a storage pool."""
    try:
        r = _v("vol-list", pool, "--details")
        if r.returncode != 0:
            return []
        volumes = []
        for line in r.stdout.strip().split("\n")[2:]:
            parts = line.split()
            if len(parts) < 5:
                continue
            volumes.append({
                "name": parts[0],
                "path": parts[1],
                "type": parts[2],
                "capacity": parts[3] + " " + (parts[4] if len(parts) > 4 else ""),
                "allocation": " ".join(parts[5:]) if len(parts) > 5 else ""
            })
        return volumes
    except Exception:
        return []


def vol_create(pool, vol_name, size_gib, fmt="qcow2"):
    """Create a new storage volume."""
    try:
        r = _v("vol-create-as", pool, vol_name, f"{size_gib}G",
               "--format", fmt, timeout=120)
        if r.returncode != 0:
            return {"error": r.stderr.strip()}
        pr = _v("vol-path", "--pool", pool, vol_name)
        path = pr.stdout.strip() if pr.returncode == 0 else ""
        return {"success": True, "path": path}
    except Exception as e:
        return {"error": str(e)}


def vol_delete(pool, vol_name):
    """Delete a storage volume."""
    try:
        r = _v("vol-delete", "--pool", pool, vol_name)
        if r.returncode != 0:
            return {"error": r.stderr.strip()}
        return {"success": True}
    except Exception as e:
        return {"error": str(e)}


def list_isos():
    """Search host filesystem for ISO files."""
    search_paths = [
        "/var/lib/libvirt/images",
        "/home", "/mnt", "/media", "/root"
    ]
    isos = []
    for base in search_paths:
        try:
            cmd = _ns(["find", base, "-maxdepth", "5", "-name", "*.iso", "-type", "f"])
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
            if r.returncode == 0:
                for line in r.stdout.strip().split("\n"):
                    line = line.strip()
                    if line and line not in isos:
                        isos.append(line)
        except Exception:
            pass
    return sorted(isos)


# ─── ISO-Verwaltung (auflisten / von URL laden / löschen) ────────────────────

_iso_downloads = {}          # filename -> {status, error, dest}
_iso_dl_lock   = threading.Lock()


def _iso_dir():
    """Erstes beschreibbares ISO-Verzeichnis (Ziel für Downloads)."""
    for d in ("/mnt/hetzner/ISO", "/var/lib/libvirt/images", "/var/lib/libvirt/boot"):
        try:
            if subprocess.run(_ns(["test", "-w", d]), capture_output=True, timeout=5).returncode == 0:
                return d
        except Exception:
            pass
    return "/var/lib/libvirt/images"


def iso_list():
    """Gefundene ISOs mit Größe (MB)."""
    out = []
    for p in list_isos():
        size = 0
        try:
            r = subprocess.run(_ns(["stat", "-c", "%s", p]),
                               capture_output=True, text=True, timeout=5)
            if r.returncode == 0 and r.stdout.strip().isdigit():
                size = int(r.stdout.strip())
        except Exception:
            pass
        out.append({"path": p, "name": p.split("/")[-1],
                    "size_mb": round(size / 1048576, 1)})
    return out


def iso_delete(path):
    """Eine ISO-Datei löschen (nur echte .iso außerhalb von Systempfaden)."""
    if not path or not path.endswith(".iso") or not os.path.isabs(path):
        return {"error": "Ungültiger ISO-Pfad"}
    p = os.path.normpath(path)
    if p.startswith(("/dev/", "/proc/", "/sys/", "/etc/", "/boot/", "/root/")):
        return {"error": "Pfad nicht erlaubt"}
    r = subprocess.run(_ns(["rm", "-f", p]), capture_output=True, text=True, timeout=15)
    if r.returncode != 0:
        return {"error": r.stderr.strip() or "Löschen fehlgeschlagen"}
    return {"success": True}


def iso_download(url, filename=""):
    """ISO von einer URL im Hintergrund auf den Host laden (curl via nsenter)."""
    if not re.match(r'^https?://', url or ""):
        return {"error": "URL muss mit http:// oder https:// beginnen"}
    fn = (filename or "").strip() or url.split("/")[-1].split("?")[0]
    if not fn.lower().endswith(".iso"):
        fn += ".iso"
    if not re.match(r'^[A-Za-z0-9_.+-]{1,128}$', fn):
        return {"error": "Ungültiger Dateiname (nur A-Z a-z 0-9 . _ + -)"}
    dest = f"{_iso_dir()}/{fn}"

    def _run():
        with _iso_dl_lock:
            _iso_downloads[fn] = {"status": "downloading", "error": "", "dest": dest}
        tmp = dest + ".part"
        try:
            r = subprocess.run(
                _ns(["curl", "-fL", "--connect-timeout", "20", "-o", tmp, url]),
                capture_output=True, text=True, timeout=7200)
            if r.returncode == 0:
                subprocess.run(_ns(["mv", "-f", tmp, dest]), capture_output=True, timeout=15)
                with _iso_dl_lock:
                    _iso_downloads[fn] = {"status": "done", "error": "", "dest": dest}
            else:
                subprocess.run(_ns(["rm", "-f", tmp]), capture_output=True, timeout=10)
                with _iso_dl_lock:
                    _iso_downloads[fn] = {"status": "error",
                                          "error": (r.stderr or "Download fehlgeschlagen").strip()[:200],
                                          "dest": dest}
        except Exception as e:
            try:
                subprocess.run(_ns(["rm", "-f", tmp]), capture_output=True, timeout=10)
            except Exception:
                pass
            with _iso_dl_lock:
                _iso_downloads[fn] = {"status": "error", "error": str(e)[:200], "dest": dest}

    threading.Thread(target=_run, daemon=True).start()
    return {"success": True, "filename": fn, "dest": dest}


def iso_download_status():
    with _iso_dl_lock:
        return {"downloads": [dict(name=k, **v) for k, v in _iso_downloads.items()]}


# ─── Terminal Execution ──────────────────────────────────────────────────────

def execute_command(cmd, timeout=30):
    """Execute a shell command on the host via nsenter, fallback to container."""
    dangerous = ["rm -rf /", "mkfs", "dd if=", ":(){", "fork bomb"]
    for d in dangerous:
        if d in cmd:
            return {"success": False, "returncode": 1, "stdout": "", "stderr": f"Blockiert: gefährliches Muster '{d}'"}

    for full_cmd in [_ns(["bash", "-c", cmd]), ["bash", "-c", cmd]]:
        try:
            result = subprocess.run(
                full_cmd, capture_output=True, text=True, timeout=timeout
            )
            return {
                "success": result.returncode == 0,
                "returncode": result.returncode,
                "stdout": result.stdout[-10000:],
                "stderr": result.stderr[-5000:],
            }
        except FileNotFoundError:
            continue
        except subprocess.TimeoutExpired:
            return {"success": False, "returncode": -1, "stdout": "", "stderr": f"Timeout nach {timeout}s"}
        except Exception as e:
            return {"success": False, "returncode": -1, "stdout": "", "stderr": str(e)}

    return {"success": False, "returncode": 127, "stdout": "", "stderr": "bash nicht gefunden"}


# ─── Docker-Verwaltung ───────────────────────────────────────────────────────

