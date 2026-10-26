#!/usr/bin/env python3
"""The F/A-18C's distant models, step two (after web/tools/pose.ts, before decimate.py): from the jet
posed as the engine draws it, gear up and gear down (pose.json), make vertex-coloured parts for the
decimator in parts.glb:
  airframe   everything that does not move with the gear, from the gear-up pose
  up, down   what moves with the gear (legs, wheels, doors), in each pose
  burner     the nozzles' glowing faces (Afterburners, Afterburner_Rings), coloured by their glow
Each corner takes its material's colour where its UV falls, from the original download's textures
(the shipped model's are KTX2, which nothing here decodes; the materials and UVs are the same), in
linear light as glTF vertex colours are. Glass reads as dark tint at range, so it is opaque here, and
the near-invisible helper materials and the decal overlays (which would z-fight once flattened into
one mesh) are left out. Faces no ray from outside can reach - the cockpit behind the closed canopy,
the engine cans - are dropped by a voxel flood from the outside, so the decimator spends nothing on
them. Usage (from this directory): far.py [pose.json] [parts.glb]"""
import io, json, math, struct, sys
from pathlib import Path
import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
ORIGINAL = HERE.parents[1] / 'downloads' / 'fa-18c_hornet-cleaned.glb'
LENGTH = 17.07             # metres, the engine's spec.length: sets the voxel size
VOXEL = 0.08               # metres
GLASS = {'Windsheild', 'Glass'}
BURNER = {'Afterburners', 'Afterburner_Rings'}
OVERLAYS = {'Decals', 'Patches'}
TINT = np.array([0.020, 0.026, 0.034])   # canopy glass seen from outside at range, linear


def linear(srgb):
    s = np.asarray(srgb, np.float64)
    return np.where(s <= 0.04045, s / 12.92, ((s + 0.055) / 1.055) ** 2.4)


def original_images():
    """material name -> (base colour image, emissive image), each an HxWx3 sRGB float array or None"""
    d = ORIGINAL.read_bytes(); cl = struct.unpack('<I', d[12:16])[0]
    G = json.loads(d[20:20 + cl]); b = d[20 + cl + 8:]
    def image(ref):
        if ref is None: return None
        im = G['images'][G['textures'][ref['index']]['source']]; bv = G['bufferViews'][im['bufferView']]
        raw = b[bv.get('byteOffset', 0):bv.get('byteOffset', 0) + bv['byteLength']]
        return np.asarray(Image.open(io.BytesIO(raw)).convert('RGB'), np.float64) / 255.0
    out, cache = {}, {}
    def load(m):
        if m['name'] not in cache:
            cache[m['name']] = (image(m.get('pbrMetallicRoughness', {}).get('baseColorTexture')), image(m.get('emissiveTexture')))
        return cache[m['name']]
    for m in G['materials']:
        out[m['name']] = (lambda m=m: load(m))
    return out


def sample(img, uv):
    # nearest texel at each UV, repeating, glTF's top-left origin
    h, w, _ = img.shape
    x = np.floor(np.mod(uv[:, 0], 1.0) * w).astype(int) % w
    y = np.floor(np.mod(uv[:, 1], 1.0) * h).astype(int) % h
    return img[y, x]


