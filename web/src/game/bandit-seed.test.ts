// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

// engine.ts cannot be imported (WebGL at module scope): bandit_seed is cut out
// of its source and run on its own, as blast.test.ts's lift() does.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
function lift(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  expect(start, `${name} in engine.ts`).toBeGreaterThan(0)
  const rest = source.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  return end ? rest.slice(0, end.index + 1) : rest
}

function seeded(replay: number): () => number {
  return new Function('demonstration_seed', `${lift('bandit_seed')}\nreturn bandit_seed`)(replay)
}

describe('the single-player bandit is seeded per mission', () => {
  it('draws a fresh seed each mission, never zero', () => {
    const draw = vi.spyOn(Math, 'random').mockReturnValueOnce(0.25).mockReturnValueOnce(0.75).mockReturnValueOnce(0)
    const bandit_seed = seeded(0)
    const first = bandit_seed(), second = bandit_seed(), lowest = bandit_seed()
    draw.mockRestore()
    expect(first).not.toEqual(second)
    expect(lowest).toBeGreaterThan(0)
  })

  it('replays the developer seed when one is given', () => {
    expect(seeded(42)()).toBe(42)
  })

  it('is what the bandit brain is armed with, not a constant', () => {
    expect(source).toMatch(/bandit_init\(\{[^}]*seed: bandit_seed\(\)/)
    expect(source).not.toMatch(/bandit_init\(\{[^}]*seed: \d/)
  })
})
