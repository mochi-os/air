// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { describe, it, expect } from 'vitest'
import { surface, inside, type Building, type Post, type Island } from './impact'

const SEA = -1e9 // open water reports no terrain surface

const hut: Building = { minx: -10, maxx: 10, minz: -10, maxz: 10, topY: 12, pts: [[-10, -10], [10, -10], [10, 10], [-10, 10]] }
const mast: Post = { x: 100, z: 0, r: 1, y1: 20 }
const carrier: Island = { x: 500, z: 500, deck: 20, height: () => 45 }

describe('surface', () => {
  it('says nothing while the aircraft is still flying', () => {
    expect(surface({ x: 0, y: 3000, z: 0 }, SEA, [], [])).toBe('')
    expect(surface({ x: 0, y: 3000, z: 0 }, 10, [hut], [mast], carrier)).toBe('')
  })

  // The whole point of the task: these two were both recorded as "fire".
  it('tells the sea from the ground', () => {
    expect(surface({ x: 0, y: 2, z: 0 }, SEA, [], [])).toBe('sea')
    expect(surface({ x: 0, y: 41, z: 0 }, 40, [], [])).toBe('ground')
  })

  it('does not call open water a crash until the aircraft is down in it', () => {
    expect(surface({ x: 0, y: 7, z: 0 }, SEA, [], [])).toBe('')
    expect(surface({ x: 0, y: 6, z: 0 }, SEA, [], [])).toBe('sea')
  })

  it('names a building, and only inside its footprint', () => {
    expect(surface({ x: 0, y: 8, z: 0 }, SEA, [hut], [])).toBe('building')
    expect(surface({ x: 50, y: 8, z: 0 }, SEA, [hut], [])).toBe('')   // clear of it
    expect(surface({ x: 0, y: 30, z: 0 }, SEA, [hut], [])).toBe('')   // over the roof
  })

  it('names an obstacle within its radius and below its height', () => {
    expect(surface({ x: 100, y: 10, z: 0 }, SEA, [], [mast])).toBe('post')
    expect(surface({ x: 100, y: 30, z: 0 }, SEA, [], [mast])).toBe('')   // above it
    expect(surface({ x: 120, y: 10, z: 0 }, SEA, [], [mast])).toBe('')   // clear of it
  })

  it('names the carrier island only above the deck', () => {
    expect(surface({ x: 500, y: 40, z: 500 }, SEA, [], [], carrier)).toBe('island')
    expect(surface({ x: 500, y: 50, z: 500 }, SEA, [], [], carrier)).toBe('')      // over the top of it
    expect(surface({ x: 900, y: 40, z: 500 }, SEA, [], [], carrier)).toBe('')      // not alongside
    // A flat deck is a landing surface, not an obstacle: with the structure no
    // taller than the deck there is nothing here to hit.
    expect(surface({ x: 500, y: 21, z: 500 }, SEA, [], [], { ...carrier, height: () => 22 })).toBe('')
  })

  // Terrain wins: an aircraft in the ground inside a building's footprint hit
  // the ground, which is what a debrief should say.
  it('reports the surface it reached first', () => {
    expect(surface({ x: 0, y: 41, z: 0 }, 40, [{ ...hut, topY: 60 }], [])).toBe('ground')
  })
})

describe('inside', () => {
  const square: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]]
  it('separates in from out', () => {
    expect(inside(5, 5, square)).toBe(true)
    expect(inside(15, 5, square)).toBe(false)
    expect(inside(5, 15, square)).toBe(false)
    expect(inside(-5, 5, square)).toBe(false)
  })
  it('handles a concave footprint, where a bounding box would lie', () => {
    const ell: [number, number][] = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]]
    expect(inside(2, 2, ell)).toBe(true)
    expect(inside(8, 8, ell)).toBe(false)   // in the box, outside the L
  })
})
