// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import nimitz from '../assets/nimitz.json'

// The carrier's deck layout lives in one file beside its model, which engine.ts
// and the model tools (tools/nimitz/ship.py) both read: the catapults the jet
// flies, the tracks and deflector boxes the deck texture paints and the cabs the
// build stands beside them are one set of numbers. engine.ts cannot be imported
// (WebGL at module scope), so its pieces are read as text.
const source = readFileSync(
  fileURLToPath(new URL('./engine.ts', import.meta.url)),
  'utf8'
)

interface Point {
  x: number
  y: number
  z: number
}
interface Carrier {
  deck: { x: number; z: number }[]
  catapults: {
    position: Point
    heading: number
    stroke: number
    speed: number
  }[]
  wires: { a: Point; b: Point }[]
}

// Runs scenery() and the landing-line helpers it uses over the real ship file.
function carrier(): Carrier {
  const scenery =
    /function scenery\(\)\{[\s\S]*?return \{ sea:3, fields, carrier, prisms, posts \};[^\n]*\n\}/.exec(
      source
    )?.[0] ?? ''
  const strip = /function strip_lat\(fa\)\{[^\n]*\n/.exec(source)?.[0] ?? ''
  const unit = /const _slen=[^\n]*\n/.exec(source)?.[0] ?? ''
  if (!scenery || !strip || !unit)
    throw new Error(
      'scenery, strip_lat or the landing line unit not found in engine.ts'
    )
  const run = new Function(
    'SHIP',
    `const ISLAND_H=3.5, AIRFIELD_FLOAT=1.46, RUNWAY_FLOAT=1.5, D2R=Math.PI/180, CARRIER_YD=0;
    const CARRIER={x:0,z:0,deckY:20}, physics_strips=[], runway_strips=[], obstacles={ islands:[], buildings:[], posts:[] }, carrier_island=()=>null;
    ${strip}${unit}${scenery}
    return scenery().carrier;`
  ) as (ship: unknown) => Carrier
  return run({ ...nimitz })
}

describe("the carrier's deck file", () => {
  it('is what the engine flies and draws, with no copy of its numbers in the engine', () => {
    expect(source).toMatch(
      /import nimitz_deck from '\.\.\/assets\/nimitz\.json'/
    )
    expect(source).toMatch(
      /const CARRIER_MODELS=\{\n\tnimitz:\{ url:nimitz_model_url,[^\n]*\n(?:\t\t[^\n]*\n)*\t\t\.\.\.nimitz_deck \} \};/
    )
    const numbers = [
      ...nimitz.catapults.flatMap((c) => [
        c.x,
        c.z,
        c.heading,
        c.deflector.x,
        c.deflector.z,
      ]),
      ...nimitz.landing.line.flat(),
      ...nimitz.landing.wires,
      nimitz.ols.x,
      nimitz.ols.z,
    ]
      .map(String)
      .filter((n) => n.includes('.') && n.replace(/\D/g, '').length >= 3)
    expect(numbers.length).toBeGreaterThan(15)
    for (const n of numbers)
      expect(source, n).not.toMatch(
        new RegExp(`(?<![\\d.])${n.replace('.', '\\.')}(?![\\d])`)
      )
  })

  it('gives the flight core each catapult as it stands in the file', () => {
    const c = carrier()
    expect(c.catapults).toHaveLength(nimitz.catapults.length)
    nimitz.catapults.forEach((want, i) => {
      expect(c.catapults[i]).toEqual({
        position: { x: want.x, y: 0, z: want.z },
        heading: (want.heading * Math.PI) / 180,
        stroke: want.stroke,
        speed: want.speed,
      })
    })
    expect(c.deck).toEqual(nimitz.outline.map(([x, z]) => ({ x, z })))
  })

  it('spans each wire square across the landing line, its length the span, centred where the file puts it', () => {
    const c = carrier()
    const [[ax, az], [bx, bz]] = nimitz.landing.line
    const along = [bx - ax, bz - az],
      length = Math.hypot(along[0], along[1])
    expect(c.wires).toHaveLength(nimitz.landing.wires.length)
    nimitz.landing.wires.forEach((x, i) => {
      const { a, b } = c.wires[i]
      expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeCloseTo(
        nimitz.landing.span,
        9
      )
      expect(
        ((b.x - a.x) * along[0] + (b.z - a.z) * along[1]) / length
      ).toBeCloseTo(0, 9)
      const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }
      expect(mid.x).toBeCloseTo(x, 9)
      expect(mid.z).toBeCloseTo(az + ((x - ax) * (bz - az)) / (bx - ax), 9)
    })
  })

  it('stands a blast deflector on every catapult, from the file', () => {
    expect(source).toMatch(
      /carrier_jbds=SHIP\.catapults\.map\(cat=>\{\n\t\tconst box=cat\.deflector, L=box\.depth-2\*JBD_INSET\.end, bw=box\.width-2\*JBD_INSET\.side;/
    )
    expect(source).toMatch(
      /const w=carrier_world\(box\.x,box\.z\), hd=cat\.heading\*D2R,/
    )
    expect(source).toMatch(
      /uv\.setXY\(i,\(f2-tx\[0\]\)\/\(tx\[1\]-tx\[0\]\),\(l2-tz\[0\]\)\/\(tz\[1\]-tz\[0\]\)\);/
    )
    expect(source).toMatch(/const tx=SHIP\.texture\.x, tz=SHIP\.texture\.z;/)
  })

  it("lights each elevator platform's deck edge from end to end", () => {
    const loop =
      /\tfor\(const el of SHIP\.elevators\)\{[^\n]*\n[^\n]*\n[^\n]*\n/.exec(
        source
      )?.[0] ?? ''
    if (!loop)
      throw new Error('the elevator lights loop not found in engine.ts')
    const lit = new Function(
      'SHIP',
      `const lit=[], ops_lights=[], edge_lat=(f,side)=>side*30, dh=(f,l)=>({ x:f, y:0, z:l }), glow_points=(pts)=>pts;
      ${loop}
      return ops_lights;`
    )({ ...nimitz }) as number[][]
    expect(lit).toHaveLength(nimitz.elevators.length)
    nimitz.elevators.forEach((e, i) => {
      const xs = lit[i].filter((_, k) => k % 3 === 0)
      expect(xs[0]).toBeCloseTo(e.aft, 9)
      expect(xs[xs.length - 1]).toBeCloseTo(e.forward, 9)
      for (let k = 1; k < xs.length; k++)
        expect(xs[k] - xs[k - 1]).toBeLessThanOrEqual(6 + 1e-9)
      expect(
        lit[i].filter((_, k) => k % 3 === 2).every((z) => z === e.side * 30)
      ).toBe(true)
    })
  })

  it('lays its deflectors across their tracks and its elevators along the deck edge', () => {
    for (const c of nimitz.catapults) {
      const h = (c.heading * Math.PI) / 180
      const across =
        (c.deflector.x - c.x) * Math.sin(h) +
        (c.deflector.z - c.z) * Math.cos(h)
      expect(Math.abs(across)).toBeLessThan(c.deflector.width / 2)
      expect(c.deflector.x).toBeLessThan(c.x)
    }
    for (const e of nimitz.elevators) {
      expect(e.aft).toBeLessThan(e.forward)
      expect([1, -1]).toContain(e.side)
    }
    const [[ax], [bx]] = nimitz.landing.line
    expect(ax).toBeLessThan(bx)
    for (const [x, z] of nimitz.outline) {
      expect(x).toBeGreaterThanOrEqual(nimitz.texture.x[0])
      expect(x).toBeLessThanOrEqual(nimitz.texture.x[1])
      expect(z).toBeGreaterThanOrEqual(nimitz.texture.z[0])
      expect(z).toBeLessThanOrEqual(nimitz.texture.z[1])
    }
  })
})
