/*
 * Vault-UI — verdrahtet crypto.js mit dem Backend. Bewusst framework-frei
 * (passt zum Dashboard-Stil). Der Vault-Key lebt nur im Speicher; Lock/Reload
 * verwirft ihn.
 */
import API from "./api.js?v=3";
import * as V from "./crypto.js?v=3";

/* ---------------- Zustand ---------------- */
const state = {
  username: null,
  saltUser: null,
  argon2: null,
  vaultKey: null,      // CryptoKey — Herzstueck, bei Lock verworfen
  items: [],           // [{id, version, data:{title,url,username,password,notes}}]
  pollTimer: null,
  lockTimer: null,
};

const AUTO_LOCK_MS = 5 * 60 * 1000;

/* ---------------- kleine DOM-Helfer ---------------- */
const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "onclick") n.addEventListener("click", v);
    else if (k === "oninput") n.addEventListener("input", v);
    else n.setAttribute(k, v);
  }
  for (const kid of kids) n.append(kid?.nodeType ? kid : document.createTextNode(kid ?? ""));
  return n;
};
function show(screen) {
  for (const s of document.querySelectorAll(".screen")) s.hidden = true;
  $("#screen-" + screen).hidden = false;
}
let modalTimer = null;   // z.B. laufender TOTP-Countdown im Detail-Dialog
function closeModal() {
  if (modalTimer) { clearInterval(modalTimer); modalTimer = null; }
  $("#modal").hidden = true;
}
function toast(msg, kind = "info") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast " + kind;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.hidden = true; }, 4000);
}

/* ---------------- Auto-Lock ---------------- */
function armLock() {
  clearTimeout(state.lockTimer);
  if (state.vaultKey) state.lockTimer = setTimeout(lock, AUTO_LOCK_MS);
}
function lock() {
  state.vaultKey = null;
  state.items = [];
  API.clearSession();
  clearTimeout(state.lockTimer);
  clearInterval(state.pollTimer);
  closeModal();
  show("login");
  toast("Tresor gesperrt.", "info");
}
["click", "keydown", "mousemove"].forEach((ev) =>
  document.addEventListener(ev, () => { if (state.vaultKey) armLock(); }, { passive: true }));

/* ---------------- Onboarding ---------------- */
async function doSetup() {
  const username = $("#ob-username").value.trim();
  const pw = $("#ob-password").value;
  const pw2 = $("#ob-password2").value;
  if (!username || !pw) return toast("Benutzername und Master-Passwort noetig.", "err");
  if (pw !== pw2) return toast("Passwoerter stimmen nicht ueberein.", "err");
  if (pw.length < 10) return toast("Master-Passwort zu kurz (min. 10 Zeichen).", "err");
  busy(true, "Konto wird kryptografisch erstellt (Argon2id)…");
  try {
    const { payload, recoveryCode } = await V.setupAccount(username, pw);
    const res = await API.setup(payload);
    if (res.status !== 201) {
      return toast("Setup fehlgeschlagen: " + (res.data.error || res.status), "err");
    }
    API.setSession(res.data.bootstrap_token);
    state.username = username;
    state.saltUser = payload.salt_user;
    state.argon2 = payload.argon2_params;
    // Vault-Key direkt entsperren, um sofort in den Tresor zu gehen.
    state.vaultKey = await V.unlockVaultKey(pw, payload.salt_user, payload.argon2_params,
      payload.protected_vault_key);
    showRecoveryCode(recoveryCode, async () => {
      await loadVault();
      show("vault");
      armLock();
      toast("Willkommen! Registriere als Naechstes dein iPhone als 2. Faktor.", "info");
    });
  } catch (e) {
    toast("Fehler: " + e.message, "err");
  } finally {
    busy(false);
  }
}

