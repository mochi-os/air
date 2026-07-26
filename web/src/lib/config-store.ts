// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { useCallback, useEffect, useRef, useState } from 'react'
import { createAppClient, useShellStorage } from '@mochi/web'
import { DEFAULT_CONFIG, type MissionConfig } from './config'
import { loadOutcome, PendingConfig } from './config-persist'

const client = createAppClient({ appName: 'air' })

const unwrap = <T>(raw: unknown): T =>
  raw && typeof raw === 'object' && 'data' in raw
    ? (raw as { data: T }).data
    : (raw as T)

type ConfigPayload = {
  config?: Partial<MissionConfig>
  name?: string
  identity?: string
}

// The identity the loaded config belongs to, echoed back with every save. The
// server requires it to match the session, so a debounced save that fires after
// an in-place account switch (the shell delivers init once and stops listening,
// so this hook need not remount) is refused rather than landing the previous
// account's edit in the new account's config. Empty until config/load resolves;
// saveConfig defers while empty so no unattributed save is ever sent.
let config_identity = ''

// The signed-in identity's display name (from config/load) — the default
// multiplayer callsign. Empty until loaded / for anonymous visitors.
let identity_name = ''

// configLoaded reports whether config/load has answered. Menu code that seeds a
// value must wait for it: a write before the load lands persists a
// defaults-shaped config over the saved one (the PendingConfig hazard below).
let config_loaded = false
export function configLoaded(): boolean {
	return config_loaded
}
const identity_waiters: ((name: string) => void)[] = []
// useIdentityName re-renders when the name arrives from config/load, which
// may complete after mount (and, when the account has no saved config, with
// no config change to piggyback a re-render on).
// resolve_identity asks CORE for the signed-in name. config/load carries it
// too, but only for callers holding an app token — and the name is wanted
// before and outside that (the callsign default). /_/identity needs just the
// session cookie, so it answers wherever the app is signed in at all.
let identity_asked = false
function resolve_identity(): void {
  if (identity_asked || identity_name) return
  identity_asked = true
  // Through the APP CLIENT, not a bare fetch: inside the menu shell's sandboxed
  // iframe the origin is opaque, so credentials:'same-origin' sends no cookies
  // and /_/identity answers 401 — it only appeared to work in a bare-app
  // harness. The client carries the shell's token, which core accepts.
  client
    .get<{ identity?: { name?: string } }>('/_/identity', { baseURL: '/' })
    .then((res) => unwrap<{ identity?: { name?: string } }>(res)) // the client may hand back the body or {data}: unwrap knows both, as loadConfig does
    .then((body) => {
      const name = body?.identity?.name
      if (!name || identity_name) return
      identity_name = name
      for (const waiter of identity_waiters.splice(0)) waiter(identity_name)
    })
    .catch(() => {}) // best effort: the field simply stays empty
}

export function useIdentityName(): string {
  const [name, setName] = useState(identity_name)
  useEffect(() => {
    if (identity_name) {
      setName(identity_name)
      return
    }
    resolve_identity()
    identity_waiters.push(setName)
    return () => {
      const at = identity_waiters.indexOf(setName)
      if (at >= 0) identity_waiters.splice(at, 1)
    }
  }, [])
  return name
}

// Load the signed-in user's saved settings from the app database. Returns the
// stored keys, or null when nothing is saved yet (anonymous, or a fresh account)
// so the caller can seed the server from its current state.
export async function loadConfig(): Promise<Partial<MissionConfig> | null> {
  try {
    const res = await client.get<ConfigPayload | { data: ConfigPayload }>(
      '/-/config/load'
    )
    const payload = unwrap<ConfigPayload>(res)
    config_identity = payload?.identity ?? ''
    config_loaded = true
    if (payload?.name) {
      identity_name = payload.name
      for (const waiter of identity_waiters.splice(0)) waiter(identity_name)
    }
    const config = payload?.config ?? {}
    // The callsign DEFAULTS to the identity name (#77). Seeded here, inside the
    // load, rather than from a component effect: the menu surface that shows
    // the field is a dialog, so an effect only ran if the player happened to
    // open it, and any earlier write raced the load. Here it is unmissable and
    // cannot race — the value simply arrives already filled in.
    if (!config.callsign && payload?.name) config.callsign = payload.name
    return Object.keys(config).length ? config : null
  } catch {
    config_loaded = true // a FAILED load still settles the question: seeding may proceed against defaults rather than waiting forever
    return null
  }
}

// Persist the whole config; the server upserts each key. Best-effort.
export async function saveConfig(config: MissionConfig): Promise<void> {
  // Defer until config/load has established the owning identity: the server
  // requires a matching identity, and a save fired before it is known (or for an
  // anonymous visitor) can't be safely attributed, so don't send one.
  if (!config_identity) return
  try {
    // identity is the account the config was loaded under; the server drops the
    // save if the session identity has since changed (in-place account switch).
    await client.post('/-/config/save', {
      config: JSON.stringify(config),
      identity: config_identity,
    })
  } catch {
    /* best-effort — the in-memory config still applies this session */
  }
}

const SAVE_DELAY = 600

// Mission/graphics config backed by the Mochi app database (the cross-device
// source of truth), with shell storage as a local cache so the menu renders the
// last-known settings instantly rather than flashing defaults while the server
// responds. Saves are debounced so dragging a slider doesn't spam the server.
export function useMissionConfig(): [
  MissionConfig,
  (config: MissionConfig) => void,
] {
  const [config, setStored] = useShellStorage<MissionConfig>(
    'air.config',
    DEFAULT_CONFIG
  )
  // pending bundles the latest edited config with the dirty flag, updated
  // synchronously in the edit path (see PendingConfig): the setup menu is
  // interactive while config/load is in flight, so an edit during the load is
  // NEWER than the server's value and must (a) not be overwritten by the late
  // load and (b) be the value flushed to the server — independent of when React
  // commits the render that syncs component state (configRef only updated then).
  const pendingRef = useRef<PendingConfig | null>(null)
  pendingRef.current ??= new PendingConfig(config)
  const pending = pendingRef.current
  pending.sync(config)
  // The debounce timer lives INSIDE the hook, not module-global: a global timer
  // survived unmount and was shared by every hook instance, so a pending save
  // could fire after navigation or an in-place account change and write stale
  // config under the then-current auth context. Cancelled on unmount.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    loadConfig().then((saved) => {
      const outcome = loadOutcome(pending.dirty, saved)
      if (outcome === 'flush') {
        // The player edited while loading: keep their change (don't overwrite it
        // with the server's older value) AND persist it. A debounced save that
        // fired before config/load established the identity was dropped, so this
        // is the point that actually saves the edit — the identity is known now.
        // pending.current() is the latest edit even if React has not yet
        // committed the render. Cancel any pending timer so it isn't a duplicate.
        if (saveTimer.current) clearTimeout(saveTimer.current)
        void saveConfig(pending.current())
      } else if (outcome === 'apply' && saved) {
        setStored({ ...DEFAULT_CONFIG, ...saved } as MissionConfig)
      } else {
        void saveConfig(pending.current()) // first run on this account — seed the server
      }
    })
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setConfig = useCallback(
    (next: MissionConfig) => {
      pending.edit(next) // records the edit AND the value synchronously
      setStored(next)
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => void saveConfig(next), SAVE_DELAY) // captures this exact config snapshot
    },
    [setStored, pending] // pending is a stable ref object; listed to satisfy exhaustive-deps
  )

  return [config, setConfig]
}
