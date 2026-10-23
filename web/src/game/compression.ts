// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Single player's time compression: the rates the pilot steps through, the
// core step each rate flies at, and how the corner writes the rate.

export const SLOWEST = 0.25
export const FASTEST = 64

// faster doubles the rate (Home) and slower halves it (End), within ¼× to 64×.
export function faster(rate: number): number {
  return Math.min(FASTEST, rate * 2)
}
export function slower(rate: number): number {
  return Math.max(SLOWEST, rate / 2)
}

// stepping is the seconds a core step covers at a rate. Up to 16× the core keeps
// its 1/240 s step: 16× at 60 fps is 64 steps a frame, about 5 ms of wasm. Past
// that the step lengthens so a frame still needs about 64: 1/120 s at 32×,
// 1/60 s at 64×, which stays within 1.6 degrees of attitude of the 1/240 s step
// over half a minute of hard turning (world flight TestIntervalCompression).
export function stepping(rate: number): number {
  return Math.min(1 / 60, Math.max(1 / 240, rate / 3840))
}

// chunking is the seconds of each world step at a rate: a 60th of a second to
// 16×, then longer, so a 60 fps frame runs at most 16 and each flies several of
// the core's steps in one call: 1/30 s at 32×, 1/15 s at 64×. A world step costs
// about a tenth of a millisecond beyond its core steps (reading the core, the
// cautions, the effects), and 64 of them a frame spent the frame's budget before
// the world had run at 16×. The bandit's brain, the missiles and the damage
// cascade keep their own 60 Hz steps within it.
export function chunking(rate: number): number {
  return Math.min(1 / 15, Math.max(1 / 60, rate / 960))
}

// written is the rate as the corner shows it: 4×, ½×, ¼×.
export function written(rate: number): string {
  if (rate === 0.5) return '½×'
  if (rate === 0.25) return '¼×'
  return `${Math.round(rate)}×`
}

// shortfall is whether the world ran more than a twentieth below the rate the
// pilot asked for, which the corner warns of under the rate.
export function shortfall(rate: number, achieved: number): boolean {
  return achieved < rate * 0.95
}

// attained is the rate the world reached as the warning writes it, with the
// decimals to write it to: rounded down, so it never reads as the rate asked
// for, in whole numbers from 2× and tenths below.
export function attained(achieved: number): [number, number] {
  if (achieved >= 2) return [Math.floor(achieved), 0]
  return [Math.floor(achieved * 10) / 10, 1]
}
