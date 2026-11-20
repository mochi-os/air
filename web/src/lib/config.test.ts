// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { KEY_DEFAULTS } from '../game/keys'
import { FUEL, PRESETS, matches, normalize } from '../game/stores'
import {
  DEFAULT_CONFIG,
  SHARED,
  TAB_FIELDS,
  bindings,
  deviceDefaults,
  profileBindings,
  profileFor,
  reaches,
  rebind,
  unreachable,
  seedStart,
} from './config'

describe('seedStart', () => {
  it('seeds a recovery fuel state for every pattern case', () => {
    for (const start of ['case1', 'case2', 'case3'] as const) {
      expect(seedStart(DEFAULT_CONFIG, start).fuel).toBe(4500)
    }
  })
  it('seeds a recovery fuel state for the approach starts, and leaves their weather alone (#133)', () => {
    const night = { ...DEFAULT_CONFIG, tod: 'night' as const }
    for (const start of ['groove', 'final'] as const) {
      expect(seedStart(night, start)).toMatchObject({ fuel: 4500, tod: 'night' })
    }
  })
  it("seeds the loaded preset's fuel back for the launch starts", () => {
    for (const [name, fuel] of Object.entries(FUEL)) {
      const light = seedStart(
        { ...DEFAULT_CONFIG, stores: structuredClone(PRESETS[name]) },
        'case1'
      )
      for (const start of ['air', 'runway', 'apron', 'carrier', 'deck'] as const) {
        expect(seedStart(light, start).fuel).toBe(fuel)
      }
    }
  })
  it("seeds full internal for a fit of the player's own", () => {
    const own = normalize({ 1: { fixture: 'rail', stores: ['9m'] } })
    expect(matches(own)).toBe('')
    expect(seedStart({ ...DEFAULT_CONFIG, stores: own }, 'air').fuel).toBe(
      10800
    )
  })
  it('loads a fuel for every stores preset', () => {
    expect(Object.keys(FUEL).sort()).toEqual(Object.keys(PRESETS).sort())
  })
  it('defaults to the fuel of the preset its stores carry', () => {
    expect(DEFAULT_CONFIG.fuel).toBe(FUEL[matches(DEFAULT_CONFIG.stores)])
  })
  it('seeds the case weather alongside the fuel', () => {
    expect(seedStart(DEFAULT_CONFIG, 'case1')).toMatchObject({
      tod: 'day',
      clouds: 'none',
    })
    expect(seedStart(DEFAULT_CONFIG, 'case2')).toMatchObject({
      tod: 'day',
      clouds: 'mid_stratus',
    }) // the cases must NOT share a deck: 500 ft is a Case III ceiling
    expect(seedStart(DEFAULT_CONFIG, 'case3')).toMatchObject({
      tod: 'night',
      clouds: 'low_stratus',
    })
  })
  it('leaves weather alone for the launch starts', () => {
    const night = { ...DEFAULT_CONFIG, tod: 'night' as const }
    expect(seedStart(night, 'air').tod).toBe('night')
  })
})

