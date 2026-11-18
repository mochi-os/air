// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { DirectionalLight, BoxGeometry, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene } from 'three/src/Three.js'
import { WebGLShadowMap } from 'three/src/renderers/webgl/WebGLShadowMap.js'
import { describe, expect, it } from 'vitest'
import {
  MIRROR_GLASS,
  MIRROR_HEIGHT,
  MIRROR_MARGIN,
  MIRROR_PIECES,
  MIRROR_RATE,
  MIRROR_WIDTH,
  MirrorClock,
  mirror_aim,
  mirror_clear,
  mirror_carried,
  mirror_live,
  mirror_lookup,
  mirror_material,
  mirror_normal,
  mirror_pieces,
  mirror_setting,
  mirror_view,
  mirror_virtual,
} from './mirror'

const D2R = Math.PI / 180

// engine.ts cannot be imported (WebGL at module scope): its mirror wiring is
// read from its source, and lift cuts one top-level function out.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
function lift(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  expect(start, `${name} in engine.ts`).toBeGreaterThan(0)
  const rest = source.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  return end ? rest.slice(0, end.index + 1) : rest
}

// A direction `az` degrees round from `forward` toward `right` and `el` up.
function bearing(forward: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3, az: number, el: number): THREE.Vector3 {
  return forward
    .clone()
    .multiplyScalar(Math.cos(el * D2R) * Math.cos(az * D2R))
    .addScaledVector(right, Math.cos(el * D2R) * Math.sin(az * D2R))
    .addScaledVector(up, Math.sin(el * D2R))
    .normalize()
}

describe('a flat mirror shows the scene from the eye reflected across it', () => {
  // A mirror 0.4 m ahead of and above the eye, tilted to face it, as the bow's centre one.
  const eye = new THREE.Vector3(0.3, 1.2, -0.1)
  const point = new THREE.Vector3(0.3, 1.6, -0.5),
    normal = new THREE.Vector3(0, -0.4, 1).normalize()
  const virtual = mirror_virtual(eye, point, normal, new THREE.Vector3())
  it('lies as far beyond the plane as the eye lies before it', () => {
    const before = eye.clone().sub(point).dot(normal),
      beyond = virtual.clone().sub(point).dot(normal)
    expect(before).toBeGreaterThan(0.1)
    expect(beyond).toBeCloseTo(-before, 12)
    // and straight across: the line between them is the normal
    expect(virtual.clone().sub(eye).normalize().dot(normal)).toBeCloseTo(-1, 12)
  })
  it('sees through each point of the glass along the sight line reflected there, at the angle it met', () => {
    for (const p of [point, point.clone().add(new THREE.Vector3(0.08, 0, 0)), point.clone().add(new THREE.Vector3(-0.05, 0.01, 0.004))]) {
      const onto = p.clone().addScaledVector(normal, -p.clone().sub(point).dot(normal)) // on the plane
      const sight = onto.clone().sub(eye).normalize()
      const reflected = sight.clone().addScaledVector(normal, -2 * sight.dot(normal))
      const seen = onto.clone().sub(virtual).normalize()
      expect(seen.angleTo(reflected)).toBeLessThan(1e-9)
    }
  })
})

describe('the mirrors are set as a pilot sets them', () => {
  it('the centre one dead aft and 13 degrees up, over the headrest, each side one level and 20 degrees out to its own side', () => {
    const centre = mirror_setting(0.02)
    expect(centre.x).toBeCloseTo(-Math.cos(13 * D2R), 12)
    expect(centre.y).toBeCloseTo(Math.sin(13 * D2R), 12)
    expect(centre.z).toBe(0)
    const right = mirror_setting(0.37),
      left = mirror_setting(-0.37)
    expect(right.x).toBeCloseTo(-Math.cos(20 * D2R), 12)
    expect(right.y).toBe(0)
    expect(right.z).toBeCloseTo(Math.sin(20 * D2R), 12)
    expect(left.z).toBeCloseTo(-Math.sin(20 * D2R), 12)
    expect(left.y).toBe(0)
  })
  it('turns a mirror to the normal that sends the sight line to its centre along its setting', () => {
    const eye = new THREE.Vector3(0.1, 1.3, 0),
      centre = new THREE.Vector3(0.45, 1.25, 0.4)
    const toward = new THREE.Vector3(-0.9, 0.05, 0.3).normalize()
    const n = mirror_normal(eye, centre, toward, new THREE.Vector3())
    const sight = centre.clone().sub(eye).normalize()
    const sent = sight.clone().addScaledVector(n, -2 * sight.dot(n))
    expect(sent.angleTo(toward)).toBeLessThan(1e-9)
    expect(n.dot(eye.clone().sub(centre))).toBeGreaterThan(0) // it faces the eye
  })
})

