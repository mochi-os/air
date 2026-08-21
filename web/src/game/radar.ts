// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// A/A radar (#30): the APG-73 at game fidelity - a swept beam over truth
// positions with probabilistic paints, but real emission STATES: SIL, RWS
// (anonymous bricks), TWS (trackfiles), STT (one continuous track, the loudest
// thing a victim's RWR hears). Angles radians, ranges metres, azimuths relative
// to own heading.

export const NM = 1852

export type RadarTarget = { id: number | string; x: number; y: number; z: number; vx: number; vy: number; vz: number; jamming?: boolean }
export type RadarOwn = { x: number; y: number; z: number; heading: number }
export type Brick = { id: number | string; azimuth: number; range: number; at: number }
export type Track = { id: number | string; x: number; y: number; z: number; vx: number; vy: number; vz: number; at: number; hits: number }
export type Wrap = (value: number) => number

const SWEEP = 1.31 // antenna sweep rate, rad/s (~75°/s)
// The EW pieces (#31): a jammer outside burnthrough or a target inside the
// clutter notch starves the tracker, so the STT goes to MEMORY and breaks if
// the condition outlasts the window.
const BURNTHROUGH = 9000 // m — inside this the skin echo beats the jammer
const NOTCH = 60 // m/s — radial speed under this sits in the clutter gate
const MEMORY = 4 // s — how long a track survives on memory before the lock drops
const ELEVATION = 0.175 // search coverage half-height, rad (~10°) — one generous band in place of bar bookkeeping
const BASE = 40 * NM // beam-aspect detection range against the game's one fighter
const BRICK_AGE = 12 // seconds an RWS paint stays on the format
const TRACK_AGE = 8 // seconds a TWS trackfile survives without a fresh paint
const GIMBAL = 1.222 // STT gimbal limit off the nose, rad (±70°)
const HOLD = 1.15 // STT holds a lock out to this multiple of detection range

export const WIDTHS = [1.222, 0.785, 0.349] // selectable azimuth half-widths: ±70°, ±45°, ±20°
export const SCALES = [5, 10, 20, 40] // display range scales, nmi

// geometry resolves a target into the radar's frame: azimuth relative to own
// heading (the engine's bearing convention: atan2(dx, -dz)), elevation off
// the horizontal, slant range. wrap is the toroidal minimum-image function.
export function geometry(own: RadarOwn, target: { x: number; y: number; z: number }, wrap: Wrap) {
  const dx = wrap(target.x - own.x)
  const dz = wrap(target.z - own.z)
  const dy = target.y - own.y
  const horizontal = Math.hypot(dx, dz)
  let azimuth = Math.atan2(dx, -dz) - own.heading
  while (azimuth > Math.PI) azimuth -= 2 * Math.PI
  while (azimuth < -Math.PI) azimuth += 2 * Math.PI
  return { azimuth, elevation: Math.atan2(dy, horizontal || 1), range: Math.hypot(dx, dy, dz) }
}

// aspect_factor scales detection by the target's aspect: a beam-on fighter is
// the biggest reflector (1.0), nose/tail the smallest (0.75). A near-stationary
// target has no meaningful aspect — middle value.
export function aspect_factor(own: RadarOwn, target: RadarTarget, wrap: Wrap): number {
  const speed = Math.hypot(target.vx, target.vy, target.vz)
  if (speed < 20) return 0.85
  const dx = wrap(target.x - own.x)
  const dy = target.y - own.y
  const dz = wrap(target.z - own.z)
  const d = Math.hypot(dx, dy, dz) || 1
  const along = Math.abs((target.vx * dx + target.vy * dy + target.vz * dz) / (speed * d))
  return 1 - 0.25 * along
}

// detect_range: how far this target paints, this look.
export function detect_range(own: RadarOwn, target: RadarTarget, wrap: Wrap): number {
  const look = target.y < own.y ? 0.65 : 1 // look-down: sea clutter behind everything below own level
  return BASE * aspect_factor(own, target, wrap) * look
}