// The config's shipped-key invariants (#116). `hints` was read at five sites in
// the engine and shipped as a Settings switch while being absent from both the
// MissionConfig interface and DEFAULT_CONFIG. Nothing caught it: the interface
// carries a catch-all index signature, and engine.ts opens with @ts-nocheck.
describe('DEFAULT_CONFIG', () => {
  it('no longer carries the Distance LOD switch (#3): distance stages and spotting dots are the same for every player', () => {
    expect(DEFAULT_CONFIG).not.toHaveProperty('lod')
    expect(TAB_FIELDS.graphics).not.toContain('lod')
  })

  it('starts ready, on runway 06 into the trades (#133)', () => {
    expect(DEFAULT_CONFIG.cold).toBe(false)
    expect(DEFAULT_CONFIG.end).toBe('06')
  })

  it('declares hints, defaulted ON', () => {
    // A COMPILE-TIME assertion, and it needs to be: MissionConfig carries a
    // catch-all index signature, so DEFAULT_CONFIG type-checks whether or not
    // `hints` is declared, and vitest strips types rather than checking them.
    // This binding only compiles if the interface narrows hints to boolean --
    // `tsc -b`, which the build runs, is what enforces it.
    const declared: boolean = DEFAULT_CONFIG.hints
    expect(declared).toBe(true)

    // Every consumer tests `cfg.hints !== false`, so ON is what the undeclared
    // key already meant; the declaration must not quietly change it.
    expect(DEFAULT_CONFIG.hints).toBe(true)
  })

  it('holds no undefined value', () => {
    // An undefined default is not a harmless gap. Reset assigns it,
    // JSON.stringify drops the key, and config/save upserts only what arrives —
    // so the stored row keeps its old value while the UI shows the default.
    const dropped = Object.keys(DEFAULT_CONFIG).filter(
      (key) => (DEFAULT_CONFIG as Record<string, unknown>)[key] === undefined
    )
    expect(dropped).toEqual([])
    expect(
      Object.keys(JSON.parse(JSON.stringify(DEFAULT_CONFIG)))
    ).toHaveLength(Object.keys(DEFAULT_CONFIG).length)
  })

  it('has a default for every field a Settings tab can reset', () => {
    // This is the gate that would have caught #116 where it was introduced,
    // rather than at the far end of a save round-trip.
    const missing: string[] = []
    for (const [tab, fields] of Object.entries(TAB_FIELDS)) {
      for (const field of fields) {
        if ((DEFAULT_CONFIG as Record<string, unknown>)[field] === undefined)
          missing.push(`${tab}.${field}`)
      }
    }
    expect(missing).toEqual([])
  })
})

