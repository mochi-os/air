// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// RWR (#28): the ALR-67 at game fidelity — a passive receiver that knows only
// what illuminates it. A SEARCH radar is heard as PERIODIC paints: you are lit
// only when his sweep crosses you, so the symbol blips every few seconds while
// you sit inside his scan cone, and the on-off rhythm is emission discipline
// felt from the receiving end. An STT on YOU is continuous and unmistakable;
// an STT on someone else is silence, because his energy is pointed at him.
// Bearing only — a receiver has no ranging — and contacts age off when the
// paints stop. The feeds are #30's emitters: the SP bandit's derived state and
// net.emitters from the pose wire in multiplayer.

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
export type RwrContact = { id: number | string; bearing: number; locked: boolean; at: number }

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
  step(dt: number, own: { x: number; z: number }, emitters: RwrEmitter[], wrap: (v: number) => number, random: () => number = Math.random): { fresh: number } {
    this.time += dt
    let fresh = 0
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
    return { fresh }
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
