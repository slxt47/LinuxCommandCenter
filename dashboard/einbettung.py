"""Eingebettete Apps (Reiter „Konten“, „Backups“, „IT-Tools“) – seit 10.11.2026.

Ehemals eigene Seiten (claude/twilio/cloudflare/hetzner/backup/tools.slxt.dev) laufen nur noch lokal
und sind ausschließlich über diesen Proxy erreichbar. Sicherheitsmodell:

1. Fähigkeits-URL statt Cookie: /einbettung/<schlüssel>/<app>/<pfad>. Den Schlüssel gibt es nur für eine
   gültige Superadmin-Sitzung (GET /api/einbettung?app=…), er ist an genau diese Sitzung und App gebunden,
   läuft nach SCHLUESSEL_S ab und wird mit der Sitzung (Abmelden, Ablauf) ungültig. Die Rolle wird bei
   JEDER Anfrage live geprüft.
2. Der Browser lädt die App in einem iframe mit sandbox OHNE allow-same-origin, und der Proxy setzt
   zusätzlich die CSP-Direktive `sandbox` – auch direkt geöffnet läuft die App in einem undurchsichtigen
   Ursprung: kein Zugriff auf das Command Center, seine Cookies, sein DOM oder seinen Speicher.
3. Zur App gehen nur ausgewählte Kopfzeilen (nie Cookies, nie Cf-*/Authorization/X-Forwarded-*). Das
   interne Token der App (Datei unter /data/einbettung/, 0600) setzt nur der Server; der Browser sieht es nie.
4. Schreibende Anfragen: nur POST, nur mit Origin „null“ (der Sandbox), höchstens 64 KB; der Proxy setzt
   dann die Origin, die die App erwartet. Die App prüft ihre eigenen Regeln (X-Aktion, JSON, Drossel …)
   weiter selbst.
5. Antworten: keine Set-Cookie, frame-ancestors 'self', Referrer-Policy no-referrer, nosniff, no-store
   für alles außer Dateien mit Versions-Hash.
"""

import http.client
import os
import re
import secrets
import threading
import time

from dashboard.base import DATA_DIR

SCHLUESSEL_S = 8 * 3600
TOKEN_DIR = DATA_DIR / "einbettung"

# app -> Ziel. host = Host-Kopfzeile, die die App erwartet (nginx/Aktions-Dienst prüfen sie);
# token = Datei mit dem internen Token (oder None, wenn die App keins braucht)
APPS = {
    "claude":     {"port": 9304, "host": "claude.slxt.dev",     "token": None},
    "twilio":     {"port": 9303, "host": "twilio.slxt.dev",     "token": None},
    "cloudflare": {"port": 9302, "host": "cloudflare.slxt.dev", "token": "cloudflare"},
    "hetzner":    {"port": 9301, "host": "hetzner.slxt.dev",    "token": "hetzner"},
    "backup":     {"port": 9320, "host": "backup.slxt.dev",     "token": "backup"},
    "tools":      {"port": 89,   "host": "tools.slxt.dev",      "token": None},
}

PFAD_RE = re.compile(r"^/einbettung/([A-Za-z0-9_-]{43})/([a-z]+)(/[^?#]*)?$")
ANFRAGE_KOEPFE = ("Accept", "Accept-Language", "Content-Type", "Range", "If-None-Match",
                  "If-Modified-Since", "X-Aktion")
ANTWORT_KOEPFE = ("Content-Type", "Content-Length", "Content-Disposition", "Content-Range", "Accept-Ranges",
                  "Last-Modified", "ETag")
SANDBOX = "sandbox allow-scripts allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox allow-modals"
# Für Apps ohne eigene CSP (it-tools): eng, aber genug für Vue/Wasm-Werkzeuge im Browser
CSP_STANDARD = ("default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; "
                "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' data: blob:; "
                "worker-src 'self' blob:; media-src 'self' data: blob:; object-src 'none'; base-uri 'none'; "
                "form-action 'none'")
MAX_POST = 64 * 1024

_lock = threading.Lock()
_schluessel = {}   # schluessel -> {"sitzung", "app", "bis"}


def schluessel_geben(sitzung: str, app: str) -> str:
    """Neuen Schlüssel für (Sitzung, App). Alte, abgelaufene werden dabei aufgeräumt."""
    jetzt = time.time()
    s = secrets.token_urlsafe(32)          # 43 Zeichen
    with _lock:
        for k in [k for k, v in _schluessel.items() if v["bis"] < jetzt]:
            del _schluessel[k]
        # höchstens 20 Schlüssel je Sitzung (jede neue Ansicht holt einen)
        eigene = sorted((v["bis"], k) for k, v in _schluessel.items() if v["sitzung"] == sitzung)
        for _, k in eigene[:-19]:
            del _schluessel[k]
        _schluessel[s] = {"sitzung": sitzung, "app": app, "bis": jetzt + SCHLUESSEL_S}
    return s


def schluessel_pruefen(s: str, app: str):
    """Sitzungs-Token zum Schlüssel, wenn gültig und zur App passend, sonst None."""
    with _lock:
        v = _schluessel.get(s)
        if not v or v["bis"] < time.time():
            _schluessel.pop(s, None)
            return None
        if not secrets.compare_digest(v["app"], app):
            return None
        return v["sitzung"]


