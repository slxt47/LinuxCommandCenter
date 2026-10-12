#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# install-schutz.sh -- Schutz-Paket des Linux Dashboards installieren/updaten
#   fail2ban (SSH, Dashboard-Login, optional Mail/Web-Apps, Dauersperre)
#   IDS-Waechter (Suricata passiv -> ids-watch -> fail2ban -> ipset)
#   Firewall-Sperrlisten (ipsets in eigenen Ketten, rein additiv)
#   Cloudflare-Rand-Sperre nur optional (CLOUDFLARE=1)
#
# Normalerweise ruft ../install.sh dieses Skript auf. Es laeuft auch allein:
#
#   sudo ./install-schutz.sh                 installieren bzw. updaten
#   sudo ./install-schutz.sh --ja            ohne Rueckfragen (Standardwerte)
#   sudo ./install-schutz.sh --anwenden      schutz.conf neu anwenden (= waechter config-anwenden)
#   sudo ./install-schutz.sh --deinstallieren [--alles]
#
# Optionen fuer die Erstinstallation (sonst wird gefragt):
#   --trusted "IP ..."        eigene Anschluesse, werden nie gesperrt
#   --ohne-ids                nur fail2ban + Firewall, kein Suricata
#   --ids-modus melden|sperren
#   --ntfy-url URL --ntfy-topic TOPIC [--ntfy-token TOKEN]
#   --cloudflare              Web-Apps liegen hinter Cloudflare (optional)
#   --firewall eigen|aus      eigene Ketten (Standard) oder nur ipsets
#   --ohne-dashboard-jail     Dashboard laeuft nicht auf diesem Server
#   --uebernehmen             manuell eingerichtete Vorversion uebernehmen
#   --force                   auch aelteres Paket ueber neueres installieren
#
# Update-Regeln: Dateien des Pakets werden ersetzt (Sicherung unter
# /var/backups/linux-dashboard-schutz/<zeit>/), DEINE Dateien nie:
#   /etc/linux-dashboard/schutz.conf, /etc/ids-watch.conf, /etc/ids-watch.whitelist,
#   /etc/linux-dashboard/blk_net4.txt, /etc/fail2ban/jail.d/waechter.local,
#   /etc/fail2ban/cloudflare.local
# Neue Schluessel werden an diese Dateien nur angehaengt.
# ---------------------------------------------------------------------------
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHARE=/usr/local/share/linux-dashboard-schutz
ETC=/etc/linux-dashboard
CONF=$ETC/schutz.conf
VERFILE=$ETC/schutz-version
MANIFEST=$SHARE/manifest
SBIN=/usr/local/sbin
F2B=/etc/fail2ban
SYSD=/etc/systemd/system
TS=$(date +%Y%m%d-%H%M%S)
BACKUP=/var/backups/linux-dashboard-schutz/$TS

if [ -f "$SRC/../VERSION" ]; then VERSION=$(cat "$SRC/../VERSION")
elif [ -f "$SRC/VERSION" ]; then VERSION=$(cat "$SRC/VERSION")
else VERSION=0.0.0; fi

MODE=install; JA=0; FORCE=0; UEBERNEHMEN=0; ALLES=0
OPT_TRUSTED=""; OPT_IDS=""; OPT_MODUS=""; OPT_NTFY_URL=""; OPT_NTFY_TOPIC=""
OPT_NTFY_TOKEN=""; OPT_CF=""; OPT_FW=""; OPT_DASHJAIL=""
while [ $# -gt 0 ]; do
    case "$1" in
        --ja|-y)              JA=1 ;;
        --anwenden)           MODE=anwenden ;;
        --deinstallieren)     MODE=deinstallieren ;;
        --alles)              ALLES=1 ;;
        --force)              FORCE=1 ;;
        --uebernehmen)        UEBERNEHMEN=1 ;;
        --trusted)            OPT_TRUSTED=$2; shift ;;
        --ohne-ids)           OPT_IDS=0 ;;
        --ids-modus)          OPT_MODUS=$2; shift ;;
        --ntfy-url)           OPT_NTFY_URL=$2; shift ;;
        --ntfy-topic)         OPT_NTFY_TOPIC=$2; shift ;;
        --ntfy-token)         OPT_NTFY_TOKEN=$2; shift ;;
        --cloudflare)         OPT_CF=1 ;;
        --firewall)           OPT_FW=$2; shift ;;
        --ohne-dashboard-jail) OPT_DASHJAIL=false ;;
        -h|--help)            sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unbekannte Option: $1" >&2; exit 1 ;;
    esac
    shift
