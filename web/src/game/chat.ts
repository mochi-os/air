// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The in-flight chat prompt's scopes: a team-only line in a teams match, the
// whole match over the match wire, or everyone on the server through the
// lobby ring beside the match list. The chat key opens the prompt at the
// match's own default and, pressed again while the prompt is open, cycles
// Team and Match; its shift chord selects the server from either.
export type Scope = 'team' | 'match' | 'server'

// opening is what the chat key opens: the team in a teams match, else the match.
export function opening(teams: boolean): Scope {
  return teams ? 'team' : 'match'
}

// advance is where the chat key takes an open prompt: its shift chord to the
// server; the bare key between Team and Match in a teams match, and to Match
// in any other, which is also the way back from the server.
export function advance(scope: Scope, teams: boolean, shout: boolean): Scope {
  if (shout) return 'server'
  if (!teams) return 'match'
  return scope === 'team' ? 'match' : 'team'
}

// wire is the scope the match connection carries, or null for a line that
// goes to the lobby instead.
export function wire(scope: Scope): 'team' | 'all' | null {
  if (scope === 'team') return 'team'
  if (scope === 'match') return 'all'
  return null
}
