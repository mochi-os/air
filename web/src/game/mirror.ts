// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The canopy bow's rear-view mirrors. A flat mirror shows the scene as seen
// from the eye reflected across its plane (its virtual eye), so the engine
// draws the scene from there into small targets, and each mirror's face looks
// up the eye's sight line reflected off it. Two layers make up the view:
// - the world, drawn once from the mirrors' virtual eyes' mean (they lie about
//   0.2 m from it, nothing to the world's distances) and looked up by world
//   direction, so the sky, the sea and every other jet stand still in the
//   mirror however far the jet turns between updates;
// - the jet's own airframe, the distant stage's few draws rather than the
//   cockpit model's hundreds, drawn for each mirror from its own virtual eye,
//   which is exact at the seat's half metre as at the fins' eight, and looked
//   up in the jet's frame, so the fins stay put in the glass.
// Both refresh MIRROR_RATE times a second. With clouds the march follows on the
// next frame, so no one frame carries a whole update.

import * as THREE from 'three'

export const MIRROR_RATE = 30
// The three mirrors reflect the cockpit model's eye over about 50 by 24 degrees,
// 54 by 30 in the rear view with the margin. A target this shape holds that at
// 12 pixels a degree, the main view's 60-degree field on a screen 810 pixels
// tall.
export const MIRROR_WIDTH = 768
export const MIRROR_HEIGHT = 384
// Silvered glass returns about 88% of the light. The targets hold display
// values, as the canvas does, so the share is taken in display terms.
export const MIRROR_GAIN = Math.pow(0.88, 1 / 2.2)
// How the mirrors are set, as a pilot sets his: the centre one looks dead aft
// just over the headrest; each side one looks level and MIRROR_OUT out to its
// own side, past the fuselage. From the centre mirror's virtual eye the
// headrest fills the view to 7.5 degrees over the horizon 6 degrees either
// side of dead aft, and its peak to 10.5 on the centreline, so no setting
// shows both it and the horizon behind; the mirror's 4.5 degrees of glass,
// centred at MIRROR_ABOVE, holds the peak at its lower edge.
export const MIRROR_ABOVE = (13 * Math.PI) / 180
export const MIRROR_OUT = (20 * Math.PI) / 180
// A mirror whose centre lies within this of the eye's plane of symmetry,
// metres, is the centre one.
export const MIRROR_MIDDLE = 0.15

// mirror_setting: the direction a mirror is set to look along, in the jet's
// frame (forward, up, right), for the mirror `across` metres right of the eye.
export function mirror_setting(across: number): THREE.Vector3 {
  if (Math.abs(across) < MIRROR_MIDDLE) return new THREE.Vector3(-Math.cos(MIRROR_ABOVE), Math.sin(MIRROR_ABOVE), 0)
  return new THREE.Vector3(-Math.cos(MIRROR_OUT), 0, Math.sign(across) * Math.sin(MIRROR_OUT))
}

// mirror_normal: the normal a mirror centred at `centre` needs to send the
// eye's sight line to it on along `toward` (unit), written to `out`: the
// bisector of the sight line reversed and the direction sent, which faces the
// eye.
export function mirror_normal(eye: THREE.Vector3, centre: THREE.Vector3, toward: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  return out.subVectors(centre, eye).normalize().negate().add(toward).normalize()
}

// The distant stages paint the canopy glass one dark tint, linear (TINT in
// tools/fa18c/far.py), the glass as it reads from outside at range. From the
// mirrors it would be a black shell round the eye, hiding everything the glass
// lets through, so their copy leaves it out.
export const MIRROR_GLASS: [number, number, number] = [0.02, 0.026, 0.034]
const GLASS_NEAR = 0.008

// mirror_clear: a triangle list (three vertex indices a triangle) without the
// triangles any vertex of which is painted the glass tint, from per-vertex
// colours read by `colour(vertex)`.
export function mirror_clear(triangles: ArrayLike<number>, colour: (vertex: number) => [number, number, number]): number[] {
  const glass = (v: number) => colour(v).every((c, i) => Math.abs(c - MIRROR_GLASS[i]) <= GLASS_NEAR)
  const kept: number[] = []
  for (let i = 0; i + 2 < triangles.length; i += 3)
    if (!glass(triangles[i]) && !glass(triangles[i + 1]) && !glass(triangles[i + 2])) kept.push(triangles[i], triangles[i + 1], triangles[i + 2])
  return kept
}

// The mirrors a face may hold (the cockpit model's bow carries three), and the
// square each one's airframe is drawn into: a mirror spans about 22 degrees
// along its length, held at 17 pixels a degree.
export const MIRROR_PIECES = 3
export const MIRROR_PIECE = 384
// How far toward the eye each mirror's airframe pass is cut, metres: the
// mirrors are the cockpit model's and the airframe the distant stage's, whose
// canopy bow stands a few centimetres proud of the glass and would fill the
// view point-blank. Nothing a mirror shows lies this close to it.
export const MIRROR_CLEAR = 0.2
// An update older than this (the mirrors were off screen) is not shown: the
// faces show the sky alone until a fresh one is drawn.
export const MIRROR_STALE = 0.15
// The field kept round the reflected rays, radians, so a face's edge never
// samples the target's clamped border.
export const MIRROR_MARGIN = (2 * Math.PI) / 180

