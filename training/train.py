"""Train the small digit CNN (10 digits + 'not a digit') with JAX and export int8 weights for the app."""
import numpy as np, jax, jax.numpy as jnp, json, base64, time, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "training", "out")

d = np.load(os.path.join(OUT, 'dataset.npz')); Xtr, Ytr, Xte, Yte = d['Xtr'], d['Ytr'], d['Xte'], d['Yte']
Xtr = Xtr[..., None]; Xte = Xte[..., None]
SHAPES = [('c1', (3, 3, 1, 16)), ('c2', (3, 3, 16, 32)), ('c3', (3, 3, 32, 64)), ('f1', (576, 64)), ('f2', (64, 11))]

def init(key):
    p = {}
    for name, shp in SHAPES:
        key, k = jax.random.split(key)
        fan_in = int(np.prod(shp[:-1]))
        p[name + 'w'] = jax.random.normal(k, shp) * np.sqrt(2.0 / fan_in)
        p[name + 'b'] = jnp.zeros(shp[-1])
    return p

def conv(x, w, b):  # x NHWC, valid padding
    return jax.lax.conv_general_dilated(x, w, (1, 1), 'VALID', dimension_numbers=('NHWC', 'HWIO', 'NHWC')) + b

def pool(x):
    return jax.lax.reduce_window(x, -jnp.inf, jax.lax.max, (1, 2, 2, 1), (1, 2, 2, 1), 'VALID')

def forward(p, x):
    x = pool(jax.nn.relu(conv(x, p['c1w'], p['c1b'])))   # 28->26->13
    x = pool(jax.nn.relu(conv(x, p['c2w'], p['c2b'])))   # 13->11->5
    x = jax.nn.relu(conv(x, p['c3w'], p['c3b']))         # 5->3
    x = x.reshape(x.shape[0], -1)                         # 3*3*64 = 576 (H,W,C order)
    x = jax.nn.relu(x @ p['f1w'] + p['f1b'])
    return x @ p['f2w'] + p['f2b']

def loss(p, x, y):
    lg = forward(p, x)
    return -jnp.mean(jnp.sum(jax.nn.log_softmax(lg) * jax.nn.one_hot(y, 11), -1))

@jax.jit
def step(p, m, v, t, x, y, lr):
    l, g = jax.value_and_grad(loss)(p, x, y)
    m = jax.tree.map(lambda a, b: 0.9 * a + 0.1 * b, m, g)
    v = jax.tree.map(lambda a, b: 0.999 * a + 0.001 * b * b, v, g)
    p = jax.tree.map(lambda a, mm, vv: a - lr * (mm / (1 - 0.9 ** t)) / (jnp.sqrt(vv / (1 - 0.999 ** t)) + 1e-8), p, m, v)
    return p, m, v, l

pred = jax.jit(lambda p, x: jnp.argmax(forward(p, x), -1))
def acc(p, X, Y):
    out = np.concatenate([np.asarray(pred(p, X[i:i + 1000])) for i in range(0, len(X), 1000)])
    return (out == Y).mean(), out

def shift_aug(x, rs):
    # small random shifts so slight off-centre crops still read
    out = np.zeros_like(x)
    dx, dy = rs.randint(-2, 3), rs.randint(-2, 3)
    out[:, max(0, dy):28 + min(0, dy), max(0, dx):28 + min(0, dx)] = x[:, max(0, -dy):28 + min(0, -dy), max(0, -dx):28 + min(0, -dx)]
    return out

p = init(jax.random.PRNGKey(0)); m = jax.tree.map(jnp.zeros_like, p); v = jax.tree.map(jnp.zeros_like, p)
rs = np.random.RandomState(0); t = 0; B = 128; EPOCHS = 14
for ep in range(EPOCHS):
    t0 = time.time(); idx = rs.permutation(len(Xtr)); lr = 2e-3 * (0.5 * (1 + np.cos(np.pi * ep / EPOCHS)))
    for i in range(0, len(idx) - B + 1, B):
        b = idx[i:i + B]; t += 1
        p, m, v, l = step(p, m, v, t, shift_aug(Xtr[b], rs), Ytr[b], lr)
    a, _ = acc(p, Xte, Yte)
    print(f'epoch {ep} loss {float(l):.3f} test acc {a:.4f} {time.time() - t0:.0f}s', flush=True)

a, out = acc(p, Xte, Yte)
digits = Yte < 10
print('digit-only acc', (out[digits] == Yte[digits]).mean(), 'noise recall', (out[~digits] == 10).mean(), 'digits called noise', (out[digits] == 10).mean())

# export: int8 per-tensor quantised weights, float biases
blob = bytearray(); meta = []
for name, shp in SHAPES:
    w = np.asarray(p[name + 'w'], np.float32); s = float(np.abs(w).max() / 127)
    q = np.clip(np.round(w / s), -127, 127).astype(np.int8)
    meta.append({'name': name, 'shape': list(shp), 'scale': s, 'off': len(blob), 'bias': [round(float(x), 6) for x in np.asarray(p[name + 'b'])]})
    blob += q.tobytes()
json.dump({'layers': meta, 'b64': base64.b64encode(bytes(blob)).decode()}, open(os.path.join(ROOT, 'model', 'model.json'), 'w'))
# reference outputs for a JS parity test (dequantised weights)
deq = {}
for L in meta:
    raw = np.frombuffer(bytes(blob[L['off']:L['off'] + int(np.prod(L['shape']))]), np.int8).astype(np.float32) * L['scale']
    deq[L['name'] + 'w'] = jnp.array(raw.reshape(L['shape'])); deq[L['name'] + 'b'] = jnp.array(L['bias'], dtype=jnp.float32)
qa, _ = acc(deq, Xte, Yte)
print('int8 test acc', qa)
np.savez(os.path.join(OUT, 'parity.npz'), x=Xte[:20, ..., 0], logits=np.asarray(forward(deq, Xte[:20])))
print('model bytes', len(blob))