describe("the mirrors' copy of the airframe leaves out the canopy glass", () => {
  it('drops every triangle with a vertex painted the glass tint, and keeps the rest', () => {
    const colours: Record<number, [number, number, number]> = {
      0: [0.42, 0.45, 0.48],
      1: [0.42, 0.45, 0.48],
      2: [0.42, 0.45, 0.48],
      3: [0.0196, 0.0275, 0.0353], // the tint as eight bits a channel carry it
      4: [0.42, 0.45, 0.48],
      5: [0.05, 0.026, 0.034], // dark, but not the glass
    }
    expect(mirror_clear([0, 1, 2, 2, 3, 4, 4, 5, 0], (v) => colours[v])).toEqual([0, 1, 2, 4, 5, 0])
  })
  it('knows the tint the distant stages are built with', () => {
    for (const tool of ['far.py', 'stages.py']) {
      const text = readFileSync(fileURLToPath(new URL(`../../../tools/fa18c/${tool}`, import.meta.url)), 'utf8')
      const tint = /\nTINT = np\.array\(\[([^\]]+)\]\)/.exec(text)
      expect(tint, tool).not.toBeNull()
      expect(tint![1].split(',').map(Number)).toEqual(MIRROR_GLASS)
    }
  })
})

describe('a face is split into its separate mirrors', () => {
  it('joins triangles that share a vertex, and lists each mirror largest first', () => {
    // a quad (0-3), a lone triangle (10-12), and a strip of three triangles (20-24)
    const pieces = mirror_pieces([0, 1, 2, 2, 1, 3, 10, 11, 12, 20, 21, 22, 22, 21, 23, 23, 22, 24])
    expect(pieces).toEqual([
      [20, 21, 22, 23, 24],
      [0, 1, 2, 3],
      [10, 11, 12],
    ])
  })
  it('keeps one mirror whole however its triangles are ordered', () => {
    expect(mirror_pieces([5, 6, 7, 1, 2, 3, 3, 4, 5])).toEqual([[1, 2, 3, 4, 5, 6, 7]])
  })
})

