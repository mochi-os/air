// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import ford from '../assets/ford.json'
import { split } from './model'
import { type Contract, foul, layout } from './ship'

// The carrier's deck layout lives in one file beside its model, which its build
// writes (tools/ford/build.py) and engine.ts reads through ship.ts: the
// catapults the jet flies, the wires it catches, the lens and lights it sees and
// the deck the model paints are one set of numbers. engine.ts cannot be imported
// (WebGL at module scope), so its pieces are read as text.
const source = readFileSync(
  fileURLToPath(new URL('./engine.ts', import.meta.url)),
  'utf8'
)
const ship = layout(ford as unknown as Contract)

// a function of engine.ts by name, to run with stand-ins
function lift(name: string): string {
  const start = source.search(new RegExp(`function ${name}\\(`))
  if (start < 0) throw new Error(`${name} not found in engine.ts`)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0)
      return source.slice(start, i + 1) + '\n'
  }
  throw new Error(`${name} never closes`)
}

interface Point {
  x: number
  y: number
  z: number
}
interface Carrier {
  deck: { x: number; z: number }[]
  catapults: {
    position: Point
    heading: number
    stroke: number
    speed: number
  }[]
  wires: { a: Point; b: Point }[]
}

// Runs scenery() and the landing-line helpers it uses over the real ship file.
function carrier(): Carrier {
  const scenery =
    /function scenery\(\)\{[\s\S]*?return \{ sea:3, fields, carrier, prisms, posts \};[^\n]*\n\}/.exec(
      source
    )?.[0] ?? ''
  const strip = /function strip_lat\(fa\)\{[^\n]*\n/.exec(source)?.[0] ?? ''
  const unit = /const _slen=[^\n]*\n/.exec(source)?.[0] ?? ''
  if (!scenery || !strip || !unit)
    throw new Error(
      'scenery, strip_lat or the landing line unit not found in engine.ts'
    )
  const run = new Function(
    'SHIP',
    `const ISLAND_H=3.5, AIRFIELD_FLOAT=1.46, RUNWAY_FLOAT=1.5, D2R=Math.PI/180, CARRIER_YD=0;
    const CARRIER={x:0,z:0,deckY:20}, CHART={x:0,z:0,yaw:0}, physics_strips=[], runway_strips=[], obstacles={ islands:[], buildings:[], posts:[] }, carrier_island=()=>null;
    ${strip}${unit}${scenery}
    return scenery().carrier;`
  ) as (ship: unknown) => Carrier
  return run({ ...ship })
}

describe("the carrier's ship file", () => {
  it('is what the engine flies and draws, with no copy of its numbers in the engine', () => {
    expect(source).toMatch(/import ford_ship from '\.\.\/assets\/ford\.json'/)
    expect(source).toMatch(
      /const CARRIER_MODELS=\{\n(?:\t\/\/[^\n]*\n)*\tford:\{ url:ford_model_url,[^\n]*\n(?:\t\t[^\n]*\n)*\t\t\.\.\.ship_layout\(ford_ship[^\n]*\) \} \};/
    )
    const numbers = [
      ...ford.catapults.flatMap((c) => [
        c.x,
        c.z,
        c.heading,
        c.deflector.x,
        c.deflector.z,
      ]),
      ...ford.landing.line.flat(),
      ...ford.landing.wires.flatMap((w) => [
        w.x,
        ...w.ends.flatMap((e) => [e[0], e[2]]),
      ]),
      ford.lens.position[0],
      ford.lens.position[2],
    ]
      .map(String)
      .filter(
        (n) =>
          n.includes('.') && n.replace(/\D/g, '').replace(/^0+/, '').length >= 4
      ) // long enough not to turn up by chance
    expect(numbers.length).toBeGreaterThan(15)
    for (const n of numbers)
      expect(source, n).not.toMatch(
        new RegExp(`(?<![\\d.])${n.replace('.', '\\.')}(?![\\d])`)
      )
  })

  it('gives the flight core each catapult as it stands in the file', () => {
    const c = carrier()
    expect(c.catapults).toHaveLength(ford.catapults.length)
    ford.catapults.forEach((want, i) => {
      const { heading, ...rest } = c.catapults[i]
      expect(rest).toEqual({
        position: { x: want.x, y: 0, z: want.z },
        stroke: want.stroke,
        speed: want.speed,
      })
      expect(heading).toBeCloseTo((want.heading * Math.PI) / 180, 12)
    })
    expect(c.deck).toEqual(ford.deck.outline.map(([x, z]) => ({ x, z })))
  })

  it('runs each wire between the sheaves the file measures, across the landing line', () => {
    const c = carrier()
    expect(c.wires).toHaveLength(ford.landing.wires.length)
    ford.landing.wires.forEach((wire, i) => {
      const { a, b } = c.wires[i]
      expect([a.x, a.z, b.x, b.z]).toEqual([
        wire.ends[0][0],
        wire.ends[0][2],
        wire.ends[1][0],
        wire.ends[1][2],
      ])
      // the pendant crosses the line where the file says, along it from the ramp
      const [[ax, az], [bx, bz]] = ford.landing.line
      const crossing = ship.landing.wires[i]
      const z = az + ((crossing - ax) * (bz - az)) / (bx - ax)
      const t = (crossing - a.x) / (b.x - a.x)
      expect(a.z + (b.z - a.z) * t).toBeCloseTo(z, 6)
    })
    expect(ship.landing.target).toBe(2)
  })

  it("raises each catapult's own blast deflector through its keys, its struts following it", () => {
    expect(source).toMatch(
      /carrier_jbds=rigged\?SHIP\.catapults\.map\(\(cat,i\)=>\(\{ joint:`catapult_\$\{i\+1\}_deflector`, followers:SHIP\.followers\[`catapult_\$\{i\+1\}_deflector`\]\?\?\[\], time:0 \}\)\):null;/
    )
    // in real time along its keys, seconds into its raise, and back along them to lower
    // the catapult our jet is hooked to: spotted, or in its stroke
    expect(source).toMatch(/const active=ownship\.launching\?cat_idx:on_cat_spot\(\);\n\tfor\(let i=0;i<carrier_jbds\.length;i\+\+\)\{ const j=carrier_jbds\[i\];\n\t\tconst keys=SHIP\.joints\[j\.joint\]\.keys, up=keys\[keys\.length-1\]\[0\], tgt=i===active\?up:0;/)
    expect(source).toMatch(/j\.time=THREE\.MathUtils\.clamp\(j\.time\+THREE\.MathUtils\.clamp\(tgt-j\.time,-dt,dt\),0,up\);/)
    expect(source).toMatch(/const angle=joints_schedule\(keys,j\.time\);/)
    expect(source).not.toMatch(/import \{[^}]*TRAVEL[^}]*\} from '\.\/ship'/)
    expect(source).toMatch(
      /for\(const f of j\.followers\) ship_joint\(f,joints_schedule\(SHIP\.joints\[f\]\.keys,angle\)\);/
    )
    for (const [i] of ship.catapults.entries()) {
      const name = `catapult_${i + 1}_deflector`
      expect(ship.joints[name], name).toBeDefined()
      expect(ship.followers[name], name).toEqual([`${name}_crank`, `${name}_rod`])
      const keys = ship.joints[name].keys
      expect(keys[keys.length - 1][0], name).toBeCloseTo(3.7)   // the measured raise, in seconds
    }
  })

  it('draws every group of the lights the file gives, in a colour and a group the engine knows', () => {
    expect(source).toMatch(
      /for\(const \[name,g\] of Object\.entries\(SHIP\.lights\|\|\{\}\)\)\{/
    )
    const colours = /const COLOURS=\{ ([^}]*) \};/.exec(source)?.[1] ?? ''
    expect(Object.keys(ford.lights).length).toBeGreaterThan(5)
    for (const [name, g] of Object.entries(ford.lights)) {
      expect(colours, name).toContain(`${g.colour}:`)
      expect(
        ['recovery', 'outline', 'navigation', 'flood', 'beacon', 'status'],
        name
      ).toContain(g.kind)
      expect(g.positions.length, name).toBeGreaterThan(0)
    }
    // a beacon or status light turns green too
    expect(colours).toContain('green:')
    // the lens's own lights where the file measures them
    expect(ford.lens.lights.datum.length).toBe(20)
    expect(source).toMatch(
      /const dpos=lens\?placed\(lens\.lights\.datum\):\[\];/
    )
  })

  it('draws a beacon or status light green where its green lamps stand, or at its red ones', () => {
    expect(source).toMatch(
      /if\(signal\) sets\.green=\[glow_points\(laid\(g\.green\?\?g\.positions,0\),COLOURS\.green,size\)\];/
    )
  })

  it('lays the drop line on its pole, none in its gap, and the beacons and status lights where the facts put them', () => {
    // the pole (tools/ford facts.json layout.transom.drop): x -165.3, z 7.45,
    // 16.4 down to 11.65 and 9.0 down to 2.2; the lamps 0.15 m aft of its face
    const drop = ford.lights.drop.positions
    expect(drop.length).toBe(9)
    for (const [x, y, z] of drop) {
      expect(x).toBeCloseTo(-165.6, 6)
      expect(z).toBeCloseTo(7.45, 6)
      expect((y >= 11.65 && y <= 16.4) || (y >= 2.2 && y <= 9.0), `${y}`).toBe(
        true
      )
    }
    // a red and a green globe on each of the island's forward, port and aft
    // faces, within its footprint
    const beacon = ford.lights.beacon as {
      positions: number[][]
      green: number[][]
      colour: string
      kind: string
    }
    expect([beacon.kind, beacon.colour]).toEqual(['beacon', 'red'])
    expect(beacon.green.length).toBe(beacon.positions.length)
    expect(beacon.positions.length).toBe(3)
    beacon.positions.forEach(([x, y, z], i) => {
      const [gx, gy, gz] = beacon.green[i]
      expect(Math.hypot(gx - x, gy - y, gz - z)).toBeLessThan(0.9)
      expect(
        x > -103 && x < -80 && z > 19 && z < 34 && y > ford.deck.height
      ).toBe(true)
    })
    // the status lights, placed by rule: the LSO's windscreen and the port
    // deck edge abeam the lens, lit red and green where they stand
    const status = ford.lights.status as {
      positions: number[][]
      green?: number[][]
      colour: string
      kind: string
    }
    expect([status.kind, status.colour, status.green]).toEqual([
      'status',
      'red',
      undefined,
    ])
    expect(status.positions.length).toBe(2)
    for (const [, , z] of status.positions) expect(z).toBeLessThan(-35)
  })

  it("leaves the deck's vehicles out of the deck and the island, and gives the core their prisms in the ship's frame", () => {
    // a tractor's roof is no deck to taxi onto, nor part of the island's box
    expect(lift('build_deck_grid')).toMatch(
      /grp\.traverse\(o=>\{ if\(!o\.isMesh\|\|!o\.geometry\.attributes\.position\) return;\n\t\tif\(\/\^vehicles\(_\\d\+\)\?\$\/\.test\(o\.name\)\) return;/
    )
    const world = lift('scenery')
    expect(world).toMatch(
      /const parked=SHIP\.vehicles\.map\(v=>\(\{ outline:v\.outline\.map\(q=>\(\{x:q\[0\], z:q\[1\]\}\)\), top:CARRIER\.height\+\(v\.top-SHIP\.deck\) \}\)\);/
    )
    expect(world).toMatch(
      /prisms:\(island\?\[island\.prism\]:\[\]\)\.concat\(parked\)/
    )
  })

  it("parks the deck's vehicles on her deck, clear of the landing area, the catapults' tracks, the parked start's taxi lane and the deck forward of it", () => {
    expect(ship.vehicles.length).toBeGreaterThan(0)
    // the lane the parked start taxis forward through, its wings folded
    // (8.6 m), from behind the spot to 20 m past the island's forward end
    const spot = ship.parking!
    const island = Math.max(
      ...ford.island.prisms.flatMap((p) => p.outline.map((q) => q[0]))
    )
    const lane = {
      x: [spot.x - 10, island + 20],
      z: [spot.z - 4.3, spot.z + 4.3],
    }
    const inside = ([x, z]: number[], outline: number[][]) => {
      let c = false
      for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
        const [xi, zi] = outline[i]
        const [xj, zj] = outline[j]
        if (zi > z !== zj > z && x < xi + ((z - zi) * (xj - xi)) / (zj - zi))
          c = !c
      }
      return c
    }
    const track = ([x, z]: number[]) =>
      Math.min(
        ...ship.catapults.map((c) => {
          const h = (c.heading * Math.PI) / 180
          const [dx, dz] = [Math.cos(h), -Math.sin(h)]
          const t = Math.max(
            0,
            Math.min(c.stroke, (x - c.x) * dx + (z - c.z) * dz)
          )
          return Math.hypot(x - (c.x + dx * t), z - (c.z + dz * t))
        })
      )
    for (const v of ship.vehicles) {
      const xs = v.outline.map((q) => q[0])
      const zs = v.outline.map((q) => q[1])
      for (const q of v.outline) {
        expect(inside(q, ship.outline), `${v.kind} at ${q}`).toBe(true)
        expect(
          foul(ship, { dark: false, closed: false, aboard: q }),
          `${v.kind} at ${q}`
        ).toBe(false)
        expect(track(q), `${v.kind} at ${q}`).toBeGreaterThan(20)
      }
      const overlaps =
        Math.min(...xs) < lane.x[1] &&
        Math.max(...xs) > lane.x[0] &&
        Math.min(...zs) < lane.z[1] &&
        Math.max(...zs) > lane.z[0]
      expect(overlaps, `${v.kind} at ${v.outline}`).toBe(false)
      // nor forward of the lane's end, where jets taxi to the catapults
      expect(Math.max(...xs), `${v.kind} at ${v.outline}`).toBeLessThan(
        lane.x[1]
      )
    }
  })

  it('lights each group as ship.ts lit says for the deck, every frame', () => {
    const papi = lift('update_papi')
    expect(papi).toMatch(
      /const deck=\{ dark, closed:deck_closed, aboard:on\?\[carrier_fore_aft\(p\.x,p\.z\),carrier_lateral\(p\.x,p\.z\)\]:null \};/
    )
    expect(papi).toMatch(
      /for\(const l of ship_lights\)\{ const c=ship_lit\(l\.group,SHIP,deck\); for\(const k in l\.sets\) for\(const m of l\.sets\[k\]\)\{ if\(m\.isLight\)\{ m\.visible=dark; m\.intensity=k===c\?m\.userData\.intensity:0; \} else m\.visible=k===c; \} \}/
    )
  })

  it("has the jet aboard from where it stands, so a deck start's first frame is lit, and switches the floods' spotlights by intensity", () => {
    // the smoothed weight-on-wheels signal begins at 0 at a deck start: the
    // floods lit a few frames late, and a spotlight joining the scene then
    // recompiled every lit material, a stall of most of a second
    const papi = lift('update_papi')
    expect(papi).toMatch(/on=under>-1e8 && p\.y-under<4;/)
    expect(papi).not.toMatch(/squish/)
    expect(source).toMatch(
      /s2\.userData\.intensity=s2\.intensity; s2\.intensity=0; scene\.add\(s2\);/
    )
  })

  it("never draws the lens's cut lights, which the LSO lights only without the radio", () => {
    expect(source).not.toMatch(/placed\(lens\.lights\.cut\)|cutPts/)
    const viewer = readFileSync(
      fileURLToPath(new URL('../components/ModelViewer.tsx', import.meta.url)),
      'utf8'
    )
    expect(viewer).toMatch(/points\(l\.lights\.datum,/)
    expect(viewer).not.toMatch(/l\.lights\.cut/)
  })

  it('lays its deflectors across their tracks and its elevators along the deck edge', () => {
    for (const c of ford.catapults) {
      const h = (c.heading * Math.PI) / 180
      const across =
        (c.deflector.x - c.x) * Math.sin(h) +
        (c.deflector.z - c.z) * Math.cos(h)
      expect(Math.abs(across)).toBeLessThan(c.deflector.width / 2)
      expect(c.deflector.x).toBeLessThan(c.x)
    }
    for (const e of ship.elevators) {
      expect(e.aft).toBeLessThan(e.forward)
      expect([1, -1]).toContain(e.side)
    }
    const [[ax], [bx]] = ford.landing.line
    expect(ax).toBeLessThan(bx)
    for (const [x, z] of ford.deck.outline) {
      expect(x).toBeGreaterThanOrEqual(ford.texture.x[0])
      expect(x).toBeLessThanOrEqual(ford.texture.x[1])
      expect(z).toBeGreaterThanOrEqual(ford.texture.z[0])
      expect(z).toBeLessThanOrEqual(ford.texture.z[1])
    }
  })

  it('finds the deck within 2 m of her bow and of her stern whatever her heading', () => {
    // a deck ending 166.29 m either side of her middle and 30 m out, where the ship stands at x 100, z -50
    const height = new Function(
      'heading',
      'x',
      'z',
      `const CARRIER={ x:100, z:-50, deckY:18.27 }, CARRIER_C=Math.cos(heading), CARRIER_S=Math.sin(heading), carrier_model={};
      let _ground_kind="";
      ${lift('carrier_fore_aft')}${lift('carrier_lateral')}
      const deck_y_at=(m,x,z,f)=>Math.abs(carrier_fore_aft(x,z))<=166.29&&Math.abs(carrier_lateral(x,z))<30?18.27:f;
      const homeward=(p)=>p, land_height=()=>-1e9, chart_point=(p)=>p;
      ${lift('ground_height')}
      return ground_height(x,z);`
    ) as (heading: number, x: number, z: number) => number
    for (const heading of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2])
      for (const along of [164.5, -164.5]) {
        // carrier_world: her frame to the world's
        const x = 100 + along * Math.cos(heading)
        const z = -50 - along * Math.sin(heading)
        expect(height(heading, x, z), `${heading} ${along}`).toBe(18.27)
      }
  })

  it("poses the model's own parts by their joints: a slide along its axis, a turn about it", async () => {
    const THREE = await import('three')
    const pose = new Function(
      'THREE',
      'SHIP',
      'root',
      `const _jointAxis=new THREE.Vector3(), _jointTurn=new THREE.Quaternion(), carrier_model=null;
      ${lift('ship_joint')}${lift('ship_joint_max')}
      return { pose:(name,value)=>ship_joint(name,value,root), most:ship_joint_max };`
    )
    const root = new THREE.Group()
    const shuttle = new THREE.Object3D(),
      deflector = new THREE.Object3D()
    shuttle.name = 'catapult_1_shuttle'
    deflector.name = 'catapult_1_deflector'
    shuttle.position.set(40, 18.3, 5)
    root.add(shuttle, deflector)
    const joints = {
      catapult_1_shuttle: {
        motion: 'slide',
        axis: [0.99, 0, -0.1],
        keys: [
          [0, 0],
          [1, 90],
        ],
      },
      catapult_1_deflector: {
        motion: 'rotate',
        axis: [0, 0, 1],
        keys: [
          [0, 0],
          [1, 0.8727],
        ],
      },
    }
    const { pose: set, most } = pose(THREE, { joints }, root)
    expect(most('catapult_1_shuttle')).toBe(90)
    set('catapult_1_shuttle', 10)
    const along = new THREE.Vector3(0.99, 0, -0.1).normalize()
    expect(shuttle.position.x).toBeCloseTo(40 + 10 * along.x, 9)
    expect(shuttle.position.z).toBeCloseTo(5 + 10 * along.z, 9)
    set('catapult_1_shuttle', 0) // back to its rest, not further along
    expect(shuttle.position.toArray()).toEqual([40, 18.3, 5])
    set('catapult_1_deflector', most('catapult_1_deflector'))
    const tip = new THREE.Vector3(-1, 0, 0).applyQuaternion(
      deflector.quaternion
    )
    expect(tip.y).toBeCloseTo(-Math.sin(0.8727), 6)
    set('missing', 3) // a part the model lacks is left alone
  })

  it("slides the hooked catapult's shuttle under the nose wheel along its track, the others at battery, and raises the manned catapults' control station", () => {
    const set: Record<string, number> = {}
    const run = new Function(
      'set', 'cat_idx',
      `const THREE={ MathUtils:{ clamp:(v,a,b)=>Math.min(Math.max(v,a),b) } }, D2R=Math.PI/180;
      const carrier_shuttles=[{ joint:'catapult_1_shuttle', cat:{ x:40, z:5, heading:5 } }, { joint:'catapult_3_shuttle', cat:{ x:-20, z:-20, heading:0 } }];
      const ownship={ launching:false, pos:{ x:37, z:4.6 }, fwd:{ x:Math.cos(5*D2R), z:-Math.sin(5*D2R) } }, on_cat_spot=()=>cat_idx;
      const AIRCRAFT_MODELS={ fa18c:{ nose:5.3 } }, own_aircraft=()=>'fa18c', carrier_fore_aft=(x,z)=>x, carrier_lateral=(x,z)=>z;
      const ship_joint=(name,value)=>{ set[name]=value; }, ship_joint_max=(name)=>name==='catapult_console_bow'?1.3:name==='catapult_console_waist'?0.7:90;
      ${lift('update_shuttles')} update_shuttles();`
    )
    run(set, 0)
    const h = (5 * Math.PI) / 180
    const wheel = [37 + Math.cos(h) * 5.3, 4.6 - Math.sin(h) * 5.3]
    const travel = (wheel[0] - 40) * Math.cos(h) - (wheel[1] - 5) * Math.sin(h)
    expect(travel).toBeGreaterThan(2) // the nose wheel 2 m on from battery
    expect(set.catapult_1_shuttle).toBeCloseTo(travel, 9)
    expect(set.catapult_3_shuttle).toBe(0)
    expect(set.catapult_console_bow).toBe(1.3)
    expect(set.catapult_console_waist).toBe(0) // the waist's stays down
    const waist: Record<string, number> = {}
    run(waist, 3) // hooked to catapult 4
    expect(waist.catapult_console_waist).toBe(0.7)
    expect(waist.catapult_console_bow).toBe(0)
  })

  it("gives each of the model's textured materials its own image, by name", () => {
    const bytes = readFileSync(
      fileURLToPath(new URL('../assets/ford.glb', import.meta.url))
    )
    const images = new Function(
      'parts',
      `${lift('glb_image')}${lift('carrier_images')} return carrier_images(parts);`
    )(
      split(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        )
      )
    )
    // the deck's paint, the lettering, the nets, the weathered groups (the
    // island, the hull, the island's radomes, the anchors' hawse hoods, tan
    // parts and rust, and the deck's vehicles, white and yellow) with their
    // normal maps, and the boot top's colour alone
    expect(Object.keys(images).sort()).toEqual([
      'boot',
      'corrosion',
      'deck',
      'domes',
      'hawse',
      'hull',
      'island',
      'lettering',
      'net',
      'tackle',
      'trim',
      'vehicles',
    ])
    const head = (src: { bytes: Uint8Array }) =>
      Array.from(src.bytes.slice(0, 8))
    const ktx2 = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb] // «KTX 20»
    for (const name of [
      'deck',
      'lettering',
      'domes',
      'hull',
      'island',
      'boot',
      'hawse',
      'tackle',
      'corrosion',
      'vehicles',
      'trim',
    ]) {
      expect(images[name].base.mime, name).toBe('image/ktx2')
      expect(head(images[name].base), name).toEqual(ktx2)
    }
    for (const name of ['domes', 'hull', 'island']) {
      expect(images[name].normal.mime, name).toBe('image/ktx2')
      expect(head(images[name].normal), name).toEqual(ktx2)
    }
    // the anchors' and the vehicles' groups carry normal maps too, small
    // enough that the packing leaves them as they are (texswap.py encodes 50
    // kB and up)
    for (const name of [
      'hawse',
      'tackle',
      'corrosion',
      'vehicles',
      'trim',
    ]) {
      expect(images[name].normal?.bytes.length, name).toBeGreaterThan(0)
    }
    expect(images.boot.normal).toBeNull()
    expect(head(images.net.base)).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(images.net.base.bytes[25]).toBe(6) // the nets' holes: an image with alpha (IHDR colour type RGBA)
    expect(images.deck.base.bytes.length).not.toBe(
      images.lettering.base.bytes.length
    )
  })

  it("glazes the deck's vehicles: see-through panes over a dark room, not opaque glass", () => {
    const bytes = readFileSync(
      fileURLToPath(new URL('../assets/ford.glb', import.meta.url))
    )
    const { json } = split(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    )
    const mesh = json.meshes.find(
      (m: { name: string }) => m.name === 'vehicles'
    )
    const used = mesh.primitives.map(
      (p: { material: number }) => json.materials[p.material]
    )
    const names = used.map((m: { name: string }) => m.name)
    expect(names).toContain('pane')
    expect(names).toContain('room')
    const pane = used.find((m: { name: string }) => m.name === 'pane')
    expect(pane.alphaMode).toBe('BLEND')
    expect(pane.pbrMetallicRoughness.baseColorFactor[3]).toBeLessThan(1)
  })

  it("measures the island's crash box and mast top from its body, not the walkways and antennas standing off it", async () => {
    const THREE = await import('three')
    const grid = new Function(
      'THREE',
      `const CARRIER={ x:0, z:0 }, CARRIER_C=1, CARRIER_S=0; let deck_grid=null;
      ${lift('carrier_fore_aft')}${lift('carrier_lateral')}${lift('build_deck_grid')}
      return (grp)=>{ build_deck_grid(grp, 18); return deck_grid; };`
    )(THREE)
    const block = (name: string, x: number[], y: number[], z: number[]) => {
      const geometry = new THREE.BoxGeometry(
        x[1] - x[0],
        y[1] - y[0],
        z[1] - z[0]
      )
      geometry.translate(
        (x[0] + x[1]) / 2,
        (y[0] + y[1]) / 2,
        (z[0] + z[1]) / 2
      )
      const mesh = new THREE.Mesh(geometry)
      mesh.name = name
      return mesh
    }
    const root = new THREE.Group()
    // the island's body to y 40, a walkway 1.1 m off its port face 12 m up and its
    // railing, in two materials, which the glTF loader makes a group of that name
    // holding a mesh for each, numbered; a whip over it
    const details = new THREE.Group()
    details.name = 'island_details'
    details.add(
      block('island_details_1', [-90, -85], [30, 30.2], [18.9, 20]),
      block('island_details_2', [-90, -85], [30.2, 31.3], [18.9, 19])
    )
    root.add(
      block('island', [-100, -80], [18, 40], [20, 35]),
      details,
      block('island_details', [-94.1, -94], [40, 60], [30, 30.1])
    )
    root.updateMatrixWorld(true)
    const g = grid(root)
    expect(g.island.minLat).toBeCloseTo(20, 6)
    expect(g.island.top).toBeCloseTo(40, 6)
    expect(g.mast.y).toBeCloseTo(40, 6)
  })

  it('gives a cut-out material a shadow that cuts the same holes, and every other the shared one', async () => {
    const THREE = await import('three')
    const carrier_depth = new THREE.MeshDepthMaterial()
    const shadow = new Function(
      'carrier_depth',
      `${lift('carrier_shadow')} return carrier_shadow;`
    )(carrier_depth)
    const plain = new THREE.MeshStandardMaterial()
    expect(shadow(plain)).toBe(carrier_depth)
    const map = new THREE.Texture()
    const net = new THREE.MeshStandardMaterial({ map, alphaTest: 0.5 })
    const cut = shadow(net)
    expect(cut).not.toBe(carrier_depth)
    expect(cut.map).toBe(map)
    expect(cut.alphaTest).toBe(0.5)
    expect(cut.onBeforeCompile).toBe(carrier_depth.onBeforeCompile)
  })
})
