"""Reiter "Sicherheit" - Live-Kachel IDS-Waechter.

Quellen (auf dem HOST, ueber /proc/1/root bzw. nsenter):

    /sys/class/net/<WAN>/statistics/{rx,tx}_bytes    Datenverkehr (network_mode host)
    /var/log/ids-watch.log                           Entscheidungen von ids-watch.py
    /etc/ids-watch.conf                              Modus melden/sperren
    systemctl / ipset / suricatasc                   Status, aktive IDS-Sperren, Paketzaehler

Installiert wird der Waechter mit install.sh (Ordner schutz/, siehe README).
Interface: DASHBOARD_WAN_IF, sonst WAN_IF aus der Schutz-Konfiguration, sonst
das Interface der Standardroute.

Der Text hinter der IP in ids-watch.log stammt aus Suricata-Regeln und
Paket-Metadaten (z. B. DNS-Namen) - Angreifer-Input, das Frontend escapt alles.
"""

import ipaddress
import json
import os
import re
import subprocess
import threading
import time
from collections import deque
from datetime import datetime

from dashboard.base import _ns

HOST_ROOT = "/proc/1/root"
NETZE_CONF = "/etc/linux-dashboard/schutz-netze.generiert"


def _detect_iface():
    env = os.environ.get("DASHBOARD_WAN_IF", "").strip()
    if env and env != "auto":
        return env
    try:
        for line in open(HOST_ROOT + NETZE_CONF):
            m = re.match(r'^WAN_IF="?([A-Za-z0-9_.@:-]+)"?\s*$', line)
            if m:
                return m.group(1)
    except OSError:
        pass
    try:
        # network_mode host: /proc/net/route ist die Routing-Tabelle des Hosts
        with open("/proc/net/route") as fh:
            for line in fh.readlines()[1:]:
                f = line.split()
                if len(f) > 2 and f[1] == "00000000":
                    return f[0]
    except OSError:
        pass
    return "eth0"


IFACE = _detect_iface()
IDS_LOG = "/var/log/ids-watch.log"
IDS_CONF = "/etc/ids-watch.conf"

SAMPLE_S = 2                 # Abtastung Datenverkehr
TRAFFIC_KEEP = 600 // SAMPLE_S   # 10 min Verlauf
MINUTES_KEEP = 24 * 60       # IDS-Treffer je Minute, 24 h

# Art in ids-watch.log -> Serie im Diagramm
_ART = {"IDS-ANGRIFF": "angriff", "IDS-AUSGANG": "ausgang", "IDS-WARNUNG": "warnung"}
SERIES = ["angriff", "ausgang", "notiert", "warnung"]
_LINE_RE = re.compile(r"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) (IDS-[A-Z]+) (\S+) (.*)$")
_SIG_RE = re.compile(r"\[([^\]]*)\]")
_SEV_RE = re.compile(r"sev=(\d)")

_lock = threading.Lock()
_state = {
    "started": False,
    "traffic": deque(maxlen=TRAFFIC_KEEP),   # (t, rx_bit/s, tx_bit/s)
    "minutes": {},                           # minute-epoch -> {serie: n}
    "recent": deque(maxlen=40),              # letzte Sperren/Warnungen
    "log_ino": None, "log_pos": 0,
    "status": {}, "status_t": 0.0,
}


def _read_int(path):
    with open(path) as fh:
        return int(fh.read().strip())


def _sampler():
    base = f"/sys/class/net/{IFACE}/statistics/"
    last = None
    while True:
        try:
            now = time.time()
            rx, tx = _read_int(base + "rx_bytes"), _read_int(base + "tx_bytes")
            if last:
                dt = now - last[0]
                if dt > 0:
                    with _lock:
                        _state["traffic"].append((round(now, 1),
                                                  max(0, (rx - last[1]) * 8 / dt),
                                                  max(0, (tx - last[2]) * 8 / dt)))
            last = (now, rx, tx)
        except Exception:
            last = None
        try:
            _read_log()
        except Exception:
            pass
        time.sleep(SAMPLE_S)


def _ts(text):
    try:
        return datetime.strptime(text, "%Y-%m-%d %H:%M:%S").timestamp()
    except ValueError:
        return 0.0


