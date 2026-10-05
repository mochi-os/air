// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as navigate from './navigation'

// The heading scale's place on the HUD. ED's manual: "The heading tape is
// raised +1.25° from its position in NAV master mode when in A/G or A/A" - it
// never leaves the top. engine.ts cannot be imported (WebGL at module scope),
// so the line that places it is read as text and evaluated per master.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
const line = /const hty=[^\n]*;/.exec(source)?.[0] ?? ''
// hud_tape places it, and the reject switch's rule (keep) gates it on the HUD
const tape = /\nfunction hud_tape\([^\n]*\n/.exec(source)?.[0] ?? ''
const support = `const keep=(symbol,level)=>rej<level; ${tape}`

// The scale's y for the master (through the aa gate) in the given frame.
function hty(aa: boolean, glass: boolean): number {
  if (!line) throw new Error('heading scale placement not found in engine.ts')
  const run = new Function('aa', 'glass', `const cy=400, ppdv=20, HH=900, worn=null; ${tape} ${line} return hty;`) as (aa: boolean, glass: boolean) => number
  return run(aa, glass)
}

describe('the heading scale', () => {
  it('sits at the top of the glass in NAV and 1.25° higher in the A/A masters', () => {
    expect(hty(false, true)).toBe(400 - 150)
    expect(hty(true, true)).toBe(400 - 150 - 1.25 * 20)
  })

  it('never moves to the bottom of the field', () => {
    for (const glass of [true, false]) for (const aa of [true, false]) expect(hty(aa, glass)).toBeLessThan(400)
  })

  it("keeps the HUD view's scale against the window's edge in every master", () => {
    expect(hty(false, false)).toBe(46)
    expect(hty(true, false)).toBe(46)
  })

  it('drops the bank scale in the A/A masters on its own rule', () => {
    expect(source).toMatch(/bank angle scale[^\n]*not drawn in the A\/A masters/)
    expect(source).toMatch(/\n\tif\(!rej&&!aa&&!limited\)\{ const pivotY=/) // and on the helmet too, which 2.21.13.3 does not exclude, outside a mission computer's backup set
    expect(source).not.toMatch(/relocated heading scale/)
  })
})

// NATOPS 2.13.4.8.11 item 1 and figure 2-26: three-digit labels over the 10°
// ticks (350 000 010), no line under the ticks, and a T under the current
// heading for true heading - every heading the game draws is true, as the HSI's
// T says; a caret there would claim magnetic. The section is run against a
// canvas that records its text and line segments.
describe('the heading scale face', () => {
  const start = source.indexOf('\t// ---- heading scale:'), end = source.indexOf('\t// ---- airspeed box', start)
  const section = source.slice(start, end)
  const cx = 640, hty = 46
  const draw = (heading: number, magnetic = false) => {
    const text: string[] = [], segments: number[][] = []
    let at = [0, 0], fills = 0
    const hctx = new Proxy({}, { get: (_, k) => {
      if (k === 'fillText') return (s: string) => text.push(String(s))
      if (k === 'moveTo') return (x: number, y: number) => { at = [x, y] }
      if (k === 'lineTo') return (x: number, y: number) => { segments.push([...at, x, y]); at = [x, y] }
      if (k === 'fill') return () => { fills++ }
      return () => {}
    }, set: () => true })
    const radians = heading * Math.PI / 180
    new Function('hctx', 'screen', 'glass', 'rej', 'aa', 'cx', 'cy', 'ppdv', 'GR', 'ownship', 'carrier_ols', 'master', 'nav', 'hud_steer', `const limited=false, worn=null, hold={ engaged:false, modes:{ attitude:false, select:false, barometric:false, radar:false, coupled:false }, source:"track", caution:-Infinity, flash:-Infinity }, link={ selected:false, five:null, six:null }, autopilot={ cue:()=>false, cautions:()=>[], advisories:()=>[] }, hud_link=()=>"", hud_coupled=()=>""; let coupled=""; ${support} ${section}`)(
      hctx, {}, null, 0, false, cx, 360, 16, 'g', { fwd: { x: Math.sin(radians), z: -Math.cos(radians) } }, false, 'nav', { magnetic, variation: 7 * Math.PI / 180 }, () => null)
    return { text, segments, fills }
  }

  it('labels the 10° ticks with three digits', () => {
    expect(start).toBeGreaterThan(0)
    expect(draw(0).text).toEqual(['350', '000', '010'])
    expect(draw(355).text).toEqual(['340', '350', '000', '010'])
    expect(draw(92).text).toEqual(['080', '090', '100'])
  })

  it('draws no line under the ticks', () => {
    for (const [x1, y1, x2, y2] of draw(0).segments) expect(y1 === hty && y2 === hty && Math.abs(x2 - x1) > 10, `${x1},${y1} to ${x2},${y2}`).toBe(false)
  })

  it('marks the current heading with a T, not a caret', () => {
    const { segments, fills } = draw(0)
    expect(segments).toContainEqual([cx - 5, hty + 5, cx + 5, hty + 5])
    expect(segments).toContainEqual([cx, hty + 5, cx, hty + 13])
    expect(fills).toBe(0)
  })

  it('reads magnetic with HDG MAG selected, a caret under the heading in place of the T (24.2.5.7)', () => {
    const { text, segments } = draw(92, true) // 7° of easterly variation: 085 magnetic
    expect(text).toEqual(['070', '080', '090', '100'])
    expect(segments).toContainEqual([cx - 5, hty + 11, cx, hty + 4])
    expect(segments).toContainEqual([cx, hty + 4, cx + 5, hty + 11])
    expect(segments).not.toContainEqual([cx - 5, hty + 5, cx + 5, hty + 5])
  })
})

// Figure 2-26: the command heading marker (NATOPS item 18) is a short heavy bar
// just under the scale's ticks; the bank pointer is an open triangle pointing
// down onto the scale, above the tick at the bank angle, and the 15° ticks are
// long like the centre, 30° and 45°, with only the 5° ticks short.
describe('the heading marker and bank scale as figure 2-26 draws them', () => {
  const record = () => {
    const paths: { points: number[][]; end: string; width: number; dash: number }[] = []
    let points: number[][] = [], width = 1, dash = 0
    const arcs: number[][] = []
    const hctx = new Proxy({}, { get: (_, k) => {
      if (k === 'beginPath') return () => { points = [] }
      if (k === 'moveTo' || k === 'lineTo') return (x: number, y: number) => points.push([k === 'moveTo' ? 0 : 1, x, y])
      if (k === 'arc') return (x: number, y: number, r: number) => arcs.push([x, y, r])
      if (k === 'setLineDash') return (d: number[]) => { dash = d.length }
      if (k === 'stroke' || k === 'fill') return () => paths.push({ points, end: String(k), width, dash })
      return () => {}
    }, set: (_, k, v) => { if (k === 'lineWidth') width = v; return true } })
    return { hctx, paths, arcs }
  }
  const THREE = { MathUtils: { clamp: (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v)) } }
  const cx = 640, hty = 46, D2R = Math.PI / 180

  // the section against a steering stand-in: the bearing steered to, or null with no steering; the jet heads north along the track given
  const scale = (steer: { bearing: number; target?: boolean } | null, track = 0, master = 'nav') => {
    const start = source.indexOf('\t// ---- heading scale:'), end = source.indexOf('\t// ---- airspeed box', start)
    const c = record()
    new Function('hctx', 'screen', 'glass', 'rej', 'aa', 'cx', 'cy', 'ppdv', 'GR', 'ownship', 'carrier_ols', 'master', 'hud_steer', 'THREE', 'navigate', 'nav', 'D2R', 'const limited=false, worn=null, link={ selected:false, five:null, six:null }, hold={ modes:{ coupled:false }, source:"track" }; ' + support + source.slice(start, end))(
      c.hctx, {}, null, 0, false, cx, 360, 16, 'g', { fwd: { x: 0, z: -1 }, pos: { x: 0, z: 0 }, gauges: { heading: 0, track: track * D2R } }, true, master, () => steer, THREE, navigate, { magnetic: false, variation: 0 }, D2R)
    return c
  }

  it('marks the command heading with a short heavy bar under the ticks, on the bearing steered to', () => {
    const mx = cx + 4 * 7   // 4°: inside the 5° the marker reads directly
    const marker = scale({ bearing: 4 * D2R }).paths.filter(path => path.points.some(([, x]) => Math.abs(x - mx) < 1e-6))
    expect(marker.length).toBe(1)
    expect(marker[0].points.map(([, x, y]) => [Math.round(x), y])).toEqual([[mx, hty + 1], [mx, hty + 6]])
    expect(marker[0].width).toBe(3)
  })

  it('compresses the marker past 5°, to the end of the scale at 30° and beyond (24.2.9.1)', () => {
    const at = (bearing: number) => scale({ bearing: bearing * D2R }).paths.find(path => path.width === 3)?.points[0][1]
    expect(at(17.5)).toBeCloseTo(cx + 10 * 7, 6)
    expect(at(30)).toBeCloseTo(cx + 15 * 7, 6)
    expect(at(-120)).toBeCloseTo(cx - 15 * 7, 6)
  })

  it('corrects the marker for wind drift: it shows the ground track\'s error, not the heading\'s', () => {
    expect(scale({ bearing: 7 * D2R }, 3).paths.find(path => path.width === 3)?.points[0][1]).toBeCloseTo(cx + 4 * 7, 6)
  })

  it('draws the target\'s diamond in the marker\'s place once a target is designated (24.2.10)', () => {
    const c = scale({ bearing: 4 * D2R, target: true })
    expect(c.paths.filter(path => path.width === 3)).toEqual([])
    const mx = cx + 4 * 7
    expect(c.paths.some(path => path.points.length === 4 && path.points.every(([, x]) => Math.abs(x - mx) <= 5 + 1e-6) && path.points[0][2] === hty + 2)).toBe(true)
  })

  it('draws no command heading without steering, nor outside the NAV master mode', () => {
    expect(scale(null).paths.filter(path => path.width === 3)).toEqual([])
    expect(scale({ bearing: 4 * D2R }).paths.filter(path => path.width === 3).length).toBe(1)
    expect(scale({ bearing: 4 * D2R }, 0, '9m').paths.filter(path => path.width === 3)).toEqual([])
  })

  const bank = (degrees: number, limited = false) => {
    const start = source.indexOf('\t// ---- bank angle scale (bottom)'), end = source.indexOf('\t// ---- data blocks', start)
    const c = record(), radians = degrees * D2R
    new Function('hctx', 'rej', 'aa', 'cx', 'cy', 'ppdv', 'GR', 'ownship', 'sim_time', 'THREE', 'D2R', `const limited=${limited}; ` + source.slice(start, end))(
      c.hctx, 0, false, cx, 360, 16, 'g', { right: { y: -Math.sin(radians) }, up: { y: Math.cos(radians) } }, 0, THREE, D2R)
    return c
  }

  it('is drawn wherever the HUD layout is, the helmet included, but not in a mission computer\'s backup set there (2.21.13.3, 2.21.15)', () => {
    expect(bank(0).paths.length).toBeGreaterThan(0)
    expect(bank(0, true).paths).toEqual([])
  })

  it('draws the 5° ticks short and the centre, 15°, 30° and 45° ticks long', () => {
    const ticks = bank(0).paths.filter(path => path.points.length === 2)
    const lengths = ticks.map(({ points: [[, x0, y0], [, x1, y1]] }) => Math.round(Math.hypot(x1 - x0, y1 - y0)))
    expect(lengths).toEqual([9, 9, 9, 5, 9, 5, 9, 9, 9])
  })

  it('points an open triangle down onto the tick at the bank angle', () => {
    for (const degrees of [0, 20, -30]) {
      const c = bank(degrees)
      const pointer = c.paths.filter(path => path.points.length === 3)
      expect(pointer.length, `${degrees}°`).toBe(1)
      expect(pointer[0].end).toBe('stroke')
      const pivotY = 360 + 4.2 * 16, br = 3.2 * 16, a = degrees * D2R
      const [[, ax, ay], [, bx, by], [, ex, ey]] = pointer[0].points
      expect(ax).toBeCloseTo(cx + Math.sin(a) * br)   // the apex on the scale's arc
      expect(ay).toBeCloseTo(pivotY + Math.cos(a) * br)
      expect(Math.hypot((bx + ex) / 2 - cx, (by + ey) / 2 - pivotY)).toBeCloseTo(br - 9)   // the base inside it
    }
    expect(bank(0).paths.some(path => path.end === 'fill')).toBe(false)
  })
})

