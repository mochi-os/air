// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// One picture per setting value, for the two places that offer the same
// choices: the Create mission dialog and the Create match form on the server
// page. Kept out of menu-parts.tsx so that file stays components-only.

import {
  Cloud,
  CloudFog,
  CloudOff,
  CloudSun,
  Cloudy,
  Crosshair,
  Flag,
  Infinity as InfinityIcon,
  Moon,
  Radar,
  Rocket,
  Sun,
  Swords,
  Target,
  Users,
  type LucideIcon,
} from 'lucide-react'

export const TOD_ICONS: Record<string, LucideIcon> = {
  day: Sun,
  night: Moon,
}

export const CLOUD_ICONS: Record<string, LucideIcon> = {
  none: CloudOff,
  cumulus: Cloud,
  high_stratus: CloudSun,
  mid_stratus: Cloudy,
  low_stratus: CloudFog,
}

// The joust start: a merge is a pass down the throat, BVR opens on the radar.
export const START_ICONS: Record<string, LucideIcon> = {
  merge: Swords,
  bvr: Radar,
}

export const MODE_ICONS: Record<string, LucideIcon> = {
  furball: Users,
  joust: Crosshair,
  teams: Flag,
}

export const WEAPON_ICONS: Record<string, LucideIcon> = {
  guns: Target,
  fox2: Rocket,
  open: InfinityIcon,
}
