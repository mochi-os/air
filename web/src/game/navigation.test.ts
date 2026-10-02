// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { describe, it, expect } from 'vitest'
import * as N from './navigation'

const NM = 1852
const D = Math.PI / 180
const truth = (over: Partial<N.Truth> = {}): N.Truth => ({
  dt: 1, x: 0, z: 0, east: 0, south: 0, tas: 0, heading: 0, pitch: 0, bank: 0, airborne: false, brake: true, power: true, radar: false, deck: false, tacan: null, ...over,
})
const run = (nav: N.Navigation, t: N.Truth, seconds: number) => {
  for (let i = 0; i < seconds; i++) N.step(nav, t)
}
const size = (f: N.Fix) => Math.hypot(f.x, f.z)
const point = (x: number, z: number, more: Partial<N.Waypoint> = {}): N.Waypoint => ({ x, z, elevation: 0, name: '', offset: null, ...more })
// cold: a jet with power on and the INS never started. flying: a spawn, aligned in NAV.
const cold = () => {
  const nav = N.fresh(7)
  run(nav, truth(), 1)
  nav.gps.search = 0
  return nav
}
const flying = (over: Partial<N.Truth> = {}) => {
  const nav = N.fresh(7)
  const t = truth({ airborne: true, brake: false, tas: 200, north: 0, east: 0, south: -200, ...over } as Partial<N.Truth>)
  N.ready(nav, t)
  N.step(nav, { ...t, dt: 0 })
  return { nav, t }
}

describe('the alignment quality', () => {
  it('is NO ATT while the platform levels, then 99.9 falling to 0.5', () => {
    expect(N.quality(0)).toBeNull()
    expect(N.quality(N.LEVEL - 1)).toBeNull()
    expect(N.quality(N.LEVEL)).toBeCloseTo(99.9, 5)
    expect(N.quality(68)).toBeGreaterThan(18.3) // figure 24-4: 18.8 at 1:08
    expect(N.quality(68)).toBeLessThan(19.3)
    expect(N.quality(470)).toBeGreaterThan(0.5)
    expect(N.quality(481)).toBe(0.5)
    expect(N.quality(5000)).toBe(0.5)
  })
})

describe('a ground alignment', () => {
  it('levels for 20 s with no attitude, then counts its quality down to OK', () => {
    const nav = cold()
    nav.ins.knob = 'gnd'
    run(nav, truth(), 10)
    expect(N.alignment(nav)).toMatchObject({ title: 'GRND', quality: null, time: 10, held: false, complete: false })
    expect(N.attitude(nav.ins)).toBe(false)
    expect(N.cautions(nav)).toContain('INS ATT')
    run(nav, truth(), 15)
    expect(N.attitude(nav.ins)).toBe(true)
    expect(N.cautions(nav)).not.toContain('INS ATT')
    expect(N.alignment(nav)?.quality).toBeLessThan(99.9)
    run(nav, truth(), 440)
    expect(N.alignment(nav)?.complete).toBe(false)
    run(nav, truth(), 20)
    expect(N.alignment(nav)).toMatchObject({ quality: 0.5, complete: true })
  })
  it('holds with the parking brake off, its time stopped', () => {
    const nav = cold()
    nav.ins.knob = 'gnd'
    run(nav, truth(), 30)
    run(nav, truth({ brake: false }), 50)
    expect(N.alignment(nav)).toMatchObject({ time: 30, held: true })
    run(nav, truth(), 5)
    expect(N.alignment(nav)).toMatchObject({ time: 35, held: false })
  })
  it('takes waypoint 0 for the present position', () => {
    const nav = cold()
    nav.waypoints[0] = point(300, -400)
    nav.ins.knob = 'gnd'
    run(nav, truth(), 2)
    expect(nav.ins.error).toEqual({ x: 300, z: -400 })
  })
  it('goes to NAV complete: navigating, waypoint 0 stored, a mile an hour of drift', () => {
    const nav = cold()
    nav.ins.knob = 'gnd'
    run(nav, truth({ x: 50, z: 60 }), 490)
    nav.ins.knob = 'nav'
    run(nav, truth({ x: 50, z: 60 }), 1)
    expect(nav.ins.mode).toBe('nav')
    expect(nav.ins.partial).toBe(false)
    expect(N.advisories(nav)).not.toContain('ALGN')
    expect(nav.source).toBe('ins')
    expect(nav.waypoints[0]).toMatchObject({ x: 50, z: 60 })
    run(nav, truth({ x: 50, z: 60 }), 3599)
    expect(size(nav.ins.error)).toBeCloseTo(NM, -1)
  })
  it('taken to NAV early navigates on a partial alignment, drifting faster, with ALGN', () => {
    const nav = cold()
    nav.ins.knob = 'gnd'
    run(nav, truth(), 200)
    const q = N.quality(nav.ins.progress) as number
    expect(q).toBeLessThan(N.VALID)
    expect(q).toBeGreaterThan(N.COMPLETE)
    nav.ins.knob = 'nav'
    run(nav, truth(), 1)
    expect(nav.ins.mode).toBe('nav')
    expect(N.advisories(nav)).toContain('ALGN')
    expect(size(nav.ins.drift)).toBeCloseTo(N.DRIFT * ((N.quality(nav.ins.progress) as number) / N.COMPLETE), 6)
    expect(size(nav.ins.drift)).toBeGreaterThan(N.DRIFT * 3)
  })
  it('taken to NAV before its velocities are valid is an attitude reference only', () => {
    const nav = cold()
    nav.gps.on = false
    nav.ins.knob = 'gnd'
    run(nav, truth(), 40)
    expect(N.velocity(nav.ins)).toBe(false)
    nav.ins.knob = 'nav'
    run(nav, truth({ power: true }), 1)
    expect(nav.ins.mode).toBe('gyro')
    expect(N.attitude(nav.ins)).toBe(true)
    expect(N.advisories(nav)).toContain('ALGN')
  })
  it('goes to NAV by itself off the ground past 80 knots', () => {
    const nav = cold()
    nav.ins.knob = 'gnd'
    run(nav, truth(), 300)
    run(nav, truth({ airborne: true, brake: false, east: 40 }), 1)
    expect(nav.ins.mode).toBe('align')
    run(nav, truth({ airborne: true, brake: false, east: 42 }), 1)
    expect(nav.ins.mode).toBe('nav')
    expect(nav.ins.knob).toBe('gnd')
  })
})

describe('a carrier alignment', () => {
  it('needs the ship, and reads CV RF', () => {
    const nav = cold()
    nav.ins.knob = 'cv'
    run(nav, truth(), 30)
    expect(N.alignment(nav)).toMatchObject({ title: 'CV RF', held: true, time: 0 })
    run(nav, truth({ deck: true }), 30)
    expect(N.alignment(nav)).toMatchObject({ held: false, time: 30 })
  })
  it('runs off the ship as a manual alignment, in about 15 minutes', () => {
    const nav = cold()
    nav.ins.knob = 'cv'
    run(nav, truth(), 1)
    expect(N.manual(nav)).toBe(true)
    run(nav, truth(), 880)
    expect(N.alignment(nav)).toMatchObject({ title: 'CV MAN', complete: false })
    run(nav, truth(), 25)
    expect(N.alignment(nav)?.complete).toBe(true)
  })
  it('offers a stored heading only after a good alignment shut down without NAV', () => {
    const nav = cold()
    nav.ins.knob = 'gnd'
    run(nav, truth(), 2)
    expect(N.storable(nav)).toBe(false)
    run(nav, truth(), 490)
    nav.ins.knob = 'off'
    run(nav, truth(), 6)
    nav.ins.knob = 'gnd'
    run(nav, truth(), 1)
    expect(N.storable(nav)).toBe(true)
    expect(N.stored(nav)).toBe(true)
    expect(N.storable(nav)).toBe(false)
    run(nav, truth(), 110)
    expect(N.alignment(nav)?.complete).toBe(false)
    run(nav, truth(), 12)
    expect(N.alignment(nav)?.complete).toBe(true)
    // after NAV has been selected the heading is no longer kept: not on a realignment straight from NAV, nor after a shutdown
    nav.ins.knob = 'nav'
    run(nav, truth(), 1)
    nav.ins.knob = 'gnd'
    run(nav, truth(), 1)
    expect(N.storable(nav)).toBe(false)
    nav.ins.knob = 'off'
    run(nav, truth(), 6)
    nav.ins.knob = 'gnd'
    run(nav, truth(), 1)
    expect(N.storable(nav)).toBe(false)
  })
})

