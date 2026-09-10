// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The public world-server list on the join page (#14), players-first. A server
// whose flight version differs from this client's wasm is greyed with the
// mismatch spelled out, not hidden. Private servers are joined by address from
// the control beside this list.

import { Trans, useLingui } from '@lingui/react/macro'
import { useFormat } from '@mochi/web'
import { Users } from 'lucide-react'
import { server_mismatch, server_offline, server_order, type Server } from '../game/servers'

export type { Server }

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
