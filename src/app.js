(() => {
'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);

// ================= storage =================
const KEY = 'timesgrader.v2';
let S = { key: null, papers: [], settings: { sound: true, apiKey: '', claudeAssist: true } };
try { const raw = localStorage.getItem(KEY); if (raw) { const o = JSON.parse(raw); S.key = o.key || null; S.papers = o.papers || []; Object.assign(S.settings, o.settings || {}); } } catch (e) { /* storage unavailable */ }
let saveT;
function save() { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast('Storage is full. Export, then start a new stack.'); } }, 150); }
const memImg = {};
let dbp = null;
function idb() {
  if (!dbp) dbp = new Promise(res => {
    try { const r = indexedDB.open('timesgrader', 1); r.onupgradeneeded = () => r.result.createObjectStore('pages'); r.onsuccess = () => res(r.result); r.onerror = () => res(null); } catch (e) { res(null); }
  });
  return dbp;
}
async function putImg(id, blob) { memImg[id] = blob; const db = await idb(); if (!db) return; try { db.transaction('pages', 'readwrite').objectStore('pages').put(blob, id); } catch (e) { /* memory only */ } }
async function getImg(id) {
  if (memImg[id]) return memImg[id];
  const db = await idb(); if (!db) return null;
  return new Promise(res => { try { const r = db.transaction('pages').objectStore('pages').get(id); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); } catch (e) { res(null); } });
}
async function delImg(id) { delete memImg[id]; if (urls[id]) { URL.revokeObjectURL(urls[id]); delete urls[id]; } const db = await idb(); if (!db) return; try { db.transaction('pages', 'readwrite').objectStore('pages').delete(id); } catch (e) { /* */ } }
const urls = {};
async function imgURL(id) { if (urls[id]) return urls[id]; const b = await getImg(id); if (!b) return null; return (urls[id] = URL.createObjectURL(b)); }

// ================= reading engine (runs in a worker so the camera stays smooth) =================
const WORKER_MAIN = `
let TPL = null;
self.onmessage = e => {
  const m = e.data;
  try {
    if (m.type === 'init') { Reader.load(m.model); self.postMessage({ type: 'ready', id: 'init' }); }
    else if (m.type === 'flatten') {
      const f = Paper.rectify(m.rgba, m.w, m.h, m.quad, 1600);
      self.postMessage({ type: 'flat', id: m.id, data: f.data, width: f.width, height: f.height }, [f.data.buffer]);
    } else if (m.type === 'template') {
      const g = Paper.toGray(m.rgba, m.W, m.H);
      TPL = Reader.buildTemplate(g, m.W, m.H, m.problems);
      self.postMessage({ type: 'template', id: m.id, items: TPL.items, found: TPL.found });
    } else if (m.type === 'grade') {
      if (!TPL) throw new Error('No answer key loaded');
      const t0 = Date.now();
      const f = Paper.rectify(m.rgba, m.w, m.h, m.quad, 1600, TPL.W, TPL.H), g = Paper.toGray(f.data, f.width, f.height);
      const res = m.expected.map((x, i) => { const r = Reader.gradeItem(g, f.width, f.height, TPL, i, x); return { verdict: r.verdict, read: r.read, conf: r.conf }; });
      self.postMessage({ type: 'graded', id: m.id, res, ms: Date.now() - t0, data: f.data, width: f.width, height: f.height }, [f.data.buffer]);
    }
  } catch (err) { self.postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) }); }
};`;
const engine = (() => {
  const pending = {};
  let post, ready;
  const onMsg = m => { const p = pending[m.id]; if (p) { delete pending[m.id]; m.type === 'error' ? p.rej(new Error(m.message)) : p.res(m); } };
  const model = JSON.parse($('#digitModel').textContent);
  try {
    const src = $('#paperSrc').textContent + '\n' + $('#readerSrc').textContent + '\n' + WORKER_MAIN;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    w.onmessage = e => onMsg(e.data);
    post = (msg, tr) => w.postMessage(msg, tr || []);
    ready = new Promise((res, rej) => { pending.init = { res, rej }; post({ type: 'init', id: 'init', model }); setTimeout(() => rej(new Error('worker timeout')), 8000); })
      .catch(() => fallbackInThread());
  } catch (e) { ready = Promise.resolve(fallbackInThread()); }
  function fallbackInThread() {
    // same code, on the main thread (slower, but works where workers are blocked)
    Reader.load(model);
    let TPL = null;
    post = msg => setTimeout(() => {
      try {
        if (msg.type === 'flatten') { const f = Paper.rectify(msg.rgba, msg.w, msg.h, msg.quad, 1600); onMsg({ type: 'flat', id: msg.id, data: f.data, width: f.width, height: f.height }); }
        else if (msg.type === 'template') { TPL = Reader.buildTemplate(Paper.toGray(msg.rgba, msg.W, msg.H), msg.W, msg.H, msg.problems); onMsg({ type: 'template', id: msg.id, items: TPL.items, found: TPL.found }); }
        else if (msg.type === 'grade') {
          const t0 = Date.now(), f = Paper.rectify(msg.rgba, msg.w, msg.h, msg.quad, 1600, TPL.W, TPL.H), g = Paper.toGray(f.data, f.width, f.height);
          onMsg({ type: 'graded', id: msg.id, res: msg.expected.map((x, i) => { const r = Reader.gradeItem(g, f.width, f.height, TPL, i, x); return { verdict: r.verdict, read: r.read, conf: r.conf }; }), ms: Date.now() - t0, data: f.data, width: f.width, height: f.height });
        }
      } catch (err) { onMsg({ type: 'error', id: msg.id, message: String(err.message || err) }); }
    }, 0);
  }
  return {
    async call(msg, transfer) { await ready; return new Promise((res, rej) => { pending[msg.id] = { res, rej }; post(msg, transfer); }); },
  };
})();
let templateReady = null; // Promise when the key's template is loaded in the engine

// ================= grading helpers =================
function expectedOf(p) {
  switch (p.op) { case '+': return p.a + p.b; case '-': return p.a - p.b; case '÷': return p.b ? p.a / p.b : NaN; default: return p.a * p.b; }
}
const keyAnswer = k => String(k.key || '').replace(/\D/g, '') || String(expectedOf(k));
function verdict(paper, i) { const ov = paper.ov?.[i]; if (ov !== undefined) return ov ? 'right' : 'wrong'; return paper.probs[i].v; }
function scoreOf(paper) {
  if (paper.status !== 'done' || !paper.probs?.length) return null;
  let c = 0, u = 0; paper.probs.forEach((_, i) => { const v = verdict(paper, i); if (v === 'right') c++; else if (v === 'unsure') u++; });
  return { c, u, t: paper.probs.length, p: Math.round(100 * c / paper.probs.length) };
}
const band = p => p >= 80 ? 'hi' : p >= 60 ? 'mid' : 'lo';
const eqText = p => `${p.a} ${p.op || '×'} ${p.b}`;

