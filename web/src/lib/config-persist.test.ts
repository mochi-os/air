// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { describe, it, expect } from 'vitest'
import { migrate, normalize } from '../game/stores'
import { DEFAULT_CONFIG, type MissionConfig } from './config'
import {
  absorb,
  loadOutcome,
  merged,
  PendingConfig,
  RETIRED,
  stripRetired,
} from './config-persist'

// Minimal stand-ins; PendingConfig only stores/returns the reference.
const cfg = (fuel: number) => ({ fuel }) as unknown as MissionConfig

describe('loadOutcome', () => {
  it('flushes an edit made during load — it is persisted, never discarded', () => {
    // The regression: an edit during a slow load whose debounced save was
    // dropped (identity not yet known) must be saved at load completion.
    expect(loadOutcome(true, null)).toBe('flush')
    expect(loadOutcome(true, { fuel: 6000 })).toBe('flush')
  })

  it('applies the stored config when the user has not edited and one exists', () => {
    expect(loadOutcome(false, { fuel: 6000 })).toBe('apply')
  })

  it('seeds the server on a fresh account with no edit and no stored config', () => {
    expect(loadOutcome(false, null)).toBe('seed')
  })
})

describe('PendingConfig', () => {
  it('reflects the latest edit synchronously — before any render sync (the load-race fix)', () => {
    const a = cfg(1)
    const b = cfg(2)
    const pending = new PendingConfig(a)
    expect(pending.dirty).toBe(false)
    expect(pending.current()).toBe(a)
    // The player edits. config/load could resolve on the very next microtask,
    // before React commits the render that would sync() the new value — the
    // flush must read b, not the stale a.
    pending.edit(b)
    expect(pending.dirty).toBe(true)
    expect(pending.current()).toBe(b)
  })

  it('mirrors external state via sync until the user edits, then holds the edit', () => {
    const a = cfg(1)
    const b = cfg(2)
    const c = cfg(3)
    const pending = new PendingConfig(a)
    pending.sync(b) // a render delivered new component state
    expect(pending.current()).toBe(b)
    pending.edit(c)
    pending.sync(a) // a later/stale render must not clobber the user's edit
    expect(pending.current()).toBe(c)
    expect(pending.dirty).toBe(true)
  })
})

describe('stripRetired', () => {
  it('drops the retired Sensitivity value a legacy account still carries', () => {
    expect(stripRetired({ fuel: 6000, sens: 0.6 })).toEqual({ fuel: 6000 })
  })

  it('drops the retired missiles boolean the per-station loadout replaced', () => {
    expect(stripRetired({ fuel: 6000, missiles: false })).toEqual({
      fuel: 6000,
    })
  })

  it('leaves a config that carries no retired key untouched', () => {
    expect(stripRetired({ fuel: 6000, callsign: 'Hornet' })).toEqual({
      fuel: 6000,
      callsign: 'Hornet',
    })
  })

  it('copies rather than mutates, so the caller can still read what it strips', () => {
    // loadConfig reads `missiles` to migrate the loadout AFTER stripping; a
    // mutating strip would pull that value out from under it.
    const saved = { fuel: 6000, missiles: false, sens: 0.6 }
    stripRetired(saved)
    expect(saved.missiles).toBe(false)
    expect(saved.sens).toBe(0.6)
  })

  it('names every retired key in one place', () => {
    expect([...RETIRED]).toEqual(['missiles', 'sens'])
  })
})

// The keys an early edit touched, and what a flush makes of them (#41): a
// server deep link enters the server as the page mounts, an edit made on the
// defaults because the saved config has not come back yet. Flushing the
// in-memory config wholesale put the defaults over every saved setting; the
// flush now lays only the edited keys onto what the server had.
describe('the partial a flush applies', () => {
  const saved: Partial<MissionConfig> = {
    callsign: 'Little Nellie',
    tod: 'night',
    clouds: 'cumulus',
    fuel: 6000,
  }

  it('records only the keys an edit changed, accumulates across edits, and settle spends them', () => {
    const pending = new PendingConfig(DEFAULT_CONFIG)
    expect(pending.partial()).toEqual({})
    pending.edit({ ...DEFAULT_CONFIG, servers: '127.0.0.1:4433', pilot: 'p1' })
    expect(pending.partial()).toEqual({
      servers: '127.0.0.1:4433',
      pilot: 'p1',
    })
    pending.edit({ ...pending.current(), tod: 'night' })
    expect(pending.partial()).toEqual({
      servers: '127.0.0.1:4433',
      pilot: 'p1',
      tod: 'night',
    })
    const whole = merged(saved, pending.partial())
    pending.settle(whole)
    expect(pending.partial()).toEqual({})
    expect(pending.dirty).toBe(false)
    expect(pending.current()).toBe(whole)
    pending.sync(DEFAULT_CONFIG) // settled: renders may sync again
    expect(pending.current()).toBe(DEFAULT_CONFIG)
  })

  it('lays the edit onto the saved config, keeping every saved key the edit did not touch', () => {
    const whole = merged(saved, { servers: '127.0.0.1:4433', pilot: 'p1' })
    expect(whole.callsign).toBe('Little Nellie')
    expect(whole.tod).toBe('night')
    expect(whole.clouds).toBe('cumulus')
    expect(whole.fuel).toBe(6000)
    expect(whole.servers).toBe('127.0.0.1:4433')
    expect(whole.pilot).toBe('p1')
    expect(whole.start).toBe(DEFAULT_CONFIG.start) // a key nobody set: the default under it
    expect(merged(null, { servers: 's' })).toEqual({
      ...DEFAULT_CONFIG,
      servers: 's',
    }) // a fresh account: the defaults plus the edit
  })

  it('does not carry the defaults an early edit was made on over the saved config', () => {
    const pending = new PendingConfig(DEFAULT_CONFIG) // a fresh page: nothing loaded yet
    pending.edit({ ...DEFAULT_CONFIG, servers: '127.0.0.1:4433', pilot: 'p1' }) // the deep link entering the server
    expect(pending.current().callsign).toBe('') // what a wholesale flush would have saved
    expect(merged(saved, pending.partial()).callsign).toBe('Little Nellie')
    expect(merged(saved, pending.partial()).tod).toBe('night')
  })

  it('reads a saved config with the retired keys gone and the stores migrated, the same way apply does', () => {
    const whole = absorb({
      fuel: 6000,
      sens: 0.6,
      missiles: false,
    } as unknown as Partial<MissionConfig>)
    expect('sens' in whole).toBe(false)
    expect('missiles' in whole).toBe(false)
    expect(whole.fuel).toBe(6000)
    expect(whole.stores).toEqual(normalize(migrate(false)))
    expect(absorb({ callsign: 'x' }).stores).toEqual(normalize(migrate(true)))
  })
})
