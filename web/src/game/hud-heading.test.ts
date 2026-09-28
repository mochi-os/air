// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The heading scale's place on the HUD. ED's manual: "The heading tape is
// raised +1.25° from its position in NAV master mode when in A/G or A/A" - it
// never leaves the top. engine.ts cannot be imported (WebGL at module scope),
// so the line that places it is read as text and evaluated per master.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
const line = /const hty=[^\n]*;/.exec(source)?.[0] ?? ''

// The scale's y for the master (through the aa gate) in the given frame.
function hty(aa: boolean, glass: boolean): number {
  if (!line) throw new Error('heading scale placement not found in engine.ts')
  const run = new Function('aa', 'glass', `const cy=400, ppdv=20, HH=900; ${line} return hty;`) as (aa: boolean, glass: boolean) => number
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
    expect(source).toMatch(/\n\tif\(!declutter&&!aa\)\{ const pivotY=/)
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
  const draw = (heading: number) => {
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
    new Function('hctx', 'screen', 'glass', 'declutter', 'aa', 'cx', 'cy', 'ppdv', 'GR', 'ownship', 'carrier_ols', 'master', `${section}`)(
      hctx, {}, null, 0, false, cx, 360, 16, 'g', { fwd: { x: Math.sin(radians), z: -Math.cos(radians) } }, false, 'nav')
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
})

