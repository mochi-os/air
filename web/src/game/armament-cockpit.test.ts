// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as armament from './armament'
import * as countermeasures from './countermeasures'
import * as communication from './communication'
import * as identification from './identification'
import * as mids from './mids'
import * as stores from './stores'
import * as faces from './faces'
import * as THREE from 'three'
import { KEY_DEFAULTS } from './keys'

// The cockpit's side of the master arm panel (G5: #7, #109): what a spawn finds,
// the MASTER ARM switch and what it holds, the A/A master mode button, the
// selective and emergency jettison controls, the fire extinguisher and the
// STORES page's ARM status. engine.ts cannot be imported (WebGL at module
// scope), so its functions are lifted as text and run around the real modules,
// with stand-ins for the jet.
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
// the panels' state and how a spawn leaves it, as the engine declares them
const panels = /\nconst CODES=[\s\S]*?\nfunction arm_sense\(\)\{[^\n]*\n/.exec(source)?.[0] ?? ''
const modules = { armament, countermeasures, communication, identification, mids, stores }
interface Jet { grounded?: boolean; handle?: number; gear?: number; rounds?: number; missiles?: number; amraams?: number; master?: string; pushed?: boolean[] }
// cockpit runs a body against the panels in a jet flying clean with the gear up, armed as an air start leaves it
function cockpit<T>(body: string, o: Jet = {}): T {
  for (const [name, text] of [['pit_press', press], ['the panels', panels]]) if (!text) throw new Error(name + ' not found in engine.ts')
  return new Function('o', ...Object.keys(modules), `const SHIP={ channels:[305000,262500,275800,318500], icls:11 }, CHAFF_LOAD=20, FLARE_LOAD=40, secured=o.pushed||[false,false], D2R=Math.PI/180;
    let sim_time=0, master=o.master||"nav", apu_accumulator=0.4, isolate_clicked=3, taping="off", ufc_dirty=false, ddi_dirty=false, recalled=0;
    const ownship={ gearTarget:o.handle??1, gear:o.gear??1, rounds:o.rounds??578, msl:o.missiles??2, amraam:o.amraams??4, failures:[7], loadout:{} }, on_ground=()=>!!o.grounded;
    const said=[], notice=(t)=>said.push(t), translate=(t)=>t, dropped=[], jettison_stations=(stations,what)=>{ dropped.push([stations,what]); return true; }, ddi_recall=()=>{ recalled++; };
    ${line('EMERGENCY_HOLD')} ${line('EMERGENCY_PAIRS')} ${line('emergency')} ${panels} ${lift('ddi_family')} ${lift('set_master')} ${line('air_weapon')} ${lift('air_press')} ${lift('jettison_press')} ${lift('emergency_update')} ${press}
    systems_fresh(!o.grounded); ${body}`)(o, ...Object.values(modules)) as T
}

describe('what a spawn finds', () => {
  interface Found { arm: boolean; select: string; stations: number[]; discharged: boolean; dispenser: string; jammer: string; receiver: boolean; one: [boolean, unknown, number]; two: [boolean, unknown, number, number]; landing: number; codes: unknown; held: boolean; terminal: boolean; flag: boolean; failures: number[]; accumulator: number; clicks: number[]; taping: string }
  const found = (o: Jet) => cockpit<Found>(`arms.stations=[5]; arms.discharged=true; extinguish_flag=true; systems_fresh(!o.grounded);
    return { arm:arms.arm, select:arms.select, stations:arms.stations, discharged:arms.discharged, dispenser:suite.dispenser, jammer:suite.jammer, receiver:suite.receiver.power,
      one:[uhf.one.on,uhf.one.channel,communication.selected(uhf.one)], two:[uhf.two.on,uhf.two.channel,communication.selected(uhf.two),uhf.two.stored], landing:uhf.panel.channel,
      codes:squawk.transponder.codes, held:squawk.held, terminal:terminal.on, flag:extinguish_flag, failures:ownship.failures, accumulator:apu_accumulator, clicks:[isolate_clicked,emergency_clicked], taping };`, o)
  it('is armed, dispensing and listening in the air', () => {
    expect(found({})).toMatchObject({ arm: true, select: 'safe', stations: [], discharged: false, dispenser: 'on', jammer: 'receive', receiver: true })
  })
  it('is safe, with the dispenser and the jammer off, on the wheels', () => {
    expect(found({ grounded: true })).toMatchObject({ arm: false, dispenser: 'off', jammer: 'off', receiver: true })
  })
  it('has both radios on, comm 1 on the ship\'s first preset and comm 2 on its second, and the ILS selector on the ship\'s channel', () => {
    expect(found({})).toMatchObject({ one: [true, 1, 305000], two: [true, 2, 262500, 262500], landing: 11 })
  })
  it('has the IFF on with the mission\'s codes and its mode 4 keys, and the Link 16 terminal on', () => {
    expect(found({})).toMatchObject({ codes: { one: '11', two: '0000', three: '1200' }, held: true, terminal: true })
  })
  it('starts again with no extinguisher press pending, no station failed, a charged APU accumulator and the recorder at AUTO', () => {
    expect(found({})).toMatchObject({ flag: false, failures: [], accumulator: 1, clicks: [-Infinity, -Infinity], taping: 'automatic' })
  })
  it('is how every flight starts: by where it starts, and armed on a respawn into a match', () => {
    expect(source).toMatch(/\n\tsystems_fresh\(st!=="carrier"&&st!=="runway"\);/)
    expect(source).toMatch(/update_rails\(ownship, ownship\.msl\); systems_fresh\(true\); Object\.assign\(hmd,helmet\.fresh\(true,hmd\.error,hmd\.direction\)\); \}/) // a fresh jet's helmet too, aligned
  })
})

