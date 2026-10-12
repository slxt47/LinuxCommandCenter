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

from dashboard.base import _ns

_terminal_state = {"cwd": "/", "home": "/root"}
_terminal_lock  = threading.Lock()
_TERM_MARKER    = "__LCDCWD9x__"

# Regex for detecting interactive prompts in PTY output
_PTY_SUDO_RE  = re.compile(rb'\[sudo\] password for [^:]*:\s*$|Password:\s*$|Passwort:\s*$', re.IGNORECASE)
_PTY_INPUT_RE = re.compile(rb'\[Y/n\]\s*$|\[y/N\]\s*$|\(yes/no\)\s*\??\s*$|Do you want to continue', re.IGNORECASE)


class _PtySession:
    """Persistent bash PTY session for interactive command execution (sudo, etc.)."""

    MARKER = "__LDASH_PS1__"

    def __init__(self):
        self._lock   = threading.Lock()
        self._master = -1
        self._proc   = None
        self._spawn()

    def _spawn(self):
        try:
            master, slave = pty.openpty()
        except OSError:
            return
        try:
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 220, 0, 0))
        except OSError:
            pass

        env = dict(os.environ)
        env['TERM'] = 'xterm-256color'
        env['PS1']  = f'{self.MARKER}:$?:' + r'\w\$ '
        env['PS2']  = ''

        def _child_setup():
            os.setsid()
            # Slave-PTY zum Controlling-Terminal machen, damit VINTR (Ctrl+C, 0x03)
            # vom Kernel in SIGINT an die Vordergrund-Prozessgruppe übersetzt wird —
            # sonst wirkt interrupt() nicht (0x03 landet nur als Byte im Puffer).
            try:
                fcntl.ioctl(0, termios.TIOCSCTTY, 0)
            except OSError:
                pass

        # `script` legt im Host-Mount-Namespace ein echtes Host-PTY an. Ohne das
        # zeigt fd 0 auf ein Container-devpts, das der Host nicht kennt — `screen`
        # hält dann /dev/null für sein Terminal und chmod-et es auf 0600
        # ("-bash: /dev/null: Permission denied" bei jedem Login).
        proc = None
        for cmd in [_ns(['script', '-qfec', 'bash --norc --noprofile', '/dev/null']),
                    _ns(['bash', '--norc', '--noprofile']),
                    ['bash', '--norc', '--noprofile']]:
            try:
                proc = subprocess.Popen(
                    cmd, stdin=slave, stdout=slave, stderr=slave,
                    env=env, close_fds=True, preexec_fn=_child_setup,
                )
                break
            except (FileNotFoundError, OSError):
                continue

        try:
            os.close(slave)
        except OSError:
            pass

        if proc is None:
            try: os.close(master)
            except OSError: pass
            return

        fl = fcntl.fcntl(master, fcntl.F_GETFL)
        fcntl.fcntl(master, fcntl.F_SETFL, fl | os.O_NONBLOCK)
        self._master = master
        self._proc   = proc

        time.sleep(0.3)   # nsenter + script brauchen etwas, bis das innere PTY steht
        self._drain()

        # Export PS1 so sub-shells (sudo su, su, bash) inherit it.
        # set +m suppresses "no job control" warnings inside containers.
        ps1_val = f'{self.MARKER}:$?:' + r'\w\$ '
        # Einfach-Quotes: $? / \w / \$ müssen LITERAL in PS1 landen und erst zur
        # Prompt-Zeit expandieren. Mit Doppel-Quotes würde die Shell $? schon beim
        # export auswerten (→ literale 0) und der Returncode wäre immer 0.
        self._write(f"export PS1='{ps1_val}'; set +m 2>/dev/null\n")
        self._drain()

        # Navigate to saved CWD
        with _terminal_lock:
            cwd = _terminal_state.get('cwd', '/')
        self._write(f'cd {shlex.quote(cwd)} 2>/dev/null || cd /\n')
        self._drain()

    def alive(self):
        return self._proc is not None and self._proc.poll() is None

    def _write(self, data):
        if isinstance(data, str):
            data = data.encode('utf-8', errors='replace')
        try:
            os.write(self._master, data)
        except OSError:
            pass

    def _drain(self, timeout=0.15):
        """Read and discard pending PTY output. Exits as soon as there is a
        gap in the data stream (one empty select window) so it never blocks
        longer than necessary."""
        buf = b''
        end = time.time() + timeout
        while time.time() < end:
            try:
                r, _, _ = select.select([self._master], [], [], 0.02)
            except (OSError, ValueError):
                break
            if not r:
                break   # no data available right now — done
            try:
                chunk = os.read(self._master, 4096)
                if chunk:
                    buf += chunk
                else:
                    break
            except (OSError, BlockingIOError):
                break
        return buf

    def _read_until_done(self, timeout=30):
        """Read PTY output until PS1 marker or an interactive prompt is detected."""
        marker   = self.MARKER.encode()
        # Command we send to a sub-shell that lacks our PS1 marker
        ps1_inject = (
            f"export PS1='{self.MARKER}:$?:" + r'\w\$ ' + "'\n"
        ).encode()
        buf      = b''
        end      = time.time() + timeout
        last_t   = time.time()
        injected = False   # only inject PS1 once per call

        while time.time() < end:
            try:
                r, _, _ = select.select([self._master], [], [], 0.02)
            except (OSError, ValueError):
                break

            if r:
                try:
                    chunk = os.read(self._master, 8192)
                    if chunk:
                        buf    += chunk
                        last_t  = time.time()
                except (OSError, BlockingIOError):
                    pass

            if not buf:
                continue

            if marker in buf:
                return buf, 'done'

            tail = buf[-300:]
            if _PTY_SUDO_RE.search(tail):
                time.sleep(0.08)
                buf += self._drain(0.1)
                return buf, 'password'

            if _PTY_INPUT_RE.search(tail):
                time.sleep(0.08)
                buf += self._drain(0.1)
                return buf, 'input'

            # No new data for 0.6 s — check what's on the last line
            if time.time() - last_t > 0.6:
                last_line = buf.rstrip().rsplit(b'\n', 1)[-1].strip()

                if last_line:
                    last_ch = last_line[-1:]
                    if last_ch in (b':', b'?', b']'):
                        # Looks like an interactive yes/no or other text prompt
                        return buf, 'input'

                    if last_ch in (b'#', b'$', b'>', b'%') and not injected:
                        # Looks like a shell prompt without our marker.
                        # This happens when sudo su / su / bash opens a sub-shell
                        # that doesn't inherit our PS1.  Inject PS1 into it so
                        # our marker appears and we can detect command completion.
                        injected = True
                        self._write(ps1_inject)
                        last_t = time.time()
                        continue   # keep reading — the new marker prompt will arrive

                last_t = time.time()

        return buf, 'timeout'

    def interrupt(self):
        """Send Ctrl-C to the PTY without waiting for the session lock."""
        try:
            os.write(self._master, b'\x03')
        except OSError:
            pass

    def execute(self, cmd, timeout=30):
        with self._lock:
            if not self.alive():
                self._spawn()
            self._drain(0.05)   # flush any stale output from prior command
            with _terminal_lock:
                cwd  = _terminal_state['cwd']
                home = _terminal_state['home']
            wrapped = f'cd {shlex.quote(cwd)} 2>/dev/null || cd /; {cmd}'
            self._write(wrapped + '\n')
            raw, status = self._read_until_done(timeout)
            return self._build_result(raw, status, cwd, home)

    def send_reply(self, reply, timeout=30):
        """Send reply to an interactive prompt (password, yes/no …)."""
        with self._lock:
            self._write(reply + '\n')
            with _terminal_lock:
                cwd  = _terminal_state['cwd']
                home = _terminal_state['home']
            raw, status = self._read_until_done(timeout)
            return self._build_result(raw, status, cwd, home)

    def _build_result(self, raw, status, cwd, home):
        marker = self.MARKER.encode()

        if status == 'done':
            before, _, after = raw.partition(marker)
            rc      = 0
            new_cwd = cwd
            # Prompt: ':<rc>:<cwd><promptchar> ' — promptchar ist '#' (root) oder '$'.
            # cwd non-greedy bis zum Prompt-Zeichen+Leerzeichen erfassen.
            m = re.match(rb':(\d+):(.*?)[#$] ', after)
            if m:
                try:
                    rc = int(m.group(1).decode('ascii', 'replace'))
                except ValueError:
                    pass
                raw_cwd = m.group(2).decode('utf-8', 'replace').strip()
                if raw_cwd == '~':
                    new_cwd = home
                elif raw_cwd.startswith('~/'):
                    new_cwd = home + raw_cwd[1:]
                elif raw_cwd.startswith('/'):
                    new_cwd = raw_cwd

            with _terminal_lock:
                _terminal_state['cwd'] = new_cwd

            text = self._strip_ansi(before)
            # Remove echoed command (first line from PTY echo)
            lines = text.split('\n')
            if lines:
                lines = lines[1:]
            text = '\n'.join(lines).strip('\r\n')
            if text:
                text += '\n'

            return {
                'success': rc == 0, 'returncode': rc,
                'stdout': text, 'stderr': '',
                'cwd': new_cwd, 'display_cwd': _term_display_cwd(new_cwd, home),
            }

        elif status in ('password', 'input'):
            text = self._strip_ansi(raw)
            lines = text.split('\n')
            if lines:
                lines = lines[1:]
            text = '\n'.join(lines).strip('\r\n')
            return {
                'needs_input': True, 'input_type': status,
                'stdout': text, 'stderr': '',
                'cwd': cwd, 'display_cwd': _term_display_cwd(cwd, home),
            }

        else:  # timeout
            text = self._strip_ansi(raw)
            lines = text.split('\n')[1:]
            text = '\n'.join(lines).strip('\r\n')
            return {
                'success': False, 'returncode': -1,
                'stdout': text, 'stderr': f'Timeout nach 30s',
                'cwd': cwd, 'display_cwd': _term_display_cwd(cwd, home),
            }

    @staticmethod
    def _strip_ansi(raw):
        text = raw.decode('utf-8', errors='replace')
        # [0-9;?]* deckt auch private CSI-Sequenzen ab (z.B. Bracketed-Paste
        # \x1b[?2004h / \x1b[?2004l), die bash um jedes Kommando herum sendet.
        text = re.sub(r'\x1b\[[0-9;?]*[a-zA-Z]', '', text)
        text = re.sub(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)', '', text)
        text = re.sub(r'\x1b[()][AB012]', '', text)
        text = re.sub(r'[\x0e\x0f]', '', text)
        text = re.sub(r'\r\n', '\n', text)
        text = re.sub(r'\r', '\n', text)
        return text


