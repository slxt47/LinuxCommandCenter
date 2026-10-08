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

import urllib.error

from dashboard.base import DATA_DIR, _ns
from dashboard.consoles import _UnixSocketHTTPConnection, _docker_api

DOCKER_TAB_VERSION = "1.4"


# ─── Selbstschutz ────────────────────────────────────────────────────────────
# Der Container, in dem dieses Dashboard läuft, darf über die eigene Oberfläche
# nicht gestoppt/gelöscht/umbenannt werden — sonst kappt ein Fehlklick die
# Sitzung mitten in der Anfrage und nur noch SSH hilft weiter.
# `cloudflared` ist der einzige Ingress (der IP-Filter in handler.py sperrt
# direkten LAN-Zugriff); er bleibt bedienbar, wird aber als „kritisch“ markiert,
# damit die Oberfläche zusätzlich warnt.

_SELF_NAME     = "linux-dashboard"
_CRITICAL      = ("cloudflared",)
_BROWSER_PFX   = "lcc-browser-"

_self_id       = None
_self_id_lock  = threading.Lock()


def _self_container_id():
    """Volle Id des eigenen Containers (einmalig aufgelöst, dann gecacht).

    Bewusst NICHT über $HOSTNAME: der Container läuft mit `network_mode: host`
    und sieht damit den Hostnamen des Wirts, nicht seine eigene Container-Id."""
    global _self_id
    with _self_id_lock:
        if _self_id is not None:
            return _self_id
    cid = ""
    try:
        status, resp = _docker_api("GET", f"/containers/{_SELF_NAME}/json")
        if status == 200:
            cid = resp.get("Id", "") or ""
    except Exception:
        cid = ""
    with _self_id_lock:
        _self_id = cid
    return cid


def _resolve_cid(ref):
    """Beliebige Container-Referenz über Docker zur vollen Id auflösen.

    Docker akzeptiert Namen, volle Ids und **jeden eindeutigen Id-Präfix** —
    auch vierstellige. Genau deshalb reicht ein Zeichenkettenvergleich für den
    Selbstschutz nicht aus."""
    try:
        st, resp = _docker_api("GET", f"/containers/{_clean(ref)}/json")
        if st == 200:
            return (resp.get("Id") or "").lower()
    except Exception:
        pass
    return ""


def _is_self(ref):
    """True, wenn `ref` (Name, Id oder Id-Präfix) auf das Dashboard selbst zeigt.

    Früher galt hier eine Mindestlänge von 12 Zeichen für Id-Präfixe. Das war
    eine Lücke: Docker löst auch `b2b25fd1` (8 Zeichen) auf den eigenen
    Container auf, der Selbstschutz griff dann nicht und ein `stop` hätte das
    Dashboard mitten in der Anfrage beendet. Jetzt entscheidet im Zweifel
    Docker selbst."""
    ref = (ref or "").strip().lstrip("/")
    if not ref:
        return False
    if ref.lower() == _SELF_NAME.lower():
        return True
    sid = (_self_container_id() or "").lower()
    if not sid:
        return False
    r = ref.lower()
    if r == sid or (len(r) >= 2 and sid.startswith(r)):
        return True
    return _resolve_cid(ref) == sid


def _protect(ref):
    """Gibt eine Fehlermeldung zurück, wenn `ref` das Dashboard selbst ist.

    Das Flag `protected` hebt den Fall vom gewöhnlichen `{"error": …}` ab —
    der Handler schickt daraufhin HTTP 403 statt 200, damit die Sperre auch
    ohne Blick in den Text erkennbar ist."""
    if _is_self(ref):
        return {"error": "Selbstschutz: Der Container des Dashboards kann hier "
                         "nicht verändert werden.", "protected": True}
    return None


# ─── Eingabevalidierung ──────────────────────────────────────────────────────
# Alles wandert entweder als JSON in den Docker-Socket oder als argv-Element an
# nsenter — nirgends in eine Shell. Die Regexe halten trotzdem Unsinn früh ab
# und liefern eine verständliche deutsche Meldung statt eines Docker-500ers.

_ID_RE     = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$')
_IMGREF_RE = re.compile(r'^[a-z0-9]([a-z0-9._/-]*[a-z0-9])?'
                        r'(:[A-Za-z0-9_.-]{1,128})?(@sha256:[a-f0-9]{64})?$')
_SHA_RE    = re.compile(r'^sha256:[a-f0-9]{64}$')
_PROJECT_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$')


def _valid_id(ref):
    """True für Container-/Netz-/Volume-Namen und Ids."""
    return bool(_ID_RE.match((ref or "").strip().lstrip("/")))


def _valid_image_ref(ref):
    """True für `repo`, `repo:tag`, `ns/repo:tag`, `…@sha256:…` und rohe Ids."""
    ref = (ref or "").strip()
    if not ref:
        return False
    if _SHA_RE.match(ref) or re.match(r'^[a-f0-9]{12,64}$', ref):
        return True
    return bool(_IMGREF_RE.match(ref))


def _clean(ref):
    """Führenden Slash entfernen — Docker liefert Namen als „/name“."""
    return (ref or "").strip().lstrip("/")


# ─── Roh-Streams über den Docker-Socket ──────────────────────────────────────
# `_docker_api` liest bis EOF und parst JSON — für Logs, Events, Pull und Build
# reicht das nicht. Wichtig: Die Antworten sind HTTP-chunked. Der 8-Byte-
# Multiplex-Header von Docker liegt UNTER dieser Rahmung, also immer aus der
# `HTTPResponse` lesen und niemals direkt aus `conn.sock` — sonst kommen die
# Chunk-Längen als Nutzdaten an und die Frames sind Müll.

def _docker_stream(method, path, body=None, headers=None):
    """Streamenden Docker-Aufruf öffnen. Liefert (conn, resp).

    Der Aufrufer MUSS am Ende `_docker_stream_close(conn)` aufrufen."""
    conn = _UnixSocketHTTPConnection()
    hdrs = {"Host": "localhost"}
    hdrs.update(headers or {})
    payload = None
    if body is not None:
        payload = json.dumps(body).encode()
        hdrs["Content-Type"] = "application/json"
        hdrs["Content-Length"] = str(len(payload))
    try:
        conn.request(method, path, body=payload, headers=hdrs)
        resp = conn.getresponse()
    except Exception as e:
        try:
            conn.close()
        except Exception:
            pass
        raise RuntimeError(f"Docker-Stream: {e}")
    return conn, resp


def _docker_stream_close(conn):
    """Stream beenden.

    `shutdown` weckt einen Thread, der gerade in `resp.read()` blockiert —
    ohne das würde ein Log-Leser bis zum TCP-Timeout hängen bleiben."""
    try:
        conn.sock.shutdown(socket.SHUT_RDWR)
    except Exception:
        pass
    try:
        conn.close()
    except Exception:
        pass


def _read_exact(resp, n):
    """Genau n Bytes lesen. None, wenn der Stream vorher endet/geschlossen wird."""
    buf = b""
    while len(buf) < n:
        try:
            chunk = resp.read(n - len(buf))
        except Exception:
            return None
        if not chunk:
            return None
        buf += chunk
    return buf


def _docker_frames(resp):
    """Frames eines Attach-/Log-Streams liefern: (stream_id, payload).

    stream_id 1 = stdout, 2 = stderr, None = roher TTY-Strom ohne Header.
    Unterschieden wird am Content-Type (…multiplexed-stream vs …raw-stream),
    nicht an `Config.Tty` — der Header entscheidet, was tatsächlich ankommt."""
    ctype = resp.getheader("Content-Type") or ""
    if "multiplexed-stream" not in ctype:
        while True:
            try:
                chunk = resp.read(8192)
            except Exception:
                return
            if not chunk:
                return
            yield None, chunk
        return
    while True:
        hdr = _read_exact(resp, 8)
        if hdr is None:
            return
        sid = hdr[0]
        ln  = struct.unpack(">I", hdr[4:8])[0]
        if ln == 0:
            continue
        payload = _read_exact(resp, ln)
        if payload is None:
            return
        yield sid, payload


def _docker_json_stream(method, path, body=None):
    """Zeilenweisen JSON-Strom liefern (/events, /images/create, /build).

    Fehler VOR dem Strom meldet Docker als HTTP-Status mit `{"message": …}` —
    nicht als `error`-Zeile im Strom. Ohne diese Prüfung galt ein
    fehlgeschlagener Pull als erfolgreich abgeschlossen."""
    conn, resp = _docker_stream(method, path, body)
    try:
        if resp.status not in (200, 201):
            msg = ""
            try:
                raw = resp.read(8192)
                try:
                    msg = json.loads(raw).get("message", "")
                except Exception:
                    msg = raw.decode("utf-8", errors="replace").strip()[:300]
            except Exception:
                pass
            yield {"error": msg or f"Docker-Fehler (HTTP {resp.status})"}
            return
        while True:
            try:
                line = resp.readline()
            except Exception:
                return
            if not line:
                return
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except Exception:
                continue
    finally:
        _docker_stream_close(conn)


def _docker_hijack(path, body):
    """POST mit `Connection: Upgrade` / `Upgrade: tcp` (für exec-Attach).

    Liefert (sock, leftover, raw_stream). `leftover` sind Nutzdaten, die
    zusammen mit den Headern eintrafen — sie müssen VOR dem Pump-Loop
    ausgeliefert werden, sonst verschluckt die Konsole die erste Eingabezeile.

    Bewusst von Hand statt über http.client: CPython setzt bei einem
    1xx-Status `length = 0` und puffert bereits gelesene Nutzdaten im
    BufferedReader — beides würde den Anfang des Streams verlieren."""
    payload = json.dumps(body).encode()
    req = (
        f"POST {path} HTTP/1.1\r\n"
        "Host: localhost\r\n"
        "Content-Type: application/json\r\n"
        "Connection: Upgrade\r\n"
        "Upgrade: tcp\r\n"
        f"Content-Length: {len(payload)}\r\n"
        "\r\n"
    ).encode() + payload

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(15)
    try:
        sock.connect("/var/run/docker.sock")
        sock.sendall(req)
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = sock.recv(4096)
            if not chunk:
                raise RuntimeError("Verbindung abgebrochen")
            buf += chunk
            if len(buf) > 65536:
                raise RuntimeError("Antwort-Header zu groß")
    except Exception as e:
        try:
            sock.close()
        except Exception:
            pass
        raise RuntimeError(f"Docker-Exec: {e}")

    head, leftover = buf.split(b"\r\n\r\n", 1)
    first = head.split(b"\r\n", 1)[0].split(b" ")
    code  = int(first[1]) if len(first) > 1 and first[1].isdigit() else 0
    if code not in (101, 200):
        try:
            sock.close()
        except Exception:
            pass
        raise RuntimeError(f"Docker-Exec: HTTP {code}")

    sock.settimeout(None)
    return sock, leftover, (b"vnd.docker.raw-stream" in head)


# ─── Hilfsfunktionen für die Aufbereitung ────────────────────────────────────

def _fmt_ports(ports):
    """Port-Liste aus /containers/json zu ['0.0.0.0:8080->80/tcp', …] verdichten.

    Doppelte Einträge (IPv4 + IPv6 auf demselben Host-Port) werden zusammen-
    gefasst, damit die Anzeige am Handy nicht doppelt so lang wird."""
    out, seen = [], set()
    for p in ports or []:
        try:
            priv  = p.get("PrivatePort")
            pub   = p.get("PublicPort")
            proto = p.get("Type", "tcp")
            if pub:
                ip = p.get("IP", "")
                ip = "" if ip in ("::", "0.0.0.0") else ip
                key = f"{ip}:{pub}->{priv}/{proto}" if ip else f"{pub}->{priv}/{proto}"
            else:
                key = f"{priv}/{proto}"
            if key not in seen:
                seen.add(key)
                out.append(key)
        except Exception:
            continue
    return out


def _parse_started(s):
    """Docker-Zeitstempel (RFC3339 mit Nanosekunden) zu Unix-Sekunden."""
    if not s or s.startswith("0001-"):
        return 0
    try:
        base = s.split(".")[0].rstrip("Z")
        return int(time.mktime(time.strptime(base, "%Y-%m-%dT%H:%M:%S"))
                   - time.timezone)
    except Exception:
        return 0


def _net_mode_info(mode):
    """Netzwerk-Modus lesbar machen und beurteilen, ob er Netze zulässt.

    `container:<64-Hex>` ist für Menschen unlesbar — der Name des geteilten
    Containers wird deshalb aufgelöst. Container mit `host`, `none` oder einem
    geteilten Namensraum können **keinem** weiteren Netz beitreten; Docker
    lehnt das ab, und die Oberfläche darf sie gar nicht erst anbieten."""
    mode = (mode or "").strip()
    if mode.startswith("container:"):
        ref = mode.split(":", 1)[1]
        name = ref[:12]
        try:
            st, d = _docker_api("GET", f"/containers/{ref}/json")
            if st == 200:
                name = _clean(d.get("Name", "")) or name
        except Exception:
            pass
        return f"container:{name}", False, name
    if mode in ("host", "none"):
        return mode, False, ""
    return mode, True, ""


def _health_str(h):
    """Health-Status als Text — leer, wenn kein Healthcheck definiert ist."""
    if isinstance(h, dict):
        h = h.get("Status", "")
    h = (h or "").strip()
    return "" if h in ("", "none") else h


def _managed_kind(name, labels):
    """Kennzeichnet Container, die das Dashboard selbst verwaltet."""
    if name.startswith(_BROWSER_PFX):
        return "browser"
    return ""


# ─── Container ───────────────────────────────────────────────────────────────

