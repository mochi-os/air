// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The earth's magnetic field, from the World Magnetic Model 2025 of NOAA's
// National Centers for Environmental Information and the British Geological
// Survey (public domain; Credits cites it): a spherical harmonic series of
// degree and order 12, valid from 2025.0 to 2030.0, evaluated at a place on
// the WGS84 ellipsoid as the model's technical report sets out. The jet's
// navigation reads its declination as the magnetic variation (NATOPS
// 24.2.5.6), and the standby compass's card swings in the whole field.

import { EQUATOR, FLATTENING, type Place, type Vec } from './earth'

const EPOCH = 2025
const END = 2030 // a date outside the model's span is held to its nearer end
const RADIUS = 6371200 // the geomagnetic reference radius, m
const ORDER = 12
const ECCENTRIC = FLATTENING * (2 - FLATTENING)

// MODEL: the Gauss coefficients g and h and their yearly rates of change,
// nT and nT a year, Schmidt semi-normalised, for n from 1 to 12 and m from 0
// to n in turn: WMM.COF as NOAA publishes it.
// prettier-ignore
const MODEL = [
  // n = 1
  -29351.8, 0, 12, 0, -1410.8, 4545.4, 9.7, -21.5,
  // n = 2
  -2556.6, 0, -11.6, 0, 2951.1, -3133.6, -5.2, -27.7, 1649.3, -815.1, -8, -12.1,
  // n = 3
  1361, 0, -1.3, 0, -2404.1, -56.6, -4.2, 4, 1243.8, 237.5, 0.4, -0.3, 453.6, -549.5, -15.6, -4.1,
  // n = 4
  895, 0, -1.6, 0, 799.5, 278.6, -2.4, -1.1, 55.7, -133.9, -6, 4.1, -281.1, 212, 5.6, 1.6, 12.1, -375.6, -7, -4.4,
  // n = 5
  -233.2, 0, 0.6, 0, 368.9, 45.4, 1.4, -0.5, 187.2, 220.2, 0, 2.2, -138.7, -122.9, 0.6, 0.4, -142, 43, 2.2, 1.7,
  20.9, 106.1, 0.9, 1.9,
  // n = 6
  64.4, 0, -0.2, 0, 63.8, -18.4, -0.4, 0.3, 76.9, 16.8, 0.9, -1.6, -115.7, 48.8, 1.2, -0.4, -40.9, -59.8, -0.9, 0.9,
  14.9, 10.9, 0.3, 0.7, -60.7, 72.7, 0.9, 0.9,
  // n = 7
  79.5, 0, -0, 0, -77, -48.9, -0.1, 0.6, -8.8, -14.4, -0.1, 0.5, 59.3, -1, 0.5, -0.8, 15.8, 23.4, -0.1, 0,
  2.5, -7.4, -0.8, -1, -11.1, -25.1, -0.8, 0.6, 14.2, -2.3, 0.8, -0.2,
  // n = 8
  23.2, 0, -0.1, 0, 10.8, 7.1, 0.2, -0.2, -17.5, -12.6, 0, 0.5, 2, 11.4, 0.5, -0.4, -21.7, -9.7, -0.1, 0.4,
  16.9, 12.7, 0.3, -0.5, 15, 0.7, 0.2, -0.6, -16.8, -5.2, -0, 0.3, 0.9, 3.9, 0.2, 0.2,
  // n = 9
  4.6, 0, -0, 0, 7.8, -24.8, -0.1, -0.3, 3, 12.2, 0.1, 0.3, -0.2, 8.3, 0.3, -0.3, -2.5, -3.3, -0.3, 0.3,
  -13.1, -5.2, 0, 0.2, 2.4, 7.2, 0.3, -0.1, 8.6, -0.6, -0.1, -0.2, -8.7, 0.8, 0.1, 0.4, -12.9, 10, -0.1, 0.1,
  // n = 10
  -1.3, 0, 0.1, 0, -6.4, 3.3, 0, 0, 0.2, 0, 0.1, -0, 2, 2.4, 0.1, -0.2, -1, 5.3, -0, 0.1,
  -0.6, -9.1, -0.3, -0.1, -0.9, 0.4, 0, 0.1, 1.5, -4.2, -0.1, 0, 0.9, -3.8, -0.1, -0.1, -2.7, 0.9, -0, 0.2,
  -3.9, -9.1, -0, -0,
  // n = 11
  2.9, 0, 0, 0, -1.5, 0, -0, -0, -2.5, 2.9, 0, 0.1, 2.4, -0.6, 0, -0, -0.6, 0.2, 0, 0.1,
  -0.1, 0.5, -0.1, -0, -0.6, -0.3, 0, -0, -0.1, -1.2, -0, 0.1, 1.1, -1.7, -0.1, -0, -1, -2.9, -0.1, 0,
  -0.2, -1.8, -0.1, 0, 2.6, -2.3, -0.1, 0,
  // n = 12
  -2, 0, 0, 0, -0.2, -1.3, 0, -0, 0.3, 0.7, -0, 0, 1.2, 1, -0, -0.1, -1.3, -1.4, -0, 0.1,
  0.6, -0, -0, -0, 0.6, 0.6, 0.1, -0, 0.5, -0.1, -0, -0, -0.1, 0.8, 0, 0, -0.4, 0.1, 0, -0,
  -0.2, -1, -0.1, -0, -1.3, 0.1, -0, 0, -0.7, 0.2, -0.1, -0.1,
]