// An imported joystick profile is the one place arbitrary JSON reaches the
// stored bindings. It failed open: `typeof null === 'object'` passed the guard,
// spreading null is legal, and the player was told "Profile saved" while their
// button map was discarded (#120).
describe('profileBindings', () => {
  // The standard gamepad, NOT the generic joystick: the generic profile carries
  // a single default binding, so a partial-map assertion against it is vacuous -
  // it passes whether or not the merge happens.
  const defaults = deviceDefaults('pad', 'standard')

  it('refuses null maps that pass a typeof test', () => {
    expect(
      profileBindings({ air: 'joystick', axes: null, buttons: null }, defaults)
    ).toBeNull()
  })

  it('refuses arrays, which are also typeof object', () => {
    expect(
      profileBindings({ air: 'joystick', axes: [], buttons: [] }, defaults)
    ).toBeNull()
  })

  it('refuses anything that is not a joystick profile', () => {
    expect(profileBindings(null, defaults)).toBeNull()
    expect(profileBindings('a string', defaults)).toBeNull()
    expect(profileBindings({ axes: {}, buttons: {} }, defaults)).toBeNull()
    expect(
      profileBindings({ air: 'keyboard', axes: {}, buttons: {} }, defaults)
    ).toBeNull()
  })

  it('merges a partial button map over the defaults rather than replacing it', () => {
    // The reachable half: an export predating a binding carries no entry for
    // it. Adopting the map wholesale left that action unbound on a file that is
    // perfectly valid.
    expect(Object.keys(defaults.buttons).length).toBeGreaterThan(1) // or the loop below asserts nothing
    const bindings = profileBindings(
      { air: 'joystick', axes: {}, buttons: { fire: '9' } },
      defaults
    )
    expect(bindings?.buttons.fire).toBe('9')
    for (const action of Object.keys(defaults.buttons)) {
      if (action !== 'fire')
        expect(bindings?.buttons[action]).toBe(defaults.buttons[action])
    }
  })

  it('merges a partial axis map over the defaults, as it always did', () => {
    const bindings = profileBindings(
      { air: 'joystick', axes: { pitch: '4' }, buttons: {} },
      defaults
    )
    expect(bindings?.axes.pitch).toBe('4')
    expect(bindings?.axes.roll).toBe(defaults.axes.roll)
  })

  it('keeps every binding a full profile declares', () => {
    const axes = { ...defaults.axes, yaw: '5' }
    const buttons = { ...defaults.buttons, fire: '2' }
    expect(
      profileBindings({ air: 'joystick', axes, buttons }, defaults)
    ).toEqual({ axes, buttons })
  })

  // A hand-written profile says "pitch": 1. Imported unchecked, the number
  // reached the Joystick tab, whose startsWith and replace threw on every
  // render, on every device signed in to the account.
  it('reads a whole number as its binding, so the tab gets text', () => {
    const bindings = profileBindings(
      { air: 'joystick', axes: { pitch: 4, yaw: -2 }, buttons: { fire: 9 } },
      defaults
    )
    expect(bindings?.axes.pitch).toBe('4')
    expect(bindings?.axes.yaw).toBe('-2')
    expect(bindings?.buttons.fire).toBe('9')
  })

  it('leaves an action at its default where the file holds no binding for it', () => {
    const bindings = profileBindings(
      {
        air: 'joystick',
        axes: { pitch: '4', roll: null, yaw: 1.5, throttle: 'up', look: [3] },
        buttons: { fire: '2', gear: true, hook: '3,x' },
      },
      defaults
    )
    expect(bindings?.axes.pitch).toBe('4')
    for (const action of ['roll', 'yaw', 'throttle', 'look'])
      expect(bindings?.axes[action], action).toBe(defaults.axes[action])
    expect(bindings?.buttons.fire).toBe('2')
    for (const action of ['gear', 'hook'])
      expect(bindings?.buttons[action], action).toBe(defaults.buttons[action])
    for (const value of [
      ...Object.values(bindings!.axes),
      ...Object.values(bindings!.buttons),
    ])
      expect(typeof value).toBe('string')
  })

  it('refuses a file none of whose bindings can be read', () => {
    expect(
      profileBindings(
        { air: 'joystick', axes: { pitch: null }, buttons: { fire: {} } },
        defaults
      )
    ).toBeNull()
  })

  it('does not alias the defaults it merged over', () => {
    const bindings = profileBindings(
      { air: 'joystick', axes: {}, buttons: {} },
      defaults
    )
    bindings!.buttons.fire = 'edited'
    expect(deviceDefaults('generic').buttons.fire).not.toBe('edited')
  })
})

// #152: a binding the device cannot reach is dropped in silence at the read,
// so nothing downstream may hand one out or fail to flag one.
describe('profileFor and the standard remap', () => {
  const stick = 'Turtle Beach VelocityOne Flightstick (10f5:7013)'

  it('gives a raw-HID stick its own profile when the browser has not remapped it', () => {
    expect(profileFor(stick, '').name).toBe(
      'Turtle Beach VelocityOne Flightstick'
    )
  })

  // RESOLVED 2026-09-15: the raw map stands aside once the browser has
  // remapped the pad. Remapped it reports 4 axes / 17 buttons, and the
  // VelocityOne map's throttle (-5), speedbrake (-6), castle pair (8/9), look
  // pair (3/4) and TRIGGER (17 of 0..16) all point past the end - three
  // working axes and no way to shoot. The standard map is written against
  // that layout and flies and fires.
  it('stands the raw map aside once the browser reports the standard layout', () => {
    expect(profileFor(stick, 'standard').name).toBe('Standard gamepad')
  })

  it('hands out only indices a standard pad reports', () => {
    expect(unreachable(deviceDefaults(stick, 'standard'), 4, 17)).toBe('')
  })

  // What the raw map WOULD have cost on such a pad - the reason for the above.
  it('would have left the raw map unable to shoot', () => {
    const raw = deviceDefaults(stick, '') // the profile an unmapped pad gets
    expect(reaches(raw.buttons.fire, 17)).toBe(false) // fire = 17, indices 0..16
    expect(reaches(raw.axes.throttle, 4)).toBe(false) // throttle = -5
    expect(reaches(raw.axes.weapon, 4, true)).toBe(false) // castle pair = 8/9
    expect(reaches(raw.axes.pitch, 4)).toBe(true) // ...while the basics land
  })

  it('still names the generic profile for an unknown stick', () => {
    expect(profileFor('No Name Stick', '').name).toBe('Generic joystick')
  })
})

