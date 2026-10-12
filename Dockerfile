FROM kasmweb/firefox:1.19.0-rolling-weekly AS kasmvnc-src

FROM debian:bookworm-slim

LABEL description="Linux Command Center Dashboard"
LABEL version="1.2"

# KasmVNC-Web-Client aus dem kasmweb-Image: exakt derselbe Client wie bei den
# Browser-Sessions — die Mobile-Patches (Trackpad-Cursor) und Resize-Settings
# des Dashboards sind auf diesen Client abgestimmt. Wird von Xkasmvnc für die
# VM-Konsolen ausgeliefert (separates Verzeichnis, damit das kasmvncserver-Deb
# sein eigenes www nicht überschreibt).
COPY --from=kasmvnc-src /usr/share/kasmvnc/www /usr/share/kasmvnc/www-kasm

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    procps \
    iproute2 \
    coreutils \
    hostname \
    util-linux \
    sysvinit-utils \
    libvirt-clients \
    novnc \
    python3-websockify \
    python3-paramiko \
    spice-html5 \
    ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# KasmVNC-Server + Viewer-Stack für VM-Konsolen: pro VM läuft ein echter
# KasmVNC-Server (Xkasmvnc), in dem remote-viewer die QEMU-VNC-Konsole
# als Kiosk anzeigt — gleiche Verbindung/Erfahrung wie Browser-Sessions.
# (Der KasmVNC-Web-Client wird von Xkasmvnc selbst ausgeliefert.)
RUN python3 -c "import urllib.request; urllib.request.urlretrieve('https://github.com/kasmtech/KasmVNC/releases/download/v1.4.0/kasmvncserver_bookworm_1.4.0_amd64.deb','/tmp/kasmvnc.deb')" \
    && apt-get update \
    && apt-get install -y /tmp/kasmvnc.deb virt-viewer matchbox-window-manager xauth xdotool \
    && rm /tmp/kasmvnc.deb \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# KasmVNC-Server-Binary aus dem kasmweb-Image — GLEICHE Version wie der
# Web-Client oben. Der 1.4.0-Release-Server lehnt den neueren Client ab
# ("unknown message type 184"). Das Binary läuft auf Bookworm (identische
# Lib-SONAMEs, libjpeg/libwebp statisch); das 1.4.0-Deb bleibt für die
# Abhängigkeiten und Tools (kasmvncpasswd, xkb-Daten) installiert.
COPY --from=kasmvnc-src /usr/bin/Xkasmvnc /usr/bin/Xkasmvnc15

WORKDIR /app
COPY server.py .
COPY static/ ./static/
COPY console-pages/vnc_cmd.html /usr/share/novnc/vnc_cmd.html
COPY console-pages/spice_cmd.html /usr/share/spice-html5/spice_cmd.html

EXPOSE 8420

ENV PYTHONUNBUFFERED=1

CMD ["python3", "server.py"]
