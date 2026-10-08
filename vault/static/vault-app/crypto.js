/*
 * Zero-Knowledge Vault — Client-Krypto-Modul (der verbindliche Crypto-Contract).
 *
 * Laeuft im Browser UND in Node (Tests) — nutzt WebCrypto (globalThis.crypto.subtle)
 * und hash-wasm fuer Argon2id. Alles Geheime bleibt hier; nur Ciphertext/oeffentliche
 * Parameter gehen ueber die API zum Server.
 *
 * Schluessel-Hierarchie:
 *   masterPassword --Argon2id(salt_user)--> masterKey (32B)
 *   masterKey --HKDF "vault:enc:v1"--> SEK        (wrappt den Vault-Key)
 *   masterKey --HKDF "vault:auth:v1"--> authProof (Zugriffs-Gate, Server hasht es)
 *   vaultKey  = 32B Zufall, mit SEK gewrappt -> protected_vault_key
 *   Eintraege = AES-256-GCM(vaultKey, nonce, JSON, AAD=itemId|version)
 *
 * Contract-Version: 1. Jedes Krypto-Objekt traegt v=1.
 *
 * Browser-Einbindung: hash-wasm per Import-Map/Bundle bereitstellen (siehe README).
 */

import { WORDS } from "./wordlist.js";

const CONTRACT_VERSION = 1;
const DEFAULT_ARGON2 = { m: 65536, t: 3, p: 4, v: 1 }; // m in KiB (64 MiB)
const subtle = globalThis.crypto.subtle;

// hash-wasm lazy laden (Node: node_modules, Browser: Import-Map)
let _argon2idFn = null;
async function argon2id(password, salt, params) {
  if (!_argon2idFn) {
    const mod = await import("hash-wasm");
    _argon2idFn = mod.argon2id;
  }
  return _argon2idFn({
    password,
    salt,
    parallelism: params.p,
    iterations: params.t,
    memorySize: params.m, // KiB
    hashLength: 32,
    outputType: "binary",
  }); // -> Uint8Array(32)
}

