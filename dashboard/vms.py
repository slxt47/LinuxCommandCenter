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

from dashboard.base import DATA_DIR, _ns

def get_vms():
    """Get list of VMs via virsh (direct socket mount or nsenter)."""
    cmd = ["virsh", "list", "--all"]
    result = None
    use_ns = False

    for full_cmd, ns in [(cmd, False), (_ns(cmd), True)]:
        try:
            r = subprocess.run(full_cmd, capture_output=True, text=True, timeout=10)
            if r.returncode == 0:
                result = r
                use_ns = ns
                break
        except FileNotFoundError:
            continue
        except Exception:
            continue

    if result is None:
        return {"vms": [], "error": "virsh nicht gefunden — libvirt nicht verfügbar"}

    def virsh_cmd(*args):
        c = ["virsh"] + list(args)
        return _ns(c) if use_ns else c

    vms = []
    owners = vm_owners_load()
    viewers = vm_viewers_load()
    for line in result.stdout.strip().split("\n")[2:]:
        parts = line.split(None, 2)
        if len(parts) >= 2:
            vm_id = parts[0] if parts[0] != "-" else None
            name = parts[1]
            state = parts[2].strip() if len(parts) > 2 else "unknown"

            vm_info = {"id": vm_id, "name": name, "state": state, "displays": [],
                       "owner": owners.get(name), "viewers": viewers.get(name, [])}
            try:
                info_r = subprocess.run(
                    virsh_cmd("dominfo", name),
                    capture_output=True, text=True, timeout=5
                )
                for info_line in info_r.stdout.split("\n"):
                    if ":" in info_line:
                        k, v = info_line.split(":", 1)
                        vm_info[k.strip().lower().replace(" ", "_")] = v.strip()
            except Exception:
                pass

            # Parse graphics/display info for running VMs
            if "running" in state:
                try:
                    xml_r = subprocess.run(
                        virsh_cmd("dumpxml", name),
                        capture_output=True, text=True, timeout=10
                    )
                    if xml_r.returncode == 0:
                        root = ET.fromstring(xml_r.stdout)
                        for gfx in root.findall(".//graphics"):
                            gtype = gfx.get("type", "")
                            port  = int(gfx.get("port", -1))
                            if port > 0:
                                vm_info["displays"].append({"type": gtype, "port": port})
                except Exception:
                    pass

            vms.append(vm_info)

    return {"vms": vms}


def get_vm_display(name, dtype="auto"):
    """Parse virsh XML to get VNC or SPICE display info."""
    last_err = ""
    try:
        for cmd in [["virsh", "dumpxml", name], _ns(["virsh", "dumpxml", name])]:
            try:
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
                if r.returncode != 0:
                    last_err = (r.stderr or "").strip() or last_err
                    continue
                root = ET.fromstring(r.stdout)
                displays = []
                for gfx in root.findall(".//graphics"):
                    gtype = gfx.get("type", "")
                    port  = int(gfx.get("port", -1))
                    if port <= 0:
                        continue
                    listen  = gfx.get("listen", "127.0.0.1") or "127.0.0.1"
                    if listen in ("0.0.0.0", "*", ""):
                        listen = "127.0.0.1"
                    keymap  = gfx.get("keymap", "us") or "us"
                    displays.append({"type": gtype, "port": port, "listen": listen, "keymap": keymap})

                if not displays:
                    return {"error": "Keine grafische Konsole konfiguriert"}
                if dtype == "auto":
                    return displays[0]
                for d in displays:
                    if d["type"] == dtype:
                        return d
                configured = ", ".join(d["type"] for d in displays)
                return {"error": f"VM hat kein {dtype}-Display — konfiguriert: {configured}"}
            except FileNotFoundError:
                continue
    except Exception as e:
        return {"error": str(e)}
    # rc≠0 bei beiden Varianten → echten virsh-Fehler zurückgeben (z.B. „failed
    # to get domain"), statt fälschlich „virsh nicht verfügbar".
    return {"error": last_err or "virsh nicht verfügbar"}


def vm_action(name, action):
    """Perform action on VM."""
    allowed = ["start", "shutdown", "reboot", "destroy", "suspend", "resume"]
    if action not in allowed:
        return {"success": False, "error": f"Invalid action. Allowed: {', '.join(allowed)}"}

    cmd = ["virsh", action, name]
    for full_cmd in [cmd, _ns(cmd)]:
        try:
            result = subprocess.run(full_cmd, capture_output=True, text=True, timeout=30)
            return {
                "success": result.returncode == 0,
                "output": result.stdout.strip(),
                "error": result.stderr.strip() if result.returncode != 0 else None
            }
        except FileNotFoundError:
            continue
        except Exception as e:
            return {"success": False, "error": str(e)}

    return {"success": False, "error": "virsh nicht verfügbar"}


# ─── virsh helper ────────────────────────────────────────────────────────────

def _v(*a, inp=None, timeout=30):
    """Unified virsh helper — tries direct then nsenter."""
    for cmd in [["virsh"] + list(a), _ns(["virsh"] + list(a))]:
        try:
            return subprocess.run(
                cmd, capture_output=True, text=True, timeout=timeout, input=inp
            )
        except FileNotFoundError:
            continue
        except subprocess.TimeoutExpired:
            class _R:
                returncode = -1; stdout = ""; stderr = "Timeout"
            return _R()
        except Exception as ex:
            class _R:
                returncode = -1; stdout = ""; stderr = str(ex)
            return _R()
    class _R:
        returncode = -1; stdout = ""; stderr = "virsh nicht verfügbar"
    return _R()


def _parse_mem_mib(value_str, unit_str):
    """Parse libvirt memory value+unit into MiB."""
    try:
        val = int(value_str.strip())
    except (ValueError, AttributeError):
        return 0
    unit = (unit_str or "KiB").strip()
    if unit in ("KiB", "kb"):
        return val // 1024
    if unit in ("MiB", "mb"):
        return val
    if unit in ("GiB", "gb"):
        return val * 1024
    # default: assume KiB
    return val // 1024


# VM-Besitzer (Rollenmodell): {vm_name: username}. Admins (Gruppe dashadmin) sehen und
# verwalten nur VMs, die sie selbst angelegt/geklont haben; Superadmins alles.
# VMs ohne Eintrag (Bestand vor Einführung) gehören implizit den Superadmins.
_OWNERS_FILE = DATA_DIR / "vm_owners.json"
_owners_lock = threading.Lock()


def vm_owners_load():
    try:
        with _owners_lock:
            if _OWNERS_FILE.exists():
                d = json.loads(_OWNERS_FILE.read_text())
                return d if isinstance(d, dict) else {}
    except Exception:
        pass
    return {}


def _owners_save_locked(d):
    tmp = _OWNERS_FILE.with_name(_OWNERS_FILE.name + ".tmp")
    tmp.write_text(json.dumps(d, indent=1, sort_keys=True))
    os.replace(tmp, _OWNERS_FILE)


def vm_owner_get(name):
    return vm_owners_load().get(name)


def vm_owner_set(name, owner):
    with _owners_lock:
        try:
            d = json.loads(_OWNERS_FILE.read_text()) if _OWNERS_FILE.exists() else {}
            if not isinstance(d, dict):
                d = {}
        except Exception:
            d = {}
        if owner:
            d[name] = owner
        else:
            d.pop(name, None)
        try:
            _owners_save_locked(d)
        except Exception:
            pass


def vm_owner_remove(name):
    vm_owner_set(name, None)


def vm_names_owned_by(owner):
    return {n for n, o in vm_owners_load().items() if o == owner}


