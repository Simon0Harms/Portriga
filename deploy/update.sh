#!/usr/bin/env bash
# Update Portriga (installed with provision.sh from a git clone in /opt/portriga). Run as root.
#   portriga-update            # newest commit of the installed branch
#   portriga-update v1.2.0     # a tag or commit
# Backs up config and data to /opt/portriga/backup first and rolls back if the new version does not start.
# Note: running games live in memory only – the restart ends them.
set -euo pipefail

APP_DIR=${PORTRIGA_DIR:-/opt/portriga}
SVC_USER=portriga
REF=${1:-}
if [ "$(id -u)" -ne 0 ]; then echo "Bitte als root ausführen." >&2; exit 1; fi
if [ ! -d "$APP_DIR/.git" ]; then
  echo "$APP_DIR ist kein git-Checkout – bitte per git clone installieren (README, Deployment 2a)." >&2
  exit 1
fi
# the checkout belongs to the service user; without safe.directory git refuses to work on it as root
GIT="git -c safe.directory=$APP_DIR -C $APP_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)

if [ -n "$($GIT status --porcelain --untracked-files=no)" ]; then
  echo "!! Lokale Änderungen an versionierten Dateien in $APP_DIR:" >&2
  $GIT status --short --untracked-files=no >&2
  echo "   Bitte erst sichern/verwerfen (git -C $APP_DIR stash bzw. checkout -- <datei>)." >&2
  exit 1
fi

health_port() {
  # same resolution as the server: config.json, overridden by PORT from portriga.env
  ( cd "$APP_DIR"
    set -a
    # shellcheck disable=SC1091
    if [ -f portriga.env ]; then . ./portriga.env; fi
    set +a
    node -e "console.log(require('./config.js').loadConfig({quiet:true}).port||3000)" 2>/dev/null ) || echo 3000
}

echo ">> Sicherung nach $APP_DIR/backup/portriga-$STAMP.tar.gz"
install -d -m 700 "$APP_DIR/backup"
FILES=""
for f in config.json portriga.env turnserver.conf data matrix; do [ -e "$APP_DIR/$f" ] && FILES="$FILES $f"; done
if [ -n "$FILES" ]; then
  # shellcheck disable=SC2086
  tar -czf "$APP_DIR/backup/portriga-$STAMP.tar.gz" -C "$APP_DIR" $FILES
  # shellcheck disable=SC2012
  ls -1t "$APP_DIR"/backup/portriga-*.tar.gz | tail -n +11 | xargs -r rm --
fi

OLD=$($GIT rev-parse HEAD)
$GIT fetch -q --tags origin
if [ -n "$REF" ]; then
  $GIT checkout -q "$REF"
else
  BRANCH=$($GIT symbolic-ref --short -q HEAD || echo main)
  $GIT checkout -q "$BRANCH"
  $GIT pull -q --ff-only origin "$BRANCH"
fi
NEW=$($GIT rev-parse HEAD)
if [ "$OLD" = "$NEW" ]; then echo ">> Bereits aktuell ($($GIT describe --always --tags))"; exit 0; fi

install_and_start() {
  local from=$1 to=$2
  ( cd "$APP_DIR"
    # dependencies only when they changed (or are missing)
    if [ ! -d node_modules ] || ! $GIT diff --quiet "$from" "$to" -- package.json package-lock.json; then
      echo ">> Abhängigkeiten installieren…"
      npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
    fi ) &&
  chown -R "$SVC_USER":"$SVC_USER" "$APP_DIR" && chown -R root:root "$APP_DIR/backup" &&
  systemctl restart portriga && sleep 3 &&
  curl -fsS -o /dev/null "http://127.0.0.1:$(health_port)/health"
}

echo ">> $($GIT log --oneline -1 "$OLD") -> $($GIT log --oneline -1 "$NEW")"
if install_and_start "$OLD" "$NEW"; then
  install -m 755 "$APP_DIR/deploy/update.sh" /usr/local/bin/portriga-update
  if ! $GIT diff --quiet "$OLD" "$NEW" -- deploy/portriga.service; then
    install -m 644 "$APP_DIR/deploy/portriga.service" /etc/systemd/system/portriga.service
    systemctl daemon-reload && systemctl restart portriga
  fi
  # nginx: sites-enabled/portriga is a symlink into the checkout – reload when the config changed
  if [ -L /etc/nginx/sites-enabled/portriga ] && ! $GIT diff --quiet "$OLD" "$NEW" -- deploy/nginx-portriga.conf; then
    if nginx -t 2>/dev/null; then systemctl reload nginx
    else echo "!! nginx: neue Konfiguration fehlerhaft (nginx -t) – nicht neu geladen" >&2; fi
  fi
  # Matrix sidecar (WANT_MATRIX=1)
  if [ -f /etc/systemd/system/portriga-matrix.service ] && ! $GIT diff --quiet "$OLD" "$NEW" -- deploy/matrix; then
    install -m 644 "$APP_DIR/deploy/matrix/portriga-matrix.service" /etc/systemd/system/portriga-matrix.service
    systemctl daemon-reload
    systemctl is-active -q portriga-matrix && systemctl restart portriga-matrix
  fi
  if ! $GIT diff --quiet "$OLD" "$NEW" -- config.example.json deploy/portriga.env.example; then
    echo ">> Hinweis: Vorlagen geändert – ggf. neue Optionen in config.json/portriga.env übernehmen:"
    $GIT diff --stat "$OLD" "$NEW" -- config.example.json deploy/portriga.env.example
  fi
  echo ">> Aktualisiert auf $($GIT describe --always --tags)"
else
  echo "!! Neue Version startet nicht – zurück auf $OLD" >&2
  $GIT checkout -q "$OLD"
  install_and_start "$NEW" "$OLD" || true
  journalctl -u portriga -n 30 --no-pager >&2 || true
  exit 1
fi
