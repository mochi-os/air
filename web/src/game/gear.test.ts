// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { advance, settled, type Mechanisms, type Timeline } from './gear'

// the F/A-18C's (tools/fa18c facts layout.motion sequence, doors and extension)
const LINE: Timeline = {
  up: { nose: [0, 0.5525], main: [0.2125, 0.85], doors: [0.85, 1] },
  down: { doors: [0, 0.04], nose: [0.04, 0.83], main: [0.04, 1] },
}
const STROKE = 5
const FRAME = 1 / 60

// run steps a gear from `state` toward one end for some seconds in frames,
// returning each frame's mechanisms
function run(state: Mechanisms, down: boolean, seconds: number): Mechanisms[] {
  const out: Mechanisms[] = []
  for (let i = 0; i < Math.round(seconds / FRAME); i++) {
    advance(LINE, state, down, FRAME, STROKE)
    out.push({ ...state })
  }
  return out
}

// first is the time a mechanism first meets a test, s
const first = (frames: Mechanisms[], test: (m: Mechanisms) => boolean) => (frames.findIndex(test) + 1) * FRAME

describe('settled', () => {
  it('poses every mechanism down or stowed at the ends', () => {
    expect(settled(LINE, 1)).toEqual({ nose: 1, main: 1, doors: 1 })
    expect(settled(LINE, 0)).toEqual({ nose: 0, main: 0, doors: 0 })
  })
  it('poses each through its own part of the retraction, as the checks pose one gear value (verify/model.py sequence)', () => {
    const at = settled(LINE, 0.75)
    expect(at.nose).toBeCloseTo(1 - 0.25 / 0.5525, 9)
    expect(at.main).toBeCloseTo(1 - (0.25 - 0.2125) / 0.6375, 9)
    expect(at.doors).toBe(1)
    expect(settled(LINE, 0.1).doors).toBeCloseTo(1 - 0.05 / 0.15, 9)
  })
})

describe('advance', () => {
  it('retracts the nose leg first, the mains after it, and closes the doors last, in the stroke', () => {
    const up = run(settled(LINE, 1), false, 5.2)
    expect(first(up, (m) => m.nose < 1)).toBeCloseTo(FRAME, 9)
    expect(first(up, (m) => m.main < 1)).toBeCloseTo(0.2125 * STROKE, 1)
    expect(first(up, (m) => m.nose === 0)).toBeCloseTo(0.5525 * STROKE, 1)
    expect(first(up, (m) => m.main === 0)).toBeCloseTo(0.85 * STROKE, 1)
    expect(first(up, (m) => m.doors < 1)).toBeGreaterThan(first(up, (m) => m.main === 0) - 1e-9)
    expect(first(up, (m) => m.doors === 0)).toBeCloseTo(STROKE, 1)
  })
  it('opens the doors first and lowers both legs together, the nose landing first, in the stroke', () => {
    const down = run(settled(LINE, 0), true, 5.2)
    expect(first(down, (m) => m.doors === 1)).toBeCloseTo(0.04 * STROKE, 1)
    const legs = first(down, (m) => m.nose > 0)
    expect(legs).toBeGreaterThan(first(down, (m) => m.doors === 1) - 1e-9)
    expect(first(down, (m) => m.main > 0)).toBeCloseTo(legs, 9)
    expect(first(down, (m) => m.nose === 1)).toBeCloseTo(0.83 * STROKE, 1)
    expect(first(down, (m) => m.main === 1)).toBeCloseTo(STROKE, 1)
    for (const m of down.slice(0, Math.round(legs / FRAME) - 1)) expect(m.nose + m.main).toBe(0)
  })
  it('draws an uninterrupted retraction as settled draws the gear at the same share of it', () => {
    const state = settled(LINE, 1)
    for (let i = 1; i <= 300; i++) {
      advance(LINE, state, false, FRAME, STROKE)
      const at = settled(LINE, 1 - (i * FRAME) / STROKE)
      for (const name of ['nose', 'main', 'doors']) expect(Math.abs(state[name] - at[name]), `${name} at ${i}`).toBeLessThan(0.03)
    }
  })
  it('turns each mechanism back from where it stands when the handle reverses, never jumping', () => {
    const state = settled(LINE, 1)
    const frames = [...run(state, false, 2), ...run(state, true, 2)]
    const turned = frames[Math.round(2 / FRAME)]
    const before = frames[Math.round(2 / FRAME) - 1]
    expect(turned.nose).toBeGreaterThan(before.nose)   // the legs come straight back: the doors are still open
    expect(turned.doors).toBe(1)
    for (let i = 1; i < frames.length; i++)
      for (const name of ['nose', 'main', 'doors']) expect(Math.abs(frames[i][name] - frames[i - 1][name])).toBeLessThan(FRAME / (0.04 * STROKE) + 1e-9)
  })
  it('opens the closing doors again before a leg moves when the handle goes down as they close', () => {
    const state = settled(LINE, 0.05)
    expect(state.doors).toBeGreaterThan(0)
    expect(state.doors).toBeLessThan(1)
    const down = run(state, true, 1)
    expect(down.some((m) => m.nose > 0)).toBe(true)
    for (const m of down) if (m.doors < 1) expect(m.nose + m.main).toBe(0)
  })
})

