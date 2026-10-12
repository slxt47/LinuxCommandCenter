#!/bin/bash
# Meldet eine Dauersperre per ntfy und protokolliert sie. Teil des Schutz-Pakets des Linux Dashboards.
# Aufruf (aus fail2ban): f2b-dauersperre-notify.sh <ip> <jail> <herkunft> <prio>
# Ruhemodus: existiert /run/f2b-dauersperre.quiet, wird nur protokolliert
# (genutzt beim Einschalten, wenn die Vorgeschichte auf einen Schlag
# abgearbeitet wird).
set -uo pipefail
LOG=/var/log/webauth/dauersperre.log
mkdir -p "${LOG%/*}" 2>/dev/null
IP=${1:-}; JAIL=${2:-?}; HERKUNFT=${3:-?}; PRIO=${4:-default}
# Nur eine echte Adresse darf in Nachricht und Log (Angreifer-Input gibt es
# hier nicht, fail2ban liefert gepruefte IPs -- trotzdem pruefen).
python3 -c 'import ipaddress,sys; ipaddress.ip_address(sys.argv[1])' "$IP" 2>/dev/null || exit 0
case "$PRIO" in min|low|default|high|urgent) ;; *) PRIO=default ;; esac
TS=$(date '+%Y-%m-%d %H:%M:%S %Z')
printf '%s DAUERSPERRE %s jail=%s herkunft=%s\n' "$TS" "$IP" "$JAIL" "$HERKUNFT" >> "$LOG"
[ -e /run/f2b-dauersperre.quiet ] && exit 0
# Nur ueber SSH aufgefallen (Scanner, ~10/Tag)? Dann nur protokollieren, kein Push
# (SSH-Scanner kommen dutzendfach am Tag). Massgeblich: Jails, die die IP gerade sperren.
JAILS=$(fail2ban-client banned "$IP" 2>/dev/null | grep -oE "'[a-z0-9-]+'" | tr -d "'" | sort -u)
if [ "$JAIL" = dauersperre ] && [ -n "$JAILS" ] && ! grep -qvE '^(sshd|sshd-invalid|dauersperre|dauersperre-web)$' <<<"$JAILS"; then
    printf '%s   (kein Push: nur SSH)\n' "$TS" >> "$LOG"
    exit 0
fi
TAGE=$(sed -n 's/^DAUERSPERRE_TAGE="\{0,1\}\([0-9]*\).*/\1/p' /etc/linux-dashboard/schutz.conf 2>/dev/null)
/usr/local/sbin/waechter-push -t "no_entry_sign" "Dauerhaft gesperrt: $IP" "$PRIO" \
    "IP $IP wurde zum 3. Mal innerhalb von ${TAGE:-90} Tagen gesperrt und ist jetzt DAUERHAFT gesperrt. Herkunft: $HERKUNFT | Jail: $JAIL | Server: $(hostname) | Zeit: $TS | Freigabe: webauth-unban.sh $IP"
exit 0