function showRecoveryCode(code, onConfirm) {
  const modal = $("#modal");
  if (modalTimer) { clearInterval(modalTimer); modalTimer = null; }
  modal.innerHTML = "";
  const chk = el("input", { type: "checkbox", id: "rc-ack" });
  const cont = el("button", { class: "btn primary", disabled: "true" }, "Weiter");
  chk.addEventListener("change", () => { cont.disabled = !chk.checked; });
  cont.addEventListener("click", () => { modal.hidden = true; onConfirm(); });
  modal.append(el("div", { class: "card" },
    el("h2", {}, "Notfall-Wiederherstellungscode"),
    el("p", { class: "muted" },
      "Der EINZIGE Weg zurueck, falls du dein Master-Passwort vergisst. " +
      "Notiere ihn offline und sicher. Er wird nur dieses eine Mal gezeigt."),
    el("div", { class: "code-box" }, code),
    el("label", { class: "row" }, chk,
      el("span", {}, " Ich habe den Code sicher gespeichert.")),
    cont));
  modal.hidden = false;
}

/* ---------------- Login mit iPhone-Freigabe ---------------- */
async function doLogin() {
  const username = $("#li-username").value.trim();
  const pw = $("#li-password").value;
  if (!username || !pw) return toast("Benutzername und Passwort noetig.", "err");
  busy(true, "Anmeldung wird vorbereitet…");
  try {
    const start = await API.authStart({ username });
    if (start.status !== 200) return toast("Login-Start fehlgeschlagen.", "err");
    const { salt_user, argon2_params, approval_id, match_code } = start.data;
    const authProof = await V.deriveAuthProof(pw, salt_user, argon2_params);
    // Passwort SOFORT validieren — der Server prueft auth_proof VOR der Freigabe.
    // So faellt ein falsches Master-Passwort hier auf, statt es als Freigabe-Fehler zu tarnen.
    const pre = await API.authFinish({ username, auth_proof: authProof, approval_id });
    if (pre.status === 401 && pre.data.error === "auth_failed") {
      busy(false); return toast("Falsches Master-Passwort.", "err");
    }
    if (pre.status === 401 && pre.data.error === "invalid_user") {
      busy(false); return toast("Unbekannter Benutzername.", "err");
    }
    busy(false);
    let token;
    if (pre.status === 200) {
      token = pre.data.access_token;  // (falls schon freigegeben)
    } else {
      // Passwort ist korrekt -> auf iPhone-Freigabe warten (Match-Code anzeigen)
      $("#li-wait-code").textContent = match_code;
      show("wait");
      const r = await pollForApproval(username, authProof, approval_id);
      if (!r.ok) {
        show("login");
        return toast(r.reason === "auth_failed" ? "Falsches Master-Passwort."
          : r.reason === "timeout" ? "Zeit abgelaufen — keine Freigabe erhalten."
          : "Freigabe abgelehnt oder abgelaufen.", "err");
      }
      token = r.token;
    }
    API.setSession(token);
    state.username = username;
    state.saltUser = salt_user;
    state.argon2 = argon2_params;
    const bundle = await API.bundle();
    state.vaultKey = await V.unlockVaultKey(pw, salt_user, argon2_params,
      bundle.data.protected_vault_key);
    await decryptBundle(bundle.data);
    show("vault");
    armLock();
    toast("Angemeldet.", "ok");
  } catch (e) {
    show("login");
    toast("Fehler: " + e.message, "err");
  } finally {
    busy(false);
  }
}

// Pollt auth/finish bis die iPhone-Freigabe erteilt ist (oder TTL ablaeuft).
async function pollForApproval(username, authProof, approvalId) {
  const deadline = Date.now() + 65000;
  while (Date.now() < deadline) {
    const res = await API.authFinish({ username, auth_proof: authProof, approval_id: approvalId });
    if (res.status === 200) return { ok: true, token: res.data.access_token };
    const err = res.data.error;
    if (err === "auth_failed") return { ok: false, reason: "auth_failed" };
    if (["approval_expired", "approval_missing"].includes(err)) return { ok: false, reason: "approval" };
    // approval_not_granted -> weiter warten
    await sleep(2000);
  }
  return { ok: false, reason: "timeout" };
}

