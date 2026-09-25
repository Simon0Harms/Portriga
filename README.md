# Portriga – Online-Kartenspiel

🇬🇧 *English version: see [below](#portriga--online-card-game).*

Server-autoritatives Mehrspieler-Kartenspiel (Stichvorhersage) nach den Regeln von
<http://portriga.bplaced.net/>. Node.js + WebSockets, ohne Datenbank.
Deployment als Proxmox-Debian-LXC.

Enthält einen **Raum-Chat** (in Lobby und Spiel nutzbar): ein-/ausklappbares Panel mit
Verlauf (bleibt bei Reconnect erhalten), Ungelesen-Zähler und dezenten System-Meldungen
(Beitritt, Spielstart). Der Verlauf liegt nur im RAM und ist auf die letzten 60 Nachrichten begrenzt.
Zusätzlich gibt es einen **Voice-Chat** als WebRTC-Mesh (Details unten).

## Spielmodi
Beim Erstellen eines Raums wählt der Host den Modus (in der Lobby jederzeit änderbar):
- **Privat** – wie bisher: Beitritt nur per Code, Direktlink oder QR-Code.
- **Öffentlich** – der Raum erscheint auf dem Startbildschirm in der Liste „offene Räume“; jeder (auch Gäste) kann beitreten.
- **Rangliste** – ebenfalls gelistet, aber nur für angemeldete Konten und ohne Bots. Das Endergebnis wird in
  `<dataDir>/ranking.json` gespeichert (Wertung, Spiele, Siege, Ø-Punkte, Bestwert). Sortiert wird nach Wertung: je Spiel
  `(Punkte − Punkte des Letzten) × Spieleranzahl / 10` (Letzter = 0), aufsummiert. und ist über „🏅 Rangliste“ bzw.
  `GET /api/ranking` abrufbar. Setzt aktivierte Benutzerkonten voraus.
  Optional (bei der Registrierung oder in den Konto-Einstellungen) schreibt der Matrix-Bot dir im privaten Chat,
  sobald sich dein Ranglistenplatz ändert – auch wenn du von anderen überholt wirst.

## Umgesetzte Regeln
- 2 Skatblätter = 64 Karten (jede Karte doppelt), 2–7 Spieler; mit der **alternativen Variante** mehr (Standard-Limit 63, per `game.maxPlayers` einschränkbar).
- Rundenfolge der Kartenanzahl pro Spieler: **1→7 aufsteigend, dann 8 genau *N*-mal (N = Spieleranzahl), dann 7→1 absteigend.** Geber wandert pro Runde im Uhrzeigersinn.
- Alternative Variante (> 7 Spieler): Maximal-Kartenzahl M = 64 / N abgerundet, bei glatter Division −1 (= `floor(63/N)`): 8 → 7, 9 → 7, 10 → 6, 12 → 5. Rundenfolge dann 1→M−1, M genau N-mal, M−1→1.
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
config.json         zentrale Konfiguration (aus config.example.json)
game.js            Regel-Engine (rein, testbar)
bots.js            simpler Platzhalter-Bot
server.js          Express + WebSocket, Räume, Bot-Steuerung, Reconnect
accounts.js        Benutzerkonten: Registrierung per Matrix-DM, Login, Sessions
announce.js        Ankündigung neuer öffentlicher/Ranglisten-Spiele im Matrix-Raum
ranking.js         Rangliste für Ranglisten-Räume (data/ranking.json)
admins.js          Admin-Rolle (data/admins.json), admin-cli.js = Verwaltung per Terminal
config.js          Laden der Konfiguration (config.json + ENV)
public/            Frontend (index.html, style.css, app.js) + regeln.html (eigenständige Regelseite)
test/simulate.js   kopflose Vollspiel-Simulation (npm test)
deploy/            Proxmox-LXC + systemd + nginx + coturn/ENV (Voice)
deploy/matrix/     Matrix-Bot (Sidecar) für Registrierung, Login-Links und Spiel-Ankündigungen
```

## Spieler kicken & Admin-Rolle
In der Lobby kann jeder einen Mitspieler per **Votekick** zur Abstimmung stellen. Stimmberechtigt sind alle
verbundenen Menschen außer dem Betroffenen; gekickt wird bei **mehr als 50 % Ja** (60 s Zeit). Gekickte
können dem Raum nicht erneut beitreten.

**Admins** kicken sofort ohne Abstimmung und können selbst nicht per Votekick entfernt werden. Die Rolle
hängt an einem (registrierten) Konto und wird nur per Terminal vergeben:
```bash
cd /opt/portriga
sudo -u portriga node admin-cli.js add <benutzername>     # Rolle vergeben
sudo -u portriga node admin-cli.js remove <benutzername>  # Rolle entziehen
sudo -u portriga node admin-cli.js list                   # Admins anzeigen
```
Gespeichert in `data/admins.json` (Konto-ID); der laufende Server übernimmt Änderungen ohne Neustart.

## Spieler stummschalten (Text- & Sprachchat)
In Lobby und laufendem Spiel kann jeder über 🔇 im Raum-Chat einen Mitspieler zur **Mute-Abstimmung** stellen.
Stimmberechtigt sind alle verbundenen Menschen außer dem Betroffenen; wirksam bei **mehr als 50 % Ja** (60 s Zeit).
Sind nur **2 Spieler** im Raum, greift der Mute sofort. Entmuten funktioniert genauso.

Stummgeschaltete können nicht schreiben; im Voice dürfen sie nur zuhören (ihr Audio wird bei allen Empfängern
stummgeschaltet, ihr Mikrofon wird clientseitig deaktiviert). Der Mute gilt für den Raum und bleibt bei
Reconnect/Neubeitritt bestehen. Admins muten/entmuten sofort und können nicht per Abstimmung gemutet werden.

## Lokal starten
```bash
npm install
npm start           # http://localhost:3000
npm test            # 1200 simulierte Vollspiele (Regel-/Absturztest)
```
Zum Alleine-Testen: Raum erstellen → „+ Bot" ein-/zweimal → „Spiel starten".

## Konfiguration (zentral in /opt/portriga)

Alle Laufzeit-Einstellungen liegen in **`/opt/portriga/config.json`**. Reihenfolge der
Priorität: eingebaute Defaults < `config.json` < Umgebungsvariablen (`portriga.env`).

```jsonc
{
  "port": 3000,
  "ice": {                       // WebRTC-Voice
    "stun": "stun:stun.l.google.com:19302",
    "turn": null                 // oder: { "url":"turn:deine-domain.de:3478", "user":"portriga", "pass":"…" }
  },
  "chat": { "historyMax": 60, "textMax": 300 },
  "bots": { "moveDelayMs": 700 },   // Zug-Tempo der Bots (ms)
  "game": {
    "ranks": ["A","7","K","D","B","10","9","8"],  // Kartenwertigkeit hoch->niedrig (genau 8, eindeutig)
    "maxPlayers": 63                               // Plätze pro Raum (2–63); > 7 = alternative Variante
  }
}
```
Die **Kartenwertigkeit** (die geflaggte Annahme von der Regelseite) lässt sich hier ohne
Code-Änderung umsortieren. `portriga.env` bleibt für Secrets sinnvoll (z. B. `TURN_PASS`),
da ENV Vorrang hat.

Damit liegt die „Wahrheit" komplett in `/opt/portriga`:
- `config.json` – App-Konfiguration (aus `config.example.json` erzeugt, per Update nicht überschrieben)
- `portriga.env` – Umgebungsvariablen/Secrets (aus `deploy/portriga.env.example`)
- `turnserver.conf` – coturn-Konfig (aus `deploy/coturn-example.conf`); `/etc/turnserver.conf` ist ein Symlink hierauf
- nginx: `/etc/nginx/sites-enabled/portriga` ist ein Symlink auf `deploy/nginx-portriga.conf`

Nach Änderungen an `config.json`/`portriga.env`: `systemctl restart portriga`.
`config.json`, `portriga.env` und `turnserver.conf` sind in `.gitignore` – ein `git pull`
überschreibt deine echten Werte nicht; die Vorlagen (`*.example.*`) werden aktualisiert.

## Sicherheit / Anti-Cheat
Die komplette Spiellogik liegt **serverseitig**. Jeder Client bekommt nur eine redigierte Sicht
(`game.viewFor`): die eigene Hand vollständig, von anderen nur die Kartenanzahl. Karten der
Mitspieler verlassen den Server nie. Legalität jedes Zuges wird serverseitig geprüft.

## Benutzerkonten (Registrierung per Matrix)

Optional. Ohne Konfiguration bleibt alles wie bisher (nur Gäste). Mit Konto ist der Spielername
fest an den Benutzernamen gebunden (✓ in der Lobby); Gäste können registrierte Namen nicht verwenden.

**Registrierung**
1. Benutzername wählen – die Verfügbarkeit wird live geprüft (Groß-/Kleinschreibung egal;
   während einer laufenden Registrierung ist der Name reserviert).
2. Optional ein Passwort (≥ 8 Zeichen) setzen.
3. Die App zeigt einen Code (`PR-XXXX-XXXX`, 15 Min. gültig). Diesen per **Direktnachricht an den
   Portriga-Bot** schicken. Die **Absender-MXID** wird mit dem Konto verknüpft – der Homeserver
   authentifiziert den Absender, das ist der Nachweis, dass die MXID dem User gehört.
4. Die App erkennt die Zustellung automatisch und meldet den User an.

**Anmeldung:** Benutzername *oder* MXID + Passwort, oder **Login-Link per Matrix** (5 Min.,
einmalig). Alternativ dem Bot `login` schreiben. Passwort lässt sich im Konto-Dialog setzen,
ändern oder entfernen; „Auf allen Geräten abmelden“ invalidiert alle Sitzungen.

**Matrix-Konto / -Chat ändern:** im Konto-Dialog unter „Matrix-Konto / -Chat ändern“ (bei
gesetztem Passwort mit Passwortbestätigung) einen Code `MX-XXXX-XXXX` anfordern (15 Min. gültig)
und ihn **von der gewünschten MXID** per DM an den Bot schicken. Absender-MXID und Raum werden neu
verknüpft; kommt der Code von der bisherigen MXID aus einem anderen Chat, wird nur der Raum
gewechselt. Eine MXID, die schon zu einem anderen Konto gehört, wird abgelehnt. Der alte Chat wird
benachrichtigt, der Bot verlässt ihn (sofern kein anderes Konto ihn nutzt); offene Login-Links und
Löschanfragen der alten MXID verfallen.

**Konto löschen:** im Konto-Dialog unter „Konto löschen“ (bei gesetztem Passwort mit
Passwortabfrage). Ist das Konto mit Matrix verknüpft, schickt der Bot einen Bestätigungsbefehl
per DM (`löschen XXXX-XXXX`, 10 Min. gültig, wird auch in der App angezeigt). Erst wenn diese
Nachricht **von der verknüpften MXID** eingeht, wird das Konto endgültig gelöscht; der Bot
verabschiedet sich und **verlässt den DM-Raum** (`room_leave` + `room_forget`). Offene Sitzungen
und Login-Links werden ungültig, der Benutzername ist wieder frei.

**User verlässt den Chat mit dem Bot:** Der Sidecar meldet das Verlassen an die App und verlässt
den dann leeren Raum ebenfalls. Konten **mit Passwort** verlieren nur die Chat-Verknüpfung
(„login“ aus einem neuen Chat stellt sie wieder her). Konten **ohne Passwort**: Existiert noch ein
gültiges Session-Cookie, erzwingt die App beim nächsten Aufruf das Verknüpfen eines neuen Chats
(Code `MX-…` oder „login“ aus dem neuen Chat). Meldet sich der User vorher ab oder läuft das letzte
Cookie ab, wird das Konto gelöscht. Gibt es kein gültiges Cookie mehr, wird es sofort gelöscht.

**Architektur** (Spool-Prinzip wie im KKk58-Sidecar, die Node-App bleibt ohne Matrix-Abhängigkeit):
```
Browser ──HTTP/WS──▶ server.js + accounts.js ──▶ data/matrix-outbox/ ──▶ portriga_matrix_bot.py ──▶ Matrix
                                              ◀── data/matrix-inbox/  ◀──  (E2EE, matrix-nio)   ◀── DM des Users
```
Daten: `data/accounts.json` (Konten, scrypt-Hashes), `data/secret.key` (HMAC für Sessions/Codes).
Beides sichern; `data/` ist in `.gitignore`.

**Einrichtung**
1. Matrix-Konto für den Bot anlegen (z. B. `@portrigabot:example.org`).
2. `WANT_MATRIX=1 ./deploy/provision.sh` (oder manuell: `apt install python3-pip libolm-dev`,
   `pip install "matrix-nio[e2e]" --break-system-packages`, Unit aus `deploy/matrix/` installieren).
3. `/opt/portriga/matrix/portriga-matrix.env` aus `deploy/matrix/env.example` ausfüllen.
4. In `config.json`:
   ```json
   "accounts": { "botMxid": "@portrigabot:example.org", "publicUrl": "https://spiel.example.org" }
   ```
   `publicUrl` (inkl. Basis-Pfad) ist Pflicht für Login-Links – sie werden bewusst **nicht** aus
   Host-Headern abgeleitet (sonst per Header-Spoofing auf fremde Domains umlenkbar).
5. `systemctl restart portriga && systemctl enable --now portriga-matrix`

Hinweise: Mit `PORTRIGA_REQUIRE_ENCRYPTION=1` (Standard) antwortet der Bot nur in
E2E-verschlüsselten Chats; eingehende Codes werden trotzdem angenommen. Den Schlüsselspeicher
`/opt/portriga/matrix-store` sichern – geht er verloren, muss sich der Bot neu anmelden
(Passwort erneut in die env-Datei). Tests: `npm test` (inkl. `test/accounts.test.js`, simuliert den Bot).

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

## Ankündigungsraum auf Matrix (neue Spiele)
Optional postet der Matrix-Bot jedes neu eröffnete **öffentliche** und **Ranglisten**-Spiel in einen
öffentlichen Matrix-Raum – mit Raumcode, Ersteller, Belegung und Direktlink (`?join=CODE`). Auch ein
privater Raum, der in der Lobby auf „Öffentlich“/„Rangliste“ umgestellt wird, wird angekündigt;
jeder Raum aber nur einmal. Private Räume erscheinen nie.

Einrichtung:
1. In Matrix einen **öffentlichen, unverschlüsselten** Raum anlegen (z. B. `#portriga-spiele:example.org`),
   Beitritt für alle erlauben, den Bot-Account einladen oder beitreten lassen und ihm Schreibrecht geben.
   Empfehlung: Bot ohne Moderator-/Admin-Rechte (dann kann er kein `@room` auslösen); Spielernamen werden
   zusätzlich entschärft.
2. Node-App: `announce.room` in `config.json` bzw. `PORTRIGA_ANNOUNCE_ROOM` in `portriga.env` setzen
   (Raum-ID `!…:server` oder Alias `#…:server`). `accounts.publicUrl` sollte gesetzt sein, sonst enthält
   die Ankündigung nur den Raumcode statt eines Links.
3. Sidecar: denselben Wert als `PORTRIGA_ANNOUNCE_ROOM` in `portriga-matrix.env` eintragen.
4. `systemctl restart portriga portriga-matrix`

Sicherheit: Der Sidecar sendet unverschlüsselt **ausschließlich** Aufträge mit `"announce": true` und
nur in genau diesen konfigurierten Raum (`m.notice`). Alle Konto-Nachrichten (Login-Links, Codes) bleiben
bei `PORTRIGA_REQUIRE_ENCRYPTION=1` auf verschlüsselte DMs beschränkt und werden nie in den Ankündigungsraum
geschickt. Nachrichten und Austritte im Ankündigungsraum werden ignoriert (keine Befehle aus der Öffentlichkeit).
Spam-Schutz: je Ersteller (Konto bzw. IP) max. eine Ankündigung pro `announce.perCreatorSec` (Standard 0 = aus; z. B. `300` = eine pro 5 Minuten),
insgesamt max. `announce.maxPerHour` (Standard 30).

Werbung für den Raum: Ist der Raum konfiguriert, zeigt die App auf dem Startbildschirm und in der Lobby einen
Hinweis mit Link (`announce.link`, Standard `https://matrix.to/#/<Raum>`), und die Willkommensnachricht nach
der Registrierung nennt den Raum. `GET /api/announce` liefert `{ enabled, room, link }`.

## Voice-Chat (WebRTC-Mesh)

Sprach-Chat läuft als **WebRTC-Mesh** (jeder mit jedem), passend für 2–7 Spieler. Der
vorhandene WebSocket-Server dient nur als **Signaling** (SDP/ICE werden an genau einen
Mitspieler im selben Raum weitergereicht; der Absender wird serverseitig gesetzt und ist
nicht fälschbar). Audio fließt direkt zwischen den Browsern, nicht über den Server.
Verbindungsaufbau nach dem *Perfect-Negotiation*-Muster; Mute und eine einfache
Sprech-Anzeige (WebAudio) sind eingebaut.

**Zwei harte Voraussetzungen:**
1. **HTTPS ist Pflicht.** `getUserMedia` (Mikrofon) funktioniert nur im sicheren Kontext
   (Ausnahme: `http://localhost` beim lokalen Test). Für den Betrieb also nginx mit
   Zertifikat (siehe HTTPS-Hinweis oben).
2. **TURN-Server (coturn) für zuverlässige Verbindungen.** Reines STUN scheitert, sobald
   jemand hinter symmetrischem NAT/CGNAT sitzt.

**coturn einrichten (im selben oder einem eigenen LXC):**
```bash
apt-get install -y coturn
# TURNSERVER_ENABLED=1 in /etc/default/coturn setzen
cp /opt/portriga/deploy/coturn-example.conf /etc/turnserver.conf   # dann Werte anpassen
systemctl enable --now coturn
```
Anschließend dem Node-Dienst die ICE-Daten geben – `deploy/portriga.env.example` nach
`/opt/portriga/portriga.env` kopieren, `TURN_URL/TURN_USER/TURN_PASS` setzen (müssen mit
`user=`/`realm=` in `turnserver.conf` übereinstimmen), dann `systemctl restart portriga`.
Der Server liefert die ICE-Konfiguration automatisch an die Clients.

**Freizugebende Ports (Firewall/LXC/Router):** `3478/udp`+`3478/tcp` (TURN/STUN),
optional `5349/tcp` (TURN über TLS), sowie der Medien-Relay-Bereich `49152-65535/udp`.

**Grenzen (bewusst):** Mesh skaliert nur für kleine Runden – bei 7 Teilnehmern hält jeder
~6 Audioverbindungen (überschlägig 150–250 kbit/s je Richtung). Bots nehmen nicht teil.
Bricht die WebSocket-Verbindung ab, endet Voice und muss neu beigetreten werden. Eine
Fern-Stumm-Anzeige (ob andere sich stummgeschaltet haben) gibt es nicht, nur die eigene.
Getestet ist bisher die Signalisierung automatisiert; die Medien-/Mikrofon-Ebene muss mit
zwei echten Browsern über HTTPS geprüft werden.

## Lizenz
GPL-3.0-or-later.

---

# Portriga – Online Card Game

*English translation of the German README above.*

Server-authoritative multiplayer card game (trick prediction) following the rules at
<http://portriga.bplaced.net/>. Node.js + WebSockets, no database.
Deployed as a Proxmox Debian LXC.

Includes a **room chat** (usable in lobby and game): a collapsible panel with history
(preserved on reconnect), unread counter and subtle system messages (joins, game start).
The history is kept in RAM only and limited to the last 60 messages.
There is also a **voice chat** as a WebRTC mesh (details below).

## Game modes
When creating a room, the host chooses the mode (changeable in the lobby at any time):
- **Private** – as before: join only via code, direct link or QR code.
- **Public** – the room appears on the start screen in the “open rooms” list; anyone (including guests) can join.
- **Ranked** – also listed, but only for registered accounts and without bots. The final result is stored in
  `<dataDir>/ranking.json` (rating, games, wins, average points, best score). Sorted by rating: per game
  `(points − points of last place) × number of players / 10` (last place = 0), summed up. and is available via “🏅 Rangliste” or
  `GET /api/ranking`. Requires user accounts to be enabled.
  Optionally (at registration or in the account settings) the Matrix bot messages you in your private chat
  whenever your ranking position changes – including when others overtake you.

## Implemented rules
- 2 Skat decks = 64 cards (each card twice), 2–7 players; more with the **alternative variant** (default limit 63, restrictable via `game.maxPlayers`).
- Sequence of cards per player per round: **1→7 ascending, then 8 exactly *N* times (N = number of players), then 7→1 descending.** The dealer moves clockwise each round.
- Alternative variant (> 7 players): maximum card count M = 64 / N rounded down, minus 1 if it divides evenly (= `floor(63/N)`): 8 → 7, 9 → 7, 10 → 6, 12 → 5. Round sequence is then 1→M−1, M exactly N times, M−1→1.
- After dealing, one card is turned up as **trump** (valid for the whole round).
- **Bidding** in turn starting left of the dealer, dealer last (0 up to the number of cards).
- The first bidder leads the first trick; afterwards the winner of the previous trick leads.
- **Follow suit + must trump:** follow the led suit if you can; otherwise play trump if you have one; otherwise play anything.
- **Special rule “the 2nd beats the 1st”**: with cards of equal value, the one played *later* wins the trick.
- **Scoring:** bid met exactly → `10 + tricks·3` (also for 0). Missed → `−|bid − tricks|·3`.
- Whoever has the most points after the last round wins.

### Deliberate assumptions (the rules page is not 100 % unambiguous)
1. **Card ranking** = picture order on the rules page: **Ace, 7, King, Queen, Jack, 10, 9, 8** (Ace highest). If that was only display order and not ranking: reorder the constant `RANKS` in `game.js` – one line.
2. **Must trump** interpreted as “follow suit, otherwise trump, otherwise free” (the common reading of “Bedienzwang + Trumpfzwang”). Changeable in `game.legalCards()`.

Not implemented (deliberately, since not required by the rules): a “sum of bids ≠ number of tricks” restriction for the dealer. Bots are only a simple placeholder for solo testing, not a strong AI.

## Project structure
```
config.json         central configuration (from config.example.json)
game.js            rules engine (pure, testable)
bots.js            simple placeholder bot
server.js          Express + WebSocket, rooms, bot control, reconnect
accounts.js        user accounts: registration via Matrix DM, login, sessions
announce.js        announcement of new public/ranked games in the Matrix room
ranking.js         leaderboard for ranked rooms (data/ranking.json)
admins.js          admin role (data/admins.json), admin-cli.js = management via terminal
config.js          configuration loading (config.json + ENV)
public/            frontend (index.html, style.css, app.js) + regeln.html (standalone rules page)
test/simulate.js   headless full-game simulation (npm test)
deploy/            Proxmox LXC + systemd + nginx + coturn/ENV (voice)
deploy/matrix/     Matrix bot (sidecar) for registration, login links and game announcements
```

## Kicking players & admin role
In the lobby, anyone can put a fellow player up for a **vote kick**. All connected humans except the
affected player may vote; the player is kicked with **more than 50 % yes** (60 s time limit). Kicked
players cannot rejoin the room.

**Admins** kick immediately without a vote and cannot be removed by vote kick themselves. The role
is tied to a (registered) account and can only be assigned via terminal:
```bash
cd /opt/portriga
sudo -u portriga node admin-cli.js add <username>     # grant role
sudo -u portriga node admin-cli.js remove <username>  # revoke role
sudo -u portriga node admin-cli.js list               # list admins
```
Stored in `data/admins.json` (account ID); the running server picks up changes without a restart.

## Muting players (text & voice chat)
In the lobby and during a game, anyone can put a fellow player up for a **mute vote** via 🔇 in the room chat.
All connected humans except the affected player may vote; takes effect with **more than 50 % yes** (60 s time limit).
If only **2 players** are in the room, the mute applies immediately. Unmuting works the same way.

Muted players cannot write; in voice they may only listen (their audio is muted for all receivers,
their microphone is disabled client-side). The mute applies to the room and persists across
reconnect/rejoin. Admins mute/unmute immediately and cannot be muted by vote.

## Running locally
```bash
npm install
npm start           # http://localhost:3000
npm test            # 1200 simulated full games (rules/crash test)
```
For solo testing: create a room → “+ Bot” once or twice → “Spiel starten” (start game).

## Configuration (central in /opt/portriga)

All runtime settings live in **`/opt/portriga/config.json`**. Order of
precedence: built-in defaults < `config.json` < environment variables (`portriga.env`).

```jsonc
{
  "port": 3000,
  "ice": {                       // WebRTC voice
    "stun": "stun:stun.l.google.com:19302",
    "turn": null                 // or: { "url":"turn:your-domain.com:3478", "user":"portriga", "pass":"…" }
  },
  "chat": { "historyMax": 60, "textMax": 300 },
  "bots": { "moveDelayMs": 700 },   // bot move speed (ms)
  "game": {
    "ranks": ["A","7","K","D","B","10","9","8"],  // card ranking high->low (exactly 8, unique)
    "maxPlayers": 63                               // seats per room (2–63); > 7 = alternative variant
  }
}
```
The **card ranking** (the flagged assumption from the rules page) can be reordered here without
code changes. `portriga.env` remains useful for secrets (e.g. `TURN_PASS`),
since ENV takes precedence.

This puts the entire “source of truth” in `/opt/portriga`:
- `config.json` – app configuration (generated from `config.example.json`, not overwritten by updates)
- `portriga.env` – environment variables/secrets (from `deploy/portriga.env.example`)
- `turnserver.conf` – coturn config (from `deploy/coturn-example.conf`); `/etc/turnserver.conf` is a symlink to it
- nginx: `/etc/nginx/sites-enabled/portriga` is a symlink to `deploy/nginx-portriga.conf`

After changing `config.json`/`portriga.env`: `systemctl restart portriga`.
`config.json`, `portriga.env` and `turnserver.conf` are in `.gitignore` – a `git pull`
does not overwrite your real values; the templates (`*.example.*`) get updated.

## Security / anti-cheat
All game logic runs **server-side**. Each client only receives a redacted view
(`game.viewFor`): its own hand in full, only the card count of others. Other players'
cards never leave the server. The legality of every move is checked server-side.

## User accounts (registration via Matrix)

Optional. Without configuration everything stays as before (guests only). With an account, the player name
is permanently bound to the username (✓ in the lobby); guests cannot use registered names.

**Registration**
1. Choose a username – availability is checked live (case-insensitive;
   the name is reserved while a registration is in progress).
2. Optionally set a password (≥ 8 characters).
3. The app shows a code (`PR-XXXX-XXXX`, valid for 15 min). Send it as a **direct message to the
   Portriga bot**. The **sender MXID** is linked to the account – the homeserver
   authenticates the sender, which proves that the MXID belongs to the user.
4. The app detects the delivery automatically and logs the user in.

**Login:** username *or* MXID + password, or a **login link via Matrix** (5 min,
single use). Alternatively write `login` to the bot. The password can be set, changed or
removed in the account dialog; “Sign out on all devices” invalidates all sessions.

**Changing the Matrix account / chat:** in the account dialog under “Matrix-Konto / -Chat ändern”
(with password confirmation if a password is set), request a code `MX-XXXX-XXXX` (valid for 15 min)
and send it **from the desired MXID** as a DM to the bot. Sender MXID and room are re-linked;
if the code comes from the existing MXID but a different chat, only the room is switched.
An MXID already belonging to another account is rejected. The old chat is notified and the
bot leaves it (unless another account uses it); pending login links and deletion requests of
the old MXID expire.

**Deleting an account:** in the account dialog under “Konto löschen” (with password prompt
if a password is set). If the account is linked to Matrix, the bot sends a confirmation command
via DM (`löschen XXXX-XXXX`, valid for 10 min, also shown in the app). Only once this
message arrives **from the linked MXID** is the account permanently deleted; the bot
says goodbye and **leaves the DM room** (`room_leave` + `room_forget`). Open sessions
and login links become invalid, and the username is free again.

**User leaves the chat with the bot:** the sidecar reports the departure to the app and also leaves
the now-empty room. Accounts **with a password** only lose the chat link
(“login” from a new chat restores it). Accounts **without a password**: if a valid
session cookie still exists, the app forces linking a new chat on the next visit
(code `MX-…` or “login” from the new chat). If the user logs out first or the last
cookie expires, the account is deleted. If there is no valid cookie left, it is deleted immediately.

**Architecture** (spool principle as in the KKk58 sidecar; the Node app has no Matrix dependency):
```
Browser ──HTTP/WS──▶ server.js + accounts.js ──▶ data/matrix-outbox/ ──▶ portriga_matrix_bot.py ──▶ Matrix
                                              ◀── data/matrix-inbox/  ◀──  (E2EE, matrix-nio)   ◀── user's DM
```
Data: `data/accounts.json` (accounts, scrypt hashes), `data/secret.key` (HMAC for sessions/codes).
Back up both; `data/` is in `.gitignore`.

**Setup**
1. Create a Matrix account for the bot (e.g. `@portrigabot:example.org`).
2. `WANT_MATRIX=1 ./deploy/provision.sh` (or manually: `apt install python3-pip libolm-dev`,
   `pip install "matrix-nio[e2e]" --break-system-packages`, install the unit from `deploy/matrix/`).
3. Fill in `/opt/portriga/matrix/portriga-matrix.env` from `deploy/matrix/env.example`.
4. In `config.json`:
   ```json
   "accounts": { "botMxid": "@portrigabot:example.org", "publicUrl": "https://spiel.example.org" }
   ```
   `publicUrl` (including base path) is mandatory for login links – they are deliberately **not** derived
   from host headers (otherwise they could be redirected to foreign domains via header spoofing).
5. `systemctl restart portriga && systemctl enable --now portriga-matrix`

Notes: with `PORTRIGA_REQUIRE_ENCRYPTION=1` (default) the bot only replies in
end-to-end encrypted chats; incoming codes are accepted regardless. Back up the key store
`/opt/portriga/matrix-store` – if it is lost, the bot has to log in again
(put the password back into the env file). Tests: `npm test` (incl. `test/accounts.test.js`, simulates the bot).

## Deployment as a Proxmox Debian 13 LXC (Trixie)

### 1. Create the container (on the Proxmox host, as root)
```bash
# values can be overridden via env
CTID=140 MEMORY=1024 CORES=2 BRIDGE=vmbr0 ./deploy/proxmox-create-lxc.sh
```
The script downloads the Debian 13 template if needed, creates an unprivileged container
and starts it. Then note the container IP:
```bash
pct exec 140 -- ip -4 addr show eth0 | grep inet
```

### 2. Get the app into the container – two ways

**a) Via Git (if you publish the repo, e.g. as Simon0Harms):**
```bash
pct exec 140 -- bash -c 'apt-get update && apt-get install -y git \
  && git clone <YOUR_REPO_URL> /opt/portriga'
```

