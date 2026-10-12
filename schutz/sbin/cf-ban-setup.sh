#!/bin/bash
# ---------------------------------------------------------------------------
# cf-ban-setup.sh -- einmaliges Einrichten der Cloudflare-Sperre.
#
# Legt an:
#   1. eine Account-weite IP-Liste (Standardname: fail2ban_bans)
#   2. je Zone eine WAF-Custom-Rule  (ip.src in $fail2ban_bans) -> block
# und traegt Account- und Listen-ID in /etc/fail2ban/cloudflare.local nach.
# Teil des Schutz-Pakets des Linux Dashboards.
#
# Mehrfach ausfuehrbar: vorhandene Liste und vorhandene Regel werden erkannt
# und nicht doppelt angelegt.
#
# WICHTIG zur WAF-Regel: der Regelsatz-Endpunkt ersetzt beim PUT IMMER alle
# Regeln der Phase. Das Skript liest deshalb zuerst die bestehenden Regeln,
# haengt die eigene hinten an und schreibt die Gesamtliste zurueck -- sonst
# waeren vorhandene WAF-Regeln weg.
# ---------------------------------------------------------------------------
set -uo pipefail

CONF=/etc/fail2ban/cloudflare.local
API=https://api.cloudflare.com/client/v4
RULE_DESC="fail2ban automatische Sperre"

[ -r "$CONF" ] || { echo "FEHLER: $CONF nicht lesbar" >&2; exit 1; }
# shellcheck source=/dev/null
. "$CONF"

if [ -z "${CF_API_TOKEN:-}" ]; then
    cat >&2 <<'MSG'
FEHLER: In /etc/fail2ban/cloudflare.local ist CF_API_TOKEN noch leer.

Token anlegen: Cloudflare-Dashboard -> Profil -> API Tokens
               -> Create Token -> Create Custom Token
Berechtigungen: Account | Account Filter Lists | Edit
                Zone    | Zone WAF             | Edit
                Zone    | Zone                 | Read
MSG
    exit 1
fi

LIST_NAME=${CF_LIST_NAME:-fail2ban_bans}

cf() {
    local method=$1 path=$2 body=${3:-}
    if [ -n "$body" ]; then
        curl -sS --max-time 30 -X "$method" \
             -H "Authorization: Bearer $CF_API_TOKEN" \
             -H "Content-Type: application/json" \
             --data "$body" "$API$path"
    else
        curl -sS --max-time 30 -X "$method" \
             -H "Authorization: Bearer $CF_API_TOKEN" "$API$path"
    fi
}

die() { echo "FEHLER: $*" >&2; exit 1; }
ok()  { jq -e '.success == true' >/dev/null 2>&1 <<<"$1"; }

# --- Token pruefen ---------------------------------------------------------
# Cloudflare kennt zwei Sorten Token, und sie haben VERSCHIEDENE
# Pruefendpunkte. Ein nutzereigener Token wird an /user/tokens/verify
# geprueft; ein account-eigener (Praefix "cfat_") wird dort mit
# "Invalid API Token" abgelehnt und braucht /accounts/<id>/tokens/verify.
# Deshalb erst der eine, dann der andere - sonst haelt man einen voellig
# gueltigen Token faelschlich fuer kaputt.
echo "== Token pruefen"
r=$(cf GET /user/tokens/verify)
if ok "$r"; then
    echo "   Token gueltig (nutzereigen)."
elif [ -n "${CF_ACCOUNT_ID:-}" ]; then
    r=$(cf GET "/accounts/$CF_ACCOUNT_ID/tokens/verify")
    ok "$r" || die "Token ungueltig oder abgelaufen: $(jq -c '.errors' <<<"$r" 2>/dev/null || head -c 300 <<<"$r")"
    echo "   Token gueltig (account-eigen)."
else
    die "Token an /user/tokens/verify abgelehnt und keine CF_ACCOUNT_ID hinterlegt, um ihn als account-eigenen Token zu pruefen. Account-ID in $CONF eintragen."
fi

# --- Account-ID ------------------------------------------------------------
if [ -z "${CF_ACCOUNT_ID:-}" ]; then
    echo "== Account-ID ermitteln"
    r=$(cf GET "/accounts?per_page=50")
    ok "$r" || die "Accounts nicht lesbar: $(jq -c '.errors' <<<"$r")"
    n=$(jq '.result | length' <<<"$r")
    [ "$n" -ge 1 ] || die "kein Account sichtbar -- hat der Token 'Account Filter Lists: Edit'?"
    if [ "$n" -gt 1 ]; then
        echo "   Mehrere Accounts gefunden:"
        jq -r '.result[] | "     \(.id)  \(.name)"' <<<"$r"
        die "bitte die gewuenschte ID von Hand als CF_ACCOUNT_ID in $CONF eintragen"
    fi
    CF_ACCOUNT_ID=$(jq -r '.result[0].id' <<<"$r")
    echo "   Account: $CF_ACCOUNT_ID ($(jq -r '.result[0].name' <<<"$r"))"
