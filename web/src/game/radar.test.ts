// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { describe, expect, it } from 'vitest'
import { Radar, NM, geometry, aspect_factor, detect_range, paint_probability, pick, WIDTHS } from './radar'

const wrap = (v: number) => v
const always = () => 0 // random() below every probability: every crossing paints
const never = () => 1

// A jet 15 nmi dead ahead of a north-facing ownship (heading 0, north = -z),
// co-altitude, crossing left-to-right (beam aspect).
const own = { x: 0, y: 3000, z: 0, heading: 0 }
const beam = { id: 7, x: 0, y: 3000, z: -15 * NM, vx: 250, vy: 0, vz: 0 }

function swept(radar: Radar, targets = [beam], seconds = 4, random = always) {
  for (let i = 0; i < seconds * 60; i++) radar.step(1 / 60, own, targets, wrap, random)
}

describe('geometry', () => {
  it('puts a target east of a north-facing jet at +90° azimuth', () => {
    const g = geometry(own, { x: 5 * NM, y: 3000, z: 0 }, wrap)
    expect(g.azimuth).toBeCloseTo(Math.PI / 2, 5)
    expect(g.range).toBeCloseTo(5 * NM, 0)
  })
  it('reads elevation off the horizontal', () => {
    const g = geometry(own, { x: 0, y: 3000 + 9260, z: -9260 }, wrap)
    expect(g.elevation).toBeCloseTo(Math.PI / 4, 3)
  })
})

describe('detection', () => {
  it('sees a beam target further than a nose-on one', () => {
    const nose = { ...beam, vx: 0, vz: 250 } // running straight at us
    expect(detect_range(own, beam, wrap)).toBeGreaterThan(detect_range(own, nose, wrap))
    expect(aspect_factor(own, nose, wrap)).toBeCloseTo(0.75, 2)
  })
  it('pays the look-down penalty only below own level', () => {
    const low = { ...beam, y: 500 }
    expect(detect_range(own, low, wrap)).toBeCloseTo(detect_range(own, beam, wrap) * 0.65, 0)
  })
  it('paints surely close in, marginally at the edge, never beyond', () => {
    expect(paint_probability(10 * NM, 40 * NM)).toBeCloseTo(0.97, 2)
    expect(paint_probability(39 * NM, 40 * NM)).toBeLessThan(0.25)
    expect(paint_probability(41 * NM, 40 * NM)).toBe(0)
  })
})

