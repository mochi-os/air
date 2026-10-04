// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as countermeasures from './countermeasures'
import * as communication from './communication'
import { KEY_DEFAULTS } from './keys'

// The cockpit's side of the dispenser/EMC panel and the RWR control indicator
// (G5: #10, #9): the DISPENSER switch, the ECM knob and the indicator's
// pushbuttons as clicks and keys reach them, what the jammer tells the rest of
// the game, and the RWR's tones at its volume control's level. engine.ts cannot
// be imported (WebGL at module scope), so its functions are lifted as text and
// run around the real modules.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
function lift(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`${name} not found in engine.ts`)
  const rest = source.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  return end ? rest.slice(0, end.index + 1) : rest
}
const press = /\nfunction pit_press\(action,direction\)\{ const d=[\s\S]*?\n\t\} \}\n/.exec(source)?.[0] ?? ''
interface Jet { airborne?: boolean; ac?: boolean; painted?: boolean; warned?: boolean }
function cockpit<T>(body: string, o: Jet = {}): T {
  if (!press) throw new Error('pit_press not found in engine.ts')
  return new Function('o', 'countermeasures', 'communication', `let sim_time=50; const buses={ ac:o.ac??true }, RWR={ locked:()=>!!o.painted, warned:()=>!!o.warned };
    const suite=countermeasures.fresh(o.airborne??true), ran=[], dispense=(way)=>ran.push(way);
    ${lift('jammer_armed')}
    ${lift('jammer_loud')}
    ${press}
    ${body}`)(o, countermeasures, communication) as T
}

describe('the DISPENSER switch', () => {
  it('goes up a position on a right click and down on a left, OFF, ON and BYPASS, stopping at its ends', () => {
    expect(cockpit('const r=[suite.dispenser]; for(const d of [1,1,-1,-1,-1]){ pit_press("dispenser",d); r.push(suite.dispenser); } return r;')).toEqual(['on', 'bypass', 'bypass', 'on', 'off', 'off'])
  })
  it('turns on and off on its key, off from BYPASS too', () => {
    expect(cockpit('const r=[]; for(let k=0;k<3;k++){ pit_press("dispenser",0); r.push(suite.dispenser); } suite.dispenser="bypass"; pit_press("dispenser",0); r.push(suite.dispenser); return r;')).toEqual(['off', 'on', 'off', 'off'])
  })
  it('has a key, shift U, for the views without the panel', () => {
    expect(KEY_DEFAULTS.dispenser).toBe('Shift+KeyU')
    expect(source).toMatch(/if\(ch===key_of\("dispenser"\)\) pit_press\("dispenser",0\);/)
  })
})

describe('the sill\'s dispense button', () => {
  it('runs the programme, as neither way on the throttle\'s switch', () => {
    expect(cockpit('pit_press("dispense",0); pit_press("dispense",1); return ran;')).toEqual([0, 0])
    expect(source).toMatch(/\{ action:"dispense", at:\[5\.863,0\.196,-0\.326\] \}/)
  })
})

describe('the ECM knob', () => {
  it('turns a position a click, clockwise on a right click or a plain one', () => {
    expect(cockpit('const r=[suite.jammer]; for(const d of [1,0,-1,-1,-1,-1,-1]){ pit_press("jammer",d); r.push(suite.jammer); } return r;', { airborne: true }))
      .toEqual(['receive', 'transmit', 'transmit', 'receive', 'test', 'standby', 'off', 'off'])
  })
  it('starts the jammer\'s test as it comes to BIT, timed from then', () => {
    expect(cockpit('suite.jammer="standby"; pit_press("jammer",1); return [suite.jammer,suite.tested];')).toEqual(['test', 50])
  })
  it('goes to XMIT and back to REC on the jammer key, without the panel', () => {
    expect(source).toMatch(/if\(ch===key_of\("jammer"\)\) countermeasures\.toggle\(suite\);/)
  })
})

describe('the jammer', () => {
  const state = (jammer: string, o: Jet = {}) => cockpit<[boolean, boolean]>(`suite.jammer=${JSON.stringify(jammer)}; return [jammer_armed(),jammer_loud()];`, o)
  it('is armed with the knob at XMIT, and radiates only while a radar or a missile has the jet', () => {
    expect(state('transmit')).toEqual([true, false])
    expect(state('transmit', { painted: true })).toEqual([true, true])
    expect(state('transmit', { warned: true })).toEqual([true, true])
    expect(state('receive', { painted: true })).toEqual([false, false])
  })
  it('is neither without ac power', () => {
    expect(state('transmit', { painted: true, ac: false })).toEqual([false, false])
  })
  it('tells a match the knob is at XMIT, on power, as the sample\'s jammer flag', () => {
    expect(source).toMatch(/radar:fox3_flag, jammer:jammer_armed\(\), eject:eject_flag,/)
  })
})

describe('ECM JETT', () => {
  it('does nothing: there is no pod aboard to jettison', () => {
    expect(cockpit('const before=JSON.stringify(suite); pit_press("jammer.jettison",0); return JSON.stringify(suite)===before;')).toBe(true)
  })
})

describe('the RWR control indicator\'s pushbuttons', () => {
  it('reach the set by name: POWER, DISPLAY, SPECIAL, OFFSET and BIT', () => {
    expect(cockpit('for(const b of ["display","special","offset","test"]) pit_press("receiver."+b,0); return suite.receiver;')).toEqual({ power: true, limit: true, offset: true, special: true, tested: 50 })
    expect(cockpit('pit_press("receiver.power",0); return suite.receiver.power;')).toBe(false)
  })
  it('do nothing but POWER with the set off', () => {
    expect(cockpit('pit_press("receiver.power",0); pit_press("receiver.display",0); pit_press("receiver.test",0); return suite.receiver;')).toEqual({ power: false, limit: false, offset: false, special: false, tested: -Infinity })
  })
})

describe('the RWR\'s tones', () => {
  it('sound at the RWR volume control\'s level, and not at all with the set off or without ac power', () => {
    expect(source).toMatch(/\n\tconst level=suite\.receiver\.power&&buses\.ac\?uhf\.panel\.volume\.receiver:0;[^\n]*\n\tif\(events\.fresh>0\) audio_rwr_paint\(level\);\n\tif\(events\.missile&&level>0&&sim_time-rwr_called>3\)\{ rwr_called=sim_time; notice\(translate\("MISSILE"\)\); \}[^\n]*\n\taudio_rwr\(RWR\.locked\(\),level\); \}/)
  })
  it('scale the lock warble and the new-threat chirp by that level', () => {
    const audio = readFileSync(fileURLToPath(new URL('./audio.ts', import.meta.url)), 'utf8')
    expect(audio).toMatch(/lock \? \(Math\.floor\(t \* 8\) % 2 \? 0\.1 : 0\.015\) \* level : 0,/)
    expect(audio).toMatch(/export function audio_rwr_paint\(level: number\): void \{\n {2}if \(!context \|\| context\.state !== 'running' \|\| level <= 0\) return/)
    expect(audio).toMatch(/gain\.gain\.exponentialRampToValueAtTime\(0\.001 \+ 0\.109 \* level, t \+ s \+ 0\.02\)/)
  })
})