def docker_containers(all_=True):
    """Alle Container mit Status, Ports, Compose-Projekt und Schutz-Flags."""
    try:
        q = "true" if all_ else "false"
        status, cs = _docker_api("GET", f"/containers/json?all={q}")
        if status != 200 or not isinstance(cs, list):
            return []
        out = []
        for c in cs:
            try:
                cid    = c.get("Id", "")
                name   = _clean((c.get("Names") or ["/?"])[0])
                labels = c.get("Labels") or {}
                # RestartPolicy und StartedAt stehen nicht in /containers/json.
                # 25 Inspects kosten zusammen ~6 ms — günstiger als ein zweiter
                # Endpunkt, den das Frontend nachladen müsste.
                policy, started, cmd = "", 0, c.get("Command", "")
                netmode, attachable, shares = "", True, ""
                try:
                    st, ins = _docker_api("GET", f"/containers/{cid}/json")
                    if st == 200:
                        hc = ins.get("HostConfig") or {}
                        rp = hc.get("RestartPolicy") or {}
                        policy  = rp.get("Name", "") or "no"
                        started = _parse_started((ins.get("State") or {}).get("StartedAt"))
                        netmode, attachable, shares = _net_mode_info(hc.get("NetworkMode", ""))
                except Exception:
                    pass
                out.append({
                    "id":         cid,
                    "short_id":   cid[:12],
                    "name":       name,
                    "image":      c.get("Image", ""),
                    "image_id":   c.get("ImageID", ""),
                    "command":    cmd,
                    "state":      c.get("State", ""),
                    "status":     c.get("Status", ""),
                    # /containers/json liefert Health als Objekt
                    # {"Status": "none|starting|healthy|unhealthy", …};
                    # "none" heißt „kein Healthcheck definiert“ → leer lassen.
                    "health":     _health_str(c.get("Health")),
                    "created":    c.get("Created", 0),
                    "started":    started,
                    "ports":      _fmt_ports(c.get("Ports")),
                    "restart":    policy,
                    "project":    labels.get("com.docker.compose.project", ""),
                    "service":    labels.get("com.docker.compose.service", ""),
                    "networks":   sorted((c.get("NetworkSettings") or {})
                                         .get("Networks", {}).keys()),
                    "mount_count": len(c.get("Mounts") or []),
                    "network_mode":   netmode,
                    "net_attachable": attachable,
                    "net_shares_with": shares,
                    "protected":  _is_self(name),
                    "critical":   name in _CRITICAL,
                    "managed":    _managed_kind(name, labels),
                })
            except Exception:
                continue
        out.sort(key=lambda x: (x["project"], x["name"]))
        return out
    except Exception:
        return []


def docker_container(cid):
    """Detaildaten eines Containers für die Übersicht der Detailseite."""
    if not _valid_id(cid):
        return {"error": "Ungültige Container-Kennung"}
    try:
        status, i = _docker_api("GET", f"/containers/{_clean(cid)}/json")
        if status == 404:
            return {"error": "Container nicht gefunden"}
        if status != 200:
            return {"error": i.get("message", f"Docker-Fehler (HTTP {status})")}
        cfg    = i.get("Config") or {}
        hcfg   = i.get("HostConfig") or {}
        state  = i.get("State") or {}
        labels = cfg.get("Labels") or {}
        name   = _clean(i.get("Name", ""))
        nets   = []
        for nname, n in ((i.get("NetworkSettings") or {}).get("Networks") or {}).items():
            nets.append({
                "name":    nname,
                "ip":      n.get("IPAddress", ""),
                "gateway": n.get("Gateway", ""),
                "mac":     n.get("MacAddress", ""),
                "aliases": n.get("Aliases") or [],
            })
        mounts = []
        for m in i.get("Mounts") or []:
            mounts.append({
                "type":        m.get("Type", ""),
                "source":      m.get("Source", "") or m.get("Name", ""),
                "destination": m.get("Destination", ""),
                "mode":        m.get("Mode", ""),
                "rw":          bool(m.get("RW", False)),
            })
        rp = hcfg.get("RestartPolicy") or {}
        return {
            "id":          i.get("Id", ""),
            "short_id":    i.get("Id", "")[:12],
            "name":        name,
            "image":       cfg.get("Image", ""),
            "image_id":    i.get("Image", ""),
            "state":       state.get("Status", ""),
            "running":     bool(state.get("Running")),
            "paused":      bool(state.get("Paused")),
            "exit_code":   state.get("ExitCode", 0),
            "error":       state.get("Error", ""),
            "started":     _parse_started(state.get("StartedAt")),
            "finished":    _parse_started(state.get("FinishedAt")),
            "created":     _parse_started(i.get("Created")),
            "health":      _health_str(state.get("Health")),
            "health_log":  [{"start": h.get("Start", ""), "exit": h.get("ExitCode", 0),
                             "output": (h.get("Output") or "")[:500]}
                            for h in ((state.get("Health") or {}).get("Log") or [])[-5:]],
            "restart":     rp.get("Name", "") or "no",
            "restart_max": rp.get("MaximumRetryCount", 0),
            "restarts":    i.get("RestartCount", 0),
            "cmd":         cfg.get("Cmd") or [],
            "entrypoint":  cfg.get("Entrypoint") or [],
            "user":        cfg.get("User", ""),
            "workdir":     cfg.get("WorkingDir", ""),
            "env":         cfg.get("Env") or [],
            "labels":      labels,
            "ports":       _fmt_ports([
                               {"PrivatePort": int(k.split("/")[0]),
                                "Type": k.split("/")[1] if "/" in k else "tcp",
                                "PublicPort": int(b["HostPort"]) if b.get("HostPort") else None,
                                "IP": b.get("HostIp", "")}
                               for k, bs in ((i.get("NetworkSettings") or {})
                                             .get("Ports") or {}).items()
                               for b in (bs or [{}]) if b
                           ]),
            "networks":    nets,
            "mounts":      mounts,
            "privileged":  bool(hcfg.get("Privileged")),
            "cap_add":     hcfg.get("CapAdd") or [],
            "cap_drop":    hcfg.get("CapDrop") or [],
            "memory":      hcfg.get("Memory", 0),
            "memory_swap": hcfg.get("MemorySwap", 0),
            "cpu_quota":   hcfg.get("CpuQuota", 0),
            "cpu_period":  hcfg.get("CpuPeriod", 0),
            "cpu_shares":  hcfg.get("CpuShares", 0),
            "cpuset":      hcfg.get("CpusetCpus", ""),
            "network_mode":   _net_mode_info(hcfg.get("NetworkMode", ""))[0],
            "net_attachable": _net_mode_info(hcfg.get("NetworkMode", ""))[1],
            "net_shares_with": _net_mode_info(hcfg.get("NetworkMode", ""))[2],
            "log_driver":  (hcfg.get("LogConfig") or {}).get("Type", ""),
            "project":     labels.get("com.docker.compose.project", ""),
            "service":     labels.get("com.docker.compose.service", ""),
            "protected":   _is_self(name),
            "critical":    name in _CRITICAL,
            "managed":     _managed_kind(name, labels),
        }
    except Exception as e:
        return {"error": str(e)}


def docker_inspect(cid):
    """Rohes Inspect-JSON eines Containers."""
    if not _valid_id(cid):
        return {"error": "Ungültige Container-Kennung"}
    try:
        status, i = _docker_api("GET", f"/containers/{_clean(cid)}/json")
        if status == 404:
            return {"error": "Container nicht gefunden"}
        if status != 200:
            return {"error": i.get("message", f"Docker-Fehler (HTTP {status})")}
        return {"inspect": i}
    except Exception as e:
        return {"error": str(e)}


def docker_top(cid, ps_args="-ef"):
    """Prozessliste im Container (`/top`)."""
    if not _valid_id(cid):
        return {"error": "Ungültige Container-Kennung"}
    if not re.match(r'^[A-Za-z0-9 -]{0,32}$', ps_args or ""):
        return {"error": "Ungültige ps-Optionen"}
    try:
        from urllib.parse import quote
        status, d = _docker_api(
            "GET", f"/containers/{_clean(cid)}/top?ps_args={quote(ps_args)}")
        if status == 404:
            return {"error": "Container nicht gefunden"}
        if status != 200:
            # Docker antwortet hier mit englischem Klartext („… is not running“)
            # — für einen gestoppten Container ist das der Normalfall, keine
            # Störung. Deshalb eine eigene, verständliche Meldung.
            msg = str(d.get("message", ""))
            if status == 409 or "not running" in msg:
                return {"error": "Container läuft nicht — keine Prozessliste verfügbar."}
            return {"error": msg or "Prozessliste nicht verfügbar"}
        return {"titles": d.get("Titles") or [], "processes": d.get("Processes") or []}
    except Exception as e:
        return {"error": str(e)}


def docker_changes(cid):
    """Dateiänderungen gegenüber dem Image (`/changes`).

    Docker liefert `null` statt `[]`, wenn nichts geändert wurde."""
    if not _valid_id(cid):
        return {"error": "Ungültige Container-Kennung"}
    try:
        status, d = _docker_api("GET", f"/containers/{_clean(cid)}/changes")
        if status == 404:
            return {"error": "Container nicht gefunden"}
        if status != 200:
            return {"error": "Dateiänderungen nicht verfügbar"}
        kinds = {0: "geändert", 1: "hinzugefügt", 2: "gelöscht"}
        return {"changes": [{"path": c.get("Path", ""),
                             "kind": c.get("Kind", 0),
                             "kind_text": kinds.get(c.get("Kind", 0), "?")}
                            for c in (d or [])]}
    except Exception as e:
        return {"error": str(e)}


def docker_logs(cid, tail=200, timestamps=False, since=0):
    """Logs einmalig abholen (nicht folgend) — als fertiger Text."""
    if not _valid_id(cid):
        return {"error": "Ungültige Container-Kennung"}
    # tail=0 heißt „keine Rückschau" — vorher wurde auf 1 hochgeklemmt.
    if tail is None or tail == "":
        tail = 200
    try:
        tail = max(0, min(int(tail), 10000))
    except (TypeError, ValueError):
        tail = 200
    try:
        since = max(0, int(since or 0))
    except (TypeError, ValueError):
        since = 0
    ts = "1" if timestamps else "0"
    path = (f"/containers/{_clean(cid)}/logs?stdout=1&stderr=1"
            f"&tail={tail}&timestamps={ts}&since={since}")
    conn = None
    try:
        conn, resp = _docker_stream("GET", path)
        if resp.status == 404:
            return {"error": "Container nicht gefunden"}
        if resp.status not in (200, 101):
            return {"error": f"Logs nicht verfügbar (HTTP {resp.status})"}
        parts, total = [], 0
        for _sid, payload in _docker_frames(resp):
            parts.append(payload)
            total += len(payload)
            if total > 4 * 1024 * 1024:      # harte Obergrenze gegen Speicher-DoS
                parts.append(b"\n[... gekuerzt, bitte kleineres Tail waehlen ...]\n")
                break
        return {"logs": b"".join(parts).decode("utf-8", errors="replace")}
    except Exception as e:
        return {"error": str(e)}
    finally:
        if conn is not None:
            _docker_stream_close(conn)


# ─── Images ──────────────────────────────────────────────────────────────────

def docker_images():
    """Alle Images mit Repo:Tag, Größe, Alter und Verwendungszähler."""
    try:
        status, imgs = _docker_api("GET", "/images/json?all=false")
        if status != 200 or not isinstance(imgs, list):
            return []
        used = {}
        try:
            st, cs = _docker_api("GET", "/containers/json?all=true")
            if st == 200:
                for c in cs or []:
                    used[c.get("ImageID", "")] = used.get(c.get("ImageID", ""), 0) + 1
        except Exception:
            pass
        out = []
        for im in imgs:
            iid  = im.get("Id", "")
            tags = im.get("RepoTags") or []
            tags = [t for t in tags if t != "<none>:<none>"]
            out.append({
                "id":        iid,
                "short_id":  iid.replace("sha256:", "")[:12],
                "tags":      tags,
                "digests":   im.get("RepoDigests") or [],
                "size":      im.get("Size", 0),
                "shared":    im.get("SharedSize", 0),
                "created":   im.get("Created", 0),
                "containers": used.get(iid, 0),
                "dangling":  not tags,
                "labels":    im.get("Labels") or {},
            })
        out.sort(key=lambda x: -x["created"])
        return out
    except Exception:
        return []


def docker_image_inspect(ref):
    """Rohes Inspect-JSON eines Images."""
    if not _valid_image_ref(ref):
        return {"error": "Ungültige Image-Referenz"}
    try:
        from urllib.parse import quote
        status, i = _docker_api("GET", f"/images/{quote(ref, safe='')}/json")
        if status == 404:
            return {"error": "Image nicht gefunden"}
        if status != 200:
            return {"error": i.get("message", f"Docker-Fehler (HTTP {status})")}
        return {"inspect": i}
    except Exception as e:
        return {"error": str(e)}


def docker_image_history(ref):
    """Schichten-Historie eines Images."""
    if not _valid_image_ref(ref):
        return {"error": "Ungültige Image-Referenz"}
    try:
        from urllib.parse import quote
        status, h = _docker_api("GET", f"/images/{quote(ref, safe='')}/history")
        if status == 404:
            return {"error": "Image nicht gefunden"}
        if status != 200:
            return {"error": "Historie nicht verfügbar"}
        return {"history": [{"id": e.get("Id", ""), "created": e.get("Created", 0),
                             "created_by": e.get("CreatedBy", ""),
                             "size": e.get("Size", 0),
                             "comment": e.get("Comment", ""),
                             "tags": e.get("Tags") or []}
                            for e in (h or [])]}
    except Exception as e:
        return {"error": str(e)}


def docker_image_remove(ref, force=False, noprune=False):
    """Image entfernen."""
    if not _valid_image_ref(ref):
        return {"error": "Ungültige Image-Referenz"}
    try:
        from urllib.parse import quote
        q = f"?force={'true' if force else 'false'}&noprune={'true' if noprune else 'false'}"
        status, resp = _docker_api("DELETE", f"/images/{quote(ref, safe='')}{q}")
        if status == 200:
            deleted = [x.get("Deleted") or x.get("Untagged") for x in (resp or [])
                       if isinstance(x, dict)] if isinstance(resp, list) else []
            return {"success": True, "deleted": [d for d in deleted if d]}
        if status == 404:
            return {"error": "Image nicht gefunden"}
        if status == 409:
            return {"error": "Image wird noch von einem Container benutzt — "
                             "„Erzwingen“ aktivieren oder Container zuerst entfernen."}
        return {"error": resp.get("message", f"Docker-Fehler (HTTP {status})")}
    except Exception as e:
        return {"error": str(e)}


def docker_image_tag(ref, repo, tag="latest"):
    """Zusätzlichen Tag auf ein Image setzen."""
    if not _valid_image_ref(ref):
        return {"error": "Ungültige Image-Referenz"}
    repo = (repo or "").strip()
    tag  = (tag or "latest").strip()
    if not _valid_image_ref(repo) or ":" in repo:
        return {"error": "Ungültiger Repository-Name (ohne Tag angeben)"}
    if not re.match(r'^[A-Za-z0-9_.-]{1,128}$', tag):
        return {"error": "Ungültiger Tag"}
    try:
        from urllib.parse import quote
        status, resp = _docker_api(
            "POST", f"/images/{quote(ref, safe='')}/tag"
                    f"?repo={quote(repo, safe='/')}&tag={quote(tag, safe='')}")
        if status in (200, 201):
            return {"success": True, "ref": f"{repo}:{tag}"}
        if status == 404:
            return {"error": "Image nicht gefunden"}
        if status == 409:
            return {"error": "Tag bereits vergeben"}
        return {"error": resp.get("message", f"Docker-Fehler (HTTP {status})")}
    except Exception as e:
        return {"error": str(e)}


