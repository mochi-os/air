// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

// Distance stages (#3): another aircraft is drawn in full, then as a merged
// medium model, a far silhouette and a dot as it shrinks on screen, and the
// carrier swaps to its far model. engine.ts cannot be imported (WebGL at
// module scope), so the functions are lifted from its text and run with
// stand-ins.
const source = readFileSync(
  fileURLToPath(new URL('./engine.ts', import.meta.url)),
  'utf8'
)

// one function's whole text, from its keyword to its matching brace
function lift(name: string): string {
  const start = source.search(new RegExp(`(async )?function ${name}\\(`))
  if (start < 0) throw new Error(`${name} not found in engine.ts`)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0)
      return source.slice(start, i + 1)
  }
  throw new Error(`${name} never closes`)
}
function line(pattern: RegExp): string {
  const found = pattern.exec(source)?.[0]
  if (!found) throw new Error(`${pattern} not found in engine.ts`)
  return found
}

type Part = { visible: boolean }
interface Stages {
  root: Part
  parts: Part[]
  albedo: THREE.Color
  airframe: Part
  up: Part
  down: Part
  burner: Part
  far: Part
}
interface Jet {
  gear?: number
  group: {
    visible: boolean
    position: THREE.Vector3
    userData: { stages: Stages; stage: number; hasModel: string }
  }
}
interface Harness {
  update_stages(): void
  stage_for(size: number, current: number): number
  screen_size(length: number, distance: number): number
  jet: Jet
  posed: Jet[]
  dots(): THREE.Points | null
  carrier(far: unknown): void
}

function harness(): Harness {
  const part = () => ({ visible: true })
  const stages: Stages = {
    root: part(),
    parts: [part(), part()],
    albedo: new THREE.Color(0.27, 0.27, 0.27),
    airframe: part(),
    up: part(),
    down: part(),
    burner: part(),
    far: part(),
  }
  return new Function(
    'THREE',
    'stages',
    `${line(/^const STAGES=[^\n]*/m)}
    ${line(/^const DOT_SIZE=[^\n]*/m)}
    ${line(/^const CARRIER_LIMIT=[^\n]*/m)}
    ${line(/^const _stage_eye=[^\n]*/m)}
    const D2R=Math.PI/180, camera={ fov:45, getWorldPosition:(v)=>v.set(0,0,0) }, scene={ add(){} };
    const sun={ color:new THREE.Color(1,1,1), intensity:2.4 }, sun_dir=new THREE.Vector3(0,1,0);
    const hemi={ color:new THREE.Color(1,1,1), groundColor:new THREE.Color(0.5,0.5,0.5), intensity:0.9 }, amb={ color:new THREE.Color(1,1,1), intensity:0.4 };
    const AIRCRAFT_MODELS={ fa18c:{ length:17.07 } }, SHIP={ length:333 }, presenting=true, posed=[];
    const screen_point=(m,s)=>{ m.size=s; return m; }, apply_anim=(st)=>posed.push(st);
    let stage_dots=null, carrier_far=null;
    const bandit={ gear:1, group:{ visible:true, position:new THREE.Vector3(), userData:{ stages, stage:-1, hasModel:"fa18c" } } }, remotes=new Map();   // -1: freshly attached, as stages_attach leaves it
    ${lift('screen_size')}
    ${lift('stage_for')}
    ${lift('stage_show')}
    ${lift('dots_build')}
    ${lift('update_stages')}
    return { update_stages, stage_for, screen_size, jet:bandit, posed, dots:()=>stage_dots, carrier:(far)=>{ carrier_far=far; } };`
  )(THREE, stages) as Harness
}

// the jet's on-screen length in reference pixels, at a 45-degree view
function at(h: Harness, distance: number) {
  h.jet.group.position.set(distance, 0, 0)
  h.update_stages()
  return ['full', 'medium', 'far', 'dot'][h.jet.group.userData.stage]
}

