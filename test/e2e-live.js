// Runs the built app in headless Chromium with a fake camera (test/out/stack.y4m):
// scans the key, then grades 3 students live. Claude is replaced by a stub that returns the fixture key.
// Usage: npm run build && node test/e2e-live.js
const path = require('path'), http = require('http'), fs = require('fs');
const { chromium } = require('playwright');
const OUT = path.join(__dirname, 'out'), F = require(path.join(OUT, 'fixtures.json'));
const DIST = path.join(__dirname, '..', 'dist');

const server = http.createServer((req, res) => {
  const file = path.join(DIST, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!file.startsWith(DIST) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/html' }); fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(0, r));
  const url = `http://localhost:${server.address().port}/index.html`;
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-video-capture=' + path.join(OUT, 'stack.y4m')] });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['camera'] })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  // stand-in for Claude: returns the fixture's key reading; background checks return nothing
  await page.addInitScript(key => {
    const sample = { limits: async () => ({ images: { maxCount: 5 } }), json: async prompt => { await new Promise(r => setTimeout(r, 1000)); return /answer key/.test(prompt) ? key : { name: '' }; } };
    window.claude = { use: async n => n === 'sample' ? sample : null };
  }, F.claudeKey);
  await page.goto(url);
  await page.click('[data-act=scankey]');
  await page.waitForFunction(() => /Found the answer spot/.test(document.querySelector('.sheet')?.textContent || ''), null, { timeout: 40000 });
  console.log((await page.textContent('.sheet p.small')).trim());
  await page.screenshot({ path: path.join(OUT, 'shot-key.png') });
  await page.click('.sheet [data-act=grade]');
  for (let i = 0; i < 70; i++) {
    await page.waitForTimeout(250);
    const h = await page.textContent('#sHintText');
    if (/right/.test(h) && !fs.existsSync(path.join(OUT, 'shot-live.png'))) await page.screenshot({ path: path.join(OUT, 'shot-live.png') });
  }
  await page.click('#sDone'); await page.waitForTimeout(500);
  const papers = await page.evaluate(() => JSON.parse(localStorage.getItem('timesgrader.v2')).papers.sort((a, b) => a.at - b.at).map(p => ({ ms: p.ms, v: p.probs.map(q => q.v) })));
  // the feed shows the key first (graded as a perfect paper), then the 3 students
  const truths = [F.key, ...F.videoStudents];
  papers.forEach((p, k) => {
    const t = truths[k % truths.length]; let ok = 0, un = 0, bad = 0;
    p.v.forEach((v, i) => { const right = t[i] === F.key[i]; if (v === 'unsure') un++; else if ((v === 'right') === right) ok++; else bad++; });
    console.log(`page ${k + 1}: ${ok} correct, ${un} flagged ?, ${bad} mistakes, graded in ${p.ms} ms`);
  });
  console.log(errors.length ? 'page errors: ' + errors.join(' | ') : 'no page errors');
  await browser.close(); server.close();
})();
