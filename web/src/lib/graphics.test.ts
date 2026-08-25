// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { diagnose } from './graphics'

// The fake answers getExtension by NAME, the way a real context does: the
// renderer-info extension for the probe's question, the lose-context one for
// the release that follows it.
function context(renderer: string, unmasked = true) {
  const lose = vi.fn()
  const gl = {
    getExtension: (name: string) =>
      name === 'WEBGL_lose_context' ? { loseContext: lose } : unmasked ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : null,
    getParameter: () => renderer,
    RENDERER: 0x1f01,
    lose,
  }
  return gl
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

// A probe that keeps its context alive is a leak with a hard ceiling: browsers
// allow about sixteen live WebGL contexts per page and force-lose the OLDEST
// when a new one passes that. Once the player is flying, the oldest is the
// game's own, so a probe that never lets go can take the mission down.
describe('the probe releases its context', () => {
  it('lets go of a hardware context', () => {
    const gl = context('NVIDIA GeForce RTX 3060/PCIe/SSE2')
    diagnose(() => gl)
    expect(gl.lose).toHaveBeenCalledTimes(1)
  })
  it('lets go of a software one', () => {
    const gl = context('Google SwiftShader')
    diagnose(() => gl)
    expect(gl.lose).toHaveBeenCalledTimes(1)
  })
  it('lets go even when the renderer name could not be read', () => {
    const lose = vi.fn()
    const gl = {
      getExtension: (name: string) => {
        if (name === 'WEBGL_lose_context') return { loseContext: lose }
        throw new Error('sanitized')
      },
      getParameter: () => { throw new Error('sanitized') },
      RENDERER: 0x1f01,
    }
    expect(diagnose(() => gl)).toBe(null)
    expect(lose).toHaveBeenCalledTimes(1)
  })
  it('survives a context that cannot be released', () => {
    const gl = {
      getExtension: (name: string) => (name === 'WEBGL_lose_context' ? null : { UNMASKED_RENDERER_WEBGL: 0x9246 }),
      getParameter: () => 'Apple M2',
      RENDERER: 0x1f01,
    }
    expect(() => diagnose(() => gl)).not.toThrow()
  })
})

// The verdict cannot change inside a session, and the menu remounts on every
// trip out to flight, so the real probe runs once and the answer is kept. A
// caller passing its own factory is a test and is never cached.
describe('the real probe runs once per session', () => {
  const fresh = async () => {
    vi.resetModules()
    return (await import('./graphics')).diagnose
  }
  afterEach(() => vi.unstubAllGlobals())

  it('makes one canvas however many times it is asked', async () => {
    const probe = await fresh()
    const gl = context('Google SwiftShader')
    const getContext = vi.fn(() => gl)
    const createElement = vi.fn(() => ({ getContext }))
    vi.stubGlobal('document', { createElement })

    expect(probe()).toBe('software')
    expect(probe()).toBe('software')
    expect(probe()).toBe('software')

    expect(createElement).toHaveBeenCalledTimes(1)
    expect(gl.lose).toHaveBeenCalledTimes(1)
  })

  it('does not keep a verdict of webgl2', async () => {
    const probe = await fresh()
    const gl = context('NVIDIA GeForce RTX 3060/PCIe/SSE2')
    let live = false
    const getContext = vi.fn(() => (live ? gl : null))
    vi.stubGlobal('document', { createElement: () => ({ getContext }) })

    expect(probe()).toBe('webgl2')
    live = true
    expect(probe()).toBe(null)
    expect(probe()).toBe(null)

    expect(getContext).toHaveBeenCalledTimes(2) // the failure re-probed, the success was kept
  })
})