done

log()  { printf '\033[1;32m[schutz]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[schutz]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[schutz]\033[0m %s\n' "$*" >&2; }
frage() {   # frage <text> <standard> -> Antwort auf stdout
    local a=""
    if [ $JA -eq 0 ] && [ -t 0 ]; then
        read -r -p "$1 [$2]: " a </dev/tty || true
    fi
    printf '%s' "${a:-$2}"
}
ver_lt() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" = "$1" ]; }
setze() {   # setze <datei> <KEY> <wert>   (KEY="wert", vorhandene Zeile ersetzen)
    local f=$1 k=$2 v=$3
    v=${v//\\/\\\\}; v=${v//&/\\&}; v=${v//|/\\|}
    if grep -q "^$k=" "$f"; then sed -i "s|^$k=.*|$k=\"$v\"|" "$f"
    else printf '%s="%s"\n' "$k" "$3" >> "$f"; fi
}
cget() { python3 "$SRC/lib/schutz.py" get "$1"; }

[ "$(id -u)" -eq 0 ] || { err "Bitte als root ausfuehren (sudo)."; exit 1; }
command -v systemctl >/dev/null || { err "systemd wird benoetigt."; exit 1; }
command -v apt-get >/dev/null || { err "Nur Debian/Ubuntu (apt) werden unterstuetzt."; exit 1; }

# ===========================================================================
# Deinstallation
# ===========================================================================
if [ "$MODE" = deinstallieren ]; then
    log "Deinstalliere Schutz-Paket ..."
    for u in ids-gesundheit.timer ids-tagesbericht.timer suricata-update-waechter.timer \
             cf-ban-reconcile.timer ids-watch.service; do
        systemctl disable --now "$u" 2>/dev/null || true
    done
    if [ -f $SYSD/suricata.service.d/waechter.conf ]; then
        systemctl disable --now suricata 2>/dev/null || true
    fi
    [ -x $SBIN/waechter-firewall.sh ] && $SBIN/waechter-firewall.sh --stop >/dev/null 2>&1 || true
    systemctl disable waechter-firewall.service 2>/dev/null || true
    if [ -f "$MANIFEST" ]; then
        while read -r f; do [ -n "$f" ] && rm -f "$f"; done < "$MANIFEST"
    fi
    systemctl daemon-reload
    systemctl reload-or-restart fail2ban 2>/dev/null || true
    for s in ids_ban4 ids_ban6 ssh_ban4 ssh_ban6 perm_ban4 perm_ban6 f2b_long4 f2b_long6 f2b_net4 blk_net4; do
        ipset destroy "$s" 2>/dev/null || true     # scheitert still, solange eine fremde Regel es nutzt
    done
    rm -rf "$SHARE" "$VERFILE"
    if [ $ALLES -eq 1 ]; then
        rm -f "$CONF" "$ETC/schutz-netze.generiert" "$ETC/blk_net4.txt" /etc/ids-watch.conf \
              /etc/ids-watch.whitelist $F2B/jail.d/waechter.local
        log "Konfiguration entfernt."
    else
        log "Konfiguration bleibt erhalten ($CONF, /etc/ids-watch.conf, $F2B/jail.d/waechter.local)."
    fi
    log "Fertig. Pakete (fail2ban, suricata) bleiben installiert: apt purge suricata"
    exit 0
fi

# ===========================================================================
# Zustand ermitteln
# ===========================================================================
INSTALLIERT=$(cat "$VERFILE" 2>/dev/null || true)
ALTBESTAND=0
if [ -z "$INSTALLIERT" ] && [ ! -f "$MANIFEST" ] && { [ -f $SBIN/ids-watch.py ] || [ -f $F2B/action.d/audit-ipset.conf ]; }; then
    ALTBESTAND=1
fi

if [ "$MODE" = anwenden ]; then
    [ -n "$INSTALLIERT" ] || { err "Schutz-Paket ist nicht installiert."; exit 1; }
    log "Wende $CONF an ..."
elif [ $ALTBESTAND -eq 1 ] && [ $UEBERNEHMEN -eq 0 ]; then
    err "Auf diesem Server ist bereits ein manuell eingerichteter Waechter (fail2ban/IDS) vorhanden,"
    err "der nicht aus diesem Paket stammt (z. B. $SBIN/ids-watch.py)."
    err "Uebernehmen mit:  ./install.sh --uebernehmen   (bzw. schutz/install-schutz.sh --uebernehmen)"
    err "Dabei werden Paket-Dateien mit gleichem Namen ersetzt (Sicherung in /var/backups/linux-dashboard-schutz/),"
    err "eigene Jail-Dateien in $F2B/jail.d/ bleiben unveraendert und gelten weiter."
    exit 2
elif [ -n "$INSTALLIERT" ] && ver_lt "$VERSION" "$INSTALLIERT" && [ $FORCE -eq 0 ]; then
    err "Installiert ist $INSTALLIERT, dieses Paket ist aelter ($VERSION). Abbruch (--force zum Erzwingen)."
    exit 1
elif [ -n "$INSTALLIERT" ]; then
    log "Update $INSTALLIERT -> $VERSION"
elif [ $ALTBESTAND -eq 1 ]; then
    log "Uebernahme der manuell eingerichteten Vorversion -> $VERSION"
else
    log "Erstinstallation $VERSION"
fi

# ===========================================================================
# Konfiguration (schutz.conf)
# ===========================================================================
mkdir -p "$ETC"; chmod 755 "$ETC"
NEU_CONF=0
if [ ! -f "$CONF" ]; then
    NEU_CONF=1
    install -m 600 "$SRC/config/schutz.conf.example" "$CONF"
    if [ $ALTBESTAND -eq 1 ]; then
        log "Uebernehme Werte aus der Vorversion:"
        while IFS='=' read -r k v; do
            v=${v#\"}; v=${v%\"}
            setze "$CONF" "$k" "$v"
            case "$k" in NTFY_TOKEN) echo "    $k=***" ;; *) echo "    $k=$v" ;; esac
        done < <(python3 "$SRC/lib/schutz.py" altbestand)
    fi
    # --- Rueckfragen / Optionen ---------------------------------------------
    t_def=$(sed -n 's/^TRUSTED_IPS="\(.*\)"/\1/p' "$CONF")
    if [ -z "$t_def" ] && [ -n "${SSH_CLIENT:-}" ]; then t_def=${SSH_CLIENT%% *}; fi
    [ -n "${SUDO_USER:-}" ] && [ -z "$t_def" ] && t_def=$(who am i 2>/dev/null | sed -n 's/.*(\([0-9a-fA-F.:]*\)).*/\1/p')
    if [ -n "$OPT_TRUSTED" ]; then t=$OPT_TRUSTED
    else
        echo
        echo "Eigene Anschluesse (Admin-IPs) werden NIE gesperrt. Wichtig: ein einziger"
        echo "ungueltiger SSH-Login sperrt sonst fuer eine Woche (Tailscale/LAN sind immer frei)."
        t=$(frage "Eigene IPs/Netze (Leerzeichen-getrennt, leer = keine)" "$t_def")
    fi
    setze "$CONF" TRUSTED_IPS "$t"

    if [ -n "$OPT_IDS" ]; then ids=$OPT_IDS
    else
        cur=$(sed -n 's/^IDS_AKTIV="\(.*\)"/\1/p' "$CONF")
        a=$(frage "IDS-Waechter (Suricata) installieren? Braucht ~1-2 GB RAM (j/n)" "$([ "$cur" = 0 ] && echo n || echo j)")
        case "$a" in n*|N*) ids=0 ;; *) ids=1 ;; esac
    fi
    setze "$CONF" IDS_AKTIV "$ids"

    [ -n "$OPT_CF" ] && setze "$CONF" CLOUDFLARE 1
    [ -n "$OPT_FW" ] && setze "$CONF" FIREWALL "$OPT_FW"
    [ -n "$OPT_DASHJAIL" ] && setze "$CONF" DASHBOARD_JAIL "$OPT_DASHJAIL"

    if [ -n "$OPT_NTFY_URL" ]; then
        setze "$CONF" NTFY_URL "$OPT_NTFY_URL"; setze "$CONF" NTFY_TOPIC "$OPT_NTFY_TOPIC"
        setze "$CONF" NTFY_TOKEN "$OPT_NTFY_TOKEN"
    elif ! grep -q '^NTFY_URL="[a-z]' "$CONF"; then
        u=$(frage "ntfy-Server fuer Push-Meldungen (z. B. https://ntfy.sh, leer = keine Pushes)" "")
        if [ -n "$u" ]; then
            setze "$CONF" NTFY_URL "$u"
            setze "$CONF" NTFY_TOPIC "$(frage "ntfy-Topic" "server-$(hostname -s)")"
            setze "$CONF" NTFY_TOKEN "$(frage "ntfy-Zugangstoken (leer = ohne)" "")"
        fi
    fi
