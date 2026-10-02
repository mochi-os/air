// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { describe, expect, it } from 'vitest'
import * as L from './datalink'

// The Link 4 carrier landing mode (#101, NATOPS 24.6.1): the controller's label
// 5 message, the SPN-42's acquisition and its label 6 message, what the
// aircraft's own systems make of them, and what there is to couple to. The
// approach's frame: along the final bearing aft of the touchdown, across it to
// the right, the hook's height above it.
const NM = 1852, FOOT = 0.3048, SLOPE = Math.tan(3.5 * Math.PI / 180)
const astern: L.Picture = {
  time: 0, along: 8 * NM, across: 0, height: 1200 * FOOT, final: 60, altitude: 1200 * FOOT + 20, waved: false,
  link: true, beacon: true, able: true, flaps: true, throttle: true, coupled: '',
}
const at = (over: Partial<L.Picture> = {}): L.Picture => ({ ...astern, ...over })
// up: the mode boxed and its test done
const up = (): L.Link => { const link = L.fresh(); L.select(link); link.test = 0; return link }
// run steps the link through pictures a second apart
const run = (link: L.Link, pictures: Partial<L.Picture>[], from = 0): L.Picture => {
  let last = astern
  pictures.forEach((p, k) => { last = at({ time: from + k, ...p }); L.step(link, last, 1) })
  return last
}
const five = (link: L.Link) => link.five as L.Five
const six = (link: L.Link) => link.six as L.Six

describe('selecting ACL', () => {
  it('boxes it and runs the test, with nothing uplinked meanwhile, and unboxes it clean (24.6.1.2.1)', () => {
    const link = L.fresh()
    expect([link.selected, L.capability(link, astern), L.mode(link, astern)]).toEqual([false, '', ''])
    L.select(link)
    expect([link.selected, link.test, L.capability(link, astern)]).toEqual([true, 10, 'TEST'])
    L.step(link, astern, 4)
    expect([link.test, link.five, L.capability(link, astern), L.mode(link, astern)]).toEqual([6, null, 'TEST', ''])
    L.step(link, astern, 6)
    expect([link.test, L.capability(link, astern)]).toEqual([0, 'ACL 1']); expect(link.five).not.toBeNull()
    L.select(link)
    expect(link).toEqual(L.fresh())
  })
  it('does nothing while it is not boxed', () => {
    const link = L.fresh(); L.step(link, astern, 1)
    expect(link).toEqual(L.fresh())
  })
  it('says what the aircraft\'s own systems can do: ACL 1, ACL 2 without a couple, ACL N/A without the data link or beacon (figure 24-23 d)', () => {
    const link = up()
    expect(L.capability(link, astern)).toBe('ACL 1'); expect(L.capability(link, at({ able: false }))).toBe('ACL 2')
    expect(L.capability(link, at({ link: false }))).toBe('ACL N/A'); expect(L.capability(link, at({ beacon: false }))).toBe('ACL N/A')
  })
})

describe('the controller\'s label 5 message', () => {
  it('brings the jet down to the 5,000 ft platform by 20 nm, then to 1,200 ft, at 250 knots (figure 24-29)', () => {
    const far = up(); run(far, [{ along: 30 * NM, altitude: 19000 * FOOT, height: 19000 * FOOT }])
    expect(five(far)).toMatchObject({ altitude: 5000, descent: 4000, airspeed: 250, discrete: '' })
    const platform = up(); run(platform, [{ along: 18 * NM, altitude: 4800 * FOOT, height: 4800 * FOOT }])
    expect(five(platform)).toMatchObject({ altitude: 1200, descent: 2000, airspeed: 250 })
    const there = up(); run(there, [{ along: 30 * NM, altitude: 5020 * FOOT }])
    expect(five(there).descent).toBe(0) // at the altitude commanded: no rate
  })
  it('sends the landing check inside 6 nm on the approach, with the approach speed', () => {
    const link = up(); run(link, [{ along: 6.2 * NM }])
    expect(five(link)).toMatchObject({ discrete: '', airspeed: 250 })
    run(link, [{ along: 5.9 * NM, height: 3000 * FOOT, altitude: 3000 * FOOT }]) // too high for the radar's window: the check alone
    expect(five(link)).toMatchObject({ discrete: 'LND CHK', airspeed: 130, altitude: 1200, descent: 2000 })
  })
  it('heads the jet up the final bearing, and cuts back at the centreline from either side, to 30°', () => {
    const heading = (across: number, along = 8 * NM) => { const link = up(); run(link, [{ across, along }]); return five(link).heading }
    expect(heading(0)).toBe(60)
    expect(heading(600)).toBeLessThan(60); expect(heading(-600)).toBeGreaterThan(60) // right of it: come left
    expect(heading(600)).toBe(Math.round(60 - Math.atan(600 / (8 * NM / 4)) * 180 / Math.PI))
    expect(heading(8000, 6 * NM)).toBe(30); expect(heading(-8000, 6 * NM)).toBe(90)
  })
  it('sends a jet outside the approach\'s cone round to the gate, 12 nm astern', () => {
    const heading = (along: number, across: number) => { const link = up(); run(link, [{ along, across }]); return five(link).heading }
    expect(heading(-5 * NM, 0)).toBe(240) // ahead of the ship: downwind
    expect(heading(12 * NM, 20 * NM)).toBe(330); expect(heading(12 * NM, -20 * NM)).toBe(150) // abeam the gate: straight at it
    expect(heading(1 * NM, 0)).toBe(240) // inside 2 nm it is no longer lined up: round again
  })
  it('wraps the heading through north', () => {
    const link = up(); run(link, [{ final: 5, across: 8000, along: 6 * NM }])
    expect(five(link).heading).toBe(335)
  })
})

