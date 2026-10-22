// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// RWR (#28): the ALR-67 at game fidelity - a passive, bearing-only receiver. A
// search radar is heard as periodic paints as its sweep crosses us, an STT on
// us is continuous, an STT on someone else is silence; contacts age off when
// the paints stop. The feeds are #30's emitters, and a missile is heard only
// when its own seeker wakes, about ten miles out.

export const NM = 1852

export type RwrEmitter = {
  id: number | string
  x: number
  z: number
  nosex: number // his horizontal nose direction, normalised — the scan cone's axis
  nosez: number
  mode: 1 | 2 // search / STT
  locked: boolean // STT with US as the target
}
export type RwrContact = {
  id: number | string
  bearing: number
  locked: boolean
  missile?: boolean
  at: number
}

// RwrSeeker is an active missile seeker painting us — the round's own radar,
// not its shooter's. Bearing is all a receiver gets.
export type RwrSeeker = { id: number | string; x: number; z: number }

// RwrMotion is a position and a velocity in world metres and metres a second.
export type RwrMotion = {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
}

// incoming reports whether a radar round is a threat to us, judged as the
// world server's bots judge one: its seeker awake (phase 1 and on: active,
// pitbull or loose) and the round still closing, its velocity relative to ours
// along the line to us. One that has gone by flies on until its battery dies,
// and warning of it told the pilot to keep defending a round that had missed.
export function incoming(
  phase: number,
  round: RwrMotion,
  own: RwrMotion,
  wrap: (v: number) => number
): boolean {
  if (phase < 1) return false
  const dx = wrap(own.x - round.x)
  const dy = own.y - round.y
  const dz = wrap(own.z - round.z)
  return (
    (round.vx - own.vx) * dx +
      (round.vy - own.vy) * dy +
      (round.vz - own.vz) * dz >
    0
  )
}

// RwrRound is a round as single player's pool holds it: its slot, whether it
// is flying and whether it is the bandit's, its seeker phase, and its position
// and velocity.
export type RwrRound = {
  slot: number
  active: boolean
  enemy: boolean
  phase?: number
  px: number
  py: number
  pz: number
  vx: number
  vy: number
  vz: number
}

// threats is single player's third voice: the bandit's rounds that are
// incoming, each painting us from where it is.
export function threats(
  rounds: RwrRound[],
  own: RwrMotion,
  wrap: (v: number) => number
): RwrSeeker[] {
  const seekers: RwrSeeker[] = []
  for (const m of rounds) {
    if (!m.active || !m.enemy) continue
    if (
      !incoming(
        m.phase ?? 0,
        { x: m.px, y: m.py, z: m.pz, vx: m.vx, vy: m.vy, vz: m.vz },
        own,
        wrap
      )
    )
      continue
    seekers.push({ id: 'bandit-round-' + m.slot, x: m.px, z: m.pz })
  }
  return seekers
}

const CONE = 0.342 // cos 70°: his scan half-width — outside it his sweep never touches us
const REACH = 60 * NM // one-way listening range: a receiver hears further than the radar sees
const REVISIT = 2.2 // his sweep's revisit floor, seconds; jitter rides on top
const JITTER = 1.6
const AGE = 8 // seconds a contact survives without a fresh paint

export class Rwr {
  contacts: RwrContact[] = []
  paints = 0 // cumulative search paints — the harness's cadence probe
  time = 0
  private next = new Map<number | string, number>() // per-emitter: when his sweep next crosses us

  reset(): void {
    this.contacts = []
    this.next.clear()
    this.time = 0
    this.paints = 0
  }

  // step returns how many NEW symbols appeared (the new-threat chirp).
  step(
    dt: number,
    own: { x: number; z: number },
    emitters: RwrEmitter[],
    wrap: (v: number) => number,
    random: () => number = Math.random,
    seekers: RwrSeeker[] = []
  ): { fresh: number; missile: boolean } {
    this.time += dt
    let fresh = 0
    // Active seekers first: a round hunting US is the loudest thing the
    // receiver will ever hear, and it owns its own symbol rather than
    // colouring the shooter's.
    for (const s of seekers) {
      const bearing = Math.atan2(wrap(s.x - own.x), -wrap(s.z - own.z))
      const existing = this.contacts.find((c) => c.id === s.id)
      if (existing) {
        existing.bearing = bearing
        existing.at = this.time
      } else {
        this.contacts.push({
          id: s.id,
          bearing,
          locked: true,
          missile: true,
          at: this.time,
        })
        fresh++
      }
    }
    for (const e of emitters) {
      if (e.mode === 2 && !e.locked) continue // his antenna is on someone else
      const dx = wrap(e.x - own.x)
      const dz = wrap(e.z - own.z)
      const range = Math.hypot(dx, dz) || 1
      const bearing = Math.atan2(dx, -dz)
      if (e.locked) {
        fresh += this.heard(e.id, bearing, true)
        continue
      }
      const facing = (-dx * e.nosex + -dz * e.nosez) / range // him toward us, against his nose
      if (facing < CONE || range > REACH) continue
      const due = this.next.get(e.id) ?? 0
      if (this.time < due) continue
      this.next.set(e.id, this.time + REVISIT + random() * JITTER)
      this.paints++
      fresh += this.heard(e.id, bearing, false)
    }
    this.contacts = this.contacts.filter((c) => this.time - c.at < AGE)
    return { fresh, missile: this.warned() }
  }

  // warned: an active seeker is painting us right now — the MISSILE alert.
  warned(): boolean {
    return this.contacts.some((c) => c.missile && this.time - c.at < 1.0)
  }

  private heard(id: number | string, bearing: number, locked: boolean): number {
    const existing = this.contacts.find((c) => c.id === id)
    if (existing) {
      existing.bearing = bearing
      existing.locked = locked
      existing.at = this.time
      return 0
    }
    this.contacts.push({ id, bearing, locked, at: this.time })
    return 1
  }

  locked(): boolean {
    return this.contacts.some((c) => c.locked && this.time - c.at < 0.5)
  }
}
