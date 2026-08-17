// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The load-completion decision for the mission config, isolated from the React
// hook (and @mochi/web) so it is unit testable. When config/load resolves:
//   - the player edited while it was in flight -> FLUSH: persist their edit and
//     keep it (a debounced save that fired before the identity was known was
//     dropped, so this is the point that actually saves it — never discard it)
//   - the server returned a saved config       -> APPLY it
//   - nothing was saved yet                     -> SEED the server from local
import type { MissionConfig } from './config'

export type LoadOutcome = 'flush' | 'apply' | 'seed'

export function loadOutcome(
  dirty: boolean,
  saved: Partial<MissionConfig> | null
): LoadOutcome {
  if (dirty) return 'flush'
  return saved ? 'apply' : 'seed'
}

// Settings that no longer exist, but whose saved VALUES still arrive from the
// server: the config store is per account and keeps every key ever written, so
// deleting a control from the menu does not delete what a player last set with
// it. `missiles` became the per-station loadout (#17). `sens` was the
// Sensitivity slider, removed once it was understood to be a flight-control
// gain rather than a mouse-look gain — and two engine reads outlived it, so an
// account that had ever moved that slider went on flying at reduced authority
// in multiplayer with no setting left anywhere to put it back.
//
// Retiring a setting therefore means three things, not one: delete the control,
// delete the reads, and add the key here so the stored value stops travelling.
export const RETIRED = ['missiles', 'sens'] as const

// stripRetired returns the saved config without any retired key. It copies
// rather than mutating: the caller reads `missiles` to migrate the loadout, and
// a mutating strip would pull that value out from under it.
export function stripRetired<T extends Record<string, unknown>>(saved: T): T {
  const out = { ...saved }
  for (const key of RETIRED) delete out[key]
  return out
}

// PendingConfig bundles the latest edited config and the dirty flag as one unit
// so an edit updates BOTH synchronously. The React ref mirroring component state
// is only refreshed on render, so a config/load that resolves between an edit
// and React committing that render would flush a stale value; recording the edit
// here in the edit path (not on render) makes the flush independent of React
// scheduling. Isolated so the invariant is unit testable without React.
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
