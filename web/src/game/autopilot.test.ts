// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { describe, expect, it } from 'vitest'
import * as P from './autopilot'

// The autopilot's logic (#100, NATOPS 2.9): what engages, what each option
// selects and takes off, what lets go and how it says so, and the sense of the
// stick it gives. How well its loops fly the jet is autopilot-core.test.ts's.
const level: P.Sense = {
  time: 100, pitch: 2, bank: 0, heading: 90, track: 92, altitude: 3000, height: 900, vertical: 0, cas: 150, roll: 0, rate: 0, approach: false, airborne: true, attitude: true, computer: true,
  stick: { pitch: 0, roll: 0 }, trim: { pitch: 0, roll: 0 }, selected: 120, couple: null, limit: 'nav',
}
const jet = (over: Partial<P.Sense> = {}): P.Sense => ({ ...level, ...over })
const steering: P.Couple = { axis: 'track', value: 45, vertical: null }
const traffic: P.Couple = { axis: 'heading', value: 200, vertical: null }
const carrier: P.Couple = { axis: 'bank', value: 5, vertical: -4 }
const on = (...modes: P.Mode[]) => (s: P.Sense = level): P.Autopilot => { const ap = P.fresh(); for (const m of modes) P.select(ap, m, s); return ap }
const selected = (ap: P.Autopilot) => P.MODES.filter((m) => ap.modes[m])

describe('engaging', () => {
  it('starts off, with nothing shown', () => {
    const ap = P.fresh()
    expect([ap.engaged, selected(ap), P.cautions(ap, 0), P.advisories(ap), P.cue(ap, 0)]).toEqual([false, [], [], [], false])
  })
  it('can engage in the air with the INS\'s attitude, inside 70° of bank and 45° of pitch (2.9)', () => {
    expect(P.able(level)).toBe(true)
    expect([P.able(jet({ bank: 70 })), P.able(jet({ bank: -70.1 })), P.able(jet({ pitch: -45 })), P.able(jet({ pitch: 45.1 }))]).toEqual([true, false, true, false])
    expect([P.able(jet({ airborne: false })), P.able(jet({ attitude: false })), P.able(jet({ computer: false }))]).toEqual([false, false, true]) // MC1 is coupled steering's
  })
  it('holds the pitch attitude and the heading with ON/OFF, or past 5° of bank the roll attitude (2.9.2.1)', () => {
    const ap = P.fresh()
    expect(P.engage(ap, jet({ bank: 5 }))).toBe(true)
    expect([ap.engaged, ap.lateral, ap.heading, ap.pitch, selected(ap), P.advisories(ap)]).toEqual([true, 'heading', 90, 2, [], ['A/P']])
    const banked = P.fresh(); P.engage(banked, jet({ bank: -5.1 }))
    expect([banked.lateral, banked.bank]).toEqual(['bank', -5.1])
  })
  it('raises AUTO PILOT for ten seconds when it does not engage, and takes everything off with a second ON/OFF', () => {
    const ap = P.fresh()
    expect(P.engage(ap, jet({ bank: 80 }))).toBe(false)
    expect([ap.engaged, P.cautions(ap, 100), P.cautions(ap, 109.9), P.cautions(ap, 110)]).toEqual([false, ['AUTO PILOT'], ['AUTO PILOT'], []])
    const flying = on('barometric', 'select')()
    expect(P.engage(flying, level)).toBe(true)
    expect([flying.engaged, selected(flying), P.cautions(flying, 100)]).toEqual([false, [], []])
  })
})

