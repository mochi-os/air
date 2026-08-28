// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { useLingui as useI18n } from '@lingui/react'
import { msg } from '@lingui/core/macro'
import { type MessageDescriptor } from '@lingui/core'
import {
  Check,
  Download,
  Gamepad2,
  Keyboard,
  Monitor,
  RotateCcw,
  Search,
  TriangleAlert,
  Upload,
  User,
  Volume2,
  X,
} from 'lucide-react'
import { Input } from '@mochi/web/components/ui/input'
import { IconButton, shellSaveBlob, toast } from '@mochi/web'
import { Badge } from '@mochi/web/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@mochi/web/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@mochi/web/components/ui/select'
import { Button } from '@mochi/web/components/ui/button'
import { Label } from '@mochi/web/components/ui/label'
import { Slider } from '@mochi/web/components/ui/slider'
import {
  DEFAULT_CONFIG,
  GRAPHICS_PRESETS,
  type GraphicsPreset,
  graphicsPreset,
  type MissionConfig,
  type StickBindings,
  deviceDefaults,
  profileFor,
} from '../lib/config'
import { useIdentityName } from '../lib/config-store'
import { KEY_DEFAULTS, pretty } from '../game/keys'
import { SliderRow, SwitchRow, MenuDialog, SectionLabel } from './menu-parts'


// The fields each tab owns, for the per-tab Reset
const TAB_FIELDS: Record<string, string[]> = {
  general: ['callsign', 'record', 'hints'],
  controls: ['joystick', 'sticks'],
  keys: ['keys'],
  sound: ['sound', 'volume'],
  graphics: ['render_scale', 'dyn_res', 'lod', 'shadows', 'exterior_detail', 'effects_quality', 'ocean_segments', 'afterburner', 'tracers', 'framerate'],
}

interface PadState {
  id: string
  mapping: string
  axes: number[]
  buttons: boolean[]
}

function useGamepads(): PadState[] {
  const [pads, setPads] = useState<PadState[]>([])
  useEffect(() => {
    const timer = setInterval(() => {
      // Nobody is watching the axis meters this drives while the tab is
      // minimised or in the background, and the pads cannot be moved there
      // either. Browsers already throttle a hidden tab's timers to about one a
      // second, so this drops that last poll rather than the full 8 Hz.
      if (document.hidden) return
      const raw = navigator.getGamepads ? navigator.getGamepads() : []
      const list: PadState[] = []
      for (const p of raw) {
        if (p && p.connected && p.axes.length >= 2)
          list.push({ id: p.id, mapping: p.mapping ?? '', axes: Array.from(p.axes), buttons: p.buttons.map((b) => b.pressed) })
      }
      setPads((old) =>
        old.length === list.length &&
        old.every((o, i) => o.id === list[i].id && o.axes.every((a, k) => Math.abs(a - list[i].axes[k]) < 0.005) && o.buttons.every((b, k) => b === list[i].buttons[k]))
          ? old
          : list,
      )
    }, 120)
    return () => clearInterval(timer)
  }, [])
  return pads
}

const GROUP_ORDER = ['flight', 'trim', 'weapons', 'aircraft', 'view', 'comms'] as const
type Group = (typeof GROUP_ORDER)[number]
const GROUP_TITLES: Record<Group, ReactNode> = {
  flight: <Trans>Flight</Trans>,
  trim: <Trans>Trim</Trans>,
  weapons: <Trans>Weapons</Trans>,
  aircraft: <Trans>Aircraft</Trans>,
  view: <Trans>View</Trans>,
  comms: <Trans>Communication</Trans>,
}
type Row = { id: string; label: MessageDescriptor; group: Group }

const AXIS_ROWS: { id: string; label: MessageDescriptor }[] = [
  { id: 'pitch', label: msg`Pitch` },
  { id: 'roll', label: msg`Roll` },
  { id: 'yaw', label: msg`Yaw` },
  { id: 'throttle', label: msg`Throttle` },
  { id: 'speedbrake', label: msg`Speed brake` },
  { id: 'look', label: msg`Look` },
  { id: 'trim', label: msg`Trim hat` },
  { id: 'weapon', label: msg`Weapon select hat` },
  { id: 'zoom', label: msg`Zoom` },
]
const LEVERS = new Set(['throttle', 'speedbrake'])
const PAIRS = new Set(['look', 'trim', 'weapon'])

function AxisMeter({ live }: { live: number }) {
  const percent = Math.round(live * 100)
  return (
    <div className='flex min-w-24 flex-1 items-center gap-2'>
      <div className='bg-muted relative h-2 flex-1 overflow-hidden rounded border border-border'>
        <div className='bg-foreground/30 absolute top-0 bottom-0 left-1/2 z-10 w-0.5' />
        <div className='bg-foreground/15 absolute top-0 bottom-0 left-1/4 w-px' />
        <div className='bg-foreground/15 absolute top-0 bottom-0 left-3/4 w-px' />
        <div
          className='absolute top-0 bottom-0 rounded transition-all duration-75'
          style={{
            left: `${50 + Math.min(0, live) * 50}%`,
            width: `${Math.abs(live) * 50}%`,
            background: 'var(--air-accent)',
          }}
        />
      </div>
      <span
        className='text-muted-foreground w-9 text-right font-mono text-[10px] tabular-nums'
        style={{ fontFamily: 'var(--air-mono)' }}
      >
        {live >= 0 ? `+${percent}` : percent}%
      </span>
    </div>
  )
}