// mirror_live: whether the mirrors show the live view: in the cockpit view
// without the map, at any effects setting above the lowest, which keeps the sky
// alone.
export function mirror_live(view: string, map: boolean, effects: number): boolean {
  return view === 'cockpit' && !map && effects >= 1
}

// mirror_virtual: the eye reflected across the plane through `point` with
// normal `normal`, written to `out`: where a flat mirror shows the scene from.
// The line from it through any point of the glass is the eye's sight line to
// that point, reflected.
const _offset = new THREE.Vector3()
export function mirror_virtual(eye: THREE.Vector3, point: THREE.Vector3, normal: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const off = _offset.subVectors(eye, point).dot(normal)
  return out.copy(eye).addScaledVector(normal, -2 * off)
}

// mirror_pieces: the separate mirrors one face's triangles make, as lists of
// their vertices (connected through shared vertices), largest first.
// `triangles` holds three vertex indices a triangle.
export function mirror_pieces(triangles: ArrayLike<number>): number[][] {
  const parent = new Map<number, number>()
  const root = (v: number): number => {
    let r = v
    while (parent.get(r) !== r) r = parent.get(r)!
    for (let x = v; x !== r; ) {
      const next = parent.get(x)!
      parent.set(x, r)
      x = next
    }
    return r
  }
  for (let i = 0; i < triangles.length; i++) if (!parent.has(triangles[i])) parent.set(triangles[i], triangles[i])
  for (let i = 0; i + 2 < triangles.length; i += 3) {
    const a = root(triangles[i])
    parent.set(root(triangles[i + 1]), a)
    parent.set(root(triangles[i + 2]), a)
  }
  const groups = new Map<number, number[]>()
  for (const v of [...parent.keys()].sort((a, b) => a - b)) {
    const r = root(v)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r)!.push(v)
  }
  return [...groups.values()].sort((a, b) => b.length - a.length || a[0] - b[0])
}

const _forward = new THREE.Vector3(),
  _right = new THREE.Vector3(),
  _up = new THREE.Vector3(),
  _target = new THREE.Vector3()

// extent: the camera's right and up axes, and each ray's furthest tangent off
// its forward axis (positive and negative, across and up); null when a ray is
// not well ahead of it.
function extent(camera: THREE.PerspectiveCamera, rays: THREE.Vector3[]) {
  camera.updateMatrixWorld(true)
  _right.setFromMatrixColumn(camera.matrixWorld, 0).normalize()
  _up.setFromMatrixColumn(camera.matrixWorld, 1).normalize()
  _forward.setFromMatrixColumn(camera.matrixWorld, 2).normalize().negate()
  let left = 0,
    right = 0,
    low = 0,
    high = 0
  for (const r of rays) {
    const ahead = r.dot(_forward)
    if (ahead < 0.2) return null
    const x = r.dot(_right) / ahead,
      y = r.dot(_up) / ahead
    left = Math.min(left, x)
    right = Math.max(right, x)
    low = Math.min(low, y)
    high = Math.max(high, y)
  }
  return { left, right, low, high }
}

// mirror_aim: place the rear-view camera at the eye, aimed at the middle of the
// reflected rays and upright to `up`, with a field just wide enough for every
// ray and `margin` radians more each side, at the camera's own aspect. False
// when the rays spread too far for one camera.
export function mirror_aim(camera: THREE.PerspectiveCamera, eye: THREE.Vector3, rays: THREE.Vector3[], up: THREE.Vector3, margin: number): boolean {
  if (!rays.length) return false
  const mean = new THREE.Vector3()
  for (const r of rays) mean.add(r)
  if (mean.lengthSq() < 1e-12) return false
  camera.position.copy(eye)
  camera.up.copy(up)
  camera.lookAt(_target.copy(eye).add(mean.normalize()))
  // Then centre it on the rays' extent, which the mean leans off when one
  // mirror reflects further out than the others.
  let e = extent(camera, rays)
  if (!e) return false
  _target
    .copy(_forward)
    .addScaledVector(_right, (e.left + e.right) / 2)
    .addScaledVector(_up, (e.low + e.high) / 2)
    .normalize()
    .add(eye)
  camera.lookAt(_target)
  e = extent(camera, rays)
  if (!e) return false
  const across = Math.atan(Math.max(-e.left, e.right)) + margin,
    up_angle = Math.atan(Math.max(-e.low, e.high)) + margin
  if (across >= Math.PI / 2 - 0.05 || up_angle >= Math.PI / 2 - 0.05) return false
  const half = Math.atan(Math.max(Math.tan(up_angle), Math.tan(across) / camera.aspect))
  camera.fov = (2 * half * 180) / Math.PI
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  return true
}

// mirror_view: the matrix a face projects a world direction through to find it
// in a target `camera` drew: projection by view. A direction's w of 0 drops the
// translation, so how far the eye has flown since the draw does not matter.
export function mirror_view(camera: THREE.Camera, out: THREE.Matrix4): THREE.Matrix4 {
  return out.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
}

