// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createAppClient,
  isHttpError,
  isInShell,
  useAuthStore,
  useShellStorage,
} from '@mochi/web'
import { DEFAULT_CONFIG, type MissionConfig } from './config'
import {
  type Answer,
  anonymous,
  ask,
  PendingConfig,
  Saver,
} from './config-persist'

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
      client.get<{ identity?: { name?: string } }>('/_/identity', {
        baseURL: '/',
      })
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

// Load the signed-in user's saved settings from the app database: whether
// the load named the account, and its stored keys, null when nothing is saved
// yet (a fresh account, which the caller seeds from its current state). A
// failed load is an answer only when it says no one is signed in; any other
// failure is null, and ask asks again.
async function loadConfig(): Promise<Answer | null> {
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
    return {
      signed: !!config_identity,
      saved: Object.keys(config).length ? config : null,
    }
  } catch (problem) {
    const status = isHttpError(problem) ? problem.response?.status : undefined
    return anonymous(status, useAuthStore.getState().token, isInShell())
      ? { signed: false, saved: null }
      : null
  }
}

// Persist the keys given; the server upserts each. Answers whether it took
// them. Best-effort: the in-memory config still applies this session.
async function saveConfig(
  config: Partial<MissionConfig>,
  keepalive: boolean
): Promise<boolean> {
  // Defer until config/load has established the owning identity: the server
  // requires a matching identity, and a save fired before it is known (or for an
  // anonymous visitor) can't be safely attributed, so don't send one.
  if (!config_identity) return false
  try {
    // identity is the account the config was loaded under; the server drops the
    // save if the session identity has since changed (in-place account switch).
    await client.post(
      '-/config/save',
      { config: JSON.stringify(config), identity: config_identity },
      { keepalive }
    )
    return true
  } catch {
    return false
  }
}

// Mission/graphics config backed by the Mochi app database (the cross-device
// source of truth), with shell storage as a local cache so the menu renders the
// last-known settings instantly rather than flashing defaults while the server
// responds. Saver debounces the saves, and flushes them when the page hides or
// the hook unmounts.
// The third value is whether config/load has answered: until then the cache
// may be stale or another account's, so nothing that writes what this player
// has saved (the pilot secret, the recent servers) may act on it. An anonymous
// load settles it too, keeping the cache; a failed one is asked again, and
// leaves it unsettled until an answer comes.
export function useMissionConfig(): [
  MissionConfig,
  (config: MissionConfig) => void,
  boolean,
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
  // The saver lives INSIDE the hook, not module-global: a global timer survived
  // unmount and was shared by every hook instance, so a pending save could fire
  // after navigation or an in-place account change and write stale config
  // under the then-current auth context. It flushes on unmount instead.
  const saverRef = useRef<Saver | null>(null)
  saverRef.current ??= new Saver(pending, saveConfig)
  const saver = saverRef.current
  const [settled, setSettled] = useState(false)

  useEffect(() => {
    let stopped = false
    void ask(loadConfig, () => stopped).then((answer) => {
      if (!answer) return
      const whole = saver.load(answer)
      if (whole) setStored(whole)
      setSettled(true)
    })
    const detach = saver.attach(window, document)
    return () => {
      stopped = true
      detach()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setConfig = useCallback(
    (next: MissionConfig) => {
      saver.edit(next)
      setStored(next)
    },
    [setStored, saver] // saver is a stable ref object; listed to satisfy exhaustive-deps
  )

  return [config, setConfig, settled]
}
