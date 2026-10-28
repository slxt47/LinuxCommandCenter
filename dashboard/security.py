"""Reiter "Sicherheit": Meldungen von fail2ban, dem Cloudflare-Rand (optional)
und dem Login-Waechter (optional), aktive Sperren und Entsperren.

Quellen (alle auf dem HOST, gelesen ueber /proc/1/root bzw. nsenter):

    /var/log/fail2ban.log*        Found / Ban / Unban / Restore / Increase
    /var/log/webauth/cf-ban.log*  GESPERRT / ENTSPERRT am Cloudflare-Rand
    journal ntfy-login-watch      erfolgreiche Anmeldungen (siehe /opt/ntfy-watch)
    fail2ban-client banned        aktive Sperren (Wahrheit)
    fail2ban.sqlite3, Tabelle bips  Sperrzeitpunkt/-dauer zu den aktiven Sperren
    /data/security_unbans.log     wer hat wann ueber das Dashboard entsperrt

Entsperrt wird ausschliesslich ueber /usr/local/sbin/webauth-unban.sh (wird von
install.sh mit dem Schutz-Paket installiert): ein Ban wirkt an bis zu drei
Stellen (Jails, ipset, ggf. Cloudflare-Liste) und das Skript raeumt alle ab.
Fehlende Quellen (kein Cloudflare, kein Login-Waechter) bleiben einfach leer.

Benutzernamen und Teile der Logzeilen sind Angreifer-Input: das Frontend
escapt alles, hier wird nur geparst, nie interpretiert.
"""

import gzip
import ipaddress
import json
import os
import re
import sqlite3
import subprocess
import threading
import time
from datetime import datetime

from dashboard.base import DATA_DIR, _ns

HOST_ROOT = "/proc/1/root"
F2B_LOG = "/var/log/fail2ban.log"
CF_LOG = "/var/log/webauth/cf-ban.log"
F2B_DB = "/var/lib/fail2ban/fail2ban.sqlite3"
KNOWN_IPS = "/var/lib/ntfy-watch/bekannte-ips.json"
UNBAN_SCRIPT = "/usr/local/sbin/webauth-unban.sh"
LOGIN_UNIT = "ntfy-login-watch.service"
UNBAN_LOG = DATA_DIR / "security_unbans.log"

# Jails der Dauersperre (3. Sperre in N Tagen = dauerhaft).
PERM_JAILS = {"dauersperre", "dauersperre-web"}

# Anwendungen im Reiter: (Name, fail2ban-Jails, Dienstnamen des Login-Waechters).
# Reihenfolge = Anzeige-Reihenfolge. Angezeigt wird eine Anwendung nur, wenn
# eine ihrer Jails auf DIESEM Server laeuft (bzw. bei reinen Login-Diensten,
# wenn der Login-Waechter laeuft). Laufende Jails, die hier fehlen, erscheinen
# automatisch unter ihrem eigenen Namen.
# Eigene Liste: /data/security_apps.json  (=/var/lib/linux-dashboard/...)
#   [{"name": "Nextcloud", "jails": ["nextcloud-auth"], "logins": ["Nextcloud"]}, ...]
DEFAULT_APPS = [
    ("Command Center",    ["dashboard-auth"], ["Command Center"]),
    ("Nextcloud",         ["nextcloud-auth"], ["Nextcloud"]),
    ("Yoga-Plattform",    ["yoga-auth"], ["Yoga-Plattform"]),
    ("Webmail",           ["roundcube"], ["Webmail"]),
    ("Webmail jokerdev",  ["roundcube-jokerdev"], ["Webmail jokerdev"]),
    ("Webmail tinytales", ["roundcube-tinytales"], ["Webmail tinytales"]),
    ("Mail",              ["postfix-sasl", "dovecot", "mail-unknownuser", "mail-subnet24"], []),
    ("Mail jokerdev",     ["postfix-jokerdev", "dovecot-jokerdev"], []),
    ("Mail tinytales",    ["postfix-tinytales", "dovecot-tinytales"], []),
    ("PXE-Server",        ["pxe-auth"], ["PXE-Server"]),
    ("Demo-QBS",          ["demo-qbs-auth"], ["Demo-QBS"]),
    ("KI-Begleiterin",    ["companion-auth"], ["Amy (KI-Begleiterin)"]),
    ("ntfy",              ["ntfy-auth"], []),
    ("play4cash",         [], ["play4cash"]),
    ("SSH",               ["sshd", "sshd-invalid"], []),
    ("IDS-Wächter",       ["ids-angriff", "ids-ausgang"], []),
    ("Dauersperre",       ["dauersperre", "dauersperre-web"], []),
]
APPS_FILE = DATA_DIR / "security_apps.json"

