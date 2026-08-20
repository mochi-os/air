// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { lazy, Suspense, useEffect, useId, useRef, useState, type ChangeEvent, type ReactNode } from 'react' // #57 parked: useCallback returns with HeadPanel
import { Trans, useLingui } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import { Check, ChevronRight, History, LogIn, Pencil, Play, RotateCcw, Send, Settings, TriangleAlert, Users, X } from 'lucide-react'
import { Input } from '@mochi/web/components/ui/input'
import { Collapsible, CollapsibleContent, CollapsibleTrigger, getErrorMessage, shellSaveBlob, toast, useShellStorage } from '@mochi/web' // #57 parked: toast returns with HeadPanel
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
  graphicsPreset,
  type MissionConfig,
  type StationSlot,
  type StickBindings,
  deviceDefaults,
  profileFor,
  seedStart,
} from '../lib/config'
import { useIdentityName } from '../lib/config-store'
import { ServerList, ServerRow, useServers } from './ServerList'
import { Multiplayer } from './Multiplayer'
import { Link } from '@tanstack/react-router'
import { KEY_DEFAULTS, pretty } from '../game/keys'
import { PRESETS, asymmetry, matches, normalize, outcome, outcomes, weight, resolve, type Catalog } from '../game/stores'
import { flight_catalog, flight_load } from '../game/flight'
import {
  default_server,
  normalize_server,
  world_chat,
  world_status,
  world_withdraw,
  world_say,
  type Join,
  type WorldChatLine,
} from '../game/net'

// Lazy, like GameCanvas on the route above: LoadoutPreview imports three.js
// directly, so a static import here put the whole renderer in the MENU's chunk
// — for a panel that only ever renders inside the Create mission dialog. The two
// warm together, because whichever loads first brings three with it.
const LoadoutPreview = lazy(() =>
  import('./LoadoutPreview').then((m) => ({ default: m.LoadoutPreview }))
)

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
  mapping: string // '' for most sticks; 'standard' means the W3C layout, which picks the standard-gamepad profile
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
  { id: 'weapon', label: <Trans>Weapon select hat</Trans> }, // an axis PAIR: POSITIONAL select — forward 120C, aft 9M, left GUN, right NAV (the VelocityOne castle)
  { id: 'zoom', label: <Trans>Zoom</Trans> }, // spring-centred wheel: deflection = zoom rate on the view (or the map when open)
]
const LEVERS = new Set(['throttle', 'speedbrake']) // lever-style rows: min-to-max meter + reverse toggle
// POV pairs: the bound index is the HORIZONTAL half and the engine reads the
// vertical from the next index up. Both halves get a meter — showing only the
// bound one made a half-bound hat look identical to a working one, so pushing
// the hat up moved nothing on screen while the engine was reading the axis
// perfectly well, and a device whose vertical half is NOT at index+1 gave no
// hint at all that it was mis-bound.
const PAIRS = new Set(['look', 'trim', 'weapon'])

// AxisMeter draws one centred +/- axis. Levers keep their own left-anchored
// fill inline below; this is the two-sided form the flight axes and the hat
// halves share.
function AxisMeter({ live }: { live: number }) {
  return (
    <div className='bg-muted relative h-2 min-w-10 flex-1 overflow-hidden rounded'>
      <div className='bg-border absolute top-0 bottom-0 left-1/2 w-px' />
      {/* The accent, not --primary: these bars ARE instruments, and reading the
          same green the HUD uses is the point. */}
      <div
        className='absolute top-0 bottom-0 rounded'
        style={{
          left: `${50 + Math.min(0, live) * 50}%`,
          width: `${Math.abs(live) * 50}%`,
          background: 'var(--air-accent)',
        }}
      />
    </div>
  )
}

