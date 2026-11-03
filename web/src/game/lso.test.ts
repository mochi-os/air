// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ONSPEED,
  pass_grade,
  pass_ramp,
  pass_sample,
  pass_start,
  pass_wire,
  points,
  remarks,
  segment_of,
  tally,
  type Pass,
} from './lso'

// A pass flown from the start to the wire with the given deviations per
// segment: [glideslope °, lateral m (+ left), alpha °, settle m/s]. A segment
// left out is flown clean and on speed.
function flown(
  deviations: Partial<
    Record<'X' | 'IM' | 'IC' | 'AR', [number, number, number, number?]>
  >
): Pass {
  const pass = pass_start()
  const middle = { X: 1500, IM: 900, IC: 400, AR: 150 } as const
  for (const [segment, along] of Object.entries(middle) as [
    'X' | 'IM' | 'IC' | 'AR',
    number,
  ][]) {
    const [glideslope, lateral, alpha, settle] = deviations[segment] ?? [
      0,
      0,
      ONSPEED,
      0,
    ]
    pass_sample(pass, along, glideslope, lateral, alpha, settle ?? 0)
  }
  return pass
}

const soft = { sink: 3, bank: 0, short: -12 }
const grade = (pass: Pass, night = false) =>
  pass_grade(pass, soft, false, 'trap', night).grade

describe('segment_of', () => {
  it('names the parts of the groove by distance short of the touchdown', () => {
    expect(segment_of(1900)).toBeNull()
    expect(segment_of(1500)).toBe('X')
    expect(segment_of(900)).toBe('IM')
    expect(segment_of(400)).toBe('IC')
    expect(segment_of(150)).toBe('AR')
    expect(segment_of(20)).toBeNull()
  })
})

describe('the write-up', () => {
  it('keeps the worst of each kind in each segment, not the average', () => {
    const pass = pass_start()
    pass_sample(pass, 400, 0.1, 0.5, ONSPEED)
    pass_sample(pass, 350, -0.5, 3, ONSPEED)
    pass_sample(pass, 300, 0.2, 1, ONSPEED)
    expect(pass.segments.IC).toEqual({
      glideslope: -0.5,
      lineup: 3,
      speed: 0,
      settle: 0,
    })
    expect(remarks(pass)).toBe('(LO) (LUL) IC')
  })

  it('judges lineup as an angle far out and in metres in close', () => {
    const pass = pass_start()
    pass_sample(pass, 1500, 0, 30, ONSPEED) // 30 m at 1,500 m is 1.1°: a little
    pass_sample(pass, 400, 0, 6, ONSPEED) // 6 m in close is a lot
    expect(remarks(pass)).toBe('(LUL) X · _LUL_ IC')
  })

  it('writes three sizes: a little in parentheses, plain, and a lot underlined', () => {
    expect(
      remarks(
        flown({
          X: [0.5, 0, ONSPEED],
          IM: [0.8, 0, ONSPEED],
          IC: [1.2, 0, ONSPEED],
        })
      )
    ).toBe('(H) X · H IM · _H_ IC')
    expect(
      remarks(flown({ IC: [0, -2.5, ONSPEED], AR: [0, 4, ONSPEED] }))
    ).toBe('(LUR) IC · LUL AR')
    expect(remarks(flown({}))).toBe('')
  })

  it('writes slow as SLO and keeps S for a settle, which it watches only in close', () => {
    expect(
      remarks(flown({ IM: [0, 0, ONSPEED + 0.8], IC: [0, 0, ONSPEED - 1.2] }))
    ).toBe('(SLO) IM · F IC')
    expect(
      remarks(
        flown({
          X: [0, 0, ONSPEED, 3],
          IC: [0, 0, ONSPEED, 1.2],
          AR: [0, 0, ONSPEED, 2],
        })
      )
    ).toBe('(S) IC · S AR')
    expect(remarks(flown({ IC: [0, 0, ONSPEED, -3] }))).toBe('') // sinking slower than the slope is no settle
  })

  it("reads the ramp's glideslope from the hook at the round-down, not the lens geometry", () => {
    // Inside 250 m the hook's angle magnifies centimetres into degrees: what
    // the lens geometry reads there is not written up
    expect(remarks(flown({ AR: [-2.5, 0, ONSPEED] }))).toBe('')
    const pass = flown({})
    pass_ramp(pass, -0.5) // half a metre low over the round-down
    expect(remarks(pass)).toBe('(LO) AR')
    pass_ramp(pass, 1.6)
    expect(remarks(pass)).toBe('_H_ AR')
  })
})