describe('the SPN-42', () => {
  it('acquires a jet through its entry window inside 5 nm, and sends ACL RDY with commands of zero', () => {
    const link = up(); run(link, [{ along: 5.2 * NM }])
    expect([link.acquired, link.six]).toEqual([false, null])
    run(link, [{ along: 4.9 * NM }])
    expect(link.acquired).toBe(true)
    expect(five(link).discrete).toBe('ACL RDY'); expect(six(link)).toMatchObject({ rate: 0, roll: 0, lateral: 0 })
    expect(six(link).vertical).toBeCloseTo(1200 * FOOT - 4.9 * NM * SLOPE, 6) // under the glidepath, which is still above the pattern
  })
  it('does not acquire outside the window: 10,000 ft wide and 630 high about the pattern altitude', () => {
    const tried = (over: Partial<L.Picture>) => { const link = up(); run(link, [{ along: 4.5 * NM, ...over }]); return link.acquired }
    expect(tried({})).toBe(true)
    expect([tried({ across: 4900 * FOOT }), tried({ across: 5100 * FOOT }), tried({ across: -5100 * FOOT })]).toEqual([true, false, false])
    expect([tried({ height: 1510 * FOOT }), tried({ height: 1520 * FOOT }), tried({ height: 890 * FOOT }), tried({ height: 880 * FOOT })]).toEqual([true, false, true, false])
    expect(tried({ beacon: false })).toBe(false) // it tracks the beacon
  })
  it('centres the window on the glidepath where that is below the pattern', () => {
    const link = up(); run(link, [{ along: 2.5 * NM, height: 2.5 * NM * SLOPE + 50 }])
    expect(link.acquired).toBe(true)
    const high = up(); run(high, [{ along: 2.5 * NM, height: 1200 * FOOT + 20 }]) // level at the pattern, well over the glidepath here
    expect(high.acquired).toBe(false)
  })
  it('keeps the jet until a waveoff, the cone\'s edge, the beacon going off or the ramp', () => {
    for (const lost of [{ waved: true }, { across: 5 * NM }, { beacon: false }, { along: -10 }] as Partial<L.Picture>[]) {
      const link = up(); run(link, [{ along: 4.5 * NM }, { along: 4.4 * NM, ...lost }])
      expect([link.acquired, link.six], JSON.stringify(lost)).toEqual([false, null])
    }
    const kept = up(); run(kept, [{ along: 4.5 * NM }, { along: 100, across: 150, height: 6 }]) // close in, the cone is no narrower than 200 m
    expect(kept.acquired).toBe(true)
  })
  it('gives command control five seconds after the couple to its commands, and takes it back with the couple', () => {
    const link = up()
    run(link, [{ along: 4.5 * NM }, { along: 4.45 * NM, coupled: 'bank' }, { along: 4.4 * NM, coupled: 'bank' }, { along: 4.35 * NM, coupled: 'bank' }, { along: 4.3 * NM, coupled: 'bank' }, { along: 4.25 * NM, coupled: 'bank' }])
    expect([link.control, five(link).discrete]).toEqual([false, 'ACL RDY'])
    run(link, [{ along: 4.2 * NM, coupled: 'bank' }], 6)
    expect([link.control, five(link).discrete]).toEqual([true, 'CMD CNT'])
    run(link, [{ along: 4.15 * NM, coupled: '' }], 7)
    expect([link.control, link.reported, five(link).discrete]).toEqual([false, null, 'ACL RDY'])
    const heading = up(); run(heading, [{ along: 4.5 * NM }, ...Array.from({ length: 8 }, () => ({ along: 4.4 * NM, coupled: 'heading' as const }))])
    expect(heading.control).toBe(false) // a traffic control couple is not the report
  })
  it('sends W/O for a pass waved off, over everything else', () => {
    const link = up(); run(link, [{ along: 4.5 * NM }, { along: 4.4 * NM, waved: true }])
    expect(five(link).discrete).toBe('W/O')
  })
})