describe('the options', () => {
  it('bring the autopilot on without ON/OFF, and leave it on when their colon is taken off (2.9.2.1)', () => {
    const ap = on('barometric')()
    expect([ap.engaged, selected(ap), ap.altitude, P.advisories(ap)]).toEqual([true, ['barometric'], 3000, ['A/P', 'BALT']])
    P.select(ap, 'barometric', jet({ pitch: 4 }))
    expect([ap.engaged, selected(ap), ap.pitch]).toEqual([true, [], 4]) // back to the attitude of the moment
  })
  it('capture the altitude of the moment: barometric with BALT, radar with RALT, one at a time (2.9.2.3, 2.9.2.5)', () => {
    const ap = on('barometric', 'radar')()
    expect([selected(ap), ap.altitude]).toEqual([['radar'], 900])
    P.select(ap, 'barometric', jet({ altitude: 3100 }))
    expect([selected(ap), ap.altitude]).toEqual([['barometric'], 3100])
  })
  it('hold the attitude of the moment with ATTH, and turn to the heading selected with HSEL, one or the other', () => {
    const ap = on('attitude')(jet({ bank: 25, pitch: 6 }))
    expect([selected(ap), ap.bank, ap.pitch]).toEqual([['attitude'], 25, 6])
    P.select(ap, 'select', level)
    expect(selected(ap)).toEqual(['select'])
    P.select(ap, 'barometric', level); P.select(ap, 'attitude', level)
    expect(selected(ap)).toEqual(['attitude', 'barometric']) // either lateral mode with an altitude hold
  })
  it('show only what is available: CPL with something to couple to and MC1, RALT inside the altimeter\'s 5,000 ft (2.9)', () => {
    const none = P.offered(P.fresh(), level)
    expect(none).toEqual({ attitude: true, select: true, barometric: true, radar: true, coupled: false })
    expect(P.offered(P.fresh(), jet({ couple: steering })).coupled).toBe(true); expect(P.offered(P.fresh(), jet({ couple: steering, computer: false })).coupled).toBe(false)
    expect([P.offered(P.fresh(), jet({ height: null })).radar, P.offered(P.fresh(), jet({ height: P.CEILING })).radar, P.offered(P.fresh(), jet({ height: P.CEILING + 1 })).radar]).toEqual([false, true, false])
  })
  it('refuse an option that is not available, or past the limits, with the caution', () => {
    const ap = P.fresh()
    expect(P.select(ap, 'radar', jet({ height: null }))).toBe(false)
    expect([ap.engaged, P.cautions(ap, 100)]).toEqual([false, ['AUTO PILOT']])
    const steep = P.fresh()
    expect(P.select(steep, 'barometric', jet({ pitch: 50 }))).toBe(false); expect(steep.engaged).toBe(false)
  })
  it('word the advisories as the DDI does, A/P first (2.9.1)', () => {
    expect(P.advisories(on('attitude', 'radar')())).toEqual(['A/P', 'ATTH', 'RALT'])
    expect(P.advisories(on('select', 'barometric', 'coupled')(jet({ couple: steering })))).toEqual(['A/P', 'BALT', 'CPLD'])
  })
})

describe('coupling', () => {
  it('couples to the steering there is, taking ATTH and HSEL off and out of the options (2.9.2.6)', () => {
    const s = jet({ couple: steering, bank: 12 })
    const ap = on('attitude', 'barometric', 'coupled')(s)
    expect([selected(ap), ap.source, ap.command, P.cue(ap, 100)]).toEqual([['barometric', 'coupled'], 'track', 12, true]) // the bank asked for starts from the bank it has
    expect(P.offered(ap, s)).toEqual({ attitude: false, select: false, barometric: true, radar: true, coupled: true })
    expect(P.select(ap, 'attitude', s)).toBe(false); expect(selected(ap)).toEqual(['barometric', 'coupled'])
  })
  it('couples to the carrier\'s commands in both axes: the altitude holds go, and nothing else is offered (24.6.1.2.3)', () => {
    const s = jet({ couple: carrier })
    const ap = on('radar', 'coupled')(s)
    expect([selected(ap), ap.source]).toEqual([['coupled'], 'bank'])
    expect(P.offered(ap, s)).toEqual({ attitude: false, select: false, barometric: false, radar: false, coupled: true })
  })
  it('flashes the coupled cue and raises the caution when a couple fails', () => {
    const ap = P.fresh()
    expect(P.select(ap, 'coupled', level)).toBe(false) // nothing to couple to
    expect([ap.modes.coupled, P.cautions(ap, 100), ap.flash]).toEqual([false, ['AUTO PILOT'], 110])
    expect([P.cue(ap, 100), P.cue(ap, 100.25), P.cue(ap, 100.5), P.cue(ap, 109.5), P.cue(ap, 110)]).toEqual([true, false, true, true, false]) // twice a second, ten seconds
  })
  it('lets a steering or traffic control couple go to heading hold with a second CPL, and no caution', () => {
    for (const couple of [steering, traffic]) {
      const s = jet({ couple, bank: 20 }), ap = on('barometric', 'coupled')(s)
      expect(P.select(ap, 'coupled', s)).toBe(true)
      expect([ap.engaged, selected(ap), ap.lateral, ap.heading, P.cautions(ap, 100), P.cue(ap, 100)], couple.axis).toEqual([true, ['barometric'], 'heading', 90, [], false])
    }
  })
  it('takes every mode off when the carrier\'s commands are let go: the pilot has the controls (24.6.1.2.3)', () => {
    const s = jet({ couple: carrier }), ap = on('coupled')(s)
    P.select(ap, 'coupled', s)
    expect([ap.engaged, selected(ap), P.cautions(ap, 100)]).toEqual([false, [], []])
  })
  it('limits coupled steering\'s bank and roll rate with BLIM: NAV 30° at 10° a second, TAC to 60° and 30° a second with airspeed (24.2.8)', () => {
    const knots = (k: number, limit: 'nav' | 'tac') => P.bound(jet({ cas: k * 0.514444, limit }))
    expect(knots(500, 'nav')).toEqual({ bank: 30, rate: 10 })
    expect(knots(200, 'tac')).toEqual({ bank: 30, rate: 10 }); expect(knots(250, 'tac')).toEqual({ bank: 30, rate: 10 })
    expect(knots(350, 'tac').bank).toBeCloseTo(45, 6); expect(knots(350, 'tac').rate).toBeCloseTo(20, 6)
    expect(knots(450, 'tac')).toEqual({ bank: 60, rate: 30 }); expect(knots(600, 'tac')).toEqual({ bank: 60, rate: 30 })
  })
})

