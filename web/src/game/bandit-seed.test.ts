// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { PRESETS, amraams, normalize, rounds } from './stores'

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

// The bandit is drawn, counted and racked on the fit its brain carries: the
// server's bots_loadout of the class bandit_init names. The BVR bandit flew the
// AMRAAMs and was drawn with six heaters on twin rails.
describe('the single-player bandit carries the fit its brain flies', () => {
  const fits = new Function(
    'stores_normalize',
    'stores_presets',
    `${source.slice(source.indexOf('const BOT_ARMED='), source.indexOf('let loadout_rev'))}\nreturn { BOT_ARMED, BOT_CLEAN, BOT_OPEN }`
  )(normalize, PRESETS)
  function fit(duel: string, missiles: boolean) {
    return new Function(
      'cfg',
      'missiles_on',
      'BOT_ARMED',
      'BOT_CLEAN',
      'BOT_OPEN',
      `${lift('bandit_fit')}\nreturn bandit_fit()`
    )({ duel }, () => missiles, fits.BOT_ARMED, fits.BOT_CLEAN, fits.BOT_OPEN)
  }

  it('flies the Fox 3 preset beyond visual range, tank included', () => {
    expect(fit('bvr', true)).toEqual(normalize(PRESETS.fox3))
    expect(fit('bvr', false)).toEqual(normalize(PRESETS.fox3))
    expect(amraams(fit('bvr', true))).toHaveLength(6)
  })

  it('flies the twin-rail heaters or the gun within visual range', () => {
    expect(rounds(fit('wvr', true))).toHaveLength(6)
    expect(amraams(fit('wvr', true))).toHaveLength(0)
    expect(rounds(fit('wvr', false))).toHaveLength(0)
  })

  it('names the class the same way bandit_init does', () => {
    expect(source).toMatch(/weapons: cfg\.duel==="bvr"\?"open":\(missiles_on\(\)\?"fox2":"guns"\)/)
    expect(source).toMatch(/assign_loadout\(bandit, bandit_fit\(\)\)/)
  })
})
