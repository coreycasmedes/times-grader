/* On-device answer reader: finds the handwritten digits inside one answer blank,
   reads each with a small neural network (runs in plain JavaScript, ~1 ms per digit),
   and checks the reading against the key answer. */
const Reader = (() => {
  let L = null; // layers
  function load(model) {
    const bin = typeof atob === 'function' ? Uint8Array.from(atob(model.b64), c => c.charCodeAt(0)) : new Uint8Array(Buffer.from(model.b64, 'base64'));
    const i8 = new Int8Array(bin.buffer, bin.byteOffset, bin.length);
    L = {};
    for (const m of model.layers) {
      const n = m.shape.reduce((a, b) => a * b, 1), w = new Float32Array(n);
      for (let i = 0; i < n; i++) w[i] = i8[m.off + i] * m.scale;
      L[m.name] = { w, b: Float32Array.from(m.bias), shape: m.shape };
    }
  }
  // HWC tensors as flat Float32Array
  function conv(x, H, W, C, layer) {
    const [kh, kw, , F] = layer.shape, oh = H - kh + 1, ow = W - kw + 1, out = new Float32Array(oh * ow * F), w = layer.w, b = layer.b;
    for (let y = 0; y < oh; y++) for (let xx = 0; xx < ow; xx++) {
      const o = (y * ow + xx) * F;
      for (let f = 0; f < F; f++) out[o + f] = b[f];
      for (let i = 0; i < kh; i++) for (let j = 0; j < kw; j++) {
        const xi = ((y + i) * W + xx + j) * C, wi = (i * kw + j) * C * F;
        for (let c = 0; c < C; c++) {
          const v = x[xi + c]; if (v === 0) continue;
          const wr = wi + c * F;
          for (let f = 0; f < F; f++) out[o + f] += v * w[wr + f];
        }
      }
      for (let f = 0; f < F; f++) if (out[o + f] < 0) out[o + f] = 0;
    }
    return [out, oh, ow, F];
  }
  function pool(x, H, W, C) {
    const oh = H >> 1, ow = W >> 1, out = new Float32Array(oh * ow * C);
    for (let y = 0; y < oh; y++) for (let xx = 0; xx < ow; xx++) for (let c = 0; c < C; c++) {
      const a = (2 * y * W + 2 * xx) * C + c;
      out[(y * ow + xx) * C + c] = Math.max(x[a], x[a + C], x[a + W * C], x[a + W * C + C]);
    }
    return [out, oh, ow, C];
  }
  function dense(x, layer, relu) {
    const [I, O] = layer.shape, out = Float32Array.from(layer.b), w = layer.w;
    for (let i = 0; i < I; i++) { const v = x[i]; if (v === 0) continue; const r = i * O; for (let o = 0; o < O; o++) out[o] += v * w[r + o]; }
    if (relu) for (let o = 0; o < O; o++) if (out[o] < 0) out[o] = 0;
    return out;
  }
  function logits(img28) {
    let t = [img28, 28, 28, 1];
    t = conv(t[0], t[1], t[2], t[3], L.c1); t = pool(...t);
    t = conv(t[0], t[1], t[2], t[3], L.c2); t = pool(...t);
    t = conv(t[0], t[1], t[2], t[3], L.c3);
    return dense(dense(t[0], L.f1, true), L.f2, false);
  }
  function probs(img28) {
    const z = logits(img28), m = Math.max(...z), e = z.map(v => Math.exp(v - m)), s = e.reduce((a, b) => a + b, 0);
    return Array.from(e, v => v / s);
  }

  // ---- MNIST-style normalisation (mirrors data.py) ----
  function resample(src, w, h, nw, nh) {
    const out = new Float32Array(nw * nh), sx = w / nw, sy = h / nh;
    for (let j = 0; j < nh; j++) for (let i = 0; i < nw; i++) {
      let acc = 0;
      for (let a = 0; a < 4; a++) {
        const y = Math.min(h - 1, Math.max(0, (j + (a + 0.5) / 4) * sy - 0.5)), y0 = y | 0, fy = y - y0, y1 = Math.min(h - 1, y0 + 1);
        for (let b = 0; b < 4; b++) {
          const x = Math.min(w - 1, Math.max(0, (i + (b + 0.5) / 4) * sx - 0.5)), x0 = x | 0, fx = x - x0, x1 = Math.min(w - 1, x0 + 1);
          acc += (src[y0 * w + x0] * (1 - fx) + src[y0 * w + x1] * fx) * (1 - fy) + (src[y1 * w + x0] * (1 - fx) + src[y1 * w + x1] * fx) * fy;
        }
      }
      out[j * nw + i] = acc / 16;
    }
    return out;
  }
  function normalize(ink, w, h) {
    let x0 = w, x1 = -1, y0 = h, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (ink[y * w + x] > 0.08) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const out = new Float32Array(784);
    if (x1 < 0) return out;
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1, crop = new Float32Array(cw * ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) crop[y * cw + x] = ink[(y + y0) * w + x + x0];
    const s = 20 / Math.max(cw, ch), nw = Math.max(1, Math.round(cw * s)), nh = Math.max(1, Math.round(ch * s));
    const sm = resample(crop, cw, ch, nw, nh);
    let tot = 0, mx = 0, my = 0;
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) { const v = sm[y * nw + x]; tot += v; mx += v * (x + 0.5); my += v * (y + 0.5); }
    if (tot <= 0) return out;
    const ox = Math.round(14 - mx / tot), oy = Math.round(14 - my / tot);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      const X = x + ox, Y = y + oy;
      if (X >= 0 && X < 28 && Y >= 0 && Y < 28) out[Y * 28 + X] = Math.min(1, Math.max(0, sm[y * nw + x]));
    }
    return out;
  }

  // ---- find digits inside an answer blank ----
  // gray: flattened page (Uint8 gray), box: [x0,y0,x1,y1] in page pixels for where the answer is written.
  function segment(gray, W, H, box, opts = {}) {
    const bw = box[2] - box[0], bh = box[3] - box[1];
    const px = Math.round(bw * 0.12), py = Math.round(bh * 0.15);
    const X0 = Math.max(0, Math.floor(box[0] - px)), Y0 = Math.max(0, Math.floor(box[1] - py)), X1 = Math.min(W, Math.ceil(box[2] + px)), Y1 = Math.min(H, Math.ceil(box[3] + py));
    const w = X1 - X0, h = Y1 - Y0;
    if (w < 6 || h < 6) return { atoms: [], natural: [] };
    const v = new Float32Array(w * h), hist = new Uint32Array(256);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const g = gray[(y + Y0) * W + x + X0]; v[y * w + x] = g; hist[g]++; }
    // paper = 80th percentile, ink = 1st percentile of this crop
    const N = w * h; let acc = 0, paper = 255, dark = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= N * 0.01 && dark === 0) dark = i || 1; if (acc >= N * 0.8) { paper = i; break; } }
    const range = Math.max(45, paper - dark);
    const ink = new Float32Array(N), bin = new Uint8Array(N);
    for (let i = 0; i < N; i++) { const t = Math.max(0, Math.min(1, (paper - v[i]) / range)); ink[i] = t; bin[i] = t > 0.35 ? 1 : 0; }
    // components (8-connected)
    const lab = new Int32Array(N), stack = new Int32Array(N), comps = [];
    let n = 0;
    for (let s = 0; s < N; s++) {
      if (!bin[s] || lab[s]) continue;
      n++; let sp = 0; stack[sp++] = s; lab[s] = n;
      const c = { id: n, x0: w, x1: 0, y0: h, y1: 0, area: 0, sx: 0, sy: 0 };
      while (sp) {
        const p = stack[--sp], x = p % w, y = (p / w) | 0;
        c.area++; c.sx += x; c.sy += y;
        if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const q = yy * w + xx;
          if (bin[q] && !lab[q]) { lab[q] = n; stack[sp++] = q; }
        }
      }
      comps.push(c);
    }
    const coreX0 = box[0] - X0, coreX1 = box[2] - X0, coreY0 = box[1] - Y0, coreY1 = box[3] - Y0;
    const minArea = Math.max(6, bh * bh * 0.004);
    let keep = comps.filter(c => {
      const cw = c.x1 - c.x0 + 1, ch = c.y1 - c.y0 + 1;
      if (c.area < minArea) return false;
      if (cw > 2.6 * ch && ch < bh * 0.22) return false;      // underline or rule
      if (cw > w * 0.8 || ch > h * 0.92) return false;         // box border
      // keep strokes that are mostly inside the answer area (the box is only roughly placed)
      const ix = Math.max(0, Math.min(c.x1, coreX1) - Math.max(c.x0, coreX0) + 1), iy = Math.max(0, Math.min(c.y1, coreY1) - Math.max(c.y0, coreY0) + 1);
      if (ix * iy < 0.4 * cw * ch) return false;
      // outside the teacher's answer spot, drop strokes that are also on the key page (printed text, the = sign)
      if (opts.print && opts.core) {
        const cx = X0 + (c.x0 + c.x1) / 2, cy = Y0 + (c.y0 + c.y1) / 2, k = opts.core;
        const inCore = cx >= k[0] && cx <= k[2] && cy >= k[1] && cy <= k[3];
        if (!inCore) {
          let on = 0, tot = 0;
          for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) if (lab[y * w + x] === c.id) { tot++; if (opts.print[(y + Y0) * W + x + X0]) on++; }
          if (on > 0.7 * tot) return false;
        }
      }
      if (ch < bh * 0.18 && cw < bh * 0.18) return false;      // speck
      return true;
    });
    // group pieces that overlap horizontally (a 5's flag, a 4's two strokes)
    keep.sort((a, b) => a.x0 - b.x0);
    const groups = [];
    for (const c of keep) {
      const g = groups[groups.length - 1];
      if (g) {
        const ov = Math.min(g.x1, c.x1) - Math.max(g.x0, c.x0), nar = Math.min(g.x1 - g.x0, c.x1 - c.x0) + 1;
        if (ov > 0.45 * nar) { g.ids.push(c.id); g.x0 = Math.min(g.x0, c.x0); g.x1 = Math.max(g.x1, c.x1); g.y0 = Math.min(g.y0, c.y0); g.y1 = Math.max(g.y1, c.y1); continue; }
      }
      groups.push({ ids: [c.id], x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1 });
    }
    if (!groups.length) return { atoms: [], natural: [] };
    const hMed = groups.map(g => g.y1 - g.y0 + 1).sort((a, b) => a - b)[groups.length >> 1];
    // cut wide groups at their thinnest columns; check() can glue the atoms back together
    const atoms = [], natural = [];
    for (const g of groups) {
      const gw = g.x1 - g.x0 + 1, gh = Math.max(g.y1 - g.y0 + 1, hMed);
      const first = atoms.length, cuts = [];
      if (gw > 0.62 * gh) {
        const prof = new Float32Array(gw);
        for (let y = g.y0; y <= g.y1; y++) for (let x = g.x0; x <= g.x1; x++) if (g.ids.includes(lab[y * w + x])) prof[x - g.x0] += ink[y * w + x];
        const minW = Math.max(2, Math.round(gh * 0.22)), cand = [];
        for (let x = minW; x < gw - minW; x++) {
          let isMin = true;
          for (let d = -2; d <= 2; d++) if (d && prof[x + d] < prof[x]) { isMin = false; break; }
          if (isMin) cand.push(x);
        }
        cand.sort((a, b) => prof[a] - prof[b]);
        const maxCuts = Math.min(3, Math.max(1, Math.round(gw / (0.45 * gh)) - 1));
        for (const x of cand) { if (cuts.length >= maxCuts) break; if (cuts.every(c => Math.abs(c - x) >= minW)) cuts.push(x); }
        cuts.sort((a, b) => a - b);
      }
      const edges = [g.x0, ...cuts.map(c => g.x0 + c), g.x1 + 1];
      for (let i = 0; i < edges.length - 1; i++) atoms.push({ ids: g.ids, x0: edges[i], x1: edges[i + 1], y0: g.y0, y1: g.y1 });
      natural.push([first, atoms.length]);
    }
    const cache = {};
    const piece = (i, j) => {
      const k = i + ',' + j; if (cache[k]) return cache[k];
      const ax = atoms[i].x0, bx = atoms[j - 1].x1, ids = new Set(); let y0 = h, y1 = 0;
      for (let t = i; t < j; t++) { atoms[t].ids.forEach(d => ids.add(d)); y0 = Math.min(y0, atoms[t].y0); y1 = Math.max(y1, atoms[t].y1); }
      const dw = bx - ax, dh = y1 - y0 + 1, m = new Float32Array(dw * dh);
      for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) { const p = (y + y0) * w + x + ax; if (ids.has(lab[p])) m[y * dw + x] = ink[p]; }
      return (cache[k] = { p: probs(normalize(m, dw, dh)), w: dw, h: dh, x: X0 + ax, y: Y0 + y0 });
    };
    return { atoms, natural, piece, hMed, X0, Y0 };
  }

  // ---- read and check one answer ----
  const argmaxDigit = p => { let b = 0; for (let d = 1; d < 10; d++) if (p[d] > p[b]) b = d; return b; };
  function check(gray, W, H, box, expected, opts = {}) {
    const S = segment(gray, W, H, box, opts);
    const exp = String(expected ?? '').replace(/\D/g, '');
    if (!S.atoms.length) return { verdict: 'wrong', read: '', conf: 0.95, blank: true };
    const m = S.atoms.length, okSpan = (i, j) => j - i <= 3 && (S.atoms[j - 1].x1 - S.atoms[i].x0) <= 1.6 * S.hMed;
    // natural reading: what the student most likely wrote
    const nat = S.natural.map(([i, j]) => S.piece(i, j).p).filter(p => !(p[10] > 0.5));
    const read = nat.map(argmaxDigit).join('');
    // best way to read the strokes as exactly the key's digits, in order (atoms may be glued together)
    let best = null;
    if (exp.length && exp.length <= m) {
      const n = exp.length, dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(null));
      dp[0][0] = { score: 0, min: 1 };
      if (opts.substring) for (let i = 1; i <= m; i++) dp[0][i] = { score: 0, min: 1 };
      for (let k = 1; k <= n; k++) for (let j = k; j <= m; j++) for (let i = k - 1; i < j; i++) {
        const prev = dp[k - 1][i]; if (!prev || !okSpan(i, j)) continue;
        const p = S.piece(i, j).p[+exp[k - 1]], sc = prev.score + Math.log(Math.max(p, 1e-9));
        if (!dp[k][j] || sc > dp[k][j].score) dp[k][j] = { score: sc, min: Math.min(prev.min, p), from: k === 1 ? i : prev.from };
      }
      best = dp[n][m];
      if (opts.substring) for (let j = n; j <= m; j++) if (dp[n][j] && (!best || dp[n][j].score > best.score)) { best = dp[n][j]; best.to = j; }
    }
    if (best && best.min >= 0.5) {
      const to = best.to ?? m, used = S.atoms.slice(best.from, to), a = used[0], b = used[used.length - 1];
      const bbox = [S.X0 + a.x0, S.Y0 + Math.min(...used.map(t => t.y0)), S.X0 + b.x1, S.Y0 + Math.max(...used.map(t => t.y1))];
      return { verdict: 'right', read: exp, conf: best.min, bbox };
    }
    if (!nat.length) return { verdict: 'wrong', read: '', conf: 0.9, blank: true };
    if (read === exp) return { verdict: best && best.min >= 0.2 ? 'right' : 'unsure', read, conf: best ? best.min : 0.3 };
    if (best && best.min >= 0.12) return { verdict: 'unsure', read, conf: best.min };
    // a shaky reading is never marked wrong outright; the teacher gets a "?" instead
    const natConf = Math.min(...nat.map(p => p[argmaxDigit(p)]));
    if (natConf < 0.75) return { verdict: 'unsure', read, conf: natConf };
    return { verdict: 'wrong', read, conf: 1 - (best ? best.min : 0) };
  }
  // ---- answer key template ----
  // problems: [{box:[x0,y0,x1,y1] rough (page px), answer:"56"}]. Finds the teacher's written answer
  // near each rough box, then defines where students will write and which ink is printed.
  function buildTemplate(gray, W, H, problems) {
    const ink = new Uint8Array(W * H);
    // printed-ink mask: dark pixels of the key page, dilated a little to absorb alignment error
    const R = 5, dark = new Uint8Array(W * H), W1 = W + 1, ii = new Float64Array(W1 * (H + 1)), B = 14;
    for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += gray[y * W + x]; ii[(y + 1) * W1 + x + 1] = ii[y * W1 + x + 1] + row; } }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const ax = Math.max(0, x - B), bx = Math.min(W, x + B + 1), ay = Math.max(0, y - B), by = Math.min(H, y + B + 1);
      const mean = (ii[by * W1 + bx] - ii[ay * W1 + bx] - ii[by * W1 + ax] + ii[ay * W1 + ax]) / ((bx - ax) * (by - ay));
      dark[y * W + x] = gray[y * W + x] < mean * 0.85 ? 1 : 0;
    }
    const rowPass = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) { let run = -1e9; for (let x = 0; x < W; x++) { if (dark[y * W + x]) run = x; if (x - run <= R) rowPass[y * W + x] = 1; } run = 1e9; for (let x = W - 1; x >= 0; x--) { if (dark[y * W + x]) run = x; if (run - x <= R) rowPass[y * W + x] = 1; } }
    for (let x = 0; x < W; x++) { let run = -1e9; for (let y = 0; y < H; y++) { if (rowPass[y * W + x]) run = y; if (y - run <= R) ink[y * W + x] = 1; } run = 1e9; for (let y = H - 1; y >= 0; y--) { if (rowPass[y * W + x]) run = y; if (run - y <= R) ink[y * W + x] = 1; } }
    let found = 0;
    const items = problems.map(p => {
      const [x0, y0, x1, y1] = p.box, bw = x1 - x0, bh = y1 - y0;
      // look near the rough box first, then further out
      let r = null;
      for (const [mx, my] of [[0.5, 0.5], [1.0, 0.8]]) {
        if (!p.answer) break;
        r = check(gray, W, H, [x0 - bw * mx, y0 - bh * my, x1 + bw * mx, y1 + bh * my], p.answer, { substring: true });
        if (r.verdict === 'right' && r.bbox) {
          // only trust a match that sits near the rough box and is digit-sized
          const cx = (r.bbox[0] + r.bbox[2]) / 2, cy = (r.bbox[1] + r.bbox[3]) / 2, bhh = r.bbox[3] - r.bbox[1];
          if (cx > x0 - bw * 0.5 && cx < x1 + bw * 0.5 && cy > y0 - bh * 0.5 && cy < y1 + bh * 0.5 && bhh > bh * 0.3) break;
        }
        r = null;
      }
      let core = r && r.bbox ? r.bbox : null;
      if (core) found++; else core = [x0 + bw * 0.15, y0 + bh * 0.15, x1 - bw * 0.15, y1 - bh * 0.15];
      const cw = core[2] - core[0], ch = core[3] - core[1], dh = Math.max(ch, bh * 0.5);
      // students write around where the teacher did; allow a generous margin
      const zone = [core[0] - Math.max(cw * 0.6, dh * 0.9), core[1] - dh * 0.5, core[2] + Math.max(cw * 0.6, dh * 0.9), core[3] + dh * 0.5];
      return { zone, core, anchored: !!(r && r.verdict === 'right') };
    });
    // the teacher's own handwriting is not print: clear it from the mask so students' answers written in the same spot survive
    for (const it of items) {
      if (!it.anchored) continue;
      const [a, b, c, d] = it.core, px = 3, py = 3;
      for (let y = Math.max(0, Math.floor(b - py)); y < Math.min(H, Math.ceil(d + py)); y++)
        for (let x = Math.max(0, Math.floor(a - px)); x < Math.min(W, Math.ceil(c + px)); x++) ink[y * W + x] = 0;
    }
    return { items, print: ink, W, H, found };
  }
  function gradeItem(gray, W, H, tpl, i, expected) {
    const it = tpl.items[i];
    const r = check(gray, W, H, it.zone, expected, { print: tpl.print, core: it.core });
    // without a confirmed answer spot, never mark wrong on the phone's say-so alone
    if (!it.anchored && r.verdict === 'wrong') r.verdict = 'unsure';
    return r;
  }
  return { load, probs, normalize, segment, check, logits, buildTemplate, gradeItem };
})();
if (typeof module !== 'undefined') module.exports = Reader;