fi

# --- IP-Liste anlegen oder wiederfinden ------------------------------------
echo "== IP-Liste '$LIST_NAME'"
r=$(cf GET "/accounts/$CF_ACCOUNT_ID/rules/lists")
ok "$r" || die "Listen nicht lesbar: $(jq -c '.errors' <<<"$r")"
CF_LIST_ID=$(jq -r --arg n "$LIST_NAME" '.result[]? | select(.name==$n) | .id' <<<"$r" | head -1)

if [ -n "$CF_LIST_ID" ] && [ "$CF_LIST_ID" != "null" ]; then
    echo "   existiert bereits: $CF_LIST_ID"
else
    body=$(jq -nc --arg n "$LIST_NAME" \
      '{name:$n, kind:"ip", description:"Von fail2ban gesperrte IPs (SSH, Mail, Web-Logins)"}')
    r=$(cf POST "/accounts/$CF_ACCOUNT_ID/rules/lists" "$body")
    ok "$r" || die "Liste nicht anlegbar: $(jq -c '.errors' <<<"$r")"
    CF_LIST_ID=$(jq -r '.result.id' <<<"$r")
    echo "   neu angelegt: $CF_LIST_ID"
fi

# --- IDs zurueckschreiben --------------------------------------------------
tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
sed -e "s|^CF_ACCOUNT_ID=.*|CF_ACCOUNT_ID=\"$CF_ACCOUNT_ID\"|" \
    -e "s|^CF_LIST_ID=.*|CF_LIST_ID=\"$CF_LIST_ID\"|" "$CONF" > "$tmp"
cat "$tmp" > "$CONF"
echo "   IDs in $CONF eingetragen."

# --- WAF-Regel je Zone -----------------------------------------------------
echo "== WAF-Sperr-Regel je Zone"
r=$(cf GET "/zones?per_page=50&account.id=$CF_ACCOUNT_ID")
ok "$r" || die "Zonen nicht lesbar -- hat der Token 'Zone: Read'? $(jq -c '.errors' <<<"$r")"

while read -r zid zname; do
    [ -n "$zid" ] || continue
    ep=$(cf GET "/zones/$zid/rulesets/phases/http_request_firewall_custom/entrypoint")
    if ok "$ep"; then
        existing=$(jq -c '[.result.rules[]? | {action,expression,description,enabled}]' <<<"$ep")
    else
        # Noch kein Regelsatz in dieser Phase -- dann eben mit leerer Liste starten.
        existing='[]'
    fi

    if jq -e --arg d "$RULE_DESC" 'any(.[]; .description==$d)' >/dev/null <<<"$existing"; then
        echo "   $zname: Regel bereits vorhanden -- unveraendert."
        continue
    fi

    # Hosts aus CF_AUSNAHME_HOSTS sind BEWUSST ausgenommen - vor allem der
    # ntfy-Server. Ohne Ausnahme sperrt die Regel den Gebannten auch von ntfy
    # aus, und damit ausgerechnet von der Meldung ueber seine Sperre (real
    # passiert: das Handy bekam den APNs-Anstoss, konnte die Nachricht aber
    # nicht abholen, die Meldung fehlte spurlos).
    # Preis: der ausgenommene Host ist nicht mehr am Rand sperrbar.
    expr="(ip.src in \$$LIST_NAME"
    for h in ${CF_AUSNAHME_HOSTS:-}; do
        case "$h" in *[!A-Za-z0-9.-]*) echo "   ungueltiger Hostname in CF_AUSNAHME_HOSTS: $h" >&2; continue ;; esac
        expr="$expr and http.host ne \"$h\""
    done
    expr="$expr)"
    merged=$(jq -c --arg d "$RULE_DESC" --arg e "$expr" \
        '. + [{action:"block", expression:$e, description:$d, enabled:true}]' \
        <<<"$existing")
    body=$(jq -nc --argjson rules "$merged" '{rules:$rules}')
    w=$(cf PUT "/zones/$zid/rulesets/phases/http_request_firewall_custom/entrypoint" "$body")
    if ok "$w"; then
        n_before=$(jq 'length' <<<"$existing")
        echo "   $zname: Regel angelegt (bestehende Regeln erhalten: $n_before)."
    else
        echo "   $zname: FEHLER -- $(jq -c '.errors' <<<"$w")" >&2
    fi
done < <(jq -r '.result[] | "\(.id) \(.name)"' <<<"$r")

echo
echo "Fertig. Testsperre:   /usr/local/sbin/cf-ban.sh add 203.0.113.5 test"
echo "        wieder frei:  /usr/local/sbin/cf-ban.sh del 203.0.113.5"
echo "        Protokoll:    /var/log/webauth/cf-ban.log"