/* ------------------------------------------------------------------ */
/* Encoding-Helfer                                                     */
/* ------------------------------------------------------------------ */
export function b64uEncode(bytes) {
  let bin = "";
  const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64uDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  str += "=".repeat((4 - (str.length % 4)) % 4);
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const utf8 = (s) => new TextEncoder().encode(s);
const fromUtf8 = (b) => new TextDecoder().decode(b);
function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

/* ------------------------------------------------------------------ */
/* Schluessel-Ableitung                                                */
/* ------------------------------------------------------------------ */
async function hkdf(keyBytes, saltBytes, infoStr, len = 32) {
  const base = await subtle.importKey("raw", keyBytes, "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: saltBytes, info: utf8(infoStr) },
    base,
    len * 8,
  );
  return new Uint8Array(bits);
}

// Aus dem Master-Passwort SEK (als AES-GCM-CryptoKey) + authProof (b64u) ableiten.
async function deriveFromMaster(password, saltUser, params) {
  const masterKey = await argon2id(utf8(password), saltUser, params);
  const sekBytes = await hkdf(masterKey, saltUser, "vault:enc:v1");
  const authProof = await hkdf(masterKey, saltUser, "vault:auth:v1");
  const sek = await subtle.importKey("raw", sekBytes, { name: "AES-GCM" }, false,
    ["encrypt", "decrypt"]);
  masterKey.fill(0); sekBytes.fill(0); // Spuren im Speicher minimieren
  return { sek, authProof };
}

// Recovery-Code normalisieren: Striche/Spaces weg, Grossschrift, Crockford-Tippfehler
// (I,L->1  O->0). So ist die Ableitung unabhaengig davon, wie der Nutzer ihn tippt.
export function normalizeRecoveryCode(code) {
  return code.toUpperCase().replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1").replace(/O/g, "0");
}

// Aus dem 24-stelligen Recovery-Code einen AES-GCM-Wrapping-Key ableiten.
async function deriveRecoveryKey(code, saltRecovery, params) {
  const rk = await argon2id(utf8(normalizeRecoveryCode(code)), saltRecovery, params);
  const key = await subtle.importKey("raw", rk, { name: "AES-GCM" }, false,
    ["encrypt", "decrypt"]);
  rk.fill(0);
  return key;
}

/* ------------------------------------------------------------------ */
/* Wrapping (Vault-Key ein-/auswickeln) + Eintrags-Krypto              */
/* ------------------------------------------------------------------ */
// Rohbytes mit einem AES-GCM-Key verschluesseln -> Blob-String {v,nonce,ct}.
async function gcmSeal(key, plaintextBytes, aadBytes = undefined) {
  const nonce = randomBytes(12);
  const alg = { name: "AES-GCM", iv: nonce };
  if (aadBytes) alg.additionalData = aadBytes;
  const ct = new Uint8Array(await subtle.encrypt(alg, key, plaintextBytes));
  return JSON.stringify({ v: CONTRACT_VERSION, nonce: b64uEncode(nonce), ct: b64uEncode(ct) });
}
async function gcmOpen(key, blobStr, aadBytes = undefined) {
  const blob = typeof blobStr === "string" ? JSON.parse(blobStr) : blobStr;
  const alg = { name: "AES-GCM", iv: b64uDecode(blob.nonce) };
  if (aadBytes) alg.additionalData = aadBytes;
  const pt = await subtle.decrypt(alg, key, b64uDecode(blob.ct));
  return new Uint8Array(pt);
}

function itemAad(itemId, version) {
  return utf8(`${itemId}|${version}`);
}

/* ------------------------------------------------------------------ */
/* Oeffentliche API                                                    */
/* ------------------------------------------------------------------ */

// Neues Konto: erzeugt alle Blobs fuer /account/setup + den einmaligen Recovery-Code.
export async function setupAccount(username, password) {
  const saltUser = randomBytes(16);
  const saltRecovery = randomBytes(16);
  const params = { ...DEFAULT_ARGON2 };

  const { sek, authProof } = await deriveFromMaster(password, saltUser, params);
  const vaultKeyBytes = randomBytes(32); // der eigentliche Datenschluessel

  const protectedVaultKey = await gcmSeal(sek, vaultKeyBytes);

  const recoveryCode = generateRecoveryCode();
  const rk = await deriveRecoveryKey(recoveryCode, saltRecovery, params);
  const protectedVaultKeyRecovery = await gcmSeal(rk, vaultKeyBytes);

  vaultKeyBytes.fill(0);
  return {
    payload: {
      username,
      salt_user: b64uEncode(saltUser),
      argon2_params: params,
      protected_vault_key: protectedVaultKey,
      auth_proof: b64uEncode(authProof),
      recovery: {
        salt_recovery: b64uEncode(saltRecovery),
        protected_vault_key_recovery: protectedVaultKeyRecovery,
      },
    },
    recoveryCode, // dem Nutzer EINMAL anzeigen, nirgends speichern
  };
}

// Login: nur den auth_proof fuer den Server ableiten (Wissensfaktor-Nachweis).
export async function deriveAuthProof(password, saltUserB64, params) {
  const { authProof } = await deriveFromMaster(password, b64uDecode(saltUserB64), params);
  return b64uEncode(authProof);
}

// Nach erfolgreichem Login: Vault-Key aus protected_vault_key auswickeln.
export async function unlockVaultKey(password, saltUserB64, params, protectedVaultKey) {
  const { sek } = await deriveFromMaster(password, b64uDecode(saltUserB64), params);
  const vkBytes = await gcmOpen(sek, protectedVaultKey);
  const vaultKey = await subtle.importKey("raw", vkBytes, { name: "AES-GCM" }, false,
    ["encrypt", "decrypt"]);
  vkBytes.fill(0);
  return vaultKey; // CryptoKey — im Speicher halten, bei Auto-Lock verwerfen
}

// Einen Eintrag verschluesseln -> Blob-String fuer /item. Neue Nonce bei jedem Aufruf.
export async function encryptItem(vaultKey, obj, itemId, version = 1) {
  return gcmSeal(vaultKey, utf8(JSON.stringify(obj)), itemAad(itemId, version));
}
export async function decryptItem(vaultKey, blobStr, itemId, version = 1) {
  const pt = await gcmOpen(vaultKey, blobStr, itemAad(itemId, version));
  return JSON.parse(fromUtf8(pt));
}

/* ------------------------------------------------------------------ */
/* Notfall-Wiederherstellung                                           */
/* ------------------------------------------------------------------ */
// Mit dem Recovery-Code den Vault-Key auswickeln (falsches -> GCM wirft).
export async function unlockVaultKeyWithRecovery(code, saltRecoveryB64, params, protectedVaultKeyRecovery) {
  const rk = await deriveRecoveryKey(code, b64uDecode(saltRecoveryB64), params);
  const vkBytes = await gcmOpen(rk, protectedVaultKeyRecovery);
  const vaultKey = await subtle.importKey("raw", vkBytes, { name: "AES-GCM" }, false,
    ["encrypt", "decrypt"]);
  return { vaultKey, vaultKeyBytes: vkBytes };
}

// Neues Master-PW + neuen Recovery-Code setzen (Client-Teil der Rotation).
// Bekommt die ausgewickelten Vault-Key-Rohbytes und erzeugt frische Wraps.
export async function rebuildForRotation(username, newPassword, vaultKeyBytes) {
  const saltUser = randomBytes(16);
  const saltRecovery = randomBytes(16);
  const params = { ...DEFAULT_ARGON2 };
  const { sek, authProof } = await deriveFromMaster(newPassword, saltUser, params);
  const newProtectedVaultKey = await gcmSeal(sek, vaultKeyBytes);
  const newRecoveryCode = generateRecoveryCode();
  const rk = await deriveRecoveryKey(newRecoveryCode, saltRecovery, params);
  const newProtectedVaultKeyRecovery = await gcmSeal(rk, vaultKeyBytes);
  return {
    payload: {
      username,
      salt_user: b64uEncode(saltUser), // fuers naechste Login-Salt (Server aktualisieren!)
      argon2_params: params,
      new_protected_vault_key: newProtectedVaultKey,
      new_auth_proof: b64uEncode(authProof),
      new_salt_recovery: b64uEncode(saltRecovery),
      new_protected_vault_key_recovery: newProtectedVaultKeyRecovery,
    },
    newRecoveryCode,
  };
}

/* ------------------------------------------------------------------ */
/* Geraete-Schluessel (iPhone-Besitzfaktor)                            */
/* ------------------------------------------------------------------ */
// Erzeugt ein nicht-extrahierbares Signatur-Keypair. Ed25519 bevorzugt, sonst P-256.
export async function generateDeviceKey() {
  try {
    const kp = await subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    return { keyPair: kp, algo: "ed25519" };
  } catch {
    const kp = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false,
      ["sign", "verify"]);
    return { keyPair: kp, algo: "p256" };
  }
}
export async function exportDevicePublicKey(keyPair) {
  const spki = new Uint8Array(await subtle.exportKey("spki", keyPair.publicKey));
  return b64uEncode(spki);
}
// Signiert eine Nachricht; Ausgabe-Format passt zur Server-Verifikation
// (Ed25519: raw 64B; P-256: raw r||s 64B — wie WebCrypto es liefert).
export async function signWithDevice(keyPair, algo, messageBytes) {
  const alg = algo === "ed25519" ? { name: "Ed25519" }
    : { name: "ECDSA", hash: "SHA-256" };
  const sig = new Uint8Array(await subtle.sign(alg, keyPair.privateKey, messageBytes));
  return b64uEncode(sig);
}
// Kanonische Approval-Nachricht — MUSS mit vault_backend._approval_message uebereinstimmen.
export async function approvalMessage(approvalId, challengeB64u, context) {
  const ctxSrc = `${context.ip || ""}|${context.user_agent || ""}|${context.iso_time || ""}`;
  const ctxHashBuf = await subtle.digest("SHA-256", utf8(ctxSrc));
  const ctxHashHex = [...new Uint8Array(ctxHashBuf)]
    .map((x) => x.toString(16).padStart(2, "0")).join("");
  return utf8(`vaultapprove:v1|${approvalId}|${challengeB64u}|${ctxHashHex}`);
}