_apps_cache = {"t": 0.0, "apps": None, "cf": set()}
_APPS_TTL = 60


def _running_jails():
    try:
        r = subprocess.run(_ns(["fail2ban-client", "status"]), capture_output=True,
                           text=True, timeout=15)
    except Exception:
        return None
    m = re.search(r"Jail list:\s*(.*)$", r.stdout, re.M)
    if not m:
        return None
    return [j.strip() for j in m.group(1).split(",") if j.strip()]


def _cf_jails(jails):
    """Jails, deren Sperre auch am Cloudflare-Rand wirkt (Action cf-block)."""
    out = set()
    for j in jails:
        try:
            r = subprocess.run(_ns(["fail2ban-client", "get", j, "actions"]),
                               capture_output=True, text=True, timeout=10)
            if "cf-block" in r.stdout:
                out.add(j)
        except Exception:
            pass
    return out


def _apps():
    """[(name, jails, logins)] passend zu diesem Server (gecacht)."""
    now = time.time()
    with _cache_lock:
        if _apps_cache["apps"] is not None and now - _apps_cache["t"] < _APPS_TTL:
            return _apps_cache["apps"]
    base = DEFAULT_APPS
    try:
        with open(APPS_FILE, encoding="utf-8") as fh:
            base = [(str(a["name"]), list(a.get("jails") or []), list(a.get("logins") or []))
                    for a in json.load(fh)]
    except (OSError, ValueError, KeyError, TypeError):
        pass
    running = _running_jails()
    if running is None:                 # fail2ban nicht erreichbar: alles zeigen
        apps = list(base)
    else:
        login_on = subprocess.run(_ns(["systemctl", "is-active", "--quiet", LOGIN_UNIT]),
                                  capture_output=True).returncode == 0
        apps, covered = [], set()
        for name, jails, logins in base:
            if set(jails) & set(running) or (not jails and logins and login_on):
                apps.append((name, jails, logins))
            covered.update(jails)
        for j in running:
            if j not in covered:
                apps.insert(max(0, len(apps) - 1), (j, [j], []))
    cf = _cf_jails(running or []) if running else set()
    with _cache_lock:
        _apps_cache.update(t=now, apps=apps, cf=cf)
    return apps


def app_names():
    return [a[0] for a in _apps()]


def app_of(jail_or_service):
    """Anwendung zu einem Jail/Dienst; Unbekanntes (alte Test-Jails, nicht mehr
    laufende Jails) landet unter "Sonstige"."""
    if not jail_or_service:
        return ""
    for name, jails, logins in _apps():
        if jail_or_service in jails or jail_or_service in logins:
            return name
    for name, jails, logins in DEFAULT_APPS:
        if jail_or_service in jails or jail_or_service in logins:
            return name
    return "Sonstige"


def cf_jails():
    _apps()
    with _cache_lock:
        return set(_apps_cache["cf"])


_cache_lock = threading.Lock()
_file_cache = {}          # host-pfad -> (signatur, [events])
_journal_cache = {"t": 0.0, "events": []}
_JOURNAL_TTL = 10


def _host(path):
    return HOST_ROOT + path


