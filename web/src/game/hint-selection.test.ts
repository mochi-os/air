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
    // is the LAUNCH set's, and it keeps it through the departure it coaches.
    expect(watch).toMatch(/st==="carrier"&&!ship_left\) return hints_launch\(ship\)/)
  })

  it('re-arms that latch with the rest of the hint state on a restart', () => {
    expect(source).toMatch(/field_left=ship_left=false/)
    // A respawn onto the cat with the last shot's stroke still recorded would
    // raise the hand-off-stick line in the holdback.
    expect(source).toMatch(/field_left=ship_left=false; stroked=false; rising=null;/)
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

describe('the Case I pattern does not coach a departure', () => {
  const carrier = body('hints_carrier')

  it('opens the side, break and on-speed lines only at pattern height', () => {
    // Once the launch set hands a departing jet over, a climb-out on the ship's
    // course is nearer the ship than the island, and these three had no height
    // of their own: the climb-out was told to hold 800' and break.
    expect(carrier).toMatch(/const low=feet<1150;/)
    expect(carrier).toMatch(/if\(low&&along>-1400&&along<\d+&&fdot>0\.3&&!hinted\[HINT\.brk\]\) hint\(HINT\.side\)/)
    expect(carrier).toMatch(/if\(low&&range<950\) hint\(HINT\.brk\)/)
    expect(carrier).toMatch(/if\(low&&down\) hint\(HINT\.donut\)/)
  })

  it('stops coaching the side once the jet is past the bow', () => {
    // A low departure ahead of the ship flies its course too.
    expect(carrier).toMatch(/along>-1400&&along<\d+&&fdot>0\.3/)
  })
})

describe('the break stands on the glass until the roll-out', () => {
  const runway = body('hints_runway')
  const carrier = body('hints_carrier')

  it('holds the roll-out and the dirty-up calls until the nose has come round', () => {
    // Keyed on the break alone, the field's roll-out call replaced the break
    // in the frame it fired, and a break flown below 285 knots lost its line
    // to the dirty-up call the same way, on both surfaces.
    expect(runway).toMatch(/if\(\(hinted\[HINT\.brk\]&&fdot<-0\.7\)\|\|circuit\) hint\(HINT\.downwind,/)
    expect(runway).toMatch(/if\(hinted\[HINT\.downwind\]&&kt<285&&!down\) hint\(HINT\.dirty\);/)
    expect(carrier).toMatch(/if\(hinted\[HINT\.roll\]&&kt<285&&!down\) hint\(HINT\.form\);/)
  })

  it('retires only the lines a surface raised itself', () => {
    // The break and the 90 are one key in both patterns, and each surface's
    // 6 NM retirement took the other surface's break and 90 down every frame.
    expect(source).toMatch(/hint_rows=rows; hint_key=key; hint_since=sim_time; hint_set=hinting;/)
    expect(runway).toMatch(/^unction hints_runway\(st\)\{ hinting="runway";/)
    expect(carrier).toMatch(/^unction hints_carrier\(st\)\{ hinting="carrier";/)
    expect(body('hints_launch')).toMatch(/^unction hints_launch\(ship\)\{ hinting="launch";/)
    expect(watch).toMatch(/if\(ship>6\*1852&&hint_set!=="runway"\) hint_retire\(\.\.\.CIRCUIT,HINT\.side,\.\.\.LAUNCH\);/)
    expect(watch).toMatch(/if\(field>6\*1852&&hint_set==="runway"\) hint_retire\(\.\.\.RUNWAY\);/)
  })
})

describe('the Case III letdown is coached where the marshal procedure flies it', () => {
  const carrier = body('hints_carrier')

  it('reaches every Case III rung from outside the pattern', () => {
    // The commence is called at 20 NM, the platform at 5,000 ft and the
    // dirty-up at 10 NM. A range return ahead of the case3 branch - the 6 NM
    // guard the visual pattern needs - left every one of them unreachable.
    const branch = carrier.indexOf('kase==="case3"')
    expect(branch, 'no case3 branch').toBeGreaterThan(0)
    expect(carrier.slice(0, branch)).not.toMatch(/if\(range>[^)]*\)\s*return/)
  })

  it('still holds the visual pattern inside 6 NM', () => {
    expect(carrier).toMatch(/kase==="case1"&&range<=6\*1852/)
  })
})

describe('the catapult launch is coached, and owns the centre banner it replaced', () => {
  const launch = body('hints_launch')

  it('exists', () => {
    expect(launch).not.toBe('')
  })

  it('hands the deck start over on HALF flap, as the clean-up line assumes', () => {
    // NATOPS 8.2.5 charts launch trim for HALF flaps, the core latches HALF on
    // deck (flight/fcs.go halfleg), and the clean-up says "flaps to auto" - a
    // switch left in AUTO on the cat read wrong on the legend and made that
    // line an instruction to do nothing.
    expect(source).toMatch(/flap_select=\(st==="case2"\)\?2:\(st==="runway"\|\|st==="carrier"\)\?1:0;/)
  })

  it('walks the sequence: tension, salute, the shot, the clean-up, the departure', () => {
    for (const key of ['tension', 'salute', 'flyaway', 'positive', 'clearing', 'climb']) {
      expect(launch, `${key} never raised`).toMatch(new RegExp(`hint\\(HINT\\.${key}`))
    }
  })

  it('lets the run-up and shot lines follow the throttle both ways', () => {
    // The jet is handed over at military, so the shot line is spent at the
    // hookup, and a pilot who came off power and ran back up was left reading
    // the run-up instruction. Each line has to re-arm the other.
    expect(launch).toMatch(/ls===1\)\{\s*delete hinted\[HINT\.salute\]/)
    expect(launch).toMatch(/ls===2\)\{\s*delete hinted\[HINT\.tension\]/)
  })

  it('takes the deck lines down when the crew unhooks the jet without a shot', () => {
    // A tension abort or a taxi off the shuttle ends the hookup, and nothing
    // else retires "Hooked up" while the jet sits on the deck. The stroke ends
    // the hookup too and must not count: the flyaway line waits on the salute.
    expect(launch).toMatch(/hooked&&ls===0&&!ownship\.launching\)\{\s*hint_retire\(HINT\.tension,HINT\.salute\)/)
    // Forgotten as well as retired, so a jet that hooks up again is coached again.
    expect(launch).toMatch(/delete hinted\[HINT\.tension\];\s*delete hinted\[HINT\.salute\]/)
    // Latched from the core only: the spot-based reading before it runs, then
    // the core's free jet until weight-on-wheels, looked like an unhook at spawn.
    expect(launch).toMatch(/hooked=flight_active&&ls>0;/)
  })

  it('reads the run-up power off the same weight board the kneeboard does', () => {
    // NATOPS 8.2.7: MAX at and above 45,000 lb, pilot's choice below. A hint
    // that named one power for every weight would contradict the CAT line on
    // the kneeboard three inches away.
    expect(launch).toMatch(/gross_weight\(\)>=45000/)
  })

  it('takes the hand off the stick for the stroke and puts it back on a positive rate', () => {
    // NATOPS 8.2.8: throttles held, the stick left alone while the jet rotates
    // itself, the gear up once a positive rate of climb is established. The
    // old lines put the hand back on the stick first and the gear call last.
    expect(source).toMatch(/salute:"Throttles held, head back, hand off stick;/)
    expect(source).toMatch(/flyaway:"Off the cat: hand off stick,/)
    expect(source).toMatch(/positive:"Positive rate: take stick, gear up, flaps auto"/)
  })

  it('keys the shot lines on the stroke and the climb rate, not a height above the deck', () => {
    // A military-power shot settles below the deck off the bow, and the old
    // deck + 50 ft and + 200 ft gates held the lines six and nine seconds late.
    expect(launch).not.toMatch(/CARRIER\.deckY/)
    expect(launch).toMatch(/if\(ownship\.launching\) stroked=true;/)
    expect(launch).toMatch(/if\(!ownship\.launching\) hint\(HINT\.flyaway\);/)
    expect(launch).toMatch(/\(ownship\.vely\?\?0\)>0\.508/)
    expect(launch).toMatch(/sim_time-rising>=1&&\(hint_key!==HINT\.flyaway\|\|sim_time-hint_since>=2\)\) hint\(HINT\.positive\)/)
  })

  it('shows the departure once clean, after the gear call has been read', () => {
    expect(launch).toMatch(/const clean=\(ownship\.gearTarget\?\?0\)>0\.5&&flap_select===0;/)
    expect(launch).toMatch(/hinted\[HINT\.positive\]&&clean&&\(hint_key!==HINT\.positive\|\|sim_time-hint_since>=3\)\) hint\(HINT\.clearing,"Clearing turn "\+\(cat_idx<2\?"right":"left"\)/)
  })

  it('ends the departure at 7 miles, or when the pilot leaves it', () => {
    // Each minimum read is the slot's age at the moment of the test: a single
    // age taken at the top of the set was the previous line's, and it took the
    // climb call down in the frame that raised it.
    expect(launch).not.toMatch(/const age=/)
    // P-816 Case I: 500' and 300 knots paralleling the ship's course to 7 DME.
    expect(launch).toMatch(/if\(ship>7\*1852\) hint\(HINT\.climb\);/)
    expect(launch).toMatch(/else if\(feet>3000\|\|course<0\)\{ hint_retire\(HINT\.clearing\); ship_left=true; \}/)
    expect(launch).toMatch(/if\(hinted\[HINT\.climb\]&&hint_key!==HINT\.climb\) ship_left=true;/)
    expect(launch).toMatch(/if\(!hinted\[HINT\.clearing\]&&\(ship>7\*1852\|\|feet>3000\)\)\{ hint_retire\(\.\.\.LAUNCH\); ship_left=true; \}/)
    expect(watch).not.toMatch(/ship_left=true/)
  })

  it('reads every line for five seconds unless it waits on the pilot', () => {
    // One standard display time, applied where every set is dispatched, so a
    // line with nothing to wait for cannot stand on the glass for minutes.
    expect(source).toMatch(/const HINT_DWELL=5;/)
    expect(watch).toMatch(/if\(hint_key!=null&&!WAITING\.has\(hint_key\)&&sim_time-hint_since>=HINT_DWELL\) hint_rows=hint_key=null;/)
    // The lines whose end the sets track from the pilot doing what they say.
    const waiting = source.match(/const WAITING=new Set\(\[([^\]]*)\]\)/)?.[1] ?? ''
    expect(waiting.split(',').map((key) => key.replace('HINT.', '')).sort()).toEqual(
      ['brk', 'cleanup', 'depart', 'dirty', 'flyaway', 'form', 'lineup', 'positive', 'rollout', 'rotate', 'salute', 'tension'],
    )
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

  it('retires its deck lines on leaving the ship', () => {
    // Nothing downstream replaces the clean-up line if the pilot never flies it (#189).
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
