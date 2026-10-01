// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The hands and feet on the controls (G2): the stick's trigger and paddle, the
// throttle grips' loose switches, the rudder pedals, the dispense switch, the
// nosewheel steering modes, the ejection seat's SAFE/ARMED handle and the
// canopy's emergency controls. engine.ts cannot be imported (WebGL at module
// scope), so the pieces are lifted as text and run against stand-ins.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
function lift(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`${name} not found in engine.ts`)
  const rest = source.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  return end ? rest.slice(0, end.index + 1) : rest
}
const constant = (name: string) => new RegExp(`\\nconst ${name}=[^\\n]*\\n`).exec(source)?.[0] ?? ''
const grip = /\nconst GRIP=\[[\s\S]*?\];[^\n]*\n/.exec(source)?.[0] ?? ''

// The rig drives' cases for the trigger and the pedals, run as apply_anim runs them.
function drive(name: string, o: { own?: boolean; trigger?: boolean; pedals?: number } = {}): number {
  const cases = [/\n\t\tcase "trigger":[^\n]*\n/, /\n\t\tcase "pedals":[^\n]*\n/].map((re) => re.exec(source)?.[0] ?? '').join('')
  if (!cases.includes('trigger') || !cases.includes('pedals')) throw new Error('the trigger and pedal drives not found in engine.ts')
  return new Function('name', 'o', `${constant('PEDALS')} ${constant('hotas')}
    hotas.trigger=!!o.trigger; hotas.pedals=o.pedals??0;
    const ownship={}, st=o.own===false?{}:ownship, r={ name };
    let f; switch(name==="pedalleft"||name==="pedalright"?"pedals":name){ ${cases} } return f;`)(name, o) as number
}

describe('the stick and the pedals', () => {
  it('drive the trigger and the pedals from their clips, and nothing as the pedal adjust lever any more', () => {
    expect(source).toMatch(/\{ name:"trigger",\s+track:\/\^node95_AN\/i,\s+drive:"trigger" \}/)
    expect(source).toMatch(/\{ name:"pedalleft",\s+track:\/\^Rudder_Left_AN\/i,\s+drive:"pedals" \}/)
    expect(source).toMatch(/\{ name:"pedalright",\s+track:\/\^Rudder_Right_AN\/i,\s+drive:"pedals" \}/)
    expect(source).not.toMatch(/pedaladjust/) // node95_AN is the trigger (figure 2-13), never the panel's pedal adjust lever
  })

  it('squeezes the ownship\'s trigger while it is held, and no other jet\'s', () => {
    expect(drive('trigger', { trigger: true })).toBe(1)
    expect(drive('trigger')).toBe(0)
    expect(drive('trigger', { trigger: true, own: false })).toBe(0)
  })

  // The clips, measured in the model, ease in and out: the authored pose is full
  // left rudder, the left pedal 9.8 cm ahead of the right. Sampled from their
  // keyframes, they put both pedals level at 6.5215 m at 0.473 (left) and 0.439
  // (right), and 4.3 cm either side of it at 0.143 and 0.768 (left), 0.687 and
  // 0.134 (right).
  it('levels the pedals with the feet off them, and takes them 4.3 cm at full rudder, right rudder taking the right pedal forward', () => {
    expect(drive('pedalleft')).toBeCloseTo(0.473, 3)
    expect(drive('pedalright')).toBeCloseTo(0.439, 3)
    expect(drive('pedalleft', { pedals: 1 })).toBeCloseTo(0.768, 6)
    expect(drive('pedalright', { pedals: 1 })).toBeCloseTo(0.687, 6)
    expect(drive('pedalleft', { pedals: -1 })).toBeCloseTo(0.143, 6)
    expect(drive('pedalright', { pedals: -1 })).toBeCloseTo(0.134, 6)
    expect(drive('pedalleft', { pedals: 0.5 })).toBeCloseTo((0.473 + 0.768) / 2, 3)
    expect(drive('pedalleft', { pedals: 1, own: false })).toBeCloseTo(0.473, 3) // another jet's stay centred
  })

  it('reads the pedals before the rudder trim, the trigger and the paddle from their keys, every frame', () => {
    expect(source).toMatch(/\n\thotas\.pedals=Math\.abs\(py\)>Math\.abs\(key_axes\.yaw\)\?py:key_axes\.yaw;\n\tinput\.yaw=THREE\.MathUtils\.clamp\(hotas\.pedals\+rudder_trim\*RUDDER_TRIM,-1,1\);/)
    expect(source).toMatch(/\n\thotas\.trigger=keys\.has\(key_of\("fire"\)\)\|\|pad_fire; hotas\.paddle=keys\.has\(key_of\("override"\)\);\n\tnws_step\(\);/)
    expect(source).toMatch(/input\.yaw=last_controls\.yaw; hotas\.pedals=input\.yaw; hotas\.paddle=last_controls\.override;/) // a replay's, from the recording
  })
})

