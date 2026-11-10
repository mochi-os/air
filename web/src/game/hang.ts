// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
// The F/A-18C's stores as our own model carries them (claude/plans/air-fa18c.md
// #9 and the contract's Stores): which of fa18c.glb's store parts a station's
// slot shows, which part carries each of its rounds, and where a missile's own
// model hangs on its part. The engine and the setup preview both hang the
// loadout through here, so the two cannot disagree.
import * as THREE from 'three'
import { entries, type Slot } from './stores'

export type Kind = 'aim9m' | 'aim120c'

export interface Round {
  name: string // the round as stores.ts names it: tip1, 9m2a, 120c4
  part: string // the part it rides: rail_1, rail_2a, launcher_2b, rack_3, ejector_4
  kind: Kind
}

// A hardpoint's round on its part, at rest in the aircraft's frame: where the
// missile's own mount sits, where its nose points, and the side its lugs face.
export interface Seat {
  kind: string
  mount: number[]
  forward: number[]
  up: number[]
}

// KINDS names each round's model by the store code the loadout and the sim
// use for it.
export const KINDS: Record<string, Kind> = { '9m': 'aim9m', '120c': 'aim120c' }

// rounds lists each round a station's slot carries and the part it rides. A
// twin's side carries its round on the rail that suits it (a LAU-7 for an
// AIM-9, a LAU-127 for an AIM-120); a single AIM-9 rides the outboard LAU-7, a
// single AIM-120 the LAU-115's own rail (both decided 2026-11-08); the cheek's
// on its LAU-116.
export function rounds(station: number, slot: Slot): Round[] {
  const out: Round[] = []
  for (const name of entries(station, slot)) {
    if (name.startsWith('tip')) {
      out.push({ name, part: `rail_${station}`, kind: 'aim9m' })
      continue
    }
    const m = /^(9m|120c)(\d)([ab]?)$/.exec(name)
    if (!m) continue
    const kind = KINDS[m[1]]
    const point = m[3]
    let part: string
    if (station === 4 || station === 6) part = `ejector_${station}`
    else if (point)
      part = `${kind === 'aim9m' ? 'rail' : 'launcher'}_${station}${point}`
    else part = kind === 'aim9m' ? `rail_${station}a` : `rack_${station}`
    out.push({ name, part, kind })
  }
  return out
}

// parts lists the store parts a station's slot shows: the wing stations'
// pylon, its LAU-115 when it carries a missile, each round's rail, a tank on
// its pylon; the cheek's LAU-116. The wingtip rails are always fitted, so
// they are never listed. A twin's empty side keeps the rail its other side's
// round needs, a LAU-7 when both are empty.
export function parts(station: number, slot: Slot): string[] {
  if (station === 1 || station === 9 || !slot.fixture) return []
  if (station === 4 || station === 6) return [`ejector_${station}`]
  const shown = new Set<string>([`pylon_${station}`])
  if (slot.fixture === 'twin') {
    shown.add(`rack_${station}`)
    ;(['a', 'b'] as const).forEach((point, i) => {
      const kind = slot.stores[i] || slot.stores[1 - i] || '9m'
      shown.add(`${kind === '120c' ? 'launcher' : 'rail'}_${station}${point}`)
    })
  } else {
    const store = slot.stores[0]
    if (store === 'tank') shown.add(`tank_${station}`)
    else if (store === '9m')
      shown.add(`rack_${station}`).add(`rail_${station}a`)
    else if (store === '120c' || slot.fixture === 'rail')
      shown.add(`rack_${station}`)
  }
  return [...shown]
}

const _f = new THREE.Vector3()
const _u = new THREE.Vector3()
const _z = new THREE.Vector3()
const _m = new THREE.Matrix4()

// place lays a missile's own mount (its points file's, in its frame: x
// forward, y up toward its lugs) on its seat: the missile's position and turn
// in the aircraft's frame at rest.
export function place(
  seat: Seat,
  mount: number[]
): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
  _f.fromArray(seat.forward).normalize()
  _u.fromArray(seat.up)
  _u.addScaledVector(_f, -_u.dot(_f)).normalize()
  _z.crossVectors(_f, _u)
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(
    _m.makeBasis(_f, _u, _z)
  )
  const position = new THREE.Vector3()
    .fromArray(seat.mount)
    .sub(new THREE.Vector3().fromArray(mount).applyQuaternion(quaternion))
  return { position, quaternion }
}
