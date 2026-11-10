// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
// Shared ordnance helpers (#27). Each round ships as its own GLB named by
// designation, our own build (tools/missiles; claude/plans/air-fa18c.md #9),
// in its own frame: x forward, y toward its lugs, true metres, the origin at
// its centre of gravity. A round on its launcher hangs by its points file
// (hang.ts); a round in flight is drawn by a holder that the engine places at
// the round's position and turns so its x axis points along the flight.
import * as THREE from 'three'
import { KINDS } from './hang'

// holder makes the object a flying round is drawn by: the fallback (a plain
// dart) until dress gives it the round's own model.
export function holder(fallback: THREE.Object3D): THREE.Group {
  const group = new THREE.Group()
  group.add(fallback)
  group.userData.fallback = fallback
  return group
}

// dress shows a holder's round as its kind's model ('9m', '120c', as the sim
// names it): a clone of the loaded prototype, in the model's own frame, which
// prepare sees once before it is shown. The same kind again changes nothing,
// so it can run every frame. With no prototype loaded yet the holder shows its
// fallback and dress returns false, for the caller to fetch the model.
export function dress(
  group: THREE.Object3D,
  kind: string,
  prototypes: Record<string, THREE.Object3D | undefined>,
  prepare?: (model: THREE.Object3D) => void
): boolean {
  const name = KINDS[kind] ?? kind
  if (group.userData.round === name) return true
  const fallback = group.userData.fallback as THREE.Object3D | undefined
  const shown = group.userData.model as THREE.Object3D | undefined
  if (shown) group.remove(shown)
  group.userData.model = undefined
  group.userData.round = undefined
  const prototype = prototypes[name]
  if (!prototype) {
    if (fallback) fallback.visible = true
    return false
  }
  const model = prototype.clone(true)
  prepare?.(model)
  group.add(model)
  group.userData.model = model
  group.userData.round = name
  if (fallback) fallback.visible = false
  return true
}
