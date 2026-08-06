// Split stores.glb's three category nodes (Pylons, aim120, Tanks) into
// per-station named nodes (Pylon_2, Missile_6, Tank_5, ...) so the loadout
// model can show and hide stores per station.
//
// The split is index-level: every station primitive SHARES the original
// meshopt-compressed vertex bufferViews and accessors, and only the index
// buffers are rewritten (uncompressed, they are small). Vertex bytes and the
// KTX2 images are copied verbatim, so the compression survives without
// re-encoding and gltfpack is not needed. Geometry is assigned to stations by
// connected components bucketed on the lateral (x) coordinate: |x|>3 is the
// outboard pair, 1.5<|x|<3 the inboard pair, 0.6<|x|<1.6 the fuselage cheeks,
// |x|<0.6 the centerline. NATOPS station numbers: port tip 1 through
// starboard tip 9; negative x is port (verified by chase-view capture).
//
// Usage: node tools/stores-split.mjs [src] [dst]
// Defaults: src = dst = web/src/assets/stores.glb (in-place).

import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const decoder = await import(join(root, 'web/node_modules/three/examples/jsm/libs/meshopt_decoder.module.js'))
const MeshoptDecoder = decoder.MeshoptDecoder
await MeshoptDecoder.ready

const src = process.argv[2] ?? join(root, 'web/src/assets/stores.glb')
const dst = process.argv[3] ?? src

const data = readFileSync(src)
if (data.readUInt32LE(0) !== 0x46546c67) throw new Error('not a glb: ' + src)
const jlen = data.readUInt32LE(12)
const json = JSON.parse(data.subarray(20, 20 + jlen).toString())
const bin = data.subarray(20 + jlen + 8)

if (json.nodes.some((n) => /^(Pylon|Missile|Tank)_/.test(n.name ?? ''))) {
  console.log('already split, nothing to do')
  process.exit(0)
}

function decode(view) {
  const ext = view.extensions?.EXT_meshopt_compression
  if (!ext) {
    const stride = view.byteStride
    return { buf: bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength), stride }
  }
  const compressed = bin.subarray(ext.byteOffset ?? 0, (ext.byteOffset ?? 0) + ext.byteLength)
  const out = new Uint8Array(ext.count * ext.byteStride)
  MeshoptDecoder.decodeGltfBuffer(out, ext.count, ext.byteStride, compressed, ext.mode, ext.filter)
  return { buf: out, stride: ext.byteStride }
}

function indices(accessor) {
  const a = json.accessors[accessor]
  const { buf, stride } = decode(json.bufferViews[a.bufferView])
  const size = a.componentType === 5125 ? 4 : 2
  const step = stride ?? size
  const view = new DataView(buf.buffer, buf.byteOffset)
  const out = new Uint32Array(a.count)
  for (let i = 0; i < a.count; i++) {
    const at = (a.byteOffset ?? 0) + i * step
    out[i] = size === 4 ? view.getUint32(at, true) : view.getUint16(at, true)
  }
  return out
}

function positions(accessor) {
  const a = json.accessors[accessor]
  if (a.componentType !== 5126) throw new Error('unexpected POSITION component type ' + a.componentType)
  const { buf, stride } = decode(json.bufferViews[a.bufferView])
  const step = stride ?? 12
  const view = new DataView(buf.buffer, buf.byteOffset)
  const out = []
  for (let i = 0; i < a.count; i++) {
    const at = (a.byteOffset ?? 0) + i * step
    out.push([view.getFloat32(at, true), view.getFloat32(at + 4, true), view.getFloat32(at + 8, true)])
  }
  return out
}

// station(kind, x) names the station a cluster centre belongs to; port is
// POSITIVE x (verified in-game by the index-aware group-frame lateral probe —
// the first cut assumed negative and hung every station on the wrong wing),
// matching NATOPS numbering 1..9 from port tip to starboard tip.
function station(kind, x) {
  const side = x > 0
  const magnitude = Math.abs(x)
  if (magnitude > 3.0) return side ? 2 : 8
  if (magnitude > 1.5) return side ? 3 : 7
  if (magnitude > 0.6) return side ? 4 : 6
  return 5
}

const PREFIX = { Pylons: 'Pylon', aim120: 'Missile', Tanks: 'Tank' }

