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
// FUEL LO's condition, either feed tank down to 800 lb in the tanks' apportionment (NATOPS 2.2.8), with what it reads.
const feeds = [/\nconst FUEL_TANKS=[^\n]*\n/, /\nfunction fuel_tanks\(internal,external,aboard\)\{[\s\S]*?\n(?=\S)/, /\nconst FEED_LOW=[^\n]*\n/, /\nfunction feed_low\(kg\)\{[^\n]*\n/]
  .map((pattern) => pattern.exec(source)?.[0] ?? '').join('') + 'const THREE={ MathUtils:{ clamp:(v,lo,hi)=>Math.min(hi,Math.max(lo,v)) } };'

// Feeds the core's tank readings [internal, external] in kg frame by frame and
// returns the calls made; reset() starts a fresh mission on the same jet.
function tank() {
  if (!block || !feeds.includes('feed_low')) throw new Error('fuel block not found in engine.ts')
  const run = new Function('readings', 'reset', `const ownship={}, STATE={fuel:0, external:1}, BINGO=1361, calls=[]; ${feeds}
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
    expect(tank().feed([1300, 0], [900, 0])).toEqual(['FUEL LO']) // 900 kg is 1,984 lb: the right feed tank is down to 800 lb
  })

  it('judge BINGO FUEL and FUEL LO on the internal tanks alone (NATOPS 2.2.10.4)', () => {
    const { feed } = tank()
    expect(feed([1500, 800], [1300, 800])).toEqual(['BINGO FUEL']) // internal crosses the setting with the external tanks still holding fuel
    expect(feed([1000, 500], [1000, 300])).toEqual([]) // the external tanks drain past the setting while internal holds
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

// NATOPS 2.2.10.4: the BINGO caution appears when the INTERNAL fuel quantity
// reaches the pilot's setting; the voice, the dump cut-off and the HUD legend
// follow the caution. Each judgement is lifted from engine.ts and run with the
// external tanks holding fuel and internal below the setting, and the reverse.
describe('the BINGO judgements', () => {
  const lb = 2.20462
  const lift = (pattern: RegExp) => pattern.exec(source)?.[0] ?? ''
  const low = lift(/\nfunction bingo_low\(\)\{[^\n]*\n[^\n]*\n/)
  const caution = lift(/\n\tlet low=false, below=false;[\s\S]*?\n\t\tif\(below\) push\("BINGO"\); \}/)
  const colour = lift(/\n\t\tif\(fuel_lo\.on\) hctx\.fillStyle=[^\n]*\n[^\n]*<BINGO\) hctx\.fillStyle="#ffb050";/)
  const tanks = { below: { fuel: 1200, external: 2000 }, above: { fuel: 1500, external: 0 } } // kg, the setting 3,000 lb (1,361 kg)

  it('drives the FUEL page, the DUMP cut-off and the HUD legend from internal fuel', () => {
    expect(low).not.toBe('')
    const run = (ownship: object) => new Function('ownship', `const fuel_state={ bingo:3000 }, cheat=()=>false, flight_active=true; ${low} return bingo_low();`)(ownship) as boolean
    expect(run(tanks.below)).toBe(true)
    expect(run(tanks.above)).toBe(false)
    expect(3000 / lb).toBeGreaterThan(tanks.below.fuel) // the setting sits between the two internal loads
  })

  it('raises the BINGO caution on internal fuel', () => {
    expect(caution).not.toBe('')
    const run = (ownship: object) => new Function('ownship', `const fuel_lo={ on:false }, BINGO=1361, cheat=()=>false, flbit_lit=()=>false, rows=[], push=(k)=>rows.push(k); ${caution} return rows;`)(ownship) as string[]
    expect(run(tanks.below)).toEqual(['BINGO'])
    expect(run(tanks.above)).toEqual([])
  })

  it('colours the fuel readout for BINGO on internal fuel', () => {
    expect(colour).not.toBe('')
    const run = (ownship: object, low = false) => new Function('ownship', `const fuel_lo={ on:${low} }, BINGO=1361, sim_time=0, hctx={ fillStyle:"g" }; ${colour} return hctx.fillStyle;`)(ownship) as string
    expect(run(tanks.below)).toBe('#ffb050')
    expect(run(tanks.above)).toBe('g')
    expect(run(tanks.above, true)).toBe('#ff5050') // FUEL LO flashes it, from the feed tanks
  })
})

// NATOPS 2.2.10.4: BINGO is a DDI caution with a voice alert; the HUD draws no
// BINGO legend in either first-person view.
describe('the BINGO annunciation', () => {
  it('stays off the HUD', () => {
    const start = source.indexOf('if(flight_symbols){'), end = source.indexOf('// end of the instrument cluster', start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    expect(source.slice(start, end)).not.toMatch(/fillText\("BINGO"/)
  })
})


// NATOPS 2.2.8: FUEL LO is the feed tanks' low-level sensors - on when either
// feed tank is down to 800 lb (the right feed, the smaller, at about 1,990 lb of
// internal fuel in the apportionment), and on for at least a minute from coming
// on however brief the cause. fuel_low_step is stepped against a stand-in jet.
describe('the FUEL LO condition', () => {
  const state = /\nconst FEED_LOW=[\s\S]*?\nfunction fuel_low\(\)\{[^\n]*\n/.exec(source)?.[0] ?? ''
  const lb = 2.20462
  // steps: [sim time, internal pounds, cheat?, flbit?]; returns FUEL LO at each
  const run = (steps: [number, number, boolean?, boolean?][]) => new Function('steps', `${feeds.replace(/\nconst FEED_LOW=[^\n]*\n|\nfunction feed_low\(kg\)\{[^\n]*\n/g, '')} let sim_time=0, cheating=false, testing=false; const ownship={}, cheat=()=>cheating, flbit_lit=()=>testing; ${state}
    return steps.map(([t,pounds,c,f])=>{ sim_time=t; ownship.fuel=pounds/${lb}; cheating=!!c; testing=!!f; fuel_low_step(); return fuel_low(); });`)(steps) as boolean[]

  it('comes on with a feed tank at 800 lb, stepped with the cautions', () => {
    expect(state).not.toBe('')
    expect(source).toMatch(/\nfunction cautions_update\(\)\{\n\tfuel_low_step\(\);/)
    expect(run([[0, 1995], [1, 1985]])).toEqual([false, true])
  })

  it('holds a minute from coming on, however brief the cause, and as long as the cause lasts', () => {
    expect(run([[0, 1985], [10, 3000], [59, 3000], [61, 3000]])).toEqual([true, true, true, false])
    expect(run([[0, 1985], [120, 1900], [121, 3000]])).toEqual([true, true, false])
  })

  it('stays off with the tank frozen, and adds a fuel low BIT\'s', () => {
    expect(run([[0, 1500, true]])).toEqual([false])
    expect(run([[0, 3000, false, true]])).toEqual([true])
  })
})
