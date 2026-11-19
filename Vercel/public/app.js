'use strict';
/* ระบบเบิก/คืนเครื่อง — PWA (vanilla JS + Supabase) */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = d => new Date(d).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' });
const TYPE = { ISSUE: 'เบิก', RETURN: 'คืน' };
const TYPE_CLS = { ISSUE: 'warn', RETURN: 'ok' };
const DRAFT_KEY = 'draft-v1';

/* ---------- Supabase ---------- */
const cfg = window.APP_CONFIG || {};
const configured = !!(window.supabase && /^https?:\/\//.test(cfg.SUPABASE_URL || '') && cfg.SUPABASE_ANON_KEY && !/YOUR_/.test(cfg.SUPABASE_URL + cfg.SUPABASE_ANON_KEY));
const sb = configured ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } }) : null;

const state = {
  view: 'issue', session: null, operator: '', busy: false, loading: false, loadErr: '',
  open: [], openMap: new Map(), docs: [], docsLimit: 300,
  hdr: { person: '', dept: '', purpose: '', note: '', model: '' },
  cart: { issue: [], return: [] }, rnote: '', retPerson: '', loose: false,
  outQ: '', hq: '', ht: ''
};

/* ---------- helpers ---------- */
const errMsg = e => /failed to fetch|networkerror|load failed/i.test(e?.message || '') ? 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — ตรวจสอบอินเทอร์เน็ต' : (e?.message || String(e));
function toast(msg, err) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.className = '', 2800);
}
let ac;
function beep(ok = true) {
  try {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = ok ? 1000 : 300; g.gain.value = .1; o.connect(g); g.connect(ac.destination);
    o.start(); o.stop(ac.currentTime + .12);
  } catch { }
  navigator.vibrate?.(ok ? 40 : [80, 40, 80]);
}
const loadScript = url => new Promise((res, rej) => {
  if (document.querySelector(`script[src="${url}"]`)) return res();
  const s = document.createElement('script'); s.src = url; s.onload = res; s.onerror = () => rej(new Error('โหลดไลบรารีไม่ได้ (ต้องออนไลน์ครั้งแรก)')); document.head.appendChild(s);
});
function download(name, text, mime) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const csvCell = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
const opName = () => state.operator.trim() || state.session?.user?.email || '';
const daysSince = d => Math.max(0, Math.floor((Date.now() - new Date(d)) / 864e5));
const saveDraft = () => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ hdr: state.hdr, cart: state.cart, rnote: state.rnote, retPerson: state.retPerson })); } catch { } };
function loadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); if (!d) return;
    Object.assign(state.hdr, d.hdr || {});
    if (d.cart) { state.cart.issue = d.cart.issue || []; state.cart.return = d.cart.return || []; }
    state.rnote = d.rnote || ''; state.retPerson = d.retPerson || '';
  } catch { }
}

/* ---------- data (Supabase) ---------- */
async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}
async function loadOpen() {
  state.open = await fetchAll((a, b) => sb.from('loans').select('*').is('returned_at', null).order('issued_at', { ascending: false }).order('id').range(a, b));
  state.openMap = new Map(state.open.map(l => [l.imei, l]));
}
async function loadDocs() {
  const { data, error } = await sb.from('documents').select('*, document_items(imei, model)').order('created_at', { ascending: false }).limit(state.docsLimit);
  if (error) throw error;
  state.docs = data;
}
async function refresh() {
  if (!sb || !state.session) return;
  state.loading = true;
  try { await Promise.all([loadOpen(), loadDocs()]); state.loadErr = ''; }
  catch (e) { state.loadErr = errMsg(e); }
  state.loading = false;
}
async function guarded(fn) {
  if (state.busy) return; state.busy = true;
  try { await fn(); } catch (e) { toast(errMsg(e), true); }
  state.busy = false;
}

