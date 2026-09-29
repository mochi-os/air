// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The voice alert system (NATOPS A1-F18AC-NFM-000 2.17.3). A message announces
// once when its condition comes on and needs no reset; it announces again only
// after the condition has been gone for 5 seconds and returns. A message that
// has started is never interrupted, so a higher priority one waits for it to
// finish. BINGO repeats every 30 seconds while the fuel stays below bingo
// (2.2.10.4, MC OFP 19C), the GPWS CHECK GEAR call every 8 seconds while the
// jet stays in the gear-up landing condition (2.17.5.4), and the GPWS recovery
// calls back to back until the warning clears (2.17.4.3.1).

// Every message, highest priority first. The GPWS recovery calls come first,
// having priority over all other cues (2.17.4.3.1, 2.17.5.4); NATOPS orders the
// fire warnings (2.14.1: ENGINE FIRE LEFT, then RIGHT); ALTITUDE is a warning
// (2.17.3), the single call of the secondary radar and barometric low-altitude
// warnings (2.12.5.2, 2.12.5.3); the cautions follow the severity of what they
// announce.
export const MESSAGES = [
  'PULL UP',
  'POWER',
  'ROLL LEFT',
  'ROLL RIGHT',
  'ENGINE FIRE LEFT',
  'ENGINE FIRE RIGHT',
  'CHECK GEAR',
  'ALTITUDE',
  'FLIGHT CONTROLS',
  'ENGINE LEFT',
  'ENGINE RIGHT',
  'FUEL LOW',
  'BINGO',
] as const
export type Message = (typeof MESSAGES)[number]

// The caution and warning rows that raise each message, and the DDI captions
// whose voice replaces the master caution tone. FLAMEOUT is both engines flamed
// out, so both ENGINE calls; a fuel fire lights both FIRE lights, so both ENGINE
// FIRE calls, left first (2.14.1). The FCS row is a jammed control surface,
// which the jet shows as AIL OFF, RUD OFF or FLAPS OFF, all voiced FLIGHT
// CONTROLS (2.8.4.6). FUEL LO says FUEL LOW alone: BINGO keeps its own row
// beside it, so its voice and repeat come from there.
export const SPOKEN: Record<string, readonly Message[]> = {
  'L ENG FIRE': ['ENGINE FIRE LEFT'],
  'R ENG FIRE': ['ENGINE FIRE RIGHT'],
  'FUEL FIRE': ['ENGINE FIRE LEFT', 'ENGINE FIRE RIGHT'],
  'L FLAMEOUT': ['ENGINE LEFT'],
  'R FLAMEOUT': ['ENGINE RIGHT'],
  FCS: ['FLIGHT CONTROLS'],
  'L ENG': ['ENGINE LEFT'],
  'R ENG': ['ENGINE RIGHT'],
  FLAMEOUT: ['ENGINE LEFT', 'ENGINE RIGHT'],
  'FUEL LO': ['FUEL LOW'],
  BINGO: ['BINGO'],
}

const REPEAT: Partial<Record<Message, number>> = { BINGO: 30, 'CHECK GEAR': 8, 'PULL UP': 0, POWER: 0, 'ROLL LEFT': 0, 'ROLL RIGHT': 0 }
const CLEAR = 5 // seconds a condition must be gone before it announces again
const GAP = 0.3 // seconds of silence after a message before the next starts

interface Heard {
  spoken: number // when the message last started, -Infinity while armed
  seen: number // when its condition was last on
}
interface Queue {
  until: number
  heard: Map<Message, Heard>
}

export function voice_queue(): Queue {
  return {
    until: -Infinity,
    heard: new Map(
      MESSAGES.map((message) => [
        message,
        { spoken: -Infinity, seen: -Infinity },
      ])
    ),
  }
}

// voice_step advances the queue to time (seconds) with the messages whose
// conditions are on, and starts the one due, if any: speak plays it and
// returns its length in seconds.
export function voice_step(
  queue: Queue,
  time: number,
  active: ReadonlySet<Message>,
  speak: (message: Message) => number
): Message | null {
  for (const [message, heard] of queue.heard) {
    if (active.has(message)) heard.seen = time
    else if (time - heard.seen >= CLEAR) heard.spoken = -Infinity
  }
  if (time < queue.until) return null
  for (const message of MESSAGES) {
    if (!active.has(message)) continue
    const heard = queue.heard.get(message) as Heard
    const period = REPEAT[message]
    if (
      heard.spoken === -Infinity ||
      (period !== undefined && time - heard.spoken >= period)
    ) {
      heard.spoken = time
      queue.until = time + speak(message) + GAP
      return message
    }
  }
  return null
}
