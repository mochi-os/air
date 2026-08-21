// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Sandbox-safe GLB loading, shared by the engine and the setup's loadout
// preview. The shell's sandboxed iframe rejects blob: URLs, so the loader's own
// texture path cannot run: strip the texture references, parse, then decode the
// images in-process.

import * as THREE from 'three'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'

export interface Parts {
  json: any
  bin: Uint8Array | null
}

export interface Source {
  bytes: Uint8Array
  mime: string
}

// split opens a GLB container into its JSON and binary chunks.
export function split(ab: ArrayBuffer): Parts {
  const dv = new DataView(ab)
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB')
  let o = 12
  const jsonLen = dv.getUint32(o, true)
  o += 8
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, o, jsonLen)))
  o += jsonLen
  let bin: Uint8Array | null = null
  if (o < ab.byteLength) {
    const binLen = dv.getUint32(o, true)
    o += 8
    bin = new Uint8Array(ab.slice(o, o + binLen))
  }
  return { json, bin }
}

// repack writes a GLB container back from its chunks.
export function repack(json: any, bin: Uint8Array | null): ArrayBuffer {
  const js = new TextEncoder().encode(JSON.stringify(json))
  const jsPad = (4 - (js.length % 4)) % 4
  const jsonLen = js.length + jsPad
  const binLen = bin ? bin.length : 0
  const total = 12 + 8 + jsonLen + (bin ? 8 + binLen : 0)
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, 0x46546c67, true)
  dv.setUint32(4, 2, true)
  dv.setUint32(8, total, true)
  dv.setUint32(12, jsonLen, true)
  dv.setUint32(16, 0x4e4f534a, true)
  out.set(js, 20)
  for (let i = 20 + js.length; i < 20 + jsonLen; i++) out[i] = 0x20
  if (bin) {
    const bo = 20 + jsonLen
    dv.setUint32(bo, binLen, true)
    dv.setUint32(bo + 4, 0x004e4942, true)
    out.set(bin, bo + 8)
  }
  return out.buffer
}

// textures maps each material's baseColor/emissive image bytes by material
// name, following KTX2 sources into the basisu extension.
export function textures(parts: Parts): Record<string, { base: Source | null; emissive: Source | null; hadEmissive: boolean }> {
  const out: Record<string, { base: Source | null; emissive: Source | null; hadEmissive: boolean }> = {}
  const images = parts.json.images || []
  const texturelist = parts.json.textures || []
  const views = parts.json.bufferViews || []
  const image = (ref: any): Source | null => {
    if (!ref || !texturelist[ref.index]) return null
    const t = texturelist[ref.index]
    const si = t.source != null ? t.source : t.extensions && t.extensions.KHR_texture_basisu ? t.extensions.KHR_texture_basisu.source : null
    const im = si != null ? images[si] : null
    if (!im || im.bufferView == null || !parts.bin) return null
    const bv = views[im.bufferView]
    return { bytes: parts.bin.slice(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength), mime: im.mimeType || 'image/jpeg' }
  }
  for (const m of parts.json.materials || []) {
    if (!m.name) continue
    const base = image(m.pbrMetallicRoughness && m.pbrMetallicRoughness.baseColorTexture)
    const emissive = image(m.emissiveTexture)
    if (base || emissive) out[m.name] = { base, emissive, hadEmissive: !!m.emissiveTexture }
  }
  return out
}

// strip removes every texture reference so parse() never builds a blob URL.
export function strip(json: any): void {
  for (const m of json.materials || []) {
    if (m.pbrMetallicRoughness) {
      delete m.pbrMetallicRoughness.baseColorTexture
      delete m.pbrMetallicRoughness.metallicRoughnessTexture
    }
    delete m.normalTexture
    delete m.occlusionTexture
    delete m.emissiveTexture
    for (const ext of Object.values(m.extensions || {})) {
      for (const key of Object.keys(ext as object)) {
        if (key.endsWith('Texture')) delete (ext as Record<string, unknown>)[key]
      }
    }
  }
  delete json.textures
  delete json.images
  delete json.samplers
}

// parse runs the GLTFLoader (meshopt-aware) over already-clean GLB bytes.
export function parse(clean: ArrayBuffer): Promise<GLTF> {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader()
    loader.setMeshoptDecoder(MeshoptDecoder)
    loader.parse(clean, '', resolve, (error) => reject(new Error((error && (error as ErrorEvent).message) || 'bad glTF')))
  })
}

// fa18c model-preparation data shared by the engine's AIRCRAFT_MODELS spec and
// the setup preview. POSE: the stabs' shared parent is authored mid-animation
// 180°-flipped, so this is its animation END key. GEAR: the landing-gear track
// family.
export const POSE: { node: string; quaternion: [number, number, number, number] }[] = [
  { node: 'elevator_percent_key_AN_238_100', quaternion: [0, -0.996, 0.087, 0] },
]
export const GEAR = /(^|_)[clr]_(gear|wheel)_AN_/i

