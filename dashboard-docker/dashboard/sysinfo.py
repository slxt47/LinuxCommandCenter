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

from dashboard.base import _ns

def get_cpu_info():
    """Get CPU usage via /proc/stat — reliable in Docker and bare-metal."""
    try:
        def read_stat():
            stats = {}
            with open("/proc/stat") as f:
                for line in f:
                    if line.startswith("cpu"):
                        parts = line.split()
                        # user, nice, system, idle, iowait, irq, softirq
                        stats[parts[0]] = [int(x) for x in parts[1:8]]
            return stats

        def calc_pct(s1, s2):
            total = sum(s2) - sum(s1)
            idle = (s2[3] + s2[4]) - (s1[3] + s1[4])  # idle + iowait
            return round((1.0 - idle / total) * 100, 1) if total > 0 else 0.0

        s1 = read_stat()
        time.sleep(0.3)
        s2 = read_stat()

        cpu_percent = calc_pct(s1["cpu"], s2["cpu"])
        core_count = os.cpu_count() or 1
        per_core = [
            calc_pct(s1[f"cpu{i}"], s2[f"cpu{i}"])
            for i in range(core_count)
            if f"cpu{i}" in s1 and f"cpu{i}" in s2
        ]

        load = os.getloadavg()

        model = "Unknown"
        try:
            with open("/proc/cpuinfo") as f:
                for line in f:
                    if "model name" in line:
                        model = line.split(":")[1].strip()
                        break
        except Exception:
            pass

        freq = "N/A"
        try:
            with open("/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq") as f:
                freq_val = f.read().strip()
            if freq_val:
                freq = f"{int(freq_val) / 1000:.0f} MHz"
        except Exception:
            pass

        temp = None
        try:
            with open("/sys/class/thermal/thermal_zone0/temp") as f:
                temp_val = f.read().strip()
            if temp_val:
                temp = round(int(temp_val) / 1000, 1)
        except Exception:
            pass

        return {
            "model": model,
            "cores": core_count,
            "usage": cpu_percent,
            "per_core": per_core[:16],
            "load": [round(l, 2) for l in load],
            "frequency": freq,
            "temperature": temp
        }
    except Exception as e:
        return {"error": str(e), "cores": 1, "usage": 0, "per_core": [0], "load": [0, 0, 0]}


def get_memory_info():
    """Get RAM and swap usage."""
    try:
        with open("/proc/meminfo") as f:
            info = {}
            for line in f:
                parts = line.split(":")
                key = parts[0].strip()
                val = int(parts[1].strip().split()[0])
                info[key] = val

        total = info.get("MemTotal", 0)
        available = info.get("MemAvailable", info.get("MemFree", 0))
        used = total - available
        swap_total = info.get("SwapTotal", 0)
        swap_free = info.get("SwapFree", 0)
        swap_used = swap_total - swap_free
        buffers = info.get("Buffers", 0)
        cached = info.get("Cached", 0)

        return {
            "total": total * 1024,
            "used": used * 1024,
            "available": available * 1024,
            "percent": round((used / total) * 100, 1) if total > 0 else 0,
            "buffers": buffers * 1024,
            "cached": cached * 1024,
            "swap_total": swap_total * 1024,
            "swap_used": swap_used * 1024,
            "swap_percent": round((swap_used / swap_total) * 100, 1) if swap_total > 0 else 0
        }
    except Exception as e:
        return {"error": str(e), "total": 0, "used": 0, "percent": 0}


def get_disk_info():
    """Get disk usage for all mounted filesystems."""
    try:
        result = subprocess.run(
            ["df", "-B1", "--output=source,fstype,size,used,avail,pcent,target"],
            capture_output=True, text=True
        )
        disks = []
        for line in result.stdout.strip().split("\n")[1:]:
            parts = line.split()
            if len(parts) >= 7 and not parts[0].startswith("tmpfs") and not parts[0].startswith("devtmpfs"):
                disks.append({
                    "device": parts[0],
                    "fstype": parts[1],
                    "total": int(parts[2]),
                    "used": int(parts[3]),
                    "available": int(parts[4]),
                    "percent": int(parts[5].replace("%", "")),
                    "mountpoint": parts[6]
                })
        return disks
    except Exception as e:
        return [{"error": str(e)}]


def get_network_info():
    """Get network interfaces and traffic."""
    try:
        interfaces = []
        with open("/proc/net/dev") as f:
            for line in f.readlines()[2:]:
                parts = line.split(":")
                if len(parts) == 2:
                    name = parts[0].strip()
                    if name == "lo":
                        continue
                    vals = parts[1].split()
                    interfaces.append({
                        "name": name,
                        "rx_bytes": int(vals[0]),
                        "rx_packets": int(vals[1]),
                        "tx_bytes": int(vals[8]),
                        "tx_packets": int(vals[9]),
                    })

        ip_result = subprocess.run(["ip", "-j", "addr", "show"], capture_output=True, text=True)
        try:
            ip_data = json.loads(ip_result.stdout)
            ip_map = {}
            for iface in ip_data:
                name = iface.get("ifname", "")
                addrs = []
                for addr_info in iface.get("addr_info", []):
                    addrs.append({
                        "family": addr_info.get("family", ""),
                        "address": addr_info.get("local", ""),
                        "prefixlen": addr_info.get("prefixlen", 0)
                    })
                ip_map[name] = addrs
            for iface in interfaces:
                iface["addresses"] = ip_map.get(iface["name"], [])
        except Exception:
            pass

        return interfaces
    except Exception as e:
        return [{"error": str(e)}]