describe('distance stages', () => {
  it('measures size on screen in reference pixels, 1/1080 of the view height, at the view the camera has', () => {
    const h = harness()
    // 17.07 m at 280 m fills 17.07/(2*280*tan 22.5°) of the 1080-pixel height
    expect(h.screen_size(17.07, 280)).toBeCloseTo(
      (17.07 * 1080) / (2 * 280 * Math.tan(Math.PI / 8)),
      9
    )
    expect(h.screen_size(17.07, 280)).toBeGreaterThan(79)
    expect(h.screen_size(17.07, 280)).toBeLessThan(80)
  })

  it('draws a jet in full above 80 px, medium to 8, far to 2, then a dot', () => {
    const h = harness()
    expect(at(h, 200)).toBe('full')
    expect(at(h, 1000)).toBe('medium')
    expect(at(h, 5000)).toBe('far')
    expect(at(h, 15000)).toBe('dot')
  })

  it('moves a jet back to a nearer stage only past a 15% margin, so it cannot flicker at a limit', () => {
    const h = harness()
    expect(h.stage_for(79, 0)).toBe(1) // shrinking: out of full at once
    expect(h.stage_for(85, 1)).toBe(1) // growing: still medium within the margin
    expect(h.stage_for(92.1, 1)).toBe(0) // and full past it
    expect(h.stage_for(2.2, 3)).toBe(3)
    expect(h.stage_for(2.31, 3)).toBe(2)
    expect(h.stage_for(100, 3)).toBe(0) // a jump straight back to full
  })

  it('shows each stage alone, the medium one with the gear part for where the gear is', () => {
    const h = harness()
    const s = h.jet.group.userData.stages
    const shown = () => ({
      parts: s.parts.every((p) => p.visible),
      root: s.root.visible,
      airframe: s.airframe.visible,
      up: s.up.visible,
      down: s.down.visible,
      far: s.far.visible,
    })
    at(h, 200)
    expect(shown()).toMatchObject({ parts: true, root: false })
    h.jet.gear = 1
    at(h, 1000)
    expect(shown()).toEqual({
      parts: false,
      root: true,
      airframe: true,
      up: true,
      down: false,
      far: false,
    })
    h.jet.gear = 0
    at(h, 1000)
    expect(shown()).toEqual({
      parts: false,
      root: true,
      airframe: true,
      up: false,
      down: true,
      far: false,
    })
    at(h, 5000)
    expect(shown()).toEqual({
      parts: false,
      root: true,
      airframe: false,
      up: false,
      down: false,
      far: true,
    })
    at(h, 15000)
    expect(shown()).toMatchObject({ parts: false, root: false })
  })

  it('poses the full model afresh as a jet comes back into full view, and not before', () => {
    const h = harness()
    at(h, 1000)
    expect(h.posed).toHaveLength(0)
    at(h, 100)
    expect(h.posed).toEqual([h.jet])
  })

  it('draws the dot at a fixed share of the view, in the jet colour under the light, fading out before its range', () => {
    const h = harness()
    at(h, 15000)
    const dots = h.dots()!
    expect(dots.geometry.drawRange.count).toBe(1)
    expect((dots.material as THREE.PointsMaterial).size).toBe(3) // POINT_HEIGHT pixels: screen_point keeps it 2 reference pixels
    expect((dots.material as THREE.PointsMaterial).sizeAttenuation).toBe(false)
    const colour = dots.geometry.attributes.color
    expect(colour.getW(0)).toBe(1)
    expect(colour.getX(0)).toBeGreaterThan(0)
    at(h, 22500) // inside the last 5 km before 25 km
    expect(h.dots()!.geometry.drawRange.count).toBe(1)
    expect(colour.getW(0)).toBeCloseTo(0.5, 9)
    at(h, 25500)
    expect(h.dots()!.geometry.drawRange.count).toBe(0)
    expect(h.dots()!.visible).toBe(false)
    h.jet.group.visible = false // a jet that is not there
    at(h, 15000)
    expect(h.dots()!.geometry.drawRange.count).toBe(0)
  })

  it('swaps the carrier to its far model under 150 px and back past the margin, keeping the deck parts', () => {
    const h = harness()
    const near = [{ visible: true }, { visible: true }]
    const far = {
      group: { visible: false, position: new THREE.Vector3() },
      near,
      far: false,
    }
    h.carrier(far)
    const place = (d: number) => {
      far.group.position.set(d, 0, 0)
      h.update_stages()
    }
    const limit = h.screen_size(333, 1) / 150 // the distance where the carrier is 150 px long
    place(limit * 0.98)
    expect(far.far).toBe(false)
    place(limit * 1.02)
    expect(far).toMatchObject({ far: true, group: { visible: true } })
    expect(near.every((o) => !o.visible)).toBe(true)
    place(limit * 0.95) // inside the margin: still far
    expect(far.far).toBe(true)
    place(limit / 1.2)
    expect(far.far).toBe(false)
    expect(near.every((o) => o.visible)).toBe(true)
  })
})

