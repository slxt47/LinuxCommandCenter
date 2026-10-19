"""Öffentliche, zeitlich begrenzte VM-Freigaben (Gast-Links).

Ein Admin erzeugt für eine VM einen Link mit frei wählbarer Laufzeit. Wer den
Link kennt, bekommt OHNE Login ausschließlich die Konsole dieser einen VM
(Maus/Tastatur/Zwischenablage) — keine Verbindungs- oder VNC-Einstellungen,
keine Dashboard-API. Die Freigabe endet automatisch zum Ablaufzeitpunkt oder
sofort beim Widerruf; offene Konsolen-Verbindungen werden dabei hart getrennt.

Persistenz: /data/vm_shares.json (atomar geschrieben), damit Freigaben einen
Container-Neustart überleben.

Netzisolation (Audit-Fund M3, 19.09.2026): Mit der ersten aktiven Freigabe
einer VM bekommt jede ihrer Netzwerkkarten den nwfilter
`dashboard-share-isolate` (siehe dashboard/vmisolate.py) — der Gast kommt
damit ins Internet, aber nicht an Host, Docker-/libvirt-Netze, Tailscale oder
SMTP. Endet die letzte Freigabe (Ablauf, Widerruf, VM gelöscht), wird der
vorherige Zustand wiederhergestellt. Kann der Filter nicht gesetzt werden,
wird die Freigabe verweigert — lieber kein Gast-Link als ein ungefilterter.
"""

import json
import os
import secrets
import socket
import threading
import time

from dashboard import vmisolate
from dashboard.base import DATA_DIR

_SHARES_FILE = DATA_DIR / "vm_shares.json"

MIN_MINUTES = 1
MAX_MINUTES = 60 * 24 * 30          # 30 Tage — genug für jeden sinnvollen Einsatz
SHARE_COOKIE = "vmshare"
_TYPES = ("kasmvnc", "vnc", "spice")


