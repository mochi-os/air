// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { PRESETS } from '../game/stores'

// One joystick's bindings: which pad axis drives each aircraft axis ('' = none),
// and which pad button provides each action ('' = none). Missing entries fall
// back to the engine's built-in device defaults.
export interface StickBindings {
  axes: Record<string, string>
  buttons: Record<string, string>
}

// One station's loadout: the fixture choice and one store id per fixture
// point. The full shape lives in game/stores.ts (normalize, presets, firing
// order); the config only persists it.
export interface StationSlot {
  fixture: string
  stores: string[]
}

// Built-in per-device bindings, the single source for the engine's pad_bindings
// and the menu's Joystick tab. "-N" = reversed axis sense; look = the axis pair
// (x index, y at x+1); a buttons value may list several indices
// comma-separated. `match` gets the pad's id AND its Gamepad API mapping, since
// the standard layout is known by the mapping, not by a product name.
export interface StickProfile {
  name: string // shown in the Joystick tab; a product name, not translated
  match: (id: string, mapping: string) => boolean
  axes: Record<string, string>
  buttons: Record<string, string>
}

// PROFILES is ordered, first match wins, so a named model beats the generic
// standard-gamepad entry and the catch-all sits last. A profile may only be
// added from MEASURED indices or a layout the platform guarantees - never
// inferred from a manual or a photo.
export const PROFILES: StickProfile[] = [
  {
    // Measured on the hardware. Buttons 8-11 are the END-OF-TRAVEL detents on
    // the throttle and speedbrake levers and carry nothing deliberately: they
    // duplicate what the axes already say, and an action bound to one fires on
    // every pull to idle. Button 14 and everything past the base diamond are
    // empty slots the device reports, not bindings waiting to be found. The
    // thumbwheel reaches the Gamepad API only in its DIGITAL mode (12 forward,
    // 13 back, set on the stick's OLED); in its default mouse mode it arrives
    // as DOM wheel events and pitch trim is unavailable on the stick.
    name: 'Turtle Beach VelocityOne Flightstick',
    match: (id) => /velocityone|10f5/i.test(id),
    // The castle POV pair at 8/9 is POSITIONAL weapon select - forward 120C,
    // aft 9M, left GUN, right NAV - so trim lives on the thumbwheel (12/13,
    // forward = nose down) and zoom keeps no stick binding.
    axes: { pitch: '1', roll: '0', yaw: '2', throttle: '-5', speedbrake: '-6', look: '3', trim: '', weapon: '8', zoom: '' },   // look = the smooth-hat ministick (axes 3/4, spring-centred); weapon = the castle POV pair (8/9). zoom: the thumbwheel is a SCROLL WHEEL on the stick's mouse interface — DOM wheel events, not a gamepad axis
    buttons: { fire: '17', 'brake.wheel': '17', acquire: '15', 'radar.undesignate': '16', flares: '0',
      gear: '7', hook: '6', atc: '1', override: '3', 'flaps.extend': '4', 'flaps.retract': '5',
      view: '2', 'view.reset': '18', 'trim.down': '12', 'trim.up': '13',
      // The base's front-centre diamond: displayed 20-23 in the Joystick tab,
      // stored 0-based as 19-22. Base buttons cannot be reached in a turn, so
      // they carry the deliberate actions.
      menu: '19', 'trim.left': '20', 'jettison.emergency': '21', 'trim.right': '22' },
  },
  {
    // The W3C standard gamepad layout, not measured and not needing to be: with
    // mapping === 'standard' the indices are fixed by specification - 0 A, 1 B,
    // 2 X, 3 Y, 4/5 shoulders, 6/7 triggers, 8 back, 9 start, 10/11 stick
    // presses, 12-15 d-pad; axes 0/1 left stick, 2/3 right stick. No twist or
    // throttle lever, so rudder rides the shoulders and throttle steps on the
    // d-pad as button actions.
    name: 'Standard gamepad',
    match: (_id, mapping) => mapping === 'standard',
    axes: { pitch: '1', roll: '0', yaw: '', throttle: '', speedbrake: '', look: '2', trim: '', weapon: '', zoom: '' },
    buttons: { fire: '7', 'brake.wheel': '6', gear: '0', flares: '1', select: '2', hook: '3',
      'yaw.left': '4', 'yaw.right': '5', 'throttle.up': '12', 'throttle.down': '13',
      'flaps.extend': '15', 'flaps.retract': '14', view: '10', 'look.target': '11', 'view.reset': '9' },
  },
  {
    // Everything else: the HID convention every stick follows — X roll, Y pitch,
    // twist yaw, and the trigger on button 0. Enough to fly and shoot on an
    // unknown stick; the rest is hand-bound in the Joystick tab.
    name: 'Generic joystick',
    match: () => true,
    axes: { pitch: '1', roll: '0', yaw: '2', throttle: '3', speedbrake: '', look: '', trim: '', weapon: '', zoom: '' },
    buttons: { fire: '0' },
  },
]