// ================= Claude (key setup, names, double-checks) =================
let sampleP = null, dlP = null;
const hasClaude = () => !!(window.claude && typeof window.claude.use === 'function');
function getSample() { if (!sampleP) sampleP = hasClaude() ? window.claude.use('sample').catch(() => null) : Promise.resolve(null); return sampleP; }
function getDownloads() { if (!dlP) dlP = hasClaude() ? window.claude.use('downloads').catch(() => null) : Promise.resolve(null); return dlP; }
let claudeVia;
async function claudeStatus() { const s = await getSample(); if (s) { const lim = await s.limits().catch(() => null); if (lim?.images) return 'claude'; } return S.settings.apiKey ? 'api' : null; }
async function blobToB64(b) { const u = new Uint8Array(await b.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768)); return btoa(s); }
function parseLoose(t) { try { return JSON.parse(t); } catch (e) { /* */ } const a = t.indexOf('{'), b = t.lastIndexOf('}'); if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1)); throw new Error('Claude did not return readable results.'); }
async function askClaude(prompt, blob) {
  const via = await claudeStatus();
  if (via === 'claude') {
    const s = await getSample();
    try { return await s.json(prompt, { images: [blob], modelTier: 'default' }); }
    catch (e) { throw new Error({ not_granted: 'Claude access was declined for this page.', rate_limited: 'Claude is busy. Wait a minute and try again.', invalid_json: 'Claude returned an unreadable answer. Try again.' }[e?.code] || e?.message || 'Claude could not read this page.'); }
  }
  if (via === 'api') {
    const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': S.settings.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 8000, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await blobToB64(blob) } }, { type: 'text', text: prompt + '\nReply with only the JSON.' }] }] }) });
    if (!res.ok) throw new Error(res.status === 401 ? 'The API key was rejected. Check it in Settings.' : 'Claude API error ' + res.status);
    const j = await res.json(); return parseLoose(j.content.map(c => c.text || '').join(''));
  }
  throw new Error('Reading the answer key needs Claude. Open Times Grader inside Claude, or add an API key in Settings.');
}
const KEY_PROMPT = 'This image is a teacher\'s answer key for an elementary school math worksheet, photographed and flattened so the page fills the image. ' +
  'Find every arithmetic problem on the page (written across like "7 × 8 =" or stacked in columns). For each problem give: ' +
  'the problem number printed on the page (count top to bottom, then left to right, if there are none); the first number; the operation as one of "×", "+", "-", "÷"; the second number; ' +
  'the answer written on the key exactly as written ("" if no answer is written); and the box where the answer is written, or the empty space where the answer goes, ' +
  'as [x0, y0, x1, y1] with x from 0 at the left edge to 1000 at the right edge and y from 0 at the top to 1000 at the bottom. Keep the box tight around the answer only, ' +
  'not the printed problem or the = sign. Also give the box of the line where students write their name, and the worksheet title. ' +
  'Reply with only JSON: {"title": "Facts Practice 4", "name_box": [80, 60, 450, 90], "p": [[1, 7, "×", 8, "56", [400, 220, 470, 250]]]}';
function normKey(out) {
  const raw = Array.isArray(out?.p) ? out.p : [];
  const n01 = v => Number(v);
  const probs = raw.map((r, i) => {
    const o = Array.isArray(r) ? { n: r[0], a: r[1], op: r[2], b: r[3], key: r[4], box: r[5] } : r;
    let op = String(o.op ?? '×').trim(); op = /^[x*×X]$/.test(op) ? '×' : /^[÷/:]$/.test(op) ? '÷' : /^[-−–]$/.test(op) ? '-' : op === '+' ? '+' : '×';
    const box = Array.isArray(o.box) ? o.box.map(n01) : null;
    return { n: String(o.n ?? i + 1), a: Number(o.a), op, b: Number(o.b), key: String(o.key ?? '').trim(), box };
  }).filter(p => Number.isFinite(p.a) && Number.isFinite(p.b) && p.box && p.box.length === 4 && p.box.every(Number.isFinite));
  if (probs.length && probs.every(p => p.box.every(v => v <= 1.001))) probs.forEach(p => p.box = p.box.map(v => v * 1000));
  probs.forEach(p => { p.box = [Math.min(p.box[0], p.box[2]), Math.min(p.box[1], p.box[3]), Math.max(p.box[0], p.box[2]), Math.max(p.box[1], p.box[3])].map(v => Math.max(0, Math.min(1000, v))); });
  let nb = Array.isArray(out?.name_box) && out.name_box.length === 4 ? out.name_box.map(Number) : null;
  if (nb && !nb.every(Number.isFinite)) nb = null;
  if (nb && nb.every(v => v <= 1.001)) nb = nb.map(v => v * 1000);
  return { title: String(out?.title || '').slice(0, 60), nameBox: nb, probs };
}

// ================= key setup =================
async function loadTemplate() {
  if (!S.key) { templateReady = null; return; }
  templateReady = (async () => {
    const blob = await getImg('key'); if (!blob) throw new Error('The key photo is missing. Scan the key again.');
    const bmp = await createImageBitmap(blob), c = document.createElement('canvas'); c.width = S.key.W; c.height = S.key.H;
    const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bmp, 0, 0, S.key.W, S.key.H);
    const rgba = ctx.getImageData(0, 0, S.key.W, S.key.H).data;
    const problems = S.key.probs.map(p => ({ box: [p.box[0] * S.key.W / 1000, p.box[1] * S.key.H / 1000, p.box[2] * S.key.W / 1000, p.box[3] * S.key.H / 1000], answer: keyAnswer(p) }));
    const r = await engine.call({ type: 'template', id: 'tpl' + uid(), rgba, W: S.key.W, H: S.key.H, problems }, [rgba.buffer]);
    S.key.items = r.items; S.key.found = r.found; save();
    return r;
  })();
  templateReady.catch(e => toast(e.message));
  return templateReady;
}
async function setupKey(blob, W, H) {
  scan.keyStatus = 'reading'; scan.keyStarted = Date.now(); updateCard();
  try {
    const out = normKey(await askClaude(KEY_PROMPT, blob));
    if (!out.probs.length) throw new Error('No problems were found on the key. Try again with the whole page in view.');
    await putImg('key', blob);
    S.key = { at: Date.now(), title: out.title, nameBox: out.nameBox, probs: out.probs, W, H, items: null, found: 0 };
    S.papers.forEach(p => { if (p.status === 'done') p.stale = true; });
    save();
    scan.keyStatus = 'template';
    updateCard();
    await loadTemplate();
    scan.keyStatus = 'done'; beep(true, 2);
    if (scan.active) closeScanner();
    modal = { type: 'key' }; renderModal(); render();
  } catch (e) {
    scan.keyStatus = 'error'; scan.keyError = e.message; updateCard(); toast(e.message);
    if (scan.tracker) scan.tracker.recent = [];
  }
}

