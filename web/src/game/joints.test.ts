// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import points from '../assets/fa18c.json'
import { type Joint, pose, rig, roll, schedule } from './joints'

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6)

describe('schedule', () => {
  const keys = [
    [0, 0],
    [0.5, 1],
    [1, 4],
  ]
  it('reads piecewise linearly between keys', () => {
    close(schedule(keys, 0.25), 0.5)
    close(schedule(keys, 0.75), 2.5)
    close(schedule(keys, 0.5), 1)
  })
  it('holds at the ends', () => {
    close(schedule(keys, -3), 0)
    close(schedule(keys, 9), 4)
  })
  it('reads the column asked for', () => {
    const bend = [
      [-3, -0.3, -0.03],
      [7.5, 0.75, 0.075],
    ]
    close(schedule(bend, 1, 1), 0.1)
    close(schedule(bend, 1, 2), 0.01)
  })
  it('holds the first key for no input', () => {
    close(schedule(keys, NaN), 0)
  })
})

describe('roll', () => {
  it('wraps a turning angle into one turn', () => {
    close(roll(0.5), 0.5)
    close(roll(Math.PI * 2 + 0.5), 0.5)
    close(roll(-Math.PI * 2 - 0.5), -0.5)
    close(roll(Math.PI * 7), -Math.PI)
    expect(roll(Math.PI * 40 + 0.25)).toBeGreaterThanOrEqual(-Math.PI)
    expect(roll(Math.PI * 40 + 0.25)).toBeLessThan(Math.PI)
  })
})

// scene builds a small rig: a hinge with a child, a slide, a shown part, a bend
// and a mesh with a shape key, each at the place the contract puts its origin.
function scene() {
  const root = new THREE.Group()
  const hinge = new THREE.Group()
  hinge.name = 'flap'
  hinge.position.set(1, 0, 0)
  const tip = new THREE.Group()
  tip.name = 'tip'
  tip.position.set(0, 0, 1)
  hinge.add(tip)
  const slide = new THREE.Group()
  slide.name = 'oleo'
  const shown = new THREE.Group()
  shown.name = 'brace'
  const bend = new THREE.Group()
  bend.name = 'flex'
  bend.position.set(0, 0, 2)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3))
  geometry.morphAttributes.position = [new THREE.Float32BufferAttribute([0, 0, 0, 0, 0.1, 0, 0, 0, 0], 3)]
  const skin = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
  skin.name = 'skin'
  skin.updateMorphTargets()
  skin.morphTargetDictionary = { flex: 0 }
  root.add(hinge, slide, shown, bend, skin)
  return root
}

const joints: Record<string, Joint> = {
  flap: { motion: 'rotate', axis: [1, 0, 0], drive: 'flaperon', keys: [[-1, -1], [1, 1]] },
  oleo: { motion: 'slide', axis: [0, 2, 0], drive: 'oleo', keys: [[0, 0], [1, 0.5]] },
  brace: { motion: 'show', drive: 'gear', keys: [[0, 0], [1, 1]] },
  flex: { motion: 'bend', axis: [1, 0, 0], direction: [0, 1, 0], drive: 'load', keys: [[0, 0, 0], [1, 0.1, 0.02]] },
  skin: { motion: 'morph', morphs: { flex: { drive: 'load', keys: [[0, 0], [1, 1]] } } },
  missing: { motion: 'rotate', axis: [0, 1, 0], drive: 'rudder', keys: [[-1, -1], [1, 1]] },
}

