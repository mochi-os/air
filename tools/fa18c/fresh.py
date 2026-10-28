# Factory-fresh paint for the F/A-18C (#147): the model's base colour atlases carry a service jet's wear - grime
# streaks on the skin, chipped paint along the cockpit's sills, walls and throttle grips, rust specks, scuffs - and
# this repaints them clean, keeping the markings, stencils, legends, panel lines and the baked shading.
#
# usage: fresh.py SRC DST [PREVIEW]
#   SRC      the JPEG model fa18c.glb is encoded from (git show bdd7ebc63^:web/src/assets/fa18c.glb)
#   DST      the same model with each atlas below repainted, as PNG; texswap.py then encodes it as the shipped
#            model: python3 ../texswap.py DST ../../web/src/assets/fa18c.glb etc1s 15,19,20,21,22
#   PREVIEW  a directory for each atlas's before and after, side by side
#
# Each atlas is worked over the texels its materials' triangles cover (grown two texels, which filtering reaches), and
# never past them into the background, in one of two ways:
#   skin     the colour regions of the paint, each small one (lettering, rivets, a stain) taken into the large region
#            beside it; a broad base the grime averages out of (a Gaussian, iteratively blind to whatever stands off
#            it), the fine detail - panel lines, rivets, stencil edges - measured against the paint around it and laid
#            back above a noise floor (floor), and anything that stands well off the base - markings, insignia,
#            numbers, walkways - left as it was
#   pit      an edge-preserving smoothing (flatten, its strength per atlas) that clears the specks, grain and scuffs
#            and keeps every hard edge and the baked shadows
# Per atlas, in a pit atlas:
#   chips    rectangles where the chips are filled from the paint around them: grey blobs on the island's edge, lighter
#            or darker than the paint beside them, with a ragged inner boundary or lying along the edge as a worn rim.
#            A panel's buttons and frames look the same to that test, so it runs only where it is asked to
#   light    rectangles where everything lighter than the paint most of its neighbourhood holds, by less than a
#            legend's white, is filled: scuffs and worn bands on dark frames, however long; faint rectangles the same
#            down to half the contrast, for faint scuffs on plain paint with no hard edge to eat into
#   clean    rectangles with every detail that is not paint filled, for the flakes inside an island that cannot be
#            told from a screw head by shape
#   skin     rectangles whose islands are repainted as the skin is (a seat cushion's grime)
#   flat     rectangles painted whole in their dominant colour (a button's side worn in a broad band), in a colour
#            of their own [x0, y0, x1, y1, r, g, b], or in the colour of a second rectangle [x0, y0, x1, y1, sx0, sy0,
#            sx1, sy1] where the worn one holds little paint
#   along    bands [x0, x1, top, bottom, dx, dy], from x0 to x1 and from top to bottom at x0, sloping with (dx, dy),
#            averaged along that direction within each island: a long strip worn in dashes along its length, which block
#            compression turns into coloured dashes
#   discs    round button faces [x, y, radius] painted whole, their legend kept
#   paint    whole islands [x, y, r, g, b], the island under texel (x, y), painted in a colour of their own before
#            the flat rectangles (a fixture's housing repainted)
#   patch    triangles lying wholly inside [x0, y0, x1, y1, px, py, r, g, b] pointed at a patch of their own, four
#            texels square at (px, py) in the background, painted (r, g, b): a part whose UVs lie on its neighbour's, so
#            that no paint on the one leaves the other alone (the shoulder spotlights' lenses, on their barrels' ends)
# and in any atlas, keep rectangles left exactly as they were (a placard, a pilot's face). Last, every texel whose
# centre no triangle covers takes its island's edge, six texels out, so filtering at an edge meets the island's own
# paint and not the background or the wear the source painted past it.
import io, json, os, struct, sys
import numpy as np
from PIL import Image

