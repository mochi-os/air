// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { useEffect, useId, useRef, useState, type ReactNode } from 'react' // #57 parked: useCallback returns with HeadPanel
import { Trans, useLingui } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import { Check, History, LogIn, Pencil, Play, RotateCcw, Send, Settings, TriangleAlert, Users, X } from 'lucide-react'
import { Input } from '@mochi/web/components/ui/input'
import { getErrorMessage, useShellStorage } from '@mochi/web' // #57 parked: toast returns with HeadPanel
import { diagnose } from '../lib/graphics'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@mochi/web/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@mochi/web/components/ui/select'
import { Button } from '@mochi/web/components/ui/button'
import { Slider } from '@mochi/web/components/ui/slider'
import { Switch } from '@mochi/web/components/ui/switch'
import { Label } from '@mochi/web/components/ui/label'
import { Separator } from '@mochi/web/components/ui/separator'
import { RadioGroup, RadioGroupItem } from '@mochi/web/components/ui/radio-group'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@mochi/web/components/ui/dialog'
import {
  DEFAULT_CONFIG,
  GRAPHICS_PRESETS,
  type GraphicsPreset,
  type MissionConfig,
  type StationSlot,
  type StickBindings,
  deviceDefaults,
  seedStart,
} from '../lib/config'
import { useIdentityName } from '../lib/config-store'
import { Multiplayer } from './Multiplayer'
import { Link } from '@tanstack/react-router'
import { KEY_DEFAULTS, pretty } from '../game/keys'
import { PRESETS, asymmetry, matches, normalize, outcome, outcomes, weight, resolve, type Catalog } from '../game/stores'
import { flight_catalog, flight_load } from '../game/flight'
import { LoadoutPreview } from './LoadoutPreview'
import {
  default_server,
  normalize_server,
  world_chat,
  world_withdraw,
  world_say,
  type Join,
  type WorldChatLine,
} from '../game/net'

// The fields each tab owns, for the per-tab Reset (the joystick tab also clears
// the per-device maps so built-in defaults apply again).
const TAB_FIELDS: Record<string, string[]> = {
  mission: ['task', 'start', 'cat', 'world', 'aircraft', 'bandit', 'fuel', 'stores', 'cheats', 'tod', 'clouds'],
  general: ['callsign', 'record'],
  controls: ['invert', 'joystick', 'sticks'],
  keys: ['keys'],
  sound: ['sound', 'volume'],
  graphics: ['render_scale', 'dyn_res', 'lod', 'shadows', 'exterior_detail', 'effects_quality', 'ocean_segments', 'afterburner', 'tracers', 'framerate'],   // missiles moved to the mission tab: they are a rule of the fight, not a rendering choice
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className='text-muted-foreground mt-4 mb-2 text-xs font-medium tracking-wide uppercase first:mt-0'>
      {children}
    </div>
  )
}

// Input configuration (#74). Bindings are per-device: cfg.sticks[pad.id] holds the
// axis and button maps for that stick, and cfg.keys remaps the keyboard actions.
interface PadState {
  id: string
  axes: number[]
  buttons: boolean[]
}

