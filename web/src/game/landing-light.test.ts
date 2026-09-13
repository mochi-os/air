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

  it('gates the landing light on it, and only the landing light', () => {
    const lights = body('update_aircraft_lights')
    expect(lights).toMatch(/land=on && geardown && !recovery_start\(\)/)
    expect(lights).toMatch(/aircraft_lights\.landing\) p\.visible=land/)
    expect(lights).toMatch(/spot\.visible=land/)
    // the position lights and strobes still follow the lights toggle on the approach
    expect(lights).toMatch(/aircraft_lights\.pos\) p\.visible=on;/)
    expect(lights).toMatch(/strobe=on && /)
  })
})
