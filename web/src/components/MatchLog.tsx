// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The flight log: every flight this player has recorded (match_list), with a
// career summary aggregated SERVER-side over all of them and a table of the
// fifty most recent. Raw mode/reason enums are mapped to labels before display.

import { useEffect, useState, type ReactNode } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { ArrowDown, ArrowUp, ChevronsUpDown, CircleAlert, Download, History, ShieldAlert } from 'lucide-react'
import { EmptyState, getErrorMessage, shellSaveBlob, toast, useFormat } from '@mochi/web'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@mochi/web/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@mochi/web/components/ui/table'
import { log, recording_load, type MatchRow, type MatchTotals } from '../game/net'
import { Button } from '@mochi/web/components/ui/button'

// Replay is the in-memory recording the engine still holds for this session's
// flights - the fallback for a row whose upload has not landed yet.
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

// The columns worth ordering by: when the flight was, how long it ran, and how
// it went. The rest are labels the filters above the table already narrow.
type SortKey = 'started' | 'duration' | 'kills' | 'deaths'
type Sort = { key: SortKey; direction: 'asc' | 'desc' }

// A header that sorts. The whole cell is the button so the hit target matches
// what the eye reads as the column title, and the arrow only appears on the
// column actually in force - an arrow on every header says nothing about which
// one the table is ordered by.
function SortHead({
  column,
  sort,
  onSort,
  right,
  children,
}: {
  column: SortKey
  sort: Sort
  onSort: (sort: Sort) => void
  right?: boolean
  children: ReactNode
}) {
  const active = sort.key === column
  const Arrow = !active ? ChevronsUpDown : sort.direction === 'asc' ? ArrowUp : ArrowDown
  return (
    <TableHead
      aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={right ? 'text-right' : undefined}
    >
      <button
        type='button'
        // A new column starts on the order that reads as "most interesting
        // first": newest flight, longest flight, most kills. Clicking the
        // column already in force is what flips it.
        onClick={() =>
          onSort(active ? { key: column, direction: sort.direction === 'asc' ? 'desc' : 'asc' } : { key: column, direction: 'desc' })
        }
        className={`hover:text-foreground focus-visible:ring-ring/50 -mx-1 flex w-full items-center gap-1 rounded px-1 outline-none focus-visible:ring-[3px] ${
          right ? 'justify-end' : ''
        } ${active ? 'text-foreground font-semibold' : ''}`}
      >
        {/* On a right-aligned column the arrow goes BEFORE the label, so the
            label itself ends flush with the numbers below it. Trailing it there
            pushed every heading an arrow's width off its own column. */}
        {right && <Arrow className={`size-3 shrink-0 ${active ? '' : 'opacity-40'}`} />}
        {children}
        {!right && <Arrow className={`size-3 shrink-0 ${active ? '' : 'opacity-40'}`} />}
      </button>
    </TableHead>
  )
}

