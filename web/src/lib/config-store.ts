// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { useCallback, useEffect, useRef, useState } from 'react'
import { createAppClient, useAuthStore, useShellStorage } from '@mochi/web'
import { DEFAULT_CONFIG, type MissionConfig } from './config'
import { loadOutcome, PendingConfig, stripRetired } from './config-persist'
import { migrate, normalize } from '../game/stores'

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

// The identity the loaded config belongs to, echoed back with every save; the
// server requires it to match the session, so a save after an in-place account
// switch is refused. Empty until config/load resolves, and saveConfig defers
// while empty.
let config_identity = ''

// The signed-in identity's display name (from config/load) — the default
// multiplayer callsign. Empty until loaded / for anonymous visitors.
let identity_name = ''

const identity_waiters: ((name: string) => void)[] = []
// resolve_identity asks CORE for the signed-in name. config/load carries it
// too, but only for callers holding an app token, and the callsign default
// wants it before that: /_/identity needs just the session cookie.
let identity_asked = false
function resolve_identity(): void {
  if (identity_asked || identity_name) return
  identity_asked = true
  // Through the APP CLIENT, not a bare fetch: inside the menu shell's sandboxed
  // iframe the origin is opaque, so credentials:'same-origin' sends no cookies
  // and /_/identity answers 401 — it only appeared to work in a bare-app
  // harness. The client carries the shell's token, which core accepts.
  authenticated()
    .then(() =>
      client.get<{ identity?: { name?: string } }>('/_/identity', { baseURL: '/' })
    ) // same race as loadConfig: fired before the shell's token lands, this went out bare and the callsign default stayed blank
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

// Wait for the auth store to finish initializing before any request fired from
// a route's first effect. The shell delivers the app token by postMessage AFTER
// mount, so such a load goes out bare and 401s - for config/load that silently
// dropped every save for the rest of the session; for match/list it rendered a
// full logbook as "No flights yet".
export function authenticated(): Promise<void> {
  return new Promise((resolve) => {
    if (useAuthStore.getState().isInitialized) return resolve()
    const stop = useAuthStore.subscribe((state) => {
      if (state.isInitialized) {
        stop()
        resolve()
      }
    })
  })
}

// Load the signed-in user's saved settings from the app database. Returns the
// stored keys, or null when nothing is saved yet (anonymous, or a fresh account)
// so the caller can seed the server from its current state.
export async function loadConfig(): Promise<Partial<MissionConfig> | null> {
  try {
    await authenticated()
    const res = await client.get<ConfigPayload | { data: ConfigPayload }>(
      '-/config/load'
    )
    const payload = unwrap<ConfigPayload>(res)
    config_identity = payload?.identity ?? ''
    if (payload?.name) {
      identity_name = payload.name
      for (const waiter of identity_waiters.splice(0)) waiter(identity_name)
    }
    const config = payload?.config ?? {}
    return Object.keys(config).length ? config : null
  } catch {
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
    await client.post('-/config/save', {
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
  // pending carries the latest edited config with its dirty flag, updated
  // synchronously in the edit path (see PendingConfig): an edit made while
  // config/load is in flight is newer than the server's value and must survive
  // the late load and be flushed.
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
        // The player edited while loading: keep their change and persist it now
        // the identity is known. pending.current() is the latest edit even if
        // React has not committed the render; cancel any pending timer so this
        // is not a duplicate.
        if (saveTimer.current) clearTimeout(saveTimer.current)
        void saveConfig(pending.current())
      } else if (outcome === 'apply' && saved) {
        // Legacy saves carry the retired missiles boolean and no stores map:
        // migrate to the matching preset (#17). Any saved stores map is
        // normalized so a stale or hand-edited shape cannot reach the engine.
        const legacy = saved as MissionConfig & { missiles?: boolean }
        // Read `missiles` BEFORE stripping — it still decides which preset a
        // pre-#17 save migrates to; stripRetired copies, so it survives here.
        const stores = normalize(legacy.stores ?? migrate(legacy.missiles !== false))
        // Every retired key goes, not just this one. A setting deleted from the
        // menu leaves its saved VALUE behind, and `sens` proved what that costs.
        setStored({ ...DEFAULT_CONFIG, ...stripRetired(legacy), stores } as MissionConfig)
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