# image index: how, which materials' islands, and the rectangles [x0, y0, x1, y1] in the atlas's pixels
ATLASES = {
    2: dict(mode="skin"),                                       # Nose
    3: dict(mode="skin"),                                       # WingL
    4: dict(mode="skin"),                                       # WingR
    5: dict(mode="skin"),                                       # Material_7: the fuselage's underside and spine
    6: dict(mode="pit", materials=["Material_10"], keep=[[40, 195, 135, 290]]),   # the gear, wheels and fittings, their baked shading kept, and the inner hub's bolts; not the pilot's body
    7: dict(mode="skin", keep=[[0, 830, 568, 1024]]),           # Tails; the engine faces' blades kept
    12: dict(mode="skin"),                                      # Fuselage
    14: dict(mode="skin", floor=10.0),                          # Petal: the nozzles' outer petals, their grain smoothed
    9: dict(mode="pit", materials=["Material_9", "Material_9.001"],    # the cockpit shell; the pilot's face and suit kept
            clean=[[368, 300, 404, 348]],                       # the bracket on the canopy rail
            faint=[[292, 248, 304, 532], [432, 248, 444, 532]],   # the canopy sills' rivets, which the engine builds as geometry
            paint=[[375, 254, 84, 91, 91], [372, 270, 84, 91, 91],   # the shoulder spotlights' barrels and cones, and
                   [369, 300, 84, 91, 91], [374, 332, 84, 91, 91]],  # their arms, in the cockpit's grey: the frame's own
                                                                # paint reads near black on their shaded sides
            patch=[[373, 247, 383, 251, 360, 316, 22, 28, 34]],  # and their lenses, the ends, as dark glass
            keep=[[0, 360, 135, 790], [0, 790, 340, 1024]]),
    15: dict(mode="pit"),                                       # Material_12: the main and centre panels
    16: dict(mode="pit", skin=[[255, 675, 410, 815]], skin_keep=55.0,   # Material_14: the canopy frame, sill rails, coaming; the stained guard plates repainted
             faint=[[0, 77, 128, 246], [128, 68, 256, 225], [256, 59, 384, 205], [384, 51, 512, 184], [512, 42, 640, 164],
                    [640, 33, 768, 143], [768, 24, 850, 123], [850, 24, 896, 110], [896, 15, 1024, 103]],   # the canopy rail and the strip below it, down their diagonal
             along=[[560, 1024, 133, 156, 1.0, -0.151]],        # and the strip's dashed worn edge, smoothed along it
             light=[[0, 250, 140, 1024], [880, 250, 1024, 1024], [0, 860, 1024, 1024]],   # the frames
             keep=[[0, 0, 60, 45], [150, 675, 230, 770], [800, 668, 885, 760], [50, 58, 245, 90], [0, 820, 85, 905]]),   # the hatching, the two dials, the painted horizon and the vent grille
    18: dict(mode="pit",                                        # Material_21: walls, sills, throttle grips; the compass deviation card kept
             chips=[[0, 0, 1024, 112], [0, 660, 175, 856], [440, 795, 625, 1024], [345, 735, 585, 835]],
             clean=[[440, 400, 500, 500], [795, 545, 855, 655], [600, 820, 665, 925], [935, 88, 1024, 132], [395, 815, 440, 830], [40, 750, 50, 760], [316, 22, 334, 38]],
             keep=[[645, 160, 715, 225], [158, 660, 275, 728]]),
    19: dict(mode="pit",                                        # Material_13.001: the main panel's lower parts
             discs=[[974, 501, 42.5]], flat=[[904, 424, 1018, 458]]),   # the DISP button's face, and its side
    20: dict(mode="pit"),                                       # Material_20: the left console
    21: dict(mode="pit"),                                       # Material_19: the right console
    24: dict(mode="pit"),                                       # Material_11: the seat and the coaming
}

NB = ((0, 1), (1, 0), (0, -1), (-1, 0))
TYPES = {5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}
COUNT = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def load(path):
    b = open(path, "rb").read()
    n = struct.unpack("<I", b[12:16])[0]
    return json.loads(b[20:20 + n]), b[20 + n + 8:]


def save(path, j, binary):
    jb = json.dumps(j, separators=(",", ":")).encode()
    jb += b" " * (-len(jb) % 4)
    binary += b"\0" * (-len(binary) % 4)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(jb) + 8 + len(binary)))
        f.write(struct.pack("<II", len(jb), 0x4E4F534A)); f.write(jb)
        f.write(struct.pack("<II", len(binary), 0x004E4942)); f.write(binary)


def accessor(j, binary, i):
    a = j["accessors"][i]; v = j["bufferViews"][a["bufferView"]]; t = TYPES[a["componentType"]]; c = COUNT[a["type"]]
    off = v.get("byteOffset", 0) + a.get("byteOffset", 0); stride = v.get("byteStride", 0); size = np.dtype(t).itemsize * c
    if stride and stride != size:
        raw = np.frombuffer(binary, np.uint8, a["count"] * stride, off).reshape(a["count"], stride)[:, :size].copy()
        x = raw.view(t).reshape(a["count"], c)
    else:
        x = np.frombuffer(binary, t, a["count"] * c, off).reshape(a["count"], c)
    x = x.astype(np.float64)
    if a.get("normalized"):
        x /= np.iinfo(t).max
    return x