# Sichtbarkeit (Superadmin-Freigabe): {vm_name: [user, ...]}. Freigegebene Benutzer
# sehen die VM, dürfen Konsole/Power-Aktionen nutzen, aber nichts konfigurieren.
_VIEWERS_FILE = DATA_DIR / "vm_viewers.json"


def vm_viewers_load():
    try:
        with _owners_lock:
            if _VIEWERS_FILE.exists():
                d = json.loads(_VIEWERS_FILE.read_text())
                return {k: list(v) for k, v in d.items() if isinstance(v, list)} \
                    if isinstance(d, dict) else {}
    except Exception:
        pass
    return {}


def vm_viewers_get(name):
    return vm_viewers_load().get(name, [])


def vm_viewers_set(name, users):
    users = sorted({u for u in (users or []) if u})
    with _owners_lock:
        try:
            d = json.loads(_VIEWERS_FILE.read_text()) if _VIEWERS_FILE.exists() else {}
            if not isinstance(d, dict):
                d = {}
        except Exception:
            d = {}
        if users:
            d[name] = users
        else:
            d.pop(name, None)
        try:
            tmp = _VIEWERS_FILE.with_name(_VIEWERS_FILE.name + ".tmp")
            tmp.write_text(json.dumps(d, indent=1, sort_keys=True))
            os.replace(tmp, _VIEWERS_FILE)
        except Exception:
            pass
    return users


def vm_viewers_remove(name):
    vm_viewers_set(name, [])


def vm_names_visible_to(user):
    """Eigene + freigegebene VMs eines Benutzers."""
    names = vm_names_owned_by(user)
    names.update(n for n, v in vm_viewers_load().items() if user in v)
    return names


# kasmVNC-Präferenz pro VM (Dashboard-seitig, da kasmVNC ein Viewer über VNC/SPICE
# ist und kein VM-Gerät). Datei enthält die Namen der VMs mit deaktiviertem kasmVNC.
_KASMVNC_PREF_FILE = DATA_DIR / "vm_kasmvnc_off.json"
_kasmvnc_pref_lock = threading.Lock()


def _kasmvnc_pref_load():
    try:
        with _kasmvnc_pref_lock:
            if _KASMVNC_PREF_FILE.exists():
                return set(json.loads(_KASMVNC_PREF_FILE.read_text()))
    except Exception:
        pass
    return set()


def set_kasmvnc_pref(name, enabled):
    """kasmVNC für eine VM aktivieren/deaktivieren (nur Dashboard-Anzeige)."""
    with _kasmvnc_pref_lock:
        try:
            cur = set(json.loads(_KASMVNC_PREF_FILE.read_text())) if _KASMVNC_PREF_FILE.exists() else set()
        except Exception:
            cur = set()
        cur.discard(name) if enabled else cur.add(name)
        try:
            tmp = _KASMVNC_PREF_FILE.with_name(_KASMVNC_PREF_FILE.name + ".tmp")
            tmp.write_text(json.dumps(sorted(cur)))
            os.replace(tmp, _KASMVNC_PREF_FILE)
        except Exception as e:
            return {"error": str(e)}
    return {"success": True, "enabled": bool(enabled)}


def get_vm_full(name):
    """Return structured dict with full VM details."""
    info = {
        "name": name, "state": "unknown", "vcpus": None, "memory_mib": None,
        "max_mem_mib": None, "disks": [], "interfaces": [], "boot_order": [],
        "machine": None, "video": {}, "autostart": "nein", "sounds": [],
        "cpu_mode": "host-passthrough", "cpu_sockets": 1, "cpu_cores": 1,
        "cpu_threads": 1, "firmware": "bios", "vnc_keymap": "en-us",
        "displays": [], "secure_boot": False, "has_tpm": False,
        "tpm_version": None, "boot_menu": False,
        "has_vnc": False, "has_spice": False, "kasmvnc_enabled": True,
    }
    try:
        r = _v("domstate", name)
        if r.returncode == 0:
            info["state"] = r.stdout.strip()

        r = _v("dominfo", name)
        if r.returncode == 0:
            for line in r.stdout.split("\n"):
                if ":" not in line:
                    continue
                k, v = line.split(":", 1)
                k, v = k.strip().lower(), v.strip()
                if k == "cpu(s)":
                    try: info["vcpus"] = int(v)
                    except ValueError: pass
                elif k == "max memory":
                    parts = v.split()
                    info["max_mem_mib"] = _parse_mem_mib(parts[0], parts[1] if len(parts)>1 else "KiB")
                elif k == "used memory":
                    parts = v.split()
                    info["memory_mib"] = _parse_mem_mib(parts[0], parts[1] if len(parts)>1 else "KiB")
                elif k == "autostart":
                    info["autostart"] = "ja" if v.lower() == "enable" else "nein"

        r = _v("dumpxml", "--inactive", name)
        if r.returncode != 0:
            r = _v("dumpxml", name)  # fallback for transient/running-only domains
        if r.returncode == 0:
            root = ET.fromstring(r.stdout)

            # disks
            for disk in root.findall(".//disk"):
                device   = disk.get("device", "")
                readonly = disk.find("readonly") is not None
                driver   = disk.find("driver")
                fmt      = driver.get("type", "") if driver is not None else ""
                source   = disk.find("source")
                src      = ""
                if source is not None:
                    src = source.get("file") or source.get("dev") or source.get("volume") or ""
                target   = disk.find("target")
                tgt_dev  = target.get("dev", "") if target is not None else ""
                tgt_bus  = target.get("bus", "") if target is not None else ""
                info["disks"].append({
                    "device": device, "format": fmt, "source": src,
                    "target": tgt_dev, "bus": tgt_bus, "readonly": readonly
                })

            # interfaces
            for iface in root.findall(".//interface"):
                source     = iface.find("source")
                src        = ""
                if source is not None:
                    src = source.get("network") or source.get("bridge") or source.get("dev") or ""
                model      = iface.find("model")
                mac        = iface.find("mac")
                info["interfaces"].append({
                    "type": iface.get("type", ""),
                    "source": src,
                    "model": model.get("type", "") if model is not None else "",
                    "mac": mac.get("address", "") if mac is not None else "",
                })

            # os / boot
            os_elem = root.find("os")
            if os_elem is not None:
                for b in os_elem.findall("boot"):
                    info["boot_order"].append(b.get("dev", ""))
                type_elem = os_elem.find("type")
                if type_elem is not None:
                    info["machine"] = type_elem.get("machine", "")
                # firmware detection — sowohl expliziter <loader> als auch
                # der libvirt-Auto-Modus <os firmware='efi'>
                if os_elem.get("firmware") == "efi":
                    info["firmware"] = "uefi"
                loader = os_elem.find("loader")
                if loader is not None and loader.text:
                    info["firmware"] = "uefi"
                if loader is not None and loader.get("secure") == "yes":
                    info["secure_boot"] = True
                fw_el = os_elem.find("firmware")
                if fw_el is not None:
                    for fe in fw_el.findall("feature"):
                        if fe.get("name") == "secure-boot" and fe.get("enabled") == "yes":
                            info["secure_boot"] = True
                bm = os_elem.find("bootmenu")
                if bm is not None and bm.get("enable") == "yes":
                    info["boot_menu"] = True
            # SMM als zusätzlicher Secure-Boot-Indikator
            if root.find("features/smm") is not None:
                info["secure_boot"] = info["secure_boot"] or (info["firmware"] == "uefi")
            # TPM
            tpm_el = root.find(".//tpm")
            if tpm_el is not None:
                info["has_tpm"] = True
                be = tpm_el.find("backend")
                info["tpm_version"] = be.get("version", "2.0") if be is not None else "2.0"

            # vcpu count + max memory — read from persistent XML so the Hardware
            # tab always shows the saved config, not the live (running) values
            vcpu_el = root.find("vcpu")
            if vcpu_el is not None:
                try: info["vcpus"] = int(vcpu_el.text or 1)
                except: pass
            mem_el = root.find("memory")
            if mem_el is not None:
                try:
                    info["max_mem_mib"] = _parse_mem_mib(
                        mem_el.text or "0", mem_el.get("unit", "KiB"))
                except: pass

            # cpu
            cpu_el = root.find("cpu")
            if cpu_el is not None:
                info["cpu_mode"] = cpu_el.get("mode", "host-passthrough")
                topo = cpu_el.find("topology")
                if topo is not None:
                    try: info["cpu_sockets"] = int(topo.get("sockets", 1))
                    except: pass
                    try: info["cpu_cores"]   = int(topo.get("cores", 1))
                    except: pass
                    try: info["cpu_threads"] = int(topo.get("threads", 1))
                    except: pass

            # video
            video = root.find(".//video/model")
            if video is not None:
                info["video"] = {
                    "type": video.get("type", ""),
                    "vram_kib": int(video.get("vram", 0) or 0)
                }

            # sound
            for snd in root.findall(".//sound"):
                info["sounds"].append({"model": snd.get("model", "")})

            # displays + vnc keymap
            vnc_seen = False
            for gfx in root.findall(".//graphics"):
                gtype = gfx.get("type", "")
                port  = int(gfx.get("port", -1))
                if gtype and port > 0:
                    info["displays"].append({"type": gtype, "port": port})
                if gtype == "vnc":
                    info["has_vnc"] = True
                    if not vnc_seen:
                        info["vnc_keymap"] = gfx.get("keymap") or "en-us"
                        vnc_seen = True
                if gtype == "spice":
                    info["has_spice"] = True

        # kasmVNC ist ein Viewer über VNC/SPICE — pro VM per Dashboard-Präferenz
        # abschaltbar (unabhängig davon, ob VNC/SPICE vorhanden sind).
        info["kasmvnc_enabled"] = name not in _kasmvnc_pref_load()
    except Exception as e:
        info["error"] = str(e)
    return info