describe('the rear view is aimed over the rays the faces reflect', () => {
  // The cockpit model's three mirrors, seen from its eye: the left reflects 26
  // to 30 degrees left of dead aft and 13 down to 6 up, the centre 8 left to 14
  // right and 7 to 11 up, the right 16 to 20 right and 11 down to 7 up. Their
  // rays' mean lies about 3 degrees off the middle of their extent.
  const eye = new THREE.Vector3(5, 2000, -3)
  const aft = new THREE.Vector3(1, 0, 0),
    up = new THREE.Vector3(0, 1, 0),
    right = new THREE.Vector3(0, 0, 1)
  const rays: THREE.Vector3[] = []
  const face = (az0: number, az1: number, el0: number, el1: number) => {
    for (let i = 0; i <= 5; i++) for (let j = 0; j <= 5; j++) rays.push(bearing(aft, right, up, az0 + ((az1 - az0) * i) / 5, el0 + ((el1 - el0) * j) / 5))
  }
  face(-30, -26, -13, 6)
  face(-8, 14, 7, 11)
  face(16, 20, -11, 7)
  const aimed = () => {
    const camera = new THREE.PerspectiveCamera(30, MIRROR_WIDTH / MIRROR_HEIGHT, 3, 130000)
    expect(mirror_aim(camera, eye, rays, up, MIRROR_MARGIN)).toBe(true)
    return camera
  }

  it('sees every ray, clear of the target border', () => {
    const view = mirror_view(aimed(), new THREE.Matrix4())
    for (const r of rays) {
      const uv = mirror_lookup(view, r)!
      expect(uv).not.toBeNull()
      for (const c of uv) {
        expect(c).toBeGreaterThan(0.02)
        expect(c).toBeLessThan(0.98)
      }
    }
  })
  it('is no wider than the rays and the margin need', () => {
    // The outermost ray lies the margin inside the edge on the axis that binds,
    // in the camera's own tangents (an off-axis ray stands higher on the target
    // by the cosine of how far round it is).
    const camera = aimed(),
      half = (camera.fov / 2) * D2R
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion),
      across = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion),
      upward = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion)
    let x = 0,
      y = 0
    for (const r of rays) {
      x = Math.max(x, Math.abs(r.dot(across) / r.dot(forward)))
      y = Math.max(y, Math.abs(r.dot(upward) / r.dot(forward)))
    }
    const needed = Math.max(Math.atan(y) + MIRROR_MARGIN, Math.atan(Math.tan(Math.atan(x) + MIRROR_MARGIN) / camera.aspect))
    expect(half).toBeCloseTo(needed, 9)
    expect(half).toBeLessThan(16 * D2R)
  })
  it('holds 12 target pixels a degree at its middle', () => {
    const camera = aimed()
    const density = (MIRROR_HEIGHT / 2 / Math.tan((camera.fov / 2) * D2R)) * D2R
    expect(density).toBeGreaterThan(12)
  })
  it('stands upright to the jet and looks along the middle of the rays', () => {
    const camera = aimed()
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
    const middle = bearing(aft, right, up, -5, -1)
    expect(forward.angleTo(middle)).toBeLessThan(1.5 * D2R)
    expect(new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).dot(up)).toBeCloseTo(0, 9)
  })
  it('widens by the margin it is given', () => {
    const tight = new THREE.PerspectiveCamera(30, MIRROR_WIDTH / MIRROR_HEIGHT, 3, 130000),
      loose = tight.clone()
    mirror_aim(tight, eye, rays, up, MIRROR_MARGIN)
    mirror_aim(loose, eye, rays, up, MIRROR_MARGIN + 10 * D2R)
    expect(loose.fov - tight.fov).toBeCloseTo(20, 0)
  })
  it('refuses rays spread past one camera', () => {
    const camera = new THREE.PerspectiveCamera(30, 2, 3, 130000)
    expect(mirror_aim(camera, eye, [aft, aft.clone().negate().add(up.clone().multiplyScalar(0.1)).normalize()], up, MIRROR_MARGIN)).toBe(false)
    expect(mirror_aim(camera, eye, [], up, MIRROR_MARGIN)).toBe(false)
    // one ray dead behind the rest: its tangents read small, but it cannot be seen
    expect(mirror_aim(camera, eye, [...rays, aft.clone().negate()], up, MIRROR_MARGIN)).toBe(false)
  })
})

describe('a face finds a direction in the targets', () => {
  const camera = new THREE.PerspectiveCamera(40, 2, 3, 130000)
  camera.position.set(100, 3000, -50)
  camera.lookAt(100, 3000, 1000)
  camera.updateMatrixWorld(true)
  const view = mirror_view(camera, new THREE.Matrix4())
  const ahead = new THREE.Vector3(0, 0, 1)

  it('at the middle for the way the camera looks, and nowhere behind it', () => {
    const uv = mirror_lookup(view, ahead)!
    expect(uv[0]).toBeCloseTo(0.5, 9)
    expect(uv[1]).toBeCloseTo(0.5, 9)
    expect(mirror_lookup(view, ahead.clone().negate())).toBeNull()
  })
  it('by direction alone, wherever the eye has flown since', () => {
    const later = camera.clone()
    later.position.add(new THREE.Vector3(8, -3, 250))
    later.updateMatrixWorld(true)
    const d = new THREE.Vector3(0.2, 0.1, 1).normalize()
    expect(mirror_lookup(mirror_view(later, new THREE.Matrix4()), d)).toEqual(mirror_lookup(view, d))
  })
  it('in the jet layer, where a direction fixed to the jet was when drawn, however the jet has turned', () => {
    const then = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, 0.4, -0.2))
    const turn = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -0.2, 1.1))
    const now = turn.clone().multiply(then)
    const fixed = new THREE.Vector3(0.1, -0.2, 1).normalize() // in the jet's frame
    const drawn = fixed.clone().applyQuaternion(then),
      seen = fixed.clone().applyQuaternion(now)
    const carried = mirror_carried(view, then, now, new THREE.Matrix4())
    const a = mirror_lookup(carried, seen)!,
      b = mirror_lookup(view, drawn)!
    expect(a[0]).toBeCloseTo(b[0], 9)
    expect(a[1]).toBeCloseTo(b[1], 9)
    // and the world layer would have lost it: the jet turned 1.1 radians
    expect(mirror_lookup(view, seen)?.[0] ?? 2).not.toBeCloseTo(b[0], 2)
  })
  it('in the jet layer, as the view itself while the jet has not turned', () => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.5, 1, 0.25))
    const carried = mirror_carried(view, q, q, new THREE.Matrix4())
    for (let i = 0; i < 16; i++) expect(carried.elements[i]).toBeCloseTo(view.elements[i], 9)
  })
})

