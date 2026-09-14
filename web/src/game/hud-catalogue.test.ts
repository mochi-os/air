// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { setupI18n } from '@lingui/core'
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
    /^\s+(?:([A-Za-z_][A-Za-z0-9_]*)|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*:\s*msg(?:`|\(\{)/gm
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
  // The coaching lines: hint() translates the HINT constant whole, so each is a
  // catalogue key too. JSON.parse reads the JS escapes (\u00b0) as the engine does.
  for (const found of hints(source)) keys.add(found[1])
  return keys
}

// The HINT table as (key, line) pairs.
const hints = (source: string) => {
  const block = source.slice(source.indexOf('const HINT={'))
  return [...block.slice(0, block.indexOf('\n};')).matchAll(/^\s+(\w+):"((?:[^"\\]|\\.)*)"/gm)]
    .map((found) => [found[1], JSON.parse('"' + found[2] + '"')] as const)
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

  it('renders every coaching line through Lingui with its figures filled', () => {
    // The lines carry apostrophes (800') beside ICU placeholders ({heading}),
    // and ICU treats an apostrophe as a quote in some positions; every line is
    // rendered the way the game renders it, and must come back with the figure
    // in and nothing else changed.
    const i18n = setupI18n({ locale: 'en', messages: { en: {} } })
    const values = { heading: '069°', power: 'military power', side: 'right' }
    for (const [key, line] of hints(read('./engine.ts'))) {
      const shown = i18n._({ id: line, message: line, values })
      const wanted = line.replace(/\{(\w+)\}/g, (_: string, name: string) => values[name as keyof typeof values])
      expect(shown, key).toBe(wanted)
    }
  })

  it('fits every coaching line in the slot without breaking at its label', () => {
    // hint() packs the "; " parts of a line into 78-character rows, and a part
    // that is longer than a row is cut at the last ": " - the label colon, which
    // leaves "Case III:" alone on a row with the line under it. The English is
    // written to fit, with the widest live figures in.
    const values = { heading: '069°', power: 'full afterburner', side: 'right' }
    for (const [key, line] of hints(read('./engine.ts'))) {
      const filled = line.replace(/\{(\w+)\}/g, (_: string, name: string) => values[name as keyof typeof values])
      for (const part of filled.split('; ')) expect(part.length, `${key}: ${part}`).toBeLessThanOrEqual(78)
    }
  })
})