/* ---------- scanner ---------- */
async function openScanner(onCode, { multi = true } = {}) {
  const dlg = $('#scanDlg'), msg = $('#scanMsg'), video = $('#scanVideo'), reader = $('#reader');
  msg.textContent = 'กำลังเปิดกล้อง...'; video.hidden = false; reader.hidden = true;
  let stopped = false, stream, timer, h5, last = '', lastT = 0, busy = false;
  const stop = () => {
    if (stopped) return; stopped = true; clearInterval(timer);
    stream?.getTracks().forEach(t => t.stop()); video.srcObject = null;
    if (h5) { h5.stop().catch(() => { }).finally(() => { try { h5.clear(); } catch { } }); }
    if (dlg.open) dlg.close();
  };
  const handle = code => {
    const now = Date.now();
    if (code === last && now - lastT < 1500) return;
    last = code; lastT = now;
    const r = onCode(code);
    const ok = r !== false && !(typeof r === 'string' && r.startsWith('✗'));
    beep(ok); msg.textContent = typeof r === 'string' ? r : (ok ? '✓ ' + code : '✗ ' + code);
    if (!multi && ok) stop();
  };
  dlg.onclose = stop; $('#scanClose').onclick = stop;
  dlg.showModal();
  if (!navigator.mediaDevices?.getUserMedia) { msg.textContent = 'เบราว์เซอร์นี้ไม่รองรับกล้อง (ต้องใช้ HTTPS) — ใช้เครื่องยิงบาร์โค้ดหรือพิมพ์รหัสแทนได้'; return; }
  try {
    if ('BarcodeDetector' in window) {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      video.srcObject = stream; await video.play();
      const fmts = await BarcodeDetector.getSupportedFormats();
      const det = new BarcodeDetector({ formats: fmts });
      msg.textContent = 'เล็งกล้องไปที่บาร์โค้ด IMEI';
      timer = setInterval(async () => {
        if (busy || stopped) return; busy = true;
        try { const r = await det.detect(video); if (r[0]?.rawValue) handle(r[0].rawValue); } catch { }
        busy = false;
      }, 200);
    } else {
      await loadScript('https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js');
      video.hidden = true; reader.hidden = false;
      h5 = new Html5Qrcode('reader');
      await h5.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 260, height: 260 } }, handle, () => { });
      msg.textContent = 'เล็งกล้องไปที่บาร์โค้ด IMEI';
    }
  } catch (e) {
    msg.textContent = 'เปิดกล้องไม่ได้: ' + (e.message || e.name) + ' — ตรวจสอบสิทธิ์กล้อง/HTTPS';
  }
}

/* ---------- IMEI + ตะกร้า ---------- */
function validImei(s) {
  if (state.loose) return /^[A-Z0-9-]{5,30}$/.test(s);
  if (!/^\d{15}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) { let d = +s[i]; if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; } sum += d; }
  return sum % 10 === 0;
}
function normImei(raw) {
  let s = String(raw).trim().replace(/\s+/g, '');
  if (!state.loose) { const m = s.match(/\d{15}/); if (m) s = m[0]; }
  return s.toUpperCase();
}
function addImei(kind, raw) {
  const s = normImei(raw), c = state.cart[kind];
  if (!validImei(s)) return `✗ ${s} ไม่ใช่ IMEI ที่ถูกต้อง (15 หลัก)`;
  if (c.some(x => x.imei === s)) return `✗ สแกน ${s} ซ้ำ`;
  const loan = state.openMap.get(s);
  if (kind === 'issue') {
    if (loan) return `✗ ${s} ถูกเบิกอยู่แล้ว (${loan.person})`;
    c.push({ imei: s, model: state.hdr.model.trim() });
  } else {
    if (!loan) return `✗ ${s} ไม่ได้อยู่ในสถานะถูกเบิก`;
    c.push({ imei: s, model: loan.model, person: loan.person });
  }
  renderCart(kind); saveDraft();
  return `✓ ${s}${c[c.length - 1].model ? ' · ' + c[c.length - 1].model : ''} (รวม ${c.length})`;
}
function cartHtml(kind) {
  const c = state.cart[kind];
  if (!c.length) return '<p class="muted center">ยังไม่มีเครื่อง — สแกนหรือพิมพ์ IMEI</p>';
  return c.slice().reverse().map(l => `<div class="line"><div class="grow"><b class="code">${esc(l.imei)}</b>
    <small>${[l.model, l.person].filter(Boolean).map(esc).join(' · ') || '&nbsp;'}</small></div>
    <button class="ghost" data-act="del" data-k="${kind}" data-imei="${esc(l.imei)}" aria-label="ลบ">✕</button></div>`).join('')
    + `<p class="total">รวม ${c.length} เครื่อง</p>`;
}
const renderCart = kind => { const e = $('#cart-' + kind); if (e) e.innerHTML = cartHtml(kind); };

