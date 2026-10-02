// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The input datagram's batch: the newest sample with the two before it, for
// loss tolerance. A QUIC datagram carries about 1,200 bytes until path MTU
// discovery lifts it, and one past the limit is not sent at all, so three
// copies of every field is all the room there is. What is almost always false
// is left out unless set, and what the session needs only the latest of rides
// the newest sample alone.

import { pack } from './mids'
import type { InputSample } from './net'

// A sample as the datagram carries it.
export type Queued = Record<string, unknown> & { sequence: number }
// DEPTH: the samples a datagram carries.
export const DEPTH = 3
// BUDGET: the bytes the encoded datagram must stay within, clear of the limit.
export const BUDGET = 1100

// queue adds a sample to the batch. solo and extinguish go only when set, a
// server reading their absence as false; the status goes packed, on the newest
// sample alone, which is the one the server reads it from.
export function queue(batch: Queued[], sample: InputSample, sequence: number): void {
  const { solo, extinguish, status, ...rest } = sample
  for (const earlier of batch) delete earlier.status
  batch.push({ ...rest, ...(solo ? { solo } : {}), ...(extinguish ? { extinguish } : {}), status: pack(status), sequence })
  if (batch.length > DEPTH) batch.shift()
}