describe('its commands', () => {
  // coupled: acquired at 4.5 nm, coupled, and flown a second at a time closing at 70 m/s until command control
  const coupled = (height = 1200 * FOOT): L.Link => {
    const link = up()
    run(link, Array.from({ length: 8 }, (_, k) => ({ along: 4.5 * NM - 70 * k, height, coupled: k ? ('bank' as const) : ('' as const) })))
    return link
  }
  it('are zero until command control', () => {
    const link = up(); run(link, [{ along: 4.5 * NM }, { along: 4.5 * NM - 70, coupled: 'bank', across: 100, height: 300 }])
    expect(six(link)).toMatchObject({ rate: 0, roll: 0 })
  })
  it('hold the height the jet coupled at until the glidepath comes down to it', () => {
    const link = coupled()
    expect(link.control).toBe(true); expect(link.level).toBeCloseTo(1200 * FOOT, 6)
    expect(six(link).rate).toBeCloseTo(0, 6)
    run(link, [{ along: 4.5 * NM - 560, height: 1200 * FOOT - 10, coupled: 'bank' }], 8)
    expect(six(link).rate).toBeCloseTo((10 * 0.25) / FOOT, 6) // ten metres low: 2.5 m/s up, in feet a second
    run(link, [{ along: 4.5 * NM - 630, height: 1200 * FOOT + 4, coupled: 'bank' }], 9)
    expect(six(link).rate).toBeCloseTo((-4 * 0.25) / FOOT, 6)
  })
  it('take the height at the couple, not the one the radar acquired the jet at', () => {
    const link = up()
    run(link, [{ along: 4.5 * NM }, { along: 4.5 * NM - 70, height: 1200 * FOOT - 20 }, ...Array.from({ length: 7 }, (_, k) => ({ along: 4.5 * NM - 140 - 70 * k, height: 1200 * FOOT - 20, coupled: 'bank' as const }))])
    expect(link.control).toBe(true); expect(link.level).toBeCloseTo(1200 * FOOT - 20, 6); expect(six(link).rate).toBeCloseTo(0, 6)
  })
  it('lose command control with the uplink, to be reported again', () => {
    const link = coupled()
    run(link, [{ along: 4.5 * NM - 560, coupled: 'bank', link: false }], 8)
    expect([link.six, link.control, link.acquired, link.reported, link.last]).toEqual([null, false, false, null, null])
    run(link, [{ along: 4.5 * NM - 630, coupled: 'bank', across: 50 }], 9)
    expect(link.acquired).toBe(true); expect(six(link)).toMatchObject({ rate: 0, roll: 0 }); expect(link.closure).toBeCloseTo(link.closure, 6); expect(Math.abs(link.drift)).toBeLessThan(1e-9) // no rate from a look it did not have
  })
  it('fly the glidepath past the tipover: its own rate at the speed the jet closes, and the height error', () => {
    const link = coupled()
    const along = 2 * NM, glide = along * SLOPE
    run(link, [{ along: along + 70, height: glide + 70 * SLOPE, coupled: 'bank' }, { along, height: glide, coupled: 'bank' }], 8)
    expect(link.closure).toBeGreaterThan(60) // the radar's own rate, from where it saw the jet last
    expect(six(link).vertical).toBeCloseTo(0, 6); expect(six(link).rate).toBeCloseTo((-link.closure * SLOPE) / FOOT, 6)
    const high = coupled(); run(high, [{ along: along + 70, height: glide + 70 * SLOPE + 8, coupled: 'bank' }, { along, height: glide + 8, coupled: 'bank' }], 8)
    expect(six(high).rate).toBeCloseTo((-high.closure * SLOPE - 8 * 0.25) / FOOT, 6)
  })
  it('roll the jet toward the centreline, against its drift, by no more than 20°', () => {
    const steady = (across: number) => { const link = coupled(); run(link, Array.from({ length: 6 }, (_, k) => ({ along: 4.5 * NM - 560 - 70 * k, across, coupled: 'bank' as const })), 8); return six(link) }
    expect(steady(0).roll).toBeCloseTo(0, 6)
    expect(steady(30).roll).toBeCloseTo((-(0.04 * 30) / 9.80665) * 180 / Math.PI, 3); expect(steady(-30).roll).toBeCloseTo(((0.04 * 30) / 9.80665) * 180 / Math.PI, 3)
    expect(steady(400).roll).toBe(-20); expect(steady(-400).roll).toBe(20)
    const drifting = coupled(); run(drifting, Array.from({ length: 6 }, (_, k) => ({ along: 4.5 * NM - 560 - 70 * k, across: -12 + 2 * k, coupled: 'bank' as const })), 8)
    expect(six(drifting).lateral).toBe(-2); expect(six(drifting).roll).toBeLessThan(0) // left of the line but closing it at 2 m/s: already rolling out
  })
  it('never ask more than 25 ft/s of sink or 10 of climb', () => {
    const low = coupled(); run(low, [{ along: 4.5 * NM - 560, height: 100, coupled: 'bank' }], 8)
    expect(six(low).rate).toBe(10)
    const high = coupled(); run(high, [{ along: 1 * NM, height: 400, coupled: 'bank' }], 8)
    expect(six(high).rate).toBe(-25)
  })
  it('send 10 SEC twelve and a half seconds from touchdown, shown for thirty', () => {
    const link = up() // down the glidepath at 70 m/s, a second a picture: 13.3 s out at 930 m, 12.3 at 860
    run(link, [1140, 1070, 1000, 930].map((along) => ({ along, height: along * SLOPE })))
    expect([link.acquired, link.ten, L.notice(link, 3)]).toEqual([true, -Infinity, ''])
    run(link, [{ along: 860, height: 860 * SLOPE }], 4)
    expect(link.ten).toBe(4)
    expect([L.notice(link, 4), L.notice(link, 33.9), L.notice(link, 34)]).toEqual(['10 SEC', '10 SEC', ''])
    run(link, [{ along: 790, height: 790 * SLOPE }], 5)
    expect(link.ten).toBe(4) // sent once
  })
})

