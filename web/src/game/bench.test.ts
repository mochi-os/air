// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { describe, it, expect } from 'vitest'

// bench.ts reads location at import time, and the suite runs in the node
// environment, which has no document. `search` is left empty so the sampler
// stays inactive and only the exported helper is under test.
const here = { href: 'https://mochi-os.org/air/', search: '' }
;(globalThis as { location?: unknown }).location = here

const { beacon } = await import('./bench')

describe('beacon', () => {
  it('accepts a destination on the page own origin', () => {
    expect(beacon('collect')).toBe('https://mochi-os.org/air/collect')
    expect(beacon('/collect')).toBe('https://mochi-os.org/collect')
    expect(beacon('https://mochi-os.org/collect?run=3')).toBe('https://mochi-os.org/collect?run=3')
  })

  it('refuses another origin', () => {
    // The payload carries the user agent, the unmasked GPU string and every
    // page error, and a text/plain beacon crosses origins silently.
    expect(beacon('https://evil.example/collect')).toBe('')
    expect(beacon('//evil.example/collect')).toBe('')
    expect(beacon('http://mochi-os.org/collect')).toBe('')       // scheme differs
    expect(beacon('https://mochi-os.org:8443/collect')).toBe('') // port differs
    expect(beacon('https://mochi-os.org.evil.example/x')).toBe('')
  })

  it('refuses a host smuggled past a naive relative-path test', () => {
    // sendBeacon resolves through the same parser, which folds backslashes and
    // leading whitespace, so neither reads as the relative path it resembles.
    expect(beacon('\\\\evil.example/collect')).toBe('')
    expect(beacon('\t//evil.example/collect')).toBe('')
  })

  it('refuses a scheme that carries its own opaque origin', () => {
    expect(beacon('javascript:fetch(1)')).toBe('')
    expect(beacon('data:text/plain,x')).toBe('')
    expect(beacon('blob:https://mochi-os.org/abc')).toBe('')
  })

  it('sends nowhere when the parameter is absent', () => {
    expect(beacon('')).toBe('')
  })

  it('refuses every destination when the document origin is opaque', () => {
    // A sandboxed frame without allow-same-origin. Measured 2026-09-08: air
    // reads a real origin in the shell today, so this is the guard holding if
    // that changes -- an origin of "null" must not compare equal to itself and
    // license the whole web.
    here.href = 'data:text/html,<canvas>'
    try {
      expect(beacon('collect')).toBe('')
      expect(beacon('https://mochi-os.org/collect')).toBe('')
    } finally {
      here.href = 'https://mochi-os.org/air/'
    }
  })
})
