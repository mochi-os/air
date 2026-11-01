// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The WGS84 ellipsoid, the geoid and the frames the game works in: the twin of
// the flight core's earth.go, which flies the same maths natively and in the
// wasm. The earth does not turn, and sea level is the geoid, mean sea level
// (geoid.ts, EGM2008): every altitude is a height above it.
//
// The world frame, EARTH, is Earth-centred: the server keeps its state in it
// and the wire carries it. A tangent frame is laid at an anchor: origin at
// sea level there, x east, y up along the ellipsoid's normal, z south - the
// axes the game has always used. Every frame is Cartesian, so lines, distances
// and angles between points are exact in any of them; only "up" and "level"
// belong to one place. HOME is the tangent frame at Midway, where the map is
// charted and the ship's track and the wakes are laid (the core's
// flight.Midway, an environment's chart). The engine works in a frame near its
// own jet, moved under it as it flies (rebase), where +y is up and y is the
// height above the sea to centimetres.

import { COLUMNS, GEOID, ROWS } from './geoid'

export const EQUATOR = 6378137 // semi-major axis, m
export const FLATTENING = 1 / 298.257223563
const POLE = EQUATOR * (1 - FLATTENING)
const ECCENTRIC = FLATTENING * (2 - FLATTENING) // first eccentricity squared
const SECOND = ECCENTRIC / (1 - ECCENTRIC) // second eccentricity squared
const OBLATENESS = EQUATOR / POLE
export const DEGREE = Math.PI / 180

export interface Vec { x: number; y: number; z: number }
export interface Quat { x: number; y: number; z: number; w: number }
export interface Place { latitude: number; longitude: number; altitude: number } // radians, radians, metres above sea level (the geoid)

const vec = (x: number, y: number, z: number): Vec => ({ x, y, z })
const dot = (a: Vec, b: Vec) => a.x * b.x + a.y * b.y + a.z * b.z
const cross = (a: Vec, b: Vec): Vec => vec(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x)
const scale = (a: Vec, s: number): Vec => vec(a.x * s, a.y * s, a.z * s)
const add = (a: Vec, b: Vec): Vec => vec(a.x + b.x, a.y + b.y, a.z + b.z)
const subtract = (a: Vec, b: Vec): Vec => vec(a.x - b.x, a.y - b.y, a.z - b.z)

// The geoid's table, decoded once: decimetres, 181 rows from 90 N, 361
// columns from 180 W (geoid.ts).
let table: Int16Array | null = null
function nodes(): Int16Array {
  if (!table) {
    const bytes = Uint8Array.from(atob(GEOID), (c) => c.charCodeAt(0))
    table = new Int16Array(ROWS * COLUMNS)
    const view = new DataView(bytes.buffer)
    for (let i = 0; i < table.length; i++) table[i] = view.getInt16(i * 2, true)
  }
  return table
}

// geoid is the height of mean sea level above the ellipsoid at a latitude and
// longitude, radians: EGM2008 at whole degrees, bilinear between, as the
// core's Geoid.
export function geoid(latitude: number, longitude: number): number {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return 0 // a place that is not one reads the ellipsoid
  const g = nodes()
  const row = Math.min(180, Math.max(0, (Math.PI / 2 - latitude) / DEGREE))
  let column = (longitude / DEGREE + 180) % 360
  if (column < 0) column += 360
  const r = Math.min(Math.floor(row), 179), c = Math.min(Math.floor(column), 359)
  const u = row - r, v = column - c, i = r * COLUMNS + c
  const a = g[i], b = g[i + 1], d = g[i + COLUMNS], e = g[i + COLUMNS + 1]
  return ((a * (1 - v) + b * v) * (1 - u) + (d * (1 - v) + e * v) * u) / 10
}

// centred is the earth-centred, earth-fixed position of a place: x through the
// equator at Greenwich, z through the north pole.
export function centred(p: Place): Vec {
  const sin = Math.sin(p.latitude), cos = Math.cos(p.latitude)
  const normal = EQUATOR / Math.sqrt(1 - ECCENTRIC * sin * sin)
  const h = p.altitude + geoid(p.latitude, p.longitude) // above the ellipsoid
  return vec((normal + h) * cos * Math.cos(p.longitude), (normal + h) * cos * Math.sin(p.longitude), (normal * (1 - ECCENTRIC) + h) * sin)
}