def image_of(j, material):
    t = j["materials"][material].get("pbrMetallicRoughness", {}).get("baseColorTexture")
    return j["textures"][t["index"]]["source"] if t else None


def triangles(j, binary, image, materials=None):
    """every UV triangle of every primitive whose material samples the image (and is listed, when a list is given)"""
    out = []
    for mesh in j["meshes"]:
        for p in mesh["primitives"]:
            m = p.get("material")
            if m is None or image_of(j, m) != image or "TEXCOORD_0" not in p["attributes"]:
                continue
            if materials and j["materials"][m].get("name") not in materials:
                continue
            uv = accessor(j, binary, p["attributes"]["TEXCOORD_0"])
            index = accessor(j, binary, p["indices"]).astype(int).reshape(-1, 3) if "indices" in p else np.arange(len(uv)).reshape(-1, 3)
            out.append(uv[index])
    return np.concatenate(out) if out else np.zeros((0, 3, 2))


def islands(tris, W, H, grow=2):
    """an island id per pixel (-1 on none): triangles joined through shared UV corners, rasterised at texel centres"""
    n = len(tris); parent = np.arange(n)

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]; x = parent[x]
        return x
    seen = {}
    for t in range(n):
        for c in tris[t]:
            k = (round(c[0] * W * 4), round(c[1] * H * 4))
            if k in seen:
                a, b = find(t), find(seen[k])
                if a != b:
                    parent[a] = b
            else:
                seen[k] = t
    _, ids = np.unique(np.array([find(t) for t in range(n)]), return_inverse=True)
    lab = np.full((H, W), -1, np.int32)
    px = tris * np.array([W, H])
    for t in range(n):
        p = px[t]
        x0, x1 = int(max(0, np.floor(p[:, 0].min()))), int(min(W - 1, np.ceil(p[:, 0].max())))
        y0, y1 = int(max(0, np.floor(p[:, 1].min()))), int(min(H - 1, np.ceil(p[:, 1].max())))
        if x1 < x0 or y1 < y0:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        (ax, ay), (bx, by), (cx, cy) = p
        d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(d) < 1e-12:
            continue
        l1 = ((by - cy) * (xs - cx) + (cx - bx) * (ys - cy)) / d
        l2 = ((cy - ay) * (xs - cx) + (ax - cx) * (ys - cy)) / d
        inside = (l1 >= -1e-6) & (l2 >= -1e-6) & (1 - l1 - l2 >= -1e-6)
        lab[y0:y1 + 1, x0:x1 + 1][inside] = ids[t]
    for _ in range(grow):   # grown two texels into the background by default: filtering reaches them at an island's edge
        grow = lab.copy()
        for dy, dx in NB:
            n = shift(lab, dy, dx, -1)
            grow = np.where((grow < 0) & (n >= 0), n, grow)
        lab = grow
    return lab


def shift(a, dy, dx, fill):
    out = np.full_like(a, fill); H, W = a.shape[:2]
    ys, yd = slice(max(dy, 0), H + min(dy, 0)), slice(max(-dy, 0), H + min(-dy, 0))
    xs, xd = slice(max(dx, 0), W + min(dx, 0)), slice(max(-dx, 0), W + min(-dx, 0))
    out[yd, xd] = a[ys, xs]
    return out


def box(a, r, axis):
    pad = [(0, 0)] * a.ndim; pad[axis] = (r + 1, r)
    c = np.cumsum(np.pad(a, pad, mode="edge"), axis=axis, dtype=np.float64)
    n = a.shape[axis]
    return ((np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis=axis) - np.take(c, np.arange(n), axis=axis)) / (2 * r + 1)).astype(np.float32)


def blur(a, sigma):
    """a Gaussian of sigma, as three box passes each way"""
    r = max(1, int(round((np.sqrt(4 * sigma * sigma + 1) - 1) / 2)))
    out = a.astype(np.float32)
    for axis in (0, 1):
        for _ in range(3):
            out = box(out, r, axis)
    return out


def opponent(a):
    """lightness and two chroma axes, the chroma weighted up: grime darkens, markings colour"""
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    return np.stack([(r + g + b) / 3, (r - g) * 1.5, (r + g - 2 * b) * 0.9], -1)