describe('the paddle switch', () => {
  it('takes every mode off, and the caution and a flashing cue with them (2.9.1, 2.9.2.1)', () => {
    const ap = on('barometric', 'coupled')(jet({ couple: steering }))
    P.step(ap, level, 1 / 60) // the steering gone: it lets go by itself
    expect([P.cautions(ap, 100), P.cue(ap, 100)]).toEqual([['AUTO PILOT'], true])
    P.paddle(ap)
    expect([ap.engaged, selected(ap), P.cautions(ap, 100), P.cue(ap, 100)]).toEqual([false, [], [], false])
  })
})

describe('what makes it let go', () => {
  const dt = 1 / 60
  it('gives no stick while it is off', () => {
    expect(P.step(P.fresh(), level, dt)).toEqual({ pitch: null, roll: null })
  })
  it('is off on the wheels, without a caution', () => {
    const ap = on('barometric')()
    expect(P.step(ap, jet({ airborne: false }), dt)).toEqual({ pitch: null, roll: null })
    expect([ap.engaged, selected(ap), P.cautions(ap, 100)]).toEqual([false, [], []])
  })
  it('lets go with the caution when the INS\'s attitude or mission computer 1 is lost (figure 12-1, 25.1.1)', () => {
    for (const lost of [{ attitude: false }, { computer: false }]) {
      const ap = on('barometric')()
      expect(P.step(ap, jet(lost), dt)).toEqual({ pitch: null, roll: null })
      expect([ap.engaged, selected(ap), P.cautions(ap, 100), P.cue(ap, 100)]).toEqual([false, [], ['AUTO PILOT'], false])
    }
    const coupled = on('coupled')(jet({ couple: steering }))
    P.step(coupled, jet({ couple: steering, computer: false }), dt)
    expect([coupled.engaged, P.cue(coupled, 100)]).toEqual([false, true]) // and the coupled cue flashes
  })
  it('uncouples with the caution and the flashing cue when the source is gone or has changed, back to heading hold', () => {
    for (const now of [null, traffic]) {
      const ap = on('barometric', 'coupled')(jet({ couple: steering }))
      const stick = P.step(ap, jet({ couple: now, bank: 20 }), dt)
      expect([ap.engaged, selected(ap), ap.lateral, P.cautions(ap, 100), ap.flash]).toEqual([true, ['barometric'], 'heading', ['AUTO PILOT'], 110])
      expect(stick.roll).not.toBeNull()
    }
  })
  it('gives the controls back when the carrier\'s commands are lost', () => {
    const ap = on('coupled')(jet({ couple: carrier }))
    expect(P.step(ap, level, dt)).toEqual({ pitch: null, roll: null })
    expect([ap.engaged, P.cautions(ap, 100)]).toEqual([false, ['AUTO PILOT']])
  })
  it('drops radar altitude hold, with the caution, out of the altimeter\'s reach', () => {
    for (const height of [null, P.CEILING + 10]) {
      const ap = on('radar')()
      P.step(ap, jet({ height, pitch: 5 }), dt)
      expect([ap.engaged, selected(ap), ap.pitch, P.cautions(ap, 100)]).toEqual([true, [], 5, ['AUTO PILOT']])
    }
  })
})