describe('the MASTER ARM switch', () => {
  it('goes up to ARM and down to SAFE, and changes over on its key', () => {
    expect(cockpit('const r=[arms.arm]; pit_press("arm",-1); r.push(arms.arm); pit_press("arm",-1); r.push(arms.arm); pit_press("arm",1); r.push(arms.arm); pit_press("arm",0); r.push(arms.arm); pit_press("arm",0); r.push(arms.arm); return r;'))
      .toEqual([true, false, false, true, false, true])
  })
  it('has a key, U, for the views without the panel', () => {
    expect(KEY_DEFAULTS.arm).toBe('KeyU')
    expect(source).toMatch(/if\(ch===key_of\("arm"\)\) pit_press\("arm",0\);/)
  })
  it('holds the gun: the trigger fires only at ARM', () => {
    expect(source).toMatch(/\n\tinput\.guns=hotas\.trigger&&master==="gun"&&arms\.arm;/)
  })
  // trigger_missile's own closing brace stands alone, so the lift stops short of it
  const fired = (arm: boolean, master: string) => new Function('arm', 'master', `let fired=""; const said=[], arms={ arm }, mc=()=>({ one:true, two:true }), notice=(t)=>said.push(t), translate=(t)=>t, weapons_hold=false, ownship={ launching:false, gear:1, msl:2 }, MULTIPLAYER=false, has_enemy=false;
    const trigger_amraam=()=>{ fired="amraam"; }, launch_missile=()=>{ fired="sidewinder"; return true; }, cheat=()=>false, audio_launch=()=>{}, update_rails=()=>{}, seeker_now={ quarry:null }; ${lift('trigger_missile')}
} trigger_missile(); return [fired, said];`)(arm, master) as [string, string[]]
  it('holds the missiles on their rails at SAFE, and says why', () => {
    expect(fired(true, '9m')).toEqual(['sidewinder', []]); expect(fired(true, '120c')).toEqual(['amraam', []])
    expect(fired(false, '9m')).toEqual(['', ['MASTER ARM SAFE']]); expect(fired(false, '120c')).toEqual(['', ['MASTER ARM SAFE']])
  })
  it('says nothing for the trigger pulled in the navigation master mode, which selects no weapon', () => {
    expect(fired(false, 'nav')).toEqual(['', []])
  })
})

