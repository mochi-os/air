// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The multiplayer panel on the Mission tab: pick an open world server (any
// address — world servers are community-run, like classic game servers), see
// its live matches, join one, or create your own. Creators choose the match
// type (open, or a 1v1 joust that ends on the first kill), the weather, and
// the rules (allowed weapons) — all carried as session parameters the world
// relays to every participant. The standing "Furball" match is listed first;
// every match is joined from its row.

import { useCallback, useEffect, useId, useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { LogIn, Plus, RefreshCw } from 'lucide-react'
import { Button } from '@mochi/web/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@mochi/web/components/ui/dialog'
import { Input } from '@mochi/web/components/ui/input'
import { Label } from '@mochi/web/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@mochi/web/components/ui/radio-group'
import { Switch } from '@mochi/web/components/ui/switch'
import { getErrorMessage } from '@mochi/web'
import { useIdentityName } from '../lib/config-store'
import { default_server, normalize_server, supported, world_create, world_sessions, world_withdraw, world_status, type Join, type WorldSession, type WorldStatus, crossHost } from '../game/net'


function Option({
  value,
  label,
  group,
}: {
  value: string
  label: React.ReactNode
  group: string
}) {
  const id = `${group}-${value}`
  return (
    <div className='flex items-center gap-2'>
      <RadioGroupItem value={value} id={id} />
      <Label htmlFor={id} className='font-normal'>
        {label}
      </Label>
    </div>
  )
}

// deviations lists a match's NON-standard settings as stable keys in the
// canonical order — weapons, time, weather, cheats (#19). Standard is
// missiles/day/no clouds/no cheats; a fully standard match returns nothing.
// The creator's fuel choice is deliberately absent: every player picks their
// own load, and the creator's is not the joiners' business.
function deviations(parameters: Record<string, unknown> | undefined): string[] {
  const out: string[] = []
  if (!parameters) return out
  if (parameters.weapons === 'guns' || (parameters.weapons == null && parameters.missiles === false)) out.push('guns')
  if (parameters.weapons === 'fox2') out.push('fox2')
  if (parameters.start === 'bvr') out.push('bvr')
  if (parameters.spaced === true) out.push('spaced')
  if (parameters.tod === 'night') out.push('night')
  if (parameters.clouds === 'cumulus' || parameters.clouds === 'high_stratus' || parameters.clouds === 'mid_stratus' || parameters.clouds === 'low_stratus') out.push(String(parameters.clouds))
  const cheats = (parameters.cheats ?? {}) as Record<string, unknown>
  for (const key of ['invulnerable', 'ammunition', 'fuel']) if (cheats[key] === true) out.push('cheat.' + key)
  return out
}

const DEVIATIONS: Record<string, React.ReactNode> = {
  guns: <Trans>Guns only</Trans>,
  fox2: 'Fox 2',
  bvr: 'BVR',
  spaced: <Trans>Spaced</Trans>,
  night: <Trans>Night</Trans>,
  cumulus: <Trans>Cumulus</Trans>,
  high_stratus: <Trans>High stratus</Trans>,
  mid_stratus: <Trans>Mid stratus</Trans>,
  low_stratus: <Trans>Low stratus</Trans>,
  'cheat.invulnerable': <Trans>Invulnerable</Trans>,
  'cheat.ammunition': <Trans>Unlimited ammunition</Trans>,
  'cheat.fuel': <Trans>Unlimited fuel</Trans>,
}

export function Multiplayer({
  server,
  callsign,
  onServer,
  onCallsign,
  onJoin,
  pilot,
  hideServer,
  rules,
  onRules,
  stores,
}: {
  server: string
  callsign: string
  onServer: (value: string) => void
  onCallsign: (value: string) => void
  onJoin: (join: Join) => void
  pilot?: string // this player's stable offer token (#77)
  hideServer?: boolean // the server page owns the address and the callsign (Settings does): show only the match list and its controls
  rules?: Record<string, unknown> // the creator's persisted match rules (#17/#32): the weapons class (missiles derived for old servers), spacing
  onRules?: (rules: Record<string, unknown>) => void
  stores?: Record<string, { fixture: string; stores: string[] }> // the player's persisted loadout, sent as the join request (#17)
}) {
  const { t } = useLingui()
  const identity = useIdentityName()
  const group = useId()
  const [status, setStatus] = useState<WorldStatus | null>(null)
  const [redirect, setRedirect] = useState<{ host: string; proceed: () => void } | null>(null)
  const [sessions, setSessions] = useState<WorldSession[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [making, setMaking] = useState(false)
  const [mode, setMode] = useState<'furball' | 'joust' | 'teams'>('furball')
  const [tod, setTod] = useState<'day' | 'night'>('day')
  const [clouds, setClouds] = useState('none')
  // The weapons CLASS (#32) defaults Unlimited and persists per-creator; the
  // missiles boolean is derived from it for old servers and old rows. The
  // original note stands (#17, decided
  // 2026-08-05): the switch seeds from the saved rules and writes back.
  const [weapons, setWeaponsState] = useState<'guns' | 'fox2' | 'open'>(
    rules?.weapons === 'guns' || rules?.weapons === 'fox2' || rules?.weapons === 'open'
      ? rules.weapons
      : rules?.missiles === false
        ? 'guns'
        : 'open'
  )
  const setWeapons = (value: 'guns' | 'fox2' | 'open') => {
    setWeaponsState(value)
    onRules?.({ ...rules, weapons: value, missiles: value !== 'guns' })
  }
  const [start, setStart] = useState<'merge' | 'bvr'>('merge') // joust start (#32): today's merge, or the BVR pair across the derived separation
  const [spaced, setSpaced] = useState(false) // open/teams (#32): spaced re-entries / anchored walls
  const [cheats, setCheats] = useState<Record<string, boolean>>({}) // invulnerable (humans only), ammunition, fuel
  const [bots, setBots] = useState<Record<string, number>>({ drone: 0, novice: 0, pilot: 0, ace: 0, superhuman: 0 }) // server-flown aircraft per skill level; drones cruise, the rest fight (also the 100-player verification lever)
  const [blueBots, setBlueBots] = useState<Record<string, number>>({ drone: 0, novice: 0, pilot: 0, ace: 0, superhuman: 0 }) // teams mode: the blue side's bots (the row above places red's)
  const [fuel, setFuel] = useState(6000) // spawn load in POUNDS, like the IFEI
  const address = normalize_server(server || default_server())
  const name = (callsign || identity || t`pilot`).slice(0, 32)

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const [s, list] = await Promise.all([world_status(address, signal), world_sessions(address, 'air', signal, pilot)])
        setStatus(s)
        setSessions(list)
        setError('')
      } catch (e) {
        if (signal?.aborted) return // unmounted or the address changed: don't clobber state with a stale failure
        setStatus(null)
        setSessions([])
        setError(getErrorMessage(e, t`World server not reachable`))
      }
    },
    [address, t, pilot],
  )

  // Poll while the panel is visible so the match list stays live. A single
  // controller aborts in-flight requests on unmount or address change, and the
  // in-flight guard stops a slow server from stacking overlapping refreshes.
  useEffect(() => {
    const controller = new AbortController()
    let busy = false
    const tick = async () => {
      if (busy) return
      busy = true
      try {
        await refresh(controller.signal)
      } finally {
        busy = false
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), 5000)
    return () => {
      clearInterval(timer)
      controller.abort()
    }
  }, [refresh])

  // enter gates every join on a cross-host check: if the lobby is redirecting
  // the game connection to a different host, confirm before dialling it.
  // Every join carries the persisted loadout as the request (#17); the server
  // clamps it against the match rules and spawns the granted result.
  const enter = useCallback(
    (params: Join) => {
      const request = { ...params, stores }
      const other = crossHost(params.address, address)
      if (other) setRedirect({ host: other, proceed: () => onJoin(request) })
      else onJoin(request)
    },
    [address, onJoin, stores]
  )

  const join = useCallback(
    (session: string, team?: string) => {
      if (!status) return
      // Flying somebody else's match retires your own offer — you can hold
      // one, and you are no longer waiting in it. Joining your OWN offer
      // must NOT withdraw it: the withdraw wins the race against the game
      // dial (which waits on asset loading), so a creator's just-made match
      // died before they ever arrived in it.
      const target = sessions.find((s) => s.session === session)
      if (pilot && !target?.mine) void world_withdraw(address, pilot)
      enter({
        server: address,
        address: status.address,
        certificate: status.certificate,
        session,
        name,
        team,
      })
    },
    [address, name, status, enter, sessions, pilot]
  )

  const create = async () => {
    setBusy(true)
    try {
      const made = await world_create(address, {
        pilot,
        game: 'air',
        mode,
        label: t`${name}'s match`,
        name,
        capacity: mode === 'joust' ? 2 : 0,
        // bots: per-level counts {drone, novice, ...}; the teams mode places them per side. Fuel in pounds; cheats: {invulnerable, ammunition, fuel}.
        // weapons is the class rule (#32); missiles stays derived so old servers and old rows keep their meaning.
        parameters: { tod, clouds, weapons, missiles: weapons !== 'guns',
          ...(mode === 'joust' ? { start } : { spaced }),
          bots: mode === 'teams' ? { red: bots, blue: blueBots } : bots, fuel, cheats },
      })
      enter({
        server: address,
        address: made.address,
        certificate: made.certificate ?? status?.certificate,
        session: made.session,
        name,
      })
    } catch (e) {
      setError(getErrorMessage(e, t`Could not create the match`))
    } finally {
      setBusy(false)
    }
  }

  if (!supported()) {
    return (
      <p className='text-muted-foreground text-sm'>
        <Trans>Multiplayer needs WebTransport, which this browser does not support yet.</Trans>
      </p>
    )
  }

  const redirectHost = redirect?.host ?? ''
  return (
    // A full-height flex column: the controls and the create form size to
    // their content, and the match list takes whatever is left and scrolls —
    // so the panel fills the server page instead of stacking at the top.
    <div className='flex h-full flex-col gap-4'>
      <Dialog open={!!redirect} onOpenChange={(open) => !open && setRedirect(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              <Trans>Different game host</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>
                This lobby is sending your game connection to a different host ({redirectHost}). Only continue if
                you trust this server.
              </Trans>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant='outline' onClick={() => setRedirect(null)}>
              <Trans>Cancel</Trans>
            </Button>
            <Button
              onClick={() => {
                redirect?.proceed()
                setRedirect(null)
              }}
            >
              <LogIn className='size-4' />
              <Trans>Continue</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {!hideServer && (
        <div className='grid gap-4 sm:grid-cols-2'>
          <div className='space-y-2'>
            <Label htmlFor='world-server'>
              <Trans>World server</Trans>
            </Label>
            <Input
              id='world-server'
              value={server}
              placeholder={default_server()}
              onChange={(e) => onServer(e.target.value)}
            />
          </div>
          <div className='space-y-2'>
            <Label htmlFor='callsign'>
              <Trans>Callsign</Trans>
            </Label>
            <Input
              id='callsign'
              value={callsign}
              placeholder={identity || t`pilot`}
              maxLength={32}
              onChange={(e) => onCallsign(e.target.value)}
            />
          </div>
        </div>
      )}

      <div className='text-muted-foreground flex items-center justify-between text-sm'>
        {status ? (
          <span>
            {status.name} · <Trans>{status.players} flying</Trans>
          </span>
        ) : (
          <span>{error || <Trans>Connecting…</Trans>}</span>
        )}
        <div className='flex gap-2'>
          <Button type='button' variant='outline' size='sm' onClick={() => void refresh()}>
            <RefreshCw className='size-4' />
            <Trans>Refresh</Trans>
          </Button>
          <Button
            type='button'
            variant='outline'
            size='sm'
            disabled={!status}
            onClick={() => setMaking((v) => !v)}
          >
            <Plus className='size-4' />
            <Trans>Create match</Trans>
          </Button>
        </div>
      </div>

      {making && (
        <div className='space-y-3 rounded-md border p-3'>
          <div className='grid gap-3 sm:grid-cols-2'>
            <div className='space-y-2'>
              <div className='text-muted-foreground text-xs font-medium uppercase'>
                <Trans>Match type</Trans>
              </div>
              <RadioGroup value={mode} onValueChange={(v) => setMode(v as 'furball' | 'joust' | 'teams')}>
                <Option group={group + 'mode'} value='furball' label={<Trans>Open — anyone may join or leave</Trans>} />
                <Option group={group + 'mode'} value='joust' label={<Trans>Joust — 1v1, first kill wins</Trans>} />
                <Option group={group + 'mode'} value='teams' label={<Trans>Teams — red versus blue</Trans>} />
              </RadioGroup>
            </div>
            <div className='space-y-2'>
              <div className='text-muted-foreground text-xs font-medium uppercase'>
                <Trans>Weather</Trans>
              </div>
              <RadioGroup value={tod} onValueChange={(v) => setTod(v as 'day' | 'night')}>
                <Option group={group + 'tod'} value='day' label={<Trans>Day</Trans>} />
                <Option group={group + 'tod'} value='night' label={<Trans>Night</Trans>} />
              </RadioGroup>
              <RadioGroup value={clouds} onValueChange={setClouds}>
                <Option group={group + 'clouds'} value='none' label={<Trans>Clear</Trans>} />
                <Option group={group + 'clouds'} value='cumulus' label={<Trans>Cumulus</Trans>} />
                <Option group={group + 'clouds'} value='high_stratus' label={<Trans>High stratus</Trans>} />
                <Option group={group + 'clouds'} value='mid_stratus' label={<Trans>Mid stratus</Trans>} />
                <Option group={group + 'clouds'} value='low_stratus' label={<Trans>Low stratus</Trans>} />
              </RadioGroup>
            </div>
          </div>
          {/* A GRID of named groups, not one flex row. Twelve controls on a
              single unwrapped row overflowed every narrow viewport, and this is
              the surface a host drives while other people wait in the lobby.
              Every header reuses an msgid the app already ships. */}
          <div className='grid gap-4 sm:grid-cols-2'>
            <div className='space-y-2'>
              <div className='text-muted-foreground text-xs font-medium uppercase'>
                <Trans>Weapons</Trans>
              </div>
              <RadioGroup value={weapons} onValueChange={(v) => setWeapons(v as 'guns' | 'fox2' | 'open')}>
                <Option group={group + 'weapons'} value='guns' label={<Trans>Guns only</Trans>} />
                <Option group={group + 'weapons'} value='fox2' label='Fox 2' />
                <Option group={group + 'weapons'} value='open' label={<Trans>Unlimited</Trans>} />
              </RadioGroup>
              <div className='flex items-center gap-2 pt-1'>
                <Label htmlFor='rule-fuel' className='font-normal'>
                  <Trans>Fuel</Trans>
                </Label>
                <Input
                  id='rule-fuel'
                  type='number'
                  min={1500}
                  max={10800}
                  step={100}
                  value={fuel}
                  onChange={(e) => setFuel(Math.max(1500, Math.min(10800, Number(e.target.value) || 6000)))}
                  className='h-8 w-24'
                />
                <span className='text-muted-foreground text-xs'>
                  <Trans>lb</Trans>
                </span>
              </div>
            </div>

            <div className='space-y-2'>
              <div className='text-muted-foreground text-xs font-medium uppercase'>
                <Trans>Start</Trans>
              </div>
              {mode === 'joust' ? (
                <RadioGroup value={start} onValueChange={(v) => setStart(v as 'merge' | 'bvr')}>
                  <Option group={group + 'start'} value='merge' label={<Trans>Merge — fight on at the pass</Trans>} />
                  <Option group={group + 'start'} value='bvr' label={<Trans>BVR — weapons free from spawn</Trans>} />
                </RadioGroup>
              ) : (
                <div className='flex items-center gap-2'>
                  <Switch id='rule-spaced' checked={spaced} onCheckedChange={setSpaced} />
                  <Label htmlFor='rule-spaced' className='font-normal'>
                    {mode === 'teams' ? <Trans>Anchored sides</Trans> : <Trans>Spaced spawns</Trans>}
                  </Label>
                </div>
              )}
            </div>

            <div className='space-y-2'>
              <div className='text-muted-foreground text-xs font-medium uppercase'>
                <Trans>Cheats</Trans>
              </div>
              <div className='flex items-center gap-2'>
                <Switch
                  id='rule-invulnerable'
                  checked={!!cheats.invulnerable}
                  onCheckedChange={(v) => setCheats((c) => ({ ...c, invulnerable: v }))}
                />
                <Label htmlFor='rule-invulnerable' className='font-normal'>
                  <Trans>Invulnerable (human players only)</Trans>
                </Label>
              </div>
              <div className='flex items-center gap-2'>
                <Switch
                  id='rule-ammunition'
                  checked={!!cheats.ammunition}
                  onCheckedChange={(v) => setCheats((c) => ({ ...c, ammunition: v }))}
                />
                <Label htmlFor='rule-ammunition' className='font-normal'>
                  <Trans>Unlimited ammunition</Trans>
                </Label>
              </div>
              <div className='flex items-center gap-2'>
                <Switch
                  id='rule-fuel-unlimited'
                  checked={!!cheats.fuel}
                  onCheckedChange={(v) => setCheats((c) => ({ ...c, fuel: v }))}
                />
                <Label htmlFor='rule-fuel-unlimited' className='font-normal'>
                  <Trans>Unlimited fuel</Trans>
                </Label>
              </div>
            </div>

            <div className='space-y-2'>
              <div className='text-muted-foreground text-xs font-medium uppercase'>
                <Trans>Bots</Trans>
              </div>
              {(mode === 'teams' ? (['red', 'blue'] as const) : (['all'] as const)).map((side) => {
                const counts = side === 'blue' ? blueBots : bots
                const update = side === 'blue' ? setBlueBots : setBots
                return (
                  <div key={side} className='space-y-1'>
                    {mode === 'teams' && (
                      <Label className='text-muted-foreground text-xs font-normal'>
                        {side === 'red' ? <Trans>Red bots</Trans> : <Trans>Blue bots</Trans>}
                      </Label>
                    )}
                    <div className='grid grid-cols-5 gap-1'>
                      {(
                        [
                          ['drone', t`Drone`],
                          ['novice', t`Novice`],
                          ['pilot', t`Pilot`],
                          ['ace', t`Ace`],
                          ['superhuman', t`Superhuman`],
                        ] as const
                      ).map(([level, label]) => (
                        <div key={level} className='min-w-0'>
                          <Label
                            htmlFor={'bots-' + side + '-' + level}
                            className='text-muted-foreground block truncate text-xs font-normal'
                            title={label}
                          >
                            {label}
                          </Label>
                          <Input
                            id={'bots-' + side + '-' + level}
                            type='number'
                            min={0}
                            max={99}
                            value={counts[level]}
                            onChange={(e) => {
                              const value = Math.max(0, Math.min(99, Number(e.target.value) || 0))
                              update((b) => {
                                const next = { ...b, [level]: value }
                                const total = Object.values(next).reduce((sum, n) => sum + n, 0)
                                return total <= 99 ? next : b // the match holds 99 bots at most
                              })
                            }}
                            className='h-8 w-full'
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          <div className='flex justify-end border-t pt-3'>
            <Button type='button' size='sm' disabled={!status || busy} onClick={() => void create()}>
              <Plus className='size-4' />
              <Trans>Create and fly</Trans>
            </Button>
          </div>
        </div>
      )}

      <div className='min-h-0 flex-1 divide-y overflow-y-auto rounded-md border'>
        {sessions.length === 0 && (
          <div className='text-muted-foreground p-4 text-sm'>
            {status ? <Trans>No open matches — create one.</Trans> : <Trans>No world server.</Trans>}
          </div>
        )}
        {[...sessions]
          .sort((a, b) => Number(!!b.mine) - Number(!!a.mine)) // your own offer pins to the top
          .map((s) => (
          <div key={s.session} className={'flex items-center justify-between gap-3 p-3' + (s.mine ? ' bg-muted/40' : '')}>
            <div className='min-w-0'>
              <div className='truncate text-sm font-medium'>
                {s.label || s.mode}
                {s.mine && (
                  <span className='text-muted-foreground ml-2 text-xs font-normal'>
                    · <Trans>your offer</Trans>
                  </span>
                )}
              </div>
              <div className='text-muted-foreground truncate text-xs'>
                {s.mode === 'joust' ? <Trans>Joust</Trans> : s.mode === 'teams' ? <Trans>Teams</Trans> : <Trans>Open</Trans>} ·{' '}
                {(s.players ?? []).map((p) => p.name).join(', ') || <Trans>empty</Trans>} ·{' '}
                <Trans>
                  {(s.players ?? []).length}/{s.capacity} players
                </Trans>
              </div>
              {/* Non-standard settings only (#19), canonical order — weapons,
                  time, weather, cheats. A fully standard match shows nothing:
                  the absence IS the signal. */}
              {deviations(s.parameters).length > 0 && (
                <div className='text-muted-foreground truncate text-xs'>
                  {deviations(s.parameters).map((key, i) => (
                    <span key={key}>
                      {i > 0 && ', '}
                      {DEVIATIONS[key]}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className='flex shrink-0 gap-2'>
              {pilot && s.mine && s.offer && (
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  onClick={async () => {
                    await world_withdraw(address, pilot)
                    void refresh()
                  }}
                >
                  <Trans>Cancel</Trans>
                </Button>
              )}
              {s.mode === 'teams' && (
                <>
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    className='text-red-600'
                    disabled={(s.players ?? []).length >= s.capacity || s.state === 'finished'}
                    onClick={() => join(s.session, 'red')}
                  >
                    <Trans>Red</Trans>
                  </Button>
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    className='text-blue-600'
                    disabled={(s.players ?? []).length >= s.capacity || s.state === 'finished'}
                    onClick={() => join(s.session, 'blue')}
                  >
                    <Trans>Blue</Trans>
                  </Button>
                </>
              )}
              <Button
                type='button'
                variant='outline'
                size='sm'
                disabled={(s.players ?? []).length >= s.capacity || s.state === 'finished'}
                onClick={() => join(s.session)}
              >
                <LogIn className='size-4' />
                <Trans>Join</Trans>
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
