// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The setup dialog's live jet: a head-on render of the airframe wearing the
// edited loadout. Parsed prototypes are cached at module scope so reopening the
// dialog costs one scene assembly; rendering is on demand, one frame per
// loadout change.

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { asset } from '../game/preload'
import { load, NEUTRAL, POSE, SCRUBS } from '../game/model'
import { ANCHORS, TIPS, entries, normalize } from '../game/stores'
import { normalize_round, amraam_anchor, amraam_aim } from '../game/weapons'
import type { StationSlot } from '../lib/config'
import fa18c_model_url from '../assets/fa18c.glb?url'
import stores_model_url from '../assets/stores.glb?url'
import amraam_model_url from '../assets/aim120c.glb?url'

let airframe: THREE.Group | null = null
let racks: THREE.Group | null = null
let amraam: THREE.Group | null = null
let loading: Promise<void> | null = null

function fetch_models(renderer: THREE.WebGLRenderer): Promise<void> {
  loading ??= (async () => {
    const [jet, stores, round] = await Promise.all([asset(fa18c_model_url), asset(stores_model_url), asset(amraam_model_url)])
    const parsed = await load(jet, renderer)
    airframe = parsed.scene
    for (const fix of POSE) {
      // The same static pose corrections the engine applies before anything
      // else — without them the stabs render planform-reversed.
      const node = airframe.getObjectByName(fix.node)
      if (node) node.quaternion.set(...fix.quaternion)
    }
    // Neutral-scrub every animated family to its first key: some authored
    // STATIC poses rest deployed (the port spoiler plate); the engine drives
    // these per-frame, the preview poses them once.
    const mixer = new THREE.AnimationMixer(airframe)
    for (const family of SCRUBS) {
      const tracks = parsed.animations.flatMap((clip) => clip.tracks.filter((track) => family.test(track.name.slice(0, track.name.lastIndexOf('.')))))
      if (!tracks.length) continue
      const action = mixer.clipAction(new THREE.AnimationClip('prep', -1, tracks))
      action.play()
      action.paused = true
      action.time = tracks[0].times[0]
    }
    mixer.update(0)
    for (const rest of NEUTRAL) {
      // Direct-driven surfaces (stabs, ailerons, rudders) to their neutral —
      // the mixer never touches these; the engine drives them per frame.
      const node = airframe.getObjectByName(rest.node)
      if (node) node.quaternion.set(...rest.quaternion)
    }
    racks = (await load(stores, renderer)).scene
    amraam = normalize_round((await load(round, renderer)).scene)
  })().catch((error) => {
    // A failed download must not be kept. preload.ts already drops its own
    // entry so the next open refetches; holding the rejected promise here
    // would defeat that for the rest of the session.
    loading = null
    throw error
  })
  return loading
}

// dress hangs the loadout on the jet: per-station clones from the split
// stores.glb, tip visibility, and AIM-9 rounds as translated clones of the
// jet's own tip missile mesh — the same node names and anchors the engine
// uses (stores.ts), so the preview and the flown jet cannot disagree.
function dress(jet: THREE.Group, stores: Record<string, StationSlot>): void {
  const previous = jet.getObjectByName('loadout')
  if (previous) jet.remove(previous)
  const holder = new THREE.Group()
  holder.name = 'loadout'
  const loadout = normalize(stores)
  const tips: Record<string, boolean> = { tip1: false, tip9: false }
  for (let station = 1; station <= 9; station++) {
    for (const name of entries(station, loadout[String(station)])) {
      if (name.startsWith('tip')) {
        tips[name] = true
        continue
      }
      if (name.startsWith('rail') || name.startsWith('twin') || name.startsWith('pylon')) {
        const piece = racks?.getObjectByName('Pylon_' + station)
        if (piece) holder.add(piece.clone(true))
      } else if (name.startsWith('tank')) {
        const piece = racks?.getObjectByName('Tank_' + station)
        if (piece) holder.add(piece.clone(true))
      } else if (name.startsWith('120c')) {
        // The AMRAAM (#27) at its anchor and the art's own lean — position
        // inherited from the source art's rounds, derived for the inboard
        // pylons, twin points spread off the single anchor, orientation from
        // the source round's long axis (weapons.ts).
        const point = name.endsWith('a') ? 'a' : name.endsWith('b') ? 'b' : ''
        const anchor = racks ? amraam_anchor(racks, station, point) : null
        if (amraam && anchor && racks) {
          const piece = amraam.clone(true)
          piece.position.copy(anchor)
          piece.quaternion.copy(amraam_aim(racks, station))
          holder.add(piece)
        }
      } else if (ANCHORS[name]) {
        const source = jet.getObjectByName(station < 5 ? TIPS.tip1 : TIPS.tip9) as THREE.Mesh | null
        if (source && source.isMesh) {
          if (!source.geometry.boundingBox) source.geometry.computeBoundingBox()
          const centre = source.geometry.boundingBox!.getCenter(new THREE.Vector3())
          const round = new THREE.Mesh(source.geometry, source.material)
          const anchor = ANCHORS[name]
          round.position.set(anchor[0] - centre.x, anchor[1] - centre.y, anchor[2] - centre.z)
          holder.add(round)
        }
      }
    }
  }
  for (const [tip, node] of Object.entries(TIPS)) {
    const mesh = jet.getObjectByName(node)
    if (mesh) mesh.visible = tips[tip]
  }
  jet.add(holder)
}

