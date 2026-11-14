// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import aim120c_points from '../assets/aim120c.json'
import aim9m_points from '../assets/aim9m.json'
import fa18c_points from '../assets/fa18c.json'
import ford_ship from '../assets/ford.json'
import * as THREE from 'three'
import { engine, fa18c, ford, missile, nozzle, rises, spin, STILL, stroke } from './cycle'
import { rig, schedule, type Joint } from './joints'
import { PACE, REACH } from './oleo'
import { deflectors, layout, raising } from './ship'

const DEGREE = Math.PI / 180
const LEGS = { nose: 1, left: 0.4, right: 0.5 } // each leg's wheel rise per unit of its oleo drive, for these tests
const FORD = layout(ford_ship as unknown as Parameters<typeof layout>[0])
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')

// after reads a mover after stepping it some seconds in one step, and in
// frames of a sixtieth of a second, which must agree
function after(mover: { step: (s: number) => void; readonly value: number }, seconds: number): number {
  mover.step(seconds)
  return mover.value
}

// framed steps a fresh mover in frames of a sixtieth of a second for some
// seconds, returning what it read after each
function framed(mover: { step: (s: number) => void; readonly value: number }, seconds: number): number[] {
  const out: number[] = []
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    mover.step(1 / 60)
    out.push(mover.value)
  }
  return out
}

// drives lists the drives a points file's joints and morphs read
function drives(joints: Record<string, { drive?: string; morphs?: Record<string, { drive: string }> }>): Set<string> {
  const out = new Set<string>()
  for (const j of Object.values(joints)) {
    if (j.drive) out.add(j.drive)
    for (const m of Object.values(j.morphs ?? {})) out.add(m.drive)
  }
  return out
}

describe('stroke', () => {
  it('runs from rest to the high end at its pace, back to the low end and on', () => {
    expect(after(stroke(-1, 2, 0.5), 3.9)).toBeCloseTo(1.95, 9)
    expect(after(stroke(-1, 2, 0.5), 4)).toBeCloseTo(2, 9)
    expect(after(stroke(-1, 2, 0.5), 5)).toBeCloseTo(1.5, 9)
    expect(after(stroke(-1, 2, 0.5), 10)).toBeCloseTo(-1, 9)
    expect(after(stroke(-1, 2, 0.5), 12)).toBeCloseTo(0, 9)
    expect(Math.min(...framed(stroke(-1, 2, 0.5), 30))).toBeCloseTo(-1, 1)
    expect(Math.max(...framed(stroke(-1, 2, 0.5), 30))).toBeCloseTo(2, 1)
  })
  it('reads the same stepped in frames as in one step', () => {
    const read = framed(stroke(-1, 2, 0.7), 7)
    expect(read[read.length - 1]).toBeCloseTo(after(stroke(-1, 2, 0.7), 7), 9)
  })
  it('turns back within one step that passes an end', () => {
    const m = stroke(0, 1, 1)
    m.step(1.25)
    expect(m.value).toBeCloseTo(0.75, 9)
    m.step(1)
    expect(m.value).toBeCloseTo(0.25, 9)
  })
  it('starts from the end nearest rest when rest is outside its travel', () => {
    expect(stroke(2, 3, 1).value).toBe(2)
    expect(stroke(-3, -2, 1).value).toBe(-2)
  })
  it('moves at a pace that depends on where it stands and which way it goes, changing it at its stops', () => {
    const pace = (v: number, rising: boolean) => (rising ? 1 : v > 0.5 ? 0.25 : 1)
    const m = stroke(0, 1, pace, [0.5])
    m.step(1)
    expect(m.value).toBe(1)
    m.step(1)
    expect(m.value).toBeCloseTo(0.75, 9)
    expect(after(stroke(0, 1, pace, [0.5]), 3.25)).toBeCloseTo(0.25, 9)
    expect(after(stroke(0, 1, pace, [0.5]), 3.5)).toBeCloseTo(0, 9)
  })
})

describe('spin', () => {
  it('turns one way for its seconds, then back the other way', () => {
    const m = spin(1, 2)
    m.step(1)
    expect(m.value).toBeCloseTo(1, 9)
    m.step(1.5)
    expect(m.value).toBeCloseTo(1.5, 9)
    m.step(1.5)
    expect(m.value).toBeCloseTo(0, 9)
  })
  it('reads its angle wrapped into one turn', () => {
    const m = spin(Math.PI, 10)
    m.step(1.5)
    expect(m.value).toBeCloseTo(-Math.PI / 2, 9)
  })
})

describe('engine', () => {
  it('opens the nozzles at idle, closes them by military power and opens them with the reheat', () => {
    expect(nozzle(0.06, 0)).toBe(0)
    expect(nozzle(0.7, 0)).toBe(1)
    expect(nozzle(1, 1)).toBe(0)
    const m = engine(6)
    framed(m, 6)
    expect(m.value).toBe(0)
    const full = framed(m, 6)
    expect(Math.max(...full)).toBeGreaterThan(0.9)
    expect(full[full.length - 1]).toBeLessThan(0.02)
  })
  it('poses the nozzles as the engine does', () => {
    expect(source).toContain('const open=Math.max(clamp((0.7-spool)/0.55,0,1),clamp(stage,0,1));')
    expect(source).toContain('case "nozzle": return 1-open;')
  })
})