def vm_stats(name):
    """Live-Auslastung einer laufenden VM: CPU% (aus zwei cpu.time-Samples) und
    RAM (aus balloon-Statistiken, benötigt Gast-Ballon/-Agent)."""
    def sample():
        r = _v("domstats", "--cpu-total", "--balloon", "--vcpu", name)
        d = {}
        if r.returncode == 0:
            for line in r.stdout.splitlines():
                line = line.strip()
                if "=" in line:
                    k, v = line.split("=", 1)
                    d[k] = v
        return d
    try:
        s1 = sample()
        if not s1 or s1.get("state.state") not in ("1", None) and "cpu.time" not in s1:
            return {"running": False}
        if "cpu.time" not in s1:
            return {"running": False}
        t1 = time.time(); c1 = int(s1.get("cpu.time", 0))
        time.sleep(0.5)
        s2 = sample()
        t2 = time.time(); c2 = int(s2.get("cpu.time", c1))
        dt_ns = (t2 - t1) * 1e9
        vcpus = int(s2.get("vcpu.current") or s2.get("vcpu.maximum") or 1) or 1
        cpu_pct = 0.0
        if dt_ns > 0:
            cpu_pct = max(0.0, min(100.0, (c2 - c1) / (dt_ns * vcpus) * 100))

        avail  = int(s2.get("balloon.available", 0))   # KiB, gesamter Gast-RAM
        unused = int(s2.get("balloon.unused", 0))
        cur    = int(s2.get("balloon.current", 0))
        rss    = int(s2.get("balloon.rss", 0))
        mem_total_mib = (avail or cur) // 1024
        if avail and unused:
            mem_used_mib = max(0, (avail - unused)) // 1024
            mem_source = "guest"
        else:
            mem_used_mib = rss // 1024                  # Fallback: Host-RSS von QEMU
            mem_source = "host-rss"
        mem_pct = round(mem_used_mib / mem_total_mib * 100, 1) if mem_total_mib else 0
        return {
            "running": True,
            "cpu_percent": round(cpu_pct, 1),
            "vcpus": vcpus,
            "mem_used_mib": mem_used_mib,
            "mem_total_mib": mem_total_mib,
            "mem_percent": mem_pct,
            "mem_source": mem_source,
        }
    except Exception as e:
        return {"running": False, "error": str(e)}


def vm_create(name, vcpus, memory_mib, pool, disk_size_gib, iso_path, network,
              machine="q35", os_type="linux", virtio_iso=""):
    """Create a new VM. os_type 'windows' nutzt SATA-Disk + e1000e-NIC (nativ von
    Windows unterstützt, da virtio ohne Treiber nicht erkannt wird); virtio_iso
    hängt zusätzlich die virtio-win-Treiber-ISO als zweites CD-ROM an."""
    try:
        # Namen/Parameter streng validieren — verhindert XML-Injection ins
        # Domain-XML und krumme Volume-/Pool-Namen.
        if not re.match(r'^[A-Za-z0-9_.-]{1,64}$', name or ""):
            return {"error": "Ungültiger VM-Name (nur A-Z a-z 0-9 . _ -, max. 64)"}
        if not re.match(r'^[A-Za-z0-9_.-]{1,64}$', str(network or "")):
            return {"error": "Ungültiger Netzwerkname"}
        if not re.match(r'^[A-Za-z0-9_.-]{1,64}$', str(machine or "")):
            return {"error": "Ungültiger Maschinentyp"}
        try:
            vcpus      = int(vcpus)
            memory_mib = int(memory_mib)
        except (ValueError, TypeError):
            return {"error": "vcpus/memory_mib müssen Zahlen sein"}

        # Create disk volume
        r = _v("vol-create-as", pool, f"{name}.qcow2", f"{disk_size_gib}G",
               "--format", "qcow2", timeout=120)
        if r.returncode != 0:
            return {"error": f"Disk erstellen fehlgeschlagen: {r.stderr.strip()}"}

        # Get volume path
        r = _v("vol-path", "--pool", pool, f"{name}.qcow2")
        if r.returncode != 0:
            return {"error": f"Vol-Path nicht gefunden: {r.stderr.strip()}"}
        disk_path = r.stdout.strip()

        # Hardware je nach OS: Windows kennt virtio-Disk/-NIC ohne Treiber nicht,
        # daher SATA-Disk + e1000e-NIC (nativ unterstützt). Linux nutzt virtio.
        os_type = (os_type or "linux").lower()
        win = os_type == "windows"
        if win:
            disk_target = "<target dev='sda' bus='sata'/>"
            nic_model   = "e1000e"
            iso_dev, virtio_dev = "sdb", "sdc"
        else:
            disk_target = "<target dev='vda' bus='virtio'/>"
            nic_model   = "virtio"
            iso_dev, virtio_dev = "sda", "sdb"

        # CD-ROMs: Installations-ISO + optional virtio-win-Treiber-ISO
        cdroms = ""
        if iso_path:
            cdroms += f"""
    <disk type='file' device='cdrom'>
      <driver name='qemu' type='raw'/>
      <source file={_xml_attr(iso_path)}/>
      <target dev='{iso_dev}' bus='sata'/>
      <readonly/>
    </disk>"""
        if virtio_iso:
            vsp = os.path.normpath(virtio_iso)
            if os.path.isabs(vsp) and not vsp.startswith(("/dev/", "/proc/", "/sys/", "/etc/")):
                cdroms += f"""
    <disk type='file' device='cdrom'>
      <driver name='qemu' type='raw'/>
      <source file={_xml_attr(virtio_iso)}/>
      <target dev='{virtio_dev}' bus='sata'/>
      <readonly/>
    </disk>"""

        xml = f"""<domain type='kvm'>
  <name>{_xml_escape(name)}</name>
  <memory unit='MiB'>{memory_mib}</memory>
  <currentMemory unit='MiB'>{memory_mib}</currentMemory>
  <vcpu>{vcpus}</vcpu>
  <os>
    <type arch='x86_64' machine={_xml_attr(machine)}>hvm</type>
    <boot dev='cdrom'/>
    <boot dev='hd'/>
  </os>
  <features>
    <acpi/>
    <apic/>
  </features>
  <cpu mode='host-passthrough'/>
  <devices>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2'/>
      <source file={_xml_attr(disk_path)}/>
      {disk_target}
    </disk>{cdroms}
    <interface type='network'>
      <source network={_xml_attr(network)}/>
      <model type='{nic_model}'/>
    </interface>
    <graphics type='vnc' port='-1' listen='127.0.0.1'/>
    <video>
      <model type='vga' vram='16384'/>
    </video>
    <controller type='usb' model='qemu-xhci'/>
    <input type='tablet' bus='usb'/>
    <console type='pty'/>
  </devices>
</domain>"""

        r = _v("define", "/dev/stdin", inp=xml)
        if r.returncode != 0:
            return {"error": f"Define fehlgeschlagen: {r.stderr.strip()}"}
        return {"success": True, "name": name}
    except Exception as e:
        return {"error": str(e)}


