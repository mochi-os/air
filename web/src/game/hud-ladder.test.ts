// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The pitch ladder rotates about the velocity vector (NATOPS A1-F18AC-NFM-000,
// I-2-102), so the two are drawn from one flight path and the ladder hangs on
// the marker as it is drawn. engine.ts reaches for WebGL at module scope and
// cannot be imported, so it is read as text, as hud-stack.test.ts does. The
// behaviour itself is flown in claude/scripts/air/hudcheck.py parts C and D.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
const conformal = source.slice(source.indexOf('if(flight_symbols){'), source.indexOf('// ---- E bracket'))

describe('the pitch ladder hangs on the velocity vector', () => {
  it('fades the flight path in from the nose rather than switching at a speed', () => {
    // vel_dir switches from the nose to the velocity at 0.5 m/s, and a HUD
    // drawn on it snapped the marker and the ladder sideways as a taxi turn
    // crossed that speed.
    expect(conformal).toMatch(
      /const path=new THREE\.Vector3\(ownship\.velx[^;]*\.addScaledVector\(ownship\.fwd,Math\.max\(0,2-ownship\.speed\)\)/,
    )
    expect(conformal).toMatch(/fpm=proj_dir\(path\)/)
    expect(conformal).not.toMatch(/proj_dir\(ownship\.vel_dir\)/)
  })

  it('keeps the ghost for the NAV cage and not for the limit', () => {
    // I-2-102 item 10: at its limit the velocity vector flashes; the ghost is
    // drawn when the vector is caged and the true position is more than 2° from
    // the caged one. A ghost on every limited marker read as a cage that was
    // never selected.
    expect(source).toMatch(/if\(master==="120c"\)\{[^}]*\} else if\(master==="nav"\) caged=!caged;/)
    expect(conformal).toMatch(/const cage=master==="nav"\?caged:!pa;/)
    expect(conformal).toMatch(/if\(cage\) fpm=\[bore\[0\],truth\[1\]\];/)
    expect(conformal).toMatch(/if\(cage&&Math\.abs\(truth\[0\]-bore\[0\]\)>2\*ppd\) \[ghost,ghost_limited\]=limit\(truth\);/)
    expect(conformal).not.toMatch(/fpm_true/)
  })

  it('cages on the key in NAV, always in the A/A masters, never with the landing symbology', () => {
    // ED manual: "In A/A it is always caged"; the uncage key only toggles NAV.
    const line = /const cage=[^\n]*;/.exec(conformal)?.[0] ?? ''
    const cage = new Function('master', 'pa', 'caged', `${line} return cage;`) as (master: string, pa: boolean, caged: boolean) => boolean
    expect(cage('nav', false, true)).toBe(true)
    expect(cage('nav', false, false)).toBe(false)
    for (const master of ['gun', '9m', '120c']) {
      expect(cage(master, false, false)).toBe(true)
      expect(cage(master, false, true)).toBe(true)
      expect(cage(master, true, true)).toBe(false)
    }
  })

  it('centres the limit, the cage and the boresight symbols on the nose in both first-person views', () => {
    // The HUD view took the screen centre for the boresight, which is where the
    // head looks, and the head holds where it is left: a look 12° up clamped a
    // level flight path to the 10° ring and flashed it (#35).
    const line = /const bore=[^\n]*;/.exec(source)?.[0] ?? ''
    expect(line).toMatch(/^const bore=proj_dir\(ownship\.fwd\)\|\|\[cx,cy\];/)
    const bore = new Function('glass', 'proj_dir', 'ownship', 'cx', 'cy', `${line} return bore;`) as (
      glass: object | null, proj_dir: (d: string) => number[] | null, ownship: { fwd: string }, cx: number, cy: number) => number[]
    const nose = (d: string) => (d === 'nose' ? [300, 500] : null)
    expect(bore(null, nose, { fwd: 'nose' }, 640, 380)).toEqual([300, 500])
    expect(bore({}, nose, { fwd: 'nose' }, 640, 380)).toEqual([300, 500])
    expect(bore(null, () => null, { fwd: 'nose' }, 640, 380)).toEqual([640, 380])
    expect(conformal).toMatch(/const limit=p=>\{ const dx=p\[0\]-bore\[0\], dy=p\[1\]-bore\[1\]/)
  })

  it('references the ladder to the marker as drawn, limit included', () => {
    // On the unlimited flight path the ladder sat a crab angle's width to the
    // side of a marker held at its limit.
    expect(conformal.indexOf('const marked=')).toBeGreaterThan(conformal.indexOf('fpm_limited=true'))
    expect(conformal).toMatch(/const marked=fpm\?/)
    expect(conformal).toMatch(/const ladFwd=new THREE\.Vector3\(marked\.x,0,marked\.z\)/)
  })
})
