// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { audio_flyby, flyby_shape, flyby_voice, passed } from './audio'

// A round that misses used to open on a 12 ms white transient, which is an
// impulsive crack, which is what a warhead sounds like. A pilot reported
// hearing a missile detonate beside them about a pair that passed at 43 and
// 48 m and never armed, in a fight where nothing fused at all. These assert
// the two halves of that fix: a pass has no attack, and it sweeps.
const RATE = 48000

const sounded = (distance: number) => {
  const log: string[] = []
  ;(globalThis as unknown as { dev_sounds: string[] }).dev_sounds = log
  audio_flyby(distance, true, 0, 0, 0)
  return log
}

const shaped = () => {
  const data = new Float32Array(Math.ceil(RATE * 1.1))
  flyby_shape(data, RATE)
  return data
}

const crossings = (data: Float32Array, from: number, to: number) => {
  let count = 0
  for (let i = from + 1; i < to; i++)
    if (data[i] >= 0 !== data[i - 1] >= 0) count++
  return count / (to - from)
}

const loudest = (data: Float32Array, from: number, to: number) => {
  let peak = 0
  for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(data[i]))
  return peak
}

describe('a round that misses does not sound like one that fused', () => {
  beforeEach(() => {
    delete (globalThis as unknown as { dev_sounds?: string[] }).dev_sounds
  })

  it('has no impulsive attack', () => {
    // The whole defect: the cue must not begin with a crack. The first 12 ms
    // is where the old transient lived, at a gain higher than anything that
    // followed it.
    const data = shaped()
    const opening = loudest(data, 0, Math.floor(RATE * 0.012))
    const whole = loudest(data, 0, data.length)
    expect(opening).toBeLessThan(whole * 0.25)
  })

  it('swells to its loudest at the pass rather than at the start', () => {
    const data = shaped()
    let at = 0
    let peak = 0
    for (let i = 0; i < data.length; i++)
      if (Math.abs(data[i]) > peak) {
        peak = Math.abs(data[i])
        at = i / data.length
      }
    expect(at).toBeGreaterThan(0.1)
    expect(at).toBeLessThan(0.55)
  })

  it('sweeps down through the pass', () => {
    // Doppler is the point: the approach is bright and the departure is dark.
    // Zero-crossing rate is indifferent to the envelope, so this measures the
    // sweep and not the swell.
    const data = shaped()
    const approach = crossings(data, 0, Math.floor(data.length * 0.25))
    const departure = crossings(
      data,
      Math.floor(data.length * 0.75),
      data.length
    )
    expect(approach).toBeGreaterThan(departure * 2)
  })

  it('stays inside the buffer', () => {
    const data = shaped()
    expect(loudest(data, 0, data.length)).toBeLessThanOrEqual(1)
  })

  it('asks for the pass, never the blast', () => {
    // audio.ts logs only the NAME, which is exactly what could not tell these
    // two apart in the cockpit. It can at least tell them apart here.
    expect(sounded(43)).toEqual(['flyby'])
  })

  it('is heard out to the reach it declares and no further', () => {
    expect(sounded(199)).toEqual(['flyby'])
    expect(sounded(201)).toEqual([])
    expect(flyby_voice(201, true)).toBeNull()
  })

  it('gets louder and brighter the closer it passes', () => {
    const near = flyby_voice(20, true)
    const middle = flyby_voice(80, true)
    const far = flyby_voice(180, true)
    expect(near!.volume).toBeGreaterThan(middle!.volume)
    expect(middle!.volume).toBeGreaterThan(far!.volume)
    expect(near!.cutoff).toBeGreaterThan(middle!.cutoff)
    expect(middle!.cutoff).toBeGreaterThan(far!.cutoff)
  })

  it('registers as a near miss at the range the recording caught', () => {
    // 43 m, the pair the pilot heard. It should be unmistakably loud, and it
    // was not before: the cue played at 0.89 there.
    const voice = flyby_voice(43, true)
    expect(voice!.volume).toBeGreaterThan(1.0)
  })

  it('carries a burning motor louder than a coasting one', () => {
    expect(flyby_voice(43, true)!.volume).toBeGreaterThan(
      flyby_voice(43, false)!.volume
    )
  })

  it('never reaches the brightness that sharpened it into a crack', () => {
    // The old cue drove the play-time lowpass to 9.9 kHz close in. The sweep
    // in the buffer carries the character now, so this stays gentle whatever
    // the range.
    for (const distance of [0, 10, 43, 100, 199])
      expect(flyby_voice(distance, true)!.cutoff).toBeLessThan(8000)
  })
})