describe('the A/A master mode button', () => {
  const mode = (o: Jet, body = 'pit_press("mode.air",0); return master;') => cockpit<string>(body, o)
  it('enters A/A from NAV on the gun, the weapon a flight starts with selected there', () => {
    expect(mode({})).toBe('gun')
  })
  it('enters it on the first weapon aboard when that one is spent: a Sidewinder, then an AMRAAM', () => {
    expect(mode({ rounds: 0 })).toBe('9m')
    expect(mode({ rounds: 0, missiles: 0 })).toBe('120c')
    expect(mode({ rounds: 0, missiles: 0, amraams: 0 })).toBe('gun') // nothing aboard: the gun, empty
  })
  it('returns to the weapon last selected in A/A, if it is still aboard', () => {
    expect(mode({}, 'set_master("120c"); set_master("nav"); pit_press("mode.air",0); return master;')).toBe('120c')
    expect(mode({ amraams: 0 }, 'set_master("120c"); set_master("nav"); pit_press("mode.air",0); return master;')).toBe('9m')
    expect(mode({}, 'set_master("9m"); set_master("nav"); pit_press("mode.air",0); return master;')).toBe('9m')
  })
  it('deselects A/A when pressed in it, which is NAV', () => {
    expect(mode({ master: '9m' })).toBe('nav')
    expect(mode({}, 'pit_press("mode.air",0); pit_press("mode.air",0); return master;')).toBe('nav')
  })
  it('recalls the displays for the mode it changes to', () => {
    expect(cockpit('pit_press("mode.air",0); const a=recalled; pit_press("mode.air",0); return [a,recalled];')).toEqual([1, 2])
  })
})

describe('the A/G master mode button', () => {
  it('selects nothing: there is no air-to-ground weapon or sensor aboard', () => {
    expect(cockpit('pit_press("mode.ground",0); return [master,recalled];')).toEqual(['nav', 0])
    expect(cockpit('pit_press("mode.ground",0); return master;', { master: '9m' })).toBe('9m')
  })
})

