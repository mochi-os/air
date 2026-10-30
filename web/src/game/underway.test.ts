// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

// The carrier under way: the flight core flies the ship's track and the
// engine poses the ship at the jet's own clock. What hangs on the ship is
// built where the map charts it and hung on carrier_rig, which carries it to
// wherever the ship is. engine.ts cannot be imported (WebGL at module scope),
// so its functions are lifted from its text and run with stand-ins.
const source = readFileSync(
  fileURLToPath(new URL('./engine.ts', import.meta.url)),
  'utf8'
)

function lift(name: string): string {
  const start = source.search(new RegExp(`(async )?function ${name}\\(`))
  if (start < 0) throw new Error(`${name} not found in engine.ts`)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0)
      return source.slice(start, i + 1) + '\n'
  }
  throw new Error(`${name} never closes`)
}
function line(pattern: RegExp): string {
  const found = pattern.exec(source)?.[0]
  if (!found) throw new Error(`${pattern} not found in engine.ts`)
  return found + '\n'
}

interface Pose {
  x: number
  z: number
  heading: number
  closed: boolean
  y?: number // her deck reference's height in the frame: on the curved sea away from where she was built, not the charted one
  lean?: number // her bow up off the frame's level, rad: the curved sea under her, seen from a frame anchored elsewhere
}
interface Grid {
  data: Float32Array
  W: number
  H: number
  cell: number
  minFa: number
  minLat: number
}
interface Station {
  channel: number
  band: string
  x: number
  z: number
}
interface Ownship {
  pos: THREE.Vector3
  fwd: THREE.Vector3
  vel_dir: THREE.Vector3
  q: THREE.Quaternion
}
interface Remote {
  pos: THREE.Vector3
  group: THREE.Object3D
}
interface Lens {
  x: number
  z: number
  tdx: number
  tdz: number
  apx: number
  apz: number
  chart: { x: number; z: number; tdx: number; tdz: number; apx: number; apz: number }
}
interface Harness {
  scene: THREE.Scene
  rig: THREE.Group
  chart: { x: number; z: number; yaw: number }
  carrier: { x: number; z: number; deckY: number }
  frame(): { yaw: number; closed: boolean; time: number }
  poses: Map<number, Pose>
  stations: Station[]
  ownship: Ownship
  lens(value: Lens): void
  placed(value: unknown): void
  carrier_pose(time: number): void
  with_charted<T>(build: () => T): T
  rig_adopt<T>(build: () => T): T
  rig_local(v: THREE.Vector3): THREE.Vector3
  carrier_world(fa: number, lat: number): { x: number; z: number }
  carrier_fore_aft(x: number, z: number): number
  carrier_lateral(x: number, z: number): number
  deck_carry(st: Remote, then: number): void
  carry_start(): void
  deck_y_at(grp: unknown, x: number, z: number, fallback: number): number
  grid(value: Grid): void
  turn(): THREE.Quaternion
}