describe('rig and pose', () => {
  it('finds each joint on the scene and leaves out what it lacks', () => {
    const posed = rig(scene(), joints)
    expect(posed.map((p) => p.name).sort()).toEqual(['brace', 'flap', 'flex', 'oleo', 'skin'])
    expect(posed.find((p) => p.name === 'skin')!.morphs).toHaveLength(1)
  })
  it('turns, slides, shows, bends and weights each joint by its keys', () => {
    const root = scene()
    const posed = rig(root, joints)
    const values: Record<string, number> = { flaperon: 0.3, oleo: 0.5, gear: 1, load: 0.5 }
    pose(posed, (drive) => values[drive])
    root.updateMatrixWorld(true)
    const tip = root.getObjectByName('tip')!.getWorldPosition(new THREE.Vector3())
    close(tip.x, 1)
    close(tip.y, -Math.sin(0.3))   // a turn about x carries the child's +z toward -y
    close(tip.z, Math.cos(0.3))
    const oleo = root.getObjectByName('oleo')!
    close(oleo.position.y, 0.25)   // half the travel, along the unit axis however it was written
    expect(root.getObjectByName('brace')!.visible).toBe(true)
    const flex = root.getObjectByName('flex')!
    close(new THREE.Euler().setFromQuaternion(flex.quaternion).x, 0.05)
    close(flex.position.y, 0.01)
    close(flex.position.z, 2)   // the slide starts from the joint's rest, not the origin
    close((root.getObjectByName('skin') as THREE.Mesh).morphTargetInfluences![0], 0.5)
  })
  it('poses from the rest every time rather than stacking', () => {
    const root = scene()
    const posed = rig(root, joints)
    for (let i = 0; i < 5; i++) pose(posed, (drive) => (drive === 'flaperon' ? 0.2 : undefined))
    close(new THREE.Euler().setFromQuaternion(root.getObjectByName('flap')!.quaternion).x, 0.2)
  })
  it('holds a joint whose drive has no value', () => {
    const root = scene()
    const posed = rig(root, joints)
    pose(posed, (drive) => (drive === 'oleo' ? 1 : undefined))
    pose(posed, () => undefined)
    close(root.getObjectByName('oleo')!.position.y, 0.5)
    expect(root.getObjectByName('brace')!.visible).toBe(true)
  })
  it('hides a shown part below half its keys', () => {
    const root = scene()
    const posed = rig(root, joints)
    pose(posed, (drive) => (drive === 'gear' ? 0.2 : undefined))
    expect(root.getObjectByName('brace')!.visible).toBe(false)
  })
})

// The points file is the build's (tools/fa18c/build.py), copied beside the
// model: every joint it names must be posable as the contract says.
describe('fa18c.json', () => {
  const all = (points as unknown as { joints: Record<string, Joint> }).joints
  it('gives every joint a motion the engine poses, and keys or morphs to pose it by', () => {
    for (const [name, joint] of Object.entries(all)) {
      expect(['rotate', 'slide', 'show', 'bend', 'morph'], name).toContain(joint.motion)
      if (joint.motion === 'morph') expect(Object.keys(joint.morphs || {}).length, name).toBeGreaterThan(0)
      else expect(joint.keys && joint.drive, name).toBeTruthy()
      if (joint.motion === 'rotate' || joint.motion === 'slide' || joint.motion === 'bend') expect(joint.axis, name).toHaveLength(3)
    }
  })
  it('lets the nosewheel steer 75 deg and the wheels roll half a turn either way', () => {
    for (const name of ['gear_nose_steering', 'gear_nose_wheel', 'gear_left_wheel', 'gear_right_wheel']) {
      const keys = all[name].keys!
      expect(keys[keys.length - 1][0], name).toBeGreaterThanOrEqual(Math.PI - 1e-6)
      expect(keys[0][0], name).toBeLessThanOrEqual(-Math.PI + 1e-6)
    }
  })
  // Every drive the points file names is one the engine computes: a joint on a
  // drive exterior_pose does not know would hold its rest for ever.
  it('names only drives the engine poses', () => {
    const engine = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
    const body = engine.slice(engine.indexOf('function exterior_pose('), engine.indexOf('// shift_node moves a node'))
    const drives = new Set<string>()
    for (const joint of Object.values(all)) {
      if (joint.drive) drives.add(joint.drive)
      for (const morph of Object.values(joint.morphs || {})) drives.add(morph.drive)
    }
    for (const drive of drives) expect(body, drive).toContain(`case "${drive}":`)
  })
})

// The engine's side (engine.ts, claude/plans/air-fa18c.md step 4): our model on
// every jet and in every external view, the old one on the pilot's jet in first
// person, and the joints driven from the jet's state.
const engine = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
function lift(name: string): string {
  const start = engine.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`${name} not found in engine.ts`)
  const rest = engine.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  return end ? rest.slice(0, end.index + 1) : rest
}

