// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The HUD's timer (NATOPS A1-F18AC-NFM-000 2.13.4 item 17): the ET stopwatch
// from mission start at the lower-left corner, removed by REJ 2 and kept by
// REJ 1. engine.ts cannot be imported (WebGL at module scope), so the block is
// read as text and drawn into a recording canvas, as gun-reticle.test.ts does.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
const block = /\n\t\/\/ ---- elapsed time[\s\S]*?,ax-84,cy\+7\.2\*ppdv\); \}/.exec(source)?.[0] ?? ''

// Draws the timer at reject level declutter with the sim clock the given
// seconds past mission start, and returns the text. The wall clock is a trap:
// the timer reads the sim clock, never the time of day.
function clock(declutter: number, seconds = 602, zero = 1000): [string, number, number, string][] {
  if (!block) throw new Error('HUD clock block not found in engine.ts')
  const run = new Function('declutter', 'sim_time', 'mission_zero', `const text=[]; let align='';
    const hctx={ font:'', fillStyle:'', get textAlign(){ return align; }, set textAlign(v){ align=v; }, fillText(t,x,y){ text.push([t,x,y,align]); } };
    class Date { constructor(){ throw new Error('the HUD timer read the wall clock'); } }
    const GR='g', ax=200, cy=400, ppdv=20;
    ${block}
    return text;`) as (d: number, t: number, z: number) => [string, number, number, string][]
  return run(declutter, zero + seconds, zero)
}

describe('the HUD clock', () => {
  it('shows elapsed time from mission start, zero-padded, at the lower-left corner', () => {
    expect(clock(0)).toEqual([['10:02ET', 200 - 84, 400 + 7.2 * 20, 'left']])
    expect(clock(0, 7)[0][0]).toBe('00:07ET')
    expect(clock(0, 3599.9)[0][0]).toBe('59:59ET')
  })

  it('prefixes the hour once there is one', () => {
    expect(clock(0, 3600)[0][0]).toBe('1:00:00ET')
    expect(clock(0, 20380)[0][0]).toBe('5:39:40ET')
  })

  it('reads zero before the mission clock starts', () => {
    expect(clock(0, -30)[0][0]).toBe('00:00ET')
  })

  it('survives REJ 1 and goes with REJ 2', () => {
    expect(clock(1)).toHaveLength(1)
    expect(clock(2)).toEqual([])
  })
})
