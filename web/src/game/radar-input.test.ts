// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { Radar, SCALES, BARS, boresight, geometry, pick, type Track } from './radar'
import * as identification from './identification'
import * as mids from './mids'
import * as countermeasures from './countermeasures'

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
  grid: (up: boolean) => unknown[]
  RADAR: Radar
  press(): void
  undesignate(): void
  rdrUndesignate(): void
  rdrClick(azimuth: number, range: number): void
  rdrX(azimuth: number): number
  rdrPress(pb: number): boolean
  events(): string[]
  clock(t: number): void
  sensor(way: string): void
  slew(x: number, y: number, dt: number): void
  tdc(): void
  acm(): void
  cursor: { azimuth: number; range: number }
  state(): { designator: string; master: string }
  set(designator: string, master: string): void
  show(display: string, page: string): void
  levers: Record<string, { armed: boolean; rest?: number }>
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
    lift('rdr_azimuth'),
    lift('rdr_y'),
    lift('rdr_press'),
    lift('rdr_face'),
    lift('tdc_designate'),
    lift('antenna_step'),
    lift('tdc_radar'),
    lift('tdc_press'),
    lift('tdc_slew'),
    lift('sensor'),
    lift('aacq'),
    lift('acm_press'),
  ].join('\n')
  const run = new Function(
    'Radar',
    'radar_geometry',
    'radar_pick',
    'contactList',
    'RADAR_BARS',
    `const THREE={MathUtils:{clamp:(v,a,b)=>Math.min(Math.max(v,a),b)}};
     const NM=1852;
     const RADAR=new Radar();
     const wrap_axis=(v)=>v;
     const MULTIPLAYER=false; let designated=-1;
     let radar_events=[];
     let sim_time=0;
     const radar_cursor={ azimuth:0, range:0 };
     const ownship={ pos:{x:0,y:0,z:0}, fwd:{x:0,y:0,z:-1}, up:{x:0,y:1,z:0}, right:{x:1,y:0,z:0}, gauges:{heading:0} };
     const pad_levers={}, hotas={ tdc:{ x:0, y:0, at:-Infinity } };
     const ddi_state={ left:{ page:'sms', menu:'' }, right:{ page:'rdr', menu:'' }, center:{ page:'sa', menu:'' } };
     let designator='right', master='120c', ddi_dirty=false;
     let grid_up=false; const grid_calls=[]; const tdc_hsi=()=>false, hsi_designate=()=>{}, hsi_slew=()=>{}, tdc_grid=()=>grid_up, grid_designate=()=>grid_calls.push('designate'), grid_slew=(x,y,dt)=>grid_calls.push([x,y,dt]), nav={}, navigate={ undesignate:()=>false };   // the HSI's use of the TDC and the undesignate button is navigation-cockpit.test.ts's
     const contacts=()=>contactList;
     ${code}
     return { RADAR, press:acquire_press, undesignate:undesignate_press,
       rdrUndesignate:()=>rdr_press(10),
       rdrClick:(azimuth,range)=>rdr_face(rdr_x(azimuth,RADAR.half()),rdr_y(range,RADAR.scale*NM)),
       rdrX:(azimuth)=>rdr_x(azimuth,RADAR.half()),
       rdrPress:(pb)=>rdr_press(pb),
       events:()=>radar_events, clock:(t)=>{ sim_time=t; },
       sensor, slew:tdc_slew, tdc:tdc_press, acm:acm_press, cursor:radar_cursor, grid:(up)=>{ grid_up=up; return grid_calls; },
       levers:pad_levers, state:()=>({ designator, master }), set:(d,m)=>{ designator=d; master=m; }, show:(d,p)=>{ ddi_state[d].page=p; } };`
  )
  return run(Radar, geometry, pick, contacts, BARS) as Rig
}

// The attack format's scan readouts (#47): the bars scanned on their bezel,
// where the scan points, the sector's edges about its centre, and the
// altitudes the bars span at the cursor's range.
describe('a new mission sets the radar up afresh', () => {
  it('scans four bars level, whatever the last mission left', () => {
    const run = new Function(
      'Radar',
      'boresight',
      `const NM=1852, cfg={ task:'joust', duel:'bvr' }, master='120c';
       const RADAR=new Radar(); const radar_cursor={ azimuth:0, range:0 };
       ${[lift('merge_joust'), lift('radar_scale'), lift('rdr_reset'), lift('default_radar')].join('\n')}
       RADAR.bars=0; RADAR.elevation=0.3;
       default_radar();
       return RADAR;`
    )
    const radar = run(Radar, boresight) as Radar
    expect(radar.bars).toBe(2)
    expect(radar.elevation).toBe(0)
    expect(radar.mode).toBe('tws')
  })
})

