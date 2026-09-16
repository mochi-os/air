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
    const ownship={fuel:c.fuel??3000};
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
