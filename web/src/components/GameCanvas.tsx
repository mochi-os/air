// Copyright © 2026 Mochi OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { useEffect, useRef } from 'react'
import { useLingui } from '@lingui/react'
import { msg } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
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
  PAUSED: msg`PAUSED`,
  'WAITING FOR OPPONENT': msg`WAITING FOR OPPONENT`,
  "FIGHT'S ON": msg`FIGHT'S ON`,
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
  'P to resume · M map · Esc menu': msg`P to resume · M map · Esc menu`,
  'CONNECTION FAILED': msg`CONNECTION FAILED`,
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
  config?: MissionConfig & { cat?: number } // cat: carrier-start catapult 1-4, session-only (deliberately not part of the persisted MissionConfig)
  join?: NetJoin | null
  onExit?: () => void
  onReady?: (handle: GameHandle) => void
}) {
  const stageRef = useRef<HTMLCanvasElement>(null)
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
      translate,
    })
    onReady?.(game)
    return () => game.stop()
    // Mount once; config is captured at launch (a new mission remounts via key).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className='furball-game'>
      <canvas id='stage' ref={stageRef} tabIndex={0} />
      <canvas id='hud' ref={hudRef} />
      <canvas id='map' ref={mapRef} />
      <div className='panel' id='framerate' ref={framerateRef} />
      <div className='panel' id='help' ref={helpRef}>
        <b>W/S</b> <Trans>pitch</Trans> · <b>A/D</b>{' '}
        <Trans>roll</Trans> · <b>Q/E</b> <Trans>yaw</Trans> · <b>[/]</b>{' '}
        <Trans>throttle</Trans> · <b>Space</b> <Trans>guns</Trans> · <b>Enter</b>{' '}
        <Trans>launch</Trans> · <b>R</b> <Trans>missile</Trans> · <b>F</b> <Trans>flares</Trans> · <b>X</b>{' '}
        <Trans>rearm</Trans> · <b>G</b> <Trans>gear</Trans> · <b>H</b> <Trans>hook</Trans> · <b>L</b> <Trans>lights</Trans> ·{' '}
        <b>B</b> <Trans>brakes</Trans> · <b>/</b> <Trans>speed brake</Trans> ·{' '}
        <b>1</b>–<b>5</b>/<b>V</b> <Trans>view</Trans> · <b>M</b> <Trans>map</Trans> ·{' '}
        <b>P</b> <Trans>pause</Trans> · <b>Esc</b> <Trans>menu</Trans>
        <br />
        <b>
          <Trans>Chase view:</Trans>
        </b>{' '}
        <b>Drag</b> <Trans>or</Trans> <b>←→</b> <Trans>orbit</Trans> · <b>↑↓</b>{' '}
        <Trans>tilt</Trans> · <b>−</b> <Trans>back</Trans> · <b>=</b>{' '}
        <Trans>closer</Trans>
      </div>
    </div>
  )
}
