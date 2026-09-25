// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { useEffect, useRef, useState } from 'react'
import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react'
import { Plural, Trans, useLingui as useLinguiMacro } from '@lingui/react/macro'
import { Button } from '@mochi/web/components/ui/button'
import {
  LogOut,
  Play,
  RotateCcw,
  Send,
  Settings as SettingsIcon,
  X,
} from 'lucide-react'
import { advance, wire, type Scope } from '../game/chat'
import { startGame, type GameHandle } from '../game/engine'
import '../game/game.css'
import { KEY_DEFAULTS, pretty } from '../game/keys'
import { type Join as NetJoin } from '../game/net'
import { type MissionConfig } from '../lib/config'
import { SettingsDialog } from './SettingsDialog'

// HUD strings the engine draws on the 2D canvas, declared in a React module so
// Lingui extracts them; the engine receives a `translate`. Aviation tokens
// (KCAS, FT, NM, kt, IR, G, M, α, THR, CV) stay untranslated.
const HUD_MESSAGES: Record<string, MessageDescriptor> = {
  GUN: msg`GUN`,
  FLARES: msg`FLARES`,
  CHAFF: msg`CHAFF`,
  GEAR: msg`GEAR`,
  HOOK: msg`HOOK`,
  // The rest of the configuration stack, which sat untranslated beside GEAR and
  // HOOK while going through the same translate() call (#109). Settled
  // 2026-09-08: what the pilot SETS is localised; deck code words are not (see
  // the note further down).
  PARK: msg`PARK`,
  PROBE: msg`PROBE`,
  CANOPY: msg`CANOPY`,
  'CANOPY LOCKED': msg`CANOPY LOCKED`,
  WINGS: msg`WINGS`,
  'WINGS LOCKED': msg`WINGS LOCKED`,
  'SPREAD WINGS': msg`SPREAD WINGS`,
  'SPD BK': msg`SPD BK`,
  'FUEL DUMP': msg`FUEL DUMP`,
  'L ENG SECURED': msg`L ENG SECURED`,
  'R ENG SECURED': msg`R ENG SECURED`,
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
  'WING UNLK': msg`WING UNLK`,
  'PARK BRK': msg`PARK BRK`,
  'PROBE UNLK': msg`PROBE UNLK`,
  FCS: msg`FCS`,
  STRUCTURE: msg`STRUCTURE`,
  LOADING: msg`LOADING`,
  CRASHED: msg`CRASHED`,
  // The death banner (#149). One whole sentence per outcome, with the callsign
  // interpolated rather than concatenated, so a translator can put the name
  // where their language needs it. The bare forms are for a multiplayer death
  // nobody is credited with.
  DESTROYED: msg`DESTROYED`,
  'DESTROYED BY {callsign}': msg({ message: 'DESTROYED BY {callsign}' }),
  COLLIDED: msg`COLLIDED`,
  'COLLIDED WITH {callsign}': msg({ message: 'COLLIDED WITH {callsign}' }),
  // The same events in the third person, for the comms log: the banner
  // is gone in three seconds and tells only the pilot who died, so the log
  // carries who did what to whom for everyone still flying. Lower case because
  // the names interpolated into these are people's callsigns, which keep the
  // case their owner chose.
  '{killer} destroyed {victim}': msg({
    message: '{killer} destroyed {victim}',
  }),
  '{victim} collided with {other}': msg({
    message: '{victim} collided with {other}',
  }),
  '{victim} crashed': msg({ message: '{victim} crashed' }),
  'PRESS ENTER TO LAUNCH': msg`PRESS ENTER TO LAUNCH`,
  LIGHTS: msg`LIGHTS`,
  'RUN UP ENGINE': msg`RUN UP ENGINE`,
  '1 WIRE': msg`1 WIRE`,
  '2 WIRE': msg`2 WIRE`,
  '3 WIRE': msg`3 WIRE`,
  '4 WIRE': msg`4 WIRE`,
  OK: msg({ message: 'OK', context: 'landing grade' }),
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
  WINS: msg`WINS`,
  JOINED: msg`JOINED`,
  LEFT: msg`LEFT`,
  // Wingman brevity calls (#139) — the caller's name stays verbatim, the call
  // words localise (unlike the annunciators above, these are radio speech).
  ENGAGED: msg`ENGAGED`,
  'BREAK RIGHT': msg`BREAK RIGHT`,
  'BREAK LEFT': msg`BREAK LEFT`,
  MISSILE: msg`MISSILE`,
  // The comms log's team-chat prefix (#84) and its server-wide chat prefix.
  TEAM: msg`TEAM`,
  EVERYONE: msg`EVERYONE`,
  // The flavour radio tier (#146) — log-only calls.
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
  // The coaching lines (engine.ts HINT), translated whole and split at the
  // "; " row break afterwards, so a translation keeps that break as "; ". A
  // line with a live figure names it as a placeholder; the values that fill
  // {power} and {side} are the four words after the lines.
  "Case I: fly up wake, {heading}, 800', 350 knots": msg({
    message: "Case I: fly up wake, {heading}, 800', 350 knots",
  }),
  "Starboard side: hold 800'; break past bow": msg`Starboard side: hold 800'; break past bow`,
  'Break: level turn, throttle idle, boards out, pull 1 g per 100 knots': msg`Break: level turn, throttle idle, boards out, pull 1 g per 100 knots`,
  'Roll out downwind: {heading}, 1NM abeam ship': msg({
    message: 'Roll out downwind: {heading}, 1NM abeam ship',
  }),
  "Below 250 knots: gear, full flaps, hook, descend to 600', slow to on-speed": msg`Below 250 knots: gear, full flaps, hook, descend to 600', slow to on-speed`,
  'Trim for amber light beside HUD (8.1° AOA), power for height': msg`Trim for amber light beside HUD (8.1° AOA), power for height`,
  "Downwind: level at 600', ship 1NM off wing": msg`Downwind: level at 600', ship 1NM off wing`,
  'Ship abeam: bank 27-30°, start down at 200-300 FPM': msg`Ship abeam: bank 27-30°, start down at 200-300 FPM`,
  "The 90: 450', 500 FPM": msg`The 90: 450', 500 FPM`,
  "The 45: 325-375', roll into groove, {heading}, fly ball with power": msg({
    message:
      "The 45: 325-375', roll into groove, {heading}, fly ball with power",
  }),
  "Case II: on final, {heading}, 1200', gear, flaps down, on-speed 8.1° AOA, 140 knots":
    msg({
      message:
        "Case II: on final, {heading}, 1200', gear, flaps down, on-speed 8.1\u00b0 AOA, 140 knots",
    }),
  'HUD needles: hold glideslope and centreline': msg`HUD needles: hold glideslope and centreline`,
  "Glideslope alive: start down, 800' at 2NM, 400' at 1NM, 200' at ½NM": msg`Glideslope alive: start down, 800' at 2NM, 400' at 1NM, 200' at ½NM`,
  "Case III: marshal 6000', 250 knots, final bearing {heading}, commence at zero":
    msg({
      message:
        "Case III: marshal 6000', 250 knots, final bearing {heading}, commence at zero",
    }),
  "Commencing: inbound {heading}, 250 knots, 4000 FPM down to 5000' platform":
    msg({
      message:
        "Commencing: inbound {heading}, 250 knots, 4000 FPM down to 5000' platform",
    }),
  "Below 5000': keep FPM less than altitude": msg`Below 5000': keep FPM less than altitude`,
  "Platform: 2000 FPM, level at 1200'": msg`Platform: 2000 FPM, level at 1200'`,
  '10NM: gear, full flaps, hook, on-speed 8.1° AOA by 6 NM, final bearing {heading}':
    msg({
      message:
        '10NM: gear, full flaps, hook, on-speed 8.1\u00b0 AOA by 6 NM, final bearing {heading}',
    }),
  "Fly needles down: 1200' at 3NM, 800' at 2NM, 400' at 1NM": msg`Fly needles down: 1200' at 3NM, 800' at 2NM, 400' at 1NM`,
  'Ball call: answer, fly ball to touchdown': msg`Ball call: answer, fly ball to touchdown`,
  'Wave-off: full power, boards in, wings level, climb, {heading}': msg({
    message: 'Wave-off: full power, boards in, wings level, climb, {heading}',
  }),
  "Bolter: full power, boards in, hook down, climb to 600', turn downwind, {heading}":
    msg({
      message:
        "Bolter: full power, boards in, hook down, climb to 600', turn downwind, {heading}",
    }),
  "Wave-off: full power, boards in, wings level, climb to 1200', {heading}":
    msg({
      message:
        "Wave-off: full power, boards in, wings level, climb to 1200', {heading}",
    }),
  "Bolter: full power, boards in, hook down, climb to 1200', turn downwind, {heading}":
    msg({
      message:
        "Bolter: full power, boards in, hook down, climb to 1200', turn downwind, {heading}",
    }),
  // #152: said once when the device does not report something it is bound to.
  'Some bound controls are not on this stick: check Settings, Joystick': msg`Some bound controls are not on this stick: check Settings, Joystick`,
  'On runway: half flaps, run up to military power, brakes off': msg`On runway: half flaps, run up to military power, brakes off`,
  '140 knots: rotate to 8° nose up': msg`140 knots: rotate to 8° nose up`,
  'Positive rate: gear up; flaps auto passing 250 knots': msg`Positive rate: gear up; flaps auto passing 250 knots`,
  'Climb out: runway heading {heading}, 350 knots': msg({
    message: 'Climb out: runway heading {heading}, 350 knots',
  }),
  "Initial: over runway, {heading}, 800', 350 knots": msg({
    message: "Initial: over runway, {heading}, 800', 350 knots",
  }),
  "Roll out downwind: {heading}, 800', 1 NM abeam runway": msg({
    message: "Roll out downwind: {heading}, 800', 1 NM abeam runway",
  }),
  "Below 250 knots: gear, full flaps; descend to 600', slow to on-speed": msg`Below 250 knots: gear, full flaps; descend to 600', slow to on-speed`,
  "Abeam numbers, 600': bank 27-30°, start down at 200-300 FPM": msg`Abeam numbers, 600': bank 27-30°, start down at 200-300 FPM`,
  'Final: runway heading {heading}, power for two red, two white on PAPI': msg({
    message:
      'Final: runway heading {heading}, power for two red, two white on PAPI',
  }),
  'Touchdown: throttle idle; aerobrake at 10° nose up, lower nose at 100 knots, brake': msg`Touchdown: throttle idle; aerobrake at 10° nose up, lower nose at 100 knots, brake`,
  "Go around: full power, boards in, wings level, climb on {heading} to 600'":
    msg({
      message:
        "Go around: full power, boards in, wings level, climb on {heading} to 600'",
    }),
  'Hooked up: run up to {power}, wipe out controls': msg({
    message: 'Hooked up: run up to {power}, wipe out controls',
  }),
  'Hand off stick; press enter to salute and launch': msg`Hand off stick; press enter to salute and launch`,
  'Off the cat: hand off stick, let jet rotate 12° nose up': msg`Off the cat: hand off stick, let jet rotate 12° nose up`,
  'Positive rate: take stick, gear up, flaps auto': msg`Positive rate: take stick, gear up, flaps auto`,
  "Clearing turn {side}, then parallel {heading} at 500', 300 knots to 7 miles":
    msg({
      message:
        "Clearing turn {side}, then parallel {heading} at 500', 300 knots to 7 miles",
    }),
  '7 miles: climb on course': msg`7 miles: climb on course`,
  'military power': msg`military power`,
  'full afterburner': msg`full afterburner`,
  right: msg`right`,
  left: msg`left`,
  // HORNET / BALL / CLARA / AUTO are deliberately absent, and are the ONLY
  // deliberate absences: the type name and the ball-call code words are spoken
  // verbatim on every deck, and it is the surrounding call that localises.
  // Everything else the HUD passes to translate() belongs in this catalog --
  // cautions and configuration included (#109/#110). A comment here used to
  // claim the annunciators were deliberately absent while all four sat eleven
  // lines above, translated; if a string is meant to read English, leave it out
  // of translate() rather than out of the catalog, where a miss is silent.
}