**b) By copying from the Proxmox host (without Git):**
```bash
# build an archive without node_modules in the project folder
tar --exclude=node_modules --exclude=.git -czf /tmp/portriga.tar.gz -C . .
pct exec 140 -- mkdir -p /opt/portriga
pct push 140 /tmp/portriga.tar.gz /opt/portriga/portriga.tar.gz
pct exec 140 -- tar -xzf /opt/portriga/portriga.tar.gz -C /opt/portriga
pct exec 140 -- rm /opt/portriga/portriga.tar.gz
```

### 3. Provisioning (inside the container)
```bash
# Node + service on port 3000 only:
pct exec 140 -- bash /opt/portriga/deploy/provision.sh

# OR with nginx reverse proxy on port 80 (recommended):
pct exec 140 -- bash -c 'WANT_NGINX=1 bash /opt/portriga/deploy/provision.sh'
```
Afterwards reachable at `http://<container-ip>/` (with nginx) or `:3000` (without).

> **Node.js on Debian 13:** by default Node 20 LTS is installed from the Debian repo
> (sufficient for this app). For a newer LTS line: `USE_NODESOURCE=1 NODE_MAJOR=22 bash …provision.sh`.
> The provision script deliberately uses the keyring/deb822 approach instead of the `setup_x.x` script, because
> the latter can fail on Trixie due to the old SHA-1 repo key (Debian 13 verifies with `sqv`, without SHA-1).

