// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The public world-server listing and the rules the join page shows it by.
// Deliberately free of imports: these decide what a player sees before they
// have clicked anything, so they are kept where a test can reach them without
// dragging in the app client and its macros.

export interface Server {
  world: string
  name: string
  address: string
  version: number
  players: number
  seen: number
}

// A listing is offline once it has missed two 10-minute refresh floors: core
// keeps it in the table for 45 minutes (repair grace), but a join page should
// stop advertising a server that has gone quiet well before then.
export const OFFLINE_AFTER = 1500

// server_offline reports whether a listing has gone quiet past two refresh
// floors. `now` is seconds since the epoch, passed in so the rule is testable
// without leaning on the wall clock.
export function server_offline(server: Server, now: number): boolean {
  return now - server.seen > OFFLINE_AFTER
}

// server_mismatch reports whether this client's wasm flies a different flight
// model from the server's. Version 0 means the wasm has not loaded yet, and an
// unknown version must not grey out the whole list.
export function server_mismatch(server: Server, version: number): boolean {
  return version > 0 && server.version !== version
}

// server_order sorts a listing set the way the join page shows it: busiest
// first, because a list of empty servers reads as a dead game, and offline
// listings sunk to the bottom regardless of the count they last reported.
// Version-mismatched servers keep their place — they are shown greyed with the
// reason, never hidden or demoted, so the list does not look like a dead
// network.
export function server_order(servers: Server[], now: number): Server[] {
  return [...servers].sort((a, b) => {
    const first = server_offline(a, now) ? 1 : 0
    const second = server_offline(b, now) ? 1 : 0
    return first - second || b.players - a.players
  })
}