// #152: what the recording carries, so "was the stick healthy?" is a grep.
describe('unreachable', () => {
  const healthy = {
    axes: { pitch: '1', roll: '0', look: '3', weapon: '8' },
    buttons: { fire: '17', gear: '0' },
  }

  it('says nothing when the device reports everything bound', () => {
    expect(unreachable(healthy, 10, 24)).toBe('')
  })

  it('names what a standard remap cannot reach, sorted', () => {
    // 4 axes / 17 buttons: fire is index 17 of 0..16; weapon is the castle
    // pair at 8/9; and look is a pair too, at 3/4 - axis 4 does not exist on a
    // 4-axis pad, so the ministick's vertical half is gone. pitch and roll,
    // both single and low, still land.
    expect(unreachable(healthy, 4, 17)).toBe('fire,look,weapon')
  })

  it('counts a pair as needing both halves', () => {
    // 9 axes has index 8 but not 9, so the castle pair is short by one.
    expect(unreachable({ axes: { weapon: '8' }, buttons: {} }, 9, 24)).toBe(
      'weapon'
    )
    expect(unreachable({ axes: { weapon: '8' }, buttons: {} }, 10, 24)).toBe('')
  })

  it('ignores unbound actions', () => {
    expect(
      unreachable({ axes: { zoom: '', trim: '' }, buttons: { hook: '' } }, 0, 0)
    ).toBe('')
  })
})

describe('reaches', () => {
  it('passes an unbound action', () => {
    expect(reaches('', 0)).toBe(true)
  })
  it('counts the index, not the sense prefix', () => {
    expect(reaches('-5', 6)).toBe(true)
    expect(reaches('-5', 5)).toBe(false)
  })
  it('needs both halves of a pair', () => {
    expect(reaches('8', 10, true)).toBe(true)
    expect(reaches('8', 9, true)).toBe(false) // 9 has axis 8 but not 9
    expect(reaches('8', 9)).toBe(true) // ...which a single axis does not need
  })
  it('needs every index a multi-button binding lists', () => {
    expect(reaches('2,3', 4)).toBe(true)
    expect(reaches('2,17', 4)).toBe(false)
  })

  // The zoom thumbwheel's half-axis form (engine.ts): "N+" reads N AND N+1,
  // and the engine parses it with parseInt. Judging it with Number gives NaN,
  // which fell through the non-finite guard and called an unreachable binding
  // fine - silent in exactly the direction #152 exists to end.
  it('reads the half-axis wheel form as the engine does', () => {
    expect(reaches('5+', 7)).toBe(true) // 7 axes: 5 and 6 both present
    expect(reaches('5+', 6)).toBe(false) // 6 axes: 5 present, 6 is not
    expect(reaches('5+', 4)).toBe(false) // neither
  })
  it('keeps the sense prefix off the wheel index too', () => {
    expect(reaches('-5+', 7)).toBe(true)
    expect(reaches('-5+', 6)).toBe(false)
  })
  it('still treats a plain index as a single axis', () => {
    expect(reaches('5', 6)).toBe(true) // ...which "5+" would refuse
  })
})