const NOW = 100
function harness(): Harness {
  return new Function(
    'THREE',
    `const D2R=Math.PI/180, SHIP={ yaw:110, bow:90, tacan:{ channel:74, band:"X" } };
    const CARRIER={ x:-18500, z:7500, deckY:19.9, height:19.9 };
    const scene=new THREE.Scene(), world_up=new THREE.Vector3(0,1,0), poses=new Map(), carrier_model={};
    const flight_carrier=(t)=>poses.get(t)??null;
    const flight_deck=(t)=>{ const p=poses.get(t); if(!p) return null;   // the ship on her heading, level on a flat sea unless the pose sets her lower and leaning, as the curved sea does
      const q=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),p.heading).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),p.lean??0));
      return { position:{ x:p.x, y:p.y??19.9, z:p.z }, quaternion:{ x:q.x, y:q.y, z:q.z, w:q.w } }; };
    const nav={ stations:[{ channel:74, band:"X", x:0, z:0 }, { channel:12, band:"X", x:5, z:5 }] };
    const ownship={ pos:new THREE.Vector3(), fwd:new THREE.Vector3(1,0,0), vel_dir:new THREE.Vector3(1,0,0), q:new THREE.Quaternion() };
    let carrier_ols=null, deck_grid=null;
    ${line(/^let CARRIER_YD=[^\n]*/m)}
    ${line(/^const CHART=[^\n]*/m)}
    ${line(/^const carrier_rig=[^\n]*/m)}
    ${line(/^const _deck_turn=[^\n]*/m)}
    ${line(/^const _hang_turn=[^\n]*/m)}
    ${line(/^const _charted_up=[^\n]*/m)}
    ${line(/^const _carry_offset=[^\n]*/m)}
    ${line(/^const _deck_rise=[^\n]*/m)}
    ${line(/^let carrier_time=[^\n]*/m)}
    ${line(/^let placed=[^\n]*/m)}
    ${lift('carrier_fore_aft')}${lift('carrier_world')}${lift('carrier_lateral')}
    ${lift('carrier_set')}${lift('carrier_pose')}${lift('carrier_hang')}${lift('carrier_place')}${lift('with_charted')}${lift('rig_adopt')}${lift('rig_local')}
    ${lift('charted')}${lift('ols_follow')}${lift('deck_carry')}${lift('carry_start')}${lift('deck_y_at')}
    return { scene, rig:carrier_rig, chart:CHART, carrier:CARRIER, poses, stations:nav.stations, ownship,
      frame:()=>({ yaw:CARRIER_YD, closed:deck_closed, time:carrier_time }),
      lens:(v)=>{ carrier_ols=v; }, placed:(v)=>{ placed=v; },
      grid:(v)=>{ deck_grid=v; }, turn:()=>carrier_turn.clone(),
      carrier_pose, with_charted, rig_adopt, rig_local, carrier_world, carrier_fore_aft, carrier_lateral, deck_carry, carry_start, deck_y_at };`
  )(THREE) as Harness
}

// The ship 3 km east and a kilometre north of where the map charts it,
// turned half a radian to port, mid-turn.
function underway(h: Harness): Pose {
  const pose = { x: h.chart.x + 3000, z: h.chart.z - 1000, heading: h.chart.yaw + 0.5, closed: true }
  h.poses.set(NOW, pose)
  h.carrier_pose(NOW)
  return pose
}