/* ---------------- Tresor ---------------- */
async function loadVault() {
  const bundle = await API.bundle();
  if (bundle.status !== 200) return toast("Tresor laden fehlgeschlagen.", "err");
  await decryptBundle(bundle.data);
}
async function decryptBundle(data) {
  state.items = [];
  for (const it of data.items || []) {
    try {
      const obj = await V.decryptItem(state.vaultKey, it.blob, it.id);
      state.items.push({ id: it.id, version: it.version, data: obj });
    } catch {
      state.items.push({ id: it.id, version: it.version, data: { title: "⚠︎ nicht entschluesselbar" } });
    }
  }
  renderList();
}
/* ---------------- Vorlagen für bekannte Dienste ---------------- */
const TEMPLATES = [
  { name: "Google", url: "https://accounts.google.com", color: "#4285F4" },
  { name: "Gmail", url: "https://mail.google.com", color: "#EA4335" },
  { name: "YouTube", url: "https://youtube.com", color: "#FF0000" },
  { name: "GitHub", url: "https://github.com", color: "#5b6470" },
  { name: "GitLab", url: "https://gitlab.com", color: "#FC6D26" },
  { name: "Microsoft", url: "https://login.microsoftonline.com", color: "#0078D4" },
  { name: "Apple", url: "https://appleid.apple.com", color: "#5b616b" },
  { name: "Amazon", url: "https://amazon.de", color: "#FF9900" },
  { name: "Netflix", url: "https://netflix.com", color: "#E50914" },
  { name: "Disney+", url: "https://disneyplus.com", color: "#113CCF" },
  { name: "Spotify", url: "https://spotify.com", color: "#1DB954" },
  { name: "Facebook", url: "https://facebook.com", color: "#1877F2" },
  { name: "Instagram", url: "https://instagram.com", color: "#E4405F" },
  { name: "X", url: "https://x.com", color: "#26292e" },
  { name: "LinkedIn", url: "https://linkedin.com", color: "#0A66C2" },
  { name: "Reddit", url: "https://reddit.com", color: "#FF4500" },
  { name: "Discord", url: "https://discord.com", color: "#5865F2" },
  { name: "Twitch", url: "https://twitch.tv", color: "#9146FF" },
  { name: "Steam", url: "https://steampowered.com", color: "#2a475e" },
  { name: "PayPal", url: "https://paypal.com", color: "#0070BA" },
  { name: "Dropbox", url: "https://dropbox.com", color: "#0061FF" },
  { name: "WhatsApp", url: "https://web.whatsapp.com", color: "#25D366" },
  { name: "TikTok", url: "https://tiktok.com", color: "#25252b" },
  { name: "eBay", url: "https://ebay.de", color: "#E53238" },
];

const ICON_PALETTE = ["#3b82f6", "#ef4444", "#00e87b", "#a855f7", "#f97316", "#00d4ff", "#f59e0b"];
function iconFor(data) {
  const t = (data.title || "?").trim();
  const letter = (t[0] || "?").toUpperCase();
  let color = data.color;
  if (!color) {
    let h = 0;
    for (const c of t) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    color = ICON_PALETTE[h % ICON_PALETTE.length];
  }
  return { letter, color };
}
function monogram(data, size = 38) {
  const { letter, color } = iconFor(data);
  const n = el("div", { class: "mono-icon", style: `background:${color};width:${size}px;height:${size}px` }, letter);
  return n;
}

