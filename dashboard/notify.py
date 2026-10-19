"""Reiter "Benachrichtigungen": die letzten Meldungen des eigenen ntfy-Servers.

Konfiguration in /data/ntfy.json (Rechte 0600, gehoert nicht ins Git):

    {"url": "http://127.0.0.1:8090",        lokal abfragen (Container laeuft im Host-Netz)
     "public_url": "https://ntfy.example.org",  fuer den Link "ntfy oeffnen"
     "token": "tk_...",                      Token eines NUR-LESE-Benutzers
     "topics": ["ssh", "fail2ban", ...]}

ntfy liefert mit ?poll=1 die zwischengespeicherten Nachrichten (cache-duration)
als JSON-Zeilen. Titel und Text stammen u. a. aus fail2ban-Meldungen und damit
indirekt von Angreifern: das Frontend escapt alles, hier wird nur geparst.
Fehlt die Datei, liefert die API "configured": false und die Seite zeigt einen Hinweis.
"""

import json
import threading
import time
import urllib.error
import urllib.request

from dashboard.base import DATA_DIR

CONFIG_FILE = DATA_DIR / "ntfy.json"
_CACHE_TTL = 10
_cache = {"t": 0.0, "key": None, "data": None}
_lock = threading.Lock()


def _config():
    try:
        with open(CONFIG_FILE, encoding="utf-8") as fh:
            cfg = json.load(fh)
        topics = [str(t) for t in cfg.get("topics") or [] if str(t).strip()]
        if not cfg.get("url") or not topics:
            return None
        return {"url": str(cfg["url"]).rstrip("/"), "public_url": str(cfg.get("public_url") or ""),
                "token": str(cfg.get("token") or ""), "topics": topics}
    except (OSError, ValueError, TypeError):
        return None


def ntfy_messages(since="24h", limit=200):
    """Neueste Nachrichten aller konfigurierten Themen, absteigend nach Zeit."""
    cfg = _config()
    if not cfg:
        return {"configured": False, "messages": [], "topics": []}
    since = since if since in ("1h", "6h", "24h", "all") else "24h"
    try:
        limit = max(1, min(int(limit), 500))
    except (TypeError, ValueError):
        limit = 200
    key = (since, limit)
    now = time.time()
    with _lock:
        if _cache["key"] == key and now - _cache["t"] < _CACHE_TTL:
            return _cache["data"]

    url = f"{cfg['url']}/{','.join(cfg['topics'])}/json?poll=1&since={since}"
    req = urllib.request.Request(url)
    if cfg["token"]:
        req.add_header("Authorization", f"Bearer {cfg['token']}")
    result = {"configured": True, "public_url": cfg["public_url"], "topics": cfg["topics"],
              "messages": [], "error": None}
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            for raw in resp:
                try:
                    m = json.loads(raw)
                except ValueError:
                    continue
                if m.get("event") != "message":
                    continue
                result["messages"].append({
                    "id": str(m.get("id", "")),
                    "time": int(m.get("time") or 0),
                    "topic": str(m.get("topic", "")),
                    "title": str(m.get("title") or ""),
                    "message": str(m.get("message") or ""),
                    "priority": int(m.get("priority") or 3),
                    "tags": [str(t) for t in (m.get("tags") or [])],
                })
    except urllib.error.HTTPError as e:
        result["error"] = f"ntfy antwortet mit HTTP {e.code}"
    except (urllib.error.URLError, OSError) as e:
        result["error"] = f"ntfy nicht erreichbar: {getattr(e, 'reason', e)}"
    result["messages"].sort(key=lambda m: m["time"], reverse=True)
    result["messages"] = result["messages"][:limit]
    with _lock:
        _cache.update(t=now, key=key, data=result)
    return result
