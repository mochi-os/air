// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { describe, expect, it } from 'vitest'
import * as F from './faces'

// The panels drawn over the cockpit model (FO-5 items 12, 17, 20, 35 and 36;
// #7, #9, #10): where a click lands on each, and what each shows lit. The
// faces draw on a recording context: every legend with the colour it was
// written in, and every lever's end.
const dark: F.Shown = {
  power: true, test: false, arm: false, air: false, ready: false, discharged: false, stations: [],
  dispenser: 'off', jammer: 'off', indicator: { power: false, limit: false, offset: false, special: false, fail: false },
}
const shown = (over: Partial<F.Shown> = {}): F.Shown => ({ ...dark, ...over })
interface Drawn { text: [string, string, number, number][]; levers: [number, number][]; cleared: number[][]; filled: [string, number, number, number, number][] }
function draw(name: F.Name, s: F.Shown): Drawn {
  const d: Drawn = { text: [], levers: [], cleared: [], filled: [] }
  let fill = '', width = 0
  const c = new Proxy({}, {
    get: (_, k) => k === 'fillText' ? (words: string, x: number, y: number) => d.text.push([words, fill, x, y])
      : k === 'clearRect' ? (...a: number[]) => d.cleared.push(a)
      : k === 'fillRect' ? (x: number, y: number, w: number, h: number) => d.filled.push([fill, x, y, w, h])
      : k === 'lineTo' ? (x: number, y: number) => { if (width === 12 || width === 8) d.levers.push([Math.round(x), Math.round(y)]) } // a lever's or a knob pointer's end
      : () => {},
    set: (_, k, v) => { if (k === 'fillStyle') fill = v; if (k === 'lineWidth') width = v; return true },
  })
  F.draw(name, c as unknown as CanvasRenderingContext2D, s)
  return d
}
const colour = (d: Drawn, words: string) => d.text.filter((t) => t[0] === words).map((t) => t[1])
const GREEN = '#2fd24a', AMBER = '#ffc23a', DIM = '#3a3c38', INK = '#cfd2cc'

describe('a click on a face', () => {
  it('lands on the control under it', () => {
    expect(F.control(F.FACES.arm, 124, 320)?.action).toBe('arm')
    expect(F.control(F.FACES.arm, 149, 57)?.action).toBe('extinguisher')
    expect(F.control(F.FACES.arm, 100, 174)?.action).toBe('mode.air')
    expect(F.control(F.FACES.arm, 100, 218)?.action).toBe('mode.ground')
    expect(F.control(F.FACES.emergency, 68, 68)?.action).toBe('jettison.emergency')
    expect(F.control(F.FACES.defence, 178, 290)?.action).toBe('dispenser')
    expect(F.control(F.FACES.defence, 346, 290)?.action).toBe('jammer')
    expect(F.control(F.FACES.defence, 56, 276)?.action).toBe('jammer.jettison')
  })
  it('takes the nearer of two controls whose reaches overlap', () => {
    expect(F.control(F.FACES.arm, 100, 190)?.action).toBe('mode.air')
    expect(F.control(F.FACES.arm, 100, 202)?.action).toBe('mode.ground')
  })
  it('lands on nothing off every control', () => {
    expect(F.control(F.FACES.arm, 20, 20)).toBeNull()
    expect(F.control(F.FACES.defence, 218, 40)).toBeNull() // the quarter behind the AMPCD, left bare
    expect(F.control(F.FACES.stations, 120, 30)).toBeNull() // beside CTR, where the model's knob stands
  })
  it('finds each station select button, the centreline over the left inboard', () => {
    const at = (x: number, y: number) => F.control(F.FACES.stations, x, y)?.action
    expect([at(40, 30), at(40, 92), at(120, 92), at(40, 154), at(120, 154)]).toEqual(['jettison.station.5', 'jettison.station.3', 'jettison.station.7', 'jettison.station.2', 'jettison.station.8'])
  })
  it('finds the RWR control indicator\'s buttons left to right: BIT, OFFSET, SPECIAL, DISPLAY, POWER', () => {
    expect([50, 134, 218, 302, 386].map((x) => F.control(F.FACES.defence, x, 144)?.action)).toEqual(['receiver.test', 'receiver.offset', 'receiver.special', 'receiver.display', 'receiver.power'])
  })
  it('keeps every control inside its face', () => {
    for (const [name, face] of Object.entries(F.FACES)) for (const c of face.controls) {
      expect(c.x >= 0 && c.x <= face.width && c.y >= 0 && c.y <= face.height, name + ' ' + c.action).toBe(true)
    }
  })
})

describe('the master arm panel\'s face', () => {
  it('throws the MASTER ARM lever up at ARM and down at SAFE', () => {
    expect(draw('arm', shown({ arm: true })).levers).toEqual([[124, 296]])
    expect(draw('arm', shown({ arm: false })).levers).toEqual([[124, 344]])
  })
  it('lights A/A in the A/A master mode, and never A/G', () => {
    expect(colour(draw('arm', shown()), 'A/A')).toEqual([DIM, INK]) // the lens dark, its label beside it
    expect(colour(draw('arm', shown({ air: true })), 'A/A')).toEqual([GREEN, INK])
    expect(colour(draw('arm', shown({ air: true })), 'A/G')).toEqual([DIM, INK])
  })
  it('lights READY amber and DISCH green on the extinguisher pushbutton', () => {
    expect(colour(draw('arm', shown()), 'READY')).toEqual([DIM]); expect(colour(draw('arm', shown()), 'DISCH')).toEqual([DIM])
    expect(colour(draw('arm', shown({ ready: true })), 'READY')).toEqual([AMBER])
    expect(colour(draw('arm', shown({ discharged: true })), 'DISCH')).toEqual([GREEN])
  })
  it('lights every lens in the lights test, and none without power', () => {
    const test = draw('arm', shown({ test: true }))
    expect([colour(test, 'READY'), colour(test, 'DISCH'), colour(test, 'A/A')[0], colour(test, 'A/G')[0]]).toEqual([[AMBER], [GREEN], GREEN, GREEN])
    const dead = draw('arm', shown({ power: false, test: true, ready: true, discharged: true, air: true }))
    expect([colour(dead, 'READY'), colour(dead, 'DISCH'), colour(dead, 'A/A')[0]]).toEqual([[DIM], [DIM], DIM])
  })
})

