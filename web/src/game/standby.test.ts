// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The standby attitude reference indicator (NATOPS 2.12.2) carries pitch,
// roll, an OFF flag and a needle and ball - no ILS bars. The model has
// glideslope and localizer carriages on it; the pit must neither show nor
// drive them, while the HUD needles and the ADI page keep their deviation.
// engine.ts cannot be imported (WebGL at module scope), so the spec is read as
// text, as the IFEI wiring test does.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')

describe('the standby attitude indicator', () => {
  it('hides the ILS bar carriages and nothing else on the instrument', () => {
    const hide = /fa18c:\{[\s\S]*?\n\t\thide:(\/[^\n]*?\/[a-z]*),/.exec(source)?.[1] ?? ''
    expect(hide).not.toBe('')
    const re = new Function('return ' + hide)() as RegExp
    for (const bar of ['INSTRUMENT_AttitudeIndicator_Glide_509', 'INSTRUMENT_AttitudeIndicator_Glide_AN_Glide_508', 'INSTRUMENT_AttitudeIndicator_Localizer_512', 'INSTRUMENT_AttitudeIndicator_Localizer_AN_Localizer_511'])
      expect(re.test(bar), bar).toBe(true)
    for (const keep of ['INSTRUMENT_AttitudeIndicator_Bank_506', 'INSTRUMENT_AttitudeIndicator_Pitch_AN_Pitch_503', 'INSTRUMENT_AttitudeIndicator_Slip_AN_Slip_514', 'INSTRUMENT_MagneticCompass_AN_MagneticCompass_517'])
      expect(re.test(keep), keep).toBe(false)
  })

  it('drives pitch, bank and the slip ball, and no ILS channel', () => {
    const rig = /rig:\[[\s\S]*?\{ name:"flaplever"[^\n]*\n/.exec(source)?.[0] ?? ''
    expect(rig).not.toBe('')
    for (const gauge of ['pitch', 'bank', 'slip']) expect(rig).toMatch(new RegExp('gauge:"' + gauge + '"'))
    expect(rig).not.toMatch(/gauge:"(glide|loc)"/)
    expect(rig).not.toMatch(/AttitudeIndicator_(Glide|Localizer)/)
  })

  it('seats the magnetic compass card in the arch housing and keeps its heading drive', () => {
    // NATOPS 2.12.9: the standby magnetic compass is on the right windshield
    // arch. The model spins its card in the right vertical panel's bezel and
    // carries the arch housing (Object_622) empty; mount_compass re-seats the
    // card there from build_indexer, reparented so it rides the housing's frame.
    const mount = /\nfunction mount_compass\(g\)\{[\s\S]*?card\.userData\.mounted=true;[^\n]*\n/.exec(source)?.[0] ?? ''
    expect(mount).not.toBe('')
    expect(mount).toMatch(/getObjectByName\("INSTRUMENT_MagneticCompass_518"\)/)
    expect(mount).toMatch(/getObjectByName\("Object_622"\)/)
    expect(mount).toMatch(/housing\.parent\.attach\(card\)/)
    expect(source).toMatch(/build_ifei\(g\); mount_compass\(g\); \}/)
    const rig = /rig:\[[\s\S]*?\{ name:"flaplever"[^\n]*\n/.exec(source)?.[0] ?? ''
    expect(rig).toMatch(/name:"compass",\s+node:"INSTRUMENT_MagneticCompass_AN_MagneticCompass_517",\s+axis:"y", gauge:"heading"/)
  })

  it('draws the radar altimeter bug and red light at the index the aural fires on, with a BIT light', () => {
    // NATOPS 2.12.5.4: the index pointer sets the altitude the red light and the
    // voice come on at. The face once painted the bug and lit the lamp at a
    // fixed 250 ft while the aural fired at law_index (200 in the pattern, 40
    // for a cat shot).
    const draw = /\nfunction radalt_draw\(r, agl, index\)\{[\s\S]*?r\.tex\.needsUpdate=true; \}\n/.exec(source)?.[0] ?? ''
    expect(draw).not.toBe('')
    expect(draw).toMatch(/dial\(RADALT_DIAL,index\)/)
    expect(draw).toMatch(/lamp=!off&&agl<index/)
    expect(draw).not.toMatch(/250/)
    expect(draw).toMatch(/the green BIT light/)
    expect(source).toMatch(/radalt_draw\(r, ownship\.pos\.y-\(surface>-1e8\?surface:0\), law_index\);/)
    expect(source).toMatch(/radalt_draw\(g\.userData\.radalt, 1e9, law_index\);/)
  })

  it('keeps the approach deviation for the HUD and the ADI page only', () => {
    const gauges = /function update_gauges\(out\)\{[\s\S]*?\n\township\.gauges=\{[\s\S]*?\n\t\t[^\n]*ground:[^\n]*\};/.exec(source)?.[0] ?? ''
    expect(gauges).not.toBe('')
    expect(gauges).not.toMatch(/approach_deviation\(\)/)
    expect(gauges).not.toMatch(/\bglide:|\bloc:/)
    expect(source).toMatch(/function ddi_adi\([\s\S]*?const dev=approach_deviation\(\);/)
    expect(source).toMatch(/if\(fpm\)\{ const dev=approach_deviation\(\);/)
  })
})

// The ALR-67 azimuth indicator (#28): the EW page's picture, drawn by one
// function at the DDI's geometry and at the disc's in the right vertical
// panel's housing, so the two cannot drift. The function runs against a
// recording context.
interface Emitter { bearing: number; at?: number; locked?: boolean; missile?: boolean }
function ew_calls(cx: number, cy: number, R: number, contacts: Emitter[]): { text: [string, number, number][]; arcs: [number, number, number][] } {
  const fn = /\nfunction ew_draw\(x,cx,cy,R,size\)\{[\s\S]*?\n\tx\.globalAlpha=1; \}\n/.exec(source)?.[0] ?? ''
  if (!fn) throw new Error('ew_draw not found in engine.ts')
  const run = new Function('cx', 'cy', 'R', 'contacts', `const D2R=Math.PI/180, RWR={contacts, time:10}, ownship={gauges:{heading:0}};
    const text=[], arcs=[];
    const x=new Proxy({}, { get:(t,k)=>{ if(k==='fillText') return (s,px,py)=>text.push([s,px,py]); if(k==='arc') return (ax,ay,r)=>arcs.push([ax,ay,r]); return ()=>{}; }, set:()=>true });
    ${fn} ew_draw(x,cx,cy,R,18); return { text, arcs };`)
  return run(cx, cy, R, contacts) as { text: [string, number, number][]; arcs: [number, number, number][] }
}
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6

describe('the ALR-67 azimuth indicator', () => {
  it('puts a search emitter on the right beam right of centre at the outer band, at both geometries', () => {
    for (const [cx, cy, R] of [[256, 266, 190], [80, 80, 68]]) {
      const { text } = ew_calls(cx, cy, R, [{ bearing: Math.PI / 2, at: 10 }])
      expect(text.length).toBe(1)
      expect(text[0][0]).toBe('18')
      expect(near(text[0][1], cx + 0.74 * R) && near(text[0][2], cy), `${cx},${cy},${R}`).toBe(true)
    }
  })

  it('draws a lock on the inner band with one ring and a missile innermost with two, scaled to the ring', () => {
    const lock = ew_calls(80, 80, 68, [{ bearing: 0, locked: true }])
    expect(near(lock.text[0][1], 80) && near(lock.text[0][2], 80 - 0.34 * 68)).toBe(true)
    expect(lock.arcs.slice(2)).toEqual([[80, 80 - 0.34 * 68, 13 * 68 / 190]]) // after the two band rings
    const missile = ew_calls(80, 80, 68, [{ bearing: 0, missile: true }])
    expect(missile.text[0][0]).toBe('M')
    expect(missile.arcs.slice(2).map((a) => a[2])).toEqual([13 * 68 / 190, 17 * 68 / 190])
  })

  it('is drawn through the shared function by the EW page and by the disc', () => {
    expect(source).toMatch(/function ddi_ew\(x\)\{ x\.fillText\("EW",256,36\); ew_draw\(x,256,266,190,18\); \}/)
    expect(source).toMatch(/ew_draw\(x,80,80,68,11\); w\.count=RWR\.contacts\.length; w\.tex\.needsUpdate=true;/)
  })

  it('seats the disc in the right vertical panel housing on the ownship layer, refreshed with the radar altimeter', () => {
    expect(source).toMatch(/const RWR_FACE=\{ x:6\.020, y:0\.353, z:0\.305, r:0\.024 \};/) // the housing bezel, measured by panel click
    expect(source).toMatch(/build_radalt\(g\); build_rwr\(g\);/)
    expect(source).toMatch(/new THREE\.CircleGeometry\(RWR_FACE\.r,36\)/)
    expect(source).toMatch(/surface_pose\(mesh,RWR_FACE\.x,0,RWR_FACE\.y,RWR_FACE\.z\); mesh\.layers\.set\(LAYER_OWN\);/)
    expect(source).toMatch(/if\(w\)\{ const now=performance\.now\(\); if\(now-w\.last>250\)\{ w\.last=now; rwr_draw\(w\); \} \} \}/)
  })
})
