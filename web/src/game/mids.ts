// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Link 16 through the MIDS terminal (NATOPS A1-F18AC-NFM-000 2.13.5, 2.13.5.2,
// 23.2.1, 23.6.2.2.2; aircraft after AFC 270): what the terminal sends and
// takes, and the picture a side builds from it - each member's own position
// report, and the radar tracks its members give to the net. NATOPS leaves the
// link's displays to the NATIP, which we do not hold, so there are none here.
// Pure: the engine says who is on the net and reads back what it adds to the
// pilot's picture.

export interface Terminal {
  on: boolean // the LINK 16 function, turned on and off at the UFC (23.2.1)
}
export function fresh(): Terminal {
  return { on: true }
}
// What the terminal has to work with: ac power, its crypto variables - which
// the communication panel's CRYPTO switch holds or zeroes with the IFF's
// (23.6.2.2.2) - and the UFC's EMCON.
export interface Sense {
  power: boolean
  held: boolean
  emission: boolean
}
// receiving: the terminal takes the net.
export function receiving(t: Terminal, s: Sense): boolean {
  return t.on && s.power && s.held
}
// sending: and gives to it - its own position and its radar's tracks - which
// EMCON stops while it goes on receiving (2.13.5.2).
export function sending(t: Terminal, s: Sense): boolean {
  return receiving(t, s) && !s.emission
}

// What the session relays of an aircraft's identification and link equipment
// (the world server's status events): whether its transponder answers a mode 4
// challenge and on which antenna, whether its interrogator is challenging,
// whether its terminal is sending, and the slots its radar tracks.
export interface Status {
  reply: boolean
  challenge: boolean
  link: boolean
  antenna: 'upper' | 'both' | 'lower'
  tracks: number[]
}
// STANDING: what an aircraft nobody has reported for is taken to be -
// everything on, as the pre-flight leaves it. An older server reports for
// nobody.
export const STANDING: Status = { reply: true, challenge: true, link: true, antenna: 'both', tracks: [] }
// read takes a status event off the wire, which promises nothing: flags that
// are not true are false, an antenna that is not UPPER or LOWER is BOTH, and
// the tracks are whole slots under the limit, each once.
export function read(event: Record<string, unknown>, slots: number): Status {
  const tracks = Array.isArray(event.tracks) ? [...new Set(event.tracks.filter((t): t is number => Number.isInteger(t) && t >= 0 && t < slots))] : []
  return { reply: event.reply === true, challenge: event.challenge === true, link: event.link === true, antenna: event.antenna === 'upper' || event.antenna === 'lower' ? event.antenna : 'both', tracks }
}

// pack writes a status as an input datagram carries it: one array, its first
// number the flags - reply 1, challenge 2, link 4, the upper antenna 8, the
// lower 16 - and the rest the tracks. The datagram has room for a dozen bytes
// of it, not for five named fields.
export function pack(s: Status): number[] {
  const flags = (s.reply ? 1 : 0) | (s.challenge ? 2 : 0) | (s.link ? 4 : 0) | (s.antenna === 'upper' ? 8 : s.antenna === 'lower' ? 16 : 0)
  return [flags, ...s.tracks]
}

// One aircraft as the net carries it: its slot, its side, whether it is
// sending, and the slots its radar holds as tracks.
export interface Member {
  slot: number
  team: string
  sending: boolean
  tracks: readonly number[]
}
// picture: what the net adds for an aircraft that is receiving - the members of
// its side that are sending, by their own reports, and the aircraft those
// members track, less itself and the members already there.
export interface Picture {
  members: number[]
  donated: number[]
}
export function picture(own: { slot: number; team: string; receiving: boolean }, net: readonly Member[]): Picture {
  if (!own.receiving || !own.team) return { members: [], donated: [] }
  const donors = net.filter((m) => m.slot !== own.slot && m.team === own.team && m.sending)
  const members = donors.map((m) => m.slot)
  const donated = [...new Set(donors.flatMap((m) => [...m.tracks]))].filter((slot) => slot !== own.slot && !members.includes(slot))
  return { members, donated }
}
