#!/bin/bash
# Taeglicher IDS-Bericht per ntfy. Teil des Schutz-Pakets des Linux Dashboards.
# Eingehende Sperren pusht fail2ban bewusst NICHT einzeln (Scanner kommen im
# Minutentakt) - stattdessen diese Zusammenfassung der letzten 24 h.
L=/var/log/ids-watch.log
seit=$(date -d '24 hours ago' '+%Y-%m-%d %H:%M:%S')
zeilen=$(cat "$L.1" "$L" 2>/dev/null | awk -v s="$seit" '($1" "$2) >= s')
an=$(grep -c ' IDS-ANGRIFF ' <<<"$zeilen"); aus=$(grep -c ' IDS-AUSGANG ' <<<"$zeilen")
wuerde=$(grep -c 'WUERDE-SPERREN' <<<"$zeilen")
top=$(grep -E ' IDS-(ANGRIFF|AUSGANG) |WUERDE-SPERREN' <<<"$zeilen" | sed -n 's/.*\[\(ET [A-Z_0-9]*\|GPL [A-Z_]*\).*/\1/p' | sort | uniq -c | sort -rn | head -5 | awk '{c=$1;$1="";printf "%s%s x%s", (NR>1?", ":""), $0, c}')
modus=$(sed -n 's/^MODUS=//p' /etc/ids-watch.conf)
aktiv=$(( $(ipset list -o save ids_ban4 2>/dev/null | grep -c '^add ') + $(ipset list -o save ids_ban6 2>/dev/null | grep -c '^add ') ))
prio=low; [ "$aus" -gt 0 ] && prio=high
/usr/local/sbin/ids-push.sh "IDS-Tagesbericht" "$prio" \
  "Modus $modus. 24 h: $an Angreifer gesperrt, $aus verdaechtige Ziele nach aussen gesperrt, $wuerde nur gemeldet (Modus melden). Aktive IDS-Sperren: $aktiv. Haeufigste: ${top:-keine}. Suricata: $(systemctl is-active suricata)."