// The in-game help line as actions, not key caps: the caps are read from the
// binding table at render, so the line follows the player's remaps. Two actions
// on one entry render as "W/S". Views (Digit1..5) are handled directly by
// engine.ts, so they are appended as literals.
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
  onConfigChange,
  onConfig,
  onAgain,
  replay = null,
}: {
  config?: MissionConfig
  join?: NetJoin | null
  replay?: string | null // a stored recording to watch flown back, instead of a mission
  onExit?: () => void
  onReady?: (handle: GameHandle) => void
  onConfigChange?: (config: MissionConfig) => void
  onConfig?: (partial: Record<string, number | string>) => void
  onAgain?: () => void // remount a fresh mission after this one ended at a crash (#240)
}) {
  const stageRef = useRef<HTMLCanvasElement>(null)
  const handleRef = useRef<GameHandle | null>(null)
  const configRef = useRef(config)
  configRef.current = config
  const onConfigChangeRef = useRef(onConfigChange)
  onConfigChangeRef.current = onConfigChange
  // the engine captures its callbacks once at startGame; the ref keeps the
  // latest closure live across re-renders (config identity changes per render)
  const onConfigRef = useRef(onConfig)
  onConfigRef.current = onConfig
  const chatRef = useRef<HTMLInputElement>(null)
  const [menu, setMenu] = useState(false)
  const [settings, setSettings] = useState(false)
  const [settingsTab, setSettingsTab] = useState('general')
  // Unmount is not the pilot leaving. stop() ends through the engine's own
  // exit_match, which logs the flight and its recording and THEN reports
  // onExit — so the keyed remount behind Fly again had the
  // OUTGOING mission tell the route to leave the game, and the fresh mission
  // was torn down the frame after it began loading its map. Only the
  // cleanup-borne call is swallowed; the menu's Exit mission runs
  // handle.exit() itself and still reports.
  const closingRef = useRef(false)
  const menuRef = useRef<HTMLDivElement>(null)
  // The mission ended at a crash (#240): the engine reports how, and the menu
  // becomes the end-of-mission surface — outcome line, Fly again, no Resume.
  const [over, setOver] = useState<{
    fate: string
    struck: number
    seconds: number
  } | null>(null)
  const [chat, setChat] = useState<Scope | null>(null) // the open chat prompt's scope, null when closed
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
  const binding = (action: string) =>
    config?.keys?.[action] ?? KEY_DEFAULTS[action]

  useEffect(() => {
    const translate = (text: string, values?: Record<string, unknown>) => {
      const descriptor = HUD_MESSAGES[text]
      return descriptor
        ? i18nRef.current._(values ? { ...descriptor, values } : descriptor)
        : text
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
        onExit: () => {
          if (!closingRef.current) onExit?.()
        },
        onConfig: (partial: Record<string, number | string>) =>
          onConfigRef.current?.(partial),
        onMenu: () => setMenu((open) => !open), // Esc toggles the popup (#84)
        onOver: (result: { fate: string; struck: number; seconds: number }) => {
          setOver(result)
          setMenu(true)
        },
        onChat: (scope) => setChat(scope as Scope),
        replay,
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
    return () => {
      closingRef.current = true
      game.stop()
    }
    // Mount once; config is captured at launch (a new mission remounts via key).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  // Close the chat prompt, dropping any unsent words: the X and Send end here.
  // Escape is not the prompt's: it means the menu, here as everywhere, so the
  // browser's own use of it in fullscreen has nothing to collide with.
  const dismiss = () => {
    if (chatRef.current) chatRef.current.value = ''
    setChat(null)
  }

  // Escape in browser fullscreen is the browser's as well as the page's: it
  // leaves fullscreen AND delivers the key. Losing fullscreen therefore OPENS
  // the menu popup — set, not toggled, so it converges with the key's own
  // arrival whichever of the two fires first. An open chat prompt is left as
  // it is under the menu and gets the keyboard back on Resume.
  useEffect(() => {
    const fell = () => {
      if (!document.fullscreenElement) setMenu(true)
    }
    document.addEventListener('fullscreenchange', fell)
    return () => document.removeEventListener('fullscreenchange', fell)
  }, [])

  // The prompt takes the keyboard when it opens, and again when a menu that
  // covered it closes.
  useEffect(() => {
    if (chat != null && !menu) chatRef.current?.focus()
  }, [chat, menu])

  // The pause menu is a modal surface, so it takes focus when it opens: without
  // this the keyboard stayed on the canvas and the menu could only be worked
  // with the mouse.
  useEffect(() => {
    if (menu) menuRef.current?.focus()
  }, [menu])

  // A dialog is open over the paused mission: keep the keyboard away from the
  // engine without taking it away from the dialog. The engine listens on
  // window in the BUBBLE phase, which is the last hop of every real key event,
  // so stopping at document-bubble fences the jet while Escape (Radix listens
  // at document-capture), the tab strip's arrow keys and the sliders all still
  // see their event. Stopping at window-capture instead, as this first did,
  // fenced the dialog too. The pad path replays its binds by dispatching
  // straight AT window (engine.ts), which never travels through document —
  // that one needs the window listener, and only for events window itself is
  // the target of.
  useEffect(() => {
    if (!settings) return
    const fence = (e: KeyboardEvent) => e.stopPropagation()
    const padFence = (e: KeyboardEvent) => {
      if (e.target === window) e.stopPropagation()
    }
    document.addEventListener('keydown', fence)
    document.addEventListener('keyup', fence)
    window.addEventListener('keydown', padFence, { capture: true })
    window.addEventListener('keyup', padFence, { capture: true })
    return () => {
      document.removeEventListener('keydown', fence)
      document.removeEventListener('keyup', fence)
      window.removeEventListener('keydown', padFence, { capture: true })
      window.removeEventListener('keyup', padFence, { capture: true })
    }
  }, [settings])

  const send = () => {
    const words = chatRef.current?.value.trim()
    if (words && chat != null) {
      const carried = wire(chat)
      if (carried) handleRef.current?.chat(words, carried)
      else handleRef.current?.say(words)
    }
    dismiss()
  }

  return (
    <div className='air-game'>
      <canvas id='stage' ref={stageRef} tabIndex={0} />
      <canvas id='hud' ref={hudRef} />
      <canvas id='map' ref={mapRef} />
      <div className='panel' id='framerate' ref={framerateRef} />
      {chat != null && (
        <div className='fixed top-56 left-10 z-30 flex items-center rounded border border-white/30 bg-black/70 font-mono'>
          <span className='border-r border-white/20 px-2 py-1 text-xs text-amber-200'>
            {chat === 'team' ? (
              <Trans>Team</Trans>
            ) : chat === 'match' ? (
              <Trans>Match</Trans>
            ) : (
              <Trans>Everyone</Trans>
            )}
          </span>
          <input
            ref={chatRef}
            maxLength={200}
            placeholder={
              chat === 'team'
                ? t`Message your team`
                : chat === 'match'
                  ? t`Message the match`
                  : t`Message everyone on the server`
            }
            className='w-96 bg-transparent px-2 py-1 text-sm text-white outline-none placeholder:text-white/40'
            onKeyDown={(e) => {
              e.stopPropagation()
              const chord = (e.shiftKey ? 'Shift+' : '') + e.code // the engine's own chord, so a remapped chat key still steers the prompt
              if (
                handleRef.current &&
                (chord === handleRef.current.key('chat') ||
                  chord === handleRef.current.key('shout'))
              ) {
                e.preventDefault() // the key steers the scope, it types nothing
                setChat(
                  advance(
                    chat,
                    handleRef.current.scope() === 'team',
                    chord === handleRef.current.key('shout')
                  )
                )
                return
              }
              if (e.key === 'Enter') send() // words or none, the prompt closes
              if (e.key === 'Escape') setMenu(true) // the menu over the prompt, set not toggled, as losing fullscreen opens it
            }}
          />
          <button
            type='button'
            aria-label={t`Close`}
            className='px-2 py-1 text-white/70 hover:text-white'
            onClick={dismiss}
          >
            <X className='size-4' />
          </button>
        </div>
      )}
      {menu && (
        <div className='fixed inset-0 z-40 flex items-center justify-center bg-black/40'>
          {/* Same visual language as the front page: card surface, solid primary,
              outline secondaries, leading icons. */}
          <div
            ref={menuRef}
            tabIndex={-1}
            role='dialog'
            aria-modal='true'
            aria-label={over ? t`Mission over` : t`Paused`}
            // Tab is bound to weapon select, Space to the trigger: tabbing
            // through this menu fired the jet in a match that flies on behind
            // it. Every key but Escape stops here, and Escape is the one the
            // engine needs — it is what closes this menu.
            //
            // KEYUP is deliberately NOT stopped. The engine holds a set of
            // pressed keys and clears each one on its keyup; a key held when
            // the menu opened releases into this menu, so swallowing that
            // keyup left the engine believing it was still down and resumed
            // flight with a stuck control. Nothing is lost by letting it
            // through: the keydown never reached the engine, so there is
            // nothing there to delete.
            onKeyDown={(e) => {
              if (e.key === 'Escape') return
              if (e.key === 'Tab') {
                e.preventDefault()
                const stops = Array.from(
                  menuRef.current?.querySelectorAll<HTMLElement>(
                    'button:not([disabled])'
                  ) ?? []
                )
                if (stops.length) {
                  // Focus sits on the container itself until the first Tab, and
                  // indexOf returns -1 for it: forward starts at the first
                  // button, back at the LAST one, which the plain modulo turned
                  // into the second to last.
                  const at = stops.indexOf(
                    document.activeElement as HTMLElement
                  )
                  const next =
                    at < 0
                      ? e.shiftKey
                        ? stops.length - 1
                        : 0
                      : (at + (e.shiftKey ? -1 : 1) + stops.length) %
                        stops.length
                  stops[next].focus()
                }
              }
              e.stopPropagation()
            }}
            className='bg-background flex w-72 flex-col gap-2 rounded-lg border p-4 shadow-lg outline-none'
          >
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
                      <Plural
                        value={over.struck}
                        one='# round taken'
                        other='# rounds taken'
                      />
                      {' · '}
                    </>
                  )}
                  {Math.floor(over.seconds / 60)}:
                  {String(Math.floor(over.seconds % 60)).padStart(2, '0')}
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
                  setChat((handleRef.current?.scope() ?? 'match') as Scope)
                }}
              >
                <Send className='size-4' />
                <Trans>Send chat</Trans>
              </Button>
            )}
            <Button
              type='button'
              variant='outline'
              className='h-12 justify-start text-base'
              onClick={() => setSettings(true)}
            >
              {/* Tuning over the PAUSED, visible scene is the best place to do
                  it — the graphics knobs apply against the frame you are
                  looking at. The dialog fences input while open so a rebind
                  cannot reach the jet (in a match it keeps flying). */}
              <SettingsIcon className='size-4' />
              <Trans>Settings</Trans>
            </Button>
            <Button
              type='button'
              variant='outline'
              className='h-12 justify-start text-base'
              onClick={() => {
                // No confirmation: exiting SAVES the flight to the log, so there
                // is nothing to lose.
                setMenu(false)
                handleRef.current?.exit()
              }}
            >
              <LogOut className='size-4' />
              {/* A MISSION is yours to leave; a MATCH continues without you. */}
              {join ? (
                <Trans>Exit match</Trans>
              ) : replay ? (
                <Trans>Exit replay</Trans>
              ) : (
                <Trans>Exit mission</Trans>
              )}
            </Button>
          </div>
        </div>
      )}
      {settings && (
        <SettingsDialog
          open={settings}
          onClose={() => {
            setSettings(false)
            // Apply graphics changes to the frozen frame behind the menu.
            // resume() ends by focusing the canvas, which would hand the
            // keyboard to the jet while the pause menu is still the thing on
            // screen — take it straight back.
            handleRef.current?.resume(configRef.current)
            requestAnimationFrame(() => menuRef.current?.focus())
          }}
          config={configRef.current!}
          onChange={onConfigChangeRef.current!}
          tab={settingsTab}
          onTabChange={setSettingsTab}
        />
      )}
      <div className='panel' id='help' ref={helpRef}>
        {/* Key legends are <kbd>; the action beside each is prose and stays wrapped. The two <b> below
            are emphasis on translated text, not keys. Legends derive from the binding table - hand-written ones went stale. */}
        {HINTS.map(({ actions, label }, index) => (
          <span key={index}>
            {index > 0 && ' · '}
            <kbd>
              {actions.map((action) => pretty(binding(action))).join('/')}
            </kbd>{' '}
            {label}
          </span>
        ))}
        {' · '}
        <Trans>
          <kbd>1</kbd>–<kbd>5</kbd> for the view
        </Trans>
        <br />
        <b>
          <Trans>Chase view:</Trans>
        </b>{' '}
        <Trans>
          <b>Drag</b> or <kbd>←→</kbd> to orbit
        </Trans>
        {' · '}
        <Trans>
          <kbd>↑↓</kbd> to tilt
        </Trans>
        {' · '}
        <Trans>
          <kbd>−</kbd> to pull back
        </Trans>
        {' · '}
        <Trans>
          <kbd>=</kbd> to move closer
        </Trans>
      </div>
    </div>
  )
}
