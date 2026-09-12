// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The bottom-left legend is one column read as one thing: the stores counters
// at the bottom and the caution stack packed upward above them. Every step in
// it must be the same, and the step between the two halves is the one that was
// wrong — the cautions began 12 px above GUN where everything else steps 18,
// so the last caution crowded the first counter (#186). engine.ts reaches for
// WebGL at module scope and cannot be imported, so it is read as text, as
// hud-catalogue.test.ts does.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')

const pitch = () => {
  const found = source.match(/const STACK_PITCH=(\d+)/)
  return found ? Number(found[1]) : null
}

// The stores counters, in the order they are drawn: each names its own offset
// from the bottom of the HUD.
const counters = () => {
  const rows: { label: string; offset: number }[] = []
  // The first draw of each counter at the left margin. Matched by line rather
  // than by one regex over the call: GUN reads translate('GUN') and 9M is a
  // bare literal, and 120C shares 9M's row at x=150 so it is not one of these.
  const lines = source.split('\n').filter((line) => line.includes(',40,HH-'))
  for (const label of ['GUN', '9M', 'FLARES', 'CHAFF', 'FUEL']) {
    const line = lines.find((at) => at.includes(`"${label}`) || at.includes(`translate("${label}")`))
    const found = line?.match(/,40,HH-(\d+)\)/)
    if (found) rows.push({ label, offset: Number(found[1]) })
  }
  return rows
}

describe('the bottom-left legend steps evenly', () => {
  it('states its pitch once', () => {
    expect(pitch()).toBeGreaterThan(0)
  })

  it('finds every stores counter', () => {
    expect(counters().map((c) => c.label)).toEqual(['GUN', '9M', 'FLARES', 'CHAFF', 'FUEL'])
  })

  it('steps one pitch between counters', () => {
    const rows = counters()
    const steps = rows.slice(1).map((row, at) => rows[at].offset - row.offset)
    expect(steps).toEqual(steps.map(() => pitch()))
  })

  it('starts the caution stack one pitch above the top counter', () => {
    const top = counters()[0]
    // Written as an expression against the same counter and the same constant,
    // so the two cannot drift apart the way the hard-coded pair did.
    expect(source).toContain(`hud_stack.left=stack_draw(rows,40,HH-${top.offset}-STACK_PITCH)`)
  })
})