describe('the airframe each view draws', () => {
  const jet = (player: boolean) => {
    const node = () => ({ visible: true })
    return { userData: { player, exterior: { object: node(), airframe: [node(), node()] }, legacy: [node(), node()], pit: [node()], cockpitHide: [node()] } }
  }
  const run = new Function(`const cfg={ view:"chase" };
    ${lift('airframe_show')}
    return (g,view,force)=>{ cfg.view=view; airframe_show(g,force); const u=g.userData; return { ours:u.exterior.object.visible, frame:u.exterior.airframe.map((o)=>o.visible), old:u.legacy.map((o)=>o.visible), pit:u.pit[0].visible, pilot:u.cockpitHide[0].visible }; };`)() as (
    g: ReturnType<typeof jet>, view: string, force?: boolean) => { ours: boolean; frame: boolean[]; old: boolean[]; pit: boolean; pilot: boolean }
  it('draws our model outside and the old cockpit in first person on the pilot\'s jet, our stores in both', () => {
    const g = jet(true)
    expect(run(g, 'chase', true)).toEqual({ ours: true, frame: [true, true], old: [false, false], pit: false, pilot: false })
    // in first person our airframe's meshes hide behind the old one, our model (its stores and rounds) still drawn;
    // the figure is cockpit_hidden's to hide
    expect(run(g, 'cockpit')).toEqual({ ours: true, frame: [false, false], old: [true, true], pit: true, pilot: false })
    expect(run(g, 'hud')).toEqual({ ours: true, frame: [true, true], old: [false, false], pit: false, pilot: false })
  })
  it('hides the old pilot every frame outside, whoever showed him', () => {
    const g = jet(true)
    run(g, 'chase', true)
    g.userData.cockpitHide[0].visible = true   // cockpit_hidden on a switch between two outside views
    expect(run(g, 'flypast').pilot).toBe(false)
  })
  it('never draws the old airframe on another jet, and leaves its model to the distance stages', () => {
    const g = jet(false)
    g.userData.exterior.object.visible = false   // a distant stage has it hidden
    expect(run(g, 'cockpit', true)).toEqual({ ours: false, frame: [true, true], old: [false, false], pit: false, pilot: false })
  })
})

// The hook on a caught wire (engine.ts hook_swing): the shank trails the pull of
// the pendant's two legs, positive with the claw to starboard (the build's
// hook_swing sense), and holds within its travel (points file motion.swing).
describe('the hook on a wire', () => {
  const swing = (fwd: number[], right: number[], travel = 20) =>
    new Function('THREE', 'carrier_rig', 'ownship', 'MOTION', 'D2R', '_swing_q', '_swing_fwd', '_swing_right', `${lift('hook_swing')}\nreturn hook_swing`)(
      THREE, { getWorldQuaternion: (q: THREE.Quaternion) => q.identity() }, { fwd: new THREE.Vector3(...fwd), right: new THREE.Vector3(...right) },
      { swing: travel }, Math.PI / 180, new THREE.Quaternion(), new THREE.Vector3(), new THREE.Vector3()
    ) as (ax: number, az: number, bx: number, bz: number) => number
  const along = swing([1, 0, 0], [0, 0, 1])
  it('trails straight aft from a jet on the pendant\'s middle', () => {
    close(along(-30, -15, -30, 15), 0)
  })
  it('swings toward the middle from a jet off to one side', () => {
    // 5 m to starboard, 30 m past the sheaves: the port leg's longer pull
    // leans the bisector to port
    const a = Math.hypot(30, 20), b = Math.hypot(30, 10)
    close(along(-30, -20, -30, 10), -Math.atan2(20 / a - 10 / b, 30 / a + 30 / b))
    expect(along(-30, -10, -30, 20)).toBeGreaterThan(0)
  })
  it('reads the pull in the jet\'s own axes, turned on the deck', () => {
    const c = Math.cos(0.3), s = Math.sin(0.3)
    const turned = swing([c, 0, s], [-s, 0, c])
    const a = [-30 * c + 15 * s, -30 * s - 15 * c], b = [-30 * c - 15 * s, -30 * s + 15 * c]
    close(turned(a[0], a[1], b[0], b[1]), 0)
  })
  it('holds within its travel, and centres with the pull ahead of it', () => {
    close(along(-3, -40, -3, 1), -20 * Math.PI / 180)
    close(along(30, -15, 30, 15), 0)
  })
})

