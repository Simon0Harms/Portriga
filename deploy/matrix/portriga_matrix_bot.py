#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Portriga Matrix-Bot (Sidecar)
=============================
Verbindet die Portriga-Node-App mit Matrix – für die Konto-Registrierung und
Login-Links. Abgeleitet vom KKk58-Sidecar (gleiches Spool-Prinzip).

  * Nimmt Raum-Einladungen automatisch an (User starten einen 1:1-Chat mit dem Bot).
  * Legt jede eingehende Textnachricht (außer eigenen) als JSON-Datei in die
    INBOX. Die Node-App wertet sie aus (Registrierungscode, Befehl „login").
    Der Absender (``sender``) ist vom Homeserver authentifiziert.
  * Sendet von der Node-App in die OUTBOX gelegte Nachrichten
    (Bestätigungen, Login-Links).
  * Aufträge mit ``"leave": true`` (Konto gelöscht): nach dem Senden – bzw.
    wenn das Senden endgültig scheitert – verlässt der Bot den Raum und
    vergisst ihn (``room_leave`` + ``room_forget``).
  * Ankündigungsraum (optional, PORTRIGA_ANNOUNCE_ROOM): Aufträge mit
    ``"announce": true`` werden NUR in diesen einen Raum gesendet – auch wenn er
    unverschlüsselt ist (öffentlicher Raum). Nachrichten und Austritte in diesem
    Raum werden NICHT an die Node-App weitergereicht (keine Befehle aus der
    Öffentlichkeit, keine Login-Links dorthin).
  * Verlässt ein User einen Raum (membership leave/ban), wird das als
    ``{"type": "leave", ...}`` in die INBOX gemeldet; ist danach niemand außer
    dem Bot mehr im Raum, verlässt der Bot ihn ebenfalls.

Die Node-App bleibt dadurch ohne Matrix-/E2EE-Abhängigkeiten.

Konfiguration: Umgebungsvariablen bzw. env-Datei (PORTRIGA_MATRIX_ENV_FILE),
siehe env.example.
"""

import asyncio
import json
import os
import secrets
import sys
import time
from datetime import datetime

try:
    from nio import (
        AsyncClient, AsyncClientConfig, LoginResponse, RoomSendResponse,
        RoomMessageText, RoomMessageNotice, MegolmEvent, InviteMemberEvent,
        RoomMemberEvent,
    )
except ImportError:
    sys.stderr.write(
        "Fehlt: matrix-nio mit E2EE. Bitte installieren:\n"
        "  pip install \"matrix-nio[e2e]\"\n"
        "(benötigt libolm, z. B. 'apt install libolm-dev' vor der Installation)\n"
    )
    raise


# ---------------------------------------------------------------------------
# .env-Datei laden (auch Start ohne systemd möglich) – wie im KKk58-Sidecar
# ---------------------------------------------------------------------------
def _parse_env_value(val):
    val = val.strip()
    if val[:1] in ("'", '"'):
        q = val[0]
        end = val.find(q, 1)
        return val[1:end] if end != -1 else val[1:]
    # Inline-Kommentar nur nach Leerraum (ein führendes # gehört evtl. zu einem Alias)
    for i in range(1, len(val)):
        if val[i] == "#" and val[i - 1] in " \t":
            return val[:i].rstrip()
    return val


def load_env_file(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line[0] in "#;":
                    continue
                if line.startswith("export "):
                    line = line[7:].lstrip()
                if "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                if k and k not in os.environ:
                    os.environ[k] = _parse_env_value(v)
    except OSError:
        pass


def env(name, default=None, required=False):
    v = os.environ.get(name, default)
    if required and (v is None or v == ""):
        sys.stderr.write(f"Konfiguration fehlt: {name}\n")
        sys.exit(2)
    return v


class Config:
    def __init__(self):
        self.homeserver = env("PORTRIGA_MATRIX_HOMESERVER", required=True)   # https://matrix.example.org
        self.user_id = env("PORTRIGA_MATRIX_USER", required=True)            # @portrigabot:example.org
        self.password = env("PORTRIGA_MATRIX_PASSWORD")                      # nur beim Erststart nötig
        data_dir = env("PORTRIGA_DATA_DIR", "/opt/portriga/data")
        self.outbox_dir = env("PORTRIGA_OUTBOX_DIR", os.path.join(data_dir, "matrix-outbox"))
        self.inbox_dir = env("PORTRIGA_INBOX_DIR", os.path.join(data_dir, "matrix-inbox"))
        self.outbox_ttl = int(env("PORTRIGA_OUTBOX_TTL", "900"))
        self.outbox_max_attempts = int(env("PORTRIGA_OUTBOX_MAX_ATTEMPTS", "5"))
        self.store_path = env("PORTRIGA_MATRIX_STORE", "/opt/portriga/matrix-store")
        self.state_file = env("PORTRIGA_MATRIX_STATE", os.path.join(self.store_path, "bot-state.json"))
        self.sync_timeout_ms = int(env("PORTRIGA_SYNC_TIMEOUT_MS", "10000"))  # Long-Poll je Sync
        self.device_name = env("PORTRIGA_MATRIX_DEVICE_NAME", "Portriga-Bot")
        # 1 = Login-Links/Antworten NUR in verschlüsselte Räume senden (empfohlen).
        # Eingehende Codes werden unabhängig davon angenommen.
        self.require_encryption = env("PORTRIGA_REQUIRE_ENCRYPTION", "1") != "0"
        # Nur Nachrichten annehmen, die jünger sind als X Sekunden (Schutz vor
        # Wiederverarbeitung alter Timeline beim Erststart).
        self.max_event_age = int(env("PORTRIGA_MAX_EVENT_AGE", "1800"))
        # Öffentlicher Ankündigungsraum (!id:server oder #alias:server); leer = aus
        self.announce_room = (env("PORTRIGA_ANNOUNCE_ROOM", "") or "").strip()


def load_state(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(path, state):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def write_spool(directory, obj):
    """Atomar eine JSON-Datei in ein Spool-Verzeichnis legen (tmp + rename)."""
    os.makedirs(directory, exist_ok=True)
    fid = "%s-%s" % (format(int(time.time() * 1000), "x"), secrets.token_hex(8))
    tmp = os.path.join(directory, "." + fid + ".tmp")
    fin = os.path.join(directory, fid + ".json")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    os.chmod(tmp, 0o600)
    os.replace(tmp, fin)
    return fid


class _PlaintextRefused(Exception):
    pass


class PortrigaBot:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.state = load_state(cfg.state_file)
        self.client = None
        self._stop = False
        self._outbox_attempts = {}
        self._seen = set(self.state.get("seen", []))  # zuletzt verarbeitete event_ids
        self._announce_id = None  # aufgelöste Raum-ID des Ankündigungsraums

    def log(self, *a):
        print(datetime.now().strftime("%Y-%m-%d %H:%M:%S"), *a, flush=True)

    def _is_announce_room(self, rid):
        if not rid or not self.cfg.announce_room:
            return False
        if rid in (self._announce_id, self.cfg.announce_room):
            return True
        # Alias noch nicht aufgelöst: über den kanonischen Alias des Raums erkennen
        r = self.client.rooms.get(rid) if self.client else None
        return bool(r) and getattr(r, "canonical_alias", None) == self.cfg.announce_room

    async def _resolve_announce(self):
        """Alias -> Raum-ID auflösen und dem (öffentlichen) Raum beitreten."""
        a = self.cfg.announce_room
        if not a:
            return None
        if self._announce_id:
            return self._announce_id
        rid = a
        if a.startswith("#"):
            resp = await self.client.room_resolve_alias(a)
            rid = getattr(resp, "room_id", None)
            if not rid:
                raise RuntimeError("Alias nicht auflösbar: %s (%r)" % (a, resp))
        if rid not in self.client.rooms:
            resp = await self.client.join(rid)
            if type(resp).__name__.endswith("Error"):
                raise RuntimeError("Beitritt Ankündigungsraum fehlgeschlagen: %r" % (resp,))
            await self.client.sync(timeout=0)
        self._announce_id = rid
        self.log("Ankündigungsraum:", a, "->", rid)
        return rid

    # ---- eingehend ----
    async def _on_message(self, room, event):
        try:
            sender = getattr(event, "sender", "") or ""
            if sender == self.cfg.user_id:
                return
            if self._is_announce_room(room.room_id):
                return  # öffentlicher Raum: keine Befehle annehmen
            eid = getattr(event, "event_id", None)
            if not eid or eid in self._seen:
                return
            ts = int(getattr(event, "server_timestamp", 0) or 0)
            if ts and (time.time() * 1000 - ts) > self.cfg.max_event_age * 1000:
                return
            body = getattr(event, "body", None)
            if not body:
                return
            write_spool(self.cfg.inbox_dir, {
                "eventId": eid,
                "roomId": room.room_id,
                "sender": sender,
                "body": str(body)[:2000],
                "ts": ts,
                "encrypted": bool(getattr(room, "encrypted", False)),
            })
            self._remember(eid)
            self.log("Inbox: Nachricht von", sender, "in", room.room_id)
        except Exception as e:  # Callback-Fehler dürfen den Sync nicht abbrechen
            self.log("Inbox-Fehler (ignoriert):", repr(e))

    async def _on_undecryptable(self, room, event):
        self.log("Nicht entschlüsselbare Nachricht von", getattr(event, "sender", "?"),
                 "in", room.room_id, "– Geräteschlüssel fehlen evtl. noch; der User sollte die Nachricht erneut senden.")

    async def _on_invite(self, room, event):
        # Nur Einladungen AN den Bot annehmen
        if getattr(event, "state_key", None) != self.cfg.user_id:
            return
        if getattr(event, "membership", None) != "invite":
            return
        try:
            await self.client.join(room.room_id)
            self.log("Einladung angenommen:", room.room_id, "von", getattr(event, "sender", "?"))
        except Exception as e:
            self.log("Beitritt fehlgeschlagen:", room.room_id, repr(e))

    async def _on_member(self, room, event):
        """User hat den Raum verlassen (oder wurde gebannt) -> an die Node-App melden."""
        try:
            who = getattr(event, "state_key", "") or ""
            if not who or who == self.cfg.user_id:
                return
            if self._is_announce_room(room.room_id):
                return  # Kommen/Gehen im öffentlichen Raum ist kein Konto-Ereignis
            if getattr(event, "membership", None) not in ("leave", "ban"):
                return
            if getattr(event, "prev_membership", None) not in (None, "join", "invite"):
                return
            eid = getattr(event, "event_id", None)
            if not eid or eid in self._seen:
                return
            ts = int(getattr(event, "server_timestamp", 0) or 0)
            if ts and (time.time() * 1000 - ts) > self.cfg.max_event_age * 1000:
                return
            write_spool(self.cfg.inbox_dir, {
                "type": "leave",
                "eventId": eid,
                "roomId": room.room_id,
                "sender": who,
                "ts": ts,
            })
            self._remember(eid)
            self.log("Inbox:", who, "hat", room.room_id, "verlassen")
            others = [u for u in list(getattr(room, "users", {}).keys())
                      if u not in (self.cfg.user_id, who)]
            if not others:
                await self._leave_room(room.room_id)
        except Exception as e:
            self.log("Member-Fehler (ignoriert):", repr(e))

    def _remember(self, eid):
        self._seen.add(eid)
        if len(self._seen) > 2000:
            self._seen = set(list(self._seen)[-1000:])
        self.state["seen"] = list(self._seen)[-1000:]
        save_state(self.cfg.state_file, self.state)

    async def _join_invites(self):
        """Fallback: offene Einladungen annehmen, die der Callback verpasst hat."""
        for rid in list(getattr(self.client, "invited_rooms", {}).keys()):
            try:
                await self.client.join(rid)
                self.log("Einladung angenommen (Nachzügler):", rid)
            except Exception as e:
                self.log("Beitritt fehlgeschlagen:", rid, repr(e))

    # ---- ausgehend ----
    ANNOUNCED_MAX_AGE = 2 * 86400  # gemerkte Ankündigungen nach 2 Tagen vergessen

    def _remember_announce(self, ref, rid, eid):
        """event_id einer Ankündigung merken, damit sie später redigiert werden kann."""
        ann = self.state.setdefault("announced", {})
        now = time.time()
        for k in [k for k, v in ann.items() if now - v.get("ts", 0) > self.ANNOUNCED_MAX_AGE]:
            ann.pop(k, None)
        ann[ref] = {"room": rid, "event": eid, "ts": now}
        save_state(self.cfg.state_file, self.state)

    async def _send_announce(self, target, body, ref=None):
        if not self.cfg.announce_room or target != self.cfg.announce_room:
            raise _PlaintextRefused(target)  # nur der konfigurierte Raum ist erlaubt
        rid = await self._resolve_announce()
        resp = await self.client.room_send(
            rid, "m.room.message", {"msgtype": "m.notice", "body": body},
            ignore_unverified_devices=True,
        )
        if not isinstance(resp, RoomSendResponse):
            raise RuntimeError("room_send: " + repr(resp))
        if ref:
            self._remember_announce(ref, rid, resp.event_id)

    async def _retract_announce(self, target, ref, reason):
        """Eigene Ankündigung per Redaction entfernen. Rückgabe: True = erledigt."""
        if not self.cfg.announce_room or target != self.cfg.announce_room:
            raise _PlaintextRefused(target)
        entry = self.state.get("announced", {}).get(ref)
        if not entry:
            return False  # (noch) nicht gesendet oder schon vergessen
        resp = await self.client.room_redact(entry["room"], entry["event"], reason=reason or None)
        if type(resp).__name__.endswith("Error"):
            raise RuntimeError("room_redact: " + repr(resp))
        self.state["announced"].pop(ref, None)
        save_state(self.cfg.state_file, self.state)
        return True

    async def _send_to_room(self, rid, body):
        if self._is_announce_room(rid):
            raise _PlaintextRefused(rid)  # keine Konto-Nachrichten in den öffentlichen Raum
        if rid not in self.client.rooms:
            await self.client.join(rid)
            await self.client.sync(timeout=0)
        enc = rid in self.client.rooms and self.client.rooms[rid].encrypted
        if self.cfg.require_encryption and not enc:
            raise _PlaintextRefused(rid)
        resp = await self.client.room_send(
            rid, "m.room.message", {"msgtype": "m.text", "body": body},
            ignore_unverified_devices=True,
        )
        if not isinstance(resp, RoomSendResponse):
            raise RuntimeError("room_send: " + repr(resp))

    async def _leave_room(self, rid):
        try:
            resp = await self.client.room_leave(rid)
            if type(resp).__name__.endswith("Error"):
                raise RuntimeError(repr(resp))
            try:
                await self.client.room_forget(rid)
            except Exception as e:  # Vergessen ist optional
                self.log("room_forget fehlgeschlagen (ignoriert):", rid, repr(e))
            self.log("Raum verlassen:", rid)
        except Exception as e:
            self.log("Raum verlassen fehlgeschlagen:", rid, repr(e))

    async def _finish(self, fpath, mid, msg):
        """Auftrag abschließen: Datei entfernen und ggf. Raum verlassen."""
        self._safe_remove(fpath)
        self._outbox_attempts.pop(mid, None)
        if msg.get("leave") and msg.get("roomId"):
            await self._leave_room(msg["roomId"])

    @staticmethod
    def _safe_remove(p):
        try:
            os.remove(p)
        except OSError:
            pass

    async def process_outbox(self):
        try:
            names = sorted(n for n in os.listdir(self.cfg.outbox_dir)
                           if n.endswith(".json") and not n.startswith("."))
        except OSError:
            return
        if not names:
            return
        if self.client.should_upload_keys:
            await self.client.keys_upload()
        if self.client.should_query_keys:
            await self.client.keys_query()
        # Ankündigungen, deren Rückzug schon in der Outbox liegt, gar nicht erst senden
        retracting = set()
        for name in names:
            try:
                with open(os.path.join(self.cfg.outbox_dir, name), "r", encoding="utf-8") as f:
                    r = json.load(f).get("retract")
                if r:
                    retracting.add(str(r))
            except (OSError, ValueError, AttributeError):
                pass
        for name in names:
            fpath = os.path.join(self.cfg.outbox_dir, name)
            try:
                with open(fpath, "r", encoding="utf-8") as f:
                    msg = json.load(f)
            except (OSError, ValueError):
                self._safe_remove(fpath)
                continue
            mid = str(msg.get("id") or name)
            age = time.time() - (msg.get("createdAt", 0) / 1000)
            room, body = msg.get("roomId"), msg.get("body")
            if msg.get("retract"):
                ref = str(msg["retract"])
                pending = os.path.join(self.cfg.outbox_dir, ref + ".json")
                if os.path.exists(pending):
                    # Ankündigung wurde noch gar nicht gesendet -> einfach verwerfen
                    self._safe_remove(pending)
                    self._outbox_attempts.pop(ref, None)
                    self.log("Outbox: Ankündigung vor dem Senden zurückgezogen:", ref)
                    await self._finish(fpath, mid, {})
                    continue
                try:
                    done = await self._retract_announce(room, ref, msg.get("reason"))
                    self.log("Outbox: Ankündigung entfernt" if done else
                             "Outbox: keine gemerkte Ankündigung zum Entfernen", ref)
                    await self._finish(fpath, mid, {})
                except _PlaintextRefused:
                    self.log("Outbox: Rückzug für fremden Raum verweigert:", room)
                    await self._finish(fpath, mid, {})
                except Exception as e:
                    n = self._outbox_attempts.get(mid, 0) + 1
                    self._outbox_attempts[mid] = n
                    self.log("Outbox: Entfernen fehlgeschlagen (Versuch %d): %r" % (n, e))
                    if n >= self.cfg.outbox_max_attempts or age > self.cfg.outbox_ttl:
                        await self._finish(fpath, mid, {})
                continue
            if age > self.cfg.outbox_ttl or not room or not body:
                await self._finish(fpath, mid, msg)
                continue
            try:
                if msg.get("announce"):
                    if mid in retracting:
                        self.log("Outbox: Ankündigung vor dem Senden zurückgezogen:", mid)
                        await self._finish(fpath, mid, {})
                        continue
                    await self._send_announce(room, body, ref=mid)
                    self.log("Outbox: Ankündigung gesendet an", room)
                    await self._finish(fpath, mid, {})
                    continue
                await self._send_to_room(room, body)
                self.log("Outbox: gesendet an", room)
                await self._finish(fpath, mid, msg)
            except _PlaintextRefused:
                self.log("Outbox: Raum", room, "ist NICHT verschlüsselt – nicht gesendet "
                         "(PORTRIGA_REQUIRE_ENCRYPTION=1). Auftrag verworfen.")
                await self._finish(fpath, mid, msg)
            except Exception as e:
                n = self._outbox_attempts.get(mid, 0) + 1
                self._outbox_attempts[mid] = n
                self.log("Outbox: Senden fehlgeschlagen (Versuch %d) an %s: %r" % (n, room, e))
                if n >= self.cfg.outbox_max_attempts:
                    await self._finish(fpath, mid, msg)

    # ---- Ablauf ----
    async def connect(self):
        for d in (self.cfg.store_path, os.path.dirname(self.cfg.state_file) or ".",
                  self.cfg.inbox_dir, self.cfg.outbox_dir):
            try:
                os.makedirs(d, exist_ok=True)
            except PermissionError:
                sys.stderr.write(f"Kein Schreibrecht: {d}\n")
                sys.exit(4)
        conf = AsyncClientConfig(store_sync_tokens=True, encryption_enabled=True)
        dev_id = self.state.get("device_id")
        self.client = AsyncClient(self.cfg.homeserver, self.cfg.user_id,
                                  device_id=dev_id or "", store_path=self.cfg.store_path, config=conf)
        token = self.state.get("access_token")
        if token and dev_id:
            self.client.restore_login(self.cfg.user_id, dev_id, token)
            self.client.load_store()
            self.log("Angemeldet (wiederhergestellt) als", self.cfg.user_id, "device", dev_id)
        else:
            if not self.cfg.password:
                sys.stderr.write("Erststart benötigt PORTRIGA_MATRIX_PASSWORD (danach Token-basiert).\n")
                sys.exit(2)
            resp = await self.client.login(self.cfg.password, device_name=self.cfg.device_name)
            if not isinstance(resp, LoginResponse):
                sys.stderr.write(f"Login fehlgeschlagen: {resp}\n")
                sys.exit(1)
            self.state["device_id"] = resp.device_id
            self.state["access_token"] = resp.access_token
            save_state(self.cfg.state_file, self.state)
            self.log("Angemeldet (neu) als", self.cfg.user_id, "device", resp.device_id)

        self.client.add_event_callback(self._on_message, (RoomMessageText, RoomMessageNotice))
        self.client.add_event_callback(self._on_undecryptable, (MegolmEvent,))
        self.client.add_event_callback(self._on_invite, (InviteMemberEvent,))
        self.client.add_event_callback(self._on_member, (RoomMemberEvent,))

        await self.client.sync(timeout=30000, full_state=True)
        if self.client.should_upload_keys:
            await self.client.keys_upload()
        await self._join_invites()
        if self.cfg.announce_room:
            try:
                await self._resolve_announce()
            except Exception as e:
                self.log("Ankündigungsraum noch nicht erreichbar (neuer Versuch beim Senden):", repr(e))

    async def loop(self):
        while not self._stop:
            try:
                await self.client.sync(timeout=self.cfg.sync_timeout_ms)
                if self.client.should_upload_keys:
                    await self.client.keys_upload()
                await self._join_invites()
            except Exception as e:
                self.log("Sync-Hinweis (fahre fort):", repr(e))
                await asyncio.sleep(3)
            await self.process_outbox()

    async def run(self):
        await self.connect()
        try:
            await self.loop()
        finally:
            self._stop = True
            await self.client.close()


def main():
    load_env_file(os.environ.get("PORTRIGA_MATRIX_ENV_FILE", "/opt/portriga/matrix/portriga-matrix.env"))
    try:
        asyncio.run(PortrigaBot(Config()).run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
