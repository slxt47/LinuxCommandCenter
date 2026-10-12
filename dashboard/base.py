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


HOST = "0.0.0.0"
PORT = int(os.environ.get("DASH_PORT", "8420"))
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
DATA_DIR = Path("/data")
DATA_DIR.mkdir(parents=True, exist_ok=True)
SESSIONS_FILE = DATA_DIR / "browser_sessions.json"


# ─── nsenter helper ─────────────────────────────────────────────────────────

def _ns(cmd):
    """Wrap a command with nsenter to run in host's mount namespace."""
    return ["nsenter", "--target", "1", "--mount", "--"] + cmd


# ─── Console Proxy Manager (websockify für VNC / SPICE) ─────────────────────

NOVNC_DIR       = "/usr/share/novnc/"
SPICE_DIR       = "/usr/share/spice-html5/"
KASMVNC_WWW_DIR = "/usr/share/kasmvnc/www"       # Client aus dem kasmvncserver-Paket (Fallback)
KASM_CLIENT_DIR = "/usr/share/kasmvnc/www-kasm"  # Client aus dem kasmweb-Image — exakt derselbe
                                                 # wie bei Browser-Sessions (Mobile-Patches passen)