// geodetic is the place of an earth-centred point, in closed form
// (Heikkinen's solution, as the core's): well under a millimetre everywhere a
// jet or a wave can be, the poles included.
export function geodetic(e: Vec): Place {
  const a = EQUATOR, b = POLE
  const p = Math.sqrt(e.x * e.x + e.y * e.y)
  const z = e.z
  const f = 54 * b * b * z * z
  const g = p * p + (1 - ECCENTRIC) * z * z - ECCENTRIC * (a * a - b * b)
  const c = (ECCENTRIC * ECCENTRIC * f * p * p) / (g * g * g)
  const s = Math.cbrt(1 + c + Math.sqrt(c * c + 2 * c))
  const k = s + 1 + 1 / s
  const q = f / (3 * k * k * g * g)
  const r = Math.sqrt(1 + 2 * ECCENTRIC * ECCENTRIC * q)
  const root = (-q * ECCENTRIC * p) / (1 + r) + Math.sqrt(Math.max(0, ((a * a) / 2) * (1 + 1 / r) - (q * (1 - ECCENTRIC) * z * z) / (r * (1 + r)) - (q * p * p) / 2))
  const u = Math.sqrt((p - ECCENTRIC * root) ** 2 + z * z)
  const v = Math.sqrt((p - ECCENTRIC * root) ** 2 + (1 - ECCENTRIC) * z * z)
  const lift = (b * b * z) / (a * v)
  const latitude = Math.atan2(z + SECOND * lift, p), longitude = Math.atan2(e.y, e.x)
  return { latitude, longitude, altitude: u * (1 - (b * b) / (a * v)) - geoid(latitude, longitude) }
}

// columns is the rotation taking the unit axes to a, b and c.
function columns(a: Vec, b: Vec, c: Vec): Quat {
  const m00 = a.x, m01 = b.x, m02 = c.x, m10 = a.y, m11 = b.y, m12 = c.y, m20 = a.z, m21 = b.z, m22 = c.z
  let q: Quat
  const t = m00 + m11 + m22
  if (t > 0) {
    const r = Math.sqrt(1 + t), h = 0.5 / r
    q = { w: 0.5 * r, x: (m21 - m12) * h, y: (m02 - m20) * h, z: (m10 - m01) * h }
  } else if (m00 >= m11 && m00 >= m22) {
    const r = Math.sqrt(1 + m00 - m11 - m22), h = 0.5 / r
    q = { w: (m21 - m12) * h, x: 0.5 * r, y: (m01 + m10) * h, z: (m02 + m20) * h }
  } else if (m11 >= m22) {
    const r = Math.sqrt(1 - m00 + m11 - m22), h = 0.5 / r
    q = { w: (m02 - m20) * h, x: (m01 + m10) * h, y: 0.5 * r, z: (m12 + m21) * h }
  } else {
    const r = Math.sqrt(1 - m00 - m11 + m22), h = 0.5 / r
    q = { w: (m10 - m01) * h, x: (m02 + m20) * h, y: (m12 + m21) * h, z: 0.5 * r }
  }
  const l = Math.hypot(q.x, q.y, q.z, q.w)
  return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l }
}

// The quaternion algebra, as the core has it (body to frame, Hamilton).
export function multiply(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  }
}
const conjugate = (q: Quat): Quat => ({ w: q.w, x: -q.x, y: -q.y, z: -q.z })
export function rotate(q: Quat, v: Vec): Vec {
  const u = vec(q.x, q.y, q.z)
  const t = scale(cross(u, v), 2)
  return add(add(v, scale(t, q.w)), cross(u, t))
}
const normalise = (q: Quat): Quat => {
  const l = Math.hypot(q.x, q.y, q.z, q.w)
  return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l }
}

// Frame is a Cartesian frame of the earth: EARTH itself (centre), or the
// tangent frame at an anchor, origin at sea level there.
export class Frame {
  readonly latitude: number
  readonly longitude: number
  readonly origin: Vec
  readonly east: Vec
  readonly up: Vec
  readonly south: Vec
  readonly turn: Quat // frame to earth-centred
  readonly centre: boolean // EARTH: its origin the earth's centre, its axes the earth's own

