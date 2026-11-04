// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
// The sky as light scattered by the air (Hillaire, "A Scalable and Production
// Ready Sky and Atmosphere Rendering Technique", 2020). Two tables describe
// the atmosphere and are baked here once: the transmittance from any height
// along any direction to space, and the light multiple scattering adds at any
// height for any sun. A third, the sky seen from the camera's height, is drawn
// on the GPU every frame from them (SKY_VIEW), and everything that shows the
// sky - the dome, the sea's reflection, the fog, the clouds' backdrop - reads
// that one table, so they cannot disagree. The CPU half of the same integral
// (radiance) gives the colours the lit materials' fog and lights take. The
// haze between the eye and what it sees (the sea, the clouds, the lit
// materials) is the same air's, from the transmittance table (at_between) or
// its integral (extinction). The aerosol is measured: its optical depth over
// the place flown in the month of the game's moment (climatology), of which the
// game flies a clearer day's share (haze).
//
// Lengths are in kilometres, the planet's centre below the sea at GROUND.
// Radiance is per unit of sun illuminance; the engine scales it.
import { AEROSOL, COLUMNS, MONTHS, ROWS, SPACING, STEP } from './aerosol'

export const GROUND = 6360
export const TOP = 6460
const RAYLEIGH = [5.802e-3, 13.558e-3, 33.1e-3] // scattering, per km, at sea level
const MIE_SCATTER = 3.996e-3
const MIE_EXTINCT = 4.4e-3
const OZONE = [0.65e-3, 1.881e-3, 0.085e-3] // absorption, per km, at 25 km
const MIE_G = 0.8
// The aerosol's scale height, km. Sea salt fills the marine layer below about a
// kilometre and the free troposphere carries the rest, in spring over the North
// Pacific Asian dust and smoke at 2-6 km, so a column's extinction falls off more
// slowly than the boundary layer's alone.
const MIE_HEIGHT = 2

export const TRANSMITTANCE = { width: 256, height: 64 }
export const SCATTERING = 32
export const SKY = { width: 192, height: 108 }

type Vector = [number, number, number]

interface Medium {
  rayleigh: Vector
  mie: number
  extinction: Vector
}

// The air at a height above the sea, km: Rayleigh and Mie falling off with
// their scale heights, ozone in a tent about 25 km. aerosol is the column's
// aerosol optical depth at 550 nm (climatology): the Mie extinction integrates
// to it from the sea up.
export function medium(height: number, aerosol: number): Medium {
  const h = Math.max(height, 0)
  const r = Math.exp(-h / 8)
  const m = (Math.exp(-h / MIE_HEIGHT) * aerosol) / (MIE_EXTINCT * MIE_HEIGHT)
  const o = Math.max(0, 1 - Math.abs(h - 25) / 15)
  const rayleigh: Vector = [RAYLEIGH[0] * r, RAYLEIGH[1] * r, RAYLEIGH[2] * r]
  return {
    rayleigh,
    mie: MIE_SCATTER * m,
    extinction: [
      rayleigh[0] + MIE_EXTINCT * m + OZONE[0] * o,
      rayleigh[1] + MIE_EXTINCT * m + OZONE[1] * o,
      rayleigh[2] + MIE_EXTINCT * m + OZONE[2] * o,
    ],
  }
}

// Where a ray from height r, at mu (the cosine of its angle from the zenith),
// leaves a sphere of radius R: [near, far] along it, or [-1, -1] for a miss.
export function sphere(r: number, mu: number, R: number): [number, number] {
  const b = r * mu
  const d = b * b - (r * r - R * R)
  if (d < 0) return [-1, -1]
  const s = Math.sqrt(d)
  return [-b - s, -b + s]
}

const HORIZON = Math.sqrt(TOP * TOP - GROUND * GROUND)

// The transmittance table's parameterisation (Bruneton): u spans the distance
// to the top of the atmosphere, v the height, both from 0 to 1.
export function transmittanceUV(r: number, mu: number): [number, number] {
  const rho = Math.sqrt(Math.max(0, r * r - GROUND * GROUND))
  const d = Math.max(
    0,
    -r * mu + Math.sqrt(Math.max(0, r * r * (mu * mu - 1) + TOP * TOP))
  )
  const near = TOP - r
  const far = rho + HORIZON
  return [(d - near) / (far - near), rho / HORIZON]
}

