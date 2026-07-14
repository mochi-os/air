#!/usr/bin/env python3
"""Canonical air Nimitz deck-texture bake — FROM THE ORIGINAL MODEL.

Layers, in order:
  1. weathered non-skid base (value noise + plate seams + grunge)
  2. ANALYTIC landing-area boundary lines (four lines parallel to the landing
     centreline, drawn BEFORE tracks/rubber so cats and wires overlay them - real deck
     layering; authored fragments near a line are suppressed in the mark pass)
  3. the ORIGINAL model's up-facing paint, classified:
       - near-black paint            -> never painted
       - saturated colour markings   -> painted fully (except exclusion zones; the JBD
         borders are killed at the authored spots and DRAWN at the plan rectangles, uniform width)
       - neutral thin lines (<1.0 m) -> painted fully (centreline dashes, foul lines, outlines)
       - neutral wide plates         -> skipped (lids, walkway wedges, ICCS ghost class)
       - neutral marks inside a catapult track corridor -> skipped (the strip owns them)
       - material_37 (life-raft canister shells) -> never painted (their tops sat close
         enough to deck height to bake as white ghost dashes along the edge)
       - EDGE_KILL: grey mono marks (lum<=0.60) within 4.5 m of the outline die (phantom
         catwalk-plate bakes); painted lines and whites survive; the bow "68" numerals
         are exempted by box (same grey as the phantom plates)
  4. catapult tracks: bare-steel strip 1.4 m + near-black slot 0.12 m, from just aft of each
     shuttle position to the exact deck-outline exit (the real track runs to the round-down);
     the cat 1 and cat 4 lines are PLAN-derived (Stage C), not the model's misplaced paint
  5. rubber: landing-strip band + catapult start streaks

After ANY mark-rule change, run the lost-bright-pixel diff against the previous texture,
clustered by fa bin - per-spot brightness probes miss systemic damage (three separate
rules ate the landing-area edge stripes across v55-v59 before that diff found them all).
The lum split that discriminates: phantom catwalk plates 0.523, painted lines 0.659,
whites 0.976.

All markings are drawn anti-aliased (3x3 coverage for model paint, analytic lateral
coverage for the tracks) - hard texel edges read as staircases on every diagonal line
at 4.2 cm/texel. Track steel noise is smooth 1D (per-column noise reads as striations).

Output: decktex12.png (8192x2400, fa -172..172, lat -52..48)
"""
import json, math, struct, sys
import resource
import numpy as np
from PIL import Image

# Hard memory cap: fail with a clean MemoryError rather than drive the kernel OOM
# killer into the desktop session (2026-07-13: a stalled float-remainder dash walk
# appended zero-length tris to 18.6 GB and the kernel reaped unrelated processes;
# this cap turned the same bug into a one-line traceback). A healthy bake fits in
# well under 4 GB; a MemoryError here means a new unbounded allocation, not a
# too-small cap.
resource.setrlimit(resource.RLIMIT_AS, (8 << 30, 8 << 30))

ORIG = '/home/alistair/mochi/apps/air/downloads/uss_nimitz_cvn-68_aircraft_carrier.glb'
W, H = 8192, 2400
FA0, FA1, LA0, LA1 = -172.0, 172.0, -52.0, 48.0
S = 0.025; CX, CZ = 6361.3, -469.3; DECKY = 776.0

OUT = [[-166,4.2],[-158,31.2]]   # placeholder; outline.json (from build_carrier) overrides
import os as _os, json as _json
if _os.path.exists('outline.json'):
    OUT=_json.load(open('outline.json'))['OUT']
    print(f"using traced outline ({len(OUT)} pts)")
POLY = np.array(OUT, np.float64)
PX_, PY_ = POLY[:,0], POLY[:,1]
PX2, PY2 = np.roll(PX_,-1), np.roll(PY_,-1)

def inpoly(f, l):
    cross = (PY_>l) != (PY2>l)
    with np.errstate(divide='ignore', invalid='ignore'):
        xi = PX_ + (l-PY_)*(PX2-PX_)/np.where((PY2-PY_)!=0, (PY2-PY_), 1)
    return (np.sum(cross & (f<xi)) % 2) == 1

# Stage B: the model is laterally squashed to the real 76.8 m beam in build_carrier
# (S_LAT below); every lat this bake paints must follow (tracks, marks, exclusions, rubber)
S_LAT = 76.8/80.0
# catapult centrelines (pre-squash frame — outputs scaled) + shuttle starts.
# Cats 2/3 are the model-paint exact fits (the 1:200 plan agrees within noise).
# Cats 1/4 are PLAN-derived (Stage C, 2026-07-10): the model's painted cat-1 track was
# 3.9 m starboard with +2.4° excess heading (its line lies on no plan feature, ridge
# coverage 0.22 vs 0.95 on the plan track, which starts at fa 45 as a slot should);
# cat-4 paint was 0.93 m starboard (plan line -27.75 post-squash, coverage 0.99 aft).
CATS = [
    (48.5,  lambda f: (16.15-0.0601*(f-48.98))*S_LAT, 12),
    (46.8,  lambda f: (-3.58+0*f)*S_LAT,              12),
    (-47.0, lambda f: (-17.79-0.0739*(f+46.61))*S_LAT,10),
    (-67.0, lambda f: (-28.91+0*f)*S_LAT,             10),
]
def track_end(start, line):
    f = start
    while f < 170.0:
        if not inpoly(f+0.1, line(f+0.1)): return f
        f += 0.1
    return f
