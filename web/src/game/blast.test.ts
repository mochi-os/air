// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BLAST_REACH } from './audio'
import { blast_plan, Blasts, LADDER, SOUND } from './blast'

// engine.ts cannot be imported (WebGL at module scope): the scenario's engine
// half is read from its source, and lift cuts one top-level function out.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
function lift(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  expect(start, `${name} in engine.ts`).toBeGreaterThan(0)
  const rest = source.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  return end ? rest.slice(0, end.index + 1) : rest
}

describe('the explosion scenario reads its plan from the URL', () => {
  it('is off unless asked for', () => {
    expect(blast_plan(null)).toBeNull()
  })

  it('flies the ladder, close to far and then a death, for 1 or an empty value', () => {
    const ladder = [
      { distance: 9, death: false },
      { distance: 150, death: false },
      { distance: 600, death: false },
      { distance: 3000, death: false },
      { distance: 9, death: true },
    ]
    expect(blast_plan('1')).toEqual(ladder)
    expect(blast_plan('')).toEqual(ladder)
    expect(blast_plan(LADDER)).toEqual(ladder)
  })

  it('takes a list of its own and drops what no burst can be', () => {
    expect(blast_plan(' 20, 600 ,Death')).toEqual([
      { distance: 20, death: false },
      { distance: 600, death: false },
      { distance: 9, death: true },
    ])
    // Nothing closer than a metre, nothing past where a burst is heard at all.
    expect(blast_plan(`abc,0,-5,,${BLAST_REACH + 1},${BLAST_REACH}`)).toEqual([
      { distance: BLAST_REACH, death: false },
    ])
    expect(blast_plan('abc,0')).toBeNull()
  })
})

describe('the scenario paces its bursts so each report is heard alone', () => {
  it('starts on time and waits for each report to land and die away', () => {
    const blasts = new Blasts(blast_plan('9,3000,death')!, 3)
    expect(blasts.due(2.9)).toBeNull()
    expect(blasts.due(3)).toEqual({ distance: 9, death: false })
    expect(blasts.due(3.1)).toBeNull() // once only
    // The next flash waits for this report's flight, the buffer's 2.2 s and a
    // 2 s gap: a burst 3 km off is heard almost nine seconds after its flash.
    const second = 3 + 9 / SOUND + 2.2 + 2
    expect(blasts.due(second - 0.01)).toBeNull()
    expect(blasts.due(second)).toEqual({ distance: 3000, death: false })
    const third = second + 3000 / SOUND + 2.2 + 2
    expect(blasts.due(third - 0.01)).toBeNull()
    expect(blasts.due(third)).toEqual({ distance: 9, death: true })
    // Round again, for as long as the pilot wants to listen.
    expect(blasts.due(third + 9 / SOUND + 4.2)).toEqual({ distance: 9, death: false })
  })

  it('tells the pilot which burst this is and when its report lands', () => {
    const blasts = new Blasts(blast_plan('600,death')!, 3)
    expect(blasts.label(0.5)).toBe('blast in 3 s')
    blasts.due(3)
    expect(blasts.label(3)).toBe('blast 1 of 2: 600 m, heard in 1.8 s')
    expect(blasts.label(3 + 600 / SOUND + 0.1)).toBe('blast 1 of 2: 600 m')
    blasts.due(20)
    expect(blasts.label(20.5)).toBe('blast 2 of 2: death: heater at 9 m and own fireball')
  })
})

describe('the engine sets the scenario off for real', () => {
  // A stand-in jet at the origin, nose along +x and right wing along +z, and a
  // stand-in explosion_at that records where each burst went and what kind.
  const fired = (blast: { distance: number; death: boolean }) => {
    const bursts: (number | string | undefined)[][] = []
    const ownship = { pos: { x: 0, y: 0, z: 0 }, fwd: { x: 1, y: 0, z: 0 }, right: { x: 0, y: 0, z: 1 } }
    new Function('ownship', 'explosion_at', 'blast', `${lift('blast_fire')}\nblast_fire(blast);`)(
      ownship,
      (x: number, y: number, z: number, kind?: string) =>
        bursts.push([Math.round(x * 10) / 10, y, Math.round(z * 10) / 10, kind]),
      blast
    )
    return bursts
  }

  it('places a burst ahead of the nose and thirty degrees right, at its distance', () => {
    expect(fired({ distance: 600, death: false })).toEqual([[519.6, 0, 300, undefined]])
  })

  it("plays a death as the heater's burst and the jet's own muffled fireball", () => {
    expect(fired({ distance: 9, death: true })).toEqual([
      [7.8, 0, 4.5, undefined],
      [0, 0, 0, 'own'],
    ])
  })

  it('reads the plan at each mission start and paces it on that mission', () => {
    expect(source).toMatch(/\n\tblast_list=blast_plan\(devq\.get\("blast"\)\); blasts=null;/)
    expect(source).toMatch(
      /if\(blast_list\)\{ if\(!blasts\) blasts=new Blasts\(blast_list,sim_time\+3\); const b=blasts\.due\(sim_time\); if\(b\) blast_fire\(b\); \}/
    )
    expect(source).toMatch(/if\(blasts\) hctx\.fillText\(blasts\.label\(sim_time\), 14, 82\);/)
  })
})
