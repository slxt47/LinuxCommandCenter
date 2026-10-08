"""
Zero-Knowledge Vault — Backend (krypto-frei).

Der Server ist bewusst "dumm": er speichert nur Ciphertext-Blobs und oeffentliche
Parameter, prueft das Auth-Gate (scrypt ueber den vom Client abgeleiteten auth_proof)
und verifiziert die Signatur der iPhone-Freigabe. Er sieht NIEMALS Master-Passwort,
Master-Key, SEK oder Vault-Key.

Zwei Nutzungsarten:
  1. Import in die Dashboard-server.py:  VaultBackend(db_path).handle(method, path, body, ctx)
  2. Standalone-Dev-Server:              python3 vault_backend.py [--db vault.db] [--port 8099]

Design-Entscheidung: siehe README.md / Projektgedaechtnis project-password-manager.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
import uuid

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.asymmetric import ec, utils as asym_utils
from cryptography.hazmat.primitives import hashes as crypto_hashes
from cryptography.hazmat.primitives.serialization import load_der_public_key
from cryptography.exceptions import InvalidSignature

# ---------------------------------------------------------------------------
# Konstanten
# ---------------------------------------------------------------------------
MAX_DEVICES       = 3           # maximal koppelbare Besitz-Faktor-Geraete pro Konto
APPROVAL_TTL      = 60          # Sekunden bis eine Login-Freigabe verfaellt
REGISTER_TTL      = 300         # Sekunden fuer eine Geraete-Registrierungs-Challenge
SESSION_TTL       = 15 * 60     # Access-Token-Lebensdauer
SCRYPT_N, SCRYPT_R, SCRYPT_P = 16384, 8, 1
SCHEMA_FILE       = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schema.sql")


# ---------------------------------------------------------------------------
# Encoding-Helfer (alles Binaere geht als base64url ohne Padding ueber den Draht)
# ---------------------------------------------------------------------------
def b64u_decode(s: str) -> bytes:
    s = s + "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s.encode())


def b64u_encode(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def now() -> int:
    return int(time.time())


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str = ""):
        super().__init__(message or code)
        self.status = status
        self.code = code
        self.message = message or code


# ---------------------------------------------------------------------------
# Backend
# ---------------------------------------------------------------------------
class VaultBackend:
    def __init__(self, db_path: str = "vault.db"):
        self.db_path = db_path
        self._init_db()

    # -- DB ------------------------------------------------------------------
    def _conn(self) -> sqlite3.Connection:
        c = sqlite3.connect(self.db_path, timeout=10, isolation_level=None)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA foreign_keys = ON")
        c.execute("PRAGMA journal_mode = WAL")
        return c

    def _init_db(self):
        with open(SCHEMA_FILE, "r", encoding="utf-8") as f:
            schema = f.read()
        with self._conn() as c:
            c.executescript(schema)

    # -- kleine Utilities ----------------------------------------------------
    @staticmethod
    def _scrypt(data: bytes, salt: bytes) -> str:
        return b64u_encode(hashlib.scrypt(data, salt=salt, n=SCRYPT_N, r=SCRYPT_R,
                                          p=SCRYPT_P, dklen=32))

    @staticmethod
    def _sha256(data: bytes) -> str:
        return b64u_encode(hashlib.sha256(data).digest())

    def _account_by_name(self, c, username: str):
        return c.execute("SELECT * FROM vault_account WHERE username=?", (username,)).fetchone()

    def _require_session(self, c, token: str):
        if not token:
            raise ApiError(401, "no_session")
        row = c.execute("SELECT * FROM sessions WHERE token_hash=?",
                        (self._sha256(token.encode()),)).fetchone()
        if not row:
            raise ApiError(401, "invalid_session")
        if row["expires_at"] < now():
            c.execute("DELETE FROM sessions WHERE token_hash=?", (row["token_hash"],))
            raise ApiError(401, "session_expired")
        return row["account_id"]

    def _require_device(self, c, token: str):
        """Authentifiziert die iPhone-PWA fuers Polling per device_token."""
        if not token:
            raise ApiError(401, "no_device_token")
        row = c.execute("SELECT * FROM trusted_devices WHERE device_token_hash=?",
                        (self._sha256(token.encode()),)).fetchone()
        if not row:
            raise ApiError(401, "invalid_device_token")
        return row

    # -- Signatur-Verifikation der Freigabe ---------------------------------
    @staticmethod
    def _verify_signature(algo: str, spki_der: bytes, message: bytes, sig: bytes) -> bool:
        try:
            pub = load_der_public_key(spki_der)
            if algo == "ed25519":
                if not isinstance(pub, Ed25519PublicKey):
                    return False
                pub.verify(sig, message)          # sig = 64 Byte raw
                return True
            if algo == "p256":
                # WebCrypto liefert ECDSA-Signaturen als raw r||s (64 Byte),
                # cryptography erwartet DER -> konvertieren.
                if len(sig) != 64:
                    return False
                r = int.from_bytes(sig[:32], "big")
                s = int.from_bytes(sig[32:], "big")
                der = asym_utils.encode_dss_signature(r, s)
                pub.verify(der, message, ec.ECDSA(crypto_hashes.SHA256()))
                return True
            return False
        except (InvalidSignature, ValueError, TypeError):
            return False

    @staticmethod
    def _approval_message(approval_id: str, challenge_b64u: str, context: dict) -> bytes:
        ctx_src = f"{context.get('ip','')}|{context.get('user_agent','')}|{context.get('iso_time','')}"
        ctx_hash = hashlib.sha256(ctx_src.encode()).hexdigest()
        return f"vaultapprove:v1|{approval_id}|{challenge_b64u}|{ctx_hash}".encode()

    # =======================================================================
    # API-Endpunkte  (jede Methode gibt (status, dict) zurueck)
    # =======================================================================

    # --- Konto anlegen -----------------------------------------------------
    def account_setup(self, body: dict):
        username = (body.get("username") or "").strip()
        if not username:
            raise ApiError(400, "username_required")
        for k in ("salt_user", "argon2_params", "protected_vault_key", "auth_proof",
                  "recovery"):
            if k not in body:
                raise ApiError(400, "missing_field", k)
        rec = body["recovery"]
        for k in ("salt_recovery", "protected_vault_key_recovery"):
            if k not in rec:
                raise ApiError(400, "missing_recovery_field", k)

        auth_salt = secrets.token_bytes(16)
        auth_hash = self._scrypt(b64u_decode(body["auth_proof"]), auth_salt)
        ts = now()
        with self._conn() as c:
            if self._account_by_name(c, username):
                raise ApiError(409, "account_exists")
            cur = c.execute(
                "INSERT INTO vault_account(username,salt_user,argon2_params,"
                "protected_vault_key,auth_salt,auth_proof_hash,created_at) "
                "VALUES(?,?,?,?,?,?,?)",
                (username, body["salt_user"], json.dumps(body["argon2_params"]),
                 body["protected_vault_key"], b64u_encode(auth_salt), auth_hash, ts))
            aid = cur.lastrowid
            c.execute(
                "INSERT INTO recovery(account_id,version,salt_recovery,"
                "protected_vault_key_recovery,used) VALUES(?,?,?,?,0)",
                (aid, 1, rec["salt_recovery"], rec["protected_vault_key_recovery"]))
            # Bootstrap-Session: loest das Henne-Ei-Problem — ohne registriertes Geraet
            # kann man sich nicht einloggen, aber zum Registrieren braucht man eine Session.
            # Direkt nach Setup gibt es diese eine kurzlebige Session zum Anlernen des
            # ersten iPhones. Danach greift fuer jeden Login der 2. Faktor.
            token = secrets.token_urlsafe(32)
            c.execute("INSERT INTO sessions(token_hash,account_id,created_at,expires_at) "
                      "VALUES(?,?,?,?)",
                      (self._sha256(token.encode()), aid, ts, ts + SESSION_TTL))
        return 201, {"ok": True, "account_id": aid, "bootstrap_token": token,
                     "expires_in": SESSION_TTL}

    # --- Login Schritt 1: Parameter holen + Freigabe anfordern -------------
    def auth_start(self, body: dict, ctx: dict):
        username = (body.get("username") or "").strip()
        with self._conn() as c:
            acc = self._account_by_name(c, username)
            if not acc:
                # Kein User-Enumeration: generische Antwort mit deterministischem Fake-Salt.
                fake = b64u_encode(hmac.new(b"vault-enum-guard", username.encode(),
                                            hashlib.sha256).digest()[:16])
                return 200, {"salt_user": fake,
                             "argon2_params": {"m": 65536, "t": 3, "p": 4, "v": 1},
                             "approval_id": str(uuid.uuid4()), "match_code": "00"}
            approval_id = str(uuid.uuid4())
            challenge = b64u_encode(secrets.token_bytes(32))
            match_code = f"{secrets.randbelow(100):02d}"
            context = {"ip": ctx.get("ip", ""), "user_agent": ctx.get("user_agent", ""),
                       "iso_time": ctx.get("iso_time", "")}
            ts = now()
            c.execute(
                "INSERT INTO pending_approvals(approval_id,account_id,challenge,context,"
                "match_code,status,created_at,expires_at) VALUES(?,?,?,?,?,'pending',?,?)",
                (approval_id, acc["id"], challenge, json.dumps(context), match_code,
                 ts, ts + APPROVAL_TTL))
            return 200, {"salt_user": acc["salt_user"],
                         "argon2_params": json.loads(acc["argon2_params"]),
                         "approval_id": approval_id, "match_code": match_code}

    # --- Login Schritt 2: auth_proof + genehmigte Freigabe -> Session ------
    def auth_finish(self, body: dict):
        username = (body.get("username") or "").strip()
        auth_proof = body.get("auth_proof")
        approval_id = body.get("approval_id")
        if not (username and auth_proof and approval_id):
            raise ApiError(400, "missing_field")
        with self._conn() as c:
            acc = self._account_by_name(c, username)
            if not acc:
                raise ApiError(401, "auth_failed")
            # 1. Wissensfaktor pruefen (konstante Zeit)
            calc = self._scrypt(b64u_decode(auth_proof), b64u_decode(acc["auth_salt"]))
            if not hmac.compare_digest(calc, acc["auth_proof_hash"]):
                raise ApiError(401, "auth_failed")
            # 2. Besitzfaktor: Freigabe muss approved + frisch + zum Konto sein
            ap = c.execute("SELECT * FROM pending_approvals WHERE approval_id=?",
                           (approval_id,)).fetchone()
            if not ap or ap["account_id"] != acc["id"]:
                raise ApiError(401, "approval_missing")
            if ap["status"] != "approved":
                raise ApiError(401, "approval_not_granted")
            if ap["expires_at"] < now():
                raise ApiError(401, "approval_expired")
            # Freigabe verbrennen (Einmal-Nutzung)
            c.execute("DELETE FROM pending_approvals WHERE approval_id=?", (approval_id,))
            # Session ausstellen
            token = secrets.token_urlsafe(32)
            ts = now()
            c.execute("INSERT INTO sessions(token_hash,account_id,created_at,expires_at) "
                      "VALUES(?,?,?,?)",
                      (self._sha256(token.encode()), acc["id"], ts, ts + SESSION_TTL))
            return 200, {"ok": True, "access_token": token, "expires_in": SESSION_TTL}

    # --- Verschluesselten Tresor ausliefern (nur Ciphertext) ---------------
    def vault_bundle(self, session_token: str):
        with self._conn() as c:
            aid = self._require_session(c, session_token)
            acc = c.execute("SELECT protected_vault_key FROM vault_account WHERE id=?",
                            (aid,)).fetchone()
            items = c.execute("SELECT id,blob,version,updated_at FROM vault_items "
                              "WHERE account_id=?", (aid,)).fetchall()
            return 200, {"protected_vault_key": acc["protected_vault_key"],
                         "items": [dict(i) for i in items]}

    # --- Eintrag anlegen/aktualisieren (Upsert, opaker Blob) ---------------
    def item_put(self, session_token: str, body: dict):
        blob = body.get("blob")
        if not blob:
            raise ApiError(400, "blob_required")
        item_id = body.get("id") or str(uuid.uuid4())
        with self._conn() as c:
            aid = self._require_session(c, session_token)
            existing = c.execute("SELECT account_id,version FROM vault_items WHERE id=?",
                                 (item_id,)).fetchone()
            ts = now()
            if existing:
                if existing["account_id"] != aid:
                    raise ApiError(403, "not_owner")
                c.execute("UPDATE vault_items SET blob=?,version=version+1,updated_at=? "
                          "WHERE id=?", (json.dumps(blob) if isinstance(blob, dict) else blob,
                                         ts, item_id))
                ver = existing["version"] + 1
            else:
                c.execute("INSERT INTO vault_items(id,account_id,blob,version,updated_at) "
                          "VALUES(?,?,?,1,?)",
                          (item_id, aid, json.dumps(blob) if isinstance(blob, dict) else blob, ts))
                ver = 1
            return 200, {"ok": True, "id": item_id, "version": ver, "updated_at": ts}

    def item_delete(self, session_token: str, item_id: str):
        with self._conn() as c:
            aid = self._require_session(c, session_token)
            row = c.execute("SELECT account_id FROM vault_items WHERE id=?",
                            (item_id,)).fetchone()
            if not row:
                raise ApiError(404, "not_found")
            if row["account_id"] != aid:
                raise ApiError(403, "not_owner")
            c.execute("DELETE FROM vault_items WHERE id=?", (item_id,))
            return 200, {"ok": True}

    # --- Kopplung: eingeloggter Client autorisiert ein neues Geraet ---------
    @staticmethod
    def _normalize_pairing(code: str) -> str:
        return re.sub(r"[^A-Z0-9]", "", (code or "").upper())

    def device_pair_start(self, session_token: str):
        """Erzeugt einen kurzlebigen Kopplungs-Code (auf dem Laptop anzuzeigen)."""
        with self._conn() as c:
            aid = self._require_session(c, session_token)
            # 12 Zeichen Crockford-artig, in 3er-Gruppen fuers Abtippen
            alpha = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
            raw = "".join(alpha[secrets.randbelow(len(alpha))] for _ in range(12))
            code = "-".join(raw[i:i + 4] for i in range(0, 12, 4))
            c.execute("INSERT INTO pairing_tokens(code_hash,account_id,expires_at,used) "
                      "VALUES(?,?,?,0)",
                      (self._sha256(self._normalize_pairing(code).encode()),
                       aid, now() + REGISTER_TTL))
            return 200, {"pairing_code": code, "expires_in": REGISTER_TTL}

    def _reg_account(self, c, ctx: dict):
        """Registrierung ist per Session ODER per Kopplungs-Code autorisiert.
        Gibt (account_id, pairing_code_hash|None) zurueck."""
        pc = (ctx.get("pairing_code") or "").strip()
        if pc:
            ch = self._sha256(self._normalize_pairing(pc).encode())
            row = c.execute("SELECT * FROM pairing_tokens WHERE code_hash=?", (ch,)).fetchone()
            if not row:
                raise ApiError(401, "bad_pairing_code")
            if row["used"]:
                raise ApiError(409, "pairing_used")
            if row["expires_at"] < now():
                raise ApiError(410, "pairing_expired")
            return row["account_id"], ch
        return self._require_session(c, ctx.get("session_token", "")), None

    # --- Geraete-Registrierung (iPhone) ------------------------------------
    def device_register_start(self, ctx: dict):
        with self._conn() as c:
            aid, _ = self._reg_account(c, ctx)
            cid = str(uuid.uuid4())
            challenge = b64u_encode(secrets.token_bytes(32))
            c.execute("INSERT INTO register_challenges(id,account_id,challenge,expires_at) "
                      "VALUES(?,?,?,?)", (cid, aid, challenge, now() + REGISTER_TTL))
            return 200, {"challenge_id": cid, "challenge": challenge}

    def device_register_finish(self, ctx: dict, body: dict):
        for k in ("challenge_id", "name", "public_key", "algo", "signature"):
            if k not in body:
                raise ApiError(400, "missing_field", k)
        if body["algo"] not in ("ed25519", "p256"):
            raise ApiError(400, "bad_algo")
        with self._conn() as c:
            aid, pairing_hash = self._reg_account(c, ctx)
            ch = c.execute("SELECT * FROM register_challenges WHERE id=?",
                           (body["challenge_id"],)).fetchone()
            if not ch or ch["account_id"] != aid:
                raise ApiError(400, "challenge_missing")
            if ch["expires_at"] < now():
                raise ApiError(400, "challenge_expired")
            # Selbst-Signatur: das Geraet beweist Besitz des Private-Keys.
            ok = self._verify_signature(body["algo"], b64u_decode(body["public_key"]),
                                        ch["challenge"].encode(),
                                        b64u_decode(body["signature"]))
            if not ok:
                raise ApiError(400, "bad_signature")
            # Geraete-Limit durchsetzen (max. MAX_DEVICES pro Konto)
            cnt = c.execute("SELECT COUNT(*) FROM trusted_devices WHERE account_id=?",
                            (aid,)).fetchone()[0]
            if cnt >= MAX_DEVICES:
                raise ApiError(409, "device_limit",
                               f"Maximal {MAX_DEVICES} Geraete erlaubt")
            c.execute("DELETE FROM register_challenges WHERE id=?", (body["challenge_id"],))
            device_id = str(uuid.uuid4())
            device_token = secrets.token_urlsafe(32)
            c.execute(
                "INSERT INTO trusted_devices(id,account_id,name,public_key,algo,"
                "device_token_hash,created_at) VALUES(?,?,?,?,?,?,?)",
                (device_id, aid, body["name"], body["public_key"], body["algo"],
                 self._sha256(device_token.encode()), now()))
            if pairing_hash:  # Kopplungs-Code ist Single-Use
                c.execute("UPDATE pairing_tokens SET used=1 WHERE code_hash=?", (pairing_hash,))
            # device_token wird EINMALIG zurueckgegeben und nur auf dem iPhone gespeichert.
            return 201, {"ok": True, "device_id": device_id, "device_token": device_token}

    # --- Geraete verwalten (Liste + Entfernen, Session-authentifiziert) -----
    def device_list(self, session_token: str):
        with self._conn() as c:
            aid = self._require_session(c, session_token)
            rows = c.execute(
                "SELECT id,name,algo,created_at,last_used FROM trusted_devices "
                "WHERE account_id=? ORDER BY created_at", (aid,)).fetchall()
            return 200, {"devices": [dict(r) for r in rows], "max": MAX_DEVICES}

    def device_remove(self, session_token: str, device_id: str):
        with self._conn() as c:
            aid = self._require_session(c, session_token)
            row = c.execute("SELECT account_id FROM trusted_devices WHERE id=?",
                            (device_id,)).fetchone()
            if not row:
                raise ApiError(404, "not_found")
            if row["account_id"] != aid:
                raise ApiError(403, "not_owner")
            c.execute("DELETE FROM trusted_devices WHERE id=?", (device_id,))
            return 200, {"ok": True}

    # --- iPhone-PWA: offene Freigaben abfragen (Polling) -------------------
    def approval_pending(self, device_token: str):
        with self._conn() as c:
            dev = self._require_device(c, device_token)
            rows = c.execute(
                "SELECT approval_id,challenge,context,match_code,expires_at FROM pending_approvals "
                "WHERE account_id=? AND status='pending' AND expires_at>=?",
                (dev["account_id"], now())).fetchall()
            out = []
            for r in rows:
                # challenge geht mit: das Geraet braucht sie, um die kanonische
                # Approval-Nachricht zu signieren. Nur das authentifizierte Geraet erhaelt sie.
                out.append({"approval_id": r["approval_id"],
                            "challenge": r["challenge"],
                            "context": json.loads(r["context"]),
                            "match_code": r["match_code"],
                            "expires_at": r["expires_at"]})
            return 200, {"pending": out}

    # --- iPhone-PWA: Freigabe erteilen (signiert) --------------------------
    def approval_respond(self, device_token: str, approval_id: str, body: dict):
        decision = body.get("decision", "approve")
        with self._conn() as c:
            dev = self._require_device(c, device_token)
            ap = c.execute("SELECT * FROM pending_approvals WHERE approval_id=?",
                           (approval_id,)).fetchone()
            if not ap or ap["account_id"] != dev["account_id"]:
                raise ApiError(404, "approval_not_found")
            if ap["status"] != "pending":
                raise ApiError(409, "already_decided")
            if ap["expires_at"] < now():
                c.execute("UPDATE pending_approvals SET status='expired' WHERE approval_id=?",
                          (approval_id,))
                raise ApiError(410, "approval_expired")

            if decision == "deny":
                c.execute("UPDATE pending_approvals SET status='denied' WHERE approval_id=?",
                          (approval_id,))
                return 200, {"ok": True, "status": "denied"}

            # Freigabe: Signatur ueber die kanonische Nachricht pruefen.
            sig = body.get("signature")
            if not sig:
                raise ApiError(400, "signature_required")
            msg = self._approval_message(approval_id, ap["challenge"], json.loads(ap["context"]))
            if not self._verify_signature(dev["algo"], b64u_decode(dev["public_key"]),
                                          msg, b64u_decode(sig)):
                raise ApiError(401, "bad_signature")
            c.execute("UPDATE pending_approvals SET status='approved',device_id=? "
                      "WHERE approval_id=?", (dev["id"], approval_id))
            c.execute("UPDATE trusted_devices SET last_used=? WHERE id=?", (now(), dev["id"]))
            return 200, {"ok": True, "status": "approved"}

    # --- Notfall-Wiederherstellung: Blob + Salt holen ----------------------
    def recovery_start(self, body: dict):
        username = (body.get("username") or "").strip()
        with self._conn() as c:
            acc = self._account_by_name(c, username)
            if not acc:
                raise ApiError(404, "not_found")
            rec = c.execute("SELECT * FROM recovery WHERE account_id=?",
                            (acc["id"],)).fetchone()
            if not rec or rec["used"]:
                raise ApiError(410, "recovery_unavailable")
            return 200, {"salt_recovery": rec["salt_recovery"],
                         "protected_vault_key_recovery": rec["protected_vault_key_recovery"],
                         "version": rec["version"]}

    # --- Notfall-Wiederherstellung: atomar rotieren ------------------------
    def recovery_rotate(self, body: dict):
        username = (body.get("username") or "").strip()
        for k in ("expected_version", "new_protected_vault_key", "new_auth_proof",
                  "new_salt_recovery", "new_protected_vault_key_recovery"):
            if k not in body:
                raise ApiError(400, "missing_field", k)
        with self._conn() as c:
            acc = self._account_by_name(c, username)
            if not acc:
                raise ApiError(404, "not_found")
            try:
                c.execute("BEGIN IMMEDIATE")
                rec = c.execute("SELECT * FROM recovery WHERE account_id=?",
                                (acc["id"],)).fetchone()
                if not rec or rec["used"]:
                    raise ApiError(410, "recovery_unavailable")
                # Single-Use: der beim Start gelesene Code ist an diese Version gebunden.
                # Eine zweite Rotation mit demselben Code scheitert, weil version bereits
                # hochgezaehlt wurde (optimistische Nebenlaeufigkeitskontrolle).
                if rec["version"] != body["expected_version"]:
                    raise ApiError(409, "recovery_already_used")
                # Single-Use: alten Code verbrennen und neuen Zugang atomar setzen.
                # Neuer Master-Passwort-Auth-Hash
                auth_salt = secrets.token_bytes(16)
                auth_hash = self._scrypt(b64u_decode(body["new_auth_proof"]), auth_salt)
                c.execute("UPDATE vault_account SET protected_vault_key=?,auth_salt=?,"
                          "auth_proof_hash=? WHERE id=?",
                          (body["new_protected_vault_key"], b64u_encode(auth_salt),
                           auth_hash, acc["id"]))
                # Neuen Recovery-Code aktivieren, Version hochzaehlen, used=0 fuer den NEUEN
                c.execute("UPDATE recovery SET version=version+1,salt_recovery=?,"
                          "protected_vault_key_recovery=?,used=0 WHERE account_id=?",
                          (body["new_salt_recovery"],
                           body["new_protected_vault_key_recovery"], acc["id"]))
                # Alle Sessions killen
                c.execute("DELETE FROM sessions WHERE account_id=?", (acc["id"],))
                c.execute("COMMIT")
            except ApiError:
                c.execute("ROLLBACK")
                raise
            except Exception:
                c.execute("ROLLBACK")
                raise ApiError(500, "rotate_failed")
            return 200, {"ok": True, "version": rec["version"] + 1}

    # =======================================================================
    # Dispatch (fuer die Dashboard-Integration)
    # =======================================================================
    def handle(self, method: str, path: str, body: dict, ctx: dict):
        """ctx: {ip, user_agent, iso_time, session_token, device_token}."""
        st = ctx.get("session_token", "")
        dt = ctx.get("device_token", "")
        try:
            if method == "POST" and path == "/api/vault/account/setup":
                return self.account_setup(body)
            if method == "POST" and path == "/api/vault/auth/start":
                return self.auth_start(body, ctx)
            if method == "POST" and path == "/api/vault/auth/finish":
                return self.auth_finish(body)
            if method == "GET" and path == "/api/vault/bundle":
                return self.vault_bundle(st)
            if method == "POST" and path == "/api/vault/item":
                return self.item_put(st, body)
            if method == "DELETE" and path.startswith("/api/vault/item/"):
                return self.item_delete(st, path.rsplit("/", 1)[-1])
            if method == "POST" and path == "/api/vault/device/pair/start":
                return self.device_pair_start(st)
            if method == "POST" and path == "/api/vault/device/register/start":
                return self.device_register_start(ctx)
            if method == "POST" and path == "/api/vault/device/register/finish":
                return self.device_register_finish(ctx, body)
            if method == "GET" and path == "/api/vault/devices":
                return self.device_list(st)
            if method == "DELETE" and path.startswith("/api/vault/device/"):
                return self.device_remove(st, path.rsplit("/", 1)[-1])
            if method == "GET" and path == "/api/vault/approval/pending":
                return self.approval_pending(dt)
            if method == "POST" and path.startswith("/api/vault/approval/"):
                return self.approval_respond(dt, path.rsplit("/", 1)[-1], body)
            if method == "POST" and path == "/api/vault/recovery/start":
                return self.recovery_start(body)
            if method == "POST" and path == "/api/vault/recovery/rotate":
                return self.recovery_rotate(body)
            raise ApiError(404, "unknown_endpoint")
        except ApiError as e:
            return e.status, {"error": e.code, "message": e.message}


# ---------------------------------------------------------------------------
# Standalone-Dev-Server (nur zum Entwickeln/Testen; im Dashboard entfaellt das)
# ---------------------------------------------------------------------------
def _run_dev_server(db_path: str, port: int, host: str = "127.0.0.1"):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from datetime import datetime, timezone

    backend = VaultBackend(db_path)

    class H(BaseHTTPRequestHandler):
        def _ctx(self):
            auth = self.headers.get("Authorization", "")
            xff = self.headers.get("X-Forwarded-For", "")
            ip = (xff.split(",")[0].strip() if xff
                  else self.headers.get("X-Real-IP") or self.client_address[0])
            return {
                "ip": ip,
                "user_agent": self.headers.get("User-Agent", ""),
                "iso_time": datetime.now(timezone.utc).isoformat(),
                "session_token": auth[7:] if auth.startswith("Bearer ") else "",
                "device_token": self.headers.get("X-Device-Token", ""),
                "pairing_code": self.headers.get("X-Pairing-Code", ""),
            }

        def _read_body(self):
            n = int(self.headers.get("Content-Length", 0) or 0)
            if not n:
                return {}
            raw = self.rfile.read(n)
            try:
                return json.loads(raw)
            except Exception:
                return {}

        def _send(self, status, payload):
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _dispatch(self, method):
            path = self.path.split("?", 1)[0]
            body = self._read_body() if method in ("POST", "PUT", "DELETE") else {}
            status, payload = backend.handle(method, path, body, self._ctx())
            # Secret-freies Diagnose-Log fuer Auth-/Freigabe-Pfade (nur Status + Fehlercode)
            if path.startswith("/api/vault/auth") or path.startswith("/api/vault/approval"):
                import sys
                print(f"[vault] {method} {path} -> {status} {payload.get('error', 'ok')}",
                      file=sys.stderr, flush=True)
            self._send(status, payload)

        def _serve_static(self):
            path = self.path.split("?", 1)[0]
            if path in ("", "/"):
                path = "/index.html"
            root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
            fp = os.path.normpath(os.path.join(root, path.lstrip("/")))
            base = os.path.basename(fp)
            # Selbsttest-/Dev-Seiten in Produktion nicht ausliefern.
            if base.startswith("selftest") or not fp.startswith(root) or not os.path.isfile(fp):
                self.send_response(404); self.end_headers(); return
            ext = os.path.splitext(fp)[1]
            ctype = {".html": "text/html", ".js": "text/javascript", ".css": "text/css",
                     ".json": "application/json", ".webmanifest": "application/manifest+json",
                     ".svg": "image/svg+xml", ".wasm": "application/wasm"}.get(
                         ext, "application/octet-stream")
            with open(fp, "rb") as f:
                data = f.read()

            self.send_response(200)
            self.send_header("Content-Type", ctype + "; charset=utf-8")
            # Gemeinsame Sicherheits-Header
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            # App-Shell nicht heuristisch cachen (sonst zeigt der Browser alte Versionen);
            # nur das grosse, stabile Vendor-WASM + Icon duerfen gecacht werden.
            if "/vendor/" in path or ext == ".svg":
                self.send_header("Cache-Control", "public, max-age=86400")
            else:
                self.send_header("Cache-Control", "no-cache")
            if base == "sw.js":
                self.send_header("Service-Worker-Allowed", "/vault-app/")
            if ext == ".html":
                # Per-Request-Nonce fuer den Inline-Importmap; strenge CSP.
                nonce = b64u_encode(secrets.token_bytes(16))
                data = data.replace(b"__NONCE__", nonce.encode())
                csp = ("default-src 'none'; "
                       f"script-src 'self' 'nonce-{nonce}' 'wasm-unsafe-eval'; "
                       "style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
                       "connect-src 'self'; manifest-src 'self'; worker-src 'self'; "
                       "frame-ancestors 'self'; base-uri 'none'; form-action 'none'")
                self.send_header("Content-Security-Policy", csp)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path.startswith("/api/"):
                self._dispatch("GET")
            else:
                self._serve_static()
        def do_POST(self):   self._dispatch("POST")
        def do_DELETE(self): self._dispatch("DELETE")
        def log_message(self, *a): pass

    srv = ThreadingHTTPServer((host, port), H)
    print(f"Vault backend auf http://{host}:{port}  (db={db_path})")
    srv.serve_forever()


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="vault.db")
    ap.add_argument("--port", type=int, default=8099)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()
    _run_dev_server(args.db, args.port, args.host)
