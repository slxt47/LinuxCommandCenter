#!/bin/bash
#############################################################################
# waechter-firewall.sh -- haengt die Sperrlisten (ipsets) in die Firewall ein.
# Teil des Schutz-Pakets des Linux Dashboards (Datei gehoert dem Paket).
#
# Aufruf:  waechter-firewall.sh            Sets anlegen + Ketten aufbauen
#          waechter-firewall.sh --stop     eigene Ketten entfernen (Sets bleiben)
#          waechter-firewall.sh --nur-sets nur die ipsets anlegen (FIREWALL=aus)
#
# Grundsaetze:
# - Rein ADDITIV und idempotent: eigene Ketten WAECHTER-IN/-OUT/-FWD (+6),
#   an Position 1 von INPUT/OUTPUT/FORWARD eingehaengt. Bestehende Regeln
#   (ufw, Docker, libvirt, Tailscale) bleiben unberuehrt.
# - Nur DROP fuer gesperrte Adressen, sonst RETURN - nie ACCEPT. Die Ketten
#   koennen also nichts oeffnen, was eine andere Firewall geschlossen hat.
# - Interne Interfaces (RUHIGE_INTERFACES) und TRUSTED_IPS werden vor jeder
#   Sperre per RETURN durchgelassen: ein versehentlicher Selbst-Ban sperrt
#   weder Tailscale noch den eigenen Anschluss aus.
# - IDS-Sperren (ids_ban4/6) wirken in BEIDE Richtungen und vor ESTABLISHED:
#   auch eine laufende Angriffsverbindung bricht ab, und kein Dienst/Container
#   erreicht ein als boesartig erkanntes Ziel.
# - Container mit veroeffentlichten Ports laufen per DNAT durch FORWARD und nie
#   durch INPUT. Docker springt in FORWARD vor allem anderen nach DOCKER-USER -
#   deshalb stehen die Sperren dort zusaetzlich.
#############################################################################
set -u
CONF=/etc/linux-dashboard/schutz.conf
NETZE=/etc/linux-dashboard/schutz-netze.generiert
BLK=/etc/linux-dashboard/blk_net4.txt

RUHIGE_INTERFACES="lo tailscale0 docker0 br-+ virbr+"
TRUSTED_IPS=""
WAN_IF=""
# shellcheck source=/dev/null
[ -r "$CONF" ] && . "$CONF"
# shellcheck source=/dev/null
[ -r "$NETZE" ] && . "$NETZE"
if [ -z "$WAN_IF" ] || [ "$WAN_IF" = "auto" ]; then
    WAN_IF=$(ip -o route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')
fi

log() { logger -t waechter-firewall "$*" 2>/dev/null; echo "$*"; }

sets_anlegen() {
    # Parameter MUESSEN mit den fail2ban-Actions uebereinstimmen, sonst
    # scheitert dort "ipset create ... -exist".
    ipset create ssh_ban4  hash:ip  family inet  timeout 0 -exist
    ipset create ssh_ban6  hash:ip  family inet6 timeout 0 -exist
    ipset create perm_ban4 hash:ip  family inet  timeout 0 maxelem 1000000 -exist
    ipset create perm_ban6 hash:ip  family inet6 timeout 0 maxelem 1000000 -exist
    ipset create f2b_long4 hash:ip  family inet  timeout 0 -exist
    ipset create f2b_long6 hash:ip  family inet6 timeout 0 -exist
    ipset create f2b_net4  hash:net family inet  timeout 0 -exist
    ipset create ids_ban4  hash:ip  family inet  timeout 0 maxelem 1000000 -exist
    ipset create ids_ban6  hash:ip  family inet6 timeout 0 maxelem 1000000 -exist
    ipset create blk_net4  hash:net family inet  -exist
    if [ -r "$BLK" ]; then
        ipset flush blk_net4
        grep -Eo '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+' "$BLK" \
          | while read -r n; do ipset add blk_net4 "$n" -exist; done
    fi
}

kette_weg() {   # kette_weg <iptables|ip6tables> <hook> <kette>
    while $1 -D "$2" -j "$3" 2>/dev/null; do :; done
    $1 -F "$3" 2>/dev/null
    $1 -X "$3" 2>/dev/null
}

docker_user_weg() {
    local t r
    for t in iptables ip6tables; do
        $t -S DOCKER-USER >/dev/null 2>&1 || continue
        # Alle Regeln entfernen, die auf unsere Sets verweisen (Kommentar-Marke).
        $t -S DOCKER-USER | grep -- '--comment "\?waechter' | sed 's/^-A /-D /' \
          | while read -r r; do eval "$t $r" 2>/dev/null; done
    done
}

stop() {
    kette_weg iptables  INPUT   WAECHTER-IN
    kette_weg iptables  OUTPUT  WAECHTER-OUT
    kette_weg iptables  FORWARD WAECHTER-FWD
    kette_weg ip6tables INPUT   WAECHTER-IN6
    kette_weg ip6tables OUTPUT  WAECHTER-OUT6
    kette_weg ip6tables FORWARD WAECHTER-FWD6
    docker_user_weg
}

case "${1:-}" in
    --stop)     stop; log "Waechter-Ketten entfernt"; exit 0 ;;
    --nur-sets) sets_anlegen; log "Sperrlisten (ipsets) angelegt"; exit 0 ;;
