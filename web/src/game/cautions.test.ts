// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as countermeasures from './countermeasures'
import * as identification from './identification'
import { describe, expect, it } from 'vitest'
import { ACROSS, PRIORITY, SLOTS, dedicated, host, lines, reconcile, restack, type Row, type Slots } from './cautions'

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
    new Function('x', 'caution_slots', 'advisory_slots', 'cautions_lines', `${draw} cautions_draw(x);`)(x, slots, [], lines)
    expect(text.map(([s, px, py]) => [s, px, py])).toEqual([['PROBE UNLK', 20, 426], ['WING UNLK', 182, 426], ['PARK BRAKE', 344, 426], ['L FLAMEOUT', 20, 394]]) // a line above the advisories'
    expect(new Set(text.map((r) => r[3]))).toEqual(new Set(['27px monospace']))
    expect(20 + 162 * 2 + 16.2 * 10).toBeLessThanOrEqual(512) // the widest caption still fits in the third column
  })

  it('draws the slots on the display that carries them only', () => {
    expect(source).toMatch(/\nfunction ddi_render\(x,size,display\)\{[\s\S]*?if\(display===\(caution_page\(\)\|\|caution_host\(\)\)\) cautions_draw\(x\);[\s\S]*?ddi_legend\(x,18,"MENU",true,!!st\.menu\); \}/)
    const draw = /\nfunction cautions_draw\(x\)\{[\s\S]*?x\.restore\(\); \}\n/.exec(source)?.[0] ?? ''
    expect(draw).toMatch(/cautions_lines\(caution_slots\)/)
  })

  it('keeps the screen stack to the HUD view and restacks on a reset with the light out', () => {
    expect(source).toMatch(/if\(authentic\) hud_stack\.left=\[\];[^\n]*\n\t\telse hud_stack\.left=stack_draw\(rows,40,HH-106-STACK_PITCH\);/)
    expect(source).toMatch(/if\(ch===key_of\("caution\.reset"\)\) caution_press\(\);/) // the press is one function since the light became a click target (#20)
    expect(source).toMatch(/function caution_press\(\)\{ if\(caution_lamp\) caution_lamp=false; else \{ caution_slots=cautions_restack\(caution_slots\); advisory_slots=cautions_restack\(advisory_slots\); ddi_dirty=true; \} \}/)
  })
})

// The advisory line and the display that carries the cautions (#89, #102, #108; NATOPS 2.20.3.2.1,
// figure 2-45, and figure 12-1's DDI advisories).
describe('the display that carries the cautions', () => {
  it('is the left DDI, the centre display while the left is off or shows BIT, and the right DDI with both off', () => {
    const lit = (left: boolean, center: boolean, right: boolean) => ({ left, center, right })
    expect(host(lit(true, true, true), false)).toBe('left')
    expect(host(lit(false, true, true), false)).toBe('center')
    expect(host(lit(true, true, true), true)).toBe('center') // BIT on the left DDI
    expect(host(lit(false, false, true), false)).toBe('right')
    expect(host(lit(true, false, true), true)).toBe('right')
    expect(host(lit(true, false, false), true)).toBe('left') // the only display lit keeps them
    expect(host(lit(false, false, false), false)).toBeNull()
  })
  it('gives them a display of their own past three lines', () => {
    const fill = (n: number) => reconcile([], Array.from({ length: n }, (_, k) => row('C' + k)))
    expect(dedicated(fill(9))).toBe(false); expect(dedicated(fill(10))).toBe(true)
    expect(dedicated(reconcile(fill(10), Array.from({ length: 9 }, (_, k) => row('C' + k))))).toBe(false) // the tenth cleared: three lines again
  })
})

