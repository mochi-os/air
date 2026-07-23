// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { useEffect, useRef, useState } from 'react'
import { useLingui } from '@lingui/react'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui as useLinguiMacro } from '@lingui/react/macro'
import { type MessageDescriptor } from '@lingui/core'
import { startGame, type GameHandle } from '../game/engine'
import { type Join as NetJoin } from '../game/net'
import { type MissionConfig } from '../lib/config'
import '../game/game.css'

// Player-facing HUD strings the engine draws on the 2D canvas. Declared here (in a
// React module) so the Lingui macro extracts them; the engine is framework-agnostic
// and receives a `translate` that resolves these against the active locale.
// Aviation unit/instrument tokens (KCAS, FT, NM, kt, IR, G, M, α, THR, CV) are left
// untranslated on purpose — they're standard on real HUDs regardless of language.
const HUD_MESSAGES: Record<string, MessageDescriptor> = {
  GUN: msg`GUN`,
  FLARES: msg`FLARES`,
  GEAR: msg`GEAR`,
  HOOK: msg`HOOK`,
  'SPD BK': msg`SPD BK`,
  YOU: msg`YOU`,
  'WAITING FOR OPPONENT': msg`WAITING FOR OPPONENT`,
  "FIGHT'S ON": msg`FIGHT'S ON`,
  FUEL: msg`FUEL`,
  'BINGO FUEL': msg`BINGO FUEL`,
  'FUEL LO': msg`FUEL LO`,
  INVULNERABLE: msg`INVULNERABLE`,
  REARMED: msg`REARMED`,
  FLAMEOUT: msg`FLAMEOUT`,
  'FUEL FIRE': msg`FUEL FIRE`,
  'L ENG FIRE': msg`L ENG FIRE`,
  'R ENG FIRE': msg`R ENG FIRE`,
  'L ENG': msg`L ENG`,
  'R ENG': msg`R ENG`,
  'NOSE GEAR': msg`NOSE GEAR`,
  'L GEAR': msg`L GEAR`,
  'R GEAR': msg`R GEAR`,
  'FUEL LEAK': msg`FUEL LEAK`,
  FCS: msg`FCS`,
  STRUCTURE: msg`STRUCTURE`,
  LOADING: msg`LOADING`,
  CRASHED: msg`CRASHED`,
  'PRESS ENTER TO LAUNCH': msg`PRESS ENTER TO LAUNCH`,
  LIGHTS: msg`LIGHTS`,
  'RUN UP ENGINE': msg`RUN UP ENGINE`,
  '1 WIRE': msg`1 WIRE`,
  '2 WIRE': msg`2 WIRE`,
  '3 WIRE': msg`3 WIRE`,
  OK: msg`OK`,
  FAIR: msg`FAIR`,
  'NO-GRADE': msg`NO-GRADE`,
  CUT: msg`CUT`,
  BOLTER: msg`BOLTER`,
  'WAVE OFF': msg`WAVE OFF`,
  'DECK POSITION SAVED': msg`DECK POSITION SAVED`,
  'TACTICAL MAP': msg`TACTICAL MAP`,
  'M to close': msg`M to close`,
  'CONNECTION FAILED': msg`CONNECTION FAILED`,
  'LOADING FAILED': msg`LOADING FAILED`,
  'FLIGHT CORE FAILED': msg`FLIGHT CORE FAILED`,
  'SESSION ENDED': msg`SESSION ENDED`,
  KILL: msg`KILL`,
  EJECTED: msg`EJECTED`,
  'PILOT DOWN': msg`PILOT DOWN`,
  // The caution-panel annunciators (L ENG FIRE, FUEL LEAK, FCS, STRUCTURE, …)
  // are deliberately NOT in this catalog: real F/A-18 annunciators read in
  // English in every operator's cockpit, so they fall through translate()
  // verbatim — the same policy as the HUD's standard flight symbology.
  WINS: msg`WINS`,
  JOINED: msg`JOINED`,
  LEFT: msg`LEFT`,
  // Wingman brevity calls (#139) — the caller's name stays verbatim, the call
  // words localise (unlike the annunciators above, these are radio speech).
  ENGAGED: msg`ENGAGED`,
  'BREAK RIGHT': msg`BREAK RIGHT`,
  'BREAK LEFT': msg`BREAK LEFT`,
  MISSILE: msg`MISSILE`,
  // The comms log's team-chat prefix (#84).
  TEAM: msg`TEAM`,
  // The flavour radio tier (#146) — log-only calls.
  SPLASH: msg`SPLASH`,
  TALLY: msg`TALLY`,
  REJOINING: msg`REJOINING`,
}

