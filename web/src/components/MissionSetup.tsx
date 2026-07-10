// Copyright © 2026 Mochi OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { useEffect, useId, useState, type ReactNode } from 'react'
import { Trans } from '@lingui/react/macro'
import { Play, RotateCcw } from 'lucide-react'
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
  type StickBindings,
  deviceDefaults,
} from '../lib/config'
import { Multiplayer } from './Multiplayer'
import { type Join } from '../game/net'

// The fields each tab owns, for the per-tab Reset (the joystick tab also clears
// the per-device maps so built-in defaults apply again).
const TAB_FIELDS: Record<string, string[]> = {
  mission: ['task', 'start', 'world', 'callsign', 'aircraft', 'bandit', 'fuel'],
  weather: ['tod', 'clouds'],
  controls: ['invert', 'joystick', 'sticks'],
  keys: ['keys'],
  sound: ['sound', 'volume'],
  graphics: ['render_scale', 'dyn_res', 'lod', 'shadows', 'exterior_detail', 'ocean_segments', 'extra_aircraft', 'afterburner', 'tracers', 'missiles', 'flares', 'framerate'],
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
// KEY_DEFAULTS mirrors the engine's KEYS table (engine.ts key_of) for display.
const KEY_DEFAULTS: Record<string, string> = {
  'pitch.up': 'KeyS',
  'pitch.down': 'KeyW',
  'roll.right': 'KeyD',
  'roll.left': 'KeyA',
  'yaw.right': 'KeyE',
  'yaw.left': 'KeyQ',
  'throttle.up': 'BracketRight',
  'throttle.down': 'BracketLeft',
  guns: 'Space',
  launch: 'Enter',
  'brake.wheel': 'KeyB',
  'brake.speed': 'Slash',
  gear: 'KeyG',
  hook: 'KeyH',
  lights: 'KeyL',
  missile: 'KeyR',
  flares: 'KeyF',
  rearm: 'KeyX',
  eject: 'KeyJ',
  map: 'KeyM',
  pause: 'KeyP',
  view: 'KeyV',
  probe: 'Shift+KeyF',
  canopy: 'Shift+KeyC',
  fold: 'Shift+KeyW',
}

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

function pretty(code: string): string {
  if (!code || code === 'None') return '—'
  const table: Record<string, string> = {
    Space: 'Space',
    Enter: 'Enter',
    Slash: '/',
    Backslash: '\\',
    BracketLeft: '[',
    BracketRight: ']',
    Comma: ',',
    Period: '.',
    Semicolon: ';',
    Quote: "'",
    Minus: '−',
    Equal: '=',
    Tab: 'Tab',
    Backspace: 'Backspace',
    ShiftLeft: 'Shift',
    ShiftRight: 'Shift',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
  }
  if (table[code]) return table[code]
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6)
  return code
}

const AXIS_ROWS: { id: string; label: ReactNode }[] = [
  { id: 'pitch', label: <Trans>Pitch</Trans> },
  { id: 'roll', label: <Trans>Roll</Trans> },
  { id: 'yaw', label: <Trans>Yaw</Trans> },
  { id: 'throttle', label: <Trans>Throttle</Trans> },
  { id: 'speedbrake', label: <Trans>Speed brake</Trans> },
  { id: 'look', label: <Trans>Look</Trans> }, // an axis PAIR: the chosen index is horizontal, the next one up is vertical
  { id: 'zoom', label: <Trans>Zoom</Trans> }, // spring-centred wheel: deflection = zoom rate on the view (or the map when open)
]
const LEVERS = new Set(['throttle', 'speedbrake']) // lever-style rows: min-to-max meter + reverse toggle