// extent projects the visible meshes' vertices through the camera and reports
// the silhouette's NDC half-width, half-height and vertical midpoint. Uses the
// INDEX (the split stores models share one vertex buffer across stations).
// Bounding-box corners overshoot the silhouette and pixel readback fails
// silently on some machines, so sampled geometry it is.
function extent(wrap: THREE.Group, camera: THREE.PerspectiveCamera): { width: number; height: number; middle: number } | null {
  camera.updateMatrixWorld(true)
  wrap.updateMatrixWorld(true)
  const v = new THREE.Vector3()
  let widest = -Infinity
  let low = Infinity
  let high = -Infinity
  wrap.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.visible) return
    const pos = mesh.geometry?.attributes?.position
    if (!pos) return
    const idx = mesh.geometry.index
    const total = idx ? idx.count : pos.count
    const stride = Math.max(1, Math.floor(total / 1500))
    for (let k = 0; k < total; k += stride) {
      v.fromBufferAttribute(pos, idx ? idx.getX(k) : k)
      mesh.localToWorld(v).project(camera)
      if (Math.abs(v.x) > widest) widest = Math.abs(v.x)
      if (v.y < low) low = v.y
      if (v.y > high) high = v.y
    }
  })
  if (widest < 0) return null
  return { width: widest, height: Math.max(Math.abs(low), Math.abs(high)), middle: (low + high) / 2 }
}

// FULLEST is the maximal carriage envelope. The camera is framed once against
// it and then fixed, so the airframe never shifts or rescales as stations
// change. The panel aspect makes this fit width-limited.
const FULLEST = normalize({
  1: { fixture: 'rail', stores: ['9m'] },
  2: { fixture: 'twin', stores: ['120c', '120c'] },
  3: { fixture: 'twin', stores: ['120c', '120c'] },
  4: { fixture: 'rail', stores: ['120c'] },
  5: { fixture: 'pylon', stores: ['tank'] },
  6: { fixture: 'rail', stores: ['120c'] },
  7: { fixture: 'twin', stores: ['120c', '120c'] },
  8: { fixture: 'twin', stores: ['120c', '120c'] },
  9: { fixture: 'rail', stores: ['9m'] },
})

// frame zooms the head-on camera so the dressed jet fills the panel: a
// bounding-box fit seeds the distance, then projected-geometry passes settle
// zoom and vertical centring (each correction changes what it corrected, so it
// loops to convergence). The slight from-below pitch keeps the centerline tank
// visible.
function frame(camera: THREE.PerspectiveCamera, wrap: THREE.Group, aspect: number): void {
  const box = new THREE.Box3().setFromObject(wrap)
  const centre = box.getCenter(new THREE.Vector3())
  const size = box.getSize(new THREE.Vector3())
  const vertical = Math.tan((camera.fov * Math.PI) / 360)
  const pitch = Math.tan((3 * Math.PI) / 180)
  let distance = Math.max(size.z / 2 / (vertical * aspect), size.y / 2 / vertical) * 1.06 + size.x / 4
  let level = centre.y
  const aim = () => {
    camera.position.set(centre.x + distance, level - distance * pitch, centre.z)
    camera.lookAt(centre.x, level, centre.z)
  }
  aim()
  for (let pass = 0; pass < 4; pass++) {
    const seen = extent(wrap, camera)
    if (!seen) break
    const fill = Math.max(seen.width, seen.height)
    if (Math.abs(fill - 0.93) < 0.015 && Math.abs(seen.middle) < 0.04) break
    level += seen.middle * distance * vertical
    distance *= fill / 0.93
    aim()
  }
}

