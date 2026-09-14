// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// A hint that tells the pilot what to fly or roll out on must name the heading
// (#90, #70, #91). The constants in HINT are only dedup keys; the displayed
// line is the `text` override at the call site, which interpolates the live
// figure from the ship or the runway — so the invariant lives at the call site
// and is checked there. engine.ts cannot be imported (it reaches for WebGL at
// module scope), so it is read as text, as hud-catalogue.test.ts does.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')

// hint key -> the heading the line must carry. Nothing else in the catalogue
// belongs here: a hint mid-turn (`brk`, `abeam`, `ninety`, `numbers`) rolls out
// on a heading the NEXT hint names, and technique lines (`donut`, `needle`,
// `floor`) have no heading to give.
const HEADED: Record<string, string> = {
  wake: 'ship_course',          // Case I: up the wake
  roll: 'ship_downwind',        // the break's roll-out
  forty: 'ship_groove',         // the 45, straightening into the groove
  clearing: 'ship_course',     // the Case I departure parallels the ship's course
  final: 'ship_groove',         // Case II: level on final
  stack: 'ship_groove',         // Case III: the marshal's final bearing
  push: 'ship_groove',          // commencing: the letdown turns inbound
  gate: 'ship_groove',          // 10 NM: final bearing
  wave: 'ship_groove',          // wave-off: up the angled deck
  bolt: 'ship_downwind',        // bolter: climb, then turn downwind
  depart: 'runway_heading',     // climb out on the runway heading
  initial: 'runway_heading',    // initial, over the runway
  downwind: 'runway_reciprocal',// the field break's roll-out
  papi: 'runway_heading',       // final
  around: 'runway_heading',     // go around: climb straight ahead
}

// Every `hint(...)` call for a key, whole — found by balancing parentheses from
// the opening one, because a plain regex stops at the first `)` inside the
// interpolation. The key is matched to its delimiter so `roll` does not claim
// `rollout`, and all of a key's sites are returned: a hint raised from two
// places must carry its heading at both.
const calls = (key: string) => {
  const found: string[] = []
  for (const opening of source.matchAll(new RegExp(`hint\\(HINT\\.${key}(?=[,)])`, 'g'))) {
    const start = opening.index
    let depth = 0
    for (let at = source.indexOf('(', start); at < source.length; at++) {
      if (source[at] === '(') depth++
      else if (source[at] === ')' && --depth === 0) { found.push(source.slice(start, at + 1)); break }
    }
  }
  return found
}

describe('hint roll-out headings', () => {
  it('finds every headed hint at a call site', () => {
    expect(Object.keys(HEADED).filter(key => calls(key).length === 0)).toEqual([])
  })

  for (const [key, heading] of Object.entries(HEADED)) {
    it(`${key} names its heading with ${heading}()`, () => {
      const sites = calls(key)
      expect(sites.length).toBeGreaterThan(0)
      for (const site of sites) expect(site).toContain(`${heading}()`)
    })
  }

  it('every heading helper is used by at least one hint', () => {
    const used = new Set(Object.values(HEADED))
    for (const helper of ['ship_course', 'ship_downwind', 'ship_groove', 'runway_heading', 'runway_reciprocal']) {
      expect(used.has(helper), `${helper} is defined but no hint carries it`).toBe(true)
    }
  })
})
