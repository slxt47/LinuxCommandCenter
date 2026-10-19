"""Persoenliche Einstellungen je Dashboard-Benutzer (seit 19.10.2026).

- hidden_pages: Tabs, die der Benutzer ausgeblendet hat (rein optisch; Rechte
  regelt weiterhin die Rolle).
- ssh_default: Standard-Zugangsdaten fuer SSH/SCP-Verbindungen (Benutzer,
  Passwort, privater Schluessel, Schluessel-Passphrase).

Gespeichert in /data/user_prefs.json (Rechte 0600). Geheimnisse verlassen den
Server nie: die API liefert nur, OB ein Passwort/Schluessel hinterlegt ist.
"""

import json
import os
import threading

from dashboard.base import DATA_DIR

PREFS_FILE = DATA_DIR / "user_prefs.json"
# Tabs, die ausgeblendet werden duerfen (Dashboard und Einstellungen bleiben immer)
HIDEABLE_PAGES = ("processes", "terminal", "updates", "vms", "docker", "services",
                  "connections", "browser", "security", "notifications", "users")
_MAX_KEY_LEN = 16384
_lock = threading.Lock()


def _load():
    try:
        with open(PREFS_FILE, encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(data):
    tmp = f"{PREFS_FILE}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=1)
    os.replace(tmp, PREFS_FILE)


def get_prefs(user):
    """Einstellungen fuer die Oberflaeche - ohne Geheimnisse."""
    with _lock:
        p = _load().get(user, {})
    d = p.get("ssh_default") or {}
    return {
        "hidden_pages": [x for x in p.get("hidden_pages", []) if x in HIDEABLE_PAGES],
        "hideable_pages": list(HIDEABLE_PAGES),
        "ssh_default": {
            "username": d.get("username", ""),
            "has_password": bool(d.get("password")),
            "has_key": bool(d.get("private_key")),
            "has_passphrase": bool(d.get("passphrase")),
        },
    }


def ssh_default_secret(user):
    """Vollstaendige Standard-Zugangsdaten (nur serverseitig verwenden)."""
    with _lock:
        return dict((_load().get(user, {}).get("ssh_default") or {}))


def set_prefs(user, data, validate_key=None):
    """Aenderungen uebernehmen. Leere Geheimnis-Felder lassen den alten Wert stehen;
    clear_password / clear_key loeschen ihn ausdruecklich."""
    if not user:
        return {"success": False, "error": "Nicht angemeldet"}
    with _lock:
        allp = _load()
        p = allp.setdefault(user, {})
        if "hidden_pages" in data:
            hp = data.get("hidden_pages") or []
            if not isinstance(hp, list):
                return {"success": False, "error": "hidden_pages muss eine Liste sein"}
            p["hidden_pages"] = sorted({str(x) for x in hp if str(x) in HIDEABLE_PAGES})
        if "ssh_default" in data:
            s = data.get("ssh_default") or {}
            d = p.setdefault("ssh_default", {})
            if "username" in s:
                d["username"] = str(s.get("username") or "").strip()[:64]
            if s.get("clear_password"):
                d.pop("password", None)
            elif s.get("password"):
                d["password"] = str(s["password"])[:512]
            if s.get("clear_key"):
                d.pop("private_key", None)
                d.pop("passphrase", None)
            else:
                if s.get("passphrase"):
                    d["passphrase"] = str(s["passphrase"])[:512]
                if s.get("private_key"):
                    key = str(s["private_key"]).strip()
                    if len(key) > _MAX_KEY_LEN:
                        return {"success": False, "error": "Schlüssel zu lang"}
                    if validate_key:
                        err = validate_key(key, d.get("passphrase") or None)
                        if err:
                            return {"success": False, "error": err}
                    d["private_key"] = key + "\n"
        _save(allp)
    return {"success": True, "prefs": get_prefs(user)}
