#!/usr/bin/env python3
"""Check the engine's deck layout against the 1:200 GA drawing (nimitz-plan.jpg). Tracing the plan's
outline directly fails (the margins are full of leader lines, part drawings and labels); instead REGISTER
the engine's outline onto the plan (fit axis + lateral scale by maximising plan darkness along the
polyline), then measure catapult track lines and wires with seeded ridge fits in that frame. Never pick
tips: the plan has no bow tip (a blunt ~23 m front edge) and the stern apex is buried in catwalk bands,
so fit the whole outline."""
import json, math, sys
import numpy as np
from PIL import Image, ImageDraw

IMG = 'nimitz-plan.jpg'
X0, X1, FA0, FA1 = 8.0, 993.0, -167.0, 165.0     # stern/bow columns -> outline fa extremes
PXM = (X1-X0)/(FA1-FA0)                          # 2.967 px/m fore-aft
FRAME = dict(a=335.0, b=0.0030, plat=2.950)      # axis y = a + b*x, lateral px/m (fitted)

im = np.asarray(Image.open(IMG).convert('L')).astype(float)
H, W = im.shape
dark = (255-im)/255.0
cur = json.load(open('outline.json'))
OUT = np.array(cur['OUT'])

def x_of(fa): return X0+(fa-FA0)*PXM
def y_of(x, lat, f=FRAME): return f['a']+f['b']*x+lat*f['plat']

def fit_frame():
    """Refit axis + lateral scale by maximizing darkness along the outline."""
    xs = x_of(OUT[:, 0]); lats = OUT[:, 1]
    def score(a, b, plat):
        ys = a+b*xs+lats*plat; s = 0.0
        for x, y in zip(xs, ys):
            xi, yi = int(round(x)), int(round(y))
            if 1 <= yi < H-1 and 0 <= xi < W: s += dark[yi-1:yi+2, xi].max()
        return s/len(xs)
    best = None
    for a in np.arange(316, 341, 1.0):
        for b in np.arange(-0.012, 0.0021, 0.002):
            for plat in np.arange(2.9, 3.75, 0.05):
                sc = score(a, b, plat)
                if best is None or sc > best[0]: best = (sc, a, b, plat)
    sc, a, b, plat = best
    for da in np.arange(-1, 1.01, 0.25):
        for db in np.arange(-0.002, 0.0021, 0.0005):
            for dp in np.arange(-0.06, 0.061, 0.01):
                s2 = score(a+da, b+db, plat+dp)
                if s2 > sc: sc, a, b, plat = s2, a+da, b+db, plat+dp
    print(f'fitted frame: axis y = {a:.2f} {b:+.4f}x  plat={plat:.3f} px/m  score={sc:.3f}')
    return dict(a=a, b=b, plat=plat)

def coverage(f0, l0, h, f1, thr=0.35):
    """Fraction of the line lat(f)=l0-tan(h)*(f-f0) that lies on plan ink."""
    t = math.tan(math.radians(h)); n = c = 0
    for f in np.arange(f0+4, f1, 0.5):
        x = x_of(f); y = y_of(x, l0-t*(f-f0))
        xi, yi = int(round(x)), int(round(y))
        if 1 <= yi < H-1 and 0 <= xi < W:
            n += 1
            if dark[yi-1:yi+2, xi].max() > thr: c += 1
    return c/max(n, 1)

def ridge(f0, l0, h, f1, dl=5.0, dh=3.0):
    """Seeded ridge fit: best (lat0, heading) near the seed by line coverage."""
    best = (0, l0, h)
    for l in np.arange(l0-dl, l0+dl+0.01, 0.1):
        for hh in np.arange(h-dh, h+dh+0.01, 0.1):
            cv = coverage(f0, l, hh, f1)
            if cv > best[0]: best = (cv, l, hh)
    return best

def overlay(name='plan_overlay.png'):
    """Engine outline + equipment drawn onto the plan at FRAME."""
    img = Image.open(IMG).convert('RGB')
    SC = 2
    big = img.resize((img.width*SC, img.height*SC), Image.LANCZOS)
    d = ImageDraw.Draw(big)
    pts = [(x_of(fa)*SC, y_of(x_of(fa), lat)*SC) for fa, lat in cur['OUT']]
    d.line(pts+[pts[0]], fill=(255, 0, 0), width=2)
    for f0, l0, h, f1 in CATS:
        t = math.tan(math.radians(h))
        d.line([(x_of(f0)*SC, y_of(x_of(f0), l0)*SC),
                (x_of(f1)*SC, y_of(x_of(f1), l0-t*(f1-f0))*SC)], fill=(0, 120, 255), width=2)
    for wfa in WIRES:
        ll = LINE_A-LINE_S*(wfa-LINE_F)
        x = x_of(wfa)
        d.line([((x-0.15*12.5*FRAME['plat'])*SC, y_of(x, ll-12.5)*SC),
                ((x+0.15*12.5*FRAME['plat'])*SC, y_of(x, ll+12.5)*SC)], fill=(255, 0, 255), width=2)
    big.save(name); print(f'wrote {name}')

# engine constants to check (post-squash deck-ops frame) — keep in sync with engine.ts
CATS = [(48.98, 15.50, 3.30, 163.0), (47.23, -3.44, 0.0, 163.0),
        (-46.61, -17.08, 4.03, 74.0), (-66.50, -27.75, 0.0, 72.0)]
WIRES = [-115.6, -103.9, -92.2, -80.5]
LINE_F, LINE_A, LINE_S = -115.6, 1.92, 0.15171   # landing line: lat = A - S*(fa-F)

if __name__ == '__main__':
    if 'fit' in sys.argv: FRAME = fit_frame()
    print('cat   engine(lat0,h)      plan ridge(lat0,h)   cover(plan/engine)')
    for i, (f0, l0, h, f1) in enumerate(CATS):
        cv, lb, hb = ridge(f0, l0, h, f1)
        print(f'cat{i+1}  ({l0:+6.2f},{h:+5.2f})  ->  ({lb:+6.2f},{hb:+5.2f})    '
              f'{cv:.2f}/{coverage(f0, l0, h, f1):.2f}')
    overlay()
