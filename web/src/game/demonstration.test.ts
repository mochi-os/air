// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { describe, expect, it } from 'vitest'
import {
  demonstration_start,
  demonstration_step,
  habits,
  wrap,
  type Picture,
} from './demonstration'

// A picture of the jet at one moment of the pattern. The ship steams 070°;
// the landing line is 9° left of the hull. Everything not named is a quiet,
// clean jet in level flight.
function picture(over: Omit<Partial<Picture>, 'ship' | 'groove'> & { ship?: Partial<Picture['ship']>; groove?: Partial<Picture['groove']> } = {}): Picture {
  return {
    time: 10,
    altitude: 244,
    vertical: 0,
    speed: 180,
    cas: 180,
    alpha: 3,
    heading: 70,
    track: 70,
    bank: 0,
    pitch: 2,
    roll: 0,
    rate: 0,
    throttle: 0.8,
    gear: false,
    flap: 0,
    hook: false,
    grounded: false,
    trapped: false,
    waving: false,
    crashed: false,
    coached: false,
    ...over,
    ship: { along: -3000, starboard: 0, bow: 166, course: 70, ...(over.ship ?? {}) },
    groove: { along: 3000, right: 0, deviation: 0, slope: 200, heading: 61, ...(over.groove ?? {}) },
  }
}

describe('wrap', () => {
  it('folds a heading difference into -180..180', () => {
    expect(wrap(190)).toBe(-170)
    expect(wrap(-190)).toBe(170)
    expect(wrap(540)).toBe(-180)
    expect(wrap(45)).toBe(45)
  })
})

describe('habits', () => {
  it('replays one pilot from a seed and draws another from a different one', () => {
    expect(habits(7)).toEqual(habits(7))
    expect(habits(7)).not.toEqual(habits(8))
  })

  it('keeps every habit inside what a competent pass allows', () => {
    for (let seed = 1; seed < 200; seed++) {
      const h = habits(seed)
      expect(h.late).toBeGreaterThanOrEqual(80)
      expect(h.late).toBeLessThanOrEqual(500) // never more than half a kilometre past the bow
      expect(h.steep).toBeGreaterThanOrEqual(64)
      expect(h.steep).toBeLessThanOrEqual(72)
      expect(h.wide).toBeGreaterThanOrEqual(1900) // "1NM abeam ship", and never past 1.25
      expect(h.wide).toBeLessThanOrEqual(2320)
      expect(h.slow).toBeGreaterThanOrEqual(1)
      expect(h.slow).toBeLessThanOrEqual(4)
      expect(h.height).toBeLessThanOrEqual(45 * 0.3048) // a wander under 50 ft
      expect(h.ball).toBeGreaterThanOrEqual(0.8)
      expect(h.ball).toBeLessThanOrEqual(1.1)
    }
  })
})

