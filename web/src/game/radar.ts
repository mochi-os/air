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

export type RadarTarget = {
  id: number | string
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  jamming?: boolean
}
export type RadarOwn = { x: number; y: number; z: number; heading: number }
export type Brick = {
  id: number | string
  azimuth: number
  range: number
  at: number
  x: number // where the paint put the target, for the SA page's plan view
  z: number
}
export type Track = {
  id: number | string
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  at: number
  hits: number
}
export type Wrap = (value: number) => number

const SWEEP = 1.31 // antenna sweep rate, rad/s (~75°/s)
const BEAM = 0.0576 // one bar's height, rad (3.3°): the APG-65/73's beam
export const TILT = 1.047 // antenna elevation gimbal, rad (±60°)
const FRAME = 2.5 // s: the longest frame TWS scans, so each trackfile is looked at least this often
// The EW pieces (#31): a jammer outside burnthrough or a target inside the
// clutter notch starves the tracker, so the STT goes to MEMORY and breaks if
// the condition outlasts the window.
const BURNTHROUGH = 9000 // m — inside this the skin echo beats the jammer
const NOTCH = 60 // m/s — radial speed under this sits in the clutter gate
const MEMORY = 4 // s — how long a track survives on memory before the lock drops
const BASE = 55 * NM // beam-aspect detection range against the game's one fighter: 44 nm nose-on, so a head-on bandit paints before the AIM-120's ~38 nm head-on reach, within the APG-65/73's published 40-50 nm against a fighter
const BRICK_AGE = 12 // seconds an RWS paint stays on the format
const TRACK_AGE = 8 // seconds a TWS trackfile survives without a fresh paint
const GIMBAL = 1.222 // STT gimbal limit off the nose, rad (±70°)
const HOLD = 1.15 // STT holds a lock out to this multiple of detection range

export const WIDTHS = [1.222, 0.785, 0.349] // selectable azimuth half-widths: ±70°, ±45°, ±20°
export const BARS = [1, 2, 4, 6] // selectable bar counts, each bar one beam high
export const SCALES = [5, 10, 20, 40, 80, 160] // display range scales, nmi: the F/A-18C's APG-65/73 air-to-air scales, the HSI's too

// geometry resolves a target into the radar's frame: azimuth relative to own
// heading (the engine's bearing convention: atan2(dx, -dz)), elevation off
// the horizontal, slant range. wrap is the toroidal minimum-image function.
export function geometry(
  own: RadarOwn,
  target: { x: number; y: number; z: number },
  wrap: Wrap
) {
  const dx = wrap(target.x - own.x)
  const dz = wrap(target.z - own.z)
  const dy = target.y - own.y
  const horizontal = Math.hypot(dx, dz)
  let azimuth = Math.atan2(dx, -dz) - own.heading
  while (azimuth > Math.PI) azimuth -= 2 * Math.PI
  while (azimuth < -Math.PI) azimuth += 2 * Math.PI
  return {
    azimuth,
    elevation: Math.atan2(dy, horizontal || 1),
    range: Math.hypot(dx, dy, dz),
  }
}

// aspect_factor scales detection by the target's aspect: a beam-on fighter is
// the biggest reflector (1.0), nose/tail the smallest (0.8). A near-stationary
// target has no meaningful aspect — middle value.
export function aspect_factor(
  own: RadarOwn,
  target: RadarTarget,
  wrap: Wrap
): number {
  const speed = Math.hypot(target.vx, target.vy, target.vz)
  if (speed < 20) return 0.85
  const dx = wrap(target.x - own.x)
  const dy = target.y - own.y
  const dz = wrap(target.z - own.z)
  const d = Math.hypot(dx, dy, dz) || 1
  const along = Math.abs(
    (target.vx * dx + target.vy * dy + target.vz * dz) / (speed * d)
  )
  return 1 - 0.2 * along
}

const EARTH = 6371000 // m, the earth's radius
const CLUTTER = 0.35 // how much of its range a target seen against the sea loses to the clutter behind it
const EDGE = 0.005 // rad: the band either side of the horizon over which the sea comes in behind a target

