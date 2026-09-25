// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { describe, expect, it } from 'vitest'
import { ONSPEED, pass_grade, pass_sample, pass_start, pass_wire, remarks, segment_of, type Pass } from './lso'

// A pass flown from the start to the wire with the given deviations per
// segment: [glideslope °, lateral m (+ left), alpha °]. A segment left out
// is flown clean and on speed.
function flown(deviations: Partial<Record<'X' | 'IM' | 'IC' | 'AR', [number, number, number]>>): Pass {
  const pass = pass_start()
  const middle = { X: 1500, IM: 900, IC: 400, AR: 150 } as const
  for (const [segment, along] of Object.entries(middle) as ['X' | 'IM' | 'IC' | 'AR', number][]) {
    const [glideslope, lateral, alpha] = deviations[segment] ?? [0, 0, ONSPEED]
    pass_sample(pass, along, glideslope, lateral, alpha)
  }
  return pass
}

const soft = { sink: 3, bank: 0, fa: -95 }

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
    pass_sample(pass, 350, -0.9, 3, ONSPEED)
    pass_sample(pass, 300, 0.2, 1, ONSPEED)
    expect(pass.segments.IC).toEqual({ glideslope: -0.9, lineup: 3, speed: 0 })
    expect(remarks(pass)).toBe('(LO)(LUL) IC')
  })

  it('judges lineup as an angle far out and in metres in close', () => {
    const pass = pass_start()
    pass_sample(pass, 1500, 0, 30, ONSPEED) // 30 m at 1,500 m is 1.1°: a little
    pass_sample(pass, 400, 0, 6, ONSPEED) // 6 m in close is gross
    expect(remarks(pass)).toBe('(LUL) X · LUL IC')
  })

  it('writes high, low, fast and slow with the LSO’s letters, a little in parentheses', () => {
    expect(remarks(flown({ X: [0.5, 0, ONSPEED], IM: [-1.2, 0, ONSPEED], IC: [0, -2.5, ONSPEED - 1], AR: [0, 0, ONSPEED + 2] }))).toBe(
      '(H) X · LO IM · (LUR)(F) IC · S AR'
    )
    expect(remarks(flown({}))).toBe('')
  })

  it('reads the glideslope at the ramp from the wire, not the lens geometry', () => {
    // Three metres under the geometric line at 60 m is 2.5° on the hook and
    // exactly where a pass that catches the 3 wire flies: not a deviation.
    expect(remarks(flown({ AR: [-2.5, 0, ONSPEED] }))).toBe('')
    expect(remarks(flown({}), 1)).toBe('(LO) IW')
    expect(remarks(flown({}), 4)).toBe('(H) IW')
  })
})

describe('the grade', () => {
  it('gives OK to a clean pass to the 2 or 3 wire, and FAIR to a little at the start', () => {
    expect(pass_grade(flown({}), soft, 3, false, 'trap').grade).toBe('OK')
    expect(pass_grade(flown({ X: [0.6, 0, ONSPEED] }), soft, 2, false, 'trap').grade).toBe('OK')
    expect(pass_grade(flown({ X: [0.6, 0, ONSPEED], IM: [0, 0, ONSPEED + 1] }), soft, 2, false, 'trap').grade).toBe('FAIR')
    expect(pass_grade(flown({ IC: [0.6, 0, ONSPEED] }), soft, 3, false, 'trap').grade).toBe('FAIR')
  })

  it('will not give OK to a firm arrival', () => {
    expect(pass_grade(flown({}), { sink: 6.5, bank: 0, fa: -95 }, 3, false, 'trap').grade).toBe('FAIR')
  })

  it('writes the five-metres-left 1 wire up as NO GRADE, where the averaged angle gave FAIR', () => {
    const pass = flown({ IC: [0, 3, ONSPEED], AR: [0, 4, ONSPEED] })
    pass_wire(pass, 5)
    const graded = pass_grade(pass, soft, 1, false, 'trap')
    expect(graded.grade).toBe('NO-GRADE')
    expect(graded.remarks).toBe('(LUL) IC · (LUL) AR · (LO)(LUL) IW')
  })

  it('gives NO GRADE to anything at the ramp, anything gross earlier, or the 1 wire', () => {
    expect(pass_grade(flown({ AR: [0, 2.5, ONSPEED] }), soft, 3, false, 'trap').grade).toBe('NO-GRADE')
    expect(pass_grade(flown({ IM: [1.2, 0, ONSPEED] }), soft, 3, false, 'trap').grade).toBe('NO-GRADE')
    expect(pass_grade(flown({ IC: [0, 0, ONSPEED + 1.6] }), soft, 3, false, 'trap').grade).toBe('NO-GRADE')
    expect(pass_grade(flown({}), soft, 1, false, 'trap').grade).toBe('NO-GRADE')
  })

  it('treats the 4 wire as FAIR clean and NO GRADE otherwise', () => {
    expect(pass_grade(flown({}), soft, 4, false, 'trap').grade).toBe('FAIR')
    expect(pass_grade(flown({ X: [0.5, 0, ONSPEED] }), soft, 4, false, 'trap').grade).toBe('NO-GRADE')
  })

  it('cuts a gross deviation at the ramp or in the wires, a settle into the 1 wire, and a trap through a wave-off', () => {
    expect(pass_grade(flown({ AR: [0, 0, ONSPEED + 2] }), soft, 2, false, 'trap').grade).toBe('CUT')
    const wide = flown({})
    pass_wire(wide, -6)
    expect(pass_grade(wide, soft, 3, false, 'trap').grade).toBe('CUT')
    expect(pass_grade(flown({}), { sink: 6.5, bank: 0, fa: -110 }, 1, false, 'trap').grade).toBe('CUT')
    expect(pass_grade(flown({}), soft, 3, true, 'trap').grade).toBe('CUT')
  })

  it('cuts a hard, banked or round-down touchdown', () => {
    expect(pass_grade(flown({}), { sink: 7.5, bank: 0, fa: -95 }, 3, false, 'trap').grade).toBe('CUT')
    expect(pass_grade(flown({}), { sink: 3, bank: 0.15, fa: -95 }, 3, false, 'trap').grade).toBe('CUT')
    expect(pass_grade(flown({}), { sink: 3, bank: 0, fa: -125 }, 3, false, 'trap').grade).toBe('CUT')
  })

  it('writes a bolter and a wave-off up without grading them', () => {
    expect(pass_grade(flown({ IC: [0.6, 0, ONSPEED] }), null, 0, false, 'bolter')).toEqual({ grade: 'BOLTER', remarks: '(H) IC' })
    expect(pass_grade(flown({ IC: [-1.2, 0, ONSPEED] }), null, 0, true, 'waveoff')).toEqual({ grade: 'WAVE OFF', remarks: 'LO IC' })
  })
})