def docker_image_save_open(ref):
    """Image als Tar-Strom öffnen. Liefert (conn, resp)."""
    if not _valid_image_ref(ref):
        raise RuntimeError("Ungültige Image-Referenz")
    from urllib.parse import quote
    conn, resp = _docker_stream("GET", f"/images/{quote(ref, safe='')}/get")
    if resp.status == 404:
        _docker_stream_close(conn)
        raise RuntimeError("Image nicht gefunden")
    if resp.status != 200:
        _docker_stream_close(conn)
        raise RuntimeError(f"Export fehlgeschlagen (HTTP {resp.status})")
    return conn, resp


# ─── Docker Hub ──────────────────────────────────────────────────────────────
# Zwei Wege: der v3-Katalog liefert zusätzlich `source` (store /
# verified_publisher / community) und damit das Verified-Kennzeichen; die
# ältere v2-Suche dient als Rückfallebene. Die Antwort wird auf fünf Felder
# eingedampft — das rohe Hub-JSON ist ein Vielfaches groß.

_HUB_TIMEOUT = 10


def _hub_get(url):
    import urllib.request, urllib.error
    req = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "User-Agent": "LinuxCommandCenter-Docker/" + DOCKER_TAB_VERSION,
        "Search-Version": "v3",
    })
    with urllib.request.urlopen(req, timeout=_HUB_TIMEOUT) as f:
        return json.loads(f.read().decode("utf-8", errors="replace"))


def docker_hub_search(query, page=1):
    """Docker Hub durchsuchen."""
    query = (query or "").strip()
    if not query or len(query) > 128:
        return {"error": "Suchbegriff fehlt oder ist zu lang"}
    if not re.match(r'^[A-Za-z0-9 _./+-]{1,128}$', query):
        return {"error": "Ungültiger Suchbegriff"}
    try:
        page = max(1, min(int(page or 1), 20))
    except (TypeError, ValueError):
        page = 1
    from urllib.parse import quote
    q = quote(query, safe='')
    try:
        d = _hub_get("https://hub.docker.com/api/search/v3/catalog/search"
                     f"?query={q}&size=25&from={(page - 1) * 25}")
        out = []
        for r in d.get("results") or []:
            src  = r.get("source", "")
            name = r.get("id") or r.get("name", "")
            # Offizielle Images liegen im Namensraum „library/“ (v3 liefert sie
            # als „library/nginx“, gezeigt wird der kurze Name „nginx“).
            official = name.startswith("library/")
            out.append({
                "name":        name[len("library/"):] if official else name,
                "description": (r.get("short_description") or "")[:300],
                "stars":       int((r.get("star_count") or 0)),
                "pulls":       int((r.get("pull_count") or 0)),
                "official":    official,
                "verified":    src in ("store", "verified_publisher") and not official,
                "publisher":   ((r.get("publisher") or {}).get("name") or "")[:64],
            })
        if out:
            return {"results": out, "source": "v3"}
    except Exception:
        pass
    # Rückfallebene: ältere v2-Suche (ohne Verified-Kennzeichen)
    try:
        d = _hub_get("https://hub.docker.com/v2/search/repositories/"
                     f"?query={q}&page_size=25&page={page}")
        out = []
        for r in d.get("results") or []:
            out.append({
                "name":        r.get("repo_name", ""),
                "description": (r.get("short_description") or "")[:300],
                "stars":       int(r.get("star_count") or 0),
                "pulls":       int(r.get("pull_count") or 0),
                "official":    bool(r.get("is_official")),
                "verified":    bool(r.get("is_automated")),
                "publisher":   "",
            })
        return {"results": out, "source": "v2"}
    except Exception:
        return {"error": "Docker Hub nicht erreichbar"}


def docker_hub_tags(repo):
    """Verfügbare Tags eines Hub-Repositories."""
    repo = (repo or "").strip()
    if not repo or not re.match(r'^[a-z0-9]([a-z0-9._/-]*[a-z0-9])?$', repo):
        return {"error": "Ungültiger Repository-Name"}
    ns, _, name = repo.rpartition("/")
    ns = ns or "library"
    from urllib.parse import quote
    try:
        d = _hub_get(f"https://hub.docker.com/v2/repositories/"
                     f"{quote(ns, safe='')}/{quote(name, safe='')}/tags"
                     "/?page_size=50&ordering=last_updated")
        tags = []
        for t in d.get("results") or []:
            tags.append({
                "name":    t.get("name", ""),
                "size":    t.get("full_size", 0),
                "updated": (t.get("last_updated") or "")[:19].replace("T", " "),
                "arch":    ",".join(sorted({(i.get("architecture") or "")
                                            for i in (t.get("images") or [])
                                            if i.get("architecture")}))[:64],
            })
        return {"tags": tags, "repo": repo}
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {"error": f"Repository „{repo}“ auf Docker Hub nicht "
                             "gefunden (oder nicht öffentlich einsehbar)."}
        return {"error": f"Tags konnten nicht geladen werden (HTTP {e.code})"}
    except Exception:
        # Manche Repositories (z. B. Hardened Images) geben ihre Tag-Liste
        # nicht öffentlich heraus — das ist kein Fehler des Dashboards.
        return {"error": "Tag-Liste für dieses Repository nicht öffentlich "
                         "abrufbar — Tag bitte von Hand eingeben."}


# ─── Netzwerke ───────────────────────────────────────────────────────────────

def docker_networks():
    """Alle Docker-Netzwerke mit Treiber, Subnetz und verbundenen Containern."""
    try:
        status, nets = _docker_api("GET", "/networks")
        if status != 200 or not isinstance(nets, list):
            return []
        # Die Listenantwort liefert `Containers: null` — die Mitgliedschaft
        # steht nur im Inspect. Statt 14 Inspects zu fahren, wird sie aus der
        # Containerliste abgeleitet (ein Aufruf). Ohne das zeigte jedes Netz
        # „0 Container“ und der Prune-Trockenlauf hätte produktive Netze als
        # ungenutzt gemeldet.
        members = {}
        try:
            # all=true: ein gestoppter, aber verbundener Container gehört
            # weiterhin zum Netz. Mit all=false war er unsichtbar — die
            # Mitgliederzahl zeigte 0 und es gab keinen Trennen-Knopf.
            st, cs = _docker_api("GET", "/containers/json?all=true")
            if st == 200:
                for c in cs or []:
                    for nname in ((c.get("NetworkSettings") or {})
                                  .get("Networks") or {}):
                        members.setdefault(nname, []).append(
                            _clean((c.get("Names") or ["/?"])[0]))
        except Exception:
            pass
        out = []
        for n in nets:
            ipam = (n.get("IPAM") or {}).get("Config") or []
            out.append({
                "id":        n.get("Id", ""),
                "short_id":  n.get("Id", "")[:12],
                "name":      n.get("Name", ""),
                "driver":    n.get("Driver", ""),
                "scope":     n.get("Scope", ""),
                "internal":  bool(n.get("Internal")),
                "ipv6":      bool(n.get("EnableIPv6")),
                "attachable": bool(n.get("Attachable")),
                "subnets":   [c.get("Subnet", "") for c in ipam if c.get("Subnet")],
                "gateways":  [c.get("Gateway", "") for c in ipam if c.get("Gateway")],
                "containers": len(members.get(n.get("Name", ""), [])),
                "members":   sorted(members.get(n.get("Name", ""), []))[:20],
                "labels":    n.get("Labels") or {},
                "builtin":   n.get("Name", "") in ("bridge", "host", "none"),
            })
        out.sort(key=lambda x: (not x["builtin"], x["name"]))
        return out
    except Exception:
        return []


def docker_network(nid):
    """Ein Netzwerk im Detail, inklusive verbundener Container."""
    if not _valid_id(nid):
        return {"error": "Ungültige Netzwerk-Kennung"}
    try:
        status, n = _docker_api("GET", f"/networks/{_clean(nid)}")
        if status == 404:
            return {"error": "Netzwerk nicht gefunden"}
        if status != 200:
            return {"error": n.get("message", f"Docker-Fehler (HTTP {status})")}
        ipam = (n.get("IPAM") or {}).get("Config") or []
        members = [{"id": k, "short_id": k[:12], "name": v.get("Name", ""),
                    "ipv4": v.get("IPv4Address", ""), "ipv6": v.get("IPv6Address", ""),
                    "mac": v.get("MacAddress", ""), "running": True}
                   for k, v in (n.get("Containers") or {}).items()]
        # `/networks/{id}` listet nur LAUFENDE Container. Gestoppte bleiben mit
        # dem Netz verbunden und müssen sich auch wieder trennen lassen —
        # deshalb aus der Containerliste ergänzen.
        try:
            bekannt = {m["id"] for m in members}
            st2, cs = _docker_api("GET", "/containers/json?all=true")
            if st2 == 200:
                nname = n.get("Name", "")
                for c in cs or []:
                    nets = (c.get("NetworkSettings") or {}).get("Networks") or {}
                    if nname in nets and c.get("Id") not in bekannt:
                        e = nets[nname] or {}
                        members.append({
                            "id": c.get("Id", ""), "short_id": c.get("Id", "")[:12],
                            "name": _clean((c.get("Names") or ["/?"])[0]),
                            "ipv4": e.get("IPAddress", ""),
                            "ipv6": e.get("GlobalIPv6Address", ""),
                            "mac": e.get("MacAddress", ""), "running": False})
        except Exception:
            pass
        members.sort(key=lambda x: x["name"])
        return {"network": {
            "id": n.get("Id", ""), "short_id": n.get("Id", "")[:12],
            "name": n.get("Name", ""), "driver": n.get("Driver", ""),
            "scope": n.get("Scope", ""), "internal": bool(n.get("Internal")),
            "ipv6": bool(n.get("EnableIPv6")),
            "attachable": bool(n.get("Attachable")),
            "created": n.get("Created", ""),
            "subnets": [c.get("Subnet", "") for c in ipam if c.get("Subnet")],
            "gateways": [c.get("Gateway", "") for c in ipam if c.get("Gateway")],
            "ranges": [c.get("IPRange", "") for c in ipam if c.get("IPRange")],
            "options": n.get("Options") or {}, "labels": n.get("Labels") or {},
            "members": members,
            "builtin": n.get("Name", "") in ("bridge", "host", "none"),
        }}
    except Exception as e:
        return {"error": str(e)}


# ─── Volumes ─────────────────────────────────────────────────────────────────

def docker_volumes():
    """Alle Volumes mit Treiber, Mountpoint, Größe und Verwendungszähler.

    Größen kommen aus `/system/df?type=volume` (8 KB) — der ungefilterte
    Aufruf liefert auf diesem Host über 1 MB und wäre für eine Liste absurd."""
    try:
        status, d = _docker_api("GET", "/volumes")
        if status != 200:
            return []
        sizes = {}
        try:
            st, df = _docker_api("GET", "/system/df?type=volume")
            if st == 200:
                for v in df.get("Volumes") or []:
                    us = v.get("UsageData") or {}
                    sizes[v.get("Name", "")] = (us.get("Size", -1), us.get("RefCount", 0))
        except Exception:
            pass
        used = {}
        try:
            st, cs = _docker_api("GET", "/containers/json?all=true")
            if st == 200:
                for c in cs or []:
                    for m in c.get("Mounts") or []:
                        if m.get("Type") == "volume" and m.get("Name"):
                            used.setdefault(m["Name"], []).append(
                                _clean((c.get("Names") or ["/?"])[0]))
        except Exception:
            pass
        out = []
        for v in d.get("Volumes") or []:
            name = v.get("Name", "")
            size, refs = sizes.get(name, (-1, 0))
            out.append({
                "name":       name,
                "driver":     v.get("Driver", ""),
                "mountpoint": v.get("Mountpoint", ""),
                "created":    v.get("CreatedAt", ""),
                "scope":      v.get("Scope", ""),
                "labels":     v.get("Labels") or {},
                "size":       size,
                "refs":       refs,
                "used_by":    sorted(used.get(name, [])),
            })
        out.sort(key=lambda x: x["name"])
        return out
    except Exception:
        return []


def docker_volume(name):
    """Ein Volume im Detail."""
    if not _valid_id(name):
        return {"error": "Ungültiger Volume-Name"}
    try:
        status, v = _docker_api("GET", f"/volumes/{_clean(name)}")
        if status == 404:
            return {"error": "Volume nicht gefunden"}
        if status != 200:
            return {"error": v.get("message", f"Docker-Fehler (HTTP {status})")}
        return {"volume": v}
    except Exception as e:
        return {"error": str(e)}


_NET_DRIVERS = ("bridge", "macvlan", "ipvlan", "overlay", "host", "none")


def docker_network_create(name, driver="bridge", subnet="", gateway="",
                          ip_range="", internal=False, ipv6=False, parent="",
                          options=None, labels=None):
    """Docker-Netzwerk anlegen."""
    import ipaddress
    name = _clean(name)
    if not _valid_id(name):
        return {"error": "Ungültiger Netzwerkname (nur A-Z a-z 0-9 . _ -)"}
    if driver not in _NET_DRIVERS:
        return {"error": f"Unbekannter Treiber: {driver}"}
    ipam_cfg = {}
    for key, val, label in (("Subnet", subnet, "Subnetz"),
                            ("Gateway", gateway, "Gateway"),
                            ("IPRange", ip_range, "IP-Bereich")):
        val = (val or "").strip()
        if not val:
            continue
        try:
            if key == "Gateway":
                ipaddress.ip_address(val)
            else:
                ipaddress.ip_network(val, strict=False)
        except ValueError:
            return {"error": f"Ungültiges {label}"}
        ipam_cfg[key] = val
    if ipam_cfg.get("Gateway") and not ipam_cfg.get("Subnet"):
        return {"error": "Gateway ohne Subnetz ist nicht möglich"}
    if ipam_cfg.get("IPRange") and not ipam_cfg.get("Subnet"):
        return {"error": "IP-Bereich ohne Subnetz ist nicht möglich"}

    opts = {}
    for k, v in (options or {}).items():
        if not re.match(r'^[A-Za-z0-9_.\-]{1,64}$', str(k)):
            return {"error": f"Ungültiger Options-Name: {k}"}
        opts[str(k)] = str(v)[:256]
    if parent:
        if not re.match(r'^[A-Za-z0-9_.:@-]{1,32}$', parent):
            return {"error": "Ungültige Eltern-Schnittstelle"}
        opts["parent"] = parent
    elif driver in ("macvlan", "ipvlan"):
        return {"error": f"Treiber {driver} braucht eine Eltern-Schnittstelle "
                         "(z. B. eth0)"}

    labs = {}
    for k, v in (labels or {}).items():
        if not re.match(r'^[A-Za-z0-9_.\-/]{1,128}$', str(k)):
            return {"error": f"Ungültiger Label-Name: {k}"}
        labs[str(k)] = str(v)[:256]

    body = {"Name": name, "Driver": driver, "CheckDuplicate": True,
            "Internal": bool(internal), "EnableIPv6": bool(ipv6),
            "Options": opts, "Labels": labs}
    if ipam_cfg:
        body["IPAM"] = {"Driver": "default", "Config": [ipam_cfg]}
    try:
        status, resp = _docker_api("POST", "/networks/create", body)
        if status in (200, 201):
            return {"success": True, "id": resp.get("Id", ""),
                    "warning": resp.get("Warning", "")}
        if status == 409:
            return {"error": f"Netzwerk „{name}“ existiert bereits"}
        return {"error": resp.get("message", f"Docker-Fehler (HTTP {status})")}
    except Exception as e:
        return {"error": str(e)}