// ================= student pages =================
async function gradePage(paper, rgba, w, h, quad) {
  await templateReady;
  const expected = S.key.probs.map(keyAnswer);
  const r = await engine.call({ type: 'grade', id: paper.id, rgba, w, h, quad, expected }, [rgba.buffer]);
  paper.probs = S.key.probs.map((k, i) => {
    const it = S.key.items[i], c = it.core;
    return { n: k.n, a: k.a, op: k.op, b: k.b, exp: expected[i], ans: r.res[i].read, v: r.res[i].verdict, x: (c[0] + c[2]) / 2 / S.key.W * 1000, y: (c[1] + c[3]) / 2 / S.key.H * 1000, src: 'device' };
  });
  paper.ms = r.ms; paper.w = r.width; paper.h = r.height; paper.status = 'done';
  // keep the flattened page for review
  const c = document.createElement('canvas'); c.width = r.width; c.height = r.height;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.data.buffer), r.width, r.height), 0, 0);
  const t = document.createElement('canvas'); t.width = 72; t.height = Math.round(r.height * 72 / r.width); t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
  paper.thumb = t.toDataURL('image/jpeg', 0.6);
  if (S.key.nameBox) {
    const nb = S.key.nameBox, x0 = nb[0] * r.width / 1000, y0 = nb[1] * r.height / 1000, nw = (nb[2] - nb[0]) * r.width / 1000, nh = (nb[3] - nb[1]) * r.height / 1000;
    if (nw > 10 && nh > 5) { const n = document.createElement('canvas'); n.height = 48; n.width = Math.min(480, Math.round(48 * nw / nh)); n.getContext('2d').drawImage(c, x0, y0 - nh * 0.3, nw, nh * 1.5, 0, 0, n.width, n.height); paper.nameCrop = n.toDataURL('image/jpeg', 0.7); }
  }
  save();
  const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
  await putImg(paper.id, blob);
  if (S.settings.claudeAssist) assist(paper, blob);
}
// Claude in the background: the student's name and any answers the phone wasn't sure about
const assistQ = []; let assisting = 0;
function assist(paper, blob) { assistQ.push({ paper, blob }); pumpAssist(); }
async function pumpAssist() {
  if (assisting >= 2 || !assistQ.length) return;
  if (!(await claudeStatus())) { assistQ.length = 0; return; }
  const { paper, blob } = assistQ.shift(); assisting++;
  try {
    const unsure = paper.probs.map((p, i) => p.v === 'unsure' ? i : -1).filter(i => i >= 0);
    const ask = unsure.map(i => paper.probs[i].n);
    const out = await askClaude('This image is one elementary student\'s math worksheet, flattened. Read the student\'s name' +
      (ask.length ? ` and the student's handwritten answers to problems ${ask.join(', ')}. Copy each answer exactly as written, digit by digit; do not work out the problems or fix them; use "" for a blank answer` : '') +
      '. Reply with only JSON: {"name": "Maya", "answers": {"3": "56"}}', blob);
    if (out?.name && !paper.nameEdited) paper.name = String(out.name).slice(0, 60);
    const ans = out?.answers || {};
    for (const i of unsure) {
      const p = paper.probs[i], got = ans[p.n] ?? ans[String(p.n)];
      if (got === undefined) continue;
      const d = String(got).replace(/\D/g, '');
      p.ans = String(got); p.v = d && d === String(p.exp) ? 'right' : 'wrong'; p.src = 'claude';
    }
    save(); render(); if (modal?.id === paper.id) renderModal(); if (scan.active) updateCard();
  } catch (e) { /* the phone's reading stands */ }
  finally { assisting--; pumpAssist(); }
}

// ================= export =================
const donePapers = () => S.papers.filter(p => scoreOf(p));
function rows() {
  const out = [['Student', 'Right', 'Total', 'Percent', 'To check', 'Missed']];
  for (const p of donePapers()) {
    const s = scoreOf(p), missed = p.probs.filter((q, i) => verdict(p, i) === 'wrong').map(q => `${eqText(q)} (wrote ${q.ans || 'blank'})`);
    out.push([p.name || 'Unnamed', s.c, s.t, s.p + '%', s.u, missed.join('; ')]);
  }
  return out;
}
const csv = () => rows().map(r => r.map(c => { c = String(c); return /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c; }).join(',')).join('\n');
const tsv = () => rows().map(r => r.map(c => String(c).replace(/[\t\n]/g, ' ')).join('\t')).join('\n');
async function saveFile(name, text, mime) {
  const blob = new Blob([text], { type: mime }), dl = await getDownloads();
  if (dl) { try { const r = await dl.save({ filename: name, data: blob }); if (r?.status === 'saved') toast('Saved ' + name); } catch (e) { if (e?.code !== 'cancelled') toast('Could not save the file.'); } return; }
  if (hasClaude()) { toast('Saving files is not available in this view. Use Copy instead.'); return; }
  const u = URL.createObjectURL(blob), a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000);
}

