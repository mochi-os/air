// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The History tab: this player's recorded multiplayer matches (match_list),
// a summary line over honest (non-cheated) matches plus a table of the recent
// ones. Raw mode/reason enums are mapped to labels before display.

import { useEffect, useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { History, ShieldAlert } from 'lucide-react'
import { EmptyState, useFormat } from '@mochi/web'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@mochi/web/components/ui/table'
import { history, type MatchRow } from '../game/net'

// serverName shows just the host of a lobby URL; the full URL is noise.
function serverName(world: string): string {
  try {
    return new URL(world).host
  } catch {
    return world
  }
}

export function MatchHistory() {
  const { t } = useLingui()
  const { formatDateTime, formatNumber } = useFormat()
  const [matches, setMatches] = useState<MatchRow[] | null>(null)

  useEffect(() => {
    let live = true
    history().then((rows) => {
      if (live) setMatches(rows)
    })
    return () => {
      live = false
    }
  }, [])

  const modeLabel = (mode: string): string => {
    const labels: Record<string, string> = {
      furball: t`Furball`,
      joust: t`Joust`,
      teams: t`Teams`,
    }
    return labels[mode] ?? mode.charAt(0).toUpperCase() + mode.slice(1)
  }
  const reasonLabel = (reason: string): string => {
    const labels: Record<string, string> = {
      left: t`Left`,
      gone: t`Disconnected`,
      finished: t`Finished`,
    }
    return labels[reason] ?? reason.charAt(0).toUpperCase() + reason.slice(1)
  }

  if (matches === null) return null // brief load

  if (matches.length === 0) {
    return (
      <EmptyState
        icon={History}
        title={t`No matches yet`}
        description={t`Your multiplayer matches appear here once you've flown one.`}
      />
    )
  }

  // Summary over honest (non-cheated) matches so a stat line stays honest.
  const honest = matches.filter((m) => !m.cheated)
  const kills = honest.reduce((sum, m) => sum + m.kills, 0)
  const deaths = honest.reduce((sum, m) => sum + m.deaths, 0)
  const ratio = deaths ? kills / deaths : kills

  return (
    <div className='space-y-4'>
      <div className='text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-sm'>
        <span>
          <Trans>Matches</Trans>: {formatNumber(honest.length)}
        </span>
        <span>
          <Trans>Kills</Trans>: {formatNumber(kills)}
        </span>
        <span>
          <Trans>Deaths</Trans>: {formatNumber(deaths)}
        </span>
        <span>
          <Trans>K/D</Trans>: {formatNumber(ratio, 2)}
        </span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              <Trans>Date</Trans>
            </TableHead>
            <TableHead>
              <Trans>Server</Trans>
            </TableHead>
            <TableHead>
              <Trans>Mode</Trans>
            </TableHead>
            <TableHead className='text-right'>
              <Trans>Players</Trans>
            </TableHead>
            <TableHead className='text-right'>
              <Trans>Kills</Trans>
            </TableHead>
            <TableHead className='text-right'>
              <Trans>Deaths</Trans>
            </TableHead>
            <TableHead>
              <Trans>Result</Trans>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {matches.map((m, i) => (
            <TableRow key={i}>
              <TableCell>{formatDateTime(new Date(m.started))}</TableCell>
              <TableCell>{serverName(m.world)}</TableCell>
              <TableCell>{modeLabel(m.mode)}</TableCell>
              <TableCell className='text-right'>
                {formatNumber(Number(m.players) || 0)}
              </TableCell>
              <TableCell className='text-right'>{formatNumber(m.kills)}</TableCell>
              <TableCell className='text-right'>{formatNumber(m.deaths)}</TableCell>
              <TableCell>
                {reasonLabel(m.reason)}
                {m.cheated ? (
                  <span className='text-muted-foreground ml-2 inline-flex items-center gap-1 text-xs'>
                    <ShieldAlert className='size-3' />
                    <Trans>Cheats</Trans>
                  </span>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
