'use strict';
/*
 * Portriga – Sprachumschaltung Deutsch/Englisch (Issue #11).
 *
 * Die Oberfläche ist auf Deutsch geschrieben (Quelltext, Server-Meldungen).
 * Ist Englisch gewählt, übersetzt dieses Skript alle sichtbaren Texte und
 * Attribute (placeholder, title, aria-label, alt) anhand eines Wörterbuchs
 * (exakte Texte + Muster für Texte mit Namen/Zahlen). Ein MutationObserver
 * erfasst auch dynamisch erzeugte Texte aus app.js und Server-Meldungen.
 * Der deutsche Originaltext wird je Knoten gemerkt, sodass jederzeit ohne
 * Neuladen zurückgeschaltet werden kann.
 *
 * Nicht übersetzt werden: Chat-Nachrichten von Spielern, Eingabefelder,
 * Raumcodes, Benutzernamen/Matrix-IDs.
 */
(function () {
  const LS_KEY = 'portriga_lang';
  const SUPPORTED = ['de', 'en'];

  function initialLang() {
    try { const s = localStorage.getItem(LS_KEY); if (SUPPORTED.includes(s)) return s; } catch (_) {}
    const q = new URLSearchParams(location.search).get('lang');
    if (SUPPORTED.includes(q)) return q;
    const nav = (navigator.languages && navigator.languages[0]) || navigator.language || 'de';
    return /^de\b/i.test(nav) ? 'de' : 'en';
  }
  let lang = initialLang();

  // ---------------------------------------------------------------- Wörterbuch
  const EXACT = {
    // Startseite
    'Portriga – Online': 'Portriga – Online',
    'Stichvorhersage-Kartenspiel · 2–7 Spieler (mehr mit alternativer Variante)': 'Trick-prediction card game · 2–7 players (more with the alternative variant)',
    'Spiel als Gast – oder': 'Play as guest – or',
    'anmelden': 'sign in', 'registrieren': 'register',
    'Angemeldet als': 'Signed in as',
    'Matrix-verifiziert': 'Matrix-verified',
    'Konto': 'Account', 'Abmelden': 'Sign out',
    'Dein Name': 'Your name', 'Spieler': 'Player',
    'Spielmodus': 'Game mode',
    'Privat – nur mit Code/Link': 'Private – code/link only',
    'Öffentlich – in der Raumliste, alle dürfen mitspielen': 'Public – listed, anyone may join',
    'Rangliste – nur angemeldete Konten, zählt für die Rangliste': 'Ranked – signed-in accounts only, counts for the leaderboard',
    'Raum erstellen': 'Create room',
    'oder beitreten': 'or join', 'CODE': 'CODE', 'Beitreten': 'Join',
    'offene Räume': 'open rooms',
    'Keine öffentlichen Räume offen.': 'No public rooms open.',
    '🏅 Rangliste anzeigen': '🏅 Show leaderboard',
    '🏅 Rangliste ausblenden': '🏅 Hide leaderboard',
    '#': '#', 'Siege': 'Wins', 'Spiele': 'Games', 'Ø Punkte': 'Avg. points', 'Best': 'Best',
    'Noch keine Ranglisten-Spiele.': 'No ranked games yet.',
    '📖 Spielregeln': '📖 Rules',
    'Ideen oder Fehler gefunden?': 'Ideas or found a bug?',
    'Verbesserungsvorschläge auf GitHub': 'Suggestions on GitHub',
    'Nur mit angemeldetem Konto': 'Signed-in accounts only',
    '🔒 Privat': '🔒 Private', '🌐 Öffentlich': '🌐 Public', '🏅 Rangliste': '🏅 Ranked',
    'Privat': 'Private', 'Öffentlich': 'Public', 'Rangliste': 'Ranked',

    // Lobby
    'Lobby': 'Lobby', 'Raumcode:': 'Room code:', 'kopieren': 'copy',
    'Direktlink:': 'Direct link:', 'QR-Code zum Beitreten': 'QR code to join',
    '+ Bot': '+ Bot', '– Bot': '– Bot', 'Spiel starten': 'Start game',
    'Raum verlassen': 'Leave room',
    'Bot': 'Bot', 'Host': 'Host', 'Admin': 'Admin',
    'registriertes Konto (Matrix-verifiziert)': 'registered account (Matrix-verified)',
    'Kicken': 'Kick', 'Votekick': 'Vote kick',
    'Sofort aus dem Raum entfernen (Admin)': 'Remove from room immediately (admin)',
    'Abstimmung zum Kicken starten (mehr als 50 % Ja nötig)': 'Start a kick vote (more than 50 % yes needed)',
    'Bereit – du kannst starten.': 'Ready – you can start.',
    'Warte auf den Host…': 'Waiting for the host…',
    'Link kopiert.': 'Link copied.', 'Code kopiert.': 'Code copied.', 'Kopiert.': 'Copied.',

    // Spiel
    'Runde': 'Round', 'Karten:': 'Cards:', 'Trumpf:': 'Trump:', 'Stiche:': 'Tricks:',
    '📖 Regeln': '📖 Rules', 'Spielregeln (neues Fenster)': 'Rules (new window)', 'Spielregeln': 'Rules',
    'Vollbild': 'Fullscreen', 'Vollbild umschalten': 'Toggle fullscreen', 'Vollbild beenden': 'Exit fullscreen',
    'Letzter Stich': 'Last trick',
    'Wie viele Stiche machst du?': 'How many tricks will you take?',
    '(auch 0 ist eine Ansage)': '(0 is a valid bid too)',
    'Schließen': 'Close', 'Zurück zum Start': 'Back to start',
    'Geber': 'Dealer',
    'Du bist dran: Stiche ansagen': 'Your turn: bid your tricks',
    'Du bist dran: Karte spielen': 'Your turn: play a card',
    '🏆 Spielende': '🏆 Game over',
    'Spiel starten?': 'Start game?', 'Nächste Runde starten?': 'Start next round?',
    'Zeit angehalten – wartet, bis alle Nein-Stimmen auf Ja wechseln.': 'Timer paused – waiting until all no votes change to yes.',
    'Ohne Nein-Stimme startet es nach Ablauf der Zeit automatisch.': 'Without a no vote it starts automatically when time runs out.',
    'Ja': 'Yes', 'Nein': 'No',
    'Über dich wird abgestimmt – du bist nicht stimmberechtigt.': 'This vote is about you – you cannot vote.',
    'kreuz': 'clubs', 'pik': 'spades', 'herz': 'hearts', 'karo': 'diamonds',

    // Voice & Chat
    '🎤 Voice beitreten': '🎤 Join voice',
    'Mikrofon stummschalten': 'Mute microphone', 'Voice verlassen': 'Leave voice',
    '🔇 Stumm': '🔇 Mute', '🔈 Laut': '🔈 Unmute', 'Verlassen': 'Leave',
    'Du': 'You', 'stumm': 'muted', 'stumm (Abst.)': 'muted (vote)',
    'verbunden': 'connected', 'verbinde…': 'connecting…', 'getrennt': 'disconnected',
    'fehlgeschlagen': 'failed', 'zu': 'closed',
    'Chat': 'Chat', 'Raum-Chat': 'Room chat',
    'Spieler stummschalten (Text & Voice)': 'Mute players (text & voice)',
    'Minimieren': 'Minimize',
    'Stummschalten gilt für Text- und Sprachchat. Nötig: mehr als 50 % Ja – bei nur 2 Spielern sofort.': 'Muting applies to text and voice chat. Requires more than 50 % yes – immediate with only 2 players.',
    'Nachricht…': 'Message…', 'Senden': 'Send',
    'Du bist stummgeschaltet': 'You are muted',
    'Entmuten': 'Unmute', 'Muten': 'Mute',
    'Sofort (Admin)': 'Immediately (admin)',
    'Abstimmung starten (mehr als 50 % Ja; bei 2 Spielern sofort)': 'Start a vote (more than 50 % yes; immediate with 2 players)',
    'Keine Mitspieler.': 'No other players.',
    'Mikrofon nicht verfügbar (HTTPS nötig).': 'Microphone not available (HTTPS required).',
    'Mikrofonzugriff verweigert oder kein HTTPS.': 'Microphone access denied or no HTTPS.',
    'Du bist stummgeschaltet und kannst das Mikrofon nicht aktivieren.': 'You are muted and cannot enable the microphone.',
    '🔇 Du wurdest im Text- und Sprachchat stummgeschaltet.': '🔇 You have been muted in text and voice chat.',
    '🔈 Du bist wieder freigeschaltet.': '🔈 You have been unmuted.',
    'Vollbild wird von diesem Browser nicht erlaubt.': 'This browser does not allow fullscreen.',
    'Vollbild wird von diesem Browser nicht unterstützt.': 'This browser does not support fullscreen.',

    // Hinweise/Toasts (Client)
    'Verbinde… die Aktion wird gleich ausgeführt.': 'Connecting… the action will run shortly.',
    'Raum geschlossen': 'Room closed',
    'Du wurdest aus dem Raum entfernt.': 'You were removed from the room.',
    'Rangliste konnte nicht geladen werden.': 'Could not load the leaderboard.',
    'Bitte 4-stelligen Code eingeben.': 'Please enter a 4-character code.',
    'Namen eingeben und „Beitreten“ drücken.': 'Enter a name and press “Join”.',

    // Gast-Hinweis Rangliste
    '🏅 Ranglisten-Spiel': '🏅 Ranked game',
    'Ranglisten-Spielen können nur registrierte Benutzer beitreten – nur so lassen sich die Ergebnisse eindeutig deinem Konto in der Rangliste zuordnen.': 'Only registered users can join ranked games – that is the only way to attribute results unambiguously to your account on the leaderboard.',
    'Möchtest du dir ein Konto erstellen?': 'Would you like to create an account?',
    'Konto erstellen': 'Create account', 'Ich habe schon ein Konto': 'I already have an account',
    'Abbrechen': 'Cancel',

    // Konto-Dialog
    'Anmelden': 'Sign in',
    'Benutzername oder Matrix-ID': 'Username or Matrix ID',
    'name oder @name:server': 'name or @name:server',
    'Passwort': 'Password', '(falls gesetzt)': '(if set)',
    'Login-Link per Matrix': 'Login link via Matrix',
    'Noch kein Konto?': 'No account yet?', 'Registrieren': 'Register',
    'Benutzername': 'Username', '3–20 Zeichen': '3–20 characters',
    '(optional – ohne Passwort meldest du dich per Matrix-Link an)': '(optional – without a password you sign in via Matrix link)',
    'mind. 8 Zeichen': 'at least 8 characters',
    'Passwort wiederholen': 'Repeat password', 'Weiter': 'Next',
    'Schreibe dem Matrix-Bot eine': 'Send the Matrix bot a',
    'Direktnachricht': 'direct message', 'mit diesem Code:': 'with this code:',
    'Bot:': 'Bot:',
    'Deine Matrix-ID (Absender der Nachricht) wird mit dem Konto verknüpft und kann zum Anmelden genutzt werden. Gültig noch': 'Your Matrix ID (sender of the message) is linked to the account and can be used to sign in. Valid for',
    '⏳ Warte auf deine Nachricht…': '⏳ Waiting for your message…',
    'Neuen Matrix-Chat verbinden': 'Connect a new Matrix chat',
    'Du hast den Chat mit dem Portriga-Bot verlassen. Da dein Konto kein Passwort hat, musst du einen neuen Chat mit dem Bot verknüpfen, um weiterzuspielen.': 'You left the chat with the Portriga bot. Since your account has no password, you must link a new chat with the bot to keep playing.',
    'Meldest du dich ab, ohne neu zu verknüpfen, wird das Konto gelöscht.': 'If you sign out without relinking, the account will be deleted.',
    'Abmelden & Konto löschen': 'Sign out & delete account',
    'Benutzername:': 'Username:', 'Matrix-ID:': 'Matrix ID:',
    'Aktuelles Passwort': 'Current password',
    'Neues Passwort': 'New password', 'Passwort setzen': 'Set password',
    '(leer = Passwort entfernen)': '(empty = remove password)',
    'Passwort speichern': 'Save password',
    'Auf allen Geräten abmelden': 'Sign out on all devices',
    'Matrix-Konto / -Chat ändern': 'Change Matrix account / chat',
    'Verknüpfe dein Konto mit einer anderen Matrix-ID oder einem neuen Chat mit dem Bot. Du erhältst einen Code, den du von der gewünschten Matrix-ID per Direktnachricht an den Bot schickst.': 'Link your account to a different Matrix ID or a new chat with the bot. You get a code that you send to the bot by direct message from the desired Matrix ID.',
    'Passwort zur Bestätigung': 'Password to confirm',
    'Code anfordern': 'Request code',
    'Schreibe': 'Write to', 'von der gewünschten Matrix-ID': 'from the desired Matrix ID',
    'in dem gewünschten Chat:': 'in the desired chat:',
    'Gleiche Matrix-ID aus einem neuen Chat = nur Chat-Wechsel. Gültig noch': 'Same Matrix ID from a new chat = chat change only. Valid for',
    'Konto löschen': 'Delete account',
    'Das Konto wird endgültig gelöscht. Ist es mit Matrix verknüpft, musst du die Löschung per Direktnachricht an den Bot bestätigen; danach verlässt der Bot den Chat.': 'The account will be deleted permanently. If it is linked to Matrix, you must confirm the deletion by direct message to the bot; the bot then leaves the chat.',
    'Konto löschen…': 'Delete account…',
    'per Matrix-Direktnachricht:': 'via Matrix direct message:',
    'Der Bot hat dir den Befehl auch direkt geschickt. Gültig noch': 'The bot has also sent you the command directly. Valid for',
    'Prüfe…': 'Checking…',
    'Passwort: mindestens 8 Zeichen.': 'Password: at least 8 characters.',
    'Passwörter stimmen nicht überein.': 'Passwords do not match.',
    'Benutzername oder Matrix-ID eingeben.': 'Enter username or Matrix ID.',
    'Falls ein Konto existiert, wurde dir ein Login-Link per Matrix geschickt.': 'If an account exists, a login link has been sent to you via Matrix.',
    '✗ Code abgelaufen – bitte neu starten.': '✗ Code expired – please start again.',
    '✗ Code abgelaufen – bitte neu anfordern.': '✗ Code expired – please request a new one.',
    'Bitte ein Passwort eingeben.': 'Please enter a password.',
    'Passwort gespeichert.': 'Password saved.', 'Passwort entfernt.': 'Password removed.',
    'Überall abgemeldet.': 'Signed out everywhere.', 'Abgemeldet.': 'Signed out.',
    'Abgemeldet – dein Konto wurde gelöscht.': 'Signed out – your account was deleted.',
    'Abgebrochen.': 'Cancelled.', 'Löschung abgebrochen.': 'Deletion cancelled.',
    'Dein Konto wurde gelöscht.': 'Your account was deleted.',
    '✗ Löschanfrage abgelaufen – das Konto besteht weiter.': '✗ Deletion request expired – the account still exists.',
    '⏳ Warte auf deine Bestätigung per Matrix…': '⏳ Waiting for your confirmation via Matrix…',
    'Neuer Matrix-Chat verknüpft.': 'New Matrix chat linked.',
    'Passwort wirklich entfernen? Anmeldung dann nur noch per Matrix-Link.': 'Really remove the password? Sign-in will then only be possible via Matrix link.',
    'Auf allen Geräten abmelden?': 'Sign out on all devices?',
    'Ohne neuen Matrix-Chat wird dein Konto endgültig gelöscht. Fortfahren?': 'Without a new Matrix chat your account will be deleted permanently. Continue?',

    // Server-Meldungen (server.js / accounts.js / game.js)
    'Ungültige Client-ID.': 'Invalid client ID.',
    'Raum nicht gefunden.': 'Room not found.',
    'Spiel läuft bereits – kein Beitritt möglich.': 'Game already running – cannot join.',
    'Du wurdest aus diesem Raum gekickt.': 'You were kicked from this room.',
    'Ranglisten-Raum: Beitritt nur mit angemeldetem Konto.': 'Ranked room: signed-in accounts only.',
    'Du sitzt mit diesem Konto bereits in diesem Raum.': 'You are already seated in this room with this account.',
    'Ranglisten-Spiele benötigen Benutzerkonten (auf diesem Server deaktiviert).': 'Ranked games require user accounts (disabled on this server).',
    'Ranglisten-Spiele sind ohne Bots – bitte zuerst alle Bots entfernen.': 'Ranked games are without bots – please remove all bots first.',
    'Ranglisten-Spiele nur mit angemeldeten Konten – im Raum sitzen noch Gäste.': 'Ranked games only with signed-in accounts – there are still guests in the room.',
    'Für Ranglisten-Spiele bitte zuerst anmelden.': 'Please sign in first for ranked games.',
    'Nur in der Lobby.': 'Only in the lobby.',
    'In Ranglisten-Räumen sind keine Bots erlaubt.': 'Bots are not allowed in ranked rooms.',
    'Spiel läuft bereits.': 'Game already running.',
    'Mindestens 2 Plätze nötig.': 'At least 2 seats required.',
    'Abstimmung läuft bereits.': 'A vote is already running.',
    'Keine Abstimmung aktiv.': 'No active vote.',
    'Kicken ist nur in der Lobby möglich.': 'Kicking is only possible in the lobby.',
    'Spieler nicht gefunden.': 'Player not found.',
    'Bots bitte über „Bot entfernen“ entfernen.': 'Please remove bots via “– Bot”.',
    'Du kannst dich nicht selbst kicken.': 'You cannot kick yourself.',
    'Admins können nicht per Abstimmung gekickt werden.': 'Admins cannot be kicked by vote.',
    'Es läuft bereits eine Kick-Abstimmung.': 'A kick vote is already running.',
    'Keine Kick-Abstimmung aktiv.': 'No active kick vote.',
    'Du bist von dieser Abstimmung betroffen und nicht stimmberechtigt.': 'This vote concerns you, so you cannot vote.',
    'Du kannst dich nicht selbst muten.': 'You cannot mute yourself.',
    'Du kannst dich nicht selbst entmuten.': 'You cannot unmute yourself.',
    'Admins können nicht per Abstimmung gemutet werden.': 'Admins cannot be muted by vote.',
    'Es läuft bereits eine Mute-Abstimmung.': 'A mute vote is already running.',
    'Keine Mute-Abstimmung aktiv.': 'No active mute vote.',
    'Du bist stummgeschaltet und kannst nicht schreiben.': 'You are muted and cannot write.',
    'Kein hello gesendet.': 'No hello sent.',
    'Kein Raum.': 'No room.', 'Nur der Host darf das.': 'Only the host may do that.',
    'Kein laufendes Spiel.': 'No game running.',
    'Du sitzt nicht in diesem Raum.': 'You are not seated in this room.',
    'Gerade keine Ansage.': 'Not bidding right now.',
    'Du bist nicht an der Reihe.': 'It is not your turn.',
    'Gerade wird nicht gespielt.': 'Not playing right now.',
    'Karte nicht erlaubt (Bedien-/Trumpfzwang) oder nicht in der Hand.': 'Card not allowed (must follow suit/trump) or not in your hand.',
    'Runde noch nicht beendet.': 'Round not finished yet.',
    'Unbekannter Spieler.': 'Unknown player.',
    'Fehler': 'Error',
    'Host hat den Raum verlassen.': 'The host left the room.',
    'Zeit abgelaufen': 'time is up',
    'Ergebnis wurde in die Rangliste eingetragen.': 'Result was recorded on the leaderboard.',
    'Abstimmung abgebrochen (Sitzordnung geändert).': 'Vote cancelled (seating changed).',
    'Benutzername ist bereits vergeben.': 'Username is already taken.',
    'Benutzername: 3–20 Zeichen, erlaubt sind Buchstaben, Ziffern, _ . -': 'Username: 3–20 characters; letters, digits, _ . - allowed',
    'Dieser Name ist reserviert.': 'This name is reserved.',
    'Konten sind auf diesem Server nicht aktiviert.': 'Accounts are not enabled on this server.',
    'Passwort: mindestens 8 Zeichen (oder leer lassen).': 'Password: at least 8 characters (or leave empty).',
    'Bitte kurz warten.': 'Please wait a moment.',
    'Zu viele offene Registrierungen – bitte später erneut.': 'Too many open registrations – please try again later.',
    'Zu viele Versuche, bitte später erneut.': 'Too many attempts, please try again later.',
    'Anmeldung fehlgeschlagen.': 'Sign-in failed.',
    'Login-Link ungültig oder abgelaufen.': 'Login link invalid or expired.',
    'Konto nicht gefunden.': 'Account not found.',
    'Nicht angemeldet.': 'Not signed in.',
    'Aktuelles Passwort falsch.': 'Current password is wrong.',
    'Bitte zuerst einen neuen Matrix-Chat verknüpfen.': 'Please link a new Matrix chat first.',
    'Passwort falsch.': 'Wrong password.',
    'Kein Matrix-Chat mit dem Bot bekannt. Schreib dem Bot zuerst „login“ und versuche es dann erneut.': 'No Matrix chat with the bot known. Send the bot “login” first and then try again.',
  };

  const HOW = { 'per Abstimmung': 'by vote', 'von einem Admin': 'by an admin' };
  const how = (h) => HOW[h] || h.replace(/^von (.+)$/, 'by $1');
  const MODE = { 'Privat': 'Private', 'Öffentlich': 'Public', 'Rangliste': 'Ranked' };

  // Muster: [RegExp (ganzer Text), Ersetzungsfunktion]. `t` übersetzt Teilstücke rekursiv.
  const PATTERNS = [
    [/^⚠ ([\s\S]+)$/, (m, t) => '⚠ ' + t(m[1])],
    [/^✗ ([\s\S]+)$/, (m, t) => '✗ ' + t(m[1])],
    [/^Fehler (\d+)$/, (m) => 'Error ' + m[1]],
    [/^(.+) \(du\)$/, (m) => m[1] + ' (you)'],
    [/^(.+) \(Admin\)( \(getrennt\))?$/, (m) => m[1] + ' (admin)' + (m[2] ? ' (disconnected)' : '')],
    [/^(.+) \(getrennt\)$/, (m) => m[1] + ' (disconnected)'],
    [/^🎤 Voice beitreten \((\d+) aktiv\)$/, (m) => `🎤 Join voice (${m[1]} active)`],
    [/^Warte auf Mitspieler oder füge Bots hinzu \(2–(\d+)\)\.$/, (m) => `Waiting for players – or add bots (2–${m[1]}).`],
    [/^Bereit – (\d+) Spieler: alternative Variante \(max\. (\d+) Karten pro Runde\)\.$/, (m) => `Ready – ${m[1]} players: alternative variant (max. ${m[2]} cards per round).`],
    [/^(.+) wirklich aus dem Raum entfernen\?$/, (m) => `Really remove ${m[1]} from the room?`],
    [/^Stich geht an (.+)$/, (m) => `Trick goes to ${m[1]}`],
    [/^(.+) sagt an…$/, (m) => `${m[1]} is bidding…`],
    [/^(.+) ist am Zug…$/, (m) => `${m[1]}'s turn…`],
    [/^Runde (\d+) beendet$/, (m) => `Round ${m[1]} finished`],
    [/^Ansage (\S+) · Stiche (\d+)$/, (m) => `Bid ${m[1]} · Tricks ${m[2]}`],
    [/^Punkte (-?\d+)$/, (m) => `Points ${m[1]}`],
    [/^· Ansage (\S+) · Stiche (\d+) · Punkte (-?\d+)$/, (m) => `· Bid ${m[1]} · Tricks ${m[2]} · Points ${m[3]}`],
    [/^\(Ansage (\S+), (\d+) Stiche\)$/, (m) => `(bid ${m[1]}, ${m[2]} tricks)`],
    [/^([♣♠♥♦]) (kreuz|pik|herz|karo)$/, (m, t) => `${m[1]} ${t(m[2])}`],
    [/^🗳 ([\s\S]+)$/, (m, t) => '🗳 ' + t(m[1])],
    [/^🚫 (.+) kicken\?$/, (m) => `🚫 Kick ${m[1]}?`],
    [/^🔇 (.+) stummschalten\?$/, (m) => `🔇 Mute ${m[1]}?`],
    [/^🔈 (.+) wieder freischalten\?$/, (m) => `🔈 Unmute ${m[1]}?`],
    [/^(\d+) von (\d+) nötigen Ja-Stimmen \(mehr als 50 %\)\.$/, (m) => `${m[1]} of ${m[2]} required yes votes (more than 50 %).`],
    [/^🔇 (.+)$/, (m, t) => { const r = t(m[1]); return r === m[1] ? null : '🔇 ' + r; }],
    [/^Willkommen, (.+)!$/, (m) => `Welcome, ${m[1]}!`],
    [/^Angemeldet als (.+)\.$/, (m) => `Signed in as ${m[1]}.`],
    [/^✓ „(.+)“ ist frei\.$/, (m) => `✓ “${m[1]}” is available.`],
    [/^Konto „(.+)“ angelegt – du bist angemeldet\.$/, (m) => `Account “${m[1]}” created – you are signed in.`],
    [/^✓ Verknüpft mit (.+)\.$/, (m) => `✓ Linked to ${m[1]}.`],
    [/^Konto „(.+)“ wirklich endgültig löschen\?(\nDie Löschung muss anschließend per Matrix bestätigt werden\.)?$/,
      (m) => `Really delete account “${m[1]}” permanently?` + (m[2] ? '\nThe deletion must then be confirmed via Matrix.' : '')],
    [/^löschen (\S+)$/, null], // Bot-Befehl – bleibt bewusst deutsch
    // Server: Chat-Systemmeldungen und Fehler mit Namen/Zahlen
    [/^Start abgebrochen: ([\s\S]+)$/, (m, t) => 'Start cancelled: ' + t(m[1])],
    [/^Das Spiel wurde gestartet(?: \((.+)\))?\. Viel Erfolg!$/, (m, t) => 'The game has started' + (m[1] ? ` (${t(m[1])})` : '') + '. Good luck!'],
    [/^Nächste Runde gestartet \((.+)\)\.$/, (m, t) => `Next round started (${t(m[1])}).`],
    [/^Abstimmung zum Kicken von (.+) abgelaufen – keine Mehrheit\.$/, (m) => `Kick vote on ${m[1]} expired – no majority.`],
    [/^(.+) wird nicht gekickt – keine Mehrheit\.$/, (m) => `${m[1]} will not be kicked – no majority.`],
    [/^(.+) wurde (per Abstimmung|von .+) aus dem Raum entfernt\.$/, (m) => `${m[1]} was removed from the room ${how(m[2])}.`],
    [/^Du wurdest (per Abstimmung|von .+) aus dem Raum (\S+) entfernt\.$/, (m) => `You were removed from room ${m[2]} ${how(m[1])}.`],
    [/^Abstimmung zum (Muten|Entmuten) von (.+) abgelaufen – keine Mehrheit\.$/, (m) => `${m[1] === 'Muten' ? 'Mute' : 'Unmute'} vote on ${m[2]} expired – no majority.`],
    [/^(.+) wird nicht (gemutet|entmutet) – keine Mehrheit\.$/, (m) => `${m[1]} will not be ${m[2] === 'gemutet' ? 'muted' : 'unmuted'} – no majority.`],
    [/^(.+) wurde (per Abstimmung|von .+) stummgeschaltet \(Text- und Sprachchat\)\.$/, (m) => `${m[1]} was muted ${how(m[2])} (text and voice chat).`],
    [/^(.+) wurde (per Abstimmung|von .+) wieder freigeschaltet\.$/, (m) => `${m[1]} was unmuted ${how(m[2])}.`],
    [/^(.+) hat den Raum erstellt \(Modus: (.+)\)\.$/, (m) => `${m[1]} created the room (mode: ${MODE[m[2]] || m[2]}).`],
    [/^(.+) ist beigetreten\.$/, (m) => `${m[1]} joined.`],
    [/^Spielmodus geändert: (.+)\.$/, (m) => `Game mode changed: ${MODE[m[1]] || m[1]}.`],
    [/^Abstimmung zum Spielstart – (\d+) s Zeit\.$/, (m) => `Vote to start the game – ${m[1]} s.`],
    [/^(.+) hat mit Nein gestimmt – Zeit angehalten\.$/, (m) => `${m[1]} voted no – timer paused.`],
    [/^(.+) möchte (.+) kicken – Abstimmung \((\d+) s, mehr als 50 % Ja nötig\)\.$/, (m) => `${m[1]} wants to kick ${m[2]} – vote (${m[3]} s, more than 50 % yes needed).`],
    [/^(.+) möchte (.+) (stummschalten|wieder freischalten) – Abstimmung \((\d+) s, mehr als 50 % Ja nötig\)\.$/,
      (m) => `${m[1]} wants to ${m[3] === 'stummschalten' ? 'mute' : 'unmute'} ${m[2]} – vote (${m[4]} s, more than 50 % yes needed).`],
    [/^Raum ist voll \(max\. (\d+)\)\.$/, (m) => `Room is full (max. ${m[1]}).`],
    [/^Max\. (\d+) Plätze\.$/, (m) => `Max. ${m[1]} seats.`],
    [/^Der Name „(.+)“ ist in diesem Raum schon vergeben\.$/, (m) => `The name “${m[1]}” is already taken in this room.`],
    [/^(.+) ist (bereits stummgeschaltet|nicht stummgeschaltet)\.$/, (m) => `${m[1]} is ${m[2] === 'bereits stummgeschaltet' ? 'already muted' : 'not muted'}.`],
    [/^„(.+)“ ist ein registrierter Benutzername – bitte anmelden oder einen anderen Namen wählen\.$/, (m) => `“${m[1]}” is a registered username – please sign in or choose another name.`],
    [/^Spieleranzahl muss (\d+)–(\d+) betragen\.$/, (m) => `Number of players must be ${m[1]}–${m[2]}.`],
    [/^Ansage muss 0–(\d+) sein\.$/, (m) => `Bid must be 0–${m[1]}.`],
  ];

  // Kartenwerte auf den Karten (Dame → Queen, Bube → Jack)
  const RANK_EN = { D: 'Q', B: 'J' };

  function translate(s) {
    if (lang !== 'en' || s == null) return s;
    const str = String(s);
    const m0 = str.match(/^(\s*)([\s\S]*?)(\s*)$/);
    const core = m0[2];
    if (!core) return str;
    const has = (k) => Object.prototype.hasOwnProperty.call(EXACT, k);
    const flat = core.replace(/\s+/g, ' ');
    let out = has(core) ? EXACT[core] : has(flat) ? EXACT[flat] : null;
    if (out == null) {
      for (const [re, fn] of PATTERNS) {
        const m = core.match(re);
        if (!m) continue;
        if (!fn) break;
        const r = fn(m, translate);
        if (r != null) { out = r; break; }
      }
    }
    return out == null ? str : m0[1] + out + m0[3];
  }

  // ---------------------------------------------------------------- DOM
  const SKIP = 'script,style,textarea,input,.cm:not(.sys),.code-badge,.reg-code,#acct-name,#set-name,#set-mxid,#lobby-link,#reg-bot,#rl-bot,#del-bot,.lang-toggle,#ranking-table tbody,[data-no-i18n]';
  const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
  const textMem = new WeakMap(); // Textknoten → { de, out }
  const attrMem = new WeakMap(); // Element → { [attr]: { de, out } }

  function skipped(el) { return !el || (el.closest && el.closest(SKIP)); }

  function doText(node) {
    const el = node.parentElement;
    if (skipped(el)) return;
    const cur = node.nodeValue;
    const rec = textMem.get(node);
    const de = rec && cur === rec.out ? rec.de : cur;
    let out;
    if (el.matches('.card .r')) out = lang === 'en' ? (RANK_EN[de] || de) : de;
    else out = lang === 'en' ? translate(de) : de;
    if (out !== cur) node.nodeValue = out;
    textMem.set(node, { de, out });
  }

  function doAttrs(el) {
    if (skipped(el)) return;
    let mem = attrMem.get(el);
    for (const a of ATTRS) {
      if (!el.hasAttribute(a)) continue;
      const cur = el.getAttribute(a);
      const rec = mem && mem[a];
      const de = rec && cur === rec.out ? rec.de : cur;
      const out = lang === 'en' ? translate(de) : de;
      if (out !== cur) el.setAttribute(a, out);
      if (!mem) { mem = {}; attrMem.set(el, mem); }
      mem[a] = { de, out };
    }
    // Regel-Links auf die passende Sprachversion umbiegen
    if (el.tagName === 'A') {
      const href = el.getAttribute('href');
      if (href === 'regeln.html' && lang === 'en') el.setAttribute('href', 'regeln.en.html');
      else if (href === 'regeln.en.html' && lang === 'de') el.setAttribute('href', 'regeln.html');
    }
  }

  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) return doText(root);
    if (root.nodeType !== 1) return;
    if (skipped(root)) return;
    doAttrs(root);
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let n;
    while ((n = tw.nextNode())) { if (n.nodeType === 3) doText(n); else doAttrs(n); }
  }

  let deTitle = null;
  function applyAll() {
    document.documentElement.lang = lang;
    if (deTitle == null) deTitle = document.title;
    document.title = lang === 'en' ? translate(deTitle) : deTitle;
    walk(document.body);
    document.querySelectorAll('.lang-toggle').forEach((b) => {
      b.textContent = lang === 'en' ? '🌐 Deutsch' : '🌐 English';
      b.title = lang === 'en' ? 'Auf Deutsch umschalten' : 'Switch to English';
      b.setAttribute('aria-label', b.title);
    });
  }

  const obs = new MutationObserver((list) => {
    for (const r of list) {
      if (r.type === 'characterData') doText(r.target);
      else if (r.type === 'attributes') doAttrs(r.target);
      else r.addedNodes.forEach(walk);
    }
  });

  function setLang(l) {
    if (!SUPPORTED.includes(l) || l === lang) return;
    lang = l;
    try { localStorage.setItem(LS_KEY, l); } catch (_) {}
    applyAll();
  }

  // Dialoge von app.js (confirm/alert) ebenfalls übersetzen
  const _confirm = window.confirm.bind(window), _alert = window.alert.bind(window);
  window.confirm = (msg) => _confirm(translate(msg));
  window.alert = (msg) => _alert(translate(msg));

  window.PortrigaI18n = { t: translate, get lang() { return lang; }, setLang,
    toggle: () => setLang(lang === 'en' ? 'de' : 'en') };

  function start() {
    applyAll();
    document.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('.lang-toggle');
      if (b) { e.preventDefault(); window.PortrigaI18n.toggle(); }
    });
    obs.observe(document.body, { subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ATTRS.concat('href') });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
