// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { describe, expect, it } from 'vitest'
import {
  acmi,
  position,
  Recorder,
  MIDWAY,
  type Recorded,
  type Sample,
  stamp,
  channels,
} from './acmi'

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
    const text = acmi(
      [{ time: 0, objects: [jet()] }],
      new Date('2026-07-27T14:32:00Z'),
      'Joust'
    )
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
      [
        {
          time: 0,
          objects: [
            jet({
              data: { aoa: 8.1, g: 1.02, tas: 220, ias: 205, mach: 0.64 },
            }),
          ],
        },
      ],
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
      [
        {
          time: 0,
          objects: [jet({ data: { stick: -0.42, stabilator: 3.75 } })],
        },
      ],
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

  // The bandit's gun on the same channel as mine, so a debrief can tell a
  // bandit that shot and missed from one that never fired.
  it("records each aircraft's rounds independently", () => {
    const text = acmi(
      [
        {
          time: 0,
          objects: [
            jet({ data: { rounds: 578 } }),
            jet({
              id: 2,
              label: 'Bandit',
              colour: 'Red',
              data: { rounds: 578 },
            }),
          ],
        },
        {
          time: 0.1,
          objects: [
            jet({ data: { rounds: 520 } }),
            jet({
              id: 2,
              label: 'Bandit',
              colour: 'Red',
              data: { rounds: 578 },
            }),
          ],
        },
        {
          time: 0.2,
          objects: [
            jet({ data: { rounds: 520 } }),
            jet({
              id: 2,
              label: 'Bandit',
              colour: 'Red',
              data: { rounds: 549 },
            }),
          ],
        },
      ],
      new Date('2026-08-05T00:00:00Z'),
      'debrief'
    )
    const mine = text.split('\n').filter((l) => l.startsWith('1,T='))
    const his = text.split('\n').filter((l) => l.startsWith('2,T='))
    expect(mine[1]).toContain('Rounds=520')
    expect(his[1]).not.toContain('Rounds=') // his counter held while mine moved: the suppression is per aircraft
    expect(his[2]).toContain('Rounds=549')
    expect(mine[2]).not.toContain('Rounds=')
  })
})

it('battle channels are delta-suppressed and the fate is written once', () => {
  const at = (time: number, struck: number, fate?: string): Sample => ({
    time,
    objects: [
      {
        id: 1,
        x: 0,
        y: 1000,
        z: 0,
        roll: 0,
        pitch: 0,
        yaw: 0,
        name: 'FA-18C',
        label: 'P',
        colour: 'Blue',
        kind: 'Air+FixedWing',
        data: { struck, burning: false, thrust: 0, ...(fate ? { fate } : {}) },
      },
    ],
  })
  const text = acmi(
    [at(0, 0), at(0.1, 0), at(0.2, 7), at(0.3, 7), at(0.4, 7, 'pilot')],
    new Date(0),
    't'
  )
  const struck = text.split('\n').filter((l) => l.includes('Struck='))
  expect(struck).toHaveLength(3) // 0, the step to 7, and the fate line (the channel group rewrites on any change)
  expect(struck[1]).toContain('Struck=7')
  expect(text.split('\n').filter((l) => l.includes('Fate=pilot'))).toHaveLength(
    1
  )
})

// #103: the whole-airframe element total and the wing loss the aero flies are
// different numbers. They used to be one channel, named Wing, carrying the
// total — so a recording could show heavy damage while saying nothing about
// whether the wing the flight model reads was touched, and the 2026-09-06
// joust could not be attributed from its recording alone.
it('records the structural total and the wing loss as separate channels', () => {
  const at = (time: number, structure: number, wing: number): Sample => ({
    time,
    objects: [
      {
        id: 2,
        x: 0,
        y: 1000,
        z: 0,
        roll: 0,
        pitch: 0,
        yaw: 0,
        name: 'FA-18C',
        label: 'Bandit',
        colour: 'Red',
        kind: 'Air+FixedWing',
        data: { struck: 0, structure, wing },
      },
    ],
  })
  const lines = acmi(
    [at(0, 0, 0), at(0.1, 8.71, 0), at(0.2, 9.21, 0.6)],
    new Date(0),
    't'
  ).split('\n')
  expect(lines.filter((l) => l.includes('Structure=8.71'))).toHaveLength(1)
  expect(lines.filter((l) => l.includes('Structure=9.21'))).toHaveLength(1)
  expect(lines.filter((l) => l.includes('Wing=0.6'))).toHaveLength(1)
  // The heavily-damaged sample with an untouched wing must say so: that is the
  // distinction one channel could not express.
  const wounded = lines.find((l) => l.includes('Structure=8.71'))
  expect(wounded).toContain('Wing=0')
  expect(wounded).not.toContain('Wing=8.71')
})

