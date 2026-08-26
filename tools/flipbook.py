# Flipbook atlas -> standalone KTX2 (#82): convert the source frame atlas to
# PNG, wrap it in a minimal textured-quad glTF so gltfpack's BasisU encoder
# keeps and encodes it, then extract the embedded KTX2 container (mip chain
# included). Same wrapper trick as texswap.py; gltfpack-native is fetched from
# github.com/zeux/meshoptimizer/releases and chmod +x, NOT committed.
# Usage: python3 flipbook.py <atlas.tga|png> <out.ktx2> [etc1s|uastc]
import json, struct, subprocess, sys, os, base64
from PIL import Image

SRC, DST, MODE = sys.argv[1], sys.argv[2], (sys.argv[3] if len(sys.argv) > 3 else "etc1s")
WORK = os.path.dirname(os.path.abspath(DST)) or "."
GLTFPACK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gltfpack-native")

def load_glb(p):
    with open(p, "rb") as f:
        magic, ver, _ = struct.unpack("<III", f.read(12))
        assert magic == 0x46546C67
        clen, ctype = struct.unpack("<II", f.read(8))
        js = json.loads(f.read(clen))
        blen, btype = struct.unpack("<II", f.read(8))
        bin_ = f.read(blen)
    return js, bin_

img = f"{WORK}/flip_src.png"
Image.open(SRC).convert("RGBA").save(img)

pos = struct.pack("<12f", 0,0,0, 1,0,0, 1,1,0, 0,1,0)
uv  = struct.pack("<8f", 0,0, 1,0, 1,1, 0,1)
idx = struct.pack("<6H", 0,1,2, 0,2,3)
binq = pos + uv + idx
gltf = {
  "asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}],
  "nodes": [{"mesh": 0}],
  "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "TEXCOORD_0": 1}, "indices": 2, "material": 0}]}],
  "materials": [{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}}, "alphaMode": "BLEND"}],
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
wrapper = f"{WORK}/flip_wrap.gltf"
json.dump(gltf, open(wrapper, "w"))
out = f"{WORK}/flip_wrap.glb"
mode = ["-tc", "-tu", "-tj", "8"] if MODE == "uastc" else ["-tc", "-tq", "10", "-tj", "8"]
env = dict(os.environ, BWRAP_PROJECT="/home/alistair/mochi")
r = subprocess.run([os.path.expanduser("~/bin/bwrap-build"), GLTFPACK, "-i", wrapper, "-o", out] + mode,
                   capture_output=True, text=True, env=env)
if r.returncode != 0:
    raise RuntimeError(f"gltfpack failed: {r.stderr[-300:]}")
wjs, wbin = load_glb(out)
(wimg,) = wjs["images"]
assert wimg["mimeType"] == "image/ktx2", wimg
bv = wjs["bufferViews"][wimg["bufferView"]]
ktx = wbin[bv.get("byteOffset", 0): bv.get("byteOffset", 0) + bv["byteLength"]]
open(DST, "wb").write(ktx)
for f_ in (img, wrapper, out): os.remove(f_)
print(f"{DST}: {len(ktx)} bytes ({MODE})")
