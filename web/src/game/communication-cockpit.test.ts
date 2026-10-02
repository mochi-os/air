// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import * as communication from './communication'
import * as identification from './identification'
import * as mids from './mids'

// The cockpit's side of the radios and the left console's panels (G5: #20,
// #81, #15): the communication and antenna select panels' switches, the volume
// controls, the radio a ship's call is heard on, the DDI's backup frequency
// control, the mission's IFF and COMM files, and the console's HYD ISOL and
// video record switches with what they drive. engine.ts cannot be imported
// (WebGL at module scope), so its functions are lifted as text and run around
// the real modules.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
function lift(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`${name} not found in engine.ts`)
  const rest = source.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  return end ? rest.slice(0, end.index + 1) : rest
}
function line(name: string): string {
  const m = new RegExp(`\\n(?:const|let) ${name}=[^\\n]*\\n`).exec(source)
  if (!m) throw new Error(`${name} not found in engine.ts`)
  return m[0]
}
const press = /\nfunction pit_press\(action,direction\)\{ const d=[\s\S]*?\n\t\} \}\n/.exec(source)?.[0] ?? ''
const accumulator = /\nconst ACCUMULATOR_CHARGE=[^\n]*\nlet apu_accumulator=[^\n]*\nfunction isolate_held[^\n]*\nfunction accumulator_step[^\n]*\nfunction accumulator_low[^\n]*\n/.exec(source)?.[0] ?? ''
const recorder = /\nlet taping=[^\n]*\nfunction recording\(\)\{[^\n]*\n/.exec(source)?.[0] ?? ''
const backup = /\nconst BACKUP_KEYS=[^\n]*\nconst BACKUP_LEGENDS=[^\n]*\n/.exec(source)?.[0] ?? ''
const CHANNELS = [305000, 262500, 275800, 318500]
interface Jet { grounded?: boolean; pump?: boolean; ac?: boolean; essential?: boolean; master?: string; up?: number; files?: string[] }
function cockpit<T>(body: string, o: Jet = {}): T {
  for (const [name, text] of [['pit_press', press], ['the APU accumulator', accumulator], ['the recorder', recorder], ['the backup keys', backup]]) if (!text) throw new Error(name + ' not found in engine.ts')
  return new Function('o', 'THREE', 'communication', 'identification', 'mids', `let sim_time=100, ufc_dirty=false, updates=0, gear_emergency=false, brake_accumulator=3000, master=o.master||"nav";
    const SHIP={ channels:${JSON.stringify(CHANNELS)}, icls:11 }, CODES={ one:"11", two:"0000", three:"1200" }, ACCUMULATOR={ full:3000, empty:1750, gas:80000 };
    const uhf={ one:communication.fresh(SHIP.channels), two:communication.fresh(SHIP.channels), panel:communication.panel(SHIP.icls), keypad:communication.backup(), pulled:"" }, squawk=identification.fresh(CODES), terminal=mids.fresh();
    const ufc={ func:"", entry:"", letter:"", error:false, option:-1, back:"" }, ufc_update=()=>{ updates++; }, buses={ ac:o.ac??true, essential:o.essential??true };
    const ownship={ grounded:!!o.grounded, up:{ y:o.up??1 } }, hydraulic=()=>o.pump??true, heard=[], comm=(text,colour)=>heard.push([text,colour]);
    const nav={ memory:{ files:o.files||["WYPT","TCN","IFF","COMM","GPS WYPT","GPS ALM"] } }, loads=[], navigate={ load:(n,m,file)=>loads.push(file) }, mission=()=>({}), mumi={ file:"", at:-Infinity };
    ${line('MUMI_FILES')} ${accumulator} ${recorder} ${backup}
    ${lift('volume_turn')}
    ${lift('comm_knob')}
    ${lift('radio')}
    ${lift('backup_press')}
    ${lift('ddi_backup')}
    ${lift('mumi_press')}
    ${press}
    ${body}`)(o, THREE, communication, identification, mids) as T
}
const presses = (action: string, ways: number[], read: string) => cockpit<unknown[]>(`const r=[${read}]; for(const d of ${JSON.stringify(ways)}){ pit_press(${JSON.stringify(action)},d); r.push(${read}); } return r;`)

describe('the communication panel\'s switches', () => {
  it('throw RLY up to CIPHER and down to PLAIN from OFF', () => {
    expect(presses('comm.relay', [1, 1, -1, -1, -1], 'uhf.panel.relay')).toEqual(['off', 'cipher', 'cipher', 'off', 'plain', 'plain'])
  })
  it('throw G XMT up to COMM 1 and down to COMM 2 from OFF', () => {
    expect(presses('comm.guard', [1, -1, -1, -1], 'uhf.panel.guard')).toEqual(['off', 'one', 'off', 'two', 'two'])
  })
  it('throw the ILS switch up to UFC and down to MAN, and over on a plain click', () => {
    expect(presses('comm.landing', [-1, -1, 1, 0, 0], 'uhf.panel.landing')).toEqual(['ufc', 'manual', 'manual', 'ufc', 'manual', 'ufc'])
  })
  it('turn the ILS channel selector a channel a click, 1 to 20', () => {
    expect(presses('comm.channel', [1, 0, -1], 'uhf.panel.channel')).toEqual([11, 12, 13, 12])
    expect(cockpit('uhf.panel.channel=20; pit_press("comm.channel",1); const top=uhf.panel.channel; uhf.panel.channel=1; pit_press("comm.channel",-1); return [top,uhf.panel.channel];')).toEqual([20, 1])
  })
  it('throw the IFF MASTER switch up to EMER', () => {
    expect(presses('identification.master', [1, 1, -1, 0, 0], 'squawk.master')).toEqual(['normal', 'emergency', 'emergency', 'normal', 'emergency', 'normal'])
  })
  it('throw the MODE 4 switch through OFF, DIS and DIS/AUD', () => {
    expect(presses('identification.alert', [1, 1, -1, -1, -1], 'squawk.alert')).toEqual(['display', 'audible', 'audible', 'display', 'off', 'off'])
  })
  it('throw the CRYPTO switch up to HOLD and down to ZERO from NORM', () => {
    expect(presses('identification.crypto', [1, 1, -1, -1, -1], 'squawk.crypto')).toEqual(['normal', 'hold', 'hold', 'normal', 'zero', 'zero'])
  })
})

describe('the antenna select panel', () => {
  it('throws COMM 1 up to UPPER and down to LOWER from AUTO', () => {
    expect(presses('antenna.comm', [1, -1, -1, -1], 'uhf.panel.antenna')).toEqual(['auto', 'upper', 'auto', 'lower', 'lower'])
  })
  it('throws IFF up to UPPER and down to LOWER from BOTH', () => {
    expect(presses('antenna.identification', [1, -1, -1, -1], 'squawk.antenna')).toEqual(['both', 'upper', 'both', 'lower', 'lower'])
  })
})

describe('the volume controls', () => {
  it('turn a fifth of their throw a click, between off and full', () => {
    expect(presses('volume.receiver', [-1, -1, -1, -1, -1, -1, 1], 'uhf.panel.volume.receiver')).toEqual([1, 0.8, 0.6, 0.4, 0.2, 0, 0, 0.2])
    expect(presses('volume.weapon', [1, -1], 'uhf.panel.volume.weapon')).toEqual([1, 1, 0.8])
    expect(presses('volume.tacan', [-1], 'uhf.panel.volume.tacan')).toEqual([1, 0.8])
  })
  it('turn a radio off at the bottom of its volume control, and on again off it', () => {
    expect(cockpit('const r=[]; for(const d of [-1,-1,-1,-1,-1,1]){ pit_press("comm.one.volume",d); r.push([uhf.one.volume,uhf.one.on]); } return [r,uhf.two.on,ufc_dirty];'))
      .toEqual([[[0.8, true], [0.6, true], [0.4, true], [0.2, true], [0, false], [0.2, true]], true, true])
    expect(cockpit('pit_press("comm.two.volume",-1); return [uhf.one.volume,uhf.two.volume];')).toEqual([1, 0.8])
  })
  it('move the model\'s RWR and WPN knobs with their levels, and set the Sidewinder tone\'s', () => {
    expect(source).toMatch(/\{ name:"volumereceiver", track:\/\^KNOB_RWR_VOL_LEFTPANEL_AN\/i, +drive:"volumereceiver" \},\n\t +\{ name:"volumeweapon", +track:\/\^KNOB_WPN_VOL_LEFTPANEL_AN\/i, +drive:"volumeweapon" \},/)
    expect(source).toMatch(/case "volumereceiver": f=st===ownship\?uhf\.panel\.volume\.receiver:1; break; case "volumeweapon": f=st===ownship\?uhf\.panel\.volume\.weapon:1; break;/)
    expect(source).toMatch(/\telse audio_seeker\(game_paused\?0:\(master==="9m"&&!pa\?\(lockon\?2:1\):0\),drinking,uhf\.panel\.volume\.weapon\);/)
    const audio = readFileSync(fileURLToPath(new URL('./audio.ts', import.meta.url)), 'utf8')
    expect(audio).toMatch(/state === 0 \? 0 : \(lock \? 0\.09 : 0\.13\) \* \(0\.7 \+ 0\.5 \* heat\) \* level,/)
  })
})

describe('the comm channel selector knobs', () => {
  it('step the channel a click each way, all the way round', () => {
    expect(presses('comm.one.channel', [1, -1, -1, -1, -1], 'uhf.one.channel')).toEqual([1, 2, 1, 'M', 'G', 20])
    expect(cockpit('pit_press("comm.two.channel",1); return [uhf.one.channel,uhf.two.channel];')).toEqual([1, 2])
  })
  it('put the UFC on the radio\'s comm display when pulled, and take it off when pulled again', () => {
    expect(cockpit('const r=[]; pit_press("comm.one.channel",0); r.push([ufc.func,uhf.pulled]); pit_press("comm.two.channel",0); r.push([ufc.func,uhf.pulled]); pit_press("comm.two.channel",0); r.push([ufc.func,uhf.pulled]); return [r,updates];'))
      .toEqual([[['comm', 'one'], ['comm', 'two'], ['', '']], 3])
  })
  it('clear a half-keyed entry and its error whichever way they move', () => {
    expect(cockpit('ufc.entry="3051"; ufc.error=true; pit_press("comm.one.channel",1); return [ufc.entry,ufc.error];')).toEqual(['', false])
  })
  it('are a click to turn and a middle click to pull, on each side of the UFC', () => {
    expect(source).toMatch(/\{ action:"comm\.one\.channel", at:\[6\.157,0\.34,-0\.088\], hold:"comm\.one\.channel" \}/)
    expect(source).toMatch(/\{ action:"comm\.two\.channel", at:\[6\.157,0\.34,0\.085\], hold:"comm\.two\.channel" \}/)
  })
})

// A ship's or a field's call is a line in the radio log, heard on comm 1.
describe('a call on the ship\'s frequencies', () => {
  const heard = (setup: string, o: Jet = {}) => cockpit<unknown[]>(`${setup} radio("PADDLES: WAVE OFF"); return heard;`, o)
  it('is heard on comm 1, in the radio\'s colour', () => {
    expect(heard('')).toEqual([['PADDLES: WAVE OFF', '#9fd0ff']])
  })
  it('is not heard with comm 1 off, its volume control at the bottom, whatever comm 2 is doing', () => {
    expect(heard('uhf.one.on=false;')).toEqual([])
    expect(heard('for(let k=0;k<5;k++) pit_press("comm.one.volume",-1);')).toEqual([])
    expect(heard('for(let k=0;k<4;k++) pit_press("comm.one.volume",-1);')).toHaveLength(1)
    expect(heard('uhf.two.on=false; uhf.two.volume=0;')).toHaveLength(1)
  })
  it('is not heard without the essential bus', () => {
    expect(heard('', { essential: false })).toEqual([])
    expect(heard('', { ac: false })).toHaveLength(1) // the radios are on the battery
  })
  it('needs the antenna selected to face the surface: LOWER upright, UPPER on its back, AUTO either way', () => {
    expect(heard('uhf.panel.antenna="lower";')).toHaveLength(1); expect(heard('uhf.panel.antenna="upper";')).toEqual([])
    expect(heard('uhf.panel.antenna="upper";', { up: -1 })).toHaveLength(1); expect(heard('uhf.panel.antenna="lower";', { up: -1 })).toEqual([])
    expect(heard('', { up: -1 })).toHaveLength(1); expect(heard('uhf.panel.antenna="auto";')).toHaveLength(1)
  })
  it('is how every call from the ship and the field goes out, and chat is not', () => {
    expect(source.match(/\bradio\((?!text\))/g)?.length).toBe(12) // tower, approach, marshal and paddles, and the pilot's own calls to them
    expect(source.match(/"#9fd0ff"/g)?.length).toBe(1) // the radio's colour, used nowhere but inside radio: no call is left on the ungated path
    expect(source).toMatch(/function feed\(fate,killer,victim\)\{ const line=report\(fate,killer,victim\); if\(line\) comm\(translate\(line\.text,line\.values\),"#ffd27f"\); \}/)
  })
})

// The UFC BU display (25.4): the DDI's backup frequency control for comm 1 and comm 2.
describe('the UFC BU display', () => {
  const pb = (...buttons: number[]) => `for(const b of ${JSON.stringify(buttons)}) backup_press(b);`
  const drawn = (setup: string) => cockpit<{ legends: [number, string, boolean, boolean][]; text: [string, number, number][] }>(`${setup} const legends=[], text=[], ddi_legend=(x,b,label,on,boxed)=>legends.push([b,label,on,boxed]);
    const x=new Proxy({}, { get:(t,k)=>k==="fillText"?(s,px,py)=>text.push([String(s),px,py]):()=>{}, set:()=>true }); ddi_backup(x); return { legends, text };`)
  it('lays the keypad down the display\'s sides, the radios across its top, and ENT, CLR and OVRD', () => {
    const { legends } = drawn('')
    const at = (label: string) => legends.find((l) => l[1] === label)?.[0]
    expect(['1', '2', '3', '4', '5'].map(at)).toEqual([5, 4, 3, 2, 1]) // down the left
    expect(['6', '7', '8', '9', '0'].map(at)).toEqual([11, 12, 13, 14, 15]) // and the right
    expect(['COM1', 'COM2', 'OVRD', 'ENT', 'CLR'].map(at)).toEqual([6, 7, 10, 20, 16])
    expect(legends).toHaveLength(15)
    expect(legends.every((l) => l[2])).toBe(true); expect(legends.some((l) => l[3])).toBe(false)
  })
  it('shows nothing of a radio until COM1 or COM2 is pressed', () => {
    expect(drawn('').text).toEqual([])
  })
  it('shows the radio selected, the frequency it is working, and the scratchpad over them', () => {
    expect(drawn(pb(6)).text).toEqual([['', 256, 206], ['COM1', 256, 246], ['305.000', 256, 286]])
    expect(drawn(pb(7)).text).toEqual([['', 256, 206], ['COM2', 256, 246], ['305.000', 256, 286]])
    expect(drawn(pb(6, 5, 4, 3)).text[0]).toEqual(['123', 256, 206])
  })
  it('stores a keyed frequency with ENT as the mission computer\'s for the radio, and OVRD puts the radio on it, boxed', () => {
    const d = drawn(pb(6, 4, 12, 1, 3, 1, 15, 20)) // 2 7 5 3 5 0, ENT
    expect(d.text).toEqual([['', 256, 206], ['COM1', 256, 246], ['305.000', 256, 286]]) // stored, and the radio still on its own channel
    const over = drawn(pb(6, 4, 12, 1, 3, 1, 15, 20, 10))
    expect(over.text[2]).toEqual(['275.350', 256, 286])
    expect(over.legends.find((l) => l[1] === 'OVRD')?.[3]).toBe(true)
    expect(cockpit(`${pb(6, 4, 12, 1, 3, 1, 15, 20, 10)} return [uhf.one.stored,uhf.one.override,uhf.two.override,communication.tuned(uhf.one)];`)).toEqual([275350, true, false, 275350])
  })
  it('clears the scratchpad with CLR, and keeps an entry that is not a frequency', () => {
    expect(drawn(pb(6, 5, 4, 16)).text[0][0]).toBe('')
    expect(drawn(pb(6, 5, 4, 3, 20)).text[0][0]).toBe('123')
  })
  it('shows the guard frequency for the radio G XMT has on guard', () => {
    expect(drawn(pb(6) + ' uhf.panel.guard="one";').text[2][0]).toBe('243.000')
    expect(drawn(pb(7) + ' uhf.panel.guard="one";').text[2][0]).toBe('305.000')
  })
  it('takes no press off its pushbuttons, and redraws the UFC on one it takes', () => {
    expect(cockpit('return [backup_press(8),backup_press(17),ufc_dirty,backup_press(6),ufc_dirty];')).toEqual([false, false, false, true, true])
  })
  it('is on the SUPT menu at its pushbutton, with its own page', () => {
    expect(source).toMatch(/\[16,"UFC BU","backup"\]/)
    expect(source).toMatch(/backup:\{draw:ddi_backup,press:backup_press\}/)
  })
})

// The mission's IFF and COMM files on the MUMI display (figure 2-21).
describe('the MUMI display\'s IFF and COMM files', () => {
  it('reads the mission\'s codes back into the IFF', () => {
    expect(cockpit('squawk.transponder.codes.three="7700"; squawk.interrogator.codes.one="73"; const took=mumi_press(8); return [took,squawk.transponder.codes.three,squawk.interrogator.codes.one,loads,mumi.file];'))
      .toEqual([true, '1200', '11', ['IFF'], 'IFF'])
  })
  it('reads the mission\'s presets back into both radios, and redraws the UFC', () => {
    expect(cockpit('uhf.one.presets[0]=251000; uhf.two.presets[3]=251000; uhf.one.presets[9]=251000; const took=mumi_press(13); return [took,uhf.one.presets[0],uhf.two.presets[3],uhf.one.presets[9],ufc_dirty];'))
      .toEqual([true, 305000, 318500, 251000, true]) // a preset the mission does not carry keeps what was keyed
  })
  it('takes them in flight too, as the GPS files and unlike the waypoints', () => {
    expect(cockpit('return [mumi_press(8),mumi_press(13),mumi_press(5)];', { grounded: false })).toEqual([true, true, false])
  })
  it('reads neither from a memory unit that does not carry it', () => {
    expect(cockpit('squawk.transponder.codes.three="7700"; return [mumi_press(8),mumi_press(13),squawk.transponder.codes.three];', { files: ['WYPT', 'TCN'] })).toEqual([false, false, '7700'])
  })
  it('has them in every mission\'s memory unit', () => {
    const navigation = readFileSync(fileURLToPath(new URL('./navigation.ts', import.meta.url)), 'utf8')
    expect(navigation).toMatch(/'GPS ALM', 'IFF', 'COMM'\]/)
  })
})

