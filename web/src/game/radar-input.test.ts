// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Radar, geometry, pick, type Track } from './radar'

// A pilot's account of a fight ("I couldn't get a lock") could not be checked
// against the recording (#33 debrief): Enter and Backspace either land on the
// radar's lock state or they do not, and nothing said which, or when. This
// tests the wrappers that decide it - radar_designate/lock/undesignate and the
// acquire_press/undesignate_press handlers that call them - against a REAL
// Radar instance, so a wrapper that agreed with a wrong stand-in could not
// pass by coincidence.
//
// engine.ts cannot be imported (WebGL at module scope): the functions are read
// as text and run against the real Radar class, as acmi.test.ts's lift() does.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
function lift(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  expect(start, `${name} in engine.ts`).toBeGreaterThan(0)
  const rest = source.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  return end ? rest.slice(0, end.index + 1) : rest
}

type Rig = {
  RADAR: Radar
  press(): void
  undesignate(): void
  rdrUndesignate(): void
  rdrClick(azimuth: number, range: number): void
  events(): string[]
  clock(t: number): void
}

// track is a minimal TWS trackfile straight ahead of the ownship at `range`
// metres (the ownship sits at the origin facing -z, heading 0 - the engine's
// own convention, atan2(dx, -dz)).
const track = (id: string, range: number): Track => ({
  id,
  x: 0,
  y: 0,
  z: -range,
  vx: 0,
  vy: 0,
  vz: 0,
  at: 0,
  hits: 1,
})

// rig builds the stand-in engine: a real Radar, an ownship facing -z at the
// origin, and contacts() answering whatever a test supplies (a target at
// x,y,z; no velocity is needed - only acquire_acm's cone test reads position).
// rdrClick takes a target's azimuth/range directly and converts through the
// SAME rdr_x/rdr_y the DDI page draws with, rather than duplicating their
// magic numbers, so a page relayout cannot silently desync the test from what
// a click actually lands on.
function rig(contacts: { id: string; x: number; y: number; z: number }[] = []): Rig {
  const code = [
    lift('radar_own'),
    lift('radar_designate'),
    lift('radar_lock'),
    lift('radar_undesignate'),
    lift('acquire_press'),
    lift('undesignate_press'),
    lift('acquire_acm'),
    lift('rdr_x'),
    lift('rdr_y'),
    lift('rdr_press'),
    lift('rdr_face'),
  ].join('\n')
  const run = new Function(
    'Radar',
    'radar_geometry',
    'radar_pick',
    'contactList',
    `const THREE={MathUtils:{clamp:(v,a,b)=>Math.min(Math.max(v,a),b)}};
     const NM=1852;
     const RADAR=new Radar();
     const wrap_axis=(v)=>v;
     const MULTIPLAYER=false; let designated=-1;
     let radar_events=[];
     let sim_time=0;
     const radar_cursor={ azimuth:0, range:0 };
     const ownship={ pos:{x:0,y:0,z:0}, fwd:{x:0,y:0,z:-1}, up:{x:0,y:1,z:0}, right:{x:1,y:0,z:0}, gauges:{heading:0} };
     const contacts=()=>contactList;
     ${code}
     return { RADAR, press:acquire_press, undesignate:undesignate_press,
       rdrUndesignate:()=>rdr_press(10),
       rdrClick:(azimuth,range)=>rdr_face(rdr_x(azimuth,RADAR.half()),rdr_y(range,RADAR.scale*NM)),
       events:()=>radar_events, clock:(t)=>{ sim_time=t; } };`
  )
  return run(Radar, geometry, pick, contacts) as Rig
}

describe('acquire (Enter / the stick\'s acquire button)', () => {
  it('first press on a fresh TWS trackfile claims it as the L&S, not a lock', () => {
    const r = rig()
    r.RADAR.mode = 'tws'
    r.RADAR.tracks = [track('bandit', 20000)]
    r.clock(160.8)
    r.press()
    expect(r.RADAR.ls).toBe('bandit')
    expect(r.RADAR.stt).toBeNull()
    expect(r.events()).toEqual(['160.8|acquire|ls'])
  })

  it('a second press on the SAME L&S hardens it into a true lock (STT)', () => {
    const r = rig()
    r.RADAR.mode = 'tws'
    r.RADAR.tracks = [track('bandit', 20000)]
    r.clock(160.8)
    r.press()
    r.clock(161.8)
    r.press()
    expect(r.RADAR.stt).toBe('bandit')
    expect(r.events()).toEqual(['160.8|acquire|ls', '161.8|acquire|stt'])
  })

  it('a contact inside the boresight cone locks straight to STT (visual/uncage path)', () => {
    const r = rig([{ id: 'bandit', x: 0, y: 0, z: -5000 }])
    r.RADAR.mode = 'rws' // no TWS trackfile to climb: the only route left is the cone
    r.clock(5)
    r.press()
    expect(r.RADAR.stt).toBe('bandit')
    expect(r.events()).toEqual(['5.0|acquire|cone'])
  })

  it('a press that finds nothing to acquire, and holds nothing, lands on nothing: no event', () => {
    const r = rig() // empty scope, empty cone
    r.RADAR.mode = 'rws'
    r.clock(3)
    r.press()
    expect(r.RADAR.stt).toBeNull()
    expect(r.RADAR.ls).toBeNull()
    expect(r.events()).toEqual([])
  })

  // The real, surprising consequence of Enter always running the ACM flow
  // once RADAR.stt is set (#27/#30's own comment: "every other state runs the
  // ACM flow"): a press meant to reacquire, with the bandit outside the
  // boresight cone at that instant, drops the STT you already had. This is
  // existing engine behaviour, not something this change introduces - the
  // Input channel is what finally makes it visible in a debrief.
  it('pressing acquire again after STT, with the target outside the cone, drops the lock', () => {
    const r = rig() // empty cone: nothing in contacts()
    r.RADAR.mode = 'tws'
    r.RADAR.stt = 'bandit'
    r.RADAR.ls = 'bandit'
    r.clock(20)
    r.press()
    expect(r.RADAR.stt).toBeNull()
    expect(r.events()).toEqual(['20.0|acquire|lost'])
  })
})

