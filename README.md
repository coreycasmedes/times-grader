# Times Grader

Grades handwritten multiplication worksheets live through a phone camera. The teacher scans the answer key once. After that, each student page is captured automatically when it is held still, graded on the phone in under a second, and marked with ✓, ✗ or ? on top of the page.

It is a single HTML page with no server and no build-time dependencies.

## How it works

```
Key (once)      camera → find page → flatten → Claude reads problems + answers → find where each answer is written → template
Student pages   camera → find page → wait until still → flatten to key size → read each answer on-device → compare to key → draw marks
```

- **Page capture** (`src/paper.js`): finds the paper's four corners in every frame, waits until the page is still, and recognizes a page it has already graded.
- **Answer reading** (`src/reader.js`): crops each answer spot, splits it into digits, and reads them with a small neural network that runs in plain JavaScript. The network is about 60 KB of int8 weights in `model/model.json`.
- **Claude** is used only to read the key and, optionally, in the background for student names and answers the phone flagged with ?. It is never on the critical path for grading.

Details: [docs/architecture.md](docs/architecture.md).

## Quick start

```bash
npm install          # test tools only (sharp, playwright, MNIST data); the app needs nothing
npm run build        # writes dist/index.html
npm run serve        # http://localhost:8080
```

The camera only works on HTTPS or `localhost`. To test on a phone, deploy it (below) or use a tunnel.

When the app runs on its own web address, add an Anthropic API key in **Settings**. It is used for the key scan. Inside Claude no key is needed, but the Claude app blocks the camera, so use **Use a video** or **Use photos** there.

## Deploy to GitHub Pages

1. Push this repo to GitHub.
2. In the repo, go to **Settings → Pages → Source** and select **GitHub Actions**.
3. Every push to `main` runs `.github/workflows/pages.yml` and publishes `dist/index.html`.
4. Open `https://<user>.github.io/<repo>/` in Safari on the phone.

More options: [docs/deploy.md](docs/deploy.md).

## Tests

```bash
pip install -r test/synth/requirements.txt   # needs ffmpeg and the DejaVu fonts
npm run fixtures                             # synthetic worksheets + a fake camera video in test/out/
npm run test:reader                          # reader accuracy, exact and rough answer boxes
npx playwright install chromium && npm run test:e2e   # full app in headless Chrome with a fake camera
```

Current results on synthetic data are in [docs/testing.md](docs/testing.md). They have **not** been measured on real student handwriting yet.

## Project layout

| Path | What it is |
|---|---|
| `src/app.html` | Page markup and styles. Markers like `/*APP*/` are filled in by the build. |
| `src/app.js` | UI, scanner loop, Claude calls, storage, Web Worker setup. |
| `src/paper.js` | Page finding, tracking, flattening, same-page detection. |
| `src/reader.js` | Digit segmentation, the neural network, key template, grading. |
| `model/model.json` | Trained digit model (int8 weights, base64). |
| `model/heldout_idx.json` | MNIST samples kept out of training, used to write test worksheets. |
| `training/` | Python scripts that build the dataset and train the model. See [docs/model.md](docs/model.md). |
| `test/` | Synthetic data generator, reader accuracy test, browser end-to-end test. |
| `scripts/build.mjs` | Inlines everything into `dist/index.html` and `dist/claude-artifact.html`. |

## Known limits

- Accuracy is measured only on synthetic pages written with MNIST digits. Real kids' handwriting is the next thing to test.
- The API key is stored in the browser. That is fine for a personal prototype, but before sharing the app with other teachers, route Claude calls through a small backend.
- The page finder needs some contrast between the paper and the desk. White paper on a white table works poorly.
- Only one answer key is active at a time, and one page counts as one student.
