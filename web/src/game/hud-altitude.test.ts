// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The altitude box and what stacks on it. The vertical velocity sits one line
// above the box, right-justified so its last digit lands on the altitude's
// last digit, in the standard digit size (Chuck's guide p.339, the JHMCS
// repeat of the HUD symbology: 5110 over 6880), and only in NAV and the
// landing configuration (NATOPS 2.13.4.8 item 12). engine.ts reaches for
// WebGL at module scope and cannot be imported, so it is read as text.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')

const altitude = /hctx\.fillText\(String\(shown\),(lx\+\d+),wly\+16\)/.exec(source)
const tail = /hctx\.fillText\(restStr,(lx\+\d+),wly\+17\)/.exec(source)
const vertical = /\n\tif\((.+?)\)\{ hctx\.font="(\d+)px 'Hornet Display', monospace"; hctx\.textAlign="(\w+)";[^\n]*\n\t\thctx\.fillText\(\(vs<0\?"-":""\)\+Math\.abs\(Math\.round\(vs\/10\)\*10\),(lx\+\d+),(wly-\d+)\);/.exec(source)

describe('the vertical velocity over the altitude box', () => {
  it('is right-justified on the altitude digits, one line above the box, in the standard size', () => {
    expect(altitude?.[1]).toBe('lx+88')
    expect(tail?.[1]).toBe('lx+88')
    expect(vertical?.[3]).toBe('right')
    expect(vertical?.[4]).toBe('lx+88')
    expect(vertical?.[5]).toBe('wly-12')
    expect(Number(vertical?.[2])).toBe(13)
  })

  it('shows in NAV and the landing configuration only', () => {
    expect(vertical?.[1]).toBe('master==="nav"||pa')
  })
})
