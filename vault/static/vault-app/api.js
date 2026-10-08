/*
 * API-Client fuer das Vault-Backend. Haelt Access-Token NUR im Speicher
 * (nie localStorage) — bei Reload/Lock ist es weg. Jede Methode liefert
 * {status, data}, damit die UI Fehlercodes (z.B. approval_not_granted) sieht.
 */
let _base = "";
let _session = null;
let _deviceToken = null;
let _pairingCode = null;

async function req(method, path, body, { device = false, pairing = false } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (_session && !device && !pairing) headers["Authorization"] = "Bearer " + _session;
  if (device && _deviceToken) headers["X-Device-Token"] = _deviceToken;
  if (pairing && _pairingCode) headers["X-Pairing-Code"] = _pairingCode;
  const res = await fetch(_base + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* leerer Body ok */ }
  return { status: res.status, data };
}

const API = {
  setBase: (b) => { _base = b; },
  setSession: (t) => { _session = t; },
  getSession: () => _session,
  clearSession: () => { _session = null; },
  setDeviceToken: (t) => { _deviceToken = t; },
  getDeviceToken: () => _deviceToken,
  setPairingCode: (c) => { _pairingCode = c; },

  setup: (p) => req("POST", "/api/vault/account/setup", p),
  authStart: (p) => req("POST", "/api/vault/auth/start", p),
  authFinish: (p) => req("POST", "/api/vault/auth/finish", p),
  bundle: () => req("GET", "/api/vault/bundle"),
  itemPut: (p) => req("POST", "/api/vault/item", p),
  itemDelete: (id) => req("DELETE", "/api/vault/item/" + encodeURIComponent(id)),

  devicePairStart: () => req("POST", "/api/vault/device/pair/start"),
  deviceList: () => req("GET", "/api/vault/devices"),
  deviceRemove: (id) => req("DELETE", "/api/vault/device/" + encodeURIComponent(id)),
  // Registrierung: per Session (Laptop) ODER per Kopplungs-Code (iPhone).
  deviceRegisterStart: (opts = {}) => req("POST", "/api/vault/device/register/start", undefined, opts),
  deviceRegisterFinish: (p, opts = {}) => req("POST", "/api/vault/device/register/finish", p, opts),
  approvalPending: () => req("GET", "/api/vault/approval/pending", undefined, { device: true }),
  approvalRespond: (id, p) =>
    req("POST", "/api/vault/approval/" + encodeURIComponent(id), p, { device: true }),

  recoveryStart: (p) => req("POST", "/api/vault/recovery/start", p),
  recoveryRotate: (p) => req("POST", "/api/vault/recovery/rotate", p),
};

export default API;
