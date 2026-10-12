#!/usr/bin/env python3
"""Hilfsfunktionen des Schutz-Pakets (Linux Dashboard).

    schutz.py netze                       Netze ermitteln -> schutz-netze.generiert
    schutz.py render <vorlage> <ziel>     @@PLATZHALTER@@ ersetzen
    schutz.py conf-merge <beispiel> <ziel> fehlende Schluessel anhaengen
    schutz.py get <KEY>                   effektiven Wert ausgeben
    schutz.py altbestand                  Werte aus einer manuell eingerichteten
                                          Vorversion ermitteln (KEY="wert")
"""
import ipaddress
import json
import os
import re
import subprocess
import sys
import time

ETC = '/etc/linux-dashboard'
CONF = f'{ETC}/schutz.conf'
NETZE = f'{ETC}/schutz-netze.generiert'

CLOUDFLARE_NETZE = (
    '173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 '
    '108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 '
    '162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22 '
    '2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32 '
    '2a06:98c0::/29 2c0f:f248::/32').split()

DEFAULTS = {
    'WAN_IF': 'auto', 'SERVER_NETZE': 'auto',
    'INTERNE_NETZE': '10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 fd7a:115c:a1e0::/48',
    'TRUSTED_IPS': '', 'RUHIGE_INTERFACES': 'lo tailscale0 docker0 br-+ virbr+',
    'FIREWALL': 'eigen', 'SSH_BANTIME': '1w', 'DAUERSPERRE_TAGE': '90',
    'F2B_DBPURGEAGE': '90d', 'IDS_AKTIV': '1', 'IDS_THREADS': 'auto',
    'IDS_CPU_QUOTA': '400%', 'IDS_MEMORY_MAX': '8G', 'IDS_WHITELIST_EXTRA': '',
    'CLOUDFLARE': '0', 'DASHBOARD_JAIL': 'true',
}

_KV = re.compile(r'^\s*([A-Z_][A-Z0-9_]*)=(.*?)\s*$')


def lies_conf(pfad):
    werte = {}
    try:
        for line in open(pfad, encoding='utf-8'):
            if line.lstrip().startswith('#'):
                continue
            m = _KV.match(line)
            if m:
                v = m.group(2)
                if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'':
                    v = v[1:-1]
                werte[m.group(1)] = v
    except OSError:
        pass
    return werte


def conf():
    c = dict(DEFAULTS)
    c.update(lies_conf(CONF))
    return c


