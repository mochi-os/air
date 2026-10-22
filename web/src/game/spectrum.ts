// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The wind sea as a spectrum, for the sea the high and ultra presets draw by
// FFT (Tessendorf, "Simulating Ocean Water", 2001). The trades' wind over a
// long fetch fixes how much energy each wavelength carries (JONSWAP) and how
// it spreads about the wind (Donelan-Banner); each cascade is one 256 square
// tile of the sea holding its own band of wavenumbers, so the three together
// carry every wavelength from the fetch's peak down to centimetres without
// counting any twice. The ground swell crossing the trades stays an analytic
// train in the sea shader.
//
// This half runs once on the CPU: the initial amplitudes, a gaussian random
// pair per wavevector scaled by the spectrum. The GPU evolves them in time
// and transforms them every frame (waves.ts).

export const SIZE = 256
export const CASCADES = [300, 57, 10.8] // m, each tile's side
export const GRAVITY = 9.81
const TENSION = 7.4e-5 // surface tension over density, m^3/s^2: capillary dispersion

export interface Wind {
  speed: number // m/s at 10 m
  direction: number // radians in the xz plane the wind blows toward
  fetch: number // m of open water it has blown over
}

export const omega = (k: number) => Math.sqrt(GRAVITY * k + TENSION * k * k * k)
const slope = (k: number) => (GRAVITY + 3 * TENSION * k * k) / (2 * omega(k)) // d omega / dk

// JONSWAP (Hasselmann et al., 1973): energy per unit angular frequency.
export function jonswap(
  w: number,
  peak: number,
  alpha: number,
  gamma: number
): number {
  const sigma = w <= peak ? 0.07 : 0.09
  const d = (w - peak) / (sigma * peak)
  const q = peak / w
  return (
    ((alpha * GRAVITY * GRAVITY) / Math.pow(w, 5)) *
    Math.exp(-1.25 * q * q * q * q) *
    Math.pow(gamma, Math.exp(-0.5 * d * d))
  )
}

// Donelan, Hamilton and Hui (1985) with Banner's (1990) tail: how the energy
// at a frequency spreads in direction, narrowest at the peak.
export function spread(theta: number, w: number, peak: number): number {
  const ratio = w / peak
  let beta: number
  if (ratio < 0.95) beta = 2.61 * Math.pow(ratio, 1.3)
  else if (ratio < 1.6) beta = 2.28 * Math.pow(ratio, -1.3)
  else
    beta = Math.pow(
      10,
      -0.4 + 0.8393 * Math.exp(-0.567 * Math.log(ratio * ratio))
    )
  const sech = 1 / Math.cosh(Math.max(-20, Math.min(20, beta * theta)))
  return (beta / (2 * Math.tanh(beta * Math.PI))) * sech * sech
}

export function peak(wind: Wind): number {
  return 22 * Math.pow((GRAVITY * GRAVITY) / (wind.speed * wind.fetch), 1 / 3)
}

const wrap = (a: number) =>
  a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI))

// The directional wavenumber spectrum, m^4: energy per unit area of k.
export function density(kx: number, kz: number, wind: Wind): number {
  const k = Math.hypot(kx, kz)
  if (k < 1e-6 || wind.speed < 0.1) return 0
  const w = omega(k)
  const top = peak(wind)
  const alpha =
    0.076 * Math.pow((wind.speed * wind.speed) / (wind.fetch * GRAVITY), 0.22)
  const theta = wrap(Math.atan2(kz, kx) - wind.direction)
  const s = jonswap(w, top, alpha, 3.3) * spread(theta, w, top)
  return (s * slope(k)) / k
}

// The band each cascade owns: from where the larger tile's resolution ends
// (six of its own cycles short of its Nyquist) to where the smaller begins.
export function bands(): [number, number][] {
  return CASCADES.map((L, c) => {
    const low = c === 0 ? 0 : (2 * Math.PI * 6) / L
    const high =
      c < CASCADES.length - 1
        ? (2 * Math.PI * 6) / CASCADES[c + 1]
        : ((Math.PI * SIZE) / L) * 0.98
    return [low, high]
  })
}

function random(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// The initial amplitudes, RGBA per texel of a (SIZE * cascades) x SIZE strip:
// h0(k) in rg and conj(h0(-k)) in ba, so the GPU's evolution needs no second
// lookup. Each is a complex gaussian scaled so the sea's height variance is
// the spectrum's. Wavevector (n - SIZE/2) * 2 pi / L for texel n, the spectrum's
// centre in the middle of each tile.
export function amplitudes(
  wind: Wind,
  seed: number
): Float32Array<ArrayBuffer> {
  const n = SIZE
  const table = new Float32Array(n * CASCADES.length * n * 4)
  const limits = bands()
  const next = random(seed)
  const gauss = () => {
    const u = Math.max(next(), 1e-12),
      v = next()
    const r = Math.sqrt(-2 * Math.log(u))
    return [r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v)]
  }
  for (let c = 0; c < CASCADES.length; c++) {
    const L = CASCADES[c]
    const dk = (2 * Math.PI) / L
    const [low, high] = limits[c]
    const draws = new Float32Array(n * n * 2)
    for (let i = 0; i < n * n; i++) {
      const [a, b] = gauss()
      draws[i * 2] = a
      draws[i * 2 + 1] = b
    }
    const amplitude = (kx: number, kz: number) => {
      const k = Math.hypot(kx, kz)
      if (k < low || k >= high) return 0
      return Math.sqrt(Math.max(density(kx, kz, wind), 0) / 4) * dk // each wavevector's wave is 2 Re(h0 e^(i(kx - wt))), variance 2|h0|^2, and E|xi|^2 is 2
    }
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const kx = (x - n / 2) * dk,
          kz = (y - n / 2) * dk
        const mx = (n - x) % n,
          my = (n - y) % n
        const a = amplitude(kx, kz),
          b = amplitude(-kx, -kz)
        const o = (y * n * CASCADES.length + c * n + x) * 4
        table[o] = draws[(y * n + x) * 2] * a
        table[o + 1] = draws[(y * n + x) * 2 + 1] * a
        table[o + 2] = draws[(my * n + mx) * 2] * b
        table[o + 3] = -draws[(my * n + mx) * 2 + 1] * b
      }
  }
  return table
}

// The sea's height variance the spectrum holds, m^2, summed over every
// cascade's band: four times its root is the significant wave height.
export function variance(wind: Wind): number {
  const n = SIZE
  const limits = bands()
  let sum = 0
  for (let c = 0; c < CASCADES.length; c++) {
    const dk = (2 * Math.PI) / CASCADES[c]
    const [low, high] = limits[c]
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const kx = (x - n / 2) * dk,
          kz = (y - n / 2) * dk
        const k = Math.hypot(kx, kz)
        if (k < low || k >= high) continue
        sum += density(kx, kz, wind) * dk * dk
      }
  }
  return sum
}

// The slope variance each cascade's band holds (both components), for the
// shader's account of the slopes a pixel cannot show.
export function slopes(wind: Wind): number[] {
  const n = SIZE
  return bands().map(([low, high], c) => {
    const dk = (2 * Math.PI) / CASCADES[c]
    let sum = 0
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const kx = (x - n / 2) * dk,
          kz = (y - n / 2) * dk
        const k = Math.hypot(kx, kz)
        if (k < low || k >= high) continue
        sum += density(kx, kz, wind) * k * k * dk * dk
      }
    return sum
  })
}
