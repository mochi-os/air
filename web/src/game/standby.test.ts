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

  it('keeps the approach deviation for the HUD and the ADI page only', () => {
    const gauges = /function update_gauges\(out\)\{[\s\S]*?\n\township\.gauges=\{[\s\S]*?\n\t\t[^\n]*ground:[^\n]*\};/.exec(source)?.[0] ?? ''
    expect(gauges).not.toBe('')
    expect(gauges).not.toMatch(/approach_deviation\(\)/)
    expect(gauges).not.toMatch(/\bglide:|\bloc:/)
    expect(source).toMatch(/function ddi_adi\([\s\S]*?const dev=approach_deviation\(\);/)
    expect(source).toMatch(/if\(fpm\)\{ const dev=approach_deviation\(\);/)
  })
})
