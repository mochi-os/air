#!/usr/bin/env python3
"""Nimitz deck-texture bake from the original model. Layers, in order:
  1. weathered non-skid base (value noise + plate seams + grunge)
  2. analytic landing-area boundary lines, drawn before tracks/rubber so cats and wires overlay them;
     authored fragments near a line are suppressed
  3. the original model's up-facing paint: near-black never painted; saturated markings painted (JBD
     borders killed at the authored spots and drawn at the plan rectangles); neutral thin lines (<1.0 m)
     painted; neutral wide plates, marks inside a catapult corridor, material_37 raft shells, and grey
     mono marks (lum<=0.60) within 4.5 m of the outline skipped (bow "68" numerals exempted by box);
     the original bow cab's tops skipped, and a steel plate with a red/yellow border drawn under each
     catapult control cab (cabs.py)
  4. catapult tracks: bare-steel strip 1.4 m + near-black slot 0.12 m, from just aft of each shuttle
     to the deck-outline exit
  5. rubber: landing-strip band + catapult start streaks
Where the deck ends, where the catapults, deflectors, landing line and cabs are, and the texture's
extent come from the ship file (ship.py), which the engine reads too.

After any mark-rule change, diff lost bright pixels against the previous texture clustered by fa bin;
per-spot probes miss systemic damage. Discriminating lum: phantom plates 0.523, painted lines 0.659,
whites 0.976. All markings are anti-aliased (3x3 coverage for model paint, analytic lateral coverage
for tracks); track steel noise is smooth 1D.

Output: decktex12.png (8192x2400 over the ship file's texture extent)
"""
import json, math, struct, sys
import resource
from pathlib import Path
import numpy as np
from PIL import Image
from cabs import CABS, footprint, PLATE, BORDER, DASH
from ship import SHIP, OUTLINE, inside as inpoly, line as catapult_line, axes as catapult_axes, end as track_end

# Hard memory cap: a healthy bake fits in well under 4 GB; a MemoryError here
# means a new unbounded allocation.
resource.setrlimit(resource.RLIMIT_AS, (8 << 30, 8 << 30))

# Derived, never typed: these scripts are committed, so an absolute home path
# makes the asset pipeline runnable on exactly one machine.
ROOT = Path(__file__).resolve().parents[4]
APP = ROOT / "apps" / "air"
ORIG = str(APP / "downloads" / "uss_nimitz_cvn-68_aircraft_carrier.glb")

W, H = 8192, 2400
(FA0, FA1), (LA0, LA1) = SHIP['texture']['x'], SHIP['texture']['z']
S = 0.025; CX, CZ = 6361.3, -469.3; DECKY = 776.0

POLY = OUTLINE   # the deck's edge

# Stage B: the model is laterally squashed to the real 76.8 m beam in build_carrier
# (S_LAT below); every lat this bake paints must follow (tracks, marks, exclusions, rubber)
S_LAT = 76.8/80.0
# catapult tracks: each slot starts half a metre aft of its shuttle's rest spot; the start
# streaks are darker on the bow catapults
STAINS = [12, 12, 10, 10]
assert len(STAINS) == len(SHIP['catapults'])
TRACKS = [(c['x']-0.5, track_end(c, c['x']-0.5), catapult_line(c), st) for c, st in zip(SHIP['catapults'], STAINS)]
# superseded model paint (cats 1/4 moved to the plan lines): the model's own painted
# track pairs still lie on the OLD lines — keep killing them exactly where the old
# corridor did.
OLD = [
    (36.0, 166.0, lambda f: (20.22-0.1034*(f-48.98))*S_LAT),
    (-67.0, 73.0,  lambda f: (-27.94+0*f)*S_LAT),
]
def superseded(f, l): return any(a < f < b and abs(l-ln(f)) < 0.9 for a, b, ln in OLD)
# JBD regions: the model authored each cat's red/yellow dashed box 8-10 m aft of
# the shuttle spot; the 1:200 plan puts the JBD 18-24 m aft, centred on the
# track. Per cat, saturated marks in the authored region (fa0, fa1, lat0, lat1)
# are killed and the border is drawn at the ship file's deflector box (the one the
# engine's animated panel fills); grey mono marks there (lum<=0.85 spares the
# landing-area stripes) are killed. The cat-1 blast-zone rectangle stays except
# where it crosses a drawn box (jbd_zone).
JBD = [
    (36.4, 53.5, 14.6, 25.4),
    (35.0, 47.6, -8.7, 1.9),
    (-59.2, -45.6, -21.5, -11.0),
    (-78.9, -60.4, -32.4, -21.8),
]
# 0.34 m border matches the measured neighbouring safety borders (blast zone, elevators,
# 25-33 cm)
JBD_LW, JBD_DASH = 0.34, 1.55
def jbd_frame(c):
    # (centre, along-track unit, starboard unit, width, depth) of a catapult's deflector box
    d = c['deflector']
    u, w2 = catapult_axes(c)
    return np.array([d['x'], d['z']]), u, w2, d['width'], d['depth']
