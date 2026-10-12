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

from dashboard.base import KASMVNC_WWW_DIR, KASM_CLIENT_DIR

class ProxyManager:
    """Manages websockify processes for browser-based VNC and SPICE consoles."""

    def __init__(self):
        self._proxies = {}
        self._lock = threading.Lock()

    def _free_port(self):
        used = {p["port"] for p in self._proxies.values()}
        for port in range(6900, 7000):
            if port in used:
                continue
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                    s.bind(("127.0.0.1", port))
                    return port
            except OSError:
                continue
        raise RuntimeError("Kein freier Port im Bereich 6900-6999")

    def get_or_start(self, key, target, web_dir):
        with self._lock:
            if key in self._proxies:
                info = self._proxies[key]
                if info["proc"].poll() is None:  # still running
                    return info["port"]
                _ws_unregister_port(info["port"])
                del self._proxies[key]

            port = self._free_port()
            proc = subprocess.Popen(
                ["websockify", "--web", web_dir, f"127.0.0.1:{port}", target],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
            # Wait until websockify is ready to accept connections (max 3s)
            for _ in range(30):
                time.sleep(0.1)
                try:
                    with socket.socket() as s:
                        s.settimeout(0.05)
                        s.connect(("127.0.0.1", port))
                        break
                except (ConnectionRefusedError, socket.timeout, OSError):
                    pass

            self._proxies[key] = {"port": port, "proc": proc}
            return port

    def cleanup(self, key):
        with self._lock:
            info = self._proxies.pop(key, None)
        if info:
            _ws_unregister_port(info.get("port"))
            if info.get("proc"):
                try:
                    info["proc"].terminate()
                except Exception:
                    pass


_proxy_mgr = ProxyManager()


class VMKasmManager:
    """Runs a real KasmVNC server per VM console (same stack as browser sessions).

    Pipeline:  QEMU-VNC → remote-viewer (Kiosk, skaliert, im Xkasmvnc-Display)
               → Xkasmvnc WebSocket (127.0.0.1:port) → Dashboard-Proxy → Browser.

    Der Browser spricht damit das echte KasmVNC-Protokoll (Kompression, dynamisches
    Resize, Clipboard) statt den KasmVNC-Client gegen QEMUs einfachen VNC-Server
    zu betreiben — das erforderte zuvor fragile Protokoll-Filter im Client.
    """

    _PORT_RANGE = range(6800, 6900)   # websocket ports; X display = :100+(port-6800)
    _IDLE_TIMEOUT = 1800              # stop session after 30 min without client

    def __init__(self):
        self._sessions = {}   # vm_name -> session dict
        self._lock = threading.Lock()
        threading.Thread(target=self._gc_loop, daemon=True).start()

    def _free_port(self):
        used = {s["port"] for s in self._sessions.values()}
        for port in self._PORT_RANGE:
            if port in used:
                continue
            try:
                with socket.socket() as s:
                    s.bind(("127.0.0.1", port))
                    return port
            except OSError:
                continue
        raise RuntimeError("Kein freier KasmVNC-Port im Bereich 6800-6899")

    def get_or_start(self, vm_name: str, target: str) -> int:
        """Return the websocket port of a running session, starting it if needed."""
        with self._lock:
            sess = self._sessions.get(vm_name)
            if sess:
                if sess["xproc"].poll() is None and sess["target"] == target:
                    sess["last_used"] = time.time()
                    return sess["port"]
                self._teardown(sess)
                del self._sessions[vm_name]

            os.makedirs("/tmp/.X11-unix", exist_ok=True)
            os.chmod("/tmp/.X11-unix", 0o1777)
            port = self._free_port()
            disp = 100 + (port - self._PORT_RANGE.start)
            # Stale X-Locks abgestürzter Sessions entfernen (Port ist frei →
            # auf diesem Display läuft sicher kein lebender Server mehr)
            for lock in (f"/tmp/.X{disp}-lock", f"/tmp/.X11-unix/X{disp}"):
                try:
                    os.remove(lock)
                except OSError:
                    pass
            # Web-Client aus dem kasmweb-Image ausliefern (gleicher Client wie
            # Browser-Sessions → Trackpad-Cursor-Patches + Resize funktionieren)
            www_dir = KASM_CLIENT_DIR if os.path.isdir(KASM_CLIENT_DIR) else KASMVNC_WWW_DIR
            # Server-Binary passend zum Client: Xkasmvnc15 (aus kasmweb-Image),
            # Fallback auf das 1.4.0-Deb-Binary
            xbin = "/usr/bin/Xkasmvnc15" if os.path.exists("/usr/bin/Xkasmvnc15") else "Xkasmvnc"
            # Flag-Satz wie im kasmweb-Container (dort nachweislich stabil).
            # WICHTIG: Mit einem Minimal-Satz wird der 1.5er-Server nach einem
            # Client-Resize (SetDesktopSize) instabil — schwarzes Bild/Hänger.
            xproc = subprocess.Popen(
                [xbin, f":{disp}",
                 "-geometry", "1280x800", "-depth", "24",
                 "-websocketPort", str(port), "-interface", "127.0.0.1",
                 "-SecurityTypes", "None", "-DisableBasicAuth", "1",
                 "-httpd", www_dir, "-ac",
                 "-FrameRate=24", "-BlacklistThreshold=0", "-FreeKeyMappings",
                 "-PreferBandwidth", "-DynamicQualityMin=4", "-DynamicQualityMax=7",
                 "-DLP_ClipDelay=0", "-QueryConnect", "0",
                 "-udpFullFrameFrequency", "0", "-AcceptKeyEvents", "1",
                 "-MaxDisconnectionTime", "0", "-AvoidShiftNumLock", "0",
                 "-BlacklistTimeout", "10", "-VideoArea", "45",
                 "-videoCodec", "auto", "-DLP_RegionAllowClick", "0",
                 "-PublicIP", "127.0.0.1", "-DLP_ClipSendMax", "0",
                 "-RectThreads", "0", "-AcceptCutText", "1",
                 "-AcceptPointerEvents", "1", "-IgnoreClientSettingsKasm", "0",
                 "-TreatLossless", "10", "-ImprovedHextile", "1",
                 "-DLP_Log", "off", "-UseIPv4", "1",
                 "-IdleTimeout", "0", "-MaxConnectionTime", "0",
                 "-JpegVideoQuality", "-1", "-ForceGameMode", "0",
                 "-VideoScaling", "2", "-ScrollDetectLimit", "25",
                 "-RawKeyboard", "0", "-SendCutText", "1",
                 "-WebpEncodingTime", "30", "-VideoOutTime", "3",
                 "-SendPrimary", "0", "-MaxVideoResolution", "1920x1080",
                 "-AcceptSetDesktopSize", "1", "-CompareFB", "1",
                 "-VideoTime", "5", "-MaxIdleTime", "0",
                 "-PrintVideoArea", "0", "-DisconnectClients", "0",
                 "-rfbwait", "30000"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            # Wait until the websocket port accepts connections (max 8 s)
            for _ in range(80):
                if xproc.poll() is not None:
                    raise RuntimeError("KasmVNC-Server konnte nicht gestartet werden")
                try:
                    with socket.socket() as s:
                        s.settimeout(0.1)
                        s.connect(("127.0.0.1", port))
                        break
                except OSError:
                    time.sleep(0.1)

            env = dict(os.environ, DISPLAY=f":{disp}")
            # matchbox keeps the viewer fullscreen even when the client resizes
            # the KasmVNC display (SetDesktopSize → RandR)
            wm = subprocess.Popen(
                ["matchbox-window-manager", "-use_titlebar", "no", "-use_cursor", "no"],
                env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            # vncconfig bridges the KasmVNC protocol clipboard to the X CLIPBOARD
            # selection on this display. Without it, text sent from the browser
            # never reaches remote-viewer (and thus the guest via SPICE vdagent),
            # and guest→browser copy doesn't work either. -nowin = no visible window.
            vnccfg = subprocess.Popen(
                ["vncconfig", "-nowin"],
                env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            sess = {
                "vm": vm_name, "port": port, "display": disp, "target": target,
                "xproc": xproc, "wm": wm, "vnccfg": vnccfg, "viewer": None,
                "stop": False, "last_used": time.time(), "ws_conns": 0,
            }
            self._sessions[vm_name] = sess
            threading.Thread(target=self._viewer_loop, args=(sess, env), daemon=True).start()
            return port

    @staticmethod
    def _display_geometry(env):
        """Aktuelle Größe des X-Displays ('W H') oder None."""
        try:
            out = subprocess.run(["xdotool", "getdisplaygeometry"],
                                 env=env, capture_output=True, timeout=5)
            return out.stdout.strip() if out.returncode == 0 else None
        except Exception:
            return None

    def _viewer_loop(self, sess, env):
        """Keep remote-viewer running (survives VM reboots); give up if the VM
        display stays unreachable and tear the session down.

        SPICE-Targets: virt-viewer setzt die ECHTE Gast-Auflösung (vdagent)
        nur beim Verbinden auf die Fenstergröße — spätere RandR-Resizes des
        KasmVNC-Displays (Browser-Resize) übernimmt er nicht. Deshalb wird
        die Displaygröße überwacht und der Viewer bei Änderung neu gestartet;
        nach dem Reconnect passt die VM-Auflösung wieder zum Browserfenster.
        """
        fast_fails = 0
        is_spice = sess["target"].startswith("spice://")
        first_start = True
        while not sess["stop"] and sess["xproc"].poll() is None:
            # Beim ERSTEN Start auf den initialen Client-Resize warten: der Browser
            # setzt via resize=remote gleich nach dem Verbinden eine neue Displaygröße.
            # Startet remote-viewer schon vorher, muss er direkt danach neu starten
            # (Größe wird nur beim Verbinden übernommen) — in diesem Fenster gehen die
            # ERSTEN Mausklicks verloren. Darum: warten bis Client verbunden + Größe
            # ~1,5s stabil, dann Viewer EINMAL an der finalen Größe starten.
            if first_start and is_spice:
                first_start = False
                deadline = time.time() + 8
                last = self._display_geometry(env)
                stable = 0
                while time.time() < deadline and not sess["stop"]:
                    time.sleep(0.5)
                    g = self._display_geometry(env)
                    if g and g == last:
                        stable += 1
                        if sess.get("ws_conns", 0) > 0 and stable >= 3:
                            break
                    else:
                        stable = 0
                        last = g or last
            t0 = time.time()
            resized_restart = False
            try:
                # --shared: gtk-vnc verbindet sich sonst EXKLUSIV (RFB-Shared-Flag=0).
                # QEMU (share-policy allow-exclusive) wirft dann alle anderen VNC-Clients
                # raus und weist neue ab → die einfache noVNC-Konsole derselben VM
                # bricht ab, sobald KasmVNC verbindet, und umgekehrt kommt KasmVNC
                # nicht mehr rein. Mit --shared koexistieren beide (verifiziert).
                viewer = subprocess.Popen(
                    ["remote-viewer", "--shared", "--kiosk", "--kiosk-quit=on-disconnect",
                     sess["target"]],
                    env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
                sess["viewer"] = viewer
                last_geo = self._display_geometry(env)
                while viewer.poll() is None:
                    time.sleep(2)
                    if sess["stop"]:
                        viewer.terminate()
                        return
                    if is_spice:
                        geo = self._display_geometry(env)
                        if geo and last_geo and geo != last_geo:
                            time.sleep(1)   # Debounce: Resize-Sturm abwarten
                            geo2 = self._display_geometry(env)
                            if geo2 == geo:
                                resized_restart = True
                                viewer.terminate()
                                break
                            last_geo = geo2 or last_geo
                        elif geo:
                            last_geo = geo
                viewer.wait()
            except Exception:
                pass
            if sess["stop"]:
                return
            if resized_restart:
                fast_fails = 0
                continue   # sofort mit neuer Fenstergröße neu verbinden
            fast_fails = fast_fails + 1 if time.time() - t0 < 10 else 0
            if fast_fails >= 20:   # VM-Display dauerhaft weg (~1 min) → Session beenden
                self.stop(sess["vm"])
                return
            time.sleep(3)

    def _by_port(self, port):
        for s in self._sessions.values():
            if s["port"] == port:
                return s
        return None

    def touch_port(self, port):
        with self._lock:
            s = self._by_port(port)
            if s:
                s["last_used"] = time.time()

    def ws_delta(self, port, delta):
        """Track open websocket connections so idle-GC never kills active sessions."""
        with self._lock:
            s = self._by_port(port)
            if s:
                s["ws_conns"] = max(0, s["ws_conns"] + delta)
                s["last_used"] = time.time()

    def stop(self, vm_name):
        with self._lock:
            sess = self._sessions.pop(vm_name, None)
        if sess:
            self._teardown(sess)

    def _teardown(self, sess):
        sess["stop"] = True
        _ws_unregister_port(sess.get("port"))
        for key in ("viewer", "vnccfg", "wm", "xproc"):
            proc = sess.get(key)
            if proc:
                try:
                    proc.terminate()
                except Exception:
                    pass

    def _gc_loop(self):
        while True:
            time.sleep(300)
            now = time.time()
            with self._lock:
                idle = [name for name, s in self._sessions.items()
                        if s["ws_conns"] == 0 and now - s["last_used"] > self._IDLE_TIMEOUT]
            for name in idle:
                self.stop(name)


_vmkasm_mgr = VMKasmManager()

# ─── WebSocket proxy session registry ───────────────────────────────────────
# Maps a short-lived token → internal websockify port so the main server can
# proxy /ws/{token} requests without exposing raw ports to the network.

_ws_sessions: dict = {}   # {token: (port, created_at, owner)}
_ws_sessions_lock = threading.Lock()

def _ws_register(port: int, owner: str = "", ttl: int = 1800) -> str:
    """Create a session token for an internal websockify port, bound to a user.

    owner — Benutzername oder "share:<id>" für öffentliche VM-Freigaben (die
            Gültigkeit solcher Tokens endet mit der Freigabe, deshalb eigene ttl).
    """
    token = secrets.token_urlsafe(16)
    now   = time.time()
    with _ws_sessions_lock:
        # Kurze TTL (Default 30 min) reduziert das Fenster für Stale-Token/Port-Reuse
        stale = [k for k, v in _ws_sessions.items() if now > v[1]]
        for k in stale:
            del _ws_sessions[k]
        _ws_sessions[token] = (port, now + max(60, int(ttl)), owner)
    return token

def _ws_port_for(token: str):
    with _ws_sessions_lock:
        entry = _ws_sessions.get(token)
    return entry[0] if entry else None

def _ws_owner_for(token: str):
    with _ws_sessions_lock:
        entry = _ws_sessions.get(token)
    return entry[2] if entry and len(entry) > 2 else ""

def _ws_unregister_port(port):
    """Alle Tokens löschen, die auf diesen Port zeigen — wird beim Teardown des
    zugehörigen Proxys aufgerufen. Verhindert, dass ein recycelter Port über
    einen alten (noch nicht per TTL abgelaufenen) Token erreichbar bleibt."""
    if port is None:
        return
    with _ws_sessions_lock:
        for tok in [t for t, v in _ws_sessions.items() if v[0] == port]:
            del _ws_sessions[tok]

def _console_url(headers, console_type: str, session_token: str) -> str:
    """Build an absolute URL for a console page respecting Cloudflare forwarding."""
    proto = headers.get("X-Forwarded-Proto", "http")
    host  = headers.get("Host", "localhost")
    return f"{proto}://{host}/console/{console_type}?session={session_token}"


def _kasm_client_inject(ws_path: str, stop_js: str, beacon_sid: str = "") -> bytes:
    """Gemeinsame HTML-Injection für KasmVNC-Clients (Browser-Sessions + VM-Konsolen).

    ws_path    — absoluter WebSocket-Proxy-Pfad ("/kasmvnc-ws/<sid>" oder "/ws/<token>")
    stop_js    — JS-Body des ✕-Buttons (Konsole schließen). Leer lassen, wenn kein
                 ✕-Button eingeblendet werden soll (Browser-Sessions).
    beacon_sid — Browser-Session-ID: aktiviert den Lebenszeichen-Heartbeat für die
                 automatische Idle-Pause. Leer lassen für VM-Konsolen (die laufen
                 auf dem Host und werden nicht pausiert).
    """
    # Heartbeat: hält die Session wach, solange der Tab SICHTBAR ist, und taut sie
    # beim Zurückkehren sofort wieder auf. Ein geschlossener oder im Hintergrund
    # liegender Tab sendet nichts → der Idle-Wächter friert die Session ein.
    # Bewusst an die Sichtbarkeit gekoppelt (nicht an die WebSocket-Verbindung):
    # ein offener Hintergrund-Tab soll die CPU nicht dauerhaft belegen.
    _beacon = ''
    if beacon_sid:
        _beacon = (
            'var _bid=' + json.dumps(beacon_sid) + ',_bBusy=false;'
            'function _beat(){'
            'if(_bBusy)return;_bBusy=true;'
            'fetch("/api/browser/ping",{method:"POST",credentials:"same-origin",'
            'headers:{"Content-Type":"application/json"},body:JSON.stringify({id:_bid})})'
            '.catch(function(){}).then(function(){_bBusy=false;});}'
            '_beat();'
            'setInterval(function(){if(document.visibilityState!=="hidden")_beat();},60000);'
            # Rückkehr zum Tab: sofort auftauen, nicht erst beim nächsten Intervall.
            'document.addEventListener("visibilitychange",function(){'
            'if(document.visibilityState!=="hidden")_beat();});'
            'window.addEventListener("focus",_beat);'
        )
    _stopbtn = ''
    if stop_js:
        _stopbtn = (
            '_xBtn=document.createElement("button");'
            '_xBtn.innerHTML="&#10005;";_xBtn.title="Session beenden";'
            '_xBtn.style.cssText="position:fixed;bottom:72px;right:70px;z-index:2147483647;'
            'width:48px;height:48px;border-radius:50%;background:#b71c1c;color:#fff;'
            'border:none;font-size:20px;cursor:pointer;'
            'box-shadow:0 3px 10px rgba(0,0,0,.6);display:flex;align-items:center;'
            'justify-content:center;touch-action:manipulation;'
            '-webkit-tap-highlight-color:transparent;";'
            'document.body.appendChild(_xBtn);'
        )
    return (
        # touch-action:none on the KasmVNC canvas prevents the browser from
        # intercepting touch drags for scrolling/zooming before the GestureHandler
        # sees them.  Must be a <style> tag so it applies before JS runs.
        '<style>canvas,#noVNC_canvas{touch-action:none!important}'
        '#noVNC_container,#noVNC_screen{touch-action:none!important}</style>'
        '<script>(function(){'
        'var _isMobile=/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);'
        + _beacon +
        # --- Pre-set KasmVNC localStorage quality defaults before initSetting() reads them ---
        # initSetting() skips if key already exists → we control defaults without overriding user changes
        'if(!localStorage.getItem("dynamic_quality_max"))localStorage.setItem("dynamic_quality_max","6");'
        'if(!localStorage.getItem("dynamic_quality_min"))localStorage.setItem("dynamic_quality_min","3");'
        'if(!localStorage.getItem("video_area"))localStorage.setItem("video_area","40");'
        # resize=remote ERZWINGEN (nicht nur Default): der Remote-Desktop passt sich
        # bei jeder Verbindung an das Client-Fenster an. localStorage ist pro Gerät —
        # ohne Erzwingen behält ein PC-Browser einen alten "scale"/"off"-Wert und zeigt
        # dann die vom Handy gesetzte (Hochkant-)Auflösung, statt sich anzupassen.
        'localStorage.setItem("resize","remote");'
        # Zwischenablage in BEIDE Richtungen erzwingen. Der KasmVNC-Client setzt
        # clipboard_up/_down je nach Browser/Kontext teils auf false (Default aus) —
        # dann funktioniert weder "An VM" (clipboardSend→clipboardPasteFrom, an
        # rfb.clipboardUp gekoppelt) noch "Von VM" (clipboardReceive, an
        # rfb.clipboardDown gekoppelt). Wie bei resize hier erzwingen, da
        # localStorage pro Gerät ist.
        'localStorage.setItem("clipboard_up","true");'
        'localStorage.setItem("clipboard_down","true");'
        # Mobile: IME-Tastatur aktivieren. Ohne enable_ime nutzt der KasmVNC-Client
        # den _screenInput (erwartet physische keydown-Events, die Soft-Keyboards
        # nicht zuverlässig liefern) statt des _touchInput (IME) — dann funktioniert
        # die Bildschirmtastatur nicht/falsch (fehlende Zeichen, Layout). Der
        # Tastatur-Button fokussiert _touchInput, was nur mit IME aktiv wirkt.
        # Nur für Mobile erzwingen (Desktop nutzt physische Tastatur ohne IME).
        'if(_isMobile)localStorage.setItem("enable_ime","true");'
        # --- WebSocket redirect ---
        'var _O=window.WebSocket;'
        'window.WebSocket=function(u,p){'
        'if(typeof u==="string"&&u.indexOf("websockify")!==-1){'
        'var _s=window.location.protocol==="https:"?"wss://":"ws://";'
        'u=_s+window.location.host+"' + ws_path + '";'
        '}'
        'var _w=p?new _O(u,p):new _O(u);return _w;};'
        'window.WebSocket.prototype=_O.prototype;'
        'window.WebSocket.CONNECTING=0;window.WebSocket.OPEN=1;'
        'window.WebSocket.CLOSING=2;window.WebSocket.CLOSED=3;'
        # --- Mobile keyboard + stop-session button ---
        'var _kbOpen=false,_kbBtn=null,_kbInit=false,_xBtn=null,_clipBtn=null,_clipPanel=null;'
        # Clipboard bridge: the native KasmVNC control bar (which holds the
        # clipboard panel) can't be opened on touch devices because our trackpad
        # layer swallows all touches. So we drive KasmVNC's own clipboard textarea
        # (#noVNC_clipboard_text) directly: setting its value + firing "change"
        # triggers UI.clipboardSend → rfb.clipboardPasteFrom → guest (via vdagent).
        # Incoming guest clipboard also lands in that textarea, so we mirror it back.
        'function _kClip(){return document.getElementById("noVNC_clipboard_text");}'
        'function _clipToVm(txt){var t=_kClip();if(!t)return false;'
        't.value=txt;t.dispatchEvent(new Event("change",{bubbles:true}));return true;}'
        'function _toggleClip(){'
        'if(!_clipPanel)return;'
        'var open=_clipPanel.style.display!=="none";'
        'if(open){_clipPanel.style.display="none";if(_clipBtn)_clipBtn.style.background="#6d28d9";}'
        'else{'
        'var box=document.getElementById("_lccClipBox");'
        'var k=_kClip();if(box&&k&&k.value)box.value=k.value;'  # zeige zuletzt von VM kopierten Text
        '_clipPanel.style.display="block";if(_clipBtn)_clipBtn.style.background="#7c3aed";'
        'setTimeout(function(){if(box)box.focus();},50);}}'
        'function _clipLoadDevice(){'
        'var box=document.getElementById("_lccClipBox");if(!box)return;'
        'if(navigator.clipboard&&navigator.clipboard.readText){'
        'navigator.clipboard.readText().then(function(t){box.value=t;}).catch(function(){box.focus();});'
        '}else{box.focus();}}'
        'function _clipSendVm(){'
        'var box=document.getElementById("_lccClipBox");if(!box)return;'
        'var st=document.getElementById("_lccClipStatus");'
        'var ok=_clipToVm(box.value);'
        'if(st){st.textContent=ok?"\\u2713 an VM gesendet":"VM nicht verbunden";'
        'setTimeout(function(){st.textContent="";},2500);}}'
        'function _clipFromVm(){'
        'var box=document.getElementById("_lccClipBox");var k=_kClip();if(!box||!k)return;'
        'box.value=k.value;'
        'if(navigator.clipboard&&navigator.clipboard.writeText&&k.value)navigator.clipboard.writeText(k.value).catch(function(){});'
        'var st=document.getElementById("_lccClipStatus");'
        'if(st){st.textContent="\\u2713 von VM geladen";setTimeout(function(){st.textContent="";},2500);}}'
        'function _getInput(){'
        'return document.getElementById("_touchInput")'
        '||document.querySelector(".noVNC_keyboardinput")'
        '||document.querySelector("textarea[autocomplete]");}'
        'function _toggleKb(){'
        'var ti=_getInput();'
        'if(_kbOpen){'
        '_kbOpen=false;if(_kbBtn)_kbBtn.style.background="#1565c0";'
        'window.postMessage({action:"hide_keyboard_controls"},"*");'
        'if(ti){ti._noRef=true;ti.blur();setTimeout(function(){ti._noRef=false;},400);}'
        '}else{'
        '_kbOpen=true;if(_kbBtn)_kbBtn.style.background="#2e7d32";'
        'window.postMessage({action:"show_keyboard_controls"},"*");'
        'if(ti)ti.focus();'
        '}}'
        'function _mkBtn(){'
        'if(_kbInit||!_isMobile)return;_kbInit=true;'
        # Keyboard button — stored in outer-scope _kbBtn so _ts can reference it directly
        '_kbBtn=document.createElement("button");'
        '_kbBtn.innerHTML="&#9000;";_kbBtn.title="Tastatur";'
        '_kbBtn.style.cssText="position:fixed;bottom:72px;right:14px;z-index:2147483647;'
        'width:48px;height:48px;border-radius:50%;background:#1565c0;color:#fff;'
        'border:none;font-size:22px;cursor:pointer;'
        'box-shadow:0 3px 10px rgba(0,0,0,.6);display:flex;align-items:center;'
        'justify-content:center;touch-action:manipulation;'
        '-webkit-tap-highlight-color:transparent;";'
        'document.body.appendChild(_kbBtn);'
        # Stop-session button — stored in outer-scope _xBtn so _ts can reference it directly.
        # Nur wenn stop_js gesetzt ist (VM-Konsolen). Browser-Sessions lassen ihn weg:
        # dort wird die Session ausschliesslich ueber die Sessionverwaltung beendet,
        # damit ein Fehlgriff auf dem Handy sie nicht unwiderruflich loescht.
        + _stopbtn +
        # Clipboard button — opens our own clipboard panel (native menu is
        # unreachable on touch). Positioned above the keyboard button.
        '_clipBtn=document.createElement("button");'
        '_clipBtn.innerHTML="\\uD83D\\uDCCB";_clipBtn.title="Zwischenablage";'
        '_clipBtn.style.cssText="position:fixed;bottom:130px;right:14px;z-index:2147483647;'
        'width:48px;height:48px;border-radius:50%;background:#6d28d9;color:#fff;'
        'border:none;font-size:20px;cursor:pointer;'
        'box-shadow:0 3px 10px rgba(0,0,0,.6);display:flex;align-items:center;'
        'justify-content:center;touch-action:manipulation;'
        '-webkit-tap-highlight-color:transparent;";'
        'document.body.appendChild(_clipBtn);'
        # Clipboard panel (hidden until button tapped)
        '_clipPanel=document.createElement("div");'
        '_clipPanel.id="_lccClip";_clipPanel.style.display="none";'
        '_clipPanel.style.cssText+=";position:fixed;top:0;left:0;right:0;z-index:2147483647;'
        'background:rgba(6,8,13,0.97);border-bottom:1px solid rgba(255,255,255,0.12);'
        'padding:10px 12px;box-sizing:border-box;font-family:system-ui,sans-serif;";'
        '_clipPanel.innerHTML='
        '"<textarea id=\'_lccClipBox\' rows=\'3\' placeholder=\'Text f\\u00fcr die VM \\u2026\' '
        'style=\'width:100%;background:#0d1320;color:#c8d4e8;border:1px solid #2a3a52;'
        'border-radius:6px;padding:8px 10px;font:13px/1.5 monospace;resize:none;outline:none;'
        'box-sizing:border-box;\'></textarea>"'
        '+"<div style=\'display:flex;gap:6px;margin-top:8px;\'>"'
        '+"<button id=\'_lccClipLoad\' style=\'flex:1;background:rgba(255,255,255,0.08);color:#c8d4e8;'
        'border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:9px;font-size:12px;\'>\\uD83D\\uDCE5 Ger\\u00e4t</button>"'
        '+"<button id=\'_lccClipSend\' style=\'flex:1;background:#7c3aed;color:#fff;border:none;'
        'border-radius:6px;padding:9px;font-weight:600;font-size:12px;\'>\\u27a1 An VM</button>"'
        '+"<button id=\'_lccClipFrom\' style=\'flex:1;background:rgba(255,255,255,0.08);color:#c8d4e8;'
        'border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:9px;font-size:12px;\'>\\u2b05 Von VM</button>"'
        '+"<button id=\'_lccClipClose\' style=\'background:rgba(255,255,255,0.05);color:#8b9dc3;'
        'border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:9px 12px;font-size:14px;\'>\\u2715</button>"'
        '+"</div>"'
        '+"<div id=\'_lccClipStatus\' style=\'color:#a855f7;font:11px/1.4 monospace;'
        'text-align:center;margin-top:6px;min-height:14px;\'></div>";'
        'document.body.appendChild(_clipPanel);'
        # Buttons im Panel: click-Handler (Desktop-Maus) + touchend (Mobile-Tap,
        # da unser Capture-Handler synthetische clicks verhindert)
        'function _bind(id,fn){var el=document.getElementById(id);if(!el)return;'
        'el.addEventListener("click",function(e){e.preventDefault();fn();});}'
        '_bind("_lccClipLoad",_clipLoadDevice);_bind("_lccClipSend",_clipSendVm);'
        '_bind("_lccClipFrom",_clipFromVm);_bind("_lccClipClose",_toggleClip);'
        '}'
        'function _watchTI(){'
        'var ti=_getInput();'
        'if(ti&&!ti._mw){ti._mw=true;'
        'ti.addEventListener("blur",function(){'
        'if(_kbOpen&&!ti._noRef)'
        'setTimeout(function(){if(_kbOpen&&!ti._noRef)ti.focus();},60);'
        '})}}'
        'function _init(){_mkBtn();_watchTI();}'
        'if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",_init);'
        'else _init();'
        'new MutationObserver(function(){_watchTI();}).observe(document.documentElement,{childList:true,subtree:true});'
        # --- Mobile trackpad crosshair (trackpad-style relative cursor, like noVNC touch mode) ---
        # Intercepts ALL touch events before kasmVNC sees them (window capture + stopImmediatePropagation).
        # Dispatches synthetic MouseEvents to #noVNC_container canvas (the actual VNC canvas).
        # 1-finger drag = move cursor  |  tap = left click  |  2-finger tap = right click
        # 2-finger drag = scroll
        'if(_isMobile){'
        'var _vx=0,_vy=0,_curEl=null,_trk=false,_kbOff=0;'
        'var _lx=0,_ly=0,_sx=0,_sy=0,_st=0,_h2=false,_mv=false;'
        'var _2lx=0,_2ly=0,_2sx=0,_2sy=0,_sax=0,_say=0;'
        'var _SPX=40;'
        # Target the real VNC canvas inside noVNC_container, NOT the cursor-overlay canvas (z-index 65535)
        'function _getC(){return document.querySelector("#noVNC_container canvas")||document.querySelector("canvas");}'
        # Direct stop action — called from _ts when ✕ button is tapped (no confirm, no click event needed)
        'function _doStop(){' + stop_js + '}'
        'function _initC(){'
        'if(_curEl)return;'
        '_curEl=document.createElement("div");'
        '_curEl.style.cssText="position:fixed;width:24px;height:24px;pointer-events:none;z-index:2147483646;display:none;transform:translate(-50%,-50%);";'
        'var h='
        '"<div style=\'position:absolute;left:50%;top:0;width:1.5px;height:100%;transform:translateX(-50%);background:rgba(255,255,255,.9);box-shadow:0 0 3px rgba(0,0,0,1)\'></div>"'
        '+"<div style=\'position:absolute;top:50%;left:0;height:1.5px;width:100%;transform:translateY(-50%);background:rgba(255,255,255,.9);box-shadow:0 0 3px rgba(0,0,0,1)\'></div>"'
        '+"<div style=\'position:absolute;width:5px;height:5px;background:#fff;border-radius:50%;top:50%;left:50%;transform:translate(-50%,-50%);box-shadow:0 0 0 1.5px rgba(0,0,0,.9)\'></div>";'
        '_curEl.innerHTML=h;'
        'document.body.appendChild(_curEl);'
        'var c=_getC();'
        'if(c){var r=c.getBoundingClientRect();_vx=r.left+r.width/2;_vy=r.top+r.height/2;}'
        'else{_vx=window.innerWidth/2;_vy=window.innerHeight/2;}'
        '_updC();}'
        'function _updC(){if(!_curEl)return;_curEl.style.left=_vx+"px";_curEl.style.top=(_vy-_kbOff)+"px";_curEl.style.display="block";}'
        'function _mev(tp,btn,btns){var c=_getC();if(!c)return;c.dispatchEvent(new MouseEvent(tp,{bubbles:true,cancelable:true,view:window,clientX:_vx,clientY:_vy-_kbOff,button:btn,buttons:btns}));}'
        # --- Keyboard-aware view shift ---
        # Wenn die Bildschirmtastatur aufgeht, schrumpft visualViewport. Wir
        # schieben den Anzeige-Container so weit nach oben, dass die zuletzt
        # angetippte Stelle (_vy ≈ Textcursor) über der Tastatur sichtbar bleibt.
        # Klickkoordinaten bleiben invariant, da _mev clientY um _kbOff korrigiert.
        'function _dispEl(){return document.getElementById("noVNC_container")||(_getC()&&_getC().parentNode);}'
        'function _applyKbShift(off){'
        'if(off===_kbOff)return;'
        '_kbOff=off;'
        'var el=_dispEl();'
        'if(el){el.style.transition="transform 0.18s ease-out";el.style.transform=off>0?("translateY(-"+off+"px)"):"";}'
        'if(_curEl)_updC();}'
        'function _vvResize(){'
        'var vv=window.visualViewport;if(!vv)return;'
        'var kb=window.innerHeight-vv.height-vv.offsetTop;'  # ungefaehre Tastaturhoehe
        'if(kb>120){'  # Tastatur offen (URL-Leisten-Aenderungen sind kleiner)
        'var visH=vv.height;'
        'var off=_vy-visH*0.45;'  # Cursor auf ~45% der sichtbaren Hoehe legen
        'off=Math.max(0,Math.min(off,window.innerHeight-visH));'
        '_applyKbShift(off);'
        '}else{_applyKbShift(0);}}'
        'function _clk(right){if(right){_mev("mousedown",2,2);_mev("mouseup",2,0);}else{_mev("mousedown",0,1);_mev("mouseup",0,0);}}'
        'function _ts(e){'
        # Overlay buttons (_xBtn, _kbBtn) are handled directly here in the window capture handler.
        # This is more reliable than letting iOS generate compat click events.
        'if(_xBtn&&(e.target===_xBtn||_xBtn.contains(e.target))){'
        'e.preventDefault();e.stopImmediatePropagation();_doStop();return;}'
        'if(_kbBtn&&(e.target===_kbBtn||_kbBtn.contains(e.target))){'
        'e.preventDefault();e.stopImmediatePropagation();_toggleKb();return;}'
        'if(_clipBtn&&(e.target===_clipBtn||_clipBtn.contains(e.target))){'
        'e.preventDefault();e.stopImmediatePropagation();_toggleClip();return;}'
        # Touches im Clipboard-Panel NICHT abfangen → native Button-Taps &
        # Textarea-Fokus (Tastatur) funktionieren
        'if(_clipPanel&&_clipPanel.contains(e.target)){return;}'
        'if(!_curEl)_initC();_trk=true;'
        'e.preventDefault();e.stopImmediatePropagation();'
        'var n=e.touches.length;'
        'if(n===1){if(!_h2){_lx=_sx=e.touches[0].clientX;_ly=_sy=e.touches[0].clientY;_st=performance.now();_mv=false;}}'
        'else if(n===2){_h2=true;_2lx=_2sx=(e.touches[0].clientX+e.touches[1].clientX)/2;_2ly=_2sy=(e.touches[0].clientY+e.touches[1].clientY)/2;_sax=_say=0;_st=performance.now();_mv=false;}}'
        'function _tm(e){'
        'if(!_trk)return;e.preventDefault();e.stopImmediatePropagation();'
        'if(_h2){'
        'if(e.touches.length>=2){'
        'var cx=(e.touches[0].clientX+e.touches[1].clientX)/2,cy=(e.touches[0].clientY+e.touches[1].clientY)/2;'
        'var dx=cx-_2lx,dy=cy-_2ly;_2lx=cx;_2ly=cy;'
        'if(Math.hypot(cx-_2sx,cy-_2sy)>8)_mv=true;'
        'if(_mv){var cc=_getC();_sax+=dx;_say+=dy;'
        'while(_say<-_SPX){if(cc)cc.dispatchEvent(new WheelEvent("wheel",{deltaY:_SPX,deltaMode:0,bubbles:true,cancelable:true,clientX:_vx,clientY:_vy}));_say+=_SPX;}'
        'while(_say>_SPX){if(cc)cc.dispatchEvent(new WheelEvent("wheel",{deltaY:-_SPX,deltaMode:0,bubbles:true,cancelable:true,clientX:_vx,clientY:_vy}));_say-=_SPX;}'
        '}}'
        'return;}'
        'if(e.touches.length!==1){_mv=true;return;}'
        'var tx=e.touches[0].clientX,ty=e.touches[0].clientY;'
        'var dx=tx-_lx,dy=ty-_ly;_lx=tx;_ly=ty;'
        '_vx=Math.max(0,Math.min(window.innerWidth-1,_vx+dx));'
        '_vy=Math.max(0,Math.min(window.innerHeight-1,_vy+dy));'
        'if(Math.hypot(tx-_sx,ty-_sy)>8)_mv=true;'
        '_mev("mousemove",0,0);_updC();}'
        'function _te(e){'
        'if(!_trk)return;e.preventDefault();e.stopImmediatePropagation();'
        'if(e.touches.length>0)return;'
        '_trk=false;var dt=performance.now()-_st;'
        'if(!_mv&&dt<400){'
        'if(_h2){_clk(true);}'
        'else{var t=e.changedTouches[0];if(Math.hypot(t.clientX-_sx,t.clientY-_sy)<20)_clk(false);}}'
        # nach Cursor-Neuplatzierung Verschiebung an neue Position anpassen
        'if(window.visualViewport)_vvResize();'
        '_h2=false;_mv=false;}'
        # Register on window (first in capture chain) so we beat any kasmVNC capture listeners
        'window.addEventListener("touchstart",_ts,{passive:false,capture:true});'
        'window.addEventListener("touchmove",_tm,{passive:false,capture:true});'
        'window.addEventListener("touchend",_te,{passive:false,capture:true});'
        'window.addEventListener("touchcancel",function(){_trk=false;_h2=false;_mv=false;},{passive:false,capture:true});'
        # Auf Tastatur-Ein/Ausblenden reagieren (Viewport-Groesse)
        'if(window.visualViewport){'
        'window.visualViewport.addEventListener("resize",_vvResize);'
        'window.visualViewport.addEventListener("scroll",_vvResize);}'
        'function _tryC(){if(_getC()&&!_curEl)_initC();}'
        'if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",function(){setTimeout(_tryC,1500);});'
        'else setTimeout(_tryC,1500);'
        'new MutationObserver(function(){_tryC();}).observe(document.documentElement,{childList:true,subtree:true});'
        '}'   # end if(_isMobile)
        '})();</script>'
    ).encode()


# ─── WebSocket helpers ───────────────────────────────────────────────────────

_WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

def _ws_handshake_response(key, protocol=""):
    accept = base64.b64encode(
        hashlib.sha1((key + _WS_MAGIC).encode()).digest()
    ).decode()
    # RFC 6455: server must select exactly ONE subprotocol from the client's list.
    # Pick the first one offered (typically "binary").
    chosen = protocol.split(",")[0].strip() if protocol else ""
    proto_hdr = f"Sec-WebSocket-Protocol: {chosen}\r\n" if chosen else ""
    return (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept}\r\n"
        f"{proto_hdr}"
        "\r\n"
    ).encode()

def _ws_recv(sock):
    """Read one WebSocket frame. Returns (opcode, data) or (None, None) on error."""
    try:
        def recv_exact(n):
            buf = b""
            while len(buf) < n:
                chunk = sock.recv(n - len(buf))
                if not chunk:
                    return None
                buf += chunk
            return buf

        hdr = recv_exact(2)
        if not hdr:
            return None, None
        opcode = hdr[0] & 0x0f
        masked = bool(hdr[1] & 0x80)
        plen   = hdr[1] & 0x7f
        if plen == 126:
            ext = recv_exact(2)
            if not ext:
                return None, None
            plen = struct.unpack(">H", ext)[0]
        elif plen == 127:
            ext = recv_exact(8)
            if not ext:
                return None, None
            plen = struct.unpack(">Q", ext)[0]
        mask = recv_exact(4) if masked else b"\x00\x00\x00\x00"
        if mask is None:
            return None, None
        payload = recv_exact(plen)
        if payload is None:
            return None, None
        if masked:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        return opcode, payload
    except Exception:
        return None, None

def _ws_send(sock, data, opcode=0x02):
    """Send a WebSocket binary/text frame."""
    if isinstance(data, str):
        data = data.encode("utf-8")
    hdr = bytearray([0x80 | opcode])
    n = len(data)
    if n < 126:
        hdr.append(n)
    elif n < 65536:
        hdr.append(126)
        hdr.extend(struct.pack(">H", n))
    else:
        hdr.append(127)
        hdr.extend(struct.pack(">Q", n))
    try:
        sock.sendall(bytes(hdr) + data)
        return True
    except Exception:
        return False


# ─── Docker API helpers (via Unix socket) ───────────────────────────────────

class _UnixSocketHTTPConnection(http.client.HTTPConnection):
    def __init__(self):
        super().__init__("localhost")

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect("/var/run/docker.sock")


def _docker_api(method, path, body=None):
    """Call Docker REST API via Unix socket. Returns (status_code, parsed_body)."""
    conn = _UnixSocketHTTPConnection()
    headers = {"Content-Type": "application/json", "Host": "localhost"}
    payload = None
    if body is not None:
        payload = json.dumps(body).encode()
        headers["Content-Length"] = str(len(payload))
    try:
        conn.request(method, path, body=payload, headers=headers)
        resp = conn.getresponse()
        raw = resp.read()
        try:
            return resp.status, json.loads(raw)
        except Exception:
            return resp.status, {}
    except Exception as e:
        raise RuntimeError(f"Docker API: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass


# ─── Browser Session Manager ─────────────────────────────────────────────────