describe('the advisory line', () => {
  const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
  const lift = (name: string) => { const start = source.indexOf(`function ${name}(`); if (start < 0) throw new Error(name + ' not found'); const rest = source.slice(start); const end = /\n(?=\S)/.exec(rest.slice(1)); return end ? rest.slice(0, end.index + 1) : rest }
  const consts = /\nconst buttons=\{[^\n]*\n/.exec(source)?.[0] ?? '', on = /\nconst ANTIICE_ON=[^\n]*\n/.exec(source)?.[0] ?? ''
  interface Jet { suite?: string[]; attitude?: boolean; grounded?: boolean; home?: boolean; ice?: number; rpm?: [number, number]; secured?: [boolean, boolean]; gear?: number; skid?: boolean; time?: number; trim?: number; reset?: number; standing?: boolean; reference?: string; failure?: boolean; chaff?: number; flares?: number; dispenser?: string; challenged?: boolean; answered?: boolean; alert?: string }
  const advised = (o: Jet = {}) => (new Function('o', 'countermeasures', 'identification', `const hold={ engaged:false, modes:{ attitude:false, select:false, barometric:false, radar:false, coupled:false }, source:"track", caution:-Infinity, flash:-Infinity }, link={ selected:false, five:null, six:null }, autopilot={ cue:()=>false, cautions:()=>[], advisories:()=>[] }, hud_link=()=>"", hud_coupled=()=>""; let coupled=""; ${consts} ${on} const sim_time=o.time??100, navigate={ advisories:()=>o.suite||[], attitude:()=>o.attitude??true }, nav={ ins:{} };
    const suite=countermeasures.fresh(true), dispenser_programme=()=>countermeasures.PROGRAMMES.mixed, squawk=identification.fresh(), challenges=()=>({ challenged:!!o.challenged, answered:!!o.answered });
    if(o.dispenser) suite.dispenser=o.dispenser; if(o.alert) squawk.alert=o.alert;
    const ownship={ grounded:o.grounded??false, gearTarget:o.gear??1, chaff:o.chaff??20, flares:o.flares??40, gauges:{ rpmL:(o.rpm||[80,80])[0], rpmR:(o.rpm||[80,80])[1] } }, fpas_home=()=>(o.home??true)?{}:null, travel_at=()=>o.ice??1;
    const secured=o.secured||[false,false], antiskid=o.skid??true, reference=o.reference||"auto";
    buttons.trim=o.trim??-Infinity; buttons.reset=o.reset??-Infinity; buttons.standing=!!o.standing; const bit={ advisory:!!o.failure };
    ${lift('advisories_now')} return advisories_now();`)(o, countermeasures, identification) as [string, string][]).map(([key]) => key)
  it('advises nothing in a healthy jet, and passes on what the navigation suite advises', () => {
    expect(consts).not.toBe(''); expect(on).not.toBe('')
    expect(advised()).toEqual([]); expect(advised({ suite: ['ALGN', 'GPS'] })).toEqual(['ALGN', 'GPS'])
  })
  it('advises FPAS while it cannot work out the home fuel in flight, and not on the wheels', () => {
    expect(advised({ home: false })).toEqual(['FPAS']); expect(advised({ home: false, grounded: true })).toEqual([]); expect(advised({ home: true })).toEqual([])
  })
  it('advises L HEAT and R HEAT with the engine anti-ice switch ON, each for a running engine', () => {
    expect(advised({ ice: 2 })).toEqual(['L HEAT', 'R HEAT']); expect(advised({ ice: 0 })).toEqual([]) // TEST is not ON
    expect(advised({ ice: 2, rpm: [80, 40] })).toEqual(['L HEAT']); expect(advised({ ice: 2, secured: [true, false] })).toEqual(['R HEAT'])
    expect(advised({ ice: 2, rpm: [40, 80] })).toEqual(['R HEAT']); expect(advised({ ice: 2, secured: [false, true] })).toEqual(['L HEAT'])
  })
  it('advises SKID with the gear down and ANTI SKID not ON', () => {
    expect(advised({ gear: 0, skid: false })).toEqual(['SKID']); expect(advised({ gear: 1, skid: false })).toEqual([]); expect(advised({ gear: 0, skid: true })).toEqual([])
  })
  it('advises TRIM while the T/O TRIM button is held on the wheels', () => {
    expect(advised({ grounded: true, time: 100, trim: 99 })).toEqual(['TRIM']); expect(advised({ grounded: true, time: 100, trim: 97.9 })).toEqual([])
    expect(advised({ grounded: false, time: 100, trim: 99, home: true })).toEqual([])
  })
  it('advises RSET for an FCS RESET, as its own failed kind when the failure stood', () => {
    expect(advised({ time: 100, reset: 99 })).toEqual(['RSET']); expect(advised({ time: 100, reset: 99, standing: true })).toEqual(['RSET FAIL']); expect(advised({ time: 100, reset: 97 })).toEqual([])
  })
  it('advises BIT while an equipment failure has not been looked at', () => {
    expect(advised({ failure: true })).toEqual(['BIT'])
  })
  it('advises D LOW at a magazine\'s bingo, and not with the dispenser off (2.13.12.1)', () => {
    expect(advised({ chaff: 4 })).toEqual(['D LOW']); expect(advised({ flares: 6 })).toEqual(['D LOW']); expect(advised({ chaff: 5, flares: 7 })).toEqual([]) // the mixed programme's two left: 4 bundles, 6 flares
    expect(advised({ chaff: 4, dispenser: 'off' })).toEqual([])
    expect(source).toMatch(/countermeasures\.advisories\(suite,\{ chaff:ownship\.chaff\|0, flare:ownship\.flares\|0 \},dispenser_programme\(\)\)/) // the match's programme sets the levels
  })
  it('advises M4 OK while the transponder answers a valid mode 4 challenge, and not with the MODE 4 switch OFF', () => {
    expect(advised({ challenged: true, answered: true })).toEqual(['M4 OK']); expect(advised({ challenged: true })).toEqual([]); expect(advised({ answered: true })).toEqual([])
    expect(advised({ challenged: true, answered: true, alert: 'off' })).toEqual([])
  })
  it('advises HIAOA while the flight control computers have no INS attitude', () => {
    expect(advised({ attitude: false })).toEqual(['HIAOA']); expect(advised({ reference: 'stby' })).toEqual(['HIAOA']); expect(advised({ reference: 'ins' })).toEqual([])
  })

  const draw = lift('cautions_draw')
  const drawn = (cautions: string[], advisories: (string | null)[]) => {
    const text: [string, number, number, string][] = [], lines: number[][] = []
    let font = '', at = [0, 0]
    const x = new Proxy({}, { get: (_, k) => (k === 'fillText' ? (t: string, px: number, py: number) => text.push([t, px, py, font]) : k === 'measureText' ? (t: string) => ({ width: (font.startsWith('27') ? 16 : 13) * t.length }) : k === 'moveTo' ? (px: number, py: number) => { at = [px, py] } : k === 'lineTo' ? (px: number, py: number) => lines.push([...at, px, py]) : () => {}), set: (_, k, v) => { if (k === 'font') font = v; return true } })
    const slot = (k: string | null) => (k ? { key: k, label: k === 'RSET FAIL' ? 'RSET' : k, red: false } : null)
    new Function('x', 'caution_slots', 'advisory_slots', 'cautions_lines', `${draw} cautions_draw(x);`)(x, cautions.map(slot), advisories.map(slot), lines_of)
    return { text, lines }
  }
  const lines_of = lines
  it('writes them on one line under the cautions at 120 %, after ADV, with commas between', () => {
    const d = drawn(['FUEL LO'], ['ALGN', 'L HEAT', 'R HEAT'])
    expect(d.text[0].slice(0, 3)).toEqual(['FUEL LO', 20, 426])
    expect(d.text.slice(1).map(([t]) => t).join('')).toBe('ADV-ALGN, L HEAT, R HEAT')
    expect(new Set(d.text.slice(1).map((r) => r[2]))).toEqual(new Set([457])); expect(new Set(d.text.slice(1).map((r) => r[3]))).toEqual(new Set(['22px monospace']))
    expect(d.text[1].slice(0, 2)).toEqual(['ADV-', 20]); expect(d.text[2].slice(0, 2)).toEqual(['ALGN', 20 + 13 * 4]) // each after the last
  })
  it('writes no ADV legend with nothing advised', () => {
    expect(drawn(['FUEL LO'], []).text.map(([t]) => t)).toEqual(['FUEL LO']); expect(drawn([], [null]).text).toEqual([])
  })
  it('leaves a cleared advisory\'s place blank, with no comma hanging off it or off the last', () => {
    const d = drawn([], ['ALGN', null, 'SKID'])
    expect(d.text.map(([t]) => t)).toEqual(['ADV-', 'ALGN', ', ', 'SKID'])
    expect(d.text[3][1]).toBe(20 + 13 * (4 + 4 + 2 + 5 + 2)) // SKID stands past the blank
  })
  it('crosses out an RSET that left the failure standing', () => {
    const failed = drawn([], ['RSET FAIL']), cleared = drawn([], ['RSET'])
    expect(failed.text.map(([t]) => t)).toEqual(['ADV-', 'RSET']); expect(failed.lines).toEqual([[72, 448, 124, 466], [72, 466, 124, 448]])
    expect(cleared.lines).toEqual([])
  })

  it('follows what is advised each sim step, and packs with the cautions on MASTER CAUTION', () => {
    expect(source).toMatch(/const next=cautions_reconcile\(advisory_slots,avionics\.advised\(advisories_now\(\),computing\)\.map\(\(\[key,label\]\)=>\[key,label,false\]\)\); if\(next!==advisory_slots\)\{ advisory_slots=next; ddi_dirty=true; \} \}/)
  })
})