class VMShareManager:
    def __init__(self):
        self._lock = threading.RLock()
        self._shares = {}      # id -> dict
        self._conns = {}       # id -> set(socket)  (offene Konsolen-Verbindungen)
        self._load()
        threading.Thread(target=self._watchdog, daemon=True).start()

    # ── Persistenz ───────────────────────────────────────────────────────────

    def _load(self):
        try:
            if _SHARES_FILE.exists():
                data = json.loads(_SHARES_FILE.read_text())
                if isinstance(data, dict):
                    self._shares = {k: v for k, v in data.items()
                                    if isinstance(v, dict) and v.get("vm")}
        except Exception as e:
            print(f"[vmshare] Freigaben konnten nicht geladen werden: {e}", flush=True)
            self._shares = {}
        self._release(self._purge_locked())

    def _save_locked(self):
        try:
            tmp = _SHARES_FILE.with_name(_SHARES_FILE.name + ".tmp")
            tmp.write_text(json.dumps(self._shares, indent=1))
            os.replace(tmp, _SHARES_FILE)
        except Exception as e:
            print(f"[vmshare] Freigaben konnten nicht gespeichert werden: {e}", flush=True)

    def _purge_locked(self):
        """Abgelaufene Freigaben entfernen; liefert die entfernten Datensätze
        (für _release — das muss OHNE Lock passieren, virsh braucht Zeit)."""
        now = time.time()
        dead = [k for k, v in self._shares.items() if float(v.get("expires", 0)) <= now]
        return [self._shares.pop(k) for k in dead if k in self._shares]

    # ── Netzisolation ────────────────────────────────────────────────────────

    def _active_for_vm_locked(self, vm):
        now = time.time()
        return [v for v in self._shares.values()
                if v.get("vm") == vm and float(v.get("expires", 0)) > now]

    def _release(self, removed):
        """Nach dem Entfernen von Freigaben: nwfilter der VMs zurücksetzen, die
        keine aktive Freigabe mehr haben. Ohne Lock aufrufen."""
        per_vm = {}
        for r in removed or ():
            vm = r.get("vm")
            if vm and vm not in per_vm:
                per_vm[vm] = r.get("nwfilter_orig") or {}
        for vm, orig in per_vm.items():
            with self._lock:
                if self._active_for_vm_locked(vm):
                    continue
            try:
                res = vmisolate.restore(vm, orig)
                if res.get("error"):
                    print(f"[vmshare] Netzisolation von {vm} nicht zurückgesetzt: {res['error']}", flush=True)
            except Exception as e:
                print(f"[vmshare] Netzisolation von {vm} nicht zurückgesetzt: {e}", flush=True)

    # ── Öffentliche Darstellung ──────────────────────────────────────────────

    @staticmethod
    def _public(s):
        now = time.time()
        d = dict(s)
        d["remaining"] = max(0, int(float(s.get("expires", 0)) - now))
        return d

    # ── Verwaltung (Admin) ───────────────────────────────────────────────────

    def create(self, vm, created_by, minutes, ctype="kasmvnc", note=""):
        try:
            minutes = int(minutes)
        except (TypeError, ValueError):
            return {"error": "Laufzeit (Minuten) ungültig"}
        if minutes < MIN_MINUTES or minutes > MAX_MINUTES:
            return {"error": f"Laufzeit muss zwischen {MIN_MINUTES} und {MAX_MINUTES} Minuten liegen"}
        if ctype not in _TYPES:
            return {"error": f"Unbekannter Konsolentyp: {ctype}"}
        if not vm:
            return {"error": "VM-Name erforderlich"}
        note = (note or "").strip()[:80]
        with self._lock:
            removed = self._purge_locked()
            existing = self._active_for_vm_locked(vm)
        self._release(removed)
        # Netzisolation VOR dem Anlegen — schlägt sie fehl, gibt es keinen Link.
        # Läuft schon eine Freigabe für diese VM, trägt deren Datensatz den
        # echten Ausgangszustand; apply() ist dann nur eine Kontrolle.
        try:
            iso = vmisolate.apply(vm)
        except Exception as e:
            iso = {"error": str(e)}
        if iso.get("error"):
            print(f"[vmshare] Freigabe für {vm} verweigert: {iso['error']}", flush=True)
            return {"error": "Freigabe verweigert — Netzisolation der VM konnte nicht gesetzt "
                             "werden: " + iso["error"]}
        orig = existing[0].get("nwfilter_orig", {}) if existing else iso.get("orig", {})
        now = time.time()
        sid = secrets.token_urlsafe(24)
        rec = {
            "id": sid,
            "vm": vm,
            "type": ctype,
            "note": note,
            "created_by": created_by or "",
            "created": now,
            "expires": now + minutes * 60,
            "minutes": minutes,
            "views": 0,
            "last_access": None,
            "last_ip": "",
            "nwfilter_orig": orig,
        }
        with self._lock:
            self._shares[sid] = rec
            self._save_locked()
        return {"success": True, "share": self._public(rec)}

    def extend(self, sid, minutes):
        try:
            minutes = int(minutes)
        except (TypeError, ValueError):
            return {"error": "Minuten ungültig"}
        if minutes < MIN_MINUTES or minutes > MAX_MINUTES:
            return {"error": f"Verlängerung muss zwischen {MIN_MINUTES} und {MAX_MINUTES} Minuten liegen"}
        with self._lock:
            s = self._shares.get(sid)
            if not s or float(s.get("expires", 0)) <= time.time():
                return {"error": "Freigabe nicht gefunden oder bereits abgelaufen"}
            new_exp = float(s["expires"]) + minutes * 60
            if new_exp - time.time() > MAX_MINUTES * 60:
                return {"error": f"Gesamtlaufzeit darf {MAX_MINUTES} Minuten nicht überschreiten"}
            s["expires"] = new_exp
            self._save_locked()
            return {"success": True, "share": self._public(s)}

    def revoke(self, sid):
        with self._lock:
            s = self._shares.pop(sid, None)
            if s:
                self._save_locked()
        if not s:
            return {"error": "Freigabe nicht gefunden"}
        self._close_conns(sid)
        self._release([s])
        return {"success": True}

    def revoke_vm(self, vm):
        """Alle Freigaben einer VM beenden (z. B. beim Löschen der VM)."""
        with self._lock:
            ids = [k for k, v in self._shares.items() if v.get("vm") == vm]
            recs = [self._shares.pop(k) for k in ids if k in self._shares]
            if ids:
                self._save_locked()
        for k in ids:
            self._close_conns(k)
        self._release(recs)
        return len(ids)

    def list_for_vm(self, vm):
        with self._lock:
            self._purge_locked()
            items = [self._public(s) for s in self._shares.values() if s.get("vm") == vm]
        items.sort(key=lambda s: s.get("created", 0), reverse=True)
        for it in items:
            it["connections"] = self.conn_count(it["id"])
        return items

    def count_active(self, vm):
        now = time.time()
        with self._lock:
            return sum(1 for s in self._shares.values()
                       if s.get("vm") == vm and float(s.get("expires", 0)) > now)

    # ── Gast-Zugriff ─────────────────────────────────────────────────────────

    def get_valid(self, sid):
        """Freigabe-Datensatz, falls vorhanden und noch nicht abgelaufen, sonst None."""
        if not sid or not isinstance(sid, str) or len(sid) > 64:
            return None
        with self._lock:
            s = self._shares.get(sid)
            if not s:
                return None
            if float(s.get("expires", 0)) <= time.time():
                self._shares.pop(sid, None)
                self._save_locked()
                return None
            return dict(s)

    def touch(self, sid, ip=""):
        with self._lock:
            s = self._shares.get(sid)
            if not s:
                return
            s["views"] = int(s.get("views", 0)) + 1
            s["last_access"] = time.time()
            s["last_ip"] = ip or ""
            self._save_locked()

    # ── Verbindungs-Tracking (für hartes Trennen bei Ablauf/Widerruf) ───────

    def register_conn(self, sid, *socks):
        with self._lock:
            self._conns.setdefault(sid, set()).update(socks)

    def unregister_conn(self, sid, *socks):
        with self._lock:
            st = self._conns.get(sid)
            if not st:
                return
            for s in socks:
                st.discard(s)
            if not st:
                self._conns.pop(sid, None)

    def conn_count(self, sid):
        with self._lock:
            return len(self._conns.get(sid, ()))

    def _close_conns(self, sid):
        with self._lock:
            socks = list(self._conns.pop(sid, ()))
        for s in socks:
            try:
                s.shutdown(socket.SHUT_RDWR)
            except Exception:
                pass
            try:
                s.close()
            except Exception:
                pass

    def _watchdog(self):
        """Abgelaufene Freigaben aufräumen und deren offene Verbindungen kappen."""
        while True:
            time.sleep(10)
            try:
                now = time.time()
                with self._lock:
                    expired = [k for k, v in self._shares.items()
                               if float(v.get("expires", 0)) <= now]
                    # Verbindungen, deren Freigabe (z. B. durch Widerruf) nicht mehr existiert
                    orphan = [k for k in self._conns if k not in self._shares]
                    recs = [self._shares.pop(k) for k in expired if k in self._shares]
                    if expired:
                        self._save_locked()
                for k in set(expired) | set(orphan):
                    self._close_conns(k)
                self._release(recs)
            except Exception as e:
                print(f"[vmshare] Watchdog-Fehler: {e}", flush=True)