// clutter is how far this target is seen against the sea, 0 to 1: its line of
// sight runs below the horizon, so the sea is behind it. The horizon sits
// further below level the higher the jet flies (2.5° at 20,000 ft), and a
// distant target sits lower for the earth's curve; a jet at the same height,
// or a little below it at long range, has the sky behind it.
export function clutter(
  own: RadarOwn,
  target: RadarTarget,
  wrap: Wrap
): number {
  const across = Math.hypot(wrap(target.x - own.x), wrap(target.z - own.z))
  const below = Math.atan2(own.y - target.y, across) + across / (2 * EARTH) // how far below level the line of sight runs
  const horizon = Math.acos(EARTH / (EARTH + Math.max(0, own.y)))
  const t = Math.min(1, Math.max(0, (below - horizon + EDGE) / (2 * EDGE)))
  return t * t * (3 - 2 * t)
}

// detect_range: how far this target paints, this look.
export function detect_range(
  own: RadarOwn,
  target: RadarTarget,
  wrap: Wrap
): number {
  const look = 1 - CLUTTER * clutter(own, target, wrap) // look-down: sea clutter behind a target below the horizon
  return BASE * aspect_factor(own, target, wrap) * look
}

// paint_probability: certain close in, fading toward the detection edge.
export function paint_probability(range: number, detection: number): number {
  if (range >= detection) return 0
  if (range < 0.55 * detection) return 0.97
  return (
    0.97 - (0.97 - 0.15) * ((range - 0.55 * detection) / (0.45 * detection))
  )
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
    const n = Math.hypot(
      (c.azimuth - azimuth) / (2 * half),
      (c.range - range) / scale
    )
    if (n < closest) {
      closest = n
      best = c.id
    }
  }
  return best
}

export class Radar {
  mode: 'rws' | 'tws' = 'rws'
  sil = false // the radar's own silence: SIL on its page, or the knob at STBY
  emcon = false // the UFC's EMCON, which silences it whatever SIL says (NATOPS 2.13.5.2)
  unpowered = false // no ac power on the aircraft (engine.ts power_step, #116)
  width = 0 // index into WIDTHS
  bars = 2 // index into BARS: four
  bar = 0 // the bar this sweep scans, 0 the top
  scale = 40 // display range, nmi
  sweep = 0 // antenna azimuth, rad relative to heading
  elevation = 0 // the antenna's elevation off the horizontal, rad — the pilot slews it to sanitise high or low (±60° gimbal)
  centre = { azimuth: 0, elevation: 0 } // where the scan volume points this step: the nose at the antenna's elevation, or in TWS the L&S
  direction = 1
  bricks: Brick[] = []
  tracks: Track[] = []
  ls: number | string | null = null // launch & steering trackfile (TWS)
  stt: number | string | null = null // the hard lock
  acm: 'bst' | 'vacq' | 'wacq' = 'bst' // armed ACM condition, used by the acquire flow
  auto = false // the ACM condition is commanded: the radar runs the cone itself and locks the first target in it, until deselected
  memory = 0 // seconds the STT has coasted without real data (0 = tracking); MEM shows past zero
  strobes: number[] = [] // azimuths of jamming emitters this step (#31): bearing-only spokes, range unknown
  time = 0
  // breakReason: why the STT dropped THIS step - 'lost' (target gone), 'gimbal'
  // (past ±70° off the nose), 'range' (past HOLD), 'jam' or 'notch' (starved
  // past MEMORY). null on every other step, including a SIL break: a debrief
  // can already see SIL directly on the Radar channel, so this vocabulary
  // stays scoped to breaks a pilot could not otherwise explain.
  breakReason: string | null = null

  // half: the effective azimuth half-width — TWS trades volume for trackfiles
  // and never scans the full ±70°.
  half(): number {
    const w = WIDTHS[this.width]
    return this.mode === 'tws' ? Math.min(w, WIDTHS[1]) : w
  }

  // count: the bars actually scanned — TWS drops bars until a frame fits
  // FRAME, as it caps the width, so its trackfiles keep updating.
  count(): number {
    const asked = BARS[this.bars]
    if (this.mode !== 'tws') return asked
    const sweep = (2 * this.half()) / SWEEP
    let n = 1
    for (const b of BARS) if (b <= asked && b * sweep <= FRAME) n = b
    return n
  }

