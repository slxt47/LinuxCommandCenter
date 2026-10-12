#!/bin/bash
# ---------------------------------------------------------------------------
# webauth-unban.sh -- eine IP ueberall wieder freigeben.
#
# Gedacht fuer den Fall, der bei maxretry=3 realistisch ist: man vertippt sich
# dreimal und sperrt die eigene Anschlussadresse aus. Ein Ban wirkt an drei
# Stellen (fail2ban-Jails, ipset, Cloudflare-Liste); dieses Skript raeumt alle
# drei ab, damit man nicht einzeln suchen muss.
#
# Aufruf:  webauth-unban.sh <ip>
#          webauth-unban.sh --status        alle aktiven Sperren anzeigen
#
# Teil des Schutz-Pakets des Linux Dashboards.
# ---------------------------------------------------------------------------
set -uo pipefail

if [ "${1:-}" = "--status" ] || [ -z "${1:-}" ]; then
    echo "== Aktive Sperren je Jail"
    for j in $(fail2ban-client status 2>/dev/null | sed -n 's/^.*Jail list:\s*//p' | tr ',' ' '); do
        liste=$(fail2ban-client status "$j" 2>/dev/null | sed -n 's/.*Banned IP list:\s*//p')
        [ -z "${liste// /}" ] && continue
        # Die SSH-Jails halten oft mehrere hundert Adressen. Vollstaendig
        # ausgegeben ist die Uebersicht unlesbar, deshalb nur Anzahl und die
        # letzten fuenf - die aelteren interessieren beim Nachsehen ohnehin
        # nicht. Die ganze Liste liefert `fail2ban-client status <jail>`.
        anzahl=$(printf '%s' "$liste" | wc -w)
        if [ "$anzahl" -gt 5 ]; then
            printf '  %-22s %s Adressen, zuletzt: %s ...\n' \
                "$j" "$anzahl" "$(printf '%s' "$liste" | tr ' ' '\n' | tail -5 | tr '\n' ' ')"
        else
            printf '  %-22s %s\n' "$j" "$liste"
        fi
    done
    echo
    echo "== ipset ssh_ban4/ssh_ban6"
    printf '  ssh_ban4: %s Eintraege\n' "$(ipset list -o save ssh_ban4 2>/dev/null | grep -c '^add ')"
    printf '  ssh_ban6: %s Eintraege\n' "$(ipset list -o save ssh_ban6 2>/dev/null | grep -c '^add ')"
    printf '  perm_ban4: %s Eintraege (Dauersperre)\n' "$(ipset list -o save perm_ban4 2>/dev/null | grep -c '^add ')"
    printf '  perm_ban6: %s Eintraege (Dauersperre)\n' "$(ipset list -o save perm_ban6 2>/dev/null | grep -c '^add ')"
    printf '  ids_ban4: %s Eintraege (IDS-Waechter)\n' "$(ipset list -o save ids_ban4 2>/dev/null | grep -c '^add ')"
    printf '  ids_ban6: %s Eintraege (IDS-Waechter)\n' "$(ipset list -o save ids_ban6 2>/dev/null | grep -c '^add ')"
    printf '  f2b_long4/6: %s Eintraege (Mail-Langzeit)\n' "$(( $(ipset list -o save f2b_long4 2>/dev/null | grep -c '^add ') + $(ipset list -o save f2b_long6 2>/dev/null | grep -c '^add ') ))"
    printf '  f2b_net4: %s Netze (Mail /24)\n' "$(ipset list -o save f2b_net4 2>/dev/null | grep -c '^add ')"
    echo
    echo "Freigeben mit:  $0 <ip>"
    exit 0
fi

IP=$1
python3 -c 'import ipaddress,sys; ipaddress.ip_address(sys.argv[1])' "$IP" 2>/dev/null \
    || { echo "FEHLER: '$IP' ist keine gueltige IP-Adresse" >&2; exit 1; }
echo "== $IP freigeben"

for j in $(fail2ban-client status 2>/dev/null | sed -n 's/^.*Jail list:\s*//p' | tr ',' ' '); do
    r=$(fail2ban-client set "$j" unbanip "$IP" 2>/dev/null)
    [ "$r" = "1" ] && echo "  fail2ban: aus Jail $j entfernt"
done

for set_ in ssh_ban4 ssh_ban6 perm_ban4 perm_ban6 f2b_long4 f2b_long6 ids_ban4 ids_ban6; do
    if ipset test "$set_" "$IP" >/dev/null 2>&1; then
        ipset del "$set_" "$IP" 2>/dev/null && echo "  ipset: aus $set_ entfernt"
    fi
done

# Cloudflare zuletzt: das ist die Sperre, die bei Diensten hinter dem Tunnel
# tatsaechlich wirkt. Nur wenn ein Cloudflare-Token hinterlegt ist.
if grep -qE '^CF_API_TOKEN="?[^" ]' /etc/fail2ban/cloudflare.local 2>/dev/null; then
    /usr/local/sbin/cf-ban.sh del "$IP" manuell
    sleep 2
    tail -1 /var/log/webauth/cf-ban.log 2>/dev/null | sed 's/^/  cloudflare: /'
fi

echo "Fertig."
