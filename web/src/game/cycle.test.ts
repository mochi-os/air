// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import fa18c_points from '../assets/fa18c.json'
import { engine, fa18c, flight, nozzle, STILL, stroke } from './cycle'

const DEGREE = Math.PI / 180
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
  // the F/A-18C's timeline (tools/fa18c facts layout.motion sequence, doors and extension)
  const LINE = {
    up: { nose: [0, 0.5525], main: [0.2125, 0.85], doors: [0.85, 1] },
    down: { doors: [0, 0.04], nose: [0.04, 0.83], main: [0.04, 1] },
  }
  const GROUND = ['oleo.nose', 'oleo.left', 'oleo.right', 'steering', 'bar', 'wheel.nose', 'wheel.left', 'wheel.right'] as const
  // frames of a fresh flight over some seconds: each drive's value after each
  const frames = (seconds: number) => {
    const movers = flight(LINE)
    const out: Record<string, number>[] = []
    for (let i = 0; i < Math.round(seconds * 60); i++) {
      for (const m of Object.values(movers)) m.step(1 / 60)
      out.push(Object.fromEntries(Object.entries(movers).map(([drive, m]) => [drive, m.value])))
    }
    return out
  }
  const run = frames(30)
  // the first frame's time from `from` at which a test holds, s
  const when = (test: (f: Record<string, number>) => boolean, from = 0) => (run.findIndex((f, i) => i >= from * 60 && test(f)) + 1) / 60
  it('moves nothing that needs weight on the wheels, the whole cycle', () => {
    for (let i = 0; i < run.length; i++) for (const drive of GROUND) expect(run[i][drive], `${drive} at frame ${i}`).toBe(0)
  })
  it('lowers the gear as the footage shows: the doors open first, then both legs together, the nose down first, all in 5 s', () => {
    expect(when((f) => f['gear.doors'] === 1)).toBeCloseTo(0.2, 1)
    const legs = when((f) => f['gear.nose'] > 0)
    expect(when((f) => f['gear.main'] > 0)).toBeCloseTo(legs, 9)
    for (const f of run.slice(0, Math.round(legs * 60) - 1)) expect(f['gear.nose'] + f['gear.main']).toBe(0)
    expect(when((f) => f['gear.nose'] === 1)).toBeCloseTo(0.83 * 5, 1)
    expect(when((f) => f['gear.main'] === 1)).toBeCloseTo(5, 1)
  })
  it('raises it as the photos show: the nose leg first, the mains after, the doors last, in 5 s from the handle', () => {
    // down 5 s and held 1 s: the handle goes up at 6 s
    expect(when((f) => f['gear.nose'] < 1, 5.5)).toBeCloseTo(6 + 1 / 60, 2)
    expect(when((f) => f['gear.main'] < 1, 5.5)).toBeCloseTo(6 + 0.2125 * 5, 1)
    expect(when((f) => f['gear.doors'] < 1, 5.5)).toBeGreaterThan(when((f) => f['gear.main'] === 0, 5.5) - 1e-9)
    expect(when((f) => f['gear.doors'] === 0, 5.5)).toBeCloseTo(11, 1)
  })
  it('turns from down straight to up, and from stowed straight to down: no touchdown between', () => {
    const down = when((f) => f['gear.main'] === 1)
    const up = when((f) => f['gear.nose'] < 1, down)
    expect(up - down).toBeCloseTo(1, 1)
    const stowed = when((f) => f['gear.doors'] === 0, up)
    expect(when((f) => f['gear.doors'] > 0, stowed) - stowed).toBeCloseTo(1, 1)
    for (let i = Math.round(down * 60); i < Math.round(up * 60) - 1; i++) for (const m of ['doors', 'nose', 'main']) expect(run[i][`gear.${m}`]).toBe(1)
  })
  it('reads the same stepped in one go as in frames', () => {
    const movers = flight(LINE)
    for (const m of Object.values(movers)) m.step(8.3)
    for (const m of ['doors', 'nose', 'main']) expect(movers[`gear.${m}`].value, m).toBeCloseTo(run[Math.round(8.3 * 60) - 1][`gear.${m}`], 2)
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
    const motion = fa18c()
    for (const drive of drives(joints)) {
      if (STILL.has(drive)) expect(motion.value(drive, '')).toBeUndefined()
      else expect(motion.value(drive, ''), drive).toBeTypeOf('number')
    }
  })
  it("keeps each mechanism within its joints' travel and takes it from end to end", () => {
    for (const drive of ['gear.doors', 'gear.nose', 'gear.main', 'speedbrake', 'canopy', 'probe', 'fold', 'hook', 'scoop', 'nozzle', 'load']) {
      const keys = Object.values(joints).find((j) => j.drive === drive)!.keys!
      const low = keys[0][0]
      const high = keys[keys.length - 1][0]
      const read: number[] = []
      const motion = fa18c()
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
    const motion = fa18c()
    motion.step(seconds)
    return motion.value(drive, '')!
  }
  it('runs the gear and the mechanisms at their stroke times', () => {
    const { seconds, canopy } = (fa18c_points as unknown as { motion: { seconds: Record<string, number>; canopy: { unlatch: number; fall: number; lock: number } } }).motion
    const { gear } = (fa18c_points as unknown as { motion: { gear: Record<'down', Record<'doors' | 'nose' | 'main', number[]>> } }).motion
    for (const m of ['doors', 'nose', 'main'] as const) expect(read(`gear.${m}`, gear.down[m][1] * 5 + 0.05), m).toBeCloseTo(1, 9)
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
    expect(source).toContain('gear_advance(MOTION.gear,st.mechanisms,lowering,dt,1/GEAR_RATE)')
    expect(read('gear.main', 0.2 + 4.8 / 2)).toBeCloseTo(0.5, 2)
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
  it('swings the hook through its travel each way at the game\'s rate, once it is down', () => {
    const { swing, seconds } = (fa18c_points as unknown as { motion: { swing: number; seconds: { swing: number; hook: number } } }).motion
    expect(read('swing', seconds.hook + seconds.swing)).toBeCloseTo(swing * DEGREE, 9)
    expect(read('swing', seconds.hook + 3 * seconds.swing)).toBeCloseTo(-swing * DEGREE, 9)
    // the rate is the points file's, whatever it holds
    const slower = structuredClone(fa18c_points) as unknown as { motion: { seconds: { swing: number; hook: number } } }
    slower.motion.seconds.swing = 2
    const motion = fa18c(slower as unknown as Parameters<typeof fa18c>[0])
    motion.step(seconds.hook + 2)
    expect(motion.value('swing', '')).toBeCloseTo(swing * DEGREE, 9)
  })
  it('swings the hook only while it is down: stowed or moving, a swing takes its point through the nozzles', () => {
    const { seconds } = (fa18c_points as unknown as { motion: { seconds: { swing: number; hook: number } } }).motion
    const motion = fa18c()
    let swung = 0
    for (let i = 0; i < Math.round((2 * seconds.hook + 4 * seconds.swing) * 2 * 60); i++) {
      motion.step(1 / 60)
      const hook = motion.value('hook', '')!
      const swing = motion.value('swing', '')!
      if (hook < 1) expect(swing, `swing at hook ${hook}`).toBe(0)
      else swung = Math.max(swung, Math.abs(swing))
    }
    expect(swung).toBeGreaterThan(0)
  })
})
