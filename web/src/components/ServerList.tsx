// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The public world-server list on the join page (#14). Reads air's /-/servers
// action (core's world listing table, kept fresh from local pushes and network
// gossip) and renders it players-first. A server whose flight version differs
// from this client's wasm is shown greyed with the mismatch spelled out rather
// than hidden — a hidden server reads as a dead network; a greyed one explains
// itself. Private servers never appear here; they are joined by URL, so the URL
// field beside this list stays first-class.

import { useEffect, useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { createAppClient, useFormat } from '@mochi/web'
import { Users } from 'lucide-react'
import { flight_load, flight_version } from '../game/flight'

const client = createAppClient({ appName: 'air' })

interface Server {
  world: string
  name: string
  address: string
  version: number
  players: number
  seen: number
}

// A listing is offline once it has missed two 10-minute refresh floors: core
// keeps it in the table for 45 minutes (repair grace), but a join page should
// stop advertising a server that has gone quiet well before then.
const OFFLINE_AFTER = 1500

export function ServerList({ onPick }: { onPick: (address: string) => void }) {
  const { t } = useLingui()
  const { formatNumber } = useFormat()
  const [servers, setServers] = useState<Server[] | null>(null)
  const [version, setVersion] = useState(0)
  const [failed, setFailed] = useState(false)

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
        const list = peel(res).servers ?? []
        if (live) {
          setServers(list)
          setFailed(false)
        }
      } catch {
        if (live) setFailed(true)
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

  if (failed || (servers && servers.length === 0)) return null // nothing public to show: the URL field carries the page
  if (!servers) return null // first load: the recents/URL controls render immediately, the list fills in

  const now = Date.now() / 1000
  // Players descending; an empty-looking list of empty servers reads as a dead
  // game, so the busiest sits first. Offline listings sink to the bottom.
  const sorted = [...servers].sort((a, b) => {
    const ao = now - a.seen > OFFLINE_AFTER ? 1 : 0
    const bo = now - b.seen > OFFLINE_AFTER ? 1 : 0
    return ao - bo || b.players - a.players
  })

  return (
    <div className='space-y-1'>
      {sorted.map((s) => {
        const offline = now - s.seen > OFFLINE_AFTER
        const mismatch = version > 0 && s.version !== version
        const disabled = offline || mismatch
        return (
          <button
            key={s.world}
            type='button'
            disabled={disabled}
            onClick={() => onPick(s.address)}
            className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors ${
              disabled ? 'border-input text-muted-foreground/60 cursor-not-allowed' : 'border-input hover:bg-muted'
            }`}
          >
            <span className='min-w-0 flex-1 truncate'>{s.name}</span>
            <span className='text-muted-foreground ml-2 flex shrink-0 items-center gap-1 text-xs'>
              {offline ? (
                <Trans>offline</Trans>
              ) : mismatch ? (
                // The one message the list must be precise about: why a server
                // the player can see is one they cannot join.
                <span>{t`server runs v${s.version}, you have v${version}`}</span>
              ) : (
                <>
                  <Users className='size-3' />
                  {formatNumber(s.players)}
                </>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}