// The canopy (engine.ts update_anim), as public-domain videos time it: opening
// a 2.3 s slide aft and a 6.9 s rise at one pace through its drive, the slide
// the drive's first quarter; closing a 4.5 s fall, then a 2.0 s slide forward
// to lock.
describe('the canopy', () => {
  const lines = /\n\tif\(st\.canopy===undefined\)[^\n]*\n\t\{ const c=MOTION\.canopy[^\n]*\n[^\n]*\n/.exec(engine)?.[0] ?? ''
  const MOTION = { seconds: { canopy: 9.2 }, canopy: { unlatch: 0.25, fall: 4.5, lock: 2 } }
  const run = (st: Record<string, number>, seconds: number) => {
    if (!lines) throw new Error('the canopy lines not found in update_anim')
    const dt = 1 / 60
    for (let i = 0; i < Math.round(seconds / dt); i++) new Function('st', 'dt', 'MOTION', 'THREE', lines)(st, dt, MOTION, THREE)
    return st.canopy
  }
  it('opens through its slide in 2.3 s and is up in 9.2', () => {
    const st = { canopy: 0, canopyTarget: 1 }
    expect(run(st, 2.3)).toBeCloseTo(0.25, 2)
    expect(run(st, 6.9)).toBeCloseTo(1, 2)
  })
  it('closes its fall in 4.5 s and locks 2.0 s after', () => {
    const st = { canopy: 1, canopyTarget: 0 }
    expect(run(st, 4.5)).toBeCloseTo(0.25, 2)
    expect(run(st, 1)).toBeCloseTo(0.125, 2)
    expect(run(st, 1)).toBeCloseTo(0, 2)
  })
})

// The FCS ram air scoop (engine.ts update_anim, NATOPS 2.16.7): AV COOL
// EMERG deploys it on the pilot's jet, it cannot be closed in flight, and a
// plane captain restows it by hand once the jet is stopped on the deck with
// the switch back at NORM.
describe('the ram air scoop', () => {
  const lines = /\n\tif\(st===ownship\)\{ if\(travel_at\("avcool"\)[^\n]*\n\tif\(st\.scoop===undefined\)[^\n]*\n/.exec(engine)?.[0] ?? ''
  const step = (st: Record<string, unknown>, avcool: number, dt: number, own = true) => {
    if (!lines) throw new Error('the scoop lines not found in update_anim')
    const ownship = own ? st : {}
    new Function('st', 'ownship', 'travel_at', 'dt', 'MOTION', 'THREE', lines)(st, ownship, (name: string) => (name === 'avcool' ? avcool : 0), dt, { seconds: { scoop: 1 } }, THREE)
    return st.scoop as number
  }
  it('deploys on AV COOL EMERG, over its stroke', () => {
    const st = { squish: 0, speed: 150, scoop: 0 }
    close(step(st, 1, 0.5), 0.5)
    close(step(st, 1, 1), 1)
  })
  it('stays stowed at NORM, and on another jet', () => {
    close(step({ squish: 0, speed: 150, scoop: 0 }, 0, 1), 0)
    close(step({ squish: 1, speed: 0, scoop: 0 }, 1, 1, false), 0)
  })
  it('stays out in flight and rolling once deployed, the switch back at NORM', () => {
    const st = { squish: 0, speed: 150, scoop: 0 }
    step(st, 1, 1)
    close(step(st, 0, 1), 1)
    st.squish = 1
    st.speed = 5
    close(step(st, 0, 1), 1)
  })
  it('is restowed stopped on the deck at NORM', () => {
    const st = { squish: 0, speed: 150, scoop: 0 }
    step(st, 1, 1)
    st.squish = 1
    st.speed = 0
    close(step(st, 0, 0.5), 0.5)
  })
})

describe('the lights on our model', () => {
  it('ride the outer panels where they sit on them', () => {
    const lights = (points as unknown as { points: { lights: Record<string, { node?: string }> } }).points.lights
    for (const side of ['left', 'right']) {
      for (const name of [`position_fold_${side}`, `formation_tip_${side}`, `formation_undertip_${side}`]) expect(lights[name]?.node, name).toBe(`wing_${side}`)
    }
    expect(lights.landing?.node).toBe('gear_nose_strut')
  })
})
