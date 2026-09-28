// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
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
