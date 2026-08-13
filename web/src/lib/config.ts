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

// Built-in per-device bindings — the SINGLE source: the engine's pad_bindings and
// the menu's Joystick tab both read this (a duplicated mirror once showed stale
// defaults after Reset). "-N" = reversed axis sense; look = the axis pair that
// looks around (x index, y at x+1); a buttons value may list several indices
// comma-separated. VelocityOne notes: buttons 8-11 are LATCHING base toggles —
// never bind them to momentary actions; fire and the wheel brakes share a button
// because the gear decides which applies.
// One built-in profile. `match` decides whether a connected pad is this model:
// it gets the pad's id AND its Gamepad API mapping, because the standard
// gamepad layout is identified by the mapping rather than by any product name.
export interface StickProfile {
  name: string // shown in the Joystick tab; a product name, not translated
  match: (id: string, mapping: string) => boolean
  axes: Record<string, string>
  buttons: Record<string, string>
}

// PROFILES is ordered: the FIRST match wins, so a named model beats the generic
// standard-gamepad entry, and the fallback sits last matching everything.
//
// A profile may only be added from MEASURED indices — read off the hardware in
// the Joystick tab — or from a layout the platform GUARANTEES. Never infer them
// from a product photo or a manual's button numbering: a guessed map attaches
// every binding to the wrong control, and the player reads that as the game
// being broken rather than as a wrong profile.
export const PROFILES: StickProfile[] = [
  {
    // Measured on the hardware 2026-08-11. select: the old missile button becomes
    // weapon select — one trigger fires the SELECTED weapon, like the real stick.
    // zoom.in/out: the trim wheel in its DIGITAL mode pulses one button per notch
    // (12 forward, 13 back — set via the stick's OLED; its default mouse-cursor
    // mode is invisible to the Gamepad API). Buttons 8-11 are LATCHING base
    // toggles and carry nothing: a latch cannot drive a momentary action.
    // Deliberately keyboard-only, the stick having run out of buttons: trim
    // reset, look-at-target, the jettison family, the radar controls, lights,
    // launch and the speed brake.
    name: 'Turtle Beach VelocityOne Flightstick',
    match: (id) => /velocityone|10f5/i.test(id),
    axes: { pitch: '1', roll: '0', yaw: '2', throttle: '-5', speedbrake: '-6', look: '3', trim: '8', zoom: '' },   // look = the smooth-hat ministick (axes 3/4, spring-centred); the castle POV pair at 8/9 is the trim hat. zoom: the thumbwheel is a SCROLL WHEEL on the stick's mouse interface — DOM wheel events, not a gamepad axis
    buttons: { fire: '17', 'brake.wheel': '17', select: '15', acquire: '16', flares: '0',
      gear: '7', hook: '6', atc: '1', override: '3', 'flaps.extend': '4', 'flaps.retract': '5',
      view: '2', 'view.reset': '18', 'zoom.in': '12', 'zoom.out': '13' },
  },
  {
    // The W3C standard gamepad layout. This one is NOT measured and does not need
    // to be: when the browser reports mapping === 'standard' the indices are
    // fixed by specification — 0 A, 1 B, 2 X, 3 Y, 4/5 shoulders, 6/7 triggers,
    // 8 back, 9 start, 10/11 stick presses, 12-15 d-pad; axes 0/1 left stick,
    // 2/3 right stick. So it can be written correctly for hardware nobody here
    // owns, which no other profile can claim.
    // A gamepad has no twist and no throttle lever, so rudder rides the shoulders
    // and throttle steps on the d-pad — both as BUTTON actions replaying their
    // keys. The right stick is the look pair (2/3); R3 holds look-at-target.
    name: 'Standard gamepad',
    match: (_id, mapping) => mapping === 'standard',
    axes: { pitch: '1', roll: '0', yaw: '', throttle: '', speedbrake: '', look: '2', trim: '', zoom: '' },
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
    axes: { pitch: '1', roll: '0', yaw: '2', throttle: '3', speedbrake: '', look: '', trim: '', zoom: '' },
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
  invert: boolean
  framerate: boolean
  world: string
  callsign: string
  // #57 parked: head: Record<string, number> // webcam head tracking (#57): on 0|1, gain (view amplification, ~5)
  cheats: Record<string, boolean> // invulnerable (humans only), ammunition, fuel — mission cheats; a multiplayer match takes its own set from the creator
  rules: Record<string, unknown> // the creator's persisted match rules (#17/#32): the weapons class and spacing, with missiles derived for old servers
  duel: 'merge' | 'bvr' // the joust's start (#32): today's merge, or head-on across the derived BVR separation, weapons free
  [key: string]: string | number | boolean | Record<string, string> | Record<string, number> | Record<string, boolean> | Record<string, unknown> | Record<string, StickBindings> | Record<string, StationSlot>
}

// seedStart applies a start choice with everything that choice defines: the
// recovery cases seed their authentic weather, and every start seeds the fuel
// that fits it — a pattern entry arrives with mission-end gas (NATOPS 4.1.7:
// full internal is over the 33,000 lb carrier landing limit before a single
// missile hangs), a launch leaves with full tanks. All of it stays freely
// overridable in the controls below the selector; re-picking a start re-seeds.
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
  record: true, // flight recorder (#212): always running, saved from History
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
  invert: false,
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