describe('the mirrors update thirty times a second on wall time', () => {
  // frames at `hz` for `seconds`, and what each did
  function run(hz: number, seconds: number, clouds: boolean, clock = new MirrorClock()) {
    const steps: (string | null)[] = []
    for (let i = 0; i < hz * seconds; i++) steps.push(clock.step(1000 + (i * 1000) / hz, clouds))
    return steps
  }

  it('at 60 frames a second, every other frame', () => {
    const steps = run(60, 2, false)
    expect(steps.filter((s) => s === 'scene').length).toBe(2 * MIRROR_RATE)
    expect(steps.slice(0, 6)).toEqual(['scene', null, 'scene', null, 'scene', null])
  })
  it('at 120 and 144 frames a second, still thirty', () => {
    expect(run(120, 2, false).filter((s) => s === 'scene').length).toBe(60)
    expect(Math.abs(run(144, 2, false).filter((s) => s === 'scene').length - 60)).toBeLessThanOrEqual(1)
  })
  it('with clouds, finishes each update on the frame after it began', () => {
    const steps = run(60, 2, true)
    expect(steps.filter((s) => s === 'scene').length).toBe(60)
    steps.forEach((s, i) => {
      if (s === 'scene') expect(steps[i + 1] ?? 'clouds').toBe('clouds')
      if (s === 'clouds') expect(steps[i - 1]).toBe('scene')
    })
  })
  it('queues no burst after a stall', () => {
    const clock = new MirrorClock()
    expect(clock.step(1000, false)).toBe('scene')
    expect(clock.step(3000, false)).toBe('scene') // two seconds without a frame
    expect(clock.step(3016, false)).toBeNull()
    expect(clock.step(3034, false)).toBe('scene')
  })
  it('begins at once when the mirrors come back into use', () => {
    const clock = new MirrorClock()
    clock.step(1000, true)
    clock.reset()
    expect(clock.step(1005, true)).toBe('scene')
  })
})

describe('the mirrors are live only where they are seen and the setting allows', () => {
  it('in the cockpit view, without the map, above the lowest effects', () => {
    expect(mirror_live('cockpit', false, 1)).toBe(true)
    expect(mirror_live('cockpit', false, 3)).toBe(true)
    expect(mirror_live('cockpit', false, 0)).toBe(false)
    expect(mirror_live('cockpit', true, 2)).toBe(false)
    expect(mirror_live('hud', false, 2)).toBe(false)
    expect(mirror_live('chase', false, 2)).toBe(false)
  })
})

describe('the live face', () => {
  const material = mirror_material(THREE.FrontSide)
  it('reflects the sight line off the side toward the eye', () => {
    expect(material.fragmentShader).toContain('if(dot(n,v)>0.0) n=-n;')
    expect(material.fragmentShader).toContain('vec3 r=reflect(v,n);')
  })
  it('takes the airframe drawn for the mirror whose plane the fragment lies on', () => {
    expect(material.fragmentShader).toContain('float off(vec4 plane){ return abs(dot(plane.xyz,vWorld)+plane.w); }')
    expect(material.fragmentShader).toContain(
      'vec4 jet=d0<=d1&&d0<=d2?texture2D(tJet0,at(uJet0,r)):d1<=d2?texture2D(tJet1,at(uJet1,r)):texture2D(tJet2,at(uJet2,r));',
    )
    for (let k = 0; k < MIRROR_PIECES; k++) expect(material.uniforms[`uPlane${k}`].value.w).toBe(1e9) // unset, no face is near it
  })
  it('lays the airframe over the world, premultiplied, at the glass share, unconverted', () => {
    expect(material.fragmentShader).toContain('gl_FragColor=vec4((jet.rgb+texture2D(tWorld,at(uWorld,r)).rgb*(1.0-jet.a))*uGain,1.0);')
    expect(material.fragmentShader).not.toContain('#include')
    expect(material.uniforms.uGain.value).toBeCloseTo(Math.pow(0.88, 1 / 2.2), 12)
  })
})

