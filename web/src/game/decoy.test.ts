// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { decoy_aspect, decoy_chance, decoy_lure, FLARE } from './decoy'

// A jet flying north (-z), and a round on each side of it.
const nose = { x: 0, y: 0, z: -1 }
const astern = { x: 0, y: 0, z: 800 } // the round behind the jet, chasing it
const ahead = { x: 0, y: 0, z: -800 } // the round in front, as it is of the jet that fired it
const abeam = { x: 800, y: 0, z: 0 }

describe('the flare roll', () => {
  it('reads the round dead astern as a tail aspect, and ahead or abeam as none', () => {
    expect(decoy_aspect(astern, nose)).toBeCloseTo(1, 6)
    expect(decoy_aspect(ahead, nose)).toBe(0)
    expect(decoy_aspect(abeam, nose)).toBeCloseTo(0, 6)
  })

  it('gives a heater chasing a jet in burner the tail chance, halved for the flame', () => {
    // The case the bandit's heaters meet: dead astern of the pilot, burner lit.
    expect(decoy_chance(decoy_aspect(astern, nose), 1)).toBeCloseTo(
      0.35 * FLARE.reject * 0.5,
      6
    )
    // The same geometry cold, and a flare met head-on.
    expect(decoy_chance(1, 0)).toBeCloseTo(0.35 * FLARE.reject, 6)
    expect(decoy_chance(0, 0)).toBeCloseTo(0.75 * FLARE.reject, 6)
    // A burner barely lit is not yet the brightest thing in view.
    expect(decoy_chance(1, 0.05)).toBeCloseTo(0.35 * FLARE.reject, 6)
  })

  it('sends a seduced round below the jet that dropped the flare', () => {
    expect(decoy_lure({ x: 120, y: 3000, z: -40 })).toEqual({
      x: 120,
      y: 3000 - FLARE.drop,
      z: -40,
    })
  })
})

// engine.ts cannot be imported (WebGL at module scope): its roll is read from
// the source. The roll used to take the aspect, the burner and the lure from
// the bandit whatever the target was, so the bandit's heaters judged the
// pilot's flares from the bandit itself.
describe("the engine's roll is the target's", () => {
  const source = readFileSync(
    fileURLToPath(new URL('./engine.ts', import.meta.url)),
    'utf8'
  )
  const start = source.indexOf('if(!m.window){ m.window=true;')
  const end = source.indexOf('} else if(!(t&&sim_time-(t.flared_at', start)
  const roll = source.slice(start, end)

  it('is found where the seeker meets a flare', () => {
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
  })

  it("reads the target's position, nose and burner, never the bandit's", () => {
    expect(roll).toMatch(
      /decoy_aspect\(\{ x:wrap_axis\(m\.px-t\.pos\.x\), y:m\.py-t\.pos\.y, z:wrap_axis\(m\.pz-t\.pos\.z\) \},t\.fwd\)/
    )
    expect(roll).toMatch(
      /decoy_chance\(tail,t===ownship\?Math\.max\(\.\.\.\(ownship\.reheats\|\|\[0\]\)\):\(t\.reheat\?\?0\)\)/
    )
    expect(roll).toMatch(/decoy_lure\(t\.pos\)/)
    expect(roll).not.toMatch(/bandit\./)
  })
})

// A heater fired at the pilot is judged twice: the bandit's brain decides to
// fire on the plume the pilot's engines make, and the round then decides
// whether its seeker has him. The round used to read the throttle lever, which
// leaves burner at once while the flame takes a second to die, and sits below
// the burner zone the engines light, so a pair the brain fired on a lit jet
// left the rail cold. Both pieces run here as engine.ts holds them: the frame's
// line that keeps the pilot's plume, and the launch.
describe("a heater fired at the pilot judges the plume its shooter fired on", () => {
  const source = readFileSync(
    fileURLToPath(new URL('./engine.ts', import.meta.url)),
    'utf8'
  )
  const start = source.indexOf('function launch_missile(')
  const launch = source.slice(start, source.indexOf('\nconst _v=', start)) // the function runs up to the next declaration
  // The frame's line, or nothing where it is absent: the ownship then carries
  // no plume of its own, as before.
  const kept = /\n\township\.reheat=[^\n]*\n/.exec(source)?.[0] ?? ''
  const STATE = { engine: 2, engine_harm: 10 }

  // The bandit 900-1,000 m dead ahead of the pilot, nose to nose.
  const fire = (lever: number, reheats: [number, number], range: number) => {
    const ownship: Record<string, unknown> = {
      pos: { x: range, y: 3000, z: 0 },
      fwd: { x: -1, y: 0, z: 0 },
      burner: lever,
    }
    const out = new Array(16).fill(0)
    out[STATE.engine] = 0.98 // the spool: a line reading it instead would light a cold jet
    out[STATE.engine + 2] = 0.98
    out[STATE.engine + 1] = reheats[0]
    out[STATE.engine + 3] = reheats[1]
    new Function('ownship', 'out', 'STATE', kept)(ownship, out, STATE)
    const missiles = [{ active: false, mesh: { visible: false } } as Record<string, unknown>]
    const bandit = { pos: { x: 0, y: 3000, z: 0 }, fwd: { x: 1, y: 0, z: 0 }, speed: 250 }
    const launch_missile = new Function(
      'THREE', 'missiles', 'local_offset', 'launch_puff', 'wrap_axis',
      `${launch}; return launch_missile`
    )(THREE, missiles, () => ({ x: 0, y: 3000, z: 0 }), () => {}, (v: number) => v)
    expect(launch_missile(bandit, ownship)).toBe(true)
    return missiles[0]
  }

  it('is found in engine.ts', () => {
    expect(start).toBeGreaterThan(0)
    expect(launch).toMatch(/m\.why="cold"/)
  })

  it('has him with the lever out of burner and the flame still dying', () => {
    // 1.1 s after a pull out of full burner: 0.11 left of the plume, a head-on
    // reach of 942 m, where the lever's reading gives 750.
    const round = fire(0, [0.11, 0.09], 900)
    expect(round.loose, `went out ${round.why}`).toBe(false)
  })

  it('has him in partial burner, where the engines light the whole zone', () => {
    // The lever just into the first zone reads 0.05; the engines light 0.2.
    const round = fire(0.05, [0.2, 0.2], 1000)
    expect(round.loose, `went out ${round.why}`).toBe(false)
  })

  it('goes out cold with the lever in burner and the flame not yet lit', () => {
    const round = fire(1, [0, 0], 900)
    expect(round.loose).toBe(true)
    expect(round.why).toBe('cold')
  })
})