else
    python3 "$SRC/lib/schutz.py" conf-merge "$SRC/config/schutz.conf.example" "$CONF"
    [ -n "$OPT_DASHJAIL" ] && setze "$CONF" DASHBOARD_JAIL "$OPT_DASHJAIL"
fi
chmod 600 "$CONF"

IDS=$(cget IDS_AKTIV); CF=$(cget CLOUDFLARE); FW=$(cget FIREWALL)

# ===========================================================================
# Pakete
# ===========================================================================
if [ "$MODE" != anwenden ]; then
    export DEBIAN_FRONTEND=noninteractive
    OS_ID=$(. /etc/os-release; echo "${ID:-}")   # nicht global sourcen: setzt sonst $VERSION
    PKGS="fail2ban ipset iptables jq curl python3 python3-yaml python3-systemd conntrack"
    if [ "$IDS" = 1 ] && ! command -v suricata >/dev/null; then
        if [ "$OS_ID" = ubuntu ] && [ "$(cget SURICATA_PPA)" = 1 ]; then
            log "Fuege OISF-PPA fuer aktuelles Suricata hinzu ..."
            apt-get update -qq
            apt-get install -y -qq software-properties-common >/dev/null
            add-apt-repository -y ppa:oisf/suricata-stable >/dev/null
        fi
        SURICATA_NOETIG=1
    fi
    log "Installiere Pakete: $PKGS${SURICATA_NOETIG:+ suricata}"
    apt-get update -qq
    # shellcheck disable=SC2086
    apt-get install -y -qq $PKGS >/dev/null
    if [ -n "${SURICATA_NOETIG:-}" ]; then
        if apt-cache policy suricata 2>/dev/null | grep -q 'Candidate: [0-9]'; then
            apt-get install -y -qq suricata >/dev/null
        elif [ "$OS_ID" = debian ]; then
            # Debian 12: Suricata gibt es nur in den Backports
            CODENAME=$(. /etc/os-release; echo "$VERSION_CODENAME")
            log "Suricata aus ${CODENAME}-backports ..."
            echo "deb http://deb.debian.org/debian ${CODENAME}-backports main" \
                > /etc/apt/sources.list.d/linux-dashboard-backports.list
            apt-get update -qq
            apt-get install -y -qq -t "${CODENAME}-backports" suricata >/dev/null
        else
            err "Suricata ist fuer dieses System nicht verfuegbar - IDS mit --ohne-ids abschalten."
            exit 1
        fi
    fi
    if [ "$IDS" = 1 ] && ! command -v suricata-update >/dev/null; then
        apt-get install -y -qq suricata-update >/dev/null || warn "suricata-update nicht installierbar"
    fi
