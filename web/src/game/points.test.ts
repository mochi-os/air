// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Screen-space lights (#12): the meatball, its datum, cut and wave-off
// lights, the PAPI and the flood glare are drawn at a constant size on
// screen, which the GPU takes in drawing-buffer pixels. A fixed size was half
// as big on a 4K monitor as on 1080p and changed as dynamic resolution moved
// the render scale, so each keeps its share of the view instead.
const source = readFileSync(
  fileURLToPath(new URL('./engine.ts', import.meta.url)),
  'utf8'
)

interface Material {
  size: number
}
function points() {
  const block =
    /const POINT_HEIGHT=[^\n]*\nfunction screen_point\([^\n]*\nfunction screen_points_resize\([^\n]*\n/.exec(
      source
    )?.[0]
  if (!block) throw new Error('the screen point helpers not found in engine.ts')
  return new Function(
    'renderer',
    `${block} return { screen_point, screen_points_resize };`
  ) as (renderer: { domElement: { height: number } }) => {
    screen_point(material: Material, size: number): Material
    screen_points_resize(): void
  }
}

describe('screen-space lights', () => {
  it('take the size they were tuned at on a 1080p screen, scaled with the drawing buffer', () => {
    const renderer = { domElement: { height: 1620 } } // 1080p, supersampled 1.5x
    const { screen_point, screen_points_resize } = points()(renderer)
    const ball = screen_point({ size: 1 }, 11)
    const datum = screen_point({ size: 1 }, 7)
    expect([ball.size, datum.size]).toEqual([11, 7]) // the look it was tuned at
    renderer.domElement.height = 3240 // a 4K monitor at 100% scaling, supersampled
    screen_points_resize()
    expect([ball.size, datum.size]).toEqual([22, 14]) // the same share of the view
    renderer.domElement.height = 1620 * 0.45 // dynamic resolution at its floor
    screen_points_resize()
    expect(ball.size).toBeCloseTo(11 * 0.45, 9)
  })

  it('registers every constant-size point, and rescales them whenever the buffer is resized', () => {
    const constant =
      source.match(
        /new THREE\.PointsMaterial\(\{[^}]*sizeAttenuation:false[^}]*\}\)[^;]*/g
      ) ?? []
    expect(constant.length).toBeGreaterThanOrEqual(6)
    for (const site of constant)
      expect(site, site).toMatch(
        /^new THREE\.PointsMaterial\(\{[^}]*\}\),[\w*/ ]+\)/
      )
    for (const site of source.match(/[^\n]*sizeAttenuation:false[^\n]*/g) ?? [])
      expect(site, site).toMatch(/screen_point\(new THREE\.PointsMaterial\(/)
    expect(source).not.toMatch(/const pscale=/)
    expect(source).toMatch(
      /renderer\.setSize\(Math\.round\(w\*sc\),Math\.round\(h\*sc\),false\); screen_points_resize\(\);/
    )
  })
})
