// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The low quality global map (#162): NASA's Blue Marble with Natural Earth's
// 1:50m land, as tools/world.py bakes it into web/public/maps/world. The sea
// draws the land from it wherever the jet flies, and the map (M) draws the
// globe. Two levels:
//
//   fine    2,048 m a pixel, 1,024 pixel tiles, only those touching land. The
//           engine holds a window of 2,048 pixels square about its jet,
//           composed from the tiles and moved as the jet flies on.
//   global  8,192 m a pixel, the whole earth in one image.
//
// A level's pixel spans its metres of equatorial arc: column 0 starts at
// 180 W and row 0 at 90 N. The earth's circumference is a fraction of a pixel
// short of the fine grid's whole width, so the last column runs that fraction
// past the antimeridian. Each texel's alpha is the share of it that is land;
// the shaders draw land where it passes one half. The flight core and the
// world server collide against land.bin, scanned from the same outline.

import * as THREE from 'three'
import { EQUATOR, FLATTENING, type Frame } from './earth'

export interface Manifest {
  equator: number
  fine: { metres: number; width: number; height: number; tile: number; tiles: [number, number][] }
  global: { metres: number; width: number; height: number }
}

export const SIZE = 2048 // the fine window's side, pixels
const ECCENTRIC = FLATTENING * (2 - FLATTENING)

// column is the fine grid's column of a longitude, radians, in [0, the
// circumference); row the row of a latitude.
export function column(m: Manifest, longitude: number): number {
  const circumference = (2 * Math.PI * m.equator) / m.fine.metres
  const s = ((longitude + Math.PI) * m.equator) / m.fine.metres
  return s - circumference * Math.floor(s / circumference)
}
export function row(m: Manifest, latitude: number): number {
  return ((Math.PI / 2 - latitude) * m.equator) / m.fine.metres
}

// origin is the window's top left corner, fine pixels, for a jet at a place:
// on the tiles' lattice, with the jet in its middle half. The column is on the
// grid stretched across the antimeridian (negative, or past the width), the
// row clamped to the grid.
export function origin(m: Manifest, latitude: number, longitude: number): { x: number; y: number } {
  const t = m.fine.tile
  const x = (Math.round(column(m, longitude) / t) - 1) * t
  const rows = Math.ceil(m.fine.height / t) * t
  const y = Math.min(Math.max((Math.round(row(m, latitude) / t) - 1) * t, 0), Math.max(rows - SIZE, 0))
  return { x, y }
}

// due reports whether a jet has left the window's middle by enough to move it.
export function due(m: Manifest, held: { x: number; y: number }, latitude: number, longitude: number): boolean {
  const next = origin(m, latitude, longitude)
  if (next.y !== held.y && Math.abs(row(m, latitude) - (held.y + SIZE / 2)) > 640) return true
  return next.x !== held.x && Math.abs(local(m, held, column(m, longitude)) - SIZE / 2) > 640
}

// local is a column's place across the window, pixels from its left edge:
// tiles lie at their columns plus or minus the grid's width, as pieces placed
// them, so a column east of the antimeridian finds the copy beside the window.
export function local(m: Manifest, held: { x: number }, column: number): number {
  const w = column - held.x
  return w - m.fine.width * Math.round((w - SIZE / 2) / m.fine.width)
}

export interface Piece {
  row: number
  column: number // the tile
  sx: number
  sy: number // its pixels drawn, from its top left
  width: number
  height: number
  dx: number
  dy: number // where in the window
}

// pieces lists the parts of the tiles a window holds: each tile at its own
// columns, and at those a grid's width east and west, so a window across the
// antimeridian is whole. Only a tile's real pixels are drawn: the last
// column's and the last row's tiles are part padding.
export function pieces(m: Manifest, held: { x: number; y: number }): Piece[] {
  const t = m.fine.tile, out: Piece[] = []
  for (const [r, c] of m.fine.tiles) {
    const top = r * t, height = Math.min(t, m.fine.height - top)
    const y0 = Math.max(top, held.y), y1 = Math.min(top + height, held.y + SIZE)
    if (y1 <= y0) continue
    for (const shift of [-m.fine.width, 0, m.fine.width]) {
      const left = c * t + shift, width = Math.min(t, m.fine.width - c * t)
      const x0 = Math.max(left, held.x), x1 = Math.min(left + width, held.x + SIZE)
      if (x1 <= x0) continue
      out.push({ row: r, column: c, sx: x0 - left, sy: y0 - top, width: x1 - x0, height: y1 - y0, dx: x0 - held.x, dy: y0 - held.y })
    }
  }
  return out
}

