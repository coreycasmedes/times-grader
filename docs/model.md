# Digit model

A small CNN that reads one handwritten digit (28×28, MNIST-style) and returns 11 probabilities: the digits 0–9 plus "not a digit".

## Data — `npm run train:data` (about 10 minutes, CPU)
`training/data.py` builds 46,000 training samples from three sources:
- **MNIST:** 8,500 digits from the `mnist` npm package, plus 3 distorted copies of each. Distortions are rotation, shear, stroke thickness, blur, downscaling and contrast.
- **Font digits:** 8,000 digits rendered in every font on the machine, with the same distortions.
- **Not a digit:** 4,000 samples of lines, dots, dashes, "=", "×" and scribbles. This lets leftover print be rejected.

1,500 MNIST digits are held out. Their indices are saved to `model/heldout_idx.json` so the test worksheets use digits the model never saw.

`normalize()` crops to the ink, scales the long side to 20 px, and centers by mass. It must match `Reader.normalize()` in JavaScript, so change both or neither.

## Training — `npm run train` (about 4 minutes, CPU, JAX)
- **Network:** conv3×3·16 → maxpool → conv3×3·32 → maxpool → conv3×3·64 → dense 64 → dense 11 (ReLU). About 61k parameters.
- **Training:** Adam with cosine learning-rate decay, 14 epochs, batch 128, random ±2 px shifts.
- **Export:** int8 per-layer weights plus float biases, written to `model/model.json` (about 80 KB base64).

Last result:
- 97.7% on the held-out augmented set, including noise samples.
- 98.0% on digits only.
- The int8 export matches the float model.
- JavaScript output matches JAX to within 1e-5.

```bash
pip install -r training/requirements.txt
npm install            # provides node_modules/mnist
npm run train:data && npm run train && npm run build
```

## Improving it
The biggest gain will come from real children's digits:
1. Save crops the teacher corrected.
2. Label them.
3. Add them to `build()` in `data.py` and retrain.

For iOS, re-implement `train.py` in PyTorch (same layers) and export to Core ML with coremltools.
