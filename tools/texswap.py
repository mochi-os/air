# Texture-only KTX2 surgery for a GLB (#200): encode embedded images >= MIN
# bytes to KTX2 (via a minimal glTF wrapper run through gltfpack, the approved
# encoder) and graft them back in place. BufferView ORDER and indices are
# preserved (offsets recomputed), geometry/animations/materials untouched — the
# fa18c rig surgery history forbids restructuring, so gltfpack never sees the
# real model.
import json, struct, subprocess, sys, os, base64

SRC, DST, MODE = sys.argv[1], sys.argv[2], (sys.argv[3] if len(sys.argv) > 3 else "etc1s")
WORK = os.path.dirname(os.path.abspath(DST))
GLTFPACK = "/home/alistair/mochi/apps/air/tools/gltfpack-native"   # native build from github.com/zeux/meshoptimizer/releases (the npm gltfpack is wasm and lacks BasisU); NOT committed - fetch and chmod +x when regenerating
MIN = 50000

def load_glb(p):
    with open(p, "rb") as f:
        magic, ver, _ = struct.unpack("<III", f.read(12))
        assert magic == 0x46546C67
        clen, ctype = struct.unpack("<II", f.read(8))
        js = json.loads(f.read(clen))
        blen, btype = struct.unpack("<II", f.read(8))
        bin_ = f.read(blen)
    return js, bin_

def save_glb(p, js, bin_):
    jb = json.dumps(js, separators=(",", ":")).encode()
    jb += b" " * (-len(jb) % 4)
    bin_ += b"\0" * (-len(bin_) % 4)
    with open(p, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(jb) + 8 + len(bin_)))
        f.write(struct.pack("<II", len(jb), 0x4E4F534A)); f.write(jb)
        f.write(struct.pack("<II", len(bin_), 0x004E4942)); f.write(bin_)

def encode_ktx2(data, mime, tag):
    ext = "png" if "png" in mime else "jpg"
    img = f"{WORK}/tex_{tag}.{ext}"
    open(img, "wb").write(data)
    # Minimal textured quad so gltfpack keeps and encodes the image.
    pos = struct.pack("<12f", 0,0,0, 1,0,0, 1,1,0, 0,1,0)
    uv  = struct.pack("<8f", 0,0, 1,0, 1,1, 0,1)
    idx = struct.pack("<6H", 0,1,2, 0,2,3)
    binq = pos + uv + idx
    gltf = {
      "asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}],
      "nodes": [{"mesh": 0}],
      "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "TEXCOORD_0": 1}, "indices": 2, "material": 0}]}],
      "materials": [{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}}}],
      "textures": [{"source": 0}], "images": [{"uri": os.path.basename(img)}],
      "buffers": [{"uri": "data:application/octet-stream;base64," + base64.b64encode(binq).decode(), "byteLength": len(binq)}],
      "bufferViews": [
        {"buffer": 0, "byteOffset": 0, "byteLength": 48},
        {"buffer": 0, "byteOffset": 48, "byteLength": 32},
        {"buffer": 0, "byteOffset": 80, "byteLength": 12}],
      "accessors": [
        {"bufferView": 0, "componentType": 5126, "count": 4, "type": "VEC3", "min": [0,0,0], "max": [1,1,0]},
        {"bufferView": 1, "componentType": 5126, "count": 4, "type": "VEC2"},
        {"bufferView": 2, "componentType": 5123, "count": 6, "type": "SCALAR"}],
    }
    wrapper = f"{WORK}/wrap_{tag}.gltf"
    json.dump(gltf, open(wrapper, "w"))
    out = f"{WORK}/wrap_{tag}.glb"
    mode = ["-tc", "-tu", "-tj", "8"] if MODE == "uastc" else ["-tc", "-tq", "10", "-tj", "8"]
    env = dict(os.environ, BWRAP_PROJECT="/home/alistair/mochi")
    r = subprocess.run([os.path.expanduser("~/bin/bwrap-build"), GLTFPACK, "-i", wrapper, "-o", out] + mode,
                      capture_output=True, text=True, env=env)
    if r.returncode != 0:
        raise RuntimeError(f"gltfpack failed for {tag}: {r.stderr[-300:]}")
    wjs, wbin = load_glb(out)
    (wimg,) = wjs["images"]
    assert wimg["mimeType"] == "image/ktx2", wimg
    bv = wjs["bufferViews"][wimg["bufferView"]]
    ktx = wbin[bv.get("byteOffset", 0): bv.get("byteOffset", 0) + bv["byteLength"]]
    for f_ in (img, wrapper, out): os.remove(f_)
    return ktx

js, bin_ = load_glb(SRC)
views = js["bufferViews"]
swaps = {}   # bufferView index -> ktx2 bytes
for i, im in enumerate(js.get("images", [])):
    bv = views[im["bufferView"]]
    if bv["byteLength"] < MIN: continue
    data = bin_[bv.get("byteOffset", 0): bv.get("byteOffset", 0) + bv["byteLength"]]
    ktx = encode_ktx2(data, im["mimeType"], str(i))
    swaps[im["bufferView"]] = ktx
    im["mimeType"] = "image/ktx2"
    print(f"image {i}: {len(data)} -> {len(ktx)} bytes")

# Rebuild the BIN preserving bufferView order/indices; recompute offsets.
newbin = bytearray()
for j, bv in enumerate(views):
    data = swaps.get(j) or bin_[bv.get("byteOffset", 0): bv.get("byteOffset", 0) + bv["byteLength"]]
    newbin += b"\0" * (-len(newbin) % 4)
    bv["byteOffset"] = len(newbin)
    bv["byteLength"] = len(data)
    newbin += data
js["buffers"][0]["byteLength"] = len(newbin)

# Route swapped textures through KHR_texture_basisu (no fallback image kept).
swapped_images = {i for i, im in enumerate(js.get("images", [])) if im.get("mimeType") == "image/ktx2"}
for t in js.get("textures", []):
    if t.get("source") in swapped_images:
        t.setdefault("extensions", {})["KHR_texture_basisu"] = {"source": t.pop("source")}
for key in ("extensionsUsed", "extensionsRequired"):
    js.setdefault(key, [])
    if "KHR_texture_basisu" not in js[key]: js[key].append("KHR_texture_basisu")

save_glb(DST, js, bytes(newbin))
print(f"done: {os.path.getsize(SRC)} -> {os.path.getsize(DST)} bytes, {len(swaps)} textures encoded")
