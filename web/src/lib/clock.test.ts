// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { clock } from './clock'

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

describe('clock', () => {
  it('reads m:ss under an hour', () => {
    expect(clock(0)).toBe('0:00')
    expect(clock(59)).toBe('0:59')
    expect(clock(61)).toBe('1:01')
    expect(clock(3599)).toBe('59:59')
  })

  it('reads h:mm:ss from an hour, so ninety minutes is 1:30:00, not 90:00', () => {
    expect(clock(3600)).toBe('1:00:00')
    expect(clock(5400)).toBe('1:30:00')
    expect(clock(36005)).toBe('10:00:05')
  })

  it('counts whole seconds elapsed: 59.9 s has not reached the minute', () => {
    expect(clock(59.9)).toBe('0:59')
    expect(clock(3599.5)).toBe('59:59')
  })

  it('reads nothing below zero or unreadable as zero', () => {
    expect(clock(-5)).toBe('0:00')
    expect(clock(Number.NaN)).toBe('0:00')
  })
})

// The three places that show a duration had drifted apart: the log wrote
// hours, the replay bar and the mission-over line minutes only.
describe('every duration goes through it', () => {
  it('the flight log keeps no clock of its own', () => {
    const log = read('../components/MatchLog.tsx')
    expect(log).toMatch(/import \{ clock \} from '\.\.\/lib\/clock'/)
    expect(log).not.toMatch(/const clock\s*=/)
  })

  it('the replay bar and the mission-over line keep none either', () => {
    const canvas = read('../components/GameCanvas.tsx')
    expect(canvas).toMatch(/import \{ clock \} from '\.\.\/lib\/clock'/)
    expect(canvas).not.toMatch(/function clock\(/)
    expect(canvas).toMatch(
      /\{clock\(timeline\.clock\)\} \/ \{clock\(timeline\.duration\)\}/
    )
    expect(canvas).toMatch(/\{clock\(over\.seconds\)\}/)
  })
})
