// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { flatten, oleo } from './oleo'

// settle runs the correction to convergence and returns where the tyre bottom
// ends up. `bottom` is measured off the posed node, so it carries the offset
// already - the loop reproduces that by re-measuring each step.
const settle = (rest: number, ground: number, steps = 200) => {
  let lift = 0
  for (let i = 0; i < steps; i++) lift = oleo(rest + lift, ground, lift, 1 / 60)
  return { lift, bottom: rest + lift }
}

describe('oleo', () => {
  // The reported defect: a strut compressing drags the rigid drawn wheel under
  // the runway. At the 14 cm the screenshot measured, the correction must lift
  // the tyre back onto the surface, not merely reduce the burial.
  it('lifts a buried wheel onto the surface', () => {
    const { lift, bottom } = settle(-0.14, 0)
    expect(lift).toBeGreaterThan(0)
    expect(bottom).toBeCloseTo(0, 6)
  })

  // The static rest pose measured for #203: the drawn nose floats 2.8 cm and
  // the drawn mains 5.2 cm above the surface, because the drawn gear is
  // shorter than the physics strut. Both must come down onto it.
  it('seats a floating wheel, nose and main alike', () => {
    expect(settle(0.028, 0).bottom).toBeCloseTo(0, 6)
    expect(settle(0.052, 0).bottom).toBeCloseTo(0, 6)
    expect(settle(0.028, 0).lift).toBeLessThan(0)
  })

  // Per-leg is the whole point: one shared scrub cannot seat both, because the
  // physics sinks the mains about 4.6 cm deeper than the nose.
  it('gives each leg its own offset', () => {
    expect(settle(0.028, 0).lift).not.toBeCloseTo(settle(0.052, 0).lift, 3)
  })

  it('follows the surface under the wheel, not a fixed plane', () => {
    expect(settle(18.4, 18.5).bottom).toBeCloseTo(18.5, 6) // a carrier deck
  })

  // Airborne the gear draws as authored - the correction is a ground effect.
  it('retires the correction once the wheel is flying', () => {
    let lift = -0.05
    for (let i = 0; i < 200; i++) lift = oleo(40, 0, lift, 1 / 60)
    expect(lift).toBe(0)
  })

  it('retires the correction where there is no surface', () => {
    let lift = 0.05
    for (let i = 0; i < 200; i++) lift = oleo(1, -1e8, lift, 1 / 60)
    expect(lift).toBe(0)
  })

  // A terrain sample that misreads must not stretch the gear across the map.
  // The bound is deliberately tight: a wheel visibly off its own oleo is a
  // worse artefact than one a centimetre out of place.
  it('cannot displace a wheel further than its reach', () => {
    let lift = 0
    for (let i = 0; i < 500; i++) lift = oleo(-50, 0, lift, 1 / 60)
    expect(lift).toBeLessThanOrEqual(0.25)
  })

  // Rotation: the wheel climbs away from the runway. The caller stops seating
  // an unloaded strut, which reaches oleo as "no plane", and the offset must
  // slew out fast enough not to be seen - 5 cm at 3 m/s is under 20 ms.
  it('retires a standing offset in milliseconds once the strut unloads', () => {
    let lift = -0.05
    let ticks = 0
    while (lift !== 0 && ticks < 600) {
      lift = oleo(1, -1e9, lift, 1 / 60)
      ticks++
    }
    expect(lift).toBe(0)
    expect(ticks / 60).toBeLessThan(0.05)
  })

  // Slewed, so a step in the surface under the wheel does not pop the tyre.
  it('slews rather than jumping', () => {
    expect(Math.abs(oleo(-0.4, 0, 0, 1 / 60))).toBeLessThanOrEqual(3 / 60 + 1e-9)
  })

  it('lands exactly on the target instead of hunting', () => {
    let lift = 0
    for (let i = 0; i < 400; i++) lift = oleo(0.03 + lift, 0, lift, 1 / 60)
    expect(oleo(0.03 + lift, 0, lift, 1 / 60)).toBe(lift)
  })
})