_share_mgr = VMShareManager()


# ─── Gast-Oberfläche: Badge + Ausblenden der Konsolen-Einstellungen ─────────

def share_guest_inject(share, kind="kasmvnc"):
    """HTML-Schnipsel für die Konsole eines Gast-Links.

    kind="kasmvnc": blendet zusätzlich die KasmVNC-Steuerleiste aus (Verbindungs-,
    Qualitäts- und Anzeige-Einstellungen, Trennen) — der Gast sieht und bedient
    nur den VM-Bildschirm. Bei noVNC/SPICE gibt es keine solche Leiste; dort
    genügt das Badge mit der Restlaufzeit.
    """
    exp = int(float(share.get("expires", 0)))
    sid = share.get("id", "")
    vm  = share.get("vm", "")
    css = ""
    if kind == "kasmvnc":
        css = (
            "#noVNC_control_bar_anchor,#noVNC_control_bar,#noVNC_control_bar_handle,"
            "#noVNC_control_bar_hint,#noVNC_hint_anchor{display:none!important}"
        )
    html = (
        "<style>" + css +
        "#_lccShare{position:fixed;top:6px;left:50%;transform:translateX(-50%);z-index:2147483645;"
        "background:rgba(6,8,13,.72);color:#8b9dc3;border:1px solid rgba(255,255,255,.12);"
        "border-radius:999px;padding:4px 12px;font:11px/1.4 ui-monospace,Menlo,monospace;"
        "pointer-events:none;white-space:nowrap;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);"
        "opacity:.85;transition:opacity .3s}"
        "#_lccShare b{color:#3d9bff;font-weight:600}"
        "#_lccShareEnd{position:fixed;inset:0;z-index:2147483647;display:none;align-items:center;justify-content:center;"
        "background:rgba(6,8,13,.94);color:#e2e8f0;font:15px/1.6 system-ui,sans-serif;text-align:center;padding:24px}"
        "#_lccShareEnd a{color:#3d9bff}"
        "</style>"
        '<div id="_lccShare">&#128279; Freigabe <b>' + _esc(vm) + '</b> &middot; endet in <span id="_lccShareT">…</span></div>'
        '<div id="_lccShareEnd"><div><div style="font-size:40px;margin-bottom:12px">&#9203;</div>'
        '<b>Die Freigabe ist abgelaufen.</b><br>Der Zugriff auf diese VM wurde beendet.</div></div>'
        "<script>(function(){"
        "var exp=" + str(exp) + "*1000,sid=" + json.dumps(sid) + ";"
        "function fmt(ms){var s=Math.max(0,Math.floor(ms/1000)),h=Math.floor(s/3600),m=Math.floor(s%3600/60);"
        "return h>0?(h+' h '+(m<10?'0':'')+m+' min'):(m>0?(m+' min'):(s+' s'));}"
        "function tick(){var left=exp-Date.now();var t=document.getElementById('_lccShareT');"
        "if(t)t.textContent=fmt(left);"
        "var b=document.getElementById('_lccShare');if(b&&left<5*60*1000)b.style.color='#f59e0b';"
        "if(left<=0){var e=document.getElementById('_lccShareEnd');if(e)e.style.display='flex';return;}"
        "setTimeout(tick,1000);}"
        "if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',tick);else tick();"
        # Badge nach kurzer Zeit dezenter machen, damit es nicht stört
        "setTimeout(function(){var b=document.getElementById('_lccShare');if(b)b.style.opacity='.45';},8000);"
        "})();</script>"
    )
    return html.encode("utf-8")


