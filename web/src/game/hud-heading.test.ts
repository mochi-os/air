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
