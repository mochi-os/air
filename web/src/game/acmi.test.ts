// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { describe, expect, it } from 'vitest'
import { acmi, position, Recorder, MIDWAY, type Recorded, type Sample } from './acmi'

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

  it('writes the standard flight-data properties TacView graphs', () => {
    const text = acmi(
      [{ time: 0, objects: [jet({ data: { aoa: 8.1, g: 1.02, tas: 220, ias: 205, mach: 0.64 } })] }],
      new Date('2026-07-27T14:32:00Z'),
      'Joust'
    )
    expect(text).toContain('AOA=8.1')
    expect(text).toContain('G=1.02')
    expect(text).toContain('TAS=220')
    expect(text).toContain('IAS=205')
    expect(text).toContain('Mach=0.64')
  })

  it('repeats flight data every sample — it is not identity, it changes', () => {
    const text = acmi(
      [
        { time: 0, objects: [jet({ data: { aoa: 8.1 } })] },
        { time: 0.1, objects: [jet({ data: { aoa: 9.4 } })] },
      ],
      new Date('2026-07-27T14:32:00Z'),
      'Joust'
    )
    expect(text).toContain('AOA=8.1')
    expect(text).toContain('AOA=9.4')
  })

  it('carries the control-law channels when a developer build supplies them', () => {
    const text = acmi(
      [{ time: 0, objects: [jet({ data: { stick: -0.42, stabilator: 3.75 } })] }],
      new Date(),
      'Joust'
    )
    expect(text).toContain('Stick=-0.42')
    expect(text).toContain('Stabilator=3.75')
  })

  it('omits flight data entirely when none is supplied', () => {
    const text = acmi([{ time: 0, objects: [jet()] }], new Date(), 'Joust')
    expect(text).not.toContain('AOA=')
    expect(text).not.toContain('Stick=')
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

  it('keeps the WHOLE flight by default — a debrief wants the takeoff too', () => {
    const r = new Recorder()
    for (let i = 0; i < 2000; i++) r.add(i * 0.2, [jet()]) // 400 s of flight
    expect(r.length).toBe(2000) // nothing discarded, however long the sortie runs
  })

  it('drops samples older than the window when one is set', () => {
    const r = new Recorder(5, 10)
    for (let i = 0; i < 2000; i++) r.add(i * 0.1, [jet()])
    expect(r.length).toBeLessThanOrEqual(52) // 5 s at 10 Hz, plus the boundary
  })

  it('re-bases time so a rolled buffer starts at zero', () => {
    const r = new Recorder(5, 10) // an explicit window, so the buffer rolls
    for (let i = 0; i < 200; i++) r.add(i * 0.1, [jet()])
    const text = r.render(new Date('2026-07-27T14:32:00Z'), 'Joust')
    expect(text).toContain('#0\n')
    expect(text).not.toContain('#19.9')
  })

  it('renders nothing when empty', () => {
    expect(new Recorder().render(new Date(), 'x')).toBe('')
  })
  it('carries fuel every sample and rounds only when they change', () => {
    const text = acmi(
      [
        { time: 0, objects: [jet({ data: { fuel: 4900, rounds: 578 } })] },
        { time: 0.1, objects: [jet({ data: { fuel: 4880.4, rounds: 578 } })] },
        { time: 0.2, objects: [jet({ data: { fuel: 4860, rounds: 520 } })] },
      ],
      new Date('2026-07-29T00:00:00Z'),
      'debrief'
    )
    const lines = text.split('\n').filter((l) => l.startsWith('1,T='))
    expect(lines).toHaveLength(3)
    // FuelWeight is the standard ACMI name, so TacView plots it unaided.
    expect(lines[0]).toContain('FuelWeight=4900')
    expect(lines[1]).toContain('FuelWeight=4880.4')
    expect(lines[2]).toContain('FuelWeight=4860')
    // Rounds hold still for whole minutes: written on change, not every sample.
    expect(lines[0]).toContain('Rounds=578')
    expect(lines[1]).not.toContain('Rounds=')
    expect(lines[2]).toContain('Rounds=520')
  })

  // The BANDIT's gun on the same channel as mine. Without it a debrief cannot
  // tell a bandit that shot and missed from one that never fired: both look
  // identical from the ownship, which is exactly the question the 2026-08-05
  // superhuman post-mortem could not answer from the recording alone.
  it('records each aircraft\'s rounds independently', () => {
    const text = acmi(
      [
        { time: 0, objects: [jet({ data: { rounds: 578 } }), jet({ id: 2, label: 'Bandit', colour: 'Red', data: { rounds: 578 } })] },
        { time: 0.1, objects: [jet({ data: { rounds: 520 } }), jet({ id: 2, label: 'Bandit', colour: 'Red', data: { rounds: 578 } })] },
        { time: 0.2, objects: [jet({ data: { rounds: 520 } }), jet({ id: 2, label: 'Bandit', colour: 'Red', data: { rounds: 549 } })] },
      ],
      new Date('2026-08-05T00:00:00Z'),
      'debrief'
    )
    const mine = text.split('\n').filter((l) => l.startsWith('1,T='))
    const his = text.split('\n').filter((l) => l.startsWith('2,T='))
    expect(mine[1]).toContain('Rounds=520')
    expect(his[1]).not.toContain('Rounds=')   // his counter held while mine moved: the suppression is per aircraft
    expect(his[2]).toContain('Rounds=549')
    expect(mine[2]).not.toContain('Rounds=')
  })

})

