// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The explosion scenario (&blast=, developer mode only): real bursts at chosen
// distances from the jet, one at a time and round again, so a pilot can hear a
// warhead close and far on demand instead of waiting for a fight to produce
// one. Each burst waits for the last one's report to arrive and die away: a
// burst 3 km off is heard nine seconds after its flash, and two reports
// overlapping would make neither one judgeable.
//
//   ?developer=1&task=free&blast=1                 the ladder below
//   ?developer=1&task=free&blast=20,600,death      a list of your own
//
// Entries are metres from the jet, 1 to BLAST_REACH, or `death`: a heater
// fusing beside the jet with the jet's own muffled fireball over it, which is
// what a pilot hears when a missile kills the jet, without the dying.

import { BLAST_REACH } from './audio'

export interface Blast {
  distance: number // metres from the jet
  death: boolean // the heater burst plus the jet's own fireball, at once
}

export const LADDER = '9,150,600,3000,death'
export const SOUND = 343 // m/s: a report arrives this long after its flash
const LENGTH = 2.2 // s: the explosion buffer, audio.ts bake()
const GAP = 2 // s of quiet between one report dying away and the next flash
const HEATER = 9 // m: a heater fusing close enough to kill

// blast_plan reads the URL's value: null when the scenario is off (absent, or
// nothing usable in it), the ladder for `1` or an empty value.
export function blast_plan(text: string | null): Blast[] | null {
  if (text === null) return null
  const source = text === '' || text === '1' ? LADDER : text
  const list: Blast[] = []
  for (const word of source.split(',')) {
    const entry = word.trim().toLowerCase()
    if (entry === 'death') {
      list.push({ distance: HEATER, death: true })
      continue
    }
    const distance = Number(entry)
    if (entry !== '' && Number.isFinite(distance) && distance >= 1 && distance <= BLAST_REACH)
      list.push({ distance, death: false })
  }
  return list.length ? list : null
}

// Blasts paces a plan on the mission clock: due() hands back the burst whose
// time has come, once, and schedules the next after the report has landed.
export class Blasts {
  private index = 0
  private at: number // mission seconds at which the next burst is due
  private fired = -1 // mission seconds of the last flash, -1 before the first
  private last: Blast | null = null
  private shown = 0 // the last burst's place in the plan, counting from 1

  constructor(
    private readonly list: Blast[],
    start: number
  ) {
    this.at = start
  }

  due(time: number): Blast | null {
    if (time < this.at) return null
    const blast = this.list[this.index]
    this.last = blast
    this.shown = this.index + 1
    this.fired = time
    this.index = (this.index + 1) % this.list.length
    this.at = time + blast.distance / SOUND + LENGTH + GAP
    return blast
  }

  // label is the developer HUD's line: which burst this is, and while its
  // report is still in the air, how long until it arrives. English, like the
  // HUD's other developer readouts, which no player sees.
  label(time: number): string {
    const count = this.list.length
    if (!this.last) return `blast in ${Math.max(0, Math.ceil(this.at - time))} s`
    const what = this.last.death
      ? `death: heater at ${this.last.distance} m and own fireball`
      : `${this.last.distance} m`
    const arrival = this.fired + this.last.distance / SOUND - time
    const report = arrival > 0 ? `, heard in ${Math.ceil(arrival * 10) / 10} s` : ''
    return `blast ${this.shown} of ${count}: ${what}${report}`
  }
}
