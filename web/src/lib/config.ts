// Copyright © 2026 Mochi OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Mission configuration collected by the setup menu and handed to the engine.
// The index signature lets the engine treat it as a plain config bag (its cfg has
// a few more baked-in keys, e.g. the catapult spawn pose); the named fields keep
// their precise types for the menu.
export interface MissionConfig {
  task: 'free' | 'joust' | 'multiplayer'
  aircraft: 'fa18f' | 'fa18c'
  start: 'air' | 'runway' | 'carrier' | 'landing'
  tod: 'day' | 'night'
  clouds: 'none' | 'cumulus' | 'high_stratus' | 'low_stratus'
  render_scale: number
  sens: number
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
  invert: boolean
  framerate: boolean
  world: string
  callsign: string
  [key: string]: string | number | boolean
}

// Mirrors the engine's defaults so the menu reflects what an unconfigured game uses.
export const DEFAULT_CONFIG: MissionConfig = {
  task: 'joust',
  aircraft: 'fa18c',
  start: 'carrier',
  tod: 'day',
  clouds: 'none',
  render_scale: 1.0,
  sens: 1.0,
  exterior_detail: 3,
  ocean_segments: 256,
  extra_aircraft: 0,
  dyn_res: false,
  lod: true,
  shadows: false,
  afterburner: true,
  tracers: true,
  missiles: true,
  flares: true,
  invert: false,
  framerate: false,
  world: '',
  callsign: '',
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
