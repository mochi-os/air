// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// How a life ended, turned into the words the pilot reads. The engine already
// knew the cause - crash_ownship records it and the recording carries it as
// Fate - but the banner said CRASHED for everything except an ejection, so
// being shot down by a missile read as flying into the ground.
//
// A pure function in its own module because engine.ts cannot be imported by a
// test (Lingui macros, THREE), which is why the old expression was never
// covered. Returns a HUD_MESSAGES key and, when one is known, the callsign to
// interpolate - so the whole sentence is one translatable string and a
// translator can put the name wherever their language needs it.

// The fates that mean another aircraft's weapons did this: a missile, a fuel
// fire that a hit started, a pilot killed at the controls, or a multiplayer
// death whose mechanism the wire does not carry. What killed you matters less
// on the banner than WHO - the weapon is in the recording either way.
const BATTLE = new Set(['missile', 'fire', 'pilot', 'battle'])

export interface Demise {
  text: string // a HUD_MESSAGES key
  callsign?: string // interpolated into it when the text takes one
}

export function demise(
  fate: string | undefined,
  callsign: string,
  ejected: boolean
): Demise {
  if (ejected) return { text: 'EJECTED' }
  if (fate === 'midair') {
    return callsign
      ? { text: 'COLLIDED WITH {callsign}', callsign }
      : { text: 'COLLIDED' }
  }
  if (fate && BATTLE.has(fate)) {
    // No callsign is reachable in multiplayer: the server credits a kill to the
    // last player to damage you within a minute, so a fire that burns longer
    // than that is nobody's.
    return callsign
      ? { text: 'DESTROYED BY {callsign}', callsign }
      : { text: 'DESTROYED' }
  }
  // sea, building, post, island, probe, the landing verdict, and an
  // unset fate: flown into something.
  return { text: 'CRASHED' }
}

export interface Line {
  text: string // a HUD_MESSAGES key
  values?: Record<string, string> // interpolated into it
}

// The same event told to everyone else, for the comms log: "A destroyed B",
// "B crashed". The banner tells the pilot who ended THEIR life and is gone in
// three seconds; this is the third-person record that outlives it and answers
// "where did the bandit go" for anyone who missed the moment.
//
// A death nobody is credited with reads as a crash. In multiplayer that is what
// the wire says - the server credits the last player to damage the victim
// within a minute, and offers no cause when nobody qualifies - so the feed
// reports the credit rather than guessing at a mechanism it was not told.
// Returns null when the victim has no name, since " crashed" is worse than
// silence.
export function report(
  fate: string | undefined,
  killer: string,
  victim: string
): Line | null {
  if (!victim) return null
  if (fate === 'midair' && killer) {
    return {
      text: '{victim} collided with {other}',
      values: { victim, other: killer },
    }
  }
  if (killer && fate && BATTLE.has(fate)) {
    return { text: '{killer} destroyed {victim}', values: { killer, victim } }
  }
  return { text: '{victim} crashed', values: { victim } }
}

// The single-player bandit's fates read differently from the ownship's in one
// place: its "verdict" is the battle model judging the airframe dead, which is
// the player's kill, where the ownship's is a wrecked landing. Everything else
// - the sea, a building, the fuel fire - means on the bandit exactly what it
// means on the player.
export function opponent(fate: string | undefined): string | undefined {
  return fate === 'verdict' ? 'battle' : fate
}