def skin(img, mask, sigma=20.0, spread=8.0, passes=6, fine=1.2, floor=4.0, keep=70.0):
    """one colour region repainted: the broad base, the fine detail above its noise floor, and whatever still stands
    far off the base as it was"""
    valid = mask.astype(np.float32)[..., None]
    o = opponent(img); w = valid.copy()
    for _ in range(passes):
        base = blur(img * w, sigma) / np.maximum(blur(w, sigma), 1e-4)
        d = np.sqrt(((o - opponent(base)) ** 2).sum(2, keepdims=True))
        w = valid * np.exp(-(d * d) / (2 * spread * spread))
    d = np.sqrt(((o - opponent(base)) ** 2).sum(2, keepdims=True))
    mark = np.clip((d - keep * 0.8) / (keep * 0.2), 0, 1)
    plain = valid * (mark == 0)   # the fine detail measured against the paint around it, never a marking's edge: no halo
    detail = img - blur(img * plain, fine) / np.maximum(blur(plain, fine), 1e-4)
    size = np.sqrt((detail ** 2).sum(2, keepdims=True))
    detail *= np.clip((size - floor) / np.maximum(size, 1e-4), 0, None)
    return (base + detail) * (1 - mark) + img * mark


def regions(img, lab, smallest=300):
    """the colour regions of each island: a light edge-preserving smoothing keeps every hard edge and lets soft grime
    blend into its paint, so the regions part at markings, strips and panels and not at stains; regions smaller than
    smallest (lettering, rivets, small markings) come back as -1"""
    cover = np.where(lab >= 0, 0, -1).astype(np.int32)
    seg = segments(flatten(img, cover, sigma=3.0, spread=10.0, passes=2), cover, 6.0)
    ids, inv, cnt = np.unique(seg[seg >= 0], return_inverse=True, return_counts=True)
    keep = cnt >= smallest
    out = np.full(lab.shape, -1, np.int64); out[seg >= 0] = np.where(keep[inv], inv, -1)
    return out


def adopt(reg, lab, steps=64):
    """the texels of the small regions (lettering, rivets, stains) taken into the large region beside them in the same
    island, so a stain is repainted with its paint while lettering, standing far off that paint, is still kept"""
    reg = reg.copy()
    for _ in range(steps):
        todo = (reg < 0) & (lab >= 0)
        if not todo.any():
            break
        grow = reg.copy()
        for dy, dx in NB:
            n = shift(reg, dy, dx, -1)
            take = (grow < 0) & todo & (n >= 0) & (shift(lab, dy, dx, -9) == lab)
            grow[take] = n[take]
        if np.array_equal(grow, reg):
            break
        reg = grow
    return reg


def flatten(img, lab, sigma=4.0, spread=14.0, passes=3):
    """a bilateral filter iterated on its own output, never mixing islands"""
    H, W, _ = img.shape; R = int(2 * sigma); out = img.astype(np.float32).copy()
    labp = np.pad(lab, R, constant_values=-2)
    for _ in range(passes):
        src = np.pad(out, ((R, R), (R, R), (0, 0)), mode="edge")
        acc = np.zeros_like(out); total = np.zeros((H, W), np.float32)
        for dy in range(-R, R + 1):
            for dx in range(-R, R + 1):
                ws = np.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma))
                if ws < 0.02:
                    continue
                s = src[R + dy:R + dy + H, R + dx:R + dx + W]
                w = ws * np.exp(-((out - s) ** 2).sum(2) / (2 * spread * spread)) * (labp[R + dy:R + dy + H, R + dx:R + dx + W] == lab)
                acc += w[..., None] * s; total += w
        ok = total > 0
        out[ok] = acc[ok] / total[ok][:, None]
    out[lab < 0] = img[lab < 0]
    return out


def segments(img, lab, tol):
    """connected regions of one colour within one island: 4-neighbours join when their colours lie within tol"""
    H, W = lab.shape; N = H * W
    L = np.where(lab >= 0, np.arange(N, dtype=np.int64).reshape(H, W), N + 1)
    joins = []
    for dy, dx in NB:
        d = np.sqrt(((img - shift(img, dy, dx, 0)) ** 2).sum(2))
        joins.append(((shift(lab, dy, dx, -3) == lab) & (lab >= 0) & (d < tol), dy, dx))
    while True:
        new = L.copy()
        for ok, dy, dx in joins:
            new = np.where(ok, np.minimum(new, shift(L, dy, dx, N + 1)), new)
        flat = new.ravel(); v = flat < N
        flat[v] = np.minimum(flat[v], flat[flat[v]])
        new = flat.reshape(H, W)
        if np.array_equal(new, L):
            return np.where(lab >= 0, L, -1)
        L = new


