#!/bin/bash
# ids-push.sh <Titel> <Prioritaet> <Text> -- ntfy-Push fuer den IDS-Waechter.
# Duenner Wrapper um waechter-push (Zugangsdaten in waechter.conf).
# Kehrt immer mit 0 zurueck, damit fail2ban einen Ban nie als gescheitert sieht.
/usr/local/sbin/waechter-push -t "shield,rotating_light" "${1:-IDS}" "${2:-high}" "${3:-}"
exit 0