describe('the station jettison select buttons\' face', () => {
  it('reads every legend unlit, and lights amber the ones pressed in', () => {
    expect(['CTR', 'LI', 'RI', 'LO', 'RO'].map((b) => colour(draw('stations', shown()), b)[0])).toEqual([INK, INK, INK, INK, INK])
    const some = draw('stations', shown({ stations: [5, 8] }))
    expect(['CTR', 'LI', 'RI', 'LO', 'RO'].map((b) => colour(some, b)[0])).toEqual([AMBER, INK, INK, INK, AMBER])
  })
  it('lights none without power, and all in the lights test', () => {
    expect(colour(draw('stations', shown({ stations: [5], power: false })), 'CTR')).toEqual([INK])
    expect(colour(draw('stations', shown({ test: true })), 'LO')).toEqual([AMBER])
  })
})

describe('the dispenser/EMC panel\'s face', () => {
  // the DISPENSER lever's end and the ECM knob's pointer, the last two strokes of the heavy pens
  const lever = (s: F.Shown) => draw('defence', s).levers[0], pointer = (s: F.Shown) => draw('defence', s).levers[1]
  it('throws the DISPENSER lever down at OFF, centred at ON and up at BYPASS', () => {
    expect(lever(shown({ dispenser: 'off' }))).toEqual([178, 314])
    expect(lever(shown({ dispenser: 'on' }))).toEqual([178, 290])
    expect(lever(shown({ dispenser: 'bypass' }))).toEqual([178, 266])
  })
  it('points the ECM knob at each position in turn, clockwise from OFF at the lower left', () => {
    const at = (['off', 'standby', 'test', 'receive', 'transmit'] as const).map((jammer) => pointer(shown({ jammer })))
    expect(at[0][0]).toBeLessThan(346); expect(at[0][1]).toBeGreaterThan(290) // OFF: down and left
    expect(at[4][0]).toBeGreaterThan(346); expect(at[4][1]).toBeLessThan(290) // XMIT: up and right
    const bearing = at.map(([x, y]) => (Math.atan2(x - 346, 290 - y) * 180) / Math.PI) // clockwise from straight up
    expect(bearing.map((b) => Math.round((b + 360) % 360))).toEqual([215, 255, 295, 335, 15]) // forty degrees a position
    for (const [x, y] of at) expect(Math.hypot(x - 346, y - 290)).toBeCloseTo(38, 0) // the pointer reaches the knob's rim
  })
  it('writes each ECM position by the knob, and the panel\'s other legends', () => {
    const words = draw('defence', shown()).text.map((t) => t[0])
    for (const w of ['OFF', 'STBY', 'BIT', 'REC', 'XMIT', 'ECM', 'DISPENSER', 'BYPASS', 'ON', 'ECM JETT', 'AUX REL', 'NORM', 'AN/ALR-67(V)']) expect(words, w).toContain(w)
  })
  it('lights each RWR light over its button: ON, LIMIT, the two ENABLEs and FAIL', () => {
    const lights = (indicator: Partial<F.Shown['indicator']>) => { const d = draw('defence', shown({ indicator: { ...dark.indicator, ...indicator } })); return { on: colour(d, 'ON')[0], limit: colour(d, 'LIMIT')[0], enable: colour(d, 'ENABLE').slice(0, 2), fail: colour(d, 'FAIL')[0] } } // the third ENABLE is AUX REL's legend
    expect(lights({})).toEqual({ on: DIM, limit: DIM, enable: [DIM, DIM], fail: DIM })
    expect(lights({ power: true })).toMatchObject({ on: GREEN, limit: DIM })
    expect(lights({ power: true, limit: true }).limit).toBe(GREEN)
    expect(lights({ power: true, offset: true }).enable).toEqual([GREEN, DIM]) // OFFSET's is the left of the two
    expect(lights({ power: true, special: true }).enable).toEqual([DIM, GREEN])
    expect(lights({ power: true, fail: true }).fail).toBe(AMBER)
  })
  it('never lights a button\'s own name', () => {
    const d = draw('defence', shown({ test: true, indicator: { power: true, limit: true, offset: true, special: true, fail: true } }))
    for (const name of ['POWER', 'DISPLAY', 'SPECIAL', 'OFFSET']) expect(colour(d, name), name).toEqual([INK])
    expect(colour(d, 'BIT')).toEqual([INK, INK]) // the button's name, and the knob's BIT position
  })
})

describe('drawing a face', () => {
  it('clears the whole face first, and paints its panel except under the round emergency button', () => {
    for (const name of ['arm', 'stations', 'defence'] as const) {
      const d = draw(name, shown()), face = F.FACES[name]
      expect(d.cleared).toEqual([[0, 0, face.width, face.height]])
      expect(d.filled[0]).toEqual(['#17191a', 0, 0, face.width, face.height])
    }
    const round = draw('emergency', shown())
    expect(round.cleared).toEqual([[0, 0, 136, 136]])
    expect(round.filled.some((f) => f[0] === '#17191a')).toBe(false) // transparent outside the disc
    expect(round.text.map((t) => t[0])).toEqual(['PUSH TO', 'JETT'])
  })
})