// The grip switches the model draws as loose parts (#26, #30), each moved from
// its drawn place in its lever's frame. The frames were read off the model: in
// each lever's frame forward is +z, up +y and right -x.
type Part = { node: string; move: () => [number, number, number] }
function parts(o: { paddle?: boolean; tdc?: [number, number]; pressed?: number; target?: number; brake?: number; way?: number; dispensed?: number; atc?: number } = {}): Record<string, [number, number, number]> {
  if (!grip) throw new Error('GRIP not found in engine.ts')
  const list = new Function('o', `const sim_time=10, ownship={ speedbrakeTarget:o.target??0, speedbrake:o.brake??0 }; ${constant('hotas')} ${lift('speedbrake_switch')}
    hotas.paddle=!!o.paddle; hotas.tdc.x=(o.tdc||[0,0])[0]; hotas.tdc.y=(o.tdc||[0,0])[1]; hotas.tdc.at=o.pressed??-Infinity;
    hotas.dispense.way=o.way??0; hotas.dispense.at=o.dispensed??-Infinity; hotas.atc=o.atc??-Infinity;
    ${grip} return GRIP;`)(o) as Part[]
  return Object.fromEntries(list.map((p) => [p.node, p.move().map((v) => Math.round(v * 1e4) / 1e4 + 0) as [number, number, number]]))
}
describe('the grips\' loose switches', () => {
  it('rest where the model draws them', () => {
    const rest = parts({ target: 1, brake: 1 })
    for (const [node, move] of Object.entries(rest)) expect(move, node).toEqual([0, 0, 0])
    expect(Object.keys(rest).sort()).toEqual(['Push_Spoiler_584', 'node100_581', 'node102_582', 'node95001_376', 'node98_577'])
  })

  it('draw the paddle aft to the grip while it is held', () => {
    expect(parts({ paddle: true }).node95001_376).toEqual([-0.008, 0, 0])
  })

  it('rock the TDC with the slew, forward for up and down for right, and sink it in when pressed', () => {
    expect(parts({ tdc: [0, 1], target: 1, brake: 1 }).node100_581).toEqual([0.0015, 0, 0])
    expect(parts({ tdc: [1, 0], target: 1, brake: 1 }).node100_581).toEqual([0, -0.0015, 0])
    expect(parts({ pressed: 9.9, target: 1, brake: 1 }).node100_581).toEqual([0, 0, -0.0015])
    expect(parts({ pressed: 9.5, target: 1, brake: 1 }).node100_581).toEqual([0, 0, 0]) // released after a quarter second
  })

  it('throw the speedbrake switch aft while the brake extends, centre once it holds, and forward for in (2.8.4.8.1)', () => {
    expect(parts({ target: 1, brake: 0.4 }).Push_Spoiler_584).toEqual([-0.004, 0, 0])
    expect(parts({ target: 1, brake: 1 }).Push_Spoiler_584).toEqual([0, 0, 0])
    expect(parts({ target: 0.5, brake: 0.5 }).Push_Spoiler_584).toEqual([0, 0, 0])
    expect(parts({ target: 0, brake: 0.5 }).Push_Spoiler_584).toEqual([0.004, 0, 0])
  })

  it('throw the dispense switch forward for chaff and aft for the programme, springing back, and press the ATC button', () => {
    expect(parts({ way: 1, dispensed: 9.9, target: 1, brake: 1 }).node102_582).toEqual([0.003, 0, 0])
    expect(parts({ way: -1, dispensed: 9.9, target: 1, brake: 1 }).node102_582).toEqual([-0.003, 0, 0])
    expect(parts({ way: -1, dispensed: 9, target: 1, brake: 1 }).node102_582).toEqual([0, 0, 0])
    expect(parts({ atc: 9.9, target: 1, brake: 1 }).node98_577).toEqual([-0.002, 0, 0])
  })

  it('place each part from its rest in its lever\'s frame, for the ownship only', () => {
    expect(source).toMatch(/if\(st===ownship&&g\.userData\.grip\) for\(const p of g\.userData\.grip\)\{ const \[forward,up,right\]=p\.move\(\); p\.object\.position\.set\(p\.rest\.x-right,p\.rest\.y\+up,p\.rest\.z\+forward\); \}/)
    expect(source).toMatch(/g\.userData\.grip=GRIP\.map\(p=>\{ const o=m\.getObjectByName\(p\.node\); return o\?\{ \.\.\.p, object:o, rest:o\.position\.clone\(\) \}:null; \}\)\.filter\(Boolean\);/)
  })

  it('press the ATC button with the ATC key, and the TDC with its own', () => {
    expect(source).toMatch(/if\(ch===key_of\("atc"\)\)\{ hotas\.atc=sim_time; pit_press\("atc",0\); \}/) // the grip's button, not the UFC's A/P selector
    expect(lift('tdc_press')).toMatch(/hotas\.tdc\.at=sim_time;/)
  })
})

