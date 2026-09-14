// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The HUD's timer (NATOPS A1-F18AC-NFM-000 2.13.4 item 17): Zulu time of day
// at the lower-left corner, removed by REJ 2 and kept by REJ 1. engine.ts
// cannot be imported (WebGL at module scope), so the block is read as text and
// drawn into a recording canvas, as gun-reticle.test.ts does.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
const block = /\n\t\/\/ ---- Zulu time of day[\s\S]*?,ax-84,cy\+7\.2\*ppdv\); \}/.exec(source)?.[0] ?? ''

// Draws the timer at reject level declutter with the wall clock at the given
// UTC time (the local time is deliberately different) and returns the text.
function clock(declutter: number, hours = 5, minutes = 39, seconds = 40): [string, number, number, string][] {
  if (!block) throw new Error('HUD clock block not found in engine.ts')
  const run = new Function('declutter', 'h', 'm', 's', `const text=[]; let align='';
    const hctx={ font:'', fillStyle:'', get textAlign(){ return align; }, set textAlign(v){ align=v; }, fillText(t,x,y){ text.push([t,x,y,align]); } };
    class Date { getUTCHours(){ return h; } getUTCMinutes(){ return m; } getUTCSeconds(){ return s; } getHours(){ return h+1; } getMinutes(){ return m+1; } getSeconds(){ return s+1; } }
    const GR='g', ax=200, cy=400, ppdv=20;
    ${block}
    return text;`) as (d: number, h: number, m: number, s: number) => [string, number, number, string][]
  return run(declutter, hours, minutes, seconds)
}

describe('the HUD clock', () => {
  it('shows Zulu time of day, zero-padded, at the lower-left corner', () => {
    expect(clock(0)).toEqual([['05:39:40Z', 200 - 84, 400 + 7.2 * 20, 'left']])
    expect(clock(0, 23, 0, 7)[0][0]).toBe('23:00:07Z')
  })

  it('survives REJ 1 and goes with REJ 2', () => {
    expect(clock(1)).toHaveLength(1)
    expect(clock(2)).toEqual([])
  })
})