// The shaders' half. A frame's points are carried earth-centred and turned
// about the pole onto the frame's own meridian (aim), so a longitude is read
// relative to the anchor's and never wraps inside the disc a frame draws; the
// fine grid's column is then the anchor's plus the turn's.
export const ATLAS = `uniform sampler2D u_atlas_fine,u_atlas_globe;
	uniform vec4 u_atlas_window;   // the window's corner (fine pixels), its side, 1 once composed
	uniform vec4 u_atlas_grid;     // the circumference and the grid's width (fine pixels), fine pixels a radian, 1 once the global level is in
	uniform vec2 u_atlas_globe_size;   // the global level, its pixels
	uniform mat3 u_atlas_turn; uniform vec3 u_atlas_anchor; uniform float u_atlas_meridian;   // the frame: its axes and anchor earth-centred, turned onto its meridian; the meridian's column
	const float ATLAS_RATIO=4.0, ATLAS_ECCENTRIC=${ECCENTRIC};
	// atlas_grid is the fine grid's column (unwrapped about the meridian) and row of a point of the frame
	vec2 atlas_grid(vec3 p){ vec3 e=u_atlas_turn*p+u_atlas_anchor;
		return vec2(u_atlas_meridian+atan(e.y,e.x)*u_atlas_grid.z,(1.5707963-atan(e.z,(1.0-ATLAS_ECCENTRIC)*length(e.xy)))*u_atlas_grid.z); }
	// a derivative across the antimeridian's seam, which only the poles bring into a disc
	vec2 atlas_step(vec2 d){ d.x-=u_atlas_grid.x*floor(d.x/u_atlas_grid.x+0.5); return d; }
	vec2 atlas_window(vec2 g){ float s=g.x-u_atlas_grid.x*floor(g.x/u_atlas_grid.x), w=s-u_atlas_window.x;
		w-=u_atlas_grid.y*floor((w-0.5*u_atlas_window.z)/u_atlas_grid.y+0.5);
		return vec2(w,g.y-u_atlas_window.y)/u_atlas_window.z; }
	vec2 atlas_globe(vec2 g){ return vec2(g.x-u_atlas_grid.x*floor(g.x/u_atlas_grid.x),g.y)/(ATLAS_RATIO*u_atlas_globe_size); }
	bool atlas_inside(vec2 w){ return u_atlas_window.w>0.5&&w.x>=0.0&&w.y>=0.0&&w.x<=1.0&&w.y<=1.0; }
	// atlas_point is the map at a point, its finest: the colour, and the share of land in alpha
	vec4 atlas_point(vec2 g){ vec2 w=atlas_window(g); if(atlas_inside(w)) return textureLod(u_atlas_fine,w,0.0);
		if(u_atlas_grid.w>0.5) return textureLod(u_atlas_globe,atlas_globe(g),0.0); return vec4(0.0); }
	// atlas_area is the map over a pixel's footprint, dx and dy its derivatives: the window
	// while its texels are finer than the global level's, the global level beyond
	vec4 atlas_area(vec2 g, vec2 dx, vec2 dy){ vec2 w=atlas_window(g);
		if(atlas_inside(w)&&max(length(dx),length(dy))<ATLAS_RATIO) return textureGrad(u_atlas_fine,w,dx/u_atlas_window.z,dy/u_atlas_window.z);
		if(u_atlas_grid.w>0.5){ vec2 k=1.0/(ATLAS_RATIO*u_atlas_globe_size); return textureGrad(u_atlas_globe,atlas_globe(g),dx*k,dy*k); }
		return vec4(0.0); }`