fi

# ===========================================================================
# Weitere Konfigurationsdateien (gehoeren dem Benutzer, nur anlegen/ergaenzen)
# ===========================================================================
anlegen() {   # anlegen <beispiel> <ziel> <modus>
    if [ ! -f "$2" ]; then install -m "$3" "$1" "$2"; log "angelegt: $2"
    else python3 "$SRC/lib/schutz.py" conf-merge "$1" "$2"; fi
}
anlegen "$SRC/config/blk_net4.txt.example" "$ETC/blk_net4.txt" 644
if [ ! -f $F2B/jail.d/waechter.local ]; then
    install -m 644 "$SRC/config/jail-waechter.local.example" $F2B/jail.d/waechter.local
fi
if [ "$IDS" = 1 ]; then
    if [ ! -f /etc/ids-watch.conf ]; then
        install -m 644 "$SRC/config/ids-watch.conf.example" /etc/ids-watch.conf
        m=$OPT_MODUS
        if [ -z "$m" ]; then
            echo
            echo "IDS-Modus: 'melden' protokolliert nur, was gesperrt wuerde (empfohlen fuer die"
            echo "ersten Tage), 'sperren' sperrt Angreifer und boesartige Ziele sofort."
            m=$(frage "IDS-Modus (melden/sperren)" "melden")
        fi
        case "$m" in sperren) ;; *) m=melden ;; esac
        sed -i "s/^MODUS=.*/MODUS=$m/" /etc/ids-watch.conf
        log "IDS-Modus: $m (spaeter: waechter ids-modus sperren)"
    else
        python3 "$SRC/lib/schutz.py" conf-merge "$SRC/config/ids-watch.conf.example" /etc/ids-watch.conf
        if [ $ALTBESTAND -eq 1 ]; then
            while IFS='=' read -r k v; do
                [ -n "$k" ] || continue
                sed -i "s|^$k=.*|$k=$v|" /etc/ids-watch.conf
                log "Altbestand: $k=$v (ids-watch.conf)"
            done < <(python3 "$SRC/lib/schutz.py" altbestand-ids)
        fi
    fi
    [ -f /etc/ids-watch.whitelist ] || install -m 644 "$SRC/config/ids-watch.whitelist.example" /etc/ids-watch.whitelist