// Live poll of connected pads — the Gamepad API has no change events for values.
function useGamepads(): PadState[] {
  const [pads, setPads] = useState<PadState[]>([])
  useEffect(() => {
    const timer = setInterval(() => {
      const raw = navigator.getGamepads ? navigator.getGamepads() : []
      const list: PadState[] = []
      for (const p of raw) {
        if (p && p.connected && p.axes.length >= 2)
          list.push({ id: p.id, axes: Array.from(p.axes), buttons: p.buttons.map((b) => b.pressed) })
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

// Binding rows are grouped so the lists read as a cockpit rather than a wall:
// the same six groups order both the key and the button panels, and a group
// with no rows in a panel simply doesn't appear there.
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
type Row = { id: string; label: ReactNode; group: Group }

const AXIS_ROWS: { id: string; label: ReactNode }[] = [
  { id: 'pitch', label: <Trans>Pitch</Trans> },
  { id: 'roll', label: <Trans>Roll</Trans> },
  { id: 'yaw', label: <Trans>Yaw</Trans> },
  { id: 'throttle', label: <Trans>Throttle</Trans> },
  { id: 'speedbrake', label: <Trans>Speed brake</Trans> },
  { id: 'look', label: <Trans>Look</Trans> }, // an axis PAIR: the chosen index is horizontal, the next one up is vertical
  { id: 'trim', label: <Trans>Trim hat</Trans> }, // an axis PAIR too (a POV that reports as two axes): forward = nose down, the aviation convention
  { id: 'zoom', label: <Trans>Zoom</Trans> }, // spring-centred wheel: deflection = zoom rate on the view (or the map when open)
]
const LEVERS = new Set(['throttle', 'speedbrake']) // lever-style rows: min-to-max meter + reverse toggle

const BUTTON_ROWS: Row[] = [
  { id: 'brake.speed', label: <Trans>Speed brake</Trans>, group: 'flight' },
  { id: 'brake.wheel', label: <Trans>Wheel brakes</Trans>, group: 'flight' },
  { id: 'override', label: <Trans>Override G limit</Trans>, group: 'flight' },
  { id: 'trim.up', label: <Trans>Trim nose up</Trans>, group: 'trim' },
  { id: 'trim.down', label: <Trans>Trim nose down</Trans>, group: 'trim' },
  { id: 'trim.left', label: <Trans>Trim roll left</Trans>, group: 'trim' },
  { id: 'trim.right', label: <Trans>Trim roll right</Trans>, group: 'trim' },
  { id: 'guns', label: <Trans>Fire weapon</Trans>, group: 'weapons' },   // the trigger serves the SELECTED weapon (engine.ts: guns in GUN mode, a 9M in 9M mode), so 'Guns' named only half of what it does
  { id: 'select', label: <Trans>Select weapon</Trans>, group: 'weapons' },
  { id: 'acquire', label: <Trans>Acquire target</Trans>, group: 'weapons' },
  { id: 'radar.undesignate', label: <Trans>Undesignate target</Trans>, group: 'weapons' },   // #30
  { id: 'radar.silent', label: <Trans>Radar silent</Trans>, group: 'weapons' },   // #30
  { id: 'radar.acm', label: <Trans>Acquisition mode</Trans>, group: 'weapons' },   // #30: boresight <-> vertical
  { id: 'flares', label: <Trans>Countermeasures</Trans>, group: 'weapons' },   // the id stays 'flares' (the action); the label is the real dispenser's name
  { id: 'jettison.tanks', label: <Trans>Jettison tanks</Trans>, group: 'weapons' },
  { id: 'jettison.emergency', label: <Trans>Emergency jettison (hold)</Trans>, group: 'weapons' },
  { id: 'caution.reset', label: <Trans>Reset master caution</Trans>, group: 'aircraft' },
  { id: 'flaps.extend', label: <Trans>Extend flaps</Trans>, group: 'aircraft' },
  { id: 'flaps.retract', label: <Trans>Retract flaps</Trans>, group: 'aircraft' },
  { id: 'gear', label: <Trans>Landing gear</Trans>, group: 'aircraft' },
  { id: 'hook', label: <Trans>Arrestor hook</Trans>, group: 'aircraft' },
  { id: 'atc', label: <Trans>Approach power (ATC)</Trans>, group: 'aircraft' },
  { id: 'launch', label: <Trans>Launch (catapult)</Trans>, group: 'aircraft' },
  { id: 'lights', label: <Trans>Lights</Trans>, group: 'aircraft' },
  { id: 'view', label: <Trans>Cycle view</Trans>, group: 'view' },
  { id: 'view.reset', label: <Trans>Reset view</Trans>, group: 'view' },
  { id: 'repeater', label: <Trans>Display repeater</Trans>, group: 'view' },
  { id: 'look.up', label: <Trans>Look up</Trans>, group: 'view' },
  { id: 'look.down', label: <Trans>Look down</Trans>, group: 'view' },
  { id: 'look.left', label: <Trans>Look left</Trans>, group: 'view' },
  { id: 'look.right', label: <Trans>Look right</Trans>, group: 'view' },
  { id: 'look.target', label: <Trans>Look at target</Trans>, group: 'view' }, // hold to look at the boxed target
  { id: 'zoom.in', label: <Trans>Zoom in</Trans>, group: 'view' },
  { id: 'zoom.out', label: <Trans>Zoom out</Trans>, group: 'view' },
]

const KEY_ROWS: Row[] = [
  { id: 'pitch.up', label: <Trans>Pitch up</Trans>, group: 'flight' },
  { id: 'pitch.down', label: <Trans>Pitch down</Trans>, group: 'flight' },
  { id: 'roll.left', label: <Trans>Roll left</Trans>, group: 'flight' },
  { id: 'roll.right', label: <Trans>Roll right</Trans>, group: 'flight' },
  { id: 'yaw.left', label: <Trans>Yaw left</Trans>, group: 'flight' },
  { id: 'yaw.right', label: <Trans>Yaw right</Trans>, group: 'flight' },
  { id: 'throttle.up', label: <Trans>Throttle up</Trans>, group: 'flight' },
  { id: 'throttle.down', label: <Trans>Throttle down</Trans>, group: 'flight' },
  { id: 'brake.speed', label: <Trans>Speed brake</Trans>, group: 'flight' },
  { id: 'brake.wheel', label: <Trans>Wheel brakes</Trans>, group: 'flight' },
  { id: 'brake.parking', label: <Trans>Parking brake</Trans>, group: 'flight' },
  { id: 'override', label: <Trans>Override G limit</Trans>, group: 'flight' },
  { id: 'trim.up', label: <Trans>Trim nose up</Trans>, group: 'trim' },
  { id: 'trim.down', label: <Trans>Trim nose down</Trans>, group: 'trim' },
  { id: 'trim.left', label: <Trans>Trim roll left</Trans>, group: 'trim' },
  { id: 'trim.right', label: <Trans>Trim roll right</Trans>, group: 'trim' },
  { id: 'trim.reset', label: <Trans>Reset trim</Trans>, group: 'trim' },
  { id: 'guns', label: <Trans>Fire weapon</Trans>, group: 'weapons' },
  { id: 'select', label: <Trans>Select weapon</Trans>, group: 'weapons' },
  { id: 'acquire', label: <Trans>Acquire target</Trans>, group: 'weapons' },
  { id: 'radar.undesignate', label: <Trans>Undesignate target</Trans>, group: 'weapons' },   // #30
  { id: 'radar.silent', label: <Trans>Radar silent</Trans>, group: 'weapons' },   // #30
  { id: 'radar.acm', label: <Trans>Acquisition mode</Trans>, group: 'weapons' },   // #30: boresight <-> vertical
  { id: 'flares', label: <Trans>Countermeasures</Trans>, group: 'weapons' },
  { id: 'jettison.tanks', label: <Trans>Jettison tanks</Trans>, group: 'weapons' },
  { id: 'jettison.emergency', label: <Trans>Emergency jettison (hold)</Trans>, group: 'weapons' },
  { id: 'caution.reset', label: <Trans>Reset master caution</Trans>, group: 'aircraft' },
  { id: 'flaps.extend', label: <Trans>Extend flaps</Trans>, group: 'aircraft' },
  { id: 'flaps.retract', label: <Trans>Retract flaps</Trans>, group: 'aircraft' },
  { id: 'gear', label: <Trans>Landing gear</Trans>, group: 'aircraft' },
  { id: 'hook', label: <Trans>Arrestor hook</Trans>, group: 'aircraft' },
  { id: 'atc', label: <Trans>Approach power (ATC)</Trans>, group: 'aircraft' },
  { id: 'probe', label: <Trans>Fuel probe</Trans>, group: 'aircraft' },
  { id: 'canopy', label: <Trans>Canopy</Trans>, group: 'aircraft' },
  { id: 'fold', label: <Trans>Wing fold</Trans>, group: 'aircraft' },
  { id: 'lights', label: <Trans>Lights</Trans>, group: 'aircraft' },
  { id: 'launch', label: <Trans>Launch (catapult)</Trans>, group: 'aircraft' },
  { id: 'eject', label: <Trans>Eject</Trans>, group: 'aircraft' },
  { id: 'view', label: <Trans>Cycle view</Trans>, group: 'view' },
  { id: 'view.reset', label: <Trans>Reset view</Trans>, group: 'view' },
  { id: 'repeater', label: <Trans>Display repeater</Trans>, group: 'view' },
  { id: 'altitude', label: <Trans>HUD altitude source</Trans>, group: 'view' },
  { id: 'reject', label: <Trans>HUD declutter</Trans>, group: 'view' },
  { id: 'map', label: <Trans>Map</Trans>, group: 'view' },
  { id: 'chat', label: <Trans>Chat</Trans>, group: 'comms' },
  { id: 'shout', label: <Trans>Chat to everyone</Trans>, group: 'comms' },
  { id: 'menu', label: <Trans>Menu</Trans>, group: 'comms' },
]

// The joystick tab: device picker, aircraft-axis sources, button actions —
// dropdowns plus press-to-detect, saved per device id.
function JoystickPanel({
  config,
  set,
}: {
  config: MissionConfig
  set: (key: string, value: MissionConfig[string]) => void
}) {
  const { t } = useLingui()
  const pads = useGamepads()
  const sticks = (config.sticks ?? {}) as Record<string, StickBindings>
  const known = Array.from(new Set([...pads.map((p) => p.id), ...Object.keys(sticks)]))
  const active = config.joystick && known.includes(config.joystick) ? config.joystick : (pads[0]?.id ?? known[0] ?? '')
  const pad = pads.find((p) => p.id === active) ?? null
  const defaults = deviceDefaults(active)
  const saved = sticks[active]
  const axes = { ...defaults.axes, ...(saved?.axes ?? {}) }
  const buttons = saved?.buttons && Object.keys(saved.buttons).length ? saved.buttons : defaults.buttons
  const axisCount = pad ? pad.axes.length : 10
  const buttonCount = pad ? pad.buttons.length : 24
  const [detecting, setDetecting] = useState<string | null>(null) // "axis:pitch" | "button:guns"
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

  // press-to-detect: watch the live pad against the armed baseline
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
          // throttle: sweep to FULL — a full stop above zero means idle sits at the low end (reversed)
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

  return (
    <div>
      <SectionLabel>
        <Trans>Device</Trans>
      </SectionLabel>
      {known.length ? (
        <Select value={active} onValueChange={(v) => set('joystick', v)}>
          <SelectTrigger className='w-full'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {known.map((id) => (
              <SelectItem key={id} value={id}>
                {id.replace(/\s*\(Vendor:.*$/, '')}
                {!pads.some((p) => p.id === id) && ' — '}
                {!pads.some((p) => p.id === id) && <Trans>disconnected</Trans>}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <div className='text-muted-foreground text-sm'>
          <Trans>No joystick detected — press any button on it to wake it up.</Trans>
        </div>
      )}
      <div className='mt-4 space-y-4'>
        <SwitchRow
          id='invert'
          label={<Trans>Invert pitch</Trans>}
          checked={config.invert}
          onChange={(v) => set('invert', v)}
        />
      </div>
      <SectionLabel>
        <Trans>Axes</Trans>
      </SectionLabel>
      <div className='grid gap-y-1 text-sm'>
        {AXIS_ROWS.map(({ id, label }) => {
          const value = axes[id] ?? ''
          const reversed = value.startsWith('-')
          const index = value.replace('-', '')
          const live = pad && index !== '' ? pad.axes[Number(index)] : null
          return (
            <div key={id} className='flex items-center justify-between gap-2 py-0.5'>
              <span className='w-24 shrink-0'>{label}</span>
              {live !== null && (
                <div className='bg-muted relative h-2 min-w-10 flex-1 overflow-hidden rounded'>
                  {/* levers show travel min..max as a left-anchored fill (throttle: power; speed brake: deployment); the flight axes stay centred +/- */}
                  {LEVERS.has(id) ? (
                    <div
                      className='bg-primary absolute top-0 bottom-0 left-0 rounded'
                      style={{ width: `${(((id === 'throttle') !== reversed ? 1 - live : live + 1) / 2) * 100}%` }}
                    />
                  ) : (
                    <>
                      <div className='bg-border absolute top-0 bottom-0 left-1/2 w-px' />
                      <div
                        className='bg-primary absolute top-0 bottom-0 rounded'
                        style={{ left: `${50 + Math.min(0, live) * 50}%`, width: `${Math.abs(live) * 50}%` }}
                      />
                    </>
                  )}
                </div>
              )}
              <span className='flex shrink-0 items-center gap-1'>
                <Select value={index === '' ? 'none' : index} onValueChange={(v) => setAxis(id, v === 'none' ? '' : (reversed ? '-' : '') + v)}>
                  <SelectTrigger size='sm' className='min-w-28'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='none'>
                      <Trans>None</Trans>
                    </SelectItem>
                    {axisOptions.map((i) => (
                      <SelectItem key={i} value={i}>
                        <Trans>Axis {i}</Trans>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {LEVERS.has(id) && index !== '' && (
                  <Button
                    type='button'
                    size='sm'
                    variant={reversed ? 'default' : 'outline'}
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
                  disabled={!pad}
                  onClick={() => {
                    setBaseline(null)
                    setDetecting(detecting === 'axis:' + id ? null : 'axis:' + id)
                  }}
                >
                  {detecting === 'axis:' + id ? <Trans>Move it…</Trans> : <Trans>Detect</Trans>}
                </Button>
              </span>
            </div>
          )
        })}
      </div>
      <SectionLabel>
        <Trans>Buttons</Trans>
      </SectionLabel>
      {GROUP_ORDER.map((group) => {
        const rows = BUTTON_ROWS.filter((r) => r.group === group)
        if (!rows.length) return null
        return (
          <div key={group} className='mb-2'>
            <div className='text-muted-foreground mt-2 mb-1 text-xs font-medium tracking-wide uppercase'>{GROUP_TITLES[group]}</div>
            <div className='grid gap-y-1 text-sm'>
        {rows.map(({ id, label }) => {
          const value = buttons[id] ?? ''
          const held = pad && value !== '' && pad.buttons[Number(value)]
          return (
            <div key={id} className='flex items-center justify-between gap-2 py-0.5'>
              <span className={held ? 'text-primary' : undefined}>{label}</span>
              <span className='flex shrink-0 items-center gap-1'>
                <Select value={value === '' ? 'none' : value} onValueChange={(v) => setButton(id, v === 'none' ? '' : v)}>
                  <SelectTrigger size='sm' className='min-w-28'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='none'>
                      <Trans>None</Trans>
                    </SelectItem>
                    {buttonOptions.map((i) => (
                      <SelectItem key={i} value={i}>
                        <Trans>Button {i}</Trans>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  disabled={!pad}
                  onClick={() => {
                    setBaseline(null)
                    setDetecting(detecting === 'button:' + id ? null : 'button:' + id)
                  }}
                >
                  {detecting === 'button:' + id ? <Trans>Press it…</Trans> : <Trans>Detect</Trans>}
                </Button>
              </span>
            </div>
          )
        })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// The sound tab: master switch plus a per-bus mixer. Buses mirror the audio
// module's routing (audio.ts): engine = turbines/afterburner, aircraft = wind,
// buffet, actuators, deck events, own fires and hits, weapons = gun/missiles/
// flares/explosions, environment = deck ambience and other aircraft, alerts =
// the cockpit tones.
const VOLUME_ROWS: { id: string; label: ReactNode }[] = [
  { id: 'master', label: <Trans>Master</Trans> },
  { id: 'engine', label: <Trans>Engine</Trans> },
  { id: 'aircraft', label: <Trans>Aircraft</Trans> },
  { id: 'weapons', label: <Trans>Weapons</Trans> },
  { id: 'environment', label: <Trans>Environment</Trans> },
  { id: 'alerts', label: <Trans>Alerts</Trans> },
]

function SoundPanel({
  config,
  set,
}: {
  config: MissionConfig
  set: (key: string, value: MissionConfig[string]) => void
}) {
  const volume = { ...DEFAULT_CONFIG.volume, ...((config.volume ?? {}) as Record<string, number>) }
  return (
    <div className='space-y-4'>
      <SwitchRow
        id='sound'
        label={<Trans>Sound</Trans>}
        checked={config.sound !== false}
        onChange={(v) => set('sound', v)}
      />
      {VOLUME_ROWS.map(({ id, label }) => (
        <SliderRow
          key={id}
          label={label}
          value={volume[id]}
          min={0}
          max={100}
          step={5}
          decimals={0}
          suffix='%'
          onChange={(v) => set('volume', { ...volume, [id]: v })}
        />
      ))}
    </div>
  )
}

// The keyboard tab: every remappable action with click-to-capture rebinding.
function KeysPanel({
  config,
  set,
}: {
  config: MissionConfig
  set: (key: string, value: MissionConfig[string]) => void
}) {
  const overrides = (config.keys ?? {}) as Record<string, string>
  const [arming, setArming] = useState<string | null>(null)
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
      if (/^(Shift|Control|Alt|Meta)/.test(e.code)) return // a bare modifier isn't a binding — wait for the full chord
      const chord = (e.shiftKey ? 'Shift+' : '') + e.code
      const next = { ...overrides }
      for (const other of Object.keys(KEY_DEFAULTS)) if (other !== arming && current(other) === chord) next[other] = 'None'
      if (KEY_DEFAULTS[arming] === chord) delete next[arming]
      else next[arming] = chord
      set('keys', next)
      setArming(null)
    }
    window.addEventListener('keydown', capture, { capture: true })
    return () => window.removeEventListener('keydown', capture, { capture: true })
  }, [arming]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      {GROUP_ORDER.map((group) => {
        const rows = KEY_ROWS.filter((r) => r.group === group)
        if (!rows.length) return null
        return (
          <div key={group} className='mb-2'>
            <div className='text-muted-foreground mt-2 mb-1 text-xs font-medium tracking-wide uppercase'>{GROUP_TITLES[group]}</div>
            <div className='grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2'>
        {rows.map(({ id, label }) => (
          <div key={id} className='flex items-center justify-between gap-2 py-0.5'>
            <span>{label}</span>
            <span className='flex items-center gap-1'>
              {arming === id ? (
                <span className='text-muted-foreground animate-pulse'>
                  <Trans>Press a key…</Trans>
                </span>
              ) : (
                <Key>{pretty(current(id))}</Key>
              )}
              <Button type='button' size='sm' variant='outline' onClick={() => setArming(arming === id ? null : id)}>
                {arming === id ? <Trans>Cancel</Trans> : <Trans>Set</Trans>}
              </Button>
              {current(id) !== 'None' && (
                <Button type='button' size='sm' variant='outline' title='None' onClick={() => set('keys', { ...overrides, [id]: 'None' })}>
                  ✕
                </Button>
              )}
            </span>
          </div>
        ))}
            </div>
          </div>
        )
      })}
      <SectionLabel>
        <Trans>Fixed keys</Trans>
      </SectionLabel>
      {/* Genuinely fixed keys only. The probe, canopy and menu rows used to be
          listed here as well as being rebindable above, and the probe entry
          still read Shift+F after that chord became flaps-retract — a settings
          screen that lies is worse than one that says less. */}
      <div className='grid gap-x-8 text-sm sm:grid-cols-2'>
        <ControlRow action={<Trans>Views</Trans>} keys={<><Key>1</Key>–<Key>5</Key></>} />
        <ControlRow action={<Trans>Reset view</Trans>} keys={<Key>0</Key>} />
        <ControlRow action={<Trans>Look / orbit</Trans>} keys={<><Key>←</Key><Key>→</Key><Key>↑</Key><Key>↓</Key></>} />
        <ControlRow action={<Trans>Camera distance</Trans>} keys={<><Key>−</Key><Key>=</Key></>} />
      </div>
    </div>
  )
}

function Key({ children }: { children: ReactNode }) {
  return (
    <kbd className='bg-muted text-foreground inline-block rounded border px-1.5 py-0.5 font-mono text-xs leading-none'>
      {children}
    </kbd>
  )
}

// A standard single-select radio group laid out inline.
function Choice<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (value: T) => void
  options: { value: T; label: ReactNode }[]
}) {
  const baseId = useId()
  return (
    <RadioGroup
      value={value}
      onValueChange={(v) => onChange(v as T)}
      className='flex flex-wrap gap-x-6 gap-y-2'
    >
      {options.map((o) => {
        const id = `${baseId}-${o.value}`
        return (
          <div key={o.value} className='flex items-center gap-2'>
            <RadioGroupItem value={o.value} id={id} />
            <Label htmlFor={id} className='cursor-pointer font-normal'>
              {o.label}
            </Label>
          </div>
        )
      })}
    </RadioGroup>
  )
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  suffix,
  decimals = 0,
  onChange,
}: {
  label: ReactNode
  value: number
  min: number
  max: number
  step: number
  suffix?: string
  decimals?: number
  onChange: (value: number) => void
}) {
  // i18n-format-ok: technical engine setting (resolution factor, segment count), not a locale-sensitive quantity
  const display = (decimals ? value.toFixed(decimals) : String(value)) + (suffix ?? '')
  return (
    <div className='space-y-1.5'>
      <div className='flex items-center justify-between'>
        <Label className='font-normal'>{label}</Label>
        <span className='text-muted-foreground text-sm tabular-nums'>{display}</span>
      </div>
      <Slider
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(parseFloat(e.currentTarget.value))}
      />
    </div>
  )
}

/* #57 parked — head tracking is disabled for now. To re-enable, uncomment this
panel, the Head tab JSX below, the toast/useCallback imports, the head blocks in
game/engine.ts, config.head in lib/config.ts, and 'head' in the SetupTab type.
// Head tab (#57): webcam head tracking. The enable switch IS the camera
// permission gesture (the shell raises the browser prompt from it); the
// mirrored preview doubles as the tracking check — its border lights while a
// face is held. One gain knob; the deadzone and filter constants stay
// internal. The camera runs only while this tab is open and the switch is on;
// in flight the engine owns its own session.
function HeadPanel({ config, set }: { config: MissionConfig; set: (key: string, value: MissionConfig[string]) => void }) {
  const { t } = useLingui()
  const on = !!(config.head ?? {}).on
  const gain = (config.head ?? {}).gain || 5
  const [camera, setCamera] = useShellStorage('air.camera', '')
  const [devices, setDevices] = useState<{ id: string; label: string }[]>([])
  const [face, setFace] = useState(false)
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const session = useRef<{ stop: () => void } | null>(null)
  const generation = useRef(0)

  const halt = useCallback(() => {
    generation.current++
    session.current?.stop()
    session.current = null
    setFace(false)
  }, [])

  const begin = useCallback(
    async (device: string) => {
      halt()
      const mine = ++generation.current
      const base = new URL('tracking-1.0.1/', window.location.href).href
      const { start } = await import('../game/head')
      const opened = await start({
        base,
        model: base + 'face_landmarker.task',
        device,
        preview: (frame) => {
          const c = canvas.current
          if (!c) return
          const x = c.getContext('2d')
          if (!x) return
          x.save()
          x.scale(-1, 1) // the mirror view people expect of themselves
          x.drawImage(frame, -c.width, 0, c.width, c.height)
          x.restore()
        },
          pose: (p) => setFace(p.ok),
        end: (reason) => {
          if (generation.current === mine) {
            session.current = null
            setFace(false)
            // The session died underneath us (worker failure, camera unplug):
            // a silently frozen preview looks like a bug — drop the switch and
            // say why, exactly like a failed open.
            set('head', { ...(config.head ?? {}), on: 0 })
            toast.error(reason || t`Camera unavailable`)
          }
        },
      })
      if (generation.current !== mine) {
        opened.head?.stop()
        return
      }
      if (opened.head) {
        session.current = opened.head
        setDevices(opened.head.devices)
      } else {
        set('head', { ...(config.head ?? {}), on: 0 })
        setCamera('') // a failed open invalidates any remembered selection — never let a stale pick linger
        toast.error(opened.error || t`Camera unavailable`)
      }
    },
    // config.head identity churn (the gain slider) must not cycle the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [halt, t]
  )

  useEffect(() => {
    if (on) void begin(camera)
    return halt
    // Restarted explicitly on device change; only the switch cycles the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on])

  return (
    <div className='space-y-4'>
      <SwitchRow
        id='head-on'
        label={<Trans>Head tracking</Trans>}
        checked={on}
        onChange={(v) => set('head', { ...(config.head ?? {}), on: v ? 1 : 0 })}
      />
      {on && (
        <>
          <canvas
            ref={canvas}
            width={320}
            height={240}
            className={'aspect-4/3 w-full rounded-lg border-2 ' + (face ? 'border-emerald-500' : 'border-border')}
          />
          {devices.length > 1 && (
            <Select
              value={camera || devices[0]?.id || ''}
              onValueChange={(v) => {
                setCamera(v)
                void begin(v)
              }}
            >
              <SelectTrigger className='w-full'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {devices.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.label || d.id.slice(0, 8)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <SliderRow
            label={<Trans>Gain</Trans>}
            value={gain}
            min={2}
            max={8}
            step={0.5}
            decimals={1}
            onChange={(v) => set('head', { ...(config.head ?? {}), gain: v })}
          />
        </>
      )}
    </div>
  )
}
*/

// #57 parked: keeps the head-tracking catalog entries referenced while the
// panel above is commented out, so `lingui extract --clean` preserves their
// translations in every locale.
export const HEAD_MESSAGES = [msg`Head`, msg`Head tracking`, msg`Gain`, msg`Camera unavailable`]

function SwitchRow({
  id,
  label,
  checked,
  onChange,
}: {
  id: string
  label: ReactNode
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <div className='flex items-center justify-between gap-4'>
      <Label htmlFor={id} className='cursor-pointer font-normal'>
        {label}
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

function ControlRow({ action, keys }: { action: ReactNode; keys: ReactNode }) {
  return (
    <div className='flex items-center justify-between gap-4 py-1'>
      <span>{action}</span>
      <span className='flex items-center gap-1 whitespace-nowrap'>{keys}</span>
    </div>
  )
}

// The loadout editor (#17, reworked for first-time readability): the live
// head-on jet on top — a station choice reads on the aircraft itself — then
// the three presets with plain one-line descriptions, and the per-station
// editor folded behind "Customize loadout". Inside, stations are labelled by
// POSITION ("Left wingtip", "Centerline"…, the NATOPS number as a small
// annotation) and each offers ONE dropdown of meaningful end states with the
// fixture derived underneath (game/stores.ts outcomes) — players choose
// "AIM-9" or "Fuel tank", never rail-versus-pylon vocabulary. Numbers come
// from the flight core's catalog, loaded on demand so the menu works before
// any mission starts. Edits build ONE new loadout and call onChange once.
// When `allowed` is false (a guns-only match rule) missile outcomes are
// ABSENT — not greyed; the persisted choice is never written back.
function Armament({
  stores,
  fuel,
  allowed,
  catapult,
  onChange,
  onFuel,
  onPreset,
}: {
  stores: Record<string, StationSlot>
  fuel: number
  allowed: boolean
  catapult: boolean
  onChange: (stores: Record<string, StationSlot>) => void
  onFuel: (fuel: number) => void
  onPreset: (stores: Record<string, StationSlot>, fuel: number) => void
}) {
  const read = () => {
    const raw = flight_catalog('fa18c')
    return raw ? resolve(raw) : null
  }
  const [book, setBook] = useState<Catalog | null>(read)
  const [custom, setCustom] = useState(() => matches(normalize(stores)) === '') // a custom loadout opens its settings on entry; presets start folded
  useEffect(() => {
    if (book) return
    let gone = false
    void flight_load().then(() => {
      if (!gone) setBook(read())
    })
    return () => {
      gone = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book])
  const loadout = normalize(stores)
  const preset = matches(loadout)
  const positions: Record<number, ReactNode> = {
    1: <Trans>Left wingtip</Trans>,
    2: <Trans>Left wing</Trans>,
    3: <Trans>Left wing</Trans>,
    4: <Trans>Fuselage</Trans>,
    5: <Trans>Centerline</Trans>,
    6: <Trans>Fuselage</Trans>,
    7: <Trans>Right wing</Trans>,
    8: <Trans>Right wing</Trans>,
    9: <Trans>Right wingtip</Trans>,
  }
  const label = (id: string): ReactNode => {
    switch (id) {
      case '9m':
        return 'AIM-9M' // designations verbatim, like the Reference dialog's V-speeds
      case '9m2':
        return '2× AIM-9M' // jsx-text-ok: a count and a designation, no prose
      case 'tank':
        return <Trans>Fuel tank</Trans>
      case 'pylon':
        return <Trans>Empty pylon</Trans>
      case 'twin1':
      case 'twin1b':
        return 'AIM-9M' // legacy hand-built twin with one round: shown, never offered
      case 'twin0':
        return <Trans>Empty pylon</Trans>
      default:
        return <Trans>None</Trans>
    }
  }
  const presets: { name: 'gun' | 'fox2' | 'cap'; title: ReactNode }[] = [
    { name: 'gun', title: <Trans>Gun fighter</Trans> },
    { name: 'fox2', title: <Trans>Fox 2 fighter</Trans> },
    { name: 'cap', title: 'CAP' },
  ]
  // A preset press SEEDS the fuel load (the duel standard for the fighters,
  // full internal for CAP); the checkmark keeps tracking stores only, so the
  // slider stays freely overridable without un-checking the preset.
  const FUELS = { gun: 6000, fox2: 6000, cap: 10800 }
  const w = book ? weight(loadout, book) : { hardware: 0, fuel: 0 }
  const gross = book ? Math.round(((book.empty + w.hardware + w.fuel) * 2.2046 + fuel) / 10) * 10 : 0
  // NATOPS flying-qualities boundary for routine catapult technique: at or
  // below 48,000 lb a hands-off rotation is benign. No v1 loadout can reach
  // it (the warning arms when heavier stores arrive); warn, never clamp.
  const LAUNCH = 48000
  // NATOPS 4.1.5 lateral asymmetry, kg·m → ft·lb: the jet genuinely flies
  // the moment (each store's mass sits at its buttline), so an uneven fill
  // gets its readout — and its 6,000 ft·lb catapult limit when the mission
  // starts on the cat. Warn, never clamp, like the launch weight above.
  const moment = book ? Math.round((Math.abs(asymmetry(loadout, book)) * 7.233) / 10) * 10 : 0
  const CATAPULT = 6000
  return (
    <div className='space-y-3'>
      <LoadoutPreview stores={loadout} />
      <div className='flex flex-wrap gap-2'>
        {presets.map((entry) => (
          <Button key={entry.name} type='button' variant='outline' size='sm' onClick={() => onPreset(structuredClone(PRESETS[entry.name]), FUELS[entry.name])}>
            {preset === entry.name && <Check className='size-4' />}
            {entry.title}
          </Button>
        ))}
        {/* Custom rides the preset row: it carries the check when the loadout
            matches no preset, and toggles the station strip — which stays open
            across preset presses, so pressing each preset SHOWS its contents
            in the dropdowns below. */}
        <Button type='button' variant='outline' size='sm' onClick={() => setCustom(!custom)}>
          {preset === '' && <Check className='size-4' />}
          <Trans>Custom</Trans>
        </Button>
      </div>
      {custom &&
        (() => {
          const cell = (station: number) => {
            const slot = loadout[String(station)]
            const open = outcomes(station).filter((o) => allowed || !o.slot.stores.includes('9m'))
            const current = outcome(station, slot)
            const usable = open.filter((o) => !o.hidden || o.id === current)
            const dead = usable.length <= 1
            return (
              <div key={station} className='space-y-1'>
                <div className='text-muted-foreground text-xs'>
                  {positions[station]} <span className='opacity-60'>{station}</span>
                </div>
                {dead ? (
                  <div className='text-muted-foreground/60 py-1.5 text-sm'>—</div>
                ) : (
                  <Select
                    value={current || 'none'}
                    onValueChange={(v) => {
                      const picked = open.find((o) => (o.id || 'none') === v)
                      if (picked) onChange({ ...loadout, [String(station)]: structuredClone(picked.slot) })
                    }}
                  >
                    <SelectTrigger size='sm' className='w-full'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {usable.map((o) => (
                        <SelectItem key={o.id || 'none'} value={o.id || 'none'}>
                          {label(o.id)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )
          }
          // Three columns MIRRORING the nose-on jet above: head-on, the
          // jet's right wing is on the viewer's LEFT. Each column runs
          // wingtip at the top to fuselage at the bottom; the centerline
          // bottom-aligns with the fuselage row.
          return (
            <div className='grid grid-cols-3 gap-x-3'>
              <div className='space-y-2'>{[9, 8, 7, 6].map(cell)}</div>
              <div className='flex flex-col justify-end'>{[5].map(cell)}</div>
              <div className='space-y-2'>{[1, 2, 3, 4].map(cell)}</div>
            </div>
          )
        })()}
      <SliderRow label={<Trans>Internal fuel</Trans>} value={fuel} min={1500} max={10800} step={100} decimals={0} suffix=' lb' onChange={onFuel} />
      {book && (
        <div className='text-sm'>
          {/* jsx-text-ok: LB is the cockpit's own unit annunciation, verbatim like the IFEI */}
          <Trans>Gross weight</Trans> {gross} lb
          {gross > LAUNCH && (
            <div className='mt-1 flex items-center gap-1.5 text-amber-500'>
              <TriangleAlert className='size-4' />
              <Trans>{gross - LAUNCH} lb over maximum launch weight</Trans>
            </div>
          )}
          {moment > 0 && (
            <div className='mt-1'>
              {/* jsx-text-ok: ft·lb is the unit annunciation, verbatim like lb above */}
              <Trans>Asymmetry</Trans> {moment} ft·lb
            </div>
          )}
          {catapult && moment > CATAPULT && (
            <div className='mt-1 flex items-center gap-1.5 text-amber-500'>
              <TriangleAlert className='size-4' />
              <Trans>{moment - CATAPULT} ft·lb over the catapult asymmetry limit</Trans>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
// The measured F/A-18C performance reference (#89): every number flown out of
// the flight model by tools/vspeeds.sh (world repo) — rerun it after flight
// changes and update these cells. Cells are TRUE KCAS, matching the HUD box:
// flight/frames.go Cas() carries the compressible pitot term (#133), so the
// 15,000/30,000 ft cells sit up to ~20 kt above the harness's KEAS printout
// (convert with the compressible formula; sea level is the identity).
// Ranges span light (11.2 t, minimum fuel) to heavy (15.6 t, full internal).
// Rows in sortie order: climb, engine-out, dash, combat, landing. Rotation
// (Vr) is deliberately absent: nosewheel liftoff depends on weight, CG, and
// technique (NATOPS gives no single speed), so a one-number row would
// mislead. The V-speed designations (Vx, Vy, Vs1, Vs0, Vapp, Vyse) are
// international aviation abbreviations and stay verbatim in every locale; the
// descriptive phrase around each is translated. id is the stable React key
// (the label is now a translated node, not a plain string).
const REFERENCE_ROWS: { id: string; label: ReactNode; cells: [string, string, string] }[] = [
  // Regenerated 2026-08-07 against today's flight model (tools/vspeeds.sh,
  // corner acceptance stabilised first — the old cells were recalibration
  // history, corner reading 298 where the jet flies 339). Each cell is
  // light-to-heavy (11.2 t minimum-fuel to 15.6 t full-internal), and the
  // heavy figure is written second even where it is the LOWER speed — the
  // column meaning outranks ascending cosmetics.
  { id: 'vx-mil', label: <Trans>Steepest climb (Vx, 100% thrust)</Trans>, cells: ['186-318', '270-337', '284-343'] },
  { id: 'vx-ab', label: <Trans>Steepest climb (Vx, afterburner)</Trans>, cells: ['Vertical', '229-219', '192-259'] },
  { id: 'vy-mil', label: <Trans>Best climb (Vy, 100% thrust)</Trans>, cells: ['562-576', '445-387', '342-348'] },
  { id: 'vy-ab', label: <Trans>Best climb (Vy, afterburner)</Trans>, cells: ['600-530', '463-475', '354-273'] },
  { id: 'vyse', label: <Trans>Single-engine best climb (Vyse, afterburner)</Trans>, cells: ['359-433', '366-232', '178-199'] },
  { id: 'glide', label: <Trans>Best glide (engines out)</Trans>, cells: ['223-263', '225-266', '229-274'] },
  { id: 'corner', label: <Trans>Corner speed (best instant turn)</Trans>, cells: ['339-386', '337-392', '336-340'] },
  { id: 'sustained', label: <Trans>Best sustained turn speed</Trans>, cells: ['373-470', '408-437', '326-328'] },
  { id: 'tightest', label: <Trans>Tightest sustained turn speed</Trans>, cells: ['167-196', '173-197', '186-201'] },
  { id: 'vs1', label: <Trans>Stall, clean (Vs1)</Trans>, cells: ['159-186', '159-187', '161-191'] },
  { id: 'vs0', label: <Trans>Stall, landing config (Vs0)</Trans>, cells: ['110-126', '108-126', '—'] },
  { id: 'vapp', label: <Trans>Approach, on-speed (Vapp)</Trans>, cells: ['126-148', '126-147', '—'] },
]

function ReferenceDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type='button' variant='link' size='sm' className='text-muted-foreground'>
          <Trans>Reference</Trans>
        </Button>
      </DialogTrigger>
      <DialogContent className='sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>
            <Trans>F/A-18C reference</Trans>
          </DialogTitle>
        </DialogHeader>
        <div className='overflow-x-auto'>
          <table className='w-full text-sm'>
            <thead>
              <tr className='text-muted-foreground border-b text-left'>
                <th className='py-1.5 pr-3 font-medium'></th>
                <th className='px-3 py-1.5 text-right font-medium'>
                  <Trans>Sea level</Trans>
                </th>
                <th className='px-3 py-1.5 text-right font-medium'>
                  <Trans>15,000 AMSL</Trans>
                </th>
                <th className='px-3 py-1.5 text-right font-medium'>
                  <Trans>30,000 AMSL</Trans>
                </th>
              </tr>
            </thead>
            <tbody>
              {REFERENCE_ROWS.map((row) => (
                <tr key={row.id} className='border-b border-dashed last:border-0'>
                  <td className='py-1.5 pr-3 whitespace-nowrap'>{row.label}</td>
                  {row.cells.map((cell, i) => (
                    <td key={i} className='text-muted-foreground px-3 py-1.5 text-right tabular-nums whitespace-nowrap'>
                      {cell === 'Vertical' ? <Trans>Vertical</Trans> : cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className='text-muted-foreground space-y-1 text-xs leading-relaxed'>
          <p>
            <Trans>
              Speeds in KCAS, as a range from light (minimum fuel, no stores) to heavy (maximum
              gross). Data derived experimentally in-game. Any differences from the real aircraft
              reflect simulator flight model errors.
            </Trans>
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function CreditsDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type='button' variant='link' size='sm' className='text-muted-foreground'>
          <Trans>Credits</Trans>
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Credits</Trans>
          </DialogTitle>
        </DialogHeader>
        <div className='text-muted-foreground space-y-3 text-sm'>
          <p className='leading-relaxed'>
            <Trans>
              Aircraft model <b>“F/A-18C Hornet”</b> by <b>CreadorDeMu</b> (Sketchfab), licensed
              under <b>CC BY 4.0</b>. Modified: reoriented and rescaled, unused texture payload
              removed, external stores split into a separate file, one shroud mesh mirrored.
            </Trans>{' '}
            <a
              className='text-primary hover:underline'
              href='https://sketchfab.com/3d-models/fa-18c-hornet-1cc5824033d84185b9bf8b222d9bb068'
              target='_blank'
              rel='noopener noreferrer'
            >
              {/* jsx-text-ok: attribution name, required verbatim by the source licence */}
              Sketchfab
            </a>{' '}
            ·{' '}
            <a
              className='text-primary hover:underline'
              href='https://creativecommons.org/licenses/by/4.0/'
              target='_blank'
              rel='noopener noreferrer'
            >
              {/* jsx-text-ok: attribution name, required verbatim by the source licence */}
              CC BY 4.0
            </a>
          </p>
          <p className='leading-relaxed'>
            <Trans>
              Aircraft carrier <b>“USS Nimitz CVN-68 Aircraft Carrier”</b> by{' '}
              <b>Muhamad Mirza Arrafi</b> (Sketchfab), licensed under <b>CC BY 4.0</b>. Modified:
              rescaled, reoriented, sunk to the waterline, and simplified for the web.
            </Trans>{' '}
            <a
              className='text-primary hover:underline'
              href='https://sketchfab.com/3d-models/uss-nimitz-cvn-68-aircraft-carrier-06cf0dba66874934a105b3fe2bfdb0f7'
              target='_blank'
              rel='noopener noreferrer'
            >
              {/* jsx-text-ok: attribution name, required verbatim by the source licence */}
              Sketchfab
            </a>{' '}
            ·{' '}
            <a
              className='text-primary hover:underline'
              href='https://creativecommons.org/licenses/by/4.0/'
              target='_blank'
              rel='noopener noreferrer'
            >
              {/* jsx-text-ok: attribution name, required verbatim by the source licence */}
              CC BY 4.0
            </a>
          </p>
          <p className='leading-relaxed'>
            <Trans>
              Midway Atoll map — imagery contains modified <b>Copernicus Sentinel-2</b> data (2026);
              airfield geometry (runway, taxiways, aprons) © <b>OpenStreetMap</b> contributors,
              licensed under <b>ODbL</b>; coastline and reef data from <b>NOAA NCCOS</b> (public
              domain).
            </Trans>{' '}
            <a
              className='text-primary hover:underline'
              href='https://dataspace.copernicus.eu/'
              target='_blank'
              rel='noopener noreferrer'
            >
              {/* jsx-text-ok: attribution name, required verbatim by the source licence */}
              Copernicus
            </a>{' '}
            ·{' '}
            <a
              className='text-primary hover:underline'
              href='https://www.openstreetmap.org/copyright'
              target='_blank'
              rel='noopener noreferrer'
            >
              {/* jsx-text-ok: attribution name, required verbatim by the source licence */}
              OpenStreetMap
            </a>{' '}
            ·{' '}
            <a
              className='text-primary hover:underline'
              href='https://coastalscience.noaa.gov/'
              target='_blank'
              rel='noopener noreferrer'
            >
              {/* jsx-text-ok: attribution name, required verbatim by the source licence */}
              NOAA NCCOS
            </a>
          </p>
          <p className='leading-relaxed'>
            <Trans>
              Rendering by <b>three.js</b> (MIT licence).
            </Trans>{' '}
            <a
              className='text-primary hover:underline'
              href='https://threejs.org/'
              target='_blank'
              rel='noopener noreferrer'
            >
              {/* jsx-text-ok: attribution name, required verbatim by the source licence */}
              three.js
            </a>
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// The server-wide lobby chat (#84): sits beside the menu so anyone browsing —
// whether or not they've picked a match — can talk about what to fly next.
// Player lines are {name, text}; system lines are structured events rendered
// in the viewer's language. It follows the world server configured on the
// Mission tab, falling back to this host's conventional lobby port.
function LobbyChat({ server, callsign }: { server: string; callsign: string }) {
  const { t } = useLingui()
  const identity = useIdentityName()
  const [lounge, setLounge] = useState<WorldChatLine[]>([])
  const [error, setError] = useState('')
  const [up, setUp] = useState(true) // optimistic until the first poll answers
  const cursor = useRef(0)
  const lineRef = useRef<HTMLInputElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const address = normalize_server(server || default_server())
  const name = (callsign || identity || t`pilot`).slice(0, 32)

  // Poll while the menu is open. This audience has no game connection, so plain
  // HTTP; an unreachable world server just leaves the lobby empty and quiet.
  useEffect(() => {
    cursor.current = 0
    setLounge([])
    let alive = true
    const pull = async () => {
      try {
        const reply = await world_chat(address, cursor.current)
        if (!alive) return
        cursor.current = reply.sequence
        if (reply.lines.length) setLounge((have) => [...have, ...reply.lines].slice(-100))
        setUp(true)
      } catch {
        if (alive) setUp(false) // no reachable world server — the empty state says so
      }
    }
    void pull()
    const chatter = setInterval(pull, 3000)
    return () => {
      alive = false
      clearInterval(chatter)
    }
  }, [address])

  useEffect(() => {
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight })
  }, [lounge])

  const say = async () => {
    const words = lineRef.current?.value.trim()
    if (!words) return
    if (lineRef.current) lineRef.current.value = ''
    try {
      await world_say(address, name, words)
      const reply = await world_chat(address, cursor.current)
      cursor.current = reply.sequence
      if (reply.lines.length) setLounge((have) => [...have, ...reply.lines].slice(-100))
      setError('')
      setUp(true)
    } catch (e) {
      // A fetch-level failure carries the browser's raw "Failed to fetch" —
      // when the server is (or just went) unreachable, say that instead.
      setUp(false)
      setError(up ? getErrorMessage(e, t`Could not send the message`) : t`World server not reachable`)
    }
  }

  return (
    <div className='flex h-full flex-col'>
      <div className='text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase'>
        <Trans>Server chat</Trans>
      </div>
      <div ref={boxRef} className='flex-1 space-y-0.5 overflow-y-auto rounded-md border p-2 text-sm'>
        {lounge.length === 0 && (
          <div className='text-muted-foreground text-xs'>
            {up ? <Trans>Nothing yet — say hello.</Trans> : <Trans>No world server.</Trans>}
          </div>
        )}
        {lounge.map((line) =>
          line.event === 'made' ? (
            <div key={line.sequence} className='text-muted-foreground text-xs italic'>
              <Trans>
                {line.name} created “{line.label}”
              </Trans>
            </div>
          ) : (
            <div key={line.sequence} className='break-words'>
              <span className='text-muted-foreground'>{line.name}: </span>
              {line.text}
            </div>
          )
        )}
      </div>
      {error && <div className='text-destructive mt-1 text-xs'>{error}</div>}
      <div className='mt-2 flex gap-2'>
        <Input
          ref={lineRef}
          maxLength={200}
          placeholder={t`Message players on this server`}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void say()
          }}
        />
        <Button type='button' variant='outline' onClick={() => void say()}>
          <Send className='size-4' />
          <Trans>Send</Trans>
        </Button>
      </div>
    </div>
  )
}

const STARTS: Record<string, ReactNode> = {
  air: <Trans>In air</Trans>,
  runway: <Trans>On runway</Trans>,
  carrier: <Trans>On carrier</Trans>,
  case1: <Trans>Case I</Trans>,
  case2: <Trans>Case II</Trans>,
  case3: <Trans>Case III</Trans>,
}

// MenuDialog is the one shell every menu surface opens in: title, scroll, and
// Esc/backdrop dismissal, so each dialog body is just its content.
function MenuDialog({
  open,
  onClose,
  title,
  wide,
  children,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  wide?: boolean
  children: ReactNode
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className={wide ? 'sm:max-w-4xl' : 'sm:max-w-2xl'}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  )
}

// ServerFlow is the multiplayer half of the menu: pick a server (recents
// first — typing a hostname every time would sting), then a full page of the
// matches it is offering beside its lobby chat. A MATCH is you against each
// other: created, offered, joined, left — never paused or restarted by one
// participant, which is why none of the mission verbs appear here.
function ServerFlow({
  open,
  onClose,
  config,
  set,
  onChange,
  onJoin,
}: {
  open: boolean
  onClose: () => void
  config: MissionConfig
  set: <K extends keyof MissionConfig>(key: K, value: MissionConfig[K]) => void
  onChange: (config: MissionConfig) => void
  onJoin: (join: Join) => void
}) {
  const [entered, setEntered] = useState(false)
  const [address, setAddress] = useState(config.world || '')
  // The pilot token identifies the owner of a match offer across reconnects.
  // It is minted when the player actually enters a server — NOT in an effect at
  // mount: this component is mounted (closed) from the first render, and a
  // write then races config/load, persisting a defaults-shaped config over the
  // saved one. That is the PendingConfig hazard useMissionConfig documents, and
  // it cost a saved callsign.
  const pilot = config.pilot || crypto.randomUUID()
  // Recents live beside the rest of the mission config so they persist with it.
  const recents = String(config.servers ?? '').split('\n').filter(Boolean)
  const enter = (server: string) => {
    const chosen = server.trim() || default_server()
    const next = { ...config, world: chosen, pilot }
    onChange({ ...next, servers: [chosen, ...recents.filter((r) => r !== chosen)].slice(0, 5).join('\n') }) // one write: consecutive set() calls each spread the render's config
    setEntered(true)
  }
  const leave = () => {
    // Leaving the page withdraws any offer you were making: an offer is
    // presence-scoped — you are offering a match while you are here. The
    // server's heartbeat grace only has to cover a tab that vanished.
    void world_withdraw(normalize_server(config.world || default_server()), pilot)
    setEntered(false)
    onClose()
  }
  if (!open) return null
  if (!entered) {
    return (
      <MenuDialog open onClose={onClose} title={<Trans>Join server</Trans>}>
        <div className='space-y-4'>
          {recents.length > 0 && (
            <div className='space-y-2'>
              <SectionLabel>
                <Trans>Recent</Trans>
              </SectionLabel>
              <div className='flex flex-col gap-1'>
                {recents.map((r) => (
                  <Button key={r} type='button' variant='outline' className='justify-start font-mono text-sm' onClick={() => enter(r)}>
                    {r}
                  </Button>
                ))}
              </div>
            </div>
          )}
          <div className='space-y-2'>
            <SectionLabel>
              <Trans>Server</Trans>
            </SectionLabel>
            <Input
              value={address}
              placeholder={default_server()}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && enter(address)}
            />
          </div>
          <div className='flex justify-end'>
            <Button onClick={() => enter(address)}>
              <LogIn className='size-4' />
              <Trans>Connect</Trans>
            </Button>
          </div>
        </div>
      </MenuDialog>
    )
  }
  return (
    // The page OWNS the viewport height: a full-height flex column whose two
    // columns fill it, each scrolling its own overflow. Previously the page
    // scrolled as one block and both columns were content-height, so a server
    // with a handful of matches drew everything squashed against the top with
    // the rest of the screen empty — and the chat, which asks for h-full, had
    // no height to fill.
    <div className='bg-background fixed inset-0 z-50 flex flex-col p-6'>
      <div className='mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-6 lg:flex-row'>
        <div className='flex min-h-0 min-w-0 flex-1 flex-col'>
          <div className='mb-4 flex items-center justify-between'>
            <div>
              <h2 className='text-2xl font-semibold tracking-tight'>
                <Trans>Matches</Trans>
              </h2>
              <p className='text-muted-foreground font-mono text-xs'>{config.world}</p>
            </div>
            <Button type='button' variant='outline' onClick={leave}>
              <X className='size-4' />
              <Trans>Leave server</Trans>
            </Button>
          </div>
          <Multiplayer
            rules={config.rules}
            onRules={(rules) => set('rules', rules)}
            stores={config.stores}
            hideServer
            pilot={pilot}
            server={config.world}
            callsign={config.callsign}
            onServer={(v) => set('world', v)}
            onCallsign={(v) => set('callsign', v)}
            onJoin={(info) => {
              // Flying somebody else's match retires your own offer: you can
              // hold one, and you are no longer waiting in it.
              void world_withdraw(normalize_server(config.world || default_server()), pilot)
              onJoin(info)
            }}
          />
        </div>
        <div className='flex min-h-0 w-full flex-col max-lg:h-96 lg:w-80'>
          <LobbyChat server={config.world} callsign={config.callsign} />
        </div>
      </div>
    </div>
  )
}

// ---- panels: each former tab body, now mounted inside its dialog ----

function MissionPanel({
  config,
  set,
  setCheat,
  onChange,
}: {
  config: MissionConfig
  set: <K extends keyof MissionConfig>(key: K, value: MissionConfig[K]) => void
  setCheat: (name: string, value: boolean) => void
  onChange: (config: MissionConfig) => void
}) {
  return (
    <div className='sm:grid sm:grid-cols-2 sm:gap-x-10'>
    <div>
<SectionLabel>
  <Trans>Task</Trans>
</SectionLabel>
<Choice
  value={config.task}
  onChange={(v) => set('task', v)}
  options={[
    { value: 'free', label: <Trans>Free flight</Trans> },
    { value: 'joust', label: <Trans>Joust 1v1</Trans> },
  ]}
/>
{config.task === 'joust' && (
  <>
    <SectionLabel>
      <Trans>Bandit</Trans>
    </SectionLabel>
    <Choice
      value={String(config.bandit || 'ace')}
      onChange={(v) => set('bandit', v as 'novice' | 'pilot' | 'ace' | 'superhuman')}
      options={[
        { value: 'novice', label: <Trans>Novice</Trans> },
        { value: 'pilot', label: <Trans>Pilot</Trans> },
        { value: 'ace', label: <Trans>Ace</Trans> },
        { value: 'superhuman', label: <Trans>Superhuman</Trans> },
      ]}
    />
  </>
)}

{config.task === 'free' && (
  <>
    {/* joust always starts at the symmetric merge, so the start choice applies to free flight only */}
    <SectionLabel>
      <Trans>Start</Trans>
    </SectionLabel>
    <Choice
      value={config.start === 'landing' ? 'case2' : config.start}
      onChange={(v) => {
        // A recovery case IS a weather definition — and a fuel state:
        // picking one seeds the authentic conditions and the arrival gas
        // (seedStart), visibly and freely overridable. One onChange with
        // every seeded field: consecutive set() calls each spread the
        // RENDER's config, so the last would revert the start (the same
        // React-batch clobber the cheats ref works around).
        onChange(seedStart(config, v as MissionConfig['start']))
      }}
      options={[
        { value: 'air', label: <Trans>In air</Trans> },
        { value: 'runway', label: <Trans>On runway</Trans> },
        { value: 'carrier', label: <Trans>On carrier</Trans> },
        { value: 'case1', label: <Trans>Case I (day)</Trans> },
        { value: 'case2', label: <Trans>Case II (weather)</Trans> },
        { value: 'case3', label: <Trans>Case III (night)</Trans> },
      ]}
    />
    {config.start === 'carrier' && (
      <>
        <SectionLabel>
          <Trans>Catapult</Trans>
        </SectionLabel>
        <Choice
          value={String(config.cat)}
          onChange={(v) => set('cat', parseInt(v, 10))}
          options={[
            { value: '1', label: '1' },
            { value: '2', label: '2' },
            { value: '3', label: '3' },
            { value: '4', label: '4' },
          ]}
        />
      </>
    )}
  </>
)}
<SectionLabel>
  <Trans>Time of day</Trans>
</SectionLabel>
<Choice
  value={config.tod}
  onChange={(v) => set('tod', v)}
  options={[
    { value: 'day', label: <Trans>Day</Trans> },
    { value: 'night', label: <Trans>Night</Trans> },
  ]}
/>
<SectionLabel>
  <Trans>Clouds</Trans>
</SectionLabel>
<Choice
  value={config.clouds}
  onChange={(v) => set('clouds', v)}
  options={[
    { value: 'none', label: <Trans>None</Trans> },
    { value: 'cumulus', label: <Trans>Cumulus</Trans> },
    { value: 'high_stratus', label: <Trans>High stratus</Trans> },
    { value: 'mid_stratus', label: <Trans>Mid stratus</Trans> },
    { value: 'low_stratus', label: <Trans>Low stratus</Trans> },
  ]}
/>
</div>
    <div>
<SectionLabel>
  <Trans>Loadout</Trans>
</SectionLabel>
{/* The loadout (#17) is a rule of the fight, like the opponent's skill.
    Presets are one-tap fills that also SEED the fuel load (freely
    overridable after, like the Start cases seed weather); the strip edits
    per station; the joust derives missiles-allowed from whether any missile
    is loaded. onPreset writes stores AND fuel in ONE config patch — two
    set() calls in a batch clobber each other. */}
<Armament
  stores={config.stores}
  fuel={Number(config.fuel) || 10800}
  allowed={true}
  catapult={config.start === 'carrier'}
  onChange={(v) => set('stores', v)}
  onFuel={(v) => set('fuel', v)}
  onPreset={(stores, fuel) => onChange({ ...config, stores, fuel })}
/>
{/* a MATCH takes its cheats from the creator's rules instead — these are the mission's */}
<SectionLabel>
  <Trans>Cheats</Trans>
</SectionLabel>
<div className='space-y-2'>
  <SwitchRow
    id='cheat-invulnerable'
    label={<Trans>Invulnerable (human players only)</Trans>}
    checked={!!(config.cheats ?? {}).invulnerable}
    onChange={(v) => setCheat('invulnerable', v)}
  />
  <SwitchRow
    id='cheat-ammunition'
    label={<Trans>Unlimited ammunition</Trans>}
    checked={!!(config.cheats ?? {}).ammunition}
    onChange={(v) => setCheat('ammunition', v)}
  />
  <SwitchRow
    id='cheat-fuel'
    label={<Trans>Unlimited fuel</Trans>}
    checked={!!(config.cheats ?? {}).fuel}
    onChange={(v) => setCheat('fuel', v)}
  />
</div>
    </div>
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
  return (
    <div className='space-y-4'>
<div>
  <SectionLabel>
    <Trans>Preset</Trans>
  </SectionLabel>
  <div className='flex flex-wrap gap-2'>
    {(['low', 'med', 'high', 'ultra'] as GraphicsPreset[]).map((p) => (
      <Button
        key={p}
        type='button'
        variant='outline'
        size='sm'
        className='min-w-20 flex-1'
        onClick={() => onChange({ ...config, ...GRAPHICS_PRESETS[p] })}
      >
        {p === 'low' ? (
          <Trans>Low</Trans>
        ) : p === 'med' ? (
          <Trans>Medium</Trans>
        ) : p === 'high' ? (
          <Trans>High</Trans>
        ) : (
          <Trans>Ultra</Trans>
        )}
      </Button>
    ))}
  </div>
</div>
<div className='grid gap-4 sm:grid-cols-2'>
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
<Separator />
<div className='grid gap-3 sm:grid-cols-2'>
  <SwitchRow
    id='dyn_res'
    label={<Trans>Dynamic resolution</Trans>}
    checked={config.dyn_res}
    onChange={(v) => set('dyn_res', v)}
  />
  <SwitchRow
    id='lod'
    label={<Trans>Distance LOD</Trans>}
    checked={config.lod}
    onChange={(v) => set('lod', v)}
  />
  <SwitchRow
    id='shadows'
    label={<Trans>Shadows</Trans>}
    checked={config.shadows}
    onChange={(v) => set('shadows', v)}
  />
  <SwitchRow
    id='afterburner'
    label={<Trans>Afterburner</Trans>}
    checked={config.afterburner}
    onChange={(v) => set('afterburner', v)}
  />
  <SwitchRow
    id='tracers'
    label={<Trans>Tracers</Trans>}
    checked={config.tracers}
    onChange={(v) => set('tracers', v)}
  />
  <SwitchRow
    id='framerate'
    label={<Trans>Framerate</Trans>}
    checked={config.framerate}
    onChange={(v) => set('framerate', v)}
  />
</div>
    </div>
  )
}

// General is the player's own identity and preferences — the things that are
// neither sortie (the mission dialog) nor hardware (the tabs beside it).
function GeneralPanel({
  config,
  set,
}: {
  config: MissionConfig
  set: <K extends keyof MissionConfig>(key: K, value: MissionConfig[K]) => void
}) {
  // The identity name IS the default, applied at render. Seeding it into the
  // stored config is not reliable on its own: useMissionConfig can take the
  // flush path (a locally-dirty config wins and is pushed to the server), which
  // discards whatever the load seeded — which is why two earlier attempts, one
  // in an effect and one inside loadConfig, both left the field blank. Showing
  // it here cannot be raced or discarded, and the first edit makes it explicit.
  const identity = useIdentityName()
  // Local text state, seeded from the stored callsign or the identity default.
  // Deriving the displayed value as `callsign || identity` instead made the
  // field un-clearable: emptying it re-showed the identity name on the very next
  // render, so select-all-delete looked like it did nothing. The seed runs only
  // while nothing is stored, so it cannot fight an edit.
  const [text, setText] = useState(config.callsign)
  useEffect(() => setText(config.callsign), [config.callsign]) // follow the config, so Reset lands in the field
  const seeded = useRef(Boolean(config.callsign)) // already had one at mount: never seed, so clearing it stays cleared
  useEffect(() => {
    // Seed ONCE. Re-seeding whenever the value is empty made the field
    // un-clearable: select-all-delete was undone on the next render. A
    // deliberately blank callsign is now allowed to stay blank.
    if (seeded.current || config.callsign || !identity) return
    seeded.current = true
    set('callsign', identity)
  }, [config.callsign, identity, set])
  return (
    <>
      <SectionLabel>
        <Trans>Callsign</Trans>
      </SectionLabel>
      <Input
        value={text}
        maxLength={32}
        className='max-w-xs'
        onChange={(e) => {
          setText(e.target.value)
          set('callsign', e.target.value)
        }}
      />
      <SectionLabel>
        <Trans>Recording</Trans>
      </SectionLabel>
      {/* Always-on by design: a recording you have to remember to start is one
          you only ever have for dull flights. Saved from the History page. */}
      <SwitchRow
        id='record'
        label={<Trans>Record flights</Trans>}
        checked={config.record !== false}
        onChange={(v) => set('record', v)}
      />
    </>
  )
}

export function MissionSetup({
  config,
  onChange,
  tab,
  onTabChange,
  settingsNonce = 0,
  gameInProgress,
  onStart,
  onJoin,
  onResume,
  onRestart,
}: {
  config: MissionConfig
  onChange: (config: MissionConfig) => void
  tab: string
  onTabChange: (tab: string) => void
  settingsNonce?: number
  gameInProgress: boolean
  onStart: () => void
  onJoin: (join: Join) => void
  onResume: () => void
  onRestart: () => void
}) {
  const set = <K extends keyof MissionConfig>(key: K, value: MissionConfig[K]) =>
    onChange({ ...config, [key]: value })

  // Cheat toggles accumulate through a ref: spreading config.cheats from the
  // render clobbers sibling flags when several switches flip inside one React
  // batch (config only re-renders between batches).
  const cheats = useRef<Record<string, boolean>>({})
  cheats.current = { ...((config.cheats as Record<string, boolean>) ?? {}) }
  const setCheat = (name: string, value: boolean) => {
    cheats.current = { ...cheats.current, [name]: value }
    set('cheats', cheats.current)
  }




  // The menu is a front page plus dialogs (#77): one decision per surface.
  // "Mission" is you against the world — configured, owned, pausable; "match"
  // is you against each other — created, offered, joined, and never paused by
  // one participant. The vocabulary is load-bearing, not decorative.
  const [dialog, setDialog] = useState<string | null>(null)
  const { t } = useLingui()
  // Graphics warnings (#55): one banner, three diagnoses, one visible at a
  // time — each names its culprit so the player knows whether to change
  // browser, flip an acceleration setting, or change machine. The capability
  // verdicts are probed here at mount; the performance one is written by the
  // engine's frame-time governor after a sustained pinned-at-the-floor
  // flight, per DEVICE (shell storage, never the cross-device config).
  const [verdict] = useState(() => diagnose())
  const [strained] = useShellStorage('air.performance', 0)
  const [dismissed, setDismissed] = useShellStorage('air.graphics', '')
  const alert = verdict ?? (strained ? 'performance' : null)
  const fromFlight = useRef(false)
  useEffect(() => {
    if (settingsNonce) {
      fromFlight.current = true // remember the visit is a detour from flight
      setDialog('settings')
    }
  }, [settingsNonce])
  const identity = useIdentityName()
  const close = () => {
    // Settings reached from the Esc menu is a detour: ANY dismissal (Done, Esc,
    // backdrop) returns to flight rather than stranding the player on the front
    // page with one more Resume click to make.
    const back = fromFlight.current && dialog === 'settings' && gameInProgress
    fromFlight.current = false
    setDialog(null)
    if (back) onResume()
  }
  // The label must describe what Fly actually does: a joust ignores the start
  // selector entirely (the engine spawns both jets at the merge), so showing
  // the start read as a deck start that then began airborne.
  // Composed from msgids the bandit selector and task label already carry, so
  // every locale is covered with no new translation surface.
  const BANDITS: Record<string, ReactNode> = {
    novice: <Trans>Novice</Trans>,
    pilot: <Trans>Pilot</Trans>,
    ace: <Trans>Ace</Trans>,
    superhuman: <Trans>Superhuman</Trans>,
  }
  const started =
    config.task === 'joust' ? (
      <>
        <Trans>Joust</Trans> · {BANDITS[String(config.bandit || 'ace')] ?? BANDITS.ace}
      </>
    ) : (
      STARTS[config.start === 'landing' ? 'case2' : config.start]
    )

  return (
    <div className='bg-background fixed inset-0 z-50 flex items-center justify-center overflow-auto p-6'>
      <div className='w-full max-w-md'>
        {/* jsx-text-ok: the game's name, verbatim in every locale */}
        <h1 className='mb-8 text-4xl font-semibold tracking-tight'>Air</h1>
        {alert && dismissed !== alert && (
          <div className='mb-4 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-600'>
            <TriangleAlert className='mt-0.5 size-4 shrink-0' />
            <div className='flex-1'>
              {alert === 'webgl2' ? (
                <Trans>This browser does not support WebGL 2, so the game cannot run — try a different browser.</Trans>
              ) : alert === 'software' ? (
                <Trans>Hardware graphics acceleration is off — check browser settings or graphics drivers.</Trans>
              ) : (
                <Trans>This machine may be too slow for smooth flight.</Trans>
              )}
            </div>
            <Button type='button' variant='ghost' size='icon' className='size-6 shrink-0' aria-label={t`Dismiss`} onClick={() => setDismissed(alert)}>
              <X className='size-4' />
            </Button>
          </div>
        )}
        <div className='flex flex-col gap-2'>
          {gameInProgress ? (
            <>
              <Button className='h-12 justify-start text-base' onClick={onResume}>
                <Play className='size-4' />
                <Trans>Resume mission</Trans>
              </Button>
              <Button type='button' variant='outline' className='h-12 justify-start text-base' onClick={onRestart}>
                <RotateCcw className='size-4' />
                <Trans>Restart mission</Trans>
              </Button>
            </>
          ) : (
            <Button className='h-12 justify-start text-base' onClick={onStart}>
              <Play className='size-4' />
              {/* The fast path stays one click: fly the mission already configured,
                  labelled with it, so tweak-and-fly never grows a detour. */}
              <Trans>Fly</Trans>
              <span className='text-primary-foreground/70 ml-1 text-sm'>{started}</span>
            </Button>
          )}
          <Button type='button' variant='outline' className='h-12 justify-start text-base' onClick={() => setDialog('mission')}>
            <Pencil className='size-4' />
            <Trans>Create mission</Trans>
          </Button>
          <Button type='button' variant='outline' className='h-12 justify-start text-base' onClick={() => setDialog('server')}>
            <Users className='size-4' />
            <Trans>Join server</Trans>
          </Button>
          <Button type='button' variant='outline' className='h-12 justify-start text-base' onClick={() => setDialog('settings')}>
            <Settings className='size-4' />
            <Trans>Settings</Trans>
          </Button>
          <Button type='button' variant='outline' className='h-12 justify-start text-base' asChild>
            <Link to='/history' search={(prev) => prev}>
              <History className='size-4' />
              <Trans>History</Trans>
            </Link>
          </Button>
          <div className='mt-2 flex gap-2'>
            <ReferenceDialog />
            <CreditsDialog />
          </div>
        </div>
      </div>

      <MenuDialog open={dialog === 'mission'} onClose={close} title={<Trans>Create mission</Trans>} wide>
        <MissionPanel config={config} set={set} setCheat={setCheat} onChange={onChange} />
        {/* The controls above write through live, so closing keeps the changes
            and the front page's Fly launches them. This is the same action
            without the round trip: create the mission and go. */}
        <div className='mt-4 flex justify-end border-t pt-4'>
          <Button
            className='min-w-40'
            onClick={() => {
              close()
              onStart()
            }}
          >
            <Play className='size-4' />
            <Trans>Fly</Trans>
          </Button>
        </div>
      </MenuDialog>

      <MenuDialog open={dialog === 'settings'} onClose={close} title={<Trans>Settings</Trans>}>
        <Tabs variant='underline' value={tab} onValueChange={onTabChange}>
          <TabsList>
            <TabsTrigger value='general'>
              <Trans>General</Trans>
            </TabsTrigger>
            <TabsTrigger value='graphics'>
              <Trans>Graphics</Trans>
            </TabsTrigger>
            <TabsTrigger value='sound'>
              <Trans>Sound</Trans>
            </TabsTrigger>
            <TabsTrigger value='controls'>
              <Trans>Joystick</Trans>
            </TabsTrigger>
            <TabsTrigger value='keys'>
              <Trans>Keys</Trans>
            </TabsTrigger>
            {/* #57 parked:
            <TabsTrigger value='head'>
              <Trans>Head</Trans>
            </TabsTrigger>
            */}
          </TabsList>
          <div className='h-[clamp(26rem,100dvh_-_19rem,60rem)] overflow-y-auto pt-4'>
            {/* #57 parked:
            <TabsContent value='head'>
              <HeadPanel config={config} set={set} />
            </TabsContent>
            */}
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
        <div className='mt-4 flex items-center justify-between border-t pt-3'>
          <Button
            type='button'
            variant='ghost'
            size='sm'
            className='text-muted-foreground'
            onClick={() => {
              const fields = TAB_FIELDS[tab] ?? Object.keys(DEFAULT_CONFIG)
              const next = { ...config }
              for (const field of fields) next[field] = DEFAULT_CONFIG[field]
              // The callsign's default is the identity name, not blank — the
              // same value loadConfig seeds. DEFAULT_CONFIG cannot hold it
              // (it is per-player and arrives with the config), so reset
              // re-applies it here rather than emptying the field.
              if (next.callsign === '' && identity) next.callsign = identity
              onChange(next)
            }}
          >
            <Trans>Reset</Trans>
          </Button>
          {/* Settings applies live, so this only closes — but a dialog that ends
              in nothing but Reset reads as unfinished, and leaving by Esc or the
              corner ✕ is not obvious enough to rely on. */}
          <Button className='min-w-28' onClick={close}>
            <Check className='size-4' />
            <Trans>Done</Trans>
          </Button>
        </div>
      </MenuDialog>


      <ServerFlow open={dialog === 'server'} onClose={close} config={config} set={set} onChange={onChange} onJoin={onJoin} />
    </div>
  )
}
