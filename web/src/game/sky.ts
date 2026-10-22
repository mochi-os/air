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

// A star's direction in the world for an observer at `latitude` (degrees) under local sidereal time `local` (radians).
export function direction(star: Star, latitude: number, local: number): [number, number, number] {
  const phi = latitude * DEGREE, hour = local - star.ascension, dec = star.declination
  const east = -Math.cos(dec) * Math.sin(hour)
  const north = Math.cos(phi) * Math.sin(dec) - Math.sin(phi) * Math.cos(dec) * Math.cos(hour)
  const up = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(hour)
  return [east, up, -north]
}

// Brightness 0..1 and screen size in pixels at a 1080-line buffer, from magnitude. Flux is compressed
// so a 5th-magnitude star stays a visible point while Sirius, 250x brighter, is the brightest rather than a
// flare: by the power 0.3, which puts the faint stars at about a quarter of white and nothing new at white,
// where a clipped core would read as a larger star. The size keeps the power 0.45 it was set by, so a star
// is brighter, not bigger. The size is the sprite's full width: its Gaussian core is about 0.6 of it, so the
// 3.5 px floor keeps every star's core two pixels wide - a point narrower than a pixel lands between pixel
// centres and flickers on and off as the view moves, which is the twinkle.
export function light(magnitude: number): { brightness: number; size: number } {
  const flux = Math.min(Math.max(Math.pow(10, -0.4 * (magnitude - 6.0)), 1), 400) / 400
  return { brightness: Math.pow(flux, 0.3), size: 3.5 + 3.5 * Math.pow(flux, 0.45) }
}

// Linear-ish display tint from B-V: hot blue-white through sun-white to cool orange, kept pale as the
// eye sees starlight.
export function tint(colour: number): [number, number, number] {
  const t = Math.min(Math.max((colour + 0.3) / 2.0, 0), 1)
  const blue: [number, number, number] = [0.78, 0.86, 1.0], white: [number, number, number] = [1.0, 0.97, 0.92], orange: [number, number, number] = [1.0, 0.78, 0.55]
  const [a, b, s] = t < 0.45 ? [blue, white, t / 0.45] : [white, orange, (t - 0.45) / 0.55]
  return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s]
}

// A planet's orbit by JPL's approximate elements for 1800-2050 (Standish, "Keplerian Elements for
// Approximate Positions of the Major Planets"): the J2000 values and their rates per Julian century of
// a (au), e, I, L, the longitude of perihelion and the longitude of the node (degrees). Good to about an
// arcminute: Mars lands within 1.2' of JPL Horizons, whose places the tests hold it to.
const ORBITS: Record<'earth' | 'mars', [number[], number[]]> = {
  earth: [
    [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0],
    [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0],
  ], // the Earth-Moon barycentre: the Earth to within the moon's 4,700 km
  mars: [
    [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
    [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
  ],
}

// A body's heliocentric place, au, in J2000 equatorial axes, Julian centuries from J2000.
function heliocentric(orbit: [number[], number[]], centuries: number): [number, number, number] {
  const [a, e, inclination, longitude, perihelion, node] = orbit[0].map((value, i) => value + orbit[1][i] * centuries)
  const mean = (((((longitude - perihelion + 180) % 360) + 360) % 360) - 180) * DEGREE
  let eccentric = mean + e * Math.sin(mean)
  for (let i = 0; i < 8; i++) eccentric -= (eccentric - e * Math.sin(eccentric) - mean) / (1 - e * Math.cos(eccentric))
  const x = a * (Math.cos(eccentric) - e), y = a * Math.sqrt(1 - e * e) * Math.sin(eccentric)
  const w = (perihelion - node) * DEGREE, n = node * DEGREE, i = inclination * DEGREE
  const cw = Math.cos(w), sw = Math.sin(w), cn = Math.cos(n), sn = Math.sin(n), ci = Math.cos(i), si = Math.sin(i)
  const ex = (cw * cn - sw * sn * ci) * x + (-sw * cn - cw * sn * ci) * y
  const ey = (cw * sn + sw * cn * ci) * x + (-sw * sn + cw * cn * ci) * y
  const ez = sw * si * x + cw * si * y
  const tilt = 23.43928 * DEGREE   // the ecliptic's obliquity at J2000
  return [ex, Math.cos(tilt) * ey - Math.sin(tilt) * ez, Math.sin(tilt) * ey + Math.cos(tilt) * ez]
}

// A planet as the sky shows it at an instant: its geocentric J2000 place, so the stars' own direction()
// stands it in the local sky, its visual magnitude (Mallama & Hilton 2018, by distances and phase angle)
// and its B-V colour. The light's few minutes of travel and the observer's place on the Earth move Mars
// by under 20 arcseconds, and are left out.
export function planet(name: 'mars', date: Date): Star {
  const centuries = (date.getTime() / 86400000 + 2440587.5 - 2451545.0) / 36525
  const body = heliocentric(ORBITS[name], centuries), earth = heliocentric(ORBITS.earth, centuries)
  const seen = [body[0] - earth[0], body[1] - earth[1], body[2] - earth[2]]
  const distance = Math.hypot(...seen), sun = Math.hypot(...body), home = Math.hypot(...earth)
  const phase = Math.acos((sun * sun + distance * distance - home * home) / (2 * sun * distance)) / DEGREE
  return {
    ascension: (Math.atan2(seen[1], seen[0]) + 2 * Math.PI) % (2 * Math.PI),
    declination: Math.asin(seen[2] / distance),
    magnitude: -1.601 + 5 * Math.log10(sun * distance) + 0.02267 * phase - 0.0001302 * phase * phase,
    colour: 1.36,
  }
}

