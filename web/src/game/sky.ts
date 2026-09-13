// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The real night sky: catalogue stars placed for an observer at a latitude and
// longitude on a given date. Dependency-free so it unit-tests in isolation.
// World axes follow the engine: +x east, +y up, -z north.

const DEGREE = Math.PI / 180

export interface Star {
  ascension: number // right ascension, radians (J2000)
  declination: number // radians (J2000)
  magnitude: number // visual
  colour: number // B-V index
}

// Decode the packed catalogue (tools/stars.py): 6 bytes a star, little-endian.
export function decode(data: string, count: number): Star[] {
  const binary = atob(data)
  if (binary.length !== count * 6) throw new Error(`star catalogue is ${binary.length} bytes, expected ${count * 6}`)
  const view = new DataView(new Uint8Array([...binary].map((c) => c.charCodeAt(0))).buffer)
  const stars: Star[] = []
  for (let i = 0; i < count; i++) {
    const o = i * 6
    stars.push({
      ascension: (view.getUint16(o, true) / 65536) * 2 * Math.PI,
      declination: (view.getInt16(o + 2, true) / 32767) * (Math.PI / 2),
      magnitude: view.getUint8(o + 4) / 20 - 2,
      colour: view.getInt8(o + 5) / 50,
    })
  }
  return stars
}

// Greenwich mean sidereal time, radians, for an instant (IAU 1982, to well under a second of time).
export function sidereal(date: Date): number {
  const days = date.getTime() / 86400000 + 2440587.5 - 2451545.0
  const centuries = days / 36525
  const degrees = 280.46061837 + 360.98564736629 * days + 0.000387933 * centuries * centuries
  return ((((degrees % 360) + 360) % 360) * DEGREE)
}

// Local mean midnight at a longitude (degrees, east positive) on the UTC calendar date of `date`:
// the hour a full moon stands due south at its highest, as the game's night moon does.
export function midnight(date: Date, longitude: number): Date {
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  const hours = (((-longitude / 15) % 24) + 24) % 24
  return new Date(day + hours * 3600000)
}

// A star's direction in the world for an observer at `latitude` (degrees) under local sidereal time `local` (radians).
export function direction(star: Star, latitude: number, local: number): [number, number, number] {
  const phi = latitude * DEGREE, hour = local - star.ascension, dec = star.declination
  const east = -Math.cos(dec) * Math.sin(hour)
  const north = Math.cos(phi) * Math.sin(dec) - Math.sin(phi) * Math.cos(dec) * Math.cos(hour)
  const up = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(hour)
  return [east, up, -north]
}

// Brightness 0..1 and screen size in pixels at a 1080-line buffer, from magnitude. Flux is compressed
// (a square-root-like response) so a 6th-magnitude star stays a faint visible point while Sirius, 1,700x
// brighter, is the brightest rather than a flare. The size is the sprite's full width: its Gaussian core is
// about 0.6 of it, so the 3.5 px floor keeps every star's core two pixels wide - a point narrower than a
// pixel lands between pixel centres and flickers on and off as the view moves, which is the twinkle.
export function light(magnitude: number): { brightness: number; size: number } {
  const flux = Math.min(Math.max(Math.pow(10, -0.4 * (magnitude - 6.0)), 1), 400)
  const brightness = Math.pow(flux, 0.45) / Math.pow(400, 0.45)
  return { brightness, size: 3.5 + 3.5 * brightness }
}

// Linear-ish display tint from B-V: hot blue-white through sun-white to cool orange, kept pale as the
// eye sees starlight.
export function tint(colour: number): [number, number, number] {
  const t = Math.min(Math.max((colour + 0.3) / 2.0, 0), 1)
  const blue: [number, number, number] = [0.78, 0.86, 1.0], white: [number, number, number] = [1.0, 0.97, 0.92], orange: [number, number, number] = [1.0, 0.78, 0.55]
  const [a, b, s] = t < 0.45 ? [blue, white, t / 0.45] : [white, orange, (t - 0.45) / 0.55]
  return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s]
}
