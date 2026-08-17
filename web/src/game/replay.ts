// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The buffered flight, reachable WITHOUT the engine.
//
// The History page is its own route and cannot see the index route's game
// handle, so it needs a module-level accessor. Importing one from engine.ts
// dragged the whole simulator — and three.js with it, 1,094 kB raw and 338 kB
// gzipped, measured — into the flight log's chunk to read a string. This module
// is the seam: the engine PUBLISHES its accessor here at mission start, and
// every reader outside the engine imports this instead.
//
// It deliberately holds a FUNCTION, not a value. The recorder is still filling
// while the page is open, so a snapshot taken at publish time would be the empty
// buffer for the whole mission.
//
// Module state survives GameCanvas unmounting, which is what lets History still
// offer this session's recording after the player has left the mission.

export interface Replay {
  text: string
  session: string
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
