// Grades the synthetic student photos against the key, the same way the app does.
// Usage: node test/reader-accuracy.js [boxJitter]   (jitter in 1/1000 of the page, simulates rough answer boxes)
const path = require('path');
const P = require('../src/paper.js'), R = require('../src/reader.js');
R.load(require('../model/model.json'));
const sharp = require('sharp');
const OUT = path.join(__dirname, 'out'), F = require(path.join(OUT, 'fixtures.json'));
const jitter = +process.argv[2] || 0; let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
async function flatten(file, ow = 0, oh = 0) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const s = 640 / Math.max(info.width, info.height), sw = Math.round(info.width * s), sh = Math.round(info.height * s);
  const small = await sharp(file).resize(sw, sh).ensureAlpha().raw().toBuffer();
  const pg = P.findPage(P.toGray(small, sw, sh), sw, sh);
  if (!pg) throw new Error('page not found in ' + file);
  const f = P.rectify(data, info.width, info.height, pg.quad.map(([x, y]) => [x / s, y / s]), 1600, ow, oh);
  return { g: P.toGray(f.data, f.width, f.height), W: f.width, H: f.height };
}
(async () => {
  const key = await flatten(path.join(OUT, 'key.png'));
  const j = () => (rnd() - 0.5) * 2 * jitter;
  const tpl = R.buildTemplate(key.g, key.W, key.H, F.boxes.map((b, i) => ({ box: [(b[0] + j()) * key.W / 1000, (b[1] + j()) * key.H / 1000, (b[2] + j()) * key.W / 1000, (b[3] + j()) * key.H / 1000], answer: F.key[i] })));
  console.log(`key: found ${tpl.found}/${F.key.length} answer spots`);
  let tot = 0, ok = 0, unsure = 0, ms = 0; const bad = [];
  for (const s of F.students) {
    const st = await flatten(path.join(OUT, s.file), key.W, key.H), t0 = performance.now();
    F.key.forEach((exp, i) => {
      const r = R.gradeItem(st.g, st.W, st.H, tpl, i, exp), truth = s.ans[i] === exp; tot++;
      if (r.verdict === 'unsure') unsure++; else if ((r.verdict === 'right') === truth) ok++; else bad.push(`${s.file} #${i + 1}: key ${exp}, wrote "${s.ans[i]}", read "${r.read}" -> ${r.verdict}`);
    });
    ms += performance.now() - t0;
  }
  console.log(`decided correctly ${ok}/${tot - unsure} (${(100 * ok / (tot - unsure)).toFixed(1)}%), flagged ? ${unsure}/${tot}, mistakes ${bad.length}, ${(ms / F.students.length).toFixed(0)} ms/page`);
  bad.forEach(b => console.log('  ' + b));
})();
