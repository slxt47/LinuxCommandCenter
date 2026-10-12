"""Netzisolation für per Gast-Link freigegebene VMs.

Wer einen Gast-Link bekommt, bedient eine VM, die im selben Host wie das
Dashboard läuft. Ohne Filter erreicht sie von innen alles, was der Host in
den libvirt-/Docker-Netzen anbietet — u. a. das Dashboard selbst auf
192.168.122.1:8420. Deshalb bekommt jede Netzwerkkarte der VM für die Dauer
der Freigabe den libvirt-nwfilter `dashboard-share-isolate` (Vorbild:
`demo-qbs-isolate` aus Demo-QBS):

  erlaubt   DHCP, ARP, DNS (Port 53, damit der libvirt-Resolver am Gateway
            weiter funktioniert), Internet
  verworfen beide öffentlichen Host-Adressen, 10/8, 172.16/12, 192.168/16
            (also auch das eigene Gateway außer DNS), Tailscale 100.64/10,
            Link-local, ausgehendes SMTP (TCP/25 — der NAT-Ausgang läuft über
            die Mail-IP), IPv6 komplett

Alle Regeln liegen bewusst auf der `ip`-Ebene (ebtables): libvirt setzt
`tcp`/`udp`-Regeln in iptables um, `ip`-Regeln in ebtables — gemischt würde
die Prioritätsreihenfolge nicht mehr gelten, weil ebtables immer zuerst
läuft. Eingehend wird nichts verworfen (stateless, Antworten müssen durch).

KEINE filterrefs auf allow-dhcp/allow-arp — das ist die Falle, in die
demo-qbs-isolate getappt ist: libvirt legt für jeden Filter mit
chain='ipv4' eine Unterkette (I-vnetX-ipv4) an, auf die die Wurzelkette
alle IPv4-Frames umleitet. ebtables-nft (Ubuntu 22.04, libvirt 8.0) schließt
diese Unterkette mit einem impliziten `accept` ab. Folge: jeder IPv4-Frame
wird dort angenommen, die Sperrregeln in der Wurzelkette laufen nie
(nachgewiesen am 19.09.2026 mit Zähler 0 bei laufendem Verkehr). DHCP
braucht keine Ausnahme (255.255.255.255 liegt in keinem gesperrten Bereich),
ARP fällt auf die ACCEPT-Policy der Wurzelkette.

Der Filter wird beim Anlegen der ersten Freigabe gesetzt (`--live --config`,
d. h. sofort und über einen VM-Neustart hinaus) und beim Ende der letzten
Freigabe wieder entfernt bzw. auf den vorherigen Filter zurückgesetzt.
Lässt sich der Filter nicht setzen, wird die Freigabe verweigert.
"""

import os
import re
import subprocess
import tempfile
import xml.etree.ElementTree as ET

from dashboard.base import _ns

FILTER_NAME = os.environ.get("DASH_SHARE_NWFILTER", "dashboard-share-isolate")