fi
if [ "$CF" = 1 ] && [ ! -f $F2B/cloudflare.local ]; then
    install -m 600 "$SRC/config/cloudflare.local.example" $F2B/cloudflare.local
    warn "Cloudflare: Token in $F2B/cloudflare.local eintragen, dann $SBIN/cf-ban-setup.sh ausfuehren."
fi

# ===========================================================================
# Netze berechnen
# ===========================================================================
log "Netze:"
python3 "$SRC/lib/schutz.py" netze

# ===========================================================================
# Paket-Dateien installieren (mit Sicherung und Manifest)
# ===========================================================================
mkdir -p "$SHARE"
NEUES_MANIFEST=$(mktemp)
sichern() {
    if [ -e "$1" ]; then
        mkdir -p "$BACKUP$(dirname "$1")"
        cp -a "$1" "$BACKUP$1"
    fi
}
inst() {    # inst <quelle> <ziel> <modus>
    if [ -e "$2" ] && cmp -s "$1" "$2"; then
        chmod "$3" "$2"
    else
        sichern "$2"
        install -D -m "$3" "$1" "$2"
    fi
    echo "$2" >> "$NEUES_MANIFEST"
}
render() {  # render <vorlage> <ziel> <modus>
    local tmp; tmp=$(mktemp)
    python3 "$SRC/lib/schutz.py" render "$1" "$tmp"
    inst "$tmp" "$2" "$3"
    rm -f "$tmp"
}

# Skripte
for f in waechter waechter-push waechter-firewall.sh webauth-unban.sh f2b-dauersperre-notify.sh \
         ids-push.sh gen-suricata-ids-yaml.py; do
    inst "$SRC/sbin/$f" "$SBIN/$f" 750
done
if [ "$IDS" = 1 ]; then
    for f in ids-watch.py ids-gesundheit.py ids-tagesbericht.sh; do inst "$SRC/sbin/$f" "$SBIN/$f" 750; done
fi
if [ "$CF" = 1 ]; then
    for f in cf-ban.sh cf-ban-reconcile.sh cf-ban-setup.sh; do inst "$SRC/sbin/$f" "$SBIN/$f" 700; done
fi

