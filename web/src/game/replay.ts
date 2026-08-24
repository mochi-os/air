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