describe('the grade', () => {
  it('grades the approach, not the wire', () => {
    const pass = flown({})
    pass_wire(pass, 0.5)
    expect(grade(pass)).toBe('OK') // whatever wire it caught
  })

  it('gives OK for one little deviation before the ramp, FAIR for two or a plain one, NO GRADE for a lot', () => {
    expect(grade(flown({ IC: [0.5, 0, ONSPEED] }))).toBe('OK')
    expect(
      grade(flown({ X: [0.5, 0, ONSPEED], IM: [0, 0, ONSPEED + 0.8] }))
    ).toBe('FAIR')
    expect(grade(flown({ IM: [0.8, 0, ONSPEED] }))).toBe('FAIR')
    expect(grade(flown({ IM: [1.2, 0, ONSPEED] }))).toBe('NO-GRADE')
    expect(grade(flown({ IC: [0, 0, ONSPEED + 1.6] }))).toBe('NO-GRADE')
  })

  it('gives FAIR for a little at the ramp or in the wires, NO GRADE for plain, CUT for a lot', () => {
    expect(grade(flown({ AR: [0, 2.5, ONSPEED] }))).toBe('FAIR')
    expect(grade(flown({ AR: [0, 4, ONSPEED] }))).toBe('NO-GRADE')
    expect(grade(flown({ AR: [0, 0, ONSPEED + 2] }))).toBe('CUT')
    const low = flown({})
    pass_ramp(low, -0.8) // low over the round-down: into the 1 wire
    expect(grade(low)).toBe('NO-GRADE')
    const wide = flown({})
    pass_wire(wide, -6)
    expect(grade(wide)).toBe('CUT')
  })

  it('cuts a settle at the ramp, a hard, banked or short touchdown, and a trap through a wave-off', () => {
    expect(grade(flown({ AR: [0, 0, ONSPEED, 1.2] }))).toBe('FAIR') // a little settle
    expect(grade(flown({ AR: [0, 0, ONSPEED, 2] }))).toBe('CUT')
    expect(
      pass_grade(flown({}), { sink: 7.5, bank: 0, short: -12 }, false, 'trap')
        .grade
    ).toBe('CUT')
    expect(
      pass_grade(flown({}), { sink: 3, bank: 0.15, short: -12 }, false, 'trap')
        .grade
    ).toBe('CUT')
    expect(
      pass_grade(flown({}), { sink: 3, bank: 0, short: 5 }, false, 'trap').grade
    ).toBe('CUT')
    expect(
      pass_grade(flown({}), { sink: 3, bank: 0, short: 4 }, false, 'trap').grade
    ).toBe('OK')
    expect(pass_grade(flown({}), soft, true, 'trap').grade).toBe('CUT')
  })

  it('keeps the perfect pass for a clean one at night', () => {
    expect(grade(flown({}), true)).toBe('PERFECT')
    expect(grade(flown({}))).toBe('OK')
    expect(grade(flown({ X: [0.5, 0, ONSPEED] }), true)).toBe('OK')
  })

  it('writes a bolter and the wave-offs up without grading them', () => {
    expect(
      pass_grade(flown({ IC: [0.5, 0, ONSPEED] }), null, false, 'bolter')
    ).toEqual({ grade: 'BOLTER', remarks: '(H) IC' })
    expect(
      pass_grade(flown({ IC: [-0.8, 0, ONSPEED] }), null, true, 'waveoff')
    ).toEqual({ grade: 'WAVE OFF', remarks: 'LO IC' })
    expect(
      pass_grade(flown({ IC: [0.8, 0, ONSPEED] }), null, false, 'own')
    ).toEqual({ grade: 'WAVE OFF', remarks: 'OWO · H IC' })
    expect(pass_grade(flown({}), null, false, 'own')).toEqual({
      grade: 'WAVE OFF',
      remarks: 'OWO',
    })
  })

  it("writes a foul deck wave-off up as the deck's, nothing in the pass against the pilot", () => {
    expect(
      pass_grade(flown({ IC: [-1.2, 0, ONSPEED] }), null, true, 'foul')
    ).toEqual({ grade: 'WAVE OFF', remarks: 'WOFD' })
  })
})

