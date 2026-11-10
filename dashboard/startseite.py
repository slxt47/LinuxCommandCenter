"""Reiter „Startseite“: die Kacheln des eigenen Dashboards (dash.slxt.dev) im Command Center.

Das Command Center holt die Daten serverseitig vom Startseiten-Container
(http://127.0.0.1:9310/api/intern/start, Admin-Sicht, nur lesend). Der Browser
spricht nie direkt mit der Startseite; dash.slxt.dev selbst bleibt unverändert.

- Token: /data/startseite-token (Rechte 0600, gleiches Token wie
  STARTSEITE_INTERN_TOKEN in ~/startseite/intern.env). Fehlt es, ist der
  Reiter leer mit Hinweis.
- Adresse änderbar über STARTSEITE_INTERN_URL (dashboard.env).
- Antwort 30 s zwischengespeichert, damit Neuladen die Startseite nicht belastet.
"""

import json
import os
import threading
import time
import urllib.error
import urllib.request

from dashboard.base import DATA_DIR

TOKEN_FILE = DATA_DIR / "startseite-token"
URL = os.environ.get("STARTSEITE_INTERN_URL", "http://127.0.0.1:9310/api/intern/start")
CACHE_S = 30
_lock = threading.Lock()
_cache = {"zeit": 0.0, "daten": None}


def _token():
    try:
        with open(TOKEN_FILE, encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return ""


def startseite_daten(neu=False):
    with _lock:
        if not neu and _cache["daten"] is not None and time.time() - _cache["zeit"] < CACHE_S:
            return _cache["daten"]
    token = _token()
    if not token:
        return {"error": "Kein Token hinterlegt (/var/lib/linux-dashboard/startseite-token)."}
    req = urllib.request.Request(URL, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=6) as r:
            daten = json.loads(r.read(4 * 1024 * 1024))
    except urllib.error.HTTPError as e:
        return {"error": f"Startseite antwortet mit {e.code}."}
    except (OSError, ValueError):
        return {"error": "Startseite nicht erreichbar."}
    with _lock:
        _cache.update(zeit=time.time(), daten=daten)
    return daten