def sh(*cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return ''


def wan_if(c):
    w = c.get('WAN_IF', 'auto')
    if w and w != 'auto':
        return w
    for line in sh('ip', '-o', 'route', 'show', 'default').splitlines():
        f = line.split()
        if 'dev' in f:
            return f[f.index('dev') + 1]
    for line in sh('ip', '-o', '-6', 'route', 'show', 'default').splitlines():
        f = line.split()
        if 'dev' in f:
            return f[f.index('dev') + 1]
    return ''


def server_netze(c, wan):
    s = c.get('SERVER_NETZE', 'auto')
    if s and s != 'auto':
        return s.split()
    out = []
    try:
        daten = json.loads(sh('ip', '-j', 'addr', 'show', 'dev', wan) or '[]')
    except ValueError:
        daten = []
    for dev in daten:
        for a in dev.get('addr_info', []):
            if a.get('scope') != 'global':
                continue
            ip = ipaddress.ip_address(a['local'])
            n = (ipaddress.ip_network(f'{ip}/64', strict=False) if ip.version == 6
                 else ipaddress.ip_network(f'{ip}/32'))
            if str(n) not in out:
                out.append(str(n))
    return out


def resolver():
    out = []
    for pfad in ('/run/systemd/resolve/resolv.conf', '/etc/resolv.conf'):
        try:
            for line in open(pfad):
                f = line.split()
                if len(f) >= 2 and f[0] == 'nameserver':
                    try:
                        ip = ipaddress.ip_address(f[1].split('%')[0])
                    except ValueError:
                        continue
                    if not ip.is_loopback and str(ip) not in out:
                        out.append(str(ip))
        except OSError:
            pass
        if out:
            break
    return out


def gueltig(liste):
    ok = []
    for n in liste:
        try:
            ok.append(str(ipaddress.ip_network(n, strict=False)))
        except ValueError:
            print(f'WARNUNG: ungueltiger Netz-/IP-Eintrag ignoriert: {n!r}', file=sys.stderr)
    return ok


def berechnen():
    c = conf()
    wan = wan_if(c)
    server = gueltig(server_netze(c, wan))
    intern = gueltig(c['INTERNE_NETZE'].split())
    trusted = gueltig(c['TRUSTED_IPS'].split())
    extra = gueltig(c['IDS_WHITELIST_EXTRA'].split())
    cf = c.get('CLOUDFLARE', '0') == '1'
    ignore = ['127.0.0.0/8', '::1'] + server + intern + trusted
    ids_ignore = ignore + extra + (CLOUDFLARE_NETZE if cf else [])
    home = server + intern
    v4_praefixe = []
    for n in server:
        net = ipaddress.ip_network(n)
        if net.version == 4:
            p = '.'.join(str(net.network_address).split('.')[:3]) + '.'
            p = re.escape(p)
            if p not in v4_praefixe:
                v4_praefixe.append(p)
    threads = c.get('IDS_THREADS', 'auto')
    if not threads.isdigit():
        threads = str(max(1, min(4, (os.cpu_count() or 2) // 2)))
    return {
        'WAN_IF': wan,
        'SERVER_NETZE': ' '.join(server),
        'HOME_NETZE': ' '.join(home),
        'IGNOREIP': ' '.join(ignore),
        'IDS_IGNOREIP': ' '.join(ids_ignore),
        'NIE_SPERREN': ' '.join(trusted + resolver() + extra),
        'SURICATA_HOME_NET': '[' + ','.join(home) + ']',
        'EIGENE_V4_PRAEFIXE': '(?:' + '|'.join(v4_praefixe) + ')' if v4_praefixe else '(?!)',
        'IDS_THREADS': threads,
        'CLOUDFLARE': '1' if cf else '0',
        'FIREWALL': c.get('FIREWALL', 'eigen'),
        'IDS_AKTIV': c.get('IDS_AKTIV', '1'),
    }


def cmd_netze():
    n = berechnen()
    if not n['WAN_IF']:
        print('FEHLER: kein Internet-Interface gefunden - WAN_IF in schutz.conf setzen',
              file=sys.stderr)
        sys.exit(1)
    os.makedirs(ETC, exist_ok=True)
    tmp = NETZE + '.tmp'
    with open(tmp, 'w') as fh:
        fh.write('# ERZEUGT von "waechter config-anwenden" aus schutz.conf - nicht von Hand aendern.\n'
                 f'# Stand: {time.strftime("%Y-%m-%d %H:%M:%S")}\n')
        for k, v in n.items():
            fh.write(f'{k}="{v}"\n')
    os.replace(tmp, NETZE)
    for k in ('WAN_IF', 'SERVER_NETZE', 'NIE_SPERREN'):
        print(f'  {k:13s} {n[k] or "-"}')


def cmd_render(src, dst):
    c = conf()
    n = berechnen()
    werte = dict(c)
    werte.update(n)
    werte['DAUERSPERRE_FINDTIME'] = re.sub(r'\D', '', c['DAUERSPERRE_TAGE']) + 'd'
    werte['IDS_ENABLED'] = 'true' if c.get('IDS_AKTIV') == '1' else 'false'
    werte['DASHBOARD_JAIL'] = 'true' if c.get('DASHBOARD_JAIL', 'true') in ('1', 'true') else 'false'
    cf = n['CLOUDFLARE'] == '1'
    out = []
    for line in open(src, encoding='utf-8'):
        if line.strip() == '@@CF_BLOCK@@':
            if cf:
                out.append(line.replace('@@CF_BLOCK@@', 'cf-block'))
            continue
        out.append(line)
    text = ''.join(out)

    def ersetze(m):
        k = m.group(1)
        if k not in werte:
            raise SystemExit(f'FEHLER: unbekannter Platzhalter @@{k}@@ in {src}')
        return str(werte[k])
    text = re.sub(r'@@([A-Z0-9_]+)@@', ersetze, text)
    tmp = dst + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        fh.write(text)
    os.replace(tmp, dst)


def cmd_conf_merge(beispiel, ziel):
    """Haengt Schluessel aus dem Beispiel an, die im Ziel fehlen (mit ihrem
    Kommentarblock). Vorhandene Werte bleiben unangetastet."""
    vorhanden = set(lies_conf(ziel))
    neu, block = [], []
    for line in open(beispiel, encoding='utf-8'):
        if line.startswith('#'):
            block.append(line)
            continue
        if not line.strip():
            block = []
            continue
        m = _KV.match(line)
        if m and m.group(1) not in vorhanden:
            neu.extend(block)
            neu.append(line)
        block = []
    if neu:
        with open(ziel, 'a', encoding='utf-8') as fh:
            fh.write(f'\n# --- ergaenzt durch Update am {time.strftime("%Y-%m-%d")} ---\n')
            fh.writelines(neu)
        keys = [l.split('=', 1)[0] for l in neu if _KV.match(l)]
        print(f'  neue Schluessel in {ziel}: {", ".join(keys)}')


def cmd_get(key):
    c = conf()
    c.update(berechnen())
    print(c.get(key, ''))


def cmd_altbestand():
    """Werte einer manuell eingerichteten Vorversion (fail2ban + IDS-Waechter
    ohne Paket) fuer die neue schutz.conf ermitteln."""
    out = {}
    # ntfy aus der alten Action (Token stand dort im Klartext)
    try:
        t = open('/etc/fail2ban/action.d/ntfy.conf').read()
        m = re.search(r'Bearer (tk_[A-Za-z0-9]+)', t)
        u = re.search(r'"(https?://[^"\s]+)/([A-Za-z0-9_-]+)"', t)
        if m:
            out['NTFY_TOKEN'] = m.group(1)
        if u:
            out['NTFY_URL'], out['NTFY_TOPIC'] = u.group(1), u.group(2)
    except OSError:
        pass
    # Internet-Interface und eigene Firewall
    try:
        t = open('/usr/local/sbin/audit-firewall.sh').read()
        m = re.search(r'^IF_WAN=(\S+)', t, re.M)
        if m:
            out['WAN_IF'] = m.group(1).strip('"\'')
        out['FIREWALL'] = 'aus'
    except OSError:
        pass
    # Eigene Anschluesse: oeffentliche Adressen aus sshd-ignoreip
    trusted = []
    for pfad in ('/etc/fail2ban/jail.d/sshd.local', '/etc/fail2ban/jail.local'):
        try:
            for line in open(pfad):
                m = re.match(r'^\s*ignoreip\s*=\s*(.+)$', line)
                if not m:
                    continue
                for n in m.group(1).split():
                    try:
                        net = ipaddress.ip_network(n, strict=False)
                    except ValueError:
                        continue
                    if net.is_global and str(net.network_address) not in trusted:
                        trusted.append(str(net.network_address) if net.num_addresses == 1 else str(net))
        except OSError:
            pass
    if trusted:
        out['TRUSTED_IPS'] = ' '.join(trusted)
    if os.path.exists('/etc/fail2ban/cloudflare.local') and \
            re.search(r'^CF_API_TOKEN="?[^"\s]', open('/etc/fail2ban/cloudflare.local').read(), re.M):
        out['CLOUDFLARE'] = '1'
    out['IDS_AKTIV'] = '1' if os.path.exists('/usr/local/sbin/ids-watch.py') else '0'
    for k, v in out.items():
        print(f'{k}="{v}"')


def cmd_altbestand_ids():
    """agentci-Anbindung aus der alten ids-gesundheit.py (stand dort fest im
    Code) -> KEY=wert-Zeilen fuer /etc/ids-watch.conf."""
    try:
        t = open('/usr/local/sbin/ids-gesundheit.py').read()
    except OSError:
        return
    if 'AGENTCI_URL' in t:          # bereits Paket-Version
        return
    werte = {}
    for key, var in (('AGENTCI_URL', 'AGENTCI'), ('AGENTCI_TOKEN_DATEI', 'TOKEN_FILE'),
                     ('AGENTCI_PROJEKT', 'PROJEKT')):
        m = re.search(rf"^{var}\s*=\s*'([^']+)'", t, re.M)
        if m:
            werte[key] = m.group(1)
    m = re.search(r"(https://agent[\w.-]+)", t)
    if m:
        werte['AGENTCI_LINK'] = m.group(1)
    if werte.get('AGENTCI_URL') and os.path.exists(werte.get('AGENTCI_TOKEN_DATEI', '')):
        for k, v in werte.items():
            print(f'{k}={v}')


if __name__ == '__main__':
    a = sys.argv[1:]
    if not a:
        print(__doc__)
        sys.exit(1)
    if a[0] == 'netze':
        cmd_netze()
    elif a[0] == 'render' and len(a) == 3:
        cmd_render(a[1], a[2])
    elif a[0] == 'conf-merge' and len(a) == 3:
        cmd_conf_merge(a[1], a[2])
    elif a[0] == 'get' and len(a) == 2:
        cmd_get(a[1])
    elif a[0] == 'altbestand':
        cmd_altbestand()
    elif a[0] == 'altbestand-ids':
        cmd_altbestand_ids()
    else:
        print(__doc__)
        sys.exit(1)