// The IFF's cautions (23.6.2.3, 23.6.2.4; #98) and the APU accumulator's (2.4.2.2), as the caution step raises them.
describe('the IFF and APU accumulator cautions', () => {
  const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
  const lines = /\n\t\{ const c=challenges\(\); for\(const caption of identification\.cautions[^\n]*\n\tif\(accumulator_low\(\)\) captions\.push\("APU ACCUM"\);[^\n]*\n/.exec(source)?.[0] ?? ''
  interface Set { held?: boolean; on?: boolean; alert?: string; challenged?: boolean; answered?: boolean; low?: boolean }
  const raised = (o: Set = {}) => new Function('o', 'identification', `const squawk=identification.fresh(), captions=[], challenges=()=>({ challenged:!!o.challenged, answered:!!o.answered }), accumulator_low=()=>!!o.low;
    squawk.held=o.held??true; squawk.on=o.on??true; if(o.alert) squawk.alert=o.alert; ${lines} return captions;`)(o, identification) as string[]
  it('raises nothing with the codes held and no challenge unanswered', () => {
    expect(lines).not.toBe('')
    expect(raised()).toEqual([]); expect(raised({ challenged: true, answered: true })).toEqual([])
  })
  it('raises IFF 4 for a valid mode 4 challenge left unanswered', () => {
    expect(raised({ challenged: true })).toEqual(['IFF 4'])
  })
  it('raises IFF 4 and IFFAI with the mode 4 codes gone', () => {
    expect(raised({ held: false })).toEqual(['IFF 4', 'IFFAI'])
  })
  it('silences IFF 4, and not IFFAI, with the MODE 4 switch OFF', () => {
    expect(raised({ challenged: true, alert: 'off' })).toEqual([]); expect(raised({ held: false, alert: 'off' })).toEqual(['IFFAI'])
  })
  it('raises neither with the set off', () => {
    expect(raised({ held: false, challenged: true, on: false })).toEqual([])
  })
  it('raises APU ACCUM with the APU accumulator low', () => {
    expect(raised({ low: true })).toEqual(['APU ACCUM']); expect(raised({ low: true, held: false })).toEqual(['IFF 4', 'IFFAI', 'APU ACCUM'])
  })
})

describe('where the cautions are drawn', () => {
  const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
  const lift = (name: string) => { const start = source.indexOf(`function ${name}(`); if (start < 0) throw new Error(name + ' not found'); const rest = source.slice(start); const end = /\n(?=\S)/.exec(rest.slice(1)); return end ? rest.slice(0, end.index + 1) : rest }
  interface Pit { levels?: Record<string, number>; pages?: Record<string, [string, string]>; cautions?: number }
  const pit = (o: Pit, body: string) => new Function('cautions_host', 'cautions_dedicated', 'o', `const levels={ left:1, center:1, right:1, ...o.levels }, display_level=(d)=>levels[d];
    const page=(d,fallback)=>({ page:(o.pages&&o.pages[d]||[fallback,""])[0], menu:(o.pages&&o.pages[d]||[fallback,""])[1] });
    const ddi_state={ left:page("left","fcs"), center:page("center","hsi"), right:page("right","adi") }, caution_slots=Array.from({ length:o.cautions||0 },(_,k)=>({ key:"C"+k }));
    ${lift('caution_host')} ${lift('caution_page')} ${body}`)(host, dedicated, o)
  it('puts them on the left DDI, the centre display with the left off or on BIT, the right with both off', () => {
    expect(pit({}, 'return caution_host();')).toBe('left')
    expect(pit({ levels: { left: 0 } }, 'return caution_host();')).toBe('center')
    expect(pit({ pages: { left: ['bit', ''] } }, 'return caution_host();')).toBe('center')
    expect(pit({ pages: { left: ['bit', 'tac'] } }, 'return caution_host();')).toBe('left') // the menu over it is not the BIT display
    expect(pit({ levels: { left: 0, center: 0 } }, 'return caution_host();')).toBe('right')
  })
  it('gives the HSI\'s display to the caution display past three lines, the centre display\'s first', () => {
    expect(pit({ cautions: 9 }, 'return caution_page();')).toBeNull()
    expect(pit({ cautions: 10 }, 'return caution_page();')).toBe('center')
    expect(pit({ cautions: 10, pages: { left: ['hsi', ''] } }, 'return caution_page();')).toBe('center')
    expect(pit({ cautions: 10, pages: { left: ['hsi', ''], center: ['sa', ''] } }, 'return caution_page();')).toBe('left')
    expect(pit({ cautions: 10, pages: { center: ['hsi', 'tac'] } }, 'return caution_page();')).toBeNull() // behind its menu the HSI is not showing
    expect(pit({ cautions: 10, levels: { center: 0 } }, 'return caution_page();')).toBeNull() // nor on a dark display
  })
  const render = (o: { dedicated?: string | null; hosted?: string | null; display: string; menu?: string }) => new Function('o', `let ddi_draws=0, spin_up=false, last_out=[], designator="none"; const calls=[];
    const ddi_state={ [o.display]:{ page:"hsi", menu:o.menu||"" } }, DDI_PAGES={ hsi:{ draw:()=>calls.push("hsi") } }, DDI_MENUS={ tac:[], supt:[] };
    const caution_page=()=>o.dedicated??null, caution_host=()=>o.hosted??null, cautions_draw=()=>calls.push("cautions"), caution_display=()=>calls.push("dedicated"), ddi_legend=()=>{}, diamond=()=>{};
    const sim_time=0, mc=()=>({ one:true, two:true }), avionics={ standby:()=>false, offered:()=>true }, display_test={ on:false };
    const x=new Proxy({}, { get:()=>()=>({ width:0 }), set:()=>true });
    ${lift('ddi_render')} ddi_render(x,512,o.display); return calls;`)(o) as string[]
  it('draws them over the page on the display that carries them, and on no other', () => {
    expect(render({ display: 'left', hosted: 'left' })).toEqual(['hsi', 'cautions']); expect(render({ display: 'right', hosted: 'left' })).toEqual(['hsi'])
  })
  it('draws the dedicated display in the HSI\'s place with the cautions on it, and takes them off the display they were on', () => {
    expect(render({ display: 'center', dedicated: 'center', hosted: 'left' })).toEqual(['dedicated', 'cautions'])
    expect(render({ display: 'left', dedicated: 'center', hosted: 'left' })).toEqual(['hsi'])
    expect(render({ display: 'center', dedicated: 'center', hosted: 'left', menu: 'tac' })).toEqual(['cautions']) // the menu is drawn, not the page
  })
  it('gives the dedicated display no options of its own', () => {
    const press = (dedicated: string | null) => new Function('dedicated', `let ddi_dirty=false, pressed=0; const ddi_state={ center:{ page:"hsi", menu:"" } }, DDI_MENUS={ tac:[], supt:[] }, DDI_PAGES={ hsi:{ press:()=>{ pressed++; return true; } } }, ddi_show=()=>{}, caution_page=()=>dedicated, mc=()=>({ one:true, two:true }), avionics={ standby:()=>false, offered:()=>true }, display_test={ on:false };
      ${lift('ddi_press')} return [ddi_press("center",7), pressed, ddi_press("center",18), ddi_state.center.menu];`)(dedicated)
    expect(press(null)).toEqual([true, 1, true, 'tac']); expect(press('center')).toEqual([false, 0, true, 'tac']) // MENU still works
  })
  it('draws an aircraft symbol at the heading over the chart, the chart on the centre display with MAP only', () => {
    const shown = (display: string, map: boolean, heading: number, north: boolean, track = 0) => new Function('navigate', `const NM=1852, charts=[], moves=[]; const ownship={ gauges:{ heading:${heading}, track:${track} } }, hsi_state={ north:${north}, map:${map}, scale:40 }, nav={}, nav_sense=()=>({});
      const hsi_chart=(x,cy,radius,ppm,rot,ox,oz)=>charts.push([cy,radius,ppm,rot,ox,oz]);
      const x=new Proxy({}, { get:(t,k)=>k==="moveTo"||k==="lineTo"?(px,py)=>moves.push([Math.round(px),Math.round(py)]):()=>{}, set:()=>true });
      ${lift('caution_display')} caution_display(x,${JSON.stringify(display)}); return { charts, moves };`)({ place: () => ({ x: 100, z: 200 }) }) as { charts: number[][]; moves: number[][] }
    const centre = shown('center', true, 0, false)
    expect(centre.charts).toEqual([[130, 110, 164 / (40 * 1852), 0, 100, 200]])
    expect(centre.moves.slice(0, 2)).toEqual([[256, 116], [256, 144]]) // the fuselage, up the display
    expect(shown('left', true, 0, false).charts).toEqual([]); expect(shown('center', false, 0, false).charts).toEqual([])
    expect(shown('center', true, Math.PI / 2, false).moves.slice(0, 2)).toEqual([[270, 130], [242, 130]]) // heading east, track north
    const east = shown('center', true, Math.PI / 2, false, Math.PI / 2)
    expect(east.moves.slice(0, 2)).toEqual([[256, 116], [256, 144]]); expect(east.charts[0][3]).toBe(Math.PI / 2) // track up: the chart turns, the symbol points up
    const north = shown('center', true, Math.PI / 2, true, Math.PI / 2)
    expect(north.moves.slice(0, 2)).toEqual([[270, 130], [242, 130]]); expect(north.charts[0][3]).toBe(0) // N UP
  })
})