  constructor(latitude: number, longitude: number, centre = false) {
    this.latitude = latitude
    this.longitude = longitude
    this.centre = centre
    if (centre) {
      this.east = vec(1, 0, 0)
      this.up = vec(0, 1, 0)
      this.south = vec(0, 0, 1)
      this.origin = vec(0, 0, 0)
      this.turn = { x: 0, y: 0, z: 0, w: 1 }
      return
    }
    const sinφ = Math.sin(latitude), cosφ = Math.cos(latitude), sinλ = Math.sin(longitude), cosλ = Math.cos(longitude)
    this.east = vec(-sinλ, cosλ, 0)
    this.up = vec(cosφ * cosλ, cosφ * sinλ, sinφ)
    this.south = cross(this.east, this.up)
    this.origin = centred({ latitude, longitude, altitude: 0 })
    this.turn = columns(this.east, this.up, this.south)
  }

  same(o: Frame): boolean {
    return this.centre === o.centre && this.latitude === o.latitude && this.longitude === o.longitude
  }
  // centred is the earth-centred position of a point given in the frame.
  centred(p: Vec): Vec {
    return add(add(add(this.origin, scale(this.east, p.x)), scale(this.up, p.y)), scale(this.south, p.z))
  }
  // local is the frame's coordinates of an earth-centred point.
  local(e: Vec): Vec {
    const d = subtract(e, this.origin)
    return vec(dot(d, this.east), dot(d, this.up), dot(d, this.south))
  }
  place(p: Vec): Place {
    return geodetic(this.centred(p))
  }
  position(p: Place): Vec {
    return this.local(centred(p))
  }
  altitude(p: Vec): number {
    return this.place(p).altitude
  }
  // level is the tangent frame under a point given in this frame.
  level(p: Vec): Frame {
    const place = this.place(p)
    return new Frame(place.latitude, place.longitude)
  }
  // normal is the ellipsoid's normal at a place, in this frame's axes.
  normal(place: Place): Vec {
    const sinφ = Math.sin(place.latitude), cosφ = Math.cos(place.latitude)
    const n = vec(cosφ * Math.cos(place.longitude), cosφ * Math.sin(place.longitude), sinφ)
    return vec(dot(n, this.east), dot(n, this.up), dot(n, this.south))
  }
  // upAt is the ellipsoid's normal at a point, in this frame's axes.
  upAt(p: Vec): Vec {
    return this.normal(this.place(p))
  }
  // sea is the point of the sea straight down this frame's own up from (x, 0,
  // z), and the rotation from the tangent frame there to this frame's axes:
  // how a ship placed by her chart position sits on the curved water. Newton
  // steps until a step moves under a tenth of a millimetre, as the core's.
  sea(x: number, z: number): { point: Vec; level: Quat } {
    const at = vec(x, 0, z)
    let place = this.place(at)
    for (let step = 0; step < 8; step++) {
      const fall = place.altitude / Math.max(this.normal(place).y, 0.1)
      at.y -= fall
      place = this.place(at)
      if (Math.abs(fall) < 1e-4) break
    }
    const level = new Frame(place.latitude, place.longitude)
    return { point: at, level: between(level, this).turn }
  }
  // clear reports whether the straight line between two points of the frame
  // passes above the sea everywhere: the earth's bulge hides a low jet from a
  // radar, a seeker or an eye a long way off. Exact, as the core's.
  clear(a: Vec, b: Vec): boolean {
    const p = this.centred(a), q = this.centred(b)
    p.z *= OBLATENESS
    q.z *= OBLATENESS
    const d = subtract(q, p)
    const length = dot(d, d)
    if (length === 0) return dot(p, p) >= EQUATOR * EQUATOR
    const t = Math.min(1, Math.max(0, -dot(p, d) / length))
    const near = add(p, scale(d, t))
    return dot(near, near) >= EQUATOR * EQUATOR
  }
}

// tangent is the frame anchored at a latitude and longitude, radians.
export function tangent(latitude: number, longitude: number): Frame {
  return new Frame(latitude, longitude)
}

// MIDWAY is the chart's anchor: the centre of Midway Atoll, the point the map
// is projected about (midway-prep/prep.py ORIGIN, map.json "origin"), so the
// map's (0, 0) is hung at its true place and everything on it lies where it
// really is.
export const MIDWAY = { latitude: 28.2334, longitude: -177.3668 } // degrees