describe('the knob at OFF and a power loss', () => {
  it('shuts the INS down, and it restarts only after 5 s at OFF', () => {
    const { nav, t } = flying()
    expect(N.attitude(nav.ins)).toBe(true)
    nav.ins.knob = 'off'
    run(nav, t, 3)
    expect(nav.ins.mode).toBe('off')
    expect(N.attitude(nav.ins)).toBe(false)
    expect(N.cautions(nav)).toContain('INS ATT')
    nav.ins.knob = 'ifa'
    run(nav, t, 30)
    expect(nav.ins.mode).toBe('off')
    nav.ins.knob = 'off'
    run(nav, t, 3)
    nav.ins.knob = 'ifa'
    run(nav, t, 1)
    expect(nav.ins.mode).toBe('align')
  })
  it('trips on a power loss, wanting the knob at OFF before it starts again', () => {
    const { nav, t } = flying()
    run(nav, { ...t, power: false }, 1)
    expect(nav.ins.mode).toBe('off')
    expect(N.tracking(nav.gps)).toBe(false)
    run(nav, t, 30)
    expect(nav.ins.mode).toBe('off')
    nav.ins.knob = 'off'
    run(nav, t, 6)
    nav.ins.knob = 'ifa'
    run(nav, t, 1)
    expect(nav.ins.mode).toBe('align')
  })
  it('leaves GPS searching for 12 minutes after power returns', () => {
    const { nav, t } = flying()
    run(nav, { ...t, power: false }, 1)
    run(nav, t, 718)
    expect(N.tracking(nav.gps)).toBe(false)
    run(nav, t, 3)
    expect(N.tracking(nav.gps)).toBe(true)
  })
})

describe('the aided INS', () => {
  it('is selected by the knob at IFA, and corrects velocity at 5 s and position at 40 s', () => {
    const { nav, t } = flying()
    nav.ins.error = { x: 2000, z: 0 }
    nav.ins.knob = 'ifa'
    run(nav, t, 1)
    expect(nav.source).toBe('ains')
    run(nav, t, 3)
    const before = size(nav.ins.error)
    run(nav, t, 30)
    expect(size(nav.ins.error)).toBeLessThan(before + 1) // the velocities corrected: no more drift
    expect(size(nav.ins.error)).toBeGreaterThan(1990)
    run(nav, t, 8)
    expect(nav.ins.error).toEqual(nav.gps.error)
    expect(size(N.offset(nav, t))).toBeCloseTo(N.HERR, 6)
  })
  it('goes back to the INS alone with the knob at NAV, drifting again', () => {
    const { nav, t } = flying()
    nav.ins.knob = 'ifa'
    run(nav, t, 50)
    nav.ins.knob = 'nav'
    run(nav, t, 1)
    expect(nav.source).toBe('ins')
    expect(N.available(nav, t).ains).toBe(false) // the aided INS is the knob at IFA
    const before = size(nav.ins.error)
    run(nav, t, 1000)
    expect(size(nav.ins.error)).toBeGreaterThan(before + 400)
  })
  it('is not there without satellites', () => {
    const { nav, t } = flying()
    nav.gps.search = 100
    nav.ins.knob = 'ifa'
    run(nav, t, 1)
    expect(nav.source).toBe('ins')
    expect(N.available(nav, t).ains).toBe(false)
    expect(N.select(nav, t, 'ains')).toBe(false)
    expect(N.select(nav, t, 'gps')).toBe(false)
  })
})

describe('an inflight alignment', () => {
  const restart = (nav: N.Navigation, t: N.Truth) => {
    nav.ins.knob = 'off'
    run(nav, t, 6)
    nav.ins.knob = 'ifa'
    run(nav, t, 1)
  }
  it('aligns on GPS in about ten minutes and takes up the GPS position', () => {
    const { nav, t } = flying()
    restart(nav, t)
    expect(N.alignment(nav)?.title).toBe('IFA GPS')
    expect(nav.source).toBe('gps')
    run(nav, t, 590)
    expect(nav.ins.mode).toBe('align')
    run(nav, t, 15)
    expect(nav.ins.mode).toBe('nav')
    expect(nav.ins.partial).toBe(false)
    expect(nav.source).toBe('ains')
    expect(size(nav.ins.error)).toBeLessThan(N.HERR + 5)
  })
  it('without satellites is a radar alignment: it needs the radar, and holds in a steep turn', () => {
    const { nav, t } = flying()
    nav.gps.search = 5000
    restart(nav, t)
    expect(N.alignment(nav)).toMatchObject({ title: 'IFA RDR', held: true })
    expect(nav.source).toBe('adc')
    expect(N.cautions(nav)).toContain('POS/ADC')
    run(nav, { ...t, radar: true }, 10)
    expect(N.alignment(nav)).toMatchObject({ held: false, time: 10 })
    run(nav, { ...t, radar: true, bank: 40 * D }, 10)
    expect(N.alignment(nav)).toMatchObject({ held: true, time: 10 })
    run(nav, { ...t, radar: true, bank: 25 * D }, 5)
    expect(N.alignment(nav)).toMatchObject({ held: false, time: 15 })
  })
  it('holds 65 s for lost satellites, then goes on by radar', () => {
    const { nav, t } = flying()
    restart(nav, t)
    run(nav, t, 30)
    nav.gps.search = 5000
    run(nav, { ...t, radar: true }, 60)
    expect(N.alignment(nav)).toMatchObject({ title: 'IFA GPS', held: true })
    run(nav, { ...t, radar: true }, 10)
    expect(N.alignment(nav)).toMatchObject({ title: 'IFA RDR', held: false })
  })
  it('takes up the position being kept when it completes, not the one it started with', () => {
    const { nav, t } = flying()
    nav.gps.search = 5000
    restart(nav, t)
    nav.adc.error = { x: 4000, z: 0 } // dead reckoning has wandered, or a position was entered, during the alignment
    run(nav, { ...t, radar: true }, 620)
    expect(nav.ins.mode).toBe('nav')
    expect(nav.ins.error.x).toBeGreaterThan(3900)
  })
  it('does not run on the ground', () => {
    const nav = cold()
    nav.ins.knob = 'ifa'
    run(nav, truth(), 30)
    expect(N.alignment(nav)).toMatchObject({ held: true, time: 0 })
  })
})

describe('the attitude-only mode', () => {
  it('keeps attitude and gives up navigation', () => {
    const { nav, t } = flying()
    nav.ins.knob = 'gyro'
    run(nav, t, 1)
    expect(nav.ins.mode).toBe('gyro')
    expect(N.attitude(nav.ins)).toBe(true)
    expect(N.velocity(nav.ins)).toBe(false)
    expect(nav.source).toBe('gps')
    expect(N.vector(nav, 'auto')).toBe('vector') // GPS velocities place a steady velocity vector
    nav.gps.search = 5000
    run(nav, t, 1)
    expect(nav.source).toBe('adc')
    expect(N.vector(nav, 'auto')).toBe('flash')
    expect(N.cautions(nav)).not.toContain('POS/ADC') // it fell from GPS, not from the INS
    nav.gps.search = 0
    nav.ins.knob = 'ifa'
    run(nav, t, 2)
    expect(N.alignment(nav)).toMatchObject({ title: 'IFA GPS', complete: false }) // the alignment was given up with the navigation
  })
  it('levels from cold in 20 s', () => {
    const nav = cold()
    nav.ins.knob = 'gyro'
    run(nav, truth(), 19)
    expect(N.attitude(nav.ins)).toBe(false)
    run(nav, truth(), 2)
    expect(N.attitude(nav.ins)).toBe(true)
  })
})

describe('the HUD flight path', () => {
  it('is the waterline symbol at STBY or without INS attitude', () => {
    const { nav, t } = flying()
    expect(N.vector(nav, 'auto')).toBe('vector')
    expect(N.vector(nav, 'stby')).toBe('waterline')
    nav.ins.knob = 'off'
    run(nav, t, 1)
    expect(N.vector(nav, 'auto')).toBe('waterline')
    expect(N.vector(nav, 'ins')).toBe('waterline')
  })
})

describe('GPS', () => {
  it('is inoperable without mission computer 1, and back at once with it', () => {
    const { nav, t } = flying()
    expect(N.tracking(nav.gps)).toBe(true)
    N.step(nav, { ...t, dt: 1, computer: false })
    expect([N.tracking(nav.gps), N.good(nav.gps), N.horizontal(nav.gps), nav.gps.search]).toEqual([false, false, null, 0]) // the receiver keeps its satellites
    N.step(nav, { ...t, dt: 1, computer: true })
    expect(N.tracking(nav.gps)).toBe(true)
    N.step(nav, { ...t, dt: 1 })
    expect(N.tracking(nav.gps)).toBe(true) // not said: taken as running
  })
  it('is good with its errors under 100 ft', () => {
    const nav = cold()
    expect(N.good(nav.gps)).toBe(true)
    expect(N.horizontal(nav.gps)).toBeCloseTo(N.HERR, 6)
    nav.gps.error = { x: 31, z: 0 }
    expect(N.good(nav.gps)).toBe(false)
    nav.gps.search = 10
    expect(N.horizontal(nav.gps)).toBeNull()
    expect(N.vertical(nav.gps)).toBeNull()
  })
  it('raises GPS DEGD in the approach phase past 33 m for ten seconds', () => {
    const { nav, t } = flying()
    nav.source = 'gps'
    nav.gps.phase = 'appr'
    nav.gps.error = { x: 25, z: 0 }
    run(nav, t, 20)
    expect(N.cautions(nav)).not.toContain('GPS DEGD')
    nav.gps.error = { x: 28, z: 20 }
    nav.source = 'gps'
    run(nav, t, 9)
    nav.source = 'gps'
    expect(N.cautions(nav)).not.toContain('GPS DEGD')
    run(nav, t, 2)
    nav.source = 'gps'
    expect(N.cautions(nav)).toContain('GPS DEGD')
    nav.gps.phase = 'norm'
    expect(N.cautions(nav)).not.toContain('GPS DEGD')
  })
  it('advises GPS in the normal phase past 333 m, and nothing for leaving the secure mode, which is a later OFP\'s', () => {
    const { nav } = flying()
    nav.source = 'gps'
    nav.gps.error = { x: 300, z: 0 }
    expect(N.advisories(nav)).toEqual([])
    nav.gps.error = { x: 340, z: 0 }
    expect(N.advisories(nav)).toEqual(['GPS'])
    nav.gps.secure = false
    expect(N.advisories(nav)).toEqual(['GPS'])
  })
})

