// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// A flight saves itself as it flies (#16): its history row, marked flying,
// then its recording, once the flight is a sortie and every PERIOD seconds
// after. A tab that freezes, crashes or closes keeps all but the last minute;
// the upload at the end of the flight cannot outlive a closing page. Every
// save, the final one included, waits for the one before it, so a checkpoint
// still uploading never lands after a later save and puts back an older
// recording.

import { record, recording_store } from './net'

export const PERIOD = 60 // s between saves while flying
export const SORTIE = 5 // s: a flight shorter than this is an aborted start and leaves nothing (#51 ruling 2026-08-21)
export const FLYING = 'flying' // the reason a row carries until the flight ends

export type Row = Parameters<typeof record>[0]
export type Recording = { session: string; started: number; text: string } | null

let queue: Promise<unknown> = Promise.resolve()

// due: whether a flight `flown` seconds in, at `now` on the wall clock and last
// saved at `last` on it (-Infinity before its first), is owed a save now. The
// sortie is flight time; the period is the pilot's time, so a frozen tab loses
// a minute of play at any time compression, and 64× does not save the whole
// recording every second.
export function due(flown: number, now: number, last: number): boolean {
  return flown >= SORTIE && now - last >= PERIOD
}

// save stores the row, then the recording, after every earlier save has
// finished. Either may be null; a recording with no session has nothing to
// bind to and is skipped.
export function save(row: Row | null, recording: Recording): Promise<unknown> {
  queue = queue.then(async () => {
    if (row) await record(row)
    if (recording && recording.session)
      await recording_store(recording.session, recording.started, recording.text)
  })
  return queue
}
