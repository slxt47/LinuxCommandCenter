-- Zero-Knowledge Vault — SQLite-Schema
-- WICHTIG: Der Server speichert ausschliesslich Ciphertext + oeffentliche Parameter.
-- Niemals Master-Passwort, Master-Key, SEK oder Vault-Key.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Ein Vault-Konto (Vault-Login ist UNABHAENGIG vom Linux-/etc/shadow-Login des Dashboards).
CREATE TABLE IF NOT EXISTS vault_account (
  id                   INTEGER PRIMARY KEY,
  username             TEXT UNIQUE NOT NULL,
  salt_user            TEXT NOT NULL,          -- b64u, oeffentlich (Argon2id-Salt)
  argon2_params        TEXT NOT NULL,          -- JSON {m,t,p,v}
  protected_vault_key  TEXT NOT NULL,          -- VK gewrappt mit SEK (nur Ciphertext)
  auth_salt            TEXT NOT NULL,          -- b64u, Salt fuer scrypt(auth_proof)
  auth_proof_hash      TEXT NOT NULL,          -- scrypt(auth_proof) — Zugriffs-Gate
  created_at           INTEGER NOT NULL
);

-- Verschluesselte Tresor-Eintraege. Server sieht nur die Blobs.
CREATE TABLE IF NOT EXISTS vault_items (
  id          TEXT PRIMARY KEY,               -- UUID (dient zugleich als AAD-Anker)
  account_id  INTEGER NOT NULL REFERENCES vault_account(id) ON DELETE CASCADE,
  blob        TEXT NOT NULL,                  -- {v,nonce,ct} — reiner Ciphertext
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_account ON vault_items(account_id);

-- Vertrauenswuerdige Besitz-Faktor-Geraete (iPhone). Nur Public-Key beim Server.
CREATE TABLE IF NOT EXISTS trusted_devices (
  id                TEXT PRIMARY KEY,          -- UUID
  account_id        INTEGER NOT NULL REFERENCES vault_account(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  public_key        TEXT NOT NULL,             -- SPKI-DER, b64u
  algo              TEXT NOT NULL,             -- 'ed25519' | 'p256'
  device_token_hash TEXT NOT NULL,            -- sha256(device_token) fuer Polling-Auth
  created_at        INTEGER NOT NULL,
  last_used         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_devices_account ON trusted_devices(account_id);

-- Out-of-Band Login-Freigaben (Challenge-Response).
CREATE TABLE IF NOT EXISTS pending_approvals (
  approval_id TEXT PRIMARY KEY,               -- UUID
  account_id  INTEGER NOT NULL REFERENCES vault_account(id) ON DELETE CASCADE,
  challenge   TEXT NOT NULL,                  -- b64u, 32 Byte
  context     TEXT NOT NULL,                  -- JSON {ip,user_agent,iso_time}
  match_code  TEXT NOT NULL,                  -- 2-stellige Zahl gegen Approval-Fatigue
  status      TEXT NOT NULL DEFAULT 'pending',-- pending|approved|denied|expired
  device_id   TEXT,                           -- welches Geraet hat freigegeben
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_account ON pending_approvals(account_id, status);

-- Kurze Registrierungs-Challenges (Geraet meldet sich neu an).
CREATE TABLE IF NOT EXISTS register_challenges (
  id         TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES vault_account(id) ON DELETE CASCADE,
  challenge  TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Kurzlebige Kopplungs-Codes: ein eingeloggter Client autorisiert damit die
-- einmalige Registrierung eines neuen Geraets (iPhone), ohne die Session zu teilen.
CREATE TABLE IF NOT EXISTS pairing_tokens (
  code_hash  TEXT PRIMARY KEY,               -- sha256(normalisierter Code)
  account_id INTEGER NOT NULL REFERENCES vault_account(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0
);

-- Aktive Sessions (Access-Token). Nur Hash gespeichert.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,                -- sha256(access_token)
  account_id INTEGER NOT NULL REFERENCES vault_account(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Notfall-Wiederherstellung. Zweiter kryptografischer Zugangsweg zum VK.
-- Kein code_hash noetig: falscher Code -> GCM-Unwrap scheitert clientseitig.
CREATE TABLE IF NOT EXISTS recovery (
  account_id                   INTEGER PRIMARY KEY REFERENCES vault_account(id) ON DELETE CASCADE,
  version                      INTEGER NOT NULL DEFAULT 1,   -- Rotationszaehler
  salt_recovery                TEXT NOT NULL,                -- b64u
  protected_vault_key_recovery TEXT NOT NULL,                -- VK gewrappt mit RK
  used                         INTEGER NOT NULL DEFAULT 0    -- Single-Use-Schutz
);