_pty_session = _PtySession()


def _term_display_cwd(cwd, home):
    if home and cwd == home:
        return "~"
    if home and cwd.startswith(home + "/"):
        return "~" + cwd[len(home):]
    return cwd or "/"


def get_terminal_info():
    with _terminal_lock:
        cwd  = _terminal_state["cwd"]
        home = _terminal_state["home"]
        cached_user = _terminal_state.get("user")
        cached_host = _terminal_state.get("hostname")

    user = cached_user
    hostname = cached_host

    if not user:
        for cmd in [_ns(["whoami"]), ["whoami"]]:
            try:
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
                if r.returncode == 0:
                    user = r.stdout.strip()
                    break
            except Exception:
                continue
        user = user or "root"

    if not hostname:
        for cmd in [_ns(["hostname"]), ["hostname"]]:
            try:
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
                if r.returncode == 0:
                    hostname = r.stdout.strip()
                    break
            except Exception:
                continue
        hostname = hostname or "host"

    with _terminal_lock:
        _terminal_state["user"]     = user
        _terminal_state["hostname"] = hostname

    return {
        "user":        user,
        "hostname":    hostname,
        "cwd":         cwd,
        "display_cwd": _term_display_cwd(cwd, home),
        "home":        home,
    }


def execute_stateful_command(cmd, timeout=30):
    dangerous = ["rm -rf /", "mkfs", "dd if=", ":(){", "fork bomb"]
    for d in dangerous:
        if d in cmd:
            with _terminal_lock:
                cwd = _terminal_state["cwd"]
            return {"success": False, "returncode": 1, "stdout": "",
                    "stderr": f"Blockiert: gefährliches Muster '{d}'",
                    "cwd": cwd, "display_cwd": _term_display_cwd(cwd, _terminal_state["home"])}

    with _terminal_lock:
        current_cwd = _terminal_state["cwd"]
        home        = _terminal_state["home"]

    # Wrap: cd to saved dir, run user cmd, capture exit code, echo new pwd
    wrapped = (
        f"cd {shlex.quote(current_cwd)} 2>/dev/null || cd /; "
        f"{cmd}; "
        f"__EC__=$?; "
        f"echo {_TERM_MARKER}:$(pwd); "
        f"exit $__EC__"
    )

    result = None
    for full_cmd in [_ns(["bash", "-c", wrapped]), ["bash", "-c", wrapped]]:
        try:
            result = subprocess.run(
                full_cmd, capture_output=True, text=True, timeout=timeout
            )
            break
        except FileNotFoundError:
            continue
        except subprocess.TimeoutExpired:
            with _terminal_lock:
                cwd = _terminal_state["cwd"]
            return {"success": False, "returncode": -1, "stdout": "",
                    "stderr": f"Timeout nach {timeout}s",
                    "cwd": cwd, "display_cwd": _term_display_cwd(cwd, home)}
        except Exception as e:
            with _terminal_lock:
                cwd = _terminal_state["cwd"]
            return {"success": False, "returncode": -1, "stdout": "", "stderr": str(e),
                    "cwd": cwd, "display_cwd": _term_display_cwd(cwd, home)}

    if result is None:
        return {"success": False, "returncode": 127, "stdout": "",
                "stderr": "bash nicht gefunden",
                "cwd": current_cwd, "display_cwd": _term_display_cwd(current_cwd, home)}

    # Extract new CWD from stdout and strip the marker line
    stdout   = result.stdout
    new_cwd  = current_cwd
    m = re.search(rf'{re.escape(_TERM_MARKER)}:(.+)$', stdout, re.MULTILINE)
    if m:
        new_cwd = m.group(1).strip()
        stdout  = stdout[:m.start()].rstrip("\n")
        if stdout:
            stdout += "\n"

    with _terminal_lock:
        _terminal_state["cwd"] = new_cwd

    return {
        "success":     result.returncode == 0,
        "returncode":  result.returncode,
        "stdout":      stdout[-10000:],
        "stderr":      result.stderr[-5000:],
        "cwd":         new_cwd,
        "display_cwd": _term_display_cwd(new_cwd, home),
    }


# ─── Session Management ──────────────────────────────────────────────────────