// The constants live on the wheel spec in engine.ts and mirror fa18c.go.
const NOSE = { strut: 4.5e5, tyre: 9.0e5, travel: 0.45, limit: 0.008 }
const MAIN = { strut: 9e5, tyre: 1.17e6, travel: 0.5, limit: 0.048 }

describe('flatten', () => {
  // The anchors the tyre stiffnesses were derived from. Static depths are the
  // measured rest pose: nose 0.0318 m, mains 0.0780 m at 15,769 kg.
  it('gives the published main deflection at its measured static load', () => {
    expect(flatten(0.078, MAIN.strut, MAIN.tyre, MAIN.travel)).toBeCloseTo(0.06, 2)
  })

  // The nose carries ~9% of the weight, so it uses only a fraction of its own
  // 4.9 cm rated figure - it must not flatten like a main.
  it('leaves the nose well inside its rated deflection', () => {
    const nose = flatten(0.0318, NOSE.strut, NOSE.tyre, NOSE.travel)
    expect(nose).toBeGreaterThan(0.005)
    expect(nose).toBeLessThan(0.049)
    expect(nose).toBeLessThan(flatten(0.078, MAIN.strut, MAIN.tyre, MAIN.travel))
  })

  // No separate schedule: as the wing takes the weight through the takeoff
  // roll the strut extends, and the tyre rounds out with it.
  it('eases off as the strut unloads through the roll', () => {
    const rolling = [0.0324, 0.025, 0.018, 0.0061].map((d) =>
      flatten(d, NOSE.strut, NOSE.tyre, NOSE.travel),
    )
    for (let i = 1; i < rolling.length; i++) expect(rolling[i]).toBeLessThan(rolling[i - 1])
  })

  it('is flat on the ground with no load, and never negative', () => {
    expect(flatten(0, MAIN.strut, MAIN.tyre, MAIN.travel)).toBe(0)
    expect(flatten(-0.2, MAIN.strut, MAIN.tyre, MAIN.travel)).toBe(0)
  })

  // A touchdown transient runs depth far past static; the physics stops
  // carrying load at Travel*3, and the drawn tyre must stop there too rather
  // than flattening without limit.
  it('stops at the physics bottoming-out clamp', () => {
    const bottomed = flatten(MAIN.travel * 3, MAIN.strut, MAIN.tyre, MAIN.travel)
    expect(flatten(50, MAIN.strut, MAIN.tyre, MAIN.travel)).toBe(bottomed)
  })

  // A tyre is linear only over its working range, and past the cap it cannot
  // flatten further however hard the strut presses. Both wheels sit ON their cap
  // at rest, so without it they would draw their full physical deflection.
  it('stops at the wheel cap however hard the strut presses', () => {
    expect(flatten(0.119, MAIN.strut, MAIN.tyre, MAIN.travel, MAIN.limit)).toBe(MAIN.limit)
    expect(flatten(5, MAIN.strut, MAIN.tyre, MAIN.travel, MAIN.limit)).toBe(MAIN.limit)
    expect(flatten(5, NOSE.strut, NOSE.tyre, NOSE.travel, NOSE.limit)).toBe(NOSE.limit)
  })

  // The caps are a VISUAL calibration set below the physical deflection, so at
  // the jet's real resting loads they are what governs. The depths are the
  // measured equilibrium (main 0.079, nose 0.027) and match the flight model's
  // own Go figures; uncapped they would draw 6.1 cm and 1.3 cm.
  it('governs at the resting loads, sitting below the physical deflection', () => {
    expect(flatten(0.079, MAIN.strut, MAIN.tyre, MAIN.travel)).toBeCloseTo(0.061, 3)
    expect(flatten(0.079, MAIN.strut, MAIN.tyre, MAIN.travel, MAIN.limit)).toBe(MAIN.limit)
    expect(flatten(0.027, NOSE.strut, NOSE.tyre, NOSE.travel)).toBeCloseTo(0.0135, 4)
    expect(flatten(0.027, NOSE.strut, NOSE.tyre, NOSE.travel, NOSE.limit)).toBe(NOSE.limit)
  })

  it('yields nothing without usable constants', () => {
    expect(flatten(0.078, MAIN.strut, 0, MAIN.travel)).toBe(0)
    expect(flatten(NaN, MAIN.strut, MAIN.tyre, MAIN.travel)).toBe(0)
  })
})