def vm_delete(name, delete_volumes=False):
    """Delete a VM, optionally removing its storage volumes."""
    try:
        _v("destroy", name)  # ignore errors (VM may already be off)
        # --snapshots-metadata: sonst schlägt undefine bei vorhandenen Snapshots fehl
        # --managed-save/--nvram: gespeicherten Zustand bzw. UEFI-nvram mit entfernen
        base = ["undefine", name, "--nvram", "--snapshots-metadata", "--managed-save"]
        r = _v(*(base + (["--remove-all-storage"] if delete_volumes else [])))
        if r.returncode != 0 and delete_volumes:
            # Storage-Removal kann an per-Pfad angehängten, nicht von libvirt
            # verwalteten Volumes scheitern → Domain trotzdem entfernen.
            r2 = _v(*base)
            if r2.returncode == 0:
                return {"success": True,
                        "warnings": ["Nicht von libvirt verwaltete Volumes blieben erhalten"]}
        if r.returncode != 0:
            return {"error": r.stderr.strip()}
        return {"success": True}
    except Exception as e:
        return {"error": str(e)}


def vm_update(name, vcpus=None, memory_mib=None, autostart=None, boot_order=None,
              cpu_sockets=None, cpu_cores=None, cpu_threads=None, cpu_mode=None,
              video_type=None, video_vram=None, add_sound=None, remove_sound=None,
              firmware=None, secure_boot=None, add_tpm=None, remove_tpm=None,
              boot_menu=None):
    """Update VM configuration. Returns {success, warnings} or {error}."""
    errors = []
    warnings = []
    try:
        # ── CPU topology via XML edit ────────────────────────────────────────
        needs_xml = any(x is not None for x in [cpu_sockets, cpu_cores, cpu_threads,
                                                  cpu_mode, video_type, video_vram,
                                                  add_sound, remove_sound, firmware,
                                                  boot_order, secure_boot, add_tpm,
                                                  remove_tpm, boot_menu])
        if needs_xml:
            r = _v("dumpxml", "--inactive", name)
            if r.returncode != 0:
                r = _v("dumpxml", name)  # fallback for transient domains
            if r.returncode != 0:
                return {"error": f"dumpxml fehlgeschlagen: {r.stderr.strip()}"}
            root = ET.fromstring(r.stdout)

            # CPU topology
            if cpu_sockets is not None or cpu_cores is not None or cpu_threads is not None:
                sockets = int(cpu_sockets or 1)
                cores   = int(cpu_cores or 1)
                threads = int(cpu_threads or 1)
                total   = sockets * cores * threads
                vcpu_el = root.find("vcpu")
                if vcpu_el is None:
                    vcpu_el = ET.SubElement(root, "vcpu")
                vcpu_el.text = str(total)
                vcpu_el.set("current", str(total))  # keep current == maximum
                cpu_el = root.find("cpu")
                if cpu_el is None:
                    cpu_el = ET.SubElement(root, "cpu")
                topo = cpu_el.find("topology")
                if topo is None:
                    topo = ET.SubElement(cpu_el, "topology")
                topo.set("sockets", str(sockets))
                topo.set("cores", str(cores))
                topo.set("threads", str(threads))

            # CPU mode
            if cpu_mode is not None:
                cpu_el = root.find("cpu")
                if cpu_el is None:
                    cpu_el = ET.SubElement(root, "cpu")
                cpu_el.set("mode", cpu_mode)
                # 'migratable' ist nur für host-passthrough/maximum gültig —
                # beim Wechsel auf host-model/custom entfernen, sonst scheitert define.
                if cpu_mode not in ("host-passthrough", "maximum"):
                    cpu_el.attrib.pop("migratable", None)

            # Video device
            if video_type is not None or video_vram is not None:
                vid = root.find(".//video/model")
                if vid is not None:
                    if video_type is not None:
                        vid.set("type", video_type)
                    if video_vram is not None:
                        vid.set("vram", str(video_vram))

            # Sound device — add
            if add_sound:
                devs = root.find("devices")
                if devs is None:
                    devs = ET.SubElement(root, "devices")
                snd = ET.SubElement(devs, "sound")
                snd.set("model", add_sound)

            # Sound device — remove (ElementTree kennt kein '..'/Parent-Achse,
            # daher direkt aus <devices> entfernen)
            if remove_sound:
                devs = root.find("devices")
                if devs is not None:
                    for snd in devs.findall("sound"):
                        devs.remove(snd)

            # Firmware (BIOS/UEFI) + Secure Boot
            if firmware is not None or secure_boot is not None:
                os_el = root.find("os")
                if os_el is None:
                    os_el = ET.SubElement(root, "os")
                feats = root.find("features")
                if feats is None:
                    feats = ET.SubElement(root, "features")

                # aktuellen Secure-Boot-Zustand ermitteln (für Teil-Updates)
                cur_sb = False
                _fw = os_el.find("firmware")
                if _fw is not None:
                    for _f in _fw.findall("feature"):
                        if _f.get("name") == "secure-boot" and _f.get("enabled") == "yes":
                            cur_sb = True
                _ldr = os_el.find("loader")
                if _ldr is not None and _ldr.get("secure") == "yes":
                    cur_sb = True

                want_uefi = (firmware == "uefi") if firmware is not None else True
                sb = bool(secure_boot) if secure_boot is not None else cur_sb

                # loader/nvram immer entfernen — libvirt-Auto-Firmware (efi) legt
                # den passenden (ggf. Secure-Boot-)Loader + nvram selbst an.
                for tag in ("loader", "nvram"):
                    el = os_el.find(tag)
                    if el is not None:
                        os_el.remove(el)
                fw_el = os_el.find("firmware")
                if fw_el is not None:
                    os_el.remove(fw_el)

                if want_uefi:
                    os_el.set("firmware", "efi")
                    fw_el = ET.SubElement(os_el, "firmware")
                    if sb:
                        for nm in ("enrolled-keys", "secure-boot"):
                            fe = ET.SubElement(fw_el, "feature")
                            fe.set("enabled", "yes"); fe.set("name", nm)
                        smm = feats.find("smm")
                        if smm is None:
                            smm = ET.SubElement(feats, "smm")
                        smm.set("state", "on")
                    else:
                        fe = ET.SubElement(fw_el, "feature")
                        fe.set("enabled", "no"); fe.set("name", "secure-boot")
                        smm = feats.find("smm")
                        if smm is not None:
                            feats.remove(smm)
                    if feats.find("acpi") is None:      # UEFI/SecureBoot setzt ACPI voraus
                        ET.SubElement(feats, "acpi")
                else:
                    os_el.attrib.pop("firmware", None)
                    smm = feats.find("smm")
                    if smm is not None:
                        feats.remove(smm)

            # TPM 2.0 (via swtpm-Emulator) — nötig für Windows 11 / Secure Boot
            if add_tpm:
                devs = root.find("devices")
                if devs is None:
                    devs = ET.SubElement(root, "devices")
                if devs.find("tpm") is None:
                    tpm = ET.SubElement(devs, "tpm")
                    tpm.set("model", "tpm-crb")
                    be = ET.SubElement(tpm, "backend")
                    be.set("type", "emulator")
                    be.set("version", "2.0" if add_tpm is True else str(add_tpm))
            if remove_tpm:
                devs = root.find("devices")
                if devs is not None:
                    for t in devs.findall("tpm"):
                        devs.remove(t)

            # Boot-Menü (F12-Auswahl beim Start)
            if boot_menu is not None:
                os_el = root.find("os")
                if os_el is None:
                    os_el = ET.SubElement(root, "os")
                bm = os_el.find("bootmenu")
                if boot_menu:
                    if bm is None:
                        bm = ET.SubElement(os_el, "bootmenu")
                    bm.set("enable", "yes"); bm.set("timeout", "3000")
                elif bm is not None:
                    os_el.remove(bm)

            # Boot order
            if boot_order is not None:
                os_el = root.find("os")
                if os_el is not None:
                    for b in os_el.findall("boot"):
                        os_el.remove(b)
                    for dev in boot_order:
                        b = ET.SubElement(os_el, "boot")
                        b.set("dev", dev)

            new_xml = ET.tostring(root, encoding="unicode")
            r = _v("define", "/dev/stdin", inp=new_xml)
            if r.returncode != 0:
                errors.append(f"XML define: {r.stderr.strip()}")

        # ── vCPUs ─────────────────────────────────────────────────────────────
        if vcpus is not None and cpu_sockets is None:
            # Eine feste <topology> würde setvcpus mit abweichender Zahl blockieren
            # ("CPU topology doesn't match the desired vcpu count"). Vorhandene
            # Topologie entfernen, damit die vCPU-Zahl frei einstellbar ist.
            rx = _v("dumpxml", "--inactive", name)
            if rx.returncode == 0:
                try:
                    rt = ET.fromstring(rx.stdout)
                    cpu_el = rt.find("cpu")
                    topo = cpu_el.find("topology") if cpu_el is not None else None
                    if topo is not None:
                        cpu_el.remove(topo)
                        vcpu_el = rt.find("vcpu")
                        if vcpu_el is not None:
                            vcpu_el.text = str(vcpus)
                            vcpu_el.attrib.pop("current", None)
                        _v("define", "/dev/stdin", inp=ET.tostring(rt, encoding="unicode"))
                except Exception:
                    pass
            r = _v("setvcpus", name, str(vcpus), "--config", "--maximum")
            if r.returncode != 0:
                errors.append(f"vCPU Maximum: {r.stderr.strip()}")
            else:
                r = _v("setvcpus", name, str(vcpus), "--config")
                if r.returncode != 0:
                    errors.append(f"vCPU: {r.stderr.strip()}")
                else:
                    # Try live (ignore error — VM may be offline)
                    rl = _v("setvcpus", name, str(vcpus), "--live")
                    if rl.returncode != 0:
                        warnings.append("vCPU-Änderung gilt erst nach Neustart")

        # ── Memory ────────────────────────────────────────────────────────────
        if memory_mib is not None:
            r = _v("setmaxmem", name, f"{memory_mib}M", "--config")
            if r.returncode != 0:
                errors.append(f"Max Memory: {r.stderr.strip()}")
            else:
                r = _v("setmem", name, f"{memory_mib}M", "--config")
                if r.returncode != 0:
                    errors.append(f"Memory: {r.stderr.strip()}")
                else:
                    rl = _v("setmem", name, f"{memory_mib}M", "--live")
                    if rl.returncode != 0:
                        warnings.append("Arbeitsspeicher-Änderung gilt erst nach Neustart")

        # ── Autostart ─────────────────────────────────────────────────────────
        if autostart is not None:
            if autostart:
                r = _v("autostart", name)
            else:
                r = _v("autostart", name, "--disable")
            if r.returncode != 0:
                errors.append(f"Autostart: {r.stderr.strip()}")

    except Exception as e:
        return {"error": str(e)}

    if errors:
        return {"success": False, "error": "\n".join(errors), "warnings": warnings}
    return {"success": True, "warnings": warnings}