def _detect_host_ips():
    """Globale IPv4-Adressen des Hosts (network_mode host -> sichtbar im Container).
    Ueberschreibbar mit DASH_HOST_PUBLIC_IPS (Komma-getrennt)."""
    env = os.environ.get("DASH_HOST_PUBLIC_IPS", "").strip()
    if env:
        return [ip.strip() for ip in env.split(",") if ip.strip()]
    import ipaddress
    try:
        out = subprocess.run(["ip", "-4", "-o", "addr", "show", "scope", "global"],
                             capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return []
    ips = []
    for m in re.finditer(r"inet (\d+\.\d+\.\d+\.\d+)/", out):
        try:
            if ipaddress.ip_address(m.group(1)).is_global and m.group(1) not in ips:
                ips.append(m.group(1))
        except ValueError:
            pass
    return ips


HOST_PUBLIC_IPS = _detect_host_ips()
# Interface-Typen, auf die libvirt keinen nwfilter anwenden kann
_UNFILTERABLE = ("user", "hostdev", "vhostuser", "vdpa")


def _filter_xml(uuid=""):
    rules = ([f"  <uuid>{uuid}</uuid>"] if uuid else []) + [
        # Keine filterrefs (allow-dhcp/allow-arp) — siehe Modul-Docstring.
        # DNS zuerst (Priorität 100), sonst würde das Gateway durch die 192.168/16-Sperre fallen
        "  <rule action='accept' direction='out' priority='100'><ip protocol='udp' dstportstart='53'/></rule>",
        "  <rule action='accept' direction='out' priority='100'><ip protocol='tcp' dstportstart='53'/></rule>",
        # kein direkter Mailversand aus der VM — der NAT-Ausgang trägt die Adresse von MTA 1
        "  <rule action='drop' direction='out' priority='150'><ip protocol='tcp' dstportstart='25'/></rule>",
    ]
    for ip in HOST_PUBLIC_IPS:
        rules.append(f"  <rule action='drop' direction='out' priority='200'><ip dstipaddr='{ip}' dstipmask='32'/></rule>")
    for net, mask in (("10.0.0.0", "8"), ("172.16.0.0", "12"), ("192.168.0.0", "16"),
                      ("100.64.0.0", "10"), ("169.254.0.0", "16")):
        rules.append(f"  <rule action='drop' direction='out' priority='200'><ip dstipaddr='{net}' dstipmask='{mask}'/></rule>")
    rules.append("  <rule action='drop' direction='out' priority='210'><ipv6/></rule>")
    return f"<filter name='{FILTER_NAME}' chain='root'>\n" + "\n".join(rules) + "\n</filter>\n"


def _virsh(*args, timeout=30):
    """virsh direkt (Socket ist in den Container gemountet), sonst per nsenter."""
    last = None
    for cmd in (["virsh"] + list(args), _ns(["virsh"] + list(args))):
        try:
            return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        except FileNotFoundError:
            continue
        except subprocess.TimeoutExpired:
            last = "virsh: Zeitüberschreitung"
        except Exception as ex:
            last = str(ex)
    class _R:
        returncode = -1; stdout = ""; stderr = last or "virsh nicht verfügbar"
    return _R()


def ensure_filter():
    """nwfilter anlegen, falls er auf dem Host fehlt; eine alte Fassung mit
    filterrefs (wirkungslos, siehe Docstring) wird unter derselben UUID
    ersetzt. Liefert Fehlertext oder ''."""
    uuid = ""
    r = _virsh("nwfilter-dumpxml", FILTER_NAME)
    if r.returncode == 0:
        if "<filterref" not in r.stdout:
            return ""
        m = re.search(r"<uuid>([0-9a-f-]+)</uuid>", r.stdout)
        uuid = m.group(1) if m else ""
    fd, path = tempfile.mkstemp(prefix="nwfilter-", suffix=".xml")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(_filter_xml(uuid))
        r = _virsh("nwfilter-define", path)
        if r.returncode != 0:
            return (r.stderr or r.stdout).strip() or "nwfilter-define fehlgeschlagen"
        print(f"[vmisolate] nwfilter {FILTER_NAME} {'ersetzt' if uuid else 'angelegt'}", flush=True)
        return ""
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def _domain_state(vm):
    """(running, persistent) oder None, wenn die VM nicht existiert."""
    r = _virsh("dominfo", vm)
    if r.returncode != 0:
        return None
    running = persistent = False
    for line in r.stdout.splitlines():
        k, _, v = line.partition(":")
        k, v = k.strip().lower(), v.strip().lower()
        if k == "state":
            running = v.startswith(("running", "paused", "läuft", "pausiert"))
        elif k == "persistent":
            persistent = v in ("yes", "ja")
    return running, persistent


def _interfaces(vm):
    r = _virsh("dumpxml", vm)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout).strip() or "dumpxml fehlgeschlagen")
    root = ET.fromstring(r.stdout)
    return [el for el in root.iter("interface")]