function transmittanceRMu(u: number, v: number): [number, number] {
  const rho = HORIZON * v
  const r = Math.sqrt(rho * rho + GROUND * GROUND)
  const near = TOP - r
  const far = rho + HORIZON
  const d = near + u * (far - near)
  const mu = d > 0 ? (HORIZON * HORIZON - rho * rho - d * d) / (2 * r * d) : 1
  return [r, Math.min(1, Math.max(-1, mu))]
}

// RGBA float table, rows of increasing height.
export function transmittanceTable(aerosol: number): Float32Array {
  const table = new Float32Array(TRANSMITTANCE.width * TRANSMITTANCE.height * 4)
  for (let y = 0; y < TRANSMITTANCE.height; y++)
    transmittanceRow(table, y, aerosol)
  return table
}

function transmittanceRow(table: Float32Array, y: number, aerosol: number) {
  const { width, height } = TRANSMITTANCE
  const steps = 40
  for (let x = 0; x < width; x++) {
    const [r, mu] = transmittanceRMu((x + 0.5) / width, (y + 0.5) / height)
    const length = sphere(r, mu, TOP)[1]
    const dt = length / steps
    const depth = [0, 0, 0]
    for (let s = 0; s < steps; s++) {
      const t = (s + 0.5) * dt
      const p = Math.sqrt(r * r + t * t + 2 * r * mu * t)
      const e = medium(p - GROUND, aerosol).extinction
      depth[0] += e[0] * dt
      depth[1] += e[1] * dt
      depth[2] += e[2] * dt
    }
    const o = (y * width + x) * 4
    table[o] = Math.exp(-depth[0])
    table[o + 1] = Math.exp(-depth[1])
    table[o + 2] = Math.exp(-depth[2])
    table[o + 3] = 1
  }
}