// paint_probability: certain close in, fading toward the detection edge.
export function paint_probability(range: number, detection: number): number {
  if (range >= detection) return 0
  if (range < 0.55 * detection) return 0.97
  return 0.97 - (0.97 - 0.15) * ((range - 0.55 * detection) / (0.45 * detection))
}

// pick resolves a cursor position onto the nearest candidate within the snap
// radius, in display-normalised space (azimuth over the shown half-width,
// range over the shown scale) — the fat-finger capture logic.
export function pick(
  candidates: { id: number | string; azimuth: number; range: number }[],
  azimuth: number,
  range: number,
  half: number,
  scale: number
): number | string | null {
  let best: number | string | null = null
  let closest = 0.14 // snap radius in normalised display space
  for (const c of candidates) {
    const n = Math.hypot((c.azimuth - azimuth) / (2 * half), (c.range - range) / scale)
    if (n < closest) {
      closest = n
      best = c.id
    }
  }
  return best
}

export class Radar {
  mode: 'rws' | 'tws' = 'rws'
  sil = false
  width = 0 // index into WIDTHS
  scale = 40 // display range, nmi
  sweep = 0 // antenna azimuth, rad relative to heading
  elevation = 0 // scan band centre off the horizontal, rad — the pilot slews it to sanitise high or low (±60° gimbal)
  direction = 1
  bricks: Brick[] = []
  tracks: Track[] = []
  ls: number | string | null = null // launch & steering trackfile (TWS)
  stt: number | string | null = null // the hard lock
  acm: 'bst' | 'vacq' = 'bst' // armed ACM condition, used by the acquire flow
  auto = false // the ACM condition is commanded: the radar runs the cone itself and locks the first target in it, until deselected
  memory = 0 // seconds the STT has coasted without real data (0 = tracking); MEM shows past zero
  strobes: number[] = [] // azimuths of jamming emitters this step (#31): bearing-only spokes, range unknown
  time = 0

  // half: the effective azimuth half-width — TWS trades volume for trackfiles
  // and never scans the full ±70°.
  half(): number {
    const w = WIDTHS[this.width]
    return this.mode === 'tws' ? Math.min(w, WIDTHS[1]) : w
  }

  // emitter: the wire truth of what this radar is doing — 0 silent, 1 search,
  // 2 STT. What the other side's RWR reacts to (#28).
  emitter(): 0 | 1 | 2 {
    return this.sil ? 0 : this.stt != null ? 2 : 1
  }