describe('the carrier under way', () => {
  it('carries what is built where the map charts the ship to where it is, turned with it', () => {
    const h = harness()
    const spots = [
      [0, 0],
      [120, -25],
      [-150, 30],
    ]
    const marks = h.with_charted(() =>
      h.rig_adopt(() =>
        spots.map(([fa, lat]) => {
          const w = h.carrier_world(fa, lat)
          const m = new THREE.Object3D()
          m.position.set(w.x, 20, w.z)
          m.rotation.y = h.chart.yaw
          h.scene.add(m)
          return m
        })
      )
    )
    for (const m of marks) expect(m.parent).toBe(h.rig)
    const pose = underway(h)
    expect(h.carrier).toMatchObject({ x: pose.x, z: pose.z })
    expect(h.frame()).toEqual({ yaw: pose.heading, closed: true, time: NOW })
    spots.forEach(([fa, lat], i) => {
      const live = h.carrier_world(fa, lat)
      const at = marks[i].getWorldPosition(new THREE.Vector3())
      expect(at.x).toBeCloseTo(live.x, 6)
      expect(at.z).toBeCloseTo(live.z, 6)
      expect(at.y).toBeCloseTo(20, 9)
      const nose = new THREE.Vector3(1, 0, 0).applyQuaternion(marks[i].getWorldQuaternion(new THREE.Quaternion()))
      expect(Math.atan2(-nose.z, nose.x)).toBeCloseTo(pose.heading, 9)
    })
    // and a world point found on the live deck lands on the rig at the charted spot
    const found = h.carrier_world(120, -25)
    const local = h.rig_local(new THREE.Vector3(found.x, 0, found.z))
    h.with_charted(() => {
      expect(h.carrier_fore_aft(local.x, local.z)).toBeCloseTo(120, 6)
      expect(h.carrier_lateral(local.x, local.z)).toBeCloseTo(-25, 6)
    })
  })

  it('builds in the charted frame and gives back the live pose, even when the build fails', () => {
    const h = harness()
    const pose = underway(h)
    expect(h.with_charted(() => ({ ...h.carrier }))).toMatchObject({ x: h.chart.x, z: h.chart.z })
    expect(() =>
      h.with_charted(() => {
        throw new Error('no deck')
      })
    ).toThrow('no deck')
    expect(h.carrier).toMatchObject({ x: pose.x, z: pose.z })
    expect(h.frame().yaw).toBe(pose.heading)
    // her attitude too: level on the chart's heading inside, her own after
    const charted = h.with_charted(() => h.turn())
    expect(charted.angleTo(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), h.chart.yaw))).toBeLessThan(1e-7)
    expect(h.turn().angleTo(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), pose.heading))).toBeLessThan(1e-7)
  })

  it('keeps the lens on the ship: its touchdown and approach axis where the ship has taken them', () => {
    const h = harness()
    const lens = h.with_charted(() => {
      const td = h.carrier_world(-60, -12)
      const o = h.carrier_world(-80, -30)
      const a = { x: -Math.cos(h.chart.yaw), z: Math.sin(h.chart.yaw) }
      const chart = { x: o.x, z: o.z, tdx: td.x, tdz: td.z, apx: a.x, apz: a.z }
      return { ...chart, chart }
    })
    h.lens(lens)
    const pose = underway(h)
    expect(h.carrier_fore_aft(lens.tdx, lens.tdz)).toBeCloseTo(-60, 6)
    expect(h.carrier_lateral(lens.tdx, lens.tdz)).toBeCloseTo(-12, 6)
    expect(h.carrier_fore_aft(lens.x, lens.z)).toBeCloseTo(-80, 6)
    expect(Math.atan2(-lens.apz, lens.apx)).toBeCloseTo(pose.heading + Math.PI - 2 * Math.PI, 6)
  })

  it('moves the stored TACAN station with the beacon on the ship, and no other', () => {
    const h = harness()
    const pose = underway(h)
    expect(h.stations[0]).toMatchObject({ x: pose.x, z: pose.z })
    expect(h.stations[1]).toMatchObject({ x: 5, z: 5 })
  })

  it('draws a remote jet on the deck where the ship is now, and one on the approach where it flies', () => {
    const h = harness()
    const pose = underway(h)
    const then = { x: pose.x - 1.5 * Math.cos(pose.heading), z: pose.z + 1.5 * Math.sin(pose.heading), heading: pose.heading - 0.003, closed: true }
    h.poses.set(NOW - 0.1, then)
    const spot = (fa: number, lat: number, y: number): Remote => {
      const c = Math.cos(then.heading),
        s = Math.sin(then.heading)
      return { pos: new THREE.Vector3(then.x + fa * c + lat * s, y, then.z - fa * s + lat * c), group: new THREE.Object3D() }
    }
    const parked = spot(-30, 10, h.carrier.deckY + 2.5)
    h.deck_carry(parked, NOW - 0.1)
    expect(h.carrier_fore_aft(parked.pos.x, parked.pos.z)).toBeCloseTo(-30, 6)
    expect(h.carrier_lateral(parked.pos.x, parked.pos.z)).toBeCloseTo(10, 6)
    expect(new THREE.Euler().setFromQuaternion(parked.group.quaternion, 'YXZ').y).toBeCloseTo(0.003, 9)
    const flying = spot(-600, 0, h.carrier.deckY + 60)
    const was = flying.pos.clone()
    h.deck_carry(flying, NOW - 0.1)
    expect(flying.pos.equals(was)).toBe(true)
    const low = spot(-30, 10, h.carrier.deckY + 10) // half way through the fade
    h.deck_carry(low, NOW - 0.1)
    expect(h.carrier_fore_aft(low.pos.x, low.pos.z)).toBeCloseTo(-30 - 0.75, 1) // the spot it held 1.5 m aft of the live one, carried half way
  })

  it('carries a start laid against the ship before the core came up, and re-aims one that only points at it', () => {
    const h = harness()
    const spot = h.carrier_world(45, -0.6)
    h.ownship.pos.set(spot.x, 22, spot.z)
    h.ownship.fwd.set(Math.cos(h.chart.yaw), 0, -Math.sin(h.chart.yaw))
    h.ownship.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), h.chart.yaw)
    h.placed({ x: h.chart.x, y: h.carrier.deckY, z: h.chart.z, turn: h.turn() })
    const pose = underway(h)
    h.carry_start()
    expect(h.carrier_fore_aft(h.ownship.pos.x, h.ownship.pos.z)).toBeCloseTo(45, 6)
    expect(h.carrier_lateral(h.ownship.pos.x, h.ownship.pos.z)).toBeCloseTo(-0.6, 6)
    expect(h.ownship.pos.y).toBeCloseTo(22, 9)
    expect(Math.atan2(-h.ownship.fwd.z, h.ownship.fwd.x)).toBeCloseTo(pose.heading, 9)
    const nose = new THREE.Vector3(1, 0, 0).applyQuaternion(h.ownship.q)
    expect(Math.atan2(-nose.z, nose.x)).toBeCloseTo(pose.heading, 9)
    h.carry_start() // once only
    expect(h.carrier_fore_aft(h.ownship.pos.x, h.ownship.pos.z)).toBeCloseTo(45, 6)
    // an air start aimed at the ship is aimed at where it is now
    h.ownship.pos.set(h.chart.x + 20000, 1500, h.chart.z)
    h.placed({ aim: true })
    h.carry_start()
    expect(h.ownship.fwd.x).toBeCloseTo((pose.x - h.ownship.pos.x) / Math.hypot(pose.x - h.ownship.pos.x, pose.z - h.ownship.pos.z), 9)
    expect(h.ownship.vel_dir.equals(h.ownship.fwd)).toBe(true)
  })

  it('carries a start onto a ship that floats lower and leans, as she does on the curved sea away from her chart', () => {
    const h = harness()
    const spot = h.carrier_world(45, -0.6)
    h.ownship.pos.set(spot.x, 22, spot.z)
    h.ownship.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), h.chart.yaw)
    h.placed({ x: h.chart.x, y: h.carrier.deckY, z: h.chart.z, turn: h.turn() })
    h.poses.set(NOW, { x: h.chart.x + 20000, z: h.chart.z - 4000, heading: h.chart.yaw + 0.3, closed: false, y: 12.1, lean: 0.004 })
    h.carrier_pose(NOW)
    h.carry_start()
    // in her own axes the jet is where it was spotted on her: 45 m forward, 2.1 m up, 0.6 m to port
    const turn = h.turn()
    const aboard = h.ownship.pos.clone().sub(new THREE.Vector3(h.carrier.x, h.carrier.deckY, h.carrier.z)).applyQuaternion(turn.clone().invert())
    expect(aboard.x).toBeCloseTo(45, 9)
    expect(aboard.y).toBeCloseTo(2.1, 9)
    expect(aboard.z).toBeCloseTo(-0.6, 9)
    expect(h.ownship.pos.y).toBeCloseTo(12.1 + 2.1 + 45 * Math.sin(0.004), 3) // lower with her, and up her rising bow
    expect(h.ownship.q.angleTo(turn)).toBeLessThan(1e-7) // and sat as level on her deck as it was spotted
  })

  it('reads the deck where the ship floats now: risen through her lean from where she sits, and as built inside with_charted', () => {
    const h = harness()
    const cell = 1.5
    const W = Math.ceil(300 / cell)
    const H = Math.ceil(80 / cell)
    h.grid({ data: new Float32Array(W * H).fill(19.9 + 1.5), W, H, cell, minFa: -150, minLat: -40 }) // a deck 1.5 m over her reference, built at 19.9 m
    h.poses.set(NOW, { x: h.chart.x + 20000, z: h.chart.z - 4000, heading: h.chart.yaw + 0.3, closed: false, y: 12.1, lean: 0.004 })
    h.carrier_pose(NOW)
    const at = h.carrier_world(45, -0.6)
    const rise = new THREE.Vector3(45, Math.fround(19.9 + 1.5) - 19.9, -0.6).applyQuaternion(h.turn()) // over her reference as built at 19.9 m; the grid holds single precision
    expect(h.deck_y_at(null, at.x, at.z, -1e9)).toBeCloseTo(12.1 + rise.y, 9)
    expect(h.deck_y_at(null, h.carrier.x + 1000, h.carrier.z, -1e9)).toBe(-1e9) // off the deck
    // inside with_charted, the height the deck was built at
    expect(h.with_charted(() => { const c = h.carrier_world(45, -0.6); return h.deck_y_at(null, c.x, c.z, -1e9) })).toBeCloseTo(19.9 + 1.5, 6)
  })
})