describe('the F/A-18C', () => {
  const joints = (fa18c_points as unknown as { joints: Record<string, { drive?: string; keys?: number[][] }> }).joints
  it('moves every drive its joints read but the loadout', () => {
    const motion = fa18c(LEGS)
    for (const drive of drives(joints)) {
      if (STILL.has(drive)) expect(motion.value(drive, '')).toBeUndefined()
      else expect(motion.value(drive, ''), drive).toBeTypeOf('number')
    }
  })
  it("keeps each mechanism within its joints' travel and takes it from end to end", () => {
    for (const drive of ['gear', 'speedbrake', 'canopy', 'probe', 'bar', 'fold', 'hook', 'scoop', 'nozzle', 'load']) {
      const keys = Object.values(joints).find((j) => j.drive === drive)!.keys!
      const low = keys[0][0]
      const high = keys[keys.length - 1][0]
      const read: number[] = []
      const motion = fa18c(LEGS)
      for (let i = 0; i < 60 * 30; i++) {
        motion.step(1 / 60)
        read.push(motion.value(drive, '')!)
      }
      expect(Math.min(...read), drive).toBeCloseTo(low, 1)
      expect(Math.max(...read), drive).toBeCloseTo(high, 1)
    }
  })
  // read is a drive of a fresh motion after some seconds
  const read = (drive: string, seconds: number) => {
    const motion = fa18c(LEGS)
    motion.step(seconds)
    return motion.value(drive, '')!
  }
  it('runs the gear and the mechanisms at their stroke times', () => {
    const { seconds, canopy } = (fa18c_points as unknown as { motion: { seconds: Record<string, number>; canopy: { unlatch: number; fall: number; lock: number } } }).motion
    expect(read('gear', 2.5)).toBeCloseTo(0.5, 9)
    expect(read('gear', 5)).toBeCloseTo(1, 9)
    expect(read('gear', 7.5)).toBeCloseTo(0.5, 9)
    expect(read('gear', 10)).toBeCloseTo(0, 9)
    expect(read('speedbrake', 2.5)).toBeCloseTo(1, 9)
    for (const drive of ['probe', 'bar', 'fold', 'hook', 'scoop']) {
      expect(read(drive, seconds[drive] / 2), drive).toBeCloseTo(0.5, 9)
      expect(read(drive, seconds[drive]), drive).toBeCloseTo(1, 9)
    }
    expect(read('canopy', seconds.canopy)).toBeCloseTo(1, 9)
    expect(read('canopy', seconds.canopy + canopy.fall)).toBeCloseTo(canopy.unlatch, 9)
    expect(read('canopy', seconds.canopy + canopy.fall + canopy.lock)).toBeCloseTo(0, 9)
  })
  it("moves the gear at the pace the engine draws the gear of a jet the core doesn't fly", () => {
    expect(source).toContain('const GEAR_RATE=0.2;')
    expect(read('gear', 1)).toBeCloseTo(0.2, 9)
  })
  it('times the canopy as the engine does', () => {
    expect(source).toContain('rate=(st.canopyTarget??0)>=st.canopy?1/MOTION.seconds.canopy:st.canopy>c.unlatch?(1-c.unlatch)/c.fall:c.unlatch/c.lock;')
  })
  it('moves the flight controls through their throws at their rate limits', () => {
    const rate = 40 * DEGREE
    expect(read('stabilator.left', 0.183 / rate)).toBeCloseTo(0.183, 9)
    expect(read('stabilator.right', (2 * 0.183 + 0.42) / rate)).toBeCloseTo(-0.42, 9)
    expect(read('aileron.left', 0.45)).toBeCloseTo(45 * DEGREE, 9)
    expect(read('aileron.right', 1.15)).toBeCloseTo(-25 * DEGREE, 9)
    expect(read('trailing.left', 2.5)).toBeCloseTo(45 * DEGREE, 9)
    expect(read('trailing.right', (45 + 45 + 8) / 18)).toBeCloseTo(-8 * DEGREE, 9)
    expect(read('slat', (25 * DEGREE) / 0.6)).toBeCloseTo(25 * DEGREE, 9)
    expect(read('rudder', 0.4)).toBeCloseTo(30 * DEGREE, 9)
    expect(read('rudder', 1.2)).toBeCloseTo(-30 * DEGREE, 9)
    expect(read('steering', (75 * DEGREE) / 0.4)).toBeCloseTo(75 * DEGREE, 9)
  })
  it("slews the nosewheel's steering as the engine does", () => {
    expect(source).toContain('st.steer=(st.steer??0)+THREE.MathUtils.clamp(target-(st.steer??0),-0.4*dt,0.4*dt);')
  })
  it('lifts each wheel on its oleo as far and as fast as the engine draws it', () => {
    expect(read('oleo.nose', REACH / PACE)).toBeCloseTo(REACH / LEGS.nose, 9)
    expect(read('oleo.left', REACH / PACE)).toBeCloseTo(REACH / LEGS.left, 9)
    expect(read('oleo.right', REACH / PACE / 2)).toBeCloseTo(REACH / LEGS.right / 2, 9)
    expect(read('oleo.right', (2 * REACH) / PACE)).toBeCloseTo(0, 9)
  })
  it("measures each leg's wheel rise per unit of its oleo drive with the gear down", () => {
    // a leg that swings down on the gear drive, its oleo sliding its wheel
    // up 0.8 m a unit along the leg, and its wheel a child of the oleo
    const scene = new THREE.Group()
    const joints: Record<string, Joint> = {}
    for (const [leg, rise] of [['nose', 0.8], ['left', 0.3], ['right', 0.3]] as const) {
      const strut = new THREE.Object3D()
      strut.name = `gear_${leg}_strut`
      const oleo = new THREE.Object3D()
      oleo.name = `gear_${leg}_oleo`
      const wheel = new THREE.Object3D()
      wheel.name = `gear_${leg}_wheel`
      wheel.position.set(0, 0, -1)
      scene.add(strut)
      strut.add(oleo)
      oleo.add(wheel)
      // stowed the leg lies along -z; down it hangs along -y
      joints[strut.name] = { motion: 'rotate', axis: [1, 0, 0], drive: 'gear', keys: [[0, 0], [1, -Math.PI / 2]] }
      joints[oleo.name] = { motion: 'slide', axis: [0, 0, 1], drive: `oleo.${leg}`, keys: [[0, 0], [1, rise]] }
    }
    const legs = rises(scene, rig(scene, joints))
    expect(legs.nose).toBeCloseTo(0.8, 6)
    expect(legs.left).toBeCloseTo(0.3, 6)
    expect(legs.right).toBeCloseTo(0.3, 6)
  })
  it('rolls each wheel at its own radius', () => {
    const { gear } = (fa18c_points as unknown as { points: { gear: Record<string, { radius: number }> } }).points
    const motion = fa18c(LEGS)
    motion.step(0.1)
    expect(motion.value('wheel.nose', '')).toBeCloseTo((5.1 * 0.1) / gear.nose.radius, 6)
    expect(motion.value('wheel.left', '')).toBeCloseTo((5.1 * 0.1) / gear.left.radius, 6)
  })
  it('swings the hook through its travel each way at the game\'s rate', () => {
    const { swing, seconds } = (fa18c_points as unknown as { motion: { swing: number; seconds: { swing: number } } }).motion
    expect(read('swing', seconds.swing)).toBeCloseTo(swing * DEGREE, 9)
    expect(read('swing', 3 * seconds.swing)).toBeCloseTo(-swing * DEGREE, 9)
    // the rate is the points file's, whatever it holds
    const slower = structuredClone(fa18c_points) as unknown as { motion: { seconds: { swing: number } } }
    slower.motion.seconds.swing = 2
    const motion = fa18c(LEGS, slower as unknown as Parameters<typeof fa18c>[1])
    motion.step(2)
    expect(motion.value('swing', '')).toBeCloseTo(swing * DEGREE, 9)
  })
})