// The APU accumulator (2.4.2.2, 2.7.4, the APU ACCUM procedure) and HYD ISOL.
describe('the APU accumulator', () => {
  const run = (body: string, o: Jet = {}) => cockpit<unknown>(body, o)
  it('is spent by the emergency gear extension, which raises APU ACCUM', () => {
    expect(run('const a=[apu_accumulator,accumulator_low()]; pit_press("gear.emergency",0); return [a,[apu_accumulator,accumulator_low()]];')).toEqual([[1, false], [0, true]])
  })
  it('recharges by itself on the wheels: ten seconds to put the caution out, twenty for a full charge', () => {
    expect(run('apu_accumulator=0; const r=[]; for(const t of [9.5,1,9,1]){ accumulator_step(t); r.push([Math.round(apu_accumulator*1000)/1000,accumulator_low()]); } return r;', { grounded: true }))
      .toEqual([[0.475, true], [0.525, false], [0.975, false], [1, false]])
  })
  it('does not recharge in flight with HYD ISOL at NORM', () => {
    expect(run('apu_accumulator=0; accumulator_step(30); return apu_accumulator;')).toBe(0)
  })
  it('recharges in flight while HYD ISOL is held at ORIDE, which a click holds for the twenty seconds', () => {
    expect(run('apu_accumulator=0; pit_press("hydraulic.isolate",0); const held=[isolate_held()]; for(let k=0;k<25;k++){ sim_time+=1; if(k===19) held.push(isolate_held()); accumulator_step(1); } held.push(isolate_held()); return [held,Math.round(apu_accumulator*1000)/1000];'))
      .toEqual([[true, true, false], 1])
    expect(run('apu_accumulator=0; pit_press("hydraulic.isolate",0); const low=[]; for(let k=1;k<=11;k++){ sim_time+=1; accumulator_step(1); if(k===9||k===11) low.push(accumulator_low()); } return low;')).toEqual([true, false]) // the caution out ten seconds in
  })
  it('does not recharge without hydraulic system 2', () => {
    expect(run('apu_accumulator=0; accumulator_step(30); return apu_accumulator;', { grounded: true, pump: false })).toBe(0)
  })
  it('is stepped each frame, and raises the DDI\'s APU ACCUM caution', () => {
    expect(source).toMatch(/\n\taccumulator_step\(dt\);/)
    expect(source).toMatch(/\n\tif\(accumulator_low\(\)\) captions\.push\("APU ACCUM"\);/)
    expect(source).toMatch(/\{ action:"hydraulic\.isolate", at:\[5\.468,-0\.037,-0\.45\] \}/)
  })
})