// The series' fixed parts: where each (n, m) sits in MODEL, the Schmidt
// factors that turn the Gauss-normalised Legendre functions the recursion
// builds into the model's, and the recursion's constants.
const SIDE = ORDER + 1
const INDEX = new Int32Array(SIDE * SIDE)
const SCHMIDT = new Float64Array(SIDE * SIDE)
const RECURSION = new Float64Array(SIDE * SIDE)
{
  let k = 0
  for (let n = 1; n <= ORDER; n++) for (let m = 0; m <= n; m++) INDEX[n * SIDE + m] = 4 * k++
  SCHMIDT[0] = 1
  for (let n = 1; n <= ORDER; n++) {
    SCHMIDT[n * SIDE] = (SCHMIDT[(n - 1) * SIDE] * (2 * n - 1)) / n
    for (let m = 1; m <= n; m++) SCHMIDT[n * SIDE + m] = SCHMIDT[n * SIDE + m - 1] * Math.sqrt(((n - m + 1) * (m === 1 ? 2 : 1)) / (n + m))
    for (let m = 0; m <= n; m++) RECURSION[n * SIDE + m] = n > 1 ? ((n - 1) * (n - 1) - m * m) / ((2 * n - 1) * (2 * n - 3)) : 0
  }
}
const legendre = new Float64Array(SIDE * SIDE)
const slope = new Float64Array(SIDE * SIDE)

// Field: the field's components along the ellipsoid's local north, east and
// down at a place, nT.
export interface Field {
  north: number
  east: number
  down: number
}

// year is a date as the model counts time: years and their fraction, UTC.
export function year(date: Date): number {
  const whole = date.getUTCFullYear()
  const start = Date.UTC(whole, 0, 1), next = Date.UTC(whole + 1, 0, 1)
  return whole + (date.getTime() - start) / (next - start)
}

// field is the field at a place and time (a year as year() counts it).
export function field(place: Place, time: number): Field {
  const t = Math.min(END, Math.max(EPOCH, time)) - EPOCH
  // The place in geocentric spherical coordinates: its radius, its geocentric
  // latitude, and the colatitude the series is written in.
  const sinφ = Math.sin(place.latitude), cosφ = Math.cos(place.latitude)
  const normal = EQUATOR / Math.sqrt(1 - ECCENTRIC * sinφ * sinφ)
  const across = (normal + place.altitude) * cosφ, up = (normal * (1 - ECCENTRIC) + place.altitude) * sinφ
  const radius = Math.hypot(across, up)
  const centric = Math.asin(up / radius)
  const cos = Math.sin(centric), sin = Math.max(Math.cos(centric), 1e-12) // of the colatitude; held off zero at the poles, where the east component's 1/sin meets an m-fold zero
  legendre[0] = 1
  slope[0] = 0
  for (let n = 1; n <= ORDER; n++)
    for (let m = 0; m <= n; m++) {
      const at = n * SIDE + m
      if (n === m) {
        const before = (n - 1) * SIDE + m - 1
        legendre[at] = sin * legendre[before]
        slope[at] = sin * slope[before] + cos * legendre[before]
      } else if (n === 1 || m === n - 1) {
        const before = (n - 1) * SIDE + m
        legendre[at] = cos * legendre[before]
        slope[at] = cos * slope[before] - sin * legendre[before]
      } else {
        const before = (n - 1) * SIDE + m, earlier = (n - 2) * SIDE + m, k = RECURSION[at]
        legendre[at] = cos * legendre[before] - k * legendre[earlier]
        slope[at] = cos * slope[before] - sin * legendre[before] - k * slope[earlier]
      }
    }
  let outward = 0, northward = 0, east = 0 // geocentric: up along the radius, north across it, and east
  for (let n = 1; n <= ORDER; n++) {
    const reach = (RADIUS / radius) ** (n + 2)
    for (let m = 0; m <= n; m++) {
      const at = n * SIDE + m, i = INDEX[at], s = SCHMIDT[at]
      const g = (MODEL[i] + t * MODEL[i + 2]) * s, h = (MODEL[i + 1] + t * MODEL[i + 3]) * s
      const c = Math.cos(m * place.longitude), w = Math.sin(m * place.longitude)
      outward += (n + 1) * reach * (g * c + h * w) * legendre[at]
      northward += reach * (g * c + h * w) * slope[at]
      east += (reach * m * (g * w - h * c) * legendre[at]) / sin
    }
  }
  // Turn the geocentric north and down onto the ellipsoid's by the angle
  // between the two latitudes.
  const tilt = centric - place.latitude
  const north = northward * Math.cos(tilt) + outward * Math.sin(tilt)
  const down = northward * Math.sin(tilt) - outward * Math.cos(tilt)
  return { north, east, down }
}