describe('search', () => {
  it('RWS paints a brick when the sweep crosses the target', () => {
    const radar = new Radar()
    swept(radar)
    expect(radar.bricks.length).toBeGreaterThan(0)
    expect(radar.bricks[0].id).toBe(7)
    expect(Math.abs(radar.bricks[0].azimuth)).toBeLessThan(0.05)
  })
  it('never paints outside the selected azimuth width', () => {
    const radar = new Radar()
    radar.width = 2 // ±20°
    const flanker = { ...beam, x: -12 * NM, z: -8 * NM } // ~56° left
    swept(radar, [flanker])
    expect(radar.bricks.length).toBe(0)
  })
  it('never paints outside the elevation band', () => {
    const radar = new Radar()
    const high = { ...beam, z: -5 * NM, y: 3000 + 5 * NM } // ~45° up
    swept(radar, [high])
    expect(radar.bricks.length).toBe(0)
  })
  it('slewing the band finds a high target the level scan cannot', () => {
    const high = { ...beam, z: -8 * NM, y: 3000 + 8 * NM * Math.tan(0.35) } // ~20° up at 8 nmi
    const radar = new Radar()
    swept(radar, [high])
    expect(radar.bricks.length).toBe(0) // invisible to the level band
    for (let i = 0; i < 4; i++) radar.slew(1) // +20°
    expect(radar.elevation).toBeCloseTo(0.349, 2)
    swept(radar, [high])
    expect(radar.bricks.length).toBeGreaterThan(0)
  })
  it('the slew respects the antenna gimbal', () => {
    const radar = new Radar()
    for (let i = 0; i < 40; i++) radar.slew(-1)
    expect(radar.elevation).toBeCloseTo(-1.047, 3)
    for (let i = 0; i < 80; i++) radar.slew(1)
    expect(radar.elevation).toBeCloseTo(1.047, 3)
  })
  it('a failed roll leaves nothing', () => {
    const radar = new Radar()
    swept(radar, [beam], 4, never)
    expect(radar.bricks.length).toBe(0)
  })
  it('one sweep crossing paints exactly one brick', () => {
    // ±20° at 75°/s: up 0→20 in 0.27 s, the down pass crosses the bore at
    // 0.53 s, the next up pass at 1.07 s. One crossing, one brick — the old
    // padded window let consecutive frames cluster duplicates.
    const radar = new Radar()
    radar.width = 2
    swept(radar, [beam], 0.9)
    expect(radar.bricks.length).toBe(1)
    swept(radar, [beam], 0.3)
    expect(radar.bricks.length).toBe(2)
  })
  it('a target never shows more than two paints — motion, not a formation', () => {
    const radar = new Radar()
    radar.width = 2 // fast passes: many crossings in the window
    swept(radar, [beam], 6)
    expect(radar.bricks.filter((b) => b.id === 7).length).toBe(2)
  })
  it('bricks age off the format', () => {
    const radar = new Radar()
    swept(radar, [beam], 2)
    const painted = radar.bricks.length
    expect(painted).toBeGreaterThan(0)
    swept(radar, [], 13)
    expect(radar.bricks.length).toBe(0)
  })
})

describe('TWS', () => {
  it('builds one trackfile per target and refreshes it', () => {
    const radar = new Radar()
    radar.mode = 'tws'
    swept(radar, [beam], 6)
    expect(radar.tracks.length).toBe(1)
    expect(radar.tracks[0].hits).toBeGreaterThan(1)
    expect(radar.tracks[0].vx).toBe(250)
  })
  it('caps the scan width — the volume trade is real', () => {
    const radar = new Radar()
    radar.mode = 'tws'
    radar.width = 0 // asks ±70°
    expect(radar.half()).toBe(WIDTHS[1]) // gets ±45°
  })
  it('stales a trackfile that stops painting, and the L&S dies with it', () => {
    const radar = new Radar()
    radar.mode = 'tws'
    swept(radar, [beam], 4)
    radar.designate(7)
    expect(radar.ls).toBe(7)
    swept(radar, [], 9)
    expect(radar.tracks.length).toBe(0)
    expect(radar.ls).toBe(null)
  })
})

// A HOT target: closing fast, radial velocity far above the clutter notch —
// the geometry where a tracker genuinely holds. The crossing `beam` target
// above sits IN the notch by definition, which since #31 puts an STT on it
// into MEMORY: the beam aspect is not a tracking geometry any more, which is
// the point of the whole doctrine.
const hot = { id: 7, x: 0, y: 3000, z: -15 * NM, vx: 0, vy: 0, vz: 250 }

