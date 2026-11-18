// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
//
// Writes a GLB whose buffer views are meshopt-compressed (EXT_meshopt_compression)
// back out plain, decoded by the game's own decoder (three's MeshoptDecoder), for
// the Python tools, which read plain buffers only. Every buffer view lands in the
// one binary chunk; a plain one is copied, a compressed one decoded.
//
// usage: node unpack.mjs IN.glb OUT.glb
import { readFileSync, writeFileSync } from 'node:fs'
import { MeshoptDecoder } from '../../web/node_modules/three/examples/jsm/libs/meshopt_decoder.module.js'

const [input, output] = process.argv.slice(2)
const data = readFileSync(input)
if (data.readUInt32LE(0) !== 0x46546c67) throw new Error(`${input}: not a GLB`)
const length = data.readUInt32LE(12)
const gltf = JSON.parse(data.subarray(20, 20 + length).toString('utf8'))
const start = 20 + length
const binary = start < data.length ? data.subarray(start + 8, start + 8 + data.readUInt32LE(start)) : Buffer.alloc(0)
await MeshoptDecoder.ready

const parts = []
let offset = 0
for (const view of gltf.bufferViews || []) {
  const packed = view.extensions?.EXT_meshopt_compression
  let bytes
  if (packed) {
    if ((packed.buffer || 0) !== 0) throw new Error('compressed data outside the binary chunk')
    bytes = new Uint8Array(packed.count * packed.byteStride)
    const source = new Uint8Array(binary.buffer, binary.byteOffset + (packed.byteOffset || 0), packed.byteLength)
    MeshoptDecoder.decodeGltfBuffer(bytes, packed.count, packed.byteStride, source, packed.mode, packed.filter || 'NONE')
    delete view.extensions.EXT_meshopt_compression
    if (!Object.keys(view.extensions).length) delete view.extensions
    if (packed.mode === 'ATTRIBUTES') view.byteStride = packed.byteStride
  } else {
    if ((view.buffer || 0) !== 0) throw new Error('a plain view outside the binary chunk')
    bytes = binary.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength)
  }
  offset += (4 - (offset % 4)) % 4
  view.buffer = 0
  view.byteOffset = offset
  view.byteLength = bytes.length
  parts.push([offset, bytes])
  offset += bytes.length
}
const chunk = Buffer.alloc(offset + ((4 - (offset % 4)) % 4))
for (const [at, bytes] of parts) chunk.set(bytes, at)
gltf.buffers = [{ byteLength: chunk.length }]
for (const key of ['extensionsUsed', 'extensionsRequired']) {
  if (gltf[key]) gltf[key] = gltf[key].filter((name) => name !== 'EXT_meshopt_compression')
  if (gltf[key] && !gltf[key].length) delete gltf[key]
}
let text = Buffer.from(JSON.stringify(gltf), 'utf8')
text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)])
const head = Buffer.alloc(20)
head.writeUInt32LE(0x46546c67, 0)
head.writeUInt32LE(2, 4)
head.writeUInt32LE(12 + 8 + text.length + 8 + chunk.length, 8)
head.writeUInt32LE(text.length, 12)
head.writeUInt32LE(0x4e4f534a, 16)
const tail = Buffer.alloc(8)
tail.writeUInt32LE(chunk.length, 0)
tail.writeUInt32LE(0x004e4942, 4)
writeFileSync(output, Buffer.concat([head, text, tail, chunk]))