const scanBox = kind => `
  <button class="primary big scanbtn" data-act="scan" data-k="${kind}"><i class="vfico"></i>สแกนด้วยกล้อง</button>
  <label style="margin-top:12px">เครื่องยิงบาร์โค้ด / พิมพ์ IMEI แล้วกด Enter
    <input class="wedge" data-k="${kind}" inputmode="numeric" placeholder="ยิง IMEI ที่นี่" autocomplete="off" enterkeyhint="done"></label>
  <details style="margin-bottom:10px"><summary class="muted" style="cursor:pointer">วางหลายเครื่องพร้อมกัน</summary>
    <textarea id="bulk-${kind}" rows="3" placeholder="คั่นด้วยบรรทัดหรือเว้นวรรค"></textarea>
    <button data-act="addBulk" data-k="${kind}" style="width:100%;margin-top:6px">เพิ่มรายการที่วาง</button></details>
  <label class="chk"><input type="checkbox" data-bind="loose" ${state.loose ? 'checked' : ''}> ไม่ตรวจรูปแบบ IMEI (ใช้กับเลขซีเรียลอื่น)</label>
  <div id="cart-${kind}">${cartHtml(kind)}</div>`;

/* ---------- views ---------- */
function viewLogin() {
  return `<section class="card" style="margin-top:20px"><h2>เข้าสู่ระบบ</h2>
    <form id="loginForm">
      <label>อีเมล<input name="email" type="email" autocomplete="username" required></label>
      <label>รหัสผ่าน<input name="password" type="password" autocomplete="current-password" required></label>
      <button class="primary big" style="margin-top:4px">เข้าสู่ระบบ</button>
    </form>
    <small style="margin-top:12px">บัญชีผู้ใช้สร้างโดยผู้ดูแลระบบใน Supabase (Authentication → Users)</small></section>`;
}
const viewSetup = () => `<section class="card" style="margin-top:20px"><h2>ยังไม่ได้ตั้งค่า Supabase</h2>
  <p class="muted">ไม่พบ <code>SUPABASE_URL</code> / <code>SUPABASE_ANON_KEY</code> (หรือโหลดไลบรารีไม่สำเร็จ)<br>
  บน Vercel: Settings → Environment Variables แล้ว Redeploy<br>ในเครื่อง: แก้ไฟล์ <code>public/config.js</code></p></section>`;

const peopleList = () => [...new Set([...state.open.map(l => l.person), ...state.docs.filter(d => d.type === 'ISSUE').map(d => d.person)].filter(Boolean))].sort((a, b) => a.localeCompare(b, 'th'));
const errBanner = () => state.loadErr ? `<p class="badge err" style="display:block;white-space:normal;margin-bottom:12px">โหลดข้อมูลไม่สำเร็จ: ${esc(state.loadErr)}</p>` : '';

function viewIssue() {
  const h = state.hdr;
  return errBanner() + `<section class="card"><h2>ข้อมูลการเบิก</h2>
    <label>ผู้เบิก *<input data-bind="hdr.person" value="${esc(h.person)}" list="people" autocomplete="off"></label>
    <datalist id="people">${peopleList().map(x => `<option value="${esc(x)}">`).join('')}</datalist>
    <label>แผนก / งาน<input data-bind="hdr.dept" value="${esc(h.dept)}"></label>
    <label>วัตถุประสงค์การใช้<input data-bind="hdr.purpose" value="${esc(h.purpose)}"></label>
    <label>หมายเหตุ<input data-bind="hdr.note" value="${esc(h.note)}"></label></section>
  <section class="card"><h2>สแกนเครื่องที่จะเบิก</h2>
    <label>รุ่นเครื่อง (ไม่บังคับ — ใช้กับเครื่องที่สแกนต่อจากนี้)<input data-bind="hdr.model" value="${esc(h.model)}" placeholder="เช่น iPhone 15 128GB"></label>
    ${scanBox('issue')}</section>
  <button class="primary big" data-act="commitIssue">✅ ยืนยันการเบิก</button>`;
}

function viewReturn() {
  const by = new Map(); state.open.forEach(l => by.set(l.person, (by.get(l.person) || 0) + 1));
  const people = [...by.keys()].sort((a, b) => a.localeCompare(b, 'th'));
  return errBanner() + `<section class="card"><h2>คืนทั้งชุดของผู้เบิก</h2>
    ${people.length ? `<label>ผู้เบิกที่มีเครื่องค้างอยู่<select data-bind="retPerson"><option value="">— เลือกผู้เบิก —</option>
      ${people.map(x => `<option value="${esc(x)}" ${x === state.retPerson ? 'selected' : ''}>${esc(x)} (${by.get(x)} เครื่อง)</option>`).join('')}</select></label>
      <button data-act="addPerson" style="width:100%">ใส่เครื่องทั้งหมดของคนนี้</button>`
      : '<p class="muted center" style="margin:0">ไม่มีเครื่องค้างอยู่</p>'}
    <label style="margin-top:12px">หมายเหตุ (เช่น สภาพเครื่อง)<input data-bind="rnote" value="${esc(state.rnote)}"></label></section>
  <section class="card"><h2>สแกนเครื่องที่คืน</h2>${scanBox('return')}</section>
  <button class="primary big" data-act="commitReturn">✅ ยืนยันการคืน</button>`;
}