JBD_FRAMES = [jbd_frame(c) for c in SHIP['catapults']]
def jbd_zone(f, l, margin=0.55):
    # Inside a JBD rectangle (+margin). Authored SAT paint dies here: besides stray
    # dashes, this terminates the authored cat-1 blast-zone border cleanly at the box —
    # that rectangle sits ~10 m from its plan position, so its port edge crosses the plan
    # JBD box at a shallow angle, and deck features do not overpaint each other.
    for c, u, w2, bw, bd in JBD_FRAMES:
        df, dl = f-c[0], l-c[1]
        if abs(df*u[0]+dl*u[1]) < bd/2+margin and abs(df*w2[0]+dl*w2[1]) < bw/2+margin:
            return True
    return False
# grey-frame mono kill boxes, not the JBD regions: the landing-area edge stripes
# are triangle fans whose apex tris land inside cat 3's region with the same
# material and lum, so cat 3 kills only two narrow fa slices over the frame's
# end lines (fa -54.1 / -46.6).
MONO_KILL = [
    (36.4, 53.5, 14.6, 25.4),
    (35.0, 47.6, -8.7, 1.9),
    (-59.2, -45.6, -21.5, -11.0),
    (-78.9, -60.4, -31.3, -21.8),   # lat0 -31.3, NOT the ensemble's -32.4: the angled-deck edge stripe runs at -31.7 through this fa range
]
# Landing-area boundary lines: four lines parallel to the landing centreline (fa
# -147..+37). The authored versions are triangle fans every kill rule nicks, so
# authored marks near them are suppressed and the lines drawn continuously,
# before tracks and rubber so cats and wires paint over them.
(LINE_F, LINE_A), (LINE_F2, LINE_A2) = SHIP['landing']['line']
def landing_centre(f):
    # z of the landing centreline at fore-aft f
    return LINE_A+(f-LINE_F)*(LINE_A2-LINE_A)/(LINE_F2-LINE_F)
LANDING_LINES = [-11.42, -9.06, 9.28, 11.75]
LANDING_SPAN = (-147.0, 36.8)
def near_landing_line(f, l):
    if not (LANDING_SPAN[0]-1 < f < LANDING_SPAN[1]+1): return False
    o = l-landing_centre(f)
    return any(abs(o-c) < 0.9 for c in LANDING_LINES)
# neutral model marks inside a corridor are owned by the drawn strip
def in_corridor(f, l):
    for s, e, ln, _ in TRACKS:
        if s-1.5 < f < e+1.5 and abs(l-ln(f)) < 0.9: return True
    return False
EXCLUDE_SAT = [(78.0, 88.5, 4.0*S_LAT, 11.5*S_LAT)]   # ammo-elevator dash box: authored, but wrong for this deck
# The original model's bow cab: its walls and roof (material_38, 0.67-1.17 m) bake as an
# octagon outline at a spot where no cab stands any more (cabs.py). The dashed lines between
# cats 1 and 2 cross the same box as deck paint (material_3), so only the cab's material goes.
OLD_CAB = (64.5, 73.0, 4.5*S_LAT, 11.5*S_LAT)
OLD_CAB_MATERIAL = 'material_38'
# Grey mono paint within EDGE_KILL of the rim is phantom: below-lip catwalk and
# sponson plates bake flat onto the deck as fans hugging the edge. Edge safety
# dashes are near-white (lum 0.976) and survive; the bow "68" numerals share the
# phantom plates' grey and reach within 1-2 m of both edges, hence the exemption
# box.
EDGE_KILL = 4.5            # grey mono mark death zone, metres inboard of the outline
NUMERALS = (118.0, 162.0, -11.0, 15.0)
_SEG1 = POLY; _SEG2 = np.roll(POLY, -1, axis=0)
_SEGD = _SEG2-_SEG1; _SEGL = (_SEGD**2).sum(1)+1e-12
def edge_distance(f, l):
    p = np.array([f, l])
    t = np.clip(((p-_SEG1)*_SEGD).sum(1)/_SEGL, 0, 1)
    q = _SEG1+t[:, None]*_SEGD
    return np.sqrt(((p-q)**2).sum(1).min())