// ATLAS_COVER is how much of a pixel is land, its edge drawn across one
// pixel: the fragment shader's alone, which has derivatives.
export const ATLAS_COVER = `float atlas_cover(float share){ float edge=max(fwidth(share),1.0e-3); return clamp((share-0.5)/edge+0.5,0.0,1.0); }`

// The frame uniforms a material carries for ATLAS, and aim lays a frame in
// them.
export function framing() {
  return { u_atlas_turn: { value: new THREE.Matrix3() }, u_atlas_anchor: { value: new THREE.Vector3() }, u_atlas_meridian: { value: 0 } }
}
export function aim(u: ReturnType<typeof framing>, frame: Frame, m: Manifest | null): void {
  // Turned onto its own meridian the frame's east is the y axis, its up
  // (cos, 0, sin) of its latitude and its south (sin, 0, -cos).
  const sin = Math.sin(frame.latitude), cos = Math.cos(frame.latitude)
  const normal = EQUATOR / Math.sqrt(1 - ECCENTRIC * sin * sin)
  u.u_atlas_turn.value.set(0, cos, sin, 1, 0, 0, 0, sin, -cos)
  u.u_atlas_anchor.value.set(normal * cos, 0, normal * (1 - ECCENTRIC) * sin)
  u.u_atlas_meridian.value = m ? column(m, frame.longitude) : 0
}

// grid is the shaders' atlas_grid in double precision, for the tests: the
// column unwrapped about the meridian, and the row.
export function grid(m: Manifest, frame: Frame, p: { x: number; y: number; z: number }): [number, number] {
  const sin = Math.sin(frame.latitude), cos = Math.cos(frame.latitude)
  const normal = EQUATOR / Math.sqrt(1 - ECCENTRIC * sin * sin)
  const e = { x: normal * cos + cos * p.y + sin * p.z, y: p.x, z: normal * (1 - ECCENTRIC) * sin + sin * p.y - cos * p.z }
  const scale = m.equator / m.fine.metres
  return [column(m, frame.longitude) + Math.atan2(e.y, e.x) * scale, (Math.PI / 2 - Math.atan2(e.z, (1 - ECCENTRIC) * Math.hypot(e.x, e.y))) * scale]
}

// Atlas loads the map and keeps the window about the jet. Its textures and
// level uniforms are shared by every material that draws the map; each
// carries its own framing.
export class Atlas {
  manifest: Manifest | null = null
  window: { x: number; y: number } | null = null // the window composed, once one is
  failed = false
  readonly fine: THREE.DataTexture
  readonly uniforms = {
    u_atlas_fine: { value: null as THREE.Texture | null },
    u_atlas_globe: { value: null as THREE.Texture | null },
    u_atlas_window: { value: new THREE.Vector4(0, 0, SIZE, 0) },
    u_atlas_grid: { value: new THREE.Vector4(1, 1, 1, 0) },
    u_atlas_globe_size: { value: new THREE.Vector2(1, 1) },
  }
  private base = ''
  private place: { latitude: number; longitude: number } | null = null // the jet's, last followed
  private composing = false
  private again = false

  private readonly pixels = new Uint8Array(SIZE * SIZE * 4) // the fine window's, which its texture holds

  constructor() {
    this.fine = texture(this.pixels, SIZE, SIZE)
  }

  // load reads the manifest and the global level, then composes the window
  // about the jet if one is being followed; limit is the largest texture the
  // GPU takes, the global level shrunk to fit it.
  async load(base: string, limit: number): Promise<void> {
    try {
      this.base = base
      const m: Manifest = await (await fetch(base + 'world.json')).json()
      const [colour, land] = await Promise.all([bitmap(base + 'global.webp'), bitmap(base + 'global-land.png')])
      const k = Math.min(1, limit / Math.max(colour.width, colour.height))
      const width = Math.max(1, Math.floor(colour.width * k)), height = Math.max(1, Math.floor(colour.height * k))
      const data = new Uint8Array(width * height * 4)
      merge(data, width, height, [{ colour, land, sx: 0, sy: 0, width: colour.width, height: colour.height, dx: 0, dy: 0, scale: k }])
      colour.close()
      land.close()
      this.manifest = m
      this.uniforms.u_atlas_grid.value.set((2 * Math.PI * m.equator) / m.fine.metres, m.fine.width, m.equator / m.fine.metres, 1)
      this.uniforms.u_atlas_globe_size.value.set(m.global.width, m.global.height)
      this.uniforms.u_atlas_globe.value = texture(data, width, height)
      this.uniforms.u_atlas_fine.value = this.fine
      if (this.place) void this.compose()
    } catch (error) {
      this.failed = true
      console.error('the world map failed to load', error)
    }
  }

