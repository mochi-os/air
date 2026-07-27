// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { describe, expect, it } from 'vitest'
import { acmi, position, Recorder, MIDWAY, type Recorded } from './acmi'

const jet = (over: Partial<Recorded> = {}): Recorded => ({
  id: 1,
  x: 0,
  y: 500,
  z: 0,
  roll: 0,
  pitch: 0,
  yaw: 90,
  name: 'FA-18C',
  label: 'Viper',
  colour: 'Blue',
  kind: 'Air+FixedWing',
  ...over,
})

describe('position', () => {
  it('places the world origin at the map reference', () => {
    const p = position(0, 0)
    expect(p.latitude).toBeCloseTo(MIDWAY.latitude, 6)
    expect(p.longitude).toBeCloseTo(MIDWAY.longitude, 6)
  })

  it('moves north for -z and east for +x', () => {
    expect(position(0, -111320).latitude).toBeCloseTo(MIDWAY.latitude + 1, 3)
    expect(position(1000, 0).longitude).toBeGreaterThan(MIDWAY.longitude)
  })
})

describe('acmi', () => {
  it('writes a header TacView accepts', () => {
    const text = acmi([{ time: 0, objects: [jet()] }], new Date('2026-07-27T14:32:00Z'), 'Joust')
    const lines = text.split('\n')
    expect(lines[0]).toBe('FileType=text/acmi/tacview')
    expect(lines[1]).toBe('FileVersion=2.2')
    expect(text).toContain('0,ReferenceTime=2026-07-27T14:32:00Z')
  })

  it('declares object properties once, then only the transform', () => {
    const text = acmi(
      [
        { time: 0, objects: [jet()] },
        { time: 0.1, objects: [jet({ y: 510 })] },
      ],
      new Date('2026-07-27T14:32:00Z'),
      'Joust'
    )
    // The delta format is the whole point: repeating Name/Pilot every frame
    // multiplies file size for no information.
    expect(text.match(/Name=FA-18C/g)).toHaveLength(1)
    expect(text).toContain('#0.1')
  })

  it('re-declares when a property changes', () => {
    const text = acmi(
      [
        { time: 0, objects: [jet({ mode: 'press' })] },
        { time: 0.1, objects: [jet({ mode: 'defense' })] },
      ],
      new Date('2026-07-27T14:32:00Z'),
      'Joust'
    )
    expect(text).toContain('Doctrine=press')
    expect(text).toContain('Doctrine=defense')
  })

  it('omits the doctrine channel when absent (shipped builds)', () => {
    const text = acmi([{ time: 0, objects: [jet()] }], new Date(), 'Joust')
    expect(text).not.toContain('Doctrine=')
  })
})

describe('Recorder', () => {
  it('samples at the configured rate', () => {
    const r = new Recorder(600, 10)
    for (let i = 0; i < 100; i++) r.add(i * 0.01, [jet()]) // 100 Hz offered
    expect(r.length).toBeGreaterThan(8)
    expect(r.length).toBeLessThan(12) // ~10 Hz kept
  })

  it('drops samples older than the window, bounding memory', () => {
    const r = new Recorder(5, 10)
    for (let i = 0; i < 2000; i++) r.add(i * 0.1, [jet()])
    expect(r.length).toBeLessThanOrEqual(52) // 5 s at 10 Hz, plus the boundary
  })

  it('re-bases time so a rolled buffer starts at zero', () => {
    const r = new Recorder(5, 10)
    for (let i = 0; i < 200; i++) r.add(i * 0.1, [jet()])
    const text = r.render(new Date('2026-07-27T14:32:00Z'), 'Joust')
    expect(text).toContain('#0\n')
    expect(text).not.toContain('#19.9')
  })

  it('renders nothing when empty', () => {
    expect(new Recorder().render(new Date(), 'x')).toBe('')
  })
})