def docker_network_remove(nid):
    """Netzwerk entfernen. Eingebaute Netze sind gesperrt."""
    if not _valid_id(nid):
        return {"error": "Ungültige Netzwerk-Kennung"}
    nid = _clean(nid)
    # Namensprüfung allein genügte nicht: wer die Id von `bridge` übergibt,
    # kam daran vorbei. Deshalb zuerst über Docker den echten Namen holen.
    name = nid
    try:
        st, info = _docker_api("GET", f"/networks/{nid}")
        if st == 200:
            name = info.get("Name", nid)
    except Exception:
        pass
    if name in ("bridge", "host", "none"):
        return {"error": "Eingebaute Docker-Netzwerke können nicht entfernt werden"}
    try:
        status, resp = _docker_api("DELETE", f"/networks/{nid}")
        if status in (200, 204):
            return {"success": True}
        if status == 404:
            return {"error": "Netzwerk nicht gefunden"}
        if status == 403:
            # Eingebaute Netze sind oben schon abgefangen — ein 403 bedeutet
            # hier immer „hat noch aktive Endpunkte".
            return {"error": "Netzwerk wird noch benutzt — zuerst alle "
                             "Container davon trennen."}
        return {"error": resp.get("message", "Netzwerk konnte nicht entfernt werden")}
    except Exception as e:
        return {"error": str(e)}


def _connect_error_de(msg, status=0):
    """Häufige Docker-Meldungen beim Verbinden auf Deutsch übersetzen.

    Docker antwortet hier in englischem Klartext; unübersetzt weitergereicht
    wirkt das in der sonst deutschen Oberfläche wie ein Absturz."""
    m = (msg or "").lower()
    if "already exists" in m or "already attached" in m:
        return "Der Container ist mit diesem Netzwerk bereits verbunden."
    if "private (none) mode" in m or "none mode" in m:
        return ("Der Container läuft im Netzwerk-Modus „none“ und kann keinem "
                "Netzwerk beitreten. Dafür muss er neu erstellt werden.")
    if "sharing network namespace" in m:
        return ("Dieser Container teilt sich den Netzwerk-Stack eines anderen "
                "Containers (oder des Wirts). Docker erlaubt ihm deshalb kein "
                "weiteres Netzwerk — das Netz muss dem Container zugewiesen "
                "werden, dessen Stack er mitbenutzt.")
    if "host network" in m or "network mode" in m and "host" in m:
        return ("Der Container nutzt den Netzwerk-Modus „host“ und teilt sich "
                "den Netzwerk-Stack des Wirts — weitere Netze sind nicht möglich.")
    if "no configured subnet" in m or "not belong to any" in m:
        return ("Die angegebene IP-Adresse liegt außerhalb des Subnetzes "
                "dieses Netzwerks.")
    if "address already in use" in m or "already allocated" in m:
        return "Die angegebene IP-Adresse ist im Netzwerk bereits vergeben."
    if "swarm" in m:
        return "Overlay-Netzwerke erfordern einen aktiven Swarm-Modus."
    return msg or f"Docker-Fehler (HTTP {status})"