describe('the engine draws the mirrors', () => {
  it('keeps the mirrors airframe copy off the cockpit layer', () => {
    const layer_own_group = new Function('LAYER_OWN', `${lift('layer_own_group')} return layer_own_group;`)(1) as (g: THREE.Object3D) => void
    const g = new THREE.Group(),
      plain = new THREE.Object3D(),
      copy = new THREE.Object3D()
    copy.userData.mirror = true
    copy.layers.set(2)
    g.add(plain, copy)
    layer_own_group(g)
    expect(plain.layers.mask).toBe(1 << 1)
    expect(copy.layers.mask).toBe(1 << 2)
  })

  it('hangs a copy of the distant stage on the player jet alone, on the mirror layer, casting no shadow', () => {
    const far = new THREE.Group()
    for (const name of ['airframe', 'up', 'down', 'burner', 'far']) {
      const part = new THREE.Group()
      part.name = name
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial())
      mesh.castShadow = true
      part.add(mesh)
      far.add(part)
    }
    const jet = (player: boolean) => {
      const g = new THREE.Group(),
        m = new THREE.Group(),
        proto = new THREE.Group(),
        inner = new THREE.Group()
      m.userData.model = true
      m.add(proto)
      proto.add(inner)
      g.add(m)
      g.userData.player = player
      return { g, inner }
    }
    // the airframe carries a glass-tinted triangle beside a painted one
    const airframe = far.getObjectByName('airframe')!.children[0] as THREE.Mesh
    const painted = new THREE.BufferGeometry()
    painted.setAttribute('position', new THREE.BufferAttribute(new Float32Array(18), 3))
    painted.setAttribute('color', new THREE.BufferAttribute(new Float32Array([0.42, 0.45, 0.48, 0.42, 0.45, 0.48, 0.42, 0.45, 0.48, ...MIRROR_GLASS, ...MIRROR_GLASS, ...MIRROR_GLASS]), 3))
    painted.setIndex([0, 1, 2, 3, 4, 5])
    airframe.geometry = painted
    const glassless = new WeakMap()
    const attach = (fleet_far: Record<string, unknown>) =>
      new Function('THREE', 'fleet_far', 'LAYER_MIRROR', 'model_of', 'mirror_glassless', 'mirror_clear', `${lift('mirror_jet_attach')} return mirror_jet_attach;`)(
        THREE,
        fleet_far,
        2,
        (g: THREE.Object3D) => g.children.find((c) => c.userData && c.userData.model) || g,
        glassless,
        mirror_clear,
      ) as (g: THREE.Object3D, kind: string) => void
    const player = jet(true)
    attach({ fa18c: far })(player.g, 'fa18c')
    expect(player.inner.children.length).toBe(1)
    const root = player.inner.children[0]
    root.traverse((o) => {
      expect(o.layers.mask).toBe(1 << 2)
      expect(o.userData.mirror).toBe(true)
      if ((o as THREE.Mesh).isMesh) expect(o.castShadow).toBe(false)
    })
    expect(root.getObjectByName('far')!.visible).toBe(false)
    expect(player.g.userData.mirror_jet.up).toBe(root.getObjectByName('up'))
    expect(far.children[0].children[0].castShadow).toBe(true) // the stage other jets draw is untouched
    const copied = (root.getObjectByName('airframe')!.children[0] as THREE.Mesh).geometry
    expect(Array.from(copied.index!.array)).toEqual([0, 1, 2]) // the glass left out of the mirrors' copy
    expect(Array.from(painted.index!.array)).toEqual([0, 1, 2, 3, 4, 5]) // and kept on the stage
    attach({ fa18c: far })(player.g, 'fa18c')
    expect(player.inner.children.length).toBe(1) // once
    const other = jet(false)
    attach({ fa18c: far })(other.g, 'fa18c')
    expect(other.inner.children.length).toBe(0)
    const early = jet(true)
    attach({ fa18c: 'loading' })(early.g, 'fa18c')
    expect(early.inner.children.length).toBe(0)
  })

  type Piece = { mesh: THREE.Mesh; points: THREE.Vector3[]; centre: THREE.Vector3; normal: THREE.Vector3 }
  const finder = (mirror: { faces: unknown[]; pieces: Piece[]; material: unknown }, glass: THREE.Material) =>
    new Function('THREE', 'mirror', 'mirror_mats', 'mirror_material', 'mirror_pieces', 'MIRROR_PIECES', `${lift('mirror_faces_find')} return mirror_faces_find;`)(
      THREE,
      mirror,
      [glass],
      mirror_material,
      mirror_pieces,
      MIRROR_PIECES,
    ) as (m: THREE.Object3D) => void

  it('reads the mirrors from the silvered glass alone, on a mesh that carries other materials too', () => {
    const glass = new THREE.MeshStandardMaterial(),
      paint = new THREE.MeshStandardMaterial()
    const geometry = new THREE.BufferGeometry()
    // a painted triangle, then two separate glass triangles facing +x
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 5, 5, 5, 6, 5, 5, 5, 6, 5, 9, 9, 5, 10, 9, 5, 9, 10]), 3))
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0]), 3))
    geometry.setIndex([0, 1, 2, 3, 4, 5, 6, 7, 8])
    geometry.addGroup(0, 3, 0)
    geometry.addGroup(3, 6, 1)
    const shared = [paint, glass],
      mesh = new THREE.Mesh(geometry, shared)
    const mirror = { faces: [] as { mesh: THREE.Mesh; index: number }[], pieces: [] as Piece[], material: null }
    const model = new THREE.Group()
    model.add(mesh)
    finder(mirror, glass)(model)
    expect(mirror.faces.length).toBe(1)
    expect(mirror.faces[0].index).toBe(1)
    expect(mirror.pieces.length).toBe(2)
    expect(mirror.pieces[0].points.map((p) => p.toArray())).toEqual([
      [5, 5, 5],
      [5, 6, 5],
      [5, 5, 6],
    ])
    mirror.pieces[0].centre.toArray().forEach((c, i) => expect(c).toBeCloseTo([5, 16 / 3, 16 / 3][i], 6))
    expect(mirror.pieces[1].normal.toArray()).toEqual([1, 0, 0])
    expect(mesh.material).not.toBe(shared) // its own list: switching it to the live face leaves other jets' glass alone
    expect(mirror.material).not.toBeNull()
  })

  it('keeps the largest mirrors when a face holds more than it draws for', () => {
    const glass = new THREE.MeshStandardMaterial(),
      at: number[] = [],
      triangles: number[] = []
    // four separate mirrors of 3, 4, 5 and 6 vertices (fans)
    for (const [k, size] of [3, 4, 5, 6].entries()) {
      const base = at.length / 3
      for (let i = 0; i < size; i++) at.push(10 * k + i, i % 2, 0)
      for (let i = 1; i + 1 < size; i++) triangles.push(base, base + i, base + i + 1)
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(at), 3))
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(at.map((_, i) => (i % 3 === 2 ? 1 : 0))), 3))
    geometry.setIndex(triangles)
    const mirror = { faces: [] as unknown[], pieces: [] as Piece[], material: null }
    const model = new THREE.Group()
    model.add(new THREE.Mesh(geometry, glass))
    finder(mirror, glass)(model)
    expect(mirror.pieces.map((p) => p.points.length)).toEqual([6, 5, 4])
  })

  it('sets each mirror from the eye, out of the model quantisation, sending the sight line to it along its setting, and setting it again turns nothing', () => {
    // Two mirrors in one quantised mesh, 0.4 m ahead of the eye, one in the middle and one 0.37 m right, both
    // facing straight back at first; the jet flies a turned frame.
    const quad = (x: number, y: number, z: number) => [x - 0.08, y - 0.02, z, x + 0.08, y - 0.02, z, x + 0.08, y + 0.02, z, x - 0.08, y + 0.02, z]
    const at = [...quad(0, 1.45, 0.4), ...quad(0.37, 1.15, 0.4)]
    const scale = 0.5 // the quantised range spans +-2 m
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Int16Array(at.map((c) => Math.round((c * scale) * 32767))), 3, true))
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Int8Array(at.map((_, i) => (i % 3 === 2 ? -127 : 0))), 3, true))
    geometry.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])
    const glass = new THREE.MeshStandardMaterial(),
      mesh = new THREE.Mesh(geometry, glass)
    mesh.scale.setScalar(1 / scale)
    // the jet's frame: forward x, up y, right z; the mesh is laid in it with the mirrors' backs toward +z... turned so they face the eye at x=0
    const g = new THREE.Group()
    g.position.set(200, 3000, -40)
    g.rotation.set(0.3, -1.2, 0.1)
    const holder = new THREE.Group()
    holder.rotation.y = -Math.PI / 2 // model z (toward the mirrors) becomes the jet's forward x; model x becomes the jet's right z
    holder.add(mesh)
    g.add(holder)
    g.updateMatrixWorld(true)
    g.userData.eye = { x: 0, y: 1.3 }
    type Piece = { mesh: THREE.Mesh; vertices: number[]; points: THREE.Vector3[]; normals: THREE.Vector3[]; centre: THREE.Vector3; normal: THREE.Vector3 }
    const mirror = { faces: [] as unknown[], pieces: [] as Piece[], material: null }
    new Function('THREE', 'mirror', 'mirror_mats', 'mirror_material', 'mirror_pieces', 'MIRROR_PIECES', `${lift('mirror_faces_find')} return mirror_faces_find;`)(
      THREE,
      mirror,
      [glass],
      mirror_material,
      mirror_pieces,
      MIRROR_PIECES,
    )(holder)
    expect(mirror.pieces.length).toBe(2)
    const temporaries = [new THREE.Matrix3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
    const plane_of = new Function('THREE', 'mirror_virtual', '_mirror_normals', '_mirror_point', '_mirror_normal', '_mirror_mean', `${lift('mirror_plane')} return mirror_plane;`)(
      THREE,
      mirror_virtual,
      ...temporaries,
    )
    const set = new Function('THREE', 'mirror', 'mirror_plane', 'mirror_setting', 'mirror_normal', `${lift('mirror_set')} return mirror_set;`)(
      THREE,
      mirror,
      plane_of,
      mirror_setting,
      mirror_normal,
    ) as (g: THREE.Object3D) => void
    set(g)
    expect(geometry.attributes.position.array).toBeInstanceOf(Float32Array) // out of the quantisation
    const eye = g.localToWorld(new THREE.Vector3(0, 1.3, 0)),
      turn = g.getWorldQuaternion(new THREE.Quaternion())
    const sends = () =>
      mirror.pieces.map((piece) => {
        const centre = piece.centre.clone().applyMatrix4(mesh.matrixWorld)
        const plane = new THREE.Plane()
        plane_of(piece, eye, plane, new THREE.Vector3())
        const sight = centre.clone().sub(eye).normalize()
        return { sent: sight.addScaledVector(plane.normal, -2 * sight.dot(plane.normal)), across: g.worldToLocal(centre.clone()).z }
      })
    for (const { sent, across } of sends()) expect(sent.angleTo(mirror_setting(across).applyQuaternion(turn))).toBeLessThan(1e-4)
    // the vertices moved with it: every one of a mirror still lies on its plane, and a second setting turns nothing
    const before = Array.from(geometry.attributes.position.array)
    set(g)
    expect(Array.from(geometry.attributes.position.array)).toEqual(before)
    for (const piece of mirror.pieces) {
      const p = new THREE.Plane().setFromNormalAndCoplanarPoint(piece.normal, piece.centre)
      for (const v of piece.vertices) expect(p.distanceToPoint(new THREE.Vector3().fromBufferAttribute(geometry.attributes.position as THREE.BufferAttribute, v))).toBeCloseTo(0, 6)
    }
  })

  it('finds a mirror plane with its normal toward the eye, and the eye mirrored across it', () => {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry())
    mesh.position.set(100, 2000, -50)
    mesh.rotation.set(0.2, 1.1, -0.3)
    const piece = { mesh, centre: new THREE.Vector3(0.1, 0.2, 0.3), normal: new THREE.Vector3(0, 0, 1) }
    const plane_of = new Function(
      'THREE',
      'mirror_virtual',
      '_mirror_normals',
      '_mirror_point',
      '_mirror_normal',
      '_mirror_mean',
      `${lift('mirror_plane')} return mirror_plane;`,
    )(THREE, mirror_virtual, new THREE.Matrix3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()) as (
      piece: unknown,
      eye: THREE.Vector3,
      plane: THREE.Plane,
      out: THREE.Vector3,
    ) => THREE.Vector3
    mesh.updateMatrixWorld(true)
    const centre = piece.centre.clone().applyMatrix4(mesh.matrixWorld),
      facing = new THREE.Vector3(0, 0, 1).transformDirection(mesh.matrixWorld)
    for (const side of [1, -1]) {
      const eye = centre.clone().addScaledVector(facing, side * 0.45).add(new THREE.Vector3(0.05, -0.1, 0.02))
      const plane = new THREE.Plane(),
        virtual = plane_of(piece, eye, plane, new THREE.Vector3())
      expect(plane.distanceToPoint(centre)).toBeCloseTo(0, 9)
      expect(plane.distanceToPoint(eye)).toBeGreaterThan(0) // the eye's side is the side the jet pass keeps
      expect(plane.distanceToPoint(virtual)).toBeCloseTo(-plane.distanceToPoint(eye), 9)
    }
  })

  it('draws the world from the virtual eyes mean, and each mirror airframe from its own virtual eye, cut at its glass', () => {
    const scene = lift('mirror_scene')
    expect(scene).toContain('if(!mirror_aim(cam,centre,rays,up,mirror.margin)) return;')
    expect(scene).toContain('renderer.clippingPlanes=[planes[k]]; renderer.render(scene,piece_cam); renderer.clippingPlanes=[];')
    expect(scene).toContain('planes.push(plane.clone().translate(plane.normal.clone().multiplyScalar(MIRROR_CLEAR)));') // cut short of the glass, toward the eye
    expect(scene).toContain('mirror_aim(piece_cam,at,')
    // without walking the scene to place its objects again, which the frame's world pass has done
    expect(scene).toMatch(/scene\.matrixWorldAutoUpdate=false;[\s\S]*renderer\.render\(scene,cam\);[\s\S]*renderer\.render\(scene,piece_cam\);[\s\S]*scene\.matrixWorldAutoUpdate=placed;/)
  })

  it('draws them after the world and before the cockpit pass that shows their faces', () => {
    const frame = lift('render_frame')
    const world = frame.lastIndexOf('renderer.render(scene,camera);')
    expect(frame.indexOf('mirror_frame();')).toBeGreaterThan(world)
    expect(frame.indexOf('mirror_frame();')).toBeLessThan(frame.indexOf('renderer.render(scene,cockpit_cam);'))
  })
})