// ================= home =================
let toastT; function toast(m) { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3000); }
const ICON = {
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>',
  cam: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>',
  key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2"/><path d="M8 9h8M8 12h8M8 15h5"/></svg>',
  logo: '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l4.5 4.5L20 6" stroke="#4CC38A" stroke-width="3"/></svg>',
};
let confirmArm = null;
function render() {
  const papers = S.papers.slice().sort((a, b) => b.at - a.at), done = donePapers();
  const avg = done.length ? Math.round(done.reduce((s, p) => s + scoreOf(p).p, 0) / done.length) : null;
  const miss = {};
  done.forEach(p => p.probs.forEach((q, i) => { if (verdict(p, i) === 'wrong') { const k = q.op === '×' || q.op === '+' ? `${Math.min(q.a, q.b)} ${q.op} ${Math.max(q.a, q.b)}` : eqText(q); miss[k] = (miss[k] || 0) + 1; } }));
  const facts = Object.entries(miss).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const K = S.key;
  const status = claudeVia === undefined ? '' : claudeVia ? `<div class="status"><span class="dot ok"></span><span>Claude reads the key once${claudeVia === 'api' ? ' with your API key' : ''}. Student pages are graded on this phone.</span></div>`
    : `<div class="status"><span class="dot warn"></span><span>Setting up a key needs Claude: open Times Grader inside Claude, or add an API key in <button class="linkbtn" data-act="settings" type="button">Settings</button>. Student pages are graded on this phone.</span></div>`;
  const keyCard = K ? `<section class="panel keycard">
      <div class="keyhead"><div style="min-width:0"><span class="label">Answer key</span><h2>${esc(K.title || 'Worksheet')}</h2>
        <p class="small muted">${K.probs.length} problems · ${K.items ? `${K.found} of ${K.probs.length} answer spots found` : 'loading…'}</p></div>
        <button class="btn" data-act="reviewkey" type="button">Review</button></div>
      <button class="btn primary big" data-act="grade" type="button">${ICON.cam} Grade papers</button>
      <div class="grid2"><button class="btn" data-act="video" type="button">Use a video</button><button class="btn" data-act="photos" type="button">Use photos</button></div>
    </section>`
    : `<section class="panel keycard"><span class="label">Step 1</span><h2>Scan your answer key</h2>
      <p class="muted small">Hold the phone over your filled-in key. Claude reads it once, in about 10 to 20 seconds. After that, every student page is graded on the phone the moment it's captured.</p>
      <button class="btn primary big" data-act="scankey" type="button">${ICON.key} Scan answer key</button>
      <div class="grid2"><button class="btn" data-act="keyphoto" type="button">Use a photo of the key</button></div></section>`;
  const rowsHtml = papers.map(p => {
    const s = scoreOf(p);
    const right = s ? `<b>${s.c}/${s.t}</b><span class="pill ${band(s.p)}">${s.p}%</span>` : p.status === 'error' ? '<span class="chip bad">Not graded</span>' : '<span class="chip">Grading…</span>';
    const who = p.name ? `<span class="nm">${esc(p.name)}</span>` : p.nameCrop ? `<img class="namecrop" src="${p.nameCrop}" alt="Handwritten name">` : '<span class="nm muted">No name yet</span>';
    return `<button class="prow" data-act="open" data-id="${p.id}" type="button">${p.thumb ? `<img class="mini" src="${p.thumb}" alt="">` : '<span class="mini"></span>'}
      <span class="who">${who}<span class="sub">${s ? `${s.t - s.c - s.u} wrong${s.u ? ` · ${s.u} to check` : ''}` : ''}${p.stale ? ' · <span class="chip ex">old key</span>' : ''}</span></span>
      <span class="right">${right}</span></button>`;
  }).join('');
  $('#app').innerHTML = `
  <div class="topbar"><div class="brand"><span class="logo">${ICON.logo}</span>Times Grader</div><button class="icon-btn" data-act="settings" aria-label="Settings" type="button">${ICON.gear}</button></div>
  <section class="hero"><h1>Grade times-table sheets live, page by page.</h1>
    <p class="muted">Scan your key once. Then hold the phone over each student's page: it captures on its own and marks every answer right on the page.</p></section>
  ${keyCard}
  ${status}
  ${done.length ? `<div class="stats"><div class="stat"><span class="label">Papers</span><b>${done.length}</b></div><div class="stat"><span class="label">Average</span><b>${avg}%</b></div><div class="stat"><span class="label">To check</span><b>${done.reduce((s, p) => s + scoreOf(p).u, 0)}</b></div></div>` : ''}
  ${facts.length ? `<section class="panel"><h3>Facts to reteach</h3><div class="facts">${facts.map(([k, n]) => `<span class="fact">${esc(k)} <span>missed ${n}×</span></span>`).join('')}</div></section>` : ''}
  <section style="display:flex;flex-direction:column;gap:10px"><div class="label">This stack</div>
    ${papers.length ? `<div class="plist">${rowsHtml}</div>` : `<div class="empty">${K ? 'Graded papers show up here.' : 'Scan the key first, then grade papers.'}</div>`}
    ${done.length ? `<div class="grid2"><button class="btn" data-act="csv" type="button">Export CSV</button><button class="btn" data-act="copy" type="button">Copy for Sheets</button></div>` : ''}
    ${papers.length ? `<button class="btn ghost danger" data-act="clear" type="button">${confirmArm === 'clear' ? 'Tap again to clear every paper' : 'Start a new stack'}</button>` : ''}
  </section>`;
}