function bilinear(
  table: Float32Array,
  width: number,
  height: number,
  u: number,
  v: number
): Vector {
  const x = Math.min(width - 1, Math.max(0, u * width - 0.5))
  const y = Math.min(height - 1, Math.max(0, v * height - 0.5))
  const x0 = Math.floor(x),
    y0 = Math.floor(y)
  const x1 = Math.min(width - 1, x0 + 1),
    y1 = Math.min(height - 1, y0 + 1)
  const fx = x - x0,
    fy = y - y0
  const out: Vector = [0, 0, 0]
  for (let c = 0; c < 3; c++) {
    const a = table[(y0 * width + x0) * 4 + c],
      b = table[(y0 * width + x1) * 4 + c]
    const d = table[(y1 * width + x0) * 4 + c],
      e = table[(y1 * width + x1) * 4 + c]
    out[c] = (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy
  }
  return out
}

// Transmittance from height r along mu to space; zero below the horizon,
// where the ray meets the sea.
export function transmittance(
  table: Float32Array,
  r: number,
  mu: number
): Vector {
  if (mu < -Math.sqrt(Math.max(0, r * r - GROUND * GROUND)) / r)
    return [0, 0, 0]
  const [u, v] = transmittanceUV(r, mu)
  return bilinear(table, TRANSMITTANCE.width, TRANSMITTANCE.height, u, v)
}

// The light passed between a point at r along mu and the point t km on along
// its ray: two lookups of the table, the ray to space from each end (Bruneton),
// taken from the far end back toward the near for a ray that meets the sea.
export function between(
  table: Float32Array,
  r: number,
  mu: number,
  t: number
): Vector {
  const rt = Math.sqrt(Math.max(t * t + 2 * r * mu * t + r * r, 0))
  const mt = Math.min(1, Math.max(-1, (r * mu + t) / rt))
  const ground = mu < -Math.sqrt(Math.max(0, 1 - (GROUND * GROUND) / (r * r)))
  const near = ground
    ? transmittance(table, rt, -mt)
    : transmittance(table, r, mu)
  const far = ground
    ? transmittance(table, r, -mu)
    : transmittance(table, rt, mt)
  return [0, 1, 2].map((c) =>
    Math.min(1, near[c] / Math.max(far[c], 1e-6))
  ) as Vector
}

const isotropic = 1 / (4 * Math.PI)
const rayleighPhase = (c: number) => (3 / (16 * Math.PI)) * (1 + c * c)
const miePhase = (c: number, g: number) => {
  const g2 = g * g
  return (
    ((3 / (8 * Math.PI)) * ((1 - g2) * (1 + c * c))) /
    ((2 + g2) * Math.pow(Math.max(1 + g2 - 2 * g * c, 1e-4), 1.5))
  )
}

// The multiple-scattering table (Hillaire's psi_ms): for a sun cosine (u) and
// a height (v), the light every order of scattering past the first adds, as
// an isotropic source, from a sphere of directions integrated to second order
// and summed as the geometric series 1/(1 - f_ms). The sea reflects 6%.
export function scatteringTable(
  transmitted: Float32Array,
  aerosol: number
): Float32Array {
  const table = new Float32Array(SCATTERING * SCATTERING * 4)
  for (let y = 0; y < SCATTERING; y++)
    for (let x = 0; x < SCATTERING; x++)
      scatteringTexel(table, transmitted, x, y, aerosol)
  return table
}

function scatteringTexel(
  table: Float32Array,
  transmitted: Float32Array,
  x: number,
  y: number,
  aerosol: number
) {
  const size = SCATTERING
  const sq = 6
  const steps = 20
  const cosSun = ((x + 0.5) / size) * 2 - 1
  const h = Math.max(((y + 0.5) / size) * (TOP - GROUND), 0.01)
  const r = GROUND + h
  const sun: Vector = [Math.sqrt(Math.max(0, 1 - cosSun * cosSun)), cosSun, 0]
  const light = [0, 0, 0]
  const factor = [0, 0, 0]
  for (let a = 0; a < sq; a++)
    for (let b = 0; b < sq; b++) {
      const theta = Math.acos(1 - (2 * (b + 0.5)) / sq)
      const phi = (2 * Math.PI * (a + 0.5)) / sq
      const d: Vector = [
        Math.sin(theta) * Math.cos(phi),
        Math.cos(theta),
        Math.sin(theta) * Math.sin(phi),
      ]
      const ground = sphere(r, d[1], GROUND)
      const hits = ground[0] > 0
      const length = hits ? ground[0] : sphere(r, d[1], TOP)[1]
      const dt = length / steps
      const t = [1, 1, 1]
      for (let s = 0; s < steps; s++) {
        const along = (s + 0.5) * dt
        const p: Vector = [d[0] * along, r + d[1] * along, d[2] * along]
        const pr = Math.hypot(p[0], p[1], p[2])
        const m = medium(pr - GROUND, aerosol)
        const smu = (p[0] * sun[0] + p[1] * sun[1] + p[2] * sun[2]) / pr
        const sunT = transmittance(transmitted, pr, smu)
        for (let c = 0; c < 3; c++) {
          const scatter = m.rayleigh[c] + m.mie
          const ext = Math.max(m.extinction[c], 1e-9)
          const step = Math.exp(-m.extinction[c] * dt)
          const source = scatter * sunT[c] * isotropic
          light[c] += (t[c] * (source - source * step)) / ext
          factor[c] += (t[c] * (scatter - scatter * step)) / ext
          t[c] *= step
        }
      }
      if (hits) {
        const pg: Vector = [d[0] * length, r + d[1] * length, d[2] * length]
        const pr = Math.hypot(pg[0], pg[1], pg[2])
        const smu = (pg[0] * sun[0] + pg[1] * sun[1] + pg[2] * sun[2]) / pr
        const sunT = transmittance(transmitted, GROUND, smu)
        for (let c = 0; c < 3; c++)
          light[c] += (t[c] * sunT[c] * Math.max(smu, 0) * 0.06) / Math.PI
      }
    }
  const o = (y * size + x) * 4
  for (let c = 0; c < 3; c++) {
    const l2 = light[c] / (sq * sq)
    const fms = factor[c] / (sq * sq)
    table[o + c] = l2 / (1 - fms)
  }
  table[o + 3] = 1
}

export interface Tables {
  transmittance: Float32Array
  scattering: Float32Array
}

export function tables(aerosol: number): Tables {
  const transmitted = transmittanceTable(aerosol)
  return {
    transmittance: transmitted,
    scattering: scatteringTable(transmitted, aerosol),
  }
}

// The same two tables baked a slice at a time, a row of the transmittance table
// or a texel of the scattering table between yields, so a bake for a new aerosol
// runs between frames: the last step returns them.
export function* baking(aerosol: number): Generator<void, Tables, void> {
  const transmitted = new Float32Array(
    TRANSMITTANCE.width * TRANSMITTANCE.height * 4
  )
  for (let y = 0; y < TRANSMITTANCE.height; y++) {
    transmittanceRow(transmitted, y, aerosol)
    yield
  }
  const scattering = new Float32Array(SCATTERING * SCATTERING * 4)
  for (let y = 0; y < SCATTERING; y++)
    for (let x = 0; x < SCATTERING; x++) {
      scatteringTexel(scattering, transmitted, x, y, aerosol)
      yield
    }
  return { transmittance: transmitted, scattering }
}

// The aerosol optical depth at 550 nm over a place (latitude and longitude in
// radians) at a time: the month's mean over ten years of NASA's MERRA-2
// (aerosol.ts, tools/aerosol.py) every SPACING degrees, bilinear between the
// table's nodes and linear between the months' middles.
let nodes: Uint8Array | null = null
export function climatology(
  latitude: number,
  longitude: number,
  time: Date
): number {
  if (!nodes) nodes = Uint8Array.from(atob(AEROSOL), (c) => c.charCodeAt(0))
  const degrees = 180 / Math.PI
  const row = Math.min(
    ROWS - 1,
    Math.max(0, (90 - latitude * degrees) / SPACING)
  )
  const column = ((((longitude * degrees + 180) % 360) + 360) % 360) / SPACING
  const days = new Date(
    Date.UTC(time.getUTCFullYear(), time.getUTCMonth() + 1, 0)
  ).getUTCDate()
  const along =
    time.getUTCMonth() +
    (time.getUTCDate() - 1 + time.getUTCHours() / 24) / days -
    0.5
  const first = Math.floor(along)
  const w = along - first
  const month = ((first % MONTHS) + MONTHS) % MONTHS
  return (
    (1 - w) * node(month, row, column) +
    w * node((month + 1) % MONTHS, row, column)
  )
}

function node(month: number, row: number, column: number): number {
  const table = nodes as Uint8Array
  const r0 = Math.floor(row),
    c0 = Math.floor(column)
  const r1 = Math.min(ROWS - 1, r0 + 1),
    c1 = Math.min(COLUMNS - 1, c0 + 1)
  const fr = row - r0,
    fc = column - c0
  const at = (r: number, c: number) =>
    table[(month * ROWS + r) * COLUMNS + c] * STEP
  return (
    (at(r0, c0) * (1 - fc) + at(r0, c1) * fc) * (1 - fr) +
    (at(r1, c0) * (1 - fc) + at(r1, c1) * fc) * fr
  )
}

// The share of the month's mean aerosol the game flies: a clearer day than the
// mean, so a jet or a ship 5-20 km off keeps more of its contrast against the
// sky. Over Midway in March a jet 10 km off at 500 ft keeps 55% of it, where the
// mean leaves 45%, and one 20 km off at 5,000 ft 50%, where it leaves 41%.
export const CLEAR = 0.7

// The aerosol optical depth the game's air holds over a place (latitude and
// longitude in radians) at a time.
export function haze(latitude: number, longitude: number, time: Date): number {
  return CLEAR * climatology(latitude, longitude, time)
}

// The mean extinction, per km, of the air between two heights (km) for a
// luminance: what a straight path between them loses per km whatever its slant,
// since the air changes only with height. Ozone's sliver is left out. The lit
// materials' fog (FOG) is the same integral.
const RAYLEIGH_LUMINANCE =
  0.2126 * RAYLEIGH[0] + 0.7152 * RAYLEIGH[1] + 0.0722 * RAYLEIGH[2]
export function extinction(low: number, high: number, aerosol: number): number {
  const a = Math.max(Math.min(low, high), 0),
    b = Math.max(Math.max(low, high), 0)
  if (b - a < 1e-3)
    return (
      RAYLEIGH_LUMINANCE * Math.exp(-a / 8) +
      (aerosol / MIE_HEIGHT) * Math.exp(-a / MIE_HEIGHT)
    )
  const column = (h: number) =>
    RAYLEIGH_LUMINANCE * 8 * (1 - Math.exp(-h / 8)) +
    aerosol * (1 - Math.exp(-h / MIE_HEIGHT))
  return (column(b) - column(a)) / (b - a)
}

function scatteringAt(t: Tables, cosSun: number, height: number): Vector {
  return bilinear(
    t.scattering,
    SCATTERING,
    SCATTERING,
    cosSun * 0.5 + 0.5,
    Math.min(1, Math.max(0, height / (TOP - GROUND)))
  )
}

// The sky's radiance along a direction (unit, y up) from an altitude in
// metres, per unit of sun illuminance: single scattering marched to the top
// of the air or the sea, plus the multiple-scattering table. SKY_VIEW is the
// same integral on the GPU.
export function radiance(
  t: Tables,
  direction: Vector,
  altitude: number,
  sun: Vector,
  aerosol: number
): Vector {
  const r = GROUND + Math.max(altitude, 1) / 1000
  const mu = direction[1]
  const ground = sphere(r, mu, GROUND)
  const length = ground[0] > 0 ? ground[0] : sphere(r, mu, TOP)[1]
  const cosTheta =
    direction[0] * sun[0] + direction[1] * sun[1] + direction[2] * sun[2]
  const pr = rayleighPhase(cosTheta)
  const pm = miePhase(cosTheta, MIE_G)
  const steps = 32
  const light: Vector = [0, 0, 0]
  const through = [1, 1, 1]
  let previous = 0
  for (let i = 0; i < steps; i++) {
    const f = (i + 1) / steps
    const next = length * f * f
    const dt = next - previous
    const along = previous + dt * 0.3
    previous = next
    const p: Vector = [
      direction[0] * along,
      r + direction[1] * along,
      direction[2] * along,
    ]
    const height = Math.hypot(p[0], p[1], p[2])
    const m = medium(height - GROUND, aerosol)
    const smu = (p[0] * sun[0] + p[1] * sun[1] + p[2] * sun[2]) / height
    const sunT = transmittance(t.transmittance, height, smu)
    const ms = scatteringAt(t, smu, height - GROUND)
    for (let c = 0; c < 3; c++) {
      const source =
        sunT[c] * (m.rayleigh[c] * pr + m.mie * pm) +
        ms[c] * (m.rayleigh[c] + m.mie)
      const step = Math.exp(-m.extinction[c] * dt)
      const ext = Math.max(m.extinction[c], 1e-9)
      light[c] += (through[c] * (source - source * step)) / ext
      through[c] *= step
    }
  }
  return light
}

// The sunlight reaching an altitude, per unit of sun illuminance outside the air.
export function sunlight(t: Tables, altitude: number, sun: Vector): Vector {
  return transmittance(
    t.transmittance,
    GROUND + Math.max(altitude, 1) / 1000,
    sun[1]
  )
}

// ---------------------------------------------------------------- GLSL

// Declarations and functions every shader reading the atmosphere shares:
// u_transmittance and u_scattering are the two baked tables, u_altitude the
// camera's height in km, u_aerosol the aerosol optical depth they were baked
// for. The sky-view pass reads these alone (it draws u_sky, and must not also
// sample it); everything else takes ATMOSPHERE, which adds the sky-view lookup.
export const AIR = `
const float AT_GROUND=${GROUND.toFixed(1)}, AT_TOP=${TOP.toFixed(1)}, AT_HORIZON=${HORIZON.toFixed(6)};   // i18n-format-ok: a GLSL literal, never shown to a user
const vec3 AT_RAYLEIGH=vec3(${RAYLEIGH.map((v) => v.toExponential(4)).join(',')});
const vec3 AT_OZONE=vec3(${OZONE.map((v) => v.toExponential(4)).join(',')});
const float AT_MIE_SCATTER=${MIE_SCATTER.toExponential(4)}, AT_MIE_EXTINCT=${MIE_EXTINCT.toExponential(4)}, AT_MIE_G=${MIE_G.toFixed(2)}, AT_MIE_HEIGHT=${MIE_HEIGHT.toFixed(2)};   // i18n-format-ok: a GLSL literal, never shown to a user
const vec2 AT_SKY=vec2(${SKY.width.toFixed(1)},${SKY.height.toFixed(1)});   // i18n-format-ok: a GLSL literal, never shown to a user
uniform sampler2D u_transmittance, u_scattering; uniform float u_altitude, u_aerosol;
vec2 at_sphere(float r, float mu, float R){ float b=r*mu; float d=b*b-(r*r-R*R); if(d<0.0) return vec2(-1.0); float s=sqrt(d); return vec2(-b-s,-b+s); }
vec3 at_transmittance(float r, float mu){
	float rho=sqrt(max(0.0,r*r-AT_GROUND*AT_GROUND));
	if(mu<-rho/r) return vec3(0.0);
	float d=max(0.0,-r*mu+sqrt(max(0.0,r*r*(mu*mu-1.0)+AT_TOP*AT_TOP)));
	float near=AT_TOP-r, far=rho+AT_HORIZON;
	return texture2D(u_transmittance,vec2((d-near)/(far-near),rho/AT_HORIZON)).rgb; }
// between() above: the light passed from a point at r along mu to the point t km on.
vec3 at_between(float r, float mu, float t){
	float rt=sqrt(max(t*t+2.0*r*mu*t+r*r,0.0)), mt=clamp((r*mu+t)/rt,-1.0,1.0);
	bool ground=mu<-sqrt(max(0.0,1.0-AT_GROUND*AT_GROUND/(r*r)));
	vec3 near=ground?at_transmittance(rt,-mt):at_transmittance(r,mu), far=ground?at_transmittance(r,-mu):at_transmittance(rt,mt);
	return min(near/max(far,vec3(1.0e-6)),vec3(1.0)); }`

// The sky-view table, u_sky, and its lookup.
export const ATMOSPHERE = `${AIR}
uniform sampler2D u_sky;
// The sky-view table's lookup: the zenith angle packed so the horizon gets the
// rows (Hillaire's non-linear mapping about the true horizon at this height),
// the azimuth from the sun's.
vec2 at_sky_uv(vec3 dir, vec3 sun){
	float r=AT_GROUND+u_altitude; float cosBeta=sqrt(max(0.0,r*r-AT_GROUND*AT_GROUND))/r;
	float beta=acos(clamp(cosBeta,-1.0,1.0)); float zha=3.14159265-beta;
	float vz=clamp(dir.y,-1.0,1.0); vec2 uv;
	if(vz>=-cosBeta){ float c=1.0-sqrt(max(1.0-acos(vz)/zha,0.0)); uv.y=c*0.5; }
	else { uv.y=sqrt(max((acos(vz)-zha)/beta,0.0))*0.5+0.5; }
	float dl=length(dir.xz), sl=length(sun.xz); float c=1.0;
	if(dl>1.0e-6&&sl>1.0e-6) c=clamp(dot(dir.xz,sun.xz)/(dl*sl),-1.0,1.0);
	uv.x=sqrt(max(-c*0.5+0.5,0.0));
	return (uv*AT_SKY+0.5)/(AT_SKY+1.0); }
vec3 at_sky(vec3 dir, vec3 sun){ return texture2D(u_sky,at_sky_uv(dir,sun)).rgb; }`

// The sky-view table, drawn over a full-screen quad of SKY's size: for each
// texel the direction it stands for, and the light scattered toward the camera
// along it. radiance() above is the same integral.
export const SKY_VIEW_VERTEX = `varying vec2 v_uv;
void main(){ v_uv=uv; gl_Position=vec4(position.xy,0.0,1.0); }`

export const SKY_VIEW_FRAGMENT = `varying vec2 v_uv; uniform vec3 u_sun_view;
${AIR}
void main(){
	vec2 uv=(v_uv*(AT_SKY+1.0)-0.5)/AT_SKY;
	float r=AT_GROUND+u_altitude; float cosBeta=sqrt(max(0.0,r*r-AT_GROUND*AT_GROUND))/r;
	float beta=acos(clamp(cosBeta,-1.0,1.0)); float zha=3.14159265-beta; float vza;
	if(uv.y<0.5){ float c=1.0-2.0*uv.y; c=1.0-c*c; vza=zha*c; }
	else { float c=uv.y*2.0-1.0; vza=zha+beta*c*c; }
	float lvc=-(uv.x*uv.x*2.0-1.0); float lvs=sqrt(max(0.0,1.0-lvc*lvc));
	float sl=length(u_sun_view.xz); vec2 sa=sl>1.0e-6?u_sun_view.xz/sl:vec2(1.0,0.0), sb=vec2(-sa.y,sa.x);
	vec2 h=sa*lvc+sb*lvs; vec3 dir=vec3(sin(vza)*h.x,cos(vza),sin(vza)*h.y);
	vec2 ground=at_sphere(r,dir.y,AT_GROUND); float len=ground.x>0.0?ground.x:at_sphere(r,dir.y,AT_TOP).y;
	float ct=dot(dir,u_sun_view);
	float pr=3.0/(16.0*3.14159265)*(1.0+ct*ct);
	float g2=AT_MIE_G*AT_MIE_G; float pm=3.0/(8.0*3.14159265)*((1.0-g2)*(1.0+ct*ct))/((2.0+g2)*pow(max(1.0+g2-2.0*AT_MIE_G*ct,1.0e-4),1.5));
	vec3 light=vec3(0.0), through=vec3(1.0); float previous=0.0;
	for(int i=0;i<32;i++){
		float f=float(i+1)/32.0; float next=len*f*f; float dt=next-previous; float along=previous+dt*0.3; previous=next;
		vec3 p=vec3(dir.x*along,r+dir.y*along,dir.z*along); float height=length(p);
		float hk=max(height-AT_GROUND,0.0);
		vec3 rayleigh=AT_RAYLEIGH*exp(-hk/8.0); float density=exp(-hk/AT_MIE_HEIGHT)*u_aerosol/(AT_MIE_EXTINCT*AT_MIE_HEIGHT), mie=AT_MIE_SCATTER*density;
		vec3 ext=rayleigh+vec3(AT_MIE_EXTINCT*density)+AT_OZONE*max(0.0,1.0-abs(hk-25.0)/15.0);
		float smu=dot(p,u_sun_view)/height;
		vec3 sunT=at_transmittance(height,smu);
		vec3 ms=texture2D(u_scattering,vec2(smu*0.5+0.5,clamp(hk/(AT_TOP-AT_GROUND),0.0,1.0))).rgb;
		vec3 source=sunT*(rayleigh*pr+vec3(mie*pm))+ms*(rayleigh+vec3(mie));
		vec3 fade=exp(-ext*dt);
		light+=through*(source-source*fade)/max(ext,vec3(1.0e-9)); through*=fade; }
	gl_FragColor=vec4(light,1.0); }`

// The lit materials' haze, for three's own fog chunks (engine.ts rewrites them):
// extinction() above, the mean per km of the air between two heights (km), for
// an aerosol optical depth that three's fogDensity carries.
export const FOG = `
float at_fog(float low, float high, float aerosol){
	float a=max(min(low,high),0.0), b=max(max(low,high),0.0);
	if(b-a<1.0e-3) return ${RAYLEIGH_LUMINANCE.toExponential(6)}*exp(-a/8.0)+aerosol/${MIE_HEIGHT.toFixed(2)}*exp(-a/${MIE_HEIGHT.toFixed(2)}); // i18n-format-ok: a GLSL literal, never shown to a user
	float ca=${(RAYLEIGH_LUMINANCE * 8).toExponential(6)}*(1.0-exp(-a/8.0))+aerosol*(1.0-exp(-a/${MIE_HEIGHT.toFixed(2)})); // i18n-format-ok: a GLSL literal, never shown to a user
	float cb=${(RAYLEIGH_LUMINANCE * 8).toExponential(6)}*(1.0-exp(-b/8.0))+aerosol*(1.0-exp(-b/${MIE_HEIGHT.toFixed(2)})); // i18n-format-ok: a GLSL literal, never shown to a user
	return (cb-ca)/(b-a); }`