### Operation
```bash
pct exec 140 -- systemctl status portriga
pct exec 140 -- journalctl -u portriga -f
pct exec 140 -- systemctl restart portriga
```
Updating: bring the new files to `/opt/portriga`, then
`systemctl restart portriga` (if dependencies changed, run `npm ci --omit=dev` first).

### HTTPS
State lives in RAM only – a restart ends running games. For public operation,
extend `nginx-portriga.conf` with a certificate (certbot/ACME) and add `listen 443 ssl;`.

## Announcement room on Matrix (new games)
Optionally the Matrix bot posts every newly opened **public** and **ranked** game to a public Matrix room –
with room code, creator, seats taken and a direct link (`?join=CODE`). A private room switched to
"Public"/"Ranked" in the lobby is announced too, but each room only once. Private rooms never appear.

Setup:
1. Create a **public, unencrypted** Matrix room (e.g. `#portriga-spiele:example.org`), allow anyone to join,
   invite the bot account and give it permission to post. Recommended: no moderator/admin rights for the bot
   (so it cannot trigger `@room`); player names are sanitised as well.
2. Node app: set `announce.room` in `config.json` or `PORTRIGA_ANNOUNCE_ROOM` in `portriga.env`
   (room ID `!…:server` or alias `#…:server`). `accounts.publicUrl` should be set, otherwise the
   announcement only contains the room code instead of a link.