it('battle channels are delta-suppressed and the fate is written once', () => {
  const at = (time: number, struck: number, fate?: string): Sample => ({
    time,
    objects: [
      {
        id: 1, x: 0, y: 1000, z: 0, roll: 0, pitch: 0, yaw: 0,
        name: 'FA-18C', label: 'P', colour: 'Blue', kind: 'Air+FixedWing',
        data: { struck, burning: false, thrust: 0, ...(fate ? { fate } : {}) },
      },
    ],
  })
  const text = acmi([at(0, 0), at(0.1, 0), at(0.2, 7), at(0.3, 7), at(0.4, 7, 'pilot')], new Date(0), 't')
  const struck = text.split('\n').filter((l) => l.includes('Struck='))
  expect(struck).toHaveLength(3) // 0, the step to 7, and the fate line (the channel group rewrites on any change)
  expect(struck[1]).toContain('Struck=7')
  expect(text.split('\n').filter((l) => l.includes('Fate=pilot'))).toHaveLength(1)
})

// Missiles are their own objects and the ownship carries the HUD's cue and
// its stores count (#33 debrief). Before this a fight won with six 9Ms
// recorded two structural wounds on the bandit and nothing else, and the
// debrief called them self-inflicted.
it('records a missile as its own object with seeker, closest approach, and a once-written fate', () => {
  const jet = (missiles: number, cue: string): Sample['objects'][number] => ({
    id: 1, x: 0, y: 1000, z: 0, roll: 0, pitch: 0, yaw: 0,
    name: 'FA-18C', label: 'P', colour: 'Blue', kind: 'Air+FixedWing', data: { missiles, cue },
  })
  const round = (seeker: string, least: number, fate?: string): Sample['objects'][number] => ({
    id: 164, x: 50, y: 1000, z: -200, roll: 0, pitch: 2, yaw: 355,
    name: 'AIM-9M', label: '9M', colour: 'Blue', kind: 'Weapon+Missile',
    round: { shooter: 1, target: 2, seeker, least, ...(fate ? { fate, killed: true } : {}) },
  })
  const text = acmi(
    [
      { time: 0, objects: [jet(6, '')] },
      { time: 0.1, objects: [jet(6, '9m')] },
      { time: 0.2, objects: [jet(5, '9m'), round('track', 900)] },
      { time: 0.3, objects: [jet(5, ''), round('lure', 400)] },
      { time: 0.4, objects: [jet(5, ''), round('track', 12, 'fuse')] },
    ],
    new Date(0),
    't'
  )
  const lines = text.split('\n')
  const mine = lines.filter((l) => l.startsWith('1,T='))
  expect(mine[0]).toContain('Missiles=6')
  expect(mine[0]).toContain('Cue=')          // the empty cue is written once so a reader knows the channel exists
  expect(mine[1]).toContain('Cue=9m')
  expect(mine[2]).toContain('Missiles=5')    // the launch is a stores step, like a gun burst is a Rounds step
  expect(mine[2]).not.toContain('Cue=')      // unchanged cue: suppressed
  expect(mine[3]).toContain('Cue=')          // the cue dropped: written
  const shots = lines.filter((l) => l.startsWith('a4,T='))   // 164 in hex
  expect(shots).toHaveLength(3)
  expect(shots[0]).toContain('Type=Weapon+Missile')
  expect(shots[0]).toContain('Parent=1')
  expect(shots[0]).toContain('LockedTarget=2')
  expect(shots[0]).toContain('Seeker=track')
  expect(shots[1]).toContain('Seeker=lure')
  expect(shots[1]).not.toContain('Parent=')  // identity written once
  expect(shots[2]).toContain('Fate=fuse')
  expect(shots[2]).toContain('Killed=1')
  expect(shots[2]).toContain('Least=12')
  expect(lines.filter((l) => l.includes('Fate=fuse'))).toHaveLength(1)
})