def sitzung_beenden(sitzung: str) -> None:
    with _lock:
        for k in [k for k, v in _schluessel.items() if v["sitzung"] == sitzung]:
            del _schluessel[k]


def _token(name):
    if not name:
        return ""
    try:
        with open(TOKEN_DIR / f"{name}.token", encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return ""


def pfad_maskieren(text: str) -> str:
    """Für Protokolle: Schlüssel nie mitschreiben."""
    return re.sub(r"/einbettung/[A-Za-z0-9_-]{20,}/", "/einbettung/***/", str(text))


def _csp(upstream: str) -> str:
    teile = [t.strip() for t in (upstream or CSP_STANDARD).split(";") if t.strip()]
    teile = [t for t in teile if not t.lower().startswith(("frame-ancestors", "sandbox", "report-uri", "report-to"))]
    return "; ".join(teile + ["frame-ancestors 'self'", SANDBOX])


def _fehler(handler, code, text):
    body = text.encode()
    handler.send_response(code)
    handler.send_header("Content-Type", "text/plain; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'self'; " + SANDBOX)
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler.end_headers()
    if handler.command != "HEAD":
        handler.wfile.write(body)


def bearbeiten(handler, methode, body=b""):
    """Eine Anfrage unter /einbettung/ beantworten. handler: DashboardHandler (für Rolle/Antwort)."""
    from urllib.parse import urlsplit
    teile = urlsplit(handler.path)
    m = PFAD_RE.match(teile.path)
    if not m or m.group(2) not in APPS:
        return _fehler(handler, 404, "Nicht gefunden")
    schluessel, app, rest = m.group(1), m.group(2), m.group(3) or "/"
    sitzung = schluessel_pruefen(schluessel, app)
    benutzer = handler._sitzung_benutzer_rolle(sitzung) if sitzung else None
    if not benutzer or benutzer[1] != "superadmin":
        return _fehler(handler, 403, "Ansicht abgelaufen – bitte im Command Center neu öffnen.")
    if ".." in rest or "\\" in rest or "%2e" in rest.lower() or "%2f" in rest.lower():
        return _fehler(handler, 400, "Ungültiger Pfad")

    ziel = APPS[app]
    if methode == "OPTIONS":
        handler.send_response(204)
        handler.send_header("Access-Control-Allow-Origin", "null")
        handler.send_header("Access-Control-Allow-Methods", "GET, POST")
        handler.send_header("Access-Control-Allow-Headers", "Content-Type, X-Aktion")
        handler.send_header("Access-Control-Max-Age", "600")
        handler.send_header("Vary", "Origin")
        handler.end_headers()
        return None
    if methode not in ("GET", "HEAD", "POST"):
        return _fehler(handler, 405, "Methode nicht erlaubt")

    koepfe = {"Host": ziel["host"], "User-Agent": "linux-dashboard-einbettung/1", "Connection": "close"}
    for k in ANFRAGE_KOEPFE:
        v = handler.headers.get(k)
        if v is not None:
            koepfe[k] = v[:1024]
    if methode == "POST":
        if handler.headers.get("Origin") != "null":
            return _fehler(handler, 403, "Anfrage nicht aus der eingebetteten Ansicht")
        if len(body) > MAX_POST:
            return _fehler(handler, 413, "Zu groß")
        koepfe["Origin"] = f"https://{ziel['host']}"
        koepfe["Content-Length"] = str(len(body))
    tok = _token(ziel["token"])
    if tok:
        koepfe["X-CC-Token"] = tok
        koepfe["X-CC-Benutzer"] = re.sub(r"[^A-Za-z0-9._-]", "", benutzer[0])[:32]

    pfad = rest + (("?" + teile.query) if teile.query else "")
    try:
        verb = http.client.HTTPConnection("127.0.0.1", ziel["port"], timeout=120)
        verb.request(methode, pfad, body=body if methode == "POST" else None, headers=koepfe)
        antw = verb.getresponse()
    except OSError:
        return _fehler(handler, 502, f"{app} ist gerade nicht erreichbar.")
    try:
        handler.send_response(antw.status)
        for k in ANTWORT_KOEPFE:
            v = antw.getheader(k)
            if v is not None:
                handler.send_header(k, v)
        ort = antw.getheader("Location")
        if ort and ort.startswith("/") and not ort.startswith("//"):
            handler.send_header("Location", f"/einbettung/{schluessel}/{app}{ort}")
        cc = antw.getheader("Cache-Control") or ""
        statisch = re.search(r"/(assets|static)/", rest) and "immutable" in cc
        handler.send_header("Cache-Control", "private, max-age=31536000, immutable" if statisch else "no-store")
        handler.send_header("Content-Security-Policy", _csp(antw.getheader("Content-Security-Policy")))
        handler.send_header("X-Content-Type-Options", "nosniff")
        handler.send_header("Access-Control-Allow-Origin", "null")   # Sandbox-Ursprung; Zugang regelt der Schlüssel
        handler.send_header("Vary", "Origin")
        handler.send_header("Cross-Origin-Opener-Policy", "same-origin")
        handler.send_header("X-Robots-Tag", "noindex, nofollow")
        handler.end_headers()
        if methode != "HEAD":
            while True:
                stueck = antw.read(64 * 1024)
                if not stueck:
                    break
                handler.wfile.write(stueck)
    except (BrokenPipeError, ConnectionResetError):
        pass
    finally:
        verb.close()
    return None
