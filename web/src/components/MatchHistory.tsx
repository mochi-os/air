// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The History tab: every flight this player has recorded (match_list), with a
// career summary aggregated SERVER-side over all of them and a table of the
// fifty most recent. Raw mode/reason enums are mapped to labels before display.

import { useEffect, useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { Download, History, ShieldAlert } from 'lucide-react'
import { EmptyState, shellSaveBlob, toast, useFormat } from '@mochi/web'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@mochi/web/components/ui/table'
import { history, recording_load, type MatchRow, type MatchTotals } from '../game/net'
import { Button } from '@mochi/web/components/ui/button'

// Replay is the in-memory recording the engine still holds for this session's
// flights (#212). Nothing is stored server-side yet, so only rows flown since
// the page loaded can offer a download — see #213.
export interface Replay {
  text: string
  session: string
  kind: string
}

// save writes the recording out. shellSaveBlob posts the blob to the parent
// shell inside the sandboxed iframe (where an anchor download is silently
// dropped) and falls back to a direct anchor outside it.
async function save(replay: Replay, started: number, done: (ok: boolean) => void) {
  // YYYYMMDD_HHMMSS in LOCAL time: the name should match the clock the player
  // flew by, and sorts chronologically in a downloads folder.
  const at = new Date(started)
  const pad = (v: number) => String(v).padStart(2, '0')
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `_${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  const name = `${stamp}.acmi`
  done(await shellSaveBlob(new Blob([replay.text], { type: 'text/plain' }), name))
}

// serverName shows just the host of a lobby URL; the full URL is noise.
function serverName(world: string): string {
  try {
    return new URL(world).host
  } catch {
    return world
  }
}

export function MatchHistory({ recording }: { recording?: () => Replay | null }) {
  const { t } = useLingui()
  const replay = recording?.() ?? null
  const { formatDateTime, formatNumber } = useFormat()
  const [matches, setMatches] = useState<MatchRow[] | null>(null)
  const [totals, setTotals] = useState<MatchTotals | null>(null)

  useEffect(() => {
    let live = true
    history().then((result) => {
      if (!live) return
      setMatches(result.matches)
      setTotals(result.totals)
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
      free: t`Free flight`,
    }
    return labels[mode] ?? mode.charAt(0).toUpperCase() + mode.slice(1)
  }
  const reasonLabel = (reason: string): string => {
    const labels: Record<string, string> = {
      left: t`Left`,
      gone: t`Disconnected`,
      finished: t`Finished`,
      flown: t`Flown`,
      victory: t`Victory`,
      killed: t`Killed`,
    }
    return labels[reason] ?? reason.charAt(0).toUpperCase() + reason.slice(1)
  }

  if (matches === null) return null // brief load

  if (matches.length === 0) {
    return (
      <EmptyState
        icon={History}
        title={t`No flights yet`}
        description={t`Your flights appear here once you've flown one.`}
      />
    )
  }

  // Career totals come from the SERVER's aggregate over every recorded flight.
  // Summing the rows on screen counted only the fifty most recent, which now
  // that every flight records a row is a small and shrinking fraction of them.
  // Cheated flights are INCLUDED: this is the player's own logbook, not a
  // leaderboard, and excluding them made the summary contradict the table.
  const flights = totals?.flights ?? matches.length
  const kills = totals?.kills ?? 0
  const deaths = totals?.deaths ?? 0
  const seconds = totals?.seconds ?? 0
  const ratio = deaths ? kills / deaths : kills
  // M:SS under an hour, H:MM:SS past it — the same clock the flight recorder
  // and the developer overlay show, so a duration reads the same everywhere.
  const clock = (total: number): string => {
    const whole = Math.max(0, Math.round(total))
    const hh = Math.floor(whole / 3600)
    const mm = Math.floor((whole % 3600) / 60)
    const ss = whole % 60
    const pad = (v: number) => String(v).padStart(2, '0')
    return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`
  }

  return (
    <div className='space-y-4'>
      <div className='text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-sm'>
        <span>
          <Trans>Flights</Trans>: {formatNumber(flights)}
        </span>
        <span>
          <Trans>Time</Trans>: {clock(seconds)}
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
            <TableHead>
              <Trans>Cheats</Trans>
            </TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {matches.map((m, i) => (
            <TableRow key={i} className='group'>
              <TableCell>{formatDateTime(new Date(m.started))}</TableCell>
              <TableCell>{serverName(m.world)}</TableCell>
              <TableCell>{modeLabel(m.mode)}</TableCell>
              <TableCell className='text-right'>
                {formatNumber(Number(m.players) || 0)}
              </TableCell>
              <TableCell className='text-right'>{formatNumber(m.kills)}</TableCell>
              <TableCell className='text-right'>{formatNumber(m.deaths)}</TableCell>
              <TableCell>{reasonLabel(m.reason)}</TableCell>
              <TableCell className='text-muted-foreground'>
                {m.cheated ? <ShieldAlert className='size-4' /> : null}
              </TableCell>
              <TableCell className='text-right'>
                {m.recording || (replay && replay.session === m.session) ? (
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    // Revealed on hover (and kept for keyboard focus, which
                    // hover alone would strand): a button on every row competes
                    // with the flight data for attention.
                    className='opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100'
                    onClick={() =>
                      void (async () => {
                        // Prefer the row's STORED copy: it exists for every
                        // flight, not just this session's, which is the whole
                        // point of keeping them server-side (#213). The
                        // in-memory buffer is the fallback for a flight whose
                        // upload has not landed yet.
                        const text =
                          (m.recording ? await recording_load(m.recording) : null) ??
                          (replay && replay.session === m.session ? replay.text : null)
                        if (!text) {
                          toast.error(t`Could not save the recording`)
                          return
                        }
                        save({ text, session: m.session, kind: m.mode }, m.started, (ok) =>
                          ok
                            ? toast.success(t`Recording saved`)
                            : toast.error(t`Could not save the recording`)
                        )
                      })()
                    }
                  >
                    <Download className='size-4' />
                    <Trans>Recording</Trans>
                  </Button>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