def docker_network_connect(nid, container, ipv4="", ipv6="", aliases=None):
    """Container mit einem Netzwerk verbinden (optional feste IP/Aliasse)."""
    import ipaddress
    if not _valid_id(nid) or not _valid_id(container):
        return {"error": "Ungültige Kennung"}
    cfg = {}
    for key, val, label in (("IPv4Address", ipv4, "IPv4-Adresse"),
                            ("IPv6Address", ipv6, "IPv6-Adresse")):
        val = (val or "").strip()
        if not val:
            continue
        try:
            ipaddress.ip_address(val)
        except ValueError:
            return {"error": f"Ungültige {label}"}
        cfg[key] = val
    al = []
    for a in (aliases or []):
        a = str(a).strip()
        if not a:
            continue
        if not re.match(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$', a):
            return {"error": f"Ungültiger Alias: {a}"}
        al.append(a)
    body = {"Container": _clean(container)}
    ep = {}
    if cfg:
        ep["IPAMConfig"] = cfg
    if al:
        ep["Aliases"] = al
    if ep:
        body["EndpointConfig"] = ep
    try:
        status, resp = _docker_api("POST", f"/networks/{_clean(nid)}/connect", body)
        if status in (200, 204):
            return {"success": True}
        if status == 404:
            return {"error": "Netzwerk oder Container nicht gefunden"}
        return {"error": _connect_error_de(resp.get("message", ""), status)}
    except Exception as e:
        return {"error": str(e)}


def docker_network_disconnect(nid, container, force=False):
    """Container von einem Netzwerk trennen."""
    if not _valid_id(nid) or not _valid_id(container):
        return {"error": "Ungültige Kennung"}
    if _is_self(container):
        return {"error": "Selbstschutz: Das Dashboard darf sich nicht selbst "
                         "vom Netz trennen.", "protected": True}
    try:
        status, resp = _docker_api("POST", f"/networks/{_clean(nid)}/disconnect",
                                   {"Container": _clean(container),
                                    "Force": bool(force)})
        if status in (200, 204):
            return {"success": True}
        if status == 404:
            return {"error": "Netzwerk oder Container nicht gefunden"}
        return {"error": resp.get("message", f"Docker-Fehler (HTTP {status})")}
    except Exception as e:
        return {"error": str(e)}


# ─── Volumes: schreibende Aktionen ───────────────────────────────────────────

def docker_volume_create(name, driver="local", options=None, labels=None):
    """Volume anlegen."""
    name = _clean(name)
    if not _valid_id(name):
        return {"error": "Ungültiger Volume-Name (nur A-Z a-z 0-9 . _ -)"}
    if not re.match(r'^[A-Za-z0-9_.-]{1,64}$', driver or "local"):
        return {"error": "Ungültiger Treiber"}
    opts, labs = {}, {}
    for k, v in (options or {}).items():
        if not re.match(r'^[A-Za-z0-9_.\-]{1,64}$', str(k)):
            return {"error": f"Ungültiger Options-Name: {k}"}
        opts[str(k)] = str(v)[:512]
    for k, v in (labels or {}).items():
        if not re.match(r'^[A-Za-z0-9_.\-/]{1,128}$', str(k)):
            return {"error": f"Ungültiger Label-Name: {k}"}
        labs[str(k)] = str(v)[:256]
    # Docker ist hier idempotent und meldet auch für ein bestehendes Volume
    # Erfolg. Ohne diese Prüfung glaubt man, ein leeres Volume zu bekommen,
    # und arbeitet in Wahrheit auf den alten Daten weiter.
    try:
        st, _vorhanden = _docker_api("GET", f"/volumes/{name}")
        if st == 200:
            return {"error": f"Volume „{name}“ existiert bereits"}
    except Exception:
        pass
    try:
        status, resp = _docker_api("POST", "/volumes/create",
                                   {"Name": name, "Driver": driver or "local",
                                    "DriverOpts": opts, "Labels": labs})
        if status in (200, 201):
            return {"success": True, "name": resp.get("Name", name)}
        return {"error": resp.get("message", f"Docker-Fehler (HTTP {status})")}
    except Exception as e:
        return {"error": str(e)}


def docker_volume_remove(name, force=False):
    """Volume entfernen."""
    if not _valid_id(name):
        return {"error": "Ungültiger Volume-Name"}
    try:
        status, resp = _docker_api(
            "DELETE", f"/volumes/{_clean(name)}?force={'true' if force else 'false'}")
        if status in (200, 204):
            return {"success": True}
        if status == 404:
            return {"error": "Volume nicht gefunden"}
        if status == 409:
            return {"error": "Volume wird noch benutzt — zuerst den Container "
                             "entfernen."}
        return {"error": resp.get("message", f"Docker-Fehler (HTTP {status})")}
    except Exception as e:
        return {"error": str(e)}


# ─── Aufräumen (Prune) ───────────────────────────────────────────────────────
# Der Trockenlauf ist verpflichtend: er listet namentlich auf, was verschwinden
# würde. Auf diesem Host sind das potenziell über 180 Images — ein blindes
# „Aufräumen“ wäre nicht rückholbar.

_PRUNE_TYPES = ("containers", "images", "volumes", "networks", "build-cache")


def docker_prune_dryrun(types, images_all=False):
    """Auflisten, was ein Prune entfernen würde — ohne etwas zu löschen."""
    types = [t for t in (types or []) if t in _PRUNE_TYPES]
    if not types:
        return {"error": "Keine gültigen Aufräum-Typen gewählt"}
    out = {"containers": [], "images": [], "volumes": [], "networks": [],
           "build_cache": {}, "reclaimable": 0}
    try:
        if "containers" in types:
            for c in docker_containers(all_=True):
                if c["state"] in ("exited", "created", "dead"):
                    out["containers"].append({"name": c["name"], "id": c["short_id"],
                                              "image": c["image"], "status": c["status"],
                                              "protected": c["protected"]})
        if "images" in types:
            imgs = docker_images()
            for i in imgs:
                if i["containers"]:
                    continue
                if not images_all and not i["dangling"]:
                    continue
                out["images"].append({"id": i["short_id"],
                                      "tags": i["tags"] or ["<none>"],
                                      "size": i["size"]})
                out["reclaimable"] += i["size"]
        if "volumes" in types:
            for v in docker_volumes():
                if not v["used_by"] and not v["refs"]:
                    out["volumes"].append({"name": v["name"],
                                           "size": max(0, v["size"])})
                    out["reclaimable"] += max(0, v["size"])
        if "networks" in types:
            for n in docker_networks():
                if not n["builtin"] and not n["containers"]:
                    out["networks"].append({"name": n["name"], "id": n["short_id"],
                                            "driver": n["driver"]})
        if "build-cache" in types:
            df = docker_df()
            bc = (df or {}).get("build_cache") or {}
            out["build_cache"] = {"count": bc.get("count", 0),
                                  "reclaimable": bc.get("reclaimable", 0)}
            out["reclaimable"] += bc.get("reclaimable", 0)
        return out
    except Exception as e:
        return {"error": str(e)}


def docker_prune(types, images_all=False):
    """Aufräumen ausführen. Der eigene Container ist nie betroffen (er läuft)."""
    types = [t for t in (types or []) if t in _PRUNE_TYPES]
    if not types:
        return {"error": "Keine gültigen Aufräum-Typen gewählt"}
    result, errors = {}, []
    try:
        if "containers" in types:
            st, r = _docker_api("POST", "/containers/prune")
            if st == 200:
                result["containers"] = {"deleted": len(r.get("ContainersDeleted") or []),
                                        "reclaimed": r.get("SpaceReclaimed", 0)}
            else:
                errors.append("Container: HTTP %d" % st)
        if "images" in types:
            # dangling=false räumt ALLE ungenutzten Images ab, nicht nur
            # namenlose — bewusst nur auf ausdrücklichen Wunsch.
            f = '{"dangling":["false"]}' if images_all else '{"dangling":["true"]}'
            from urllib.parse import quote
            st, r = _docker_api("POST", f"/images/prune?filters={quote(f, safe='')}")
            if st == 200:
                result["images"] = {"deleted": len(r.get("ImagesDeleted") or []),
                                    "reclaimed": r.get("SpaceReclaimed", 0)}
            else:
                errors.append("Images: HTTP %d" % st)
        if "volumes" in types:
            st, r = _docker_api("POST", "/volumes/prune")
            if st == 200:
                result["volumes"] = {"deleted": len(r.get("VolumesDeleted") or []),
                                     "reclaimed": r.get("SpaceReclaimed", 0)}
            else:
                errors.append("Volumes: HTTP %d" % st)
        if "networks" in types:
            st, r = _docker_api("POST", "/networks/prune")
            if st == 200:
                result["networks"] = {"deleted": len(r.get("NetworksDeleted") or []),
                                      "reclaimed": 0}
            else:
                errors.append("Netzwerke: HTTP %d" % st)
        if "build-cache" in types:
            st, r = _docker_api("POST", "/build/prune")
            if st == 200:
                result["build_cache"] = {"deleted": len(r.get("CachesDeleted") or []),
                                         "reclaimed": r.get("SpaceReclaimed", 0)}
            else:
                errors.append("Build-Cache: HTTP %d" % st)
        total = sum(v.get("reclaimed", 0) for v in result.values())
        out = {"success": not errors, "result": result, "reclaimed": total}
        if errors:
            out["error"] = "; ".join(errors)
        return out
    except Exception as e:
        return {"error": str(e)}


# ─── Container → Image, Dateien ──────────────────────────────────────────────

def docker_container_commit(cid, repo, tag="latest", message="", author="",
                            pause=True):
    """Laufenden Container als neues Image festschreiben."""
    if not _valid_id(cid):
        return {"error": "Ungültige Container-Kennung"}
    repo = (repo or "").strip()
    tag  = (tag or "latest").strip()
    if not _valid_image_ref(repo) or ":" in repo:
        return {"error": "Ungültiger Repository-Name (ohne Tag angeben)"}
    if not re.match(r'^[A-Za-z0-9_.-]{1,128}$', tag):
        return {"error": "Ungültiger Tag"}
    if len(message) > 512 or len(author) > 128:
        return {"error": "Nachricht oder Autor zu lang"}
    try:
        from urllib.parse import quote
        q = (f"?container={quote(_clean(cid), safe='')}"
             f"&repo={quote(repo, safe='/')}&tag={quote(tag, safe='')}"
             f"&pause={'1' if pause else '0'}")
        if message:
            q += f"&comment={quote(message, safe='')}"
        if author:
            q += f"&author={quote(author, safe='')}"
        status, resp = _docker_api("POST", f"/commit{q}")
        if status in (200, 201):
            return {"success": True, "id": (resp.get("Id") or "")[:19],
                    "ref": f"{repo}:{tag}"}
        if status == 404:
            return {"error": "Container nicht gefunden"}
        return {"error": resp.get("message", f"Docker-Fehler (HTTP {status})")}
    except Exception as e:
        return {"error": str(e)}


def docker_archive_open(cid, path):
    """Pfad im Container als Tar-Strom öffnen. Liefert (conn, resp)."""
    if not _valid_id(cid):
        raise RuntimeError("Ungültige Container-Kennung")
    path = (path or "").strip()
    if not path.startswith("/") or len(path) > 512 or "\x00" in path:
        raise RuntimeError("Pfad muss im Container absolut sein")
    from urllib.parse import quote
    conn, resp = _docker_stream(
        "GET", f"/containers/{_clean(cid)}/archive?path={quote(path, safe='')}")
    if resp.status == 404:
        _docker_stream_close(conn)
        # 404 deckt beides ab — nachsehen, was tatsächlich fehlt.
        try:
            st, _ = _docker_api("GET", f"/containers/{_clean(cid)}/json")
            if st == 404:
                raise RuntimeError("Container nicht gefunden")
        except RuntimeError:
            raise
        except Exception:
            pass
        raise RuntimeError("Pfad im Container nicht gefunden")
    if resp.status != 200:
        _docker_stream_close(conn)
        raise RuntimeError(f"Export fehlgeschlagen (HTTP {resp.status})")
    return conn, resp


def docker_archive_put(cid, path, name, data_b64):
    """Eine Datei in den Container legen.

    Der Inhalt kommt Base64-kodiert und wird hier zu einem Ein-Datei-Tar
    zusammengesetzt — die Docker-API nimmt an dieser Stelle nur Tar entgegen."""
    import io, tarfile
    if not _valid_id(cid):
        return {"error": "Ungültige Container-Kennung"}
    blocked = _protect(cid)
    if blocked:
        return blocked
    path = (path or "").strip()
    if not path.startswith("/") or len(path) > 512 or "\x00" in path:
        return {"error": "Zielpfad muss im Container absolut sein"}
    name = (name or "").strip()
    if not re.match(r'^[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}$', name):
        return {"error": "Ungültiger Dateiname (nur A-Z a-z 0-9 . _ + -)"}
    try:
        raw = base64.b64decode(data_b64 or "", validate=True)
    except Exception:
        return {"error": "Dateiinhalt ist kein gültiges Base64"}
    if len(raw) > 7 * 1024 * 1024:
        return {"error": "Datei zu groß (max. 7 MB)"}
    try:
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w") as tf:
            info = tarfile.TarInfo(name=name)
            info.size = len(raw)
            info.mtime = int(time.time())
            info.mode = 0o644
            tf.addfile(info, io.BytesIO(raw))
        payload = buf.getvalue()

        from urllib.parse import quote
        conn = _UnixSocketHTTPConnection()
        try:
            conn.request("PUT",
                         f"/containers/{_clean(cid)}/archive?path={quote(path, safe='')}",
                         body=payload,
                         headers={"Host": "localhost",
                                  "Content-Type": "application/x-tar",
                                  "Content-Length": str(len(payload))})
            resp = conn.getresponse()
            body = resp.read()
            if resp.status in (200, 204):
                return {"success": True, "bytes": len(raw)}
            if resp.status == 404:
                return {"error": "Zielverzeichnis im Container nicht gefunden"}
            try:
                msg = json.loads(body).get("message", "")
            except Exception:
                msg = ""
            return {"error": msg or f"Docker-Fehler (HTTP {resp.status})"}
        finally:
            try:
                conn.close()
            except Exception:
                pass
    except Exception as e:
        return {"error": str(e)}


# ─── Compose-Stacks ──────────────────────────────────────────────────────────

def docker_stacks():
    """Container nach `com.docker.compose.project` gruppieren."""
    try:
        groups = {}
        for c in docker_containers(all_=True):
            proj = c.get("project", "")
            if not proj:
                continue
            g = groups.setdefault(proj, {"project": proj, "containers": [],
                                         "running": 0, "total": 0,
                                         "config_file": "", "workdir": ""})
            g["containers"].append({
                "id": c["id"], "short_id": c["short_id"], "name": c["name"],
                "service": c["service"], "state": c["state"], "status": c["status"],
                "image": c["image"], "health": c["health"],
                "protected": c["protected"], "critical": c["critical"],
            })
            g["total"] += 1
            if c["state"] == "running":
                g["running"] += 1
        # Compose-Datei aus den Labels des ersten Containers je Projekt ziehen
        try:
            st, cs = _docker_api("GET", "/containers/json?all=true")
            if st == 200:
                for c in cs or []:
                    lb = c.get("Labels") or {}
                    p  = lb.get("com.docker.compose.project", "")
                    if p in groups and not groups[p]["config_file"]:
                        groups[p]["config_file"] = lb.get(
                            "com.docker.compose.project.config_files", "")
                        groups[p]["workdir"] = lb.get(
                            "com.docker.compose.project.working_dir", "")
        except Exception:
            pass
        out = list(groups.values())
        for g in out:
            g["containers"].sort(key=lambda x: x["service"] or x["name"])
        out.sort(key=lambda x: x["project"])
        return out
    except Exception:
        return []


def docker_stack_compose(project):
    """Compose-Datei eines Stacks lesen.

    Der Container sieht das Host-Dateisystem nicht — der Pfad wird deshalb über
    `nsenter` im Mount-Namespace des Wirts gelesen."""
    if not _PROJECT_RE.match(project or ""):
        return {"error": "Ungültiger Projektname"}
    path = ""
    for s in docker_stacks():
        if s["project"] == project:
            path = (s.get("config_file") or "").split(",")[0].strip()
            break
    if not path:
        return {"error": "Keine Compose-Datei zu diesem Stack hinterlegt"}
    err = _path_denied(path)
    if err:
        return err
    try:
        r = subprocess.run(_ns(["cat", path]), capture_output=True, timeout=10)
        if r.returncode != 0:
            return {"error": "Compose-Datei nicht lesbar", "path": path}
        data = r.stdout[:256 * 1024]
        return {"file": data.decode("utf-8", errors="replace"), "path": path}
    except Exception as e:
        return {"error": str(e), "path": path}


# Zweige, die weder als Build-Kontext noch als Lesepfad taugen. `/etc` und
# `/root` stehen bewusst dabei: ein Build-Kontext wird vollständig eingepackt,
# `/etc` würde also `shadow` in ein Image schreiben.
_DENIED_ROOTS = ("/proc", "/sys", "/dev", "/boot", "/etc", "/root",
                 "/run", "/var/run", "/var/lib/docker")


def _norm_path(path):
    """Pfad normalisieren — inklusive führender Mehrfach-Slashes.

    `os.path.normpath("//etc")` liefert nach POSIX `"//etc"` (genau zwei
    führende Slashes bleiben erhalten). Ein Präfixvergleich gegen `/etc` läuft
    damit ins Leere — deshalb werden sie hier vorher zusammengefasst."""
    p = re.sub(r'^/+', '/', path or "")
    return os.path.normpath(p)


def _real_host_path(path):
    """Pfad im Mount-Namespace des Wirts auflösen, Symlinks inklusive.

    Der Container sieht das Host-Dateisystem nicht, `os.path.realpath` liefe
    also ins Leere. `realpath -m` funktioniert auch für noch nicht existierende
    Pfade."""
    try:
        r = subprocess.run(_ns(["realpath", "-m", "--", path]),
                           capture_output=True, text=True, timeout=10)
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip()
    except Exception:
        pass
    return ""


def _path_denied(path):
    """Pfad-Sicherheitsprüfung (absolut, ohne Systemzweige, symlinkfest).

    Geprüft wird sowohl der geschriebene als auch der **tatsächlich
    aufgelöste** Pfad. Ohne die Auflösung genügte ein Symlink an erlaubter
    Stelle (`/tmp/x -> /etc`), um `/etc/shadow` in einen Build-Kontext und
    damit in ein Image zu bekommen — `normpath` folgt Symlinks nicht."""
    if not path or not os.path.isabs(path):
        return {"error": "Pfad muss absolut sein"}
    kandidaten = [_norm_path(path)]
    real = _real_host_path(path)
    if real:
        rn = _norm_path(real)
        if rn not in kandidaten:
            kandidaten.append(rn)
    for p in kandidaten:
        if p == "/":
            return {"error": "Das Wurzelverzeichnis ist nicht erlaubt"}
        for root in _DENIED_ROOTS:
            if p == root or p.startswith(root + "/"):
                hinweis = ""
                if p != kandidaten[0]:
                    hinweis = f" — der Pfad zeigt (über einen Symlink) auf {p}"
                return {"error": f"Pfad nicht erlaubt (Systemzweig {root})"
                                 f"{hinweis}"}
    return None


# ─── System ──────────────────────────────────────────────────────────────────

def docker_system():
    """Version und Eckdaten der Engine, plus Version dieses Reiters."""
    out = {"tab_version": DOCKER_TAB_VERSION}
    try:
        status, v = _docker_api("GET", "/version")
        out["version"] = {
            "version":     v.get("Version", ""),
            "api":         v.get("ApiVersion", ""),
            "min_api":     v.get("MinAPIVersion", ""),
            "os":          v.get("Os", ""),
            "arch":        v.get("Arch", ""),
            "kernel":      v.get("KernelVersion", ""),
            "go":          v.get("GoVersion", ""),
            "build_time":  v.get("BuildTime", ""),
            "platform":    (v.get("Platform") or {}).get("Name", ""),
        } if status == 200 else {}
    except Exception:
        out["version"] = {}
    try:
        status, i = _docker_api("GET", "/info")
        out["info"] = {
            "name":            i.get("Name", ""),
            "server_version":  i.get("ServerVersion", ""),
            "containers":      i.get("Containers", 0),
            "running":         i.get("ContainersRunning", 0),
            "paused":          i.get("ContainersPaused", 0),
            "stopped":         i.get("ContainersStopped", 0),
            "images":          i.get("Images", 0),
            "driver":          i.get("Driver", ""),
            "cgroup_driver":   i.get("CgroupDriver", ""),
            "cgroup_version":  i.get("CgroupVersion", ""),
            "logging_driver":  i.get("LoggingDriver", ""),
            "ncpu":            i.get("NCPU", 0),
            "mem_total":       i.get("MemTotal", 0),
            "docker_root":     i.get("DockerRootDir", ""),
            "kernel":          i.get("KernelVersion", ""),
            "os":              i.get("OperatingSystem", ""),
            "live_restore":    bool(i.get("LiveRestoreEnabled")),
            "warnings":        i.get("Warnings") or [],
        } if status == 200 else {}
    except Exception:
        out["info"] = {}
    return out


def docker_df():
    """Speicherbelegung — nur Aggregate.

    Die `Items`-Listen von `/system/df` sind auf diesem Host über 1 MB groß
    (allein 1074 Build-Cache-Einträge); sie werden bewusst nicht ausgeliefert."""
    out = {}
    try:
        status, d = _docker_api("GET", "/system/df")
        if status != 200:
            return {"error": "Speicherbelegung nicht verfügbar"}

        def _agg(items, size_key="Size"):
            total = sum(int(x.get(size_key, 0) or 0) for x in items or [])
            return total

        imgs = d.get("Images") or []
        cons = d.get("Containers") or []
        vols = d.get("Volumes") or []
        bc   = d.get("BuildCache") or []
        img_active = sum(1 for x in imgs if int(x.get("Containers", 0) or 0) > 0)
        img_recl   = sum(int(x.get("Size", 0) or 0) for x in imgs
                         if int(x.get("Containers", 0) or 0) <= 0)
        vol_recl   = sum(int((x.get("UsageData") or {}).get("Size", 0) or 0)
                         for x in vols
                         if int((x.get("UsageData") or {}).get("RefCount", 0) or 0) <= 0)
        con_size   = sum(int(x.get("SizeRw", 0) or 0) for x in cons)
        con_recl   = sum(int(x.get("SizeRw", 0) or 0) for x in cons
                         if x.get("State") != "running")
        bc_recl    = sum(int(x.get("Size", 0) or 0) for x in bc
                         if not x.get("InUse"))
        out = {
            "layers_size": d.get("LayersSize", 0),
            "images":      {"count": len(imgs), "active": img_active,
                            "size": _agg(imgs), "reclaimable": img_recl},
            "containers":  {"count": len(cons),
                            "active": sum(1 for x in cons if x.get("State") == "running"),
                            "size": con_size, "reclaimable": con_recl},
            "volumes":     {"count": len(vols),
                            "active": sum(1 for x in vols
                                          if int((x.get("UsageData") or {})
                                                 .get("RefCount", 0) or 0) > 0),
                            "size": _agg([{"Size": (x.get("UsageData") or {}).get("Size", 0)}
                                          for x in vols]),
                            "reclaimable": vol_recl},
            "build_cache": {"count": len(bc),
                            "active": sum(1 for x in bc if x.get("InUse")),
                            "size": _agg(bc), "reclaimable": bc_recl},
        }
        return out
    except Exception as e:
        return {"error": str(e)}


# ─── Obergrenzen für offene Streams ──────────────────────────────────────────
# Jeder Log- oder Konsolen-Stream belegt eine Docker-Socket-Verbindung und zwei
# Threads. Ohne Deckel könnte eine Reload-Schleife im Browser hunderte davon
# öffnen; diese Zähler machen daraus eine verständliche Fehlermeldung.

MAX_LOG_WS  = 8
MAX_EXEC_WS = 4

_ws_counts = {"log": 0, "exec": 0}
_ws_count_lock = threading.Lock()


def _ws_slot_take(kind):
    """Platz für einen Stream belegen. False, wenn die Obergrenze erreicht ist."""
    cap = MAX_LOG_WS if kind == "log" else MAX_EXEC_WS
    with _ws_count_lock:
        if _ws_counts.get(kind, 0) >= cap:
            return False
        _ws_counts[kind] = _ws_counts.get(kind, 0) + 1
        return True


def _ws_slot_free(kind):
    with _ws_count_lock:
        _ws_counts[kind] = max(0, _ws_counts.get(kind, 0) - 1)


def docker_logs_open(cid, tail=200, timestamps=False, since=0, follow=True):
    """Log-Stream öffnen. Liefert (conn, resp) oder wirft RuntimeError."""
    if not _valid_id(cid):
        raise RuntimeError("Ungültige Container-Kennung")
    # tail=0 heißt „keine Rückschau" — vorher wurde auf 1 hochgeklemmt.
    if tail is None or tail == "":
        tail = 200
    try:
        tail = max(0, min(int(tail), 10000))
    except (TypeError, ValueError):
        tail = 200
    try:
        since = max(0, int(since or 0))
    except (TypeError, ValueError):
        since = 0
    path = (f"/containers/{_clean(cid)}/logs?stdout=1&stderr=1"
            f"&follow={'1' if follow else '0'}&tail={tail}"
            f"&timestamps={'1' if timestamps else '0'}&since={since}")
    conn, resp = _docker_stream("GET", path)
    if resp.status == 404:
        _docker_stream_close(conn)
        raise RuntimeError("Container nicht gefunden")
    if resp.status not in (200, 101):
        _docker_stream_close(conn)
        raise RuntimeError(f"Logs nicht verfügbar (HTTP {resp.status})")
    return conn, resp


_EXEC_SHELLS = ("sh", "bash", "ash", "zsh", "fish")


def docker_exec_open(cid, shell="sh", user="", workdir=""):
    """Interaktive Shell im Container starten.

    Liefert (exec_id, sock, leftover). Der Aufrufer schiebt `leftover` als
    Erstes an den Browser und pumpt danach beide Richtungen."""
    if not _valid_id(cid):
        raise RuntimeError("Ungültige Container-Kennung")
    shell = (shell or "sh").strip()
    if shell not in _EXEC_SHELLS:
        raise RuntimeError(f"Unerlaubte Shell: {shell}")
    if user and not re.match(r'^[A-Za-z0-9_.:-]{1,64}$', user):
        raise RuntimeError("Ungültiger Benutzer")
    if workdir and not (workdir.startswith("/") and len(workdir) <= 512
                        and "\x00" not in workdir):
        raise RuntimeError("Ungültiges Arbeitsverzeichnis")

    body = {
        "AttachStdin": True, "AttachStdout": True, "AttachStderr": True,
        "Tty": True, "Cmd": [shell],
        "Env": ["TERM=xterm-256color"],
    }
    if user:
        body["User"] = user
    if workdir:
        body["WorkingDir"] = workdir

    status, resp = _docker_api("POST", f"/containers/{_clean(cid)}/exec", body)
    if status == 404:
        raise RuntimeError("Container nicht gefunden")
    if status == 409:
        raise RuntimeError("Container läuft nicht — Konsole nicht möglich.")
    if status not in (200, 201):
        raise RuntimeError(resp.get("message", f"Exec-Fehler (HTTP {status})"))
    eid = resp.get("Id", "")
    if not eid:
        raise RuntimeError("Exec-Id fehlt in der Antwort")

    try:
        sock, leftover, _raw = _docker_hijack(f"/exec/{eid}/start",
                                              {"Detach": False, "Tty": True})
    except RuntimeError as e:
        # Docker meldet hier englischen OCI-Rohtext — in der sonst deutschen
        # Oberfläche wirkt das wie ein Absturz.
        m = str(e).lower()
        if "executable file not found" in m or "no such file" in m:
            raise RuntimeError(f"Die Shell „{shell}“ ist in diesem Container "
                               "nicht vorhanden — bitte eine andere wählen "
                               "(z. B. sh).")
        if "no such directory" in m or "chdir" in m:
            raise RuntimeError(f"Das Arbeitsverzeichnis „{workdir}“ existiert "
                               "im Container nicht.")
        if "unable to find user" in m:
            raise RuntimeError(f"Der Benutzer „{user}“ existiert im Container nicht.")
        raise
    return eid, sock, leftover


def docker_exec_message_de(raw, shell="", workdir="", user=""):
    """OCI-Fehlertexte im Exec-Strom eindeutschen.

    Docker liefert diese Fehler nicht als HTTP-Status, sondern als erste
    Nutzdaten des Streams — abfangen lässt sich das nur beim Durchreichen."""
    try:
        txt = raw.decode("utf-8", errors="replace")
    except Exception:
        return None
    if "OCI runtime exec failed" not in txt and "exec failed" not in txt:
        return None
    low = txt.lower()
    if "executable file not found" in low or "no such file or directory" in low:
        msg = (f"Die Shell „{shell}“ ist in diesem Container nicht vorhanden. "
               "Bitte eine andere wählen — „sh“ gibt es praktisch überall.")
    elif "no such directory" in low or "chdir" in low:
        msg = f"Das Arbeitsverzeichnis „{workdir}“ existiert im Container nicht."
    elif "unable to find user" in low:
        msg = f"Der Benutzer „{user}“ existiert im Container nicht."
    else:
        msg = "Die Shell konnte im Container nicht gestartet werden."
    return ("\r\n" + msg + "\r\n").encode("utf-8")


def docker_exec_cleanup(eid):
    """Nach dem Trennen die Shell im Zielcontainer beenden.

    Docker beendet einen Exec-Prozess NICHT, wenn die Verbindung abreißt. Ohne
    das hier bliebe bei jeder Konsole, die nicht ausdrücklich mit `exit`
    verlassen wird, dauerhaft eine Shell im Container zurück — und die
    Oberfläche trennt beim Tab-Wechsel nun einmal die Verbindung, statt `exit`
    zu tippen. Der Dashboard-Container läuft mit `pid: host`, die von Docker
    gemeldete Pid ist deshalb direkt adressierbar."""
    if not re.match(r'^[a-f0-9]{16,128}$', eid or ""):
        return
    try:
        st, d = _docker_api("GET", f"/exec/{eid}/json")
        if st != 200 or not d.get("Running"):
            return
        pid = int(d.get("Pid") or 0)
    except Exception:
        return
    if pid <= 1:
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError, OSError):
        return
    for _ in range(6):
        time.sleep(0.1)
        try:
            st, d = _docker_api("GET", f"/exec/{eid}/json")
            if st != 200 or not d.get("Running"):
                return
        except Exception:
            return
    try:
        os.kill(pid, signal.SIGKILL)
    except Exception:
        pass


