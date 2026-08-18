// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { describe, it, expect } from 'vitest'
import { loadOutcome, PendingConfig, RETIRED, stripRetired } from './config-persist'
import type { MissionConfig } from './config'

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
    // The regression: removing the slider left the SAVED value in place, and two
    // engine reads (the multiplayer control sample, the nosewheel pedal) went on
    // scaling by it — so an account that had ever moved it flew at reduced
    // authority against other people, with no setting left to correct it.
    expect(stripRetired({ fuel: 6000, sens: 0.6 })).toEqual({ fuel: 6000 })
  })

  it('drops the retired missiles boolean the per-station loadout replaced', () => {
    expect(stripRetired({ fuel: 6000, missiles: false })).toEqual({ fuel: 6000 })
  })

  it('leaves a config that carries no retired key untouched', () => {
    expect(stripRetired({ fuel: 6000, callsign: 'Hornet' })).toEqual({ fuel: 6000, callsign: 'Hornet' })
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