const BUTTON_ROWS: Row[] = [
  { id: 'brake.speed', label: msg`Speed brake`, group: 'flight' },
  { id: 'brake.wheel', label: msg`Wheel brakes`, group: 'flight' },
  { id: 'override', label: msg`Override G limit`, group: 'flight' },
  { id: 'yaw.left', label: msg`Yaw left`, group: 'flight' },
  { id: 'yaw.right', label: msg`Yaw right`, group: 'flight' },
  { id: 'throttle.up', label: msg`Throttle up`, group: 'flight' },
  { id: 'throttle.down', label: msg`Throttle down`, group: 'flight' },
  { id: 'trim.up', label: msg`Trim nose up`, group: 'trim' },
  { id: 'trim.down', label: msg`Trim nose down`, group: 'trim' },
  { id: 'trim.left', label: msg`Trim roll left`, group: 'trim' },
  { id: 'trim.right', label: msg`Trim roll right`, group: 'trim' },
  { id: 'trim.reset', label: msg`Reset trim`, group: 'trim' },
  { id: 'fire', label: msg`Fire weapon`, group: 'weapons' },
  { id: 'select', label: msg`Select weapon`, group: 'weapons' },
  { id: 'acquire', label: msg`Acquire target`, group: 'weapons' },
  { id: 'radar.undesignate', label: msg`Undesignate target`, group: 'weapons' },
  { id: 'uncage', label: msg`Uncage seeker`, group: 'weapons' },
  { id: 'jammer', label: msg`Jammer`, group: 'weapons' },
  { id: 'radar.silent', label: msg`Radar silent`, group: 'weapons' },
  { id: 'radar.acm', label: msg`Acquisition mode`, group: 'weapons' },
  { id: 'flares', label: msg`Countermeasures`, group: 'weapons' },
  { id: 'jettison.tanks', label: msg`Jettison tanks`, group: 'weapons' },
  { id: 'jettison.emergency', label: msg`Emergency jettison (hold)`, group: 'weapons' },
  { id: 'caution.reset', label: msg`Reset master caution`, group: 'aircraft' },
  { id: 'flaps.extend', label: msg`Extend flaps`, group: 'aircraft' },
  { id: 'flaps.retract', label: msg`Retract flaps`, group: 'aircraft' },
  { id: 'gear', label: msg`Landing gear`, group: 'aircraft' },
  { id: 'hook', label: msg`Arrestor hook`, group: 'aircraft' },
  { id: 'atc', label: msg`Approach power (ATC)`, group: 'aircraft' },
  { id: 'fold', label: msg`Wing fold`, group: 'aircraft' },
  { id: 'launch', label: msg`Launch (catapult)`, group: 'aircraft' },
  { id: 'lights', label: msg`Lights`, group: 'aircraft' },
  { id: 'view', label: msg`Cycle view`, group: 'view' },
  { id: 'view.reset', label: msg`Reset view`, group: 'view' },
  { id: 'repeater', label: msg`Display repeater`, group: 'view' },
  { id: 'look.up', label: msg`Look up`, group: 'view' },
  { id: 'look.down', label: msg`Look down`, group: 'view' },
  { id: 'look.left', label: msg`Look left`, group: 'view' },
  { id: 'look.right', label: msg`Look right`, group: 'view' },
  { id: 'look.target', label: msg`Look at target`, group: 'view' },
  { id: 'zoom.in', label: msg`Zoom in`, group: 'view' },
  { id: 'zoom.out', label: msg`Zoom out`, group: 'view' },
  { id: 'menu', label: msg`Menu`, group: 'comms' },
]

const KEY_ROWS: Row[] = [
  { id: 'pitch.up', label: msg`Pitch up`, group: 'flight' },
  { id: 'pitch.down', label: msg`Pitch down`, group: 'flight' },
  { id: 'roll.left', label: msg`Roll left`, group: 'flight' },
  { id: 'roll.right', label: msg`Roll right`, group: 'flight' },
  { id: 'yaw.left', label: msg`Yaw left`, group: 'flight' },
  { id: 'yaw.right', label: msg`Yaw right`, group: 'flight' },
  { id: 'throttle.up', label: msg`Throttle up`, group: 'flight' },
  { id: 'throttle.down', label: msg`Throttle down`, group: 'flight' },
  { id: 'brake.speed', label: msg`Speed brake`, group: 'flight' },
  { id: 'brake.wheel', label: msg`Wheel brakes`, group: 'flight' },
  { id: 'brake.parking', label: msg`Parking brake`, group: 'flight' },
  { id: 'override', label: msg`Override G limit`, group: 'flight' },
  { id: 'trim.up', label: msg`Trim nose up`, group: 'trim' },
  { id: 'trim.down', label: msg`Trim nose down`, group: 'trim' },
  { id: 'trim.left', label: msg`Trim roll left`, group: 'trim' },
  { id: 'trim.right', label: msg`Trim roll right`, group: 'trim' },
  { id: 'trim.reset', label: msg`Reset trim`, group: 'trim' },
  { id: 'fire', label: msg`Fire weapon`, group: 'weapons' },
  { id: 'select', label: msg`Select weapon`, group: 'weapons' },
  { id: 'acquire', label: msg`Acquire target`, group: 'weapons' },
  { id: 'radar.undesignate', label: msg`Undesignate target`, group: 'weapons' },
  { id: 'uncage', label: msg`Uncage seeker`, group: 'weapons' },
  { id: 'jammer', label: msg`Jammer`, group: 'weapons' },
  { id: 'radar.silent', label: msg`Radar silent`, group: 'weapons' },
  { id: 'radar.acm', label: msg`Acquisition mode`, group: 'weapons' },
  { id: 'flares', label: msg`Countermeasures`, group: 'weapons' },
  { id: 'jettison.tanks', label: msg`Jettison tanks`, group: 'weapons' },
  { id: 'jettison.emergency', label: msg`Emergency jettison (hold)`, group: 'weapons' },
  { id: 'caution.reset', label: msg`Reset master caution`, group: 'aircraft' },
  { id: 'flaps.extend', label: msg`Extend flaps`, group: 'aircraft' },
  { id: 'flaps.retract', label: msg`Retract flaps`, group: 'aircraft' },
  { id: 'gear', label: msg`Landing gear`, group: 'aircraft' },
  { id: 'hook', label: msg`Arrestor hook`, group: 'aircraft' },
  { id: 'atc', label: msg`Approach power (ATC)`, group: 'aircraft' },
  { id: 'probe', label: msg`Fuel probe`, group: 'aircraft' },
  { id: 'canopy', label: msg`Canopy`, group: 'aircraft' },
  { id: 'fold', label: msg`Wing fold`, group: 'aircraft' },
  { id: 'lights', label: msg`Lights`, group: 'aircraft' },
  { id: 'launch', label: msg`Launch (catapult)`, group: 'aircraft' },
  { id: 'eject', label: msg`Eject`, group: 'aircraft' },
  { id: 'view', label: msg`Cycle view`, group: 'view' },
  { id: 'view.reset', label: msg`Reset view`, group: 'view' },
  { id: 'repeater', label: msg`Display repeater`, group: 'view' },
  { id: 'altitude', label: msg`HUD altitude source`, group: 'view' },
  { id: 'reject', label: msg`HUD declutter`, group: 'view' },
  { id: 'map', label: msg`Map`, group: 'view' },
  { id: 'chat', label: msg`Chat`, group: 'comms' },
  { id: 'shout', label: msg`Chat to everyone`, group: 'comms' },
  { id: 'menu', label: msg`Menu`, group: 'comms' },
]

