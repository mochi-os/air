// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// A ship file in the plan's contract (tools/ford/build.py writes ford.json)
// read into the deck layout engine.ts and the flight core take: the deck,
// its catapults, the landing line and its wires, the lens, the elevators, the
// deck texture's extent and the waterline the bow wave and wake draw from.
// The contract's frame is the engine's deck frame: x forward, y up from the
// waterline, z to starboard, metres; headings in degrees, positive to port.
// Free of the engine and the page, so the reading is testable.
import { schedule } from './joints'

type Plan = [number, number]
type Point = [number, number, number]

export interface Contract {
  deck: { height: number; outline: Plan[] }
  catapults: {
    x: number
    z: number
    heading: number
    stroke: number
    speed: number // the end speed a shot is capped at, m/s
    deflector?: {
      x: number
      z: number
      width: number
      depth: number
      heading: number
    }
  }[]
  landing: {
    line: [Plan, Plan]
    wires: { number: number; x: number; ends: [Point, Point] }[]
    target: number
  }
  lens?: Lens
  lights?: Record<string, Lights>
  parking?: { x: number; z: number; heading: number }
  joints?: Record<string, Joint>
  elevators: { number: number; side: string; outline: Plan[] }[]
  texture: { x: [number, number]; z: [number, number] }
  hull?: {
    draught: number
    entrance: number
    waterline: { stern: number; stem: number; half: Plan[] }
    screws?: { lateral: number[]; diameter: number }
  }
}

// The lens: its cell column's centre at datum height, the way it faces, its
// cells and their pitch, and its datum, cut and wave-off lights
export interface Lens {
  position: Point
  facing: Point
  cells: number
  pitch: number
  lights: { datum: Point[]; cut: Point[]; waveoff: Point[] }
}

// A group of the ship's lights: where each stands, its colour's name and
// which of the engine's groups lights it (recovery, outline, navigation,
// flood)
export interface Lights {
  positions: Point[]
  colour: string
  kind: string
}

// A rigged part of the model (the plan's contract): it slides along its axis or
// turns about it, by what its drive sets through its keys, [input, output]
// pairs read piecewise linearly; at rest it stands as the model is built. One
// that follows another joint takes that joint's value as its input (a blast
// deflector's struts follow its panel)
export interface Joint {
  motion: string
  axis: Point
  drive: string
  keys: [number, number][]
  follows?: string
}

export interface Layout {
  deck: number // the deck's height over the waterline
  outline: Plan[]
  catapults: {
    x: number
    z: number
    heading: number
    stroke: number
    speed: number
    deflector?: {
      x: number
      z: number
      width: number
      depth: number
      heading: number
    }
  }[]
  // wires: where each pendant crosses the landing line, in x; ends: where it
  // leaves its sheaves; span: the mean distance between them
  landing: {
    line: [Plan, Plan]
    wires: number[]
    ends: [Point, Point][]
    span: number
    target: number
  }
  ols: { x: number; z: number; model: boolean }
  lens?: Lens
  lights: Record<string, Lights>
  parking?: { x: number; z: number; heading: number }
  joints: Record<string, Joint>
  // followers: each joint some others follow, and those joints, by name
  followers: Record<string, string[]>
  elevators: { aft: number; forward: number; side: number }[]
  texture: { x: [number, number]; z: [number, number] }
  waterline?: { stern: number; stem: number; sides: number[][] }
  draught?: number
  entrance?: number
  screws?: { lateral: number[]; diameter: number }
}

// followers groups the joints that follow another by the joint they follow,
// each group in name order
export function followers(joints: Record<string, Joint>): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const name of Object.keys(joints).sort()) {
    const leader = joints[name].follows
    if (leader) (out[leader] ??= []).push(name)
  }
  return out
}

// A blast deflector's joint: its keys are seconds into its raise against its
// angle, and a lowering runs back along them
const DEFLECTOR = /^catapult_\d+_deflector$/

// deflectors gives every blast deflector's joint value a number of seconds
// into its raise, through its keys, and each of its followers' through their
// own keys on that value: the pose the engine moves a deflector through
export function deflectors(ship: Layout, seconds: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const name of Object.keys(ship.joints).sort()) {
    if (!DEFLECTOR.test(name)) continue
    const angle = schedule(ship.joints[name].keys, seconds)
    out[name] = angle
    for (const follower of ship.followers[name] ?? []) out[follower] = schedule(ship.joints[follower].keys, angle)
  }
  return out
}

