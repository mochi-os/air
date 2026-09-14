// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The landing gear warning tone (NATOPS A1-F18AC-NFM-000 2.10.1.4): gear handle
// up, below 175 knots, below 7,500 ft, and descending faster than 250 ft/min.
// Without the descent term the horn ran through every catapult climb-out.
// engine.ts cannot be imported (WebGL at module scope), so wheels_warning() is
// read as text and run against a stand-in jet, as trim-law.test.ts does.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
const law = /\nfunction wheels_warning\(\)\{[^\n]*\}\n/.exec(source)?.[0] ?? ''

interface Jet { gearTarget: number; cas: number; y: number; vely: number; grounded?: boolean; launching?: boolean }
function warning(jet: Jet): boolean {
  if (!law) throw new Error('wheels_warning() not found in engine.ts')
  const run = new Function('jet', `const ownship={ gearTarget:jet.gearTarget, cas:jet.cas, speed:jet.cas, pos:{y:jet.y}, vely:jet.vely, grounded:!!jet.grounded, launching:!!jet.launching };
    ${law}
    return wheels_warning();`) as (jet: Jet) => boolean
  return run(jet)
}
const KNOTS = 0.5144, FEET = 0.3048, FPM = 0.3048 / 60
// Gear coming up off the catapult: slow, low and climbing.
const climbout: Jet = { gearTarget: 1, cas: 150 * KNOTS, y: 100 * FEET, vely: 1500 * FPM }
// Gear up on the way down, the case the tone exists for.
const descent: Jet = { gearTarget: 1, cas: 160 * KNOTS, y: 1500 * FEET, vely: -500 * FPM }

describe('the wheels warning', () => {
  it('stays quiet through the climb-out after a launch', () => {
    expect(warning(climbout)).toBe(false)
    expect(warning({ ...climbout, vely: 0 })).toBe(false) // level and slow is not a landing either
    expect(warning({ ...climbout, vely: -200 * FPM })).toBe(false) // inside the 250 ft/min allowance
  })

  it('sounds for a gear-up descent below 175 knots and 7,500 ft', () => {
    expect(warning(descent)).toBe(true)
    expect(warning({ ...descent, y: 7000 * FEET })).toBe(true)
  })

  it('needs each of the four conditions', () => {
    expect(warning({ ...descent, gearTarget: 0 })).toBe(false)
    expect(warning({ ...descent, cas: 180 * KNOTS })).toBe(false)
    expect(warning({ ...descent, y: 8000 * FEET })).toBe(false)
    expect(warning({ ...descent, vely: -200 * FPM })).toBe(false)
  })

  it('is for a jet in the air', () => {
    expect(warning({ ...descent, grounded: true })).toBe(false)
    expect(warning({ ...descent, launching: true })).toBe(false)
  })
})
