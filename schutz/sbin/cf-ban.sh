#!/bin/bash
# ---------------------------------------------------------------------------
# cf-ban.sh -- traegt von fail2ban gebannte IPs in eine Cloudflare-IP-Liste ein
#              bzw. wieder aus.
#
# WARUM DAS NOETIG IST
# Web-Apps hinter einem Cloudflare-Tunnel/-Proxy: die Pakete des Angreifers
# erreichen den Host nie mit seiner eigenen Adresse -- sie kommen vom
# cloudflared-Container bzw. von Cloudflare. Ein iptables-/ipset-Ban auf die
# echte Client-IP laeuft deshalb ins Leere. Gesperrt werden kann nur am
# Cloudflare-Rand. Die echte IP steht im Header CF-Connecting-IP; die Apps
# muessen sie loggen. Dieses Skript sperrt sie dann per API.
#
# Teil des Schutz-Pakets des Linux Dashboards (Datei gehoert dem Paket).
#
# Aufruf:  cf-ban.sh add <ip> [jail]
#          cf-ban.sh del <ip>
#
# Alles ist idempotent und schlaegt NIE hart fehl: ein Ausfall der
# Cloudflare-API darf den fail2ban-Ban nicht als fehlgeschlagen markieren.
# ---------------------------------------------------------------------------
set -uo pipefail

CONF=/etc/fail2ban/cloudflare.local
LOG=/var/log/webauth/cf-ban.log
API=https://api.cloudflare.com/client/v4

mkdir -p "${LOG%/*}" 2>/dev/null
log() { printf '%s cf-ban[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$$" "$*" >> "$LOG"; }

# Ohne Konfiguration ist die Cloudflare-Sperre schlicht nicht eingerichtet.
[ -r "$CONF" ] || exit 0
# shellcheck source=/dev/null
. "$CONF"

ACTION=${1:-}; IP=${2:-}; JAIL=${3:-unbekannt}

[ -n "$IP" ] || { log "FEHLER: keine IP uebergeben"; exit 0; }

# Nur eine echte Adresse darf weiter: die IP landet in einem JSON-Body und in
# einer URL. fail2ban liefert zwar immer eine gepruefte Adresse, aber das
# Skript wird auch von Hand (webauth-unban.sh) aufgerufen.
# IPv6 wird als /64 gesperrt: ein Anschluss hat in aller Regel ein ganzes
# /64, und ein Angreifer koennte sonst fuer jeden Versuch eine neue Adresse
# aus demselben Netz nehmen -- die Sperre waere wirkungslos. IPv4 bleibt eine
# Einzeladresse (ein /24 traefe hunderte Unbeteiligte).
IP=$(python3 - "$IP" <<'PY' 2>/dev/null
import ipaddress, sys
a = ipaddress.ip_address(sys.argv[1].strip())
print(ipaddress.ip_network(f"{a}/64", strict=False) if a.version == 6 else a)
PY
)
[ -n "$IP" ] || { log "FEHLER: '${2}' ist keine gueltige IP-Adresse"; exit 0; }

# Kein Token = Cloudflare-Sperre bewusst nicht genutzt: still beenden.
[ -n "${CF_API_TOKEN:-}" ] || exit 0
if [ -z "${CF_ACCOUNT_ID:-}" ] || [ -z "${CF_LIST_ID:-}" ]; then
    log "UNTAETIG ($ACTION $IP): CF_ACCOUNT_ID/CF_LIST_ID fehlen -- /usr/local/sbin/cf-ban-setup.sh ausfuehren."
    exit 0
fi

cf() {
    # cf <METHODE> <PFAD> [BODY]
    local method=$1 path=$2 body=${3:-}
    if [ -n "$body" ]; then
        curl -sS --max-time 20 -X "$method" \
             -H "Authorization: Bearer $CF_API_TOKEN" \
             -H "Content-Type: application/json" \
             --data "$body" "$API$path"
    else
        curl -sS --max-time 20 -X "$method" \
             -H "Authorization: Bearer $CF_API_TOKEN" \
             "$API$path"
    fi
}

# Cloudflare antwortet EINGERUECKT ("success": true mit Leerzeichen). Ein
# grep auf '"success":true' geht deshalb immer daneben - eine geglueckte
# Sperre sah dadurch wie ein Fehler aus, und beim Entsperren scheiterte auf
# dieselbe Weise das Auslesen der Item-ID. Deswegen hier durchgaengig jq.
ok() { jq -e '.success == true' >/dev/null 2>&1 <<<"$1"; }

ITEMS="/accounts/$CF_ACCOUNT_ID/rules/lists/$CF_LIST_ID/items"

case "$ACTION" in
  add)
    body=$(printf '[{"ip":"%s","comment":"fail2ban %s @ %s %s"}]' \
           "$IP" "$(tr -cd 'A-Za-z0-9._-' <<<"$JAIL")" "$(hostname)" "$(date '+%Y-%m-%d %H:%M:%S')")
    resp=$(cf POST "$ITEMS" "$body")
    if ok "$resp"; then
        log "GESPERRT $IP (jail=$JAIL) in Cloudflare-Liste ${CF_LIST_NAME:-}"
    else
        log "FEHLER beim Sperren von $IP (jail=$JAIL): $(jq -c '.errors' <<<"$resp" 2>/dev/null || head -c 300 <<<"$resp" | tr -d '\n')"
    fi
    ;;
  del)
    # Dauersperre schuetzen: laeuft die Kurzsperre einer Web-Jail
    # ab, deren IP inzwischen in dauersperre-web steckt, darf der Eintrag am
    # Rand NICHT verschwinden. Freigeben duerfen nur dauersperre-web selbst
    # und webauth-unban.sh ("manuell", entsperrt vorher alle Jails).
    # Ausgabe erst einlesen: mit pipefail koennte "| grep -q" per SIGPIPE
    # faelschlich "nicht gesperrt" ergeben.
    perm_jails=$(fail2ban-client banned "${2}" 2>/dev/null)
    if [ "$JAIL" != "manuell" ] && [ "$JAIL" != "dauersperre-web" ] && \
       [[ "$perm_jails" == *"'dauersperre-web'"* ]]; then
        log "ENTSPERREN $IP (jail=$JAIL) uebersprungen: IP ist dauerhaft gesperrt (dauersperre-web)"
        exit 0
    fi
    # Zum Loeschen braucht die API die Item-ID, nicht die IP -- also erst
    # suchen. `search` filtert serverseitig, damit auch grosse Listen nicht
    # seitenweise durchgeblaettert werden muessen.
    found=$(cf GET "$ITEMS?per_page=500&search=${IP%%/*}")
    id=$(jq -r --arg ip "$IP" '.result[]? | select(.ip == $ip) | .id' <<<"$found" 2>/dev/null | head -1)
    if [ -z "$id" ]; then
        log "ENTSPERREN $IP: kein Listeneintrag gefunden (bereits entfernt?)"
        exit 0
    fi
    resp=$(cf DELETE "$ITEMS" "$(printf '{"items":[{"id":"%s"}]}' "$id")")
    if ok "$resp"; then
        log "ENTSPERRT $IP aus Cloudflare-Liste ${CF_LIST_NAME:-}"
    else
        log "FEHLER beim Entsperren von $IP: $(jq -c '.errors' <<<"$resp" 2>/dev/null || head -c 300 <<<"$resp" | tr -d '\n')"
    fi
    ;;
  *)
    log "FEHLER: unbekannte Aktion '$ACTION' (erwartet: add|del)"
    ;;
esac
exit 0
