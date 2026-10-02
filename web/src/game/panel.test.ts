// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'

// The cockpit's panel systems against NATOPS: the electrical power panel and
// what the cockpit loses without generator power (2.5, 15.17), the display and
// lights knobs (2.6.2, 2.13.4), the ECS's BLEED AIR knob, the cockpit's pressure
// and the fire and bleed air test (2.14.5, 2.16), RUD TRIM and T/O TRIM (2.8.2.2),
// EXT TANKS and INTR WING (2.2), the emergency gear extension (2.10.1.6), the
// clock's elapsed time, the travel-only controls and the spin recovery display
// (2.8.2.6.2). engine.ts cannot be imported (WebGL at module scope), so the
// panel systems block and pit_press are lifted as text and run against
// stand-ins for the engine's state.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
function lift(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`${name} not found in engine.ts`)
  const rest = source.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  return end ? rest.slice(0, end.index + 1) : rest
}
const block = /\n\/\/ =+ panel systems \(G1\)\n[\s\S]*?\nfunction travel_press\([^\n]*\n/.exec(source)?.[0] ?? ''
const tables = [/\nconst TRAVEL=\{[^\n]*\n[^\n]*\n/, /\nconst TRAVEL_REST=[^\n]*\n/, /\nconst FUEL_TANKS=[^\n]*\n/, /\nconst lighting=\{[^\n]*\n/]
  .map((re) => re.exec(source)?.[0] ?? '').join('')
const press = /\nfunction pit_press\(action,direction\)\{ const d=[\s\S]*?\n\t\} \}\n/.exec(source)?.[0] ?? ''
const rig = /rig:\[[\s\S]*?\{ name:"flaplever"[^\n]*\n/.exec(source)?.[0] ?? ''

// out: the core's words the harness lays out - both engines' spool and harm,
// the altitude, the spin display's direction and the recovery latch, the
// calibrated airspeed and the alpha.
const STATE = { engine: 0, engine_harm: 4, position: 6, spin: 9, recovery: 10, cas: 11, alpha: 12 }
function words(o: { spoolL?: number; spoolR?: number; metres?: number; spin?: number; recovery?: number; cas?: number; alpha?: number } = {}): number[] {
  const out = new Array(16).fill(0)
  out[0] = o.spoolL ?? 0.8; out[2] = o.spoolR ?? 0.8; out[STATE.position + 1] = o.metres ?? 0
  out[STATE.spin] = o.spin ?? 0; out[STATE.recovery] = o.recovery ?? 0; out[STATE.cas] = o.cas ?? 0; out[STATE.alpha] = o.alpha ?? 0
  return out
}
const running = words(), stopped = words({ spoolL: 0, spoolR: 0 })

// deno-lint-ignore no-explicit-any
type System = any
function system(o: { tod?: string; grounded?: boolean; parking?: boolean } = {}): System {
  for (const [name, text] of [['panel systems block', block], ['tables', tables], ['pit_press', press]]) if (!text) throw new Error(name + ' not found in engine.ts')
  return new Function('THREE', 'STATE', 'o', `let sim_time=0, reset_flag=false, brake_accumulator=3000, unpowered=false, lamps_testing=false, sari_clicked=-Infinity, radalt_on=true, radalt_test=-Infinity;
    const cfg={ tod:o.tod||"day" }, ownship={ grounded:o.grounded??false, gearTarget:1 }, RADAR={ unpowered:false }, ACCUMULATOR={ full:3000, empty:1750, gas:80000 };
    const on_ground=()=>ownship.grounded, parking=o.parking??true, set_master=()=>{}, notice=()=>{}, translate=(t)=>t, buttons={ trim:-Infinity, reset:-Infinity, standing:false, jams:0 }, fcs_jams=(w)=>w.jams||0; let last_out=null;
    ${tables} ${block} ${lift('generators')} ${lift('lighting_set')} ${press}
    return { press:pit_press, step(t,out){ sim_time=t; power_step(out); }, at(t){ sim_time=t; }, generators, knob_level, knob_turn, display_level, display_press, symbology,
      battery_switch, battery_volts, volt_angle, bleed_open, bleed_turn, pressurized, cabin_altitude, cabin_step, fire_testing, wing_step, clock_elapsed, travel_at, lighting_set,
      ownship, knobs, displays, electrics, ecs, transfer, thrown, fire_test, lighting, RADAR, TRAVEL,
      get buses(){ return buses; }, set buses(v){ buses=v; }, get reset(){ return reset_flag; }, get accumulator(){ return brake_accumulator; }, get rudder(){ return rudder_trim; },
      get reference(){ return reference; }, get emergency(){ return gear_emergency; }, get inhibit(){ return wing_inhibit; }, get held(){ return wing_held; }, set inhibit(v){ wing_inhibit=v; },
      get cabin(){ return cabin_feet; }, set unpowered(v){ unpowered=v; }, get sari(){ return sari_clicked; }, get radalt(){ return radalt_test; },
      buttons, set out(v){ last_out=v; } };`)(THREE, STATE, o)
}

describe('the electrical power panel (#21, #116)', () => {
  it('powers every bus from either generator, each GEN switch taking its own off the line', () => {
    const s = system()
    s.step(0, running)
    expect(s.buses).toEqual({ ac: true, essential: true, left: true, right: true })
    s.press('generator.left', 1); s.step(1, running)
    expect(s.generators(running)).toEqual([false, true])
    expect(s.buses.ac).toBe(true)
    s.press('generator.right', -1); s.step(2, running)
    expect(s.buses).toEqual({ ac: false, essential: true, left: false, right: false }) // on the batteries
    expect(s.RADAR.unpowered).toBe(true)
    s.press('generator.left', 0); s.step(3, running)
    expect(s.buses).toEqual({ ac: true, essential: true, left: true, right: true })
    expect(s.RADAR.unpowered).toBe(false)
    s.press('generator.right', 0)
    expect(s.generators(words({ spoolL: 0 }))).toEqual([false, true]) // a stopped engine takes its generator with it
  })

  // The bus tie (2.5.1.1, 2.5.1.3, FO-8): tied, either generator feeds both 115 volt ac buses; a ground start with the
  // parking brake released opens it, each bus is then its own generator's, and the GEN TIE CONTROL switch closes it.
  it('feeds both ac buses from one generator through the bus tie', () => {
    const s = system()
    s.step(0, words({ spoolL: 0 }))
    expect(s.electrics.tie).toBe(true)
    expect(s.buses).toMatchObject({ ac: true, left: true, right: true })
  })
  it('opens the bus tie on a ground start with the parking brake released, and leaves a dead generator\'s bus dead', () => {
    const s = system({ grounded: true, parking: false })
    s.step(0, running); s.step(1, stopped); s.step(2, words({ spoolL: 0 }))
    expect(s.electrics.tie).toBe(false)
    expect(s.buses).toMatchObject({ ac: true, left: false, right: true })
    s.step(3, running)
    expect(s.buses).toMatchObject({ left: true, right: true }) // each on its own generator
    expect(s.electrics.tie).toBe(false) // and the tie stays open until it is reset
  })
  it('keeps the bus tie closed for a start with the parking brake set, or in the air', () => {
    const set = system({ grounded: true, parking: true })
    set.step(0, running); set.step(1, stopped); set.step(2, words({ spoolL: 0 }))
    expect(set.electrics.tie).toBe(true)
    const air = system({ grounded: false, parking: false })
    air.step(0, running); air.step(1, stopped); air.step(2, words({ spoolL: 0 }))
    expect(air.electrics.tie).toBe(true)
  })
  it('does not take a spawn\'s engines, which need a moment to read as turning, for an engine start', () => {
    const s = system({ grounded: true, parking: false })
    s.step(0, stopped); s.step(5, running)
    expect(s.electrics.tie).toBe(true)
    expect(s.buses).toMatchObject({ ac: true, left: true, right: true })
  })
  it('closes the bus tie again with the GEN TIE CONTROL switch cycled', () => {
    const s = system({ grounded: true, parking: false })
    s.step(0, running); s.step(1, stopped); s.step(2, words({ spoolL: 0 })); const open = s.electrics.tie; s.press('generator.tie', 0); s.step(3, words({ spoolL: 0 }))
    expect([open, s.electrics.tie]).toEqual([false, true])
    expect(s.buses).toMatchObject({ left: true, right: true })
  })

  it('carries the essential bus on the U battery, then the E, for about 20 minutes, and recharges them', () => {
    const s = system()
    for (let t = 0; t <= 300; t++) s.step(t, stopped)
    expect(s.electrics.charge.u).toBeCloseTo(0.5, 2)
    expect(s.electrics.charge.e).toBe(1)
    for (let t = 301; t <= 900; t++) s.step(t, stopped)
    expect(s.electrics.charge.u).toBe(0)
    expect(s.electrics.charge.e).toBeCloseTo(0.5, 2)
    for (let t = 901; t <= 1190; t++) s.step(t, stopped)
    expect(s.buses.essential).toBe(true)
    for (let t = 1191; t <= 1210; t++) s.step(t, stopped)
    expect(s.buses.essential).toBe(false)
    for (let t = 1211; t <= 1310; t++) s.step(t, running)
    expect(s.electrics.charge.u).toBeCloseTo(100 / 600, 2)
  })

  it('takes the E battery alone at ORIDE', () => {
    const s = system()
    s.press('battery', -1); s.press('battery', -1)
    expect(s.electrics.battery).toBe('oride')
    for (let t = 0; t <= 300; t++) s.step(t, stopped)
    expect([s.electrics.charge.u, s.electrics.charge.e]).toEqual([1, expect.closeTo(0.5, 2)])
  })

  it('cuts the batteries off at ON five minutes after a loss of ac power that began on the wheels, but not at ORIDE or from a loss in the air', () => {
    const ground = system({ grounded: true })
    for (let t = 0; t <= 299; t++) ground.step(t, stopped)
    expect(ground.buses.essential).toBe(true)
    ground.ownship.grounded = false // a catapult shot after it changes nothing
    for (let t = 300; t <= 302; t++) ground.step(t, stopped)
    expect(ground.buses.essential).toBe(false)
    ground.press('battery', -1); ground.press('battery', 1) // OFF and back to ON: five more minutes
    for (let t = 303; t <= 600; t++) ground.step(t, stopped)
    expect(ground.buses.essential).toBe(true)
    for (let t = 601; t <= 605; t++) ground.step(t, stopped)
    expect(ground.buses.essential).toBe(false)
    const oride = system({ grounded: true })
    oride.press('battery', -1); oride.press('battery', -1)
    for (let t = 0; t <= 400; t++) oride.step(t, stopped)
    expect(oride.buses.essential).toBe(true)
    const air = system()
    for (let t = 0; t <= 400; t++) air.step(t, stopped)
    expect(air.buses.essential).toBe(true)
  })

  it('reverts to MECH ON 8 s after the essential bus dies, and holds it with the power back until FCS RESET', () => {
    const s = system()
    s.press('battery', -1) // OFF
    for (let t = 0; t <= 7; t++) s.step(t, stopped)
    expect(s.electrics.mech).toBe(false)
    s.step(8, stopped)
    expect(s.electrics.mech).toBe(true)
    s.press('fcs.reset', 1) // no power, no reset
    expect(s.electrics.mech).toBe(true)
    s.step(9, running)
    expect(s.electrics.mech).toBe(true)
    s.press('fcs.reset', 1)
    expect(s.electrics.mech).toBe(false)
  })

  it('raises BATT SW on the ground with the batteries draining, and in the air with the switch out of ON or the batteries on the bus (2.5.3.3)', () => {
    const at = (grounded: boolean, ac: boolean, battery: string) => {
      const s = system({ grounded }); s.electrics.battery = battery; s.buses = { ac, essential: ac || battery !== 'off' }; return s.battery_switch()
    }
    expect([at(true, true, 'on'), at(true, false, 'on'), at(true, false, 'oride'), at(true, false, 'off')]).toEqual([false, true, true, false])
    expect([at(false, true, 'on'), at(false, true, 'oride'), at(false, true, 'off'), at(false, false, 'on')]).toEqual([false, true, true, true])
  })

  it('reads the E/U BATT voltmeter: 16 V at OFF, E alone at ORIDE, 24 V charged, 20.5 V spent and 28 V on a generator (2.5.3.2)', () => {
    const s = system()
    s.buses = { ac: false, essential: true }
    expect([s.battery_volts('e'), s.battery_volts('u')]).toEqual([24, 24])
    s.electrics.charge.u = 0
    expect(s.battery_volts('u')).toBe(20.5)
    s.electrics.battery = 'oride'
    expect([s.battery_volts('e'), s.battery_volts('u')]).toEqual([24, 16])
    s.electrics.battery = 'off'
    expect([s.battery_volts('e'), s.battery_volts('u')]).toEqual([16, 16])
    s.electrics.battery = 'on'; s.buses = { ac: true, essential: true }
    expect(s.battery_volts('e')).toBe(28)
    // the needle: equal divisions of 1 V to 20 V and 2 V above, 24 and 28 V where the gauge had them
    expect(s.volt_angle(28)).toBeCloseTo(1.86, 6)
    expect(s.volt_angle(24)).toBeCloseTo(1.55, 6)
    expect(s.volt_angle(18) - s.volt_angle(16)).toBeCloseTo(s.volt_angle(24) - s.volt_angle(20), 6)
    expect(source).toMatch(/voltsE:volt_angle\(battery_volts\("e"\)\), voltsU:volt_angle\(battery_volts\("u"\)\),/)
    expect(rig).toMatch(/name:"voltE",[^\n]*gauge:"voltsE" \}/)
    expect(rig).toMatch(/name:"voltU",[^\n]*gauge:"voltsU" \}/)
  })

  it('darks the displays and the HUD, silences the radar and keeps the lights on the battery; the essential bus takes the rest', () => {
    expect(source).toMatch(/function lamp_set\(m,on\)\{ if\(!m\) return; on=\(!!on\|\|lamps_testing\)&&buses\.essential;/)
    expect(source).toMatch(/l\.transit\.material\.opacity=!buses\.essential\?0:wheels_warning\(\)/)
    expect(source).toMatch(/if\(e\) e\.intensity=\(unpowered&&buses\.essential&&cfg\.view==="cockpit"\)\?EMERGENCY_LIGHT:0;/)
    expect(source).toMatch(/const sym=symbology\(\);[^\n]*\n\tconst flight_symbols=sym>0&&\(/)
    expect(source).toMatch(/adi_face\(faces\.adi,[^\n]*sari_testing\(\),!buses\.essential\);/)
    expect(source).toMatch(/power_step\(out\); displays_light\(\); wing_step\(lbs,step\); cabin_step\(out,step\); spin_step\(out\);/)
    const radar = readFileSync(fileURLToPath(new URL('./radar.ts', import.meta.url)), 'utf8')
    expect(radar).toMatch(/return this\.sil \|\| this\.emcon \|\| this\.unpowered/)
  })
})

describe('the display and lights knobs (#11, #23, #115)', () => {
  it('leave the pre-flight\'s levels until turned, a fifth of the throw a click, clockwise brighter', () => {
    const day = system(), night = system({ tod: 'night' })
    expect(['instrument', 'consoles', 'flood', 'warn', 'symbology'].map((k) => day.knob_level(k))).toEqual([0.22, 0, 0, 1, 1])
    expect(['instrument', 'consoles', 'flood', 'warn'].map((k) => night.knob_level(k))).toEqual([0.62, 1, 1, 0.7])
    day.press('knob.instrument', 1)
    expect(day.knob_level('instrument')).toBeCloseTo(0.42, 6)
    day.press('knob.instrument', -1); day.press('knob.instrument', -1); day.press('knob.instrument', -1)
    expect(day.knob_level('instrument')).toBe(0)
    for (let i = 0; i < 8; i++) day.press('knob.consoles', 1)
    expect(day.knob_level('consoles')).toBe(1)
  })

  it('set the interior lights from INST PNL, CONSOLES, FLOOD and WARN/CAUT, the lenses in NITE\'s low range only', () => {
    const s = system({ tod: 'night' })
    s.press('knob.flood', -1); s.press('knob.warn', -1); s.lighting_set()
    expect([s.lighting.flood, s.lighting.warn]).toEqual([0.8, expect.closeTo(0.45, 6)]) // WARN/CAUT from 0.7 to 0.5 of the low range
    s.unpowered = true; s.lighting_set()
    expect([s.lighting.instrument, s.lighting.consoles, s.lighting.flood]).toEqual([0, 0, 0])
    const day = system(); day.press('knob.warn', -1); day.lighting_set()
    expect(day.lighting.warn).toBe(1)
  })

  it('take each DDI off with its own side\'s ac bus, the AMPCD staying on either (FO-8)', () => {
    const s = system({ grounded: true, parking: false })
    s.step(0, running); s.step(1, stopped); s.step(2, words({ spoolL: 0 })) // a ground start that opened the bus tie, the left generator not turning
    expect(['left', 'right', 'center'].map((d) => s.display_level(d))).toEqual([0, 1, 1])
    s.step(3, words({ spoolR: 0 }))
    expect(['left', 'right', 'center'].map((d) => s.display_level(d))).toEqual([1, 0, 1])
  })

  it('light each DDI from its selector and BRT knob, the AMPCD from its OFF/BRT knob and NGT/DAY rocker, none without ac power', () => {
    const s = system()
    expect(['left', 'right', 'center'].map((d) => s.display_level(d))).toEqual([1, 1, 1])
    s.press('display.left.mode', -1)
    expect(s.displays.left.mode).toBe('night')
    expect(s.display_level('left')).toBeCloseTo(0.45, 6)
    s.press('display.left.mode', -1)
    expect(s.display_level('left')).toBe(0) // OFF
    s.press('display.left.mode', 1); s.press('display.left.mode', 1); s.press('display.left.mode', 1); s.press('display.left.mode', 1)
    expect(s.displays.left.mode).toBe('day')
    for (let i = 0; i < 6; i++) s.press('display.right.brt', -1)
    expect(s.display_level('right')).toBeCloseTo(0.3, 6) // a DDI's BRT is no off switch
    for (let i = 0; i < 6; i++) s.press('display.center.brt', -1)
    expect(s.display_level('center')).toBe(0) // the AMPCD's is
    s.press('display.center.brt', 1); s.press('display.center.mode', -1)
    expect(s.displays.center.mode).toBe('night')
    expect(s.display_level('center')).toBeCloseTo(0.45 * (0.3 + 0.7 * 0.2), 6)
    s.buses = { ac: false, essential: true }
    expect(['left', 'right', 'center'].map((d) => s.display_level(d))).toEqual([0, 0, 0])
  })

  it('dim the HUD from SYM BRT, off at its stop and without ac power', () => {
    const s = system()
    expect(s.symbology()).toBe(1)
    for (let i = 0; i < 5; i++) s.press('knob.symbology', -1)
    expect(s.symbology()).toBe(0)
    s.press('knob.symbology', 1); s.buses = { ac: false, essential: true }
    expect(s.symbology()).toBe(0)
    expect(source.match(/hctx\.globalAlpha=sym;/g)?.length).toBe(3) // the velocity vector's block, the A/A symbology and the cluster
  })

  it('dim the AoA indexer from its knob, dark without ac power (2.13.4.8.7)', () => {
    expect(source).toMatch(/const glow=buses\.ac\?knob_level\("indexer"\):0;/)
    expect(source).toMatch(/ind\.slow\.opacity = lit&&alpha>=8\.8\?glow:0;/)
  })

  it('dark the azimuth indicator without ac power', () => {
    expect(source).toMatch(/if\(u\.rwr\) u\.rwr\.mesh\.material\.color\.setScalar\(buses\.ac&&suite\.receiver\.power\?1:0\);/) // and with the control indicator's POWER off (#9)
  })

  it('light the UFC and the IFEI from their BRT knobs, the IFEI\'s under NITE only', () => {
    expect(source).toMatch(/if\(u\.ufc\) u\.ufc\.mesh\.material\.color\.setScalar\(buses\.ac\?0\.3\+0\.7\*knob_level\("ufc"\):0\);/)
    expect(source).toMatch(/if\(u\.ifei\) u\.ifei\.mesh\.material\.color\.setScalar\(buses\.ac\?\(lighting\.mode==="nite"\?0\.3\+0\.7\*knob_level\("ifei"\):1\):0\);/)
  })
})

describe('the ECS and the fire and bleed air test (#14, #17, #22)', () => {
  it('opens each primary bleed valve with the BLEED AIR knob, L OFF, NORM, R OFF and OFF clockwise, and neither without ac power', () => {
    const s = system()
    const open = () => [s.bleed_open(0), s.bleed_open(1)]
    expect(open()).toEqual([true, true])
    s.press('bleed', -1); expect(open()).toEqual([false, true]) // L OFF
    s.press('bleed', 1); s.press('bleed', 1); expect(open()).toEqual([true, false]) // R OFF
    s.press('bleed', 1); expect(open()).toEqual([false, false]) // OFF
    s.press('bleed', 1); expect(s.ecs.bleed).toBe(3) // its stop
    s.ecs.bleed = 1; s.buses = { ac: false, essential: true }
    expect(open()).toEqual([false, false])
  })

  it('tests the loops four seconds, closing both valves, which reopen only through OFF to NORM with ac power (2.14.5)', () => {
    const s = system()
    s.at(10); s.press('fire.test', 1)
    expect([s.fire_testing(), s.fire_test.loop, s.ecs.valves]).toEqual([true, 1, [false, false]])
    s.at(13.9); expect(s.fire_testing()).toBe(true)
    s.at(14); expect(s.fire_testing()).toBe(false)
    s.press('bleed', 1); s.press('bleed', -1) // R OFF and back: not through OFF
    expect(s.ecs.valves).toEqual([false, false])
    s.buses = { ac: false, essential: true }
    s.press('bleed', 1); s.press('bleed', 1); s.press('bleed', -1); s.press('bleed', -1) // through OFF without ac power
    expect(s.ecs.valves).toEqual([false, false])
    s.buses = { ac: true, essential: true }
    s.press('bleed', 1); s.press('bleed', 1); s.press('bleed', -1); s.press('bleed', -1)
    expect(s.ecs.valves).toEqual([true, true])
    const dead = system(); dead.buses = { ac: false, essential: false }
    dead.press('fire.test', -1)
    expect(dead.ecs.valves).toEqual([true, true]) // no power, no test
  })

  it('pressurises the cockpit on figure 2-37\'s schedule with bleed air from a turning engine, and holds it at the aircraft\'s altitude without', () => {
    const s = system()
    expect([0, 11000, 20000, 24000, 32000, 40000].map((f) => s.cabin_altitude(f, true))).toEqual([-2300, 8000, 8000, 8000, 11900, 15800])
    expect(s.cabin_altitude(5000, true)).toBeCloseTo(-2300 + 5000 * 10300 / 11000, 6)
    expect(s.cabin_altitude(30000, false)).toBe(30000)
    expect(s.pressurized(running)).toBe(true)
    expect(s.pressurized(stopped)).toBe(false)
    s.press('bleed', -1) // L OFF
    expect(s.pressurized(words({ spoolR: 0 }))).toBe(false) // the left valve shut, the right engine stopped
    expect(s.pressurized(words({ spoolL: 0 }))).toBe(true)
  })

  it('moves the cockpit\'s altitude toward the schedule at 5,000 ft a minute', () => {
    const s = system()
    const high = words({ metres: 30000 / 3.281 })
    s.cabin_step(high, 0)
    expect(s.cabin).toBeCloseTo(s.cabin_altitude(30000, true), 6)
    s.press('bleed', -1); s.press('bleed', 1); s.press('bleed', 1); s.press('bleed', 1) // OFF: no bleed air
    s.cabin_step(high, 60)
    expect(s.cabin).toBeCloseTo(s.cabin_altitude(30000, true) + 5000, 6)
  })

  it('draws the cockpit altimeter 0 at the bottom, 30 at the top, 6° a thousand clockwise to 50 (FO-5 item 39)', () => {
    const needle = (feet: number) => {
      const lines: number[][] = []; let at = [0, 0]
      const x = new Proxy({}, { get: (_t, k) => k === 'moveTo' ? (a: number, b: number) => { at = [a, b] } : k === 'lineTo' ? (a: number, b: number) => lines.push([...at, a, b]) : () => {}, set: () => true })
      new Function('THREE', 'x', 'feet', `const D2R=Math.PI/180; ${lift('cabin_draw')} cabin_draw({ canvas:{ getContext:()=>x }, tex:{} },feet);`)(THREE, x, feet)
      const l = lines[lines.length - 1]; return [Math.round(l[2]), Math.round(l[3])]
    }
    expect(needle(0)).toEqual([80, 150])
    expect(needle(30000)).toEqual([80, 10])
    expect(needle(15000)).toEqual([10, 80])
    expect(needle(90000)).toEqual(needle(50000))
  })

  it('shows the fire test on the FIRE and BLEED lights, the BLD OFF cautions and the fire voices', () => {
    expect(source).toMatch(/lamp_set\(l\.fireL,own_burn\[0\]>0\|\|own_burning\|\|loop\); lamp_set\(l\.fireR,own_burn\[1\]>0\|\|own_burning\|\|loop\); lamp_set\(l\.apufire,loop\); lamp_set\(l\.bleedL,loop\); lamp_set\(l\.bleedR,loop\);/)
    expect(source).toMatch(/if\(fire_testing\(\)\)\{ active\.add\("ENGINE FIRE LEFT"\); active\.add\("ENGINE FIRE RIGHT"\); \}/)
  })
})

// The caption lines cautions_update adds for the panel systems, run against stand-ins.
function captions(c: { batt?: boolean; left?: boolean; right?: boolean; mech?: boolean; seat?: boolean }): string[] {
  const lines = /\n\tif\(battery_switch\(\)\) captions\.push\("BATT SW"\);[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n/.exec(source)?.[0] ?? ''
  if (!lines) throw new Error('panel captions not found in engine.ts')
  return new Function('c', `const captions=[], battery_switch=()=>!!c.batt, check_seat=()=>!!c.seat, bleed_open=(side)=>side===0?!c.left:!c.right, electrics={ mech:!!c.mech }; ${lines} return captions;`)(c) as string[]
}
// check_seat: CK SEAT's condition (2.15.3.5.1, #112) - the right throttle at MIL or above,
// weight on the wheels and the seat not armed.
function seat(c: { armed?: boolean; grounded?: boolean; throttle?: number; secured?: boolean }): boolean {
  return new Function('c', `let seat_armed=c.armed??true; const ownship={ grounded:c.grounded??true, throttle:c.throttle??1 }, secured=[false,!!c.secured];
    ${lift('check_seat')}
    return check_seat();`)(c) as boolean
}
describe('the panel systems\' cautions', () => {
  it('raise BATT SW, L BLD OFF, R BLD OFF and MECH ON on their conditions (2.5.3.3, 2.16.1.3, 2.8.2.10)', () => {
    expect(captions({})).toEqual([])
    expect(captions({ batt: true, left: true, right: true, mech: true })).toEqual(['BATT SW', 'L BLD OFF', 'R BLD OFF', 'MECH ON'])
    expect(captions({ right: true })).toEqual(['R BLD OFF'])
    expect(captions({ seat: true })).toEqual(['CHECK SEAT'])
  })

  it('raises CHECK SEAT with the seat safe on the wheels at MIL, and not armed, airborne, below MIL or with the right engine secured', () => {
    expect(seat({ armed: false })).toBe(true)
    expect(seat({ armed: true })).toBe(false)
    expect(seat({ armed: false, grounded: false })).toBe(false)
    expect(seat({ armed: false, throttle: 0.9 })).toBe(false)
    expect(seat({ armed: false, secured: true })).toBe(false)
  })
})

describe('the FCS panel (#19)', () => {
  it('trims the rudder a quarter of the way to a stop a click, and T/O TRIM centres it and re-datums the trim on the wheels only', () => {
    const s = system()
    s.press('rudder.trim', 1); s.press('rudder.trim', 1)
    expect(s.rudder).toBe(0.5)
    for (let i = 0; i < 6; i++) s.press('rudder.trim', 1)
    expect(s.rudder).toBe(1)
    s.press('trim.takeoff', 0)
    expect([s.rudder, s.reset]).toEqual([1, false]) // airborne: nothing
    s.ownship.grounded = true; s.press('trim.takeoff', 0)
    expect([s.rudder, s.reset]).toEqual([0, true])
    expect(source).toMatch(/hotas\.pedals=Math\.abs\(py\)>Math\.abs\(key_axes\.yaw\)\?py:key_axes\.yaw;\n\tinput\.yaw=THREE\.MathUtils\.clamp\(hotas\.pedals\+rudder_trim\*RUDDER_TRIM,-1,1\);/)
  })

  it('times the T/O TRIM and FCS RESET presses for their advisories, and notes the failures a reset leaves standing', () => {
    const s = system()
    s.at(40); s.press('trim.takeoff', 0)
    expect(s.buttons.trim).toBe(-Infinity) // airborne: the button trims nothing, and advises nothing
    s.ownship.grounded = true; s.at(41); s.press('trim.takeoff', 0)
    expect(s.buttons.trim).toBe(41)
    s.step(42, running); s.at(50); s.press('fcs.reset', 1)
    expect([s.buttons.reset, s.buttons.jams, s.buttons.standing]).toEqual([50, 0, false]) // nothing failed: a clean reset
    s.out = { jams: 2 }; s.at(60); s.press('fcs.reset', 1)
    expect([s.buttons.reset, s.buttons.jams, s.buttons.standing]).toEqual([60, 2, true]) // two channels still failed: the caution comes off for those two
    s.buses = { ac: false, essential: false }; s.at(70); s.press('fcs.reset', 1)
    expect(s.buttons.reset).toBe(60) // no power, no reset
  })

  it('crosses PROC 1 and 3 with the ATT switch at STBY, up toward INS', () => {
    const s = system()
    expect(s.reference).toBe('auto')
    s.press('attitude', 1); expect(s.reference).toBe('ins')
    s.press('attitude', -1); s.press('attitude', -1); s.press('attitude', -1); expect(s.reference).toBe('stby')
  })
})

describe('the fuel panel (#18)', () => {
  it('steps each EXT TANKS switch STOP, NORM, ORIDE, up toward ORIDE, and sends both to the core', () => {
    const s = system()
    s.press('transfer.wing', 1); s.press('transfer.wing', 1)
    s.press('transfer.centre', -1); s.press('transfer.centre', -1)
    expect(s.transfer).toEqual({ wing: 1, centre: -1 })
    expect(source).toMatch(/emergency:gear_emergency, mechanical:mechanical\(\), transfer:\[transfer\.wing,transfer\.centre\],/)
    expect(source).toMatch(/emergency:gear_emergency, mechanical:mechanical\(\), wing:transfer\.wing, centre:transfer\.centre,/)
  })

  it('holds the wings\' fuel under INTR WING\'s INHIBIT and gives it back at NORM at the transfer rate', () => {
    const s = system()
    s.press('wing.inhibit', 0)
    expect(s.inhibit).toBe(true)
    s.wing_step(10810, 1)
    expect(s.held).toBe(1160)
    s.wing_step(9000, 1)
    expect(s.held).toBe(1160) // the fuselage tanks gave the 1,810 lb
    s.press('wing.inhibit', 0)
    s.wing_step(9000, 10)
    expect(s.held).toBe(1160 - 150)
    s.wing_step(9000, 100)
    expect(s.held).toBeNull() // back to NORM's order: at 9,000 lb the wings are empty
  })
})

describe('the emergency gear extension (#128)', () => {
  it('turns and pulls the handle once, drawing one application from the brake accumulator, and locks it where it is', () => {
    const s = system()
    s.press('gear.emergency', 0)
    expect(s.emergency).toBe(true)
    expect(s.accumulator).toBeCloseTo(3000 / (1 + 3000 / 80000), 6)
    s.press('gear.emergency', 0)
    expect(s.accumulator).toBeCloseTo(3000 / (1 + 3000 / 80000), 6)
    s.press('gear', -1)
    expect(s.ownship.gearTarget).toBe(1) // the handle is locked out, UP where it was
  })

  it('reaches it by a middle click on the handle or an unbound key, both in the key settings', () => {
    expect(source).toMatch(/const s=pit_target\(e\); if\(s&&s\.name==="ruddertrim"\) pit_press\("trim\.takeoff",0\); else if\(s&&s\.name==="gearlever"\) pit_press\("gear\.emergency",0\);/)
    expect(source).toMatch(/if\(ch===key_of\("gear\.emergency"\)&&!playback\) pit_press\("gear\.emergency",0\);/)
    expect(source).toMatch(/if\(action==="view"\|\|action==="trim\.reset"\|\|action==="gear\.emergency"\)/)
    const keys = readFileSync(fileURLToPath(new URL('./keys.ts', import.meta.url)), 'utf8')
    expect(keys).toMatch(/'gear\.emergency': 'None',/)
    const dialog = readFileSync(fileURLToPath(new URL('../components/SettingsDialog.tsx', import.meta.url)), 'utf8')
    expect(dialog.match(/\{ id: 'gear\.emergency', label: msg`Emergency gear extension`, group: 'aircraft' \},/g)?.length).toBe(2)
  })

  it('draws the handle turned 90° clockwise about its shaft and then pulled 1.5 in', () => {
    const lines = /\n\tif\(st===ownship&&g\.userData\.handle&&g\.userData\.handle\.length\)\{[\s\S]*?HANDLE\.pull\); \} \}\n/.exec(source)?.[0] ?? ''
    const consts = /\nconst HANDLE=\{[^\n]*\nconst HANDLE_TURN=[^\n]*\n/.exec(source)?.[0] ?? ''
    expect(lines).not.toBe('')
    const pose = (pulled: boolean, seconds: number) => new Function('THREE', 'pulled', 'seconds', `${consts} let emergency_travel=0; const gear_emergency=pulled, ownship={}, st=ownship;
      const lever=new THREE.Object3D(), g={ userData:{ handle:[lever] } };
      for(let t=0;t<seconds;t+=0.05){ const dt=0.05; ${lines} }
      return { travel:emergency_travel, q:lever.quaternion.toArray(), p:lever.position.toArray(), axis:HANDLE.axis.toArray(), centre:HANDLE.centre.toArray() };`)(THREE, pulled, seconds)
    const out = pose(true, 1)
    expect(out.travel).toBe(1)
    const q = new THREE.Quaternion().fromArray(out.q), axis = new THREE.Vector3().fromArray(out.axis)
    expect(q.angleTo(new THREE.Quaternion())).toBeCloseTo(Math.PI / 2, 6)
    expect(new THREE.Vector3(q.x, q.y, q.z).normalize().dot(axis)).toBeCloseTo(-1, 6) // clockwise seen from the grip end
    const along = (o: { q: number[]; p: number[]; centre: number[] }) => {   // how far the grip has come out along its shaft
      const turn = new THREE.Quaternion().fromArray(o.q), centre = new THREE.Vector3().fromArray(o.centre)
      return new THREE.Vector3().fromArray(o.p).add(centre.clone().applyQuaternion(turn)).sub(centre).dot(axis)
    }
    expect(along(out)).toBeCloseTo(0.038, 6) // the shaft stays put and the grip comes out along it
    expect(along(pose(true, 0.2))).toBeCloseTo(0, 6) // the turn comes first
    expect(pose(false, 1).travel).toBe(0)
  })
})

describe('the prefixed clicks', () => {
  it('turn their knob, display or travel-only control and nothing else', () => {
    const s = system()
    s.at(5)
    for (const action of ['knob.instrument', 'display.left.mode', 'display.center.brt', 'travel.crank']) s.press(action, 1)
    expect([s.sari, s.radalt]).toEqual([-Infinity, -Infinity]) // no fall through into the test switches' cases
  })
})

describe('the clock and the travel-only controls (#16, #17, #22, #25, #129)', () => {
  it('starts, stops and resets the elapsed time hand from its knob', () => {
    const s = system()
    s.at(10); s.press('clock', 0)
    s.at(70); expect(s.clock_elapsed()).toBe(60)
    s.press('clock', 0); s.at(100); expect(s.clock_elapsed()).toBe(60)
    s.press('clock', 0); expect(s.clock_elapsed()).toBe(0)
    expect(source).toMatch(/ck\.mesh\.quaternion\.copy\(ck\.base\)\.multiply\(CLOCK_TURN\.setFromAxisAngle\(CLOCK_AXIS,-clock_elapsed\(\)\/3600\*Math\.PI\*2\)\);/)
  })

  it('throw a switch a position a click from where the pre-flight leaves it, without passing its stops', () => {
    const s = system()
    expect([s.travel_at('crank'), s.travel_at('apu'), s.travel_at('groundone')]).toEqual([1, 0, 1])
    s.press('travel.crank', 1); s.press('travel.crank', 1)
    expect(s.thrown.crank).toBe(2)
    for (let i = 0; i < 4; i++) s.press('travel.crank', -1)
    expect(s.thrown.crank).toBe(0)
  })

  it('give every travel-only control a rig entry on the travel drive', () => {
    const s = system()
    for (const name of Object.keys(s.TRAVEL)) expect(rig, name).toMatch(new RegExp(`name:"${name}",\\s+track:/[^\\n]*drive:"travel"`))
  })

  it('come back to the pre-flight\'s positions on a fresh jet', () => {
    expect(source).toMatch(/for\(const k of Object\.keys\(knobs\)\) knobs\[k\]=null; for\(const k of Object\.keys\(thrown\)\) delete thrown\[k\];/)
    expect(source).toMatch(/gear_emergency=false; emergency_travel=0; transfer\.wing=transfer\.centre=0; wing_inhibit=false; wing_held=null; systems_at=null; cabin_feet=null; spin_up=false;/)
    expect(source).toMatch(/ecs\.bleed=1; ecs\.valves=\[true,true\]; ecs\.through=false; fire_test\.at=-Infinity; rudder_trim=0; reference="auto";/)
  })
})

// The rig's drives for the panel's switches: each state to its clip fraction,
// the clips measured on the model (the toggles run aft to forward and down to up).
function drive(name: string, setup: string, entry = name): number {
  const cases = /\n\t\tcase "warncaut": f=knob_level\("warn"\); break;[\s\S]*?\n\t\tcase "travel": [^\n]*\n/.exec(source)?.[0] ?? ''
  if (!cases) throw new Error('panel drives not found in engine.ts')
  const detents = /\nconst BLEED_DETENTS=[^\n]*\n/.exec(source)?.[0] ?? ''
  return new Function(`const knob_level=()=>0.5, sim_time=10, r={ name:${JSON.stringify(entry)} }; let reference="auto", rudder_trim=0;
    const electrics={ battery:"on", switches:[true,true] }, ecs={ bleed:1 }, fire_test={ at:-Infinity, loop:0 }, transfer={ wing:0, centre:0 }, thrown={}, TRAVEL={ crank:3, apu:2 }, TRAVEL_REST={ crank:1 };
    const travel_at=(n)=>thrown[n]??TRAVEL_REST[n]??0; ${detents} ${setup} let f; switch(${JSON.stringify(name)}){ ${cases} } return f;`)() as number
}
describe('the panel\'s switches on the model', () => {
  it('put BATT, the GEN switches, ATT and EXT TANKS where FO-5 has their positions', () => {
    expect(['on', 'off', 'oride'].map((b) => drive('battery', `electrics.battery="${b}";`))).toEqual([1, 0.5, 0])
    expect([drive('genleft', ''), drive('genleft', 'electrics.switches[0]=false;')]).toEqual([1, 0])
    expect(['ins', 'auto', 'stby'].map((a) => drive('attswitch', `reference="${a}";`))).toEqual([1, 0.5, 0])
    expect([1, 0, -1].map((t) => drive('wingtanks', `transfer.wing=${t};`))).toEqual([1, 0.5, 0])
    expect(drive('centretank', 'transfer.centre=1;')).toBe(1)
  })

  it('turn BLEED AIR to its detents, RUD TRIM about its neutral, FIRE TEST out of NORM while it runs, and travel from the rests', () => {
    expect([0, 1, 2, 3].map((k) => drive('bleed', `ecs.bleed=${k};`))).toEqual([0, 0.3075, 0.653, 0.92])
    expect([drive('ruddertrim', ''), drive('ruddertrim', 'rudder_trim=1;'), drive('ruddertrim', 'rudder_trim=-1;')]).toEqual([0.5, 0.646, expect.closeTo(0.354, 6)])
    expect([drive('firetest', ''), drive('firetest', 'fire_test.at=8; fire_test.loop=1;'), drive('firetest', 'fire_test.at=8; fire_test.loop=-1;')]).toEqual([0.5, 1, 0])
    expect([drive('travel', '', 'crank'), drive('travel', '', 'apu'), drive('travel', 'thrown.crank=2;', 'crank')]).toEqual([0.5, 0, 1])
  })
})

describe('the spin recovery display (#12, figure 2-14)', () => {
  const run = (frames: number[][]) => new Function('STATE', 'frames', `let spin_up=false, ddi_dirty=false; const ddi_state={ left:{ menu:"" }, right:{ menu:"" }, center:{ menu:"" } };
    ${lift('spin_step')} const seen=[]; for(const out of frames){ spin_step(out); seen.push([spin_up,ddi_state.left.menu,ddi_state.right.menu,ddi_state.center.menu]); } return seen;`)(STATE, frames) as [boolean, string, string, string][]
  it('comes up on both DDIs with the core\'s direction or its latch, and hands them the MENU display when the spin ends', () => {
    const seen = run([words(), words({ spin: -1 }), words({ spin: -1, recovery: 1 }), words({ recovery: 1 }), words()])
    expect(seen.map((s) => s[0])).toEqual([false, true, true, true, false])
    expect(seen[4].slice(1)).toEqual(['tac', 'tac', ''])
    expect(source).toMatch(/if\(spin_up&&display!=="center"\)\{ spin_draw\(x,last_out\|\|\[\]\); return; \}/)
  })

  it('draws SPIN MODE, the arrow with STICK over LEFT or RIGHT, ENGAGED once latched, the boxed airspeed and altitude and the AOA', () => {
    const draw = (out: number[]) => {
      const text: [string, number, number][] = [], rects: number[][] = []
      const x = new Proxy({}, { get: (_t, k) => k === 'fillText' ? (s: string, a: number, b: number) => text.push([String(s), a, b]) : k === 'strokeRect' ? (...r: number[]) => rects.push(r) : k === 'measureText' ? (s: string) => ({ width: 10 * String(s).length }) : () => {}, set: () => true })
      new Function('STATE', 'x', 'out', `const D2R=Math.PI/180; ${lift('spin_draw')}\n spin_draw(x,out);`)(STATE, x, out)
      return { text, rects }
    }
    const left = draw(words({ spin: -1, cas: 120 / 1.944, metres: 21500 / 3.281, alpha: 23.5 * Math.PI / 180 }))
    const said = left.text.map((t) => t[0])
    expect(said).toEqual(expect.arrayContaining(['SPIN MODE', 'STICK', 'LEFT', '120', '21500', 'α 23.5']))
    expect(said).not.toContain('ENGAGED')
    expect(left.text.find((t) => t[0] === 'LEFT')![1]).toBeLessThan(256)
    expect(left.rects).toHaveLength(2) // the airspeed and the altitude boxed
    const right = draw(words({ spin: 1, recovery: 1 }))
    expect(right.text.map((t) => t[0])).toEqual(expect.arrayContaining(['SPIN MODE', 'ENGAGED', 'RIGHT']))
    expect(right.text.find((t) => t[0] === 'RIGHT')![1]).toBeGreaterThan(256)
  })
})
