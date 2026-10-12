#!/usr/bin/env bash
#
# install.sh — Linux Command Center (Dashboard) + Schutz-Paket
#
# Installiert bzw. aktualisiert auf einem Debian/Ubuntu-Server:
#   1. Docker (falls nötig) und den Dashboard-Container
#   2. das Schutz-Paket: fail2ban + IDS-Wächter (Suricata) + Firewall-Sperrlisten,
#      ohne Cloudflare (Cloudflare nur optional mit --cloudflare)
#
# Nutzung:
#   sudo ./install.sh                 Erstinstallation (fragt das Nötigste ab)
#   sudo ./install.sh --update        Update nach "git pull" (behält alle Einstellungen)
#   sudo ./install.sh --ja            ohne Rückfragen, mit Standardwerten
#   sudo ./install.sh --ohne-schutz   nur das Dashboard
#   sudo ./install.sh --nur-schutz    nur fail2ban/IDS (z. B. auf einem Server ohne Dashboard)
#   sudo ./install.sh --no-start      Dashboard bauen, aber nicht starten
#   sudo ./install.sh --status        installierte Versionen anzeigen
#
# Optionen für das Schutz-Paket werden durchgereicht, z. B.:
#   --trusted "203.0.113.7"  --ohne-ids  --ids-modus melden|sperren
#   --ntfy-url https://ntfy.sh --ntfy-topic mein-server [--ntfy-token tk_...]
#   --cloudflare  --firewall eigen|aus  --uebernehmen  --force
#   (Details: schutz/install-schutz.sh --help)
#
# Optionen für das Dashboard (sonst wird gefragt):
#   --erlaubte-netze "192.168.0.0/16,100.64.0.0/10"   wer direkt zugreifen darf ("*" = alle)
#   --superadmins "root,david"                        volle Rechte im Dashboard
#   --port 8420
#
# Einstellungen danach: /etc/linux-dashboard/dashboard.env (Dashboard) und
# /etc/linux-dashboard/schutz.conf (Schutz). Updates ändern dort keine Werte.
#
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO=$(pwd)
VERSION=$(cat VERSION)
ETC=/etc/linux-dashboard
ENVF=$ETC/dashboard.env
VERFILE=$ETC/version
DATA_DIR=/var/lib/linux-dashboard

MODE=install; START=1; SCHUTZ=1; DASH=1; JA=0
OPT_NETZE=""; OPT_SUPER=""; OPT_PORT=""
SCHUTZ_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --update)         MODE=update ;;
    --no-start)       START=0 ;;
    --ohne-schutz)    SCHUTZ=0 ;;
    --nur-schutz)     DASH=0 ;;
    --ja|-y)          JA=1; SCHUTZ_ARGS+=(--ja) ;;
    --status)         MODE=status ;;
    --erlaubte-netze) OPT_NETZE=$2; shift ;;
    --superadmins)    OPT_SUPER=$2; shift ;;
    --port)           OPT_PORT=$2; shift ;;
    --trusted|--ids-modus|--ntfy-url|--ntfy-topic|--ntfy-token|--firewall)
                      SCHUTZ_ARGS+=("$1" "$2"); shift ;;
    --ohne-ids|--cloudflare|--uebernehmen|--force)
                      SCHUTZ_ARGS+=("$1") ;;
    -h|--help)        sed -n '2,35p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unbekannte Option: $1 (siehe --help)" >&2; exit 1 ;;
  esac
  shift
done