describe("the sun's shadow map is drawn once a frame", () => {
  it('the engine draws it at the frame first pass over the scene, and leaves three to redraw it nowhere', () => {
    expect(source).toContain('\nrenderer.shadowMap.autoUpdate=false;\n')
    const frame = lift('render_frame')
    const asked = frame.indexOf('renderer.shadowMap.needsUpdate=true;')
    expect(asked).toBeGreaterThan(0)
    expect(asked).toBeLessThan(frame.indexOf('renderer.render('))
    expect(source.match(/shadowMap\.needsUpdate=true/g)!.length).toBe(1)
  })

  // three's own shadow map, driven as the renderer drives it: each render of
  // the scene hands it the shadow-casting lights.
  function passes(automatic: boolean): number[] {
    const drawn: number[] = []
    let clears = 0
    const renderer = {
      state: { setBlending() {}, buffers: { color: { setClear() {} }, depth: { setTest() {} } }, setScissorTest() {}, viewport() {} },
      properties: { get: () => ({}) },
      localClippingEnabled: false,
      getRenderTarget: () => null,
      getActiveCubeFace: () => 0,
      getActiveMipmapLevel: () => 0,
      setRenderTarget() {},
      clear: () => clears++,
      renderBufferDirect() {},
    }
    type Parts = ConstructorParameters<typeof WebGLShadowMap>
    const map = new WebGLShadowMap(
      renderer as unknown as Parts[0],
      { update: (o: { geometry: unknown }) => o.geometry } as unknown as Parts[1],
      { maxTextureSize: 4096 } as unknown as Parts[2],
    )
    map.enabled = true
    map.autoUpdate = automatic
    const scene = new Scene(),
      sun = new DirectionalLight()
    sun.castShadow = true
    const box = new Mesh(new BoxGeometry(), new MeshStandardMaterial())
    box.castShadow = true
    scene.add(sun, sun.target, box)
    scene.updateMatrixWorld(true)
    const camera = new PerspectiveCamera()
    for (let frame = 0; frame < 2; frame++) {
      if (!automatic) map.needsUpdate = true
      for (let pass = 0; pass < 3; pass++) {
        const before = clears
        map.render([sun], scene, camera)
        drawn.push(clears - before)
      }
    }
    return drawn
  }
  it('with its automatic redraw off and a frame asking once, only the first of three passes draws it', () => {
    expect(passes(false)).toEqual([1, 0, 0, 1, 0, 0])
  })
  it('where left on, as three ships it, every pass redraws it', () => {
    expect(passes(true)).toEqual([1, 1, 1, 1, 1, 1])
  })
})