// ================= modals =================
let modal = null;
function svgOverlay(W, H, probs, verdictOf, s) {
  return `<svg viewBox="0 0 ${W} ${H}">` + probs.map((p, i) => {
    const x = p.x * W / 1000, y = p.y * H / 1000, v = verdictOf(i), col = v === 'right' ? '#1FA864' : v === 'wrong' ? '#E5432D' : '#E0A21F';
    const d = v === 'right' ? `M${x - 0.45 * s} ${y} L${x - 0.12 * s} ${y + 0.38 * s} L${x + 0.55 * s} ${y - 0.5 * s}` : v === 'wrong' ? `M${x - 0.4 * s} ${y - 0.4 * s} L${x + 0.4 * s} ${y + 0.4 * s} M${x + 0.4 * s} ${y - 0.4 * s} L${x - 0.4 * s} ${y + 0.4 * s}` : '';
    return `<g class="tap" data-act="flip" data-i="${i}" role="button" aria-label="Problem ${esc(p.n)}: ${esc(eqText(p))}, read ${esc(p.ans || 'blank')}, ${v}">
      <circle cx="${x}" cy="${y}" r="${s * 0.8}" fill="${v === 'unsure' ? 'rgba(224,162,31,.18)' : 'transparent'}" ${v === 'unsure' ? 'stroke="#E0A21F" stroke-width="3"' : ''}/>
      ${d ? `<path d="${d}" fill="none" stroke="${col}" stroke-width="${s * 0.2}" stroke-linecap="round" stroke-linejoin="round" opacity=".9"/>` : `<text x="${x}" y="${y + s * 0.3}" text-anchor="middle" font-size="${s}" font-weight="800" fill="#E0A21F">?</text>`}
      ${v === 'wrong' ? `<text x="${x + 0.62 * s}" y="${y - 0.3 * s}" font-size="${s * 0.62}" font-weight="800" fill="#E5432D" font-family="ui-monospace, Menlo, monospace">${esc(String(p.exp ?? expectedOf(p)))}</text>` : ''}</g>`;
  }).join('') + '</svg>';
}
function sizeFor(W, H, probs) {
  const pts = probs.map(p => [p.x * W / 1000, p.y * H / 1000]);
  if (pts.length < 2) return W * 0.04;
  const d = pts.map((p, i) => Math.min(...pts.filter((_, j) => j !== i).map(q => Math.hypot(p[0] - q[0], p[1] - q[1])))).sort((a, b) => a - b);
  return Math.max(W * 0.015, Math.min(W * 0.05, d[d.length >> 1] * 0.38));
}
async function renderModal() {
  const root = $('#modalRoot');
  if (!modal) { root.innerHTML = ''; return; }
  if (modal.type === 'settings') {
    root.innerHTML = `<div class="modal" data-act="close"><div class="sheet" data-stop="1" role="dialog" aria-label="Settings">
      <div class="topbar"><h2 style="flex:1">Settings</h2><button class="btn" data-act="close" type="button">Close</button></div>
      <label class="check"><input type="checkbox" id="sound" ${S.settings.sound ? 'checked' : ''}> Beep when a page is captured</label>
      <label class="check"><input type="checkbox" id="assist" ${S.settings.claudeAssist ? 'checked' : ''}> Ask Claude in the background for student names and answers the phone isn't sure about</label>
      <div class="panel"><h3>Claude API key</h3><p class="small muted">Only needed when Times Grader runs on its own web address. Inside Claude, no key is needed.</p>
        <input type="password" id="apiKey" value="${esc(S.settings.apiKey)}" placeholder="sk-ant-…" autocomplete="off" aria-label="Anthropic API key">
        <p class="small muted">Kept in this browser and sent only to Anthropic.</p></div></div></div>`;
    return;
  }
  if (modal.type === 'key') {
    const K = S.key; if (!K) { modal = null; root.innerHTML = ''; return; }
    const src = await imgURL('key');
    const probs = K.probs.map((p, i) => { const it = K.items?.[i]; const c = it ? it.core : [p.box[0] * K.W / 1000, p.box[1] * K.H / 1000, p.box[2] * K.W / 1000, p.box[3] * K.H / 1000]; return { ...p, c, z: it?.zone, ok: it?.anchored }; });
    const mism = K.probs.filter(p => p.key && p.key.replace(/\D/g, '') !== String(expectedOf(p)));
    const boxes = `<svg viewBox="0 0 ${K.W} ${K.H}">${probs.map(p => `${p.z ? `<rect x="${p.z[0]}" y="${p.z[1]}" width="${p.z[2] - p.z[0]}" height="${p.z[3] - p.z[1]}" fill="none" stroke="${p.ok ? '#1FA864' : '#E0A21F'}" stroke-width="3" stroke-dasharray="${p.ok ? '0' : '8 6'}" rx="6"/>` : ''}`).join('')}</svg>`;
    root.innerHTML = `<div class="modal" data-act="close"><div class="sheet" data-stop="1" role="dialog" aria-label="Answer key">
      <div class="topbar"><div style="flex:1;min-width:0"><span class="label">Answer key</span><h2>${esc(K.title || 'Worksheet')}</h2></div><button class="btn" data-act="close" type="button">Close</button></div>
      <p class="small muted">${K.items ? `Found the answer spot for ${K.found} of ${K.probs.length} problems (green boxes).${K.found < K.probs.length ? ' Dashed boxes are a best guess: answers there get a "?" more often.' : ''}` : 'Locating answer spots…'}</p>
      ${mism.length ? `<p class="chip ex" style="align-self:flex-start">The key's answer doesn't match the math for ${mism.map(p => '#' + esc(p.n)).join(', ')}</p>` : ''}
      <div class="pagebox">${src ? `<img src="${src}" alt="Answer key">` : ''}${boxes}</div>
      <div class="keylist">${K.probs.map((p, i) => `<label class="krow"><span class="num">${esc(p.n)}.</span><span class="eq">${esc(eqText(p))} =</span><input type="text" inputmode="numeric" data-keyi="${i}" value="${esc(keyAnswer(p))}" aria-label="Answer for problem ${esc(p.n)}">${K.items && !K.items[i]?.anchored ? '<span class="chip ex">guess</span>' : ''}</label>`).join('')}</div>
      <button class="btn primary big" data-act="grade" type="button">${ICON.cam} Grade papers</button>
      <button class="btn" data-act="scankey" type="button">Scan a different key</button></div></div>`;
    return;
  }
  const p = S.papers.find(x => x.id === modal.id); if (!p) { modal = null; root.innerHTML = ''; return; }
  const s = scoreOf(p), src = await imgURL(p.id);
  if (!modal || modal.id !== p.id) return;
  const list = p.status === 'done' ? p.probs.map((q, i) => ({ q, i, v: verdict(p, i) })).filter(x => x.v !== 'right') : [];
  root.innerHTML = `<div class="modal" data-act="close"><div class="sheet" data-stop="1" role="dialog" aria-label="Paper">
    <div class="topbar"><div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:6px">${p.nameCrop ? `<img class="namecrop big" src="${p.nameCrop}" alt="Name as written">` : ''}<input type="text" id="pname" value="${esc(p.name || '')}" placeholder="Student name" aria-label="Student name"></div><button class="btn" data-act="close" type="button">Close</button></div>
    ${s ? `<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><span class="num" style="font-size:2rem;font-weight:700">${s.c}<span class="muted" style="font-size:1.1rem">/${s.t}</span></span><span class="pill ${band(s.p)}">${s.p}%</span>${s.u ? `<span class="chip ex">${s.u} to check</span>` : ''}${p.ms ? `<span class="small muted">graded on the phone in ${(p.ms / 1000).toFixed(1)} s</span>` : ''}</div><p class="small muted">Tap a mark to change it.</p>`
      : `<p class="muted">${p.status === 'error' ? esc(p.error) : 'Grading…'}</p>`}
    <div class="pagebox">${src ? `<img src="${src}" alt="Student page">` : '<div class="empty">Page photo not available</div>'}${s ? svgOverlay(p.w, p.h, p.probs, i => verdict(p, i), sizeFor(p.w, p.h, p.probs)) : ''}</div>
    ${list.length ? `<h3>Wrong or unclear</h3><div class="wronglist">${list.map(({ q, i, v }) => `<div class="wrow"><span><span class="eq">${esc(eqText(q))} = ${esc(String(q.exp))}</span><br><span class="small muted">${v === 'unsure' ? 'Not sure: looks like' : 'Wrote'} ${q.ans ? `<b>${esc(q.ans)}</b>` : 'nothing'} · #${esc(q.n)}${q.src === 'claude' ? ' · checked by Claude' : ''}</span></span>
      <span class="wbtns"><button class="btn sm" data-act="setv" data-i="${i}" data-v="right" type="button">Right</button>${v === 'unsure' ? `<button class="btn sm" data-act="setv" data-i="${i}" data-v="wrong" type="button">Wrong</button>` : ''}</span></div>`).join('')}</div>` : ''}
    <button class="btn danger" data-act="del" type="button">${confirmArm === 'del' ? 'Tap again to delete' : 'Delete paper'}</button>
  </div></div>`;
}