def vm_snapshot_list(name):
    """List snapshots for a VM (Spaltenformat — NICHT --tree, das ist ein Baum
    und lässt sich nicht spaltenweise parsen)."""
    r = _v("snapshot-list", name)
    if r.returncode != 0:
        return {"error": r.stderr.strip()}
    snapshots = []
    for line in r.stdout.strip().split("\n"):
        s = line.strip()
        # Kopf-/Trennzeilen überspringen
        if not s or set(s) <= set("- ") or s.lower().startswith("name"):
            continue
        parts = line.split()
        if not parts:
            continue
        # Format: <Name> <Datum> <Zeit> <TZ> <State>  → alles zwischen Name und
        # letztem Token ist der Zeitstempel, letztes Token der Zustand.
        snapshots.append({
            "name": parts[0],
            "creation_time": " ".join(parts[1:-1]) if len(parts) >= 3 else "",
            "state": parts[-1] if len(parts) >= 3 else "",
        })
    return {"snapshots": snapshots}


def vm_snapshot_create(name, snap_name, description=""):
    """Create a VM snapshot."""
    args = ["snapshot-create-as", name, snap_name]
    if description:
        args += ["--description", description]
    args += ["--atomic"]
    r = _v(*args, timeout=120)
    if r.returncode != 0:
        return {"error": r.stderr.strip()}
    return {"success": True, "name": snap_name}


def vm_snapshot_delete(name, snap_name):
    """Delete a VM snapshot."""
    r = _v("snapshot-delete", name, snap_name)
    if r.returncode != 0:
        return {"error": r.stderr.strip()}
    return {"success": True}


def vm_snapshot_revert(name, snap_name):
    """Revert VM to a snapshot."""
    r = _v("snapshot-revert", name, snap_name, timeout=60)
    if r.returncode != 0:
        return {"error": r.stderr.strip()}
    return {"success": True}


def vm_clone(src, dst):
    """Clone a VM using virt-clone."""
    for base in [[], ["nsenter", "--target", "1", "--mount", "--"]]:
        try:
            cmd = base + ["virt-clone", "--original", src, "--name", dst, "--auto-clone"]
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
            if r.returncode == 0:
                return {"success": True, "name": dst}
            err = r.stderr.strip() or r.stdout.strip()
            if "not found" not in err.lower() and "no such" not in err.lower():
                return {"error": err}
        except FileNotFoundError:
            continue
        except Exception as ex:
            return {"error": str(ex)}
    return {"error": "virt-clone nicht verfügbar. Installieren: apt install virtinst"}