def _ts(text, fmt="%Y-%m-%d %H:%M:%S"):
    """Lokale Server-Zeit (UTC auf diesem Host) -> Epoch."""
    try:
        return datetime.strptime(text, fmt).timestamp()
    except ValueError:
        return 0.0


# ─── fail2ban.log ───────────────────────────────────────────────────────────

_F2B_RE = re.compile(
    r"^(?P<d>\d{4}-\d\d-\d\d \d\d:\d\d:\d\d),\d+\s+fail2ban\.(?P<mod>\w+)\s+"
    r"\[\d+\]:\s+(?P<lvl>\w+)\s+(?P<rest>.*)$")
_F2B_JAIL_RE = re.compile(r"^\[(?P<jail>[^\]]+)\]\s+(?P<msg>.*)$")
_F2B_ACTIONS = [
    (re.compile(r"^Found (?P<ip>\S+)"), "found"),
    (re.compile(r"^Restore Ban (?P<ip>\S+)"), "ban"),
    (re.compile(r"^Increase Ban (?P<ip>\S+)"), "ban"),
    (re.compile(r"^Ban (?P<ip>\S+)"), "ban"),
    (re.compile(r"^Unban (?P<ip>\S+)"), "unban"),
    (re.compile(r"^(?P<ip>\S+) already banned"), "info"),
]


def _parse_f2b(line):
    m = _F2B_RE.match(line)
    if not m:
        return None
    rest = m.group("rest")
    jail, msg = "", rest
    jm = _F2B_JAIL_RE.match(rest)
    if jm:
        jail, msg = jm.group("jail"), jm.group("msg")
    kind, ip = None, ""
    for rx, k in _F2B_ACTIONS:
        am = rx.match(msg)
        if am:
            kind, ip = k, am.group("ip")
            break
    if kind is None:
        # Sonstige Meldungen: nur Warnungen/Fehler und Start/Stopp sind
        # interessant, das INFO-Rauschen (Rollover, Jail-Setup) nicht.
        lvl = m.group("lvl")
        if lvl not in ("WARNING", "ERROR", "CRITICAL") and \
           not re.search(r"Starting|Stopping|Exiting|Jail .* (started|stopped)", msg):
            return None
        kind = "warn" if lvl != "INFO" else "info"
    if jail in PERM_JAILS:
        # Die Dauersperre zählt Sperren anderer Jails, keine Login-Versuche.
        if kind == "found":
            kind, text = "perm_count", "Sperre gezählt (3. Sperre in 90 Tagen = dauerhaft)"
        elif kind == "ban":
            kind = "perm_ban"
            text = ("Dauersperre wiederhergestellt (Neustart)" if msg.startswith("Restore")
                    else "IP DAUERHAFT gesperrt")
        elif kind == "unban":
            text = "Dauersperre aufgehoben"
        elif kind == "info" and ip:
            text = "bereits dauerhaft gesperrt"
        else:
            text = msg[:400]
    elif kind == "found":
        text = "Fehlversuch erkannt"
    elif kind == "ban":
        if msg.startswith("Increase"):
            text = ("Sperre verlängert " + msg.split(ip, 1)[-1].strip()).strip()
        elif msg.startswith("Restore"):
            text = "Sperre wiederhergestellt (Neustart)"
        else:
            text = "IP gesperrt"
    elif kind == "unban":
        text = "Sperre aufgehoben"
    elif kind == "info" and ip:
        text = "bereits gesperrt"
    else:
        text = msg[:400]
    return {"ts": _ts(m.group("d")), "source": "fail2ban", "kind": kind,
            "jail": jail, "ip": ip, "user": "", "text": text}


# ─── cf-ban.log ─────────────────────────────────────────────────────────────

_CF_RE = re.compile(r"^(?P<d>\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) cf-ban\[\d+\] (?P<msg>.*)$")


