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

from dashboard.base import HOST, PORT, _ns
from dashboard.browsers import _browser_mgr
from dashboard.handler import DashboardHandler
from dashboard.terminal import _terminal_lock, _terminal_state

class ThreadedServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    # Initialize terminal CWD to host home directory
    for cmd in [_ns(["bash", "-c", "echo $HOME"]), ["bash", "-c", "echo $HOME"]]:
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
            if r.returncode == 0 and r.stdout.strip():
                home = r.stdout.strip()
                with _terminal_lock:
                    _terminal_state["cwd"]  = home
                    _terminal_state["home"] = home
                break
        except Exception:
            pass

    # Recover browser sessions from previous run and clean up orphan containers
    _browser_mgr.recover()

    # Verwaiste VM-KasmVNC-Prozesse früherer Läufe beenden. Wegen pid:host
    # überleben sie Container-Neustarts und würden Ports/Displays blockieren
    # bzw. sich um die exklusive QEMU-VNC-Verbindung streiten.
    # Die Muster entsprechen exakt den von VMKasmManager gestarteten Prozessen.
    for _pat in (r"Xkasmvnc15? :1[0-9][0-9] .*-websocketPort 68",
                 r"remote-viewer --kiosk --kiosk-quit=on-disconnect (vnc|spice)://",
                 r"matchbox-window-manager -use_titlebar no -use_cursor no"):
        try:
            subprocess.run(["pkill", "-9", "-f", _pat],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
        except Exception:
            pass

    print(f"""
╔══════════════════════════════════════════════════╗
║       LINUX COMMAND CENTER — v1.2 (Docker)       ║
║    System Monitoring · Updates · Terminal · VMs   ║
╠══════════════════════════════════════════════════╣
║  Server:  http://{HOST}:{PORT}                    ║
║  Login:   http://{HOST}:{PORT}/login              ║
╚══════════════════════════════════════════════════╝
    """)

    server = ThreadedServer((HOST, PORT), DashboardHandler)

    def shutdown(sig, frame):
        print("\n[!] Shutting down...")
        server.shutdown()
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