// The Joystick tab reads its saved maps through bindings, so an account that
// already holds a number, or worse, renders rather than throwing.
describe('bindings', () => {
  it('keeps the forms the engine reads', () => {
    expect(
      bindings({
        a: '',
        b: '3',
        c: '-5',
        d: '5+',
        e: '-5+',
        f: '2,17',
        g: ' 2, 17 ',
      })
    ).toEqual({
      a: '',
      b: '3',
      c: '-5',
      d: '5+',
      e: '-5+',
      f: '2,17',
      g: '2,17',
    })
  })

  it('is how the Joystick tab reads a stick it has saved', () => {
    const settings = readFileSync(
      fileURLToPath(
        new URL('../components/SettingsDialog.tsx', import.meta.url)
      ),
      'utf8'
    )
    expect(settings).toMatch(/\.\.\.bindings\(saved\?\.axes\)/)
    expect(settings).toMatch(/= bindings\(saved\?\.buttons\)/)
  })

  it('drops what is not a binding', () => {
    expect(
      bindings({
        a: null,
        b: true,
        c: 1.5,
        d: 'pitch',
        e: '3,',
        f: {},
        g: [1],
        h: '--3',
      })
    ).toEqual({})
    expect(bindings(null)).toEqual({})
    expect(bindings([1, 2])).toEqual({})
  })
})

// The default keys put two controls on Enter and two on Space on purpose
// (keys.test.ts pins which). A rebind took the chord from every other control
// holding it, so putting Acquire target back on Enter after moving it away
// left the catapult's Launch unbound, and Fire weapon back on Space left a
// replay's Pause unbound.
describe('rebind', () => {
  it('names exactly the pairs the defaults share', () => {
    const byChord = new Map<string, string[]>()
    for (const [action, chord] of Object.entries(KEY_DEFAULTS))
      if (chord !== 'None')
        byChord.set(chord, [...(byChord.get(chord) ?? []), action])
    const shared = [...byChord.values()]
      .filter((actions) => actions.length > 1)
      .map((actions) => actions.sort().join('/'))
      .sort()
    expect(SHARED.map((pair) => [...pair].sort().join('/')).sort()).toEqual(
      shared
    )
  })

  it("leaves a control's partner on the chord they share", () => {
    const away = rebind({}, 'acquire', 'KeyQ').keys
    const back = rebind(away, 'acquire', 'Enter')
    expect(back.keys.launch ?? KEY_DEFAULTS.launch).toBe('Enter')
    expect(back.keys.acquire ?? KEY_DEFAULTS.acquire).toBe('Enter')
    expect(back.taken).toEqual([])

    const fire = rebind(rebind({}, 'fire', 'KeyK').keys, 'fire', 'Space')
    expect(fire.keys.pause ?? KEY_DEFAULTS.pause).toBe('Space')
    expect(fire.taken).not.toContain('pause')
  })

  it('takes the chord from any other control, and says so', () => {
    const moved = rebind({}, 'gear', 'KeyH')
    expect(moved.keys.gear).toBe('KeyH')
    expect(moved.keys.hook).toBe('None')
    expect(moved.taken).toEqual(['hook'])
  })

  it('names every control it unbinds, both of a pair included', () => {
    const moved = rebind({}, 'hook', 'Space')
    expect(moved.keys.fire).toBe('None')
    expect(moved.keys.pause).toBe('None')
    expect([...moved.taken].sort()).toEqual(['fire', 'pause'])
  })

  it('is what the Keys tab does with a captured chord, naming all it took', () => {
    const settings = readFileSync(
      fileURLToPath(
        new URL('../components/SettingsDialog.tsx', import.meta.url)
      ),
      'utf8'
    )
    expect(settings).toMatch(/= rebind\(overrides, arming, chord\)/)
    expect(settings).toMatch(/\{ from: next\.taken, chord \}/)
    expect(settings).toMatch(/formatList\(named\.map\(/)
  })

  it('clears an override that puts a control back on its default', () => {
    expect(rebind({ gear: 'KeyQ' }, 'gear', 'KeyG').keys).not.toHaveProperty(
      'gear'
    )
  })
})