// EARTH is the world frame: Earth-centred, Earth-fixed coordinates, x through
// the equator at Greenwich, z through the north pole. The server keeps its
// state in it and the wire carries it.
export const EARTH = new Frame(0, 0, true)

// HOME is the chart: the tangent frame at Midway, where the map is charted and
// the ship's track and the wakes are laid.
export const HOME = new Frame(MIDWAY.latitude * DEGREE, MIDWAY.longitude * DEGREE)

// Rigid is a rigid motion from one frame to another: a point p in the first
// is rotate(turn, p) + move in the second.
export interface Rigid { turn: Quat; move: Vec; plain: boolean }
export const IDENTITY: Rigid = { turn: { x: 0, y: 0, z: 0, w: 1 }, move: vec(0, 0, 0), plain: true }

export function between(from: Frame, to: Frame): Rigid {
  if (from.same(to)) return IDENTITY
  return { turn: normalise(multiply(conjugate(to.turn), from.turn)), move: to.local(from.origin), plain: false }
}
export function point(r: Rigid, p: Vec): Vec {
  return r.plain ? vec(p.x, p.y, p.z) : add(rotate(r.turn, p), r.move)
}
export function vector(r: Rigid, v: Vec): Vec {
  return r.plain ? vec(v.x, v.y, v.z) : rotate(r.turn, v)
}
export function attitude(r: Rigid, q: Quat): Quat {
  return r.plain ? { x: q.x, y: q.y, z: q.z, w: q.w } : normalise(multiply(r.turn, q))
}
export function inverse(r: Rigid): Rigid {
  if (r.plain) return r
  const back = conjugate(r.turn)
  return { turn: back, move: scale(rotate(back, r.move), -1), plain: false }
}

// theatre is the frame the engine works in now, and the motions between it
// and the world frame - inward carries a point of EARTH into it, outward back
// - and the chart: charted carries a point of HOME into it, charting back.
// The engine settles it as its jet flies on; the modules that turn its
// positions into latitudes and longitudes (navigation, the recorder) read it.
export const theatre = { frame: HOME, inward: IDENTITY, outward: IDENTITY, charted: IDENTITY, charting: IDENTITY }
export function settle(frame: Frame): void {
  theatre.frame = frame
  theatre.inward = between(EARTH, frame)
  theatre.outward = inverse(theatre.inward)
  theatre.charted = between(HOME, frame)
  theatre.charting = inverse(theatre.charted)
}
settle(HOME)

// level is a point given only across the frame's horizontal, at sea level:
// the sea straight down the frame's up from (x, z). A point that knows its
// height keeps it.
export function level(frame: Frame, p: { x: number; y?: number; z: number }): Vec {
  return { x: p.x, y: p.y ?? frame.sea(p.x, p.z).point.y, z: p.z }
}

