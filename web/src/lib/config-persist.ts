// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The load-completion decision for the mission config, isolated from the React
// hook (and @mochi/web) so it is unit testable. When config/load resolves:
//   - the player edited while it was in flight -> FLUSH: persist their edit and
//     keep it (a debounced save that fired before the identity was known was
//     dropped, so this is the point that actually saves it — never discard it)
//   - the server returned a saved config       -> APPLY it
//   - nothing was saved yet                     -> SEED the server from local
import type { MissionConfig } from './config'

export type LoadOutcome = 'flush' | 'apply' | 'seed'

export function loadOutcome(
  dirty: boolean,
  saved: Partial<MissionConfig> | null
): LoadOutcome {
  if (dirty) return 'flush'
  return saved ? 'apply' : 'seed'
}