def get_system_info():
    """Get general system information."""
    try:
        hostname = subprocess.run(["hostname"], capture_output=True, text=True).stdout.strip()

        with open("/proc/uptime") as f:
            uptime_secs = float(f.read().split()[0])

        days = int(uptime_secs // 86400)
        hours = int((uptime_secs % 86400) // 3600)
        mins = int((uptime_secs % 3600) // 60)
        uptime_str = f"{days}d {hours}h {mins}m"

        os_info = "Linux"
        try:
            with open("/etc/os-release") as f:
                for line in f:
                    if line.startswith("PRETTY_NAME="):
                        os_info = line.split("=")[1].strip().strip('"')
                        break
        except Exception:
            pass

        kernel = subprocess.run(["uname", "-r"], capture_output=True, text=True).stdout.strip()
        users = subprocess.run(["who"], capture_output=True, text=True).stdout.strip()
        user_count = len([l for l in users.split("\n") if l.strip()]) if users else 0
        proc_count = len([p for p in os.listdir("/proc") if p.isdigit()])

        return {
            "hostname": hostname,
            "os": os_info,
            "kernel": kernel,
            "uptime": uptime_str,
            "uptime_seconds": uptime_secs,
            "users": user_count,
            "processes": proc_count,
            "arch": subprocess.run(["uname", "-m"], capture_output=True, text=True).stdout.strip()
        }
    except Exception as e:
        return {"error": str(e), "hostname": "unknown"}


def get_top_processes(count=15):
    """Get top processes by CPU/memory usage."""
    try:
        result = subprocess.run(
            ["ps", "aux", "--sort=-%cpu"],
            capture_output=True, text=True
        )
        procs = []
        for line in result.stdout.strip().split("\n")[1:count+1]:
            parts = line.split(None, 10)
            if len(parts) >= 11:
                procs.append({
                    "user": parts[0],
                    "pid": int(parts[1]),
                    "cpu": float(parts[2]),
                    "mem": float(parts[3]),
                    "vsz": int(parts[4]),
                    "rss": int(parts[5]),
                    "stat": parts[7],
                    "time": parts[9],
                    "command": parts[10][:80]
                })
        return procs
    except Exception as e:
        return [{"error": str(e)}]


def get_services():
    """Get systemd service status via nsenter to host systemd."""
    try:
        cmd = ["systemctl", "list-units", "--type=service", "--all", "--no-pager", "--plain"]
        result = None

        for full_cmd in [_ns(cmd), cmd]:
            try:
                r = subprocess.run(full_cmd, capture_output=True, text=True, timeout=10)
                if r.returncode == 0 and r.stdout.strip():
                    result = r
                    break
            except FileNotFoundError:
                continue

        if result is None:
            return {"error": "systemd nicht erreichbar — Container benötigt privileged-Modus"}

        services = []
        for line in result.stdout.strip().split("\n")[1:]:
            parts = line.split(None, 4)
            if len(parts) >= 4 and parts[0].endswith(".service"):
                services.append({
                    "name": parts[0].replace(".service", ""),
                    "load": parts[1],
                    "active": parts[2],
                    "sub": parts[3],
                    "description": parts[4].strip() if len(parts) > 4 else ""
                })
        return services[:50]
    except Exception as e:
        return {"error": str(e)}


# ─── Package Management ─────────────────────────────────────────────────────

def get_updates():
    """Check for available package updates on host."""
    try:
        cmd = ["apt", "list", "--upgradable"]
        result = None

        for full_cmd in [_ns(cmd), cmd]:
            try:
                r = subprocess.run(full_cmd, capture_output=True, text=True, timeout=30)
                if r.returncode == 0:
                    result = r
                    break
            except FileNotFoundError:
                continue

        if result is None:
            return {"manager": "unknown", "packages": [], "count": 0, "error": "Kein Paketmanager gefunden"}

        packages = []
        for line in result.stdout.strip().split("\n")[1:]:
            if "/" in line:
                name = line.split("/")[0]
                parts = line.split()
                version = parts[1] if len(parts) > 1 else "unknown"
                packages.append({"name": name, "version": version, "manager": "apt"})
        return {"manager": "apt", "packages": packages, "count": len(packages)}
    except Exception as e:
        return {"manager": "apt", "packages": [], "count": 0, "error": str(e)}


def run_update():
    """Run system update on host via nsenter."""
    try:
        cmd = "apt update && apt upgrade -y 2>&1"
        for full_cmd in [_ns(["bash", "-c", cmd]), ["bash", "-c", cmd]]:
            try:
                result = subprocess.run(full_cmd, capture_output=True, text=True, timeout=600)
                return {"success": result.returncode == 0, "output": result.stdout + result.stderr}
            except FileNotFoundError:
                continue
        return {"success": False, "output": "bash nicht gefunden"}
    except Exception as e:
        return {"success": False, "output": str(e)}


# ─── VM Management (libvirt) ─────────────────────────────────────────────────

