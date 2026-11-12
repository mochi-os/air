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
  vehicles?: Vehicle[]
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
// cells and their pitch, and its datum, cut and wave-off lights; housed when
// the model carries its housing, so the engine draws only the lights
export interface Lens {
  position: Point
  facing: Point
  cells: number
  pitch: number
  lights: { datum: Point[]; cut: Point[]; waveoff: Point[] }
  housed?: boolean
}

// A group of the ship's lights: where each stands, its colour's name and
// which of the engine's groups lights it (recovery, outline, navigation,
// flood, beacon, status: see lit). A beacon's or status light's colour is the
// red its lamps at positions show, and green where its green lamps stand,
// beside them, or with them when not given
export interface Lights {
  positions: Point[]
  colour: string
  kind: string
  green?: Point[]
}

// A vehicle parked on the deck as the flight core collides with it: its
// kind, its footprint in the ship's plan and the height of its top over the
// waterline
export interface Vehicle {
  kind: string
  outline: Plan[]
  top: number
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
  vehicles: Vehicle[]
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

// meatball is what the lens shows an eye at a point in the ship's frame, as
// the game draws it for the pilot's (engine.ts update_ols): its datum lights
// lit to an eye astern of the touchdown, within 7 km and 40° either side of
// the approach; and on an approach (40 m to 5 km out, above the deck) the
// ball's height on the cell column, from the hook's deviation off the 3.5°
// glideslope to the touchdown (the hook 4 m under the eye and 9 m aft): 0.8°
// takes it to the column's end, and it turns red 0.7° low. The touchdown is
// halfway between the wire before the target and the target, on the landing
// line. Its cut lights stay dark: the LSO lights them only for signals given
// without the radio (LSO NATOPS 4.2.4 and 6.4: under EMCON or to a jet without
// one, his control at the ball call and power; the bingo with the wave-off
// lights), and the game's LSO talks
export function meatball(
  ship: Layout,
  eye: Point
): { lit: boolean; ball: { height: number; low: boolean } | null } {
  const lens = ship.lens
  if (!lens) return { lit: false, ball: null }
  const [aft, forward] = ship.landing.line
  const { wires, target } = ship.landing
  const x = target > 1 ? (wires[target - 2] + wires[target - 1]) / 2 : wires[0]
  const z =
    aft[1] + ((forward[1] - aft[1]) * (x - aft[0])) / (forward[0] - aft[0])
  const length = Math.hypot(aft[0] - forward[0], aft[1] - forward[1])
  const [ax, az] = [
    (aft[0] - forward[0]) / length,
    (aft[1] - forward[1]) / length,
  ]
  const [rx, rz] = [eye[0] - x, eye[2] - z]
  const along = rx * ax + rz * az
  const distance = Math.hypot(rx, rz)
  const lit =
    along > 10 &&
    distance < 7000 &&
    Math.abs(-rx * az + rz * ax) < along * Math.tan((40 * Math.PI) / 180)
  if (distance <= 40 || distance >= 5000 || along <= 40 || eye[1] <= ship.deck)
    return { lit, ball: null }
  const deviation =
    (Math.atan2(eye[1] - ship.deck - 4, Math.max(along + 9, 1)) * 180) /
      Math.PI -
    3.5
  const travel = (lens.cells * lens.pitch) / 2
  return {
    lit,
    ball: {
      height:
        lens.position[1] + Math.max(-1, Math.min(1, deviation / 0.8)) * travel,
      low: deviation < -0.7,
    },
  }
}

// The deck as the ship's lights show it: dark from dusk to dawn (the game's
// night); closed while she turns, or steams away from the wind, and takes no
// one; and aboard, where the player's jet stands on her deck in her frame
// (x, z), or null
export interface Deck {
  dark: boolean
  closed: boolean
  aboard: Plan | null
}

// LANDING is the landing area's half-width: its outer edge stripes' outer
// edges, 40 ft either side of the centreline (NAVAIR 51-50AAA-2 WP 006 04,
// which the Ford's measured stripes match within 3 cm)
const LANDING = 12.192

// foul is whether the deck is foul (CV NATOPS 00-80T-105, 2004, 5.5): closed,
// or the player's jet in the landing area, within its half-width of the
// landing line and between the line's ends
export function foul(ship: Layout, deck: Deck): boolean {
  if (deck.closed) return true
  if (!deck.aboard) return false
  const [[ax, az], [bx, bz]] = ship.landing.line
  const length = Math.hypot(bx - ax, bz - az)
  const [ux, uz] = [(bx - ax) / length, (bz - az) / length]
  const [rx, rz] = [deck.aboard[0] - ax, deck.aboard[1] - az]
  const along = rx * ux + rz * uz
  return along >= 0 && along <= length && Math.abs(rz * ux - rx * uz) <= LANDING
}

// lit is the colour a group of the ship's lights shows for the deck, or null
// while it is out (CV NATOPS 00-80T-105, 2004, and LSO NATOPS 00-80T-104):
// - recovery, the landing area's lights, the drop line and the elevators'
//   edges: at night while the deck is open, out while it is closed (the
//   closed-deck signal, Figure 5-9), lit while it is only foul (5.5)
// - outline, the blue deck-edge lights, and navigation: all night
// - flood, the island's floods: at night while the player's jet is aboard,
//   work lights doused for the flight operations around it
// - beacon, the island's rotating beacons, and status, the deck status
//   lights: day and night, green for a clear deck and red for a foul one.
//   PriFly turns the beacons green to clear a launch (4.2) and the deck is
//   foul while they are red (5.5); the arresting gear officer sets the status
//   lights (LSO NATOPS 6.4.1)
export function lit(lights: Lights, ship: Layout, deck: Deck): string | null {
  switch (lights.kind) {
    case 'recovery':
      return deck.dark && !deck.closed ? lights.colour : null
    case 'outline':
    case 'navigation':
      return deck.dark ? lights.colour : null
    case 'flood':
      return deck.dark && deck.aboard ? lights.colour : null
    case 'beacon':
    case 'status':
      return foul(ship, deck) ? lights.colour : 'green'
  }
  return null
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
      ? { x: c.lens.position[0], z: c.lens.position[2], model: !!c.lens.housed }
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
    vehicles: c.vehicles ?? [],
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