describe('what the loop is ready for', () => {
  it('reads T/C with the controller\'s heading and no label 6, MODE 1 with the radar\'s commands (figure 24-23 b)', () => {
    const link = up(); const far = run(link, [{}])
    expect(L.mode(link, far)).toBe('T/C')
    const near = run(link, [{ along: 4.5 * NM }])
    expect(L.mode(link, near)).toBe('MODE 1')
  })
  it('reads MODE 2 without a couple to make: no FCS couple, no beacon reply, the flaps short of FULL, or no ATC', () => {
    const link = up(); const near = run(link, [{ along: 4.5 * NM }])
    for (const lacking of [{ able: false }, { flaps: false }, { throttle: false }] as Partial<L.Picture>[]) expect(L.mode(link, { ...near, ...lacking }), JSON.stringify(lacking)).toBe('MODE 2')
    expect(L.mode(link, { ...near, beacon: false })).toBe('MODE 2')
  })
  it('reads TILT out of the link\'s reach, nothing uplinked, and nothing at all with the receiver off', () => {
    const link = up(); const out = run(link, [{ along: 101 * NM }])
    expect([link.five, L.mode(link, out)]).toEqual([null, 'TILT'])
    const off = run(link, [{ link: false }])
    expect([link.five, L.mode(link, off), L.capability(link, off)]).toEqual([null, '', 'ACL N/A'])
    const back = run(link, [{ along: 99 * NM }])
    expect(L.mode(link, back)).toBe('T/C')
  })
  it('offers no traffic control couple without an FCS that can couple, nor after a waveoff', () => {
    const link = up(); const far = run(link, [{}])
    expect(L.mode(link, { ...far, able: false })).toBe('')
    const waved = run(link, [{ waved: true }])
    expect(L.mode(link, waved)).toBe('')
  })
})

