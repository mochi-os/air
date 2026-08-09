// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { describe, expect, it } from 'vitest'
import { diagnose } from './graphics'

function context(renderer: string, unmasked = true) {
  return {
    getExtension: () => (unmasked ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : null),
    getParameter: () => renderer,
    RENDERER: 0x1f01,
  }
}

describe('diagnose', () => {
  it('names the browser when WebGL 2 is missing', () => {
    expect(diagnose(() => null)).toBe('webgl2')
    expect(diagnose(() => { throw new Error('blocked') })).toBe('webgl2')
  })
  it('names the acceleration when the renderer is software', () => {
    expect(diagnose(() => context('Google SwiftShader'))).toBe('software')
    expect(diagnose(() => context('llvmpipe (LLVM 15.0.7, 256 bits)'))).toBe('software')
    expect(diagnose(() => context('Microsoft Basic Render Driver'))).toBe('software')
  })
  it('stays quiet on real hardware', () => {
    expect(diagnose(() => context('NVIDIA GeForce RTX 3060/PCIe/SSE2'))).toBe(null)
    expect(diagnose(() => context('Apple M2', false))).toBe(null)
  })
  it('stays quiet when the renderer name is unreadable', () => {
    expect(
      diagnose(() => ({
        getExtension: () => { throw new Error('sanitized') },
        getParameter: () => { throw new Error('sanitized') },
        RENDERER: 0x1f01,
      }))
    ).toBe(null)
  })
})