describe('position keeping', () => {
  it('gives way down the hierarchy, and calls POS/ADC only when it falls from the INS', () => {
    const { nav, t } = flying()
    nav.ins.knob = 'ifa'
    run(nav, t, 1)
    expect(nav.source).toBe('ains')
    nav.gps.search = 5000
    run(nav, t, 1)
    expect(nav.source).toBe('ins')
    nav.ins.knob = 'gyro'
    run(nav, t, 1)
    expect(nav.source).toBe('adc')
    expect(N.cautions(nav)).toContain('POS/ADC')
    nav.gps.search = 0
    run(nav, t, 1)
    expect(nav.source).toBe('adc') // a source chosen stays until it fails
    expect(N.select(nav, t, 'gps')).toBe(true)
    expect(N.cautions(nav)).not.toContain('POS/ADC')
    expect(N.select(nav, t, 'adc')).toBe(true)
    expect(N.cautions(nav)).not.toContain('POS/ADC') // selected by hand
  })
  it('dead reckons on the last wind found: steady air keeps it, a change of wind carries it off', () => {
    const { nav, t } = flying({ east: 10, south: -200 }) // heading north at 200 m/s in a 10 m/s wind from the west
    run(nav, t, 5)
    expect(nav.adc.wind.x).toBeCloseTo(10, 6)
    nav.ins.knob = 'gyro'
    nav.gps.search = 5000
    run(nav, t, 100)
    expect(nav.source).toBe('adc')
    const start = size(nav.adc.error)
    run(nav, t, 100)
    expect(size(nav.adc.error)).toBeCloseTo(start, 6)
    run(nav, { ...t, east: 15 }, 100)
    expect(size(nav.adc.error)).toBeGreaterThan(start + 400)
  })
  it('keeps the position by TACAN to within its bearing error', () => {
    const { nav, t } = flying()
    const tacan = { x: 0, z: -50000, bearing: 0, range: 50000 }
    const with_ = { ...t, tacan }
    expect(N.select(nav, t, 'tcn')).toBe(false)
    expect(N.select(nav, with_, 'tcn')).toBe(true)
    expect(size(N.offset(nav, with_))).toBeCloseTo(2 * 50000 * Math.sin(Math.abs(nav.bias) / 2), 3)
    run(nav, t, 1) // the station lost
    expect(nav.source).toBe('ins')
  })
  it('places the aircraft where the kept position has it', () => {
    const { nav, t } = flying({ x: 1000, z: 2000 })
    nav.ins.error = { x: 30, z: -40 }
    expect(N.place(nav, t)).toEqual({ x: 1030, z: 1960 })
  })
  it('takes a present position entered by hand', () => {
    const { nav, t } = flying({ x: 1000, z: 2000 })
    N.locate(nav, t, { x: 1500, z: 2000 })
    expect(N.place(nav, t)).toEqual({ x: 1500, z: 2000 })
  })
})

describe('position updates', () => {
  const tacan = { x: 0, z: -30000, bearing: 0, range: 30000 }
  it('keeps the post flight log: the unaided navigation time, and each update\'s error, summed and in size, with the rate it showed', () => {
    const { nav, t } = flying()
    expect(nav.log).toEqual(N.record())
    N.step(nav, { ...t, dt: 1800 })
    expect(nav.log.navigation).toBe(1800)
    nav.bias = 0; nav.ins.error = { x: 926, z: 1852 } // half a mile east, a mile south
    expect(N.propose(nav, { ...t, tacan }, 'tcn')).toBe(true); expect(N.accept(nav)).toBe(true)
    expect(nav.log.updates).toBe(1); expect(nav.log.error.north).toBeCloseTo(-1852, 6); expect(nav.log.error.east).toBeCloseTo(926, 6)
    expect(nav.log.cumulative.north).toBeCloseTo(1852, 6); expect(nav.log.rate as number * 3600 / 1852).toBeCloseTo(Math.hypot(1, 0.5) * 2, 6) // nm an hour, over half an hour
    nav.ins.error = { x: -926, z: 0 }
    N.propose(nav, { ...t, tacan }, 'tcn'); N.accept(nav)
    expect(nav.log.updates).toBe(2); expect(nav.log.error.east).toBeCloseTo(0, 6); expect(nav.log.cumulative.east).toBeCloseTo(1852, 6) // summed as they came, and in size
  })
  it('counts no navigation time on the aided INS, and logs no update taken on air data', () => {
    const { nav, t } = flying()
    nav.ins.knob = 'ifa'
    N.step(nav, { ...t, dt: 5 }); const held = nav.log.navigation; N.step(nav, { ...t, dt: 100 })
    expect(nav.ins.aided.held).toBe(true); expect(nav.log.navigation).toBe(held)
    const other = flying(); other.nav.source = 'adc'; other.nav.bias = 0; other.nav.adc.error = { x: 500, z: 0 }
    N.propose(other.nav, { ...other.t, tacan }, 'tcn'); N.accept(other.nav)
    expect(other.nav.log.updates).toBe(0)
  })
  it('starts the log afresh with an alignment, and keeps the time it took', () => {
    const nav = cold(); nav.log.updates = 3
    nav.ins.knob = 'gnd'
    for (let k = 0; k < 30; k++) N.step(nav, truth({ dt: 1, brake: true, power: true }))
    expect(nav.log.updates).toBe(0); expect(nav.log.alignment).toBe(nav.ins.time); expect(nav.log.alignment).toBeGreaterThan(20)
  })
  it('a TACAN update shows the error and ACPT takes the TACAN position', () => {
    const { nav, t } = flying()
    const with_ = { ...t, tacan }
    nav.bias = 0
    nav.ins.error = { x: 3000, z: 0 }
    expect(N.propose(nav, with_, 'tcn')).toBe(true)
    const read = N.reading(nav) as N.Leg
    expect(read.range).toBeCloseTo(3000, 6)
    expect(read.bearing / D).toBeCloseTo(270, 6) // the computed position lies west of the onboard one
    expect(N.accept(nav)).toBe(true)
    expect(size(nav.ins.error)).toBeCloseTo(0, 6)
    expect(nav.update).toBeNull()
    expect(N.cancel(nav)).toBe(true)
    expect(nav.ins.error).toEqual({ x: 3000, z: 0 })
    expect(N.cancel(nav)).toBe(false)
  })
  it('REJ leaves the position as it was', () => {
    const { nav, t } = flying()
    nav.ins.error = { x: 3000, z: 0 }
    N.propose(nav, { ...t, tacan }, 'tcn')
    expect(N.reject(nav)).toBe(true)
    expect(nav.ins.error).toEqual({ x: 3000, z: 0 })
    expect(N.accept(nav)).toBe(false)
  })
  it('is not offered while the aided INS keeps the position, nor without the data', () => {
    const { nav, t } = flying()
    expect(N.propose(nav, t, 'tcn')).toBe(false) // no station
    nav.gps.search = 50
    expect(N.propose(nav, t, 'gps')).toBe(false)
    nav.gps.search = 0
    nav.ins.knob = 'ifa'
    run(nav, t, 1)
    expect(N.updatable(nav)).toBe(false)
    expect(N.propose(nav, { ...t, tacan }, 'tcn')).toBe(false)
  })
  it('a GPS update takes the GPS position', () => {
    const { nav, t } = flying()
    nav.ins.error = { x: 500, z: 500 }
    expect(N.propose(nav, t, 'gps')).toBe(true)
    N.accept(nav)
    expect(nav.ins.error.x).toBeCloseTo(nav.gps.error.x, 6)
    expect(nav.ins.error.z).toBeCloseTo(nav.gps.error.z, 6)
  })
  it('a designation update takes the overflown waypoint for the aircraft position', () => {
    const { nav, t } = flying({ x: 5000, z: 5000 })
    nav.waypoints[3] = point(5000, 5000)
    nav.current = 3
    nav.ins.error = { x: -800, z: 600 }
    nav.updating = 'dsg'
    expect(N.propose(nav, t, 'dsg', nav.waypoints[3])).toBe(true)
    expect((N.reading(nav) as N.Leg).range).toBeCloseTo(1000, 6)
    N.accept(nav)
    expect(size(nav.ins.error)).toBeCloseTo(0, 6)
    expect(nav.updating).toBe('')
  })
  it('an AUTO update takes the waypoint at once and selects the next', () => {
    const { nav, t } = flying({ x: 5000, z: 5000 })
    nav.waypoints[3] = point(5000, 5000)
    nav.waypoints[4] = point(9000, 5000)
    nav.current = 3
    nav.ins.error = { x: -800, z: 600 }
    expect(N.overhead(nav, t)).toBe(false) // AUTO not selected
    nav.updating = 'auto'
    expect(N.overhead(nav, t)).toBe(true)
    expect(size(nav.ins.error)).toBeCloseTo(0, 6)
    expect(nav.current).toBe(4)
    expect(nav.update).toBeNull()
    expect(nav.updating).toBe('')
  })
  it('a MAP update takes the map slew for the error', () => {
    const { nav } = flying()
    nav.ins.error = { x: 700, z: -200 }
    nav.slew = { x: 700, z: -200 }
    expect(N.slewed(nav)).toBe(false)
    nav.updating = 'map'
    expect(N.slewed(nav)).toBe(true)
    N.accept(nav)
    expect(size(nav.ins.error)).toBeCloseTo(0, 6)
    expect(nav.slew).toEqual({ x: 0, z: 0 })
  })
  it('goes to the air data position when that is the one kept', () => {
    const { nav, t } = flying()
    nav.ins.knob = 'gyro'
    nav.gps.search = 5000
    run(nav, t, 1)
    nav.adc.error = { x: 900, z: 0 }
    nav.bias = 0
    N.propose(nav, { ...t, tacan }, 'tcn')
    N.accept(nav)
    expect(size(nav.adc.error)).toBeCloseTo(0, 6)
  })
})