describe('the points', () => {
  it('scores each grade as the training command does, and does not count a foul deck', () => {
    expect(points('PERFECT', '')).toBe(5)
    expect(points('OK', '(H) X')).toBe(4)
    expect(points('FAIR', '')).toBe(3)
    expect(points('BOLTER', '')).toBe(2.5)
    expect(points('NO-GRADE', '')).toBe(2)
    expect(points('WAVE OFF', 'OWO')).toBe(2)
    expect(points('WAVE OFF', 'LO IC')).toBe(1)
    expect(points('CUT', '')).toBe(0)
    expect(points('WAVE OFF', 'WOFD')).toBeNull()
    expect(points('', '')).toBeNull()
  })

  it('tallies a sortie: the passes that count, the traps, and the points of those that score', () => {
    const t = tally([
      { grade: 'BOLTER', remarks: '(H) IC', wire: 0 },
      { grade: 'WAVE OFF', remarks: 'WOFD', wire: 0 },
      { grade: 'WAVE OFF', remarks: 'LO IC', wire: 0 },
      { grade: 'OK', remarks: '', wire: 2 },
    ])
    expect(t).toEqual({ passes: 3, traps: 1, points: 7.5, scored: 3 })
  })
})

// The waveoff in the cockpit (#123): the lens's waveoff lights are the LSO's, lit
// for every waveoff he calls, flashing in phase with the call; PADDLES says it on
// the radio once as the call begins; the flashing WAVE OFF banner is HUD-view
// furniture only. engine.ts cannot be imported (WebGL at module scope), so its
// lines are read as text.
describe('the waveoff', () => {
  const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
  const lights = /\n\to\.wavePts\.visible = [^\n]*\n/.exec(source)?.[0] ?? ''
  const call = /\n\t\t\tif\(wave\)\{[^\n]*\n/.exec(source)?.[0] ?? ''
  const banner = /\n\tif\(crash_t<=0 && ownship\.waving[^\n]*\n/.exec(source)?.[0] ?? ''

  it('lights the lens\'s waveoff lights for every waveoff the LSO calls, flashing in phase with it', () => {
    expect(lights).not.toBe('')
    const shown = (waving: boolean, since: number) => new Function('waving', 'since', `const o={ wavePts:{ visible:false } }, low=false;
      const ownship={ waving, wavet:1, groove:true }, sim_time=1+since/1000;
      ${lights} return o.wavePts.visible;`)(waving, since) as boolean
    expect(shown(true, 100)).toBe(true)    // a waveoff on lineup, on glideslope: the lens is not low
    expect(shown(true, 300)).toBe(false)   // the dark half of the flash
    expect(shown(true, 500)).toBe(true)
    expect(shown(false, 100)).toBe(false)
  })

  it('has PADDLES call it on the radio once, as the call begins', () => {
    expect(call).not.toBe('')
    const run = (frames: number) => new Function('frames', `const comms=[], ownship={ waving:false, waved:false }, wave=true, deck_closed=false, HINT={ abort:'a', wave:'w' };
      const sim_time=1, radio=(text)=>comms.push(text), translate=(t)=>t, pass_end=()=>{}, recoach=()=>{}, mission_start=()=>'carrier', hint=()=>{}, ship_groove=()=>90;
      for(let i=0;i<frames;i++){ ${call}
      }
      return comms;`)(frames) as string[]
    expect(run(1)).toEqual(['PADDLES: WAVE OFF'])
    expect(run(5)).toEqual(['PADDLES: WAVE OFF'])
  })

  it('ends the pass as a foul deck when the ship has closed it, and as the pilot\'s wave-off when not', () => {
    const ended = (closed: boolean) => new Function('closed', `const ended=[], ownship={ waving:false, waved:false }, wave=true, deck_closed=closed, HINT={ abort:'a', wave:'w' };
      const sim_time=1, radio=()=>{}, translate=(t)=>t, pass_end=(e)=>ended.push(e), recoach=()=>{}, mission_start=()=>'case1', hint=()=>{}, ship_groove=()=>90;
      ${call}
      return ended;`)(closed) as string[]
    expect(ended(true)).toEqual(['foul'])
    expect(ended(false)).toEqual(['waveoff'])
  })

  it('flashes the WAVE OFF banner in the HUD view only', () => {
    expect(banner).not.toBe('')
    const drawn = (view: string) => new Function('view', `const shown=[], crash_t=0, net_notice_t=0, cfg={ view }, ownship={ waving:true, wavet:1 };
      const sim_time=1.1, translate=(t)=>t, hud_message=(t)=>shown.push(t);
      ${banner}
      return shown;`)(view) as string[]
    expect(drawn('hud')).toEqual(['WAVE OFF'])
    expect(drawn('cockpit')).toEqual([])
  })
})

// The engine's side of the book: where the lens puts the hook down, the
// hook's height over the round-down, the pilot's own wave-off and the
// perfect pass on the HUD. engine.ts cannot be imported, so its lines are
// read as text.
describe("the engine's book", () => {
  const source = readFileSync(
    fileURLToPath(new URL('./engine.ts', import.meta.url)),
    'utf8'
  )
  const line = (pattern: RegExp) => pattern.exec(source)?.[0] ?? ''

  it('aims the hook halfway between the wire before the target and the target', () => {
    const aim = line(/\n\tconst aim=[^\n]*\n\tconst twfa=[^\n]*\n/)
    expect(aim).not.toBe('')
    const twfa = (wires: number[], target: number) =>
      new Function('SHIP', `${aim} return twfa;`)({
        landing: { wires, target },
        ols: { x: 0, z: 0 },
      }) as number
    expect(twfa([-107, -95, -82], 2)).toBe(-101) // the Ford: between the 1 and 2 wires
    expect(twfa([-115.6, -103.9, -92.2, -80.5], 0)).toBeCloseTo(-98.05, 6) // a four-wire deck: between the 2 and 3
    expect(twfa([-107, -95, -82], 1)).toBe(-107) // a target with no wire before it is the aim itself
  })

  it("reads the ramp's glideslope once, as the hook crosses the round-down", () => {
    const book = line(
      /\n\t\t\tif\(\(ownship\.hook\?\?0\)>0\.5\)\{ const book=[\s\S]*?ownship\.closing=\{ along:s\.along, t:sim_time \}; \}\n/
    )
    expect(book).not.toBe('')
    const fly = (height: number) =>
      new Function(
        'height',
        `const ramps=[], samples=[], D2R=Math.PI/180, GROOVE={ slope:3.5 }, HOOK_AFT=9, carrier_ols={ ramp:57 };
        const pass_start=()=>({}), pass_sample=(...a)=>samples.push(a[5]), pass_ramp=(b,m)=>ramps.push(m);
        const ownship={ hook:1, vely:-4, aoa:8.1, pass:null, closing:null }; let sim_time=0;
        for(let along=120; along>=30; along-=1.2){ sim_time+=1.2/70;
          const hook=along+9, dev=Math.atan2(hook*Math.tan(3.5*D2R)+height, hook)*180/Math.PI-3.5, s={ along, dev, lat:0 };
          ${book} }
        return { ramps, samples };`
      )(height) as { ramps: number[]; samples: number[] }
    const low = fly(-0.6)
    expect(low.ramps).toHaveLength(1)
    expect(low.ramps[0]).toBeCloseTo(-0.6, 6)
    expect(fly(0.3).ramps[0]).toBeCloseTo(0.3, 6)
    // 4 m/s down at 70 m/s closing is the 3.5 degree slope's own rate: no settle
    expect(Math.max(...low.samples.slice(1))).toBeCloseTo(
      4 - 70 * Math.tan((3.5 * Math.PI) / 180),
      6
    )
  })

  it("ends a pass flown past the touchdown, never down and never waved off, as the pilot's own wave-off", () => {
    const reset = line(
      /\n\t\tif\(s\.along>2500 \|\| s\.along<-70\)\{[^\n]*\n[^\n]*\n/
    )
    expect(reset).not.toBe('')
    const ended = (state: Record<string, boolean>, along = -80) =>
      new Function(
        'state',
        'along',
        `const ended=[], pass_end=(e)=>ended.push(e), pass_start=()=>({}), s={ along };
        const ownship={ groove:true, ended:false, grounded:false, ...state };
        ${reset} return { ended, ownship };`
      )(state, along) as { ended: string[]; ownship: Record<string, unknown> }
    expect(ended({}).ended).toEqual(['own'])
    expect(ended({}).ownship.ended).toBe(false) // and the next pass starts fresh
    expect(ended({ ended: true }).ended).toEqual([]) // a bolter or a wave-off already ended it
    expect(ended({ grounded: true }).ended).toEqual([])
    expect(ended({ groove: false }).ended).toEqual([]) // never in the groove: not a pass
    expect(ended({}, 2600).ended).toEqual([]) // a pass starting far out
  })

  it('shows the perfect pass on the HUD as OK underlined', () => {
    const start = source.indexOf('function grade_text(')
    const text = source.slice(start, source.indexOf('\n', start))
    const shown = new Function(
      'grade',
      `const translate=(t)=>t; ${text} return grade_text(grade);`
    )
    expect(shown('PERFECT')).toBe('O\u0332K\u0332')
    expect(shown('FAIR')).toBe('FAIR')
  })
})
