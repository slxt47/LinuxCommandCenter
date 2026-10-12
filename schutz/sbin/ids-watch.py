#!/usr/bin/env python3
"""
ids-watch - wertet Suricata-Alarme aus und meldet Sperrkandidaten an fail2ban.

Teil des Schutz-Pakets des Linux Dashboards (Doku: README.md im Repository).

Suricata (passiv auf dem Internet-Interface) schreibt Alarme nach /var/log/suricata/eve.json.
Dieser Dienst liest die Datei mit, entscheidet je Alarm und schreibt EINE
saubere Zeile nach /var/log/ids-watch.log. Gesperrt wird nicht hier, sondern
von fail2ban (Jails ids-angriff / ids-ausgang -> ipset ids_ban4/6), damit
Freigabe (webauth-unban.sh), Ablauf und Verdopplung wie ueberall funktionieren.

Zeilenformat (fail2ban-Filter ids-watch.conf haengt daran):
  <zeit> IDS-ANGRIFF <ip> <text>      Angriff von aussen -> Gegenstelle sperren
  <zeit> IDS-AUSGANG <ip> <text>      Server/Container/VM baut verdaechtige
                                      Verbindung nach aussen auf -> Ziel sperren
  <zeit> IDS-WARNUNG <resolver> <text> DNS-Abfrage einer Malware-Domain (Push, keine Sperre)
  <zeit> IDS-MELDUNG <ip> <text>      nur notiert (Modus "melden", Whitelist,
                                      DNS-Treffer, schwache Kategorie ...)
Die IP steht immer an dritter Stelle und ist per ipaddress validiert; der Text
dahinter stammt aus Regeln/Metadaten und wird auf druckbare Zeichen gekuerzt.
"""
import ipaddress, json, os, re, subprocess, sys, time, urllib.request
from collections import deque

EVE = '/var/log/suricata/eve.json'
OUT = '/var/log/ids-watch.log'
CONF = '/etc/ids-watch.conf'
CF_CACHE = '/var/lib/ids-watch/cloudflare.txt'
PUSH = '/usr/local/sbin/ids-push.sh'
# Vom Installer aus /etc/linux-dashboard/schutz.conf erzeugt (waechter config-anwenden):
#   HOME_NETZE  = eigene + interne Netze ("innen" fuer die Richtungsentscheidung)
#   NIE_SPERREN = TRUSTED_IPS, System-Resolver, IDS_WHITELIST_EXTRA
NETZE = '/etc/linux-dashboard/schutz-netze.generiert'

IMMER_HOME = ('127.0.0.0/8', '::1/128', 'fe80::/10', 'ff00::/8', '224.0.0.0/4',
              '255.255.255.255/32', '0.0.0.0/32')


def lade_netze():
    werte = {}
    try:
        for line in open(NETZE):
            m = re.match(r'^\s*([A-Z_]+)="?([^"]*)"?\s*$', line)
            if m:
                werte[m.group(1)] = m.group(2).split()
    except OSError:
        pass
    home = []
    for n in list(IMMER_HOME) + werte.get('HOME_NETZE', ['10.0.0.0/8', '172.16.0.0/12',
                                                         '192.168.0.0/16', '100.64.0.0/10']):
        try:
            home.append(ipaddress.ip_network(n, strict=False))
        except ValueError:
            pass
    nie = werte.get('NIE_SPERREN', [])
    if werte.get('CLOUDFLARE', ['0'])[:1] == ['1']:
        nie = nie + CLOUDFLARE_NETZE + ['CLOUDFLARE-LISTE']
    return home, nie


# Cloudflare-Netze: nur mit CLOUDFLARE=1 auf der Whitelist (Tunnel/Proxy -
# eine Sperre wuerde alle eigenen Web-Dienste abschneiden). Die aktuelle Liste
# kommt dann zusaetzlich taeglich aus CF_CACHE.
CLOUDFLARE_NETZE = [
    '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
    '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
    '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
    '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22', '2400:cb00::/32',
    '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
    '2a06:98c0::/29', '2c0f:f248::/32',
]

HOME, NIE_SPERREN = lade_netze()

# Gegenstellen, die NIE gesperrt werden duerfen (grosse oeffentliche Resolver;
# die eigenen System-Resolver stehen in NIE_SPERREN).
WHITELIST_FEST = [
    '1.1.1.1/32', '1.0.0.1/32', '8.8.8.8/32', '8.8.4.4/32', '9.9.9.9/32',
]