log()  { printf '\033[1;32m[+]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; }
frage() {
  local a=""
  if [ $JA -eq 0 ] && [ -t 0 ]; then read -r -p "$1 [$2]: " a </dev/tty || true; fi
  printf '%s' "${a:-$2}"
}
ver_lt() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" = "$1" ]; }
env_setze() {   # env_setze KEY wert  (dashboard.env: KEY=wert ohne Anführungszeichen)
  local v=${2//\\/\\\\}; v=${v//&/\\&}; v=${v//|/\\|}
  if grep -q "^$1=" "$ENVF"; then sed -i "s|^$1=.*|$1=$v|" "$ENVF"; else echo "$1=$2" >> "$ENVF"; fi
}

if [ "$MODE" = status ]; then
  echo "Repository:        $VERSION"
  echo "Dashboard:         $(cat "$VERFILE" 2>/dev/null || echo 'nicht installiert / vor 2.0')"
  echo "Schutz-Paket:      $(cat "$ETC/schutz-version" 2>/dev/null || echo 'nicht installiert')"
  command -v docker >/dev/null && docker ps --filter name=^linux-dashboard$ --format 'Container:         {{.Status}}'
  exit 0
fi

[ "$(id -u)" -eq 0 ] || { err "Bitte als root ausführen (sudo ./install.sh)."; exit 1; }

# ─── Versionen ──────────────────────────────────────────────────────────────
INSTALLIERT=$(cat "$VERFILE" 2>/dev/null || true)
ALT_DASH=0
if [ -z "$INSTALLIERT" ] && { [ -d "$DATA_DIR" ] || docker inspect linux-dashboard >/dev/null 2>&1; }; then
  ALT_DASH=1     # Dashboard läuft schon, aber aus einer Version vor 2.0 (ohne Versionsdatei)
fi
if [ $DASH -eq 1 ]; then
  if [ -n "$INSTALLIERT" ] && ver_lt "$VERSION" "$INSTALLIERT" && [[ " ${SCHUTZ_ARGS[*]} " != *" --force "* ]]; then
    err "Installiert ist Dashboard $INSTALLIERT, dieses Repository ist älter ($VERSION). Erst 'git pull'."
    exit 1
  elif [ -n "$INSTALLIERT" ]; then log "Dashboard: Update $INSTALLIERT -> $VERSION"
  elif [ $ALT_DASH -eq 1 ]; then log "Dashboard: Update einer Version vor 2.0 -> $VERSION"
  else log "Dashboard: Erstinstallation $VERSION"; fi
fi

# ─── Paketmanager / Docker ──────────────────────────────────────────────────
detect_pm() {
  if   command -v apt-get >/dev/null 2>&1; then echo apt
  elif command -v dnf     >/dev/null 2>&1; then echo dnf
  elif command -v yum     >/dev/null 2>&1; then echo yum
  elif command -v pacman  >/dev/null 2>&1; then echo pacman
  elif command -v zypper  >/dev/null 2>&1; then echo zypper
  else echo unknown; fi
}
PM="$(detect_pm)"

install_docker() {
  if command -v docker >/dev/null 2>&1; then
    log "Docker vorhanden: $(docker --version)"
    return
  fi
  log "Docker nicht gefunden — installiere Docker Engine..."
  case "$PM" in
    apt)
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -y
      apt-get install -y ca-certificates curl gnupg
      install -m 0755 -d /etc/apt/keyrings
      if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
        local ID VERSION_CODENAME
        ID=$(. /etc/os-release; echo "$ID"); VERSION_CODENAME=$(. /etc/os-release; echo "$VERSION_CODENAME")
        curl -fsSL "https://download.docker.com/linux/${ID}/gpg" \
          | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
        chmod a+r /etc/apt/keyrings/docker.gpg
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
          > /etc/apt/sources.list.d/docker.list
      fi
      apt-get update -y
      apt-get install -y docker-ce docker-ce-cli containerd.io \
              docker-buildx-plugin docker-compose-plugin \
        || { warn "Docker-CE-Repo fehlgeschlagen — nutze Distro-Pakete (docker.io)."; \
             apt-get install -y docker.io docker-compose-v2 || apt-get install -y docker.io; }
      ;;
    dnf|yum)
      $PM install -y dnf-plugins-core || true
      $PM config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo 2>/dev/null \
        || $PM config-manager addrepo --from-repofile=https://download.docker.com/linux/centos/docker-ce.repo 2>/dev/null || true
      $PM install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
        || $PM install -y docker docker-compose
      ;;
    pacman) pacman -Sy --noconfirm docker docker-compose ;;
    zypper) zypper --non-interactive install docker docker-compose ;;
    *) err "Unbekannter Paketmanager. Docker bitte manuell installieren: https://docs.docker.com/engine/install/"; exit 1 ;;
  esac
  systemctl enable --now docker 2>/dev/null || service docker start 2>/dev/null || true
  log "Docker installiert: $(docker --version)"
}

compose() {
  if docker compose version >/dev/null 2>&1; then docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then docker-compose "$@"
  else err "Weder 'docker compose' noch 'docker-compose' verfügbar."; exit 1; fi
}

