// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PROFILES, profileFor } from '../lib/config'
import { KEY_DEFAULTS, pretty } from './keys'

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

// The settings tab's rows in their order, and the controls its Buttons tab offers.
function rows(settings: string): { id: string; group: string }[] {
  const block = /const KEY_ROWS: Row\[\] = \[([\s\S]*?)\n\]/.exec(settings)
  expect(block, 'KEY_ROWS not found').toBeTruthy()
  return Array.from(
    block![1].matchAll(/id:\s*'([\w.]+)',[\s\S]*?group:\s*'(\w+)'/g),
    (m) => ({ id: m[1], group: m[2] })
  )
}
function buttonIds(settings: string): string[] {
  const block = /const BUTTONS = new Set\(\[([\s\S]*?)\]\)/.exec(settings)
  expect(block, 'BUTTONS not found').toBeTruthy()
  return Array.from(block![1].matchAll(/'([\w.]+)'/g), (m) => m[1])
}

// The engine and the menu's Keys tab share KEY_DEFAULTS, so the tables cannot
// disagree; these tests guard the two remaining ways the sets can fall out of
// step.
describe('key bindings', () => {
  it('binds every action the engine dispatches', () => {
    const engine = read('./engine.ts')
    const used = new Set(
      Array.from(
        engine.matchAll(/(?:key_of|held)\("([\w.]+)"\)/g),
        (m) => m[1]
      )
    )
    expect(used.size).toBeGreaterThan(20) // the scan found the call sites at all
    expect(used.has('lights.test')).toBe(true) // held actions count
    const unbound = [...used]
      .filter((action) => !(action in KEY_DEFAULTS))
      .sort()
    expect(unbound).toEqual([])
  })

  it('dispatches every bound action, so no Settings row is a dead key', () => {
    const engine = read('./engine.ts')
    const used = new Set(
      Array.from(
        engine.matchAll(/(?:key_of|held)\("([\w.]+)"\)/g),
        (m) => m[1]
      )
    )
    const dead = Object.keys(KEY_DEFAULTS)
      .filter((action) => !used.has(action))
      .sort()
    expect(dead).toEqual([])
  })

  it('offers every bindable action in the Keys and Buttons tabs', () => {
    const settings = read('../components/SettingsDialog.tsx')
    // KEY_ROWS is every row, `{ id: '...'` each; the Buttons tab is the subset
    // the BUTTONS set names. A row whose id has no default renders as '—',
    // telling the player a working control is unbound.
    const keys = rows(settings).map((row) => row.id)
    const buttons = buttonIds(settings)
    for (const [table, ids] of [
      ['KEY_ROWS', keys],
      ['BUTTONS', buttons],
    ] as const) {
      expect(ids.length).toBeGreaterThan(10)
      const missing = ids.filter((id) => !(id in KEY_DEFAULTS)).sort()
      expect(missing, `${table} rows with no default binding`).toEqual([])
    }
    const orphans = buttons.filter((id) => !keys.includes(id)).sort()
    expect(orphans, 'BUTTONS naming a control KEY_ROWS lacks').toEqual([])
  })

  it('offers the antenna elevation in the Keys and Buttons tabs', () => {
    const settings = read('../components/SettingsDialog.tsx')
    const keys = rows(settings).map((row) => row.id)
    for (const id of ['antenna.up', 'antenna.down']) {
      expect(keys, `KEY_ROWS lacks ${id}`).toContain(id)
      expect(buttonIds(settings), `BUTTONS lacks ${id}`).toContain(id)
    }
  })

  it('reads a held action by its key, a live shift-chord owning its bare key', () => {
    const engine = read('./engine.ts')
    const fn = /\nfunction held\(action\)\{[^\n]*\n[^\n]*\n[^\n]*\n/.exec(engine)?.[0] ?? ''
    expect(fn).not.toBe('')
    const held = (action: string, down: string[]) => new Function('action', 'down', `const keys=new Set(down), bind={ "trim.down":"Comma", "trim.left":"Shift+Comma", reject:"None" }, key_of=(a)=>bind[a]; ${fn} return held(action);`)(action, down) as boolean
    expect(held('trim.down', ['Comma'])).toBe(true)
    expect(held('trim.down', ['Comma', 'Shift+Comma'])).toBe(false) // Shift+, is roll trim
    expect(held('trim.left', ['Comma', 'Shift+Comma'])).toBe(true)
    expect(held('trim.left', ['Comma'])).toBe(false)
    expect(held('reject', ['None'])).toBe(false) // an unbound action is never held
  })

  it('gives each chord to one action, so a keypress is never ambiguous', () => {
    // Enter deliberately serves both: it launches the selected missile and,
    // with nothing selected, acquires. They can never both apply at once.
    // Space fires in flight and pauses a replay, which answers no key that
    // works the jet.
    const shared = new Set(['acquire/launch', 'fire/pause'])
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
    const actions = Array.from(
      block![0].matchAll(/actions:\s*\[([^\]]*)\]/g)
    ).flatMap((m) => Array.from(m[1].matchAll(/'([\w.]+)'/g), (q) => q[1]))
    expect(actions.length).toBeGreaterThan(15)
    // Every legend must name an action that exists AND is actually bound —
    // the line previously advertised a key that had moved to another control.
    const unknown = actions.filter((a) => !(a in KEY_DEFAULTS)).sort()
    expect(unknown, 'help line names actions with no binding').toEqual([])
    const unbound = actions.filter((a) => KEY_DEFAULTS[a] === 'None').sort()
    expect(
      unbound,
      'help line offers actions that are unbound, drawn as a dash'
    ).toEqual([])
    // The controls this help line exists to teach.
    for (const action of ['flares', 'flaps.extend', 'trim.up'])
      expect(actions).toContain(action)
    // No hand-written key caps left: a bare <kbd>F</kbd> is how it went stale,
    // and the chase line's arrows and −/= stayed put when the keys moved.
    const caps = Array.from(
      canvas.matchAll(/<kbd>([^<{\s][^<]*)<\/kbd>/g),
      (m) => m[1]
    )
    expect(
      caps,
      'hand-written key caps drift; derive them from the bindings'
    ).toEqual([])
  })

  it('offers every view, look, zoom and replay key in the Keys tab', () => {
    const settings = read('../components/SettingsDialog.tsx')
    const block = rows(settings).map((row) => row.id)
    for (const id of [
      'view.cockpit',
      'view.hud',
      'view.displays',
      'view.chase',
      'view.flypast',
      'view.padlock',
      'look.up',
      'look.down',
      'look.left',
      'look.right',
      'look.target',
      'zoom.in',
      'zoom.out',
      'pause',
      'dump',
      'secure.port',
      'secure.starboard',
    ])
      expect(block, `KEY_ROWS lacks ${id}`).toContain(id)
  })

  it('groups the rows in the order the tabs draw them, each group in one run', () => {
    const settings = read('../components/SettingsDialog.tsx')
    const order = Array.from(
      /const GROUP_ORDER = \[([^\]]*)\]/
        .exec(settings)![1]
        .matchAll(/'(\w+)'/g),
      (m) => m[1]
    )
    const runs = rows(settings)
      .map((row) => row.group)
      .filter((group, index, all) => group !== all[index - 1])
    expect(runs).toEqual(order) // every group drawn, in order, none split
  })

  it('keeps each control beside the ones it works with', () => {
    const settings = read('../components/SettingsDialog.tsx')
    const group = new Map(rows(settings).map((row) => [row.id, row.group]))
    // The pilot's example: the gear, the brakes, the hook and the flaps are all
    // takeoff and landing, and the parking brake sat in Flight.
    for (const id of [
      'gear',
      'brake.wheel',
      'brake.parking',
      'hook',
      'flaps.extend',
      'launch',
    ])
      expect(group.get(id), id).toBe('landing')
    for (const id of ['acquire', 'tdc.designate', 'antenna.up', 'radar.silent'])
      expect(group.get(id), id).toBe('sensors')
    for (const id of ['dump', 'secure.port', 'lights', 'eject'])
      expect(group.get(id), id).toBe('systems')
    for (const id of ['altitude', 'reject', 'baro.up', 'heading.left'])
      expect(group.get(id), id).toBe('instruments')
    for (const id of ['menu', 'time.faster', 'pause', 'chat', 'shout'])
      expect(group.get(id), id).toBe('game')
    for (const id of ['pitch.up', 'throttle.up', 'trim.up', 'trim.reset'])
      expect(group.get(id), id).toBe('flight')
  })

  it('pairs each control with its opposite, up before down, left before right', () => {
    const ids = rows(read('../components/SettingsDialog.tsx')).map(
      (row) => row.id
    )
    const pairs: [string, string][] = []
    for (const [first, second] of [
      ['up', 'down'],
      ['left', 'right'],
      ['extend', 'retract'],
      ['in', 'out'],
      ['faster', 'slower'],
      ['forward', 'aft'],
      ['port', 'starboard'],
    ])
      for (const id of ids)
        if (id.endsWith('.' + first))
          pairs.push([id, id.slice(0, -first.length) + second])
    expect(pairs.length).toBeGreaterThan(15)
    for (const [first, second] of pairs)
      expect(ids.indexOf(second), `${second} right after ${first}`).toBe(
        ids.indexOf(first) + 1
      )
  })

  it('starts each pair in the left column, so its halves share a line in both tabs', () => {
    const settings = read('../components/SettingsDialog.tsx')
    const buttons = new Set(buttonIds(settings))
    const all = rows(settings)
    for (const [tab, shown] of [
      ['Keys', all],
      ['Buttons', all.filter((row) => buttons.has(row.id))],
    ] as const) {
      const column = new Map<string, number>()
      const seen = new Map<string, number>()
      for (const row of shown) {
        const index = seen.get(row.group) ?? 0
        column.set(row.id, index % 2)
        seen.set(row.group, index + 1)
      }
      const opposite = (id: string) =>
        id
          .replace(/\.up$/, '.down')
          .replace(/\.left$/, '.right')
          .replace(/\.extend$/, '.retract')
          .replace(/\.in$/, '.out')
          .replace(/\.faster$/, '.slower')
          .replace(/\.forward$/, '.aft')
          .replace(/\.port$/, '.starboard')
      const split = shown
        .filter(
          (row) => opposite(row.id) !== row.id && column.has(opposite(row.id))
        )
        .filter((row) => column.get(row.id) !== 0)
        .map((row) => row.id)
      expect(split, `${tab} pairs that straddle two lines`).toEqual([])
    }
  })

  it('shows no hand-written key caps in the Keys tab: every key there is a binding', () => {
    const settings = read('../components/SettingsDialog.tsx')
    const caps = Array.from(
      settings.matchAll(/<Key>([^<{][^<]*)<\/Key>/g),
      (m) => m[1]
    )
    expect(caps, 'a fixed key the player can no longer trust').toEqual([])
  })

  it('draws the Buttons tab from the same rows, so its order cannot drift', () => {
    expect(read('../components/SettingsDialog.tsx')).toContain(
      'const BUTTON_ROWS = KEY_ROWS.filter((row) => BUTTONS.has(row.id))'
    )
  })

  it('keeps the number row, the arrows, −/= and Space as defaults', () => {
    expect(
      [
        'view.cockpit',
        'view.hud',
        'view.displays',
        'view.chase',
        'view.flypast',
        'view.padlock',
      ].map((action) => KEY_DEFAULTS[action])
    ).toEqual(['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'])
    expect(
      ['look.up', 'look.down', 'look.left', 'look.right'].map(
        (action) => KEY_DEFAULTS[action]
      )
    ).toEqual(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])
    expect([KEY_DEFAULTS['zoom.in'], KEY_DEFAULTS['zoom.out']]).toEqual([
      'Equal',
      'Minus',
    ])
    expect(KEY_DEFAULTS.pause).toBe('Space')
  })

  it('reads no player key by its code: views, looks, zoom and the replay pause go through the bindings', () => {
    const engine = read('./engine.ts')
    expect(engine).not.toMatch(/keys\.has\("(Arrow\w+|Minus|Equal)"\)/)
    expect(engine).not.toMatch(/k==="(Digit[1-6]|Space)"/)
    expect(engine).not.toMatch(/\^Digit\[1-6\]/)
    const views: Record<string, string> = {
      'view.cockpit': 'cockpit',
      'view.displays': 'ddi',
      'view.chase': 'chase',
      'view.flypast': 'flypast',
      'view.padlock': 'padlock',
    }
    for (const [action, view] of Object.entries(views))
      expect(engine).toContain(
        `if(ch===key_of("${action}")) set_view("${view}",source);`
      )
    expect(engine).toMatch(
      /if\(ch===key_of\("view\.hud"\)\)\{ if\(cfg\.view==="hud"\) pit_press\("reject",0\); else set_view\("hud",source\); \}/
    )
    for (const action of ['look.up', 'look.down', 'look.left', 'look.right'])
      expect(
        engine.match(
          new RegExp(`held\\("${action.replace('.', '\\.')}"\\)`, 'g')
        )
      ).toHaveLength(3) // the head, the chase orbit and the map's pan
    for (const action of ['zoom.in', 'zoom.out'])
      expect(
        engine.match(
          new RegExp(`held\\("${action.replace('.', '\\.')}"\\)`, 'g')
        )
      ).toHaveLength(2) // the chase dolly and the map
  })

  it('answers a replay on the keys the pilot bound: a rebound view, and a rebound pause', () => {
    const engine = read('./engine.ts')
    const fn =
      /\nfunction watching\(ch\)\{[^\n]*\n[^\n]*\n/.exec(engine)?.[0] ?? ''
    expect(fn).not.toBe('')
    const watch = (ch: string) =>
      new Function(
        'ch',
        `let playback_held=false; const bind={ "view.chase":"KeyQ", pause:"KeyP" }, key_of=(a)=>bind[a]??({ "view.cockpit":"Digit1", map:"KeyM", fire:"Space" })[a], playback_hold=(v)=>{ playback_held=v; };
        ${fn} return [watching(ch), playback_held];`
      )(ch) as [boolean, boolean]
    expect(watch('KeyQ')).toEqual([true, false]) // the chase view, rebound
    expect(watch('Digit4')).toEqual([false, false]) // its old key is gone
    expect(watch('Digit1')).toEqual([true, false])
    expect(watch('KeyP')).toEqual([false, true]) // pause, rebound: it pauses and goes no further
    expect(watch('Space')).toEqual([false, false]) // Space no longer pauses, nor fires
  })

  it('lists the six views on the help line, from their bindings', () => {
    const canvas = read('../components/GameCanvas.tsx')
    const block = /const HINTS: \{[\s\S]*?\n\]/.exec(canvas)![0]
    expect(block).toMatch(
      /actions: \[\s*'view\.cockpit',\s*'view\.hud',\s*'view\.displays',\s*'view\.chase',\s*'view\.flypast',\s*'view\.padlock',\s*\]/
    )
    for (const [name, actions] of Object.entries({
      orbit: "pretty(binding('look.left')) + pretty(binding('look.right'))",
      tilt: "pretty(binding('look.up')) + pretty(binding('look.down'))",
      back: "pretty(binding('zoom.out'))",
      closer: "pretty(binding('zoom.in'))",
    }))
      expect(canvas).toContain(`const ${name} = ${actions}`)
  })

  it('shows both halves of every axis pair the engine reads as a pair', () => {
    // An axis the engine reads as index and index+1 is a POV pair. The settings
    // tab must know about it, or it draws only the bound half — and a hat whose
    // vertical half is missing or mis-bound then looks exactly like a working
    // one, because pushing it up moves nothing on screen.
    const engine = read('./engine.ts')
    const paired = new Set(
      Array.from(
        engine.matchAll(
          /bind\.axes\.(\w+)\s*\?\?\s*""[\s\S]{0,200}?hi\s*\+\s*1/g
        ),
        (m) => m[1]
      )
    )
    expect(paired.size).toBeGreaterThan(0) // the scan found the pair reads at all
    // PAIRS lives in lib/config.ts, not the settings tab: the engine's read,
    // the tab's row marks and unreachable() all need the same answer, and a
    // second copy is how they drift (#152).
    const shared = read('../lib/config.ts')
    const declared = new RegExp(`const PAIRS = new Set\\(\\[([^\\]]*)\\]`).exec(
      shared
    )
    expect(declared, 'PAIRS not found').toBeTruthy()
    const shown = new Set(
      Array.from(declared![1].matchAll(/'([\w.]+)'/g), (m) => m[1])
    )
    expect(
      [...paired].sort(),
      'engine pair reads vs PAIRS in the settings tab'
    ).toEqual([...shown].sort())
  })

  it('binds only real actions in the built-in device maps', () => {
    // A device default naming an action that does not exist binds a physical
    // button to nothing at all, silently — there is no error, the button simply
    // does not work, and it looks like a hardware fault.
    const config = read('../lib/config.ts')
    const block =
      /export const PROFILES: StickProfile\[\] = \[([\s\S]*?)\n\]/.exec(config)
    expect(block, 'PROFILES not found').toBeTruthy()
    const maps = Array.from(
      block![1].matchAll(/buttons:\s*\{([\s\S]*?)\},?\n/g)
    )
    expect(
      maps.length,
      'every profile must declare a button map'
    ).toBeGreaterThan(2)
    const actions = maps.flatMap((m) =>
      Array.from(m[1].matchAll(/'?([\w.]+)'?\s*:\s*'/g), (q) => q[1])
    )
    expect(actions.length).toBeGreaterThan(10)
    const engine = read('./engine.ts')
    const special = new Set(
      Array.from(engine.matchAll(/action===["']([\w.]+)["']/g), (m) => m[1])
    )
    const looks = new Set(['look.up', 'look.down', 'look.left', 'look.right'])
    const unknown = actions
      .filter((a) => !(a in KEY_DEFAULTS) && !special.has(a) && !looks.has(a))
      .sort()
    expect(
      unknown,
      'device map binds actions the engine does not know'
    ).toEqual([])
  })

  it('resolves each device to the right built-in profile, most specific first', () => {
    expect(
      profileFor(
        'Turtle Beach VelocityOne Flightstick (Vendor: 10f5 Product: 7055)',
        ''
      ).name
    ).toContain('VelocityOne')
    expect(
      profileFor('Xbox Wireless Controller (STANDARD GAMEPAD)', 'standard').name
    ).toBe('Standard gamepad')
    expect(profileFor('Some Unknown Stick', '').name).toBe('Generic joystick')
    // Order matters: a MEASURED model beats the generic standard layout, so a
    // known stick does not silently take the gamepad map. That rule assumes
    // the device reports its OWN raw layout - and mapping === 'standard' says
    // it does not. Remapped, the pad reports 4 axes / 17 buttons and the
    // VelocityOne map's trigger (button 17 of 0..16) points past the end: the
    // named map cannot shoot, the standard one can (#152). So the rule is
    // SCOPED to the raw case rather than overturned.
    expect(profileFor('VelocityOne Flightstick', '').name).toContain(
      'VelocityOne'
    )
    expect(profileFor('VelocityOne Flightstick', 'standard').name).toBe(
      'Standard gamepad'
    )
    // The last profile is the catch-all, so resolution can never return nothing.
    expect(PROFILES[PROFILES.length - 1].match('anything at all', '')).toBe(
      true
    )
  })

  it('flies the BVR loop from the VelocityOne stick: castle selects, 15 acquires, 16 steps, 17 fires', () => {
    const stick = profileFor(
      'Turtle Beach VelocityOne Flightstick (Vendor: 10f5 Product: 7055)',
      ''
    )
    expect(stick.axes.weapon).toBe('8')
    expect(stick.axes.trim).toBe('')
    expect(stick.axes.zoom).toBe('')
    expect(stick.buttons.acquire).toBe('15')
    expect(stick.buttons['radar.undesignate']).toBe('16')
    expect(stick.buttons.fire).toBe('17')
    expect(stick.buttons['trim.down']).toBe('12')
    expect(stick.buttons['trim.up']).toBe('13')
    // The base's front-centre diamond (measured 2026-08-16): deliberate
    // actions only, because a base button cannot be reached in a turn.
    expect(stick.buttons.menu).toBe('19')
    expect(stick.buttons['trim.left']).toBe('20')
    expect(stick.buttons['jettison.emergency']).toBe('21')
    expect(stick.buttons['trim.right']).toBe('22')
    expect(stick.buttons.select).toBeUndefined() // the cycle key stays on the keyboard; the stick selects positionally
    // Buttons 2 and 3 as flown (2026-09-10): the G-limit override on 2 and the
    // target padlock on 3; the view cycle has no stick binding.
    expect(stick.buttons.override).toBe('2')
    expect(stick.buttons['look.target']).toBe('3')
    expect(stick.buttons.view).toBeUndefined()
    expect(stick.buttons['zoom.in']).toBeUndefined()
    expect(stick.buttons['zoom.out']).toBeUndefined()
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
      expect(
        index +
          (axis === 'look' || axis === 'trim' || axis === 'weapon' ? 1 : 0),
        `${axis} axis index`
      ).toBeLessThanOrEqual(3)
    }
  })

  it('offers 1-based axis and button numbers while storing the 0-based index', () => {
    // Hardware and the platform controller panels number controls from 1, the
    // Gamepad API from 0. Only the DISPLAY carries the +1: the stored value
    // indexes pad.axes/pad.buttons and travels in exported profiles.
    const settings = read('../components/SettingsDialog.tsx')
    for (const kind of ['axisOptions', 'buttonOptions']) {
      const block = new RegExp(
        `${kind}\\.map\\(\\(option\\) => \\{([\\s\\S]*?)\\n\\s*\\}\\)\\}`
      ).exec(settings)
      expect(block, `${kind} list not found`).toBeTruthy()
      const body = block![1]
      // stored: the raw option, never the incremented one
      expect(body, `${kind} must store the raw index`).toMatch(
        /value=\{option\}/
      )
      expect(body, `${kind} must not store an incremented index`).not.toMatch(
        /value=\{[^}]*\+\s*1[^}]*\}/
      )
      // displayed: option + 1
      expect(body, `${kind} must display 1-based`).toMatch(
        /Number\(option\)\s*\+\s*1/
      )
    }
  })

  it('renders an unbound action as a dash rather than the word None', () => {
    expect(pretty('None')).toBe('—')
    expect(pretty(KEY_DEFAULTS['trim.reset'])).toBe('—')
  })

  it('puts chat on the backtick key, with chat to everyone on its Shift chord', () => {
    expect(KEY_DEFAULTS.chat).toBe('Backquote')
    expect(KEY_DEFAULTS.shout).toBe('Shift+Backquote')
    // the key cap's glyph, not the raw KeyboardEvent code, in the help line and settings
    expect(pretty(KEY_DEFAULTS.chat)).toBe('`')
    expect(pretty(KEY_DEFAULTS.shout)).toBe('Shift+`')
  })
})
