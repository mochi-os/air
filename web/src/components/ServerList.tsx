// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The public world-server list on the join page (#14). Reads air's /-/servers
// action (core's world listing table, kept fresh from local pushes and network
// gossip) and renders it players-first. A server whose flight version differs
// from this client's wasm is shown greyed with the mismatch spelled out rather
// than hidden — a hidden server reads as a dead network; a greyed one explains
// itself. Private servers never appear here; they are joined by address from
// the collapsed control beside this list.

import { useEffect, useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { createAppClient, useFormat } from '@mochi/web'
import { Users } from 'lucide-react'
import { flight_load, flight_version } from '../game/flight'
import { server_mismatch, server_offline, server_order, type Server } from '../game/servers'

const client = createAppClient({ appName: 'air' })

export type { Server }

// useServers polls the public listing and loads this client's own flight
// version. It lives outside ServerList so the join dialog can also match its
// RECENTS against the listing — a public server the player has joined shows
// once, in the recent position, under its public name. `servers` is null until
// the first response; a failed fetch resolves to an empty list so the dialog's
// empty state (the auto-expanded private-server entry) still applies.
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
        const res = await client.get<unknown>('/-/servers')
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

// ServerRow renders one listed server: name, live player count, and the two
// disabled states — offline (quiet past two refresh floors) and version
// mismatch, the one message the list must be precise about: why a server the
// player can see is one they cannot join.
export function ServerRow({ server, version, onPick }: { server: Server; version: number; onPick: (address: string) => void }) {
  const { t } = useLingui()
  const { formatNumber } = useFormat()
  const offline = server_offline(server, Date.now() / 1000)
  const mismatch = server_mismatch(server, version)
  const disabled = offline || mismatch
  return (
    <button
      type='button'
      disabled={disabled}
      onClick={() => onPick(server.address)}
      className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors ${
        disabled ? 'border-input text-muted-foreground/60 cursor-not-allowed' : 'border-input hover:bg-muted'
      }`}
    >
      <span className='min-w-0 flex-1 truncate'>{server.name}</span>
      <span className='text-muted-foreground ml-2 flex shrink-0 items-center gap-1 text-xs'>
        {offline ? (
          <Trans>offline</Trans>
        ) : mismatch ? (
          <span>{t`server runs v${server.version}, you have v${version}`}</span>
        ) : (
          <>
            <Users className='size-3' />
            {formatNumber(server.players)}
          </>
        )}
      </span>
    </button>
  )
}

export function ServerList({ servers, version, onPick }: { servers: Server[]; version: number; onPick: (address: string) => void }) {
  const sorted = server_order(servers, Date.now() / 1000)

  return (
    <div className='space-y-1'>
      {sorted.map((s) => (
        <ServerRow key={s.world} server={s} version={version} onPick={onPick} />
      ))}
    </div>
  )
}
