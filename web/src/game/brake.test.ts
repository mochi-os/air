// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// A remote jet's speed brake is animated from the target the wire carries,
// eased at the actuator's own travel (2.5 s stowed to full, the flight
// core's Rate.Brake) so a wingman's panel opens at the pace the ownship's
// does. engine.ts cannot be imported (WebGL at module scope).
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')

describe('the remote speed brake', () => {
  it("opens at the actuator's pace", () => {
    const line = /st\.speedbrake\+=THREE\.MathUtils\.clamp\(\(st\.speedbrakeTarget\?\?0\)-st\.speedbrake,-([\d.]+)\*dt,([\d.]+)\*dt\);/.exec(source)
    expect(line).not.toBeNull()
    expect(Number(line?.[1])).toBeCloseTo(0.4, 5)
    expect(Number(line?.[2])).toBeCloseTo(0.4, 5)
  })
})