describe('waypoints and marks', () => {
  it('steps through the 60 waypoints, then the marks there are', () => {
    const nav = N.fresh(1)
    N.advance(nav, -1)
    expect(nav.current).toBe(59)
    N.advance(nav, 1)
    expect(nav.current).toBe(0)
    nav.marks[2] = point(1, 1)
    nav.current = 59
    N.advance(nav, 1)
    expect(nav.current).toBe(62)
    expect(N.label(nav.current)).toBe('M3')
    expect(N.spot(nav, nav.current)).toMatchObject({ x: 1, z: 1 })
    N.advance(nav, 1)
    expect(nav.current).toBe(0)
    N.advance(nav, -1)
    expect(nav.current).toBe(62)
  })
  it('drops the course line when a new point is selected', () => {
    const nav = N.fresh(1)
    nav.steer = 'wypt'
    N.set(nav, 'course', 90)
    expect(nav.course).toBeCloseTo(90 * D, 9)
    N.advance(nav, 1)
    expect(nav.course).toBeNull()
  })
  it('marks the point overflown at zero elevation, or the designated one, and wraps to MK1', () => {
    const nav = N.fresh(1)
    expect(N.mark(nav, { x: 10, z: 20 })).toBe(0)
    expect(nav.marks[0]).toMatchObject({ x: 10, z: 20, elevation: 0 })
    nav.designation = { x: 70, z: 80, elevation: 300, stage: 'tgt' }
    expect(N.mark(nav, { x: 10, z: 20 })).toBe(1)
    expect(nav.marks[1]).toMatchObject({ x: 70, z: 80, elevation: 300 })
    nav.designation = null
    for (let i = 2; i < 9; i++) N.mark(nav, { x: i, z: 0 })
    expect(nav.mark).toBe(0)
    N.mark(nav, { x: 99, z: 0 })
    expect(nav.marks[0]).toMatchObject({ x: 99 })
    expect(nav.mark).toBe(1)
  })
})

describe('sequences', () => {
  it('takes waypoints once each, in order or after a named one, and not marks', () => {
    const nav = N.fresh(1)
    expect(N.insert(nav, 1)).toBe(true)
    expect(N.insert(nav, 2)).toBe(true)
    expect(N.insert(nav, 7)).toBe(true)
    expect(N.insert(nav, 2)).toBe(false)
    expect(N.insert(nav, 60)).toBe(false)
    expect(N.insert(nav, 4, 1)).toBe(true)
    expect(N.insert(nav, 5, 9)).toBe(false)
    expect(nav.sequences[0]).toEqual([1, 4, 2, 7])
    expect(N.remove(nav, 4)).toBe(true)
    expect(N.remove(nav, 4)).toBe(false)
    expect(nav.sequences[0]).toEqual([1, 2, 7])
  })
  it('holds fifteen, the first giving way to a sixteenth', () => {
    const nav = N.fresh(1)
    for (let i = 0; i < 16; i++) N.insert(nav, i)
    expect(nav.sequences[0]).toHaveLength(15)
    expect(nav.sequences[0][0]).toBe(1)
    expect(nav.sequences[0][14]).toBe(15)
  })
  it('SEQ # goes unboxed, boxed, then the next sequence', () => {
    const nav = N.fresh(1)
    const seen: string[] = []
    for (let i = 0; i < 6; i++) {
      N.cycle(nav)
      seen.push(nav.sequence + 1 + (nav.lines ? 'b' : ''))
    }
    expect(seen).toEqual(['1b', '2', '2b', '3', '3b', '1'])
  })
  it('AUTO needs two waypoints in the sequence, and starts on the first', () => {
    const nav = N.fresh(1)
    N.insert(nav, 5)
    expect(N.automatic(nav)).toBe(false)
    N.insert(nav, 6)
    nav.course = 1
    expect(N.automatic(nav)).toBe(true)
    expect(nav).toMatchObject({ auto: true, steer: 'wypt', current: 5, course: null })
    N.advance(nav, 1)
    expect(nav.current).toBe(6)
    N.advance(nav, 1)
    expect(nav.current).toBe(5) // the arrows stay within the sequence
    expect(N.automatic(nav)).toBe(true)
    expect(nav.auto).toBe(false)
  })
  it('moves on inside 5 nm with the waypoint behind, and drops AUTO after the last', () => {
    const nav = N.fresh(1)
    nav.waypoints[5] = point(0, 0)
    nav.waypoints[6] = point(0, -40000)
    N.insert(nav, 5)
    N.insert(nav, 6)
    N.automatic(nav)
    expect(N.sequential(nav, { x: 0, z: 3000 }, 0)).toBe(false) // close, but still ahead
    expect(N.sequential(nav, { x: 0, z: -12000 }, 0)).toBe(false) // behind, but past 5 nm
    nav.course = 2
    expect(N.sequential(nav, { x: 100, z: -3000 }, 0)).toBe(true)
    expect(nav).toMatchObject({ current: 6, auto: true, course: null })
    expect(N.sequential(nav, { x: 100, z: -41000 }, 0)).toBe(true)
    expect(nav).toMatchObject({ current: 6, auto: false })
    expect(N.sequential(nav, { x: 100, z: -41000 }, 0)).toBe(false)
  })
})

