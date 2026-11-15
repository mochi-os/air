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
import { Button } from '@mochi/web/components/ui/button'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import amraam_model_url from '../assets/aim120c.glb?url'
import fa18c_model_url from '../assets/fa18c.glb?url'
import fa18c_old_url from '../assets/fa18c-old.glb?url'
import ford_model_url from '../assets/ford.glb?url'
import ford_ship from '../assets/ford.json'
import aim9m_model_url from '../assets/aim9m.glb?url'
import aim9m_points from '../assets/aim9m.json'
import aim120c_points from '../assets/aim120c.json'
import fa18c_points from '../assets/fa18c.json'
import * as cycle from '../game/cycle'
import { outfit, type Fittings, type Kind, type Seat } from '../game/hang'
import { pose, rig, type Joint, type Posed } from '../game/joints'
import { model } from '../game/library'
import { posed } from '../game/model'
import { deflectors, layout, meatball, raising, stations } from '../game/ship'
import { PRESETS, SHOWCASE, type Loadout } from '../game/stores'

interface Entry {
  name: string // the asset's file name: the bundle serves it under a content-hashed one
  url: string
  prepare: (gltf: GLTF) => THREE.Object3D // a clone: the library's stock is shared and never changed in place
}

// The jet's points for hanging its loadout (hang.ts), and the loadouts its
// button steps through: the setup's presets, and one of each kind of store.
const FITTINGS: Fittings = {
  ...(fa18c_points as unknown as { points: { stores: string[]; hardpoints: Record<string, { rounds: Record<string, Seat> }> } }).points,
  mounts: {
    aim9m: (aim9m_points as unknown as { points: { mount: number[] } }).points.mount,
    aim120c: (aim120c_points as unknown as { points: { mount: number[] } }).points.mount,
  },
}
const LOADOUTS: { name: string; stores: Loadout }[] = [
  { name: 'clean', stores: PRESETS.gun },
  { name: 'Fox 2', stores: PRESETS.fox2 },
  { name: 'Fox 3', stores: PRESETS.fox3 },
  { name: 'showcase', stores: SHOWCASE },
]

const MODELS: Entry[] = [
  // Our own missiles as tools/missiles/build.py builds them, at rest.
  { name: 'aim120c.glb', url: amraam_model_url, prepare: (gltf: GLTF) => gltf.scene.clone(true) },
  { name: 'aim9m.glb', url: aim9m_model_url, prepare: (gltf: GLTF) => gltf.scene.clone(true) },
  // Our own F/A-18C as tools/fa18c/build.py builds it, at rest: gear up, every
  // surface neutral, clean (its stores hidden but the wingtip rails) until its
  // button hangs a loadout.
  {
    name: 'fa18c.glb',
    url: fa18c_model_url,
    prepare: (gltf: GLTF) => {
      const jet = gltf.scene.clone(true)
      for (const name of (fa18c_points as unknown as { points: { stores: string[] } }).points.stores) {
        const part = jet.getObjectByName(name)
        if (part) part.visible = false
      }
      return jet
    },
  },
  // The model it replaces, still the pilot's cockpit in first person until
  // ours is built (claude/plans/air-fa18c.md, step 6).
  { name: 'fa18c-old.glb', url: fa18c_old_url, prepare: posed },
  // Our own Gerald R. Ford, the carrier the game flies from, as
  // tools/ford/build.py builds it, at rest: elevators up, deflectors flush,
  // the port whips upright; but its catapult control stations raised, which
  // at rest lie hidden under the deck.
  {
    name: 'ford.glb',
    url: ford_model_url,
    prepare: (gltf: GLTF) => {
      const ship = gltf.scene.clone(true)
      // the JSON's points are number[], the contract's tuples
      const { joints } = layout(ford_ship as unknown as Parameters<typeof layout>[0])
      for (const [name, offset] of Object.entries(stations(joints)))
        ship.getObjectByName(name)?.position.add(new THREE.Vector3(...offset))
      return ship
    },
  },
].sort((a, b) => naturalCompare(a.name, b.name))

