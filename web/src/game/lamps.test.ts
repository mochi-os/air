// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

// The pit's flap position lights (NATOPS 2.8.4.3): HALF and FULL are green
// for the switch in that position below 250 kt; FLAPS is amber for HALF or
// FULL selected above 250 kt, or any flap off; none of them reads flap
// position. engine.ts cannot be imported (WebGL at module scope), so the flap
// lines of lamps_update are read as text and stepped against stand-ins.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
const block = /\n\tif\(l\.half\)\{ const slow=[\s\S]*?l\.flaps\.material\.opacity=[^\n]*\n/.exec(source)?.[0] ?? ''

interface Case { flap: number; kt: number; jam?: number; hyd?: number }
// Returns the names of the flap lights on for a switch position, an airspeed
// (knots calibrated) and the leading-edge flap jam word.
function lit(c: Case): string[] {
  if (!block) throw new Error('flap lamp block not found in engine.ts')
  const run = new Function('c', `const STATE={cas:0, jam:1}, out=[c.kt/1.944, 0,0,0,0,0, c.jam||0];
    const lamp=()=>({material:{opacity:0}}), l={half:lamp(), full:lamp(), flaps:lamp()}, ownship={ gauges:{ hyd:c.hyd??2.83 } };
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

  it('show amber FLAPS for flaps without hydraulic pressure (2.8.4.3)', () => {
    expect(lit({ flap: 0, kt: 150, hyd: 0 })).toEqual(['flaps'])
    expect(lit({ flap: 1, kt: 150, hyd: 0 })).toEqual(['half', 'flaps'])
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
interface Panel { speedbrake?: number; bar?: number; target?: number; armed?: boolean; loud?: boolean; contacts?: number }
function panel(p: Panel): string[] {
  const block = /\n\t\/\/ glareshield panels \(#12\)[\s\S]*?lamp_set\(l\.ai,[^\n]*\n/.exec(source)?.[0] ?? ''
  if (!block) throw new Error('glareshield panel block not found in engine.ts')
  const run = new Function('p', `const STATE={speedbrake:0}, out=[p.speedbrake||0], ownship={bar:p.bar||0, barTarget:p.target??p.bar??0};
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
    expect(build).toMatch(/grid\(-1,GLARESHIELD\.left\); grid\(1,GLARESHIELD\.right\);/)
  })

  // Each lens by its row from the top and its column, 0 inboard and 1 outboard,
  // as build_lamps places it on the brow.
  const place = (m: THREE.Object3D) => [Math.round((-0.006 - m.position.y) / 0.012), Math.abs(m.position.z) < 0.14 ? 0 : 1, Math.sign(m.position.z)]
  it('lay the right panel six rows deep as FO-5 item 8 does, with legendless lenses where it draws a dash', () => {
    const { lamps, brow } = built()
    const at = Object.fromEntries(['rcdr', 'disp', 'sam', 'ai', 'aaa', 'cw'].map((n) => [n, place(lamps[n])]))
    expect(at).toEqual({ rcdr: [0, 0, 1], disp: [0, 1, 1], sam: [3, 1, 1], ai: [4, 0, 1], aaa: [4, 1, 1], cw: [5, 0, 1] })
    const blanks = brow.children.filter((m) => m.userData.text === '' && m.position.z > 0).map((m) => place(m).slice(0, 2))
    expect(blanks).toEqual([[1, 0], [1, 1], [2, 0], [2, 1], [3, 0]])
    expect(Object.values(lamps).filter((m) => m.userData.text === '')).toEqual([]) // no lamp for a legendless lens
  })

  it('put ASPJ ON in the left panel\'s inboard column under XMIT (FO-5 item 6)', () => {
    const { lamps } = built()
    expect(place(lamps.aspj)).toEqual([5, 0, -1])
    expect(place(lamps.xmit)).toEqual([4, 0, -1])
    expect(place(lamps.lbarfault)).toEqual([4, 1, -1])
    expect(place(lamps.go)).toEqual([0, 1, -1])
  })

  it('put the green L BAR out with the switch at RETRACT while the bar is still coming up (2.10.4)', () => {
    expect(panel({ bar: 1, target: 0 })).toEqual([])
    expect(panel({ bar: 0.02, target: 1 })).toEqual(['lbar']) // on as the bar starts down
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

  // The lights are the jammer's cockpit indication: the radar attack format
  // carries no JAM ARM or XMIT text, and a monochrome DDI no amber.
  it('are the jammer\'s indication, with nothing about it on the radar page', () => {
    const start = source.indexOf('function ddi_rdr('), end = source.indexOf('\nfunction ', start + 1)
    expect(start).toBeGreaterThan(0)
    const page = source.slice(start, end)
    expect(page).not.toMatch(/JAM ARM|"XMIT"|jammer_/)
    expect(page).not.toMatch(/#ffc14d/)
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
    expect(build).toMatch(/lamps\.hook=legend\("HOOK","#e23b2e",0\.020,0\.012\);/)
    expect(build).toMatch(/hook\.attach\(lamps\.hook\);/)
    expect(source).toMatch(/case "hooklever": f=\(st\.hookTarget\?\?0\)>0\.5\?1:0; break;/)
  })
})

// The caution lights panel (FO-5 item 46): FUEL LO on the feed-tank hardware
// caution, L GEN and R GEN when their generator drops off the line but neither
// in a dual failure (NATOPS 2.5.1.1), FCES with any FCS caution (2.8.4.5.1).
interface Cautions { low?: boolean; spoolL?: number; spoolR?: number; harmL?: number; harmR?: number; jam?: number }
const generators = /\nfunction generators\(out\)\{[^\n]*\n[^\n]*\n/.exec(source)?.[0] ?? ''
// The DDI side of the generators (NATOPS 2.5.1.1): cautions_update's L GEN and R
// GEN captions and its battery state, from the core's spools and harm.
function gencaptions(c: Cautions): { captions: string[]; battery: boolean } {
  const lines = /\n\tconst \[genL,genR\]=core\?generators\(core\):\[true,true\][^\n]*\n[^\n]*\n/.exec(source)?.[0] ?? ''
  if (!lines || !generators) throw new Error('generator captions not found in engine.ts')
  return new Function('c', `const STATE={engine:0, engine_harm:4}, THREE={MathUtils:{clamp:(v,lo,hi)=>Math.min(hi,Math.max(lo,v))}}; ${generators}
    const core=[c.spoolL??0.7, 0, c.spoolR??0.7, 0, c.harmL||0, c.harmR||0], captions=[]; ${lines} return { captions, battery };`)(c) as { captions: string[]; battery: boolean }
}
function cautionlit(c: Cautions): string[] {
  const block = /\n\t\/\/ the caution lights panel \(#13\)[\s\S]*?lamp_set\(l\.fces,jammed\); \}\n/.exec(source)?.[0] ?? ''
  if (!block || !generators) throw new Error('caution panel block not found in engine.ts')
  const run = new Function('c', `const FUELLO=726, STATE={engine:0, engine_harm:4, jam:6}, THREE={MathUtils:{clamp:(v,lo,hi)=>Math.min(hi,Math.max(lo,v))}}; ${generators}
    const out=[c.spoolL??0.7, 0, c.spoolR??0.7, 0, c.harmL||0, c.harmR||0, 0,0,0,c.jam||0,0,0,0,0];
    const ownship={group:{userData:{}}}, cfg={view:'cockpit'}, EMERGENCY_LIGHT=0.5; let unpowered=false;
    const l={fuello:{},genL:{},genR:{},fces:{}}, lamp_set=(m,on)=>{ m.on=!!on; }, fuel_low=()=>!!c.low; ${block}
    return Object.keys(l).filter((k)=>l[k].on);`)
  return run(c) as string[]
}

describe('the caution lights panel', () => {
  it('raises the L GEN or R GEN caution on the DDI with its light, neither in a dual failure, which is the battery (2.5.1.1)', () => {
    expect(gencaptions({})).toEqual({ captions: [], battery: false })
    expect(gencaptions({ spoolL: 0 })).toEqual({ captions: ['L GEN'], battery: false })
    expect(gencaptions({ harmR: 1 })).toEqual({ captions: ['R GEN'], battery: false })
    expect(gencaptions({ spoolL: 0, spoolR: 0 })).toEqual({ captions: [], battery: true })
  })

  it('lights FUEL LO with the FUEL LO state, the feed tanks\' or a fuel low BIT\'s (fuel_low)', () => {
    expect(cautionlit({ low: true })).toEqual(['fuello'])
  })

  it('is dark with FUEL LO out, both engines turning and no jam', () => {
    expect(cautionlit({})).toEqual([])
  })

  it('lights the generator whose engine has stopped or died, and neither when both have', () => {
    expect(cautionlit({ spoolL: 0 })).toEqual(['genL'])
    expect(cautionlit({ harmR: 1 })).toEqual(['genR'])
    expect(cautionlit({ spoolL: 0, spoolR: 0 })).toEqual([])
  })

  it('lights FCES with any jam word', () => {
    expect(cautionlit({ jam: 1 })).toEqual(['fces'])
  })

  // The model's painted caution lenses, their centres in the group frame: each
  // lens's texture centre mapped through the mesh that carries it and the
  // model's placement (scale, yaw and offset, which dev_box confirms node for
  // node), rows top down and left to right.
  const PAINTED = [
    [[6.178, -0.0122, 0.3229], [6.1684, -0.005, 0.3473], [6.159, 0.0021, 0.3713]],
    [[6.1723, -0.0217, 0.3234], [6.1627, -0.0144, 0.3478], [6.1532, -0.0073, 0.3718]],
    [[6.1665, -0.031, 0.3239], [6.1568, -0.0238, 0.3483], [6.1475, -0.0167, 0.3723]],
    [[6.161, -0.0401, 0.3244], [6.1514, -0.0329, 0.3488], [6.1419, -0.0258, 0.3728]],
  ]
  it('lays the twelve lights four by three as FO-5 item 46 does, each on its painted lens', () => {
    const { lamps, cautions } = built()
    const names = [['ckseat', 'apuacc', 'battsw'], ['fcshot', 'gentie', null], ['fuello', 'fces', null], ['genL', 'genR', null]]
    expect(cautions.children.length).toBe(12)
    names.forEach((row, r) => row.forEach((name, c) => {
      const m = cautions.children[r * 3 + c]
      expect(m.userData.text === '', `${r},${c}`).toBe(name === null)
      if (name) expect(lamps[name], name).toBe(m)
      const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(m.quaternion)
      const lens = m.position.clone().addScaledVector(normal, -0.0015)
      expect(lens.distanceTo(new THREE.Vector3(...PAINTED[r][c])), `${r},${c}`).toBeLessThan(0.0006)
    }))
  })

  it('faces each light toward the pilot, its legend upright on the canted panel and a lens in size', () => {
    const { cautions } = built()
    for (const m of cautions.children) {
      const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(m.quaternion), across = new THREE.Vector3(1, 0, 0).applyQuaternion(m.quaternion)
      expect(normal.x).toBeLessThan(-0.7) // aft
      expect(normal.y).toBeGreaterThan(0.4) // up
      expect(normal.z).toBeLessThan(-0.4) // inboard
      expect(across.z).toBeGreaterThan(0.8) // the legend reads outboard
      expect(m.userData.size).toEqual([0.026, 0.0095]) // inside the 27 by 11 mm cell, the painted frame showing between
    }
  })
})

// build_lamps's brow and caution panel blocks, run on three.js with the layout
// constants and a stand-in lens that records its legend and size.
function built(): { lamps: Record<string, THREE.Mesh>; brow: THREE.Object3D; cautions: THREE.Object3D } {
  const constants = ['GLARESHIELD', 'CAUTION_LIGHTS', 'CAUTION_GRID'].map((n) => {
    const m = new RegExp(`\\nconst ${n}=[\\s\\S]*?;\\n`).exec(source)?.[0]
    if (!m) throw new Error(`${n} not found in engine.ts`)
    return m
  }).join('')
  const cut = (from: string, to: string) => {
    const start = source.indexOf(from), end = source.indexOf(to, start)
    if (start < 0 || end < 0) throw new Error(`${from} not found in engine.ts`)
    return source.slice(start, end)
  }
  const place = /\nfunction caution_place\([^\n]*\n/.exec(source)?.[0] ?? ''
  const brow = cut('\tconst brow=new THREE.Group();', '\tconst handle=')
  const cautions = cut('\t// The caution lights panel (FO-5 item 46', '\t// The emergency instrument light')
  return new Function('THREE', `${constants} ${place} const LAYER_OWN=1, lamps={}, g=new THREE.Group();
    const legend=(text,colour,w=0.026,h=0.010)=>{ const m=new THREE.Mesh(new THREE.PlaneGeometry(w,h)); m.userData.text=text; m.userData.size=[w,h]; return m; };
    ${brow} ${cautions} return { lamps, brow, cautions };`)(THREE)
}

// The canopy bow lights (FO-5 item 1): LOCK while the radar holds a single
// target track, SHOOT whenever the HUD draws its SHOOT cue, so the bow light
// flashes exactly as the cue does.
function bowlit(stt: number | null, shoot: boolean, mode = 'day', instrument = 0.22): string[] {
  const line = /\n\tlamp_set\(l\.lock,[^\n]*\n/.exec(source)?.[0] ?? ''
  if (!line) throw new Error('bow light line not found in engine.ts')
  const run = new Function('stt', 'shoot', 'mode', 'instrument', `const RADAR={stt}, hud_shoot=shoot, lighting={ mode, instrument };
    const l={lock:{},shoot:{}}, lamp_set=(m,on)=>{ m.on=!!on; }; ${line}
    return Object.keys(l).filter((k)=>l[k].on);`)
  return run(stt, shoot, mode, instrument) as string[]
}

describe('the LOCK and SHOOT lights', () => {
  it('keep the strobe SHOOT light dark with the instrument lights up at night (2.6.2.4)', () => {
    expect(bowlit(7, true, 'nite', 0.62)).toEqual(['lock'])
    expect(bowlit(7, true, 'nite', 0)).toEqual(['lock', 'shoot']) // INST PNL off
    expect(bowlit(7, true, 'day', 0.22)).toEqual(['lock', 'shoot']) // the day wash is not the lights on
  })

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
    expect(source).toMatch(/hctx\.fillText\("SHOOT",at\[0\],at\[1\]-seeker-16\*hs\); hud_shoot=true; \}/)
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
  const block = /\n\t\{ const \[genL,genR\]=generators\(out\);[\s\S]*?EMERGENCY_LIGHT:0; \}[^\n]*\n/.exec(source)?.[0] ?? ''
  if (!block || !generators) throw new Error('generator block not found in engine.ts')
  const run = new Function('p', `const STATE={engine:0, engine_harm:4}, THREE={MathUtils:{clamp:(v,lo,hi)=>Math.min(hi,Math.max(lo,v))}}; ${generators}
    const out=[p.spoolL??0.7, 0, p.spoolR??0.7, 0, 0, 0];
    const ownship={group:{userData:{emergency:{intensity:0}}}}, cfg={view:p.view||'cockpit'}, EMERGENCY_LIGHT=0.5; let unpowered=false;
    const l={genL:{},genR:{}}, lamp_set=(m,on)=>{ m.on=!!on; }; ${block}
    return { unpowered, intensity:ownship.group.userData.emergency.intensity };`)
  return run(p) as { unpowered: boolean; intensity: number }
}
interface Lights { mode: string; instrument: number; consoles: number; flood: number; warn: number }
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
interface Handle { ext: number; t: number; lit?: number; wheels?: boolean; up?: boolean; harm?: number[] }
function handle(c: Handle): { opacity: number; lit: number; greens: number[] } {
  const block = /\n\tif\(l\.transit\)\{ const locked=[\s\S]*?l\.right\.material\.opacity=locked\[2\]\?1:0; \}\n/.exec(source)?.[0] ?? ''
  const collapse = /\nconst GEAR_COLLAPSE=[^\n]*\n/.exec(source)?.[0] ?? ''
  if (!block || !collapse) throw new Error('gear handle light block not found in engine.ts')
  const run = new Function('c', `const ext=c.ext, sim_time=c.t, wheels_warning=()=>!!c.wheels; let handle_lit=c.lit??-1; ${collapse}
    const STATE={ gear_harm:0 }, out=c.harm??[0,0,0], ownship={ gearTarget:c.up?1:0 };
    const l={transit:{material:{opacity:0}},nose:{material:{}},left:{material:{}},right:{material:{}}}; ${block}
    return { opacity:l.transit.material.opacity, lit:handle_lit, greens:[l.nose.material.opacity,l.left.material.opacity,l.right.material.opacity] };`)
  return run(c) as { opacity: number; lit: number; greens: number[] }
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
    expect(handle({ ext: 0.5, t: 10 })).toMatchObject({ opacity: 1, lit: 10 })
    expect(handle({ ext: 0.5, t: 12, lit: 10 })).toMatchObject({ opacity: 1, lit: 10 })
    expect(handle({ ext: 1, t: 15, lit: 10 })).toMatchObject({ opacity: 0, lit: -1, greens: [1, 1, 1] })
  })

  it('keeps it on with UP selected until the gear is up', () => {
    expect(handle({ ext: 0.5, t: 10, up: true })).toMatchObject({ opacity: 1, greens: [0, 0, 0] })
    expect(handle({ ext: 0.01, t: 20, up: true, lit: 10 })).toMatchObject({ opacity: 0, lit: -1 })
  })

  it('gives each leg its own green, and keeps the handle light on while a folded strut is not down and locked (2.10.1.4, 2.10.1.5)', () => {
    expect(handle({ ext: 1, t: 10, harm: [0, 0.8, 0] })).toEqual({ opacity: 1, lit: 10, greens: [1, 0, 1] })
    expect(handle({ ext: 1, t: 10, harm: [0.75, 0, 0] }).greens).toEqual([0, 1, 1])
    expect(handle({ ext: 1, t: 10, harm: [0, 0, 0.71] }).greens).toEqual([1, 1, 0])
    expect(handle({ ext: 1, t: 10, harm: [0.69, 0.69, 0.69] })).toEqual({ opacity: 0, lit: -1, greens: [1, 1, 1] }) // damaged, still standing
  })

  it('carries the handle light on the handle as it moves', () => {
    const cut = (from: string, to: string) => { const a = source.indexOf(from), b = source.indexOf(to, a); if (a < 0 || b < 0) throw new Error(`${from} not found`); return source.slice(a, b) }
    const lamp = /\n\tconst lamp=\(c,w,h\)=>[^\n]*\n[^\n]*\n/.exec(source)?.[0] ?? ''
    const gear = cut('\tconst handle=g.getObjectByName("Gear_handle_483");', '\t// The HOOK light')
    const built = new Function('THREE', `const LAYER_OWN=1, lamps={}, g=new THREE.Group(), node=new THREE.Group(), lever=new THREE.Group();
      node.name="Gear_handle_483"; lever.name="Gear_handle_AN_handle_482"; node.position.set(6.25,0.076,-0.338); node.add(lever); g.add(node); ${lamp} ${gear}
      g.updateMatrixWorld(true); const rest=lamps.transit.getWorldPosition(new THREE.Vector3());
      lever.rotation.z=0.6; g.updateMatrixWorld(true); const up=lamps.transit.getWorldPosition(new THREE.Vector3());
      return { parent:lamps.transit.parent===lever, name:lamps.transit.name, rest, up, silence:g.userData.silence.parent!==lever };`)(THREE) as { parent: boolean; name: string; rest: THREE.Vector3; up: THREE.Vector3; silence: boolean }
    expect(built.parent).toBe(true)
    expect(built.name).toBe('transitlamp')
    expect(built.rest.toArray().map((v) => Math.round(v * 1000) / 1000)).toEqual([6.23, 0.121, -0.318]) // on the knob at rest, where it was
    expect(built.rest.distanceTo(built.up)).toBeGreaterThan(0.01) // and it travels with the handle
    expect(built.silence).toBe(true) // the rest of the unit stays on the panel
  })

  it('flashes the handle with the beep under the wheels warning', () => {
    expect(handle({ ext: 0, t: 0.2, wheels: true, up: true }).opacity).toBe(1)
    expect(handle({ ext: 0, t: 0.8, wheels: true, up: true }).opacity).toBe(0)
    expect(handle({ ext: 0, t: 0.2, up: true }).opacity).toBe(0)
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
    expect(source).toMatch(/\n\t\taudio_horn\(gear_tone\(\)\|\|lamps_testing\);/)
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
    expect(source).toMatch(/targets=\[l\.caution,u\.silence,l\.fireL,l\.fireR\]\.filter\(Boolean\);/)
    expect(source).toMatch(/if\(on\)\{ if\(on\.object===u\.silence\) tone_silence\(\); else if\(on\.object===l\.fireL\|\|on\.object===l\.fireR\)\{[^\n]*\} else caution_press\(\); return; \}/)
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
    expect(lights('day', false, false)).toEqual({ mode: 'day', instrument: 0.22, consoles: 0, flood: 0, warn: 1 })
    expect(lights('day', true, false).flood).toBe(0)
  })

  it('sets NITE at night, dims the lenses, and brings the panel, consoles and floods up, whatever the exterior lights master', () => {
    expect(lights('night', false, false)).toEqual({ mode: 'nite', instrument: 0.62, consoles: 1, flood: 1, warn: 0.55 })
    expect(lights('night', true, false)).toEqual(lights('night', false, false))
    expect(lights('day', true, false)).toEqual(lights('day', false, false))
  })

  it('lights the panel\'s placards and gauge atlases from INST PNL, keeping them out of the formation strips\' glow', () => {
    expect(source).toMatch(/if\(!mm\.emissiveMap\|\|instrument_mats\.includes\(mm\)\) return;/)
    expect(source).toMatch(/for\(const mm of instrument_mats\) mm\.emissiveIntensity=level;/)
  })

  it('loses the integral lighting, the consoles and the floods with both generators', () => {
    const dark = lights('night', true, true)
    expect([dark.instrument, dark.consoles, dark.flood]).toEqual([0, 0, 0])
  })

  it('dims every lens by its material colour and every plain lamp\'s own colour, the legendless lenses too (2.6.2.1, 2.17.2.2)', () => {
    const backlight = /\nfunction instrument_backlight\(\)\{[\s\S]*?\n(?=\S)/.exec(source)?.[0] ?? ''
    expect(backlight).not.toBe('')
    const run = (warn: number) => new Function('THREE', `let backlight_state=""; const instrument_mats=[], lighting={ instrument:0.3, warn:1 }, lighting_set=()=>{ lighting.warn=${warn}; };
      const g=new THREE.Group(), named=new THREE.Mesh(new THREE.PlaneGeometry(1,1), new THREE.MeshBasicMaterial()), blank=new THREE.Mesh(new THREE.PlaneGeometry(1,1), new THREE.MeshBasicMaterial()), gear=new THREE.Mesh(new THREE.PlaneGeometry(1,1), new THREE.MeshBasicMaterial({ color:0x2fd24a }));
      named.userData.lens={}; blank.userData.lens={}; gear.userData.lit=0x2fd24a; g.add(named,blank,gear); g.userData.lamps={ lbar:named, nose:gear };
      const ownship={ group:g }; ${backlight} instrument_backlight();
      return [named.material.color.r, blank.material.color.r, gear.material.color.getHex()];`)(THREE) as [number, number, number]
    const [named, blank, gear] = run(0.55)
    expect(named).toBeCloseTo(0.55, 6)
    expect(blank).toBeCloseTo(0.55, 6)
    expect(gear).toBe(new THREE.Color(0x2fd24a).multiplyScalar(0.55).getHex())
    expect(run(1)[2]).toBe(0x2fd24a)
    expect(source).toMatch(/g\.userData\.lamps=lamps; backlight_state="";/) // a rebuilt pit takes the level afresh
    const helper = /\n\tconst lamp=\(c,w,h\)=>\{[^\n]*\n[^\n]*\n/.exec(source)?.[0] ?? ''
    const quad = new Function('THREE', `${helper} return lamp(0x2fd24a,0.01,0.008);`)(THREE) as THREE.Mesh
    expect(quad.userData.lit).toBe(0x2fd24a) // the gear and flap lamps carry the colour the dimming scales
  })

  it('drives the panel\'s four knobs and two switches from the levels and dims the lenses by their material colour', () => {
    const rig = /rig:\[[\s\S]*?\{ name:"flaplever"[^\n]*\n/.exec(source)?.[0] ?? ''
    for (const [name, node] of [['instpnl', 'Knob_INSTPNL_RightPanel_AN'], ['consoles', 'Knob_CONSOLES_RIGHTPANEL_AN'], ['flood', 'Knob_FLOOD_RightPanel_AN'], ['floodswitch', 'Knob_CHART_RightPanel_AN'], ['warncaut', 'Knob_WARN_CAUT_RightPanel_AN'], ['lttest', 'PEDESTAL_LIGHT_AN']])
      expect(rig, name).toMatch(new RegExp('name:"' + name + '",\\s+track:/\\^' + node + '/i,\\s+drive:"' + name + '"'))
    expect(source).toMatch(/case "instpnl": f=lighting\.instrument; break; case "consoles": f=lighting\.consoles; break; case "flood": f=lighting\.flood; break;/)
    // the FLOOD COCKPIT/CHART switch rests at COCKPIT, the floods on the FLOOD knob (2.6.2.5); the KY-58's MODE knob is no lights control
    expect(source).toMatch(/case "floodswitch": f=0; break; case "warncaut": f=lighting\.warn; break;/)
    expect(source).not.toMatch(/track:\/\^MODE_C_AN/)
    expect(source).not.toMatch(/lighting\.chart/)
    expect(source).toMatch(/if\(\/\^EMISSIVE_LIGHTS\$\/\.test\(mm\.name\|\|""\)\) instrument_mats\.push\(mm\);/)
    expect(source).toMatch(/for\(const l of console_lights\) l\.intensity=pit\?0\.06\*Math\.max\(lighting\.consoles,lighting\.flood\):0;/)
    expect(source).toMatch(/cockpit_flood\.intensity=pit\?0\.12\*lighting\.flood:0;/)
  })
})

// The FIRE warning/extinguisher lights as pushbuttons (NATOPS 2.14.4): a click
// on one, or its key, shuts off that engine's fuel at the feed tank, and the light
// stays in with a barber pole in its guard until it is pushed again.
describe('the FIRE lights as pushbuttons', () => {
  it('shut off and restore an engine\'s fuel, each light its own engine, as the keys do', () => {
    const fn = /\nfunction fire_press\(side\)\{[^\n]*\n/.exec(source)?.[0] ?? ''
    expect(fn).not.toBe('')
    const pushes = (sides: number[]) => new Function('sides', `const secured=[false,false]; ${fn} const seen=[]; for(const s of sides){ fire_press(s); seen.push([...secured]); } return seen;`)(sides) as boolean[][]
    expect(pushes([0, 1, 0])).toEqual([[true, false], [true, true], [false, true]])
    expect(source).toMatch(/if\(ch===key_of\("secure\.port"\)\) fire_press\(0\);/)
    expect(source).toMatch(/if\(ch===key_of\("secure\.starboard"\)\) fire_press\(1\);/)
  })

  it('take a click on either FIRE light, but not in a replay', () => {
    expect(source).toMatch(/targets=\[l\.caution,u\.silence,l\.fireL,l\.fireR\]\.filter\(Boolean\);/)
    expect(source).toMatch(/else if\(on\.object===l\.fireL\|\|on\.object===l\.fireR\)\{ if\(!playback\) fire_press\(on\.object===l\.fireL\?0:1\); \}/)
  })

  it('show each light\'s barber pole while it is in, kept out of the lights test and the dimming', () => {
    const line = /\n\t\{ const p=ownship\.group\.userData\.poles; [^\n]*\n/.exec(source)?.[0] ?? ''
    expect(line).not.toBe('')
    const shown = (secured: boolean[]) => new Function('secured', `const poles=[{ visible:false },{ visible:false }], ownship={ group:{ userData:{ poles } } }; ${line} return poles.map((p)=>p.visible);`)(secured) as boolean[]
    expect([shown([true, false]), shown([false, true]), shown([false, false])]).toEqual([[true, false], [false, true], [false, false]])
    // their own group beside the glareshield's, so neither brow.children (the lights test) nor a lens or lamp colour (the dimming) reaches them
    expect(source).toMatch(/guard\.position\.copy\(brow\.position\); g\.add\(guard\); g\.userData\.poles=poles; \}/)
    expect(source).toMatch(/for\(const z of \[-0\.245,0\.245\]\)/) // under the left and right FIRE lenses
  })
})

// The lights test (NATOPS 2.6.2.11): the LT TEST switch, spring-loaded off,
// lights every warning, caution and advisory light while it is held, and only
// with AC power on the aircraft. lamps_update is run whole against stand-ins,
// one frame per call, with the real lamp_set and lights_test.
describe('the lights test', () => {
  const update = /\nfunction lamps_update\(out\)\{[\s\S]*?\n(?=\/\/ Radar altimeter)/.exec(source)?.[0] ?? ''
  const test = /\nfunction lights_switch\(\)\{[^\n]*\nfunction lights_test\(\)\{[^\n]*\n/.exec(source)?.[0] ?? ''
  const set = /\nfunction lamp_set\(m,on\)\{[^\n]*\n[^\n]*\n[^\n]*\n/.exec(source)?.[0] ?? ''
  interface Light { on: boolean; swaps: number }
  interface Rig { frame(held: boolean): Record<string, Light> }
  const rig = (c: { unpowered?: boolean; playback?: boolean; caution?: boolean; clicked?: number } = {}): Rig => {
    for (const [name, text] of [['lamps_update', update], ['lights_test', test], ['lamp_set', set]]) if (!text) throw new Error(name + ' not found in engine.ts')
    return new Function('c', `let lamps_testing=false, unpowered=!!c.unpowered, handle_lit=-1, lights_clicked=c.clicked??-Infinity; const playback=c.playback?{}:null;
      const keys=new Set(), key_of=(a)=>a==="lights.test"?"Shift+KeyL":"None", held=(a)=>keys.has(key_of(a));
      ${test}${set}
      const lens=()=>{ const m={ userData:{ lens:{ on:"on", off:"off" }, on:false }, swaps:0 }; let map="off"; m.material={ get map(){ return map; }, set map(v){ map=v; m.swaps++; } }; return m; };
      const plain=()=>({ userData:{ lit:0x2fd24a }, material:{ opacity:0 }, swaps:0 });
      const l={}; for(const n of ["fireL","fireR","caution","apufire","go","spdbrk","lbar","aspj","xmit","rec","ai","hook","fuello","genL","genR","fces","lock","shoot"]) l[n]=lens();
      for(const n of ["transit","nose","left","right","half","full","flaps"]) l[n]=plain();
      const blank=lens(), tested=[...Object.values(l),blank];
      const STATE={extension:0,speedbrake:1,cas:2,jam:3,gear_harm:12}, out=[], own_burn=[0,0], own_burning=false, caution_lamp=!!c.caution, jammer_armed=false, jammer_loud=()=>false;
      const RWR={contacts:[]}, fuel_low=()=>false, generators=()=>unpowered?[false,false]:[true,true], EMERGENCY_LIGHT=1, cfg={view:"cockpit",tod:"day"}, RADAR={stt:null}, hud_shoot=false;
      const wheels_warning=()=>false, sim_time=0, GEAR_COLLAPSE=0.7, flap_select=0;
      const ownship={ group:{ userData:{ lamps:l, tested } }, gearTarget:1, barTarget:0, hook:0, hookTarget:0, grounded:false, gauges:{ hyd:3000 } };
      ${update}
      return { frame(down){ if(down) keys.add("Shift+KeyL"); else keys.clear(); lamps_update(out);
        const seen={ blank }; Object.assign(seen,l); const r={};
        for(const [n,m] of Object.entries(seen)) r[n]={ on:m.userData.lens?m.userData.on:m.material.opacity>0.5, swaps:m.swaps };
        return r; } };`)(c) as Rig
  }
  const lit = (r: Record<string, Light>) => Object.keys(r).filter((n) => r[n].on).sort()

  it('lights every light while held, those no condition drives and the lens with no legend too', () => {
    const r = rig().frame(true)
    expect(lit(r)).toEqual(Object.keys(r).sort())
    expect(Object.keys(r).length).toBe(26)
  })

  it('holds a driven light on through the test rather than putting it out and back each frame', () => {
    const r = rig()
    r.frame(true)
    r.frame(true)
    expect(r.frame(true).fuello.swaps).toBe(1)
  })

  it('puts out what no condition drives on release, and leaves the rest to their conditions', () => {
    const r = rig({ caution: true })
    r.frame(true)
    expect(lit(r.frame(false))).toEqual(['caution'])
  })

  it('does nothing without AC power, or in a replay', () => {
    expect(lit(rig({ unpowered: true }).frame(true))).toEqual([])
    expect(lit(rig({ playback: true }).frame(true))).toEqual([])
    expect(lit(rig().frame(false))).toEqual([])
    expect(lit(rig({ unpowered: true, clicked: -1 }).frame(false))).toEqual([])
  })

  it('runs two seconds from a click on the switch, which a click cannot hold', () => {
    const r = rig({ clicked: -1.9 }).frame(false) // sim_time 0: clicked 1.9 s ago
    expect(lit(r)).toEqual(Object.keys(r).sort())
    expect(lit(rig({ clicked: -2 }).frame(false))).toEqual([])
    expect(lit(rig({ playback: true, clicked: -1 }).frame(false))).toEqual([])
  })

  it('shows TEST on the model\'s LT TEST switch while the test runs, on the ownship only, and starts a fresh jet at OFF', () => {
    const line = /\n\t\tcase "lttest": [^\n]*\n/.exec(source)?.[0] ?? ''
    expect(line).not.toBe('')
    const drive = (on: boolean, own: boolean) => new Function('on', 'own', `const ownship={}, st=own?ownship:{}, lights_switch=()=>on; let f; switch("lttest"){ ${line} } return f;`)(on, own) as number
    expect([drive(true, true), drive(false, true), drive(true, false)]).toEqual([1, 0, 0])
    expect(source).toMatch(/\{ name:"lttest",\s+track:\/\^PEDESTAL_LIGHT_AN\/i,\s+drive:"lttest" \}/)
    expect(source).toMatch(/\n\tlights_clicked=-Infinity;[^\n]*\n\texterior\.landing=/)
  })

  it('tests each lens on the glareshield and the caution panel, those with no legend too, and every other lamp once', () => {
    const line = /\n\tg\.userData\.tested=[^\n]*\n/.exec(source)?.[0] ?? ''
    expect(line).not.toBe('')
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((name) => ({ name }))
    const tested = new Function('a', 'b', 'c', 'd', `const g={ userData:{} }, brow={ children:[a,b] }, cautions={ children:[c] }, lamps={ one:a, two:d }; ${line} return g.userData.tested;`)(a, b, c, d) as { name: string }[]
    expect(tested.map((m) => m.name)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('is held on Shift+L, beside the lights key, and offered in the Keys and Buttons tabs', () => {
    const keys = readFileSync(fileURLToPath(new URL('./keys.ts', import.meta.url)), 'utf8')
    expect(keys).toMatch(/'lights\.test': 'Shift\+KeyL'/)
    const settings = readFileSync(fileURLToPath(new URL('../components/SettingsDialog.tsx', import.meta.url)), 'utf8')
    expect(settings.match(/id: 'lights\.test', label: msg`Lights test`, group: 'aircraft'/g)?.length).toBe(2)
  })
})
