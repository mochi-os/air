// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
// The rig contract's joints (claude/plans/air-fa18c.md, Joints and Schedules):
// a model built by tools/fa18c writes its joints into its points file
// (fa18c.json), and these pose them. Every joint rests at identity, its
// origin on its hinge and its axis in the aircraft frame, so a joint's pose
// is its rest composed with one rotation about the axis, one slide along it,
// a bend (a turn about the axis, then a slide along its direction), a
// show or hide, or its shape keys' weights. Each output is the joint's keys
// read piecewise linearly at the drive's value, held at the ends.
import * as THREE from 'three'

export type Keys = number[][]

export interface Joint {
  motion: 'rotate' | 'slide' | 'show' | 'bend' | 'morph'
  axis?: number[]
  direction?: number[]
  drive?: string
  keys?: Keys
  morphs?: Record<string, { drive: string; keys: Keys }>
}

// schedule reads keys [[input, output, ...], ...] at input: piecewise linear
// between keys in increasing input, held at the ends. column picks the
// output (a bend's keys carry two: turn and slide).
export function schedule(keys: Keys, input: number, column = 1): number {
  if (!keys.length || !Number.isFinite(input)) return keys.length ? keys[0][column] : 0
  if (input <= keys[0][0]) return keys[0][column]
  const last = keys[keys.length - 1]
  if (input >= last[0]) return last[column]
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1]
    const b = keys[i]
    if (input <= b[0]) {
      const span = b[0] - a[0]
      const f = span > 0 ? (input - a[0]) / span : 1
      return a[column] + (b[column] - a[column]) * f
    }
  }
  return last[column]
}

// roll wraps a wheel's turning angle into one turn, [-pi, pi): a wheel's
// keys span half a turn either way, and it rolls without end.
export function roll(angle: number): number {
  if (!Number.isFinite(angle)) return 0
  const turn = Math.PI * 2
  return ((((angle + Math.PI) % turn) + turn) % turn) - Math.PI
}

export interface Morph {
  mesh: THREE.Mesh
  index: number
  drive: string
  keys: Keys
}

export interface Posed {
  name: string
  object: THREE.Object3D
  joint: Joint
  axis: THREE.Vector3 | null
  direction: THREE.Vector3 | null
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  morphs: Morph[]
}

// meshes are a joint's own meshes: the node itself, or the primitives the
// loader hangs under it when a mesh has several materials, never another
// joint below it.
function meshes(object: THREE.Object3D, names: Set<string>): THREE.Mesh[] {
  const own = object as THREE.Mesh
  if (own.isMesh) return [own]
  return object.children.filter(
    (c) => (c as THREE.Mesh).isMesh && !names.has(c.name)
  ) as THREE.Mesh[]
}

// rig finds each joint's node in a scene (one cloned for this aircraft) and
// records its rest. A joint whose node the scene lacks is left out: a model
// and its points file come from one build, so that is a stale copy, which
// the tests catch.
export function rig(scene: THREE.Object3D, joints: Record<string, Joint>): Posed[] {
  const names = new Set(Object.keys(joints))
  const out: Posed[] = []
  for (const [name, joint] of Object.entries(joints)) {
    const object = scene.getObjectByName(name)
    if (!object) continue
    const morphs: Morph[] = []
    for (const [key, morph] of Object.entries(joint.morphs || {})) {
      for (const mesh of meshes(object, names)) {
        const index = mesh.morphTargetDictionary?.[key]
        if (index !== undefined) morphs.push({ mesh, index, drive: morph.drive, keys: morph.keys })
      }
    }
    out.push({
      name,
      object,
      joint,
      axis: joint.axis ? new THREE.Vector3(...joint.axis).normalize() : null,
      direction: joint.direction ? new THREE.Vector3(...joint.direction).normalize() : null,
      position: object.position.clone(),
      quaternion: object.quaternion.clone(),
      morphs,
    })
  }
  return out
}

const turn = new THREE.Quaternion()

// pose sets every joint from its drive's value: value(drive, joint name)
// returns the drive's value, or undefined to hold the joint where it is (an
// aircraft whose state carries no such channel).
export function pose(
  posed: Posed[],
  value: (drive: string, name: string) => number | undefined
): void {
  for (const p of posed) {
    const j = p.joint
    if (j.drive && j.keys) {
      const v = value(j.drive, p.name)
      if (v !== undefined) {
        switch (j.motion) {
          case 'rotate':
            if (p.axis) p.object.quaternion.copy(p.quaternion).multiply(turn.setFromAxisAngle(p.axis, schedule(j.keys, v)))
            break
          case 'slide':
            if (p.axis) p.object.position.copy(p.position).addScaledVector(p.axis, schedule(j.keys, v))
            break
          case 'show':
            p.object.visible = schedule(j.keys, v) > 0.5
            break
          case 'bend':
            if (p.axis) p.object.quaternion.copy(p.quaternion).multiply(turn.setFromAxisAngle(p.axis, schedule(j.keys, v, 1)))
            if (p.direction) p.object.position.copy(p.position).addScaledVector(p.direction, schedule(j.keys, v, 2))
            break
        }
      }
    }
    for (const m of p.morphs) {
      const v = value(m.drive, p.name)
      if (v !== undefined && m.mesh.morphTargetInfluences) m.mesh.morphTargetInfluences[m.index] = schedule(m.keys, v)
    }
  }
}
