// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
// The free in-air start (#167): a jet placed anywhere on the earth from the
// create flight dialog, at a latitude and longitude, an altitude, a true
// heading and an indicated airspeed. spawn turns the choice into what the
// flight core's level trim takes: a point and a horizontal direction in the
// world frame (earth.ts HOME), and a true airspeed.
import { DEGREE, HOME, centred, tangent, type Vec } from './earth'

export interface Choice {
  latitude: number // degrees, north positive
  longitude: number // degrees, east positive
  altitude: number // feet above the sea
  heading: number // degrees true
  airspeed: number // knots, calibrated: what the HUD shows
}

// FREE is a choice's defaults: Midway, where every other start is, at a
// height and speed a pilot can fly away from in any direction.
export const FREE: Choice = {
  latitude: 28.2334,
  longitude: -177.3668,
  altitude: 10000,
  heading: 0,
  airspeed: 350,
}

// The choice's limits, as the dialog's controls offer them.
export const LIMITS = {
  altitude: { minimum: 500, maximum: 50000, step: 500 },
  heading: { minimum: 0, maximum: 359, step: 1 },
  airspeed: { minimum: 150, maximum: 700, step: 10 },
}

const FOOT = 0.3048,
  KNOT = 1852 / 3600

// The flight core's standard atmosphere (world/games/air/flight/atmosphere.go),
// with no temperature or pressure offset: free flight's.
const SURFACE = 288.15,
  PRESSURE = 101325,
  LAPSE = 0.0065,
  TROPOPAUSE = 11000,
  GAS = 287.053,
  GRAVITY = 9.80665,
  HEAT = 1.4
function air(height: number): { pressure: number; sound: number } {
  const h = Math.max(0, height)
  const top = SURFACE - LAPSE * Math.min(h, TROPOPAUSE)
  const at = PRESSURE * Math.pow(top / SURFACE, GRAVITY / (LAPSE * GAS))
  const pressure =
    h <= TROPOPAUSE
      ? at
      : at * Math.exp((-GRAVITY * (h - TROPOPAUSE)) / (GAS * top))
  return { pressure, sound: Math.sqrt(HEAT * GAS * top) }
}

// speed is the true airspeed, m/s, of a calibrated airspeed in knots at a
// height in metres: the impact pressure the airspeed indicator reads, carried
// to the height's static pressure (subsonic pitot).
export function speed(knots: number, height: number): number {
  const sea = air(0),
    here = air(height)
  const calibrated = (knots * KNOT) / sea.sound
  const impact =
    sea.pressure * (Math.pow(1 + 0.2 * calibrated * calibrated, 3.5) - 1)
  const mach = Math.sqrt(5 * (Math.pow(impact / here.pressure + 1, 2 / 7) - 1))
  return mach * here.sound
}

// clamp keeps a choice inside the earth and the dialog's limits, filling what
// is missing from FREE.
export function clamp(choice: Partial<Choice>): Choice {
  const number = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback
  const within = (v: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, v))
  const longitude = number(choice.longitude, FREE.longitude)
  return {
    latitude: within(number(choice.latitude, FREE.latitude), -90, 90),
    longitude: ((((longitude + 180) % 360) + 360) % 360) - 180,
    altitude: within(
      number(choice.altitude, FREE.altitude),
      LIMITS.altitude.minimum,
      LIMITS.altitude.maximum
    ),
    heading: ((number(choice.heading, FREE.heading) % 360) + 360) % 360,
    airspeed: within(
      number(choice.airspeed, FREE.airspeed),
      LIMITS.airspeed.minimum,
      LIMITS.airspeed.maximum
    ),
  }
}

// spawn is where the core's level trim lays the jet: the point in the world
// frame, the horizontal direction it takes there, and the true airspeed. The
// trim turns the direction into the frame level under the point and flies
// what lies across that level (flight/trim.go Level), which far from Midway
// is not the world frame's own horizontal: the direction is the one the core
// turns back into the heading chosen.
export function spawn(choice: Partial<Choice>): {
  position: Vec
  direction: { x: number; z: number }
  speed: number
} {
  const c = clamp(choice)
  const height = c.altitude * FOOT
  const place = {
    latitude: c.latitude * DEGREE,
    longitude: c.longitude * DEGREE,
    altitude: height,
  }
  const level = tangent(place.latitude, place.longitude)
  const dot = (a: Vec, b: Vec) => a.x * b.x + a.y * b.y + a.z * b.z
  // The world frame's east and south in the level frame's axes: what a world
  // direction (x, 0, z) becomes there.
  const east = { x: dot(HOME.east, level.east), z: dot(HOME.east, level.south) }
  const south = {
    x: dot(HOME.south, level.east),
    z: dot(HOME.south, level.south),
  }
  const h = c.heading * DEGREE,
    want = { x: Math.sin(h), z: -Math.cos(h) }
  const det = east.x * south.z - south.x * east.z
  let x = (want.x * south.z - south.x * want.z) / det,
    z = (east.x * want.z - want.x * east.z) / det
  if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(det) < 1e-9) {
    x = want.x
    z = want.z // the world frame's horizontal stands on edge there: its antipode's neighbourhood
  }
  const length = Math.hypot(x, z) || 1
  return {
    position: HOME.local(centred(place)),
    direction: { x: x / length, z: z / length },
    speed: speed(c.airspeed, height),
  }
}

// parse reads a latitude or longitude typed into the dialog: decimal degrees
// with either decimal mark, a leading sign, or a trailing hemisphere letter.
export function parse(
  text: string,
  axis: 'latitude' | 'longitude'
): number | null {
  const m =
    /^\s*([+-]?\d+(?:[.,]\d*)?|[+-]?[.,]\d+)\s*°?\s*([NSEWnsew])?\s*$/.exec(
      text
    )
  if (!m) return null
  let v = parseFloat(m[1].replace(',', '.'))
  const hemisphere = (m[2] || '').toUpperCase()
  if (hemisphere) {
    if ((axis === 'latitude') !== (hemisphere === 'N' || hemisphere === 'S'))
      return null
    if (v < 0) return null
    if (hemisphere === 'S' || hemisphere === 'W') v = -v
  }
  const limit = axis === 'latitude' ? 90 : 180
  return Number.isFinite(v) && Math.abs(v) <= limit ? v : null
}

// The global map's projection (atlas.ts, public/maps/world/global.webp): plate
// carrée from 180° W at the left and 90° N at the top, its columns and rows
// the same arc. on is the place under a point of the image as fractions of
// its width and height; at the fraction of the image a place stands at.
export const SPAN = {
  width: (2 * Math.PI * 6378137) / 8192 / 4892,
  height: (Math.PI * 6378137) / 8192 / 2446,
} // the share of the image the earth fills: its last column runs a fraction past the antimeridian
export function on(
  across: number,
  down: number
): { latitude: number; longitude: number } {
  return {
    latitude: 90 - (down / SPAN.height) * 180,
    longitude: (across / SPAN.width) * 360 - 180,
  }
}
export function at(
  latitude: number,
  longitude: number
): { across: number; down: number } {
  return {
    across: ((longitude + 180) / 360) * SPAN.width,
    down: ((90 - latitude) / 180) * SPAN.height,
  }
}
