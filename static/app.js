
// ═══════════════════════════════════════════════════
//  LINUX COMMAND CENTER — Frontend Logic
// ═══════════════════════════════════════════════════

const API = window.location.origin;
let refreshInterval = null;
let currentPage = 'dashboard';
let terminalHistory = [];
let historyIndex = -1;
// ─── Terminal Screen Buffer (VT100/xterm emulator) ─────────
// Vollwertiger Screen-Puffer: Alternativ-Schirm (vim/htop/less), DEC-Sonder-
// zeichensatz (dialog/whiptail-Rahmen), Antworten auf Geräteabfragen (DA/DSR),
// Doppelbreiten-Zeichen und ein gecachter Rückblick-Puffer.
const _T_FG    = ['#1a1a2e','#ef4444','#4ade80','#fcd34d','#60a5fa','#c084fc','#67e8f9','#e2e8f0'];
const _T_FG_BR = ['#4a5e80','#f87171','#86efac','#fde68a','#93c5fd','#d8b4fe','#a5f3fc','#f8fafc'];
const _T_BG    = ['#000000','#7f1d1d','#14532d','#78350f','#1e3a5f','#581c87','#164e63','#374151'];
const _T_BG_BR = ['#334155','#b91c1c','#166534','#b45309','#1d4ed8','#7e22ce','#0e7490','#cbd5e1'];

// DEC Special Graphics (ESC ( 0) — ohne diese Abbildung zeichnen ncurses-
// Programme (dialog, whiptail, mc, nmtui) statt Rahmen die Buchstaben "lqqqk".
const _T_DECGFX = {
  '`':'◆','a':'▒','b':'␉','c':'␌','d':'␍','e':'␊','f':'°','g':'±','h':'␤','i':'␋',
  'j':'┘','k':'┐','l':'┌','m':'└','n':'┼','o':'⎺','p':'⎻','q':'─','r':'⎼','s':'⎽',
  't':'├','u':'┤','v':'┴','w':'┬','x':'│','y':'≤','z':'≥','{':'π','|':'≠','}':'£','~':'·'
};

// Zeichenbreite: CJK/Emoji belegen zwei Zellen, Kombinationszeichen keine.
function _tWide(cp) {
  return cp >= 0x1100 && (
    cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) || (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd));
}
function _tCombining(cp) {
  return (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x0483 && cp <= 0x0489) ||
         (cp >= 0x1ab0 && cp <= 0x1aff) || (cp >= 0x20d0 && cp <= 0x20ff) ||
         (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xfe20 && cp <= 0xfe2f) || cp === 0x200d;
}
function _tEsc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const _T_SCROLLBACK = 2500;

class TermScreen {
  constructor(cols, rows, opts) {
    opts = opts || {};
    this.onReply = opts.onReply || null;   // Antwort an die PTY (DA/DSR)
    this.onTitle = opts.onTitle || null;   // OSC 0/2 Fenstertitel
    this.onBell  = opts.onBell  || null;
    this.cols = cols || 80;
    this.rows = rows || 24;
    this._pend = '';
    this.reset();
  }

  // ── Aufbau ────────────────────────────────────────
  reset() {
    this.r = 0; this.c = 0; this.st = {}; this._wrapPend = false;
    this._sc = { r: 0, c: 0, st: {} };
    this._sT = 0; this._sB = this.rows - 1;
    this.cells = this._grid(this.rows, this.cols);
    this._sbH = []; this._sbCache = null;
    this._pend = '';
    this.alt = null; this.inAlt = false;
    this.curVis = true; this.appCursor = false; this.appKeypad = false;
    this.autoWrap = true; this.insertMode = false;
    this.bracketedPaste = false; this.mouse = 0; this.mouseSgr = false;
    this.title = ''; this.g0 = 'B'; this.g1 = 'B'; this.gl = 0;
    this._tabs = this._defTabs(this.cols);
  }
  _defTabs(cols) { const s = new Set(); for (let i = 8; i < cols + 8; i += 8) s.add(i); return s; }
  _grid(r, c) { return Array.from({ length: r }, () => this._row(c)); }
  _row(n) { return Array.from({ length: n || this.cols }, () => this._cell()); }
  _cell() { return { ch: ' ', fg: null, bg: null, b: false, d: false, i: false, u: false, s: false, h: false, w: 1 }; }

  _resizeGrid(cells, cols, rows) {
    const ng = Array.from({ length: rows }, () => this._row(cols));
    for (let r = 0; r < Math.min(rows, cells.length); r++)
      for (let c = 0; c < Math.min(cols, cells[r].length); c++) ng[r][c] = cells[r][c];
    return ng;
  }

  resize(cols, rows) {
    cols = Math.max(2, cols | 0); rows = Math.max(1, rows | 0);
    if (cols === this.cols && rows === this.rows) return;
    // Beim Verkleinern der Höhe wandern die obersten Zeilen in den Rückblick,
    // damit der Cursor (= die aktuelle Eingabezeile) sichtbar bleibt.
    if (!this.inAlt && rows < this.rows) {
      const drop = Math.min(this.rows - rows, Math.max(0, this.r - (rows - 1)));
      for (let i = 0; i < drop; i++) {
        this._pushSb(this.cells[0]);
        this.cells.shift(); this.cells.push(this._row(this.cols));
        this.r--;
      }
    }
    this.cells = this._resizeGrid(this.cells, cols, rows);
    if (this.alt) this.alt.cells = this._resizeGrid(this.alt.cells, cols, rows);
    this.cols = cols; this.rows = rows;
    this.r = Math.max(0, Math.min(this.r, rows - 1));
    this.c = Math.max(0, Math.min(this.c, cols - 1));
    this._sT = 0; this._sB = rows - 1;
    this._wrapPend = false;
    this._tabs = this._defTabs(cols);
  }

  // ── Rückblick-Puffer (gerendert zwischengespeichert) ──
  _pushSb(row) {
    this._sbH.push(this._rrow(row, -1));
    if (this._sbH.length > _T_SCROLLBACK) this._sbH.splice(0, this._sbH.length - _T_SCROLLBACK);
    this._sbCache = null;
  }

  // ── Eingabestrom ──────────────────────────────────
  feed(data) {
    data = this._pend + data; this._pend = '';
    let i = 0;
    while (i < data.length) {
      const cc = data.charCodeAt(i);
      if (cc === 0x1b) {
        const n = this._escSeq(data, i);
        if (n < 0) { this._pend = data.slice(i); break; }
        i += n; continue;
      }
      if (cc === 0x0d) { this.c = 0; this._wrapPend = false; i++; continue; }
      if (cc === 0x0a || cc === 0x0b || cc === 0x0c) { this._lf(); this._wrapPend = false; i++; continue; }
      if (cc === 0x08) { this._wrapPend = false; if (this.c > 0) this.c--; i++; continue; }
      if (cc === 0x09) { this._tab(1); i++; continue; }
      if (cc === 0x0e) { this.gl = 1; i++; continue; }
      if (cc === 0x0f) { this.gl = 0; i++; continue; }
      if (cc === 0x07) { if (this.onBell) this.onBell(); i++; continue; }
      if (cc < 0x20 || cc === 0x7f) { i++; continue; }
      // Halbes Surrogatpaar am Puffer-Ende → auf den nächsten Frame warten
      if (cc >= 0xd800 && cc <= 0xdbff && i + 1 >= data.length) { this._pend = data.slice(i); break; }
      const cp = data.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      this._put(ch, cp);
      i += ch.length;
    }
  }

  _tab(n) {
    for (let k = 0; k < n; k++) {
      let c = this.c + 1;
      while (c < this.cols - 1 && !this._tabs.has(c)) c++;
      this.c = Math.min(this.cols - 1, c);
    }
    this._wrapPend = false;
  }

  _lf() {
    if (this.r === this._sB) this._scrollUp(1);
    else if (this.r < this.rows - 1) this.r++;
  }
  _scrollUp(n) {
    for (let k = 0; k < n; k++) {
      if (!this.inAlt && this._sT === 0 && this._sB === this.rows - 1) this._pushSb(this.cells[this._sT]);
      this.cells.splice(this._sT, 1);
      this.cells.splice(this._sB, 0, this._row());
    }
  }
  _scrollDown(n) {
    for (let k = 0; k < n; k++) {
      this.cells.splice(this._sB, 1);
      this.cells.splice(this._sT, 0, this._row());
    }
  }

  _put(ch, cp) {
    if (_tCombining(cp)) {   // an die vorherige Zelle anhängen
      const pc = this.c > 0 ? this.cells[this.r][this.c - 1] : null;
      if (pc && pc.ch !== ' ') pc.ch += ch;
      return;
    }
    if ((this.gl === 1 ? this.g1 : this.g0) === '0' && _T_DECGFX[ch]) ch = _T_DECGFX[ch];
    const w = _tWide(cp) ? 2 : 1;
    if (this._wrapPend) {
      this._wrapPend = false;
      if (this.autoWrap) { this.c = 0; this._lf(); }
    }
    if (this.c + w > this.cols) {
      if (this.autoWrap) { this.c = 0; this._lf(); }
      else this.c = this.cols - w;
    }
    const s = this.st;
    const row = this.cells[this.r];
    if (this.insertMode) for (let k = 0; k < w; k++) { row.splice(this.c, 0, this._cell()); row.pop(); }
    row[this.c] = { ch, fg: s.fg || null, bg: s.bg || null, b: !!s.b, d: !!s.d, i: !!s.i,
                    u: !!s.u, s: !!s.s, h: !!s.h, w };
    if (w === 2 && this.c + 1 < this.cols) {
      row[this.c + 1] = { ch: '', fg: s.fg || null, bg: s.bg || null, b: false, d: false,
                          i: false, u: false, s: false, h: false, w: 0 };
    }
    this.c += w;
    if (this.c >= this.cols) { this.c = this.cols - 1; this._wrapPend = true; }
  }

  // ── Escape-Sequenzen ──────────────────────────────
  _escSeq(s, i) {
    if (i + 1 >= s.length) return -1;
    const c1 = s[i + 1];
    if (c1 === '[') {
      // Zwischenzeichen (0x20–0x2f) MÜSSEN mitgeparst werden, sonst landen
      // z. B. Cursorform-Sequenzen ("\x1b[2 q" aus vim) als " q" im Text.
      const m = s.slice(i).match(/^\x1b\[([0-9;:<=>?]*)([ -\/]*)([@-~])/);
      if (!m) return (s.length - i) < 64 ? -1 : 2;
      this._csi(m[1], m[3], m[2]);
      return m[0].length;
    }
    if (c1 === ']') {                                   // OSC
      const rest = s.slice(i + 2);
      const e = rest.search(/\x07|\x1b\\/);
      if (e < 0) return (s.length - i) < 4096 ? -1 : 2;
      this._osc(rest.slice(0, e));
      return 2 + e + (rest[e] === '\x07' ? 1 : 2);
    }
    if (c1 === 'P' || c1 === '^' || c1 === '_' || c1 === 'X') {  // DCS/PM/APC/SOS → überspringen
      const rest = s.slice(i + 2);
      const e = rest.search(/\x1b\\|\x07/);
      if (e < 0) return (s.length - i) < 4096 ? -1 : 2;
      return 2 + e + (rest[e] === '\x07' ? 1 : 2);
    }
    if (c1 === '(' || c1 === ')' || c1 === '*' || c1 === '+') {
      if (i + 2 >= s.length) return -1;
      const set = s[i + 2];
      if (c1 === '(') this.g0 = set; else if (c1 === ')') this.g1 = set;
      return 3;
    }
    if (c1 === '#' || c1 === '%') return i + 2 < s.length ? 3 : -1;
    if (c1 === 'M') { if (this.r === this._sT) this._scrollDown(1); else if (this.r > 0) this.r--; return 2; }
    if (c1 === 'D') { this._lf(); return 2; }
    if (c1 === 'E') { this._lf(); this.c = 0; return 2; }
    if (c1 === 'H') { this._tabs.add(this.c); return 2; }
    if (c1 === '7') { this._sc = { r: this.r, c: this.c, st: { ...this.st }, g0: this.g0, g1: this.g1, gl: this.gl }; return 2; }
    if (c1 === '8') { this._restoreCursor(); return 2; }
    if (c1 === 'c') { this.reset(); return 2; }
    if (c1 === '=') { this.appKeypad = true; return 2; }
    if (c1 === '>') { this.appKeypad = false; return 2; }
    return 2;
  }

  _restoreCursor() {
    const b = this._sc || {};
    this.r = Math.max(0, Math.min(b.r || 0, this.rows - 1));
    this.c = Math.max(0, Math.min(b.c || 0, this.cols - 1));
    this.st = { ...(b.st || {}) };
    if (b.g0 !== undefined) { this.g0 = b.g0; this.g1 = b.g1; this.gl = b.gl; }
    this._wrapPend = false;
  }

  _osc(body) {
    const sep = body.indexOf(';');
    if (sep < 0) return;
    const n = parseInt(body.slice(0, sep), 10);
    const val = body.slice(sep + 1);
    if (n === 0 || n === 2) { this.title = val; if (this.onTitle) this.onTitle(val); }
  }

  _reply(s) { if (this.onReply) this.onReply(s); }

  _csi(p, cmd, inter) {
    if (inter) {                       // Sequenzen mit Zwischenzeichen
      if (inter === '!' && cmd === 'p') this._softReset();
      return;                          // Cursorform (' q'), DECSCA ('"q') … ignorieren
    }
    const priv = p.startsWith('?');
    const ns = (priv ? p.slice(1) : p).split(';').map(v => (v === '' ? 0 : parseInt(v, 10) || 0));
    const p1 = ns[0] || 0, p2 = ns[1] || 0;

    if (priv) {
      if (cmd === 'h') { this._privMode(ns, true);  return; }
      if (cmd === 'l') { this._privMode(ns, false); return; }
      if (cmd === 'n' && p1 === 6) { this._reply(`\x1b[?${this.r + 1};${this.c + 1}R`); return; }
      return;                          // ?s / ?r (Modi sichern) — nicht nötig
    }

    // Cursorbewegende Befehle heben den ausstehenden Zeilenumbruch auf
    if ('HfABCDEFG`dJKLMP@STru'.includes(cmd)) this._wrapPend = false;

    switch (cmd) {
      case 'H': case 'f':
        this.r = Math.max(0, Math.min(this.rows - 1, (p1 || 1) - 1));
        this.c = Math.max(0, Math.min(this.cols - 1, (p2 || 1) - 1)); break;
      case 'A': this.r = Math.max(this._sT <= this.r ? this._sT : 0, this.r - (p1 || 1)); break;
      case 'B': this.r = Math.min(this._sB >= this.r ? this._sB : this.rows - 1, this.r + (p1 || 1)); break;
      case 'C': this.c = Math.min(this.cols - 1, this.c + (p1 || 1)); break;
      case 'D': this.c = Math.max(0, this.c - (p1 || 1)); break;
      case 'E': this.r = Math.min(this.rows - 1, this.r + (p1 || 1)); this.c = 0; break;
      case 'F': this.r = Math.max(0, this.r - (p1 || 1)); this.c = 0; break;
      case 'G': case '`': this.c = Math.max(0, Math.min(this.cols - 1, (p1 || 1) - 1)); break;
      case 'd': this.r = Math.max(0, Math.min(this.rows - 1, (p1 || 1) - 1)); break;
      case 'I': this._tab(p1 || 1); break;
      case 'Z': {                                  // Rück-Tabulator
        let c = this.c - 1;
        while (c > 0 && !this._tabs.has(c)) c--;
        this.c = Math.max(0, c); break;
      }
      case 'J':
        if (p1 === 0) { this._eraseInRow(this.cells[this.r], this.c, this.cols - 1); for (let r = this.r + 1; r < this.rows; r++) this.cells[r] = this._row(); }
        else if (p1 === 1) { for (let r = 0; r < this.r; r++) this.cells[r] = this._row(); this._eraseInRow(this.cells[this.r], 0, this.c); }
        else { for (let r = 0; r < this.rows; r++) this.cells[r] = this._row(); if (p1 === 3) { this._sbH = []; this._sbCache = null; } }
        break;
      case 'K':
        if (p1 === 0) this._eraseInRow(this.cells[this.r], this.c, this.cols - 1);
        else if (p1 === 1) this._eraseInRow(this.cells[this.r], 0, this.c);
        else this.cells[this.r] = this._row();
        break;
      case 'X': this._eraseInRow(this.cells[this.r], this.c, Math.min(this.cols - 1, this.c + (p1 || 1) - 1)); break;
      case 'L': {                                  // Zeilen einfügen (nur im Scrollbereich)
        if (this.r < this._sT || this.r > this._sB) break;
        const n = Math.min(p1 || 1, this._sB - this.r + 1);
        for (let k = 0; k < n; k++) { this.cells.splice(this._sB, 1); this.cells.splice(this.r, 0, this._row()); }
        break;
      }
      case 'M': {                                  // Zeilen löschen
        if (this.r < this._sT || this.r > this._sB) break;
        const n = Math.min(p1 || 1, this._sB - this.r + 1);
        for (let k = 0; k < n; k++) { this.cells.splice(this.r, 1); this.cells.splice(this._sB, 0, this._row()); }
        break;
      }
      case 'P': { const n = Math.min(p1 || 1, this.cols - this.c); const row = this.cells[this.r];
                  row.splice(this.c, n); for (let x = 0; x < n; x++) row.push(this._cell()); break; }
      case '@': { const n = Math.min(p1 || 1, this.cols - this.c); const row = this.cells[this.r];
                  for (let x = 0; x < n; x++) { row.splice(this.c, 0, this._cell()); row.pop(); } break; }
      case 'S': this._scrollUp(p1 || 1); break;
      case 'T': this._scrollDown(p1 || 1); break;
      case 'b': {                                  // Letztes Zeichen wiederholen
        const src = this.c > 0 ? this.cells[this.r][this.c - 1] : null;
        if (src && src.ch) for (let k = 0; k < (p1 || 1); k++) this._put(src.ch, src.ch.codePointAt(0));
        break;
      }
      case 'g': if (p1 === 3) this._tabs = new Set(); else this._tabs.delete(this.c); break;
      case 'm': this._sgr(ns); break;
      case 'h': if (p1 === 4) this.insertMode = true;  break;
      case 'l': if (p1 === 4) this.insertMode = false; break;
      case 'r':
        this._sT = Math.max(0, (p1 || 1) - 1);
        this._sB = Math.min(this.rows - 1, (p2 || this.rows) - 1);
        if (this._sB <= this._sT) { this._sT = 0; this._sB = this.rows - 1; }
        this.r = this._sT; this.c = 0; break;
      case 's': this._sc = { r: this.r, c: this.c, st: { ...this.st } }; break;
      case 'u': this._restoreCursor(); break;
      case 'c': this._reply('\x1b[?62;22c'); break;                       // Geräteattribute
      case 'n':
        if (p1 === 5) this._reply('\x1b[0n');
        else if (p1 === 6) this._reply(`\x1b[${this.r + 1};${this.c + 1}R`);
        break;
      case 't': if (p1 === 18) this._reply(`\x1b[8;${this.rows};${this.cols}t`); break;
    }
  }

  _eraseInRow(row, from, to) {
    for (let c = Math.max(0, from); c <= Math.min(this.cols - 1, to); c++) {
      const n = this._cell();
      if (this.st.bg) n.bg = this.st.bg;    // Hintergrundfarbe bleibt beim Löschen erhalten
      row[c] = n;
    }
  }

  _softReset() {
    this.st = {}; this._sT = 0; this._sB = this.rows - 1;
    this.insertMode = false; this.autoWrap = true; this.curVis = true;
    this.appCursor = false; this.appKeypad = false;
    this.g0 = 'B'; this.g1 = 'B'; this.gl = 0;
  }

  _privMode(ns, on) {
    for (const n of ns) {
      switch (n) {
        case 1:    this.appCursor = on; break;
        case 7:    this.autoWrap = on; break;
        case 25:   this.curVis = on; break;
        case 1000: case 1002: case 1003: this.mouse = on ? n : 0; break;
        case 1006: this.mouseSgr = on; break;
        case 2004: this.bracketedPaste = on; break;
        case 47: case 1047: on ? this._altOn() : this._altOff(); break;
        case 1048: on ? (this._sc = { r: this.r, c: this.c, st: { ...this.st } }) : this._restoreCursor(); break;
        case 1049:
          if (on) { this._sc = { r: this.r, c: this.c, st: { ...this.st } }; this._altOn(); }
          else this._altOff();
          break;
      }
    }
  }

  // Alternativ-Schirm: vim/htop/less/man zeichnen hier hinein — ohne ihn wird
  // der Rückblick überschrieben und nach dem Beenden bleibt der Schirmmüll stehen.
  _altOn() {
    if (this.inAlt) return;
    this.alt = { cells: this.cells, r: this.r, c: this.c, st: { ...this.st }, sT: this._sT, sB: this._sB };
    this.cells = this._grid(this.rows, this.cols);
    this.r = 0; this.c = 0; this._sT = 0; this._sB = this.rows - 1;
    this._wrapPend = false; this.inAlt = true;
  }
  _altOff() {
    if (!this.inAlt) return;
    const a = this.alt;
    this.cells = this._resizeGrid(a.cells, this.cols, this.rows);
    this.r = Math.min(a.r, this.rows - 1); this.c = Math.min(a.c, this.cols - 1);
    this.st = a.st;
    this._sT = Math.min(a.sT, this.rows - 1);
    this._sB = Math.min(a.sB, this.rows - 1);
    if (this._sB <= this._sT) { this._sT = 0; this._sB = this.rows - 1; }
    this.alt = null; this.inAlt = false; this._wrapPend = false;
  }

  _sgr(ns) {
    if (!ns.length) ns = [0];
    let i = 0;
    while (i < ns.length) {
      const n = ns[i];
      if (n === 0) this.st = {};
      else if (n === 1) this.st.b = true;
      else if (n === 2) this.st.d = true;
      else if (n === 3) this.st.i = true;
      else if (n === 4) this.st.u = true;
      else if (n === 5 || n === 6) this.st.b = true;      // Blinken → hervorheben statt blinken
      else if (n === 7) { const t = this.st.fg; this.st.fg = this.st.bg || '#0b1220'; this.st.bg = t || '#c8d4e8'; }
      else if (n === 8) this.st.h = true;
      else if (n === 9) this.st.s = true;
      else if (n === 21 || n === 22) { delete this.st.b; delete this.st.d; }
      else if (n === 23) delete this.st.i;
      else if (n === 24) delete this.st.u;
      else if (n === 25) { /* Blinken aus */ }
      else if (n === 27) { delete this.st.fg; delete this.st.bg; }
      else if (n === 28) delete this.st.h;
      else if (n === 29) delete this.st.s;
      else if (n >= 30 && n <= 37) this.st.fg = _T_FG[n - 30];
      else if (n === 39) delete this.st.fg;
      else if (n >= 40 && n <= 47) this.st.bg = _T_BG[n - 40];
      else if (n === 49) delete this.st.bg;
      else if (n >= 90 && n <= 97) this.st.fg = _T_FG_BR[n - 90];
      else if (n >= 100 && n <= 107) this.st.bg = _T_BG_BR[n - 100];
      else if (n === 38 && ns[i + 1] === 5 && i + 2 < ns.length) { this.st.fg = this._c256(ns[i + 2]); i += 2; }
      else if (n === 38 && ns[i + 1] === 2 && i + 4 < ns.length) { this.st.fg = `rgb(${ns[i + 2]},${ns[i + 3]},${ns[i + 4]})`; i += 4; }
      else if (n === 48 && ns[i + 1] === 5 && i + 2 < ns.length) { this.st.bg = this._c256(ns[i + 2]); i += 2; }
      else if (n === 48 && ns[i + 1] === 2 && i + 4 < ns.length) { this.st.bg = `rgb(${ns[i + 2]},${ns[i + 3]},${ns[i + 4]})`; i += 4; }
      i++;
    }
  }

  _c256(n) {
    if (n < 8) return _T_FG[n];
    if (n < 16) return _T_FG_BR[n - 8];
    if (n < 232) { const i = n - 16, b = i % 6, g = Math.floor(i / 6) % 6, r = Math.floor(i / 36), v = k => (k ? 55 + k * 40 : 0);
                   return `rgb(${v(r)},${v(g)},${v(b)})`; }
    const x = 8 + (n - 232) * 10; return `rgb(${x},${x},${x})`;
  }

  // ── Darstellung ───────────────────────────────────
  _css(c) {
    let s = '';
    if (c.h) return 'color:transparent;' + (c.bg ? `background:${c.bg};` : '');
    if (c.fg) s += `color:${c.fg};`;
    if (c.bg) s += `background:${c.bg};`;
    if (c.b) s += 'font-weight:700;';
    if (c.i) s += 'font-style:italic;';
    if (c.u && c.s) s += 'text-decoration:underline line-through;';
    else if (c.u) s += 'text-decoration:underline;';
    else if (c.s) s += 'text-decoration:line-through;';
    if (c.d) s += 'opacity:.6;';
    return s;
  }

  _rrow(row, cur) {
    let html = '', cs = null, span = false, last = -1;
    for (let c = row.length - 1; c >= 0; c--) {
      const cl = row[c];
      if (cl.ch !== ' ' || cl.fg || cl.bg || cl.u || cl.s) { last = c; break; }
    }
    if (cur >= 0 && cur > last) last = cur;
    if (last < 0) return '';
    for (let c = 0; c <= last; c++) {
      const cl = row[c];
      if (cl.w === 0) continue;                       // Fortsetzung eines Doppelbreiten-Zeichens
      const s = (c === cur)
        ? `color:${cl.bg || '#0a0f1a'};background:${cl.fg || '#c8d4e8'};` + (cl.b ? 'font-weight:700;' : '') + (cl.i ? 'font-style:italic;' : '')
        : this._css(cl);
      if (s !== cs) { if (span) { html += '</span>'; span = false; } cs = s; if (s) { html += `<span style="${s}">`; span = true; } }
      html += _tEsc(cl.ch === '' ? ' ' : cl.ch);
    }
    return span ? html + '</span>' : html;
  }

  toHtml() {
    if (this._sbCache === null) this._sbCache = this._sbH.join('\n');
    const cur = this.curVis ? this.c : -1;
    const rows = this.cells.map((row, ri) => this._rrow(row, ri === this.r ? cur : -1));
    let end = rows.length;
    while (end > 0 && rows[end - 1] === '') end--;
    if (this.r + 1 > end) end = this.r + 1;
    const live = rows.slice(0, end).join('\n');
    if (!this._sbH.length) return live;
    return this._sbCache + (live ? '\n' + live : '');
  }

  // Text-Auszug (Kopieren des sichtbaren Puffers)
  toText() {
    const strip = h => h.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    return this.toHtml().split('\n').map(strip).join('\n');
  }
}

// ─── WebSocket-PTY: Grundlagen ────────────────────────
// Wichtig: {stream:true} — sonst zerfällt ein UTF-8-Zeichen, das auf zwei
// WebSocket-Frames aufgeteilt wurde, in zwei Ersatzzeichen (»<?>«).
const _termDec = new TextDecoder('utf-8', { fatal: false });
const _termEnc = new TextEncoder();
let _termWs = null;
let _termReconnectTimer = null;
let _termScreen = new TermScreen(80, 24, {
  onReply: (s) => _termSend(s),          // Antwort auf DA/DSR zurück an die PTY
  onTitle: (t) => termSetTitle(t),       // OSC 0/2 → Kopfzeile aktualisieren
});

// Alte Tabelle — wird von der Docker-Container-Konsole weiterverwendet.
const TERM_KEY_MAP = {
  'Backspace':'\x7f','Tab':'\t','Enter':'\r','Escape':'\x1b',
  'ArrowUp':'\x1b[A','ArrowDown':'\x1b[B','ArrowRight':'\x1b[C','ArrowLeft':'\x1b[D',
  'Home':'\x1b[H','End':'\x1b[F','Delete':'\x1b[3~',
  'PageUp':'\x1b[5~','PageDown':'\x1b[6~',
  'F1':'\x1bOP','F2':'\x1bOQ','F3':'\x1bOR','F4':'\x1bOS',
  'F5':'\x1b[15~','F6':'\x1b[17~','F7':'\x1b[18~','F8':'\x1b[19~',
  'F9':'\x1b[20~','F10':'\x1b[21~','F11':'\x1b[23~','F12':'\x1b[24~',
};

// ─── Tastenumsetzung mit Modifikatoren ────────────────
// xterm-Kodierung: Modifikator = 1 + Shift(1) + Alt(2) + Strg(4) + Meta(8).
// Damit funktionieren Strg+Pfeil (wortweise springen), Shift+Pfeil (markieren
// in mc/nano), Strg+Shift+Pfeil usw. — vorher wurden Modifikatoren verworfen.
const _T_CURSOR_KEYS = { ArrowUp:'A', ArrowDown:'B', ArrowRight:'C', ArrowLeft:'D', Home:'H', End:'F' };
const _T_TILDE_KEYS  = { Insert:2, Delete:3, PageUp:5, PageDown:6,
                         F5:15, F6:17, F7:18, F8:19, F9:20, F10:21, F11:23, F12:24 };
const _T_SS3_KEYS    = { F1:'P', F2:'Q', F3:'R', F4:'S' };
const _T_CTRL_SPECIAL = { '@':0, ' ':0, '2':0, '[':27, '3':27, '\\':28, '4':28,
                          ']':29, '5':29, '^':30, '6':30, '_':31, '7':31, '?':127, '8':127, '/':31 };

function _termCtrlChar(ch) {
  const lower = ch.toLowerCase();
  const cc = lower.charCodeAt(0);
  if (cc >= 97 && cc <= 122) return String.fromCharCode(cc - 96);   // a–z → 0x01–0x1a
  if (ch in _T_CTRL_SPECIAL) return String.fromCharCode(_T_CTRL_SPECIAL[ch]);
  return null;
}

function termSeqFor(key, mods, appCursor) {
  mods = mods || {};
  const mod = 1 + (mods.shift ? 1 : 0) + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0) + (mods.meta ? 8 : 0);
  const cur = _T_CURSOR_KEYS[key];
  if (cur) {
    if (mod > 1) return `\x1b[1;${mod}${cur}`;
    return (appCursor ? '\x1bO' : '\x1b[') + cur;
  }
  const tl = _T_TILDE_KEYS[key];
  if (tl !== undefined) return mod > 1 ? `\x1b[${tl};${mod}~` : `\x1b[${tl}~`;
  const ss3 = _T_SS3_KEYS[key];
  if (ss3) return mod > 1 ? `\x1b[1;${mod}${ss3}` : '\x1bO' + ss3;
  if (key === 'Tab')       return mods.shift ? '\x1b[Z' : (mods.alt ? '\x1b\t' : '\t');
  if (key === 'Enter')     return mods.alt ? '\x1b\r' : '\r';
  if (key === 'Backspace') return mods.ctrl ? '\x08' : (mods.alt ? '\x1b\x7f' : '\x7f');
  if (key === 'Escape')    return '\x1b';
  if (key === 'Spacebar' || key === ' ') return mods.ctrl ? '\x00' : (mods.alt ? '\x1b ' : ' ');
  if (Array.from(key).length === 1) {
    let s = key;
    if (mods.ctrl) { const c = _termCtrlChar(key); if (c !== null) s = c; }
    if (mods.alt) s = '\x1b' + s;
    return s;
  }
  return '';
}

function _termSend(data) {
  if (_termWs && _termWs.readyState === WebSocket.OPEN) {
    _termWs.send(typeof data === 'string' ? _termEnc.encode(data) : data);
    _termScrollBottom();
  }
}

function _termScrollBottom() {
  const out = document.getElementById('terminal-output');
  if (out) out.scrollTop = out.scrollHeight;
}

// Echte Zellgröße messen statt 8×16 px zu raten — die geratenen Werte lagen
// bei 13 px/1.6 Zeilenhöhe rund 30 % daneben, wodurch die PTY eine zu große
// Zeilenzahl bekam und top/htop/vim aus dem sichtbaren Bereich liefen.
function termCellSize(out) {
  const probe = document.createElement('span');
  probe.textContent = 'M'.repeat(80);
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;left:-9999px;top:-9999px;';
  out.appendChild(probe);
  const w = probe.getBoundingClientRect().width / 80;
  out.removeChild(probe);
  const st = getComputedStyle(out);
  let h = parseFloat(st.lineHeight);
  if (!isFinite(h) || h <= 0) h = parseFloat(st.fontSize) * 1.2;
  return { w: w > 0 ? w : 8, h: h > 0 ? h : 16 };
}

function termGeometry(out) {
  const st = getComputedStyle(out);
  const padX = parseFloat(st.paddingLeft || 0) + parseFloat(st.paddingRight || 0);
  const padY = parseFloat(st.paddingTop || 0) + parseFloat(st.paddingBottom || 0);
  const cell = termCellSize(out);
  const cols = Math.max(20, Math.min(500, Math.floor((out.clientWidth - padX - 1) / cell.w)));
  const rows = Math.max(5,  Math.min(200, Math.floor((out.clientHeight - padY) / cell.h)));
  return { cols, rows, cell };
}

function _termSendResize() {
  const out = document.getElementById('terminal-output');
  if (!out || !out.clientWidth) return;
  const { cols, rows } = termGeometry(out);
  if (cols === _termScreen.cols && rows === _termScreen.rows) return;
  _termScreen.resize(cols, rows);
  _termRender();
  if (_termWs && _termWs.readyState === WebSocket.OPEN)
    _termWs.send(JSON.stringify({ type: 'resize', cols, rows }));
  const el = document.getElementById('term-size');
  if (el) el.textContent = `${cols}×${rows}`;
}

function _termSetStatus(text, color) {
  const el = document.getElementById('term-ws-status');
  if (el) { el.textContent = text; el.style.color = color || 'var(--text-muted)'; }
}

let _termRenderPending = false;
function _termRender() {
  if (_termRenderPending) return;
  _termRenderPending = true;
  requestAnimationFrame(() => {
    _termRenderPending = false;
    const out = document.getElementById('terminal-output');
    if (!out || !_termScreen) return;
    // Im Alternativ-Schirm (vim/htop) gibt es kein Scrollen — immer ganz zeigen
    const atBottom = _termScreen.inAlt || (out.scrollHeight - out.scrollTop - out.clientHeight < 60);
    out.innerHTML = _termScreen.toHtml();
    if (atBottom) out.scrollTop = out.scrollHeight;
  });
}

// ─── Modifikator-Tasten für Mobilgeräte ───────────────
// 0 = aus, 1 = einmalig scharf, 2 = dauerhaft (Doppeltipp). Sie wirken auf die
// Leisten-Tasten UND auf Zeichen, die anschließend über die Bildschirmtastatur
// eingegeben werden — damit ist z. B. Strg+C oder Strg+Shift+→ mobil möglich.
const _termMod = { ctrl: 0, alt: 0, shift: 0 };

function termToggleMod(name) {
  _termMod[name] = (_termMod[name] + 1) % 3;
  _termPaintMods();
  termFocus();
}

function _termPaintMods() {
  for (const name of ['ctrl', 'alt', 'shift']) {
    const b = document.getElementById(`term-mod-${name}`);
    if (!b) continue;
    b.classList.toggle('armed',  _termMod[name] === 1);
    b.classList.toggle('locked', _termMod[name] === 2);
  }
}

function _termPeekMods() {
  return { ctrl: _termMod.ctrl > 0, alt: _termMod.alt > 0, shift: _termMod.shift > 0 };
}

function _termTakeMods() {
  const m = _termPeekMods();
  let changed = false;
  for (const name of ['ctrl', 'alt', 'shift'])
    if (_termMod[name] === 1) { _termMod[name] = 0; changed = true; }
  if (changed) _termPaintMods();
  return m;
}

// Taste aus der Leiste: nutzt dieselbe Umsetzung wie die echte Tastatur
function termKeyBtn(key) {
  const seq = termSeqFor(key, _termTakeMods(), _termScreen && _termScreen.appCursor);
  if (seq) _termSend(seq);
  termFocus();
}

// Feste Kombination (z. B. Strg+C) — unabhängig von den scharfen Modifikatoren
function termCombo(seq) {
  _termSend(seq);
  termFocus();
}

// Zeichen einfügen (Sonderzeichen-Leiste), respektiert scharfe Modifikatoren
function termInsert(text) {
  const m = _termTakeMods();
  if (m.ctrl || m.alt) { const s = termSeqFor(text[0], m, false); _termSend(s + text.slice(1)); }
  else _termSend(text);
  termFocus();
}

function termToggleFkeys() {
  const row = document.getElementById('term-fkey-row');
  if (row) row.classList.toggle('open');
  termFocus();
}

// Am PC sind die Leisten standardmäßig aus (mobil immer an) — Zustand merken
function termToggleKeys() {
  const box = document.getElementById('term-keys');
  if (!box) return;
  const on = box.classList.toggle('force-show');
  try { localStorage.setItem('term_keys_desktop', on ? '1' : '0'); } catch (_) {}
  const btn = document.getElementById('btn-term-keys');
  if (btn) btn.classList.toggle('active', on);
  setTimeout(_termSendResize, 60);
  termFocus();
}

// Schriftgröße: mehr/weniger Spalten. Zeilenhöhe wird mitgeführt, sonst
// stimmt die an die PTY gemeldete Zeilenzahl nicht mehr mit der Anzeige überein.
const _TERM_FONT_STEPS = [[10,14],[11,15],[12,16],[13,18],[14,19],[15,21],[16,22],[18,25]];

function termFontSize(delta) {
  const out = document.getElementById('terminal-output');
  if (!out) return;
  const cur = parseFloat(getComputedStyle(out).fontSize) || 13;
  let i = _TERM_FONT_STEPS.findIndex(s => s[0] >= cur);
  if (i < 0) i = _TERM_FONT_STEPS.length - 1;
  i = Math.max(0, Math.min(_TERM_FONT_STEPS.length - 1, i + delta));
  const [fs, lh] = _TERM_FONT_STEPS[i];
  out.style.setProperty('--term-fs', fs + 'px');
  out.style.setProperty('--term-lh', lh + 'px');
  try { localStorage.setItem('term_font', String(fs)); } catch (_) {}
  _termSendResize();
  termFocus();
}

function _termRestoreFontPref() {
  let fs = 0;
  try { fs = parseInt(localStorage.getItem('term_font') || '0', 10); } catch (_) {}
  const step = _TERM_FONT_STEPS.find(s => s[0] === fs);
  const out = document.getElementById('terminal-output');
  if (!step || !out) return;
  out.style.setProperty('--term-fs', step[0] + 'px');
  out.style.setProperty('--term-lh', step[1] + 'px');
}

function _termRestoreKeysPref() {
  let on = false;
  try { on = localStorage.getItem('term_keys_desktop') === '1'; } catch (_) {}
  if (!on) return;
  const box = document.getElementById('term-keys');
  if (box) box.classList.add('force-show');
  const btn = document.getElementById('btn-term-keys');
  if (btn) btn.classList.add('active');
}

// Rückwärtskompatible Kurzbefehle (alte Leiste / externe Aufrufe)
function termMobileKey(action) {
  switch (action) {
    case 'interrupt':    _termSend('\x03'); break;
    case 'ctrl_s':       _termSend('\x13'); break;
    case 'ctrl_x':       _termSend('\x18'); break;
    case 'ctrl_alt_del': _termSend('\x1b[3;7~'); break;
    case 'up':   termKeyBtn('ArrowUp'); return;
    case 'down': termKeyBtn('ArrowDown'); return;
    case 'tab':  termKeyBtn('Tab'); return;
    case 'home': termKeyBtn('Home'); return;
    case 'end':  termKeyBtn('End'); return;
  }
  termFocus();
}

// ─── Utility ────────────────────────────────────────

function formatBytes(bytes, decimals = 1) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
}

async function api(endpoint, options = {}) {
  try {
    const resp = await fetch(`${API}${endpoint}`, {
      credentials: 'same-origin',
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers }
    });
    if (resp.status === 401) {
      window.location.href = '/login';
      return { error: 'Nicht authentifiziert' };
    }
    return await resp.json();
  } catch (e) {
    console.error(`API Error (${endpoint}):`, e);
    return { error: e.message };
  }
}

function getBarClass(percent) {
  if (percent >= 90) return 'danger';
  if (percent >= 70) return 'warn';
  return '';
}

// ─── Navigation ─────────────────────────────────────

// Rollenmodell (siehe dashboard/auth.py): superadmin (root, jokergame) = alles;
// admin (Gruppe dashadmin) = eigene VMs + Browser + Verbindungen; user = Browser + Verbindungen.
const _SUPERADMIN_PAGES = new Set(['processes', 'terminal', 'updates', 'services', 'users', 'docker', 'security', 'notifications']);
const _ADMIN_PAGES = new Set(['vms']);
const _ROLE_RANK = { user: 0, admin: 1, superadmin: 2 };
function roleAtLeast(min) { return (_ROLE_RANK[window._userRole] ?? -1) >= (_ROLE_RANK[min] ?? 99); }
function isSuperadmin() { return window._userRole === 'superadmin'; }
function pageAllowed(page) {
  if (_SUPERADMIN_PAGES.has(page)) return isSuperadmin();
  // VMs auch für "user", wenn ein Superadmin ihm VMs sichtbar gemacht hat
  if (_ADMIN_PAGES.has(page)) return roleAtLeast('admin') || (page === 'vms' && (window._vmAccess | 0) > 0);
  return true;
}

function showPage(page) {
  if (window._userRole && !pageAllowed(page)) {
    page = 'dashboard';
  }
  // showPage() räumt sonst nichts auf. Der Docker-Reiter hält aber Timer und
  // WebSockets (Logs, Konsole) — die müssen beim Verlassen weg, sonst laufen
  // sie im Hintergrund weiter und belegen Docker-Socket-Verbindungen.
  if (currentPage.startsWith('docker') && !page.startsWith('docker')) stopDocker();
  currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  document.getElementById(`page-${page}`).classList.add('active');
  const btn = document.getElementById(`nav-btn-${page}`);
  if (btn) btn.classList.add('active');

  // Load page-specific data
  switch(page) {
    case 'processes': loadProcesses(); break;
    case 'terminal': termConnect(); termFocus(); loadTerminalInfo(); break;
    case 'updates': checkUpdates(); break;
    case 'vms': loadVMs(); break;
    case 'services': loadServices(); break;
    case 'connections': loadConnections(); break;
    case 'browser': loadBrowserSessions(); break;
    case 'users': loadUsers(); break;
    case 'docker': loadDocker(); break;
    case 'security': loadSecurity(); break;
    case 'notifications': loadNotifications(); break;
    case 'settings': renderSettings(); break;
  }
}

// ─── Dashboard ──────────────────────────────────────

async function loadDashboard() {
  const data = await api('/api/all');
  if (data.error) return;
  
  // System Info
  if (data.system) {
    const s = data.system;
    document.getElementById('sys-hostname').textContent = s.hostname || '—';
    document.getElementById('sys-uptime').textContent = `⏱ ${s.uptime || '—'}`;
    document.getElementById('sys-os').textContent = s.os || '—';
    
    const sysDetails = document.getElementById('system-details');
    sysDetails.innerHTML = `
      <div class="info-row"><span class="info-label">Hostname</span><span class="info-value">${escHtml(s.hostname)}</span></div>
      <div class="info-row"><span class="info-label">Betriebssystem</span><span class="info-value">${escHtml(s.os)}</span></div>
      <div class="info-row"><span class="info-label">Kernel</span><span class="info-value">${escHtml(s.kernel)}</span></div>
      <div class="info-row"><span class="info-label">Architektur</span><span class="info-value">${escHtml(s.arch)}</span></div>
      <div class="info-row"><span class="info-label">Uptime</span><span class="info-value">${escHtml(s.uptime)}</span></div>
      <div class="info-row"><span class="info-label">Benutzer</span><span class="info-value">${escHtml(s.users)}</span></div>
      <div class="info-row"><span class="info-label">Prozesse</span><span class="info-value">${escHtml(s.processes)}</span></div>
    `;
  }
  
  // CPU
  if (data.cpu) {
    const c = data.cpu;
    document.getElementById('cpu-usage').textContent = c.usage;
    document.getElementById('cpu-model').textContent = (c.model || '—').substring(0, 50);
    document.getElementById('cpu-cores').textContent = `${c.cores} Cores`;
    document.getElementById('cpu-load').textContent = (c.load || [0,0,0]).join(' / ');
    
    const bar = document.getElementById('cpu-bar');
    bar.style.width = `${c.usage}%`;
    bar.className = `progress-fill ${getBarClass(c.usage)}`;
    
    // Core bars
    const coreContainer = document.getElementById('cpu-cores-bars');
    if (c.per_core && c.per_core.length > 0) {
      coreContainer.innerHTML = c.per_core.map((val, i) => `
        <div class="core-bar-item">
          <div class="core-bar-label">C${i}</div>
          <div class="core-bar-track">
            <div class="core-bar-fill" style="height:${val}%;background:${val>80?'linear-gradient(0deg,#ef4444,#f87171)':val>50?'linear-gradient(0deg,#f59e0b,#fbbf24)':'linear-gradient(0deg,var(--accent-dim),var(--accent))'}"></div>
            <div class="core-bar-value">${val}</div>
          </div>
        </div>
      `).join('');
    }
  }
  
  // Memory
  if (data.memory) {
    const m = data.memory;
    document.getElementById('mem-percent').textContent = m.percent;
    document.getElementById('mem-used').textContent = formatBytes(m.used);
    document.getElementById('mem-total-val').textContent = formatBytes(m.total);
    document.getElementById('mem-total').textContent = formatBytes(m.total);
    document.getElementById('mem-available').textContent = formatBytes(m.available);
    document.getElementById('mem-cached').textContent = formatBytes(m.cached);
    document.getElementById('mem-swap').textContent = m.swap_total > 0 
      ? `${formatBytes(m.swap_used)} / ${formatBytes(m.swap_total)} (${m.swap_percent}%)`
      : 'Nicht konfiguriert';
    
    const bar = document.getElementById('mem-bar');
    bar.style.width = `${m.percent}%`;
    bar.className = `progress-fill ${getBarClass(m.percent)}`;
  }
  
  // Network
  if (data.network) {
    const netList = document.getElementById('network-list');
    if (data.network.length === 0) {
      netList.innerHTML = '<div class="metric-sub">Keine Netzwerk-Interfaces gefunden</div>';
    } else {
      netList.innerHTML = data.network.map(n => {
        const ipv4 = (n.addresses || []).find(a => a.family === 'inet');
        return `
          <div class="net-iface">
            <div class="net-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><circle cx="12" cy="20" r="1"/></svg>
            </div>
            <div class="net-details">
              <div class="net-name">${escHtml(n.name)}</div>
              <div class="net-ip">${ipv4 ? escHtml(ipv4.address + '/' + ipv4.prefixlen) : 'Keine IP'}</div>
            </div>
            <div class="net-stats">
              <span class="net-rx">↓ ${formatBytes(n.rx_bytes)}</span>
              <span class="net-tx">↑ ${formatBytes(n.tx_bytes)}</span>
            </div>
          </div>
        `;
      }).join('');
    }
  }
  
  // Disks
  if (data.disks) {
    const diskList = document.getElementById('disk-list');
    diskList.innerHTML = data.disks.map(d => `
      <div class="disk-item">
        <div class="disk-top">
          <div>
            <div class="disk-mount">${escHtml(d.mountpoint)}</div>
            <div class="disk-device">${escHtml(d.device)} · ${escHtml(d.fstype)}</div>
          </div>
          <div class="disk-usage">${formatBytes(d.used)} / ${formatBytes(d.total)}</div>
        </div>
        <div class="progress-track" style="margin:8px 0 4px">
          <div class="progress-fill ${getBarClass(d.percent)}" style="width:${d.percent}%"></div>
        </div>
        <div class="metric-sub">${d.percent}% belegt · ${formatBytes(d.available)} frei</div>
      </div>
    `).join('');
  }
}

// ─── Processes ──────────────────────────────────────

async function loadProcesses() {
  const procs = await api('/api/processes');
  const tbody = document.getElementById('process-tbody');
  
  if (procs.error || !Array.isArray(procs)) {
    tbody.innerHTML = '<tr><td colspan="7" class="loading-overlay">Fehler beim Laden</td></tr>';
    return;
  }
  
  tbody.innerHTML = procs.map(p => {
    const cpuClass = p.cpu > 50 ? 'cpu-high' : p.cpu > 10 ? 'cpu-mid' : 'cpu-low';
    return `
      <tr>
        <td>${Number(p.pid)||0}</td>
        <td>${escHtml(p.user)}</td>
        <td class="${cpuClass}">${escHtml(p.cpu)}%</td>
        <td>${escHtml(p.mem)}%</td>
        <td>${escHtml(p.stat)}</td>
        <td title="${escHtml(p.command)}">${escHtml(p.command)}</td>
        <td>
          <button class="btn btn-sm btn-danger" onclick="killProcess(${Number(p.pid)||0})" title="Prozess beenden">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

async function killProcess(pid) {
  if (!(await uiConfirm(`Prozess ${pid} wirklich beenden (SIGTERM)?`, {danger:true, okLabel:'Beenden'}))) return;
  const result = await api('/api/process/kill', {
    method: 'POST',
    body: JSON.stringify({ pid, signal: 'TERM' })
  });
  if (result.success) {
    loadProcesses();
  } else {
    alert('Fehler: ' + (result.error || 'Unbekannt'));
  }
}

// ─── Terminal (WebSocket PTY) ─────────────────────────

let termUser = 'root', termHost = 'host', termCwd = '/', termDCwd = '~';

function _te(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function updatePrompt() {
  ['term-hdr-user','term-tab-user'].forEach(id => { const e=document.getElementById(id); if(e) e.textContent=termUser; });
  ['term-hdr-host','term-tab-host'].forEach(id => { const e=document.getElementById(id); if(e) e.textContent=termHost; });
  ['term-hdr-cwd','term-tab-cwd'].forEach(id => { const e=document.getElementById(id); if(e) e.textContent=termDCwd; });
}

// Der Fenstertitel der Shell (OSC 0/2, von Ubuntus .bashrc als "user@host: /pfad"
// gesetzt) ist die einzige Quelle, die das ECHTE Arbeitsverzeichnis dieser PTY
// kennt — /api/terminal/info beschreibt eine andere Sitzung und lief hinterher.
function termSetTitle(title) {
  if (!title) return;
  const m = title.match(/^(?:\(([^)]*)\)\s*)?([^@\s]+)@([^:\s]+):\s*(.+)$/);
  if (m) {
    termUser = m[2]; termHost = m[3];
    termCwd  = m[4];
    termDCwd = m[4];
  } else {
    termDCwd = title;
  }
  updatePrompt();
}

async function loadTerminalInfo() {
  try {
    const r = await api('/api/terminal/info');
    if (r.error) return;
    termUser = r.user || 'root';
    termHost = r.hostname || 'host';
    termCwd  = r.cwd || '/';
    termDCwd = r.display_cwd || r.cwd || '~';
    updatePrompt();
  } catch(_) {}
}

function termFocus() {
  const kb = document.getElementById('term-kb');
  if (kb) kb.focus({ preventScroll: true });
}

function termConnect() {
  if (_termWs && (_termWs.readyState === WebSocket.OPEN || _termWs.readyState === WebSocket.CONNECTING)) return;
  if (_termReconnectTimer) { clearTimeout(_termReconnectTimer); _termReconnectTimer = null; }
  _termSetStatus('○ Verbinde…', 'var(--text-muted)');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/api/terminal/ws`);
  ws.binaryType = 'arraybuffer';
  _termWs = ws;
  ws.onopen = () => {
    if (_termWs !== ws) return;
    _termSetStatus('● Online', 'var(--accent)');
    // Sofort die echte Fenstergröße melden: die Shell startet sonst mit 80×24
    // und zeichnet ihre erste Ausgabe in der falschen Breite.
    const out = document.getElementById('terminal-output');
    if (out && out.clientWidth) {
      const g = termGeometry(out);
      _termScreen.resize(g.cols, g.rows);
      ws.send(JSON.stringify({ type: 'resize', cols: g.cols, rows: g.rows }));
      const el = document.getElementById('term-size');
      if (el) el.textContent = `${g.cols}×${g.rows}`;
    }
    setTimeout(_termSendResize, 120);
    loadTerminalInfo();
    termFocus();
  };
  ws.onmessage = (e) => {
    if (_termWs !== ws) return;
    // {stream:true} hält den Dekoder-Zustand über Frame-Grenzen hinweg
    const chunk = e.data instanceof ArrayBuffer
      ? _termDec.decode(e.data, { stream: true })
      : e.data;
    if (!chunk) return;
    _termScreen.feed(chunk);
    _termRender();
  };
  ws.onclose = () => {
    if (_termWs !== ws) return;
    _termWs = null;
    _termSetStatus('○ Getrennt — neu verbinden', 'var(--red)');
    if (currentPage === 'terminal') _termReconnectTimer = setTimeout(termConnect, 3000);
  };
  ws.onerror = () => { if (_termWs === ws) _termSetStatus('● Fehler', 'var(--red)'); };
}

function termReconnect() {
  if (_termWs) { try { _termWs.close(); } catch (_) {} _termWs = null; }
  _termScreen.reset();
  _termRender();
  termConnect();
}

function quickCmd(cmd) {
  _termSend(cmd + '\r');
  termFocus();
}

function clearTerminal() {
  // Wie `clear`: Bildschirm UND Rückblick leeren, dann die Shell neu zeichnen
  _termScreen.reset();
  _termRender();
  _termSend('\x0c');
  termFocus();
}

async function termCopyAll() {
  try {
    await navigator.clipboard.writeText(_termScreen.toText());
    _termSetStatus('● Kopiert', 'var(--accent)');
    setTimeout(() => _termSetStatus(_termWs ? '● Online' : '○ Getrennt', _termWs ? 'var(--accent)' : 'var(--red)'), 1200);
  } catch (_) {
    alert('Zwischenablage nicht verfügbar (nur über HTTPS).');
  }
}

// Einfügen: im Klammer-Einfüge-Modus (bash ≥ 4.4, vim) muss der Text markiert
// werden, sonst führt die Shell mehrzeiligen Text sofort Zeile für Zeile aus.
function termPasteText(text) {
  if (!text) return;
  text = text.replace(/\r\n/g, '\r').replace(/\n/g, '\r');
  if (_termScreen.bracketedPaste) _termSend('\x1b[200~' + text + '\x1b[201~');
  else _termSend(text);
}

// ─── Mauszeiger-Meldung (htop, vim, mc) ───────────────
function _termMouseCell(ev, out) {
  const st = getComputedStyle(out);
  const cell = termCellSize(out);
  const rect = out.getBoundingClientRect();
  const x = ev.clientX - rect.left - parseFloat(st.paddingLeft || 0) + out.scrollLeft;
  const y = ev.clientY - rect.top  - parseFloat(st.paddingTop  || 0) + out.scrollTop;
  // Zeilen oberhalb des Live-Schirms gehören zum Rückblick — nicht melden
  const totalLines = _termScreen._sbH.length + _termScreen.rows;
  const line = Math.floor(y / cell.h);
  const row  = line - (totalLines - _termScreen.rows);
  return { col: Math.max(0, Math.floor(x / cell.w)), row, ok: row >= 0 && row < _termScreen.rows };
}

function _termMouseReport(ev, out, btn, release) {
  if (!_termScreen.mouse) return false;
  const p = _termMouseCell(ev, out);
  if (!p.ok) return false;
  let b = btn + (ev.shiftKey ? 4 : 0) + (ev.altKey ? 8 : 0) + (ev.ctrlKey ? 16 : 0);
  if (_termScreen.mouseSgr) {
    _termSend(`\x1b[<${b};${p.col + 1};${p.row + 1}${release ? 'm' : 'M'}`);
  } else {
    if (release) b = 3;
    if (p.col > 222 || p.row > 222) return false;
    _termSend('\x1b[M' + String.fromCharCode(32 + b, 33 + p.col, 33 + p.row));
  }
  return true;
}

// ─── Eingabe-Anbindung ────────────────────────────────
function termBindInput() {
  const kb  = document.getElementById('term-kb');
  const out = document.getElementById('terminal-output');
  if (!kb || kb.dataset.bound) return;
  kb.dataset.bound = '1';

  // Sichtbare Eingabe (auch Bildschirmtastatur/IME) läuft über das Textfeld
  kb.addEventListener('input', () => {
    const t = kb.value;
    kb.value = '';
    if (!t) return;
    const m = _termPeekMods();
    if (m.ctrl || m.alt) {
      _termTakeMods();
      _termSend(termSeqFor(t[0], m, false) + t.slice(1));
    } else {
      if (_termMod.shift === 1) _termTakeMods();
      _termSend(t);
    }
  });

  // iOS meldet Rücktaste nur als beforeinput/input-Ereignis
  kb.addEventListener('beforeinput', (e) => {
    if (e.inputType === 'deleteContentBackward') {
      e.preventDefault();
      kb.value = '';
      _termSend('\x7f');
    } else if (e.inputType === 'insertLineBreak') {
      e.preventDefault();
      kb.value = '';
      _termSend('\r');
    }
  });

  kb.addEventListener('focus', () => {
    const btn = document.getElementById('btn-term-kb');
    if (btn) btn.classList.add('active');
  });
  kb.addEventListener('blur', () => {
    const btn = document.getElementById('btn-term-kb');
    if (btn) btn.classList.remove('active');
  });

  // Klick ins Terminal fokussiert die Eingabe — außer beim Markieren von Text
  if (out) {
    out.addEventListener('mousedown', (e) => {
      if (_termMouseReport(e, out, e.button === 1 ? 1 : (e.button === 2 ? 2 : 0), false)) { e.preventDefault(); return; }
    });
    out.addEventListener('mouseup', (e) => {
      if (_termScreen.mouse && _termMouseReport(e, out, 0, true)) { e.preventDefault(); return; }
      if (window.getSelection && String(window.getSelection())) return;
      termFocus();
    });
    out.addEventListener('contextmenu', (e) => { if (_termScreen.mouse) e.preventDefault(); });

    // Mausrad: im Alternativ-Schirm (less/man/vim) gibt es keinen Rückblick —
    // dort wird das Rad in Pfeiltasten übersetzt, sonst scrollt der Browser.
    out.addEventListener('wheel', (e) => {
      if (_termScreen.mouse >= 1002) {
        const p = _termMouseCell(e, out);
        if (p.ok) {
          const b = e.deltaY < 0 ? 64 : 65;
          if (_termScreen.mouseSgr) _termSend(`\x1b[<${b};${p.col + 1};${p.row + 1}M`);
          else _termSend('\x1b[M' + String.fromCharCode(32 + b, 33 + p.col, 33 + p.row));
          e.preventDefault();
          return;
        }
      }
      if (_termScreen.inAlt) {
        const seq = termSeqFor(e.deltaY < 0 ? 'ArrowUp' : 'ArrowDown', {}, _termScreen.appCursor);
        _termSend(seq.repeat(3));
        e.preventDefault();
      }
    }, { passive: false });
  }

  // Globale Tastatur: fängt alles ab, solange die Terminalseite offen ist
  document.addEventListener('keydown', (e) => {
    if (currentPage !== 'terminal') return;
    const ae = document.activeElement;
    if (ae && ae !== kb && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
    if (e.isComposing || e.keyCode === 229 || e.key === 'Dead') return;
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta' ||
        e.key === 'CapsLock' || e.key === 'NumLock' || e.key === 'ScrollLock') return;

    // Browser-Kürzel durchlassen: Strg+Shift+C/V (kopieren/einfügen), Cmd-*, F5/F12 mit Strg
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && ['c','v','j','i'].includes(e.key.toLowerCase())) return;
    if (e.metaKey && !e.ctrlKey) return;
    if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'v') return;   // paste-Ereignis
    if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'c' &&
        window.getSelection && String(window.getSelection())) return;                   // Auswahl kopieren

    const mods = { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: false };
    const seq = termSeqFor(e.key, mods, _termScreen.appCursor);
    if (!seq) return;
    // Reine Schreibzeichen liefert das Textfeld (IME-tauglich) — außer es hat
    // keinen Fokus, dann würde die Eingabe sonst verloren gehen.
    if (!e.ctrlKey && !e.altKey && Array.from(e.key).length === 1) {
      if (ae === kb) return;
      termFocus();
    }
    e.preventDefault();
    _termSend(seq);
  });

  document.addEventListener('paste', (e) => {
    if (currentPage !== 'terminal') return;
    e.preventDefault();
    termPasteText((e.clipboardData || window.clipboardData).getData('text'));
  });

  document.addEventListener('copy', () => {
    if (currentPage === 'terminal') setTimeout(termFocus, 0);
  });

  const onResize = () => { if (currentPage === 'terminal') _termSendResize(); };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 250));
  if (window.visualViewport)
    window.visualViewport.addEventListener('resize', () => { if (currentPage === 'terminal') setTimeout(_termSendResize, 120); });
  // Schriftgröße/Layout kann sich auch ohne Fensteränderung ändern
  if (window.ResizeObserver && out) new ResizeObserver(onResize).observe(out);

  _termPaintMods();
  _termRestoreKeysPref();
  _termRestoreFontPref();
}
// ─── Role-based access ─────────────────────────────
window._userRole = 'superadmin'; // default until /api/me responds
window._userName = '';

async function initUserRole() {
  try {
    const data = await api('/api/me');
    window._userRole = data.role || 'user';
    window._userName = data.username || '';
    window._vmAccess = data.vm_access || 0;
  } catch (_) {}
  // Elemente mit class="adm-only" (VM anlegen, Netze/Storage/ISOs) erst ab Rolle admin
  if (!roleAtLeast('admin')) {
    document.querySelectorAll('.adm-only').forEach(el => { el.style.display = 'none'; });
  }
  // Benutzerverwaltung und Docker nur für Superadmins sichtbar (Buttons starten
  // versteckt — Docker-Zugriff über den Socket ist faktisch Root auf dem Host)
  if (isSuperadmin()) {
    for (const p of ['users', 'docker', 'security', 'notifications']) {
      const b = document.getElementById(`nav-btn-${p}`);
      if (b) b.style.display = '';
    }
  }
  for (const page of [..._SUPERADMIN_PAGES, ..._ADMIN_PAGES]) {
    if (pageAllowed(page)) continue;
    const btn = document.getElementById(`nav-btn-${page}`);
    if (btn) btn.style.display = 'none';
  }
  // Elemente mit class="sa-only" (XML-Tab, Netz-/ISO-Anlegen …) nur für Superadmins
  if (!isSuperadmin()) {
    document.querySelectorAll('.sa-only').forEach(el => { el.style.display = 'none'; });
  }
  // If currently on a restricted page, redirect to dashboard
  if (!pageAllowed(currentPage)) showPage('dashboard');
  loadPrefs();
}

document.addEventListener('DOMContentLoaded', () => {
  initUserRole();
  termBindInput();
});

// ─── Updates ────────────────────────────────────────

async function checkUpdates() {
  document.getElementById('update-list').innerHTML =
    '<div class="loading-overlay"><span class="spinner"></span> Suche nach Updates...</div>';
  document.getElementById('update-count').textContent = '...';
  
  const data = await api('/api/updates');
  
  document.getElementById('update-count').textContent = data.count || 0;
  document.getElementById('update-manager').textContent = (data.manager || '—').toUpperCase();
  
  const list = document.getElementById('update-list');
  if (!data.packages || data.packages.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
        <p>${data.error ? 'Fehler: ' + escHtml(data.error) : 'System ist aktuell! Keine Updates verfügbar.'}</p>
      </div>
    `;
  } else {
    list.innerHTML = data.packages.map(p => `
      <div class="update-item">
        <span class="update-name">${escHtml(p.name)}</span>
        <span class="update-version">${escHtml(p.version)}</span>
      </div>
    `).join('');
  }
}

async function runSystemUpdate() {
  if (!(await uiConfirm('System-Update jetzt durchführen? Dies kann einige Minuten dauern.', {okLabel:'Update starten'}))) return;
  
  const btn = document.getElementById('btn-run-update');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Update läuft...';
  
  const log = document.getElementById('update-log');
  log.textContent = 'Update wird durchgeführt...\nBitte warten...\n';
  
  const result = await api('/api/update', { method: 'POST' });
  
  log.textContent = result.output || 'Keine Ausgabe';
  log.scrollTop = log.scrollHeight;
  
  btn.disabled = false;
  btn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
    Alle Updates installieren
  `;
  
  // Refresh update list
  checkUpdates();
}

// ─── Toast Notifications ────────────────────────────

// Eigener Bestätigungsdialog statt native confirm() — Letzteres kann vom Browser
// unterdrückt werden ("weitere Dialoge verhindern") und gibt dann immer false
// zurück, wodurch destruktive Aktionen scheinbar "nichts tun".
function uiConfirm(message, opts) {
  opts = opts || {};
  return new Promise(resolve => {
    const m = document.getElementById('ui-confirm-modal');
    if (!m) { resolve(window.confirm(message)); return; }
    document.getElementById('ui-confirm-msg').textContent = message;
    const ok = document.getElementById('ui-confirm-ok');
    const cancel = document.getElementById('ui-confirm-cancel');
    ok.textContent = opts.okLabel || 'OK';
    ok.className = 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary');
    cancel.textContent = opts.cancelLabel || 'Abbrechen';
    m.style.display = 'flex';
    const done = (val) => { m.style.display = 'none'; ok.onclick = cancel.onclick = m.onclick = null; resolve(val); };
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
    m.onclick = (e) => { if (e.target === m) done(false); };
  });
}

function toast(msg, type = 'info', duration = 4000) {
  const icons = { success:'✓', error:'✕', warn:'⚠', info:'ℹ' };
  const tc = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.innerHTML = `<span class="toast-icon">${icons[type]||'ℹ'}</span><span class="toast-msg">${escHtml(String(msg))}</span>`;
  tc.appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity .3s,transform .3s';
    t.style.opacity = '0';
    t.style.transform = 'translateX(16px)';
    setTimeout(() => t.remove(), 320);
  }, duration);
}

// ─── VMs ────────────────────────────────────────────

let _currentVMName = null;

async function loadVMs() {
  const grid = document.getElementById('vm-grid');
  grid.innerHTML = '<div class="loading-overlay"><span class="spinner"></span> Lade VMs...</div>';

  const data = await api('/api/vms');

  if (data.error) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
        <p>${escHtml(data.error)}</p>
        <p style="margin-top:12px;font-size:12px;color:var(--text-ghost)">Stellen Sie sicher, dass libvirt installiert ist:<br><code>apt install libvirt-daemon-system virt-manager</code></p>
      </div>`;
    loadNetworks();
    loadPools();
    loadIsos();
    return;
  }

  if (!data.vms || data.vms.length === 0) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
        <p>Keine virtuellen Maschinen gefunden.</p>
      </div>`;
    loadNetworks();
    loadPools();
    loadIsos();
    return;
  }

  grid.innerHTML = data.vms.map(vm => {
    const stateClass = vm.state.includes('running') ? 'running'
                     : vm.state.includes('paused')  ? 'paused'
                     : vm.state.includes('crash')   ? 'crashed'
                     : 'shut';
    const isRunning = stateClass === 'running';
    const isPaused  = stateClass === 'paused';
    const hasDisplay = isRunning && vm.displays && vm.displays.length > 0;
    const hasVnc   = hasDisplay && vm.displays.some(d=>d.type==='vnc');
    const hasSpice = hasDisplay && vm.displays.some(d=>d.type==='spice');
    return `
      <div class="vm-card" data-vm="${escHtml(vm.name)}" style="cursor:pointer;">
        <div class="vm-card-header">
          <div class="vm-name">${escHtml(vm.name)}${isSuperadmin() && vm.owner ? ` <span class="owner-badge" style="float:none;">${escHtml(vm.owner)}</span>` : ''}${isSuperadmin() && vm.viewers && vm.viewers.length ? ` <span class="owner-badge" style="float:none;" title="Sichtbar für: ${escHtml(vm.viewers.join(', '))}">&#128101; ${vm.viewers.length}</span>` : ''}${vm.access === 'view' ? ` <span class="owner-badge" style="float:none;" title="Freigegeben${vm.owner ? ' von ' + escHtml(vm.owner) : ''} — nur Konsole/Power">&#128065; Freigabe</span>` : ''}</div>
          <span style="display:flex;gap:6px;align-items:center;">
            ${vm.public_shares ? `<span class="vm-state paused" title="Öffentlich freigegeben (${vm.public_shares} Link${vm.public_shares>1?'s':''})">&#128279; ${vm.public_shares}</span>` : ''}
            <span class="vm-state ${stateClass}">${escHtml(vm.state)}</span>
          </span>
        </div>
        <div class="vm-info">
          <div class="vm-info-item"><div class="vm-info-label">vCPUs</div><div class="vm-info-value">${escHtml(String(vm['cpu(s)']||'—'))}</div></div>
          <div class="vm-info-item"><div class="vm-info-label">RAM</div><div class="vm-info-value">${escHtml(String(vm.max_memory||'—'))}</div></div>
        </div>
        <div class="vm-actions">
          ${!isRunning && !isPaused ? `<button class="btn btn-sm btn-primary vm-act-btn" data-vm="${escHtml(vm.name)}" data-act="start">&#9654; Start</button>` : ''}
          ${isRunning ? `<button class="btn btn-sm vm-act-btn" data-vm="${escHtml(vm.name)}" data-act="shutdown">&#9209; Stop</button>` : ''}
          ${isRunning ? `<button class="btn btn-sm vm-act-btn" data-vm="${escHtml(vm.name)}" data-act="reboot">&#8635;</button>` : ''}
          ${isPaused  ? `<button class="btn btn-sm btn-primary vm-act-btn" data-vm="${escHtml(vm.name)}" data-act="resume">&#9654; Resume</button>` : ''}
          ${isRunning || isPaused ? `<button class="btn btn-sm btn-danger vm-act-btn" data-vm="${escHtml(vm.name)}" data-act="destroy">&#9889; Force Off</button>` : ''}
          <span style="flex:1"></span>
          <button class="btn btn-sm" data-vm="${escHtml(vm.name)}" data-act="settings">&#9881;</button>
        </div>
        ${hasDisplay ? `
        <div style="display:flex;gap:8px;margin-top:8px;padding-top:8px;border-top:1px solid var(--border-dim);">
          ${hasVnc ? `<button class="btn btn-console-vnc vm-act-btn" data-vm="${escHtml(vm.name)}" data-act="vnc" style="flex:1;justify-content:center;" title="noVNC">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            VNC
          </button>` : ''}
          ${hasSpice ? `<button class="btn btn-console-spice vm-act-btn" data-vm="${escHtml(vm.name)}" data-act="spice" style="flex:1;justify-content:center;" title="SPICE">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            SPICE
          </button>` : ''}
          ${hasVnc ? `<button class="btn btn-primary vm-act-btn" data-vm="${escHtml(vm.name)}" data-act="kasmvnc" style="flex:1;justify-content:center;" title="KasmVNC">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            KasmVNC
          </button>` : ''}
        </div>` : ''}
      </div>`;
  }).join('');

  loadNetworks();
  loadPools();
  loadIsos();
}

async function doVmAction(name, action, btnEl) {
  if (btnEl) { btnEl.disabled = true; const orig = btnEl.innerHTML; btnEl.innerHTML = '&#9203;'; btnEl._orig = orig; }
  const result = await api('/api/vm/action', { method: 'POST', body: JSON.stringify({ name, action }) });
  if (btnEl) { btnEl.disabled = false; btnEl.innerHTML = btnEl._orig || action; }
  if (result.success) {
    toast(`${action}: ${name}`, 'success');
    setTimeout(loadVMs, 1500);
    // Also refresh detail page if open
    if (document.getElementById('page-vm-detail').classList.contains('active') && _vmDetailName === name)
      setTimeout(() => loadVMDetail(name), 1500);
  } else {
    toast(`Fehler: ${result.error || 'Unbekannt'}`, 'error', 8000);
  }
}

// ─── VM Detail Page ──────────────────────────────────

let _vmDetailName = null;
let _vmDetailData = null;
let _vmStatsTimer = null;

function stopVMStats() { if (_vmStatsTimer) { clearTimeout(_vmStatsTimer); _vmStatsTimer = null; } }
function startVMStats(name) { stopVMStats(); pollVMStats(name); }
function _vmFmtMem(m) { m = m || 0; return m >= 1024 ? (m/1024).toFixed(1)+' GiB' : m+' MiB'; }
function _vmSetBar(valId, barId, pct, label) {
  const v = document.getElementById(valId), b = document.getElementById(barId);
  if (v) v.textContent = (label != null ? label : pct + '%');
  if (b) { b.style.width = Math.max(0, Math.min(100, pct)) + '%'; b.className = 'progress-fill ' + getBarClass(pct); }
}
async function pollVMStats(name) {
  const active = document.getElementById('page-vm-detail')?.classList.contains('active');
  const ov = document.getElementById('vmdtab-overview');
  const onOverview = ov && ov.style.display !== 'none';
  if (!active || _vmDetailName !== name || !onOverview || !document.getElementById('vmd-stat-cpu')) { stopVMStats(); return; }
  let s = null;
  try { s = await api(`/api/vm/stats?name=${encodeURIComponent(name)}`); } catch(e) {}
  if (_vmDetailName !== name || !document.getElementById('vmd-stat-cpu')) { stopVMStats(); return; }
  const stEl = document.getElementById('vmd-util-state');
  if (s && s.running) {
    const cpu = Math.round(s.cpu_percent || 0), mem = Math.round(s.mem_percent || 0);
    _vmSetBar('vmd-stat-cpu', 'vmd-stat-cpu-bar', cpu, cpu + '%');
    _vmSetBar('vmd-stat-mem', 'vmd-stat-mem-bar', mem, mem + '%');
    const vc = document.getElementById('vmd-stat-vcpu'); if (vc) vc.textContent = s.vcpus ? '(' + s.vcpus + ' vCPU)' : '';
    const md = document.getElementById('vmd-stat-mem-detail');
    if (md) md.textContent = _vmFmtMem(s.mem_used_mib) + ' / ' + _vmFmtMem(s.mem_total_mib) + (s.mem_source === 'host-rss' ? ' (Host-RSS)' : '');
    if (stEl) stEl.textContent = '● live';
  } else {
    if (stEl) stEl.textContent = 'VM ausgeschaltet';
    _vmSetBar('vmd-stat-cpu', 'vmd-stat-cpu-bar', 0, '—');
    _vmSetBar('vmd-stat-mem', 'vmd-stat-mem-bar', 0, '—');
  }
  _vmStatsTimer = setTimeout(() => pollVMStats(name), 2500);
}

async function openVMDetail(name) {
  _vmDetailName = name;
  _vmDetailData = null;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('page-vm-detail').classList.add('active');
  // Früher wurde das Icon über einen Positionsindex in ein hartkodiertes
  // Seiten-Array gesucht — jeder neue Nav-Button hätte das stillschweigend
  // verschoben und den falschen Reiter markiert. Jetzt direkt über die Id.
  document.getElementById('nav-btn-vms')?.classList.add('active');
  switchVMDTab('overview');
  await loadVMDetail(name);
}

async function loadVMDetail(name) {
  document.getElementById('vmd-title').textContent = name;
  document.getElementById('vmd-actions').innerHTML = '<span style="color:var(--text-muted);font-size:12px;font-family:var(--font-mono)">Lade...</span>';

  const d = await api(`/api/vm/details?name=${encodeURIComponent(name)}`);
  if (d.error) { toast('Fehler: ' + d.error, 'error'); return; }
  _vmDetailData = d;
  // Nur-Sicht-Zugriff (von Superadmin freigegeben): Konfigurations-Tabs ausblenden,
  // es bleiben Übersicht, Konsole und Power-Aktionen.
  const _viewOnly = d.access === 'view';
  document.querySelectorAll('.vm-mgmt-tab[id^="vmdt-"]').forEach(b => {
    if (b.id === 'vmdt-overview') return;
    if (b.classList.contains('sa-only') && !isSuperadmin()) return;   // bleibt versteckt
    b.style.display = _viewOnly ? 'none' : '';
  });

  // State badge
  const stateClass = (d.state||'').includes('running') ? 'running' : (d.state||'').includes('paused') ? 'paused' : 'shut';
  document.getElementById('vmd-state-badge').innerHTML = `<span class="vm-state ${stateClass}">${escHtml(d.state||'unknown')}</span>`;

  // Action buttons
  const isRunning = stateClass === 'running';
  const isPaused  = stateClass === 'paused';
  document.getElementById('vmd-actions').innerHTML = `
    ${!isRunning && !isPaused ? `<button class="btn btn-primary vm-act-btn" data-vm="${escHtml(name)}" data-act="start">&#9654; Start</button>` : ''}
    ${isRunning ? `<button class="btn vm-act-btn" data-vm="${escHtml(name)}" data-act="shutdown">&#9209; Stop</button>` : ''}
    ${isRunning ? `<button class="btn vm-act-btn" data-vm="${escHtml(name)}" data-act="reboot">&#8635; Reboot</button>` : ''}
    ${isRunning ? `<button class="btn vm-act-btn" data-vm="${escHtml(name)}" data-act="suspend">&#9208; Pause</button>` : ''}
    ${isPaused  ? `<button class="btn btn-primary vm-act-btn" data-vm="${escHtml(name)}" data-act="resume">&#9654; Resume</button>` : ''}
    ${isRunning||isPaused ? `<button class="btn btn-danger vm-act-btn" data-vm="${escHtml(name)}" data-act="destroy">&#9889; Force Off</button>` : ''}
    ${isRunning && d.displays && d.displays.find(x=>x.type==='vnc') ? `<button class="btn btn-console-vnc" onclick="openConsole(this,'${escHtml(name)}','vnc')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg> VNC</button>` : ''}
    ${isRunning && d.displays && d.displays.find(x=>x.type==='spice') ? `<button class="btn btn-console-spice" onclick="openConsole(this,'${escHtml(name)}','spice')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg> SPICE</button>` : ''}
    ${isRunning && d.kasmvnc_enabled && d.displays && (d.displays.find(x=>x.type==='vnc') || d.displays.find(x=>x.type==='spice')) ? `<button class="btn btn-primary" onclick="openConsole(this,'${escHtml(name)}','kasmvnc')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg> KasmVNC</button>` : ''}
  `;

  // Add delegation to action buttons in detail header
  document.getElementById('vmd-actions').addEventListener('click', e => {
    const btn = e.target.closest('.vm-act-btn');
    if (btn) doVmAction(btn.dataset.vm, btn.dataset.act, btn);
  }, {once: true});

  // Render current tab
  renderVMDTab(_vmDetailData);
  if (d.access === 'view') {
    // Verwaltungs-Buttons der Übersicht (Löschen, Klonen, Einstellungen …) verbergen
    document.querySelectorAll('#vmdtab-overview button').forEach(b => {
      if (!/openConsole|vm-act-btn/.test(b.outerHTML)) b.style.display = 'none';
    });
  }
}

function switchVMDTab(tab) {
  if ((tab === 'xml' || tab === 'access') && !isSuperadmin()) tab = 'overview';
  ['overview','hardware','disks','network','devices','boot','snapshots','xml','share','access'].forEach(t => {
    const p = document.getElementById(`vmdtab-${t}`);
    const b = document.getElementById(`vmdt-${t}`);
    if (p) p.style.display = t === tab ? 'block' : 'none';
    if (b) b.classList.toggle('active', t === tab);
  });
  if (_vmDetailData) renderVMDTab(_vmDetailData, tab);
  else if (tab === 'snapshots' && _vmDetailName) loadVMDSnapshots();
}

function renderVMDTab(d, tab) {
  tab = tab || document.querySelector('.vm-mgmt-tab.active[id^="vmdt-"]')?.id.replace('vmdt-','') || 'overview';

  if (tab === 'overview') {
    const name = d.name || _vmDetailName || '';
    document.getElementById('vmdtab-overview').innerHTML = `
      <div class="card" id="vmd-util-card" style="margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div class="card-title" style="margin-bottom:0;">Live-Auslastung</div>
          <span id="vmd-util-state" style="font-size:11px;font-family:var(--font-mono);color:var(--text-muted);"></span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;padding-top:14px;" class="vmd-util-grid">
          <div>
            <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px;">
              <span class="hw-label">CPU <span style="color:var(--text-muted);font-size:11px;" id="vmd-stat-vcpu"></span></span>
              <span class="hw-value" id="vmd-stat-cpu" style="color:var(--accent);font-family:var(--font-mono)">&#8212;</span>
            </div>
            <div class="progress-track"><div class="progress-fill" id="vmd-stat-cpu-bar" style="width:0%"></div></div>
          </div>
          <div>
            <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px;">
              <span class="hw-label">RAM <span style="color:var(--text-muted);font-size:11px;" id="vmd-stat-mem-detail"></span></span>
              <span class="hw-value" id="vmd-stat-mem" style="color:var(--accent);font-family:var(--font-mono)">&#8212;</span>
            </div>
            <div class="progress-track"><div class="progress-fill" id="vmd-stat-mem-bar" style="width:0%"></div></div>
          </div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;">
        <div class="card">
          <div class="card-title">Allgemein</div>
          <div class="hw-row"><span class="hw-label">Name</span><span class="hw-value">${escHtml(d.name||'')}</span></div>
          <div class="hw-row"><span class="hw-label">Status</span><span class="hw-value">${escHtml(d.state||'')}</span></div>
          <div class="hw-row"><span class="hw-label">Maschine</span><span class="hw-value">${escHtml(d.machine||'&#8212;')}</span></div>
          <div class="hw-row"><span class="hw-label">Firmware</span><span class="hw-value">${escHtml((d.firmware||'bios').toUpperCase())}</span></div>
          <div class="hw-row"><span class="hw-label">Secure Boot</span><span class="hw-value" style="color:${d.secure_boot?'var(--accent)':'var(--text-muted)'}">${d.secure_boot?'&#10003; aktiv':'aus'}</span></div>
          <div class="hw-row"><span class="hw-label">TPM</span><span class="hw-value" style="color:${d.has_tpm?'var(--accent)':'var(--text-muted)'}">${d.has_tpm?'&#10003; '+escHtml(d.tpm_version||'2.0'):'kein'}</span></div>
          <div class="hw-row"><span class="hw-label">Autostart</span><span class="hw-value">${escHtml(d.autostart||'nein')}</span></div>
        </div>
        <div class="card">
          <div class="card-title">CPU</div>
          <div class="hw-row"><span class="hw-label">vCPUs gesamt</span><span class="hw-value" style="color:var(--accent)">${d.vcpus||'&#8212;'}</span></div>
          <div class="hw-row"><span class="hw-label">Modus</span><span class="hw-value">${escHtml(d.cpu_mode||'&#8212;')}</span></div>
          <div class="hw-row"><span class="hw-label">Topologie</span><span class="hw-value">${d.cpu_sockets||1}S &#215; ${d.cpu_cores||1}C &#215; ${d.cpu_threads||1}T</span></div>
        </div>
        <div class="card">
          <div class="card-title">Arbeitsspeicher</div>
          <div class="hw-row"><span class="hw-label">Max. RAM</span><span class="hw-value" style="color:var(--accent)">${d.max_mem_mib ? (d.max_mem_mib >= 1024 ? (d.max_mem_mib/1024).toFixed(1)+' GiB' : d.max_mem_mib+' MiB') : '&#8212;'}</span></div>
          <div class="hw-row"><span class="hw-label">Aktuell</span><span class="hw-value">${d.memory_mib ? (d.memory_mib >= 1024 ? (d.memory_mib/1024).toFixed(1)+' GiB' : d.memory_mib+' MiB') : '&#8212;'}</span></div>
        </div>
        <div class="card">
          <div class="card-title">Anzeige &amp; Sound</div>
          <div class="hw-row"><span class="hw-label">Video Typ</span><span class="hw-value">${escHtml(d.video?.type||'&#8212;')}</span></div>
          <div class="hw-row"><span class="hw-label">Video VRAM</span><span class="hw-value">${d.video?.vram_kib ? (d.video.vram_kib/1024)+'MiB' : '&#8212;'}</span></div>
          <div class="hw-row"><span class="hw-label">Sound</span><span class="hw-value">${d.sounds?.length ? d.sounds.map(s=>s.model).join(', ') : 'Kein'}</span></div>
        </div>
        <div class="card">
          <div class="card-title">Datentr&#228;ger (${(d.disks||[]).length})</div>
          ${(d.disks||[]).map(dk => `
          <div class="hw-row">
            <span class="hw-label">${escHtml(dk.target||'?')} <span style="font-size:10px;color:var(--text-muted)">${escHtml(dk.bus||'')}/${escHtml(dk.format||'')}</span></span>
            <span class="hw-value" style="font-size:11px;overflow:hidden;text-overflow:ellipsis;">${escHtml((dk.source||dk.device||'').split('/').pop()||'&#8212;')}</span>
          </div>`).join('')||'<div class="hw-row" style="color:var(--text-muted)">Keine Datentr&#228;ger</div>'}
        </div>
        <div class="card">
          <div class="card-title">Netzwerk (${(d.interfaces||[]).length})</div>
          ${(d.interfaces||[]).map(nic => `
          <div class="hw-row">
            <span class="hw-label">${escHtml(nic.source||'?')} <span style="font-size:10px;color:var(--text-muted)">${escHtml(nic.model||'')}</span></span>
            <span class="hw-value" style="font-size:11px;">${escHtml(nic.mac||'')}</span>
          </div>`).join('')||'<div class="hw-row" style="color:var(--text-muted)">Keine NICs</div>'}
        </div>
        <div class="card">
          <div class="card-title">VNC Tastaturlayout</div>
          <div style="display:grid;gap:10px;padding-top:8px;">
            <div>
              <div class="hw-label" style="margin-bottom:6px;">Layout</div>
              <select id="vmd-vnc-keymap" class="conn-input" style="appearance:auto;width:100%;">
                <option value="en-us">en-us — Englisch (US)</option>
                <option value="de">de — Deutsch</option>
                <option value="fr">fr — Französisch</option>
                <option value="fr-be">fr-be — Französisch (Belgien)</option>
                <option value="fr-ch">fr-ch — Französisch (Schweiz)</option>
                <option value="es">es — Spanisch</option>
                <option value="it">it — Italienisch</option>
                <option value="pt">pt — Portugiesisch</option>
                <option value="pt-br">pt-br — Portugiesisch (Brasilien)</option>
                <option value="nl">nl — Niederländisch</option>
                <option value="pl">pl — Polnisch</option>
                <option value="ru">ru — Russisch</option>
                <option value="tr">tr — Türkisch</option>
                <option value="sv">sv — Schwedisch</option>
                <option value="no">no — Norwegisch</option>
                <option value="fi">fi — Finnisch</option>
                <option value="da">da — Dänisch</option>
                <option value="hu">hu — Ungarisch</option>
                <option value="cs">cs — Tschechisch</option>
                <option value="sk">sk — Slowakisch</option>
                <option value="ro">ro — Rumänisch</option>
                <option value="uk">uk — Ukrainisch</option>
                <option value="ja">ja — Japanisch</option>
                <option value="ko">ko — Koreanisch</option>
              </select>
            </div>
            <p style="font-size:11px;color:var(--amber,#f59e0b);font-family:var(--font-mono);margin:0;">&#9432; &#196;nderung gilt erst nach VM-Neustart</p>
            <button class="btn btn-primary" id="vmd-keymap-save-btn" onclick="setVMKeymap()" style="width:100%;padding:10px;">&#10003; Tastaturlayout speichern</button>
          </div>
        </div>
      </div>
      <div class="card" style="border-color:rgba(239,68,68,.25);margin-top:16px;">
        <div class="card-title" style="color:var(--red);">Gefahrenzone</div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding-top:8px;">
          <button class="btn" onclick="vmdCloneVM()" style="color:var(--cyan);border-color:rgba(0,212,255,.3);">&#9111; Klonen</button>
          <div style="flex:1;display:flex;align-items:center;gap:10px;justify-content:flex-end;flex-wrap:wrap;">
            <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted);">
              <input type="checkbox" id="vmd-del-vols" style="accent-color:var(--red);"> Datentr&#228;ger l&#246;schen
            </label>
            <button class="btn btn-danger" onclick="vmdDeleteVM()">&#128465; VM l&#246;schen</button>
          </div>
        </div>
      </div>
    `;
    const kmSel = document.getElementById('vmd-vnc-keymap');
    if (kmSel) kmSel.value = d.vnc_keymap || 'en-us';
    // Live-Auslastung nur bei laufender VM pollen
    if ((d.state||'').includes('running')) startVMStats(d.name || _vmDetailName);
    else { stopVMStats(); const st=document.getElementById('vmd-util-state'); if(st) st.textContent='VM ausgeschaltet'; }
  } else {
    stopVMStats();   // Auslastungs-Poll stoppen, sobald ein anderer Tab aktiv ist
  }

  if (tab === 'hardware') renderVMDHardware(d);
  if (tab === 'disks') renderVMDDisks(d);
  if (tab === 'network') renderVMDNetwork(d);
  if (tab === 'devices') renderVMDDevices(d);
  if (tab === 'boot') renderVMDBoot(d);
  if (tab === 'snapshots') loadVMDSnapshots();
  if (tab === 'xml') renderVMDXml(d);
  if (tab === 'access') renderVMDAccess(d);
  if (tab === 'share') renderVMDShare(d);
}

// ─── Hardware tab ────────────────────────────────────

function renderVMDHardware(d) {
  document.getElementById('vmdtab-hardware').innerHTML = `
<div style="display:grid;gap:20px;max-width:700px;">
  <div class="card">
    <div class="card-title">CPU Konfiguration</div>
    <div style="display:grid;gap:12px;padding-top:8px;">
      <div class="vmd-grid-2">
        <div><label class="conn-label">CPU Modus</label>
          <select id="vmd-cpu-mode" class="conn-input" style="appearance:auto;">
            <option value="host-passthrough" ${d.cpu_mode==='host-passthrough'?'selected':''}>host-passthrough (empfohlen)</option>
            <option value="host-model" ${d.cpu_mode==='host-model'?'selected':''}>host-model</option>
            <option value="custom" ${d.cpu_mode==='custom'?'selected':''}>custom</option>
          </select>
        </div>
        <div style="display:flex;flex-direction:column;justify-content:flex-end;">
          <div style="font-size:12px;color:var(--text-muted);font-family:var(--font-mono);padding-bottom:10px;">
            host-passthrough = beste Performance
          </div>
        </div>
      </div>
      <div class="vmd-grid-3">
        <div><label class="conn-label">Sockets</label>
          <input id="vmd-cpu-sockets" type="number" min="1" max="8" value="${d.cpu_sockets||1}" class="conn-input" oninput="vmdUpdateVCPUs()">
        </div>
        <div><label class="conn-label">Cores / Socket</label>
          <input id="vmd-cpu-cores" type="number" min="1" max="64" value="${d.cpu_cores||1}" class="conn-input" oninput="vmdUpdateVCPUs()">
        </div>
        <div><label class="conn-label">Threads / Core</label>
          <input id="vmd-cpu-threads" type="number" min="1" max="4" value="${d.cpu_threads||1}" class="conn-input" oninput="vmdUpdateVCPUs()">
        </div>
      </div>
      <div style="font-size:13px;font-family:var(--font-mono);color:var(--accent);">
        &#8594; Gesamt: <strong id="vmd-vcpu-total">${(d.cpu_sockets||1)*(d.cpu_cores||1)*(d.cpu_threads||1)}</strong> vCPUs
      </div>
      <div class="vmd-grid-2">
        <div><label class="conn-label">RAM Max (MiB)</label>
          <input id="vmd-mem" type="number" min="128" max="524288" value="${d.max_mem_mib||1024}" class="conn-input">
        </div>
        <div style="display:flex;align-items:flex-end;">
          <span style="font-size:12px;color:var(--text-muted);font-family:var(--font-mono);padding-bottom:10px;">
            = ${d.max_mem_mib ? (d.max_mem_mib >= 1024 ? (d.max_mem_mib/1024).toFixed(1)+' GiB' : d.max_mem_mib+' MiB') : '&#8212;'}
          </span>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;">
        <label style="font-size:12px;color:var(--text-secondary);">
          <input type="checkbox" id="vmd-autostart" ${d.autostart==='ja'?'checked':''} style="accent-color:var(--accent);">
          Autostart beim Host-Boot
        </label>
      </div>
      <div id="vmd-hw-err" style="display:none;color:var(--red);font-size:12px;font-family:var(--font-mono);padding:8px;background:var(--red-glow);border-radius:6px;"></div>
      <button class="btn btn-primary" id="vmd-hw-save-btn" onclick="saveVMDHardware()" style="width:100%;padding:11px;">&#10003; CPU &amp; RAM speichern</button>
    </div>
  </div>

  <div class="card">
    <div class="card-title">Video &amp; Anzeige</div>
    <div style="display:grid;gap:12px;padding-top:8px;">
      <div class="vmd-grid-2">
        <div><label class="conn-label">Video Typ</label>
          <select id="vmd-video-type" class="conn-input" style="appearance:auto;">
            <option value="vga" ${d.video?.type==='vga'?'selected':''}>VGA (Standard)</option>
            <option value="cirrus" ${d.video?.type==='cirrus'?'selected':''}>Cirrus</option>
            <option value="virtio" ${d.video?.type==='virtio'?'selected':''}>VirtIO GPU (Linux)</option>
            <option value="qxl" ${d.video?.type==='qxl'?'selected':''}>QXL (SPICE)</option>
            <option value="bochs" ${d.video?.type==='bochs'?'selected':''}>Bochs</option>
          </select>
        </div>
        <div><label class="conn-label">VRAM (KiB)</label>
          <input id="vmd-video-vram" type="number" min="4096" max="524288" step="4096" value="${d.video?.vram_kib||16384}" class="conn-input">
        </div>
      </div>
      <button class="btn btn-primary" onclick="saveVMDVideo()" style="width:100%;padding:10px;">&#10003; Video speichern</button>
    </div>
  </div>

  <div class="card">
    <div class="card-title">Sound</div>
    <div style="padding-top:8px;">
      <div style="margin-bottom:12px;font-size:13px;font-family:var(--font-mono);color:var(--text-secondary);">
        ${d.sounds?.length ? '&#10003; ' + d.sounds.map(s=>s.model).join(', ') : '&#10005; Kein Sound-Ger&#228;t'}
      </div>
      <div class="vmd-sound-row">
        <select id="vmd-sound-model" class="conn-input" style="appearance:auto;">
          <option value="ich9">ich9 (Intel HD Audio &#8212; empfohlen f&#252;r Windows)</option>
          <option value="ich6">ich6 (AC97)</option>
          <option value="ac97">ac97</option>
          <option value="es1370">es1370 (&#228;ltere VMs)</option>
          <option value="usb">USB Audio</option>
        </select>
        <div style="display:flex;gap:6px;">
          <button class="btn btn-primary" onclick="saveVMDAddSound()">+ Hinzuf&#252;gen</button>
          ${d.sounds?.length ? `<button class="btn btn-danger" onclick="saveVMDRemoveSound()">&#10005; Entfernen</button>` : ''}
        </div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">Firmware &amp; Sicherheit</div>
    <div style="padding-top:8px;display:grid;gap:12px;">
      <div><label class="conn-label">Firmware</label>
        <select id="vmd-firmware" class="conn-input" style="appearance:auto;width:100%;" onchange="vmdFwChange()">
          <option value="bios" ${d.firmware!=='uefi'?'selected':''}>SeaBIOS &#8212; Legacy BIOS (Standard)</option>
          <option value="uefi" ${d.firmware==='uefi'?'selected':''}>OVMF &#8212; UEFI (Windows 11, Secure Boot)</option>
        </select>
      </div>
      <label id="vmd-sb-label" style="display:flex;align-items:center;gap:10px;font-size:13px;color:var(--text-secondary);padding:9px;border-radius:6px;background:var(--bg-elevated);${d.firmware==='uefi'?'':'opacity:.45;'}">
        <input type="checkbox" id="vmd-secureboot" ${d.secure_boot?'checked':''} ${d.firmware==='uefi'?'':'disabled'} style="accent-color:var(--accent);width:16px;height:16px;">
        &#128274; Secure Boot <span style="font-size:11px;color:var(--text-muted)">(nur UEFI &#8212; aktiviert SMM)</span>
      </label>
      <label style="display:flex;align-items:center;gap:10px;font-size:13px;color:var(--text-secondary);padding:9px;border-radius:6px;background:var(--bg-elevated);">
        <input type="checkbox" id="vmd-tpm" ${d.has_tpm?'checked':''} style="accent-color:var(--accent);width:16px;height:16px;">
        &#128737; TPM 2.0 (emuliert) <span style="font-size:11px;color:var(--text-muted)">(Pflicht f&#252;r Windows 11)</span>
      </label>
      <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);">
        &#9888; Nur bei ausgeschalteter VM wirksam. Firmware-Wechsel kann VM unbootbar machen.
      </div>
      <button class="btn btn-primary" onclick="saveVMDFirmware()" style="width:100%;padding:10px;">&#10003; Firmware &amp; Sicherheit speichern</button>
    </div>
  </div>

  <div class="card">
    <div class="card-title">Konsolen-Verbindungen</div>
    <div style="display:grid;gap:10px;padding-top:8px;">
      <label style="display:flex;align-items:center;gap:10px;font-size:13px;color:var(--text-secondary);padding:9px;border-radius:6px;background:var(--bg-elevated);">
        <input type="checkbox" id="vmd-gfx-vnc" ${d.has_vnc?'checked':''} style="accent-color:var(--accent);width:16px;height:16px;">
        &#128421; VNC-Konsole <span style="font-size:11px;color:var(--text-muted)">(breit kompatibel)</span>
      </label>
      <label style="display:flex;align-items:center;gap:10px;font-size:13px;color:var(--text-secondary);padding:9px;border-radius:6px;background:var(--bg-elevated);">
        <input type="checkbox" id="vmd-gfx-spice" ${d.has_spice?'checked':''} style="accent-color:var(--accent);width:16px;height:16px;">
        &#127916; SPICE-Konsole <span style="font-size:11px;color:var(--text-muted)">(+ Agent-Kanal: Clipboard/Auto-Resize)</span>
      </label>
      <label style="display:flex;align-items:center;gap:10px;font-size:13px;color:var(--text-secondary);padding:9px;border-radius:6px;background:var(--bg-elevated);">
        <input type="checkbox" id="vmd-gfx-kasm" ${d.kasmvnc_enabled?'checked':''} style="accent-color:var(--accent);width:16px;height:16px;">
        &#128241; KasmVNC <span style="font-size:11px;color:var(--text-muted)">(Browser-Viewer über VNC/SPICE, mobil-optimiert)</span>
      </label>
      <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);">
        &#9432; VNC/SPICE sind VM-Ger&#228;te (gelten nach Neustart). KasmVNC ist eine Dashboard-Anzeigeoption (sofort).
      </div>
      <button class="btn btn-primary" onclick="saveVMDGraphics()" style="width:100%;padding:10px;">&#10003; Konsolen speichern</button>
    </div>
  </div>
</div>
  `;
}

async function saveVMDGraphics() {
  const name = _vmDetailName; if (!name) return;
  const vnc = document.getElementById('vmd-gfx-vnc')?.checked || false;
  const spice = document.getElementById('vmd-gfx-spice')?.checked || false;
  const kasm = document.getElementById('vmd-gfx-kasm')?.checked || false;
  const r = await api('/api/vm/graphics', { method:'POST', body: JSON.stringify({ name, vnc, spice }) });
  if (r.error) { toast('Fehler: '+r.error,'error',7000); return; }
  if (_vmDetailData && kasm !== _vmDetailData.kasmvnc_enabled) {
    await api('/api/vm/kasmvnc', { method:'POST', body: JSON.stringify({ name, enabled: kasm }) });
  }
  if (r.warnings?.length) r.warnings.forEach(w => toast(w,'warn',6000));
  toast('Konsolen gespeichert &#8212; VNC/SPICE gelten nach Neustart','warn',5000);
  await loadVMDetail(name);
}

function vmdFwChange() {
  const fw = document.getElementById('vmd-firmware')?.value;
  const cb = document.getElementById('vmd-secureboot');
  const lbl = document.getElementById('vmd-sb-label');
  if (cb) { cb.disabled = fw !== 'uefi'; if (fw !== 'uefi') cb.checked = false; }
  if (lbl) lbl.style.opacity = fw === 'uefi' ? '1' : '.45';
}

function vmdUpdateVCPUs() {
  const s = parseInt(document.getElementById('vmd-cpu-sockets')?.value)||1;
  const c = parseInt(document.getElementById('vmd-cpu-cores')?.value)||1;
  const t = parseInt(document.getElementById('vmd-cpu-threads')?.value)||1;
  const el = document.getElementById('vmd-vcpu-total');
  if (el) el.textContent = s*c*t;
}

async function setVMKeymap() {
  const name = _vmDetailName; if (!name) return;
  const sel = document.getElementById('vmd-vnc-keymap');
  const keymap = sel ? sel.value : '';
  if (!keymap) return;
  const btn = document.getElementById('vmd-keymap-save-btn');
  if (btn) btn.disabled = true;
  try {
    const r = await api('/api/vm/keymap', {method:'POST', body:JSON.stringify({name, keymap})});
    if (r.error) { toast('Fehler: ' + r.error, 'error', 7000); return; }
    if (_vmDetailData) _vmDetailData.vnc_keymap = keymap;
    toast('Tastaturlayout gespeichert — gilt nach VM-Neustart', 'warn', 5000);
  } catch(e) {
    toast('Fehler: ' + e.message, 'error', 7000);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function saveVMDHardware() {
  const name = _vmDetailName; if (!name) return;
  const btn = document.getElementById('vmd-hw-save-btn');
  const err = document.getElementById('vmd-hw-err');
  if (err) err.style.display = 'none';
  if (btn) { btn.disabled=true; btn.textContent='Speichere...'; }
  const r = await api('/api/vm/update', { method:'POST', body: JSON.stringify({
    name,
    cpu_mode:    document.getElementById('vmd-cpu-mode').value,
    cpu_sockets: parseInt(document.getElementById('vmd-cpu-sockets').value)||1,
    cpu_cores:   parseInt(document.getElementById('vmd-cpu-cores').value)||1,
    cpu_threads: parseInt(document.getElementById('vmd-cpu-threads').value)||1,
    memory_mib:  parseInt(document.getElementById('vmd-mem').value)||1024,
    autostart:   document.getElementById('vmd-autostart').checked,
  })});
  if (btn) { btn.disabled=false; btn.textContent='&#10003; CPU & RAM speichern'; }
  if (r.error) { if (err) { err.textContent=r.error; err.style.display='block'; } toast('Fehler: '+r.error,'error',7000); return; }
  if (r.warnings?.length) r.warnings.forEach(w => toast(w,'warn',6000));
  else toast('Gespeichert &#8212; gilt nach Neustart der VM','warn',5000);
  await loadVMDetail(name);
}

async function saveVMDVideo() {
  const name = _vmDetailName; if (!name) return;
  const r = await api('/api/vm/update', { method:'POST', body: JSON.stringify({
    name,
    video_type: document.getElementById('vmd-video-type').value,
    video_vram: parseInt(document.getElementById('vmd-video-vram').value)||16384,
  })});
  if (r.error) { toast('Fehler: '+r.error,'error',7000); return; }
  toast('Video gespeichert &#8212; gilt nach Neustart','warn',5000);
  await loadVMDetail(name);
}

async function saveVMDFirmware() {
  const name = _vmDetailName; if (!name) return;
  const fw = document.getElementById('vmd-firmware').value;
  const sb = document.getElementById('vmd-secureboot')?.checked || false;
  const wantTpm = document.getElementById('vmd-tpm')?.checked || false;
  const hadTpm = !!(_vmDetailData && _vmDetailData.has_tpm);
  const body = { name, firmware: fw, secure_boot: (fw === 'uefi' ? sb : false) };
  if (wantTpm && !hadTpm) body.add_tpm = '2.0';
  if (!wantTpm && hadTpm) body.remove_tpm = true;
  const r = await api('/api/vm/update', { method:'POST', body: JSON.stringify(body) });
  if (r.error) { toast('Fehler: '+r.error,'error',7000); return; }
  if (r.warnings?.length) r.warnings.forEach(w => toast(w,'warn',6000));
  toast('Firmware & Sicherheit gespeichert &#8212; gilt nach Neustart','warn',5000);
  await loadVMDetail(name);
}

async function saveVMDAddSound() {
  const name = _vmDetailName; if (!name) return;
  const model = document.getElementById('vmd-sound-model').value;
  const r = await api('/api/vm/update', { method:'POST', body: JSON.stringify({ name, add_sound: model }) });
  if (r.error) { toast('Fehler: '+r.error,'error',7000); return; }
  toast(`Sound ${model} hinzugef&#252;gt &#8212; gilt nach Neustart`,'warn',5000);
  await loadVMDetail(name);
}

async function saveVMDRemoveSound() {
  const name = _vmDetailName; if (!name) return;
  const r = await api('/api/vm/update', { method:'POST', body: JSON.stringify({ name, remove_sound: true }) });
  if (r.error) { toast('Fehler: '+r.error,'error',7000); return; }
  toast('Sound entfernt &#8212; gilt nach Neustart','warn',5000);
  await loadVMDetail(name);
}

// ─── Disks tab ───────────────────────────────────────

async function renderVMDDisks(d) {
  const el = document.getElementById('vmdtab-disks'); if (!el) return;

  // Load pools for volume selector
  const pd = await api('/api/storage/pools');
  const poolOpts = (pd.pools||[]).map(p=>`<option value="${escHtml(p.name)}">${escHtml(p.name)}</option>`).join('');

  el.innerHTML = `
<div style="max-width:760px;display:grid;gap:20px;">
  <div class="card">
    <div class="card-title">Datentr&#228;ger (${(d.disks||[]).length})</div>
    <div style="padding-top:8px;">
      ${!(d.disks||[]).length ? '<div style="color:var(--text-muted);font-size:13px;padding:8px;">Keine Datentr&#228;ger konfiguriert.</div>' :
        (d.disks||[]).map(dk => `
        <div class="vol-row" style="border-radius:var(--radius-sm);margin-bottom:6px;padding:10px 12px;">
          <div style="font-size:20px;width:32px;text-align:center;flex-shrink:0;">${dk.device==='cdrom'?'&#128191;':'&#128190;'}</div>
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;font-family:var(--font-mono);color:var(--text-primary);">
              ${escHtml(dk.target||'?')}
              <span style="font-weight:400;color:var(--text-muted);font-size:11px;">${escHtml(dk.bus||'')} / ${escHtml(dk.format||'')}</span>
              ${dk.readonly?'<span style="color:var(--amber);font-size:10px;background:var(--amber-glow);padding:1px 5px;border-radius:4px;margin-left:4px;">Nur-Lesen</span>':''}
              ${dk.device==='cdrom'?'<span style="color:var(--cyan);font-size:10px;background:var(--cyan-glow);padding:1px 5px;border-radius:4px;margin-left:4px;">CD-ROM</span>':''}
            </div>
            <div style="color:var(--text-muted);font-size:11px;font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px;">${escHtml(dk.source||dk.device||'&#8212;')}</div>
          </div>
          <button class="btn btn-sm btn-danger" onclick="vmdRemoveDisk('${escHtml(dk.target||'')}', ${(dk.source && dk.device!=='cdrom')?'true':'false'})">&#128465; Entfernen</button>
        </div>`).join('')}
    </div>
  </div>

  <div class="card">
    <div class="card-title">Datentr&#228;ger / CD-ROM hinzuf&#252;gen</div>
    <div style="display:grid;gap:12px;padding-top:8px;">
      <div>
        <label class="conn-label">Typ</label>
        <select id="vmd-add-devtype" class="conn-input" style="appearance:auto;width:100%;" onchange="vmdDiskTypeChange()">
          <option value="disk">Datenträger (Festplatte)</option>
          <option value="cdrom">CD-ROM (ISO einlegen — z. B. virtio-Treiber für Windows)</option>
        </select>
      </div>
      <div id="vmd-add-iso-wrap" style="display:none;">
        <label class="conn-label">ISO-Abbild</label>
        <select id="vmd-add-iso" class="conn-input" style="appearance:auto;width:100%;" onchange="document.getElementById('vmd-add-path').value=this.value">
          <option value="">ISO wählen…</option>
        </select>
      </div>
      <div id="vmd-add-vol-wrap">
        <label class="conn-label">Volume aus Storage Pool</label>
        <div class="vmd-pool-row">
          <select id="vmd-add-pool" class="conn-input" style="appearance:auto;" onchange="vmdLoadVolumes(this.value)">
            ${poolOpts}
          </select>
          <select id="vmd-add-vol" class="conn-input" style="appearance:auto;" onchange="vmdVolSelected(this.value)">
            <option value="">Pool w&#228;hlen...</option>
          </select>
        </div>
      </div>
      <div>
        <label class="conn-label">Oder manueller Dateipfad</label>
        <input id="vmd-add-path" type="text" class="conn-input" placeholder="/var/lib/libvirt/images/disk.qcow2">
      </div>
      <div class="vmd-grid-4">
        <div><label class="conn-label">Ger&#228;t (dev)</label>
          <input id="vmd-add-target" type="text" class="conn-input" placeholder="vdb" value="vdb">
        </div>
        <div><label class="conn-label">Bus</label>
          <select id="vmd-add-bus" class="conn-input" style="appearance:auto;">
            <option>virtio</option><option>sata</option><option>ide</option><option>scsi</option>
          </select>
        </div>
        <div><label class="conn-label">Format</label>
          <select id="vmd-add-fmt" class="conn-input" style="appearance:auto;">
            <option>qcow2</option><option>raw</option><option>vmdk</option>
          </select>
        </div>
        <div style="display:flex;align-items:flex-end;padding-bottom:2px;">
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-secondary);">
            <input type="checkbox" id="vmd-add-ro" style="accent-color:var(--accent);"> Nur-Lesen
          </label>
        </div>
      </div>
      <button class="btn btn-primary" onclick="vmdAddDisk()" style="width:100%;padding:10px;">+ Datentr&#228;ger hinzuf&#252;gen</button>
    </div>
  </div>
</div>
  `;

  // Auto-load first pool volumes
  if (pd.pools?.length) vmdLoadVolumes(pd.pools[0].name);
  // ISO-Liste für den CD-ROM-Modus befüllen
  api('/api/storage/isos').then(r => {
    const sel = document.getElementById('vmd-add-iso'); if (!sel) return;
    sel.innerHTML = '<option value="">ISO wählen…</option>' +
      (r.isos || []).map(i => `<option value="${escHtml(i)}">${escHtml(i.split('/').pop())}</option>`).join('');
  }).catch(()=>{});
}

async function vmdLoadVolumes(pool) {
  const sel = document.getElementById('vmd-add-vol'); if (!sel) return;
  sel.innerHTML = '<option>Lade...</option>';
  const d = await api(`/api/storage/volumes?pool=${encodeURIComponent(pool)}`);
  sel.innerHTML = '<option value="">Volume w&#228;hlen...</option>' +
    (d.volumes||[]).map(v=>`<option value="${escHtml(v.path)}" data-fmt="${escHtml(v.type||'qcow2')}">${escHtml(v.name)} (${escHtml(v.capacity)})</option>`).join('');
}

function vmdVolSelected(path) {
  if (!path) return;
  document.getElementById('vmd-add-path').value = path;
}

async function vmdAddDisk() {
  const name = _vmDetailName; if (!name) return;
  const devtype = document.getElementById('vmd-add-devtype')?.value || 'disk';
  const path = document.getElementById('vmd-add-path').value.trim();
  const target = document.getElementById('vmd-add-target').value.trim();
  if (!path || !target) { toast('Pfad/ISO und Gerätename sind erforderlich','warn'); return; }
  const r = await api('/api/vm/disk/attach', { method:'POST', body: JSON.stringify({
    name, source_path: path, target_dev: target, device: devtype,
    bus: document.getElementById('vmd-add-bus').value,
    format: devtype === 'cdrom' ? 'raw' : document.getElementById('vmd-add-fmt').value,
    readonly: devtype === 'cdrom' ? true : document.getElementById('vmd-add-ro').checked,
  })});
  if (r.error) { toast('Fehler: '+r.error,'error',8000); return; }
  if (r.warnings?.length) r.warnings.forEach(w => toast(w,'warn',6000));
  toast((devtype === 'cdrom' ? 'CD-ROM' : 'Datenträger') + ' hinzugefügt','success');
  await loadVMDetail(name);
  switchVMDTab('disks');
}

function _vmNextSata() {
  const used = new Set((_vmDetailData && _vmDetailData.disks || []).map(d => d.target));
  for (const c of 'bcdefgh') if (!used.has('sd' + c)) return 'sd' + c;
  return 'sdz';
}

function vmdDiskTypeChange() {
  const cd = document.getElementById('vmd-add-devtype')?.value === 'cdrom';
  const iso = document.getElementById('vmd-add-iso-wrap');
  const vol = document.getElementById('vmd-add-vol-wrap');
  if (iso) iso.style.display = cd ? 'block' : 'none';
  if (vol) vol.style.display = cd ? 'none' : 'block';
  const bus = document.getElementById('vmd-add-bus');
  const tgt = document.getElementById('vmd-add-target');
  if (cd) {
    if (bus) bus.value = 'sata';
    if (tgt) tgt.value = _vmNextSata();
    document.getElementById('vmd-add-path').value = document.getElementById('vmd-add-iso')?.value || '';
  } else {
    if (tgt) tgt.value = 'vdb';
  }
}

async function vmdRemoveDisk(dev, hasSource) {
  const name = _vmDetailName; if (!name) return;
  if (!(await uiConfirm(`Datenträger "${dev}" von ${name} entfernen?`, {danger:true, okLabel:'Entfernen'}))) return;
  let delStorage = false;
  if (hasSource) delStorage = await uiConfirm('Auch die zugehörige Speicherdatei (Image) ENDGÜLTIG löschen?\n\n„Datei löschen" = unwiderruflich · „Abbrechen" = nur aus VM entfernen, Datei behalten.', {danger:true, okLabel:'Datei löschen', cancelLabel:'Nur entfernen'});
  const r = await api('/api/vm/disk/detach', { method:'POST', body: JSON.stringify({ name, target_dev: dev, delete_storage: delStorage }) });
  if (r.error) { toast('Fehler: '+r.error,'error',8000); return; }
  if (r.warnings?.length) r.warnings.forEach(w => toast(w,'warn',6000));
  toast(`Datenträger ${dev} entfernt`,'success');
  await loadVMDetail(name);
  switchVMDTab('disks');
}

// ─── Network tab ─────────────────────────────────────

async function renderVMDNetwork(d) {
  const el = document.getElementById('vmdtab-network'); if (!el) return;
  const nd = await api('/api/networks');
  const netOpts = (nd.networks||[]).map(n=>`<option value="${escHtml(n.name)}">${escHtml(n.name)}</option>`).join('');

  el.innerHTML = `
<div style="max-width:700px;display:grid;gap:20px;">
  <div class="card">
    <div class="card-title">Netzwerkkarten (${(d.interfaces||[]).length})</div>
    <div style="padding-top:8px;">
      ${!(d.interfaces||[]).length ? '<div style="color:var(--text-muted);font-size:13px;padding:8px;">Keine NICs konfiguriert.</div>' :
        (d.interfaces||[]).map(nic => `
        <div class="vol-row" style="border-radius:var(--radius-sm);margin-bottom:6px;padding:10px 12px;">
          <div style="font-size:20px;width:32px;text-align:center;flex-shrink:0;">&#128268;</div>
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;font-family:var(--font-mono);color:var(--text-primary);">
              ${escHtml(nic.source||'?')}
              <span style="font-weight:400;color:var(--text-muted);font-size:11px;">${escHtml(nic.model||'')} &middot; ${escHtml(nic.type||'')}</span>
            </div>
            <div style="color:var(--text-muted);font-size:11px;font-family:var(--font-mono);margin-top:2px;">MAC: ${escHtml(nic.mac||'&#8212;')}</div>
          </div>
          <button class="btn btn-sm btn-danger" onclick="vmdRemoveNic('${escHtml(nic.mac||'')}')">&#128465; Entfernen</button>
        </div>`).join('')}
    </div>
  </div>

  <div class="card">
    <div class="card-title">Netzwerkkarte hinzuf&#252;gen</div>
    <div style="display:grid;gap:12px;padding-top:8px;">
      <div class="vmd-grid-2">
        <div><label class="conn-label">Virtuelles Netzwerk</label>
          <select id="vmd-add-net" class="conn-input" style="appearance:auto;">${netOpts}</select>
        </div>
        <div><label class="conn-label">Netzwerk-Modell</label>
          <select id="vmd-add-nic-model" class="conn-input" style="appearance:auto;">
            <option value="virtio">virtio (empfohlen)</option>
            <option value="e1000">e1000 (Intel, Windows)</option>
            <option value="e1000e">e1000e</option>
            <option value="rtl8139">RTL8139 (alt)</option>
          </select>
        </div>
      </div>
      <button class="btn btn-primary" onclick="vmdAddNic()" style="width:100%;padding:10px;">+ NIC hinzuf&#252;gen</button>
    </div>
  </div>
</div>
  `;
}

async function vmdAddNic() {
  const name = _vmDetailName; if (!name) return;
  const net   = document.getElementById('vmd-add-net')?.value;
  const model = document.getElementById('vmd-add-nic-model')?.value || 'virtio';
  if (!net) { toast('Netzwerk w&#228;hlen','warn'); return; }
  const r = await api('/api/vm/nic/attach', { method:'POST', body: JSON.stringify({ name, network: net, model }) });
  if (r.error) { toast('Fehler: '+r.error,'error',7000); return; }
  toast('NIC hinzugef&#252;gt &#8212; Neustart erforderlich','warn',5000);
  await loadVMDetail(name);
  switchVMDTab('network');
}

async function vmdRemoveNic(mac) {
  const name = _vmDetailName; if (!name) return;
  if (!(await uiConfirm(`NIC ${mac} entfernen?`, {danger:true, okLabel:'Entfernen'}))) return;
  const r = await api('/api/vm/nic/detach', { method:'POST', body: JSON.stringify({ name, mac }) });
  if (r.error) { toast('Fehler: '+r.error,'error',7000); return; }
  toast('NIC entfernt','success');
  await loadVMDetail(name);
  switchVMDTab('network');
}

// ─── Boot tab ────────────────────────────────────────

function renderVMDBoot(d) {
  const order = d.boot_order || [];
  document.getElementById('vmdtab-boot').innerHTML = `
<div style="max-width:600px;">
  <div class="card">
    <div class="card-title">Boot-Reihenfolge</div>
    <div style="display:grid;gap:10px;padding-top:12px;">
      <label style="display:flex;align-items:center;gap:10px;font-size:13px;color:var(--text-secondary);padding:8px;border-radius:6px;background:var(--bg-elevated);">
        <input type="checkbox" id="vmd-boot-hd" ${order.includes('hd')?'checked':''} style="accent-color:var(--accent);width:16px;height:16px;">
        &#128190; Festplatte (hd) &#8212; prim&#228;rer Startdatentr&#228;ger
      </label>
      <label style="display:flex;align-items:center;gap:10px;font-size:13px;color:var(--text-secondary);padding:8px;border-radius:6px;background:var(--bg-elevated);">
        <input type="checkbox" id="vmd-boot-cdrom" ${order.includes('cdrom')?'checked':''} style="accent-color:var(--accent);width:16px;height:16px;">
        &#128191; CD-ROM / ISO (cdrom)
      </label>
      <label style="display:flex;align-items:center;gap:10px;font-size:13px;color:var(--text-secondary);padding:8px;border-radius:6px;background:var(--bg-elevated);">
        <input type="checkbox" id="vmd-boot-network" ${order.includes('network')?'checked':''} style="accent-color:var(--accent);width:16px;height:16px;">
        &#127760; Netzwerk / PXE (network)
      </label>
      <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);">Reihenfolge: aktivierte Ger&#228;te von oben nach unten.</div>
      <label style="display:flex;align-items:center;gap:10px;font-size:13px;color:var(--text-secondary);padding:8px;border-radius:6px;background:var(--bg-elevated);margin-top:4px;">
        <input type="checkbox" id="vmd-boot-menu" ${d.boot_menu?'checked':''} style="accent-color:var(--accent);width:16px;height:16px;">
        &#9000; Boot-Men&#252; anzeigen (F12-Auswahl beim Start)
      </label>
      <button class="btn btn-primary" onclick="saveVMDBoot()" style="width:100%;padding:11px;">&#10003; Boot-Einstellungen speichern</button>
    </div>
  </div>
</div>
  `;
}

async function saveVMDBoot() {
  const name = _vmDetailName; if (!name) return;
  const order = [];
  if (document.getElementById('vmd-boot-hd')?.checked)      order.push('hd');
  if (document.getElementById('vmd-boot-cdrom')?.checked)   order.push('cdrom');
  if (document.getElementById('vmd-boot-network')?.checked) order.push('network');
  const bootMenu = document.getElementById('vmd-boot-menu')?.checked || false;
  const r = await api('/api/vm/update', { method:'POST', body: JSON.stringify({ name, boot_order: order, boot_menu: bootMenu }) });
  if (r.error) { toast('Fehler: '+r.error,'error',7000); return; }
  toast('Boot-Einstellungen gespeichert','success');
}

// ─── Geräte-Tab (Hardware hinzufügen/entfernen, virt-manager-artig) ──────────

const VMD_DEVICE_KINDS = [
  {v:'channel_agent', t:'QEMU Gast-Agent (Kanal) — Shutdown/Stats/IP'},
  {v:'channel_spice', t:'SPICE-Agent-Kanal — Clipboard/Auto-Resize'},
  {v:'tablet',        t:'Tablet — absolute Maus (bessere Konsole)'},
  {v:'keyboard',      t:'Tastatur (virtio)'},
  {v:'usb_controller',t:'USB-3-Controller (qemu-xhci)'},
  {v:'usb_host',      t:'USB-Gerät durchreichen (vom Host)'},
  {v:'pci_host',      t:'PCI-Gerät durchreichen (GPU etc.)'},
  {v:'filesystem',    t:'Geteilter Ordner (virtiofs)'},
  {v:'disk',          t:'Datenträger (bestehende Image-Datei)'},
  {v:'interface',     t:'Netzwerkkarte'},
  {v:'sound',         t:'Sound-Gerät'},
  {v:'rng',           t:'RNG — Zufallszahlen (virtio)'},
  {v:'redirdev',      t:'USB-Redirection (SPICE)'},
  {v:'smartcard',     t:'Smartcard (SPICE)'},
  {v:'watchdog',      t:'Watchdog'},
  {v:'vsock',         t:'VSOCK'},
  {v:'panic',         t:'Panic-Notifier'},
  {v:'serial',        t:'Serielle Konsole'},
];
let _vmHostDevs = null;
let _vmNetCache = null;

function renderVMDDevices(d) {
  document.getElementById('vmdtab-devices').innerHTML = `
<div style="display:grid;gap:20px;max-width:760px;">
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <div class="card-title" style="margin-bottom:0;">Angeschlossene Geräte</div>
      <button class="btn" onclick="loadVMDDevices()">&#8635; Aktualisieren</button>
    </div>
    <div id="vmd-dev-list" style="padding-top:12px;"><div style="text-align:center;color:var(--text-muted);padding:12px;"><span class="spinner"></span></div></div>
  </div>
  <div class="card">
    <div class="card-title">Hardware hinzuf&#252;gen</div>
    <div style="display:grid;gap:12px;padding-top:8px;">
      <div><label class="conn-label">Ger&#228;tetyp</label>
        <select id="vmd-add-kind" class="conn-input" style="appearance:auto;width:100%;" onchange="vmdAddKindChange()">
          ${VMD_DEVICE_KINDS.filter(k => isSuperadmin() || !['usb_host','pci_host','filesystem','disk'].includes(k.v)).map(k=>`<option value="${k.v}">${escHtml(k.t)}</option>`).join('')}
        </select>
      </div>
      <div id="vmd-add-params"></div>
      <div id="vmd-add-err" style="display:none;color:var(--red);font-size:12px;font-family:var(--font-mono);padding:8px;background:var(--red-glow);border-radius:6px;"></div>
      <button class="btn btn-primary" id="vmd-add-btn" onclick="vmdAddDevice()" style="width:100%;padding:11px;">+ Ger&#228;t hinzuf&#252;gen</button>
      <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);">&#9432; &#196;nderungen gelten nach Neustart der VM.</div>
    </div>
  </div>
</div>`;
  vmdAddKindChange();
  loadVMDDevices();
}

async function loadVMDDevices() {
  const name = _vmDetailName; const el = document.getElementById('vmd-dev-list'); if (!name || !el) return;
  const r = await api(`/api/vm/devices?name=${encodeURIComponent(name)}`);
  if (r.error) { el.innerHTML = `<div style="color:var(--red);font-size:12px;">${escHtml(r.error)}</div>`; return; }
  const devs = r.devices || [];
  el.innerHTML = devs.map(dv => `
    <div class="hw-row" style="align-items:center;">
      <span class="hw-label" style="min-width:auto;flex:1;">${escHtml(dv.label)} <span style="color:var(--text-muted);font-size:10px;">${escHtml(dv.kind)}</span></span>
      <button class="btn btn-sm btn-danger" onclick="vmdRemoveDevice(${Number(dv.index)||0}, '${escHtml(dv.label)}')" title="Entfernen">&#10005;</button>
    </div>`).join('') || '<div style="color:var(--text-muted);font-size:12px;">Keine Geräte</div>';
}

async function vmdRemoveDevice(index, label) {
  const name = _vmDetailName; if (!name) return;
  if (!(await uiConfirm('Gerät entfernen?\n' + label, {danger:true, okLabel:'Entfernen'}))) return;
  const r = await api('/api/vm/device/remove', { method:'POST', body: JSON.stringify({ name, index }) });
  if (r.error) { toast('Fehler: '+r.error,'error',7000); return; }
  toast('Gerät entfernt — gilt nach Neustart','warn',5000);
  await loadVMDetail(name);
  switchVMDTab('devices');
}

async function vmdAddKindChange() {
  const kind = document.getElementById('vmd-add-kind')?.value;
  const box = document.getElementById('vmd-add-params'); if (!box) return;
  const inp = 'class="conn-input" style="width:100%;"';
  if (kind === 'usb_host' || kind === 'pci_host') {
    box.innerHTML = `<label class="conn-label">${kind==='usb_host'?'USB':'PCI'}-Gerät (vom Host)</label>
      <select id="vmd-p-hostdev" class="conn-input" style="appearance:auto;width:100%;"><option>Lade Host-Geräte…</option></select>
      <div style="font-size:11px;color:var(--amber,#f59e0b);font-family:var(--font-mono);margin-top:6px;">&#9888; Durchgereichtes Gerät ist im Host nicht mehr nutzbar.</div>`;
    if (!_vmHostDevs) { try { _vmHostDevs = await api('/api/vm/hostdevices'); } catch(e){ _vmHostDevs={usb:[],pci:[]}; } }
    const list = kind==='usb_host' ? (_vmHostDevs.usb||[]) : (_vmHostDevs.pci||[]);
    const sel = document.getElementById('vmd-p-hostdev');
    if (sel) sel.innerHTML = list.length
      ? list.map(x => `<option value="${escHtml(kind==='usb_host'? x.vendor+':'+x.product : x.address)}">${escHtml(x.label)}</option>`).join('')
      : '<option value="">Keine Geräte gefunden</option>';
  } else if (kind === 'filesystem') {
    box.innerHTML = `<label class="conn-label">Host-Ordner (absoluter Pfad)</label><input id="vmd-p-src" ${inp} placeholder="/srv/share">
      <label class="conn-label" style="margin-top:8px;">Mount-Tag (im Gast)</label><input id="vmd-p-tag" ${inp} placeholder="share" value="share">
      <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);margin-top:6px;">Im Linux-Gast: <code>mount -t virtiofs &lt;tag&gt; /mnt</code></div>`;
  } else if (kind === 'disk') {
    box.innerHTML = `<label class="conn-label">Image-Pfad (absolut)</label><input id="vmd-p-src" ${inp} placeholder="/var/lib/libvirt/images/data.qcow2">
      <div class="vmd-grid-3" style="margin-top:8px;">
        <div><label class="conn-label">Ziel</label><input id="vmd-p-tgt" ${inp} value="vdb"></div>
        <div><label class="conn-label">Bus</label><select id="vmd-p-bus" class="conn-input" style="appearance:auto;"><option>virtio</option><option>sata</option><option>scsi</option><option>usb</option><option>ide</option></select></div>
        <div><label class="conn-label">Format</label><select id="vmd-p-fmt" class="conn-input" style="appearance:auto;"><option>qcow2</option><option>raw</option></select></div>
      </div>
      <div style="display:flex;gap:16px;margin-top:8px;">
        <label style="font-size:12px;color:var(--text-secondary);"><input type="checkbox" id="vmd-p-cdrom"> CD-ROM</label>
        <label style="font-size:12px;color:var(--text-secondary);"><input type="checkbox" id="vmd-p-ro"> Schreibgesch&#252;tzt</label>
      </div>`;
  } else if (kind === 'interface') {
    box.innerHTML = `<label class="conn-label">Netzwerk</label><select id="vmd-p-net" class="conn-input" style="appearance:auto;width:100%;"><option>Lade…</option></select>
      <label class="conn-label" style="margin-top:8px;">Modell</label><select id="vmd-p-model" class="conn-input" style="appearance:auto;width:100%;"><option>virtio</option><option>e1000e</option><option>rtl8139</option></select>`;
    if (!_vmNetCache) { try { const rn = await api('/api/networks'); _vmNetCache = (rn.networks||[]).map(n=>n.name||n).filter(Boolean); } catch(e){ _vmNetCache=['default']; } }
    const nsel = document.getElementById('vmd-p-net');
    if (nsel) nsel.innerHTML = (_vmNetCache.length?_vmNetCache:['default']).map(n=>`<option>${escHtml(n)}</option>`).join('');
  } else if (kind === 'sound') {
    box.innerHTML = `<label class="conn-label">Modell</label><select id="vmd-p-model" class="conn-input" style="appearance:auto;width:100%;"><option value="ich9">ich9 (HD Audio)</option><option value="ac97">ac97</option><option value="es1370">es1370</option><option value="usb">USB</option></select>`;
  } else if (kind === 'watchdog') {
    box.innerHTML = `<div class="vmd-grid-2"><div><label class="conn-label">Modell</label><select id="vmd-p-model" class="conn-input" style="appearance:auto;"><option>i6300esb</option><option>ib700</option></select></div>
      <div><label class="conn-label">Aktion</label><select id="vmd-p-action" class="conn-input" style="appearance:auto;"><option>reset</option><option>poweroff</option><option>pause</option><option>none</option></select></div></div>`;
  } else {
    box.innerHTML = `<div style="font-size:12px;color:var(--text-muted);font-family:var(--font-mono);padding:4px;">Keine weiteren Parameter nötig.</div>`;
  }
}

async function vmdAddDevice() {
  const name = _vmDetailName; if (!name) return;
  const kind = document.getElementById('vmd-add-kind').value;
  const err = document.getElementById('vmd-add-err'); if (err) err.style.display='none';
  const params = {};
  const val = id => document.getElementById(id)?.value?.trim() || '';
  if (kind === 'usb_host') { const [v,p]=(val('vmd-p-hostdev')||'').split(':'); params.vendor=v; params.product=p; }
  else if (kind === 'pci_host') { params.address = val('vmd-p-hostdev'); }
  else if (kind === 'filesystem') { params.source=val('vmd-p-src'); params.target=val('vmd-p-tag'); }
  else if (kind === 'disk') { params.source=val('vmd-p-src'); params.target=val('vmd-p-tgt'); params.bus=val('vmd-p-bus'); params.format=val('vmd-p-fmt'); params.device=document.getElementById('vmd-p-cdrom')?.checked?'cdrom':'disk'; params.readonly=document.getElementById('vmd-p-ro')?.checked||false; }
  else if (kind === 'interface') { params.network=val('vmd-p-net'); params.model=val('vmd-p-model'); }
  else if (kind === 'sound' || kind === 'watchdog') { params.model=val('vmd-p-model'); if(kind==='watchdog') params.action=val('vmd-p-action'); }
  const btn = document.getElementById('vmd-add-btn'); if (btn){btn.disabled=true;btn.textContent='Füge hinzu…';}
  const r = await api('/api/vm/device/add', { method:'POST', body: JSON.stringify({ name, kind, params }) });
  if (btn){btn.disabled=false;btn.textContent='+ Gerät hinzufügen';}
  if (r.error) { if(err){err.textContent=r.error;err.style.display='block';} toast('Fehler: '+r.error,'error',7000); return; }
  toast('Gerät hinzugefügt — gilt nach Neustart','warn',5000);
  await loadVMDetail(name);
  switchVMDTab('devices');
}

// ─── XML-Tab (Experten-Editor — jegliche Konfiguration) ──────────────────────

function renderVMDXml(d) {
  document.getElementById('vmdtab-xml').innerHTML = `
<div style="max-width:900px;">
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <div class="card-title" style="margin-bottom:0;">Domain-XML &#8212; Experten-Modus</div>
      <button class="btn" onclick="loadVMDXml()">&#8635; Neu laden</button>
    </div>
    <div style="font-size:11px;color:var(--amber,#f59e0b);font-family:var(--font-mono);padding:8px 0;">
      &#9888; Direkte libvirt-Konfiguration. Fehler k&#246;nnen die VM unbootbar machen. &lt;name&gt; muss erhalten bleiben.
    </div>
    <textarea id="vmd-xml-box" spellcheck="false" style="width:100%;height:52vh;min-height:320px;background:#0a0e17;color:#c8d4e8;border:1px solid var(--border-dim);border-radius:8px;padding:12px;font:12px/1.5 var(--font-mono);resize:vertical;box-sizing:border-box;white-space:pre;overflow:auto;">Lade…</textarea>
    <button class="btn btn-primary" onclick="saveVMDXml()" style="width:100%;padding:11px;margin-top:12px;">&#10003; XML speichern (define)</button>
  </div>
</div>`;
  loadVMDXml();
}

async function loadVMDXml() {
  const name = _vmDetailName; const box = document.getElementById('vmd-xml-box'); if (!name || !box) return;
  const r = await api(`/api/vm/xml?name=${encodeURIComponent(name)}`);
  box.value = r.error ? ('Fehler: ' + r.error) : (r.xml || '');
}

async function saveVMDXml() {
  const name = _vmDetailName; const box = document.getElementById('vmd-xml-box'); if (!name || !box) return;
  if (!(await uiConfirm('Domain-XML übernehmen? Fehlkonfiguration kann die VM unbootbar machen.', {danger:true, okLabel:'Übernehmen'}))) return;
  const r = await api('/api/vm/xml', { method:'POST', body: JSON.stringify({ name, xml: box.value }) });
  if (r.error) { toast('Fehler: '+r.error,'error',9000); return; }
  toast('XML gespeichert — gilt nach Neustart','warn',5000);
  await loadVMDetail(name);
}


// ─── Freigabe-Tab (öffentlicher Gast-Link, zeitlich begrenzt) ────────────────
// Backend: dashboard/vmshare.py — /api/vm/shares (GET), /api/vm/share/create|
// revoke|extend (POST), Gast-Einstieg /share/vm/<id> (ohne Login).

let _vmdShareTimer = null;

function renderVMDShare(d) {
  const el = document.getElementById('vmdtab-share'); if (!el) return;
  const types = [];
  if (d.kasmvnc_enabled && (d.has_vnc || d.has_spice)) types.push(['kasmvnc', 'KasmVNC (empfohlen: mobil-optimiert, Auto-Resize)']);
  if (d.has_vnc)   types.push(['vnc',   'VNC (noVNC)']);
  if (d.has_spice) types.push(['spice', 'SPICE (spice-html5)']);
  const isRunning = (d.state || '').includes('running');
  el.innerHTML = `
<div style="max-width:900px;display:grid;gap:20px;">
  <div class="card">
    <div class="card-title">&#128279; &#214;ffentlichen Link erstellen</div>
    <div style="font-size:12px;color:var(--text-secondary);line-height:1.6;margin-bottom:14px;">
      Wer den Link kennt, kann <b>ohne Anmeldung</b> ausschlie&#223;lich den Bildschirm dieser VM bedienen
      (Maus, Tastatur, Zwischenablage). Verbindungs- und VNC-Einstellungen, VM-Aktionen und das Dashboard
      bleiben gesperrt. Der Link erlischt automatisch nach Ablauf der Laufzeit &#8212; oder sofort beim Widerruf;
      offene Verbindungen werden dann getrennt.
    </div>
    ${types.length ? `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;">
      <div>
        <label class="conn-label">Laufzeit</label>
        <select id="vmd-share-dur" class="conn-input" onchange="vmdShareDurChange()">
          <option value="15">15 Minuten</option>
          <option value="30">30 Minuten</option>
          <option value="60" selected>1 Stunde</option>
          <option value="120">2 Stunden</option>
          <option value="240">4 Stunden</option>
          <option value="480">8 Stunden</option>
          <option value="1440">24 Stunden</option>
          <option value="10080">7 Tage</option>
          <option value="custom">Benutzerdefiniert&#8230;</option>
        </select>
      </div>
      <div id="vmd-share-custom-wrap" style="display:none;">
        <label class="conn-label">Minuten (1 &#8211; 43200)</label>
        <input id="vmd-share-custom" class="conn-input" type="number" min="1" max="43200" value="90">
      </div>
      <div>
        <label class="conn-label">Konsole</label>
        <select id="vmd-share-type" class="conn-input">${types.map(t => `<option value="${t[0]}">${t[1]}</option>`).join('')}</select>
      </div>
      <div>
        <label class="conn-label">Bezeichnung (optional)</label>
        <input id="vmd-share-note" class="conn-input" maxlength="80" placeholder="z. B. Demo f&#252;r Max">
      </div>
    </div>
    ${!isRunning ? `<div style="font-size:11px;color:var(--amber,#f59e0b);font-family:var(--font-mono);margin-top:10px;">&#9888; Die VM ist ausgeschaltet &#8212; G&#228;ste sehen bis zum Start nur einen Hinweis (starten k&#246;nnen sie die VM nicht).</div>` : ''}
    <button class="btn btn-primary" onclick="vmdShareCreate(this)" style="width:100%;padding:10px;margin-top:14px;">&#128279; Link erstellen</button>
    ` : `<div style="font-size:12px;color:var(--amber,#f59e0b);font-family:var(--font-mono);">&#9888; Diese VM hat keine grafische Konsole (VNC/SPICE). Bitte zuerst unter &#8222;Hardware &#8594; Konsolen-Verbindungen&#8220; aktivieren.</div>`}
  </div>

  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <div class="card-title" style="margin-bottom:0;">Aktive Freigaben</div>
      <button class="btn" onclick="loadVMDShares()">&#8635; Aktualisieren</button>
    </div>
    <div id="vmd-share-list"><span class="spinner"></span></div>
  </div>
</div>`;
  loadVMDShares();
}

function vmdShareDurChange() {
  const sel = document.getElementById('vmd-share-dur');
  const wrap = document.getElementById('vmd-share-custom-wrap');
  if (sel && wrap) wrap.style.display = sel.value === 'custom' ? 'block' : 'none';
}

function _vmdShareFmt(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  if (d > 0) return `${d} Tag${d > 1 ? 'en' : ''} ${h} h`;
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m > 0) return `${m} min`;
  return `${sec} s`;
}

function _vmdShareSchedule() {
  if (_vmdShareTimer) clearTimeout(_vmdShareTimer);
  _vmdShareTimer = setTimeout(() => {
    _vmdShareTimer = null;
    const p = document.getElementById('vmdtab-share');
    const active = document.getElementById('page-vm-detail')?.classList.contains('active');
    if (!active || !p || p.style.display === 'none' || !document.getElementById('vmd-share-list')) return;
    loadVMDShares();
  }, 30000);
}

async function loadVMDShares() {
  const name = _vmDetailName; const box = document.getElementById('vmd-share-list');
  if (!name || !box) return;
  const r = await api(`/api/vm/shares?name=${encodeURIComponent(name)}`);
  if (!document.getElementById('vmd-share-list')) return;
  if (r.error) { box.innerHTML = `<div style="color:var(--red);font-size:12px;">${escHtml(r.error)}</div>`; return; }
  const shares = r.shares || [];
  if (!shares.length) {
    box.innerHTML = `<div style="font-size:12px;color:var(--text-muted);font-family:var(--font-mono);padding:6px 0;">Keine aktiven Freigaben.</div>`;
  } else {
    box.innerHTML = shares.map(s => `
    <div style="border:1px solid var(--border-dim);border-radius:8px;padding:12px;margin-bottom:10px;background:var(--bg-elevated);">
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;">
        <div style="font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px;min-width:0;">
          <span style="overflow:hidden;text-overflow:ellipsis;">${escHtml(s.note || 'Freigabe')}</span>
          <span class="vm-state running">${escHtml(s.type)}</span>
        </div>
        <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);">
          endet in <b style="color:${s.remaining < 300 ? 'var(--amber,#f59e0b)' : 'var(--accent)'}">${_vmdShareFmt(s.remaining)}</b>
          &middot; ${escHtml(new Date(s.expires * 1000).toLocaleString('de-DE', {dateStyle:'short', timeStyle:'short'}))}
        </div>
      </div>
      <div style="display:flex;gap:6px;margin-top:10px;">
        <input class="conn-input" readonly value="${escHtml(s.url)}" onclick="this.select()" style="flex:1;min-width:0;font-size:12px;">
        <button class="btn" data-url="${escHtml(s.url)}" onclick="vmdShareCopy(this.dataset.url, this)" title="Link kopieren">&#128203;</button>
        <button class="btn" data-url="${escHtml(s.url)}" onclick="window.open(this.dataset.url,'_blank')" title="Link &#246;ffnen (Gast-Ansicht)">&#8599;</button>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;align-items:center;font-size:11px;color:var(--text-muted);font-family:var(--font-mono);">
        <span>von ${escHtml(s.created_by || '?')}</span>
        <span>&middot; ${s.views || 0}&#215; ge&#246;ffnet</span>
        <span>&middot; ${s.connections || 0} verbunden</span>
        ${s.last_ip ? `<span>&middot; zuletzt ${escHtml(s.last_ip)}</span>` : ''}
        <span style="flex:1"></span>
        <button class="btn btn-sm" data-id="${escHtml(s.id)}" onclick="vmdShareExtend(this.dataset.id)">+ Verl&#228;ngern</button>
        <button class="btn btn-sm btn-danger" data-id="${escHtml(s.id)}" onclick="vmdShareRevoke(this.dataset.id)">&#10005; Widerrufen</button>
      </div>
    </div>`).join('');
  }
  _vmdShareSchedule();
}

async function vmdShareCreate(btn) {
  const name = _vmDetailName; if (!name) return;
  const sel = document.getElementById('vmd-share-dur');
  let minutes = sel ? sel.value : '60';
  if (minutes === 'custom') minutes = document.getElementById('vmd-share-custom')?.value;
  minutes = parseInt(minutes, 10);
  if (!minutes || minutes < 1 || minutes > 43200) { toast('Laufzeit: 1 bis 43200 Minuten', 'error'); return; }
  const type = document.getElementById('vmd-share-type')?.value || 'kasmvnc';
  const note = document.getElementById('vmd-share-note')?.value || '';
  if (btn) btn.disabled = true;
  const r = await api('/api/vm/share/create', { method: 'POST', body: JSON.stringify({ name, minutes, type, note }) });
  if (btn) btn.disabled = false;
  if (r.error) { toast('Fehler: ' + r.error, 'error', 7000); return; }
  const copied = await _copyText(r.share.url);
  toast(copied ? 'Link erstellt und in die Zwischenablage kopiert' : 'Link erstellt', 'success', 5000);
  await loadVMDShares();
}

async function _copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { return false; }
}

async function vmdShareCopy(url, btn) {
  const ok = await _copyText(url);
  if (ok) { toast('Link kopiert', 'success', 2500); if (btn) { const o = btn.innerHTML; btn.innerHTML = '&#10003;'; setTimeout(() => btn.innerHTML = o, 1500); } }
  else {
    const inp = btn?.parentElement?.querySelector('input'); if (inp) { inp.select(); }
    toast('Kopieren nicht m&#246;glich &#8212; Link markiert, bitte manuell kopieren', 'warn', 4000);
  }
}

async function vmdShareExtend(id) {
  const v = window.prompt('Um wie viele Minuten verlängern?', '60');
  if (v == null) return;
  const minutes = parseInt(v, 10);
  if (!minutes || minutes < 1) { toast('Ungültige Minutenzahl', 'error'); return; }
  const r = await api('/api/vm/share/extend', { method: 'POST', body: JSON.stringify({ id, minutes }) });
  if (r.error) { toast('Fehler: ' + r.error, 'error', 7000); return; }
  toast('Freigabe verlängert', 'success');
  await loadVMDShares();
}

async function vmdShareRevoke(id) {
  if (!(await uiConfirm('Freigabe widerrufen? Der Link wird sofort ungültig, verbundene Gäste werden getrennt.', { danger: true, okLabel: 'Widerrufen' }))) return;
  const r = await api('/api/vm/share/revoke', { method: 'POST', body: JSON.stringify({ id }) });
  if (r.error) { toast('Fehler: ' + r.error, 'error', 7000); return; }
  toast('Freigabe widerrufen', 'success');
  await loadVMDShares();
}

// ─── Snapshots tab ───────────────────────────────────

async function loadVMDSnapshots() {
  const name = _vmDetailName; if (!name) return;
  const el = document.getElementById('vmdtab-snapshots'); if (!el) return;
  el.innerHTML = `
<div style="max-width:700px;display:grid;gap:20px;">
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <div class="card-title" style="margin-bottom:0;">Snapshots</div>
      <button class="btn" onclick="loadVMDSnapshots()">&#8635; Aktualisieren</button>
    </div>
    <div id="vmd-snap-list"><div style="padding:16px;text-align:center;color:var(--text-muted);font-size:12px;"><span class="spinner"></span></div></div>
  </div>
  <div class="card">
    <div class="card-title">Neuer Snapshot</div>
    <div style="display:grid;gap:10px;padding-top:8px;">
      <div><label class="conn-label">Name</label>
        <input id="vmd-snap-name" type="text" class="conn-input" placeholder="vor-update-2026-06">
      </div>
      <div><label class="conn-label">Beschreibung (optional)</label>
        <input id="vmd-snap-desc" type="text" class="conn-input" placeholder="Vor Windows Update">
      </div>
      <button class="btn btn-primary" onclick="vmdCreateSnapshot()" style="width:100%;padding:10px;">&#128247; Snapshot erstellen</button>
    </div>
  </div>
</div>
  `;

  const d = await api(`/api/vm/snapshots?name=${encodeURIComponent(name)}`);
  const snapEl = document.getElementById('vmd-snap-list');
  if (!snapEl) return;
  if (d.error) { snapEl.innerHTML = `<div style="padding:12px;color:var(--red);font-size:12px;font-family:var(--font-mono);">${escHtml(d.error)}</div>`; return; }
  const snaps = d.snapshots || [];
  if (!snaps.length) {
    snapEl.innerHTML = '<div style="padding:14px;text-align:center;color:var(--text-muted);font-size:12px;font-family:var(--font-mono);">Keine Snapshots vorhanden.</div>';
    return;
  }
  snapEl.innerHTML = snaps.map(s => `
    <div class="snap-row">
      <span class="snap-name">&#128247; ${escHtml(s.name)}</span>
      <span class="snap-date">${escHtml(s.creation_time)}</span>
      <span class="snap-state">${escHtml(s.state)}</span>
      <button class="btn btn-sm" onclick="vmdRevertSnap('${escHtml(s.name)}')" title="Wiederherstellen">&#9100; Zur&#252;ck</button>
      <button class="btn btn-sm btn-danger" onclick="vmdDeleteSnap('${escHtml(s.name)}')" title="L&#246;schen">&#128465;</button>
    </div>`).join('');
}

async function vmdCreateSnapshot() {
  const name = _vmDetailName; if (!name) return;
  const snapName = document.getElementById('vmd-snap-name')?.value.trim();
  if (!snapName) { toast('Snapshot-Name erforderlich','warn'); return; }
  toast('Erstelle Snapshot...','info',3000);
  const r = await api('/api/vm/snapshot/create', { method:'POST', body: JSON.stringify({
    name, snapshot_name: snapName, description: document.getElementById('vmd-snap-desc')?.value.trim() || ''
  })});
  if (r.error) { toast('Fehler: '+r.error,'error',8000); return; }
  toast(`Snapshot "${snapName}" erstellt`,'success');
  await loadVMDSnapshots();
}

async function vmdDeleteSnap(snapName) {
  const name = _vmDetailName;
  if (!name) return;
  if (!(await uiConfirm(`Snapshot "${snapName}" löschen?`, {danger:true, okLabel:'Löschen'}))) return;
  const r = await api('/api/vm/snapshot/delete', { method:'POST', body: JSON.stringify({ name, snapshot_name: snapName }) });
  if (r.error) { toast('Fehler: '+r.error,'error',7000); return; }
  toast(`Snapshot "${snapName}" gel&#246;scht`,'success');
  await loadVMDSnapshots();
}

async function vmdRevertSnap(snapName) {
  const name = _vmDetailName;
  if (!name) return;
  if (!(await uiConfirm(`VM "${name}" auf Snapshot "${snapName}" zurücksetzen?\n⚠ Die VM wird gestoppt!`, {danger:true, okLabel:'Zurücksetzen'}))) return;
  toast('Stelle wieder her...','info',4000);
  const r = await api('/api/vm/snapshot/revert', { method:'POST', body: JSON.stringify({ name, snapshot_name: snapName }) });
  if (r.error) { toast('Fehler: '+r.error,'error',8000); return; }
  toast(`Wiederhergestellt: ${snapName}`,'success');
  await loadVMDetail(name);
  switchVMDTab('snapshots');
  setTimeout(loadVMs, 2000);
}

// ─── Clone & Delete (from detail page) ───────────────

async function vmdCloneVM() {
  const name = _vmDetailName; if (!name) return;
  const dst = prompt(`Neuer Name f&#252;r den Klon von "${name}":`, name + '-clone');
  if (!dst?.trim()) return;
  toast('Klone VM... (kann Minuten dauern)','info',120000);
  const r = await api('/api/vm/clone', { method:'POST', body: JSON.stringify({ name, new_name: dst.trim() }) });
  if (r.error) { toast('Klon-Fehler: '+r.error,'error',8000); return; }
  toast(`VM "${dst.trim()}" erstellt`,'success');
  showPage('vms');
}

async function vmdDeleteVM() {
  const name = _vmDetailName; if (!name) return;
  const deleteVols = document.getElementById('vmd-del-vols')?.checked;
  if (!(await uiConfirm(`VM "${name}" wirklich löschen?` + (deleteVols ? '\n\n⚠ Inklusive aller Datenträger (unwiderruflich)!' : ''), {danger:true, okLabel:'VM löschen'}))) return;
  const r = await api('/api/vm/delete', { method:'POST', body: JSON.stringify({ name, delete_volumes: deleteVols }) });
  if (r.error) { toast('Fehler: '+r.error,'error',7000); return; }
  toast(`VM "${name}" gel&#246;scht`,'success');
  showPage('vms');
}

// ─── VM Create Modal ─────────────────────────────────

async function openVMCreateModal() {
  const modal = document.getElementById('vm-create-modal');
  document.getElementById('vc-name').value = '';
  document.getElementById('vc-vcpus').value = 2;
  document.getElementById('vc-ram').value = 2;
  document.getElementById('vc-disk').value = 20;
  document.getElementById('vc-err').style.display = 'none';
  document.getElementById('vc-btn').textContent = 'VM Erstellen';
  document.getElementById('vc-btn').disabled = false;

  // Load pools
  const pd = await api('/api/storage/pools');
  const poolSel = document.getElementById('vc-pool');
  poolSel.innerHTML = (pd.pools || []).map(p => `<option value="${escHtml(p.name)}">${escHtml(p.name)}</option>`).join('');

  // Load ISOs
  const id = await api('/api/storage/isos');
  const isos = id.isos || [];
  const isoSel = document.getElementById('vc-iso');
  isoSel.innerHTML = '<option value="">Kein ISO</option>' +
    isos.map(i => `<option value="${escHtml(i)}">${escHtml(i.split('/').pop())} (${escHtml(i)})</option>`).join('');
  // virtio-Treiber-ISOs separat (für Windows)
  const virtioSel = document.getElementById('vc-virtio');
  const virtioIsos = isos.filter(i => /virtio/i.test(i));
  virtioSel.innerHTML = '<option value="">Keine</option>' +
    virtioIsos.map(i => `<option value="${escHtml(i)}">${escHtml(i.split('/').pop())}</option>`).join('');
  // sinnvolle Vorauswahl der virtio-ISO
  if (virtioIsos.length) virtioSel.value = virtioIsos[0];
  document.getElementById('vc-ostype').value = 'linux';
  vcOsChange();

  // Load networks
  const nd = await api('/api/networks');
  const netSel = document.getElementById('vc-net');
  netSel.innerHTML = (nd.networks || []).map(n => `<option value="${escHtml(n.name)}">${escHtml(n.name)}</option>`).join('');

  modal.style.display = 'flex';
}

function vcOsChange() {
  const os = document.getElementById('vc-ostype')?.value;
  const wrap = document.getElementById('vc-virtio-wrap');
  if (wrap) wrap.style.display = (os === 'windows') ? 'block' : 'none';
}
function vcIsoChange() {
  // OS-Typ automatisch anhand des ISO-Namens vorschlagen
  const iso = (document.getElementById('vc-iso')?.value || '').toLowerCase();
  const sel = document.getElementById('vc-ostype');
  if (!iso || !sel) return;
  if (/win|windows/.test(iso)) sel.value = 'windows';
  else if (/ubuntu|debian|fedora|linux|centos|arch|mint|alma|rocky|proxmox|iso.*nix/.test(iso)) sel.value = 'linux';
  vcOsChange();
}
function closeVMCreateModal() {
  document.getElementById('vm-create-modal').style.display = 'none';
}
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('vm-create-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeVMCreateModal();
  });
});

async function createVM() {
  const errEl = document.getElementById('vc-err');
  const btn   = document.getElementById('vc-btn');
  errEl.style.display = 'none';
  const name = document.getElementById('vc-name').value.trim();
  if (!name) { errEl.textContent = 'VM Name erforderlich.'; errEl.style.display = 'block'; return; }
  btn.textContent = 'Erstelle...';
  btn.disabled = true;
  const r = await api('/api/vm/create', {
    method: 'POST',
    body: JSON.stringify({
      name,
      vcpus: parseInt(document.getElementById('vc-vcpus').value) || 2,
      memory_mib: (parseInt(document.getElementById('vc-ram').value) || 2) * 1024,
      pool: document.getElementById('vc-pool').value,
      disk_size_gib: parseInt(document.getElementById('vc-disk').value) || 20,
      iso_path: document.getElementById('vc-iso').value,
      network: document.getElementById('vc-net').value,
      machine: document.getElementById('vc-machine').value,
      os_type: document.getElementById('vc-ostype').value,
      virtio_iso: document.getElementById('vc-ostype').value === 'windows'
        ? document.getElementById('vc-virtio').value : '',
    })
  });
  btn.textContent = 'VM Erstellen';
  btn.disabled = false;
  if (r.error) { errEl.textContent = r.error; errEl.style.display = 'block'; return; }
  closeVMCreateModal();
  loadVMs();
}

// ─── Networks ────────────────────────────────────────

async function loadNetworks() {
  const container = document.getElementById('net-list');
  container.innerHTML = '<div class="loading-overlay"><span class="spinner"></span></div>';
  const d = await api('/api/networks');
  const nets = d.networks || [];
  _netCache = {}; nets.forEach(n => { _netCache[n.name] = n; });
  if (!nets.length) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:12px;font-family:var(--font-mono);padding:12px;">Keine Netzwerke gefunden.</div>';
    return;
  }
  container.innerHTML = nets.map(n => `
    <div class="net-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <div style="font-weight:600;font-family:var(--font-mono);font-size:14px;">${escHtml(n.name)}</div>
        <span style="font-size:11px;padding:2px 8px;border-radius:20px;font-family:var(--font-mono);font-weight:600;
          ${n.active ? 'background:var(--accent-ghost);color:var(--accent)' : 'background:rgba(100,116,139,.15);color:#94a3b8'}">
          ${n.active ? 'aktiv' : 'inaktiv'}
        </span>
      </div>
      <div style="font-size:11px;font-family:var(--font-mono);color:var(--text-muted);margin-bottom:10px;line-height:1.6;">
        ${escHtml(n.forward_mode || 'isolated')}
        ${n.bridge ? ' &bull; ' + escHtml(n.bridge) : ''}
        ${n.ip ? ' &bull; ' + escHtml(n.ip) + '/' + escHtml(String(n.prefix)) : ''}
        ${n.dhcp_start ? ' &bull; DHCP: ' + escHtml(n.dhcp_start) + '&#8209;' + escHtml(n.dhcp_end) : ''}
        ${n.active ? ` &bull; <span style="color:var(--accent)">&#128268; ${Number(n.leases)||0} verbunden</span>` : ''}
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        ${n.active ? `<button class="btn btn-sm btn-danger" onclick="netAction('${escHtml(n.name)}','stop')">Stop</button>`
                   : `<button class="btn btn-sm" onclick="netAction('${escHtml(n.name)}','start')">Start</button>`}
        <button class="btn btn-sm" onclick="netAction('${escHtml(n.name)}','${n.autostart ? 'no-autostart' : 'autostart'}')">
          Autostart ${n.autostart ? 'aus' : 'ein'}
        </button>
        <button class="btn btn-sm" onclick="netShowEdit('${escHtml(n.name)}')">Bearbeiten</button>
        <button class="btn btn-sm" onclick="netShowReservations('${escHtml(n.name)}')">Reservierungen</button>
        ${n.active ? `<button class="btn btn-sm" onclick="netShowLeases('${escHtml(n.name)}')">Verbundene</button>` : ''}
        <button class="btn btn-sm" onclick="netShowXml('${escHtml(n.name)}')">XML</button>
        <button class="btn btn-sm btn-danger" onclick="netAction('${escHtml(n.name)}','delete')" style="margin-left:auto;">L&#246;schen</button>
      </div>
      <div id="net-expand-${escHtml(n.name)}" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--border-dim);"></div>
    </div>`).join('');
}

function _netExpand(name) { return document.getElementById('net-expand-' + name); }

async function netShowLeases(name) {
  const el = _netExpand(name); if (!el) return;
  if (el.style.display !== 'none' && el.dataset.mode === 'leases') { el.style.display='none'; return; }
  el.dataset.mode = 'leases'; el.style.display = 'block';
  el.innerHTML = '<div style="color:var(--text-muted);font-size:12px;"><span class="spinner"></span></div>';
  const r = await api(`/api/network/leases?name=${encodeURIComponent(name)}`);
  if (r.error) { el.innerHTML = `<div style="color:var(--red);font-size:12px;">${escHtml(r.error)}</div>`; return; }
  const ls = r.leases || [];
  el.innerHTML = `<div style="font-size:12px;font-weight:600;margin-bottom:8px;">Verbundene Gäste (${ls.length})</div>` +
    (ls.length ? `<div style="display:grid;gap:6px;">` + ls.map(l => `
      <div style="display:flex;justify-content:space-between;gap:8px;font-family:var(--font-mono);font-size:11px;background:var(--bg-elevated);padding:6px 8px;border-radius:6px;">
        <span style="color:var(--accent)">${escHtml(l.ip||'?')}</span>
        <span style="color:var(--text-secondary)">${escHtml(l.hostname||'')}</span>
        <span style="color:var(--text-muted)">${escHtml(l.mac||'')}</span>
      </div>`).join('') + `</div>`
    : '<div style="color:var(--text-muted);font-size:12px;">Keine aktiven DHCP-Leases</div>');
}

async function netShowXml(name) {
  const el = _netExpand(name); if (!el) return;
  if (el.style.display !== 'none' && el.dataset.mode === 'xml') { el.style.display='none'; return; }
  el.dataset.mode = 'xml'; el.style.display = 'block';
  el.innerHTML = '<div style="color:var(--text-muted);font-size:12px;"><span class="spinner"></span></div>';
  const r = await api(`/api/network/xml?name=${encodeURIComponent(name)}`);
  if (r.error) { el.innerHTML = `<div style="color:var(--red);font-size:12px;">${escHtml(r.error)}</div>`; return; }
  el.innerHTML = `
    <div style="font-size:11px;color:var(--amber,#f59e0b);font-family:var(--font-mono);margin-bottom:6px;">&#9888; &#196;nderung gilt nach Netzwerk-Neustart (Stop/Start). &lt;name&gt; muss erhalten bleiben.</div>
    <textarea id="net-xml-${escHtml(name)}" spellcheck="false" style="width:100%;height:220px;background:#0a0e17;color:#c8d4e8;border:1px solid var(--border-dim);border-radius:8px;padding:10px;font:11px/1.5 var(--font-mono);resize:vertical;box-sizing:border-box;white-space:pre;"></textarea>
    <button class="btn btn-primary btn-sm" onclick="netSaveXml('${escHtml(name)}')" style="margin-top:8px;">&#10003; XML speichern</button>`;
  const ta = document.getElementById('net-xml-' + name); if (ta) ta.value = r.xml || '';
}

async function netSaveXml(name) {
  const ta = document.getElementById('net-xml-' + name); if (!ta) return;
  if (!(await uiConfirm('Netzwerk-XML übernehmen?', {okLabel:'Übernehmen'}))) return;
  const r = await api('/api/network/xml', { method:'POST', body: JSON.stringify({ name, xml: ta.value }) });
  if (r.error) { toast('Fehler: '+r.error,'error',9000); return; }
  if (r.warnings?.length) r.warnings.forEach(w=>toast(w,'warn',6000));
  toast('Netzwerk-XML gespeichert','success');
  loadNetworks();
}

let _netCache = {};

function netShowEdit(name) {
  const el = _netExpand(name); if (!el) return;
  if (el.style.display !== 'none' && el.dataset.mode === 'edit') { el.style.display='none'; return; }
  el.dataset.mode = 'edit'; el.style.display = 'block';
  const n = _netCache[name] || {};
  const modes = ['nat','route','open','isolated'];
  el.innerHTML = `
    <div style="display:grid;gap:10px;">
      <div><label class="conn-label">Forward-Modus</label>
        <select id="net-e-mode-${escHtml(name)}" class="conn-input" style="appearance:auto;width:100%;">
          ${modes.map(x=>`<option value="${x}" ${(n.forward_mode||'isolated')===x?'selected':''}>${x}</option>`).join('')}
        </select></div>
      <div class="vmd-grid-2">
        <div><label class="conn-label">Gateway-IP</label><input id="net-e-ip-${escHtml(name)}" class="conn-input" value="${escHtml(n.ip||'')}"></div>
        <div><label class="conn-label">Prefix</label><input id="net-e-prefix-${escHtml(name)}" type="number" min="1" max="32" class="conn-input" value="${escHtml(String(n.prefix||24))}"></div>
      </div>
      <label style="font-size:12px;color:var(--text-secondary);"><input type="checkbox" id="net-e-dhcp-${escHtml(name)}" ${n.dhcp_start?'checked':''} onchange="var r=document.getElementById('net-e-range-${escHtml(name)}');if(r)r.style.display=this.checked?'grid':'none'"> DHCP aktiv</label>
      <div id="net-e-range-${escHtml(name)}" class="vmd-grid-2" style="${n.dhcp_start?'':'display:none;'}">
        <div><label class="conn-label">DHCP von</label><input id="net-e-ds-${escHtml(name)}" class="conn-input" value="${escHtml(n.dhcp_start||'')}"></div>
        <div><label class="conn-label">DHCP bis</label><input id="net-e-de-${escHtml(name)}" class="conn-input" value="${escHtml(n.dhcp_end||'')}"></div>
      </div>
      <div style="font-size:11px;color:var(--amber,#f59e0b);font-family:var(--font-mono);">&#9888; Gilt nach Netzwerk-Neustart (Stop/Start).</div>
      <button class="btn btn-primary btn-sm" onclick="netSaveEdit('${escHtml(name)}')">&#10003; Speichern</button>
    </div>`;
}

async function netSaveEdit(name) {
  const g = id => document.getElementById(id);
  const dhcpOn = g('net-e-dhcp-'+name)?.checked || false;
  const body = { name, forward_mode: g('net-e-mode-'+name)?.value, dhcp_enabled: dhcpOn };
  const ip = g('net-e-ip-'+name)?.value.trim();
  if (ip) { body.ip = ip; body.prefix = parseInt(g('net-e-prefix-'+name)?.value)||24; }
  if (dhcpOn) { body.dhcp_start = g('net-e-ds-'+name)?.value.trim(); body.dhcp_end = g('net-e-de-'+name)?.value.trim(); }
  const r = await api('/api/network/edit', { method:'POST', body: JSON.stringify(body) });
  if (r.error) { toast('Fehler: '+r.error,'error',8000); return; }
  if (r.warnings?.length) r.warnings.forEach(w=>toast(w,'warn',6000));
  toast('Netzwerk gespeichert','success');
  loadNetworks();
}

function netShowReservations(name) {
  const el = _netExpand(name); if (!el) return;
  if (el.style.display !== 'none' && el.dataset.mode === 'res') { el.style.display='none'; return; }
  el.dataset.mode = 'res'; el.style.display = 'block';
  _netRenderRes(name);
}

async function _netRenderRes(name) {
  const el = _netExpand(name); if (!el) return;
  el.innerHTML = '<div style="color:var(--text-muted);font-size:12px;"><span class="spinner"></span></div>';
  const r = await api(`/api/network/dhcp-hosts?name=${encodeURIComponent(name)}`);
  if (r.error) { el.innerHTML = `<div style="color:var(--red);font-size:12px;">${escHtml(r.error)}</div>`; return; }
  const hs = r.hosts || [];
  el.innerHTML = `
    <div style="font-size:12px;font-weight:600;margin-bottom:8px;">Statische Reservierungen (${hs.length})</div>
    <div style="display:grid;gap:6px;margin-bottom:12px;">${hs.map(h=>`
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;font-family:var(--font-mono);font-size:11px;background:var(--bg-elevated);padding:6px 8px;border-radius:6px;">
        <span style="color:var(--accent)">${escHtml(h.ip)}</span><span style="flex:1;">${escHtml(h.name||'')}</span><span style="color:var(--text-muted)">${escHtml(h.mac)}</span>
        <button class="btn btn-sm btn-danger" onclick="netRemoveReservation('${escHtml(name)}','${escHtml(h.mac)}')" title="Entfernen">&#10005;</button>
      </div>`).join('') || '<div style="color:var(--text-muted);font-size:12px;">Keine Reservierungen</div>'}</div>
    <div class="vmd-grid-3">
      <input id="net-r-mac-${escHtml(name)}" class="conn-input" placeholder="MAC 52:54:00:..">
      <input id="net-r-ip-${escHtml(name)}" class="conn-input" placeholder="IP-Adresse">
      <input id="net-r-host-${escHtml(name)}" class="conn-input" placeholder="Hostname (opt.)">
    </div>
    <button class="btn btn-primary btn-sm" style="margin-top:8px;" onclick="netAddReservation('${escHtml(name)}')">+ Reservierung</button>`;
}

async function netAddReservation(name) {
  const g = id => document.getElementById(id)?.value.trim() || '';
  const r = await api('/api/network/dhcp-host/add', { method:'POST', body: JSON.stringify({
    name, mac: g('net-r-mac-'+name), ip: g('net-r-ip-'+name), hostname: g('net-r-host-'+name) }) });
  if (r.error) { toast('Fehler: '+r.error,'error',8000); return; }
  toast('Reservierung hinzugefügt','success');
  _netRenderRes(name); loadNetworks();
}

async function netRemoveReservation(name, mac) {
  if (!(await uiConfirm('Reservierung entfernen?\n' + mac, {danger:true, okLabel:'Entfernen'}))) return;
  const r = await api('/api/network/dhcp-host/remove', { method:'POST', body: JSON.stringify({ name, mac }) });
  if (r.error) { toast('Fehler: '+r.error,'error',8000); return; }
  toast('Reservierung entfernt','success');
  _netRenderRes(name); loadNetworks();
}

async function netAction(name, action) {
  if (action === 'delete' && !(await uiConfirm(`Netzwerk "${name}" löschen?`, {danger:true, okLabel:'Löschen'}))) return;
  const r = await api('/api/network/action', {
    method: 'POST',
    body: JSON.stringify({ name, action })
  });
  if (r.error) { alert('Fehler: ' + r.error); return; }
  loadNetworks();
}

function openNetCreateModal() {
  document.getElementById('nc-name').value = '';
  document.getElementById('nc-cidr').value = '';
  document.getElementById('nc-err').style.display = 'none';
  document.getElementById('nc-btn').textContent = 'Erstellen';
  document.getElementById('nc-btn').disabled = false;
  document.getElementById('net-create-modal').style.display = 'flex';
}
function closeNetCreateModal() {
  document.getElementById('net-create-modal').style.display = 'none';
}
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('net-create-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeNetCreateModal();
  });
});

async function createNetwork() {
  const errEl = document.getElementById('nc-err');
  const btn   = document.getElementById('nc-btn');
  errEl.style.display = 'none';
  const name = document.getElementById('nc-name').value.trim();
  const cidr = document.getElementById('nc-cidr').value.trim();
  if (!name || !cidr) { errEl.textContent = 'Name und IP CIDR erforderlich.'; errEl.style.display = 'block'; return; }
  btn.textContent = 'Erstelle...'; btn.disabled = true;
  const r = await api('/api/network/create', {
    method: 'POST',
    body: JSON.stringify({ name, ip_cidr: cidr, forward_mode: document.getElementById('nc-mode').value })
  });
  btn.textContent = 'Erstellen'; btn.disabled = false;
  if (r.error) { errEl.textContent = r.error; errEl.style.display = 'block'; return; }
  closeNetCreateModal();
  loadNetworks();
}

// ─── Storage Pools & Volumes ─────────────────────────

async function loadPools() {
  const d = await api('/api/storage/pools');
  const pools = d.pools || [];

  // Populate pool-select
  const sel = document.getElementById('pool-select');
  const cur = sel.value;
  sel.innerHTML = '<option value="">Pool waehlen...</option>' +
    pools.map(p => `<option value="${escHtml(p.name)}">${escHtml(p.name)}</option>`).join('');
  if (cur) sel.value = cur;

  // Render pool cards
  const container = document.getElementById('pool-list');
  if (!pools.length) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:12px;font-family:var(--font-mono);padding:8px;">Keine Storage Pools gefunden.</div>';
    return;
  }
  container.innerHTML = pools.map(p => `
    <div class="pool-card" onclick="document.getElementById('pool-select').value='${escHtml(p.name)}';loadVolumes('${escHtml(p.name)}')"
         style="cursor:pointer;" title="Klicken zum Anzeigen der Volumes">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <div style="font-weight:600;font-family:var(--font-mono);font-size:13px;">${escHtml(p.name)}</div>
        <span style="font-size:10px;padding:2px 7px;border-radius:20px;font-family:var(--font-mono);font-weight:600;
          ${p.active ? 'background:var(--accent-ghost);color:var(--accent)' : 'background:rgba(100,116,139,.15);color:#94a3b8'}">
          ${p.active ? 'aktiv' : 'inaktiv'}
        </span>
      </div>
      ${p.path ? `<div style="font-size:11px;font-family:var(--font-mono);color:var(--text-muted);margin-bottom:4px;">${escHtml(p.path)}</div>` : ''}
      <div style="font-size:11px;font-family:var(--font-mono);color:var(--text-secondary);">
        ${p.capacity ? 'Gesamt: ' + escHtml(p.capacity) + ' &bull; Frei: ' + escHtml(p.available) : ''}
      </div>
    </div>`).join('');
}

async function loadVolumes(pool) {
  const container = document.getElementById('vol-list');
  if (!pool) { container.innerHTML = ''; return; }
  container.innerHTML = '<div class="loading-overlay"><span class="spinner"></span></div>';
  const d = await api(`/api/storage/volumes?pool=${encodeURIComponent(pool)}`);
  const vols = d.volumes || [];
  if (!vols.length) {
    container.innerHTML = `<div style="color:var(--text-muted);font-size:12px;font-family:var(--font-mono);padding:10px;">Keine Volumes in Pool '${escHtml(pool)}'.</div>`;
    return;
  }
  container.innerHTML = `
    <div style="background:var(--bg-card);border:1px solid var(--border-dim);border-radius:var(--radius-md);overflow:hidden;">
      <div style="padding:10px 14px;border-bottom:1px solid var(--border-dim);font-size:11px;font-family:var(--font-mono);color:var(--text-muted);text-transform:uppercase;letter-spacing:.8px;">
        Volumes in Pool: ${escHtml(pool)}
      </div>
      ${vols.map(v => `
        <div class="vol-row">
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;color:var(--text-primary);">${escHtml(v.name)}</div>
            <div style="color:var(--text-muted);font-size:11px;overflow:hidden;text-overflow:ellipsis;">${escHtml(v.path)}</div>
          </div>
          <div style="color:var(--text-secondary);">${escHtml(v.type)}</div>
          <div style="color:var(--accent);">${escHtml(v.capacity)}</div>
          <button class="btn btn-sm btn-danger" onclick="deleteVolume('${escHtml(pool)}','${escHtml(v.name)}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
          </button>
        </div>`).join('')}
    </div>`;
}

function openVolCreateModal() {
  const pool = document.getElementById('pool-select').value;
  document.getElementById('volc-name').value = '';
  document.getElementById('volc-size').value = 10;
  document.getElementById('volc-pool').value = pool;
  document.getElementById('volc-err').style.display = 'none';
  document.getElementById('volc-btn').textContent = 'Erstellen';
  document.getElementById('volc-btn').disabled = false;
  document.getElementById('vol-create-modal').style.display = 'flex';
}
function closeVolCreateModal() {
  document.getElementById('vol-create-modal').style.display = 'none';
}
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('vol-create-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeVolCreateModal();
  });
});

async function createVolume() {
  const errEl = document.getElementById('volc-err');
  const btn   = document.getElementById('volc-btn');
  errEl.style.display = 'none';
  const pool = document.getElementById('volc-pool').value;
  const name = document.getElementById('volc-name').value.trim();
  if (!pool || !name) { errEl.textContent = 'Pool und Name erforderlich.'; errEl.style.display = 'block'; return; }
  btn.textContent = 'Erstelle...'; btn.disabled = true;
  const r = await api('/api/storage/volume/create', {
    method: 'POST',
    body: JSON.stringify({
      pool, vol_name: name,
      size_gib: parseInt(document.getElementById('volc-size').value) || 10,
      format: document.getElementById('volc-fmt').value,
    })
  });
  btn.textContent = 'Erstellen'; btn.disabled = false;
  if (r.error) { errEl.textContent = r.error; errEl.style.display = 'block'; return; }
  closeVolCreateModal();
  loadVolumes(pool);
}

async function deleteVolume(pool, name) {
  if (!(await uiConfirm(`Volume "${name}" in Pool "${pool}" wirklich löschen?`, {danger:true, okLabel:'Löschen'}))) return;
  const r = await api('/api/storage/volume/delete', {
    method: 'POST',
    body: JSON.stringify({ pool, vol_name: name })
  });
  if (r.error) { alert('Fehler: ' + r.error); return; }
  loadVolumes(pool);
}

// ─── ISO-Verwaltung ──────────────────────────────────
let _isoPoll = null;
function _fmtIsoSize(mb) { mb = mb || 0; return mb >= 1024 ? (mb/1024).toFixed(1)+' GiB' : mb+' MB'; }

async function loadIsos() {
  const el = document.getElementById('iso-list'); if (!el) return;
  if (!el.innerHTML) el.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:8px;"><span class="spinner"></span> Suche ISOs…</div>';
  const [r, dl] = await Promise.all([ api('/api/storage/iso/list'), api('/api/storage/iso/downloads') ]);
  const isos = r.isos || [];
  const downloads = (dl.downloads || []).filter(d => d.status !== 'done');
  const active = downloads.filter(d => d.status === 'downloading');
  let html = downloads.map(d => `
    <div class="iso-row" style="margin-bottom:6px;">
      <span class="iso-name">${escHtml(d.name)}</span>
      <span class="iso-status" style="color:${d.status==='error'?'var(--red)':'var(--amber)'}">${d.status==='downloading'?'⏳ lädt…':'✗ '+escHtml(d.error||'Fehler')}</span>
    </div>`).join('');
  html += isos.length ? '<div class="iso-list-grid">' + isos.map(i => `
    <div class="iso-row">
      <span class="iso-name">${escHtml(i.name)} <span class="iso-size">${_fmtIsoSize(i.size_mb)}</span></span>
      <span class="iso-path">${escHtml(i.path)}</span>
      <button class="btn btn-sm btn-danger iso-del" onclick="deleteIso('${escHtml(i.path)}','${escHtml(i.name)}')" title="ISO löschen">&#10005;</button>
    </div>`).join('') + '</div>'
    : '<div style="color:var(--text-muted);font-size:12px;padding:8px;">Keine ISOs gefunden.</div>';
  el.innerHTML = html;
  clearTimeout(_isoPoll);
  if (active.length) _isoPoll = setTimeout(loadIsos, 3000);
}

function openIsoModal() {
  document.getElementById('iso-url').value = '';
  document.getElementById('iso-fn').value = '';
  document.getElementById('iso-err').style.display = 'none';
  const b = document.getElementById('iso-btn'); b.disabled = false; b.textContent = 'Download starten';
  document.getElementById('iso-modal').style.display = 'flex';
}
function closeIsoModal() { document.getElementById('iso-modal').style.display = 'none'; }

async function startIsoDownload() {
  const url = document.getElementById('iso-url').value.trim();
  const fn  = document.getElementById('iso-fn').value.trim();
  const err = document.getElementById('iso-err'); err.style.display = 'none';
  if (!url) { err.textContent = 'URL erforderlich.'; err.style.display = 'block'; return; }
  const btn = document.getElementById('iso-btn'); btn.disabled = true; btn.textContent = 'Starte…';
  const r = await api('/api/storage/iso/download', { method:'POST', body: JSON.stringify({ url, filename: fn }) });
  btn.disabled = false; btn.textContent = 'Download starten';
  if (r.error) { err.textContent = r.error; err.style.display = 'block'; return; }
  toast('Download gestartet: ' + r.filename + ' — läuft im Hintergrund','success',6000);
  closeIsoModal(); loadIsos();
}

async function deleteIso(path, name) {
  if (!(await uiConfirm('ISO endgültig löschen?\n' + name, {danger:true, okLabel:'Löschen'}))) return;
  const r = await api('/api/storage/iso/delete', { method:'POST', body: JSON.stringify({ path }) });
  if (r.error) { toast('Fehler: ' + r.error,'error',7000); return; }
  toast('ISO gelöscht','success'); loadIsos();
}

// ─── Benutzerverwaltung ──────────────────────────────
let _editUser = null;

async function loadUsers() {
  const el = document.getElementById('users-list'); if (!el) return;
  el.innerHTML = '<div class="loading-overlay"><span class="spinner"></span> Lade Benutzer...</div>';
  const r = await api('/api/users');
  if (r.error) { el.innerHTML = `<div style="color:var(--red);font-size:13px;padding:12px;">${escHtml(r.error)}</div>`; return; }
  const users = r.users || [];
  el.innerHTML = '<div style="display:grid;gap:10px;max-width:780px;">' + users.map(u => `
    <div class="card" style="display:flex;align-items:center;gap:14px;margin-bottom:0;padding:14px 16px;">
      <div style="width:40px;height:40px;border-radius:50%;background:${u.is_admin?'var(--accent-ghost)':'var(--bg-elevated)'};display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">${u.is_admin?'&#128081;':'&#128100;'}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;font-family:var(--font-mono);">${escHtml(u.username)}
          ${u.is_admin?'<span style="color:var(--accent);font-size:10px;background:var(--accent-ghost);padding:1px 6px;border-radius:4px;margin-left:6px;">Admin</span>':''}
          ${u.locked?'<span style="color:var(--amber);font-size:10px;background:var(--amber-glow,rgba(245,158,11,.15));padding:1px 6px;border-radius:4px;margin-left:4px;">gesperrt</span>':''}
          ${u.username===window._userName?'<span style="color:var(--text-muted);font-size:10px;margin-left:4px;">(Sie)</span>':''}
        </div>
        <div style="color:var(--text-muted);font-size:11px;font-family:var(--font-mono);">UID ${Number(u.uid)||0} &middot; ${escHtml(u.shell||'')}</div>
      </div>
      <button class="btn btn-sm" onclick="openUserModal('${escHtml(u.username)}', ${u.is_admin?'true':'false'}, '${escHtml(u.shell||'/bin/bash')}')">Bearbeiten</button>
      ${(!u.system && u.username!==window._userName) ? `<button class="btn btn-sm btn-danger" onclick="delUser('${escHtml(u.username)}')">L&#246;schen</button>` : ''}
    </div>`).join('') + '</div>';
}

function openUserModal(username, isAdmin, shell) {
  _editUser = username || null;
  document.getElementById('user-modal-title').textContent = _editUser ? ('Benutzer bearbeiten: ' + _editUser) : 'Benutzer erstellen';
  const nameInp = document.getElementById('usr-name');
  nameInp.value = _editUser || ''; nameInp.disabled = !!_editUser;
  document.getElementById('usr-pw').value = '';
  document.getElementById('usr-pw-label').textContent = _editUser ? 'Neues Passwort (leer = unverändert)' : 'Passwort';
  const shellSel = document.getElementById('usr-shell');
  shellSel.value = shell || '/bin/bash';
  shellSel.parentElement.style.display = _editUser ? 'none' : 'block';  // Shell nur beim Anlegen
  document.getElementById('usr-admin').checked = !!isAdmin;
  document.getElementById('usr-err').style.display = 'none';
  const btn = document.getElementById('usr-btn');
  btn.textContent = _editUser ? 'Speichern' : 'Erstellen'; btn.disabled = false;
  document.getElementById('user-modal').style.display = 'flex';
}
function closeUserModal() { document.getElementById('user-modal').style.display = 'none'; }

async function saveUser() {
  const err = document.getElementById('usr-err'); err.style.display = 'none';
  const name = document.getElementById('usr-name').value.trim();
  const pw = document.getElementById('usr-pw').value;
  const isAdmin = document.getElementById('usr-admin').checked;
  const btn = document.getElementById('usr-btn');
  if (!name) { err.textContent = 'Benutzername erforderlich'; err.style.display = 'block'; return; }
  btn.disabled = true; btn.textContent = '…';
  let r;
  if (_editUser) {
    const body = { username: _editUser, is_admin: isAdmin };
    if (pw) body.password = pw;
    r = await api('/api/user/update', { method:'POST', body: JSON.stringify(body) });
  } else {
    if (!pw) { err.textContent = 'Passwort erforderlich'; err.style.display = 'block'; btn.disabled = false; btn.textContent = 'Erstellen'; return; }
    r = await api('/api/user/create', { method:'POST', body: JSON.stringify({ username: name, password: pw, is_admin: isAdmin, shell: document.getElementById('usr-shell').value }) });
  }
  btn.disabled = false; btn.textContent = _editUser ? 'Speichern' : 'Erstellen';
  if (r.error) { err.textContent = r.error; err.style.display = 'block'; return; }
  toast(_editUser ? 'Benutzer gespeichert' : 'Benutzer erstellt', 'success');
  closeUserModal(); loadUsers();
}

async function delUser(name) {
  if (!(await uiConfirm(`Benutzer "${name}" wirklich löschen?\n\nDas Home-Verzeichnis wird mit entfernt.`, {danger:true, okLabel:'Löschen'}))) return;
  const r = await api('/api/user/delete', { method:'POST', body: JSON.stringify({ username: name, remove_home: true }) });
  if (r.error) { toast('Fehler: '+r.error,'error',7000); return; }
  toast('Benutzer gelöscht','success'); loadUsers();
}

// ─── VM Console (VNC / SPICE via websockify) ────────

async function openConsole(btn, name, type) {
  const origContent = btn.innerHTML;
  btn.innerHTML = '<span class="spinner"></span>';
  btn.disabled = true;

  // Fenster SYNCHRON (noch in der User-Geste) öffnen — sonst blockieren Browser,
  // besonders iOS-Safari, das window.open nach dem await.
  const win = window.open('', '_blank');

  const data = await api(`/api/vm/console?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`);

  btn.innerHTML = origContent;
  btn.disabled = false;

  if (data.error) {
    if (win) win.close();
    alert(`Konsolen-Fehler (${type.toUpperCase()}): ${data.error}`);
    return;
  }
  if (data.notice) toast(data.notice, 'info');

  if (win) win.location = data.url;
  else window.location.href = data.url;   // Popup blockiert → selber Tab als Fallback
}

// ─── Services ───────────────────────────────────────

let allServices = [];

async function loadServices() {
  const list = document.getElementById('service-list');
  list.innerHTML = '<div class="loading-overlay"><span class="spinner"></span> Lade Services...</div>';

  const data = await api('/api/services');

  // Handle error object (systemd not reachable)
  if (data && !Array.isArray(data) && data.error) {
    list.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <p>${data.error}</p>
      </div>`;
    return;
  }

  allServices = Array.isArray(data) ? data : [];
  renderServices(allServices);
}

function renderServices(services) {
  const list = document.getElementById('service-list');
  
  if (services.length === 0) {
    list.innerHTML = '<div class="empty-state"><p>Keine Services gefunden.</p></div>';
    return;
  }
  
  list.innerHTML = services.map(s => {
    const dotClass = s.active === 'active' ? 'active' : s.sub === 'failed' ? 'failed' : 'inactive';
    return `
      <div class="service-row">
        <div class="service-status-dot ${dotClass}"></div>
        <div class="service-name">${escHtml(s.name)}</div>
        <div class="service-desc">${escHtml(s.description || '—')}</div>
        <div class="service-actions">
          ${s.active !== 'active' ? `<button class="btn btn-sm" onclick="serviceAction('${escHtml(s.name)}','start')">Start</button>` : ''}
          ${s.active === 'active' ? `<button class="btn btn-sm" onclick="serviceAction('${escHtml(s.name)}','stop')">Stop</button>` : ''}
          <button class="btn btn-sm" onclick="serviceAction('${escHtml(s.name)}','restart')">Restart</button>
        </div>
      </div>
    `;
  }).join('');
}

async function serviceAction(name, action) {
  const result = await api('/api/service/action', {
    method: 'POST',
    body: JSON.stringify({ name: name + '.service', action })
  });
  
  if (result.success) {
    setTimeout(loadServices, 1000);
  } else {
    alert(`Fehler: ${result.error || result.output || 'Unbekannt'}`);
  }
}

// Service search
document.addEventListener('DOMContentLoaded', () => {
  const searchInput = document.getElementById('service-search');
  searchInput.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    const filtered = allServices.filter(s => 
      s.name.toLowerCase().includes(q) || 
      (s.description || '').toLowerCase().includes(q)
    );
    renderServices(filtered);
  });
});

// ─── Connections ────────────────────────────────────

let _selectedProto = 'ssh';
const PROTO_PORTS = { ssh:22, vnc:5900, spice:5900, rdp:3389, scp:22 };
const PROTO_SHOW_AUTH = new Set(['ssh','scp']);

function selectProto(p) {
  _selectedProto = p;
  document.querySelectorAll('.proto-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.proto === p);
  });
  document.getElementById('conn-port').value = PROTO_PORTS[p] || 22;
  document.getElementById('conn-auth').style.display = PROTO_SHOW_AUTH.has(p) ? 'grid' : 'none';
}

function openConnModal() {
  selectProto('ssh');
  document.getElementById('conn-label').value = '';
  document.getElementById('conn-host').value  = '';
  document.getElementById('conn-port').value  = '22';
  document.getElementById('conn-user').value  = '';
  document.getElementById('conn-pass').value  = '';
  document.getElementById('conn-key').value   = '';
  document.getElementById('conn-keypass').value = '';
  document.getElementById('conn-usedef').checked = false;
  document.getElementById('conn-err').style.display = 'none';
  document.getElementById('conn-modal').style.display = 'flex';
}
function closeConnModal() {
  document.getElementById('conn-modal').style.display = 'none';
}
document.getElementById('conn-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeConnModal();
});

async function saveConn() {
  const errEl = document.getElementById('conn-err');
  errEl.style.display = 'none';
  const host = document.getElementById('conn-host').value.trim();
  const port = document.getElementById('conn-port').value;
  if (!host || !port) { errEl.textContent = 'Host und Port sind erforderlich.'; errEl.style.display = 'block'; return; }
  const body = {
    proto:    _selectedProto,
    host,
    port:     parseInt(port),
    username: document.getElementById('conn-user').value.trim(),
    password: document.getElementById('conn-pass').value,
    label:    document.getElementById('conn-label').value.trim(),
  };
  if (PROTO_SHOW_AUTH.has(_selectedProto)) {
    body.private_key = document.getElementById('conn-key').value.trim();
    body.passphrase  = document.getElementById('conn-keypass').value;
    body.use_default = document.getElementById('conn-usedef').checked;
    if (!body.use_default && !body.username) { errEl.textContent = 'Benutzername fehlt (oder Standard-Zugangsdaten verwenden).'; errEl.style.display = 'block'; return; }
    if (!body.use_default && !body.password && !body.private_key) { errEl.textContent = 'Passwort oder Schlüssel angeben (oder Standard-Zugangsdaten verwenden).'; errEl.style.display = 'block'; return; }
  }
  const r = await api('/api/ext/save', { method: 'POST', body: JSON.stringify(body) });
  if (r.error) { errEl.textContent = r.error; errEl.style.display = 'block'; return; }
  closeConnModal();
  loadConnections();
}

async function loadConnections() {
  const grid = document.getElementById('conn-grid');
  grid.innerHTML = '<div class="loading-overlay"><span class="spinner"></span> Lade Verbindungen...</div>';
  const r = await api('/api/ext/list');
  const conns = r.connections || [];
  if (!conns.length) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:48px;height:48px"><path d="M4 12h16"/><circle cx="20" cy="12" r="2"/><circle cx="4" cy="12" r="2"/></svg>
        <p>Noch keine Verbindungen gespeichert.<br>Klicke auf <strong>Neue Verbindung</strong>.</p>
      </div>`;
    return;
  }
  grid.innerHTML = conns.map(c => `
    <div class="conn-card">
      <span class="conn-badge conn-badge-${c.proto}">${c.proto.toUpperCase()}</span>
      ${isSuperadmin() && c.owner && c.owner !== window._userName ? `<span class="owner-badge">${escHtml(c.owner)}</span>` : ''}
      <div style="font-weight:600;margin-bottom:4px;font-size:14px;">${escHtml(c.label)}</div>
      <div style="font-family:var(--font-mono);font-size:12px;color:var(--text-secondary);margin-bottom:14px;">
        <span class="conn-status-dot ${c.status === 'connected' ? 'connected' : 'idle'}"></span>
        ${escHtml(c.host)}:${c.port}
        ${c.username ? ' · ' + escHtml(c.username) : ''}
      </div>
      ${(c.proto === 'ssh' || c.proto === 'scp') ? `<div class="conn-auth-tags">${c.has_key ? '<span>🔑 Schlüssel</span>' : ''}${c.has_password ? '<span>Passwort</span>' : ''}${c.use_default ? '<span>Standard-Zugang</span>' : ''}</div>` : ''}
      <div style="display:flex;gap:8px;">
        <button class="btn btn-primary" style="flex:1;justify-content:center;" onclick="openConn('${c.id}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          Öffnen
        </button>
        <button class="btn btn-danger" onclick="deleteConn('${c.id}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
        </button>
      </div>
    </div>
  `).join('');
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/`/g,'&#96;');
}

async function openConn(id) {
  const r = await api('/api/ext/connect', { method: 'POST', body: JSON.stringify({ id }) });
  if (r.error) { alert('Fehler: ' + r.error); return; }
  window.open(r.url, '_blank');
  setTimeout(loadConnections, 1500);
}

async function deleteConn(id) {
  if (!(await uiConfirm('Verbindung löschen?', {danger:true, okLabel:'Löschen'}))) return;
  await api('/api/ext/delete', { method: 'POST', body: JSON.stringify({ id }) });
  loadConnections();
}

// ─── Browser Sessions ───────────────────────────────

let _selectedBrowserImg = 'firefox';

function selectBrowserImg(key) {
  _selectedBrowserImg = key;
  document.querySelectorAll('#browser-img-btns .proto-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.img === key);
  });
}

function openBrowserModal() {
  const modal = document.getElementById('browser-modal');
  modal.style.display = 'flex';
  document.getElementById('browser-label').value = '';
  document.getElementById('browser-audio').checked = false;
  document.getElementById('browser-err').style.display = 'none';
  const btn = document.getElementById('browser-start-btn');
  btn.textContent = 'Session starten';
  btn.disabled = false;
}

function closeBrowserModal() {
  document.getElementById('browser-modal').style.display = 'none';
}

async function startBrowser() {
  const errEl = document.getElementById('browser-err');
  const btn   = document.getElementById('browser-start-btn');
  errEl.style.display = 'none';
  btn.textContent = 'Wird gestartet…';
  btn.disabled = true;

  const r = await api('/api/browser/start', {
    method: 'POST',
    body: JSON.stringify({
      image: _selectedBrowserImg,
      label: document.getElementById('browser-label').value.trim(),
      audio: document.getElementById('browser-audio').checked,
    }),
  });

  btn.textContent = 'Session starten';
  btn.disabled = false;

  if (r.error) {
    errEl.textContent = r.error;
    errEl.style.display = 'block';
    return;
  }
  closeBrowserModal();
  if (r.session && r.session.url) {
    window.open(r.session.url, '_blank');
  }
  loadBrowserSessions();
}

let _pendingStopId = null;
function stopBrowser(id) {
  _pendingStopId = id;
  document.getElementById('stop-browser-modal').style.display = 'flex';
}
async function _doStopBrowser() {
  document.getElementById('stop-browser-modal').style.display = 'none';
  const btn = document.getElementById('stop-browser-confirm-btn');
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  await api('/api/browser/stop', { method: 'POST', body: JSON.stringify({ id: _pendingStopId }) });
  if (btn) { btn.disabled = false; btn.textContent = 'Ja, beenden'; }
  loadBrowserSessions();
}

// Leerlaufzeit menschenlesbar: „3 min", „1 std 12 min"
function fmtIdle(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  if (sec < 60) return sec + ' s';
  const m = Math.floor(sec / 60);
  if (m < 60) return m + ' min';
  return Math.floor(m / 60) + ' std ' + (m % 60) + ' min';
}

// Session manuell einfrieren bzw. auftauen (Automatik läuft unabhängig weiter).
async function toggleBrowserPause(id, pause) {
  const r = await api(pause ? '/api/browser/pause' : '/api/browser/resume', {
    method: 'POST',
    body: JSON.stringify({ id }),
  });
  if (r.error) toast(r.error, 'error');
  loadBrowserSessions();
}

let _browserSig = '';
async function loadBrowserSessions(silent) {
  const grid = document.getElementById('browser-grid');
  if (!silent) {
    grid.innerHTML = '<div class="loading-overlay"><span class="spinner"></span> Lade Sessions...</div>';
    _browserSig = '';
  }
  const r = await api('/api/browser/list');
  const sessions = r.sessions || [];
  if (!sessions.length) {
    _browserSig = 'empty';
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:48px;height:48px"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/><path d="M2 7h20"/></svg>
        <p>Keine aktiven Browser-Sessions.<br>Klicke auf <strong>Neue Session</strong>.</p>
      </div>`;
    return;
  }
  // Beim stillen Aktualisieren nur neu zeichnen, wenn sich wirklich etwas
  // geändert hat — sonst flackert die Ansicht und Klicks gehen verloren.
  const sig = sessions.map(s => [s.id, s.status, Math.floor((s.idle_seconds || 0) / 30)].join(':')).join('|');
  if (silent && sig === _browserSig) return;
  _browserSig = sig;

  const pauseMin = sessions[0] && sessions[0].pause_after_min;
  const hint = document.getElementById('browser-idle-hint');
  if (hint) {
    hint.textContent = pauseMin
      ? `Unbenutzte Sessions werden nach ${pauseMin} min automatisch eingefroren (Zustand bleibt erhalten) und beim Öffnen fortgesetzt.`
      : 'Automatische Pause ist deaktiviert.';
  }

  grid.innerHTML = sessions.map(s => {
    const paused = s.status === 'paused';
    return `
    <div class="browser-card"${paused ? ' style="opacity:.75"' : ''}>
      <span class="browser-badge">
        ${s.image_key === 'firefox' ? '🦊' : s.image_key === 'chromium' ? '🔵' : '🌐'}
        ${escHtml(s.image_key.toUpperCase())}
      </span>
      ${isSuperadmin() && s.owner && s.owner !== window._userName ? `<span class="owner-badge">${escHtml(s.owner)}</span>` : ''}
      ${!isSuperadmin() && s.owner && s.owner !== window._userName ? `<span class="owner-badge" title="Freigegeben von ${escHtml(s.owner)}">&#128065; ${escHtml(s.owner)}</span>` : ''}
      <div style="font-weight:600;margin-bottom:4px;font-size:14px;">${escHtml(s.label)}</div>
      <div style="font-family:var(--font-mono);font-size:12px;color:var(--text-secondary);margin-bottom:6px;">
        <span class="conn-status-dot ${paused ? '' : 'connected'}"${paused ? ' style="background:var(--amber);box-shadow:none"' : ''}></span>
        ${escHtml(s.image)}
      </div>
      <div style="font-family:var(--font-mono);font-size:11px;margin-bottom:14px;color:${paused ? 'var(--amber)' : 'var(--text-secondary)'};">
        ${paused
          ? `⏸ Eingefroren${s.paused_auto ? ' (Leerlauf)' : ''} — 0 % CPU, Zustand gespeichert`
          : (s.pause_after_min
              ? `▶ Aktiv · ${fmtIdle(s.idle_seconds)} unbenutzt · Pause in ${fmtIdle(s.pause_in_seconds)}`
              : '▶ Aktiv')}
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-primary" style="flex:1;justify-content:center;" ${s.url ? `onclick="window.open('${escHtml(s.url)}','_blank')"` : 'disabled'}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          ${paused ? 'Fortsetzen' : 'Öffnen'}
        </button>
        <button class="btn" onclick="toggleBrowserPause('${s.id}',${paused ? 'false' : 'true'})" style="min-width:44px;justify-content:center;" title="${paused ? 'Session auftauen' : 'Session jetzt einfrieren (CPU sparen)'}">
          ${paused
            ? '<svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'}
        </button>
        ${isSuperadmin() ? `<button class="btn" onclick="openBrowserAccess('${s.id}', this)" data-viewers="${escHtml(JSON.stringify(s.viewers || []))}" style="min-width:44px;justify-content:center;" title="Sichtbar für andere Benutzer${(s.viewers||[]).length ? ': ' + escHtml(s.viewers.join(', ')) : ''}">&#128101;${(s.viewers||[]).length ? ' ' + s.viewers.length : ''}</button>` : ''}
        ${isSuperadmin() || s.owner === window._userName ? `<button class="btn btn-danger" onclick="stopBrowser('${s.id}')" style="min-width:80px;justify-content:center;gap:5px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
          Beenden
        </button>` : ''}
      </div>
    </div>
  `;
  }).join('');
}

// ─── Auto-Refresh ───────────────────────────────────

function startAutoRefresh() {
  loadDashboard();
  refreshInterval = setInterval(() => {
    if (currentPage === 'dashboard') {
      loadDashboard();
    } else if (currentPage === 'browser') {
      // Still aktualisieren: zeigt Leerlaufzeit und automatisch eingefrorene
      // Sessions, zeichnet aber nur bei echter Änderung neu (kein Flackern).
      loadBrowserSessions(true);
    }
  }, 5000);
}

// ─── Init ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  startAutoRefresh();
  // (old settings modal CPU calculator removed)
  // VM grid event delegation
  const vmGrid = document.getElementById('vm-grid');
  if (vmGrid) {
    vmGrid.addEventListener('click', e => {
      const btn = e.target.closest('.vm-act-btn, [data-act="settings"]');
      if (btn) {
        e.stopPropagation();
        const name = btn.dataset.vm;
        const act  = btn.dataset.act;
        if (act === 'settings' || !act) { openVMDetail(name); return; }
        if (act === 'vnc')     { openConsoleByName(name, 'vnc',     e); return; }
        if (act === 'spice')   { openConsoleByName(name, 'spice',   e); return; }
        if (act === 'kasmvnc') { openConsoleByName(name, 'kasmvnc', e); return; }
        if (act === 'console') { openConsoleByName(name, 'auto',    e); return; }
        doVmAction(name, act, btn);
        return;
      }
      const card = e.target.closest('.vm-card[data-vm]');
      if (card) openVMDetail(card.dataset.vm);
    });
  }
});

async function openConsoleByName(name, type, e) {
  const btn = e ? e.target.closest('button') : null;
  if (btn) { btn.disabled = true; const orig = btn.innerHTML; btn.innerHTML = '&#9203;'; setTimeout(()=>{btn.disabled=false;btn.innerHTML=orig;},3000); }
  const win = window.open('', '_blank');   // synchron öffnen (Popup-Blocker/iOS)
  const data = await api(`/api/vm/console?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type||'auto')}`);
  if (data.error) { if (win) win.close(); toast('Fehler: '+data.error,'error'); return; }
  if (data.notice) toast(data.notice, 'info');
  if (win) win.location = data.url;
  else window.location.href = data.url;
}

// ─── Docker-Verwaltung ──────────────────────────────
// Der Reiter ist admin-only (siehe _ADMIN_PAGES und das Prefix-Gate in
// dashboard/handler.py). showPage() räumt nichts auf, deshalb hält dieser
// Abschnitt seine Timer/WebSockets selbst im Griff — Einstiegspunkt für den
// Abbau ist stopDocker(), zusätzlich sichert sich jeder Poller selbst ab.

let _dkTab        = 'containers';
let _dkFilter     = 'all';
let _dkImgFilter  = 'all';
let _dkAuto       = true;
let _dkListTimer  = null;
let _dkStatsTimer = null;
let _dkEventsTimer= null;
let _dkJobTimer   = null;
let _dkLogWs      = null;
let _dkConWs      = null;
let _dkDetailId   = null;
let _dkDetailTab  = 'overview';
let _dkDetail     = null;
const _dkCache    = { containers: [], images: [], networks: [], volumes: [], stacks: [], system: null };

function stopDocker() {
  for (const t of [_dkListTimer, _dkStatsTimer, _dkEventsTimer, _dkJobTimer]) {
    if (t) clearTimeout(t);
  }
  _dkListTimer = _dkStatsTimer = _dkEventsTimer = _dkJobTimer = null;
  for (const ws of [_dkLogWs, _dkConWs]) {
    try { if (ws) ws.close(); } catch (_) {}
  }
  _dkLogWs = _dkConWs = null;
}

// Beim Schließen/Verstecken des Tabs sofort abbauen, damit die Server-Threads
// nicht erst in einen TCP-Timeout laufen.
window.addEventListener('pagehide', stopDocker);

// ─── Docker: Hilfsfunktionen ───────────────────────

function dkAge(unixSec) {
  if (!unixSec) return '—';
  let s = Math.max(0, Math.floor(Date.now() / 1000 - unixSec));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'min';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  const d = Math.floor(s / 86400);
  if (d < 60) return d + 'd';
  return Math.floor(d / 30) + 'mon';
}

function dkStateClass(state) {
  if (state === 'running') return 'running';
  if (state === 'paused') return 'paused';
  if (state === 'restarting' || state === 'removing') return 'paused';
  if (state === 'dead') return 'crashed';
  return 'shut';
}

function dkHealthBadge(h) {
  if (!h) return '';
  const cls = h === 'healthy' ? 'badge-green' : h === 'starting' ? 'badge-amber' : 'badge-red';
  return `<span class="card-badge ${cls}">${escHtml(h)}</span>`;
}

// Schutz-/Verwaltungs-Kennzeichen einer Container-Karte
function dkFlags(c) {
  let out = '';
  if (c.protected) out += '<span class="card-badge badge-amber" title="Das Dashboard selbst — kann hier nicht ver&#228;ndert werden">&#128274; gesch&#252;tzt</span> ';
  if (c.critical)  out += '<span class="card-badge badge-red" title="Kritisch f&#252;r die Erreichbarkeit des Dashboards">&#9888; kritisch</span> ';
  if (c.managed === 'browser') out += '<span class="card-badge badge-cyan" title="Vom Dashboard verwaltete Browser-Session">vom Dashboard verwaltet</span> ';
  return out;
}

function dkEmpty(msg) {
  return `<div class="dk-empty">${escHtml(msg)}</div>`;
}

function dkErr(msg) {
  return `<div class="dk-empty" style="color:var(--red)">${escHtml(msg)}</div>`;
}

// Nur laden, wenn der Docker-Reiter auch wirklich noch sichtbar ist.
function dkOnPage(tab) {
  if (currentPage !== 'docker') return false;
  return !tab || _dkTab === tab;
}

// ─── Docker: Seiten- und Tabsteuerung ──────────────

function dkSwitchTab(tab) {
  // Poller des vorherigen Tabs beenden — sonst laufen Stats und Ereignisse
  // parallel weiter, obwohl ihr Ziel gar nicht mehr sichtbar ist.
  if (_dkStatsTimer) { clearTimeout(_dkStatsTimer); _dkStatsTimer = null; }
  if (_dkJobTimer)   { clearTimeout(_dkJobTimer);   _dkJobTimer = null; }
  _dkTab = tab;
  ['containers', 'images', 'networks', 'volumes', 'stacks', 'system'].forEach(t => {
    const p = document.getElementById(`dktab-${t}`);
    const b = document.getElementById(`dkt-${t}`);
    if (p) p.style.display = t === tab ? 'block' : 'none';
    if (b) b.classList.toggle('active', t === tab);
  });
  if (_dkListTimer) { clearTimeout(_dkListTimer); _dkListTimer = null; }
  loadDocker(true);
}

function dkToggleAuto() {
  _dkAuto = !_dkAuto;
  const b = document.getElementById('dk-auto-btn');
  if (b) b.innerHTML = _dkAuto ? '&#9210; Auto: an' : '&#9210; Auto: aus';
  if (_dkListTimer) { clearTimeout(_dkListTimer); _dkListTimer = null; }
  if (_dkAuto) loadDocker();
}

function dkSetFilter(f) {
  _dkFilter = f;
  ['all', 'running', 'stopped'].forEach(x => {
    const b = document.getElementById(`dk-cf-${x}`);
    if (b) b.classList.toggle('active', x === f);
  });
  dkRenderContainers();
}

function dkSetImgFilter(f) {
  _dkImgFilter = f;
  ['all', 'unused', 'dangling'].forEach(x => {
    const b = document.getElementById(`dk-if-${x}`);
    if (b) b.classList.toggle('active', x === f);
  });
  dkRenderImages();
}

async function loadDocker(force) {
  if (currentPage !== 'docker') return;
  if (force && _dkListTimer) { clearTimeout(_dkListTimer); _dkListTimer = null; }
  const tab = _dkTab;
  if (tab === 'containers')    await dkLoadContainers();
  else if (tab === 'images')   await dkLoadImages();
  else if (tab === 'networks') await dkLoadNetworks();
  else if (tab === 'volumes')  await dkLoadVolumes();
  else if (tab === 'stacks')   await dkLoadStacks();
  else if (tab === 'system')   await dkLoadSystem();

  if (!_dkCache.system) dkLoadFooterVersion();

  // Nur Container und Stacks ändern sich von allein — Images/Volumes/Netze
  // pollen wäre reine Last ohne Nutzen.
  if (_dkAuto && dkOnPage() && (tab === 'containers' || tab === 'stacks')) {
    if (_dkListTimer) clearTimeout(_dkListTimer);
    _dkListTimer = setTimeout(() => {
      if (dkOnPage(tab)) loadDocker();
    }, 5000);
  }
}

async function dkLoadFooterVersion() {
  const d = await api('/api/docker/system');
  if (d && !d.error) {
    _dkCache.system = d;
    const f = document.getElementById('docker-version-foot');
    if (f) f.textContent = d.tab_version || '?';
  }
}

// ─── Docker: Container ─────────────────────────────

async function dkLoadContainers() {
  const el = document.getElementById('dk-container-list');
  if (!el) return;
  if (!_dkCache.containers.length) {
    el.innerHTML = '<div class="loading-overlay"><span class="spinner"></span> Lade Container...</div>';
  }
  const d = await api('/api/docker/containers');
  if (!dkOnPage('containers')) return;
  if (d.error) { el.innerHTML = dkErr(d.error); return; }
  _dkCache.containers = d.containers || [];
  dkRenderContainers();
  dkStartStats();
}

function dkRenderContainers() {
  const el = document.getElementById('dk-container-list');
  if (!el) return;
  const q = (document.getElementById('dk-c-search')?.value || '').toLowerCase().trim();
  let list = _dkCache.containers;
  // Pausiert zählt zu „Laufend" — der Container existiert und belegt
  // Ressourcen; unter „Gestoppt" wäre er irreführend einsortiert.
  if (_dkFilter === 'running') list = list.filter(c => c.state === 'running' || c.state === 'paused');
  if (_dkFilter === 'stopped') list = list.filter(c => c.state !== 'running' && c.state !== 'paused');
  if (q) list = list.filter(c =>
    (c.name + ' ' + c.image + ' ' + c.project + ' ' + c.short_id).toLowerCase().includes(q));

  if (!list.length) { el.innerHTML = dkEmpty('Keine Container gefunden.'); return; }

  el.innerHTML = '<div class="dk-grid">' + list.map(c => {
    const up = c.state === 'running' && c.started ? dkAge(c.started) : '';
    return `
    <div class="dk-card${c.protected ? ' dk-protected' : ''}" data-dk-id="${escHtml(c.id)}">
      <div class="dk-card-head">
        <div class="dk-name" title="${escHtml(c.name)}">${escHtml(c.name)}</div>
        <span class="vm-state ${dkStateClass(c.state)}">${escHtml(c.state)}</span>
      </div>
      <div style="margin-bottom:6px;">${dkFlags(c)}${dkHealthBadge(c.health)}</div>
      <div class="dk-meta">
        <div class="dk-meta-row"><span class="dk-meta-key">Image</span><span class="dk-meta-val" title="${escHtml(c.image)}">${escHtml(c.image)}</span></div>
        <div class="dk-meta-row"><span class="dk-meta-key">Id</span><span class="dk-meta-val">${escHtml(c.short_id)}</span></div>
        <div class="dk-meta-row"><span class="dk-meta-key">Status</span><span class="dk-meta-val">${escHtml(c.status)}${up ? ' &bull; seit ' + escHtml(up) : ''}</span></div>
        <div class="dk-meta-row"><span class="dk-meta-key">Neustart</span><span class="dk-meta-val">${escHtml(c.restart || 'no')}</span></div>
        ${c.project ? `<div class="dk-meta-row"><span class="dk-meta-key">Stack</span><span class="dk-meta-val">${escHtml(c.project)}${c.service ? ' / ' + escHtml(c.service) : ''}</span></div>` : ''}
      </div>
      ${c.ports.length ? `<div class="dk-ports">${c.ports.map(p => `<span class="dk-port">${escHtml(p)}</span>`).join('')}</div>` : ''}
      <div class="dk-bars" id="dk-bars-${escHtml(c.short_id)}"></div>
      <div class="dk-actions">
        ${(c.state === 'running' || c.state === 'paused')
          ? `<button class="btn btn-sm btn-danger" onclick="dkAction('${escHtml(c.id)}','stop',this)">&#9209; Stop</button>`
          : `<button class="btn btn-sm btn-primary" onclick="dkAction('${escHtml(c.id)}','start',this)">&#9654; Start</button>`}
        ${c.state === 'running' ? `<button class="btn btn-sm" onclick="dkAction('${escHtml(c.id)}','restart',this)" title="Neustart">&#8635;</button>` : ''}
        ${c.state === 'running' ? `<button class="btn btn-sm" onclick="dkAction('${escHtml(c.id)}','pause',this)" title="Pausieren">&#10074;&#10074;</button>` : ''}
        ${c.state === 'paused' ? `<button class="btn btn-sm" onclick="dkAction('${escHtml(c.id)}','unpause',this)" title="Fortsetzen">&#9654;&#9654;</button>` : ''}
        <span class="dk-spacer"></span>
        <button class="btn btn-sm" onclick="openDockerDetail('${escHtml(c.id)}')">Details</button>
      </div>
    </div>`;
  }).join('') + '</div>';
}

// ─── Docker: Images ────────────────────────────────

async function dkLoadImages() {
  const el = document.getElementById('dk-image-list');
  if (!el) return;
  el.innerHTML = '<div class="loading-overlay"><span class="spinner"></span> Lade Images...</div>';
  const d = await api('/api/docker/images');
  if (!dkOnPage('images')) return;
  if (d.error) { el.innerHTML = dkErr(d.error); return; }
  _dkCache.images = d.images || [];
  dkRenderImages();
}

function dkRenderImages() {
  const el = document.getElementById('dk-image-list');
  if (!el) return;
  const q = (document.getElementById('dk-i-search')?.value || '').toLowerCase().trim();
  let list = _dkCache.images;
  if (_dkImgFilter === 'unused')   list = list.filter(i => !i.containers);
  if (_dkImgFilter === 'dangling') list = list.filter(i => i.dangling);
  if (q) list = list.filter(i => (i.tags.join(' ') + ' ' + i.short_id).toLowerCase().includes(q));

  const total = list.reduce((a, i) => a + (i.size || 0), 0);
  if (!list.length) { el.innerHTML = dkEmpty('Keine Images gefunden.'); return; }

  el.innerHTML =
    `<div class="dk-empty">${list.length} ${list.length === 1 ? 'Image' : 'Images'} &bull; ${formatBytes(total)}</div>` +
    '<div class="dk-list">' + list.map(i => {
      const tag = i.tags.length ? i.tags[0] : '&lt;none&gt;:&lt;none&gt;';
      const more = i.tags.length > 1 ? ` +${i.tags.length - 1}` : '';
      return `
      <div class="dk-row">
        <span class="dk-row-main" title="${escHtml(i.tags.join(', '))}">${i.tags.length ? escHtml(tag) : tag}${more}</span>
        <span class="dk-row-sub">${escHtml(i.short_id)}</span>
        <span class="dk-row-sub">${formatBytes(i.size)}</span>
        <span class="dk-row-sub">${dkAge(i.created)}</span>
        <span class="dk-row-sub">${i.containers ? i.containers + '&times; genutzt' : 'ungenutzt'}</span>
        <span class="dk-row-act">
          <button class="btn btn-sm" onclick="dkImageDetail('${escHtml(i.id)}')">Details</button>
        </span>
      </div>`;
    }).join('') + '</div>';
}

// ─── Docker: Netzwerke ─────────────────────────────

async function dkLoadNetworks() {
  const el = document.getElementById('dk-network-list');
  if (!el) return;
  el.innerHTML = '<div class="loading-overlay"><span class="spinner"></span></div>';
  const d = await api('/api/docker/networks');
  if (!dkOnPage('networks')) return;
  if (d.error) { el.innerHTML = dkErr(d.error); return; }
  _dkCache.networks = d.networks || [];
  dkRenderNetworks();
}

function dkRenderNetworks() {
  const el = document.getElementById('dk-network-list');
  if (!el) return;
  const list = _dkCache.networks;
  if (!list.length) { el.innerHTML = dkEmpty('Keine Netzwerke gefunden.'); return; }
  el.innerHTML = '<div class="dk-grid">' + list.map(n => `
    <div class="dk-card">
      <div class="dk-card-head">
        <div class="dk-name" title="${escHtml(n.name)}">${escHtml(n.name)}</div>
        <span class="card-badge ${n.builtin ? 'badge-amber' : 'badge-cyan'}">${escHtml(n.driver)}</span>
      </div>
      <div class="dk-meta">
        <div class="dk-meta-row"><span class="dk-meta-key">Subnetz</span><span class="dk-meta-val">${n.subnets.length ? escHtml(n.subnets.join(', ')) : '—'}</span></div>
        <div class="dk-meta-row"><span class="dk-meta-key">Gateway</span><span class="dk-meta-val">${n.gateways.length ? escHtml(n.gateways.join(', ')) : '—'}</span></div>
        <div class="dk-meta-row"><span class="dk-meta-key">Scope</span><span class="dk-meta-val">${escHtml(n.scope)}${n.internal ? ' &bull; internal' : ''}${n.ipv6 ? ' &bull; IPv6' : ''}</span></div>
        <div class="dk-meta-row"><span class="dk-meta-key">Container</span><span class="dk-meta-val">${n.containers}</span></div>
      </div>
      <div class="dk-actions">
        <button class="btn btn-sm" onclick="dkNetDetail('${escHtml(n.id)}')">Details</button>
      </div>
    </div>`).join('') + '</div>';
}

// ─── Docker: Netzwerke vom Container aus ───────────
// Der Weg „Netzwerke → Netz → Container verbinden" ist rückwärts gedacht: wer
// einem Container ein Netz geben will, sucht die Funktion beim Container.
// Deshalb hier dieselbe Aktion aus der anderen Richtung.

// Warum kann dieser Container keinem Netzwerk beitreten?
function dkNetModusText(c) {
  const m = (c && c.network_mode) || '';
  if (m === 'host') {
    return 'Dieser Container nutzt den Netzwerk-Modus „host" — er teilt sich den '
         + 'Netzwerk-Stack des Wirts und kann keinem Netzwerk beitreten.';
  }
  if (m === 'none') {
    return 'Dieser Container läuft im Netzwerk-Modus „none" — er hat bewusst keinen '
         + 'Netzwerkzugang und kann keinem Netzwerk beitreten.';
  }
  if (m.startsWith('container:')) {
    const ziel = c.net_shares_with || m.slice('container:'.length);
    return `Dieser Container teilt sich den Netzwerk-Stack von „${ziel}". Docker erlaubt `
         + `ihm deshalb kein eigenes Netzwerk — weise das Netz stattdessen „${ziel}" zu, `
         + 'dann gilt es für beide.';
  }
  return '';
}

async function dkOpenCtrConnect(cid) {
  const c = dkFind(cid);
  // host UND none können keinem weiteren Netz beitreten. Vorher lief nur host
  // in diese Sperre, bei none kam erst nach dem Absenden ein englischer
  // Docker-Rohtext zurück.
  if (c && c.net_attachable === false) {
    toast(dkNetModusText(c), 'warn', 11000);
    return;
  }
  if (!_dkCache.networks.length) {
    const d = await api('/api/docker/networks');
    if (d.error) { toast('Fehler: ' + d.error, 'error', 8000); return; }
    _dkCache.networks = d.networks || [];
  }
  // Bereits verbundene und nicht zuweisbare Netze ausblenden
  const schon = new Set(((c && c.networks) || []).map(n => n.name));
  const frei = _dkCache.networks.filter(
    n => !schon.has(n.name) && n.name !== 'host' && n.name !== 'none');
  if (!frei.length) {
    toast('Keine weiteren Netzwerke verfügbar — der Container ist bereits mit allen verbunden.', 'info', 7000);
    return;
  }
  document.getElementById('dk-ctrcn-id').value = cid;
  document.getElementById('dk-ctrcn-name').textContent = c ? c.name : cid.slice(0, 12);
  document.getElementById('dk-ctrcn-ip').value = '';
  document.getElementById('dk-ctrcn-alias').value = '';
  document.getElementById('dk-ctrcn-err').style.display = 'none';
  const sel = document.getElementById('dk-ctrcn-net');
  sel.innerHTML = frei.map(n => {
    const sub = n.subnets.length ? ' — ' + n.subnets[0] : '';
    return `<option value="${escHtml(n.name)}">${escHtml(n.name)} (${escHtml(n.driver)})${escHtml(sub)}</option>`;
  }).join('');
  document.getElementById('dk-ctrconnect-modal').style.display = 'flex';
}
function dkCloseCtrConnect() { document.getElementById('dk-ctrconnect-modal').style.display = 'none'; }

async function dkDoCtrConnect() {
  const errEl = document.getElementById('dk-ctrcn-err');
  errEl.style.display = 'none';
  const cid = document.getElementById('dk-ctrcn-id').value;
  const alias = document.getElementById('dk-ctrcn-alias').value.trim();
  const r = await api('/api/docker/network/connect', {
    method: 'POST',
    body: JSON.stringify({
      id: document.getElementById('dk-ctrcn-net').value,
      container: cid,
      ipv4: document.getElementById('dk-ctrcn-ip').value.trim(),
      aliases: alias ? [alias] : []
    })
  });
  if (r.error) { errEl.textContent = r.error; errEl.style.display = 'block'; return; }
  dkCloseCtrConnect();
  toast('Netzwerk verbunden', 'success');
  _dkCache.networks = [];          // Mitgliederzahlen sind jetzt veraltet
  if (_dkDetailId === cid) dkLoadDetail(cid);
}

async function dkCtrDisconnect(cid, netName) {
  const c = dkFind(cid);
  const ok = await uiConfirm(
    `Container „${c ? c.name : cid.slice(0, 12)}" vom Netzwerk „${netName}" trennen?` +
    '\n\nLaufende Verbindungen über dieses Netz brechen ab.' + dkRiskText(c),
    { danger: true, okLabel: 'Trennen' });
  if (!ok) return;
  const r = await api('/api/docker/network/disconnect', {
    method: 'POST', body: JSON.stringify({ id: netName, container: cid })
  });
  if (r.error) { toast('Fehler: ' + r.error, 'error', 9000); return; }
  toast('Getrennt von ' + netName, 'success');
  _dkCache.networks = [];
  if (_dkDetailId === cid) dkLoadDetail(cid);
}

// ─── Docker: Volumes ───────────────────────────────

async function dkLoadVolumes() {
  const el = document.getElementById('dk-volume-list');
  if (!el) return;
  el.innerHTML = '<div class="loading-overlay"><span class="spinner"></span></div>';
  const d = await api('/api/docker/volumes');
  if (!dkOnPage('volumes')) return;
  if (d.error) { el.innerHTML = dkErr(d.error); return; }
  _dkCache.volumes = d.volumes || [];
  dkRenderVolumes();
}

function dkRenderVolumes() {
  const el = document.getElementById('dk-volume-list');
  if (!el) return;
  const list = _dkCache.volumes;
  if (!list.length) { el.innerHTML = dkEmpty('Keine Volumes gefunden.'); return; }
  el.innerHTML = '<div class="dk-list">' + list.map(v => `
    <div class="dk-row">
      <span class="dk-row-main" title="${escHtml(v.name)}">${escHtml(v.name)}</span>
      <span class="dk-row-sub">${escHtml(v.driver)}</span>
      <span class="dk-row-sub">${v.size >= 0 ? formatBytes(v.size) : '—'}</span>
      <span class="dk-row-sub" title="${escHtml(v.used_by.join(', '))}">${v.used_by.length ? escHtml(v.used_by.length + '× genutzt') : 'ungenutzt'}</span>
      <span class="dk-row-act">
        <button class="btn btn-sm" onclick="dkVolDetail('${escHtml(v.name)}')">Details</button>
      </span>
    </div>`).join('') + '</div>';
}

// ─── Docker: Compose-Stacks ────────────────────────

async function dkLoadStacks() {
  const el = document.getElementById('dk-stack-list');
  if (!el) return;
  if (!_dkCache.stacks.length) {
    el.innerHTML = '<div class="loading-overlay"><span class="spinner"></span></div>';
  }
  const d = await api('/api/docker/stacks');
  if (!dkOnPage('stacks')) return;
  if (d.error) { el.innerHTML = dkErr(d.error); return; }
  _dkCache.stacks = d.stacks || [];
  dkRenderStacks();
}

function dkRenderStacks() {
  const el = document.getElementById('dk-stack-list');
  if (!el) return;
  const list = _dkCache.stacks;
  if (!list.length) { el.innerHTML = dkEmpty('Keine Compose-Stacks gefunden.'); return; }
  el.innerHTML = '<div class="dk-grid">' + list.map(s => `
    <div class="dk-card">
      <div class="dk-card-head">
        <div class="dk-name" title="${escHtml(s.project)}">${escHtml(s.project)}</div>
        <span class="card-badge ${s.running === s.total ? 'badge-green' : s.running ? 'badge-amber' : 'badge-red'}">${s.running}/${s.total}</span>
      </div>
      <div class="dk-list" style="margin-bottom:8px;">
        ${s.containers.map(c => `
          <div class="dk-row" style="padding:5px 8px;">
            <span class="dk-row-main">${escHtml(c.service || c.name)}</span>
            <span class="dk-row-sub">${escHtml(c.name)}</span>
            <span class="vm-state ${dkStateClass(c.state)}" style="flex:0 0 auto;">${escHtml(c.state)}</span>
          </div>`).join('')}
      </div>
      ${s.config_file ? `<div class="dk-meta"><div class="dk-meta-row"><span class="dk-meta-key">Datei</span><span class="dk-meta-val" title="${escHtml(s.config_file)}">${escHtml(s.config_file)}</span></div></div>` : ''}
      <div class="dk-actions">
        <button class="btn btn-sm btn-primary" onclick="dkStackAction('${escHtml(s.project)}','start')">&#9654; Alle starten</button>
        <button class="btn btn-sm btn-danger" onclick="dkStackAction('${escHtml(s.project)}','stop')">&#9209; Alle stoppen</button>
        <button class="btn btn-sm" onclick="dkStackAction('${escHtml(s.project)}','restart')">&#8635; Alle neu starten</button>
        ${s.config_file ? `<button class="btn btn-sm" onclick="dkShowCompose('${escHtml(s.project)}')">Compose-Datei</button>` : ''}
      </div>
      <div id="dk-stack-exp-${escHtml(s.project)}" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--border-dim);"></div>
    </div>`).join('') + '</div>';
}

async function dkShowCompose(project) {
  const el = document.getElementById('dk-stack-exp-' + project);
  if (!el) return;
  if (el.style.display !== 'none') { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.innerHTML = '<div class="dk-empty"><span class="spinner"></span></div>';
  const r = await api(`/api/docker/stack/compose?project=${encodeURIComponent(project)}`);
  if (r.error) { el.innerHTML = dkErr(r.error + (r.path ? ' (' + r.path + ')' : '')); return; }
  el.innerHTML = `<div class="dk-empty" style="padding:0 0 6px;">${escHtml(r.path || '')}</div>
                  <textarea class="dk-pre" style="height:280px;" spellcheck="false" readonly></textarea>`;
  el.querySelector('textarea').value = r.file || '';
}

// ─── Docker: System ────────────────────────────────

async function dkLoadSystem() {
  const el = document.getElementById('dk-system-info');
  if (!el) return;
  el.innerHTML = '<div class="loading-overlay"><span class="spinner"></span></div>';
  const [sys, df] = await Promise.all([api('/api/docker/system'), api('/api/docker/df')]);
  if (!dkOnPage('system')) return;
  if (sys.error) { el.innerHTML = dkErr(sys.error); return; }
  _dkCache.system = sys;
  const f = document.getElementById('docker-version-foot');
  if (f) f.textContent = sys.tab_version || '?';
  const v = sys.version || {}, i = sys.info || {};

  const dfRow = (label, o) => {
    if (!o) return '';
    return `<div class="dk-row">
      <span class="dk-row-main">${escHtml(label)}</span>
      <span class="dk-row-sub">${o.active}/${o.count} aktiv</span>
      <span class="dk-row-sub">${formatBytes(o.size || 0)}</span>
      <span class="dk-row-sub" style="color:var(--amber)">${formatBytes(o.reclaimable || 0)} freigebbar</span>
    </div>`;
  };

  el.innerHTML = `
    <div class="dk-grid">
      <div class="card">
        <div class="card-title">Engine</div>
        <dl class="dk-kv">
          <dt>Version</dt><dd>${escHtml(v.version || '—')}</dd>
          <dt>API</dt><dd>${escHtml(v.api || '—')} (min ${escHtml(v.min_api || '—')})</dd>
          <dt>Plattform</dt><dd>${escHtml(v.platform || '—')}</dd>
          <dt>Betriebssystem</dt><dd>${escHtml(i.os || v.os || '—')}</dd>
          <dt>Kernel</dt><dd>${escHtml(i.kernel || v.kernel || '—')}</dd>
          <dt>Architektur</dt><dd>${escHtml(v.arch || '—')}</dd>
          <dt>Go</dt><dd>${escHtml(v.go || '—')}</dd>
        </dl>
      </div>
      <div class="card">
        <div class="card-title">Host</div>
        <dl class="dk-kv">
          <dt>Name</dt><dd>${escHtml(i.name || '—')}</dd>
          <dt>Container</dt><dd>${i.containers || 0} (${i.running || 0} laufend, ${i.paused || 0} pausiert, ${i.stopped || 0} gestoppt)</dd>
          <dt>Images</dt><dd>${i.images || 0}</dd>
          <dt>Storage-Treiber</dt><dd>${escHtml(i.driver || '—')}</dd>
          <dt>cgroup</dt><dd>${escHtml(i.cgroup_driver || '—')} v${escHtml(String(i.cgroup_version || '?'))}</dd>
          <dt>Log-Treiber</dt><dd>${escHtml(i.logging_driver || '—')}</dd>
          <dt>CPUs / RAM</dt><dd>${i.ncpu || 0} / ${formatBytes(i.mem_total || 0)}</dd>
          <dt>Root-Verzeichnis</dt><dd>${escHtml(i.docker_root || '—')}</dd>
        </dl>
      </div>
    </div>
    ${(i.warnings || []).length ? `<div class="dk-warn" style="margin-top:14px;">${(i.warnings || []).map(w => escHtml(w)).join('<br>')}</div>` : ''}
    <div class="card" style="margin-top:14px;">
      <div class="card-header">
        <div class="card-title">Speicherbelegung</div>
        <button class="btn btn-sm btn-danger" onclick="dkOpenPrune()">&#128465; Aufr&#228;umen</button>
      </div>
      ${df.error ? dkErr(df.error) : `<div class="dk-list">
        ${dfRow('Images', df.images)}
        ${dfRow('Container', df.containers)}
        ${dfRow('Volumes', df.volumes)}
        ${dfRow('Build-Cache', df.build_cache)}
      </div>
      <div class="dk-empty" style="padding:10px 0 0;">Schichten gesamt: ${formatBytes(df.layers_size || 0)}</div>`}
    </div>

    <div class="card" style="margin-top:14px;">
      <div class="card-header">
        <div class="card-title">Ereignisse (live)</div>
        <span class="card-badge badge-cyan" id="dk-event-badge">l&#228;uft</span>
      </div>
      <div id="dk-event-list"><div class="dk-empty">Warte auf Ereignisse&#8230;</div></div>
    </div>`;
  dkRenderEvents();
  dkStartEvents();
}

// ─── Docker: Detailseite ───────────────────────────

async function openDockerDetail(id) {
  _dkDetailId = id;
  _dkDetail = null;
  if (_dkListTimer) { clearTimeout(_dkListTimer); _dkListTimer = null; }
  currentPage = 'docker-detail';
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('page-docker-detail').classList.add('active');
  document.getElementById('nav-btn-docker')?.classList.add('active');
  dkdSwitchTab('overview');
  await dkLoadDetail(id);
}

function dkBackToList() {
  stopDocker();
  _dkDetailId = null;
  _dkDetail = null;
  showPage('docker');
}

function dkdSwitchTab(tab) {
  _dkDetailTab = tab;
  ['overview', 'logs', 'stats', 'console', 'inspect', 'procs', 'changes'].forEach(t => {
    const p = document.getElementById(`dkdtab-${t}`);
    const b = document.getElementById(`dkdt-${t}`);
    if (p) p.style.display = t === tab ? 'block' : 'none';
    if (b) b.classList.toggle('active', t === tab);
  });
  if (_dkDetail) dkRenderDetailTab(tab);
}

async function dkLoadDetail(id) {
  const t = document.getElementById('dkd-title');
  if (t) t.textContent = '…';
  const d = await api(`/api/docker/container?id=${encodeURIComponent(id)}`);
  if (_dkDetailId !== id) return;
  if (d.error) { toast('Fehler: ' + d.error, 'error', 8000); dkBackToList(); return; }
  _dkDetail = d;
  if (t) { t.textContent = d.name; t.title = d.name; }
  const sb = document.getElementById('dkd-state-badge');
  if (sb) sb.innerHTML = `<span class="vm-state ${dkStateClass(d.state)}">${escHtml(d.state)}</span> ${dkFlags(d)}${dkHealthBadge(d.health)}`;
  dkRenderDetailActions(d);
  dkRenderDetailTab(_dkDetailTab);
}

function dkRenderDetailActions(d) {
  const el = document.getElementById('dkd-actions');
  if (!el) return;
  const id = escHtml(d.id);
  const run = d.state === 'running', pau = d.state === 'paused';
  el.innerHTML = `
    ${run || pau ? `<button class="btn btn-sm btn-danger" onclick="dkAction('${id}','stop',this)">&#9209; Stop</button>` : ''}
    ${!run && !pau ? `<button class="btn btn-sm btn-primary" onclick="dkAction('${id}','start',this)">&#9654; Start</button>` : ''}
    ${run ? `<button class="btn btn-sm" onclick="dkAction('${id}','restart',this)">&#8635; Neustart</button>` : ''}
    ${run ? `<button class="btn btn-sm" onclick="dkAction('${id}','pause',this)">&#10074;&#10074; Pause</button>` : ''}
    ${pau ? `<button class="btn btn-sm" onclick="dkAction('${id}','unpause',this)">&#9654;&#9654; Fortsetzen</button>` : ''}
    ${run || pau ? `<button class="btn btn-sm btn-danger" onclick="dkOpenKill('${id}')">&#9889; Kill</button>` : ''}
    <button class="btn btn-sm" onclick="dkOpenRename('${id}')">Umbenennen</button>
    <button class="btn btn-sm" onclick="dkOpenLimits('${id}')">Limits</button>
    <button class="btn btn-sm" onclick="dkOpenCommit('${id}')">Als Image</button>
    <button class="btn btn-sm" onclick="dkOpenUpload('${id}')">&#8593; Datei</button>
    <button class="btn btn-sm" onclick="dkDownloadArchive('${id}')">&#8595; Datei</button>
    <button class="btn btn-sm btn-danger" onclick="dkRemove('${id}')">&#128465; Entfernen</button>`;
}

// ─── Docker: Aktionen ──────────────────────────────

// Der Detaildatensatz hat Vorrang: nur er enthält Limits, CPU-Set und
// max_retry — die Listenantwort ist bewusst schlanker. Ohne diesen Vorrang
// stünde der Limits-Dialog leer da, obwohl Limits gesetzt sind.
function dkFind(id) {
  if (_dkDetail && (_dkDetail.id === id || _dkDetail.short_id === id)) return _dkDetail;
  return _dkCache.containers.find(c => c.id === id || c.short_id === id) || null;
}

// Zusatzwarnungen: kritische Infrastruktur und vom Dashboard verwaltete
// Container brauchen mehr als ein nacktes „Wirklich löschen?".
function dkRiskText(c) {
  let s = '';
  if (!c) return s;
  if (c.critical) s += '\n\n\u26A0 Dieser Container ist kritisch für die Erreichbarkeit des Dashboards '
                    + '(Tunnel). Stoppt er, ist das Dashboard über den Tunnel nicht mehr erreichbar — '
                    + 'dann hilft nur noch SSH am Host.';
  if (c.managed === 'browser') s += '\n\n\u26A0 Dieser Container gehört zu einer vom Dashboard verwalteten '
                    + 'Browser-Sitzung. Er wird über die Sitzungsverwaltung entfernt, damit der '
                    + 'gespeicherte Zustand konsistent bleibt.';
  if (c.project) s += `\n\nCompose-Stack: ${c.project}${c.service ? ' / ' + c.service : ''}`;
  return s;
}

const _DK_ACTION_LABEL = { start:'Start', stop:'Stop', restart:'Neustart',
                           pause:'Pause', unpause:'Fortsetzen', kill:'Kill' };

async function dkAction(id, action, btnEl, signal) {
  const c = dkFind(id);
  const name = c ? c.name : id.slice(0, 12);
  if (action !== 'start' && action !== 'unpause') {
    const verb = _DK_ACTION_LABEL[action] || action;
    const ok = await uiConfirm(
      `${verb} für Container „${name}"?` + dkRiskText(c),
      { danger: true, okLabel: verb });
    if (!ok) return;
  }
  if (btnEl) { btnEl._orig = btnEl.innerHTML; btnEl.disabled = true; btnEl.innerHTML = '&#9203;'; }
  const body = { id, action };
  if (signal) body.signal = signal;
  const r = await api('/api/docker/container/action',
                      { method: 'POST', body: JSON.stringify(body) });
  if (btnEl) { btnEl.disabled = false; btnEl.innerHTML = btnEl._orig || action; }
  if (r.error) { toast('Fehler: ' + r.error, 'error', 9000); return; }
  toast(`${_DK_ACTION_LABEL[action] || action}: ${name}`, 'success');
  dkRefreshAfterAction(id);
}

function dkRefreshAfterAction(id) {
  setTimeout(() => {
    if (currentPage === 'docker') loadDocker(true);
    else if (currentPage === 'docker-detail' && _dkDetailId === id) dkLoadDetail(id);
  }, 900);
}

async function dkRemove(id) {
  const c = dkFind(id);
  const name = c ? c.name : id.slice(0, 12);
  const running = c && (c.state === 'running' || c.state === 'paused');
  const ok = await uiConfirm(
    `Container „${name}" endgültig entfernen?` + dkRiskText(c) +
    (running ? '\n\nDer Container läuft noch und wird dafür zwangsweise gestoppt.' : ''),
    { danger: true, okLabel: 'Entfernen' });
  if (!ok) return;
  const withVols = await uiConfirm(
    `Sollen die anonymen Volumes von „${name}" ebenfalls gelöscht werden?\n\n` +
    'Benannte Volumes bleiben in jedem Fall erhalten.',
    { danger: true, okLabel: 'Ja, mit Volumes', cancelLabel: 'Nein, nur Container' });
  const r = await api('/api/docker/container/remove', {
    method: 'POST',
    body: JSON.stringify({ id, force: !!running, volumes: !!withVols })
  });
  if (r.error) { toast('Fehler: ' + r.error, 'error', 9000); return; }
  toast(`Entfernt: ${name}` + (r.note ? ' (' + r.note + ')' : ''), 'success');
  if (currentPage === 'docker-detail') dkBackToList();
  else { _dkCache.containers = _dkCache.containers.filter(x => x.id !== id); loadDocker(true); }
}

async function dkStackAction(project, action) {
  const label = { start: 'starten', stop: 'stoppen', restart: 'neu starten' }[action] || action;
  const st = _dkCache.stacks.find(s => s.project === project);
  const crit = (st ? st.containers : []).filter(c => c.critical).map(c => c.name);
  const prot = (st ? st.containers : []).filter(c => c.protected).map(c => c.name);
  let extra = `\n\n${st ? st.total : '?'} Container betroffen.`;
  if (crit.length) extra += `\n\n\u26A0 Kritisch: ${crit.join(', ')} — Stoppen kappt den Zugang zum Dashboard.`;
  if (prot.length) extra += `\n\nÜbersprungen (Selbstschutz): ${prot.join(', ')}`;
  const ok = await uiConfirm(`Stack „${project}" komplett ${label}?` + extra,
                             { danger: action !== 'start', okLabel: 'Ja, ' + label });
  if (!ok) return;
  // Ein Stop kann pro Container bis zu 10 s dauern — solange die Knöpfe
  // sperren, sonst klickt man in einen laufenden Vorgang hinein.
  const card = document.getElementById('dk-stack-exp-' + project)?.closest('.dk-card');
  const btns = card ? [...card.querySelectorAll('.dk-actions .btn')] : [];
  btns.forEach(b => { b.disabled = true; });
  toast(`Stack ${project} wird ${label}…`, 'info', 3000);
  const r = await api('/api/docker/stack/action',
                      { method: 'POST', body: JSON.stringify({ project, action }) });
  btns.forEach(b => { b.disabled = false; });
  if (r.error) { toast('Fehler: ' + r.error, 'error', 10000); }
  else toast(`Stack ${project}: ${(r.done || []).length} Container ${label}`, 'success');
  loadDocker(true);
}

// ─── Docker: kleine Aktionsdialoge ─────────────────

function dkOpenKill(id) {
  const c = dkFind(id);
  document.getElementById('dk-kill-name').textContent = c ? c.name : id.slice(0, 12);
  document.getElementById('dk-kill-id').value = id;
  document.getElementById('dk-kill-sig').value = 'SIGKILL';
  document.getElementById('dk-kill-modal').style.display = 'flex';
}
function dkCloseKill() { document.getElementById('dk-kill-modal').style.display = 'none'; }
async function dkDoKill() {
  const id = document.getElementById('dk-kill-id').value;
  const sig = document.getElementById('dk-kill-sig').value;
  dkCloseKill();
  await dkAction(id, 'kill', null, sig);
}

function dkOpenRename(id) {
  const c = dkFind(id);
  document.getElementById('dk-rn-id').value = id;
  document.getElementById('dk-rn-name').value = c ? c.name : '';
  document.getElementById('dk-rn-err').style.display = 'none';
  document.getElementById('dk-rename-modal').style.display = 'flex';
}
function dkCloseRename() { document.getElementById('dk-rename-modal').style.display = 'none'; }
async function dkDoRename() {
  const errEl = document.getElementById('dk-rn-err');
  const id = document.getElementById('dk-rn-id').value;
  const name = document.getElementById('dk-rn-name').value.trim();
  errEl.style.display = 'none';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)) {
    errEl.textContent = 'Ungültiger Name (nur A-Z a-z 0-9 . _ -, Beginn alphanumerisch)';
    errEl.style.display = 'block'; return;
  }
  const r = await api('/api/docker/container/rename',
                      { method: 'POST', body: JSON.stringify({ id, name }) });
  if (r.error) { errEl.textContent = r.error; errEl.style.display = 'block'; return; }
  dkCloseRename();
  toast('Umbenannt in ' + name, 'success');
  dkRefreshAfterAction(id);
}

function dkOpenLimits(id) {
  const c = dkFind(id) || {};
  document.getElementById('dk-lim-id').value = id;
  document.getElementById('dk-lim-policy').value = c.restart || 'no';
  document.getElementById('dk-lim-retry').value = c.restart_max || 0;
  document.getElementById('dk-lim-mem').value = c.memory ? Math.round(c.memory / 1048576) : '';
  document.getElementById('dk-lim-cpus').value =
    (c.cpu_quota && c.cpu_period) ? (c.cpu_quota / c.cpu_period) : '';
  document.getElementById('dk-lim-shares').value = c.cpu_shares || '';
  document.getElementById('dk-lim-cpuset').value = c.cpuset || '';
  document.getElementById('dk-lim-err').style.display = 'none';
  document.getElementById('dk-limits-modal').style.display = 'flex';
}
function dkCloseLimits() { document.getElementById('dk-limits-modal').style.display = 'none'; }
async function dkDoLimits() {
  const errEl = document.getElementById('dk-lim-err');
  errEl.style.display = 'none';
  const v = i => { const s = document.getElementById(i).value.trim(); return s === '' ? undefined : s; };
  const body = {
    id: document.getElementById('dk-lim-id').value,
    policy: document.getElementById('dk-lim-policy').value,
    max_retry: document.getElementById('dk-lim-retry').value || 0,
    memory_mb: v('dk-lim-mem'), cpus: v('dk-lim-cpus'),
    cpu_shares: v('dk-lim-shares'), cpuset: v('dk-lim-cpuset')
  };
  const r = await api('/api/docker/container/update',
                      { method: 'POST', body: JSON.stringify(body) });
  if (r.error) { errEl.textContent = r.error; errEl.style.display = 'block'; return; }
  dkCloseLimits();
  const wrn = r.warnings || [];
  toast(wrn.length ? 'Teilweise übernommen: ' + wrn.join(' ') : 'Einstellungen übernommen',
        wrn.length ? 'warn' : 'success', wrn.length ? 11000 : 4000);
  dkRefreshAfterAction(body.id);
}

function dkRenderDetailTab(tab) {
  const d = _dkDetail;
  if (!d) return;
  // Poller der übrigen Tabs anhalten, bevor ein neuer startet
  if (tab !== 'stats' && _dkEventsTimer) { clearTimeout(_dkEventsTimer); _dkEventsTimer = null; }
  // Log-Stream schließen, sobald ein anderer Tab aktiv ist
  if (tab !== 'logs' && _dkLogWs) { try { _dkLogWs.close(); } catch (_) {} _dkLogWs = null; }
  // Konsole beim Verlassen trennen — eine im Hintergrund offene Shell würde
  // sonst dauerhaft einen der vier Exec-Plätze belegen.
  if (tab !== 'console') dkConDisconnect();
  if (tab === 'overview') dkRenderOverview(d);
  if (tab === 'console')  dkRenderConsole(d);
  if (tab === 'logs')     dkRenderLogs(d);
  if (tab === 'stats')    dkRenderStats(d);
  if (tab === 'inspect')  dkRenderInspect(d);
  if (tab === 'procs')    dkRenderProcs(d);
  if (tab === 'changes')  dkRenderChanges(d);
}

function dkRenderOverview(d) {
  const el = document.getElementById('dkdtab-overview');
  if (!el) return;
  const kv = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  const cmd = (d.entrypoint || []).concat(d.cmd || []).join(' ');
  el.innerHTML = `
    <div class="dk-grid">
      <div class="card">
        <div class="card-title">Allgemein</div>
        <dl class="dk-kv">
          ${kv('Name', escHtml(d.name))}
          ${kv('Id', escHtml(d.short_id))}
          ${kv('Image', escHtml(d.image))}
          ${kv('Status', escHtml(d.state) + (d.running && d.started ? ' &bull; seit ' + dkAge(d.started) : ''))}
          ${d.exit_code ? kv('Exit-Code', escHtml(String(d.exit_code))) : ''}
          ${d.error ? kv('Fehler', escHtml(d.error)) : ''}
          ${kv('Neustart-Regel', escHtml(d.restart) + (d.restart_max ? ' (max ' + d.restart_max + ')' : ''))}
          ${kv('Neustarts', escHtml(String(d.restarts)))}
          ${kv('Erstellt', dkAge(d.created) + ' her')}
          ${kv('Kommando', cmd ? escHtml(cmd) : '—')}
          ${kv('Benutzer', escHtml(d.user || 'root (Vorgabe)'))}
          ${kv('Arbeitsverz.', escHtml(d.workdir || '/'))}
          ${d.project ? kv('Stack', escHtml(d.project) + (d.service ? ' / ' + escHtml(d.service) : '')) : ''}
        </dl>
      </div>
      <div class="card">
        <div class="card-title">Ressourcen &amp; Rechte</div>
        <dl class="dk-kv">
          ${kv('Speicherlimit', d.memory ? formatBytes(d.memory) : 'unbegrenzt')}
          ${kv('Swap-Limit', d.memory_swap > 0 ? formatBytes(d.memory_swap) : (d.memory_swap === -1 ? 'unbegrenzt' : '—'))}
          ${kv('CPU-Quota', d.cpu_quota && d.cpu_period ? (d.cpu_quota / d.cpu_period).toFixed(2) + ' CPUs' : 'unbegrenzt')}
          ${kv('CPU-Shares', escHtml(String(d.cpu_shares || 0)))}
          ${kv('CPU-Set', escHtml(d.cpuset || '—'))}
          ${kv('Privileged', d.privileged ? '<span style="color:var(--red)">ja</span>' : 'nein')}
          ${kv('Caps +', (d.cap_add || []).length ? escHtml(d.cap_add.join(', ')) : '—')}
          ${kv('Caps −', (d.cap_drop || []).length ? escHtml(d.cap_drop.join(', ')) : '—')}
          ${kv('Netzwerkmodus', escHtml(d.network_mode || '—'))}
          ${kv('Log-Treiber', escHtml(d.log_driver || '—'))}
        </dl>
      </div>
    </div>

    <div class="card" style="margin-top:14px;">
      <div class="card-title">Ports</div>
      ${d.ports.length ? `<div class="dk-ports">${d.ports.map(p => `<span class="dk-port">${escHtml(p)}</span>`).join('')}</div>` : dkEmpty('Keine ver&#246;ffentlichten Ports.')}
    </div>

    <div class="card" style="margin-top:14px;">
      <div class="card-header">
        <div class="card-title">Netzwerke</div>
        ${(d.protected || d.net_attachable === false) ? ''
          : `<button class="btn btn-sm btn-primary" onclick="dkOpenCtrConnect('${escHtml(d.id)}')">+ Netzwerk verbinden</button>`}
      </div>
      ${d.net_attachable === false ? `<div class="dk-warn">${escHtml(dkNetModusText(d))}</div>` : ''}
      ${d.networks.length ? `<div class="dk-list">${d.networks.map(n => `
        <div class="dk-row">
          <span class="dk-row-main">${escHtml(n.name)}</span>
          <span class="dk-row-sub">${escHtml(n.ip || '—')}</span>
          <span class="dk-row-sub">GW ${escHtml(n.gateway || '—')}</span>
          <span class="dk-row-sub">${escHtml(n.mac || '')}</span>
          ${(d.protected || n.name === 'host' || n.name === 'none') ? '' : `<span class="dk-row-act">
            <button class="btn btn-sm btn-danger" onclick="dkCtrDisconnect('${escHtml(d.id)}','${escHtml(n.name)}')">Trennen</button>
          </span>`}
        </div>`).join('')}</div>` : dkEmpty('Keine Netzwerke verbunden.')}
    </div>

    <div class="card" style="margin-top:14px;">
      <div class="card-title">Mounts</div>
      ${d.mounts.length ? `<div class="dk-list">${d.mounts.map(m => `
        <div class="dk-row">
          <span class="dk-row-main" title="${escHtml(m.source)}">${escHtml(m.source || '—')}</span>
          <span class="dk-row-sub" title="${escHtml(m.destination)}">&#8594; ${escHtml(m.destination)}</span>
          <span class="dk-row-sub">${escHtml(m.type)}</span>
          <span class="dk-row-sub" style="color:${m.rw ? 'var(--amber)' : 'var(--text-muted)'}">${m.rw ? 'rw' : 'ro'}</span>
        </div>`).join('')}</div>` : dkEmpty('Keine Mounts.')}
    </div>

    <div class="card" style="margin-top:14px;">
      <div class="card-title">Umgebungsvariablen (${d.env.length})</div>
      ${d.env.length ? `<div class="dk-list">${d.env.map(e => {
        const ix = e.indexOf('=');
        const k = ix < 0 ? e : e.slice(0, ix), v = ix < 0 ? '' : e.slice(ix + 1);
        return `<div class="dk-row">
          <span class="dk-row-sub" style="flex:0 0 auto;max-width:45%;">${escHtml(k)}</span>
          <span class="dk-row-main" title="${escHtml(v)}">${escHtml(v)}</span>
        </div>`;
      }).join('')}</div>` : dkEmpty('Keine Umgebungsvariablen.')}
    </div>

    <div class="card" style="margin-top:14px;">
      <div class="card-title">Labels (${Object.keys(d.labels || {}).length})</div>
      ${Object.keys(d.labels || {}).length ? `<div class="dk-list">${Object.entries(d.labels).map(([k, v]) => `
        <div class="dk-row">
          <span class="dk-row-sub" style="flex:0 0 auto;max-width:45%;" title="${escHtml(k)}">${escHtml(k)}</span>
          <span class="dk-row-main" title="${escHtml(v)}">${escHtml(v)}</span>
        </div>`).join('')}</div>` : dkEmpty('Keine Labels.')}
    </div>

    ${(d.health_log || []).length ? `<div class="card" style="margin-top:14px;">
      <div class="card-title">Health-Verlauf</div>
      <div class="dk-list">${d.health_log.map(h => `
        <div class="dk-row">
          <span class="dk-row-sub" style="flex:0 0 auto;">${escHtml((h.start || '').slice(0, 19).replace('T', ' '))}</span>
          <span class="dk-row-sub" style="flex:0 0 auto;color:${h.exit ? 'var(--red)' : 'var(--accent)'}">exit ${h.exit}</span>
          <span class="dk-row-main" title="${escHtml(h.output)}">${escHtml(h.output)}</span>
        </div>`).join('')}</div>
    </div>` : ''}`;
}

async function dkRenderInspect(d) {
  const el = document.getElementById('dkdtab-inspect');
  if (!el) return;
  el.innerHTML = '<div class="dk-empty"><span class="spinner"></span></div>';
  const r = await api(`/api/docker/container/inspect?id=${encodeURIComponent(d.id)}`);
  if (_dkDetailId !== d.id) return;
  if (r.error) { el.innerHTML = dkErr(r.error); return; }
  el.innerHTML = '<textarea class="dk-pre" style="height:calc(100vh - 300px);min-height:320px;" spellcheck="false" readonly></textarea>';
  el.querySelector('textarea').value = JSON.stringify(r.inspect, null, 2);
}

async function dkRenderProcs(d) {
  const el = document.getElementById('dkdtab-procs');
  if (!el) return;
  el.innerHTML = '<div class="dk-empty"><span class="spinner"></span></div>';
  const r = await api(`/api/docker/container/top?id=${encodeURIComponent(d.id)}`);
  if (_dkDetailId !== d.id) return;
  if (r.error) { el.innerHTML = dkErr(r.error); return; }
  el.innerHTML = `<div class="card" style="overflow-x:auto;">
    <table class="process-table">
      <thead><tr>${(r.titles || []).map(t => `<th>${escHtml(t)}</th>`).join('')}</tr></thead>
      <tbody>${(r.processes || []).map(p => `<tr>${p.map(c => `<td>${escHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>`;
}

async function dkRenderChanges(d) {
  const el = document.getElementById('dkdtab-changes');
  if (!el) return;
  el.innerHTML = '<div class="dk-empty"><span class="spinner"></span></div>';
  const r = await api(`/api/docker/container/changes?id=${encodeURIComponent(d.id)}`);
  if (_dkDetailId !== d.id) return;
  if (r.error) { el.innerHTML = dkErr(r.error); return; }
  const ch = r.changes || [];
  if (!ch.length) { el.innerHTML = dkEmpty('Keine Ver&#228;nderungen gegen&#252;ber dem Image.'); return; }
  const col = { 0: 'var(--amber)', 1: 'var(--accent)', 2: 'var(--red)' };
  el.innerHTML = `<div class="dk-empty">${ch.length} ge&#228;nderte Pfade</div><div class="dk-list">` +
    ch.slice(0, 2000).map(c => `
      <div class="dk-row">
        <span class="dk-row-sub" style="flex:0 0 90px;color:${col[c.kind] || ''}">${escHtml(c.kind_text)}</span>
        <span class="dk-row-main" title="${escHtml(c.path)}">${escHtml(c.path)}</span>
      </div>`).join('') +
    (ch.length > 2000 ? dkEmpty(`… ${ch.length - 2000} weitere ausgeblendet`) : '') + '</div>';
}


// ─── Docker: Live-Statistik ────────────────────────
// Ein Poller für die Kartenliste, einer für die Detailseite. Beide prüfen vor
// dem Nachlegen, ob ihr Ziel überhaupt noch sichtbar ist — showPage() räumt
// nicht auf, also müssen sie sich selbst beenden.

function dkFmtRate(bps) {
  return formatBytes(bps || 0) + '/s';
}

// pct steuert nur die Balkenbreite; rechts steht der aussagekräftigere Wert
// (bei CPU die Last bezogen auf EINEN Kern, wie `docker stats` sie zeigt).
function dkBar(pct, left, right) {
  const p = Math.max(0, Math.min(100, pct || 0));
  return `<div>
    <div class="dk-bar-label"><span>${left}</span><span>${right}</span></div>
    <div class="progress-track"><div class="progress-fill ${getBarClass(p)}" style="width:${p}%"></div></div>
  </div>`;
}

async function dkPollStats() {
  if (currentPage !== 'docker' || _dkTab !== 'containers') { _dkStatsTimer = null; return; }
  const d = await api('/api/docker/stats');
  if (currentPage !== 'docker' || _dkTab !== 'containers') { _dkStatsTimer = null; return; }
  if (!d.error) {
    const st = d.stats || {};
    for (const c of _dkCache.containers) {
      const box = document.getElementById('dk-bars-' + c.short_id);
      if (!box) continue;
      const s = st[c.id];
      if (!s || !s.warm) { box.innerHTML = ''; continue; }
      box.innerHTML =
        dkBar(s.cpu_pct / (s.cpus || 1), 'CPU', s.cpu_pct.toFixed(1) + '&thinsp;%') +
        dkBar(s.mem_pct, 'RAM', formatBytes(s.mem_used));
    }
  }
  if (_dkStatsTimer) clearTimeout(_dkStatsTimer);
  _dkStatsTimer = setTimeout(dkPollStats, 2500);
}

function dkStartStats() {
  if (_dkStatsTimer) clearTimeout(_dkStatsTimer);
  _dkStatsTimer = setTimeout(dkPollStats, 300);
}

// ─── Docker: Stats-Tab der Detailseite ─────────────

async function dkRenderStats(d) {
  const el = document.getElementById('dkdtab-stats');
  if (!el) return;
  if (!el.dataset.built || el.dataset.forId !== d.id) {
    el.dataset.built = '1';
    el.dataset.forId = d.id;
    el.innerHTML = `
      <div class="dk-grid">
        <div class="card">
          <div class="card-title">Auslastung</div>
          <div id="dkd-stat-bars" class="dk-bars"></div>
          <dl class="dk-kv" style="margin-top:14px;" id="dkd-stat-kv"></dl>
        </div>
        <div class="card">
          <div class="card-title">Netzwerk &amp; Datentr&#228;ger</div>
          <dl class="dk-kv" id="dkd-stat-io"></dl>
        </div>
      </div>
      <div class="dk-empty" id="dkd-stat-note">Messwerte werden alle 2&nbsp;s aktualisiert.</div>`;
  }
  dkStartDetailStats(d.id);
}

async function dkPollDetailStats(id) {
  const onTab = currentPage === 'docker-detail' && _dkDetailTab === 'stats'
                && _dkDetailId === id && document.getElementById('dkd-stat-bars');
  if (!onTab) { _dkEventsTimer = null; return; }
  const d = await api('/api/docker/stats');
  if (_dkDetailId !== id || _dkDetailTab !== 'stats') { _dkEventsTimer = null; return; }
  const s = (d.stats || {})[id];
  const bars = document.getElementById('dkd-stat-bars');
  const kv   = document.getElementById('dkd-stat-kv');
  const io   = document.getElementById('dkd-stat-io');
  const note = document.getElementById('dkd-stat-note');
  if (!bars) { _dkEventsTimer = null; return; }
  if (!s) {
    bars.innerHTML = '';
    if (kv) kv.innerHTML = '';
    if (io) io.innerHTML = '';
    if (note) note.textContent = 'Container läuft nicht — keine Messwerte.';
  } else {
    if (note) note.innerHTML = s.warm ? 'Messwerte werden alle 2&nbsp;s aktualisiert.'
                                      : 'Erster Messwert … CPU-Rate folgt in wenigen Sekunden.';
    bars.innerHTML = dkBar(s.cpu_pct / (s.cpus || 1), `CPU (von ${s.cpus} Kernen)`,
                           s.cpu_pct.toFixed(1) + '&thinsp;%')
                   + dkBar(s.mem_pct, 'RAM', formatBytes(s.mem_used)
                           + (s.mem_limit ? ' / ' + formatBytes(s.mem_limit) : ''));
    if (kv) kv.innerHTML = `
      <dt>CPU</dt><dd>${s.cpu_pct.toFixed(2)} % (${s.cpus} Kerne)</dd>
      <dt>Speicher</dt><dd>${formatBytes(s.mem_used)}${s.mem_limit ? ' / ' + formatBytes(s.mem_limit) : ''} (${s.mem_pct.toFixed(1)} %)</dd>
      <dt>Prozesse</dt><dd>${s.pids}</dd>`;
    if (io) io.innerHTML = `
      <dt>Netz empfangen</dt><dd>${formatBytes(s.net_rx)} &bull; ${dkFmtRate(s.net_rx_rate)}</dd>
      <dt>Netz gesendet</dt><dd>${formatBytes(s.net_tx)} &bull; ${dkFmtRate(s.net_tx_rate)}</dd>
      <dt>Block gelesen</dt><dd>${formatBytes(s.blk_read)}</dd>
      <dt>Block geschrieben</dt><dd>${formatBytes(s.blk_write)}</dd>`;
  }
  if (_dkEventsTimer) clearTimeout(_dkEventsTimer);
  _dkEventsTimer = setTimeout(() => dkPollDetailStats(id), 2500);
}

function dkStartDetailStats(id) {
  if (_dkEventsTimer) clearTimeout(_dkEventsTimer);
  _dkEventsTimer = setTimeout(() => dkPollDetailStats(id), 200);
}

// ─── Docker: Ereignis-Strom (System-Tab) ───────────

let _dkEventSeq = 0;
let _dkEvents   = [];

const _DK_EV_COLOR = {
  die: 'var(--red)', kill: 'var(--red)', destroy: 'var(--red)', stop: 'var(--amber)',
  start: 'var(--accent)', create: 'var(--cyan)', restart: 'var(--amber)',
  pause: 'var(--amber)', unpause: 'var(--accent)', health_status: 'var(--purple)'
};

async function dkPollEvents() {
  if (currentPage !== 'docker' || _dkTab !== 'system') { _dkJobTimer = null; return; }
  const d = await api(`/api/docker/events?since=${_dkEventSeq}`);
  if (currentPage !== 'docker' || _dkTab !== 'system') { _dkJobTimer = null; return; }
  if (!d.error) {
    _dkEventSeq = d.seq || _dkEventSeq;
    if ((d.events || []).length) {
      _dkEvents = _dkEvents.concat(d.events).slice(-200);
      dkRenderEvents();
    }
  }
  if (_dkJobTimer) clearTimeout(_dkJobTimer);
  _dkJobTimer = setTimeout(dkPollEvents, 3000);
}

function dkRenderEvents() {
  const el = document.getElementById('dk-event-list');
  if (!el) return;
  if (!_dkEvents.length) { el.innerHTML = dkEmpty('Noch keine Ereignisse.'); return; }
  el.innerHTML = '<div class="dk-list">' + _dkEvents.slice().reverse().slice(0, 120).map(e => {
    const t = e.time ? new Date(e.time * 1000).toLocaleTimeString('de-DE') : '';
    return `<div class="dk-row">
      <span class="dk-row-sub" style="flex:0 0 68px;">${escHtml(t)}</span>
      <span class="dk-row-sub" style="flex:0 0 66px;">${escHtml(e.type)}</span>
      <span class="dk-row-sub" style="flex:0 0 100px;color:${_DK_EV_COLOR[e.action] || 'var(--text-secondary)'}">${escHtml(e.action)}</span>
      <span class="dk-row-main" title="${escHtml(e.name)}">${escHtml(e.name)}</span>
    </div>`;
  }).join('') + '</div>';
}

function dkStartEvents() {
  if (_dkJobTimer) clearTimeout(_dkJobTimer);
  _dkJobTimer = setTimeout(dkPollEvents, 200);
}

// ─── Docker: Logs ──────────────────────────────────
// Der Log-Tab nutzt dasselbe Muster wie das Host-Terminal: ein WebSocket
// liefert Binärframes, die hier aber nicht durch den VT100-Emulator laufen —
// Logzeilen sind reiner Text und sollen filterbar/kopierbar bleiben.

let _dkLogBuf    = '';
let _dkLogFilter = '';
const _DK_LOG_MAX = 400000;   // Zeichen; darüber vorne abschneiden

function dkRenderLogs(d) {
  const el = document.getElementById('dkdtab-logs');
  if (!el) return;
  if (el.dataset.forId !== d.id) {
    el.dataset.forId = d.id;
    _dkLogBuf = '';
    _dkLogFilter = '';
    el.innerHTML = `
      <div class="dk-toolbar">
        <select id="dkd-log-tail" class="conn-input" style="flex:0 0 auto;width:auto;" onchange="dkLogReconnect()">
          <option value="100">100 Zeilen</option>
          <option value="200" selected>200 Zeilen</option>
          <option value="500">500 Zeilen</option>
          <option value="2000">2000 Zeilen</option>
          <option value="10000">10000 Zeilen</option>
        </select>
        <label class="dk-empty" style="padding:0;display:flex;align-items:center;gap:6px;cursor:pointer;">
          <input type="checkbox" id="dkd-log-ts" onchange="dkLogReconnect()"> Zeitstempel
        </label>
        <label class="dk-empty" style="padding:0;display:flex;align-items:center;gap:6px;cursor:pointer;">
          <input type="checkbox" id="dkd-log-follow" checked onchange="dkLogToggleFollow()"> Folgen
        </label>
        <input type="text" id="dkd-log-filter" class="conn-input dk-search" placeholder="Filter (Text)" oninput="dkLogApplyFilter()">
        <span class="dk-spacer"></span>
        <span class="card-badge badge-cyan" id="dkd-log-status">verbinde&#8230;</span>
        <button class="btn" onclick="dkLogClear()">Leeren</button>
        <button class="btn" onclick="dkLogDownload()">&#8595; Herunterladen</button>
      </div>
      <pre id="dkd-log-out" class="dk-pre" style="height:calc(100vh - 340px);min-height:260px;white-space:pre-wrap;word-break:break-all;"></pre>`;
  }
  dkLogConnect();
}

function dkLogSetStatus(txt, cls) {
  const s = document.getElementById('dkd-log-status');
  if (s) { s.textContent = txt; s.className = 'card-badge ' + (cls || 'badge-cyan'); }
}

function dkLogConnect() {
  const id = _dkDetailId;
  if (!id) return;
  if (_dkLogWs) { try { _dkLogWs.close(); } catch (_) {} _dkLogWs = null; }
  const tail = document.getElementById('dkd-log-tail')?.value || '200';
  const ts   = document.getElementById('dkd-log-ts')?.checked ? '1' : '0';
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  dkLogSetStatus('verbinde…', 'badge-amber');
  const ws = new WebSocket(
    `${proto}//${location.host}/api/docker/ws/logs/${encodeURIComponent(id)}?tail=${tail}&timestamps=${ts}`);
  ws.binaryType = 'arraybuffer';
  _dkLogWs = ws;
  ws.onopen = () => dkLogSetStatus('● live', 'badge-green');
  ws.onmessage = (e) => {
    // Beim Tabwechsel kann noch ein Frame unterwegs sein — dann verwerfen.
    if (_dkLogWs !== ws || _dkDetailId !== id) return;
    const txt = typeof e.data === 'string' ? e.data : _termDec.decode(e.data);
    _dkLogBuf += txt;
    if (_dkLogBuf.length > _DK_LOG_MAX) _dkLogBuf = _dkLogBuf.slice(-_DK_LOG_MAX);
    dkLogPaint();
  };
  ws.onclose = () => { if (_dkLogWs === ws) { _dkLogWs = null; dkLogSetStatus('○ getrennt', 'badge-red'); } };
  ws.onerror = () => dkLogSetStatus('● Fehler', 'badge-red');
}

function dkLogPaint() {
  const out = document.getElementById('dkd-log-out');
  if (!out) return;
  const follow = document.getElementById('dkd-log-follow')?.checked;
  let text = _dkLogBuf;
  if (_dkLogFilter) {
    const f = _dkLogFilter.toLowerCase();
    text = text.split('\n').filter(l => l.toLowerCase().includes(f)).join('\n');
  }
  out.textContent = text;
  if (follow) out.scrollTop = out.scrollHeight;
}

function dkLogApplyFilter() {
  _dkLogFilter = document.getElementById('dkd-log-filter')?.value.trim() || '';
  dkLogPaint();
}
function dkLogToggleFollow() { dkLogPaint(); }
function dkLogClear() { _dkLogBuf = ''; dkLogPaint(); }
function dkLogReconnect() { _dkLogBuf = ''; dkLogPaint(); dkLogConnect(); }

function dkLogDownload() {
  const id = _dkDetailId;
  if (!id) return;
  const tail = document.getElementById('dkd-log-tail')?.value || '2000';
  // Direkter Navigationsaufruf: der Browser lädt die Datei über die Session-
  // Cookie-Verbindung, kein Blob-Umweg nötig.
  window.location.href =
    `/api/docker/container/logs/download?id=${encodeURIComponent(id)}&tail=${tail}&timestamps=1`;
}

// ─── Docker: Container-Konsole ─────────────────────
// Zweite Instanz des vorhandenen VT100-Emulators (class TermScreen) mit
// eigenem WebSocket — dasselbe Drahtprotokoll wie das Host-Terminal:
// Binärframes = rohe Bytes, Textframe {"type":"resize"} = Fenstergröße.

let _dkConScreen = null;
let _dkConId     = null;

function dkConSetStatus(txt, cls) {
  const s = document.getElementById('dkd-con-status');
  if (s) { s.textContent = txt; s.className = 'card-badge ' + (cls || 'badge-cyan'); }
}

function dkRenderConsole(d) {
  const el = document.getElementById('dkdtab-console');
  if (!el) return;
  if (el.dataset.forId !== d.id) {
    el.dataset.forId = d.id;
    el.innerHTML = `
      <div class="dk-toolbar">
        <select id="dkd-con-shell" class="conn-input" style="flex:0 0 auto;width:auto;">
          <option value="sh">sh</option>
          <option value="bash">bash</option>
          <option value="ash">ash</option>
          <option value="zsh">zsh</option>
        </select>
        <input type="text" id="dkd-con-user" class="conn-input" style="flex:0 0 auto;width:120px;" placeholder="Benutzer">
        <input type="text" id="dkd-con-cwd" class="conn-input" style="flex:0 0 auto;width:150px;" placeholder="/pfad">
        <button class="btn btn-primary" onclick="dkConConnect()">Verbinden</button>
        <button class="btn" onclick="dkConDisconnect()">Trennen</button>
        <span class="dk-spacer"></span>
        <span class="card-badge badge-cyan" id="dkd-con-status">nicht verbunden</span>
      </div>
      <div class="terminal-container" style="height:calc(100vh - 340px);min-height:280px;">
        <div class="terminal-output" id="dkd-con-out" tabindex="0"></div>
      </div>
      <div class="term-key-bar">
        <button class="term-ctrl-btn" onclick="dkConKey('esc')">Esc</button>
        <button class="term-ctrl-btn" onclick="dkConKey('interrupt')">Ctrl+C</button>
        <button class="term-ctrl-btn" onclick="dkConKey('ctrl_d')">Ctrl+D</button>
        <button class="term-ctrl-btn" onclick="dkConKey('ctrl_z')">Ctrl+Z</button>
        <button class="term-ctrl-btn" onclick="dkConKey('ctrl_l')">Ctrl+L</button>
        <button class="term-ctrl-btn nav" onclick="dkConKey('tab')">Tab</button>
        <button class="term-ctrl-btn nav" onclick="dkConKey('left')">&#8592;</button>
        <button class="term-ctrl-btn nav" onclick="dkConKey('up')">&#8593;</button>
        <button class="term-ctrl-btn nav" onclick="dkConKey('down')">&#8595;</button>
        <button class="term-ctrl-btn nav" onclick="dkConKey('right')">&#8594;</button>
        <button class="term-ctrl-btn nav" onclick="dkConKey('home')">Pos1</button>
        <button class="term-ctrl-btn nav" onclick="dkConKey('end')">Ende</button>
      </div>
      <textarea id="dkd-con-kb" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false"
                style="position:absolute;left:-9999px;top:-200px;width:1px;height:1px;font-size:16px;opacity:0;"></textarea>
      <div class="dk-empty" id="dkd-con-hint">${d.running ? 'Shell w&#228;hlen und „Verbinden" dr&#252;cken.'
                                         : 'Container l&#228;uft nicht — eine Konsole ist nur bei laufendem Container m&#246;glich.'}</div>`;
    dkConBindInput();
  }
}

function dkConSend(data) {
  if (_dkConWs && _dkConWs.readyState === WebSocket.OPEN) {
    _dkConWs.send(typeof data === 'string' ? _termEnc.encode(data) : data);
  }
}

function dkConKey(action) {
  const map = { interrupt: '\x03', ctrl_d: '\x04', ctrl_z: '\x1a', ctrl_l: '\x0c',
                esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B',
                left: '\x1b[D', right: '\x1b[C', home: '\x1b[H', end: '\x1b[F' };
  if (map[action]) dkConSend(map[action]);
  dkConFocus();
}

function dkConFocus() {
  const kb = document.getElementById('dkd-con-kb');
  if (kb) kb.focus({ preventScroll: true });
}

let _dkConRenderPending = false;
function dkConRender() {
  if (_dkConRenderPending) return;
  _dkConRenderPending = true;
  requestAnimationFrame(() => {
    _dkConRenderPending = false;
    const out = document.getElementById('dkd-con-out');
    if (!out || !_dkConScreen) return;
    const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 60;
    out.innerHTML = _dkConScreen.toHtml();
    if (atBottom) out.scrollTop = out.scrollHeight;
  });
}

function dkConSendResize() {
  const out = document.getElementById('dkd-con-out');
  if (!out || !_dkConScreen || !out.clientWidth) return;
  const { cols, rows } = termGeometry(out);
  if (cols === _dkConScreen.cols && rows === _dkConScreen.rows) return;
  _dkConScreen.resize(cols, rows);
  dkConRender();
  if (_dkConWs && _dkConWs.readyState === WebSocket.OPEN)
    _dkConWs.send(JSON.stringify({ type: 'resize', cols, rows }));
}

function dkConConnect() {
  const id = _dkDetailId;
  if (!id) return;
  dkConDisconnect();
  _dkConId = id;
  _dkConScreen = new TermScreen(100, 30, { onReply: (r) => dkConSend(r) });
  const shell = document.getElementById('dkd-con-shell')?.value || 'sh';
  const user  = document.getElementById('dkd-con-user')?.value.trim() || '';
  const cwd   = document.getElementById('dkd-con-cwd')?.value.trim() || '';
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let url = `${proto}//${location.host}/api/docker/ws/exec/${encodeURIComponent(id)}?shell=${encodeURIComponent(shell)}`;
  if (user) url += `&user=${encodeURIComponent(user)}`;
  if (cwd)  url += `&cwd=${encodeURIComponent(cwd)}`;
  dkConSetStatus('verbinde…', 'badge-amber');
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  _dkConWs = ws;
  ws.onopen = () => {
    dkConSetStatus('● verbunden', 'badge-green');
    const h = document.getElementById('dkd-con-hint');
    if (h) h.textContent = 'Tastatureingaben gehen direkt an die Shell. „Trennen" beendet die Sitzung.';
    setTimeout(dkConSendResize, 90);
    dkConFocus();
  };
  ws.onmessage = (e) => {
    if (_dkConWs !== ws) return;
    const chunk = e.data instanceof ArrayBuffer ? _termDec.decode(e.data, { stream: true }) : e.data;
    if (!chunk) return;
    _dkConScreen.feed(chunk);
    dkConRender();
  };
  ws.onclose = () => {
    if (_dkConWs === ws) { _dkConWs = null; dkConSetStatus('○ getrennt', 'badge-red'); }
  };
  ws.onerror = () => dkConSetStatus('● Fehler', 'badge-red');
}

function dkConDisconnect() {
  if (_dkConWs) { try { _dkConWs.close(); } catch (_) {} _dkConWs = null; }
  dkConSetStatus('nicht verbunden', 'badge-cyan');
}

// Eingabe: eigener, auf die Konsole beschränkter Tastatur-Handler. Der globale
// Handler des Host-Terminals prüft `currentPage !== 'terminal'` und stört hier
// deshalb nicht.
function dkConBindInput() {
  const out = document.getElementById('dkd-con-out');
  const kb  = document.getElementById('dkd-con-kb');
  if (!out || !kb || kb.dataset.bound) return;
  kb.dataset.bound = '1';
  out.addEventListener('click', dkConFocus);
  kb.addEventListener('keydown', (e) => {
    if (currentPage !== 'docker-detail' || _dkDetailTab !== 'console') return;
    if (!_dkConWs) return;
    if (e.isComposing || e.keyCode === 229) return;
    if (e.metaKey && !e.ctrlKey) return;
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && ['c', 'v'].includes(e.key.toLowerCase())) return;
    if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'v') return;
    const seq = termSeqFor(e.key, { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey },
                           _dkConScreen && _dkConScreen.appCursor);
    if (!seq) return;
    e.preventDefault();
    dkConSend(seq);
  });
  kb.addEventListener('paste', (e) => {
    if (!_dkConWs) return;
    e.preventDefault();
    let t = ((e.clipboardData || window.clipboardData).getData('text') || '')
              .replace(/\r\n/g, '\r').replace(/\n/g, '\r');
    if (!t) return;
    if (_dkConScreen && _dkConScreen.bracketedPaste) t = '\x1b[200~' + t + '\x1b[201~';
    dkConSend(t);
  });
  window.addEventListener('resize', () => {
    if (currentPage === 'docker-detail' && _dkDetailTab === 'console') dkConSendResize();
  });
}

// ─── Docker: Auftragsverfolgung (Pull / Build) ─────
// Aufträge laufen serverseitig weiter, auch wenn der Dialog geschlossen oder
// der Reiter gewechselt wird. Der Poller ist deshalb an den Auftrag gebunden,
// nicht an die Sichtbarkeit — er hört auf, sobald der Auftrag fertig ist.

function dkJobWatch(jobId, boxId, onDone) {
  const step = async () => {
    const d = await api(`/api/docker/job?id=${encodeURIComponent(jobId)}`);
    const box = document.getElementById(boxId);
    if (d.error) { if (box) box.innerHTML = dkErr(d.error); return; }
    const j = d.job;
    if (box) {
      box.style.display = 'block';
      let html = '';
      if (j.layers_total) {
        html += `<div class="dk-empty" style="padding:0 0 6px;">Schichten ${j.layers_done}/${j.layers_total}</div>`;
        html += j.layers.map(l => {
          const pct = l.total ? Math.min(100, l.current / l.total * 100) : (l.done ? 100 : 0);
          return `<div style="margin-bottom:4px;">
            <div class="dk-bar-label"><span>${escHtml(l.id)}</span><span>${escHtml(l.status)}</span></div>
            <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
          </div>`;
        }).join('');
      }
      if (j.log.length) {
        html += `<pre class="dk-pre" style="height:150px;margin-top:8px;">${escHtml(j.log.slice(-40).join('\n'))}</pre>`;
      }
      if (j.status === 'error') html += dkErr(j.error);
      box.innerHTML = html;
    }
    if (j.status === 'running') { setTimeout(step, 900); return; }
    if (j.status === 'error') toast('Fehlgeschlagen: ' + j.error, 'error', 12000);
    else toast((j.kind === 'pull' ? 'Geladen: ' : 'Gebaut: ') + (j.result || j.title), 'success', 6000);
    if (onDone) onDone(j);
  };
  step();
}

// ─── Docker: Image herunterladen ───────────────────

function dkOpenPull(prefill) {
  document.getElementById('dk-pull-repo').value = prefill || '';
  document.getElementById('dk-pull-err').style.display = 'none';
  document.getElementById('dk-pull-progress').style.display = 'none';
  document.getElementById('dk-pull-progress').innerHTML = '';
  document.getElementById('dk-pull-btn').disabled = false;
  document.getElementById('dk-pull-modal').style.display = 'flex';
}
function dkClosePull() { document.getElementById('dk-pull-modal').style.display = 'none'; }

async function dkDoPull() {
  const errEl = document.getElementById('dk-pull-err');
  const btn   = document.getElementById('dk-pull-btn');
  const repo  = document.getElementById('dk-pull-repo').value.trim();
  errEl.style.display = 'none';
  if (!repo) { errEl.textContent = 'Bitte ein Image angeben.'; errEl.style.display = 'block'; return; }
  btn.disabled = true;
  const r = await api('/api/docker/image/pull', { method: 'POST', body: JSON.stringify({ repo }) });
  if (r.error) { errEl.textContent = r.error; errEl.style.display = 'block'; btn.disabled = false; return; }
  dkJobWatch(r.job, 'dk-pull-progress', () => {
    btn.disabled = false;
    if (_dkTab === 'images') dkLoadImages();
  });
}

// ─── Docker: Docker-Hub-Suche ──────────────────────

function dkOpenHub() {
  document.getElementById('dk-hub-results').innerHTML = dkEmpty('Suchbegriff eingeben.');
  document.getElementById('dk-hub-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('dk-hub-q').focus(), 60);
}
function dkCloseHub() { document.getElementById('dk-hub-modal').style.display = 'none'; }

async function dkHubSearch() {
  const q  = document.getElementById('dk-hub-q').value.trim();
  const el = document.getElementById('dk-hub-results');
  if (!q) return;
  el.innerHTML = '<div class="dk-empty"><span class="spinner"></span> Suche&#8230;</div>';
  const d = await api(`/api/docker/hub/search?q=${encodeURIComponent(q)}`);
  if (d.error) { el.innerHTML = dkErr(d.error); return; }
  const res = d.results || [];
  if (!res.length) { el.innerHTML = dkEmpty('Keine Treffer.'); return; }
  el.innerHTML = '<div class="dk-list">' + res.map(r => `
    <div class="dk-row" style="flex-wrap:wrap;">
      <span class="dk-row-main" style="flex:1 1 180px;" title="${escHtml(r.name)}">${escHtml(r.name)}</span>
      ${r.official ? '<span class="card-badge badge-green" style="flex:0 0 auto;">official</span>' : ''}
      ${r.verified ? '<span class="card-badge badge-cyan" style="flex:0 0 auto;">verified</span>' : ''}
      <span class="dk-row-sub" style="flex:0 0 auto;">&#9733; ${r.stars}</span>
      <span class="dk-row-act">
        <button class="btn btn-sm" onclick="dkHubTags('${escHtml(r.name)}')">Tags</button>
        <button class="btn btn-sm btn-primary" onclick="dkCloseHub();dkOpenPull('${escHtml(r.name)}')">Pull</button>
        <button class="btn btn-sm" onclick="dkCloseHub();dkOpenCreate('${escHtml(r.name)}')">Container</button>
      </span>
      <div style="flex:1 1 100%;min-width:0;color:var(--text-muted);font-size:10px;">${escHtml(r.description)}</div>
      <div id="dk-hub-tags-${escHtml(r.name).replace(/[^A-Za-z0-9]/g, '_')}" style="flex:1 1 100%;min-width:0;display:none;margin-top:6px;"></div>
    </div>`).join('') + '</div>';
}

async function dkHubTags(repo) {
  const el = document.getElementById('dk-hub-tags-' + repo.replace(/[^A-Za-z0-9]/g, '_'));
  if (!el) return;
  if (el.style.display !== 'none') { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.innerHTML = '<span class="spinner"></span>';
  const d = await api(`/api/docker/hub/tags?repo=${encodeURIComponent(repo)}`);
  if (d.error) { el.innerHTML = dkErr(d.error); return; }
  el.innerHTML = (d.tags || []).slice(0, 40).map(tg =>
    `<button class="btn btn-sm" style="margin:2px;" title="${escHtml(tg.updated)} &bull; ${escHtml(tg.arch)}"
             onclick="dkCloseHub();dkOpenPull('${escHtml(repo)}:${escHtml(tg.name)}')">${escHtml(tg.name)}</button>`
  ).join('') || dkEmpty('Keine Tags gefunden.');
}

// ─── Docker: Image bauen ───────────────────────────

function dkOpenBuild() {
  ['dk-build-ctx', 'dk-build-tag', 'dk-build-args'].forEach(i => document.getElementById(i).value = '');
  document.getElementById('dk-build-df').value = 'Dockerfile';
  document.getElementById('dk-build-nocache').checked = false;
  document.getElementById('dk-build-err').style.display = 'none';
  document.getElementById('dk-build-log').style.display = 'none';
  document.getElementById('dk-build-btn').disabled = false;
  document.getElementById('dk-build-modal').style.display = 'flex';
}
function dkCloseBuild() { document.getElementById('dk-build-modal').style.display = 'none'; }

async function dkDoBuild() {
  const errEl = document.getElementById('dk-build-err');
  const btn   = document.getElementById('dk-build-btn');
  errEl.style.display = 'none';
  const buildargs = {};
  for (const line of document.getElementById('dk-build-args').value.split('\n')) {
    const s = line.trim(); if (!s) continue;
    const i = s.indexOf('='); if (i < 0) continue;
    buildargs[s.slice(0, i)] = s.slice(i + 1);
  }
  btn.disabled = true;
  const r = await api('/api/docker/image/build', {
    method: 'POST',
    body: JSON.stringify({
      context: document.getElementById('dk-build-ctx').value.trim(),
      dockerfile: document.getElementById('dk-build-df').value.trim() || 'Dockerfile',
      tag: document.getElementById('dk-build-tag').value.trim(),
      nocache: document.getElementById('dk-build-nocache').checked,
      buildargs
    })
  });
  if (r.error) { errEl.textContent = r.error; errEl.style.display = 'block'; btn.disabled = false; return; }
  dkJobWatch(r.job, 'dk-build-log', () => {
    btn.disabled = false;
    if (_dkTab === 'images') dkLoadImages();
  });
}

// ─── Docker: Image-Aktionen ────────────────────────

function dkImgRef(i) { return i.tags.length ? i.tags[0] : i.id; }

async function dkImageDetail(id) {
  const img = _dkCache.images.find(x => x.id === id);
  const box = document.getElementById('dk-img-exp');
  const list = document.getElementById('dk-image-list');
  if (!img || !list) return;
  let el = document.getElementById('dk-img-exp');
  if (el && el.dataset.forId === id) { el.remove(); return; }
  if (el) el.remove();
  el = document.createElement('div');
  el.id = 'dk-img-exp';
  el.dataset.forId = id;
  el.className = 'card';
  el.style.marginTop = '10px';
  el.innerHTML = '<div class="dk-empty"><span class="spinner"></span></div>';
  list.appendChild(el);
  const [ins, hist] = await Promise.all([
    api(`/api/docker/image/inspect?id=${encodeURIComponent(dkImgRef(img))}`),
    api(`/api/docker/image/history?id=${encodeURIComponent(dkImgRef(img))}`)
  ]);
  if (document.getElementById('dk-img-exp') !== el) return;
  const cfg = (ins.inspect || {}).Config || {};
  el.innerHTML = `
    <div class="card-title">${escHtml(dkImgRef(img))}</div>
    <div class="dk-actions" style="margin-bottom:12px;">
      <button class="btn btn-sm" onclick="dkImageTag('${escHtml(id)}')">Tag setzen</button>
      <button class="btn btn-sm" onclick="dkOpenCreate('${escHtml(dkImgRef(img))}')">Container erstellen</button>
      <button class="btn btn-sm" onclick="dkImageSave('${escHtml(dkImgRef(img))}')">&#8595; Exportieren</button>
      <span class="dk-spacer"></span>
      <button class="btn btn-sm btn-danger" onclick="dkImageRemove('${escHtml(id)}')">&#128465; Entfernen</button>
    </div>
    <dl class="dk-kv">
      <dt>Id</dt><dd>${escHtml(img.short_id)}</dd>
      <dt>Alle Tags</dt><dd>${img.tags.length ? escHtml(img.tags.join(', ')) : '&lt;none&gt;'}</dd>
      <dt>Gr&#246;&#223;e</dt><dd>${formatBytes(img.size)}</dd>
      <dt>Alter</dt><dd>${dkAge(img.created)}</dd>
      <dt>Genutzt von</dt><dd>${img.containers} Container</dd>
      <dt>Architektur</dt><dd>${escHtml((ins.inspect || {}).Architecture || '—')} / ${escHtml((ins.inspect || {}).Os || '—')}</dd>
      <dt>Kommando</dt><dd>${escHtml((cfg.Cmd || []).join(' ') || '—')}</dd>
      <dt>Entrypoint</dt><dd>${escHtml((cfg.Entrypoint || []).join(' ') || '—')}</dd>
      <dt>Ports</dt><dd>${escHtml(Object.keys(cfg.ExposedPorts || {}).join(', ') || '—')}</dd>
    </dl>
    <div class="card-title" style="margin-top:14px;">Schichten (${(hist.history || []).length})</div>
    <div class="dk-list">${(hist.history || []).slice(0, 30).map(h => `
      <div class="dk-row">
        <span class="dk-row-sub" style="flex:0 0 70px;">${formatBytes(h.size)}</span>
        <span class="dk-row-main" title="${escHtml(h.created_by)}">${escHtml(h.created_by)}</span>
      </div>`).join('')}</div>`;
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function dkImageRemove(id) {
  const img = _dkCache.images.find(x => x.id === id);
  const ref = img ? dkImgRef(img) : id;
  const used = img && img.containers;
  const ok = await uiConfirm(
    `Image „${ref}" entfernen?` +
    (used ? `\n\n⚠ Es wird noch von ${used} Container(n) benutzt — das Entfernen wird erzwungen.` : '') +
    (img ? `\n\nGröße: ${formatBytes(img.size)}` : ''),
    { danger: true, okLabel: 'Entfernen' });
  if (!ok) return;
  const r = await api('/api/docker/image/remove',
                      { method: 'POST', body: JSON.stringify({ id: ref, force: !!used }) });
  if (r.error) { toast('Fehler: ' + r.error, 'error', 9000); return; }
  toast(`Entfernt: ${(r.deleted || []).length} Einträge`, 'success');
  document.getElementById('dk-img-exp')?.remove();
  dkLoadImages();
}

async function dkImageTag(id) {
  const img = _dkCache.images.find(x => x.id === id);
  const ref = img ? dkImgRef(img) : id;
  const val = await dkPromptModal('Neuen Tag setzen', 'repository:tag', 'z. B. meinapp:stabil');
  if (!val) return;
  const i = val.lastIndexOf(':');
  const repo = i > 0 ? val.slice(0, i) : val;
  const tag  = i > 0 ? val.slice(i + 1) : 'latest';
  const r = await api('/api/docker/image/tag',
                      { method: 'POST', body: JSON.stringify({ id: ref, repo, tag }) });
  if (r.error) { toast('Fehler: ' + r.error, 'error', 9000); return; }
  toast('Tag gesetzt: ' + r.ref, 'success');
  dkLoadImages();
}

function dkImageSave(ref) {
  window.location.href = `/api/docker/image/save?id=${encodeURIComponent(ref)}`;
  toast('Export gestartet — je nach Größe kann das dauern.', 'info', 6000);
}

// ─── Docker: kleiner Eingabedialog ─────────────────
// Ersatz für das native prompt() — dieselbe Begründung wie bei uiConfirm:
// native Dialoge können vom Browser unterdrückt werden.

function dkPromptModal(title, label, placeholder, value) {
  return new Promise(resolve => {
    const m = document.getElementById('ui-confirm-modal');
    if (!m) { resolve(null); return; }
    const msg = document.getElementById('ui-confirm-msg');
    const ok = document.getElementById('ui-confirm-ok');
    const cancel = document.getElementById('ui-confirm-cancel');
    msg.innerHTML = `<div style="font-weight:600;margin-bottom:10px;">${escHtml(title)}</div>
      <label class="conn-label">${escHtml(label)}</label>
      <input id="ui-prompt-input" class="conn-input" placeholder="${escHtml(placeholder || '')}" value="${escHtml(value || '')}">`;
    ok.textContent = 'OK'; ok.className = 'btn btn-primary';
    cancel.textContent = 'Abbrechen';
    m.style.display = 'flex';
    setTimeout(() => document.getElementById('ui-prompt-input')?.focus(), 60);
    const done = (val) => {
      m.style.display = 'none';
      msg.innerHTML = ''; msg.textContent = '';
      ok.onclick = cancel.onclick = m.onclick = null;
      resolve(val);
    };
    ok.onclick = () => done(document.getElementById('ui-prompt-input')?.value.trim() || null);
    cancel.onclick = () => done(null);
    m.onclick = (e) => { if (e.target === m) done(null); };
  });
}

// ─── Docker: Netzwerke ─────────────────────────────

function dkNetDriverChanged() {
  const drv = document.getElementById('dk-net-driver').value;
  document.getElementById('dk-net-parent-wrap').style.display =
    (drv === 'macvlan' || drv === 'ipvlan') ? '' : 'none';
}

function dkOpenNetCreate() {
  ['dk-net-name', 'dk-net-subnet', 'dk-net-gw', 'dk-net-range', 'dk-net-parent']
    .forEach(i => document.getElementById(i).value = '');
  document.getElementById('dk-net-driver').value = 'bridge';
  document.getElementById('dk-net-internal').checked = false;
  document.getElementById('dk-net-ipv6').checked = false;
  document.getElementById('dk-net-err').style.display = 'none';
  dkNetDriverChanged();
  document.getElementById('dk-net-modal').style.display = 'flex';
}
function dkCloseNet() { document.getElementById('dk-net-modal').style.display = 'none'; }

async function dkDoNetCreate() {
  const errEl = document.getElementById('dk-net-err');
  errEl.style.display = 'none';
  const v = i => document.getElementById(i).value.trim();
  const r = await api('/api/docker/network/create', {
    method: 'POST',
    body: JSON.stringify({
      name: v('dk-net-name'), driver: document.getElementById('dk-net-driver').value,
      subnet: v('dk-net-subnet'), gateway: v('dk-net-gw'), ip_range: v('dk-net-range'),
      parent: v('dk-net-parent'),
      internal: document.getElementById('dk-net-internal').checked,
      ipv6: document.getElementById('dk-net-ipv6').checked
    })
  });
  if (r.error) { errEl.textContent = r.error; errEl.style.display = 'block'; return; }
  dkCloseNet();
  toast('Netzwerk angelegt' + (r.warning ? ' (' + r.warning + ')' : ''), 'success');
  dkLoadNetworks();
}

async function dkNetDetail(id) {
  const list = document.getElementById('dk-network-list');
  let el = document.getElementById('dk-net-exp');
  if (el && el.dataset.forId === id) { el.remove(); return; }
  if (el) el.remove();
  el = document.createElement('div');
  el.id = 'dk-net-exp'; el.dataset.forId = id; el.className = 'card';
  el.style.marginTop = '10px';
  el.innerHTML = '<div class="dk-empty"><span class="spinner"></span></div>';
  list.appendChild(el);
  const d = await api(`/api/docker/network?id=${encodeURIComponent(id)}`);
  if (document.getElementById('dk-net-exp') !== el) return;
  if (d.error) { el.innerHTML = dkErr(d.error); return; }
  const n = d.network;
  el.innerHTML = `
    <div class="card-title">${escHtml(n.name)}</div>
    <div class="dk-actions" style="margin-bottom:12px;">
      <button class="btn btn-sm" onclick="dkOpenConnect('${escHtml(n.id)}','${escHtml(n.name)}')">Container verbinden</button>
      <span class="dk-spacer"></span>
      ${n.builtin ? '<span class="card-badge badge-amber">eingebaut &#8212; nicht entfernbar</span>'
                  : `<button class="btn btn-sm btn-danger" onclick="dkNetRemove('${escHtml(n.id)}','${escHtml(n.name)}')">&#128465; Entfernen</button>`}
    </div>
    <dl class="dk-kv">
      <dt>Id</dt><dd>${escHtml(n.short_id)}</dd>
      <dt>Treiber</dt><dd>${escHtml(n.driver)} (${escHtml(n.scope)})</dd>
      <dt>Subnetz</dt><dd>${escHtml(n.subnets.join(', ') || '—')}</dd>
      <dt>Gateway</dt><dd>${escHtml(n.gateways.join(', ') || '—')}</dd>
      <dt>IP-Bereich</dt><dd>${escHtml(n.ranges.join(', ') || '—')}</dd>
      <dt>Intern</dt><dd>${n.internal ? 'ja' : 'nein'}</dd>
      <dt>IPv6</dt><dd>${n.ipv6 ? 'ja' : 'nein'}</dd>
      <dt>Optionen</dt><dd>${escHtml(Object.entries(n.options || {}).map(([k, v]) => k + '=' + v).join(', ') || '—')}</dd>
    </dl>
    <div class="card-title" style="margin-top:14px;">Verbundene Container (${n.members.length})</div>
    ${n.members.length ? `<div class="dk-list">${n.members.map(m => `
      <div class="dk-row">
        <span class="dk-row-main">${escHtml(m.name)}</span>
        ${m.running === false ? '<span class="card-badge" style="flex:0 0 auto;background:rgba(100,116,139,.15);color:#94a3b8;">gestoppt</span>' : ''}
        <span class="dk-row-sub">${escHtml(m.ipv4 || '—')}</span>
        <span class="dk-row-act">
          <button class="btn btn-sm btn-danger" onclick="dkNetDisconnect('${escHtml(n.id)}','${escHtml(m.name)}')">Trennen</button>
        </span>
      </div>`).join('')}</div>` : dkEmpty('Kein Container verbunden.')}`;
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function dkNetRemove(id, name) {
  if (!(await uiConfirm(`Netzwerk „${name}" entfernen?\n\nContainer, die es noch nutzen, verlieren die Verbindung.`,
                        { danger: true, okLabel: 'Entfernen' }))) return;
  const r = await api('/api/docker/network/remove', { method: 'POST', body: JSON.stringify({ id }) });
  if (r.error) { toast('Fehler: ' + r.error, 'error', 9000); return; }
  toast('Netzwerk entfernt: ' + name, 'success');
  document.getElementById('dk-net-exp')?.remove();
  dkLoadNetworks();
}

async function dkNetDisconnect(id, container) {
  if (!(await uiConfirm(`„${container}" von diesem Netzwerk trennen?`,
                        { danger: true, okLabel: 'Trennen' }))) return;
  const r = await api('/api/docker/network/disconnect',
                      { method: 'POST', body: JSON.stringify({ id, container }) });
  if (r.error) { toast('Fehler: ' + r.error, 'error', 9000); return; }
  toast('Getrennt: ' + container, 'success');
  // Kartenzähler UND Aufklappbereich auffrischen — vorher blieb die Karte auf
  // dem alten Stand stehen.
  document.getElementById('dk-net-exp')?.remove();
  await dkLoadNetworks();
  dkNetDetail(id);
}

function dkOpenConnect(netId, netName) {
  document.getElementById('dk-cn-net').value = netId;
  document.getElementById('dk-cn-netname').textContent = netName;
  document.getElementById('dk-cn-ip').value = '';
  document.getElementById('dk-cn-alias').value = '';
  document.getElementById('dk-cn-err').style.display = 'none';
  const sel = document.getElementById('dk-cn-container');
  // Geschützte Container und solche im Modus host/none können ohnehin nicht
  // verbunden werden — sie gehören nicht in die Auswahl.
  const waehlbar = _dkCache.containers.filter(c => !c.protected && c.net_attachable !== false);
  const gesperrt = _dkCache.containers.filter(c => !c.protected && c.net_attachable === false);
  sel.innerHTML = waehlbar.length
    ? waehlbar.map(c => `<option value="${escHtml(c.id)}">${escHtml(c.name)}${c.state !== 'running' ? ' (gestoppt)' : ''}</option>`).join('')
    : '<option value="">— kein verbindbarer Container vorhanden —</option>';
  // Erklären, warum manche Container fehlen — sonst sucht man sie vergeblich.
  const hinweis = document.getElementById('dk-cn-hinweis');
  if (hinweis) {
    hinweis.innerHTML = gesperrt.length
      ? `${gesperrt.length} Container werden nicht angeboten, weil sie den Netzwerk-Stack `
        + `teilen (<code>host</code>, <code>none</code> oder <code>container:…</code>): `
        + escHtml(gesperrt.map(c => c.name).slice(0, 6).join(', '))
        + (gesperrt.length > 6 ? ' …' : '')
      : '';
    hinweis.style.display = gesperrt.length ? 'block' : 'none';
  }
  document.getElementById('dk-connect-modal').style.display = 'flex';
}
function dkCloseConnect() { document.getElementById('dk-connect-modal').style.display = 'none'; }

async function dkDoConnect() {
  const errEl = document.getElementById('dk-cn-err');
  errEl.style.display = 'none';
  if (!document.getElementById('dk-cn-container').value) {
    errEl.textContent = 'Kein Container geladen — bitte den Reiter aktualisieren.';
    errEl.style.display = 'block';
    return;
  }
  const alias = document.getElementById('dk-cn-alias').value.trim();
  const r = await api('/api/docker/network/connect', {
    method: 'POST',
    body: JSON.stringify({
      id: document.getElementById('dk-cn-net').value,
      container: document.getElementById('dk-cn-container').value,
      ipv4: document.getElementById('dk-cn-ip').value.trim(),
      aliases: alias ? [alias] : []
    })
  });
  if (r.error) { errEl.textContent = r.error; errEl.style.display = 'block'; return; }
  const id = document.getElementById('dk-cn-net').value;
  dkCloseConnect();
  toast('Verbunden', 'success');
  document.getElementById('dk-net-exp')?.remove();
  dkLoadNetworks();
}

// ─── Docker: Volumes ───────────────────────────────

function dkOpenVolCreate() {
  document.getElementById('dk-vol-name').value = '';
  document.getElementById('dk-vol-driver').value = 'local';
  document.getElementById('dk-vol-err').style.display = 'none';
  document.getElementById('dk-vol-modal').style.display = 'flex';
}
function dkCloseVol() { document.getElementById('dk-vol-modal').style.display = 'none'; }

async function dkDoVolCreate() {
  const errEl = document.getElementById('dk-vol-err');
  errEl.style.display = 'none';
  const r = await api('/api/docker/volume/create', {
    method: 'POST',
    body: JSON.stringify({ name: document.getElementById('dk-vol-name').value.trim(),
                           driver: document.getElementById('dk-vol-driver').value.trim() || 'local' })
  });
  if (r.error) { errEl.textContent = r.error; errEl.style.display = 'block'; return; }
  dkCloseVol();
  toast('Volume angelegt: ' + r.name, 'success');
  dkLoadVolumes();
}

async function dkVolDetail(name) {
  const list = document.getElementById('dk-volume-list');
  let el = document.getElementById('dk-vol-exp');
  if (el && el.dataset.forId === name) { el.remove(); return; }
  if (el) el.remove();
  el = document.createElement('div');
  el.id = 'dk-vol-exp'; el.dataset.forId = name; el.className = 'card';
  el.style.marginTop = '10px';
  el.innerHTML = '<div class="dk-empty"><span class="spinner"></span></div>';
  list.appendChild(el);
  const d = await api(`/api/docker/volume?name=${encodeURIComponent(name)}`);
  if (document.getElementById('dk-vol-exp') !== el) return;
  if (d.error) { el.innerHTML = dkErr(d.error); return; }
  const v = d.volume, cached = _dkCache.volumes.find(x => x.name === name) || {};
  el.innerHTML = `
    <div class="card-title">${escHtml(v.Name || name)}</div>
    <div class="dk-actions" style="margin-bottom:12px;">
      <span class="dk-spacer"></span>
      <button class="btn btn-sm btn-danger" onclick="dkVolRemove('${escHtml(name)}')">&#128465; Entfernen</button>
    </div>
    <dl class="dk-kv">
      <dt>Treiber</dt><dd>${escHtml(v.Driver || '—')}</dd>
      <dt>Mountpoint</dt><dd>${escHtml(v.Mountpoint || '—')}</dd>
      <dt>Erstellt</dt><dd>${escHtml((v.CreatedAt || '').replace('T', ' ').slice(0, 19) || '—')}</dd>
      <dt>Gr&#246;&#223;e</dt><dd>${cached.size >= 0 ? formatBytes(cached.size) : 'unbekannt'}</dd>
      <dt>Genutzt von</dt><dd>${escHtml((cached.used_by || []).join(', ') || 'niemandem')}</dd>
      <dt>Labels</dt><dd>${escHtml(Object.entries(v.Labels || {}).map(([k, x]) => k + '=' + x).join(', ') || '—')}</dd>
    </dl>`;
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function dkVolRemove(name) {
  const v = _dkCache.volumes.find(x => x.name === name) || {};
  const used = (v.used_by || []).length;
  const ok = await uiConfirm(
    `Volume „${name}" endgültig entfernen?\n\n⚠ Die enthaltenen Daten sind danach unwiederbringlich weg.` +
    (used ? `\n\nWird noch benutzt von: ${v.used_by.join(', ')}` : '') +
    (v.size > 0 ? `\n\nGröße: ${formatBytes(v.size)}` : ''),
    { danger: true, okLabel: 'Endgültig löschen' });
  if (!ok) return;
  const r = await api('/api/docker/volume/remove',
                      { method: 'POST', body: JSON.stringify({ name }) });
  if (r.error) { toast('Fehler: ' + r.error, 'error', 9000); return; }
  toast('Volume entfernt: ' + name, 'success');
  document.getElementById('dk-vol-exp')?.remove();
  dkLoadVolumes();
}

// ─── Docker: Aufräumen (Prune) ─────────────────────
// Zweistufig: erst Trockenlauf mit namentlicher Auflistung, dann eine zweite,
// ausdrückliche Bestätigung. Auf diesem Host hängen produktive Dienste dran.

function dkOpenPrune() {
  document.getElementById('dk-prune-modal').style.display = 'flex';
  dkPruneDryrun();
}
function dkClosePrune() { document.getElementById('dk-prune-modal').style.display = 'none'; }

function dkPruneTypes() {
  const t = [];
  if (document.getElementById('dk-pr-containers').checked) t.push('containers');
  if (document.getElementById('dk-pr-images').checked)     t.push('images');
  if (document.getElementById('dk-pr-volumes').checked)    t.push('volumes');
  if (document.getElementById('dk-pr-networks').checked)   t.push('networks');
  if (document.getElementById('dk-pr-cache').checked)      t.push('build-cache');
  return t;
}

async function dkPruneDryrun() {
  const el = document.getElementById('dk-prune-preview');
  const types = dkPruneTypes();
  const all = document.getElementById('dk-pr-images-all').checked;
  if (!types.length) { el.innerHTML = dkEmpty('Nichts ausgew&#228;hlt.'); return; }
  el.innerHTML = '<div class="dk-empty"><span class="spinner"></span> Trockenlauf&#8230;</div>';
  const d = await api(`/api/docker/prune/dryrun?types=${types.join(',')}&images_all=${all ? 1 : 0}`);
  if (d.error) { el.innerHTML = dkErr(d.error); return; }
  const sec = (title, items, render) => items.length
    ? `<div class="card-title" style="margin-top:12px;">${title} (${items.length})</div>
       <div class="dk-list">${items.slice(0, 60).map(render).join('')}</div>
       ${items.length > 60 ? dkEmpty(`… ${items.length - 60} weitere`) : ''}`
    : '';
  el.innerHTML =
    `<div class="dk-warn">Wird gel&#246;scht &#8212; insgesamt <b>${formatBytes(d.reclaimable || 0)}</b> werden frei.</div>` +
    sec('Container', d.containers, c =>
      `<div class="dk-row"><span class="dk-row-main">${escHtml(c.name)}</span>
       <span class="dk-row-sub">${escHtml(c.image)}</span>
       <span class="dk-row-sub">${escHtml(c.status)}</span></div>`) +
    sec('Images', d.images, i =>
      `<div class="dk-row"><span class="dk-row-main">${escHtml(i.tags.join(', '))}</span>
       <span class="dk-row-sub">${escHtml(i.id)}</span>
       <span class="dk-row-sub">${formatBytes(i.size)}</span></div>`) +
    sec('Volumes', d.volumes, v =>
      `<div class="dk-row"><span class="dk-row-main" style="color:var(--red)">${escHtml(v.name)}</span>
       <span class="dk-row-sub">${formatBytes(v.size)}</span></div>`) +
    sec('Netzwerke', d.networks, n =>
      `<div class="dk-row"><span class="dk-row-main">${escHtml(n.name)}</span>
       <span class="dk-row-sub">${escHtml(n.driver)}</span></div>`) +
    ((d.build_cache && d.build_cache.count)
      ? `<div class="card-title" style="margin-top:12px;">Build-Cache</div>
         <div class="dk-empty">${d.build_cache.count} Eintr&#228;ge &bull; ${formatBytes(d.build_cache.reclaimable || 0)}</div>` : '') +
    (!d.containers.length && !d.images.length && !d.volumes.length && !d.networks.length
      && !(d.build_cache && d.build_cache.count)
      ? dkEmpty('Nichts zu l&#246;schen.') : '');
  el._dry = d;
}

async function dkDoPrune() {
  const types = dkPruneTypes();
  if (!types.length) { toast('Nichts ausgewählt.', 'warn'); return; }
  const all = document.getElementById('dk-pr-images-all').checked;
  const d = document.getElementById('dk-prune-preview')._dry || {};
  const zeilen = [];
  if (d.containers && d.containers.length) zeilen.push(`${d.containers.length} Container`);
  if (d.images && d.images.length)         zeilen.push(`${d.images.length} Images`);
  if (d.volumes && d.volumes.length)       zeilen.push(`${d.volumes.length} Volumes (mit Daten!)`);
  if (d.networks && d.networks.length)     zeilen.push(`${d.networks.length} Netzwerke`);
  if (d.build_cache && d.build_cache.count) zeilen.push(`${d.build_cache.count} Build-Cache-Einträge`);
  if (!zeilen.length) { toast('Nichts zu löschen.', 'info'); return; }

  const ok = await uiConfirm(
    'Wirklich endgültig löschen?\n\n' + zeilen.join('\n') +
    `\n\nFrei werden etwa ${formatBytes(d.reclaimable || 0)}.` +
    '\n\nDieser Schritt ist NICHT umkehrbar.' +
    ((d.volumes && d.volumes.length)
      ? '\n\n⚠ Volumes enthalten Nutzdaten — diese sind danach verloren.' : ''),
    { danger: true, okLabel: 'Endgültig löschen' });
  if (!ok) return;

  const r = await api('/api/docker/prune',
                      { method: 'POST', body: JSON.stringify({ types, images_all: all }) });
  if (r.error) { toast('Fehler: ' + r.error, 'error', 12000); return; }
  toast(`Aufgeräumt — ${formatBytes(r.reclaimed || 0)} frei`, 'success', 8000);
  dkClosePrune();
  loadDocker(true);
}

// ─── Docker: Commit / Dateien ──────────────────────

function dkOpenCommit(id) {
  const c = dkFind(id) || {};
  document.getElementById('dk-cm-id').value = id;
  document.getElementById('dk-cm-repo').value = (c.name || '').replace(/[^A-Za-z0-9_.-]/g, '-').toLowerCase();
  document.getElementById('dk-cm-tag').value = 'latest';
  document.getElementById('dk-cm-msg').value = '';
  document.getElementById('dk-cm-pause').checked = true;
  document.getElementById('dk-cm-err').style.display = 'none';
  document.getElementById('dk-commit-modal').style.display = 'flex';
}
function dkCloseCommit() { document.getElementById('dk-commit-modal').style.display = 'none'; }

async function dkDoCommit() {
  const errEl = document.getElementById('dk-cm-err');
  errEl.style.display = 'none';
  const r = await api('/api/docker/container/commit', {
    method: 'POST',
    body: JSON.stringify({
      id: document.getElementById('dk-cm-id').value,
      repo: document.getElementById('dk-cm-repo').value.trim(),
      tag: document.getElementById('dk-cm-tag').value.trim() || 'latest',
      message: document.getElementById('dk-cm-msg').value.trim(),
      pause: document.getElementById('dk-cm-pause').checked
    })
  });
  if (r.error) { errEl.textContent = r.error; errEl.style.display = 'block'; return; }
  dkCloseCommit();
  toast('Image erstellt: ' + r.ref, 'success', 7000);
}

function dkOpenUpload(id) {
  document.getElementById('dk-up-id').value = id;
  document.getElementById('dk-up-path').value = '/tmp';
  document.getElementById('dk-up-file').value = '';
  document.getElementById('dk-up-err').style.display = 'none';
  document.getElementById('dk-upload-modal').style.display = 'flex';
}
function dkCloseUpload() { document.getElementById('dk-upload-modal').style.display = 'none'; }

async function dkDoUpload() {
  const errEl = document.getElementById('dk-up-err');
  errEl.style.display = 'none';
  const f = document.getElementById('dk-up-file').files[0];
  if (!f) { errEl.textContent = 'Bitte eine Datei wählen.'; errEl.style.display = 'block'; return; }
  // Der Server begrenzt den Request-Body auf 10 MB; Base64 bläht um ~4/3 auf.
  if (f.size > 7 * 1024 * 1024) {
    errEl.textContent = `Datei zu groß (${formatBytes(f.size)}) — höchstens 7 MB.`;
    errEl.style.display = 'block'; return;
  }
  const buf = await f.arrayBuffer();
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  const r = await api('/api/docker/container/upload', {
    method: 'POST',
    body: JSON.stringify({
      id: document.getElementById('dk-up-id').value,
      path: document.getElementById('dk-up-path').value.trim(),
      name: f.name, data_b64: btoa(bin)
    })
  });
  if (r.error) { errEl.textContent = r.error; errEl.style.display = 'block'; return; }
  dkCloseUpload();
  toast(`Hochgeladen: ${f.name} (${formatBytes(r.bytes)})`, 'success');
}

async function dkDownloadArchive(id) {
  const p = await dkPromptModal('Aus dem Container herunterladen',
                                'Pfad im Container', '/etc/nginx', '/');
  if (!p) return;
  window.location.href =
    `/api/docker/container/archive?id=${encodeURIComponent(id)}&path=${encodeURIComponent(p)}`;
}

// ─── Docker: Container-Assistent ───────────────────

async function dkOpenCreate(prefillImage) {
  ['dk-cr-name', 'dk-cr-cmd', 'dk-cr-entry', 'dk-cr-user', 'dk-cr-workdir',
   'dk-cr-ports', 'dk-cr-vols', 'dk-cr-env', 'dk-cr-labels', 'dk-cr-mem',
   'dk-cr-cpus', 'dk-cr-caps'].forEach(i => document.getElementById(i).value = '');
  document.getElementById('dk-cr-image').value = prefillImage || '';
  document.getElementById('dk-cr-restart').value = 'unless-stopped';
  document.getElementById('dk-cr-privileged').checked = false;
  document.getElementById('dk-cr-tty').checked = false;
  document.getElementById('dk-cr-start').checked = true;
  document.getElementById('dk-cr-err').style.display = 'none';
  document.getElementById('dk-cr-btn').disabled = false;
  document.getElementById('dk-cr-btn').textContent = 'Erstellen';
  document.getElementById('dk-create-modal').style.display = 'flex';
  // Netzwerkauswahl frisch befüllen
  const sel = document.getElementById('dk-cr-net');
  if (!_dkCache.networks.length) {
    const d = await api('/api/docker/networks');
    if (!d.error) _dkCache.networks = d.networks || [];
  }
  sel.innerHTML = '<option value="">Vorgabe (bridge)</option>' +
    _dkCache.networks.filter(n => n.name !== 'none')
      .map(n => `<option value="${escHtml(n.name)}">${escHtml(n.name)} (${escHtml(n.driver)})</option>`).join('');
}
function dkCloseCreate() { document.getElementById('dk-create-modal').style.display = 'none'; }

function dkLines(id) {
  return document.getElementById(id).value.split('\n').map(s => s.trim()).filter(Boolean);
}

async function dkDoCreate() {
  const errEl = document.getElementById('dk-cr-err');
  const btn   = document.getElementById('dk-cr-btn');
  errEl.style.display = 'none';
  const v = i => document.getElementById(i).value.trim();
  if (!v('dk-cr-image')) {
    errEl.textContent = 'Bitte ein Image angeben.'; errEl.style.display = 'block'; return;
  }
  if (document.getElementById('dk-cr-privileged').checked) {
    const ok = await uiConfirm(
      'Container wirklich mit „Privileged" starten?\n\n' +
      'Damit hat er faktisch vollen Zugriff auf den Host — inklusive aller ' +
      'Geräte und Kernel-Fähigkeiten. Nur verwenden, wenn es wirklich nötig ist.',
      { danger: true, okLabel: 'Trotzdem erstellen' });
    if (!ok) return;
  }
  btn.disabled = true; btn.textContent = 'Erstelle…';
  const caps = v('dk-cr-caps').split(',').map(s => s.trim()).filter(Boolean);
  const r = await api('/api/docker/container/create', {
    method: 'POST',
    body: JSON.stringify({
      image: v('dk-cr-image'), name: v('dk-cr-name'), cmd: v('dk-cr-cmd'),
      entrypoint: v('dk-cr-entry'), user: v('dk-cr-user'), workdir: v('dk-cr-workdir'),
      ports: dkLines('dk-cr-ports'), volumes: dkLines('dk-cr-vols'),
      env: dkLines('dk-cr-env'), labels: dkLines('dk-cr-labels'),
      network: document.getElementById('dk-cr-net').value,
      restart: document.getElementById('dk-cr-restart').value,
      memory_mb: v('dk-cr-mem') || undefined, cpus: v('dk-cr-cpus') || undefined,
      privileged: document.getElementById('dk-cr-privileged').checked,
      tty: document.getElementById('dk-cr-tty').checked,
      cap_add: caps,
      start: document.getElementById('dk-cr-start').checked
    })
  });
  btn.disabled = false; btn.textContent = 'Erstellen';
  if (r.error) {
    // Sonderfall: angelegt, aber der Start scheiterte (z. B. Port belegt).
    // Der Container liegt dann im Zustand „created" herum — das muss man
    // erfahren, sonst sammeln sich Leichen an.
    errEl.textContent = r.error + (r.created
      ? ` — der Container wurde bereits angelegt (${(r.id || '').slice(0, 12)}) und liegt gestoppt vor.`
      : '');
    errEl.style.display = 'block';
    if (r.created) loadDocker(true);
    return;
  }
  dkCloseCreate();
  toast('Container erstellt: ' + r.short_id +
        ((r.warnings || []).length ? ' (' + r.warnings.join('; ') + ')' : ''), 'success', 7000);
  loadDocker(true);
}

// ─── Zugriff / Sichtbarkeit (Superadmin): VM-Besitzer + Freigabelisten ──────────

async function _accessUserList() {
  const r = await api('/api/users');
  if (r.error) return { error: r.error };
  const arr = Array.isArray(r) ? r : (r.users || []);
  return { users: arr.filter(u => u.username !== 'root') };
}

async function renderVMDAccess(d) {
  const el = document.getElementById('vmdtab-access'); if (!el) return;
  const name = d.name || _vmDetailName || '';
  el.innerHTML = '<div class="loading-overlay"><span class="spinner"></span></div>';
  const [ul, acc] = await Promise.all([_accessUserList(), api(`/api/vm/access?name=${encodeURIComponent(name)}`)]);
  if (ul.error || acc.error) { el.innerHTML = `<div class="empty-state"><p>${escHtml(ul.error || acc.error)}</p></div>`; return; }
  const viewers = new Set(acc.viewers || []);
  el.innerHTML = `
    <div class="card">
      <div class="card-title">Besitzer &amp; Sichtbarkeit</div>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:14px;line-height:1.5;">
        Der <b>Besitzer</b> verwaltet die VM vollständig (Admin-Rolle vorausgesetzt).
        <b>Sichtbar für</b>: diese Benutzer sehen die VM, dürfen sie starten/stoppen und die Konsole
        öffnen, aber nichts an der Konfiguration ändern — unabhängig von ihrer Rolle.
      </p>
      <label class="conn-label">Besitzer</label>
      <select id="vmd-acc-owner" class="conn-input" style="appearance:auto;max-width:320px;margin-bottom:16px;">
        <option value="">— kein Besitzer (nur Superadmins)</option>
        ${ul.users.map(u => `<option value="${escHtml(u.username)}" ${u.username === acc.owner ? 'selected' : ''}>${escHtml(u.username)}${u.is_admin ? ' (Admin)' : ''}</option>`).join('')}
      </select>
      <label class="conn-label">Sichtbar für</label>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:8px;margin:8px 0 18px;">
        ${ul.users.map(u => `<label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;"><input type="checkbox" class="vmd-acc-cb" value="${escHtml(u.username)}" ${viewers.has(u.username) ? 'checked' : ''} style="accent-color:var(--accent);"> ${escHtml(u.username)}${u.is_admin ? ' <span style="color:var(--text-muted);font-size:11px;">Admin</span>' : ''}</label>`).join('') || '<span style="color:var(--text-muted);font-size:12px;">Keine Benutzer</span>'}
      </div>
      <button class="btn btn-primary" onclick="saveVMDAccess('${escHtml(name)}')">Speichern</button>
    </div>`;
}

async function saveVMDAccess(name) {
  const owner = document.getElementById('vmd-acc-owner')?.value || '';
  const viewers = [...document.querySelectorAll('.vmd-acc-cb:checked')].map(c => c.value);
  const r = await api('/api/vm/access', { method: 'POST', body: JSON.stringify({ name, owner, viewers }) });
  if (r.error) { toast('Fehler: ' + r.error, 'error', 7000); return; }
  toast('Zugriff gespeichert', 'success');
  if (_vmDetailData) { _vmDetailData.owner = r.owner; _vmDetailData.viewers = r.viewers; }
  renderVMDAccess(_vmDetailData || { name });
}

let _accessModalCb = null;

async function openAccessModal(title, hint, selected, onSave) {
  const m = document.getElementById('access-modal'); if (!m) return;
  document.getElementById('access-modal-title').textContent = title;
  document.getElementById('access-modal-hint').textContent = hint || '';
  document.getElementById('access-modal-err').style.display = 'none';
  const list = document.getElementById('access-modal-list');
  list.innerHTML = '<div class="loading-overlay"><span class="spinner"></span></div>';
  _accessModalCb = onSave;
  m.style.display = 'flex';
  const ul = await _accessUserList();
  if (ul.error) { list.innerHTML = `<span style="color:var(--text-muted);font-size:12px;">${escHtml(ul.error)}</span>`; return; }
  const sel = new Set(selected || []);
  list.innerHTML = ul.users.map(u => `<label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;"><input type="checkbox" class="access-modal-cb" value="${escHtml(u.username)}" ${sel.has(u.username) ? 'checked' : ''} style="accent-color:var(--accent);"> ${escHtml(u.username)}${u.is_admin ? ' <span style="color:var(--text-muted);font-size:11px;">Admin</span>' : ''}</label>`).join('')
    || '<span style="color:var(--text-muted);font-size:12px;">Keine Benutzer</span>';
}

function closeAccessModal() {
  const m = document.getElementById('access-modal'); if (m) m.style.display = 'none';
  _accessModalCb = null;
}

async function saveAccessModal() {
  const viewers = [...document.querySelectorAll('.access-modal-cb:checked')].map(c => c.value);
  const btn = document.getElementById('access-modal-btn'); btn.disabled = true;
  try {
    const err = _accessModalCb ? await _accessModalCb(viewers) : null;
    if (err) { const e = document.getElementById('access-modal-err'); e.textContent = err; e.style.display = 'block'; return; }
    closeAccessModal();
  } finally { btn.disabled = false; }
}

function openBrowserAccess(sid, btn) {
  let cur = [];
  try { cur = JSON.parse(btn?.dataset?.viewers || '[]'); } catch (_) {}
  openAccessModal('Browser-Session sichtbar für',
    'Freigegebene Benutzer sehen diese Session in ihrer Liste und können sie öffnen, einfrieren und auftauen — aber nicht beenden.',
    cur, async viewers => {
      const r = await api('/api/browser/access', { method: 'POST', body: JSON.stringify({ id: sid, viewers }) });
      if (r.error) return r.error;
      toast('Sichtbarkeit gespeichert', 'success');
      loadBrowserSessions(true);
      return null;
    });
}

document.addEventListener('DOMContentLoaded', () => {
  const m = document.getElementById('access-modal');
  if (m) m.addEventListener('click', e => { if (e.target === e.currentTarget) closeAccessModal(); });
});


// ─── Sicherheit: fail2ban-/Login-Meldungen, Sperren, Entsperren ─────
// Backend: dashboard/security.py (nur Superadmins). Meldungen werden
// serverseitig gefiltert/sortiert/geblättert (zusammen > 20 000 Zeilen),
// die Sperrliste (einige hundert) kommt komplett und wird hier gefiltert.

const _sec = {
  bans: [], banSearch: '', banApp: '', apps: {}, app: '', appCounts: {}, banSort: 'since', banDesc: true, myIp: '',
  q: '', source: '', kinds: new Set(), sort: 'ts', desc: true,
  events: [], total: 0, counts: {}, pageSize: 200, seq: 0, timer: null, wired: false,
};

const _SEC_KIND_LABEL = {
  login: 'Login', login_new: 'Login (neue IP)', found: 'Fehlversuch', ban: 'Gesperrt',
  unban: 'Entsperrt', cf_ban: 'CF gesperrt', cf_unban: 'CF entsperrt',
  manual_unban: 'Manuell entsperrt', warn: 'Warnung', info: 'Info',
  // Dauersperre (seit 08.10.2026): perm_count = eine Kurzsperre wurde gezählt,
  // expired = Kurzsperre abgelaufen, die IP bleibt aber dauerhaft gesperrt.
  perm_count: 'Sperre gezählt', perm_ban: 'Dauerhaft gesperrt', expired: 'Kurzsperre abgelaufen',
};
const _SEC_SOURCE_LABEL = { fail2ban: 'fail2ban', cloudflare: 'Cloudflare', login: 'Login-Wächter', dashboard: 'Dashboard' };

// Werte aus Logzeilen in onclick: als JSON-Literal, dann HTML-escapen
function _secJs(v) { return escHtml(JSON.stringify(String(v))); }

function _secTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' }) + ' ' +
         d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function _secRel(sec) {
  const a = Math.abs(sec);
  if (a < 60) return `${Math.round(a)} s`;
  if (a < 3600) return `${Math.round(a / 60)} Min`;
  if (a < 86400 * 2) return `${Math.round(a / 3600)} Std`;
  return `${Math.round(a / 86400)} Tg`;
}

function _secWire() {
  if (_sec.wired) return;
  _sec.wired = true;
  let tBan = null, tEv = null;
  document.getElementById('sec-ban-search').addEventListener('input', e => {
    clearTimeout(tBan);
    tBan = setTimeout(() => { _sec.banSearch = e.target.value.trim().toLowerCase(); renderSecBans(); }, 150);
  });
  document.getElementById('sec-ev-search').addEventListener('input', e => {
    clearTimeout(tEv);
    tEv = setTimeout(() => { _sec.q = e.target.value.trim(); loadSecEvents(); }, 300);
  });
  document.getElementById('sec-source').addEventListener('change', e => { _sec.source = e.target.value; loadSecEvents(); });
  document.getElementById('sec-app').addEventListener('change', e => { _sec.app = e.target.value; loadSecEvents(); });
  document.querySelectorAll('#page-security th[data-esort]').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.esort;
    if (_sec.sort === k) _sec.desc = !_sec.desc; else { _sec.sort = k; _sec.desc = k === 'ts'; }
    loadSecEvents();
  }));
  document.querySelectorAll('#page-security th[data-bsort]').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.bsort;
    if (_sec.banSort === k) _sec.banDesc = !_sec.banDesc;
    else { _sec.banSort = k; _sec.banDesc = ['since', 'until', 'bancount'].includes(k); }
    renderSecBans();
  }));
  // Auto-Aktualisierung nur, solange der Reiter offen und sichtbar ist
  _sec.timer = setInterval(() => {
    if (currentPage !== 'security' || document.visibilityState !== 'visible') return;
    if (!document.getElementById('sec-auto').checked) return;
    loadSecBans(); loadSecEvents(true);
  }, 30000);
}

function loadSecurity() {
  _secWire();
  idsStart();
  loadSecBans();
  loadSecEvents();
}

// ─── IDS-Wächter live (seit 09.10.2026) ─────────────────────────────
// Backend: dashboard/ids.py, GET /api/security/ids. Aktualisiert sich alle
// 3 s, solange der Reiter offen und sichtbar ist (unabhängig von "Auto").
// Datenverkehr kommt als Delta (?since=), Balken + Status jedes Mal komplett.
// Farben: geprüfte kategoriale Palette (dataviz-Validator, dunkle Fläche).
const _ids = {
  timer: null, wired: false, range: '60', traffic: [], data: null, lastT: 0, busy: false,
  series: {
    angriff: { label: 'Angreifer gesperrt', color: '#3987e5' },
    ausgang: { label: 'Ziel nach außen gesperrt', color: '#d95926' },
    notiert: { label: 'Nur notiert', color: '#2f7fd6' },
    warnung: { label: 'DNS-Warnung', color: '#c98500' },
  },
  lines: { rx: { label: 'Eingehend', color: '#3987e5' }, tx: { label: 'Ausgehend', color: '#d95926' } },
  hover: { traffic: null, bars: null },
};

function idsStart() {
  if (!_ids.wired) {
    _ids.wired = true;
    document.querySelectorAll('#ids-card .ids-range-btn').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('#ids-card .ids-range-btn').forEach(x => x.classList.toggle('active', x === b));
      _ids.range = b.dataset.range;
      document.getElementById('ids-bar-sub').textContent =
        _ids.range === '60' ? 'je Minute · letzte Stunde' : 'je 30 Min · letzte 24 Std';
      idsLoad();
    }));
    document.getElementById('ids-leg-traffic').innerHTML = Object.values(_ids.lines)
      .map(l => `<span><i class="line" style="background:${l.color}"></i>${l.label}</span>`).join('');
    document.getElementById('ids-leg-bars').innerHTML = Object.values(_ids.series)
      .map(l => `<span><i style="background:${l.color}"></i>${l.label}</span>`).join('');
    _idsHover('traffic'); _idsHover('bars');
    window.addEventListener('resize', () => { if (currentPage === 'security') idsDraw(); });
    _ids.timer = setInterval(() => {
      if (currentPage !== 'security' || document.visibilityState !== 'visible') {
        document.getElementById('ids-live-dot').classList.remove('on');
        return;
      }
      idsLoad();
    }, 3000);
  }
  idsLoad();
}

async function idsLoad() {
  if (_ids.busy) return;
  _ids.busy = true;
  try {
    const d = await api(`/api/security/ids?range=${_ids.range}&since=${_ids.lastT}`);
    const dot = document.getElementById('ids-live-dot');
    if (!d || d.error) { dot.classList.remove('on'); return; }
    dot.classList.add('on');
    if (d.traffic.length) {
      _ids.traffic = _ids.traffic.concat(d.traffic);
      _ids.lastT = d.traffic[d.traffic.length - 1][0];
    }
    const cut = d.now - 600;
    _ids.traffic = _ids.traffic.filter(p => p[0] >= cut);
    _ids.data = d;
    if (d.iface) document.getElementById('ids-iface').textContent = d.iface;
    idsRenderTiles(d);
    idsRenderRecent(d.recent || []);
    idsDraw();
  } finally { _ids.busy = false; }
}

function _idsMbit(v) {
  const m = v / 1e6;
  return m.toLocaleString('de-DE', { maximumFractionDigits: m >= 100 ? 0 : m >= 10 ? 1 : 2, minimumFractionDigits: m >= 100 ? 0 : m >= 10 ? 1 : 2 });
}
function _idsNum(n) { return n == null ? '–' : Number(n).toLocaleString('de-DE'); }

function idsRenderTiles(d) {
  const s = d.status || {};
  const st = v => v === 'active' ? ['ok', 'läuft'] : ['bad', escHtml(v || 'unbekannt')];
  const [sc, sl] = st(s.suricata), [wc, wl] = st(s.ids_watch);
  const modusOk = s.modus === 'sperren';
  const verlust = s.pakete ? (100 * (s.verworfen || 0) / s.pakete) : null;
  const t = d.tag || {};
  const last = _ids.traffic[_ids.traffic.length - 1];
  const tiles = [
    ['Suricata', `<span class="ids-state ${sc}">${sl}</span>`,
      s.pakete != null ? `${_idsNum(s.pakete)} Pakete · Verlust ${verlust.toFixed(2).replace('.', ',')} %` : 'Paketzähler nicht lesbar'],
    ['Wächter', `<span class="ids-state ${wc}">${wl}</span>`,
      `Modus: <b style="color:var(--text-primary)">${escHtml(s.modus || '?')}</b>${modusOk ? '' : ' (sperrt nicht)'}`],
    ['Aktive IDS-Sperren', _idsNum(s.sperren), 'ipset ids_ban4/6'],
    ['24 Std gesperrt', _idsNum(t.angriff), 'Angreifer von außen'],
    ['24 Std nach außen', _idsNum((t.ausgang || 0) + (t.warnung || 0)),
      (t.ausgang || t.warnung) ? `<span style="color:var(--red)">${_idsNum(t.ausgang)} Ziele, ${_idsNum(t.warnung)} DNS — prüfen!</span>` : 'keine verdächtigen Ziele'],
    ['Jetzt', last ? `<span class="ids-now">↓ ${_idsMbit(last[1])}</span> <span class="ids-now">↑ ${_idsMbit(last[2])}</span>` : '–',
      'Mbit/s ein / aus'],
  ];
  document.getElementById('ids-tiles').innerHTML = tiles.map(([l, v, sub]) =>
    `<div class="ids-tile"><div class="ids-tile-label">${l}</div><div class="ids-tile-val">${v}</div><div class="ids-tile-sub">${sub}</div></div>`).join('');
}

function idsRenderRecent(list) {
  const tb = document.getElementById('ids-recent-tbody');
  if (!list.length) {
    tb.innerHTML = '<tr><td colspan="4" style="color:var(--text-muted)">Noch keine Sperren oder Warnungen.</td></tr>';
    return;
  }
  tb.innerHTML = list.map(e => {
    const s = _ids.series[e.art] || _ids.series.notiert;
    return `<tr><td style="white-space:nowrap">${_secTime(e.ts)}</td>
      <td><span class="ids-art"><i style="background:${s.color}"></i>${escHtml(s.label)}</span></td>
      <td><span class="sec-ip" onclick="secSearchIp(${_secJs(e.ip)})">${escHtml(e.ip)}</span></td>
      <td class="sig">${escHtml(e.sig)}${e.detail ? ` <span style="color:var(--text-muted)">· ${escHtml(e.detail)}</span>` : ''}</td></tr>`;
  }).join('');
}

// Canvas auf Gerätepixel einstellen, liefert Kontext + CSS-Maße
function _idsCanvas(id) {
  const c = document.getElementById(id);
  const r = c.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(10, Math.round(r.width)), h = Math.max(10, Math.round(r.height));
  if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}

// "schöne" Obergrenze + Teilstriche
function _idsNice(max) {
  if (max <= 0) return { top: 1, step: 0.5 };
  const p = Math.pow(10, Math.floor(Math.log10(max)));
  const f = max / p;
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return { top: n * p, step: n * p / (n === 2.5 ? 5 : n === 1 || n === 10 ? 4 : n === 2 ? 4 : 5) };
}

const _IDS_PAD = { l: 38, r: 8, t: 8, b: 20 };
const _idsCss = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

function _idsAxes(g, w, h, top, step, fmt) {
  const P = _IDS_PAD, ph = h - P.t - P.b;
  g.font = '10px ' + (_idsCss('--font-sans') || 'sans-serif');
  g.textAlign = 'right'; g.textBaseline = 'middle';
  for (let v = 0; v <= top + 1e-9; v += step) {
    const y = Math.round(P.t + ph - (v / top) * ph) + 0.5;
    g.strokeStyle = v === 0 ? _idsCss('--border-mid') : _idsCss('--border-dim');
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(P.l, y); g.lineTo(w - P.r, y); g.stroke();
    g.fillStyle = _idsCss('--text-muted');
    g.fillText(fmt(v), P.l - 6, y);
  }
}

function _idsTimeLabels(g, w, h, t0, t1, n, fmt) {
  const P = _IDS_PAD, pw = w - P.l - P.r;
  g.fillStyle = _idsCss('--text-muted'); g.textBaseline = 'alphabetic';
  for (let i = 0; i <= n; i++) {
    const t = t0 + (t1 - t0) * i / n;
    g.textAlign = i === 0 ? 'left' : i === n ? 'right' : 'center';
    g.fillText(fmt(t), P.l + pw * i / n, h - 5);
  }
}
const _idsHm = t => new Date(t * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

function idsDraw() {
  if (!_ids.data || currentPage !== 'security') return;
  _idsDrawTraffic(); _idsDrawBars();
}

function _idsDrawTraffic() {
  const { g, w, h } = _idsCanvas('ids-chart-traffic');
  const P = _IDS_PAD, pw = w - P.l - P.r, ph = h - P.t - P.b;
  const pts = _ids.traffic, t1 = _ids.data.now, t0 = t1 - 600;
  const max = Math.max(1e5, ...pts.map(p => Math.max(p[1], p[2])));
  const { top, step } = _idsNice(max / 1e6);
  _idsAxes(g, w, h, top, step, v => v.toLocaleString('de-DE', { maximumFractionDigits: 3 }));
  _idsTimeLabels(g, w, h, t0, t1, w < 480 ? 3 : 5, _idsHm);
  const X = t => P.l + (t - t0) / 600 * pw, Y = v => P.t + ph - Math.min(1, v / 1e6 / top) * ph;
  _ids.geomT = { X, Y, t0, t1 };
  for (const [k, idx] of [['rx', 1], ['tx', 2]]) {
    g.strokeStyle = _ids.lines[k].color; g.lineWidth = 2; g.lineJoin = 'round'; g.lineCap = 'round';
    g.beginPath();
    pts.forEach((p, i) => { const x = X(p[0]), y = Y(p[idx]); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke();
  }
  const hv = _ids.hover.traffic;
  if (hv != null && pts.length) {
    let best = pts[0];
    for (const p of pts) if (Math.abs(X(p[0]) - hv) < Math.abs(X(best[0]) - hv)) best = p;
    const x = Math.round(X(best[0])) + 0.5;
    g.strokeStyle = _idsCss('--text-muted'); g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, P.t); g.lineTo(x, P.t + ph); g.stroke();
    for (const [k, idx] of [['rx', 1], ['tx', 2]]) {
      g.fillStyle = _ids.lines[k].color; g.strokeStyle = _idsCss('--bg-input'); g.lineWidth = 2;
      g.beginPath(); g.arc(x, Y(best[idx]), 4, 0, 7); g.fill(); g.stroke();
    }
    _idsTip('traffic', x, `<b>${new Date(best[0] * 1000).toLocaleTimeString('de-DE')}</b>` +
      `<div class="r"><i style="background:${_ids.lines.rx.color}"></i>Eingehend<span>${_idsMbit(best[1])} Mbit/s</span></div>` +
      `<div class="r"><i style="background:${_ids.lines.tx.color}"></i>Ausgehend<span>${_idsMbit(best[2])} Mbit/s</span></div>`);
  }
}

function _idsDrawBars() {
  const { g, w, h } = _idsCanvas('ids-chart-bars');
  const P = _IDS_PAD, pw = w - P.l - P.r, ph = h - P.t - P.b;
  const d = _ids.data, bars = d.bars, keys = d.series;
  const tot = b => keys.reduce((s, _, i) => s + b[i + 1], 0);
  const { top, step } = _idsNice(Math.max(4, ...bars.map(tot)));
  _idsAxes(g, w, h, top, step, v => Number.isInteger(v) ? v.toLocaleString('de-DE') : '');
  const n = bars.length, slot = pw / n, gap = slot > 6 ? 2 : 1, bw = Math.max(1, slot - gap);
  const t0 = bars[0][0], t1 = bars[n - 1][0] + d.bar_s;
  _idsTimeLabels(g, w, h, t0, t1, w < 480 ? 3 : 4, _idsHm);
  _ids.geomB = { slot, n };
  const hv = _ids.hover.bars;
  const hi = hv == null ? -1 : Math.floor((hv - P.l) / slot);
  bars.forEach((b, i) => {
    let y = P.t + ph;
    const x = P.l + i * slot + gap / 2;
    const segs = keys.map((k, j) => [k, b[j + 1]]).filter(s => s[1] > 0);
    segs.forEach(([k, v], j) => {
      const hh = v / top * ph;
      const isTop = j === segs.length - 1;
      g.globalAlpha = hi >= 0 && hi !== i ? 0.45 : 1;
      g.fillStyle = _ids.series[k].color;
      const y0 = y - hh, sh = Math.max(0, hh - (isTop ? 0 : 1));   // 1px Fuge zwischen Segmenten
      if (isTop && bw >= 6 && sh > 3) {
        const r = Math.min(4, bw / 2, sh);
        g.beginPath(); g.moveTo(x, y0 + sh); g.lineTo(x, y0 + r); g.arcTo(x, y0, x + r, y0, r);
        g.lineTo(x + bw - r, y0); g.arcTo(x + bw, y0, x + bw, y0 + r, r); g.lineTo(x + bw, y0 + sh); g.closePath(); g.fill();
      } else g.fillRect(x, y0 + (isTop ? 0 : 1), bw, sh);
      y -= hh;
    });
  });
  g.globalAlpha = 1;
  if (hi >= 0 && hi < n) {
    const b = bars[hi], von = _idsHm(b[0]), bis = _idsHm(b[0] + d.bar_s);
    _idsTip('bars', P.l + (hi + 0.5) * slot, `<b>${von}–${bis}</b>` +
      keys.map((k, j) => `<div class="r"><i style="background:${_ids.series[k].color}"></i>${_ids.series[k].label}<span>${_idsNum(b[j + 1])}</span></div>`).join(''));
  }
}

function _idsTip(which, x, html) {
  const tip = document.getElementById('ids-tip-' + which);
  tip.innerHTML = html; tip.style.display = 'block';
  const wrap = tip.parentElement.getBoundingClientRect();
  const tw = tip.offsetWidth;
  let left = x + 12;
  if (left + tw > wrap.width) left = x - tw - 12;
  tip.style.left = Math.max(0, left) + 'px'; tip.style.top = '6px';
}

function _idsHover(which) {
  const c = document.getElementById('ids-chart-' + which);
  const tip = document.getElementById('ids-tip-' + which);
  const set = e => {
    const r = c.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
    _ids.hover[which] = x >= _IDS_PAD.l && x <= r.width - _IDS_PAD.r ? x : null;
    if (_ids.hover[which] == null) tip.style.display = 'none';
    which === 'traffic' ? _idsDrawTraffic() : _idsDrawBars();
  };
  const clear = () => { _ids.hover[which] = null; tip.style.display = 'none'; which === 'traffic' ? _idsDrawTraffic() : _idsDrawBars(); };
  c.addEventListener('mousemove', set);
  c.addEventListener('mouseleave', clear);
  c.addEventListener('touchstart', set, { passive: true });
  c.addEventListener('touchmove', set, { passive: true });
  c.addEventListener('touchend', () => setTimeout(clear, 1500));
}

async function loadSecBans() {
  const d = await api('/api/security/bans');
  const tb = document.getElementById('sec-ban-tbody');
  if (d.error) {
    tb.innerHTML = `<tr><td colspan="7" style="color:var(--red)">${escHtml(d.error)}</td></tr>`;
    return;
  }
  _sec.bans = d.bans || [];
  _sec.myIp = d.my_ip || '';
  _sec.now = d.now || Date.now() / 1000;
  _sec.jails = d.jails || {};
  _sec.apps = d.apps || {};
  document.getElementById('sec-ban-count').textContent = _sec.bans.length;
  const mine = _sec.bans.find(b => b.mine);
  document.getElementById('sec-myip').innerHTML = _sec.myIp
    ? `Deine aktuelle IP: <span class="sec-ip" onclick="secSearchIp(${_secJs(_sec.myIp)})">${escHtml(_sec.myIp)}</span>` +
      (mine ? ' — <b style="color:var(--red)">ist gesperrt!</b>' : '')
    : '';
  renderSecBans();
}

function renderSecBans() {
  const chips = document.getElementById('sec-jail-chips');
  // Alle Anwendungen, auch ohne Sperre (Reihenfolge vom Backend). null = keine
  // fail2ban-Jail (play4cash, fremdes Cloudflare-Konto) → ausgegraut.
  chips.innerHTML = `<button class="sec-chip ${_sec.banApp ? '' : 'on'}" onclick="secBanApp('')">Alle<span class="n">${_sec.bans.length}</span></button>` +
    Object.entries(_sec.apps).map(([a, n]) => n === null
      ? `<button class="sec-chip sec-chip-off" disabled title="Keine fail2ban-Sperre für diese Anwendung">${escHtml(a)}<span class="n">–</span></button>`
      : `<button class="sec-chip ${_sec.banApp === a ? 'on' : ''} ${n ? '' : 'sec-chip-zero'}" onclick="secBanApp(${_secJs(a)})">${escHtml(a)}<span class="n">${n}</span></button>`).join('');

  const q = _sec.banSearch;
  let list = _sec.bans.filter(b => {
    if (_sec.banApp && !(b.apps || []).includes(_sec.banApp)) return false;
    if (!q) return true;
    const hay = (b.ip + ' ' + b.jails.map(j => j.jail + ' ' + j.app).join(' ') + ' ' + (b.known || []).join(' ')).toLowerCase();
    return q.split(/\s+/).every(t => hay.includes(t));
  });
  const k = _sec.banSort, dir = _sec.banDesc ? -1 : 1;
  const val = b => k === 'jails' ? b.jails.map(j => j.jail).join(',')
                 : k === 'until' ? (b.until === -1 ? Infinity : b.until) : b[k];
  list.sort((a, b) => {
    const x = val(a), y = val(b);
    if (k === 'ip') return dir * String(x).localeCompare(String(y), undefined, { numeric: true });
    return dir * (x > y ? 1 : x < y ? -1 : 0);
  });
  document.querySelectorAll('#page-security th[data-bsort]').forEach(th => {
    th.classList.toggle('sorted', th.dataset.bsort === k);
    th.classList.toggle('asc', th.dataset.bsort === k && !_sec.banDesc);
  });

  const tb = document.getElementById('sec-ban-tbody');
  if (!list.length) {
    tb.innerHTML = `<tr><td colspan="7" style="color:var(--text-muted)">${_sec.bans.length ? 'Keine Treffer.' : 'Keine aktiven Sperren.'}</td></tr>`;
    return;
  }
  const now = _sec.now || Date.now() / 1000;
  tb.innerHTML = list.map(b => {
    const ip = escHtml(b.ip);
    const tags = (b.mine ? '<span class="sec-tag mine">DEINE IP</span>' : '') +
      ((b.known || []).length ? `<span class="sec-tag known" title="Hat sich hier schon erfolgreich angemeldet: ${escHtml(b.known.join(', '))}">bekannt</span>` : '');
    const jails = b.jails.map(j => `<span class="sec-tag ${_secWebJail(j.jail) ? 'web' : ''}" title="Jail ${escHtml(j.jail)}">${escHtml(j.app || j.jail)}${j.app && j.app !== j.jail ? ` <span style="opacity:.6">${escHtml(j.jail)}</span>` : ''}</span>`).join('');
    const until = b.until === -1 ? 'dauerhaft' : b.until ? `in ${_secRel(b.until - now)}` : '—';
    return `<tr class="${b.mine ? 'sec-row-mine' : ''}">
      <td class="sec-ban-ip"><span class="sec-ip" title="Meldungen zu dieser IP" onclick="secSearchIp(${_secJs(b.ip)})">${ip}</span> ${tags}</td>
      <td class="sec-wrap">${jails}</td>
      <td title="${escHtml(_secTime(b.since))}">${b.since ? 'vor ' + _secRel(now - b.since) : '—'}</td>
      <td title="${b.until > 0 ? escHtml(_secTime(b.until)) : ''}"><span class="sec-mlabel">bis </span>${until}</td>
      <td>${b.bancount || 1}×</td>
      <td title="${b.cloudflare ? 'Auch am Cloudflare-Rand gesperrt' : 'Nur am Server (ipset)'}">${b.cloudflare ? '☁ CF' : 'Server'}</td>
      <td class="sec-ban-act"><button class="btn btn-sm btn-danger" onclick="secUnban(${_secJs(b.ip)})">Entsperren</button></td>
    </tr>`;
  }).join('');
}

function _secWebJail(j) { return !/^sshd/.test(j); }
function secBanApp(a) { _sec.banApp = _sec.banApp === a ? '' : a; renderSecBans(); }

async function loadSecEvents(keepCount) {
  const seq = ++_sec.seq;
  const limit = keepCount ? Math.min(Math.max(_sec.events.length, _sec.pageSize), 2000) : _sec.pageSize;
  const params = new URLSearchParams({
    q: _sec.q, sources: _sec.source, apps: _sec.app, kinds: [..._sec.kinds].join(','),
    sort: _sec.sort, dir: _sec.desc ? 'desc' : 'asc', limit, offset: 0,
  });
  const d = await api('/api/security/events?' + params);
  if (seq !== _sec.seq) return;   // überholt von einer neueren Suche
  if (d.error) {
    document.getElementById('sec-ev-tbody').innerHTML = `<tr><td colspan="7" style="color:var(--red)">${escHtml(d.error)}</td></tr>`;
    return;
  }
  _sec.events = d.events || [];
  _sec.total = d.total || 0;
  _sec.counts = d.counts || {};
  _sec.appCounts = d.app_counts || {};
  renderSecEvents();
}

async function secMoreEvents() {
  const seq = ++_sec.seq;
  const params = new URLSearchParams({
    q: _sec.q, sources: _sec.source, apps: _sec.app, kinds: [..._sec.kinds].join(','),
    sort: _sec.sort, dir: _sec.desc ? 'desc' : 'asc', limit: _sec.pageSize, offset: _sec.events.length,
  });
  const d = await api('/api/security/events?' + params);
  if (seq !== _sec.seq || d.error) return;
  _sec.events = _sec.events.concat(d.events || []);
  _sec.total = d.total || 0;
  renderSecEvents();
}

function secToggleKind(k) {
  if (!k) _sec.kinds.clear();
  else if (_sec.kinds.has(k)) _sec.kinds.delete(k);
  else _sec.kinds.add(k);
  loadSecEvents();
}

function secSearchIp(ip) {
  const inp = document.getElementById('sec-ev-search');
  inp.value = ip;
  _sec.q = ip;
  loadSecEvents();
  inp.closest('.card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderSecEvents() {
  const all = Object.values(_sec.counts).reduce((a, b) => a + b, 0);
  const order = ['login', 'login_new', 'found', 'perm_count', 'ban', 'perm_ban', 'unban', 'expired', 'cf_ban', 'cf_unban', 'manual_unban', 'warn', 'info'];
  document.getElementById('sec-kind-chips').innerHTML =
    `<button class="sec-chip ${_sec.kinds.size ? '' : 'on'}" onclick="secToggleKind('')">Alle<span class="n">${all}</span></button>` +
    order.filter(k => _sec.counts[k]).map(k =>
      `<button class="sec-chip ${_sec.kinds.has(k) ? 'on' : ''}" onclick="secToggleKind(${_secJs(k)})">${_SEC_KIND_LABEL[k]}<span class="n">${_sec.counts[k]}</span></button>`).join('');
  document.getElementById('sec-ev-count').textContent = _sec.total;
  const sel = document.getElementById('sec-app');
  sel.innerHTML = '<option value="">Alle Anwendungen</option>' + Object.entries(_sec.appCounts).map(([a, n]) =>
    `<option value="${escHtml(a)}" ${_sec.app === a ? 'selected' : ''}>${escHtml(a)} (${n})</option>`).join('');
  document.querySelectorAll('#page-security th[data-esort]').forEach(th => {
    th.classList.toggle('sorted', th.dataset.esort === _sec.sort);
    th.classList.toggle('asc', th.dataset.esort === _sec.sort && !_sec.desc);
  });

  const banned = new Map(_sec.bans.map(b => [b.ip, b.until]));
  const tb = document.getElementById('sec-ev-tbody');
  if (!_sec.events.length) {
    tb.innerHTML = '<tr><td colspan="7" style="color:var(--text-muted)">Keine Meldungen gefunden.</td></tr>';
  } else {
    tb.innerHTML = _sec.events.map(e => {
      const ip = escHtml(e.ip || '');
      const ipCell = e.ip
        ? `<span class="sec-ip" title="Nach dieser IP filtern" onclick="secSearchIp(${_secJs(e.ip)})">${ip}</span>` +
          (banned.has(e.ip) ? ` <span class="sec-tag mine" title="${banned.get(e.ip) === -1 ? 'Aktuell dauerhaft gesperrt' : 'Aktuell gesperrt'} – klicken zum Entsperren" style="cursor:pointer" onclick="secUnban(${_secJs(e.ip)})">${banned.get(e.ip) === -1 ? 'dauerhaft gesperrt' : 'gesperrt'} ✕</span>` : '')
        : '';
      return `<tr>
        <td>${escHtml(_secTime(e.ts))}</td>
        <td>${escHtml(_SEC_SOURCE_LABEL[e.source] || e.source)}</td>
        <td><span class="sec-k sec-k-${escHtml(e.kind)}">${escHtml(_SEC_KIND_LABEL[e.kind] || e.kind)}</span></td>
        <td title="${escHtml(e.jail || '')}">${escHtml(e.app || e.jail || '')}${e.jail && e.app && e.jail !== e.app ? ` <span style="opacity:.55">${escHtml(e.jail)}</span>` : ''}</td>
        <td>${ipCell}</td>
        <td>${escHtml(e.user || '')}</td>
        <td class="sec-msg">${escHtml(e.text || '')}</td>
      </tr>`;
    }).join('');
  }
  const more = document.getElementById('sec-ev-more');
  more.innerHTML = _sec.events.length < _sec.total
    ? `${_sec.events.length} von ${_sec.total} angezeigt — <button class="btn btn-sm" onclick="secMoreEvents()">Weitere ${Math.min(_sec.pageSize, _sec.total - _sec.events.length)} laden</button>`
    : (_sec.total ? `Alle ${_sec.total} Meldungen angezeigt` : '');
}

// Manuelle Sperre (seit 19.10.2026): Jail "manuell" = Cloudflare-Rand + Server-Firewall, 4 Wochen
async function secBan() {
  const inp = document.getElementById('sec-ban-ip');
  const ip = (inp.value || '').trim();
  if (!ip) { inp.focus(); return; }
  const ok = await uiConfirm(
    `IP ${ip} sperren?\n\nDie IP wird 4 Wochen lang am Cloudflare-Rand (alle Seiten) und an der Server-Firewall (SSH, VPN) gesperrt.\nAufheben jederzeit über „Entsperren“.`,
    { okLabel: 'Sperren', danger: true });
  if (!ok) return;
  toast(`Sperre ${ip} …`, 'info', 3000);
  const r = await api('/api/security/ban', { method: 'POST', body: JSON.stringify({ ip }) });
  if (r.success) { toast(`${r.ip} gesperrt (Jail manuell)`, 'success'); inp.value = ''; }
  else toast(`Sperren fehlgeschlagen: ${r.error || 'siehe Protokoll'}`, 'error', 8000);
  loadSecBans();
  loadSecEvents(true);
}

async function secUnban(ip) {
  const b = _sec.bans.find(x => x.ip === ip);
  const where = b ? b.jails.map(j => j.jail).join(', ') : 'alle Jails';
  const ok = await uiConfirm(
    `IP ${ip} entsperren?\n\nWird aus allen fail2ban-Jails (${where}), dem ipset${b && b.cloudflare ? ' und der Cloudflare-Sperrliste' : ''} entfernt.` +
    (b && !b.mine && !(b.known || []).length ? '\n\nHinweis: Diese IP hat sich hier noch nie erfolgreich angemeldet.' : ''),
    { okLabel: 'Entsperren', danger: true });
  if (!ok) return;
  toast(`Entsperre ${ip} …`, 'info', 3000);
  const r = await api('/api/security/unban', { method: 'POST', body: JSON.stringify({ ip }) });
  if (r.success) toast(`${ip} entsperrt${r.jails && r.jails.length ? ' (' + r.jails.join(', ') + ')' : ''}`, 'success');
  else toast(`Entsperren unvollständig: ${r.error || (r.still_banned || []).join(', ') || 'siehe Protokoll'}`, 'error', 8000);
  loadSecBans();
  loadSecEvents(true);
}

// ─── Benachrichtigungen (ntfy) — seit 16.10.2026 ─────────────────────
// Backend: dashboard/notify.py, GET /api/notifications. Liest mit einem
// Nur-Lese-Token die zwischengespeicherten Nachrichten des eigenen ntfy-Servers.
// Titel/Texte koennen Angreifer-Input enthalten (fail2ban): alles wird escapt.
const _ntf = { timer: null, wired: false, since: '24h', topic: '', data: null };
const _NTF_TOPIC_LABEL = { ssh: 'SSH', fail2ban: 'fail2ban', logins: 'Web-Logins', kernel: 'Kernel' };

function _ntfWire() {
  if (_ntf.wired) return;
  _ntf.wired = true;
  document.querySelectorAll('#page-notifications .ntf-range-btn').forEach(b => b.addEventListener('click', () => {
    _ntf.since = b.dataset.since;
    document.querySelectorAll('#page-notifications .ntf-range-btn').forEach(x => x.classList.toggle('active', x === b));
    loadNotifications();
  }));
  // Auto-Aktualisierung nur, solange der Reiter offen und sichtbar ist
  _ntf.timer = setInterval(() => {
    if (currentPage !== 'notifications' || document.visibilityState !== 'visible') return;
    if (!document.getElementById('ntf-auto').checked) return;
    loadNotifications();
  }, 30000);
}

async function loadNotifications() {
  _ntfWire();
  const d = await api(`/api/notifications?since=${encodeURIComponent(_ntf.since)}`);
  _ntf.data = d;
  renderNotifications();
}

function _ntfFilter(topic) {
  _ntf.topic = (_ntf.topic === topic) ? '' : topic;
  renderNotifications();
}

function renderNotifications() {
  const d = _ntf.data || {};
  const list = document.getElementById('ntf-list');
  const chips = document.getElementById('ntf-chips');
  const open = document.getElementById('ntf-open');
  if (d.public_url) { open.href = d.public_url; open.style.display = ''; } else { open.style.display = 'none'; }
  if (d.error && !d.messages) { list.innerHTML = `<div class="ntf-empty">${escHtml(d.error)}</div>`; chips.innerHTML = ''; return; }
  if (d.configured === false) {
    list.innerHTML = '<div class="ntf-empty">ntfy ist nicht eingerichtet (/var/lib/linux-dashboard/ntfy.json fehlt).</div>';
    chips.innerHTML = ''; return;
  }
  const msgs = d.messages || [];
  const counts = {};
  for (const m of msgs) counts[m.topic] = (counts[m.topic] || 0) + 1;
  const topics = d.topics || [];
  chips.innerHTML = [`<button class="ntf-chip${_ntf.topic ? '' : ' active'}" onclick="_ntfFilter('')">Alle <span>${msgs.length}</span></button>`]
    .concat(topics.map(t => `<button class="ntf-chip${_ntf.topic === t ? ' active' : ''}" onclick="_ntfFilter('${escHtml(t)}')">${escHtml(_NTF_TOPIC_LABEL[t] || t)} <span>${counts[t] || 0}</span></button>`))
    .join('');
  const shown = _ntf.topic ? msgs.filter(m => m.topic === _ntf.topic) : msgs;
  let html = '';
  if (d.error) html += `<div class="ntf-empty ntf-warn">${escHtml(d.error)}</div>`;
  if (!shown.length) {
    html += '<div class="ntf-empty">Keine Benachrichtigungen im gewählten Zeitraum.</div>';
  } else {
    html += shown.map(m => {
      const t = new Date(m.time * 1000);
      const when = t.toLocaleString('de-AT', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const prio = m.priority >= 5 ? 'urgent' : m.priority >= 4 ? 'high' : m.priority <= 2 ? 'low' : '';
      const body = escHtml(m.message).replace(/ \| /g, '<br>').replace(/\n/g, '<br>');
      return `<div class="ntf-item ${prio ? 'ntf-' + prio : ''}">
        <div class="ntf-meta"><span class="ntf-time">${escHtml(when)}</span>
          <span class="ntf-topic">${escHtml(_NTF_TOPIC_LABEL[m.topic] || m.topic)}</span>
          ${prio === 'high' || prio === 'urgent' ? `<span class="ntf-prio">${prio === 'urgent' ? 'dringend' : 'hoch'}</span>` : ''}</div>
        <div class="ntf-title">${escHtml(m.title || '(ohne Titel)')}</div>
        <div class="ntf-body">${body}</div>
      </div>`;
    }).join('');
  }
  list.innerHTML = html;
}


// ─── Einstellungen (seit 19.10.2026) ─────────────────────────────────
// Backend: dashboard/prefs.py, GET/POST /api/prefs. Tabs ausblenden ist rein
// optisch (Rechte regelt die Rolle); SSH-Geheimnisse kommen nie zurück zum Browser.
const _TAB_LABELS = { processes: 'Prozesse', terminal: 'Terminal', updates: 'Updates', vms: 'VMs',
  docker: 'Docker', services: 'Services', connections: 'Verbindungen', browser: 'Browser',
  security: 'Sicherheit', notifications: 'Benachrichtigungen', users: 'Benutzer' };
window._prefs = null;

async function loadPrefs() {
  const p = await api('/api/prefs');
  if (p && !p.error) { window._prefs = p; applyTabPrefs(); }
}

function applyTabPrefs() {
  const p = window._prefs; if (!p) return;
  const hidden = new Set(p.hidden_pages || []);
  for (const page of (p.hideable_pages || [])) {
    const btn = document.getElementById(`nav-btn-${page}`);
    if (btn) btn.style.display = (pageAllowed(page) && !hidden.has(page)) ? '' : 'none';
  }
  if (hidden.has(currentPage)) showPage('dashboard');
}

function renderSettings() {
  const p = window._prefs;
  if (!p) { loadPrefs().then(() => window._prefs && renderSettings()); return; }
  const hidden = new Set(p.hidden_pages || []);
  document.getElementById('set-tabs').innerHTML = (p.hideable_pages || []).filter(pageAllowed).map(page => `
    <label class="set-tab"><span>${escHtml(_TAB_LABELS[page] || page)}</span>
      <span class="set-switch"><input type="checkbox" data-page="${escHtml(page)}" ${hidden.has(page) ? '' : 'checked'}><span class="set-slider"></span></span>
      <span class="set-yn">${hidden.has(page) ? 'NEIN' : 'JA'}</span></label>`).join('');
  document.querySelectorAll('#set-tabs input').forEach(i => i.addEventListener('change', () => {
    i.closest('.set-tab').querySelector('.set-yn').textContent = i.checked ? 'JA' : 'NEIN';
  }));
  const d = p.ssh_default || {};
  document.getElementById('set-ssh-user').value = d.username || '';
  document.getElementById('set-ssh-pass').value = '';
  document.getElementById('set-ssh-key').value = '';
  document.getElementById('set-ssh-keypass').value = '';
  document.getElementById('set-ssh-pw-state').textContent = d.has_password ? '✓ gespeichert' : '– keins';
  document.getElementById('set-ssh-key-state').textContent = d.has_key ? '✓ gespeichert' : '– keiner';
  document.getElementById('set-ssh-err').textContent = '';
}

async function _savePrefs(body, okMsg) {
  const r = await api('/api/prefs', { method: 'POST', body: JSON.stringify(body) });
  if (r.success) { window._prefs = r.prefs; applyTabPrefs(); renderSettings(); toast(okMsg, 'success'); return true; }
  const e = document.getElementById('set-ssh-err'); if (e) e.textContent = r.error || 'Speichern fehlgeschlagen';
  toast(r.error || 'Speichern fehlgeschlagen', 'error', 6000);
  return false;
}

function saveTabPrefs() {
  const hidden = [...document.querySelectorAll('#set-tabs input')].filter(i => !i.checked).map(i => i.dataset.page);
  _savePrefs({ hidden_pages: hidden }, 'Tabs gespeichert');
}

function saveSshDefaults() {
  _savePrefs({ ssh_default: {
    username: document.getElementById('set-ssh-user').value.trim(),
    password: document.getElementById('set-ssh-pass').value,
    private_key: document.getElementById('set-ssh-key').value.trim(),
    passphrase: document.getElementById('set-ssh-keypass').value,
  } }, 'Standard-Zugangsdaten gespeichert');
}

async function clearSshDefault(what) {
  const ok = await uiConfirm(what === 'key' ? 'Gespeicherten Schlüssel löschen?' : 'Gespeichertes Passwort löschen?', { okLabel: 'Löschen', danger: true });
  if (!ok) return;
  _savePrefs({ ssh_default: what === 'key' ? { clear_key: true } : { clear_password: true } }, 'Gelöscht');
}
