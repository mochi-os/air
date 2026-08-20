// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { useEffect, useRef, useState } from 'react'
import { useLingui } from '@lingui/react'
import { msg } from '@lingui/core/macro'
import { Plural, Trans, useLingui as useLinguiMacro } from '@lingui/react/macro'
import { type MessageDescriptor } from '@lingui/core'
import { Button } from '@mochi/web/components/ui/button'
import { LogOut, Play, RotateCcw, Send, Settings as SettingsIcon } from 'lucide-react'
import { startGame, type GameHandle } from '../game/engine'
import { KEY_DEFAULTS, pretty } from '../game/keys'
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
  CHAFF: msg`CHAFF`,
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
  PADLOCK: msg`PADLOCK`,
  'PADLOCK OFF': msg`PADLOCK OFF`,
  'NO TARGET': msg`NO TARGET`,
  'M to close': msg`M to close`,
  'CONNECTION FAILED': msg`CONNECTION FAILED`,
  'LOADING FAILED': msg`LOADING FAILED`,
  'FLIGHT CORE FAILED': msg`FLIGHT CORE FAILED`,
  'SESSION ENDED': msg`SESSION ENDED`,
  KILL: msg`KILL`,
  EJECTED: msg`EJECTED`,
  'JETTISON: GEAR': msg`JETTISON: GEAR`,
  'NO TANKS': msg`NO TANKS`,
  'EMERG JETT': msg`EMERG JETT`,
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
  // The Case III recovery script (#205) — controller callsigns (MARSHAL,
  // APPROACH, PADDLES) stay verbatim like player callsigns; the call words
  // localise, same rule as the wingman brevity calls above.
  'PUSH TIME': msg`PUSH TIME`,
  COMMENCING: msg`COMMENCING`,
  EARLY: msg`EARLY`,
  LATE: msg`LATE`,
  PLATFORM: msg`PLATFORM`,
  'LEVEL AT 1200, DIRTY UP': msg`LEVEL AT 1200, DIRTY UP`,
  'CALL THE BALL': msg`CALL THE BALL`,
  'BREAK WHEN READY': msg`BREAK WHEN READY`,
  'BELOW 250 — GEAR AND FLAPS': msg`BELOW 250 — GEAR AND FLAPS`,
  'DIRTY UP': msg`DIRTY UP`,
  'DOWNWIND 600 FEET': msg`DOWNWIND 600 FEET`,
  // HORNET / BALL / CLARA / AUTO are deliberately absent: the type name and
  // the ball-call code words are spoken verbatim on every deck, like the
  // annunciators above — it is the surrounding call that localises.
}

// Mounts the imperative Three.js engine onto its canvases and tears it down on
// unmount. The engine owns the render loop; React owns the surrounding DOM.
// onReady hands the engine handle (stop/resume) back so the menu can resume a
// paused game; onExit fires when the player presses Esc in flight.
// The in-game help line, as ACTIONS rather than key caps — the caps are read
// from the binding table at render so the line cannot drift from the engine and
// follows the player's own remaps. Two actions on one entry render as "W/S".
// Views are the bare number row (engine.ts handles Digit1..5 directly, not
// through a rebindable action), so they are appended as literals.
const HINTS: { actions: string[]; label: React.ReactNode }[] = [
  { actions: ['pitch.down', 'pitch.up'], label: <Trans>pitch</Trans> },
  { actions: ['roll.left', 'roll.right'], label: <Trans>roll</Trans> },
  { actions: ['yaw.left', 'yaw.right'], label: <Trans>yaw</Trans> },
  { actions: ['throttle.down', 'throttle.up'], label: <Trans>throttle</Trans> },
  { actions: ['trim.up', 'trim.down'], label: <Trans>trim</Trans> },
  { actions: ['fire'], label: <Trans>fire</Trans> },
  { actions: ['select'], label: <Trans>weapon</Trans> },
  { actions: ['launch'], label: <Trans>launch / target</Trans> },
  { actions: ['flares'], label: <Trans>flares</Trans> },
  { actions: ['flaps.extend', 'flaps.retract'], label: <Trans>flaps</Trans> },
  { actions: ['gear'], label: <Trans>gear</Trans> },
  { actions: ['hook'], label: <Trans>hook</Trans> },
  { actions: ['atc'], label: 'ATC' },
  { actions: ['lights'], label: <Trans>lights</Trans> },
  { actions: ['brake.wheel'], label: <Trans>brakes</Trans> },
  { actions: ['brake.speed'], label: <Trans>speed brake</Trans> },
  { actions: ['map'], label: <Trans>map</Trans> },
  { actions: ['chat'], label: <Trans>chat</Trans> },
  { actions: ['menu'], label: <Trans>menu</Trans> },
]

