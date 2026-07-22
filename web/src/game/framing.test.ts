// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

/* eslint-disable lingui/no-unlocalized-strings -- vitest describe/it names are not user-facing */
import { describe, it, expect } from 'vitest'
import { frame, frames, FramingError, FRAME_MOST } from './framing'

// reader turns a fixed list of chunks into a stream reader; the last read is done.
function reader(chunks: Uint8Array[]): ReadableStreamDefaultReader<Uint8Array> {
  let i = 0
  return {
    read: async () =>
      i < chunks.length
        ? { value: chunks[i++], done: false }
        : { value: undefined, done: true },
  } as unknown as ReadableStreamDefaultReader<Uint8Array>
}

async function collect(chunks: Uint8Array[], pending: Uint8Array = new Uint8Array(0)): Promise<Uint8Array[]> {
  const out: Uint8Array[] = []
  for await (const f of frames(reader(chunks), pending)) out.push(f)
  return out
}

function concat(list: Uint8Array[]): Uint8Array {
  const total = list.reduce((s, c) => s + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of list) {
    out.set(c, off)
    off += c.length
  }
  return out
}

// header writes a 4-byte big-endian length WITHOUT a body — for truncation tests.
function header(size: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, size)
  return b
}

const decoder = new TextDecoder()
const text = (payload: Uint8Array) => decoder.decode(payload)
const encode = (s: string) => new TextEncoder().encode(s)

describe('frames', () => {
  it('yields multiple frames delivered in a single chunk', async () => {
    const buf = concat([frame(encode('one')), frame(encode('two')), frame(encode('three'))])
    const out = await collect([buf])
    expect(out.map(text)).toEqual(['one', 'two', 'three'])
  })

  it('reassembles a frame fragmented across the header and body', async () => {
    const full = frame(encode('hello world'))
    // one byte at a time — exercises the head-index assembler across many chunks
    const bytes = Array.from(full, (b) => new Uint8Array([b]))
    const out = await collect(bytes)
    expect(out.map(text)).toEqual(['hello world'])
  })

  it('consumes pending bytes before reading the stream', async () => {
    const full = frame(encode('buffered'))
    const split = Math.floor(full.length / 2)
    const out = await collect([full.subarray(split)], full.subarray(0, split))
    expect(out.map(text)).toEqual(['buffered'])
  })

  it('returns cleanly at end of stream between frames', async () => {
    const out = await collect([frame(encode('done'))])
    expect(out.map(text)).toEqual(['done'])
  })

  it('rejects a zero-length declared frame', async () => {
    await expect(collect([header(0)])).rejects.toThrow(FramingError)
  })

  it('accepts a frame of exactly FRAME_MOST and rejects FRAME_MOST + 1', async () => {
    const ok = frame(new Uint8Array(FRAME_MOST))
    expect((await collect([ok]))[0].length).toBe(FRAME_MOST)
    await expect(collect([header(FRAME_MOST + 1)])).rejects.toThrow(FramingError)
  })

  it('throws on a truncated header at end of stream (partial header must not read as a clean close)', async () => {
    // two bytes of a four-byte header, then EOF
    await expect(collect([new Uint8Array([0, 0])])).rejects.toThrow(FramingError)
  })

  it('throws on a truncated body at end of stream — the frozen-match vector', async () => {
    // declares 10 bytes, delivers only 4, then EOF
    await expect(collect([header(10), new Uint8Array([1, 2, 3, 4])])).rejects.toThrow(FramingError)
  })

  it('stays linear when a large frame arrives one byte per chunk', async () => {
    // 40k one-byte chunks: trivial with a head index, seconds-long if take()
    // shifted the queue per chunk (the O(n^2) regression this guards).
    const payload = new Uint8Array(40000)
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff
    const full = frame(payload)
    const chunks = Array.from(full, (b) => new Uint8Array([b]))
    const started = performance.now()
    const out = await collect(chunks)
    expect(out.length).toBe(1)
    expect(out[0].length).toBe(payload.length)
    expect(Array.from(out[0].subarray(0, 8))).toEqual(Array.from(payload.subarray(0, 8)))
    expect(performance.now() - started).toBeLessThan(4000)
  })
})