def U(fa):  return (fa-FA0)/(FA1-FA0)*W
def V(lat): return (lat-LA0)/(LA1-LA0)*H

rng = np.random.default_rng(11)
def value_noise(h, w, cells, amp):
    g = rng.normal(0, 1, (cells+1, int(cells*w/h)+1))
    gy = np.linspace(0, g.shape[0]-1-1e-6, h); gx = np.linspace(0, g.shape[1]-1-1e-6, w)
    y0 = gy.astype(int); x0 = gx.astype(int)
    fy = (gy-y0)[:,None]; fx = (gx-x0)[None,:]
    a = g[y0][:,x0]; b = g[y0][:,x0+1]; c = g[y0+1][:,x0]; d = g[y0+1][:,x0+1]
    return ((a*(1-fx)+b*fx)*(1-fy) + (c*(1-fx)+d*fx)*fy) * amp

print("base...")
base = np.zeros((H, W), np.float64) + 0.0
for cells, amp in ((24, 12.0), (96, 7.0), (384, 3.5)):
    base += value_noise(H, W, cells, amp)
img = np.zeros((H, W, 3), np.float64)
img[:,:,0] = 96 + base; img[:,:,1] = 98 + base; img[:,:,2] = 94 + base
# plate seams: 12 m fore-aft, 6 m lateral
for f in np.arange(FA0, FA1, 12.0):
    u = int(U(f)); img[:, u:u+1] -= 10
for l in np.arange(LA0, LA1, 6.0):
    v = int(V(l)); img[v:v+1, :] -= 10
# low-frequency grunge (multiplicative)
img *= (1.0 + value_noise(H, W, 10, 0.045))[:,:,None]

