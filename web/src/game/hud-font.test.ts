// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The HUD's typeface: Hornet Display, bundled as a WOFF2 and registered with
// the FontFace API before the first frame, drawn at one stroke weight as the
// references show. engine.ts cannot be imported (WebGL at module scope), so
// the source is read as text.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
const lines = source.split('\n')

// The lines of a HUD drawing function: from its declaration to the next
// top-level statement.
function body(name: string): string[] {
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`))
  if (start < 0) throw new Error(`${name} not found in engine.ts`)
  let end = start + 1
  while (end < lines.length && !/^(function |const |let |if\(DEV_MODE\)|\/\/ =+)/.test(lines[end])) end++
  return lines.slice(start, end)
}
const drawers = [...body('draw_hud'), ...body('hud_launch_zone'), ...body('hud_message')]
const fonts = drawers.flatMap((l) => [...l.matchAll(/hctx\.font="([^"]+)"/g)].map((m) => [m[1], l] as const))
const FACE = "'Hornet Display', monospace"

describe('the HUD face', () => {
  it('is registered from the bundled WOFF2 before the first frame', () => {
    expect(source).toMatch(/^import hornet_font_url from '\.\.\/assets\/hornet\.woff2\?url'$/m)
    expect(source).toMatch(/new FontFace\("Hornet Display","url\("\+hornet_font_url\+"\)"\); document\.fonts\.add\(face\);/)
    expect(source).toMatch(/function assets_ready\(\)\{ return [^\n]*&& face_ready; \}/)
    expect(source).toMatch(/core:flight_ready\(\), face:face_ready \}/)
  })

  it('falls back to the system monospace when the load fails, rather than holding LOADING', () => {
    expect(source).toMatch(/face\.load\(\)\.then\(\(\)=>\{ face_ready=true; \},\(e\)=>\{[^\n]*face_ready=true; \}\)/)
    expect(fonts.every(([f]) => !f.includes('Hornet Display') || f.endsWith(FACE))).toBe(true)
  })

  it('draws every piece of symbology in it, and only the developer overlays without', () => {
    const symbology = fonts.filter(([f]) => f.endsWith(FACE))
    expect(symbology.length).toBeGreaterThanOrEqual(30)
    // What keeps the system monospace carries a developer colour or is the
    // comms log; a symbology site that regresses has GR/AM or nothing on its line.
    const overlays = fonts.filter(([f]) => !f.endsWith(FACE))
    for (const [, line] of overlays) expect(line).toMatch(/#ff5040|#7fc8ff|#8fa0aa|ui-monospace/)
    // the sites the references were measured on
    for (const anchor of [/\+"ET",ax-84/, /String\(Math\.round\(kcas\)\)/, /hctx\.fillText\(String\(thousands\)/, /hctx\.fillText\("c",right/, /fillText\(translate\("GUN"\)/]) {
      const at = source.search(anchor)
      expect(at).toBeGreaterThan(0)
      const set = [...source.slice(0, at).matchAll(/hctx\.font="([^"]+)"/g)].pop()?.[1] ?? ''
      expect(set, anchor.source).toMatch(/'Hornet Display', monospace$/)
    }
  })

  it('is one stroke weight: no synthesised bold', () => {
    for (const [f] of fonts) if (f.endsWith(FACE)) expect(f).not.toMatch(/^(600|bold) /)
    expect(source).toMatch(/hctx\.font="20px 'Hornet Display', monospace"; hctx\.textAlign="right"; hctx\.fillText\(String\(Math\.round\(kcas\)\)/)
    expect(source).toMatch(/hctx\.font="21px 'Hornet Display', monospace"; hctx\.fillText\(String\(thousands\)/)
  })

  it('ships as a small WOFF2 with its MIT notice', () => {
    const asset = readFileSync(fileURLToPath(new URL('../assets/hornet.woff2', import.meta.url)))
    expect(asset.subarray(0, 4).toString('latin1')).toBe('wOF2')
    expect(asset.length).toBeLessThan(8192)
    const notice = readFileSync(fileURLToPath(new URL('../assets/hornet-license.txt', import.meta.url)), 'utf8')
    expect(notice).toContain('MIT License')
    expect(notice).toContain('Copyright (c) 2022 Mørkvitnir')
    expect(notice).toContain('github.com/0x408/hornet-display')
  })
})

// lift cuts one top-level function out of the source: from its head to the
// next line that starts at column 0 (the bodies are tab-indented).
function lift(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  expect(start, `${name} in engine.ts`).toBeGreaterThan(0)
  const rest = source.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  return end ? rest.slice(0, end.index + 1) : rest
}

// A stand-in 2D context that records its text calls with the pen state they
// were made under.
function context(font: string) {
  const calls: string[] = []
  const c = {
    font,
    fillStyle: '#0f0',
    strokeStyle: '#f00',
    lineWidth: 1.5,
    lineJoin: 'miter',
    dash: [4, 2] as number[],
    getLineDash() { return this.dash },
    setLineDash(d: number[]) { this.dash = d },
    strokeText(t: string, x: number, y: number, w?: number) { calls.push(`stroke ${t} ${x} ${y} ${w} ${this.strokeStyle} ${this.lineWidth} ${this.lineJoin} [${this.dash.join(',')}]`) },
    fillText(t: string, x: number, y: number, w?: number) { calls.push(`fill ${t} ${x} ${y} ${w} ${this.fillStyle} [${this.dash.join(',')}]`) },
  }
  return { c, calls }
}
const PEN = Number(/const HUD_PEN=([\d.]+);/.exec(source)?.[1])
const pen = new Function('HUD_PEN', `${lift('hud_pen')}\nreturn hud_pen;`)(PEN) as (c: object) => void

describe('the HUD pen', () => {
  it('strokes each glyph in its fill colour at the pen width, round-joined and undashed, under the fill', () => {
    const { c, calls } = context(`13px ${FACE}`)
    pen(c)
    c.fillText('445', 10, 20)
    expect(calls).toEqual([`stroke 445 10 20 undefined #0f0 ${PEN} round []`, 'fill 445 10 20 undefined #0f0 [4,2]'])
  })

  it("hands the caller's pen back afterwards", () => {
    const { c } = context(`13px ${FACE}`)
    pen(c)
    c.fillText('445', 10, 20)
    expect(c.strokeStyle).toBe('#f00')
    expect(c.lineWidth).toBe(1.5)
    expect(c.lineJoin).toBe('miter')
    expect(c.dash).toEqual([4, 2])
  })

  it('passes a maximum width through to both passes', () => {
    const { c, calls } = context(`13px ${FACE}`)
    pen(c)
    c.fillText('RDR', 1, 2, 30)
    expect(calls).toEqual([`stroke RDR 1 2 30 #0f0 ${PEN} round []`, 'fill RDR 1 2 30 #0f0 [4,2]'])
  })

  it('leaves text in any other face alone', () => {
    const { c, calls } = context('12px ui-monospace')
    pen(c)
    c.fillText('54 fps', 5, 6)
    expect(calls).toEqual(['fill 54 fps 5 6 undefined #0f0 [4,2]'])
  })

  it('is a little under the symbology line width, and installed on the HUD context as it is made', () => {
    expect(PEN).toBeGreaterThanOrEqual(1)
    expect(PEN).toBeLessThan(1.5)
    expect(source).toMatch(/\nhud_pen\(hctx\);\nlet HW=innerWidth, HH=innerHeight;/)
  })
})
