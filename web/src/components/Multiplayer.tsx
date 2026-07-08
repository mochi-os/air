// Copyright © 2026 Mochi OÜ
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
import { Input } from '@mochi/web/components/ui/input'
import { Label } from '@mochi/web/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@mochi/web/components/ui/radio-group'
import { Switch } from '@mochi/web/components/ui/switch'
import { getErrorMessage } from '@mochi/web'
import { useIdentityName } from '../lib/config-store'
import {
  normalize_server,
  supported,
  world_create,
  world_sessions,
  world_status,
  type Join,
  type WorldSession,
  type WorldStatus,
} from '../game/net'

// The conventional lobby port on the page's own host — the natural default
// when the Mochi server's operator also runs a world server.
export function default_server(): string {
  return `${location.protocol === 'https:' ? 'https' : 'http'}://${location.hostname}:4433`
}

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

export function Multiplayer({
  server,
  callsign,
  onServer,
  onCallsign,
  onJoin,
}: {
  server: string
  callsign: string
  onServer: (value: string) => void
  onCallsign: (value: string) => void
  onJoin: (join: Join) => void
}) {
  const { t } = useLingui()
  const identity = useIdentityName()
  const group = useId()
  const [status, setStatus] = useState<WorldStatus | null>(null)
  const [sessions, setSessions] = useState<WorldSession[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [making, setMaking] = useState(false)
  const [mode, setMode] = useState<'furball' | 'joust'>('furball')
  const [tod, setTod] = useState<'day' | 'night'>('day')
  const [clouds, setClouds] = useState('none')
  const [missiles, setMissiles] = useState(false)
  const [bots, setBots] = useState<Record<string, number>>({ drone: 0, rookie: 0, pilot: 0, veteran: 0, ace: 0 }) // server-flown aircraft per skill level; drones cruise, the rest fight (also the 100-player verification lever)
  const [fuel, setFuel] = useState(6600) // spawn load in POUNDS, like the IFEI
  const address = normalize_server(server || default_server())
  const name = (callsign || identity || t`pilot`).slice(0, 32)

  const refresh = useCallback(async () => {
    try {
      const [s, list] = await Promise.all([world_status(address), world_sessions(address, 'furball')])
      setStatus(s)
      setSessions(list)
      setError('')
    } catch (e) {
      setStatus(null)
      setSessions([])
      setError(getErrorMessage(e, t`World server not reachable`))
    }
  }, [address, t])

  // Poll while the panel is visible so the match list stays live.
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    return () => clearInterval(timer)
  }, [refresh])

  const join = useCallback(
    (session: string) => {
      if (!status) return
      onJoin({
        server: address,
        address: status.address,
        certificate: status.certificate,
        session,
        name,
      })
    },
    [address, name, status, onJoin]
  )

  const create = async () => {
    setBusy(true)
    try {
      const made = await world_create(address, {
        game: 'furball',
        mode,
        label: t`${name}'s match`,
        capacity: mode === 'joust' ? 2 : 0,
        parameters: { tod, clouds, missiles, bots, fuel },   // bots: per-level counts {drone, rookie, pilot, veteran, ace}; fuel in pounds
      })
      onJoin({
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

  return (
    <div className='space-y-4'>
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
              <RadioGroup value={mode} onValueChange={(v) => setMode(v as 'furball' | 'joust')}>
                <Option group={group + 'mode'} value='furball' label={<Trans>Open — anyone may join or leave</Trans>} />
                <Option group={group + 'mode'} value='joust' label={<Trans>Joust — 1v1, first kill wins</Trans>} />
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
                <Option group={group + 'clouds'} value='low_stratus' label={<Trans>Low stratus</Trans>} />
              </RadioGroup>
            </div>
          </div>
          <div className='flex items-center justify-between'>
            <div className='flex items-center gap-4'>
              <div className='flex items-center gap-2'>
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
                  onChange={(e) => setFuel(Math.max(1500, Math.min(10800, Number(e.target.value) || 6600)))}
                  className='h-8 w-20'
                />
                <span className='text-muted-foreground text-xs'>
                  <Trans>lb</Trans>
                </span>
              </div>
              <div className='flex items-center gap-2'>
                <Switch id='rule-missiles' checked={missiles} onCheckedChange={setMissiles} />
                <Label htmlFor='rule-missiles' className='font-normal'>
                  <Trans>Missiles allowed</Trans>
                </Label>
              </div>
              <div className='flex flex-wrap items-center gap-2'>
                <Label className='font-normal'>
                  <Trans>Bots</Trans>
                </Label>
                {(
                  [
                    ['drone', t`Drone`],
                    ['rookie', t`Rookie`],
                    ['pilot', t`Pilot`],
                    ['veteran', t`Veteran`],
                    ['ace', t`Ace`],
                  ] as const
                ).map(([level, label]) => (
                  <div key={level} className='flex items-center gap-1'>
                    <Label htmlFor={'bots-' + level} className='text-muted-foreground text-xs font-normal'>
                      {label}
                    </Label>
                    <Input
                      id={'bots-' + level}
                      type='number'
                      min={0}
                      max={99}
                      value={bots[level]}
                      onChange={(e) => {
                        const value = Math.max(0, Math.min(99, Number(e.target.value) || 0))
                        setBots((b) => {
                          const next = { ...b, [level]: value }
                          const total = Object.values(next).reduce((sum, n) => sum + n, 0)
                          return total <= 99 ? next : b // the match holds 99 bots at most
                        })
                      }}
                      className='h-8 w-14'
                    />
                  </div>
                ))}
              </div>
            </div>
            <Button type='button' size='sm' disabled={!status || busy} onClick={() => void create()}>
              <Plus className='size-4' />
              <Trans>Create and fly</Trans>
            </Button>
          </div>
        </div>
      )}

      <div className='divide-y rounded-md border'>
        {sessions.length === 0 && (
          <div className='text-muted-foreground p-4 text-sm'>
            {status ? <Trans>No open matches — create one.</Trans> : <Trans>No world server.</Trans>}
          </div>
        )}
        {sessions.map((s) => (
          <div key={s.session} className='flex items-center justify-between gap-3 p-3'>
            <div className='min-w-0'>
              <div className='truncate text-sm font-medium'>{s.label || s.mode}</div>
              <div className='text-muted-foreground truncate text-xs'>
                {s.mode === 'joust' ? <Trans>Joust</Trans> : <Trans>Open</Trans>} ·{' '}
                {(s.players ?? []).map((p) => p.name).join(', ') || <Trans>empty</Trans>} ·{' '}
                <Trans>
                  {(s.players ?? []).length}/{s.capacity} players
                </Trans>
              </div>
            </div>
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
        ))}
      </div>
    </div>
  )
}