describe('the selective jettison controls', () => {
  it('turn the SELECT JETT knob a position a click, clockwise on a right click', () => {
    expect(cockpit('const r=[arms.select]; pit_press("jettison.select",1); r.push(arms.select); pit_press("jettison.select",-1); pit_press("jettison.select",-1); r.push(arms.select); pit_press("jettison.select",0); r.push(arms.select); return r;'))
      .toEqual(['safe', 'right', 'left', 'safe'])
  })
  it('light and put out a station\'s select button by its station number', () => {
    expect(cockpit('pit_press("jettison.station.5",0); pit_press("jettison.station.8",0); const a=[...arms.stations]; pit_press("jettison.station.5",0); pit_press("jettison.station.4",0); return [a,arms.stations];')).toEqual([[5, 8], [8]])
  })
  const jett = (setup: string, o: Jet = {}) => cockpit<{ dropped: [number[], string][]; said: string[] }>(`${setup} pit_press("jettison.release",0); return { dropped, said };`, o)
  it('drop the selected stations\' stores, or their racks, with the JETT button', () => {
    expect(jett('arms.select="stores"; arms.stations=[7,3];')).toEqual({ dropped: [[[3, 7], 'stores']], said: [] })
    expect(jett('arms.select="rack"; arms.stations=[5];')).toEqual({ dropped: [[[5], 'rack']], said: [] })
    expect(jett('arms.select="left"; arms.stations=[5];').dropped).toEqual([[[4], 'stores']])
  })
  it('drop nothing at SAFE or with no station selected, and say nothing', () => {
    expect(jett('arms.stations=[5];')).toEqual({ dropped: [], said: [] })
    expect(jett('arms.select="stores";')).toEqual({ dropped: [], said: [] })
  })
  it('refuse with MASTER ARM at SAFE, and say so', () => {
    expect(jett('arms.arm=false; arms.select="stores"; arms.stations=[5];')).toEqual({ dropped: [], said: ['MASTER ARM SAFE'] })
  })
  it('refuse on the wheels, with the gear handle down or a gear not up and locked, and say so', () => {
    const set = 'arms.arm=true; arms.select="stores"; arms.stations=[5];'
    expect(jett(set, { grounded: true })).toEqual({ dropped: [], said: ['JETTISON: GEAR'] })
    expect(jett(set, { handle: 0 })).toEqual({ dropped: [], said: ['JETTISON: GEAR'] })
    expect(jett(set, { gear: 0.5 })).toEqual({ dropped: [], said: ['JETTISON: GEAR'] })
  })
  it('have the JETT button in the knob: a middle click on it', () => {
    expect(source).toMatch(/\{ action:"jettison\.select", at:\[6\.193,0\.017,-0\.281\], hold:"jettison\.release" \}/)
  })
  it('keep the tanks key behind MASTER ARM too', () => {
    expect(source).toMatch(/if\(ch===key_of\("jettison\.tanks"\) && !dev_parked\)\{[^\n]*\n\t\t\tif\(!arms\.arm\) notice\(translate\("MASTER ARM SAFE"\)\);[^\n]*\n\t\t\telse if\(on_ground\(\)\|\|\(ownship\.gearTarget\?\?1\)<0\.5\) notice\(translate\("JETTISON: GEAR"\)\);/)
  })
})

describe('the emergency jettison button', () => {
  // a click cannot be held, so it holds the button for the whole sequence: the three pairs, 0.3 s apart
  const clicked = (frames: number, hold = '') => cockpit<[number[], string][]>(`${hold} sim_time=10; pit_press("jettison.emergency",0);
    for(let k=0;k<${frames};k++){ emergency_update(0.05, sim_time-emergency_clicked<EMERGENCY_HOLD); sim_time+=0.05; } return dropped;`)
  it('releases the outboard pair, the inboard pair and the centreline with their racks from one click', () => {
    expect(clicked(40)).toEqual([[[2, 8], 'rack'], [[3, 7], 'rack'], [[5], 'rack']])
  })
  it('releases them a pair at a time, not all at once', () => {
    expect(clicked(1)).toEqual([[[2, 8], 'rack']])
  })
  it('needs no MASTER ARM', () => {
    expect(clicked(40, 'arms.arm=false;')).toHaveLength(3)
  })
  it('is held by its key or by a click, each frame', () => {
    expect(source).toMatch(/\n\temergency_update\(dt, keys\.has\(key_of\("jettison\.emergency"\)\)\|\|sim_time-emergency_clicked<EMERGENCY_HOLD\);/)
  })
})

describe('the FIRE EXTGH pushbutton', () => {
  const pushed = (o: Jet, presses = 1) => cockpit<{ flag: boolean; discharged: boolean; flags: boolean[] }>(`const flags=[]; for(let k=0;k<${presses};k++){ pit_press("extinguisher",0); flags.push(extinguish_flag); extinguish_flag=false; }
    return { flag:flags[0], discharged:arms.discharged, flags };`, o)
  it('discharges the bottle with READY on: a fire light pushed in', () => {
    expect(pushed({ pushed: [true, false] })).toMatchObject({ flag: true, discharged: true })
    expect(pushed({ pushed: [false, true] })).toMatchObject({ flag: true, discharged: true })
  })
  it('does nothing without READY', () => {
    expect(pushed({})).toMatchObject({ flag: false, discharged: false })
  })
  it('discharges once: there is one bottle', () => {
    expect(pushed({ pushed: [true, false] }, 3).flags).toEqual([true, false, false])
  })
  it('reaches the damage model: alone as its third bit, in a match as the sample\'s extinguish flag, sent once', () => {
    expect(source).toMatch(/battle_progress\(ownship\.throttle,battle_tick\+\+,battle_reset,\(secured\[0\]\?1:0\)\|\(secured\[1\]\?2:0\)\|\(extinguish_flag\?4:0\)\); battle_reset=false; extinguish_flag=false;/)
    expect(source).toMatch(/eject:eject_flag, solo:solo_flag, extinguish:extinguish_flag, /)
    expect(source).toMatch(/if\(sequence>0\)\{ flare_flag=false; solo_flag=false; chaff_flag=false; missile_flag=false; fox3_flag=false; fox3_visual=false; eject_flag=false; extinguish_flag=false; onspeed_owed=false; reset_owed=false; \}/)
  })
})

// The STORES page (#109): the ARM status, and FAIL at a station whose store tore away.
describe('the STORES page', () => {
  const page = (o: Jet & { failures?: number[]; arm?: boolean } = {}) => cockpit<[string, number, number][]>(`arms.arm=o.arm??true; ownship.failures=o.failures||[]; const hud_sms=0;
    const stores_rounds=stores.rounds, stores_amraams=stores.amraams, stores_entries=stores.entries, text=[];
    const x=new Proxy({}, { get:(t,k)=>k==="fillText"?(s,px,py)=>text.push([String(s),px,py]):()=>{}, set:()=>true });
    ${lift('ddi_sms')}
    ddi_sms(x,"left"); return text;`, o)
  const status = (o: Parameters<typeof page>[0]) => page(o).filter((t) => t[0] === 'ARM' || t[0] === 'SAFE')
  it('reads ARM with the ARM conditions met: MASTER ARM at ARM, off the wheels, the gear handle up', () => {
    expect(status({})).toEqual([['ARM', 256, 66]])
  })
  it('reads SAFE with the switch at SAFE, on the wheels, or with the gear handle down', () => {
    expect(status({ arm: false })).toEqual([['SAFE', 256, 66]])
    expect(status({ grounded: true, arm: true })).toEqual([['SAFE', 256, 66]])
    expect(status({ handle: 0 })).toEqual([['SAFE', 256, 66]])
  })
  it('writes FAIL at a station whose store tore away, and nowhere else', () => {
    expect(page({}).filter((t) => t[0] === 'FAIL')).toEqual([])
    expect(page({ failures: [3] }).filter((t) => t[0] === 'FAIL')).toEqual([['FAIL', 160, 362]])
    expect(page({ failures: [3, 8] }).filter((t) => t[0] === 'FAIL').map((t) => t[1])).toEqual([160, 400])
  })
  it('is told which station it was when a rack lets go under load', () => {
    expect(source).toMatch(/jettison_stations\(\[station\],"rack"\); ownship\.torn=true; \(ownship\.failures\|\|\(ownship\.failures=\[\]\)\)\.push\(station\); \}/)
  })
})