describe('control stick steering', () => {
  const dt = 1 / 60
  it('gives the pilot the pitch axis while his stick is moved, and takes up the attitude he leaves it at', () => {
    const ap = P.fresh(); P.engage(ap, level)
    expect(P.step(ap, jet({ stick: { pitch: 0.2, roll: 0 }, pitch: 8 }), dt).pitch).toBeNull()
    expect(P.step(ap, jet({ stick: { pitch: 0.04, roll: 0 }, pitch: 9 }), dt).pitch).not.toBeNull() // inside the stick's own slack
    expect(ap.pitch).toBe(9)
  })
  it('takes BALT and RALT off with pitch stick, back to the attitude hold (2.9.2.3)', () => {
    for (const mode of ['barometric', 'radar'] as const) {
      const ap = on(mode)()
      P.step(ap, jet({ stick: { pitch: -0.2, roll: 0 } }), dt)
      expect([ap.engaged, selected(ap), P.cautions(ap, 100)], mode).toEqual([true, [], []])
    }
  })
  it('keeps the altitude through roll stick, and takes the new heading or roll attitude when it is let go (2.9.2.5)', () => {
    const ap = on('radar')()
    expect(P.step(ap, jet({ stick: { pitch: 0, roll: 0.3 }, bank: 20, heading: 100 }), dt)).toMatchObject({ roll: null })
    expect(selected(ap)).toEqual(['radar'])
    P.step(ap, jet({ bank: 20, heading: 110 }), dt)
    expect([ap.lateral, ap.bank]).toEqual(['bank', 20])
    P.step(ap, jet({ stick: { pitch: 0, roll: -0.3 }, bank: 3 }), dt); P.step(ap, jet({ bank: 3, heading: 130 }), dt)
    expect([ap.lateral, ap.heading]).toEqual(['heading', 130])
  })
  it('keeps the pitch attitude held through roll stick', () => {
    const ap = P.fresh(); P.engage(ap, level)
    P.step(ap, jet({ stick: { pitch: 0, roll: 0.3 }, bank: 20, pitch: 6 }), dt); P.step(ap, jet({ bank: 20, pitch: 6 }), dt)
    expect([ap.lateral, ap.bank, ap.pitch]).toEqual(['bank', 20, 2]) // the nose is still the autopilot's: its reference stands
  })
  it('takes the new roll attitude in ATTH, and simply resumes the turn in HSEL', () => {
    const atth = on('attitude')(jet({ bank: 10 }))
    P.step(atth, jet({ stick: { pitch: 0, roll: 0.3 }, bank: 30 }), dt); P.step(atth, jet({ bank: 32 }), dt)
    expect(atth.bank).toBe(32)
    const hsel = on('select')()
    P.step(hsel, jet({ stick: { pitch: 0, roll: 0.3 } }), dt)
    expect(P.step(hsel, level, dt).roll).toBeGreaterThan(0); expect(selected(hsel)).toEqual(['select'])
  })
  it('decouples steering past half an inch of roll stick, not inside it, and never by pitch stick (2.9.2.6)', () => {
    const s = jet({ couple: steering })
    const ap = on('coupled')(s)
    expect(P.step(ap, { ...s, stick: { pitch: 0, roll: 0.14 } }, dt).roll).not.toBeNull(); expect(ap.modes.coupled).toBe(true)
    expect(P.step(ap, { ...s, stick: { pitch: 0.3, roll: 0 } }, dt)).toMatchObject({ pitch: null }); expect(ap.modes.coupled).toBe(true)
    P.step(ap, { ...s, stick: { pitch: 0, roll: 0.16 } }, dt)
    expect([ap.modes.coupled, ap.engaged, P.cautions(ap, 100)]).toEqual([false, true, ['AUTO PILOT']])
  })
  it('lets the carrier\'s commands go on either stick, everything off (24.6.1.2.3)', () => {
    for (const stick of [{ pitch: 0.1, roll: 0 }, { pitch: 0, roll: 0.1 }]) {
      const s = jet({ couple: carrier }), ap = on('coupled')(s)
      expect(P.step(ap, { ...s, stick }, dt)).toEqual({ pitch: null, roll: null })
      expect([ap.engaged, P.cautions(ap, 100)]).toEqual([false, ['AUTO PILOT']])
    }
  })
})