def _ingest(line):
    m = _LINE_RE.match(line)
    if not m:
        return
    ts = _ts(m.group(1))
    if not ts:
        return
    art, ip, rest = m.group(2), m.group(3), m.group(4)
    try:
        ip = ipaddress.ip_address(ip).compressed
    except ValueError:
        return
    if "TEST" in rest.split(" ", 1)[0]:
        return                                  # Kettentest-Zeilen
    serie = _ART.get(art, "notiert")
    minute = int(ts // 60 * 60)
    with _lock:
        b = _state["minutes"].setdefault(minute, dict.fromkeys(SERIES, 0))
        b[serie] += 1
        if serie != "notiert":
            sig = _SIG_RE.search(rest)
            sev = _SEV_RE.search(rest)
            richtung = "aus" if "(von innen)" in rest else "ein"
            dom = re.search(r"domain=(\S+)", rest)
            her = re.search(r"herkunft=(.+)$", rest)
            _state["recent"].appendleft({
                "ts": ts, "art": serie, "ip": ip,
                "sig": (sig.group(1) if sig else "")[:140],
                "sev": int(sev.group(1)) if sev else None,
                "richtung": richtung,
                "detail": ((dom.group(1) if dom else "") or (her.group(1) if her else ""))[:80],
            })


def _read_log():
    path = HOST_ROOT + IDS_LOG
    st = os.stat(path)
    with _lock:
        ino, pos = _state["log_ino"], _state["log_pos"]
    first = ino is None
    if ino != st.st_ino or st.st_size < pos:
        pos = 0
        if first:
            # Erster Start: nur die letzten ~24 h einlesen (Datei waechst ~10 MB/Tag)
            pos = max(0, st.st_size - 12 * 1024 * 1024)
    if st.st_size == pos:
        with _lock:
            _state["log_ino"] = st.st_ino
        return
    with open(path, "rb") as fh:
        fh.seek(pos)
        data = fh.read(16 * 1024 * 1024)
    cut = data.rfind(b"\n") + 1
    if pos and first:
        nl = data.find(b"\n") + 1      # angeschnittene erste Zeile verwerfen
        lines = data[nl:cut]
    else:
        lines = data[:cut]
    for line in lines.decode("utf-8", "replace").splitlines():
        _ingest(line)
    grenze = time.time() - MINUTES_KEEP * 60
    with _lock:
        _state["log_ino"], _state["log_pos"] = st.st_ino, pos + cut
        for k in [k for k in _state["minutes"] if k < grenze]:
            del _state["minutes"][k]


def _start():
    with _lock:
        if _state["started"]:
            return
        _state["started"] = True
    threading.Thread(target=_sampler, name="ids-sampler", daemon=True).start()


def _run(cmd, timeout=8):
    try:
        r = subprocess.run(_ns(cmd), capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout
    except Exception:
        return 99, ""


def _ipset_count(name):
    rc, out = _run(["ipset", "list", "-t", name])
    m = re.search(r"Number of entries:\s*(\d+)", out)
    return int(m.group(1)) if m else None


def _status():
    now = time.time()
    with _lock:
        if now - _state["status_t"] < 10:
            return _state["status"]
    s = {}
    for u in ("suricata", "ids-watch"):
        s[u.replace("-", "_")] = _run(["systemctl", "is-active", u])[1].strip() or "unbekannt"
    modus = "?"
    try:
        for line in open(HOST_ROOT + IDS_CONF):
            m = re.match(r"^\s*MODUS\s*=\s*(\w+)", line)
            if m:
                modus = m.group(1)
    except OSError:
        pass
    s["modus"] = modus
    v4, v6 = _ipset_count("ids_ban4"), _ipset_count("ids_ban6")
    s["sperren"] = (v4 or 0) + (v6 or 0) if v4 is not None else None
    sock = "/run/suricata/suricata-command.socket"
    extra = [sock] if os.path.exists(HOST_ROOT + sock) else []
    rc, out = _run(["suricatasc", "-c", f"iface-stat {IFACE}"] + extra)
    try:
        msg = json.loads(out)["message"]
        s["pakete"], s["verworfen"] = int(msg["pkts"]), int(msg["drop"])
    except Exception:
        s["pakete"] = s["verworfen"] = None
    with _lock:
        _state["status"], _state["status_t"] = s, now
    return s


def ids_live(rng="60", since=0.0):
    """Daten fuer die Live-Kachel.
    rng = "60" (letzte Stunde, Minutenbalken) oder "1440" (24 h, 30-min-Balken).
    since = nur Datenverkehrs-Punkte neuer als dieser Zeitpunkt (Delta-Abruf)."""
    _start()
    try:
        since = float(since or 0)
    except ValueError:
        since = 0.0
    breite, anzahl = (60, 60) if str(rng) != "1440" else (1800, 48)
    now = time.time()
    ende = int(now // breite * breite)
    start = ende - (anzahl - 1) * breite
    bars = []
    with _lock:
        traffic = [list(p) for p in _state["traffic"] if p[0] > since]
        for i in range(anzahl):
            b0 = start + i * breite
            summe = dict.fromkeys(SERIES, 0)
            for m in range(b0, b0 + breite, 60):
                for k, v in _state["minutes"].get(m, {}).items():
                    summe[k] += v
            bars.append([b0] + [summe[k] for k in SERIES])
        recent = list(_state["recent"])[:20]
        tag = dict.fromkeys(SERIES, 0)
        grenze = now - 86400
        for m, b in _state["minutes"].items():
            if m >= grenze:
                for k, v in b.items():
                    tag[k] += v
    return {
        "now": now, "status": _status(), "traffic": traffic,
        "iface": IFACE, "series": SERIES, "bar_s": breite, "bars": bars, "tag": tag, "recent": recent,
    }