// variation is the declination: how far east of true north the field points,
// radians, west negative.
export function variation(place: Place, time: number): number {
  const f = field(place, time)
  return Math.atan2(f.east, f.north)
}

// dip is the inclination: how far below the horizontal the field points,
// radians, upward negative.
export function dip(f: Field): number {
  return Math.atan2(f.down, Math.hypot(f.north, f.east))
}

// ---- the standby compass (NATOPS 2.12.9) ----

// A conventional aircraft compass: a magnet on a float in fluid, pivoted so it
// is free to tilt about 18° (the FAA's Pilot's Handbook of Aeronautical
// Knowledge). It hangs along the apparent gravity, so the card lies across
// the jet's load as it banks, pulls and accelerates, and it lines up with the
// part of the field that lies across it: wherever the field dips, a bank or a
// change of speed tilts the card into the dip and turns it - the turning and
// acceleration errors. The fluid damps its swing and drags it a little with the
// case as the jet turns. PERIOD and DAMPING are ours: NATOPS gives the compass
// no figures. The card swings at PERIOD in a field STRENGTH across it, about
// Midway's horizontal field; a weaker field, nearer the magnetic poles, swings it
// more slowly.
export const TILT = (18 * Math.PI) / 180
const PERIOD = 2.5 // s
const DAMPING = 0.5
const STRENGTH = 27000 // nT
const STEP = 1 / 60 // the longest step the card is swung over, s
const TURN = 2 * Math.PI

const dot = (a: Vec, b: Vec) => a.x * b.x + a.y * b.y + a.z * b.z
const along = (a: Vec, b: Vec, s: number): Vec => ({ x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s })
const unit = (a: Vec): Vec => {
  const l = Math.sqrt(dot(a, a))
  return l > 0 ? { x: a.x / l, y: a.y / l, z: a.z / l } : a
}
const across = (a: Vec, n: Vec): Vec => along(a, n, -dot(a, n)) // a with its part along n taken out
const cross = (a: Vec, b: Vec): Vec => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x })

// rest is where the card would come to rest, given the field at the jet and
// the jet's axes and apparent gravity (the specific force, m/s², which reads
// up in level flight) in a level frame there - x east, y up, z south: the
// heading it would read, radians from 0 to 2π, and the strength of the field
// across it, nT.
export function rest(f: Field, nose: Vec, up: Vec, force: Vec): { heading: number; strength: number } {
  let card = unit(force)
  const lean = dot(card, up)
  if (lean < Math.cos(TILT)) {
    const side = unit(across(card, up)) // which way the float leans, against its stop
    card = dot(side, side) > 0 ? unit(along({ x: up.x * Math.cos(TILT), y: up.y * Math.cos(TILT), z: up.z * Math.cos(TILT) }, side, Math.sin(TILT))) : up
  }
  const magnet = across({ x: f.east, y: -f.down, z: -f.north }, card)
  const lubber = across(nose, card)
  const heading = Math.atan2(dot(lubber, cross(magnet, card)), dot(lubber, magnet))
  return { heading: (heading + TURN) % TURN, strength: Math.sqrt(dot(magnet, magnet)) }
}

// Card: the card as it swings - where its north points, radians clockwise
// from the jet's true north reference, and how fast it turns, rad/s.
export interface Card {
  azimuth: number
  rate: number
}

// settled is a card at rest on a reading, with the jet on a heading.
export function settled(heading: number, reading: number): Card {
  return { azimuth: heading - reading, rate: 0 }
}

// swing steps the card dt seconds and gives its reading: the magnet pulls its
// north toward the field's, the fluid toward the case's turn. heading is the
// jet's true heading, yaw its rate of turn, rad/s, and target and strength
// what rest() gives.
export function swing(card: Card, heading: number, yaw: number, target: number, strength: number, dt: number): number {
  const natural = TURN / PERIOD
  const pull = (natural * natural * strength) / STRENGTH
  const steps = Math.min(600, Math.max(1, Math.ceil(dt / STEP)))
  const h = dt / steps
  const north = heading - target // where the field points across the card
  for (let k = 0; k < steps; k++) {
    card.rate += (pull * Math.sin(north - card.azimuth) + 2 * DAMPING * natural * (yaw - card.rate)) * h
    card.azimuth += card.rate * h
  }
  card.azimuth = Math.atan2(Math.sin(card.azimuth), Math.cos(card.azimuth))
  return (((heading - card.azimuth) % TURN) + TURN) % TURN
}