describe('spotting on the catapult under way', () => {
  it('puts the nose gear on the shuttle and the jet down the track as the ship heads now, not as the map charts it', () => {
    const spot = new Function(
      'THREE',
      `const D2R=Math.PI/180, SHIP={ yaw:110, bow:90, catapults:[{ x:48, z:-0.6, heading:1.6 }] }, CARRIER={ x:-8500, z:-2500, deckY:19.9 };
      const AIRCRAFT_MODELS={ fa18c:{ nose:5.3 } }, own_aircraft=()=>"fa18c", carrier_model=null, cat_idx=0, stance_of=()=>2.46, world_up=new THREE.Vector3(0,1,0);
      const ownship={ pos:new THREE.Vector3(), fwd:new THREE.Vector3(), vel_dir:new THREE.Vector3(), q:new THREE.Quaternion() };
      let CARRIER_YD=(SHIP.yaw-SHIP.bow)*D2R+0.9, CARRIER_C=Math.cos(CARRIER_YD), CARRIER_S=Math.sin(CARRIER_YD);   // the ship has turned 0.9 rad from its charted heading
      ${lift('carrier_fore_aft')}${lift('carrier_lateral')}${lift('place_on_cat')}
      place_on_cat(0);
      const nose={ x:ownship.pos.x+ownship.fwd.x*5.3, z:ownship.pos.z+ownship.fwd.z*5.3 };
      return { fa:carrier_fore_aft(nose.x,nose.z), lat:carrier_lateral(nose.x,nose.z), heading:Math.atan2(-ownship.fwd.z,ownship.fwd.x)-CARRIER_YD };`
    )(THREE) as { fa: number; lat: number; heading: number }
    expect(spot.fa).toBeCloseTo(48, 6)
    expect(spot.lat).toBeCloseTo(-0.6, 6)
    expect(spot.heading).toBeCloseTo((1.6 * Math.PI) / 180, 6) // the catapult's own heading on the deck
  })

  // Handed to the core at rest over the sea, a jet on the deck of a ship under way had the deck run 0.2 m out from
  // under it before the catapult snatched it up to her speed, and the nose rocked +4.1 then -1.7 degrees for a second
  // and a half (measured in the built app, single player's 2.6 m/s).
  const pushed = (speed: number) => new Function(`const STATE={ position:0, velocity:3, attitude:6, omega:10, fuel:13, engine:14, stabilator:22, demand:33, normal:34, extension:35, catapult:36, stroke:37, wire:38, wow:39, contact:40, touch:41, engine_harm:45, stress:54, time:55, element:57, gear_harm:106 };
    let flight_active=true, prev_wire=0, test_active=false, sent=null, asked=null; const b=new Float64Array(117);
    const ownship={ flown:true, grounded:true, speed:${speed}, throttle:0, pos:{ x:-18457, y:22.4, z:7484 }, vel_dir:{ x:1, y:0, z:0 }, q:{ w:1, x:0, y:0, z:0 }, gearTarget:0 };
    const mission_start=()=>"carrier", flight_get=()=>b, flight_set=(state)=>{ sent=Array.from(state); }, sync_core=()=>{}, ground_height=()=>19.94, stance_of=()=>2.46, FUEL=()=>4000, stores_book=null;
    const flight_footing=(x,y,z)=>{ asked=[x,y,z]; return { x:2.44, y:0, z:-0.89 }; };   // the deck's own velocity where the jet sits
    ${/\nconst IDLE=[^\n]*\n/.exec(source)?.[0] ?? ''} ${lift('flight_push')}
    flight_push(); return { velocity:sent.slice(3,6), asked };`)() as { velocity: number[]; asked: number[] }
  it("hands the core a jet spotted on the deck moving with her deck, not at rest over the sea", () => {
    const parked = pushed(0)
    expect(parked.velocity).toEqual([2.44, 0, -0.89])
    expect(parked.asked).toEqual([-18457, expect.closeTo(22.4, 9), 7484]) // the deck's velocity where the jet is, its wheels rested on the deck
    expect(pushed(10).velocity).toEqual([12.44, 0, -0.89]) // a composed roll on the deck rolls over it
  })
})