def _parse_cf(line):
    m = _CF_RE.match(line)
    if not m:
        return None
    msg = m.group("msg")
    parts = msg.split()
    word = parts[0] if parts else ""
    ip = parts[1].rstrip(":") if len(parts) > 1 else ""
    try:
        ipaddress.ip_network(ip, strict=False)
    except ValueError:
        ip = ""
    jm = re.search(r"\(jail=([^)]+)\)", msg)
    kind = {"GESPERRT": "cf_ban", "ENTSPERRT": "cf_unban"}.get(word, "warn" if "FEHL" in msg.upper() else "info")
    return {"ts": _ts(m.group("d")), "source": "cloudflare", "kind": kind,
            "jail": jm.group(1) if jm else "", "ip": ip, "user": "", "text": msg[:400]}


# ─── Dateien mit Rotation lesen (gecacht) ───────────────────────────────────

def _rotations(path):
    """path, path.1, path.2.gz … – älteste zuletzt; nur was existiert."""
    out = []
    for i in range(0, 15):
        for cand in ([path] if i == 0 else [f"{path}.{i}", f"{path}.{i}.gz"]):
            if os.path.exists(_host(cand)):
                out.append(cand)
    return out


def _read_file_events(path, parser):
    hp = _host(path)
    try:
        st = os.stat(hp)
    except OSError:
        return []
    sig = (st.st_ino, st.st_size, st.st_mtime)
    with _cache_lock:
        hit = _file_cache.get(path)
        if hit and hit[0] == sig:
            return hit[1]
    events = []
    try:
        opener = gzip.open if path.endswith(".gz") else open
        with opener(hp, "rt", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                ev = parser(line.rstrip("\n"))
                if ev:
                    events.append(ev)
    except OSError:
        return []
    with _cache_lock:
        _file_cache[path] = (sig, events)
    return events


# ─── Login-Wächter (Journal) ────────────────────────────────────────────────

# Format bis 09.10.2026: "ip=X NEU push=", seitdem "ip=X stufe=<bekannt|anbieter|fremd> push="
# (Login-Wächter vergleicht IPv6 nach Anschluss /64, siehe /opt/ntfy-watch/login-watch.py).
_LOGIN_RE = re.compile(
    r"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d (?P<svc>.+?) login user=(?P<user>.*) "
    r"ip=(?P<ip>\S+)(?: stufe=(?P<stufe>\w+))?(?P<neu> NEU)? push=(?P<push>\S+)$")
_LOGIN_SYS_RE = re.compile(r"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d (?P<msg>.*)$")


def _journal_events():
    now = time.time()
    with _cache_lock:
        if now - _journal_cache["t"] < _JOURNAL_TTL:
            return _journal_cache["events"]
    events = []
    try:
        r = subprocess.run(
            _ns(["journalctl", "-u", LOGIN_UNIT, "-o", "json", "--no-pager",
                 "--output-fields=MESSAGE,_COMM,SYSLOG_IDENTIFIER"]),
            capture_output=True, text=True, timeout=20)
        lines = r.stdout.splitlines()
    except Exception:
        lines = []
    for raw in lines:
        try:
            j = json.loads(raw)
        except ValueError:
            continue
        msg = j.get("MESSAGE")
        if isinstance(msg, list):          # Nicht-UTF-8 kommt als Byte-Liste
            try:
                msg = bytes(msg).decode("utf-8", "replace")
            except Exception:
                continue
        if not isinstance(msg, str):
            continue
        try:
            ts = int(j.get("__REALTIME_TIMESTAMP", "0")) / 1e6
        except ValueError:
            ts = 0.0
        if j.get("SYSLOG_IDENTIFIER") == "systemd" or j.get("_COMM") == "systemd":
            events.append({"ts": ts, "source": "login", "kind": "info", "jail": "",
                           "ip": "", "user": "", "text": "Login-Wächter: " + msg[:300]})
            continue
        m = _LOGIN_RE.match(msg)
        if m:
            new = bool(m.group("neu")) or m.group("stufe") == "fremd"
            text = "Anmeldung erfolgreich" + (" – NEUE IP" if new else "")
            if m.group("stufe") == "anbieter":
                text += " – neuer Anschluss, bekannter Anbieter"
            if m.group("push") != "ok":
                text += " (Push fehlgeschlagen)"
            events.append({"ts": ts, "source": "login",
                           "kind": "login_new" if new else "login",
                           "jail": m.group("svc"), "ip": m.group("ip"),
                           "user": m.group("user")[:120], "text": text})
            continue
        sm = _LOGIN_SYS_RE.match(msg)
        body = sm.group("msg") if sm else msg
        events.append({"ts": ts, "source": "login",
                       "kind": "warn" if "Fehler" in body else "info",
                       "jail": "", "ip": "", "user": "", "text": body[:400]})
    with _cache_lock:
        _journal_cache["t"] = now
        _journal_cache["events"] = events
    return events


# ─── Dashboard-eigenes Entsperr-Protokoll ───────────────────────────────────

def _unban_log_events():
    events = []
    try:
        with open(UNBAN_LOG, encoding="utf-8") as fh:
            for line in fh:
                try:
                    j = json.loads(line)
                except ValueError:
                    continue
                _js = j.get("jails") or []
                events.append({"app": app_of(_js[0]) if _js else "",
                               "ts": float(j.get("ts", 0)), "source": "dashboard",
                               "kind": "manual_unban", "jail": ", ".join(j.get("jails") or []),
                               "ip": j.get("ip", ""), "user": j.get("by", ""),
                               "text": "Manuell entsperrt über das Dashboard"
                                       + ("" if j.get("ok") else " (mit Fehlern)")})
    except OSError:
        pass
    return events


# ─── Öffentliche Funktionen ─────────────────────────────────────────────────

KINDS = ("login", "login_new", "found", "perm_count", "ban", "perm_ban", "unban",
         "expired", "cf_ban", "cf_unban", "manual_unban", "warn", "info")


def _mark_kept_by_perm(events):
    """Ablauf einer Kurzsperre (unban/cf_unban) einer IP, die zu diesem Zeitpunkt
    dauerhaft gesperrt war, als "expired" kennzeichnen – sonst liest es sich, als
    wäre die IP wieder frei. Arbeitet auf Kopien (die Ereignisse sind gecacht)."""
    perm = {}
    for ev in sorted((e for e in events if e["jail"] in PERM_JAILS and e["ip"]),
                     key=lambda e: e["ts"]):
        spans = perm.setdefault(ev["ip"], [])
        if ev["kind"] == "perm_ban" and (not spans or spans[-1][1] is not None):
            spans.append([ev["ts"], None])
        elif ev["kind"] == "unban" and spans and spans[-1][1] is None:
            spans[-1][1] = ev["ts"]
    if not perm:
        return events
    out = []
    for ev in events:
        spans = perm.get(ev["ip"])
        if spans and ev["kind"] in ("unban", "cf_unban") and ev["jail"] not in PERM_JAILS and \
           any(a <= ev["ts"] and (b is None or ev["ts"] < b) for a, b in spans):
            ev = dict(ev)
            ev["kind"] = "expired"
            ev["text"] = ("Cloudflare-Eintrag der Kurzsperre entfernt – Dauersperre bleibt"
                          if ev["source"] == "cloudflare"
                          else "Kurzsperre abgelaufen – IP bleibt dauerhaft gesperrt")
        out.append(ev)
    return out
SORT_KEYS = ("ts", "source", "kind", "jail", "app", "ip", "user", "text")


def security_events(q="", kinds=None, sources=None, sort="ts", desc=True,
                    limit=200, offset=0, apps=None):
    events = []
    for p in _rotations(F2B_LOG):
        events.extend(_read_file_events(p, _parse_f2b))
    for p in _rotations(CF_LOG):
        events.extend(_read_file_events(p, _parse_cf))
    events.extend(_journal_events())
    events.extend(_unban_log_events())
    events = _mark_kept_by_perm(events)

    counts = {}
    src_counts = {}
    app_counts = {a: 0 for a in app_names()}
    apps = set(apps or []) or None
    q = (q or "").strip().lower()
    terms = q.split()
    kinds = set(kinds or []) or None
    sources = set(sources or []) or None

    def matches(ev):
        if not terms:
            return True
        hay = " ".join((ev["source"], ev["kind"], ev["jail"], ev["app"], ev["ip"], ev["user"],
                        ev["text"], datetime.fromtimestamp(ev["ts"]).strftime("%Y-%m-%d %H:%M:%S")
                        if ev["ts"] else "")).lower()
        return all(t in hay for t in terms)

    filtered = []
    for ev in events:
        if "app" not in ev:
            ev["app"] = app_of(ev["jail"])
        if not matches(ev):
            continue
        # Zähler nach Suche, aber vor Typ-/Quellenfilter → Chips zeigen,
        # was ein Klick bringen würde.
        counts[ev["kind"]] = counts.get(ev["kind"], 0) + 1
        src_counts[ev["source"]] = src_counts.get(ev["source"], 0) + 1
        if kinds and ev["kind"] not in kinds:
            continue
        if sources and ev["source"] not in sources:
            continue
        if ev["app"]:
            app_counts[ev["app"]] = app_counts.get(ev["app"], 0) + 1
        if apps and ev["app"] not in apps:
            continue
        filtered.append(ev)

    if sort not in SORT_KEYS:
        sort = "ts"
    if sort == "ts":
        filtered.sort(key=lambda e: e["ts"], reverse=desc)
    else:
        # Zweitschlüssel Zeit (neueste zuerst), damit gleiche Werte sinnvoll stehen
        filtered.sort(key=lambda e: -e["ts"])
        filtered.sort(key=lambda e: str(e[sort]).lower(), reverse=desc)

    try:
        limit = max(1, min(int(limit), 2000))
        offset = max(0, int(offset))
    except (TypeError, ValueError):
        limit, offset = 200, 0
    return {"total": len(filtered), "all": len(events), "counts": counts,
            "source_counts": src_counts, "app_counts": app_counts, "offset": offset,
            "events": filtered[offset:offset + limit]}


def _known_ips():
    try:
        with open(_host(KNOWN_IPS), encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    out = {}
    for svc, ips in (data or {}).items():
        if isinstance(ips, dict):
            for ip in ips:
                for key in {ip, _anschluss(ip)}:
                    if key and svc not in out.setdefault(key, []):
                        out[key].append(svc)
    return out


def _anschluss(ip):
    """IPv6 -> "/64"-Netz (Datenschutzadressen wechseln nur den hinteren Teil),
    IPv4 -> Adresse. Gleiche Regel wie im Login-Wächter."""
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return None
    return str(ipaddress.ip_network(f"{a}/64", strict=False)) if a.version == 6 else str(a)


def _banned_now():
    """{jail: [ip, …]} aus `fail2ban-client banned` (Python-Literal-Ausgabe)."""
    r = subprocess.run(_ns(["fail2ban-client", "banned"]),
                       capture_output=True, text=True, timeout=20)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout or "fail2ban-client fehlgeschlagen").strip()[:300])
    import ast
    data = ast.literal_eval(r.stdout.strip() or "[]")
    out = {}
    for item in data:
        for jail, ips in item.items():
            out[str(jail)] = [str(i) for i in ips]
    return out