def _esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


_PAGE_CSS = (
    "*{box-sizing:border-box;margin:0;padding:0}"
    "body{font-family:'Space Grotesk',system-ui,sans-serif;background:#06080d;color:#e2e8f0;"
    "min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}"
    ".box{background:#151d2e;border:1px solid #2a3a52;border-radius:20px;padding:40px 36px;"
    "width:100%;max-width:440px;text-align:center}"
    ".ico{font-size:44px;margin-bottom:14px}"
    "h1{font-size:19px;font-weight:600;margin-bottom:10px}"
    "p{color:#8b9dc3;font-size:14px;line-height:1.6}"
    ".btn{display:inline-block;margin-top:22px;background:#3d9bff;color:#06080d;font-weight:600;"
    "text-decoration:none;padding:12px 22px;border-radius:10px;font-size:14px}"
    ".mono{font-family:ui-monospace,Menlo,monospace;color:#4a5e80;font-size:11px;margin-top:18px}"
)


def share_page(title, text, icon="&#128274;", button=None):
    """Kleine Hinweis-Seite für Gäste (abgelaufen, VM aus, Verbindung beendet)."""
    btn = f'<a class="btn" href="{_esc(button[1])}">{_esc(button[0])}</a>' if button else ""
    html = (
        "<!DOCTYPE html><html lang='de'><head><meta charset='UTF-8'>"
        "<meta name='viewport' content='width=device-width, initial-scale=1.0'>"
        f"<title>{_esc(title)}</title><style>{_PAGE_CSS}</style></head><body>"
        f"<div class='box'><div class='ico'>{icon}</div><h1>{_esc(title)}</h1><p>{text}</p>{btn}"
        "<div class='mono'>Linux Command Center &middot; VM-Freigabe</div></div></body></html>"
    )
    return html.encode("utf-8")