export function LoadoutPreview({ stores }: { stores: Record<string, StationSlot> }) {
  const mount = useRef<HTMLDivElement>(null)
  const state = useRef<{ renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; jet: THREE.Group; wrap: THREE.Group } | null>(null)
  const wanted = useRef(stores)
  wanted.current = stores
  const shape = JSON.stringify(normalize(stores))

  useEffect(() => {
    const host = mount.current
    if (!host) return
    let gone = false
    const width = host.clientWidth || 480
    // The box is CSS aspect-locked just below the fullest fit's silhouette
    // aspect (~3.1) so the fixed frame stays width-limited at any dialog width;
    // a fixed height went height-limited on wide dialogs.
    const height = host.clientHeight || Math.round(width / 2.9)
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
    } catch {
      return // no WebGL 2 (#55): the setup dialog stands without its preview; the menu banner explains
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setSize(width, height)
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = height + 'px'
    renderer.domElement.dataset.preview = 'loadout'
    host.appendChild(renderer.domElement)
    let settled = false
    void fetch_models(renderer)
      // A failed download still has to hand the context back: an unhandled
      // rejection would skip the body below, leave settled false, and the
      // cleanup would then keep the context live for the rest of the session.
      .catch(() => {})
      .then(() => {
        settled = true
        // Closed before the models arrived: the cleanup below already ran and had
        // to leave the context alone, so release it here instead. dispose() does
        // not touch the extension registry, so this still reaches it.
        if (gone) return void renderer.forceContextLoss()
        // All three, not the airframe alone: a run that parsed the jet and
        // then failed on the stores would otherwise draw a bare jet and frame
        // the camera against it, which reads as an empty loadout rather than a
        // preview that could not be built.
        if (!airframe || !racks || !amraam) return
        const scene = new THREE.Scene()
        scene.add(new THREE.HemisphereLight(0xdfe8f2, 0x54595e, 2.4))
        const sun = new THREE.DirectionalLight(0xffffff, 2.2)
        sun.position.set(3, 4, 2)
        scene.add(sun)
        const jet = airframe.clone(true)
        // Normalize head-on: centre the model and face the nose at the camera
        // (the raw scene needs the same +90 yaw the engine applies).
        const box = new THREE.Box3().setFromObject(jet)
        const size = box.getSize(new THREE.Vector3())
        const centre = box.getCenter(new THREE.Vector3())
        jet.position.set(-centre.x, -centre.y, -centre.z)
        const wrap = new THREE.Group()
        wrap.add(jet)
        wrap.rotation.y = Math.PI / 2
        wrap.scale.setScalar(10 / Math.max(size.x, size.y, size.z, 1e-3))
        scene.add(wrap)
        const camera = new THREE.PerspectiveCamera(18, width / height, 0.1, 100)
        state.current = { renderer, scene, camera, jet, wrap }
        dress(jet, FULLEST)
        frame(camera, wrap, width / height)
        dress(jet, wanted.current)
        renderer.render(scene, camera)
      })
    return () => {
      gone = true
      state.current = null
      // dispose() does NOT hand the context back, and a page is allowed about
      // sixteen live ones before the browser force-loses the OLDEST, which once
      // the player is flying is the game's. forceContextLoss first, the order
      // three's own TextureUtils uses.
      if (settled) renderer.forceContextLoss()
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [])

  useEffect(() => {
    const s = state.current
    if (!s) return
    dress(s.jet, wanted.current)
    s.renderer.render(s.scene, s.camera) // the camera stays where FULLEST framed it — the jet never moves
  }, [shape])

  return <div ref={mount} className='aspect-[29/10] w-full overflow-hidden' />
}
