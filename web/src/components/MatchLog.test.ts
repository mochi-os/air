// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
const source = read('./MatchLog.tsx')

// One of the log's label functions, from its declaration to its closing brace.
function labeller(name: string): string {
  const found = new RegExp(
    `const ${name} = \\(\\w+: string\\): string => \\{[\\s\\S]*?\\n  \\}\\n`
  ).exec(source)
  expect(found, `${name} in MatchLog.tsx`).toBeTruthy()
  return found![0]
}

describe('the flight log labels', () => {
  // world/server: session_close(s, ...) in tick.go and session.go, broadcast
  // as the end message's reason and recorded by the engine unchanged.
  it('labels every end reason the world server sends', () => {
    const reasons = labeller('reasonLabel')
    for (const reason of ['finished', 'withdrawn', 'idle', 'shutdown', 'fault'])
      expect(reasons, `no label for ${reason}`).toMatch(
        new RegExp(`\\n\\s*${reason}: t[\`(]`)
      )
  })

  it('never shows a raw mode or end reason: an unknown one reads as a translated word', () => {
    for (const name of ['modeLabel', 'reasonLabel']) {
      const body = labeller(name)
      const fallback = /return labels\[\w+\] \?\? ([^\n]*)\n/.exec(body)
      expect(fallback, `${name}'s fallback`).toBeTruthy()
      expect(fallback![1], `${name} falls back to the raw value`).toMatch(
        /^t\(\{ message: '[^']+', context: '[^']+' \}\)$/
      )
    }
  })

  it('names the free-for-all Open, in the sense the lobby gives it', () => {
    const lobby = /<Trans context='([^']+)'>Open<\/Trans>/.exec(
      read('./Multiplayer.tsx')
    )
    expect(lobby, "the lobby's Open").toBeTruthy()
    expect(labeller('modeLabel')).toMatch(
      new RegExp(
        `furball: t\\(\\{ message: 'Open', context: '${lobby![1]}' \\}\\)`
      )
    )
    expect(source).not.toMatch(/Furball/)
  })

  it('marks a developer-mode flight as it marks a cheated one', () => {
    expect(source).toMatch(
      /\{m\.developer \? \(\s*<span\s+role='img'\s+aria-label=\{t`Developer mode`\}\s+title=\{t`Developer mode`\}/
    )
  })
})