describe("the carrier's island", () => {
  it("is the ship's own prism and mast, in its frame, whatever the ship has done since the deck was surveyed", () => {
    const island = new Function(
      'THREE',
      `const D2R=Math.PI/180, SHIP={ yaw:110, bow:90 }, CARRIER={ x:-18500, z:7500, deckY:19.9 }, carrier_model={};
      ${line(/^let CARRIER_YD=[^\n]*/m)}
      ${line(/^const CHART=[^\n]*/m)}
      ${line(/^let island_prism=[^\n]*/m)}
      ${lift('charted')}${lift('carrier_set')}${lift('carrier_world')}
      const mast=carrier_world(-61.8,30.5);   // surveyed where the map charts the ship
      const deck_grid={ island:{ minFa:-84.7, maxFa:-36.1, minLat:22.8, maxLat:43.1, top:42.8 }, mast:{ x:mast.x, y:61.2, z:mast.z } };
      carrier_set(CARRIER.x+4000, CARRIER.z-2500, CARRIER_YD+1.2);   // and the ship has since steamed and turned
      ${lift('carrier_island')}
      return carrier_island();`
    )(THREE) as { prism: { outline: { x: number; z: number }[]; top: number }; post: { position: { x: number; z: number }; radius: number; top: number } }
    expect(island.prism.outline).toEqual([
      { x: -84.7, z: 22.8 },
      { x: -36.1, z: 22.8 },
      { x: -36.1, z: 43.1 },
      { x: -84.7, z: 43.1 },
    ])
    expect(island.prism.top).toBe(42.8)
    expect(island.post.position.x).toBeCloseTo(-61.8, 6)
    expect(island.post.position.z).toBeCloseTo(30.5, 6)
    expect(island.post.top).toBe(61.2)
  })
})

