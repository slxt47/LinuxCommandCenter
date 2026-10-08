#!/usr/bin/env bash
#
# install.sh — Linux Command Center + Passwort-Tresor (Vault)
#
# Installiert bzw. aktualisiert beide Komponenten auf einem neuen System:
#
#   1. Dashboard  — Docker-Container "linux-dashboard" (Port 8420, host-network)
#   2. Vault      — unprivilegierter systemd-Dienst "vault.service"
#                   (127.0.0.1:8099, SQLite unter /var/lib/vault/vault.db)
#
# Das Dashboard reverse-proxied /vault-app und /api/vault/ auf den Vault-Dienst,
# der Tresor erscheint dadurch als eigener Reiter im Dashboard.
#
# Nutzung:
#   sudo ./install.sh                 # alles installieren bzw. aktualisieren
#   sudo ./install.sh --update        # dito (Alias) — Daten bleiben IMMER erhalten
#   sudo ./install.sh --dashboard-only
#   sudo ./install.sh --vault-only
#   sudo ./install.sh --no-start      # nur einrichten/bauen, nichts starten
#   sudo ./install.sh --port 9000     # abweichender Dashboard-Port
#   sudo ./install.sh --uninstall     # Dienste + Container entfernen (Daten bleiben)
#   sudo ./install.sh --check         # nur prüfen, ob alles läuft
#
# Der Installer ist idempotent: mehrfaches Ausführen aktualisiert nur den Code.
# Vorhandene Daten (/var/lib/vault/vault.db, /var/lib/linux-dashboard) werden
# NIE überschrieben oder gelöscht.
#
set -euo pipefail

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
cd "$(dirname "$SELF")"
SRC_DIR="$PWD"
VERSION="$(cat VERSION 2>/dev/null || echo unbekannt)"

# ─── Konstanten ─────────────────────────────────────────────────────────────
DASH_SRC="$SRC_DIR/dashboard-docker"
DASH_DATA="/var/lib/linux-dashboard"
VAULT_SRC="$SRC_DIR/vault"
VAULT_DIR="/opt/vault-manager"
VAULT_DATA="/var/lib/vault"
VAULT_DB="$VAULT_DATA/vault.db"
VAULT_USER="vault"
VAULT_PORT=8099
PORT="${DASH_PORT:-8420}"

DO_DASH=1
DO_VAULT=1
START=1
ACTION="install"

while [ $# -gt 0 ]; do
  case "$1" in
    --update)          ACTION="install" ;;
    --dashboard-only)  DO_VAULT=0 ;;
    --vault-only)      DO_DASH=0 ;;
    --no-start)        START=0 ;;
    --port)            PORT="${2:?--port braucht einen Wert}"; shift ;;
    --uninstall)       ACTION="uninstall" ;;
    --check)           ACTION="check" ;;
    -h|--help)         grep '^#' "$SELF" | grep -v '^#!' | sed 's/^# \{0,1\}//;s/^#//'; exit 0 ;;
    *) echo "Unbekannte Option: $1" >&2; exit 1 ;;
  esac
  shift
done

log()  { printf '\033[1;32m[+]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; }
step() { printf '\n\033[1;36m══ %s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  err "Bitte als root ausführen:  sudo ./install.sh"
  exit 1
fi

# ─── Paketmanager erkennen ──────────────────────────────────────────────────
detect_pm() {
  if   command -v apt-get >/dev/null 2>&1; then echo apt
  elif command -v dnf     >/dev/null 2>&1; then echo dnf
  elif command -v yum     >/dev/null 2>&1; then echo yum
  elif command -v pacman  >/dev/null 2>&1; then echo pacman
  elif command -v zypper  >/dev/null 2>&1; then echo zypper
  else echo unknown; fi
}
PM="$(detect_pm)"

pm_install() {
  case "$PM" in
    apt)    DEBIAN_FRONTEND=noninteractive apt-get install -y "$@" ;;
    dnf|yum) $PM install -y "$@" ;;
    pacman) pacman -S --noconfirm --needed "$@" ;;
    zypper) zypper --non-interactive install "$@" ;;
    *)      return 1 ;;
  esac
}

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    err "Weder 'docker compose' noch 'docker-compose' verfügbar."
    exit 1
  fi
}