print("model paint...")
data = open(ORIG, 'rb').read()
clen, _ = struct.unpack('<II', data[12:20])
G = json.loads(data[20:20+clen]); boff = 20+clen
blen, _ = struct.unpack('<II', data[boff:boff+8])
B = data[boff+8:boff+8+blen]
acc = G['accessors']; bvs = G['bufferViews']; nodes = G['nodes']; mats = G['materials']
def readA(ai):
    a = acc[ai]; bv = bvs[a['bufferView']]
    comps = {'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4}[a['type']]
    dt = {5126:np.float32,5125:np.uint32,5123:np.uint16,5121:np.uint8,5120:np.int8}[a['componentType']]
    isz = np.dtype(dt).itemsize
    off = bv.get('byteOffset',0)+a.get('byteOffset',0)
    stride = bv.get('byteStride', comps*isz)
    if stride != comps*isz:
        raw = np.frombuffer(B, np.uint8, a['count']*stride, off).reshape(a['count'], stride)
        return np.ascontiguousarray(raw[:,:comps*isz]).view(dt).reshape(a['count'], comps)
    return np.frombuffer(B, dt, a['count']*comps, off).reshape(a['count'], comps)
def trs(n):
    m = np.eye(4)
    if 'matrix' in n: return np.array(n['matrix']).reshape(4,4).T
    if 'translation' in n: m[:3,3] = n['translation']
    if 'rotation' in n:
        x,y,z,w = n['rotation']
        m[:3,:3] = np.array([[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],[2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],[2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]])
    if 'scale' in n: m[:3,:3] = m[:3,:3]@np.diag(n['scale'])
    return m
world = {}
def walk(i, P):
    Wm = P@trs(nodes[i]); world[i] = Wm
    for c in nodes[i].get('children', []): walk(c, Wm)
for r in G['scenes'][G.get('scene',0)]['nodes']: walk(r, np.eye(4))

marks = []   # (h, convex polygon in (fa, lat), anticlockwise or clockwise [nx2], colour): mostly triangles
old_cab = 0
for ni, n in enumerate(nodes):
    if 'mesh' not in n: continue
    for p in G['meshes'][n['mesh']]['primitives']:
        mi = p.get('material', -1)
        if mi < 0: continue
        m = mats[mi]
        if m.get('name') == 'material_37': continue   # raft canister shells: 3D hardware on the fascia, never deck paint — their up-facing tops baked as white ghost dashes along the deck edge
        if m.get('alphaMode') == 'BLEND': continue
        col = m.get('pbrMetallicRoughness', {}).get('baseColorFactor')
        if col is None: continue
        c3 = np.array(col[:3])
        if c3.max() < 0.16: continue                    # black paint never bakes
        v = readA(p['attributes']['POSITION']).astype(np.float64)
        w = (world[ni][:3,:3]@v.T).T + world[ni][:3,3]
        if 'indices' in p: idx = readA(p['indices']).ravel().astype(np.int64)
        else: idx = np.arange(len(w), dtype=np.int64)
        idx = idx[:len(idx)//3*3]
        t = w[idx].reshape(-1,3,3)
        fa = (t[:,:,0]-CX)*S; la = (t[:,:,2]-CZ)*S*S_LAT; hh = (t[:,:,1]-DECKY)*S   # marks read the UNSQUASHED original; scale lat to the squashed deck
        cf = fa.mean(1); cl = la.mean(1); ch = hh.mean(1)
        e1 = t[:,1]-t[:,0]; e2 = t[:,2]-t[:,0]
        fn = np.cross(e1, e2); nl = np.linalg.norm(fn, axis=1)+1e-12
        ny = np.abs(fn[:,1]/nl)
        band = (ny > 0.6) & (ch > -1.3) & (ch < 1.6)
        sat = (c3.max()-c3.min()) > 0.12
        lum = c3.mean()
        for i2 in np.where(band)[0]:
            f2, l2 = cf[i2], cl[i2]
            if not inpoly(f2, l2): continue
            if m.get('name') == OLD_CAB_MATERIAL and OLD_CAB[0] < f2 < OLD_CAB[1] and OLD_CAB[2] < l2 < OLD_CAB[3]:
                old_cab += 1; continue
            if sat:
                if any(a<f2<b and c<l2<d for a,b,c,d in EXCLUDE_SAT): continue
            else:
                if lum <= 0.45: continue                # mono mid/dark grey: the deck owns it
                if in_corridor(f2, l2): continue        # the drawn strip owns the track lines
                if superseded(f2, l2): continue         # the OLD cat-1/4 painted pairs (tracks moved to the plan lines)
                # thin-line test in metres
                a3 = np.stack([fa[i2], la[i2]], 1)
                ee = np.array([np.linalg.norm(a3[1]-a3[0]), np.linalg.norm(a3[2]-a3[1]), np.linalg.norm(a3[0]-a3[2])])
                d1 = a3[1]-a3[0]; d2v = a3[2]-a3[0]
                area = abs(d1[0]*d2v[1]-d1[1]*d2v[0])/2
                if ee.max() > 1e-9 and 2*area/ee.max() >= 1.0: continue   # wide pale plate: skip
                if lum <= 0.60 and not (NUMERALS[0] < f2 < NUMERALS[1] and NUMERALS[2] < l2 < NUMERALS[3]) \
                        and edge_distance(f2, l2) < EDGE_KILL: continue   # phantom rim-structure grey — the catwalk/sponson plates are lum 0.523. Painted LINES near the edge are lum 0.659 (the angled-deck edge stripe runs 2.5-4.5 m from the outline for its whole length — a <=0.85 kill severed it, v55..v59) or 0.976 white (edge dashes): both must survive. The 68 numerals use BOTH greys, hence the box exemption stays.
            tri = np.stack([fa[i2], la[i2]], 1)
            if sat and (any(e[0] < f2 < e[1] and e[2] < l2 < e[3] for e in JBD) or jbd_zone(f2, l2)):
                continue   # authored JBD dashes + anything crossing the plan rectangles: killed at the source; the borders are DRAWN below (uniform width — the authored dashes were half the width of the neighbouring safety borders)
            elif lum <= 0.85 and any(b[0] < f2 < b[1] and b[2] < l2 < b[3] for b in MONO_KILL):
                continue   # the grey frames
            if not sat and 0.60 < lum <= 0.85 and near_landing_line(f2, l2):
                continue   # authored boundary-line fragments: replaced by the drawn lines
            marks.append((ch[i2], tri, (c3*255)))
# analytic JBD borders: 0.34 m red/yellow dashes on the exact plan rectangles
# the engine's animated panels fill (the authored dashes were half the width of
# the neighbouring safety borders). Appended as mark tris at ch +10 so they
# rasterise last through the same anti-aliased pipeline.
JBD_RED = np.array([0.58, 0.0, 0.01])*255; JBD_YEL = np.array([0.97, 0.86, 0.02])*255
def dashed_loop(corners, width, dash, h):
    # red/yellow dashes of this width centred on the closed polyline through corners
    s = 0.0
    for k in range(len(corners)):
        a, b = corners[k], corners[(k+1) % len(corners)]
        seg = b-a; seglen = np.linalg.norm(seg); sd = seg/seglen
        nn = np.array([-sd[1], sd[0]])*width/2
        # walk dash boundaries by integer dash index, continuous around the loop
        # - a float-remainder walk stalls when the remainder lands at ~dash
        # and appends zero-length tris without bound
        for i in range(int(math.floor(s/dash)), int(math.floor((s+seglen)/dash))+1):
            t0 = max(i*dash-s, 0.0); t1 = min((i+1)*dash-s, seglen)
            if t1 <= t0: continue
            col = JBD_RED if i % 2 == 0 else JBD_YEL
            p0, p1 = a+sd*t0, a+sd*t1
            marks.append((h, np.stack([p0+nn, p1+nn, p1-nn]), col))
            marks.append((h, np.stack([p0+nn, p1-nn, p0-nn]), col))
        s += seglen
for c, u, w2, bw, bd in JBD_FRAMES:
    dashed_loop([c+u*bd/2+w2*bw/2, c-u*bd/2+w2*bw/2, c-u*bd/2-w2*bw/2, c+u*bd/2-w2*bw/2], JBD_LW, JBD_DASH, 10.0)
# catapult control cabs: each stands on a smooth steel plate, lighter than the non-skid, with a
# red/yellow dashed border round its outer edge (Navy photographs); painted over everything
# beneath, as the plate replaces the deck there
PLATE_GREY = np.array([150.0, 152.0, 153.0])
for cab in CABS:
    marks.append((10.5, footprint(cab, PLATE), PLATE_GREY))   # one convex polygon: a fan of triangles leaves anti-aliased seams
    dashed_loop(footprint(cab, PLATE-BORDER/2), BORDER, DASH, 11.0)
print(f"  old bow cab: {old_cab} tops skipped")
print(f"  {len(marks)} paint tris")
marks.sort(key=lambda x: x[0])
SS = 3   # 3x3 coverage per texel: edge steps of 1/3 texel read smooth at deck view distances
CHUNK = 256   # texel rows per raster stripe: temporaries stay ~CHUNK*W*SS^2 floats however
              # large the triangle (a deck-spanning mark's whole-bbox meshgrid was a multi-GB
              # spike). Stripes align to texel rows, so every subsample and coverage mean is
              # computed exactly as before — output identical.
for _, tri, col in marks:
    up = U(tri[:,0]); vp = V(tri[:,1])
    x0, x1 = max(int(up.min()),0), min(int(np.ceil(up.max()))+1, W)
    yb0, yb1 = max(int(vp.min()),0), min(int(np.ceil(vp.max()))+1, H)
    if x1<=x0 or yb1<=yb0: continue
    det = (up[1]-up[0])*(vp[2]-vp[0]) - (vp[1]-vp[0])*(up[2]-up[0])
    if abs(det) < 1e-9: continue
    sgn = 1.0 if det > 0 else -1.0
    for y0 in range(yb0, yb1, CHUNK):
        y1 = min(y0+CHUNK, yb1)
        gx, gy = np.meshgrid(x0+(np.arange((x1-x0)*SS)+0.5)/SS, y0+(np.arange((y1-y0)*SS)+0.5)/SS)
        inside = np.ones(gx.shape, bool)
        for k in range(len(up)):
            ax, ay = up[k], vp[k]; bx, by = up[(k+1)%len(up)], vp[(k+1)%len(up)]
            e = (gx-ax)*(by-ay) - (gy-ay)*(bx-ax)
            inside &= (e*sgn <= 0.01)
        if not inside.any(): continue
        cov = inside.reshape(y1-y0, SS, x1-x0, SS).mean(axis=(1,3))
        img[y0:y1, x0:x1] = img[y0:y1, x0:x1]*(1-cov)[:,:,None] + col[None,None,:]*cov[:,:,None]

print("landing boundary lines...")
_rowlat = (np.arange(H)+0.5)/H*(LA1-LA0)+LA0
_pxm = (LA1-LA0)/H
for _c in LANDING_LINES:
    for u in range(int(U(LANDING_SPAN[0])), int(U(LANDING_SPAN[1]))+1):
        f = (u+0.5)/W*(FA1-FA0)+FA0
        lc = landing_centre(f)+_c
        if not inpoly(f, lc): continue
        v0 = max(0, int(V(lc-0.5))); v1 = min(H, int(V(lc+0.5))+1)
        d = np.abs(_rowlat[v0:v1]-lc)
        cov = np.clip((0.18-d)/_pxm+0.5, 0, 1)
        img[v0:v1, u] = img[v0:v1, u]*(1-cov)[:, None] + np.array([164.0, 164.0, 164.0])[None, :]*cov[:, None]

print("tracks...")
def noise1d(n, cells, amp):
    g = rng.normal(0, 1, cells+1)
    x = np.linspace(0, cells-1e-6, n); x0 = x.astype(int); fx = x-x0
    return (g[x0]*(1-fx)+g[x0+1]*fx)*amp
steelnoise = noise1d(W, 230, 2.5) + noise1d(W, 900, 1.2)   # ~1.5 m + ~0.4 m cells
rowlat = (np.arange(H)+0.5)/H*(LA1-LA0)+LA0
PXM = (LA1-LA0)/H   # metres per texel row
for start, end, line, stain in TRACKS:
    for u in range(int(U(start)), int(U(end))+1):
        fa = (u+0.5)/W*(FA1-FA0)+FA0
        lc = line(fa)
        v0 = max(0, int(V(lc-1.0))); v1 = min(H, int(V(lc+1.0))+1)
        d = np.abs(rowlat[v0:v1]-lc)
        cov = np.clip((0.70-d)/PXM+0.5, 0, 1)
        col = np.clip(np.array([129,132,135])+steelnoise[u], 112, 152)
        img[v0:v1, u] = img[v0:v1, u]*(1-cov)[:,None] + col[None,:]*cov[:,None]
        covs = np.clip((0.06-d)/PXM+0.5, 0, 1)
        img[v0:v1, u] = img[v0:v1, u]*(1-covs)[:,None] + np.array([38,39,40])[None,:]*covs[:,None]

print("rubber...")
vv = np.arange(H)
for u in range(W):
    fa = u/W*(FA1-FA0)+FA0
    # landing strip band
    if -112 < fa < 12:
        lc = landing_centre(fa)
        d2 = (vv - V(lc))/ (5.0*H/(LA1-LA0))
        img[:, u, 0] -= 26*np.exp(-0.5*d2*d2); img[:, u, 1] -= 26*np.exp(-0.5*d2*d2); img[:, u, 2] -= 24*np.exp(-0.5*d2*d2)
    # cat start streaks
    for s, e, line, stain in TRACKS:
        if s-2 < fa < s+55:
            fade = max(0.0, 1.0-(fa-s)/55.0)
            lc = line(fa)
            d2 = (vv - V(lc))/(1.8*H/(LA1-LA0))
            g = stain*fade*np.exp(-0.5*d2*d2)
            img[:, u, 0] -= g; img[:, u, 1] -= g; img[:, u, 2] -= g

Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).save('decktex12.png')
import os
print("decktex12.png", os.path.getsize('decktex12.png'))
for s, e, ln, _ in TRACKS:
    print(f"  track {s:7.1f} .. {e:6.1f}  (edge exit)")