// The dispense switch (NATOPS 2.1.1.7.3, ALE-47, #31): aft runs the manual
// programme, a flare and a chaff bloom; forward dispenses chaff singles. Weight
// on the wheels inhibits it.
describe('the dispense switch', () => {
  type Dispensed = { flares: number; chaff: number; flare: boolean; bloom: boolean; dropped: string[]; way: number }
  function dispense(way: number, o: { flares?: number; chaff?: number; squish?: number; cheat?: boolean } = {}): Dispensed {
    return new Function('way', 'o', `const sim_time=5, ownship={ flares:o.flares??10, chaff:o.chaff??10, squish:o.squish??0 }, dropped=[];
      let flare_flag=false, chaff_flag=false; ${constant('hotas')}
      const cheat=()=>!!o.cheat, dispense_flare=()=>dropped.push('flare'), dispense_chaff=()=>dropped.push('chaff'), audio_flare=()=>{};
      ${lift('dispense')} dispense(way);
      return { flares:ownship.flares, chaff:ownship.chaff, flare:flare_flag, bloom:chaff_flag, dropped, way:hotas.dispense.way };`)(way, o) as Dispensed
  }
  it('runs the programme aft, a flare and a chaff bloom, and dispenses chaff alone forward', () => {
    expect(dispense(-1)).toEqual({ flares: 9, chaff: 9, flare: true, bloom: false, dropped: ['flare', 'chaff'], way: -1 })
    expect(dispense(1)).toEqual({ flares: 10, chaff: 9, flare: false, bloom: true, dropped: ['chaff'], way: 1 })
  })

  it('keeps each half of the programme on its own magazine, and does nothing empty or on the wheels', () => {
    expect(dispense(-1, { flares: 0 }).dropped).toEqual(['chaff'])
    expect(dispense(1, { chaff: 0 })).toMatchObject({ dropped: [], bloom: false })
    const deck = dispense(-1, { squish: 1 })
    expect(deck).toMatchObject({ dropped: [], flare: false, flares: 10, way: -1 }) // the switch still moves
  })

  it('binds aft to the flares key and forward to the chaff key, and sends the chaff edge on the wire', () => {
    expect(source).toMatch(/if\(ch===key_of\("flares"\)\) dispense\(-1\);/)
    expect(source).toMatch(/if\(ch===key_of\("chaff"\)\) dispense\(1\);/)
    expect(source).toMatch(/flare:flare_flag, chaff:chaff_flag,/)
    expect(source).toMatch(/if\(sequence>0\)\{ flare_flag=false; chaff_flag=false;/)
  })
})

// Nosewheel steering (NATOPS 2.10.2, #36, #28).
describe('nosewheel steering', () => {
  type World = { button?: boolean; paddle?: boolean; nose?: boolean; essential?: boolean; mech?: boolean; bar?: number; handle?: string }
  function wheels() {
    return new Function(`let held_button=false, w={}; const hotas={ paddle:false }, buses={ essential:true }, electrics={ mech:false };
      let fold_handle="lock"; const ownship={ grounded:true, bar:0, group:{ userData:{ spin:[{},{},{ depth:0.01 }] } } };
      const held=(a)=>a==="radar.undesignate"&&held_button;
      ${/\nconst NWS=\{[^\n]*\nlet steering=[^\n]*\n/.exec(source)?.[0] ?? ''} ${lift('nose_loaded')}
      ${lift('nws_step')}

      return { frame(next){ w={ ...w, ...next }; held_button=!!w.button; hotas.paddle=!!w.paddle; buses.essential=w.essential??true; electrics.mech=!!w.mech;
        ownship.bar=w.bar??0; fold_handle=w.handle??"lock"; ownship.grounded=w.nose??true; ownship.group.userData.spin[2].depth=(w.nose??true)?0.01:-0.1;
        nws_step(); return steering; } };`)() as { frame(next?: World): number }
  }
  it('engages LOW with weight on the nose gear, and HI while the button is held', () => {
    const s = wheels()
    expect(s.frame()).toBe(0)
    expect(s.frame({ button: true })).toBe(1)
    expect(s.frame({ button: false })).toBe(0)
  })

  it('disengages on the paddle until the button engages LOW again', () => {
    const s = wheels()
    s.frame()
    expect(s.frame({ paddle: true })).toBe(-1)
    expect(s.frame({ paddle: false })).toBe(-1)
    s.frame({ button: true })
    expect(s.frame({ button: false })).toBe(0)
  })

  it('latches HI on a press with the wing fold handle unlocked', () => {
    const s = wheels()
    s.frame({ handle: 'spread' })
    s.frame({ button: true })
    expect(s.frame({ button: false })).toBe(1)
  })

  it('disengages with the launch bar extended, the button held still giving LOW', () => {
    const s = wheels()
    expect(s.frame({ bar: 1 })).toBe(-1)
    expect(s.frame({ bar: 1, button: true })).toBe(0)
    expect(s.frame({ bar: 1, button: false })).toBe(-1)
  })

  it('disengages with the power off, on MECH ON and with the nose gear off the ground, and engages LOW as it comes back down', () => {
    expect(wheels().frame({ essential: false })).toBe(-1)
    expect(wheels().frame({ mech: true })).toBe(-1)
    const lifted = wheels()
    lifted.frame()
    expect(lifted.frame({ nose: false })).toBe(-1) // rotation: the nose gear unloads
    const s = wheels()
    s.frame({ paddle: true })
    s.frame({ paddle: false })
    expect(s.frame({ nose: false })).toBe(-1)
    expect(s.frame({ nose: true })).toBe(0) // the landing engages LOW, the paddle's disengagement forgotten
  })

  it('steers the core by the mode in single and multiplayer alike', () => {
    expect(source).toMatch(/fire:trigger_own\(\), steering, sequence:\+\+control_sequence \};/)
    expect(source).toMatch(/port:secured\[0\], starboard:secured\[1\], steering,\n/)
  })

  // The drawn nosewheel follows the core's law (gear.go, Strut.limit): LOW ±16°,
  // HI 75°, and off it castors, trailing the path its leg travels 5.4 m ahead of
  // the mains.
  function swivel(steering: number, o: { yaw?: number; rate?: number; speed?: number } = {}): number {
    const block = /\n\tif\(st===ownship&&steering<0\)\{[\s\S]*?\n\telse if\(st===ownship\)\{[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n/.exec(source)?.[0] ?? ''
    if (!block) throw new Error('the drawn nosewheel not found in engine.ts')
    return new Function('steering', 'o', `const D2R=Math.PI/180, THREE={MathUtils:{clamp:(v,lo,hi)=>Math.min(hi,Math.max(lo,v))}}, _NWS=75*D2R, dt=100;
      const ownship={ gauges:{ yaw:o.rate??0 } }, st=ownship, input={ yaw:o.yaw??0 }; st.speed=o.speed??0; st.squish=1; ${block} return st.steer/D2R;`)(steering, o) as number
  }
  it('draws the nosewheel at the mode\'s throw, and castoring with the steering off', () => {
    expect(swivel(0, { yaw: 1 })).toBeCloseTo(16)
    expect(swivel(1, { yaw: 1 })).toBeCloseTo(75)
    expect(swivel(-1, { yaw: 1 })).toBeCloseTo(0) // the pedal moves nothing
    expect(swivel(-1, { rate: 0.2, speed: 3 })).toBeCloseTo(Math.atan2(0.2 * 5.4, 3) * 180 / Math.PI) // a right turn trails it right
  })
})

// The ejection seat (2.15.3, #112) and the canopy's emergency controls (2.15.1.2, #113).
describe('the seat and the canopy\'s emergency controls', () => {
  it('puts the jettison handle, the hand crank and the SAFE/ARMED handle among the pit\'s click spots', () => {
    const spots = /\nconst PIT_SPOTS=\[([\s\S]*?)\];/.exec(source)?.[1] ?? ''
    for (const action of ['canopy.jettison', 'canopy.crank', 'seat']) expect(spots, action).toContain(`action:"${action}"`)
  })

  it('pulls the jettison handle with a middle click', () => {
    expect(source).toMatch(/else if\(s&&s\.action==="canopy\.jettison"\) pit_press\("canopy\.jettison",0\);/)
    expect(source).toMatch(/if\(ch===key_of\("canopy\.jettison"\)&&!playback\) pit_press\("canopy\.jettison",0\);/)
  })

  it('refuses the ejection handle at SAFE, and fires the canopy away first when it pulls', () => {
    expect(source).toMatch(/if\(ch===key_of\("eject"\) && !dev_parked && crash_t<=0 && !ejected && !seat_armed\) notice\(translate\("SEAT SAFE"\)\);/)
    expect(source).toMatch(/else if\(ch===key_of\("eject"\) && !dev_parked && crash_t<=0 && !ejected\)\{\n\t\t\tcanopy_gone=true;/)
  })

  it('hides every canopy the model carries once it has gone, leaving the actuator arm, and puts it back for a fresh jet', () => {
    expect(source).toMatch(/if\(\/\^Canopy_ParentAction_AN_Parent\/i\.test\(o\.name\)\) for\(const c of o\.children\) if\(!\/\^Canopy_Arm\/i\.test\(c\.name\)\) g\.userData\.canopy\.push\(c\);/)
    expect(source).toMatch(/if\(st===ownship&&g\.userData\.canopy\) for\(const c of g\.userData\.canopy\) c\.visible=!canopy_gone;/)
    expect(source).toMatch(/seat_armed=true; canopy_gone=false; cranked=false;/)
  })
})
