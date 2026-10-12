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

from dashboard.vms import _v

def list_networks():
    """List all libvirt networks with details."""
    try:
        r = _v("net-list", "--all")
        if r.returncode != 0:
            return []
        networks = []
        for line in r.stdout.strip().split("\n")[2:]:
            parts = line.split()
            if len(parts) < 3:
                continue
            net_name = parts[0]
            active = parts[1].lower() in ("active", "yes")
            auto = parts[2].lower() == "yes"
            info = {"name": net_name, "active": active, "autostart": auto,
                    "forward_mode": "", "ip": "", "prefix": "",
                    "dhcp_start": "", "dhcp_end": "", "bridge": "", "leases": 0}
            try:
                xr = _v("net-dumpxml", net_name)
                if xr.returncode == 0:
                    root = ET.fromstring(xr.stdout)
                    fwd = root.find("forward")
                    info["forward_mode"] = fwd.get("mode", "") if fwd is not None else "isolated"
                    br = root.find("bridge")
                    if br is not None:
                        info["bridge"] = br.get("name", "")
                    ip_elem = root.find("ip")
                    if ip_elem is not None:
                        info["ip"] = ip_elem.get("address", "")
                        info["prefix"] = ip_elem.get("prefix", ip_elem.get("netmask", ""))
                        dhcp = ip_elem.find("dhcp/range")
                        if dhcp is not None:
                            info["dhcp_start"] = dhcp.get("start", "")
                            info["dhcp_end"] = dhcp.get("end", "")
            except Exception:
                pass
            if active:
                try:
                    lr = _v("net-dhcp-leases", net_name)
                    if lr.returncode == 0:
                        info["leases"] = max(0, len([l for l in lr.stdout.strip().split("\n")[2:] if l.strip()]))
                except Exception:
                    pass
            networks.append(info)
        return networks
    except Exception:
        return []


def net_leases(name):
    """Aktive DHCP-Leases eines Netzwerks (verbundene Gäste: MAC/IP/Hostname)."""
    r = _v("net-dhcp-leases", name)
    if r.returncode != 0:
        return {"error": r.stderr.strip()}
    leases = []
    for line in r.stdout.strip().split("\n")[2:]:
        parts = line.split()
        if len(parts) < 5 or not parts[0].strip():
            continue
        # Spalten: Expiry(2) MAC Protokoll IP Hostname ClientID
        leases.append({
            "mac": parts[2] if len(parts) > 2 else "",
            "ip": parts[4].split("/")[0] if len(parts) > 4 else "",
            "hostname": parts[5] if len(parts) > 5 and parts[5] != "-" else "",
            "expiry": " ".join(parts[0:2]),
        })
    return {"leases": leases}


def net_get_xml(name):
    """Rohes (persistentes) Netzwerk-XML für den Editor."""
    r = _v("net-dumpxml", "--inactive", name)
    if r.returncode != 0:
        r = _v("net-dumpxml", name)
    if r.returncode != 0:
        return {"error": r.stderr.strip()}
    return {"xml": r.stdout}


def net_set_xml(name, xml):
    """Netzwerk-XML übernehmen (net-define). <name> muss erhalten bleiben."""
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as e:
        return {"error": f"XML ungültig: {e}"}
    if root.tag != "network":
        return {"error": "Wurzelelement muss <network> sein"}
    nm = root.find("name")
    if nm is None or (nm.text or "").strip() != name:
        return {"error": f"<name> muss '{name}' bleiben"}
    r = _v("net-define", "/dev/stdin", inp=xml)
    if r.returncode != 0:
        return {"error": r.stderr.strip()}
    return {"success": True, "warnings": ["Änderung gilt nach Netzwerk-Neustart (Stop/Start)"]}


def _net_active(name):
    r = _v("net-info", name)
    return r.returncode == 0 and re.search(r"(?im)^Active:\s*yes", r.stdout) is not None