function outListHtml() {
  const q = state.outQ.trim().toLowerCase();
  const list = state.open.filter(l => !q || [l.imei, l.model, l.person, l.dept, l.purpose, l.issue_doc].some(x => String(x || '').toLowerCase().includes(q)));
  return list.length ? list.slice(0, 200).map(l => { const n = daysSince(l.issued_at); return `<div class="card item doc t-ISSUE"><div class="line" style="border:0;padding:0">
    <div class="grow"><b class="code">${esc(l.imei)}</b>${l.model ? ' ' + esc(l.model) : ''}
      <small><b>${esc(l.person)}</b>${l.dept ? ' · ' + esc(l.dept) : ''}</small>
      <small>เบิก ${fmt(l.issued_at)} · <span class="code">${esc(l.issue_doc)}</span></small></div>
    <div style="text-align:right"><span class="badge ${n >= 7 ? 'err' : 'warn'}">${n === 0 ? 'วันนี้' : n + ' วัน'}</span><br>
    <button data-act="retOne" data-imei="${esc(l.imei)}" style="margin-top:8px;padding:6px 12px">คืน</button></div></div></div>`; }).join('')
    + (list.length > 200 ? `<p class="muted center">แสดง 200 จาก ${list.length} — ใช้ช่องค้นหาเพื่อกรอง</p>` : '')
    : '<p class="muted center">ไม่พบรายการ</p>';
}
const renderOutList = () => { const e = $('#outList'); if (e) e.innerHTML = outListHtml(); };
function viewOut() {
  const people = new Set(state.open.map(l => l.person)).size;
  return errBanner() + `<input data-bind="outQ" placeholder="ค้นหา IMEI / รุ่น / ผู้เบิก / เลขที่เอกสาร" value="${esc(state.outQ)}" style="margin-bottom:10px">
    <p class="muted">เครื่องที่ถูกเบิกอยู่ <b>${state.open.length}</b> เครื่อง · ${people} คน</p>
    <div class="row"><button data-act="reload">🔄 รีเฟรช</button><button data-act="exportCsv">⬇️ ส่งออก CSV</button></div>
    <div id="outList">${outListHtml()}</div>`;
}