# ─── Dashboard-Einstellungen (dashboard.env) ────────────────────────────────
dashboard_env() {
  mkdir -p "$ETC"; chmod 755 "$ETC"
  if [ -f "$ENVF" ]; then
    python3 schutz/lib/schutz.py conf-merge config/dashboard.env.example "$ENVF"
    return
  fi
  install -m 600 config/dashboard.env.example "$ENVF"
  if [ $ALT_DASH -eq 1 ]; then
    # Vor 2.0 standen die Einstellungen in docker-compose.yml bzw. im Code.
    # Werte aus dem laufenden Container übernehmen und das alte Verhalten beibehalten.
    log "Übernehme Einstellungen der bisherigen Installation:"
    local envs; envs=$(docker inspect linux-dashboard --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null || true)
    local k v
    for k in DASHBOARD_ALLOWED_NETS DASH_PORT DASH_SUPERADMINS DASH_ADMIN_GROUP DASHBOARD_TOKEN \
             DASH_HOST_PUBLIC_IPS DASHBOARD_AUTH_LOG; do
      v=$(printf '%s\n' "$envs" | sed -n "s/^$k=//p" | head -1)
      [ -n "$v" ] && { env_setze "$k" "$v"; echo "    $k=$v"; }
    done
    # Bisher galten Proxy-Header von allen privaten Adressen (Tunnel im Docker-Netz)
    # und die Superadmins standen im Code.
    env_setze DASHBOARD_TRUSTED_PROXIES ""
    printf '%s\n' "$envs" | grep -q '^DASH_SUPERADMINS=' || env_setze DASH_SUPERADMINS "root,jokergame"
    return
  fi
  # Erstinstallation: das Nötigste fragen
  local netze super port
  echo
  echo "Zugriff: Das Dashboard hat Root-Rechte am Host. Ohne Tunnel/Reverse-Proxy nur aus"
  echo "vertrauenswürdigen Netzen freigeben (LAN, Tailscale). localhost geht immer."
  netze=${OPT_NETZE:-$(frage "Erlaubte Netze (Komma, CIDR; * = alle)" "192.168.0.0/16,10.0.0.0/8,100.64.0.0/10,fd7a:115c:a1e0::/48")}
  super=${OPT_SUPER:-$(frage "Superadmins (Komma-getrennt)" "root${SUDO_USER:+,$SUDO_USER}")}
  port=${OPT_PORT:-$(frage "Port" "8420")}
  env_setze DASHBOARD_ALLOWED_NETS "$netze"
  env_setze DASH_SUPERADMINS "$super"
  env_setze DASH_PORT "$port"
  if [ "$netze" = "*" ]; then
    warn "DASHBOARD_ALLOWED_NETS=* — das Dashboard ist von überall erreichbar. Dringend eine Firewall"
    warn "davor setzen oder HTTPS-Reverse-Proxy/Tailscale nutzen."
  fi
}

# ─── Dashboard ──────────────────────────────────────────────────────────────
if [ $DASH -eq 1 ]; then
  install_docker
  if ! docker info >/dev/null 2>&1; then
    log "Starte Docker-Daemon..."
    systemctl start docker 2>/dev/null || service docker start 2>/dev/null || true
    sleep 2
    docker info >/dev/null 2>&1 || { err "Docker-Daemon nicht erreichbar."; exit 1; }
  fi
  command -v python3 >/dev/null || { [ "$PM" = apt ] && apt-get install -y -qq python3 >/dev/null; }

  dashboard_env
  mkdir -p "$DATA_DIR"
  touch "$DATA_DIR/auth.log"

  log "Baue Image (beim ersten Mal einige Minuten)..."
  compose build
  if [ "$START" -eq 1 ]; then
    log "Starte Container..."
    # Alter Container (z. B. aus einem anderen Verzeichnis gestartet) wird ersetzt;
    # Daten liegen in $DATA_DIR und bleiben erhalten.
    if docker inspect linux-dashboard >/dev/null 2>&1 && \
       [ "$(docker inspect linux-dashboard --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}')" != "$REPO" ]; then
      warn "Ersetze bestehenden Container linux-dashboard (anderes Verzeichnis)."
      docker rm -f linux-dashboard >/dev/null
    fi
    # Code ist per Volume eingebunden: Neustart erzwingen, sonst laeuft der alte Code weiter.
    compose up -d --force-recreate --remove-orphans
  fi
  echo "$VERSION" > "$VERFILE"
fi

# ─── Schutz-Paket ───────────────────────────────────────────────────────────
if [ $SCHUTZ -eq 1 ]; then
  echo
  log "Schutz-Paket (fail2ban + IDS-Wächter) ..."
  if [ $DASH -eq 0 ] && ! docker inspect linux-dashboard >/dev/null 2>&1; then
    SCHUTZ_ARGS+=(--ohne-dashboard-jail)
  fi
  bash schutz/install-schutz.sh "${SCHUTZ_ARGS[@]}"
fi

# ─── Zusammenfassung ────────────────────────────────────────────────────────
if [ $DASH -eq 1 ] && [ "$START" -eq 1 ]; then
  PORT=$(sed -n 's/^DASH_PORT=//p' "$ENVF"); PORT=${PORT:-8420}
  IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo
  log "Fertig!  Linux Command Center $VERSION"
  echo "        →  http://localhost:${PORT}"
  [ -n "${IP:-}" ] && echo "        →  http://${IP}:${PORT}   (nur aus DASHBOARD_ALLOWED_NETS)"
  echo "        →  Login mit einem lokalen Systembenutzer (Host-Konto)."
  echo
  echo "   Einstellungen:  $ENVF, $ETC/schutz.conf"
  echo "   Schutz:         waechter status"
  echo "   Update:         git pull && sudo ./install.sh --update"
fi
