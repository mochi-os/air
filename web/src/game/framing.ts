// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Length-framed message reader for the control stream. World servers are
// UNTRUSTED, so every frame length is bounded (the server caps its own inbound
// at 65536; the client must apply the same cap the other way) and chunks are
// held in a queue rather than re-concatenated whole on each read — an
// unbounded declared length otherwise forced ever-growing buffers with
// quadratic copies, exhausting the tab. Dependency-free so the parser is unit
// testable in isolation.

// FRAME_MOST is the largest control-stream frame the client will assemble,
// mirroring the server's frame_most inbound cap.
export const FRAME_MOST = 65536

// FramingError is thrown on a protocol violation (zero-length or oversized
// declared frame). The caller closes the transport rather than continue.
export class FramingError extends Error {}

// frame length-prefixes a payload for the control stream (4-byte big-endian
// length + bytes). Outbound frames are always small; the cap is on the read
// side, but the encoder lives here so both directions share one definition.
export function frame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length)
  new DataView(out.buffer).setUint32(0, payload.length)
  out.set(payload, 4)
  return out
}

// frames yields length-framed messages from a stream reader, starting with any
// bytes already buffered (pending). It rejects a zero-length or larger-than-
// FRAME_MOST declared frame by throwing FramingError, and consumes bytes from a
// chunk queue so the cost stays linear regardless of how the peer fragments.
export async function* frames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  pending: Uint8Array,
): AsyncGenerator<Uint8Array> {
  // Chunks are consumed from the head via an index (head) plus a byte offset
  // into the head chunk (headOffset). Advancing is O(1) and the array is
  // compacted in amortised O(1), so assembling a frame from many tiny chunks
  // stays linear — a plain shift() per consumed chunk would be O(n^2).
  const chunks: Uint8Array[] = []
  let head = 0
  let headOffset = 0
  let total = 0
  if (pending.length) {
    chunks.push(pending)
    total = pending.length
  }

  // fill pulls one more chunk; false at end of stream.
  const fill = async (): Promise<boolean> => {
    const { value, done } = await reader.read()
    if (done) return false
    if (value && value.length) {
      chunks.push(value)
      total += value.length
    }
    return true
  }

  // take removes and returns the first n buffered bytes, assembling exactly n
  // from the head of the queue without shifting or copying the whole backlog.
  const take = (n: number): Uint8Array => {
    const out = new Uint8Array(n)
    let off = 0
    while (off < n) {
      const chunk = chunks[head]
      const available = chunk.length - headOffset
      const wanted = n - off
      if (available <= wanted) {
        out.set(chunk.subarray(headOffset), off)
        off += available
        head++
        headOffset = 0
      } else {
        out.set(chunk.subarray(headOffset, headOffset + wanted), off)
        headOffset += wanted
        off += wanted
      }
    }
    total -= n
    // Drop fully-consumed chunks once they dominate the array, so `chunks` does
    // not grow without bound over a long-lived stream (amortised O(1)).
    if (head > 32 && head * 2 >= chunks.length) {
      chunks.splice(0, head)
      head = 0
    }
    return out
  }

  for (;;) {
    while (total < 4) {
      // A clean end BETWEEN frames leaves nothing buffered. Anything else is a
      // truncated header — a protocol violation the caller must treat as fatal,
      // so a half-sent frame at EOF cannot be mistaken for a clean close.
      if (!(await fill())) {
        if (total === 0) return
        throw new FramingError('truncated header')
      }
    }
    const header = take(4)
    const size = new DataView(header.buffer, header.byteOffset).getUint32(0)
    if (size === 0 || size > FRAME_MOST) {
      throw new FramingError(`frame size ${size}`)
    }
    while (total < size) {
      // EOF mid-body: the frame is truncated. Throw (not return) so the caller
      // tears the match down rather than treating it as a clean stream end.
      if (!(await fill())) throw new FramingError('truncated frame')
    }
    yield take(size)
  }
}
