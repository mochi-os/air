// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The altitude box and what stacks on it. The vertical velocity sits one line
// above the box, right-justified so its last digit lands on the altitude's
// last digit, in the standard digit size (Chuck's guide p.339, the JHMCS
// repeat of the HUD symbology: 5110 over 6880), and only in NAV and the
// landing configuration (NATOPS 2.13.4.8 item 12). engine.ts reaches for
// WebGL at module scope and cannot be imported, so it is read as text.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')

const altitude = /hctx\.fillText\(String\(shown\),(lx\+\d+),wly\+16\)/.exec(source)
const tail = /hctx\.fillText\(restStr,(lx\+\d+),wly\+17\)/.exec(source)
const vertical = /\n\tif\((.+?)\)\{ hctx\.font="(\d+)px 'Hornet Display', monospace"; hctx\.textAlign="(\w+)";[^\n]*\n\t\thctx\.fillText\(\(vs<0\?"-":""\)\+Math\.abs\(Math\.round\(vs\/10\)\*10\),(lx\+\d+),(wly-\d+)\);/.exec(source)

describe('the vertical velocity over the altitude box', () => {
  it('is right-justified on the altitude digits, one line above the box, in the standard size', () => {
    expect(altitude?.[1]).toBe('lx+88')
    expect(tail?.[1]).toBe('lx+88')
    expect(vertical?.[3]).toBe('right')
    expect(vertical?.[4]).toBe('lx+88')
    expect(vertical?.[5]).toBe('wly-12')
    expect(Number(vertical?.[2])).toBe(13)
  })

  it('shows in NAV and the landing configuration only', () => {
    expect(vertical?.[1]).toBe('master==="nav"||pa')
  })
})

// NATOPS 2.13.4.8.11 item 2: the airspeed and altitude box tops are the
// waterline. The instrument cluster is laid out about cx,cy with the waterline
// datum 4° above, and both first-person views move that datum onto the
// projected nose, so the cluster rides the airframe rather than the head. The
// HUD view's own game furniture - the heading scale against the window's top
// and the throttle gauge at its edge - stays in screen space. Each section is
// run against a canvas stand-in that tracks the transform.
describe('the instrument cluster rides the nose', () => {
  const HH = 720, cx = 640, cy = 360, ppdv = HH / 45
  const section = (from: string, to: string) => {
    const start = source.indexOf(from), end = source.indexOf(to, start)
    if (start < 0 || end < 0) throw new Error(`${from} not found in engine.ts`)
    return source.slice(start, end)
  }
  interface Canvas { hctx: object; point: (x: number, y: number) => number[]; moves: number[][]; rects: number[][] }
  const canvas = (start = [1, 0, 0, 1, 0, 0]): Canvas => {
    let m = [...start]
    const stack: number[][] = [], moves: number[][] = [], rects: number[][] = []
    const point = (x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
    const hctx = new Proxy({}, { get: (_, k) => {
      if (k === 'save') return () => stack.push([...m])
      if (k === 'restore') return () => { m = stack.pop() ?? m }
      if (k === 'translate') return (dx: number, dy: number) => { m[4] += m[0] * dx + m[2] * dy; m[5] += m[1] * dx + m[3] * dy }
      if (k === 'scale') return (sx: number, sy: number) => { m[0] *= sx; m[1] *= sx; m[2] *= sy; m[3] *= sy }
      if (k === 'getTransform') return () => ({ a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] })
      if (k === 'setTransform') return (t: { a: number; b: number; c: number; d: number; e: number; f: number }) => { m = [t.a, t.b, t.c, t.d, t.e, t.f] }
      if (k === 'moveTo') return (x: number, y: number) => moves.push(point(x, y))
      if (k === 'strokeRect') return (x: number, y: number) => rects.push(point(x, y))
      if (k === 'measureText') return (s: string) => ({ width: 7 * String(s).length })
      return () => {}
    }, set: () => true })
    return { hctx, point: (x, y) => point(x, y), moves, rects }
  }
  const THREE = { MathUtils: { clamp: (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v)) } }

  it('puts the waterline datum on the projected nose in the HUD view and on the glass', () => {
    const opening = section('// ---- instrument furniture (#133)', '\tconst ppdv=HH/45;')
    for (const [glass, hs] of [[null, 1], [{}, 0.8]] as [object | null, number][]) {
      const c = canvas()
      new Function('hctx', 'glass', 'glass_clip', 'flight_symbols', 'bore', 'hs', 'cx', 'cy', 'HH', 'sym', `${opening} }`)(c.hctx, glass, () => {}, true, [300, 500], hs, cx, cy, HH, 1)
      const [x, y] = c.point(cx, cy - 4 * ppdv)
      expect([x, y], glass ? 'cockpit' : 'HUD view').toEqual([300, 500])
    }
  })

  it('keeps the HUD view\'s heading scale against the window\'s top edge, and the glass\'s on the layout', () => {
    const heading = section('\t// ---- heading scale:', '\t// ---- airspeed box')
    const run = (glass: object | null) => {
      const c = canvas([1, 0, 0, 1, -340, 156]) // the cluster's move onto the nose
      new Function('hctx', 'screen', 'glass', 'declutter', 'aa', 'cx', 'cy', 'ppdv', 'GR', 'ownship', 'carrier_ols', 'THREE', `${heading}`)(
        c.hctx, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, glass, 0, false, cx, cy, ppdv, 'g', { fwd: { x: 0, z: -1 } }, false, THREE)
      return c.moves[0] // the first tick, at the scale's left end
    }
    expect(run(null)).toEqual([cx - 15 * 7, 46])
    expect(run({})).toEqual([cx - 15 * 7 - 340, cy - 150 + 156])
  })

  it('keeps the HUD view\'s throttle gauge at the window\'s edge', () => {
    const gauge = section('\t// ---- throttle gauge:', '\t// ---- gear / hook status')
    const c = canvas([1, 0, 0, 1, -340, 156])
    new Function('hctx', 'screen', 'glass', 'authentic', 'cy', 'GR', 'ownship', 'pad_levers', `if(true){ ${gauge}`)(
      c.hctx, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, null, false, cy, 'g', { throttle: 0.5, burner: 0, spool: 0.5, stage: 0 }, {})
    expect(c.rects[0]).toEqual([25, cy - 70])
  })
})