def edge_distance(lab, limit=24):
    """4-neighbour steps from each island pixel to its island's edge, 1 on the edge"""
    d = np.zeros(lab.shape, np.int32); cur = lab >= 0; k = 0
    while cur.any() and k < limit:
        k += 1; inner = cur.copy()
        for dy, dx in NB:
            inner &= shift(lab, dy, dx, -9) == lab
        d[cur & ~inner] = k; cur = inner
    d[cur] = limit
    return d


def chips(img, lab, fraction=0.15, minimum=400):
    """the blobs off each island's paint, and of them the chips: grey, on the island's edge, ragged where they meet
    the paint or a rim along the edge, standing 22 or more off it in lightness"""
    H, W = lab.shape; valid = lab >= 0
    seg = segments(img, lab, 14.0)
    s = seg[valid]; isl = lab[valid]
    dist = edge_distance(lab)
    _, inv, cnt = np.unique(s, return_inverse=True, return_counts=True)
    owner = np.zeros(len(cnt), np.int64); owner[inv] = isl
    depth = np.zeros(len(cnt), np.int64); np.maximum.at(depth, inv, dist[valid])
    area = np.bincount(isl, minlength=lab.max() + 1)
    largest = np.zeros(area.shape, np.int64); order = np.argsort(cnt); largest[owner[order]] = cnt[order]
    paint = np.zeros((H, W), bool)   # a rim worn along the whole edge can be a long run of one colour, but it is never paint
    paint[valid] = (((cnt >= np.maximum(minimum, fraction * area[owner])) & (depth > 2)) | (cnt == largest[owner]))[inv]
    detail = valid & ~paint
    blob = segments(np.zeros((H, W, 1), np.float32), np.where(detail, 0, -1).astype(np.int32), 1.0)
    bv = blob >= 0
    if not bv.any():
        return np.zeros((H, W), bool), detail
    ub, binv, bcnt = np.unique(blob[bv], return_inverse=True, return_counts=True); nb = len(ub)
    touches = np.zeros(nb, bool); np.logical_or.at(touches, binv, dist[bv] <= 2)
    rim = np.zeros(nb, np.int64); np.maximum.at(rim, binv, dist[bv]); rim = rim <= 2
    inner = np.zeros((H, W), bool)
    for dy, dx in NB:
        inner |= bv & shift(paint, dy, dx, False)
    iv = inner[bv].astype(float); dd = dist[bv].astype(float)
    n = np.bincount(binv, weights=iv, minlength=nb)
    m1 = np.bincount(binv, weights=dd * iv, minlength=nb) / np.maximum(n, 1)
    ragged = np.sqrt(np.maximum(np.bincount(binv, weights=dd * dd * iv, minlength=nb) / np.maximum(n, 1) - m1 * m1, 0)) >= 1.0
    # the paint beside each blob
    owner_of = np.full((H, W), -1, np.int64)
    for dy, dx in NB:
        nbl = shift(np.where(bv, blob, -1), dy, dx, -1)
        owner_of = np.where(paint & (owner_of < 0) & (nbl >= 0), nbl, owner_of)
    near = owner_of >= 0; pid = np.searchsorted(ub, owner_of[near])
    pn = np.bincount(pid, minlength=nb).astype(float)
    pmean = np.stack([np.bincount(pid, weights=img[near][:, c], minlength=nb) for c in range(3)], 1) / np.maximum(pn, 1)[:, None]
    bmean = np.stack([np.bincount(binv, weights=img[bv][:, c], minlength=nb) for c in range(3)], 1) / bcnt[:, None]
    grey = (bmean.max(1) - bmean.min(1)) < 28
    contrast = np.abs(bmean.mean(1) - pmean.mean(1))
    chip = touches & (ragged | rim) & grey & (contrast >= 22) & (pn > 0)
    fill = np.zeros((H, W), bool); fill[bv] = chip[binv]
    return fill, detail


def flecks(img, lab, sigma=6.0, spread=10.0, passes=4, low=22.0, high=130.0):
    """the texels lighter than the paint around them by low to high, near grey, and clear of a legend's white:
    scuffs and chipped edges on dark paint. The paint is the lightness most of the neighbourhood holds, so a long
    worn band, which segments as paint of its own, is still found"""
    valid = (lab >= 0).astype(np.float32)[..., None]
    lightness = img.mean(2, keepdims=True); w = valid.copy()
    for _ in range(passes):
        base = blur(lightness * w, sigma) / np.maximum(blur(w, sigma), 1e-4)
        w = valid * np.exp(-((lightness - base) ** 2) / (2 * spread * spread))
    up = (lightness - base)[..., 0]
    white = up > high
    for _ in range(2):
        white = white | shift(white, 1, 0, False) | shift(white, -1, 0, False) | shift(white, 0, 1, False) | shift(white, 0, -1, False)
    chroma = img.max(2) - img.min(2)
    found = (lab >= 0) & (up >= low) & (up <= high) & (chroma < 60) & ~white
    edge = found | shift(found, 1, 0, False) | shift(found, -1, 0, False) | shift(found, 0, 1, False) | shift(found, 0, -1, False)
    return found | (edge & (lab >= 0) & (up >= low / 2) & ~white)   # and the fleck's soft border


