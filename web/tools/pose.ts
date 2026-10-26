// The F/A-18C's distant models start here (apps/air/tools/fa18c/far.py). The shipped jet is
// posed as the engine draws it - model.ts posed(): the static pose fixes, every scrubbed family
// at its neutral first key (gear up) and the direct-driven surfaces at neutral - and again with
// the landing gear down, the gear family scrubbed to the end of its moving span as the engine's
// rig does at full extension. Every mesh is written in the model's own frame: positions, UVs,
// triangles and its material's name, factor and alpha mode, in one JSON file.
//
// Run from apps/air/web: pnpm exec tsx tools/pose.ts <out.json>

import { readFileSync, writeFileSync } from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { GEAR, posed, repack, split } from '../src/game/model'

const out = process.argv[2]
if (!out) throw new Error('usage: tsx tools/pose.ts <out.json>')

// the geometry only: texture references would send the loader down its image path
const bytes = readFileSync(new URL('../src/assets/fa18c.glb', import.meta.url))
const parts = split(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
for (const material of parts.json.materials ?? []) {
  const pbr = material.pbrMetallicRoughness ?? {}
  delete pbr.baseColorTexture
  delete pbr.metallicRoughnessTexture
  delete material.normalTexture
  delete material.occlusionTexture
  delete material.emissiveTexture
  for (const extension of Object.values(material.extensions ?? {}))
    for (const key of Object.keys(extension as object))
      if (key.endsWith('Texture')) delete (extension as Record<string, unknown>)[key]
}
const names = (parts.json.materials ?? []).map((m: { name?: string }) => m.name ?? '')
const alpha = (parts.json.materials ?? []).map((m: { alphaMode?: string }) => m.alphaMode ?? 'OPAQUE')
delete parts.json.textures
delete parts.json.images
delete parts.json.samplers

const jet: GLTF = await new Promise((resolve, reject) =>
  new GLTFLoader().parse(repack(parts.json, parts.bin), '', resolve, reject)
)

// the end of the gear family's moving span, as the engine's rig_build and moving_span find it
function moving(track: THREE.KeyframeTrack): [number, number] | null {
  const size = track.getValueSize()
  let first = -1
  let last = -1
  for (let i = 1; i < track.times.length; i++) {
    let moved = false
    for (let k = 0; k < size; k++)
      if (Math.abs(track.values[i * size + k] - track.values[(i - 1) * size + k]) > 1e-5) moved = true
    if (moved) {
      if (first < 0) first = track.times[i - 1]
      last = track.times[i]
    }
  }
  return first < 0 ? null : [first, last]
}

function capture(root: THREE.Object3D) {
  root.updateMatrixWorld(true)
  const meshes: unknown[] = []
  root.traverseVisible((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const geometry = mesh.geometry
    const position = geometry.attributes.position
    const uv = geometry.attributes.uv
    const v = new THREE.Vector3()
    const positions: number[] = []
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld)
      positions.push(+v.x.toFixed(5), +v.y.toFixed(5), +v.z.toFixed(5))
    }
    const material = mesh.material as THREE.MeshStandardMaterial
    const index = geometry.index
    meshes.push({
      name: mesh.name,
      material: material.name,
      alpha: alpha[names.indexOf(material.name)] ?? 'OPAQUE',
      factor: [material.color.r, material.color.g, material.color.b, material.opacity],
      positions,
      uvs: uv ? Array.from(uv.array as ArrayLike<number>, (x) => +x.toFixed(5)) : null,
      indices: index ? Array.from(index.array as ArrayLike<number>) : null,
    })
  })
  return meshes
}

const up = posed(jet)
const down = posed(jet)
const tracks = jet.animations.flatMap((clip) =>
  clip.tracks.filter((track) => GEAR.test(track.name.slice(0, track.name.lastIndexOf('.'))))
)
let end = -Infinity
for (const track of tracks) {
  const span = moving(track)
  if (span && span[1] > end) end = span[1]
}
const mixer = new THREE.AnimationMixer(down)
const action = mixer.clipAction(new THREE.AnimationClip('gear', -1, tracks))
action.play()
action.paused = true
action.time = end
mixer.update(0)

writeFileSync(out, JSON.stringify({ gear: GEAR.source, up: capture(up), down: capture(down) }))
console.log(`posed: gear down at ${end.toFixed(3)} s over ${tracks.length} tracks; wrote ${out}`)