describe('the RDR page draws the scan volume', () => {
  function draw(set: (radar: Radar) => void) {
    const text: string[] = []
    const at: [string, number][] = [] // each text with where it was drawn across
    const boxes: number[] = [] // each strokeRect's left edge
    const run = new Function(
      'Radar',
      'radar_geometry',
      'set',
      'text',
      'at',
      'boxes',
      `const THREE={MathUtils:{clamp:(v,a,b)=>Math.min(Math.max(v,a),b)}};
       const NM=1852, D2R=Math.PI/180, wrap_axis=(v)=>v;
       const RADAR=new Radar();
       const radar_cursor={ azimuth:0, range:20*NM };
       const ownship={ pos:{x:0,y:6096,z:0}, gauges:{heading:0}, speed:250, fwd:{x:0,y:0,z:-1} };
       const breakaway_shown=()=>false, breakaway=()=>{};
       ${[lift('radar_own'), lift('ddi_legend'), lift('rdr_x'), lift('rdr_y'), lift('rdr_stick'), lift('rdr_star'), lift('rdr_block'), lift('ddi_rdr')].join('\n')}
       set(RADAR);
       const x=new Proxy({}, { get:(t,k)=>k==='fillText'?(s,px)=>{ text.push(String(s)); at.push([String(s),px]); }:k==='strokeRect'?(bx)=>boxes.push(bx):k==='measureText'?(s)=>({ width:10*String(s).length }):()=>{}, set:()=>true });
       ddi_rdr(x);
       return RADAR;`
    )
    const radar = run(Radar, geometry, set, text, at, boxes) as Radar
    return { text, at, boxes, radar }
  }
  it('labels the bars scanned, TWS dropping bars as it caps the width', () => {
    expect(draw(() => {}).text).toContain('4B')
    expect(draw((r) => { r.mode = 'tws' }).text).toContain('2B')
  })
  it('says where the scan points, and nothing when it points level', () => {
    expect(draw(() => {}).text.some((t) => t.startsWith('EL '))).toBe(false)
    expect(draw((r) => { r.centre = { azimuth: 0, elevation: (10 * Math.PI) / 180 } }).text).toContain('EL +10°')
  })
  it('labels the sector about its centre', () => {
    const { text } = draw((r) => {
      r.mode = 'tws'
      r.width = 2
      r.centre = { azimuth: (30 * Math.PI) / 180, elevation: 0 }
    })
    for (const edge of ['10', '30', '50']) expect(text).toContain(edge)
  })
  it('draws trackfiles, strobes and the cursor about an off-nose centre', () => {
    const off = (40 * Math.PI) / 180 // 10° right of a centre at 30°: three quarters across a ±20° face
    const { at, boxes } = draw((r) => {
      r.mode = 'tws'
      r.width = 2
      r.centre = { azimuth: (30 * Math.PI) / 180, elevation: 0 }
      r.tracks = [{ id: 'b', x: 20000 * Math.sin(off), y: 6096, z: -20000 * Math.cos(off), vx: 0, vy: 0, vz: 0, at: 0, hits: 1 }]
      r.strobes = [off]
    })
    const across = 256 + 0.5 * 180
    expect(boxes.some((bx) => Math.abs(bx - (across - 6)) < 0.5)).toBe(true) // the trackfile's box
    expect(at.some(([s, px]) => s === 'JAM' && Math.abs(px - across) < 0.5)).toBe(true)
    const { at: cursor } = draw((r) => {
      r.mode = 'tws'
      r.width = 2
      r.centre = { azimuth: (30 * Math.PI) / 180, elevation: 0 }
    })
    // The TDC sits at the cursor's azimuth, 0° here: past the sector's left edge, so pinned to it.
    expect(cursor.some(([s, px]) => /^-?\d+--?\d+$/.test(s) && Math.abs(px - (76 + 12)) < 0.5)).toBe(true)
  })

  it('gives the altitudes the bars span at the cursor', () => {
    const { text, radar } = draw(() => {})
    const reach = 20 * 1852, cover = radar.coverage()
    const hi = Math.round(((6096 + reach * Math.tan(cover)) * 3.281) / 1000)
    const lo = Math.round(((6096 - reach * Math.tan(cover)) * 3.281) / 1000)
    expect(text).toContain(`${hi}-${lo}`)
    expect(hi - lo).toBeLessThan(30) // four bars at 20 nm: about ±14,000 ft, not the old ±10° band's ±21,000
  })
})

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

  it('draws and clicks about the scan centre when TWS follows an L&S off the nose', () => {
    const r = rig()
    r.RADAR.mode = 'tws'
    r.RADAR.width = 2 // ±20°
    const off = 0.7 // 40° right: outside a ±20° face on the nose
    r.RADAR.tracks = [{ ...track('bandit', 0), x: 20000 * Math.sin(off), z: -20000 * Math.cos(off) }]
    r.RADAR.centre = { azimuth: 0.6, elevation: 0 }
    expect(r.rdrX(0.6)).toBe(256) // the scan's centre is the face's
    r.clock(40)
    r.rdrClick(off, 20000)
    expect(r.RADAR.ls).toBe('bandit')
  })

  it('steps the bars on its bezel, and slews the antenna on EL', () => {
    const r = rig()
    expect(r.RADAR.bars).toBe(2) // four
    const seen = [1, 2, 3].map(() => (r.rdrPress(13), r.RADAR.bars))
    expect(seen).toEqual([3, 0, 1])
    r.rdrPress(11)
    expect(r.RADAR.elevation).toBeCloseTo((5 * Math.PI) / 180, 6)
    r.rdrPress(12)
    r.rdrPress(12)
    expect(r.RADAR.elevation).toBeCloseTo((-5 * Math.PI) / 180, 6)
  })

  it('a click on an RWS brick locks straight to STT, one click', () => {
    // rdr_face confirms an RWS click against contacts() (the truth) within a
    // snap tolerance, so both the brick and a matching contact are needed.
    const r = rig([{ id: 'bandit', x: 0, y: 0, z: -20000 }])
    r.RADAR.mode = 'rws'
    r.RADAR.bricks = [{ id: 'bandit', azimuth: 0, range: 20000, at: 0, x: 0, z: -20000 }]
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

describe('the range scale (the RDR page\'s arrows, the castle zoom)', () => {
  // rdr_range, lifted as the rig does, stepping a real Radar's scale.
  function stepper() {
    return new Function(
      'Radar',
      'RADAR_SCALES',
      `const THREE={MathUtils:{clamp:(v,a,b)=>Math.min(Math.max(v,a),b)}};
       const RADAR=new Radar();
       ${lift('rdr_range')}
       return { RADAR, out:()=>rdr_range(-1), in:()=>rdr_range(1) };`
    )(Radar, SCALES) as { RADAR: Radar; out(): void; in(): void }
  }

  it("steps out through the F/A-18C's scales to 160 nm and no further, and back in to 5", () => {
    expect(SCALES).toEqual([5, 10, 20, 40, 80, 160])
    const r = stepper()
    expect(r.RADAR.scale).toBe(40) // the search scale a fight starts on
    const seen = [r.RADAR.scale]
    for (let i = 0; i < 4; i++) {
      r.out()
      seen.push(r.RADAR.scale)
    }
    expect(seen).toEqual([40, 80, 160, 160, 160])
    for (let i = 0; i < 6; i++) r.in()
    expect(r.RADAR.scale).toBe(5)
  })
})

describe('the HUD box: what the pilot has designated, and nothing else', () => {
  // hud_target, radar_held and heat_quarry, lifted as the rig does, with the
  // bandit alone or a match's remotes.
  type Jet = { group: { visible: boolean }; name: string }
  function world(multiplayer: boolean) {
    return new Function(
      'Radar',
      `const RADAR=new Radar();
       const MULTIPLAYER=${multiplayer}, has_enemy=!MULTIPLAYER, net=MULTIPLAYER?{}:null;
       const bandit={ group:{ visible:true }, name:'bandit' };
       const remotes=new Map([[3,{ group:{ visible:true }, name:'three' }]]);
       let designated=-1;
       ${lift('radar_held')}
       ${lift('hud_target')}
       ${lift('heat_quarry')}
       return { RADAR, bandit, remotes, hud_target, radar_held, heat_quarry,
         designate:(id)=>{ designated=id; }, designated:()=>designated };`
    )(Radar) as {
      RADAR: Radar
      bandit: Jet
      remotes: Map<number, Jet>
      hud_target(): Jet | null
      radar_held(): void
      heat_quarry(boxed: Jet | null): Jet | null
      designate(id: number | string): void
      designated(): number | string
    }
  }

  it('boxes no bandit the pilot has not designated, however near, alone', () => {
    const w = world(false)
    expect(w.hud_target()).toBeNull() // at a BVR joust's start: nothing designated, nothing boxed
    w.designate('bandit')
    expect(w.hud_target()).toBe(w.bandit) // once acquired, boxed
    w.bandit.group.visible = false
    expect(w.hud_target()).toBeNull() // shot down: gone, and the designation with it
    expect(w.designated()).toBe(-1)
  })

  it("boxes a match's designated remote, and drops a designation that has gone", () => {
    const w = world(true)
    expect(w.hud_target()).toBeNull()
    w.designate(3)
    expect(w.hud_target()?.name).toBe('three')
    w.designate(9) // left the match
    expect(w.hud_target()).toBeNull()
    expect(w.designated()).toBe(-1)
  })

  it('drops the designation when the radar lets it go, and keeps a silent radar\'s visual one', () => {
    const w = world(false)
    w.designate('bandit')
    w.RADAR.stt = 'bandit'
    w.radar_held()
    expect(w.designated()).toBe('bandit') // the radar holds it: it stands
    w.RADAR.stt = null // the lock broke: range, gimbal, memory
    w.radar_held()
    expect(w.designated()).toBe(-1) // and the box goes with it
    w.designate('bandit')
    w.RADAR.ls = 'bandit' // a TWS L&S holds it too
    w.radar_held()
    expect(w.designated()).toBe('bandit')
    w.RADAR.ls = null
    w.RADAR.sil = true // silent: a visual designation, the radar holding nothing
    w.designate('bandit')
    w.radar_held()
    expect(w.designated()).toBe('bandit')
  })

  it("points the 9M's seeker at the bandit alone whether or not the radar has it, and at the designated jet in a match", () => {
    const alone = world(false)
    expect(alone.heat_quarry(null)).toBe(alone.bandit) // a heat seeker needs no radar
    alone.bandit.group.visible = false
    expect(alone.heat_quarry(null)).toBeNull()
    const match = world(true)
    const three = match.remotes.get(3)!
    expect(match.heat_quarry(three)).toBe(three)
    expect(match.heat_quarry(null)).toBeNull()
  })

  it('draws with these: the box from hud_target, the seeker from heat_quarry, the designation checked each radar step', () => {
    const hud = lift('draw_hud')
    expect(hud).toMatch(/const dst=hud_target\(\); if\(dst\)\{ boxed=dst;/)
    expect(hud).not.toMatch(/if\(has_enemy\)\{[^}]*boxed=bandit/) // never the bandit for being there
    expect(hud).toMatch(/const quarry=heat_quarry\(boxed\);/)
    expect(hud).toMatch(/if\(master==="9m"&&!pa&&quarry\)/)
    expect(hud).toMatch(/const at=lockon\?\(proj_point\(quarry\.pos\)\|\|bore\):bore;/) // the seeker circle on its heat, boxed or not
    expect(lift('radar_step')).toMatch(/RADAR\.step\(dt,radar_own\(\),contacts\(\),wrap_axis\);\n\tradar_held\(\);/)
  })

  it('designates the bandit alone as a match designates its remotes: the acquire key, the TWS L&S, the ACM cone', () => {
    for (const name of ['radar_designate', 'radar_lock'])
      expect(lift(name)).toMatch(/\tdesignated=id; return true; \}/)
    expect(lift('acquire_press')).toMatch(/\t\tdesignated=RADAR\.ls;/)
    expect(lift('undesignate_press')).toMatch(/\t\tdesignated=RADAR\.ls;/)
    expect(lift('acquire_acm')).toMatch(/\tdesignated=id;\n\tif\(radar_lock\(id\)/)
    for (const name of ['radar_designate', 'radar_lock', 'radar_undesignate', 'acquire_press', 'undesignate_press', 'acquire_acm'])
      expect(lift(name)).not.toMatch(/MULTIPLAYER/) // nothing kept for a match alone
  })
})

describe('the known picture: what the SA page and the map draw', () => {
  // known lifted with the bandit alone, or a match with the pilot on blue, a
  // blue teammate (slot 2) and a red hostile (slot 3); the pilot at the origin.
  // The identification and link helpers run as they are, on the real modules; statuses is what the session has relayed
  // of each slot, none for an aircraft nobody has reported for. The teammate flies level, 1,000 m below the pilot.
  type Mark = { x: number; z: number; fx: number; fz: number; team: string; name: string }
  type Page = { RADAR: Radar; known(): Mark[]; statuses: Map<number, mids.Status>; squawk: identification.Identification; terminal: mids.Terminal; power(ac: boolean): void; emission(on: boolean): void; challenges(): { challenged: boolean; answered: boolean }; status(): mids.Status; lit(slot: number, visible: boolean): void }
  function page(multiplayer: boolean, night = false, far = 100000) {
    return new Function(
      'Radar', 'identification', 'mids',
      `const RADAR=new Radar(), statuses=new Map(), squawk=identification.fresh(), terminal=mids.fresh(), world_up={ x:0, y:1, z:0 };
       let buses={ ac:true }, emcon=false;
       const MULTIPLAYER=${multiplayer}, net=MULTIPLAYER?{ slot:1, teams:new Map([[1,'blue'],[2,'blue'],[3,'red']]), statuses }:null;
       const cfg={ tod:${night}?'night':'day' }, ownship={ pos:{ x:0, y:0, z:0 }, up:{ x:0, y:1, z:0 } }, wrap_axis=(v)=>v;
       const jets=MULTIPLAYER
         ?[{ id:2, x:100, y:-1000, z:-50000, fwd:{ x:1, z:0 }, name:'two', team:'blue' }, { id:3, x:0, y:0, z:-${far}, fwd:{ x:0, z:1 }, name:'three', team:'red' }]
         :[{ id:'bandit', x:0, y:0, z:-${far}, fwd:{ x:0, z:1 }, name:'', team:'' }];
       const contacts=()=>jets, remotes=new Map(jets.map(j=>[j.id,{ pos:{ x:j.x, y:j.y, z:j.z }, up:{ x:0, y:1, z:0 }, group:{ visible:true } }]));
       ${['own_team', 'status_of', 'link_sense', 'link_picture16', 'overhead', 'identified', 'challenges', 'status_own'].map(lift).join('\n')}
       ${lift('known').replace(/^function known/, 'const SIGHT=12000; function known')}
       return { RADAR, known, statuses, squawk, terminal, power(ac){ buses={ ac }; }, emission(on){ emcon=on; }, challenges, status:status_own, lit(slot,visible){ remotes.get(slot).group.visible=visible; } };`
    )(Radar, identification, mids) as Page
  }
  const standing = (over: Partial<mids.Status> = {}): mids.Status => ({ ...mids.STANDING, ...over })
  const track = (id: number | string, z: number, at = 0) => ({ id, x: 0, y: 0, z, vx: 0, vy: 0, vz: 250, at, hits: 1 })
  const paint = (id: number | string, z: number, at: number) => ({ id, azimuth: 0, range: -z, at, x: 0, z })

  it('shows no bandit beyond sight that the radar does not hold', () => {
    expect(page(false).known()).toEqual([])
  })
  it('shows a hostile close enough to see as it is, unnamed, radar or none', () => {
    expect(page(false, false, 11000).known()).toEqual([{ x: 0, z: -11000, fx: 0, fz: 1, team: '', name: '' }])
    expect(page(false, false, 13000).known()).toEqual([])
  })
  it("names no hostile in sight in a match: the eyes read no callsign", () => {
    expect(page(true, false, 11000).known().map((m) => m.name)).toEqual(['two', ''])
  })
  it('sees half as far at night', () => {
    expect(page(false, true, 7000).known()).toEqual([])
    expect(page(false, true, 5000).known()).toHaveLength(1)
  })
  it('draws a trackfile where its last fix, carried on by its velocity, puts it, unnamed', () => {
    const p = page(false)
    p.RADAR.tracks = [track('bandit', -80000)]
    p.RADAR.time = 4
    expect(p.known()).toEqual([{ x: 0, z: -79000, fx: 0, fz: 250, team: '', name: '' }])
  })
  it('draws a seen hostile once, as seen, over its trackfile', () => {
    const p = page(false, false, 9000)
    p.RADAR.tracks = [track('bandit', -9500)]
    expect(p.known()).toEqual([{ x: 0, z: -9000, fx: 0, fz: 1, team: '', name: '' }])
  })
  it('marks an RWS paint without a heading: its newest paint, and none beside a trackfile', () => {
    const p = page(false)
    p.RADAR.bricks = [paint('bandit', -90000, 0), paint('bandit', -89500, 2)]
    expect(p.known()).toEqual([{ x: 0, z: -89500, fx: 0, fz: 0, team: '', name: '' }])
    p.RADAR.tracks = [track('bandit', -89000, 2)]
    p.RADAR.time = 2
    expect(p.known().map((m) => m.fz)).toEqual([250])
  })
  it("shows a match's teammate by datalink at any range, named, and a hostile only as tracked, unnamed", () => {
    const p = page(true)
    expect(p.known().map((m) => m.name)).toEqual(['two'])
    p.RADAR.tracks = [track(3, -30000), track(2, -50000)] // the teammate's own trackfile adds nothing
    expect(p.known()).toEqual([
      { x: 100, z: -50000, fx: 1, fz: 0, team: 'blue', name: 'two' },
      { x: 0, z: -30000, fx: 0, fz: 250, team: '', name: '' }, // the radar gives a track no side
    ])
  })

  // Link 16 (#99): a member of the side is on the page by its own report, sent by its terminal and taken by the pilot's.
  it('takes a teammate off the link picture once its terminal stops sending, or the pilot\'s stops receiving', () => {
    const p = page(true)
    p.statuses.set(2, standing({ link: false }))
    expect(p.known()).toEqual([])
    p.statuses.set(2, standing())
    expect(p.known()).toHaveLength(1)
    p.terminal.on = false
    expect(p.known()).toEqual([])
    p.terminal.on = true; p.power(false)
    expect(p.known()).toEqual([])
    p.power(true); p.squawk.held = false // the crypto variables zeroed
    expect(p.known()).toEqual([])
  })
  it('goes on receiving the link in EMCON', () => {
    const p = page(true)
    p.emission(true)
    expect(p.known().map((m) => m.name)).toEqual(['two'])
  })
  it('adds the tracks a member\'s radar holds, where the pilot holds nothing of his own, with no side and no name', () => {
    const p = page(true)
    p.statuses.set(2, standing({ tracks: [3, 1, 2] })) // the hostile, the pilot himself and the member
    expect(p.known()).toEqual([{ x: 100, z: -50000, fx: 1, fz: 0, team: 'blue', name: 'two' }, { x: 0, z: -100000, fx: 0, fz: 1, team: '', name: '' }])
    p.RADAR.tracks = [track(3, -30000)]
    expect(p.known().map((m) => m.z)).toEqual([-50000, -30000]) // his own trackfile, once
    p.RADAR.tracks = []; p.statuses.set(2, standing({ tracks: [3], link: false }))
    expect(p.known()).toEqual([]) // a member not sending gives nothing
  })

  // IFF (#98): off the link, a track gets a side only by answering the pilot's mode 4 challenge.
  it('gives a tracked teammate off the link its side by its answer to a mode 4 challenge, and no name', () => {
    const p = page(true)
    p.statuses.set(2, standing({ link: false }))
    p.RADAR.tracks = [track(2, -50000)]
    expect(p.known()).toEqual([{ x: 0, z: -50000, fx: 0, fz: 250, team: 'blue', name: '' }])
  })
  it('gives it no side when it does not answer: its transponder off, or the answering antenna on the far side', () => {
    const p = page(true)
    p.RADAR.tracks = [track(2, -50000)]
    const team = (status: Partial<mids.Status>) => { p.statuses.set(2, standing({ link: false, ...status })); return p.known()[0].team }
    expect(team({ reply: false })).toBe('')
    expect(team({ antenna: 'lower' })).toBe('') // the pilot is above it
    expect(team({ antenna: 'upper' })).toBe('blue')
    expect(team({ antenna: 'both' })).toBe('blue')
  })
  it('gives it no side when the pilot does not challenge: the interrogator off, mode 4 disabled, the codes gone, EMCON, or no ac power', () => {
    const fresh = () => { const p = page(true); p.statuses.set(2, standing({ link: false })); p.RADAR.tracks = [track(2, -50000)]; return p }
    const team = (set: (p: Page) => void) => { const p = fresh(); set(p); return p.known()[0].team }
    expect(team(() => {})).toBe('blue')
    expect(team((p) => { p.squawk.on = false })).toBe('')
    expect(team((p) => { p.squawk.interrogator.modes.four = false })).toBe('')
    expect(team((p) => { p.squawk.held = false })).toBe('')
    expect(team((p) => { p.emission(true) })).toBe('')
    expect(team((p) => { p.power(false) })).toBe('')
    expect(team((p) => { p.squawk.transponder.modes.four = false })).toBe('blue') // his own answering is another matter
  })
  it('never gives a hostile a side, whatever it reports', () => {
    const p = page(true)
    p.statuses.set(3, standing())
    p.RADAR.tracks = [track(3, -30000)]
    expect(p.known().find((m) => m.z === -30000)?.team).toBe('')
  })
  it('gives nothing a side with the bandit alone, where there are no sides', () => {
    const p = page(false)
    p.RADAR.tracks = [track('bandit', -80000)]
    expect(p.known().map((m) => m.team)).toEqual([''])
  })

  // The challenges arriving (23.6.2.2.1, 23.6.2.3): from a member of the side challenging in mode 4 whose radar holds
  // the pilot; answered when his transponder replies to every one of them.
  it('counts a valid challenge from a member whose radar holds the pilot, and its answer', () => {
    const p = page(true)
    expect(p.challenges()).toEqual({ challenged: false, answered: false })
    p.statuses.set(2, standing({ tracks: [1] }))
    expect(p.challenges()).toEqual({ challenged: true, answered: true })
    p.statuses.set(2, standing({ tracks: [1], challenge: false }))
    expect(p.challenges().challenged).toBe(false)
    p.statuses.set(3, standing({ tracks: [1] })) // a hostile's challenge is not a valid one
    expect(p.challenges().challenged).toBe(false)
  })
  it('leaves a challenge unanswered with the transponder not replying, or its antenna on the far side', () => {
    const p = page(true)
    p.statuses.set(2, standing({ tracks: [1] }))
    p.squawk.transponder.modes.four = false
    expect(p.challenges()).toEqual({ challenged: true, answered: false })
    p.squawk.transponder.modes.four = true; p.squawk.antenna = 'upper' // the challenger is below
    expect(p.challenges().answered).toBe(false)
    p.squawk.antenna = 'lower'
    expect(p.challenges().answered).toBe(true)
    p.emission(true)
    expect(p.challenges().answered).toBe(false)
  })
  it('counts no challenge from an aircraft that is not flying', () => {
    const p = page(true)
    p.statuses.set(2, standing({ tracks: [1] })); p.lit(2, false)
    expect(p.challenges().challenged).toBe(false)
  })

  // What the session is told of this aircraft, for the others' pictures.
  it('reports its own transponder, interrogator, terminal, antenna and radar tracks', () => {
    const p = page(true)
    p.RADAR.tracks = [track(2, -50000)]; p.RADAR.stt = 3 // a trackfile, and the single target track
    expect(p.status()).toEqual({ reply: true, challenge: true, link: true, antenna: 'both', tracks: [2, 3] })
    p.RADAR.tracks = [track(3, -30000), track(2, -50000)]
    expect(p.status().tracks).toEqual([3, 2]) // each once
    p.emission(true); p.squawk.antenna = 'upper'
    expect(p.status()).toEqual({ reply: false, challenge: false, link: false, antenna: 'upper', tracks: [3, 2] })
    p.emission(false); p.terminal.on = false; p.squawk.transponder.modes.four = false
    expect(p.status()).toMatchObject({ reply: false, challenge: true, link: false })
  })
  it('reports no more than sixteen tracks, and none that is not a slot', () => {
    const p = page(true)
    p.RADAR.tracks = Array.from({ length: 20 }, (_, k) => track(k + 2, -30000))
    expect(p.status().tracks).toHaveLength(16)
    const solo = page(false)
    solo.RADAR.tracks = [track('bandit', -30000)]
    expect(solo.status().tracks).toEqual([])
  })
  it('sends its status with every input sample, and takes the others\' from the session\'s status events', () => {
    expect(source).toMatch(/solo:suite\.dispenser==="bypass", extinguish:extinguish_flag, status:status_own\(\) \};/)
    const net = readFileSync(fileURLToPath(new URL('./net.ts', import.meta.url)), 'utf8')
    expect(net).toMatch(/if \(ev\.kind === 'status' && validSlot\(ev\.slot\)\) this\.statuses\.set\(ev\.slot as number, status_read\(ev, MAX_SLOT\)\)/)
  })
  it('draws the SA page and the map from it, a paint with no heading as a plain mark', () => {
    const sa = lift('ddi_sa'), map = lift('draw_map')
    expect(sa).toContain('for(const c of known()) jet(c.x,c.z,c.fx,c.fz,')
    expect(sa).toMatch(/if\(!fx&&!fz\)\{ [^\n]*x\.arc\(dx,dz,6,0,Math\.PI\*2\); x\.stroke\(\); return; \}/)
    expect(map).toContain('for(const c of known()) jet(X(c.x),Y(c.z),c.fx,c.fz,')
    expect(map).toMatch(/if\(!fx&&!fz\)\{ [^\n]*mctx\.arc\(x2,y2,5,0,Math\.PI\*2\); mctx\.stroke\(\); return; \}/)
    expect(map).not.toMatch(/remotes\.entries\(\)|bandit\.pos/)
  })

  // The SA page's other marks (#110): the air-to-air waypoint, and at the rim the bearings the RWR hears. The page
  // runs against a recording context, the picture empty, at the 40 nm scale: 196 px to 20 nm.
  type Emitter = { bearing: number; at: number; locked?: boolean; missile?: boolean }
  function sa(o: { air?: number | null; waypoint?: { x: number; z: number } | null; emitters?: Emitter[]; power?: boolean; limit?: boolean; heading?: number } = {}) {
    return new Function('o', 'countermeasures', `const NM=1852, D2R=Math.PI/180, sa_state={ scale:40 }, wrap_axis=(v)=>v, CARRIER={ x:1e7, z:1e7 }, known=()=>[], link={ selected:false }, ddi_legend=()=>{};
      const ownship={ pos:{ x:0, y:0, z:0 }, gauges:{ heading:o.heading||0 } }, hsi_state={ air:o.air??null }, nav={}, navigate={ spot:(n,i)=>i===3?o.waypoint:null };
      const suite=countermeasures.fresh(true,{ chaff:20, flare:40 }); suite.receiver.power=o.power??true; suite.receiver.limit=!!o.limit; const RWR={ time:10, contacts:o.emitters||[] };
      const arcs=[], text=[], shifts=[], turns=[];
      const x=new Proxy({}, { get:(t,k)=>k==="arc"?(ax,ay,r)=>arcs.push([Math.round(ax),Math.round(ay),r]):k==="fillText"?(w,px,py)=>text.push([String(w),px,py]):k==="translate"?(px,py)=>shifts.push([Math.round(px)+0,Math.round(py)+0]):k==="rotate"?(a)=>turns.push(a):()=>{}, set:()=>true });
      ${lift('ddi_sa')}
      ddi_sa(x,"left"); return { arcs, text, shifts, turns };`)(o, countermeasures) as { arcs: number[][]; text: [string, number, number][]; shifts: number[][]; turns: number[] }
  }
  const rings = (d: ReturnType<typeof sa>) => d.arcs.filter((a) => a[2] === 8)
  it('marks the air-to-air waypoint with a ring where it lies, north up the page', () => {
    expect(rings(sa())).toEqual([])
    expect(rings(sa({ air: 3, waypoint: { x: 10 * 1852, z: -10 * 1852 } }))).toEqual([[98, -98, 8]]) // ten miles east and ten north: half the scale each way
  })
  it('marks none with no waypoint made the A/A waypoint, one that holds nothing, or one off the scale', () => {
    expect(rings(sa({ air: null, waypoint: { x: 0, z: -18520 } }))).toEqual([])
    expect(rings(sa({ air: 3, waypoint: null }))).toEqual([])
    expect(rings(sa({ air: 3, waypoint: { x: 0, z: -25 * 1852 } }))).toEqual([])
  })
  // each emitter is written at a translate of its own: the first is the page's centre
  const emitters = (d: ReturnType<typeof sa>) => d.shifts.slice(1).map((at, k) => [d.text.filter((t) => t[0] === '18' || t[0] === 'M')[k][0], ...at])
  it('writes each bearing the RWR hears just inside the rim, at its true bearing, a missile as M', () => {
    const d = sa({ emitters: [{ bearing: Math.PI / 2, at: 10 }, { bearing: Math.PI, at: 10, missile: true }] })
    expect(emitters(d)).toEqual([['M', 0, 180], ['18', 180, 0]]) // the missile first, by priority: due south, and the search radar due east
  })
  it('keeps the bearings upright as the page turns with the heading', () => {
    expect(sa({ heading: 0.5, emitters: [{ bearing: 0, at: 10 }] }).turns).toEqual([-0.5, 0.5]) // the page turned to the heading, the symbol turned back
  })
  it('writes none with the RWR off, and the six of highest priority with its DISPLAY at LIMIT', () => {
    const eight: Emitter[] = Array.from({ length: 8 }, (_, k) => ({ bearing: k * 0.4, at: k }))
    expect(emitters(sa({ emitters: eight }))).toHaveLength(8)
    expect(emitters(sa({ emitters: eight, power: false }))).toEqual([])
    expect(emitters(sa({ emitters: eight, limit: true }))).toHaveLength(6)
  })
})

describe('the launch zones fly the radar trackfile, not the jet', () => {
  // radar_target, launch_zone and heat_zone lifted with the ladders stubbed to
  // record what they are flown against; the bandit, alone, is somewhere else
  // by now than the radar last saw it.
  type Fed = { position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number } }
  function zones() {
    return new Function(
      'Radar', 'THREE',
      `const RADAR=new Radar();
       const MULTIPLAYER=false, has_enemy=true, remotes=new Map(), WORLD_WRAP=0, wrap_axis=(v)=>v;
       const bandit={ group:{ visible:true }, pos:{ x:0, y:6000, z:-30000 }, velx:0, vely:0, velz:250, fwd:{ x:0, y:0, z:1 }, speed:250, reheat:0.5 };
       const ownship={ pos:{ x:0, y:6000, z:0 }, velx:0, vely:0, velz:-250, speed:250 };
       let sim_time=10, zone_at=0, zone=null, zone_track=null, heat_at=0, heat=null, heat_track=null, heat_prev=null;
       const fed={ amraam:null, heater:null, reheat:null };
       const round_ladder=(own,target)=>{ fed.amraam=target; return { max:40000, escape:20000, minimum:800 }; };
       const heater_ladder=(own,target,swing,reheat)=>{ fed.heater=target; fed.reheat=reheat; return { max:8000, escape:4000, minimum:500 }; };
       ${lift('radar_target')} ${lift('launch_zone')} ${lift('heat_zone')} ${lift('ranging')}
       return { RADAR, bandit, fed, launch_zone, heat_zone, ranging };`
    )(Radar, THREE) as { RADAR: Radar; bandit: { group: { visible: boolean } }; fed: { amraam: Fed | null; heater: Fed | null; reheat: number | null }; launch_zone(): { range: number; lead: { z: number } } | null; heat_zone(): { range: number } | null; ranging(): { range: number; closure: number } | null }
  }
  // the trackfile's last fix: 40 km out four seconds ago, closing at 250 m/s
  const held = { id: 'bandit', x: 0, y: 6000, z: -40000, vx: 0, vy: 0, vz: 250, at: 0, hits: 1 }

  it('flies the AMRAAM zone against the trackfile carried on, not the jet', () => {
    const z = zones()
    z.RADAR.tracks = [held]
    z.RADAR.ls = 'bandit'
    z.RADAR.time = 4
    const zone = z.launch_zone()
    expect(z.fed.amraam?.position).toEqual({ x: 0, y: 6000, z: -39000 })
    expect(z.fed.amraam?.velocity).toEqual({ x: 0, y: 0, z: 250 })
    expect(zone?.range).toBeCloseTo(39000, 6)
    expect(zone?.lead.z).toBeCloseTo(-39000 + 250 * (39000 / (250 + 650)), 6) // the steering dot leads the track, not the jet at 30 km
  })
  it("flies the 9M's zone against it too, with the jet's own plume", () => {
    const z = zones()
    z.RADAR.tracks = [held]
    z.RADAR.stt = 'bandit'
    z.RADAR.time = 4
    const heat = z.heat_zone()
    expect(z.fed.heater?.position).toEqual({ x: 0, y: 6000, z: -39000 })
    expect(heat?.range).toBeCloseTo(39000, 6)
    expect(z.fed.reheat).toBe(0.5)
  })
  it("ranges the HUD on the trackfile carried on: range, and closure on the track's velocity", () => {
    const z = zones()
    z.RADAR.tracks = [held]
    z.RADAR.stt = 'bandit'
    z.RADAR.time = 4
    const r = z.ranging()
    expect(r?.range).toBeCloseTo(39000, 6)
    expect(r?.closure).toBeCloseTo(500, 6) // 250 m/s each, nose to nose
  })
  it('has no ranging from a silent radar or without a trackfile', () => {
    const z = zones()
    z.RADAR.stt = 'bandit'
    expect(z.ranging()).toBeNull()
    z.RADAR.tracks = [held]
    z.RADAR.sil = true
    expect(z.ranging()).toBeNull()
  })
  it('feeds both HUDs the radar ranging, and shows the data block only with it', () => {
    for (const name of ['draw_hud', 'ddi_hud']) {
      const body = lift(name)
      expect(body, name).toMatch(/const r=ranging\(\); if\(r\)\{ rng=r\.range; vc=r\.closure; ranged=true; \}/)
      expect(body, name).not.toMatch(/rng=wrap_distance\(ownship\.pos,dst\.pos\)/)
      expect(body, name).toContain('vc,ranged?rng:null,')
    }
    expect(lift('hud_cluster')).toContain('if(aa&&boxed&&rng!=null&&!declutter)')
  })
  it('has no zone without a trackfile, or once the jet is gone', () => {
    const z = zones()
    z.RADAR.ls = 'bandit'
    expect(z.launch_zone()).toBeNull()
    expect(z.heat_zone()).toBeNull()
    z.RADAR.tracks = [held]
    z.bandit.group.visible = false
    expect(z.launch_zone()).toBeNull()
    expect(z.heat_zone()).toBeNull()
  })
})

// The stick's sensor control switch (#27, NATOPS 2.8.2.2.2) and the throttle's
// TDC (#32), against the real Radar: in BVR the switch hands the TDC between the
// displays and commands ACM forward; toward the display that already has the TDC
// and the attack format it commands AACQ; in ACM it picks BST, VACQ and WACQ,
// and right returns to search.
describe('the sensor control switch and the TDC', () => {
  it('in BVR gives the TDC to the display it points at, aft to the AMPCD, and commands ACM in boresight forward', () => {
    const r = rig()
    r.set('center', '120c')
    r.sensor('left')
    expect(r.state().designator).toBe('left')
    r.sensor('aft')
    expect(r.state().designator).toBe('center')
    r.sensor('right')
    expect(r.state().designator).toBe('right')
    expect(r.RADAR.auto).toBe(false)
    r.sensor('forward')
    expect([r.RADAR.auto, r.RADAR.acm]).toEqual([true, 'bst'])
  })

  it('in ACM selects BST, VACQ and WACQ, and returns to search on the right, the TDC staying where it is', () => {
    const r = rig()
    r.RADAR.auto = true
    r.sensor('aft')
    expect(r.RADAR.acm).toBe('vacq')
    r.sensor('left')
    expect(r.RADAR.acm).toBe('wacq')
    r.sensor('forward')
    expect(r.RADAR.acm).toBe('bst')
    r.sensor('right')
    expect(r.RADAR.auto).toBe(false)
    expect(r.state().designator).toBe('right')
  })

  it('in NAV only assigns the TDC: no ACM forward, no AACQ', () => {
    const r = rig()
    r.set('right', 'nav')
    r.RADAR.mode = 'tws'
    r.RADAR.tracks = [track('bandit', 8000)]
    r.sensor('forward')
    expect(r.RADAR.auto).toBe(false)
    r.sensor('right')
    expect(r.RADAR.stt).toBeNull()
  })

  it('commands AACQ toward the display that has the TDC and the attack format: the target under the cursor, else the nearest', () => {
    const under = rig()
    under.RADAR.mode = 'tws'
    under.RADAR.tracks = [track('near', 8000), track('far', 20000)]
    under.cursor.azimuth = 0
    under.cursor.range = 20000
    under.clock(4)
    under.sensor('right')
    expect([under.RADAR.stt, under.RADAR.ls]).toEqual(['far', 'far'])
    expect(under.events()).toEqual(['4.0|acquire|aacq'])
    const nearest = rig()
    nearest.RADAR.mode = 'tws'
    nearest.RADAR.tracks = [track('far', 20000), track('near', 8000)]
    nearest.cursor.azimuth = 0.4
    nearest.cursor.range = 60000
    nearest.sensor('right')
    expect(nearest.RADAR.stt).toBe('near')
  })

  it('gives AACQ nothing to do away from the attack format, or silent', () => {
    const away = rig()
    away.RADAR.mode = 'tws'
    away.RADAR.tracks = [track('bandit', 8000)]
    away.show('right', 'fuel')
    away.sensor('right')
    expect(away.RADAR.stt).toBeNull()
    const silent = rig()
    silent.RADAR.mode = 'tws'
    silent.RADAR.tracks = [track('bandit', 8000)]
    silent.RADAR.sil = true
    silent.sensor('right')
    expect(silent.RADAR.stt).toBeNull()
  })

  it('acquires in WACQ 30° either side of the nose and 10° about the horizon, to 10 nm', () => {
    const at = (bearing: number, elevation: number, range: number) => {
      const b = bearing * Math.PI / 180, e = elevation * Math.PI / 180
      return { id: 'bandit', x: Math.sin(b) * Math.cos(e) * range, y: Math.sin(e) * range, z: -Math.cos(b) * Math.cos(e) * range }
    }
    const locks = (bearing: number, elevation: number, range = 9000) => {
      const r = rig([at(bearing, elevation, range)])
      r.RADAR.mode = 'rws'
      r.RADAR.auto = true
      r.RADAR.acm = 'wacq'
      r.press()
      return r.RADAR.stt
    }
    expect(locks(20, 0)).toBe('bandit')
    expect(locks(-28, 8)).toBe('bandit')
    expect(locks(35, 0)).toBeNull()
    expect(locks(0, 12)).toBeNull()
    expect(locks(0, 0, 19000)).toBeNull()
  })

  it('steps the ACM legend BST, VACQ, WACQ and back to search', () => {
    const r = rig()
    const seen: string[] = []
    for (let i = 0; i < 4; i++) { r.acm(); seen.push(r.RADAR.auto ? r.RADAR.acm : 'off') }
    expect(seen).toEqual(['bst', 'vacq', 'wacq', 'off'])
  })

  it('slews the cursor with the TDC on the attack format, a full deflection crossing the scan in two seconds, and nothing elsewhere', () => {
    const r = rig()
    const half = r.RADAR.half(), scale = r.RADAR.scale * 1852
    r.cursor.azimuth = 0
    r.cursor.range = scale / 4
    r.slew(1, 0, 0.5)
    expect(r.cursor.azimuth).toBeCloseTo(half / 2)
    r.slew(0, 1, 1)
    expect(r.cursor.range).toBeCloseTo(scale * 3 / 4)
    r.slew(1, 1, 10)
    expect([r.cursor.azimuth, r.cursor.range]).toEqual([half, scale]) // held at the format's edges
    r.set('left', '120c')
    r.slew(-1, -1, 1)
    expect([r.cursor.azimuth, r.cursor.range]).toEqual([half, scale])
  })

  it('designates under the cursor when the TDC is pressed on the attack format', () => {
    const r = rig()
    r.RADAR.mode = 'tws'
    r.RADAR.tracks = [track('bandit', 9000)]
    r.cursor.azimuth = 0
    r.cursor.range = 9000
    r.tdc()
    expect(r.RADAR.ls).toBe('bandit')
    r.set('left', '120c')
    r.tdc()
    expect(r.RADAR.stt).toBeNull() // the TDC on the stores page: nothing to designate
  })

  it('works the square identification grid\'s cursor when the TDC is on that display, and leaves it alone otherwise', () => {
    const r = rig()
    r.set('left', 'nav'); r.show('left', 'sms')
    const calls = r.grid(false)
    r.tdc(); r.slew(1, -1, 0.25)
    expect(calls).toEqual([])
    r.grid(true)
    r.tdc(); r.slew(1, -1, 0.25); r.slew(0, 0, 0.25)
    expect(calls).toEqual(['designate', [1, -1, 0.25]]) // a centred TDC slews nothing
  })

  it('takes the antenna back from a wheel bound on the stick when the keys or the EL bezel step it', () => {
    const r = rig()
    r.levers.antenna = { armed: true, rest: 0.5 }
    r.rdrPress(11)
    expect(r.levers.antenna.armed).toBe(false)
    expect(r.RADAR.elevation).toBeCloseTo(5 * Math.PI / 180)
  })
})
