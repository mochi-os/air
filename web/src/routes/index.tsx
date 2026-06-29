// Copyright © 2026 Mochi OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useShellStorage } from '@mochi/web'
import { GameCanvas } from '../components/GameCanvas'
import { MissionSetup } from '../components/MissionSetup'
import { DEFAULT_CONFIG, type MissionConfig } from '../lib/config'

// Menu ↔ game state machine: the setup menu collects config (persisted across
// reloads via the shell), launches the game on start, and the game returns here
// on Esc (which unmounts <GameCanvas>, tearing the engine down).
function Index() {
  const [config, setConfig] = useShellStorage<MissionConfig>('furball.config', DEFAULT_CONFIG)
  const [playing, setPlaying] = useState(false)

  if (playing) {
    return <GameCanvas config={config} onExit={() => setPlaying(false)} />
  }
  return <MissionSetup config={config} onChange={setConfig} onStart={() => setPlaying(true)} />
}

export const Route = createFileRoute('/')({ component: Index })
