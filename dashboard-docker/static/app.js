
// ═══════════════════════════════════════════════════
//  LINUX COMMAND CENTER — Frontend Logic
// ═══════════════════════════════════════════════════

const API = window.location.origin;
let refreshInterval = null;
let currentPage = 'dashboard';
let terminalHistory = [];
let historyIndex = -1;
// ─── Terminal Screen Buffer (VT100 emulator) ─────────
const _T_FG    = ['#1a1a2e','#ef4444','#4ade80','#fcd34d','#60a5fa','#c084fc','#67e8f9','#e2e8f0'];
const _T_FG_BR = ['#4a5e80','#f87171','#86efac','#fde68a','#93c5fd','#d8b4fe','#a5f3fc','#f8fafc'];
const _T_BG    = ['#000000','#7f1d1d','#14532d','#78350f','#1e3a5f','#581c87','#164e63','#374151'];

class TermScreen {
  constructor(cols,rows){this.cols=cols||80;this.rows=rows||24;this._esc='';this._sb=[];this.reset();}
  reset(){this.r=0;this.c=0;this.st={};this._sc={r:0,c:0,st:{}};this._sT=0;this._sB=this.rows-1;this.cells=this._grid(this.rows,this.cols);this._sb=[];this._esc='';}
  resize(cols,rows){const nc=this._grid(rows,cols);for(let r=0;r<Math.min(rows,this.rows);r++)for(let c=0;c<Math.min(cols,this.cols);c++)nc[r][c]=this.cells[r][c];this.cols=cols;this.rows=rows;this.cells=nc;this.r=Math.min(this.r,rows-1);this.c=Math.min(this.c,cols-1);this._sB=rows-1;}
  _grid(r,c){return Array.from({length:r},()=>this._row(c));}
  _row(n){return Array.from({length:n||this.cols},()=>({ch:' ',fg:null,bg:null,b:false,d:false,i:false,u:false}));}
  _cell(){return {ch:' ',fg:null,bg:null,b:false,d:false,i:false,u:false};}
  feed(data){
    data=this._esc+data;this._esc='';let i=0;
    while(i<data.length){
      const cc=data.charCodeAt(i);
      if(cc===0x1b){const n=this._esc_seq(data,i);if(n<0){this._esc=data.slice(i);break;}i+=n;}
      else if(cc===0x0d){this.c=0;i++;}
      else if(cc===0x0a){this._lf();i++;}
      else if(cc===0x08){if(this.c>0)this.c--;i++;}
      else if(cc===0x09){this.c=Math.min(this.cols-1,(Math.floor(this.c/8)+1)*8);i++;}
      else if(cc===0x07||cc<0x20){i++;}
      else{this._put(data[i]);i++;}
    }
  }
  _lf(){
    if(this.r===this._sB){
      if(this._sT===0&&this._sB===this.rows-1){this._sb.push(this._rrow(this.cells[0]));if(this._sb.length>3000)this._sb.shift();}
      this.cells.splice(this._sT,1);this.cells.splice(this._sB,0,this._row());
    } else if(this.r<this.rows-1){this.r++;}
  }
  _put(ch){if(this.c>=this.cols){this.c=0;this._lf();}const s=this.st;this.cells[this.r][this.c]={ch,fg:s.fg||null,bg:s.bg||null,b:!!s.b,d:!!s.d,i:!!s.i,u:!!s.u};this.c++;}
  _esc_seq(s,i){
    if(i+1>=s.length)return -1;
    const c1=s[i+1];
    if(c1==='['){const m=s.slice(i).match(/^\x1b\[([0-9;?<>]*)([A-Za-z`@])/);if(!m)return s.length-i<64?-1:2;this._csi(m[1],m[2]);return m[0].length;}
    if(c1===']'){const rest=s.slice(i+2);const e=rest.search(/\x07|\x1b\\/);if(e<0)return s.length-i<512?-1:2;return 2+e+(rest[e]==='\x07'?1:2);}
    if(c1==='('||c1===')'){return i+2<s.length?3:-1;}
    if(c1==='M'){if(this.r===this._sT){this.cells.splice(this._sB,1);this.cells.splice(this._sT,0,this._row());}else{this.r=Math.max(0,this.r-1);}return 2;}
    if(c1==='7'){this._sc={r:this.r,c:this.c,st:{...this.st}};return 2;}
    if(c1==='8'){this.r=this._sc.r;this.c=this._sc.c;this.st={...this._sc.st};return 2;}
    return 2;
  }
  _csi(p,cmd){
    const prv=p.startsWith('?');const ns=(prv?p.slice(1):p).split(';').map(v=>v===''?0:+v);
    const p1=ns[0]||0,p2=ns[1]||0;
    switch(cmd){
      case 'H':case 'f':this.r=Math.max(0,Math.min(this.rows-1,(p1||1)-1));this.c=Math.max(0,Math.min(this.cols-1,(p2||1)-1));break;
      case 'A':this.r=Math.max(0,this.r-(p1||1));break;
      case 'B':this.r=Math.min(this.rows-1,this.r+(p1||1));break;
      case 'C':this.c=Math.min(this.cols-1,this.c+(p1||1));break;
      case 'D':this.c=Math.max(0,this.c-(p1||1));break;
      case 'E':this.r=Math.min(this.rows-1,this.r+(p1||1));this.c=0;break;
      case 'F':this.r=Math.max(0,this.r-(p1||1));this.c=0;break;
      case 'G':case '`':this.c=Math.max(0,Math.min(this.cols-1,(p1||1)-1));break;
      case 'd':this.r=Math.max(0,Math.min(this.rows-1,(p1||1)-1));break;
      case 'J':
        if(p1===0){for(let c=this.c;c<this.cols;c++)this.cells[this.r][c]=this._cell();for(let r=this.r+1;r<this.rows;r++)this.cells[r]=this._row();}
        else if(p1===1){for(let r=0;r<this.r;r++)this.cells[r]=this._row();for(let c=0;c<=this.c;c++)this.cells[this.r][c]=this._cell();}
        else{for(let r=0;r<this.rows;r++)this.cells[r]=this._row();}
        break;
      case 'K':
        if(p1===0){for(let c=this.c;c<this.cols;c++)this.cells[this.r][c]=this._cell();}
        else if(p1===1){for(let c=0;c<=this.c;c++)this.cells[this.r][c]=this._cell();}
        else{this.cells[this.r]=this._row();}
        break;
      case 'L':for(let n=0;n<(p1||1);n++){this.cells.splice(this.r,0,this._row());if(this.cells.length>this.rows)this.cells.splice(this._sB+1,1);}break;
      case 'M':for(let n=0;n<(p1||1);n++){this.cells.splice(this.r,1);this.cells.splice(this._sB,0,this._row());}break;
      case 'P':{const n=p1||1;this.cells[this.r].splice(this.c,n);for(let x=0;x<n;x++)this.cells[this.r].push(this._cell());}break;
      case '@':{const n=p1||1;for(let x=0;x<n;x++){this.cells[this.r].splice(this.c,0,this._cell());this.cells[this.r].pop();}}break;
      case 'S':for(let n=0;n<(p1||1);n++){this.cells.splice(this._sT,1);this.cells.splice(this._sB,0,this._row());}break;
      case 'T':for(let n=0;n<(p1||1);n++){this.cells.splice(this._sB,1);this.cells.splice(this._sT,0,this._row());}break;
      case 'm':this._sgr(ns);break;
      case 'r':this._sT=Math.max(0,(p1||1)-1);this._sB=Math.min(this.rows-1,(p2||this.rows)-1);break;
      case 's':this._sc={r:this.r,c:this.c,st:{...this.st}};break;
      case 'u':this.r=this._sc.r||0;this.c=this._sc.c||0;this.st={...this._sc.st};break;
    }
  }
  _sgr(ns){
    let i=0;
    while(i<ns.length){const n=ns[i];
      if(n===0)this.st={};
      else if(n===1)this.st.b=true;else if(n===2)this.st.d=true;else if(n===3)this.st.i=true;else if(n===4)this.st.u=true;
      else if(n===7){const t=this.st.fg;this.st.fg=this.st.bg||'#1e293b';this.st.bg=t||'#e2e8f0';}
      else if(n===22){delete this.st.b;delete this.st.d;}else if(n===23)delete this.st.i;else if(n===24)delete this.st.u;
      else if(n===27){delete this.st.fg;delete this.st.bg;}
      else if(n>=30&&n<=37)this.st.fg=_T_FG[n-30];else if(n===39)delete this.st.fg;
      else if(n>=40&&n<=47)this.st.bg=_T_BG[n-40];else if(n===49)delete this.st.bg;
      else if(n>=90&&n<=97)this.st.fg=_T_FG_BR[n-90];
      else if(n===38&&ns[i+1]===5&&i+2<ns.length){this.st.fg=this._c256(ns[i+2]);i+=2;}
      else if(n===38&&ns[i+1]===2&&i+4<ns.length){this.st.fg=`rgb(${ns[i+2]},${ns[i+3]},${ns[i+4]})`;i+=4;}
      else if(n===48&&ns[i+1]===5&&i+2<ns.length){this.st.bg=this._c256(ns[i+2]);i+=2;}
      else if(n===48&&ns[i+1]===2&&i+4<ns.length){this.st.bg=`rgb(${ns[i+2]},${ns[i+3]},${ns[i+4]})`;i+=4;}
      i++;
    }
  }
  _c256(n){if(n<8)return _T_FG[n];if(n<16)return _T_FG_BR[n-8];if(n<232){const i=n-16,b=i%6,g=Math.floor(i/6)%6,r=Math.floor(i/36),v=k=>k?55+k*40:0;return `rgb(${v(r)},${v(g)},${v(b)})`;}const x=8+(n-232)*10;return `rgb(${x},${x},${x})`;}
  _rrow(row,cur){
    let html='',cs=null,span=false,last=-1;
    for(let c=row.length-1;c>=0;c--){if(row[c].ch!==' '||row[c].fg||row[c].bg||row[c].b){last=c;break;}}
    if(cur>=0&&cur>last)last=cur;
    if(last<0)return '';
    for(let c=0;c<=last;c++){
      const cl=row[c];
      const isCur=(c===cur);
      let s;
      if(isCur){s=`color:${cl.bg||'#0a0a0a'};background:${cl.fg||'#c8d4e8'};`+(cl.b?'font-weight:700;':'')+(cl.i?'font-style:italic;':'');}
      else{s=this._css(cl);}
      if(s!==cs){if(span){html+='</span>';span=false;}cs=s;if(s){html+=`<span style="${s}">`;span=true;}}
      html+=cl.ch==='&'?'&amp;':cl.ch==='<'?'&lt;':cl.ch==='>'?'&gt;':cl.ch;
    }
    return span?html+'</span>':html;
  }
  _css(c){let s='';if(c.fg)s+=`color:${c.fg};`;if(c.bg)s+=`background:${c.bg};`;if(c.b)s+='font-weight:700;';if(c.i)s+='font-style:italic;';if(c.u)s+='text-decoration:underline;';if(c.d)s+='opacity:.6;';return s;}
  toHtml(){
    const cr=this.r,cc=this.c;
    const lines=this._sb.concat(this.cells.map((row,ri)=>this._rrow(row,ri===cr?cc:-1)));
    let end=lines.length;
    while(end>this._sb.length&&lines[end-1]==='')end--;
    return lines.slice(0,end).join('\n');
  }
}

// ─── WebSocket PTY globals ────────────────────────────
const _termDec = new TextDecoder('utf-8', { fatal: false });
const _termEnc = new TextEncoder();
let _termWs = null;
let _termScreen = new TermScreen(80, 24);

const TERM_KEY_MAP = {
  'Backspace':'\x7f','Tab':'\t','Enter':'\r','Escape':'\x1b',
  'ArrowUp':'\x1b[A','ArrowDown':'\x1b[B','ArrowRight':'\x1b[C','ArrowLeft':'\x1b[D',
  'Home':'\x1b[H','End':'\x1b[F','Delete':'\x1b[3~',
  'PageUp':'\x1b[5~','PageDown':'\x1b[6~',
  'F1':'\x1bOP','F2':'\x1bOQ','F3':'\x1bOR','F4':'\x1bOS',
  'F5':'\x1b[15~','F6':'\x1b[17~','F7':'\x1b[18~','F8':'\x1b[19~',
  'F9':'\x1b[20~','F10':'\x1b[21~','F11':'\x1b[23~','F12':'\x1b[24~',
};

function _termSend(data) {
  if (_termWs && _termWs.readyState === WebSocket.OPEN) {
    _termWs.send(typeof data === 'string' ? _termEnc.encode(data) : data);
  }
}

function _termSendResize() {
  const out = document.getElementById('terminal-output');
  if (!out) return;
  const style = getComputedStyle(out);
  const padX = parseFloat(style.paddingLeft||0) + parseFloat(style.paddingRight||0);
  const padY = parseFloat(style.paddingTop||0) + parseFloat(style.paddingBottom||0);
  const cols = Math.max(40, Math.floor((out.clientWidth - padX) / 8));
  const rows = Math.max(10, Math.floor((out.clientHeight - padY) / 16));
  _termScreen.resize(cols, rows);
  if (_termWs && _termWs.readyState === WebSocket.OPEN)
    _termWs.send(JSON.stringify({ type: 'resize', cols, rows }));
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
    if (!out) return;
    const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 60;
    out.innerHTML = _termScreen.toHtml();
    if (atBottom) out.scrollTop = out.scrollHeight;
  });
}

function termMobileKey(action) {
  switch (action) {
    case 'interrupt':    _termSend('\x03'); break;
    case 'ctrl_s':       _termSend('\x13'); break;
    case 'ctrl_x':       _termSend('\x18'); break;
    case 'ctrl_alt_del': _termSend('\x1b[3;7~'); break;
    case 'up':   _termSend('\x1b[A'); break;
    case 'down': _termSend('\x1b[B'); break;
    case 'tab':  _termSend('\t'); break;
    case 'home': _termSend('\x1b[H'); break;
    case 'end':  _termSend('\x1b[F'); break;
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

const _ADMIN_PAGES = new Set(['processes', 'terminal', 'updates', 'services', 'vms', 'users', 'docker']);

function showPage(page) {
  if (_ADMIN_PAGES.has(page) && window._userRole && window._userRole !== 'admin') {
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
  if (kb) { kb.focus(); }
}

function termConnect() {
  if (_termWs && (_termWs.readyState === WebSocket.OPEN || _termWs.readyState === WebSocket.CONNECTING)) return;
  _termSetStatus('○ Verbinde…', 'var(--text-muted)');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  _termWs = new WebSocket(`${proto}//${location.host}/api/terminal/ws`);
  _termWs.binaryType = 'arraybuffer';
  _termWs.onopen = () => {
    _termSetStatus('● Online', 'var(--accent)');
    setTimeout(_termSendResize, 80);
    loadTerminalInfo();
  };
  _termWs.onmessage = (e) => {
    const chunk = e.data instanceof ArrayBuffer ? _termDec.decode(e.data) : e.data;
    _termScreen.feed(chunk);
    _termRender();
  };
  _termWs.onclose = () => {
    _termSetStatus('○ Getrennt', 'var(--red)');
    if (currentPage === 'terminal') setTimeout(termConnect, 3000);
  };
  _termWs.onerror = () => _termSetStatus('● Fehler', 'var(--red)');
}

function quickCmd(cmd) {
  _termSend(cmd + '\r');
  termFocus();
}

function clearTerminal() {
  _termScreen.reset();
  _termRender();
}

// Terminal input handler
// ─── Role-based access ─────────────────────────────
window._userRole = 'admin'; // default until /api/me responds
window._userName = '';

async function initUserRole() {
  try {
    const data = await api('/api/me');
    window._userRole = data.role || 'admin';
    window._userName = data.username || '';
  } catch (_) {}
  // Benutzerverwaltung und Docker nur für Admins sichtbar (Buttons starten
  // versteckt — Docker-Zugriff über den Socket ist faktisch Root auf dem Host)
  if (window._userRole === 'admin') {
    for (const p of ['users', 'docker']) {
      const b = document.getElementById(`nav-btn-${p}`);
      if (b) b.style.display = '';
    }
  }
  if (window._userRole !== 'admin') {
    for (const page of _ADMIN_PAGES) {
      const btn = document.getElementById(`nav-btn-${page}`);
      if (btn) btn.style.display = 'none';
    }
    // If currently on a restricted page, redirect to dashboard
    if (_ADMIN_PAGES.has(currentPage)) showPage('dashboard');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initUserRole();
  const kb = document.getElementById('term-kb');
  if (kb) {
    kb.addEventListener('keydown', (e) => {
      // Ctrl+key combos are handled exclusively by the global document handler (always fires, no double-send risk)
      if (e.ctrlKey) return;
      const seq = TERM_KEY_MAP[e.key];
      if (seq) {
        e.preventDefault();
        _termSend(seq);
        return;
      }
    });

    kb.addEventListener('input', (e) => {
      // Mobile browsers (iOS) fire deleteContentBackward instead of keydown for Backspace
      if (e.inputType === 'deleteContentBackward') {
        _termSend('\x7f');
        kb.value = '';
        return;
      }
      const t = kb.value;
      kb.value = '';
      if (t) _termSend(t);
    });

    kb.addEventListener('focus', () => {
      const btn = document.getElementById('btn-term-kb');
      if (btn) btn.style.background = 'rgba(0,232,123,0.15)';
    });
    kb.addEventListener('blur', () => {
      const btn = document.getElementById('btn-term-kb');
      if (btn) btn.style.background = '';
    });
  }

  // Global keydown: handles all terminal input independent of which element has focus.
  document.addEventListener('keydown', (e) => {
    if (currentPage !== 'terminal') return;
    const ae = document.activeElement;
    if (e.ctrlKey && !e.altKey && e.key.length === 1) {
      const k = e.key.toLowerCase();
      // Ctrl+C: if user has text selected, let browser copy — otherwise send SIGINT
      if (k === 'c' && window.getSelection && window.getSelection().toString()) return;
      // Ctrl+V: let the paste event handle clipboard → PTY forwarding
      if (k === 'v') return;
      e.preventDefault();
      _termSend(String.fromCharCode(k.charCodeAt(0) - 96));
      return;
    }
    // Ctrl+Alt+Del
    if (e.ctrlKey && e.altKey && e.key === 'Delete') {
      e.preventDefault();
      _termSend('\x1b[3;7~');
      return;
    }
    // Non-ctrl special keys: only when term-kb is NOT focused (avoid double-send with kb handler)
    if (ae === kb) return;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
    const seq = TERM_KEY_MAP[e.key];
    if (seq) { e.preventDefault(); _termSend(seq); }
  });

  // Paste: forward clipboard text to the PTY
  document.addEventListener('paste', (e) => {
    if (currentPage !== 'terminal') return;
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (text) _termSend(text);
  });

  // Resize PTY when window resizes
  window.addEventListener('resize', () => {
    if (currentPage === 'terminal') _termSendResize();
  });

  // VisualViewport API: re-send resize when mobile keyboard appears/disappears
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      if (currentPage === 'terminal') setTimeout(_termSendResize, 100);
    });
  }
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
          <div class="vm-name">${escHtml(vm.name)}</div>
          <span class="vm-state ${stateClass}">${escHtml(vm.state)}</span>
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
}

function switchVMDTab(tab) {
  ['overview','hardware','disks','network','devices','boot','snapshots','xml'].forEach(t => {
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
          ${VMD_DEVICE_KINDS.map(k=>`<option value="${k.v}">${escHtml(k.t)}</option>`).join('')}
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
      ${window._userRole === 'admin' && c.owner && c.owner !== window._userName ? `<span class="owner-badge">${escHtml(c.owner)}</span>` : ''}
      <div style="font-weight:600;margin-bottom:4px;font-size:14px;">${escHtml(c.label)}</div>
      <div style="font-family:var(--font-mono);font-size:12px;color:var(--text-secondary);margin-bottom:14px;">
        <span class="conn-status-dot ${c.status === 'connected' ? 'connected' : 'idle'}"></span>
        ${escHtml(c.host)}:${c.port}
        ${c.username ? ' · ' + escHtml(c.username) : ''}
      </div>
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

async function loadBrowserSessions() {
  const grid = document.getElementById('browser-grid');
  grid.innerHTML = '<div class="loading-overlay"><span class="spinner"></span> Lade Sessions...</div>';
  const r = await api('/api/browser/list');
  const sessions = r.sessions || [];
  if (!sessions.length) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:48px;height:48px"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/><path d="M2 7h20"/></svg>
        <p>Keine aktiven Browser-Sessions.<br>Klicke auf <strong>Neue Session</strong>.</p>
      </div>`;
    return;
  }
  grid.innerHTML = sessions.map(s => `
    <div class="browser-card">
      <span class="browser-badge">
        ${s.image_key === 'firefox' ? '🦊' : s.image_key === 'chromium' ? '🔵' : '🌐'}
        ${escHtml(s.image_key.toUpperCase())}
      </span>
      ${window._userRole === 'admin' && s.owner && s.owner !== window._userName ? `<span class="owner-badge">${escHtml(s.owner)}</span>` : ''}
      <div style="font-weight:600;margin-bottom:4px;font-size:14px;">${escHtml(s.label)}</div>
      <div style="font-family:var(--font-mono);font-size:12px;color:var(--text-secondary);margin-bottom:14px;">
        <span class="conn-status-dot connected"></span>
        ${escHtml(s.image)}
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-primary" style="flex:1;justify-content:center;" ${s.url ? `onclick="window.open('${escHtml(s.url)}','_blank')"` : 'disabled'}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          Öffnen
        </button>
        <button class="btn btn-danger" onclick="stopBrowser('${s.id}')" style="min-width:80px;justify-content:center;gap:5px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
          Beenden
        </button>
      </div>
    </div>
  `).join('');
}

// ─── Auto-Refresh ───────────────────────────────────

function startAutoRefresh() {
  loadDashboard();
  refreshInterval = setInterval(() => {
    if (currentPage === 'dashboard') {
      loadDashboard();
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
                    + '(Cloudflare-Tunnel). Stoppt er, ist das Dashboard von außen nicht mehr erreichbar — '
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
      <div class="term-ctrl-bar">
        <button class="term-ctrl-btn" onclick="dkConKey('interrupt')">Ctrl+C</button>
        <button class="term-ctrl-btn" onclick="dkConKey('ctrl_d')">Ctrl+D</button>
        <button class="term-ctrl-btn" onclick="dkConKey('tab')">Tab</button>
        <button class="term-ctrl-btn" onclick="dkConKey('up')">&#8593;</button>
        <button class="term-ctrl-btn" onclick="dkConKey('down')">&#8595;</button>
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
  const map = { interrupt: '\x03', ctrl_d: '\x04', tab: '\t',
                up: '\x1b[A', down: '\x1b[B' };
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
  if (!out || !_dkConScreen) return;
  const st = getComputedStyle(out);
  const padX = parseFloat(st.paddingLeft || 0) + parseFloat(st.paddingRight || 0);
  const padY = parseFloat(st.paddingTop || 0) + parseFloat(st.paddingBottom || 0);
  const cols = Math.max(40, Math.floor((out.clientWidth - padX) / 8));
  const rows = Math.max(10, Math.floor((out.clientHeight - padY) / 16));
  _dkConScreen.resize(cols, rows);
  if (_dkConWs && _dkConWs.readyState === WebSocket.OPEN)
    _dkConWs.send(JSON.stringify({ type: 'resize', cols, rows }));
}

function dkConConnect() {
  const id = _dkDetailId;
  if (!id) return;
  dkConDisconnect();
  _dkConId = id;
  _dkConScreen = new TermScreen(100, 30);
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
    const chunk = e.data instanceof ArrayBuffer ? _termDec.decode(e.data) : e.data;
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
    if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
      const c = e.key.toLowerCase().charCodeAt(0) - 96;
      if (c >= 1 && c <= 26) { e.preventDefault(); dkConSend(String.fromCharCode(c)); return; }
    }
    if (TERM_KEY_MAP[e.key]) { e.preventDefault(); dkConSend(TERM_KEY_MAP[e.key]); return; }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) { e.preventDefault(); dkConSend(e.key); }
  });
  kb.addEventListener('paste', (e) => {
    if (!_dkConWs) return;
    e.preventDefault();
    dkConSend((e.clipboardData || window.clipboardData).getData('text'));
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
