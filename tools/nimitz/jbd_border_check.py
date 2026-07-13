#!/usr/bin/env python3
"""One-shot verification of the analytic JBD border bake (2026-07-13).

1. Diffs decktex12.png against decktex12-prev.png and clusters changed texels by
   region — the change must be confined to the four JBD rectangles.
2. Measures painted border width in texels along sample cuts: each JBD box edge
   vs the elevator-1 border and the cat-1 blast-zone border. The point of the
   change is uniform width, so the JBD numbers must land in the neighbours' range.
"""
import numpy as np
from PIL import Image

FA0, FA1, LA0, LA1 = -172.0, 172.0, -52.0, 48.0
W, H = 8192, 2400
def U(fa):  return int((fa-FA0)/(FA1-FA0)*W)
def V(lat): return int((lat-LA0)/(LA1-LA0)*H)
PXM_U = W/(FA1-FA0)   # texels per metre, fa axis
PXM_V = H/(LA1-LA0)

new = np.asarray(Image.open('decktex12.png').convert('RGB'), np.int16)
old = np.asarray(Image.open('decktex12-prev.png').convert('RGB'), np.int16)

d = np.abs(new-old).max(2) > 12
ys, xs = np.where(d)
print(f"changed texels: {d.sum()}")
if len(xs):
    # cluster by connected fa bands (gap > 40 texels starts a new region)
    order = np.argsort(xs)
    xs_s = xs[order]; ys_s = ys[order]
    breaks = np.where(np.diff(xs_s) > 40)[0]
    start = 0
    for b in list(breaks)+[len(xs_s)-1]:
        seg = slice(start, b+1)
        fa_lo = xs_s[seg].min()/PXM_U+FA0; fa_hi = xs_s[seg].max()/PXM_U+FA0
        la_lo = ys_s[seg].min()/PXM_V+LA0; la_hi = ys_s[seg].max()/PXM_V+LA0
        print(f"  region fa {fa_lo:7.2f}..{fa_hi:7.2f}  lat {la_lo:7.2f}..{la_hi:7.2f}  ({(b+1-start)} texels)")
        start = b+1

def is_border(px):   # saturated red or yellow
    r, g, b = int(px[0]), int(px[1]), int(px[2])
    return (r > 100 and g < 80 and b < 80) or (r > 160 and g > 120 and b < 90)

def runs(img, fa_c=None, lat_range=None, lat_c=None, fa_range=None):
    """widths (texels) of border-coloured runs along one cut"""
    out = []
    if fa_c is not None:
        u = U(fa_c); v0, v1 = V(lat_range[0]), V(lat_range[1])
        line = [is_border(img[v, u]) for v in range(v0, v1)]
    else:
        v = V(lat_c); u0, u1 = U(fa_range[0]), U(fa_range[1])
        line = [is_border(img[v, u]) for u in range(u0, u1)]
    n = 0
    for f in line + [False]:
        if f: n += 1
        elif n: out.append(n); n = 0
    return out

JBD = [(27.2, 16.76), (23.5, -3.44), (-68.7, -15.52), (-84.5, -27.75)]
print("\nJBD border widths (texels; lateral cut through box centre crosses the two long edges):")
for i, (tf, tl) in enumerate(JBD):
    r = runs(new, fa_c=tf, lat_range=(tl-6.5, tl+6.5))
    print(f"  cat {i+1}: lateral cut {r}   fore-aft cut {runs(new, lat_c=tl, fa_range=(tf-4.0, tf+4.0))}")

print("\nneighbour borders for comparison (same cuts on the OLD texture = authored paint):")
print(f"  elevator 1 left edge   (fa 30, lat 18..26):  {runs(new, fa_c=30, lat_range=(18, 26))}")
print(f"  blast zone aft of cat 1 (fa 20, lat 26..37): {runs(new, fa_c=20, lat_range=(26, 37))}")
print(f"  old cat-1 JBD (authored dashes, lateral cut): {runs(old, fa_c=27.2, lat_range=(16.76-6.5, 16.76+6.5))}")