function JoystickPanel({
  config,
  set,
}: {
  config: MissionConfig
  set: (key: string, value: MissionConfig[string]) => void
}) {
  const { t } = useLingui()
  const { i18n } = useI18n()
  const pads = useGamepads()
  const sticks = (config.sticks ?? {}) as Record<string, StickBindings>
  const known = Array.from(new Set([...pads.map((p) => p.id), ...Object.keys(sticks)]))
  const active = config.joystick && known.includes(config.joystick) ? config.joystick : (pads[0]?.id ?? known[0] ?? '')
  const pad = pads.find((p) => p.id === active) ?? null
  const defaults = deviceDefaults(active, pad?.mapping ?? '')
  const saved = sticks[active]
  const axes = { ...defaults.axes, ...(saved?.axes ?? {}) }
  const buttons = saved?.buttons && Object.keys(saved.buttons).length ? saved.buttons : defaults.buttons
  const axisCount = pad ? pad.axes.length : 10
  const buttonCount = pad ? pad.buttons.length : 24
  const [detecting, setDetecting] = useState<string | null>(null)
  const [baseline, setBaseline] = useState<{ axes: number[]; buttons: boolean[] } | null>(null)

  const store = (nextAxes: Record<string, string>, nextButtons: Record<string, string>) => {
    set('sticks', { ...sticks, [active]: { axes: nextAxes, buttons: nextButtons } })
  }
  const setAxis = (name: string, value: string) => {
    const next = { ...axes, [name]: value }
    if (value !== '')
      for (const other of Object.keys(next)) if (other !== name && next[other].replace('-', '') === value.replace('-', '')) next[other] = ''
    store(next, buttons)
  }
  const setButton = (action: string, value: string) => {
    const next = { ...buttons, [action]: value }
    if (value !== '')
      for (const other of Object.keys(next)) if (other !== action && next[other] === value) next[other] = ''
    store(axes, next)
  }

  const fileRef = useRef<HTMLInputElement>(null)
  const exportProfile = async () => {
    const payload = { air: 'joystick', version: 1, device: active, axes, buttons }
    const name =
      (active.replace(/\s*\(Vendor:.*$/, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'joystick') + '.json'
    const saved = await shellSaveBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), name)
    if (saved) toast.success(t`Profile saved`)
    else toast.error(t`Could not save the profile`)
  }
  const importProfile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const parsed = JSON.parse(await file.text())
      if (parsed?.air !== 'joystick' || typeof parsed.axes !== 'object' || typeof parsed.buttons !== 'object')
        throw new Error('not a profile')
      store({ ...defaults.axes, ...(parsed.axes as Record<string, string>) }, parsed.buttons as Record<string, string>)
      toast.success(t`Profile saved`)
    } catch {
      toast.error(t`Not a joystick profile`)
    }
  }

  useEffect(() => {
    if (!detecting || !pad) return
    if (!baseline) {
      setBaseline({ axes: pad.axes, buttons: pad.buttons })
      return
    }
    const [kind, name] = detecting.split(':')
    if (kind === 'axis') {
      for (let i = 0; i < pad.axes.length; i++) {
        if (Math.abs(pad.axes[i] - (baseline.axes[i] ?? 0)) > 0.6) {
          const reversed = name === 'throttle' && pad.axes[i] > 0
          setAxis(name, (reversed ? '-' : '') + String(i))
          setDetecting(null)
          setBaseline(null)
          return
        }
      }
    } else {
      for (let i = 0; i < pad.buttons.length; i++) {
        if (pad.buttons[i] && !baseline.buttons[i]) {
          setButton(name, String(i))
          setDetecting(null)
          setBaseline(null)
          return
        }
      }
    }
  }, [detecting, pad, baseline]) // eslint-disable-line react-hooks/exhaustive-deps

  const axisOptions = Array.from({ length: axisCount }, (_, i) => String(i))
  const buttonOptions = Array.from({ length: buttonCount }, (_, i) => String(i))

  const [query, setQuery] = useState('')
  const hunt = query.trim().toLowerCase()
  // The same caps the pickers show ("Axis 3", "Button 5"), so searching for
  // what a stick's button is called finds the control it drives - the Keys tab
  // matches its key caps the same way. The variable HAS to be `i` for the macro
  // to reuse the msgid the pickers already ship.
  const cap = (kind: 'axis' | 'button', mapped: string) => {
    const i = String(Number(mapped.replace('-', '')) + 1)
    return kind === 'axis' ? t`Axis ${i}` : t`Button ${i}`
  }
  const shows = (label: MessageDescriptor, mapped: string, kind: 'axis' | 'button') =>
    !hunt ||
    i18n._(label).toLowerCase().includes(hunt) ||
    (mapped !== '' && cap(kind, mapped).toLowerCase().includes(hunt))
  const axisHits = AXIS_ROWS.filter((row) => shows(row.label, axes[row.id] ?? '', 'axis'))
  const buttonHits = BUTTON_ROWS.filter((row) => shows(row.label, buttons[row.id] ?? '', 'button'))

  return (
    <div className='space-y-4'>
      <div className='bg-background sticky top-0 z-10 pb-2'>
        <SearchBox query={query} onQuery={setQuery} />
      </div>
      {/* The device picker stays put while filtering: every mapping below it
          belongs to the selected stick, so hiding it would leave the results
          with nothing saying which device they are for. */}
      <section>
        
          <div className='flex items-center justify-between'>
            <SectionLabel>
              <Trans>Input hardware</Trans>
            </SectionLabel>
            {active !== '' && (
              <Badge variant='outline' className='font-mono text-[10px] text-muted-foreground'>
                {profileFor(active, pad?.mapping ?? '').name}
              </Badge>
            )}
          </div>
        
        <div className='space-y-3'>
          {known.length ? (
            <Select value={active} onValueChange={(v) => set('joystick', v)}>
              <SelectTrigger className='w-full'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {known.map((id) => (
                  <SelectItem key={id} value={id}>
                    {id.replace(/\s*\(Vendor:.*$/, '')}
                    {!pads.some((p) => p.id === id) && (
                      <>
                        {' ('}
                        <Trans>disconnected</Trans>
                        {')'}
                      </>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <div className='text-muted-foreground rounded-lg border border-dashed border-border p-3 text-center text-xs'>
              <Trans>No joystick detected — press any button on it to wake it up.</Trans>
            </div>
          )}

          <div className='flex items-center justify-between gap-2 pt-1'>
            <div className='flex shrink-0 gap-1.5'>
              <Button type='button' size='sm' variant='outline' className='gap-1 text-xs' disabled={active === ''} onClick={exportProfile}>
                <Download className='size-3.5' />
                <Trans>Export</Trans>
              </Button>
              <Button type='button' size='sm' variant='outline' className='gap-1 text-xs' disabled={active === ''} onClick={() => fileRef.current?.click()}>
                <Upload className='size-3.5' />
                <Trans>Import</Trans>
              </Button>
            </div>
            <input ref={fileRef} type='file' accept='application/json,.json' className='hidden' onChange={importProfile} />
          </div>

        </div>
      </section>

      <section hidden={axisHits.length === 0}>

          <SectionLabel>
            <Trans>Axis calibration and mapping</Trans>
          </SectionLabel>

        <div className='space-y-2 text-xs'>
          {axisHits.map(({ id, label }) => {
            const value = axes[id] ?? ''
            const reversed = value.startsWith('-')
            const index = value.replace('-', '')
            const live = pad && index !== '' ? pad.axes[Number(index)] : null
            const vertical = PAIRS.has(id) && pad && index !== '' ? (pad.axes[Number(index) + 1] ?? null) : null
            return (
              <div key={id} className='flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-2.5'>
                <span className='w-24 shrink-0 font-medium text-foreground'>{i18n._(label)}</span>
                {live !== null &&
                  (LEVERS.has(id) ? (
                    <div className='bg-muted relative h-2 min-w-16 flex-1 overflow-hidden rounded border border-border'>
                      <div
                        className='absolute top-0 bottom-0 left-0 rounded transition-all duration-75'
                        style={{
                          width: `${(((id === 'throttle') !== reversed ? 1 - live : live + 1) / 2) * 100}%`,
                          background: 'var(--air-accent)',
                        }}
                      />
                    </div>
                  ) : PAIRS.has(id) ? (
                    <div className='flex min-w-24 flex-1 items-center gap-1.5'>
                      <span className='text-muted-foreground shrink-0 text-xs'>↔</span>
                      <AxisMeter live={live} />
                      <span className='text-muted-foreground shrink-0 text-xs'>↕</span>
                      {vertical !== null ? (
                        <AxisMeter live={vertical} />
                      ) : (
                        <div className='bg-muted/50 h-2 min-w-12 flex-1 rounded border border-dashed border-border' />
                      )}
                    </div>
                  ) : (
                    <AxisMeter live={live} />
                  ))}
                <div className='flex shrink-0 items-center gap-1.5'>
                  <Select value={index === '' ? 'none' : index} onValueChange={(v) => setAxis(id, v === 'none' ? '' : (reversed ? '-' : '') + v)}>
                    <SelectTrigger size='sm' className='h-8 min-w-24 text-xs'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='none'>
                        <Trans>None</Trans>
                      </SelectItem>
                      {axisOptions.map((option) => {
                        const i = String(Number(option) + 1)
                        return (
                          <SelectItem key={option} value={option}>
                            <Trans>Axis {i}</Trans>
                          </SelectItem>
                        )
                      })}
                    </SelectContent>
                  </Select>
                  {!PAIRS.has(id) && index !== '' && (
                    <Button
                      type='button'
                      size='sm'
                      variant={reversed ? 'default' : 'outline'}
                      className='h-8 px-2 text-xs'
                      title={t`Reversed`}
                      onClick={() => setAxis(id, (reversed ? '' : '-') + index)}
                    >
                      ⇄
                    </Button>
                  )}
                  <Button
                    type='button'
                    size='sm'
                    variant='outline'
                    className='h-8 min-w-16 text-xs'
                    disabled={!pad}
                    onClick={() => {
                      setBaseline(null)
                      setDetecting(detecting === 'axis:' + id ? null : 'axis:' + id)
                    }}
                  >
                    {detecting === 'axis:' + id ? <Trans>Move…</Trans> : <Trans>Detect</Trans>}
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <section hidden={buttonHits.length === 0}>

          <SectionLabel>
            <Trans>Button mappings</Trans>
          </SectionLabel>

        <div className='space-y-4'>
          {GROUP_ORDER.map((group) => {
            const rows = buttonHits.filter((r) => r.group === group)
            if (!rows.length) return null
            return (
              <div key={group} className='space-y-1.5'>
                <div className='text-muted-foreground text-xs font-semibold tracking-wider uppercase'>{GROUP_TITLES[group]}</div>
                <div className='grid gap-2 text-xs sm:grid-cols-2'>
                  {rows.map(({ id, label }) => {
                    const value = buttons[id] ?? ''
                    const held = pad && value !== '' && pad.buttons[Number(value)]
                    return (
                      <div
                        key={id}
                        className={`flex items-center justify-between gap-2 rounded-lg border p-2 transition-colors ${
                          held ? 'border-primary bg-primary/10 shadow-xs' : 'border-border bg-card'
                        }`}
                      >
                        <span className={held ? 'text-primary font-bold' : 'text-foreground font-medium'}>{i18n._(label)}</span>
                        <div className='flex shrink-0 items-center gap-1'>
                          <Select value={value === '' ? 'none' : value} onValueChange={(v) => setButton(id, v === 'none' ? '' : v)}>
                            <SelectTrigger size='sm' className='h-7 min-w-20 px-2 text-xs'>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value='none'>
                                <Trans>None</Trans>
                              </SelectItem>
                              {buttonOptions.map((option) => {
                                const i = String(Number(option) + 1)
                                return (
                                  <SelectItem key={option} value={option}>
                                    <Trans>Button {i}</Trans>
                                  </SelectItem>
                                )
                              })}
                            </SelectContent>
                          </Select>
                          <Button
                            type='button'
                            size='sm'
                            variant='outline'
                            className='h-7 px-2 text-xs'
                            disabled={!pad}
                            onClick={() => {
                              setBaseline(null)
                              setDetecting(detecting === 'button:' + id ? null : 'button:' + id)
                            }}
                          >
                            {detecting === 'button:' + id ? <Trans>Press…</Trans> : <Trans>Detect</Trans>}
                          </Button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      {axisHits.length === 0 && buttonHits.length === 0 && <NoMatch query={query} />}
    </div>
  )
}

const VOLUME_ROWS: { id: string; label: ReactNode }[] = [
  { id: 'master', label: <Trans>Master volume</Trans> },
  { id: 'engine', label: <Trans>Engine and afterburner</Trans> },
  { id: 'aircraft', label: <Trans>Wind and cockpit airframe</Trans> },
  { id: 'weapons', label: <Trans>Cannons and ordnance</Trans> },
  { id: 'environment', label: <Trans>Carrier and ambient</Trans> },
  { id: 'alerts', label: <Trans>Betty and RWR alerts</Trans> },
]

function SoundPanel({
  config,
  set,
}: {
  config: MissionConfig
  set: (key: string, value: MissionConfig[string]) => void
}) {
  const volume = { ...DEFAULT_CONFIG.volume, ...((config.volume ?? {}) as Record<string, number>) }
  const sound = config.sound !== false
  return (
    <div className='space-y-4'>
      <SwitchRow
        id='sound'
        label={<Trans>Enable sound</Trans>}
        checked={sound}
        onChange={(v) => set('sound', v)}
      />

      <SectionLabel>
        <Trans>Master volume</Trans>
      </SectionLabel>
      <div className={`flex items-center gap-4 p-3${sound ? '' : ' opacity-50'}`}>
        <Slider
          value={volume.master}
          min={0}
          max={100}
          step={5}
          disabled={!sound}
          className='flex-1'
          onChange={(e) => set('volume', { ...volume, master: parseFloat(e.currentTarget.value) })}
        />
        <span
          className='text-foreground bg-muted rounded border border-border px-1.5 py-0.5 font-mono text-xs font-semibold tabular-nums'
          style={{ fontFamily: 'var(--air-mono)' }}
        >
          {volume.master}%
        </span>
      </div>

      <SectionLabel>
        <Trans>Volumes</Trans>
      </SectionLabel>
      <div className='grid gap-3 sm:grid-cols-2'>
        {VOLUME_ROWS.filter((r) => r.id !== 'master').map(({ id, label }) => (
          <SliderRow
            key={id}
            label={label}
            value={volume[id]}
            min={0}
            max={100}
            step={5}
            decimals={0}
            suffix='%'
            disabled={!sound}
            onChange={(v) => set('volume', { ...volume, [id]: v })}
          />
        ))}
      </div>
    </div>
  )
}

// Both mapping tabs are long lists of one-line controls, so both get the same
// box. It is sticky at the top of the scroll region: on the Keys tab the match
// can be forty rows down, and a filter you cannot see while reading the result
// looks like the app has lost half its controls.
function SearchBox({ query, onQuery }: { query: string; onQuery: (query: string) => void }) {
  const { t } = useLingui()
  return (
    // Logical inset and padding, not left/right: air ships nine RTL locales
    // (ar, ckb, fa, he, ku, ps, sd, ur, yi) and lib/web flips the document
    // direction for them, so a physical `left-2.5` puts the magnifier on top of
    // the Arabic text and the clear button where the magnifier belongs. Same
    // ps-9 the other apps' search fields use.
    <div className='relative'>
      <Search className='text-muted-foreground pointer-events-none absolute top-1/2 start-3 size-4 -translate-y-1/2' />
      <Input
        value={query}
        placeholder={t`Search controls`}
        aria-label={t`Search controls`}
        className='ps-9'
        onChange={(e) => onQuery(e.target.value)}
      />
      {query !== '' && (
        <IconButton
          type='button'
          variant='ghost'
          label={t`Clear`}
          className='text-muted-foreground hover:text-foreground absolute top-1/2 end-1 size-7 -translate-y-1/2'
          onClick={() => onQuery('')}
        >
          <X className='size-4' />
        </IconButton>
      )}
    </div>
  )
}

// Nothing matched the filter, on either mapping tab.
function NoMatch({ query }: { query: string }) {
  return (
    <p className='text-muted-foreground py-6 text-center text-sm'>
      <Trans>No control matches “{query}”.</Trans>
    </p>
  )
}

function KeysPanel({
  config,
  set,
}: {
  config: MissionConfig
  set: (key: string, value: MissionConfig[string]) => void
}) {
  const { t } = useLingui()
  const { i18n } = useI18n()
  const overrides = (config.keys ?? {}) as Record<string, string>
  const [arming, setArming] = useState<string | null>(null)
  // The action a rebind took the key away from. Taking it is right - two
  // controls on one chord is worse - but it used to happen in silence, and the
  // row that lost its key is usually scrolled off screen.
  const [taken, setTaken] = useState<{ from: string; chord: string } | null>(null)
  const [query, setQuery] = useState('')
  const current = (id: string) => overrides[id] ?? KEY_DEFAULTS[id]
  useEffect(() => {
    if (!arming) return
    const capture = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.code === 'Escape') {
        setArming(null)
        return
      }
      if (/^(Shift|Control|Alt|Meta)/.test(e.code)) return
      const chord = (e.shiftKey ? 'Shift+' : '') + e.code
      const next = { ...overrides }
      let stolen: string | null = null
      for (const other of Object.keys(KEY_DEFAULTS))
        if (other !== arming && current(other) === chord) {
          next[other] = 'None'
          stolen = other
        }
      if (KEY_DEFAULTS[arming] === chord) delete next[arming]
      else next[arming] = chord
      set('keys', next)
      setTaken(stolen ? { from: stolen, chord } : null)
      setArming(null)
    }
    window.addEventListener('keydown', capture, { capture: true })
    return () => window.removeEventListener('keydown', capture, { capture: true })
  }, [arming]) // eslint-disable-line react-hooks/exhaustive-deps

  const hunt = query.trim().toLowerCase()
  const found = (row: Row) =>
    !hunt ||
    i18n._(row.label).toLowerCase().includes(hunt) ||
    pretty(current(row.id)).toLowerCase().includes(hunt) // a player looking for what sits on a key searches the CAP, not the action's name
  const hits = KEY_ROWS.filter(found)
  // BUTTON_ROWS too, and a fallback below for the handful of actions the engine
  // knows that neither tab lists: naming nothing is how this went silent in the
  // first place.
  const lost = taken ? [...KEY_ROWS, ...BUTTON_ROWS].find((r) => r.id === taken.from) : undefined

  return (
    <div className='space-y-4'>
      <div className='bg-background sticky top-0 z-10 space-y-2 pb-2'>
        <SearchBox query={query} onQuery={setQuery} />
        {taken && (
          <div className='flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-600'>
            <TriangleAlert className='mt-0.5 size-4 shrink-0' />
            <span className='flex-1'>
              {lost ? (
                <Trans>
                  {pretty(taken.chord)} was on {i18n._(lost.label)}, which is now unbound.
                </Trans>
              ) : (
                <Trans>{pretty(taken.chord)} was already taken, and that control is now unbound.</Trans>
              )}
            </span>
            <IconButton
              type='button'
              variant='ghost'
              label={t`Dismiss`}
              className='size-5 shrink-0'
              onClick={() => setTaken(null)}
            >
              <X className='size-3.5' />
            </IconButton>
          </div>
        )}
      </div>
      {hits.length === 0 && <NoMatch query={query} />}
      {GROUP_ORDER.map((group) => {
        const rows = hits.filter((r) => r.group === group)
        if (!rows.length) return null
        return (
          <section key={group}>

              <SectionLabel>
                {GROUP_TITLES[group]}
              </SectionLabel>

            <div>
              <div className='grid gap-2 text-xs sm:grid-cols-2'>
                {rows.map(({ id, label }) => (
                  <div key={id} className='flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2'>
                    <span className='font-medium text-foreground'>{i18n._(label)}</span>
                    <span className='flex items-center gap-1'>
                      {arming === id ? (
                        <span className='text-primary animate-pulse font-mono text-xs font-semibold'>
                          <Trans>Press a key…</Trans>
                        </span>
                      ) : (
                        <Key>{pretty(current(id))}</Key>
                      )}
                      <Button
                        type='button'
                        size='sm'
                        variant='ghost'
                        className='h-7 px-2 text-xs'
                        onClick={() => setArming(arming === id ? null : id)}
                      >
                        {arming === id ? <Trans>Cancel</Trans> : <Trans>Set</Trans>}
                      </Button>
                      {current(id) !== 'None' && (
                        <Button
                          type='button'
                          size='sm'
                          variant='ghost'
                          className='text-muted-foreground hover:text-destructive h-7 w-7 p-0 text-xs'
                          title={t`None`}
                          onClick={() => set('keys', { ...overrides, [id]: 'None' })}
                        >
                          ✕
                        </Button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )
      })}

      {/* Not rows, so there is nothing here for the search to match: the
          section would just sit under an empty result looking like a hit. */}
      <section hidden={hunt !== ''}>

          <SectionLabel>
            <Trans>Fixed flight keys</Trans>
          </SectionLabel>
        
        <div>
          <div className='grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2'>
            <ControlRow action={<Trans>Views</Trans>} keys={<><Key>1</Key>–<Key>5</Key></>} />
            <ControlRow action={<Trans>Reset view</Trans>} keys={<Key>0</Key>} />
            <ControlRow action={<Trans>Look / orbit</Trans>} keys={<><Key>←</Key><Key>→</Key><Key>↑</Key><Key>↓</Key></>} />
            <ControlRow action={<Trans>Camera distance</Trans>} keys={<><Key>−</Key><Key>=</Key></>} />
          </div>
        </div>
      </section>
    </div>
  )
}

function Key({ children }: { children: ReactNode }) {
  return (
    <kbd className='bg-muted text-foreground border-border shadow-2xs inline-flex items-center justify-center rounded border px-1.5 py-0.5 font-mono text-[11px] font-semibold leading-none'>
      {children}
    </kbd>
  )
}

// #57 parked: keeps the head-tracking catalog entries referenced while head
// tracking is parked, so `lingui extract --clean` preserves their translations.
export const HEAD_MESSAGES = [msg`Head`, msg`Head tracking`, msg`Gain`, msg`Camera unavailable`]

function ControlRow({ action, keys }: { action: ReactNode; keys: ReactNode }) {
  return (
    <div className='flex items-center justify-between gap-4 py-1'>
      <span className='text-muted-foreground'>{action}</span>
      <span className='flex items-center gap-1 whitespace-nowrap'>{keys}</span>
    </div>
  )
}

function GraphicsPanel({
  config,
  set,
  onChange,
}: {
  config: MissionConfig
  set: <K extends keyof MissionConfig>(key: K, value: MissionConfig[K]) => void
  onChange: (config: MissionConfig) => void
}) {
  const active = graphicsPreset(config)
  const presets: { id: GraphicsPreset; label: ReactNode }[] = [
    { id: 'low', label: <Trans>Low</Trans> },
    { id: 'med', label: <Trans>Medium</Trans> },
    { id: 'high', label: <Trans>High</Trans> },
    { id: 'ultra', label: <Trans>Ultra</Trans> },
  ]

  return (
    <div className='space-y-4'>
      <section>
        
          <SectionLabel>
            <Trans>Graphics preset</Trans>
          </SectionLabel>
        
        <div>
          <div className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
            {presets.map((p) => (
              <Button
                key={p.id}
                type='button'
                variant={active === p.id ? 'default' : 'outline'}
                size='sm'
                className='text-xs font-semibold'
                onClick={() => onChange({ ...config, ...GRAPHICS_PRESETS[p.id] })}
              >
                {p.label}
              </Button>
            ))}
          </div>
        </div>
      </section>

      <section>
        
          <SectionLabel>
            <Trans>Detail</Trans>
          </SectionLabel>
        
        <div>
          <div className='grid gap-1 sm:grid-cols-2'>
            <SliderRow
              label={<Trans>Resolution</Trans>}
              value={config.render_scale}
              min={0.4}
              max={2}
              step={0.1}
              decimals={1}
              suffix='×'
              onChange={(v) => set('render_scale', v)}
            />
            <SliderRow
              label={<Trans>Exterior detail</Trans>}
              value={config.exterior_detail}
              min={1}
              max={6}
              step={1}
              onChange={(v) => set('exterior_detail', v)}
            />
            <SliderRow
              label={<Trans>Effects detail</Trans>}
              value={config.effects_quality}
              min={0}
              max={3}
              step={1}
              onChange={(v) => set('effects_quality', v)}
            />
            <SliderRow
              label={<Trans>Ocean detail</Trans>}
              value={config.ocean_segments}
              min={64}
              max={512}
              step={32}
              onChange={(v) => set('ocean_segments', v)}
            />
          </div>
        </div>
      </section>

      <section>
        
          <SectionLabel>
            <Trans>Effects</Trans>
          </SectionLabel>
        
        <div>
          <div className='grid gap-1 sm:grid-cols-2'>
            <SwitchRow
              id='dyn_res'
              tight
              label={<Trans>Dynamic resolution</Trans>}
              checked={config.dyn_res}
              onChange={(v) => set('dyn_res', v)}
            />
            <SwitchRow
              id='lod'
              tight
              label={<Trans>Distance LOD</Trans>}
              checked={config.lod}
              onChange={(v) => set('lod', v)}
            />
            <SwitchRow
              id='shadows'
              tight
              label={<Trans>Shadows</Trans>}
              checked={config.shadows}
              onChange={(v) => set('shadows', v)}
            />
            <SwitchRow
              id='afterburner'
              tight
              label={<Trans>Afterburner</Trans>}
              checked={config.afterburner}
              onChange={(v) => set('afterburner', v)}
            />
            <SwitchRow
              id='tracers'
              tight
              label={<Trans>Tracers</Trans>}
              checked={config.tracers}
              onChange={(v) => set('tracers', v)}
            />
            <SwitchRow
              id='framerate'
              tight
              label={<Trans>Framerate counter</Trans>}
              checked={config.framerate}
              onChange={(v) => set('framerate', v)}
            />
          </div>
        </div>
      </section>
    </div>
  )
}

function GeneralPanel({
  config,
  set,
}: {
  config: MissionConfig
  set: <K extends keyof MissionConfig>(key: K, value: MissionConfig[K]) => void
}) {
  const identity = useIdentityName()
  const [text, setText] = useState(config.callsign)
  useEffect(() => setText(config.callsign), [config.callsign])
  const seeded = useRef(Boolean(config.callsign))
  useEffect(() => {
    if (seeded.current || config.callsign || !identity) return
    seeded.current = true
    set('callsign', identity)
  }, [config.callsign, identity, set])

  return (
    <div className='space-y-4'>
      <section>
        
          <SectionLabel>
            <Trans>Pilot identity</Trans>
          </SectionLabel>
        
        <div className='space-y-2'>
          <Label className='text-xs text-muted-foreground uppercase font-medium'>
            <Trans>Callsign</Trans>
          </Label>
          <Input
            value={text}
            maxLength={32}
            className='max-w-sm font-mono'
            onChange={(e) => {
              setText(e.target.value)
              set('callsign', e.target.value)
            }}
          />
        </div>
      </section>

      <section>
        
          <SectionLabel>
            <Trans>Recording</Trans>
          </SectionLabel>
        
        <div>
          <SwitchRow
            id='record'
            tight
            label={<Trans>Record flights</Trans>}
            checked={config.record !== false}
            onChange={(v) => set('record', v)}
          />
        </div>
      </section>

      <section>
        <SectionLabel>
          <Trans>Hints</Trans>
        </SectionLabel>
        {/* Coaching through the comms area as you fly — the carrier recovery
            procedures first (#70). On by default: the players who need it most
            never find a buried toggle, and it only speaks on approach. */}
        <div>
          <SwitchRow
            id='hints'
            tight
            label={<Trans>Flight hints</Trans>}
            checked={config.hints !== false}
            onChange={(v) => set('hints', v)}
          />
        </div>
      </section>
    </div>
  )
}

export function SettingsDialog({
  open,
  onClose,
  config,
  onChange,
  tab,
  onTabChange,
  guarded,
}: {
  open: boolean
  onClose: () => void
  config: MissionConfig
  onChange: (config: MissionConfig) => void
  tab: string
  onTabChange: (tab: string) => void
  guarded?: boolean
}) {
  const set = <K extends keyof MissionConfig>(key: K, value: MissionConfig[K]) =>
    onChange({ ...config, [key]: value })
  const identity = useIdentityName()
  const { t } = useLingui()

  return (
    // steady: the five tabs differ wildly in height (General is a handful of
    // rows, Keys is sixty), and without a fixed frame the dialog jumped and
    // moved the tab strip out from under the pointer on every switch.
    <MenuDialog
      open={open}
      onClose={onClose}
      guarded={guarded}
      steady
      title={<Trans>Settings</Trans>}
      footer={
        <div className='flex items-center justify-between'>
          <Button
            type='button'
            variant='ghost'
            size='sm'
            className='text-muted-foreground hover:text-foreground gap-1.5 text-xs'
            onClick={() => {
              const fields = TAB_FIELDS[tab] ?? Object.keys(DEFAULT_CONFIG)
              const next = { ...config }
              for (const field of fields) next[field] = DEFAULT_CONFIG[field]
              if (next.callsign === '' && identity) next.callsign = identity
              onChange(next)
            }}
          >
            <RotateCcw className='size-3.5' />
            <Trans>Reset</Trans>
          </Button>
          <Button className='min-w-28 gap-1.5 font-semibold' onClick={onClose}>
            <Check className='size-4' />
            <Trans>Done</Trans>
          </Button>
        </div>
      }
    >
      <Tabs variant='underline' value={tab} onValueChange={onTabChange} className='flex flex-col min-h-0 flex-1 space-y-4'>
        <TabsList aria-label={t`Settings`}>
          <TabsTrigger value='general' className='gap-2'>
            <User className='size-4' />
            <span><Trans>General</Trans></span>
          </TabsTrigger>
          <TabsTrigger value='graphics' className='gap-2'>
            <Monitor className='size-4' />
            <span><Trans>Graphics</Trans></span>
          </TabsTrigger>
          <TabsTrigger value='sound' className='gap-2'>
            <Volume2 className='size-4' />
            <span><Trans>Sound</Trans></span>
          </TabsTrigger>
          <TabsTrigger value='controls' className='gap-2'>
            <Gamepad2 className='size-4' />
            <span><Trans>Joystick</Trans></span>
          </TabsTrigger>
          <TabsTrigger value='keys' className='gap-2'>
            <Keyboard className='size-4' />
            <span><Trans>Keys</Trans></span>
          </TabsTrigger>
        </TabsList>
        <div className='min-h-0 flex-1 overflow-y-auto pr-1'>
          <TabsContent value='general'>
            <GeneralPanel config={config} set={set} />
          </TabsContent>
          <TabsContent value='graphics'>
            <GraphicsPanel config={config} set={set} onChange={onChange} />
          </TabsContent>
          <TabsContent value='sound'>
            <SoundPanel config={config} set={set} />
          </TabsContent>
          <TabsContent value='controls'>
            <JoystickPanel config={config} set={set} />
          </TabsContent>
          <TabsContent value='keys'>
            <KeysPanel config={config} set={set} />
          </TabsContent>
        </div>
      </Tabs>
    </MenuDialog>
  )
}