def _ban_times():
    """{(ip, jail): (timeofban, bantime, bancount)} aus der fail2ban-DB."""
    # SQLite kann den Pfad über den magischen Symlink /proc/1/root nicht
    # öffnen ("unable to open database file") → Datei einlesen und im
    # Speicher öffnen. Nebenbei hält das keine Sperre auf fail2bans DB.
    out = {}
    try:
        with open(_host(F2B_DB), "rb") as fh:
            blob = fh.read()
        con = sqlite3.connect(":memory:")
        try:
            con.deserialize(blob)
            for ip, jail, tob, bt, cnt in con.execute(
                    "SELECT ip, jail, timeofban, bantime, bancount FROM bips"):
                out[(ip, jail)] = (tob, bt, cnt)
        finally:
            con.close()
    except sqlite3.Error:
        pass
    return out


def security_bans(my_ip=""):
    try:
        banned = _banned_now()
    except Exception as e:
        return {"error": f"fail2ban nicht abfragbar: {e}"}
    times = _ban_times()
    known = _known_ips()
    web_jails = cf_jails()
    by_ip = {}
    for jail, ips in banned.items():
        for ip in ips:
            tob, bt, cnt = times.get((ip, jail), (0, 0, 1))
            until = -1 if bt is not None and bt < 0 else (tob + bt if tob else 0)
            e = by_ip.setdefault(ip, {"ip": ip, "jails": [], "since": 0, "until": 0,
                                      "cloudflare": False, "bancount": 0,
                                      "known": known.get(ip) or known.get(_anschluss(ip)) or [],
                                      "mine": bool(my_ip) and ip == my_ip})
            e["jails"].append({"jail": jail, "app": app_of(jail), "since": tob,
                               "until": until, "bancount": cnt})
            e["since"] = max(e["since"], tob or 0)
            if until == -1 or e["until"] == -1:
                e["until"] = -1
            else:
                e["until"] = max(e["until"], until)
            e["bancount"] = max(e["bancount"], cnt or 1)
            if jail in web_jails:
                e["cloudflare"] = True
    items = sorted(by_ip.values(), key=lambda e: e["since"], reverse=True)
    for e in items:
        e["apps"] = sorted({j["app"] for j in e["jails"]})
    jail_counts = {j: len(v) for j, v in banned.items()}
    # Anwendungen mit Anzahl gesperrter IPs – alle, auch ohne Sperre; reine
    # Login-Dienste ohne Jail werden mit null geführt.
    app_counts = {a: (None if not jails else 0) for a, jails, _ in _apps()}
    for e in items:
        for a in e["apps"]:
            app_counts[a] = (app_counts.get(a) or 0) + 1
    return {"bans": items, "jails": jail_counts, "apps": app_counts,
            "my_ip": my_ip, "now": time.time()}