3. Sidecar: put the same value into `PORTRIGA_ANNOUNCE_ROOM` in `portriga-matrix.env`.
4. `systemctl restart portriga portriga-matrix`

Security: the sidecar sends unencrypted **only** jobs marked `"announce": true` and only to exactly this
configured room (`m.notice`). All account messages (login links, codes) stay restricted to encrypted DMs with
`PORTRIGA_REQUIRE_ENCRYPTION=1` and are never sent to the announcement room. Messages and leaves in the
announcement room are ignored (no commands from the public). Spam protection: per creator (account or IP) at
most one announcement per `announce.perCreatorSec` (default 0 = off; e.g. `300` = one per 5 minutes), at most `announce.maxPerHour` overall (default 30).

Promoting the room: once configured, the app shows a note with a link on the start screen and in the lobby
(`announce.link`, default `https://matrix.to/#/<room>`), and the welcome message after registration mentions
the room. `GET /api/announce` returns `{ enabled, room, link }`.

## Voice chat (WebRTC mesh)

Voice chat runs as a **WebRTC mesh** (everyone with everyone), suitable for 2–7 players. The
existing WebSocket server only serves as **signaling** (SDP/ICE are forwarded to exactly one
fellow player in the same room; the sender is set server-side and cannot be
spoofed). Audio flows directly between browsers, not through the server.
Connection setup follows the *Perfect Negotiation* pattern; mute and a simple
speaking indicator (WebAudio) are built in.

