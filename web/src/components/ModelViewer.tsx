// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
// The model viewer (/air/models): every model the game ships, one at a time,
// to orbit, pan and zoom around. A developer page, English only by decision.
// Models come from the same parse library as the flight, so what shows here is
// what the game draws.
import { useEffect, useRef, useState } from 'react'
import {
  naturalCompare,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useFormat,
} from '@mochi/web'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import amraam_model_url from '../assets/aim120c.glb?url'
import fa18c_model_url from '../assets/fa18c.glb?url'
import nimitz_model_url from '../assets/nimitz.glb?url'
import stores_model_url from '../assets/stores.glb?url'
import { model } from '../game/library'
import { posed } from '../game/model'
import { normalize_round } from '../game/weapons'

interface Entry {
  name: string // the asset's file name: the bundle serves it under a content-hashed one
  url: string
  prepare: (gltf: GLTF) => THREE.Object3D // a clone: the library's stock is shared and never changed in place
}

const MODELS: Entry[] = [
  {
    name: 'aim120c.glb',
    url: amraam_model_url,
    prepare: (gltf: GLTF) => normalize_round(gltf.scene.clone(true)),
  },
  { name: 'fa18c.glb', url: fa18c_model_url, prepare: posed },
  {
    name: 'stores.glb',
    url: stores_model_url,
    prepare: (gltf: GLTF) => gltf.scene.clone(true),
  },
  {
    name: 'nimitz.glb',
    url: nimitz_model_url,
    prepare: (gltf: GLTF) => gltf.scene.clone(true),
  },
].sort((a, b) => naturalCompare(a.name, b.name))

interface View {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  shown: THREE.Object3D | null
  radius: number
  draw: () => void
}

// polygons counts the triangles the model draws.
function polygons(object: THREE.Object3D): number {
  let count = 0
  object.traverseVisible((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    const index = mesh.geometry.index
    const position = mesh.geometry.attributes.position
    count += Math.floor(
      (index ? index.count : position ? position.count : 0) / 3
    )
  })
  return count
}

// frame puts the camera on a three-quarter view from above, orbiting the
// model's centre, at the distance where its box fills most of the screen: the
// bounding sphere alone leaves a long ship a third of the width.
function frame(view: View, object: THREE.Object3D): void {
  const { camera, controls } = view
  const box = new THREE.Box3().setFromObject(object)
  const sphere = box.getBoundingSphere(new THREE.Sphere())
  const radius = sphere.radius || 1
  const along = new THREE.Vector3(1, 0.6, 1).normalize()
  let distance = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.05
  const corner = new THREE.Vector3()
  view.radius = radius
  controls.target.copy(sphere.center)
  for (let pass = 0; pass < 4; pass++) {
    camera.position.copy(sphere.center).addScaledVector(along, distance)
    camera.lookAt(sphere.center)
    camera.near = distance / 1000
    camera.far = distance + radius * 4
    camera.updateMatrixWorld(true)
    camera.updateProjectionMatrix()
    let fill = 0
    for (let k = 0; k < 8; k++) {
      corner
        .set(
          k & 1 ? box.max.x : box.min.x,
          k & 2 ? box.max.y : box.min.y,
          k & 4 ? box.max.z : box.min.z
        )
        .project(camera)
      fill = Math.max(fill, Math.abs(corner.x), Math.abs(corner.y))
    }
    distance *= fill / 0.85
  }
  camera.position.copy(sphere.center).addScaledVector(along, distance)
  controls.minDistance = radius / 1000
  controls.maxDistance = distance * 10
  controls.update()
}

// file is the model the URL names (?file=nimitz.glb); an unknown or missing one shows
// the first. onFile puts a switch back in the URL, so a view can be linked to.
export function ModelViewer({
  file,
  onFile,
}: {
  file?: string
  onFile: (file: string) => void
}) {
  const mount = useRef<HTMLDivElement>(null)
  const view = useRef<View | null>(null)
  const chosen = (MODELS.find((m) => m.name === file) ?? MODELS[0]).name
  const [status, setStatus] = useState('Loading…') // empty once the model is drawn
  const [count, setCount] = useState<number | null>(null) // the shown model's polygons
  const { formatNumber } = useFormat()

  useEffect(() => {
    const host = mount.current
    if (!host) return
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true })
    } catch {
      setStatus('WebGL is not available in this browser')
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setClearColor(0x6b7680)
    renderer.domElement.style.display = 'block'
    host.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    scene.add(new THREE.HemisphereLight(0xdfe8f2, 0x54595e, 2.2))
    // A light carried by the camera, up and to the left of it: whatever side
    // the model is turned to is the lit side.
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000)
    const lamp = new THREE.DirectionalLight(0xffffff, 2.0)
    lamp.position.set(-1, 1, 0)
    lamp.target.position.set(0, 0, -1)
    camera.add(lamp, lamp.target)
    scene.add(camera)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.zoomToCursor = true // a carrier is 333 m long: zooming into the middle of it would never reach the part under the pointer
    const current: View = {
      renderer,
      scene,
      camera,
      controls,
      shown: null,
      radius: 1,
      draw: () => {
        // The clip planes follow the zoom, so a detail a metre away and the
        // far end of the ship both keep their depth precision.
        const distance = camera.position.distanceTo(controls.target)
        camera.near = Math.max(current.radius / 1e5, distance / 1000)
        camera.far = distance + current.radius * 4
        camera.updateProjectionMatrix()
        renderer.render(scene, camera)
      },
    }
    controls.addEventListener('change', current.draw)
    const fit = () => {
      const width = host.clientWidth
      const height = host.clientHeight
      if (!width || !height) return
      renderer.setSize(width, height)
      camera.aspect = width / height
      current.draw()
    }
    const observer = new ResizeObserver(fit)
    observer.observe(host)
    fit()
    view.current = current
    return () => {
      observer.disconnect()
      controls.dispose()
      view.current = null
      // dispose() does not hand the WebGL context back; forceContextLoss
      // first, as the loadout preview does.
      renderer.forceContextLoss()
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [])

  useEffect(() => {
    const current = view.current
    if (!current) return
    const entry = MODELS.find((m) => m.name === chosen)
    if (!entry) return
    let wanted = true
    setStatus('Loading…')
    setCount(null)
    model(entry.url, current.renderer).then(
      (gltf) => {
        if (!wanted || view.current !== current) return
        if (current.shown) current.scene.remove(current.shown)
        current.shown = entry.prepare(gltf)
        current.scene.add(current.shown)
        frame(current, current.shown)
        current.draw()
        setCount(polygons(current.shown))
        setStatus('')
      },
      (error) => {
        if (wanted)
          setStatus(
            `Could not load ${entry.name}: ${(error as Error)?.message || error}`
          )
      }
    )
    return () => {
      wanted = false
    }
  }, [chosen])

  return (
    <div className='bg-background fixed inset-0'>
      <div ref={mount} className='absolute inset-0' />
      {/* Top right: the shell's menu sits over the top-left corner. */}
      <div className='absolute end-4 top-4 flex flex-col items-end gap-1'>
        <Select value={chosen} onValueChange={onFile}>
          <SelectTrigger className='bg-background w-56'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODELS.map((m) => (
              <SelectItem key={m.name} value={m.name}>
                {m.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {count !== null && (
          <div className='font-mono text-sm text-white'>
            {/* jsx-text-ok: developer page, English only by decision */}
            {formatNumber(count)} polygons
          </div>
        )}
      </div>
      {status && (
        <div className='pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-sm text-white/80'>
          {status}
        </div>
      )}
    </div>
  )
}
