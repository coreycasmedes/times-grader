# Times Grader: notes for Claude Code

Single-page web app that grades handwritten multiplication worksheets live from a phone camera. Read README.md and docs/architecture.md first.

## Commands
- `npm run build`: inline `src/*` and `model/model.json` into `dist/index.html` and `dist/claude-artifact.html`. Always rebuild after editing `src/`.
- `npm run fixtures`: synthetic test data in `test/out/` (Python, ffmpeg, DejaVu fonts).
- `npm run test:reader`: reader accuracy in Node. Report the "decided correctly", "flagged ?" and "mistakes" lines.
- `npm run test:e2e`: headless Chromium with a fake camera (`npx playwright install chromium` first).

## Rules
- `src/paper.js` and `src/reader.js` must stay plain scripts that define a global (`Paper`, `Reader`) and end with the `module.exports` guard. They run in the page, in a Web Worker built from their script tags, and in Node tests.
- No runtime dependencies or CDN libraries. The app must work offline after load, except for Claude calls.
- `Reader.normalize()` must match `normalize()` in `training/data.py`.
- Accuracy changes: run `npm run test:reader` before and after, and include both numbers in the PR description.
- A ? is better than a wrong ✗. Don't trade more flags for more mistakes.
- Claude prompts live in `src/app.js` (`KEY_PROMPT` and the one in `assist()`). The key reply shape is `{title, name_box, p:[[n,a,op,b,key,[x0,y0,x1,y1]]]}`, with boxes in 0–1000 page units.

## Open work
- Measure on real student worksheets (docs/testing.md, "Next").
- Backend proxy for the API key (docs/deploy.md).
- Retrain with real children's digits (docs/model.md).
- Native iOS port (docs/architecture.md, "Porting to Swift").