def _hotplug(name, base_args):
    """attach/detach mit passenden Flags: laufende VM → live+config (sofort),
    Fallback nur config (gilt nach Neustart, z.B. bei SATA/IDE ohne Hotplug);
    ausgeschaltete VM → nur config."""
    running = "running" in (_v("domstate", name).stdout or "").lower()
    if running:
        r = _v(*base_args, "--live", "--config")
        if r.returncode == 0:
            return {"success": True}
        r2 = _v(*base_args, "--config")
        if r2.returncode == 0:
            return {"success": True,
                    "warnings": ["Live-Änderung nicht möglich — gilt nach Neustart der VM"]}
        return {"error": (r2.stderr or r.stderr or "").strip() or "Fehlgeschlagen"}
    r = _v(*base_args, "--config")
    if r.returncode != 0:
        return {"error": r.stderr.strip()}
    return {"success": True}


def vm_disk_attach(name, source_path, target_dev, bus="virtio", fmt="qcow2",
                   readonly=False, device="disk"):
    """Attach a disk OR cdrom to a VM. device='cdrom' hängt eine ISO als echtes
    CD-ROM an (nur so erkennt z.B. Windows die virtio-Treiber-ISO)."""
    try:
        # Nur echte Image-Dateien erlauben — keine Host-Blockgeräte oder
        # System-Pfade (sonst Vollzugriff auf Host-Storage aus einer VM heraus).
        if not source_path or not os.path.isabs(source_path):
            return {"error": "source_path muss ein absoluter Pfad sein"}
        sp = os.path.normpath(source_path)   # kollabiert '..' für den Prefix-Check
        if sp.startswith(("/dev/", "/proc/", "/sys/", "/etc/", "/root/", "/boot/")):
            return {"error": "Pfad nicht erlaubt (Host-Gerät/Systempfad)"}
        # Existenz auf dem HOST prüfen (Bilder liegen im Host-Namespace).
        # Zwischen "Datei fehlt wirklich" (Verzeichnis erreichbar) und "Mount evtl.
        # down" (Verzeichnis nicht erreichbar, z.B. CIFS-Storagebox) unterscheiden.
        def _host_status(p):
            d = os.path.dirname(p)
            try:
                subprocess.run(_ns(["ls", d]), capture_output=True, timeout=8)  # Mount ggf. wecken
            except Exception:
                pass
            try:
                if subprocess.run(_ns(["test", "-f", p]), capture_output=True, timeout=8).returncode == 0:
                    return "exists"
            except Exception:
                return "unknown"
            try:
                dir_ok = subprocess.run(_ns(["test", "-d", d]), capture_output=True, timeout=8).returncode == 0
            except Exception:
                dir_ok = False
            if os.path.isfile(p):        # Fallback: direkt in den Container gemountet
                return "exists"
            return "missing" if dir_ok else "unknown"

        status = _host_status(sp)
        if status == "missing":
            return {"error": f"Datei nicht gefunden: {sp} — bitte einen aktuellen Pfad/ISO wählen"}
        if device == "cdrom":
            # CD-ROM: virtio-Bus kann kein CD-ROM → SATA erzwingen; immer readonly.
            cbus = bus if bus in ("sata", "ide", "scsi") else "sata"
            base = ["attach-disk", name, source_path, target_dev,
                    "--type", "cdrom", "--mode", "readonly", "--targetbus", cbus]
        else:
            base = ["attach-disk", name, source_path, target_dev,
                    "--driver", "qemu", "--subdriver", fmt, "--targetbus", bus]
            if readonly:
                base.append("--readonly")
        res = _hotplug(name, base)
        if res.get("success") and status == "unknown":
            res.setdefault("warnings", []).append(
                "Datei konnte nicht verifiziert werden (Netzwerk-Mount evtl. offline) — Pfad bitte prüfen")
        return res
    except Exception as e:
        return {"error": str(e)}


def vm_disk_detach(name, target_dev, delete_storage=False):
    """Detach a disk from a VM. Optional: zugehörige Image-Datei mitlöschen."""
    try:
        # Quellpfad vor dem Entfernen ermitteln (für optionales Löschen)
        src = ""
        if delete_storage:
            root, _ = _vm_root(name)
            if root is not None:
                for disk in root.findall(".//disk"):
                    t = disk.find("target")
                    if t is not None and t.get("dev") == target_dev:
                        s = disk.find("source")
                        if s is not None:
                            src = s.get("file") or s.get("dev") or ""
                        break
        res = _hotplug(name, ["detach-disk", name, target_dev])
        if res.get("success") and delete_storage and src and os.path.isabs(src) \
           and not os.path.normpath(src).startswith(("/dev/", "/proc/", "/sys/", "/etc/", "/boot/", "/root/")):
            dr = _v("vol-delete", src)               # akzeptiert auch einen Pfad
            if dr.returncode != 0:
                subprocess.run(_ns(["rm", "-f", src]), capture_output=True, timeout=15)
            res.setdefault("warnings", []).append("Speicherdatei gelöscht")
        return res
    except Exception as e:
        return {"error": str(e)}


def vm_nic_attach(name, network, model="virtio"):
    """Attach a network interface to a VM."""
    try:
        return _hotplug(name, ["attach-interface", name, "network", network,
                               "--model", model])
    except Exception as e:
        return {"error": str(e)}


def vm_nic_detach(name, mac):
    """Detach a network interface from a VM by MAC address."""
    try:
        return _hotplug(name, ["detach-interface", name, "network", "--mac", mac])
    except Exception as e:
        return {"error": str(e)}


def set_vm_vnc_keymap(name, keymap):
    """Set the VNC keymap attribute in VM XML. Takes effect after VM restart."""
    r = _v("dumpxml", "--inactive", name)
    if r.returncode != 0:
        r = _v("dumpxml", name)
        if r.returncode != 0:
            return {"error": f"dumpxml fehlgeschlagen: {r.stderr.strip()}"}
    try:
        root = ET.fromstring(r.stdout)
    except ET.ParseError as e:
        return {"error": f"XML Parse-Fehler: {e}"}
    changed = False
    for gfx in root.findall(".//graphics"):
        if gfx.get("type") == "vnc":
            gfx.set("keymap", keymap)
            changed = True
    if not changed:
        return {"error": "Keine VNC-Grafikkonsole gefunden"}
    new_xml = ET.tostring(root, encoding="unicode")
    r2 = _v("define", "/dev/stdin", inp=new_xml)
    if r2.returncode != 0:
        return {"error": f"virsh define fehlgeschlagen: {r2.stderr.strip()}"}
    return {"success": True, "keymap": keymap}


# ─── Generische Geräte-Verwaltung (virt-manager-artig) ──────────────────────

def _vm_root(name):
    """Inaktives Domain-XML als ElementTree-Root (mit Fallback auf laufend)."""
    r = _v("dumpxml", "--inactive", name)
    if r.returncode != 0:
        r = _v("dumpxml", name)
    if r.returncode != 0:
        return None, r.stderr.strip()
    try:
        return ET.fromstring(r.stdout), None
    except ET.ParseError as e:
        return None, f"XML Parse-Fehler: {e}"


def vm_get_xml(name):
    """Rohes Domain-XML (für den XML-Editor — jegliche Konfiguration)."""
    r = _v("dumpxml", "--inactive", name)
    if r.returncode != 0:
        r = _v("dumpxml", name)
    if r.returncode != 0:
        return {"error": r.stderr.strip()}
    return {"xml": r.stdout}