describe('steering', () => {
  it('finds the bearing and range to a point, across the wrap', () => {
    const nav = N.fresh(1)
    expect(N.leg(nav, { x: 0, z: 0 }, { x: 1000, z: 0 }).bearing / D).toBeCloseTo(90, 9)
    expect(N.leg(nav, { x: 0, z: 0 }, { x: 0, z: 1000 }).bearing / D).toBeCloseTo(180, 9)
    expect(N.leg(nav, { x: 0, z: 0 }, { x: -300, z: -400 }).range).toBeCloseTo(500, 9)
    nav.span = 100000
    expect(N.leg(nav, { x: 49000, z: 0 }, { x: -49000, z: 0 })).toMatchObject({ range: 2000 })
    expect(N.leg(nav, { x: 49000, z: 0 }, { x: -49000, z: 0 }).bearing / D).toBeCloseTo(90, 9)
  })
  it('steers to the waypoint, an offset aimpoint itself, or the designated target', () => {
    const nav = N.fresh(1)
    expect(N.goal(nav)).toBeNull()
    nav.waypoints[0] = point(100, 200, { elevation: 30 })
    expect(N.goal(nav)).toEqual({ x: 100, z: 200, elevation: 30, kind: 'wypt' })
    nav.waypoints[0] = point(100, 200, { offset: { range: 1000, bearing: 90 * D, elevation: 50 } })
    expect(N.goal(nav)).toMatchObject({ x: 100, z: 200, kind: 'oap' })
    expect(N.aim(nav.waypoints[0] as N.Waypoint).x).toBeCloseTo(1100, 6)
    nav.designation = { x: 7, z: 8, elevation: 9, stage: 'tgt' }
    expect(N.goal(nav)).toEqual({ x: 7, z: 8, elevation: 9, kind: 'tgt' })
  })
  it('places the command heading marker: the error to 5°, 30° at the scale end', () => {
    expect(N.command(3)).toBe(3)
    expect(N.command(-5)).toBe(-5)
    expect(N.command(17.5)).toBeCloseTo(10, 9)
    expect(N.command(30)).toBe(15)
    expect(N.command(-120)).toBe(-15)
  })
  it('measures the turn between directions through north', () => {
    expect(N.turn(350 * D, 10 * D) / D).toBeCloseTo(20, 9)
    expect(N.turn(10 * D, 350 * D) / D).toBeCloseTo(-20, 9)
    expect(Math.abs(N.turn(0, 180 * D) / D)).toBeCloseTo(180, 9)
  })
  it('reads the deviation from a course line and the distance off it', () => {
    expect(N.deviation(90 * D, 94 * D)).toBeCloseTo(4, 9)
    expect(N.deviation(90 * D, 82 * D)).toBeCloseTo(-8, 9)
    expect(N.across({ bearing: 90 * D, range: 10000 }, 60 * D)).toBeCloseTo(5000, 6)
  })
  it('sets the heading marker and, with steering selected, the course line', () => {
    const nav = N.fresh(1)
    N.set(nav, 'heading', -10)
    expect(nav.heading / D).toBeCloseTo(350, 9)
    expect(N.set(nav, 'course', 5)).toBe(false)
    expect(nav.course).toBeNull()
    nav.steer = 'tcn'
    expect(N.set(nav, 'course', 5)).toBe(true)
    N.set(nav, 'course', 5)
    expect(nav.course).toBeCloseTo(10 * D, 9)
    N.advance(nav, 1) // a new point drops the line
    N.set(nav, 'course', 1)
    expect(nav.course).toBeCloseTo(11 * D, 9) // where the switch last left it
  })
})

describe('the groundspeed required', () => {
  const plan = () => {
    const nav = N.fresh(1)
    nav.waypoints[1] = point(0, -100 * NM)
    nav.waypoints[2] = point(0, -160 * NM)
    N.insert(nav, 1)
    N.insert(nav, 2)
    nav.target = 2
    nav.steer = 'wypt'
    return nav
  }
  it('needs a target in a sequence and a time on target', () => {
    const nav = plan()
    expect(N.required(nav, { x: 0, z: 0 }, 0)).toBeNull()
    nav.tot = 3600
    nav.target = null
    expect(N.required(nav, { x: 0, z: 0 }, 0)).toBeNull()
  })
  it('direct to the target is the distance over the time left', () => {
    const nav = plan()
    nav.tot = 1200
    nav.current = 2
    expect(N.required(nav, { x: 0, z: 0 }, 0)).toBeCloseTo(480, 6)
  })
  it('with AUTO flies the final leg at the groundspeed entered when there is time', () => {
    const nav = plan()
    nav.tot = 1800
    N.automatic(nav)
    expect(N.required(nav, { x: 0, z: 0 }, 0)).toBeCloseTo(320, 6) // 160 nm in half an hour
    nav.speed = 360 // the last 60 nm take ten minutes, leaving 100 nm for twenty
    expect(N.required(nav, { x: 0, z: 0 }, 0)).toBeCloseTo(300, 6)
    nav.tot = 500 // no time for that: the entry is ignored
    expect(N.required(nav, { x: 0, z: 0 }, 0)).toBe(999)
    nav.tot = 900
    nav.speed = 200
    expect(N.required(nav, { x: 0, z: 0 }, 0)).toBeCloseTo(640, 6)
  })
  it('is 999 once the time has passed', () => {
    const nav = plan()
    nav.current = 2
    nav.tot = 100
    expect(N.required(nav, { x: 0, z: 0 }, 200)).toBe(999)
  })
})

describe('designation', () => {
  it('NAVDSG makes the waypoint the target, once', () => {
    const nav = N.fresh(1)
    expect(N.designate(nav)).toBe(false)
    nav.waypoints[0] = point(100, 200, { elevation: 40 })
    nav.auto = true
    expect(N.designate(nav)).toBe(true)
    expect(nav.designation).toEqual({ x: 100, z: 200, elevation: 40, stage: 'tgt' })
    expect(nav.auto).toBe(false)
    expect(N.designate(nav)).toBe(false)
    expect(N.undesignate(nav)).toBe(true)
    expect(N.undesignate(nav)).toBe(false)
  })
  it('an offset aimpoint waits for O/S to add its offset', () => {
    const nav = N.fresh(1)
    nav.waypoints[0] = point(100, 200, { offset: { range: 500, bearing: 180 * D, elevation: 60 } })
    N.designate(nav)
    expect(nav.designation).toMatchObject({ x: 100, z: 200, stage: 'oap' })
    expect(N.designate(nav)).toBe(true)
    expect(nav.designation).toMatchObject({ stage: 'tgt', elevation: 60 })
    expect((nav.designation as N.Designation).z).toBeCloseTo(700, 6)
  })
  it('an overfly designation takes the present position, an offset added at once', () => {
    const nav = N.fresh(1)
    expect(N.overfly(nav, { x: 1, z: 2 })).toBe(false)
    nav.waypoints[0] = point(100, 200, { elevation: 40 })
    expect(N.overfly(nav, { x: 130, z: 190 })).toBe(true)
    expect(nav.designation).toEqual({ x: 130, z: 190, elevation: 40, stage: 'tgt' })
    nav.waypoints[0] = point(100, 200, { offset: { range: 500, bearing: 90 * D, elevation: 60 } })
    N.overfly(nav, { x: 130, z: 190 })
    expect((nav.designation as N.Designation).x).toBeCloseTo(630, 6)
    expect(nav.designation).toMatchObject({ elevation: 60, stage: 'tgt' })
  })
})

describe('the mission data load', () => {
  const mission: N.Mission = {
    identifier: 'MIDWAY',
    waypoints: [{ index: 1, point: { name: 'SHIP', x: 5, z: 6, elevation: 0 } }, { index: 2, point: { name: 'PMDY', x: 7, z: 8, elevation: 4 } }],
    stations: [{ channel: 71, band: 'X', x: 5, z: 6, elevation: 20, name: 'STL' }],
    points: [{ name: 'PMDY', x: 7, z: 8, elevation: 4 }, { name: 'ALPHA', x: 1, z: 1, elevation: 0 }],
  }
  it('loads every file at power-up', () => {
    const nav = N.fresh(1)
    N.load(nav, mission)
    expect(nav.memory).toMatchObject({ identifier: 'MIDWAY', files: [...N.FILES], loaded: [...N.FILES] })
    expect(nav.waypoints[1]).toMatchObject({ x: 5, z: 6, name: 'SHIP' })
    expect(nav.waypoints[2]).toMatchObject({ x: 7, z: 8, elevation: 4 })
    expect(nav.waypoints[3]).toBeNull()
    expect(nav.stations).toHaveLength(1)
    expect(nav.points.map((p) => p.name)).toEqual(['ALPHA', 'PMDY']) // in alphanumeric order
  })
  it('loads one file alone', () => {
    const nav = N.fresh(1)
    N.load(nav, mission, 'TCN')
    expect(nav.stations).toHaveLength(1)
    expect(nav.waypoints[1]).toBeNull()
    expect(nav.memory.loaded).toEqual(['TCN'])
    nav.waypoints[1] = point(999, 999)
    N.load(nav, mission, 'WYPT')
    expect(nav.waypoints[1]).toMatchObject({ x: 5 })
  })
  it('transfers a GPS point into a waypoint with its ID', () => {
    const nav = N.fresh(1)
    N.load(nav, mission)
    expect(N.transfer(nav, 'ALPHA', 9)).toBe(true)
    expect(nav.waypoints[9]).toEqual({ x: 1, z: 1, elevation: 0, name: 'ALPHA', offset: null })
    expect(N.transfer(nav, 'NOWHERE', 9)).toBe(false)
    expect(N.transfer(nav, 'ALPHA', 60)).toBe(false)
  })
})

