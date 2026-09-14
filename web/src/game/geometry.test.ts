// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { describe, expect, it } from 'vitest'

import { geometry_canonical, geometry_hash } from './geometry'

describe('canonical geometry', () => {
  it('sorts keys, drops undefined, rounds to the millimetre and never writes -0', () => {
    expect(geometry_canonical({ b: 1, a: [{ z: 2.00049, x: 1 }], u: undefined })).toBe('{"a":[{"x":1,"z":2}],"b":1}')
    expect(geometry_canonical({ x: -0.0001, y: 1.0005 })).toBe('{"x":0,"y":1.001}')
    expect(geometry_canonical([[1, 2], [3]])).toBe('[[1,2],[3]]')
    expect(geometry_canonical({ name: 'a"b', flag: true, none: null })).toBe('{"flag":true,"name":"a\\"b","none":null}')
  })

  it('is a fixed point: canonical of the parsed canonical is itself', () => {
    const text = geometry_canonical({ sea: 3, fields: [{ height: 3.5, coast: [{ x: 1.23456, z: -0.5 }] }], prisms: [] })
    expect(geometry_canonical(JSON.parse(text))).toBe(text)
  })

  it('hashes with SHA-256, hex', async () => {
    expect(await geometry_hash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