// Geodesics on the ellipsoid (Vincenty's formulae): the distance along the
// surface between two places and the bearings at either end, and the place a
// distance along a bearing. Navigation reads them: a waypoint 500 km off lies
// along a great circle, not a line drawn on a flat map.
export function geodesic(from: Place, to: Place): { distance: number; bearing: number; arrival: number } {
  const a = EQUATOR, b = POLE, f = FLATTENING
  const L = to.longitude - from.longitude
  const U1 = Math.atan((1 - f) * Math.tan(from.latitude)), U2 = Math.atan((1 - f) * Math.tan(to.latitude))
  const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1), sinU2 = Math.sin(U2), cosU2 = Math.cos(U2)
  let λ = L, previous = 0, iterations = 0
  let sinσ = 0, cosσ = 1, σ = 0, cos2α = 1, cos2σm = 0, sinλ = 0, cosλ = 1
  do {
    sinλ = Math.sin(λ)
    cosλ = Math.cos(λ)
    sinσ = Math.sqrt((cosU2 * sinλ) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosλ) ** 2)
    if (sinσ === 0) return { distance: 0, bearing: 0, arrival: 0 }
    cosσ = sinU1 * sinU2 + cosU1 * cosU2 * cosλ
    σ = Math.atan2(sinσ, cosσ)
    const sinα = (cosU1 * cosU2 * sinλ) / sinσ
    cos2α = 1 - sinα * sinα
    cos2σm = cos2α !== 0 ? cosσ - (2 * sinU1 * sinU2) / cos2α : 0
    const C = (f / 16) * cos2α * (4 + f * (4 - 3 * cos2α))
    previous = λ
    λ = L + (1 - C) * f * sinα * (σ + C * sinσ * (cos2σm + C * cosσ * (-1 + 2 * cos2σm * cos2σm)))
  } while (Math.abs(λ - previous) > 1e-12 && ++iterations < 200)
  if (iterations >= 200) {
    // Nearly antipodal: Vincenty does not converge. The great circle on the
    // mean sphere is within a part in three hundred, and no waypoint is set
    // there.
    const R = 6371008.8
    const d = Math.acos(Math.min(1, Math.max(-1, Math.sin(from.latitude) * Math.sin(to.latitude) + Math.cos(from.latitude) * Math.cos(to.latitude) * Math.cos(L))))
    const y = Math.sin(L) * Math.cos(to.latitude), x = Math.cos(from.latitude) * Math.sin(to.latitude) - Math.sin(from.latitude) * Math.cos(to.latitude) * Math.cos(L)
    return { distance: R * d, bearing: (Math.atan2(y, x) + 2 * Math.PI) % (2 * Math.PI), arrival: (Math.atan2(y, x) + 2 * Math.PI) % (2 * Math.PI) }
  }
  const u2 = (cos2α * (a * a - b * b)) / (b * b)
  const A = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)))
  const B = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)))
  const Δσ = B * sinσ * (cos2σm + (B / 4) * (cosσ * (-1 + 2 * cos2σm * cos2σm) - (B / 6) * cos2σm * (-3 + 4 * sinσ * sinσ) * (-3 + 4 * cos2σm * cos2σm)))
  const distance = b * A * (σ - Δσ)
  const bearing = Math.atan2(cosU2 * sinλ, cosU1 * sinU2 - sinU1 * cosU2 * cosλ)
  const arrival = Math.atan2(cosU1 * sinλ, -sinU1 * cosU2 + cosU1 * sinU2 * cosλ)
  return { distance, bearing: (bearing + 2 * Math.PI) % (2 * Math.PI), arrival: (arrival + 2 * Math.PI) % (2 * Math.PI) }
}

export function destination(from: Place, bearing: number, distance: number): Place {
  const a = EQUATOR, b = POLE, f = FLATTENING
  const sinα1 = Math.sin(bearing), cosα1 = Math.cos(bearing)
  const tanU1 = (1 - f) * Math.tan(from.latitude), cosU1 = 1 / Math.sqrt(1 + tanU1 * tanU1), sinU1 = tanU1 * cosU1
  const σ1 = Math.atan2(tanU1, cosα1)
  const sinα = cosU1 * sinα1, cos2α = 1 - sinα * sinα
  const u2 = (cos2α * (a * a - b * b)) / (b * b)
  const A = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)))
  const B = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)))
  let σ = distance / (b * A), previous = 0, iterations = 0
  let cos2σm = 0, sinσ = 0, cosσ = 1
  do {
    cos2σm = Math.cos(2 * σ1 + σ)
    sinσ = Math.sin(σ)
    cosσ = Math.cos(σ)
    const Δσ = B * sinσ * (cos2σm + (B / 4) * (cosσ * (-1 + 2 * cos2σm * cos2σm) - (B / 6) * cos2σm * (-3 + 4 * sinσ * sinσ) * (-3 + 4 * cos2σm * cos2σm)))
    previous = σ
    σ = distance / (b * A) + Δσ
  } while (Math.abs(σ - previous) > 1e-12 && ++iterations < 200)
  const x = sinU1 * sinσ - cosU1 * cosσ * cosα1
  const latitude = Math.atan2(sinU1 * cosσ + cosU1 * sinσ * cosα1, (1 - f) * Math.sqrt(sinα * sinα + x * x))
  const λ = Math.atan2(sinσ * sinα1, cosU1 * cosσ - sinU1 * sinσ * cosα1)
  const C = (f / 16) * cos2α * (4 + f * (4 - 3 * cos2α))
  const L = λ - (1 - C) * f * sinα * (σ + C * sinσ * (cos2σm + C * cosσ * (-1 + 2 * cos2σm * cos2σm)))
  let longitude = from.longitude + L
  longitude = ((((longitude + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI
  return { latitude, longitude, altitude: from.altitude }
}