// NATOPS 2.13.4.8.1 and figure 2-26 sheet 2: REJ 1 removes the airspeed and
// altitude boxes, and REJ 2 with it - the airspeed, the altitude and the
// altimeter setting under it stay at every reject level. The section is run
// against a recording canvas.
describe('the reject switch keeps the airspeed and altitude', () => {
  const start = source.indexOf('\t// ---- airspeed box (left)'), end = source.indexOf('\t// ---- target ranging data', start)
  const boxes = source.slice(start, end)
  const reading = /\nfunction altitude_reading\(\)\{[\s\S]*?\n(?=\S)/.exec(source)?.[0] ?? ''
  const draw = (declutter: number) => new Function('declutter', `const GR='g', cx=640, ppdv=16, wly=344, alt_radar=false, sim_time=10, RADAR={ sil:false }, baro_error=()=>0, radalt_inhibited=()=>RADAR.sil;
    const ownship={ cas:100, speed:100, pos:{ x:0, y:1000, z:0 } }, ground_height=()=>0; ${reading}
    let baro_armed=false, baro_shown=-99, baro_flash=false, baro_set=2992, baro_last=2980;
    const text=[], rects=[];
    const hctx=new Proxy({}, { get:(t,k)=>k==='fillText'?(s)=>text.push(String(s)):k==='strokeRect'?(x,y,w,h)=>rects.push([x,y,w,h]):k==='measureText'?(s)=>({ width:7*String(s).length }):()=>{}, set:()=>true });
    ${boxes} return { text, rects };`)(declutter) as { text: string[]; rects: number[][] }

  it('boxes them at NORM', () => {
    expect(start).toBeGreaterThan(0)
    const d = draw(0)
    expect(d.rects.length).toBe(2)
    for (const value of ['194', '3', '281', '29.92']) expect(d.text).toContain(value)
  })

  it('removes only the boxes at REJ 1 and REJ 2', () => {
    for (const declutter of [1, 2]) {
      const d = draw(declutter)
      expect(d.rects, `REJ ${declutter}`).toEqual([])
      for (const value of ['194', '3', '281', '29.92']) expect(d.text, `REJ ${declutter}`).toContain(value)
    }
  })
})
