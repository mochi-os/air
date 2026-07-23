// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// One joystick's bindings: which pad axis drives each aircraft axis ('' = none),
// and which pad button provides each action ('' = none). Missing entries fall
// back to the engine's built-in device defaults.
export interface StickBindings {
  axes: Record<string, string>
  buttons: Record<string, string>
}

// Built-in per-device bindings — the SINGLE source: the engine's pad_bindings and
// the menu's Joystick tab both read this (a duplicated mirror once showed stale
// defaults after Reset). "-N" = reversed axis sense; look = the axis pair that
// looks around (x index, y at x+1); a buttons value may list several indices
// comma-separated. VelocityOne notes: buttons 8-11 are LATCHING base toggles —
// never bind them to momentary actions; guns and wheel brakes share a button
// because the gear decides which applies.
export function deviceDefaults(id: string): StickBindings {
  const vone = /velocityone|10f5/i.test(id)
  return {
    axes: { pitch: '1', roll: '0', yaw: '2', throttle: vone ? '-5' : '3', speedbrake: vone ? '-6' : '', look: vone ? '3' : '', zoom: '' },   // look = the smooth-hat ministick (axes 3/4, spring-centred — measured; the castle POV pair at 8/9 stays free). zoom: the VelocityOne thumbwheel is a SCROLL WHEEL on the stick's mouse interface — DOM wheel events, not a gamepad axis; the axis forms ("N", "N+") remain for sticks whose wheel is a real axis
    buttons: vone
      ? { guns: '17', 'brake.wheel': '17', select: '15', flares: '16', gear: '3', hook: '2', 'zoom.in': '12', 'zoom.out': '13' }   // select: the old missile button becomes weapon select — one trigger fires the selected weapon, like the real stick. zoom.in/out: the trim wheel in its DIGITAL mode pulses one button per notch (12 forward, 13 back — set via the stick's OLED; its default mouse-cursor mode is invisible to the Gamepad API)
      : { guns: '0' },
  }
}

// Mission configuration collected by the setup menu and handed to the engine.
// The index signature lets the engine treat it as a plain config bag (its cfg has
// a few more baked-in keys, e.g. the catapult spawn pose); the named fields keep
// their precise types for the menu.
export interface MissionConfig {
  task: 'free' | 'joust' | 'multiplayer'
  fuel: number
  bandit: 'rookie' | 'pilot' | 'veteran' | 'ace'
  aircraft: 'fa18c' // one shipping aircraft today; the field + catalogue stay so a second type re-adds cleanly (client AIRCRAFT_MODELS, world aircraft.Get, and the menu picker)
  joystick: string // menu-selected stick id ('' = first connected)
  sticks: Record<string, StickBindings> // per-device axis/button maps, keyed by pad id
  keys: Record<string, string> // keyboard remaps: action -> key code (defaults live in the engine's KEYS table)
  start: 'air' | 'runway' | 'carrier' | 'landing'
  cat: number // carrier-start catapult 1-4
  tod: 'day' | 'night'
  clouds: 'none' | 'cumulus' | 'high_stratus' | 'low_stratus'
  render_scale: number
  exterior_detail: number
  ocean_segments: number
  extra_aircraft: number
  dyn_res: boolean
  lod: boolean
  shadows: boolean
  afterburner: boolean
  tracers: boolean
  missiles: boolean
  flares: boolean
  sound: boolean
  volume: Record<string, number> // Sound-tab mixer, percent per bus: master, engine, aircraft, weapons, environment, alerts
  invert: boolean
  framerate: boolean
  world: string
  callsign: string
  cheats: Record<string, boolean> // invulnerable (humans only), ammunition, fuel — mission cheats; a multiplayer match takes its own set from the creator
  [key: string]: string | number | boolean | Record<string, string> | Record<string, number> | Record<string, boolean> | Record<string, StickBindings>
}

// Mirrors the engine's defaults so the menu reflects what an unconfigured game uses.
export const DEFAULT_CONFIG: MissionConfig = {
  task: 'joust',
  bandit: 'veteran',
  fuel: 6000,
  aircraft: 'fa18c',
  joystick: '',
  sticks: {},
  keys: {},
  start: 'carrier',
  cat: 2,
  tod: 'day',
  clouds: 'none',
  render_scale: 1.0,
  exterior_detail: 3,
  ocean_segments: 256,
  extra_aircraft: 0,
  // Dynamic resolution defaults ON (#148): the frame-time governor sheds
  // render_scale (floor 0.45) when frames exceed 18 ms, so slow machines get a
  // smooth game instead of a slideshow. The Graphics tab switch still disables it.
  dyn_res: true,
  lod: true,
  shadows: false,
  afterburner: true,
  tracers: true,
  missiles: true,
  flares: true,
  sound: true,
  volume: { master: 80, engine: 100, aircraft: 100, weapons: 100, environment: 100, alerts: 100 },
  invert: false,
  framerate: false,
  world: '',
  callsign: '',
  cheats: {},
}

export type GraphicsPreset = 'low' | 'med' | 'high' | 'ultra'

// A concrete patch (no index signature / undefined) so spreading it over a
// MissionConfig stays a MissionConfig.
type GraphicsPatch = Pick<
  MissionConfig,
  'render_scale' | 'ocean_segments' | 'exterior_detail' | 'shadows'
>

export const GRAPHICS_PRESETS: Record<GraphicsPreset, GraphicsPatch> = {
  low: { render_scale: 0.6, ocean_segments: 96, exterior_detail: 1, shadows: false },
  med: { render_scale: 1.0, ocean_segments: 192, exterior_detail: 3, shadows: false },
  high: { render_scale: 1.0, ocean_segments: 320, exterior_detail: 4, shadows: true },
  ultra: { render_scale: 1.5, ocean_segments: 512, exterior_detail: 5, shadows: true },
}
