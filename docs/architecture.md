# Architecture

## Pipeline

### 1. Find the page — `Paper.findPage(gray, w, h)`
Runs on every camera frame, downscaled so the long side is 640 px (about 10 ms).
1. An Otsu threshold separates bright paper from the darker desk.
2. The largest bright blob is taken as the page. Its boundary pixels feed a convex hull, which is reduced to 4 corners.
3. Each corner is refined by fitting a line to each edge and intersecting neighboring edges. Corner error is about 0.3% of the page size.
4. The result is `{quad: [TL, TR, BR, BL], clipped}`. `clipped` means a corner touches the frame edge.

### 2. Decide when to capture — `Paper.Tracker.feed(frame)`
Returns one of these states on every frame:

| State | Meaning |
|---|---|
| `search` | No page in view. |
| `clipped` | Page is partly out of frame. |
| `steady` | Page is in view but still moving. |
| `capture` | Page has been still for 4 frames and is new. The app grades it. |
| `tracking` | Page in view has already been graded. The app draws its marks. |

**"Still"** means corners moved less than 1.2% of the page size and the whole frame changed less than 2%.

**"New"** means the page doesn't match any of the last 6 pages graded. Each page gets a 200×260 ink fingerprint, and `Paper.difference()` counts the cells that differ after a small local alignment. Copies of the same worksheet share all their print, so only the handwriting differs: the same sheet scores about 0–110, while different students score about 160+. The threshold is `sameThresh = 80`. A low threshold means a hand passing over a page can cause a duplicate capture, which is better than silently missing a student.

### 3. Flatten — `Paper.rectify(rgba, w, h, quad, outLong, outW, outH)`
A perspective warp from the full-resolution frame. The key is flattened with a 1600 px long side. Student pages are flattened to the **key's exact size**, so the same pixel means the same place on every page.

### 4. Read the key (Claude, once) — `KEY_PROMPT` in `app.js`
Claude returns `{title, name_box, p: [[n, a, op, b, keyAnswer, [x0,y0,x1,y1]]]}`, with boxes in 0–1000 page units. The boxes are only rough and are refined in the next step. If the key's written answer is blank, the computed product is used instead.

### 5. Build the template — `Reader.buildTemplate(gray, W, H, problems)`
For each problem:
- **Anchor:** search near Claude's box for the teacher's handwriting that reads as the key answer. This gives a tight box, the *core*. The search tries a 50% margin first, then 100%. A match only counts if it is near the rough box and digit-sized.
- **Zone:** the core plus generous margins. This is where students are expected to write.
- **Print mask:** dark pixels on the key page, dilated by 5 px, with the teacher's answers cleared out. Student strokes outside the core that lie mostly on the print mask are treated as printed text (the "=" sign, the neighboring problem) and ignored.

Problems whose anchor is not found keep Claude's rough box. These are shown dashed in the key review screen. They never get a firm ✗ from the phone, only a ?.

### 6. Grade one answer — `Reader.gradeItem()` → `Reader.check()`
1. Crop the zone and estimate paper and ink levels.
2. Binarize, then take connected components.
3. Drop underlines, box borders, specks, and printed ink.
4. Group strokes that overlap horizontally (a 5's top, a 4's two strokes) into one digit.
5. Cut wide groups at their thinnest columns. These pieces are called *atoms*.
6. **Key-constrained reading:** dynamic programming finds the best way to glue atoms into exactly the key's digits, in order. If every digit scores at least 0.5, the answer is **right**. This copes with touching digits and broken strokes.
7. Otherwise the natural reading is compared with the key. A low-confidence reading becomes **unsure (?)**, never **wrong**.

The network is a CNN: conv 16 → pool → conv 32 → pool → conv 64 → dense 64 → 11 outputs. The outputs are the digits 0–9 plus a "not a digit" class for lines, dots and "=" signs. It takes about 2.5 ms per digit in JavaScript.

### 7. Show and store
- The live view draws marks at each core's center, projected through the current page corners with `Paper.pageToQuad`.
- Anything flagged ? (and the student's name) is sent to Claude in the background when Claude is available (`assist()` in `app.js`).

## Threads

All heavy work (flattening, building the template, grading) runs in a **Web Worker** created from a Blob. The Worker is built from the `paperSrc` and `readerSrc` script tags plus `WORKER_MAIN`. If workers are blocked, the same code runs on the main thread (`fallbackInThread`).

Worker messages:

| Message | Input | Output |
|---|---|---|
| `init` | model | — |
| `flatten` | rgba, w, h, quad | flat image |
| `template` | key rgba, W, H, rough boxes | items, found |
| `grade` | rgba, w, h, quad, expected[] | verdicts, flat image, ms |

## Data

- **localStorage `timesgrader.v2`:** `{ key, papers, settings }`
  - `key`: `{ title, nameBox, probs:[{n,a,op,b,key,box}], W, H, items:[{zone,core,anchored}], found }`
  - Each paper: `{ id, at, name, status, probs:[{n,a,op,b,exp,ans,v,x,y,src}], ov:{index:bool}, ms, w, h, thumb, nameCrop }`
    - `v` is `right`, `wrong` or `unsure`.
    - `ov` holds the teacher's overrides.
    - `x`, `y` are in 0–1000 page units.
- **IndexedDB `timesgrader`, store `pages`:** flattened JPEGs keyed by paper id. The key page is stored under `key`. The template is rebuilt from it on load, which takes about 1 second.

## Tuning knobs

| Where | Value | Effect |
|---|---|---|
| `Tracker` `stableFrames` | 4 | Frames of stillness before capture. Lower is faster but blurrier. |
| `Tracker` `sameThresh` | 80 | Fingerprint difference that still counts as the same page. |
| `check()` right threshold | 0.5 | Minimum per-digit probability to mark an answer right. |
| `check()` unsure band | 0.12, and natural confidence 0.75 | Below these, an answer is marked wrong. Between them, it gets a ?. |
| `buildTemplate` print mask | dilation 5 px, local threshold 0.85 | How strictly printed ink is ignored. |
| `rectify` size | 1600 px | Larger reads small writing better but is slower. |

## Porting to Swift

| Here | Native equivalent |
|---|---|
| `findPage` / `Tracker` | `VNDetectDocumentSegmentationRequest` + `VNTrackRectangleRequest`. Keep the stillness and fingerprint logic. |
| `rectify` | `CIPerspectiveCorrection` |
| Camera | `AVCapturePhotoOutput`, for a full-resolution photo at capture time. |
| `reader.js` | Port as is. Convert the model with coremltools from the training script. |
| Template, grading, data shapes | Same logic and JSON. |