// The engine's side (engine.ts exterior_pose): each jet's mechanisms follow
// its gear value the way it travels, drawn outright at first sight or when the
// gear is set rather than travelling. engine.ts cannot be imported (WebGL at
// module scope), so the block is lifted from its source.
describe('the engine', () => {
  const engine = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
  const start = engine.indexOf('\tconst travel=down-(st.mechanismsAt??down);')
  const end = engine.indexOf('\tst.mechanismsAt=down;', start) + '\tst.mechanismsAt=down;'.length
  const block = new Function('st', 'down', 'dt', 'GEAR_RATE', 'MOTION', 'gear_settled', 'gear_advance', engine.slice(start, end)) as (
    st: { mechanisms?: Mechanisms },
    down: number,
    dt: number,
    rate: number,
    motion: { gear: Timeline },
    s: typeof settled,
    a: typeof advance
  ) => void
  const frame = (st: { mechanisms?: Mechanisms }, down: number) => block(st, down, FRAME, 1 / STROKE, { gear: LINE }, settled, advance)
  it('is found in exterior_pose', () => {
    expect(start).toBeGreaterThan(engine.indexOf('function exterior_pose('))
    expect(end).toBeLessThan(engine.indexOf('// shift_node moves a node'))
  })
  it('draws a jet first seen with its gear down, all down', () => {
    const st: { mechanisms?: Mechanisms } = {}
    frame(st, 1)
    expect(st.mechanisms).toEqual({ nose: 1, main: 1, doors: 1 })
  })
  it('follows the core retracting and lowering the gear, each mechanism in its order', () => {
    const st: { mechanisms?: Mechanisms } = {}
    let down = 1
    frame(st, down)
    const up: Mechanisms[] = []
    for (let i = 0; i < 330; i++) {
      down = Math.max(0, down - FRAME / STROKE)
      frame(st, down)
      up.push({ ...st.mechanisms! })
    }
    expect(first(up, (m) => m.main < 1)).toBeGreaterThan(first(up, (m) => m.nose < 1) + 1)
    expect(up[up.length - 1]).toEqual({ nose: 0, main: 0, doors: 0 })
    const lowered: Mechanisms[] = []
    for (let i = 0; i < 330; i++) {
      down = Math.min(1, down + FRAME / STROKE)
      frame(st, down)
      lowered.push({ ...st.mechanisms! })
    }
    expect(first(lowered, (m) => m.doors === 1)).toBeLessThan(first(lowered, (m) => m.nose > 0) + 1e-9)
    expect(first(lowered, (m) => m.main > 0)).toBeCloseTo(first(lowered, (m) => m.nose > 0), 9)
    expect(lowered[lowered.length - 1]).toEqual({ nose: 1, main: 1, doors: 1 })
  })
  it('draws the gear where it stands when it is set rather than travelling (a respawn)', () => {
    const st: { mechanisms?: Mechanisms } = {}
    frame(st, 0)
    frame(st, 1)
    expect(st.mechanisms).toEqual({ nose: 1, main: 1, doors: 1 })
  })
  it('keeps its pace when the core moves the gear only every other frame', () => {
    const st: { mechanisms?: Mechanisms } = {}
    let down = 1
    frame(st, down)
    for (let i = 0; i < 330; i++) {
      if (i % 2 === 0) down = Math.max(0, down - (2 * FRAME) / STROKE)
      frame(st, down)
    }
    expect(st.mechanisms).toEqual({ nose: 0, main: 0, doors: 0 })
  })
})