have_systemd() { [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; }

# HTTP-Erreichbarkeit prüfen — curl, sonst wget, sonst python3 (immer vorhanden,
# weil der Vault es ohnehin braucht).
http_ok() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -o /dev/null -m 5 "$url" 2>/dev/null
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O /dev/null -T 5 "$url" 2>/dev/null
  else
    python3 - "$url" <<'PY' 2>/dev/null
import sys, urllib.request
try:
    urllib.request.urlopen(sys.argv[1], timeout=5)
except Exception:
    sys.exit(1)
PY
  fi
}

# ─── Deinstallation ─────────────────────────────────────────────────────────
if [ "$ACTION" = "uninstall" ]; then
  step "Deinstallation (Daten bleiben erhalten)"
  if [ "$DO_DASH" -eq 1 ] && [ -d "$DASH_SRC" ]; then
    ( cd "$DASH_SRC" && compose down 2>/dev/null || true )
    docker rm -f linux-dashboard 2>/dev/null || true
    log "Dashboard-Container entfernt."
  fi
  if [ "$DO_VAULT" -eq 1 ] && have_systemd; then
    systemctl disable --now vault.service 2>/dev/null || true
    rm -f /etc/systemd/system/vault.service
    systemctl daemon-reload
    log "vault.service entfernt."
  fi
  echo
  log "Fertig. Daten liegen weiterhin unter:"
  echo "        $DASH_DATA"
  echo "        $VAULT_DATA  (vault.db — Tresor-Daten!)"
  exit 0
fi

# ─── Statusprüfung ──────────────────────────────────────────────────────────
check_status() {
  local rc=0
  echo
  if [ "$DO_DASH" -eq 1 ]; then
    printf '  %-24s ' "Dashboard-Container:"
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx linux-dashboard; then
      printf '\033[1;32mläuft\033[0m\n'
    else
      printf '\033[1;31mläuft NICHT\033[0m\n'; rc=1
    fi
    printf '  %-24s ' "Dashboard-HTTP:"
    if http_ok "http://127.0.0.1:${PORT}/"; then
      printf '\033[1;32mHTTP OK (Port %s)\033[0m\n' "$PORT"
    else
      printf '\033[1;31mkeine Antwort auf Port %s\033[0m\n' "$PORT"; rc=1
    fi
  fi
  if [ "$DO_VAULT" -eq 1 ]; then
    if have_systemd; then
      printf '  %-24s ' "vault.service:"
      if systemctl is-active --quiet vault.service 2>/dev/null; then
        printf '\033[1;32maktiv\033[0m\n'
      else
        printf '\033[1;31minaktiv\033[0m\n'; rc=1
      fi
    fi
    printf '  %-24s ' "Vault-HTTP:"
    if http_ok "http://127.0.0.1:${VAULT_PORT}/vault-app/index.html"; then
      printf '\033[1;32mHTTP OK (Port %s)\033[0m\n' "$VAULT_PORT"
    else
      printf '\033[1;31mkeine Antwort auf Port %s\033[0m\n' "$VAULT_PORT"; rc=1
    fi
  fi
  if [ "$DO_DASH" -eq 1 ] && [ "$DO_VAULT" -eq 1 ]; then
    printf '  %-24s ' "Vault über Dashboard:"
    if http_ok "http://127.0.0.1:${PORT}/vault-app/index.html"; then
      printf '\033[1;32mProxy OK\033[0m\n'
    else
      printf '\033[1;31mProxy antwortet nicht\033[0m\n'; rc=1
    fi
  fi
  echo
  return $rc
}

if [ "$ACTION" = "check" ]; then
  check_status && log "Alles läuft." || warn "Es gibt Probleme (siehe oben)."
  exit 0
fi

echo
echo "  ┌───────────────────────────────────────────────┐"
printf "  │  Linux Command Center + Vault  %-14s │\n" "v$VERSION"
echo "  └───────────────────────────────────────────────┘"