// SCRUBS: the engine's scrubbed-clip track families (AIRCRAFT_MODELS fa18c
// rig). Each family's timeline holds its NEUTRAL value at the first key, while
// some authored static poses rest deployed. Keep in sync when the engine gains
// a family.
export const SCRUBS: RegExp[] = [
  GEAR,
  /^Hook_AN_/i,
  /^RefuelDoorAction_AN/i,
  /^Canopy_ParentAction_AN/i,
  /^EXHAUSTS_/i,
  /wing_outer_AN/i,
  /^c_launch_bar_AN/i,
  /^SPOILER_L/i,
]

// NEUTRAL: the direct-driven control surfaces' neutral base quaternions (x, y,
// z, w), mirrored from the engine's rig entries - the authored static poses
// rest deflected. Keep in sync with AIRCRAFT_MODELS fa18c.
export const NEUTRAL: { node: string; quaternion: [number, number, number, number] }[] = [
  { node: 'Elevator_Left_94', quaternion: [0.96593, 0, 0, 0.25882] },
  { node: 'Elevator_right_97', quaternion: [0.96502, 0, 0, 0.26219] },
  { node: 'AileronL_69', quaternion: [-0.17365, 0, 0, 0.98481] },
  { node: 'AileronR_309', quaternion: [-0.17365, 0, 0, 0.98481] },
  { node: 'rudder_percent_key_AN_Left_319', quaternion: [0, 0.15471, 0, 0.98796] },
  { node: 'rudder_percent_key_AN_Right_322', quaternion: [0, 0.19423, 0, 0.98096] },
]

// decode turns captured image bytes into a texture: KTX2 through the transcoder
// (self-hosted under basis/), everything else through createImageBitmap. glTF
// UVs are NOT flipped - a flipped decode scrambles the livery atlas.
async function decode(ktx2: KTX2Loader, src: Source, srgb: boolean): Promise<THREE.Texture> {
  if (src.mime === 'image/ktx2') {
    const loaderInternal = ktx2 as unknown as { _createTexture(buffer: ArrayBuffer): Promise<THREE.Texture> }
    const bytes = src.bytes
    const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer
    const texture = await loaderInternal._createTexture(buffer as ArrayBuffer)
    texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping
    texture.needsUpdate = true
    return texture
  }
  const bitmap = await createImageBitmap(new Blob([src.bytes as unknown as BlobPart], { type: src.mime }))
  const texture = new THREE.Texture(bitmap as unknown as HTMLImageElement)
  texture.flipY = false
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.needsUpdate = true
  return texture
}

// load runs the whole pipeline for a standalone consumer (the setup preview):
// bytes to a textured scene. The engine keeps its own pipeline with per-jet
// extras and shares only split/repack/textures.
export async function load(ab: ArrayBuffer, renderer: THREE.WebGLRenderer): Promise<GLTF> {
  const parts = split(ab)
  const captured = textures(parts)
  strip(parts.json)
  const gltf = await parse(repack(parts.json, parts.bin))
  const ktx2 = new KTX2Loader().setTranscoderPath('basis/').detectSupport(renderer)
  const decoded: Record<string, { base: THREE.Texture | null; emissive: THREE.Texture | null; hadEmissive: boolean }> = {}
  await Promise.all(
    Object.keys(captured).map(async (name) => {
      try {
        decoded[name] = {
          base: captured[name].base ? await decode(ktx2, captured[name].base!, true) : null,
          emissive: captured[name].emissive ? await decode(ktx2, captured[name].emissive!, true) : null,
          hadEmissive: captured[name].hadEmissive,
        }
      } catch (error) {
        decoded[name] = { base: null, emissive: null, hadEmissive: captured[name].hadEmissive }
        console.warn('[model] texture decode failed for ' + name, (error as Error)?.message || error)
      }
    })
  )
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.material) return
    for (const mm of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const m = mm as THREE.MeshStandardMaterial
      const d = decoded[m.name]
      if (d && d.base) m.map = d.base
      if (d && d.emissive) {
        m.emissiveMap = d.emissive
        m.emissiveIntensity = Math.min(m.emissiveIntensity || 1, 1.1) // cap: a hot emissive blows to white under tone mapping
      } else if (d && d.hadEmissive && m.emissive) {
        m.emissive.setRGB(0, 0, 0) // emissive texture stripped and unrestorable: black it out rather than glow flat white — the untextured-white-fuselage failure
      }
      if (m.metalness !== undefined && !/glass|screen|oleo|gear/i.test(m.name || '')) {
        m.metalness = 0.0
        m.roughness = 0.88
      }
      m.needsUpdate = true
    }
  })
  ktx2.dispose()
  return gltf
}