/* ---------------- Passwort-Stärke ---------------- */
function strengthOf(pw) {
  if (!pw) return { pct: 0, color: "var(--border-mid)", label: "—" };
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 32;
  const bits = pw.length * Math.log2(pool || 1);
  if (bits < 40) return { pct: 25, color: "var(--red)", label: "Schwach", bits };
  if (bits < 60) return { pct: 50, color: "var(--amber)", label: "Mittel", bits };
  if (bits < 90) return { pct: 75, color: "var(--accent-dim)", label: "Stark", bits };
  return { pct: 100, color: "var(--accent)", label: "Sehr stark", bits };
}

async function copyText(text, label = "Kopiert") {
  if (!text) return;
  try { await navigator.clipboard.writeText(text); toast(label + ".", "ok"); }
  catch { toast("Kopieren nicht moeglich (nur ueber HTTPS).", "err"); }
}

/* ---------------- Liste ---------------- */
function renderList(filter = "") {
  const list = $("#vault-list");
  list.innerHTML = "";
  const f = filter.toLowerCase();
  const items = state.items
    .filter((i) => !f || `${i.data.title} ${i.data.username} ${i.data.url}`.toLowerCase().includes(f))
    .sort((a, b) => (a.data.title || "").localeCompare(b.data.title || ""));
  if (!items.length) {
    list.append(el("div", { class: "empty" }, filter ? "Keine Treffer." : "Noch keine Eintraege. Lege oben einen an."));
    return;
  }
  for (const it of items) {
    const copyBtn = el("button", { class: "btn ghost sm", title: "Passwort kopieren",
      onclick: (e) => { e.stopPropagation(); copyText(it.data.password, "Passwort kopiert"); } }, "📋");
    list.append(el("div", { class: "item", onclick: () => openDetail(it) },
      monogram(it.data),
      el("div", { class: "item-main" },
        el("div", { class: "item-title" }, it.data.title || "(ohne Titel)"),
        el("div", { class: "item-sub" }, it.data.username || it.data.url || "")),
      el("div", { class: "item-actions" }, copyBtn)));
  }
}

/* ---------------- Vorlagen-Auswahl (neuer Eintrag) ---------------- */
function openTemplatePicker() {
  const modal = $("#modal");
  if (modalTimer) { clearInterval(modalTimer); modalTimer = null; }
  modal.innerHTML = "";
  const grid = el("div", { class: "tmpl-grid" });
  grid.append(el("div", { class: "tmpl", onclick: () => openEditor(null, {}) },
    el("div", { class: "mono-icon", style: "background:var(--bg-elevated);color:var(--text-secondary)" }, "+"),
    el("span", {}, "Eigener")));
  for (const t of TEMPLATES) {
    grid.append(el("div", { class: "tmpl", onclick: () =>
      openEditor(null, { title: t.name, url: t.url, color: t.color }) },
      monogram({ title: t.name, color: t.color }, 40),
      el("span", {}, t.name)));
  }
  modal.append(el("div", { class: "card wide" },
    el("h2", {}, "Vorlage wählen"),
    el("p", { class: "dim", style: "margin-bottom:8px" }, "Wähle einen Dienst oder lege einen eigenen Eintrag an."),
    grid,
    el("div", { class: "row mt" }, el("button", { class: "btn", onclick: closeModal }, "Abbrechen"))));
  modal.hidden = false;
}