// engine.ts cannot be imported (WebGL at module scope), so the wiring is
// asserted against its source.
describe('oleo wiring', () => {
  const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')

  it('drives every drawn leg through oleo', () => {
    expect(source).toMatch(/import\s*\{[^}]*\boleo\b[^}]*\}\s*from\s*'\.\/oleo'/)
    expect(source).toMatch(/\boleo\(/)
  })

  // The strut constants are a deliberate second copy of flight/fa18c.go's
  // Gear.{Nose,Left,Right}. If they drift, the drawn tyre flattens against a
  // load the physics is not carrying.
  it('mirrors the physics strut constants on the wheel spec', () => {
    expect(source).toMatch(/\bflatten\(/)
    expect(source).toMatch(/attach:\[4\.9,-2\.63,0\]/)
    expect(source).toMatch(/attach:\[-0\.5,-2\.63,-1\.55\]/)
    expect(source).toMatch(/attach:\[-0\.5,-2\.63,1\.55\]/)
    // Both mains, not just whichever the edit anchor happened to match.
    expect(source.match(/limit:0\.048/g)?.length).toBe(2)
    expect(source).toMatch(/limit:0\.008/)
  })

  // `radius` on the wheel spec is the REAL tyre's size (30x11.5 mains, 22x6.6
  // nose); the modeller's mesh is 8-13 mm bigger. Seating on the constant drove
  // every wheel that much into the runway - measured 4.924 m against a 5.000 m
  // runway where the model believed 4.937. The drawn radius must be measured
  // off the mesh.
  it('seats on the measured drawn radius, not the real-world tyre size', () => {
    expect(source).toMatch(/const measured=w\.y-low/)
    // and the measurement is only accepted when it is plausible: the one-shot can
    // land on a frame where a leg has not posed, and a wrong radius is permanent -
    // it stranded one main 17 cm off its tyre while the other seated correctly.
    expect(source).toMatch(/measured>s\.radius\*0\.8\s*&&\s*measured<s\.radius\*1\.3/)
    expect(source).toMatch(/oleo\(w\.y-outer,/)
    expect(source).not.toMatch(/oleo\(w\.y-s\.radius,/)
  })

  // getWorldPosition refreshes ANCESTORS only. Without an explicit descendant
  // update the tyre's own mesh matrices are stale when measured, the radius
  // comes out absurd, and the correction slams into its 0.6 m cap - which is
  // exactly what the live probe caught.
  it('refreshes the tyre mesh matrices before measuring it', () => {
    expect(source).toMatch(/updateWorldMatrix\(false,\s*true\)/)
  })

  // The wheel is translated relative to its strut, so seating one that is NOT
  // carrying weight pulls the tyre visibly off its own oleo. Proximity is not
  // contact: through rotation the wheel sits inches above the runway with the
  // strut unloaded, and the first cut dragged it down there for as long as it
  // stayed within reach.
  it('seats only a loaded strut, never a wheel merely near the ground', () => {
    expect(source).toMatch(/if\(s\.depth>0\)\{\s*s\.sink=flatten\(/)
    expect(source).toMatch(/plane=surface-s\.sink/)
  })

  // The fixed squat scrub is what this replaces: one clip fraction for all
  // three legs, blind to load, which is why the mains and the nose could never
  // both be seated. Its return would silently re-introduce the defect.
  it('no longer poses the gear from a fixed squat constant', () => {
    expect(source).not.toMatch(/squat\s*\*\s*\(?\s*st\.squish/)
  })

  // The runtime floor clamp used the single global GEAR (2.46 m) while the
  // spawn used the per-aircraft stance (2.57 m) - 11 cm apart, four times the
  // rest-pose margin, so wherever the clamp governed it pulled the origin
  // below what the drawn model needs.
  it('rests the jet on the per-aircraft stance, not the global GEAR', () => {
    expect(source).not.toMatch(/ownship\.pos\.y\s*=\s*Math\.max\(ownship\.pos\.y\s*,\s*g\s*\+\s*GEAR\)/)
    expect(source).toMatch(/function stance_of\b/)
  })
})