def soup(mesh):
    """triangle corners (n,3,3) and their UVs (n,3,2) or None"""
    p = np.array(mesh['positions'], np.float64).reshape(-1, 3)
    idx = np.array(mesh['indices'] if mesh['indices'] is not None else range(len(p)), np.int64)
    idx = idx[:len(idx) // 3 * 3].reshape(-1, 3)
    uv = np.array(mesh['uvs'], np.float64).reshape(-1, 2)[idx] if mesh['uvs'] else None
    return p[idx], uv


def colours(mesh, n, uv, images, glow=False):
    """linear RGB per corner (n,3,3) for a mesh's n triangles"""
    factor = np.array(mesh['factor'][:3], np.float64)
    if mesh['material'] in GLASS and not glow:
        return np.broadcast_to(TINT, (n, 3, 3)).copy()
    base, emissive = images[mesh['material']]() if mesh['material'] in images else (None, None)
    img = emissive if glow else base
    if img is None or uv is None:
        return np.broadcast_to(factor if not glow else np.ones(3), (n, 3, 3)).copy()
    s = sample(img, uv.reshape(-1, 2)).reshape(-1, 3, 3)
    return linear(s) * (1.0 if glow else factor)


def exterior(tris, voxel):
    """which triangles touch air a flood from outside the bounding box reaches"""
    lo = tris.reshape(-1, 3).min(0) - 2 * voxel
    dims = np.ceil((tris.reshape(-1, 3).max(0) + 2 * voxel - lo) / voxel).astype(int) + 1
    solid = np.zeros(dims, bool)
    owner_points, owner = [], []
    a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
    longest = np.max(np.stack([np.linalg.norm(b - a, axis=1), np.linalg.norm(c - b, axis=1), np.linalg.norm(a - c, axis=1)]), 0)
    steps = np.clip(np.ceil(longest / (voxel * 0.5)).astype(int), 1, 400)
    for k in np.unique(steps):
        sel = np.where(steps == k)[0]
        u, v = np.meshgrid(np.arange(k + 1) / k, np.arange(k + 1) / k)
        keep = (u + v) <= 1.0 + 1e-9; u, v = u[keep], v[keep]
        pts = a[sel, None] + u[None, :, None] * (b - a)[sel, None] + v[None, :, None] * (c - a)[sel, None]
        cells = np.floor((pts - lo) / voxel).astype(int)
        solid[cells[..., 0], cells[..., 1], cells[..., 2]] = True
        owner_points.append(cells.reshape(-1, 3)); owner.append(np.repeat(sel, cells.shape[1]))
    air = ~solid
    outside = np.zeros(dims, bool)
    outside[0, :, :] = outside[-1, :, :] = outside[:, 0, :] = outside[:, -1, :] = outside[:, :, 0] = outside[:, :, -1] = True
    outside &= air
    while True:
        grown = outside.copy()
        grown[1:] |= outside[:-1]; grown[:-1] |= outside[1:]
        grown[:, 1:] |= outside[:, :-1]; grown[:, :-1] |= outside[:, 1:]
        grown[:, :, 1:] |= outside[:, :, :-1]; grown[:, :, :-1] |= outside[:, :, 1:]
        grown &= air
        if grown.sum() == outside.sum(): break
        outside = grown
    near = outside.copy()   # solid voxels with outside air beside them
    near[1:] |= outside[:-1]; near[:-1] |= outside[1:]
    near[:, 1:] |= outside[:, :-1]; near[:, :-1] |= outside[:, 1:]
    near[:, :, 1:] |= outside[:, :, :-1]; near[:, :, :-1] |= outside[:, :, 1:]
    cells = np.concatenate(owner_points); who = np.concatenate(owner)
    hit = near[cells[:, 0], cells[:, 1], cells[:, 2]]
    keep = np.zeros(len(tris), bool); keep[who[hit]] = True
    return keep


def write(path, parts):
    """a glTF with one node and mesh per part: positions and linear vertex colours, a triangle soup"""
    bin_, views, accessors, meshes, nodes = bytearray(), [], [], [], []
    def add(arr, kind, target):
        off = len(bin_); data = np.ascontiguousarray(arr, np.float32).tobytes(); bin_.extend(data)
        while len(bin_) % 4: bin_.append(0)
        views.append({'buffer': 0, 'byteOffset': off, 'byteLength': len(data), 'target': target})
        acc = {'bufferView': len(views) - 1, 'componentType': 5126, 'count': len(arr), 'type': kind}
        if kind == 'VEC3' and target == 34962 and len(accessors) % 2 == 0:
            acc['min'] = np.asarray(arr).min(0).tolist(); acc['max'] = np.asarray(arr).max(0).tolist()
        accessors.append(acc); return len(accessors) - 1
    for name, (tris, cols) in parts.items():
        if not len(tris): continue
        p = add(tris.reshape(-1, 3), 'VEC3', 34962); c = add(cols.reshape(-1, 3), 'VEC3', 34962)
        meshes.append({'name': name, 'primitives': [{'attributes': {'POSITION': p, 'COLOR_0': c}}]})
        nodes.append({'name': name, 'mesh': len(meshes) - 1})
    G = {'asset': {'version': '2.0', 'generator': 'apps/air/tools/fa18c/far.py'}, 'scene': 0,
         'scenes': [{'nodes': list(range(len(nodes)))}], 'nodes': nodes, 'meshes': meshes,
         'accessors': accessors, 'bufferViews': views, 'buffers': [{'byteLength': len(bin_)}]}
    j = json.dumps(G).encode(); j += b' ' * ((4 - len(j) % 4) % 4)
    out = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(j) + 8 + len(bin_)) + struct.pack('<II', len(j), 0x4E4F534A) + j + struct.pack('<II', len(bin_), 0x004E4942) + bytes(bin_)
    Path(path).write_bytes(out)