// Missiles are their own objects and the ownship carries the HUD's cue and
// its stores count (#33 debrief). Before this a fight won with six 9Ms
// recorded two structural wounds on the bandit and nothing else, and the
// debrief called them self-inflicted.
it('records a missile as its own object with seeker, closest approach, and a once-written fate', () => {
  const jet = (missiles: number, cue: string): Sample['objects'][number] => ({
    id: 1,
    x: 0,
    y: 1000,
    z: 0,
    roll: 0,
    pitch: 0,
    yaw: 0,
    name: 'FA-18C',
    label: 'P',
    colour: 'Blue',
    kind: 'Air+FixedWing',
    data: { missiles, cue },
  })
  const round = (
    seeker: string,
    least: number,
    fate?: string
  ): Sample['objects'][number] => ({
    id: 164,
    x: 50,
    y: 1000,
    z: -200,
    roll: 0,
    pitch: 2,
    yaw: 355,
    name: 'AIM-9M',
    label: '9M',
    colour: 'Blue',
    kind: 'Weapon+Missile',
    round: {
      shooter: 1,
      target: 2,
      seeker,
      least,
      ...(fate
        ? {
            fate,
            killed: true,
            burst: 6.24,
            closure: 641,
            when: 0.38,
            off: { ahead: 3.1, above: -2.0, right: 4.9 },
          }
        : {}),
    },
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
  expect(mine[0]).toContain('Cue=') // the empty cue is written once so a reader knows the channel exists
  expect(mine[1]).toContain('Cue=9m')
  expect(mine[2]).toContain('Missiles=5') // the launch is a stores step, like a gun burst is a Rounds step
  expect(mine[2]).not.toContain('Cue=') // unchanged cue: suppressed
  expect(mine[3]).toContain('Cue=') // the cue dropped: written
  const shots = lines.filter((l) => l.startsWith('a4,T=')) // 164 in hex
  expect(shots).toHaveLength(3)
  expect(shots[0]).toContain('Type=Weapon+Missile')
  expect(shots[0]).toContain('Parent=1')
  expect(shots[0]).toContain('LockedTarget=2')
  expect(shots[0]).toContain('Seeker=track')
  expect(shots[1]).toContain('Seeker=lure')
  expect(shots[1]).not.toContain('Parent=') // identity written once
  expect(shots[2]).toContain('Fate=fuse')
  expect(shots[2]).toContain('Killed=1')
  expect(shots[2]).toContain('Least=12')
  // The burst record (#58): the fuse's CONTINUOUS miss, closure, exact time,
  // and the body-frame miss vector — written once, with the fate.
  expect(shots[2]).toContain('Burst=6.2')
  expect(shots[2]).toContain('Closure=641')
  expect(shots[2]).toContain('When=0.38')
  expect(shots[2]).toContain('Off=3.1|-2|4.9')
  expect(lines.filter((l) => l.includes('Fate=fuse'))).toHaveLength(1)
  expect(lines.filter((l) => l.includes('Burst='))).toHaveLength(1)
})

// The bot's tier rides on its own object, so a debrief judges its plays in
// context without decoding the mission title (which named the tier only for
// jousts). Declared once, like the other identity properties.
it("writes a bot's skill tier once, on the object", () => {
  const bandit = (): Sample['objects'][number] => ({
    id: 2,
    x: 0,
    y: 1000,
    z: 0,
    roll: 0,
    pitch: 0,
    yaw: 0,
    name: 'FA-18C',
    label: 'Bandit',
    colour: 'Red',
    kind: 'Air+FixedWing',
    skill: 'ace',
  })
  const text = acmi(
    [
      { time: 0, objects: [bandit()] },
      { time: 0.1, objects: [bandit()] },
    ],
    new Date(0),
    't'
  )
  const lines = text.split('\n').filter((l) => l.startsWith('2,T='))
  expect(lines[0]).toContain('Skill=ace')
  expect(lines[1]).not.toContain('Skill=')
})

// The wider channel set (#33 debrief, 2026-08-15): countermeasures, the hand
// on the throttle, the sensor picture, and the match block in the header.
it('records flares, throttle, the sensor picture, and the match rules', () => {
  const jet = (
    flares: number,
    radar: string,
    lock: number | undefined,
    target: number | undefined
  ): Sample['objects'][number] => ({
    id: 1,
    x: 0,
    y: 1000,
    z: 0,
    roll: 0,
    pitch: 0,
    yaw: 0,
    name: 'FA-18C',
    label: 'P',
    colour: 'Blue',
    kind: 'Air+FixedWing',
    data: {
      flares,
      chaff: flares - 20,
      throttle: 0.85,
      burner: 0.4,
      radar,
      ...(lock !== undefined ? { lock } : {}),
      rwrlock: false,
      rwrmissile: lock !== undefined,
      jammer: false,
      ...(target !== undefined ? { target } : {}),
    },
  })
  const text = acmi(
    [
      { time: 0, objects: [jet(40, 'rws', undefined, undefined)] },
      { time: 0.1, objects: [jet(40, 'rws', undefined, undefined)] },
      { time: 0.2, objects: [jet(39, 'stt', 2, 2)] },
      { time: 0.3, objects: [jet(39, 'stt', 2, 2)] },
    ],
    new Date(0),
    't',
    {
      task: 'joust',
      bandit: 'ace',
      weapons: 'fox2',
      cheats: 'invulnerable',
      empty: '',
    }
  )
  const lines = text.split('\n')
  expect(lines.filter((l) => l.startsWith('0,Match_'))).toEqual([
    '0,Match_task=joust',
    '0,Match_bandit=ace',
    '0,Match_weapons=fox2',
    '0,Match_cheats=invulnerable',
  ])
  const mine = lines.filter((l) => l.startsWith('1,T='))
  expect(mine[0]).toContain('Flares=40')
  expect(mine[0]).toContain('Chaff=20') // its own magazine, its own channel (#43)
  expect(mine[0]).toContain('Throttle=0.85')
  expect(mine[0]).toContain('Afterburner=0.4')
  expect(mine[0]).toContain('Radar=rws')
  expect(mine[0]).toContain('RwrMissile=0')
  expect(mine[1]).not.toContain('Flares=') // held: suppressed
  expect(mine[1]).not.toContain('Chaff=')
  expect(mine[1]).not.toContain('Radar=') // sensor group unchanged: suppressed
  expect(mine[1]).toContain('Throttle=0.85') // throttle is written every sample
  expect(mine[2]).toContain('Flares=39') // the dispense is a step
  expect(mine[2]).toContain('Chaff=19')
  expect(mine[2]).toContain('Radar=stt')
  expect(mine[2]).toContain('Lock=2')
  expect(mine[2]).toContain('Target=2')
  expect(mine[2]).toContain('RwrMissile=1')
  expect(mine[3]).not.toContain('Radar=')
})

// Afterburner is the name the format defines; a Mochi-only Reheat reads as
// stone cold to every other ACMI tool.
it('records the burner as the standard Afterburner property, never Reheat', () => {
  const bandit = (burner: number): Sample['objects'][number] => ({
    id: 2,
    x: 0,
    y: 1000,
    z: 0,
    roll: 0,
    pitch: 0,
    yaw: 0,
    name: 'FA-18C',
    label: 'Bandit',
    colour: 'Red',
    kind: 'Air+FixedWing',
    data: { burner, spool: 1 },
  })
  const text = acmi(
    [
      { time: 0, objects: [bandit(0.99)] },
      { time: 0.1, objects: [bandit(0)] },
    ],
    new Date(0),
    't'
  )
  const lines = text.split('\n').filter((l) => l.startsWith('2,T='))
  expect(lines[0]).toContain('Afterburner=0.99')
  expect(lines[1]).toContain('Afterburner=0') // written every sample, like the ownship's
  expect(text).not.toContain('Reheat=')
  expect(lines[0]).toContain('Spool=1') // a deliberate Mochi extension, and not a duplicate of the burner
})

// A comma separates ACMI properties and a newline separates records, so an
// unescaped value writes structure rather than text. The world server's clean()
// already drops every rune below 32, so a newline cannot survive the join path -
// but the comma does, and a multiplayer pilot's label reaches the object line
// straight off the wire (engine.ts add(st, 10+slot, st.name || net.names.get(slot))).
describe('field escaping', () => {
  const emit = (over: Partial<Recorded>, title = 'Fight') =>
    acmi(
      [{ time: 0, objects: [jet(over)] }],
      new Date('2026-01-01T00:00:00Z'),
      title
    )

  // The object's property record: `1,T=<transform>,Name=...,Pilot=...`. Parsed
  // into properties rather than searched as text - an escaped comma leaves the
  // injected `Type=Ground+Static` visible INSIDE the pilot's name, which is the
  // intended outcome, so a substring search would report a defect that is a fix.
  const properties = (text: string) => {
    const line = text.split('\n').find((l) => l.startsWith('1,T=')) ?? ''
    const found = new Map<string, string[]>()
    for (const pair of line.split(',').slice(2)) {
      const at = pair.indexOf('=')
      const key = pair.slice(0, at)
      found.set(key, [...(found.get(key) ?? []), pair.slice(at + 1)])
    }
    return found
  }

  it('keeps an injected property out of a pilot name', () => {
    const found = properties(emit({ label: 'x,Type=Ground+Static,Color=Red' }))
    // One Type and one Color, each the recorder's own value. Unescaped, the
    // name supplied a second of each - and they land BEFORE the legitimate
    // pair, so a last-wins parser reports the object as it really is while an
    // ordinary one reads a ground target.
    expect(found.get('Type')).toEqual(['Air+FixedWing'])
    expect(found.get('Color')).toEqual(['Blue'])
    // The text survives where it belongs: inside the pilot's name.
    expect(found.get('Pilot')).toEqual(['x Type=Ground+Static Color=Red'])
  })

  it('emits one record, not two, for a name carrying a newline', () => {
    // Unreachable through the join path - clean() drops every rune below 32 -
    // but the recorder must not rest on a guarantee made in another repo.
    const text = emit({ label: 'x\n1,T=0|0|0|0|0|0,Name=Ghost' })
    expect(text.split('\n').filter((l) => l.startsWith('1,T='))).toHaveLength(1)
    expect(properties(text).get('Pilot')).toEqual([
      'x 1 T=0|0|0|0|0|0 Name=Ghost',
    ])
  })

  it('escapes every recorded string field, not only the wire-fed one', () => {
    // The enums are safe today because they are enums. Routing them anyway is
    // the point: "escape the untrusted ones" is the rule that left nine of
    // eleven sites raw.
    for (const over of [
      { label: 'a,b' },
      { name: 'a,b' },
      { kind: 'a,b' },
      { mode: 'a,b' },
      { skill: 'a,b' },
    ] as Partial<Recorded>[]) {
      const line =
        emit(over)
          .split('\n')
          .find((l) => l.startsWith('1,T=')) ?? ''
      expect(line).not.toContain('a,b')
      expect(line).toContain('a b')
    }
  })

  it('escapes the header fields too', () => {
    const text = emit({}, 'Joust,Category=Naval')
    expect(text.split('\n').find((l) => l.startsWith('0,Title='))).toBe(
      '0,Title=Joust Category=Naval'
    )
  })
})

describe('stamp', () => {
  // Everything a fight is, minus what each case is about.
  const fight = {
    multiplayer: false,
    mode: 'joust',
    duel: 'bvr',
    bandit: 'superhuman',
    weapons: 'fox2',
    start: 'air',
    clouds: 'none',
    tod: 'day',
    world: 'https://mochi-os.org:4433',
    callsign: 'Little Nellie',
    cheats: { invulnerable: false, fuel: true },
    effects: 2,
    version: 41,
    stick: 'Turtle Beach VelocityOne Flightstick (10f5:7013)',
    mapping: '',
    axes: 10,
    buttons: 24,
    unreachable: '',
  }

  // #152: a degraded stick flies on its good axes while its hat and trigger
  // send nothing. Recorded, "was the stick healthy?" is a grep rather than a
  // debrief and a code audit - and it survives the replug that fixes the
  // stick and erases the evidence.
  it('records the device the sortie was flown on', () => {
    const { match } = stamp(fight)
    expect(match.stick).toContain('VelocityOne')
    expect(match.axes).toBe('10')
    expect(match.buttons).toBe('24')
    expect(match.mapping).toBe('direct') // no browser remap
    expect(match.unreachable).toBe('')
  })

  it('names the browser remap when there is one', () => {
    expect(stamp({ ...fight, mapping: 'standard' }).match.mapping).toBe(
      'standard',
    )
  })

  it('carries the bindings the device cannot reach', () => {
    const { match } = stamp({ ...fight, axes: 4, buttons: 17, unreachable: 'fire,weapon' })
    expect(match.unreachable).toBe('fire,weapon')
    expect(match.axes).toBe('4')
  })

  // A keyboard flight has no device, and a row of zeroes would read as a pad
  // reporting nothing at all. acmi() drops empty values, so these vanish.
  it('writes nothing about a device when there is none', () => {
    const { match } = stamp({ ...fight, stick: '', axes: 0, buttons: 0 })
    expect(match.stick).toBe('')
    expect(match.mapping).toBe('')
    expect(match.axes).toBe('')
    expect(match.buttons).toBe('')
  })

  it('names a single-player joust by the bandit it was flown against', () => {
    const { kind, match } = stamp(fight)
    expect(kind).toBe('joust-superhuman')
    expect(match.task).toBe('joust')
    expect(match.duel).toBe('bvr')
    expect(match.bandit).toBe('superhuman')
    expect(match.multiplayer).toBe(0)
    expect(match.world).toBe('') // a single-player flight has no server, whatever the menu last held
  })

  it('names a multiplayer match by the mode the SERVER says it is', () => {
    // The engine forces cfg.task="joust" for every multiplayer session and
    // cfg.duel/cfg.bandit are the player's last single-player settings, so
    // this used to record a furball against a person as "joust-ace" (#171).
    const { kind, match } = stamp({
      ...fight,
      multiplayer: true,
      mode: 'furball',
      weapons: 'guns',
    })
    expect(kind).toBe('furball')
    expect(match.task).toBe('furball')
    expect(match.multiplayer).toBe(1)
    expect(match.world).toBe('https://mochi-os.org:4433')
  })

  it('claims no bandit and no duel shape in a multiplayer match — there is neither', () => {
    const { match } = stamp({ ...fight, multiplayer: true, mode: 'furball' })
    expect(match.bandit).toBe('') // acmi() omits an empty field, so the header carries no Match_bandit at all
    expect(match.duel).toBe('')
  })

  it('carries the multiplayer weapons rule, which the header used to leave blank', () => {
    expect(
      stamp({ ...fight, multiplayer: true, mode: 'furball', weapons: 'guns' })
        .match.weapons
    ).toBe('guns')
    expect(
      stamp({ ...fight, multiplayer: true, mode: 'teams', weapons: 'open' })
        .match.weapons
    ).toBe('open')
  })

  it('keeps a multiplayer joust a joust, and still names no bandit', () => {
    const { kind, match } = stamp({
      ...fight,
      multiplayer: true,
      mode: 'joust',
    })
    expect(kind).toBe('joust')
    expect(match.task).toBe('joust')
    expect(match.bandit).toBe('')
  })

  it('falls back to a furball when the welcome named no mode', () => {
    expect(stamp({ ...fight, multiplayer: true, mode: '' }).kind).toBe(
      'furball'
    )
  })

  it('records only the cheats that were ON', () => {
    expect(stamp(fight).match.cheats).toBe('fuel')
    expect(stamp({ ...fight, cheats: undefined }).match.cheats).toBe('')
  })

  it('writes a free flight as a flight, with no duel and no bandit', () => {
    const { kind, match } = stamp({ ...fight, mode: 'free' })
    expect(kind).toBe('flight')
    expect(match.task).toBe('free')
    expect(match.duel).toBe('')
    expect(match.bandit).toBe('')
  })
})

describe('a multiplayer remote is recorded, not just tracked (#163/#164)', () => {
  // In the first human-versus-human match the opponent emptied all 578 rounds
  // and put rounds into the player, and the recording carried neither: a
  // remote was written as position and attitude alone, so the debrief reported
  // "no Rounds channel - cannot tell whether it fired" and "rounds taken 0"
  // for a pilot who had been hit.
  it('carries what he shot and what landed on him', () => {
    const out = channels({ spent: 578, struck: 14, speed: 240 })
    expect(out.rounds).toBe(578)
    expect(out.struck).toBe(14)
  })

  it('carries his true airspeed, so it need not be derived from position', () => {
    // #161: a track with no TAS is finite-differenced, and its extremes are
    // fiction - 2,812 kt over frames whose recorded truth never passed 656.
    const out = channels({ speed: 243.7 })
    expect(out.tas).toBeCloseTo(243.7, 3)
  })

  it('reports an unfired, unhurt jet as zero rather than omitting the channels', () => {
    // An absent channel and a zero are different claims: a debrief must be
    // able to say "he did not shoot", not merely "I cannot tell".
    const out = channels({})
    expect(out.rounds).toBe(0)
    expect(out.struck).toBe(0)
    expect(out.burning).toBe(false)
    expect(out.leak).toBe(0)
  })

  it('reads burning off either engine fire, as the ownship does', () => {
    expect(channels({ burn: [0, 0.4] }).burning).toBe(true)
    expect(channels({ burning: true }).burning).toBe(true)
    expect(channels({ burn: [0, 0] }).burning).toBe(false)
  })

  it('names his radar mode from the emitter byte', () => {
    expect(channels({}, { mode: 0, target: -1 }).radar).toBe('sil')
    expect(channels({}, { mode: 1, target: -1 }).radar).toBe('rws')
    expect(channels({}, { mode: 2, target: 3 }).radar).toBe('stt')
    expect(channels({}).radar).toBe('sil') // no emitter report is silence, not a guess
  })

  it('records his lock only when it is on us', () => {
    // The emitter byte names one slot. Recording his lock on a third party
    // would be a claim about a fight this client cannot see.
    expect(channels({}, { mode: 2, target: 3 }, 3).lock).toBe(1)
    expect(channels({}, { mode: 2, target: 5 }, 3).lock).toBeUndefined()
    expect(channels({}, { mode: 2, target: 3 }).lock).toBeUndefined()
  })

  it('is written through the recorder onto his own object line', () => {
    // End to end: the mapping reaches the file as the delta-suppressed battle
    // block, on the remote's object, not the ownship's.
    const text = acmi(
      [
        {
          time: 0,
          objects: [
            jet({
              id: 11,
              label: 'Chris',
              data: channels({ spent: 120, struck: 3, speed: 250 }),
            }),
          ],
        },
        {
          time: 0.1,
          objects: [
            jet({
              id: 11,
              label: 'Chris',
              data: channels({ spent: 245, struck: 3, speed: 251 }),
            }),
          ],
        },
      ],
      new Date(0),
      'Mochi Air: furball'
    )
    expect(text).toContain('Rounds=120')
    expect(text).toContain('Rounds=245') // the step IS the burst
    expect(text).toContain('Struck=3')
    expect(text).toMatch(/TAS=25[01]/)
  })
})