def _update_device(vm, el, running, persistent):
    fd, path = tempfile.mkstemp(prefix="iface-", suffix=".xml")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(ET.tostring(el))
        flags = []
        if running:
            flags.append("--live")
        if persistent:
            flags.append("--config")
        if not flags:
            flags.append("--current")
        r = _virsh("update-device", vm, path, *flags, timeout=60)
        if r.returncode != 0:
            raise RuntimeError((r.stderr or r.stdout).strip() or "update-device fehlgeschlagen")
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def _mac(el):
    m = el.find("mac")
    return (m.get("address") or "").lower() if m is not None else ""


def apply(vm):
    """Filter auf alle Netzwerkkarten der VM setzen.

    Liefert {"success": True, "orig": {mac: vorheriger Filtername oder ""}}
    oder {"error": "..."}. Das `orig`-Dict gehört in den Freigabe-Datensatz,
    damit restore() den Ausgangszustand wiederherstellen kann.
    """
    err = ensure_filter()
    if err:
        return {"error": f"nwfilter {FILTER_NAME} konnte nicht angelegt werden: {err}"}
    st = _domain_state(vm)
    if st is None:
        return {"error": "VM nicht gefunden"}
    running, persistent = st
    try:
        ifaces = _interfaces(vm)
    except RuntimeError as e:
        return {"error": str(e)}
    if not ifaces:
        return {"success": True, "orig": {}}     # keine Netzwerkkarte — nichts zu isolieren
    for el in ifaces:
        if el.get("type") in _UNFILTERABLE:
            return {"error": f"Netzwerkkarte vom Typ '{el.get('type')}' kann nicht gefiltert werden "
                             f"— Freigabe verweigert"}
    orig = {}
    done = []
    try:
        for el in ifaces:
            mac = _mac(el)
            fr = el.find("filterref")
            orig[mac] = (fr.get("filter") or "") if fr is not None else ""
            if orig[mac] == FILTER_NAME:
                continue
            if fr is not None:
                el.remove(fr)
            ET.SubElement(el, "filterref", {"filter": FILTER_NAME})
            _update_device(vm, el, running, persistent)
            done.append(el)
    except RuntimeError as e:
        # Teilweise gesetzte Filter wieder zurücknehmen, sonst bleibt ein halber Zustand
        for el in done:
            try:
                _set_filter(vm, el, orig.get(_mac(el), ""), running, persistent)
            except Exception:
                pass
        return {"error": f"Netzisolation konnte nicht gesetzt werden: {e}"}
    print(f"[vmisolate] {vm}: nwfilter {FILTER_NAME} auf {len(ifaces)} Karte(n) gesetzt "
          f"({'live+config' if running and persistent else 'live' if running else 'config'})", flush=True)
    return {"success": True, "orig": orig}


def _set_filter(vm, el, name, running, persistent):
    fr = el.find("filterref")
    if fr is not None:
        el.remove(fr)
    if name:
        ET.SubElement(el, "filterref", {"filter": name})
    _update_device(vm, el, running, persistent)


def restore(vm, orig):
    """Filter wieder entfernen bzw. auf den in `orig` gemerkten Zustand zurücksetzen."""
    st = _domain_state(vm)
    if st is None:
        return {"error": "VM nicht gefunden"}      # z. B. gelöscht — nichts mehr zu tun
    running, persistent = st
    try:
        ifaces = _interfaces(vm)
    except RuntimeError as e:
        return {"error": str(e)}
    orig = orig or {}
    errors = []
    n = 0
    for el in ifaces:
        fr = el.find("filterref")
        if fr is None or fr.get("filter") != FILTER_NAME:
            continue                                # nicht von uns gesetzt — nicht anfassen
        try:
            _set_filter(vm, el, orig.get(_mac(el), ""), running, persistent)
            n += 1
        except RuntimeError as e:
            errors.append(str(e))
    if errors:
        return {"error": "; ".join(errors)}
    if n:
        print(f"[vmisolate] {vm}: nwfilter {FILTER_NAME} von {n} Karte(n) entfernt", flush=True)
    return {"success": True}


def status(vm):
    """Für die Anzeige: True, wenn mindestens eine Karte den Freigabe-Filter trägt."""
    try:
        return any((el.find("filterref") is not None and el.find("filterref").get("filter") == FILTER_NAME)
                   for el in _interfaces(vm))
    except Exception:
        return False
