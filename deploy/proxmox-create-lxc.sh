#!/usr/bin/env bash
# Auf dem PROXMOX-HOST ausführen (als root). Legt einen Debian-13-LXC an.
# Alle Werte per Env überschreibbar, z.B.:  CTID=141 MEMORY=2048 ./proxmox-create-lxc.sh
set -euo pipefail

CTID="${CTID:-140}"
CT_HOSTNAME="${CT_HOSTNAME:-portriga}"   # NICHT $HOSTNAME nutzen: von der Bash mit dem Host-Namen vorbelegt
STORAGE="${STORAGE:-local-lvm}"           # Storage für die Container-Disk
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"  # Storage für das Template
BRIDGE="${BRIDGE:-vmbr0}"
CORES="${CORES:-2}"
MEMORY="${MEMORY:-1024}"                   # MB
SWAP="${SWAP:-512}"
DISK="${DISK:-8}"                          # GB
IPCONFIG="${IPCONFIG:-ip=dhcp}"            # oder: ip=192.168.1.50/24,gw=192.168.1.1
UNPRIVILEGED="${UNPRIVILEGED:-1}"
ROOT_PASSWORD="${ROOT_PASSWORD:-}"         # leer = zufällig; für Konsole/SSH ggf. setzen
ARCH="${ARCH:-$(dpkg --print-architecture)}"   # Host-Architektur, i.d.R. amd64 (x86-64)

if pct status "$CTID" &>/dev/null; then
  echo "FEHLER: CTID $CTID existiert bereits. Anderen CTID wählen." >&2; exit 1
fi

echo ">> Template-Liste aktualisieren (Architektur: ${ARCH})…"
pveam update >/dev/null || true
# Nur Templates der Host-Architektur (sonst startet der Container nicht, z.B. arm64 auf x86-64).
TMPL="$(pveam available --section system \
  | awk -v a="_${ARCH}.tar" '/debian-13-standard/ && index($2,a){print $2}' \
  | sort -V | tail -1)"
if [ -z "${TMPL:-}" ]; then
  echo "FEHLER: kein debian-13-standard Template für Architektur '${ARCH}' gefunden." >&2
  echo "Verfügbar:" >&2
  pveam available --section system | awk '/debian-13-standard/{print "  "$2}' >&2
  exit 1
fi
echo ">> Gewähltes Template: ${TMPL}"

if ! pveam list "$TEMPLATE_STORAGE" | grep -q "$TMPL"; then
  echo ">> Lade Template $TMPL …"
  pveam download "$TEMPLATE_STORAGE" "$TMPL"
fi

PW_ARG=()
if [ -n "$ROOT_PASSWORD" ]; then PW_ARG=(--password "$ROOT_PASSWORD"); fi

echo ">> Erstelle Container $CTID ($CT_HOSTNAME) …"
pct create "$CTID" "${TEMPLATE_STORAGE}:vztmpl/${TMPL}" \
  --hostname "$CT_HOSTNAME" \
  --cores "$CORES" --memory "$MEMORY" --swap "$SWAP" \
  --rootfs "${STORAGE}:${DISK}" \
  --net0 "name=eth0,bridge=${BRIDGE},firewall=1,${IPCONFIG}" \
  --unprivileged "$UNPRIVILEGED" \
  --features nesting=1 \
  --onboot 1 \
  "${PW_ARG[@]}"

echo ">> Starte Container…"
pct start "$CTID"
sleep 4

echo
echo "FERTIG. Container $CTID läuft."
echo "IP ermitteln:   pct exec $CTID -- ip -4 addr show eth0 | grep inet"
echo
echo "Nächste Schritte (App hineinkopieren + provisionieren) stehen in der README."
echo "Schnellweg per Git im Container:"
echo "  pct exec $CTID -- bash -c 'apt-get update && apt-get install -y git && git clone <DEIN_REPO> /opt/portriga && bash /opt/portriga/deploy/provision.sh'"
