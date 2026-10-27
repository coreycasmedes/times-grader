"""Training data for the answer-digit reader: MNIST (10k from the npm package),
digits rendered in many fonts, and a 'not a digit' class (lines, dots, dashes,
equals signs) so leftovers from printed blanks are rejected."""
import json, glob, os, random, numpy as np, cv2
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'training', 'out')
MNIST_DIR = os.path.join(ROOT, 'node_modules', 'mnist', 'src', 'digits')  # from `npm install` (the mnist package)
NOISE = 10

def normalize(ink):
    """ink: float array (h, w) with 1 = ink. Returns 28x28 MNIST-style image.
    Same steps as normalizeDigit() in the app: crop to ink, scale longest side to 20, centre of mass to the middle."""
    ys, xs = np.nonzero(ink > 0.08)
    out = np.zeros((28, 28), np.float32)
    if len(xs) == 0: return out
    ink = ink[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    h, w = ink.shape
    s = 20.0 / max(h, w)
    nw, nh = max(1, int(round(w * s))), max(1, int(round(h * s)))
    small = resample(ink, nw, nh)
    tot = small.sum()
    if tot <= 0: return out
    cy = (small.sum(1) * (np.arange(nh) + 0.5)).sum() / tot
    cx = (small.sum(0) * (np.arange(nw) + 0.5)).sum() / tot
    ox, oy = int(round(14 - cx)), int(round(14 - cy))
    for j in range(nh):
        y = j + oy
        if 0 <= y < 28:
            for i in range(nw):
                x = i + ox
                if 0 <= x < 28: out[y, x] = small[j, i]
    return np.clip(out, 0, 1)

def resample(src, nw, nh):
    """Area-ish resampling with 4x4 bilinear samples per target pixel (mirrored in JS)."""
    h, w = src.shape
    out = np.zeros((nh, nw), np.float32)
    sx, sy = w / nw, h / nh
    offs = (np.arange(4) + 0.5) / 4
    for j in range(nh):
        for i in range(nw):
            acc = 0.0
            for oyv in offs:
                y = min(h - 1.0, max(0.0, (j + oyv) * sy - 0.5))
                y0 = int(y); fy = y - y0; y1 = min(h - 1, y0 + 1)
                for oxv in offs:
                    x = min(w - 1.0, max(0.0, (i + oxv) * sx - 0.5))
                    x0 = int(x); fx = x - x0; x1 = min(w - 1, x0 + 1)
                    acc += (src[y0, x0] * (1 - fx) + src[y0, x1] * fx) * (1 - fy) + (src[y1, x0] * (1 - fx) + src[y1, x1] * fx) * fy
            out[j, i] = acc / 16
    return out

def load_mnist():
    X, Y = [], []
    for d in range(10):
        a = np.array(json.load(open(os.path.join(MNIST_DIR, f'{d}.json')))['data'], np.float32).reshape(-1, 28, 28)
        X.append(a); Y += [d] * len(a)
    return np.concatenate(X), np.array(Y)

def distort(img, rnd, big=64):
    """Random handwriting-like distortion on an ink image, then a camera-like blur/downscale."""
    im = cv2.resize(img, (big, big), interpolation=cv2.INTER_LINEAR)
    ang = rnd.uniform(-16, 16); sh = rnd.uniform(-0.3, 0.3); sc = rnd.uniform(0.85, 1.1)
    M = cv2.getRotationMatrix2D((big / 2, big / 2), ang, sc)
    M[0, 1] += sh; M[0, 2] -= sh * big / 2
    im = cv2.warpAffine(im, M, (big, big), flags=cv2.INTER_LINEAR, borderValue=0)
    k = rnd.choice([0, 0, 1, 2, -1])  # stroke thickness
    if k > 0: im = cv2.dilate(im, np.ones((k + 1, k + 1), np.uint8))
    if k < 0: im = cv2.erode(im, np.ones((2, 2), np.uint8))
    # simulate a small digit seen by the camera: shrink, blur, then threshold-ish contrast
    t = rnd.randint(12, 40)
    im = cv2.resize(im, (t, t), interpolation=cv2.INTER_AREA)
    if rnd.random() < 0.5: im = cv2.GaussianBlur(im, (3, 3), rnd.uniform(0.3, 0.9))
    gamma = rnd.uniform(0.6, 1.4)
    im = np.clip(im, 0, 1) ** gamma
    im = im * rnd.uniform(0.6, 1.0) + rnd.normalvariate(0, 0.03)
    return normalize(np.clip(im, 0, 1))

FONTS = [f for f in glob.glob('/usr/share/fonts/**/*.[ot]tf', recursive=True)
         if not any(b in f.lower() for b in ['math', 'symbol', 'wqy', 'ipa', 'emoji', 'dingbat', 'cmex', 'cmsy', 'msam', 'msbm'])]

def font_digit(d, rnd):
    f = ImageFont.truetype(rnd.choice(FONTS), 52)
    im = Image.new('L', (80, 80), 0); ImageDraw.Draw(im).text((14, 4), str(d), font=f, fill=255)
    return np.asarray(im, np.float32) / 255

def noise_sample(rnd):
    im = Image.new('L', (64, 64), 0); dr = ImageDraw.Draw(im)
    kind = rnd.randint(0, 5)
    w = rnd.randint(2, 6)
    if kind == 0:  # horizontal line or underline piece
        y = rnd.randint(20, 44); dr.line([(rnd.randint(0, 20), y), (rnd.randint(44, 63), y + rnd.randint(-4, 4))], fill=255, width=w)
    elif kind == 1:  # dot or speck
        r = rnd.randint(2, 6); x, y = rnd.randint(20, 44), rnd.randint(20, 44); dr.ellipse([x - r, y - r, x + r, y + r], fill=255)
    elif kind == 2:  # equals sign
        y = rnd.randint(22, 34); dr.line([(10, y), (54, y)], fill=255, width=w); dr.line([(10, y + 12), (54, y + 12)], fill=255, width=w)
    elif kind == 3:  # short dash
        y = rnd.randint(26, 38); dr.line([(22, y), (42, y + rnd.randint(-3, 3))], fill=255, width=w)
    elif kind == 4:  # times sign
        dr.line([(18, 18), (46, 46)], fill=255, width=w); dr.line([(46, 18), (18, 46)], fill=255, width=w)
    else:  # scribble
        pts = [(rnd.randint(8, 56), rnd.randint(8, 56)) for _ in range(rnd.randint(4, 8))]; dr.line(pts, fill=255, width=w)
    return np.asarray(im, np.float32) / 255

def build(seed, mnist_x, mnist_y, n_aug_mnist=3, n_font=8000, n_noise=4000):
    rnd = random.Random(seed)
    X, Y = [], []
    for img, y in zip(mnist_x, mnist_y):
        X.append(img); Y.append(y)
        for _ in range(n_aug_mnist): X.append(distort(img, rnd)); Y.append(y)
    for _ in range(n_font):
        d = rnd.randrange(10); X.append(distort(font_digit(d, rnd), rnd)); Y.append(d)
    for _ in range(n_noise):
        X.append(distort(noise_sample(rnd), rnd)); Y.append(NOISE)
    return np.stack(X).astype(np.float32), np.array(Y, np.int32)

if __name__ == '__main__':
    X, Y = load_mnist()
    idx = np.random.RandomState(0).permutation(len(X))
    test_idx, train_idx = idx[:1500], idx[1500:]
    os.makedirs(OUT, exist_ok=True)
    # digits kept out of training; the synthetic test worksheets are written with these
    json.dump([int(i) for i in test_idx], open(os.path.join(ROOT, 'model', 'heldout_idx.json'), 'w'))
    Xtr, Ytr = build(1, X[train_idx], Y[train_idx])
    Xte, Yte = build(2, X[test_idx], Y[test_idx], n_aug_mnist=1, n_font=1000, n_noise=500)
    np.savez_compressed(os.path.join(OUT, 'dataset.npz'), Xtr=Xtr, Ytr=Ytr, Xte=Xte, Yte=Yte)
    print(Xtr.shape, Xte.shape, np.bincount(Ytr))