def inpaint(img, lab, fill):
    """each filled pixel from the paint around it, in its own island, working inwards"""
    out = img.copy(); known = (lab >= 0) & ~fill; todo = fill.copy()
    while todo.any():
        acc = np.zeros_like(out); n = np.zeros(lab.shape, np.float32)
        for dy, dx in NB + ((1, 1), (1, -1), (-1, 1), (-1, -1)):
            k = shift(known, dy, dx, False) & (shift(lab, dy, dx, -9) == lab) & todo
            acc[k] += shift(out, dy, dx, 0)[k]; n[k] += 1
        step = n > 0
        if not step.any():
            break
        out[step] = acc[step] / n[step][:, None]
        known |= step; todo &= ~step
    # smooth the filled pixels a little among themselves, so a filled band carries no streaks
    for _ in range(3):
        acc = np.zeros_like(out); n = np.zeros(lab.shape, np.float32)
        for dy, dx in NB:
            k = fill & (shift(lab, dy, dx, -9) == lab)
            acc[k] += shift(out, dy, dx, 0)[k]; n[k] += 1
        ok = n > 0
        out[ok] = 0.5 * out[ok] + 0.5 * acc[ok] / n[ok][:, None]
    return out


def rectangles(shape, boxes):
    m = np.zeros(shape, bool)
    for x0, y0, x1, y1 in boxes:
        m[y0:y1, x0:x1] = True
    return m