MANUAL_JAIL = "manuell"
MANUAL_LOG = DATA_DIR / "security_manual_bans.log"
# Nie manuell sperrbar: interne Netze + die Netze des Servers selbst (zusaetzlich zu
# ignoreip der Jail). Server-Netze aus der Datei des Schutz-Pakets (SERVER_NETZE)
# bzw. der Umgebungsvariable DASH_HOST_PUBLIC_IPS - nichts Server-Spezifisches im Code.
NETZE_FILE = "/etc/linux-dashboard/schutz-netze.generiert"
_PRIVATE_NETS = ("127.0.0.0/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
                 "100.64.0.0/10", "fc00::/7", "fe80::/10")


def _no_ban_nets():
    netze = list(_PRIVATE_NETS)
    netze += os.environ.get("DASH_HOST_PUBLIC_IPS", "").replace(",", " ").split()
    try:
        with open(HOST_ROOT + NETZE_FILE, encoding="utf-8") as fh:
            for line in fh:
                m = re.match(r'^\s*SERVER_NETZE="([^"]*)"', line)
                if m:
                    netze += m.group(1).split()
    except OSError:
        pass
    out = []
    for n in netze:
        try:
            out.append(ipaddress.ip_network(n, strict=False))
        except ValueError:
            pass
    return out


