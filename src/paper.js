/* Times Grader page engine: find the worksheet in a camera frame, track it,
   decide when a new page is ready, flatten it, and map marks back onto the live view.
   Pure functions on grayscale arrays so it runs in the browser and in Node. */
const Paper = (() => {
  // ---------- math ----------
  function solve(A, b) {
    const n = b.length, M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-12) return null;
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    return M.map((r, i) => r[n] / r[i]);
  }
  function homography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const h = solve(A, b);
    return h ? [...h, 1] : null;
  }
  const project = (H, x, y) => { const w = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w]; };
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  function toGray(rgba, w, h) {
    const g = new Uint8ClampedArray(w * h);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    return g;
  }
  function polyArea(p) { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; } return Math.abs(a) / 2; }
  function hull(pts) {
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    up.pop(); lo.pop();
    return lo.concat(up);
  }
  // reduce a convex polygon to 4 corners by repeatedly dropping the vertex that adds the least area
  function toQuad(poly) {
    const p = poly.slice();
    while (p.length > 4) {
      let bi = 0, ba = Infinity;
      for (let i = 0; i < p.length; i++) {
        const a = p[(i - 1 + p.length) % p.length], b = p[i], c = p[(i + 1) % p.length];
        const ar = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
        if (ar < ba) { ba = ar; bi = i; }
      }
      p.splice(bi, 1);
    }
    return p.length === 4 ? p : null;
  }
  function orderQuad(q) {
    const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
    const s = q.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
    let k = 0; s.forEach((p, i) => { if (p[0] + p[1] < s[k][0] + s[k][1]) k = i; });
    return [0, 1, 2, 3].map(i => s[(i + k) % 4]); // TL TR BR BL
  }

  // fit a line to the boundary points along each side, then intersect neighbouring sides
  function refineQuad(q, bpts, w, h) {
    const size = Math.sqrt(polyArea(q)), lines = [];
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], L = dist(a, b), ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
      let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, n = 0;
      for (const p of bpts) {
        const dx = p[0] - a[0], dy = p[1] - a[1], t = dx * ux + dy * uy, d = Math.abs(-dx * uy + dy * ux);
        if (t < L * 0.08 || t > L * 0.92 || d > size * 0.025) continue;
        if (p[0] < 1 || p[1] < 1 || p[0] > w - 1 || p[1] > h - 1) continue; // frame border is not a paper edge
        sx += p[0]; sy += p[1]; sxx += p[0] * p[0]; syy += p[1] * p[1]; sxy += p[0] * p[1]; n++;
      }
      if (n < 8) { lines.push({ px: a[0], py: a[1], dx: ux, dy: uy }); continue; }
      const mx = sx / n, my = sy / n, cxx = sxx / n - mx * mx, cyy = syy / n - my * my, cxy = sxy / n - mx * my;
      const th = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
      lines.push({ px: mx, py: my, dx: Math.cos(th), dy: Math.sin(th) });
    }
    const out = [];
    for (let i = 0; i < 4; i++) {
      const l1 = lines[(i + 3) % 4], l2 = lines[i];
      const den = l1.dx * l2.dy - l1.dy * l2.dx;
      if (Math.abs(den) < 1e-6) return q;
      const t = ((l2.px - l1.px) * l2.dy - (l2.py - l1.py) * l2.dx) / den;
      const p = [l1.px + t * l1.dx, l1.py + t * l1.dy];
      if (dist(p, q[i]) > size * 0.1) return q; // refinement went wild; keep the rough corners
      out.push(p);
    }
    return out;
  }

  // ---------- page finder ----------
  // Finds the brightest large region (the paper) and fits a quadrilateral to it.
  function findPage(g, w, h) {
    const N = w * h, hist = new Float64Array(256);
    for (let i = 0; i < N; i++) hist[g[i]]++;
    // Otsu
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sB = 0, wB = 0, best = 0, t = 128;
    for (let i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue; const wF = N - wB; if (!wF) break;
      sB += i * hist[i]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2;
      if (v > best) { best = v; t = i; }
    }
    let brightFrac = 0; for (let i = t + 1; i < 256; i++) brightFrac += hist[i]; brightFrac /= N;
    const mask = new Uint8Array(N);
    for (let i = 0; i < N; i++) mask[i] = g[i] > t ? 1 : 0;
    // largest component (4-connected)
    const seen = new Uint8Array(N), stack = new Int32Array(N);
    let bestCnt = 0, bestSeed = -1;
    for (let s = 0; s < N; s++) {
      if (!mask[s] || seen[s]) continue;
      let sp = 0, cnt = 0; stack[sp++] = s; seen[s] = 1;
      while (sp) {
        const p = stack[--sp]; cnt++;
        const x = p % w;
        if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
        if (p >= w && mask[p - w] && !seen[p - w]) { seen[p - w] = 1; stack[sp++] = p - w; }
        if (p < N - w && mask[p + w] && !seen[p + w]) { seen[p + w] = 1; stack[sp++] = p + w; }
      }
      if (cnt > bestCnt) { bestCnt = cnt; bestSeed = s; }
    }
    if (bestCnt < N * 0.12) return null;
    // collect the component's boundary pixels
    const lab = new Uint8Array(N); let sp = 0; stack[sp++] = bestSeed; lab[bestSeed] = 1;
    const bpts = [];
    while (sp) {
      const p = stack[--sp], x = p % w, y = (p / w) | 0;
      let border = false;
      if (x > 0) { if (mask[p - 1]) { if (!lab[p - 1]) { lab[p - 1] = 1; stack[sp++] = p - 1; } } else border = true; } else border = true;
      if (x < w - 1) { if (mask[p + 1]) { if (!lab[p + 1]) { lab[p + 1] = 1; stack[sp++] = p + 1; } } else border = true; } else border = true;
      if (p >= w) { if (mask[p - w]) { if (!lab[p - w]) { lab[p - w] = 1; stack[sp++] = p - w; } } else border = true; } else border = true;
      if (p < N - w) { if (mask[p + w]) { if (!lab[p + w]) { lab[p + w] = 1; stack[sp++] = p + w; } } else border = true; } else border = true;
      if (border) bpts.push([x + 0.5, y + 0.5]);
    }
    const hp = hull(bpts.slice());
    let q4 = toQuad(hp);
    if (!q4) return null;
    q4 = refineQuad(orderQuad(q4), bpts, w, h);
    if (!q4) return null;
    const quad = q4;
    const area = polyArea(quad);
    // the fitted quad should explain the blob (a paper is a convex 4-sided shape)
    if (bestCnt / area < 0.82) return null;
    const sides = [0, 1, 2, 3].map(i => dist(quad[i], quad[(i + 1) % 4]));
    if (Math.min(...sides) < Math.min(w, h) * 0.15) return null;
    const m = 2;
    const clipped = quad.some(([x, y]) => x <= m || y <= m || x >= w - m || y >= h - m);
    return { quad, area, clipped, size: Math.sqrt(area), brightFrac };
  }

  // ---------- flatten ----------
  function pageSize(quad) {
    const wpx = (dist(quad[0], quad[1]) + dist(quad[3], quad[2])) / 2, hpx = (dist(quad[0], quad[3]) + dist(quad[1], quad[2])) / 2;
    return { wpx, hpx, aspect: wpx / hpx };
  }
  // rgba: full-res pixels; quad in full-res px. Returns {data,width,height} RGBA.
  // outW/outH force the output size (student pages are flattened to the key page's size so positions line up)
  function rectify(rgba, w, h, quad, outLong = 1400, outW = 0, outH = 0) {
    const { aspect } = pageSize(quad);
    const W = outW || (aspect >= 1 ? outLong : Math.round(outLong * aspect)), Hh = outH || (aspect >= 1 ? Math.round(outLong / aspect) : outLong);
    const H = homography([[0, 0], [W, 0], [W, Hh], [0, Hh]], quad);
    const out = new Uint8ClampedArray(W * Hh * 4);
    for (let j = 0; j < Hh; j++) {
      for (let i = 0; i < W; i++) {
        const [x, y] = project(H, i + 0.5, j + 0.5), o = (j * W + i) * 4;
        if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) { out[o] = out[o + 1] = out[o + 2] = 255; out[o + 3] = 255; continue; }
        const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, p = (y0 * w + x0) * 4, p2 = p + w * 4;
        for (let c = 0; c < 3; c++) out[o + c] = (rgba[p + c] * (1 - fx) + rgba[p + 4 + c] * fx) * (1 - fy) + (rgba[p2 + c] * (1 - fx) + rgba[p2 + 4 + c] * fx) * fy;
        out[o + 3] = 255;
      }
    }
    return { data: out, width: W, height: Hh };
  }

  // ---------- page fingerprint (to tell a new sheet from the same sheet) ----------
  // Different students' copies of one worksheet share all the print, so the comparison
  // looks for ink that differs after a small local alignment, block by block.
  const GW = 200, GH = 260, BLK = 32, DT = 0.25;
  function fingerprint(g, w, h, quad) {
    const H = homography([[0, 0], [GW, 0], [GW, GH], [0, GH]], quad), v = new Float32Array(GW * GH);
    for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
      const [x, y] = project(H, i + 0.5, j + 0.5);
      const x0 = Math.max(0, Math.min(w - 2, x | 0)), y0 = Math.max(0, Math.min(h - 2, y | 0)), fx = Math.min(1, Math.max(0, x - x0)), fy = Math.min(1, Math.max(0, y - y0));
      v[j * GW + i] = (g[y0 * w + x0] * (1 - fx) + g[y0 * w + x0 + 1] * fx) * (1 - fy) + (g[(y0 + 1) * w + x0] * (1 - fx) + g[(y0 + 1) * w + x0 + 1] * fx) * fy;
    }
    const o = new Float32Array(GW * GH), R = 6;
    for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
      let m = 1;
      for (let y = Math.max(0, j - R); y <= Math.min(GH - 1, j + R); y += 3) for (let x = Math.max(0, i - R); x <= Math.min(GW - 1, i + R); x += 3) m = Math.max(m, v[y * GW + x]);
      o[j * GW + i] = 1 - Math.min(1, v[j * GW + i] / m); // ink darkness 0..1
    }
    return o;
  }
  // count of fingerprint cells whose ink differs after local alignment (0 = identical page).
  // An absolute count works better than a share of all ink: two copies of one worksheet
  // share most of their ink, and only the handwriting differs.
  function difference(a, b) {
    let bad = 0, ink = 0;
    for (let by = 6; by < GH - 6; by += BLK) for (let bx = 6; bx < GW - 6; bx += BLK) {
      let bestBad = Infinity, bestInk = 0;
      const ye = Math.min(GH - 6, by + BLK), xe = Math.min(GW - 6, bx + BLK);
      for (let sy = -3; sy <= 3; sy++) for (let sx = -3; sx <= 3; sx++) {
        let bb = 0, ii = 0;
        for (let j = by; j < ye; j++) for (let i = bx; i < xe; i++) {
          const da = a[j * GW + i], db = b[(j + sy) * GW + i + sx];
          if (da > DT || db > DT) ii++;
          if (Math.abs(da - db) > DT) bb++;
        }
        if (bb < bestBad) { bestBad = bb; bestInk = ii; }
      }
      bad += bestBad; ink += bestInk;
    }
    return bad;
  }

  // ---------- tracker ----------
  // feed() each frame. Emits onCapture({quad, frame}) when a new still page appears,
  // and keeps a smoothed quad for drawing marks on the page that is in view.
  class Tracker {
    constructor(opts = {}) {
      this.need = opts.stableFrames ?? 4; this.sameThresh = opts.sameThresh ?? 80;
      this.prevThumb = null; this.prevQuad = null; this.smooth = null; this.stable = 0; this.lost = 0;
      this.attached = null; // paper id in view
      this.recent = [];     // [{id, fp}]
    }
    thumb(g, w, h) {
      const TW = 48, TH = 48, t = new Float32Array(TW * TH);
      for (let j = 0; j < TH; j++) for (let i = 0; i < TW; i++) t[j * TW + i] = g[Math.floor((j + 0.5) * h / TH) * w + Math.floor((i + 0.5) * w / TW)] / 255;
      return t;
    }
    remember(id, fp) { this.recent.unshift({ id, fp }); this.recent.length = Math.min(this.recent.length, 6); }
    forget(id) { this.recent = this.recent.filter(r => r.id !== id); if (this.attached === id) this.attached = null; }
    feed(frame) {
      const { g, w, h } = frame;
      const t = this.thumb(g, w, h);
      let motion = 0;
      if (this.prevThumb) { for (let i = 0; i < t.length; i++) motion += Math.abs(t[i] - this.prevThumb[i]); motion /= t.length; }
      this.prevThumb = t;
      const pg = findPage(g, w, h);
      if (!pg) {
        this.lost++; this.stable = 0; this.prevQuad = null;
        if (this.lost >= 3) { this.attached = null; this.smooth = null; }
        return { state: 'search', motion };
      }
      this.lost = 0;
      const move = this.prevQuad ? Math.max(...pg.quad.map((p, i) => dist(p, this.prevQuad[i]))) / pg.size : 1;
      this.prevQuad = pg.quad;
      if (motion > 0.07 || move > 0.15) { this.attached = null; this.smooth = null; } // page flipped or swapped
      // smoothing for drawing
      if (!this.smooth || move > 0.05) this.smooth = pg.quad.map(p => p.slice());
      else this.smooth = this.smooth.map((p, i) => [p[0] * 0.5 + pg.quad[i][0] * 0.5, p[1] * 0.5 + pg.quad[i][1] * 0.5]);
      this.stable = move < 0.012 && motion < 0.02 ? this.stable + 1 : 0;
      const base = { quad: this.smooth, clipped: pg.clipped, motion };
      if (this.attached) return { ...base, state: 'tracking', id: this.attached };
      if (pg.clipped) return { ...base, state: 'clipped' };
      if (this.stable < this.need) return { ...base, state: 'steady' };
      const fp = fingerprint(g, w, h, pg.quad);
      let bestD = Infinity, bestId = null;
      for (const r of this.recent) { const d = difference(fp, r.fp); if (d < bestD) { bestD = d; bestId = r.id; } }
      if (bestD <= this.sameThresh) { this.attached = bestId; return { ...base, state: 'tracking', id: bestId, reattached: true, diff: bestD }; }
      return { ...base, state: 'capture', fp, rawQuad: pg.quad, diff: bestD };
    }
    attach(id, fp) { this.attached = id; this.remember(id, fp); }
  }

  // marks are stored in 0..1000 page coordinates; this maps them to any target quad
  function pageToQuad(quad) { return homography([[0, 0], [1000, 0], [1000, 1000], [0, 1000]], quad); }

  return { toGray, homography, project, findPage, rectify, fingerprint, difference, Tracker, pageToQuad, pageSize };
})();
if (typeof module !== 'undefined') module.exports = Paper;
