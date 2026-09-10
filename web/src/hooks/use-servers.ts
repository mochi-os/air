// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// useServers polls the public world-server listing and loads this client's
// flight version. It lives apart from ServerList so the join dialog can match
// its recents against the listing, and apart from any component so fast
// refresh keeps working for the files that render it. `servers` is null until
// the first response; a failed fetch resolves to an empty list so the dialog's
// empty state still applies.

import { useEffect, useState } from 'react'
import { createAppClient } from '@mochi/web'
import { flight_load, flight_version } from '../game/flight'
import { type Server } from '../game/servers'
import { authenticated } from '../lib/config-store'

const client = createAppClient({ appName: 'air' })

export function useServers(): { servers: Server[] | null; version: number } {
  const [servers, setServers] = useState<Server[] | null>(null)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let live = true
    // The wasm carries the authoritative flight version; load it once so the
    // compatibility check is against what this client actually flies.
    void flight_load().then(() => live && setVersion(flight_version()))
    const load = async () => {
      try {
        await authenticated()
        const res = await client.get<unknown>('-/servers')
        // The app client returns the response; a Starlark action wraps its
        // payload in {data:...}, and createAppClient may unwrap one layer —
        // tolerate either depth rather than guess.
        const peel = (v: unknown): { servers?: Server[] } =>
          v && typeof v === 'object' && 'data' in v ? peel((v as { data: unknown }).data) : (v as { servers?: Server[] })
        if (live) setServers(peel(res).servers ?? [])
      } catch {
        if (live) setServers([])
      }
    }
    void load()
    // The list is cheap and the counts drift; a slow poll keeps it live without
    // hammering the user's own server.
    const timer = setInterval(load, 30000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [])

  return { servers, version }
}