def vm_set_xml(name, xml):
    """Rohes Domain-XML übernehmen. <name> muss erhalten bleiben (kein Rename/Hijack)."""
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as e:
        return {"error": f"XML ungültig: {e}"}
    if root.tag != "domain":
        return {"error": "Wurzelelement muss <domain> sein"}
    nm = root.find("name")
    if nm is None or (nm.text or "").strip() != name:
        return {"error": f"<name> muss '{name}' bleiben"}
    r = _v("define", "/dev/stdin", inp=xml)
    if r.returncode != 0:
        return {"error": r.stderr.strip()}
    return {"success": True}


def list_host_devices():
    """Host-USB- und -PCI-Geräte für Passthrough (via lsusb/lspci auf dem Host)."""
    usb, pci = [], []
    try:
        r = subprocess.run(_ns(["lsusb"]), capture_output=True, text=True, timeout=8)
        for line in r.stdout.splitlines():
            m = re.match(r"Bus (\d+) Device (\d+): ID ([0-9a-fA-F]{4}):([0-9a-fA-F]{4})\s*(.*)", line)
            if not m:
                continue
            vid, pid, desc = m.group(3), m.group(4), (m.group(5) or "").strip()
            # Root-Hubs/leere Beschreibungen überspringen
            if "root hub" in desc.lower():
                continue
            usb.append({"vendor": vid, "product": pid,
                        "label": f"{desc or 'USB-Gerät'} ({vid}:{pid})"})
    except Exception:
        pass
    try:
        r = subprocess.run(_ns(["lspci", "-D"]), capture_output=True, text=True, timeout=8)
        for line in r.stdout.splitlines():
            m = re.match(r"(\S+)\s+(.*)", line)
            if not m:
                continue
            addr, desc = m.group(1), m.group(2).strip()
            pci.append({"address": addr, "label": f"{desc} [{addr}]"})
    except Exception:
        pass
    return {"usb": usb, "pci": pci}


def _build_device_xml(kind, p):
    """Baut das <devices>-Kindelement für einen Gerätetyp. p = Parameter-Dict."""
    p = p or {}
    esc = _xml_attr
    if kind == "rng":
        return "<rng model='virtio'><backend model='random'>/dev/urandom</backend></rng>"
    if kind == "watchdog":
        model = p.get("model", "i6300esb")
        action = p.get("action", "reset")
        if not re.match(r'^[a-z0-9-]+$', model) or not re.match(r'^[a-z-]+$', action):
            return {"error": "Ungültiges Watchdog-Modell/-Aktion"}
        return f"<watchdog model='{model}' action='{action}'/>"
    if kind == "tablet":
        return "<input type='tablet' bus='usb'/>"
    if kind == "keyboard":
        return "<input type='keyboard' bus='virtio'/>"
    if kind == "usb_controller":
        return "<controller type='usb' model='qemu-xhci'/>"
    if kind == "channel_agent":
        return ("<channel type='unix'><target type='virtio' "
                "name='org.qemu.guest_agent.0'/></channel>")
    if kind == "channel_spice":
        return ("<channel type='spicevmc'><target type='virtio' "
                "name='com.redhat.spice.0'/></channel>")
    if kind == "redirdev":
        return "<redirdev bus='usb' type='spicevmc'/>"
    if kind == "smartcard":
        return "<smartcard mode='passthrough' type='spicevmc'/>"
    if kind == "vsock":
        return "<vsock model='virtio'><cid auto='yes'/></vsock>"
    if kind == "panic":
        return "<panic model='isa'/>"
    if kind == "serial":
        return "<serial type='pty'><target port='0'/></serial>"
    if kind == "sound":
        model = p.get("model", "ich9")
        if not re.match(r'^[a-z0-9]+$', model):
            return {"error": "Ungültiges Sound-Modell"}
        return f"<sound model='{model}'/>"
    if kind == "usb_host":
        vid = (p.get("vendor") or "").lower().replace("0x", "")
        pid = (p.get("product") or "").lower().replace("0x", "")
        if not re.match(r'^[0-9a-f]{4}$', vid) or not re.match(r'^[0-9a-f]{4}$', pid):
            return {"error": "vendor/product müssen 4-stellige Hex sein"}
        return (f"<hostdev mode='subsystem' type='usb' managed='yes'><source>"
                f"<vendor id='0x{vid}'/><product id='0x{pid}'/></source></hostdev>")
    if kind == "pci_host":
        a = (p.get("address") or "").strip()
        m = re.match(r'^(?:([0-9a-fA-F]{4}):)?([0-9a-fA-F]{2}):([0-9a-fA-F]{2})\.([0-7])$', a)
        if not m:
            return {"error": "PCI-Adresse muss Form [dddd:]bb:ss.f haben"}
        dom = m.group(1) or "0000"
        return (f"<hostdev mode='subsystem' type='pci' managed='yes'><source>"
                f"<address domain='0x{dom}' bus='0x{m.group(2)}' "
                f"slot='0x{m.group(3)}' function='0x{m.group(4)}'/></source></hostdev>")
    if kind == "filesystem":
        src = p.get("source", "")
        tag = p.get("target", "")
        if not src or not os.path.isabs(src):
            return {"error": "Quellpfad muss absolut sein"}
        if not re.match(r'^[A-Za-z0-9_.-]{1,36}$', tag):
            return {"error": "Ungültiger Mount-Tag (nur A-Z a-z 0-9 . _ -)"}
        return (f"<filesystem type='mount' accessmode='passthrough'>"
                f"<driver type='virtiofs'/><source dir={esc(src)}/>"
                f"<target dir={esc(tag)}/></filesystem>")
    if kind == "disk":
        src = p.get("source", "")
        tgt = p.get("target", "vdb")
        bus = p.get("bus", "virtio")
        fmt = p.get("format", "qcow2")
        dev = p.get("device", "disk")
        if not src or not os.path.isabs(src):
            return {"error": "Datenträger-Pfad muss absolut sein"}
        if not re.match(r'^[a-z]{1,4}[a-z0-9]*$', tgt) or bus not in ("virtio","sata","scsi","ide","usb") \
           or fmt not in ("qcow2","raw") or dev not in ("disk","cdrom"):
            return {"error": "Ungültige Datenträger-Parameter"}
        ro = "<readonly/>" if p.get("readonly") else ""
        return (f"<disk type='file' device='{dev}'>"
                f"<driver name='qemu' type='{fmt}'/><source file={esc(src)}/>"
                f"<target dev='{tgt}' bus='{bus}'/>{ro}</disk>")
    if kind == "interface":
        net = p.get("network", "default")
        model = p.get("model", "virtio")
        if not re.match(r'^[A-Za-z0-9_.-]{1,64}$', net) or not re.match(r'^[a-z0-9-]+$', model):
            return {"error": "Ungültige Netzwerk-Parameter"}
        return (f"<interface type='network'><source network='{net}'/>"
                f"<model type='{model}'/></interface>")
    return {"error": f"Unbekannter Gerätetyp: {kind}"}


