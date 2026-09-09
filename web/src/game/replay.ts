// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The buffered flight, reachable WITHOUT the engine: importing an accessor from
// engine.ts would drag three.js into the log page's chunk. The engine
// PUBLISHES here at mission start. It holds a FUNCTION, not a value - the
// recorder is still filling - and the module state survives GameCanvas
// unmounting.

export interface Replay {
  text: string
  session: string // the history row this belongs to: the world's session in multiplayer, "local-<start>" alone (#118)
  started: number // that row's `started`, which the two cases key differently — match_started v mission_began
  kind: string
}

let live: () => Replay | null = () => null

// publish is called by the engine at mission start, once per mission.
export function publish(source: () => Replay | null): void {
  live = source
}

// recording renders what is buffered right now; null when nothing was captured.
export function recording(): Replay | null {
  return live()
}

// identity answers which history row a recording belongs to, and it is a pure
// function here rather than engine state so it can be tested at all (#118).
//
// The two cases key differently and that is the whole defect: net_finish writes
// a multiplayer row with the WORLD's session and match_started, while a
// single-player row is written with "local-"+mission_began for both. The engine
// used the local pair unconditionally, so in multiplayer the recording's key
// matched no row: MatchLog's `replay.session === m.session` was never true and
// the upload was gated off, leaving the recorder filling memory all match for
// something nothing could reach.
//
// Null means no row exists to bind to — a multiplayer session that never got a
// welcome never wrote one, and an upload would have nothing to attach to.
export function identity(
  multiplayer: boolean,
  session: string, // the world's session id, when there is one
  started: number, // match_started: when the server's match began
  began: number // mission_began: when this local flight began
): { session: string; started: number } | null {
  if (multiplayer) return started ? { session, started } : null
  return { session: 'local-' + began, started: began }
}