// The faces drawn over the model's panels (faces.ts; FO-5 items 12, 17, 20, 35 and 36): where the engine seats
// them, what it gives them to show, when it redraws them, and how a click on one reaches its control.
describe('the panels drawn over the model', () => {
  const seats = /\nconst FACE_SEATS=\{[\s\S]*?\n\tdefence:[^\n]*\n/.exec(source)?.[0] ?? '', mark = /\nconst JETTISON_MARK=[^\n]*\n/.exec(source)?.[0] ?? ''
  interface Built { name: string; at: number[]; size: number[]; normal: number[]; overlay: boolean; layer: number; canvas: number[]; transparent: boolean }
  // pit builds the faces on a group with a recording canvas, and runs a body against them
  function pit<T>(body: string, o: { essential?: boolean; testing?: boolean; master?: string; pushed?: boolean[] } = {}): T {
    if (!seats || !mark) throw new Error('the face seats not found in engine.ts')
    return new Function('o', 'THREE', 'faces', 'armament', 'countermeasures', `const LAYER_OWN=1, D2R=Math.PI/180, _v=new THREE.Vector3(), secured=o.pushed||[false,false];
      let sim_time=10, lamps_testing=!!o.testing, master=o.master||"nav", drawn=[], buses={ essential:o.essential??true };
      const arms=armament.fresh(true), suite=countermeasures.fresh(true);
      const document={ createElement:()=>({ width:0, height:0, getContext(){ const canvas=this; return new Proxy({}, { get:(t,k)=>k==="clearRect"?()=>drawn.push(canvas.width):()=>{}, set:()=>true }); } }) };
      const g=new THREE.Group(), ownship={ group:g }, _click_ray={ intersectObjects:(meshes)=>hit?[{ object:meshes[hit.face], uv:{ x:hit.u, y:hit.v } }]:[] }; let hit=null;
      ${seats} ${mark} ${lift('seat_pose')} ${line('faces_key')}
      ${lift('faces_shown')}
      ${lift('faces_update')}
      ${lift('face_target')}
      ${lift('build_faces')}
      build_faces(g); ${body}`)(o, THREE, faces, armament, countermeasures) as T
  }
  const round = (v: number[]) => v.map((n) => Math.round(n * 1e4) / 1e4 + 0)
  it('seats a face on each panel, a little proud of it, facing the pilot, at the size measured on the model', () => {
    const built = pit<Built[]>(`return Object.entries(g.userData.faces).map(([name,f])=>({ name, at:f.mesh.position.toArray(), size:[f.mesh.geometry.parameters.width,f.mesh.geometry.parameters.height],
      normal:new THREE.Vector3(0,0,1).applyQuaternion(f.mesh.quaternion).toArray(), overlay:f.mesh.userData.overlay, layer:f.mesh.layers.mask, canvas:[f.canvas.width,f.canvas.height], transparent:f.mesh.material.transparent }));`)
    expect(built.map((b) => b.name)).toEqual(['arm', 'emergency', 'stations', 'defence'])
    const by = Object.fromEntries(built.map((b) => [b.name, b]))
    expect(round(by.arm.at)).toEqual([6.165, 0.3475, -0.3445]); expect(by.arm.size).toEqual([0.051, 0.109]) // beside the left DDI, 2 mm aft of its panel
    expect(round(by.emergency.at)).toEqual([6.182, 0.255, -0.339]); expect(by.emergency.size).toEqual([0.034, 0.034])
    expect(round(by.stations.at)).toEqual([6.209, 0.075, -0.3505]); expect(by.stations.size).toEqual([0.04, 0.046])
    expect(by.defence.size).toEqual([0.109, 0.113])
    for (const name of ['arm', 'emergency', 'stations']) expect(round(by[name].normal), name).toEqual([-1, 0, 0])
    expect(round(by.defence.normal)).toEqual(round([-0.951, 0.309, 0.001].map((n) => n / Math.hypot(0.951, 0.309, 0.001)))) // the pedestal leans back
    for (const b of built) { expect(b.overlay, b.name).toBe(true); expect(b.layer, b.name).toBe(2); expect(b.canvas, b.name).toEqual([faces.FACES[b.name as faces.Name].width, faces.FACES[b.name as faces.Name].height]) }
    expect(built.map((b) => b.transparent)).toEqual([false, true, false, false]) // only the round button shows the panel round it
  })
  it('keeps each face\'s shape: its picture is as wide for its height as its seat', () => {
    for (const [name, size] of Object.entries({ arm: [0.051, 0.109], emergency: [0.034, 0.034], stations: [0.04, 0.046], defence: [0.109, 0.113] })) {
      const face = faces.FACES[name as faces.Name]
      expect(face.width / face.height, name).toBeCloseTo(size[0] / size[1], 1)
    }
  })
  it('is built with the cockpit, once', () => {
    expect(source).toMatch(/build_ifei\(g\); build_ufc\(g\); build_faces\(g\); \}/)
    expect(pit('const before=g.children.length; build_faces(g); return g.children.length-before;')).toBe(0)
  })
  it('shows the panels\' own state: the switches, the A/A mode, the extinguisher\'s lights, the stations pressed, the RWR\'s lights', () => {
    expect(pit('arms.stations=[5]; suite.receiver.limit=true; return faces_shown();', { master: '9m', pushed: [true, false] })).toEqual({
      power: true, test: false, arm: true, air: true, ready: true, discharged: false, stations: [5], dispenser: 'on', jammer: 'receive',
      indicator: { power: true, limit: true, offset: false, special: false, fail: false } })
    expect(pit('arms.discharged=true; return faces_shown();', { essential: false, testing: true })).toMatchObject({ power: false, test: true, air: false, ready: false, discharged: true })
  })
  it('redraws every face when what they show changes, and not otherwise', () => {
    expect(pit<number[]>('const a=drawn.length; faces_update(); const b=drawn.length; arms.arm=false; faces_update(); const c=drawn.length; faces_update(); return [a,b,c,drawn.length];')).toEqual([4, 4, 8, 8])
    expect(pit<number[]>('drawn=[]; suite.jammer="transmit"; faces_update(); return drawn;')).toEqual([204, 136, 160, 436]) // each face's own canvas
  })
  it('is redrawn each frame with the lamps', () => {
    expect(source).toMatch(/\n\tfaces_update\(\); {3}\/\/ the faces' lights and switches/)
  })
  it('moves the SELECT JETT knob\'s mark to the position selected, round the knob as FO-5 draws them', () => {
    const at = (select: string) => pit<number[]>(`arms.select=${JSON.stringify(select)}; faces_update(); return g.userData.jettison.position.toArray();`)
    const centre = [6.204, 0.017, -0.284], right = [0.125, -0.594, 0.794], up = [0.391, 0.765, 0.511]
    for (const [select, degrees] of Object.entries({ left: -50, safe: 0, right: 50, rack: 88, stores: 130 })) {
      const a = (degrees * Math.PI) / 180
      expect(round(at(select)), select).toEqual(round(centre.map((c, k) => c + 0.027 * (Math.sin(a) * right[k] + Math.cos(a) * up[k]))))
    }
    expect(at('safe')[1]).toBeGreaterThan(at('stores')[1]) // SAFE at the top, STORES round past the right
  })
  it('sends a click on a face to the control under it, the picture\'s top at the face\'s top', () => {
    expect(pit('hit={ face:0, u:124/204, v:1-320/436 }; return face_target();')).toMatchObject({ action: 'arm' })
    expect(pit('hit={ face:0, u:149/204, v:1-57/436 }; return face_target();')).toMatchObject({ action: 'extinguisher' })
    expect(pit('hit={ face:3, u:346/436, v:1-290/452 }; return face_target();')).toMatchObject({ action: 'jammer' })
    expect(pit('hit={ face:2, u:40/160, v:1-30/184 }; return face_target();')).toMatchObject({ action: 'jettison.station.5' })
  })
  it('sends nothing for a click on a face off its controls, or off every face', () => {
    expect(pit('hit={ face:0, u:0.05, v:0.95 }; return face_target();')).toBeNull()
    expect(pit('return face_target();')).toBeNull()
  })
  it('is asked before the model\'s own switches and the click spots', () => {
    expect(source).toMatch(/function pit_target\(e\)\{ const list=ownship\.group\.userData\.switches\|\|\[\];\n\t\{ const on=face_target\(\); if\(on\) return on; \}/)
  })
})
