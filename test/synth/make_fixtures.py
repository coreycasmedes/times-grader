"""Builds synthetic test data in test/out/:
  - key.png + student_*.png: phone-style photos of a 30-problem multiplication worksheet,
    answers handwritten with MNIST digits the model never trained on
  - stack.y4m: a fake camera feed (key page, then 3 students, with a hand flipping pages)
  - fixtures.json: the truth (key answers, rough answer boxes as Claude would return them, student answers)
Run from the repo root:  python3 test/synth/make_fixtures.py"""
import json, os, random, subprocess, sys, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from ws import photo, problems
import ws2
OUT = os.path.join(os.path.dirname(HERE), 'out'); os.makedirs(OUT, exist_ok=True)
rnd = random.Random(7); np.random.seed(7)
probs = problems(42); key = [str(a * b) for a, b in probs]

def student_answers(r):
    ans = []
    for a, b in probs:
        u = r.random(); p = a * b
        ans.append('' if u < 0.04 else str(max(1, p + r.choice([-1, 1, 2, -2, 10, -10, a]))) if u < 0.2 else str(p))
    return ans

# --- still photos for the reader accuracy test ---
sheet, boxes = ws2.worksheet(probs, key, '', rnd)
photo(sheet, 1080, 1920, rnd, tilt=0.06)[0].save(os.path.join(OUT, 'key.png'))
students = []
for s in range(8):
    ans = student_answers(rnd)
    sh, _ = ws2.worksheet(probs, ans, f'S{s}', rnd, set(rnd.sample(range(30), 4)))
    fn = f'student_{s}.png'
    photo(sh, 1080, 1920, rnd, tilt=0.1, blur=rnd.choice([0.8, 1.0, 1.4]))[0].save(os.path.join(OUT, fn))
    students.append({'file': fn, 'ans': ans})

# --- fake camera feed for the browser test ---
W, H = 720, 1280
def held(sh, n, seed):
    r = random.Random(seed); base, _ = photo(sh, W, H, r, tilt=0.05, scale=(0.82, 0.88)); b = np.asarray(base).astype(np.float32)
    return [np.clip(np.roll(np.roll(b, r.randint(-1, 1), 0), r.randint(-1, 1), 1) + np.random.normal(0, 2, b.shape), 0, 255).astype(np.uint8) for _ in range(n)]
def hand(n):
    out = []
    for i in range(n):
        a = np.full((H, W, 3), 85, np.float32) + np.random.normal(0, 7, (H, W, 3)); yy, xx = np.mgrid[0:H, 0:W]; cx = W * (-0.1 + 1.2 * i / max(1, n - 1))
        a[((xx - cx) / (W * 0.3)) ** 2 + ((yy - H * 0.55) / (H * 0.22)) ** 2 < 1] = [205, 165, 140]; out.append(np.clip(a, 0, 255).astype(np.uint8))
    return out
frames = hand(4) + held(sheet, 45, 1)
video_students = []
for s in range(3):
    ans = student_answers(rnd); sh, _ = ws2.worksheet(probs, ans, f'Kid{s}', rnd)
    frames += hand(8) + held(sh, 45, 10 + s); video_students.append(ans)
frames += hand(8)
p = subprocess.Popen(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', '15', '-i', '-', '-pix_fmt', 'yuv420p', os.path.join(OUT, 'stack.y4m')], stdin=subprocess.PIPE)
for f in frames: p.stdin.write(f.tobytes())
p.stdin.close(); p.wait()

# rough answer boxes, jittered by up to 1.2% like a model's guess would be
rj = random.Random(5); J = lambda: rj.uniform(-12, 12)
claude_key = {'title': 'Multiplication Facts — Practice 4', 'name_box': [150, 80, 560, 120],
              'p': [[i + 1, a, '×', b, key[i], [round(bx[0] + J()), round(bx[1] + J()), round(bx[2] + J()), round(bx[3] + J())]] for i, ((a, b), bx) in enumerate(zip(probs, boxes))]}
json.dump({'key': key, 'boxes': boxes, 'claudeKey': claude_key, 'students': students, 'videoStudents': video_students}, open(os.path.join(OUT, 'fixtures.json'), 'w'))
print('wrote test/out/ (key.png, 8 student photos, stack.y4m, fixtures.json)')