// The video record mode selector (2.13.8.7) and the RCDR ON light it drives.
describe('the video record mode selector', () => {
  it('goes up to MAN and down to AUTO from OFF', () => {
    expect(cockpit('const r=[taping]; for(const d of [1,1,-1,-1,-1,0]){ pit_press("recorder",d); r.push(taping); } return r;')).toEqual(['automatic', 'off', 'manual', 'off', 'automatic', 'automatic', 'off'])
  })
  it('records continuously at MAN, in a weapon\'s master mode at AUTO, never at OFF, and only on ac power', () => {
    const on = (taping: string, o: Jet = {}) => cockpit<boolean>(`taping=${JSON.stringify(taping)}; return recording();`, o)
    expect([on('manual'), on('automatic'), on('off')]).toEqual([true, false, false])
    expect([on('manual', { master: '9m' }), on('automatic', { master: '9m' }), on('off', { master: '9m' })]).toEqual([true, true, false])
    expect(on('manual', { ac: false })).toBe(false)
  })
  it('has its switch on the left of the main panel', () => {
    expect(source).toMatch(/\{ action:"recorder", at:\[6\.211,0\.055,-0\.206\] \}/)
  })
})

describe('the left console\'s click spots', () => {
  it('put each switch of the communication and antenna select panels where FO-5 draws it', () => {
    for (const [action, at] of Object.entries({ 'antenna.comm': '5.565,-0.04,-0.431', 'antenna.identification': '5.619,-0.041,-0.431', 'comm.relay': '5.556,-0.05,-0.373', 'comm.guard': '5.628,-0.049,-0.38', 'comm.landing': '5.649,-0.057,-0.331',
      'comm.channel': '5.592,-0.056,-0.338', 'identification.crypto': '5.558,-0.065,-0.283', 'identification.alert': '5.601,-0.066,-0.284', 'identification.master': '5.641,-0.065,-0.282', 'volume.tacan': '5.681,-0.04,-0.367' }))
      expect(source, action).toContain(`{ action:"${action}", at:[${at}] }`)
  })
  it('put the radios\' volume controls at the UFC\'s lower corners', () => {
    expect(source).toContain('{ action:"comm.one.volume", at:[6.14,0.417,-0.089] }'); expect(source).toContain('{ action:"comm.two.volume", at:[6.14,0.417,0.086] }')
  })
  it('give every click spot an action pit_press answers', () => {
    const spots = [...source.matchAll(/\{ action:"([a-z.0-9]+)", at:\[[^\]]*\](?:, hold:"([a-z.]+)")? \}/g)].flatMap((m) => [m[1], m[2]].filter(Boolean))
    expect(spots.length).toBeGreaterThan(30)
    for (const action of new Set(spots)) {
      const prefix = ['knob.', 'travel.', 'display.', 'jettison.station.', 'receiver.'].some((p) => action.startsWith(p))
      expect(prefix || press.includes(`case "${action}":`), action).toBe(true)
    }
  })
})