describe('the carrier under way in recordings', () => {
  it('records the ship by its compass heading, and a replay turns that back into the heading it steamed on', () => {
    const recorded = /yaw:(\(degrees\(Math\.atan2\(CARRIER_C,CARRIER_S\)\)\+360\)%360),[^\n]*\n\t\tname:"Nimitz", label:SHIP\.ident, colour:"Blue", kind:"Sea\+Watercraft\+AircraftCarrier" \}\);\n\tfor\(const o of list\)[^\n]*\n\trecorder\.add\(sim_time,list\); \}/.exec(source)?.[1]
    const replayed = /if\(type\.includes\("Watercraft"\)\)\{ carrier_place\(pose,([^;]*)\); continue; \}/.exec(source)?.[1]
    expect(recorded).toBeTruthy()
    expect(replayed).toBe('pose.yaw*D2R') // the compass heading, which carrier_place turns back into the engine's
    expect(lift('carrier_place')).toMatch(/heading=Math\.PI\/2-yaw;/)
    const compass = new Function('CARRIER_C', 'CARRIER_S', `const degrees=(v)=>v*180/Math.PI; return ${recorded};`) as (c: number, s: number) => number
    const back = new Function('pose', `const D2R=Math.PI/180, yaw=${replayed}; return Math.PI/2-yaw;`) as (pose: { yaw: number }) => number
    expect(compass(Math.cos(0.349), Math.sin(0.349))).toBeCloseTo(70, 1) // into the trade wind from 070
    for (let heading = -3; heading <= 3; heading += 0.25) {
      const yaw = compass(Math.cos(heading), Math.sin(heading))
      expect(yaw).toBeGreaterThanOrEqual(0)
      expect(yaw).toBeLessThan(360)
      const again = back({ yaw })
      expect(Math.cos(again)).toBeCloseTo(Math.cos(heading), 9)
      expect(Math.sin(again)).toBeCloseTo(Math.sin(heading), 9)
    }
  })

  it('replays a recording without the ship against the ship where the map charts it', () => {
    expect(lift('playback_arm')).toMatch(/^function playback_arm\(text\)\{\n\tcarrier_place\(theatre_point\(HOME\.sea\(CHART\.x,CHART\.z\)\.point\),Math\.PI\/2-CHART\.yaw\);/)
    expect(lift('carrier_pose')).toMatch(/carrier_hang\(d\.position,d\.quaternion\);/)
  })
})