const BUTTON_ROWS: { id: string; label: ReactNode }[] = [
  { id: 'guns', label: <Trans>Guns</Trans> },
  { id: 'missile', label: <Trans>Missile</Trans> },
  { id: 'flares', label: <Trans>Flares</Trans> },
  { id: 'gear', label: <Trans>Landing gear</Trans> },
  { id: 'hook', label: <Trans>Arrestor hook</Trans> },
  { id: 'brake.wheel', label: <Trans>Wheel brakes</Trans> },
  { id: 'brake.speed', label: <Trans>Speed brake</Trans> },
  { id: 'launch', label: <Trans>Launch (catapult)</Trans> },
  { id: 'lights', label: <Trans>Lights</Trans> },
  { id: 'rearm', label: <Trans>Rearm</Trans> },
  { id: 'view', label: <Trans>Cycle view</Trans> },
  { id: 'look.up', label: <Trans>Look up</Trans> },
  { id: 'look.down', label: <Trans>Look down</Trans> },
  { id: 'look.left', label: <Trans>Look left</Trans> },
  { id: 'look.right', label: <Trans>Look right</Trans> },
  { id: 'zoom.in', label: <Trans>Zoom in</Trans> },
  { id: 'zoom.out', label: <Trans>Zoom out</Trans> },
]

