// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The left DDI's caution area (NATOPS A1-F18AC-NFM-000 2.20.3.2.1, 2.17.2.1).
// Cautions take slots as they occur, from the lower left, three across, a new
// line above the last when a line fills, up to seven lines. A caution that
// clears leaves its slot blank; a new one takes the next slot past the end,
// never a blank, until MASTER CAUTION is pressed while out, which packs the
// rest left and down. With every slot taken a new caution waits for space at the
// end, unless it is a priority caution, for which the oldest non-priority one
// gives way. Pure, so the engine feeds it rows and draws what comes back.

export const ACROSS = 3
const LINES = 7
export const SLOTS = ACROSS * LINES
// PRIORITY: the cautions that may displace the oldest non-priority caution when
// all 21 slots are taken (2.20.3.2.1); with every slot a priority caution,
// nothing new shows until one clears.
export const PRIORITY: ReadonlySet<string> = new Set(['AIL ON', 'CAUT DEGD', 'DEL ON', 'FLAPS OFF', 'FLAPS SCHED', 'INS ATT', 'L AMAD', 'R AMAD', 'L AMAD PR', 'R AMAD PR', 'MECH ON', 'RUD OFF'])

interface Slot {
  key: string
  label: string
  red: boolean
}
export type Slots = (Slot | null)[]
export type Row = [string, string, boolean] // key, label, red - the engine's caution_list rows

// reconcile brings the slots up to date with the rows on show, returning the
// same array when nothing changed so a caller can redraw only on change.
export function reconcile(slots: Slots, rows: readonly Row[]): Slots {
  const want = new Map(rows.map(([key, label, red]) => [key, { key, label, red }]))
  const next: Slots = slots.map((slot) => (slot && want.has(slot.key) ? (want.get(slot.key) as Slot) : null))
  const held = new Set(next.filter((slot): slot is Slot => slot !== null).map((slot) => slot.key))
  while (next.length && next[next.length - 1] === null) next.pop() // a blank at the end is the open space the next caution takes
  for (const [key, slot] of want) {
    if (held.has(key)) continue
    if (next.length >= SLOTS) {
      if (!PRIORITY.has(key)) continue // full: it waits until an open space comes at the end
      const oldest = next.findIndex((slot) => slot !== null && !PRIORITY.has(slot.key))
      if (oldest < 0) continue // all priority: it waits too
      next.splice(oldest, 1) // the oldest non-priority caution gives way and the rest close up behind it
    }
    next.push(slot)
  }
  let same = next.length === slots.length
  for (let i = 0; same && i < next.length; i++) {
    const a = slots[i], b = next[i]
    same = a === b || (!!a && !!b && a.key === b.key && a.label === b.label && a.red === b.red)
  }
  return same ? slots : next
}

// restack packs the blanks out: the MASTER CAUTION press with the light out.
export function restack(slots: Slots): Slots {
  const packed = slots.filter((slot) => slot !== null)
  return packed.length === slots.length ? slots : packed
}

// lines groups the slots for drawing: lines[0] is the bottom line, each
// three long from the left, blanks kept so a cleared caution's slot stays empty.
export function lines(slots: Slots): Slots[] {
  const out: Slots[] = []
  for (let i = 0; i < slots.length; i += ACROSS) out.push(slots.slice(i, i + ACROSS))
  return out
}
