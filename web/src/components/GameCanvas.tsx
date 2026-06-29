// Copyright © 2026 Mochi OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { useEffect, useRef } from 'react'
import { startGame, type GameHandle } from '../game/engine'
import { type MissionConfig } from '../lib/config'
import '../game/game.css'

// Mounts the imperative Three.js engine onto its canvases and tears it down on
// unmount. The engine owns the render loop; React owns the surrounding DOM.
// onReady hands the engine handle (stop/resume) back so the menu can resume a
// paused game; onExit fires when the player presses Esc in flight.
export function GameCanvas({
  config,
  onExit,
  onReady,
}: {
  config?: MissionConfig
  onExit?: () => void
  onReady?: (handle: GameHandle) => void
}) {
  const stageRef = useRef<HTMLCanvasElement>(null)
  const hudRef = useRef<HTMLCanvasElement>(null)
  const mapRef = useRef<HTMLCanvasElement>(null)
  const helpRef = useRef<HTMLDivElement>(null)
  const framerateRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const game = startGame({
      stage: stageRef.current!,
      hud: hudRef.current!,
      map: mapRef.current!,
      help: helpRef.current!,
      framerate: framerateRef.current!,
      config,
      onExit,
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
        <b>W/S</b> or <b>↑/↓</b> pitch · <b>A/D</b> roll · <b>Q/E</b> yaw ·{' '}
        <b>Shift/Ctrl</b> throttle · <b>Space</b> launch / guns · <b>R</b> missile ·{' '}
        <b>F</b> flares · <b>X</b> rearm · <b>V</b> view · <b>M</b> map · <b>P</b> pause ·{' '}
        <b>H</b> help · <b>Esc</b> menu
        <br />
        <b>Chase view:</b> <b>Shift</b>+<b>←→</b> orbit · <b>,</b>/<b>.</b> tilt · <b>−</b> back ·{' '}
        <b>=</b> closer
      </div>
    </div>
  )
}
