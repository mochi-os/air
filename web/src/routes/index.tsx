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

// Mission-setup tabs are mirrored in the URL (?tab=…) so the address bar tracks
// the active tab and it's shareable / back-navigable, like other Mochi apps.
type SetupTab = 'mission' | 'weather' | 'controls' | 'graphics'
const SETUP_TABS: SetupTab[] = ['mission', 'weather', 'controls', 'graphics']

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

  const { tab = 'mission' } = Route.useSearch()
  const navigate = Route.useNavigate()
  const setTab = (t: string) =>
    navigate({ search: (prev) => ({ ...prev, tab: t as SetupTab }) })

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
        />
      )}
      {menuOpen && (
        <MissionSetup
          config={config}
          onChange={setConfig}
          tab={tab}
          onTabChange={setTab}
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
  validateSearch: (search: Record<string, unknown>): { tab?: SetupTab } =>
    SETUP_TABS.includes(search.tab as SetupTab) ? { tab: search.tab as SetupTab } : {},
})
