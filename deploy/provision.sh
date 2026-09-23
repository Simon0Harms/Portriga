#!/usr/bin/env bash
# IM CONTAINER (Debian 13 / Trixie) als root ausführen.
# Installiert Node, richtet Dienst + optional nginx ein.
# Erwartet die App unter /opt/portriga (vorher hineinkopieren oder GIT_URL setzen).
#   WANT_NGINX=1      -> nginx als Reverse-Proxy auf Port 80 (mit WebSocket-Upgrade)
#   WANT_COTURN=1     -> coturn (TURN-Server für Voice), Config in /opt/portriga/turnserver.conf
#   WANT_MATRIX=1     -> Matrix-Bot für Benutzerkonten (python3 + matrix-nio[e2e]), siehe deploy/matrix/
#   GIT_URL=...       -> falls App noch nicht vorhanden, von dort klonen
#   USE_NODESOURCE=1  -> Node via NodeSource (neuere LTS) statt Debian-Paket
#   NODE_MAJOR=22     -> NodeSource-Major (nur mit USE_NODESOURCE=1)
set -euo pipefail
APP_DIR="/opt/portriga"
SVC_USER="portriga"
WANT_NGINX="${WANT_NGINX:-0}"
GIT_URL="${GIT_URL:-}"
USE_NODESOURCE="${USE_NODESOURCE:-0}"
NODE_MAJOR="${NODE_MAJOR:-22}"

echo ">> System aktualisieren…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg git

if [ ! -f "$APP_DIR/server.js" ]; then
  if [ -n "$GIT_URL" ]; then
    echo ">> Klone App von $GIT_URL …"
    git clone "$GIT_URL" "$APP_DIR"
  else
    echo "FEHLER: $APP_DIR/server.js fehlt und kein GIT_URL gesetzt." >&2
    echo "App zuerst nach $APP_DIR kopieren (siehe README)." >&2
    exit 1
  fi
fi

# --- Node.js ---
# Standard: Debian-13-Paket = Node.js 20 LTS. Reicht für diese App (>=18)
# und vermeidet den NodeSource/Trixie-Key-Fallstrick (sqv lehnt SHA-1 ab).
if [ "$USE_NODESOURCE" = "1" ]; then
  echo ">> Node.js ${NODE_MAJOR}.x via NodeSource (keyring/deb822)…"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  cat > /etc/apt/sources.list.d/nodesource.sources <<SRC
Types: deb
URIs: https://deb.nodesource.com/node_${NODE_MAJOR}.x
Suites: nodistro
Components: main
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/nodesource.gpg
SRC
  apt-get update -y
  apt-get install -y nodejs
else
  echo ">> Node.js aus dem Debian-13-Repo (Node 20 LTS)…"
  apt-get install -y nodejs npm
fi
echo "Node $(node -v), npm $(npm -v)"

echo ">> Dienstbenutzer anlegen…"
id "$SVC_USER" &>/dev/null || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$SVC_USER"

echo ">> Konfigurationsdateien in $APP_DIR sicherstellen…"
# Reale Configs nur anlegen, wenn sie fehlen – Updates überschreiben sie dann nicht.
[ -f "$APP_DIR/config.json" ]  || cp "$APP_DIR/config.example.json" "$APP_DIR/config.json"
[ -f "$APP_DIR/portriga.env" ] || cp "$APP_DIR/deploy/portriga.env.example" "$APP_DIR/portriga.env"

echo ">> Abhängigkeiten installieren…"
cd "$APP_DIR"
npm ci --omit=dev 2>/dev/null || npm install --omit=dev
chown -R "$SVC_USER":"$SVC_USER" "$APP_DIR"

echo ">> systemd-Dienst einrichten…"
install -m 0644 "$APP_DIR/deploy/portriga.service" /etc/systemd/system/portriga.service
systemctl daemon-reload
systemctl enable --now portriga
sleep 1
systemctl --no-pager --full status portriga | head -n 6 || true

if [ "$WANT_NGINX" = "1" ]; then
  echo ">> nginx-Reverse-Proxy einrichten (Config aus $APP_DIR)…"
  apt-get install -y nginx
  # aktive Config als Symlink auf die Datei in /opt/portriga -> dort liegt die Wahrheit
  ln -sf "$APP_DIR/deploy/nginx-portriga.conf" /etc/nginx/sites-enabled/portriga
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl restart nginx
fi

if [ "$WANT_COTURN" = "1" ]; then
  echo ">> coturn (TURN-Server) einrichten (Config aus $APP_DIR)…"
  apt-get install -y coturn
  [ -f "$APP_DIR/turnserver.conf" ] || cp "$APP_DIR/deploy/coturn-example.conf" "$APP_DIR/turnserver.conf"
  ln -sf "$APP_DIR/turnserver.conf" /etc/turnserver.conf
  # coturn-Dienst aktivieren
  if [ -f /etc/default/coturn ]; then
    grep -q '^TURNSERVER_ENABLED=1' /etc/default/coturn || \
      { sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn || echo 'TURNSERVER_ENABLED=1' >> /etc/default/coturn; }
  fi
  echo "   Hinweis: $APP_DIR/turnserver.conf (user/realm/Zertifikate) anpassen, dann: systemctl enable --now coturn"
  echo "   Und in $APP_DIR/config.json bzw. portriga.env die TURN-Zugangsdaten setzen."
fi

if [ "${WANT_MATRIX:-0}" = "1" ]; then
  echo ">> Matrix-Bot für Benutzerkonten einrichten…"
  apt-get install -y python3 python3-pip libolm-dev
  pip install "matrix-nio[e2e]" --break-system-packages
  install -d -m 0700 -o "$SVC_USER" -g "$SVC_USER" "$APP_DIR/data" "$APP_DIR/matrix" "$APP_DIR/matrix-store"
  [ -f "$APP_DIR/matrix/portriga-matrix.env" ] || install -m 0600 -o "$SVC_USER" -g "$SVC_USER" \
    "$APP_DIR/deploy/matrix/env.example" "$APP_DIR/matrix/portriga-matrix.env"
  install -m 0644 "$APP_DIR/deploy/matrix/portriga-matrix.service" /etc/systemd/system/portriga-matrix.service
  systemctl daemon-reload
  systemctl enable portriga-matrix
  echo "   Hinweis: $APP_DIR/matrix/portriga-matrix.env ausfüllen, in config.json accounts.botMxid +"
  echo "   accounts.publicUrl setzen, dann: systemctl restart portriga && systemctl start portriga-matrix"
fi

IP="$(ip -4 addr show eth0 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1 | head -1)"
echo
echo "FERTIG."
if [ "$WANT_NGINX" = "1" ]; then
  echo "Erreichbar unter:  http://${IP:-<container-ip>}/"
else
  echo "Erreichbar unter:  http://${IP:-<container-ip>}:3000/"
fi
echo "Logs:  journalctl -u portriga -f"
