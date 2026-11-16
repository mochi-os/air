// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import fa18c_points from '../assets/fa18c.json'
import * as THREE from 'three'
import { engine, fa18c, flight, nozzle, rises, STILL, stroke } from './cycle'
import { rig, type Joint } from './joints'
import { PACE } from './oleo'

const DEGREE = Math.PI / 180
const LEGS = { nose: 1, left: 0.4, right: 0.5 } // each leg's wheel rise per unit of its oleo drive, for these tests
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

describe('a flight', () => {
  // each leg's stance on the ground in drive, its wheel's radius, and the
  // launch bar's stroke time, for these tests
  const STANCE = { nose: 0.4, left: 0.8, right: 0.8 }
  const RADIUS = { nose: 0.27, left: 0.37, right: 0.37 }
  const BAR = 1.25
  const GROUND = ['oleo.nose', 'oleo.left', 'oleo.right', 'steering', 'bar'] as const
  // frames of a fresh flight over some seconds: each drive's value after each
  const frames = (seconds: number) => {
    const movers = flight(LEGS, STANCE, RADIUS, BAR)
    const out: Record<string, number>[] = []
    for (let i = 0; i < Math.round(seconds * 60); i++) {
      for (const m of Object.values(movers)) m.step(1 / 60)
      out.push(Object.fromEntries(Object.entries(movers).map(([drive, m]) => [drive, m.value])))
    }
    return out
  }
  const run = frames(60)
  it('moves nothing that needs weight on the wheels with the gear travelling or stowed', () => {
    let moving = 0
    for (let i = 1; i < run.length; i++) {
      if (run[i].gear === 1 && run[i - 1].gear === 1) continue
      moving++
      for (const drive of GROUND) expect(run[i][drive], `${drive} at frame ${i}`).toBe(0)
      for (const leg of ['nose', 'left', 'right']) expect(run[i][`wheel.${leg}`], `wheel.${leg} at frame ${i}`).toBe(run[i - 1][`wheel.${leg}`])
    }
    expect(moving).toBeGreaterThan(60 * 20) // two cycles' travel and stowage
  })
  it('runs the gear 5 s each way', () => {
    expect(run[149].gear).toBeCloseTo(0.5, 9)
    expect(run[299].gear).toBeCloseTo(1, 9)
    const up = run.findIndex((f, i) => i > 300 && f.gear < 1)
    expect(run[up - 1 + 150].gear).toBeCloseTo(0.5, 2)
    expect(run[up + 300].gear).toBeCloseTo(0, 9)
  })
  it("eases each oleo to its stance on touchdown at the engine's pace, and out again on lift-off", () => {
    const touch = run.findIndex((f) => f['oleo.nose'] > 0)
    for (const leg of ['nose', 'left', 'right'] as const) {
      // PACE metres a second of its wheel's rise, by its rise a unit of drive
      const pace = PACE / LEGS[leg]
      expect(run[touch + 1][`oleo.${leg}`] - run[touch][`oleo.${leg}`], leg).toBeCloseTo(pace / 60, 9)
      expect(Math.max(...run.map((f) => f[`oleo.${leg}`])), leg).toBeCloseTo(STANCE[leg], 9)
      const lift = run.findIndex((f, i) => i > touch && f[`oleo.${leg}`] < STANCE[leg] && run[i - 1][`oleo.${leg}`] === STANCE[leg])
      expect(run[lift][`oleo.${leg}`] - run[lift + 1][`oleo.${leg}`], leg).toBeCloseTo(pace / 60, 9)
    }
  })
  it('steers the nosewheel to each stop and lowers and raises the launch bar on the ground', () => {
    expect(Math.max(...run.map((f) => f.steering))).toBeCloseTo(75 * DEGREE, 2)
    expect(Math.min(...run.map((f) => f.steering))).toBeCloseTo(-75 * DEGREE, 2)
    expect(Math.max(...run.map((f) => f.bar))).toBe(1)
    // the slew no faster than the engine's 0.4 rad/s, the bar than its stroke
    for (let i = 1; i < run.length; i++) {
      expect(Math.abs(run[i].steering - run[i - 1].steering)).toBeLessThanOrEqual(0.4 / 60 + 1e-9)
      expect(Math.abs(run[i].bar - run[i - 1].bar)).toBeLessThanOrEqual(1 / BAR / 60 + 1e-9)
    }
  })
  it('rolls each wheel at a taxi from touchdown, at its own radius', () => {
    const touch = run.findIndex((f) => f['oleo.nose'] > 0)
    const after = run[touch + 6]
    const before = run[touch - 1]
    for (const leg of ['nose', 'left', 'right'] as const) {
      const turned = (5.1 * (7 / 60)) / RADIUS[leg]
      expect(after[`wheel.${leg}`] - before[`wheel.${leg}`], leg).toBeCloseTo(turned, 6)
    }
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

// The model viewer offers the Motion button for the F/A-18C alone (user,
// 2026-11-13): nothing drives the missiles' or the Ford's parts there
describe('the viewer', () => {
  it('offers motion for fa18c.glb alone', () => {
    const viewer = readFileSync(fileURLToPath(new URL('../components/ModelViewer.tsx', import.meta.url)), 'utf8')
    expect(viewer).toContain("file: 'fa18c.glb',")
    expect(viewer).toContain('{chosen === MOTION.file && loaded && (')
    expect(viewer).toContain("if (!current || !loaded || !moving || chosen !== MOTION.file) return")
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
    expect(read('speedbrake', 2.5)).toBeCloseTo(1, 9)
    for (const drive of ['probe', 'fold', 'hook', 'scoop']) {
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
  })
  it("slews the nosewheel's steering as the engine does", () => {
    expect(source).toContain('st.steer=(st.steer??0)+THREE.MathUtils.clamp(target-(st.steer??0),-0.4*dt,0.4*dt);')
  })
  it("compresses each oleo to its stance on the ground, and strokes the launch bar at its time, from the points file", () => {
    const { points, motion: timing } = fa18c_points as unknown as { points: { gear: Record<'nose' | 'left' | 'right', { static: number }> }; motion: { seconds: { bar: number } } }
    const motion = fa18c(LEGS)
    const most = { nose: 0, left: 0, right: 0 }
    let bar = 0
    let swing = 0
    for (let i = 0; i < 60 * 30; i++) {
      motion.step(1 / 60)
      for (const leg of ['nose', 'left', 'right'] as const) most[leg] = Math.max(most[leg], motion.value(`oleo.${leg}`, '')!)
      swing = Math.max(swing, Math.abs(motion.value('bar', '')! - bar))
      bar = motion.value('bar', '')!
    }
    for (const leg of ['nose', 'left', 'right'] as const) expect(most[leg], leg).toBeCloseTo(points.gear[leg].static, 9)
    expect(swing).toBeCloseTo(1 / timing.seconds.bar / 60, 9)
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
  it("rolls each wheel at its own radius in the points file", () => {
    const { gear } = (fa18c_points as unknown as { points: { gear: Record<string, { radius: number }> } }).points
    const motion = fa18c(LEGS)
    let touched = 0
    for (let i = 0; i < 60 * 10 && !touched; i++) {
      motion.step(1 / 60)
      if (motion.value('oleo.nose', '')! > 0) touched = i
    }
    const nose = motion.value('wheel.nose', '')!
    const left = motion.value('wheel.left', '')!
    motion.step(0.1)
    expect(motion.value('wheel.nose', '')! - nose).toBeCloseTo((5.1 * 0.1) / gear.nose.radius, 6)
    expect(motion.value('wheel.left', '')! - left).toBeCloseTo((5.1 * 0.1) / gear.left.radius, 6)
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