describe('the pattern', () => {
  it('flies the wake at 800 ft and 350 knots on the ship course, and breaks past the bow', () => {
    const d = demonstration_start(3)
    let c = demonstration_step(d, picture({ ship: { along: -2000 } }), 1 / 60)
    expect(d.phase).toBe('wake')
    expect(d.targets.altitude).toBeCloseTo(800 * 0.3048, -1)
    expect(d.targets.cas).toBeCloseTo(350 * 0.514444, -1)
    expect(Math.abs(wrap(d.targets.heading - 70))).toBeLessThan(16)
    expect(c.speedbrake).toBe(0)
    expect(c.gear).toBe(false)
    // Level with the bow: not yet. This pilot breaks `late` metres past it.
    demonstration_step(d, picture({ ship: { along: 166 } }), 1 / 60)
    expect(d.phase).toBe('wake')
    demonstration_step(d, picture({ ship: { along: 166 + d.habits.late + 1 } }), 1 / 60)
    expect(d.phase).toBe('break')
    // The break, from the next frame: a level LEFT turn at this pilot's bank, idle, boards out.
    c = demonstration_step(d, picture({ ship: { along: 166 + d.habits.late + 4 } }), 1 / 60)
    expect(c.throttle).toBe(0)
    expect(c.speedbrake).toBe(1)
    expect(d.targets.bank).toBeCloseTo(-d.habits.steep, 5)
    expect(c.roll).toBeLessThan(0)
  })

  it('pulls to hold the height through the break, as a load the up-and-away law reads', () => {
    const d = demonstration_start(3)
    d.phase = 'break'
    const c = demonstration_step(d, picture({ bank: -65, cas: 150 }), 1 / 60)
    // 1/cos 65° is 2.37 g: the stick asks the up-and-away law for it.
    expect(c.pitch).toBeGreaterThan(0.15)
    expect(c.pitch).toBeLessThan(0.35)
  })

  it('rolls out on the downwind and dirties up in order after the call, hands a moment behind', () => {
    const d = demonstration_start(3)
    d.phase = 'break'
    demonstration_step(d, picture({ heading: 255, track: 255, cas: 130 }), 1 / 60)
    expect(d.phase).toBe('downwind')
    expect(Math.abs(wrap(d.targets.heading - 250))).toBeLessThan(21)
    // Above 250 knots the boards stay out and nothing is thrown.
    let c = demonstration_step(d, picture({ time: 20, heading: 250, track: 250, cas: 135 }), 1 / 60)
    expect(c.speedbrake).toBe(1)
    expect(c.gear).toBe(false)
    // Below 250 the boards come in; the coaching calls the dirty-up and this
    // pilot's hands follow within half their delay: gear, then flaps, then hook.
    c = demonstration_step(d, picture({ time: 21, heading: 250, track: 250, cas: 125, coached: true }), 1 / 60)
    expect(c.speedbrake).toBe(0)
    expect(c.gear).toBe(false)
    const due = 21 + d.habits.slow * 0.5
    c = demonstration_step(d, picture({ time: due + 0.1, heading: 250, track: 250, cas: 120, coached: true }), 1 / 60)
    expect(c.gear).toBe(true)
    expect(c.flap).toBe(0)
    expect(c.hook).toBe(false)
    c = demonstration_step(d, picture({ time: due + 0.9, heading: 250, track: 250, cas: 118, coached: true, gear: true }), 1 / 60)
    expect(c.flap).toBe(2)
    expect(c.hook).toBe(false)
    c = demonstration_step(d, picture({ time: due + 1.7, heading: 250, track: 250, cas: 116, coached: true, gear: true, flap: 2 }), 1 / 60)
    expect(c.hook).toBe(true)
    expect(d.configured).toBe(true)
  })

  it('dirties up anyway when nothing coaches it, a little later', () => {
    const d = demonstration_start(5)
    d.phase = 'downwind'
    demonstration_step(d, picture({ time: 30, heading: 250, track: 250, cas: 125 }), 1 / 60)
    let c = demonstration_step(d, picture({ time: 30 + d.habits.slow - 0.1, heading: 250, track: 250, cas: 120 }), 1 / 60)
    expect(c.gear).toBe(false)
    c = demonstration_step(d, picture({ time: 30 + d.habits.slow + 0.1, heading: 250, track: 250, cas: 120 }), 1 / 60)
    expect(c.gear).toBe(true)
  })

  it('holds 800 ft clean, 600 ft once dirty, and turns a kilometre and a half astern of the touchdown', () => {
    const d = demonstration_start(3)
    d.phase = 'downwind'
    demonstration_step(d, picture({ heading: 250, track: 250, cas: 110, ship: { along: 500, starboard: -2000 }, groove: { along: -600 } }), 1 / 60)
    expect(d.targets.altitude).toBeCloseTo(800 * 0.3048, -1)
    d.configured = true
    demonstration_step(d, picture({ heading: 250, track: 250, cas: 110, flap: 2, gear: true, hook: true, ship: { along: 500, starboard: -2000 }, groove: { along: -600 } }), 1 / 60)
    expect(d.targets.altitude).toBeCloseTo(600 * 0.3048, -1)
    expect(d.phase).toBe('downwind')
    demonstration_step(d, picture({ heading: 250, track: 250, cas: 75, flap: 2, gear: true, hook: true, altitude: 190, ship: { along: -850, starboard: -2000 }, groove: { along: 700 } }), 1 / 60)
    expect(d.phase).toBe('downwind') // slow and at 600 ft, but only 700 m astern: the groove would be that short
    demonstration_step(d, picture({ heading: 250, track: 250, cas: 75, flap: 2, gear: true, hook: true, ship: { along: -1750, starboard: -2000 }, groove: { along: 1600 } }), 1 / 60)
    expect(d.phase).toBe('downwind') // slow, but still at 800 ft: the turn waits for 600
    demonstration_step(d, picture({ heading: 250, track: 250, cas: 75, flap: 2, gear: true, hook: true, altitude: 190, ship: { along: -1750, starboard: -2000 }, groove: { along: 1600 } }), 1 / 60)
    expect(d.phase).toBe('turn')
    // The turn, from the next frame: from a mile abeam at on-speed the arc
    // that ends on the landing line needs the hint's 27-30° of bank, and
    // the start-down abeam is 200-300 fpm.
    demonstration_step(d, picture({ heading: 250, track: 250, cas: 72, speed: 72, flap: 2, gear: true, hook: true, altitude: 190, ship: { along: -1752, starboard: -2000 }, groove: { along: 1602, right: -2000 } }), 1 / 60)
    expect(d.targets.bank).toBeLessThan(-26)
    expect(d.targets.bank).toBeGreaterThan(-31)
    expect(d.targets.vertical).toBeLessThan(-0.8)
    expect(d.targets.vertical).toBeGreaterThan(-1.7)
    // Past the 90 the slope is flown at its own rate; a jet still above the pattern comes down no faster than 500 fpm.
    d.closing = 40
    d.along = 2300 + 40 / 60
    demonstration_step(d, picture({ heading: 120, track: 120, cas: 72, speed: 72, flap: 2, gear: true, hook: true, altitude: 190, ship: { along: -2000, starboard: -1200 }, groove: { along: 2300, right: -800, slope: 160 } }), 1 / 60)
    expect(d.targets.vertical).toBeCloseTo(-(500 / 60) * 0.3048, 1)
    d.along = 2260 + 40 / 60
    demonstration_step(d, picture({ heading: 120, track: 120, cas: 72, speed: 72, flap: 2, gear: true, hook: true, altitude: 165, ship: { along: -2000, starboard: -1200 }, groove: { along: 2260, right: -800, slope: 160 } }), 1 / 60)
    expect(d.targets.vertical).toBeLessThan(-40 * Math.tan((3.5 * Math.PI) / 180)) // on the slope: its own rate, and a little more for the 3 m above the aim
    // Wide abeam, the same arc needs less bank; tight, more.
    demonstration_step(d, picture({ heading: 250, track: 250, cas: 72, speed: 72, flap: 2, gear: true, hook: true, ship: { along: -852, starboard: -3000 }, groove: { along: 702, right: -3000 } }), 1 / 60)
    expect(d.targets.bank).toBeGreaterThan(-22)
    demonstration_step(d, picture({ heading: 250, track: 250, cas: 72, speed: 72, flap: 2, gear: true, hook: true, ship: { along: -852, starboard: -1500 }, groove: { along: 702, right: -1500 } }), 1 / 60)
    expect(d.targets.bank).toBeLessThan(-29) // and no steeper than 30: the arc from a tight abeam is opened out on the intercept instead
    expect(d.targets.bank).toBeGreaterThanOrEqual(-30)
  })

  it('hands the groove over only once the lineup is closed, then flies the ball with power', () => {
    const d = demonstration_start(3)
    d.phase = 'turn'
    d.configured = true
    demonstration_step(d, picture({ heading: 100, track: 100, cas: 72, flap: 2, gear: true, hook: true, groove: { along: 2500, right: -600 } }), 1 / 60)
    expect(d.phase).toBe('turn')
    demonstration_step(d, picture({ heading: 66, track: 66, cas: 72, flap: 2, gear: true, hook: true, groove: { along: 2300, right: -200 } }), 1 / 60)
    expect(d.phase).toBe('groove')
    // High on the ball: the sink target steepens past the slope's own rate.
    d.closing = 70
    d.along = 1200 + 70 / 60
    const riding = -70 * Math.tan((3.5 * Math.PI) / 180)
    demonstration_step(d, picture({ heading: 61, track: 61, cas: 72, flap: 2, gear: true, hook: true, altitude: 130, groove: { along: 1200, right: 0, slope: 100 } }), 1 / 60)
    expect(d.targets.vertical).toBeLessThan(riding)
    // In close a high ball still asks for more sink, within a band about the slope's own rate.
    d.along = 200 + 70 / 60 // a frame's closure at 70 m/s, so the filter reads what it read
    demonstration_step(d, picture({ heading: 61, track: 61, cas: 72, flap: 2, gear: true, hook: true, altitude: 50, groove: { along: 200, right: 0, slope: 30 } }), 1 / 60)
    expect(d.targets.vertical).toBeLessThan(riding)
    expect(d.targets.vertical).toBeGreaterThanOrEqual(riding - 2.5 - 1e-9)
    // Through the middle of the groove the catch-up is gentler.
    d.along = 1000 + 70 / 60
    demonstration_step(d, picture({ heading: 61, track: 61, cas: 72, flap: 2, gear: true, hook: true, altitude: 120, groove: { along: 1000, right: 0, slope: 80 } }), 1 / 60)
    expect(d.targets.vertical).toBeCloseTo(riding - 1.5, 5)
    // Over the round-down a high ball is never chased: a fraction more than the slope's rate, no more.
    d.along = 80 + 70 / 60
    demonstration_step(d, picture({ heading: 61, track: 61, cas: 72, flap: 2, gear: true, hook: true, altitude: 32, groove: { along: 80, right: 0, slope: 27 } }), 1 / 60)
    expect(d.targets.vertical).toBeLessThan(riding)
    expect(d.targets.vertical).toBeGreaterThanOrEqual(riding - 1 - 1e-9)
    // Well under the slope far out, the descent stops until the slope comes down to the jet.
    d.along = 2500 + 70 / 60
    demonstration_step(d, picture({ heading: 61, track: 61, cas: 72, flap: 2, gear: true, hook: true, altitude: 60, groove: { along: 2500, right: 0, slope: 180 } }), 1 / 60)
    expect(d.targets.vertical).toBeGreaterThan(-1)
    // A lineup left of centreline is corrected to the right.
    demonstration_step(d, picture({ heading: 61, track: 61, cas: 72, flap: 2, gear: true, hook: true, groove: { along: 1000, right: -80, slope: 90 } }), 1 / 60)
    const wanted = wrap(d.targets.heading - 61)
    expect(wanted).toBeGreaterThan(0.5)
    // In a crosswind the nose is held into it: the same lineup with the track 5° right of the heading asks for 5° less.
    demonstration_step(d, picture({ heading: 61, track: 66, cas: 72, flap: 2, gear: true, hook: true, groove: { along: 1000, right: -80, slope: 90 } }), 1 / 60)
    // 5° of crab, and less correction for the drift the track now carries toward the line.
    expect(wrap(d.targets.heading - 61)).toBeLessThan(wanted - 4)
    // And settling low there, where the lens no longer calls it, is the pilot's own wave-off.
    d.along = 120 + 70 / 60
    demonstration_step(d, picture({ heading: 61, track: 61, cas: 72, flap: 2, gear: true, hook: true, altitude: 25, vertical: -3, groove: { along: 120, right: 0, slope: 29, deviation: -0.9 } }), 1 / 60)
    expect(d.phase).toBe('groove') // low, but sinking shallower than the slope: coming back to it
    demonstration_step(d, picture({ heading: 61, track: 61, cas: 72, flap: 2, gear: true, hook: true, altitude: 25, vertical: -6, groove: { along: 110, right: 0, slope: 28.5, deviation: -0.9 } }), 1 / 60)
    expect(d.phase).toBe('around')
  })

  it('holds on-speed alpha with the stick once dirty and near on-speed, and flies the path with it while still fast', () => {
    const d = demonstration_start(3)
    d.phase = 'groove'
    d.configured = true
    // Alpha 7.4, half a degree fast of the doughnut: a pull, and over a few
    // seconds a trim learned on top of it. Alpha 10: a push.
    let c = demonstration_step(d, picture({ heading: 61, track: 61, cas: 72, speed: 72, alpha: 7.4, flap: 2, gear: true, hook: true, altitude: 100, groove: { along: 1200, slope: 100 } }), 1 / 60)
    const first = c.pitch
    expect(first).toBeGreaterThan(0.02)
    for (let i = 0; i < 180; i++) c = demonstration_step(d, picture({ time: 10 + i / 60, heading: 61, track: 61, cas: 72, speed: 72, alpha: 7.4, flap: 2, gear: true, hook: true, altitude: 100, groove: { along: 1200, slope: 100 } }), 1 / 60)
    expect(d.nose).toBeGreaterThan(0.03)
    expect(c.pitch).toBeGreaterThan(first + 0.03)
    c = demonstration_step(d, picture({ heading: 61, track: 61, cas: 72, speed: 72, alpha: 11, flap: 2, gear: true, hook: true, altitude: 100, groove: { along: 1200, slope: 100 } }), 1 / 60)
    expect(c.pitch).toBeLessThan(-0.05)
    // A nose already pitching up toward it is pulled less.
    const still = demonstration_step(d, picture({ heading: 61, track: 61, cas: 72, speed: 72, alpha: 7.4, flap: 2, gear: true, hook: true, altitude: 100, groove: { along: 1200, slope: 100 } }), 1 / 60).pitch
    c = demonstration_step(d, picture({ heading: 61, track: 61, cas: 72, speed: 72, alpha: 7.4, rate: 0.2, flap: 2, gear: true, hook: true, altitude: 100, groove: { along: 1200, slope: 100 } }), 1 / 60)
    expect(c.pitch).toBeLessThan(still - 0.04)
    // Fast - alpha 4, 165 knots dirty - alpha is not the point, the height is: level at the aim, the stick is nearly centred whatever alpha reads.
    c = demonstration_step(d, picture({ heading: 61, track: 61, cas: 85, speed: 85, alpha: 4, flap: 2, gear: true, hook: true, altitude: 100, vertical: d.targets.vertical, groove: { along: 1200, slope: 100 } }), 1 / 60)
    expect(Math.abs(c.pitch)).toBeLessThan(0.05)
  })

  it('flies the final turn on a steady hand: the stick for the path, the lever for the indexer, the power leading the roll-in', () => {
    // The outbound half of the turn, 600 ft, on-speed, a mile and a quarter off the landing line.
    const outbound = (over: Omit<Partial<Picture>, 'ship' | 'groove'> = {}) =>
      picture({ heading: 250, track: 250, cas: 72, speed: 72, alpha: 8.1, flap: 2, gear: true, hook: true, altitude: 600 * 0.3048, ship: { along: -1800, starboard: -2000 }, groove: { along: 1650, right: -2000 }, ...over })
    const turning = (over: Omit<Partial<Picture>, 'ship' | 'groove'> = {}) => {
      const d = demonstration_start(3)
      d.phase = 'turn'
      d.configured = true
      d.seated = true
      d.lever = 0.3
      d.vertical = over.vertical ?? 0 // no acceleration read on the first frame
      d.cas = over.cas ?? 72
      return d
    }
    // Wings still level, the roll-in just commanded, on-speed: the bank's power is already on.
    let d = turning()
    let c = demonstration_step(d, outbound(), 2) // 2 s: the hand is not what is measured here
    const tilt = Math.pow(Math.cos((Math.abs(d.targets.bank) * Math.PI) / 180), -1.5)
    expect(d.targets.bank).toBeLessThan(-20)
    expect(d.targets.vertical).toBe(0)
    expect(c.throttle).toBeCloseTo(0.34 * tilt, 2)
    expect(c.throttle).toBeGreaterThan(0.38)
    const level = c.throttle
    // Reading slow, more power; the path is not the lever's here.
    d = turning()
    c = demonstration_step(d, outbound({ alpha: 10 }), 2)
    expect(c.throttle - level).toBeCloseTo(1.9 * 0.06 + 1.9 * 0.01 * 2, 2) // the proportional share, and two seconds of the trim
    d = turning({ vertical: -2 })
    c = demonstration_step(d, outbound({ vertical: -2 }), 2)
    expect(c.throttle).toBeCloseTo(level, 2)
    // Reading a degree fast for five seconds, the trim learns less power.
    d = turning()
    for (let i = 0; i < 300; i++) c = demonstration_step(d, outbound({ time: 10 + i / 60, alpha: 7.1 }), 1 / 60)
    expect(d.trim).toBeLessThan(-0.04)
    expect(c.throttle).toBeLessThan(level - 0.06 - 0.04)
    // On the doughnut but the speed still building a metre and a half a second a second: the handful comes off.
    d = turning()
    d.cas = 72 - 3 // read over the 2 s frame: 1.5 m/s²
    c = demonstration_step(d, outbound(), 2)
    expect(level - c.throttle).toBeCloseTo(1.5 * 0.06, 2)
    // Fast - 175 knots, alpha 5 - less power, and never idle.
    d = turning({ cas: 90 })
    d.lever = 0.4
    c = demonstration_step(d, outbound({ cas: 90, speed: 90, alpha: 5 }), 3)
    expect(c.throttle).toBeGreaterThan(0.1) // three seconds of the trim on top of the proportional share, and still power on
    expect(c.throttle).toBeLessThan(0.3)
    // The stick holds the path: sinking two metres a second, a pull.
    d = turning({ vertical: -2 })
    c = demonstration_step(d, outbound({ vertical: -2 }), 1 / 60)
    expect(c.pitch).toBeCloseTo(0.16, 2)
    // And pulls the bank's share of lift with the wings at 30°, on the path.
    d = turning()
    c = demonstration_step(d, outbound({ bank: -30 }), 1 / 60)
    expect(c.pitch).toBeCloseTo(1 / Math.cos(Math.PI / 6) - 1, 2)
    // A path still sinking a metre a second past it after five seconds: the trim has learned more pull.
    d = turning({ vertical: -1 })
    for (let i = 0; i < 300; i++) c = demonstration_step(d, outbound({ time: 10 + i / 60, vertical: -1 }), 1 / 60)
    expect(d.carry).toBeGreaterThan(0.05)
    expect(c.pitch).toBeGreaterThan(0.08 + 0.05)
    // At a hand's pace: however much power is asked for, one frame moves the lever by a sixtieth of HAND.
    d = turning()
    c = demonstration_step(d, outbound({ alpha: 12 }), 1 / 60)
    expect(c.throttle).toBeGreaterThan(0.3)
    expect(c.throttle).toBeLessThanOrEqual(0.3 + 0.15 / 60 + 1e-9)
    // Thirty feet under 600 in the outbound half: level off, never climb back.
    d = turning()
    demonstration_step(d, outbound({ altitude: 570 * 0.3048 }), 1 / 60)
    expect(d.targets.vertical).toBeLessThanOrEqual(0)
    expect(d.targets.vertical).toBeGreaterThanOrEqual(-(250 / 60) * 0.3048 - 1e-9)
    // Into the groove the stick changes hands over three seconds, not in a frame.
    const entering = (since: number) => {
      const e = demonstration_start(3)
      e.phase = 'groove'
      e.configured = true
      e.seated = true
      e.since = 10
      e.vertical = -3
      e.closing = 70
      e.along = 2400 + 70 / 60
      return demonstration_step(e, picture({ time: 10 + since, heading: 64, track: 64, bank: 20, cas: 72, speed: 72, alpha: 7, vertical: -3, flap: 2, gear: true, hook: true, altitude: 200, groove: { along: 2400, right: -50, slope: 190 } }), 1 / 60).pitch
    }
    const first = entering(0)
    const middle = entering(1.5)
    const settled = entering(3)
    expect(Math.abs(first - settled)).toBeGreaterThan(0.05)
    expect(middle).toBeCloseTo((first + settled) / 2, 2)
  })

  it('goes around on a wave-off with full power and the switches left down, then rejoins the downwind', () => {
    const d = demonstration_start(3)
    d.phase = 'groove'
    d.configured = true
    let c = demonstration_step(d, picture({ heading: 61, track: 61, cas: 72, flap: 2, gear: true, hook: true, waving: true, altitude: 40 }), 1 / 60)
    expect(d.phase).toBe('around')
    expect(c.throttle).toBe(1)
    expect(c.speedbrake).toBe(0)
    expect(c.gear).toBe(true)
    expect(c.flap).toBe(2)
    expect(c.hook).toBe(true)
    expect(Math.abs(d.targets.bank)).toBeLessThan(1) // wings level until climbing
    c = demonstration_step(d, picture({ heading: 61, track: 61, cas: 72, flap: 2, gear: true, hook: true, altitude: 90, vertical: 4 }), 1 / 60)
    expect(d.targets.heading).toBe(250)
    expect(c.throttle).toBeLessThan(1) // climbing: the lever comes back from the wall toward on-speed
    demonstration_step(d, picture({ heading: 240, track: 240, cas: 72, flap: 2, gear: true, hook: true, altitude: 170, vertical: 3 }), 1 / 60)
    expect(d.phase).toBe('downwind')
    expect(d.configured).toBe(true)
  })

  it('stays centred and idle through the runout, lets go once stopped, and goes around off a touch without a wire', () => {
    const d = demonstration_start(3)
    d.phase = 'groove'
    let c = demonstration_step(d, picture({ trapped: true, grounded: true, speed: 60, cas: 60, gear: true, flap: 2, hook: true }), 1 / 60)
    expect(c.released).toBe(false) // still rolling out on the wire: the pilot holds the controls centred
    expect(c.throttle).toBe(0)
    expect(c.pitch).toBe(0)
    expect(c.roll).toBe(0)
    c = demonstration_step(d, picture({ trapped: true, grounded: true, speed: 1, cas: 1, gear: true, flap: 2, hook: true }), 1 / 60)
    expect(c.released).toBe(true)
    expect(c.throttle).toBe(0)
    expect(c.pitch).toBe(0)
    const e = demonstration_start(3)
    e.phase = 'groove'
    demonstration_step(e, picture({ grounded: true, speed: 70, cas: 70, gear: true, flap: 2, hook: true, altitude: 20, groove: { along: -30, slope: 24 } }), 1 / 60)
    expect(e.phase).toBe('around')
    c = demonstration_step(e, picture({ grounded: true, speed: 72, cas: 72, gear: true, flap: 2, hook: true, altitude: 20, groove: { along: -60, slope: 24 } }), 1 / 60)
    expect(c.released).toBe(false)
    expect(c.throttle).toBe(1)
    expect(c.hook).toBe(true)
  })

  it('never commands afterburner, a negative lever, or a stick past the shaping', () => {
    const d = demonstration_start(11)
    for (let i = 0; i < 300; i++) {
      const c = demonstration_step(d, picture({ time: i / 10, altitude: 100 + (i % 7) * 40, vertical: (i % 5) - 2, cas: 60 + (i % 9) * 15, flap: i % 2 ? 2 : 0 }), 0.1)
      expect(c.throttle).toBeGreaterThanOrEqual(0)
      expect(c.throttle).toBeLessThanOrEqual(1)
      expect(Math.abs(c.pitch)).toBeLessThanOrEqual(0.5)
      expect(Math.abs(c.roll)).toBeLessThanOrEqual(0.7)
    }
  })
})