  // frame: seconds to scan the volume once, each bar swept once — how often
  // any one target can be looked at.
  frame(): number {
    return (this.count() * 2 * this.half()) / SWEEP
  }

  // coverage: the scan's half-height, rad — the bars stacked a beam apart
  // either side of the centre.
  coverage(): number {
    return (this.count() * BEAM) / 2
  }

  // aim points the scan: TWS centres it on the L&S trackfile, carried on from
  // its last fix, in azimuth and elevation, so the target stays in a volume
  // narrow enough to update it; otherwise the nose at the antenna's elevation.
  private aim(own: RadarOwn, wrap: Wrap): void {
    const track =
      this.mode === 'tws' && this.ls != null
        ? this.tracks.find((t) => t.id === this.ls)
        : undefined
    if (!track) {
      this.centre = { azimuth: 0, elevation: this.elevation }
      return
    }
    const age = this.time - track.at
    const g = geometry(
      own,
      {
        x: track.x + track.vx * age,
        y: track.y + track.vy * age,
        z: track.z + track.vz * age,
      },
      wrap
    )
    const reach = GIMBAL - this.half() // the scan's edge stays inside the gimbal
    this.centre = {
      azimuth: Math.max(-reach, Math.min(reach, g.azimuth)),
      elevation: Math.max(-TILT, Math.min(TILT, g.elevation)),
    }
  }

  // silent: the radar is not transmitting, from its own silence, from EMCON or
  // for want of ac power (#116).
  silent(): boolean {
    return this.sil || this.emcon || this.unpowered
  }

  // emitter: the wire truth of what this radar is doing — 0 silent, 1 search,
  // 2 STT. What the other side's RWR reacts to (#28).
  emitter(): 0 | 1 | 2 {
    return this.silent() ? 0 : this.stt != null ? 2 : 1
  }