export function GameCanvas({
  config,
  join = null,
  onExit,
  onReady,
  onSettings,
  onConfig,
  onAgain,
  flying,
}: {
  config?: MissionConfig
  join?: NetJoin | null
  onExit?: () => void
  onReady?: (handle: GameHandle) => void
  onSettings?: () => void
  onConfig?: (partial: Record<string, number | string>) => void
  onAgain?: () => void // remount a fresh mission after this one ended at a crash (#240)
  flying?: boolean
}) {
  const stageRef = useRef<HTMLCanvasElement>(null)
  const handleRef = useRef<GameHandle | null>(null)
  // the engine captures its callbacks once at startGame; the ref keeps the
  // latest closure live across re-renders (config identity changes per render)
  const onConfigRef = useRef(onConfig)
  onConfigRef.current = onConfig
  const chatRef = useRef<HTMLInputElement>(null)
  const [menu, setMenu] = useState(false)
  // The mission ended at a crash (#240): the engine reports how, and the menu
  // becomes the end-of-mission surface — outcome line, Fly again, no Resume.
  const [over, setOver] = useState<{ fate: string; struck: number; seconds: number } | null>(null)
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
  // The player's remap wins over the default, exactly as the engine's key_of does.
  const binding = (action: string) => config?.keys?.[action] ?? KEY_DEFAULTS[action]

  useEffect(() => {
    const translate = (text: string) => {
      const descriptor = HUD_MESSAGES[text]
      return descriptor ? i18nRef.current._(descriptor) : text
    }
    let game: GameHandle
    try {
      game = startGame({
        stage: stageRef.current!,
        hud: hudRef.current!,
        map: mapRef.current!,
        help: helpRef.current!,
        framerate: framerateRef.current!,
        config,
        join,
        onExit,
        onConfig: (partial: Record<string, number | string>) => onConfigRef.current?.(partial),
        onMenu: () => setMenu((open) => !open), // Esc toggles the popup (#84)
        onOver: (result: { fate: string; struck: number; seconds: number }) => {
          setOver(result)
          setMenu(true)
        },
        onChat: (scope) => setChat(scope),
        translate,
      })
    } catch (error) {
      // The engine constructor throws where WebGL 2 is missing (#55): return
      // to the menu, whose graphics banner names the culprit, instead of
      // crashing into the route's generic error page.
      console.error('engine failed to start', error)
      onExit?.()
      return
    }
    handleRef.current = game
    onReady?.(game)
    return () => game.stop()
    // Mount once; config is captured at launch (a new mission remounts via key).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-entering flight from the front page (Resume mission) closes the Esc
  // popup: it stayed open - and paused - behind the menu, so Resume appeared
  // to land back on the escape menu instead of flying.
  useEffect(() => {
    if (flying) setMenu(false)
  }, [flying])

  // Once the mission has ended the menu is MODAL: there is nothing behind it
  // but the frozen fireball, so any dismissal (Esc, the settings detour's
  // return) reopens it rather than stranding the player in a held world.
  useEffect(() => {
    if (over && !menu) setMenu(true)
  }, [over, menu])

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
          {/* Same visual language as the front page: card surface, solid primary,
              outline secondaries, leading icons. */}
          <div className='bg-background flex w-72 flex-col gap-2 rounded-lg border p-4 shadow-lg'>
            {over && (
              <div className='mb-1 text-center'>
                <p className='text-base font-medium'>
                  {over.fate === 'pilot' ? (
                    <Trans>Pilot killed</Trans>
                  ) : over.fate === 'fire' ? (
                    <Trans>Destroyed by fire</Trans>
                  ) : over.fate === 'sea' ? (
                    <Trans>Flew into the sea</Trans>
                  ) : over.fate === 'midair' ? (
                    <Trans>Midair collision</Trans>
                  ) : (
                    <Trans>Crashed</Trans>
                  )}
                </p>
                <p className='text-muted-foreground text-sm'>
                  {over.struck > 0 && (
                    <>
                      <Plural value={over.struck} one='# round taken' other='# rounds taken' />
                      {' · '}
                    </>
                  )}
                  {Math.floor(over.seconds / 60)}:{String(Math.floor(over.seconds % 60)).padStart(2, '0')}
                </p>
              </div>
            )}
            {over ? (
              <Button
                className='h-12 justify-start text-base'
                onClick={() => {
                  setOver(null)
                  onAgain?.()
                }}
              >
                <RotateCcw className='size-4' />
                <Trans>Fly again</Trans>
              </Button>
            ) : (
              <Button
                className='h-12 justify-start text-base'
                onClick={() => {
                  setMenu(false)
                  document.documentElement.requestFullscreen?.().catch(() => {}) // back to fullscreen flight; the click is the gesture
                }}
              >
                <Play className='size-4' />
                <Trans>Resume</Trans>
              </Button>
            )}
            {join && (
              <Button
                type='button'
                variant='outline'
                className='h-12 justify-start text-base'
                onClick={() => {
                  setMenu(false)
                  setChat(handleRef.current?.scope() ?? 'all')
                }}
              >
                <Send className='size-4' />
                <Trans>Send chat</Trans>
              </Button>
            )}
            {onSettings && (
              <Button
                type='button'
                variant='outline'
                className='h-12 justify-start text-base'
                onClick={() => onSettings()}
              >
                {/* Tuning over the PAUSED, visible scene is the best place to do
                    it — the graphics knobs apply against the frame you are
                    looking at. The dialog fences input while open so a rebind
                    cannot reach the jet (in a match it keeps flying). */}
                <SettingsIcon className='size-4' />
                <Trans>Settings</Trans>
              </Button>
            )}
            <Button
              type='button'
              variant='outline'
              className='h-12 justify-start text-base'
              onClick={() => {
                setMenu(false)
                handleRef.current?.exit()
              }}
            >
              <LogOut className='size-4' />
              {/* A MISSION is yours to leave; a MATCH continues without you. */}
              {join ? <Trans>Exit match</Trans> : <Trans>Exit mission</Trans>}
            </Button>
            {join && (
              <p className='text-muted-foreground text-center text-xs'>
                <Trans>The match continues behind this menu.</Trans>
              </p>
            )}
          </div>
        </div>
      )}
      <div className='panel' id='help' ref={helpRef}>
        {/* Key legends are <kbd>, the element that means "keyboard input";
            the action beside each one is prose and stays wrapped. Two <b>
            below are emphasis on translated text, not keys, so they stay <b>.
            The legends are DERIVED from the binding table rather than written
            out: hand-written ones went stale and lied — this line advertised F
            for flares long after F became the flaps switch and flares moved to
            C, and offered V for view after V became the ACM control. Deriving
            them also means a player who remaps a key sees their own key here. */}
        {HINTS.map(({ actions, label }, index) => (
          <span key={index}>
            {index > 0 && ' · '}
            <kbd>{actions.map((action) => pretty(binding(action))).join('/')}</kbd> {label}
          </span>
        ))}
        {' · '}
        <kbd>1</kbd>–<kbd>5</kbd> <Trans>view</Trans>
        <br />
        <b>
          <Trans>Chase view:</Trans>
        </b>{' '}
        <b><Trans>Drag</Trans></b> <Trans>or</Trans> <kbd>←→</kbd> <Trans>orbit</Trans> · <kbd>↑↓</kbd>{' '}
        <Trans>tilt</Trans> · <kbd>−</kbd> <Trans>back</Trans> · <kbd>=</kbd>{' '}
        <Trans>closer</Trans>
      </div>
    </div>
  )
}
