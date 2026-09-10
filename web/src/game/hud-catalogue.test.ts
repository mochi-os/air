// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// GameCanvas.tsx cannot be imported here — it pulls in Lingui macros, which the
// test environment has no babel plugin for — so both sides are read as text.
// That is enough: the invariant is about two lists agreeing.
const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

const catalogue = () => {
  const source = read('../components/GameCanvas.tsx')
  const block = source.slice(source.indexOf('const HUD_MESSAGES'))
  const keys = new Set<string>()
  const entry =
    /^\s+(?:([A-Za-z_][A-Za-z0-9_]*)|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*:\s*msg`/gm
  for (const found of block.slice(0, block.indexOf('\n}\n')).matchAll(entry)) {
    keys.add((found[1] ?? found[2] ?? found[3]).replace(/\\(.)/g, '$1'))
  }
  return keys
}

const translated = () => {
  const source = read('./engine.ts')
  const keys = new Set<string>()
  for (const found of source.matchAll(
    /translate\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g
  )) {
    keys.add(found[1].replace(/\\(.)/g, '$1'))
  }
  for (const found of source.matchAll(
    /translate\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g
  )) {
    keys.add(found[1].replace(/\\(.)/g, '$1'))
  }
  return keys
}

// The deck code words, kept English on purpose and documented as such beside
// the catalogue. This list is the ONLY licensed gap.
const VERBATIM = ['AUTO', 'BALL', 'CLARA', 'HORNET']

describe('HUD_MESSAGES', () => {
  it('carries every string the engine asks it to translate', () => {
    // translate() returns its input on a miss, so a gap here is silent: the
    // string renders in English beside its translated neighbours, which is how
    // PARK, PROBE, CANOPY and WINGS shipped untranslated next to GEAR and HOOK
    // in the same corner stack (#109).
    const have = catalogue()
    const missing = [...translated()]
      .filter((key) => !have.has(key) && !VERBATIM.includes(key))
      .sort()
    expect(missing).toEqual([])
  })

  it('keeps the deck code words out, and only those', () => {
    // The other half of the rule (#110). A string meant to read English belongs
    // OUT of translate(), not out of the catalogue — a catalogue miss is
    // indistinguishable from an oversight, which is exactly what a comment here
    // once asserted about the annunciators while all four sat in the catalogue,
    // translated.
    const have = catalogue()
    expect(VERBATIM.filter((key) => have.has(key))).toEqual([])
    const asked = translated()
    expect(VERBATIM.filter((key) => !asked.has(key))).toEqual([])
  })
})
