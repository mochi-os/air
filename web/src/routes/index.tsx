// Copyright © 2026 Mochi OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { useEffect, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useShellImmersive } from '@mochi/web'
import { GameCanvas } from '../components/GameCanvas'
import { MissionSetup } from '../components/MissionSetup'
import { useMissionConfig } from '../lib/config-store'
import { type GameHandle } from '../game/engine'

function enterFullscreen() {
  // Requires the shell to grant the iframe allow="fullscreen"; a no-op (caught)
  // if the browser declines. Must be called from a user gesture.
  document.documentElement.requestFullscreen?.().catch(() => {})
}
function exitFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
}

// Menu ↔ game state machine. Once a mission starts the game stays mounted and
// alive; Escape pauses it and overlays the menu (Resume / Restart). "In flight"
// (game running, menu hidden) hides the Mochi shell chrome and goes fullscreen.
function Index() {
  const [config, setConfig] = useMissionConfig()
  const [started, setStarted] = useState(false)
  const [menuOpen, setMenuOpen] = useState(true)
  const [gameKey, setGameKey] = useState(0)
  const gameRef = useRef<GameHandle | null>(null)

  const inFlight = started && !menuOpen

  // Hide the shell chrome while in flight; the hook's heartbeat lets the shell
  // restore it automatically if furball crashes or is closed.
  useShellImmersive(inFlight)

  // Leaving fullscreen (Esc is always permitted) returns to the menu.
  useEffect(() => {
    function onFullscreenChange() {
      if (!document.fullscreenElement && inFlight) setMenuOpen(true)
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [inFlight])

  const enterFlight = () => {
    setMenuOpen(false)
    enterFullscreen()
  }
  const leaveFlight = () => {
    setMenuOpen(true)
    exitFullscreen()
  }

  return (
    <>
      {started && (
        <GameCanvas
          key={gameKey}
          config={config}
          onReady={(h) => {
            gameRef.current = h
          }}
          onExit={leaveFlight}
        />
      )}
      {menuOpen && (
        <MissionSetup
          config={config}
          onChange={setConfig}
          gameInProgress={started}
          onStart={() => {
            setStarted(true)
            enterFlight()
          }}
          onResume={() => {
            gameRef.current?.resume(config)
            enterFlight()
          }}
          onRestart={() => {
            setGameKey((k) => k + 1)
            enterFlight()
          }}
        />
      )}
    </>
  )
}

export const Route = createFileRoute('/')({ component: Index })