esac

if [ -z "$WAN_IF" ]; then
    log "FEHLER: kein Internet-Interface gefunden (WAN_IF in $CONF setzen)"
    sets_anlegen
    exit 1
fi

sets_anlegen
stop

ist_v6() { case "$1" in *:*) return 0 ;; *) return 1 ;; esac; }

# --- Eingang ---------------------------------------------------------------
for fam in 4 6; do
    if [ $fam = 4 ]; then T=iptables; K=WAECHTER-IN; S=4; else T=ip6tables; K=WAECHTER-IN6; S=6; fi
    $T -N $K
    $T -I INPUT 1 -j $K
    # IDS-Sperre zuerst (vor ESTABLISHED), nur auf dem Internet-Interface
    $T -A $K -i "$WAN_IF" -m set --match-set ids_ban$S src -j DROP
    $T -A $K -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
    for i in $RUHIGE_INTERFACES; do $T -A $K -i "$i" -j RETURN; done
    [ $fam = 6 ] && $T -A $K -p ipv6-icmp -j RETURN   # Neighbor Discovery/PMTU nie stoeren
    for t in $TRUSTED_IPS; do
        if ist_v6 "$t"; then [ $fam = 6 ] && $T -A $K -s "$t" -j RETURN
        else [ $fam = 4 ] && $T -A $K -s "$t" -j RETURN; fi
    done
    $T -A $K -m set --match-set ssh_ban$S  src -j DROP
    $T -A $K -m set --match-set perm_ban$S src -j DROP
    $T -A $K -m set --match-set f2b_long$S src -j DROP
    if [ $fam = 4 ]; then
        $T -A $K -m set --match-set f2b_net4 src -j DROP
        $T -A $K -m set --match-set blk_net4 src -j DROP
    fi
done

# --- Ausgang (Host) ----------------------------------------------------------
iptables  -N WAECHTER-OUT;  iptables  -I OUTPUT 1 -j WAECHTER-OUT
ip6tables -N WAECHTER-OUT6; ip6tables -I OUTPUT 1 -j WAECHTER-OUT6
iptables  -A WAECHTER-OUT  -o "$WAN_IF" -m set --match-set ids_ban4 dst -j REJECT
ip6tables -A WAECHTER-OUT6 -o "$WAN_IF" -m set --match-set ids_ban6 dst -j REJECT

# --- Weiterleitung (VMs, Container ohne Docker-Regeln) ----------------------
iptables  -N WAECHTER-FWD;  iptables  -I FORWARD 1 -j WAECHTER-FWD
ip6tables -N WAECHTER-FWD6; ip6tables -I FORWARD 1 -j WAECHTER-FWD6
iptables  -A WAECHTER-FWD  -m set --match-set ids_ban4 dst -j REJECT
iptables  -A WAECHTER-FWD  -m set --match-set ids_ban4 src -j DROP
ip6tables -A WAECHTER-FWD6 -m set --match-set ids_ban6 dst -j REJECT
ip6tables -A WAECHTER-FWD6 -m set --match-set ids_ban6 src -j DROP
for S in ssh_ban4 perm_ban4 f2b_long4 f2b_net4 blk_net4; do
    iptables -A WAECHTER-FWD -i "$WAN_IF" -m set --match-set $S src -j DROP
done
for S in ssh_ban6 perm_ban6 f2b_long6; do
    ip6tables -A WAECHTER-FWD6 -i "$WAN_IF" -m set --match-set $S src -j DROP
done

# --- Docker (DOCKER-USER) -----------------------------------------------------
# Nur wenn Docker laeuft. Docker leert DOCKER-USER bei einem Neustart nicht;
# fehlt die Kette noch (Docker startet spaeter), legt die Gesundheitspruefung
# bzw. der naechste Lauf die Regeln nach.
du_regel() {  # du_regel <iptables|ip6tables> <regel...>
    local t=$1; shift
    $t -I DOCKER-USER 1 "$@" -m comment --comment waechter
}
if iptables -S DOCKER-USER >/dev/null 2>&1; then
    for S in blk_net4 f2b_net4 f2b_long4 perm_ban4 ssh_ban4; do
        du_regel iptables -i "$WAN_IF" -m set --match-set $S src -j DROP
    done
    du_regel iptables -m set --match-set ids_ban4 dst -j REJECT
    du_regel iptables -m set --match-set ids_ban4 src -j DROP
fi
if ip6tables -S DOCKER-USER >/dev/null 2>&1; then
    for S in f2b_long6 perm_ban6 ssh_ban6; do
        du_regel ip6tables -i "$WAN_IF" -m set --match-set $S src -j DROP
    done
    du_regel ip6tables -m set --match-set ids_ban6 dst -j REJECT
    du_regel ip6tables -m set --match-set ids_ban6 src -j DROP
fi

log "Waechter-Firewall aufgebaut (WAN=$WAN_IF, WAECHTER-IN $(iptables -S WAECHTER-IN | wc -l) Regeln)"
exit 0
