// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The HUD trim readout shows the PA pitch datum, which the flight core holds
// only in its PA law (world/games/air/flight/fcs.go:
// pa := ((in.Flap >= 1 || m.halfleg) && !m.fast) || m.rolling > 0). The readout used to follow
// the HUD's gear-driven landing-symbology gate, which hid the datum with the
// flaps down and the gear up, and showed a stale one with the gear down on AUTO.
// engine.ts cannot be imported (WebGL at module scope), so trim_law() is read as
// text and stepped against a stand-in ownship, as landing-light.test.ts does.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
const law = /\nfunction trim_law\(\)\{[\s\S]*?\n\treturn [^\n]*\}\n/.exec(source)?.[0] ?? ''

interface Jet { grounded: boolean; speed: number; cas: number; gearTarget: number }
// A fresh law mirror; step() is one frame at a time and flap setting.
function mirror() {
  if (!law) throw new Error('trim_law() not found in engine.ts')
  return new Function(`let law_halfleg=false, law_wheels=-Infinity, law_fast=false, sim_time=0, flap_select=0, ownship=null;
    ${law}
    return (jet, time, flap) => { ownship=jet; sim_time=time; flap_select=flap; return trim_law(); };`)() as
    (jet: Jet, time: number, flap: number) => boolean
}
const airborne = (cas: number, gear: 'up' | 'down'): Jet => ({ grounded: false, speed: cas, cas, gearTarget: gear === 'up' ? 1 : 0 })

describe('the HUD trim readout follows the PA law, not the gear', () => {
  it('shows the datum with the flaps down and the gear up', () => {
    const step = mirror()
    expect(step(airborne(120, 'up'), 10, 1)).toBe(true) // HALF
    expect(step(airborne(120, 'up'), 11, 2)).toBe(true) // FULL
  })

  it('hides it with the gear down on AUTO in the air, where the core flies up-and-away', () => {
    const step = mirror()
    expect(step(airborne(100, 'down'), 10, 0)).toBe(false)
  })

  it('holds PA through the takeoff leg from the deck, and drops it at the clean-up', () => {
    const step = mirror()
    expect(step({ grounded: true, speed: 0, cas: 0, gearTarget: 0 }, 0, 0)).toBe(true) // on deck, slow: the latch sets
    expect(step(airborne(80, 'down'), 20, 0)).toBe(true) // climbing out, still latched
    expect(step(airborne(80, 'up'), 21, 0)).toBe(true) // gear up but not yet past 92.6 m/s
    expect(step(airborne(95, 'up'), 22, 0)).toBe(false) // the clean-up ends the leg
    expect(step(airborne(80, 'down'), 23, 0)).toBe(false) // and the latch stays cleared
  })

  it('keeps PA for three seconds after the wheels, like the core rolling timer', () => {
    const step = mirror()
    expect(step({ grounded: true, speed: 60, cas: 60, gearTarget: 1 }, 0, 0)).toBe(true) // fast on the wheels: no latch, the timer runs
    expect(step(airborne(95, 'up'), 2.9, 0)).toBe(true)
    expect(step(airborne(95, 'up'), 3.1, 0)).toBe(false)
  })

  it('hides it above the ~240 KCAS AUTO handover whatever the flap switch says', () => {
    // NATOPS 11.1.1, the core's m.fast: past 126 m/s CAS the jet flies the
    // up-and-away law with HALF selected, and the PA datum is not in use. The
    // band either side keeps a speed on the line from flickering the readout.
    const step = mirror()
    expect(step(airborne(110, 'down'), 10, 1)).toBe(true) // HALF at 214 KCAS
    expect(step(airborne(130, 'down'), 11, 1)).toBe(false) // 253 KCAS: AUTO
    expect(step(airborne(123, 'down'), 12, 1)).toBe(false) // 239 KCAS slowing: still inside the band
    expect(step(airborne(119, 'down'), 13, 1)).toBe(true) // 231 KCAS: PA again
    expect(step(airborne(124, 'down'), 14, 1)).toBe(true) // 241 KCAS accelerating: still inside the band
  })

  it('gates the readout on the mirror, not on the landing-symbology gate', () => {
    expect(source).toMatch(/trim_manual=trim_law\(\);/)
    expect(source).toMatch(/if\(trim_manual&&Math\.abs\(datum\)>0\.0025\)/)
    expect(source).not.toMatch(/if\(hud_pa&&Math\.abs\(datum\)/)
  })
})