def docker_exec_resize(eid, rows, cols):
    """Fenstergröße der laufenden Exec-Sitzung nachziehen."""
    if not re.match(r'^[a-f0-9]{16,128}$', eid or ""):
        return
    try:
        rows = max(2, min(int(rows), 200))
        cols = max(10, min(int(cols), 500))
    except (TypeError, ValueError):
        return
    try:
        _docker_api("POST", f"/exec/{eid}/resize?h={rows}&w={cols}")
    except Exception:
        pass


# ─── Live-Statistik ──────────────────────────────────────────────────────────
# `/stats?stream=false` misst zweimal und braucht dadurch ~1 s PRO Container —
# bei 25 Containern also 25 s für eine Liste. Mit `one-shot=true` antwortet
# Docker in ~2 ms, liefert dafür aber kein `precpu_stats.system_cpu_usage`.
# Deshalb hält dieser Sampler das vorige Sample selbst und rechnet die Deltas.
# Es läuft genau EIN Thread für den ganzen Prozess (alle Browser-Tabs teilen
# ihn), und er beendet sich von selbst, wenn eine Weile niemand mehr fragt —
# so bleibt beim Verlassen des Reiters nichts zurück.

_SAMPLE_INTERVAL  = 2.0
_SAMPLE_IDLE_STOP = 15.0


class _StatsSampler:
    def __init__(self):
        self._lock     = threading.Lock()
        self._prev     = {}     # cid -> Rohzähler des letzten Durchlaufs
        self._table    = {}     # cid -> fertig berechnete Werte fürs Frontend
        self._last_req = 0.0
        self._running  = False

    def touch(self):
        """Sampler bei Bedarf starten und die Leerlauf-Uhr zurücksetzen."""
        with self._lock:
            self._last_req = time.monotonic()
            if self._running:
                return
            self._running = True
        threading.Thread(target=self._loop, daemon=True).start()

    def table(self):
        """Aktuellen Messwert-Schnappschuss liefern (blockiert nie)."""
        self.touch()
        with self._lock:
            return dict(self._table)

    def _loop(self):
        try:
            while True:
                with self._lock:
                    idle = time.monotonic() - self._last_req
                if idle > _SAMPLE_IDLE_STOP:
                    with self._lock:
                        self._prev.clear()
                        self._table.clear()
                    return
                try:
                    self._tick()
                except Exception:
                    pass
                time.sleep(_SAMPLE_INTERVAL)
        finally:
            with self._lock:
                self._running = False

    def _tick(self):
        try:
            status, cs = _docker_api("GET", "/containers/json?all=false")
        except Exception:
            return
        if status != 200 or not isinstance(cs, list):
            return
        now  = time.monotonic()
        live = set()
        for c in cs:
            cid = c.get("Id", "")
            if not cid:
                continue
            live.add(cid)
            try:
                st, d = _docker_api(
                    "GET", f"/containers/{cid}/stats?stream=false&one-shot=true")
            except Exception:
                continue
            if st != 200 or not isinstance(d, dict):
                continue
            try:
                self._compute(cid, d, now)
            except Exception:
                continue
        with self._lock:
            for gone in [k for k in self._prev if k not in live]:
                self._prev.pop(gone, None)
                self._table.pop(gone, None)

    def _compute(self, cid, d, now):
        cpu  = d.get("cpu_stats") or {}
        mem  = d.get("memory_stats") or {}
        blk  = d.get("blkio_stats") or {}
        nets = d.get("networks") or {}

        cpu_total = ((cpu.get("cpu_usage") or {}).get("total_usage") or 0)
        cpu_sys   = cpu.get("system_cpu_usage") or 0
        online    = cpu.get("online_cpus") or 1

        rx = sum((n or {}).get("rx_bytes", 0) for n in nets.values())
        tx = sum((n or {}).get("tx_bytes", 0) for n in nets.values())
        br = bw = 0
        for e in (blk.get("io_service_bytes_recursive") or []):
            op = str(e.get("op", "")).lower()
            if op == "read":
                br += e.get("value", 0)
            elif op == "write":
                bw += e.get("value", 0)

        # cgroup v2: `usage` enthält den Page-Cache. `inactive_file` abzuziehen
        # entspricht dem, was `docker stats` als Speicherverbrauch anzeigt.
        stats    = mem.get("stats") or {}
        mem_used = max(0, (mem.get("usage") or 0)
                       - (stats.get("inactive_file") or stats.get("total_inactive_file") or 0))
        mem_lim  = mem.get("limit") or 0

        with self._lock:
            prev = self._prev.get(cid)
            cpu_pct = rx_rate = tx_rate = 0.0
            if prev:
                dt = now - prev["ts"]
                cd = cpu_total - prev["cpu_total"]
                sd = cpu_sys - prev["cpu_sys"]
                if sd > 0 and cd >= 0:
                    cpu_pct = (cd / sd) * online * 100.0
                if dt > 0:
                    rx_rate = max(0, rx - prev["rx"]) / dt
                    tx_rate = max(0, tx - prev["tx"]) / dt
            self._prev[cid] = {"ts": now, "cpu_total": cpu_total,
                               "cpu_sys": cpu_sys, "rx": rx, "tx": tx}
            self._table[cid] = {
                "cpu_pct":  round(min(cpu_pct, online * 100.0), 2),
                "cpus":     online,
                "mem_used": mem_used,
                "mem_limit": mem_lim,
                "mem_pct":  round(mem_used / mem_lim * 100.0, 2) if mem_lim else 0.0,
                "net_rx":   rx, "net_tx": tx,
                "net_rx_rate": round(rx_rate), "net_tx_rate": round(tx_rate),
                "blk_read": br, "blk_write": bw,
                "pids":     (d.get("pids_stats") or {}).get("current", 0),
                "warm":     bool(prev),
            }


_stats_sampler = _StatsSampler()


def docker_stats():
    """Messwerte aller laufenden Container aus dem Sampler-Cache."""
    try:
        return {"stats": _stats_sampler.table(), "interval": _SAMPLE_INTERVAL}
    except Exception as e:
        return {"error": str(e), "stats": {}}


# ─── Ereignis-Strom ──────────────────────────────────────────────────────────
# Ein einziger Leser-Thread hängt an `/events` und legt die Ereignisse in einen
# Ringpuffer. Die Oberfläche pollt `?since=<seq>` — so braucht kein Browser-Tab
# eine eigene Docker-Socket-Verbindung, und ein geschlossener Tab hinterlässt
# nichts.

_EVENT_MAX      = 500
_EVENT_IDLE_STOP = 60.0


class _EventRing:
    def __init__(self):
        self._lock     = threading.Lock()
        self._events   = []
        self._seq      = 0
        self._last_req = 0.0
        self._running  = False
        self._conn     = None

    def touch(self):
        with self._lock:
            self._last_req = time.monotonic()
            if self._running:
                return
            self._running = True
        threading.Thread(target=self._loop, daemon=True).start()

    def since(self, seq):
        """Alle Ereignisse neuer als `seq` (0 = die letzten 50)."""
        self.touch()
        with self._lock:
            if seq <= 0:
                out = self._events[-50:]
            else:
                out = [e for e in self._events if e["seq"] > seq]
            return {"events": out, "seq": self._seq}

    def _loop(self):
        backoff = 1.0
        try:
            while True:
                with self._lock:
                    idle = time.monotonic() - self._last_req
                if idle > _EVENT_IDLE_STOP:
                    return
                conn = None
                try:
                    since = int(time.time()) - 60
                    conn, resp = _docker_stream(
                        "GET", f"/events?since={since}")
                    with self._lock:
                        self._conn = conn
                    if resp.status != 200:
                        raise RuntimeError(f"HTTP {resp.status}")
                    backoff = 1.0
                    # `resp.readline()` blockiert. Auf einem ruhigen Docker-
                    # Daemon (keine Ereignisse) käme die Leerlaufprüfung nie
                    # wieder dran und der Thread liefe ewig weiter. Deshalb
                    # weckt ein Wachhund den Leser durch Schließen des Sockets.
                    def _wachhund(c=conn):
                        while True:
                            time.sleep(5)
                            with self._lock:
                                if time.monotonic() - self._last_req > _EVENT_IDLE_STOP:
                                    break
                                if self._conn is not c:
                                    return
                        _docker_stream_close(c)
                    threading.Thread(target=_wachhund, daemon=True).start()
                    while True:
                        with self._lock:
                            if time.monotonic() - self._last_req > _EVENT_IDLE_STOP:
                                break
                        line = resp.readline()
                        if not line:
                            break
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            self._add(json.loads(line))
                        except Exception:
                            continue
                except Exception:
                    time.sleep(backoff)
                    backoff = min(backoff * 2, 30.0)
                finally:
                    with self._lock:
                        self._conn = None
                    if conn is not None:
                        _docker_stream_close(conn)
        finally:
            with self._lock:
                self._running = False

    def _add(self, ev):
        attrs = (ev.get("Actor") or {}).get("Attributes") or {}
        name  = attrs.get("name", "") or (ev.get("Actor") or {}).get("ID", "")[:12]
        with self._lock:
            self._seq += 1
            self._events.append({
                "seq":    self._seq,
                "type":   ev.get("Type", ""),
                "action": str(ev.get("Action", "")).split(":")[0],
                "name":   name,
                "id":     (ev.get("Actor") or {}).get("ID", "")[:12],
                "image":  attrs.get("image", ""),
                "time":   ev.get("time", 0),
            })
            if len(self._events) > _EVENT_MAX:
                del self._events[:len(self._events) - _EVENT_MAX]