def net_edit(name, forward_mode=None, ip=None, prefix=None,
             dhcp_start=None, dhcp_end=None, dhcp_enabled=None):
    """Geführtes Bearbeiten (Forward-Modus, IP/Prefix, DHCP-Range). Bestehende
    Reservierungen und andere Elemente bleiben erhalten. Gilt nach Neustart."""
    import ipaddress
    r = _v("net-dumpxml", "--inactive", name)
    if r.returncode != 0:
        r = _v("net-dumpxml", name)
    if r.returncode != 0:
        return {"error": r.stderr.strip()}
    try:
        root = ET.fromstring(r.stdout)
    except ET.ParseError as e:
        return {"error": f"XML Parse-Fehler: {e}"}

    if forward_mode is not None:
        if forward_mode not in ("nat", "route", "open", "bridge", "isolated"):
            return {"error": "Ungültiger Forward-Modus"}
        fwd = root.find("forward")
        if forward_mode == "isolated":
            if fwd is not None:
                root.remove(fwd)
        else:
            if fwd is None:
                fwd = ET.SubElement(root, "forward")
            fwd.set("mode", forward_mode)

    touch_ip = any(v is not None for v in (ip, prefix, dhcp_start, dhcp_end, dhcp_enabled))
    if touch_ip:
        ip_el = root.find("ip")
        if ip_el is None:
            ip_el = ET.SubElement(root, "ip")
        if ip is not None:
            try:
                ipaddress.ip_address(ip)
            except ValueError:
                return {"error": "Ungültige IP-Adresse"}
            ip_el.set("address", ip)
            ip_el.attrib.pop("netmask", None)
        if prefix is not None:
            try:
                pfx = int(prefix)
                assert 1 <= pfx <= 32
            except (ValueError, AssertionError):
                return {"error": "Prefix muss 1–32 sein"}
            ip_el.set("prefix", str(pfx))
        dhcp = ip_el.find("dhcp")
        if dhcp_enabled is False:
            if dhcp is not None:
                ip_el.remove(dhcp)
        elif dhcp_enabled or dhcp_start is not None or dhcp_end is not None:
            if dhcp is None:
                dhcp = ET.SubElement(ip_el, "dhcp")
            rng = dhcp.find("range")
            if rng is None:
                rng = ET.SubElement(dhcp, "range")
            for key, val in (("start", dhcp_start), ("end", dhcp_end)):
                if val is not None:
                    try:
                        ipaddress.ip_address(val)
                    except ValueError:
                        return {"error": f"Ungültige DHCP-{key}-Adresse"}
                    rng.set(key, val)

    r = _v("net-define", "/dev/stdin", inp=ET.tostring(root, encoding="unicode"))
    if r.returncode != 0:
        return {"error": r.stderr.strip()}
    return {"success": True, "warnings": ["Gilt nach Netzwerk-Neustart (Stop/Start)"]}


def net_dhcp_hosts(name):
    """Statische DHCP-Reservierungen (MAC→IP) eines Netzwerks."""
    r = _v("net-dumpxml", "--inactive", name)
    if r.returncode != 0:
        r = _v("net-dumpxml", name)
    if r.returncode != 0:
        return {"error": r.stderr.strip()}
    try:
        root = ET.fromstring(r.stdout)
    except ET.ParseError as e:
        return {"error": f"XML Parse-Fehler: {e}"}
    hosts = []
    for h in root.findall("ip/dhcp/host"):
        hosts.append({"mac": h.get("mac", ""), "ip": h.get("ip", ""),
                      "name": h.get("name", "")})
    return {"hosts": hosts}