describe('latitude and longitude', () => {
  it('writes degrees, minutes and seconds, or thousandths of minutes', () => {
    expect(N.angle(28.2072, 'NS', false)).toBe('N  28°12\'26"')
    expect(N.angle(-177.3735, 'EW', false)).toBe('W 177°22\'25"')
    expect(N.angle(28.2072, 'NS', true)).toBe("N  28°12.432'")
    expect(N.angle(-5.5, 'NS', false)).toBe('S  05°30\'00"')
    expect(N.angle(9.99999, 'EW', false)).toBe('E 010°00\'00"') // the seconds carry
    expect(N.angle(9.9999999, 'EW', true)).toBe("E 010°00.000'")
  })
  it('reads a keypad entry', () => {
    expect(N.entered('N', '281226', false)).toBeCloseTo(28 + 12 / 60 + 26 / 3600, 9)
    expect(N.entered('W', '1772225', false)).toBeCloseTo(-(177 + 22 / 60 + 25 / 3600), 9)
    expect(N.entered('S', '53000', false)).toBeCloseTo(-5.5, 9)
    expect(N.entered('N', '2812432', true)).toBeCloseTo(28 + 12.432 / 60, 9)
    expect(N.entered('N', '286026', false)).toBeNull() // 60 minutes
    expect(N.entered('N', '281260', false)).toBeNull() // 60 seconds
    expect(N.entered('N', '910000', false)).toBeNull()
    expect(N.entered('E', '1810000', false)).toBeNull()
    expect(N.entered('N', '1281226', false)).toBeNull() // too long for a latitude
    expect(N.entered('N', '1226', false)).toBeNull() // no degrees
    expect(N.entered('X', '281226', false)).toBeNull()
    expect(N.entered('N', '', false)).toBeNull()
  })
  it('goes to the world and back', () => {
    const fix = N.world(28.3, -177.5)
    const back = N.coordinates(fix)
    expect(back.latitude).toBeCloseTo(28.3, 9)
    expect(back.longitude).toBeCloseTo(-177.5, 9)
    expect(N.coordinates({ x: 0, z: 0 }).latitude).toBeCloseTo(28.2072, 9)
    expect(N.coordinates({ x: 0, z: 0 }).longitude).toBeCloseTo(-177.3735, 9)
    expect(N.coordinates({ x: -400000, z: 0 }).longitude).toBeGreaterThan(170) // west across the date line
  })
  it('gives directions true, or magnetic with HDG MAG', () => {
    const nav = N.fresh(1)
    nav.variation = 10 * D
    expect(N.shown(nav, 5 * D)).toBe(5 * D)
    nav.magnetic = true
    expect(N.shown(nav, 5 * D) / D).toBeCloseTo(355, 9)
  })
})

describe('a manual carrier alignment given the wrong ship speed', () => {
  it('leaves the error in its velocities', () => {
    const still = cold()
    still.ins.knob = 'cv'
    run(still, truth(), 1)
    N.manual(still)
    run(still, truth(), 905)
    still.ins.knob = 'nav'
    run(still, truth(), 1)
    const moved = cold()
    moved.ins.knob = 'cv'
    run(moved, truth(), 1)
    N.manual(moved)
    N.carrier(moved, 90 * D, 10)
    run(moved, truth(), 905)
    moved.ins.knob = 'nav'
    run(moved, truth(), 1)
    expect(size(still.ins.drift)).toBeCloseTo(N.DRIFT, 6)
    expect(moved.ins.drift.x - still.ins.drift.x).toBeCloseTo(10, 6)
  })
})

describe('the cruise search', () => {
  // a jet whose flow has its least per second at Mach 0.61 and its least per metre faster, improving with altitude to 12 km
  const sound = 300
  const lookup: N.Lookup = (altitude, mach) => {
    if (mach < 0.35 || altitude > 14000) return null
    const height = 1 + ((altitude - 12000) / 12000) ** 2
    return { flow: (0.5 + 4 * (mach - 0.61) ** 2) * height, speed: mach * sound }
  }
  it('finds the best Mach for range and for endurance at an altitude, to the hundredth', () => {
    const found = N.best(lookup, 6000)
    expect(found.endurance?.mach).toBeCloseTo(0.61, 9) // between the twentieths searched first
    expect(found.range?.mach).toBeGreaterThan(0.695) // flow over Mach is least at 0.705
    expect(found.range?.mach).toBeLessThan(0.715)
    expect(found.range?.altitude).toBe(6000)
  })
  it('counts the wind along the track in the range, not the endurance', () => {
    const calm = N.best(lookup, 6000)
    const head = N.best(lookup, 6000, -60)
    expect(head.range?.mach).toBeGreaterThan(calm.range?.mach as number) // into wind it pays to fly faster
    expect(head.endurance?.mach).toBeCloseTo(0.61, 9)
  })
  it('makes about twenty looks at an altitude', () => {
    let looks = 0
    N.best((altitude, mach) => (looks++, lookup(altitude, mach)), 6000)
    expect(looks).toBeLessThanOrEqual(21)
    expect(looks).toBeGreaterThan(12)
  })
  it('finds nothing where the jet cannot cruise', () => {
    expect(N.best(lookup, 15000)).toEqual({ range: null, endurance: null })
    expect(N.best(() => null, 6000)).toEqual({ range: null, endurance: null })
  })
  it('surveys the altitudes a few at a time for the optimum', () => {
    const s = N.survey()
    N.sweep(s, lookup, 10)
    expect(s.done).toBe(false)
    expect(s.altitude).toBeCloseTo(10000 * 0.3048, 6)
    for (let i = 0; i < 20 && !s.done; i++) N.sweep(s, lookup, 5)
    expect(s.done).toBe(true)
    expect(s.range?.altitude).toBeCloseTo(39000 * 0.3048, 6) // the thousand-foot layer nearest 12 km
    expect(s.endurance?.altitude).toBeCloseTo(39000 * 0.3048, 6)
    expect(s.endurance?.mach).toBeCloseTo(0.61, 9)
    const before = s.altitude
    N.sweep(s, lookup, 5)
    expect(s.altitude).toBe(before) // done: it climbs no further
  })
})