describe("undesignate (Backspace / the stick's undesignate button)", () => {
  it('steps the L&S to the next trackfile in TWS with no lock held', () => {
    const r = rig()
    r.RADAR.mode = 'tws'
    r.RADAR.tracks = [track('near', 1000), track('far', 5000)]
    r.RADAR.ls = 'near'
    r.clock(7)
    r.undesignate()
    expect(r.RADAR.ls).toBe('far')
    expect(r.events()).toEqual(['7.0|undesignate|step'])
  })

  it('drops a hard lock back to search, labeled break', () => {
    const r = rig()
    r.RADAR.mode = 'tws'
    r.RADAR.tracks = [track('bandit', 1000)] // one track: the step branch does not apply
    r.RADAR.stt = 'bandit'
    r.RADAR.ls = 'bandit'
    r.clock(15)
    r.undesignate()
    expect(r.RADAR.stt).toBeNull()
    expect(r.events()).toEqual(['15.0|undesignate|break'])
  })

  it('drops a bare L&S to nothing, labeled clear', () => {
    const r = rig()
    r.RADAR.mode = 'tws'
    r.RADAR.tracks = [track('bandit', 1000)]
    r.RADAR.ls = 'bandit'
    r.clock(9)
    r.undesignate()
    expect(r.RADAR.ls).toBeNull()
    expect(r.events()).toEqual(['9.0|undesignate|clear'])
  })

  it('with nothing held, lands on nothing: no event', () => {
    const r = rig()
    r.RADAR.mode = 'tws'
    r.clock(1)
    r.undesignate()
    expect(r.events()).toEqual([])
  })
})

// The RDR attack page's mouse-driven designate/undesignate (rdr_face,
// rdr_press's UNDES bezel) reach the exact same radar_designate/undesignate
// wrappers as the HOTAS controls above - a fight worked entirely from this
// page must not read as silence on the Input channel, or the channel's own
// documented claim ("no landing here means no lock ever formed") would be
// false for it.
describe('the radar page click (rdr_face) and its UNDES bezel (rdr_press)', () => {
  it('a first click on a TWS trackfile claims it, a second click on the SAME one locks it', () => {
    const r = rig()
    r.RADAR.mode = 'tws'
    r.RADAR.tracks = [track('bandit', 20000)]
    r.clock(50)
    r.rdrClick(0, 20000)
    expect(r.RADAR.ls).toBe('bandit')
    expect(r.RADAR.stt).toBeNull()
    r.clock(51)
    r.rdrClick(0, 20000)
    expect(r.RADAR.stt).toBe('bandit')
    expect(r.events()).toEqual(['50.0|acquire|ls', '51.0|acquire|stt'])
  })

  it('a click on an RWS brick locks straight to STT, one click', () => {
    // rdr_face confirms an RWS click against contacts() (the truth) within a
    // snap tolerance, so both the brick and a matching contact are needed.
    const r = rig([{ id: 'bandit', x: 0, y: 0, z: -20000 }])
    r.RADAR.mode = 'rws'
    r.RADAR.bricks = [{ id: 'bandit', azimuth: 0, range: 20000, at: 0 }]
    r.clock(30)
    r.rdrClick(0, 20000)
    expect(r.RADAR.stt).toBe('bandit')
    expect(r.events()).toEqual(['30.0|acquire|stt'])
  })

  it("the UNDES bezel button drops a hard lock, labeled break", () => {
    const r = rig()
    r.RADAR.stt = 'bandit'
    r.RADAR.ls = 'bandit'
    r.clock(60)
    r.rdrUndesignate()
    expect(r.RADAR.stt).toBeNull()
    expect(r.events()).toEqual(['60.0|undesignate|break'])
  })

  it('the UNDES bezel button with nothing held lands on nothing: no event', () => {
    const r = rig()
    r.clock(2)
    r.rdrUndesignate()
    expect(r.events()).toEqual([])
  })
})