export function MatchLog({ recording }: { recording?: () => Replay | null }) {
  const { t } = useLingui()
  const replay = recording?.() ?? null
  const { formatDateTime, formatNumber } = useFormat()
  const [matches, setMatches] = useState<MatchRow[] | null>(null)
  const [totals, setTotals] = useState<MatchTotals | null>(null)
  const [failure, setFailure] = useState<unknown>(null)
  const [mode, setMode] = useState('all')
  const [world, setWorld] = useState('all')
  const [sort, setSort] = useState<Sort>({ key: 'started', direction: 'desc' })

  useEffect(() => {
    let live = true
    log()
      .then((result) => {
        if (!live) return
        setMatches(result.matches)
        setTotals(result.totals)
      })
      .catch((problem: unknown) => {
        if (live) setFailure(problem ?? new Error())
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

  // A failed load is an error, never the empty state: the empty state says
  // "you have no flights", which for a 401 or a down server is a lie about
  // the player's whole logbook.
  if (failure !== null) {
    const title = t`Could not load your flights`
    const detail = getErrorMessage(failure, title)
    return (
      <EmptyState
        icon={CircleAlert}
        title={title}
        description={detail === title ? undefined : detail}
      />
    )
  }

  // A skeleton shaped like the table that is coming, not a spinner and not
  // nothing: returning null left the page as a Back button and a heading over
  // empty space, which reads as "you have no flights" — the exact thing the
  // real empty state below says properly.
  if (matches === null)
    return (
      <div className='space-y-4' aria-busy='true'>
        <div className='flex flex-wrap gap-x-4 gap-y-1'>
          {[64, 72, 52, 60, 44].map((w, i) => (
            <div key={i} className='bg-muted h-4 animate-pulse rounded' style={{ width: w }} />
          ))}
        </div>
        <div className='space-y-2'>
          {Array.from({ length: 6 }, (_, i) => (
            <div
              key={i}
              className='bg-muted h-8 animate-pulse rounded'
              style={{ animationDelay: `${i * 60}ms` }}
            />
          ))}
        </div>
      </div>
    )

  if (matches.length === 0) {
    return (
      <EmptyState
        icon={History}
        title={t`No flights yet`}
        description={t`Your flights appear here once you've flown one.`}
      />
    )
  }

  // Career totals are the server's aggregate over every flight (the rows on
  // screen are only the fifty most recent), cheated flights included - a
  // logbook, not a leaderboard.
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

  // The pickers offer only what the rows actually contain: a menu of every mode
  // the game has would mostly filter to nothing.
  const modes = Array.from(new Set(matches.map((m) => m.mode))).sort()
  const worlds = Array.from(new Set(matches.map((m) => serverName(m.world)))).sort()
  const filtered = matches.filter(
    (m) => (mode === 'all' || m.mode === mode) && (world === 'all' || serverName(m.world) === world)
  )
  const rank = (m: MatchRow): number => {
    switch (sort.key) {
      // A row with no end stamp has no duration to compare; -1 keeps it below
      // every real one instead of sorting as a zero-second flight.
      case 'duration':
        return m.ended > m.started ? m.ended - m.started : -1
      case 'kills':
        return m.kills
      case 'deaths':
        return m.deaths
      default:
        return m.started
    }
  }
  // Copied first: sort() works in place, and matches is the state array.
  const ordered = [...filtered].sort((a, b) => (rank(a) - rank(b)) * (sort.direction === 'asc' ? 1 : -1))
  const filtering = mode !== 'all' || world !== 'all'
  const clear = () => {
    setMode('all')
    setWorld('all')
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

      {/* Only worth showing once there is something to narrow: one server and
          one mode make both pickers a menu of a single choice. */}
      {(modes.length > 1 || worlds.length > 1) && (
        <div className='flex flex-wrap items-center gap-2'>
          {modes.length > 1 && (
            <Select value={mode} onValueChange={setMode}>
              <SelectTrigger size='sm' className='w-40' aria-label={t`Mode`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='all'>
                  <Trans>All modes</Trans>
                </SelectItem>
                {modes.map((m) => (
                  <SelectItem key={m} value={m}>
                    {modeLabel(m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {worlds.length > 1 && (
            <Select value={world} onValueChange={setWorld}>
              <SelectTrigger size='sm' className='w-56' aria-label={t`Server`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='all'>
                  <Trans>All servers</Trans>
                </SelectItem>
                {worlds.map((w) => (
                  <SelectItem key={w} value={w}>
                    {w}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {filtering && (
            <>
              <Button type='button' variant='ghost' size='sm' className='text-muted-foreground' onClick={clear}>
                <Trans>Clear</Trans>
              </Button>
              {/* The career line above counts every flight ever, so a filtered
                  table needs its own count or the two read as a contradiction. */}
              <span className='text-muted-foreground text-xs'>
                <Trans>
                  {ordered.length} of {matches.length} flights
                </Trans>
              </span>
            </>
          )}
        </div>
      )}

      <Table>
        <TableHeader>
          <TableRow>
            <SortHead column='started' sort={sort} onSort={setSort}>
              <Trans>Date</Trans>
            </SortHead>
            <SortHead column='duration' sort={sort} onSort={setSort} right>
              <Trans>Duration</Trans>
            </SortHead>
            <TableHead>
              <Trans>Server</Trans>
            </TableHead>
            <TableHead>
              <Trans>Mode</Trans>
            </TableHead>
            <TableHead className='text-right'>
              <Trans>Players</Trans>
            </TableHead>
            <SortHead column='kills' sort={sort} onSort={setSort} right>
              <Trans>Kills</Trans>
            </SortHead>
            <SortHead column='deaths' sort={sort} onSort={setSort} right>
              <Trans>Deaths</Trans>
            </SortHead>
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
          {ordered.length === 0 && (
            <TableRow>
              {/* Inside the table, not above it: the headers stay put so it
                  reads as this table with nothing in it, not as a page that
                  has lost its flights. */}
              <TableCell colSpan={10} className='text-muted-foreground py-8 text-center text-sm'>
                <Trans>No flight matches these filters.</Trans>{' '}
                <button type='button' className='text-primary hover:underline' onClick={clear}>
                  <Trans>Clear</Trans>
                </button>
              </TableCell>
            </TableRow>
          )}
          {ordered.map((m) => (
            // session and start together: one session can leave more than one
            // row, and an index key hands the wrong row's download button to
            // the wrong flight the moment the table is sorted.
            <TableRow key={`${m.session}-${m.started}`} className='group'>
              <TableCell>{formatDateTime(new Date(m.started))}</TableCell>
              {/* started/ended are epoch milliseconds, stamped by the client
                  and summed server-side for the career total above — so the
                  row reads on the same clock as the summary. */}
              <TableCell className='text-right tabular-nums'>
                {m.ended > m.started ? clock((m.ended - m.started) / 1000) : '—'}
              </TableCell>
              <TableCell>{serverName(m.world)}</TableCell>
              <TableCell>{modeLabel(m.mode)}</TableCell>
              {/* tabular-nums like the Duration column beside them: without it
                  a 1 and a 0 are different widths and the column edge wobbles. */}
              <TableCell className='text-right tabular-nums'>
                {formatNumber(Number(m.players) || 0)}
              </TableCell>
              <TableCell className='text-right tabular-nums'>{formatNumber(m.kills)}</TableCell>
              <TableCell className='text-right tabular-nums'>{formatNumber(m.deaths)}</TableCell>
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
                    // with the flight data for attention. A coarse pointer has
                    // no hover at all, so there it stays visible — otherwise a
                    // tablet could see recordings it had no way to save.
                    className='opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100'
                    onClick={() =>
                      void (async () => {
                        // Prefer the stored copy (exists for every flight); the
                        // in-memory buffer covers a flight whose upload has not
                        // landed yet.
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
