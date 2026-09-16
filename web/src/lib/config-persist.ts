// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
// The load-completion decision for the mission config, isolated from the React
// hook so it is unit testable. On config/load: an edit made while it was in
// flight -> FLUSH (apply it onto the saved config and persist that), a saved
// config -> APPLY, nothing saved -> SEED the server from local.
import { migrate, normalize } from '../game/stores'
import { DEFAULT_CONFIG, type MissionConfig } from './config'

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

// absorb turns what config/load returned into a whole config: the defaults
// under it, every retired key gone, the stores map normalized (a legacy save
// carries the retired missiles boolean and no stores map, and migrates to the
// matching preset, #17). Read `missiles` BEFORE stripping: it still decides the
// preset, and stripRetired copies, so it survives here.
export function absorb(saved: Partial<MissionConfig>): MissionConfig {
  const legacy = saved as Partial<MissionConfig> & { missiles?: boolean }
  const stores = normalize(legacy.stores ?? migrate(legacy.missiles !== false))
  const kept = stripRetired(legacy) as Partial<MissionConfig>
  return { ...DEFAULT_CONFIG, ...kept, stores } as MissionConfig
}

// merged is what a flush persists: the saved config (or the defaults, on a
// fresh account) with the keys edited while it was loading laid on top. Never
// the in-memory config wholesale - on a fresh or top-window load that is the
// defaults, and saving it clobbered every setting the account had (#41: a
// server deep link entered the server at boot, and the callsign, the weather
// and everything else went back to their defaults on every visit).
export function merged(
  saved: Partial<MissionConfig> | null,
  partial: Partial<MissionConfig>
): MissionConfig {
  return {
    ...(saved ? absorb(saved) : DEFAULT_CONFIG),
    ...partial,
  } as MissionConfig
}

// PendingConfig bundles the latest edited config, the keys those edits touched
// and the dirty flag so an edit updates ALL of them synchronously. A React ref
// only refreshes on render, so a config/load resolving between an edit and its
// commit would flush a stale value; and the keys are what a flush applies onto
// the saved config, since the in-memory config an early edit was made on may
// be nothing but the defaults.
export class PendingConfig {
  private value: MissionConfig
  private edits: Partial<MissionConfig> = {}
  dirty = false

  constructor(initial: MissionConfig) {
    this.value = initial
  }

  // edit records a user change; current() reflects it immediately, before the
  // render that would otherwise sync it. The keys whose value changed are
  // kept as the partial a flush applies.
  edit(next: MissionConfig): void {
    for (const key of Object.keys(next) as (keyof MissionConfig)[]) {
      if (next[key] !== this.value[key])
        (this.edits as Record<string, unknown>)[key] = next[key]
    }
    this.dirty = true
    this.value = next
  }

  // partial is what the edits since the last settle changed.
  partial(): Partial<MissionConfig> {
    return { ...this.edits }
  }

  // settle adopts the config a load merged the edits into: the edits are
  // spent, and the next sync may follow renders again.
  settle(value: MissionConfig): void {
    this.value = value
    this.edits = {}
    this.dirty = false
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