TRACKS = [(s, track_end(s, ln), ln, st) for s, ln, st in CATS]
# superseded model paint (cats 1/4 moved to the plan lines): the model's own painted
# track pairs still lie on the OLD lines — keep killing them exactly where the old
# corridor did.
OLD = [
    (36.0, 166.0, lambda f: (20.22-0.1034*(f-48.98))*S_LAT),
    (-67.0, 73.0,  lambda f: (-27.94+0*f)*S_LAT),
]
def superseded(f, l): return any(a < f < b and abs(l-ln(f)) < 0.9 for a, b, ln in OLD)
# JBD relocation (v56) + analytic borders (2026-07-13): the model authored each cat's
# red/yellow dashed JBD box ~8-10 m aft of the shuttle spot — under the parked jet's
# rear fuselage, where a deflector could never rise — plus a grey "frame" between box
# and spot that exists on no reference. The 1:200 plan draws the JBDs as hatched bars
# 18-24 m aft of the spots, centred on each track. Per cat: SAT marks in the ensemble
# region (the authored dashed box) are KILLED (they were rigid-transplanted until the
# authored dashes proved half the width of every neighbouring safety border) and the
# border is DRAWN at the plan rectangle instead, uniform width, same rectangle the
# engine's animated panel fills; GREY mono marks there (the frame — lum<=0.85 spares
# the near-white landing-area stripes crossing at the waist) are killed. The big
# blast-zone rectangle aft of cat 1 (fa ~13..37, down to the deck edge) stays as
# authored — its bottom hugs the deck edge, which did not move — except where it
# crosses a plan JBD rectangle (jbd_zone kill below).
#     region fa0,fa1,lat0,lat1      box centre       target centre
JBD = [
    (36.4, 53.5, 14.6, 25.4,     39.35, 20.47,    27.2, 16.76),
    (35.0, 47.6, -8.7, 1.9,      37.5, -3.40,     23.5, -3.44),
    (-59.2, -45.6, -21.5, -11.0, -56.3, -17.06,   -68.7, -15.52),
    (-78.9, -60.4, -32.4, -21.8, -76.25, -26.79,  -84.5, -27.75),
]
# plan-rectangle geometry, shared by the kill pass and the border drawing at the end:
# 0.34 m border matches the measured neighbouring safety borders (blast zone, elevators,
# 25-33 cm); the rectangle is the one the engine's animated panel fills.
JBD_BW, JBD_BD, JBD_LW, JBD_DASH = 9.65, 4.4, 0.34, 1.55
JBD_M = [-0.0601*S_LAT, 0.0, -0.0705*S_LAT, 0.0]   # track slope d(lat)/d(fa) per cat (post-squash)
def jbd_zone(f, l, margin=0.55):
    # Inside a plan JBD rectangle (+margin). Authored SAT paint dies here: besides stray
    # dashes, this terminates the authored cat-1 blast-zone border cleanly at the box —
    # that rectangle sits ~10 m from its plan position, so its port edge crosses the plan
    # JBD box at a shallow angle, and deck features do not overpaint each other.
    for e, m in zip(JBD, JBD_M):
        tf, tl = e[6], e[7]
        nl = math.hypot(1.0, m)
        ux, uy = 1.0/nl, m/nl
        df, dl = f-tf, l-tl
        if abs(df*ux+dl*uy) < JBD_BD/2+margin and abs(-df*uy+dl*ux) < JBD_BW/2+margin:
            return True
    return False
# grey-frame mono kill boxes. NOT the same as the JBD regions: the landing-area edge
# stripes are drawn as triangle FANS whose short apex tris land inside cat 3's region
# (same material and lum as the frame — position is the only discriminator), so cat 3
# kills only two narrow fa slices covering the frame's end lines at fa -54.1 / -46.6.
# The frame's long sides there survive; they hug the stripes and read as part of them.
MONO_KILL = [
    (36.4, 53.5, 14.6, 25.4),
    (35.0, 47.6, -8.7, 1.9),
    (-59.2, -45.6, -21.5, -11.0),
    (-78.9, -60.4, -31.3, -21.8),   # lat0 -31.3, NOT the ensemble's -32.4: the angled-deck edge stripe runs at -31.7 through this fa range
]
# Landing-area boundary lines (v61): four straight lines parallel to the landing
# centreline (fitted from the v52 bake: offsets/colour below, fa -147..+37). The
# authored versions are triangle fans that every kill rule keeps nicking (corridor,
# frames, edge) — so the authored marks near them are SUPPRESSED and the lines are
# DRAWN continuously instead, before the tracks and rubber so cats and wires paint
# over them (paint layering, as on the real deck).
LINE_A, LINE_S, LINE_F = 1.92, 0.15171, -115.6
LANDING_LINES = [-11.42, -9.06, 9.28, 11.75]
LANDING_SPAN = (-147.0, 36.8)
def near_landing_line(f, l):
    if not (LANDING_SPAN[0]-1 < f < LANDING_SPAN[1]+1): return False
    o = l-(LINE_A-LINE_S*(f-LINE_F))
    return any(abs(o-c) < 0.9 for c in LANDING_LINES)