/* ---------------- Passwort-Generator (wiederverwendbar) ---------------- */
function makeGenerator({ onApply } = {}) {
  let mode = "password";
  const cb = (on) => el("input", on ? { type: "checkbox", checked: "true" } : { type: "checkbox" });
  const opt = (c, label) => el("label", { class: "opt" }, c, el("span", {}, label));
  const num = (v, min, max) => el("input", { type: "number", min: String(min), max: String(max), value: String(v), style: "width:60px" });

  const output = el("input", { class: "mono", readonly: "true", style: "flex:1" });
  const sBar = el("i", {});
  const sLbl = el("span", { class: "dim" }, "");

  // Passwort-Optionen
  const len = el("input", { type: "range", min: "5", max: "128", value: "20", style: "flex:1" });
  const lenNum = num(20, 5, 128);
  const cUp = cb(true), cLo = cb(true), cDi = cb(true), cSy = cb(true), cAm = cb(true);
  const minD = num(1, 0, 9), minS = num(1, 0, 9);
  const pwOpts = el("div", {},
    el("div", { class: "opt" }, el("span", { style: "min-width:66px" }, "Länge"), len, lenNum),
    el("div", { class: "chips", style: "margin:8px 0" },
      opt(cUp, "A-Z"), opt(cLo, "a-z"), opt(cDi, "0-9"), opt(cSy, "!@#"), opt(cAm, "Ähnliche aus")),
    el("div", { class: "row", style: "gap:16px" },
      el("label", { class: "opt" }, el("span", {}, "Min. Ziffern"), minD),
      el("label", { class: "opt" }, el("span", {}, "Min. Sonderz."), minS)));

  // Passphrase-Optionen
  const wNum = num(4, 3, 10);
  const sep = el("select", { style: "width:auto" });
  for (const [v, t] of [["-", "Bindestrich -"], [".", "Punkt ."], ["_", "Unterstrich _"], [" ", "Leerzeichen"], ["", "keins"]]) {
    sep.append(el("option", { value: v }, t));
  }
  const cCap = cb(true), cNum = cb(true);
  const ppOpts = el("div", { hidden: "true" },
    el("div", { class: "opt" }, el("span", { style: "min-width:66px" }, "Wörter"), wNum,
      el("span", { style: "min-width:60px;margin-left:8px" }, "Trenner"), sep),
    el("div", { class: "chips", style: "margin:8px 0" }, opt(cCap, "Großschreiben"), opt(cNum, "Zahl einfügen")));

  function regen() {
    try {
      output.value = mode === "password"
        ? V.generatePassword({ length: +len.value, upper: cUp.checked, lower: cLo.checked,
            digits: cDi.checked, symbols: cSy.checked, excludeAmbiguous: cAm.checked,
            minDigits: +minD.value, minSymbols: +minS.value })
        : V.generatePassphrase({ words: +wNum.value, separator: sep.value,
            capitalize: cCap.checked, includeNumber: cNum.checked });
    } catch (e) { toast(e.message, "err"); return; }
    const s = strengthOf(output.value);
    sBar.style.width = s.pct + "%"; sBar.style.background = s.color;
    sLbl.textContent = `${s.label} · ${Math.round(s.bits)} bit`;
  }
  len.addEventListener("input", () => { lenNum.value = len.value; regen(); });
  lenNum.addEventListener("input", () => { len.value = lenNum.value; regen(); });
  for (const c of [cUp, cLo, cDi, cSy, cAm, minD, minS, wNum, cCap, cNum]) c.addEventListener("input", regen);
  sep.addEventListener("change", regen);

  const tabPw = el("button", { class: "btn sm primary" }, "Passwort");
  const tabPp = el("button", { class: "btn sm" }, "Passphrase");
  tabPw.addEventListener("click", () => { mode = "password"; tabPw.classList.add("primary"); tabPp.classList.remove("primary"); pwOpts.hidden = false; ppOpts.hidden = true; regen(); });
  tabPp.addEventListener("click", () => { mode = "passphrase"; tabPp.classList.add("primary"); tabPw.classList.remove("primary"); ppOpts.hidden = false; pwOpts.hidden = true; regen(); });

  const btnRe = el("button", { class: "btn icon", title: "Neu erzeugen", onclick: regen }, "🔄");
  const btnCopy = el("button", { class: "btn icon", title: "Kopieren", onclick: () => copyText(output.value, "Passwort kopiert") }, "📋");
  const footer = onApply
    ? el("div", { class: "row mt" }, el("button", { class: "btn primary sm", onclick: () => onApply(output.value) }, "✓ Übernehmen"))
    : el("span", {});

  const node = el("div", { class: "gen-panel" },
    el("div", { class: "row", style: "gap:6px;margin-bottom:10px" }, tabPw, tabPp),
    el("div", { class: "pw-row" }, output, btnRe, btnCopy),
    el("div", { class: "strength", style: "margin:8px 0 4px" }, sBar), sLbl,
    el("div", { style: "margin-top:10px" }, pwOpts, ppOpts),
    footer);
  regen();
  return { node };
}