**Two hard requirements:**
1. **HTTPS is mandatory.** `getUserMedia` (microphone) only works in a secure context
   (exception: `http://localhost` for local testing). For operation, use nginx with a
   certificate (see the HTTPS note above).
2. **TURN server (coturn) for reliable connections.** Plain STUN fails as soon as
   someone is behind symmetric NAT/CGNAT.

**Setting up coturn (in the same or a separate LXC):**
```bash
apt-get install -y coturn
# set TURNSERVER_ENABLED=1 in /etc/default/coturn
cp /opt/portriga/deploy/coturn-example.conf /etc/turnserver.conf   # then adjust values
systemctl enable --now coturn
```
Then give the Node service the ICE data – copy `deploy/portriga.env.example` to
`/opt/portriga/portriga.env`, set `TURN_URL/TURN_USER/TURN_PASS` (must match
`user=`/`realm=` in `turnserver.conf`), then `systemctl restart portriga`.
The server delivers the ICE configuration to the clients automatically.

**Ports to open (firewall/LXC/router):** `3478/udp`+`3478/tcp` (TURN/STUN),
optionally `5349/tcp` (TURN over TLS), plus the media relay range `49152-65535/udp`.

**Limits (deliberate):** a mesh only scales for small groups – with 7 participants each holds
~6 audio connections (roughly 150–250 kbit/s per direction). Bots do not take part.
If the WebSocket connection drops, voice ends and has to be rejoined. There is no remote
mute indicator (whether others have muted themselves), only your own.
So far only the signaling has been tested automatically; the media/microphone layer must be verified with
two real browsers over HTTPS.

## License
GPL-3.0-or-later.