/* ------------------------------------------------------------------ */
/* Passwort-Generator + Recovery-Code (bias-frei, CSPRNG)              */
/* ------------------------------------------------------------------ */
// Gleichverteilte Zufallsauswahl per Rejection-Sampling (kein Modulo-Bias).
function pick(alphabet) {
  return alphabet[randIndex(alphabet.length)];
}
// Uniformer Zufallsindex in [0, n) via Rejection-Sampling (fuer beliebiges n).
function randIndex(n) {
  const MAX = 0x100000000;
  const limit = MAX - (MAX % n);
  const buf = new Uint32Array(1);
  let x;
  do { globalThis.crypto.getRandomValues(buf); x = buf[0]; } while (x >= limit);
  return x % n;
}
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randIndex(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Zeichenbasiertes Passwort. Optionen: length, Zeichenklassen, Mindestanzahl
// Ziffern/Sonderzeichen, mehrdeutige Zeichen ausschliessen.
export function generatePassword(opts = {}) {
  const {
    length = 20, lower = true, upper = true, digits = true, symbols = true,
    excludeAmbiguous = true, minDigits = 1, minSymbols = 1,
  } = opts;
  let lo = "abcdefghijklmnopqrstuvwxyz";
  let up = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let di = "0123456789";
  let sy = "!#$%&()*+,-./:;<=>?@[]^_{|}~";
  if (excludeAmbiguous) {
    const bad = /[0O1lI]/g;
    lo = lo.replace(bad, ""); up = up.replace(bad, ""); di = di.replace(bad, "");
  }
  const classes = [];
  if (lower) classes.push(lo);
  if (upper) classes.push(up);
  if (digits) classes.push(di);
  if (symbols) classes.push(sy);
  if (!classes.length) throw new Error("mindestens eine Zeichenklasse noetig");
  const pool = classes.join("");

  // Pflichtzeichen: Mindestanzahlen + je 1 pro selektierter Klasse
  const required = [];
  const nd = digits ? Math.max(0, minDigits) : 0;
  const ns = symbols ? Math.max(0, minSymbols) : 0;
  for (let i = 0; i < nd; i++) required.push(pick(di));
  for (let i = 0; i < ns; i++) required.push(pick(sy));
  if (lower) required.push(pick(lo));
  if (upper) required.push(pick(up));
  if (digits && nd === 0) required.push(pick(di));
  if (symbols && ns === 0) required.push(pick(sy));

  const total = Math.max(length, required.length); // Mindestanzahlen haben Vorrang
  const out = required.slice();
  for (let i = out.length; i < total; i++) out.push(pick(pool));
  return shuffle(out).join("");
}

// Passphrase (Wort-Passwort) aus 2048-Wort-Liste (11 bit/Wort).
export function generatePassphrase(opts = {}) {
  const { words = 4, separator = "-", capitalize = true, includeNumber = true } = opts;
  const n = Math.max(3, Math.min(12, words | 0));
  const parts = [];
  for (let i = 0; i < n; i++) {
    let w = WORDS[randIndex(WORDS.length)];
    if (capitalize) w = w[0].toUpperCase() + w.slice(1);
    parts.push(w);
  }
  if (includeNumber) {
    const idx = randIndex(parts.length);
    parts[idx] = parts[idx] + randIndex(10);
  }
  return parts.join(separator);
}

// 24-stelliger Notfall-Code, Crockford-Base32 (~120 Bit Entropie).
export function generateRecoveryCode() {
  const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // ohne I,L,O,U
  let code = "";
  for (let i = 0; i < 24; i++) {
    if (i > 0 && i % 6 === 0) code += "-"; // Gruppierung fuer Lesbarkeit
    code += pick(CROCKFORD);
  }
  return code;
}

/* ------------------------------------------------------------------ */
/* TOTP (Authenticator) — 6-stelliger Code aus einem Base32-Secret      */
/* ------------------------------------------------------------------ */
function base32Decode(s) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  s = (s || "").replace(/=+$/, "").replace(/\s/g, "").toUpperCase();
  let bits = 0, value = 0;
  const out = [];
  for (const ch of s) {
    const idx = A.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return new Uint8Array(out);
}

// Liefert {code, secondsLeft, period} fuer das aktuelle 30s-Fenster.
export async function totpNow(secretB32, period = 30, digits = 6) {
  const key = base32Decode(secretB32);
  if (!key.length) throw new Error("leerer 2FA-Schluessel");
  const counter = Math.floor(Date.now() / 1000 / period);
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  dv.setUint32(0, Math.floor(counter / 2 ** 32));
  dv.setUint32(4, counter >>> 0);
  const ck = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const h = new Uint8Array(await subtle.sign("HMAC", ck, buf));
  const off = h[h.length - 1] & 0xf;
  const bin = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) |
    ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);
  const code = (bin % 10 ** digits).toString().padStart(digits, "0");
  const secondsLeft = period - Math.floor((Date.now() / 1000) % period);
  return { code, secondsLeft, period };
}

export const CONTRACT = { version: CONTRACT_VERSION, argon2: DEFAULT_ARGON2 };
