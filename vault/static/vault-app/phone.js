/*
 * iPhone-PWA — der Besitz-Faktor ("Approver"). Kein Master-Passwort, keine
 * Tresor-Daten. Nur: ein geraetegebundener Signatur-Schluessel + Freigabe von
 * Login-Anfragen. Der Private-Key ist nicht-extrahierbar und liegt in IndexedDB.
 */
import API from "./api.js";
import * as V from "./crypto.js";

/* ---------------- IndexedDB (persistenter Geraeteschluessel) ---------------- */
const DB_NAME = "vault-approver";
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(key) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction("kv", "readonly").objectStore("kv").get(key);
    t.onsuccess = () => res(t.result);
    t.onerror = () => rej(t.error);
  });
}
async function idbSet(key, val) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction("kv", "readwrite").objectStore("kv").put(val, key);
    t.onsuccess = () => res();
    t.onerror = () => rej(t.error);
  });
}
async function idbClear() {
  const db = await idb();
  return new Promise((res) => {
    db.transaction("kv", "readwrite").objectStore("kv").clear().onsuccess = () => res();
  });
}

/* ---------------- DOM-Helfer ---------------- */
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "onclick") n.addEventListener("click", v);
    else n.setAttribute(k, v);
  }
  for (const kid of kids) n.append(kid?.nodeType ? kid : document.createTextNode(kid ?? ""));
  return n;
};
function show(id) {
  for (const s of document.querySelectorAll(".screen")) s.hidden = true;
  $("#" + id).hidden = false;
}
function toast(msg, kind = "info") {
  const t = $("#toast");
  t.textContent = msg; t.className = "toast " + kind; t.hidden = false;
  clearTimeout(t._t); t._t = setTimeout(() => (t.hidden = true), 3500);
}

/* ---------------- Zustand ---------------- */
let device = null; // { keyPair, algo, deviceToken, name }
let pollTimer = null;

/* ---------------- Kopplung ---------------- */
async function doPair() {
  const code = $("#pair-code").value.trim();
  const name = $("#pair-name").value.trim() || "iPhone";
  if (!code) return toast("Kopplungs-Code eingeben.", "err");
  $("#pair-btn").disabled = true;
  try {
    const { keyPair, algo } = await V.generateDeviceKey();
    const pub = await V.exportDevicePublicKey(keyPair);
    API.setPairingCode(code);
    const start = await API.deviceRegisterStart({ pairing: true });
    if (start.status !== 200) throw new Error(start.data.error || "Kopplung ungueltig");
    const sig = await V.signWithDevice(keyPair, algo, new TextEncoder().encode(start.data.challenge));
    const fin = await API.deviceRegisterFinish({
      challenge_id: start.data.challenge_id, name, public_key: pub, algo, signature: sig,
    }, { pairing: true });
    if (fin.status !== 201) throw new Error(fin.data.error || "Registrierung fehlgeschlagen");
    // Schluessel (nicht-extrahierbar) + Token persistent speichern
    await idbSet("keyPair", keyPair);
    await idbSet("algo", algo);
    await idbSet("deviceToken", fin.data.device_token);
    await idbSet("name", name);
    device = { keyPair, algo, deviceToken: fin.data.device_token, name };
    API.setDeviceToken(device.deviceToken);
    enterApprover();
    toast("Gekoppelt. Dieses iPhone gibt jetzt Logins frei.", "ok");
  } catch (e) {
    toast("Fehler: " + e.message, "err");
  } finally {
    $("#pair-btn").disabled = false;
  }
}

/* ---------------- Freigaben ---------------- */
function enterApprover() {
  $("#dev-name").textContent = device.name;
  show("screen-approver");
  poll();
  clearInterval(pollTimer);
  pollTimer = setInterval(poll, 3000);
}

async function poll() {
  try {
    const res = await API.approvalPending();
    if (res.status !== 200) return;
    renderApprovals(res.data.pending || []);
  } catch { /* offline -> stumm */ }
}

function renderApprovals(pending) {
  const list = $("#approval-list");
  list.innerHTML = "";
  if (!pending.length) {
    list.append(el("p", { class: "muted pad" }, "Keine offenen Anmeldeversuche."));
    return;
  }
  for (const ap of pending) {
    const when = new Date((ap.context.iso_time || "")).toLocaleString();
    list.append(el("div", { class: "approval" },
      el("div", { class: "big" }, "Anmeldeversuch"),
      el("div", { class: "muted" }, `IP: ${ap.context.ip || "?"}`),
      el("div", { class: "muted" }, isNaN(when) ? "" : when),
      el("div", { class: "match" }, "Abgleich-Code: ", el("b", {}, ap.match_code)),
      el("div", { class: "row gap" },
        el("button", { class: "btn primary", onclick: () => decide(ap, "approve") }, "✓ Freigeben"),
        el("button", { class: "btn danger", onclick: () => decide(ap, "deny") }, "✗ Ablehnen"))));
  }
}

async function decide(ap, decision) {
  try {
    let body = { decision };
    if (decision === "approve") {
      const msg = await V.approvalMessage(ap.approval_id, ap.challenge, ap.context);
      body.signature = await V.signWithDevice(device.keyPair, device.algo, msg);
    }
    const res = await API.approvalRespond(ap.approval_id, body);
    if (res.status === 200) toast(decision === "approve" ? "Freigegeben." : "Abgelehnt.", "ok");
    else toast("Fehlgeschlagen: " + (res.data.error || res.status), "err");
    poll();
  } catch (e) {
    toast("Fehler: " + e.message, "err");
  }
}

/* ---------------- Start ---------------- */
function boot() {
  $("#pair-btn").addEventListener("click", doPair);
  $("#unpair-btn").addEventListener("click", async () => {
    await idbClear(); location.reload();
  });
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
  // Sofort den Pairing-Screen zeigen (instant paint); danach asynchron pruefen,
  // ob dieses Geraet bereits gekoppelt ist -> dann in den Approver-Modus wechseln.
  show("screen-pair");
  (async () => {
    try {
      const token = await idbGet("deviceToken");
      if (!token) return;
      device = {
        keyPair: await idbGet("keyPair"), algo: await idbGet("algo"),
        deviceToken: token, name: (await idbGet("name")) || "iPhone",
      };
      API.setDeviceToken(token);
      enterApprover();
    } catch { /* kein gespeichertes Geraet -> Pairing-Screen bleibt */ }
  })();
}
document.addEventListener("DOMContentLoaded", boot);
window.__PHONE__ = { idbGet, idbSet };
