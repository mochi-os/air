// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react' // #57 parked: useCallback returns with HeadPanel
import { Trans, useLingui } from '@lingui/react/macro'
import { msg } from '@lingui/core/macro'
import { Check } from 'lucide-react'
import { Input } from '@mochi/web/components/ui/input'
import { shellSaveBlob, toast } from '@mochi/web' // #57 parked: toast returns with HeadPanel

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@mochi/web/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@mochi/web/components/ui/select'
import { Button } from '@mochi/web/components/ui/button'
import { Separator } from '@mochi/web/components/ui/separator'
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
import { SectionLabel, SliderRow, SwitchRow, MenuDialog } from './menu-parts'

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


function ControlRow({ action, keys }: { action: ReactNode; keys: ReactNode }) {
  return (
    <div className='flex items-center justify-between gap-4 py-1'>
      <span>{action}</span>
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


// The one Settings surface. The front page opens it over the menu; the pause
// menu opens it over the frozen scene, in fullscreen, without leaving flight —
// which is the whole reason it is a component and not a branch of MissionSetup.
// Everything applies live, so there is no Save: `onClose` is the only exit.
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
  guarded?: boolean // opened over the game: only Done, the ✕ and Esc close it
}) {
  const set = <K extends keyof MissionConfig>(key: K, value: MissionConfig[K]) =>
    onChange({ ...config, [key]: value })
  const identity = useIdentityName()
  return (
      <MenuDialog open={open} onClose={onClose} guarded={guarded} title={<Trans>Settings</Trans>}>
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
          <Button className='min-w-28' onClick={onClose}>
            <Check className='size-4' />
            <Trans>Done</Trans>
          </Button>
        </div>
      </MenuDialog>  )
}