  // follow keeps the window under a jet at a place, radians: moved when the
  // jet has wandered from its middle, composed in the background.
  follow(latitude: number, longitude: number): void {
    this.place = { latitude, longitude }
    const m = this.manifest
    if (!m || this.failed) return // load composes it once the map is in
    if (this.window && !due(m, this.window, latitude, longitude)) return
    void this.compose()
  }

  private async compose(): Promise<void> {
    const m = this.manifest
    if (!m) return
    if (this.composing) {
      this.again = true
      return
    }
    this.composing = true
    try {
      do {
        this.again = false
        const place = this.place!
        const at = origin(m, place.latitude, place.longitude)
        if (this.window && at.x === this.window.x && at.y === this.window.y) continue
        const parts = pieces(m, at)
        const images = new Map<string, Promise<[ImageBitmap, ImageBitmap]>>()
        for (const p of parts) {
          const name = p.row + '-' + p.column
          if (!images.has(name)) images.set(name, Promise.all([bitmap(this.base + 'fine/' + name + '.webp'), bitmap(this.base + 'fine/' + name + '-land.png')]))
        }
        const ready = new Map<string, [ImageBitmap, ImageBitmap]>()
        for (const [name, promise] of images) ready.set(name, await promise)
        this.pixels.fill(0)
        merge(this.pixels, SIZE, SIZE, parts.map((p) => {
          const [colour, land] = ready.get(p.row + '-' + p.column)!
          return { ...p, colour, land, scale: 1 }
        }))
        for (const [colour, land] of ready.values()) {
          colour.close()
          land.close()
        }
        this.fine.needsUpdate = true // the texture and where it lies change together, on the next frame drawn
        this.window = at
        this.uniforms.u_atlas_window.value.set(at.x, at.y, SIZE, 1)
      } while (this.again)
    } catch (error) {
      console.error('the world map window failed to compose', error)
    } finally {
      this.composing = false
    }
  }
}

function texture(data: Uint8Array<ArrayBuffer>, width: number, height: number): THREE.DataTexture {
  const t = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
  t.magFilter = THREE.LinearFilter
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.generateMipmaps = true
  t.anisotropy = 4
  t.needsUpdate = true
  return t
}

async function bitmap(url: string): Promise<ImageBitmap> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(url + ': HTTP ' + response.status)
  return createImageBitmap(await response.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })   // the land share is read exactly: a half is the coast
}

// merge draws the colour and the land share of each part into an RGBA image,
// the share in alpha: kept apart until here, since a canvas holds colour
// multiplied by alpha and would blacken everything under the sea.
function merge(data: Uint8Array, width: number, height: number, parts: { colour: ImageBitmap; land: ImageBitmap; sx: number; sy: number; width: number; height: number; dx: number; dy: number; scale: number }[]): void {
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('no 2D context for the world map')
  const draw = (pick: (p: (typeof parts)[number]) => ImageBitmap) => {
    context.clearRect(0, 0, width, height)
    for (const p of parts) context.drawImage(pick(p), p.sx, p.sy, p.width, p.height, p.dx * p.scale, p.dy * p.scale, p.width * p.scale, p.height * p.scale)
    return context.getImageData(0, 0, width, height).data
  }
  const colour = draw((p) => p.colour)
  for (let i = 0; i < width * height * 4; i += 4) {
    data[i] = colour[i]
    data[i + 1] = colour[i + 1]
    data[i + 2] = colour[i + 2]
  }
  const land = draw((p) => p.land)
  for (let i = 0; i < width * height * 4; i += 4) data[i + 3] = land[i]
}