  step(dt: number, own: RadarOwn, targets: RadarTarget[], wrap: Wrap, random: () => number = Math.random): void {
    this.time += dt
    this.bricks = this.bricks.filter((b) => this.time - b.at < BRICK_AGE)
    this.tracks = this.tracks.filter((t) => this.time - t.at < TRACK_AGE || t.id === this.stt)
    if (this.ls != null && this.stt == null && !this.tracks.some((t) => t.id === this.ls)) this.ls = null
    if (this.sil) {
      this.stt = null // a silent radar tracks nothing — the picture freezes and ages
      return
    }
    // Jamming strobes (#31): a radiating emitter shows as a bearing-only
    // spoke whatever the radar is doing — the jam arrives whether or not
    // the sweep is pointed at it.
    this.strobes = []
    for (const t of targets) {
      if (!t.jamming) continue
      const g = geometry(own, t, wrap)
      this.strobes.push(g.azimuth)
    }
    if (this.stt != null) {
      const target = targets.find((t) => t.id === this.stt)
      const g = target ? geometry(own, target, wrap) : null
      if (!target || !g || Math.abs(g.azimuth) > GIMBAL || g.range > HOLD * detect_range(own, target, wrap)) {
        this.stt = null // broken lock: back to search; the last trackfile remembers
        this.memory = 0
        return
      }
      // MEMORY (#31): a starved tracker coasts on the track's last state (no
      // fix), the display says MEM, and the lock drops if the condition
      // outlasts the window.
      const speed = Math.hypot(target.vx, target.vy, target.vz)
      const radial = speed < 1 ? 0 : Math.abs((target.vx * wrap(target.x - own.x) + target.vy * (target.y - own.y) + target.vz * wrap(target.z - own.z)) / Math.max(g.range, 1))
      const starved = (target.jamming && g.range > BURNTHROUGH) || radial < NOTCH
      if (starved) {
        this.memory += dt
        if (this.memory > MEMORY) {
          this.stt = null
          this.memory = 0
        }
        return
      }
      this.memory = 0
      this.fix(target) // the antenna stays on the target: a continuous track, and nothing else painted
      return
    }
    this.memory = 0
    const half = this.half()
    let az = this.sweep + this.direction * SWEEP * dt
    if (az > half) { az = half; this.direction = -1 }
    if (az < -half) { az = -half; this.direction = 1 }
    for (const target of targets) {
      const g = geometry(own, target, wrap)
      if (Math.abs(g.elevation - this.elevation) > ELEVATION) continue
      if (Math.abs(g.azimuth) > half) continue
      // Half-open interval (previous, current]: consecutive frames partition
      // the sweep exactly, so one crossing is one detection roll and never a
      // cluster of duplicates.
      if ((g.azimuth - this.sweep) * (g.azimuth - az) > 0 || g.azimuth === this.sweep) continue
      const detection = detect_range(own, target, wrap)
      if (g.range >= detection) continue
      if (random() > paint_probability(g.range, detection)) continue
      if (this.mode === 'rws') this.paint({ id: target.id, azimuth: g.azimuth, range: g.range, at: this.time })
      else this.fix(target)
    }
    this.sweep = az
  }

  // paint records an RWS brick, keeping at most TWO per target — the current
  // paint plus one dimming predecessor, the real format's low HITS history:
  // a mover shows motion, never a formation. Aging still clears both, so the
  // lone stale brick of a departed target (the honest RWS lesson) survives.
  private paint(brick: Brick): void {
    const mine = this.bricks.filter((b) => b.id === brick.id)
    if (mine.length >= 2) {
      const oldest = mine.reduce((a, b) => (a.at <= b.at ? a : b))
      this.bricks.splice(this.bricks.indexOf(oldest), 1)
    }
    this.bricks.push(brick)
  }

  private fix(target: RadarTarget): void {
    const existing = this.tracks.find((t) => t.id === target.id)
    if (existing) {
      existing.x = target.x; existing.y = target.y; existing.z = target.z
      existing.vx = target.vx; existing.vy = target.vy; existing.vz = target.vz
      existing.at = this.time
      existing.hits++
    } else this.tracks.push({ id: target.id, x: target.x, y: target.y, z: target.z, vx: target.vx, vy: target.vy, vz: target.vz, at: this.time, hits: 1 })
  }

  // designate climbs the ladder onto a track: in TWS the first designation
  // makes it the L&S, designating the L&S again commands STT; RWS (no
  // trackfiles) goes straight to STT. A silent radar cannot lock.
  designate(id: number | string): boolean {
    if (this.sil) return false
    if (this.mode === 'tws' && this.stt == null && this.ls !== id) {
      this.ls = id
      return true
    }
    this.ls = id
    this.stt = id
    return true
  }

  // lock is the ACM acquisition: straight to STT whatever the search mode —
  // the cone found him, so there is no trackfile ladder to climb. A silent
  // radar cannot lock.
  lock(id: number | string): boolean {
    if (this.sil) return false
    this.ls = id
    this.stt = id
    return true
  }

  // undesignate steps down: STT back to search (L&S kept), then the L&S, gone.
  undesignate(): void {
    if (this.stt != null) this.stt = null
    else this.ls = null
  }

  // slew moves the elevation band centre by steps of 5°, held inside the
  // ±60° antenna gimbal.
  slew(direction: number): void {
    this.elevation = Math.max(-1.047, Math.min(1.047, this.elevation + Math.sign(direction) * (5 * Math.PI / 180)))
  }
}
