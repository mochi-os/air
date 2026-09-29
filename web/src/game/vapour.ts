// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// When the air around a jet shows: the condensation in its vortex cores and
// in the fast, cold flow near Mach 1. Lifted out of the engine so the rules
// are typed and tested; the engine draws what these say, for every jet.
//
// Water condenses where the air cools to its dew point. The cores of the LEX
// and wingtip vortices, and the pockets of supersonic flow over the canopy,
// body and wing near Mach 1, are all low-pressure and cold, so they show
// first - in air already near saturation. The sky decides how near: the
// trade-wind air over Midway is moist under its cloud, saturated within it
// and dry above it, so vapour is a low-level and a near-the-deck sight, and a
// rare one in the clear sky at a joust's 15,000 ft.

// The cloud layers a preset lays (base and top, m); none lays a haze-topped
// boundary layer that never quite saturates.
const LAYERS: Record<string, { base: number; top: number; saturated: number }> =
  {
    none: { base: 1800, top: 1800, saturated: 0.85 },
    cumulus: { base: 600, top: 2400, saturated: 0.98 },
    high_stratus: { base: 1829, top: 2439, saturated: 1 },
    mid_stratus: { base: 305, top: 915, saturated: 1 },
    low_stratus: { base: 91, top: 701, saturated: 1 },
  }

const SURFACE = 0.75 // relative humidity at the sea, trade-wind maritime air
const ALOFT = 0.35 // above the inversion the air is dry
const DRYING = 1500 // m above the layer's top over which it dries out

// humidity is the relative humidity, 0..1, at altitude under the preset.
export function humidity(clouds: string, altitude: number): number {
  const layer = LAYERS[clouds] ?? LAYERS.none
  const h = Math.max(0, altitude)
  if (h <= layer.base)
    return SURFACE + (layer.saturated - SURFACE) * (h / layer.base)
  if (h <= layer.top) return layer.saturated
  return (
    ALOFT +
    (layer.saturated - ALOFT) * Math.max(0, 1 - (h - layer.top) / DRYING)
  )
}

// What a jet is doing, as its vapour depends on it.
export interface Flight {
  alpha: number // angle of attack, degrees
  g: number // load factor
  speed: number // true airspeed, m/s
  mach: number
}

// How strongly each kind of vapour shows, 0..1, and where the transonic
// cloud's rear edge stands (0 at its forward limit, 1 at its aft).
export interface Vapour {
  lex: number // the LEX vortices: sheets over the strakes at high alpha
  tips: number // the wingtip vortices: streamers at high lift
  flaps: number // the flap edges: wisps at high lift slow, as on approach
  collar: number // the transonic collar around the body, and the canopy's bubble
  wing: number // the transonic sheet over the wing, earlier under g
  film: number // the film over the wing's upper surface in a hard pull
  edge: number
}

const WEIGHT = 16000 * 9.81 // N, a Hornet at mid fuel
const AREA = 37.16 // m², the wing's reference area (400 ft²)

// smooth is the smoothstep of x between low and high.
function smooth(low: number, high: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - low) / (high - low)))
  return t * t * (3 - 2 * t)
}

// density is the standard atmosphere's, kg/m³, at altitude.
function density(altitude: number): number {
  const h = Math.max(0, altitude)
  if (h <= 11000) return 1.225 * Math.pow(1 - (0.0065 * h) / 288.15, 4.2559)
  return 0.3639 * Math.exp(-(h - 11000) / 6341.6)
}

// shows is how strongly a flow feature this strong (0..1) condenses in air
// this humid: its own cooling lifts the humidity it meets by up to 60%, and
// the vapour appears where that crosses 85%, full at 110%.
export function shows(strength: number, humid: number): number {
  if (strength <= 0) return 0
  return smooth(0.85, 1.1, humid * (1 + 0.6 * strength)) * strength
}

// vapour is what a jet shows, in air of the given humidity at its altitude.
export function vapour(f: Flight, humid: number, altitude: number): Vapour {
  const flowing = smooth(40, 70, f.speed) // parked or taxiing, nothing condenses
  const q = 0.5 * density(altitude) * f.speed * f.speed
  const lift = q > 1 ? (Math.abs(f.g) * WEIGHT) / (q * AREA) : 0 // the lift coefficient the load factor takes
  const lex = smooth(10, 24, f.alpha) * flowing
  const tips = smooth(0.6, 1.4, lift) * flowing
  const flaps =
    smooth(0.9, 1.6, lift) * (1 - smooth(90, 120, f.speed)) * flowing
  // The suction over the wing is the wing loading the pull asks of it, so
  // the air over the upper surface cools with the load factor, whatever the
  // height or speed: a hard pull in wet air lays a film over each wing.
  const film = 0.7 * smooth(3.5, 7.5, Math.abs(f.g)) * flowing
  // Under g the flow over the top of the wing goes supersonic sooner.
  const effective = f.mach + 0.04 * Math.max(0, Math.abs(f.g) - 1.5)
  const collar =
    smooth(0.9, 0.97, effective) * (1 - smooth(1.05, 1.2, effective))
  const wing =
    smooth(0.83, 0.92, effective) *
    (1 - smooth(1.0, 1.1, effective)) *
    (0.4 + 0.6 * smooth(1.5, 4, Math.abs(f.g)))
  return {
    lex: shows(lex, humid),
    tips: shows(tips, humid),
    flaps: shows(flaps, humid),
    collar: shows(collar, humid),
    wing: shows(wing, humid),
    film: shows(film, humid),
    edge: smooth(0.9, 1.05, f.mach),
  }
}