  step(
    dt: number,
    own: RadarOwn,
    targets: RadarTarget[],
    wrap: Wrap,
    random: () => number = Math.random
  ): void {
    this.time += dt
    this.breakReason = null // this step's cause, if a hard lock breaks below; cleared every step like memory
    this.bricks = this.bricks.filter((b) => this.time - b.at < BRICK_AGE)
    this.tracks = this.tracks.filter(
      (t) => this.time - t.at < TRACK_AGE || t.id === this.stt
    )
    if (
      this.ls != null &&
      this.stt == null &&
      !this.tracks.some((t) => t.id === this.ls)
    )
      this.ls = null
    if (this.silent()) {
      this.stt = null // a silent radar tracks nothing — the picture freezes and ages
      return
    }
    this.aim(own, wrap)
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
      if (!target || !g) {
        this.stt = null // broken lock: back to search; the last trackfile remembers
        this.memory = 0
        this.breakReason = 'lost'
        return
      }
      if (Math.abs(g.azimuth) > GIMBAL) {
        this.stt = null
        this.memory = 0
        this.breakReason = 'gimbal'
        return
      }
      if (g.range > HOLD * detect_range(own, target, wrap)) {
        this.stt = null
        this.memory = 0
        this.breakReason = 'range'
        return
      }
      // MEMORY (#31): a starved tracker coasts on the track's last state (no
      // fix), the display says MEM, and the lock drops if the condition
      // outlasts the window.
      const speed = Math.hypot(target.vx, target.vy, target.vz)
      const radial =
        speed < 1
          ? 0
          : Math.abs(
              (target.vx * wrap(target.x - own.x) +
                target.vy * (target.y - own.y) +
                target.vz * wrap(target.z - own.z)) /
                Math.max(g.range, 1)
            )
      const jammed = target.jamming && g.range > BURNTHROUGH
      const starved = jammed || radial < NOTCH
      if (starved) {
        this.memory += dt
        if (this.memory > MEMORY) {
          this.stt = null
          this.memory = 0
          this.breakReason = jammed ? 'jam' : 'notch' // the condition AT EXPIRY: the one that finally starved it, not whichever opened the window
        }
        return
      }
      this.memory = 0
      this.fix(target) // the antenna stays on the target: a continuous track, and nothing else painted
      return
    }
    this.memory = 0
    const half = this.half()
    const count = this.count()
    if (this.bar >= count) this.bar = 0
    // Each sweep scans one bar, top to bottom, and the antenna steps a bar at
    // every turn: one frame sweeps every bar once.
    const level = this.centre.elevation + ((count - 1) / 2 - this.bar) * BEAM
    let az = this.sweep + this.direction * SWEEP * dt
    let turned = false
    if (az > this.centre.azimuth + half) {
      az = this.centre.azimuth + half
      this.direction = -1
      turned = true
    }
    if (az < this.centre.azimuth - half) {
      az = this.centre.azimuth - half
      this.direction = 1
      turned = true
    }
    for (const target of targets) {
      const g = geometry(own, target, wrap)
      const off = g.elevation - level
      if (off <= -BEAM / 2 || off > BEAM / 2) continue // this bar's slice, half-open so a target on a seam is in one bar
      if (Math.abs(g.azimuth - this.centre.azimuth) > half) continue
      // Half-open interval (previous, current]: consecutive frames partition
      // the sweep exactly, so one crossing is one detection roll and never a
      // cluster of duplicates.
      if (
        (g.azimuth - this.sweep) * (g.azimuth - az) > 0 ||
        g.azimuth === this.sweep
      )
        continue
      const detection = detect_range(own, target, wrap)
      if (g.range >= detection) continue
      if (random() > paint_probability(g.range, detection)) continue
      if (this.mode === 'rws')
        this.paint({
          id: target.id,
          azimuth: g.azimuth,
          range: g.range,
          at: this.time,
          x: target.x,
          z: target.z,
        })
      else this.fix(target)
    }
    this.sweep = az
    if (turned) this.bar = (this.bar + 1) % count
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
      existing.x = target.x
      existing.y = target.y
      existing.z = target.z
      existing.vx = target.vx
      existing.vy = target.vy
      existing.vz = target.vz
      existing.at = this.time
      existing.hits++
    } else
      this.tracks.push({
        id: target.id,
        x: target.x,
        y: target.y,
        z: target.z,
        vx: target.vx,
        vy: target.vy,
        vz: target.vz,
        at: this.time,
        hits: 1,
      })
  }

  // designate climbs the ladder onto a track: in TWS the first designation
  // makes it the L&S, designating the L&S again commands STT; RWS (no
  // trackfiles) goes straight to STT. A silent radar cannot lock.
  designate(id: number | string): boolean {
    if (this.silent()) return false
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
    if (this.silent()) return false
    this.ls = id
    this.stt = id
    return true
  }

  // undesignate steps down: STT back to search (L&S kept), then the L&S, gone.
  undesignate(): void {
    if (this.stt != null) this.stt = null
    else this.ls = null
  }

  // slew moves the antenna's elevation by steps of 5°, held inside the
  // ±60° antenna gimbal.
  slew(direction: number): void {
    this.elevation = Math.max(
      -TILT,
      Math.min(
        TILT,
        this.elevation + Math.sign(direction) * ((5 * Math.PI) / 180)
      )
    )
  }
}

// boresight: does this mission arm the ACM boresight condition and search at
// ten miles, rather than the wide free-flight setup? A merge joust is the
// close-in visual arena from the first frame, so the radar acquires whatever
// the pilot points at instead of making him work a trackfile ladder.
//
// It depends on the mission's SHAPE and nothing else. It used to carry a
// `&& !MULTIPLAYER` term, which took the setup away from a multiplayer joust -
// the same fight, against a person instead of a bot - so nothing acquired for
// the pilot, the display sat on the 40 nm scale through a knife fight, and
// Enter fell through to a boresight cone that is empty whenever the opponent
// is not in front of you. The exclusion reads as caution about auto-locking
// the nearest of many aircraft in a furball, but the ACM modes ARE the furball
// tool: they exist for the visual arena and take whatever enters the cone,
// because the pilot's aim is the selection.
export function boresight(task: string, duel: string): boolean {
  return task === 'joust' && duel !== 'bvr'
}