# ════════════════════════════════════════════════════════════════════════════
#  Teil 1: Vault (systemd-Dienst auf dem Host)
# ════════════════════════════════════════════════════════════════════════════
install_vault() {
  step "Passwort-Tresor (Vault)"

  # Abhängigkeiten: python3 + cryptography (Signaturprüfung der Geräte-Freigabe)
  if ! command -v python3 >/dev/null 2>&1; then
    log "Installiere python3 …"
    pm_install python3 || { err "python3 konnte nicht installiert werden."; exit 1; }
  fi
  if ! python3 -c "import cryptography" 2>/dev/null; then
    log "Installiere Python-Modul 'cryptography' …"
    case "$PM" in
      apt)     pm_install python3-cryptography || true ;;
      dnf|yum) pm_install python3-cryptography || true ;;
      pacman)  pm_install python-cryptography  || true ;;
      zypper)  pm_install python3-cryptography || true ;;
    esac
    if ! python3 -c "import cryptography" 2>/dev/null; then
      warn "Distro-Paket fehlgeschlagen — versuche pip …"
      pm_install python3-pip 2>/dev/null || true
      python3 -m pip install --break-system-packages cryptography 2>/dev/null \
        || python3 -m pip install cryptography 2>/dev/null || true
    fi
    python3 -c "import cryptography" 2>/dev/null \
      || { err "Python-Modul 'cryptography' fehlt — Vault kann nicht starten."; exit 1; }
  fi
  log "Abhängigkeiten ok: python3 + cryptography"

  # Dienstbenutzer (unprivilegiert, kein Login)
  if ! id -u "$VAULT_USER" >/dev/null 2>&1; then
    log "Lege Systembenutzer '$VAULT_USER' an …"
    useradd --system --no-create-home --shell /usr/sbin/nologin "$VAULT_USER" 2>/dev/null \
      || useradd --system --no-create-home --shell /sbin/nologin "$VAULT_USER"
  else
    log "Systembenutzer '$VAULT_USER' vorhanden."
  fi

  # Datenverzeichnis + DB (NIE überschreiben)
  mkdir -p "$VAULT_DATA"
  chown "$VAULT_USER:$VAULT_USER" "$VAULT_DATA"
  chmod 700 "$VAULT_DATA"
  if [ -f "$VAULT_DB" ]; then
    log "Vorhandene Tresor-Datenbank gefunden — bleibt unverändert ($VAULT_DB)."
  else
    log "Neue (leere) Tresor-Datenbank wird beim ersten Start angelegt."
  fi

  # Programmdateien nach /opt (Code wird ersetzt, Daten liegen woanders)
  log "Kopiere Vault nach $VAULT_DIR …"
  mkdir -p "$VAULT_DIR"
  rm -rf "$VAULT_DIR/static" "$VAULT_DIR/__pycache__"
  install -m 0644 "$VAULT_SRC/vault_backend.py" "$VAULT_DIR/vault_backend.py"
  install -m 0644 "$VAULT_SRC/schema.sql"       "$VAULT_DIR/schema.sql"
  cp -r "$VAULT_SRC/static" "$VAULT_DIR/static"
  chown -R root:root "$VAULT_DIR"
  find "$VAULT_DIR" -type d -exec chmod 755 {} +
  find "$VAULT_DIR" -type f -exec chmod 644 {} +

  # systemd-Dienst
  if have_systemd; then
    install -m 0644 "$VAULT_SRC/vault.service" /etc/systemd/system/vault.service
    systemctl daemon-reload
    systemctl enable vault.service >/dev/null 2>&1 || true
    if [ "$START" -eq 1 ]; then
      systemctl restart vault.service
      sleep 1
      if systemctl is-active --quiet vault.service; then
        log "vault.service läuft (127.0.0.1:$VAULT_PORT)."
      else
        err "vault.service startet nicht:"
        systemctl status vault.service --no-pager -l | tail -20 || true
        exit 1
      fi
    else
      log "vault.service eingerichtet (nicht gestartet, --no-start)."
    fi
  else
    warn "Kein systemd gefunden — Vault manuell starten mit:"
    echo "     python3 $VAULT_DIR/vault_backend.py --db $VAULT_DB --port $VAULT_PORT --host 127.0.0.1"
  fi
}

# ════════════════════════════════════════════════════════════════════════════
#  Teil 2: Dashboard (Docker)
# ════════════════════════════════════════════════════════════════════════════
install_docker_engine() {
  if command -v docker >/dev/null 2>&1; then
    log "Docker vorhanden: $(docker --version)"
    return
  fi
  log "Docker nicht gefunden — installiere Docker Engine …"
  case "$PM" in
    apt)
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -y
      pm_install ca-certificates curl gnupg
      install -m 0755 -d /etc/apt/keyrings
      if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
        . /etc/os-release
        curl -fsSL "https://download.docker.com/linux/${ID}/gpg" \
          | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
        chmod a+r /etc/apt/keyrings/docker.gpg
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
          > /etc/apt/sources.list.d/docker.list
      fi
      apt-get update -y
      pm_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
        || { warn "Docker-CE-Repo fehlgeschlagen — nutze Distro-Pakete."; \
             pm_install docker.io docker-compose-v2 || pm_install docker.io; }
      ;;
    dnf|yum)
      pm_install dnf-plugins-core || true
      $PM config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo 2>/dev/null \
        || $PM config-manager addrepo --from-repofile=https://download.docker.com/linux/centos/docker-ce.repo 2>/dev/null || true
      pm_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
        || pm_install docker docker-compose
      ;;
    pacman) pm_install docker docker-compose ;;
    zypper) pm_install docker docker-compose ;;
    *)
      err "Unbekannter Paketmanager. Docker bitte manuell installieren:"
      err "  https://docs.docker.com/engine/install/"
      exit 1 ;;
  esac
  systemctl enable --now docker 2>/dev/null || service docker start 2>/dev/null || true
  log "Docker installiert: $(docker --version)"
}

