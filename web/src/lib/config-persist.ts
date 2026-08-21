// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The load-completion decision for the mission config, isolated from the React
// hook so it is unit testable. On config/load: an edit made while it was in
// flight -> FLUSH (persist and keep it), a saved config -> APPLY, nothing saved
// -> SEED the server from local.
import type { MissionConfig } from './config'

export type LoadOutcome = 'flush' | 'apply' | 'seed'

export function loadOutcome(
  dirty: boolean,
  saved: Partial<MissionConfig> | null
): LoadOutcome {
  if (dirty) return 'flush'
  return saved ? 'apply' : 'seed'
}

// Settings that no longer exist but whose saved VALUES still arrive: the
// per-account config keeps every key ever written. Retiring a setting means
// three things - delete the control, delete the reads, and add the key here so
// the stored value stops travelling.
export const RETIRED = ['missiles', 'sens'] as const

// stripRetired returns the saved config without any retired key. It copies
// rather than mutating: the caller reads `missiles` to migrate the loadout, and
// a mutating strip would pull that value out from under it.
export function stripRetired<T extends Record<string, unknown>>(saved: T): T {
  const out = { ...saved }
  for (const key of RETIRED) delete out[key]
  return out
}

// PendingConfig bundles the latest edited config and the dirty flag so an edit
// updates BOTH synchronously. A React ref only refreshes on render, so a
// config/load resolving between an edit and its commit would flush a stale
// value.
export class PendingConfig {
  private value: MissionConfig
  dirty = false

  constructor(initial: MissionConfig) {
    this.value = initial
  }

  // edit records a user change; current() reflects it immediately, before the
  // render that would otherwise sync it.
  edit(next: MissionConfig): void {
    this.dirty = true
    this.value = next
  }

  // sync mirrors external/component state (a render). Once the user has edited,
  // their pending value is authoritative, so a later render can't clobber it.
  sync(value: MissionConfig): void {
    if (!this.dirty) this.value = value
  }

  current(): MissionConfig {
    return this.value
  }
}
