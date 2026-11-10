// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { finish, once, SHEEN, textures, type Source } from './model'

function material(name: string): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ metalness: 0.5, roughness: 0.4 })
  m.name = name
  return m
}

describe('finish', () => {
  it('lays paint matte', () => {
    const m = material('paint')
    finish(m)
    expect([m.metalness, m.roughness]).toEqual([0, 0.88])
  })

  it("keeps the sheen the missiles' bare metal is built with", () => {
    for (const name of SHEEN) {
      const m = material(name)
      finish(m)
      expect([m.metalness, m.roughness], name).toEqual([0.5, 0.4])
    }
  })

  it('leaves glass as it is', () => {
    const m = material('glass')
    finish(m)
    expect([m.metalness, m.roughness]).toEqual([0.5, 0.4])
  })
})

// A model whose materials share one image, as the missiles' atlas is shared
// by every one of their materials, and one with its own.
function shared() {
  return {
    json: {
      images: [
        { bufferView: 0, mimeType: 'image/png' },
        { bufferView: 1, mimeType: 'image/png' },
      ],
      textures: [{ source: 0 }, { source: 0 }, { source: 1 }],
      bufferViews: [
        { byteOffset: 0, byteLength: 4 },
        { byteOffset: 4, byteLength: 4 },
      ],
      materials: [
        {
          name: 'paint',
          pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
        },
        {
          name: 'metal',
          pbrMetallicRoughness: { baseColorTexture: { index: 1 } },
        },
        {
          name: 'glass',
          pbrMetallicRoughness: { baseColorTexture: { index: 2 } },
        },
      ],
    },
    bin: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
  }
}

describe('textures', () => {
  it('gives materials sharing an image the one source', () => {
    const captured = textures(shared())
    expect(captured.paint.base).toBe(captured.metal.base)
    expect(captured.glass.base).not.toBe(captured.paint.base)
    expect(Array.from(captured.glass.base!.bytes)).toEqual([5, 6, 7, 8])
  })
})

describe('once', () => {
  it('decodes each image once, however many materials name it', async () => {
    const captured = textures(shared())
    const seen: Source[] = []
    const decoding = once(async (source: Source) => {
      seen.push(source)
      return seen.length
    })
    const paint = await decoding(captured.paint.base!)
    const metal = await decoding(captured.metal.base!)
    const glass = await decoding(captured.glass.base!)
    expect(seen).toHaveLength(2)
    expect(metal).toBe(paint)
    expect(glass).not.toBe(paint)
  })
})
