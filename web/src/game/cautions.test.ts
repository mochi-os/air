// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ACROSS, PRIORITY, SLOTS, lines, reconcile, restack, type Row, type Slots } from './cautions'

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

  it('hold at most 21, a new caution waiting for space at the end when they are full', () => {
    const many = Array.from({ length: SLOTS }, (_, i) => row('C' + i))
    let slots = reconcile([], many)
    expect(slots.length).toBe(SLOTS)
    slots = reconcile(slots, [...many, row('LATE')])
    expect(keys(slots)).toEqual(many.map((r) => r[0])) // nothing gives way for it
    slots = reconcile(slots, [...many.slice(0, 5), ...many.slice(6), row('LATE')])
    expect(keys(slots)[5]).toBe(null) // a slot freed in the middle is not open space
    expect(keys(slots)).not.toContain('LATE')
    slots = reconcile(slots, [...many.slice(0, 5), ...many.slice(6, SLOTS - 1), row('LATE')])
    expect(keys(slots)[SLOTS - 2]).toBe('C19')
    expect(keys(slots)[SLOTS - 1]).toBe('LATE') // the last one clears: LATE takes the space at the end
  })

  it('let a priority caution displace the oldest non-priority one, and wait only when all are priority', () => {
    expect([...PRIORITY]).toEqual(['AIL ON', 'CAUT DEGD', 'DEL ON', 'FLAPS OFF', 'FLAPS SCHED', 'INS ATT', 'L AMAD', 'R AMAD', 'L AMAD PR', 'R AMAD PR', 'MECH ON', 'RUD OFF'])
    const many = [row('MECH ON'), ...Array.from({ length: SLOTS - 1 }, (_, i) => row('C' + i))]
    let slots = reconcile([], many)
    slots = reconcile(slots, [...many, row('RUD OFF')])
    expect(keys(slots)[0]).toBe('MECH ON') // a priority caution is not displaced
    expect(keys(slots)).not.toContain('C0') // the oldest non-priority one gives way
    expect(keys(slots)[SLOTS - 1]).toBe('RUD OFF')
    const names = [...PRIORITY]
    const mixed: Row[] = [] // eleven priority cautions with a plain one after each of the first ten, a priority one last
    for (let i = 0; i < 11; i++) { mixed.push(row(names[i])); if (i < 10) mixed.push(row('C' + i)) }
    let held = reconcile([], mixed)
    held = reconcile(held, mixed.filter((r) => PRIORITY.has(r[0]))) // the plain ones clear: blanks between the priority ones
    expect(held.length).toBe(SLOTS)
    expect(reconcile(held, [...mixed.filter((r) => PRIORITY.has(r[0])), row(names[11])])).toBe(held) // nothing plain to displace: it waits
  })
})

// The engine side: the slots are fed each sim step, drawn on the left DDI,
// the HUD's screen stack keeps to the HUD view, and the reset key restacks
// when the light is already out.
describe('the caution wiring', () => {
  const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')

  it('feeds the slots from the caution rows before the tail the voice test extracts', () => {
    expect(source).toMatch(/const next=cautions_reconcile\(caution_slots,captions\.map\(c=>\[c,c,false\]\)\); if\(next!==caution_slots\)\{ caution_slots=next; ddi_dirty=true; \} \}[^\n]*\n\tcaution_list=rows;\n/)
  })

  it('shows the jet\'s cautions only, under their index captions, FLAMEOUT per engine', () => {
    const table = /\nconst DDI_CAPTIONS=\{[^\n]*\n/.exec(source)?.[0] ?? ''
    const section = /\n\tconst captions=\[\];\n[^\n]*\n[^\n]*\n/.exec(source)?.[0] ?? ''
    expect(table).not.toBe(''); expect(section).not.toBe('')
    const run = (rows: string[], o: { fuel?: number; harm?: [number, number]; secured?: [boolean, boolean] } = {}) => new Function(`const STATE={ engine_harm:0 }, core=${JSON.stringify(o.harm ?? [0, 0])}, secured=${JSON.stringify(o.secured ?? [false, false])}, ownship={ fuel:${o.fuel ?? 3000} }, rows=${JSON.stringify(rows.map((k) => [k, k, false]))};
      ${table} ${section} return captions;`)() as string[]
    expect(run(['FUEL LEAK', 'WING UNLK', 'L ENG FIRE', 'FUEL FIRE', 'PARK BRK', 'NOSE GEAR', 'STRUCTURE', 'L ENG', 'FCS', 'FUEL LO', 'BINGO', 'HOME FUEL', 'CANOPY', 'PROBE UNLK', 'FLAMEOUT']))
      .toEqual(['WING UNLK', 'PARK BRAKE', 'FCS', 'FUEL LO', 'BINGO', 'HOME FUEL', 'CANOPY', 'PROBE UNLK'])
    expect(run([], { fuel: 0 })).toEqual(['L FLAMEOUT', 'R FLAMEOUT']) // dry tanks: both engines
    expect(run([], { fuel: 0, secured: [true, false] })).toEqual(['R FLAMEOUT']) // not with the fuel shut off, below IDLE
    expect(run([], { harm: [1, 0] })).toEqual(['L FLAMEOUT']) // a core the damage has left nothing
    expect(run([], { harm: [0.8, 0] })).toEqual([]) // a hurt engine still running is no flameout
  })

  it('draws the captions at 150 % of the pages\' 18 px text, three ten-letter captions across', () => {
    const draw = /\nfunction cautions_draw\(x\)\{[\s\S]*?x\.restore\(\); \}\n/.exec(source)?.[0] ?? ''
    const text: [string, number, number, string][] = []
    let font = ''
    const x = new Proxy({}, { get: (_, k) => (k === 'fillText' ? (s: string, px: number, py: number) => text.push([s, px, py, font]) : k === 'measureText' ? (s: string) => ({ width: 16.2 * s.length }) : () => {}), set: (_, k, v) => { if (k === 'font') font = v; return true } })
    const slots = ['PROBE UNLK', 'WING UNLK', 'PARK BRAKE', 'L FLAMEOUT'].map((k) => ({ key: k, label: k, red: false }))
    new Function('x', 'caution_slots', 'cautions_lines', `${draw} cautions_draw(x);`)(x, slots, lines)
    expect(text.map(([s, px, py]) => [s, px, py])).toEqual([['PROBE UNLK', 20, 452], ['WING UNLK', 182, 452], ['PARK BRAKE', 344, 452], ['L FLAMEOUT', 20, 420]])
    expect(new Set(text.map((r) => r[3]))).toEqual(new Set(['27px monospace']))
    expect(20 + 162 * 2 + 16.2 * 10).toBeLessThanOrEqual(512) // the widest caption still fits in the third column
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