describe('grid coordinates', () => {
  // the eastings and northings are proj's, +proj=utm +ellps=WGS84
  it('projects into the UTM zone, band and metres', () => {
    for (const [latitude, longitude, zone, band, easting, northing] of [[21.31, -157.86, 4, 'Q', 618238.268, 2356884.33], [28.2072, -177.3735, 1, 'R', 463346.877, 3120211.791], [0, -177, 1, 'N', 500000, 0],
      [-33.8688, 151.2093, 56, 'H', 334368.634, 6250948.345], [40.6892, -74.0445, 18, 'T', 580735.871, 4504695.165]] as [number, number, number, string, number, number][]) {
      const u = N.utm(latitude, longitude) as N.Utm
      expect(u.zone).toBe(zone); expect(u.band).toBe(band)
      expect(u.easting).toBeCloseTo(easting, 1); expect(u.northing).toBeCloseTo(northing, 1)
    }
    expect(N.utm(85, 0)).toBeNull(); expect(N.utm(-81, 0)).toBeNull()
  })
  it('comes back from the zone to degrees', () => {
    const back = N.geodetic(4, 618238.268, 2356884.33, false)
    expect(back.latitude).toBeCloseTo(21.31, 6); expect(back.longitude).toBeCloseTo(-157.86, 6)
    const south = N.geodetic(56, 334368.634, 6250948.345, true)
    expect(south.latitude).toBeCloseTo(-33.8688, 6); expect(south.longitude).toBeCloseTo(151.2093, 6)
  })
  it('names the 100 km square and writes the grid to 100 m, or a metre with PRECISE, cut short', () => {
    expect(N.square(21.31, -157.86)).toEqual({ zone: 4, band: 'Q', id: 'FJ' }) // Honolulu's square
    expect(N.grid(21.31, -157.86, false)).toBe('4QFJ182568')
    expect(N.grid(21.31, -157.86, true)).toBe('4QFJ1823856884')
    expect(N.grid(28.2072, -177.3735, false)).toBe('1RDM633202')
    expect(N.grid(-33.8688, 151.2093, true)).toBe('56HLH3436850948')
    expect(N.grid(40.6892, -74.0445, true)).toBe('18TWL8073504695')
    expect(N.grid(86, 0, false)).toBe('')
  })
  it('reads a keyed easting and northing back to its place, leading zeros optional', () => {
    const at = N.ungrid({ zone: 4, band: 'Q', id: 'FJ' }, '1823856884', true) as { latitude: number; longitude: number }
    expect(at.latitude).toBeCloseTo(21.31, 4); expect(at.longitude).toBeCloseTo(-157.86, 4)
    const coarse = N.ungrid({ zone: 4, band: 'Q', id: 'FJ' }, '182568', false) as { latitude: number; longitude: number }
    expect(N.grid(coarse.latitude, coarse.longitude, false)).toBe('4QFJ182568') // the middle of the square keyed reads back as keyed
    { const u = N.utm(coarse.latitude, coarse.longitude) as N.Utm; expect(u.easting).toBeCloseTo(618250, 2); expect(u.northing).toBeCloseTo(2356850, 2) }
    const south = N.ungrid({ zone: 56, band: 'H', id: 'LH' }, '3436850948', true) as { latitude: number; longitude: number }
    expect(south.latitude).toBeCloseTo(-33.8688, 4); expect(south.longitude).toBeCloseTo(151.2093, 4)
    const short = N.ungrid({ zone: 1, band: 'R', id: 'DM' }, '5007', false) as { latitude: number; longitude: number } // 005 east, 007 north
    expect(N.grid(short.latitude, short.longitude, false)).toBe('1RDM005007')
    expect(N.ungrid({ zone: 4, band: 'Q', id: 'FJ' }, '0010020', false)).toBeNull() // too many digits without PRECISE
    expect(N.ungrid({ zone: 4, band: 'Q', id: 'FJ' }, '0010020', true)).not.toBeNull()
    expect(N.ungrid({ zone: 4, band: 'Q', id: 'FJ' }, '', false)).toBeNull() // nothing keyed is no grid
    expect(N.ungrid({ zone: 4, band: 'Q', id: 'ZJ' }, '123456', false)).toBeNull() // no such column in the zone
    const below = N.ungrid({ zone: 4, band: 'M', id: 'FA' }, '123456', false) as { latitude: number } // the rows repeat every 2,000 km down the zone: the band picks which
    expect(below.latitude).toBeLessThan(0); expect(below.latitude).toBeGreaterThan(-8)
    expect(N.ungrid({ zone: 4, band: 'Q', id: 'FA' }, '123456', false)).toBeNull() // and band Q holds no row A
  })
  it('lays out the square identification grid about a position, and shifts it a grid at a time', () => {
    const rows = N.sig(28.2072, -177.3735, { east: 0, north: 0 })
    expect(rows.length).toBe(5); expect(rows[2][2]).toEqual({ zone: 1, band: 'R', id: 'DM' })
    expect(rows[1][2]?.id).toBe('DN'); expect(rows[3][2]?.id).toBe('DL') // north above, south below
    expect(rows[2][3]?.id).toBe('EM'); expect(rows[2][1]?.id).toBe('CM')
    expect(rows[2][0]).toEqual({ zone: 1, band: 'R', id: 'BM' })
    expect(N.sig(28.2072, -177.3735, { east: -1, north: 0 })[2][2]?.zone).toBe(60) // a grid west, across the zone's edge at the date line
    const north = N.sig(28.2072, -177.3735, { east: 0, north: 1 })
    expect(north[2][2]?.id).toBe('DS'); expect(north[4][2]?.id).toBe('DQ') // five squares on: M, N, P, Q, R, S
    expect(N.sig(86, 0, { east: 0, north: 0 })).toEqual([])
  })
  it('builds a shifted grid about its own centre, in that centre\'s zone', () => {
    const west = N.sig(28.2072, -177.3735, { east: -1, north: 0 }) // 500 km west: proj puts the centre at 553,243 E 3,108,267 N in zone 60
    expect(west[2][2]).toEqual({ zone: 60, band: 'R', id: 'WS' })
    for (const row of west) expect(row.map((q) => q && q.zone + q.id[0])).toEqual(['60U', '60V', '60W', '60X', '60Y']) // square columns, not the reference zone's slanting across them
    expect(west.map((row) => row[2]?.id[1])).toEqual(['U', 'T', 'S', 'R', 'Q'])
    const at = N.pin(28.2072, -177.3735, { east: -1, north: 0 }, { latitude: 28, longitude: 178 }) as { east: number; north: number } // 598,325 E 3,097,605 N there
    expect(at.east).toBeCloseTo(2.98325, 4); expect(at.north).toBeCloseTo(1.97605, 4)
  })
  it('blanks a row past N84 or S80, and has no grid where every row is', () => {
    const rows = N.sig(83.5, 3, { east: 0, north: 0 })
    expect(rows[2][2]).toEqual({ zone: 31, band: 'X', id: 'EN' }) // proj: 500,000 E 9,272,276 N
    expect(rows[1].every((q) => q === null)).toBe(true); expect(rows[0].every((q) => q === null)).toBe(true) // 100 km north is past N84
    expect(rows[3].some((q) => q !== null)).toBe(true)
    expect(N.sig(83.5, 3, { east: 0, north: 1 })).toEqual([]); expect(N.sig(83.5, 3, { east: 0, north: -1 }).length).toBe(5)
    expect(N.sig(-79.5, 3, { east: 0, north: -1 })).toEqual([])
    const south = N.sig(-79.2, 3, { east: 0, north: 0 }) // 100 km south is past S80 on the zone's meridian, though not 200 km off it: the whole row goes
    expect(south[3].every((q) => q === null)).toBe(true); expect(south[2].every((q) => q !== null)).toBe(true)
  })
  it('pins a place on the grid in squares from its left and bottom edges, and nothing off it', () => {
    const at = N.pin(28.2072, -177.3735, { east: 0, north: 0 }, { latitude: 28.2072, longitude: -177.3735 }) as { east: number; north: number }
    expect(at.east).toBeCloseTo(2.63346877, 6); expect(at.north).toBeCloseTo(2.20211791, 6) // 463,346.877 E 3,120,211.791 N: 63 km into the centre square, 20 km up it
    const north = N.pin(28.2072, -177.3735, { east: 0, north: 0 }, { latitude: 28.3735672, longitude: -177.3735 }) as { east: number; north: number }
    expect(north.north).toBeCloseTo(2.38642, 4)
    expect(N.pin(28.2072, -177.3735, { east: 1, north: 0 }, { latitude: 28.2072, longitude: -177.3735 })).toBeNull() // a grid east: the place is off its left edge
    expect(N.pin(28.2072, -177.3735, { east: 0, north: 0 }, { latitude: 40, longitude: -177.3735 })).toBeNull()
    const across = N.pin(28.2072, -179.4, { east: 0, north: 0 }, { latitude: 28.2072, longitude: 179.9 }) as { east: number; north: number } // in zone 60, pinned on zone 1's grid: proj puts it at 195,702 E 3,124,049 N there
    expect(across.east).toBeCloseTo(1.957, 3); expect(across.north).toBeCloseTo(2.2405, 3)
    const shifted = N.pin(28.2072, -177.3735, { east: 0, north: -1 }, { latitude: 28.2072 - 4.5, longitude: -177.3735 }) as { east: number; north: number }
    expect(shifted.north).toBeGreaterThan(1.9); expect(shifted.north).toBeLessThan(2.3) // some 500 km south, back near the middle of the grid south
  })
})

describe('a direction as the displays read it', () => {
  it('takes another variation in place of the aircraft\'s, for a TACAN station\'s own', () => {
    const nav = N.fresh(1); nav.variation = 7 * D; nav.magnetic = true
    expect(N.shown(nav, 90 * D) / D).toBeCloseTo(83, 9); expect(N.shown(nav, 90 * D, 10 * D) / D).toBeCloseTo(80, 9)
    nav.magnetic = false; expect(N.shown(nav, 90 * D, 10 * D) / D).toBeCloseTo(90, 9)
  })
})

describe('units and PRECISE', () => {
  it('writes and reads lengths in feet, metres, miles and yards, an offset inside its limit', () => {
    expect(N.measure(304.8, 'feet')).toBe('1000 FT'); expect(N.measure(304.8, 'mtrs')).toBe('305 M'); expect(N.measure(18520, 'nm')).toBe('10 NM'); expect(N.measure(914.4, 'yard')).toBe('1000 YD')
    expect(N.taken(1000, 'feet', false)).toBeCloseTo(304.8, 9); expect(N.taken(10, 'nm', true)).toBe(18520)
    expect(N.taken(400001, 'feet', true)).toBeNull(); expect(N.taken(400001, 'feet', false)).not.toBeNull()
    expect(N.taken(67, 'nm', true)).toBeNull(); expect(N.taken(122001, 'mtrs', true)).toBeNull(); expect(N.taken(133001, 'yard', true)).toBeNull()
  })
  it('writes the hundredths of a second with PRECISE', () => {
    expect(N.angle(35 + 41 / 60 + 33.27 / 3600, 'NS', false, true)).toBe('N  35°41\'33.27"')
    expect(N.angle(-(117 + 41 / 60 + 7.44 / 3600), 'EW', false, true)).toBe('W 117°41\'07.44"')
    expect(N.angle(28.2072, 'NS', true, true)).toBe("N  28°12.432'") // decimal minutes are not made precise
  })
})