describe('the trim switch', () => {
  const second = (ap: P.Autopilot, s: P.Sense) => { for (let k = 0; k < 60; k++) P.step(ap, s, 1 / 60) }
  it('moves the pitch attitude held at half a degree a second, to 45°, and not while an altitude is held (2.9.2.1)', () => {
    const ap = P.fresh(); P.engage(ap, level)
    second(ap, jet({ trim: { pitch: 1, roll: 0 } }))
    expect(ap.pitch).toBeCloseTo(2.5, 6)
    ap.pitch = 44.9; second(ap, jet({ trim: { pitch: 1, roll: 0 } }))
    expect(ap.pitch).toBe(45)
    const held = on('barometric')(); second(held, jet({ trim: { pitch: -1, roll: 0 } }))
    expect(held.pitch).toBe(2)
  })
  it('moves the heading held, or the roll attitude, at two degrees a second', () => {
    const ap = P.fresh(); P.engage(ap, level)
    second(ap, jet({ trim: { pitch: 0, roll: -1 } }))
    expect(ap.heading).toBeCloseTo(88, 6)
    const banked = on('attitude')(jet({ bank: 69 })); second(banked, jet({ bank: 69, trim: { pitch: 0, roll: 1 } }))
    expect(banked.bank).toBe(70) // and no further than 70°
    const hsel = on('select')(); second(hsel, jet({ trim: { pitch: 0, roll: 1 } }))
    expect(hsel.heading).toBe(90) // HSEL's heading is the HSI's
  })
})