def net_add_dhcp_host(name, mac, ip, hostname=""):
    """Statische DHCP-Reservierung hinzufügen (live + persistent, falls aktiv)."""
    import ipaddress
    mac = (mac or "").strip().lower()
    ip = (ip or "").strip()
    hostname = (hostname or "").strip()
    if not re.match(r'^([0-9a-f]{2}:){5}[0-9a-f]{2}$', mac):
        return {"error": "Ungültige MAC-Adresse"}
    try:
        ipaddress.ip_address(ip)
    except ValueError:
        return {"error": "Ungültige IP-Adresse"}
    if hostname and not re.match(r'^[A-Za-z0-9_.-]{1,63}$', hostname):
        return {"error": "Ungültiger Hostname"}
    host = f"<host mac='{mac}'" + (f" name={_xml_attr(hostname)}" if hostname else "") + f" ip='{ip}'/>"
    flags = ["--config"] + (["--live"] if _net_active(name) else [])
    r = _v("net-update", name, "add", "ip-dhcp-host", host, *flags)
    if r.returncode != 0:
        return {"error": r.stderr.strip()}
    return {"success": True}


def net_remove_dhcp_host(name, mac):
    """Statische DHCP-Reservierung anhand der MAC entfernen."""
    mac = (mac or "").strip().lower()
    if not re.match(r'^([0-9a-f]{2}:){5}[0-9a-f]{2}$', mac):
        return {"error": "Ungültige MAC-Adresse"}
    flags = ["--config"] + (["--live"] if _net_active(name) else [])
    r = _v("net-update", name, "delete", "ip-dhcp-host", f"<host mac='{mac}'/>", *flags)
    if r.returncode != 0:
        return {"error": r.stderr.strip()}
    return {"success": True}


def net_create(name, ip_cidr, forward_mode="nat"):
    """Create a new libvirt network."""
    try:
        if not re.match(r'^[A-Za-z0-9_.-]{1,64}$', name or ""):
            return {"error": "Ungültiger Netzwerkname (nur A-Z a-z 0-9 . _ -)"}
        if forward_mode not in ("nat", "route", "open", "bridge", "isolated"):
            return {"error": "Ungültiger Forward-Modus"}
        import ipaddress
        net = ipaddress.ip_network(ip_cidr, strict=False)
        hosts = list(net.hosts())
        gateway = str(hosts[0]) if hosts else ""
        prefix = str(net.prefixlen)
        dhcp_start = str(hosts[10]) if len(hosts) > 11 else (str(hosts[1]) if len(hosts) > 1 else "")
        dhcp_end = str(hosts[-1]) if hosts else ""
        dhcp_xml = ""
        if dhcp_start and dhcp_end:
            dhcp_xml = f"""
      <dhcp>
        <range start='{dhcp_start}' end='{dhcp_end}'/>
      </dhcp>"""
        forward_xml = "" if forward_mode == "isolated" else f"<forward mode='{forward_mode}'/>"
        xml = f"""<network>
  <name>{_xml_escape(name)}</name>
  {forward_xml}
  <ip address='{gateway}' prefix='{prefix}'>{dhcp_xml}
  </ip>
</network>"""
        r = _v("net-define", "/dev/stdin", inp=xml)
        if r.returncode != 0:
            return {"error": f"net-define fehlgeschlagen: {r.stderr.strip()}"}
        _v("net-autostart", name)
        _v("net-start", name)
        return {"success": True, "name": name}
    except Exception as e:
        return {"error": str(e)}


def net_action(name, action):
    """Perform action on a libvirt network."""
    try:
        if action == "start":
            r = _v("net-start", name)
        elif action == "stop":
            r = _v("net-destroy", name)
        elif action == "delete":
            _v("net-destroy", name)
            r = _v("net-undefine", name)
        elif action == "autostart":
            r = _v("net-autostart", name)
        elif action == "no-autostart":
            r = _v("net-autostart", name, "--disable")
        else:
            return {"error": f"Unbekannte Aktion: {action}"}
        if r.returncode != 0:
            return {"error": r.stderr.strip()}
        return {"success": True}
    except Exception as e:
        return {"error": str(e)}


