// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Which hint set coaches, and how a pilot gets INTO it (#204, #205). Both were
// reported the same way: a flight that earned coaching and got none. engine.ts
// cannot be imported (WebGL at module scope), so it is read as text, as
// hint-headings.test.ts and hud-catalogue.test.ts do.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')

// The body of one top-level `function name(` up to the next one, so an
// assertion about hints_watch cannot be satisfied by hints_runway.
// Returns '' when the function is absent rather than throwing, so a missing
// function fails the assertions that depend on it one by one instead of
// collapsing the whole file into a collection error — which is what a negative
// control run against the pre-fix source produces.
function body(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) return ''
  const rest = source.slice(start + 1)
  const end = rest.search(/\nfunction \w+\(/)
  return end < 0 ? rest : rest.slice(0, end)
}

const watch = body('hints_watch')

describe('the arrival set follows the jet, not the Start selector (#204)', () => {

  it('does not choose the set from the mission start', () => {
    // The defect: `if(st!=="case1"&&st!=="case2"&&st!=="case3"){ hints_runway(st); return; }`
    // A carrier launch to an island landing took the runway branch on the deck
    // and the carrier branch nowhere, and was coached at neither end.
    expect(watch).not.toMatch(/st!=="case1"/)
  })

  it('measures both surfaces and hands the arrival to the nearer one', () => {
    expect(watch).toMatch(/ownship\.pos\.x-CARRIER\.x/)
    expect(watch).toMatch(/ownship\.pos\.x-ap\.start\.x/)
    expect(watch).toMatch(/field<=ship\s*\?|if\(field<=ship\)/)
  })

  it('still has a field to compare against when the map carries no airport', () => {
    expect(watch).toMatch(/:\s*Infinity/)
  })

  it('holds the recovery pattern off until the jet has left the ship it launched from', () => {
    // Without this a cat shot is told to break over the bow it just crossed —
    // the ship analogue of #196, where the arrival set armed during the
    // takeoff climb-out and told a departing pilot to lower the gear. The deck
    // is the LAUNCH set's, and it keeps it until the jet is clear of the ship.
    expect(watch).toMatch(/st==="carrier"&&!ship_left\) return hints_launch\(\)/)
  })

  it('re-arms that latch with the rest of the hint state on a restart', () => {
    expect(source).toMatch(/field_left=ship_left=false/)
  })
})

describe('a mission that briefed no recovery still gets one (#204)', () => {
  const carrier = body('hints_carrier')

  it('exists as a set of its own', () => {
    expect(carrier).not.toBe('')
  })

  it('resolves a case for every start, defaulting to the visual pattern', () => {
    expect(carrier).toMatch(/const kase=\(st==="case2"\|\|st==="case3"\)\?st:"case1"/)
  })

  it('reads the resolved case in every branch, never the raw start', () => {
    // A deck launch, a runway departure and a free flight are all st values
    // that match no case, so a branch left on `st` is a branch that never runs
    // for them — which is how the deck-start bolter (#190) kept a line that
    // nothing could retire.
    for (const k of ['case1', 'case2', 'case3']) {
      expect(carrier, `${k} branch still keyed on st`).not.toMatch(
        new RegExp(`if\\(st==="${k}"`),
      )
      expect(carrier).toMatch(new RegExp(`kase==="${k}"`))
    }
  })
})

describe('the catapult launch is coached, and owns the centre banner it replaced', () => {
  const launch = body('hints_launch')

  it('exists', () => {
    expect(launch).not.toBe('')
  })

  it('walks the deck sequence: tension, salute, the shot, the clean-up', () => {
    for (const key of ['tension', 'salute', 'flyaway', 'cleanup']) {
      expect(launch, `${key} never raised`).toMatch(new RegExp(`hint\\(HINT\\.${key}`))
    }
  })

  it('reads the run-up power off the same weight board the kneeboard does', () => {
    // NATOPS 8.2.7: MAX at and above 45,000 lb, pilot's choice below. A hint
    // that named one power for every weight would contradict the CAT line on
    // the kneeboard three inches away.
    expect(launch).toMatch(/gross_weight\(\)>=45000/)
  })

  it('takes the hands off for the stroke and puts them back for the climb-out', () => {
    // Both halves matter and they are on DIFFERENT lines: off the controls for
    // the shot, back on once the jet is flying. Asserting "hands off" alone
    // would now match the salute and pass whatever the flyaway said.
    expect(source).toMatch(/salute:"Hands off flight controls/)
    expect(source).toMatch(/flyaway:"Hands on controls/)
  })

  it('names the attitude the law actually captures', () => {
    // fa18c.go sets Control.Flyaway to 16 degrees for this jet's weight row.
    // The runway set's 8 degrees is the ROTATION, a different number.
    expect(source).toMatch(/flyaway:"[^"]*16\\u00b0 nose up/)
  })

  it('leaves the centre banner to a pilot who turned coaching off', () => {
    // The prompts moved to the coaching slot, but they are also the only thing
    // naming the key that fires the shot, so hints=off must still get them.
    expect(source).toMatch(/net_notice_t<=0&&cfg\.hints===false/)
  })

  it('retires its last line on leaving the ship', () => {
    // The clean-up is the set's last, and nothing downstream replaces it (#189).
    expect(source).toMatch(/const LAUNCH=\[/)
    expect(watch).toMatch(/\.\.\.LAUNCH/)
  })
})

describe('the straight-in can reach the runway set (#205)', () => {
  const runway = body('hints_runway')

  it('has an entry that is on the axis, inbound, before the threshold and descending', () => {
    const straight = runway.match(/const straight=(.+)/)?.[1] ?? ''
    expect(straight, 'no straight-in entry').not.toBe('')
    expect(straight).toMatch(/fdot>0\.[5-9]/) // inbound on the runway heading
    expect(straight).toMatch(/along<-\d/) //     short of the threshold
    expect(straight).toMatch(/lateral</) //      on the centreline
    expect(straight).toMatch(/feet</) //         descending, not overflying
  })

  it('joins at the configuration rung rather than re-flying a pattern', () => {
    // The break, the downwind and the 90 do not exist on a straight-in, so the
    // entry has to hand straight to gear/flaps and on-speed.
    expect(runway).toMatch(/straight&&!hinted\[HINT\.initial\]&&!hinted\[HINT\.downwind\]/)
    expect(runway).toMatch(/hint\(HINT\.dirty\)/)
    expect(runway).toMatch(/hint\(HINT\.donut\)/)
  })

  it('reaches the final call without having flown the 90', () => {
    const groove = runway.match(/const groove=(.+)/)?.[1] ?? ''
    expect(groove, 'papi still gated on the 90 alone').not.toBe('')
    expect(groove).toMatch(/straight/)
  })

  it('reaches the touchdown call from an arrival that never got a final', () => {
    expect(runway).toMatch(/hinted\[HINT\.papi\]\|\|hinted\[HINT\.donut\]/)
  })
})
