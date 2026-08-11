// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { KEY_DEFAULTS, pretty } from './keys'
import { PROFILES, profileFor } from '../lib/config'

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

// The engine and the menu's Keys tab once kept SEPARATE copies of this table
// and drifted: the tab advertised eject on J after the engine had moved it to
// Shift+E and given J to the jettison family, and twelve actions the engine
// binds were missing from the tab, which therefore drew them as unbound. The
// engine now imports KEY_DEFAULTS, so the tables cannot disagree — these tests
// guard the two remaining ways the set can fall out of step.
describe('key bindings', () => {
  it('binds every action the engine dispatches', () => {
    const engine = read('./engine.ts')
    const used = new Set(Array.from(engine.matchAll(/key_of\("([\w.]+)"\)/g), (m) => m[1]))
    expect(used.size).toBeGreaterThan(20) // the scan found the call sites at all
    const unbound = [...used].filter((action) => !(action in KEY_DEFAULTS)).sort()
    expect(unbound).toEqual([])
  })

  it('offers every bindable action in the Keys and Buttons tabs', () => {
    const setup = read('../components/MissionSetup.tsx')
    // The row tables are `const KEY_ROWS: Row[] = [...]` / `BUTTON_ROWS`; take
    // each `{ id: '...'` inside them. A row whose id has no default renders as
    // '—', telling the player a working control is unbound.
    for (const table of ['KEY_ROWS', 'BUTTON_ROWS']) {
      const block = new RegExp(`const ${table}: Row\\[\\] = \\[([\\s\\S]*?)\\n\\]`).exec(setup)
      expect(block, `${table} not found`).toBeTruthy()
      const ids = Array.from(block![1].matchAll(/\{\s*id:\s*'([\w.]+)'/g), (m) => m[1])
      expect(ids.length).toBeGreaterThan(10)
      // The four look DIRECTIONS carry no key: the pad path turns them into
      // camera level state directly (pad_looks) and the keyboard drives the
      // same camera from the fixed arrow keys. look.target is deliberately NOT
      // exempt — it is a bound hold, and it must own a key for a pad button to
      // replay.
      const keyless = new Set(['look.up', 'look.down', 'look.left', 'look.right'])
      const missing = ids.filter((id) => !keyless.has(id) && !(id in KEY_DEFAULTS)).sort()
      expect(missing, `${table} rows with no default binding`).toEqual([])
    }
  })

  it('gives each chord to one action, so a keypress is never ambiguous', () => {
    // Enter deliberately serves both: it launches the selected missile and,
    // with nothing selected, acquires. They can never both apply at once.
    const shared = new Set(['acquire/launch'])
    const byChord = new Map<string, string[]>()
    for (const [action, chord] of Object.entries(KEY_DEFAULTS)) {
      if (chord === 'None') continue // unbound is not a collision
      byChord.set(chord, [...(byChord.get(chord) ?? []), action])
    }
    const clashes = [...byChord.entries()]
      .filter(([, actions]) => actions.length > 1)
      .map(([chord, actions]) => `${chord}: ${actions.sort().join('/')}`)
      .filter((line) => !shared.has(line.split(': ')[1]))
      .sort()
    expect(clashes).toEqual([])
  })

  it('draws the in-game help line from real, bound actions', () => {
    const canvas = read('../components/GameCanvas.tsx')
    const block = /const HINTS: \{[\s\S]*?\n\]/.exec(canvas)
    expect(block, 'HINTS not found').toBeTruthy()
    // Only the `actions: [...]` arrays — a label may be a plain string ('ATC').
    const actions = Array.from(block![0].matchAll(/actions:\s*\[([^\]]*)\]/g)).flatMap((m) =>
      Array.from(m[1].matchAll(/'([\w.]+)'/g), (q) => q[1]),
    )
    expect(actions.length).toBeGreaterThan(15)
    // Every legend must name an action that exists AND is actually bound —
    // the line previously advertised a key that had moved to another control.
    const unknown = actions.filter((a) => !(a in KEY_DEFAULTS)).sort()
    expect(unknown, 'help line names actions with no binding').toEqual([])
    const unbound = actions.filter((a) => KEY_DEFAULTS[a] === 'None').sort()
    expect(unbound, 'help line offers actions that are unbound, drawn as a dash').toEqual([])
    // The controls this help line exists to teach.
    for (const action of ['flares', 'flaps.extend', 'trim.up']) expect(actions).toContain(action)
    // No hand-written key caps left: a bare <kbd>F</kbd> is how it went stale.
    // The number row is the one legitimate literal (views are not rebindable).
    const caps = Array.from(canvas.matchAll(/<kbd>([A-Za-z][\w/]*)<\/kbd>/g), (m) => m[1])
    expect(caps, 'hand-written key caps drift; derive them from the bindings').toEqual([])
  })

  it('shows both halves of every axis pair the engine reads as a pair', () => {
    // An axis the engine reads as index and index+1 is a POV pair. The settings
    // tab must know about it, or it draws only the bound half — and a hat whose
    // vertical half is missing or mis-bound then looks exactly like a working
    // one, because pushing it up moves nothing on screen.
    const engine = read('./engine.ts')
    const paired = new Set(
      Array.from(engine.matchAll(/bind\.axes\.(\w+)\s*\?\?\s*""[\s\S]{0,200}?hi\s*\+\s*1/g), (m) => m[1]),
    )
    expect(paired.size).toBeGreaterThan(0) // the scan found the pair reads at all
    const setup = read('../components/MissionSetup.tsx')
    const declared = new RegExp(`const PAIRS = new Set\\(\\[([^\\]]*)\\]`).exec(setup)
    expect(declared, 'PAIRS not found').toBeTruthy()
    const shown = new Set(Array.from(declared![1].matchAll(/'([\w.]+)'/g), (m) => m[1]))
    expect([...paired].sort(), 'engine pair reads vs PAIRS in the settings tab').toEqual([...shown].sort())
  })

  it('binds only real actions in the built-in device maps', () => {
    // A device default naming an action that does not exist binds a physical
    // button to nothing at all, silently — there is no error, the button simply
    // does not work, and it looks like a hardware fault.
    const config = read('../lib/config.ts')
    const block = /export const PROFILES: StickProfile\[\] = \[([\s\S]*?)\n\]/.exec(config)
    expect(block, 'PROFILES not found').toBeTruthy()
    const maps = Array.from(block![1].matchAll(/buttons:\s*\{([\s\S]*?)\},?\n/g))
    expect(maps.length, 'every profile must declare a button map').toBeGreaterThan(2)
    const actions = maps.flatMap((m) => Array.from(m[1].matchAll(/'?([\w.]+)'?\s*:\s*'/g), (q) => q[1]))
    expect(actions.length).toBeGreaterThan(10)
    const engine = read('./engine.ts')
    const special = new Set(Array.from(engine.matchAll(/action===["']([\w.]+)["']/g), (m) => m[1]))
    const looks = new Set(['look.up', 'look.down', 'look.left', 'look.right'])
    const unknown = actions.filter((a) => !(a in KEY_DEFAULTS) && !special.has(a) && !looks.has(a)).sort()
    expect(unknown, 'device map binds actions the engine does not know').toEqual([])
  })

  it('resolves each device to the right built-in profile, most specific first', () => {
    expect(profileFor('Turtle Beach VelocityOne Flightstick (Vendor: 10f5 Product: 7055)', '').name).toContain('VelocityOne')
    expect(profileFor('Xbox Wireless Controller (STANDARD GAMEPAD)', 'standard').name).toBe('Standard gamepad')
    expect(profileFor('Some Unknown Stick', '').name).toBe('Generic joystick')
    // Order matters: a MEASURED model must beat the generic standard layout even
    // when the browser also reports the pad as standard, or a known stick would
    // silently take the gamepad map.
    expect(profileFor('VelocityOne Flightstick', 'standard').name).toContain('VelocityOne')
    // The last profile is the catch-all, so resolution can never return nothing.
    expect(PROFILES[PROFILES.length - 1].match('anything at all', '')).toBe(true)
  })

  it('keeps the standard gamepad profile inside the layout the spec guarantees', () => {
    // This is the one profile written without the hardware in hand, and it is
    // only safe because the W3C standard mapping fixes the indices: 17 buttons
    // (0-16) and 4 axes (0-3). An index outside that is a guess, not a spec.
    const standard = PROFILES.find((p) => p.name === 'Standard gamepad')
    expect(standard).toBeTruthy()
    for (const [action, index] of Object.entries(standard!.buttons)) {
      expect(Number(index), `${action} button index`).toBeGreaterThanOrEqual(0)
      expect(Number(index), `${action} button index`).toBeLessThanOrEqual(16)
    }
    for (const [axis, value] of Object.entries(standard!.axes)) {
      if (value === '') continue
      const index = Number(value.replace('-', ''))
      expect(index, `${axis} axis index`).toBeGreaterThanOrEqual(0)
      // look is a PAIR and reads index+1, so it must leave room for its second half.
      expect(index + (axis === 'look' || axis === 'trim' ? 1 : 0), `${axis} axis index`).toBeLessThanOrEqual(3)
    }
  })

  it('offers 1-based axis and button numbers while storing the 0-based index', () => {
    // Hardware labels, the Windows controller panel and the simulators number
    // controls from 1; the Gamepad API numbers from 0. The DISPLAY carries the
    // +1 and the STORED value must not: it indexes pad.axes/pad.buttons directly
    // and travels in exported profiles. Getting this backwards binds the wrong
    // control with no error at all, so it is worth pinning.
    const setup = read('../components/MissionSetup.tsx')
    for (const kind of ['axisOptions', 'buttonOptions']) {
      const block = new RegExp(`${kind}\\.map\\(\\(option\\) => \\{([\\s\\S]*?)\\n\\s*\\}\\)\\}`).exec(setup)
      expect(block, `${kind} list not found`).toBeTruthy()
      const body = block![1]
      // stored: the raw option, never the incremented one
      expect(body, `${kind} must store the raw index`).toMatch(/value=\{option\}/)
      expect(body, `${kind} must not store an incremented index`).not.toMatch(/value=\{[^}]*\+\s*1[^}]*\}/)
      // displayed: option + 1
      expect(body, `${kind} must display 1-based`).toMatch(/Number\(option\)\s*\+\s*1/)
    }
  })

  it('renders an unbound action as a dash rather than the word None', () => {
    expect(pretty('None')).toBe('—')
    expect(pretty(KEY_DEFAULTS['trim.reset'])).toBe('—')
  })
})