describe('the stick it gives', () => {
  const dt = 1 / 60
  const roll = (ap: P.Autopilot, s: P.Sense) => P.step(ap, s, dt).roll as number
  it('rolls toward the heading held, banking no more than 30° for it', () => {
    const ap = P.fresh(); P.engage(ap, level)
    expect(roll(ap, level)).toBeCloseTo(0, 9)
    expect(roll(ap, jet({ heading: 80 }))).toBeGreaterThan(0); expect(roll(ap, jet({ heading: 100 }))).toBeLessThan(0)
    expect(roll(ap, jet({ heading: 0 }))).toBeCloseTo(30 * 0.022, 9); expect(roll(ap, jet({ heading: 0, bank: 30 }))).toBeCloseTo(0, 9)
  })
  it('turns the short way to the heading selected, and damps the roll', () => {
    const ap = on('select')()
    expect(roll(ap, jet({ heading: 350, selected: 10 }))).toBeGreaterThan(0); expect(roll(ap, jet({ heading: 10, selected: 350 }))).toBeLessThan(0)
    expect(roll(ap, jet({ heading: 120, roll: 0.5 }))).toBeCloseTo(-0.09, 9) // on the heading, rolling right: stick against it
  })
  it('holds the roll attitude in ATTH, and rolls harder through the approach law\'s stick', () => {
    const ap = on('attitude')(jet({ bank: 20 }))
    expect(roll(ap, jet({ bank: 10 }))).toBeCloseTo(10 * 0.022, 9); expect(roll(ap, jet({ bank: 10, approach: true }))).toBeCloseTo(10 * 0.045, 9)
  })
  it('brings coupled steering\'s bank on at its rate, toward the track to fly, inside the bank limit', () => {
    const far = jet({ couple: { axis: 'track', value: 180, vertical: null }, track: 90 })
    const ap = on('coupled')(far)
    for (let k = 0; k < 60; k++) P.step(ap, far, dt)
    expect(ap.command).toBeCloseTo(10, 6) // NAV: 10° a second
    for (let k = 0; k < 600; k++) P.step(ap, far, dt)
    expect(ap.command).toBeCloseTo(30, 6)
    const fast = { ...far, limit: 'tac' as const, cas: 450 * 0.514444 }, tac = on('coupled')(fast)
    for (let k = 0; k < 60; k++) P.step(tac, fast, dt)
    expect(tac.command).toBeCloseTo(30, 6) // TAC at 450 knots: 30° a second
    for (let k = 0; k < 600; k++) P.step(tac, fast, dt)
    expect(tac.command).toBeCloseTo(60, 6)
    const between = jet({ couple: { axis: 'track', value: 91, vertical: null }, track: 92, heading: 90 }), cross = on('coupled')(between)
    for (let k = 0; k < 60; k++) P.step(cross, between, dt)
    expect(cross.command).toBeCloseTo(-2.5, 6) // against the track, not the heading: a degree left of where the jet is going
    const left = jet({ couple: { axis: 'track', value: 80, vertical: null }, track: 92 }), other = on('coupled')(left)
    for (let k = 0; k < 600; k++) P.step(other, left, dt)
    expect(other.command).toBeCloseTo(-30, 6)
  })
  it('flies a traffic control heading against the heading, to 30° of bank at 10° a second (24.6.1.2.2)', () => {
    const s = jet({ couple: { axis: 'heading', value: 200, vertical: null }, limit: 'tac', cas: 450 * 0.514444 })
    const ap = on('coupled')(s)
    for (let k = 0; k < 60; k++) P.step(ap, s, dt)
    expect(ap.command).toBeCloseTo(10, 6)
    for (let k = 0; k < 600; k++) P.step(ap, s, dt)
    expect(ap.command).toBeCloseTo(30, 6) // BLIM is coupled steering's, not this
    expect(roll(ap, { ...s, heading: 199 })).toBeLessThan(roll(ap, { ...s, heading: 150 }))
  })
  it('takes the carrier\'s roll angle and rate of climb as given, inside what the FCS accepts', () => {
    const rolled = jet({ couple: { axis: 'bank', value: 50, vertical: 0 }, approach: true }), ap = on('coupled')(rolled)
    for (let k = 0; k < 600; k++) P.step(ap, rolled, dt)
    expect(ap.command).toBeCloseTo(30, 6) // 30° of the 50° asked
    // the stick once the jet has settled at a rate of climb, against the rate the carrier asks
    const settled = (asked: number, flown: number) => { const s = jet({ couple: { axis: 'bank', value: 0, vertical: asked }, approach: true, vertical: flown }), flying = on('coupled')(s); let stick = 0
      for (let k = 0; k < 120; k++) stick = P.step(flying, s, dt).pitch as number
      return stick }
    expect(settled(-3, -3)).toBeCloseTo(0, 2); expect(settled(-3, -5)).toBeGreaterThan(0.05); expect(settled(-3, -1)).toBeLessThan(-0.05)
    expect(settled(-20, -8)).toBeCloseTo(0, 2); expect(settled(-20, -12)).toBeGreaterThan(0.05) // -8 m/s is the most sink it will fly
    expect(settled(10, 4)).toBeCloseTo(0, 2); expect(settled(10, 6)).toBeLessThan(-0.05) // and 4 m/s the most climb
  })
  it('pulls toward an altitude held from below and pushes from above, in either control law', () => {
    for (const approach of [false, true]) {
      const ap = on('barometric')(jet({ approach }))
      const low = P.step(ap, jet({ approach, altitude: 2990 }), dt).pitch as number, high = P.step(on('barometric')(jet({ approach })), jet({ approach, altitude: 3010 }), dt).pitch as number
      expect(low, String(approach)).toBeGreaterThan(0); expect(high, String(approach)).toBeLessThan(0)
    }
    const radar = on('radar')()
    expect(P.step(radar, jet({ height: 890, altitude: 5000 }), dt).pitch as number).toBeGreaterThan(0) // RALT flies the radar altitude, not the barometric
  })
  it('holds the nose in attitude hold, adds the bank\'s share of the lift, and damps the pitch rate', () => {
    const ap = P.fresh(); P.engage(ap, level)
    expect(P.step(ap, jet({ pitch: 1 }), dt).pitch as number).toBeGreaterThan(0); expect(P.step(P.fresh(), level, dt).pitch).toBeNull()
    const flat = P.fresh(); P.engage(flat, level)
    const banked = P.fresh(); P.select(banked, 'attitude', jet({ bank: 45 }))
    expect(P.step(banked, jet({ bank: 45 }), dt).pitch as number).toBeGreaterThan((P.step(flat, level, dt).pitch as number) + 0.05) // 1.41 g of turn
    const rising = P.fresh(); P.engage(rising, level)
    expect(P.step(rising, jet({ rate: 0.05 }), dt).pitch as number).toBeLessThan(0)
  })
})
