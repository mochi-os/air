// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { audio_gesture } from '../game/audio'
import { createFileRoute } from '@tanstack/react-router'
import { shellSetTitle, useShellImmersive } from '@mochi/web'
import { MissionSetup } from '../components/MissionSetup'
import { useMissionConfig } from '../lib/config-store'
// Type-only, so the statement is erased at build. Keep it that way: a VALUE
// import from the engine here would undo the lazy split below.
import { type GameHandle } from '../game/engine'
import { type Join as NetJoin } from '../game/net'
import { preload } from '../game/preload'

// The engine and three.js are by far the largest chunk air ships (1,094 kB
// raw). Keep it lazy: imported statically it lands in the MENU's chunk. It is
// warmed in the same effect that starts the asset downloads.
const GameCanvas = lazy(() =>
  import('../components/GameCanvas').then((m) => ({ default: m.GameCanvas }))
)

// The Settings tabs are COMPONENT state, not a route: inside the shell iframe
// every URL change relays a navigation to the parent, stacking a history entry
// per click (#77).
type SetupTab = 'general' | 'graphics' | 'sound' | 'controls' | 'keys' /* #57 parked: | 'head' */ // the Settings dialog's tabs (#77): mission, weather and history became their own surfaces

// Inside the menu shell the top window owns the browser tab; without this it
// stays titled "Mochi" no matter what the app's own index.html says.
function useTabTitle() {
  useEffect(() => {
    shellSetTitle('Air')
    // Start the big asset downloads (models + flight core) while the player is
    // still in the menu: by the time they start a mission the loading screen
    // usually costs nothing, and the engine joins these same in-flight fetches.
    preload()
    // The same idea for the engine's own chunk, now that it is lazy: fetched
    // AFTER the menu has painted rather than before, so it costs the first
    // render nothing and is warm by the time Fly is pressed.
    void import('../components/GameCanvas')
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
    // Arm the audio context HERE, synchronously inside the click dispatch
    // (#55): a resume in a genuine event handler always satisfies the autoplay
    // policy, and a HOTAS-only pilot fires no DOM events at all once flying.
    audio_gesture()
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
        <Suspense fallback={<div className='fixed inset-0 z-20 bg-[#0a1412]' />}>
          <GameCanvas
            key={gameKey}
            config={config}
            join={join}
            onReady={(h) => {
              gameRef.current = h
            }}
            onExit={() => {
              // The mission is OVER, not suspended: exit_match has written the
              // flight to History and closed any transport, so leaving
              // `started` true offers Resume on a torn-down session and
              // collides the next sortie's record. The crash path ends through
              // onOver.
              setStarted(false)
              leaveFlight()
            }}
            onConfigChange={setConfig}
            onConfig={(partial) => {
              // Engine-side setting changes (per-view zoom, the DDI view's
              // remembered display) merge into the same persisted config the
              // menu owns — one store, one save path.
              setConfig({ ...config, ...partial })
            }}
            onAgain={() => {
              // Fly again after the mission ended at a crash (#240) or Restart
              // from the pause menu: a fresh mount, same setup.
              setGameKey((k) => k + 1)
              enterFlight()
            }}
          />
        </Suspense>
      )}
      {menuOpen && (
        <MissionSetup
          config={config}
          onChange={setConfig}
          tab={tab}
          onTabChange={(t) => setTab(t as SetupTab)}
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
        />
      )}
    </>
  )
}

export const Route = createFileRoute('/')({
  component: Index,
  // Pass search through UNCHANGED: validateSearch strips anything it does not
  // return, and the engine reads ?developer / ?fly / ?start / ?view straight
  // off location.search. History is its own route, so a legacy ?tab= or
  // ?page=history is accepted and ignored.
  validateSearch: (search: Record<string, unknown>) => search,
})
