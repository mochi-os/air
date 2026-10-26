#!/usr/bin/env python3
"""Check the F/A-18C's distant models (fa18c-far.glb, from pose.ts, far.py and decimate.py) against the
jet they stand in for (pose.json, the shipped model posed as the engine draws it):
  parts     airframe, up, down, burner and far are all there, each within its triangle budget
  place     nearly every vertex lies on the posed jet (gear up for airframe, up, burner and far; gear
            down for down), and each stage spans the jet as the full model does
  colour    the stages carry the jet's colours: their area-weighted mean is the full model's
-v also draws side, top and front views of each stage and of the full jet to views.png.
Exits non-zero on a failure. Usage: farcheck.py [-v] [fa18c-far.glb] [pose.json]"""
import json, struct, sys
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent
BUDGET = {'airframe': 4300, 'up': 300, 'down': 750, 'burner': 100, 'far': 450}
NEAR, ON = 0.10, 0.97     # this share of a stage's vertices lies within NEAR metres of the posed jet
SPAN = 0.30               # metres a stage's extent may fall short of the full jet's
COLOUR = 0.08             # how far a stage's mean linear colour may stray from the full jet's


def load(path):
    d = Path(path).read_bytes(); cl = struct.unpack('<I', d[12:16])[0]
    G = json.loads(d[20:20 + cl]); b = d[20 + cl + 8:]
    CT = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}; NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}
    def rd(ai):
        a = G['accessors'][ai]; bv = G['bufferViews'][a['bufferView']]
        x = np.frombuffer(b, dtype=CT[a['componentType']], count=a['count'] * NC[a['type']], offset=bv.get('byteOffset', 0) + a.get('byteOffset', 0)).reshape(a['count'], -1).astype(np.float64)
        return x / 65535.0 if a['componentType'] == 5123 and a.get('normalized') else x
    out = {}
    for n in G['nodes']:
        if 'mesh' not in n: continue
        for k in ('translation', 'rotation', 'scale', 'matrix'):
            if k in n: raise ValueError(f"{n.get('name')} carries a node {k}: the stages must sit in the model's own frame")
        p = G['meshes'][n['mesh']]['primitives'][0]
        v = rd(p['attributes']['POSITION']); c = rd(p['attributes']['COLOR_0'])[:, :3]
        i = rd(p['indices']).astype(np.int64).reshape(-1, 3)
        out[n['name']] = (v[i], c[i])
    return out