const KEY_ROWS: { id: string; label: ReactNode }[] = [
  { id: 'pitch.up', label: <Trans>Pitch up</Trans> },
  { id: 'pitch.down', label: <Trans>Pitch down</Trans> },
  { id: 'roll.left', label: <Trans>Roll left</Trans> },
  { id: 'roll.right', label: <Trans>Roll right</Trans> },
  { id: 'yaw.left', label: <Trans>Yaw left</Trans> },
  { id: 'yaw.right', label: <Trans>Yaw right</Trans> },
  { id: 'throttle.up', label: <Trans>Throttle up</Trans> },
  { id: 'throttle.down', label: <Trans>Throttle down</Trans> },
  { id: 'guns', label: <Trans>Guns</Trans> },
  { id: 'missile', label: <Trans>Missile</Trans> },
  { id: 'flares', label: <Trans>Flares</Trans> },
  { id: 'gear', label: <Trans>Landing gear</Trans> },
  { id: 'hook', label: <Trans>Arrestor hook</Trans> },
  { id: 'brake.wheel', label: <Trans>Wheel brakes</Trans> },
  { id: 'brake.speed', label: <Trans>Speed brake</Trans> },
  { id: 'launch', label: <Trans>Launch (catapult)</Trans> },
  { id: 'lights', label: <Trans>Lights</Trans> },
  { id: 'rearm', label: <Trans>Rearm</Trans> },
  { id: 'eject', label: <Trans>Eject</Trans> },
  { id: 'map', label: <Trans>Map</Trans> },
  { id: 'pause', label: <Trans>Pause</Trans> },
  { id: 'view', label: <Trans>Cycle view</Trans> },
  { id: 'probe', label: <Trans>Fuel probe</Trans> },
  { id: 'canopy', label: <Trans>Canopy</Trans> },
  { id: 'fold', label: <Trans>Wing fold</Trans> },
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
                    title='Reversed'
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
      <div className='grid gap-y-1 text-sm'>
        {BUTTON_ROWS.map(({ id, label }) => {
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
      <div className='grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2'>
        {KEY_ROWS.map(({ id, label }) => (
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
      <SectionLabel>
        <Trans>Fixed keys</Trans>
      </SectionLabel>
      <div className='grid gap-x-8 text-sm sm:grid-cols-2'>
        <ControlRow action={<Trans>Views</Trans>} keys={<><Key>1</Key>–<Key>5</Key></>} />
        <ControlRow action={<Trans>Look / orbit</Trans>} keys={<><Key>←</Key><Key>→</Key><Key>↑</Key><Key>↓</Key></>} />
        <ControlRow action={<Trans>Camera distance</Trans>} keys={<><Key>−</Key><Key>=</Key></>} />
        <ControlRow action={<Trans>Refueling probe</Trans>} keys={<><Key>Shift</Key>+<Key>F</Key></>} />
        <ControlRow action={<Trans>Canopy</Trans>} keys={<><Key>Shift</Key>+<Key>C</Key></>} />
        <ControlRow action={<Trans>Return to menu</Trans>} keys={<Key>Esc</Key>} />
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

// The measured F/A-18C performance reference (#89): every number flown out of
// the flight model by tools/vspeeds.sh (world repo) — rerun it after flight
// changes and update these cells. Cells are the harness's KEAS verbatim: the
// HUD's CAS (flight/frames.go Cas()) approximates calibrated as EQUIVALENT
// airspeed, no compressibility term, so KEAS is exactly what the player's
// HUD shows. If #133 (real HUD) gives Cas() true pitot compressibility,
// re-run the harness and re-base these cells on real KCAS.
// Ranges span light (11.2 t, minimum fuel) to heavy (15.6 t, full internal).
// Rows in sortie order: climb, engine-out, dash, combat, landing. Rotation
// (Vr) is deliberately absent: nosewheel liftoff depends on weight, CG, and
// technique (NATOPS gives no single speed), so a one-number row would
// mislead. The V-speed designations (Vx, Vy, Vs1, Vs0, Vapp, Vyse) are
// international aviation abbreviations and stay verbatim in every locale; the
// descriptive phrase around each is translated. id is the stable React key
// (the label is now a translated node, not a plain string).
const REFERENCE_ROWS: { id: string; label: ReactNode; cells: [string, string, string] }[] = [
  { id: 'vx-mil', label: <Trans>Steepest climb (Vx, 100% thrust)</Trans>, cells: ['167-385', '314-374', '300-307'] },
  { id: 'vx-ab', label: <Trans>Steepest climb (Vx, afterburner)</Trans>, cells: ['Vertical', '273-305', '263-317'] },
  { id: 'vy-mil', label: <Trans>Best climb (Vy, 100% thrust)</Trans>, cells: ['510-546', '392-438', '318-320'] },
  { id: 'vy-ab', label: <Trans>Best climb (Vy, afterburner)</Trans>, cells: ['532-610', '448-449', '326-328'] },
  { id: 'vyse', label: <Trans>Single-engine best climb (Vyse, afterburner)</Trans>, cells: ['398-457', '214-352', '158-199'] },
  { id: 'glide', label: <Trans>Best glide (engines out)</Trans>, cells: ['245-291', '247-290', '247-295'] },
  { id: 'corner', label: <Trans>Corner speed (best instant turn)</Trans>, cells: ['321-376', '332-379', '305-315'] },
  { id: 'sustained', label: <Trans>Best sustained turn speed</Trans>, cells: ['353-468', '379-420', '307-310'] },
  { id: 'tightest', label: <Trans>Tightest sustained turn speed</Trans>, cells: ['167-203', '166-225', '186-198'] },
  { id: 'vs1', label: <Trans>Stall, clean (Vs1)</Trans>, cells: ['159-185', '158-185', '158-186'] },
  { id: 'vs0', label: <Trans>Stall, landing config (Vs0)</Trans>, cells: ['111-128', '110-128', '—'] },
  { id: 'vapp', label: <Trans>Approach, on-speed (Vapp)</Trans>, cells: ['126-148', '125-147', '—'] },
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
              Sketchfab
            </a>{' '}
            ·{' '}
            <a
              className='text-primary hover:underline'
              href='https://creativecommons.org/licenses/by/4.0/'
              target='_blank'
              rel='noopener noreferrer'
            >
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
              Sketchfab
            </a>{' '}
            ·{' '}
            <a
              className='text-primary hover:underline'
              href='https://creativecommons.org/licenses/by/4.0/'
              target='_blank'
              rel='noopener noreferrer'
            >
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
              Copernicus
            </a>{' '}
            ·{' '}
            <a
              className='text-primary hover:underline'
              href='https://www.openstreetmap.org/copyright'
              target='_blank'
              rel='noopener noreferrer'
            >
              OpenStreetMap
            </a>{' '}
            ·{' '}
            <a
              className='text-primary hover:underline'
              href='https://coastalscience.noaa.gov/'
              target='_blank'
              rel='noopener noreferrer'
            >
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
              three.js
            </a>
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function MissionSetup({
  config,
  onChange,
  cat,
  onCat,
  tab,
  onTabChange,
  gameInProgress,
  onStart,
  onJoin,
  onResume,
  onRestart,
}: {
  config: MissionConfig
  onChange: (config: MissionConfig) => void
  cat: number
  onCat: (cat: number) => void
  tab: string
  onTabChange: (tab: string) => void
  gameInProgress: boolean
  onStart: () => void
  onJoin: (join: Join) => void
  onResume: () => void
  onRestart: () => void
}) {
  const set = <K extends keyof MissionConfig>(key: K, value: MissionConfig[K]) =>
    onChange({ ...config, [key]: value })



  return (
    <div className='bg-background fixed inset-0 z-50 flex items-center justify-center overflow-auto p-6'>
      <div className='w-full max-w-2xl'>
        <h1 className='mb-6 text-3xl font-semibold tracking-tight'>Furball</h1>
        <div>
          <Tabs variant='underline' value={tab} onValueChange={onTabChange}>
            <TabsList>
              <TabsTrigger value='mission'>
                <Trans>Mission</Trans>
              </TabsTrigger>
              <TabsTrigger value='weather'>
                <Trans>Weather</Trans>
              </TabsTrigger>
              <TabsTrigger value='controls'>
                <Trans>Joystick</Trans>
              </TabsTrigger>
              <TabsTrigger value='keys'>
                <Trans>Keys</Trans>
              </TabsTrigger>
              <TabsTrigger value='sound'>
                <Trans>Sound</Trans>
              </TabsTrigger>
              <TabsTrigger value='graphics'>
                <Trans>Graphics</Trans>
              </TabsTrigger>
            </TabsList>

            {/* Fixed-height area so the card doesn't resize when switching tabs */}
            {/* Fixed height so the layout never shifts when switching tabs (Graphics is the tallest). */}
            <div className='h-[30rem] overflow-y-auto pt-4'>
              <TabsContent value='mission'>
                <SectionLabel>
                  <Trans>Task</Trans>
                </SectionLabel>
                <Choice
                  value={config.task}
                  onChange={(v) => set('task', v)}
                  options={[
                    { value: 'free', label: <Trans>Free flight</Trans> },
                    { value: 'joust', label: <Trans>Joust against AI player</Trans> },
                    { value: 'multiplayer', label: <Trans>Multiplayer</Trans> },
                  ]}
                />
                <SectionLabel>
                  <Trans>Fuel</Trans>
                </SectionLabel>
                <SliderRow
                  label={<Trans>Load</Trans>}
                  value={Number(config.fuel) || 6600}
                  min={1500}
                  max={10800}
                  step={100}
                  decimals={0}
                  suffix=' lb'
                  onChange={(v) => set('fuel', v)}
                />
                {config.task === 'joust' && (
                  <>
                    <SectionLabel>
                      <Trans>Bandit</Trans>
                    </SectionLabel>
                    <Choice
                      value={String(config.bandit || 'veteran')}
                      onChange={(v) => set('bandit', v as 'rookie' | 'pilot' | 'veteran' | 'ace')}
                      options={[
                        { value: 'rookie', label: <Trans>Rookie</Trans> },
                        { value: 'pilot', label: <Trans>Pilot</Trans> },
                        { value: 'veteran', label: <Trans>Veteran</Trans> },
                        { value: 'ace', label: <Trans>Ace</Trans> },
                      ]}
                    />
                  </>
                )}
                {config.task === 'multiplayer' && (
                  <div className='mt-4'>
                    <Multiplayer
                      server={config.world}
                      callsign={config.callsign}
                      onServer={(v) => set('world', v)}
                      onCallsign={(v) => set('callsign', v)}
                      onJoin={onJoin}
                    />
                  </div>
                )}
                {config.task === 'free' && (
                  <>
                    {/* joust always starts at the symmetric merge, so the start choice applies to free flight only */}
                    <SectionLabel>
                      <Trans>Start</Trans>
                    </SectionLabel>
                    <Choice
                      value={config.start}
                      onChange={(v) => set('start', v)}
                      options={[
                        { value: 'air', label: <Trans>In air</Trans> },
                        { value: 'runway', label: <Trans>On runway</Trans> },
                        { value: 'carrier', label: <Trans>On carrier</Trans> },
                        { value: 'landing', label: <Trans>Carrier landing</Trans> },
                      ]}
                    />
                    {config.start === 'carrier' && (
                      <>
                        <SectionLabel>
                          <Trans>Catapult</Trans>
                        </SectionLabel>
                        <Choice
                          value={String(cat)}
                          onChange={(v) => onCat(parseInt(v, 10))}
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
              </TabsContent>

              <TabsContent value='weather'>
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
                    { value: 'low_stratus', label: <Trans>Low stratus</Trans> },
                  ]}
                />
              </TabsContent>

              <TabsContent value='controls'>
                <JoystickPanel config={config} set={set} />
              </TabsContent>

              <TabsContent value='keys'>
                <KeysPanel config={config} set={set} />
              </TabsContent>

              <TabsContent value='sound'>
                <SoundPanel config={config} set={set} />
              </TabsContent>

              <TabsContent value='graphics' className='space-y-4'>
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
                    label={<Trans>Ocean detail</Trans>}
                    value={config.ocean_segments}
                    min={64}
                    max={512}
                    step={32}
                    onChange={(v) => set('ocean_segments', v)}
                  />
                  <SliderRow
                    label={<Trans>Extra aircraft</Trans>}
                    value={config.extra_aircraft}
                    min={0}
                    max={40}
                    step={1}
                    onChange={(v) => set('extra_aircraft', v)}
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
                    id='missiles'
                    label={<Trans>Missiles</Trans>}
                    checked={config.missiles}
                    onChange={(v) => set('missiles', v)}
                  />
                  <SwitchRow
                    id='flares'
                    label={<Trans>Flares</Trans>}
                    checked={config.flares}
                    onChange={(v) => set('flares', v)}
                  />
                  <SwitchRow
                    id='framerate'
                    label={<Trans>Framerate</Trans>}
                    checked={config.framerate}
                    onChange={(v) => set('framerate', v)}
                  />
                </div>
              </TabsContent>
            </div>
          </Tabs>

          <div className='mt-6 flex items-center justify-end gap-3'>
            {gameInProgress ? (
              <div className='flex gap-2'>
                <Button type='button' variant='outline' onClick={onRestart}>
                  <RotateCcw className='size-4' />
                  <Trans>Restart</Trans>
                </Button>
                <Button className='min-w-32' onClick={onResume}>
                  <Play className='size-4' />
                  <Trans>Resume</Trans>
                </Button>
              </div>
            ) : config.task === 'multiplayer' ? null : (
              <Button className='min-w-40' onClick={onStart}>
                <Play className='size-4' />
                <Trans>Start</Trans>
              </Button>
            )}
          </div>
        </div>
        <div className='text-muted-foreground/60 mt-4 flex items-center justify-between border-t pt-3'>
          <Button
            type='button'
            variant='ghost'
            size='sm'
            className='text-muted-foreground'
            onClick={() => {
              const fields = TAB_FIELDS[tab] ?? Object.keys(DEFAULT_CONFIG)
              const next = { ...config }
              for (const field of fields) next[field] = DEFAULT_CONFIG[field]
              onChange(next)
            }}
          >
            <Trans>Reset</Trans>
          </Button>
          <ReferenceDialog />
          <CreditsDialog />
        </div>
      </div>
    </div>
  )
}