# Kategorien (Praefix der Signatur). Alles andere (ET INFO, ET POLICY,
# ET HUNTING, SURICATA-Decoder ...) wird nie gesperrt, nur ggf. notiert.
ANGRIFF = ('ET SCAN', 'ET EXPLOIT', 'ET WEB_SERVER', 'ET WEB_SPECIFIC_APPS',
           'ET ATTACK_RESPONSE', 'ET DOS', 'ET WORM', 'ET CURRENT_EVENTS',
           'ET MALWARE', 'ET TROJAN', 'ET DROP', 'ET CINS', 'ET COMPROMISED',
           'ET 3CORESec', 'ET PHISHING', 'GPL EXPLOIT', 'GPL WEB_SERVER',
           'GPL ATTACK_RESPONSE', 'GPL SCAN', 'GPL SHELLCODE', 'GPL RPC',
           'GPL NETBIOS', 'GPL SQL', 'ET SHELLCODE', 'ET SQL', 'ET VOIP',
           'ET TELNET', 'ET RPC')
# Reine IP-Reputationslisten: zaehlen nur, wenn die GEGENSTELLE die Verbindung
# aufgebaut hat. Baut der Server selbst zu so einer IP auf (z.B. Mailzustellung
# an einen gelisteten MX), wird nicht gesperrt - sonst bricht eigener Betrieb.
REPUTATION = ('ET DROP', 'ET CINS', 'ET COMPROMISED', 'ET 3CORESec')
AUSGANG = ('ET MALWARE', 'ET TROJAN', 'ET MOBILE_MALWARE', 'ET COINMINER',
           'ET ATTACK_RESPONSE', 'ET CURRENT_EVENTS', 'ET WORM', 'ET PHISHING',
           'GPL ATTACK_RESPONSE')

MAX_SPERREN_PRO_STUNDE = 1500  # Notbremse gegen Regelfehler / Flut; per Konf. aenderbar
# 300 war zu knapp: allein die Reputationslisten (CINS/DROP) liefern einige
# hundert neue Scanner-IPs pro Stunde, die Bremse zog bei normalem Grundrauschen.
NICHT_WIEDERHOLEN_S = 600      # gleiche IP+Art hoechstens alle 10 min melden


def log(msg):
    print(msg, flush=True)


def conf():
    c = {'MODUS': 'melden', 'MIN_SEVERITY_ANGRIFF': '2', 'MIN_SEVERITY_AUSGANG': '2'}
    try:
        for line in open(CONF):
            m = re.match(r'^\s*([A-Z_]+)\s*=\s*"?([^"#\s]*)"?', line)
            if m:
                c[m.group(1)] = m.group(2)
    except OSError:
        pass
    return c


def lade_whitelist():
    nets = list(WHITELIST_FEST) + [n for n in NIE_SPERREN if n != 'CLOUDFLARE-LISTE']
    if 'CLOUDFLARE-LISTE' in NIE_SPERREN:
        try:
            nets += [l.strip() for l in open(CF_CACHE) if l.strip()]
        except OSError:
            pass
    try:
        for n in open('/etc/ids-watch.whitelist'):
            n = n.split('#', 1)[0].strip()
            if n:
                nets.append(n)
    except OSError:
        pass
    out = []
    for n in nets:
        try:
            out.append(ipaddress.ip_network(n, strict=False))
        except ValueError:
            log(f'Whitelist-Eintrag ungueltig: {n!r}')
    return out


def cf_aktualisieren():
    try:
        nets = []
        for f in ('v4', 'v6'):
            req = urllib.request.Request(f'https://www.cloudflare.com/ips-{f}',
                                         headers={'User-Agent': 'curl/7.81.0'})
            with urllib.request.urlopen(req, timeout=15) as r:
                nets += [ipaddress.ip_network(l.strip()).compressed
                         for l in r.read().decode().split() if l.strip()]
        if len(nets) > 10:
            os.makedirs(os.path.dirname(CF_CACHE), exist_ok=True)
            open(CF_CACHE + '.tmp', 'w').write('\n'.join(nets) + '\n')
            os.replace(CF_CACHE + '.tmp', CF_CACHE)
    except Exception as e:
        log(f'Cloudflare-Liste nicht aktualisiert: {e}')