def posed(pose, gear):
    tris, cols = [], []
    for m in pose[gear]:
        p = np.array(m['positions'], np.float64).reshape(-1, 3)
        idx = np.array(m['indices'] if m['indices'] is not None else range(len(p)), np.int64)
        tris.append(p[idx[:len(idx) // 3 * 3]].reshape(-1, 3, 3))
    return np.concatenate(tris)


def on(vertices, surface_points, cell):
    cells = {tuple(k) for k in np.floor(surface_points / cell).astype(np.int64)}
    steps = [(i, j, k) for i in (-1, 0, 1) for j in (-1, 0, 1) for k in (-1, 0, 1)]
    keys = np.floor(vertices / cell).astype(np.int64)
    return float(np.mean([any((x + i, y + j, z + k) in cells for i, j, k in steps) for x, y, z in keys]))


def surface(tris, spacing):
    # points over every triangle, no further apart than spacing
    a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
    k = np.clip(np.ceil(np.max(np.stack([np.linalg.norm(b - a, axis=1), np.linalg.norm(c - a, axis=1)]), 0) / spacing).astype(int), 1, 60)
    pts = [a, b, c]
    for n in np.unique(k):
        sel = k == n
        u, v = np.meshgrid(np.arange(n + 1) / n, np.arange(n + 1) / n); keep = (u + v) <= 1; u, v = u[keep], v[keep]
        pts.append((a[sel, None] + u[None, :, None] * (b - a)[sel, None] + v[None, :, None] * (c - a)[sel, None]).reshape(-1, 3))
    return np.concatenate(pts)


def area_mean(tris, cols):
    area = np.linalg.norm(np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]), axis=1) / 2
    return (cols.mean(1) * area[:, None]).sum(0) / max(area.sum(), 1e-9)


def check(far_path, pose_path, verbose=False):
    failures = []
    stages = load(far_path); pose = json.loads(Path(pose_path).read_text())
    up, down = posed(pose, 'up'), posed(pose, 'down')
    full = {'up': surface(up, NEAR / 2), 'down': surface(down, NEAR / 2)}
    for name, budget in BUDGET.items():
        if name not in stages: failures.append(f'{name} missing'); continue
        tris, cols = stages[name]
        if len(tris) > budget: failures.append(f'{name}: {len(tris)} triangles, over {budget}')
        share = on(tris.reshape(-1, 3), full['down' if name == 'down' else 'up'], NEAR)
        if share < ON: failures.append(f'{name}: only {share:.1%} of its vertices on the posed jet')
        print(f'{name}: {len(tris)} triangles, {share:.1%} on the posed jet')
    for name in ('airframe', 'far'):
        if name not in stages: continue
        span = np.ptp(stages[name][0].reshape(-1, 3), 0); want = np.ptp(up.reshape(-1, 3), 0)
        if (want - span).max() > SPAN: failures.append(f'{name}: spans {np.round(span, 2).tolist()} m of {np.round(want, 2).tolist()}')
    if 'airframe' in stages and 'far' in stages:
        a = area_mean(*stages['airframe']); f = area_mean(*stages['far'])
        print(f'colour: airframe {np.round(a, 3).tolist()}, far {np.round(f, 3).tolist()}')
        if np.abs(a - f).max() > COLOUR: failures.append(f'far colour {np.round(f, 3).tolist()} strays from the airframe {np.round(a, 3).tolist()}')
        if a.max() < 0.05: failures.append('airframe colours are near black')
    if verbose: views(stages, up, HERE / 'views.png')
    return failures


def views(stages, up, out):
    from PIL import Image, ImageDraw
    rows = [('full', [(up, np.full((len(up), 3, 3), 0.35))])] + [(n, [stages[n]] + ([stages['up']] if n == 'airframe' else [])) for n in ('airframe', 'far', 'down')]
    W, H, pad = 360, 240, 10
    img = Image.new('RGB', (3 * W, len(rows) * H), (40, 40, 48)); d = ImageDraw.Draw(img)
    pts = up.reshape(-1, 3); lo, hi = pts.min(0), pts.max(0); scale = (W - 2 * pad) / np.ptp(pts, 0).max()
    light = np.array([0.4, 0.8, 0.45]); light /= np.linalg.norm(light)
    for r, (label, parts) in enumerate(rows):
        for col, (ax, ay, depth) in enumerate(((2, 1, 0), (2, 0, 1), (0, 1, 2))):   # side, top, front
            tris = np.concatenate([t for t, _ in parts]); cols = np.concatenate([c for _, c in parts])
            n = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]); n /= np.linalg.norm(n, axis=1)[:, None] + 1e-12
            shade = 0.35 + 0.65 * np.abs(n @ light)
            order = np.argsort(tris[:, :, depth].mean(1))
            for i in order:
                t = tris[i]; c = np.clip(cols[i].mean(0) ** (1 / 2.2) * shade[i], 0, 1)
                xy = [(col * W + pad + (p[ax] - lo[ax]) * scale, r * H + H - pad - (p[ay] - lo[ay]) * scale) for p in t]
                d.polygon(xy, fill=tuple(int(x * 255) for x in c))
        d.text((4, r * H + 4), label, fill=(255, 255, 255))
    img.save(out); print(f'wrote {out}')


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if a != '-v']
    bad = check(args[0] if args else HERE / 'fa18c-far.glb', args[1] if len(args) > 1 else HERE / 'pose.json', '-v' in sys.argv)
    for f in bad: print('FAIL', f)
    print('ALL PASS' if not bad else 'FAILED')
    sys.exit(1 if bad else 0)