# neutral model marks inside a corridor are owned by the drawn strip
def in_corridor(f, l):
    for s, e, ln, _ in TRACKS:
        if s-1.5 < f < e+1.5 and abs(l-ln(f)) < 0.9: return True
    return False
EXCLUDE_SAT = [(78.0, 88.5, 4.0*S_LAT, 11.5*S_LAT)]   # ammo-elevator dash box: authored, but wrong for this deck
# Structure-grey near the rim is PHANTOM paint: the model's below-lip catwalk and
# sponson plates (up-facing, pale grey, ch +0.2..0.6 — inside the mark band) bake
# flat onto the deck as triangle-fan wedges hugging the edge (the port-margin
# "strange triangles", 2026-07-10; same fans ring the whole rim). No legitimate
# GREY paint lives that close to the edge — the edge safety dashes are near-white
# (lum 0.976) and stay; the bow "68" numerals are the SAME grey material as the
# phantom plates (lum 0.523/0.659) and reach within ~1-2 m of both edges, hence
# the exemption box.
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

marks = []   # (h, tri_fa_lat[3x2], colour)
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
# analytic JBD borders (2026-07-13): the authored dashes measured 17-21 cm wide vs the
# 25-33 cm of the neighbouring safety borders (blast zone, elevators) — deck safety
# stripes are a uniform width on the real ship. Drawn as 0.34 m red/yellow dashes on
# the exact plan rectangles the engine's animated panels fill, so paint and geometry
# stay concentric by construction. Appended as mark tris at ch +10 so they rasterise
# last through the same anti-aliased pipeline.
JBD_RED = np.array([0.58, 0.0, 0.01])*255; JBD_YEL = np.array([0.97, 0.86, 0.02])*255
for e, m in zip(JBD, JBD_M):
    tf, tl = e[6], e[7]
    u = np.array([1.0, m]); u /= np.linalg.norm(u)
    w2 = np.array([-u[1], u[0]])
    corners = [np.array([tf, tl])+u*JBD_BD/2+w2*JBD_BW/2, np.array([tf, tl])-u*JBD_BD/2+w2*JBD_BW/2,
               np.array([tf, tl])-u*JBD_BD/2-w2*JBD_BW/2, np.array([tf, tl])+u*JBD_BD/2-w2*JBD_BW/2]
    s = 0.0
    for k in range(4):
        a, b = corners[k], corners[(k+1) % 4]
        seg = b-a; seglen = np.linalg.norm(seg); sd = seg/seglen
        nn = np.array([-sd[1], sd[0]])*JBD_LW/2
        # dash boundaries continuous around the loop, walked by INTEGER dash index —
        # the float-remainder walk this replaces stalled when the remainder landed at
        # ~JBD_DASH (step 2e-16), appending zero-length tris until the kernel OOM
        # killer took out the desktop session (2026-07-13)
        for i in range(int(math.floor(s/JBD_DASH)), int(math.floor((s+seglen)/JBD_DASH))+1):
            t0 = max(i*JBD_DASH-s, 0.0); t1 = min((i+1)*JBD_DASH-s, seglen)
            if t1 <= t0: continue
            col = JBD_RED if i % 2 == 0 else JBD_YEL
            p0, p1 = a+sd*t0, a+sd*t1
            marks.append((10.0, np.stack([p0+nn, p1+nn, p1-nn]), col))
            marks.append((10.0, np.stack([p0+nn, p1-nn, p0-nn]), col))
        s += seglen
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
        for k in range(3):
            ax, ay = up[k], vp[k]; bx, by = up[(k+1)%3], vp[(k+1)%3]
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
        lc = (LINE_A-LINE_S*(f-LINE_F))+_c
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
        lc = (-16.27 - 0.1583*fa)*S_LAT
        d2 = (vv - V(lc))/ (5.0*H/100.0)
        img[:, u, 0] -= 26*np.exp(-0.5*d2*d2); img[:, u, 1] -= 26*np.exp(-0.5*d2*d2); img[:, u, 2] -= 24*np.exp(-0.5*d2*d2)
    # cat start streaks
    for s, e, line, stain in TRACKS:
        if s-2 < fa < s+55:
            fade = max(0.0, 1.0-(fa-s)/55.0)
            lc = line(fa)
            d2 = (vv - V(lc))/(1.8*H/100.0)
            g = stain*fade*np.exp(-0.5*d2*d2)
            img[:, u, 0] -= g; img[:, u, 1] -= g; img[:, u, 2] -= g

Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).save('decktex12.png')
import os
print("decktex12.png", os.path.getsize('decktex12.png'))
for s, e, ln, _ in TRACKS:
    print(f"  track {s:7.1f} .. {e:6.1f}  (edge exit)")
