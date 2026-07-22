// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { useCallback, useEffect, useRef, useState } from 'react'
import { createAppClient, useShellStorage } from '@mochi/web'
import { DEFAULT_CONFIG, type MissionConfig } from './config'
import { loadOutcome } from './config-persist'

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
const identity_waiters: ((name: string) => void)[] = []
// useIdentityName re-renders when the name arrives from config/load, which
// may complete after mount (and, when the account has no saved config, with
// no config change to piggyback a re-render on).
export function useIdentityName(): string {
  const [name, setName] = useState(identity_name)
  useEffect(() => {
    if (identity_name) {
      setName(identity_name)
      return
    }
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
  const configRef = useRef(config)
  configRef.current = config
  // dirty guards the async config load: the setup menu is interactive while the
  // load is in flight (slow or replicated servers especially), so if the player
  // changes a setting before the response lands, that edit is NEWER than the
  // server's stored value and the late load must not overwrite it.
  const dirty = useRef(false)
  // The debounce timer lives INSIDE the hook, not module-global: a global timer
  // survived unmount and was shared by every hook instance, so a pending save
  // could fire after navigation or an in-place account change and write stale
  // config under the then-current auth context. Cancelled on unmount.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    loadConfig().then((saved) => {
      const outcome = loadOutcome(dirty.current, saved)
      if (outcome === 'flush') {
        // The player edited while loading: keep their change (don't overwrite it
        // with the server's older value) AND persist it. A debounced save that
        // fired before config/load established the identity was dropped, so this
        // is the point that actually saves the edit — the identity is known now.
        // Cancel any still-pending timer so it isn't a duplicate save.
        if (saveTimer.current) clearTimeout(saveTimer.current)
        void saveConfig(configRef.current)
      } else if (outcome === 'apply' && saved) {
        setStored({ ...DEFAULT_CONFIG, ...saved } as MissionConfig)
      } else {
        void saveConfig(configRef.current) // first run on this account — seed the server
      }
    })
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setConfig = useCallback(
    (next: MissionConfig) => {
      dirty.current = true
      setStored(next)
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => void saveConfig(next), SAVE_DELAY) // captures this exact config snapshot
    },
    [setStored]
  )

  return [config, setConfig]
}
