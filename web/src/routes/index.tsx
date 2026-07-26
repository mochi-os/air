// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { useEffect, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { shellSetTitle, useShellImmersive } from '@mochi/web'
import { GameCanvas } from '../components/GameCanvas'
import { MissionSetup } from '../components/MissionSetup'
import { useMissionConfig } from '../lib/config-store'
import { type GameHandle } from '../game/engine'
import { type Join as NetJoin } from '../game/net'
import { preload } from '../game/preload'

// The Settings tabs are COMPONENT state, not a route. Mirroring them in the URL
// made sense when tabs were the menu itself; now Settings is a dialog, so a tab
// is transient UI — and inside the shell iframe every change relayed a
// navigation to the parent, rewriting the address bar and stacking a history
// entry per click (#77).
type SetupTab = 'general' | 'graphics' | 'sound' | 'controls' | 'keys' // the Settings dialog's tabs (#77): mission, weather and history became their own surfaces

// Inside the menu shell the top window owns the browser tab; without this it
// stays titled "Mochi" no matter what the app's own index.html says.
function useTabTitle() {
  useEffect(() => {
    shellSetTitle('Air')
    // Start the big asset downloads (models + flight core) while the player is
    // still in the menu: by the time they start a mission the loading screen
    // usually costs nothing, and the engine joins these same in-flight fetches.
    preload()
  }, [])
}

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
  const [join, setJoin] = useState<NetJoin | null>(null)
  const fly =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('developer') === '1' &&
    new URLSearchParams(window.location.search).has('fly') // dev/screenshot hook: ?developer=1&fly=1 skips the menu straight into a mission with saved config (#105: all hooks live behind developer mode)
  const [started, setStarted] = useState(fly)
  const [menuOpen, setMenuOpen] = useState(!fly)
  const [gameKey, setGameKey] = useState(0)
  const gameRef = useRef<GameHandle | null>(null)

  const [tab, setTab] = useState<SetupTab>('general')

  const inFlight = started && !menuOpen

  // Hide the shell chrome while in flight; the hook's heartbeat lets the shell
  // restore it automatically if air crashes or is closed.
  useShellImmersive(inFlight)
  useTabTitle()

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
          join={join}
          onReady={(h) => {
            gameRef.current = h
          }}
          onExit={leaveFlight}
          onSettings={() => {
            // Settings over a paused mission: reuse the one menu surface rather
            // than a second copy of every panel. Resume returns to flight.
            setTab('general')
            leaveFlight()
          }}
        />
      )}
      {menuOpen && (
        <MissionSetup
          config={config}
          onChange={setConfig}
          tab={tab}
          onTabChange={(t) => setTab(t as SetupTab)}
          gameInProgress={started}
          onStart={() => {
            setJoin(null)
            setGameKey((k) => k + 1)
            setStarted(true)
            enterFlight()
          }}
          onJoin={(info) => {
            setJoin(info)
            setGameKey((k) => k + 1)
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

export const Route = createFileRoute('/')({
  component: Index,
  // tab is optional so navigations to '/' (e.g. shared error pages) needn't supply it;
  // it's defaulted to 'mission' on read.
  // A legacy ?tab= is accepted and ignored: old links must not error.
  validateSearch: (): Record<string, never> => ({}),
})
