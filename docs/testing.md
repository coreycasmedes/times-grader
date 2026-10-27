# Testing

All tests use synthetic data. The numbers below say nothing yet about real classrooms.

## Fixtures — `npm run fixtures`
`test/synth/make_fixtures.py` writes the following to `test/out/`:
- `key.png` and `student_0..7.png`: phone-style photos of a 30-problem worksheet. Answers are handwritten with MNIST digits the model never saw. Each photo has tilt, perspective, blur, uneven light, some touching digits, and about 16% wrong and 4% blank answers.
- `stack.y4m`: a 15 fps, 720p fake camera feed showing the key, then 3 students, with a hand flipping the pages.
- `fixtures.json`: the truth, plus a stand-in for Claude's key reading with boxes jittered by up to 1.2%.

Requires Python 3, numpy, pillow, ffmpeg, the DejaVu fonts, and `npm install` (for the MNIST digits).

## Reader accuracy — `npm run test:reader`
Grades the 8 student photos against the key in Node, using the same code as the app.

```
exact boxes:        decided correctly 231/235 (98.3%), flagged ? 5/240, 4 mistakes, ~450 ms/page
boxes off by ±1.5%: decided correctly 223/226 (98.7%), flagged ? 14/240, 3 mistakes
boxes off by ±2.5%: ~98.6% decided correctly, ~12% flagged ?
```

*Decided* means marked right or wrong, not ?. Rougher boxes from Claude produce more ? marks, not more mistakes.

## Browser end-to-end — `npm run test:e2e`
Runs `dist/index.html` in headless Chromium with the fake camera. Claude is replaced by a stub that returns the fixture key.

Last run:
- Key: 24 of 30 answer spots found.
- 4 pages auto-captured: the key page plus 3 students.
- 107 of 120 answers decided correctly, 12 flagged ?, 1 mistake.
- 0.5–0.6 s per page, graded in the Worker.

Screenshots are saved to `test/out/shot-*.png`.

## Next: real worksheets
1. Collect 10–20 real filled worksheets plus the key, photographed with the app's **Use photos** button.
2. Record the true answers in a JSON file shaped like `fixtures.json`.
3. Point `test/reader-accuracy.js` at them and compare.
4. Retrain with the misread digits added (see [model.md](model.md)).
