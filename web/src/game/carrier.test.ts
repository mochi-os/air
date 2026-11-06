// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import ford from '../assets/ford.json'
import { split } from './model'
import { type Contract, layout } from './ship'

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

  it('stands a blast deflector on every catapult, from the file', () => {
    expect(source).toMatch(
      /carrier_jbds=rigged\?[^\n]*:SHIP\.catapults\.map\(cat=>\{\n\t\tconst box=cat\.deflector, L=box\.depth-2\*JBD_INSET\.end, bw=box\.width-2\*JBD_INSET\.side;/
    )
    expect(source).toMatch(
      /const w=carrier_world\(box\.x,box\.z\), hd=cat\.heading\*D2R,/
    )
    expect(source).toMatch(
      /uv\.setXY\(i,\(f2-tx\[0\]\)\/\(tx\[1\]-tx\[0\]\),\(l2-tz\[0\]\)\/\(tz\[1\]-tz\[0\]\)\);/
    )
    expect(source).toMatch(/const tx=SHIP\.texture\.x, tz=SHIP\.texture\.z;/)
  })

  it('draws every group of the lights the file gives, in a colour and a group the engine knows', () => {
    expect(source).toMatch(
      /for\(const \[name,g\] of Object\.entries\(SHIP\.lights\)\)\{/
    )
    const colours = /const COLOURS=\{ ([^}]*) \};/.exec(source)?.[1] ?? ''
    expect(Object.keys(ford.lights).length).toBeGreaterThan(5)
    for (const [name, g] of Object.entries(ford.lights)) {
      expect(colours, name).toContain(`${g.colour}:`)
      expect(['recovery', 'outline', 'navigation', 'flood'], name).toContain(
        g.kind
      )
      expect(g.positions.length, name).toBeGreaterThan(0)
    }
    // the lens's own lights where the file measures them
    expect(ford.lens.lights.datum.length).toBe(20)
    expect(source).toMatch(
      /const dpos=lens\?placed\(lens\.lights\.datum\):\[\];/
    )
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
    // the deck's paint, the lettering, the nets, the three weathered
    // groups (the island, the hull, the island's radomes) with their normal
    // maps, and the boot top's colour alone
    expect(Object.keys(images).sort()).toEqual([
      'boot',
      'deck',
      'domes',
      'hull',
      'island',
      'lettering',
      'net',
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
    ]) {
      expect(images[name].base.mime, name).toBe('image/ktx2')
      expect(head(images[name].base), name).toEqual(ktx2)
    }
    for (const name of ['domes', 'hull', 'island']) {
      expect(images[name].normal.mime, name).toBe('image/ktx2')
      expect(head(images[name].normal), name).toEqual(ktx2)
    }
    expect(images.boot.normal).toBeNull()
    expect(head(images.net.base)).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(images.net.base.bytes[25]).toBe(6) // the nets' holes: an image with alpha (IHDR colour type RGBA)
    expect(images.deck.base.bytes.length).not.toBe(
      images.lettering.base.bytes.length
    )
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
