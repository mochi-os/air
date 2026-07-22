// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { useCallback, useEffect, useRef, useState } from 'react'
import { createAppClient, useShellStorage } from '@mochi/web'
import { DEFAULT_CONFIG, type MissionConfig } from './config'

const client = createAppClient({ appName: 'air' })

const unwrap = <T>(raw: unknown): T =>
  raw && typeof raw === 'object' && 'data' in raw
    ? (raw as { data: T }).data
    : (raw as T)

type ConfigPayload = { config?: Partial<MissionConfig>; name?: string }

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
  try {
    await client.post('/-/config/save', { config: JSON.stringify(config) })
  } catch {
    /* best-effort — the in-memory config still applies this session */
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
function saveConfigDebounced(config: MissionConfig, delay = 600) {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void saveConfig(config), delay)
}

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

  useEffect(() => {
    loadConfig().then((saved) => {
      if (dirty.current) return // the player edited while loading; keep their change
      if (saved) setStored({ ...DEFAULT_CONFIG, ...saved } as MissionConfig)
      else void saveConfig(configRef.current) // first run on this account — seed the server
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setConfig = useCallback(
    (next: MissionConfig) => {
      dirty.current = true
      setStored(next)
      saveConfigDebounced(next)
    },
    [setStored]
  )

  return [config, setConfig]
}
