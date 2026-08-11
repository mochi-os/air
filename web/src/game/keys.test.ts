// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { KEY_DEFAULTS, pretty } from './keys'

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

  it('renders an unbound action as a dash rather than the word None', () => {
    expect(pretty('None')).toBe('—')
    expect(pretty(KEY_DEFAULTS['trim.reset'])).toBe('—')
  })
})