const _then = new THREE.Matrix4(),
  _now = new THREE.Matrix4()

// mirror_carried: the same for a target that rides with the jet. A direction
// now is taken into the jet's frame (the inverse of its turn `now`), back out
// into the world as the jet lay at the draw (`then`), and through the view
// drawn then.
export function mirror_carried(view: THREE.Matrix4, then: THREE.Quaternion, now: THREE.Quaternion, out: THREE.Matrix4): THREE.Matrix4 {
  _then.makeRotationFromQuaternion(then)
  _now.makeRotationFromQuaternion(now).transpose()
  return out.copy(view).multiply(_then).multiply(_now)
}

// mirror_lookup: where a world direction falls in a target, as texture
// co-ordinates from 0 to 1, by the face shader's own arithmetic; null behind
// the camera.
export function mirror_lookup(view: THREE.Matrix4, direction: THREE.Vector3): [number, number] | null {
  const e = view.elements,
    x = direction.x,
    y = direction.y,
    z = direction.z
  const cx = e[0] * x + e[4] * y + e[8] * z,
    cy = e[1] * x + e[5] * y + e[9] * z,
    cw = e[3] * x + e[7] * y + e[11] * z
  if (cw <= 0) return null
  return [(cx / cw) * 0.5 + 0.5, (cy / cw) * 0.5 + 0.5]
}

// MirrorClock paces the updates on wall time, whatever the frame rate. A frame
// begins an update ("scene": the world and the jet are drawn), finishes one
// begun the frame before ("clouds": the march and its composite), or does
// neither. A stall does not queue a burst of updates.
export class MirrorClock {
  next = 0
  pending = false
  period: number
  constructor(rate = MIRROR_RATE) {
    this.period = 1000 / rate
  }
  step(now: number, clouds: boolean): 'scene' | 'clouds' | null {
    if (this.pending) {
      this.pending = false
      return 'clouds'
    }
    if (now < this.next) return null
    this.next = now - this.next >= this.period ? now + this.period : this.next + this.period
    this.pending = clouds
    return 'scene'
  }
  // reset: the mirrors went out of use; the next frame they are wanted begins
  // an update at once.
  reset(): void {
    this.next = 0
    this.pending = false
  }
}

// mirror_material: the live face. It looks the eye's sight line, reflected off
// the face toward the eye, up in the world and in the airframe drawn for the
// mirror the fragment lies on (the plane it is nearest, a plane each: normal
// and offset, so that n.x + w is the distance from it), and lays the airframe
// (premultiplied: cleared transparent, its edges resolved to their coverage)
// over the world. The targets hold display values, so the face writes them
// out unconverted at the glass's share. The model's scale is uniform, so the
// model matrix turns the normal as well as it turns the face.
export function mirror_material(side: THREE.Side): THREE.ShaderMaterial {
  const uniforms: Record<string, THREE.IUniform> = { tWorld: { value: null }, uWorld: { value: new THREE.Matrix4() }, uGain: { value: MIRROR_GAIN } }
  for (let k = 0; k < MIRROR_PIECES; k++) {
    uniforms[`tJet${k}`] = { value: null }
    uniforms[`uJet${k}`] = { value: new THREE.Matrix4() }
    uniforms[`uPlane${k}`] = { value: new THREE.Vector4(0, 1, 0, 1e9) }   // no mirror: a plane no face is near
  }
  return new THREE.ShaderMaterial({
    side,
    uniforms,
    vertexShader: `varying vec3 vWorld, vNormal;
      void main(){ vec4 w=modelMatrix*vec4(position,1.0); vWorld=w.xyz; vNormal=mat3(modelMatrix)*normal; gl_Position=projectionMatrix*viewMatrix*w; }`,
    fragmentShader: `uniform sampler2D tWorld, tJet0, tJet1, tJet2; uniform mat4 uWorld, uJet0, uJet1, uJet2; uniform vec4 uPlane0, uPlane1, uPlane2; uniform float uGain;
      varying vec3 vWorld, vNormal;
      vec2 at(mat4 view, vec3 r){ vec4 c=view*vec4(r,0.0); return c.w>0.0?clamp(c.xy/c.w*0.5+0.5,0.0,1.0):vec2(0.5); }
      float off(vec4 plane){ return abs(dot(plane.xyz,vWorld)+plane.w); }
      void main(){
        vec3 v=normalize(vWorld-cameraPosition), n=normalize(vNormal);
        if(dot(n,v)>0.0) n=-n;   // the side toward the eye, whichever way the model wound the face
        vec3 r=reflect(v,n);
        float d0=off(uPlane0), d1=off(uPlane1), d2=off(uPlane2);
        vec4 jet=d0<=d1&&d0<=d2?texture2D(tJet0,at(uJet0,r)):d1<=d2?texture2D(tJet1,at(uJet1,r)):texture2D(tJet2,at(uJet2,r));
        gl_FragColor=vec4((jet.rgb+texture2D(tWorld,at(uWorld,r)).rgb*(1.0-jet.a))*uGain,1.0); }`,
  })
}
