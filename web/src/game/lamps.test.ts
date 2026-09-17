// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The pit's flap position lights (NATOPS 2.8.4.3): HALF and FULL are green
// for the switch in that position below 250 kt; FLAPS is amber for HALF or
// FULL selected above 250 kt, or any flap off; none of them reads flap
// position. engine.ts cannot be imported (WebGL at module scope), so the flap
// lines of lamps_update are read as text and stepped against stand-ins.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
const block = /\n\tif\(l\.half\)\{ const slow=[\s\S]*?l\.flaps\.material\.opacity=[^\n]*\n/.exec(source)?.[0] ?? ''

interface Case { flap: number; kt: number; jam?: number }
// Returns the names of the flap lights on for a switch position, an airspeed
// (knots calibrated) and the leading-edge flap jam word.
function lit(c: Case): string[] {
  if (!block) throw new Error('flap lamp block not found in engine.ts')
  const run = new Function('c', `const STATE={cas:0, jam:1}, out=[c.kt/1.944, 0,0,0,0,0, c.jam||0];
    const lamp=()=>({material:{opacity:0}}), l={half:lamp(), full:lamp(), flaps:lamp()};
    const flap_select=c.flap; ${block}
    return Object.keys(l).filter((k)=>l[k].material.opacity>0.5);`)
  return run(c) as string[]
}

describe('the flap position lights', () => {
  it('show HALF or FULL in green for the switch below 250 kt', () => {
    expect(lit({ flap: 1, kt: 150 })).toEqual(['half'])
    expect(lit({ flap: 2, kt: 150 })).toEqual(['full'])
    expect(lit({ flap: 0, kt: 150 })).toEqual([])
  })

  it('show amber FLAPS instead once the switch is out of AUTO above 250 kt', () => {
    expect(lit({ flap: 1, kt: 260 })).toEqual(['flaps'])
    expect(lit({ flap: 2, kt: 300 })).toEqual(['flaps'])
    expect(lit({ flap: 0, kt: 300 })).toEqual([])
  })

  it('show amber FLAPS for a flap off at any speed, beside the green', () => {
    expect(lit({ flap: 1, kt: 150, jam: 1 })).toEqual(['half', 'flaps'])
    expect(lit({ flap: 0, kt: 400, jam: 1 })).toEqual(['flaps'])
  })

  it('build the three lamps into the gear light unit', () => {
    const build = /\nfunction build_lamps\(g\)\{[\s\S]*?g\.userData\.lamps=lamps;/.exec(source)?.[0] ?? ''
    expect(build).toMatch(/lamps\.half=lamp\(0x2fd24a/)
    expect(build).toMatch(/lamps\.full=lamp\(0x2fd24a/)
    expect(build).toMatch(/lamps\.flaps=lamp\(0xffc23a/)
    expect(build).toMatch(/gear\.add\(lamps\.transit,lamps\.nose,lamps\.left,lamps\.right,lamps\.half,lamps\.full,lamps\.flaps\)/)
  })
})

// The glareshield panels (NATOPS 2.14.1, 2.17.2, foldout FO-5 items 4-10):
// FIRE, MASTER CAUTION and the left panel port of the HUD, the right panel,
// APU FIRE and FIRE starboard. The drivable lamps are stepped from the
// updater's own lines; the layout is pinned from the builder's source.
interface Panel { speedbrake?: number; bar?: number; armed?: boolean; loud?: boolean; contacts?: number }
function panel(p: Panel): string[] {
  const block = /\n\t\/\/ glareshield panels \(#12\)[\s\S]*?lamp_set\(l\.ai,[^\n]*\n/.exec(source)?.[0] ?? ''
  if (!block) throw new Error('glareshield panel block not found in engine.ts')
  const run = new Function('p', `const STATE={speedbrake:0}, out=[p.speedbrake||0], ownship={bar:p.bar||0};
    const jammer_armed=!!p.armed, jammer_loud=()=>!!p.loud, RWR={contacts:new Array(p.contacts||0).fill(0)};
    const l={spdbrk:{},lbar:{},aspj:{},xmit:{},rec:{},ai:{}}, lamp_set=(m,on)=>{ m.on=!!on; }; ${block}
    return Object.keys(l).filter((k)=>l[k].on);`)
  return run(p) as string[]
}

describe('the glareshield panels', () => {
  it('lay FIRE, MASTER CAUTION and the grids outboard of the HUD glass, and APU FIRE and FIRE on the right', () => {
    const build = /\nfunction build_lamps\(g\)\{[\s\S]*?g\.userData\.lamps=lamps;/.exec(source)?.[0] ?? ''
    expect(build).toMatch(/const BROW=\{ x:6\.160, y:0\.495 \};/) // the measured aft face of the glareshield, just below its chamfer
    expect(build).toMatch(/brow\.position\.set\(BROW\.x, BROW\.y, 0\);/)
    expect(build).toMatch(/brow\.children\.forEach\(m=>\{ m\.rotateY\(-Math\.PI\/2\);/) // painted face aft: the back of a lens reads mirrored
    expect(build).toMatch(/const P=0\.012, col=\(k\)=>0\.125\+k\*0\.032;/) // the grids start 12.5 cm out, past the 9 cm glass half-width
    expect(build).toMatch(/lamps\.caution=legend\("MASTER\\nCAUTION","#ffc23a",0\.028,0\.016\); lamps\.caution\.position\.set\(0,-0\.012,-0\.205\);/)
    expect(build).toMatch(/lamps\.fireL=legend\("FIRE","#e23b2e",0\.024,0\.016\); lamps\.fireL\.position\.set\(0,-0\.012,-0\.245\);/)
    expect(build).toMatch(/lamps\.apufire=legend\("APU\\nFIRE","#e23b2e",0\.024,0\.016\); lamps\.apufire\.position\.set\(0,-0\.012,0\.205\);/)
    expect(build).toMatch(/lamps\.fireR=legend\("FIRE","#e23b2e",0\.024,0\.016\); lamps\.fireR\.position\.set\(0,-0\.012,0\.245\);/)
    for (const [name, text] of [['go', 'GO'], ['nogo', 'NO GO'], ['bleedL', 'L BLEED'], ['bleedR', 'R BLEED'], ['spdbrk', 'SPD BRK'], ['stby', 'STBY'], ['lbar', 'L BAR'], ['rec', 'REC'], ['lbarfault', 'L BAR'], ['xmit', 'XMIT'], ['aspj', 'ASPJ ON'], ['rcdr', 'RCDR ON'], ['disp', 'DISP'], ['sam', 'SAM'], ['ai', 'AI'], ['aaa', 'AAA'], ['cw', 'CW']])
      expect(build, name).toContain(`["${name}","${text}"`)
  })

  it('light SPD BRK off the stop and L BAR extended', () => {
    expect(panel({})).toEqual([])
    expect(panel({ speedbrake: 0.5 })).toEqual(['spdbrk'])
    expect(panel({ bar: 1 })).toEqual(['lbar'])
  })

  it('show the ASPJ armed as ASPJ ON with REC, radiating as ASPJ ON with XMIT', () => {
    expect(panel({ armed: true })).toEqual(['aspj', 'rec'])
    expect(panel({ armed: true, loud: true })).toEqual(['aspj', 'xmit'])
  })

  it('light AI for any radar the RWR hears', () => {
    expect(panel({ contacts: 2 })).toEqual(['ai'])
  })

  it('kept the gear unit as it was', () => {
    const build = /\nfunction build_lamps\(g\)\{[\s\S]*?g\.userData\.lamps=lamps;/.exec(source)?.[0] ?? ''
    expect(build).toMatch(/lamps\.half=lamp\(0x2fd24a/)
    expect(build).toMatch(/lamps\.full=lamp\(0x2fd24a/)
    expect(build).toMatch(/lamps\.flaps=lamp\(0xffc23a/)
    expect(build).toMatch(/gear\.add\(lamps\.transit,lamps\.nose,lamps\.left,lamps\.right,lamps\.half,lamps\.full,lamps\.flaps\)/)
  })
})

// The HOOK light (NATOPS 2.10.5.1): on while the hook is in transit, out at the
// selected position, on while the hook rests on the deck short of the down
// proximity switch, and any time the hook disagrees with the handle.
interface Hook { hook: number; target: number; grounded?: boolean }
function hooklit(h: Hook): boolean {
  const line = /\n\tlamp_set\(l\.hook,[^\n]*\n/.exec(source)?.[0] ?? ''
  if (!line) throw new Error('HOOK lamp line not found in engine.ts')
  const run = new Function('h', `const ownship={hook:h.hook, hookTarget:h.target, grounded:!!h.grounded};
    const l={hook:{}}, lamp_set=(m,on)=>{ m.on=!!on; }; ${line}
    return l.hook.on;`)
  return run(h) as boolean
}

describe('the HOOK light', () => {
  it('is out with the hook up and latched, or fully down in the air', () => {
    expect(hooklit({ hook: 0, target: 0 })).toBe(false)
    expect(hooklit({ hook: 1, target: 1 })).toBe(false)
    expect(hooklit({ hook: 0, target: 0, grounded: true })).toBe(false)
  })

  it('is on while the hook travels either way', () => {
    expect(hooklit({ hook: 0.5, target: 1 })).toBe(true)
    expect(hooklit({ hook: 0.5, target: 0 })).toBe(true)
    expect(hooklit({ hook: 0.5, target: 0, grounded: true })).toBe(true)
  })

  it('stays on with the hook down on deck, resting short of the down switch', () => {
    expect(hooklit({ hook: 1, target: 1, grounded: true })).toBe(true)
  })

  it('rides the handle node, and the handle reads the selection so the light means disagreement', () => {
    const build = /\nfunction build_lamps\(g\)\{[\s\S]*?g\.userData\.lamps=lamps;/.exec(source)?.[0] ?? ''
    expect(build).toMatch(/const hook=g\.getObjectByName\("LANDING_Gear_Lever_Hook_AN_Hook_569"\), knob=hook&&hook\.getObjectByName\("Object_986"\);/) // the clip moves this node, not its parent; the knob is its second mesh
    expect(build).toMatch(/const b=node_box\(g,knob\);/)
    expect(build).toMatch(/lamps\.hook=legend\("HOOK","#ffc23a",0\.020,0\.012\);/)
    expect(build).toMatch(/hook\.attach\(lamps\.hook\);/)
    expect(source).toMatch(/case "hooklever": f=\(st\.hookTarget\?\?0\)>0\.5\?1:0; break;/)
  })
})

// The caution lights panel (FO-5 item 46): FUEL LO on the feed-tank hardware
// caution, L GEN and R GEN when their generator drops off the line but neither
// in a dual failure (NATOPS 2.5.1.1), FCES with any FCS caution (2.8.4.5.1).
interface Cautions { fuel?: number; spoolL?: number; spoolR?: number; harmL?: number; harmR?: number; jam?: number }
function cautionlit(c: Cautions): string[] {
  const block = /\n\t\/\/ the caution lights panel \(#13\)[\s\S]*?lamp_set\(l\.fces,jammed\); \}\n/.exec(source)?.[0] ?? ''
  if (!block) throw new Error('caution panel block not found in engine.ts')
  const run = new Function('c', `const FUELLO=726, STATE={engine:0, engine_harm:4, jam:6}, THREE={MathUtils:{clamp:(v,lo,hi)=>Math.min(hi,Math.max(lo,v))}};
    const out=[c.spoolL??0.7, 0, c.spoolR??0.7, 0, c.harmL||0, c.harmR||0, 0,0,0,c.jam||0,0,0,0,0];
    const ownship={fuel:c.fuel??3000, group:{userData:{}}}, cfg={view:'cockpit'}, EMERGENCY_LIGHT=0.5; let unpowered=false;
    const l={fuello:{},genL:{},genR:{},fces:{}}, lamp_set=(m,on)=>{ m.on=!!on; }; ${block}
    return Object.keys(l).filter((k)=>l[k].on);`)
  return run(c) as string[]
}

describe('the caution lights panel', () => {
  it('is dark with fuel above the hardware caution, both engines turning and no jam', () => {
    expect(cautionlit({})).toEqual([])
  })

  it('lights FUEL LO below the feed-tank caution', () => {
    expect(cautionlit({ fuel: 700 })).toEqual(['fuello'])
  })

  it('lights the generator whose engine has stopped or died, and neither when both have', () => {
    expect(cautionlit({ spoolL: 0 })).toEqual(['genL'])
    expect(cautionlit({ harmR: 1 })).toEqual(['genR'])
    expect(cautionlit({ spoolL: 0, spoolR: 0 })).toEqual([])
  })

  it('lights FCES with any jam word', () => {
    expect(cautionlit({ jam: 1 })).toEqual(['fces'])
  })

  it('lays the nine lights three by three on the lower right panel', () => {
    const build = /\nfunction build_lamps\(g\)\{[\s\S]*?g\.userData\.lamps=lamps;/.exec(source)?.[0] ?? ''
    expect(build).toMatch(/const CAUTIONS=\{ x:6\.160, y:0\.001, z:0\.357, pitch:0\.016, span:0\.034, lean:0\.6, wrap:-0\.51 \};/) // the face fitted by panel clicks
    expect(build).toMatch(/m\.position\.set\(CAUTIONS\.lean\*dy\+CAUTIONS\.wrap\*dz,dy,dz\); m\.setRotationFromMatrix\(face\);/) // each lens on the leaning plane, facing its normal
    for (const [name, text] of [['ckseat', 'CK SEAT'], ['apuacc', 'APU ACC'], ['battsw', 'BATT SW'], ['fcshot', 'FCS HOT'], ['gentie', 'GEN TIE'], ['fuello', 'FUEL LO'], ['fces', 'FCES'], ['genL', 'L GEN'], ['genR', 'R GEN']])
      expect(build, name).toContain(`["${name}","${text}"]`)
    expect(build).toMatch(/const face=new THREE\.Matrix4\(\)\.lookAt\(aft,new THREE\.Vector3\(\),new THREE\.Vector3\(0,1,0\)\);/)
  })
})

// The canopy bow lights (FO-5 item 1): LOCK while the radar holds a single
// target track, SHOOT whenever the HUD draws its SHOOT cue, so the bow light
// flashes exactly as the cue does.
function bowlit(stt: number | null, shoot: boolean): string[] {
  const line = /\n\tlamp_set\(l\.lock,[^\n]*\n/.exec(source)?.[0] ?? ''
  if (!line) throw new Error('bow light line not found in engine.ts')
  const run = new Function('stt', 'shoot', `const RADAR={stt}, hud_shoot=shoot;
    const l={lock:{},shoot:{}}, lamp_set=(m,on)=>{ m.on=!!on; }; ${line}
    return Object.keys(l).filter((k)=>l[k].on);`)
  return run(stt, shoot) as string[]
}

describe('the LOCK and SHOOT lights', () => {
  it('follow the single target track and the drawn SHOOT cue', () => {
    expect(bowlit(null, false)).toEqual([])
    expect(bowlit(7, false)).toEqual(['lock'])
    expect(bowlit(7, true)).toEqual(['lock', 'shoot'])
    expect(bowlit(null, true)).toEqual(['shoot'])
  })

  it('take the SHOOT word from every HUD site that draws it, reset each frame', () => {
    expect(source).toMatch(/hud_cue=""; hud_shoot=false;/)
    expect(source.match(/hud_shoot=true/g)?.length).toBe(3) // the AMRAAM cue, the gun director and the Sidewinder cue
    expect(source).toMatch(/hctx\.fillText\("SHOOT",cx,cy-2\.2\*ppdv\); hud_shoot=true; \}/)
    expect(source).toMatch(/hctx\.fillText\("SHOOT",at\[0\],at\[1\]-seeker-16\); hud_shoot=true; \}/)
  })

  it('sit on the arch pendant, LOCK over SHOOT', () => {
    const build = /\nfunction build_lamps\(g\)\{[\s\S]*?g\.userData\.lamps=lamps;/.exec(source)?.[0] ?? ''
    expect(build).toMatch(/const PENDANT=\{ x:6\.033, y:0\.740, z:0\.160, pitch:0\.011 \};/) // the pendant face, measured by panel click
    expect(build).toMatch(/lamps\.lock=legend\("LOCK","#2fd24a",0\.026,0\.010\); lamps\.lock\.position\.set\(0,0,0\);/)
    expect(build).toMatch(/lamps\.shoot=legend\("SHOOT","#2fd24a",0\.026,0\.010\); lamps\.shoot\.position\.set\(0,-PENDANT\.pitch,0\);/)
    expect(build).toMatch(/bow\.children\.forEach\(m=>\{ m\.rotateY\(-Math\.PI\/2\);/)
  })
})

// The emergency instrument light (NATOPS 2.6.2.8): on with both generators off
// the line, when the integral lighting goes dark, so the standby instruments
// stay readable at night. No cockpit control.
interface Power { spoolL?: number; spoolR?: number; view?: string }
function emergency(p: Power): { unpowered: boolean; intensity: number } {
  const block = /\n\t\{ const turning=[\s\S]*?EMERGENCY_LIGHT:0; \}[^\n]*\n/.exec(source)?.[0] ?? ''
  if (!block) throw new Error('generator block not found in engine.ts')
  const run = new Function('p', `const STATE={engine:0, engine_harm:4}, THREE={MathUtils:{clamp:(v,lo,hi)=>Math.min(hi,Math.max(lo,v))}};
    const out=[p.spoolL??0.7, 0, p.spoolR??0.7, 0, 0, 0];
    const ownship={group:{userData:{emergency:{intensity:0}}}}, cfg={view:p.view||'cockpit'}, EMERGENCY_LIGHT=0.5; let unpowered=false;
    const l={genL:{},genR:{}}, lamp_set=(m,on)=>{ m.on=!!on; }; ${block}
    return { unpowered, intensity:ownship.group.userData.emergency.intensity };`)
  return run(p) as { unpowered: boolean; intensity: number }
}
interface Lights { mode: string; instrument: number; consoles: number; flood: number; chart: number; warn: number }
function lights(tod: string, lights: boolean, unpowered: boolean): Lights {
  const state = /\nconst lighting=\{[^\n]*\n/.exec(source)?.[0] ?? ''
  const fn = /\nfunction lighting_set\(\)\{[\s\S]*?lighting\.warn=[^\n]*\n/.exec(source)?.[0] ?? ''
  if (!state || !fn) throw new Error('lighting_set not found in engine.ts')
  const run = new Function('tod', 'lights', 'unpowered', `const cfg={tod}, ownship={lights}; ${state} ${fn} lighting_set(); return { ...lighting };`)
  return run(tod, lights, unpowered) as Lights
}
function backlight(tod: string, on: boolean, unpowered: boolean): number {
  return lights(tod, on, unpowered).instrument
}

describe('the emergency instrument light', () => {
  it('stays off with either generator on the line', () => {
    expect(emergency({})).toEqual({ unpowered: false, intensity: 0 })
    expect(emergency({ spoolL: 0 })).toEqual({ unpowered: false, intensity: 0 })
  })

  it('comes on with both off, in the cockpit view only', () => {
    expect(emergency({ spoolL: 0, spoolR: 0 })).toEqual({ unpowered: true, intensity: 0.5 })
    expect(emergency({ spoolL: 0, spoolR: 0, view: 'hud' })).toEqual({ unpowered: true, intensity: 0 })
  })

  it('takes the integral backlight down with the generators', () => {
    expect(backlight('day', false, false)).toBe(0.22)
    expect(backlight('night', true, false)).toBe(0.62)
    expect(backlight('night', true, true)).toBe(0)
  })

  it('is a white spot on the ownship layer aimed at the standby cluster, reported by the probe', () => {
    const build = /\nfunction build_lamps\(g\)\{[\s\S]*?g\.userData\.lamps=lamps;/.exec(source)?.[0] ?? ''
    expect(build).toMatch(/const emergency=new THREE\.SpotLight\(0xffffff,0,0\.9,0\.55,0\.6,2\); emergency\.position\.set\(6\.10,0\.34,0\.42\);/)
    expect(build).toMatch(/emergency\.target\.position\.set\(6\.30,0\.13,0\.19\); emergency\.layers\.set\(LAYER_OWN\); g\.add\(emergency\); g\.add\(emergency\.target\);/)
    expect(source).toMatch(/emergency:u\.emergency\?u\.emergency\.intensity:null, backlight:lighting\.instrument, lighting:\{ \.\.\.lighting \},/)
  })
})

// The gear handle light and the landing gear aural (NATOPS 2.10.1.4): the red
// light in the handle is on in transit; on for 15 s it brings the tone; under
// the wheels warning it flashes with the beep; and the warning tone silence
// button latches the tone off until its condition clears.
interface Handle { ext: number; t: number; lit?: number; wheels?: boolean }
function handle(c: Handle): { opacity: number; lit: number } {
  const block = /\n\tif\(l\.transit\)\{ const moving=[\s\S]*?l\.right\.material\.opacity=green; \}\n/.exec(source)?.[0] ?? ''
  if (!block) throw new Error('gear handle light block not found in engine.ts')
  const run = new Function('c', `const ext=c.ext, sim_time=c.t, wheels_warning=()=>!!c.wheels; let handle_lit=c.lit??-1;
    const l={transit:{material:{opacity:0}},nose:{material:{}},left:{material:{}},right:{material:{}}}; ${block}
    return { opacity:l.transit.material.opacity, lit:handle_lit };`)
  return run(c) as { opacity: number; lit: number }
}
function tone(lit: number, t: number, wheels: boolean, silenced: boolean): { tone: boolean; silenced: boolean } {
  const fn = /\nfunction gear_tone\(\)\{[\s\S]*?return due&&!tone_silenced; \}\n/.exec(source)?.[0] ?? ''
  if (!fn) throw new Error('gear_tone not found in engine.ts')
  const run = new Function('lit', 't', 'wheels', 'silenced', `const handle_lit=lit, sim_time=t, wheels_warning=()=>wheels; let tone_silenced=silenced;
    ${fn} const tone=gear_tone(); return { tone, silenced:tone_silenced };`)
  return run(lit, t, wheels, silenced) as { tone: boolean; silenced: boolean }
}

describe('the gear handle light and tone', () => {
  it('lights the handle in transit and remembers when it came on', () => {
    expect(handle({ ext: 0.5, t: 10 })).toEqual({ opacity: 1, lit: 10 })
    expect(handle({ ext: 0.5, t: 12, lit: 10 })).toEqual({ opacity: 1, lit: 10 })
    expect(handle({ ext: 1, t: 15, lit: 10 })).toEqual({ opacity: 0, lit: -1 })
  })

  it('flashes the handle with the beep under the wheels warning', () => {
    expect(handle({ ext: 0, t: 0.2, wheels: true }).opacity).toBe(1)
    expect(handle({ ext: 0, t: 0.8, wheels: true }).opacity).toBe(0)
    expect(handle({ ext: 0, t: 0.2 }).opacity).toBe(0)
  })

  it('sounds the tone once the light has been on 15 s, or under the wheels warning', () => {
    expect(tone(10, 24.9, false, false).tone).toBe(false)
    expect(tone(10, 25, false, false).tone).toBe(true)
    expect(tone(-1, 25, true, false).tone).toBe(true)
  })

  it('holds the tone off once silenced, and lets the latch go when the condition clears', () => {
    expect(tone(10, 25, false, true)).toEqual({ tone: false, silenced: true })
    expect(tone(-1, 25, false, true)).toEqual({ tone: false, silenced: false })
  })

  it('drives the horn from the tone, resets on a spawn and offers the button to the dev hook', () => {
    expect(source).toMatch(/\n\t\taudio_horn\(gear_tone\(\)\);\n/)
    expect(source).toMatch(/\n\thandle_lit=-1; tone_silenced=false;/)
    expect(source).toMatch(/dev_silence=function\(\)\{ tone_silence\(\); return tone_silenced; \};/)
  })
})

// The MASTER CAUTION light and the warning tone silence button as click
// targets (#20): the light's press is one function the key and the click
// share (NATOPS 2.17.2.1), and the button next to the gear handle has a key
// and a quad in the gear unit.
function caution_press(lit: boolean): { lamp: boolean; restacked: boolean; dirty: boolean } {
  const fn = /\nfunction caution_press\(\)\{[^\n]*\}\n/.exec(source)?.[0] ?? ''
  if (!fn) throw new Error('caution_press not found in engine.ts')
  const run = new Function('lit', `let caution_lamp=lit, caution_slots=['a'], ddi_dirty=false, restacked=false; const cautions_restack=(s)=>{ restacked=true; return s; };
    ${fn} caution_press(); return { lamp:caution_lamp, restacked, dirty:ddi_dirty };`)
  return run(lit) as { lamp: boolean; restacked: boolean; dirty: boolean }
}

describe('the MASTER CAUTION and silence button clicks', () => {
  it('clear the lit light, and pack the slots when it is out', () => {
    expect(caution_press(true)).toEqual({ lamp: false, restacked: false, dirty: false })
    expect(caution_press(false)).toEqual({ lamp: false, restacked: true, dirty: true })
  })

  it('share the press between the key and the click, and count silence presses', () => {
    expect(source).toMatch(/if\(ch===key_of\("caution\.reset"\)\) caution_press\(\);/)
    expect(source).toMatch(/if\(ch===key_of\("tone\.silence"\)\) tone_silence\(\);/)
    expect(source).toMatch(/function tone_silence\(\)\{ tone_silenced=true; tone_presses\+\+; \}/)
    expect(source).toMatch(/targets=\[u\.lamps&&u\.lamps\.caution,u\.silence\]\.filter\(Boolean\);/)
    expect(source).toMatch(/if\(on\)\{ if\(on\.object===u\.silence\) tone_silence\(\); else caution_press\(\); return; \}/)
  })

  it('seat the button below the gear unit and bind Shift+G with a settings label', () => {
    const build = /\nfunction build_lamps\(g\)\{[\s\S]*?g\.userData\.lamps=lamps;/.exec(source)?.[0] ?? ''
    expect(build).toMatch(/silence\.position\.set\(0,-0\.036,0\); silence\.name="silencebutton"; gear\.add\(silence\); g\.userData\.silence=silence;/)
    const keys = readFileSync(fileURLToPath(new URL('./keys.ts', import.meta.url)), 'utf8')
    expect(keys).toMatch(/'tone\.silence': 'Shift\+KeyG'/)
    const settings = readFileSync(fileURLToPath(new URL('../components/SettingsDialog.tsx', import.meta.url)), 'utf8')
    expect(settings.match(/id: 'tone\.silence', label: msg`Silence gear tone`, group: 'aircraft'/g)?.length).toBe(2)
  })
})

// The interior lights panel (NATOPS 2.6.2): MODE, INST PNL, CONSOLES, FLOOD,
// CHART and WARN/CAUT as the game sets them from the time of day, the lights
// key and the generators, driving the model's knobs and dimming the lenses.
describe('the interior lights panel', () => {
  it('sets DAY with a dim instrument wash and everything else off by day', () => {
    expect(lights('day', false, false)).toEqual({ mode: 'day', instrument: 0.22, consoles: 0, flood: 0, chart: 0, warn: 1 })
    expect(lights('day', true, false).flood).toBe(0)
  })

  it('sets NITE at night, dims the lenses, and brings the panel, consoles and floods up with the lights key', () => {
    expect(lights('night', false, false)).toEqual({ mode: 'nite', instrument: 0.3, consoles: 0.5, flood: 0, chart: 0, warn: 0.55 })
    expect(lights('night', true, false)).toEqual({ mode: 'nite', instrument: 0.62, consoles: 1, flood: 1, chart: 0, warn: 0.55 })
  })

  it('loses the integral lighting, the consoles and the floods with both generators', () => {
    const dark = lights('night', true, true)
    expect([dark.instrument, dark.consoles, dark.flood]).toEqual([0, 0, 0])
  })

  it('drives the six panel controls from the levels and dims the lenses by their material colour', () => {
    const rig = /rig:\[[\s\S]*?\{ name:"flaplever"[^\n]*\n/.exec(source)?.[0] ?? ''
    for (const [name, node] of [['instpnl', 'Knob_INSTPNL_RightPanel_AN'], ['consoles', 'Knob_CONSOLES_RIGHTPANEL_AN'], ['flood', 'Knob_FLOOD_RightPanel_AN'], ['chart', 'Knob_CHART_RightPanel_AN'], ['warncaut', 'Knob_WARN_CAUT_RightPanel_AN'], ['mode', 'MODE_C_AN']])
      expect(rig, name).toMatch(new RegExp('name:"' + name + '",\\s+track:/\\^' + node + '/i,\\s+drive:"' + name + '"'))
    expect(source).toMatch(/case "instpnl": f=lighting\.instrument; break; case "consoles": f=lighting\.consoles; break; case "flood": f=lighting\.flood; break;/)
    expect(source).toMatch(/case "chart": f=lighting\.chart; break; case "warncaut": f=lighting\.warn; break; case "mode": f=lighting\.mode==="nite"\?0\.5:1; break;/)
    expect(source).toMatch(/if\(lamps\) for\(const m of Object\.values\(lamps\)\) if\(m\.userData\.lens\) m\.material\.color\.setScalar\(lighting\.warn\);/)
    expect(source).toMatch(/if\(\/\^EMISSIVE_LIGHTS\$\/\.test\(mm\.name\|\|""\)\) instrument_mats\.push\(mm\);/)
    expect(source).toMatch(/for\(const l of console_lights\) l\.intensity=pit\?0\.06\*Math\.max\(lighting\.consoles,lighting\.flood\):0;/)
    expect(source).toMatch(/cockpit_flood\.intensity=pit\?0\.12\*lighting\.flood:0;/)
  })
})