install_dashboard() {
  step "Dashboard (Docker-Container)"
  install_docker_engine

  if ! docker info >/dev/null 2>&1; then
    log "Starte Docker-Daemon …"
    systemctl start docker 2>/dev/null || service docker start 2>/dev/null || true
    sleep 2
    docker info >/dev/null 2>&1 || { err "Docker-Daemon nicht erreichbar."; exit 1; }
  fi

  # Datenverzeichnis (bleibt bei Updates erhalten)
  if [ -d "$DASH_DATA" ]; then
    log "Datenverzeichnis vorhanden: $DASH_DATA (bleibt unverändert)"
  else
    log "Lege Datenverzeichnis an: $DASH_DATA"
    mkdir -p "$DASH_DATA"
  fi

  # Optionale Host-Komponenten melden
  [ -d /run/libvirt ] || warn "libvirt nicht gefunden — VM-Funktionen bleiben inaktiv (Rest läuft)."

  cd "$DASH_SRC"
  if [ "$PORT" != "8420" ]; then
    log "Setze Dashboard-Port auf $PORT."
    if grep -q '^\( *\)# *- DASH_PORT=' docker-compose.yml; then
      sed -i "s|^\( *\)# *- DASH_PORT=.*|\1- DASH_PORT=${PORT}|" docker-compose.yml
    else
      sed -i "s|^\( *\)- DASH_PORT=.*|\1- DASH_PORT=${PORT}|" docker-compose.yml
    fi
  fi

  log "Baue Image (beim ersten Mal dauert das einige Minuten) …"
  compose build

  if [ "$START" -eq 1 ]; then
    log "Starte Container …"
    compose up -d
    sleep 3
    compose ps
  else
    log "Build fertig, Start übersprungen (--no-start)."
  fi
  cd "$SRC_DIR"
}

# ─── Ablauf ─────────────────────────────────────────────────────────────────
if [ "$DO_VAULT" -eq 1 ]; then install_vault; fi
if [ "$DO_DASH"  -eq 1 ]; then install_dashboard; fi

if [ "$START" -eq 1 ]; then
  step "Prüfung"
  check_status || true
fi

step "Fertig"
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [ "$DO_DASH" -eq 1 ]; then
  echo "  Dashboard:   http://localhost:${PORT}"
  [ -n "${IP:-}" ] && echo "               http://${IP}:${PORT}"
  echo "  Login:       ein lokaler Systembenutzer dieses Hosts (/etc/shadow)."
  echo "               Admin-Funktionen nur für Mitglieder der Gruppe 'sudo'."
fi
if [ "$DO_VAULT" -eq 1 ]; then
  if [ "$DO_DASH" -eq 1 ]; then
    echo "  Tresor:      Reiter „Tresor\" im Dashboard  (→ /vault-app/)"
  else
    echo "  Tresor:      http://127.0.0.1:${VAULT_PORT}/vault-app/  (nur localhost)"
  fi
  echo "               Beim ersten Öffnen: Konto anlegen, Notfall-Code notieren,"
  echo "               danach iPhone-PWA über /vault-app/phone.html koppeln."
fi
echo
echo "  Logs:        docker logs -f linux-dashboard   |   journalctl -u vault -f"
echo "  Status:      sudo ./install.sh --check"
echo "  Update:      sudo ./install.sh --update"
echo "  Entfernen:   sudo ./install.sh --uninstall"
echo
warn "Sicherheit: Das Dashboard hat vollen Host-Zugriff (Terminal, Docker, VMs)."
warn "Nicht ungeschützt ins Internet stellen — DASHBOARD_ALLOWED_NETS in"
warn "dashboard-docker/docker-compose.yml einschränken bzw. Reverse-Proxy + TLS nutzen."
echo
