// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The map's globe (#162): the earth seen from straight above the map's
// centre, from far enough off that every line of sight is parallel - an
// orthographic projection. Close in it is the flat map the game always drew,
// and zoomed out it is the whole planet with its limb. The map draws its
// marks through project; the globe itself is a plain sea on a canvas of its
// own beneath them, until the earth has terrain to show.

import * as THREE from 'three'
import { EQUATOR, FLATTENING, destination, type Frame, type Place, type Vec } from './earth'

const OBLATENESS = 1 / (1 - FLATTENING)
const ECCENTRIC = FLATTENING * (2 - FLATTENING) // first eccentricity squared

// project is a point's place on the map, metres east and south of the view's
// centre, and whether the earth hides it: seen from above the centre, a point
// on the far side of the limb is behind the globe.
export function project(view: Frame, e: Vec): { x: number; z: number; seen: boolean } {
  const local = view.local(e), up = view.up
  return { x: local.x, z: local.z, seen: e.x * up.x + e.y * up.y + e.z * up.z * OBLATENESS * OBLATENESS >= 0 }
}

// heading is a direction of the earth's on the map: east and south, unit.
export function heading(view: Frame, d: Vec): { x: number; z: number } {
  const x = d.x * view.east.x + d.y * view.east.y + d.z * view.east.z
  const z = d.x * view.south.x + d.y * view.south.y + d.z * view.south.z
  const length = Math.hypot(x, z) || 1
  return { x: x / length, z: z / length }
}

// step is the range rings' spacing, nautical miles, for a map whose half
// width is range: one of 1, 2 and 5 in every power of ten, the finest that
// leaves at most four rings across it.
export function step(range: number): number {
  for (let power = 1; ; power *= 10) for (const k of [1, 2, 5]) if (range / (k * power) <= 4) return k * power
}

// ring is a circle on the earth, a distance from a place along every bearing,
// as points of the earth: a few kilometres across it is the circle on the
// map, and thousands across it bends as the globe does.
export function ring(centre: Place, distance: number, points: number): Place[] {
  const out: Place[] = []
  for (let k = 0; k <= points; k++) out.push(destination(centre, (2 * Math.PI * k) / points, distance))
  return out
}

// offset is the map's centre panned from a place: metres east and south of
// it, along the great circle that way, so a pan reaches anywhere on the earth
// and past the far side carries on round it.
export function offset(from: Place, east: number, south: number): Place {
  const distance = Math.hypot(east, south)
  return distance < 1 ? from : destination(from, Math.atan2(east, -south), distance)
}

const VERTEX = `void main(){ gl_Position=vec4(position.xy,0.0,1.0); }`
const FRAGMENT = `uniform vec4 u_view; uniform vec2 u_screen; uniform vec3 u_sea,u_space;
	uniform mat3 u_turn; uniform vec3 u_anchor;   // the view's frame: its axes and centre earth-centred, turned onto its own meridian
	const float OBLATENESS=${OBLATENESS}, EQUATOR=${EQUATOR}.0;
	void main(){ vec2 css=vec2(gl_FragCoord.x,u_screen.y*u_view.w-gl_FragCoord.y)/u_view.w, m=(css-u_view.xy)*u_view.z;   // metres east and south of the centre, across the view's level
		vec3 b=(u_turn*vec3(m.x,0.0,m.y)+u_anchor)/EQUATOR, up=u_turn*vec3(0.0,1.0,0.0);   // the line of sight down through it, earth-centred in earth radii
		vec3 bs=vec3(b.xy,b.z*OBLATENESS), us=vec3(up.xy,up.z*OBLATENESS);   // where the ellipsoid is the unit sphere
		float A=dot(us,us), B=dot(bs,us), D=B*B-A*(dot(bs,bs)-1.0);
		float limb=clamp(D/max(fwidth(D),1.0e-12),0.0,1.0);   // the limb, drawn across a pixel
		gl_FragColor=vec4(mix(u_space,u_sea,limb),1.0);
		#include <colorspace_fragment>
	}`

// aim lays a view's frame in the shader's uniforms. Turned onto its own
// meridian the frame's east is the y axis, its up (cos, 0, sin) of its
// latitude and its south (sin, 0, -cos); the sea is the same all round the
// axis, so the longitude does not matter.
export function aim(turn: THREE.Matrix3, anchor: THREE.Vector3, view: Frame): void {
  const sin = Math.sin(view.latitude), cos = Math.cos(view.latitude)
  const normal = EQUATOR / Math.sqrt(1 - ECCENTRIC * sin * sin)
  turn.set(0, cos, sin, 1, 0, 0, 0, sin, -cos)
  anchor.set(normal * cos, 0, normal * (1 - ECCENTRIC) * sin)
}

// Globe draws the earth on its own canvas, its own renderer: the map sits over
// the scene, which goes on drawing beneath it.
export class Globe {
  readonly canvas: HTMLCanvasElement
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly material: THREE.ShaderMaterial

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false })
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        u_turn: { value: new THREE.Matrix3() },
        u_anchor: { value: new THREE.Vector3() },
        u_view: { value: new THREE.Vector4() },
        u_screen: { value: new THREE.Vector2() },
        u_sea: { value: new THREE.Color('#0b1d3a') },
        u_space: { value: new THREE.Color('#020408') },
      },
    })
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material)
    quad.frustumCulled = false
    this.scene.add(quad)
  }

  // draw shows the earth about a view, its centre at (x, y) of a canvas
  // width by height (CSS pixels), metres a pixel.
  draw(view: Frame, x: number, y: number, metres: number, width: number, height: number, ratio: number): void {
    if (this.canvas.width !== Math.round(width * ratio) || this.canvas.height !== Math.round(height * ratio)) {
      this.renderer.setPixelRatio(ratio)
      this.renderer.setSize(width, height)
    }
    aim(this.material.uniforms.u_turn.value, this.material.uniforms.u_anchor.value, view)
    this.material.uniforms.u_view.value.set(x, y, metres, ratio)
    this.material.uniforms.u_screen.value.set(width, height)
    this.renderer.render(this.scene, this.camera)
  }

  dispose(): void {
    this.material.dispose()
    for (const o of this.scene.children) (o as THREE.Mesh).geometry?.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.canvas.remove()
  }
}
