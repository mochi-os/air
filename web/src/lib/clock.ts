// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// clock reads a duration in seconds as m:ss under an hour and h:mm:ss from an
// hour, counting whole seconds elapsed. The one formatter for every duration
// the game shows - the flight log's rows and career total, the replay bar and
// the mission-over line - so a flight reads the same in each.
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const rest = whole % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours
    ? `${hours}:${pad(minutes)}:${pad(rest)}`
    : `${minutes}:${pad(rest)}`
}
