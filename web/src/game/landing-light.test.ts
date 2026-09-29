// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The landing light on a carrier recovery. A Hornet flies the approach with
// every exterior light on except the taxi/landing light (NATOPS
// A1-F18AC-NFM-000 8.3.9); lit, its beam flooded the whole ship from 0.2 NM.
// engine.ts cannot be imported (WebGL at module scope), so it is read as text,
// as hint-selection.test.ts does, and the two start functions are evaluated.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')

// The body of one top-level `function name(` up to the next one; '' when the
// function is absent, so a negative control fails assertion by assertion.
function body(name: string): string {
  const start = source.indexOf(`\nfunction ${name}(`)
  if (start < 0) return ''
  const rest = source.slice(start + 1)
  const end = rest.slice(1).search(/\nfunction \w+\(/)
  return end < 0 ? rest : rest.slice(0, end + 1)
}

// recovery_start() through the real mission_start(), for a given mission config.
function recovery(config: { task: string; start: string }): boolean | undefined {
  const functions = body('mission_start') + '\n' + body('recovery_start')
  if (!body('recovery_start')) return undefined
  return new Function('cfg', `${functions}\nreturn recovery_start();`)(config) as boolean
}

describe('the landing light stays dark on a carrier recovery', () => {
  it('treats every Case start as a recovery', () => {
    for (const start of ['case1', 'case2', 'case3']) {
      expect(recovery({ task: 'free', start }), start).toBe(true)
    }
  })

  it('reads the legacy landing start as the Case II it now opens', () => {
    expect(recovery({ task: 'free', start: 'landing' })).toBe(true)
  })

  it('leaves the runway, deck, free-flight and joust starts alone', () => {
    for (const start of ['runway', 'carrier', 'air']) {
      expect(recovery({ task: 'free', start }), start).toBe(false)
    }
    expect(recovery({ task: 'joust', start: 'case3' }), 'a joust starts at the merge whatever the selector says').toBe(false)
  })

  it('spawns with the LDG/TAXI switch OFF on a recovery, and ON after dark otherwise', () => {
    const line = /\n\texterior\.landing=cfg\.tod!=="day"&&!recovery_start\(\);[^\n]*\n/.exec(source)?.[0] ?? ''
    expect(line).not.toBe('')
    const spawn = (tod: string, recovering: boolean) => new Function('tod', 'recovering', `const cfg={ tod }, exterior={ landing:null }, recovery_start=()=>recovering; ${line} return exterior.landing;`)(tod, recovering) as boolean
    expect([spawn('night', false), spawn('dusk', false), spawn('day', false)]).toEqual([true, true, false])
    expect(spawn('night', true)).toBe(false)
  })
})

// The exterior lights each frame (NATOPS 2.6.1): the master switch (the L key,
// ownship.lights) powers the position lights at the POSITION knob's level and the
// strobes as the STROBE switch sets them; the landing/taxi light answers only its
// own switch, the gear handle and the gear. update_aircraft_lights is run whole
// against stand-ins, the cockpit lights already built.
interface Point { visible: boolean; material: { opacity: number } }
interface Frame { pos: Point[]; strobe: Point[]; landing: Point[]; spot: boolean }
interface Jet { lights?: boolean; gear?: number; gearTarget?: number; at?: number; exterior?: Record<string, unknown> }
function frame(jet: Jet): Frame {
  const update = body('update_aircraft_lights')
  if (!update) throw new Error('update_aircraft_lights not found in engine.ts')
  return new Function('jet', `const performance={ now:()=>jet.at??0 }, instrument_backlight=()=>{}, cfg={ view:"hud" }, lighting={ flood:0, consoles:0 };
    const cockpit_flood={ position:{ set(){} }, intensity:0 }, console_lights=[];
    const exterior={ position:1, formation:1, strobe:"bright", landing:false, ...jet.exterior };
    const v=()=>{ const o={ copy(){ return o; }, addScaledVector(){ return o; } }; return o; }, point=()=>({ visible:false, material:{ opacity:1 } });
    const ownship={ lights:!!jet.lights, gear:jet.gear??1, gearTarget:jet.gearTarget??1, group:{ userData:{} }, pos:v(), fwd:v(), up:v() };
    const aircraft_lights={ pos:[point(),point(),point(),point(),point(),point(),point()], strobe:[point(),point()], landing:[point()], spot:{ visible:false, position:v() }, spotTarget:{ position:v() }, nose:{ x:4.6, y:-1.2 } };
    ${update} update_aircraft_lights();
    return { pos:aircraft_lights.pos, strobe:aircraft_lights.strobe, landing:aircraft_lights.landing, spot:aircraft_lights.spot.visible };`)(jet) as Frame
}
const shown = (points: Point[]) => points.map((p) => (p.visible ? p.material.opacity : 0))

describe('the exterior lights', () => {
  it('show all seven position lights at the POSITION knob\'s level under the master switch', () => {
    expect(shown(frame({ lights: true }).pos)).toEqual([1, 1, 1, 1, 1, 1, 1])
    expect(shown(frame({ lights: true, exterior: { position: 0.5 } }).pos)).toEqual(Array(7).fill(0.5))
    expect(shown(frame({ lights: true, exterior: { position: 0 } }).pos)).toEqual(Array(7).fill(0))
    expect(shown(frame({ lights: false }).pos)).toEqual(Array(7).fill(0))
  })

  it('flash the two red strobes at BRT, dimmer at DIM, not at OFF or with the master off', () => {
    expect(shown(frame({ lights: true, at: 20 }).strobe)).toEqual([1, 1]) // in the flash
    expect(shown(frame({ lights: true, at: 500 }).strobe)).toEqual([0, 0]) // between flashes
    expect(shown(frame({ lights: true, at: 20, exterior: { strobe: 'dim' } }).strobe)).toEqual([0.35, 0.35])
    expect(shown(frame({ lights: true, at: 20, exterior: { strobe: 'off' } }).strobe)).toEqual([0, 0])
    expect(shown(frame({ lights: false, at: 20 }).strobe)).toEqual([0, 0])
  })

  it('light the landing light with LDG/TAXI ON, the handle DN and the gear down, the master switch aside (2.6.1.5)', () => {
    const down = { gear: 0, gearTarget: 0 }
    expect(frame({ ...down, exterior: { landing: true } }).spot).toBe(true)
    expect(frame({ ...down, lights: true, exterior: { landing: false } }).spot).toBe(false)
    expect(frame({ gear: 0, gearTarget: 1, exterior: { landing: true } }).spot).toBe(false) // the handle UP, the gear not yet moving
    expect(frame({ gear: 0.5, gearTarget: 0, exterior: { landing: true } }).spot).toBe(false) // still travelling
    expect(shown(frame({ ...down, exterior: { landing: true } }).landing)).toEqual([1])
  })

  it('put the white just below the right fin tip and the strobes on the fins\' outboard faces, the LEX and hinge pairs where measured', () => {
    const place = body('position_aircraft_lights')
    expect(place).toMatch(/const f=fins\(each\); if\(f\)\{ set\(L\.pos\[2\], f\.stbd\.aft\+0\.05, f\.stbd\.top-0\.12, f\.stbd\.z\);/)
    expect(place).toMatch(/set\(L\.strobe\[0\], f\.port\.x, f\.port\.top-0\.45, f\.port\.face-0\.03\); set\(L\.strobe\[1\], f\.stbd\.x, f\.stbd\.top-0\.45, f\.stbd\.face\+0\.03\);/)
    expect(place).toMatch(/set\(L\.pos\[3\], lx, ly, -lz\); set\(L\.pos\[4\], lx, ly, lz\); set\(L\.pos\[5\], hx, hy, -hz\); set\(L\.pos\[6\], hx, hy, hz\);/)
    expect(source).toMatch(/lights:\{ lex:\[1\.25,-0\.21,1\.45\], hinge:\[-0\.79,-0\.50,4\.13\] \},/)
    // two red strobes where there were three white, and red, green, white, then the red and green pairs
    const build = body('build_aircraft_lights')
    expect(build.match(/strobe:\[[^\n]*/)?.[0].match(/mk\(0xff2020/g)?.length).toBe(2)
    expect(build.match(/pos:\[[\s\S]*?\],/)?.[0].match(/mk\(0x(\w+)/g)).toEqual(['mk(0xff2020', 'mk(0x20ff20', 'mk(0xffffff', 'mk(0xff2020', 'mk(0x20ff20', 'mk(0xff2020', 'mk(0x20ff20'])
  })

  it('find each fin\'s tip, trailing edge and outboard face among the airframe\'s vertices', () => {
    // two fins canted outboard, root 1.3 m out at 0.5 m up and tip 1.84 m out at 2.3 m, 2 cm thick; a fuselage and wings besides
    const points: { x: number; y: number; z: number }[] = []
    for (const side of [-1, 1])
      for (let i = 0; i <= 45; i++) {
        const y = 0.5 + i * 0.04
        for (let k = 0; k <= 12; k++) for (const skin of [-0.02, 0.02]) points.push({ x: -4.85 + k * 0.1, y, z: side * (1.3 + (y - 0.5) * 0.3 + skin) })
      }
    for (let x = -6; x <= 10; x += 0.5) points.push({ x, y: 1.0, z: 0.4 }, { x, y: -0.4, z: 6 }, { x, y: -0.4, z: -6 })
    const fins = body('fins')
    expect(fins).not.toBe('')
    const f = new Function('points', `${fins} return fins(g=>points.forEach(g));`)(points) as Record<'port' | 'stbd', { x: number; top: number; aft: number; face: number; z: number }>
    for (const [name, side] of [['port', -1], ['stbd', 1]] as const) {
      expect(f[name].top, name).toBeCloseTo(2.3, 6)
      expect(f[name].aft, name).toBeCloseTo(-4.85, 6)
      expect(f[name].x, name).toBeCloseTo(-4.25, 6)
      expect(f[name].face, name).toBeCloseTo(side * (1.3 + 1.44 * 0.3 + 0.02), 6) // the outboard skin 0.36 m below the tip, the highest in the band
    }
    expect(new Function(`${fins} return fins(g=>[{x:0,y:0,z:0}].forEach(g));`)()).toBe(null) // no fins, no placement
  })

  it('light the ownship\'s formation strips on the FORMATION knob under the master switch, and other jets\' after dark', () => {
    const block = /\n\tif\(g\.userData\.glow&&g\.userData\.glow\.length\)\{[^\n]*\n[^\n]*\n/.exec(source)?.[0] ?? ''
    expect(block).not.toBe('')
    const glow = (own: boolean, lights: boolean, formation: number, tod = 'night') => new Function('own', 'lights', 'formation', 'tod', `const ownship={ lights }, st=own?ownship:{}, exterior={ formation }, cfg={ tod };
      const mm={ emissiveIntensity:-1, userData:{ glowmax:4 } }, g={ userData:{ glow:[mm] } }; ${block} return mm.emissiveIntensity;`)(own, lights, formation, tod) as number
    expect([glow(true, true, 1), glow(true, true, 0.5), glow(true, false, 1)]).toEqual([4, 2, 0])
    expect([glow(false, false, 0, 'night'), glow(false, true, 1, 'day')]).toEqual([4, 0])
  })

  it('replay the recorded master switch, the panel being the viewer\'s', () => {
    expect(source).toMatch(/const lights=n\("Lights",-1\); if\(lights>=0\) ownship\.lights=lights>0;/)
  })
})
