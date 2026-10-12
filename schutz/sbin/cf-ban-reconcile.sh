#!/bin/bash
# ---------------------------------------------------------------------------
# cf-ban-reconcile.sh -- gleicht die Cloudflare-IP-Liste mit fail2ban ab
#
# WARUM
# cf-ban.sh laeuft pro Ban/Unban genau einmal und wiederholt nichts. Scheitert
# das Entsperren (Cloudflare-Ratelimit 10040, API kurz weg, Neustart mitten
# im Vorgang), bleibt der Eintrag in der Liste -- und die Adresse ist am Rand
# DAUERHAFT gesperrt, obwohl fail2ban sie laengst freigegeben hat. Umgekehrt
# kann ein Ban fehlen, wenn das Sperren fehlschlug.
#
# Dieses Skript stellt beide Richtungen wieder her:
#   - Listeneintrag, den KEINE Jail mehr sperrt  -> aus der Liste entfernen
#   - Jail-Ban einer Web-/Mail-Jail ohne Eintrag  -> in die Liste eintragen
# Es fasst nur Eintraege an, die cf-ban.sh angelegt hat (Kommentar beginnt
# mit "fail2ban"), damit von Hand gepflegte Eintraege unangetastet bleiben.
#
# Laeuft alle 15 Minuten ueber cf-ban-reconcile.timer. Teil des Schutz-Pakets des Linux Dashboards.
# ---------------------------------------------------------------------------
set -uo pipefail
CONF=/etc/fail2ban/cloudflare.local
LOG=/var/log/webauth/cf-ban.log
API=https://api.cloudflare.com/client/v4
mkdir -p "${LOG%/*}" 2>/dev/null
log() { printf '%s cf-reconcile[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$$" "$*" >> "$LOG"; }

. "$CONF" 2>/dev/null || exit 0
[ -n "${CF_API_TOKEN:-}" ] && [ -n "${CF_ACCOUNT_ID:-}" ] && [ -n "${CF_LIST_ID:-}" ] || exit 0
systemctl is-active --quiet fail2ban || { log "fail2ban laeuft nicht -- kein Abgleich"; exit 0; }

ITEMS="/accounts/$CF_ACCOUNT_ID/rules/lists/$CF_LIST_ID/items"
liste=$(curl -sS --max-time 20 -H "Authorization: Bearer $CF_API_TOKEN" "$API$ITEMS?per_page=500")
jq -e '.success == true' >/dev/null 2>&1 <<<"$liste" || { log "Liste nicht abrufbar: $(jq -c '.errors' <<<"$liste" 2>/dev/null | head -c 200)"; exit 0; }

# Alle aktuell gesperrten Adressen aller Jails, die cf-block benutzen --
# in derselben Form, in der cf-ban.sh sie eintraegt (IPv6 als /64).
gebannt=$(python3 - <<'PY'
import ast, ipaddress, subprocess
raw = subprocess.run(["fail2ban-client", "banned"], capture_output=True, text=True).stdout
try:
    daten = ast.literal_eval(raw.strip())
except Exception:
    raise SystemExit(0)
mit_cf = set()
for eintrag in daten:
    for jail, ips in eintrag.items():
        akt = subprocess.run(["fail2ban-client", "get", jail, "actions"], capture_output=True, text=True).stdout
        if "cf-block" not in akt:
            continue
        for ip in ips:
            try:
                a = ipaddress.ip_address(ip)
            except ValueError:
                continue
            mit_cf.add(str(ipaddress.ip_network(f"{a}/64", strict=False)) if a.version == 6 else str(a))
print("\n".join(sorted(mit_cf)))
PY
)

entfernt=0; ergaenzt=0
# 1) Verwaiste Eintraege loeschen
while IFS=$'\t' read -r id ip kommentar; do
    [ -n "$id" ] || continue
    case "$kommentar" in fail2ban*) ;; *) continue ;; esac
    grep -qxF "$ip" <<<"$gebannt" && continue
    resp=$(curl -sS --max-time 20 -X DELETE -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
           --data "{\"items\":[{\"id\":\"$id\"}]}" "$API$ITEMS")
    if jq -e '.success == true' >/dev/null 2>&1 <<<"$resp"; then
        log "VERWAIST entfernt: $ip ($kommentar)"; entfernt=$((entfernt+1))
    else
        log "FEHLER beim Entfernen von $ip: $(jq -c '.errors' <<<"$resp" 2>/dev/null | head -c 200)"
    fi
    sleep 1   # Ratelimit der Listen-API schonen
done < <(jq -r '.result[]? | [.id, .ip, (.comment // "")] | @tsv' <<<"$liste")

# 2) Fehlende Eintraege nachtragen
while read -r ip; do
    [ -n "$ip" ] || continue
    jq -e --arg ip "$ip" '.result[]? | select(.ip == $ip)' >/dev/null 2>&1 <<<"$liste" && continue
    /usr/local/sbin/cf-ban.sh add "${ip%%/*}" reconcile
    log "FEHLEND nachgetragen: $ip"; ergaenzt=$((ergaenzt+1))
    sleep 1
done <<<"$gebannt"

[ $entfernt -eq 0 ] && [ $ergaenzt -eq 0 ] || log "Abgleich fertig: $entfernt entfernt, $ergaenzt ergaenzt"
exit 0