// profileFor names the built-in profile a pad resolves to (for the Joystick tab).
export function profileFor(id: string, mapping = ''): StickProfile {
  return PROFILES.find((p) => p.match(id, mapping)) ?? PROFILES[PROFILES.length - 1]
}

export function deviceDefaults(id: string, mapping = ''): StickBindings {
  const profile = profileFor(id, mapping)
  return { axes: { ...profile.axes }, buttons: { ...profile.buttons } }
}

// Mission configuration collected by the setup menu and handed to the engine.
// The index signature lets the engine treat it as a plain config bag (its cfg has
// a few more baked-in keys, e.g. the catapult spawn pose); the named fields keep
// their precise types for the menu.
export interface MissionConfig {
  task: 'free' | 'joust' // multiplayer is no longer a task: a MATCH is joined from the server page (#77)
  fuel: number
  record: boolean // record flights for replay download
  bandit: 'novice' | 'pilot' | 'ace' | 'superhuman'
  aircraft: 'fa18c' // one shipping aircraft today; the field + catalogue stay so a second type re-adds cleanly (client AIRCRAFT_MODELS, world aircraft.Get, and the menu picker)
  joystick: string // menu-selected stick id ('' = first connected)
  sticks: Record<string, StickBindings> // per-device axis/button maps, keyed by pad id
  keys: Record<string, string> // keyboard remaps: action -> key code (defaults live in the engine's KEYS table)
  start: 'air' | 'runway' | 'carrier' | 'case1' | 'case2' | 'case3' | 'landing' // landing = legacy saved value, read as case2 (#205)
  servers: string // recently joined world servers, newline-separated, most recent first (#77) — the config's index signature is scalar-or-record, and a bare array does not fit it
  pilot: string // this player's stable token: identifies the owner of a match offer across reconnects (#77)
  cat: number // carrier-start catapult 1-4
  tod: 'day' | 'night'
  clouds: 'none' | 'cumulus' | 'high_stratus' | 'mid_stratus' | 'low_stratus'
  render_scale: number
  exterior_detail: number
  ocean_segments: number
  dyn_res: boolean
  lod: boolean
  shadows: boolean
  afterburner: boolean
  tracers: boolean
  effects_quality: number // 0..3: particle density/detail; presets keep effects inside their GPU budget
  stores: Record<string, StationSlot> // per-station loadout (#17), station number -> slot; replaced the missiles boolean (legacy saves migrate in the store's load merge)
  sound: boolean
  volume: Record<string, number> // Sound-tab mixer, percent per bus: master, engine, aircraft, weapons, environment, alerts
  framerate: boolean
  world: string
  callsign: string
  // #57 parked: head: Record<string, number> // webcam head tracking (#57): on 0|1, gain (view amplification, ~5)
  cheats: Record<string, boolean> // invulnerable (humans only), ammunition, fuel — mission cheats; a multiplayer match takes its own set from the creator
  rules: Record<string, unknown> // the creator's persisted match rules (#17/#32): the weapons class and spacing, with missiles derived for old servers
  duel: 'merge' | 'bvr' // the joust's start (#32): today's merge, or head-on across the derived BVR separation, weapons free
  [key: string]: string | number | boolean | Record<string, string> | Record<string, number> | Record<string, boolean> | Record<string, unknown> | Record<string, StickBindings> | Record<string, StationSlot>
}