describe('the carrier under way in the engine', () => {
  it('steers single player and poses the ship at the jet clock every frame, after the core steps', () => {
    expect(source).toMatch(/\tsync_core\(out\); last_out=out;\n\tif\(!MULTIPLAYER\) flight_steer\(\); carrier_pose\(out\[STATE\.time\]\);/)
  })

  it('sets the ship under way as the core comes up, before the jet is handed to it', () => {
    expect(source).toMatch(
      /if\(MULTIPLAYER\) flight_voyage\(ship_track\|\|net\.welcome\.spawn\.ship\); else flight_plan\(\);[^\n]*\n\t+carrier_pose\(flight_get\(\)\[STATE\.time\]\|\|0\); if\(MULTIPLAYER\) placed=null; else carry_start\(\);\n\t+joust_drawn\(\); flight_active=true; flight_push\(\);/
    )
    expect(lift('reset_ownship')).toMatch(/placed=\(st==="carrier"\|\|st==="case1"\|\|st==="case2"\|\|st==="case3"\)\?\{ x:CARRIER\.x, y:CARRIER\.deckY, z:CARRIER\.z, turn:carrier_turn\.clone\(\) \}/)
    // the frame onto the spawn as the core comes up, before anything is flown or judged there
    expect(source).toMatch(/joust_drawn\(\); flight_active=true; flight_push\(\);\n\t+theatre_follow\(\);/)
  })

  it("takes a match's track from its ship events", () => {
    expect(source).toMatch(/case "ship": ship_track=e\.ship; if\(flight_active\) flight_voyage\(e\.ship\); break;/)
  })

  it('builds the model, its far model and the deck aids where the map charts the ship, on the rig', () => {
    const model = lift('init_carrier_model')
    expect(model).toMatch(/grp\.position\.set\(CHART\.x,0,CHART\.z\);/)
    expect(model).toMatch(/with_charted\(\(\)=>build_deck_grid\(grp, st\.deckY-waterline\)\);/)
    expect(model).toMatch(/carrier_model=grp; carrier_rig\.add\(grp\);/)
    expect(model).toMatch(/with_charted\(\(\)=>rig_adopt\(\(\)=>\{ CARRIER\.deckY=CARRIER\.height=deck_y_at\([^\n]*\n\t+build_carrier_deck_aids\(\); \}\)\);[^\n]*\n\t+ols_follow\(\);/)
    expect(model).not.toMatch(/scene\.add\(grp\)/)
  })

  it('places what follows the jet on the deck in the frame of the rig it hangs from', () => {
    expect(lift('update_shuttles')).toMatch(/rig_local\(s\.mesh\.position\)\.y=s\.home\.y;/)
    expect(lift('update_wire_drag')).toMatch(/const h=rig_local\(_wireApex\.set\(hx,hy,hz\)\); hx=h\.x; hz=h\.z;[^\n]*\n\tseg_between\(o\.vsegs\[0\]/)
  })

  it('draws remote jets on the deck where the ship is', () => {
    expect(source).toMatch(/deck_carry\(st,net\.render\(\)\+1\/60\);[^\n]*\n\t\tst\.group\.position\.copy\(st\.pos\);/)
  })

  it('waves off a jet in close while the deck is closed, as a foul deck', () => {
    expect(source).toMatch(/\|\| \(deck_closed && s\.along<1200\);/)
    expect(source).toMatch(/pass_end\(deck_closed\?"foul":"waveoff"\)/)
  })
})
