// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The BINGO FUEL and FUEL LO calls are crossings of the tank through a level,
// so they need a real reading behind them. Joining a match the core runs on a
// zero tank until the welcome's state lands, and that zero is unread, not
// empty: it must not read as a fall from full. engine.ts cannot be imported
// (WebGL at module scope), so the fuel block of sync_core is read as text and
// stepped against a stand-in jet, as trim-law.test.ts does.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
const block = /\n\t\{ const read=fuel_read, beforeInternal=[\s\S]*?notice\(translate\("FUEL LO"\)\); \} \}/.exec(source)?.[0] ?? ''

// Feeds the core's tank readings [internal, external] in kg frame by frame and
// returns the calls made; reset() starts a fresh mission on the same jet.
function tank() {
  if (!block) throw new Error('fuel block not found in engine.ts')
  const run = new Function('readings', 'reset', `const ownship={}, STATE={fuel:0, external:1}, BINGO=1361, FUELLO=726, calls=[];
    const cheat=()=>false, translate=(t)=>t, notice=(t)=>calls.push(t);
    let fuel_read=false;
    return readings.map((out)=>{ if(out===reset){ fuel_read=false; return null; } ${block} return calls.splice(0); });`)
  const reset = Symbol('reset')
  return { reset, feed: (...readings: (number[] | symbol)[]) => (run(readings, reset) as (string[] | null)[]).filter((c) => c !== null).flat() }
}

describe('the fuel calls', () => {
  it('say nothing while a joined match runs on the unread tank, then reads the real load', () => {
    const { feed, reset } = tank()
    expect(feed([0, 0], [0, 0], [2100, 0], [4899, 0])).toEqual([])
    // The second match of a session: the jet still holds the last flight's tank,
    // and the unread zero must not read as a fall from it.
    expect(feed([4000, 0], reset, [0, 0], [0, 0], [2100, 0], [4899, 0])).toEqual([])
  })

  it('call BINGO FUEL and FUEL LO on the way down through each level', () => {
    const { feed } = tank()
    expect(feed([2450, 0], [1300, 0], [900, 0], [700, 0])).toEqual(['BINGO FUEL', 'FUEL LO'])
  })

  it('count the externals for bingo, and only the internal tank for FUEL LO', () => {
    const { feed } = tank()
    expect(feed([1000, 500], [1000, 300])).toEqual(['BINGO FUEL'])
    expect(feed([1000, 300], [700, 300])).toEqual(['FUEL LO'])
  })

  it('treat a light spawn load as a state the legend shows, not a fall from full', () => {
    const { feed } = tank()
    expect(feed([952, 0], [950, 0])).toEqual([])
    expect(feed([952, 0], [600, 0])).toEqual(['FUEL LO'])
  })

  it('start the next mission afresh, so its first reading is not a crossing from the last flight', () => {
    const { feed, reset } = tank()
    expect(feed([4000, 0], reset, [900, 0], [890, 0])).toEqual([])
    expect(source).toMatch(/mission_zero=sim_time; fuel_read=false;/)
  })
})
