#!/usr/bin/env python3
"""Check the engine's deck layout against the 1:200 GA drawing (nimitz-plan.jpg).

This is the Stage C tool that WORKED (see PLAN.md). The earlier idea — trace the
plan's deck outline column-by-column and re-source the outline from it — failed:
the scan's margins are full of leader lines, part drawings, labels and a compass
rose, and no masking made the trace trustworthy. What works is the inverse:
REGISTER the engine's current outline onto the plan (fit axis + lateral scale by
maximizing plan darkness along the outline polyline), then measure specific
features (catapult track lines, wires) with seeded ridge fits in that frame.

Registration found 2026-07-10 (and why the first attempt misregistered): the plan
has no bow tip — the flight-deck front is a blunt ~23 m edge — and the stern
round-down apex is buried in catwalk bands, so tip-picking put the axis ~12 px too
high. The whole-outline fit gives axis y = 335.0 + 0.0030x and 2.950 px/m lateral
(anisotropy vs fore-aft 0.994 — the scan is effectively isotropic).

Findings (all in deck-ops metres, post-squash):
- outline: 2/3 of stations sit on a plan line within +-1.7 m; the rest is clutter.
  Bow front edge is ~1.5 m short of the plan's (real half-length 166.4 vs fa 165).
- wires: plan marks at fa -116.8/-105.3/-93.9/-83.7 vs engine -115.6..-80.5 at the
  same 11.4-11.7 m spacing; the uniform ~1.4 m offset is fa-registration noise.
- cat2 (-3.44, 0 deg) and cat3 (-17.08, 4.03 deg): plan agrees within noise. The
  full-length line the fit prefers for cat2 (+1.4 deg) is the bow foul line — it
  misses the bow water-brake slot centre; the real track line matches the engine.
- cat1: engine's model-paint fit (19.41, 5.67) lay on NO plan feature (ridge
  coverage 0.22); the plan's track line (15.50, 3.30, coverage 0.95) starts at
  fa 45 — a slot's aft end right behind the spot — and hits the bow slot centre.
  MOVED (engine shuttles + bake CATS + JBD ensemble transplant), 2026-07-10.
- cat4: plan line at -27.75 (coverage 0.99 over the unambiguous aft stretch) vs
  model paint -26.82 (0.15). MOVED with heading kept 0.
"""
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
