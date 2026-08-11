// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The setup dialog's live jet (#17 menu rework): a head-on render of the
// airframe wearing the edited loadout, so a station choice reads on the
// aircraft itself instead of through fixture vocabulary. Assets join the
// preload's in-flight downloads; the parsed prototypes are cached at module
// scope so reopening the dialog costs one scene assembly, not a re-parse.
// Rendering is on-demand — one frame per loadout change, no animation loop.

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { asset } from '../game/preload'
import { load, NEUTRAL, POSE, SCRUBS } from '../game/model'
import { ANCHORS, TIPS, entries, normalize } from '../game/stores'
import { normalize_round, amraam_anchor } from '../game/weapons'
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
  })()
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
        // The AMRAAM (#27) at its anchor — inherited from the source art's
        // rounds, derived for the inboard pylons, twin points spread off the
        // single anchor (weapons.ts).
        const point = name.endsWith('a') ? 'a' : name.endsWith('b') ? 'b' : ''
        const anchor = racks ? amraam_anchor(racks, station, point) : null
        if (amraam && anchor) {
          const piece = amraam.clone(true)
          piece.position.copy(anchor)
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

// silhouette reads the rendered frame's alpha and reports the jet's extent:
// width and height as fractions of the frame, and how far the jet's centre
// sits below the frame's centre (fraction of frame height, positive down).
let gauge: HTMLCanvasElement | null = null
function silhouette(source: HTMLCanvasElement): { width: number; height: number; middle: number } | null {
  gauge ??= document.createElement('canvas')
  const w = 200
  const h = Math.max(1, Math.round((w * source.height) / source.width))
  gauge.width = w
  gauge.height = h
  const flat = gauge.getContext('2d', { willReadFrequently: true })
  if (!flat) return null
  flat.clearRect(0, 0, w, h)
  flat.drawImage(source, 0, 0, w, h)
  const data = flat.getImageData(0, 0, w, h).data
  let left = w, right = -1, top = h, bottom = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (x < left) left = x
        if (x > right) right = x
        if (y < top) top = y
        if (y > bottom) bottom = y
      }
    }
  }
  if (right < 0) return null
  return { width: (right - left + 1) / w, height: (bottom - top + 1) / h, middle: ((top + bottom) / 2 - (h - 1) / 2) / h }
}

// frame zooms the head-on camera so the dressed jet FILLS the panel,
// recomputed per loadout so a bare Gun fighter is not dwarfed by the frame a
// full fit needs. A bounding-box fit seeds the distance, then one measured
// pass reads the rendered silhouette and corrects the zoom and the vertical
// centring — the box carries depth and hidden extents the nose-on projection
// never shows, so a pure box fit leaves wide, uneven margins. The eye keeps
// a slight from-below pitch: the belly is where the stores hang, and a
// from-above eye hid the centerline tank behind the nose.
function frame(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, wrap: THREE.Group, aspect: number): void {
  const box = new THREE.Box3().setFromObject(wrap)
  const centre = box.getCenter(new THREE.Vector3())
  const size = box.getSize(new THREE.Vector3())
  const vertical = Math.tan((camera.fov * Math.PI) / 360)
  const pitch = Math.tan((3 * Math.PI) / 180)
  let distance = Math.max(size.z / 2 / (vertical * aspect), size.y / 2 / vertical)
  let level = centre.y
  const aim = () => {
    camera.position.set(centre.x + distance, level - distance * pitch, centre.z)
    camera.lookAt(centre.x, level, centre.z)
  }
  aim()
  // Measured passes until the fill settles: each correction changes the
  // geometry it measured (the eye moves closer and drops less), and the
  // pitched perspective bends the zoom-to-size relation, so one pass
  // overshoots into the frame edge.
  for (let pass = 0; pass < 5; pass++) {
    renderer.render(scene, camera)
    const seen = silhouette(renderer.domElement)
    if (!seen) break
    const fill = Math.max(seen.width, seen.height)
    if (Math.abs(fill - 0.93) < 0.015 && Math.abs(seen.middle) < 0.02) break
    level -= seen.middle * 2 * distance * vertical
    distance *= fill / 0.93
    aim()
  }
}

export function LoadoutPreview({ stores }: { stores: Record<string, StationSlot> }) {
  const mount = useRef<HTMLDivElement>(null)
  const state = useRef<{ renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; jet: THREE.Group; wrap: THREE.Group } | null>(null)
  const wanted = useRef(stores)
  wanted.current = stores

  useEffect(() => {
    const host = mount.current
    if (!host) return
    let gone = false
    const width = host.clientWidth || 480
    // The box is CSS aspect-locked to the head-on silhouette (span to
    // height-with-stores, ~10:3), so the tight frame fills it on BOTH axes
    // at any dialog width — a fixed height went height-limited on wide
    // dialogs and the side margins returned.
    const height = host.clientHeight || Math.round(width * 0.3)
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
    void fetch_models(renderer).then(() => {
      if (gone || !airframe) return
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
      dress(jet, wanted.current)
      frame(renderer, scene, camera, wrap, width / height)
      renderer.render(scene, camera)
    })
    return () => {
      gone = true
      state.current = null
      renderer.dispose()
      renderer.domElement.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const s = state.current
    if (!s) return
    dress(s.jet, stores)
    frame(s.renderer, s.scene, s.camera, s.wrap, s.camera.aspect)
    s.renderer.render(s.scene, s.camera)
  }, [stores])

  return <div ref={mount} className='aspect-[10/3] w-full overflow-hidden' />
}