describe('what there is to couple to', () => {
  it('is the controller\'s heading in T/C', () => {
    const link = up(); const far = run(link, [{ across: 600 }])
    expect(L.couple(link, far)).toEqual({ axis: 'heading', value: five(link).heading, vertical: null })
  })
  it('is the radar\'s roll and rate of climb in MODE 1, the rate in metres a second', () => {
    const link = up(); const near = run(link, [{ along: 4.5 * NM }])
    expect(L.couple(link, near)).toEqual({ axis: 'bank', value: 0, vertical: 0 })
    link.six = { vertical: 0, lateral: 0, rate: -12, roll: 3 }
    expect(L.couple(link, near)).toEqual({ axis: 'bank', value: 3, vertical: -12 * FOOT })
  })
  it('stays the heading while a traffic control couple is held, until it is let go (24.6.1.2.3)', () => {
    const link = up(); const near = run(link, [{ along: 4.5 * NM, coupled: 'heading' }])
    expect(L.mode(link, near)).toBe('MODE 1'); expect(L.couple(link, near)).toMatchObject({ axis: 'heading' })
    expect(L.couple(link, { ...near, coupled: '' })).toMatchObject({ axis: 'bank' })
    expect(L.couple(link, { ...near, able: false })).toBeNull() // an FCS that can no longer couple keeps nothing
    const waved = run(link, [{ along: 4.4 * NM, coupled: 'heading', waved: true }], 1)
    expect(five(link).discrete).toBe('W/O'); expect(L.couple(link, waved)).toBeNull() // a waveoff takes the heading couple too
  })
  it('is nothing in MODE 2, with TILT, after a waveoff, or without an FCS to couple', () => {
    const link = up(); const near = run(link, [{ along: 4.5 * NM }])
    expect(L.couple(link, { ...near, throttle: false })).toBeNull(); expect(L.couple(link, { ...near, able: false })).toBeNull()
    const waved = run(link, [{ along: 4.4 * NM, waved: true }])
    expect(L.couple(link, waved)).toBeNull()
    const out = run(link, [{ along: 101 * NM }])
    expect(L.couple(link, out)).toBeNull(); expect(L.couple(link, { ...out, coupled: 'heading' })).toBeNull()
    expect(L.couple(L.fresh(), astern)).toBeNull()
  })
})

describe('what changed', () => {
  it('underlines the item that last changed, and flashes DATA for ten seconds after it (figure 24-23, 24.6.1.1.2)', () => {
    const link = up(); run(link, [{ along: 6.5 * NM }])
    expect([link.changed, link.data]).toEqual(['', -Infinity]) // the first picture is not a change
    run(link, [{ along: 5.9 * NM, height: 3000 * FOOT, altitude: 1200 * FOOT + 20 }], 1)
    expect([link.changed, link.data]).toEqual(['airspeed', 1]) // 250 to 130 with the landing check: the first of the two in the display's order
    run(link, [{ along: 4.9 * NM }], 2)
    expect([link.changed, link.data]).toEqual(['discrete', 2])
    expect([L.flashing(link, 2), L.flashing(link, 2.25), L.flashing(link, 2.5), L.flashing(link, 11.9), L.flashing(link, 12)]).toEqual([true, false, true, false, false])
    run(link, [{ along: 4.8 * NM }], 3)
    expect([link.changed, link.data]).toEqual(['discrete', 2]) // nothing new: the underline stays
  })
  it('underlines TILT when the uplink is lost, but does not count an item going blank as new data', () => {
    const link = up(); run(link, [{ along: 4.9 * NM }, { along: 4.8 * NM }])
    expect(link.data).toBe(-Infinity)
    link.ten = -28.5 // a notice with a second and a half to run
    run(link, [{ along: 4.7 * NM }, { along: 4.6 * NM }], 0)
    expect([link.changed, link.data]).toEqual(['notice', 0])
    run(link, [{ along: 4.5 * NM }], 2) // the notice gone: nothing new
    expect([L.notice(link, 2), link.changed, link.data]).toEqual(['', 'notice', 0])
    run(link, [{ along: 101 * NM }], 3)
    expect([link.five, link.changed, link.data]).toEqual([null, 'mode', 3])
  })
})