describe('STT', () => {
  it('tracks a hot target continuously and paints nothing else', () => {
    const radar = new Radar()
    radar.designate(7) // RWS: straight to STT
    expect(radar.stt).toBe(7)
    const other = { ...hot, id: 9, x: 2 * NM }
    swept(radar, [hot, other], 3)
    expect(radar.tracks.find((t) => t.id === 7)?.hits).toBeGreaterThan(100)
    expect(radar.tracks.find((t) => t.id === 9)).toBeUndefined()
    expect(radar.bricks.length).toBe(0)
  })

  it('a beaming target coasts in MEMORY, then the lock drops (#31)', () => {
    const radar = new Radar()
    radar.designate(7)
    swept(radar, [beam], 2) // in the notch: no fresh data, the track coasts
    expect(radar.stt).toBe(7)
    expect(radar.memory).toBeGreaterThan(1)
    expect(radar.tracks.find((t) => t.id === 7)?.hits ?? 0).toBeLessThan(10)
    swept(radar, [beam], 3) // the memory window (4 s) expires
    expect(radar.stt).toBe(null)
  })

  it('a jammer outside burnthrough steals the gate; inside, the echo wins (#31)', () => {
    const radar = new Radar()
    radar.designate(7)
    const far = { ...hot, jamming: true } // 15 nmi: well outside 9 km burnthrough
    swept(radar, [far], 2)
    expect(radar.memory).toBeGreaterThan(1)
    swept(radar, [far], 3)
    expect(radar.stt).toBe(null)
    radar.designate(7)
    const near = { ...hot, z: -4000, jamming: true } // 4 km: burnt through
    swept(radar, [near], 2)
    expect(radar.stt).toBe(7)
    expect(radar.memory).toBe(0)
  })

  it('a radiating emitter draws a bearing-only strobe (#31)', () => {
    const radar = new Radar()
    radar.step(1 / 60, own, [{ ...beam, x: 5 * NM, jamming: true }], wrap, always)
    expect(radar.strobes.length).toBe(1)
    expect(radar.strobes[0]).toBeGreaterThan(0) // off to the right, bearing only
    radar.step(1 / 60, own, [beam], wrap, always)
    expect(radar.strobes.length).toBe(0)
  })
  it('breaks past the gimbal and returns to search', () => {
    const radar = new Radar()
    radar.designate(7)
    const behind = { ...beam, x: 0, z: 10 * NM } // dead six
    radar.step(1 / 60, own, [behind], wrap, always)
    expect(radar.stt).toBe(null)
  })
  it('breaks when the target disappears', () => {
    const radar = new Radar()
    radar.designate(7)
    radar.step(1 / 60, own, [], wrap, always)
    expect(radar.stt).toBe(null)
  })
})

describe('emission', () => {
  it('SIL breaks the lock, stops painting, and reports silent', () => {
    const radar = new Radar()
    radar.designate(7)
    expect(radar.emitter()).toBe(2)
    radar.sil = true
    radar.step(1 / 60, own, [beam], wrap, always)
    expect(radar.stt).toBe(null)
    expect(radar.emitter()).toBe(0)
    const bricks = radar.bricks.length
    swept(radar, [beam], 2)
    expect(radar.bricks.length).toBe(bricks) // frozen: nothing new
  })
  it('a silent radar refuses to designate', () => {
    const radar = new Radar()
    radar.sil = true
    expect(radar.designate(7)).toBe(false)
    expect(radar.stt).toBe(null)
  })
  it('searching reports 1', () => {
    expect(new Radar().emitter()).toBe(1)
  })
})

describe('ladder', () => {
  it('TWS: first designation is the L&S, the second commands STT', () => {
    const radar = new Radar()
    radar.mode = 'tws'
    radar.designate(7)
    expect(radar.ls).toBe(7)
    expect(radar.stt).toBe(null)
    radar.designate(7)
    expect(radar.stt).toBe(7)
  })
  it('undesignate steps down one rung at a time', () => {
    const radar = new Radar()
    radar.mode = 'tws'
    swept(radar, [beam], 4)
    radar.designate(7)
    radar.designate(7)
    radar.undesignate()
    expect(radar.stt).toBe(null)
    expect(radar.ls).toBe(7)
    radar.undesignate()
    expect(radar.ls).toBe(null)
  })
})

describe('pick', () => {
  it('snaps to the nearest candidate inside the capture radius', () => {
    const candidates = [
      { id: 1, azimuth: 0.1, range: 20 * NM },
      { id: 2, azimuth: -0.4, range: 30 * NM },
    ]
    expect(pick(candidates, 0.12, 21 * NM, WIDTHS[0], 40 * NM)).toBe(1)
  })
  it('captures nothing in empty space', () => {
    const candidates = [{ id: 1, azimuth: 0.9, range: 35 * NM }]
    expect(pick(candidates, -0.9, 5 * NM, WIDTHS[0], 40 * NM)).toBe(null)
  })
})