describe('distance stages in the engine', () => {
  it('loads the stages after each airframe and hangs them on every other jet, never the ownship', () => {
    expect(source).toMatch(
      /fleet\[kind\]=\{ proto, rig, profile:gun_profile\(proto,AIRCRAFT_MODELS\[kind\]\|\|\{\}\) \};\n\t+void init_far_model\(kind\);/
    )
    expect(source).toMatch(/\tg\.add\(m\);\n\tstages_attach\(g,kind\);/)
    expect(lift('stages_attach')).toMatch(
      /if\(g\.userData\.player\|\|!far\|\|far==="loading"\|\|!m\) return;/
    )
    expect(source).toMatch(/fa18c:\{ url:fa18c_model_url, far:fa18c_far_url,/)
  })

  it('retires the Distance LOD switch, dropping the value saved configs still carry', () => {
    expect(lift('sanitize_cfg')).toMatch(/\tdelete cfg\.lod;/)
    expect(source).not.toMatch(/\blod:true\b/)
  })

  it('picks the stages every presented frame and poses only jets drawn in full', () => {
    expect(source).toMatch(/\tupdate_stages\(\); update_papi\(ownship\.pos\);/)
    expect(source).toMatch(
      /if\(presenting&&!\(st\.group&&st\.group\.userData\.stage>0\)\) apply_anim\(st,dt\);/
    )
  })

  it('loads the carrier far model outside carrier_model, placed as the full one', () => {
    expect(source).toMatch(
      /carrier_model=grp; scene\.add\(grp\);\n\t+void init_carrier_far\(grp,gscene\);/
    )
    const far = lift('init_carrier_far')
    expect(far).toMatch(
      /far\.position\.copy\(grp\.position\); far\.rotation\.copy\(grp\.rotation\); far\.scale\.copy\(grp\.scale\);/
    )
    expect(far).toMatch(/scene\.add\(far\);/)
    expect(far).not.toMatch(/grp\.add\(/)
    expect(source).toMatch(
      /nimitz:\{ url:nimitz_model_url, far:nimitz_far_url,/
    )
  })

  it('ships the stages the engine names and a carrier far model without the deck parts or images', () => {
    const json = (path: string) => {
      const bytes = readFileSync(fileURLToPath(new URL(path, import.meta.url)))
      const length = bytes.readUInt32LE(12)
      return JSON.parse(bytes.subarray(20, 20 + length).toString('utf8'))
    }
    const jet = json('../assets/fa18c-far.glb')
    expect(
      jet.nodes
        .map((n: { name?: string }) => n.name)
        .filter(Boolean)
        .sort()
    ).toEqual(['airframe', 'burner', 'down', 'far', 'up'])
    for (const mesh of jet.meshes)
      expect(Object.keys(mesh.primitives[0].attributes)).toContain('COLOR_0')
    const ship = json('../assets/nimitz-far.glb')
    expect(ship.images ?? []).toHaveLength(0)
    expect(ship.nodes.map((n: { name?: string }) => n.name)).not.toEqual(
      expect.arrayContaining(['deck_baked'])
    )
  })
})