def build(pose_path, out_path):
    pose = json.loads(Path(pose_path).read_text()); images = original_images()
    assert len(pose['up']) == len(pose['down']), 'the two poses list different meshes'
    groups = {'airframe': [], 'up': [], 'down': [], 'burner': []}
    for up, down in zip(pose['up'], pose['down']):
        assert up['name'] == down['name'] and up['material'] == down['material']
        if up['material'] in OVERLAYS or (up['alpha'] == 'BLEND' and up['factor'][3] < 0.05 and up['material'] not in GLASS):
            continue
        tu, uv = soup(up); td, _ = soup(down)
        if not len(tu): continue
        if up['material'] in BURNER:
            groups['burner'].append((tu, colours(up, len(tu), uv, images, glow=True))); continue
        if np.abs(tu - td).max() > 1e-4 * np.ptp(tu.reshape(-1, 3), 0).max() + 1e-6:
            groups['up'].append((tu, colours(up, len(tu), uv, images))); groups['down'].append((td, colours(down, len(td), uv, images)))
        else:
            groups['airframe'].append((tu, colours(up, len(tu), uv, images)))
    joined = {k: (np.concatenate([t for t, _ in v]) if v else np.zeros((0, 3, 3)),
                  np.concatenate([c for _, c in v]) if v else np.zeros((0, 3, 3))) for k, v in groups.items()}
    raw = np.ptp(np.concatenate([joined['airframe'][0], joined['up'][0]]).reshape(-1, 3), 0).max()
    voxel = VOXEL * raw / LENGTH
    print(f'far: voxel {voxel:.4f} model units ({VOXEL} m)')
    out = {}
    for pose_name, gear in (('up', 'up'), ('down', 'down')):
        frame = np.concatenate([joined['airframe'][0], joined[gear][0]])
        keep = exterior(frame, voxel); n = len(joined['airframe'][0])
        out.setdefault('airframe', np.zeros(n, bool)); out['airframe'] |= keep[:n]
        out[gear] = keep[n:]
    parts = {}
    for k in ('airframe', 'up', 'down'):
        t, c = joined[k]; keep = out[k]
        parts[k] = (t[keep], c[keep])
        print(f'far: {k}: {keep.sum()} of {len(keep)} triangles face the outside')
    parts['burner'] = joined['burner']
    print(f"far: burner: {len(joined['burner'][0])} triangles")
    write(out_path, parts)
    print(f'far: wrote {out_path}')


if __name__ == '__main__':
    build(sys.argv[1] if len(sys.argv) > 1 else HERE / 'pose.json', sys.argv[2] if len(sys.argv) > 2 else HERE / 'parts.glb')