// seedStart applies a start choice with everything it defines: the recovery
// cases seed their weather and every start seeds matching fuel (NATOPS 4.1.7:
// full internal exceeds the 33,000 lb carrier landing limit). Seeded values
// stay overridable; re-picking re-seeds.
export function seedStart(config: MissionConfig, start: MissionConfig['start']): MissionConfig {
  const seeded = { ...config, start }
  if (start === 'case1') {
    seeded.tod = 'day'
    seeded.clouds = 'none'
    seeded.fuel = 4500
  } else if (start === 'case2') {
    seeded.tod = 'day'
    seeded.clouds = 'mid_stratus' // the Case II band (1,000-3,000 ft); low_stratus is a Case III ceiling and the two cases shared it until 2026-08-09
    seeded.fuel = 4500
  } else if (start === 'case3') {
    seeded.tod = 'night'
    seeded.clouds = 'low_stratus'
    seeded.fuel = 4500
  } else {
    seeded.fuel = 10800
  }
  return seeded
}

// Mirrors the engine's defaults so the menu reflects what an unconfigured game uses.
export const DEFAULT_CONFIG: MissionConfig = {
  task: 'joust',
  bandit: 'ace',
  fuel: 10800, // full internal — combat loads are a slider pull away
  record: true, // flight recorder (#212): always running, saved from the log
  aircraft: 'fa18c',
  joystick: '',
  sticks: {},
  keys: {},
  start: 'carrier',
  servers: '',
  pilot: '',
  cat: 2,
  tod: 'day',
  clouds: 'none',
  render_scale: 1.0,
  exterior_detail: 3,
  ocean_segments: 256,
  // Dynamic resolution defaults ON (#148): the frame-time governor sheds
  // render_scale (floor 0.45) when frames exceed 18 ms, so slow machines get a
  // smooth game instead of a slideshow. The Graphics tab switch still disables it.
  dyn_res: true,
  lod: true,
  shadows: false,
  afterburner: true,
  tracers: true,
  effects_quality: 2,
  stores: PRESETS.fox2, // new players fly the Fox 2 preset — six heaters, the armed bot standard's round count (#17, decided 2026-08-05)
  sound: true,
  volume: { master: 80, engine: 100, aircraft: 100, weapons: 100, environment: 100, alerts: 100 },
  framerate: false,
  world: '',
  callsign: '',
  // #57 parked: head: { on: 0, gain: 5 },
  cheats: {},
  rules: {},
  duel: 'merge',
}

export type GraphicsPreset = 'low' | 'med' | 'high' | 'ultra'

// A concrete patch (no index signature / undefined) so spreading it over a
// MissionConfig stays a MissionConfig.
type GraphicsPatch = Pick<
  MissionConfig,
  'render_scale' | 'ocean_segments' | 'exterior_detail' | 'effects_quality' | 'shadows'
>

export const GRAPHICS_PRESETS: Record<GraphicsPreset, GraphicsPatch> = {
  low: { render_scale: 0.6, ocean_segments: 96, exterior_detail: 1, effects_quality: 0, shadows: false },
  med: { render_scale: 1.0, ocean_segments: 192, exterior_detail: 3, effects_quality: 1, shadows: false },
  high: { render_scale: 1.0, ocean_segments: 320, exterior_detail: 4, effects_quality: 2, shadows: true },
  ultra: { render_scale: 1.5, ocean_segments: 512, exterior_detail: 5, effects_quality: 3, shadows: true },
}

// Which preset the current settings ARE, so the Graphics tab can mark the one
// in force. Equality is over the five preset fields only, and render_scale
// comes off a range input so it is compared with a tolerance.
export function graphicsPreset(config: MissionConfig): GraphicsPreset | null {
  const same = (a: number | boolean, b: number | boolean) =>
    typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-6 : a === b
  const keys = Object.keys(GRAPHICS_PRESETS.low) as (keyof GraphicsPatch)[]
  return (
    (Object.keys(GRAPHICS_PRESETS) as GraphicsPreset[]).find((p) =>
      keys.every((k) => same(config[k], GRAPHICS_PRESETS[p][k])),
    ) ?? null
  )
}
