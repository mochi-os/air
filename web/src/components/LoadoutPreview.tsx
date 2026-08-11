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
        // The AMRAAM (#27) at the station's anchor — inherited from the
        // source art's rounds, derived for the inboard pylons (weapons.ts).
        const anchor = racks ? amraam_anchor(racks, station) : null
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

export function LoadoutPreview({ stores }: { stores: Record<string, StationSlot> }) {
  const mount = useRef<HTMLDivElement>(null)
  const state = useRef<{ renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; jet: THREE.Group } | null>(null)
  const wanted = useRef(stores)
  wanted.current = stores

  useEffect(() => {
    const host = mount.current
    if (!host) return
    let gone = false
    const width = host.clientWidth || 480
    const height = 130
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
      // Normalize head-on: centre the model, face the nose at the camera
      // (the raw scene needs the same +90 yaw the engine applies), and frame
      // the full span.
      const box = new THREE.Box3().setFromObject(jet)
      const size = box.getSize(new THREE.Vector3())
      const centre = box.getCenter(new THREE.Vector3())
      jet.position.set(-centre.x, -centre.y, -centre.z)
      const wrap = new THREE.Group()
      wrap.add(jet)
      wrap.rotation.y = Math.PI / 2
      wrap.scale.setScalar(10 / Math.max(size.x, size.y, size.z, 1e-3))
      scene.add(wrap)
      // Nose-on from slightly BELOW: the belly is where the stores hang, and
      // a from-above eye hid the centerline tank behind the nose. The narrow
      // lens fills the panel with the wingspan without fisheye at this range.
      const camera = new THREE.PerspectiveCamera(18, width / height, 0.1, 100)
      camera.position.set(9.0, -0.85, 0)
      camera.lookAt(0, -0.38, 0)
      state.current = { renderer, scene, camera, jet }
      dress(jet, wanted.current)
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
    s.renderer.render(s.scene, s.camera)
  }, [stores])

  return <div ref={mount} className='h-[130px] w-full overflow-hidden' />
}
