#!/usr/bin/env python3
"""Erzeugt /etc/suricata/suricata-ids.yaml aus der Paket-Vorlage suricata.yaml.
Teil des Schutz-Pakets des Linux Dashboards.

Die Paketdatei bleibt unberuehrt (apt-Updates ueberschreiben sie ggf.); die
eigene Konfig wird bei jedem Update/"waechter config-anwenden" neu erzeugt.

Aufruf: gen-suricata-ids-yaml.py --iface eth0 --home "[1.2.3.4/32,10.0.0.0/8]" --threads 2
"""
import argparse
import sys

import yaml

ap = argparse.ArgumentParser()
ap.add_argument('--iface', required=True)
ap.add_argument('--home', required=True, help='HOME_NET im Suricata-Format [a,b,c]')
ap.add_argument('--threads', type=int, default=2)
ap.add_argument('--src', default='/etc/suricata/suricata.yaml')
ap.add_argument('--out', default='/etc/suricata/suricata-ids.yaml')
a = ap.parse_args()

text = open(a.src).read()
if text.startswith('%YAML'):
    text = text.split('\n', 1)[1]
src = yaml.safe_load(text)

v = src['vars']['address-groups']
v['HOME_NET'] = a.home
v['EXTERNAL_NET'] = '!$HOME_NET'

# Passiv per af-packet (kein NFQUEUE/inline): stuerzt Suricata ab, laeuft der
# Verkehr unveraendert weiter - nur ohne neue Sperren.
src['af-packet'] = [
    {'interface': a.iface, 'threads': max(1, a.threads), 'cluster-id': 99,
     'cluster-type': 'cluster_flow', 'defrag': True, 'tpacket-v3': True,
     'checksum-checks': 'no'},
    {'interface': 'default'},
]

outs = []
for o in src.get('outputs', []):
    name = next(iter(o))
    if name == 'eve-log':
        e = o[name]
        e.update({'enabled': True, 'filetype': 'regular', 'filename': 'eve.json',
                  'community-id': True})
        e.pop('xff', None)
        # Nur Alarme: haelt eve.json klein, ids-watch liest nichts anderes.
        e['types'] = [{'alert': {'tagged-packets': False,
                                 'metadata': {'app-layer': True, 'flow': True,
                                              'rule': {'metadata': True}}}}]
    elif name in ('fast', 'stats'):
        o[name]['enabled'] = False
    outs.append(o)
src['outputs'] = outs
src['stats'] = {'enabled': False}
src['default-rule-path'] = '/var/lib/suricata/rules'
src['rule-files'] = ['suricata.rules']
src.setdefault('logging', {})
src['logging']['outputs'] = [{'console': {'enabled': False}},
                             {'file': {'enabled': True, 'level': 'notice',
                                       'filename': 'suricata.log'}},
                             {'syslog': {'enabled': False}}]
# Command-Socket fuer suricatasc (Gesundheitspruefung, Dashboard-Kachel)
src['unix-command'] = {'enabled': True, 'filename': '/run/suricata/suricata-command.socket'}

out = ('%YAML 1.1\n---\n# ERZEUGT von gen-suricata-ids-yaml.py (Linux-Dashboard-Schutz) - '
       'nicht von Hand aendern, wird bei Updates neu geschrieben.\n'
       + yaml.safe_dump(src, sort_keys=False, default_flow_style=False))
open(a.out, 'w').write(out)
print('ok', a.out, file=sys.stderr)
