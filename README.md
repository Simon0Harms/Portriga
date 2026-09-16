# Portriga – Online-Kartenspiel

Server-autoritatives Mehrspieler-Kartenspiel (Stichvorhersage) nach den Regeln von
<http://portriga.bplaced.net/>. Node.js + WebSockets, ohne Datenbank.
Deployment als Proxmox-Debian-LXC.

## Umgesetzte Regeln
- 2 Skatblätter = 64 Karten (jede Karte doppelt), 2–7 Spieler.
- Rundenfolge der Kartenanzahl pro Spieler: **1→7 aufsteigend, dann 8 genau *N*-mal (N = Spieleranzahl), dann 7→1 absteigend.** Geber wandert pro Runde im Uhrzeigersinn.
- Nach dem Austeilen wird eine Karte als **Trumpf** aufgedeckt (gilt die ganze Runde).
- **Ansage** reihum ab links vom Geber, Geber zuletzt (0 bis Kartenanzahl).
- Ausgespielt wird zuerst vom ersten Ansager, danach vom Gewinner des letzten Stichs.
- **Bedienzwang + Trumpfzwang:** bediene die angespielte Farbe, wenn du sie hast; sonst spiele Trumpf, wenn du einen hast; sonst frei.
- **Sonderregel „der 2. übersticht den 1."**: Bei wertgleichen Karten gewinnt die *später* gelegte den Stich.
- **Wertung:** Ansage exakt getroffen → `10 + Stiche·3` (auch bei 0). Daneben → `−|Ansage − Stiche|·3`.
- Wer nach der letzten Runde am meisten Punkte hat, gewinnt.

### Bewusste Annahmen (per Regelseite nicht 100 % eindeutig)
1. **Kartenwertigkeit** = Bildreihenfolge der Regelseite: **Ass, 7, König, Dame, Bube, 10, 9, 8** (Ass am höchsten). Falls das nur Anzeige und keine Wertigkeit war: in `game.js` die Konstante `RANKS` umsortieren – eine Zeile.
2. **Trumpfzwang** als „bedienen, sonst Trumpf, sonst frei" interpretiert (gängige Lesart von „Bedienzwang + Trumpfzwang"). Änderbar in `game.legalCards()`.

Nicht implementiert (bewusst, weil in den Regeln nicht gefordert): eine „Summe der Ansagen ≠ Stichzahl"-Beschränkung für den Geber. Bots sind nur ein simpler Platzhalter zum Solo-Testen, keine starke KI.

## Projektstruktur
```
game.js            Regel-Engine (rein, testbar)
bots.js            simpler Platzhalter-Bot
server.js          Express + WebSocket, Räume, Bot-Steuerung, Reconnect
public/            Frontend (index.html, style.css, app.js)
test/simulate.js   kopflose Vollspiel-Simulation (npm test)
deploy/            Proxmox-LXC + systemd + nginx
```

## Lokal starten
```bash
npm install
npm start           # http://localhost:3000
npm test            # 1200 simulierte Vollspiele (Regel-/Absturztest)
```
Zum Alleine-Testen: Raum erstellen → „+ Bot" ein-/zweimal → „Spiel starten".

## Sicherheit / Anti-Cheat
Die komplette Spiellogik liegt **serverseitig**. Jeder Client bekommt nur eine redigierte Sicht
(`game.viewFor`): die eigene Hand vollständig, von anderen nur die Kartenanzahl. Karten der
Mitspieler verlassen den Server nie. Legalität jedes Zuges wird serverseitig geprüft.

## Deployment als Proxmox-Debian-13-LXC (Trixie)

### 1. Container anlegen (auf dem Proxmox-Host, als root)
```bash
# Werte per Env überschreibbar
CTID=140 MEMORY=1024 CORES=2 BRIDGE=vmbr0 ./deploy/proxmox-create-lxc.sh
```
Das Skript lädt bei Bedarf das Debian-13-Template, erstellt einen unprivilegierten Container
und startet ihn. Danach die Container-IP notieren:
```bash
pct exec 140 -- ip -4 addr show eth0 | grep inet
```

### 2. App in den Container bringen – zwei Wege

**a) Per Git (wenn du das Repo veröffentlichst, z. B. als Simon0Harms):**
```bash
pct exec 140 -- bash -c 'apt-get update && apt-get install -y git \
  && git clone <DEIN_REPO_URL> /opt/portriga'
```

**b) Per Kopie vom Proxmox-Host (ohne Git):**
```bash
# im Projektordner ein Archiv ohne node_modules bauen
tar --exclude=node_modules --exclude=.git -czf /tmp/portriga.tar.gz -C . .
pct exec 140 -- mkdir -p /opt/portriga
pct push 140 /tmp/portriga.tar.gz /opt/portriga/portriga.tar.gz
pct exec 140 -- tar -xzf /opt/portriga/portriga.tar.gz -C /opt/portriga
pct exec 140 -- rm /opt/portriga/portriga.tar.gz
```

### 3. Provisionieren (im Container)
```bash
# Nur Node + Dienst auf Port 3000:
pct exec 140 -- bash /opt/portriga/deploy/provision.sh

# ODER mit nginx-Reverse-Proxy auf Port 80 (empfohlen):
pct exec 140 -- bash -c 'WANT_NGINX=1 bash /opt/portriga/deploy/provision.sh'
```
Danach erreichbar unter `http://<container-ip>/` (mit nginx) bzw. `:3000` (ohne).

> **Node.js auf Debian 13:** Standardmäßig wird Node 20 LTS aus dem Debian-Repo installiert
> (reicht für diese App). Für eine neuere LTS-Linie: `USE_NODESOURCE=1 NODE_MAJOR=22 bash …provision.sh`.
> Das provision-Skript nutzt bewusst den keyring/deb822-Weg statt des `setup_x.x`-Skripts, weil
> Letzteres auf Trixie am alten SHA-1-Repo-Key scheitern kann (Debian 13 verifiziert mit `sqv`, ohne SHA-1).

### Betrieb
```bash
pct exec 140 -- systemctl status portriga
pct exec 140 -- journalctl -u portriga -f
pct exec 140 -- systemctl restart portriga
```
Aktualisieren: neue Dateien nach `/opt/portriga` bringen, dann
`systemctl restart portriga` (bei geänderten Dependencies vorher `npm ci --omit=dev`).

### HTTPS
Der State liegt nur im RAM – ein Neustart beendet laufende Spiele. Für öffentlichen Betrieb
`nginx-portriga.conf` um ein Zertifikat erweitern (certbot/ACME) und `listen 443 ssl;` ergänzen.

## Lizenz
GPL-3.0-or-later.
