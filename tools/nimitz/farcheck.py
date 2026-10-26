#!/usr/bin/env python3
"""Check the Nimitz's distant model against the full one it stands in for (far.py): the same place and
extent in the model's own frame, every material it uses carried over by name, no deck parts (the full
model keeps drawing those), no images, and within the triangle budget. Exits non-zero on a failure.
Usage: farcheck.py [far.glb] [full.glb]   (defaults: the packed web/src/assets/nimitz-far.glb against
nimitz-clean.glb; the packed file is meshopt-compressed, so the check reads the unpacked
nimitz-far.glb when given it)"""
import json, struct, sys
from pathlib import Path
import numpy as np

KEEP = {'deck_baked', 'deck_underside', 'deck_skirt'}
BUDGET = 52000
SHRINK, GROW = 4.0, 0.2   # metres a bounding-box face may move in (collapsing shaves open edges and thin
                          # extremities) or out
NEAR, ON = 0.5, 0.99      # this share of the far model's vertices must lie within NEAR metres of the full one's
S = 0.025


def load(path):
    d = Path(path).read_bytes(); cl = struct.unpack('<I', d[12:16])[0]
    G = json.loads(d[20:20 + cl]); b = d[20 + cl + 8:]
    return G, b


def trs(n):
    if 'matrix' in n: return np.array(n['matrix'], float).reshape(4, 4).T
    M = np.eye(4); t = n.get('translation', [0, 0, 0]); r = n.get('rotation', [0, 0, 0, 1]); s = n.get('scale', [1, 1, 1]); x, y, z, w = r
    R = np.array([[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)], [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)], [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]])
    M[:3, :3] = R * np.array(s)[None, :]; M[:3, 3] = t; return M


def meshes(G, b, skip=frozenset()):
    """(name, world-space vertices, triangles, material names) per mesh node"""
    CT = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}; NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}
    def rd(ai):
        a = G['accessors'][ai]; bv = G['bufferViews'][a['bufferView']]
        return np.frombuffer(b, dtype=CT[a['componentType']], count=a['count'] * NC[a['type']], offset=bv.get('byteOffset', 0) + a.get('byteOffset', 0)).reshape(a['count'], -1)
    W = {}
    def walk(i, P):
        W[i] = P @ trs(G['nodes'][i])
        for c in G['nodes'][i].get('children', []): walk(c, W[i])
    for r in G['scenes'][G.get('scene', 0)]['nodes']: walk(r, np.eye(4))
    out = []
    for i, n in enumerate(G['nodes']):
        if 'mesh' not in n or (n.get('name') in skip): continue
        m = G['meshes'][n['mesh']]; vs = []; tris = 0; mats = []
        for p in m['primitives']:
            v = rd(p['attributes']['POSITION']).astype(float); vs.append((W[i][:3, :3] @ v.T).T + W[i][:3, 3])
            tris += (G['accessors'][p['indices']]['count'] if 'indices' in p else len(v)) // 3
            if 'material' in p: mats.append(G['materials'][p['material']].get('name'))
        out.append((n.get('name'), np.concatenate(vs), tris, mats))
    return out


def check(far_path, full_path):
    failures = []
    G, b = load(far_path); F, fb = load(full_path)
    if 'EXT_meshopt_compression' in G.get('extensionsUsed', []):
        return ['the packed file is meshopt-compressed: check the unpacked nimitz-far.glb']
    far = meshes(G, b); full = meshes(F, fb, KEEP)
    if any(name in KEEP for name, *_ in far): failures.append('a deck part is in the far model')
    if G.get('images'): failures.append(f"{len(G['images'])} images in the far model")
    tris = sum(t for _, _, t, _ in far)
    if tris > BUDGET: failures.append(f'{tris} triangles, over the {BUDGET} budget')
    a = np.concatenate([v for _, v, _, _ in far]); c = np.concatenate([v for _, v, _, _ in full])
    grow = np.concatenate([c.min(0) - a.min(0), a.max(0) - c.max(0)]) * S   # positive where the far model reaches past
    if grow.max() > GROW: failures.append(f'reaches {grow.max():.2f} m past the full model')
    if -grow.min() > SHRINK: failures.append(f'falls {-grow.min():.2f} m short of the full model')
    # the same place: nearly every far vertex has a full vertex within NEAR (cells of NEAR, and their neighbours)
    cell = NEAR / S
    full_cells = {tuple(k) for k in np.floor(c / cell).astype(np.int64)}
    keys = np.floor(a / cell).astype(np.int64)
    steps = [(i, j, k) for i in (-1, 0, 1) for j in (-1, 0, 1) for k in (-1, 0, 1)]
    on = np.mean([any((x + i, y + j, z + k) in full_cells for i, j, k in steps) for x, y, z in keys])
    if on < ON: failures.append(f'only {on:.1%} of its vertices lie on the full model')
    used = {m for _, _, _, ms in full for m in ms}; kept = {m for _, _, _, ms in far for m in ms}
    if used - kept: failures.append(f'materials lost: {sorted(used - kept)}')
    print(f'far model: {tris} triangles in {len(far)} meshes (full: {sum(t for _, _, t, _ in full)} without the deck parts); '
          f'{on:.2%} of its vertices on the full model; extent {-grow.min():.2f} m in, {max(grow.max(), 0):.2f} m out; '
          f'{len(kept)} of {len(used)} materials')
    return failures


if __name__ == '__main__':
    far = sys.argv[1] if len(sys.argv) > 1 else 'nimitz-far.glb'
    full = sys.argv[2] if len(sys.argv) > 2 else 'nimitz-clean.glb'
    bad = check(far, full)
    for f in bad: print('FAIL', f)
    print('ALL PASS' if not bad else 'FAILED')
    sys.exit(1 if bad else 0)