def fresh(img, lab, cfg):
    keep = rectangles(lab.shape, cfg.get("keep", []))
    clean = rectangles(lab.shape, cfg.get("clean", []))
    if cfg["mode"] == "skin":
        out = img.copy(); H, W = lab.shape; m = 60
        reg = adopt(regions(img, lab), lab)
        for i in np.unique(reg[reg >= 0]):
            ys, xs = np.nonzero(reg == i)
            y0, y1, x0, x1 = max(0, ys.min() - m), min(H, ys.max() + m + 1), max(0, xs.min() - m), min(W, xs.max() + m + 1)
            mask = reg[y0:y1, x0:x1] == i
            out[y0:y1, x0:x1][mask] = skin(img[y0:y1, x0:x1], mask, floor=cfg.get("floor", 4.0))[mask]
    else:
        out = flatten(img, np.where(lab >= 0, 0, -1).astype(np.int32), **cfg.get("flatten", {}))   # across islands: a surface painted over several has no seams
        within = rectangles(lab.shape, cfg.get("chips", []))
        light = rectangles(lab.shape, cfg.get("light", []))
        faint = rectangles(lab.shape, cfg.get("faint", []))
        if within.any() or clean.any() or light.any() or faint.any():
            fill = light & flecks(out, lab) if light.any() else np.zeros(lab.shape, bool)
            if faint.any():
                fill |= faint & flecks(out, lab, low=12.0)
            if within.any() or clean.any():
                chip, detail = chips(out, lab)
                fill |= (chip & within) | (detail & clean)
            out = inpaint(out, lab, fill & ~keep)
        for x0, y0, x1, y1 in cfg.get("skin", []):   # whole islands inside a skin rectangle are repainted as the skin is
            sub = lab[y0:y1, x0:x1]
            for i in np.unique(sub[sub >= 0]):
                mask = lab == i
                ys, xs = np.nonzero(mask)
                if ys.min() < y0 - 2 or ys.max() >= y1 + 2 or xs.min() < x0 - 2 or xs.max() >= x1 + 2:
                    continue
                m = 60; Y0, Y1, X0, X1 = max(0, ys.min() - m), min(lab.shape[0], ys.max() + m + 1), max(0, xs.min() - m), min(lab.shape[1], xs.max() + m + 1)
                rm = mask[Y0:Y1, X0:X1]   # the island whole: its baked shadows stand off the base and stay, its stains go
                out[Y0:Y1, X0:X1][rm] = skin(img[Y0:Y1, X0:X1], rm, keep=cfg.get("skin_keep", 40.0))[rm]
    for x0, x1, top, bottom, dx, dy in cfg.get("along", []):   # a long strip worn in dashes along its length: averaged along it
        Y, X = np.mgrid[0:lab.shape[0], 0:lab.shape[1]]; edge = (X - x0) * dy / dx   # the band between top and bottom at x0, sloping with the strip
        n = np.hypot(dx, dy); dx, dy = dx / n, dy / n
        ys, xs = np.nonzero((X >= x0) & (X < x1) & (Y >= top + edge) & (Y < bottom + edge) & (lab >= 0))
        acc = np.zeros((len(ys), 3), np.float32); cnt = np.zeros(len(ys), np.float32)
        for k in range(-12, 13):
            sy = np.clip(np.round(ys + k * dy).astype(int), 0, lab.shape[0] - 1); sx = np.clip(np.round(xs + k * dx).astype(int), 0, lab.shape[1] - 1)
            ok = lab[sy, sx] == lab[ys, xs]
            acc[ok] += out[sy[ok], sx[ok]]; cnt[ok] += 1
        out = out.copy(); out[ys, xs] = acc / np.maximum(cnt, 1)[:, None]
    for x, y, *colour in cfg.get("paint", []):   # a whole island in a colour of its own
        out = out.copy(); out[lab == lab[y, x]] = colour
    for x0, y0, x1, y1, *source in cfg.get("flat", []):   # a plain painted part worn in bands too broad to read as flecks: its paint whole
        if len(source) == 3:   # in a colour of its own
            paint = np.array(source, np.float32)
        elif source:   # in the colour of another rectangle's paint, where the worn one holds too little of its own
            sx0, sy0, sx1, sy1 = source; area = out[sy0:sy1, sx0:sx1][lab[sy0:sy1, sx0:sx1] >= 0]; paint = np.median(area, axis=0)
        else:
            area = img[y0:y1, x0:x1].reshape(-1, 3); first = np.median(area, axis=0)
            paint = np.median(area[np.abs(area - first).max(1) < 40], axis=0)
        inside = lab[y0:y1, x0:x1] >= 0
        out[y0:y1, x0:x1][inside] = paint
    for cx, cy, r in cfg.get("discs", []):   # a round button face worn at its rim: its paint whole, its legend kept
        ys, xs = np.mgrid[0:lab.shape[0], 0:lab.shape[1]]; d = np.hypot(xs + 0.5 - cx, ys + 0.5 - cy)
        inside = d < r - 1
        paint = np.median(img[inside & (img.max(2) - img.min(2) > 50)], axis=0)
        lightness = img.mean(2)
        legend = inside & (d < r * 0.8) & (lightness > paint.mean() + 30)
        blob = segments(np.zeros(lab.shape + (1,), np.float32), np.where(legend, 0, -1).astype(np.int32), 1.0)
        ids, inv, cnt = np.unique(blob[legend], return_inverse=True, return_counts=True)
        legend[legend] = cnt[inv] >= 12   # the letters; a worn speck beside them is repainted
        edge = legend | shift(legend, 1, 0, False) | shift(legend, -1, 0, False) | shift(legend, 0, 1, False) | shift(legend, 0, -1, False)
        legend |= edge & inside & (lightness > paint.mean() + 12)   # and their soft edges
        alpha = np.clip(r - d, 0, 1)[..., None] * ~legend[..., None]
        out = out * (1 - alpha) + paint * alpha
    out[keep] = img[keep]
    out[lab < 0] = img[lab < 0]
    return out