document.addEventListener('click', async e => {
  const t = e.target.closest('[data-act]'); if (!t) return;
  const act = t.dataset.act;
  if (act === 'close' && t.classList.contains('modal') && e.target.closest('[data-stop]')) return;
  if (act !== 'clear' && act !== 'del') confirmArm = null;
  const paper = modal?.id ? S.papers.find(x => x.id === modal.id) : null;
  switch (act) {
    case 'scankey': modal = null; renderModal(); startScan('key'); return;
    case 'keyphoto': initAudio(); pickFile('photos', 'key'); return;
    case 'grade': modal = null; renderModal(); startScan('grade'); return;
    case 'video': initAudio(); pickFile('video', 'grade'); return;
    case 'photos': initAudio(); pickFile('photos', 'grade'); return;
    case 'reviewkey': modal = { type: 'key' }; renderModal(); return;
    case 'settings': modal = { type: 'settings' }; renderModal(); return;
    case 'open': modal = { type: 'paper', id: t.dataset.id }; renderModal(); return;
    case 'close': modal = null; renderModal(); render(); return;
    case 'flip': { const i = +t.dataset.i, cur = verdict(paper, i); paper.ov = paper.ov || {}; paper.ov[i] = cur !== 'right'; save(); renderModal(); render(); return; }
    case 'setv': { paper.ov = paper.ov || {}; paper.ov[+t.dataset.i] = t.dataset.v === 'right'; save(); renderModal(); render(); return; }
    case 'del': if (confirmArm !== 'del') { confirmArm = 'del'; renderModal(); return; } S.papers = S.papers.filter(x => x !== paper); delImg(paper.id); scan.tracker?.forget(paper.id); modal = null; confirmArm = null; save(); renderModal(); break;
    case 'clear': if (confirmArm !== 'clear') { confirmArm = 'clear'; break; } S.papers.forEach(p => delImg(p.id)); S.papers = []; confirmArm = null; save(); break;
    case 'csv': await saveFile('times-grades.csv', csv(), 'text/csv'); return;
    case 'copy': try { await navigator.clipboard.writeText(tsv()); toast('Copied. Paste into Google Sheets or Excel.'); } catch (err) { toast('Copy is blocked here. Use Export CSV.'); } return;
    case 'rescan': { const p = S.papers.find(x => x.id === scan.attachedId); if (p) { S.papers = S.papers.filter(x => x !== p); delImg(p.id); scan.tracker.forget(p.id); scan.count = Math.max(0, scan.count - 1); $('#sCount').textContent = scan.count; scan.attachedId = null; updateCard(); } return; }
  }
  render();
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'sound') S.settings.sound = t.checked;
  else if (t.id === 'assist') S.settings.claudeAssist = t.checked;
  else if (t.id === 'apiKey') { S.settings.apiKey = t.value.trim(); claudeStatus().then(v => { claudeVia = v; render(); }); }
  else if (t.id === 'pname') { const p = S.papers.find(x => x.id === modal.id); p.name = t.value.trim(); p.nameEdited = true; render(); }
  else if (t.dataset.keyi !== undefined) {
    const k = S.key.probs[+t.dataset.keyi]; k.key = t.value.trim();
    // re-check papers against the corrected answer
    S.papers.forEach(p => { if (p.status === 'done' && p.probs[+t.dataset.keyi]) p.stale = true; });
    loadTemplate().then(() => renderModal());
  }
  save();
});