_event_ring = _EventRing()


def docker_events(since=0):
    """Ereignisse seit der angegebenen Sequenznummer."""
    try:
        since = max(0, int(since or 0))
    except (TypeError, ValueError):
        since = 0
    try:
        return _event_ring.since(since)
    except Exception as e:
        return {"error": str(e), "events": [], "seq": 0}


# ─── Hintergrund-Aufträge (Pull / Build) ─────────────────────────────────────
# Nach dem Muster von `iso_download` in storage.py: der Auftrag läuft in einem
# eigenen Thread weiter, die Oberfläche pollt den Zustand. Bewusst KEIN
# WebSocket — ein Pull darf nicht abbrechen, nur weil jemand den Reiter
# wechselt oder das Handy sperrt.

_jobs      = {}
_jobs_lock = threading.Lock()
_JOB_TTL   = 600.0        # abgeschlossene Aufträge nach 10 min vergessen
_JOB_LOG_MAX = 400        # Zeilen je Auftrag


def _job_new(kind, title):
    jid = secrets.token_urlsafe(8)
    with _jobs_lock:
        _jobs[jid] = {"id": jid, "kind": kind, "title": title,
                      "status": "running", "log": [], "layers": {},
                      "error": "", "result": "", "started": time.time(),
                      "finished": 0.0}
    return jid


def _job_log(jid, line):
    with _jobs_lock:
        j = _jobs.get(jid)
        if not j:
            return
        j["log"].append(line)
        if len(j["log"]) > _JOB_LOG_MAX:
            del j["log"][:len(j["log"]) - _JOB_LOG_MAX]


def _job_done(jid, error="", result=""):
    with _jobs_lock:
        j = _jobs.get(jid)
        if not j:
            return
        j["status"] = "error" if error else "done"
        j["error"] = error
        j["result"] = result
        j["finished"] = time.time()


def _job_reap():
    now = time.time()
    with _jobs_lock:
        for k in [k for k, v in _jobs.items()
                  if v["finished"] and now - v["finished"] > _JOB_TTL]:
            _jobs.pop(k, None)


def docker_job(jid):
    """Zustand eines Auftrags."""
    _job_reap()
    with _jobs_lock:
        j = _jobs.get(jid)
        if not j:
            return {"error": "Auftrag nicht gefunden (oder bereits verfallen)"}
        layers = list(j["layers"].values())
        done_l = sum(1 for l in layers if l.get("done"))
        return {"job": {
            "id": j["id"], "kind": j["kind"], "title": j["title"],
            "status": j["status"], "error": j["error"], "result": j["result"],
            "log": list(j["log"])[-120:],
            "layers": layers[:40],
            "layers_total": len(layers), "layers_done": done_l,
            "started": j["started"], "finished": j["finished"],
        }}


def docker_jobs():
    """Kurzübersicht aller bekannten Aufträge."""
    _job_reap()
    with _jobs_lock:
        return [{"id": j["id"], "kind": j["kind"], "title": j["title"],
                 "status": j["status"], "error": j["error"],
                 "started": j["started"], "finished": j["finished"]}
                for j in sorted(_jobs.values(), key=lambda x: -x["started"])]


def docker_image_pull(repo, tag="latest"):
    """Image herunterladen — läuft im Hintergrund weiter."""
    repo = (repo or "").strip()
    # „nginx:1.25“ in einem Feld ist die übliche Schreibweise; hier auftrennen.
    if ":" in repo and "@" not in repo:
        head, _, maybe_tag = repo.rpartition(":")
        if "/" not in maybe_tag:
            repo, tag = head, maybe_tag
    tag = (tag or "latest").strip()
    if not _valid_image_ref(repo):
        return {"error": "Ungültige Image-Referenz"}
    if not re.match(r'^[A-Za-z0-9_.-]{1,128}$', tag):
        return {"error": "Ungültiger Tag"}

    jid = _job_new("pull", f"{repo}:{tag}")

    def _run():
        from urllib.parse import quote
        try:
            path = f"/images/create?fromImage={quote(repo, safe='/')}&tag={quote(tag, safe='')}"
            got_error = ""
            for ev in _docker_json_stream("POST", path):
                if ev.get("error"):
                    got_error = str(ev["error"])
                    break
                lid = ev.get("id", "")
                st  = ev.get("status", "")
                pd  = ev.get("progressDetail") or {}
                # „Pulling from library/x" trägt den TAG als id, keine Schicht —
                # sonst entsteht eine Phantomschicht, die nie fertig wird und
                # den Fortschritt bei 0 % festhält.
                if st.startswith("Pulling from") or st.startswith("Digest:") \
                        or st.startswith("Status:"):
                    lid = ""
                if lid:
                    with _jobs_lock:
                        j = _jobs.get(jid)
                        if j is not None:
                            j["layers"][lid] = {
                                "id": lid, "status": st,
                                "current": pd.get("current", 0),
                                "total": pd.get("total", 0),
                                "done": st in ("Download complete", "Pull complete",
                                               "Already exists", "Verifying Checksum"),
                            }
                elif st:
                    _job_log(jid, st)
            _job_done(jid, error=got_error,
                      result="" if got_error else f"{repo}:{tag}")
        except Exception as e:
            _job_done(jid, error=str(e))

    threading.Thread(target=_run, daemon=True).start()
    return {"success": True, "job": jid}


def docker_image_build(context, tag, dockerfile="Dockerfile", nocache=False,
                       buildargs=None):
    """Image aus einem Dockerfile bauen.

    Der Build-Kontext liegt auf dem WIRT — der Container sieht dessen
    Dateisystem nicht. Deshalb packt `nsenter … tar` im Mount-Namespace des
    Wirts und der Tar-Strom wandert als Request-Body an `/build`.
    `context` ist ein argv-Element, niemals ein Shell-String."""
    context = (context or "").strip()
    err = _path_denied(context)
    if err:
        return err
    if not re.match(r'^[A-Za-z0-9_.-]{1,128}$', dockerfile or ""):
        return {"error": "Ungültiger Dockerfile-Name"}
    tag = (tag or "").strip()
    if not _valid_image_ref(tag) or ":" not in tag:
        return {"error": "Bitte Tag in der Form „name:version“ angeben"}
    args = {}
    for k, v in (buildargs or {}).items():
        if not re.match(r'^[A-Za-z_][A-Za-z0-9_]{0,63}$', str(k)):
            return {"error": f"Ungültiger Build-Argument-Name: {k}"}
        args[str(k)] = str(v)

    # Existiert der Kontext auf dem Wirt überhaupt?
    try:
        r = subprocess.run(_ns(["test", "-d", context]), timeout=10)
        if r.returncode != 0:
            return {"error": f"Verzeichnis existiert auf dem Host nicht: {context}"}
    except Exception as e:
        return {"error": f"Kontext nicht prüfbar: {e}"}

    jid = _job_new("build", tag)

    def _run():
        from urllib.parse import quote
        tar = conn = None
        try:
            tar = subprocess.Popen(_ns(["tar", "-cf", "-", "-C", context, "."]),
                                   stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL)
            q = (f"/build?t={quote(tag, safe='')}"
                 f"&dockerfile={quote(dockerfile, safe='')}"
                 f"&nocache={'1' if nocache else '0'}&rm=1&forcerm=1")
            if args:
                q += "&buildargs=" + quote(json.dumps(args), safe='')
            conn = _UnixSocketHTTPConnection()
            # Ohne Content-Length schickt http.client den Datei-artigen Body
            # automatisch chunked — genau das erwartet der Builder.
            conn.request("POST", q, body=tar.stdout,
                         headers={"Host": "localhost",
                                  "Content-Type": "application/x-tar"})
            resp = conn.getresponse()
            got_error = ""
            if resp.status not in (200, 201):
                # Fehler vor dem Strom (z. B. fehlendes Dockerfile) kommen als
                # HTTP-Status mit {"message": …} — nicht als Strom-Zeile.
                try:
                    raw = resp.read(8192)
                    try:
                        got_error = json.loads(raw).get("message", "")
                    except Exception:
                        got_error = raw.decode("utf-8", errors="replace").strip()[:300]
                except Exception:
                    pass
                got_error = got_error or f"Docker-Fehler (HTTP {resp.status})"
                _job_done(jid, error=got_error)
                return
            while True:
                line = resp.readline()
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except Exception:
                    continue
                if ev.get("error"):
                    got_error = str(ev["error"]).strip()
                    break
                txt = (ev.get("stream") or "").rstrip("\n")
                if txt:
                    _job_log(jid, txt)
                st = ev.get("status")
                if st:
                    _job_log(jid, st)
            _job_done(jid, error=got_error, result="" if got_error else tag)
        except Exception as e:
            _job_done(jid, error=str(e))
        finally:
            for c in (tar, conn):
                try:
                    if c is tar and tar:
                        tar.stdout.close()
                        tar.terminate()
                    elif c:
                        c.close()
                except Exception:
                    pass

    threading.Thread(target=_run, daemon=True).start()
    return {"success": True, "job": jid}


# ─── Container-Aktionen ──────────────────────────────────────────────────────

_SIGNALS = ("SIGTERM", "SIGKILL", "SIGINT", "SIGHUP", "SIGQUIT",
            "SIGUSR1", "SIGUSR2", "SIGSTOP", "SIGCONT")

_RESTART_POLICIES = ("no", "always", "unless-stopped", "on-failure")


def _action_error_de(msg, cid="", status=0):
    """Docker-Zustandsmeldungen eindeutschen und die 64-stellige Id kürzen.

    Docker liefert bei HTTP 409 immer ein `message`-Feld, weshalb der eigene
    deutsche Rückfalltext nie zum Zug kam — der Nutzer sah englischen Rohtext
    mit der vollen Container-Id darin."""
    m = (msg or "").lower()
    if "already paused" in m:
        return "Der Container ist bereits pausiert."
    if "is not paused" in m:
        return "Der Container ist nicht pausiert."
    if "is not running" in m:
        return "Der Container läuft nicht."
    if "already started" in m or "already running" in m:
        return "Der Container läuft bereits."
    if "paused container" in m and "start" in m:
        return ("Ein pausierter Container kann nicht gestartet werden — "
                "bitte „Fortsetzen“ verwenden.")
    if "same name as its current name" in m:
        return "Der Container heißt bereits so."
    if "requested cpus are not available" in m or "cpuset" in m:
        return f"Angeforderte CPUs sind auf diesem Host nicht verfügbar ({msg})"
    # Unbekannte Meldung: wenigstens die volle Id auf 12 Zeichen kürzen
    out = msg or f"Docker-Fehler (HTTP {status})"
    return re.sub(r'\b([0-9a-f]{12})[0-9a-f]{52}\b', r'\1', out)


def docker_container_action(cid, action, signal="", timeout=10):
    """Container starten/stoppen/neustarten/pausieren/fortsetzen/killen."""
    if not _valid_id(cid):
        return {"error": "Ungültige Container-Kennung"}
    cid = _clean(cid)
    # Der eigene Container darf nur gestartet werden (No-Op) — alles andere
    # würde die laufende Sitzung kappen.
    if action != "start":
        blocked = _protect(cid)
        if blocked:
            return blocked
    # `int(timeout or 10)` verschluckte die 0: `0 or 10` ergibt 10, ein
    # „sofort hart stoppen“ war damit unmöglich (gemessen 10,5 s statt 0).
    if timeout is None or timeout == "":
        timeout = 10
    try:
        timeout = max(0, min(int(timeout), 120))
    except (TypeError, ValueError):
        timeout = 10
    try:
        if action == "start":
            path = f"/containers/{cid}/start"
        elif action == "stop":
            path = f"/containers/{cid}/stop?t={timeout}"
        elif action == "restart":
            path = f"/containers/{cid}/restart?t={timeout}"
        elif action == "pause":
            path = f"/containers/{cid}/pause"
        elif action == "unpause":
            path = f"/containers/{cid}/unpause"
        elif action == "kill":
            sig = (signal or "SIGKILL").upper()
            if sig not in _SIGNALS:
                return {"error": f"Unbekanntes Signal: {sig}"}
            path = f"/containers/{cid}/kill?signal={sig}"
        else:
            return {"error": f"Unbekannte Aktion: {action}"}
        status, resp = _docker_api("POST", path)
        if status in (200, 204):
            return {"success": True}
        if status == 304:
            # Docker meldet 304, wenn der Zustand schon passt (z. B. Start
            # eines laufenden Containers) — für den Benutzer ist das Erfolg.
            return {"success": True, "note": "Zustand war bereits so"}
        if status == 404:
            return {"error": "Container nicht gefunden"}
        if status in (400, 409):
            return {"error": _action_error_de(resp.get("message", ""), cid, status)}
        return {"error": _action_error_de(resp.get("message", ""), cid, status)}
    except Exception as e:
        return {"error": str(e)}


def _parse_port_spec(line):
    """„8080:80/tcp“ → (host_port, container_port, proto, host_ip) oder Fehler."""
    import ipaddress
    s = (line or "").strip()
    if not s:
        return None, None
    proto = "tcp"
    if "/" in s:
        s, _, proto = s.rpartition("/")
        if proto not in ("tcp", "udp", "sctp"):
            return None, f"Ungültiges Protokoll: {proto}"
    parts = s.split(":")
    host_ip = ""
    if len(parts) == 3:
        host_ip, hp, cp = parts
        try:
            ipaddress.ip_address(host_ip)
        except ValueError:
            return None, f"Ungültige Host-IP: {host_ip}"
    elif len(parts) == 2:
        hp, cp = parts
    elif len(parts) == 1:
        hp = cp = parts[0]
    else:
        return None, f"Port-Angabe nicht verstanden: {line}"
    try:
        hpi, cpi = int(hp), int(cp)
    except ValueError:
        return None, f"Ports müssen Zahlen sein: {line}"
    if not (1 <= hpi <= 65535 and 1 <= cpi <= 65535):
        return None, f"Ports müssen zwischen 1 und 65535 liegen: {line}"
    return (hpi, cpi, proto, host_ip), None