def vm_ensure_absolute_pointer(name):
    """Sorgt dafür, dass die VM ein absolutes Zeigegerät (USB-Tablet) hat.

    Nur mit PS/2-Maus (relativ) rechnet QEMU die absoluten Koordinaten der
    Konsole in Bewegungs-Deltas um; Gast-Beschleunigung/-Geschwindigkeit
    lassen den Gast-Zeiger dann vom Fadenkreuz/Mauszeiger der Konsole weg-
    driften. gtk-vnc (KasmVNC-Pipeline) sendet im Relativ-Modus sogar erst nach
    einem Klick-Grab überhaupt Bewegungen. Ein USB-Tablet ist per USB-Hotplug
    live anhängbar (Windows/Linux treiberlos), wie es virt-manager standardmäßig
    tut. Rückgabe: {"attached": bool, "warnings": [...]} oder {"error": str}.
    """
    r = _v("dumpxml", name)
    if r.returncode != 0:
        return {"error": (r.stderr or "").strip() or "dumpxml fehlgeschlagen"}
    try:
        root = ET.fromstring(r.stdout)
    except ET.ParseError as e:
        return {"error": f"XML Parse-Fehler: {e}"}
    if root.find("./devices/input[@type='tablet']") is not None:
        return {"attached": False}
    xml = "<input type='tablet' bus='usb'/>"
    running = "running" in (_v("domstate", name).stdout or "").lower()
    if running:
        # persistente VM: live + config; transiente VM (kein --config möglich): nur live
        r = _v("attach-device", name, "/dev/stdin", "--live", "--config", inp=xml)
        if r.returncode != 0:
            r = _v("attach-device", name, "/dev/stdin", "--live", inp=xml)
        if r.returncode != 0:
            return {"error": (r.stderr or "").strip() or "attach-device fehlgeschlagen"}
        return {"attached": True}
    r = _v("attach-device", name, "/dev/stdin", "--config", inp=xml)
    if r.returncode != 0:
        return {"error": (r.stderr or "").strip() or "attach-device fehlgeschlagen"}
    return {"attached": True, "warnings": ["gilt ab dem nächsten Start der VM"]}


def vm_add_device(name, kind, params=None):
    """Fügt ein Gerät zum persistenten Domain-XML hinzu (gilt nach Neustart)."""
    dev = _build_device_xml(kind, params)
    if isinstance(dev, dict):        # Fehler aus dem Builder
        return dev
    root, err = _vm_root(name)
    if root is None:
        return {"error": err}
    devs = root.find("devices")
    if devs is None:
        devs = ET.SubElement(root, "devices")
    try:
        devs.append(ET.fromstring(dev))
    except ET.ParseError as e:
        return {"error": f"Geräte-XML fehlerhaft: {e}"}
    # virtiofs braucht geteilten Speicher (memfd/shared), sonst startet die VM nicht
    if kind == "filesystem":
        mb = root.find("memoryBacking")
        if mb is None:
            mb = ET.SubElement(root, "memoryBacking")
        if mb.find("source") is None:
            ET.SubElement(mb, "source").set("type", "memfd")
        if mb.find("access") is None:
            ET.SubElement(mb, "access").set("mode", "shared")
    r = _v("define", "/dev/stdin", inp=ET.tostring(root, encoding="unicode"))
    if r.returncode != 0:
        return {"error": r.stderr.strip()}
    return {"success": True}


def _device_label(el):
    t = el.tag
    def sub(tag, attr, d=""):
        e = el.find(tag); return e.get(attr, d) if e is not None else d
    if t == "disk":
        src = el.find("source")
        s = (src.get("file") or src.get("dev") or src.get("volume") or "") if src is not None else ""
        return f"Datenträger {sub('target','dev','?')} · {(s.split('/')[-1] or el.get('device','disk'))}"
    if t == "interface":
        return f"NIC {sub('source','network') or sub('source','bridge','')} · {sub('mac','address','')}"
    if t == "hostdev":
        return f"Passthrough ({el.get('type','').upper()})"
    if t == "controller":
        return f"Controller {el.get('type','')} {el.get('model','')}".strip()
    if t == "channel":
        return f"Channel {sub('target','name') or el.get('type','')}"
    if t == "input":
        return f"Eingabe {el.get('type','')} ({el.get('bus','')})"
    if t == "graphics":
        return f"Grafik {el.get('type','')}"
    if t == "sound":
        return f"Sound {el.get('model','')}"
    if t == "video":
        m = el.find("model"); return f"Video {m.get('type','') if m is not None else ''}"
    if t == "filesystem":
        return f"Shared FS {sub('source','dir')} → {sub('target','dir')}"
    if t == "rng":       return "RNG (virtio)"
    if t == "watchdog":  return f"Watchdog {el.get('model','')}"
    if t == "tpm":       return f"TPM {sub('backend','version','')}"
    if t == "redirdev":  return "USB-Redirection"
    if t == "smartcard": return "Smartcard"
    if t == "vsock":     return "VSOCK"
    if t == "panic":     return "Panic-Notifier"
    if t == "serial":    return "Serielle Konsole"
    if t == "console":   return "Konsole"
    if t == "memballoon":return "Memory-Balloon"
    return t


def vm_device_list(name):
    """Alle Geräte im <devices>-Block mit stabilem Index (für Anzeige/Entfernen)."""
    root, err = _vm_root(name)
    if root is None:
        return {"error": err}
    devs = root.find("devices")
    out = []
    if devs is not None:
        for i, el in enumerate(list(devs)):
            if not isinstance(el.tag, str):
                continue   # Kommentare o.ä. überspringen
            out.append({"index": i, "kind": el.tag, "label": _device_label(el)})
    return {"devices": out}


def vm_remove_device(name, index):
    """Entfernt das Gerät am gegebenen <devices>-Index aus dem persistenten XML."""
    root, err = _vm_root(name)
    if root is None:
        return {"error": err}
    devs = root.find("devices")
    if devs is None:
        return {"error": "Keine Geräte vorhanden"}
    children = [c for c in list(devs) if isinstance(c.tag, str)]
    try:
        idx = int(index)
    except (ValueError, TypeError):
        return {"error": "Ungültiger Index"}
    if idx < 0 or idx >= len(children):
        return {"error": "Gerät nicht gefunden"}
    devs.remove(children[idx])
    r = _v("define", "/dev/stdin", inp=ET.tostring(root, encoding="unicode"))
    if r.returncode != 0:
        return {"error": r.stderr.strip()}
    return {"success": True}


def vm_set_graphics(name, vnc=None, spice=None):
    """VNC-/SPICE-Grafikkonsole der VM hinzufügen oder entfernen (jeweils bool/None)."""
    root, err = _vm_root(name)
    if root is None:
        return {"error": err}
    devs = root.find("devices")
    if devs is None:
        devs = ET.SubElement(root, "devices")
    warnings = []

    def _has(t):
        return any(g.get("type") == t for g in devs.findall("graphics"))

    def _remove(t):
        for g in devs.findall("graphics"):
            if g.get("type") == t:
                devs.remove(g)

    if vnc is not None:
        if vnc and not _has("vnc"):
            g = ET.SubElement(devs, "graphics")
            g.set("type", "vnc"); g.set("port", "-1")
            g.set("autoport", "yes"); g.set("listen", "127.0.0.1")
        elif not vnc:
            _remove("vnc")

    if spice is not None:
        if spice and not _has("spice"):
            g = ET.SubElement(devs, "graphics")
            g.set("type", "spice"); g.set("autoport", "yes")
            g.set("listen", "127.0.0.1")
            # SPICE-Agent-Kanal für Clipboard/Auto-Resize ergänzen, falls fehlt
            has_ch = any(
                (c.find("target") is not None and
                 c.find("target").get("name") == "com.redhat.spice.0")
                for c in devs.findall("channel"))
            if not has_ch:
                ch = ET.SubElement(devs, "channel"); ch.set("type", "spicevmc")
                tg = ET.SubElement(ch, "target")
                tg.set("type", "virtio"); tg.set("name", "com.redhat.spice.0")
        elif not spice:
            _remove("spice")

    if not devs.findall("graphics"):
        warnings.append("VM hat jetzt keine Grafikkonsole mehr (nur serielle Konsole)")
    r = _v("define", "/dev/stdin", inp=ET.tostring(root, encoding="unicode"))
    if r.returncode != 0:
        return {"error": r.stderr.strip()}
    return {"success": True, "warnings": warnings}