const docSummary = d => { const n = d.document_items.length, f = d.document_items[0]; return n ? `${esc(f.model ? f.model + ' · ' : '')}${esc(f.imei)}${n > 1 ? ` และอีก ${n - 1} เครื่อง` : ''}` : ''; };
function historyListHtml() {
  const q = state.hq.trim().toLowerCase(), t = state.ht;
  const list = state.docs.filter(d => (!t || d.type === t) && (!q || [d.doc_no, d.person, d.dept, d.purpose, d.note, ...d.document_items.flatMap(i => [i.imei, i.model])].some(x => String(x || '').toLowerCase().includes(q))));
  const html = list.length ? list.map(d => {
    let st = '';
    if (d.type === 'ISSUE') { const n = d.document_items.filter(i => state.openMap.get(i.imei)?.issue_doc === d.doc_no).length; st = `<span class="badge ${n ? 'warn' : 'ok'}">${n ? 'ค้าง ' + n : 'คืนครบ'}</span>`; }
    return `<div class="card item doc t-${d.type}" data-act="viewDoc" data-no="${esc(d.doc_no)}"><div class="line" style="border:0;padding:0"><div class="grow">
      <span class="badge ${TYPE_CLS[d.type]}">${TYPE[d.type]}</span> <b>${esc(d.doc_no)}</b>
      <small>${fmt(d.created_at)} · ${esc(d.person || '-')}${d.dept ? ' · ' + esc(d.dept) : ''}</small><small>${docSummary(d)}</small></div>${st}</div></div>`;
  }).join('') : '<p class="muted center">ไม่มีรายการ</p>';
  return html + (state.docs.length >= state.docsLimit ? '<button data-act="moreDocs" style="width:100%">โหลดเพิ่ม</button>' : '');
}
const renderHistoryList = () => { const e = $('#histList'); if (e) e.innerHTML = historyListHtml(); };
function viewHistory() {
  return errBanner() + `<div class="row"><input data-bind="hq" placeholder="ค้นหา เลขที่เอกสาร / ผู้เบิก / IMEI" value="${esc(state.hq)}">
    <select data-bind="ht"><option value="">ทั้งหมด</option>${Object.entries(TYPE).map(([k, v]) => `<option value="${k}" ${state.ht === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    <div id="histList">${historyListHtml()}</div>`;
}

function viewSettings() {
  return `<section class="card"><h2>ผู้ใช้งาน</h2>
    <p class="muted" style="margin-bottom:8px">เข้าสู่ระบบเป็น <b>${esc(state.session?.user?.email || '-')}</b></p>
    <label>ชื่อผู้บันทึก (ใส่ในทุกเอกสาร — ถ้าเว้นว่างจะใช้อีเมล)<input data-bind="operator" value="${esc(state.operator)}"></label>
    <button class="danger" data-act="logout" style="width:100%">ออกจากระบบ</button></section>
  <section class="card"><h2>ข้อมูล</h2>
    <p class="muted">ข้อมูลเก็บบน Supabase ใช้ร่วมกันทุกเครื่อง/ทุกคน (ต้องออนไลน์)</p>
    <div class="row"><button data-act="reload">🔄 โหลดข้อมูลใหม่</button><button data-act="exportCsv">⬇️ ส่งออก CSV</button></div></section>
  <section class="card"><h2>วิธีใช้</h2><p class="muted">1) แท็บ “เบิก” กรอกผู้เบิก → สแกน IMEI ทีละเครื่อง → ยืนยัน<br>2) แท็บ “คืน” สแกนเครื่องที่คืน (หรือเลือกผู้เบิกแล้วกดใส่ทั้งหมด) → ยืนยัน<br>3) แท็บ “ค้างอยู่” ดูเครื่องที่ยังไม่คืน กด “คืน” ได้ทันที<br>4) กล้องต้องใช้ผ่าน HTTPS · ติดตั้งเป็นแอปได้จากเมนูเบราว์เซอร์ “เพิ่มไปยังหน้าจอหลัก”</p></section>`;
}

const views = { issue: viewIssue, return: viewReturn, out: viewOut, history: viewHistory, settings: viewSettings };
function render() {
  document.body.classList.toggle('noauth', !state.session);
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.view === state.view));
  $('#nav [data-view="out"]')?.setAttribute('data-n', state.open.length || '');
  $('#app').innerHTML = !configured ? viewSetup() : !state.session ? viewLogin() : views[state.view]();
  window.scrollTo(0, 0);
}

/* ---------- commits ---------- */
const commitIssue = () => guarded(async () => {
  const h = state.hdr, cart = state.cart.issue;
  if (!h.person.trim()) return toast('กรุณาระบุผู้เบิก', true);
  if (!cart.length) return toast('ยังไม่ได้สแกนเครื่อง', true);
  const { data, error } = await sb.rpc('issue_devices', {
    p_person: h.person.trim(), p_dept: h.dept.trim(), p_purpose: h.purpose.trim(), p_note: h.note.trim(), p_by: opName(),
    p_items: cart.map(l => ({ imei: l.imei, model: l.model || '' }))
  });
  if (error) { await refresh(); return toast(errMsg(error), true); }
  state.cart.issue = []; state.hdr = { person: '', dept: '', purpose: '', note: '', model: '' }; saveDraft();
  await refresh(); render(); toast('บันทึกการเบิก ' + data); showDoc(data);
});
const commitReturn = () => guarded(async () => {
  const cart = state.cart.return;
  if (!cart.length) return toast('ยังไม่ได้สแกนเครื่องที่คืน', true);
  const { data, error } = await sb.rpc('return_devices', { p_imeis: cart.map(l => l.imei), p_by: opName(), p_note: state.rnote.trim() });
  if (error) { await refresh(); return toast(errMsg(error), true); }
  state.cart.return = []; state.rnote = ''; state.retPerson = ''; saveDraft();
  await refresh(); render(); toast('บันทึกการคืน ' + data); showDoc(data);
});

/* ---------- dialogs ---------- */
const dlg = () => $('#dlg');
function showDialog(html) { dlg().innerHTML = html; if (!dlg().open) dlg().showModal(); }
function showDoc(no) {
  const d = state.docs.find(x => x.doc_no === no); if (!d) return;
  const iss = d.type === 'ISSUE';
  showDialog(`<h2>${TYPE[d.type]} · ${esc(d.doc_no)}</h2>
    <p>วันที่: ${fmt(d.created_at)}<br>${iss ? 'ผู้เบิก' : 'ผู้คืน'}: <b>${esc(d.person || '-')}</b>${d.dept ? '<br>แผนก/งาน: ' + esc(d.dept) : ''}
    ${d.purpose ? '<br>วัตถุประสงค์: ' + esc(d.purpose) : ''}${d.note ? '<br>หมายเหตุ: ' + esc(d.note) : ''}<br>บันทึกโดย: ${esc(d.by_name || '-')}</p>
    <table><tr><th>IMEI</th><th>รุ่น</th>${iss ? '<th class="r">สถานะ</th>' : ''}</tr>
    ${d.document_items.map(i => `<tr><td>${esc(i.imei)}</td><td>${esc(i.model || '-')}</td>${iss ? `<td class="r">${state.openMap.get(i.imei)?.issue_doc === d.doc_no ? '<span class="badge warn">ค้าง</span>' : '<span class="badge ok">คืนแล้ว</span>'}</td>` : ''}</tr>`).join('')}</table>
    <p class="muted" style="margin-top:8px">รวม ${d.document_items.length} เครื่อง</p>
    <div class="row" style="margin-top:12px"><button data-act="printDoc" data-no="${esc(d.doc_no)}" data-mode="table">🖨️ พิมพ์ทั้งใบ</button><button data-act="printDoc" data-no="${esc(d.doc_no)}" data-mode="slip">🖨️ แยกทีละเครื่อง</button></div>
    <button class="primary big" data-act="closeDlg" style="margin-top:0">ปิด</button>`);
}
function printDoc(no, mode = 'table') {
  const d = state.docs.find(x => x.doc_no === no); if (!d) return;
  const iss = d.type === 'ISSUE', title = iss ? 'ใบเบิกเครื่อง' : 'ใบคืนเครื่อง', who = iss ? 'ผู้เบิก' : 'ผู้คืน';
  const dt = new Date(d.created_at).toLocaleString('th-TH', { dateStyle: 'long', timeStyle: 'short' });
  const items = d.document_items, n = items.length;
  const row = (k, v) => v ? `<div><span>${k}</span>${esc(v)}</div>` : '';
  const info = [row(who, d.person), row('แผนก / งาน', d.dept), row('วันที่', dt), row('ผู้บันทึก', d.by_name), row('วัตถุประสงค์', d.purpose), row('หมายเหตุ', d.note)].join('');
  const sign = `<div class="sign"><div><i></i><small>ลงชื่อ${iss ? 'ผู้รับเครื่อง' : 'ผู้คืนเครื่อง'}</small><small>วันที่ ____ / ____ / ________</small></div>
    <div><i></i><small>ลงชื่อ${iss ? 'ผู้จ่ายเครื่อง' : 'ผู้รับคืน'}</small><small>วันที่ ____ / ____ / ________</small></div></div>`;
  const head = (extra = '') => `<div class="hd"><div><h1>${title}</h1><div class="sub">${extra || (n + ' เครื่อง')}</div></div><div class="no">${esc(d.doc_no)}</div></div>`;
  let body;
  if (mode === 'slip') {
    body = items.map((it, i) => `<section class="slip">${head(`เครื่องที่ ${i + 1} / ${n}`)}<div class="info">${info}</div>
      <div class="dev"><span>รุ่นเครื่อง</span><b>${esc(it.model || '-')}</b><span>IMEI / ซีเรียล</span><b class="imei">${esc(it.imei)}</b></div>${sign}</section>`).join('');
  } else {
    body = `<section class="page">${head()}<div class="info">${info}</div>
      <table><thead><tr><th style="width:40px">#</th><th>รุ่นเครื่อง</th><th>IMEI / ซีเรียล</th><th style="width:26%">สภาพ / หมายเหตุ</th></tr></thead>
      <tbody>${items.map((it, i) => `<tr><td>${i + 1}</td><td>${esc(it.model || '-')}</td><td class="imei">${esc(it.imei)}</td><td></td></tr>`).join('')}</tbody></table>
      <p class="sum">รวม ${n} เครื่อง</p>${sign}</section>`;
  }
  const css = `@page{size:A4;margin:14mm}*{box-sizing:border-box}
  body{font:13px/1.55 "IBM Plex Sans Thai","Noto Sans Thai",system-ui,sans-serif;color:#101820;margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .bar{height:7px;margin-bottom:12px;background:repeating-linear-gradient(135deg,#ffc20e 0 9px,#101820 9px 18px)}
  .hd{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #101820;padding-bottom:8px}
  h1{font-size:24px;margin:0;line-height:1.2}.sub{color:#5d6a75;font-size:12.5px}
  .no{font:600 16px "IBM Plex Mono",ui-monospace,monospace;background:#ffc20e;padding:4px 10px;border-radius:4px}
  .info{display:grid;grid-template-columns:1fr 1fr;gap:8px 28px;margin:14px 0}
  .info div{border-bottom:1px dotted #8a96a0;padding-bottom:3px;min-height:38px}
  .info span,.dev span{display:block;color:#5d6a75;font-size:11.5px}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  th{background:#101820;color:#fff;font-weight:600;font-size:12px;padding:7px 9px;text-align:left}
  td{padding:9px;border-bottom:1px solid #c9d0d6}tr{break-inside:avoid}tr:nth-child(even) td{background:#f3f5f6}
  td.imei,.imei{font:500 13.5px "IBM Plex Mono",ui-monospace,monospace;letter-spacing:.04em}
  .sum{text-align:right;font-weight:700;margin:10px 0 0}
  .sign{display:flex;gap:36px;margin-top:44px;break-inside:avoid}.sign div{flex:1;text-align:center}
  .sign i{display:block;border-bottom:1px solid #101820;height:34px}.sign small{display:block;margin-top:6px;color:#5d6a75}
  .slip{border:1.5px solid #101820;border-radius:8px;padding:12px 16px 14px;margin-bottom:12px;break-inside:avoid;page-break-inside:avoid}
  .slip .info{margin:10px 0}.slip .info div{min-height:0}.slip .sign{margin-top:26px}
  .dev{background:#fff8dc;border:1.5px dashed #e0a800;border-radius:6px;padding:8px 14px}
  .dev b{display:block;font-size:19px;margin-bottom:6px}.dev b.imei{font-size:21px;margin:0}
  .foot{margin-top:14px;color:#8a96a0;font-size:11px;text-align:center}`;
  const w = window.open('', '_blank'); if (!w) return toast('เบราว์เซอร์บล็อกหน้าต่างพิมพ์', true);
  w.document.write(`<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${esc(d.doc_no)}</title>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@400;600;700&family=IBM+Plex+Mono:wght@500&display=swap">
  <style>${css}</style></head><body><div class="bar"></div>${body}<div class="foot">พิมพ์เมื่อ ${esc(new Date().toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }))}</div>
  <script>(document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve()).then(()=>setTimeout(()=>print(),250));<\/script></body></html>`);
  w.document.close();
}

/* ---------- actions ---------- */
const actions = {
  scan: d => openScanner(code => addImei(d.k, code), { multi: true }),
  del: d => { state.cart[d.k] = state.cart[d.k].filter(x => x.imei !== d.imei); renderCart(d.k); saveDraft(); },
  addBulk: d => {
    const ta = $('#bulk-' + d.k); if (!ta) return;
    const bad = [];
    ta.value.split(/[\s,;]+/).filter(Boolean).forEach(x => { if (addImei(d.k, x).startsWith('✗')) bad.push(x); });
    ta.value = bad.join('\n');
    toast(bad.length ? `เพิ่มไม่ได้ ${bad.length} รายการ (เหลือไว้ในช่องวาง)` : 'เพิ่มรายการแล้ว', !!bad.length);
  },
  addPerson: () => {
    if (!state.retPerson) return toast('เลือกผู้เบิกก่อน', true);
    let n = 0;
    state.open.filter(l => l.person === state.retPerson).forEach(l => { if (!state.cart.return.some(x => x.imei === l.imei)) { state.cart.return.push({ imei: l.imei, model: l.model, person: l.person }); n++; } });
    renderCart('return'); saveDraft(); toast(n ? `เพิ่ม ${n} เครื่อง` : 'เครื่องของคนนี้อยู่ในรายการครบแล้ว');
  },
  retOne: d => {
    const r = addImei('return', d.imei);
    if (r.startsWith('✗') && !r.includes('ซ้ำ')) return toast(r, true);
    state.view = 'return'; render(); toast(r.startsWith('✗') ? 'เครื่องนี้อยู่ในรายการคืนแล้ว' : 'ใส่ในรายการคืนแล้ว');
  },
  commitIssue, commitReturn,
  viewDoc: d => showDoc(d.no),
  printDoc: d => printDoc(d.no, d.mode),
  closeDlg: () => dlg().close(),
  reload: () => guarded(async () => { await refresh(); render(); toast(state.loadErr || 'โหลดข้อมูลแล้ว', !!state.loadErr); }),
  moreDocs: () => guarded(async () => { state.docsLimit += 300; await loadDocs(); renderHistoryList(); }),
  logout: async () => {
    if (!confirm('ออกจากระบบ?')) return;
    await sb.auth.signOut(); state.session = null; state.open = []; state.openMap = new Map(); state.docs = []; render();
  },
  exportCsv: () => guarded(async () => {
    const rows = await fetchAll((a, b) => sb.from('loans').select('*').order('issued_at', { ascending: false }).order('id').range(a, b));
    const head = ['IMEI', 'รุ่น', 'ผู้เบิก', 'แผนก', 'วัตถุประสงค์', 'วันที่เบิก', 'เลขที่ใบเบิก', 'ผู้จ่าย', 'สถานะ', 'วันที่คืน', 'เลขที่ใบคืน', 'ผู้รับคืน'];
    const lines = rows.map(l => [l.imei, l.model, l.person, l.dept, l.purpose, new Date(l.issued_at).toLocaleString('sv-SE'), l.issue_doc, l.issued_by,
      l.returned_at ? 'คืนแล้ว' : 'ค้างอยู่', l.returned_at ? new Date(l.returned_at).toLocaleString('sv-SE') : '', l.return_doc || '', l.returned_by || '']);
    download('loans-' + new Date().toISOString().slice(0, 10) + '.csv', '﻿' + [head, ...lines].map(r => r.map(csvCell).join(',')).join('\r\n'), 'text/csv');
  })
};

/* ---------- events ---------- */
document.addEventListener('click', e => {
  const nav = e.target.closest('[data-view]');
  if (nav) {
    const v = nav.dataset.view; state.view = v; render();
    if (v !== 'settings') refresh().then(() => { if (state.view === v && v !== 'issue') render(); else if (state.view === 'issue') { const l = $('#people'); if (l) l.innerHTML = peopleList().map(x => `<option value="${esc(x)}">`).join(''); } });
    return;
  }
  const a = e.target.closest('[data-act]');
  if (a) actions[a.dataset.act]?.(a.dataset);
});
function onBind(e) {
  const t = e.target, b = t.dataset.bind; if (!b) return;
  const v = t.type === 'checkbox' ? t.checked : t.value;
  const [o, k] = b.split('.');
  if (k) state[o][k] = v; else state[o] = v;
  if (b === 'outQ') renderOutList();
  else if (b === 'hq' || b === 'ht') renderHistoryList();
  else if (b === 'operator') { try { localStorage.setItem('operator', v); } catch { } }
  if (b.startsWith('hdr.') || b === 'rnote' || b === 'retPerson') saveDraft();
}
document.addEventListener('input', onBind);
document.addEventListener('change', onBind);
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !e.target.classList?.contains('wedge')) return;
  e.preventDefault();
  const code = e.target.value.trim(); e.target.value = ''; if (!code) return;
  const r = addImei(e.target.dataset.k, code);
  beep(!r.startsWith('✗')); toast(r, r.startsWith('✗'));
});
document.addEventListener('submit', e => {
  if (e.target.id !== 'loginForm') return;
  e.preventDefault();
  const f = new FormData(e.target);
  guarded(async () => {
    const { data, error } = await sb.auth.signInWithPassword({ email: String(f.get('email')).trim(), password: String(f.get('password')) });
    if (error) return toast(/invalid login/i.test(error.message) ? 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' : errMsg(error), true);
    state.session = data.session; await refresh(); render();
  });
});
const setNet = () => { const n = $('#net'); n.textContent = navigator.onLine ? 'ออนไลน์' : 'ออฟไลน์'; n.className = 'badge ' + (navigator.onLine ? 'ok' : 'warn'); };
addEventListener('online', setNet); addEventListener('offline', setNet);

/* ---------- boot ---------- */
(async () => {
  setNet();
  try { state.operator = localStorage.getItem('operator') || ''; } catch { }
  if (configured) {
    loadDraft();
    try { state.session = (await sb.auth.getSession()).data.session; } catch { }
    sb.auth.onAuthStateChange((ev, s) => { if (ev === 'SIGNED_OUT') { state.session = null; render(); } else if (s) state.session = s; });
    if (state.session) {
      await refresh();
      state.cart.return = state.cart.return.filter(l => state.openMap.has(l.imei)); // ตัดเครื่องที่ไม่ได้ค้างแล้วออกจากร่าง
    }
  }
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
})();