def repoint(j, binary, index, W, H):
    """each patch's triangles, those whose UVs lie wholly inside its rectangle, pointed at the patch's centre; their
    corners must be theirs alone, or a neighbour sharing one would be stretched to the patch too"""
    cfg = ATLASES[index]; binary = bytearray(binary)
    for x0, y0, x1, y1, px, py, *_ in cfg.get("patch", []):
        moved = set(); done = set()
        for mesh in j["meshes"]:
            for p in mesh["primitives"]:
                m = p.get("material"); a = p["attributes"].get("TEXCOORD_0")
                if m is None or a is None or a in done or image_of(j, m) != index:
                    continue
                if cfg.get("materials") and j["materials"][m].get("name") not in cfg["materials"]:
                    continue
                done.add(a)
                uv = accessor(j, binary, a) * [W, H]
                within = (uv[:, 0] >= x0) & (uv[:, 0] <= x1) & (uv[:, 1] >= y0) & (uv[:, 1] <= y1)
                every = np.concatenate([accessor(j, binary, q["indices"]).astype(int).reshape(-1, 3)
                                        for n in j["meshes"] for q in n["primitives"] if q["attributes"].get("TEXCOORD_0") == a])
                inside = within[every].all(1)
                corners = set(every[inside].ravel().tolist())
                assert not corners & set(every[~inside].ravel().tolist()), f"image {index}: a patch's corner is shared"
                acc = j["accessors"][a]; view = j["bufferViews"][acc["bufferView"]]
                assert acc["componentType"] == 5126 and not acc.get("normalized")
                off = view.get("byteOffset", 0) + acc.get("byteOffset", 0); stride = view.get("byteStride", 8)
                for v in corners:
                    struct.pack_into("<ff", binary, off + v * stride, (px + 2) / W, (py + 2) / H)
                moved |= {(a, v) for v in corners}
        assert moved, f"image {index}: patch {[x0, y0, x1, y1]} holds no triangle"
    return bytes(binary)


def pad(out, lab, used, width=6):
    """each island's edge carried out over the texels whose centres no triangle covers, so filtering at the edge
    meets the island's own paint and not the background or wear the source painted past it"""
    out = out.copy(); have = lab >= 0; free = ~used
    for _ in range(width):
        acc = np.zeros_like(out); n = np.zeros(lab.shape, np.float32)
        for dy, dx in NB:
            k = shift(have, dy, dx, False) & ~have & free
            acc[k] += shift(out, dy, dx, 0)[k]; n[k] += 1
        step = n > 0
        out[step] = acc[step] / n[step][:, None]; have |= step
    return out


def atlas(j, binary, index):
    """an atlas's source image and its repainted one"""
    cfg = ATLASES[index]; im = j["images"][index]; v = j["bufferViews"][im["bufferView"]]
    data = binary[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]]
    img = np.asarray(Image.open(io.BytesIO(data)).convert("RGB"), np.float32)
    H, W, _ = img.shape
    tris = triangles(j, binary, index, cfg.get("materials"))
    lab = islands(tris, W, H)
    core = islands(tris, W, H, grow=0)
    used = islands(triangles(j, binary, index), W, H, grow=0) >= 0   # every material's texels, a listed one's or not
    out = pad(fresh(img, lab, cfg), core, used)
    for *_, px, py, r, g, b in cfg.get("patch", []):   # where repoint() sent each patch's triangles
        assert not used[py:py + 4, px:px + 4].any(), f"image {index}: patch at {px}, {py} lies under a triangle"
        out[py:py + 4, px:px + 4] = [r, g, b]
    return img, lab, np.clip(np.round(out), 0, 255).astype(np.uint8)


def main():
    src, dst = sys.argv[1], sys.argv[2]
    preview = sys.argv[3] if len(sys.argv) > 3 else None
    j, binary = load(src)
    images = {}
    for index, cfg in ATLASES.items():
        if cfg.get("patch"):
            im = j["images"][index]; v = j["bufferViews"][im["bufferView"]]
            W, H = Image.open(io.BytesIO(binary[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]])).size
            binary = repoint(j, binary, index, W, H)
    for index, cfg in ATLASES.items():
        img, lab, out = atlas(j, binary, index)
        H, W, _ = img.shape
        buf = io.BytesIO(); Image.fromarray(out).save(buf, "PNG", optimize=True); images[index] = buf.getvalue()
        if preview:
            os.makedirs(preview, exist_ok=True)
            both = Image.new("RGB", (W * 2 + 8, H), (255, 0, 255))
            both.paste(Image.fromarray(img.astype(np.uint8)), (0, 0)); both.paste(Image.fromarray(out), (W + 8, 0))
            both.save(os.path.join(preview, f"atlas{index:02d}.png"))
        print(f"image {index}: {cfg['mode']}, {lab.max() + 1} islands", flush=True)
    # rebuild the binary chunk with the repainted images in place of the originals, every other view moved along
    views = j["bufferViews"]; replaced = {j["images"][i]["bufferView"]: data for i, data in images.items()}
    out = bytearray()
    for vi, v in enumerate(views):
        data = replaced.get(vi, binary[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]])
        out += b"\0" * (-len(out) % 4)
        v["byteOffset"] = len(out); v["byteLength"] = len(data); out += data
    for i in images:
        j["images"][i]["mimeType"] = "image/png"
    j["buffers"][0]["byteLength"] = len(out)
    save(dst, j, bytes(out))


if __name__ == "__main__":
    main()
