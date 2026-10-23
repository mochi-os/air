// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Hysteresis, Pacing } from './pacing'

const BUDGET = 18 // ms: the governor lowers the scale past this mean

function fly(pacing: Pacing, lengths: number[], times = 1) {
  for (let k = 0; k < times; k++)
    for (const ms of lengths) pacing.record(ms / 1000)
}

describe('the frame record', () => {
  it('judges a backed-up GPU queue by its stalls, so the governor sees the overload', () => {
    // Measured on the Lunar Lake Arc: 4.4 ms frames broken by 260 ms stalls,
    // which the governor once read as a 7 ms mean.
    const pacing = new Pacing()
    fly(pacing, [...new Array(15).fill(4.4), 260], 12)
    expect(pacing.recent()!.mean).toBeGreaterThan(BUDGET)
    expect(1000 / pacing.readout().low).toBeLessThan(5)
  })

  it('reads the newest frames, not the slots at the end of the ring', () => {
    // Three seconds overloaded, then a second recovered: the ring's last slots
    // still hold the overload.
    const pacing = new Pacing()
    fly(pacing, [40], 180)
    fly(pacing, [8], 125)
    expect(pacing.recent()!.mean).toBeLessThan(BUDGET)
    expect(pacing.recent()!.spike).toBeLessThan(17.5)
  })

  it('dilutes a single shader-compile hitch across a second of frames', () => {
    const pacing = new Pacing()
    fly(pacing, [8], 180)
    fly(pacing, [400])
    fly(pacing, [8], 20)
    expect(pacing.recent()!.mean).toBeLessThan(BUDGET)
  })

  it('discards the settling second after a reset, so a compile frame and a resize are not judged as load', () => {
    const pacing = new Pacing()
    fly(pacing, [8], 180)
    pacing.reset()
    let judged = 0
    for (const ms of [817, 100, 67, ...new Array(260).fill(8)]) {
      pacing.record(ms / 1000)
      const recent = pacing.recent()
      if (recent) {
        judged++
        expect(recent.mean).toBeLessThan(BUDGET)
      }
    }
    expect(judged).toBeGreaterThan(100)
  })

  it('judges nothing until a full second has been recorded since the reset', () => {
    const pacing = new Pacing()
    fly(pacing, [8], 180)
    pacing.reset()
    fly(pacing, [8], 125 + 60)
    expect(pacing.recent()).toBeNull()
    fly(pacing, [8], 70)
    expect(pacing.recent()).not.toBeNull()
  })

  it('says it is settling for the second after a reset', () => {
    const pacing = new Pacing()
    expect(pacing.settling).toBe(false)
    fly(pacing, [8], 180)
    pacing.reset()
    expect(pacing.settling).toBe(true)
    fly(pacing, [8], 120)
    expect(pacing.settling).toBe(true)
    fly(pacing, [8], 6)
    expect(pacing.settling).toBe(false)
  })

  it('does not record a hidden or suspended page as a frame', () => {
    const pacing = new Pacing()
    fly(pacing, [8], 180)
    pacing.record(12)
    expect(pacing.recent()!.mean).toBeCloseTo(8, 6)
    expect(pacing.readout().average).toBeCloseTo(8, 6)
  })
})

describe('the hysteresis', () => {
  const judged = (hysteresis: Hysteresis, readouts: boolean[]) =>
    readouts.map((bad) => hysteresis.judge(bad))

  it('holds after its run of bad readouts and lets go after its run of clear ones', () => {
    const hysteresis = new Hysteresis(4, 12)
    expect(judged(hysteresis, [true, true, true])).toEqual([
      false,
      false,
      false,
    ])
    expect(hysteresis.judge(true)).toBe(true)
    expect(judged(hysteresis, new Array(11).fill(false))).toEqual(
      new Array(11).fill(true)
    )
    expect(hysteresis.judge(false)).toBe(false)
  })

  it('starts each run again when a readout breaks it', () => {
    const hysteresis = new Hysteresis(4, 12)
    expect(
      judged(hysteresis, [true, true, true, false, true, true, true])
    ).toEqual(new Array(7).fill(false))
    hysteresis.judge(true)
    expect(judged(hysteresis, [...new Array(11).fill(false), true])).toEqual(
      new Array(12).fill(true)
    )
    expect(judged(hysteresis, new Array(11).fill(false))).toEqual(
      new Array(11).fill(true)
    ) // the bad readout began the clear run again
  })

  it('lets go at once when reset', () => {
    const hysteresis = new Hysteresis(4, 12)
    judged(hysteresis, [true, true, true, true])
    hysteresis.reset()
    expect(hysteresis.held).toBe(false)
    expect(judged(hysteresis, [true, true, true])).toEqual([
      false,
      false,
      false,
    ])
  })
})

describe('the wiring', () => {
  const engine = readFileSync(
    fileURLToPath(new URL('./engine.ts', import.meta.url)),
    'utf8'
  )

  it('records each frame at its real length, not the simulation step clamped at 50 ms', () => {
    expect(engine).toMatch(
      /function frame\(\)\{ const wall=clock\.getDelta\(\); let dt=Math\.min\(wall,0\.05\);/
    )
    expect(engine).toMatch(/refresh_perf\(wall\); dynamic_res\(wall\);/)
    expect(engine).toMatch(
      /const judged=pacing\.recent\(\); if\(!judged\) return;/
    )
  })

  it('settles the record when a mission starts and whenever the canvas is resized', () => {
    expect(engine).toMatch(
      /if\(assets_ready\(\)\)\{ loading=false; pacing\.reset\(\);/
    )
    expect(engine).toMatch(
      /function apply_size\(\)\{[^\n]*\n\trenderer\.setSize\([^\n]*\); pacing\.reset\(\);/
    )
  })

  it('filters the sea detail at anisotropy 2, not the GPU maximum', () => {
    const detail = engine.slice(
      engine.indexOf('function build_water_detail'),
      engine.indexOf('const col_deep2')
    )
    expect(detail).toMatch(
      /tex\.anisotropy=Math\.min\(2,renderer\.capabilities\.getMaxAnisotropy\(\)\);/
    )
  })
})