// Coupled steering (#100, NATOPS 2.9.2.6, 24.2.8, 24.2.9.3, 24.2.9.5, 24.4.5.2): what the steering boxed on the HSI
// gives the autopilot to fly, and the lead turn of a coupled sequence. The jet is at the origin unless said, x
// east and z south; tracks and courses in radians, true.
describe('coupled steering', () => {
  const suite = (plan: (nav: N.Navigation) => void = () => {}) => { const nav = N.fresh(1); N.ready(nav, { x: 0, z: 0 }); plan(nav); return nav }
  const here = { x: 0, z: 0 }
  const degrees = (c: N.Coupling | null) => Math.round(((c as N.Coupling).track / D) * 100) / 100
  it('starts with the bank limit at NAV', () => {
    expect(N.fresh(1).limit).toBe('nav')
  })
  it('gives nothing with no steering boxed, no point to fly to, or a target designated', () => {
    const nav = suite((n) => { n.waypoints[1] = point(4000, -4000); n.current = 1 })
    expect(N.coupling(nav, here, 0, 200, null)).toBeNull() // nothing boxed
    nav.steer = 'wypt'
    expect(N.coupling(nav, here, 0, 200, null)).not.toBeNull()
    nav.designation = { x: 9000, z: 0, elevation: 0, stage: 'tgt' }
    expect(N.coupling(nav, here, 0, 200, null)).toBeNull() // waypoint steering does not couple with a ground point designated
    nav.designation = null; nav.current = 5
    expect(N.coupling(nav, here, 0, 200, null)).toBeNull()
    nav.steer = 'tcn'
    expect(N.coupling(nav, here, 0, 200, null)).toBeNull() // no station received
  })
  it('flies straight at a waypoint with no course line, and says when it has been reached', () => {
    const nav = suite((n) => { n.waypoints[1] = point(4000, -4000); n.current = 1; n.steer = 'wypt' })
    expect(N.coupling(nav, here, 0, 200, null)).toEqual({ track: 45 * D, label: 'WYPT', passed: false })
    const close = { x: 4000, z: -4000 + 900 } // the point 900 m ahead, flying north
    expect((N.coupling(nav, close, 0, 200, null) as N.Coupling).passed).toBe(false)
    expect((N.coupling(nav, { x: 4000, z: -4000 - 900 }, 0, 200, null) as N.Coupling).passed).toBe(true) // 900 m behind
    expect((N.coupling(nav, { x: 4000, z: -4000 - 2000 }, 0, 200, null) as N.Coupling).passed).toBe(false) // behind, but not inside a mile of it
    expect((N.coupling(nav, { x: 4000 + 900, z: -4000 }, 0, 200, null) as N.Coupling).passed).toBe(false) // abeam on the left wing: exactly 90° is not yet behind
  })
  it('cuts at a course line from either side, 45° at most, and less as the line nears', () => {
    const nav = suite((n) => { n.waypoints[1] = point(0, -30000); n.current = 1; n.steer = 'wypt'; n.course = 0 })
    const from = (x: number, speed = 100) => degrees(N.coupling(nav, { x, z: 0 }, 0, speed, null))
    expect(from(0)).toBe(0)
    expect(from(-20000)).toBe(45); expect(from(20000)).toBe(315) // west of the line: fly north-east
    expect(from(-1500)).toBe(45); expect(from(-750)).toBeCloseTo(Math.atan(0.5) / D, 2) // slow, the lead is its least: 1,500 m
    expect(from(-150)).toBeGreaterThan(0); expect(from(-150)).toBeLessThan(from(-750))
  })
  it('lengthens the lead with the square of the speed, as the room to turn grows', () => {
    const nav = suite((n) => { n.waypoints[1] = point(0, -30000); n.current = 1; n.steer = 'wypt'; n.course = 0 })
    const cut = (speed: number) => (N.coupling(nav, { x: -1000, z: 0 }, 0, speed, null) as N.Coupling).track
    expect(cut(200)).toBeCloseTo(Math.atan(1000 / ((1.2 * 200 * 200) / 9.80665)), 9)
    expect(cut(240)).toBeCloseTo(Math.atan(1000 / ((1.2 * 240 * 240) / 9.80665)), 9)
    expect(cut(100)).toBeCloseTo(Math.atan(1000 / 1500), 9) // under 1,500 m of lead: the least
  })
  it('flies on along the line past the point, and never calls it reached', () => {
    const nav = suite((n) => { n.waypoints[1] = point(0, -30000); n.current = 1; n.steer = 'wypt'; n.course = 0 })
    const past = N.coupling(nav, { x: 300, z: -40000 }, 0, 100, null) as N.Coupling
    expect(past.passed).toBe(false)
    expect(past.track).toBeCloseTo(2 * Math.PI - Math.atan(300 / 1500), 9) // east of the outbound line: back west onto it
  })
  it('takes the TACAN station by the bearing and range received, with its course line', () => {
    const nav = suite((n) => { n.steer = 'tcn' })
    expect(N.coupling(nav, here, 0, 100, { bearing: 80 * D, range: 20000 })).toEqual({ track: 80 * D, label: 'TCN', passed: false })
    nav.course = 90 * D
    const c = N.coupling(nav, here, 0, 100, { bearing: 88 * D, range: 20000 }) as N.Coupling
    expect(c.track).toBeCloseTo(90 * D - Math.atan((Math.sin(2 * D) * 20000) / 1500), 9); expect(c.label).toBe('TCN') // the line lies 700 m to the left: north of east
    nav.designation = { x: 1, z: 1, elevation: 0, stage: 'tgt' }
    expect(N.coupling(nav, here, 0, 100, { bearing: 80 * D, range: 20000 })).not.toBeNull() // a designation is the waypoint steering's bar
  })
  it('names a sequence by its number, and flies the course from the waypoint before', () => {
    const nav = suite((n) => { n.waypoints[1] = point(0, -10000); n.waypoints[2] = point(20000, -10000); n.sequences[1] = [1, 2]; n.sequence = 1; n.current = 1; n.steer = 'wypt'; n.auto = true })
    expect(N.coupling(nav, here, 0, 100, null)).toEqual({ track: 0, label: 'SEQ2', passed: false }) // the first is flown direct
    nav.current = 2
    const c = N.coupling(nav, { x: 5000, z: -9000 }, 0, 100, null) as N.Coupling
    expect(c.label).toBe('SEQ2'); expect(c.passed).toBe(false)
    expect(c.track).toBeCloseTo(90 * D - Math.atan(1000 / 1500), 9) // a kilometre south of the leg from 1 to 2: a cut north of east
    nav.course = 45 * D
    expect((N.coupling(nav, { x: 20000, z: -10000 + 3000 }, 0, 100, null) as N.Coupling).track).toBeCloseTo(0, 9) // a course line selected is flown in the leg's place: 045 through the point, cut at 45° from the south
  })
  it('turns ahead of a coupled sequence\'s waypoint, where a turn of the bank allowed rolls out on the next course', () => {
    const plan = (n: N.Navigation) => { n.waypoints[1] = point(0, -20000); n.waypoints[2] = point(20000, -20000); n.waypoints[3] = point(20000, -40000); n.sequences[0] = [1, 2, 3]; n.current = 1; n.steer = 'wypt'; n.auto = true }
    const radius = (200 * 200) / (9.80665 * Math.tan(30 * D)), lead = radius + 200 * 4 // a 90° turn: its radius, and four seconds to roll into it
    const short = suite(plan), there = suite((n) => { plan(n); n.course = 1 }) // a course line selected through the waypoint goes with it
    expect(N.anticipate(short, { x: 0, z: -20000 + lead + 50 }, 200, 30 * D)).toBe(false); expect(short.current).toBe(1)
    expect(N.anticipate(there, { x: 0, z: -20000 + lead - 50 }, 200, 30 * D)).toBe(true); expect([there.current, there.course]).toEqual([2, null])
    const steep = suite(plan) // TAC's 60° turns far tighter
    expect(N.anticipate(steep, { x: 0, z: -20000 + 4000 }, 200, 60 * D)).toBe(false); expect(N.anticipate(steep, { x: 0, z: -20000 + 3000 }, 200, 60 * D)).toBe(true)
  })
  it('turns no earlier than the 5 nm at which the sequence moves on by itself, however sharp the corner', () => {
    const nav = suite((n) => { n.waypoints[1] = point(0, -20000); n.waypoints[2] = point(100, 20000); n.sequences[0] = [1, 2]; n.current = 1; n.steer = 'wypt'; n.auto = true })
    expect(N.anticipate(nav, { x: 0, z: -20000 + 5.1 * NM }, 200, 30 * D)).toBe(false)
    expect(N.anticipate(nav, { x: 0, z: -20000 + 4.9 * NM }, 200, 30 * D)).toBe(true)
  })
  it('flies over a waypoint with OVFLY boxed, flies to the last, and leaves uncoupled steering alone', () => {
    const plan = (n: N.Navigation) => { n.waypoints[1] = point(0, -20000); n.waypoints[2] = point(20000, -20000); n.sequences[0] = [1, 2]; n.current = 1; n.steer = 'wypt'; n.auto = true }
    const near = { x: 0, z: -20000 + 2000 }
    const over = suite((n) => { plan(n); (n.waypoints[1] as N.Waypoint).overfly = true })
    expect(N.anticipate(over, near, 200, 30 * D)).toBe(false); expect(over.current).toBe(1)
    const last = suite((n) => { plan(n); n.current = 2 })
    expect(N.anticipate(last, { x: 19000, z: -20000 }, 200, 30 * D)).toBe(false)
    const manual = suite((n) => { plan(n); n.auto = false })
    expect(N.anticipate(manual, near, 200, 30 * D)).toBe(false)
    const station = suite((n) => { plan(n); n.steer = 'tcn' })
    expect(N.anticipate(station, near, 200, 30 * D)).toBe(false)
    const marking = suite((n) => { plan(n); n.updating = 'dsg' }) // an overfly designation in hand holds the sequence (24.2.9.4)
    expect(N.anticipate(marking, near, 200, 30 * D)).toBe(false)
    expect(N.anticipate(suite(plan), near, 200, 30 * D)).toBe(true)
  })
})