const additions = [] // {name, matrix, extras, attributes, material, station, tris: Uint32Array}
for (const node of json.nodes) {
  const mesh = json.meshes[node.mesh]
  const primitive = mesh.primitives[0]
  const material = json.materials[primitive.material]
  const prefix = PREFIX[material.name]
  if (!prefix) throw new Error('unrecognized material ' + material.name)
  const scale = node.matrix[0]
  const position = positions(primitive.attributes.POSITION)
  const index = indices(primitive.indices)

  // Union-find over shared triangle corners, plus a positional merge so
  // attribute seams (normal or uv splits) do not divide one physical piece.
  const parent = new Int32Array(position.length).map((_, i) => i)
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  const union = (a, b) => {
    a = find(a)
    b = find(b)
    if (a !== b) parent[a] = b
  }
  for (let t = 0; t < index.length; t += 3) {
    union(index[t], index[t + 1])
    union(index[t], index[t + 2])
  }
  const seen = new Map()
  for (let i = 0; i < position.length; i++) {
    const key = position[i].join(',')
    if (seen.has(key)) union(i, seen.get(key))
    else seen.set(key, i)
  }

  // Cluster centres in the node's world frame decide the station; every
  // triangle follows its cluster.
  const sum = new Map()
  for (let i = 0; i < position.length; i++) {
    const r = find(i)
    const s = sum.get(r) ?? { x: 0, n: 0 }
    s.x += position[i][0] * scale + node.matrix[12]
    s.n++
    sum.set(r, s)
  }
  const of = new Map()
  for (const [r, s] of sum) of.set(r, station(material.name, s.x / s.n))

  const buckets = new Map()
  for (let t = 0; t < index.length; t += 3) {
    const at = of.get(find(index[t]))
    if (!buckets.has(at)) buckets.set(at, [])
    buckets.get(at).push(index[t], index[t + 1], index[t + 2])
  }

  for (const [at, tris] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    additions.push({
      name: prefix + '_' + at,
      matrix: node.matrix,
      extras: { ...node.extras, station: at },
      attributes: primitive.attributes,
      material: primitive.material,
      tris: Uint32Array.from(tris),
    })
  }
  console.log(`${node.name} (${material.name}): ${index.length / 3} tris -> ` + [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([at, t]) => `${prefix}_${at}:${t.length / 3}`).join(' '))
}

// Rebuild the binary: image and vertex bufferViews verbatim (offsets
// recomputed), then one fresh uncompressed index view per station primitive.
// The old compressed index views are dropped.
const indexViews = new Set(json.meshes.map((m) => json.accessors[m.primitives[0].indices].bufferView))
const chunks = []
let offset = 0
const viewMap = new Map()
json.bufferViews.forEach((view, i) => {
  if (indexViews.has(i)) return
  const ext = view.extensions?.EXT_meshopt_compression
  const from = ext ? ext.byteOffset ?? 0 : view.byteOffset ?? 0
  const length = ext ? ext.byteLength : view.byteLength
  chunks.push(bin.subarray(from, from + length))
  const copy = JSON.parse(JSON.stringify(view))
  if (ext) copy.extensions.EXT_meshopt_compression.byteOffset = offset
  else copy.byteOffset = offset
  viewMap.set(i, { view: copy, at: chunks.length - 1 })
  offset += length
  if (offset % 4) {
    chunks.push(Buffer.alloc(4 - (offset % 4)))
    offset += 4 - (offset % 4)
  }
})

const views = []
const remap = new Map()
for (const [i, { view }] of viewMap) {
  remap.set(i, views.length)
  views.push(view)
}

const accessors = []
const accessorMap = new Map()
json.accessors.forEach((a, i) => {
  if (indexViews.has(a.bufferView)) return
  const copy = { ...a, bufferView: remap.get(a.bufferView) }
  accessorMap.set(i, accessors.length)
  accessors.push(copy)
})

const meshes = []
const nodes = []
for (const add of additions) {
  const bytes = Buffer.alloc(add.tris.length * 2)
  add.tris.forEach((v, i) => bytes.writeUInt16LE(v, i * 2))
  views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target: 34963 })
  chunks.push(bytes)
  offset += bytes.length
  if (offset % 4) {
    chunks.push(Buffer.alloc(4 - (offset % 4)))
    offset += 4 - (offset % 4)
  }
  accessors.push({ bufferView: views.length - 1, componentType: 5123, count: add.tris.length, type: 'SCALAR' })
  const attributes = {}
  for (const [semantic, accessor] of Object.entries(add.attributes)) attributes[semantic] = accessorMap.get(accessor)
  meshes.push({ name: add.name, primitives: [{ attributes, indices: accessors.length - 1, material: add.material, mode: 4 }] })
  nodes.push({ name: add.name, matrix: add.matrix, mesh: meshes.length - 1, extras: add.extras })
}

json.bufferViews = views
json.accessors = accessors
json.meshes = meshes
json.nodes = nodes
json.scenes = [{ nodes: nodes.map((_, i) => i) }]
json.buffers = [{ byteLength: offset }]

const body = Buffer.concat(chunks)
let text = Buffer.from(JSON.stringify(json))
if (text.length % 4) text = Buffer.concat([text, Buffer.alloc(4 - (text.length % 4), 0x20)])
const padded = body.length % 4 ? Buffer.concat([body, Buffer.alloc(4 - (body.length % 4))]) : body
const header = Buffer.alloc(12)
header.writeUInt32LE(0x46546c67, 0)
header.writeUInt32LE(2, 4)
header.writeUInt32LE(12 + 8 + text.length + 8 + padded.length, 8)
const jsonHeader = Buffer.alloc(8)
jsonHeader.writeUInt32LE(text.length, 0)
jsonHeader.writeUInt32LE(0x4e4f534a, 4)
const binHeader = Buffer.alloc(8)
binHeader.writeUInt32LE(padded.length, 0)
binHeader.writeUInt32LE(0x004e4942, 4)
writeFileSync(dst, Buffer.concat([header, jsonHeader, text, binHeader, padded]))
console.log(`wrote ${dst}: ${nodes.length} nodes, ${(12 + 8 + text.length + 8 + padded.length) / 1024 | 0} KB (was ${data.length / 1024 | 0} KB)`)