def docker_container_create(image, name="", cmd="", entrypoint="", ports=None,
                            volumes=None, env=None, labels=None, network="",
                            restart="no", memory_mb=None, cpus=None, user="",
                            workdir="", privileged=False, tty=False,
                            cap_add=None, start=True):
    """Container nach Assistenten-Angaben anlegen (optional gleich starten)."""
    if not _valid_image_ref(image):
        return {"error": "Ungültige Image-Referenz"}
    name = _clean(name)
    if name and not _valid_id(name):
        return {"error": "Ungültiger Container-Name (nur A-Z a-z 0-9 . _ -)"}
    if restart not in _RESTART_POLICIES:
        return {"error": f"Unbekannte Neustart-Regel: {restart}"}
    if user and not re.match(r'^[A-Za-z0-9_.:-]{1,64}$', user):
        return {"error": "Ungültiger Benutzer"}
    if workdir and not workdir.startswith("/"):
        return {"error": "Arbeitsverzeichnis muss absolut sein"}
    if network and not _valid_id(network):
        return {"error": "Ungültiger Netzwerkname"}

    exposed, bindings = {}, {}
    for line in (ports or []):
        spec, err = _parse_port_spec(line)
        if err:
            return {"error": err}
        if not spec:
            continue
        hpi, cpi, proto, host_ip = spec
        key = f"{cpi}/{proto}"
        exposed[key] = {}
        b = {"HostPort": str(hpi)}
        if host_ip:
            b["HostIp"] = host_ip
        bindings.setdefault(key, []).append(b)

    binds = []
    for line in (volumes or []):
        s = (line or "").strip()
        if not s:
            continue
        parts = s.split(":")
        if len(parts) < 2 or len(parts) > 3:
            return {"error": f"Volume-Angabe nicht verstanden: {s}"}
        src, dst = parts[0], parts[1]
        mode = parts[2] if len(parts) == 3 else ""
        if mode and mode not in ("ro", "rw", "z", "Z"):
            return {"error": f"Ungültiger Volume-Modus: {mode}"}
        if not dst.startswith("/"):
            return {"error": f"Ziel im Container muss absolut sein: {dst}"}
        if src.startswith("/"):
            err = _path_denied(src)
            if err:
                return {"error": err["error"] + f" ({src})"}
        elif not _valid_id(src):
            return {"error": f"Ungültiger Volume-Name: {src}"}
        binds.append(s)

    envs = []
    for line in (env or []):
        s = (line or "").strip()
        if not s:
            continue
        if not re.match(r'^[A-Za-z_][A-Za-z0-9_]{0,127}=', s):
            return {"error": f"Umgebungsvariable nicht verstanden: {s}"}
        envs.append(s)

    labs = {}
    for line in (labels or []):
        s = (line or "").strip()
        if not s:
            continue
        k, _, v = s.partition("=")
        if not re.match(r'^[A-Za-z0-9_.\-/]{1,128}$', k):
            return {"error": f"Ungültiger Label-Name: {k}"}
        labs[k] = v[:256]

    caps = []
    for c in (cap_add or []):
        c = str(c).strip().upper()
        if not c:
            continue
        if not re.match(r'^[A-Z_]{1,32}$', c):
            return {"error": f"Ungültige Capability: {c}"}
        caps.append(c)

    hostcfg = {"PortBindings": bindings, "Binds": binds,
               "RestartPolicy": {"Name": restart, "MaximumRetryCount": 0},
               "Privileged": bool(privileged)}
    if caps:
        hostcfg["CapAdd"] = caps
    if network:
        hostcfg["NetworkMode"] = network
    if memory_mb not in (None, ""):
        try:
            m = int(memory_mb)
        except (TypeError, ValueError):
            return {"error": "Speicherlimit muss eine Zahl sein (MB)"}
        if m and (m < 6 or m > 1024 * 1024):
            return {"error": "Speicherlimit muss 0 oder 6–1048576 MB sein"}
        if m:
            hostcfg["Memory"] = m * 1024 * 1024
            hostcfg["MemorySwap"] = m * 1024 * 1024
    if cpus not in (None, ""):
        try:
            c = float(cpus)
        except (TypeError, ValueError):
            return {"error": "CPU-Anzahl muss eine Zahl sein"}
        if c < 0 or c > 1024:
            return {"error": "CPU-Anzahl muss 0–1024 sein"}
        if c:
            hostcfg["CpuPeriod"] = 100000
            hostcfg["CpuQuota"] = int(c * 100000)

    body = {"Image": image, "Env": envs, "Labels": labs,
            "ExposedPorts": exposed, "HostConfig": hostcfg,
            "Tty": bool(tty), "OpenStdin": bool(tty)}
    if cmd:
        try:
            body["Cmd"] = shlex.split(cmd)
        except ValueError:
            return {"error": "Kommando nicht lesbar (Anführungszeichen prüfen)"}
    if entrypoint:
        try:
            body["Entrypoint"] = shlex.split(entrypoint)
        except ValueError:
            return {"error": "Entrypoint nicht lesbar (Anführungszeichen prüfen)"}
    if user:
        body["User"] = user
    if workdir:
        body["WorkingDir"] = workdir

    try:
        from urllib.parse import quote
        q = f"?name={quote(name, safe='')}" if name else ""
        status, resp = _docker_api("POST", f"/containers/create{q}", body)
        if status == 404:
            # Image fehlt lokal — einmal blockierend nachladen und erneut
            # versuchen (gleiches Vorgehen wie im Browser-Session-Manager).
            repo, _, tag = image.rpartition(":")
            if not repo or "/" in tag:
                repo, tag = image, "latest"
            pull = _docker_api("POST", "/images/create"
                                       f"?fromImage={quote(repo, safe='/')}"
                                       f"&tag={quote(tag, safe='')}")
            if pull[0] not in (200, 201):
                return {"error": f"Image „{image}“ konnte nicht geladen werden"}
            status, resp = _docker_api("POST", f"/containers/create{q}", body)
        if status == 409:
            return {"error": f"Name „{name}“ ist bereits vergeben"}
        if status not in (200, 201):
            return {"error": resp.get("message", f"Docker-Fehler (HTTP {status})")}
        cid = resp.get("Id", "")
        warnings = resp.get("Warnings") or []
        if start:
            st, sr = _docker_api("POST", f"/containers/{cid}/start")
            if st not in (200, 204):
                return {"error": sr.get("message",
                                        f"Erstellt, aber Start fehlgeschlagen (HTTP {st})"),
                        "id": cid, "created": True}
        return {"success": True, "id": cid, "short_id": cid[:12],
                "warnings": warnings}
    except Exception as e:
        return {"error": str(e)}


def docker_container_remove(cid, force=False, volumes=False):
    """Container entfernen (optional erzwungen und mit anonymen Volumes).

    Browser-Session-Container laufen über den BrowserSessionManager — sie hier
    direkt zu löschen würde `/data/browser_sessions.json` verwaisen lassen.
    Deshalb wird für sie an den Manager delegiert."""
    if not _valid_id(cid):
        return {"error": "Ungültige Container-Kennung"}
    cid = _clean(cid)
    blocked = _protect(cid)
    if blocked:
        return blocked
    try:
        name = ""
        try:
            st, ins = _docker_api("GET", f"/containers/{cid}/json")
            if st == 200:
                name = _clean(ins.get("Name", ""))
        except Exception:
            pass
        if name.startswith(_BROWSER_PFX):
            from dashboard.browsers import _browser_mgr
            sid = name[len(_BROWSER_PFX):]
            try:
                _browser_mgr.stop(sid, is_admin=True)
                return {"success": True, "note": "Über die Browser-Sitzungs-"
                                                 "verwaltung entfernt"}
            except Exception:
                pass   # Fallback: normal löschen, Manager räumt beim Start auf
        q = f"?force={'true' if force else 'false'}&v={'true' if volumes else 'false'}"
        status, resp = _docker_api("DELETE", f"/containers/{cid}{q}")
        if status in (200, 204):
            return {"success": True}
        if status == 404:
            return {"error": "Container nicht gefunden"}
        if status == 409:
            return {"error": "Container läuft noch — „Erzwingen“ aktivieren "
                             "oder vorher stoppen."}
        return {"error": resp.get("message", f"Docker-Fehler (HTTP {status})")}
    except Exception as e:
        return {"error": str(e)}


def docker_container_rename(cid, new_name):
    """Container umbenennen."""
    if not _valid_id(cid):
        return {"error": "Ungültige Container-Kennung"}
    new_name = _clean(new_name)
    if not _valid_id(new_name):
        return {"error": "Ungültiger Name (nur A-Z a-z 0-9 . _ -, max. 128)"}
    cid = _clean(cid)
    blocked = _protect(cid)
    if blocked:
        return blocked
    try:
        from urllib.parse import quote
        status, resp = _docker_api(
            "POST", f"/containers/{cid}/rename?name={quote(new_name, safe='')}")
        if status in (200, 204):
            return {"success": True, "name": new_name}
        if status == 404:
            return {"error": "Container nicht gefunden"}
        if status == 409:
            return {"error": f"Name „{new_name}“ ist bereits vergeben"}
        return {"error": _action_error_de(resp.get("message", ""), cid, status)}
    except Exception as e:
        return {"error": str(e)}


def docker_container_update(cid, policy=None, max_retry=0, memory_mb=None,
                            memory_swap_mb=None, cpus=None, cpu_shares=None,
                            cpuset=None):
    """Neustart-Regel und/oder Ressourcen-Limits ändern (`/update`).

    Alle Werte sind optional; nur Gesetztes wird an Docker geschickt, damit ein
    Formular ohne Speicherangabe kein bestehendes Limit löscht."""
    if not _valid_id(cid):
        return {"error": "Ungültige Container-Kennung"}
    cid = _clean(cid)
    blocked = _protect(cid)
    if blocked:
        return blocked
    body = {}
    if policy is not None:
        if policy not in _RESTART_POLICIES:
            return {"error": f"Unbekannte Neustart-Regel: {policy}"}
        try:
            mr = max(0, min(int(max_retry or 0), 1000))
        except (TypeError, ValueError):
            mr = 0
        body["RestartPolicy"] = {"Name": policy,
                                 "MaximumRetryCount": mr if policy == "on-failure" else 0}
    if memory_mb is not None and str(memory_mb) != "":
        try:
            m = int(memory_mb)
        except (TypeError, ValueError):
            return {"error": "Speicherlimit muss eine Zahl sein (MB)"}
        if m and (m < 6 or m > 1024 * 1024):
            return {"error": "Speicherlimit muss 0 (unbegrenzt) oder 6–1048576 MB sein"}
        body["Memory"] = m * 1024 * 1024
        # Ohne MemorySwap setzt Docker Swap implizit auf 2× Memory. Explizit
        # gleichsetzen heißt „kein zusätzlicher Swap“, das ist die erwartete
        # Bedeutung eines Speicherlimits.
        if memory_swap_mb is None or str(memory_swap_mb) == "":
            body["MemorySwap"] = m * 1024 * 1024 if m else 0
    if memory_swap_mb is not None and str(memory_swap_mb) != "":
        try:
            s = int(memory_swap_mb)
        except (TypeError, ValueError):
            return {"error": "Swap-Limit muss eine Zahl sein (MB)"}
        body["MemorySwap"] = -1 if s < 0 else s * 1024 * 1024
    if cpus is not None and str(cpus) != "":
        try:
            c = float(cpus)
        except (TypeError, ValueError):
            return {"error": "CPU-Anzahl muss eine Zahl sein"}
        if c < 0 or c > 1024:
            return {"error": "CPU-Anzahl muss 0–1024 sein"}
        body["CpuPeriod"] = 100000
        body["CpuQuota"] = int(c * 100000) if c > 0 else 0
    if cpu_shares is not None and str(cpu_shares) != "":
        try:
            sh = int(cpu_shares)
        except (TypeError, ValueError):
            return {"error": "CPU-Shares müssen eine Zahl sein"}
        if sh and (sh < 2 or sh > 262144):
            return {"error": "CPU-Shares müssen 0 oder 2–262144 sein"}
        body["CpuShares"] = sh
    if cpuset is not None and str(cpuset) != "":
        if not re.match(r'^[0-9,\-]{1,64}$', str(cpuset)):
            return {"error": "Ungültiger CPU-Set (z. B. „0-3“ oder „0,2,4“)"}
        body["CpusetCpus"] = str(cpuset)
    if not body:
        return {"error": "Keine Änderung angegeben"}
    # Welche Limits sollen auf „unbegrenzt“ zurückgesetzt werden? Die Engine
    # ignoriert das stillschweigend — dafür wird unten gewarnt.
    _null_limits = []
    if body.get("Memory") == 0 and memory_mb not in (None, ""):
        _null_limits.append("Speicher")
    if body.get("CpuQuota") == 0 and cpus not in (None, ""):
        _null_limits.append("CPU-Anzahl")
    if body.get("CpuShares") == 0 and cpu_shares not in (None, ""):
        _null_limits.append("CPU-Shares")
    try:
        status, resp = _docker_api("POST", f"/containers/{cid}/update", body)
        if status in (200, 204):
            warn = list(resp.get("Warnings") or [])
            # Die Engine kann ein bereits gesetztes Limit im laufenden Betrieb
            # nicht auf „unbegrenzt“ zurücksetzen — sie meldet trotzdem Erfolg.
            # Ohne diesen Hinweis glaubt man, das Limit sei weg.
            if _null_limits:
                warn.append("Docker kann gesetzte Limits im laufenden Betrieb "
                            "nicht entfernen (" + ", ".join(_null_limits) +
                            "). Dafür muss der Container neu erstellt werden.")
            return {"success": True, "warnings": warn}
        if status == 404:
            return {"error": "Container nicht gefunden"}
        return {"error": _action_error_de(resp.get("message", ""), cid, status)}
    except Exception as e:
        return {"error": str(e)}


def docker_stack_action(project, action):
    """Alle Container eines Compose-Stacks gemeinsam schalten."""
    if not _PROJECT_RE.match(project or ""):
        return {"error": "Ungültiger Projektname"}
    if action not in ("start", "stop", "restart"):
        return {"error": f"Unbekannte Aktion: {action}"}
    targets = []
    for s in docker_stacks():
        if s["project"] == project:
            targets = s["containers"]
            break
    if not targets:
        return {"error": "Stack nicht gefunden"}
    # Parallel, nicht nacheinander: ein `stop` wartet bis zu 10 s auf SIGTERM.
    # Bei einem Stack mit sieben Diensten wären das über eine Minute, in der
    # die HTTP-Anfrage offen bliebe und die Oberfläche nichts täte.
    done, failed, skipped = [], [], []
    results, res_lock = {}, threading.Lock()

    def _one(c):
        r = docker_container_action(c["id"], action)
        with res_lock:
            results[c["name"]] = r

    threads = []
    for c in targets:
        if _is_self(c["name"]):
            skipped.append(c["name"])
            continue
        th = threading.Thread(target=_one, args=(c,), daemon=True)
        th.start()
        threads.append(th)
    for th in threads:
        th.join(timeout=60)

    for name in sorted(results):
        r = results[name]
        if r.get("success"):
            done.append(name)
        else:
            failed.append(f"{name}: {r.get('error', '?')}")
    out = {"success": not failed, "done": done, "failed": failed}
    if skipped:
        out["skipped"] = skipped
    if failed:
        out["error"] = "; ".join(failed)
    return out


# ─── HTTP Request Handler ────────────────────────────────────────────────────