# fail2ban
for f in "$SRC"/fail2ban/action.d/*.conf; do
    b=$(basename "$f")
    [ "$b" = cf-block.conf ] && [ "$CF" != 1 ] && continue
    inst "$f" "$F2B/action.d/$b" 644
done
for f in "$SRC"/fail2ban/filter.d/*.conf; do inst "$f" "$F2B/filter.d/$(basename "$f")" 644; done
render "$SRC/fail2ban/filter.d/mail-subnet24.conf.in" "$F2B/filter.d/mail-subnet24.conf" 644
render "$SRC/fail2ban/jail.d/waechter.conf.in" "$F2B/jail.d/waechter.conf" 644
render "$SRC/fail2ban/fail2ban.d/waechter.conf.in" "$F2B/fail2ban.d/waechter.conf" 644

# systemd + logrotate
inst "$SRC/systemd/waechter-firewall.service" "$SYSD/waechter-firewall.service" 644
if [ "$IDS" = 1 ]; then
    for u in ids-watch.service ids-gesundheit.service ids-gesundheit.timer ids-tagesbericht.service \
             ids-tagesbericht.timer suricata-update-waechter.service suricata-update-waechter.timer; do
        inst "$SRC/systemd/$u" "$SYSD/$u" 644
    done
    render "$SRC/systemd/suricata-waechter.conf.in" "$SYSD/suricata.service.d/waechter.conf" 644
    if [ ! -f /etc/logrotate.d/suricata ]; then
        inst "$SRC/logrotate/suricata-waechter" /etc/logrotate.d/suricata-waechter 644
    fi
fi
if [ "$CF" = 1 ]; then
    for u in cf-ban-reconcile.service cf-ban-reconcile.timer; do inst "$SRC/systemd/$u" "$SYSD/$u" 644; done
fi
inst "$SRC/logrotate/linux-dashboard-schutz" /etc/logrotate.d/linux-dashboard-schutz 644

# Altbestand: Dateien der manuellen Vorversion, die durch Paket-Dateien mit
# anderem Namen ersetzt werden, sichern und stilllegen.
if [ $ALTBESTAND -eq 1 ] && [ "$MODE" != anwenden ]; then
    if [ -f $SYSD/suricata.service.d/ids.conf ]; then
        sichern $SYSD/suricata.service.d/ids.conf; rm -f $SYSD/suricata.service.d/ids.conf
        log "Altbestand: suricata-Drop-in ids.conf ersetzt durch waechter.conf"
    fi
    if [ -f $SYSD/suricata-update.timer ] && [ "$IDS" = 1 ]; then
        systemctl disable --now suricata-update.timer 2>/dev/null || true
        sichern $SYSD/suricata-update.timer; sichern $SYSD/suricata-update.service
        rm -f $SYSD/suricata-update.timer $SYSD/suricata-update.service
        log "Altbestand: suricata-update.timer ersetzt durch suricata-update-waechter.timer"
    fi
    if [ -f /etc/logrotate.d/ids-watch ]; then
        sichern /etc/logrotate.d/ids-watch; rm -f /etc/logrotate.d/ids-watch
    fi
fi

# Dateien, die frueher zum Paket gehoerten und jetzt nicht mehr: entfernen
if [ -f "$MANIFEST" ]; then
    sort -u "$MANIFEST" > "$NEUES_MANIFEST.alt"
    sort -u "$NEUES_MANIFEST" > "$NEUES_MANIFEST.neu"
    comm -23 "$NEUES_MANIFEST.alt" "$NEUES_MANIFEST.neu" | while read -r f; do
        [ -n "$f" ] && [ -e "$f" ] || continue
        sichern "$f"; rm -f "$f"; log "entfernt (nicht mehr im Paket): $f"
    done
    rm -f "$NEUES_MANIFEST.alt" "$NEUES_MANIFEST.neu"
fi

# Kopie des Pakets fuer "waechter config-anwenden" und Deinstallation
if [ "$SRC" != "$SHARE" ]; then
    rm -rf "$SHARE.neu"; mkdir -p "$SHARE.neu"
    cp -a "$SRC"/. "$SHARE.neu"/
    echo "$VERSION" > "$SHARE.neu/VERSION"
    rm -rf "$SHARE.alt"; [ -d "$SHARE" ] && mv "$SHARE" "$SHARE.alt"
    mv "$SHARE.neu" "$SHARE"; rm -rf "$SHARE.alt"
fi
sort -u "$NEUES_MANIFEST" > "$MANIFEST"; rm -f "$NEUES_MANIFEST"
systemctl daemon-reload

# ===========================================================================
# Firewall
# ===========================================================================
if [ "$FW" = eigen ]; then
    systemctl enable waechter-firewall.service >/dev/null 2>&1
    systemctl restart waechter-firewall.service
    log "Firewall: Ketten WAECHTER-* aktiv"
else
    systemctl disable --now waechter-firewall.service >/dev/null 2>&1 || true
    $SBIN/waechter-firewall.sh --nur-sets >/dev/null
    log "Firewall: nur ipsets (FIREWALL=aus) - eigene Firewall muss die Sets einhaengen"
fi

# ===========================================================================
# IDS (Suricata)
# ===========================================================================
if [ "$IDS" = 1 ]; then
    id suricata >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin suricata
    install -d -m 750 -o suricata -g suricata /var/log/suricata /run/suricata
    chown -R suricata:suricata /var/log/suricata
    install -d -m 755 /var/lib/suricata /var/lib/suricata/rules /var/lib/ids-watch
    touch /var/log/ids-watch.log; chmod 640 /var/log/ids-watch.log
    WAN=$(cget WAN_IF)
    $SBIN/gen-suricata-ids-yaml.py --iface "$WAN" --home "$(cget SURICATA_HOME_NET)" \
        --threads "$(cget IDS_THREADS)" 2>/dev/null
    if [ ! -s /var/lib/suricata/rules/suricata.rules ] || [ "$MODE" != anwenden ]; then
        log "Lade Suricata-Regeln (ET Open) ..."
        suricata-update --suricata-conf /etc/suricata/suricata-ids.yaml -q >/dev/null 2>&1 \
            || warn "suricata-update fehlgeschlagen (Netz?) - naechster Versuch per Timer"
    fi
    if [ -s /var/lib/suricata/rules/suricata.rules ]; then
        if ! suricata -T -c /etc/suricata/suricata-ids.yaml >/tmp/suricata-test.$$ 2>&1; then
            err "Suricata-Konfigtest fehlgeschlagen:"; tail -5 /tmp/suricata-test.$$ >&2
        fi
        rm -f /tmp/suricata-test.$$
    fi
    systemctl enable suricata.service >/dev/null 2>&1
    systemctl restart suricata.service || warn "Suricata startet nicht: journalctl -u suricata"
    systemctl enable --now suricata-update-waechter.timer ids-gesundheit.timer ids-tagesbericht.timer >/dev/null 2>&1
    systemctl enable ids-watch.service >/dev/null 2>&1
    systemctl restart ids-watch.service
    log "IDS-Waechter aktiv (Interface $WAN, Modus $(sed -n 's/^MODUS=//p' /etc/ids-watch.conf))"
else
    for u in ids-watch.service ids-gesundheit.timer ids-tagesbericht.timer suricata-update-waechter.timer; do
        systemctl disable --now "$u" >/dev/null 2>&1 || true
    done
fi
if [ "$CF" = 1 ]; then
    systemctl enable --now cf-ban-reconcile.timer >/dev/null 2>&1
fi

# ===========================================================================
# fail2ban: pruefen, sonst zurueckrollen
# ===========================================================================
mkdir -p /var/log/webauth
touch /var/log/fail2ban.log
if [ "$(cget DASHBOARD_JAIL)" != false ]; then
    mkdir -p /var/lib/linux-dashboard; touch /var/lib/linux-dashboard/auth.log
fi
if ! fail2ban-client -t >/tmp/f2b-test.$$ 2>&1; then
    err "fail2ban-Konfiguration fehlerhaft:"; grep -iE 'error|fehler' /tmp/f2b-test.$$ | tail -8 >&2
    if [ -d "$BACKUP$F2B" ]; then
        err "Stelle die vorherigen fail2ban-Dateien wieder her ($BACKUP$F2B)."
        cp -a "$BACKUP$F2B"/. $F2B/
    fi
    rm -f /tmp/f2b-test.$$
    exit 1
fi
rm -f /tmp/f2b-test.$$
systemctl enable fail2ban >/dev/null 2>&1
if systemctl is-active --quiet fail2ban; then
    fail2ban-client reload >/dev/null || systemctl restart fail2ban
else
    systemctl restart fail2ban
fi
for _ in $(seq 1 20); do
    jails=$(fail2ban-client status 2>/dev/null | sed -n 's/^.*Jail list:\s*//p' || true)
    [ -n "$jails" ] && break
    sleep 1
done
log "fail2ban: ${jails:-KEINE JAILS AKTIV - journalctl -u fail2ban}"

if [ "$MODE" != anwenden ]; then
    echo "$VERSION" > "$VERFILE"
    [ -d "$BACKUP" ] && log "Sicherung der ersetzten Dateien: $BACKUP"
fi
log "Fertig. Status: waechter status   |   Freigeben: waechter freigeben <ip>"