// The Ford's ship file read, for posing its blast deflectors (the JSON's points
// are number[], the contract's tuples)
const FORD = layout(ford_ship as unknown as Parameters<typeof layout>[0])
const RESTS = new WeakMap<THREE.Object3D, THREE.Quaternion>()

// lift poses the Ford's blast deflectors a number of seconds into their raise
// and their struts with them, each joint turned about its axis from where it
// rests, as the engine turns them.
function lift(ship: THREE.Object3D, seconds: number): void {
  for (const [name, value] of Object.entries(deflectors(FORD, seconds))) {
    const part = ship.getObjectByName(name)
    const joint = FORD.joints[name]
    if (!part || !joint) continue
    let rest = RESTS.get(part)
    if (!rest) RESTS.set(part, (rest = part.quaternion.clone()))
    part.quaternion
      .copy(rest)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...joint.axis).normalize(), value))
  }
}

// The model whose parts the Motion button moves, the F/A-18C: its joints, and
// its motion (cycle.ts) from the model and its rigged joints
const MOTION = {
  file: 'fa18c.glb',
  joints: (fa18c_points as unknown as { joints: Record<string, Joint> }).joints,
  motion: (shown: THREE.Object3D, posed: Posed[]) => cycle.fa18c(cycle.rises(shown, posed)),
}

// The Ford's lens lights as the game draws them (engine.ts,
// build_carrier_deck_aids and update_ols): dots a fixed size on the screen in
// the game's colours, what they show (ship.ts meatball) for the camera as the
// pilot's eye; the wave-off lights flashing when asked.
type Lighting = 'off' | 'on' | 'waveoff'
const LIGHTINGS: Lighting[] = ['off', 'on', 'waveoff']
const POINT_HEIGHT = 1620 // the drawing height at which a dot is its size in pixels

interface Lens {
  group: THREE.Group
  waveoff: THREE.Points
  update: (eye: THREE.Vector3, height: number) => void
}

function lens(): Lens | null {
  const l = FORD.lens
  if (!l) return null
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 64
  const context = canvas.getContext('2d')!
  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32)
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.36, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.6, 'rgba(255,255,255,0.3)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  context.fillStyle = gradient
  context.fillRect(0, 0, 64, 64)
  const dot = new THREE.CanvasTexture(canvas)
  const dots: { material: THREE.PointsMaterial; size: number }[] = [] // each dot's material, its size at POINT_HEIGHT
  const points = (
    positions: number[][],
    size: number,
    color: number | null,
    blending: THREE.Blending
  ) => {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(positions.flat()), 3)
    )
    const material = new THREE.PointsMaterial({
      map: dot,
      transparent: true,
      blending,
      depthWrite: false,
      sizeAttenuation: false,
    })
    if (color === null) {
      material.vertexColors = true
      geometry.setAttribute(
        'color',
        new THREE.BufferAttribute(new Float32Array([1, 0.62, 0]), 3)
      )
    } else material.color.set(color)
    dots.push({ material, size })
    const shown = new THREE.Points(geometry, material)
    shown.frustumCulled = false
    return shown
  }
  const group = new THREE.Group()
  const datum = points(l.lights.datum, 7, 0x35e06a, THREE.AdditiveBlending) // the cut lights stay dark (ship.ts meatball)
  const waveoff = points(l.lights.waveoff, 7, 0xff2a1e, THREE.AdditiveBlending)
  const ball = points([l.position], 11, null, THREE.NormalBlending)
  group.add(datum, waveoff, ball)
  const update = (eye: THREE.Vector3, height: number) => {
    for (const d of dots) d.material.size = (d.size * height) / POINT_HEIGHT
    const seen = meatball(FORD, [eye.x, eye.y, eye.z])
    datum.visible = seen.lit
    ball.visible = !!seen.ball
    if (!seen.ball) return
    const position = ball.geometry.attributes.position as THREE.BufferAttribute
    position.setY(0, seen.ball.height)
    position.needsUpdate = true
    const color = ball.geometry.attributes.color as THREE.BufferAttribute
    color.setXYZ(0, 1, seen.ball.low ? 0.1 : 0.62, 0)
    color.needsUpdate = true
  }
  return { group, waveoff, update }
}