def ist(ip, netze):
    return any(ip.version == n.version and ip in n for n in netze)


def sauber(s, n=160):
    return re.sub(r'[^A-Za-z0-9 ._:/()\[\]+=,-]', '_', str(s))[:n]


def herkunft(ext):
    """Welcher Container/VM steckt hinter der NAT? (conntrack, best effort)"""
    try:
        r = subprocess.run(['conntrack', '-L', '-d', str(ext)], capture_output=True,
                           text=True, timeout=5)
        m = re.search(r'src=(\S+) dst=' + re.escape(str(ext)), r.stdout)
        if not m:
            return ''
        src = ipaddress.ip_address(m.group(1))
        if not src.is_private:
            return 'Host'
        r = subprocess.run(['docker', 'ps', '-q'], capture_output=True, text=True, timeout=10)
        ids = r.stdout.split()
        if ids:
            r = subprocess.run(['docker', 'inspect', '-f',
                                '{{.Name}} {{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}'] + ids,
                               capture_output=True, text=True, timeout=10)
            for line in r.stdout.splitlines():
                teile = line.split()
                if str(src) in teile[1:]:
                    return 'Container ' + teile[0].lstrip('/')
        return f'intern {src}'
    except Exception:
        return ''


def bereits_gesperrt(ip):
    return subprocess.run(['ipset', 'test', 'ids_ban6' if ip.version == 6 else 'ids_ban4',
                           ip.compressed], capture_output=True).returncode == 0


def folge(pfad):
    """tail -F: liest neue Zeilen, folgt Logrotate (Inode-Wechsel)."""
    f, ino = None, None
    while True:
        if f is None:
            try:
                f = open(pfad, 'r', errors='replace')
                ino = os.fstat(f.fileno()).st_ino
                if not getattr(folge, 'gestartet', False):
                    f.seek(0, 2)          # beim Dienststart nur neue Alarme
                    folge.gestartet = True
            except OSError:
                time.sleep(5)
                continue
        line = f.readline()
        if line:
            if line.endswith('\n'):
                yield line
            else:
                f.seek(f.tell() - len(line.encode('utf-8', 'replace')))
                time.sleep(0.5)
            continue
        time.sleep(1)
        try:
            if os.stat(pfad).st_ino != ino or os.stat(pfad).st_size < f.tell():
                f.close()
                f = None
        except OSError:
            pass


