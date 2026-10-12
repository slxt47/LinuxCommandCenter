#!/usr/bin/env bash
#
# install.sh — Linux Command Center Dashboard (portable, ohne Vault)
#
# Installiert alle Abhängigkeiten (Docker Engine + Compose-Plugin), legt das
# Datenverzeichnis an und baut & startet den Container.
#
# Nutzung:
#   sudo ./install.sh            # installieren + bauen + starten
#   sudo ./install.sh --update   # nur Image neu bauen + neu starten (Code-Update)
#   sudo ./install.sh --no-start # nur Abhängigkeiten + Build, nicht starten
#
set -euo pipefail

# ─── Immer aus dem Script-Verzeichnis heraus arbeiten ───────────────────────
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DATA_DIR="/var/lib/linux-dashboard"
PORT="${DASH_PORT:-8420}"
MODE="install"
START=1

for arg in "$@"; do
  case "$arg" in
    --update)   MODE="update" ;;
    --no-start) START=0 ;;
    -h|--help)  grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unbekannte Option: $arg" >&2; exit 1 ;;
  esac
done

log()  { printf '\033[1;32m[+]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; }

# ─── Root-Check ─────────────────────────────────────────────────────────────
if [ "$(id -u)" -ne 0 ]; then
  err "Bitte als root ausführen (sudo ./install.sh)."
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

# ─── Docker installieren (falls nicht vorhanden) ────────────────────────────
install_docker() {
  if command -v docker >/dev/null 2>&1; then
    log "Docker bereits vorhanden: $(docker --version)"
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
        . /etc/os-release
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
    pacman)
      pacman -Sy --noconfirm docker docker-compose
      ;;
    zypper)
      zypper --non-interactive install docker docker-compose
      ;;
    *)
      err "Unbekannter Paketmanager. Bitte Docker manuell installieren: https://docs.docker.com/engine/install/"
      exit 1
      ;;
  esac
  systemctl enable --now docker 2>/dev/null || service docker start 2>/dev/null || true
  log "Docker installiert: $(docker --version)"
}

# ─── Compose-Kommando ermitteln (v2-Plugin bevorzugt) ───────────────────────
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

# ─── Ablauf ─────────────────────────────────────────────────────────────────
install_docker

# Docker-Daemon läuft?
if ! docker info >/dev/null 2>&1; then
  log "Starte Docker-Daemon..."
  systemctl start docker 2>/dev/null || service docker start 2>/dev/null || true
  sleep 2
  docker info >/dev/null 2>&1 || { err "Docker-Daemon nicht erreichbar."; exit 1; }
fi

# Datenverzeichnis
if [ ! -d "$DATA_DIR" ]; then
  log "Lege Datenverzeichnis an: $DATA_DIR"
  mkdir -p "$DATA_DIR"
fi

# Bauen & Starten
log "Baue Image (das erste Mal dauert es einige Minuten)..."
compose build

if [ "$START" -eq 1 ]; then
  log "Starte Container..."
  compose up -d
  sleep 2
  echo
  compose ps
  IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo
  log "Fertig!  Dashboard läuft:"
  echo "        →  http://localhost:${PORT}"
  [ -n "${IP:-}" ] && echo "        →  http://${IP}:${PORT}"
  echo "        →  Login mit einem lokalen Systembenutzer (Host-Konto)."
  echo
  echo "   Logs:      docker compose logs -f"
  echo "   Stoppen:   docker compose down"
  echo "   Update:    sudo ./install.sh --update"
else
  log "Build fertig. Start übersprungen (--no-start)."
  echo "   Starten mit:  docker compose up -d"
fi