interface View {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  shown: THREE.Object3D | null
  radius: number
  lens: Lens | null // the Ford's lens lights while they are shown
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

// file is the model the URL names (?file=ford.glb); an unknown or missing one shows
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
  const [raised, setRaised] = useState(false) // the Ford's blast deflectors asked up
  const [lighting, setLighting] = useState<Lighting>('off') // the Ford's lens lights
  const [worn, setWorn] = useState(0) // the F/A-18C's loadout, from LOADOUTS
  const [moving, setMoving] = useState(false) // every moving part driven back and forth
  const [loaded, setLoaded] = useState<THREE.Object3D | null>(null) // the shown model, once drawn
  const time = useRef(0) // how many seconds into their raise they stand
  const { formatNumber } = useFormat()

  useEffect(() => {
    const host = mount.current
    if (!host) return
    let renderer: THREE.WebGLRenderer
    try {
      // Depth kept to a share of the distance, not of the clip planes: zoomed
      // to the cursor, the orbit target can lie a few metres from the camera
      // with the model 80 m off, its near plane then millimetres, and a door
      // 5 cm in front of a wall drew through it in stripes
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        logarithmicDepthBuffer: true,
      })
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
      lens: null,
      draw: () => {
        // The clip planes follow the zoom, so a detail a metre away and the
        // far end of the ship both keep their depth precision.
        const distance = camera.position.distanceTo(controls.target)
        camera.near = Math.max(current.radius / 1e5, distance / 1000)
        camera.far = distance + current.radius * 4
        camera.updateProjectionMatrix()
        current.lens?.update(camera.position, renderer.domElement.height)
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
    setLoaded(null)
    model(entry.url, current.renderer).then(
      (gltf) => {
        if (!wanted || view.current !== current) return
        if (current.shown) current.scene.remove(current.shown)
        current.shown = entry.prepare(gltf)
        time.current = 0 // a fresh model stands at rest
        current.scene.add(current.shown)
        frame(current, current.shown)
        current.draw()
        setCount(polygons(current.shown))
        setLoaded(current.shown)
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

  // The Ford's blast deflectors move toward up or down in real time, along
  // their measured raise (backwards to lower), redrawn each frame until they
  // stand there.
  useEffect(() => {
    const current = view.current
    if (!current?.shown || chosen !== 'ford.glb' || count === null) return
    const shown = current.shown
    const up = raising(FORD)
    const target = raised ? up : 0
    let frame = 0
    let last = performance.now()
    const step = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1)
      last = now
      time.current = THREE.MathUtils.clamp(time.current + THREE.MathUtils.clamp(target - time.current, -dt, dt), 0, up)
      lift(shown, time.current)
      current.draw()
      if (time.current !== target) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [raised, count, chosen])

  // The Ford's lens lights, shown as asked, the wave-off lights flashing at
  // the game's rate (lit 200 ms in each 400) while they are asked for.
  useEffect(() => {
    const current = view.current
    if (!current || !loaded || chosen !== 'ford.glb' || lighting === 'off')
      return
    const shown = lens()
    if (!shown) return
    current.lens = shown
    current.scene.add(shown.group)
    shown.waveoff.visible = false
    current.draw()
    let frame = 0
    if (lighting === 'waveoff') {
      const step = (now: number) => {
        shown.waveoff.visible = now % 400 < 200
        current.draw()
        frame = requestAnimationFrame(step)
      }
      frame = requestAnimationFrame(step)
    }
    return () => {
      cancelAnimationFrame(frame)
      current.scene.remove(shown.group)
      current.lens = null
      shown.group.traverse((o) => {
        const p = o as THREE.Points
        if (p.isPoints) {
          p.geometry.dispose()
          ;(p.material as THREE.PointsMaterial).map?.dispose()
          ;(p.material as THREE.PointsMaterial).dispose()
        }
      })
      current.draw()
    }
  }, [lighting, loaded, chosen])

  // While asked, every moving part of the F/A-18C goes back and forth through
  // its travel at its pace (cycle.ts), redrawn each frame; stopped, each goes
  // back where it stood.
  useEffect(() => {
    const current = view.current
    if (!current || !loaded || !moving || chosen !== MOTION.file) return
    const shown = loaded
    const posed = rig(shown, MOTION.joints)
    const stood = posed.map((p) => ({
      position: p.object.position.clone(),
      quaternion: p.object.quaternion.clone(),
      influences: p.morphs.map((m) => m.mesh.morphTargetInfluences?.[m.index] ?? 0),
    }))
    const motion = MOTION.motion(shown, posed)
    let frame = 0
    let last = performance.now()
    const step = (now: number) => {
      motion.step(Math.min((now - last) / 1000, 0.1))
      last = now
      pose(posed, motion.value)
      current.draw()
      frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => {
      cancelAnimationFrame(frame)
      posed.forEach((p, i) => {
        p.object.position.copy(stood[i].position)
        p.object.quaternion.copy(stood[i].quaternion)
        p.morphs.forEach((m, k) => {
          if (m.mesh.morphTargetInfluences) m.mesh.morphTargetInfluences[m.index] = stood[i].influences[k]
        })
      })
      current.draw()
    }
  }, [moving, loaded, chosen])

  // The F/A-18C wears the loadout asked for, its rounds our own missiles hung as
  // the flight hangs them.
  useEffect(() => {
    const current = view.current
    if (!current || !loaded || chosen !== 'fa18c.glb') return
    const jet = loaded
    let wanted = true
    Promise.all([model(aim9m_model_url, current.renderer), model(amraam_model_url, current.renderer)]).then(
      ([nine, amraam]) => {
        if (!wanted || current.shown !== jet) return
        const missiles: Record<Kind, THREE.Object3D> = { aim9m: nine.scene, aim120c: amraam.scene }
        outfit(jet, LOADOUTS[worn].stores, missiles, FITTINGS)
        current.draw()
        setCount(polygons(jet))
      },
      (error) => {
        if (wanted) setStatus(`Could not load the missiles: ${(error as Error)?.message || error}`)
      }
    )
    return () => {
      wanted = false
    }
  }, [worn, loaded, chosen])

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
        {chosen === MOTION.file && loaded && (
          <Button variant='outline' size='sm' onClick={() => setMoving((m) => !m)}>
            {/* jsx-text-ok: developer page, English only by decision */}
            Motion: {moving ? 'on' : 'off'}
          </Button>
        )}
        {chosen === 'ford.glb' && count !== null && (
          <Button variant='outline' size='sm' onClick={() => setRaised((up) => !up)}>
            {/* jsx-text-ok: developer page, English only by decision */}
            {raised ? 'Lower JBDs' : 'Raise JBDs'}
          </Button>
        )}
        {chosen === 'ford.glb' && count !== null && (
          <Button
            variant='outline'
            size='sm'
            onClick={() =>
              setLighting(
                (l) => LIGHTINGS[(LIGHTINGS.indexOf(l) + 1) % LIGHTINGS.length]
              )
            }
          >
            {/* jsx-text-ok: developer page, English only by decision */}
            Lights: {lighting === 'waveoff' ? 'wave-off' : lighting}
          </Button>
        )}
        {chosen === 'fa18c.glb' && loaded && (
          <Button variant='outline' size='sm' onClick={() => setWorn((i) => (i + 1) % LOADOUTS.length)}>
            {/* jsx-text-ok: developer page, English only by decision */}
            Stores: {LOADOUTS[worn].name}
          </Button>
        )}
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