def security_ban(ip, by, my_ip=""):
    """IP manuell sperren (Jail "manuell": Cloudflare-Rand + Server-Firewall, 4 Wochen)."""
    try:
        addr = ipaddress.ip_address(str(ip).strip())
    except ValueError:
        return {"success": False, "error": "Ungültige IP-Adresse"}
    ip = str(addr)
    if not addr.is_global or any(addr in n for n in _no_ban_nets()):
        return {"success": False, "error": "Interne Adressen und der Server selbst können nicht gesperrt werden"}
    try:
        if my_ip and ipaddress.ip_address(my_ip) == addr:
            return {"success": False, "error": "Das ist deine eigene aktuelle IP – Sperre abgelehnt"}
    except ValueError:
        pass
    try:
        r = subprocess.run(_ns(["fail2ban-client", "set", MANUAL_JAIL, "banip", ip]),
                           capture_output=True, text=True, timeout=30)
        output = (r.stdout + r.stderr).strip()
    except Exception as e:
        return {"success": False, "error": str(e)}
    try:
        ok = ip in _banned_now().get(MANUAL_JAIL, [])
    except Exception:
        ok = r.returncode == 0
    try:
        with open(MANUAL_LOG, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"ts": time.time(), "ip": ip, "by": by, "ok": ok}) + "\n")
    except OSError:
        pass
    print(f"[security] {by} hat {ip} manuell gesperrt (ok={ok})", flush=True)
    return {"success": ok, "ip": ip, "error": None if ok else (output[-300:] or "Sperre nicht bestätigt")}