// raising is how many seconds the slowest blast deflector takes to rise: its
// keys' last input (0 on a ship without any)
export function raising(ship: Layout): number {
  let most = 0
  for (const [name, joint] of Object.entries(ship.joints))
    if (DEFLECTOR.test(name) && joint.keys.length) most = Math.max(most, joint.keys[joint.keys.length - 1][0])
  return most
}

// STATIONS is how many stations the waterline is given at, stern to stem: the
// wake's limit (wake.ts HULL)
export const STATIONS = 42

// crossing is where the segment a-b crosses the line through p and q, in x
function crossing(a: Plan, b: Plan, p: Plan, q: Plan): number {
  const dx = q[0] - p[0]
  const dz = q[1] - p[1]
  const side = (s: Plan) => (s[0] - p[0]) * dz - (s[1] - p[1]) * dx
  const t = side(a) / (side(a) - side(b))
  return a[0] + (b[0] - a[0]) * t
}

// half is the waterline's half-breadth at x, piecewise linear between its
// stations and nothing past its ends
function half(stations: Plan[], x: number): number {
  if (x <= stations[0][0] || x >= stations[stations.length - 1][0]) {
    const end =
      x <= stations[0][0] ? stations[0] : stations[stations.length - 1]
    return x === end[0] ? end[1] : 0
  }
  for (let i = 1; i < stations.length; i++) {
    const [x0, h0] = stations[i - 1]
    const [x1, h1] = stations[i]
    if (x <= x1) return h0 + ((h1 - h0) * (x - x0)) / (x1 - x0)
  }
  return 0
}

// layout reads a contract ship file
export function layout(c: Contract): Layout {
  const [p, q] = c.landing.line
  const ends = c.landing.wires.map((w) => w.ends)
  const out: Layout = {
    deck: c.deck.height,
    outline: c.deck.outline,
    catapults: c.catapults.map((cat) => ({
      x: cat.x,
      z: cat.z,
      heading: cat.heading,
      stroke: cat.stroke,
      speed: cat.speed,
      ...(cat.deflector ? { deflector: cat.deflector } : {}),
    })),
    landing: {
      line: c.landing.line,
      wires: ends.map(([a, b]) => crossing([a[0], a[2]], [b[0], b[2]], p, q)),
      ends,
      span:
        ends.reduce(
          (sum, [a, b]) => sum + Math.hypot(b[0] - a[0], b[2] - a[2]),
          0
        ) / Math.max(ends.length, 1),
      target: c.landing.target,
    },
    ols: c.lens
      ? { x: c.lens.position[0], z: c.lens.position[2], model: false }
      : { x: 0, z: 0, model: false },
    elevators: c.elevators.map((e) => {
      // the platform's outboard side, along the deck's edge: its two points
      // furthest from the centreline
      const outboard = [...e.outline]
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
        .slice(0, 2)
      return {
        aft: Math.min(outboard[0][0], outboard[1][0]),
        forward: Math.max(outboard[0][0], outboard[1][0]),
        side: e.side === 'port' ? -1 : 1,
      }
    }),
    texture: { x: c.texture.x, z: c.texture.z },
    ...(c.lens ? { lens: c.lens } : {}),
    lights: c.lights ?? {},
    ...(c.parking ? { parking: c.parking } : {}),
    joints: c.joints ?? {},
    followers: followers(c.joints ?? {}),
  }
  if (c.hull) {
    const w = c.hull.waterline
    // the stations end short of the stem, where the breadth closes to nothing
    const stations = [...w.half].sort((a, b) => a[0] - b[0])
    if (stations[stations.length - 1][0] < w.stem) stations.push([w.stem, 0])
    out.waterline = {
      stern: w.stern,
      stem: w.stem,
      sides: Array.from({ length: STATIONS }, (_, i) => {
        const h = half(
          stations,
          w.stern + ((w.stem - w.stern) * i) / (STATIONS - 1)
        )
        return [-h, h]
      }),
    }
    out.draught = c.hull.draught
    out.entrance = c.hull.entrance
    if (c.hull.screws) out.screws = c.hull.screws
  }
  return out
}

// The offset that stands each catapult control station up (its slide at its
// last key), by node name, for a view that shows them raised rather than
// stowed under the deck
export function stations(joints: Record<string, Joint>): Record<string, Point> {
  const out: Record<string, Point> = {}
  for (const [name, j] of Object.entries(joints)) {
    if (!name.startsWith('catapult_console_') || j.motion !== 'slide' || !j.keys.length) continue
    const top = j.keys[j.keys.length - 1][1]
    out[name] = [j.axis[0] * top, j.axis[1] * top, j.axis[2] * top]
  }
  return out
}