// Mounts the imperative Three.js engine onto its canvases and tears it down on
// unmount. The engine owns the render loop; React owns the surrounding DOM.
// onReady hands the engine handle (stop/resume) back so the menu can resume a
// paused game; onExit fires when the player presses Esc in flight.
export function GameCanvas({
  config,
  join = null,
  onExit,
  onReady,
}: {
  config?: MissionConfig
  join?: NetJoin | null
  onExit?: () => void
  onReady?: (handle: GameHandle) => void
}) {
  const stageRef = useRef<HTMLCanvasElement>(null)
  const handleRef = useRef<GameHandle | null>(null)
  const chatRef = useRef<HTMLInputElement>(null)
  const [menu, setMenu] = useState(false)
  const [chat, setChat] = useState<string | null>(null) // the open chat prompt's scope, null when closed
  const { t } = useLinguiMacro()
  const hudRef = useRef<HTMLCanvasElement>(null)
  const mapRef = useRef<HTMLCanvasElement>(null)
  const helpRef = useRef<HTMLDivElement>(null)
  const framerateRef = useRef<HTMLDivElement>(null)

  // Keep the active i18n in a ref so the (mount-once) engine always resolves HUD
  // text against the current locale without remounting.
  const { i18n } = useLingui()
  const i18nRef = useRef(i18n)
  i18nRef.current = i18n

  useEffect(() => {
    const translate = (text: string) => {
      const descriptor = HUD_MESSAGES[text]
      return descriptor ? i18nRef.current._(descriptor) : text
    }
    const game = startGame({
      stage: stageRef.current!,
      hud: hudRef.current!,
      map: mapRef.current!,
      help: helpRef.current!,
      framerate: framerateRef.current!,
      config,
      join,
      onExit,
      onMenu: () => setMenu((open) => !open), // Esc toggles the popup (#84)
      onChat: (scope) => setChat(scope),
      translate,
    })
    handleRef.current = game
    onReady?.(game)
    return () => game.stop()
    // Mount once; config is captured at launch (a new mission remounts via key).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The popup pauses single player; a multiplayer server flies on regardless.
  useEffect(() => {
    if (!join) handleRef.current?.pause(menu)
  }, [menu, join])

  // Escape in browser fullscreen belongs to the browser: it exits fullscreen
  // before (or instead of) reaching the page. Losing fullscreen therefore
  // OPENS the menu popup — set, not toggled, so it converges with the
  // engine's own Esc handling whichever of the two fires.
  useEffect(() => {
    const fell = () => {
      if (!document.fullscreenElement) setMenu(true)
    }
    document.addEventListener('fullscreenchange', fell)
    return () => document.removeEventListener('fullscreenchange', fell)
  }, [])

  useEffect(() => {
    if (chat != null) chatRef.current?.focus()
  }, [chat])

  const send = () => {
    const words = chatRef.current?.value.trim()
    if (words && chat != null) handleRef.current?.chat(words, chat)
    if (chatRef.current) chatRef.current.value = ''
    setChat(null)
  }

  return (
    <div className='air-game'>
      <canvas id='stage' ref={stageRef} tabIndex={0} />
      <canvas id='hud' ref={hudRef} />
      <canvas id='map' ref={mapRef} />
      <div className='panel' id='framerate' ref={framerateRef} />
      {chat != null && (
        <div className='fixed top-56 left-10 z-30 flex items-center gap-2'>
          <span className='rounded bg-black/70 px-2 py-1 font-mono text-xs text-amber-200'>
            {chat === 'team' ? <Trans>Team</Trans> : <Trans>Everyone</Trans>}
          </span>
          <input
            ref={chatRef}
            maxLength={200}
            placeholder={chat === 'team' ? t`Message your team` : t`Message everyone`}
            className='w-96 rounded border border-white/30 bg-black/70 px-2 py-1 font-mono text-sm text-white outline-none placeholder:text-white/40'
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') send()
              if (e.key === 'Escape') {
                if (chatRef.current) chatRef.current.value = ''
                setChat(null)
              }
            }}
          />
        </div>
      )}
      {menu && (
        <div className='fixed inset-0 z-40 flex items-center justify-center bg-black/40'>
          <div className='flex w-64 flex-col gap-2 rounded-lg border border-white/20 bg-black/80 p-4'>
            <button
              type='button'
              className='rounded border border-white/25 px-3 py-2 text-sm text-white hover:bg-white/10'
              onClick={() => {
                setMenu(false)
                document.documentElement.requestFullscreen?.().catch(() => {}) // back to fullscreen flight; the click is the gesture
              }}
            >
              <Trans>Resume</Trans>
            </button>
            {join && (
              <button
                type='button'
                className='rounded border border-white/25 px-3 py-2 text-sm text-white hover:bg-white/10'
                onClick={() => {
                  setMenu(false)
                  setChat(handleRef.current?.scope() ?? 'all')
                }}
              >
                <Trans>Send chat</Trans>
              </button>
            )}
            <button
              type='button'
              className='rounded border border-white/25 px-3 py-2 text-sm text-white hover:bg-white/10'
              onClick={() => {
                setMenu(false)
                handleRef.current?.exit()
              }}
            >
              <Trans>Exit match</Trans>
            </button>
            {join && (
              <p className='text-center text-xs text-white/50'>
                <Trans>The match continues behind this menu.</Trans>
              </p>
            )}
          </div>
        </div>
      )}
      <div className='panel' id='help' ref={helpRef}>
        <b>W/S</b> <Trans>pitch</Trans> · <b>A/D</b>{' '}
        <Trans>roll</Trans> · <b>Q/E</b> <Trans>yaw</Trans> · <b>[/]</b>{' '}
        <Trans>throttle</Trans> · <b>Space</b> <Trans>fire</Trans> · <b>X</b>{' '}
        <Trans>weapon</Trans> · <b>Enter</b>{' '}
        <Trans>launch / target</Trans> · <b>F</b> <Trans>flares</Trans> · <b>G</b>{' '}
        <Trans>gear</Trans> · <b>H</b> <Trans>hook</Trans> · <b>P</b> {'ATC'} · <b>L</b> <Trans>lights</Trans> ·{' '}
        <b>B</b> <Trans>brakes</Trans> · <b>/</b> <Trans>speed brake</Trans> ·{' '}
        <b>1</b>–<b>5</b>/<b>V</b> <Trans>view</Trans> · <b>M</b> <Trans>map</Trans> ·{' '}
        <b>T</b> <Trans>chat</Trans> · <b>Esc</b> <Trans>menu</Trans>
        <br />
        <b>
          <Trans>Chase view:</Trans>
        </b>{' '}
        <b><Trans>Drag</Trans></b> <Trans>or</Trans> <b>←→</b> <Trans>orbit</Trans> · <b>↑↓</b>{' '}
        <Trans>tilt</Trans> · <b>−</b> <Trans>back</Trans> · <b>=</b>{' '}
        <Trans>closer</Trans>
      </div>
    </div>
  )
}