/* ---------------- Editor ---------------- */
function openEditor(item, prefill = {}) {
  const d = item ? { ...item.data } : { title: "", url: "", username: "", password: "", notes: "", totp: "", ...prefill };
  const modal = $("#modal");
  if (modalTimer) { clearInterval(modalTimer); modalTimer = null; }
  modal.innerHTML = "";
  const f = {};
  const field = (key, label, type = "text") => {
    f[key] = el("input", { type, value: d[key] || "" });
    return el("label", { class: "field" }, el("span", {}, label), f[key]);
  };

  // Passwortfeld mit Anzeigen / Kopieren / Generieren
  const pwField = el("input", { type: "password", value: d.password || "" });
  f.password = pwField;
  const strengthBar = el("i", {});
  const strengthLbl = el("span", { class: "dim" }, "");
  const updateStrength = () => {
    const s = strengthOf(pwField.value);
    strengthBar.style.width = s.pct + "%"; strengthBar.style.background = s.color;
    strengthLbl.textContent = pwField.value ? `${s.label} · ${Math.round(s.bits)} bit` : "";
  };
  pwField.addEventListener("input", updateStrength);
  const revealBtn = el("button", { class: "btn icon", title: "Anzeigen",
    onclick: () => { pwField.type = pwField.type === "password" ? "text" : "password"; } }, "👁");
  const copyPw = el("button", { class: "btn icon", title: "Kopieren",
    onclick: () => copyText(pwField.value, "Passwort kopiert") }, "📋");
  const genToggle = el("button", { class: "btn icon", title: "Generator" }, "🎲");

  // Reichhaltiger Generator (lazy eingebunden, mit "Übernehmen")
  const genWrap = el("div", { hidden: "true" });
  let genBuilt = false;
  genToggle.addEventListener("click", () => {
    if (!genBuilt) {
      genWrap.append(makeGenerator({ onApply: (val) => {
        pwField.value = val; updateStrength(); genWrap.hidden = true;
      } }).node);
      genBuilt = true;
    }
    genWrap.hidden = !genWrap.hidden;
  });

  const save = el("button", { class: "btn primary", onclick: async () => {
    const obj = { title: f.title.value.trim(), url: f.url.value.trim(),
      username: f.username.value.trim(), password: f.password.value,
      totp: f.totp.value.replace(/\s/g, ""), notes: f.notes.value, color: d.color || "" };
    if (!obj.title) return toast("Titel fehlt.", "err");
    const id = item ? item.id : (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
    const blob = await V.encryptItem(state.vaultKey, obj, id);
    const res = await API.itemPut({ id, blob });
    if (res.status !== 200) return toast("Speichern fehlgeschlagen.", "err");
    closeModal(); await loadVault(); toast("Gespeichert.", "ok");
  } }, "Speichern");
  const actions = [save, el("button", { class: "btn", onclick: closeModal }, "Abbrechen")];
  if (item) {
    actions.push(el("button", { class: "btn danger", onclick: () => removeItem(item) }, "Löschen"));
  }

  modal.append(el("div", { class: "card wide" },
    el("div", { class: "brand" }, monogram(d), el("h2", { style: "margin:0" }, item ? "Eintrag bearbeiten" : "Neuer Eintrag")),
    field("title", "Titel"),
    field("url", "URL"),
    field("username", "Benutzername"),
    el("label", { class: "field" }, el("span", {}, "Passwort"),
      el("div", { class: "pw-row" }, pwField, revealBtn, copyPw, genToggle), genWrap,
      el("div", { class: "strength" }, strengthBar), strengthLbl),
    el("label", { class: "field" }, el("span", {}, "2FA-Schlüssel (TOTP, optional)"),
      (f.totp = el("input", { class: "mono", value: d.totp || "", placeholder: "Base32-Geheimnis" }))),
    el("label", { class: "field" }, el("span", {}, "Notizen"),
      (f.notes = el("textarea", {}, d.notes || ""))),
    el("div", { class: "row mt" }, ...actions)));
  modal.hidden = false;
  updateStrength();
}

/* ---------------- Detailansicht ---------------- */
async function removeItem(item) {
  const res = await API.itemDelete(item.id);
  if (res.status !== 200) return toast("Löschen fehlgeschlagen.", "err");
  closeModal(); await loadVault(); toast("Gelöscht.", "ok");
}

function openDetail(item) {
  const d = item.data;
  const modal = $("#modal");
  if (modalTimer) { clearInterval(modalTimer); modalTimer = null; }
  modal.innerHTML = "";
  const rows = [];
  const detailRow = (k, valNode, ...actions) =>
    el("div", { class: "detail-row" }, el("div", { class: "k" }, k),
      el("div", { class: "v" }, valNode), ...actions);

  if (d.username) {
    rows.push(detailRow("Benutzer", el("span", {}, d.username),
      el("button", { class: "btn ghost sm", onclick: () => copyText(d.username, "Benutzer kopiert") }, "📋")));
  }
  if (d.password) {
    const pwSpan = el("span", { class: "mono" }, "••••••••••");
    let shown = false;
    rows.push(detailRow("Passwort", pwSpan,
      el("button", { class: "btn ghost sm", onclick: () => { shown = !shown; pwSpan.textContent = shown ? d.password : "••••••••••"; } }, "👁"),
      el("button", { class: "btn ghost sm", onclick: () => copyText(d.password, "Passwort kopiert") }, "📋")));
  }
  if (d.url) {
    rows.push(detailRow("URL",
      el("a", { href: d.url, target: "_blank", rel: "noopener noreferrer", style: "color:var(--cyan)" }, d.url),
      el("button", { class: "btn ghost sm", onclick: () => copyText(d.url, "URL kopiert") }, "📋")));
  }
  if (d.totp) {
    const codeSpan = el("span", { class: "totp-code" }, "······");
    const ring = el("span", { class: "totp-ring" }, "");
    const tick = async () => {
      try {
        const t = await V.totpNow(d.totp);
        codeSpan.textContent = t.code.replace(/(\d{3})(\d{3})/, "$1 $2");
        ring.textContent = t.secondsLeft + "s";
      } catch { codeSpan.textContent = "ungültig"; }
    };
    tick(); modalTimer = setInterval(tick, 1000);
    rows.push(detailRow("2FA-Code", el("div", { class: "row" }, codeSpan, ring),
      el("button", { class: "btn ghost sm", onclick: async () => copyText((await V.totpNow(d.totp)).code, "Code kopiert") }, "📋")));
  }
  if (d.notes) rows.push(detailRow("Notizen", el("span", { style: "white-space:pre-wrap" }, d.notes)));

  modal.append(el("div", { class: "card wide" },
    el("div", { class: "brand", style: "margin-bottom:14px" }, monogram(d, 44),
      el("div", {}, el("h2", { style: "margin:0" }, d.title || "(ohne Titel)"),
        el("div", { class: "dim" }, d.url || ""))),
    ...rows,
    el("div", { class: "row mt" },
      el("button", { class: "btn primary", onclick: () => openEditor(item) }, "Bearbeiten"),
      el("button", { class: "btn", onclick: closeModal }, "Schließen"),
      el("span", { class: "grow" }),
      el("button", { class: "btn danger", onclick: () => removeItem(item) }, "Löschen"))));
  modal.hidden = false;
}

/* ---------------- Eigenständiger Generator ---------------- */
function openGenerator() {
  const modal = $("#modal");
  if (modalTimer) { clearInterval(modalTimer); modalTimer = null; }
  modal.innerHTML = "";
  modal.append(el("div", { class: "card wide" },
    el("h2", {}, "Passwort-Generator"),
    makeGenerator({}).node,
    el("div", { class: "row mt" }, el("button", { class: "btn", onclick: closeModal }, "Schließen"))));
  modal.hidden = false;
}

/* ---------------- Gerät koppeln / verwalten ---------------- */
async function showPairing() {
  const list = await API.deviceList();
  if (list.status !== 200) return toast("Geraete konnten nicht geladen werden.", "err");
  const devices = list.data.devices || [];
  const max = list.data.max || 3;
  const modal = $("#modal");
  if (modalTimer) { clearInterval(modalTimer); modalTimer = null; }
  modal.innerHTML = "";

  const card = el("div", { class: "card" },
    el("h2", {}, "Geraete"),
    el("p", { class: "muted" }, `${devices.length} von ${max} Geraeten gekoppelt.`));

  // Liste vorhandener Geräte mit Entfernen-Button
  for (const d of devices) {
    const created = new Date((d.created_at || 0) * 1000).toLocaleDateString();
    card.append(el("div", { class: "item", style: "display:flex;align-items:center;gap:10px" },
      el("div", { class: "grow" },
        el("div", { class: "item-title" }, d.name || "Geraet"),
        el("div", { class: "item-sub" }, `${d.algo} · seit ${created}`)),
      el("button", { class: "btn danger", onclick: async () => {
        const r = await API.deviceRemove(d.id);
        if (r.status !== 200) return toast("Entfernen fehlgeschlagen.", "err");
        toast("Geraet entfernt.", "ok");
        showPairing();
      } }, "Entfernen")));
  }

  if (devices.length >= max) {
    card.append(el("p", { class: "muted" },
      `Limit erreicht (max. ${max}). Entferne ein Geraet, um ein neues zu koppeln.`));
  } else {
    const start = await API.devicePairStart();
    if (start.status !== 200) {
      card.append(el("p", { class: "muted" }, "Kopplung konnte nicht gestartet werden."));
    } else {
      card.append(
        el("p", { class: "muted" },
          "Neues iPhone koppeln: Approver-App oeffnen (phone.html, Zum-Home-Bildschirm) " +
          "und diesen Code eingeben. Gueltig 5 Minuten, einmalig."),
        el("div", { class: "code-box" }, start.data.pairing_code));
    }
  }
  card.append(el("button", { class: "btn primary", onclick: () => { modal.hidden = true; } }, "Fertig"));
  modal.append(card);
  modal.hidden = false;
}

/* ---------------- Utils ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function busy(on, msg = "") {
  const b = $("#busy");
  b.hidden = !on;
  if (on) $("#busy-msg").textContent = msg;
}

/* ---------------- Verdrahtung ---------------- */
function wire() {
  $("#ob-submit").addEventListener("click", doSetup);
  $("#li-submit").addEventListener("click", doLogin);
  $("#to-login").addEventListener("click", () => show("login"));
  $("#to-onboarding").addEventListener("click", () => show("onboarding"));
  $("#btn-add").addEventListener("click", openTemplatePicker);
  $("#btn-gen").addEventListener("click", openGenerator);
  $("#btn-pair").addEventListener("click", showPairing);
  $("#btn-lock").addEventListener("click", lock);
  $("#search").addEventListener("input", (e) => renderList(e.target.value));
  $("#li-cancel-wait")?.addEventListener("click", () => show("login"));
  show("onboarding");
}
document.addEventListener("DOMContentLoaded", wire);

// Fuer Selbsttest/Debug (nur im Test genutzt)
window.__VAULT__ = { state, V, API };
