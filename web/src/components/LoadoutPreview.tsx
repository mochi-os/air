// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
// The setup dialog's live jet: a head-on render of the airframe wearing the
// edited loadout. The models come parsed from the library, shared with the
// flight and warmed by the menu; the posed clones are kept at module scope so
// reopening the dialog costs one scene assembly; rendering is on demand, one
// frame per loadout change. Until the first render the box says it is loading.
import { useEffect, useRef, useState } from 'react'
import { Trans } from '@lingui/react/macro'
import { flushSync } from 'react-dom'
import * as THREE from 'three'
import fa18c_points from '../assets/fa18c.json'
import fa18c_model_url from '../assets/fa18c.glb?url'
import aim120c_points from '../assets/aim120c.json'
import aim120c_model_url from '../assets/aim120c.glb?url'
import aim9m_points from '../assets/aim9m.json'
import aim9m_model_url from '../assets/aim9m.glb?url'
import { parts, place, rounds, type Kind, type Seat } from '../game/hang'
import { model } from '../game/library'
import { normalize } from '../game/stores'
import type { StationSlot } from '../lib/config'

// Our own jet and missiles (claude/plans/air-fa18c.md #9), with their points
// files: the store parts the jet carries and where each round hangs.
const JET = fa18c_points as unknown as { points: { stores: string[]; hardpoints: Record<string, { rounds: Record<string, Seat> }> } }
const MOUNTS: Record<Kind, number[]> = {
  aim9m: (aim9m_points as unknown as { points: { mount: number[] } }).points.mount,
  aim120c: (aim120c_points as unknown as { points: { mount: number[] } }).points.mount,
}

let airframe: THREE.Group | null = null
let missiles: Record<Kind, THREE.Group> | null = null
let loading: Promise<void> | null = null

function fetch_models(renderer: THREE.WebGLRenderer): Promise<void> {
  loading ??= (async () => {
    const [jet, nine, amraam] = await Promise.all([
      model(fa18c_model_url, renderer),
      model(aim9m_model_url, renderer),
      model(aim120c_model_url, renderer),
    ])
    airframe = jet.scene.clone(true)
    missiles = { aim9m: nine.scene.clone(true), aim120c: amraam.scene.clone(true) }
  })().catch((error) => {
    // A failed download must not be kept. preload.ts already drops its own
    // entry so the next open refetches; holding the rejected promise here
    // would defeat that for the rest of the session.
    loading = null
    throw error
  })
  return loading
}

// origin is a node's origin at rest in the jet's frame: every part rests
// unturned, so it is the sum of the rest positions up to the jet's root.
function origin(node: THREE.Object3D, root: THREE.Object3D): THREE.Vector3 {
  const at = new THREE.Vector3()
  for (let o: THREE.Object3D | null = node; o && o !== root; o = o.parent) at.add(o.position)
  return at
}

// dress hangs the loadout on the jet as the flight does (hang.ts): the store
// parts its stations show, the rest hidden, and each round's missile laid on
// its seat beside its part.
function dress(jet: THREE.Group, stores: Record<string, StationSlot>): void {
  for (const old of (jet.userData.rounds as THREE.Object3D[] | undefined) ?? []) old.parent?.remove(old)
  const hung: THREE.Object3D[] = []
  const loadout = normalize(stores)
  const shown = new Set<string>()
  for (let station = 1; station <= 9; station++) {
    const slot = loadout[String(station)]
    for (const part of parts(station, slot)) shown.add(part)
    const seats = JET.points.hardpoints[String(station)]?.rounds ?? {}
    for (const r of rounds(station, slot)) {
      const part = jet.getObjectByName(r.part)
      const seat = seats[r.part]
      if (!part?.parent || !seat || !missiles) continue
      const piece = missiles[r.kind].clone(true)
      const at = place(seat, MOUNTS[r.kind])
      piece.position.copy(at.position).sub(origin(part.parent, jet))
      piece.quaternion.copy(at.quaternion)
      part.parent.add(piece)
      hung.push(piece)
    }
  }
  for (const name of JET.points.stores) {
    const part = jet.getObjectByName(name)
    if (part) part.visible = shown.has(name)
  }
  jet.userData.rounds = hung
}

// extent projects the visible meshes' vertices through the camera and reports
// the silhouette's NDC half-width, half-height and vertical midpoint. Uses the
// INDEX (the split stores models share one vertex buffer across stations).
// Bounding-box corners overshoot the silhouette and pixel readback fails
// silently on some machines, so sampled geometry it is.
function extent(
  wrap: THREE.Group,
  camera: THREE.PerspectiveCamera
): { width: number; height: number; middle: number } | null {
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
  return {
    width: widest,
    height: Math.max(Math.abs(low), Math.abs(high)),
    middle: (low + high) / 2,
  }
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
function frame(
  camera: THREE.PerspectiveCamera,
  wrap: THREE.Group,
  aspect: number
): void {
  const box = new THREE.Box3().setFromObject(wrap)
  const centre = box.getCenter(new THREE.Vector3())
  const size = box.getSize(new THREE.Vector3())
  const vertical = Math.tan((camera.fov * Math.PI) / 360)
  const pitch = Math.tan((3 * Math.PI) / 180)
  let distance =
    Math.max(size.z / 2 / (vertical * aspect), size.y / 2 / vertical) * 1.06 +
    size.x / 4
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

export function LoadoutPreview({
  stores,
}: {
  stores: Record<string, StationSlot>
}) {
  const mount = useRef<HTMLDivElement>(null)
  const state = useRef<{
    renderer: THREE.WebGLRenderer
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    jet: THREE.Group
    wrap: THREE.Group
  } | null>(null)
  const wanted = useRef(stores)
  wanted.current = stores
  const shape = JSON.stringify(normalize(stores))
  const [ready, setReady] = useState(false) // the first render is in, or the models failed and the box stays blank as before

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
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        preserveDrawingBuffer: true,
      })
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
        flushSync(() => setReady(true)) // committed now, not a frame later: the line must not sit over the jet drawn below
        // Closed before the models arrived: the cleanup below already ran and had
        // to leave the context alone, so release it here instead. dispose() does
        // not touch the extension registry, so this still reaches it.
        if (gone) return void renderer.forceContextLoss()
        // All three, not the airframe alone: a run that parsed the jet and
        // then failed on a missile would otherwise draw a bare jet and frame
        // the camera against it, which reads as an empty loadout rather than a
        // preview that could not be built.
        if (!airframe || !missiles) return
        const scene = new THREE.Scene()
        scene.add(new THREE.HemisphereLight(0xdfe8f2, 0x54595e, 2.4))
        const sun = new THREE.DirectionalLight(0xffffff, 2.2)
        sun.position.set(3, 4, 2)
        scene.add(sun)
        const jet = airframe.clone(true)
        // Normalize head-on: centre the model, its nose along +x toward the
        // camera as it is built.
        const box = new THREE.Box3().setFromObject(jet)
        const size = box.getSize(new THREE.Vector3())
        const centre = box.getCenter(new THREE.Vector3())
        jet.position.set(-centre.x, -centre.y, -centre.z)
        const wrap = new THREE.Group()
        wrap.add(jet)
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

  return (
    <div className='relative w-full'>
      <div ref={mount} className='aspect-[29/10] w-full overflow-hidden' />
      {!ready && (
        <div className='pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-xs text-white/60'>
          <Trans>Loading aircraft</Trans>
        </div>
      )}
    </div>
  )
}
