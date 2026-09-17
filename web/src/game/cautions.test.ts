// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ACROSS, SLOTS, lines, reconcile, restack, type Row, type Slots } from './cautions'

// The left DDI's caution slots against NATOPS 2.20.3.2.1 and 2.17.2.1.
const row = (key: string, red = false): Row => [key, key, red]
const keys = (slots: Slots) => slots.map((slot) => (slot ? slot.key : null))

describe('the caution slots', () => {
  it('fill from the first slot in the order the cautions occur, three to a line', () => {
    const slots = reconcile([], [row('FUEL LEAK'), row('CANOPY'), row('WING UNLK'), row('STRUCTURE')])
    expect(keys(slots)).toEqual(['FUEL LEAK', 'CANOPY', 'WING UNLK', 'STRUCTURE'])
    expect(lines(slots).map(keys)).toEqual([['FUEL LEAK', 'CANOPY', 'WING UNLK'], ['STRUCTURE']])
    expect(ACROSS).toBe(3)
  })

  it('leave a cleared caution\'s slot blank and give a new caution the next slot past the end', () => {
    let slots = reconcile([], [row('FUEL LEAK'), row('CANOPY'), row('WING UNLK')])
    slots = reconcile(slots, [row('FUEL LEAK'), row('WING UNLK')])
    expect(keys(slots)).toEqual(['FUEL LEAK', null, 'WING UNLK'])
    slots = reconcile(slots, [row('FUEL LEAK'), row('WING UNLK'), row('STRUCTURE')])
    expect(keys(slots)).toEqual(['FUEL LEAK', null, 'WING UNLK', 'STRUCTURE']) // the blank is not reused
  })

  it('take a blank at the end as the open space for the next caution', () => {
    let slots = reconcile([], [row('FUEL LEAK'), row('CANOPY')])
    slots = reconcile(slots, [row('FUEL LEAK')])
    expect(keys(slots)).toEqual(['FUEL LEAK'])
    slots = reconcile(slots, [row('FUEL LEAK'), row('STRUCTURE')])
    expect(keys(slots)).toEqual(['FUEL LEAK', 'STRUCTURE'])
  })

  it('return the same array when nothing changed, and a new one when a label or colour moves', () => {
    const slots = reconcile([], [row('FUEL LEAK')])
    expect(reconcile(slots, [row('FUEL LEAK')])).toBe(slots)
    expect(reconcile(slots, [row('FUEL LEAK', true)])).not.toBe(slots)
    expect(reconcile(slots, [['FUEL LEAK', 'FUEL LEAK L', false]])).not.toBe(slots)
  })

  it('pack the blanks out on restack and leave a packed list alone', () => {
    let slots = reconcile([], [row('A'), row('B'), row('C'), row('D')])
    slots = reconcile(slots, [row('A'), row('C')])
    expect(keys(slots)).toEqual(['A', null, 'C'])
    const packed = restack(slots)
    expect(keys(packed)).toEqual(['A', 'C'])
    expect(restack(packed)).toBe(packed)
  })

  it('hold at most 21 and let the oldest give way when full', () => {
    const many = Array.from({ length: SLOTS }, (_, i) => row('C' + i))
    let slots = reconcile([], many)
    expect(slots.length).toBe(SLOTS)
    slots = reconcile(slots, [...many, row('LATE')])
    expect(slots.length).toBe(SLOTS)
    expect(keys(slots)[0]).toBe('C1')
    expect(keys(slots)[SLOTS - 1]).toBe('LATE')
  })
})

// The engine side: the slots are fed each sim step, drawn on the left DDI,
// the HUD's screen stack keeps to the HUD view, and the reset key restacks
// when the light is already out.
describe('the caution wiring', () => {
  const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')

  it('feeds the slots from the caution rows before the tail the voice test extracts', () => {
    expect(source).toMatch(/const next=cautions_reconcile\(caution_slots,rows\); if\(next!==caution_slots\)\{ caution_slots=next; ddi_dirty=true; \}[^\n]*\n\tcaution_list=rows;\n/)
  })

  it('draws the slots on the left display only', () => {
    expect(source).toMatch(/\nfunction ddi_render\(x,size,display\)\{[\s\S]*?if\(display==="left"\) cautions_draw\(x\);[\s\S]*?ddi_legend\(x,18,"MENU",true,!!st\.menu\); \}/)
    const draw = /\nfunction cautions_draw\(x\)\{[\s\S]*?x\.restore\(\); \}\n/.exec(source)?.[0] ?? ''
    expect(draw).toMatch(/cautions_lines\(caution_slots\)/)
  })

  it('keeps the screen stack to the HUD view and restacks on a reset with the light out', () => {
    expect(source).toMatch(/if\(authentic\) hud_stack\.left=\[\];[^\n]*\n\t\telse hud_stack\.left=stack_draw\(rows,40,HH-106-STACK_PITCH\);/)
    expect(source).toMatch(/if\(ch===key_of\("caution\.reset"\)\) caution_press\(\);/) // the press is one function since the light became a click target (#20)
    expect(source).toMatch(/function caution_press\(\)\{ if\(caution_lamp\) caution_lamp=false; else \{ caution_slots=cautions_restack\(caution_slots\); ddi_dirty=true; \} \}/)
  })
})