describe('the missiles', () => {
  it('moves every drive their joints read', () => {
    for (const points of [aim9m_points, aim120c_points]) {
      const motion = missile()
      for (const drive of drives((points as unknown as { joints: Record<string, { drive?: string }> }).joints))
        expect(motion.value(drive, ''), drive).toBeTypeOf('number')
    }
  })
})

describe('the Ford', () => {
  it('moves every joint', () => {
    const motion = ford(FORD)
    for (const name of Object.keys(FORD.joints)) expect(motion.value(FORD.joints[name].drive, name), name).toBeTypeOf('number')
  })
  it('raises the blast deflectors in real time, their struts following as the engine poses them', () => {
    const motion = ford(FORD)
    motion.step(0.5)
    const pose = deflectors(FORD, 0.5)
    for (const [name, joint] of Object.entries(FORD.joints)) {
      if (!/^catapult_\d+_deflector/.test(name)) continue
      expect(schedule(joint.keys, motion.value(joint.drive, name)!), name).toBeCloseTo(pose[name], 6)
    }
    expect(read('catapult_1_deflector', raising(FORD))).toBeCloseTo(raising(FORD), 9)
    expect(read('catapult_1_deflector', 2 * raising(FORD))).toBeCloseTo(0, 9)
  })
  it("shoots the shuttles over the stroke at the catapults' capped end speed", () => {
    const cat = FORD.catapults[0]
    expect(read('catapult_1_shuttle', (2 * cat.stroke) / cat.speed)).toBeCloseTo(1, 9)
  })
  // read is a Ford joint of a fresh motion after some seconds
  function read(name: string, seconds: number): number {
    const motion = ford(FORD)
    motion.step(seconds)
    return motion.value(FORD.joints[name].drive, name)!
  }
})
