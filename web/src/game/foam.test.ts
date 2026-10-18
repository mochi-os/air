// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PATTERN_FRAGMENT } from './foam'

const engine = readFileSync(
  fileURLToPath(new URL('./engine.ts', import.meta.url)),
  'utf8'
)

describe('the foam pattern', () => {
  it('tiles seamlessly: every lattice wraps on its period', () => {
    expect(PATTERN_FRAGMENT).toMatch(/cell=mod\(cell,period\);/)
    expect(PATTERN_FRAGMENT).toMatch(/vec2 cell=mod\(ip\+o,span\);/)
    expect(engine).toMatch(
      /wrapS:THREE\.RepeatWrapping, wrapT:THREE\.RepeatWrapping/
    )
  })
})

describe('the foam on the sea', () => {
  it('shows the pattern by its cover where a pixel resolves the lace, and the soft cover beyond', () => {
    expect(engine).toMatch(
      /float mask=mix\(clamp\(foam,0\.0,0\.85\),min\(lace,0\.97\),resolved\);/
    )
    expect(engine).toMatch(
      /float lace=smoothstep\(0\.02,0\.6,cover\)\*mix\(1\.0,0\.3\+0\.9\*pattern,0\.6\);/
    )
  })

  it('keeps the amount the soft cover had', () => {
    expect(engine).toMatch(/u_foam_gain:\{value:2\.2\}/)
    expect(engine).toMatch(
      /float cover=clamp\(max\(spill,max\(broad\*breaks,0\.5\*trail\*carried\)\*fade\*0\.9\)\*u_foam_gain,0\.0,1\.0\)/
    )
  })

  it('is lit by the sun and by the hour', () => {
    expect(engine).toMatch(/\*\(0\.62\+0\.38\*max\(dot\(N,L\),0\.0\)\);/)
    expect(engine).toMatch(
      /vec3 tint=mix\(vec3\(0\.92,0\.96,1\.0\),lit,resolved\);[\s\S]*col=mix\(col,tint\*shade\*u_light,mask\);/
    )
  })
})