def main():
    global HOME, NIE_SPERREN
    out = open(OUT, 'a', buffering=1)
    os.chmod(OUT, 0o640)
    if 'CLOUDFLARE-LISTE' in NIE_SPERREN:
        cf_aktualisieren()
    weiss = lade_whitelist()
    c = conf()
    letzte_konf = time.time()
    zuletzt = {}
    sperren = deque()
    notbremse = False
    log(f'gestartet, Modus={c["MODUS"]}, Whitelist {len(weiss)} Netze')

    def schreibe(art, ip, text):
        out.write(f'{time.strftime("%Y-%m-%d %H:%M:%S")} {art} {ip.compressed} {text}\n')

    for line in folge(EVE):
        jetzt = time.time()
        if jetzt - letzte_konf > 60:
            c, letzte_konf = conf(), jetzt
            if 'CLOUDFLARE-LISTE' in NIE_SPERREN and (
                    not os.path.exists(CF_CACHE) or jetzt - os.path.getmtime(CF_CACHE) > 86400):
                cf_aktualisieren()
            HOME, NIE_SPERREN = lade_netze()
            weiss = lade_whitelist()
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get('event_type') != 'alert':
            continue
        a = e.get('alert', {})
        sig = a.get('signature', '')
        sev = int(a.get('severity', 3))
        try:
            src = ipaddress.ip_address(e['src_ip'])
            dst = ipaddress.ip_address(e['dest_ip'])
        except (KeyError, ValueError):
            continue
        fl = e.get('flow') or {}
        try:
            initiator = ipaddress.ip_address(fl.get('src_ip', e['src_ip']))
        except ValueError:
            initiator = src
        s_home, d_home = ist(src, HOME), ist(dst, HOME)
        if s_home == d_home:
            continue                       # intern<->intern oder fremd<->fremd
        ext = dst if s_home else src
        von_aussen = not ist(initiator, HOME)
        port = fl.get('dest_port', e.get('dest_port'))   # angesprochener Dienst-Port der Verbindung
        text = sauber(f'sev={sev} sid={a.get("signature_id")} [{sig}] '
                      f'{e.get("proto","")}/{port} ({"von aussen" if von_aussen else "von innen"})')

        art = 'IDS-MELDUNG'
        grund = ''
        dns = e.get('app_proto') == 'dns' or e.get('dest_port') == 53 or e.get('src_port') == 53
        if (not von_aussen and dns and sig.startswith(AUSGANG)
                and sev <= int(c['MIN_SEVERITY_AUSGANG'])):
            # Jemand hier fragt eine Malware-/Mining-Domain ab. Der Resolver
            # wird nie gesperrt (sonst faellt DNS aus) - aber sofort melden.
            k = ('WARNUNG', sig)
            if jetzt - zuletzt.get(k, 0) > 3600:
                zuletzt[k] = jetzt
                q = ((e.get('dns') or {}).get('queries') or [{}])[0].get('rrname', '') \
                    or (e.get('dns') or {}).get('rrname', '')
                schreibe('IDS-WARNUNG', ext, sauber(f'{text} domain={q}', 260))
                subprocess.Popen([PUSH, 'IDS: verdaechtige DNS-Abfrage', 'urgent',
                                  sauber(f'{sig} domain={q} - ein Dienst/Container auf dem Server '
                                         'fragt eine bekannte Malware-/Mining-Domain ab. '
                                         'Verbindungen zum Ziel werden gesperrt, sobald sie '
                                         'aufgebaut werden. Pruefen: /var/log/ids-watch.log', 400)])
            continue
        if ist(ext, weiss):
            grund = 'Whitelist'
        elif von_aussen:
            if sig.startswith(ANGRIFF) and sev <= int(c['MIN_SEVERITY_ANGRIFF']):
                art = 'IDS-ANGRIFF'
            else:
                grund = 'Kategorie/Schwere'
        else:
            # Verbindung wurde von hier aus aufgebaut
            if sig.startswith(REPUTATION):
                grund = 'Reputation, selbst aufgebaut'
            elif dns:
                grund = 'DNS-Abfrage (Resolver wird nie gesperrt)'
            elif sig.startswith(AUSGANG) and sev <= int(c['MIN_SEVERITY_AUSGANG']):
                art = 'IDS-AUSGANG'
            elif sig.startswith(ANGRIFF) and sev <= int(c['MIN_SEVERITY_ANGRIFF']):
                # z.B. ET SCAN-Treffer auf Verkehr, den wir aufgebaut haben:
                # meist Antwort eines fremden Servers -> nicht sperren
                grund = 'Angriffsregel, aber selbst aufgebaut'
            else:
                grund = 'Kategorie/Schwere'

        key = (art, ext)
        if jetzt - zuletzt.get(key, 0) < NICHT_WIEDERHOLEN_S:
            continue
        zuletzt[key] = jetzt
        if len(zuletzt) > 50000:
            zuletzt = {k: v for k, v in zuletzt.items() if jetzt - v < NICHT_WIEDERHOLEN_S}

        if art != 'IDS-MELDUNG':
            if c['MODUS'] != 'sperren':
                schreibe('IDS-MELDUNG', ext, f'{text} WUERDE-SPERREN={art}')
                continue
            if bereits_gesperrt(ext):
                continue                       # Suricata sieht Pakete VOR der Firewall
            limit = int(c.get('MAX_SPERREN_PRO_STUNDE', MAX_SPERREN_PRO_STUNDE))
            while sperren and jetzt - sperren[0] > 3600:
                sperren.popleft()
            if len(sperren) >= limit:
                if not notbremse:
                    notbremse = True
                    log('NOTBREMSE: zu viele Sperren in einer Stunde, nur noch melden')
                    subprocess.Popen([PUSH, 'IDS-Notbremse', 'urgent',
                                      f'Mehr als {limit} IDS-Sperren in 1 h - '
                                      'Waechter sperrt vorerst nicht mehr, bitte pruefen.'])
                schreibe('IDS-MELDUNG', ext, f'{text} NOTBREMSE')
                continue
            notbremse = False
            sperren.append(jetzt)
            if art == 'IDS-AUSGANG':
                wer = herkunft(ext)
                text = sauber(f'{text} herkunft={wer or "unbekannt"}', 220)
        else:
            text = f'{text} {grund}'
        schreibe(art, ext, text)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
