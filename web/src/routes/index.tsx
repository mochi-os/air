// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { shellSetTitle, useShellImmersive } from '@mochi/web'
import { MissionSetup } from '../components/MissionSetup'
import { useMissionConfig } from '../lib/config-store'
// Type-only, so the statement is erased at build. Keep it that way: a VALUE
// import from the engine here would undo the lazy split below.
import { type GameHandle } from '../game/engine'
import { type Join as NetJoin } from '../game/net'
import { preload } from '../game/preload'

// The engine and three.js are 1,094 kB raw / 338 kB gzipped — measured, and the
// one chunk that dwarfs everything else air ships. Imported statically it landed
// in the MENU's chunk, so the front page downloaded and parsed the whole
// simulator before the player had clicked anything. Lazy here, and warmed in the
// same effect that starts the asset downloads, so pressing Fly still costs
// nothing.
const GameCanvas = lazy(() =>
  import('../components/GameCanvas').then((m) => ({ default: m.GameCanvas }))
)

// The Settings tabs are COMPONENT state, not a route. Mirroring them in the URL
// made sense when tabs were the menu itself; now Settings is a dialog, so a tab
// is transient UI — and inside the shell iframe every change relayed a
// navigation to the parent, rewriting the address bar and stacking a history
// entry per click (#77).
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
  const [settingsNonce, setSettingsNonce] = useState(0)

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
        // fallback={null} on purpose: the engine draws its own LOADING screen
        // the moment it mounts, and a spinner in front of that would be the only
        // thing that ever flashed. The chunk is warmed at menu open anyway.
        <Suspense fallback={null}>
          <GameCanvas
            key={gameKey}
            config={config}
            join={join}
            onReady={(h) => {
              gameRef.current = h
            }}
            onExit={() => {
              // Leaving the mission clears any pending settings request: the
              // nonce survives into MissionSetup's fresh mount, and a stale one
              // reopened the settings dialog over the front page.
              setSettingsNonce(0)
              // The mission is OVER, not suspended. exit_match has already written
              // the flight to History and, in multiplayer, closed the transport and
              // latched session_over — so leaving `started` true made the front
              // page offer Resume mission for a mission that had ended. Resuming
              // set running=true again on a torn-down session (flying on with no
              // server and no way back), and in single player it reused
              // mission_began, so the next exit's record collided with the first
              // on the (world, session, started) index and the second sortie never
              // reached the logbook. Unmounting also runs GameCanvas's cleanup,
              // which stops the engine. The crash path is untouched: that ends
              // through onOver, which keeps its own Fly again surface.
              setStarted(false)
              leaveFlight()
            }}
            flying={inFlight}
            onConfig={(partial) => {
              // Engine-side setting changes (per-view zoom, the DDI view's
              // remembered display) merge into the same persisted config the
              // menu owns — one store, one save path.
              setConfig({ ...config, ...partial })
            }}
            onAgain={() => {
              // Fly again after the mission ended at a crash (#240): a fresh
              // mount, same setup — the same path Restart mission takes.
              setGameKey((k) => k + 1)
              enterFlight()
            }}
            onSettings={() => {
              // Settings over a paused mission: reuse the one menu surface rather
              // than a second copy of every panel. Resume returns to flight. The
              // nonce asks MissionSetup to OPEN its settings dialog — landing on
              // the front page alone left the button apparently dead.
              setTab('general')
              setSettingsNonce((n) => n + 1)
              leaveFlight()
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
          settingsNonce={settingsNonce}
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
  // History is its own ROUTE (/history, declared in app.json like the root), so
  // nothing about it belongs in this route's search. A legacy ?tab= or
  // ?page=history is accepted and ignored: old links must not error.
  // Pass search through UNCHANGED. validateSearch strips anything it does not
  // return, and the engine reads ?developer / ?fly / ?start / ?view and the
  // rest straight off location.search — an allow-list here deleted every dev
  // hook but the one it named, and a joust launched from a link stopped
  // launching at all.
  validateSearch: (search: Record<string, unknown>) => search,
})