const BUTTON_ROWS: Row[] = [
  { id: 'brake.speed', label: <Trans>Speed brake</Trans>, group: 'flight' },
  { id: 'brake.wheel', label: <Trans>Wheel brakes</Trans>, group: 'flight' },
  { id: 'override', label: <Trans>Override G limit</Trans>, group: 'flight' },
  // A gamepad has no twist and no throttle lever, so rudder and power have to be
  // reachable as BUTTONS; the same rows serve a stick whose twist axis is absent
  // or too coarse to fly on. The labels are the ones the Keys tab already uses.
  { id: 'yaw.left', label: <Trans>Yaw left</Trans>, group: 'flight' },
  { id: 'yaw.right', label: <Trans>Yaw right</Trans>, group: 'flight' },
  { id: 'throttle.up', label: <Trans>Throttle up</Trans>, group: 'flight' },
  { id: 'throttle.down', label: <Trans>Throttle down</Trans>, group: 'flight' },
  { id: 'trim.up', label: <Trans>Trim nose up</Trans>, group: 'trim' },
  { id: 'trim.down', label: <Trans>Trim nose down</Trans>, group: 'trim' },
  { id: 'trim.left', label: <Trans>Trim roll left</Trans>, group: 'trim' },
  { id: 'trim.right', label: <Trans>Trim roll right</Trans>, group: 'trim' },
  { id: 'trim.reset', label: <Trans>Reset trim</Trans>, group: 'trim' },   // keyless by default, so the pad path fires it directly rather than replaying a key
  { id: 'fire', label: <Trans>Fire weapon</Trans>, group: 'weapons' },   // the trigger serves the SELECTED weapon (engine.ts: guns in GUN mode, a 9M in 9M mode), so 'Guns' named only half of what it does
  { id: 'select', label: <Trans>Select weapon</Trans>, group: 'weapons' },
  { id: 'acquire', label: <Trans>Acquire target</Trans>, group: 'weapons' },
  { id: 'radar.undesignate', label: <Trans>Undesignate target</Trans>, group: 'weapons' },   // #30
  { id: 'uncage', label: <Trans>Uncage seeker</Trans>, group: 'weapons' },   // #27: the AIM-120's CIA <-> VISUAL toggle; the 9M's SEAM slaving joins it later
  { id: 'jammer', label: <Trans>Jammer</Trans>, group: 'weapons' },   // #31: the ASPJ's one real decision — armed, radiating only while painted
  { id: 'radar.silent', label: <Trans>Radar silent</Trans>, group: 'weapons' },   // #30
  { id: 'radar.acm', label: <Trans>Acquisition mode</Trans>, group: 'weapons' },   // #30: the castle switch — boresight, vertical, off
  { id: 'flares', label: <Trans>Countermeasures</Trans>, group: 'weapons' },   // the id stays 'flares' (the action); the label is the real dispenser's name
  { id: 'jettison.tanks', label: <Trans>Jettison tanks</Trans>, group: 'weapons' },
  { id: 'jettison.emergency', label: <Trans>Emergency jettison (hold)</Trans>, group: 'weapons' },
  { id: 'caution.reset', label: <Trans>Reset master caution</Trans>, group: 'aircraft' },
  { id: 'flaps.extend', label: <Trans>Extend flaps</Trans>, group: 'aircraft' },
  { id: 'flaps.retract', label: <Trans>Retract flaps</Trans>, group: 'aircraft' },
  { id: 'gear', label: <Trans>Landing gear</Trans>, group: 'aircraft' },
  { id: 'hook', label: <Trans>Arrestor hook</Trans>, group: 'aircraft' },
  { id: 'atc', label: <Trans>Approach power (ATC)</Trans>, group: 'aircraft' },
  { id: 'fold', label: <Trans>Wing fold</Trans>, group: 'aircraft' },   // bindable, but no built-in profile assigns it: a deck-only function does not earn a button on a stick that has run out of them, and the pilot who wants it can say so
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
  { id: 'menu', label: <Trans>Menu</Trans>, group: 'comms' },   // bindable but unassigned by any profile: it suits a BASE button (a stick that pauses the game under the trigger finger is a stick that pauses it by accident), and the Xbox-logo button is where every other device puts this
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
  { id: 'throttle.idle', label: <Trans>Throttle idle</Trans>, group: 'flight' },
  { id: 'throttle.mil', label: <Trans>Throttle military</Trans>, group: 'flight' },
  { id: 'throttle.max', label: <Trans>Throttle max reheat</Trans>, group: 'flight' },
  { id: 'brake.speed', label: <Trans>Speed brake</Trans>, group: 'flight' },
  { id: 'brake.wheel', label: <Trans>Wheel brakes</Trans>, group: 'flight' },
  { id: 'brake.parking', label: <Trans>Parking brake</Trans>, group: 'flight' },
  { id: 'override', label: <Trans>Override G limit</Trans>, group: 'flight' },
  { id: 'trim.up', label: <Trans>Trim nose up</Trans>, group: 'trim' },
  { id: 'trim.down', label: <Trans>Trim nose down</Trans>, group: 'trim' },
  { id: 'trim.left', label: <Trans>Trim roll left</Trans>, group: 'trim' },
  { id: 'trim.right', label: <Trans>Trim roll right</Trans>, group: 'trim' },
  { id: 'trim.reset', label: <Trans>Reset trim</Trans>, group: 'trim' },
  { id: 'fire', label: <Trans>Fire weapon</Trans>, group: 'weapons' },
  { id: 'select', label: <Trans>Select weapon</Trans>, group: 'weapons' },
  { id: 'acquire', label: <Trans>Acquire target</Trans>, group: 'weapons' },
  { id: 'radar.undesignate', label: <Trans>Undesignate target</Trans>, group: 'weapons' },   // #30
  { id: 'uncage', label: <Trans>Uncage seeker</Trans>, group: 'weapons' },   // #27: the AIM-120's CIA <-> VISUAL toggle; the 9M's SEAM slaving joins it later
  { id: 'jammer', label: <Trans>Jammer</Trans>, group: 'weapons' },   // #31: the ASPJ's one real decision — armed, radiating only while painted
  { id: 'radar.silent', label: <Trans>Radar silent</Trans>, group: 'weapons' },   // #30
  { id: 'radar.acm', label: <Trans>Acquisition mode</Trans>, group: 'weapons' },   // #30: the castle switch — boresight, vertical, off
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
  { id: 'hud.hide', label: <Trans>Hide HUD</Trans>, group: 'view' },
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
  const defaults = deviceDefaults(active, pad?.mapping ?? '')
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
  // A profile is one device's complete map, shared as plain JSON. This is the
  // only route that covers hardware nobody here owns: one owner of a model maps
  // it and every other owner imports the result, with no build needed.
  const fileRef = useRef<HTMLInputElement>(null)
  const exportProfile = async () => {
    const payload = { air: 'joystick', version: 1, device: active, axes, buttons }
    const name =
      (active.replace(/\s*\(Vendor:.*$/, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'joystick') + '.json'
    // shellSaveBlob, not an anchor: inside the shell's sandboxed iframe an
    // anchor download is silently dropped (see MatchHistory).
    const saved = await shellSaveBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), name)
    if (saved) toast.success(t`Profile saved`)
    else toast.error(t`Could not save the profile`)
  }
  const importProfile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = '' // clear first, so the same file can be retried after a bad parse
    if (!file) return
    try {
      const parsed = JSON.parse(await file.text())
      if (parsed?.air !== 'joystick' || typeof parsed.axes !== 'object' || typeof parsed.buttons !== 'object')
        throw new Error('not a profile')
      // Applied to the ACTIVE device whatever id it was exported from: the same
      // model reports a different id string on another machine, and refusing
      // those would defeat the point of sharing a profile at all. Axes merge
      // over the defaults and buttons replace them, matching how the engine
      // resolves a saved map.
      store({ ...defaults.axes, ...(parsed.axes as Record<string, string>) }, parsed.buttons as Record<string, string>)
      toast.success(t`Profile saved`)   // an imported profile IS saved; reusing the string avoids a near-duplicate msgid
    } catch {
      toast.error(t`Not a joystick profile`)
    }
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
      {/* Which built-in profile this device resolved to, beside the buttons that
          move a map between machines. The name is a product name, not prose. */}
      <div className='mt-2 flex items-center gap-2'>
        {active !== '' && (
          <span className='text-muted-foreground truncate text-xs'>{profileFor(active, pad?.mapping ?? '').name}</span>
        )}
        <span className='ml-auto flex shrink-0 gap-2'>
          <Button type='button' size='sm' variant='outline' disabled={active === ''} onClick={exportProfile}>
            <Trans>Export</Trans>
          </Button>
          <Button type='button' size='sm' variant='outline' disabled={active === ''} onClick={() => fileRef.current?.click()}>
            <Trans>Import</Trans>
          </Button>
        </span>
        <input ref={fileRef} type='file' accept='application/json,.json' className='hidden' onChange={importProfile} />
      </div>
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
          // The pair's vertical half, read where the engine reads it. undefined
          // (rather than null) means the device has no axis at index+1 at all,
          // which is worth SEEING: the hat's vertical half cannot work.
          const vertical = PAIRS.has(id) && pad && index !== '' ? (pad.axes[Number(index) + 1] ?? null) : null
          return (
            <div key={id} className='flex items-center justify-between gap-2 py-0.5'>
              <span className='w-24 shrink-0'>{label}</span>
              {/* levers show travel min..max as a left-anchored fill (throttle: power; speed brake: deployment); the flight axes stay centred +/-, and a POV pair shows both halves */}
              {live !== null &&
                (LEVERS.has(id) ? (
                  <div className='bg-muted relative h-2 min-w-10 flex-1 overflow-hidden rounded'>
                    <div
                      className='absolute top-0 bottom-0 left-0 rounded'
                      style={{
                        width: `${(((id === 'throttle') !== reversed ? 1 - live : live + 1) / 2) * 100}%`,
                        background: 'var(--air-accent)',
                      }}
                    />
                  </div>
                ) : PAIRS.has(id) ? (
                  <div className='flex min-w-10 flex-1 items-center gap-1.5'>
                    {/* jsx-text-ok: the arrows are direction glyphs, not prose — they read the same in every language */}
                    <span className='text-muted-foreground shrink-0 text-xs'>↔</span>
                    <AxisMeter live={live} />
                    <span className='text-muted-foreground shrink-0 text-xs'>↕</span>
                    {vertical !== null ? (
                      <AxisMeter live={vertical} />
                    ) : (
                      // No axis at index+1: the bar stays empty on purpose, so a
                      // pair bound to the last axis of the device is visible.
                      <div className='bg-muted h-2 min-w-10 flex-1 rounded opacity-50' />
                    )}
                  </div>
                ) : (
                  <AxisMeter live={live} />
                ))}
              <span className='flex shrink-0 items-center gap-1'>
                <Select value={index === '' ? 'none' : index} onValueChange={(v) => setAxis(id, v === 'none' ? '' : (reversed ? '-' : '') + v)}>
                  <SelectTrigger size='sm' className='min-w-28'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='none'>
                      <Trans>None</Trans>
                    </SelectItem>
                    {axisOptions.map((option) => {
                      // DISPLAYED 1-based, STORED 0-based. Hardware labels, the
                      // Windows controller panel and every simulator that numbers
                      // a control count from 1, while the Gamepad API counts from
                      // 0 — so the raw index is the one number the player can
                      // check against nothing. The stored value stays the API
                      // index: it is what indexes pad.axes, and an exported
                      // profile has to mean the same thing on another machine.
                      const i = String(Number(option) + 1)
                      return (
                        <SelectItem key={option} value={option}>
                          <Trans>Axis {i}</Trans>
                        </SelectItem>
                      )
                    })}
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
                    {buttonOptions.map((option) => {
                      const i = String(Number(option) + 1) // displayed 1-based, stored 0-based — see the axis list above
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
  const { t } = useLingui()
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
              {/* 'None' is the stored SENTINEL; the tooltip below is its LABEL,
                  so it translates. The lint exemption covers the sentinel, not
                  the label, which is how this stayed English in 106 languages. */}
              {current(id) !== 'None' && (
                <Button type='button' size='sm' variant='outline' title={t`None`} onClick={() => set('keys', { ...overrides, [id]: 'None' })}>
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
// Segmented: the short mutually-exclusive groups (2-4 options) as a joined row
// of buttons rather than scattered radio circles. Still a RadioGroup underneath,
// so arrow-key navigation and the screen-reader announcement are unchanged — only
// the skin differs. Long lists do NOT use this: past about four options the row
// wraps and the tightness is lost, which is what crowded the dialog in the first
// place, so Start and Clouds are Selects instead.
function Segmented<T extends string>({
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
    <RadioGroup value={value} onValueChange={(v) => onChange(v as T)} className='flex flex-wrap gap-1'>
      {options.map((o) => {
        const id = `${baseId}-${o.value}`
        const on = o.value === value
        return (
          <div key={o.value}>
            <RadioGroupItem value={o.value} id={id} className='peer sr-only' />
            <Label
              htmlFor={id}
              className={`cursor-pointer rounded-md border px-2.5 py-1 text-sm font-normal transition-colors peer-focus-visible:ring-[3px] ${
                on ? 'bg-primary text-primary-foreground border-primary' : 'bg-background hover:bg-muted border-input'
              }`}
            >
              {o.label}
            </Label>
          </div>
        )
      })}
    </RadioGroup>
  )
}

// Picker: a long mutually-exclusive list. A Select costs a click to open, which
// is the right trade only once the options stop fitting on one line.
function Picker<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (value: T) => void
  options: { value: T; label: ReactNode }[]
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as T)}>
      <SelectTrigger className='w-full'>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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
        {/* Instrument readouts are set on the instrument face, not the UI face. */}
        <span
          className='text-muted-foreground text-sm tabular-nums'
          style={{ fontFamily: 'var(--air-mono)' }}
        >
          {display}
        </span>
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
  useEffect(() => {
    if (book) return
    let gone = false
    void flight_load().then(() => {
      if (!gone) setBook(read())
    })
    return () => {
      gone = true
    }
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
      case '120c':
        return 'AIM-120C' // designation verbatim (#27)
      case '120c2':
        return '2× AIM-120C' // jsx-text-ok: a count and a designation, no prose
      case 'tank':
        return <Trans>Fuel tank</Trans>
      case 'pylon':
        return <Trans>Empty pylon</Trans>
      case 'twin1':
      case 'twin1b':
        return 'AIM-9M' // legacy hand-built twin with one round: shown, never offered
      case '120c1':
      case '120c1b':
        return 'AIM-120C' // hand-built twin with one round: shown, never offered
      case 'mixed':
      case 'mixedb':
        return 'AIM-9M + AIM-120C' // jsx-text-ok: designations; the real LAU-115 flies mixed pairs, representable but not offered
      case 'twin0':
        return <Trans>Empty pylon</Trans>
      default:
        return <Trans>None</Trans>
    }
  }
  const presets: { name: 'gun' | 'fox2' | 'fox3'; title: ReactNode }[] = [
    { name: 'gun', title: <Trans>Gun only</Trans> },
    { name: 'fox2', title: 'Fox 2' }, // jsx-text-ok: brevity codes, verbatim
    { name: 'fox3', title: 'Fox 3' }, // jsx-text-ok: brevity codes, verbatim
  ]
  // A preset press SEEDS the fuel load — full internal for every preset since
  // 2026-08-18: the 6,000 lb duel standard the fighters used to seed ended a
  // new pilot's fight on fuel before it ended on a kill (a seven-minute joust
  // at 79% burner landed at 1,000 lb), and an experienced one is a slider
  // pull from a lighter jet. The checkmark keeps tracking stores only, so the
  // slider stays freely overridable without un-checking the preset.
  const FUELS = { gun: 10800, fox2: 10800, fox3: 10800 }
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
      {/* The fallback holds the preview's exact aspect box, so the dialog does
          not jump when the renderer arrives (and stands in permanently on a
          machine with no WebGL 2, where LoadoutPreview draws nothing). */}
      <Suspense fallback={<div className='aspect-[29/10] w-full' />}>
        <LoadoutPreview stores={loadout} />
      </Suspense>
      <div className='flex flex-wrap gap-2'>
        {presets.map((entry) => (
          <Button key={entry.name} type='button' variant='outline' size='sm' onClick={() => onPreset(structuredClone(PRESETS[entry.name]), FUELS[entry.name])}>
            {preset === entry.name && <Check className='size-4' />}
            {entry.title}
          </Button>
        ))}
      </div>
      {/* The station strip is always visible (2026-08-13): a loadout that
          matches no preset simply shows no check above, and the dropdowns
          ARE the details — folding them behind a button hid the answer to
          "what am I actually carrying". */}
      {(() => {
          const cell = (station: number) => {
            const slot = loadout[String(station)]
            const open = outcomes(station).filter((o) => allowed || !o.slot.stores.some((s) => s === '9m' || s === '120c'))
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
                    <SelectTrigger size='sm' className='w-full px-2'>
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
          // bottom-aligns with the fuselage row. Equal thirds: the longest
          // wing label (2× AIM-120C) and the longest centerline label
          // (Empty pylon) are nearly the same width, and the tight gap and
          // trigger padding buy the text room the stock spacing lacked.
          return (
            <div className='grid grid-cols-3 gap-x-2'>
              <div className='space-y-2'>{[9, 8, 7, 6].map(cell)}</div>
              <div className='flex flex-col justify-end'>{[5].map(cell)}</div>
              <div className='space-y-2'>{[1, 2, 3, 4].map(cell)}</div>
            </div>
          )
        })()}
      <SliderRow label={<Trans>Internal fuel</Trans>} value={fuel} min={1500} max={10800} step={100} decimals={0} suffix=' lb' onChange={onFuel} />
      {book && (
        <div className='text-sm'>
          {/* jsx-text-ok: LB and ft·lb are the cockpit's own unit annunciations, verbatim like the IFEI */}
          <Trans>Gross weight</Trans>{' '}
          <span className='tabular-nums' style={{ fontFamily: 'var(--air-mono)' }}>
            {gross} lb
          </span>
          {/* The asymmetry rides in brackets on the gross-weight line: it is a
              property of the same loadout, and its own line read as a second
              headline for what is really a qualifier. The over-limit warnings
              below stay on their own lines — those ARE headlines. */}
          {moment > 0 && (
            <>
              {' ('}
              {/* Lower case as a mid-sentence qualifier, and a msgid of its own rather than a
                  CSS transform of the capitalised one: German capitalises its nouns, so
                  Asymmetrie must stay capitalised where English asymmetry does not. */}
              <Trans>asymmetry</Trans>{' '}
              <span className='tabular-nums' style={{ fontFamily: 'var(--air-mono)' }}>
                {moment} ft·lb
              </span>
              {')'}
            </>
          )}
          {gross > LAUNCH && (
            <div className='mt-1 flex items-center gap-1.5 text-amber-500'>
              <TriangleAlert className='size-4' />
              <Trans>{gross - LAUNCH} lb over maximum launch weight</Trans>
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
              Missile model <b>“AIM-120C AMRAAM”</b> by <b>Pippa</b> (Sketchfab), licensed under{' '}
              <b>CC BY 4.0</b>. Modified: rescaled, reoriented, and centred for placement.
            </Trans>{' '}
            <a
              className='text-primary hover:underline'
              href='https://sketchfab.com/3d-models/aim-120c-amraam-62b79b0f76e44684ad43adcc2ae3cdb9'
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
  steady,
  children,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  wide?: boolean
  steady?: boolean // hold one height whatever the options render: the interior scrolls instead of the box breathing as sections expand
  children: ReactNode
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className={`${wide ? 'sm:max-w-4xl' : 'sm:max-w-2xl'}${steady ? ' h-[min(46rem,calc(100svh-2rem))]' : ''}`}>
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
  const { servers, version } = useServers()
  // The private-server address entry is collapsed by default; no persistence,
  // because a joined private server lands in recents, which remembers for us.
  const [private_, setPrivate] = useState(false)
  // The server's own name, from its lobby status — every world server
  // advertises one ([world] name), so the page can be titled with it even for
  // private servers the public listing has never heard of. Empty until it
  // answers; the generic heading stands in.
  const [world, setWorld] = useState('')
  useEffect(() => {
    if (!entered) return
    const abort = new AbortController()
    setWorld('')
    world_status(normalize_server(config.world || default_server()), abort.signal)
      .then((s) => setWorld(s.name))
      .catch(() => {}) // unreachable: the generic heading stands
    return () => abort.abort()
  }, [entered, config.world])
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
    // A recent that matches a public listing shows ONCE, here in the recent
    // position, under its public name with the live count — the name is the
    // player-facing identity; the raw address is only shown when no listing
    // matches (a private server, or a public one gone quiet), which doubles
    // as the honest signal that the server is not currently announcing.
    const matched = (r: string) => (servers ?? []).find((s) => normalize_server(s.address) === normalize_server(r))
    const publics = (servers ?? []).filter((s) => !recents.some((r) => normalize_server(r) === normalize_server(s.address)))
    // The address entry is the expert path and collapses out of a new
    // player's way — unless it is the only thing the dialog would contain
    // (no listings, no recents: today's lone-private-player state).
    const bare = servers !== null && publics.length === 0 && recents.length === 0
    const entry = private_ || bare
    return (
      <MenuDialog open onClose={onClose} title={<Trans>Join server</Trans>}>
        <div className='space-y-4'>
          {recents.length > 0 && (
            <div className='space-y-2'>
              <SectionLabel>
                <Trans>Recent</Trans>
              </SectionLabel>
              <div className='flex flex-col gap-1'>
                {recents.map((r) => {
                  const s = matched(r)
                  return s ? (
                    <ServerRow key={r} server={s} version={version} onPick={(a) => enter(a)} />
                  ) : (
                    <Button key={r} type='button' variant='outline' className='justify-start font-mono text-sm' onClick={() => enter(r)}>
                      {r}
                    </Button>
                  )
                })}
              </div>
            </div>
          )}
          {/* The public list: community servers hosting air, live from the
              network. Absent entirely when nothing is public, so a lone
              private player just sees the recents + address entry. */}
          {publics.length > 0 && (
            <div className='space-y-2'>
              <SectionLabel>
                <Trans>Public servers</Trans>
              </SectionLabel>
              <ServerList servers={publics} version={version} onPick={(a) => enter(a)} />
            </div>
          )}
          <div className='space-y-2'>
            <button
              type='button'
              onClick={() => setPrivate(!private_)}
              className='text-muted-foreground hover:text-foreground flex items-center gap-1 text-sm transition-colors'
            >
              <ChevronRight className={`size-4 transition-transform ${entry ? 'rotate-90' : ''}`} />
              <Trans>Connect to private server</Trans>
            </button>
            {entry && (
              <>
                <Input
                  value={address}
                  placeholder={default_server()}
                  onChange={(e) => setAddress(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && enter(address)}
                />
                <div className='flex justify-end'>
                  <Button onClick={() => enter(address)}>
                    <LogIn className='size-4' />
                    <Trans>Connect</Trans>
                  </Button>
                </div>
              </>
            )}
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
              <h2 className='text-2xl font-semibold tracking-tight'>{world || <Trans>Matches</Trans>}</h2>
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
            onJoin={onJoin}
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
  // The Cheats section is folded unless a cheat is actually set. Opening is
  // one-way on purpose: an EFFECT rather than a useState initialiser, so a
  // config that resolves after mount still opens it, and nothing ever closes it
  // for the player — switching the last cheat off would otherwise collapse the
  // section out from under the cursor mid-click.
  const anyCheat = Object.values(config.cheats ?? {}).some(Boolean)
  const [cheatsOpen, setCheatsOpen] = useState(anyCheat)
  useEffect(() => {
    if (anyCheat) setCheatsOpen(true)
  }, [anyCheat])
  return (
    <div className='sm:grid sm:grid-cols-2 sm:gap-x-10'>
    <div>
<SectionLabel>
  <Trans>Mission</Trans>
</SectionLabel>
<Segmented
  value={config.task}
  onChange={(v) => set('task', v)}
  options={[
    { value: 'free', label: <Trans>Free flight</Trans> },
    { value: 'joust', label: <Trans>Joust against bot</Trans> },
  ]}
/>
{config.task === 'joust' && (
  <>
    <SectionLabel>
      <Trans>Start</Trans>
    </SectionLabel>
    <Picker
      value={config.duel === 'bvr' ? 'bvr' : 'merge'}
      onChange={(v) => set('duel', v as 'merge' | 'bvr')}
      options={[
        { value: 'merge', label: <Trans>Merge, fight's on at the pass</Trans> },
        { value: 'bvr', label: <Trans>BVR, fight's on at start</Trans> },
      ]}
    />
    <SectionLabel>
      <Trans>Bandit</Trans>
    </SectionLabel>
    <Picker
      value={String(config.bandit || 'pilot') as 'novice' | 'pilot' | 'ace' | 'superhuman'}
      onChange={(v) => set('bandit', v)}
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
    <Picker
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
        <Segmented
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
{/* The recovery cases SEED the weather (seedStart: Case I day/clear, Case II
    day/mid stratus, Case III night/low stratus) and the fuel that fits them.
    Restating both as peer controls made the panel echo the choice just made,
    which is most of what crowded it. They live behind a disclosure instead —
    still one click from any override, and the summary says what is set so
    nothing is hidden, only folded. */}
<SectionLabel>
  <Trans>Time of day</Trans>
</SectionLabel>
<Picker
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
<Picker
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
{/* a MATCH takes its cheats from the creator's rules instead — these are the mission's */}
{/* Folded away when every cheat is off, which is the normal state: an honest
    mission should not devote three rows to switches nobody has touched. It
    opens itself if any cheat IS set — including one that arrives late with the
    loaded config — and once open it stays where the player left it, so turning
    the last one off does not snap the section shut under the cursor. */}
<Collapsible open={cheatsOpen} onOpenChange={setCheatsOpen}>
  <CollapsibleTrigger className='text-muted-foreground hover:text-foreground mt-4 mb-2 flex w-full items-center gap-1.5 text-xs font-medium tracking-wide uppercase'>
    <ChevronRight className={`size-4 transition-transform ${cheatsOpen ? 'rotate-90' : ''}`} />
    <Trans>Cheats</Trans>
  </CollapsibleTrigger>
  <CollapsibleContent>
<div className='space-y-2'>
  <SwitchRow
    id='cheat-invulnerable'
    label={config.task === 'free' ? <Trans>Invulnerable</Trans> : <Trans>Invulnerable (human players only)</Trans>}
    checked={!!(config.cheats ?? {}).invulnerable}
    onChange={(v) => setCheat('invulnerable', v)}
  />
  <SwitchRow
    id='cheat-ammunition'
    label={config.task === 'free' ? <Trans>Unlimited ammunition</Trans> : <Trans>Unlimited ammunition (all players)</Trans>}
    checked={!!(config.cheats ?? {}).ammunition}
    onChange={(v) => setCheat('ammunition', v)}
  />
  <SwitchRow
    id='cheat-fuel'
    label={config.task === 'free' ? <Trans>Unlimited fuel</Trans> : <Trans>Unlimited fuel (all players)</Trans>}
    checked={!!(config.cheats ?? {}).fuel}
    onChange={(v) => setCheat('fuel', v)}
  />
</div>
  </CollapsibleContent>
</Collapsible>
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
  // The row is a segmented control, not four fire-and-forget buttons: the
  // settings below ARE a preset until the player moves one, so the matching
  // button is filled. Moving any slider off it clears the row to none, which
  // is the honest read of a custom mix. Same filled/outline pair the Reversed
  // axis toggle uses, so a set button looks set everywhere in this dialog.
  const active = graphicsPreset(config)
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
        aria-pressed={active === p}
        variant={active === p ? 'default' : 'outline'}
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
        <Trans>Joust</Trans> · {BANDITS[String(config.bandit || 'pilot')] ?? BANDITS.pilot}
        {config.duel === 'bvr' ? ' · BVR' : ''}
      </>
    ) : (
      STARTS[config.start === 'landing' ? 'case2' : config.start]
    )

  return (
    <div className='bg-background fixed inset-0 z-50 flex items-center justify-center overflow-auto p-6'>
      <div className='w-full max-w-md'>
        {/* The app's own mark beside the wordmark — the front page carried a
            bare <h1> and nothing else of the game in it. Inline SVG rather than
            an <img> so it takes the accent directly and costs no request; the
            same path public/images/icon.svg uses for the launcher. */}
        <div className='mb-8 flex items-center gap-3'>
          <svg
            viewBox='0 0 24 24'
            aria-hidden='true'
            className='size-9 shrink-0'
            fill='none'
            stroke='var(--air-accent)'
            strokeWidth={2}
            strokeLinecap='round'
            strokeLinejoin='round'
          >
            <path d='M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z' />
          </svg>
          {/* jsx-text-ok: the game's name, verbatim in every locale */}
          <h1 className='text-4xl font-semibold tracking-tight'>Air</h1>
        </div>
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

      <MenuDialog open={dialog === 'mission'} onClose={close} title={<Trans>Create mission</Trans>} wide steady>
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