// A jet tearing past: the range read at each look, the pass sounded the moment
// it opens after closing inside 180 m at a real speed between the two jets.
describe('a close pass by another jet', () => {
  // head on at 500 m/s relative, abeam by lateral metres, looked at every step seconds
  const pass = (
    lateral: number,
    step: number,
    speed = (t: number, r: number) => (500 * -500 * t) / r
  ) => {
    // by default the closure along the line between them, negative once opening
    const p = {}
    for (let t = -2 + 0.3 * step; t < 2; t += step) {
      const r = Math.hypot(-500 * t, lateral),
        heard = passed(p, r, speed(t, r), 100 + t)
      if (heard !== null) return Math.round(heard)
    }
    return null
  }
  const relative = () => 500
  it('sounds every pass inside 180 m, looked at every world step', () => {
    for (const lateral of [5, 40, 120, 170])
      for (const step of [1 / 60, 1 / 15])
        expect(
          pass(lateral, step, relative),
          `${lateral} m at ${step}`
        ).not.toBeNull()
    expect(pass(200, 1 / 60, relative)).toBeNull() // wide of it
  })
  it("judges a pass on the two jets' relative speed: the closure between them falls through zero at the closest point", () => {
    expect([5, 40, 120, 170].map((lateral) => pass(lateral, 1 / 60))).toEqual([
      null,
      null,
      null,
      null,
    ]) // on the closure the old judgement used, no pass was ever heard: it is negative on the look that opens
    const p = {}
    for (const r of [60, 40, 41]) expect(passed(p, r, 30, 0)).toBeNull() // formation, 30 m/s apart: no roar
  })
  it('misses the pass between looks a frame apart at 64x, so the engine looks every world step', () => {
    expect(
      [5, 40, 120].map((lateral) => pass(lateral, 64 / 60, relative))
    ).toEqual([null, null, null])
    const engine = readFileSync(
      fileURLToPath(new URL('./engine.ts', import.meta.url)),
      'utf8'
    )
    const bandit =
      /\n\t\tif\(has_enemy&&bandit\.group\.visible\)\{[^\n]*\n[^\n]*\n[^\n]*\n\t\t\taudio_pass\("bandit", range, Math\.hypot\(bandit\.velx-ownship\.velx,bandit\.vely-ownship\.vely,bandit\.velz-ownship\.velz\),[^\n]*\n\t\t\tif\(presenting\) audio_remote\("bandit"/
    expect(engine).toMatch(bandit) // judged every world step, voiced once a frame
    const audio = readFileSync(
      fileURLToPath(new URL('./audio.ts', import.meta.url)),
      'utf8'
    )
    const voice = audio.slice(
      audio.indexOf('export function audio_remote('),
      audio.indexOf('export function audio_remote_drop(')
    )
    expect(voice).not.toMatch(/audio_pass|passed\(/) // the voice judges nothing: a second look, once a frame, would sound the pass again
  })
  it('sounds at most one pass in five seconds', () => {
    const p = {}
    for (const r of [60, 40, 41]) passed(p, r, 500, 0)
    expect([
      passed(p, 30, 500, 3),
      passed(p, 31, 500, 3.1),
      passed(p, 20, 500, 6),
      passed(p, 21, 500, 6.1),
    ]).toEqual([null, null, null, 20])
  })
})