def security_unban(ip, by):
    try:
        ip = str(ipaddress.ip_address(str(ip).strip()))
    except ValueError:
        return {"success": False, "error": "Ungültige IP-Adresse"}
    try:
        before = [j for j, ips in _banned_now().items() if ip in ips]
    except Exception:
        before = []
    try:
        r = subprocess.run(_ns([UNBAN_SCRIPT, ip]), capture_output=True,
                           text=True, timeout=90)
        output = (r.stdout + r.stderr).strip()
        ok = r.returncode == 0
    except Exception as e:
        output, ok = str(e), False
    try:
        still = [j for j, ips in _banned_now().items() if ip in ips]
    except Exception:
        still = []
    if still:
        ok = False
    try:
        with open(UNBAN_LOG, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"ts": time.time(), "ip": ip, "by": by,
                                 "jails": before, "ok": ok}) + "\n")
    except OSError:
        pass
    print(f"[security] {by} hat {ip} entsperrt (Jails: {', '.join(before) or '-'}, ok={ok})",
          flush=True)
    return {"success": ok, "ip": ip, "jails": before, "still_banned": still,
            "output": output[-3000:]}


UNBAN_MANY_MAX = 50


def security_unban_many(ips, by):
    """Mehrere IPs nacheinander ueberall freigeben (seit 28.10.2026: Mehrfachauswahl,
    Eingabefeld und "Meine IP entsperren" im Reiter Sicherheit)."""
    if not isinstance(ips, list):
        return {"success": False, "error": "Liste von IPs erwartet"}
    gueltig, ungueltig = [], []
    for raw in ips:
        try:
            ip = str(ipaddress.ip_address(str(raw).strip()))
        except ValueError:
            ungueltig.append(str(raw)[:60])
            continue
        if ip not in gueltig:
            gueltig.append(ip)
    if not gueltig:
        return {"success": False, "error": "Keine gültige IP-Adresse", "invalid": ungueltig}
    if len(gueltig) > UNBAN_MANY_MAX:
        return {"success": False, "error": f"Höchstens {UNBAN_MANY_MAX} IPs auf einmal"}
    ergebnisse = [security_unban(ip, by) for ip in gueltig]
    return {"success": all(r.get("success") for r in ergebnisse),
            "done": [r["ip"] for r in ergebnisse if r.get("success")],
            "failed": [{"ip": r.get("ip"), "still_banned": r.get("still_banned"), "error": r.get("error")}
                       for r in ergebnisse if not r.get("success")],
            "invalid": ungueltig}