// ================= scanner =================
const scan = { active: false, mode: 'grade', stream: null, stop: null, tracker: null, count: 0, attachedId: null, lastId: null, audio: null, wake: null, source: 'camera', keyStatus: null };
const video = $('#cam'), overlay = $('#overlay');
const small = document.createElement('canvas'), sctx = small.getContext('2d', { willReadFrequently: true });
const big = document.createElement('canvas'), bctx = big.getContext('2d', { willReadFrequently: true });
function initAudio() { try { if (!scan.audio) scan.audio = new (window.AudioContext || window.webkitAudioContext)(); scan.audio.resume(); } catch (e) { /* */ } }
function beep(ok = true, n = 1) {
  if (S.settings.sound && scan.audio) {
    try {
      const c = scan.audio;
      for (let k = 0; k < n; k++) { const o = c.createOscillator(), g = c.createGain(), t0 = c.currentTime + k * 0.13; o.frequency.value = ok ? 1250 + k * 250 : 440; g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.22, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.11); o.connect(g).connect(c.destination); o.start(t0); o.stop(t0 + 0.12); }
    } catch (e) { /* */ }
  }
  try { navigator.vibrate && navigator.vibrate(n > 1 ? [25, 50, 25] : 30); } catch (e) { /* */ }
}
function hint(text, ok) { $('#sHintText').textContent = text; $('#sHint').classList.toggle('ok', !!ok); }
function openScanner(mode) {
  scan.active = true; scan.mode = mode; scan.count = 0; scan.attachedId = null; scan.lastId = null; scan.keyStatus = null;
  scan.tracker = new Paper.Tracker();
  $('#scanner').hidden = false; $('#sFallback').hidden = true; $('#sCard').hidden = true; $('#sProg').hidden = true; $('#sCount').textContent = '0';
  $('#sTitle').textContent = mode === 'key' ? 'Scan the answer key' : 'Grading papers';
  $('#sSub').textContent = mode === 'key' ? 'Hold the phone over your filled-in key' : (S.key?.title || 'Hold the phone over the top page');
  $('#sCountWrap').hidden = mode === 'key';
  document.documentElement.style.overflow = 'hidden';
  initAudio();
  try { navigator.wakeLock?.request('screen').then(w => scan.wake = w).catch(() => { }); } catch (e) { /* */ }
}
function closeScanner() {
  scan.active = false;
  if (scan.stop) scan.stop(); scan.stop = null;
  if (scan.stream) scan.stream.getTracks().forEach(t => t.stop()); scan.stream = null;
  video.pause(); video.srcObject = null; video.removeAttribute('src'); video.load();
  try { scan.wake?.release(); } catch (e) { /* */ }
  $('#scanner').hidden = true; document.documentElement.style.overflow = '';
  render();
}
$('#sDone').addEventListener('click', closeScanner);
$('#fbVideo').addEventListener('click', () => pickFile('video', scan.mode));
$('#fbPhotos').addEventListener('click', () => pickFile('photos', scan.mode));
async function startScan(mode) {
  if (mode === 'grade' && !S.key) { toast('Scan the answer key first.'); return; }
  openScanner(mode); scan.source = 'camera'; hint('Starting camera…');
  let stream;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('no camera');
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
  } catch (e) { $('#sFallback').hidden = false; return; }
  if (!scan.active) { stream.getTracks().forEach(t => t.stop()); return; }
  scan.stream = stream; video.srcObject = stream; video.muted = true;
  try { const [tr] = stream.getVideoTracks(); const caps = tr.getCapabilities?.(); if (caps?.focusMode?.includes('continuous')) tr.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => { }); } catch (e) { /* */ }
  await video.play().catch(() => { });
  scan.stop = loop(false);
}
function pickFile(kind, mode) {
  if (mode === 'grade' && !S.key) { toast('Scan the answer key first.'); return; }
  const input = kind === 'video' ? $('#vidIn') : $('#photoIn');
  input.multiple = kind === 'photos' && mode !== 'key';
  input.value = '';
  input.onchange = () => {
    const files = [...input.files]; if (!files.length) return;
    if (!scan.active) openScanner(mode);
    $('#sFallback').hidden = true;
    if (scan.stop) scan.stop(); scan.stop = null;
    if (scan.stream) { scan.stream.getTracks().forEach(t => t.stop()); scan.stream = null; video.srcObject = null; }
    if (kind === 'video') runVideo(files[0]); else runPhotos(files);
  };
  input.click();
}
async function runVideo(file) {
  scan.source = 'video'; scan.tracker = new Paper.Tracker({ stableFrames: 3 });
  const url = URL.createObjectURL(file);
  video.srcObject = null; video.src = url; video.muted = true;
  hint('Opening the video…'); $('#sProg').hidden = false;
  try {
    await new Promise((res, rej) => { video.onloadeddata = res; video.onerror = () => rej(new Error('This video can’t be played here. Try photos instead.')); });
    await video.play();
  } catch (e) { toast(e.message); $('#sFallback').hidden = false; return; }
  scan.stop = loop(true);
  video.onended = () => { if (scan.stop) scan.stop(); scan.stop = null; if (scan.mode === 'grade') hint(scan.count ? `Done: ${scan.count} page${scan.count > 1 ? 's' : ''} graded` : 'No pages found in this video', true); URL.revokeObjectURL(url); };
}
async function runPhotos(files) {
  scan.source = 'photos'; $('#sProg').hidden = false;
  let n = 0;
  for (let i = 0; i < files.length && scan.active; i++) {
    hint(`Reading photo ${i + 1} of ${files.length}`); $('#sProg i').style.width = (100 * (i + 1) / files.length) + '%';
    let bmp; try { bmp = await createImageBitmap(files[i]); } catch (e) { continue; }
    const k = Math.min(1, 2600 / Math.max(bmp.width, bmp.height)), fw = Math.round(bmp.width * k), fh = Math.round(bmp.height * k);
    big.width = fw; big.height = fh; bctx.drawImage(bmp, 0, 0, fw, fh);
    const f = makeFrame(big, fw, fh), pg = Paper.findPage(f.g, f.w, f.h);
    await capture(f, pg && !pg.clipped ? pg.quad : [[0, 0], [f.w, 0], [f.w, f.h], [0, f.h]], null);
    n++;
    if (scan.mode === 'key') return;
  }
  hint(n ? `Done: ${n} photo${n > 1 ? 's' : ''} graded` : 'No photos could be opened', true);
}
function makeFrame(src, vw, vh) {
  const k = 640 / Math.max(vw, vh), w = Math.round(vw * k), h = Math.round(vh * k);
  if (small.width !== w || small.height !== h) { small.width = w; small.height = h; }
  sctx.drawImage(src, 0, 0, w, h);
  const id = sctx.getImageData(0, 0, w, h);
  return { g: Paper.toGray(id.data, w, h), w, h, vw, vh,
    full: () => { if (src !== big) { if (big.width !== vw || big.height !== vh) { big.width = vw; big.height = vh; } bctx.drawImage(src, 0, 0, vw, vh); } return bctx.getImageData(0, 0, vw, vh); } };
}
async function capture(frame, quad, fp) {
  const img = frame.full(), k = frame.vw / frame.w, fq = quad.map(([x, y]) => [x * k, y * k]);
  beep(true);
  if (scan.mode === 'key') {
    if (scan.keyStatus === 'reading' || scan.keyStatus === 'template') return null;
    const id = 'keycap';
    if (fp) scan.tracker.attach(id, fp);
    scan.attachedId = id;
    const r = await engine.call({ type: 'flatten', id: 'k' + uid(), rgba: img.data, w: img.width, h: img.height, quad: fq }, [img.data.buffer]);
    const c = document.createElement('canvas'); c.width = r.width; c.height = r.height;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.data.buffer), r.width, r.height), 0, 0);
    const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.9));
    setupKey(blob, r.width, r.height);
    return null;
  }
  const paper = { id: uid(), at: Date.now(), name: '', status: 'grading', probs: [], ov: {} };
  S.papers.push(paper);
  if (fp) scan.tracker.attach(paper.id, fp);
  scan.attachedId = fp ? paper.id : null; scan.lastId = paper.id;
  scan.count++; $('#sCount').textContent = scan.count;
  updateCard(); render();
  try { await gradePage(paper, img.data, img.width, img.height, fq); beep(true, 2); }
  catch (e) { paper.status = 'error'; paper.error = e.message; save(); }
  updateCard(); render();
  return paper;
}
function loop(isFile) {
  let alive = true, lastT = -1, busy = false;
  const step = () => {
    if (!alive || !scan.active) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (video.readyState >= 2 && vw && (!isFile || video.currentTime !== lastT)) {
      lastT = video.currentTime;
      const frame = makeFrame(video, vw, vh);
      const st = scan.tracker.feed(frame);
      if (st.state === 'capture' && !busy) {
        busy = true;
        if (isFile) video.pause();
        capture(frame, st.rawQuad, st.fp).finally(() => { busy = false; if (isFile && alive && !video.ended && scan.active) video.play().catch(() => { }); });
        st.state = 'tracking'; st.id = scan.attachedId;
      } else if (st.state === 'capture') st.state = 'steady';
      scan.attachedId = st.state === 'tracking' ? st.id : (busy ? scan.attachedId : null);
      if (st.state === 'tracking') scan.lastId = st.id;
      draw(st, frame); hintFor(st); updateCard();
      if (isFile && video.duration) $('#sProg i').style.width = (100 * video.currentTime / video.duration) + '%';
    }
    schedule();
  };
  const schedule = () => { if (!alive) return; if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => step()); else requestAnimationFrame(() => step()); };
  schedule();
  return () => { alive = false; };
}
function hintFor(st) {
  if (scan.source === 'video' && video.ended) return;
  if (scan.mode === 'key') {
    if (scan.keyStatus === 'reading') return hint(`Claude is reading your key… ${Math.round((Date.now() - scan.keyStarted) / 1000)}s`);
    if (scan.keyStatus === 'template') return hint('Finding where students write…');
    if (scan.keyStatus === 'error') return hint('Couldn’t read the key. Hold steady to try again');
  } else {
    const p = st.id ? S.papers.find(x => x.id === st.id) : null;
    if (p) { const s = scoreOf(p); if (s) return hint(`${s.c} of ${s.t} right${s.u ? `, ${s.u} to check` : ''}. Next page`, true); if (p.status === 'error') return hint('Couldn’t grade this page'); return hint('Grading…'); }
  }
  hint({ search: 'Point at a worksheet', clipped: 'Back up so all four page corners show', steady: 'Hold still…' }[st.state] || 'Hold still…');
}
function draw(st, frame) {
  const r = overlay.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1), W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
  if (overlay.width !== W || overlay.height !== H) { overlay.width = W; overlay.height = H; }
  const ctx = overlay.getContext('2d'); ctx.clearRect(0, 0, W, H);
  if (!st.quad) return;
  const vw = frame.vw, vh = frame.vh, s = Math.max(W / vw, H / vh), ox = (W - vw * s) / 2, oy = (H - vh * s) / 2, k = vw / frame.w;
  const q = st.quad.map(([x, y]) => [ox + x * k * s, oy + y * k * s]);
  const p = scan.mode === 'grade' && st.id ? S.papers.find(x => x.id === st.id) : null;
  // corner brackets, like a check-deposit camera
  ctx.lineWidth = 4 * dpr; ctx.lineCap = 'round';
  ctx.strokeStyle = p?.status === 'done' ? '#4CC38A' : st.state === 'clipped' ? '#F2735F' : st.state === 'tracking' ? '#82A4FF' : '#F2B33D';
  q.forEach((pt, i) => {
    const a = q[(i + 3) % 4], b = q[(i + 1) % 4], L = 0.12;
    ctx.beginPath(); ctx.moveTo(pt[0] + (a[0] - pt[0]) * L, pt[1] + (a[1] - pt[1]) * L); ctx.lineTo(pt[0], pt[1]); ctx.lineTo(pt[0] + (b[0] - pt[0]) * L, pt[1] + (b[1] - pt[1]) * L); ctx.stroke();
  });
  ctx.lineWidth = 1.5 * dpr; ctx.globalAlpha = 0.5; ctx.beginPath(); q.forEach((pt, i) => i ? ctx.lineTo(pt[0], pt[1]) : ctx.moveTo(pt[0], pt[1])); ctx.closePath(); ctx.stroke(); ctx.globalAlpha = 1;
  const Hm = Paper.pageToQuad(q);
  if (p && p.status === 'done') drawMarks(ctx, p, Hm, Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]));
  else if (st.state === 'tracking' || (scan.mode === 'key' && scan.keyStatus === 'reading')) {
    const t = (Date.now() / 1200) % 1, y = 30 + t * 940, a = Paper.project(Hm, 0, y), b = Paper.project(Hm, 1000, y);
    ctx.strokeStyle = 'rgba(130,164,255,.95)'; ctx.lineWidth = 3 * dpr; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
  }
}
function drawMarks(ctx, paper, H, pageW) {
  const pts = paper.probs.map(p => Paper.project(H, p.x, p.y));
  let s = pageW * 0.04;
  if (pts.length > 1) { const d = pts.map((p, i) => Math.min(...pts.filter((_, j) => j !== i).map(q => Math.hypot(p[0] - q[0], p[1] - q[1])))).sort((a, b) => a - b); s = Math.max(pageW * 0.015, Math.min(pageW * 0.05, d[d.length >> 1] * 0.38)); }
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  paper.probs.forEach((p, i) => {
    const [x, y] = pts[i], v = verdict(paper, i);
    const path = () => { ctx.beginPath(); if (v === 'right') { ctx.moveTo(x - 0.45 * s, y); ctx.lineTo(x - 0.12 * s, y + 0.38 * s); ctx.lineTo(x + 0.55 * s, y - 0.5 * s); } else if (v === 'wrong') { ctx.moveTo(x - 0.4 * s, y - 0.4 * s); ctx.lineTo(x + 0.4 * s, y + 0.4 * s); ctx.moveTo(x + 0.4 * s, y - 0.4 * s); ctx.lineTo(x - 0.4 * s, y + 0.4 * s); } };
    if (v === 'unsure') {
      ctx.fillStyle = 'rgba(242,179,61,.9)'; ctx.beginPath(); ctx.arc(x, y, s * 0.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#2A2005'; ctx.font = `800 ${Math.round(s * 0.7)}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('?', x, y + 1); ctx.textAlign = 'start';
      return;
    }
    ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = s * 0.22 + 3; path(); ctx.stroke();
    ctx.strokeStyle = v === 'right' ? '#2FD082' : '#FF5A43'; ctx.lineWidth = s * 0.2; path(); ctx.stroke();
    if (v === 'wrong') {
      ctx.font = `800 ${Math.round(s * 0.62)}px ui-monospace, Menlo, monospace`; ctx.textBaseline = 'middle';
      const label = String(p.exp), tx = x + 0.6 * s, ty = y - 0.45 * s, tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(255,90,67,.95)'; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(tx - 4, ty - s * 0.38, tw + 8, s * 0.76, 5) : ctx.rect(tx - 4, ty - s * 0.38, tw + 8, s * 0.76); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillText(label, tx, ty + 1);
    }
  });
}
function updateCard() {
  const card = $('#sCard');
  if (scan.mode === 'key') {
    const st = scan.keyStatus; if (!st) { card.hidden = true; return; }
    card.hidden = false;
    const key = 'key|' + st;
    if (card.dataset.key === key) return; card.dataset.key = key;
    card.innerHTML = st === 'error' ? `<div><div class="nm">Answer key</div><div style="font-weight:700">${esc(scan.keyError)}</div></div><div></div>`
      : `<div><div class="nm">Answer key captured</div><div style="font-weight:700">${st === 'reading' ? 'Claude is reading the problems and answers' : st === 'template' ? 'Finding where students write' : 'Key ready'}</div></div><div class="grade mid">…</div><div class="acts"><span>This happens once per worksheet.</span></div>`;
    return;
  }
  const id = scan.attachedId || scan.lastId, p = id ? S.papers.find(x => x.id === id) : null;
  if (!p) { card.hidden = true; return; }
  card.hidden = false;
  const s = scoreOf(p), key = `${p.id}|${p.status}|${s ? s.c + '/' + s.u : ''}|${p.name}|${scan.attachedId === p.id}`;
  if (card.dataset.key === key) return; card.dataset.key = key;
  const where = scan.attachedId === p.id ? 'Page in view' : 'Last page';
  if (s) {
    card.innerHTML = `<div style="min-width:0"><div class="nm">${p.name ? esc(p.name) + ' · ' : ''}${where}</div><div class="big">${s.c}<small> / ${s.t} right</small></div></div><div class="grade ${band(s.p)}">${s.p}%</div><div class="bar"><i style="width:${s.p}%"></i></div>
      <div class="acts"><span>${s.t - s.c - s.u} wrong${s.u ? ` · ${s.u} to check` : ''}${p.ms ? ` · ${(p.ms / 1000).toFixed(1)} s` : ''}</span>${scan.attachedId === p.id ? '<button data-act="rescan" type="button">Retake</button>' : ''}</div>`;
  } else if (p.status === 'error') card.innerHTML = `<div><div class="nm">${where}</div><div style="font-weight:700">${esc(p.error)}</div></div><div></div>`;
  else card.innerHTML = `<div><div class="nm">${where}</div><div style="font-weight:700">Grading on the phone…</div></div><div class="grade mid">…</div>`;
}

// ================= start =================
render();
claudeStatus().then(v => { claudeVia = v; render(); });
if (S.key) loadTemplate().then(() => render()).catch(() => { });
})();
