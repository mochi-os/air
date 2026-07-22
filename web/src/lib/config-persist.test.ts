// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

/* eslint-disable lingui/no-unlocalized-strings -- vitest describe/it names are not user-facing */
import { describe, it, expect } from 'vitest'
import { loadOutcome, PendingConfig } from './config-persist'
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
