// @ts-nocheck
// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
//
// Air game engine: the Three.js render loop, flight model and 2D-canvas HUD,
// extracted verbatim from the prototype. Imperative and self-contained; mounted by
// the React <GameCanvas> via startGame(). The mission-setup menu lives in React.
import { bench_register } from './bench'   // FIRST: the #148 sampler must survive an engine-init failure
import { atc_step } from './atc'
import * as THREE from 'three'
import {
  connect as net_dial,
  record as net_record,
  recording_store,
  type Join as NetJoin,
} from './net'
import { flight_load, flight_ready, flight_failure, flight_init, flight_set, flight_get, flight_frame, flight_mark, flight_ack, flight_level, flight_approach, flight_stores, flight_clear, flight_version, steps as flight_steps, STATE, battle_hulk, battle_volley, battle_fly, battle_blast, battle_progress, BATTLE, bandit_init, bandit_spawn, bandit_mirror, bandit_menace, bandit_step, bandit_mode } from './flight'
import { normalize as stores_normalize, migrate as stores_migrate, strip as stores_strip, rounds as stores_rounds, entries as stores_entries, mask as stores_mask, weight as stores_weight, missiles_loaded, resolve as stores_resolve, PRESETS as stores_presets, TIPS as stores_tips, ANCHORS as stores_anchors, jettison as stores_jettison, LIMITS as stores_limits, RELEASE as stores_release } from './stores'
import { split as model_split, repack as model_repack, textures as model_captures, POSE as model_pose, GEAR as model_gear } from './model'
import { flight_catalog } from './flight'
import { diagnose } from '../lib/graphics'
// #57 parked: import { start as head_start, shape as head_shape, Euro as HeadEuro } from './head'
import { shellStorage } from '@mochi/web'
import { deviceDefaults } from '../lib/config'
import { audio_gesture, audio_enable, audio_volumes, audio_frame, audio_gun, audio_hit, audio_explosion, audio_launch, audio_flare, audio_catapult, audio_trap, audio_touchdown, audio_servo, audio_eject, audio_caution, audio_warning, audio_horn, audio_seeker, audio_departure, audio_law, audio_remote, audio_remote_drop, audio_listener } from './audio'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
// Model binaries ride the bundle as content-hashed assets (assets/nimitz-<hash>.glb):
// the URL changes exactly when the bytes do, so the stale-programmatic-fetch trap
// (90 minutes of phantom debugging, 2026-07-07) is impossible by construction —
// no manual version constants to bump on regen. The dev readout shows the hash.
import nimitz_model_url from '../assets/nimitz.glb?url'
import fa18c_model_url from '../assets/fa18c.glb?url'
import stores_model_url from '../assets/stores.glb?url'
import { asset as asset_bytes, progress as load_progress } from './preload'
import { Recorder } from './acmi'

export type GameConfig = Record<string, unknown>

export interface GameHandle {
  stop: () => void
  resume: (config?: GameConfig) => void
  exit: () => void                              // the old Esc: suspend to the mission menu (leaves the match in multiplayer)
  recording: () => { text: string; session: string; kind: string } | null   // the buffered flight recording, rendered as ACMI (#212)
  pause: (on: boolean) => void                  // the menu popup's single-player freeze (#84)
  chat: (text: string, scope: string) => void   // send one match-chat line (#84)
  scope: () => string                           // the default chat scope: "team" in a teams match, else "all"
}

// The buffered flight, reachable WITHOUT a game handle: the History page is its
// own route and cannot see the index route's handle. startGame publishes its
// accessor here rather than the recorder being lifted out of the closure it
// shares with the whole engine.
let live_recording: () => { text: string; session: string; kind: string } | null = () => null
export function recording() { return live_recording() }

export function startGame({
  stage,
  hud,
  map,
  help,
  framerate,
  config = {},
  join = null,
  onExit,
  onMenu,
  onChat,
  onConfig,
  onOver,
  translate = (s) => s,
}: {
  stage: HTMLCanvasElement
  hud: HTMLCanvasElement
  map: HTMLCanvasElement
  help: HTMLElement
  framerate?: HTMLElement
  config?: GameConfig
  join?: NetJoin | null
  onExit?: () => void
  onConfig?: (partial: Record<string, number>) => void // engine-side setting changes (per-view zoom) flow back for persistence
  onOver?: (result: { fate: string; struck: number; seconds: number }) => void // the SP mission ended at a crash (#240): how, how wounded, how long
  onMenu?: () => void
  onChat?: (scope: string) => void
  translate?: (text: string) => string
}): GameHandle {
  const __ac = new AbortController()
  const signal = __ac.signal
  let __raf = 0

// ============================================================================ config
const cfg = { record:true, render_scale:1.0, dyn_res:true, ocean_segments:256, exterior_detail:3, lod:true,   // dyn_res defaults ON (#148): slow machines self-tune render_scale down to 0.45 instead of stuttering
	tracers:true, effects_quality:2, stores:stores_migrate(true), flares:true, shadows:false, clouds:"none", afterburner:true,   // effects_quality 0..3 scales expensive translucent work; stores (#17): the per-station loadout
	view:"hud", invert:false, framerate:false, sens:1.0,
	task:"joust", start:"carrier", tod:"day", help:false };
// The ship: everything that describes the carrier itself, per model —
// shuttle (nose-gear) points, arrestor wires, the landing centreline, the
// OLS bracket, and the deck outline for the flight core. Measured per deck
// with the align tool and the GLB measurement scripts; a second carrier is
// one more entry (#100). CARRIER {x,z} is world PLACEMENT, not ship data.
// stamp: the content hash from an imported asset URL (assets/nimitz-<hash>.glb),
// for the dev readout — the capture-verification workflow reads it off the HUD.
function model_stamp(url){ const m=/-([\w-]+)\.\w+$/.exec(url); return m?m[1]:url; }
const CARRIER_MODELS={
	nimitz:{ url:nimitz_model_url, length:333, yaw:20, bow:0, draft:0.375, deck:19,   // real USS Nimitz length. yaw:20 faces the bow to 070° (into the Midway wind) — the model's bow is +X (the retired Ford's was +Z, hence its yaw:110); both reach the same 070° recovery course. bow = the bow's bearing in the MODEL frame (0 = +X, 90 = +Z): the deck-ops frame is (yaw - bow), so carrier-local fore-aft tracks the drawn bow whatever the modeller's axes
		stroke:85, speed:88,                             // catapult throw and end speed, m / m/s
		// Wires + landing line: measured off the 1:200 CVN-68 deck plan (2026-07-06) — anchored on the deck
		// plateau extent (model fa -166.5..+164.9), hull centreline at lat +1.3; strip axis came out 9.5° port
		// of the bow (real angled deck: 9.05°), wire spacing 11.7 m (real: 40 ft). Catapults: measured off the
		// MODEL's track troughs/JBDs via a painter-ordered deck raster + Hough fit (waist headings +9.2°/+8.8°
		// bracket the real 9.05° angle). OLS AND THE DECK OUTLINE ARE STILL FORD PLACEHOLDERS.
		shuttles:[ {x:48.98, z:15.50, h:3.30},            // 1: starboard bow — x toward bow, z + starboard, heading deg (+ = port). PLAN-derived (Stage C, 1:200 GA drawing 2026-07-10): the plan's cat-1 track line starts at fa 45 (a slot's aft end, right behind this spot) and runs to the bow water-brake slot centre at 0.95 ridge coverage. The MODEL's painted track (z 19.41, h 5.67 — the 2026-07-07 exact fit) sits 3.9 m starboard with +2.4° excess heading and lies on no plan feature at all (0.22 coverage); the baked deck track moved with this constant, so jet, shuttle, and paint stay coherent
		           {x:47.23, z:-3.44, h:0},              // 2: port bow (the carrier-start spawn) — user-located in-game (2026-07-07), exact-fitted to the track's own triangles (heading -0.044° ≈ dead straight, line at lat -3.58 for this fa)
		           {x:-46.61, z:-17.08, h:4.03},          // 3: starboard waist — user-located in-game (2026-07-07), exact-fitted to the track's own triangles (heading +4.225°, line at lat -17.79 for this fa); the old Hough entry had fit the angled-deck trough 27 m away
		           {x:-66.50, z:-27.75, h:0} ],          // 4: port waist — heading stays the user's dead-straight in-game reading (2026-07-07); lat re-sourced from the 1:200 plan's track line (Stage C 2026-07-10: -27.75 at 0.99 ridge coverage over the unambiguous aft stretch; the model paint's -26.82 scores 0.15). Baked deck track moved with it
		wires:[-115.6,-103.9,-92.2,-80.5], halfspan:12.5,  // arrestor wires 1..4 (fore-aft) spanning ±halfspan about the landing line — the classic four-wire CVN-68 fit, 11.7 m apart, 1-wire 51 m from the stern round-down. halfspan 13 parks the sheaves just outside the 22 m strip; 16 reached the el-4 apron on the port side
		line:{ afa:-115.6, alat:1.92, bfa:-92.2, blat:-1.63 }, // the landing centreline = the MODEL's painted stripe (least-squares through its yellow centreline segments: lat = -16.27 - 0.1583·fa, 8.99° — the real angled deck is 9.05°). The plan-derived line sat 2.1-2.4 m port of the painted stripe, which made the wires' starboard sheaves look further out; the 1:200 plan says the sheaves are symmetric (~15.5 m each side), so the wires centre on the stripe
		ident:"NIM",                                      // the ship's TACAN ident, shown beside the HUD's slant range
		ols:{ fa:-21.0, lat:-37.06, model:true },         // OLS bracket on the port side — measured off the model's own IFLOLS: amber lens column (heights -0.5..+2.1 rel deck), green datum arms at +0.66 spanning 8.5 m, red wave-off columns at ±1.5 m. model:true = the GLB carries the physical structure, so the engine draws only the glowing lights
		outline:[ [-167.0,8.11],[-164.0,16.72],[-161.0,23.5],[-158.0,24.35],[-155.0,23.36],[-152.0,24.56],[-149.0,25.74],[-146.0,26.68],[-143.0,27.34],[-140.0,28.56],[-137.0,28.88],[-134.0,29.37],[-131.0,29.85],[-128.0,30.25],[-125.0,30.36],[-122.0,30.46],[-119.0,31.88],[-116.0,33.41],[-113.0,34.89],[-110.0,35.02],[-107.0,35.11],[-104.0,35.19],[-101.0,35.28],[-98.0,35.36],[-95.0,35.44],[-92.0,35.52],[-89.0,35.6],[-86.0,36.4],[-83.0,37.35],[-80.0,38.27],[-77.0,38.45],[-74.0,38.45],[-71.0,38.27],[-68.0,38.08],[-65.0,34.5],[-62.0,31.1],[-59.0,27.37],[-56.0,27.03],[-53.0,26.7],[-50.0,26.7],[-47.0,26.7],[-44.0,30.62],[-41.0,34.53],[-38.0,38.27],[-35.0,37.35],[-32.0,36.43],[-29.0,35.69],[-26.0,35.69],[-23.0,35.69],[-20.0,35.69],[-17.0,35.69],[-14.0,35.69],[-11.0,35.69],[-8.0,36.43],[-5.0,37.16],[-2.0,37.9],[1.0,37.9],[4.0,37.9],[7.0,37.9],[10.0,37.9],[13.0,37.16],[16.0,36.43],[19.0,35.69],[22.0,35.69],[25.0,35.69],[28.0,35.69],[31.0,35.69],[34.0,35.69],[37.0,35.69],[40.0,36.43],[43.0,37.16],[46.0,37.9],[49.0,37.9],[52.0,37.9],[55.0,37.9],[58.0,37.9],[61.0,37.9],[64.0,37.85],[67.0,37.33],[70.0,36.04],[73.0,33.99],[76.0,31.65],[79.0,29.27],[82.0,26.93],[85.0,24.55],[88.0,22.43],[91.0,21.04],[94.0,20.41],[97.0,19.46],[100.0,18.47],[103.0,17.44],[106.0,17.22],[109.0,17.0],[112.0,16.76],[115.0,16.52],[118.0,16.32],[121.0,16.13],[124.0,15.95],[127.0,15.68],[130.0,15.43],[133.0,15.17],[136.0,15.0],[139.0,14.78],[142.0,14.61],[145.0,14.38],[148.0,14.16],[151.0,13.99],[154.0,13.74],[157.0,13.54],[160.0,13.23],[163.0,13.02],[164.0,12.84],[165.0,12.77],[165.0,-10.34],[164.0,-10.51],[163.0,-10.76],[160.0,-10.9],[157.0,-11.1],[154.0,-11.29],[151.0,-11.44],[148.0,-11.61],[145.0,-11.78],[142.0,-12.1],[139.0,-12.33],[136.0,-12.62],[133.0,-12.76],[130.0,-12.93],[127.0,-13.03],[124.0,-13.31],[121.0,-13.58],[118.0,-13.91],[115.0,-14.06],[112.0,-14.25],[109.0,-14.39],[106.0,-14.6],[103.0,-14.86],[100.0,-15.13],[97.0,-15.37],[94.0,-15.53],[91.0,-15.77],[88.0,-16.75],[85.0,-18.5],[82.0,-20.84],[79.0,-23.16],[76.0,-25.49],[73.0,-27.81],[70.0,-30.12],[67.0,-32.44],[64.0,-34.66],[61.0,-36.46],[58.0,-37.48],[55.0,-37.83],[52.0,-37.83],[49.0,-37.83],[46.0,-37.83],[43.0,-37.83],[40.0,-37.83],[37.0,-37.83],[34.0,-37.83],[31.0,-37.36],[28.0,-36.6],[25.0,-35.65],[22.0,-34.99],[19.0,-34.45],[16.0,-33.92],[13.0,-33.48],[10.0,-33.57],[7.0,-33.83],[4.0,-34.19],[1.0,-34.19],[-2.0,-34.32],[-5.0,-33.56],[-8.0,-33.56],[-11.0,-33.43],[-14.0,-34.2],[-17.0,-35.95],[-20.0,-35.45],[-23.0,-34.7],[-26.0,-33.0],[-29.0,-33.55],[-32.0,-34.35],[-35.0,-34.35],[-38.0,-34.35],[-41.0,-34.35],[-44.0,-34.67],[-47.0,-34.98],[-50.0,-35.3],[-53.0,-34.98],[-56.0,-34.66],[-59.0,-34.34],[-62.0,-34.34],[-65.0,-34.34],[-68.0,-35.16],[-71.0,-35.97],[-74.0,-36.79],[-77.0,-36.79],[-80.0,-36.79],[-83.0,-35.97],[-86.0,-35.16],[-89.0,-33.81],[-92.0,-33.29],[-95.0,-32.76],[-98.0,-32.76],[-101.0,-32.76],[-104.0,-32.76],[-107.0,-32.76],[-110.0,-32.76],[-113.0,-32.76],[-116.0,-32.81],[-119.0,-32.64],[-122.0,-28.11],[-125.0,-22.52],[-128.0,-17.05],[-131.0,-15.77],[-134.0,-15.39],[-137.0,-15.0],[-140.0,-14.69],[-143.0,-14.37],[-146.0,-14.06],[-149.0,-13.6],[-152.0,-13.18],[-155.0,-12.77],[-158.0,-12.42],[-161.0,-11.97],[-164.0,-9.43],[-167.0,-7.09] ] } }; // deck polygon TRACED FROM THE NIMITZ deck grid (84 pts, 1.5 m cells) — the Ford placeholder was narrower in places and the physics dropped jets through visually-solid deck near the edges
const SHIP=CARRIER_MODELS.nimitz;   // the active carrier (a picker arrives with the second ship)
function sanitize_cfg(){   // runs after every config merge (the server-backed store can hold stale eras too)
	delete cfg.cats; delete cfg.cat_dy;   // pre-#100 configs carried ship data; CARRIER_MODELS owns it now
	if(cfg.clouds!=="none"&&!["cumulus","high_stratus","mid_stratus","low_stratus"].includes(cfg.clouds)) cfg.clouds="cumulus";   // a saved cloud type that no longer exists falls back to the default. EVERY new preset must be listed here: an omission silently rewrites the mission to cumulus, which would have turned every Case II approach into a clear-sky one
	cfg.stores=stores_normalize(cfg.stores&&Object.keys(cfg.stores).length?cfg.stores:stores_migrate(cfg.missiles!==false));   // #17: legacy configs carry the retired missiles boolean — map it to its preset; any stores map is normalized so a stale shape cannot reach the loadout paths
	delete cfg.missiles; }
let dev_cursor=null;   // the measuring-cursor ring on deck (dev mode)
let dev_probe=null, dev_probe_text="", dev_probe_t=0;
let departure_drive=[0,0];   // the departure tone's last drive (#53): [yaw intensity 0..1, steady-alpha flag] — headless verification reads it from dev_probe
let fuel_dump=false; const secured=[false,false];   // #54: the DUMP switch and the per-engine fuel cutoffs (port, starboard) — toggles, cleared at every spawn   // &probe pixel raycast state
const dev_nudge={fa:0,lat:0,hd:0};   // dev measuring-cursor offset from the nose wheel (I/K fore-aft, J/L port-stbd, U/O heading while parked); the readout and Ctrl+C include it
function here_text(){   // dev: the deck point under the NOSE WHEEL (plus the nudge offset) in carrier-local coordinates — the same frame AND reference point as the shuttle table (a value can be compared with or pasted as a cat spot directly)
	const nose=(AIRCRAFT_MODELS[own_aircraft()]||AIRCRAFT_MODELS.fa18c).nose||5.3;
	const nx=ownship.pos.x+ownship.fwd.x*nose, nz=ownship.pos.z+ownship.fwd.z*nose;
	const fa=carrier_fore_aft(nx,nz)+dev_nudge.fa, lat=carrier_lateral(nx,nz)+dev_nudge.lat;
	const hd=Math.atan2(-(ownship.fwd.x*CARRIER_S+ownship.fwd.z*CARRIER_C), ownship.fwd.x*CARRIER_C-ownship.fwd.z*CARRIER_S)*180/Math.PI+dev_nudge.hd;   // heading in the deck frame (0 = down the bow, + = port), from the forward vector through the inverse frame
	return "fa="+fa.toFixed(2)+", lat="+lat.toFixed(2)+", heading="+hd.toFixed(1)+", y="+ownship.pos.y.toFixed(2)+" · nimitz "+model_stamp(nimitz_model_url);
}
function copy_here(){   // dev (Ctrl+C): the live position line to the clipboard
	const txt=here_text();
	const fallback=()=>{ try{ const ta=document.createElement("textarea"); ta.value=txt; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); }catch{ /* clipboard fallback best-effort */ } };
	try{ navigator.clipboard.writeText(txt).catch(fallback); }catch{ fallback(); }
}
Object.assign(cfg, config);   // mission-setup menu overrides defaults — the server-backed config store is the single source (the joust_cfg_v1 localStorage era silently no-opped in the sandboxed shell and shadowed the store outside it)
sanitize_cfg();
cfg.view="hud";   // start in HUD (view 2); 1-5 select views, V swaps cockpit/HUD

let running=false, has_enemy=true;
const MULTIPLAYER=!!join;            // in a live match the map/P must never freeze the world
let missiles_rule=!MULTIPLAYER;      // the match's missiles-allowed rule (#17): single-player has no rule (the loadout decides); multiplayer starts forbidden until the welcome's parameters arrive. The rule clamps the FLOWN loadout via loadout() — cfg.stores is never written back, so one guns-only match cannot disarm the persisted choice
if(MULTIPLAYER){ cfg.task="joust"; cfg.cheats={}; }   // multiplayer: air start, no local AI; the match rules from the welcome set the missiles rule and the match cheats (the menu's own cheats never leak into a match)
const cheat=(name)=>!!(cfg.cheats&&cfg.cheats[name]);   // mission cheats: invulnerable (humans only — the server enforces it in multiplayer), ammunition, fuel
const DEV_MODE=(new URLSearchParams(location.search).get("developer")||"").replace(/"/g,"")==="1";   // tolerant of BOTH ?developer=1 and the ?developer="1" the router writes when it round-trips the flag through a navigation (search values are JSON-encoded)   // &developer=1: landing/trap test autopilot (Shift+1..0), deck align (0), stab cycle (Shift+E), cloud A/B (Shift+X), position copy (Shift+P), and ALL query hooks (?fly/clouds/tod/harm/view/start/sweep/shot/cat/glassdebug) — outside developer mode none of the scaffolding parses (#105)
const GLASS_DEBUG=DEV_MODE&&new URLSearchParams(location.search).get("glassdebug")==="1";   // magenta outline of the HUD-glass clip quad
const PANEL_POINT=DEV_MODE&&new URLSearchParams(location.search).get("panelpoint")==="1";   // cockpit clicks that miss the DDIs report the panel point hit (group-frame y,z on the dev HUD + clipboard) — feeds &radalt=y,z calibration
const INDEXER_TEST=DEV_MODE?(new URLSearchParams(location.search).get("indexertest")||""):"";   // "1": force all three AoA lamps lit; "2": also depth-free draw-on-top — the render-vs-depth bisect
// Benchmark overrides (#148, developer mode only): &ssaa=1.0 / &msaa=0 / &dynres=0|1
// pin the startup-read quality knobs so a single build can A/B each one; &bench=S
// (below, with &benchto=) samples frame times and beacons the stats out.
const BENCH_PARAMS=DEV_MODE?new URLSearchParams(location.search):null;
const SSAA_OVERRIDE=BENCH_PARAMS?parseFloat(BENCH_PARAMS.get("ssaa")||""):NaN;
const MSAA_OFF=BENCH_PARAMS?.get("msaa")==="0";
const TEST_SCENARIOS=DEV_MODE;         // (DEV_MODE must be declared FIRST: initializing these from it a line early was a temporal-dead-zone crash at module load)
let cat_idx=(()=>{ const u=DEV_MODE?parseInt(new URLSearchParams(location.search).get("cat")||"",10):NaN; const c=u>=1&&u<=4?u:(cfg.cat>=1&&cfg.cat<=4?cfg.cat:2); return c-1; })();   // selected catapult (0-based): &cat=1..4 (developer mode) wins, else the menu's Catapult choice, else #2 port bow
let menu_hold=false, game_paused=false;   // menu_hold = the Esc popup freeze; the popup is the ONLY pause UI (the old P-pause banner/controls-window plumbing was dead code whose banner drew UNDER the popup)
let loading=false, loading_t0=0;
const load_marks={}; let load_pending=[];   // loading-screen profiling: per-gate ready times + what is still pending (drawn under LOADING)   // flight-start LOADING screen: the sim + render hold until assets_ready() (20 s cap so a failed load can't hang the game)
let joust_side=1;   // which end of the merge the player drew this round (+1 = start west heading east); coin-flipped per joust start
const sun_dir = new THREE.Vector3(0.45,0.42,-0.32).normalize();
const CARRIER={ x:-18500, z:7500, deckY:SHIP.deck };   // ~20 km WSW of Midway (leeward deep water); heading +X, bow at +x
const sky_horizon=new THREE.Color(0xbfd8e8), sky_zenith=new THREE.Color(0x2a5a8c), fog_colour=new THREE.Color(0xc4d6e2);
const col_sundisc=new THREE.Color(0xfff3da), col_deep=new THREE.Color(0x0a2a3a), col_shallow=new THREE.Color(0x1d6e86);

// ============================================================================ renderer/scene
const canvas = stage;
const graphics_verdict = diagnose();   // #55: null = real acceleration; the governor's machine verdict below only counts then (a software-rendered run says nothing about the GPU that never got to fight)
const renderer = new THREE.WebGLRenderer({ canvas, antialias:!MSAA_OFF, powerPreference:"high-performance" });
renderer.outputColorSpace=THREE.SRGBColorSpace; renderer.toneMapping=THREE.ACESFilmicToneMapping; renderer.toneMappingExposure=1.05;
renderer.shadowMap.type=THREE.PCFSoftShadowMap;
const scene = new THREE.Scene(); scene.fog=new THREE.FogExp2(fog_colour,0.000042);
const camera = new THREE.PerspectiveCamera(45,1,3.0,130000);   // 45° ≈ HUD-like 1:1 so a 3° glideslope reads right (was 62°, too wide → approaches felt low). far REACHES PAST THE OCEAN RIM (120 km): at 42 km the far plane clipped the sea mid-disc, and from altitude the clip circle cut a razor-straight line across every cloud gap — sea below it, sky-dome haze above (the water shader fades the rim at 70-112 km and always expected the whole disc to render). Near-field depth precision is ~d²/(near·2²⁴), essentially independent of far, so this costs nothing
// Cockpit view (#99) renders in TWO passes: the world with the main camera
// (near 3.0 — hopeless for a panel at 0.5 m), then depth cleared and the
// ownship alone with this near camera over the composited frame. The split
// is by THREE layer: LAYER_OWN carries every ownship object.
const LAYER_OWN=1;
const cockpit_cam = new THREE.PerspectiveCamera(45,1,0.05,60);
cockpit_cam.layers.set(LAYER_OWN);
function layer_own_group(g){ g.traverse(o=>o.layers.set(LAYER_OWN)); }   // layers are per-object, not hierarchical: run over the whole subtree, and re-run whenever children are added

const sun = new THREE.DirectionalLight(0xfff4e0,2.4); sun.position.copy(sun_dir).multiplyScalar(4000); sun.castShadow=true;
sun.shadow.mapSize.set(1024,1024); sun.shadow.camera.near=100; sun.shadow.camera.far=8000;
sun.shadow.camera.left=-800; sun.shadow.camera.right=800; sun.shadow.camera.top=800; sun.shadow.camera.bottom=-800;
scene.add(sun,sun.target); const hemi=new THREE.HemisphereLight(0xbcd6ec,0x35506a,0.9); const amb=new THREE.AmbientLight(0x405060,0.4); scene.add(hemi,amb);
sun.layers.enable(LAYER_OWN); hemi.layers.enable(LAYER_OWN); amb.layers.enable(LAYER_OWN);   // lights are layer-filtered: without these the cockpit pass renders black

// ============================================================================ sky + ocean (proven)
const sky_mat = new THREE.ShaderMaterial({ side:THREE.BackSide, depthWrite:false, fog:false,
	uniforms:{ u_sun:{value:sun_dir}, u_horizon:{value:sky_horizon}, u_zenith:{value:sky_zenith}, u_fog:{value:fog_colour}, u_dip:{value:0.0}, u_ovc:{value:0.0}, u_ovct:{value:1.02}, u_ovcw:{value:0.28}, u_sun_col:{value:col_sundisc} },
	vertexShader:`varying vec3 v_dir; void main(){ v_dir=normalize(position); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
	fragmentShader:`varying vec3 v_dir; uniform vec3 u_sun,u_horizon,u_zenith,u_fog,u_sun_col; uniform float u_dip,u_ovc,u_ovct,u_ovcw;
		void main(){ vec3 d=normalize(v_dir); float t=(d.y+u_dip)*1.2;
		vec3 col=t>=0.0?mix(u_horizon,u_zenith,pow(clamp(t,0.0,1.0),0.65))
		               :mix(u_horizon,u_fog*0.88,clamp(-t*6.0,0.0,1.0));   // #108: the gradient's bright peak sits at the VISIBLE HORIZON (u_dip = the altitude-dependent dip to the ocean rim), not at eye level — peaking at d.y=0 painted a bright crest ACROSS the sky at eye level from any altitude, framed darker above and below: the persistent band. Below the horizon the sky descends into a darkened haze belt. CHANGE IN LOCKSTEP with the cloud pass's skybg — the aerial-haze payout must match this dome exactly or a colour-seam band returns
		col=mix(col, vec3(dot(col,vec3(0.333)))*u_ovct, u_ovc*(1.0-smoothstep(0.0,u_ovcw,abs(t))));   // CLOUD HORIZON BAND, preset-driven: overcast (strength 1, wide, deck-grey tone) — under an endless deck, rays passing beneath the slab forever showed blue between the deck's far edge and the sea; scattered cumulus (partial strength, narrow, bright haze tone) — the real field extends far beyond the 90 km march and its stacked distant clouds read as a hazy band riding the sea line. Horizon-weighted so sky overhead stays blue. LOCKSTEP with the cloud skybg
		float s=max(dot(d,normalize(u_sun)),0.0); col+=u_sun_col*pow(s,220.0)*1.4; col+=u_sun_col*pow(s,8.0)*0.18; gl_FragColor=vec4(col,1.0); }` });
const sky = new THREE.Mesh(new THREE.SphereGeometry(30000,32,16),sky_mat); sky.frustumCulled=false; scene.add(sky);

// stars (night only)
const star_geo=new THREE.BufferGeometry();
{ const N=1400, pos=new Float32Array(N*3); for(let i=0;i<N;i++){ const u=Math.random(), th=Math.random()*Math.PI*2, r=16000, el=u*u*1.0, sq=Math.sqrt(1-el*el);
	pos[i*3]=r*sq*Math.cos(th); pos[i*3+1]=200+r*el; pos[i*3+2]=r*sq*Math.sin(th); } star_geo.setAttribute("position",new THREE.BufferAttribute(pos,3)); }
const stars=new THREE.Points(star_geo,new THREE.PointsMaterial({color:0xffffff,size:16,sizeAttenuation:true,transparent:true,opacity:0,depthWrite:false,fog:false}));
stars.frustumCulled=false; scene.add(stars);

// time-of-day presets + apply
const TOD={
	day:  { sun:[0,0.866,0.5], sunCol:0xfff4e0, sunI:2.4,  disc:0xfff3da, hor:0xbfd8e8, zen:0x2a5a8c, fog:0xc4d6e2, deep:0x0a2a3a, shal:0x1d6e86, hs:0xbcd6ec, hg:0x35506a, hi:0.9,  ac:0x405060, ai:0.4,  exp:1.05, stars:0.0,  water:[1.0,1.0,1.0], deep2:0x11424e, glint:60.0, rough:0.11, sss:0x16483f },   // sun due south at 60° — high and exactly abeam an east-west joust merge, so neither pilot starts up-sun (fair by mirror symmetry; realistic for 28°N)
	night:{ sun:[0,0.866,0.5], sunCol:0x9fb6e0, sunI:0.32, disc:0xcdd8f0, hor:0x0f1626, zen:0x05080f, fog:0x0a111c, deep:0x030810, shal:0x0a2030, hs:0x1a2742, hg:0x05060a, hi:0.32, ac:0x0a0e18, ai:0.22, exp:1.18, stars:0.95, water:[0.30,0.36,0.50], deep2:0x05101a, glint:14.0, rough:0.07, sss:0x03100d },   // the moon takes the same slot at night — same fairness geometry, and no low glitter path on the sea
};
function apply_time_of_day(t){ const p=TOD[t]||TOD.day;
	sun_dir.set(p.sun[0],p.sun[1],p.sun[2]).normalize(); sun.position.copy(sun_dir).multiplyScalar(4000); sun.target.position.set(0,0,0);
	sun.color.setHex(p.sunCol); sun.intensity=p.sunI;
	col_sundisc.setHex(p.disc); sky_horizon.setHex(p.hor); sky_zenith.setHex(p.zen); col_deep.setHex(p.deep); col_shallow.setHex(p.shal);
	scene.fog.color.setHex(p.fog); fog_colour.setHex(p.fog);
	hemi.color.setHex(p.hs); hemi.groundColor.setHex(p.hg); hemi.intensity=p.hi; amb.color.setHex(p.ac); amb.intensity=p.ai;
	renderer.toneMappingExposure=p.exp; cloud_mat.uniforms.uExposure.value=p.exp; cloud_mat.uniforms.uSunGain.value=p.sunI/TOD.day.sunI; stars.material.opacity=p.stars;   // the cloud composite uses the same exposure as the scene
	if(p.water) ocean_mat.uniforms.u_water_tint.value.setRGB(p.water[0],p.water[1],p.water[2]);   // darken the reef/lagoon colour map at night
	if(p.deep2!==undefined) ocean_mat.uniforms.u_deep2.value.setHex(p.deep2);
	ocean_mat.uniforms.u_seafog.value.setHex(p.fog).lerp(new THREE.Color(p.deep), 0.42);   // the sea's distance colour: mildly darker than the sky so the horizon line reads, but light enough that the approach to it SILVERS the way grazing Fresnel really behaves — the defect to avoid is a stripe (brighter than the water beyond it), not brightness itself   // the sea's distance colour: a deep slate CONTINUING the rolled-off mid-band's darkness — a merely-dimmed pale grey sits BRIGHTER than the mid band and reads as a white stripe before the horizon
	if(p.glint!==undefined){ ocean_mat.uniforms.u_glint.value=p.glint; ocean_mat.uniforms.u_rough.value=p.rough; }
	if(p.sss!==undefined) ocean_mat.uniforms.u_sss.value.setHex(p.sss);
}

// Tileable water detail texture, generated at init (no asset): RG = surface-normal
// slope of a periodic multi-wave heightfield (the per-pixel ripple detail at three
// scrolled scales), B = mid-scale noise (whitecap mask), A = independent low-noise
// (deep-water colour patchiness). Periodic by construction: integer wavenumbers only.
function build_water_detail(){
	const S=512, data=new Uint8Array(S*S*4);
	let seed=0x1234567;
	const rnd=()=>{ seed=(seed*1103515245+12345)&0x7fffffff; return seed/0x7fffffff; };
	const mkwaves=(K,fmax,red)=>{ const w=[]; for(let i=0;i<K;i++){ let fx=0,fz=0;
		while(fx===0&&fz===0){ fx=Math.round((rnd()*2-1)*fmax); fz=Math.round((rnd()*2-1)*fmax); }
		w.push([fx,fz,rnd()*Math.PI*2,(0.6+0.7*rnd())/Math.pow(Math.hypot(fx,fz),red)]); } return w; };
	// A dense red spectrum: few modes = visible plane-wave plaid (the "chessboard sea").
	// Wide frequency band per tile: the repeat period in the world equals the sampling
	// scale, so richness INSIDE the tile is what separates feature size from repeat size.
	// Directional spectrum: real seas concentrate energy around the wind direction
	// (crests elongate cross-wind, break irregularly along it). An isotropic dense
	// field is a Gaussian noise — it reads as fingerprint swirls, not waves.
	const band=(K,flo,fhi,red,dir,spread)=>{ const w=[]; for(let i=0;i<K;i++){
		const f=flo*Math.pow(fhi/flo,rnd());
		const th=dir+(rnd()+rnd()+rnd()-1.5)*spread;   // triangular-ish spread about the wind
		const fx=Math.round(f*Math.cos(th)), fz=Math.round(f*Math.sin(th));
		if(fx===0&&fz===0){ i--; continue; }
		w.push([fx,fz,rnd()*Math.PI*2,(0.6+0.7*rnd())/Math.pow(Math.hypot(fx,fz),red)]); } return w; };
	const WIND=0.29;   // matches the primary vertex swell W0 (1,0.3)
	const H=band(170,3,40,1.15,WIND,0.9), B=band(26,6,24,1.0,WIND,1.4), A=mkwaves(8,3,1.0);
	const T=Math.PI*2/S;
	// Two passes: accumulate raw fields, then normalise each channel to its own
	// max so nothing clips (clipped slopes read as ±45° wavelets and the whole
	// sea turns into Fresnel mirror). Decoded range is ±1; the shader weights
	// bring typical slopes to realistic ~0.1-0.2.
	const raw=new Float32Array(S*S*4); const mx=[1e-6,1e-6,1e-6,1e-6];
	for(let y=0;y<S;y++) for(let x=0;x<S;x++){
		let gx=0,gz=0,b=0,a=0;
		for(const [fx,fz,ph,am] of H){ const c=Math.cos((x*fx+y*fz)*T+ph); gx+=am*fx*c; gz+=am*fz*c; }
		for(const [fx,fz,ph,am] of B) b+=am*Math.sin((x*fx+y*fz)*T+ph);
		for(const [fx,fz,ph,am] of A) a+=am*Math.sin((x*fx+y*fz)*T+ph);
		const o=(y*S+x)*4; raw[o]=gx; raw[o+1]=gz; raw[o+2]=b; raw[o+3]=a;
		for(let k=0;k<4;k++) mx[k]=Math.max(mx[k],Math.abs(raw[o+k]));
	}
	for(let i=0;i<S*S;i++) for(let k=0;k<4;k++)
		data[i*4+k]=Math.round(127.5+raw[i*4+k]/mx[k]*127.4);
	const tex=new THREE.DataTexture(data,S,S,THREE.RGBAFormat);
	tex.wrapS=tex.wrapT=THREE.RepeatWrapping; tex.magFilter=THREE.LinearFilter;
	tex.minFilter=THREE.LinearMipmapLinearFilter; tex.generateMipmaps=true; tex.needsUpdate=true;
	tex.anisotropy=renderer.capabilities.getMaxAnisotropy();   // default anisotropy (1) blurs the detail flat at oblique view angles — a silky "oily" band that no shader change can fix (same disease as the deck markings)
	return tex;
}
const col_deep2=new THREE.Color(0x11424e);
const ocean_mat = new THREE.ShaderMaterial({ fog:false, side:THREE.DoubleSide,
	uniforms:{ u_time:{value:0}, u_sun:{value:sun_dir}, u_deep:{value:col_deep}, u_deep2:{value:col_deep2}, u_shallow:{value:col_shallow}, u_sky:{value:sky_horizon}, u_fog_density:{value:0.000060},
		u_water:{value:null}, u_lagoon:{value:null}, u_water_half:{value:12000.0}, u_water_on:{value:0.0}, u_water_tint:{value:new THREE.Color(1,1,1)}, u_seafog:{value:new THREE.Color(0xa7bccc)},
		u_detail:{value:build_water_detail()}, u_wind:{value:0.75}, u_rough:{value:0.11}, u_glint:{value:60.0}, u_sss:{value:new THREE.Color(0x16483f)},   // wind 0..1 scales caps+roughness; glint is HDR, soft-kneed in-shader (custom shaders bypass the renderer's ACES pass)
		u_cloudnoise:{value:null}, u_cloud_on:{value:0.0}, u_cloud_cover:{value:0.42}, u_cloud_mid:{value:1500.0}, u_cloud_flat:{value:0.0} },   // the SAME 3D noise field the cloud raymarcher samples — shadows land under the rendered clouds
	vertexShader:`uniform float u_time,u_water_half,u_water_on; uniform sampler2D u_water,u_lagoon; varying vec3 v_world; varying vec3 v_normal; varying float v_height; varying float v_calm;
		const vec4 W0=vec4(-0.12,-0.99,420.0,60.0); const vec4 W1=vec4(0.85,0.55,233.0,44.0); const vec4 W2=vec4(0.95,-0.05,117.0,38.0); const vec4 W3=vec4(0.75,0.45,59.0,24.0);   // W0 is the long NW GROUND SWELL crossing the trades at ~115 degrees (Midway winter climatology: Aleutian-storm swell vs ENE trade wind-sea) — ONE crossing train of huge wavelength reads as a real crossing sea; W1-W3 stay clustered about the wind (a four-way cross-sea is physically absurd and its interference lattice is a moving quilt no texture fix can hide). Speeds (w.w = 2*pi*m/s): W0/W1 run at ~70% of GROUP velocity — full phase speed always reads too fast in a sum-of-sines sea (no group structure: every crest lives forever)
		float wave(vec2 p,vec4 w,float amp,out vec2 grad){ vec2 dir=normalize(w.xy); float k=6.2831853/w.z; float ph=dot(dir,p)*k-u_time*(w.w/w.z); grad=dir*(k*amp*cos(ph)); return amp*sin(ph); }   // sin(kx - wt) propagates ALONG dir (downwind): the old +wt sign sent every swell racing UPWIND — a 420 m wave sweeping against the wind at 14 m/s, under whitecap tails built to trail downwind-moving crests
		void main(){ vec4 wp=modelMatrix*vec4(position,1.0); vec2 xz=wp.xz; vec2 g,gt=vec2(0.0); float h=0.0;
		float calm=0.0; if(u_water_on>0.5){ vec2 wuv=clamp((xz+u_water_half)/(2.0*u_water_half),0.0,1.0); calm=texture2D(u_lagoon,wuv).r; }   // atoll interior (reef flat + lagoon incl. the deep basin) = calm
		v_calm=calm; float ws=mix(1.0,0.12,calm);   // damp wave amplitude inside the reef
		h+=wave(xz,W0,2.0,g);gt+=g; h+=wave(xz,W1,1.1,g);gt+=g;
		h+=wave(xz,W2,0.5,g); h+=wave(xz,W3,0.25,g);   // the short waves DISPLACE but do not shade: their slope interference is the moving quilt; the texture octaves own shading at those scales
		h*=ws; gt*=ws;
		wp.y+=h; v_height=h; v_normal=normalize(vec3(-gt.x,1.0,-gt.y)); v_world=wp.xyz; gl_Position=projectionMatrix*viewMatrix*wp; }`,
	fragmentShader:`uniform vec3 u_sun,u_deep,u_deep2,u_shallow,u_sky,u_water_tint,u_sss,u_seafog; uniform float u_fog_density,u_time,u_water_half,u_water_on,u_wind,u_rough,u_glint,u_cloud_on,u_cloud_cover,u_cloud_mid,u_cloud_flat; uniform sampler2D u_water,u_detail; uniform highp sampler3D u_cloudnoise; varying vec3 v_world; varying vec3 v_normal; varying float v_height; varying float v_calm;
		float hash2(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
		float swell(vec2 p){   // the two SHADING swells, analytically — lets foam ask "is the crest here / was it here just now" at any point. MUST mirror the vertex W0/W1 exactly: sin(kx - wt), W0 = the crossing NW ground swell, W1 = the longest wind-sea train
			float h=2.0*sin(dot(normalize(vec2(-0.12,-0.99)),p)*(6.2831853/420.0)-u_time*(60.0/420.0));
			h+=1.1*sin(dot(normalize(vec2(0.85,0.55)),p)*(6.2831853/233.0)-u_time*(44.0/233.0));
			return h; }
		vec2 hashcell(vec2 p){ return fract(sin(vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3))))*43758.5453); }
		// Stochastic tiling (Heitz/Deliot): static triangle lattice, per-cell hashed texture
		// offsets, variance-preserving blend. Kills tile repetition WITHOUT the beat envelope
		// dual incommensurate sampling creates (the "moving quilt"). Drift applies inside the
		// fetch: the lattice stays world-static (no cell popping), the water flows through it.
		vec2 hexslope(vec2 uv, vec2 drift){
			vec2 t=mat2(1.0,0.0,-0.57735027,1.15470054)*uv*3.464;
			vec2 i=floor(t), f=fract(t);
			float su=step(1.0,f.x+f.y);
			vec3 w=mix(vec3(1.0-f.x-f.y,f.x,f.y), vec3(f.x+f.y-1.0,1.0-f.y,1.0-f.x), su);
			vec2 a=texture2D(u_detail,uv+hashcell(i+su*vec2(1.0))+drift).rg-0.5;
			vec2 b=texture2D(u_detail,uv+hashcell(i+vec2(1.0,0.0))+drift).rg-0.5;
			vec2 c=texture2D(u_detail,uv+hashcell(i+vec2(0.0,1.0))+drift).rg-0.5;
			return (w.x*a+w.y*b+w.z*c)*inversesqrt(dot(w,w))*2.0;
		}
		float remap(float v,float a,float b,float c,float d){ return c+clamp((v-a)/(b-a),0.0,1.0)*(d-c); }
		vec3 sky_at(vec3 d){ d=normalize(d); float t=clamp(d.y*1.2,0.0,1.0); vec3 col=mix(u_sky, u_sky*0.55+vec3(0.04,0.10,0.22), pow(t,0.65));
			float s=max(dot(d,normalize(u_sun)),0.0); col+=vec3(1.0,0.96,0.85)*pow(s,14.0)*0.07; return col; }   // sun halo kept faint: reflected via Fresnel it paints a smooth statistics-free pseudo-glint over the Cox-Munk corridor — the oily sheen in the sun zone
		void main(){ vec3 V=normalize(cameraPosition-v_world); vec3 L=normalize(u_sun);
			vec2 xz=v_world.xz; float dist=length(cameraPosition-v_world);
			// --- multi-octave scrolling detail normals, distance-faded (the fine texture MSFS has at every altitude)
			float f2=exp(-dist/6500.0);   // the fine octave outlives the 1-5 km ring: grazing Fresnel is hypersensitive to the glass-smooth swell faces left when it fades (pale mirror stripes along every crest)
			vec2 xr3=vec2(0.940*xz.x-0.342*xz.y, 0.342*xz.x+0.940*xz.y);
			// ALL texture drift runs downwind at dispersion-scaled speeds; anti-repeat is
			// hex-tiling per octave (see hexslope) — dual incommensurate sampling created a
			// beat envelope that drifted with the water: the "moving quilt".
			vec2 s3=hexslope(xr3/2650.0, u_time*vec2(1.45e-4,4.3e-5));
			// The coarse octave is warped by the kilometre octave and rotated off-axis: an
			// unwarped tile repeats its exact pattern every 331 m, which reads as a quilt
			// from altitude no matter how irregular the pattern inside the tile is.
			vec2 warp=(texture2D(u_detail,xr3/6400.0).rg*2.0-1.0);   // very-low-frequency warp source: strong warp from a busy field marbles the sea into curlicues
			vec2 xr0=vec2(0.993*xz.x-0.122*xz.y, 0.122*xz.x+0.993*xz.y)+warp*45.0+s3*8.0;   // gentle meander only: hex-tiling owns anti-repetition now, and a strong warp draws visible mid-band swirl curls
			vec2 s0=hexslope(xr0/610.0, u_time*vec2(1.10e-3,3.3e-4));
			// Octaves rotate AND domain-warp on the coarse field: same-direction lattices at
			// every zoom read as a chessboard; warped, the crests meander like real seas.
			vec2 xr1=vec2(0.966*xz.x+0.259*xz.y, -0.259*xz.x+0.966*xz.y)+warp*34.0+s0*5.0;   // ±15°: rotations must preserve the wind axis or the trains cross
			vec2 s1=hexslope(xr1/90.0, u_time*vec2(1.17e-2,3.5e-3));
			float far=smoothstep(3000.0,14000.0,dist);
			vec2 slope=(s0*0.34 + s1*0.48*f2 + s3*0.28*far)*u_wind*(1.0-0.85*v_calm);   // near Cox-Munk slope variance for a working breeze: too little and the Fresnel sky reflection stays coherent — the oily gloss
			// Shading normal: the four fixed-direction vertex waves print a herringbone on the
			// distance band once the detail octaves mip away — real seas read isotropic out
			// there, so their slopes fade from SHADING with range (geometry keeps the swell).
			vec3 vn=normalize(mix(v_normal,vec3(0.0,1.0,0.0),far*0.7));
			vec3 N=normalize(vn+vec3(slope.x,0.0,slope.y));
			float fres=(0.02+0.80*pow(1.0-max(dot(N,V),0.0),5.0))*(1.0-0.58*far);   // grazing mirror reduced by wave shadowing but NOT killed: the sea silvers smoothly toward the horizon, it just must never form a stripe brighter than the water beyond it   // grazing reflectance capped AND rolled off at range: a rough sea's wave shadowing keeps the far band from mirroring the pale sky (Cox-Munk), so the horizon keeps its blue
			float diff=max(dot(N,L),0.0); vec3 body;
			if(u_water_on>0.5){ vec2 wuv=clamp((v_world.xz+u_water_half)/(2.0*u_water_half),0.0,1.0); body=texture2D(u_water,wuv).rgb*u_water_tint*(0.7+0.3*diff); }
			else { // deep-water patchiness: slow drift between two deep hues at ~1.5 km scale
				float swatch=texture2D(u_detail,xz/1470.0+u_time*vec2(1.3e-4,3.9e-5)).a;   // 'patch' is a GLSL ES 3.0 reserved word
				swatch=mix(swatch, texture2D(u_detail,vec2(xz.y,-xz.x)/5300.0).a, far*0.7);   // kilometre-scale colour variation survives the mip flattening at flight-level slants
				vec3 deep=mix(u_deep,u_deep2,smoothstep(0.35,0.65,swatch));
				body=mix(deep,u_shallow,diff*0.8+0.2); }
			float shallow=clamp((body.g-0.25)*2.2,0.0,1.0);   // turquoise/foam → damp the sky reflection so the colour shows
			vec3 refl=sky_at(reflect(-V,N));
			refl=mix(refl, vec3(dot(refl,vec3(0.333)))*0.90, u_cloud_flat*0.85);   // under an OVERCAST the sea reflects a grey ceiling, not the procedural blue sky — the water's blue cast was the residual "blue horizon" under the stratus
			// --- cloud shadows: one sample of the raymarcher's own base field at cloud-mid height along the sun ray
			float shade=1.0;
			if(u_cloud_on>0.5){
				vec3 cp=v_world+L*((u_cloud_mid-v_world.y)/max(L.y,0.2)); vec3 sp=cp+vec3(u_time*8.0,0.0,u_time*3.0);
				vec4 n=texture(u_cloudnoise,sp*1.6667e-4); float wf=n.g*0.625+n.b*0.25+n.a*0.125;
				float dcl=remap(remap(n.r,wf-1.0,1.0,0.0,1.0)*0.7, 1.0-u_cloud_cover, 1.0, 0.0, 1.0)*u_cloud_cover;
				shade=mix(1.0,exp(-dcl*4.0),0.5); }
			body*=shade;
			vec3 col=mix(body,refl*mix(shade,1.0,0.5),fres*mix(1.0,0.35,shallow));
			// --- Cox-Munk style glint: slope-space Beckmann, corridor stretched along the sun azimuth,
			// wind-roughened, calmed in the lagoon; granular sparkle emerges from the detail normals.
			vec3 H=normalize(L+V);
			vec2 hs=-H.xz/max(H.y,0.05);
			// Corridor envelope from the SMOOTH normal (vertex waves + a whisper of coarse detail):
			// the pool's shape stays coherent while the full detail normal supplies the granular
			// sparkle inside it — two scales, as on a real sea.
			vec3 Ne=v_normal;   // envelope from the swell alone: even a whisper of coarse detail in Ne paints the warp's filament structure across the pool as smooth white swirls — the residual oil
			vec2 es=-Ne.xz/max(Ne.y,0.2); vec2 dv=es-hs;
			vec2 az=normalize(L.xz+vec2(1e-4,0.0)); vec2 c=vec2(dot(dv,az),dot(dv,vec2(-az.y,az.x)));
			float ra=u_rough*(0.55+0.45*u_wind)*mix(1.0,0.4,v_calm);
			float rw=ra*2.4;   // the envelope carries the FULL Cox-Munk slope variance (detail included) — the sparkle only granulates inside it
			float env=exp(-(c.x*c.x/(rw*rw*3.6)+c.y*c.y/(rw*rw)));
			vec2 fs=-N.xz/max(N.y,0.2); vec2 dv2=fs-hs; float rs=ra*1.6;   // sparkle sigma must sit near the true facet-slope spread or it never fires
			float spark=exp(-dot(dv2,dv2)/(rs*rs));
			float g=env*(0.10+2.8*spark);   // sparkle-dominant: a strong smooth-envelope base paints an oily sheen no breeze-rippled sea has
			float fresH=0.02+0.98*pow(1.0-max(dot(H,V),0.0),5.0);
			vec3 glint=vec3(1.0,0.94,0.80)*g*fresH*u_glint*shade*shade;
			col+=glint/(1.0+0.22*glint);   // soft knee: HDR bloom saturation without the renderer's ACES (custom shaders bypass it)
			// --- subsurface transmission: light through the thin water near a crest reaches the
			// viewer when looking toward the sun's far side — the blue-green glow that makes
			// waves read as liquid up close (MSFS-style SSS, cheapened to one term).
			vec3 Lb=normalize(vec3(L.x,0.25,L.z));
			float trans=pow(max(dot(V,-Lb),0.0),3.0);
			float crest=clamp(v_height/3.0+0.12,0.0,1.2);   // low baseline: an unconditional floor paints a faint wash along the same near-grazing crest bands
			float thin=smoothstep(0.25,0.65,length(slope)*2.0)*0.55;   // gated on real steepness and dimmed: a broad smooth SSS wash reads as oil, not translucency
			col+=u_sss*(trans*crest*thin*(0.35+0.65*shade)*(1.0-0.7*v_calm))*exp(-dist/6000.0);
			// --- foam: crest foam on the big vertex waves + wind-scattered whitecaps from the cap-noise channel
			// Real whitecaps are commas: born as a crest line elongated CROSS-wind (the
			// breaking front), decaying into a dimmer foam streak stretched ALONG-wind
			// behind it. Head = along-wind-compressed field; tail = upwind-shifted,
			// along-wind-stretched field at half strength.
			vec2 aw=vec2(0.958,0.286);
			vec2 xzc=xz-u_time*aw*1.1;   // the cap pattern drifts downwind
			float alo=dot(xzc,aw), cro=dot(xzc,vec2(-aw.y,aw.x));
			vec2 hu=vec2(alo*2.2,cro), tu=vec2((alo-16.0)*0.45,cro*1.5);
			float capc=texture2D(u_detail,xz/1900.0+u_time*vec2(5.0e-4,1.5e-4)).b; // wind-streak clustering
			float hv=(0.45*texture2D(u_detail,hu/320.0).b+0.55*texture2D(u_detail,hu/700.0).b)*(0.6+0.4*capc);
			float tv=(0.45*texture2D(u_detail,tu/320.0).b+0.55*texture2D(u_detail,tu/700.0).b)*(0.6+0.4*capc);
			float head=smoothstep(0.575,0.615,hv), tail=smoothstep(0.565,0.615,tv);
			// Caps ride the big swell crests, and FOAM PERSISTS: heads gate on the crest
			// being here now; tails also pass if the crest is just DOWNWIND (it recently
			// swept this spot), so each break leaves a fading streak behind the wave for
			// seconds instead of flashing out with the crest. Stateless memory — the
			// swell is analytic, so "where was the crest" is a question, not a history.
			// (An instantaneous steepness gate is wrong: sines are steepest at ZERO
			// height, so ridge*steep only passed in narrow flickering windows.)
			float ridge=smoothstep(0.55,1.8,swell(xzc));
			float ridge1=smoothstep(0.55,1.8,swell(xzc+aw*24.0));
			float ridge2=smoothstep(0.55,1.8,swell(xzc+aw*52.0));
			float lee=0.7+0.3*smoothstep(0.0,0.10,dot(slope,aw));
			float carry=max(ridge, max(ridge1*0.65, ridge2*0.35));
			float caps=max(head*(0.10+0.90*ridge*lee), 0.5*tail*(0.10+0.90*carry*lee))*smoothstep(0.3,0.8,u_wind)*(1.0-v_calm)*exp(-dist/6000.0);   // measured: ~1.1% coverage, ~0.4% solid white — fewer, larger; tapered by ~6 km (mip flattening finishes the job further out)
			float foam=smoothstep(1.5,2.6,v_height)*(0.55+0.45*hash2(floor(xz*0.6))); foam*=smoothstep(0.15,0.55,1.0-N.y);
			foam=max(foam,caps*0.9);
			col=mix(col,vec3(0.92,0.96,1.0)*shade,clamp(foam,0.0,0.85));
			float fog=1.0-exp(-u_fog_density*u_fog_density*dist*dist);
			fog=max(fog, smoothstep(70000.0,112000.0,dist));   // absolute saturation before the disc rim — a safety net; the density fog completes far earlier
			vec3 seafog=mix(u_seafog, vec3(dot(u_seafog,vec3(0.333)))*0.74, u_cloud_flat);   // under an OVERCAST the far sea silvers toward the deck's grey, not toward a sunny sky's pale blue — the bright rim read as blue sky under the stratus
			float toDome=smoothstep(600.0,3200.0,cameraPosition.y);   // the deliberate darker-than-sky horizon line is a SEA-LEVEL design: from altitude the fogged sea against the paler dome widens into a hard stripe across the view (the user's line, 2026-08-10), so the far sea converges to the dome colour as the camera climbs and the rim melts into the sky
			col=mix(col,mix(seafog,u_sky,toDome*0.9),clamp(fog,0.0,1.0));   // the sea fogs to a slightly DEEPER colour than the sky: the real horizon is a visibly darker line, not a white merge
			gl_FragColor=vec4(col,1.0); }` });
let ocean=null;
function build_ocean(seg){ if(ocean){scene.remove(ocean);ocean.geometry.dispose();}
	// Camera-centred polar disc, not a square: a 20 km square rim sits at ~2° depression
	// and its projected edge curves like low-earth orbit; a 120 km disc puts the apparent
	// horizon where fog completes (~40 km, ~0.5-1° depression) — straight and constant
	// in every direction. Quadratic ring spacing keeps the vertex budget near the camera.
	const rings=seg, sectors=Math.max(64,seg), R=120000;
	const pos=new Float32Array((rings*sectors+1)*3);
	let vi=1;
	for(let i=1;i<=rings;i++){ const r=R*Math.pow(i/rings,2.0);
		for(let j=0;j<sectors;j++){ const a=j/sectors*Math.PI*2;
			pos[vi*3]=Math.cos(a)*r; pos[vi*3+1]=0; pos[vi*3+2]=Math.sin(a)*r; vi++; } }
	const idx=[];
	for(let j=0;j<sectors;j++) idx.push(0, 1+(j+1)%sectors, 1+j);
	for(let i=0;i<rings-1;i++){ const a0=1+i*sectors, b0=1+(i+1)*sectors;
		for(let j=0;j<sectors;j++){ const j2=(j+1)%sectors;
			idx.push(a0+j, b0+j2, b0+j); idx.push(a0+j, a0+j2, b0+j2); } }
	const geo=new THREE.BufferGeometry();
	geo.setAttribute("position", new THREE.BufferAttribute(pos,3)); geo.setIndex(idx);
	ocean=new THREE.Mesh(geo,ocean_mat); ocean.receiveShadow=true; ocean.frustumCulled=false; scene.add(ocean); }
build_ocean(cfg.ocean_segments);

// cloud layer types (rendered by the raymarch pass below)
const CLOUDS={   // cover: higher = more cloud (coverage remap). Trade-wind cumulus: low bases (~2,000 ft), most tops at the inversion, a few towers.
	cumulus:      { base:600,  top:2400, high:5000,  cover:0.42, density:1.0, flat:0.0, gate:[0.22,0.50], dark:0.45 },   // fair-weather broken trade-wind sky (user-preferred). (A cumulonimbus preset lived here 2026-07-05/06 and was removed entirely — recover from git if ever revisited)
	high_stratus: { base:1829, top:2134, high:2134, cover:0.78, density:1.0, flat:1.0, gate:[0.0,0.0], dark:0.3 },   // altostratus deck 6,000-7,000 ft: dogfights descend through it and LOSE each other inside (dense enough to white-out; occasional thin spots for re-acquisition). Base above the 5,000 ft free-flight spawn
	mid_stratus:  { base:305,  top:915,  high:915,  cover:0.85, density:1.3, flat:1.0, gate:[0.0,0.0], dark:0.3 },   // CASE II deck, 1,000-3,000 ft: the NATOPS Case II band (ceiling at or above 1,000 ft but below Case I's 3,000). The Case II spawn is INSIDE it at 1,200 ft, so the level segment is flown on instruments and the glideslope descent breaks out at ~2.7 NM — enough to finish visually, which is what the procedure requires
	low_stratus:  { base:91,   top:915,  high:915,  cover:0.85, density:1.3, flat:1.0, gate:[0.0,0.0], dark:0.3 },   // CASE III deck, 300-3,000 ft: a 300 ft ceiling puts the break-out at ~0.8 NM, exactly on the 0.75 NM ball call — see the ball or call CLARA. The top rose from 1,510 to 3,000 ft because the old deck left marshal and most of the penetration in CLEAR AIR, which drains an instrument approach of its point; now the business end is genuinely IMC (spawn clearings deliberately do not hole stratus). dark matches high_stratus: the user approved that base grey
};
function apply_clouds(){ const p=CLOUDS[cfg.clouds];
	ocean_mat.uniforms.u_cloud_on.value=p?1.0:0.0;
	ocean_mat.uniforms.u_cloud_flat.value=p?p.flat:0.0;   // overcast presets grey the sea's far silvering + reflection (scattered cumulus leaves the sunny sea alone)
	// Cloud horizon band (sky dome + cloud skybg in lockstep): overcast = full-strength wide deck-grey;
	// scattered presets = partial narrow bright haze scaled by coverage (the distant unresolved field).
	const ovc=p?Math.max(p.flat,Math.min(1.0,1.6*p.cover)*(1.0-p.flat)):0.0, ovct=p?(p.flat>0.5?1.02:1.10):1.02, ovcw=p?(p.flat>0.5?0.28:0.14):0.28;   // scattered strength 1.6x cover (cumulus ~0.67): at 0.3 the band vanished on a real display
	sky_mat.uniforms.u_ovc.value=ovc; sky_mat.uniforms.u_ovct.value=ovct; sky_mat.uniforms.u_ovcw.value=ovcw;
	cloud_mat.uniforms.uOvc.value=ovc; cloud_mat.uniforms.uOvcT.value=ovct; cloud_mat.uniforms.uOvcW.value=ovcw;
	if(!p) return;
	cloud_mat.uniforms.uBase.value=p.base; cloud_mat.uniforms.uTop.value=p.top; cloud_mat.uniforms.uHigh.value=p.high;
	cloud_mat.uniforms.uCoverage.value=p.cover; cloud_mat.uniforms.uDensity.value=p.density; cloud_mat.uniforms.uFlat.value=p.flat;
	cloud_mat.uniforms.uGate.value.set(p.gate[0],p.gate[1]); cloud_mat.uniforms.uDark.value=p.dark;
	ocean_mat.uniforms.u_cloud_cover.value=p.cover; ocean_mat.uniforms.u_cloud_mid.value=(p.base+p.top)*0.5; }
const cloud_active=()=>cfg.clouds&&cfg.clouds!=="none";

// ---- volumetric clouds: raymarched, composited against scene depth ----
// scene renders to an offscreen target (with depth); a fullscreen pass marches a
// cloud slab and composites over it, stopping at the scene surface for occlusion.
let rt=null, rt_march=null; const rt_hist=[null,null]; let hist_write=0, hist_valid=false;   // temporal accumulation: the march output is blended into a reprojected history ping-pong
const invVP=new THREE.Matrix4(), curVP=new THREE.Matrix4(), prevVP=new THREE.Matrix4(); const _buf=new THREE.Vector2();
let cloud_frame=0;
function size_rt(){ renderer.getDrawingBufferSize(_buf); const w=Math.max(2,_buf.x|0),h=Math.max(2,_buf.y|0);
	const hw=Math.max(2,w>>1), hh=Math.max(2,h>>1);   // clouds are soft: everything cloud-related runs at half resolution
	if(!rt){ rt=new THREE.WebGLRenderTarget(hw,hh,{depthBuffer:true}); rt.depthTexture=new THREE.DepthTexture(hw,hh);   // depth-source pass only — the scene the player SEES renders directly to the canvas, exactly like the no-clouds path (the full-res RT detour alone cost ~40% frame time and lost MSAA)
		rt_march=new THREE.WebGLMultipleRenderTargets(hw,hh,2,{depthBuffer:false});   // [0] marched cloud light + transmittance, [1] transmittance-weighted mean march distance (reprojection depth)
		rt_march.texture[1].minFilter=THREE.NearestFilter; rt_march.texture[1].magFilter=THREE.NearestFilter;
		rt_hist[0]=new THREE.WebGLRenderTarget(hw,hh,{depthBuffer:false}); rt_hist[1]=new THREE.WebGLRenderTarget(hw,hh,{depthBuffer:false});   // accumulated cloud (ping-pong; the reprojection source must be bilinear)
		rt.texture.minFilter=THREE.LinearFilter; rt.texture.magFilter=THREE.LinearFilter; }
	else if(rt.width!==hw||rt.height!==hh){ rt.setSize(hw,hh); rt_march.setSize(hw,hh); rt_hist[0].setSize(hw,hh); rt_hist[1].setSize(hw,hh); hist_valid=false; } }
const fs_scene=new THREE.Scene(); const fs_cam=new THREE.OrthographicCamera(-1,1,1,-1,0,1);
const cloud_mat=new THREE.ShaderMaterial({ depthTest:false, depthWrite:false, glslVersion:THREE.GLSL3,   // GLSL3 for MRT: the pass writes colour AND a reprojection-depth attachment (explicit outs replace gl_FragColor)
	uniforms:{ tDepth:{value:null}, tNoise:{value:null}, tDetail:{value:null}, uCamPos:{value:new THREE.Vector3()}, uInvVP:{value:new THREE.Matrix4()},
		uTime:{value:0}, uSun:{value:sun_dir}, uSunCol:{value:col_sundisc}, uSky:{value:sky_horizon}, uZenith:{value:sky_zenith}, uFog:{value:fog_colour}, uSunGain:{value:1.0}, uDip:{value:0.0}, uDebug:{value:0.0}, uJitter:{value:0.0},
		uBase:{value:600.0}, uTop:{value:2400.0}, uHigh:{value:5000.0}, uCoverage:{value:0.42}, uDensity:{value:1.0}, uFlat:{value:0.0}, uExposure:{value:1.05},
		uGate:{value:new THREE.Vector2(0.22,0.50)}, uDark:{value:0.45}, uOvc:{value:0.0}, uOvcT:{value:1.02}, uOvcW:{value:0.28},
		uClear:{value:[   // spawn clearings (xy world centre, z inner radius², w outer radius²): no cumulus/Cb ON a spawn spot. World CONSTANTS, so the shared multiplayer cloud field stays identical on every client
			new THREE.Vector4(CARRIER.x, CARRIER.z, 25.0e6, 100.0e6),                                     // carrier (cat spots + landing spawn astern)
			new THREE.Vector4(-1125, 2898, 25.0e6, 100.0e6),                                              // Sand Island runway (reset_ownship's fallback centroid)
			new THREE.Vector4(-1125+Math.sin(68*Math.PI/180)*15000, 2898-Math.cos(68*Math.PI/180)*15000, 25.0e6, 100.0e6),   // free-flight air start (same formula as reset_ownship)
			new THREE.Vector4(0, 0, 25.0e6, 100.0e6) ] } },                                               // joust merge / multiplayer spawn ring (ring=2778 m about the origin)
	vertexShader:`varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }`,
	fragmentShader:`varying vec2 vUv;
		layout(location=0) out vec4 oColor;   // premultiplied cloud light + transmittance
		layout(location=1) out vec4 oDepth;   // R: transmittance-weighted mean march distance / 45 km, G: accumulated alpha (validity)
		uniform sampler2D tDepth; uniform highp sampler3D tNoise,tDetail;
		uniform vec3 uCamPos,uSun,uSunCol,uSky,uZenith,uFog; uniform mat4 uInvVP;
		uniform float uTime,uBase,uTop,uHigh,uCoverage,uDensity,uFlat,uExposure,uDebug,uDark,uJitter,uDip,uOvc,uOvcT,uOvcW,uSunGain;
			uniform vec2 uGate;
		float hash(vec3 p){ p=fract(p*0.3183099+vec3(0.1,0.2,0.3)); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
		float remap(float v,float a,float b,float c,float d){ return c+clamp((v-a)/(b-a),0.0,1.0)*(d-c); }
		float hg(float c,float g){ float g2=g*g; return (1.0-g2)/pow(1.0+g2-2.0*g*c,1.5); }
		// Trade-wind cumulus field: flat bases at uBase, most cells capped by the inversion at uTop, a minority of
		// vigorous cells towering to uHigh (per-cell vigour from low-frequency noise). Density: Perlin-Worley base
		// remapped by coverage, eroded at the edges by high-frequency Worley — the cauliflower billows.
		vec4 cellfield(vec2 xz){ vec2 q=vec2((xz.x*0.958+xz.y*0.286)*0.62, -xz.x*0.286+xz.y*0.958);   // cells stretched ~1.6x along the wind: STREETS of distinct cells — stronger stretch fuses them into worm-chains
			return texture(tNoise, vec3(q*2.0833e-5, 0.37)); }   // ~8 km cell pattern
		float vigour(vec2 xz){ return cellfield(xz).g; }   // .g drives cell placement; .b/.a (worley octaves at the same fetch — free) become per-cell CHARACTER fields below
		uniform vec4 uClear[4];   // spawn clearings — see the uniform block
		float clearing(vec2 xz){ float m=1.0;
			for(int i=0;i<4;i++){ vec2 cd=xz-uClear[i].xy; m*=smoothstep(uClear[i].z,uClear[i].w,dot(cd,cd)); }
			return mix(m,1.0,uFlat); }   // stratus overcast keeps its unbroken sheet — a hole punched in an overcast reads as a bug, not a clearing
		float top_at(float vig){ return mix(mix(uTop,uHigh,smoothstep(0.52,0.68,vig)), uTop, uFlat); }   // NARROW ramp: height plateaus just inside a vigorous cell, so the flanks rise as near-vertical walls — the old wide ramp (0.48-0.82) made height track the vigour falloff and every tower rendered as a smooth cone
		float dens(vec3 p, float lod){   // lod 0 = near (full erosion detail) … 1 = far (soft stable masses — fine detail undersamples at long range and reads as clouds bubbling in and out)
			float cm=clearing(p.xz); if(cm<=0.002) return 0.0;   // spawn clearings: nothing to march inside them
				vec3 sp=p+vec3(uTime*8.0,0.0,uTime*3.0);   // slow drift
				vec4 w=texture(tNoise, sp*4.2e-4+vec3(0.31,0.17,0.47));   // ~2.4 km warp field (fetched early: .r feeds the flank turrets, .gba warps the base field below)
				float hh=clamp((p.y-uBase)/(uHigh-uBase),0.0,1.0);   // absolute slab altitude (independent of vig — the lobe terms below must not feed back into themselves)
				vec4 cf=cellfield(p.xz); float vig=cf.g;
			vec4 lb=texture(tNoise, sp*9.0e-5+vec3(0.63,0.42,0.11));   // GIANT lobe field, ~2 km features: a few HUGE bulging masses first, billows second, texture last
			float attach=smoothstep(uGate.x-0.02,uGate.x+0.06,vig);   // perturbations SCULPT existing cells only: unmasked, a strong lobe over near-gate vigour conjures isolated round puffs floating in mid-air with no tower beneath
			vig=clamp(vig+((lb.g-0.5)*(0.05+0.13*hh)+(w.r-0.5)*0.04)*(1.0-uFlat)*attach,0.0,1.0);   // FLANK TURRETS, two scales: km-class lobes (amplitude growing with height — flat bases, billowing flared heads) + fine 3D scalloping (both TRUE 3D fields — an xz-only field paints vertical cliff striations, found twice)
			float top=top_at(vig);
			float tA=smoothstep(0.25,0.75,cf.b), tB=smoothstep(0.25,0.75,cf.a);   // per-cell character (smooth low-frequency fields, same fetch as vigour): every cell no longer bakes from an identical recipe
			float tallf=smoothstep(uTop,uHigh,top);   // 0 = modest dome, 1 = vigorous tower
			if(tallf>0.02){   // the HEAD is a cluster of giant turrets, not one dome. The turret field
				// must be LOW-PASSED: fine noise makes adjacent columns jump in height — vertical
				// cliff striations down every flank (the curtain-wall look, found twice).
				float turret=texture(tNoise, vec3(p.xz*0.75e-4, 0.71)).g;
				top*=1.0+0.12*tallf*(turret*2.0-1.0);
			}
			float lbase=uBase+(lb.a-0.5)*mix(64.0,110.0,1.0-uFlat);   // the condensation level is flat, not MACHINE-flat: lobe-scale undulation (lowered shelves, ragged patches) breaks the single shared plane that read as artificial. Stratus gets a gentler +/-32 m — a 500 ft marine-layer ceiling that varies slightly, like the real thing
				float h=(p.y-lbase)/(top-lbase); if(h>1.0) return 0.0;
			if(h<0.0){   // sub-base veil: vigorous cells trail translucent virga toward the sea
				if(uFlat>0.5) return 0.0;
				float vfall=1.0+h*3.2; if(vfall<=0.0) return 0.0;
				float shaft=smoothstep(0.60,0.85,vig)*vfall*(1.0-smoothstep(0.35,0.70,lod));   // NEAR-field only: as a thin horizontal layer it integrates into a flat pale band above the horizon at range (height-coded debug, 2026-07-05)
				if(shaft<=0.0) return 0.0;
				vec4 nb=texture(tNoise,(p+vec3(uTime*8.0,0.0,uTime*3.0))*1.6667e-4);
				return smoothstep(0.55,0.85,nb.r)*shaft*0.045*uDensity*cm;
			}
			float prof=mix( smoothstep(0.02,0.12,h)*smoothstep(1.0,mix(mix(0.40,0.62,tA),0.86,tallf),h),   // cumulus domes, per-cell taper (flat-topped through plump); TOWERS hold near-constant width and only round at the head — early taper renders ice-cream cones
			                smoothstep(0.0,0.25,h)*smoothstep(1.0,0.7,h), uFlat );   // stratus: thin even slab
			sp+=(w.gba-0.5)*vec3(150.0,80.0,150.0)*(0.75+0.5*tA)*(1.0-uFlat);   // domain warp, gentle, per-cell amplitude: clusters the base blobs into LOBES (height-scaled warp smears the field into vertical curtain folds — tried and reverted)
			vec3 spn=sp;
			if(uFlat>0.01){ vec2 sw=vec2(sp.x*0.958+sp.z*0.286, -sp.x*0.286+sp.z*0.958); sw.x*=0.32;   // stratus sheets are WIND-COMBED: stretch the base field ~3x along the wind so the deck shows banded striations instead of a featureless veil
				spn=mix(sp, vec3(sw.x,sp.y,sw.y), uFlat); }
			vec4 n=texture(tNoise, spn*1.6667e-4);   // base field, ~6 km period
			float wf=n.g*0.625+n.b*0.25+n.a*0.125;
			float braw=remap(n.r, wf-1.0, 1.0, 0.0, 1.0);
			float base=braw*prof;
				float cov=uCoverage*mix((0.55+0.95*vig)*smoothstep(uGate.x,uGate.y,vig), 1.0, uFlat);   // per-preset cell gate: how FEW the cells are; uCoverage sets how MASSIVE each survivor builds
				float d=remap(base, 1.0-cov, 1.0, 0.0, 1.0)*cov;
			if(d<=0.0) return 0.0;
			float hb=clamp(h*4.0,0.0,1.0), estr=mix(0.35,0.15,uFlat)*(0.82+0.36*tB)*mix(1.0,0.75,uDark);   // per-cell erosion character: some cells ragged and crisply carved, others fuller and softer; darker presets erode less (full billowing masses, not serrated rock)
			float coarse=mix(n.b, 1.0-n.b, hb);                               // coarse erosion from the base sample: keeps far cells SEPARATE at zero cost and zero shimmer (fading erosion out entirely merged the horizon into a solid wall)
			float er=coarse;
			if(lod<0.7){
				vec3 dn=texture(tDetail, sp*8.333e-4).rgb;   // fine erosion detail, ~1.2 km period (near field only — it undersamples and shimmers at range)
				float det=dn.r*0.625+dn.g*0.25+dn.b*0.125;
				if(lod<0.35){ vec3 dn2=texture(tDetail, sp*3.1e-3+vec3(0.5)).rgb;   // second, finer crenellation scale (~320 m), GENTLY mixed: it only exists near, so a strong weight makes clouds visibly dissolve as you approach them
					det=det*0.85+(dn2.r*0.625+dn2.g*0.25+dn2.b*0.125)*0.15*(1.0-smoothstep(0.15,0.35,lod)); }
				er=mix(mix(det, 1.0-det, hb), coarse, smoothstep(0.25,0.7,lod));
			}
				d=remap(d, er*estr*(1.0+1.1*(1.0-clamp(d*2.2,0.0,1.0))), 1.0, 0.0, 1.0);   // edge-weighted erosion: the rim erodes hardest (fractal raggedness), the core stays solid
				d=max(smoothstep(0.05,0.52,d), d*0.30);   // sharpen: defined lobe rims instead of uniform wool — but thin margins SURVIVE the knee as translucent veils (the reference photo mixes dense cores with dissipating wisps you can half-see through; a pure knee makes everything opaque)
			return clamp(d,0.0,1.0)*uDensity*cm;   // cm: spawn clearings thin the fade ring like natural dissipation
		}
		// The blend layer expects display-encoded premultiplied light; reproduce three's exact ACESFilmic + sRGB.
		vec3 rrtodt(vec3 v){ vec3 a=v*(v+0.0245786)-0.000090537; vec3 b=v*(0.983729*v+0.4329510)+0.238081; return a/b; }
		vec3 aces(vec3 color){
			const mat3 inm=mat3(0.59719,0.07600,0.02840, 0.35458,0.90834,0.13383, 0.04823,0.01566,0.83777);
			const mat3 outm=mat3(1.60475,-0.10208,-0.00327, -0.53108,1.10813,-0.07276, -0.07367,-0.00605,1.07602);
			color*=uExposure/0.6; return clamp(outm*rrtodt(inm*color),0.0,1.0); }
		vec3 srgb(vec3 c){ return mix(c*12.92, 1.055*pow(c,vec3(1.0/2.4))-0.055, step(vec3(0.0031308),c)); }
		void main(){
			float depth=texture(tDepth,vUv).r;
			vec4 fp=uInvVP*vec4(vUv*2.0-1.0,1.0,1.0); vec3 ray=normalize(fp.xyz/fp.w-uCamPos);
			float sceneDist=1.0e9;
			if(depth<1.0){ vec4 wp=uInvVP*vec4(vUv*2.0-1.0,depth*2.0-1.0,1.0); sceneDist=length(wp.xyz/wp.w-uCamPos); }
			// The sea PLANE, analytically: the ocean mesh is a finite disc, so past
			// its rim a below-horizon ray reports "no hit" and the march integrates
			// tens of kilometres of extra cloud beyond where water would have stopped
			// it. The rim is a circle at constant range and painted itself as a hard
			// horizontal seam across the cloud field — visible from altitude over
			// cumulus, where the rim sits well below the horizon haze.
			if(ray.y<-1.0e-4) sceneDist=min(sceneDist,(0.0-uCamPos.y)/ray.y);
			vec3 cloudc=vec3(0.0); float ctr=1.0; float aw=0.0, adist=0.0;   // aw/adist: alpha-weighted mean march distance — the accumulation pass reprojects each pixel at this depth
			if(uDebug<0.5){   // uDebug=1: full RT path, zero cloud contribution (A/B against the no-clouds path)
				float slabTop=mix(uHigh,uTop,uFlat);
				float ry=ray.y<0.0?min(ray.y,-2.0e-3):max(ray.y,2.0e-3);   // horizontal rays: the exact-level slab intersection degenerates and paints a one-pixel cloudless line across the view (sign() would zero on ray.y==0)
				float ta=(uBase-uCamPos.y)/ry, tb=(slabTop-uCamPos.y)/ry;
				float cfar=90000.0;   // real maritime visibility: a 12.8 km tower is geometrically visible past 100 km — a 60 km cap read as "clouds nearby, empty sky beyond". Far cells arrive as 72%-hazed silhouettes (the aerial perspective saturates by ~46 km), so haze ends visibility, not a wall
				float t0=max(min(ta,tb),0.0), t1=min(max(ta,tb),min(sceneDist,cfar));
				if(t1>t0){
					float ign=fract(52.9829189*fract(0.06711056*gl_FragCoord.x+0.00583715*gl_FragCoord.y));   // interleaved gradient noise: structured spatially...
					ign=fract(ign+uJitter);   // ...and rotated per frame (golden-ratio sequence): the temporal accumulation then averages ~10 differently-jittered marches per pixel — genuine supersampling, not a blur
					float t=t0; float tr=1.0; vec3 col=vec3(0.0); float hw=0.0;   // each step samples at a jittered point WITHIN its stride (below) — a start-offset-only jitter is a tiny fraction of the far strides, so the shells stay correlated across frames and accumulate as horizontal washboard on distant towers
					float cosT=dot(ray,uSun);
						// Multi-scattering octaves (Hillaire): each bounce generation sees less
						// extinction and a flatter phase — single-scatter Beer renders dense cores
						// dark grey; real cumulus glow white because light floods the interior.
						vec3 phv=vec3( mix(hg(cosT,0.55),hg(cosT,-0.2),0.35),
						               mix(hg(cosT,0.30),hg(cosT,-0.11),0.35),
						               mix(hg(cosT,0.17),hg(cosT,-0.06),0.35) );
					for(int i=0;i<68;i++){ if(t>t1||tr<0.03) break;
						float dt=clamp(t*0.105,110.0,2600.0);   // adaptive stride sized so 68 steps reach cfar from INSIDE the slab (t0=0) — an earlier 60..420 m schedule exhausted at ~13 km in flight and big cells popped in. Strides this coarse are only safe because each is sampled stochastically (ts below) and ~10 jittered frames accumulate; the 96->68 step cut bought the frame rate back after dens() grew the lobe/anvil fetches
						float ts=t+ign*dt;   // stochastic sample WITHIN the stride: the per-frame ign rotation then decorrelates the march shells at EVERY range — jittering only the ray start leaves far shells correlated, accumulating as horizontal washboard across distant towers
						vec3 pos=uCamPos+ray*ts;
						float lod=clamp(ts/26000.0,0.0,1.0); float d=dens(pos,lod);   // detail persists to range: the LOD fade also fades the SHADOW micro-structure, leaving distant towers uniform white against a detailed near one
						if(d>0.01){
							float ld=0.0; vec3 lp=pos; float ls=32.0; float slod=min(lod,0.5);   // the shadow march keeps mid-range detail at ALL distances — sharing the view lod left far towers uniformly lit (flat white against a modelled near one)
							ls*=(0.72+0.56*ign);   // per-pixel tap-distance jitter: decorrelates the shadow shells into floret-scale variance the accumulation smooths
							for(int j=0;j<5;j++){ lp+=uSun*ls; ld+=dens(lp,slod)*ls; ls*=1.75; }   // reach ~640 m: with km-class lobes, a turret must be able to shade the turret below it — the old ~460 m reach lit every lobe identically
								float powder=1.0-exp(-ld*0.028);   // Beer-powder: darkened crinkles on sun-facing billows
								float sun=(0.22+0.78*powder)*(phv.x*exp(-ld*0.010)+0.45*phv.y*exp(-ld*0.005))
								         +0.22*phv.z*exp(-ld*0.0022);   // multi-scatter octaves; powder gates the first two — gap-slipping light samples otherwise flood the field white
								float vig=vigour(pos.xz); float hcur=clamp((pos.y-uBase)/(top_at(vig)-uBase),0.0,1.0);
								// Sky-dome ambient: cumulus shadows are BLUE (sky-lit), with a warm whisper
								// bounced into the bases; both dim deep inside the mass (sun-march depth proxy).
								vec3 suncol=mix(uSunCol,vec3(1.0),0.25)*uSunGain;   // uSunGain = TOD sun intensity / day: the disc COLOUR barely dims at night (a bright moon), but the light it casts must — without this, moonlit clouds rendered like noon. Clouds see a more NEUTRAL sun than the disc: the warm tint compounds through gain+powder+bounce, and near clouds (no aerial haze to blue them) rendered BROWN against the sky
								vec3 dome=mix(uZenith,uSky,0.40); dome=mix(dome,vec3(dot(dome,vec3(0.333))),0.14);   // lightly desaturated: shadowed cloud is sky-lit blue-grey (full saturation painted electric rims; heavier desat turned the shade warm-grey) — kept fairly blue: the reference photo's shade is distinctly cool
								float bfloor=mix(0.68,0.30,uDark);   // per-preset base darkness: fair-weather bottoms are shaded, storm bottoms near-black
								sun=pow(sun,mix(1.38,1.5,uDark))*(bfloor+(1.0-bfloor)*smoothstep(0.04,0.55,hcur));   // harder mid-tone falloff: brilliant lit tops against genuinely shaded mid-bodies — the reference masses are SCULPTED by light, not just lit
								float afloor=mix(0.24,0.12,uDark);
								vec3 ambient=(dome*(afloor+(1.0-afloor)*hcur) + suncol*0.03*(1.0-hcur))*exp(-ld*0.0030)*(1.0-mix(0.50,0.60,uDark)*d)*(1.0+0.45*uFlat);   // crevice AO: dense samples sit deep between billows. Stratus undersides get a lift: over bright tropical water, sea-reflected light keeps an overcast's base grey, not charcoal
								vec3 lit=(suncol*sun*mix(1.30,1.42,uDark) + ambient*0.55)*(0.40+0.60*smoothstep(0.03,0.35,d));   // the low-density fringe DIMS into translucency — a bright fringe reads as an airbrushed halo
							float a=(1.0-exp(-d*0.09*dt))*mix(smoothstep(cfar,cfar*0.65,ts),1.0,uFlat)*smoothstep(0.006,0.045,d);   // the ultra-thin fringe barely registers: accumulated over steps it painted a pale glow RING around every cloud against dark water. NO range ALPHA fade for stratus: at grazing angles any range fade compresses into a few pixels and cuts a hard edge (tried 2026-07-06) — the overcast dissolve is done in COLOUR below instead
							float hz=clamp(1.0-exp(-ts*ts*mix(0.6e-9,1.5e-9,uFlat)),0.0,mix(0.72,0.985,uFlat));   // aerial perspective: the hazed share of each sample's alpha is paid out AFTER the march as the scene sky's own display-space colour — mixing a haze colour through this pass's aces/srgb never matches the sky behind and left a flat pale band above the horizon; pure alpha fade saturates over enough steps and turned the far field its raw beige. For stratus the haze COMPLETES (0.98): the far deck converges to exactly the greyed dome backdrop, so the march's 90 km cutoff is invisible by construction and the texture melts into murk with distance — the dissolve a real overcast has. Safe only because u_ovc greys the dome: against a blue backdrop this leaked blue under the deck
							col+=tr*a*lit*(1.0-hz); hw+=tr*a*hz; aw+=tr*a; adist+=tr*a*ts; tr*=1.0-a; }
						t+=dt; }
					float tsk=(ray.y+uDip)*1.2;   // EXACTLY the sky_mat gradient incl. the #108 horizon-dip peak shift, fog descent and overcast horizon grey (+ sun aureole below), so the haze share composites to the true backdrop — these two shaders change in LOCKSTEP
					vec3 skybg=tsk>=0.0?mix(uSky,uZenith,pow(clamp(tsk,0.0,1.0),0.65))
					                   :mix(uSky,uFog*0.88,clamp(-tsk*6.0,0.0,1.0));
					skybg=mix(skybg, vec3(dot(skybg,vec3(0.333)))*uOvcT, uOvc*(1.0-smoothstep(0.0,uOvcW,abs(tsk))));
					float sbg=max(dot(ray,uSun),0.0); skybg+=uSunCol*(pow(sbg,220.0)*1.4+pow(sbg,8.0)*0.18);
					cloudc=srgb(aces(col))+skybg*hw; ctr=tr; } }   // display-encoded premultiplied cloud light + transmittance for the blend layer
					// (An analytic under-storm horizon mist lived here 2026-07-06 and was removed by request:
					// four rounds of geometry/hue fixes never fully hid the sea/sky line to the pilot's eye.)
			oColor=vec4(cloudc,ctr);
			float tmean=aw>1.0e-4?adist/aw:0.0;   // 0 = no cloud on this ray; the accumulation pass reprojects those at a nominal far distance
			oDepth=vec4(clamp(tmean/100000.0,0.0,1.0), clamp(aw,0.0,1.0), 0.0, 1.0);
		}` });
fs_scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2,2),cloud_mat));
// One-time GPU bake of the tiling 3D cloud noise (Perlin-Worley base + Worley erosion detail), rendered
// slice by slice into 3D textures. Sampling these is ~10x cheaper than the old in-loop fbm, which is what
// pays for the richer lighting and step count above.
function build_cloud_noise(){
	const gen_mat=new THREE.ShaderMaterial({ depthTest:false, depthWrite:false, glslVersion:THREE.GLSL3,
		uniforms:{ uZ:{value:0}, uMode:{value:0} },
		vertexShader:`out vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }`,
		fragmentShader:`in vec2 vUv; layout(location=0) out vec4 frag; uniform float uZ,uMode;
			// PCG3D integer hash, shared VERBATIM with the flight core's convection.go —
			// bit-exact on every GPU and in Go, so the physics feels the cells the player
			// sees (the old sin-hash was driver-dependent). Change one, change both.
			uvec3 pcg3d(uvec3 v){ v=v*1664525u+1013904223u; v.x+=v.y*v.z; v.y+=v.z*v.x; v.z+=v.x*v.y; v=v^(v>>16u); v.x+=v.y*v.z; v.y+=v.z*v.x; v.z+=v.x*v.y; return v; }
			vec3 h3(vec3 p){ uvec3 r=pcg3d(uvec3(ivec3(p+0.5)+64)); return vec3(r)*(1.0/4294967296.0); }
			float worley(vec3 p,float freq){ p*=freq; vec3 id=floor(p), f=fract(p); float m=8.0;
				for(int x=-1;x<=1;x++)for(int y=-1;y<=1;y++)for(int z=-1;z<=1;z++){ vec3 o=vec3(float(x),float(y),float(z));
					vec3 c=h3(mod(id+o,freq))*0.85+0.075+o; vec3 d=c-f; m=min(m,dot(d,d)); }
				return clamp(1.0-sqrt(m),0.0,1.0); }
			float pnoise(vec3 p,float freq){ p*=freq; vec3 id=floor(p), f=fract(p); vec3 u=f*f*(3.0-2.0*f); float v=0.0;
				for(int x=0;x<=1;x++)for(int y=0;y<=1;y++)for(int z=0;z<=1;z++){ vec3 c=vec3(float(x),float(y),float(z));
					vec3 g=h3(mod(id+c,freq))*2.0-1.0;
					float w=mix(1.0-u.x,u.x,c.x)*mix(1.0-u.y,u.y,c.y)*mix(1.0-u.z,u.z,c.z);
					v+=w*dot(normalize(g+1.0e-4),f-c); }
				return clamp(v*0.75+0.5,0.0,1.0); }
			float remap(float v,float a,float b,float c,float d){ return c+clamp((v-a)/(b-a),0.0,1.0)*(d-c); }
			void main(){ vec3 p=vec3(vUv,uZ);
				if(uMode<0.5){
					float pf=pnoise(p,4.0)*0.55+pnoise(p,8.0)*0.3+pnoise(p,16.0)*0.15;
					float w1=worley(p,6.0), w2=worley(p,12.0), w3=worley(p,24.0);
					float wf=w1*0.625+w2*0.25+w3*0.125;
					frag=vec4(remap(pf,wf-1.0,1.0,0.0,1.0), w1,w2,w3);   // R: perlin-worley; GBA: worley fbm octaves
				} else {
					frag=vec4(worley(p,4.0),worley(p,8.0),worley(p,16.0),1.0);   // erosion detail octaves
				} }` });
	const gs=new THREE.Scene(); gs.add(new THREE.Mesh(new THREE.PlaneGeometry(2,2),gen_mat));
	const mk=(size,mode)=>{ const t3=new THREE.WebGL3DRenderTarget(size,size,size);
		t3.texture.wrapS=t3.texture.wrapT=t3.texture.wrapR=THREE.RepeatWrapping; t3.texture.minFilter=THREE.LinearFilter; t3.texture.magFilter=THREE.LinearFilter;
		gen_mat.uniforms.uMode.value=mode;
		for(let z=0;z<size;z++){ gen_mat.uniforms.uZ.value=(z+0.5)/size; renderer.setRenderTarget(t3,z); renderer.render(gs,fs_cam); }
		renderer.setRenderTarget(null); return t3.texture; };
	cloud_mat.uniforms.tNoise.value=mk(128,0);
	ocean_mat.uniforms.u_cloudnoise.value=cloud_mat.uniforms.tNoise.value;   // the ocean's cloud shadows sample the same field the raymarcher renders
	cloud_mat.uniforms.tDetail.value=mk(64,1);
}
build_cloud_noise();
const comp_mat=new THREE.ShaderMaterial({ depthTest:false, depthWrite:false, transparent:true,
	blending:THREE.CustomBlending, blendSrc:THREE.OneFactor, blendDst:THREE.OneMinusSrcAlphaFactor,   // canvas = cloud.rgb + canvas*tr — the same premultiplied maths the RT composite used, done by the blender over the DIRECT scene render
	uniforms:{ tCloud:{value:null}, uTexel:{value:new THREE.Vector2(1/512,1/512)} },
	vertexShader:`varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }`,
	fragmentShader:`varying vec2 vUv; uniform sampler2D tCloud; uniform vec2 uTexel;
		void main(){   // alpha-aware joint upsample: a plain tent feathers bright cloud light across
			// every silhouette into the background — a 2-3 px halo ring at 4K (the same disease
			// the bilateral blur cured in the smoothing pass)
			vec4 c0=texture2D(tCloud,vUv);
			vec4 acc=c0; float wsum=1.0;
			for(int i=0;i<4;i++){
				vec2 dxy=(i==0)?vec2(-0.75,-0.75):(i==1)?vec2(0.75,-0.75):(i==2)?vec2(-0.75,0.75):vec2(0.75,0.75);
				vec4 cs=texture2D(tCloud,vUv+uTexel*dxy);
				float w=0.6*exp(-12.0*abs(cs.a-c0.a));
				acc+=cs*w; wsum+=w;
			}
			vec4 cl=acc/wsum;
			gl_FragColor=vec4(cl.rgb,1.0-cl.a); }` });
const comp_scene=new THREE.Scene(); comp_scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2,2),comp_mat));
const depth_override=new THREE.MeshBasicMaterial({colorWrite:false});   // depth-only scene pass for the cloud raymarch
const acc_mat=new THREE.ShaderMaterial({ depthTest:false, depthWrite:false,
		uniforms:{ tCur:{value:null}, tAux:{value:null}, tHist:{value:null}, uTexel:{value:new THREE.Vector2(1/512,1/512)},
			uPrevVP:{value:new THREE.Matrix4()}, uInvVP:{value:new THREE.Matrix4()}, uCamPos:{value:new THREE.Vector3()}, uHistValid:{value:0.0} },
	vertexShader:`varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }`,
	fragmentShader:`varying vec2 vUv; uniform sampler2D tCur,tAux,tHist; uniform vec2 uTexel;
		uniform mat4 uPrevVP,uInvVP; uniform vec3 uCamPos; uniform float uHistValid;
		void main(){   // temporal accumulation: reproject last frame's accumulated cloud through the previous
			// view-projection at each pixel's mean march distance, clamp it against the current 3x3
			// neighbourhood (kills ghosting on disocclusion), and blend. ~10 differently-jittered marches
			// average into each pixel — the supersampling the old bilateral blur only faked.
			vec4 cur=texture2D(tCur,vUv);
			vec4 mn=cur, mx=cur; vec4 avg=cur;
			for(int i=0;i<8;i++){
				vec2 d=(i==0)?vec2(uTexel.x,0.0):(i==1)?vec2(-uTexel.x,0.0):(i==2)?vec2(0.0,uTexel.y):(i==3)?vec2(0.0,-uTexel.y)
				      :(i==4)?uTexel:(i==5)?-uTexel:(i==6)?vec2(uTexel.x,-uTexel.y):vec2(-uTexel.x,uTexel.y);
				vec4 cs=texture2D(tCur,vUv+d);
				mn=min(mn,cs); mx=max(mx,cs); avg+=cs;
			}
			avg*=1.0/9.0;
			float tn=texture2D(tAux,vUv).r;
			float t=tn>0.0?tn*100000.0:30000.0;   // cloudless rays reproject at a nominal far distance (rotation-dominant)
			vec4 fp=uInvVP*vec4(vUv*2.0-1.0,1.0,1.0); vec3 ray=normalize(fp.xyz/fp.w-uCamPos);
			vec4 pc=uPrevVP*vec4(uCamPos+ray*t,1.0);
			vec2 puv=(pc.xy/pc.w)*0.5+0.5;
			float w=0.90*uHistValid;
			if(pc.w<=0.0||puv.x<0.0||puv.x>1.0||puv.y<0.0||puv.y>1.0) w=0.0;   // off-screen last frame: no history
			vec4 hist=clamp(texture2D(tHist,puv),mn,mx);   // neighbourhood clamp: stale history is pulled to what the current frame says is locally possible
			gl_FragColor=mix(w>0.0?cur:avg,hist,w); }` });   // rejected pixels fall back to the neighbourhood mean — the old blur, exactly where it is still needed
const acc_scene=new THREE.Scene(); acc_scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2,2),acc_mat));
function render_frame(){
	if(cfg.view==="ddi") return;   // head-down: the opaque 2D panel covers the screen — skip the world passes entirely (the sim and audio run on; set_view marks cloud history stale for the return cut)
	{ const f=new THREE.Vector3(0,0,-1).applyQuaternion(camera.quaternion), u=new THREE.Vector3(0,1,0).applyQuaternion(camera.quaternion);
		audio_listener(camera.position.x,camera.position.y,camera.position.z,f.x,f.y,f.z,u.x,u.y,u.z); }
	// Cockpit split (#99), stateless per frame so nothing can strand a stale mask:
	// in cockpit view the world passes skip the ownship layer entirely.
	const pit = cfg.view==="cockpit" && !map_on;
	camera.layers.set(0); if(!pit) camera.layers.enable(LAYER_OWN);
	const dip=Math.max(camera.position.y,3)/45000;   // #108: dip of the VISIBLE sea/sky line — set by the seafog completion and the 42 km far plane, NOT the 120 km mesh rim (that model left a bright crest above the line at altitude). Generous by design: a peak clipped below the line is invisible, a crest above it is the band
	sky_mat.uniforms.u_dip.value=dip; cloud_mat.uniforms.uDip.value=dip;
	if(cloud_active()){ size_rt();
		scene.overrideMaterial=depth_override; renderer.setRenderTarget(rt); renderer.render(scene,camera); scene.overrideMaterial=null;   // half-res pass, used only for scene DEPTH (cloud occlusion) — cheap flat shading, no lighting or textures
		curVP.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse); invVP.copy(curVP).invert();
		cloud_mat.uniforms.tDepth.value=rt.depthTexture;
		cloud_mat.uniforms.uCamPos.value.copy(camera.position); cloud_mat.uniforms.uInvVP.value.copy(invVP);
		cloud_mat.uniforms.uJitter.value=(++cloud_frame*0.61803398875)%1;   // golden-ratio jitter sequence for the march offsets — see the accumulation pass
		cloud_mat.uniforms.uTime.value=(MULTIPLAYER&&net&&net.time)?net.time():sim_time;   // multiplayer: clouds drift on the SHARED session clock — a local mission clock puts every player's cloud field in a different place, and hiding in cloud must mean the same cloud for everyone
		renderer.setRenderTarget(rt_march); renderer.render(fs_scene,fs_cam);   // half-res raymarch (colour + reprojection depth)
		const hr=1-hist_write;
		acc_mat.uniforms.tCur.value=rt_march.texture[0]; acc_mat.uniforms.tAux.value=rt_march.texture[1]; acc_mat.uniforms.tHist.value=rt_hist[hr].texture;
		acc_mat.uniforms.uTexel.value.set(1/rt_march.width,1/rt_march.height);
		acc_mat.uniforms.uPrevVP.value.copy(prevVP); acc_mat.uniforms.uInvVP.value.copy(invVP); acc_mat.uniforms.uCamPos.value.copy(camera.position);
		acc_mat.uniforms.uHistValid.value=hist_valid?1.0:0.0;
		renderer.setRenderTarget(rt_hist[hist_write]); renderer.render(acc_scene,fs_cam);   // blend into the reprojected history
		renderer.setRenderTarget(null); renderer.render(scene,camera);   // the player-visible scene: the EXACT no-clouds path (canvas MSAA and all)
		comp_mat.uniforms.tCloud.value=rt_hist[hist_write].texture; comp_mat.uniforms.uTexel.value.set(1/rt_march.width,1/rt_march.height);
		renderer.autoClear=false; renderer.render(comp_scene,fs_cam); renderer.autoClear=true;   // blend the cloud layer over it
		prevVP.copy(curVP); hist_valid=true; hist_write=hr;   // this frame's accumulation is next frame's history
	} else { renderer.render(scene,camera); }
	if(pit){   // the near pass: ownship only, depth cleared, drawn OVER the composited world+clouds — clouds can never bleed onto the panel, and the world shows through the glass
		cockpit_cam.position.copy(camera.position); cockpit_cam.quaternion.copy(camera.quaternion);
		renderer.autoClear=false; renderer.clearDepth(); renderer.render(scene,cockpit_cam); renderer.autoClear=true;
	}
}

// ============================================================================ geometry
function merge_geometries(geos){ let total=0; const parts=geos.map(g=>(g.index?g.toNonIndexed():g)); parts.forEach(g=>total+=g.attributes.position.count);
	const pos=new Float32Array(total*3),nor=new Float32Array(total*3); let o=0;
	for(const g of parts){ const p=g.attributes.position.array,n=g.attributes.normal.array; pos.set(p,o); nor.set(n,o); o+=p.length; }
	const out=new THREE.BufferGeometry(); out.setAttribute("position",new THREE.BufferAttribute(pos,3)); out.setAttribute("normal",new THREE.BufferAttribute(nor,3)); out.computeBoundingSphere(); return out; }
// Afterburner cone geometry/material — SHARED by every jet make_jet builds.
// (Restored: the #166 dead-code sweep removed them as "procedural jet leftovers"
// while make_jet still used both, so every mission start threw ab_geo-not-defined.)
const ab_geo=new THREE.ConeGeometry(0.3,2.6,12); ab_geo.rotateZ(Math.PI/2);
const ab_mat=new THREE.MeshBasicMaterial({color:0xffaa44,transparent:true,opacity:0.8,blending:THREE.AdditiveBlending,depthWrite:false,fog:false});
function make_jet(){ const g=new THREE.Group();   // afterburner cones only — the airframe is the loaded GLB (no procedural fallback). NO team colour: every jet wears the F/A-18C's own livery, and identification is the HUD's and the map's job (#210)
	for(const side of [1,-1]){ const ab=new THREE.Mesh(ab_geo,ab_mat); ab.position.set(-9.3,-0.37,side*0.48); ab.userData.ab=true; g.add(ab); } return g; }   // at the Hornet's twin nozzles (Y raised from -0.95 after the gear extended the model bbox, shifting normalise's centre up ~0.58)

// ============================================================================ aircraft GLB models (cosmetic only)
// Each aircraft is web/public/aircraft/<id>/model.glb (served by the app.json "aircraft" action);
// a new type is one CATALOGUE entry here plus its folder — mirrors world/games/air/aircraft/<id>/.
// Source must be UNCOMPRESSED glTF/GLB (no Draco/Meshopt) — Sketchfab's plain "glTF" download works.
// Per-aircraft models and their animation rigs. Orientation: if a model
// looks wrong — flies BACKWARDS -> yaw 180; on its SIDE -> roll ±90; nose
// pitched -> pitch ±90; upside down -> roll 180. A rig entry either matches
// whole CLIPS by name (the F ships split clips) or partitions the model's
// single timeline by animated-node TRACK name (the C); each is scrubbed
// from game state: "drive" picks the state channel, min/max normalise a
// signed surface deflection (rad) onto the clip span, flip reverses it.
const AIRCRAFT_MODELS={
	fa18c:{ url:fa18c_model_url, length:17.07, yaw:90, pitch:0, roll:0,
		cockpitHide:/^Pilot_Head_769$/,   // first person: this subtree is the head+helmet+visor+mask; the body and arms stay on the stick
		pose:model_pose,   // the stabs' mid-animation-flipped parent correction — SHARED with the setup preview (model.ts POSE) so both prepare the same jet. A GLOBAL end-prime is wrong: other subtrees (the left flap family) end DEPLOYED

		nose:4.9, wheel:2.85, stance:2.57, squat:0.08, flames:true,   // the model's own glow discs carry the burner look, procedural cones stay off (the nozzle helper-cube mesh was removed from the GLB itself — #94)   // physics nose-gear x + the DEPLOYED drawn nose-wheel x and wheel-bottom drop (three.js pose of the gear animation — the STATIC pose is gear-up on this model and lies about both); squat = clip-fraction scrubbed back under weight so the drawn oleo compresses (~0.4 m of wheel travel per unit fraction at the clip tail)
		swivel:{ node:"c_gear_AN_lower_134", axis:[0.0012,0.0934,0.9956] },
		spin:[ { node:"l_tire_anim_AN_Tire_35",     axis:[-0.043,-0.991,-0.130], radius:0.375 },   // wheel spin: node-local axles measured in the DEPLOYED gear pose (the static pose stows the mains FLAT — never measure there); +rotation about each axis rolls forward. Radii match the real 30x11.5 mains / 22x6.6 nose tires
		       { node:"r_tire_anim_AN__287",        axis:[-0.124,0.992,0.029],   radius:0.377 },
		       { node:"c_tire_anim_AN_Wheels_132",  axis:[1,0,0],                radius:0.296 } ],   // the nose PAIR's axle is exactly local +x (0.63 m across the pair, circular 0.59 m discs about it) — the deployed-pose world-x read was 13.7° off and made the wheels wobble ("ploughed field"). (Fan-face rotation was implemented and REMOVED: the S-ducts hide the fans from every outside sightline — verified by render — so it was invisible machinery)
		flame:[ "Afterburner_can_flamesAction_AN_flames_1", "Afterburner_can_flames_rightAction_AN_right_4" ],   // the can-interior flame discs: the modeller's authored effect is a spin about the engine axis (local z) — a radial flame texture churning inside the can. Hidden dry, spinning with each engine's reheat   // nosewheel steering: the lower strut + scissor + wheels swivel about this node-local axis (the strut line in the DEPLOYED gear pose — measured; the gear clip re-poses the node every frame so the steering twist is post-multiplied after the mixer). Axis SIGN set empirically: the offline tire-PCA direction read was ambiguous and picked the wrong sense — the user saw the wheel steer opposite the turn
		rig:[ { name:"gear",     track:model_gear, drive:"gear" },   // track family shared with the preview (model.ts GEAR)
		      { name:"hook",     track:/^Hook_AN_/i, drive:"hook" },
		      { name:"probe",    track:/^RefuelDoorAction_AN/i, drive:"probe" },   // in-flight refueling probe (starboard nose): door + arm + probe swing on one sequence; Shift+F toggles, ~5 s travel (the cockpit Refuel_Switch tracks have a different prefix and stay untouched)
		      { name:"canopy",   track:/^Canopy_ParentAction_AN/i, drive:"canopy" },
		      { name:"petals",   track:/^EXHAUSTS_/i, drive:"nozzle" },
		      { name:"fold",     track:/wing_outer_AN/i, drive:"fold" },
		      { name:"bar",      track:/^c_launch_bar_AN/i, drive:"bar" },   // launch bar: rides the nose-gear subtree (retracts with the gear); its own track swings it 133° from stowed-along-strut (authored) to the deck hookup (end). Automatic: down when captured by a catapult, up after the shot   // wing fold: both outer-panel tracks (left +100°, right -110° — the clip owns the asymmetric sweeps), authored = spread, track end = folded. The panels carry ailerons, covers, droop stages and outer slats   // 24 nozzle petals, one shared sweep: authored = closed, track end = open (+7.2°, tip radius 25->32 cm, measured). Driven by the F404 area schedule, not a toggle   // canopy shells + actuator arm + linkage; Shift+C on the ground, ~6 s stroke, auto-closes on the takeoff roll (the cockpit Canopy_Switch has a different prefix)
		      { name:"stabL",    node:"Elevator_Left_94",  axis:"x", base:[0.96593,0,0,0.25882], drive:"stabL" },   // neutral base calibrated three ways: the user's Shift+E bracket (position 3 ≈ neutral), the thin-axis minimum (surface vertical thickness minimized at +130° from the old base), and NATOPS throws (+10.5°/−24°) mapping full stick inside the user's positions 2..4
		      { name:"stabR",    node:"Elevator_right_97", axis:"x", base:[0.96502,0,0,0.26219], drive:"stabR" },
		      { name:"slatLI",    node:"Left_Slat_Inner_63",   axis:"x", drive:"slat" },   // leading-edge flaps: static nodes in the GLB (no authored animation), direct-driven about their own local X — the modeller aligned each node frame with the swept LE hinge (within 3°), and +rotation droops the LE on BOTH sides (mirrored frames). Drive = the core's alpha-scheduled slat state (word 27)
		      { name:"slatLO",    node:"Left_slat_outer_77",   axis:"x", drive:"slat" },
		      { name:"slatRI",    node:"Right_Slat_inner_300", axis:"x", drive:"slat" },
		      { name:"slatRO",    node:"Right_Slat_Outer_315", axis:"x", drive:"slat" },
		      { name:"flapL",     node:"FlapL_12",           axis:"x", sign:-1, drive:"flapL" },   // flap droop percent keys sweep 0..-40° with 0 = 0% droop, so the authored pose IS flush — no base needed (unlike the aileron roll stage, whose keys are roll ±20° around a -20° flush centre)
		      { name:"flapR",     node:"FlapR_15",           axis:"x", sign:-1, drive:"flapR" },
		      // NOTE: Left_Flaperon_74 / Right_Flaperon_312 are NOT separate inboard surfaces — they are the
		      // DROOP stage of the aileron chains (Left_Flaperon_74 -> ... -> AileronL_69 -> the one aileron
		      // mesh). Driving them alongside the aileron entries doubled the droop (ailerons drooped 2v while
		      // the flaps drooped v — the in-flight "ailerons droop relative to the flaps"). The aileron entries
		      // below carry the full flaperon signal (droop + roll differential) through one stage instead.
		      { name:"aileronL",  node:"AileronL_69",        axis:"x", sign:-1, base:[-0.17365,0,0,0.98481], drive:"flapL" },   // both ailerons: flush (TE continues the wing; ailerons are faired with flaps up) = -20° local, the centre of each side's 0..±40° roll percent-key sweep — matches the right's silhouette-bisected hand calibration to 0.02°. The authored static poses are asymmetric (left full-up 0°, right full-down -40°), so neither is neutral
		      { name:"aileronR",  node:"AileronR_309",       axis:"x", sign:-1, base:[-0.17365,0,0,0.98481], drive:"flapR" },
		      { name:"coverL",    node:"l_aileron_percent_key_AN_Cover_65",  axis:"x", sign:-1, max:0, drive:"flapL" },   // aileron shroud covers: separate follower nodes outside the aileron subtrees, seated on the wing at their authored statics and floored there via the node-drive max cap (they ride up with an up-deflected aileron so it never pokes through, and never follow the droop down). The original left plate was a different, smaller ride-on-the-aileron design that leaked a gap at every pose; its mesh was replaced in the GLB by a mirrored copy of the right cover baked closed at the authored static, so both wings now share the validated seated design
		      { name:"coverR",    node:"r_aileron_percent_key_AN_Cover_302", axis:"x", sign:-1, max:0, drive:"flapR" },
		      { name:"rudderL",  node:"rudder_percent_key_AN_Left_319",  axis:"y", base:[0,0.15471,0,0.98796], sign:-1, toe:-0.5236, min:-0.5236, max:0.5236, drive:"rudder" },   // rudder neutral: trailing-edge-in-fin-plane (PCA fin plane, rotate until the TE's mean plane distance is zero) — sharper than the lateral-extent minimum, which sat ~6° off; re-verified 2026-07-06 (TE residual under 4 mm). toe = the Hornet's rudder toe-in: with the gear down both trailing edges deflect 30° INBOARD (the canted fins turn that into nose-up pitch for takeoff rotation), active with weight on wheels (washing out at liftoff via the squish signal); min/max clamp the sum of toe + yaw command at the ±30° physical throw
		      { name:"rudderR",  node:"rudder_percent_key_AN_Right_322", axis:"y", base:[0,0.19423,0,0.98096], sign:-1, toe:0.5236, min:-0.5236, max:0.5236, drive:"rudder" },   // sign -1 on both: the core's aero convention is +rudder = nose LEFT (tail pushed right), and these hinges deflect the TEs starboard for +local rotation — so nose-right (negative) commands must show TE-starboard rudders. The toe values are pre-sign, hence flipped
		      { name:"brake",    track:/^SPOILER_L/i, drive:"speedbrake" },
	      // ---- cockpit instruments (#99): DIRECT drives, never clip scrubs — the GLB's percent-key
	      // tracks for these are EASED 0-360° sweeps (scrubbing time would warp the reading and
	      // cannot wrap). Axes/signs/throws extracted from the tracks themselves. RULE: none of
	      // these nodes may ever be matched by a scrubbed-clip track regex, or the mixer fights
	      // the writes (the nosewheel swivel post-multiply pattern is the escape hatch).
	      { name:"adiPitch",  node:"INSTRUMENT_AttitudeIndicator_Pitch_AN_Pitch_503",        axis:"x", gauge:"pitch" },
	      { name:"adiBank",   node:"INSTRUMENT_AttitudeIndicator_Bank_AN_Bank_505",          axis:"z", sign:-1, gauge:"bank" },
	      { name:"compass",   node:"INSTRUMENT_MagneticCompass_AN_MagneticCompass_517",      axis:"y", gauge:"heading" },
	      { name:"throttleA", node:"ThrottleLever_LeftAction_AN_throttle0_579",              axis:"x", gain:0.698, gauge:"throttle" },
	      { name:"throttleB", node:"Throttle_Lever_RightAction_AN_throttle1_585",            axis:"x", gain:0.698, gauge:"throttle" },
	      { name:"stickPitch",node:"Stick_ForeAft_Action_AN_Base_382",                       axis:"x", gain:-0.35, gauge:"stickPitch" },
	      { name:"stickRoll", node:"Stick_LR_Action_AN_Column_379",                          axis:"z", gain:0.52,  gauge:"stickRoll" },
	      { name:"adiSlip",   node:"INSTRUMENT_AttitudeIndicator_Slip_AN_Slip_514",          trans:[-1,-0.02,0],  gain:0.0276, min:-1, max:1, gauge:"slip" },
	      { name:"adiGlide",  node:"INSTRUMENT_AttitudeIndicator_Glide_AN_Glide_508",        trans:[0,0.99,0.14], gain:0.0468, min:-1, max:1, gauge:"glide" },
	      { name:"adiLoc",    node:"INSTRUMENT_AttitudeIndicator_Localizer_AN_Localizer_511",trans:[-1,0,0],      gain:0.0554, min:-1, max:1, gauge:"loc" },
	      // ---- #99 batch 2: needles are shaped in update_gauges (nonlinear dials measured off the
	      // face textures — the GLB's needle tracks are uncalibrated double-spins, useless beyond
	      // axis+sign); drums are plain place-value gains (full turn per 10 units of their place).
	      // Needle +z = clockwise and drum -x = digits ascending, verified against the live pit.
	      { name:"asi",       node:"Airspeed_Action_AN__350",                        axis:"z", gauge:"asi" },
	      { name:"altNeedle", node:"needle_altitude_thousand_AN_thousand_594",       axis:"z", gain:6.2832/1000,   gauge:"altitude" },
	      { name:"altH",      node:"digits_altitude_hundred_AN_hundred_388",         axis:"x", sign:-1, gain:6.2832/1000,   gauge:"altitude" },
	      { name:"altT",      node:"digits_altitude_thousand_AN_thousand_394",       axis:"x", sign:-1, gain:6.2832/10000,  gauge:"altitude" },
	      { name:"altTT",     node:"digits_altitude_tenthousand_AN_tenthousand_391", axis:"x", sign:-1, gain:6.2832/100000, gauge:"altitude" },
	      { name:"vsi",       node:"VSINeedleAction_AN__736",                        axis:"z", gauge:"vsi" },
	      { name:"fuelNeedle",node:"FuelNeedleAction_AN_Needle_466",                 axis:"z", gain:6.2832/22000,  gauge:"fuelLbs" },
	      { name:"fuel10",    node:"Fuel_Drum_10_AN_10_442",                         axis:"x", sign:-1, gain:6.2832/100,    gauge:"fuelLbs" },
	      { name:"fuel100",   node:"Fuel_Drum_100_AN_100_445",                       axis:"x", sign:-1, gain:6.2832/1000,   gauge:"fuelLbs" },
	      { name:"fuel1000",  node:"Fuel_Drum_1000_AN_1000_448",                     axis:"x", sign:-1, gain:6.2832/10000,  gauge:"fuelLbs" },
	      { name:"fuel10000", node:"Fuel_Drum_10000_AN_10000_451",                   axis:"x", sign:-1, gain:6.2832/100000, gauge:"fuelLbs" },
	      // engine column pairs: higher x = higher digit place AND the left-engine column (both
	      // verified from node positions: EGT_10/100/1000 ascend with x; L-pair sits at higher x)
	      { name:"rpmL10",    node:"RPMNeedleLAction_AN__646",  axis:"x", sign:-1, gain:6.2832/100,   gauge:"rpmL" },
	      { name:"rpmL1",     node:"RPMNeedleL2Action_AN__649", axis:"x", sign:-1, gain:6.2832/10,    gauge:"rpmL" },
	      { name:"rpmR10",    node:"RPMNeedleRAction_AN__652",  axis:"x", sign:-1, gain:6.2832/100,   gauge:"rpmR" },
	      { name:"rpmR1",     node:"RPMNeedleR2Action_AN__655", axis:"x", sign:-1, gain:6.2832/10,    gauge:"rpmR" },
	      { name:"egtL10",    node:"EGT_10_AN_10_424",       axis:"x", sign:-1, gain:6.2832/100,   gauge:"egtL" },
	      { name:"egtL100",   node:"EGT_100_AN_100_427",     axis:"x", sign:-1, gain:6.2832/1000,  gauge:"egtL" },
	      { name:"egtL1000",  node:"EGT_1000_AN_1000_430",   axis:"x", sign:-1, gain:6.2832/10000, gauge:"egtL" },
	      { name:"egtR10",    node:"EGT2_10_AN_10_415",      axis:"x", sign:-1, gain:6.2832/100,   gauge:"egtR" },
	      { name:"egtR100",   node:"EGT2_100_AN_100_418",    axis:"x", sign:-1, gain:6.2832/1000,  gauge:"egtR" },
	      { name:"egtR1000",  node:"EGT2_1000_AN_1000_421",  axis:"x", sign:-1, gain:6.2832/10000, gauge:"egtR" },
	      // fuel flow displays pph/10 on three drums (place order by x, same rule)
	      { name:"flowL1",    node:"FuelFlowAction3_AN__472",   axis:"x", sign:-1, gain:6.2832/10,   gauge:"flowL" },
	      { name:"flowL10",   node:"FuelFlowAction4_AN__475",   axis:"x", sign:-1, gain:6.2832/100,  gauge:"flowL" },
	      { name:"flowL100",  node:"FuelFlowAction5_AN__478",   axis:"x", sign:-1, gain:6.2832/1000, gauge:"flowL" },
	      { name:"flowR1",    node:"Fuel_Flow1d_AN_Flow1d_463", axis:"x", sign:-1, gain:6.2832/10,   gauge:"flowR" },
	      { name:"flowR10",   node:"Fuel_Flow1c_AN_Flow1c_460", axis:"x", sign:-1, gain:6.2832/100,  gauge:"flowR" },
	      { name:"flowR100",  node:"Fuel_Flow1b_AN_Flow1b_457", axis:"x", sign:-1, gain:6.2832/1000, gauge:"flowR" },
	      { name:"clockH",    node:"Clock_hourAction_AN_Hour_364", axis:"z", gain:6.2832/12, gauge:"clockH" },
	      { name:"clockM",    node:"ClockMinutesAction_AN__367",   axis:"z", gain:6.2832/60, gauge:"clockM" },
	      { name:"clockS",    node:"ClockSecondsAction_AN__370",   axis:"z", gain:6.2832/60, gauge:"clockS" },
	      // right-console gauges: batteries are calibrated ±143° y-axis sweeps; hyd/cabin follow
	      // the needle family's clock-anchored +z convention with game-plausible drives
	      { name:"hyd",       node:"INSTRUMENT_Needle_HydPressure_AN_HydPressure_529", axis:"z", gauge:"hyd" },
	      { name:"cabin",     node:"INSTRUMENT_Needle_CabinPress_AN_CabinPress_526",   axis:"z", gauge:"cabin" },
	      { name:"voltE",     node:"INSTRUMENT_Needle_Battery_AN_BatteryE_520",  axis:"y", sign:-1, gauge:"volts" },
	      { name:"voltU",     node:"INSTRUMENT_Needle_BatteryUAction_AN_BatteryU_523", axis:"y", gauge:"volts" },
	      // cockpit levers ride their authored clips (single calibrated sweeps), scrubbed from state
	      { name:"gearlever", track:/^Gear_handle_AN/i, drive:"gearlever" },
	      { name:"hooklever", track:/^LANDING_Gear_Lever_Hook_AN/i, drive:"hooklever" },
	      { name:"flaplever", track:/^lever_flap_AN/i, drive:"flaplever" } ] } };
const D2R=Math.PI/180;
// fleet: aircraft name -> { proto, rig:[{clip, t0, t1, drive, min, max, flip}] } once loaded.
const fleet={}; const fleet_loading={};
let model_active=false;   // the ownship's aircraft model is ready (loading gate)
const GEAR_RATE=0.5;   // extend/retract speed of the 0..1 visual progress for aircraft the core doesn't fly
const DROOP=30*D2R;    // PA trailing-edge droop (NATOPS flaps HALF on the ground: TEF 30°, aileron droop 30°) — the rest pose of the flap family for gear-down aircraft the core doesn't fly; the ownship's comes live from the FCS (Droop.Angle in the flight core)
const SLAT_PA=12*D2R;  // parked/gear-down LEF droop for aircraft without FCS data (NATOPS flaps HALF: LEF 12°) — the ownship's comes live from the alpha schedule
const _NWS=75*D2R;      // nosewheel steering throw (NWS HI 75°; LOW is 22.5° — the speed washout stands in for the mode switch, mirroring Gear.Nose.Steer in the flight core)
function normalise_model(scene, spec){ scene.updateMatrixWorld(true);
	const box=new THREE.Box3().setFromObject(scene), size=box.getSize(new THREE.Vector3()), ctr=box.getCenter(new THREE.Vector3());
	const s=spec.length/Math.max(size.x,size.y,size.z,1e-3);
	scene.scale.setScalar(s); scene.position.set(-ctr.x*s,-ctr.y*s,-ctr.z*s);
	const proto=new THREE.Group(); proto.add(scene);
	proto.rotation.set(spec.pitch*D2R, spec.yaw*D2R, spec.roll*D2R);
	proto.position.x=(spec.nose||0)-(spec.wheel||spec.nose||0);   // align the drawn nose wheel onto the physics nose gear: wheels, physics, and the shuttle coincide
	const outer=new THREE.Group(); outer.add(proto); outer.updateMatrixWorld(true); return outer; }

// rig_build partitions a model's animations into scrubbable per-subsystem
// clips: clip-name matching for models shipped with split clips, track-name
// matching to carve subsystems out of a single combined timeline.
// moving_span finds where a track's values actually CHANGE — on a shared
// timeline every track carries keys across the whole file and only moves in
// its own segment, so keyframe extents lie about the subsystem's range.
function moving_span(track){
	const n=track.times.length, w=track.getValueSize();
	let first=-1, last=-1;
	for(let i=1;i<n;i++){ let moved=false;
		for(let k=0;k<w;k++){ if(Math.abs(track.values[i*w+k]-track.values[(i-1)*w+k])>1e-5){ moved=true; break; } }
		if(moved){ if(first<0) first=track.times[i-1]; last=track.times[i]; } }
	return first<0?null:[first,last];
}
function rig_build(spec, animations){
	const rig=[];
	for(const entry of spec.rig||[]){
		if(entry.node){ rig.push({ ...entry, axis:entry.axis||"x", sign:entry.sign||1 }); continue; }   // direct hinge drive, all spec fields carried (toe/min/max included — an explicit field list here silently dropped them once) — resolved against each clone in apply_model_to
		let tracks=[], duration=0;
		if(entry.clip){ for(const c of animations){ if(entry.clip.test(c.name||"")){ tracks=tracks.concat(c.tracks); duration=Math.max(duration,c.duration||0); } } }
		else { for(const c of animations) for(const t of c.tracks){ const node=t.name.slice(0,t.name.lastIndexOf(".")); if(entry.track.test(node)) tracks.push(t); } }
		if(!tracks.length) continue;
		let t0=1e9, t1=-1e9;
		for(const t of tracks){ const span=moving_span(t); if(!span) continue; if(span[0]<t0) t0=span[0]; if(span[1]>t1) t1=span[1]; }
		if(t1<t0){ t0=tracks[0].times[0]; t1=tracks[0].times[tracks[0].times.length-1]; } // nothing moves: fall back to extents
		if(entry.clip){ t0=0; t1=duration||t1; }
		rig.push({ name:entry.name, clip:new THREE.AnimationClip("rig_"+entry.name, -1, tracks), t0, t1, drive:entry.drive, min:entry.min, max:entry.max, flip:!!entry.flip });
	}
	return rig;
}
function apply_model_to(g, kind){ kind=kind||g.userData.aircraft||"fa18c";
	const loaded=fleet[kind]; if(!loaded||g.userData.hasModel===kind) return; g.userData.hasModel=kind;
	g.children.forEach(c=>{ if(c.userData.body||c.userData.glass) c.visible=false; });   // hide procedural shell, keep afterburner cones
	const previous=g.children.find(c=>c.userData&&c.userData.model); if(previous) g.remove(previous);   // aircraft swap: drop the old airframe
	// NO team tint on a modelled airframe (#210). The red bandit and pale-grey
	// traffic were identification aids from the procedural-shell era, when every
	// jet was untextured geometry and colour was the only way to tell them
	// apart. Multiplied over the F/A-18C's own livery it just stains the
	// paintwork, and it was inconsistent besides (multiplayer tinted by real
	// team, the single-player bandit was always red). Identification is a
	// SENSOR job, as in the real jet: the HUD boxes the designated target and
	// draws the locator line to it off-boresight, and the map colours contacts
	// by side. The airframe wears its own paint.
	const m=loaded.proto.clone(true); m.userData.model=true;
	m.traverse(o=>{ if(o.isMesh){ o.userData.modelmesh=true; o.castShadow=cfg.shadows; } });
	const spec=AIRCRAFT_MODELS[kind]||{};
	if(spec.hide) m.traverse(o=>{ if(o.name&&spec.hide.test(o.name)) o.visible=false; });   // per-aircraft junk meshes (helper cubes etc.)
	g.userData.flames=spec.flames||undefined;
	if(spec.flames) g.children.forEach(c=>{ if(c.userData&&c.userData.ab) c.visible=false; });   // this model's own glow replaces the procedural cones
	g.userData.swivel=null;
	if(spec.swivel){ const sw=m.getObjectByName(spec.swivel.node); if(sw) g.userData.swivel={ object:sw, axis:new THREE.Vector3(...spec.swivel.axis).normalize() }; }
	g.userData.spin=(spec.spin||[]).map(s=>{ const o=m.getObjectByName(s.node); return o?{ object:o, axis:new THREE.Vector3(...s.axis).normalize(), radius:s.radius, base:o.quaternion.clone() }:null; }).filter(Boolean);
	g.userData.flame=(spec.flame||[]).map(n=>{ const o=m.getObjectByName(n); return o?{ object:o, base:o.quaternion.clone() }:null; }).filter(Boolean);
	const glow=new Map(), burner=new Map();   // emissive materials cloned per aircraft: exterior/cockpit lights switch with the lights state; the afterburner can + exit-disc glow follows the achieved engine power (no external plume — the glow lives inside the nozzles)
	m.traverse(o=>{ if(!o.isMesh||!o.material) return; (Array.isArray(o.material)?o.material:[o.material]).forEach((mm,ix)=>{
		if(!mm.emissiveMap) return;
		const pool=/afterburner/i.test(mm.name||"")?burner:glow;
		if(!pool.has(mm)){ const c=mm.clone(); c.userData.glowmax=/^(nose|fuselage|tails)$/i.test(mm.name||"")?4.0:(mm.emissiveIntensity??1); pool.set(mm,c); }   // the formation strips are pale PAINT in the baseColor — at night the off state already reflects moonlight, so the on state must overdrive well past it to read as a powered light under ACES
		if(Array.isArray(o.material)) o.material[ix]=pool.get(mm); else o.material=pool.get(mm);
	}); });
	g.userData.glow=[...glow.values()]; g.userData.burner=[...burner.values()];
	if(spec.cockpitHide){ const hide=[]; m.traverse(o=>{ if(o.name&&spec.cockpitHide.test(o.name)) hide.push(o); });
		g.userData.cockpitHide=hide; }   // first-person set: the pilot's head subtree (visible cascades down, so one node hides head+helmet+visor+mask)
	g.add(m);
	if(g.userData.player){ layer_own_group(g); cockpit_hidden(); }   // the ownship renders in the cockpit pass; re-layer on every model (re)apply
	if(loaded.rig.length){ const mixer=new THREE.AnimationMixer(m); g.userData.gearMixer=mixer;   // per-subsystem scrub actions, driven by state in update_anim()
		g.userData.rig=loaded.rig.map(r=>{
			if(r.node){ const o=m.getObjectByName(r.node); if(!o) return null;
				return { ...r, object:o, quaternion:r.base?new THREE.Quaternion(...r.base):o.quaternion.clone(),
					position:o.position.clone(), transDir:r.trans?new THREE.Vector3(...r.trans).normalize():null }; }   // direct hinge drive from the authored pose (or an explicit clean base); trans entries slide from the rest position
			const a=mixer.clipAction(r.clip); a.play(); a.paused=true; return { ...r, action:a }; }).filter(Boolean); } }
function own_aircraft(){ return MULTIPLAYER ? ((net&&net.welcome&&net.welcome.spawn&&net.welcome.spawn.aircraft)||"fa18c") : (cfg.aircraft||"fa18c"); }   // multiplayer flies what the SERVER spawned; the name still travels on the wire so a second type needs no protocol change
function calibrate_eye(){ const head=ownship.group.getObjectByName("Pilot_Head_769"); if(!head) return;
	ownship.group.updateMatrixWorld(true);
	const p=new THREE.Vector3(); head.getWorldPosition(p);
	ownship.group.worldToLocal(p);
	ownship.group.userData.eye={ x:p.x+0.17, y:p.y+0.17 };   // head origin -> eye offset (y tuned from captures: more world over the glareshield; x moved 7 cm nearer the glass so the canopy bow reads slim, DCS-style, instead of looming); z forced to the centreline by the camera branch
	const pane=ownship.group.getObjectByName("Object_1042");   // the combining glass: the only small transparent pane centred just forward-above the eye line (identified by geometry — the GLB leaves it anonymous)
	let mesh=null; if(pane) pane.traverse(o=>{ if(!mesh&&o.isMesh&&o.geometry) mesh=o; });
	if(mesh){ ownship.group.updateMatrixWorld(true);
		mesh.geometry.computeBoundingBox();   // the node's OWN geometry only — setFromObject would sweep in child meshes and fatten the pane
		const box=mesh.geometry.boundingBox;
		const lo=new THREE.Vector3(Infinity,Infinity,Infinity), hi=new THREE.Vector3(-Infinity,-Infinity,-Infinity), c=new THREE.Vector3();
		for(let k=0;k<8;k++){ c.set(k&1?box.max.x:box.min.x, k&2?box.max.y:box.min.y, k&4?box.max.z:box.min.z);
			c.applyMatrix4(mesh.matrixWorld); ownship.group.worldToLocal(c); lo.min(c); hi.max(c); }
		ownship.group.userData.glass={ x:(lo.x+hi.x)/2, y:(lo.y+hi.y)/2, hw:(hi.z-lo.z)/2, hh:(hi.y-lo.y)/2 };   // body-frame pane: x fore-aft, y up, half-extents across the span and vertically
		// The pane's OUTLINE, not its box: the combining glass is an octagon
		// with sloped upper corners, and a rectangular clip lets symbology
		// float on sky at those corners (#16). Convex-hull the pane's own
		// vertices in the span/height plane, pre-clipped at the visible glass
		// line (the mesh runs down behind the glareshield, where a 2D overlay
		// cannot be occluded by geometry).
		{ const pos=mesh.geometry.attributes.position, pts=[];
			for(let k=0;k<pos.count;k++){ c.set(pos.getX(k),pos.getY(k),pos.getZ(k));
				c.applyMatrix4(mesh.matrixWorld); ownship.group.worldToLocal(c); pts.push([c.z,c.y,c.x]); }
			pts.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
			const cross=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]);
			const half=(list)=>{ const out=[]; for(const p of list){
				while(out.length>1&&cross(out[out.length-2],out[out.length-1],p)<=0) out.pop(); out.push(p); } return out; };
			const lower=half(pts), upper=half(pts.slice().reverse());
			const hull=lower.slice(0,-1).concat(upper.slice(0,-1));
			const floor=ownship.group.userData.glass.y-ownship.group.userData.glass.hh*0.42;   // the visible glass line — same raise glass_rect always applied
			const clipped=[];
			for(let k=0;k<hull.length;k++){ const a=hull[k], b=hull[(k+1)%hull.length];
				if(a[1]>=floor) clipped.push(a);
				if((a[1]>=floor)!==(b[1]>=floor)){ const f=(floor-a[1])/(b[1]-a[1]);
					clipped.push([a[0]+(b[0]-a[0])*f, floor, a[2]+(b[2]-a[2])*f]); } }
			if(clipped.length>=3) ownship.group.userData.outline=clipped; } }   // [z, y, x] per hull vertex, group frame
	try{ build_indexer(ownship.group); }catch(e){ build_error=String(e&&e.message||e); }
	console.warn("cockpit eye", ownship.group.userData.eye.x.toFixed(2), ownship.group.userData.eye.y.toFixed(2)); }
// AoA indexer (#99): the GLB ships the brightness knob but no indexer lights, so
// three unlit emissive shapes stand in, mounted beside the combining glass —
// green chevron (slow), amber donut (on-speed), red chevron (fast), Navy
// colours. Driven from alpha in update_gauges; lit only with the gear down,
// like the real box. Unlit material so it reads at night, LAYER_OWN so only
// the cockpit pass pays for it.
function build_indexer(g){
	if(g.userData.indexer&&g.userData.indexerGroup&&g.userData.indexerGroup.parent===g) return;
	const glass=g.userData.glass, eye=g.userData.eye;
	if(!glass||!eye) return;
	const box=new THREE.Group();
	const mat=c=>new THREE.MeshBasicMaterial({ color:c, transparent:true, opacity:0, side:THREE.DoubleSide, depthWrite:false });
	const chevron=(down)=>{ const sh=new THREE.Shape();   // a V of thickness t, apex on the centreline, pointing at the donut
		const w=0.0065, h=0.004, t=0.0021, dir=down?-1:1;   // sized to the modeled unit's own lamp apertures — the old doubled sizes read as cartoons drawn over the lamps once the stack mounted ON the unit
		sh.moveTo(-w,dir*(h+t)); sh.lineTo(0,dir*t); sh.lineTo(w,dir*(h+t)); sh.lineTo(w,dir*h); sh.lineTo(0,0); sh.lineTo(-w,dir*h);
		sh.closePath(); return new THREE.ShapeGeometry(sh); };
	const parts={ slow:mat(0x2fd24a), donut:mat(0xffb03a), fast:mat(0xe23b2e) };
	const geoms=[ chevron(false), new THREE.RingGeometry(0.0026,0.0046,24), chevron(true) ];   // chevrons point AT the donut: green slow (top) apex-down, red fast (bottom) apex-up — the first cut had them mirrored
	["slow","donut","fast"].forEach((k,i)=>{ const m=new THREE.Mesh(geoms[i],parts[k]);
		m.rotateY(Math.PI/2);   // face the shapes aft toward the pilot (DoubleSide covers the sign)
		m.position.set(0,0.012-0.012*i,0); m.layers.set(LAYER_OWN); box.add(m); });   // 12 mm rows, the unit's own lamp pitch
	let iy=glass.y-glass.hh*0.35, edge=-(glass.hw-0.008), depth=glass.x-0.055;   // pane box conventions — pre-outline fallback
	if(g.userData.outline){   // calibrated model: mount ON the modeled indexer unit (#16), whose position the pilot measured by panel click — tucked at the glass's lower-left against the frame, almost masked from boresight like the real unit, which is exactly why it is a bright-lamp instrument. A straight-aft ray finds the unit's face depth regardless of what the boresight eye sees.
		const shown=(o)=>{ let n=o; while(n){ if(n.visible===false) return false; n=n.parent; } return true; };   // the hidden pilot head raycasts like anything else
		const eye=g.userData.eye, rc=new THREE.Raycaster(); rc.layers.mask=-1; rc.far=3;
		const IY=0.586, IZ=-0.105;   // raised off the pilot's clicked point: the shelf under the unit cut the stack at ~0.566, half-sinking the donut and hiding the fast chevron entirely
		const origin=g.localToWorld(new THREE.Vector3(eye.x,IY,IZ));
		const aim=g.localToWorld(new THREE.Vector3(eye.x+1,IY,IZ)).sub(origin).normalize();
		rc.set(origin,aim);
		const h=rc.intersectObject(g,true).find(k=>!k.object.userData.overlay&&shown(k.object));
		if(h){ const p=g.worldToLocal(h.point.clone());
			iy=IY; depth=p.x-0.006; edge=IZ; } }   // 6 mm proud of the unit's face
	box.position.set(depth, iy, edge);
	if(INDEXER_TEST==="2"){ for(const k of ["slow","donut","fast"]) parts[k].depthTest=false; box.traverse(o=>{ o.renderOrder=999; }); }
	g.add(box); g.userData.indexer=parts; g.userData.indexerGroup=box;
	build_lamps(g);
	build_radalt(g); build_screens(g); }
// Cockpit lamps (#99 realism): the GLB models no annunciators, so the indexer's
// unlit-quad pattern extends to the fire/caution row on the glareshield and the
// gear lights beside the handle. All state the lamps need already exists.
function build_lamps(g){
	if(g.userData.lamps&&g.userData.lampsGroup&&g.userData.lampsGroup.parent===g) return;
	const glass=g.userData.glass; if(!glass) return;
	const lamp=(c,w,h)=>new THREE.Mesh(new THREE.PlaneGeometry(w||0.016,h||0.009),
		new THREE.MeshBasicMaterial({ color:c, transparent:true, opacity:0, side:THREE.DoubleSide, depthWrite:false }));
	const lamps={};
	const brow=new THREE.Group();
	lamps.fireL=lamp(0xe23b2e); lamps.fireL.position.set(0,0,-0.075);
	lamps.caution=lamp(0xffc23a); lamps.caution.position.set(0,-0.004,0);
	lamps.fireR=lamp(0xe23b2e); lamps.fireR.position.set(0,0,0.075);
	brow.add(lamps.fireL,lamps.caution,lamps.fireR);
	brow.position.set(glass.x-0.03, glass.y-glass.hh-0.035, 0);
	brow.children.forEach(m=>{ m.rotateY(Math.PI/2); m.layers.set(LAYER_OWN); });
	g.add(brow);
	const handle=g.getObjectByName("Gear_handle_483"); const gear=new THREE.Group();
	if(handle){ const p=new THREE.Vector3(); handle.getWorldPosition(p); g.worldToLocal(p);
		lamps.transit=lamp(0xe23b2e,0.011,0.011); lamps.transit.position.set(0,0.045,0);   // the lollipop: red while the gear travels
		lamps.nose=lamp(0x2fd24a,0.010,0.008); lamps.nose.position.set(0,0.022,0);
		lamps.left=lamp(0x2fd24a,0.010,0.008); lamps.left.position.set(0,0.008,-0.009);
		lamps.right=lamp(0x2fd24a,0.010,0.008); lamps.right.position.set(0,0.008,0.009);
		gear.add(lamps.transit,lamps.nose,lamps.left,lamps.right);
		gear.position.copy(p); gear.position.x-=0.02; gear.position.z+=0.02;   // just inboard of the handle, proud of its panel
		gear.children.forEach(m=>{ m.rotateY(Math.PI/2); m.layers.set(LAYER_OWN); }); g.add(gear); }
	g.userData.lamps=lamps; g.userData.lampsGroup=brow; }
function lamps_update(out){
	const l=ownship.group.userData.lamps; if(!l) return;
	const ext=out[STATE.extension]||0, harmL=out[STATE.engine_harm]||0, harmR=out[STATE.engine_harm+1]||0;
	const fuel=(out[STATE.fuel]||0)*2.2046, leak=Math.max(out[STATE.leak]||0, own_leak);
	// The FIRE warnings read FIRE, not thrust loss (#40): three cannon hits on a
	// turbine reach full harm with nothing alight, and the red light is the most
	// action-forcing cue in the cockpit — it must not cry wolf.
	l.fireL.material.opacity=(own_burn[0]>0||own_burning)?1:0; l.fireR.material.opacity=(own_burn[1]>0||own_burning)?1:0;
	l.caution.material.opacity=caution_lamp?1:0;   // the latched MASTER CAUTION (#47) — its OWN conditions disagreed with the stack (a pounds/kg mix left FUEL LO dark)
	if(l.transit){ const moving=ext>0.02&&ext<0.98;
		l.transit.material.opacity=moving?1:0;
		const green=ext>0.98?1:0; l.nose.material.opacity=green; l.left.material.opacity=green; l.right.material.opacity=green; }
	const r=ownship.group.userData.radalt;
	if(r){ const now=performance.now(); if(now-r.last>250){ r.last=now;
		const surface=ground_height(ownship.pos.x,ownship.pos.z);
		radalt_draw(r, ownship.pos.y-(surface>-1e8?surface:0)); } } }
// Radar altimeter (#99 realism): the modeled gauge has its needle and OFF flag
// painted into the face texture, so a live canvas disc covers it — APN-194
// style dial measured from that face, needle below 5000 ft, OFF flag above.
const RADALT_DIAL=[[0,35],[100,52],[200,70],[300,103],[400,149],[600,202],[800,235],[1000,280],[3000,305],[5000,325]];
// node_box: the node's own geometry corners in the GROUP frame (the pattern
// calibrate_eye uses for the glass pane). A world Box3 tilts with the parked
// heading, and its centre sits inside the housing DEPTH — placing "proud"
// quads from that centre buried them behind the painted faces, which is what
// kept these builders parked.
function node_box(g,node){
	const lo=new THREE.Vector3(Infinity,Infinity,Infinity), hi=new THREE.Vector3(-Infinity,-Infinity,-Infinity), c=new THREE.Vector3(); let any=false;
	node.traverse(o=>{ if(!o.isMesh||!o.geometry) return; any=true;
		o.geometry.computeBoundingBox(); const b=o.geometry.boundingBox;
		for(let k=0;k<8;k++){ c.set(k&1?b.max.x:b.min.x, k&2?b.max.y:b.min.y, k&4?b.max.z:b.min.z);
			c.applyMatrix4(o.matrixWorld); g.worldToLocal(c); lo.min(c); hi.max(c); } });
	return any?{lo,hi}:null; }
// surface_fit: the surface the pilot actually SEES over an aperture, by
// raycast from the calibrated eye. The named screen/gauge nodes are the
// recessed plates; each sits behind a smoked cover glass in a DIFFERENT node
// — opaque black, nearer the eye — so a quad placed off the plate loses the
// depth test to the cover and renders buried (what parked these builders).
// Three rays (top/centre/bottom of the aperture) give the cover's x and the
// panel's lean; overlays go just proud of THAT, tilted to match.
function surface_fit(g,box){
	const eye=g.userData.eye; if(!eye) return null;
	const cy=(box.lo.y+box.hi.y)/2, cz=(box.lo.z+box.hi.z)/2, hh=Math.max((box.hi.y-box.lo.y)/2,0.02);
	const rc=new THREE.Raycaster(); rc.layers.mask=-1; rc.far=3;
	const eyeW=g.localToWorld(new THREE.Vector3(eye.x,eye.y,0));
	let cover=null;
	const probe=(y)=>{ const pW=g.localToWorld(new THREE.Vector3(box.lo.x,y,cz));
		rc.set(eyeW,pW.sub(eyeW).normalize());
		for(const h of rc.intersectObject(g,true)){ if(h.object.userData.overlay) continue;
			const p=g.worldToLocal(h.point.clone());
			if(p.x>=box.lo.x-0.12&&p.x<=box.hi.x+0.02){ cover=cover||h.object; return p.x; } }   // the full-panel smoked cover sits up to ~9 cm proud of the recessed plates; hits nearer still (stick, levers) are REAL occluders — the overlay belongs behind them
		return null; };
	const xm=probe(cy); if(xm==null) return null;
	const xt=probe(cy+hh*0.8)??xm, xb=probe(cy-hh*0.8)??xm;
	const pW=g.localToWorld(new THREE.Vector3(box.lo.x,cy,cz)); rc.set(eyeW,pW.sub(eyeW).normalize());   // diagnostic: the full surface stack on the centre sightline
	const stack=rc.intersectObject(g,true).slice(0,8).map(h=>{ const p=g.worldToLocal(h.point.clone());
		return +p.x.toFixed(3)+" "+(h.object.name||h.object.type)+"/"+(((h.object as THREE.Mesh).material as THREE.Material&{name?:string})?.name||"?"); });
	return { x:xm, tilt:Math.atan2(xt-xb,1.6*hh), stack, cover }; }
// (Two placement refinements were tried against captures and refuted: sliding
// and scaling the quad along the eye sightline to subtend the recessed plate
// put it visibly OFF the bezel outline, and hunting the cover glass for a
// per-screen pane sub-mesh found none — the cover is one merged mesh. The
// seated placement, measured against grid-overlaid captures, is the plate
// box's own y/z at the fitted cover surface, with a few millimetres of
// hand-measured bias below.)
// surface_pose orients a +Z-facing geometry onto the fitted surface at the
// given centre: width along the span, height up the measured lean, normal out
// toward the pilot. The centre comes from aperture_fit (the visible opening),
// never slid or scaled — the frame the pilot aligns against lives at the
// cover depth, so projecting the recessed plate toward the eye lands the
// overlay OFF the frame (the misalignment the first fit shipped).
function surface_pose(mesh,x,tilt,cy,cz){
	const X=new THREE.Vector3(0,0,1), Y=new THREE.Vector3(Math.sin(tilt),Math.cos(tilt),0), N=new THREE.Vector3().crossVectors(X,Y);
	mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(X,Y,N));
	mesh.position.set(x,cy,cz).addScaledVector(N,0.003);
	mesh.userData.overlay=true; mesh.layers.set(LAYER_OWN); }
function build_radalt(g){
	if(g.userData.radalt&&g.userData.radalt.mesh.parent) return;
	// The GLB has no radar-altimeter face node — the Object_1372 this builder
	// originally covered turned out to be the full-panel cover glass. The dial's
	// position was measured by a panel click (&panelpoint=1): top-centre of the
	// main panel just under the glareshield. &radalt=y,z (dev) still overrides
	// for recalibration.
	const at=DEV_MODE&&new URLSearchParams(location.search).get("radalt");
	const [y,z]=at?at.split(",").map(Number):[0.535,0.011];
	if(!isFinite(y)||!isFinite(z)) return;
	const box={ lo:new THREE.Vector3(6.20,y-0.04,z-0.04), hi:new THREE.Vector3(6.25,y+0.04,z+0.04) };
	const canvas=document.createElement("canvas"); canvas.width=canvas.height=160;
	const tex=new THREE.CanvasTexture(canvas); tex.minFilter=THREE.LinearFilter; tex.generateMipmaps=false;
	const mesh=new THREE.Mesh(new THREE.CircleGeometry(0.023,36),   // sized to the right cluster's small-gauge aperture (~6 cm pitch), not the imagined big face the bogus anchor implied
		new THREE.MeshBasicMaterial({ map:tex, side:THREE.DoubleSide, toneMapped:false }));
	const fit=surface_fit(g,box);
	surface_pose(mesh,fit?fit.x:box.lo.x,fit?fit.tilt:0,(box.lo.y+box.hi.y)/2,(box.lo.z+box.hi.z)/2);
	g.add(mesh);
	g.userData.radalt={ mesh, canvas, tex, last:0 };
	radalt_draw(g.userData.radalt, 1e9); }
function radalt_draw(r, agl){
	const x=r.canvas.getContext("2d"), W=160, C=80;
	x.fillStyle="#101210"; x.fillRect(0,0,W,W);
	x.strokeStyle="#d8d8d0"; x.fillStyle="#d8d8d0"; x.lineWidth=2;
	x.font="16px monospace"; x.textAlign="center"; x.textBaseline="middle";
	for(const [ft,deg] of RADALT_DIAL){ if(!ft) continue;
		const a=(deg-90)*D2R, inner=ft<=1000&&ft%200===0||ft>=3000;
		x.beginPath(); x.moveTo(C+Math.cos(a)*66,C+Math.sin(a)*66); x.lineTo(C+Math.cos(a)*58,C+Math.sin(a)*58); x.stroke();
		if(inner) x.fillText(String(ft/100),C+Math.cos(a)*46,C+Math.sin(a)*46); }
	x.font="9px monospace"; x.fillText("RADAR ALT",C,C-22); x.fillText("X100 FT",C,C+24);
	{ const a=(dial(RADALT_DIAL,250)/D2R-90)*D2R;   // the low-altitude index bug at 250 ft (#47, NATOPS 2.12.5.4.4)
		x.fillStyle="#e8c832"; x.beginPath();
		x.moveTo(C+Math.cos(a)*70,C+Math.sin(a)*70); x.lineTo(C+Math.cos(a-0.08)*58,C+Math.sin(a-0.08)*58); x.lineTo(C+Math.cos(a+0.08)*58,C+Math.sin(a+0.08)*58); x.closePath(); x.fill();
		x.fillStyle="#d8d8d0"; }
	const off=agl>5000;
	if(off){ x.fillStyle="#a02020"; x.fillRect(C-18,C+34,36,14); x.fillStyle="#fff"; x.font="10px monospace"; x.fillText("OFF",C,C+41); }
	else{ const ang=(dial(RADALT_DIAL,Math.max(0,agl))/D2R-90)*D2R;
		if(agl<250){ x.fillStyle="#c02020"; x.beginPath(); x.arc(C+30,C-30,7,0,7); x.fill(); x.fillStyle="#d8d8d0"; }   // the red LOW warning lamp on the gauge (#47, NATOPS 2.12.5.4.3)
		x.strokeStyle="#f0f0e8"; x.lineWidth=4;
		x.beginPath(); x.moveTo(C-Math.cos(ang)*10,C-Math.sin(ang)*10); x.lineTo(C+Math.cos(ang)*54,C+Math.sin(ang)*54); x.stroke(); }
	r.tex.needsUpdate=true; }
// DDI/AMPCD screens (#99): the three screen meshes exist in the GLB but are
// bare dark glass; each gets a canvas quad proud of its pane, drawn by the
// shared page renderers below. left/right are the monochrome DDIs, center the
// colour-capable AMPCD.
function build_screens(g){
	if(g.userData.screens&&g.userData.screens.every(sc=>sc.mesh.parent)) return;
	const spec=[ ["Object_1045","left"], ["Object_1048","right"], ["Object_1051","center"] ];
	const list=[];
	for(const [name,display] of spec){ const node=g.getObjectByName(name); if(!node) continue;
		const box=node_box(g,node); if(!box) continue;
		const fit=surface_fit(g,box);
		const tilt=fit?fit.tilt:0;
		const cy=(box.lo.y+box.hi.y)/2+0.002, cz=(box.lo.z+box.hi.z)/2-0.002;   // the recess reads a hair up-left of the plate box in grid captures
		const w=(box.hi.z-box.lo.z)*0.92, h=(box.hi.y-box.lo.y)*0.92/Math.cos(tilt);
		const canvas=document.createElement("canvas"); canvas.width=canvas.height=512;
		const tex=new THREE.CanvasTexture(canvas); tex.minFilter=THREE.LinearFilter; tex.generateMipmaps=false;   // the default filter would REGENERATE mipmaps on every upload
		const flat=DEV_MODE&&new URLSearchParams(location.search).get("ddiflat");   // &ddiflat=1: untextured magenta quads — separates a mesh-render problem from a texture problem
		const mesh=new THREE.Mesh(new THREE.PlaneGeometry(w,h),
			flat?new THREE.MeshBasicMaterial({ color:0xff00ff, side:THREE.DoubleSide })
			:new THREE.MeshBasicMaterial({ map:tex, toneMapped:false, side:THREE.DoubleSide }));
		surface_pose(mesh,fit?fit.x:box.lo.x,tilt,cy,cz);
		g.add(mesh);
		list.push({ mesh, canvas, tex, display, height:h, fit:fit?[+fit.x.toFixed(3),+(tilt/D2R).toFixed(1)]:null, stack:fit?fit.stack:null,
			box:[box.lo.x,box.lo.y,box.lo.z,box.hi.x,box.hi.y,box.hi.z].map(n=>+n.toFixed(3)) }); }
	if(DEV_MODE) (globalThis as Record<string,unknown>).ddi_geometry=list.map(sc=>({ display:sc.display, at:sc.mesh.position.toArray().map(n=>+(n as number).toFixed(3)), box:sc.box }));   // placement diagnostics that survive dev_probe churn
	if(list.length){ g.userData.screens=list; for(const sc of list) ddi_blit(sc); } }
// ---- DDI/AMPCD paging (#99): per-display page state drawn by size-agnostic
// renderers in a 512-logical space — every consumer (the pit quads now; the
// full-screen DDI view and HUD repeater later) scales the same draw onto its
// own canvas at its own resolution. Twenty pushbuttons ring each display (1-5
// up the left, 6-10 across the top, 11-15 down the right, 16-20 across the
// bottom right to left); MENU lives at PB18 and alternates the TAC and SUPT
// menus, like the real jet. Legends are cockpit verbatim — English by the
// annunciator policy. Menu entries whose page has no backing system yet draw
// dim and inert, never faked.
const ddi_state={ left:{page:"eng",menu:""}, right:{page:"adi",menu:""}, center:{page:"hsi",menu:""} };
// Master-mode display recall (#15): the real avionics remember a display
// configuration PER MASTER MODE and restore it when the mode is selected —
// there is no per-mission-phase page card in NATOPS. Families: A/A (gun and
// 9m share one, as in the jet) and NAV. Seeds are fleet convention minus the
// radar we don't model: A/A = SMS/SA/HSI, NAV = CHKLST/FUEL/HSI (recovery
//-case starts pre-set NAV's right display to ADI — the pilot would have
// configured for the approach). Page selections record into the CURRENT
// family, so a switch away and back restores what you had.
const ddi_sets={ aa:{left:"sms",right:"sa",center:"hsi"}, nav:{left:"chklst",right:"fuel",center:"hsi"} };
function ddi_family(){ return master==="nav"?"nav":"aa"; }
function ddi_recall(){ const set=ddi_sets[ddi_family()]; for(const d of ["left","right","center"]) ddi_state[d]={ page:set[d], menu:"" }; ddi_dirty=true; }
function ddi_show(display,page){ ddi_state[display]={ page, menu:"" }; ddi_sets[ddi_family()][display]=page; ddi_dirty=true; }
function set_master(m){ const before=ddi_family(); master=m; if(ddi_family()!==before) ddi_recall(); }
let ddi_dirty=false;   // a pushbutton press redraws NOW — the 120 ms cadence would read as a stuck button
const DDI_MENUS={   // [pushbutton, legend, page] — page "" = not built yet
	tac:[ [6,"HUD","hud"],[7,"RDR",""],[8,"SA","sa"],[9,"SMS","sms"],[10,"EW","ew"] ],
	supt:[ [6,"ADI","adi"],[7,"HSI","hsi"],[8,"ENG","eng"],[9,"FUEL","fuel"],[10,"FCS","fcs"],[11,"CHKLST","chklst"],[12,"FPAS","fpas"],[13,"BIT",""],[14,"MUMI",""] ] };
function button_of(lx,ly){   // 512-space point -> pushbutton number, 0 between slots (five 80 px slots along the 56..456 span of each edge)
	const slot=v=>{ const k=Math.floor((v-56)/80); return k>=0&&k<5?k:-1; };
	if(ly<56){ const k=slot(lx); return k<0?0:6+k; }
	if(lx>456){ const k=slot(ly); return k<0?0:11+k; }
	if(ly>456){ const k=slot(lx); return k<0?0:20-k; }
	if(lx<56){ const k=slot(ly); return k<0?0:5-k; }
	return 0; }
function ddi_legend(x,pb,text,on,current){   // on=false: dim, inert; current: boxed
	x.save(); x.font="20px monospace"; x.textBaseline="middle"; x.globalAlpha=on?1:0.4;
	let tx=0,ty=0;
	if(pb<=5){ x.textAlign="left"; tx=10; ty=96+80*(5-pb); }
	else if(pb<=10){ x.textAlign="center"; tx=96+80*(pb-6); ty=30; }
	else if(pb<=15){ x.textAlign="right"; tx=502; ty=96+80*(pb-11); }
	else { x.textAlign="center"; tx=96+80*(20-pb); ty=482; }
	x.fillText(text,tx,ty);
	if(current){ const w=x.measureText(text).width;
		const bx=x.textAlign==="left"?tx:x.textAlign==="right"?tx-w:tx-w/2;
		x.strokeRect(bx-6,ty-14,w+12,28); }
	x.restore(); }
function ddi_press(display,pb){   // true when the press did something (consumes the click)
	const st=ddi_state[display]; if(!st||!pb) return false;
	if(pb===18){ st.menu=st.menu==="tac"?"supt":"tac"; ddi_dirty=true; return true; }   // MENU alternates the two menus
	if(st.menu){ const row=DDI_MENUS[st.menu].find(r=>r[0]===pb);
		if(row&&row[2]){ ddi_show(display,row[2]); } return !!(row&&row[2]); }   // menu picks record into the master mode's set (#15)
	const p=DDI_PAGES[st.page];
	if(p&&p.press&&p.press(pb,display)){ ddi_dirty=true; return true; }   // page-owned pushbuttons
	return false; }
function ddi_render(x,size,display){   // size-agnostic: draws the display's current face into ANY square canvas
	const s=size/512; x.setTransform(s,0,0,s,0,0);
	x.globalAlpha=1; x.fillStyle="#050b06"; x.fillRect(0,0,512,512);
	x.strokeStyle="#39e07a"; x.fillStyle="#39e07a"; x.lineWidth=2; x.font="26px monospace"; x.textAlign="center"; x.textBaseline="middle";
	const st=ddi_state[display];
	if(st.menu){ x.fillText(st.menu==="tac"?"TAC":"SUPT",256,256);
		for(const [pb,label,page] of DDI_MENUS[st.menu]) ddi_legend(x,pb,label,!!page,!!page&&page===st.page); }
	else{ const p=DDI_PAGES[st.page]; if(p) p.draw(x,display); }
	ddi_legend(x,18,"MENU",true,!!st.menu); }
function ddi_blit(sc){ const x=sc.canvas.getContext("2d"); ddi_render(x,sc.canvas.width,sc.display); sc.tex.needsUpdate=true; }
const DDI_STEPS=[256,512,1024];
const _sv1=new THREE.Vector3(), _sv2=new THREE.Vector3();
let screens_last=0;
let repeat="";   // HUD-view corner repeater (#12): "" off, else the display it shows
function repeat_size(){ return Math.round(Math.min(HW,HH)*0.30); }
function screens_update(){
	const list=ownship.group.userData.screens; if(!list) return;
	const pit=cfg.view==="cockpit", rep=(cfg.view==="hud"&&!map_on)?repeat:"";
	if(!pit&&!rep) return;   // pages redraw only while some consumer is on screen
	const now=performance.now(); if(!ddi_dirty&&now-screens_last<120) return; screens_last=now; ddi_dirty=false;
	const dpr=Math.min(devicePixelRatio||1,2);
	for(const sc of list){
		if(!pit&&sc.display!==rep) continue;   // repeating: only the shown display spends
		// variable resolution: the canvas follows the consumer — the quad's
		// projected on-screen height in the pit (stepped, with hysteresis
		// against zoom flutter), the panel's size when repeating
		let px;
		if(pit){ _sv1.set(0,sc.height/2,0).applyMatrix4(sc.mesh.matrixWorld).project(cockpit_cam);
			_sv2.set(0,-sc.height/2,0).applyMatrix4(sc.mesh.matrixWorld).project(cockpit_cam);
			px=Math.abs(_sv1.y-_sv2.y)*0.5*HH*dpr; }
		else px=repeat_size()*dpr;
		const cur=sc.canvas.width;
		if(px>cur*1.15||px<cur*0.45){ const want=DDI_STEPS.find(v=>v>=px)||1024;
			if(want!==cur){ sc.canvas.width=sc.canvas.height=want;
				sc.tex.dispose(); } }   // WebGL2 canvas textures get immutable texStorage2D storage at first upload; without a dispose a resized canvas texSubImage2Ds into one corner of the old allocation and the rest of the face keeps stale texels
		ddi_blit(sc); } }
// Pages may declare optional handlers beyond draw: press(pb,display) for
// page-owned bezel buttons, and range(direction)/reset() which the DDI view
// routes the wheel, −/= and 0 into (wheel-up = range in, the map's wheel
// semantics; 0 puts the page's transient state back to defaults).
const DDI_PAGES={ eng:{draw:ddi_eng}, adi:{draw:ddi_adi}, hsi:{draw:ddi_hsi,range:hsi_range,reset:hsi_reset,press:hsi_press},
	sa:{draw:ddi_sa,range:sa_range,reset:sa_reset,press:sa_press}, hud:{draw:ddi_hud},
	fuel:{draw:ddi_fuel,press:fuel_press}, fcs:{draw:ddi_fcs}, chklst:{draw:ddi_chklst}, ew:{draw:ddi_ew}, sms:{draw:ddi_sms}, fpas:{draw:ddi_fpas} };
// ---- HSI page state (#99 pages): ONE nav picture shared by every display
// showing the format, like the jet's single nav solution. The rose ring sits
// at HALF the selected scale; DCTR slides the rose down so the scale ahead
// grows; the TAMMAC-style map underlay is AMPCD-only (the DDIs are monochrome
// and map-less in the real jet).
const HSI_SCALES=[5,10,20,40,80,160];
const hsi_state={ scale:40, dctr:false, map:true };
function hsi_range(direction){ const i=HSI_SCALES.indexOf(hsi_state.scale);
	hsi_state.scale=HSI_SCALES[THREE.MathUtils.clamp(i-Math.sign(direction),0,HSI_SCALES.length-1)]; }   // zoom-in steps the scale DOWN
function hsi_reset(){ hsi_state.scale=40; }   // 0: range to default — DCTR and MAP are pilot layout choices and stay
function hsi_press(pb,display){
	if(pb===4){ hsi_range(-1); return true; }   // ↑ scale out
	if(pb===3){ hsi_range(1); return true; }    // ↓ scale in
	if(pb===9){ hsi_state.dctr=!hsi_state.dctr; return true; }
	if(pb===6&&display==="center"){ hsi_state.map=!hsi_state.map; return true; }
	return false; }
// ---- SA page state (#99 pages): the datalink-style tactical picture, its own
// scale independent of the HSI's. It shows exactly what the client already
// knows — the SP bandit, MP remotes, the boat — never sensor truth the server
// does not provide (the tactical map is the ceiling on its information).
const sa_state={ scale:20 };
function sa_range(direction){ const i=HSI_SCALES.indexOf(sa_state.scale);
	sa_state.scale=HSI_SCALES[THREE.MathUtils.clamp(i-Math.sign(direction),0,HSI_SCALES.length-1)]; }
function sa_reset(){ sa_state.scale=20; }
function sa_press(pb){
	if(pb===4){ sa_range(-1); return true; }
	if(pb===3){ sa_range(1); return true; }
	return false; }
function ddi_eng(x){ const gz=ownship.gauges||{};   // the real format: parameter names down the CENTRE, engine values either side
	x.fillText("ENG",256,36);
	x.font="22px monospace";
	const rows=[["N2 %",gz.rpmL,gz.rpmR,1],["EGT °C",gz.egtL,gz.egtR,1],["FF PPH",(gz.flowL||0)*10,(gz.flowR||0)*10,10],
		["NOZ %",100*Math.max((0.7-(gz.spoolL||0))/0.55,gz.reheatL||0),100*Math.max((0.7-(gz.spoolR||0))/0.55,gz.reheatR||0),1],
		["OIL PSI",55+45*(gz.spoolL||0),55+45*(gz.spoolR||0),1]];   // 55 idle to 100 at MIL: the -402 inflight bands are 55-110 idle and 95-180 MIL (NATOPS 4.1.1.4). It swept 55-65, below the MIL minimum at every power setting (#49)
	x.textAlign="center"; x.fillText("L",150,84); x.fillText("R",362,84);
	let y=140;
	for(const [label,L,R,q] of rows){
		x.textAlign="center"; x.font="19px monospace"; x.fillText(label,256,y);
		x.font="22px monospace"; x.textAlign="right";
		x.fillText(String(Math.round((L||0)/q)*q),192,y); x.fillText(String(Math.round((R||0)/q)*q),404,y);
		y+=62; } }   // the fuel total lives on the FUEL page now
function ddi_adi(x,display){ const gz=ownship.gauges||{}; const bank=gz.bank||0, pitch=gz.pitch||0, ppd=5.2;
	const colour=display==="center";   // the AMPCD's colour licence; the DDIs shade the ball in green
	const cx=256, cy=246, R=186;
	x.save(); x.beginPath(); x.arc(cx,cy,R,0,Math.PI*2); x.clip();   // the attitude BALL, not a full-screen wash
	x.translate(cx,cy); x.rotate(-bank);
	const off=pitch/D2R*ppd;
	x.fillStyle=colour?"#123a5e":"#12351f"; x.fillRect(-280,-280+off,560,280);   // sky
	x.fillStyle=colour?"#4a3a20":"#050b06"; x.fillRect(-280,off,560,280);        // ground
	x.strokeStyle=colour?"#e8e8e0":"#39e07a"; x.lineWidth=3;
	x.beginPath(); x.moveTo(-280,off); x.lineTo(280,off); x.stroke();
	x.fillStyle=colour?"#e8e8e0":"#39e07a"; x.font="18px monospace"; x.lineWidth=2;
	for(let d=-30;d<=30;d+=10){ if(!d) continue; const py=off+d*ppd;
		x.beginPath(); x.moveTo(-60,py); x.lineTo(60,py); x.stroke();
		x.textAlign="left"; x.fillText(String(Math.abs(d)),66,py); }
	x.restore();
	x.strokeStyle="#39e07a"; x.lineWidth=2;   // ball rim, bank scale outside the top arc, pointer at the bank angle
	x.beginPath(); x.arc(cx,cy,R,0,Math.PI*2); x.stroke();
	for(const d of [-60,-45,-30,-20,-10,0,10,20,30,45,60]){ const a=-Math.PI/2+d*D2R, i=d===0?16:10;
		x.beginPath(); x.moveTo(cx+Math.cos(a)*R,cy+Math.sin(a)*R); x.lineTo(cx+Math.cos(a)*(R+i),cy+Math.sin(a)*(R+i)); x.stroke(); }
	{ const ba=-Math.PI/2-THREE.MathUtils.clamp(bank,-Math.PI/3,Math.PI/3);
		x.fillStyle="#39e07a";
		x.beginPath(); x.moveTo(cx+Math.cos(ba)*(R-4),cy+Math.sin(ba)*(R-4)); x.lineTo(cx+Math.cos(ba-0.045)*(R-20),cy+Math.sin(ba-0.045)*(R-20)); x.lineTo(cx+Math.cos(ba+0.045)*(R-20),cy+Math.sin(ba+0.045)*(R-20)); x.closePath(); x.fill(); }
	x.strokeStyle="#39e07a"; x.lineWidth=4;   // waterline, fixed
	x.beginPath(); x.moveTo(cx-60,cy); x.lineTo(cx-20,cy); x.lineTo(cx,cy+12); x.lineTo(cx+20,cy); x.lineTo(cx+60,cy); x.stroke();
	const dev=approach_deviation();
	if(dev){ x.strokeStyle=colour?"#ffd24a":"#7dff9f"; x.lineWidth=4;   // ICLS needles ride the ball, as on the real format
		const gs=THREE.MathUtils.clamp(dev.gs,-1,1), az=THREE.MathUtils.clamp(dev.az,-1,1);
		x.beginPath(); x.moveTo(cx-176,cy+gs*120); x.lineTo(cx-116,cy+gs*120); x.stroke();
		x.beginPath(); x.moveTo(cx+az*120,cy+94); x.lineTo(cx+az*120,cy+154); x.stroke(); }
	{ const sy=cy+R-24, s=THREE.MathUtils.clamp(gz.slip||0,-1,1)*26;   // slip ball in the lower ball area
		x.strokeStyle="#39e07a"; x.lineWidth=2;
		x.beginPath(); x.moveTo(cx-44,sy); x.lineTo(cx+44,sy); x.stroke();
		x.beginPath(); x.moveTo(cx-12,sy-10); x.lineTo(cx-12,sy+10); x.moveTo(cx+12,sy-10); x.lineTo(cx+12,sy+10); x.stroke();
		x.beginPath(); x.arc(cx+s,sy,7,0,Math.PI*2); x.stroke(); } }
function ddi_hsi(x,display){ const gz=ownship.gauges||{}; const hdg=gz.heading||0;
	const scale=hsi_state.scale, cy=hsi_state.dctr?356:266, R=196;
	const ppm=R/(scale*NM/2);   // pixels per metre: the rose ring sits at HALF the selected scale
	// TAMMAC-style underlay, AMPCD only: the same Midway coastline / airport /
	// carrier set the tactical map draws, ownship-centred and heading-up, in
	// muted chart colours so the symbology stays on top of it.
	if(display==="center"&&hsi_state.map){ x.save();
		x.beginPath(); x.arc(256,cy,R+34,0,Math.PI*2); x.clip();
		x.translate(256,cy); x.rotate(-hdg);
		x.fillStyle="#33402f"; x.strokeStyle="#55684e"; x.lineWidth=1.5;
		for(const polygon of island_polygons||[]){ x.beginPath();
			for(let k=0;k<polygon.length;k++){ const sx=wrap_axis(polygon[k][0]-ownship.pos.x)*ppm, sy=wrap_axis(polygon[k][1]-ownship.pos.z)*ppm;
				if(k===0) x.moveTo(sx,sy); else x.lineTo(sx,sy); }
			x.closePath(); x.fill(); x.stroke(); }
		x.strokeStyle="#8a94a0"; x.lineWidth=3;
		for(const ap of airports||[]){ const ax=wrap_axis(ap.x-ownship.pos.x)*ppm, az=wrap_axis(ap.z-ownship.pos.z)*ppm, len=Math.max(4,1300*ppm);
			x.beginPath(); x.moveTo(ax-ap.dir.x*len,az-ap.dir.z*len); x.lineTo(ax+ap.dir.x*len,az+ap.dir.z*len); x.stroke(); }
		{ const kx=wrap_axis(CARRIER.x-ownship.pos.x)*ppm, kz=wrap_axis(CARRIER.z-ownship.pos.z)*ppm;
			x.fillStyle="#ffd27a"; x.fillRect(kx-6,kz-6,12,12); }   // the boat, in the AMPCD's colour licence
		x.restore(); }
	x.fillText(String(Math.round(hdg/D2R+360)%360).padStart(3,"0"),256,30);
	x.save(); x.translate(256,cy);
	x.strokeStyle="rgba(57,224,122,0.45)"; x.lineWidth=1.5;   // rose ring (half scale) and the quarter-scale ring inside it
	x.beginPath(); x.arc(0,0,R,0,Math.PI*2); x.stroke();
	x.strokeStyle="rgba(57,224,122,0.22)";
	x.beginPath(); x.arc(0,0,R/2,0,Math.PI*2); x.stroke();
	x.strokeStyle="#39e07a"; x.fillStyle="#39e07a"; x.lineWidth=2; x.font="20px monospace"; x.textAlign="center";
	for(let d=0;d<360;d+=30){ const a=(d*D2R)-hdg-Math.PI/2;
		const cx=Math.cos(a), cyy=Math.sin(a);
		x.beginPath(); x.moveTo(cx*196,cyy*196); x.lineTo(cx*180,cyy*180); x.stroke();
		x.fillText(d%90===0?"NESW"[d/90]:String(d/10),cx*158,cyy*158); }
	if(gz.track!=null){ const a=gz.track-hdg, tx=Math.sin(a)*R, ty=-Math.cos(a)*R;   // ground-track diamond on the rim — the gap off the lubber line is drift
		x.lineWidth=2.5;
		x.beginPath(); x.moveTo(tx,ty-9); x.lineTo(tx+7,ty); x.lineTo(tx,ty+9); x.lineTo(tx-7,ty); x.closePath(); x.stroke(); }
	const dx=CARRIER.x-ownship.pos.x, dz=CARRIER.z-ownship.pos.z;
	const brg=Math.atan2(dx,-dz), rel=brg-hdg;   // world bearing in the heading convention, relative to the nose
	x.rotate(rel); x.strokeStyle="#ffd24a"; x.lineWidth=5;   // TACAN pointer to the boat
	x.beginPath(); x.moveTo(0,-196); x.lineTo(0,-140); x.stroke();
	x.beginPath(); x.moveTo(-12,-172); x.lineTo(0,-196); x.lineTo(12,-172); x.stroke();
	x.restore();
	x.strokeStyle="#39e07a"; x.lineWidth=3;   // ownship symbol
	x.beginPath(); x.moveTo(256,cy-20); x.lineTo(246,cy+16); x.lineTo(266,cy+16); x.closePath(); x.stroke();
	ddi_legend(x,4,"↑",true,false); ddi_legend(x,3,"↓",true,false);   // range scale arrows, the scale value between them
	x.fillStyle="#39e07a"; x.font="20px monospace"; x.textAlign="left";
	x.fillText(String(scale),14,216);
	if(display==="center") ddi_legend(x,6,"MAP",true,hsi_state.map);
	ddi_legend(x,9,"DCTR",true,hsi_state.dctr);
	if(gz.ground>50) x.fillText("GS "+Math.round(gz.ground),24,64);
	const rngnm=Math.hypot(dx,dz)/NM;   // TACAN block: bearing / range / minutes to the boat at present groundspeed — two short lines in the corner, clear of the MENU legend
	x.font="20px monospace";
	x.fillText("TCN "+String(Math.round(brg/D2R+360)%360).padStart(3,"0"),24,458);
	let tline=rngnm.toFixed(1)+" NM";
	if(gz.ground>50) tline+="  "+Math.max(0,Math.round(rngnm/gz.ground*60))+" MIN";
	x.fillText(tline,24,486); }
function ddi_sa(x,display){ const gz=ownship.gauges||{}; const hdg=gz.heading||0;
	const scale=sa_state.scale, cy=266, R=196, ppm=R/(scale*NM/2);
	const colour=display==="center";   // team colours on the AMPCD; the DDIs stay monochrome green
	x.fillText(String(Math.round(hdg/D2R+360)%360).padStart(3,"0"),256,30);
	x.save(); x.translate(256,cy);
	x.strokeStyle="rgba(57,224,122,0.45)"; x.lineWidth=1.5;   // half- and quarter-scale rings, ticks only — the SA picture stays uncluttered, the HSI owns full nav
	x.beginPath(); x.arc(0,0,R,0,Math.PI*2); x.stroke();
	x.strokeStyle="rgba(57,224,122,0.22)";
	x.beginPath(); x.arc(0,0,R/2,0,Math.PI*2); x.stroke();
	x.strokeStyle="#39e07a"; x.fillStyle="#39e07a"; x.lineWidth=2; x.font="18px monospace"; x.textAlign="center";
	for(let d=0;d<360;d+=30){ const a=(d*D2R)-hdg-Math.PI/2;
		x.beginPath(); x.moveTo(Math.cos(a)*196,Math.sin(a)*196); x.lineTo(Math.cos(a)*184,Math.sin(a)*184); x.stroke();
		if(d===0) x.fillText("N",Math.cos(a)*166,Math.sin(a)*166+6); }
	x.rotate(-hdg);   // heading-up frame: contacts draw at their north-up offsets
	const jet=(wx,wz,fx,fz,c,label)=>{ const dx=wrap_axis(wx-ownship.pos.x)*ppm, dz=wrap_axis(wz-ownship.pos.z)*ppm;
		if(Math.hypot(dx,dz)>R+14) return;   // outside the scale: not shown, like the real format
		const fl=Math.hypot(fx,fz)||1, ux=fx/fl, uz=fz/fl, rx=-uz, rz=ux;
		x.fillStyle=c; x.beginPath();
		x.moveTo(dx+ux*11,dz+uz*11); x.lineTo(dx-ux*7+rx*6,dz-uz*7+rz*6); x.lineTo(dx-ux*7-rx*6,dz-uz*7-rz*6); x.closePath(); x.fill();
		if(label){ x.save(); x.translate(dx,dz); x.rotate(hdg); x.font="14px monospace"; x.fillText(label,0,24); x.restore(); } };   // labels unrotate to stay upright
	{ const kx=wrap_axis(CARRIER.x-ownship.pos.x)*ppm, kz=wrap_axis(CARRIER.z-ownship.pos.z)*ppm;   // the boat
		if(Math.hypot(kx,kz)<=R+14){ x.fillStyle=colour?"#ffd27a":"#39e07a"; x.fillRect(kx-5,kz-5,10,10); } }
	if(MULTIPLAYER&&net){ for(const [slot,st] of remotes.entries()){ if(!st.group||!st.group.visible) continue;
			const team=net.teams.get(slot)||"";
			jet(st.pos.x,st.pos.z,st.fwd.x,st.fwd.z,colour?(team==="red"?"#ff5a48":team==="blue"?"#5a86ff":"#ffb04a"):"#39e07a",st.name||net.names.get(slot)||""); } }
	else if(has_enemy&&bandit.group.visible) jet(bandit.pos.x,bandit.pos.z,bandit.fwd.x,bandit.fwd.z,colour?"#ffb04a":"#39e07a","");
	x.restore();
	x.strokeStyle=colour?"#ffffff":"#39e07a"; x.lineWidth=3;   // ownship
	x.beginPath(); x.moveTo(256,cy-14); x.lineTo(248,cy+12); x.lineTo(264,cy+12); x.closePath(); x.stroke();
	ddi_legend(x,4,"↑",true,false); ddi_legend(x,3,"↓",true,false);
	x.fillStyle="#39e07a"; x.font="20px monospace"; x.textAlign="left";
	x.fillText(String(scale),14,216); }
function ddi_hud(x){ const gz=ownship.gauges||{};   // HUD repeater format (#9): the symbol generator's boresight picture at a fixed field — the same numbers the HUD shows, independent of the head and camera (which is why this is a fresh renderer, not a copy of the screen HUD's camera-coupled draw)
	const ppd=512/26, cx=256, cy=250;   // a 26° square field, about the HUD's own
	const pitch=(gz.pitch||0)/D2R, bank=gz.bank||0;
	x.save(); x.beginPath(); x.rect(40,44,432,432); x.clip();   // the picture stays clear of the button bands
	x.lineWidth=2;
	x.save(); x.translate(cx,cy); x.rotate(-bank);   // pitch ladder about the boresight
	for(let p=-30;p<=30;p+=5){ const off=(pitch-p)*ppd; if(Math.abs(off)>230) continue;
		if(p===0){ x.beginPath(); x.moveTo(-200,off); x.lineTo(-40,off); x.moveTo(40,off); x.lineTo(200,off); x.stroke(); continue; }   // horizon
		const w=p%10===0?70:40, gap=36;
		x.save(); if(p<0) x.setLineDash([10,7]);
		x.beginPath(); x.moveTo(-gap-w,off); x.lineTo(-gap,off); x.moveTo(gap,off); x.lineTo(gap+w,off); x.stroke();
		x.restore();
		if(p%10===0){ x.font="17px monospace"; x.textAlign="left"; x.fillText(String(Math.abs(p)),gap+w+6,off);
			x.textAlign="right"; x.fillText(String(Math.abs(p)),-gap-w-6,off); } }
	x.restore();
	{ const vx=cx+(gz.slip||0)*3*ppd, vy=cy+(ownship.aoa||0)*ppd;   // velocity vector: alpha below the waterline, slip across (the repeat of the picture, not a camera projection)
		const r=9;
		x.beginPath(); x.arc(vx,vy,r,0,Math.PI*2); x.stroke();
		x.beginPath(); x.moveTo(vx-r,vy); x.lineTo(vx-r-10,vy); x.moveTo(vx+r,vy); x.lineTo(vx+r+10,vy); x.moveTo(vx,vy-r); x.lineTo(vx,vy-r-8); x.stroke(); }
	x.beginPath(); x.moveTo(cx-30,cy); x.lineTo(cx-12,cy); x.lineTo(cx-6,cy+8); x.lineTo(cx,cy); x.lineTo(cx+6,cy+8); x.lineTo(cx+12,cy); x.lineTo(cx+30,cy); x.stroke();   // waterline W
	x.font="24px monospace"; x.textAlign="right";   // airspeed and altitude boxes at the waterline datum
	x.strokeRect(58,196,96,34); x.fillText(String(Math.round(gz.casKt||0)),144,214);
	x.strokeRect(360,196,110,34); x.fillText(String(Math.round(gz.altitude||0)),462,214);
	x.font="20px monospace"; x.textAlign="left";
	x.fillText("α "+(ownship.aoa||0).toFixed(1),58,254);
	x.fillText("G  "+(ownship.gload||1).toFixed(1),58,280);
	x.fillText("M  "+(gz.mach||0).toFixed(2),58,306);
	x.textAlign="right"; x.fillText(String(Math.round(gz.fpm||0)),470,254);   // VVI under the altitude box
	x.font="26px monospace"; x.textAlign="center";
	x.fillText(String(Math.round((gz.heading||0)/D2R+360)%360).padStart(3,"0"),256,70);
	for(const d of [-45,-30,-20,-10,0,10,20,30,45]){ const a=Math.PI/2+d*D2R, br=180;   // bank scale under the boresight, pointer at the bank angle
		const i=d===0?14:10;
		x.beginPath(); x.moveTo(cx+Math.cos(a)*br,cy+Math.sin(a)*br); x.lineTo(cx+Math.cos(a)*(br+i),cy+Math.sin(a)*(br+i)); x.stroke(); }
	{ const ba=Math.PI/2-THREE.MathUtils.clamp(bank,-45*D2R,45*D2R), br=180;
		x.beginPath(); x.moveTo(cx+Math.cos(ba)*(br-4),cy+Math.sin(ba)*(br-4)); x.lineTo(cx+Math.cos(ba-0.035)*(br-16),cy+Math.sin(ba-0.035)*(br-16)); x.lineTo(cx+Math.cos(ba+0.035)*(br-16),cy+Math.sin(ba+0.035)*(br-16)); x.closePath(); x.fill(); }
	x.restore(); }
// ---- FUEL page state: the bingo caret, stepped from the bezel arrows.
// fpas_home is the FPAS arrival computation (#54): distance and time to the
// carrier at present groundspeed, and the fuel state on arrival at the
// present measured burn. Null while the numbers cannot mean anything —
// on deck, hovering, or with the engines not burning.
function fpas_home(){ const gz=ownship.gauges||{};
	const gs=gz.ground||0, pph=flow_state.pph;
	if(ownship.grounded||gs<60||pph<200||cheat("fuel")) return null;
	const dist=Math.hypot(wrap_axis(CARRIER.x-ownship.pos.x),wrap_axis(CARRIER.z-ownship.pos.z))/1852;
	const hours=dist/gs;
	const arrive=(gz.fuelRaw||0)+(gz.externalRaw||0)-pph*hours;
	return { dist, hours, arrive };
}
function ddi_fpas(x,display){ const gz=ownship.gauges||{};   // FPAS (#8 menu promise, built at #54): the real page advises best-efficiency cruise; this one carries the decision the game is actually about — endurance and range to the 2,000 lb reserve at the PRESENT burn and speed, and the fuel state on arrival back at the boat. Cockpit text stays English by the annunciator policy.
	const colour=display==="center";
	x.fillText("FPAS",256,36);
	const total=(gz.fuelRaw||0)+(gz.externalRaw||0), pph=flow_state.pph, gs=gz.ground||0;
	const hm=h=>Math.floor(h)+"+"+String(Math.floor((h%1)*60)).padStart(2,"0");
	const row=(label,value,y)=>{ x.font="20px monospace"; x.textAlign="left"; x.fillText(label,60,y); x.fillText(value,190,y); };
	x.font="20px monospace"; x.textAlign="center"; x.fillText("RANGE",256,96);
	if(pph>200){
		const spare=Math.max(0,total-2000), hours=spare/pph;
		row("FLOW",Math.round(pph/10)*10+" PPH",140);
		row("",gs>60?(pph/gs).toFixed(1)+" LB/NM":"--- LB/NM",168);
		row("TIME",hm(hours)+" TO 2000",210);
		row("RANGE",gs>60?Math.round(hours*gs)+" NM TO 2000":"---",238);
	} else { x.font="20px monospace"; x.textAlign="center"; x.fillText("ENGINES DEAD",256,180); }
	x.font="20px monospace"; x.textAlign="center"; x.fillText("HOME",256,300);
	const home=fpas_home();
	if(home){
		const low=home.arrive<=2000;
		row("DIST",home.dist.toFixed(0)+" NM",344);
		row("TIME",hm(home.hours),372);
		if(low&&colour) x.fillStyle="#ffb04a";
		row("FUEL",Math.round(home.arrive/10)*10+" LB",400);
		if(low){ x.font="22px monospace"; x.textAlign="center"; x.fillText("HOME FUEL",256,436); }
		x.fillStyle="#39e07a";
	} else { x.font="20px monospace"; x.textAlign="center"; x.fillText("---",256,360); }
}
const fuel_state={ bingo:2000 };
function fuel_press(pb){
	if(pb===4){ fuel_state.bingo=Math.min(10000,fuel_state.bingo+500); return true; }
	if(pb===3){ fuel_state.bingo=Math.max(0,fuel_state.bingo-500); return true; }
	return false; }
function ddi_fuel(x,display){ const gz=ownship.gauges||{};
	const total=Math.round((gz.fuelRaw||0)/10)*10, ext=Math.round((gz.externalRaw||0)/10)*10, flow=((gz.flowL||0)+(gz.flowR||0))*10;
	const low=(total+ext)<fuel_state.bingo, colour=display==="center";   // the BINGO caret watches TOTAL fuel — externals burn first, so they count (#17)
	x.fillText("FUEL",256,36);
	x.strokeStyle="#39e07a"; x.lineWidth=2;   // fuselage outline, the honest INTERNAL total inside — one external figure below it (concurrent transfer drains the tanks in step, so per-tank rows would all read the same)
	x.beginPath(); x.moveTo(256,86); x.lineTo(292,130); x.lineTo(292,330); x.lineTo(276,364); x.lineTo(236,364); x.lineTo(220,330); x.lineTo(220,130); x.closePath(); x.stroke();
	if(low&&colour) x.fillStyle="#ffb04a";
	x.font="30px monospace"; x.textAlign="center"; x.fillText(String(total),256,226);
	x.font="19px monospace"; x.fillText("LB",256,258);
	if(low){ x.font="22px monospace"; x.fillText("BINGO",256,304); }   // annunciated under the total while beneath the caret
	if(fuel_dump){ if(colour) x.fillStyle="#ffb04a"; x.font="22px monospace"; x.fillText("DUMP",256,336); x.fillStyle="#39e07a"; }   // #54: the switch is ON — fuel is going overboard
	x.fillStyle="#39e07a"; x.font="20px monospace";
	x.textAlign="right"; x.fillText("FF "+Math.round((gz.flowL||0)*10),190,206);   // per-engine burn either side of the tank
	x.textAlign="left"; x.fillText("FF "+Math.round((gz.flowR||0)*10),322,206);
	if(ext>0||external_capacity()>0){ x.textAlign="center"; x.fillText("EXT "+ext,256,396); }   // external tanks aboard: their remaining fuel (burns before internal)
	if(flow>300){ const m=Math.round((total+ext)/flow*60);   // endurance at the present burn, externals included
		x.textAlign="left"; x.fillText("TIME "+Math.floor(m/60)+"+"+String(m%60).padStart(2,"0"),24,458); }
	ddi_legend(x,4,"↑",true,false); ddi_legend(x,3,"↓",true,false);   // the arrows step the caret
	x.font="16px monospace"; x.textAlign="left"; x.fillText(String(fuel_state.bingo),8,216);
	x.font="13px monospace"; x.fillText("BINGO",8,242); }
function ddi_sms(x,display){   // SMS (#5): the stores format over the real loadout model (#17) — planform with per-station contents, remaining rounds, and the SMS priority station boxed when the missile is selected. Display and employment only; configuration lives in the menus.
	const colour=display==="center";
	const lo=ownship.loadout||{};
	x.fillText("SMS",256,36);
	// Planform sketch: nose up, wing line across the middle, stations 1..9
	// port to starboard along it (wingtips at the ends, cheeks inboard,
	// centerline on the keel).
	x.strokeStyle="rgba(57,224,122,0.5)"; x.lineWidth=2;
	x.beginPath(); x.moveTo(256,96); x.lineTo(236,206); x.lineTo(60,266); x.lineTo(60,282); x.lineTo(236,262); x.lineTo(236,352); x.lineTo(216,398); x.lineTo(256,388); x.lineTo(296,398); x.lineTo(276,352); x.lineTo(276,262); x.lineTo(452,282); x.lineTo(452,266); x.lineTo(276,206); x.closePath(); x.stroke();
	const spots={ 1:[64,308], 2:[112,318], 3:[160,328], 4:[208,338], 5:[256,348], 6:[304,338], 7:[352,328], 8:[400,318], 9:[448,308] };
	const order=stores_rounds(lo);
	const fired=Math.max(0, order.length-Math.max(0,ownship.msl|0));
	const next=order[fired];   // the SMS priority station: the round the trigger takes next
	const live=new Set(order.slice(fired).map(r=>r.name));
	for(let station=1;station<=9;station++){
		const slot=lo[String(station)]||{fixture:"",stores:[]};
		const [sx,sy]=spots[station];
		const names=stores_entries(station,slot).filter(n=>!n.startsWith("rail")&&!n.startsWith("twin")&&!n.startsWith("pylon"));
		const missiles_here=names.filter(n=>(n.startsWith("tip")||n.startsWith("9m"))&&live.has(n)).length;
		const tank_here=names.some(n=>n.startsWith("tank"));
		let label="—";
		if(tank_here) label="TK";
		else if(missiles_here>0) label="9M"+(missiles_here>1?"×"+missiles_here:"");
		else if(slot.fixture&&names.length===0) label="PYL";   // hardware aboard, nothing on it
		x.font="15px monospace"; x.textAlign="center";
		if(colour&&label!=="—"&&label!=="PYL") x.fillStyle=tank_here?"#ffd24a":"#39e07a"; else x.fillStyle=label==="—"?"rgba(57,224,122,0.4)":"#39e07a";
		x.fillText(label,sx,sy+34);
		x.font="12px monospace"; x.fillStyle="rgba(57,224,122,0.6)"; x.fillText(String(station),sx,sy+52);
		if(master==="9m"&&next&&next.station===station){ x.strokeStyle="#39e07a"; x.lineWidth=2; x.strokeRect(sx-22,sy+20,44,20);   // the priority station's round launches next
			x.font="12px monospace"; x.fillStyle="#39e07a"; x.fillText("SEL",sx,sy+14); }
		x.fillStyle="#39e07a"; }
	x.font="18px monospace"; x.textAlign="left";
	x.fillText("9M "+Math.max(0,ownship.msl|0),24,430);
	x.fillText("GUN "+(ownship.rounds??0),24,458);
	x.textAlign="right"; x.fillText(master.toUpperCase(),488,458); }
function ddi_ew(x){   // EW (#11): the ALR-67 format frame, REALISTIC for the C by decision — a radar warning receiver is a passive RF sensor, and every missile in this game is an IR AIM-9 that emits nothing, so the real box would show exactly this: a quiet ring. (An MWS-style inbound-dart cue was built and removed here on that ground; the C carries no missile warner.) The page earns its symbols when radar-guided threats arrive with the BVR layer.
	x.fillText("EW",256,36);
	const cx=256, cy=266, R=190;
	x.strokeStyle="rgba(57,224,122,0.45)"; x.lineWidth=1.5;   // aircraft-referenced ring, nose up — lethality bands, not ranges: inside = close
	x.beginPath(); x.arc(cx,cy,R,0,Math.PI*2); x.stroke();
	x.strokeStyle="rgba(57,224,122,0.22)";
	x.beginPath(); x.arc(cx,cy,R*0.5,0,Math.PI*2); x.stroke();
	x.strokeStyle="#39e07a"; x.lineWidth=2;
	for(let d=0;d<360;d+=30){ const a=d*D2R-Math.PI/2;
		x.beginPath(); x.moveTo(cx+Math.cos(a)*R,cy+Math.sin(a)*R); x.lineTo(cx+Math.cos(a)*(R-10),cy+Math.sin(a)*(R-10)); x.stroke(); }
	x.beginPath(); x.moveTo(cx,cy-14); x.lineTo(cx-8,cy+12); x.lineTo(cx+8,cy+12); x.closePath(); x.stroke(); }   // ownship
function gross_weight(){ const gz=ownship.gauges||{}; const book=stores_catalog();   // empty jet + loadout hardware + internal + external, lb — the honest live gross the CHKLST judges (#8, #51)
	const hardware=book?stores_weight(ownship.loadout||loadout(),book).hardware:0;   // pylons, rails, rounds, dry tanks — the flown loadout's hardware (#17)
	return Math.round((((book?book.empty:10700)+hardware)*2.2046+(gz.fuelRaw||0)+(gz.externalRaw||0))/10)*10; }
function ddi_chklst(x,display){ const gz=ownship.gauges||{}; const o=last_out||[];   // CHKLST (#8): the real page is an ABBREVIATED memory-jogger, here filtered to systems the game models — and live: each line checks itself off from the sim state, which the real static page cannot do. Cockpit text stays English by the annunciator policy.
	const colour=display==="center";
	x.fillText("CHKLST",256,36);
	const wt=gross_weight();
	const t=Math.max(0,(wt/2.2046/1000-11.2)/(15.6-11.2));   // linear on the Reference dialog's measured 11.2-15.6 t interval, EXTRAPOLATED above it: a tanked jet flies past the clean bracket and clamping under-read its speeds
	const vapp=Math.round(126+t*22), vs0=Math.round(110+t*16);   // linear between the Reference dialog's measured endpoints (rows vapp/vs0, 11.2-15.6 t — re-based 2026-08-07 with the regenerated table)
	const flap=["AUTO","HALF","FULL"][flap_select]||"AUTO";
	const trim=((o[STATE.datum]||0)/D2R);
	const item=(cx0,y,label,state,ok)=>{
		if(ok!==null){ x.strokeStyle="#39e07a"; x.lineWidth=2; x.strokeRect(cx0,y-9,18,18);
			if(ok){ x.beginPath(); x.moveTo(cx0+4,y); x.lineTo(cx0+8,y+5); x.lineTo(cx0+15,y-6); x.stroke(); } }
		x.font="18px monospace"; x.textAlign="left"; x.fillText(label,cx0+28,y);
		if(state){ if(colour&&ok===false) x.fillStyle="#ffb04a";
			x.font="15px monospace"; x.fillText(state,cx0+28,y+20); x.fillStyle="#39e07a"; } };
	x.font="20px monospace"; x.textAlign="center"; x.fillText("T/O",130,88); x.fillText("LDG",372,88);
	let y=130;
	item(44,y,"WINGS","SPREAD",(ownship.fold??0)<0.02); y+=56;
	item(44,y,"FLAPS","FLAPS "+flap,flap_select===1); y+=56;
	item(44,y,"TRIM",trim.toFixed(1)+"° NU",trim>0.5); y+=56;
	item(44,y,"HOOK UP",null,(ownship.hook??0)<0.02); y+=56;
	item(44,y,"CANOPY",null,(ownship.canopy??ownship.canopyTarget??0)<0.02); y+=56;
	item(44,y,"PARK BRK","OFF",!parking);
	x.font="20px monospace"; x.textAlign="left";   // NATOPS 8.2.7 catapult power: below the 44,000 lb weight board the technique is the pilot's choice of MIL / MIL-MAX / MAX; 45,000 and above requires MAX. Data, not automation — the power stays in the pilot's hand
	x.fillText("CAT "+(wt>=45000?"MAX":"MIL/MAX"),44,458);
	y=130;
	item(286,y,"GEAR","DOWN",(ownship.gear??1)<0.02); y+=56;
	item(286,y,"FLAPS","FLAPS "+flap,flap_select>0); y+=56;
	item(286,y,"HOOK","HOOK "+((ownship.hook??0)>0.98?"DN":"UP"),null); y+=56;   // carrier or field decides — state only
	item(286,y,"ON SPEED","8.1° AOA",null); y+=56;
	item(286,y,"LDG WT","MAX 33000",wt<=33000);   // NATOPS 4.1.7: carrier landing 33,000 lb unrestricted (34,000 absolute, with restrictions) — the box ticks when the live gross is legal to trap
	x.font="20px monospace"; x.textAlign="left";   // under the shorter LDG column — the T/O column runs long
	x.fillText("WT "+wt+" LB",286,402);
	x.fillText("VAPP "+vapp,286,430);
	x.fillText("VS0  "+vs0,286,458); }
function ddi_fcs(x,display){ const o=last_out||[];   // per-surface truth straight from the flight core's control words; X = the channel's jam word
	const colour=display==="center";
	const deg=i=>(o[i]||0)/D2R;
	const jam=i=>(o[STATE.jam+i]||0)>0.5;
	x.fillText("FCS",256,36);
	x.font="20px monospace";
	const row=(label,v,xx,y,jammed)=>{ const r=Math.round(v);   // round BEFORE the sign, or a -0.3° deflection prints "-0°"
		x.textAlign="center"; x.fillText(label,xx,y);
		x.fillText((r<0?"-":"")+Math.abs(r)+"°",xx,y+26);
		if(jammed){ x.strokeStyle=colour?"#ffb04a":"#39e07a"; x.lineWidth=3;
			x.beginPath(); x.moveTo(xx-26,y-12); x.lineTo(xx+26,y+38); x.moveTo(xx+26,y-12); x.lineTo(xx-26,y+38); x.stroke();
			x.strokeStyle="#39e07a"; x.lineWidth=2; } };
	row("LEF",deg(STATE.slat),110,140,jam(5)); row("LEF",deg(STATE.slat),402,140,jam(5));   // one slat word, both wings
	// The jam words are per ACTUATOR (flight/damage.go: 0/1 stabilator, 2/3
	// FLAPERON, 4 rudder, 5 slat, 6 speedbrake) — there is no flap channel at
	// all. The X belonged on the AIL rows, which show the genuinely frozen
	// surface; it sat on TEF, whose number keeps moving because Fcs.Flap is a
	// readout the flaperon actuator already carries (aero.go). The page the
	// pilot opens to identify a failure named the wrong surface (#48).
	row("TEF",deg(STATE.flap),110,216,false); row("TEF",deg(STATE.flap),402,216,false);
	row("AIL",deg(STATE.flaperon),110,292,jam(2)); row("AIL",deg(STATE.flaperon+1),402,292,jam(3));
	row("STAB",deg(STATE.stabilator),110,368,jam(0)); row("STAB",deg(STATE.stabilator+1),402,368,jam(1));
	row("RUD",deg(STATE.rudder),256,368,jam(4));
	x.textAlign="center"; x.fillText("SPD BRK "+Math.round((o[STATE.speedbrake]||0)*100)+"%",256,110);
	if(jam(6)){ x.strokeStyle=colour?"#ffb04a":"#39e07a"; x.lineWidth=3;   // the speedbrake actuator jams too (battle plumbing damage) and showed nothing
		x.beginPath(); x.moveTo(150,92); x.lineTo(362,122); x.moveTo(362,92); x.lineTo(150,122); x.stroke();
		x.strokeStyle="#39e07a"; x.lineWidth=2; }
	x.textAlign="left";   // the two trim datums
	x.fillText("TRIM "+((o[STATE.datum]||0)/D2R).toFixed(1)+"°",24,430);
	x.fillText("ROLL "+Math.round((o[STATE.bank]||0)*100)+"%",24,458); }
// ============================================================================ stores (#17): per-station loadout, visuals, firing order
const TIP_NODES=stores_tips;   // the two wingtip AIM-9 NODES in the fa18c GLB, sides probe-verified — SHARED with the setup preview via stores.ts so the two can never disagree
const MISSILE_NODES=[TIP_NODES.tip9, TIP_NODES.tip1];   // legacy tip pair for jets with no known loadout (remotes before the roster carries theirs)
const ROUND_ANCHORS=stores_anchors;   // model-space anchors for AIM-9 rounds cloned onto the outboard stations — also shared with the preview
const BOT_ARMED=stores_presets.fox2;   // the bot's armed standard IS the Fox 2 fighter (decided 2026-08-06): six AIM-9Ms carried; the brain's calibrated two-round discipline fires from them in SMS order (opening it is #25's re-sweep)
const BOT_CLEAN=stores_normalize({});
let loadout_rev=0;   // bumped whenever a jet's loadout is (re)assigned — keys the per-frame mask memo
let stores_book=null;   // the resolved fitment catalog, read from the core once it boots
function stores_catalog(){ if(!stores_book){ const raw=flight_catalog(own_aircraft()); if(raw) stores_book=stores_resolve(raw); } return stores_book; }
function loadout(){ return missiles_rule?cfg.stores:stores_strip(cfg.stores); }   // the FLOWN loadout: the match rule clamps the spawn, never the persisted choice
function missiles_on(){ return missiles_rule&&missiles_loaded(cfg.stores); }   // the derived flag that replaced cfg.missiles: joust rule (bandit arms when the player does), SHOOT cue, dev probe
function loadout_racked(lo){ for(let s=2;s<=8;s++){ const slot=lo&&lo[String(s)]; if(slot&&slot.fixture) return true; } return false; }
function bandit_remaining(){ return missiles_on()?stores_rounds(BOT_ARMED).length:0; }   // the SP bandit CARRIES the full armed standard of missiles and never expends them (its brain is guns-only; the gun draws from a real 578-round belt, #233); server bots decrement their own masks
function assign_loadout(st,lo){ st.loadout=lo; loadout_rev++; if(loadout_racked(lo)) void init_stores_model(); apply_stores(st); }
// apply_stores rebuilds a jet's store visuals from its loadout: fixtures and
// tanks from the split stores.glb (per-station nodes in the airframe's own
// model space — parenting under the scene frame needs no offset math), and
// pylon AIM-9 rounds as translated clones of the jet's own tip missile mesh.
// Tips stay airframe nodes, toggled by update_rails.
function apply_stores(st){ if(!st.group) return;
	const model=st.group.children.find(c=>c.userData&&c.userData.model);
	const scene=model&&model.children[0]&&model.children[0].children[0];
	if(!scene) return;
	if(st.racks&&st.racks.holder&&st.racks.holder.parent) st.racks.holder.parent.remove(st.racks.holder);
	st.racks=null;
	const lo=st.loadout;
	if(!lo||!stores_proto) return;   // no loadout known (remote before its roster) or the stores model is still loading — tips alone carry the legacy look
	const holder=new THREE.Group(); holder.name="stores";
	const nodes={};
	for(let station=1;station<=9;station++){
		const slot=lo[String(station)]; if(!slot) continue;
		for(const name of stores_entries(station,slot)){
			if(name.startsWith("tip")) continue;   // airframe nodes, not clones
			let piece=null;
			if(name.startsWith("rail")||name.startsWith("twin")||name.startsWith("pylon")){ piece=stores_clone("Pylon_"+station); }
			else if(name.startsWith("tank")){ piece=stores_clone("Tank_"+station); }
			else if(ROUND_ANCHORS[name]){ piece=round_clone(model, name, station); }
			if(piece){ holder.add(piece); nodes[name]=piece; }
		}
	}
	scene.add(holder);
	st.racks={ holder, nodes };
	if(st.group.userData.player){ layer_own_group(st.group); }   // fresh children need the cockpit-pass layer
	update_rails(st, Math.max(0, st.msl|0)); }
function stores_clone(name){ if(!stores_proto) return null; const source=stores_proto.getObjectByName(name); if(!source) return null;
	const piece=source.clone(true); piece.traverse(o=>{ if(o.isMesh){ o.castShadow=cfg.shadows; o.userData.modelmesh=true; } }); return piece; }
// round_clone borrows the jet's own tip missile mesh for a pylon round: same
// geometry, material, and heading — only translated to the station anchor.
function round_clone(model, name, station){
	const source=model.getObjectByName(station<5?TIP_NODES.tip1:TIP_NODES.tip9);   // clone the same side's tip so any livery asymmetry stays honest
	if(!source||!source.isMesh) return null;
	if(!source.geometry.boundingBox) source.geometry.computeBoundingBox();
	const centre=source.geometry.boundingBox.getCenter(new THREE.Vector3());
	const piece=new THREE.Mesh(source.geometry, source.material);
	piece.castShadow=cfg.shadows; piece.userData.modelmesh=true;
	const anchor=ROUND_ANCHORS[name];
	piece.position.set(anchor[0]-centre.x, anchor[1]-centre.y, anchor[2]-centre.z);
	return piece; }
// update_rails shows the jet's remaining rounds: expended missiles disappear
// in the SMS firing order (rounds()), tips included. A jet with no known
// loadout falls back to the legacy tip pair per count.
function update_rails(st,count){ if(!st.group) return;
	const lo=st.loadout;
	if(!lo){ for(let i=0;i<MISSILE_NODES.length;i++){ const node=st.group.getObjectByName(MISSILE_NODES[i]); if(node) node.visible=i<count; } return; }
	const order=stores_rounds(lo);
	const fired=Math.max(0, order.length-Math.max(0,count|0));
	const live=new Set(order.slice(fired).map(r=>r.name));
	for(const key of ["tip1","tip9"]){ const node=st.group.getObjectByName(TIP_NODES[key]); if(node) node.visible=live.has(key); }
	for(const [name,node] of Object.entries((st.racks&&st.racks.nodes)||{})){ if(name.startsWith("9m")) node.visible=live.has(name); } }
function apply_model_all(){ apply_model_to(ownship.group, own_aircraft()); apply_model_to(bandit.group); position_aircraft_lights(); calibrate_eye();
	assign_loadout(ownship, loadout()); assign_loadout(bandit, missiles_on()?BOT_ARMED:BOT_CLEAN);
	update_rails(ownship, ownship.msl); update_rails(bandit, bandit_remaining()); }   // re-pin the ownship lights to the real airframe; rails reflect the loadout
// own_mask is the core attach bitmask for the ownship's flown loadout with the
// expended rounds cleared — memoised on (loadout revision, remaining count) so
// the per-frame sync allocates nothing. Before the catalog is readable the
// bare default (wingtips) stands in; the real mask lands the next frame.
let own_mask_memo={ key:-1, value:0b11 };
function own_mask(){ const book=stores_catalog(); if(!book) return 0b11;
	const lo=ownship.loadout||loadout();
	const remaining=Math.max(0, ownship.msl|0);
	const key=loadout_rev*64+remaining;
	if(own_mask_memo.key!==key){ const order=stores_rounds(lo); own_mask_memo={ key, value:stores_mask(lo, Math.max(0,order.length-remaining), book) }; }
	return own_mask_memo.value; }
// external_capacity is the flown loadout's full-tank external fuel, kg — the
// deck crew's fill line and the setup's gross-weight arithmetic both use it.
function external_capacity(){ const book=stores_catalog(); if(!book) return 0;
	return stores_weight(ownship.loadout||loadout(), book).fuel; }
// ---- Jettison (#18): ONE separation path shared by the pilot's commands and
// carriage-limit failures. The loadout edit flows to the core (mass, drag,
// external fuel clamp) through the per-frame flight_stores sync; departing
// pieces become free-falling debris; multiplayer learns through the jettison
// wire event and the server's roster re-emit.
const falling=[];   // free-falling jettisoned pieces: {piece, vel, spin, age}
function separate_debris(st, names){
	const nodes=(st.racks&&st.racks.nodes)||{};
	for(const name of names){ const node=nodes[name]; if(!node||!node.visible||!node.parent) continue;
		const piece=node.clone(true);
		node.parent.updateWorldMatrix(true,false);
		piece.applyMatrix4(node.parent.matrixWorld);   // keep the world pose after reparenting to the scene
		piece.traverse(o=>{ o.layers.enable(0); });   // the jet's meshes live on the own-group layer; free-falling debris is world furniture — back onto the default layer every camera renders
		scene.add(piece);
		const vel=st.vel_dir?st.vel_dir.clone().multiplyScalar((st.speed||0)*0.99):new THREE.Vector3();
		vel.y-=2;   // the ejector cartridge's downward punch — the store leaves the airframe's shadow so the separation is SEEN
		falling.push({ piece, vel, spin:new THREE.Vector3((Math.random()-0.5)*2,(Math.random()-0.5)*2,(Math.random()-0.5)*4), age:0 }); } }
function falling_update(dt){
	for(let i=falling.length-1;i>=0;i--){ const f=falling[i]; f.age+=dt;
		f.vel.y-=9.81*dt; f.vel.multiplyScalar(1-0.03*dt);   // streamlined stores decelerate gently — they fall away below and aft, in view for seconds, as on the real jettison footage
		f.piece.position.addScaledVector(f.vel,dt);
		f.piece.rotation.x+=f.spin.x*dt; f.piece.rotation.y+=f.spin.y*dt; f.piece.rotation.z+=f.spin.z*dt;
		if(f.age>15||f.piece.position.y<0){ scene.remove(f.piece); falling.splice(i,1); } } }
// departure_names lists the catalog entries a jettison removes from a slot —
// the debris to spawn. 'stores' keeps the fixture hardware on the jet.
function departure_names(station, slot, what){
	const out=[];
	for(const name of stores_entries(station,slot)){
		if(name.startsWith("tip")) continue;
		if(what==="stores"&&(name.startsWith("rail")||name.startsWith("twin")||name.startsWith("pylon"))) continue;
		out.push(name); }
	return out; }
// jettison_stations applies a departure to the ownship and tells the server.
// what: 'stores' drops the mounts, 'rack' the fixture and all on it.
function jettison_stations(stations, what){
	if(!running||ownship.grounded) return false;
	const lo=ownship.loadout||loadout();
	let next=lo; const dropped=[], debris=[];
	for(const station of stations){
		const slot=lo[String(station)]; if(!slot||!slot.fixture) continue;
		const names=departure_names(station,slot,what); if(!names.length) continue;
		dropped.push(station); debris.push(...names);
		next=stores_jettison(next,station,what); }
	if(!dropped.length) return false;
	separate_debris(ownship, debris);
	const before=stores_rounds(lo), fired=Math.max(0,before.length-Math.max(0,ownship.msl|0));
	const live=new Set(stores_rounds(next).map(r=>r.name));
	const gone=before.slice(fired).filter(r=>!live.has(r.name)).length;   // live rounds that left on their racks
	assign_loadout(ownship,next);
	ownship.msl=Math.max(0,(ownship.msl|0)-gone);
	update_rails(ownship,ownship.msl);
	// The release envelope (#43, NATOPS fig 4-4 jettison columns: 575 KCAS /
	// Mach 0.95, +1 to +2 g). Outside it the departing store can strike the
	// airframe — a deterministic dent and overstress per offending station.
	// SP only: in multiplayer the server's Jettison applies the same strike
	// authoritatively (world/games/air/stores.go release_severity — in sync).
	if(!MULTIPLAYER){
		const speed=Math.max((ownship.cas||0)*1.9438/stores_release.knots, (((ownship.gauges&&ownship.gauges.mach)||0))/stores_release.mach);
		const g=ownship.gload||1;
		const severity=Math.max(0,speed-1)+0.5*Math.max(0,Math.max(stores_release.low-g,g-stores_release.high));
		if(severity>0){ const words=flight_get(); if(words){ const struck=Math.min(1,2*severity);
			for(let s=0;s<dropped.length;s++){ words[STATE.drag]+=0.05*struck; words[STATE.stress]+=2*severity; }
			flight_set(words); } } }
	if(net) net.jettison(dropped.map(station=>({ station, what })));
	return true; }
// Emergency jettison: the striped button — held through the whole sequence,
// pairs 2+8 then 3+7 then the centerline, RACK/LCHR semantics, weight off
// wheels the only interlock (as the real button, NATOPS 2.17.1.1).
const EMERGENCY_PAIRS=[[2,8],[3,7],[5]];
const emergency={ held:false, step:0, timer:0, said:false };
function emergency_update(dt, pressed){
	if(!pressed){ emergency.held=false; return; }
	if(!emergency.held){ emergency.held=true; emergency.step=0; emergency.timer=0; emergency.said=false; }
	if(emergency.step>=EMERGENCY_PAIRS.length) return;
	emergency.timer-=dt;
	if(emergency.timer<=0){ if(jettison_stations(EMERGENCY_PAIRS[emergency.step],"rack")&&!emergency.said){ emergency.said=true; notice(translate("EMERG JETT")); }   // the wing stations are behind the pilot — say that the button worked
		emergency.step++; emergency.timer=0.3; } }
// Carriage limits (#18/#43): each store's envelope is NATOPS figure 4-4 data
// (stores LIMITS, keyed by entry name — the centreline tank genuinely differs
// from the wing stations). The limit is two-sided, KCAS or Mach whichever is
// less; there is NO store g limit (LBA — the airframe's own placard governs),
// and missiles/rails/pylons carry no limit at all. Exceedance accumulates
// per-station harm and past threshold the attachment FAILS — the store
// departs involuntarily through the same path, the sudden asymmetry itself
// the pilot's first cue.
function carriage_update(dt){
	if(!running||ownship.grounded||!ownship.loadout) return;
	const cas=(ownship.cas||0)*1.9438, mach=(ownship.gauges&&ownship.gauges.mach)||0;   // knots CAS + Mach from the core's own air data
	const harm=ownship.carriage||(ownship.carriage={});
	for(let station=2;station<=8;station++){
		const slot=ownship.loadout[String(station)]; if(!slot||!slot.fixture) continue;
		let worst=0;
		for(const name of stores_entries(station,slot)){
			const limit=stores_limits[name]; if(!limit) continue;
			if(limit.knots) worst=Math.max(worst, cas/limit.knots);
			if(limit.mach) worst=Math.max(worst, mach/limit.mach); }
		if(worst<=1) continue;
		harm[station]=(harm[station]||0)+(worst-1)*dt*2.5;   // ~6 s at 7% over, faster the deeper the breach
		if(harm[station]>=1){ delete harm[station]; jettison_stations([station],"rack"); } } }
// --- minimal GLB container surgery (so we never trigger the loader's blob-URL texture path) ---
// The pure helpers moved to game/model.ts (shared with the setup's loadout
// preview); glb_split/glb_repack/model_textures are import aliases so every
// call site here reads as before. Solid-colour materials (no
// baseColorTexture) keep their baseColorFactor, so a multi-material model
// renders its full livery.
const glb_split=model_split, glb_repack=model_repack, model_textures=model_captures;
async function init_external_model(kind){
	kind=kind||"fa18c"; const spec=AIRCRAFT_MODELS[kind]||AIRCRAFT_MODELS.fa18c;
	if(fleet[kind]||fleet_loading[kind]) return fleet_loading[kind]; // one load per aircraft
	let finish; fleet_loading[kind]=new Promise(r=>{ finish=r; });
	const tag=spec.url;
	try{
		// Fetch/decode the GLB bytes ourselves (the loader's .load() builds a Request that sandboxed iframes can't clone).
		// The preload module owns the download: single-flight with the menu's early start, byte-counted for the loading screen.
		const abuf=await asset_bytes(spec.url);
		// Capture per-material baseColor images, then strip texture refs so parse() never makes a blob: URL (which the sandbox rejects).
		const parts=glb_split(abuf); const tex_by_material=model_textures(parts);
		(parts.json.materials||[]).forEach(m=>{ if(m.pbrMetallicRoughness){ delete m.pbrMetallicRoughness.baseColorTexture; delete m.pbrMetallicRoughness.metallicRoughnessTexture; } delete m.normalTexture; delete m.occlusionTexture; delete m.emissiveTexture;
			for(const ext of Object.values(m.extensions||{})){ for(const key of Object.keys(ext)){ if(key.endsWith("Texture")) delete ext[key]; } } });   // extension-held refs too (KHR_materials_specular etc.) — a dangling texture index kills the parse
		delete parts.json.textures; delete parts.json.images; delete parts.json.samplers;
		const clean=glb_repack(parts.json, parts.bin);
		const loader=new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);   // models ship meshopt-compressed (EXT_meshopt_compression); the decoder is bundled, no CDN
		loader.parse(clean, "",
			async gltf=>{ try{
				for(const fix of spec.pose||[]){ let o=null; gltf.scene.traverse(x=>{ if(!o&&x.name===fix.node) o=x; }); if(o) o.quaternion.set(...fix.quaternion); }   // static pose corrections for mid-animation-authored nodes, before anything captures rest poses
				const proto=normalise_model(gltf.scene, spec);
				const rig=rig_build(spec, gltf.animations||[]);
				// Stand the drawn model on its wheels. normalise_model centres on the bounding box, which knows
				// nothing about wheel geometry — and GLB edits move the centre (removing the external tanks
				// shifted it ~11 cm and buried the wheels). Scrub the gear rig to the grounded pose, find the
				// drawn wheel bottoms, and lift the model so they land exactly on the physics resting plane
				// (spec.stance below the origin — the core settles the origin ~2.56 m above the surface).
				const gearrig=rig.find(r=>r.name==="gear"&&r.clip);
				if(gearrig&&spec.stance){
					const mixer=new THREE.AnimationMixer(proto), action=mixer.clipAction(gearrig.clip);
					action.play(); action.paused=true;
					action.time=gearrig.t0+(1-(spec.squat||0))*(gearrig.t1-gearrig.t0); mixer.update(0); proto.updateMatrixWorld(true);
					let low=1e9; const lv=new THREE.Vector3(); const bottoms=[];
					proto.traverse(x=>{ if(!x.isMesh) return; const pa=x.geometry.attributes.position;
						for(let i=0;i<pa.count;i++){ lv.fromBufferAttribute(pa,i).applyMatrix4(x.matrixWorld); if(lv.y<low) low=lv.y; if(lv.y<low+0.6) bottoms.push([lv.x,lv.y]); } });
					if(low>-8&&low<-1){ proto.children[0].position.y=(-spec.stance)-low;   // clones inherit; each aircraft's own gear scrub re-poses the struts every frame
						// Measure the DRAWN nose wheel and pin it onto the physics nose gear: the static spec.wheel
						// constant goes stale every time a GLB edit moves the bounding-box centre the normaliser uses
						// (the stores removal did). The forward-most wheel-bottom cluster is the nose wheel contact;
						// shifting it onto spec.nose makes the shuttle, the cat spot, and the align tool all
						// nosewheel-true by construction.
						const wb=bottoms.filter(q=>q[1]<low+0.35);
						if(wb.length>3){ const mx=Math.max(...wb.map(q=>q[0]));
							const nosewb=wb.filter(q=>q[0]>mx-1.2), nx=nosewb.reduce((a,q)=>a+q[0],0)/nosewb.length;
							if(spec.nose&&Math.abs(spec.nose-nx)<1.5) proto.children[0].position.x+=(spec.nose-nx); } }
				}
				if(typeof createImageBitmap==="function"){
					const decoded={};
					await Promise.all(Object.keys(tex_by_material).map(async name=>{ try{
						// make_tex handles both classic images (createImageBitmap) and KTX2 (#200,
						// transcoded via KTX2Loader) — the old inline duplicate fed KTX2 bytes to
						// createImageBitmap, which throws, leaving the jet untextured.
						const src=tex_by_material[name]; const make=async(im,srgb)=>im?make_tex(im,srgb):null;
						decoded[name]={ base:await make(src.base,true), emissive:await make(src.emissive,true), hadEmissive:src.hadEmissive };
					}catch(te){ console.warn("[model] texture decode failed for "+name,te&&te.message||te); } }));
					proto.traverse(o=>{ if(o.isMesh&&o.material){ (Array.isArray(o.material)?o.material:[o.material]).forEach(mm=>{
						const d=decoded[mm.name];
						if(d&&d.base) mm.map=d.base;
						if(d&&d.base&&/^Material_1[24]$/.test(mm.name||"")){ mm.emissiveMap=d.base; mm.emissive=new THREE.Color(0xffffff); mm.emissiveIntensity=0.32; instrument_mats.push(mm); }   // instrument backlighting (#99): the two cockpit gauge atlases are near-black faces that vanish in the glareshield's shadow — self-illuminate them from their own baseColor, like the real backlit panels, so dials read day and night; intensity follows tod/lights (instrument_backlight)
						if(d&&d.emissive){ mm.emissiveMap=d.emissive; mm.emissiveIntensity=Math.min(mm.emissiveIntensity||1, 1.1); }   // cap KHR emissive strength: under the scene's ACES tone mapping a hot emissive blows to white-pink
						else if(d&&d.hadEmissive&&mm.emissive){ mm.emissive.setRGB(0,0,0); }   // emissive texture stripped and unrestorable: black it out rather than glow flat white
						if(mm.metalness!==undefined && !/glass|screen|oleo|gear/i.test(mm.name||"")){ mm.metalness=0.0; mm.roughness=0.88; }   // matte low-vis tactical paint; keep canopy glass, chrome oleo, and the gear (semi-gloss, matching the donor) untouched
						mm.needsUpdate=true;
					}); } });
				}
				fleet[kind]={ proto, rig };
				if(kind===(cfg.aircraft||"fa18c")) model_active=true;   // the loading gate waits on the ownship's aircraft
				apply_model_all(); finish();
			}catch(e){ finish(); throw new Error("aircraft model: failed to process "+tag+": "+(e&&e.message||e)); } },
			err=>{ finish(); throw new Error("aircraft model: parse failed for "+tag+" ("+((err&&err.message)||"bad glTF")+") — ensure uncompressed glTF/GLB (no Draco)"); });
	}catch(e){ finish(); throw new Error("aircraft model: not loaded "+tag+" ("+((e&&e.message)||e)+")"); }
}

// ============================================================================ stores model (#17)
// The split stores.glb: per-station pylon, tank, and (future) missile nodes in
// the airframe's own model space, lazily fetched the first time a loadout
// carries anything beyond the wingtips. Same sandbox-safe pipeline as the
// airframe: strip texture refs, parse, decode KTX2 in-process.
let stores_proto=null, stores_pending=null;
async function init_stores_model(){
	if(stores_proto) return; if(stores_pending) return stores_pending;
	stores_pending=(async()=>{ try{
		const abuf=await asset_bytes(stores_model_url);
		const parts=glb_split(abuf); const tex_by_material=model_textures(parts);
		(parts.json.materials||[]).forEach(m=>{ if(m.pbrMetallicRoughness){ delete m.pbrMetallicRoughness.baseColorTexture; delete m.pbrMetallicRoughness.metallicRoughnessTexture; } delete m.normalTexture; delete m.occlusionTexture; delete m.emissiveTexture;
			for(const ext of Object.values(m.extensions||{})){ for(const key of Object.keys(ext)){ if(key.endsWith("Texture")) delete ext[key]; } } });
		delete parts.json.textures; delete parts.json.images; delete parts.json.samplers;
		const clean=glb_repack(parts.json, parts.bin);
		const gltf=await new Promise((res,rej)=>{ const loader=new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder); loader.parse(clean,"",res,rej); });
		if(typeof createImageBitmap==="function"){
			const decoded={};
			await Promise.all(Object.keys(tex_by_material).map(async name=>{ try{
				const src=tex_by_material[name]; const make=async(im,srgb)=>im?make_tex(im,srgb):null;
				decoded[name]={ base:await make(src.base,true) };
			}catch(te){ console.warn("[stores] texture decode failed for "+name,te&&te.message||te); } }));
			gltf.scene.traverse(o=>{ if(o.isMesh&&o.material){ (Array.isArray(o.material)?o.material:[o.material]).forEach(mm=>{
				const d=decoded[mm.name];
				if(d&&d.base) mm.map=d.base;
				if(mm.metalness!==undefined){ mm.metalness=0.0; mm.roughness=0.88; }   // the same matte tactical finish as the airframe
				mm.needsUpdate=true;
			}); } });
		}
		stores_proto=gltf.scene;
		apply_stores(ownship); apply_stores(bandit);   // jets that spawned before the fetch finished get their racks now
		for(const st of remotes.values()) apply_stores(st);
	}catch(e){ console.warn("[stores] model failed",e&&e.message||e); stores_pending=null; } })();
	return stores_pending;
}

// ============================================================================ optional external carrier model
// Placed so bow -> +X (yaw 90; flip to -90 or +180 if reversed) and the waterline sits at y=0.
// draft_frac = fraction of the keel->deck height kept BELOW water; raise it to sit the hull deeper.
let carrier_model=null; const _ray=new THREE.Raycaster();
function glb_image(p,ti){ if(ti==null||!p.bin||!p.json.textures) return null; const t=p.json.textures[ti]; if(!t) return null;
	const si=t.source!=null?t.source:(t.extensions&&t.extensions.KHR_texture_basisu?t.extensions.KHR_texture_basisu.source:null);   // KTX2 textures (#200) carry their image in the basisu extension
	const im=p.json.images&&si!=null?p.json.images[si]:null; if(!im||im.bufferView==null) return null; const bv=p.json.bufferViews[im.bufferView];
	return { bytes:p.bin.slice(bv.byteOffset||0,(bv.byteOffset||0)+bv.byteLength), mime:im.mimeType||"image/png" }; }
// Shared KTX2/BasisU transcoder (#200): one instance (KTX2Loader warns on more),
// created lazily because detectSupport needs the renderer. The transcoder js/wasm
// are self-hosted under the app's basis/ files action; the relative path resolves
// against the page URL like the maps/ convention.
let ktx2=null;
function ktx2_loader(){ if(!ktx2){ ktx2=new KTX2Loader().setTranscoderPath("basis/").detectSupport(renderer); } return ktx2; }
async function make_tex(src,srgb){
	if(src.mime==="image/ktx2"){
		// GPU-compressed textures (#200): transcode the KTX2 payload to the native
		// block format (BC7/ASTC/ETC2). _createTexture is KTX2Loader's buffer entry
		// (load() is a thin URL wrapper around it); the mip chain ships in the
		// container, so no generateMipmaps. flipY stays false (glTF convention —
		// compressed textures cannot flip anyway).
		const buf=src.bytes.byteOffset===0&&src.bytes.byteLength===src.bytes.buffer.byteLength?src.bytes.buffer:src.bytes.slice().buffer;
		const t=await ktx2_loader()._createTexture(buf);
		t.colorSpace=srgb?THREE.SRGBColorSpace:THREE.LinearSRGBColorSpace; t.wrapS=t.wrapT=THREE.RepeatWrapping;
		t.anisotropy=renderer.capabilities.getMaxAnisotropy(); t.needsUpdate=true; return t; }
	const bmp=await createImageBitmap(new Blob([src.bytes],{type:src.mime}));
	const t=new THREE.Texture(bmp); t.flipY=false; t.colorSpace=srgb?THREE.SRGBColorSpace:THREE.LinearSRGBColorSpace; t.wrapS=t.wrapT=THREE.RepeatWrapping;
	// trilinear mipmapping + max anisotropy: the carrier deck is a big flat surface viewed at grazing
	// angles from altitude, where thin painted markings (landing strip, centreline) alias badly without it.
	t.magFilter=THREE.LinearFilter; t.minFilter=THREE.LinearMipmapLinearFilter; t.generateMipmaps=true;
	t.anisotropy=renderer.capabilities.getMaxAnisotropy(); t.needsUpdate=true; return t; }
function model_y_stats(grp){ grp.updateMatrixWorld(true); const v=new THREE.Vector3(); let mn=Infinity,mx=-Infinity; const ys=[];
	grp.traverse(o=>{ if(o.isMesh&&o.geometry&&o.geometry.attributes.position){ const pa=o.geometry.attributes.position; o.updateWorldMatrix(true,false);
		for(let i=0;i<pa.count;i++){ v.fromBufferAttribute(pa,i).applyMatrix4(o.matrixWorld); if(v.y<mn)mn=v.y; if(v.y>mx)mx=v.y; ys.push(v.y); } } });
	const NB=80,w=(mx-mn)/NB||1,h=new Array(NB).fill(0); for(const y of ys){ let b=Math.floor((y-mn)/w); if(b<0)b=0; if(b>=NB)b=NB-1; h[b]++; }
	let pk=0; for(let i=0;i<NB;i++) if(h[i]>h[pk])pk=i; return { keelY:mn, topY:mx, deckY:mn+(pk+0.5)*w }; }
let deck_grid=null;   // deck height field, carrier-local 1.5 m cells — built once at carrier load; raycasting the 358k-triangle hull cost 13 ms PER QUERY and startup makes ~300 of them (the 4-second loading hang)
function build_deck_grid(grp,deckY){
	const cell=1.5, minFa=-172, maxFa=172, minLat=-52, maxLat=48;
	const W=Math.ceil((maxFa-minFa)/cell), H=Math.ceil((maxLat-minLat)/cell);
	const data=new Float32Array(W*H).fill(NaN);
	const a=new THREE.Vector3(), b=new THREE.Vector3(), c=new THREE.Vector3();
	const mast={x:0,y:-1e9,z:0};   // the island mast top — found here because the deck grid EXCLUDES island geometry by design, so the old deck_y_at height scan can never see it (the masthead/floods silently vanished when the grid replaced raycasts)
	grp.traverse(o=>{ if(!o.isMesh||!o.geometry.attributes.position) return;
		const p=o.geometry.attributes.position, idx=o.geometry.index;
		const n=idx?idx.count:p.count;
		for(let i=0;i<n;i+=3){
			a.fromBufferAttribute(p, idx?idx.getX(i):i).applyMatrix4(o.matrixWorld);
			b.fromBufferAttribute(p, idx?idx.getX(i+1):i+1).applyMatrix4(o.matrixWorld);
			c.fromBufferAttribute(p, idx?idx.getX(i+2):i+2).applyMatrix4(o.matrixWorld);
			for(const v2 of [a,b,c]){ if(v2.y>mast.y){ const lf=carrier_fore_aft(v2.x,v2.z), ll=carrier_lateral(v2.x,v2.z);
				if(lf>-105&&lf<65&&ll>8&&ll<46){ mast.x=v2.x; mast.y=v2.y; mast.z=v2.z; } } }
			if(Math.abs(a.y-deckY)>3.5||Math.abs(b.y-deckY)>3.5||Math.abs(c.y-deckY)>3.5) continue;   // deck band only: the island must NOT write cells, or cats near it would read roof heights
			const fa=[carrier_fore_aft(a.x,a.z),carrier_fore_aft(b.x,b.z),carrier_fore_aft(c.x,c.z)];
			const la=[carrier_lateral(a.x,a.z),carrier_lateral(b.x,b.z),carrier_lateral(c.x,c.z)];
			const ys=[a.y,b.y,c.y];
			const i0=Math.max(0,Math.floor((Math.min(...fa)-minFa)/cell)), i1=Math.min(W-1,Math.ceil((Math.max(...fa)-minFa)/cell));
			const j0=Math.max(0,Math.floor((Math.min(...la)-minLat)/cell)), j1=Math.min(H-1,Math.ceil((Math.max(...la)-minLat)/cell));
			const d=(fa[1]-fa[0])*(la[2]-la[0])-(la[1]-la[0])*(fa[2]-fa[0]); if(Math.abs(d)<1e-9) continue;
			for(let gi=i0;gi<=i1;gi++) for(let gj=j0;gj<=j1;gj++){
				const qf=minFa+(gi+0.5)*cell, ql=minLat+(gj+0.5)*cell;
				const w1=((fa[1]-qf)*(la[2]-ql)-(la[1]-ql)*(fa[2]-qf))/d, w2=((fa[2]-qf)*(la[0]-ql)-(la[2]-ql)*(fa[0]-qf))/d, w3=1-w1-w2;
				if(w1<-0.02||w2<-0.02||w3<-0.02) continue;
				const y=w1*ys[0]+w2*ys[1]+w3*ys[2], k=gj*W+gi;
				if(!(data[k]>=y)) data[k]=y;   // top surface wins (NaN-safe)
			}
		} });
	deck_grid={ data, W, H, cell, minFa, minLat, mast };
}
function deck_y_at(grp,x,z,fallback){
	if(deck_grid){ const g=deck_grid, gi=Math.floor((carrier_fore_aft(x,z)-g.minFa)/g.cell), gj=Math.floor((carrier_lateral(x,z)-g.minLat)/g.cell);
		if(gi>=0&&gi<g.W&&gj>=0&&gj<g.H){ const y=g.data[gj*g.W+gi]; if(!Number.isNaN(y)) return y; } return fallback; }
	_ray.set(new THREE.Vector3(x,5000,z), new THREE.Vector3(0,-1,0)); const hits=_ray.intersectObject(grp,true); return hits.length?hits[0].point.y:fallback; }
// Place ownship on the configured catapult (deck height found by raycast when a model carrier is present).
function place_on_cat(i=cat_idx){
	// A cat pose ({x,z} offset, h launch heading) was tuned at yaw 90; rotate it by the
	// carrier's yaw delta so it tracks the ship when the heading changes. R_y: x'=x·c+z·s, z'=−x·s+z·c.
	const cat=SHIP.shuttles[i], yaw_delta=(SHIP.yaw-(SHIP.bow??90))*D2R, c=Math.cos(yaw_delta), s=Math.sin(yaw_delta);
	const sx=CARRIER.x+(cat.x*c+cat.z*s), sz=CARRIER.z+(-cat.x*s+cat.z*c);   // the SHUTTLE, in world
	const hd=cat.h*D2R, fx=Math.cos(hd), fz=-Math.sin(hd);
	const fwd=new THREE.Vector3(fx*c+fz*s,0,-fx*s+fz*c);
	const nose=(AIRCRAFT_MODELS[own_aircraft()]||AIRCRAFT_MODELS.fa18c).nose||5.3;
	const wx=sx-fwd.x*nose, wz=sz-fwd.z*nose;   // park the origin one nose-gear length behind the shuttle
	const dy=carrier_model?deck_y_at(carrier_model,wx,wz,CARRIER.deckY):CARRIER.deckY;
	ownship.pos.set(wx, dy+((AIRCRAFT_MODELS[own_aircraft()]||AIRCRAFT_MODELS.fa18c).stance||GEAR), wz); ownship.fwd.copy(fwd); ownship.vel_dir.copy(fwd);
	const r=new THREE.Vector3().crossVectors(fwd,world_up).normalize(), u=new THREE.Vector3().crossVectors(r,fwd).normalize();
	ownship.q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(fwd,u,r)); }
async function init_carrier_model(){
	const tag=SHIP.url.startsWith("data:")?"embedded carrier":SHIP.url;
	try{ 
		let abuf;
		if(SHIP.url.startsWith("data:")){ const b64=SHIP.url.slice(SHIP.url.indexOf(",")+1); const bin=atob(b64);
			const u=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i); abuf=u.buffer; }
		else { abuf=await asset_bytes(SHIP.url); }   // preload-owned download: single-flight with the menu's early start
		const parts=glb_split(abuf); const M=(parts.json.materials||[]).find(m=>m.pbrMetallicRoughness&&m.pbrMetallicRoughness.baseColorTexture)||{};   // the first material CARRYING a texture (the Ford's was materials[0]; the Nimitz's baked deck material sits at the end)
		const baseSrc=glb_image(parts, M.pbrMetallicRoughness&&M.pbrMetallicRoughness.baseColorTexture&&M.pbrMetallicRoughness.baseColorTexture.index);
		const normSrc=glb_image(parts, M.normalTexture&&M.normalTexture.index);
		(parts.json.materials||[]).forEach(m=>{ if(m.pbrMetallicRoughness){ delete m.pbrMetallicRoughness.baseColorTexture; delete m.pbrMetallicRoughness.metallicRoughnessTexture; } delete m.normalTexture; delete m.occlusionTexture; delete m.emissiveTexture;
			for(const ext of Object.values(m.extensions||{})){ for(const key of Object.keys(ext)){ if(key.endsWith("Texture")) delete ext[key]; } } });   // extension-held refs too (KHR_materials_specular etc.) — a dangling texture index kills the parse
		delete parts.json.textures; delete parts.json.images; delete parts.json.samplers;
		const clean=glb_repack(parts.json, parts.bin);
		const shiploader=new GLTFLoader(); shiploader.setMeshoptDecoder(MeshoptDecoder);   // the carrier ships meshopt-compressed
		shiploader.parse(clean, "", async gltf=>{ try{
			const gscene=gltf.scene; gscene.updateMatrixWorld(true);
			const b0=new THREE.Box3().setFromObject(gscene), sz=b0.getSize(new THREE.Vector3());
			const s=SHIP.length/Math.max(sz.x,sz.y,sz.z,1e-3);
			const c0=b0.getCenter(new THREE.Vector3()); gscene.position.sub(c0);   // centre the MODEL's OWN bbox at the group origin: the deck-ops frame must be the model's local frame, independent of yaw — centring on the world AABB after rotation shifted the origin 8 m to starboard on this asymmetric hull (the rotated AABB's centre is not the rotated centre), which put every measured cat/wire/OLS coordinate 8 m off the drawn deck
			const grp=new THREE.Group(); grp.add(gscene); grp.scale.setScalar(s); grp.rotation.y=SHIP.yaw*D2R;
			grp.position.set(CARRIER.x,0,CARRIER.z); grp.updateMatrixWorld(true);
			const st=model_y_stats(grp); const waterline=st.keelY+SHIP.draft*(st.deckY-st.keelY);   // sink so waterline -> y=0
			grp.position.y-=waterline; grp.updateMatrixWorld(true);
			build_deck_grid(grp, st.deckY-waterline);   // one triangle pass replaces every startup deck raycast
			let baseTex=null,normTex=null;
			if(baseSrc&&typeof createImageBitmap==="function"){ try{ baseTex=await make_tex(baseSrc,true); }catch{ /* texture optional */ } }
			if(normSrc&&typeof createImageBitmap==="function"){ try{ normTex=await make_tex(normSrc,false); }catch{ /* texture optional */ } }
			grp.traverse(o=>{ if(o.isMesh&&o.material){ const mm=o.material; const hasuv=!!(o.geometry&&o.geometry.attributes&&o.geometry.attributes.uv);
				if(baseTex&&hasuv)mm.map=baseTex; if(normTex&&hasuv)mm.normalMap=normTex; mm.metalness=0.0; mm.roughness=0.9; mm.needsUpdate=true; o.castShadow=cfg.shadows; o.receiveShadow=true; } });   // the map goes only where UVs exist: on the Nimitz only the baked deck strip has them (a map without UVs renders garbage)
			carrier_model=grp; scene.add(grp);
			/* procedural carrier removed; nothing to hide */
			const yd=(SHIP.yaw-(SHIP.bow??90))*D2R, dc=Math.cos(yd), ds=Math.sin(yd);                        // rotate the sample spot with the carrier heading (yaw - bow: the deck-ops frame, see the nimitz config)
			CARRIER.deckY=deck_y_at(grp, CARRIER.x+(70*dc-6*ds), CARRIER.z+(-70*ds-6*dc), st.deckY-waterline);   // deck height near the catapult spot (carrier-relative)
			build_carrier_deck_aids();   // wires + OLS, now that the deck height is known
			if(mission_start()==="carrier" && !ownship.launching && ownship.speed<5){ place_on_cat(); flight_push(); }   // re-spot on the cat at the now-known deck height, unless already taxiing / launched
		}catch(e){ throw new Error("carrier model: failed to process "+tag+": "+(e&&e.message||e)); } },
		err=>{ throw new Error("carrier model: parse failed for "+tag+" ("+((err&&err.message)||"bad glTF")+")"); });
	}catch(e){ throw new Error("carrier model: not loaded "+tag+" ("+((e&&e.message)||e)+")"); }
}

// ============================================================================ particles (proven)
function glow_texture(soft){ const c=document.createElement("canvas"); c.width=c.height=128; const x=c.getContext("2d");
	// Smoke is an irregular, overlapping lobe field rather than a radial dot.
	// The deterministic lobes keep captures stable while rotation in the point
	// shader prevents repeated puffs from exposing the shared source texture.
	if(soft){ x.clearRect(0,0,128,128); const lobes=[[64,62,47,.24],[43,67,34,.19],[82,47,31,.17],[83,79,36,.17],[55,39,28,.15],[39,43,23,.11]];
		for(const [cx,cy,r,a] of lobes){ const g=x.createRadialGradient(cx,cy,0,cx,cy,r); g.addColorStop(0,`rgba(205,205,205,${a})`); g.addColorStop(.58,`rgba(155,155,155,${a*.55})`); g.addColorStop(1,"rgba(145,145,145,0)"); x.fillStyle=g; x.fillRect(cx-r,cy-r,r*2,r*2); } }
	else { const g=x.createRadialGradient(64,64,0,64,64,64); g.addColorStop(0,"rgba(255,255,255,1)"); g.addColorStop(0.3,"rgba(255,240,200,0.9)"); g.addColorStop(1,"rgba(255,200,120,0)"); x.fillStyle=g; x.fillRect(0,0,128,128); }
	return new THREE.CanvasTexture(c); }
function make_points(max,size,additive,tex,sized){ const geo=new THREE.BufferGeometry();
	geo.setAttribute("position",new THREE.BufferAttribute(new Float32Array(max*3),3)); geo.setAttribute("color",new THREE.BufferAttribute(new Float32Array(max*3),3));
	const mat=new THREE.PointsMaterial({size,map:tex,vertexColors:true,transparent:true,blending:additive?THREE.AdditiveBlending:THREE.NormalBlending,depthWrite:false,sizeAttenuation:true,fog:!additive});
	// sized (#239): per-particle scale and alpha, injected into the points
	// shader. Smoke needs both — real smoke GROWS as it disperses and fades by
	// TRANSPARENCY, where the stock colour-fade dimmed every puff to black
	// under normal blending (smoke that darkens as it dies is backwards: soot
	// is darkest at birth and pales as it thins).
	if(sized){ geo.setAttribute("grow",new THREE.BufferAttribute(new Float32Array(max),1)); geo.setAttribute("fade",new THREE.BufferAttribute(new Float32Array(max),1)); geo.setAttribute("spin",new THREE.BufferAttribute(new Float32Array(max),1));
		mat.onBeforeCompile=(sh)=>{
			sh.vertexShader="attribute float grow;\nattribute float fade;\nattribute float spin;\nvarying float vFade;\nvarying float vSpin;\n"+sh.vertexShader.replace("gl_PointSize = size;","gl_PointSize = size * grow;\n\tvFade = fade;\n\tvSpin = spin;");
			sh.fragmentShader="varying float vFade;\nvarying float vSpin;\n"+sh.fragmentShader.replace("vec4 diffuseColor = vec4( diffuse, opacity );","vec4 diffuseColor = vec4( diffuse, opacity * vFade );\n// Cheap hemispheric volume cue: the upper lobe catches sky/sun while the lower core stays dense.\ndiffuseColor.rgb *= 0.72 + 0.42 * smoothstep(0.0, 1.0, 1.0-gl_PointCoord.y);").replace("vec2 uv = ( uvTransform * vec3( gl_PointCoord.x, 1.0 - gl_PointCoord.y, 1 ) ).xy;","vec2 pc=gl_PointCoord-0.5; float cs=cos(vSpin), sn=sin(vSpin); pc=mat2(cs,-sn,sn,cs)*pc; vec2 uv=(uvTransform*vec3(pc+0.5,1)).xy;");
			// The replaces target THREE r160's exact chunk text; a reworded upgrade
			// would otherwise drop growth/fade/rotation SILENTLY (invisible smoke
			// or static puffs, no error anywhere).
			if(!sh.vertexShader.includes("size * grow")||!sh.fragmentShader.includes("opacity * vFade")||!sh.fragmentShader.includes("mat2(cs,-sn,sn,cs)")) console.warn("points shader injection missed a token — THREE chunk text changed; sized-particle growth/fade/spin are OFF"); }; }
	const pts=new THREE.Points(geo,mat); pts.frustumCulled=false; pts.userData.sized=!!sized; scene.add(pts); return pts; }
const glow=glow_texture(false), soft=glow_texture(true);
function light_dot_texture(){ const c=document.createElement("canvas"); c.width=c.height=64; const x=c.getContext("2d"); const g=x.createRadialGradient(32,32,0,32,32,32);   // crisp light point (solid core, quick falloff) — no big halo, unlike the soft `glow`
	g.addColorStop(0,"rgba(255,255,255,1)"); g.addColorStop(0.36,"rgba(255,255,255,1)"); g.addColorStop(0.6,"rgba(255,255,255,0.3)"); g.addColorStop(1,"rgba(255,255,255,0)");   // solid opaque core → bright + crisp
	x.fillStyle=g; x.fillRect(0,0,64,64); return new THREE.CanvasTexture(c); }
const light_dot=light_dot_texture();
function windsock_texture(){ const c=document.createElement("canvas"); c.width=8; c.height=160; const x=c.getContext("2d");   // 5 alternating orange/white bands along the length (standard windsock)
	const cols=["#e8531a","#f2f2f2"]; for(let i=0;i<5;i++){ x.fillStyle=cols[i%2]; x.fillRect(0,i*32,8,32); }
	const t=new THREE.CanvasTexture(c); t.colorSpace=THREE.SRGBColorSpace; return t; }
function pool(max){ return { px:new Float32Array(max),py:new Float32Array(max),pz:new Float32Array(max), vx:new Float32Array(max),vy:new Float32Array(max),vz:new Float32Array(max),
	life:new Float32Array(max),ttl:new Float32Array(max), r:new Float32Array(max),g:new Float32Array(max),b:new Float32Array(max),
	sz:new Float32Array(max),gr:new Float32Array(max), spin:new Float32Array(max), seed:new Float32Array(max), activeList:[], pos:new Int32Array(max),   // sized pools only (#239): scale at birth, growth per second of age
	active:new Uint8Array(max), max, next:0 }; }
function pool_spawn(p){ if(p.activeList.length>=(p.limit??p.max)) return -1; for(let i=0;i<p.max;i++){ const k=(p.next+i)%p.max; if(!p.active[k]){ p.next=(k+1)%p.max; p.active[k]=1; p.seed[k]=Math.random()*1000; p.spin[k]=Math.random()*Math.PI*2;
		// A caller can retire a slot between physics ticks (missile impact, reset).
		// Remove that stale index before reusing it or it would simulate twice.
		// O(1) via the position map (indexOf scanned the whole live list per
		// spawn); list order is immaterial — one draw call renders the pool —
		// so a swap-remove is safe.
		const sp=p.pos[k]; if(sp<p.activeList.length&&p.activeList[sp]===k){ const last=p.activeList.pop(); if(sp<p.activeList.length){ p.activeList[sp]=last; p.pos[last]=sp; } }
		p.pos[k]=p.activeList.length; p.activeList.push(k); return k; } } return -1; }
const TR_MAX=4000,FL_MAX=2500,SM_MAX=3000,ST_MAX=1200,DB_MAX=260;
const tracers=pool(TR_MAX),flares=pool(FL_MAX),smoke=pool(SM_MAX),strikes=pool(ST_MAX),debris=pool(DB_MAX);
function effects_limits(){ const q=Math.max(0,Math.min(3,Number(cfg.effects_quality??2))), scale=[.28,.52,.78,1][q]; smoke.limit=Math.floor(SM_MAX*scale); strikes.limit=Math.floor(ST_MAX*scale); debris.limit=Math.max(60,Math.floor(DB_MAX*scale)); flares.limit=Math.max(500,Math.floor(FL_MAX*scale)); }
effects_limits();   // and again from apply_effects: computed only at boot, a Settings change over a paused mission silently did nothing until reload
const tr_pts=make_points(TR_MAX,4,false,glow), fl_pts=make_points(FL_MAX,26,true,glow), sm_pts=make_points(SM_MAX,70,false,soft,true);   // tracers: small + NORMAL blend (additive blew the colour out to white against bright sky); smoke is SIZED (per-particle growth + alpha fade, #239)
const db_pts=make_points(DB_MAX,5,false,glow);   // debris (#239): dark shed panels and wreck chunks — normal-blended dots on ballistic arcs, decoupled from the aircraft's path (the gun-camera signature of coming apart)
// Strike flashes get their OWN pool, and it is ADDITIVE. Borrowing the tracer
// pool inherited that pool's normal blending, which is right for a tracer (a
// lit round, read against bright sky) and wrong for an impact: a flash is
// emissive, and normal-blended it came out the same dull amber as the tracer
// that caused it — indistinguishable from the stream, over both a grey
// airframe and the sky. Borrowing also inherited `tr_pts.visible=cfg.tracers`,
// so switching tracers off silently switched hit flashes off with them.
const strike_pts=make_points(ST_MAX,9,true,glow);
function flush_points(p,pts){ const pos=pts.geometry.attributes.position.array,col=pts.geometry.attributes.color.array; let n=0;
	const sized=pts.userData.sized, grow=sized?pts.geometry.attributes.grow.array:null, fade=sized?pts.geometry.attributes.fade.array:null, spin=sized?pts.geometry.attributes.spin.array:null;
	for(const i of p.activeList){ if(!p.active[i]) continue; const o=n*3; pos[o]=p.px[i];pos[o+1]=p.py[i];pos[o+2]=p.pz[i];
		if(sized){
			// Smoke life (#239, from the gun-camera study): the puff GROWS as it
			// disperses, fades by alpha (fast in, slow out), and its colour
			// PALES with age toward a neutral haze — soot is darkest at birth.
			const left=Math.max(0,p.life[i]/p.ttl[i]), age=1-left, elapsed=age*p.ttl[i];
			grow[n]=p.sz[i]+p.gr[i]*elapsed;
			spin[n]=p.spin[i]+elapsed*(0.08+0.08*Math.sin(p.seed[i]));
			fade[n]=Math.min(1,elapsed/0.12)*Math.pow(left,0.6);   // fade-in on WALL time: a fraction-of-ttl ramp left long-lived soot invisible for its first half second — the part nearest the jet
			const t=age*0.75; col[o]=p.r[i]+(0.62-p.r[i])*t; col[o+1]=p.g[i]+(0.62-p.g[i])*t; col[o+2]=p.b[i]+(0.64-p.b[i])*t;
		} else {
			const f=Math.max(0,p.life[i]/p.ttl[i]); col[o]=p.r[i]*f;col[o+1]=p.g[i]*f;col[o+2]=p.b[i]*f; }
		n++; }
	pts.geometry.setDrawRange(0,n); pts.geometry.attributes.position.needsUpdate=true; pts.geometry.attributes.color.needsUpdate=true;
	if(sized){ pts.geometry.attributes.grow.needsUpdate=true; pts.geometry.attributes.fade.needsUpdate=true; pts.geometry.attributes.spin.needsUpdate=true; }
	return n; }
let _live_particles=0;
function update_pool_ballistic(p,dt,grav,drag,round){ const live=[]; for(const i of p.activeList){ if(!p.active[i]) continue;
	p.vy[i]-=grav*dt; if(drag){p.vx[i]*=drag;p.vy[i]*=drag;p.vz[i]*=drag;}
	if(round){ const sp=Math.hypot(p.vx[i],p.vy[i],p.vz[i]); if(sp>1){ const k=1/(1+sp*dt/round_length(p.py[i]));   // the quadratic drag the real 20 mm round flies (battle.Fly): the tracer IS the round the pilot corrects by
		p.vx[i]*=k;p.vy[i]*=k;p.vz[i]*=k; } }
	// Trade-wind advection plus low-frequency curl-like drift. It is deliberately
	// cheap and only applied to smoke; hot puffs also rise through negative grav.
	if(p===smoke){ const age=p.ttl[i]-p.life[i], q=p.seed[i]; p.vx[i]+=(2.8+Math.sin(q+age*.7)*1.7-p.vx[i]*.018)*dt; p.vz[i]+=(.8+Math.cos(q*.71+age*.55)*1.5-p.vz[i]*.018)*dt; }
	p.px[i]+=p.vx[i]*dt; p.py[i]+=p.vy[i]*dt; p.pz[i]+=p.vz[i]*dt; p.life[i]-=dt; if(p.life[i]<=0||p.py[i]<0) p.active[i]=0; else { p.pos[i]=live.length; live.push(i); } } p.activeList=live; }

const muzzle=1050; const gun={};
// 20 mm drag (mirrors battle.Length/Average in Go): quadratic drag decays the
// round's speed exponentially with distance, v(x)=v0*exp(-x/L), L=2,600 m at
// sea level stretching as the air thins — fitted to the published M56/PGU-28
// tables (~700 m/s and 1.16 s at a thousand metres). Every consumer of the
// round — the flying tracers, the director pipper, the funnel — must share
// this or the pilot walks a burst by tracers that lie about where rounds go.
const ROUND_LENGTH=2600;
function round_length(alt){ return ROUND_LENGTH*Math.exp(Math.max(alt,0)/8500); }
function round_average(span,alt){ if(span<1) return muzzle; const l=round_length(alt); return span*muzzle/(l*Math.expm1(span/l)); }
const MAGAZINE=578;   // the M61's load: the ownship's magazine, and the nominal the bandit's expenditure is reported against
function fire_gun(st,target,key,dt,force){
	let active;
	if(force!==undefined) active=force;
	else { const to=target.pos.clone().sub(st.pos); const rng=to.length(); active=(rng<2500 && st.fwd.dot(to.normalize())>0.985); }
	if(!active) return 0; if(st.rounds!==undefined && st.rounds<=0) return 0; if(!cfg.tracers && st===ownship) { /* own-ship tracers suppressed */ } // tracers toggle only affects render
	const rps=100; gun[key]=(gun[key]||0)+rps*dt;   // M61 Vulcan: 6000 rpm = 100 rounds/sec
	let fired=0;
	const spend=(n)=>{ st.spent=(st.spent||0)+n; };   // every shooter's running expenditure: survives the ammunition cheat's refill (#258), so what was actually fired stays observable
	while(gun[key]>=1){ gun[key]-=1; fired++; if(st.rounds!==undefined){ if(st.rounds<=0) break; st.rounds--; if(cheat("ammunition")) st.rounds=MAGAZINE; }   // infinite AMMUNITION, not a gun that stops counting (#258): the round is spent and the magazine refills, mirroring the server, so expenditure stays observable and the two counters cannot drift
		const tr=(Math.floor(gun[key+"_n"]||0)%5)===0; gun[key+"_n"]=(gun[key+"_n"]||0)+1;
		if(!tr) continue;   // only 1 in 5 rounds is a visible tracer; the rest fire invisibly
		const k=pool_spawn(tracers); if(k<0) break; const sp=body_offset(st,6.53,0.43,0.0);   // the M61 port: nose-top centreline, ~0.9 m ahead of and ~0.12 m below the pilot's eye (runtime-calibrated at 5.61/0.55 from Pilot_Head_769) — matches the server's hitscan muzzle
		tracers.px[k]=sp.x;tracers.py[k]=sp.y;tracers.pz[k]=sp.z; const spread=0.004;
		tracers.vx[k]=st.fwd.x*muzzle+(Math.random()-0.5)*spread*muzzle+st.velx;
		tracers.vy[k]=st.fwd.y*muzzle+(Math.random()-0.5)*spread*muzzle+st.vely;
		tracers.vz[k]=st.fwd.z*muzzle+(Math.random()-0.5)*spread*muzzle+st.velz;
		tracers.ttl[k]=tracers.life[k]=1.8;   // ~1.8s @1050m/s -> ~1900m burnout (real 20mm tracer range; no drag in this sim)
		tracers.r[k]=1.3;tracers.g[k]=0.42;tracers.b[k]=0.1; }   // red-orange; normal-blended (see tr_pts) so the colour reads instead of blowing out white
	spend(fired);
	return fired; }
const _flare_timer={bandit:4.5};
function dispense_flares(st){ for(let i=0;i<36;i++){ const k=pool_spawn(flares); if(k<0) break; const sp=local_offset(st,-2,-0.3,0);
	flares.px[k]=sp.x;flares.py[k]=sp.y;flares.pz[k]=sp.z; flares.vx[k]=st.velx*0.5+(Math.random()-0.5)*40; flares.vy[k]=st.vely*0.5-Math.random()*25; flares.vz[k]=st.velz*0.5+(Math.random()-0.5)*40;
	flares.ttl[k]=flares.life[k]=3.5+Math.random()*1.5; flares.r[k]=2.6;flares.g[k]=2.3;flares.b[k]=1.2; } }   // brilliant white-hot with a warm tinge (burning magnesium), not orange
const MSL_MAX=32;   // in-flight pool (own missiles): sized for infinite-ammunition ripple fire — a fast finger against 20 s missile lives peaks in the twenties; was 8, saturated the day the cheat landed
const missile_geo=(()=>{ const parts=[]; const b=new THREE.CylinderGeometry(0.12,0.12,2.4,12); b.rotateZ(-Math.PI/2); parts.push(b);
	const n=new THREE.ConeGeometry(0.12,0.5,12); n.rotateZ(-Math.PI/2); n.translate(1.45,0,0); parts.push(n);
	for(const s of [0,1,2,3]){ const f=new THREE.BoxGeometry(0.4,0.02,0.3); f.translate(-1.0,0,0); f.rotateX(s*Math.PI/2); parts.push(f); } return merge_geometries(parts); })();
const missile_mat=new THREE.MeshStandardMaterial({color:0xdedede,metalness:0.3,roughness:0.6});
const missile_trail_mat=new THREE.LineBasicMaterial({color:0xc9d1d5,transparent:true,opacity:.38,depthWrite:false,fog:true});
const missiles=[]; for(let i=0;i<MSL_MAX;i++){ const m=new THREE.Mesh(missile_geo,missile_mat); m.visible=false; scene.add(m); const tg=new THREE.BufferGeometry(); tg.setAttribute("position",new THREE.BufferAttribute(new Float32Array(30*3),3)); tg.setDrawRange(0,0); const trail=new THREE.Line(tg,missile_trail_mat); trail.frustumCulled=false; trail.visible=false; scene.add(trail);
	missiles.push({mesh:m,active:false,px:0,py:0,pz:0,vx:0,vy:0,vz:0,life:0,target:null,smoke_acc:0,
		burn:0,flew:0,sx:0,sy:0,sz:0,loose:false,blind:0,lx:0,ly:0,lz:0,window:false,trail,trail_n:0,trail_acc:0}); }   // AIM-9M state (#126): boost, arming, seeker sight line, broken lock, and a swallowed flare's fall point
function launch_missile(st,target){ const m=missiles.find(x=>!x.active); if(!m) return false;
	let sp=local_offset(st,1,-0.8,0);   // fallback: near the nose
	if(st.group&&st.msl>0){ let rail=null;
		if(st.loadout){ const order=stores_rounds(st.loadout); const next=order[Math.max(0,order.length-st.msl)];   // the round about to depart, in the SMS priority order (#17)
			if(next&&next.name.startsWith("tip")) rail=st.group.getObjectByName(TIP_NODES[next.name]);
			else if(next){ const piece=st.racks&&st.racks.nodes&&st.racks.nodes[next.name];   // rack rounds carry baked geometry offset by a delta, so the node origin is NOT the round — take the drawn centre
				if(piece){ _launch_box.setFromObject(piece); _launch_box.getCenter(_v); sp={x:_v.x,y:_v.y,z:_v.z}; } } }
		else rail=st.group.getObjectByName(MISSILE_NODES[(st.msl-1)%MISSILE_NODES.length]);   // no known loadout (remote before its roster): the legacy alternating tips
		if(rail){ rail.getWorldPosition(_v); sp={x:_v.x,y:_v.y,z:_v.z}; } }
	m.active=true; m.mesh.visible=true; m.px=sp.x;m.py=sp.y;m.pz=sp.z;
	m.trail_n=1; m.trail_acc=0; { const a=m.trail.geometry.attributes.position.array; a[0]=sp.x;a[1]=sp.y;a[2]=sp.z; m.trail.geometry.setDrawRange(0,1); m.trail.visible=(cfg.effects_quality??2)>0; }
	m.vx=st.fwd.x*(st.speed+30); m.vy=st.fwd.y*(st.speed+30); m.vz=st.fwd.z*(st.speed+30);   // off the rail at aircraft speed; the Mk 36 does the rest
	m.life=20; m.target=target; m.smoke_acc=0; m.burn=3.0; m.flew=0; m.loose=false; m.blind=0; m.window=false; m.least=1e9; m.why=""; m.at=-1; m.mask=-1; m.killed=false; m.prate=undefined;
	if(target){ const dx=wrap_axis(target.pos.x-st.pos.x), dy=target.pos.y-st.pos.y, dz=wrap_axis(target.pos.z-st.pos.z); const d=Math.hypot(dx,dy,dz)||1;
		const tail=target.fwd?Math.max(0,(dx*target.fwd.x+dy*target.fwd.y+dz*target.fwd.z)/d):0;
		const floor=0.15+0.35*THREE.MathUtils.clamp(target.reheat??0,0,1);
		if(d>5000*(floor+(1-floor)*tail)){ m.loose=true; if(DEV_MODE) m.why="cold"; } }   // launched without acquisition (#255): the round departs ballistic — the seeker never had him, exactly as the lock tone warned
	if(target){ const d=Math.hypot(target.pos.x-m.px,target.pos.y-m.py,target.pos.z-m.pz)||1;
		m.sx=(target.pos.x-m.px)/d; m.sy=(target.pos.y-m.py)/d; m.sz=(target.pos.z-m.pz)/d; }
	return true; }
const _v=new THREE.Vector3();
const _launch_box=new THREE.Box3();
// trigger_missile: the 9M edge of the fire trigger, shared by the keyboard's
// keydown and the pad trigger's press. The pad path CALLS this rather than
// synthesising a Space keydown: the synthetic event (sent with deliberately no
// matching keyup, to protect held fire) wedged Space into the held-keys set,
// after which BOTH the real key and the trigger skipped the edge block until a
// real press-release cleared it — the trigger "only worked after pressing
// space, which did nothing".
function trigger_missile(){
	if(master!=="9m" || weapons_hold || ownship.launching || (ownship.gear??0)<=0.98 || ownship.msl<=0) return;   // an unarmed loadout has no rounds, so msl covers the retired missiles flag (#17)
	if(MULTIPLAYER) missile_flag=true;
	if(launch_missile(ownship,MULTIPLAYER?(remotes.get(designated)||remote_nearest()):(has_enemy?bandit:null))){ if(!cheat("ammunition")) ownship.msl--; audio_launch(); update_rails(ownship,ownship.msl); }
}
function update_missiles(dt){ for(const m of missiles){ if(!m.active){ m.trail.visible=false; continue; } m.life-=dt; m.flew+=dt;
	if(DEV_MODE&&m.target){ const md=wrap_distance({x:m.px,y:m.py,z:m.pz},m.target.pos); if(md<(m.least??1e9)) m.least=md; }   // terminal telemetry for dev_missiles
	const post=(why)=>{ if(DEV_MODE){ const log=(globalThis as any).dev_missiles=(globalThis as any).dev_missiles||[]; log.push({why, least:+(m.least??-1).toFixed(1), flew:+m.flew.toFixed(1), loose:!!m.loose, broke:m.why||"", at:m.at??-1, mask:m.mask??-1, killed:!!m.killed}); } };
	if(m.life<=0){ m.active=false; m.mesh.visible=false; post("life"); continue; }
	// The AIM-9M (#126), mirroring the server: proportional navigation with a
	// gimballed, rate-limited seeker; boost-coast propulsion paying for every
	// turn in drag; a fuse that arms after separation; flares that SEDUCE.
	let spd=Math.hypot(m.vx,m.vy,m.vz)||1;
	const t=m.target;
	let tracking=!m.loose && m.blind<=0 && !!t && (t!==bandit || bandit.group.visible);
	// Bandit flares: one seduction roll per flare window (SP only — MP damage is the server's).
	if(tracking && t===bandit && sim_time-(bandit.flared_at??-9)<0.8){
		if(!m.window){ m.window=true;
			const dx=m.px-bandit.pos.x, dy=m.py-bandit.pos.y, dz=m.pz-bandit.pos.z; const dd=Math.hypot(dx,dy,dz)||1;
			const tail=THREE.MathUtils.clamp(-(dx*bandit.fwd.x+dy*bandit.fwd.y+dz*bandit.fwd.z)/dd,0,1);
			let decoy=(0.35+0.40*(1-tail))*0.55;
			if((bandit.reheat??0)>0.05) decoy*=0.5;   // the burner is the brightest thing in view (mirrors the server — the client never had this factor)
			if(Math.random()<decoy){ m.blind=1.5; m.lx=bandit.pos.x; m.ly=bandit.pos.y-30; m.lz=bandit.pos.z; tracking=false;
				const sx=m.lx-m.px, sy=m.ly-m.py, sz=m.lz-m.pz, sd=Math.hypot(sx,sy,sz)||1;   // the seeker is ON the flare now: re-reference the track, or the aim-point swap reads as an LOS-rate spike and breaks the lock at the seduction instant (mirrors the server)
				m.sx=sx/sd; m.sy=sy/sd; m.sz=sz/sd; } }
	} else if(!(t===bandit && sim_time-(bandit.flared_at??-9)<0.8)) m.window=false;
	// Proximity fuse (armed): independent of the seeker — a broken lock leaves the
	// warhead live, and it detonates at the CLOSEST APPROACH within this step, not
	// at the first frame-sampled range under the envelope (which burst at 8-12 m,
	// outside the 5 m lethal radius, and never at all once the terminal LOS rate
	// broke the lock against an evading target). Mirrors the server (#133 follow-up).
	if(m.flew>0.6 && t && t.group && t.group.visible){
		const rx=wrap_axis(t.pos.x-m.px), ry=t.pos.y-m.py, rz=wrap_axis(t.pos.z-m.pz);
		const cvx=(t.velx??t.fwd.x*t.speed)-m.vx, cvy=(t.vely??t.fwd.y*t.speed)-m.vy, cvz=(t.velz??t.fwd.z*t.speed)-m.vz;
		const squared=cvx*cvx+cvy*cvy+cvz*cvz;
		const ts=squared>1e-9?THREE.MathUtils.clamp(-(rx*cvx+ry*cvy+rz*cvz)/squared,0,dt):0;
		const nx=rx+cvx*ts, ny=ry+cvy*ts, nz=rz+cvz*ts;
		if(Math.hypot(nx,ny,nz)<12){ m.active=false; m.mesh.visible=false;
			const bx=t.pos.x-nx, by=t.pos.y-ny, bz=t.pos.z-nz;   // the missile at its nearest point, anchored to the target
			if(!MULTIPLAYER&&has_enemy&&t===bandit){ const verdict=battle_blast(0,{x:bx,y:by,z:bz},battle_aim(bandit),0,battle_tick);
				if(DEV_MODE){ m.mask=verdict.mask; m.killed=verdict.kill; }
				explosion_at(bx,by,bz); if(verdict.kill){ own_kills++; bandit_destroy(); } }
			post("fuse");
			continue; } }
	let ax=0, ay=0, az=0, guided=false;
	if(tracking){ ax=t.pos.x; ay=t.pos.y; az=t.pos.z; guided=true; }
	else if(m.blind>0){ m.blind-=dt; m.ly-=45*dt; ax=m.lx; ay=m.ly; az=m.lz; guided=true;
		if(m.blind<=0){ if(DEV_MODE&&!m.loose){ m.why="flare"; } m.loose=true; } }   // a swallowed flare is terminal: the seeker stares at the burnt-out decoy and never re-acquires (9M-realistic) — ballistic from here, fuse still live; mirrors the server
	if(guided && m.flew>0.6){
		const dx=ax-m.px, dy=ay-m.py, dz=az-m.pz; const dist=Math.hypot(dx,dy,dz)||1e-6;
		const ux=dx/dist, uy=dy/dist, uz=dz/dist;
		const axl=m.vx/spd, ayl=m.vy/spd, azl=m.vz/spd;
		if(ux*axl+uy*ayl+uz*azl<0.766){ if(DEV_MODE&&!m.loose){ m.why="gimbal"; m.at=+dist.toFixed(0); } m.loose=true; }   // ±40° gimbal: the lock breaks
		let rx=(ux-m.sx)/Math.max(dt,1e-6), ry=(uy-m.sy)/Math.max(dt,1e-6), rz=(uz-m.sz)/Math.max(dt,1e-6);
		const along=rx*ux+ry*uy+rz*uz; rx-=along*ux; ry-=along*uy; rz-=along*uz;   // the rotation component of the LOS motion
		const rate=Math.hypot(rx,ry,rz);
		const paced=(rate+(m.prate??rate))/2; m.prate=rate;   // two-frame average: the bandit advances in whole 1/60 s quanta, so off-60 fps render frames see its motion as alternating spikes — judge the ceiling on the mean, not the artifact
		if(paced>0.35){ if(DEV_MODE&&!m.loose){ m.why="rate"; m.at=+dist.toFixed(0); } m.loose=true; }   // the seeker's track ceiling — beaming saturates it
		m.sx=ux; m.sy=uy; m.sz=uz;
		if(!m.loose){
			// PROPORTIONAL NAVIGATION: a = N·Vc·λ̇ — fly the collision course.
			const tvx=tracking?(t.velx??t.fwd.x*t.speed):0, tvy=tracking?(t.vely??t.fwd.y*t.speed):0, tvz=tracking?(t.velz??t.fwd.z*t.speed):0;
			const closing=Math.abs((tvx-m.vx)*ux+(tvy-m.vy)*uy+(tvz-m.vz)*uz);
			let gx=rx*3.5*closing, gy=ry*3.5*closing, gz=rz*3.5*closing;
			const limit=35*9.81*THREE.MathUtils.clamp(spd/600,0.15,1);
			const pull=Math.hypot(gx,gy,gz);
			if(pull>limit){ gx*=limit/pull; gy*=limit/pull; gz*=limit/pull; }
			m.vx+=gx*dt; m.vy+=gy*dt; m.vz+=gz*dt;
			spd=Math.hypot(m.vx,m.vy,m.vz)||1;
			const frac=Math.min(1,Math.hypot(gx,gy,gz)/(35*9.81));
			const bleed=5e-5*spd*spd*(1+3*frac*frac);
			const next=Math.max(spd-bleed*dt,60)/spd; m.vx*=next; m.vy*=next; m.vz*=next;
			if(m.burn<=0 && tracking){ const ts=Math.hypot(tvx,tvy,tvz);
				if(spd<ts+60 && closing<40){ m.active=false; m.mesh.visible=false; post("energy"); continue; } }   // energy death: it trails off, no dice
		}
	} else if(guided){ const dx=ax-m.px, dy=ay-m.py, dz=az-m.pz; const dd=Math.hypot(dx,dy,dz)||1; m.sx=dx/dd; m.sy=dy/dd; m.sz=dz/dd; }
	if(m.burn>0){ m.burn-=dt; spd=Math.hypot(m.vx,m.vy,m.vz)||1; m.vx+=m.vx/spd*260*dt; m.vy+=m.vy/spd*260*dt; m.vz+=m.vz/spd*260*dt; }
	else if(m.loose||!guided){ spd=Math.hypot(m.vx,m.vy,m.vz)||1; const next=Math.max(spd-5e-5*spd*spd*dt,60)/spd; m.vx*=next; m.vy*=next; m.vz*=next; }
	m.px+=m.vx*dt;m.py+=m.vy*dt;m.pz+=m.vz*dt; m.mesh.position.set(m.px,m.py,m.pz); m.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(1,0,0),new THREE.Vector3(m.vx,m.vy,m.vz).normalize());
	m.trail_acc+=dt; if(m.trail_acc>.035){ m.trail_acc=0; const a=m.trail.geometry.attributes.position.array, n=Math.min(30,m.trail_n+1); if(m.trail_n>=30)a.copyWithin(0,3); const o=(n-1)*3; a[o]=m.px;a[o+1]=m.py;a[o+2]=m.pz; m.trail_n=n; m.trail.geometry.setDrawRange(0,n); m.trail.geometry.attributes.position.needsUpdate=true; }
	if(m.py<=0){ m.active=false; m.mesh.visible=false; post("ocean"); continue; }
	m.smoke_acc+=dt; const puff=m.burn>0?0.02:0.08;   // the motor smokes; the coast barely does (reduced-smoke Mk 36)
	while(m.smoke_acc>puff){ m.smoke_acc-=puff; const k=pool_spawn(smoke); if(k<0) break;
		smoke.px[k]=m.px-m.vx*0.01;smoke.py[k]=m.py;smoke.pz[k]=m.pz-m.vz*0.01; smoke.vx[k]=(Math.random()-0.5)*6;smoke.vy[k]=(Math.random()-0.5)*6+2;smoke.vz[k]=(Math.random()-0.5)*6;
		smoke.ttl[k]=smoke.life[k]=2.8; smoke.sz[k]=0.30+Math.random()*0.12; smoke.gr[k]=0.40;   // thin at the motor, swelling downstream (#239)
		smoke.r[k]=0.7;smoke.g[k]=0.72;smoke.b[k]=0.75; } } }


// ============================================================================ flight
const world_up=new THREE.Vector3(0,1,0);
function make_state(pos,fwd,speed){ return { pos:pos.clone(), fwd:fwd.clone().normalize(), speed, bank:0, group:null,
	break_t:0, break_dir:new THREE.Vector3(1,0,0), velx:0,vely:0,velz:0, gear:1, gearTarget:1, hook:0, hookTarget:0, speedbrake:0, speedbrakeTarget:0 }; }   // gear 0=down 1=up, hook 0=stowed 1=deployed, speedbrake 0=stowed 1=deployed (default clean for the bandit)
function steer(st,desired,dt,max_rate,max_bank){ desired.normalize(); const ang=st.fwd.angleTo(desired); const max=max_rate*dt;
	if(ang>1e-4){ const axis=new THREE.Vector3().crossVectors(st.fwd,desired).normalize(); st.fwd.applyAxisAngle(axis,Math.min(ang,max)).normalize(); }
	const horiz=new THREE.Vector3(desired.x-st.fwd.x,0,desired.z-st.fwd.z); const side=new THREE.Vector3().crossVectors(world_up,st.fwd);
	const bt=THREE.MathUtils.clamp(side.dot(horiz)*4.0,-1,1)*max_bank; st.bank+=(bt-st.bank)*Math.min(1,dt*3);
	st.velx=st.fwd.x*st.speed; st.vely=st.fwd.y*st.speed; st.velz=st.fwd.z*st.speed; st.pos.addScaledVector(st.fwd,st.speed*dt); }
function hold_altitude(d,st,lo,hi){ if(st.pos.y<lo)d.y+=(lo-st.pos.y)*0.002; if(st.pos.y>hi)d.y-=(st.pos.y-hi)*0.002; }
function apply_orientation(st){ const g=st.group,fwd=st.fwd,up=world_up; const right=new THREE.Vector3().crossVectors(fwd,up).normalize(); const trueUp=new THREE.Vector3().crossVectors(right,fwd).normalize();
	g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(fwd,trueUp,right)); g.rotateX(st.bank); g.position.copy(st.pos); }
function local_offset(st,x,y,z){ const right=new THREE.Vector3().crossVectors(st.fwd,world_up).normalize(); const up=new THREE.Vector3().crossVectors(right,st.fwd).normalize();
	return st.pos.clone().addScaledVector(st.fwd,x).addScaledVector(up,y).addScaledVector(right,z); }
function body_offset(st,x,y,z){ const up=st.up||world_up; const right=st.right||new THREE.Vector3().crossVectors(st.fwd,world_up).normalize();
	return st.pos.clone().addScaledVector(st.fwd,x).addScaledVector(up,y).addScaledVector(right,z); }

// ownship = player
const ownship=make_state(new THREE.Vector3(CARRIER.x+70,CARRIER.deckY+1.8,CARRIER.z-6),new THREE.Vector3(1,0,0),0);
ownship.player=true; ownship.q=new THREE.Quaternion(); ownship.up=new THREE.Vector3(0,1,0); ownship.right=new THREE.Vector3(0,0,1);
// magazine: AIM-9s aboard — four everywhere, the real jet's tips plus one
// LAU-127 dual-rail pair (the server arms the same four, and validates). The
// airframe models only the wingtip rails, so missiles three and four launch
// from a visibly clean jet and the stores mass/drag covers at most the two
// tips; #226 owns doing stores properly.
function magazine(){ return stores_rounds(ownship.loadout||loadout()).length; }   // the flown loadout's round count in SMS firing order (#17): four for the Fox 2 fighter, zero for the Gun fighter or a guns-only match
ownship.vel_dir=ownship.fwd.clone(); ownship.throttle=0.85; ownship.burner=0; ownship.rounds=MAGAZINE; ownship.msl=magazine(); ownship.cm=60; ownship.aoa=0; ownship.gload=1;
ownship.launching=false;
// init quaternion from initial fwd
(()=>{ const r=new THREE.Vector3().crossVectors(ownship.fwd,world_up).normalize(); const u=new THREE.Vector3().crossVectors(r,ownship.fwd).normalize();
	ownship.q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(ownship.fwd,u,r)); })();
const bandit=make_state(new THREE.Vector3(3000,2400,-1000),new THREE.Vector3(-0.3,0,1),195);
// ============================================================================ battle (#78)
// Single-player damage authority: the SAME Go battle package the multiplayer
// server runs natively, through the wasm exports. The bandit and every extra
// carry a "hulk" (a model-less hit body); the ownship's wounds land straight
// in the flight core's damage state, so the aero degrades on the next step.
let battle_tick=0, battle_reset=true, battle_rigged=false;
let net_waiting=false;   // joust waiting room (#88): the server holds the lone first player frozen at the ring until the opponent joins
let weapons_hold=false;   // joust weapons hold (#87): guns and missiles inhibited until the MERGE — either aircraft crossing the other's 3/9 line; released by the fighton event (MP) or the local check (SP)
const turn_probe={x:1,y:0,z:0,rate:0};   // developer readout: instantaneous turn rate — the angular rate of the VELOCITY vector (the BFM number), EMA-smoothed
let bandit_brain=false;   // SP joust bandit runs on the wasm brain (#125 phase 2); false = the legacy kinematic AI
let bandit_acc=0;   // fixed-step accumulator for the brain (1/60 s frames, display-rate independent)
let harm_pending=null;   // ?harm dev hook (#105): pending injection kind
let sweep_pending=null;   // ?sweep dev hook (#105): rig entry name to sweep once the model resolves
function apply_harm(kind){ const words=flight_get(); if(!words) return;
	if(kind==="wing"){ for(let i=4;i<8;i++) words[STATE.element+i]=1; }   // left wing outboard: the asymmetry rolls the jet
	if(kind==="engine"){ words[STATE.engine_harm]=0.8; }
	if(kind==="leak"){ words[STATE.leak]=2.0; }
	if(kind==="jam"){ words[STATE.jam+4]=1; }   // rudder frozen
	if(kind==="aileron"){ words[STATE.jam+2]=1; }   // left flaperon frozen — the FCS page must X the AIL row, not TEF (#48)
	if(kind==="brake"){ words[STATE.jam+6]=1; }   // speedbrake actuator frozen
	if(kind==="gear"){ words[STATE.gear_harm+1]=0.8; }   // left main folded (#78)
	if(kind==="fire"){ words[STATE.engine_harm]=0.9; words[STATE.engine_harm+1]=0.9; }   // pre-damaged engines...
	flight_set(words);
	if(kind==="fire"){   // ...then rake the jet from astern through the real battle path: the kindle roll lights the fire honestly (visual verification of the burn trail, #78)
		const pose={ position:{x:ownship.pos.x-ownship.fwd.x*300, y:ownship.pos.y-ownship.fwd.y*300, z:ownship.pos.z-ownship.fwd.z*300},
			forward:{x:ownship.fwd.x,y:ownship.fwd.y,z:ownship.fwd.z}, up:{x:ownship.up.x,y:ownship.up.y,z:ownship.up.z} };
		for(let volley=0;volley<6;volley++) battle_volley(1,{...pose,velocity:{x:ownship.velx,y:ownship.vely,z:ownship.velz}},40,battle_tick+volley); } }   // real rounds now: they arrive over the next frames
let own_burn=[0,0], own_burning=false, own_leak=0;   // ownship condition mirrored from progress()
let eject_flag=false, ejected=false;
bandit.harm={ thrust:0, wing:0, killed:false, burning:false, fire:[0,0], leak:0 };   // zonal summary driving the AI, plus the graded wound channels the visuals read (#244)
bandit.rounds=MAGAZINE;   // the bandit fires from the same 578-round M61 load as the ownship (#233) — fire_gun enforces it. Dry, it keeps pressing its attacks with a silent gun: the brain never learns the belt state, which is what a real pilot out of rounds would do rather than concede
function battle_aim(st){ const q=st.group?st.group.quaternion:ownship.q;
	return { position:{x:st.pos.x,y:st.pos.y,z:st.pos.z}, quaternion:{w:q.w,x:q.x,y:q.y,z:q.z},
		velocity:{x:st.velx??st.fwd.x*st.speed,y:st.vely??st.fwd.y*st.speed,z:st.velz??st.fwd.z*st.speed} }; }   // the target's motion carries it across the rounds' flight
function battle_pose(st){ const up=st.up||world_up; return { position:{x:st.pos.x+st.fwd.x*6,y:st.pos.y+st.fwd.y*6,z:st.pos.z+st.fwd.z*6},
	forward:{x:st.fwd.x,y:st.fwd.y,z:st.fwd.z}, up:{x:up.x,y:up.y,z:up.z},
	velocity:{x:st.velx??st.fwd.x*st.speed,y:st.vely??st.fwd.y*st.speed,z:st.velz??st.fwd.z*st.speed} }; }   // the shooter's velocity rides on every round
function battle_rig(){ battle_rigged=battle_hulk(0,"fa18c");   // battle_rigged: mission start races the async wasm load and battle_hulk silently no-ops until the core lands — the frame loop retries until the rig takes (an unrigged hulk made the bandit UNHITTABLE: every gun burst and missile blast on him no-opped for the whole mission)
	bandit.harm={thrust:0,wing:0,killed:false,burning:false,fire:[0,0],leak:0}; battle_reset=true;
	for(const m of impact_marks.splice(0)) m.parent?.remove(m); }   // a fresh fight starts unscarred — marks otherwise survive the respawn on the persistent bandit group
// bandit_destroy ends the DUEL: a joust is one fight to one kill, so the bandit
// does not respawn — the sky stays empty and the pilot ends the mission from
// the menu (and launches another if they want one). The endless-rematch loop
// this replaces made a victory feel like a lap counter. The match row and the
// recording are written at exit as always; the kill is already on the counters.
function bandit_destroy(){ bandit.fate=bandit.fate||"fire"; bandit.fated=sim_time; explosion_at(bandit.pos.x,bandit.pos.y,bandit.pos.z);
	has_enemy=false; bandit.group.visible=false;
	notice(translate("KILL")); }
let aircraft_lights=null;
ownship.group=make_jet(); bandit.group=make_jet(); scene.add(ownship.group,bandit.group);
ownship.group.userData.player=true; layer_own_group(ownship.group);
build_aircraft_lights(); layer_own_group(ownship.group);   // the nav lights/strobes/landing spot just joined the group — layer them too

// ---- aircraft carrier (static landmark + launch platform) ----
const airports=[]; let island_polygons=[]; let WORLD_WRAP=0;   // 2D-map island outlines; toroidal world size (m, 0 = no wrap) — both set from map.json
// Midway: load the baked map assets (midway-prep, per midway.md) and build the world.
async function generate_world(){
	try{
		const base=new URL("maps/midway/",location.href).href;   // web/public/maps/<name>/ (served via the app.json "maps" route)
		const map=await (await fetch(base+"map.json")).json();
		WORLD_WRAP=map.wrap||0;
		// --- single Sentinel-2 texture for the ocean AND the islands (reef/lagoon/breakers + land) ---
		const texture=await new THREE.TextureLoader().loadAsync(base+"map.jpg");
		texture.flipY=false; texture.wrapS=texture.wrapT=THREE.ClampToEdgeWrapping; texture.colorSpace=THREE.SRGBColorSpace;
		texture.magFilter=THREE.LinearFilter; texture.minFilter=THREE.LinearMipmapLinearFilter; texture.generateMipmaps=true;
		texture.anisotropy=renderer.capabilities.getMaxAnisotropy();
		ocean_mat.uniforms.u_water.value=texture; ocean_mat.uniforms.u_water_half.value=map.region_half; ocean_mat.uniforms.u_water_on.value=1.0;
		// --- atoll-interior calm mask: damps waves inside the reef (incl. the deep lagoon basin) ---
		const lagoon=await new THREE.TextureLoader().loadAsync(base+"lagoon.png");
		lagoon.flipY=false; lagoon.wrapS=lagoon.wrapT=THREE.ClampToEdgeWrapping; lagoon.colorSpace=THREE.NoColorSpace;
		lagoon.magFilter=THREE.LinearFilter; lagoon.minFilter=THREE.LinearMipmapLinearFilter; lagoon.generateMipmaps=true;
		ocean_mat.uniforms.u_lagoon.value=lagoon;
		// --- islands + runway from the real coastline (same texture, planar-mapped by world position) ---
		const coast=await (await fetch(base+"coastline.json")).json();
		build_islands(coast.polygons||[], texture, map.region_half);
		// --- airfields (runway / taxiways / aprons) from OpenStreetMap, per map.json ---
		for(const code of map.airfields||[]){ const af=await (await fetch(base+code+".json")).json(); build_airfield(af); build_buildings(af); }
		// The runway loads async, after the initial reset_ownship — a runway start would otherwise fall
		// through to an air start; re-place on the runway now that it exists.
		if(mission_start()==="runway" && running && airports.length) reset_ownship();
	}catch(error){ console.error("midway map load failed",error); }
}
const ISLAND_H=3.5;   // island top; the airfield surfaces + runway sit ~1.5 m above it (floating read fine for runway/taxiways; coplanar z-fought worse). Runway height tuned to the y=8 aircraft floor.
const AIRFIELD_FLOAT=1.46;   // how far the airfield ground floats above the island top
function pip(px,pz,poly){ let inside=false; for(let i=0,j=poly.length-1;i<poly.length;j=i++){ const xi=poly[i][0],zi=poly[i][1],xj=poly[j][0],zj=poly[j][1]; if(((zi>pz)!==(zj>pz)) && px<(xj-xi)*(pz-zi)/(zj-zi)+xi) inside=!inside; } return inside; }
// Crash-collision registry, populated as the world builds: island terrain, buildings, small structures
// (PAPI/windsock), and the runway rectangle (the one place the arcade landing floor still applies).
const obstacles={ islands:[], buildings:[], posts:[], aprons:[], runway:null };   // aprons/islands/… stay [] until the async airfield loads, so the ground checks never iterate undefined
const SKIRT=26, SKIRT_DROP=0.8;   // beach skirt: real Midway shores are gently sloping sand, not cliffs — slope the last ~26 m from ground level to just below the waterline
const HARBOUR={minx:140,maxx:720,minz:2430,maxz:2725}, QUAY=2.0, QUAY_APRON=5;   // the SE harbour basin on Sand Island: deep water meets the land at a smooth man-made wall, its top (quay) 2 m above the sea at the end of a short apron down from ground level
function in_harbour(x,z){ return x>HARBOUR.minx&&x<HARBOUR.maxx&&z>HARBOUR.minz&&z<HARBOUR.maxz; }
function build_islands(polygons, ground, half){
	island_polygons=polygons.filter(polygon=>polygon.length>=30);   // Sand / Eastern / Spit; skip tiny reef rocks
	const material=new THREE.MeshStandardMaterial({map:ground,roughness:0.96,metalness:0.0});   // Sentinel-2 imagery, planar-mapped by world position
	const skirtMat=new THREE.MeshStandardMaterial({map:ground,roughness:0.96,metalness:0.0,side:THREE.DoubleSide});   // the same imagery flows down the beach (its surf/shallow pixels land on the slope)
	for(const polygon of island_polygons){
		const shape=new THREE.Shape(); shape.moveTo(polygon[0][0],-polygon[0][1]); for(let i=1;i<polygon.length;i++) shape.lineTo(polygon[i][0],-polygon[i][1]);   // shape (x,-z): after rotateX the island rises +y, z un-mirrored
		const geometry=new THREE.ExtrudeGeometry(shape,{depth:ISLAND_H,bevelEnabled:false,steps:1}); geometry.rotateX(-Math.PI/2);
		const pos=geometry.attributes.position, uv=new Float32Array(pos.count*2);   // planar UVs → sample the map texture by world position
		for(let i=0;i<pos.count;i++){ uv[i*2]=(pos.getX(i)+half)/(2*half); uv[i*2+1]=(pos.getZ(i)+half)/(2*half); }
		geometry.setAttribute("uv", new THREE.BufferAttribute(uv,2));
		const mesh=new THREE.Mesh(geometry,material); mesh.receiveShadow=true; mesh.castShadow=true; scene.add(mesh);
		// shore skirt: a continuous two-band ribbon from the coastline at ground level, hiding the extrusion cliff.
		// Beach profile: slope ~26 m out and down to below the waterline. Harbour profile: short apron down to the
		// quay at 2 m, then a smooth vertical wall into the deep water.
		{ const n=polygon.length, vn=[];
			for(let i=0;i<n;i++){ const p0=polygon[(i-1+n)%n], p1=polygon[i], p2=polygon[(i+1)%n];
				const nx=(p1[1]-p0[1])+(p2[1]-p1[1]), nz=-((p1[0]-p0[0])+(p2[0]-p1[0])); const l=Math.hypot(nx,nz)||1; vn.push([nx/l,nz/l]); }   // per-vertex normal (adjacent edges averaged) → gap-free ribbon at corners
			if(pip(polygon[0][0]+vn[0][0]*2, polygon[0][1]+vn[0][1]*2, polygon)){ for(const v of vn){ v[0]=-v[0]; v[1]=-v[1]; } }   // orient outward (winding-agnostic)
			const prof=polygon.map(a=>in_harbour(a[0],a[1])?{o1:QUAY_APRON,h1:QUAY,o2:QUAY_APRON,h2:-1.5}:{o1:SKIRT,h1:-SKIRT_DROP,o2:SKIRT+1,h2:-SKIRT_DROP-0.2});   // per-vertex profile; shared vertices blend the two continuously
			const r1=polygon.map((a,i)=>[a[0]+vn[i][0]*prof[i].o1, a[1]+vn[i][1]*prof[i].o1, prof[i].h1]);
			const r2=polygon.map((a,i)=>[a[0]+vn[i][0]*prof[i].o2, a[1]+vn[i][1]*prof[i].o2, prof[i].h2]);
			for(let pass=0;pass<4;pass++) for(const r of [r1,r2]){   // smooth the offset rings — the raw coastline is dense and noisy, and offsetting it 26 m amplifies every kink into a jagged waterline
				const prev=r.map(v=>v.slice());
				for(let i=0;i<n;i++){ const p0=prev[(i-1+n)%n], p1=prev[i], p2=prev[(i+1)%n];
					r[i][0]=(p0[0]+2*p1[0]+p2[0])/4; r[i][1]=(p0[1]+2*p1[1]+p2[1])/4; r[i][2]=(p0[2]+2*p1[2]+p2[2])/4; } }
			const spos=[], suv=[];
			const push=(x,y,z,ux,uz)=>{ spos.push(x,y,z); suv.push((ux+half)/(2*half),(uz+half)/(2*half)); };   // uv from the COASTLINE point, not the offset one — the skirt stretches the shore's own beach pixels outward instead of sampling the photo's water (which read as blue land)
			for(let i=0;i<n;i++){ const j=(i+1)%n, a=polygon[i], b=polygon[j];
				const tri=(v1,v2,v3)=>{ push(...v1); push(...v2); push(...v3); };
				const A=[a[0],ISLAND_H,a[1],a[0],a[1]], B=[b[0],ISLAND_H,b[1],b[0],b[1]];
				const A1=[r1[i][0],r1[i][2],r1[i][1],a[0],a[1]], B1=[r1[j][0],r1[j][2],r1[j][1],b[0],b[1]];
				const A2=[r2[i][0],r2[i][2],r2[i][1],a[0],a[1]], B2=[r2[j][0],r2[j][2],r2[j][1],b[0],b[1]];
				tri(A,B,B1); tri(A,B1,A1);   // land edge → beach toe / quay top
				tri(A1,B1,B2); tri(A1,B2,A2); }   // beach run-out / harbour wall face
			const sg=new THREE.BufferGeometry(); sg.setAttribute("position",new THREE.BufferAttribute(new Float32Array(spos),3)); sg.setAttribute("uv",new THREE.BufferAttribute(new Float32Array(suv),2)); sg.computeVertexNormals();
			const sm=new THREE.Mesh(sg,skirtMat); sm.receiveShadow=true; scene.add(sm); }
		let minx=1e9,maxx=-1e9,minz=1e9,maxz=-1e9; for(const p of polygon){ minx=Math.min(minx,p[0]); maxx=Math.max(maxx,p[0]); minz=Math.min(minz,p[1]); maxz=Math.max(maxz,p[1]); }
		obstacles.islands.push({pts:polygon,minx,maxx,minz,maxz});
	}
}
function edge_distance(x,z,pts){ let best=1e18;   // distance from (x,z) to the nearest polygon edge
	for(let i=0;i<pts.length;i++){ const a=pts[i], b=pts[(i+1)%pts.length];
		const dx=b[0]-a[0], dz=b[1]-a[1], t=THREE.MathUtils.clamp(((x-a[0])*dx+(z-a[1])*dz)/((dx*dx+dz*dz)||1),0,1);
		const ex=a[0]+dx*t-x, ez=a[1]+dz*t-z, d=ex*ex+ez*ez; if(d<best) best=d; }
	return Math.sqrt(best); }
const ASPHALT_TILE=22;   // metres per asphalt-texture tile
function asphalt_texture(){ const c=document.createElement("canvas"); c.width=c.height=256; const x=c.getContext("2d");
	x.fillStyle="#565a5e"; x.fillRect(0,0,256,256);                                                   // weathered grey base (not fresh-black)
	for(let i=0;i<70;i++){ const r=18+Math.random()*46, gx=Math.random()*256, gy=Math.random()*256, s=Math.random()<0.5?0:235, a=0.03+Math.random()*0.05;   // low-freq weathering patches
		const g=x.createRadialGradient(gx,gy,0,gx,gy,r); g.addColorStop(0,`rgba(${s},${s},${s},${a})`); g.addColorStop(1,`rgba(${s},${s},${s},0)`); x.fillStyle=g; x.fillRect(gx-r,gy-r,2*r,2*r); }
	const im=x.getImageData(0,0,256,256),d=im.data; for(let i=0;i<d.length;i+=4){ const n=(Math.random()-0.5)*20; d[i]+=n; d[i+1]+=n; d[i+2]+=n; } x.putImageData(im,0,0);   // fine speckle
	const t=new THREE.CanvasTexture(c); t.colorSpace=THREE.SRGBColorSpace; t.wrapS=t.wrapT=THREE.RepeatWrapping; t.anisotropy=renderer.capabilities.getMaxAnisotropy(); return t; }
function ribbon(points, width, y){   // asphalt strip of `width` (m) along a world-space polyline at height y
	const hw=width/2, pos=[], uvs=[];
	const off=points.map((_p,i)=>{ const a=points[Math.max(0,i-1)], b=points[Math.min(points.length-1,i+1)];
		const dx=b[0]-a[0], dz=b[1]-a[1]; const l=Math.hypot(dx,dz)||1; return [-dz/l*hw, dx/l*hw]; });   // perpendicular (left) offset
	for(let i=0;i<points.length-1;i++){ const p=points[i], q=points[i+1], u=off[i], v=off[i+1];
		const pl=[p[0]+u[0],p[1]+u[1]], pr=[p[0]-u[0],p[1]-u[1]], ql=[q[0]+v[0],q[1]+v[1]], qr=[q[0]-v[0],q[1]-v[1]];
		const ny=(pr[1]-pl[1])*(qr[0]-pl[0])-(pr[0]-pl[0])*(qr[1]-pl[1]);   // wind the top face upward regardless of strip direction (else it back-faces and shades black)
		const quad=ny>=0?[pl,pr,qr,pl,qr,ql]:[pl,qr,pr,pl,ql,qr];
		for(const w of quad){ pos.push(w[0],y,w[1]); uvs.push(w[0]/ASPHALT_TILE, w[1]/ASPHALT_TILE); } }
	const g=new THREE.BufferGeometry(); g.setAttribute("position",new THREE.BufferAttribute(new Float32Array(pos),3));
	const n=new Float32Array(pos.length); for(let i=1;i<n.length;i+=3) n[i]=1; g.setAttribute("normal",new THREE.BufferAttribute(n,3));
	g.setAttribute("uv",new THREE.BufferAttribute(new Float32Array(uvs),2)); return g;
}
function fill_polygon(points, y){   // filled world-space polygon (apron) at height y
	let pts=points; if(pts.length>3 && pts[0][0]===pts[pts.length-1][0] && pts[0][1]===pts[pts.length-1][1]) pts=pts.slice(0,-1);   // drop OSM's duplicate closing node (else earcut tears)
	const shape=new THREE.Shape(); shape.moveTo(pts[0][0],-pts[0][1]); for(let i=1;i<pts.length;i++) shape.lineTo(pts[i][0],-pts[i][1]);
	const g=new THREE.ShapeGeometry(shape); g.rotateX(-Math.PI/2); const pos=g.attributes.position;
	const uv=new Float32Array(pos.count*2);
	for(let i=0;i<pos.count;i++){ pos.setY(i,y); uv[i*2]=pos.getX(i)/ASPHALT_TILE; uv[i*2+1]=pos.getZ(i)/ASPHALT_TILE; }
	g.setAttribute("uv",new THREE.BufferAttribute(uv,2)); return g;
}
function merge_uv(geos){   // merge_geometries drops uv; this keeps position+normal+uv (converts indexed → non-indexed)
	const parts=geos.map(g=>g.index?g.toNonIndexed():g); let total=0; parts.forEach(g=>total+=g.attributes.position.count);
	const pos=new Float32Array(total*3), nor=new Float32Array(total*3), uv=new Float32Array(total*2); let a=0,b=0;
	for(const g of parts){ pos.set(g.attributes.position.array,a); nor.set(g.attributes.normal.array,a); uv.set(g.attributes.uv.array,b); a+=g.attributes.position.count*3; b+=g.attributes.position.count*2; }
	const out=new THREE.BufferGeometry(); out.setAttribute("position",new THREE.BufferAttribute(pos,3)); out.setAttribute("normal",new THREE.BufferAttribute(nor,3)); out.setAttribute("uv",new THREE.BufferAttribute(uv,2)); out.computeBoundingSphere(); return out;
}
function build_airfield(af){
	obstacles.aprons=(af.aprons||[]).map(a=>a.points);   // apron polygons double as a landing surface at apron height
	const tex=asphalt_texture();
	const asphalt=new THREE.MeshStandardMaterial({map:tex,roughness:0.96,metalness:0.0,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1});
	// all ground surfaces (aprons + taxiways + stopways) merged into ONE mesh at ONE height. Floats ~1.5 m above the
	// island: read fine for the runway/taxiways; the apron area keeps some z-fighting we accept (buildings cover it, #49).
	const gy=ISLAND_H+AIRFIELD_FLOAT;
	// Physics capsules for the flight core: taxiways/stopways per segment, aprons as a
	// major-axis approximation — drawn geometry and contact geometry come from the same data.
	for(const t of [...(af.taxiways||[]),...(af.stopways||[])]) for(let i=1;i<t.points.length;i++) physics_strips.push({a:t.points[i-1],b:t.points[i],w:t.width});
	for(const a2 of af.aprons||[]){ const pts=a2.points; let minx=1e9,maxx=-1e9,minz=1e9,maxz=-1e9;
		for(const q of pts){ minx=Math.min(minx,q[0]); maxx=Math.max(maxx,q[0]); minz=Math.min(minz,q[1]); maxz=Math.max(maxz,q[1]); }
		const lx=maxx-minx, lz=maxz-minz, cx2=(minx+maxx)/2, cz2=(minz+maxz)/2;
		if(lx>=lz) physics_strips.push({a:[minx,cz2],b:[maxx,cz2],w:lz}); else physics_strips.push({a:[cx2,minz],b:[cx2,maxz],w:lx}); }
	const ground=[...af.aprons.map(a=>fill_polygon(a.points,gy)), ...af.taxiways.map(t=>ribbon(t.points,t.width,gy)), ...af.stopways.map(s=>ribbon(s.points,s.width,gy))];
	if(ground.length){ const m=new THREE.Mesh(merge_uv(ground),asphalt); m.receiveShadow=true; scene.add(m); }
	const rw=af.runway, a=rw.points[0], b=rw.points[rw.points.length-1];   // a = first end (06), b = last end (24)
	const cx=(a[0]+b[0])/2, cz=(a[1]+b[1])/2, dx=b[0]-a[0], dz=b[1]-a[1];
	const L=Math.hypot(dx,dz), H=Math.atan2(dx,-dz);   // runway centre, true length, heading a→b (fwd=(sinH,0,-cosH))
	const parts=rw.ref.split("/").map(s=>parseInt(s,10));   // painted magnetic numbers (06/24) from the OSM ref
	obstacles.runway={x:cx,z:cz,fx:Math.sin(H),fz:-Math.cos(H),hl:L/2+45,hw:rw.width/2+12};   // landing floor applies only inside this rectangle
	{ const r=obstacles.runway; physics_strips.push({a:[r.x-r.fx*r.hl,r.z-r.fz*r.hl],b:[r.x+r.fx*r.hl,r.z+r.fz*r.hl],w:r.hw*2}); }
	build_airport({x:cx,z:cz,h:ISLAND_H,hd:H}, parts[0], parts[1], false, L, rw.width);
}
const WALL_TILE=3.6, ROOF_TILE=2.2;
function wall_texture(){ const c=document.createElement("canvas"); c.width=c.height=64; const x=c.getContext("2d");
	x.fillStyle="#cec7b7"; x.fillRect(0,0,64,64);                                                 // pale painted wall
	x.fillStyle="#b7b1a1"; x.fillRect(15,13,34,34); x.fillStyle="#3f464d"; x.fillRect(18,16,28,28);   // one window (frame + glass) per tile
	x.fillStyle="#565d64"; x.fillRect(31,16,2,28); x.fillRect(18,29,28,2);                         // mullions
	const im=x.getImageData(0,0,64,64),d=im.data; for(let i=0;i<d.length;i+=4){ const n=(Math.random()-0.5)*12; d[i]+=n; d[i+1]+=n; d[i+2]+=n; } x.putImageData(im,0,0);
	const t=new THREE.CanvasTexture(c); t.colorSpace=THREE.SRGBColorSpace; t.wrapS=t.wrapT=THREE.RepeatWrapping; t.anisotropy=renderer.capabilities.getMaxAnisotropy(); return t; }
function wall_emissive(full){   // night companion to wall_texture: the same window layout with a random subset of panes lit (or every pane, for the fully-lit buildings) — real lit windows rather than glow points
	const c=document.createElement("canvas"); c.width=c.height=1024; const x=c.getContext("2d");   // 16x16 tiles: the pattern repeats only every ~58 m of wall
	x.fillStyle="#000"; x.fillRect(0,0,1024,1024);
	const bias=[]; for(let i=0;i<16;i++) bias.push(0.45+(Math.random()-0.5)*0.5);   // per-block occupancy varies, so some stretches are busy and others asleep — less uniform than a flat coin flip
	for(let ty=0;ty<16;ty++) for(let tx=0;tx<16;tx++){ if(!full && Math.random()>=bias[(ty>>2)*4+(tx>>2)]) continue;
		const warm=Math.random()<0.8, br=0.7+Math.random()*0.3;
		x.fillStyle=warm?`rgb(${Math.round(255*br)},${Math.round(196*br)},${Math.round(120*br)})`:`rgb(${Math.round(190*br)},${Math.round(214*br)},${Math.round(255*br)})`;
		x.fillRect(tx*64+18,ty*64+16,28,28);
		x.fillStyle="#000"; x.fillRect(tx*64+31,ty*64+16,2,28); x.fillRect(tx*64+18,ty*64+29,28,2);   // keep the mullions dark
	}
	const t=new THREE.CanvasTexture(c); t.colorSpace=THREE.SRGBColorSpace; t.wrapS=t.wrapT=THREE.RepeatWrapping; t.repeat.set(1/16,1/16); t.anisotropy=renderer.capabilities.getMaxAnisotropy(); return t; }
const window_mats=[];   // wall materials whose lit windows switch on at night (emissiveIntensity toggled in update_papi)
function roof_texture(dark){ const c=document.createElement("canvas"); c.width=c.height=32; const x=c.getContext("2d");
	x.fillStyle=dark?"#4a4f56":"#a8adb3"; x.fillRect(0,0,32,32);
	x.strokeStyle=dark?"#3b3f45":"#8d9299"; x.lineWidth=1; for(let i=1;i<32;i+=4){ x.beginPath(); x.moveTo(i,0); x.lineTo(i,32); x.stroke(); }   // corrugation ribs
	const im=x.getImageData(0,0,32,32),d=im.data; for(let i=0;i<d.length;i+=4){ const n=(Math.random()-0.5)*10; d[i]+=n; d[i+1]+=n; d[i+2]+=n; } x.putImageData(im,0,0);
	const t=new THREE.CanvasTexture(c); t.colorSpace=THREE.SRGBColorSpace; t.wrapS=t.wrapT=THREE.RepeatWrapping; t.anisotropy=renderer.capabilities.getMaxAnisotropy(); return t; }
function facenorm(a,b,c){ const ux=b[0]-a[0],uy=b[1]-a[1],uz=b[2]-a[2], vx=c[0]-a[0],vy=c[1]-a[1],vz=c[2]-a[2];
	const nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx, l=Math.hypot(nx,ny,nz)||1; return [nx/l,ny/l,nz/l]; }
function pushtri(pos,nor,uv, a,b,c, ta,tb,tc, want){   // emit a triangle, flipping winding so its face normal points toward `want`
	let n=facenorm(a,b,c); if(n[0]*want[0]+n[1]*want[1]+n[2]*want[2]<0){ const t=b; b=c; c=t; const u=tb; tb=tc; tc=u; n=facenorm(a,b,c); }
	pos.push(a[0],a[1],a[2], b[0],b[1],b[2], c[0],c[1],c[2]); nor.push(n[0],n[1],n[2], n[0],n[1],n[2], n[0],n[1],n[2]); uv.push(ta[0],ta[1], tb[0],tb[1], tc[0],tc[1]); }
function geom_from(pos,nor,uv){ const g=new THREE.BufferGeometry(); g.setAttribute("position",new THREE.BufferAttribute(new Float32Array(pos),3)); g.setAttribute("normal",new THREE.BufferAttribute(new Float32Array(nor),3)); g.setAttribute("uv",new THREE.BufferAttribute(new Float32Array(uv),2)); return g; }
function building_walls(pts, gy, topY){   // textured vertical walls per footprint edge (windows tile by world size)
	const pos=[],nor=[],uv=[], h=topY-gy; let cx=0,cz=0; for(const p of pts){ cx+=p[0]; cz+=p[1]; } cx/=pts.length; cz/=pts.length;
	let cum=0;
	for(let i=0;i<pts.length;i++){ const a=pts[i], b=pts[(i+1)%pts.length], dx=b[0]-a[0], dz=b[1]-a[1], len=Math.hypot(dx,dz)||1;
		let nx=dz/len, nz=-dx/len; if(((a[0]+b[0])/2-cx)*nx+((a[1]+b[1])/2-cz)*nz<0){ nx=-nx; nz=-nz; }   // outward
		const want=[nx,0,nz], u0=cum/WALL_TILE, u1=(cum+len)/WALL_TILE, v1=h/WALL_TILE;
		const aB=[a[0],gy,a[1]], bB=[b[0],gy,b[1]], bT=[b[0],topY,b[1]], aT=[a[0],topY,a[1]];
		pushtri(pos,nor,uv, aB,bB,bT, [u0,0],[u1,0],[u1,v1], want); pushtri(pos,nor,uv, aB,bT,aT, [u0,0],[u1,v1],[u0,v1], want);
		cum+=len; }
	return geom_from(pos,nor,uv); }
function gable_roof(pts, eaveY){   // two sloped roof planes over the footprint's oriented bounding box; returns {slopes, ends}
	let cx=0,cz=0; for(const p of pts){ cx+=p[0]; cz+=p[1]; } cx/=pts.length; cz/=pts.length;
	let sxx=0,szz=0,sxz=0; for(const p of pts){ const dx=p[0]-cx, dz=p[1]-cz; sxx+=dx*dx; szz+=dz*dz; sxz+=dx*dz; }
	const ang=0.5*Math.atan2(2*sxz, sxx-szz); let ux=Math.cos(ang), uz=Math.sin(ang), vx=-Math.sin(ang), vz=Math.cos(ang);
	let uMin=1e9,uMax=-1e9,vMin=1e9,vMax=-1e9; for(const p of pts){ const du=(p[0]-cx)*ux+(p[1]-cz)*uz, dv=(p[0]-cx)*vx+(p[1]-cz)*vz; uMin=Math.min(uMin,du); uMax=Math.max(uMax,du); vMin=Math.min(vMin,dv); vMax=Math.max(vMax,dv); }
	if(uMax-uMin<vMax-vMin){ [ux,uz,vx,vz]=[vx,vz,-ux,-uz]; [uMin,uMax,vMin,vMax]=[vMin,vMax,-uMax,-uMin]; }   // u = long axis (ridge runs along it)
	const rise=Math.max(1.2,Math.min(5,(vMax-vMin)*0.18)), ry=eaveY+rise, vMid=(vMin+vMax)/2;
	const W=(u,v,yy)=>[cx+u*ux+v*vx, yy, cz+u*uz+v*vz], puv=(p)=>[p[0]/ROOF_TILE, p[2]/ROOF_TILE];
	const A=W(uMin,vMin,eaveY), B=W(uMax,vMin,eaveY), C=W(uMax,vMax,eaveY), D=W(uMin,vMax,eaveY), R0=W(uMin,vMid,ry), R1=W(uMax,vMid,ry);
	const sp=[],sn=[],su=[]; pushtri(sp,sn,su, A,B,R1, puv(A),puv(B),puv(R1), [0,1,0]); pushtri(sp,sn,su, A,R1,R0, puv(A),puv(R1),puv(R0), [0,1,0]);
	pushtri(sp,sn,su, D,C,R1, puv(D),puv(C),puv(R1), [0,1,0]); pushtri(sp,sn,su, D,R1,R0, puv(D),puv(R1),puv(R0), [0,1,0]);
	const ep=[],en=[],eu=[]; pushtri(ep,en,eu, A,D,R0, puv(A),puv(D),puv(R0), [-ux,0,-uz]); pushtri(ep,en,eu, B,C,R1, puv(B),puv(C),puv(R1), [ux,0,uz]);
	return {slopes: geom_from(sp,sn,su), ends: geom_from(ep,en,eu)}; }
function flat_cap(pts, topY){   // flat roof cap at topY
	const shape=new THREE.Shape(); shape.moveTo(pts[0][0],-pts[0][1]); for(let i=1;i<pts.length;i++) shape.lineTo(pts[i][0],-pts[i][1]);
	const g=new THREE.ShapeGeometry(shape); g.rotateX(-Math.PI/2); const pos=g.attributes.position, uv=new Float32Array(pos.count*2);
	for(let i=0;i<pos.count;i++){ pos.setY(i,topY); uv[i*2]=pos.getX(i)/ROOF_TILE; uv[i*2+1]=pos.getZ(i)/ROOF_TILE; }
	g.setAttribute("uv", new THREE.BufferAttribute(uv,2)); return g; }
function rectangularity(pts){   // footprint area / oriented-bounding-box area (1 = perfect rectangle)
	let area=0; for(let i=0;i<pts.length;i++){ const a=pts[i], b=pts[(i+1)%pts.length]; area+=a[0]*b[1]-b[0]*a[1]; } area=Math.abs(area)/2;
	let cx=0,cz=0; for(const p of pts){ cx+=p[0]; cz+=p[1]; } cx/=pts.length; cz/=pts.length;
	let sxx=0,szz=0,sxz=0; for(const p of pts){ const dx=p[0]-cx, dz=p[1]-cz; sxx+=dx*dx; szz+=dz*dz; sxz+=dx*dz; }
	const ang=0.5*Math.atan2(2*sxz, sxx-szz), ux=Math.cos(ang), uz=Math.sin(ang);
	let uMin=1e9,uMax=-1e9,vMin=1e9,vMax=-1e9; for(const p of pts){ const du=(p[0]-cx)*ux+(p[1]-cz)*uz, dv=-(p[0]-cx)*uz+(p[1]-cz)*ux; uMin=Math.min(uMin,du); uMax=Math.max(uMax,du); vMin=Math.min(vMin,dv); vMax=Math.max(vMax,dv); }
	const obb=(uMax-uMin)*(vMax-vMin); return obb>0?area/obb:0; }
function build_buildings(af){   // OSM footprints → textured walls + gable/flat roofs on the island
	if(!af.buildings || !af.buildings.length) return;
	const wallTex=wall_texture();
	const litMat=em=>{ const m=new THREE.MeshStandardMaterial({map:wallTex,roughness:0.9,metalness:0.05,emissive:0xffffff,emissiveIntensity:0,emissiveMap:em}); window_mats.push(m); return m; };   // lit windows appear at night (emissiveIntensity toggled in update_papi)
	const wallMat=litMat(wall_emissive(false)), fullMat=litMat(wall_emissive(true));   // most buildings: a random scatter of lit windows; a few: every window lit
	const darkMat=new THREE.MeshStandardMaterial({map:wallTex,roughness:0.9,metalness:0.05});   // ~a quarter of buildings are completely dark
	const tankMat=new THREE.MeshStandardMaterial({map:roof_texture(false),roughness:0.6,metalness:0.4});   // storage tanks: bare corrugated metal, no windows, never lit
	const roofMat=new THREE.MeshStandardMaterial({map:roof_texture(false),roughness:0.7,metalness:0.3});     // light metal roof
	const hangarMat=new THREE.MeshStandardMaterial({map:roof_texture(true),roughness:0.65,metalness:0.35});  // dark metal (hangar)
	const walls=[], fulls=[], darks=[], tanks=[], roofs=[], hroofs=[];
	for(const b of af.buildings){
		let pts=b.points; if(pts.length>3 && pts[0][0]===pts[pts.length-1][0] && pts[0][1]===pts[pts.length-1][1]) pts=pts.slice(0,-1);
		if(pts.length<3) continue;
		let cx=0,cz=0; for(const p of pts){ cx+=p[0]; cz+=p[1]; } cx/=pts.length; cz/=pts.length;
		const apron=(af.aprons||[]).some(a=>pip(cx,cz,a.points));
		const gy=apron?ISLAND_H+AIRFIELD_FLOAT:ISLAND_H, eaveY=gy+b.height;   // buildings on the apron stand on it, not half-buried under it
		let rmin=1e9,rmax=0; for(const p of pts){ const d=Math.hypot(p[0]-cx,p[1]-cz); rmin=Math.min(rmin,d); rmax=Math.max(rmax,d); }
		const tank=pts.length>=8 && rmax/Math.max(rmin,0.01)<1.2;   // near-circular footprint = oil/water storage tank, not a building
		const rl=Math.random(), bucket=tank?tanks:(rl<0.25?darks:(rl<0.33?fulls:walls));   // tanks: windowless; ~1/4 of buildings fully dark, ~1/12 every window lit, the rest a random scatter
		bucket.push(building_walls(pts, gy, eaveY));
		// The gable spans the footprint's oriented bounding box, so it overhangs non-rectangular footprints — those get a flat cap instead.
		const gabled=b.roof==="gable" && rectangularity(pts)>=0.8;
		if(gabled){ const g=gable_roof(pts, eaveY); (b.kind==="hangar"?hroofs:roofs).push(g.slopes); bucket.push(g.ends); }
		else roofs.push(flat_cap(pts, eaveY));
		let minx=1e9,maxx=-1e9,minz=1e9,maxz=-1e9; for(const p of pts){ minx=Math.min(minx,p[0]); maxx=Math.max(maxx,p[0]); minz=Math.min(minz,p[1]); maxz=Math.max(maxz,p[1]); }
		obstacles.buildings.push({pts,minx:minx-3,maxx:maxx+3,minz:minz-3,maxz:maxz+3,topY:eaveY+(gabled?5:0)});
	}
	const add=(geos,mat)=>{ if(geos.length){ const m=new THREE.Mesh(merge_uv(geos),mat); m.castShadow=true; m.receiveShadow=true; scene.add(m); } };
	add(walls,wallMat); add(fulls,fullMat); add(darks,darkMat); add(tanks,tankMat); add(roofs,roofMat); add(hroofs,hangarMat);
}
// Toroidal world wrap — WORLD_WRAP (m) from map.json, 0 = no wrap. Minimum-image for relative quantities.
function wrap_axis(value){ return WORLD_WRAP>0 ? value-WORLD_WRAP*Math.round(value/WORLD_WRAP) : value; }
function wrap_position(position){ if(WORLD_WRAP>0){ position.x=wrap_axis(position.x); position.z=wrap_axis(position.z); } }
function wrap_distance(from,to){ return Math.hypot(wrap_axis(to.x-from.x), to.y-from.y, wrap_axis(to.z-from.z)); }
function runway_texture(nTop,nBottom){ const c=document.createElement("canvas"); c.width=128; c.height=1024; const x=c.getContext("2d");
	x.fillStyle="#4a4c50"; x.fillRect(0,0,128,1024);                                                  // weathered grey asphalt (not fresh-black)
	{ const im=x.getImageData(0,0,128,1024),d=im.data; for(let i=0;i<d.length;i+=4){ const n=(Math.random()-0.5)*22; d[i]+=n; d[i+1]+=n; d[i+2]+=n; } x.putImageData(im,0,0); }   // fine weathering speckle
	x.fillStyle="#d8d8d8"; x.fillRect(8,0,4,1024); x.fillRect(116,0,4,1024);                         // side stripes
	x.fillStyle="#eaeaea"; for(let y=120;y<1024-120;y+=56){ x.fillRect(62,y,4,30); }                 // centreline dashes
	const keys=(yc,dir)=>{ x.fillStyle="#eaeaea"; for(let k=-3;k<=3;k++){ x.fillRect(64+k*9-3,yc,6,46*dir); } };
	keys(20,1); keys(1004,-1);                                                                        // threshold piano keys
	x.fillStyle="#eaeaea"; x.fillRect(40,150,12,60); x.fillRect(76,150,12,60); x.fillRect(40,814,12,60); x.fillRect(76,814,12,60); // aiming points
	// each number reads upright to the aircraft approaching that end (glyph top points down-runway toward the centre)
	x.fillStyle="#f2f2f2"; x.font="bold 52px sans-serif"; x.textAlign="center"; x.textBaseline="middle";
	x.save(); x.translate(64,92);  x.rotate(Math.PI); x.fillText(String(nTop),0,0); x.restore();      // +y end (US: single-digit runways painted without a leading zero, e.g. "6" not "06")
	x.save(); x.translate(64,932);                    x.fillText(String(nBottom),0,0); x.restore();   // -y end
	const t=new THREE.CanvasTexture(c); t.colorSpace=THREE.SRGBColorSpace; t.anisotropy=renderer.capabilities.getMaxAnisotropy(); return t; }
function glow_points(pts, color, size){   // additive glowing point-lights (runway edge / threshold / REIL)
	const g=new THREE.BufferGeometry(); g.setAttribute("position",new THREE.BufferAttribute(new Float32Array(pts),3));
	const p=new THREE.Points(g,new THREE.PointsMaterial({size,map:light_dot,color,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,sizeAttenuation:true})); p.frustumCulled=false; scene.add(p); return p;
}
const night_lights=[];   // runway lights that are lit only when it's dark (edge lights; bidirectional)
const ops_lights=[]; const flood_lights=[]; const deck_floods=[];   // carrier night lighting, split per real procedure: ops_lights = recovery aids (centreline/drop/datum/deck-edge), up for an inbound gear-down approach; deck_floods + flood_lights = the island floodlights, WORK lights only — on when on deck, doused during launch/recovery so they never wreck night vision on the ball
const beacon_lights=[];  // aerodrome beacon on the tower: alternating white/green flash at night (userData.phase 0/1)
const dir_lights=[];     // directional + night-only lights (green threshold / red end / REIL) — shown only from their facing side
function dir_glow(pts,color,size,x,z,fx,fz,flash){ const p=glow_points(pts,color,size); dir_lights.push({mesh:p,x,z,fx,fz,flash}); return p; }
function build_airport(o, number_plus, number_minus, tower=true, L=2400, W=60){
	const y=o.h+1.5, H=o.hd;                                                 // H = compass heading (rad) you fly taking off / landing in +fwd
	const up=new THREE.Vector3(0,1,0);
	const fwd=new THREE.Vector3(Math.sin(H),0,-Math.cos(H));                 // world dir whose compass heading is H
	const right=new THREE.Vector3().crossVectors(fwd,up);                    // to the right of the landing direction
	const hdeg=((H*180/Math.PI)%360+360)%360;
	const nPlus=number_plus??(Math.round(hdeg/10)%36||36);                   // painted number for heading H (override for magnetic-based names, e.g. Midway 06/24)
	const nMinus=number_minus??(Math.round(((hdeg+180)%360)/10)%36||36);     // the reciprocal end
	// runway surface (local +y == fwd == the +y/canvas-top end; nMinus is painted there, nPlus at the -y end)
	const rmesh=new THREE.Mesh(new THREE.PlaneGeometry(W,L),new THREE.MeshStandardMaterial({map:runway_texture(nMinus,nPlus),roughness:0.95,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2}));
	rmesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right,fwd,up));
	rmesh.position.set(o.x,y,o.z); rmesh.receiveShadow=true; scene.add(rmesh);
	// control tower (concrete base + glass cab + roof), offset to the side near midfield
	if(tower){
	const tp=new THREE.Vector3(o.x,0,o.z).addScaledVector(right,110).addScaledVector(fwd,150);
	const tg=[]; tg.push(new THREE.CylinderGeometry(6,8,34,12).translate(tp.x,o.h+17,tp.z));
	const base=new THREE.Mesh(merge_geometries(tg),new THREE.MeshStandardMaterial({color:0xbfc4c8,roughness:0.8})); base.castShadow=true; scene.add(base);
	const cab=new THREE.Mesh(new THREE.CylinderGeometry(9,7.5,7,12),new THREE.MeshStandardMaterial({color:0x1c2024,metalness:0.4,roughness:0.4})); cab.position.set(tp.x,o.h+37,tp.z); scene.add(cab);
	const roof=new THREE.Mesh(new THREE.CylinderGeometry(10,10,1.5,12),new THREE.MeshStandardMaterial({color:0x44494e})); roof.position.set(tp.x,o.h+41,tp.z); scene.add(roof);
	for(const [phase,col] of [[0,0xffffff],[1,0x28ff40]]){ const b=glow_points([tp.x,o.h+42.6,tp.z],col,9); b.userData.phase=phase; b.visible=false; beacon_lights.push(b); }   // aerodrome beacon on the cab roof: alternating white/green at night
	}
	// PAPI on BOTH ends, on the left as seen by the approaching aircraft, each visible only within its approach beam
	const setAng=[3.5,3.167,2.833,2.5];
	function build_papi(tdz,leftVec,beam){ const papi=[],gpos=[],gcol=[];
		for(let i=0;i<4;i++){ const p=tdz.clone().addScaledVector(leftVec,(W/2+15)+i*9);   // 4 units, 9 m apart, inner unit 15 m from the runway edge
			const post=new THREE.Mesh(new THREE.BoxGeometry(0.4,0.7,0.4),new THREE.MeshStandardMaterial({color:0x2a2d31})); post.position.set(p.x,y+0.35,p.z); scene.add(post);
			const m=new THREE.Mesh(new THREE.BoxGeometry(1.2,0.55,0.7),new THREE.MeshBasicMaterial({color:0x23262b})); m.position.set(p.x,y+0.75,p.z); scene.add(m);   // ~0.6 m light box, low on frangible legs
			gpos.push(p.x,y+0.75,p.z); gcol.push(1,1,1); papi.push({mesh:m,x:p.x,y:y+0.75,z:p.z,set:setAng[i]});
			obstacles.posts.push({x:p.x,z:p.z,r:2.2,y1:y+1.6}); }
		const pg=new THREE.BufferGeometry(); pg.setAttribute("position",new THREE.BufferAttribute(new Float32Array(gpos),3)); pg.setAttribute("color",new THREE.BufferAttribute(new Float32Array(gcol),3));
		const papiPts=new THREE.Points(pg,new THREE.PointsMaterial({size:7,map:light_dot,vertexColors:true,transparent:true,blending:THREE.NormalBlending,depthWrite:false,sizeAttenuation:false})); papiPts.frustumCulled=false; papiPts.visible=false; scene.add(papiPts);   // base: normal-blended so the red reads red in daylight (additive washed it pale-orange). SCREEN-SPACE like the OLS meatball: world-sized (13 m) discs read as giant red balls from the runway in daylight
		const wg=new THREE.BufferGeometry(); wg.setAttribute("position",pg.getAttribute("position")); wg.setAttribute("color",new THREE.BufferAttribute(new Float32Array(gcol.length),3));
		const papiWhite=new THREE.Points(wg,new THREE.PointsMaterial({size:7,map:light_dot,vertexColors:true,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,sizeAttenuation:false})); papiWhite.frustumCulled=false; papiWhite.visible=false; scene.add(papiWhite);   // additive boost lit ONLY on the white units, so they punch through bright daylight (red units stay normal-blended)
		return {papi,papiPts,papiWhite,cx:tdz.x,cz:tdz.z,bx:beam.x,bz:beam.z}; }
	const thrP=new THREE.Vector3(o.x,y,o.z).addScaledVector(fwd,-L/2);        // -y end: approach for heading H, fly +fwd, left=-right, beam back along -fwd
	const thrM=new THREE.Vector3(o.x,y,o.z).addScaledVector(fwd, L/2);        // +y end: approach for heading H+180, fly -fwd, left=+right, beam along +fwd
	const papis=[ build_papi(thrP.clone().addScaledVector(fwd,320), right.clone().multiplyScalar(-1), fwd.clone().multiplyScalar(-1)),
	              build_papi(thrM.clone().addScaledVector(fwd,-320), right.clone(),                    fwd.clone()) ];
	// --- runway lighting (small, night-only except the always-on PAPI): MIRL edge, directional green/red thresholds, REIL ---
	const edge=[]; const m0=35, span=L-2*m0, segs=Math.max(2,Math.round(span/60));   // inset 35 m from the thresholds so the last edge light doesn't sit on the threshold/end lights
	for(let i=0;i<=segs;i++){ const c=new THREE.Vector3(o.x,y+0.3,o.z).addScaledVector(fwd,-L/2+m0+i*(span/segs));
		const l=c.clone().addScaledVector(right,W/2), r=c.clone().addScaledVector(right,-W/2); edge.push(l.x,l.y,l.z, r.x,r.y,r.z); }
	night_lights.push(glow_points(edge,0xf0e2b0,8));                          // MIRL runway edge lights (warm white, bidirectional)
	for(const [thr,appr] of [[thrP,fwd.clone().negate()],[thrM,fwd.clone()]]){   // appr = direction the approach comes from (outward from the threshold)
		const gp=[],rp=[]; for(let k=-2;k<=2;k++){ const b=thr.clone().addScaledVector(right,k*(W/4));
			gp.push(b.x,y+0.3,b.z); const e=b.clone().addScaledVector(appr,-4); rp.push(e.x,y+0.3,e.z); }
		dir_glow(gp,0x66ff8a,13,thr.x,thr.z, appr.x,appr.z,false);              // green threshold — seen only from the approach side
		dir_glow(rp,0xff4030,18,thr.x,thr.z,-appr.x,-appr.z,false);             // red runway-end — seen only from the runway side
		const rl=[]; for(const s of [1,-1]){ const q=thr.clone().addScaledVector(right,(W/2+9)*s); rl.push(q.x,y+0.6,q.z); }
		dir_glow(rl,0xffffff,10,thr.x,thr.z, appr.x,appr.z,true); }             // REIL — approach side, ~2 Hz flash
	{ const ws=new THREE.Vector3(o.x,0,o.z).addScaledVector(right,W/2+25);    // windsock beside the runway
		const pole=new THREE.Mesh(new THREE.CylinderGeometry(0.12,0.12,6,6),new THREE.MeshStandardMaterial({color:0xd0d0d0,metalness:0.3,roughness:0.6})); pole.position.set(ws.x,y+3,ws.z); pole.castShadow=true; scene.add(pole);
		// wind from ~070° (ENE trades) → the sock streams downwind (~250°); at a light ~10 kt it droops ~25° rather than standing full
		const wd=250*D2R, droop=25*D2R, axis=new THREE.Vector3(Math.sin(wd)*Math.cos(droop),-Math.sin(droop),-Math.cos(wd)*Math.cos(droop)).normalize();
		const h=3.4, sock=new THREE.Mesh(new THREE.CylinderGeometry(0.18,0.5,h,12,1,true),new THREE.MeshStandardMaterial({map:windsock_texture(),side:THREE.DoubleSide,roughness:0.9,metalness:0.0}));   // banded orange/white, mouth (wide) at the pole, narrow tail downwind
		sock.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),axis); sock.position.set(ws.x,y+6,ws.z).addScaledVector(axis,h/2); sock.castShadow=true; scene.add(sock);
		obstacles.posts.push({x:ws.x,z:ws.z,r:2.0,y1:y+9}); }
	const takeoff=thrP.clone().addScaledVector(fwd,55);                       // at the start of the runway, before the numbers, rolling toward +fwd
	airports.push({x:o.x,z:o.z,papis,dir:fwd,sy:o.h+2.2,start:{x:takeoff.x,y:o.h+2.2,z:takeoff.z}});
}
function update_papi(p){ const flash=(performance.now()%520)<90;   // REIL: ~2 Hz synchronized white flash
	const dark=cfg.tod!=="day";                                     // edge/threshold/REIL lit only when dark; PAPI is always on
	for(const m of night_lights) m.visible=dark;
	{ const dx=p.x-CARRIER.x, dz=p.z-CARRIER.z, d2=dx*dx+dz*dz;   // carrier flight-ops gate: deck working = lights up; otherwise the ship stays darkened
		const ops=dark && ((d2<400*400 && (ownship.squish??0)>0.1) || (d2<6000*6000 && (ownship.gear??1)<0.5));   // 6 km: the landing start spawns at 3 NM (5.6 km) — the recovery aids light up as you settle onto the approach, comfortably before the ball call
		const work=dark && d2<400*400 && (ownship.squish??0)>0.1;   // floods are WORK lights: real carriers douse them for night launch/recovery (black-hole deck); they come up only with weight on wheels
		for(const m of ops_lights) m.visible=ops;
		for(const m of deck_floods) m.visible=work;
		for(const s2 of flood_lights) s2.visible=work; }
	const bph=(performance.now()%3000)<1500;                        // aerodrome beacon: white / green alternating ~1.5 s each
	for(const m of beacon_lights) m.visible=dark && ((m.userData.phase===0)===bph);
	for(const m of window_mats) m.emissiveIntensity=dark?1.15:0;    // building windows light up after dark
	for(const d of dir_lights){ const facing=((p.x-d.x)*d.fx+(p.z-d.z)*d.fz)>0; d.mesh.visible=dark&&facing&&(!d.flash||flash); }
	for(const ap of airports){
	for(const set of ap.papis){
	const dx=p.x-set.cx, dz=p.z-set.cz; const horiz=Math.hypot(dx,dz);
	// realistic beam: visible only ahead of the lights, within ~±18° azimuth and out to ~16 km
	const vis = horiz>30 && horiz<16000 && (dx*set.bx+dz*set.bz)/horiz > 0.95;
	set.papiPts.visible=vis; set.papiWhite.visible=vis; const col=set.papiPts.geometry.attributes.color, wcol=set.papiWhite.geometry.attributes.color;
	for(let i=0;i<set.papi.length;i++){ const L=set.papi[i];
		if(!vis){ L.mesh.material.color.setHex(0x23262b); continue; }
		const h2=Math.hypot(p.x-L.x,p.z-L.z)||1; const white=(Math.atan2(p.y-L.y,h2)*180/Math.PI)>=L.set;
		L.mesh.material.color.setHex(white?0xffffff:0xff0000); col.array[i*3]=1; col.array[i*3+1]=white?1:0; col.array[i*3+2]=white?1:0;   // base (normal): pure red so it doesn't read orange
			const w=white?1:0; wcol.array[i*3]=w; wcol.array[i*3+1]=w; wcol.array[i*3+2]=w; }   // additive white boost — white units only
	if(vis){ col.needsUpdate=true; wcol.needsUpdate=true; }
} } }
let carrier_ols=null;
let carrier_shuttles=null;   // one catapult shuttle (towing spreader) per cat spot; the active one rides the stroke with the jet
let carrier_jbds=null;       // one Mk 7 jet blast deflector per cat spot; rises behind the hooked jet
const JBD_W=9.4, JBD_L=4.2, JBD_T=0.28, JBD_ANG=50*Math.PI/180;   // panel fills the painted plan-derived box (~9.7x4.4 m); real Mk 7 raises to ~50°
function ols_points(pts,color,size){   // like glow_points but SCREEN-SPACE (constant pixels) so the meatball reads small up close and far, not a 9 m blob
	const g=new THREE.BufferGeometry(); g.setAttribute("position",new THREE.BufferAttribute(new Float32Array(pts),3));
	const p=new THREE.Points(g,new THREE.PointsMaterial({size,map:light_dot,color,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,sizeAttenuation:false})); p.frustumCulled=false; scene.add(p); return p;
}
function build_carrier_deck_aids(){   // arrestor wires + OLS meatball on the flight deck (called once the carrier GLB has loaded and CARRIER.deckY is known)
	const dy=CARRIER.deckY;
	// --- 3 arrestor wires across the landing strip, at the trap fore-aft positions (angled to the strip) ---
	const wireMat=new THREE.MeshStandardMaterial({color:0x26282a,metalness:0.8,roughness:0.45});   // greased working steel: dark gunmetal with a faint sheen
	const sheaveMat=new THREE.MeshStandardMaterial({color:0x6a6e73,metalness:0.5,roughness:0.6});   // grey, per user — black boxes read as holes in the deck
	const wires=[];
	for(const wfa of SHIP.wires){
		const clat=strip_lat(wfa), hw=SHIP.halfspan;   // span the strip width, perpendicular to its centreline
		const a=carrier_world(wfa-STRIP_ULAT*hw,clat+STRIP_UFA*hw), b=carrier_world(wfa+STRIP_ULAT*hw,clat-STRIP_UFA*hw);
		const ddx=b.x-a.x, ddz=b.z-a.z, len=Math.hypot(ddx,ddz);
		const w=new THREE.Mesh(new THREE.BoxGeometry(len,0.05,0.05),wireMat); w.position.set((a.x+b.x)/2,dy+0.10,(a.z+b.z)/2); w.rotation.y=Math.atan2(-ddz,ddx); w.castShadow=true; scene.add(w);   // Mk 7 cross-deck pendant: 35 mm wire rope ~10 cm off the deck on its supports (drawn a touch fat for visibility)
		wires.push({ax:a.x,az:a.z,bx:b.x,bz:b.z,mesh:w});
		const wyaw=Math.atan2(-ddz,ddx);
		for(const e of [a,b]){ const s=new THREE.Mesh(new THREE.BoxGeometry(1.3,0.24,0.5),sheaveMat); s.position.set(e.x,dy+0.12,e.z); s.rotation.y=wyaw; scene.add(s); }   // deck-edge fairing housings over the sheave pockets (the real 60-90 cm sheave wheels live BELOW deck) — long low deck-grey ramps aligned with the cable run
	}
	const vsegs=[0,1].map(()=>{ const m=new THREE.Mesh(new THREE.BoxGeometry(1,0.05,0.05),wireMat); m.visible=false; m.castShadow=true; scene.add(m); return m; });   // the caught wire, dragged into a V by the hook
	// --- catapult shuttles: the towing spreader standing proud of each track slot; the launch bar drops onto it.
	// Real C-13 shuttle: a low greased-steel block with a raised towing HORN at the rear that the bar hooks
	// over — near-black worn metal, never painted ---
	const shuttleMat=new THREE.MeshStandardMaterial({color:0x2e3136,metalness:0.75,roughness:0.4});
	carrier_shuttles=SHIP.shuttles.map(cat=>{
		const w=carrier_world(cat.x,cat.z), hd=cat.h*D2R, fx=Math.cos(hd), fz=-Math.sin(hd);
		const fwdx=fx*CARRIER_C+fz*CARRIER_S, fwdz=-fx*CARRIER_S+fz*CARRIER_C;
		const m=new THREE.Group();
		const body=new THREE.Mesh(new THREE.BoxGeometry(0.7,0.08,0.32),shuttleMat); body.position.set(0.1,0.04,0); m.add(body);   // the low deck block
		const horn=new THREE.Mesh(new THREE.BoxGeometry(0.22,0.14,0.24),shuttleMat); horn.position.set(-0.22,0.13,0); horn.rotation.z=0.18; m.add(horn);   // the raised aft towing horn, leaning forward
		m.traverse(o=>{ if(o.isMesh) o.castShadow=true; });
		m.position.set(w.x, deck_y_at(carrier_model,w.x,w.z,dy), w.z); m.rotation.y=Math.atan2(-fwdz,fwdx); scene.add(m);
		return { mesh:m, home:m.position.clone() };
	});
	// --- jet blast deflectors: a Mk 7 panel behind each cat spot, engine-animated ---
	// The painted JBD boxes (plan-derived, centred on each track 18-24 m aft of the spot)
	// are the FOOTPRINT: the panel fills the box, hinged at its FORWARD edge, 1.5 cm above
	// deck while it moves (never coplanar — the z-fight rule), rising to 50° behind a hooked
	// jet. Fully down the mesh is HIDDEN and the painted deck is the flush panel — the real
	// panels are recessed flush, and any rendered plate, even deck-textured (the taxi face
	// samples the bake at the panel's own footprint), reads raised at grazing angles: its
	// edge halves the border dashes, parallax doubles them, and the steel side face draws a
	// dark outline. The underside the queued jet sees when it's raised is ribbed steel.
	// Raised, a near-black pit quad and three hydraulic rams appear in the footprint — the
	// recess the real panel lies in.
	const jbdSteel=new THREE.MeshStandardMaterial({color:0x7a8087,metalness:0.35,roughness:0.62});
	const jbdDeck=new THREE.MeshStandardMaterial({color:0x5e605c,metalness:0.05,roughness:0.95});   // fallback only: a carrier without a deck_baked material
	const jbdPitM=new THREE.MeshStandardMaterial({color:0x0c0d0f,metalness:0.1,roughness:1.0});
	const jbdRamM=new THREE.MeshStandardMaterial({color:0xb9bec4,metalness:0.85,roughness:0.3});
	let jbdTop:THREE.Material|null=null; carrier_model.traverse(o=>{ const m=(o as THREE.Mesh & {material?:THREE.Material}).material; if(!jbdTop && m?.name==='deck_baked') jbdTop=m; });   // the deck strip's own material: same texture, same light response
	const JBDS=[{x:27.2,z:16.76,h:3.30},{x:23.5,z:-3.44,h:0},{x:-68.7,z:-15.52,h:3.87},{x:-84.5,z:-27.75,h:0}];   // box centres from the bake's JBD table (post-squash deck frame, on the current track lines); h = atan(track slope × the 0.96 lateral squash)
	carrier_jbds=JBDS.map(cat=>{
		const w=carrier_world(cat.x,cat.z), hd=cat.h*D2R, fx=Math.cos(hd), fz=-Math.sin(hd);
		const fwdx=fx*CARRIER_C+fz*CARRIER_S, fwdz=-fx*CARRIER_S+fz*CARRIER_C;
		const g=new THREE.Group(); g.visible=false;   // shown only while animating/raised (update_jbds)
		g.position.set(w.x, deck_y_at(carrier_model,w.x,w.z,dy), w.z); g.rotation.y=Math.atan2(-fwdz,fwdx); scene.add(g);
		const pivot=new THREE.Group(); pivot.position.set(JBD_L/2,0.015,0); g.add(pivot);   // hinge line = the box's forward edge, 1.5 cm above deck
		const pg=new THREE.BoxGeometry(JBD_L,JBD_T,JBD_W); pg.translate(-JBD_L/2,-JBD_T/2,0);   // TOP face at hinge level: flat = flush plate, body sunk in the notional recess
		{ const pp=pg.attributes.position, uv=pg.attributes.uv;   // taxi-face UVs = the panel footprint in the bake frame, so flat = the deck's own paint (deck_baked maps u=(fa+172)/344, v=(lat+52)/100 — bake_decktex.py FA0/FA1/LA0/LA1)
			for(let i=0;i<pp.count;i++){ const gx=pp.getX(i)+JBD_L/2, gz=pp.getZ(i);
				const f2=cat.x+gx*fx-gz*fz, l2=cat.z+gx*fz+gz*fx;
				uv.setXY(i,(f2+172)/344,(l2+52)/100); } }
		const panel=new THREE.Mesh(pg,[jbdSteel,jbdSteel,jbdTop||jbdDeck,jbdSteel,jbdSteel,jbdSteel]);   // +y (taxi face) deck paint, all other faces steel
		panel.castShadow=true; pivot.add(panel);
		for(let r=0;r<4;r++){ const rib=new THREE.Mesh(new THREE.BoxGeometry(0.14,0.10,JBD_W-0.5),jbdSteel); rib.position.set(-0.55-r*1.02,-JBD_T-0.05,0); rib.castShadow=true; pivot.add(rib); }   // underside stiffeners (buried when flat, shown when raised)
		const pit=new THREE.Mesh(new THREE.PlaneGeometry(JBD_L+0.2,JBD_W+0.2),jbdPitM); pit.rotation.x=-Math.PI/2; pit.position.set(0,0.012,0); pit.visible=false; g.add(pit);
		const rams=[-1,0,1].map(k=>{ const m=new THREE.Mesh(new THREE.CylinderGeometry(0.09,0.11,1,8),jbdRamM); m.castShadow=true; m.visible=false; g.add(m); m.userData.kz=k*3.1; return m; });
		return { g, pivot, pit, rams, frac:0 };
	});
	// --- OLS (meatball) on the port bracket of the carrier (measured); glideslope stays referenced to the touchdown, not this housing ---
	const twfa=SHIP.wires[SHIP.wires.length>3?2:1], ofa=SHIP.ols.fa, olat=SHIP.ols.lat;   // OLS bracket position on the carrier's port side; the glideslope targets the 3-wire on a four-wire deck (the US aim wire), the middle wire on a three-wire fit
	const o=carrier_world(ofa,olat), datumY=dy+(SHIP.ols.model?0.66:0.8), travel=SHIP.ols.model?1.1:1.0;   // datum height + ball travel matched to the model's lens column when it provides the structure
	if(!SHIP.ols.model){ const house=new THREE.Mesh(new THREE.BoxGeometry(2.0,1.4,0.6),new THREE.MeshStandardMaterial({color:0x181b1f,metalness:0.4,roughness:0.6})); house.position.set(o.x,dy+0.2,o.z); house.rotation.y=Math.atan2(-CARRIER_C,CARRIER_S); house.castShadow=true; scene.add(house); }
	const at=(d,h)=>{ const q=carrier_world(ofa-STRIP_ULAT*d,olat+STRIP_UFA*d); return [q.x,h,q.z]; };   // flank the ball perpendicular to the strip (square to the approach)
	const dspread=SHIP.ols.model?[-1.65,-1.2,-0.75,-0.3, 0.3,0.75,1.2,1.65]:[-3.3,-2.5,-1.7,-0.9, 0.9,1.7,2.5,3.3];
	const dpos=[]; for(const d of dspread) dpos.push(...at(d,datumY)); const datumPts=ols_points(dpos,0x35e06a,7);   // green datum row (flanks the ball; spread matches the model's arm bar, TRIMMED to ±1.8 m in v54 — the authored 8.5 m bar overhung the flight deck by 2.2 m, under the cat-4 wingtip path)
	const cpos=[]; for(const d of [-1.5,-0.5,0.5,1.5]) cpos.push(...at(d,dy+1.6)); const cutPts=ols_points(cpos,0x35e06a,4);   // cut lights
	const wpos=[]; for(const d of (SHIP.ols.model?[-1.5,-1.5,1.5,1.5]:[-2.0,-0.7,0.7,2.0])) wpos.push(...at(d, wpos.length<6&&SHIP.ols.model?dy+0.9:dy+(SHIP.ols.model?1.5:2.0))); const wavePts=ols_points(wpos,0xff2a1e,7); wavePts.visible=false;   // waveoff (flashes on a low approach) — on the model's red columns when present (two heights per side)
	// structure: horizontal arms carrying the datum / cut / waveoff light rows, on a mast up from the housing (so the lights aren't floating)
	if(!SHIP.ols.model){   // procedural bracket structure — only when the ship model doesn't carry its own OLS
	const strut=new THREE.MeshStandardMaterial({color:0x15181c,metalness:0.5,roughness:0.6});
	const arm=(d,y,th)=>{ const a=at(-d,y), b=at(d,y), dx=b[0]-a[0], dz=b[2]-a[2], len=Math.hypot(dx,dz); const m=new THREE.Mesh(new THREE.BoxGeometry(len,th,th),strut); m.position.set((a[0]+b[0])/2,y,(a[2]+b[2])/2); m.rotation.y=Math.atan2(-dz,dx); m.castShadow=true; scene.add(m); };
	arm(3.9,datumY,0.13);   // datum arm (through the housing)
	const mast=new THREE.Mesh(new THREE.BoxGeometry(0.13,2.1,0.13),strut); mast.position.set(o.x,dy+1.1,o.z); mast.castShadow=true; scene.add(mast);   // mast from the housing up to the cut/waveoff
	arm(2.3,dy+1.6,0.1); arm(2.3,dy+2.0,0.1); }   // cut + waveoff arms
	const bg=new THREE.BufferGeometry(); bg.setAttribute("position",new THREE.BufferAttribute(new Float32Array([o.x,datumY,o.z]),3)); bg.setAttribute("color",new THREE.BufferAttribute(new Float32Array([1,0.62,0]),3));
	const ballPts=new THREE.Points(bg,new THREE.PointsMaterial({size:11,map:light_dot,vertexColors:true,transparent:true,blending:THREE.NormalBlending,depthWrite:false,sizeAttenuation:false})); ballPts.frustumCulled=false; ballPts.visible=false; scene.add(ballPts);   // the amber "ball" — screen-space, normal-blended so it reads amber/red
	const td=carrier_world(twfa,strip_lat(twfa));   // touchdown reference (the 2-wire) — the glideslope references the wires, NOT the OLS housing on the bracket
	const sdx=STRIP_UFA*CARRIER_C+STRIP_ULAT*CARRIER_S, sdz=-STRIP_UFA*CARRIER_S+STRIP_ULAT*CARRIER_C, sl=Math.hypot(sdx,sdz);
	carrier_ols={ x:o.x, z:o.z, dy, datumY, travel, ballPts, wavePts, datumPts, cutPts, wires, vsegs, tdx:td.x, tdz:td.z, apx:-sdx/sl, apz:-sdz/sl };   // approach comes from the −fa (aft) side, opposite the rollout
	// --- night lighting (darken-ship, night-only); heights + edges sampled off the REAL deck (which isn't flat), not a rectangle at deckY ---
	const dh=(f,l)=>{ const w=carrier_world(f,l); return { x:w.x, z:w.z, y:deck_y_at(carrier_model,w.x,w.z,-1e9) }; };   // world pos + deck height at a carrier-local point (−1e9 = off the deck)
	const edge_lat=(f,dir)=>{ let e=null; for(let l=0;Math.abs(l)<42;l+=dir*4){ const d=dh(f,l); if(d.y>dy-0.6 && d.y<dy+4) e=l; else if(e!==null) break; } return e; };   // scan out from the centre to the outermost still-DECK-LEVEL lat: the catwalks outboard sit ~1-2 m BELOW the lip and used to qualify, hanging edge lights off the ship (measured: dots at -0.84 and -2.2 m)
	const edge=[];
	for(let f=-145;f<=150;f+=18){ for(const dir of [1,-1]){ const e=edge_lat(f,dir); if(e!==null){ const d=dh(f,e); edge.push(d.x,d.y+0.3,d.z); } } }
	night_lights.push(glow_points(edge,0xf0d18a,3));                                      // warm-white deck-edge outline, on the real edge + deck height — stays up all night as the find-the-boat watch lighting
	// RECOVERY AIDS join the flight-ops group: a darkened carrier brings its deck lighting up for launch/recovery, not all night
	const line=[]; for(let f=-118;f<=48;f+=9){ const d=dh(f,strip_lat(f)); line.push(d.x,(d.y>-1e8?d.y:dy)+0.25,d.z); }   // angled-deck centreline / lineup
	ops_lights.push(glow_points(line,0xbfe6cf,3));
	const dd=dh(-140,strip_lat(-140)), db=dd.y>-1e8?dd.y:dy; const drop=[]; for(let h=0;h>=-16;h-=2.2) drop.push(dd.x,db+h,dd.z);   // red drop line down the round-down
	ops_lights.push(glow_points(drop,0xff3222,5));
	const datum=[]; for(const d2 of [-6,-4,4,6]){ const q=carrier_world(-140,strip_lat(-140)+d2); datum.push(q.x,db+0.3,q.z); }   // green ramp datum bar flanking the drop line — the LSO's ramp reference
	ops_lights.push(glow_points(datum,0x35e06a,5));
	for(const el of [[11,35,1],[-33,-11,1],[-111,-89,1],[-119,-93,-1]]){ const pts=[];   // amber elevator-edge dots (fa spans + side measured off the deck map)
		for(let f=el[0];f<=el[1];f+=6){ const e=edge_lat(f,el[2]); if(e!==null){ const d=dh(f,e); pts.push(d.x,d.y+0.25,d.z); } }
		if(pts.length) ops_lights.push(glow_points(pts,0xffb060,3)); }
	for(const [dir,col] of [[-1,0xff2418],[1,0x24ff2a]]){ const e=edge_lat(-5,dir); if(e!==null){ const d=dh(-5,e); night_lights.push(glow_points([d.x,d.y+1.2,d.z],col,5)); } }   // red (port) / green (starboard) nav lights on the beam edges
	{ const st2=dh(-160,0); if(st2.y>-1e8) night_lights.push(glow_points([st2.x,st2.y+1.5,st2.z],0xffffff,5)); }   // white sternlight on the fantail — completes the COLREGS steaming set
	const mt=(deck_grid&&deck_grid.mast)||{x:0,y:-1e9,z:0}; const my=mt.y,mx=mt.x,mz=mt.z;   // the island mast top, recorded during the grid build (the deck grid itself excludes the island, so a deck_y_at scan can never find the mast)
	if(my>dy+3){ night_lights.push(glow_points([mx,my+1.2,mz],0xffffff,6));               // white masthead just above the mast top
		night_lights.push(glow_points([mx,my+0.4,mz],0xff2418,5)); }                       // red obstruction light just below it
	// ISLAND DECK FLOODS: one glare per AUTHORED lamp fitting — the model's yellow grid arrays
	// (material_43) clustered at 0.9 m resolution = 68 individual fittings; wash spots shine
	// from the two big banks. Day geometry and night light are the same objects.
	if(my>dy+3){ const FIX=[[-68.0,29.1,16.6],[-67.9,34.8,16.6],[-62.2,28.7,16.4],[-59.9,28.3,7.5],[-59.6,28.4,8.0],[-59.3,28.4,5.2],[-58.9,28.2,5.2],[-58.5,28.1,8.5],[-58.0,28.1,8.6],[-57.9,28.1,5.3],[-57.8,28.1,8.2],[-57.4,28.0,7.5],[-55.8,27.9,7.4],[-55.6,27.9,7.9],[-55.2,27.7,8.5],[-55.1,27.8,8.5],[-54.7,27.7,5.6],[-54.1,27.7,5.6],[-53.8,27.7,8.1],[-53.4,27.6,7.9],[-52.7,28.4,19.3],[-52.7,32.1,19.3],[-50.0,27.4,10.9],[-48.6,34.4,5.9],[-45.3,37.5,16.6],[-44.8,23.9,18.4],[-44.4,24.1,18.4],[-44.3,34.4,5.9],[-43.7,23.9,18.4],[-43.1,23.9,18.9],[-42.8,24.1,18.9],[-42.1,24.1,18.9],[-41.5,23.9,18.9],[-41.1,24.0,18.7],[-40.5,24.1,18.9],[-39.8,23.9,19.0],[-39.4,24.2,18.9],[-39.0,24.3,18.4],[-39.0,24.6,19.0],[-39.0,33.6,18.6],[-38.6,24.6,18.9],[-38.6,25.0,18.4],[-38.6,26.0,18.9],[-38.6,27.0,19.0],[-38.6,27.5,19.0],[-38.6,28.4,18.9],[-38.6,29.5,18.9],[-38.6,29.9,18.9],[-38.4,25.3,19.0],[-38.4,26.3,18.9],[-38.4,27.8,18.9],[-38.4,28.7,19.0],[-38.3,28.1,15.7],[-38.3,31.7,15.7],[-38.3,32.1,15.7],[-38.2,29.2,15.9],[-38.2,30.6,15.9],[-38.2,33.1,15.9],[-38.2,33.9,15.9],[-38.1,28.4,15.6],[-38.1,28.7,15.6],[-38.1,29.7,15.6],[-38.1,32.6,15.6],[-38.1,34.1,15.6],[-38.0,29.3,15.7],[-38.0,30.1,15.8],[-38.0,32.1,15.7],[-38.0,33.2,15.8]];
		const fixtures=[];
		for(const [f,l,h] of FIX){ const q=carrier_world(f,l); fixtures.push(q.x, dy+h, q.z); }
		const mk=(f,l,h,tx,tz)=>{ const q=carrier_world(f,l); const s2=new THREE.SpotLight(0xffd9a0,320,260,0.62,0.65,1); s2.castShadow=false;
			s2.position.set(q.x,dy+h,q.z); s2.target.position.set(tx,dy,tz); scene.add(s2); scene.add(s2.target); s2.visible=false; return s2; };
		const ld=carrier_world(-80,strip_lat(-80)), bw=carrier_world(30,2);
		flood_lights.push(mk(-56.6,28.0,5.9,ld.x,ld.z), mk(-42.8,31.1,12.0,bw.x,bw.z));
		const pscale=Math.max(1, renderer.domElement.height/720);   // Points sizes are DEVICE pixels: unscaled, the lamps were 3x smaller on a 4K screen than in 720p captures
		const mkpts=(size,color)=>{ const lg=new THREE.BufferGeometry(); lg.setAttribute("position",new THREE.BufferAttribute(new Float32Array(fixtures),3));
			const lp=new THREE.Points(lg,new THREE.PointsMaterial({size:size*pscale,map:light_dot,color,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,depthTest:false,sizeAttenuation:false}));
			lp.frustumCulled=false; lp.renderOrder=998; scene.add(lp); deck_floods.push(lp); };
		mkpts(46,0x4a3a20);
		mkpts(13,0xfff2d2); }   // the white-hot lamp core   // flood GLARE sprites: constant pixels AND no depth test — the broad island superstructure occluded every depth-tested placement near the mast; a source this bright blooms through structure anyway
}
const HOOK_DROP=4, HOOK_AFT=9;   // the tailhook rides ~4 m below and ~9 m aft of the pilot's eye; the meatball flies the HOOK onto the wire, so the eye rides well above the 3.5° glideslope
function ols_dev(p,o){   // hook's deviation off the 3.5° glideslope to the touchdown: along/lateral/distance + dev (+ high, − low)
	const rx=p.x-o.tdx, rz=p.z-o.tdz, along=rx*o.apx+rz*o.apz, lat=rx*(-o.apz)+rz*o.apx;
	return { along, lat, dist:Math.hypot(rx,rz), dev:Math.atan2(p.y-o.dy-HOOK_DROP,Math.max(along+HOOK_AFT,1))*180/Math.PI-3.5 };
}
function update_ols(p){   // 3D ball on the bracket, driven by the hook's deviation off the glideslope to the touchdown
	if(!carrier_ols) return; const o=carrier_ols, s=ols_dev(p,o);
	// the IFLOLS is DIRECTIONAL: lens, datum, cut, and wave-off all project aft along
	// the final bearing into a ~±40° wedge — from the bow (or anywhere off-wedge) the
	// bracket shows no lights. tan 40° = 0.84.
	o.datumPts.visible=o.cutPts.visible = s.along>10 && s.dist<7000 && Math.abs(s.lat)<s.along*0.84;
	const approach = s.dist>40 && s.dist<5000 && s.along>40 && ownship.vely<3 && p.y>o.dy;
	o.ballPts.visible=approach; if(!approach){ o.wavePts.visible=false; return; }
	const low=s.dev<-0.7;
	const pos=o.ballPts.geometry.attributes.position; pos.setY(0, o.datumY+THREE.MathUtils.clamp(s.dev/0.8,-1,1)*o.travel); pos.needsUpdate=true;
	const col=o.ballPts.geometry.attributes.color; col.setXYZ(0, 1, low?0.1:0.62, 0); col.needsUpdate=true;
	if(low && !o.low) o.wavet=performance.now(); o.low=low;   // phase-anchor the red flash to its onset too
	o.wavePts.visible = low && !!ownship.groove && ((performance.now()-(o.wavet||0))%400)<200;   // paddles only waves an aircraft established in the groove — the lens ball above stays purely geometric (the lights are physical)
}
function seg_between(mesh,ax,az,bx,bz,y){ const dx=bx-ax, dz=bz-az, len=Math.hypot(dx,dz)||0.001; mesh.position.set((ax+bx)/2,y,(az+bz)/2); mesh.rotation.y=Math.atan2(-dz,dx); mesh.scale.x=len; }
let hook_claw=null;   // {node, local}: the tailhook claw tip, resolved once as the furthest vertex from the hook pivot (attitude-invariant in the node's local frame). (Restored with _wireApex: the #166 sweep removed both while claw_world still used them — carrier traps would throw.)
const _wireApex=new THREE.Vector3();
function claw_world(out){   // world position of the actual rendered claw, or null if the hook model isn't resolved
	if(!hook_claw){ const base=ownship.group.getObjectByName("Hook_AN_base_20"); if(!base) return null;
		const v=new THREE.Vector3(); let far=null, best=-1; base.updateWorldMatrix(true,true);
		base.traverse(o=>{ if(o.isMesh&&o.geometry?.attributes?.position){ const pos=o.geometry.attributes.position;
			for(let i=0;i<pos.count;i++){ v.fromBufferAttribute(pos,i); o.localToWorld(v); base.worldToLocal(v); const d=v.length(); if(d>best){ best=d; far=v.clone(); } } } });
		if(!far) return null; hook_claw={node:base, local:far};   // the claw in the hook node's local frame: reused every frame via localToWorld
	}
	return out.copy(hook_claw.local).applyMatrix4(hook_claw.node.matrixWorld);
}
function update_wire_drag(){   // the caught wire deforms into a V, its apex dragged forward by the tailhook; released wires snap back straight
	if(!carrier_ols) return; const o=carrier_ols, caught=ownship.trapped?ownship.wire:0;
	for(let i=0;i<o.wires.length;i++) o.wires[i].mesh.visible=(i+1)!==caught;
	if(!caught){ o.vsegs[0].visible=o.vsegs[1].visible=false; return; }
	const w=o.wires[caught-1]; ownship.group.updateMatrixWorld(true);
	const claw=claw_world(_wireApex);   // the V apex rides the ACTUAL claw, not the fixed pos-6.5m guess that floated ~0.9 m above it (#72)
	let hx, hz, hy;
	if(claw){
		const rx=ownship.right.x, rz=ownship.right.z, rl=Math.hypot(rx,rz)||1;   // starboard, horizontal-projected
		const off=((claw.x-ownship.pos.x)*rx+(claw.z-ownship.pos.z)*rz)/(rl*rl);   // the claw vertex sits ~7 cm off the centreline (furthest-vertex of the asymmetric claw); project the apex back onto the jet's vertical centreline so the V is dead centre under the hook (#72)
		hx=claw.x-rx*off; hz=claw.z-rz*off; hy=Math.max(claw.y, o.dy+0.05);   // clamp to the deck: the mesh tip dips a touch below, the wire rides on top
	}
	else { hx=ownship.pos.x-ownship.fwd.x*6.5; hz=ownship.pos.z-ownship.fwd.z*6.5; hy=o.dy+0.5; }   // fallback before the model resolves
	seg_between(o.vsegs[0],w.ax,w.az,hx,hz,hy); seg_between(o.vsegs[1],hx,hz,w.bx,w.bz,hy); o.vsegs[0].visible=o.vsegs[1].visible=true;
}
function build_aircraft_lights(){   // nav position lights (red port / green stbd / white tail) + white anti-collision strobes + forward landing light, on the ownship
	const mk=(color,x,y,z,size)=>{ const g=new THREE.BufferGeometry(); g.setAttribute("position",new THREE.BufferAttribute(new Float32Array([x,y,z]),3));
		const p=new THREE.Points(g,new THREE.PointsMaterial({size,map:light_dot,color,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,sizeAttenuation:true})); p.frustumCulled=false; ownship.group.add(p); return p; };   // aircraft-local: +x nose, +y up, +z starboard
	const spot=new THREE.SpotLight(0xfff2d8,200,500,0.34,0.5,1); spot.castShadow=false; spot.layers.enable(LAYER_OWN);   // decay 1 (not inverse-square) so the beam still reaches the deck from up the approach; tuned so it lights a pool ahead without flooding the whole transom
	const st=new THREE.Object3D(); scene.add(spot,st); spot.target=st;   // in the SCENE, not the aircraft group (hidden in first-person) — positioned each frame to follow the nose
	aircraft_lights={
		pos:[ mk(0xff2020,0,0,-6,1.3), mk(0x20ff20,0,0,6,1.3), mk(0xffffff,-8.4,0.4,0,1.1) ],           // red left wing, green right wing, white tail (guesses; re-pinned to the airframe once the GLB loads)
		strobe:[ mk(0xffffff,0,-0.15,-6,1.9), mk(0xffffff,0,-0.15,6,1.9), mk(0xffffff,-7.6,1.0,0,1.9) ], // anti-collision strobes
		landing:[ mk(0xfff4d8,4.6,-1.2,0,2.6) ], spot, spotTarget:st, nose:{x:4.6,y:-1.2} };             // forward landing light: the nose glow (in the group) + the spotlight beam (in the scene)
	position_aircraft_lights();
}
function position_aircraft_lights(){   // pin the lights to the real airframe: cluster the loaded model's extreme vertices for the wingtips (full span) and the tail/nose (centreline only, so a swept stabilator tip or missile fin can't win). The hardcoded offsets are only a pre-load fallback.
	if(!aircraft_lights) return; const m=ownship.group.children.find(c=>c.userData.model); if(!m) return;
	ownship.group.updateMatrixWorld(true);
	const inv=new THREE.Matrix4().copy(ownship.group.matrixWorld).invert(), v=new THREE.Vector3();
	const each=f=>m.traverse(o=>{ if(!o.isMesh) return; const p=o.geometry&&o.geometry.getAttribute("position"); if(!p) return;
		for(let i=0;i<p.count;i++){ f(v.fromBufferAttribute(p,i).applyMatrix4(o.matrixWorld).applyMatrix4(inv)); } });
	let zmin=1e9,zmax=-1e9,xmin=1e9,xmax=-1e9;   // aircraft-local: +x nose, +y up, +z starboard; tail/nose restricted to |z|<0.9 (centreline)
	each(p=>{ if(p.z<zmin)zmin=p.z; if(p.z>zmax)zmax=p.z; if(Math.abs(p.z)<0.9){ if(p.x<xmin)xmin=p.x; if(p.x>xmax)xmax=p.x; } });
	if(zmin>1e8||xmin>1e8) return;
	const acc={port:[0,0,0,0],stbd:[0,0,0,0],tail:[0,0,0,0],nose:[0,0,0,0]}, add=(a,p)=>{ a[0]+=p.x; a[1]+=p.y; a[2]+=p.z; a[3]++; };
	each(p=>{ if(p.z-zmin<0.3) add(acc.port,p); if(zmax-p.z<0.3) add(acc.stbd,p);
		if(Math.abs(p.z)<0.9){ if(p.x-xmin<0.4) add(acc.tail,p); if(xmax-p.x<0.4) add(acc.nose,p); } });
	const mean=a=>({x:a[0]/a[3], y:a[1]/a[3], z:a[2]/a[3]});
	const port=mean(acc.port), stbd=mean(acc.stbd), tail=mean(acc.tail), nose=mean(acc.nose);
	const set=(pts,x,y,z)=>{ const a=pts.geometry.getAttribute("position"); a.setXYZ(0,x,y,z); a.needsUpdate=true; };
	const L=aircraft_lights;
	set(L.pos[0], port.x, port.y, zmin); set(L.pos[1], stbd.x, stbd.y, zmax); set(L.pos[2], xmin+0.5, tail.y, tail.z);   // nav lights on the wingtip extremities + the stern, tucked against the tail
	set(L.strobe[0], port.x, port.y-0.12, zmin); set(L.strobe[1], stbd.x, stbd.y-0.12, zmax); set(L.strobe[2], xmin+0.6, tail.y+0.25, tail.z);   // strobes beside them
	let gn=null; m.traverse(o=>{ if(o.name==="gear_nose") gn=o; });   // the nose-gear strut node in the GLB (bind pose = gear down)
	if(gn){ const p=new THREE.Vector3(); gn.getWorldPosition(p); p.applyMatrix4(inv); L.nose={x:p.x+0.15, y:p.y-1.1}; }   // partway down the strut from the hinge
	else L.nose={x:xmax-3.5, y:-1.2};
	set(L.landing[0], L.nose.x, L.nose.y, nose.z);   // landing light on the nose gear strut (as on the real Hornet), so it exists only with the gear down
}
let build_error="";   // first cockpit-builder failure, surfaced via dev_probe
const instrument_mats=[];   // the two gauge-atlas materials, per loaded model — backlight follows night + the lights switch
let backlight_state="";
function instrument_backlight(){
	const level=cfg.tod==="night"?(ownship.lights?0.62:0.30):0.22;   // dim wash by day; night panel follows the lights switch (L)
	const key=level.toFixed(2); if(key===backlight_state) return; backlight_state=key;
	for(const mm of instrument_mats) mm.emissiveIntensity=level; }
let cockpit_flood=null;
function update_shuttles(){   // the hooked cat's shuttle rides with the jet's launch bar; the others sit home
	if(!carrier_shuttles) return;
	// The shuttle is mechanically attached to the launch bar, so it follows the bar tip
	// whenever the jet is HOOKED — parked (the holdback spring stretches the nose ~0.2-0.8 m
	// forward of the spot at run-up power) as well as through the stroke. Drawing it only
	// during the launch left it pinned at the spot while the bar strained forward, so the
	// jet looked parked in front of the shuttle. The horn (local -0.22 m) meets the deployed
	// bar tip (~0.06 m ahead of the nose gear) when the group origin leads the nose gear by 0.28 m.
	const active=ownship.launching?cat_idx:on_cat_spot();   // the cat the jet is hooked to (on_cat_spot is -1 mid-launch)
	const nose=(AIRCRAFT_MODELS[own_aircraft()]||AIRCRAFT_MODELS.fa18c).nose||5.3;
	for(let i=0;i<carrier_shuttles.length;i++){ const s=carrier_shuttles[i];
		if(i===active) s.mesh.position.set(ownship.pos.x+ownship.fwd.x*(nose+0.28), s.home.y, ownship.pos.z+ownship.fwd.z*(nose+0.28));
		else s.mesh.position.copy(s.home); }
}
const _ramDir=new THREE.Vector3(), _ramUp=new THREE.Vector3(0,1,0);
function update_jbds(dt){   // the hooked cat's deflector rises through run-up and the stroke, drops after
	if(!carrier_jbds) return;
	const active=ownship.launching?cat_idx:on_cat_spot();
	for(let i=0;i<carrier_jbds.length;i++){ const j=carrier_jbds[i];
		const tgt=i===active?1:0, rate=tgt>j.frac?0.9:0.55;   // ~1.1 s up (hydraulic), ~1.8 s settle down
		j.frac=THREE.MathUtils.clamp(j.frac+THREE.MathUtils.clamp(tgt-j.frac,-rate*dt,rate*dt),0,1);
		const th=j.frac*JBD_ANG;
		j.pivot.rotation.z=-th;   // -z rotation lifts the aft (free) edge
		j.g.visible=j.frac>0.002;   // fully down = the painted deck IS the flush panel: even deck-textured, a 1.5 cm plate reads raised at grazing angles (its edge halves the border dashes and the parallax doubles them, with the steel side face drawing a dark outline)
		const show=j.frac>0.06; j.pit.visible=show;
		// rams: fixed base in the pit to an attachment on the panel underside (pivot-local
		// x -2.5), which sweeps with the hinge angle — position/orient/stretch each frame
		const ax=-2.5*Math.cos(th)-JBD_T*Math.sin(th), ay=2.5*Math.sin(th)-JBD_T*Math.cos(th);   // attachment on the panel UNDERSIDE (pivot-local -2.5,-T), swept by the hinge angle
		const hx=JBD_L/2, tipx=hx+ax, tipy=0.015+ay, bx=hx-2.9, by=0.04;
		for(const m of j.rams){ m.visible=show; if(!show) continue;
			const len=Math.hypot(tipx-bx,tipy-by);
			m.scale.set(1,Math.max(len,0.05),1);
			m.position.set((bx+tipx)/2,(by+tipy)/2,m.userData.kz);
			_ramDir.set(tipx-bx,tipy-by,0).normalize();
			m.quaternion.setFromUnitVectors(_ramUp,_ramDir); }
	}
}
function update_aircraft_lights(){
	if(!aircraft_lights) return; const on=!!ownship.lights, strobe=on && (performance.now()%1100)<70;   // ~1 Hz strobe flash
	instrument_backlight();
	if(!cockpit_flood){ cockpit_flood=new THREE.PointLight(0xffd9a8,0,2.2,2); cockpit_flood.layers.set(LAYER_OWN);   // panel flood (#99): the night pit is otherwise unlit; layer-own so the world pass never pays for it
		ownship.group.add(cockpit_flood); }
	const at=ownship.group.userData.eye||{x:3.0,y:0.6}; cockpit_flood.position.set(at.x+0.45,at.y-0.15,0);
	cockpit_flood.intensity=(on&&cfg.view==="cockpit")?0.12:0;   // follows the L lights toggle, only spends when the pit is on screen
	const geardown=(ownship.gear??0)<0.02, land=on && geardown;   // the landing light rides the nose gear strut: on when the extend animation finishes (down & locked, the HUD's green GEAR threshold), dark the moment retraction starts
	for(const p of aircraft_lights.pos) p.visible=on; for(const p of aircraft_lights.landing) p.visible=land; for(const p of aircraft_lights.strobe) p.visible=strobe;
	const spot=aircraft_lights.spot; spot.visible=land;   // the landing-light beam lights whatever it points at (kept in the scene so it works in first-person, where the aircraft group is hidden)
	if(land){ const n=aircraft_lights.nose; spot.position.copy(ownship.pos).addScaledVector(ownship.fwd,n.x).addScaledVector(ownship.up,n.y);   // at the strut
		aircraft_lights.spotTarget.position.copy(ownship.pos).addScaledVector(ownship.fwd,70).addScaledVector(ownship.up,-15); }   // aim forward + ~12° down
}
function approach_deviation(){   // shared by the HUD ICLS needles and the cockpit ADI bars: one computation, one truth
	if(!carrier_ols) return null; const o=carrier_ols, p=ownship.pos, s=ols_dev(p,o);
	if((ownship.gearTarget??0)>0.5) return null;   // the ICLS boxes with the landing checklist (gear down) — the auto-display stands in for the pilot selecting ILS, and a clean pass up the wake is not an approach
	const toward=(o.tdx-p.x)*ownship.fwd.x+(o.tdz-p.z)*ownship.fwd.z;   // >0 = nose pointing at the touchdown
	if(!(s.along>60 && s.dist<15000 && toward>0 && p.y>o.dy)) return null;   // on the approach: aft, within ~8 nm, heading at the boat
	const az=Math.atan2(s.lat,Math.max(s.along,1))*180/Math.PI;                        // ° off the extended centreline
	if(Math.abs(az)>5) return null;   // needles alive only near the localizer: the Case I upwind runs ~9° off the angled centreline, and pegged bars there were clutter, not guidance
	return { az:THREE.MathUtils.clamp(az/3,-1,1), gs:THREE.MathUtils.clamp(s.dev/0.8,-1,1) }; }
// Dial calibrations measured off the GLB's face textures (the needle tracks are
// uncalibrated demo spins). Piecewise-linear: value -> dial angle, degrees
// clockwise from the needle's rest. The standby ASI expands 60-200 kt (the
// approach band) and compresses beyond; the VSI is the usual log-ish card.
const ASI_DIAL=[[0,0],[60,14],[100,54],[150,108],[200,202],[300,242],[400,263],[500,287],[600,302],[700,321],[800,340],[850,350]];
const VSI_DIAL=[[0,0],[500,28],[1000,44],[2000,73],[4000,119],[6000,180]];
function dial(table,v){ const a=Math.abs(v);
	for(let i=1;i<table.length;i++){ if(a<=table[i][0]){ const [v0,d0]=table[i-1], [v1,d1]=table[i];
		return Math.sign(v)*(d0+(d1-d0)*(a-v0)/(v1-v0))*D2R; } }
	return Math.sign(v)*table[table.length-1][1]*D2R; }
let flow_state={t:0,fuel:0,pph:0};   // smoothed total burn from the fuel word itself — honest, includes AB and leaks
function update_gauges(out){   // instrument channels for the cockpit rig (#99)
	const dev=approach_deviation();
	const cas=(out[STATE.cas]||0)*1.944, altitude=Math.max(0,(out[STATE.position+1]||0)*3.281);
	const fpm=THREE.MathUtils.clamp((out[STATE.velocity+1]||0)*196.85,-6000,6000);
	const lbs=Math.max(0,(out[STATE.fuel]||0)*2.2046);
	const extlbs=Math.max(0,(out[STATE.external]||0)*2.2046);   // external-tank fuel (#17): burns first, shown on the FUEL page and inside the totals
	const t=out[STATE.time]||0;
	if(t>flow_state.t){ const target=THREE.MathUtils.clamp((flow_state.fuel-out[STATE.fuel])/(t-flow_state.t)*2.2046*3600,0,40000);
		flow_state.pph+=(target-flow_state.pph)*Math.min(1,(t-flow_state.t)/2); }   // ~2 s smoothing so the counter reads steadily
	flow_state={t, fuel:out[STATE.fuel]||0, pph:flow_state.pph};
	const sL=THREE.MathUtils.clamp(out[STATE.engine]||0,0,1), sR=THREE.MathUtils.clamp(out[STATE.engine+2]||0,0,1);
	const rL=THREE.MathUtils.clamp(out[STATE.engine+1]||0,0,1), rR=THREE.MathUtils.clamp(out[STATE.engine+3]||0,0,1);
	// The instruments read what the DAMAGED engine actually does (#41): the core
	// keeps spool as the commanded thrust basis and scales output by health, so
	// the gauges scale the same way — a dead core windmills near 35% N2 with a
	// cooling can, instead of showing 99%/810°C on the page the pilot opens to
	// find out which engine is gone (NATOPS 15.1).
	const hL=1-THREE.MathUtils.clamp(out[STATE.engine_harm]||0,0,1), hR=1-THREE.MathUtils.clamp(out[STATE.engine_harm+1]||0,0,1);
	const gL=sL*hL, gR=sR*hR, bL=rL*hL, bR=rR*hR;   // health-weighted spool/reheat: the gauges' and the effects' drive
	const vx=out[STATE.velocity]||0, vz=out[STATE.velocity+2]||0, vh=Math.hypot(vx,vz);   // horizontal velocity: HSI ground track and groundspeed
	const now=new Date();
	ownship.gauges={
		pitch:Math.asin(THREE.MathUtils.clamp(ownship.fwd.y,-1,1)),
		bank:Math.atan2(ownship.right.y,ownship.up.y),
		heading:Math.atan2(ownship.fwd.x,-ownship.fwd.z),
		slip:THREE.MathUtils.clamp(out[STATE.beta]/0.10,-1,1),   // ±~6° of sideslip = full ball travel
		glide:dev?dev.gs:0, loc:dev?dev.az:0,                    // park centred off-approach
		throttle:ownship.throttle||0,                            // the LEVERS show the hand, not the spool
		stickPitch:last_controls?last_controls.pitch:0, stickRoll:last_controls?last_controls.roll:0,
		asi:dial(ASI_DIAL,cas), altitude,
		vsi:dial(VSI_DIAL,fpm),
		fuelLbs:Math.min(lbs,21000),
		rpmL:35+(30+34*gL)*hL, rpmR:35+(30+34*gR)*hR,            // F404 N2: ground idle ~65 %, military 99; a dead core windmills near 35
		egtL:300+(150+360*gL)*hL+90*bL, egtR:300+(150+360*gR)*hR+90*bR,   // °C, F404-shaped: idle ~450, military ~810, max reheat ~900 — inside the -402's 920 steady-state ceiling (NATOPS 4.1.1.2); it read 950, above even the 942 transient, so hard flying showed a permanent over-temperature. A dead can cools toward 300
		flowL:THREE.MathUtils.clamp(flow_state.pph*((0.12*hL+gL+3.4*bL)/((0.12*hL+gL+3.4*bL)+(0.12*hR+gR+3.4*bR)||1))/10,0,999),   // the honest measured total, split by each engine's own health-weighted demand — a dead engine's counter winds to zero, matching the core's burn (#41)
		flowR:THREE.MathUtils.clamp(flow_state.pph*((0.12*hR+gR+3.4*bR)/((0.12*hL+gL+3.4*bL)+(0.12*hR+gR+3.4*bR)||1))/10,0,999),
		hyd:(gL+gR)>0.03?2.83:0,                                 // ~3000 psi on the 0-5k arc while either healthy pump turns (an engine failure takes its side's circuit, NATOPS 15.4)
		cabin:Math.min(altitude,8000+Math.max(0,altitude-8000)*0.35)*(5.2/50000),   // ECS schedule: sea-level cabin to 8k, then bleed up
		volts:(gL+gR)>0.03?1.86:1.55,                            // generators 28 V / battery 24 V on the ±143° dual voltmeter
		clockH:(now.getHours()%12)+now.getMinutes()/60, clockM:now.getMinutes()+now.getSeconds()/60, clockS:now.getSeconds(),
		casKt:cas, fpm, spoolL:gL, spoolR:gR, reheatL:bL, reheatR:bR, fuelRaw:lbs, externalRaw:extlbs, mach:out[STATE.mach]||0,
		track:vh>2?Math.atan2(vx,-vz):null, ground:vh*1.944 };   // track null at taxi speeds — the diamond parks off the rose rather than swinging with tyre scrub
	lamps_update(out);
	const ind=ownship.group.userData.indexer;
	if(ind&&INDEXER_TEST){ ind.slow.opacity=1; ind.donut.opacity=1; ind.fast.opacity=1; }
	else if(ind){ const devd=(out[STATE.alpha]||0)/D2R-8.1;   // Control.Onspeed, the PA on-speed alpha datum (trim.go)
		// The indexer arms with the gear AND weight off wheels, and FLASHES
		// when the hook is up (NATOPS 2.12.10) — the jet telling you at eye
		// level that you forgot it, long before the hook-up waveoff at 1,200 m.
		// It was alpha alone: steady on a hook-up approach, and still lit
		// through the rollout after a trap.
		const blink=((ownship.hook??0)<0.5)?(Math.floor(sim_time*3)%2):1;
		const lit=(out[STATE.extension]||0)>0.9 && !ownship.grounded && blink>0;
		ind.slow.opacity = lit?THREE.MathUtils.clamp((devd-0.4)/0.5,0,1):0;
		ind.fast.opacity = lit?THREE.MathUtils.clamp((-devd-0.4)/0.5,0,1):0;
		ind.donut.opacity= lit?THREE.MathUtils.clamp(1-(Math.abs(devd)-0.5)/0.5,0,1):0; } }
generate_world();
// ---- input ----
const input={ pitch:0, roll:0, yaw:0, guns:false, brake:false };
const keys=new Set();
let cam_az=0, cam_el=0.22, cam_dist=24, cam_psi=0;
let buffet_env=0;   // low-passed buffet intensity (#234): the seat cue's shared envelope — the camera writes it each frame, draw_hud reads it
let head_az=0, head_el=0, head_drag=false;   // cockpit head look (#99): mouse-drag or arrow keys. The head HOLDS where it is left, like the chase orbit — 0 (view.reset) recenters
/* #57 parked — head tracking is disabled for now. To re-enable, uncomment this
block, the import at the top, the head_apply/head_begin/head_close call sites,
the view_reset datum capture, the dev_probe tracking field, the dev_head devq
read, and the Head tab in MissionSetup.tsx (plus config.head and the SetupTab
member).
// --- Webcam head tracking (#57): while a session is live and the face is
// fresh, the tracked pose owns head_az/head_el in the first-person views; the
// arrows still work the moment tracking is off or the face is lost (which
// eases the view home). 0 (view.reset) re-datums the CURRENT physical pose
// BEFORE zeroing — "make here neutral" and "recentre" are the same press.
let head_track=null, head_starting=false, head_pose=null, head_at=0, head_ok=false, head_seen=false, dev_head=false;
let head_datum={ yaw:0, pitch:0 };
const head_yaw=new HeadEuro(), head_pitch=new HeadEuro();
function head_begin(){ if(head_track||head_starting) return;
	dev_head=dev_head||(DEV_MODE&&new URLSearchParams(location.search).get("head")==="1");   // read here, not just at the devq parse: mission start can run before that block (#48's ordering lesson)
	if(!((cfg.head&&cfg.head.on)||dev_head)) return;
	head_starting=true;
	const base=new URL("tracking-1.0.1/",location.href).href;
	Promise.resolve(shellStorage.getItem("air.camera")).then(stored=>{
		let device=""; try{ device=stored?JSON.parse(stored):""; }catch(_){ device=""; }
		return head_start({ base, model: base+"face_landmarker.task", device,
			pose:(p)=>{ head_ok=!!p.ok; if(p.ok){
				if(!head_seen){ head_seen=true; head_datum={ yaw:p.yaw, pitch:p.pitch }; }   // first sight IS the calibration: wherever the head rests when tracking wakes is neutral
				const t=performance.now(), dt=head_at?Math.min(0.2,(t-head_at)/1000):0.033; head_at=t;
				head_pose={ yaw:head_yaw.next(p.yaw,dt), pitch:head_pitch.next(p.pitch,dt), raw:p }; } },
			end:()=>{ head_track=null; head_ok=false; } });
	}).then(r=>{ head_starting=false; if(r&&r.head) head_track=r.head; else if(r&&r.error) notice("HEAD TRACKING: "+String(r.error).toUpperCase()); })
	.catch((e)=>{ head_starting=false; console.warn("head tracking failed to start",e); });
}
function head_close(){ if(head_track){ head_track.stop(); head_track=null; } head_ok=false; head_seen=false; head_pose=null; head_at=0; head_yaw.reset(); head_pitch.reset(); }
function head_apply(dt){ if(!head_track) return;
	if(cfg.view!=="cockpit"&&cfg.view!=="hud") return;   // first-person views only; chase/flypast/padlock keep their own logic
	const fresh=head_ok&&head_pose&&performance.now()-head_at<400;
	const gain=(cfg.head&&cfg.head.gain)||5;
	const az=fresh?head_shape(head_pose.yaw-head_datum.yaw,gain,2.618):0;
	const el=fresh?THREE.MathUtils.clamp(head_shape(head_pose.pitch-head_datum.pitch,gain,1.396),-1.047,1.396):0;
	const k=Math.min(1,dt*12);   // glide bridges the 30 Hz pose to frame rate, and eases the view home when the face is lost
	head_az+=(az-head_az)*k; head_el+=(el-head_el)*k;
	if(fresh&&Math.abs(az)>0.05){ padlock=false; padlock_snap=false; } }   // a deliberate head turn takes the view back from padlock; a resting head leaves it alone
*/
let padlock=false, padlock_snap=false, padlock_warned=false;   // padlock (#243, fourth iteration): HOLD Y to look at the target — the head eases there fast and smoothly, release eases it home. No toggle, no helmet symbology: the user removed the JHMCS after three rounds — overlays never substituted for knowing your own jet
let view_zoom=1, zoom_target=1, zoom_wheel=0;   // optical zoom: notches move the TARGET, the view eases after it (stepping the FOV directly read as jerky); per-view values persist in the config (zoom_<view>, #209)
let zoom_save=0;   // debounce handle for persisting the zoom
function zoom_floor(){ return cfg.view==="chase"?0.5:0.6; }   // chase zooms out to 90° wide; first person to ~75°, which is nearer what a pilot actually takes in than the 45° a 1x floor pinned it to
function zoom_recall(v){ return THREE.MathUtils.clamp(Number(cfg["zoom_"+v])||1, v==="chase"?0.5:0.6, 4); }
function zoom_persist(){   // remember the setting per view, debounced past the notch flurry
	const view=cfg.view, value=()=>Math.round(zoom_target*100)/100;   // the view is captured at SCHEDULE time: a swap inside the debounce window otherwise files this zoom under the view just switched TO
	if(zoom_save) clearTimeout(zoom_save);
	zoom_save=window.setTimeout(()=>{ zoom_save=0;
		const key="zoom_"+view, v=view===cfg.view?value():Math.round(zoom_recall(view)*100)/100;
		if(cfg[key]!==v){ cfg[key]=v; if(on_config) on_config({ [key]:v }); } },800); }
let on_config=null;   // engine -> menu config channel (startGame option): partial updates the menu merges and saves
const _headq=new THREE.Quaternion(), _pitq=new THREE.Quaternion(), _yaxis=new THREE.Vector3(0,1,0), _zaxis=new THREE.Vector3(0,0,1);
const _vig=new THREE.Vector3(), _vigr=new THREE.Vector3(), _vigu=new THREE.Vector3();   // hit-vignette scratch (#239)
const _pad_d=new THREE.Vector3();   // padlock scratch (#243)
const CAMFIX=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),-Math.PI/2);   // maps the camera's -Z view axis onto body +X with +Y up   // chase view: orbit around the aircraft; cam_psi = smoothed heading the orbit is referenced to
let flyby_pos=null, flyby_side=1;          // flypast view: fixed world point the jet flies past, re-seeded ahead as it recedes
// True while the aircraft is sitting/rolling on the deck or runway (not yet airborne) — gear can't retract then.
let marshal=null, pattern=null;   // Case III script / Case I-II visual pattern (#50)   // Case III recovery state (#205): {push: sim_time of the assigned EAT, commenced, platform, dirty, ball} — null outside a Case III mission
const MARSHAL_PUSH=DEV_MODE&&+(new URLSearchParams(location.search).get("push")||0)>0?+(new URLSearchParams(location.search).get("push")||0):360;   // one full six-minute racetrack to the push; &push=N (dev) shortens it for testing
function clock_text(seconds){ const s=Math.max(0,Math.round(seconds)); return Math.floor(s/60)+":"+String(s%60).padStart(2,"0"); }
// marshal_watch: the Case III radio script, driven by range and altitude. The
// controller calls come from range gates (MARSHAL/APPROACH/PADDLES callsigns
// verbatim, call words localised — the #139 radio rule); the pilot's own calls
// carry the callsign. Commencing is judged against the assigned push time:
// within ±10 s is on time, as the real recovery demands.
function marshal_watch(){ if(!marshal||!running) return;
	const range=Math.hypot(wrap_axis(CARRIER.x-ownship.pos.x),wrap_axis(CARRIER.z-ownship.pos.z));
	if(!marshal.commenced){ if(range<20.5*1852){ marshal.commenced=true;
		const delta=sim_time-marshal.push;
		let call=translate("COMMENCING");
		if(Math.abs(delta)>10) call+=" — "+(delta<0?translate("EARLY"):translate("LATE"))+" "+Math.round(Math.abs(delta))+"s";
		comm((cfg.callsign||"701")+": "+call, "#9fd0ff"); }
		return; }
	if(!marshal.platform && ownship.pos.y<1524){ marshal.platform=true; comm((cfg.callsign||"701")+": "+translate("PLATFORM"), "#9fd0ff"); }
	if(!marshal.dirty && range<10*1852){ marshal.dirty=true; comm("APPROACH: "+translate("LEVEL AT 1200, DIRTY UP"), "#9fd0ff"); }
	if(!marshal.ball && range<0.75*1852){ marshal.ball=true; call_the_ball(); } }
// pattern_watch is the Case I/II analogue of marshal_watch (#50): the visual
// pattern's own gates, in NATOPS 8.2.10's order — the break, the 250 kt
// dirty-up, the 600 ft downwind, the abeam, and the ball. Case III was fully
// scripted while Case I — the mode a player picks in order TO FLY THE
// PATTERN — offered nothing at all between spawn and the LSO watch.
function pattern_watch(){ if(!pattern||!running) return;
	const range=Math.hypot(wrap_axis(CARRIER.x-ownship.pos.x),wrap_axis(CARRIER.z-ownship.pos.z));
	const feet=ownship.pos.y*3.28084, kt=(ownship.cas||0)*1.9438;
	if(!pattern.broke){ if(range<1.2*1852){ pattern.broke=true;
		comm("TOWER: "+translate("BREAK WHEN READY"), "#9fd0ff"); }
		return; }
	if(!pattern.dirty){ if(kt<250&&(ownship.gearTarget??0)>0.5){ pattern.dirty=true;
		comm((cfg.callsign||"701")+": "+translate("DIRTY UP"), "#9fd0ff"); }
		else if(kt<250&&!pattern.told){ pattern.told=true;
			comm("TOWER: "+translate("BELOW 250 — GEAR AND FLAPS"), "#9fd0ff"); }
		return; }
	if(!pattern.downwind && feet<800 && range>0.7*1852){ pattern.downwind=true;
		comm("TOWER: "+translate("DOWNWIND 600 FEET"), "#9fd0ff"); }
	if(!pattern.ball && range<0.75*1852){ pattern.ball=true; call_the_ball(); } }
// call_the_ball is the paddles prompt AND the pilot's reply (NATOPS 8.2.10:
// "call sign, Hornet, Ball or CLARA, fuel state, auto"). Both Case III and the
// visual pattern use it; only the prompt existed, and only in Case III.
function call_the_ball(){
	comm("PADDLES: "+translate("CALL THE BALL"), "#9fd0ff");
	const hundreds=Math.round(((ownship.fuel??0)+(ownship.external??0))*2.2046/100)/10;   // fuel state to the nearest 100 lb, spoken in thousands
	// BALL or CLARA: CLARA ("clear as mud") is the call when the lens is not
	// yet in sight — off the centreline, or below the glideslope's lower
	// lens travel where the amber ball has dropped out of view.
	const clara=(()=>{ if(!carrier_ols) return true; const s=ols_dev(ownship.pos,carrier_ols);
		return Math.abs(Math.atan2(s.lat,Math.max(s.along,1))*180/Math.PI)>4 || s.dev<-1; })();
	const ball=clara?translate("CLARA"):translate("BALL");
	comm((cfg.callsign||"701")+": "+translate("HORNET")+" "+ball+" "+hundreds.toFixed(1)+(atc_on?" "+translate("AUTO"):""), "#9fd0ff"); }
function mission_start(){ const start=cfg.task==="joust"?"joust":cfg.start; return start==="landing"?"case2":start; }   // joust always starts at the merge; the Start selector applies to free flight only. "landing" is the legacy saved value for what is now Case II (#205)
function takeoff_surface(){ const st=mission_start(); if(st==="carrier") return CARRIER.deckY; if(st==="runway"&&airports.length) return airports[0].start.y; return 8; }
function on_ground(){ return ownship.launching||!!ownship.grounded; }   // the real resting flag, not an altitude guess — off the cat you fly level at deck height, where a +12 m heuristic left G dead
addEventListener("keydown",e=>{ if(e.target instanceof HTMLInputElement||e.target instanceof HTMLTextAreaElement) return;   // the chat box owns the keyboard while focused (#84) — no flares while typing f
	if(["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"," ","PageUp","PageDown","/"].includes(e.key)) e.preventDefault();
	audio_gesture();   // the first gesture unlocks the audio context (browser policy)
	const k=e.code; if(!keys.has(k)){ // edge-triggered actions
		const ch=(e.shiftKey?"Shift+":"")+k;   // full chord — remappable actions match this, so a shift-chord never fires the bare-key action and vice versa
		if(ch===key_of("launch") && launch_status()===2){ if((ownship.fold??0)>0.02) notice(translate("SPREAD WINGS")); else start_launch(); }   // only when spotted on the cat, lined up, at full power — and never with the wings folded
		if(ch===key_of("acquire") && MULTIPLAYER && !on_ground()) acquire_target();   // ACM acquisition (in flight, Enter is free — the catapult owns it only on deck); single-player auto-designates the lone bandit
		if(ch===key_of("select")){ set_master(master==="gun"?"9m":master==="9m"?"nav":"gun"); }   // weapon select (#133): GUN -> 9M -> NAV -> GUN; the HUD master mode follows, and crossing the A/A-NAV boundary recalls that mode's displays (#15)
		if(ch===key_of("altitude")){ alt_radar=!alt_radar; }   // HUD altitude switch: BARO <-> RDR
		if(ch===key_of("reject")){ declutter=(declutter+1)%3; notice(translate(["HUD NORM","HUD REJ 1","HUD REJ 2"][declutter])); }     // the three-position symbology reject switch (NATOPS 2.13.4.8.1) — unbound by default: re-pressing 2 cycles it; the action stays for players who want a dedicated key or button
		if(ch===key_of("guns")) trigger_missile();   // one trigger, weapon-selected: in 9M the trigger launches (the real Hornet's trigger fires the selected A/A weapon) chases the acquisition when one exists (the server's seeker judges the real damage)
		if(TEST_SCENARIOS && e.ctrlKey && k==="KeyC"){ copy_here(); notice("POSITION COPIED"); }   // dev (Ctrl+C): the live position line to the clipboard — for identifying deck locations (spots, markings) by taxiing onto them
		if(ch===key_of("probe")){ ownship.probeTarget=(ownship.probeTarget??0)>0.5?0:1; notice(ownship.probeTarget?translate("PROBE OUT"):translate("PROBE IN")); }   // refueling probe (real limit is ~300 KCAS — procedural, not enforced)
		if(ch===key_of("fold")){ if((ownship.squish??0)>0.5 && ownship.speed<15){ ownship.foldTarget=(ownship.foldTarget??0)>0.5?0:1; notice(ownship.foldTarget?translate("WINGS FOLDING"):translate("WINGS SPREADING")); } else notice(translate("WINGS LOCKED")); }   // wing fold — ground only, taxi speeds; the outer panels carry the ailerons and outer slats with them
		if(ch===key_of("canopy")){ if((ownship.squish??0)>0.5 && ownship.speed<15){ ownship.canopyTarget=(ownship.canopyTarget??0)>0.5?0:1; notice(ownship.canopyTarget?translate("CANOPY OPEN"):translate("CANOPY CLOSED")); } else notice(translate("CANOPY LOCKED")); }   // Shift+C: canopy — ground only, taxi speeds (NATOPS closes it before takeoff; ~60 kt operation wind limit)
		if(ch===key_of("flares") && ownship.cm>0 && (ownship.squish??0)<0.1){ dispense_flares(ownship); if(!cheat("ammunition")) ownship.cm--; flare_flag=true; audio_flare(); }   // plain F only — Shift+F is the probe (self-guarded, NOT an else-chain: an inserted handler between the pair once re-aimed the else and Shift+F dropped flares). Weight-on-wheels inhibits the dispenser, as the real ALE-47 does — no pyrotechnics on the deck
		const dev_parked=DEV_MODE && on_ground() && (ownship.speed??0)<1;   // J/L/O are nudge keys in this state
		if(ch===key_of("eject") && !dev_parked && crash_t<=0 && !ejected){   // ejection handle: one deliberate Shift+E chord — the zero-zero seat works everywhere. Moved off plain J (a pilot reaching for "jettison" must never punch out) and off a tap count (untypeable in the Keys tab)
			ejected=true; audio_eject();
			if(MULTIPLAYER) eject_flag=true;   // the server scores the eject and wrecks the jet
			crash_ownship(); }   // the red centre banner announces it — no notice-line duplicate
		if(TEST_SCENARIOS && e.shiftKey && /^Digit\d$/.test(k)){ start_test((+k.slice(5)+9)%10); }   // Shift+1..0: scripted landing test scenarios (dev-only)
		if(TEST_SCENARIOS && e.shiftKey && k==="KeyY"){ stab_cycle=(stab_cycle+1)%8; notice("STAB ANGLE "+stab_cycle); }   // Shift+Y (dev): stab orientation cycle, +90° per press — the user reports the correct number
		if(TEST_SCENARIOS && e.shiftKey && k==="KeyA"){ const rig=ownship.group.userData.rig||[];   // Shift+A (dev): rig calibration — cycle subsystems, sweeping the active one 0..1
			rig_sweep = rig_sweep+1 > rig.length ? 0 : rig_sweep+1;
			notice(rig_sweep ? "RIG SWEEP: "+rig[rig_sweep-1].name : "RIG SWEEP OFF"); }
		if(TEST_SCENARIOS && e.shiftKey && k==="KeyX"){ const u=cloud_mat.uniforms.uDebug; u.value=u.value>0.5?0:1; }   // Shift+X (dev, moved off Shift+C for the canopy): keep the cloud render path but zero the cloud contribution — the definitive plumbing-vs-cloud-light A/B
		else if(!e.shiftKey){ if(k==="Digit1") set_view("cockpit");   // 1 Cockpit — plain digits ONLY: the else fell through for every Shift+Digit, so starting scenario 1 (Shift+1) ALSO flipped the view to cockpit on every landing test (#72)
			if(k==="Digit2"){ if(cfg.view==="hud"){ declutter=(declutter+1)%3; notice(translate(["HUD NORM","HUD REJ 1","HUD REJ 2"][declutter])); } else set_view("hud"); }   // 2 HUD; re-press cycles the reject switch NORM -> REJ 1 -> REJ 2 (the cycle lives HERE, not in set_view — mission start resets the view through set_view("hud") and must never bump the declutter)
			if(k==="Digit3") set_view("ddi");        // 3 DDI — one display full screen; re-press cycles left/right/AMPCD
			if(k==="Digit4") set_view("chase");      // 4 Chase
			if(k==="Digit5") set_view("flypast");    // 5 Flypast
			if(k==="Digit6") set_view("padlock"); }  // 6 Padlock — head-forward views on 1-3, external on 4-6
		if(ch===key_of("view")) set_view(cfg.view==="cockpit"?"hud":"cockpit");   // Cockpit↔HUD fast-swap (any other view → Cockpit); unbound by default since the number row selects views
		if(ch===key_of("repeater")&&cfg.view==="hud"){ repeat=repeat===""?"left":repeat==="left"?"right":repeat==="right"?"center":""; ddi_dirty=true; }   // I: corner DDI repeater panel — off -> left DDI -> right DDI -> AMPCD -> off (#12); HUD view only, game furniture by policy
		if(ch===key_of("view.reset")) view_reset();   // 0: put THIS view back to its defaults — zoom, head, and the chase orbit
		if(ch===key_of("zoom.in")&&(map_on||cfg.view!=="chase")) zoom_step(1);     // =/− zoom every view optically; chase keeps them for the orbit distance, its wheel already zooms. Edge-triggered here, and HELD keys sweep continuously from read_input below
		if(ch===key_of("zoom.out")&&(map_on||cfg.view!=="chase")) zoom_step(-1);
		if(ch===key_of("map")){ map_on=!map_on; map_el.style.display=map_on?"block":"none"; if(map_on){ map_px=0; map_pz=0; map_resize(); } }   // reopening always returns centred on own aircraft
		if(ch===key_of("chat") && MULTIPLAYER && running && onChat){ e.preventDefault(); onChat(chat_scope()); }   // T: the fast path to match chat (#84); MP only — bots do not read
		if(ch===key_of("shout") && MULTIPLAYER && running && onChat){ e.preventDefault(); onChat("all"); }   // Shift+T: everyone, when team chat is the default
		if(ch===key_of("hook")){ ownship.hookTarget = ownship.hookTarget>0.5?0:1; }   // arrestor hook deploy/stow
		if(ch===key_of("lights") && !dev_parked){ ownship.lights=!ownship.lights; }   // aircraft position/strobe/landing lights

		if(ch===key_of("brake.speed")){ ownship.speedbrakeTarget = ownship.speedbrakeTarget>0.5?0:1; }   // / : speed brake (air brake) toggle
		if(ch===key_of("flaps.extend")&&flap_select<2){ flap_select++; notice(translate(["FLAPS AUTO","FLAPS HALF","FLAPS FULL"][flap_select])); }   // F: one notch toward FULL, no wrap — a cycle's worst moment was FULL wrapping to AUTO on short final
		if(ch===key_of("flaps.retract")&&flap_select>0){ flap_select--; notice(translate(["FLAPS AUTO","FLAPS HALF","FLAPS FULL"][flap_select])); }   // Shift+F: one notch toward AUTO (the switch legends read verbatim English, like the annunciators)
		if(ch===key_of("brake.parking")){ parking=!parking; notice(translate(parking?"PARK BRAKE":"PARK BRAKE OFF")); }   // Shift+B: strictly manual, like the real handle
		if(ch===key_of("trim.reset")){ reset_flag=true; }   // unbound by default: zero both trim datums, re-datum the hold
		if(ch===key_of("gear") && !on_ground()){ ownship.gearTarget = ownship.gearTarget>0.5?0:1; audio_servo(); }   // G: landing gear up/down — only once airborne, never on deck/runway
		if(ch===key_of("caution.reset")) caution_lamp=false;   // the pressed-out MASTER CAUTION (NATOPS 2.17.2.1); the next NEW caution re-lights it
		if(ch===key_of("dump")){ fuel_dump=!fuel_dump; notice("FUEL DUMP "+(fuel_dump?"ON":"OFF")); }   // #54: NATOPS 2.2.7 — the drain and its bingo floor live in the core; annunciator vocabulary stays English
		if(ch===key_of("secure.port")){ secured[0]=!secured[0]; notice(secured[0]?"L ENG SECURED":"L ENG RELIGHT"); }   // #54: per-engine fuel OFF (NATOPS 15.1) — securing a burning engine starves its fire while the other keeps fighting
		if(ch===key_of("secure.starboard")){ secured[1]=!secured[1]; notice(secured[1]?"R ENG SECURED":"R ENG RELIGHT"); }
		if(ch===key_of("jettison.tanks") && !dev_parked){   // J: punch the tanks — selective STORES drop, gear-up interlock as the real panel (#18). A refused press SAYS so — a silent no-op reads as broken
			if(on_ground()||(ownship.gearTarget??1)<0.5) notice(translate("JETTISON: GEAR"));   // gearTarget: 0=down 1=up (make_state) — refuse on deck or gear down
			else if(!jettison_stations([3,5,7],"stores")) notice(translate("NO TANKS")); }
		if(ch===key_of("atc")){ if(atc_on) atc_on=false; else if(ownship.gearTarget<0.5 && !on_ground()){ atc_on=true; atc_alpha=ownship.aoa;   // gearTarget 0=down 1=up — the polarity was inverted here, so ATC only ever engaged CLEAN and refused on every real approach
			if(pad_levers.throttle){ pad_levers.throttle.armed=false; pad_levers.throttle.rest=undefined; } } }   // P: Approach Power Compensator (#202) — engages only in the landing configuration (gear down, airborne); toggling off is always allowed. Engaging takes the throttle back from an armed physical lever (same as the keyboard keys at the throttling take-back) — a lever is armed from mission start, so without this ATC disengaged the same frame it engaged; the next DELIBERATE lever sweep re-arms and disengages, the real jet's throttle-grip force-override
		if(ch===key_of("menu") && running){ if(onMenu) onMenu(); else exit_match(); } }   // Esc: the in-game menu popup (#84); the popup exits via exit_match, and a host without a popup falls back to the old immediate exit
	keys.add(k); if(e.shiftKey) keys.add("Shift+"+k); }, { signal });   // chords live in the held set too: trim's Shift pairs are HELD actions, not edges
addEventListener("keyup",e=>{ keys.delete(e.code); keys.delete("Shift+"+e.code);
	if(e.code==="ShiftLeft"||e.code==="ShiftRight") for(const held of [...keys]) if(held.startsWith("Shift+")) keys.delete(held); },{ signal });
addEventListener("blur",()=>keys.clear(),{ signal });
addEventListener("pagehide",()=>{ if(MULTIPLAYER) net_finish("left"); },{ signal });   // closing/navigating the tab sends a clean leave — otherwise the QUIC connection lingers as a ghost player (the browser ACKs snapshots even with the page dead)

// ---- mouse look / orbit (keys.md §5): left-drag orbits the chase camera, sharing
// cam_az/cam_el with the keyboard orbit and holding on release (no spring-back). Left
// button only (fire stays Space); never in HUD. Pointer capture — not pointer lock, which
// the sandboxed shell iframe can block. Zoom stays on -/= (not the wheel), so no wheel handler.
let dragging=false, drag_x=0, drag_y=0, press_moved=0;
stage.addEventListener("pointerdown",e=>{ if(cfg.view==="ddi"){ if(e.button===0&&running&&!map_on) ddi_view_click(e); e.preventDefault(); return; }   // full-screen bezel presses, immediate on the down edge (no drag semantics head-down)
	if(e.button!==0 || (cfg.view!=="chase"&&cfg.view!=="cockpit")) return;
	dragging=true; head_drag=(cfg.view==="cockpit"); drag_x=e.clientX; drag_y=e.clientY; press_moved=0; try{ stage.setPointerCapture(e.pointerId); }catch(_){ /* pointer capture optional */ } e.preventDefault(); }, { signal });
stage.addEventListener("pointermove",e=>{ if(!dragging) return;
	const dx=e.clientX-drag_x, dy=e.clientY-drag_y; drag_x=e.clientX; drag_y=e.clientY; press_moved+=Math.abs(dx)+Math.abs(dy);
	const f=0.005;   // radians per pixel (the sensitivity slider is gone: one constant fits, and the setting only ever scaled THIS — players kept reading it as a flight-control gain)
	if(head_drag){ head_az=THREE.MathUtils.clamp(head_az-dx*f,-2.618,2.618); head_el=THREE.MathUtils.clamp(head_el+dy*f,-1.047,1.396); return; }   // cockpit head look (#99): ±150° az, −60/+80° el; snap-back runs on release
	cam_az-=dx*f; cam_el=THREE.MathUtils.clamp(cam_el+dy*f,-1.2,1.45); }, { signal });   // both axes reversed (grab-the-world feel): drag right = orbit left, drag up = camera lowers
function end_drag(e){ if(!dragging) return; dragging=false; head_drag=false; try{ stage.releasePointerCapture(e.pointerId); }catch(_){ /* release optional */ } }
stage.addEventListener("pointerup",e=>{ const pressed=dragging&&head_drag&&press_moved<6; end_drag(e); if(pressed) pit_click(e); },{ signal });
// A stationary press-release in the pit is a pushbutton CLICK, not a head look
// (movement past a few px stays a drag, with its snap-back): raycast the
// pointer through the near camera at the DDI quads and press the bezel
// button under the hit.
const _click_ray=new THREE.Raycaster(); _click_ray.layers.enable(LAYER_OWN);
const _click_at=new THREE.Vector2();
function pit_click(e){
	if(map_on||!running) return;
	const list=ownship.group.userData.screens; if(!list) return;
	_click_ray.setFromCamera(_click_at.set((e.clientX/HW)*2-1,-(e.clientY/HH)*2+1),cockpit_cam);
	const hit=_click_ray.intersectObjects(list.map(sc=>sc.mesh),false)[0];
	if(!hit||!hit.uv){
		if(PANEL_POINT){ const h=_click_ray.intersectObject(ownship.group,true).find(k=>!k.object.userData.overlay);   // measuring click: report where on the panel the pilot pointed
			if(h){ const p=ownship.group.worldToLocal(h.point.clone());
				dev_probe_text="panel y="+p.y.toFixed(3)+" z="+p.z.toFixed(3)+" x="+p.x.toFixed(3)+" ("+(h.object.name||"?")+")";
				try{ navigator.clipboard.writeText(dev_probe_text); }catch(_){ /* clipboard optional */ } } }   // the WHOLE line — the node name and depth matter as much as y,z
		return; }
	const sc=list.find(s=>s.mesh===hit.object);
	if(ddi_press(sc.display,button_of(hit.uv.x*512,(1-hit.uv.y)*512))) screens_update(); }   // dirty redraw NOW — a press must answer this frame
// zoom_step: one discrete notch of zoom (trim-wheel button pulse or scroll notch).
function zoom_step(direction){
	if(map_on){ map_range=THREE.MathUtils.clamp(map_range*Math.pow(1.2,-direction),MAP_RANGE_MIN,MAP_RANGE_MAX); return; }
	if(cfg.view==="ddi"){ ddi_range(direction); return; }   // no optical zoom on a flat panel — the notch goes to the focused page's range scale
	if(running){ zoom_target=THREE.MathUtils.clamp(zoom_target*Math.pow(1.18,direction),zoom_floor(),4); zoom_persist(); } }   // fine per-tap steps (~12 taps floor to ceiling) — a HELD key sweeps continuously for big moves, so taps can afford precision
// view_reset returns the CURRENT view to how it starts: zoom back to 1x, the
// head back to boresight, and the chase orbit back to its shoulder. Per-view,
// not global — resetting the cockpit should not disturb a chase framing the
// player set up earlier, and the zoom is persisted per view anyway (#209).
function view_reset(){ padlock_snap=false;
	if(map_on){ map_range=MAP_RANGE_DEFAULT; return; }
	if(cfg.view==="ddi"){ const p=DDI_PAGES[ddi_state[ddi_focus()].page];
		if(p&&p.reset){ p.reset(); ddi_dirty=true; ddi_view_last=0; } return; }   // 0 head-down: the focused page's transients back to defaults
	zoom_target=THREE.MathUtils.clamp(1,zoom_floor(),4); zoom_persist();
	// #57 parked: if(head_track&&head_pose){ head_datum={ yaw:head_pose.raw.yaw, pitch:head_pose.raw.pitch }; head_yaw.reset(); head_pitch.reset(); }   // #57: capture the physical pose as the new neutral FIRST — zeroing alone would snap the view straight back off
	head_az=0; head_el=0;
	if(cfg.view==="chase"){ cam_az=0; cam_el=0.22; cam_dist=24; }
}
// ddi_range: wheel and −/= notches head-down go to the focused page's range
// scale when it declares one; pages without a range concept stay inert.
let ddi_wheel=0, ddi_stepped=0;   // wheel accumulator + last-step beat: discrete steps from a continuous device
function ddi_range(direction){ if(!running) return;
	const p=DDI_PAGES[ddi_state[ddi_focus()].page];
	if(p&&p.range){ p.range(direction); ddi_dirty=true; ddi_view_last=0; } }
// scan_zoom: the trim-wheel notch buttons, edge-detected. Called from read_input
// in flight AND from frame() while the map is up — the SP map pauses the world,
// so read_input stops and the wheel went dead over the map without this.
function scan_zoom(pad,bind){
	for(const [action,list] of Object.entries(bind.buttons)){ if(action!=="zoom.in"&&action!=="zoom.out") continue;
		for(const index of String(list).split(",")){ const b=+index;
			if(!(b>=0)||b>=pad.buttons.length) continue;
			const down=pad.buttons[b].pressed, was=pad_buttons[action+"/"+b]||false;
			if(down!==was){ pad_buttons[action+"/"+b]=down; if(down) zoom_step(action==="zoom.in"?1:-1); } } } }
stage.addEventListener("wheel",e=>{ e.preventDefault();   // scroll = zoom (any mouse wheel; the VelocityOne trim wheel in DIGITAL mode arrives as button pulses instead — see zoom.in/zoom.out)
	if(!running||game_paused) return;
	const notch=-e.deltaY/(e.deltaMode===1?3:100);   // deltaMode 1 = lines (Firefox), else pixels; scroll up = zoom in
	if(map_on){ map_range=THREE.MathUtils.clamp(map_range*Math.pow(1.30,-notch),MAP_RANGE_MIN,MAP_RANGE_MAX); return; }
	if(cfg.view==="ddi"){ const now=performance.now();   // wheel-up = range in on the focused page, the map's wheel semantics. A range change is a DISCRETE step, and trackpads / smooth wheels deliver a gesture as dozens of small events plus a momentum tail — accumulate to a full notch, one step per beat, and SWALLOW the tail inside the beat, or a single swipe races through every scale
		if(now-ddi_stepped<250){ ddi_wheel=0; return; }
		ddi_wheel+=notch;
		if(Math.abs(ddi_wheel)>=1){ ddi_range(Math.sign(ddi_wheel)); ddi_wheel=0; ddi_stepped=now; }
		return; }
	zoom_target=THREE.MathUtils.clamp(zoom_target*Math.pow(1.5,notch),zoom_floor(),4); zoom_persist();
},{ signal, passive:false });
stage.addEventListener("pointercancel",end_drag,{ signal });
// Remappable input actions (#74): defaults here, user overrides in cfg.keys
// (the menu's Keys tab). Joystick buttons bind to ACTIONS and replay the
// action's current key as a synthetic event, so pad binds follow key remaps.
const KEYS={ "pitch.up":"KeyS", "pitch.down":"KeyW", "roll.right":"KeyD", "roll.left":"KeyA", "yaw.right":"KeyE", "yaw.left":"KeyQ",
	"throttle.up":"BracketRight", "throttle.down":"BracketLeft", guns:"Space", launch:"Enter", "brake.wheel":"KeyB", "brake.speed":"Slash", "trim.up":"Period", "trim.down":"Comma", "trim.left":"Shift+Comma", "trim.right":"Shift+Period", "trim.reset":"None", "flaps.extend":"KeyF", "flaps.retract":"Shift+KeyF", override:"KeyO", "brake.parking":"Shift+KeyB",
	gear:"KeyG", hook:"KeyH", probe:"KeyR", atc:"KeyP", lights:"KeyL", flares:"KeyC", eject:"Shift+KeyE", map:"KeyM", chat:"KeyT", shout:"Shift+KeyT", menu:"Escape", view:"None", select:"KeyX", altitude:"KeyK", reject:"None", acquire:"Enter",
	canopy:"Shift+KeyC", fold:"Shift+KeyW", "zoom.in":"Equal", "zoom.out":"Minus", "view.reset":"Digit0", repeater:"KeyI", padlock:"KeyY",
	"jettison.tanks":"KeyJ", "jettison.emergency":"Shift+KeyJ", "caution.reset":"Shift+KeyM", dump:"Shift+KeyD", "secure.port":"Shift+KeyZ", "secure.starboard":"Shift+KeyX" };   // the cutoffs are chords like the jettison family — securing an engine must be deliberate (Shift+Digit collided with the dev scenario starts)   // chord actions: "Shift+<code>" — matched against the full chord, so Shift+F never also fires flares. J is the jettison family; eject moved to triple-Escape (a pilot reaching for "jettison" must never punch out)
function key_of(action){ return (cfg.keys&&cfg.keys[action])||KEYS[action]; }
let gamepad_seen=false;
const key_axes={ pitch:0, roll:0, yaw:0 };
const pad_buttons={};   // edge state per ACTION+BUTTON, not per button: the default binds share button 17 between guns and the wheel brake, and a per-button edge let whichever action processed first consume the press and starve the other (the joystick trigger fired a missile only when guns happened to win)
const pad_levers={};   // per-purpose lever state: armed on the first deliberate sweep
function throttle_from_lever(){   // mission start: seed the throttle from the physical lever when one is bound, and arm it so it tracks from the first frame
	const pad=read_gamepad(); if(!pad) return;
	const text=String(pad_bindings(pad).axes.throttle??""); if(text==="") return;
	const index=Math.abs(+text); if(!(pad.axes.length>index)) return;
	const value=(text.startsWith("-")?-1:1)*pad.axes[index];
	const lever=pad_levers.throttle||(pad_levers.throttle={ rest:undefined, armed:false });
	lever.armed=true; lever.rest=value;
	const power=1-THREE.MathUtils.clamp((value+1)/2,0,1);
	ownship.throttle=Math.min(1,power/0.75); ownship.burner=THREE.MathUtils.clamp((power-0.75)/0.25,0,1); }
function pad_lever(pad,entry,name){   // "N"/"-N" axis entry -> travel fraction 0..1 (0 = the raw LOW end after the reverse negation), or null when unbound/untouched
	const text=String(entry??""); if(text==="") return null;
	const index=Math.abs(+text); if(!(pad.axes.length>index)) return null;
	const value=(text.startsWith("-")?-1:1)*pad.axes[index];
	const lever=pad_levers[name]||(pad_levers[name]={ rest:undefined, armed:false });
	if(!lever.armed){ if(lever.rest===undefined) lever.rest=value;
		if(Math.abs(value-lever.rest)<=0.15) return null;   // keyboard stays in charge until a DELIBERATE sweep — in-flight jitter once armed the brake and snapped it to the parked lever position
		lever.armed=true; }
	return THREE.MathUtils.clamp((value+1)/2,0,1); }   // the plain ±1 HID range, 1:1 across the travel (the VelocityOne reads clean ±1.00 at its stops; end margins just made dead zones). NEVER normalise by the observed sweep: treating the advancing edge as an end stop commanded full afterburner at half throttle travel

function read_gamepad(){ const pads=(navigator.getGamepads&&navigator.getGamepads())||[];   // #74: the menu-selected stick when present, else the first connected; browsers expose pads only after a button press
	let first=null;
	for(const p of pads){ if(!p||!p.connected||p.axes.length<2) continue;
		if(cfg.joystick&&p.id===cfg.joystick) return p;
		if(!first) first=p; }
	return first; }
function pad_bindings(pad){   // resolved axis/button map for THIS stick: the menu's per-device config over the SHARED built-in defaults (lib/config deviceDefaults — one source for the engine and the menu, so Reset always shows what the engine flies)
	const saved=(cfg.sticks||{})[pad.id]||{};
	const defaults=deviceDefaults(pad.id||"");
	return { axes:{ ...defaults.axes, ...(saved.axes||{}) },
		buttons: saved.buttons&&Object.keys(saved.buttons).length?saved.buttons:defaults.buttons }; }
const pad_looks={ up:false, down:false, left:false, right:false };
const pad_trim={ x:0, y:0 };   // the trim hat pair's level state (x + = right wing down, y + = hat aft = nose up after the sign flip at the read)   // castle/hat state, level-read per frame — deliberately NOT synthetic Arrow events (shared codes let a castle release kill a held physical arrow)
let pad_guns=false;   // guns level state, same reasoning: a HELD action with possibly several bound buttons must never be synthetic key events
function pad_axis(pad,i){ const v=pad.axes[i]??0;   // raw ±1, no calibration: the worn-pot centring/throw machinery is gone by decree — modern sticks read clean, and every margin only made dead travel
	const dz=Math.abs(v)<0.05?0:(v-Math.sign(v)*0.05)/0.95;   // small centre deadzone against electrical jitter
	return Math.sign(dz)*Math.pow(Math.abs(dz),1.25);   // gentle expo: fine control near centre, full authority at the stops
}
let flap_select=0;   // the flap switch: 0 AUTO (the FCS virtual schedule), 1 HALF, 2 FULL — notched by the flaps keys, sent with every control sample
let parking=false;   // the parking brake: forces the wheel-brake input while set, so the idle-thrust creep needs no held key
let reset_flag=false;   // one-shot trim reset, consumed once the core has stepped with it
function read_input(dt){
	let tp=0,tr=0,ty=0;   // target axis deflections from the held keys (flight is W/S/A/D/Q/E only — arrows look/orbit, keys.md §2/§5)
	if(keys.has(key_of("pitch.up"))) tp+=1;   // pull / nose up
	if(keys.has(key_of("pitch.down"))) tp-=1;   // nose down
	if(keys.has(key_of("roll.right"))) tr+=1;
	if(keys.has(key_of("roll.left"))) tr-=1;
	if(keys.has(key_of("yaw.right"))) ty+=1; if(keys.has(key_of("yaw.left"))) ty-=1;   // rudder / yaw
	tp=THREE.MathUtils.clamp(tp,-1,1)*(cfg.invert?-1:1); tr=THREE.MathUtils.clamp(tr,-1,1); ty=THREE.MathUtils.clamp(ty,-1,1);
	// Asymmetric ramp: SLOW attack (2/s — a short tap gives a small deflection
	// instead of a 40%-stick g-spike the FCS then chases into oscillation),
	// FAST recentre (6/s) so releasing a key stops the command promptly.
	// Hold ~0.5 s for full deflection.
	const shape=(current,target)=>{ const toward=Math.abs(target)>Math.abs(current)&&target*current>=0;
		const R=(toward?2.0:6.0)*dt; return current+THREE.MathUtils.clamp(target-current,-R,R); };
	// Keyboard pitch is a G-COMMAND (#242). The core's UA law already maps
	// stick deflection to a load-factor demand (the bot's compose exploits the
	// same linearity), so shaping the STICK trajectory IS shaping the g
	// trajectory — no second feedback loop wrapped around the FCS to fight it.
	// The attack ramp above makes a held key a smooth g ramp and a tap a small
	// g increment; what it could never fix was RELEASE: letting go at a hard
	// pull recentred the stick in ~170 ms, a step no arm would command, and
	// the airframe answered with the pitch bobble the pilot then pumped W/S
	// against ("extreme oscillations when releasing the s key"). Released
	// pitch now UNLOADS: an exponential decay (tau ~0.33 s, floored so the
	// tail does not linger) that walks the g back to level the way a pilot
	// eases a pull. Only when BOTH keys are up — an actively held opposite
	// key keeps the fast rate, so push-after-pull stays crisp. Roll and yaw
	// keep the fast recentre: stopping a roll promptly is what you want.
	if(tp===0&&key_axes.pitch!==0){ const R=Math.max(1.2,Math.abs(key_axes.pitch)*3.0)*dt;
		key_axes.pitch=key_axes.pitch-THREE.MathUtils.clamp(key_axes.pitch,-R,R); }
	else key_axes.pitch=shape(key_axes.pitch,tp);   // keyboard stays live alongside the stick — larger magnitude wins per axis
	key_axes.roll=shape(key_axes.roll,tr);
	key_axes.yaw=shape(key_axes.yaw,ty);
	let pp=0, pr=0, py=0;
	const pad=read_gamepad();
	if(pad){ if(!gamepad_seen){ gamepad_seen=true;
			if(!(pad_levers.throttle&&pad_levers.throttle.armed)) throttle_from_lever(); }   // browsers hide pads until a button press ON THE PAD — when the stick finally appears (often after the mission spawned), the lever still wins over the spawn default
		const bind=pad_bindings(pad);
		const ax=name=>{ const i=bind.axes[name]; return (i===""||i===undefined)?0:pad_axis(pad,+i); };
		pp=ax("pitch")*(cfg.invert?-1:1);   // stick back = pull; analog goes straight to the FCS — no key shaping
		pr=ax("roll");
		py=ax("yaw");
		{ const p=(test_active||sim_time<test_idle)?null:pad_lever(pad,bind.axes.throttle,"throttle");   // throttle: power grows from the HIGH raw end (idle at high; "-" prefix flips). The lever yields during a scripted scenario and its rollout grace — a parked lever re-powering the touchdown floated every test landing (#72)
			if(p!==null){ const lever=1-p;
				ownship.throttle=Math.min(1,lever/0.75); ownship.burner=THREE.MathUtils.clamp((lever-0.75)/0.25,0,1); } }   // lever: 0..75% = idle..MIL, the top quarter sweeps the five AB zones
		{ const p=pad_lever(pad,bind.axes.speedbrake,"speedbrake");   // speed brake: full forward retracted, aft deployed (deployed at the HIGH raw end; "-" prefix flips)
			if(p!==null) ownship.speedbrakeTarget=p; }
		pad_looks.up=pad_looks.down=pad_looks.left=pad_looks.right=false; pad_guns=false; pad_trim.x=pad_trim.y=0;
		{ const z=String(bind.axes.zoom??""); zoom_wheel=0;
			if(z.endsWith("+")){ const zi=Math.abs(parseInt(z,10));   // "N+": half-axis PAIR wheel — each roll direction sweeps its own axis 0..-1 (thumbwheel style)
				if(pad.axes.length>zi+1){ const back=Math.max(0,-pad.axes[zi]), fore=Math.max(0,-pad.axes[zi+1]);
					const v=(z.startsWith("-")?-1:1)*(fore-back);
					zoom_wheel=Math.abs(v)>0.08?v:0; } }
			else if(z!==""){ const zi=Math.abs(+z); if(pad.axes.length>zi){ const v=(z.startsWith("-")?-1:1)*pad.axes[zi];
				zoom_wheel=Math.abs(v)>0.02?v:0; } } }   // plain "N": a rate axis — the VelocityOne's infinite clicky wheel reports rolling SPEED that decays to zero, so single notches are brief small blips: tiny deadband, gain lives at the apply site
		{ const h=String(bind.axes.trim??""); if(h!==""){ const hi=+h;   // the trim hat pair, thresholded like the look pair — a POV that reports as two axes
			if(pad.axes.length>hi+1){ const hx=pad.axes[hi], hy=pad.axes[hi+1];
				pad_trim.x=Math.abs(hx)>0.5?Math.sign(hx):0; pad_trim.y=Math.abs(hy)>0.5?Math.sign(hy):0; } } }
		{ const h=String(bind.axes.look??""); if(h!==""){ const hi=+h;   // the Look pair (HID: x -1 left +1 right, y -1 up +1 down; the 0.5 threshold covers analog ministicks and digital hats alike)
			if(pad.axes.length>hi+1){ const hx=pad.axes[hi], hy=pad.axes[hi+1];
				if(hx<-0.5) pad_looks.left=true; if(hx>0.5) pad_looks.right=true;
				if(hy<-0.5) pad_looks.up=true; if(hy>0.5) pad_looks.down=true; } } }
		for(const [action,list] of Object.entries(bind.buttons)) for(const index of String(list).split(",")){ const b=+index;   // a binding may list several buttons
			if(!(b>=0)||b>=pad.buttons.length) continue;
			const down=pad.buttons[b].pressed;
			if(action.startsWith("look.")){ if(down) pad_looks[action.slice(5)]=true; continue; }   // look directions are level state for the camera, not key events
			if(action==="guns"){   // held fire stays a LEVEL read (any bound button, immune to another button's release); the PRESS edge calls the 9M launch DIRECTLY — no synthetic key event, which wedged Space into the held-keys set and froze the edge for keyboard and trigger alike
				if(down){ pad_guns=true;
					if(!pad_buttons["guns/"+b]){ pad_buttons["guns/"+b]=true; trigger_missile(); } }
				else pad_buttons["guns/"+b]=false;
				continue; }
			if(action==="zoom.in"||action==="zoom.out") continue;   // notch zoom is scanned by scan_zoom (also polled while the map pauses the world)
			const was=pad_buttons[action+"/"+b]||false;   // other actions replay their CURRENT key: synthetic keydown on press, keyup on release, so held actions (brakes) work and pad binds follow key remaps
			if(down!==was){ pad_buttons[action+"/"+b]=down; const bindText=key_of(action);
				if(bindText){ const shift=bindText.startsWith("Shift+"), code=bindText.replace("Shift+","");
					for(const target of [window, document, stage]) target.dispatchEvent(new KeyboardEvent(down?"keydown":"keyup",{ code, shiftKey:shift, bubbles:true })); } } }
	}
	else { pad_looks.up=pad_looks.down=pad_looks.left=pad_looks.right=false; pad_guns=false; }
	input.pitch=Math.abs(pp)>Math.abs(key_axes.pitch)?pp:key_axes.pitch;
	input.roll=Math.abs(pr)>Math.abs(key_axes.roll)?pr:key_axes.roll;
	input.yaw=Math.abs(py)>Math.abs(key_axes.yaw)?py:key_axes.yaw;
	if(pad) scan_zoom(pad,pad_bindings(pad));
	input.guns=(keys.has(key_of("guns"))||pad_guns)&&master==="gun";   // the trigger serves the SELECTED weapon (#133): guns only in GUN
	const held=(action)=>{ const b=key_of(action); if(!b||b==="None") return false;
		if(!keys.has(b)) return false;
		return b.startsWith("Shift+")||!keys.has("Shift+"+b); };   // a live shift-chord owns its bare key: Shift+, is roll trim, not nose-down-with-Shift
	input.trim=(held("trim.up")?1:0)-(held("trim.down")?1:0);   // . / , held: the pitch trim switch (UA attitude datum, PA alpha datum)
	input.lean=(held("trim.right")?1:0)-(held("trim.left")?1:0);   // Shift+. / Shift+, held: the hat's roll half — a standing differential-flaperon bias
	if(pad_trim.x||pad_trim.y){ input.trim=input.trim||-pad_trim.y; input.lean=input.lean||pad_trim.x; }   // the trim HAT (an axis pair, e.g. the VelocityOne castle at 8/9): forward = nose DOWN, the aviation convention
	input.brake=keys.has(key_of("brake.wheel"))||parking;   // B: wheel brakes, held (both mains together); the joystick trigger's ground brake role comes from its brake.wheel BINDING, not hidden logic
	if(DEV_MODE && on_ground() && (ownship.speed??0)<1){   // dev measuring cursor: nudge the readout point off the nose wheel while parked (the eject/lights/override keys are gated off in this state)
		const step=dt*1.2, turn=dt*2.5;
		if(keys.has("KeyI")) dev_nudge.fa+=step; if(keys.has("KeyK")) dev_nudge.fa-=step;
		if(keys.has("KeyJ")) dev_nudge.lat-=step; if(keys.has("KeyL")) dev_nudge.lat+=step;
		if(keys.has("KeyU")) dev_nudge.hd+=turn; if(keys.has("KeyO")) dev_nudge.hd-=turn;
	}
	const throttling=keys.has(key_of("throttle.up"))||keys.has(key_of("throttle.down"));
	if(throttling&&pad_levers.throttle){ pad_levers.throttle.armed=false; pad_levers.throttle.rest=undefined; }   // the keyboard takes the throttle back from an armed physical lever (else the lever pins it every frame and e.g. the catapult unhook — throttle below 30% + full pedal — can never fire); the next deliberate lever sweep re-takes control
	if(keys.has(key_of("throttle.up"))){ if(ownship.throttle>=1) ownship.burner=Math.min(1,(ownship.burner??0)+dt*0.8); else ownship.throttle=Math.min(1,ownship.throttle+dt*0.5); }   // throttle up (], held & ramped); past MIL the lever advances through the afterburner range
	// Approach Power Compensator (#202): with ATC engaged the throttle holds
	// on-speed alpha and the pilot flies glideslope/lineup with the stick.
	// Auto-disengage on touchdown, gear retraction, or any manual throttle
	// input (keyboard keys or an armed physical lever) — the real jet's
	// force-override. Alpha in degrees from the flight core (ownship.aoa).
	if(atc_on){
		if(on_ground()||ownship.gearTarget>0.5||throttling||(pad_levers.throttle&&pad_levers.throttle.armed)) atc_on=false;   // gearTarget>0.5 = gear UP (retraction disengages)
		else { const rate=(ownship.aoa-atc_alpha)/Math.max(dt,1e-3); atc_alpha=ownship.aoa;
			ownship.throttle=atc_step(ownship.throttle,ownship.aoa,rate,dt); ownship.burner=0; }
	}
	if(keys.has(key_of("throttle.down"))){ if((ownship.burner??0)>0) ownship.burner=Math.max(0,ownship.burner-dt*0.8); else ownship.throttle=Math.max(0,ownship.throttle-dt*0.5); }    // throttle down ([): the burner comes off before the dry range
}

let sim_time=0;
// Flight recorder (#212): a rolling buffer saved from the History page. The
// bot's doctrine state rides along in developer builds only — free to capture
// (the brain runs in-process in wasm for a local joust) but it is the AI's
// hand, so a shipped replay does not show it.
const recorder=new Recorder();
let record_started=null, record_session="";
function recording_sample(){
	if(!running||!cfg.record||game_paused) return;
	const list=[];
	const degrees=(v)=>v*180/Math.PI;
	// Only the OWNSHIP carries a full basis; make_state gives the legacy bandit
	// fwd plus a scalar bank (reading .right.y there killed the frame loop, and
	// every earlier test happened to be free flight, so nothing exercised it).
	const attitude=(st)=>({
		yaw:(degrees(Math.atan2(st.fwd.x,-st.fwd.z))+360)%360,
		pitch:degrees(Math.asin(THREE.MathUtils.clamp(st.fwd.y,-1,1))),
		roll:(st.up&&st.right)?degrees(Math.atan2(st.right.y,st.up.y)):degrees(st.bank||0) });
	const add=(st,id,label,colour,mode,data)=>{ if(!st||!st.pos||!st.fwd) return;   // a half-built state must never take the frame loop down with it
		const a=attitude(st);
		list.push({ id, x:st.pos.x, y:st.pos.y, z:st.pos.z, roll:a.roll, pitch:a.pitch, yaw:a.yaw,
			name:"FA-18C", label, colour, kind:"Air+FixedWing", mode, data }); };
	// The ownship's flight data comes from the instrument tail the gauges read
	// (#216) — TacView graphs AOA/G/TAS/IAS/Mach natively, which is what turns a
	// replay into the handling trace the old CSV telemetry carried. The
	// control-law channels stay behind developer mode with the doctrine one.
	const out=last_out;
	// Fuel and rounds ride in the SHIPPED recording, not behind developer mode:
	// "what did that fight cost me" is a debrief question every pilot asks, and
	// without them the answer was unrecoverable once the mission ended. Fuel is
	// kg straight from the state (the gauge is what multiplies to pounds).
	const data=out?{ aoa:(out[STATE.alpha]||0)/D2R, g:out[STATE.nz]||0, tas:ownship.speed||0,
		ias:out[STATE.cas]||0, mach:out[STATE.mach]||0,
		fuel:out[STATE.fuel]||0, rounds:ownship.rounds??0,
		// battle channels (#238): what the fight did to ME, from the same
		// state the CAS alerts and damage visuals read
		struck:ownship.struck||0, burning:own_burning||Math.max(own_burn[0],own_burn[1])>0,
		thrust:((out[STATE.engine_harm]||0)+(out[STATE.engine_harm+1]||0))/2, leak:own_leak||0,
		...(ownship.fate?{fate:ownship.fate}:{}),
		...(DEV_MODE?{ stick:last_controls?last_controls.pitch:0, stabilator:(out[STATE.stabilator]||0)/D2R }:{}) }:undefined;
	add(ownship,1,cfg.callsign||"Player","Blue",undefined,data);
	if(!MULTIPLAYER&&bandit.group&&(has_enemy&&bandit.group.visible||(bandit.fated&&sim_time-bandit.fated<1)))   // the grace second writes the corpse's Fate: destruction hides the group before the next sample, and an unrecorded fate was how a debrief argued with the pilot about who killed whom
		add(bandit,2,"Bandit","Red",DEV_MODE&&bandit_brain?(bandit_mode()||undefined):undefined,
			{ rounds:bandit.rounds??0,   // the true belt (#233), same counter as the ownship's — no longer a nominal derived from expenditure
				struck:bandit.struck||0, burning:!!bandit.harm.burning, thrust:bandit.harm.thrust||0,
				wing:bandit.harm.wreck||0, ...(bandit.fate?{fate:bandit.fate}:{}) });   // the bandit's gun, on the same channel as mine: without it a debrief cannot tell a bandit that shot and missed from one that never fired (both look identical from the ownship)   // the wasm exports come through flight.ts, never as globals — reading globalThis here left the channel silently empty
	if(MULTIPLAYER&&net){ for(const [slot,st] of remotes.entries()){ if(!st.group||!st.group.visible) continue;
		const team=net.teams.get(slot)||"";
		add(st,10+slot,st.name||net.names.get(slot)||"",team==="red"?"Red":team==="blue"?"Blue":"Orange"); } }
	recorder.add(sim_time,list); }
// recording_file renders what is buffered; null when nothing was captured.
function recording_file(){
	if(!recorder.length||!record_started) return null;
	const kind=cfg.task==="joust"?("joust-"+(cfg.bandit||"ace")):"flight";
	return { text:recorder.render(record_started,"Mochi Air: "+kind), session:record_session, kind }; }
const _q=new THREE.Quaternion(), _fwd=new THREE.Vector3(), _up=new THREE.Vector3(), _right=new THREE.Vector3();
function start_launch(){ launch_flag=true; ownship.trapped=false; ownship.throttle=Math.max(ownship.throttle,0.9); }   // requests the shot; the core fires it while attached to the shuttle (caller gates on launch_status()===2)
let atc_on=false, atc_alpha=0;   // Approach Power Compensator (#202): engaged flag + last-frame alpha for the rate term
let crash_t=0;   // >0 = crashed; counts down through the fireball
let mission_done=false;   // SP: the crash ended the mission — the world holds and the menu owns what happens next (#240)
let mission_zero=0;       // sim_time at mission start, for the outcome line's clock
let on_over=null;         // app callback: the mission ended with a result
let hit_flash=0;   // red vignette pulse when rounds land on the ownship
const audio_prev={launching:false,trapped:false,grounded:false,cautions:0};   // one-shot edge detection (#73)
// ---- Master caution/warning model (#47): the caution SET is built in the
// sim step, keyed and view-independent — the tone, the glareshield lamp, and
// the HUD stack read this one source. It was a count published by draw_hud:
// dead in every view that returns before the stack (chase, map, and the
// head-down DDI view — the one mode where the ear is the only channel), and
// blind to escalation (L ENG catching fire kept the count at one). NATOPS
// 2.17.2.1: the tone fires when ANY caution comes ON (a new KEY), the light
// goes out when PRESSED, and later cautions re-arm it. Warnings (red tier)
// carry their own tone — explicitly not backed by the caution beep (2.17.3).
let caution_list=[];        // [key, label, red] rows, sim-step fresh — the renderers' source
let caution_keys=new Set(); // keys present last step (the new-key edge)
let caution_lamp=false;     // the glareshield MASTER CAUTION: latched by a new caution, cleared by the reset key, re-lit by the next new one
let bingo_nag=0;            // the 30 s BINGO repeat (NATOPS 2.2.10.4: the alert sounds every 30 s until acted on)
function cautions_update(){
	const rows=[]; const core=last_out;
	const push=(key,red)=>rows.push([key,translate(key),!!red]);
	if((ownship.fuel??1)<=0) push("FLAMEOUT",true);
	if(own_burning) push("FUEL FIRE",true);
	if(own_burn[0]>0) push("L ENG FIRE",true); else if(core&&core[STATE.engine_harm]>0.55) push("L ENG");
	if(own_burn[1]>0) push("R ENG FIRE",true); else if(core&&core[STATE.engine_harm+1]>0.55) push("R ENG");
	if((core&&core[STATE.leak]>0.1)||own_leak>0.1) push("FUEL LEAK");
	if(!cheat("fuel")){ const total=(ownship.fuel??0)+(ownship.external??0);
		if(ownship.fuel!==undefined&&ownship.fuel<FUELLO) push("FUEL LO");
		else if(total>0&&total<BINGO) push("BINGO"); }   // FUEL LO supersedes BINGO on the stack, as the deeper state
	{ const home=fpas_home(); if(home&&home.arrive<=2000) push("HOME FUEL"); }   // FPAS (#54, NATOPS 2.3.1.2): calculated fuel on arrival back at the boat has reached the 2,000 lb reserve
	if(core) for(let leg=0;leg<3;leg++){ const harm=core[STATE.gear_harm+leg]; if(harm>0.3) push(["NOSE GEAR","L GEAR","R GEAR"][leg],harm>0.7); }
	if(core){ let jammed=false; for(let c=0;c<8;c++) if(core[STATE.jam+c]>0.2) jammed=true; if(jammed) push("FCS");
		let torn=false; for(let e=0;e<40;e++) if(core[STATE.element+e]>0.6) torn=true;
		if(torn||core[STATE.stress]>2) push("STRUCTURE"); }
	caution_list=rows;
	let freshCaution=false, freshWarning=false;
	for(const [key,,red] of rows) if(!caution_keys.has(key)){ if(red) freshWarning=true; else freshCaution=true; }
	caution_keys=new Set(rows.map(r=>r[0]));
	if(freshWarning){ caution_lamp=true; audio_warning(); }
	else if(freshCaution){ caution_lamp=true; audio_caution(); }
	if(!rows.length) caution_lamp=false;   // a clean jet clears the latch (the reset key clears it earlier)
	const bingo=rows.some(r=>r[0]==="BINGO"||r[0]==="FUEL LO");
	if(bingo){ bingo_nag+=1/60; if(bingo_nag>=30){ bingo_nag=0; audio_caution(); } } else bingo_nag=0; }
let law_armed=true;   // radar-altimeter low-altitude warning: one aural per descent through the bug
let dev_pip=null;   // dev (#243/pipper): last drawn director geometry for headless assertions
let law_active=false;   // the warning is LIVE this frame: drives the repeating aural AND the flashing break-X on HUD/helmet (#243 — the user flew into the sea padlocked, gear up, in silence)
let last_out=null;   // the core's latest output words: the HUD caution panel reads damage straight from them
// burn_trail: flame + sooty smoke from a burning aircraft, rate by intensity.
// The gun-camera rules (#239): one CONNECTED clumped plume, darkest and
// warmest at the head — the flame interpenetrates the young smoke and tints
// it from within — paling and swelling as it ages down the ribbon. Clustered
// sub-puffs give the cauliflower texture a single row of blobs never had.
function burn_trail(pos,intensity,vx,_vy,vz){ if(intensity<=0.02) return;
	if(Math.random()<Math.min(1,intensity)){
		const cluster=1+(Math.random()<0.25+0.55*Math.min(1,intensity)?1:0);   // a small fire puffs singly; a torching jet emits dense clusters
		for(let c=0;c<cluster;c++){ const k=pool_spawn(smoke); if(k<0) break;
		smoke.px[k]=pos.x-((vx||0)*0.05)+(Math.random()-0.5)*2.4;smoke.py[k]=pos.y+(Math.random()-0.5)*1.6;smoke.pz[k]=pos.z-((vz||0)*0.05)+(Math.random()-0.5)*2.4;
		smoke.vx[k]=(Math.random()-0.5)*4;smoke.vy[k]=4+Math.random()*6;smoke.vz[k]=(Math.random()-0.5)*4;
		const flame=c===0&&Math.random()<0.3;
		if(flame){ smoke.ttl[k]=smoke.life[k]=0.5+Math.random()*0.3; smoke.sz[k]=0.26; smoke.gr[k]=0.5;   // the fire itself: brief, small, bright
			smoke.vy[k]=0.5+Math.random()*2;   // flame HUGS the path — the jet's own motion strings the tongues into the trail's burning head
			smoke.r[k]=2.2;smoke.g[k]=0.9;smoke.b[k]=0.25; }
		else { smoke.ttl[k]=smoke.life[k]=3.2+Math.random()*2.2; smoke.sz[k]=0.30+Math.random()*0.15; smoke.gr[k]=0.75;   // soot: long-lived, strong growth — the expanding ribbon
			smoke.vy[k]=2+Math.random()*3;
			const warm=Math.min(1,intensity);   // fire-lit at birth, near-black when the fire is small; the flush ramp pales it with age. Mid-grey floor: true 0.10 soot disappeared against the sea
			smoke.r[k]=0.16+0.26*warm;smoke.g[k]=0.15+0.10*warm;smoke.b[k]=0.15; } } } }
// engine_smoke: dark machinery smoke from a damaged engine (#244) — unburned
// oil and fuel through a wrecked compressor, cooler and flatter than fire soot
// (no warm tint, no flame), thin at the nozzle and thickening with the damage.
function engine_smoke(pos,fraction,vx,_vy,vz){ if(Math.random()>Math.min(1,fraction*0.8)) return; const k=pool_spawn(smoke); if(k<0) return;
	smoke.px[k]=pos.x-((vx||0)*0.04);smoke.py[k]=pos.y-0.3;smoke.pz[k]=pos.z-((vz||0)*0.04);
	smoke.vx[k]=(Math.random()-0.5)*3;smoke.vy[k]=1+Math.random()*2;smoke.vz[k]=(Math.random()-0.5)*3;
	smoke.ttl[k]=smoke.life[k]=2.0+Math.random()*1.4; smoke.sz[k]=0.18+0.10*Math.min(1,fraction); smoke.gr[k]=0.55;
	smoke.r[k]=0.24;smoke.g[k]=0.24;smoke.b[k]=0.25; }
// leak_trail: white fuel mist behind a holed tank.
function leak_trail(pos,rate,vx,_vy,vz){ if(Math.random()>Math.min(1,rate)) return; const k=pool_spawn(smoke); if(k<0) return;
	smoke.px[k]=pos.x-((vx||0)*0.06);smoke.py[k]=pos.y-0.4;smoke.pz[k]=pos.z-((vz||0)*0.06);
	smoke.vx[k]=(Math.random()-0.5)*3;smoke.vy[k]=(Math.random()-0.5)*3;smoke.vz[k]=(Math.random()-0.5)*3;
	smoke.ttl[k]=smoke.life[k]=1.4+Math.random()*0.8; smoke.sz[k]=0.26+Math.random()*0.10; smoke.gr[k]=0.55;   // fuel vapour: pale, fast-swelling, quick to thin (#239)
	smoke.r[k]=0.95;smoke.g[k]=0.96;smoke.b[k]=0.98; }
let hud_pa=false;   // the virtual flap switch's HUD mirror (see the landing-symbology gate)
// hit_sparks: the flash where a round strikes an airframe (#217). Real cannon
// strikes are a brief white-hot flash with sparks thrown along the round's
// path, gone in well under a tenth of a second — so these are short-lived,
// additive, and slightly random in size, and a burst walking across the target
// leaves the line of flashes the pilot actually sees.
let _spark_count=0;   // dev: how many strike flashes have been spawned
const impact_marks=[];
function impact_mark_texture(){ const c=document.createElement("canvas"); c.width=c.height=64; const x=c.getContext("2d"); const g=x.createRadialGradient(32,32,2,32,32,30);
	g.addColorStop(0,"rgba(8,8,7,.95)"); g.addColorStop(.28,"rgba(35,25,16,.9)"); g.addColorStop(.62,"rgba(70,48,26,.35)"); g.addColorStop(1,"rgba(0,0,0,0)"); x.fillStyle=g; x.fillRect(0,0,64,64); return new THREE.CanvasTexture(c); }
const impact_mark_mat=new THREE.MeshBasicMaterial({map:impact_mark_texture(),transparent:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2,side:THREE.DoubleSide,toneMapped:false});
const impact_mark_geo=new THREE.PlaneGeometry(1,1); const _mark_z=new THREE.Vector3(0,0,1); const _v2=new THREE.Vector3();   // _v2: the mark-normal scratch — its definition was lost in an interleaved commit, and the first gun hit after that threw ReferenceError and killed the whole frame loop
function add_impact_mark(st,local){ if(!st||!st.group||!local||(cfg.effects_quality??2)<1) return; const cap=[0,10,28,56][Math.max(0,Math.min(3,cfg.effects_quality|0))];
	while(impact_marks.length>=cap){ const old=impact_marks.shift(); old.parent?.remove(old); }
	const n=_v2.set(local.x,local.y,local.z).normalize(); const mark=new THREE.Mesh(impact_mark_geo,impact_mark_mat); mark.position.set(local.x,local.y,local.z).addScaledVector(n,.018); mark.quaternion.setFromUnitVectors(_mark_z,n); const s=.22+Math.random()*.28; mark.scale.set(s,s*(.65+Math.random()*.35),1); mark.rotation.z=Math.random()*Math.PI*2; mark.renderOrder=3; st.group.add(mark); impact_marks.push(mark); }
if(DEV_MODE) (globalThis as any).dev_ball=()=>{ call_the_ball(); return comms.slice(-2).map(c=>c.text); };   // dev: fire the ball exchange and return both lines — a flown pattern turn is not reachable from a headless harness, and this exercises the real function
if(DEV_MODE) (globalThis as any).dev_flight=()=>({ pitch:+(Math.asin(THREE.MathUtils.clamp(ownship.fwd.y,-1,1))*57.3).toFixed(2), g:+(ownship.gload??1).toFixed(2), aoa:+(ownship.aoa??0).toFixed(1), stick:last_controls?+(+last_controls.pitch).toFixed(3):0, head:[+head_az.toFixed(3),+head_el.toFixed(3)], padlock, law:law_active, pip:dev_pip, hold:weapons_hold, rounds:ownship.rounds??-1, gear:+(ownship.gear??1).toFixed(2), sparks:_spark_count, bandit:has_enemy?{thrust:+(bandit.harm.thrust||0).toFixed(2),leak:+(bandit.harm.leak||0).toFixed(2),fire:(bandit.harm.fire||[0,0]).map(v=>+v.toFixed(2)),burning:!!bandit.harm.burning,marks:impact_marks.length}:null });   // dev (#242, #243, #244): flight-state sampler for headless input-shaping verification — the unload test reads pitch/g/stick at ~12 Hz through a pull-release cycle
if(DEV_MODE) (globalThis as any).dev_approach=(clouds,nm,ft)=>{   // dev (#6): set a cloud deck and park the jet on the 3.5 deg glideslope at nm — cfg/apply_clouds/carrier_world are module-scope, so a headless approach test cannot be driven from page script without this
	if(clouds!==undefined){ cfg.clouds=clouds; apply_clouds(); }
	const d=nm*1852, tw=SHIP.wires[SHIP.wires.length>3?2:1], td=carrier_world(tw,strip_lat(tw));
	const A=carrier_world(SHIP.line.afa,SHIP.line.alat), B=carrier_world(SHIP.line.bfa,SHIP.line.blat);
	let lx=B.x-A.x, lz=B.z-A.z; const l=Math.hypot(lx,lz)||1; lx/=l; lz/=l;
	const alt=ft!==undefined?ft*0.3048:(nm*1852*Math.tan(3.5*Math.PI/180)+CARRIER.deckY);
	ownship.pos.set(td.x-lx*d, alt, td.z-lz*d); ownship.fwd.set(lx,0,lz).normalize();
	const r=new THREE.Vector3().crossVectors(ownship.fwd,world_up).normalize(), u=new THREE.Vector3().crossVectors(r,ownship.fwd).normalize();
	ownship.q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(ownship.fwd,u,r)); ownship.vel_dir.copy(ownship.fwd);
	flight_push();
	const p=CLOUDS[cfg.clouds];
	return { clouds:cfg.clouds, nm, alt:+alt.toFixed(0), altFeet:+(alt/0.3048).toFixed(0), base:p?p.base:null, top:p?p.top:null, inCloud:!!p&&alt>=p.base&&alt<=p.top }; };
if(DEV_MODE) (globalThis as any).dev_effects=(q)=>{ cfg.effects_quality=q; apply_effects(); return [smoke.limit,strikes.limit,debris.limit,flares.limit]; };   // dev (#13): the Settings live-apply path, verifiable headless
if(DEV_MODE) (globalThis as any).dev_pools=()=>{   // dev (#13): pool invariants — the swap-remove position map must never duplicate, lose, or mis-map a live index
	const report={};
	for(const [name,p] of [["smoke",smoke],["strikes",strikes],["debris",debris],["flares",flares],["tracers",tracers]]){
		const seen=new Set(); let dup=0, dead=0, mis=0, live=0;
		for(let n=0;n<p.activeList.length;n++){ const i=p.activeList[n];
			if(seen.has(i)) dup++; seen.add(i);
			if(!p.active[i]) dead++;
			if(p.pos[i]!==n) mis++; }
		for(let i=0;i<p.max;i++) if(p.active[i]){ live++; if(!seen.has(i)) mis++; }   // an active slot missing from the list would never simulate or render again
		report[name]={list:p.activeList.length,live,dup,dead,mis,limit:p.limit??p.max}; }
	return report; };
if(DEV_MODE) (globalThis as any).dev_bandit=(vx,vy,vz)=>{ bandit.velx=+vx||0; bandit.vely=+vy||0; bandit.velz=+vz||0; if(bandit_brain) bandit_spawn(bandit.pos,{x:bandit.velx,y:bandit.vely,z:bandit.velz}); return [bandit.velx,bandit.vely,bandit.velz]; };   // dev (#pipper): give the boxed target a chosen world velocity for deflection-solution checks
if(DEV_MODE) (globalThis as any).dev_close=(m,az,el)=>{ const d=+m||200;   // dev (?developer=1 only): park the bandit at d metres — dead ahead by default, or at az/el degrees off the nose (padlock and JHMCS checks need a target at a chosen aspect; module scope hides every placement primitive from page script, so the hook carries the geometry)
	const a=(+az||0)*D2R, e=(+el||0)*D2R;
	_pad_d.copy(ownship.fwd).multiplyScalar(Math.cos(a)).addScaledVector(ownship.right,Math.sin(a)).normalize();
	bandit.pos.copy(ownship.pos).addScaledVector(_pad_d,d*Math.cos(e)); bandit.pos.y+=d*Math.sin(e);
	bandit.fwd.copy(ownship.fwd); bandit.speed=ownship.speed;
	if(bandit_brain) bandit_spawn(bandit.pos,{x:bandit.fwd.x*bandit.speed,y:0,z:bandit.fwd.z*bandit.speed}); return d; };
function hit_sparks(x,y,z,vx,vy,vz,target,local){ _spark_count++; add_impact_mark(target,local);
	// Re-read against real gun-camera frames (#239, the 3 June 1967 F-105 on a
	// MiG-17 in colour): 20 mm HEI lands as a SOFT VOLUMETRIC FLASH CLOUD —
	// warm white-cream, a metre or two across, cauliflower edges, hugging the
	// skin — because each round is a small high-explosive detonation, not a
	// spark shower. So the LEAD is now a burst-puff in the smoke pool; the
	// additive hot core stays (the earlier trial, #217, proved additive is
	// what reads over a grey airframe) but trimmed, its sparks thrown as
	// short collinear STREAKS (the API garnish of the WWII footage). Heavy
	// walking bursts occasionally shed a dark tumbling flake — the panel
	// visibly leaving the MiG's wing in the same frame.
	for(let i=0;i<3;i++){ const k=pool_spawn(smoke); if(k<0) break;   // the HEI cloud: one bright body, two wisps
		smoke.px[k]=x+(Math.random()-0.5)*1.2; smoke.py[k]=y+(Math.random()-0.5)*1.0; smoke.pz[k]=z+(Math.random()-0.5)*1.2;
		smoke.vx[k]=(vx||0)*0.9+(Math.random()-0.5)*5; smoke.vy[k]=(vy||0)*0.9+(Math.random()-0.5)*5; smoke.vz[k]=(vz||0)*0.9+(Math.random()-0.5)*5;
		smoke.ttl[k]=smoke.life[k]=i===0?0.30:(0.8+Math.random()*0.5);
		smoke.sz[k]=i===0?0.15:0.10; smoke.gr[k]=i===0?0.5:0.25;   // a metre or two of cloud, swelling as it thins (first cut at 0.34 swallowed the whole jet)
		if(i===0){ smoke.r[k]=1.25;smoke.g[k]=1.18;smoke.b[k]=1.02; }   // the incandescent body, warm white-cream
		else { smoke.r[k]=0.82;smoke.g[k]=0.80;smoke.b[k]=0.76; } }
	for(let i=0;i<3;i++){ const k=pool_spawn(strikes); if(k<0) break;   // the tight white-hot core at the point of impact
		const a=Math.random()*Math.PI*2, e=Math.random()*Math.PI-Math.PI/2, sp=0.6+Math.random()*1.6;
		strikes.px[k]=x+(Math.random()-0.5)*0.5; strikes.py[k]=y+(Math.random()-0.5)*0.5; strikes.pz[k]=z+(Math.random()-0.5)*0.5;
		strikes.vx[k]=(vx||0)+Math.cos(a)*Math.cos(e)*sp; strikes.vy[k]=(vy||0)+Math.sin(e)*sp*0.6+1.5; strikes.vz[k]=(vz||0)+Math.sin(a)*Math.cos(e)*sp;
		strikes.ttl[k]=strikes.life[k]=0.14+Math.random()*0.08;
		strikes.r[k]=1.0; strikes.g[k]=0.97; strikes.b[k]=0.88; }
	// Carry the TARGET's velocity throughout: ejecta is shed BY the airframe,
	// so it leaves at the jet's speed plus its own. Spawned at rest in world
	// space it hung where the round struck while the jet flew on at ~220 m/s.
	for(let d=0;d<3;d++){   // streaked sparks: three directions, three collinear particles each — a line, not a dot
		const a=Math.random()*Math.PI*2, e=Math.random()*Math.PI-Math.PI/2, sp=11+Math.random()*16;
		const ux=Math.cos(a)*Math.cos(e), uy=Math.sin(e)*0.6, uz=Math.sin(a)*Math.cos(e);
		for(let j=0;j<3;j++){ const k=pool_spawn(strikes); if(k<0) break;
			strikes.px[k]=x+ux*j*0.9; strikes.py[k]=y+uy*j*0.9; strikes.pz[k]=z+uz*j*0.9;
			strikes.vx[k]=(vx||0)+ux*sp; strikes.vy[k]=(vy||0)+uy*sp+1.5; strikes.vz[k]=(vz||0)+uz*sp;
			strikes.ttl[k]=strikes.life[k]=0.16+j*0.05+Math.random()*0.08;
			strikes.r[k]=1.0; strikes.g[k]=0.5+Math.random()*0.3; strikes.b[k]=0.10; } }
	if(Math.random()<0.15){ const k=pool_spawn(debris); if(k>=0){   // roughly one flake per walked burst
		debris.px[k]=x; debris.py[k]=y; debris.pz[k]=z;
		debris.vx[k]=(vx||0)*0.8+(Math.random()-0.5)*14; debris.vy[k]=(vy||0)*0.8+2+Math.random()*6; debris.vz[k]=(vz||0)*0.8+(Math.random()-0.5)*14;
		debris.ttl[k]=debris.life[k]=2.5+Math.random()*2;
		debris.r[k]=0.16;debris.g[k]=0.16;debris.b[k]=0.17; } } }
const transient_fx=[];
function transient_blast(x,y,z,water){ if((cfg.effects_quality??2)<1) return;
	const mat=new THREE.MeshBasicMaterial({color:water?0xd9f4ff:0xffb34d,transparent:true,opacity:.72,depthWrite:false,blending:water?THREE.NormalBlending:THREE.AdditiveBlending,side:THREE.DoubleSide,toneMapped:false});
	const mesh=new THREE.Mesh(new THREE.RingGeometry(.45,1,48),mat); mesh.position.set(x,water?.12:y,z); if(water) mesh.rotation.x=-Math.PI/2; else mesh.quaternion.copy(camera.quaternion); scene.add(mesh);
	const light=new THREE.PointLight(water?0xcceeff:0xff8b32,water?14:38,water?35:75,2); light.position.set(x,y+1,z); scene.add(light); transient_fx.push({mesh,light,age:0,life:water?.75:.34,water}); }
function update_transient_fx(dt){ for(let i=transient_fx.length-1;i>=0;i--){ const f=transient_fx[i]; f.age+=dt; const t=f.age/f.life; if(t>=1){ scene.remove(f.mesh,f.light); f.mesh.material.dispose(); f.mesh.geometry.dispose(); transient_fx.splice(i,1); continue; }
	const s=(f.water?3:2)+t*(f.water?24:15); f.mesh.scale.setScalar(s); f.mesh.material.opacity=(1-t)*(f.water?.55:.72); f.light.intensity=(1-t)*(f.water?14:38); if(!f.water) f.mesh.quaternion.copy(camera.quaternion); } }
function explosion_at(x,y,z,kind){
	audio_explosion(Math.hypot(x-ownship.pos.x,y-ownship.pos.y,z-ownship.pos.z));
	const water=kind==="water"||(kind===undefined&&y<2); transient_blast(x,y,z,water);
	// Two stages (#239): a fast-swelling fireball that soots into a slower,
	// longer-lived dark cloud — fewer particles than the old 64, because each
	// one now GROWS instead of holding its spawn size — plus shed wreckage on
	// its own ballistic arcs drawing micro-trails as it falls.
	for(let i=0;i<36;i++){ const k=pool_spawn(smoke); if(k<0) break;
	const fire=i<14, a=Math.random()*Math.PI*2, e=Math.random()*Math.PI-Math.PI/2, sp=fire?(9+Math.random()*40):(3+Math.random()*15);
	smoke.px[k]=x; smoke.py[k]=y+1; smoke.pz[k]=z;
	smoke.vx[k]=Math.cos(a)*Math.cos(e)*sp; smoke.vy[k]=Math.abs(Math.sin(e))*sp*0.8+6; smoke.vz[k]=Math.sin(a)*Math.cos(e)*sp;
	smoke.ttl[k]=smoke.life[k]=fire?(0.5+Math.random()*0.7):(3.0+Math.random()*3.0);
	smoke.sz[k]=fire?0.45:(0.35+Math.random()*0.2); smoke.gr[k]=fire?2.6:0.9;   // the fireball balloons; the soot billows
	if(water){ smoke.r[k]=.82; smoke.g[k]=.92; smoke.b[k]=1.0; smoke.gr[k]=1.5; smoke.ttl[k]=smoke.life[k]=.8+Math.random()*1.5; }
	else if(fire){ smoke.r[k]=1.3; smoke.g[k]=0.55+Math.random()*0.3; smoke.b[k]=0.10; } else { smoke.r[k]=0.16; smoke.g[k]=0.15; smoke.b[k]=0.15; } }
	for(let i=0;i<9;i++){ const k=pool_spawn(debris); if(k<0) break;
	const a=Math.random()*Math.PI*2, e=Math.random()*Math.PI-Math.PI/2, sp=12+Math.random()*30;
	debris.px[k]=x; debris.py[k]=y+1; debris.pz[k]=z;
	debris.vx[k]=Math.cos(a)*Math.cos(e)*sp; debris.vy[k]=Math.abs(Math.sin(e))*sp*0.7+8; debris.vz[k]=Math.sin(a)*Math.cos(e)*sp;
	debris.ttl[k]=debris.life[k]=3.5+Math.random()*3;
	debris.r[k]=0.15;debris.g[k]=0.15;debris.b[k]=0.16; } }
function crash_ownship(why){ if(crash_t>0) return; crash_t=3.0;
	ownship.fate=ownship.fate||why||"pilot";   // how this life ended, for the recording (#238); the pilot-down path calls with no reason
	if(!MULTIPLAYER) own_deaths++;   // local deaths count too — the history records the joust honestly (multiplayer's arrive via the net death event)
	if(has_enemy){ has_enemy=false; bandit.group.visible=false; }   // the duel is decided the other way: the winner stands down rather than circling a respawning target (has_enemy is never true in multiplayer, where the airframe belongs to a remote player)
	(globalThis as any).dev_crash=why||"?"; explosion_at(ownship.pos.x,ownship.pos.y,ownship.pos.z); ownship.group.visible=false; ownship.speed=0; }
function over_runway(p){ const r=obstacles.runway; if(!r) return false; const dx=p.x-r.x, dz=p.z-r.z;
	return Math.abs(dx*r.fx+dz*r.fz)<r.hl && Math.abs(dx*r.fz-dz*r.fx)<r.hw; }
const GEAR=2.46;   // the aircraft origin rests this far above whatever surface is beneath it — the model's wheel bottoms measure 2.457 m below the (bbox-centred) origin in the gear-down pose; per-aircraft stance lives in AIRCRAFT_MODELS. Lower buries the wheels
const HOOK_DECK_CAP=0.88;   // max hook-deploy progress while resting on a surface — stops the claw at deck level instead of rotating through it
const CARRIER_YD=(SHIP.yaw-(SHIP.bow??90))*D2R, CARRIER_C=Math.cos(CARRIER_YD), CARRIER_S=Math.sin(CARRIER_YD);   // same yaw-delta frame as place_on_cat: yaw - bow, so fore-aft follows the drawn bow (the -90 default is the legacy +Z-bow convention the Ford's constants were measured in)
function carrier_fore_aft(x,z){ return (x-CARRIER.x)*CARRIER_C-(z-CARRIER.z)*CARRIER_S; }   // carrier-local fore/aft: + toward the bow (catapult ≈ +48), the arrestor wires are aft (≈ −50)
function carrier_world(lx,lz){ return { x:CARRIER.x+lx*CARRIER_C+lz*CARRIER_S, z:CARRIER.z-lx*CARRIER_S+lz*CARRIER_C }; }   // carrier-local (fore-aft, lateral: −=port) → world x/z (same frame as place_on_cat)
function carrier_lateral(x,z){ return (x-CARRIER.x)*CARRIER_S+(z-CARRIER.z)*CARRIER_C; }   // inverse of the lateral axis: how far port(−)/starboard(+) of the ship centreline
function cat_spot(i=cat_idx){ const cat=SHIP.shuttles[i]; return { x:CARRIER.x+cat.x*CARRIER_C+cat.z*CARRIER_S, z:CARRIER.z-cat.x*CARRIER_S+cat.z*CARRIER_C }; }   // world position of a catapult spot
const CAT_POS_TOL=3, CAT_HEADING_DOT=0.99;   // "spotted on the cat": within 3 m of the spot and ~8° of the launch heading — tight, so the launch (which fires from the actual pose, never snapped) always looks clean
function on_cat_spot(){   // which catapult the aircraft is parked on, lined up down its launch heading — -1 for none (works before the carrier GLB finishes loading — the spots are fixed world coords)
	if(ownship.launching) return -1;
	const fh=Math.hypot(ownship.fwd.x,ownship.fwd.z)||1;
	const nose=(AIRCRAFT_MODELS[own_aircraft()]||AIRCRAFT_MODELS.fa18c).nose||5.3;
	const nx=ownship.pos.x+ownship.fwd.x/fh*nose, nz=ownship.pos.z+ownship.fwd.z/fh*nose;   // the nose-gear point — the shuttle datum
	for(let i=0;i<SHIP.shuttles.length;i++){
		const cs=cat_spot(i); if(Math.hypot(nx-cs.x,nz-cs.z)>CAT_POS_TOL) continue;
		const hd=SHIP.shuttles[i].h*D2R, fx=Math.cos(hd), fz=-Math.sin(hd), cfx=fx*CARRIER_C+fz*CARRIER_S, cfz=-fx*CARRIER_S+fz*CARRIER_C;   // this cat's launch heading in world
		if((ownship.fwd.x*cfx+ownship.fwd.z*cfz)/fh >= CAT_HEADING_DOT) return i;
	}
	return -1;
}
function launch_status(){ return (flight_active?(core_catapult>=0&&core_stroke<0):on_cat_spot()>=0) ? (ownship.throttle>=0.9?2:1) : 0; }   // 0 off the cat / not attached · 1 attached, run up · 2 attached + full power, ready
// Landing line, measured directly at the three wire crossings on the landing path.
function strip_lat(fa){ return SHIP.line.alat+(fa-SHIP.line.afa)*((SHIP.line.blat-SHIP.line.alat)/(SHIP.line.bfa-SHIP.line.afa)); }   // lateral of the landing centreline at a given fore-aft
const _slen=Math.hypot(SHIP.line.bfa-SHIP.line.afa,SHIP.line.blat-SHIP.line.alat), STRIP_UFA=(SHIP.line.bfa-SHIP.line.afa)/_slen, STRIP_ULAT=(SHIP.line.blat-SHIP.line.alat)/_slen;   // unit vector along the landing line (toward +fa = the rollout)
let _ground_kind="";   // surface kind under the last ground_height() hit: deck / runway / apron / ground / "" (sea) — read right after the call
function ground_height(x,z){   // top of the solid surface under (x,z): carrier deck / runway / apron / island; -inf = open sea (no landing)
	_ground_kind="";
	if(Math.abs(x-CARRIER.x)<160 && Math.abs(z-CARRIER.z)<160){
		if(!carrier_model){ _ground_kind="deck"; return CARRIER.deckY; }   // GLB still loading — treat the deck box as solid at the known height so a carrier start doesn't fall through to the flight model
		const h=deck_y_at(carrier_model,x,z,-1e9);
		if(h>-1e8 && h<CARRIER.deckY+4){ _ground_kind="deck"; return h>CARRIER.deckY-2.5?CARRIER.deckY:h; }   // the flight deck is one horizontal plane — the GLB models it as two flat layers 1.72 m apart (gaps in the top layer expose the lower), so near-deck hits snap to the measured plane; genuinely lower hits (catwalks/sponsons off the edge) stay real. Taller hits are the island superstructure — see check_collisions
	}
	if(obstacles.runway && over_runway({x,z})){ _ground_kind="runway"; return ISLAND_H+1.5; }
	for(const a of obstacles.aprons){ if(pip(x,z,a)){ _ground_kind="apron"; return ISLAND_H+AIRFIELD_FLOAT; } }
	for(const is of obstacles.islands){ if(x>is.minx-SKIRT&&x<is.maxx+SKIRT&&z>is.minz-SKIRT&&z<is.maxz+SKIRT){
		if(pip(x,z,is.pts)){ _ground_kind="ground"; return ISLAND_H; }
		if(in_harbour(x,z)){ const d=edge_distance(x,z,is.pts); if(d<QUAY_APRON){ _ground_kind="ground"; return ISLAND_H-(ISLAND_H-QUAY)*(d/QUAY_APRON); } }   // harbour: short apron to the quay edge, then the wall drops into deep water
		else { const d=edge_distance(x,z,is.pts); if(d<SKIRT){ _ground_kind="ground"; return ISLAND_H-(ISLAND_H+SKIRT_DROP)*(d/SKIRT); } }   // the beach skirt is a real sloped surface (sand → soft-field rules)
	} }
	return -1e9;
}
function check_collisions(){   // ownship vs sea / buildings / structures / carrier / other aircraft (land landings handled by the ground floor in fly_player)
	if(crash_t>0) return; const p=ownship.pos;
	if(p.y<3.4 && ground_height(p.x,p.z)<-1e8) return crash_ownship("sea");   // the sea — but not the beach skirt, which slopes below this line down to the waterline
	if(p.y<45){
		for(const b of obstacles.buildings){ if(p.y<b.topY+2 && p.x>b.minx&&p.x<b.maxx&&p.z>b.minz&&p.z<b.maxz && pip(p.x,p.z,b.pts)) return crash_ownship("building"); }
		for(const s of obstacles.posts){ if(p.y<s.y1 && Math.hypot(p.x-s.x,p.z-s.z)<s.r+4) return crash_ownship("post"); }
	}
	if(carrier_model && p.y<80 && Math.abs(p.x-CARRIER.x)<160 && Math.abs(p.z-CARRIER.z)<160){
		const h=deck_y_at(carrier_model,p.x,p.z,-1e9);   // the flat deck is a landing surface (ground floor); only the taller island superstructure is an obstacle here
		if(h>CARRIER.deckY+4 && p.y<h) return crash_ownship("island");   // flew into the island superstructure
	}
	// A midair kills BOTH. This drew an explosion on the bandit and then merely
	// relocated it — damage intact, no consequence — so the player watched it
	// blow up and it flew on. bandit_destroy is the real thing (explosion,
	// duel over); no kill is credited, because flying into someone is
	// not shooting them down.
	if(has_enemy && wrap_distance(p,bandit.pos)<14){ bandit_destroy(); return crash_ownship("midair"); }
}
function lso_grade(){   // LSO pass grade from the in-close deviations and the touchdown: OK / FAIR / NO-GRADE / CUT
	const p=ownship.pass||{gs:0,az:0,n:0}, t=ownship.touch||{sink:0,bank:0,fa:0};
	const gs=p.n?p.gs/p.n:9, az=p.n?p.az/p.n:9;   // no in-close data (e.g. a taxi engagement) can't grade OK
	if(t.sink>7 || t.fa<-120 || t.bank>0.14 || ownship.waved) return "CUT";   // dangerously hard, ramp-close, a wing down at the deck, or trapped through a waveoff
	if((ownship.wire===2||ownship.wire===3) && gs<0.35 && az<0.9 && t.sink<6) return "OK";
	if(gs<0.7 && az<1.8) return "FAIR";
	return "NO-GRADE";
}
// ---- landing test scenarios (dev-only, TEST_SCENARIOS + Shift+1..0): scripted hands-off approaches with exact
// touchdown parameters, because a keyboard pilot can't reliably hit "sink 11 m/s, wings level" to test the gates.
// The autopilot prescribes attitude + track to the touchdown; the outcome (land / bounce / crash / trap / bolter)
// then unfolds through the ordinary physics and shows via the ordinary banners.
const TESTS=[
	{name:"1 runway - soft touchdown (lands)",              V:70,  S:2.5, pitch:4},
	{name:"2 runway - firm 11 m/s (bounces)",               V:70,  S:11,  pitch:4},
	{name:"3 runway - hard 16 m/s (crashes)",               V:70,  S:16,  pitch:4},
	{name:"4 runway - banked 12 deg (wingtip strike)",      V:70,  S:2.5, pitch:2, bank:12},
	{name:"5 runway - nose-high 17 deg (tail strike)",      V:70,  S:2.5, pitch:17},
	{name:"6 runway - overspeed 115 m/s (tires fail, crashes)", V:115, S:2.5, pitch:2},   // ~90 kt over the tire limit: the blown-tire rollout cascading to a wreck is the ACCEPTED outcome under the real flight model (2026-07-14) — the placeholder model's survivable slide is history
	{name:"7 runway - gentle belly landing (slides)",       V:70,  S:1.2, pitch:2, gearup:true},
	{name:"8 runway - hard belly landing (crashes)",        V:70,  S:4,   pitch:2, gearup:true},
	{name:"9 carrier - on glideslope (traps)",              V:70,  S:4.3, pitch:4, carrier:true, hook:true},
	{name:"0 carrier - touch and go (bolter)",              V:80,  S:1.2, pitch:3, carrier:true, hook:false, long:55, bolter:true},
];
let test_active=null, test_idle=0, _test_power=0, test_brake=false, dev_fps=0, dev_jitter=false, livery_pending=null;   // post-scenario throttle grace: the physical lever must not re-power a scripted rollout (_test_power: a bolter keeps MIL power instead)
if(DEV_MODE) (globalThis as any).dev_measure=()=>{   // one-shot: the lowest mesh nodes in MODEL frame, named — the source of truth for the physics Belly/Probe constants (#72)
	const inverse=new THREE.Matrix4().copy(ownship.group.matrixWorld).invert();
	const v=new THREE.Vector3();
	const rows:any[]=[];
	ownship.group.traverse((o:any)=>{ if(!o.isMesh || !o.geometry) return;
		const pos=o.geometry.attributes.position; if(!pos) return;
		const m=new THREE.Matrix4().multiplyMatrices(inverse,o.matrixWorld);
		const stride=Math.max(1,Math.floor(pos.count/3000));
		let best=null as any;
		for(let i=0;i<pos.count;i+=stride){ v.fromBufferAttribute(pos,i).applyMatrix4(m);
			if(!best || v.y<best.y) best={y:v.y,x:v.x,z:v.z}; }
		if(best) rows.push({n:(o.name||o.parent?.name||"?").slice(0,28), y:+best.y.toFixed(2), x:+best.x.toFixed(2), z:+best.z.toFixed(2)}); });
	rows.sort((p1,p2)=>p1.y-p2.y);
	return JSON.stringify(rows.slice(0,16));
};
let dev_peakbank=0, dev_pitchhi=0, dev_pitchlo=0;   // true per-frame peak bank + pitch high/low since the last scenario start (#72)
let dev_fired=0;   // frames on which any REMOTE streamed gunfire — cumulative, so a headless probe can't miss a short burst between samples
if(DEV_MODE) (globalThis as any).dev_hook=()=>{   // the actual claw (aft-most low vertex of the Hook mesh) in WORLD, vs the current wire apex — #72 wire-to-claw
	let claw=null as any; const v=new THREE.Vector3(); const base=ownship.group.getObjectByName("Hook_AN_base_20");
	if(base) base.traverse((o:any)=>{ if(o.isMesh&&o.geometry?.attributes?.position){ const pos=o.geometry.attributes.position; for(let i=0;i<pos.count;i++){ v.fromBufferAttribute(pos,i).applyMatrix4(o.matrixWorld); if(!claw||v.y<claw.y) claw={x:v.x,y:v.y,z:v.z}; } } });
	let cl=null; if(claw){ const local=new THREE.Vector3(claw.x,claw.y,claw.z); ownship.group.worldToLocal(local); cl={x:+local.x.toFixed(2),y:+local.y.toFixed(2),z:+local.z.toFixed(2)}; }
	return JSON.stringify({claw:claw?{x:+claw.x.toFixed(2),y:+claw.y.toFixed(2),z:+claw.z.toFixed(2)}:null, clawModel:cl, trapped:!!ownship.trapped, wire:ownship.wire||0}); };
if(DEV_MODE) (globalThis as any).dev_probe=()=>({ y:+ownship.pos.y.toFixed(2), v:+ownship.speed.toFixed(1), vy:+(ownship.vely??0).toFixed(2), thr:+ownship.throttle.toFixed(2), wow:flight_ready()&&flight_active?flight_get()[STATE.wow]:-1, test:!!test_active, crash:crash_t>0, kills:own_kills, banditv:has_enemy?(bandit.group.visible?1:0):-1, msl:ownship.msl,
	running, loading, gates:{ carrier:!!carrier_model, aircraft:model_active, map:airports.length>0, core:flight_ready() },   // #restart debugging: which load gate is stuck
	atc:atc_on, missiles:missiles_on(), hold:weapons_hold, master, brake:!!input.brake, park:parking, flap:flap_select, banditspent:bandit.spent||0, trim:input.trim||0, lean:input.lean||0, flares:ownship.cm, probe:ownship.probeTarget??0, view:cfg.view, harm:{...bandit.harm}, own:{ burn:[+own_burn[0].toFixed(2),+own_burn[1].toFixed(2)], burning:own_burning, leak:+own_leak.toFixed(2) }, alerts:{ lamp:caution_lamp, keys:[...caution_keys] }, face:ddi_view_rect, pattern:pattern&&{...pattern}, comms:comms.map(c=>c.text).slice(-8), hook:+(ownship.hook??0).toFixed(2), gross:gross_weight(), fuel:Math.round(((ownship.gauges||{}).fuelRaw)||0), departure:departure_drive, yawrate:+((Math.abs((last_out||[])[STATE.omega+1]||0))*57.2958).toFixed(1), aoa:+(ownship.aoa??0).toFixed(1), dump:fuel_dump?1:0, secured:[...secured], /* #57 parked: tracking:{ on:head_track?1:0, ok:head_ok?1:0, az:+head_az.toFixed(3), el:+head_el.toFixed(3) }, */home:(()=>{const h=fpas_home(); return h?Math.round(h.arrive):null})(), spool:[+(((ownship.gauges||{}).spoolL)||0).toFixed(2),+(((ownship.gauges||{}).spoolR)||0).toFixed(2)],   // #50: the visual-pattern gates and the recent radio log   // #47 alert diagnostics; face is the full-screen DDI's on-screen box, which headless page verification crops from   // #40: the ownship's OWN damage — in multiplayer this comes from the server's copy via the self pose
	aoa:+(ownship.aoa??0).toFixed(2), zoom:+view_zoom.toFixed(2), view:cfg.view, sparks:_spark_count,
	stores:{ msl:ownship.msl, mask:own_mask().toString(2), external:+(((ownship.gauges||{}).externalRaw)||0).toFixed(0), rounds:stores_rounds(ownship.loadout||{}).map(r=>r.name), carriage:{...(ownship.carriage||{})}, cas:+(((ownship.cas||0))*1.9438).toFixed(0), debris:falling.length, dpos:falling[0]?falling[0].piece.position.toArray().map(n=>+n.toFixed(1)):null, dinfo:(()=>{ const f=falling[0]; if(!f) return null; let mesh=null; f.piece.traverse(o=>{ if(!mesh&&o.isMesh) mesh=o; }); return { vis:f.piece.visible, parent:f.piece.parent===scene, scale:+f.piece.scale.x.toFixed(4), mask:mesh?mesh.layers.mask:-1, mvis:mesh?mesh.visible:false, geo:!!(mesh&&mesh.geometry&&mesh.geometry.attributes.position), ndc:(()=>{ const v=new THREE.Vector3().copy(f.piece.position).project(camera); return [+v.x.toFixed(2),+v.y.toFixed(2),+v.z.toFixed(3)]; })(), opos:ownship.group.position.toArray().map(n=>+n.toFixed(1)) }; })(),   // #17/#18 diagnostics: the flown loadout, the live core mask, carriage harm, knots CAS
		racks:Object.fromEntries(Object.entries((ownship.racks&&ownship.racks.nodes)||{}).map(([n,o])=>[n,o.visible])),
		lateral:Object.fromEntries(Object.entries((ownship.racks&&ownship.racks.nodes)||{}).map(([n,o])=>{ let mesh=null; o.traverse(x=>{ if(!mesh&&x.isMesh) mesh=x; });
			if(!mesh||!mesh.geometry||!mesh.geometry.attributes.position) return [n,null];
			// INDEX-AWARE mean: the split stores.glb shares one vertex buffer
			// across every station's primitive, so a bounding box over the
			// position attribute spans all stations — only the index selects
			// this piece's triangles.
			const g=mesh.geometry, pos=g.attributes.position, idx=g.index;
			const c=new THREE.Vector3(); let count=0;
			if(idx){ for(let k=0;k<idx.count;k+=9){ const i=idx.getX(k); c.x+=pos.getX(i); c.y+=pos.getY(i); c.z+=pos.getZ(i); count++; } }
			else { for(let i=0;i<pos.count;i+=3){ c.x+=pos.getX(i); c.y+=pos.getY(i); c.z+=pos.getZ(i); count++; } }
			if(!count) return [n,null];
			c.multiplyScalar(1/count); mesh.localToWorld(c); ownship.group.worldToLocal(c);
			return [n,+c.z.toFixed(2)]; })),   // group-frame lateral: positive z = starboard (the cockpit panel-click convention) — the port/starboard placement truth for each rack
		tips:Object.fromEntries(Object.entries(TIP_NODES).map(([k,n])=>{ const o=ownship.group.getObjectByName(n); return [k,o?o.visible:null]; })),
		tiplateral:Object.fromEntries(Object.entries(TIP_NODES).map(([k,n])=>{ const o=ownship.group.getObjectByName(n); if(!o||!o.isMesh||!o.geometry.attributes.position) return [k,null];
			const pos=o.geometry.attributes.position, c=new THREE.Vector3(); let count=0;
			for(let i=0;i<pos.count;i+=7){ c.x+=pos.getX(i); c.y+=pos.getY(i); c.z+=pos.getZ(i); count++; }
			c.multiplyScalar(1/count); o.localToWorld(c); ownship.group.worldToLocal(c); return [k,+c.z.toFixed(2)]; })) },   // the airframe tip nodes' true sides, same convention as lateral
	record:(()=>{ const r=recording_file(); if(!r) return null; const lines=r.text.split(String.fromCharCode(10));
		return {lines:lines.length, session:r.session, kind:r.kind, bot:/Doctrine=/.test(r.text),
			// The ownship's last data line: proves a channel actually plumbs
			// through at runtime, which a unit test on the renderer cannot.
			sample:(()=>{const d=lines.filter(l=>l.indexOf("1,T=")===0);return d[d.length-1]||"";})()};
	})(),
	rig:(()=>{ const r=(ownship.group.userData.rig||[]).filter(e=>e.gauge!==undefined); return { bound:r.filter(e=>e.object).length, total:r.length, missing:r.filter(e=>!e.object).map(e=>e.name) }; })(),
	screens:(()=>{ const out={}; const v=new THREE.Vector3();   // where each driven gauge lands on screen (css px): crops for visual verification
		for(const e of ownship.group.userData.rig||[]){ if(e.gauge===undefined||!e.object) continue;
			e.object.getWorldPosition(v); v.project(cockpit_cam);
			if(v.z<1) out[e.name]=[Math.round((v.x+1)/2*innerWidth), Math.round((1-v.y)/2*innerHeight)]; }
		return out; })(),
	gauges:(()=>{ const g=ownship.gauges||{}; const f=v=>v===undefined?null:+(+v).toFixed(3); return { asi:f(g.asi), altitude:f(g.altitude), vsi:f(g.vsi), fuelLbs:f(g.fuelLbs), rpmL:f(g.rpmL), egtL:f(g.egtL), flowL:f(g.flowL), clockH:f(g.clockH) }; })(),
	indexer:(()=>{ const i=ownship.group.userData.indexer; return i?{ slow:+i.slow.opacity.toFixed(2), donut:+i.donut.opacity.toFixed(2), fast:+i.fast.opacity.toFixed(2) }:null; })(),
	built:(()=>{ const u=ownship.group.userData; return { indexer:!!u.indexer, lamps:!!u.lamps, radalt:!!u.radalt, screens:(u.screens||[]).length, err:build_error,
		view:cfg.view, focus:ddi_focus(), hsi:hsi_state.scale, sa:sa_state.scale, repeat,
		radar:(()=>{ const r=u.radalt; if(!r) return null; const v=new THREE.Vector3(); r.mesh.getWorldPosition(v); v.project(cockpit_cam);   // the disc's projection — aims verification crops
			return [Math.round((v.x*0.5+0.5)*HW),Math.round((-v.y*0.5+0.5)*HH)]; })(),
		mount:(()=>{ const b=u.indexerGroup; if(!b) return null; const v=new THREE.Vector3(); b.children[1].getWorldPosition(v); v.project(cockpit_cam);
			return { px:[Math.round((v.x*0.5+0.5)*HW),Math.round((-v.y*0.5+0.5)*HH)], at:b.position.toArray().map(n=>+n.toFixed(3)), low:u.indexlow }; })(),
		outline:(u.outline||[]).map(p=>p.map(n=>+n.toFixed(3))),
		faces:["left","right","center"].map(d=>d+":"+(ddi_state[d].menu||ddi_state[d].page)), px:(u.screens||[]).map(sc=>sc.canvas.width),
		rects:(u.screens||[]).map(sc=>{ const m=sc.mesh, v=new THREE.Vector3(), w=(m.geometry as THREE.PlaneGeometry).parameters.width/2, h=sc.height/2;   // projected quad corners (css px, pilot's view) — aims headless bezel clicks
			const p=(px_,py_)=>{ v.set(px_,py_,0).applyMatrix4(m.matrixWorld).project(cockpit_cam); return [Math.round((v.x*0.5+0.5)*HW),Math.round((-v.y*0.5+0.5)*HH)]; };
			return { tl:p(-w,h), br:p(w,-h) }; }),
		geom:(u.screens||[]).map(sc=>({ at:sc.mesh.position.toArray().map(n=>+n.toFixed(3)), box:sc.box, fit:sc.fit, stack:sc.stack, mask:sc.mesh.layers.mask, vis:sc.mesh.visible })), eye:u.eye, glass:u.glass }; })(),
	scene:(()=>{ const u=ownship.group.userData; const probe=(o)=>{ if(!o) return null;
			const p=new THREE.Vector3(); o.getWorldPosition(p);
			let vis=true, q=o; while(q){ if(!q.visible) vis=false; q=q.parent; }
			let inScene=false; q=o; while(q){ if(q===scene) inScene=true; q=q.parent; }
			return { p:[+p.x.toFixed(1),+p.y.toFixed(1),+p.z.toFixed(1)], layer:o.layers.mask, vis, inScene }; };
		return { radalt:probe(u.radalt&&u.radalt.mesh), screen0:probe(u.screens&&u.screens[0]&&u.screens[0].mesh), nose:probe(u.lamps&&u.lamps.nose), donut:probe(u.indexerGroup&&u.indexerGroup.children[1]), eyecam:[+cockpit_cam.position.x.toFixed(1),+cockpit_cam.position.y.toFixed(1),+cockpit_cam.position.z.toFixed(1)], cam_layer:cockpit_cam.layers.mask }; })(), geart:+(ownship.gearTarget??0), gearx:+((ownship.gear??0).toFixed(2)), marshal:marshal?{left:+(marshal.push-sim_time).toFixed(1),commenced:marshal.commenced,platform:marshal.platform,dirty:marshal.dirty,ball:marshal.ball}:null, comms:comms.map(c=>c.text), groove:!!ownship.groove, waving:!!ownship.waving, icls:!!approach_deviation(),
	boff:has_enemy?+(Math.acos(THREE.MathUtils.clamp(ownship.fwd.dot(_v.set(bandit.pos.x-ownship.pos.x,bandit.pos.y-ownship.pos.y,bandit.pos.z-ownship.pos.z).normalize()),-1,1))*57.3).toFixed(0):-1,
	bburn:has_enemy&&bandit.harm?(bandit.harm.burning?1:0):-1, bkill:has_enemy&&bandit.harm?(bandit.harm.killed?1:0):-1, bwing:has_enemy&&bandit.harm?+(bandit.harm.wing??0).toFixed(2):-1,
	brng:has_enemy?+wrap_distance(ownship.pos,bandit.pos).toFixed(0):-1, peak:+dev_peakbank.toFixed(1), phi:+dev_pitchhi.toFixed(1), plo:+dev_pitchlo.toFixed(1), gs:ownship.pass&&ownship.pass.n?+(ownship.pass.gs/ownship.pass.n).toFixed(2):-1, az:ownship.pass&&ownship.pass.n?+(ownship.pass.az/ownship.pass.n).toFixed(2):-1, grade:ownship.grade||"", pn:ownship.pass?ownship.pass.n:0, why:(globalThis as any).dev_crash||"", x:+ownship.pos.x.toFixed(0), z:+ownship.pos.z.toFixed(0), pitch:+((Math.asin(THREE.MathUtils.clamp(ownship.fwd.y,-1,1))*57.3).toFixed(1)), bank:+((Math.atan2(ownship.right.y,ownship.up.y)*57.3).toFixed(1)), wire:ownship.wire||0,
	lat:carrier_ols?+(((ownship.pos.x-carrier_ols.tdx)*(-carrier_ols.apz)+(ownship.pos.z-carrier_ols.tdz)*carrier_ols.apx).toFixed(1)):0,
	along:carrier_ols?+(((ownship.pos.x-carrier_ols.tdx)*carrier_ols.apx+(ownship.pos.z-carrier_ols.tdz)*carrier_ols.apz).toFixed(1)):0, fa:+carrier_fore_aft(ownship.pos.x,ownship.pos.z).toFixed(1), edge:carrier_ols?+((ownship.pos.y-carrier_ols.dy).toFixed(1)):0,
	darts:net?net.darts.map(d=>({p:d.position.map(n=>+n.toFixed(0)),v:d.velocity.map(n=>+n.toFixed(0)),s:d.shooter})):[], drawn:darts_pool.filter(p=>p.mesh.visible).length, firing:[...remotes.values()].filter(st=>st.firing).length, fired:dev_fired, remotes:remotes.size,
	burn:+Math.max(own_burn[0],own_burn[1]).toFixed(2), burning:own_burning, leak:+own_leak.toFixed(2) });   // dev: CDP-reachable state sampler for headless scenario verification (#72); darts/drawn/firing/remotes verify the multiplayer weapon visuals over a live wire; burn/leak mirror the damage-visual drivers (#78)
function start_test(i){ const sc=TESTS[i]; if(!sc || crash_t>0) return;
	let T,d;
	if(sc.carrier){ if(!carrier_ols) return; const o=carrier_ols;
		d=new THREE.Vector3(-o.apx,0,-o.apz).normalize(); T=new THREE.Vector3(o.tdx,0,o.tdz);   // fly the approach axis toward the aim wire
		T.addScaledVector(d,18);   // hook-geometry bias: the deployed hook rides level with the unloaded mains and trails ~2 m aft, so its deck touch runs ~18 m short of the origin's aim line — unbiased, the on-glideslope pass caught the 1 wire on the Nimitz
		if(sc.short) T.addScaledVector(d,-sc.short);                                            // aim short of the wires (ramp cases)
		if(sc.long) T.addScaledVector(d,sc.long); }                                             // aim LONG, past every wire (the bolter floats over them and flies off the bow)
	else { if(!airports.length) return; const ap=airports[0];
		d=new THREE.Vector3(ap.dir.x,0,ap.dir.z).normalize(); T=new THREE.Vector3(ap.start.x+d.x*500,0,ap.start.z+d.z*500); }   // 500 m past the threshold
	const g=ground_height(T.x,T.z); T.y=(g>-1e8?g:0)+GEAR;
	const V=sc.V, S=sc.S, Vh=Math.sqrt(Math.max(V*V-S*S,1)), D=Math.max(500,V*9);   // ~9 s of approach
	ownship.pos.set(T.x-d.x*D, T.y+S*(D/Vh), T.z-d.z*D);
	const fwd0=d.clone(), right0=new THREE.Vector3().crossVectors(fwd0,world_up).normalize(), up0=new THREE.Vector3().crossVectors(right0,fwd0).normalize();
	const q=new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(fwd0,up0,right0));
	q.premultiply(new THREE.Quaternion().setFromAxisAngle(right0,(sc.pitch||0)*D2R)); q.premultiply(new THREE.Quaternion().setFromAxisAngle(fwd0,(sc.bank||0)*D2R));
	const vd=new THREE.Vector3(d.x*Vh,-S,d.z*Vh).normalize();
	ownship.q.copy(q); ownship.vel_dir.copy(vd); ownship.speed=V; ownship.throttle=0;
	ownship.gearTarget=sc.gearup?1:0; ownship.gear=ownship.gearTarget; ownship.hookTarget=sc.hook?1:0; ownship.hook=ownship.hookTarget;
	ownship.launching=false; ownship.trapped=false; ownship.wire=0; ownship.touch=null; ownship.grounded=false;
	ownship.pass={gs:0,az:0,n:0}; ownship.waved=false;
	test_active={ name:sc.name, q:q.clone(), vd:vd.clone(), V, t0:sim_time, bolter:!!sc.bolter, touchY:T.y, carrier:!!sc.carrier }; dev_peakbank=0; dev_pitchhi=0; dev_pitchlo=0;
	flight_push();
}
function test_handoff(t){   // the scenario's outcome is decided: hand the jet back with the right hands on the controls
	test_active=null; test_idle=sim_time+60;   // rollout grace: the scripted pilot rides the brakes to a stop (a hands-off free roll ran off into the sea)
	if(t.bolter){ _test_power=0.95; ownship.throttle=0.95; ownship.burner=0; }   // a bolter goes to MIL power and flies off the bow — no brakes (_test_power gates them off)
	test_brake=!t.carrier && !t.bolter;   // grace-brake only on a RUNWAY rollout: on the carrier the wire (or the bolter's power) stops the jet, and braking the just-touched wheels for the frame before the wire catch registers grabbed asymmetrically and banked the arrest (#72 low-fps trap)
}
function test_drive(){   // hold the prescribed approach exactly; hand control back the moment the outcome is decided
	const t=test_active;
	if(crash_t>0 || ownship.trapped || (ownship.touch && ownship.touch.t>=t.t0)){ test_handoff(t); return; }   // this branch fires a frame before the state checks below (the verdict path records the touch first) — it must ALSO start the rollout grace
	const b=flight_get();   // hold the prescribed approach exactly; position integrates in the core
	if(b[STATE.wow]>0.5 || b[STATE.contact]>=0 || b[STATE.touch]>0.5){ test_handoff(t); return; }
	// EARLY RELEASE ~1.5 m up, with a CLEAN on-speed state: the settle,
	// touchdown, wire catch and arrest then run as pure core physics, which is
	// frame-rate independent (like a real un-scripted landing). Re-pinning the
	// approach THROUGH the gear/wire engagement fights the physics for a whole
	// frame and resonates with the frame rate — banking the rollout up to ~25°
	// around 15 fps while 60 fps looked clean (#72 trap-topple-at-low-fps).
	if(!t.bolter && t.carrier && ownship.pos.y < t.touchY + 1.5){   // CARRIER only (and not the bolter): the early clean hand-off exists solely to keep the wire/gear re-pin fight off the frame rate (#72). On a runway it just adds ~4 m/s of free-fall sink that trips the strict belly verdict and drops the nose-high tail-strike case flat — runway scenarios release at contact like before. (The bolter must fly its scripted high approach clear over the wires; releasing early with power drops it onto one.)
		b[STATE.velocity]=t.vd.x*t.V; b[STATE.velocity+1]=t.vd.y*t.V; b[STATE.velocity+2]=t.vd.z*t.V;
		b[STATE.attitude]=t.q.w; b[STATE.attitude+1]=t.q.x; b[STATE.attitude+2]=t.q.y; b[STATE.attitude+3]=t.q.z;
		b[STATE.omega]=0; b[STATE.omega+1]=0; b[STATE.omega+2]=0;
		flight_set(b);
		test_handoff(t);
		return;
	}   // the LATCHED touch record too: at low frame rates the strut can contact AND rebound inside one frame, wow reads false again, and the re-pinned sink loads the gear into a real bounce — 28 fps machines bounced, 60 fps machines did not   // wheels on: release IMMEDIATELY — re-pinning the scripted sink into a compressed strut at 60 Hz spring-loaded the gear and bounced every touchdown (#72). The idle grace stops a physical throttle lever from re-powering the rollout
	b[STATE.velocity]=t.vd.x*t.V; b[STATE.velocity+1]=t.vd.y*t.V; b[STATE.velocity+2]=t.vd.z*t.V;
	b[STATE.attitude]=t.q.w; b[STATE.attitude+1]=t.q.x; b[STATE.attitude+2]=t.q.y; b[STATE.attitude+3]=t.q.z;
	b[STATE.omega]=0; b[STATE.omega+1]=0; b[STATE.omega+2]=0;
	flight_set(b);
}
// ============================================================ flight core host glue
// The wasm blade-element core owns the ownship physics; this section feeds it
// the world, delivers state on spawns/resets, and syncs its output back onto
// the ownship object every rendered frame.
const physics_strips=[];   // paved capsules, collected as the airfields build
const FUEL=()=>THREE.MathUtils.clamp((cfg.fuel||10800)/2.2046,500,4900);   // spawn fuel: the menu slider speaks POUNDS like the IFEI, the sim burns kilograms (default full internal, 10,800 lb ≈ 4,900 kg; the START selector seeds the slider per start — recovery cases arrive light, #51)
const BINGO=1361, FUELLO=726;   // kg: the 3,000 lb bingo call and the ~1,600 lb hardware FUEL LO caution
let flight_active=false, control_sequence=0, launch_flag=false, core_catapult=-1, core_stroke=-1, prev_wire=-1, prev_wow=false;
let last_controls=null, marked_steps=0;   // multiplayer prediction: the sample the core flew this frame + fixed steps since the last mark
const render_offset=new THREE.Vector3();  // reconciliation discontinuity, decayed on ownship.group only (~150 ms)
function flight_world(){
	// Multiplayer must mirror the SERVER's world exactly (sea-only, the match
	// seed and wrap) — a client-side carrier the server doesn't simulate would
	// poison prediction; deck operations stay single-player for now.
	if(MULTIPLAYER) return { aircraft:own_aircraft(), environment:{ seed:(net&&net.welcome&&net.welcome.seed)||1, wrap:(net&&net.wrap)||WORLD_WRAP, cheat:{ fuel:cheat("fuel") } }, world:{ sea:3 } };   // the prediction core must freeze the tank exactly as the server does, or fuel drift feeds the corrections forever
	const fields=[{ height:ISLAND_H+AIRFIELD_FLOAT, strips:physics_strips.map(c=>({ a:{x:c.a[0], z:c.a[1]}, b:{x:c.b[0], z:c.b[1]}, width:c.w })) }];
	for(const is of obstacles.islands) fields.push({ height:ISLAND_H, coast:is.pts.map(q=>({x:q[0], z:q[1]})) });
	const carrier={ position:{x:CARRIER.x, y:CARRIER.deckY, z:CARRIER.z}, heading:CARRIER_YD, speed:0,
		deck:SHIP.outline.map(q=>({x:q[0], z:q[1]})),
		catapults:SHIP.shuttles.map(c=>({ position:{x:c.x, y:0, z:c.z}, heading:c.h*D2R, stroke:SHIP.stroke, speed:SHIP.speed })),   // shuttles ARE the nose-gear points — the core's native convention
		wires:SHIP.wires.map(fa=>({ a:{x:fa+SHIP.halfspan*STRIP_ULAT, y:0, z:strip_lat(fa)-SHIP.halfspan*STRIP_UFA}, b:{x:fa-SHIP.halfspan*STRIP_ULAT, y:0, z:strip_lat(fa)+SHIP.halfspan*STRIP_UFA} })) };   // pendants span SQUARE TO THE LANDING STRIP, as a real angled deck rigs them (the hook crosses them perpendicular on rollout); ship-axis-aligned wires skewed the catch geometry. NOT the topple fix — that was the world-side wing-leveler (#72 scenario 9) — but correct regardless
	const cl=CLOUDS[cfg.clouds];
	const cloud=(cl&&cl.flat<0.5)?{ base:cl.base, top:cl.top, high:cl.high, convective:1, gate:{ minimum:cl.gate[0], maximum:cl.gate[1] } }:undefined;   // #122: convective presets bump and lift; stratiform decks are STABLE air and stay deliberately smooth
	// Wind (#44): ~25 kt from 070° — the Midway trades the deck already faces
	// (yaw:20 aims the bow into them). This single key activates the whole of
	// flight/wind.go — shear, veer, gusts, and the carrier burble — which had
	// never run: Environment.Wind was assigned nowhere. Vector points WHERE
	// THE AIR MOVES: from 070° means toward 250°, i.e. -x*sin(70°),+z... the
	// core's frame has -z north, so blowing-toward-250° is x=-sin(250°+180°)…
	// measured empirically instead: HUD wind arrow and drift on the 070° bow
	// must read a HEADWIND on deck. 12.9 m/s ≈ 25 kt.
	let wind={ x:-12.9*Math.sin(70*D2R), z:12.9*Math.cos(70*D2R) };   // blowing FROM 070 toward 250 in the world frame (x east, z south)
	if(DEV_MODE){ const w=new URLSearchParams(location.search).get("wind"); if(w!==null){ const knots=parseFloat(w)||0; const scale=knots*0.5144/12.9; wind={ x:wind.x*scale, z:wind.z*scale }; } }   // &wind=<knots> (0 = calm) — headless A/B isolation of wind effects (#44)
	return { aircraft:cfg.aircraft||"fa18c", environment:{ seed:1, wrap:WORLD_WRAP, cloud, wind, cheat:{ fuel:cheat("fuel") } }, world:{ sea:0, fields, carrier } };
}
function sync_core(out){   // core state -> the ownship object every consumer reads (HUD, cameras, weapons, LSO)
	ownship.pos.set(out[STATE.position],out[STATE.position+1],out[STATE.position+2]);
	ownship.q.set(out[STATE.attitude+1],out[STATE.attitude+2],out[STATE.attitude+3],out[STATE.attitude]);
	ownship.fwd.set(1,0,0).applyQuaternion(ownship.q); ownship.up.set(0,1,0).applyQuaternion(ownship.q); ownship.right.set(0,0,1).applyQuaternion(ownship.q);
	ownship.velx=out[STATE.velocity]; ownship.vely=out[STATE.velocity+1]; ownship.velz=out[STATE.velocity+2];
	ownship.speed=Math.hypot(ownship.velx,ownship.vely,ownship.velz);
	if(ownship.speed>0.5) ownship.vel_dir.set(ownship.velx/ownship.speed,ownship.vely/ownship.speed,ownship.velz/ownship.speed); else ownship.vel_dir.copy(ownship.fwd);
	ownship.aoa=out[STATE.alpha]*180/Math.PI; ownship.gload=out[STATE.nz]; if(ownship.gload>peak_g) peak_g=ownship.gload;   // sticky peak g for the NATOPS readout (#133)
	{ const beforeInternal=ownship.fuel??1e9, beforeTotal=beforeInternal+(ownship.external??0);   // the tank state, for the IFEI readout and the calls (the infinite-fuel cheat freezes it inside the core: environment.cheat.fuel)
		ownship.fuel=out[STATE.fuel]; ownship.external=out[STATE.external]||0;
		const total=ownship.fuel+ownship.external;
		if(!cheat("fuel")){   // a frozen tank makes the fuel calls meaningless — a light spawn load would otherwise call BINGO at mission start
			if(beforeTotal>=BINGO&&total<BINGO) notice(translate("BINGO FUEL"));   // BINGO is a total-fuel caret (#17: externals count — they burn first, so total is what endurance means)
			if(beforeInternal>=FUELLO&&ownship.fuel<FUELLO) notice(translate("FUEL LO")); } }   // FUEL LO stays an INTERNAL caution: the hardware watches the feed tanks, and externals cannot refill a dry feed
	ownship.cas=out[STATE.cas];   // calibrated airspeed, m/s — the real jet's HUD speed source
	ownship.spool=out[STATE.power]; ownship.stage=out[STATE.stage];   // achieved across the airframe's engines, computed core-side
	ownship.reheats=[out[STATE.engine+1]*(1-Math.min(1,out[STATE.engine_harm]||0)), out[STATE.engine+3]*(1-Math.min(1,out[STATE.engine_harm+1]||0))];   // per-engine achieved reheat, health-weighted (#41): a dead engine's flame disc stops and its nozzle glow dies with it
	ownship.gear=1-out[STATE.extension]; ownship.speedbrake=out[STATE.speedbrake];
	ownship.surfaces={ stabL:out[STATE.stabilator], stabR:out[STATE.stabilator+1], flapL:out[STATE.flaperon], flapR:out[STATE.flaperon+1], rudder:out[STATE.rudder], slat:out[STATE.slat] };   // live FCS deflections, rad — the rig scrubs surfaces from these
	update_gauges(out);   // cockpit instruments (#99)
	recording_sample();
	screens_update();
	ownship.grounded=out[STATE.wow]>0.5;
	core_catapult=out[STATE.catapult]; core_stroke=out[STATE.stroke];
	if(core_catapult>=0 && core_catapult<SHIP.shuttles.length) cat_idx=core_catapult;   // the active cat follows whichever shuttle the crew hooked you onto — without this, taxiing to another cat towed the wrong shuttle mesh
	ownship.launching=core_catapult>=0&&core_stroke>=0;
	const wire=out[STATE.wire];
	if(wire>=0&&prev_wire<0){ ownship.trapped=true; ownship.wire=wire+1; ownship.grade=lso_grade(); ownship.turned=false; ownship.taxied=false; notice(translate(ownship.grade)+", "+translate(ownship.wire+" WIRE"), 8); }
	if(ownship.trapped&&!ownship.turned&&ownship.speed<0.5){ ownship.turned=true;   // chocked and chained: the deck crew turn the jet around and service it (#128)
		ownship.rounds=MAGAZINE; ownship.msl=magazine(); ownship.cm=60; update_rails(ownship,ownship.msl);
		const b=flight_get(); b[STATE.fuel]=FUEL(); b[STATE.external]=external_capacity(); flight_set(b); }   // the deck crew top the externals too — every spawn and service is a full-tank fill (#17)
	if(ownship.turned&&!ownship.taxied&&ownship.speed>4){ ownship.taxied=true; notice(translate("REARMED")); }   // announce the rearm only once the player TAXIES clear of the trap — so it never lands on top of the LSO grade at the stop (#72)   // end the LSO grade banner so REARMED replaces it cleanly instead of overprinting it (#72)
	else if(wire<0&&prev_wire>=0){ ownship.trapped=false; }
	prev_wire=wire;
	// Airfield service: a full stop on the paved strip after a flight brings
	// the ground crew — the carrier trap's choreography (service at the stop,
	// REARMED announced through the same taxi-away line above). The flown gate
	// keeps a runway spawn from being "serviced" it never needed; it re-arms
	// only after genuinely flying again. Multiplayer has no airfields (and
	// physics_strips stays empty there), so this is single-player by nature.
	if(!ownship.grounded && ownship.speed>50) ownship.flown=true;
	if(ownship.flown && ownship.grounded && !ownship.trapped && ownship.speed<0.5 && on_strip(ownship.pos)){
		ownship.flown=false; ownship.turned=true; ownship.taxied=false;
		ownship.rounds=MAGAZINE; ownship.msl=magazine(); ownship.cm=60; update_rails(ownship,ownship.msl);
		const b=flight_get(); b[STATE.fuel]=FUEL(); b[STATE.external]=external_capacity(); flight_set(b); }
}
function on_strip(p){   // point inside any paved capsule (the airfield strips; the carrier deck is not one)
	for(const c of physics_strips){ const dx=c.b[0]-c.a[0], dz=c.b[1]-c.a[1], len=dx*dx+dz*dz;
		const t=len>0?THREE.MathUtils.clamp(((p.x-c.a[0])*dx+(p.z-c.a[1])*dz)/len,0,1):0;
		const qx=c.a[0]+dx*t, qz=c.a[1]+dz*t, w=(c.w||0)/2+5;   // +5 m shoulder: stopping with the mains on the paint but the reference point off it still counts
		if((p.x-qx)*(p.x-qx)+(p.z-qz)*(p.z-qz)<=w*w) return true; }
	return false;
}
function flight_push(){   // deliver the ownship pose to the core: trimmed level flight when airborne, a composed state on the ground / in a test
	if(!flight_active) return;
	prev_wire=-1;
	ownship.flown=false;   // a fresh spawn has not flown: no phantom airfield service (a respawn already carries a full load)
	if(!test_active && !ownship.grounded && mission_start()==="case2"){
		// The CORE owns approach trim (#158). On-speed is a wing condition, so the
		// speed, the attitude and the power all follow from the weight and the
		// droop schedule — carrying them here as measured constants is what let
		// the old landing start go stale under the flight core and balloon off
		// the glideslope. The client supplies only where and which way. Case II
		// trims LEVEL (slope 0): established at 1,200 ft on the final bearing,
		// the glideslope intercept ~3 nm ahead is the pilot's to fly (CV-1).
		ownship.throttle=flight_approach(ownship.pos.x,ownship.pos.y,ownship.pos.z, ownship.fwd.x,ownship.fwd.z, 0, FUEL());
		sync_core(flight_get()); return;
	}
	if(!test_active && ownship.speed>50 && !ownship.grounded){
		flight_level(ownship.pos.x,ownship.pos.y,ownship.pos.z, ownship.fwd.x,ownship.fwd.z, ownship.speed, FUEL());   // trimmed CLEAN level flight — right for air starts, but it threw away the landing start's composed on-speed pose (the PA law then wrestled a clean trim onto approach alpha: nose-down lurch, dead stick)
		{ const entry=mission_start();
			if(entry==="case1"||entry==="case3"){   // pattern and marshal entries HOLD their entry speed: command the power the core just solved, or the spawn's high default spools back up and the jet runs away from 350/250 kt (the free-flight air start keeps its power-on feel). (spool − idle)/(1 − idle) inverts the propulsion idle floor (0.04) back to a lever position
				const trimmed=flight_get(); ownship.throttle=Math.max(0,Math.min(1,(trimmed[STATE.engine]-0.04)/0.96)); } }
		sync_core(flight_get()); return;
	}
	const b=flight_get();   // keep time (carrier pose, wind field) and fuel across resets
	// ...but NEVER the damage block: every flight_push call site is a fresh-airframe moment
	// (mission start, cat re-spot, scenario, respawn), and recycling the snapshot carried the
	// crashed jet's damage into the respawn — folded gear with red cautions at the threshold,
	// and worse, silent engine thrust loss + fuel leak (the client visuals reset, the core
	// words didn't). Air starts were immune only because flight_level builds a fresh state.
	for(let i=STATE.engine_harm;i<=STATE.stress;i++) b[i]=0;   // engine harm ×4, leak, drag, shift ×3, stress
	for(let i=STATE.element;i<=STATE.gear_harm+2;i++) b[i]=0;   // element losses ×40, jams ×8, shed mass, gear struts ×3
	if(ownship.speed<1){ const g=ground_height(ownship.pos.x,ownship.pos.z);   // ground spawns: rest the wheels ON the surface — legacy spawn heights assume the old glue, and an interpenetrated spawn fires the bottomed-out struts like a mortar
		if(g>-1e8) ownship.pos.y=Math.max(ownship.pos.y,g+GEAR); }
	b[STATE.position]=ownship.pos.x; b[STATE.position+1]=ownship.pos.y; b[STATE.position+2]=ownship.pos.z;
	b[STATE.velocity]=ownship.vel_dir.x*ownship.speed; b[STATE.velocity+1]=ownship.vel_dir.y*ownship.speed; b[STATE.velocity+2]=ownship.vel_dir.z*ownship.speed;
	b[STATE.attitude]=ownship.q.w; b[STATE.attitude+1]=ownship.q.x; b[STATE.attitude+2]=ownship.q.y; b[STATE.attitude+3]=ownship.q.z;
	b[STATE.extension]=(ownship.gearTarget??0)<0.5?1:0;   // the core's gear matches the spawn configuration immediately — a landing start otherwise spends its first seconds extending (flaps absent, trim shifting)
	b[STATE.omega]=0; b[STATE.omega+1]=0; b[STATE.omega+2]=0;
	if(b[STATE.time]===0 || b[STATE.fuel]<500){ b[STATE.fuel]=FUEL(); if(stores_book) b[STATE.external]=external_capacity(); }   // a NEVER-STEPPED core boots with the airframe's full 4,900 kg tank — without the time gate the menu's fuel load never reached ground starts (carrier/runway read 10,800 lb whatever the slider said); mid-mission resets still keep their burned-down tank. Externals mount full (#17): the same push seeds the tanks, but ONLY once the catalog is readable — an early push wrote a not-yet-derivable 0 OVER the fill the mask transition had already made, and no transition remained to refill it (the EXT 0 carrier boots)
	b[STATE.engine]=ownship.throttle; b[STATE.engine+1]=0; b[STATE.engine+2]=ownship.throttle; b[STATE.engine+3]=0;
	for(let i=STATE.stabilator;i<=STATE.normal;i++) b[i]=0;   // surfaces + controller memories
	b[STATE.demand]=1; b[STATE.normal]=1;
	b[STATE.extension]=(ownship.gearTarget??0)<0.5?1:0;
	b[STATE.catapult]=-1; b[STATE.stroke]=-1; b[STATE.wire]=-1;
	b[STATE.wow]=0; b[STATE.contact]=-1;
	b[STATE.touch]=0; b[STATE.touch+1]=0; b[STATE.touch+2]=0; b[STATE.touch+3]=0;
	flight_set(b); sync_core(flight_get());
}
function verdict(out){   // judge the core's touchdown record: crash conditions end the pass; survivable touches just record the numbers for the LSO
	const sink=Math.max(0,out[STATE.touch+1]), bank=Math.abs(out[STATE.touch+2]), kind=out[STATE.touch+3];
	const deck=kind===3, soft=kind===2;
	const pitch=Math.asin(THREE.MathUtils.clamp(ownship.fwd.y,-1,1));
	ownship.touch={ sink, bank, t:sim_time, deck, fa:deck?carrier_fore_aft(ownship.pos.x,ownship.pos.z):0 };
	const die=()=>{ ownship.group.position.copy(ownship.pos); crash_ownship("verdict"); return true; };
	if(deck && ownship.touch.fa<-134) return die();                   // ramp strike: caught the round-down at the stern
	if(out[STATE.extension]<0.5){                                     // belly arrival: survivable only feather-soft and level — but judged at FLYING speed: the core now lets a slide settle its nose and rest a wingtip below 20 m/s (ground handling, not a crash)
		if(ownship.speed>20 && (sink>2 || bank>0.09 || pitch>0.21 || pitch<-0.04)) return die();
	} else {
		if(ownship.speed>105) return die();                           // far above the tire limits (~200 kt)
		if(bank>0.17) return die();                                   // wingtip strike (~10°)
		if(pitch>0.26) return die();                                  // tail strike (~15° nose-up)
		const firm=soft?4:9;                                          // structural sink limit; soft ground digs in sooner
		if(sink>firm*1.6) return die();
		if(soft && ownship.speed>55) return die();                    // fast touchdown off-pavement digs the wheels in
	}
	return false;                                                     // bounces and rollout are the core's physics, not a verdict
}
function fly_player(dt){
	if(net_waiting){ hud_message(translate("WAITING FOR OPPONENT")); return; }   // joust waiting room: frozen at the ring, no sim, until the server's match-start respawn
	if(crash_t>0||mission_done){ if(MULTIPLAYER){ read_input(dt); return; }   // multiplayer: hold in the fireball until the server's respawn event places us
		// Single player: the crash ENDS the mission (#240) — every task, free
		// flight included. The old silent respawn was worst in a joust, where
		// the victorious bandit stands down and the fresh jet spawned into an
		// EMPTY sky; the menu owns what happens next, with the outcome on it.
		if(!mission_done){ crash_t-=dt;
			if(crash_t<=0){ crash_t=0; mission_done=true;
				if(on_over) on_over({ fate:ownship.fate||"crash", struck:ownship.struck||0, seconds:Math.max(0,sim_time-mission_zero) }); } }
		return; }
	read_input(dt);
	ownship.fwd.set(1,0,0).applyQuaternion(ownship.q); ownship.up.set(0,1,0).applyQuaternion(ownship.q); ownship.right.set(0,0,1).applyQuaternion(ownship.q);
	if(!flight_active){   // bind the core to this mission's world on the first live frame past the loading gate
		if(MULTIPLAYER && !(net&&net.welcome)) return;   // the world payload needs the match seed/wrap from the welcome
		if(!flight_ready()){ if(flight_failure()) notice(translate("FLIGHT CORE FAILED")); return; }
		if(!flight_init(flight_world())){ notice(translate("FLIGHT CORE FAILED")); return; }
		flight_active=true; flight_push();
	}
	if(test_active) test_drive();   // scripted test approach: prescribes attitude + velocity into the core each frame
	const controls={ pitch:THREE.MathUtils.clamp(input.pitch,-1,1), roll:THREE.MathUtils.clamp(input.roll,-1,1), yaw:THREE.MathUtils.clamp(input.yaw,-1,1),   // RAW stick: cfg.sens used to scale these (the removed Sensitivity slider genuinely was a flight-control gain — a saved sens!=1 silently rescaled the whole stick)
		throttle:ownship.throttle, speedbrake:ownship.speedbrakeTarget??0,
		reheat:ownship.burner??0, brake:input.brake || (sim_time<test_idle && test_brake && !ownship.wire),   // scenario rollout: the scripted pilot rides the brakes only on a runway (test_brake); the carrier's wire and the bolter's power stop the jet instead (a hands-off free roll ran 1.4 km off the runway end into the lagoon) — but NEVER on a wire: locked mains under the 3 g runout slammed the nose and rolled the trap over (the live-traced 37-degree topple)
		gear:(ownship.gearTarget??0)<0.5, hook:(ownship.hookTarget??0)>0.5, probe:(ownship.probeTarget??0)>0.5,
		trim:input.trim||0, lean:input.lean||0, reset:reset_flag, flap:flap_select,
		launch:launch_flag, override:keys.has(key_of("override"))&&!(DEV_MODE&&on_ground()),
		dump:fuel_dump, port:secured[0], starboard:secured[1], sequence:++control_sequence };
	flight_stores(own_mask());   // the flown loadout follows the magazine every frame (idempotent): firing sheds each round's mass and carriage drag in the core in the SMS order; respawns re-arm through the same line, and a tank bit's off-to-on transition fills it (#17)
	const out=flight_frame(controls,dt);
	if(flight_steps.value>0){ launch_flag=false; reset_flag=false; }   // the edges were consumed by the core
	last_controls=controls; marked_steps+=flight_steps.value;
	sync_core(out); last_out=out;
	emergency_update(dt, keys.has(key_of("jettison.emergency")));   // #18: the held striped button — pairs release while held
	carriage_update(dt); falling_update(dt);
	if(!MULTIPLAYER){   // SP damage cascade: fires, fuses, sheds — judged by the same Go as the server
		if(harm_pending&&battle_tick>2){ apply_harm(harm_pending); harm_pending=null; }   // frame-gated: headless captures render only a handful of frames
		if(livery_pending&&model_active){ apply_livery(ownship.group,livery_pending); apply_livery(bandit.group,livery_pending==="red"?"blue":"red"); livery_pending=null; }
		if(sweep_pending&&ownship.group.userData.rig){ const i=ownship.group.userData.rig.findIndex(r=>r.name===sweep_pending);
			if(i>=0){ rig_sweep=i+1; } sweep_pending=null; }
		if(!battle_rigged) battle_rig();   // the mission-start rig raced the wasm load and no-opped: retry until it takes
		// Fly the airborne gun rounds one step (#real-TOF): arrivals are judged
		// against where everyone IS this frame, so a break after the trigger is
		// a real defence. Sparks land where ownship rounds strike the bandit;
		// the flash and thud are the bandit's rounds arriving on us.
		{ const flown=battle_fly(Math.min(dt,0.1), !!cheat("invulnerable"), (has_enemy&&bandit.group.visible)?battle_aim(bandit):null);
			for(const p of flown.impacts){ const w=_v.set(p.x,p.y,p.z).applyQuaternion(bandit.group.quaternion).add(bandit.group.position);
				hit_sparks(w.x,w.y,w.z,bandit.velx??bandit.fwd.x*bandit.speed,bandit.vely??bandit.fwd.y*bandit.speed,bandit.velz??bandit.fwd.z*bandit.speed,bandit,p); }
			if(flown.own>0){ hit_flash=Math.min(1,hit_flash+0.25*flown.own); audio_hit(Math.min(flown.own,4)); }
			ownship.struck=(ownship.struck||0)+flown.own; bandit.struck=(bandit.struck||0)+flown.bandit; }   // cumulative rounds taken, for the recording (#238): the total survives 10 Hz sampling losslessly
		const battle=battle_progress(ownship.throttle,battle_tick++,battle_reset,(secured[0]?1:0)|(secured[1]?2:0)); battle_reset=false;
		own_burn[0]=battle[0]; own_burn[1]=battle[1]; own_burning=battle[2]>0; own_leak=battle[5];
		if(has_enemy){ const h=bandit.harm; h.thrust=battle[11]; h.wing=battle[12]; h.killed=battle[9]>0; h.burning=battle[8]>0;
			h.fire=[battle[6]||0,battle[7]||0]; h.leak=battle[14]||0;   // per-engine fire intensity (always exported, never read until #244) and the hulk leak (new wasm row)
			h.wreck=battle[13]; if(h.killed&&!bandit.fate) bandit.fate="pilot";
			if(battle[10]&BATTLE.explode){ own_kills++; bandit_destroy(); } }
		if(has_enemy&&bandit.group.visible){ const rdx=bandit.pos.x-ownship.pos.x, rdy=bandit.pos.y-ownship.pos.y, rdz=bandit.pos.z-ownship.pos.z;
			const range=Math.hypot(rdx,rdy,rdz)||1;
			const closure=-((bandit.velx-ownship.velx)*rdx+(bandit.vely-ownship.vely)*rdy+(bandit.velz-ownship.velz)*rdz)/range;
			audio_remote("bandit", bandit.pos.x, bandit.pos.y, bandit.pos.z, closure, false); }
		burn_trail(ownship.pos,Math.max(own_burn[0],own_burn[1],own_burning?1:0),ownship.velx,ownship.vely,ownship.velz);
		if(own_leak>0.05) leak_trail(ownship.pos,own_leak,ownship.velx,ownship.vely,ownship.velz);
		if(battle[4]&BATTLE.explode){ ownship.grade=""; return crash_ownship("fire"); }   // the fuel fire's fuse ran out
		if(battle[3]>0&&crash_t<=0){ notice(translate("PILOT DOWN")); return crash_ownship(); }
	}
	if(weapons_hold&&!MULTIPLAYER&&has_enemy){   // SP merge check (#87): either jet crossing the other's 3/9 line frees the weapons (mirrors the server's rule)
		const rx=bandit.pos.x-ownship.pos.x, ry=bandit.pos.y-ownship.pos.y, rz=bandit.pos.z-ownship.pos.z;
		const ownBehind=-(rx*bandit.fwd.x+ry*bandit.fwd.y+rz*bandit.fwd.z)< -5;   // own position in the bandit's frame: -rel·fwd
		const banditBehind=(rx*ownship.fwd.x+ry*ownship.fwd.y+rz*ownship.fwd.z)< -5;
		if(ownBehind||banditBehind){ weapons_hold=false; notice(translate("FIGHT'S ON")); } }
	if(hit_flash>0) hit_flash=Math.max(0,hit_flash-dt*2.2);
	{ // audio (#73): continuous voices track the core; edges fire one-shots
		const harmL=last_out?last_out[STATE.engine_harm]:0, harmR=last_out?last_out[STATE.engine_harm+1]:0;
		audio_frame({ spool:ownship.spool||0, stage:ownship.stage||0, speed:ownship.speed||0, alpha:ownship.aoa||0,
			wow:!!ownship.grounded, burn:Math.max(own_burn[0],own_burn[1],own_burning?1:0), harm:[harmL,harmR] });
		audio_gun(!!(input.guns&&!ownship.launching&&(ownship.gear??0)>0.98&&ownship.rounds>0));
		if(ownship.launching&&!audio_prev.launching) audio_catapult();
		if(ownship.trapped&&!audio_prev.trapped) audio_trap();
		if(ownship.grounded&&!audio_prev.grounded&&!ownship.trapped&&ownship.speed>30) audio_touchdown();
		audio_horn((ownship.gearTarget??0)>0.5&&ownship.pos.y<300&&ownship.speed<95&&!ownship.grounded&&!ownship.launching);
		{ const g=ground_height(ownship.pos.x,ownship.pos.z); const agl=(ownship.pos.y-(g>-1e8?Math.max(g,0):0))*3.28084;   // radar-altimeter low-altitude warning: descending through 250 ft AGL clean — the "altitude, altitude" moment; the gear coming down declares the descent deliberate
			const sink=-(ownship.vely??0);   // m/s down
			// The warning was GEAR-GATED: on approach it called descending through
			// 250 ft, and in a fight — gear up — it said NOTHING; the pilot flew a
			// padlocked jet into the sea in silence. Gear up, a fixed bug is also
			// the wrong shape (a fast dive blows through any height before the
			// call helps), so the clean trigger is ground CLOSURE: about six
			// seconds from impact at the current sink, floored at 300 ft and
			// capped at the 5,000 ft training hard deck.
			const dirty=(ownship.gearTarget??0)>0.5&&agl<250&&sink>2;
			const closure=(ownship.gearTarget??0)<=0.5&&sink>10&&agl<Math.min(5000,Math.max(300,sink*3.28084*6));
			law_active=(dirty||closure)&&!ownship.grounded&&!ownship.launching&&crash_t<=0;
			if(law_armed&&law_active) { audio_law(); }   // repeats while below the index (#47) — it played once and went silent for the rest of the descent
			else if(agl>400&&!law_active) law_armed=true; }
		cautions_update();   // #47: keyed, view-independent — the tone lives HERE, not in draw_hud
		audio_prev.launching=!!ownship.launching; audio_prev.trapped=!!ownship.trapped; audio_prev.grounded=!!ownship.grounded;
	}
	if(out[STATE.contact]>=0){ flight_clear(); ownship.group.position.copy(ownship.pos); return crash_ownship("probe"); }   // crash probe: any non-permitted airframe contact
	if(out[STATE.touch]>0.5){ const crashed=verdict(out); flight_clear(); if(crashed) return; }
	if(sim_time<test_idle && out[STATE.wow]<0.5 && out[STATE.velocity+1]>1){ test_idle=0; _test_power=0; }   // climbing away (a bolter): end the rollout grace — the pilot needs the throttle back
	// bolter: hook down, touched the deck this pass, airborne again without a wire
	if(prev_wow&&!ownship.grounded&&!ownship.trapped&&(ownship.hookTarget??0)>0.5&&ownship.touch&&ownship.touch.deck&&(sim_time-ownship.touch.t)<8&&ownship.speed>30){ ownship.grade="BOLTER"; notice(translate("BOLTER"), 6); }
	prev_wow=ownship.grounded;
	ownship.group.quaternion.copy(ownship.q); ownship.group.position.copy(ownship.pos);
	if(MULTIPLAYER && render_offset.lengthSq()>1e-8){ render_offset.multiplyScalar(Math.max(0,1-dt*7)); ownship.group.position.add(render_offset); }   // the correction shows as a ~150 ms visual decay, never a physics change
	check_collisions();
}
// bandit_wrecked: the bandit against the same world the PLAYER is checked
// against — terrain height, buildings, masts, the deck — not just a flat sea
// line. The client owned obstacle collision for the ownship alone, so a bot
// could fly through an island, a hangar or the carrier island untouched while
// the same geometry killed the player instantly.
function bandit_wrecked(){
	const p=bandit.pos;
	const floor=ground_height(p.x,p.z);
	if(p.y<=(floor>-1e8?floor+2:6)) return true;   // terrain, deck, runway, apron — or open sea, which reports no surface
	for(const b of obstacles.buildings){ if(p.y<b.topY+2 && p.x>b.minx&&p.x<b.maxx&&p.z>b.minz&&p.z<b.maxz && pip(p.x,p.z,b.pts)) return true; }
	for(const m of obstacles.posts){ if(p.y<m.y1 && Math.hypot(p.x-m.x,p.z-m.z)<m.r+4) return true; }
	if(carrier_model && p.y<80 && Math.abs(p.x-CARRIER.x)<160 && Math.abs(p.z-CARRIER.z)<160){
		const h=deck_y_at(carrier_model,p.x,p.z,-1e9);   // the flat deck is a landing surface (the height check above owns it); only the taller superstructure is an obstacle
		if(h>CARRIER.deckY+4 && p.y<h) return true; }
	return false;
}
function fly_bandit(dt){
	// The sea finishes a bandit whichever brain is flying it. This check lived
	// only in the STRICKEN path, so a healthy bandit that flew itself into the
	// water was caught nowhere — and the flight core has no ground, so it just
	// kept descending for the rest of the mission. One recorded joust had it
	// 81 km below sea level four minutes later, still reporting "cruise", with
	// the target box pointing dutifully straight down while the player hunted
	// for it at twenty feet. Counted as the player's kill, as the stricken
	// path counts it: flying an opponent into the ground is a kill.
	if(bandit_wrecked()){ own_kills++; bandit_destroy(); return; }
	if(bandit.harm&&(bandit.harm.killed||bandit.harm.wing>0.5)) return fly_bandit_stricken(dt);
	if(!bandit_brain&&cfg.task==="joust"&&flight_ready()&&!fly_bandit.tried){   // lazy: the core loads async and start_mission races it — arm the brain on the first frame the core is ready
		fly_bandit.tried=true;
		bandit_brain=bandit_init({ level: cfg.bandit||"ace", seed: 7, wrap: WORLD_WRAP, sky: cfg.clouds||"", night: cfg.tod==="night", missiles: missiles_on() });   // missiles: what the PLAYER can fire (the joust rule: loading any missile arms the fight) — the bandit's defensive doctrine reacts to it (#211 flare gate)
		if(bandit_brain) bandit_spawn(bandit.pos, {x:bandit.fwd.x*bandit.speed, y:0, z:bandit.fwd.z*bandit.speed});
	}
	if(bandit_brain){   // the wasm brain: mirror the player in, step the second core, read the bandit back (#125 phase 2)
		bandit_mirror(flight_get(), input.guns, crash_t<=0);
		const shots=[]; for(const m of missiles){ if(m.active&&m.target===bandit&&shots.length<36) shots.push(m.px,m.py,m.pz,m.vx,m.vy,m.vz); }
		bandit_menace(shots);
		// The brain advances fixed 1/60 s frames: run it through an accumulator like
		// the flight core, not once per render frame — per-frame stepping scaled the
		// bandit's SIM SPEED with the display (double speed at 120 Hz, slow motion
		// below 60) and fed the missiles' LOS-rate measurement fixed-step position
		// jumps over variable render dt, tripping the seeker's track ceiling at
		// ranges where the true rate was a tenth of the limit.
		bandit_acc+=Math.max(0,dt); let count=Math.floor(bandit_acc*60);
		if(count>8){ count=8; bandit_acc=0; }   // a long stall: drop the debt rather than fast-forward (the flight core's rule)
		else bandit_acc-=count/60;
		let step=null, pulled=false, popped=false;
		for(let s=0;s<count;s++){ const one=bandit_step(); if(!one) break; step=one; pulled=pulled||one.fire; popped=popped||one.flare; }
		if(step){
			const w=step.state; step.fire=pulled; step.flare=popped;

			bandit.pos.set(w[0],w[1],w[2]);
			bandit.velx=w[3]; bandit.vely=w[4]; bandit.velz=w[5];
			bandit.speed=Math.hypot(w[3],w[4],w[5]);
			bandit.reheat=Math.max(w[STATE.engine+1],w[STATE.engine+3]);   // achieved reheat: the flare-seduction burner factor reads it
			_q.set(w[7],w[8],w[9],w[6]);   // words are W,X,Y,Z; three.js wants x,y,z,w
			bandit.fwd.set(1,0,0).applyQuaternion(_q);
			// The full basis, same convention as the ownship. The brain bandit
			// flies the real model, so it HAS a roll — but only fwd was read
			// back, leaving body_offset to fall back on a world-up basis (gun
			// hit flashes landed on the wrong part of a rolled airframe) and
			// the recorder to fall back on the kinematic AI's stale scalar
			// bank, which for a brain bandit never updates: every recording so
			// far shows it flying without ever rolling.
			(bandit.up??=new THREE.Vector3()).set(0,1,0).applyQuaternion(_q);
			(bandit.right??=new THREE.Vector3()).set(0,0,1).applyQuaternion(_q);
			bandit.group.quaternion.copy(_q);
			bandit.group.position.copy(bandit.pos);
			if(bandit.merging&&(wrap_distance(bandit.pos,ownship.pos)<500||bandit.fwd.dot(_v.subVectors(ownship.pos,bandit.pos))<0)) bandit.merging=false;   // keep the merge flag honest for the SP weapons hold
			if(step.flare){ dispense_flares(bandit); bandit.flared_at=sim_time; }
			const fired=fire_gun(bandit,ownship,"bandit",dt,step.fire&&!weapons_hold);   // the joust hold binds BOTH jets: the brain may pull its trigger on the run-in, but nothing leaves the barrel before the merge (#87 — the player's trigger has always been gated; the bandit's never was)
			if(fired>0 && !cheat("invulnerable")){ battle_volley(1,battle_pose(bandit),fired,battle_tick); }   // real rounds: arrival, and the hit feedback, come from battle_fly
		}
		return;   // the brain owns the bandit even on a zero-step render frame (above 60 fps most frames step 0 or 1) — falling through would hand those frames to the legacy AI
	}
	bandit.break_t-=dt;
	const to_own=ownship.pos.clone().sub(bandit.pos); const rng=to_own.length();
	if(bandit.merging){   // joust run-in: pure pursuit straight at the player — no weaving — until the pass, then the fight is on
		if(rng<500 || to_own.dot(bandit.fwd)<0){ bandit.merging=false; }
		else { steer(bandit,to_own.clone(),dt,0.3,1.0); apply_orientation(bandit);
			const fired=weapons_hold?0:fire_gun(bandit,ownship,"bandit",dt);   // legacy AI: no head-on gunnery during the run-in — the hold binds both jets
			if(fired>0 && !cheat("invulnerable")){ battle_volley(1,battle_pose(bandit),fired,battle_tick); }   // real rounds: arrival, and the hit feedback, come from battle_fly
			return; }
	}
	const threatened = rng<1800 && ownship.fwd.dot(to_own.clone().multiplyScalar(-1).normalize())>0.5; // ownship pointing at bandit from behind-ish
	if(bandit.break_t<=0){ const a=Math.random()*Math.PI*2; bandit.break_dir.set(Math.cos(a),0,Math.sin(a)); bandit.break_t=threatened?(2+Math.random()*2):(5+Math.random()*5);
		if(threatened){ dispense_flares(bandit); bandit.flared_at=sim_time; } }
	const b=bandit.break_dir.clone(); b.x+=Math.sin(sim_time*0.7)*0.6; b.z+=Math.cos(sim_time*0.9)*0.6;
	if(bandit.pos.length()>5500) b.addScaledVector(bandit.pos.clone().negate().setY(0).normalize(),1.2);
	hold_altitude(b,bandit,1400,3600); steer(bandit,b,dt,threatened?0.5:0.34,1.2); apply_orientation(bandit);
	// bandit guns at ownship: the burst lands in the flight core's damage
	// state, so the jet genuinely flies worse after every hit
	{ const fired=weapons_hold?0:fire_gun(bandit,ownship,"bandit",dt);
		if(fired>0 && !cheat("invulnerable")) battle_volley(1,battle_pose(bandit),fired,battle_tick); }   // real rounds: arrival via battle_fly
}

// Degraded bandit flying: pilot dead = a frozen shallow dive; a lost wing =
// a terminal spiral; thrust loss slows it. The sea finishes each of them.
function fly_bandit_stricken(dt){
	const harm=bandit.harm;
	if(harm.killed){ const d=bandit.fwd.clone(); d.y=-0.15; steer(bandit,d,dt,0.05,0.2); }
	else { const d=bandit.break_dir.clone(); d.y=-0.5; steer(bandit,d,dt,0.9,1.5); bandit.speed=Math.max(120,bandit.speed-30*dt); }   // wing gone: rolling descent
	apply_orientation(bandit);
	// The bandit's wounds render at their true severity (#244): per-engine fire
	// intensity grades the burn from a thin lick to a torching trail (the old
	// binary burned at full blast or not at all), an engine knocked out streams
	// dark machinery smoke even before anything burns, and a holed tank streams
	// the same pale fuel mist the ownship shows. This is the feedback loop the
	// player's gunnery learns from — what a burst DID, readable at a glance.
	burn_trail(bandit.pos,Math.max(harm.fire?harm.fire[0]:0,harm.fire?harm.fire[1]:0,harm.burning?0.7:0,harm.wing*0.9),bandit.velx,bandit.vely,bandit.velz);
	if((harm.thrust||0)>0.06) engine_smoke(bandit.pos,harm.thrust,bandit.velx,bandit.vely,bandit.velz);
	if((harm.leak||0)>0.04) leak_trail(bandit.pos,Math.min(1,harm.leak*3),bandit.velx,bandit.vely,bandit.velz);
}
let rig_sweep=0;   // dev calibration (Shift+A): 0 = off, n = sweep the nth rig entry of the ownship
let stab_cycle=0;   // dev calibration (Shift+E): adds n×90° about the stab hinge so the user can identify the correct orientation
function apply_anim(st){ const g=st.group; if(!g||!g.userData.gearMixer||!g.userData.rig) return;
	const sweeping=(st===ownship&&rig_sweep>0)?g.userData.rig[rig_sweep-1]:null;
	const AXES={ x:new THREE.Vector3(1,0,0), y:new THREE.Vector3(0,1,0), z:new THREE.Vector3(0,0,1) };
	for(const r of g.userData.rig){
		if(r.object){ const surfaces=st.surfaces;
			let v=r.gauge!==undefined ? ((st.gauges&&st.gauges[r.gauge])||0) : ((surfaces&&surfaces[r.drive]!==undefined)?surfaces[r.drive]:0);   // gauges (#99, ownship only) read the instrument channel; no FCS data (remotes): neutral, NOT the GLB rest pose (the C's right stab rests at -50°)
			if((!surfaces||surfaces[r.drive]===undefined)&&(r.drive==="flapL"||r.drive==="flapR")) v=DROOP*(1-THREE.MathUtils.clamp(st.gear??1,0,1));
			if((!surfaces||surfaces[r.drive]===undefined)&&r.drive==="slat") v=SLAT_PA*(1-THREE.MathUtils.clamp(st.gear??1,0,1));   // ...except the trailing-edge flap family: gear down = the PA configuration, drooped 30° (NATOPS flaps HALF on deck), scaled by the drawn gear travel — matching what the FCS commands for the ownship
			if(r.toe) v+=r.toe*(st.squish??0);   // rudder toe-in is a WEIGHT-ON-WHEELS aid: full during the takeoff roll, washing out at liftoff (squish = the smoothed ground-contact signal the oleo squat already uses) — NOT gear-scheduled; a climbing or approaching jet with gear down flies with straight rudders
			if(r.max!==undefined&&v>r.max) v=r.max;   // node-driven caps (one-sided followers like the shroud covers, and the rudders' ±30° throw around the toe)
			if(r.min!==undefined&&v<r.min) v=r.min;
			v*=(r.gain??1);   // instrument throw scaling (#99): track-derived physical throws
			const sweep=(sweeping===r)?(Math.sin(performance.now()/600)-0.5)*0.6:0;
			if(r.trans){ r.object.position.copy(r.position).addScaledVector(r.transDir,(r.sign||1)*(v+sweep)); continue; }   // translation drive: needle carriages (ICLS bars, slip ball)
			const cycle=(st===ownship&&stab_cycle&&(r.drive==="stabL"||r.drive==="stabR"))?stab_cycle*Math.PI/4:0;   // Shift+E calibration offset (45° per step)
			r.object.quaternion.copy(r.quaternion).multiply(new THREE.Quaternion().setFromAxisAngle(AXES[r.axis]||AXES.x, cycle+(r.sign||1)*(v+sweep)));
			continue; }
		if(sweeping===r){ const f=(Math.sin(performance.now()/600)+1)/2; r.action.time=r.t0+f*(r.t1-r.t0); continue; }
		let f;
		switch(r.drive){
		case "gear": { f=1-THREE.MathUtils.clamp(st.gear??1,0,1);   // st.gear: 1 = up; the rig scrubs extension
			const spec=AIRCRAFT_MODELS[g.userData.hasModel];   // weight on wheels: scrub back so the drawn oleo carries the strut compression instead of the tire sinking
			if(spec&&spec.squat) f=Math.max(0, f-spec.squat*(st.squish||0));
			break; }
		case "hook": { f=THREE.MathUtils.clamp(st.hook??0,0,1);
			if(f>0.05){ const surf=ground_height(st.pos.x,st.pos.z); if(surf>-1e8 && st.pos.y<=surf+GEAR+0.6) f=Math.min(f,HOOK_DECK_CAP); }   // claw rests ON the deck, not through it
			break; }
		case "speedbrake": f=THREE.MathUtils.clamp(st.speedbrake??0,0,1); break;
		case "probe": f=THREE.MathUtils.clamp(st.probe??0,0,1); break;
		case "nozzle": { const own=st===ownship;   // F404 exit-area schedule: open at idle, closed by ~70% spool (military), opening again with the reheat stage — so the AB zones read in daylight, not just by glow. The core's slewed spool/stage keep the motion smooth
			const spool=own?(ownship.spool??0.8):0.8, stage=own?(ownship.stage??0):(cfg.afterburner?1:0);
			f=Math.max(THREE.MathUtils.clamp((0.7-spool)/0.55,0,1), THREE.MathUtils.clamp(stage,0,1)); break; }
		case "canopy": f=THREE.MathUtils.clamp(st.canopy??0,0,1); break;
		case "gearlever": f=st===ownship?THREE.MathUtils.clamp(ownship.gearTarget??0,0,1):THREE.MathUtils.clamp(st.gear??1,0,1); break;   // the handle snaps with the SELECTION (travel lags it); authored rest = parked = handle down
		case "hooklever": f=(st.hook??0)>0.05?1:0; break;
		case "flaplever": f=(st===ownship?(ownship.gearTarget??0):(st.gear??1))<0.5?(st.grounded?0.5:1):0; break;   // AUTO up-and-away, HALF on deck (NATOPS takeoff), FULL in the air with gear down
		case "fold": f=THREE.MathUtils.clamp(st.fold??0,0,1); break;
		case "bar": f=THREE.MathUtils.clamp(st.bar??0,0,1)*0.955; break;   // full track-end deployment stabs the tip 5 cm into the deck (measured); 0.955 rests it on the shuttle block instead
		default: { const surfaces=st.surfaces; if(!surfaces||surfaces[r.drive]===undefined){ f=undefined; break; }   // no live FCS data (remotes): hold the rest pose
			f=(surfaces[r.drive]-(r.min??0))/(((r.max??1)-(r.min??0))||1); f=THREE.MathUtils.clamp(f,0,1); } }
		if(f===undefined) continue;
		if(r.flip) f=1-f;
		r.action.time=r.t0+f*(r.t1-r.t0);
	}
	g.userData.gearMixer.update(0);
	if(g.userData.glow&&g.userData.glow.length){ const on=(st===ownship)?!!ownship.lights:(cfg.tod!=="day");   // formation strips + cockpit glow follow the aircraft lights (L toggles the ownship's; others follow day/night)
		for(const mm of g.userData.glow){ const want=on?mm.userData.glowmax:0; if(mm.emissiveIntensity!==want) mm.emissiveIntensity=want; } }
	if(g.userData.burner&&g.userData.burner.length){   // nozzle glow: dark at idle, a dull ember approaching military power, alight with the ACHIEVED reheat stage (the core's ~0.5 s light/quench lag comes free) — no external plume by design
		let want=1.1;   // non-ownship aircraft have no engine core: keep the constant glow as a spotting cue
		if(st===ownship){ const stage=ownship.stage??0, spool=ownship.spool??0;
			want=stage>0.02 ? 0.5+2.5*stage : (spool>0.7 ? (spool-0.7)*0.7 : 0); }
		for(const mm of g.userData.burner){ if(mm.emissiveIntensity!==want) mm.emissiveIntensity=want; } }
	if(g.userData.spin&&g.userData.spin.length){ const d=st.wheelDist??0;
		for(const s of g.userData.spin) s.object.quaternion.copy(s.base).multiply(new THREE.Quaternion().setFromAxisAngle(s.axis, d/s.radius)); }
	if(g.userData.flame&&g.userData.flame.length){ const Z=new THREE.Vector3(0,0,1), a=[st.flameA??0,st.flameB??0], on=st.flameOn||[false,false];
		g.userData.flame.forEach((f2,i2)=>{ f2.object.visible=!!on[i2]; if(on[i2]) f2.object.quaternion.copy(f2.base).multiply(new THREE.Quaternion().setFromAxisAngle(Z,a[i2])); }); }
	const sw=g.userData.swivel;   // nosewheel steering: the same law the core's strut applies (pedal x NWS throw, washing out with ground speed), gated on ground contact
	if(sw){   // ABSOLUTE application from a captured base: the mixer only rewrites the strut pose when the gear-clip time changes, so post-multiplying every frame compounded and the wheel windmilled under alternating pedal
		if(!sw.gear) sw.gear=(g.userData.rig||[]).find(r=>r.name==="gear"&&r.action)||null;
		const gt=sw.gear?sw.gear.action.time:0;
		if(!sw.base||sw.baseTime!==gt){ sw.base=sw.object.quaternion.clone(); sw.baseTime=gt; }
		sw.object.quaternion.copy(sw.base);
		if(Math.abs(st.steer??0)>0.001) sw.object.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(sw.axis,st.steer)); } }   // st.steer = the slewed, authority-blended state from update_anim (LOW 22.5° at taxi, HI near standstill, ~23°/s actuator rate)
function ease_to(cur,tgt,dt){ const d=tgt-cur; return Math.abs(d)>1e-4 ? cur+Math.sign(d)*Math.min(Math.abs(d),GEAR_RATE*dt) : tgt; }
function update_anim(dt){ for(const st of [ownship,bandit]){
	const owned=st===ownship&&flight_active;   // the core's actuators drive ownship gear + speedbrake progress (sync_core); don't ease over them
	const settled=(st===ownship)?(ownship.grounded?1:0):0;   // weight on wheels: the drawn oleo compresses (squat scrub); remotes stay unloaded for now
	st.squish=(st.squish??0)+THREE.MathUtils.clamp(settled-(st.squish??0),-3*dt,3*dt);
	if(!owned){ if(st.gear===undefined) st.gear=st.gearTarget??1; st.gear=ease_to(st.gear,st.gearTarget??1,dt);
		if(st.speedbrake===undefined) st.speedbrake=st.speedbrakeTarget??0; st.speedbrake+=THREE.MathUtils.clamp((st.speedbrakeTarget??0)-st.speedbrake,-1.5*dt,1.5*dt); }   // air-brake ease for the aircraft the core doesn't fly
	if(st.hook===undefined) st.hook=st.hookTarget??0; st.hook=ease_to(st.hook,st.hookTarget??0,dt);
	if(st.probe===undefined) st.probe=st.probeTarget??0; st.probe+=THREE.MathUtils.clamp((st.probeTarget??0)-st.probe,-0.2*dt,0.2*dt);   // refueling probe: ~5 s hydraulic stroke
	if(st===ownship && (st.canopyTarget??0)>0.5 && st.speed>13){ st.canopyTarget=0; notice(translate("CANOPY CLOSING")); }   // the takeoff roll closes an open canopy before the airflow does it destructively
	if(st.canopy===undefined) st.canopy=st.canopyTarget??0; st.canopy+=THREE.MathUtils.clamp((st.canopyTarget??0)-st.canopy,-0.167*dt,0.167*dt);   // ~6 s canopy stroke
	if(st===ownship && (st.foldTarget??0)>0.5 && st.speed>13){ st.foldTarget=0; notice(translate("WINGS SPREADING")); }   // rolling for takeoff spreads folded wings before the airflow rips them
	if(st.fold===undefined) st.fold=st.foldTarget??0; st.fold+=THREE.MathUtils.clamp((st.foldTarget??0)-st.fold,-0.125*dt,0.125*dt);   // ~8 s fold cycle
	if(st===ownship) st.barTarget=(st.launching || ((st.squish??0)>0.5 && ownship.speed<15 && on_cat_spot()>=0))?1:0;   // launch bar drops automatically when the catapult captures the jet (the deck crew the game doesn't have), stays down through the stroke, retracts as the jet flies off or taxis clear — the real bar's retraction IS automatic
	if(st.bar===undefined) st.bar=st.barTarget??0; st.bar+=THREE.MathUtils.clamp((st.barTarget??0)-st.bar,-0.8*dt,0.8*dt);   // ~1.3 s swing
	if(st===ownship){ const pedal=THREE.MathUtils.clamp((input.yaw??0)*cfg.sens,-1,1), sp=st.speed||0;   // nosewheel steering: mirror the core's authority blend (LOW 22.5° at taxi, HI 75° only near standstill), then slew the drawn wheel at an actuator-like rate — the keyboard pedal is bang-bang and an unslewed wheel snaps
		const auth=(22.5+(75-22.5)*THREE.MathUtils.clamp(1-sp/2.5,0,1))*D2R;
		const target=pedal*auth*THREE.MathUtils.clamp(1-sp/60,0.1,1)*(st.squish??0);
		st.steer=(st.steer??0)+THREE.MathUtils.clamp(target-(st.steer??0),-0.4*dt,0.4*dt); }   // ~23°/s — hydraulic, not snappy
	{ const rh=(st===ownship)?(ownship.reheats||[0,0]):[cfg.afterburner?1:0,cfg.afterburner?1:0];   // flame discs churn with each engine's reheat: ~0.5 rev/s at min zone to ~3 rev/s at max
		st.flameA=(st.flameA??0)+(rh[0]>0.02?(0.5+2.5*rh[0])*6.283*dt:0); st.flameB=(st.flameB??0)+(rh[1]>0.02?(0.5+2.5*rh[1])*6.283*dt:0);
		st.flameOn=[rh[0]>0.02, rh[1]>0.02]; }
	{ const rolling=(st===ownship)?(st.squish??0)>0.1:((st.gear??1)<0.1 && st.speed>1);   // wheel spin: on the ground the tires match ground speed; airborne they freewheel down (~2.5 s), and retraction brakes them (real jets auto-brake the wheels in the wells)
		st.wheelSpeed=rolling?st.speed:(st.gear??1)>0.5?0:(st.wheelSpeed??0)*Math.exp(-dt/2.5);
		st.wheelDist=(st.wheelDist??0)+(st.wheelSpeed??0)*dt; }
	apply_anim(st); } }
function step_world(dt){ sim_time+=dt;
	marshal_watch(); pattern_watch();
	fly_player(dt); if(has_enemy) fly_bandit(dt); if(MULTIPLAYER&&net) net_frame(dt);
	const flick=0.6+Math.random()*0.4; const set_ab=(g,on)=>{
		if(g.userData.flames) return;   // this airframe's burner look is its own nozzle glow — no cones, no flame boxes
		g.children.forEach(c=>{ if(c.userData.ab){ c.visible=on; c.scale.z=flick; c.material.opacity=on?0.55+Math.random()*0.35:0; } }); };
	set_ab(ownship.group,cfg.afterburner&&(ownship.stage??(((ownship.burner??0)>0)?1:0))>0.15); set_ab(bandit.group,cfg.afterburner);   // ownship: the ACHIEVED reheat stage (the burner takes ~half a second to light and quench)
	// player guns
	{ const fired=fire_gun(ownship,MULTIPLAYER?null:bandit,"own",dt,input.guns&&!weapons_hold&&!ownship.launching&&(ownship.gear??0)>0.98);   // weapons safe unless the gear is fully up (a weight-on-wheels-style interlock) or before the joust merge; in multiplayer the tracers are local, the damage is the server's
		if(fired>0&&!MULTIPLAYER){ battle_volley(0,battle_pose(ownship),fired,battle_tick); } }
	update_pool_ballistic(tracers,dt,9.8,0,true); update_missiles(dt);
	update_pool_ballistic(flares,dt,9.8,0.985); update_pool_ballistic(smoke,dt,-0.5,0.96); update_pool_ballistic(strikes,dt,9.8,0);   // no drag, exactly as these behaved in the tracer pool: the change here is legibility, not motion
	update_pool_ballistic(debris,dt,9.8,0.998);   // shed panels fall ballistically with a whisper of drag (#239)
	update_transient_fx(dt);
	for(let i=0;i<debris.max;i++){ if(!debris.active[i]||Math.random()>dt*7) continue;   // micro-trail: falling wreckage sheds an occasional thin wisp — the gun-camera frames show each chunk drawing its own faint line
		const k=pool_spawn(smoke); if(k<0) break;
		smoke.px[k]=debris.px[i]; smoke.py[k]=debris.py[i]; smoke.pz[k]=debris.pz[i];
		smoke.vx[k]=debris.vx[i]*0.15; smoke.vy[k]=debris.vy[i]*0.15; smoke.vz[k]=debris.vz[i]*0.15;
		smoke.ttl[k]=smoke.life[k]=1.2+Math.random()*0.8; smoke.sz[k]=0.16; smoke.gr[k]=0.5;
		smoke.r[k]=0.30;smoke.g[k]=0.29;smoke.b[k]=0.28; }
	_live_particles=flush_points(tracers,tr_pts)+flush_points(flares,fl_pts)+flush_points(smoke,sm_pts)+flush_points(strikes,strike_pts)+flush_points(debris,db_pts);
	tr_pts.visible=cfg.tracers; fl_pts.visible=true; strike_pts.visible=true;   // flares are no longer a mission setting (dispensing is always allowed); a strike flash is not a tracer, so it stays on with tracers switched off
	update_anim(dt);
	update_papi(ownship.pos); update_ols(ownship.pos); update_wire_drag(); update_aircraft_lights(); update_shuttles(); update_jbds(dt);
	if(carrier_ols && !ownship.trapped && ((ownship.hook??0)>0.5 || (ownship.gear??1)<0.5)){   // LSO watch: accumulate glideslope/lineup deviation through the in-close portion of a pass, and call the waveoff — the LSO waves off ANY unlandable pass, not just a low one
		const s=ols_dev(ownship.pos,carrier_ols);
		ownship.waving=false;   // current waveoff call (drives the flashing banner); waved is sticky for the pass grade
		if(s.along>2500 || s.along<-70){ ownship.pass={gs:0,az:0,n:0}; ownship.waved=false; ownship.groove=false; }   // outside the pass → fresh slate. The forward bound is -70 m, NOT 0: touchdown and the wire catch happen 0..-30 m past the reference, so resetting at 0 wiped the in-close data the frame before lso_grade() read it — every trap scored NO-GRADE for want of data (#72). A bolter/go-around rolls or flies well past -70 and still resets for the next pass.
		else if(!ownship.grounded && s.dist<1852 && s.along>40){
			const lineup=Math.abs(Math.atan2(s.lat,Math.max(s.along,1)))*180/Math.PI;
			// ESTABLISHED gate: the LSO grades an aircraft in the groove — aligned
			// and at approach speed — not every configured jet in the wedge. The
			// Case I upwind runs up the WAKE, ~9° off the angled centreline and
			// fast, and used to collect "high, lineup — wave off" for the flyby.
			// Sticky once armed, so the drifted-past-6° wave still fires.
			if(!ownship.groove && lineup<5 && ownship.speed<105) ownship.groove=true;
			if(ownship.groove){
			if((ownship.hook??0)>0.5){ const p=ownship.pass||(ownship.pass={gs:0,az:0,n:0});
				p.gs+=Math.abs(s.dev); p.az+=Math.abs(Math.atan2(s.lat,Math.max(s.along,1)))*180/Math.PI; p.n++; }
			const wave=(s.dev<-0.7 && s.dist>250)   // dangerously low in close (matches the OLS waveoff lights); inside ~250 m the call is over (hook geometry reads falsely low there)
				|| (lineup>6 && s.along>250)          // gross lineup deviation — drifting for the foul line or the island
				|| (s.dev>1.8 && s.along<800 && s.along>250)   // way high in close: unlandable, go around
				|| ((ownship.hook??0)<0.5 && s.along<1200);    // hook up on an approach — a mandatory wave-off on any deck
			if(wave){ ownship.waved=true; if(!ownship.waving) ownship.wavet=performance.now(); ownship.waving=true; }   // stamp the call's onset: the blink phase anchors here, so the banner always opens with a full ON period (a free-running clock made it flicker off just as it appeared)
			}
		}
	} else { ownship.waving=false; ownship.groove=false; }
}

function reset_ownship(){
	test_idle=0; _test_power=0;   // a respawn ends any scenario rollout grace — the lever and brakes are the pilot's again
	hist_valid=false;   // spawn/respawn teleports the camera — a cut for the cloud accumulation history
	battle_rig(); ejected=false; hit_flash=0; own_burn=[0,0]; own_burning=false; own_leak=0; peak_g=1;   // a fresh jet, a fresh fight (#78)
	master=cfg.task==="free"?"nav":"gun";   // default master mode per mission: combat spawns fight-ready (a dead trigger at the merge is a trap), free flight powers up in NAV like the real jet
	bandit_acc=0;   // no stale fixed-step debt across spawns
	designated=-1;   // a respawn drops the acquisition
	bandit.spent=0; bandit.rounds=MAGAZINE;   // a fresh fight rearms the bandit: full belt, clean expenditure
	bandit.struck=0; bandit.fate=undefined; ownship.struck=0; ownship.fate=undefined;   // and starts clean battle channels (#238)
	ownship.q.set(0,0,0,1); ownship.fwd.set(1,0,0); ownship.up.set(0,1,0); ownship.right.set(0,0,1); ownship.vel_dir.set(1,0,0);
	ownship.rounds=MAGAZINE; ownship.msl=magazine(); ownship.cm=60; ownship.aoa=0; ownship.gload=1; ownship.launching=false; ownship.trapped=false; ownship.wire=0; atc_on=false; ownship.lights=(cfg.tod!=="day");   // lights default on at night, off by day; the magazine is the flown loadout's round count (#17)
	update_rails(ownship, ownship.msl); update_rails(bandit, bandit_remaining());
	ownship.grounded=false; ownship.touch=null; ownship.pass={gs:0,az:0,n:0}; ownship.grade=""; ownship.waved=false; ownship.groove=false; ownship.turned=false; ownship.taxied=false;   // landing / LSO pass state
	test_active=null;   // a test scenario must not keep driving across a crash respawn (it would fly the fresh spawn straight into the deck, forever)
	const st=mission_start();
	if(st==="case1"||st==="case2"||st==="case3") ddi_sets.nav.right="adi";   // spawned on approach: the pilot set up for instrument work before we hand over (#15)
	ddi_recall();   // a fresh pit shows the spawn master mode's display set
	marshal=null;   // a fresh spawn restarts any Case III procedure (the case3 branch re-arms it)
	pattern=null;   // ...and any visual-pattern procedure (#50)
	fuel_dump=false; secured[0]=false; secured[1]=false;   // a fresh jet spawns with the dump off and both engines fuelled (#54)
	if(st==="carrier"){ ownship.speed=0; ownship.throttle=0.95; place_on_cat(); }   // spotted on the cat at military power — the real-world standard shot at this weight (full throttle = burner, the heavy-day technique); Enter fires, throttle back + steer to taxi off
	else if(st==="runway" && airports.length){ const ap=airports[0];          // start on the near airport runway
		ownship.pos.set(ap.start.x,ap.start.y,ap.start.z); ownship.fwd.copy(ap.dir).normalize(); ownship.speed=0; ownship.throttle=0;
		const r=new THREE.Vector3().crossVectors(ownship.fwd,world_up).normalize(); const u=new THREE.Vector3().crossVectors(r,ownship.fwd).normalize();
		ownship.q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(ownship.fwd,u,r)); ownship.vel_dir.copy(ownship.fwd); }
	else if(st==="case1"){   // Case I (#205): initial — up the WAKE (hull axis, not the angled centreline) at 800 ft, 350 kt, clean. The break, the dirty-up, and the pattern are the mission
		const O=carrier_world(0,0), F=carrier_world(100,0);
		let hx=F.x-O.x, hz=F.z-O.z; const hl=Math.hypot(hx,hz)||1; hx/=hl; hz/=hl;   // unit hull-forward
		const dist=3*1852;
		ownship.pos.set(O.x-hx*dist, 245, O.z-hz*dist);   // 3 NM astern on the wake at 800 ft
		ownship.speed=180; ownship.throttle=0.85;   // 350 kt clean; pre-core fallback — flight_push trims speed AND power via the core's Level
		ownship.fwd.set(hx,0,hz).normalize();
		const r=new THREE.Vector3().crossVectors(ownship.fwd,world_up).normalize(); const u=new THREE.Vector3().crossVectors(r,ownship.fwd).normalize();
		ownship.q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(ownship.fwd,u,r)); ownship.vel_dir.copy(ownship.fwd);
		pattern={ broke:false, told:false, dirty:false, downwind:false, ball:false }; }
	else if(st==="case2"){   // Case II (#205): established on the FINAL BEARING at 1,200 ft, on-speed, configured — needles to the break-out, visual finish. Level at 1,200 intercepts the 3.5° glideslope ~3 nm out (CV-1)
		const A=carrier_world(SHIP.line.afa,SHIP.line.alat), B=carrier_world(SHIP.line.bfa,SHIP.line.blat);   // landing centreline, A (aft) → B (forward, toward the rollout)
		let ldx=B.x-A.x, ldz=B.z-A.z; const ll=Math.hypot(ldx,ldz)||1; ldx/=ll; ldz/=ll;           // unit landing direction (the way the aircraft rolls out)
		const tw=SHIP.wires[SHIP.wires.length>3?2:1], td=carrier_world(tw,strip_lat(tw)), dist=6*1852;   // 6 NM astern of the aim wire
		ownship.pos.set(td.x-ldx*dist, 366, td.z-ldz*dist);
		ownship.speed=72; ownship.throttle=0.35;   // pre-core fallback only — flight_push asks the core for the real LEVEL on-speed trim the moment it is up
		ownship.fwd.set(ldx,0,ldz).normalize();
		const r=new THREE.Vector3().crossVectors(ownship.fwd,world_up).normalize(); const u=new THREE.Vector3().crossVectors(r,ownship.fwd).normalize();
		ownship.q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(ownship.fwd,u,r)); ownship.vel_dir.copy(ownship.fwd);
		ownship.q.premultiply(new THREE.Quaternion().setFromAxisAngle(r,8.1*D2R));   // attitude = on-speed alpha over the level path (pre-core fallback)
		pattern={ broke:true, told:true, dirty:true, downwind:true, ball:false }; }   // Case II starts configured on the final bearing: only the ball remains
	else if(st==="case3"){   // Case III (#205): marshal — 21 NM on the final bearing at angels 6, clean, 250 kt, inbound at the fix. The push clock is running: fly the racetrack, commence on time
		const A=carrier_world(SHIP.line.afa,SHIP.line.alat), B=carrier_world(SHIP.line.bfa,SHIP.line.blat);
		let ldx=B.x-A.x, ldz=B.z-A.z; const ll=Math.hypot(ldx,ldz)||1; ldx/=ll; ldz/=ll;
		const tw=SHIP.wires[SHIP.wires.length>3?2:1], td=carrier_world(tw,strip_lat(tw)), dist=21*1852;
		ownship.pos.set(td.x-ldx*dist, 1829, td.z-ldz*dist);   // angels 6 at 21 DME: "angels = DME − 15"
		ownship.speed=129; ownship.throttle=0.7;   // 250 kt hold speed; pre-core fallback — flight_push trims speed AND power via Level
		ownship.fwd.set(ldx,0,ldz).normalize();
		const r=new THREE.Vector3().crossVectors(ownship.fwd,world_up).normalize(); const u=new THREE.Vector3().crossVectors(r,ownship.fwd).normalize();
		ownship.q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(ownship.fwd,u,r)); ownship.vel_dir.copy(ownship.fwd);
		marshal={ push:sim_time+MARSHAL_PUSH, commenced:false, platform:false, dirty:false, ball:false };
		comm("MARSHAL: "+translate("PUSH TIME")+" "+clock_text(MARSHAL_PUSH), "#9fd0ff"); }
	else if(st==="joust"){   // 1v1 merge: head-on east-west directly over the atoll at 15,000 ft, 1 NM either side, equal AIRSPEED — symmetric in every respect (island below both at all fight orientations, sun/moon abeam both noses); the side is a coin flip so the sun-left/sun-right mirror can't systematically favour one player
		weapons_hold=true;   // #87: fight's on at the merge, not before
		joust_side=Math.random()<0.5?1:-1;
		ownship.pos.set(-joust_side*1.5*NM, 4572, 0); ownship.fwd.set(joust_side,0,0); ownship.speed=220; ownship.throttle=0.85;   // 15,000 ft = 4572 m; 1.5 NM either side = 3 NM head-on
		const r=new THREE.Vector3().crossVectors(ownship.fwd,world_up).normalize(); const u=new THREE.Vector3().crossVectors(r,ownship.fwd).normalize();
		ownship.q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(ownship.fwd,u,r)); ownship.vel_dir.copy(ownship.fwd); }
	else {   // air start (free flight): ~15 km ENE of the runway at 5000 ft, heading at the carrier
		const rwy=airports.length?airports[0]:{x:-1125,z:2898};   // Sand Island runway (fallback = its known centroid, since the map loads async)
		const b=68*D2R;   // ENE
		ownship.pos.set(rwy.x+Math.sin(b)*15000, 1524, rwy.z-Math.cos(b)*15000);   // 5000 ft = 1524 m
		ownship.fwd.set(CARRIER.x-ownship.pos.x,0,CARRIER.z-ownship.pos.z).normalize(); ownship.speed=220; ownship.throttle=0.85;
		const r=new THREE.Vector3().crossVectors(ownship.fwd,world_up).normalize(); const u=new THREE.Vector3().crossVectors(r,ownship.fwd).normalize();
		ownship.q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(ownship.fwd,u,r)); ownship.vel_dir.copy(ownship.fwd); }
	throttle_from_lever();   // a connected stick with a bound throttle wins over the spawn default — the physical lever position IS the commanded power (falls back silently: browsers hide pads until a button has been pressed)
	{ const down=(st==="carrier"||st==="runway"||st==="case2"); ownship.gearTarget=down?0:1; ownship.gear=ownship.gearTarget; }   // gear down on deck/runway/Case II (established on the approach); Cases I and III spawn CLEAN — the dirty-up is part of the procedure
	{ const hk=(st==="case1"||st==="case2")?1:0; ownship.hookTarget=hk; ownship.hook=hk; }   // hook down for BOTH visual-pattern starts (NATOPS 8.2.10: "enter the carrier landing pattern with the hook down"); Case III lowers it at the dirty-up, everything else stows it
	flight_push();   // deliver the spawn to the flight core (no-op until it boots; the boot pushes this pose itself)
	ownship.group.quaternion.copy(ownship.q); ownship.group.position.copy(ownship.pos);
	if(st==="joust"){ bandit.pos.set(joust_side*1.5*NM,4572,0); bandit.fwd.set(-joust_side,0,0); bandit.speed=220; bandit.merging=true;   // merging: the bandit flies straight at the player until the pass, so the merge can be timed   // the other end of the merge, same airspeed (equal TAS is the fair condition once wind exists)
		bandit_brain=false; fly_bandit.tried=false;   // the wasm brain arms lazily in fly_bandit once the core is ready (#125 phase 2)
	}
	else { bandit.pos.set(3000,2400,-1000); bandit.fwd.set(-0.3,0,1).normalize(); bandit.speed=195; bandit.merging=false; }   // ground/deck starts: the bandit orbits near Midway as before
	bandit.break_t=0;
}

// ============================================================================ camera
// padlock_target: what the padlock watches. Single player, the bandit while
// the duel stands; multiplayer, the nearest remote not on my team (any remote
// in a teamless furball). Null means nothing to watch.
function padlock_target(){
	if(!MULTIPLAYER) return (has_enemy&&bandit.group&&bandit.group.visible)?bandit:null;
	if(!net) return null;
	const mine=net.teams.get(net.slot)||"";
	let best=null, span=1e12;
	for(const [slot,st] of remotes.entries()){ if(!st.group||!st.group.visible) continue;
		if(mine&&(net.teams.get(slot)||"")===mine) continue;
		const d=st.pos.distanceToSquared(ownship.pos); if(d<span){ span=d; best=st; } }
	return best;
}
function update_camera(dt){
	const firstPerson = (cfg.view==="hud");
	ownship.group.visible=(!firstPerson) || cfg.view==="cockpit";   // in cockpit view the airframe RENDERS (near pass); the layer split keeps it out of the world passes
	// #57 parked: head_apply(dt);   // #57: the tracked pose first — a held arrow still nudges on top for the frame
	if(cfg.view!=="chase" && cfg.view!=="ddi" && !map_on){   // arrow/hat head look in BOTH first-person views — chase keeps the arrows for its orbit, and head-down DDI work leaves the head where it was. The clamps are the pilot's: ±150° azimuth (checking six over the shoulder, as far as the straps allow) and -60°/+80° elevation
		const hr=dt*1.6;
		const daz=(((keys.has("ArrowLeft")||pad_looks.left)?1:0)-((keys.has("ArrowRight")||pad_looks.right)?1:0))*hr;
		const del=(((keys.has("ArrowUp")||pad_looks.up)?1:0)-((keys.has("ArrowDown")||pad_looks.down)?1:0))*hr;   // ↑ looks up (head_el positive = up; the compose carries the sign); the castle joins the arrows in both views
		if(daz||del){ head_az=THREE.MathUtils.clamp(head_az+daz,-2.618,2.618); head_el=THREE.MathUtils.clamp(head_el+del,-1.047,1.396); padlock_snap=false; }   // a manual look cancels any ease-home in progress
	}
	// Padlock (#243): HOLD Y to look at the target in the first-person views;
	// release and the head eases home. The motion is an exponential ease with
	// a rate cap — fast off the mark, smooth into the target, never a robot
	// sweep. The CLAMPS are the mask: a target past ±150° az or under the sill
	// stays honestly out of view, head parked at its limit ("he's behind me
	// and I can't see him"), resuming when he emerges.
	{ const held=(cfg.view==="hud"||cfg.view==="cockpit")&&keys.has(key_of("padlock"));
		const t=held?padlock_target():null;
		if(held&&!t&&!padlock_warned){ notice(translate("NO TARGET")); padlock_warned=true; }
		if(!held) padlock_warned=false;
		if(padlock&&!(held&&t)) padlock_snap=true;   // released (or target gone): ease home
		padlock=!!(held&&t);
		if(padlock){ padlock_snap=false;
			_pad_d.copy(t.pos).sub(ownship.pos).normalize();
			const bf=_pad_d.dot(ownship.fwd), bu=_pad_d.dot(ownship.up), br=_pad_d.dot(ownship.right);
			const azT=THREE.MathUtils.clamp(Math.atan2(-br,bf),-2.618,2.618);
			const elT=THREE.MathUtils.clamp(Math.atan2(bu,Math.hypot(bf,br)),-1.047,1.396);
			const k=1-Math.exp(-dt*9), R=dt*7;   // ease constant ~0.11 s, rate cap ~400°/s
			head_az+=THREE.MathUtils.clamp((azT-head_az)*k,-R,R);
			head_el+=THREE.MathUtils.clamp((elT-head_el)*k,-R,R); } }
	if(padlock_snap){ const k=1-Math.exp(-dt*9), R=dt*7;   // the same ease carries the head home
		head_az-=THREE.MathUtils.clamp(head_az*k,-R,R); head_el-=THREE.MathUtils.clamp(head_el*k,-R,R);
		if(Math.abs(head_az)<0.01&&Math.abs(head_el)<0.01){ head_az=0; head_el=0; padlock_snap=false; } }
	if(cfg.view!=="chase" || map_on){   // HELD zoom keys sweep the optical zoom (the keydown edge gives the first notch; this carries the hold). Chase in flight is excluded: there −/= dolly the orbit below
		const zk=(k)=>keys.has(key_of(k).replace(/^Shift\+/,""));
		const sweep=((zk("zoom.in")?1:0)-(zk("zoom.out")?1:0))*dt*2.6;   // held sweep quickened to match the coarser notch
		if(sweep&&running&&!game_paused){ if(map_on) map_range=THREE.MathUtils.clamp(map_range*Math.pow(1.2,-sweep),MAP_RANGE_MIN,MAP_RANGE_MAX);
			else if(cfg.view!=="ddi"){ zoom_target=THREE.MathUtils.clamp(zoom_target*Math.pow(2.4,sweep),zoom_floor(),4); zoom_persist(); } } }
	if(cfg.view==="chase" && !map_on){   // keyboard orbit (shares cam_az/el with the mouse drag): ←→ azimuth, ↑↓ elevation, −/= zoom — keys.md §5; with the map up, −/= zoom the map instead
		const ar=dt*0.9, zr=dt*40;
		cam_az+=(((keys.has("ArrowRight")||pad_looks.right)?1:0)-((keys.has("ArrowLeft")||pad_looks.left)?1:0))*ar;           // ←/→ orbit (keyboard or castle)
		cam_el=THREE.MathUtils.clamp(cam_el+(((keys.has("ArrowUp")||pad_looks.up)?1:0)-((keys.has("ArrowDown")||pad_looks.down)?1:0))*ar,-1.2,1.45);   // ↑/↓ tilt
		if(keys.has("Minus")) cam_dist=Math.min(140,cam_dist+zr);           // - back
		if(keys.has("Equal")) cam_dist=Math.max(14,cam_dist-zr);            // = in — floor clears the airframe: ~10 m bounding radius about the orbit centre + the 3 m near plane + margin, so the camera can never cut inside the jet (#116)
	}
	// Aerodynamic buffet, the seat cue: the core grades the LEX/stall shake
	// (STATE.buffet) and the seat views ride it — a small white-noise jitter
	// whose amplitude cubes with the ENVELOPED intensity, so onset is a
	// gradual tremble and the deep stall is a firm shake. Outside views stay
	// steady.
	// The envelope, then a cubed law (#234 tuning): the core's channel ramps
	// with alpha, so a brisk pull crosses the whole onset band in a fraction
	// of a second and the raw value arrives as a step — the shake snapped on
	// and read as violent. The low-pass gives it a ~0.4 s fade-in/out, and the
	// cube keeps the low end near-imperceptible so the tremble grows instead
	// of appearing.
	const buffet_b=last_out?(last_out[STATE.buffet]||0):0;
	buffet_env+=(buffet_b-buffet_env)*Math.min(1,dt*4);
	const buffet_cue=buffet_env*buffet_env*buffet_env;
	const buffet_amp=buffet_cue*0.009;
	const buffet_rot=buffet_cue*0.0008;   // HUD view (#234): ±0.05° of attitude noise at the limit — translation is invisible there (no near geometry, centimetres of eye motion give no parallax against distant scenery), so the world gets a whisper of tremble against the screen-fixed symbology, whose own pixel shake in draw_hud carries the cue
	const buffet_jitter=(eye)=>{ if(buffet_amp>1e-4){ eye.x+=(Math.random()*2-1)*buffet_amp; eye.y+=(Math.random()*2-1)*buffet_amp; eye.z+=(Math.random()*2-1)*buffet_amp; } return eye; };
	if(firstPerson){ const eye=buffet_jitter(body_offset(ownship,3.0,0.6,0)); camera.position.copy(eye);
		// Same head compose as the cockpit, not a bare lookAt: this view is a
		// pilot without the airframe in the way, so the head turns here too,
		// and the quaternion form is what keeps roll coupled correctly near
		// the pitch poles where lookAt fumbles it.
		camera.quaternion.copy(ownship.q).multiply(_headq.setFromAxisAngle(_yaxis,head_az)).multiply(_pitq.setFromAxisAngle(_zaxis,head_el)).multiply(CAMFIX);   // the held look keeps the pilot's head roll in the AIRFRAME frame — a glance, not a stabilised camera (world-up stabilisation tried 2026-08-10 and removed at the user's direction)
		if(buffet_rot>1e-5) camera.quaternion.multiply(_headq.setFromAxisAngle(_zaxis,(Math.random()*2-1)*buffet_rot)).multiply(_pitq.setFromAxisAngle(_yaxis,(Math.random()*2-1)*buffet_rot));   // the temps are free again after the compose consumed them
		}
	else if(cfg.view==="cockpit"){ const at=ownship.group.userData.eye||{x:3.0,y:0.6};   // calibrated from the modeled pilot head once the GLB resolves
		const eye=buffet_jitter(body_offset(ownship,at.x,at.y,0)); camera.position.copy(eye);
		camera.quaternion.copy(ownship.q).multiply(_headq.setFromAxisAngle(_yaxis,head_az)).multiply(_pitq.setFromAxisAngle(_zaxis,head_el)).multiply(CAMFIX);   // quaternion compose: lookAt fumbles roll coupling near +80° pitch; the held look keeps head roll in the airframe frame
		}
	else if(cfg.view==="padlock"){ const eye=camera_floor(body_offset(ownship,-12,4,0)); camera.position.copy(eye); camera.up.set(0,1,0);
		camera.lookAt(has_enemy?bandit.pos:eye.clone().addScaledVector(ownship.fwd,200)); }   // lock on the bandit; look ahead when solo
	else if(cfg.view==="chase"){   // earth-referenced orbit: world-up + smoothed heading-follow, ignores roll/pitch (keys.md §5)
		const psi=Math.atan2(ownship.fwd.x,ownship.fwd.z);
		let dpsi=psi-cam_psi; if(dpsi>Math.PI)dpsi-=2*Math.PI; if(dpsi<-Math.PI)dpsi+=2*Math.PI;
		cam_psi+=dpsi*Math.min(1,dt*4); if(cam_psi>Math.PI)cam_psi-=2*Math.PI; if(cam_psi<-Math.PI)cam_psi+=2*Math.PI;   // the smoothing lives in the ANGLE, not the position
		const ang=cam_psi+cam_az, tgt=ownship.pos.clone(); tgt.y+=1.2;
		let ce=Math.cos(cam_el), se=Math.sin(cam_el);
		const p=new THREE.Vector3(tgt.x-Math.sin(ang)*ce*cam_dist, tgt.y+se*cam_dist, tgt.z-Math.cos(ang)*ce*cam_dist);
		const g=ground_height(p.x,p.z), floor=(g>-1e8?g:0.4)+1.5;   // deck / runway / island under the camera, or the sea surface; margin > the near plane's ~1.24 m reach below the camera (near 3.0, 45° fov), else the near plane slices the ground open
		if(p.y<floor){   // clamp the ELEVATION at the floor (not just y) — otherwise holding down keeps shrinking cos(el), sliding the camera in toward the aircraft
			cam_el=Math.asin(THREE.MathUtils.clamp((floor-tgt.y)/cam_dist,-1,1)); ce=Math.cos(cam_el); se=Math.sin(cam_el);
			p.set(tgt.x-Math.sin(ang)*ce*cam_dist, tgt.y+se*cam_dist, tgt.z-Math.cos(ang)*ce*cam_dist); }
		camera.position.copy(p); camera.up.set(0,1,0); camera.lookAt(tgt); }   // rigid offset — a world-space position lerp against a 70-300 m/s target lags v/6 m and drags the camera behind the tail, defeating the orbit
	else if(cfg.view==="flypast"){ update_flypast(dt); }
}
function camera_floor(p){   // keep an external camera above whatever's beneath it: carrier deck / runway / island, or the sea surface
	const g=ground_height(p.x,p.z), f=(g>-1e8?g:0.4)+1.5;   // margin > the near plane's reach below the camera (see the chase clamp)
	if(p.y<f) p.y=f; return p;
}

function update_flypast(_dt){   // fixed-ground flyby: the jet flies past a stationary camera; re-seed ahead once it recedes
	if(!flyby_pos || ownship.pos.distanceTo(flyby_pos)>380){
		flyby_side*=-1;
		const fwdH=new THREE.Vector3(ownship.fwd.x,0,ownship.fwd.z); if(fwdH.lengthSq()<1e-4) fwdH.set(0,0,1); fwdH.normalize();
		const rightH=new THREE.Vector3().crossVectors(new THREE.Vector3(0,1,0),fwdH).normalize();
		const ahead=170+Math.random()*80, side=(45+Math.random()*40)*flyby_side, up=12.5+Math.random()*27.5;
		flyby_pos=ownship.pos.clone().addScaledVector(fwdH,ahead).addScaledVector(rightH,side); flyby_pos.y+=up;
		const floor=takeoff_surface()+6; if(flyby_pos.y<floor) flyby_pos.y=floor;   // keep the camera above the sea/deck
	}
	camera.position.copy(flyby_pos); camera.up.set(0,1,0); camera.lookAt(ownship.pos);
}

// ============================================================================ HUD (2D canvas overlay)
const hctx=hud.getContext("2d");
let HW=innerWidth, HH=innerHeight;
function hud_resize(){ HW=innerWidth; HH=innerHeight; const dpr=Math.min(devicePixelRatio||1,2);
	hud.width=HW*dpr; hud.height=HH*dpr; hud.style.width=HW+"px"; hud.style.height=HH+"px"; hctx.setTransform(dpr,0,0,dpr,0,0); }
const _p=new THREE.Vector3();
function proj_point(v){ _p.copy(v).project(camera); if(_p.z>1) return null; return [(_p.x*0.5+0.5)*HW,(-_p.y*0.5+0.5)*HH]; }
// The combining glass, projected (#99): flight symbology in cockpit view lives ON
// the glass — conformal pieces are clipped to this quad, instrument furniture is
// scaled into it. Returns null when the glass is out of frame (head turned away).
function glass_rect(){ const at=ownship.group.userData.eye||{x:3.0,y:0.6};
	const pane=ownship.group.userData.glass, outline=ownship.group.userData.outline;
	const gx=pane?pane.x:at.x+0.55, gy=pane?pane.y:at.y+0.055, hw=pane?pane.hw:0.10, hh=pane?pane.hh:0.078;   // the MODELED combining glass when calibrated (Object_1042); hand constants only until the GLB resolves
	// The clip follows the pane's hulled OUTLINE (an octagon — sloped upper
	// corners) when calibrated; the box quad is only the pre-calibration
	// fallback. A box clip let ladder numbers float on sky at the corners (#16).
	const corners=(outline
		?outline.map(([z,y,x])=>proj_point(body_offset(ownship,x,y,z)))
		:[[gy+hh,-hw],[gy+hh,hw],[gy-hh*0.42,hw],[gy-hh*0.42,-hw]].map(([y,z])=>proj_point(body_offset(ownship,gx,y,z))));   // bottom edge raised: the pane MESH runs down behind the glareshield, and the 2D overlay cannot be occluded by geometry
	if(corners.some(c=>!c)) return null;
	let rcx=0, rcy=0, xlo=Infinity, xhi=-Infinity;
	for(const c of corners){ rcx+=c[0]; rcy+=c[1]; if(c[0]<xlo)xlo=c[0]; if(c[0]>xhi)xhi=c[0]; }
	rcx/=corners.length; rcy/=corners.length;
	const width=xhi-xlo;
	if(width<40) return null;   // glancing/edge-on: nothing sensible to draw
	return { corners, rcx, rcy, scale:width/620 }; }
function glass_clip(g){ hctx.beginPath(); hctx.moveTo(g.corners[0][0],g.corners[0][1]);
	for(let i=1;i<g.corners.length;i++) hctx.lineTo(g.corners[i][0],g.corners[i][1]); hctx.closePath();
	if(GLASS_DEBUG){ hctx.save(); hctx.strokeStyle="#ff40ff"; hctx.lineWidth=2; hctx.stroke(); hctx.restore(); }
	hctx.clip(); }
function proj_dir(d){ _p.copy(camera.position).addScaledVector(d,1000).project(camera); if(_p.z>1) return null; return [(_p.x*0.5+0.5)*HW,(-_p.y*0.5+0.5)*HH]; }
let GR="#15b85f"; const AM="#ffc14d";   // GR switches to a brighter daytime green in draw_hud (real HUDs have a brightness knob)

// ---- full-screen map (M) — aircraft, islands, airports, carrier; never bandits ----
const map_el=map; const mctx=map_el.getContext("2d"); let map_on=false;
const help_el=help;
function map_resize(){ const dpr=Math.min(devicePixelRatio||1,2); map_el.width=innerWidth*dpr; map_el.height=innerHeight*dpr; map_el.style.width=innerWidth+"px"; map_el.style.height=innerHeight+"px"; mctx.setTransform(dpr,0,0,dpr,0,0); }
const NM=1852;
const MAP_RANGE_DEFAULT=40000; let map_range=MAP_RANGE_DEFAULT; const MAP_RANGE_MIN=5*NM, MAP_RANGE_MAX=100*NM;   // half-width of the map view in metres; − / = / mouse wheel zoom
let map_px=0, map_pz=0;   // arrow-key pan offset from own aircraft (world metres); cleared on map open so it reopens centred
function draw_map(){ const W=innerWidth,H=innerHeight; mctx.clearRect(0,0,W,H);
	const cxp=W/2, cyp=H/2, s=Math.min(W,H)*0.46/map_range;
	const X=x=>cxp+wrap_axis(x-ownship.pos.x-map_px)*s, Y=z=>cyp+wrap_axis(z-ownship.pos.z-map_pz)*s;   // centred on own aircraft (+ pan), north up (+x→east, +z→south); min-image across the wrap
	// frame + title
	mctx.fillStyle=GR; mctx.font="14px monospace"; mctx.textAlign="left"; mctx.fillText(translate("TACTICAL MAP"),24,30);
	mctx.fillStyle="#7fcfa6"; mctx.font="11px monospace"; mctx.fillText(translate("M to close"),24,48);
	// range rings around the player, every 10 NM
	const px=X(ownship.pos.x), py=Y(ownship.pos.z);
	mctx.strokeStyle="rgba(95,200,150,0.18)"; mctx.lineWidth=1; mctx.textAlign="left";
	for(let nm=10;nm<=160 && nm*NM*s<Math.hypot(W,H)*0.75;nm+=10){ const rr=nm*NM*s; mctx.beginPath(); mctx.arc(px,py,rr,0,Math.PI*2); mctx.stroke();
		mctx.fillStyle="rgba(127,207,166,0.4)"; mctx.font="9px monospace"; mctx.fillText(nm+"NM",px+4,py-rr+12); }
	// islands — the real Midway coastline polygons (Sand / Eastern / Spit)
	mctx.fillStyle="#c3b892"; mctx.strokeStyle="#e8e0c0"; mctx.lineWidth=1.2;
	for(const polygon of island_polygons){ mctx.beginPath();
		for(let k=0;k<polygon.length;k++){ const sx=X(polygon[k][0]), sy=Y(polygon[k][1]); if(k===0) mctx.moveTo(sx,sy); else mctx.lineTo(sx,sy); }
		mctx.closePath(); mctx.fill(); mctx.stroke(); }
	// airports: runway line + marker on their islands
	mctx.font="10px monospace"; mctx.textAlign="center";
	for(const ap of airports){ const ax=X(ap.x), ay=Y(ap.z); const dx=ap.dir.x, dz=ap.dir.z; const len=Math.max(8,1300*s);
		mctx.strokeStyle="#e8eef0"; mctx.lineWidth=2; mctx.beginPath(); mctx.moveTo(ax-dx*len,ay-dz*len); mctx.lineTo(ax+dx*len,ay+dz*len); mctx.stroke();
		mctx.fillStyle="#bfe9ff"; mctx.beginPath(); mctx.arc(ax,ay,4,0,Math.PI*2); mctx.fill();
		mctx.fillStyle="#bfe9ff"; mctx.fillText("\u2708",ax,ay-9); }
	// carrier
	const kx=X(CARRIER.x), ky=Y(CARRIER.z); mctx.fillStyle="#ffd27a"; mctx.fillRect(kx-5,ky-5,10,10);
	mctx.fillStyle="#ffd27a"; mctx.font="10px monospace"; mctx.fillText("CV",kx,ky-9);
	// contacts: rendered remotes (and the SP bandit), coloured by side
	const jet=(x2,y2,fx,fz,colour,label)=>{ const fl=Math.hypot(fx,fz)||1, jux=fx/fl, juz=fz/fl, jrx=-juz, jrz=jux;
		mctx.fillStyle=colour; mctx.beginPath();
		mctx.moveTo(x2+jux*9,y2+juz*9); mctx.lineTo(x2-jux*6+jrx*5,y2-juz*6+jrz*5); mctx.lineTo(x2-jux*6-jrx*5,y2-juz*6-jrz*5); mctx.closePath(); mctx.fill();
		if(label){ mctx.font="9px monospace"; mctx.textAlign="center"; mctx.fillText(label,x2,y2+18); } };
	if(MULTIPLAYER&&net){ for(const [slot,st] of remotes.entries()){ if(!st.group||!st.group.visible) continue;
			const team=net.teams.get(slot)||"";
			const colour=team==="red"?"#ff5a48":team==="blue"?"#5a86ff":"#ffb04a";
			jet(X(st.pos.x),Y(st.pos.z),st.fwd.x,st.fwd.z,colour,st.name||net.names.get(slot)||""); } }
	else if(has_enemy&&bandit.group.visible) jet(X(bandit.pos.x),Y(bandit.pos.z),bandit.fwd.x,bandit.fwd.z,"#ffb04a","");
	if(MULTIPLAYER&&net&&net.welcome&&net.welcome.spawn&&net.welcome.spawn.mode==="teams"){
		mctx.textAlign="left"; mctx.font="13px monospace";
		mctx.fillStyle="#ff5a48"; mctx.fillText("RED "+(net.score.red||0),24,70);
		mctx.fillStyle="#5a86ff"; mctx.fillText("BLUE "+(net.score.blue||0),24,88); }
	// player aircraft: triangle pointing along heading
	const hx=ownship.fwd.x, hz=ownship.fwd.z, hl=Math.hypot(hx,hz)||1; const ux=hx/hl, uz=hz/hl, rxv=-uz, rzv=ux;
	mctx.fillStyle="#ffffff"; mctx.beginPath();
	mctx.moveTo(px+ux*12,py+uz*12); mctx.lineTo(px-ux*8+rxv*7,py-uz*8+rzv*7); mctx.lineTo(px-ux*8-rxv*7,py-uz*8-rzv*7); mctx.closePath(); mctx.fill();
	mctx.fillStyle="#ffffff"; mctx.font="10px monospace"; mctx.fillText(translate("YOU"),px,py+24);
}
addEventListener("resize",()=>{ if(map_on) map_resize(); },{ signal });
map_el.addEventListener("wheel",e=>{ e.preventDefault(); map_range=THREE.MathUtils.clamp(map_range*Math.pow(1.2,Math.sign(e.deltaY)),MAP_RANGE_MIN,MAP_RANGE_MAX); },{ signal, passive:false });   // wheel down = zoom out (map only — chase zoom deliberately stays on −/=)

// #133 real-HUD state: weapon master mode (cycled by the select key; the
// trigger fires the SELECTED weapon like the real stick), the HUD control
// panel's BARO/RDR altitude switch, the REJ 1 declutter, and the sticky
// peak-g readout NATOPS shows past 4.0.
let master="gun", alt_radar=false, declutter=0, peak_g=1;   // declutter: 0 NORM, 1 REJ 1, 2 REJ 2
function dir_at(headFwd, rightH, yawRad, pitchRad){ const d=headFwd.clone().applyAxisAngle(world_up,yawRad); d.applyAxisAngle(rightH,pitchRad); return d; }
function hud_message(text){ hctx.textAlign="center"; hctx.fillStyle=AM; hctx.font="20px monospace"; hctx.fillText(text, HW/2, HH/2+180); }   // shared centre banner for important messages (RUN UP ENGINE / PRESS SPACE TO LAUNCH / N WIRE)
// ---- DDI view (#99 follow-on): one display fills the screen, head-down. The
// face reuses the same size-agnostic page renderers at SCREEN resolution on
// its own canvas (never the pit's small textures upscaled); the bezel bands
// become large click targets. The world is not rendered behind the panel —
// honest head-down time; the sim and audio run on. Re-press 3 cycles the
// display; the choice persists in the config as cfg.ddi.
const DDI_ORDER=["left","right","center"];
function ddi_focus(){ return DDI_ORDER.includes(cfg.ddi)?cfg.ddi:"left"; }
const ddi_face=document.createElement("canvas");
let ddi_view_last=0, ddi_view_rect=null;
function draw_ddi_view(){
	const d=ddi_focus(), dpr=Math.min(devicePixelRatio||1,2);
	const size=Math.min(HW,HH)*0.86, px=Math.round(size*dpr);   // margins hold the physical pushbuttons
	hctx.save(); hctx.shadowBlur=0;
	hctx.fillStyle="#101214"; hctx.fillRect(0,0,HW,HH);   // opaque matte — the GL canvas beneath still holds the last world frame
	if(ddi_face.width!==px){ ddi_face.width=ddi_face.height=px; ddi_view_last=0; }
	if(!ddi_view_last||performance.now()-ddi_view_last>120){ ddi_view_last=performance.now();
		ddi_render(ddi_face.getContext("2d"),px,d); }
	const ox=(HW-size)/2, oy=(HH-size)/2;
	ddi_view_rect={ ox, oy, size };
	hctx.drawImage(ddi_face,ox,oy,size,size);
	hctx.strokeStyle="#2a2f33"; hctx.lineWidth=2; hctx.strokeRect(ox-1,oy-1,size+2,size+2);   // bezel line
	// the twenty physical pushbuttons ringing the bezel, outside the face at
	// their slot positions — the legends inside the face edge sit adjacent to
	// them, as on the real display. Caps are click targets too.
	const u=size/512, capW=64*u, capH=26*u, gap=8*u;
	hctx.fillStyle="#1d2327"; hctx.strokeStyle="#39434b"; hctx.lineWidth=1.5;
	for(let pb=1;pb<=20;pb++){ let bx,by,w,h;
		if(pb<=5){ bx=ox-gap-capH/2; by=oy+(96+80*(5-pb))*u; w=capH; h=capW; }
		else if(pb<=10){ bx=ox+(96+80*(pb-6))*u; by=oy-gap-capH/2; w=capW; h=capH; }
		else if(pb<=15){ bx=ox+size+gap+capH/2; by=oy+(96+80*(pb-11))*u; w=capH; h=capW; }
		else { bx=ox+(96+80*(20-pb))*u; by=oy+size+gap+capH/2; w=capW; h=capH; }
		hctx.fillRect(bx-w/2,by-h/2,w,h); hctx.strokeRect(bx-w/2,by-h/2,w,h); }
	hctx.fillStyle="#8fa0aa"; hctx.font="13px monospace"; hctx.textAlign="right"; hctx.textBaseline="middle";
	hctx.fillText(d==="center"?"AMPCD":d==="left"?"LEFT DDI":"RIGHT DDI", ox-gap-capH-10, oy+8);   // cockpit legend — English by the annunciator policy; clear of the button columns
	hctx.restore(); }
function ddi_view_click(e){   // screen-space bezel press — the same 512-space bands as the pit; cap clicks just outside the face clamp into their edge band
	if(!ddi_view_rect) return;
	let lx=(e.clientX-ddi_view_rect.ox)/ddi_view_rect.size*512, ly=(e.clientY-ddi_view_rect.oy)/ddi_view_rect.size*512;
	if(lx<-44||ly<-44||lx>556||ly>556) return;
	lx=THREE.MathUtils.clamp(lx,1,511); ly=THREE.MathUtils.clamp(ly,1,511);
	if(ddi_press(ddi_focus(),button_of(lx,ly))) ddi_view_last=0; }   // redraw NOW — a press must answer this frame
function draw_hud(){
	{ const dpr=Math.min(devicePixelRatio||1,2); hctx.setTransform(dpr,0,0,dpr,0,0); }   // re-assert the base each frame: the buffet shake below leaves a translated transform behind, and early returns must not accumulate it
	hctx.clearRect(0,0,HW,HH);
	// Buffet on the combiner (#234): in HUD view the seat cue is carried by the
	// SYMBOLOGY — the camera's centimetre translation is invisible with no near
	// geometry, but the combining glass is bolted to the shaking airframe. Same
	// enveloped cubed law as the seat views (buffet_env fades the onset in over
	// ~0.4 s — the raw channel arrives as a step on a brisk pull), scaled to
	// 0.3% of viewport height at the limit: ~3-4 px at the stall on a 1200 px
	// view. A HINT, never a hindrance (the user's words, after three rounds
	// of tuning down from 12 px): the symbology must stay fully readable at
	// every buffet depth — the cue is peripheral, like the real shake.
	if(cfg.view==="hud"){ const a=buffet_env*buffet_env*buffet_env*0.003*HH;
		if(a>0.2) hctx.translate((Math.random()*2-1)*a,(Math.random()*2-1)*a); }
	GR=cfg.tod==="day"?"#23e57d":"#15b85f";   // daytime brightness up — the muted night green washes out against a sunlit sea/sky
	hctx.shadowColor="rgba(0,0,0,0.85)"; hctx.shadowBlur=3; hctx.shadowOffsetX=0; hctx.shadowOffsetY=0;   // dark halo behind every HUD glyph/line so it stays readable over any background
	if(cfg.view==="ddi") draw_ddi_view();   // the head-down panel underdraws — banners and notices below stay on top
	const cx=HW/2, cy=HH/2;
	const glass=(cfg.view==="cockpit")?glass_rect():null;   // #99: flight symbology binds to the combining glass in cockpit view
	// The combining glass is bolted to the airframe, not to the pilot's head. In
	// cockpit view the glass rectangle already answers this — turn away and it
	// is off screen. HUD view has no cockpit to occlude it, so now that the head
	// moves there too the same truth has to be stated directly: the symbology
	// fades out as the head leaves boresight and is gone by ~25° off, which is
	// about where a real HUD's field of view runs out.
	const boresight=Math.hypot(head_az,head_el);
	const flight_symbols=(cfg.view==="cockpit")?!!glass:(cfg.view!=="hud"||boresight<0.44);
	if(crash_t>0){ hctx.textAlign="center"; hctx.fillStyle="#ff5040"; hctx.font="bold 36px monospace"; hctx.fillText(translate(ejected?"EJECTED":"CRASHED"),cx,cy-60); return; }   // a fired seat is an ejection, not a crash — same banner, honest word
	if(crash_t<=0 && ownship.waving && net_notice_t<=0 && ((performance.now()-(ownship.wavet||0))%400)<200){ hud_message(translate("WAVE OFF")); }   // flashing waveoff call; the LSO grade / BOLTER / REARMED all go through the notice slot now (#72), so this is the only direct centre-banner draw left
	if(test_active){ hctx.textAlign="left"; hctx.fillStyle="#7fc8ff"; hctx.font="13px monospace"; hctx.fillText("TEST  "+test_active.name, 14, 28); }
	if(DEV_MODE){   // mission elapsed time, on the SAME base as the flight recording — so a moment you noticed reads straight off the ACMI timeline
		const whole=Math.max(0,Math.floor(sim_time));
		hctx.textAlign="left"; hctx.fillStyle="#7fc8ff"; hctx.font="14px monospace";
		hctx.fillText(String(Math.floor(whole/60))+":"+String(whole%60).padStart(2,"0")+" · ω "+turn_probe.rate.toFixed(1)+"°/s", 14, 46); }   // mission clock · instantaneous turn rate (EM validation, #131)
	if(DEV_MODE && carrier_model){   // developer mode: the deck measuring cursor and the &probe raycast. The nose-wheel readout and the dashed view centreline were deck-alignment scaffolding and are gone — Ctrl+C still copies the position
		if(dev_probe && performance.now()-dev_probe_t>1000){ dev_probe_t=performance.now();
			const rc=new THREE.Raycaster(); rc.setFromCamera(new THREE.Vector2(dev_probe.x*2-1, -(dev_probe.y*2-1)), camera);
			const hits=rc.intersectObject(carrier_model.parent||carrier_model, true);
			if(hits.length){ const h=hits[0]; const fa2=carrier_fore_aft(h.point.x,h.point.z), la2=carrier_lateral(h.point.x,h.point.z);
				dev_probe_text="probe: fa="+fa2.toFixed(1)+" lat="+la2.toFixed(1)+" y="+h.point.y.toFixed(2)+" mesh="+(h.object.name||"?")+" mat="+((h.object as THREE.Mesh & {material?:{name?:string}}).material?.name||"?")
					+" geo="+((h.object as THREE.Mesh).geometry?.type||"?")+" kind="+h.object.type+" parents="+(()=>{ const chain:string[]=[]; let o:THREE.Object3D|null=h.object.parent; while(o&&chain.length<4){ chain.push(o.name||o.type); o=o.parent; } return chain.join("<"); })()
					+" at="+h.object.getWorldPosition(new THREE.Vector3()).toArray().map(v=>v.toFixed(1)).join(",")
					+" box="+JSON.stringify(((h.object as THREE.Mesh).geometry as any)?.parameters||{})+" colour="+(((h.object as THREE.Mesh).material as any)?.color?.getHexString?.()||"?"); }
			else dev_probe_text="probe: no hit"; }
		if(dev_probe_text){ hctx.fillStyle="#ff80ff"; hctx.fillText(dev_probe_text, 14, 64); }
		if(!dev_cursor){ const cmat=new THREE.MeshBasicMaterial({color:0x7fc8ff,side:THREE.DoubleSide,depthTest:false});
			dev_cursor=new THREE.Group();
			const ring=new THREE.Mesh(new THREE.RingGeometry(0.10,0.16,24),cmat); ring.rotation.x=-Math.PI/2; ring.renderOrder=999; dev_cursor.add(ring);
			const needle=new THREE.Mesh(new THREE.BoxGeometry(2.4,0.02,0.06),cmat); needle.position.x=1.2; needle.renderOrder=999; dev_cursor.add(needle);   // heading needle: U/O rotate it; lay it along the painted track line to read the true heading
			dev_cursor.traverse(o=>{ o.frustumCulled=false; }); scene.add(dev_cursor); }
		{ const nose=(AIRCRAFT_MODELS[own_aircraft()]||AIRCRAFT_MODELS.fa18c).nose||5.3;
			const bx=ownship.pos.x+ownship.fwd.x*nose+dev_nudge.fa*CARRIER_C+dev_nudge.lat*CARRIER_S, bz=ownship.pos.z+ownship.fwd.z*nose-dev_nudge.fa*CARRIER_S+dev_nudge.lat*CARRIER_C;
			const hd=(Math.atan2(-(ownship.fwd.x*CARRIER_S+ownship.fwd.z*CARRIER_C), ownship.fwd.x*CARRIER_C-ownship.fwd.z*CARRIER_S)+dev_nudge.hd*D2R);
			const dfa=Math.cos(hd), dla=-Math.sin(hd);   // deck-frame heading (+ = port) -> world direction, same transform as the offset
			const dx2=dfa*CARRIER_C+dla*CARRIER_S, dz2=-dfa*CARRIER_S+dla*CARRIER_C;
			dev_cursor.rotation.y=Math.atan2(-dz2,dx2);
			const cursor_y=deck_y_at(carrier_model,bx,bz,-1e9);   // the measuring cursor belongs to the DECK: off the ship the fallback (deck height) hangs it in the sky over the island runway
			dev_cursor.position.set(bx, cursor_y+0.06, bz); dev_cursor.visible=cursor_y>-1e8; }
		}
	if(net_notice_t<=0){ const ls=launch_status(); if(ls>0) hud_message(translate(ls===2?"PRESS ENTER TO LAUNCH":"RUN UP ENGINE")); }   // transient notices own the centre banner — never draw two messages on top of each other
	if(cfg.view!=="hud" && cfg.view!=="cockpit"){ return; }
	hctx.lineWidth=1.5; hctx.strokeStyle=GR; hctx.fillStyle=GR; hctx.font="13px monospace";
	hctx.textAlign="center"; hctx.textBaseline="middle";

	// ---- conformal symbology (#133): 5° pitch ladder referenced to the velocity
	// vector, zenith/nadir, gun cross (A/A only), waterline (landing), the
	// velocity vector with its 8° limit, E-bracket, and ILS deviation bars.
	const ppd=HH/camera.fov;                      // true pixels per degree at the camera's LIVE field (tracks the pit's wide base and the zoom ease alike)
	// Landing symbology follows the FLAP state, not the gear handle — the same
	// virtual flap switch as the FCS law (flight/fcs.go): HALF/FULL armed with
	// the gear below 125 m/s CAS, AUTO passing 92.6 clean (180 KCAS) or 135
	// dirty. Mirrored here because the law state never crosses the wire.
	{ const geardown=(ownship.gear??1)<0.5, kcas=ownship.cas??ownship.speed;
		if(hud_pa){ if((!geardown&&kcas>92.6)||kcas>135) hud_pa=false; }
		else if(geardown&&kcas<125) hud_pa=true; }
	const pa=hud_pa;                              // landing symbology gate (flaps HALF/FULL)
	let fpm=null;
	const bore=glass?(proj_dir(ownship.fwd)||[cx,cy]):[cx,cy];   // boresight on screen — shared by the conformal block AND the A/A weapon block below (was const inside the former: the 9M seeker threw and killed the frame loop)
	if(glass){ hctx.save(); glass_clip(glass); }
	if(flight_symbols){
	const ladFwd=new THREE.Vector3(ownship.vel_dir.x,0,ownship.vel_dir.z);
	if(ladFwd.lengthSq()<0.0025) ladFwd.set(ownship.fwd.x,0,ownship.fwd.z);   // near-vertical flight: fall back to the nose azimuth
	if(ladFwd.lengthSq()>0.0025){ ladFwd.normalize(); const rightH=new THREE.Vector3().crossVectors(ladFwd,world_up).normalize();   // fwd × up = out the RIGHT wing (up × fwd pointed left and inverted the ladder)
		for(let p=-90;p<=90;p+=5){ const pr=p*D2R;
			if(Math.abs(p)===90){ const Z=proj_dir(dir_at(ladFwd,rightH,0,pr)); if(!Z) continue;   // zenith circle; nadir circle with an X
				hctx.strokeStyle=GR; hctx.setLineDash([]); hctx.beginPath(); hctx.arc(Z[0],Z[1],7,0,Math.PI*2); hctx.stroke();
				if(p<0){ hctx.beginPath(); hctx.moveTo(Z[0]-5,Z[1]-5); hctx.lineTo(Z[0]+5,Z[1]+5); hctx.moveTo(Z[0]+5,Z[1]-5); hctx.lineTo(Z[0]-5,Z[1]+5); hctx.stroke(); }
				continue; }
			const wide=(p===0&&pa)?20:(p===0?12:5.2);   // the horizon bar extends in the landing configuration (NATOPS)
			const L=proj_dir(dir_at(ladFwd,rightH,wide*D2R,pr)), R=proj_dir(dir_at(ladFwd,rightH,-wide*D2R,pr)); if(!L||!R) continue;
			const midx=(L[0]+R[0])/2, midy=(L[1]+R[1])/2;
			const ang=Math.atan2(R[1]-L[1],R[0]-L[0]), len=Math.hypot(R[0]-L[0],R[1]-L[1])/2;
			const gap=p===0?30:22;
			hctx.save(); hctx.translate(midx,midy); hctx.rotate(ang); hctx.strokeStyle=GR; hctx.fillStyle=GR;
			hctx.setLineDash(p<0?[7,6]:[]);
			const slope=Math.tan(Math.abs(pr)/2)*(p>0?1:-1);   // NATOPS: lines angled toward the horizon at HALF the flight-path angle
			const tick=p===0?0:(p>0?9:-9);                     // outer end-ticks point toward the horizon
			for(const half of [-1,1]){ const x0=half*gap, x1=half*len, y1=Math.abs(x1-x0)*slope;
				hctx.beginPath(); hctx.moveTo(x0,0); hctx.lineTo(x1,y1); if(tick) hctx.lineTo(x1,y1+tick); hctx.stroke(); }
			if(p!==0){ hctx.setLineDash([]); hctx.font="11px monospace"; hctx.textAlign="center";   // numbers ride the rotated frame, so inverted flight reads at a glance
				for(const half of [-1,1]){ const x1=half*len, y1=Math.abs(x1-half*gap)*slope;
					hctx.fillText(String(Math.abs(p)),x1+half*14,y1+(p>0?tick*0.6:tick*0.6)); } }
			hctx.restore(); } }

	// ---- boresight gun cross: A/A master modes only (the NAV HUD carries none) ----
	if(master!=="nav"&&!pa){ hctx.strokeStyle=GR; hctx.setLineDash([]); hctx.beginPath();
		hctx.moveTo(bore[0]-12,bore[1]); hctx.lineTo(bore[0]-4,bore[1]); hctx.moveTo(bore[0]+4,bore[1]); hctx.lineTo(bore[0]+12,bore[1]);
		hctx.moveTo(bore[0],bore[1]-12); hctx.lineTo(bore[0],bore[1]-4); hctx.stroke(); }

	// ---- waterline symbol (landing configuration) ----
	if(pa){ hctx.strokeStyle=GR; hctx.setLineDash([]); hctx.beginPath();
		hctx.moveTo(bore[0]-16,bore[1]); hctx.lineTo(bore[0]-6,bore[1]); hctx.lineTo(bore[0],bore[1]+7); hctx.lineTo(bore[0]+6,bore[1]); hctx.lineTo(bore[0]+16,bore[1]); hctx.stroke(); }

	// ---- velocity vector, limited to 10° from the boresight and flashing when limited ----
	// The cage models the HUD field-of-view edge, which the real jet references —
	// NOT an 8° boresight cone: on-speed alpha is 8.1°, so an 8° cage clamped the
	// marker by an invisible 0.1° on every trimmed approach and flashed it
	// continuously while it looked perfectly centred. 10° keeps the trimmed
	// approach steady with gust margin, and still cues a genuinely pegged marker
	// (the catapult fly-away peaks ~10.9° alpha and flashes briefly, as before).
	fpm=proj_dir(ownship.vel_dir);
	let fpm_limited=false;
	if(fpm){ const dx=fpm[0]-bore[0], dy=fpm[1]-bore[1], r=Math.hypot(dx,dy), rmax=10*ppd;
		if(r>rmax){ fpm=[bore[0]+dx/r*rmax,bore[1]+dy/r*rmax]; fpm_limited=true; }
		if(!fpm_limited||(sim_time*6)%2<1){ hctx.strokeStyle=GR; hctx.setLineDash([]); hctx.beginPath(); hctx.arc(fpm[0],fpm[1],6,0,Math.PI*2);
			hctx.moveTo(fpm[0]-6,fpm[1]); hctx.lineTo(fpm[0]-14,fpm[1]); hctx.moveTo(fpm[0]+6,fpm[1]); hctx.lineTo(fpm[0]+14,fpm[1]); hctx.moveTo(fpm[0],fpm[1]-6); hctx.lineTo(fpm[0],fpm[1]-12); hctx.stroke(); } }

	// ---- E bracket (#86): the PA-mode AoA error bracket, left of the velocity vector.
	// FPM centred = on-speed 8.1°; fast pushes the bracket DOWN under the FPM.
	if(fpm && pa && !ownship.grounded){
		const dpp=ppd/(view_zoom||1);   // zoom-independent degrees->px, tracking the view's base field
		const off=THREE.MathUtils.clamp((8.1-(ownship.aoa??8.1))*dpp,-3.5*dpp,3.5*dpp);
		const bx=fpm[0]-30, by=fpm[1]+off, half=1.2*dpp;
		hctx.beginPath(); hctx.moveTo(bx+7,by-half); hctx.lineTo(bx,by-half); hctx.lineTo(bx,by+half); hctx.lineTo(bx+7,by+half);
		hctx.moveTo(bx,by); hctx.lineTo(bx+5,by); hctx.stroke(); }   // centre tick marks on-speed

	// ---- ILS deviation bars, referenced to the velocity vector (replacing the old centred needles) ----
	if(fpm){ const dev=approach_deviation(); if(dev){ hctx.strokeStyle=GR; hctx.setLineDash([]);
		const reach=2.2*ppd, lx=fpm[0]+dev.az*reach, gy=fpm[1]+dev.gs*reach;
		hctx.beginPath(); hctx.moveTo(lx,fpm[1]-reach); hctx.lineTo(lx,fpm[1]+reach); hctx.stroke();
		hctx.beginPath(); hctx.moveTo(fpm[0]-reach,gy); hctx.lineTo(fpm[0]+reach,gy); hctx.stroke(); } }
	}
	if(glass) hctx.restore();

	// ---- targets (#133): the designated target carries the authentic green TD
	// box — the ONLY aircraft marking, in every view; its range/closure live in
	// the fixed right-side data block (the real HUD attaches no text to the
	// target, boxes nothing else, and draws no amber).
	const authentic=cfg.view==="cockpit";
	let boxed=null; let rng=1500; let vc=0;   // vc: closure to the boxed target, m/s (+ = closing) — the data block and the breakaway cue share it
	// Closure from the two VELOCITY vectors along the line of sight, not by
	// differencing range between render frames. The flight cores advance on a
	// fixed 60 Hz accumulator while the display runs at whatever rate it runs
	// at, so above 60 fps the range simply did not change on the frames that
	// stepped nothing: the difference quotient alternated between zero and
	// roughly double the true closure, every frame. That fed the time of
	// flight the director pipper leads on, so the pipper shook — and flipped
	// between two positions fast enough to read as two pippers.
	const closure=(one,two)=>{ const to=new THREE.Vector3(wrap_axis(two.pos.x-one.pos.x),two.pos.y-one.pos.y,wrap_axis(two.pos.z-one.pos.z));
		if(to.lengthSq()<1e-6) return 0;
		to.normalize();
		const mine=new THREE.Vector3(one.velx??one.fwd.x*one.speed,one.vely??one.fwd.y*one.speed,one.velz??one.fwd.z*one.speed);
		const his=new THREE.Vector3(two.velx??two.fwd.x*two.speed,two.vely??two.fwd.y*two.speed,two.velz??two.fwd.z*two.speed);
		return mine.sub(his).dot(to); };   // + = closing
	if(has_enemy){ rng=wrap_distance(ownship.pos,bandit.pos); boxed=bandit; vc=closure(ownship,bandit); }
	else if(MULTIPLAYER&&net){ const dst=remotes.get(designated);   // the pilot's acquisition, not auto-nearest: designate/step/undesignate on the acquire key like the real ACM flow
		if(dst&&dst.group.visible){ boxed=dst; rng=wrap_distance(ownship.pos,dst.pos); vc=closure(ownship,dst); }
		else designated=-1; }

	// 9M seeker tone (#73): the growl/lock audio tracks the seeker itself, not
	// the drawn symbology — the tone keeps playing with the head turned away
	// from the glass, exactly like the real headset.
	let lockon=false;
	if(master==="9m"&&!pa&&boxed){ const to=_v.set(wrap_axis(boxed.pos.x-ownship.pos.x),boxed.pos.y-ownship.pos.y,wrap_axis(boxed.pos.z-ownship.pos.z)); const d=to.length()||1; to.multiplyScalar(1/d);
		// Plume-conditioned acquisition (#255), mirroring the server: a
		// burner-lit nose is lockable to half the envelope, a cold one only
		// close aboard — rear aspect keeps the full reach. The tone tells
		// the truth about what the seeker can actually hold.
		const tail=boxed.fwd?Math.max(0,to.dot(boxed.fwd)):0;
		const floor=0.15+0.35*THREE.MathUtils.clamp(boxed.reheat??0,0,1);
		lockon=ownship.fwd.dot(to)>0.866&&d<5000*(floor+(1-floor)*tail); }
	audio_seeker(game_paused?0:(master==="9m"&&!pa?(lockon?2:1):0));
	// Departure / AoA warning tone (NATOPS 2.8.2.5, #53): yaw-rate intensity
	// from the 40°/s onset to the 60°/s ceiling, steady above 35° AoA. Ground
	// excluded — a HI-mode nosewheel turn yaws faster than the onset.
	{ const o=last_out||[]; const yawrate=Math.abs(o[STATE.omega+1]||0)*57.2958, aoadeg=(o[STATE.alpha]||0)*57.2958;
		const airborne=!ownship.grounded&&!game_paused&&crash_t<=0;
		departure_drive=[airborne&&yawrate>40?+Math.min(1,(yawrate-40)/20).toFixed(2):0, airborne&&aoadeg>35?1:0];
		audio_departure(departure_drive[0], departure_drive[1]===1); }

	// ---- A/A weapon symbology (#133): GUN = funnel free / director pipper on a
	// boxed target, with the gun cross above; 9M = seeker circle + SHOOT cue.
	if(flight_symbols&&master!=="nav"&&!pa){ if(glass){ hctx.save(); glass_clip(glass); }
	const brk=boxed&&rng<(master==="9m"?300:150)+THREE.MathUtils.clamp(vc,0,1000)*1.5;   // breakaway: reaching minimum range within 1.5 s at the current closure — time-based like the real cue, so a 900 kt merge breaks far earlier than a tail-chase (vc clamped: a boxed-target switch in MP spikes one frame)
	const td=boxed?proj_point(boxed.pos):null;
	if(td){ hctx.strokeStyle=GR; hctx.setLineDash([]); hctx.strokeRect(td[0]-14,td[1]-14,28,28); }   // the target designator box — the real (monochrome green) marking, both views
	if(boxed&&!(td&&td[0]>0&&td[0]<HW&&td[1]>0&&td[1]<HH)){   // target locator line (NATIP): the boxed target is off the HUD — a line from the boresight points the shortest way to it, angle-off at the tip
		const to=new THREE.Vector3(wrap_axis(boxed.pos.x-ownship.pos.x),boxed.pos.y-ownship.pos.y,wrap_axis(boxed.pos.z-ownship.pos.z)).normalize();
		const off=Math.acos(THREE.MathUtils.clamp(ownship.fwd.dot(to),-1,1))*57.29578;
		const cs=to.applyQuaternion(_q.copy(camera.quaternion).invert()); const sd=Math.hypot(cs.x,cs.y);
		if(sd>1e-4){ const ux=cs.x/sd, uy=-cs.y/sd;
			hctx.strokeStyle=GR; hctx.setLineDash([]); hctx.lineWidth=2;
			hctx.beginPath(); hctx.moveTo(bore[0]+ux*18,bore[1]+uy*18); hctx.lineTo(bore[0]+ux*70,bore[1]+uy*70); hctx.stroke(); hctx.lineWidth=1.5;
			hctx.fillStyle=GR; hctx.font="12px monospace"; hctx.textAlign="center";
			hctx.fillText(String(Math.round(off)),bore[0]+ux*84,bore[1]+uy*84+4); } }
	if(master==="gun"){
		if(boxed&&td){   // director: a TRUE lead-computing pipper now that rounds fly real time of flight — where my rounds will be, pulled back by where HE will be, so pipper-on-target IS the deflection solution (mirrors battle.Burst exactly); range analog around the ring
			const span=Math.min(rng,2000); const muz=body_offset(ownship,6.0,0.35,0.0);
			// Time of flight from the ROUND'S closing speed along the sight line —
			// NOT aircraft closure: a hard pull swings own velocity off the LOS and
			// collapsed the old round_average+vc denominator to its 200 m/s floor,
			// inflating t to ~10 s; the -targetVel*t pullback then threw the pipper
			// kilometres (the top-of-screen jump under g, 2026-08-10). The round
			// flies at muzzle+ownship speed toward him regardless of own g, so its
			// LOS closing speed stays near round speed through any manoeuvre. The
			// honest own-g effect remains: alpha and gravity DROOP the pipper, and
			// the pilot pulls lead to bring it up — it must never rise above the
			// gun cross from own manoeuvre alone.
			const avg=round_average(span,ownship.pos.y);
			_pad_d.set(wrap_axis(boxed.pos.x-ownship.pos.x),boxed.pos.y-ownship.pos.y,wrap_axis(boxed.pos.z-ownship.pos.z)).normalize();   // sight line (padlock scratch, free at draw time)
			// Time of flight is how long the ROUND takes to fly the span — muzzle
			// speed under drag, plus the pilot's own velocity the round inherits,
			// projected on the line of sight. NO target term: the target's motion
			// decides WHERE you aim (the -targetVel*t pullback below), never how
			// fast the round travels. A first pass wrongly subtracted target
			// velocity here too, so a fast-OPENING bandit (-338 kt) collapsed the
			// denominator to its floor, inflated t to ~6 s, and threw the pipper
			// to the top of the screen in a slow high-alpha fight (2026-08-10).
			const vlos=(ownship.fwd.x*avg+(ownship.velx??0))*_pad_d.x
				+(ownship.fwd.y*avg+(ownship.vely??0))*_pad_d.y
				+(ownship.fwd.z*avg+(ownship.velz??0))*_pad_d.z;
			const t=span/Math.max(vlos,250);
			const air=round_length(ownship.pos.y)*Math.log1p(muzzle*t/round_length(ownship.pos.y));   // barrel-component distance actually covered in t under drag
			const impact=muz.clone().addScaledVector(ownship.fwd,air).addScaledVector(ownship.vel_dir,ownship.speed*t); impact.y-=0.5*9.8*t*t;
			impact.x-=(boxed.velx??boxed.fwd.x*boxed.speed)*t; impact.y-=(boxed.vely??boxed.fwd.y*boxed.speed)*t; impact.z-=(boxed.velz??boxed.fwd.z*boxed.speed)*t;
			const pip=proj_point(impact);
			if(DEV_MODE&&pip){ const bvy=(boxed.vely??boxed.fwd.y*boxed.speed);
				dev_pip={py:Math.round(pip[1]),by:Math.round(bore[1]),t:+t.toFixed(2),rng:Math.round(rng),bvy:Math.round(bvy),
					pullY:Math.round(-bvy*t),gravY:-Math.round(0.5*9.8*t*t),ownY:Math.round(ownship.vel_dir.y*ownship.speed*t)}; }   // decomposition of the vertical impact terms — which one lifts the pipper
			if(pip){ hctx.strokeStyle=GR; hctx.fillStyle=GR; hctx.setLineDash([]);
				hctx.beginPath(); hctx.arc(pip[0],pip[1],4,0,Math.PI*2); hctx.fill();
				hctx.beginPath(); hctx.arc(pip[0],pip[1],11,0,Math.PI*2); hctx.stroke();
				// Range analog, the real director's convention: the arc is
				// PROPORTIONAL to range — full ring at 3,000 ft (~914 m, the
				// dial's full scale on the jet), unwinding clockwise to nothing
				// as the target closes, with the 1,000 ft minimum-range tick.
				// It was inverted (growing on closure, against its own comment)
				// and scaled to 3,000 METRES, so it read backwards and barely
				// moved inside actual gun range.
				// Full scale 3,000 ft (~914 m), the real dial — restored
				// 2026-08-06 when the round got real drag. The 1,500 m scale
				// existed because the no-drag round genuinely reached past a
				// kilometre and the ring pegged where real shots lived; with
				// drag those shots die out the way they do in reality, and
				// the dial and the round tell the same story again. A
				// high-closure face shot still pegs the ring — it does on
				// the jet too, and the SHOOT cue owns that case.
				const fraction=THREE.MathUtils.clamp(rng/914,0,1);
				hctx.lineWidth=2.5; hctx.beginPath(); hctx.arc(pip[0],pip[1],15,-Math.PI/2,-Math.PI/2+fraction*Math.PI*2); hctx.stroke();
				const tick=-Math.PI/2+(305/914)*Math.PI*2;   // 1,000 ft of 3,000: the no-closer cue on the same dial
				hctx.beginPath(); hctx.moveTo(pip[0]+Math.cos(tick)*12,pip[1]+Math.sin(tick)*12); hctx.lineTo(pip[0]+Math.cos(tick)*18,pip[1]+Math.sin(tick)*18); hctx.stroke(); hctx.lineWidth=1.5;
				const miss=Math.hypot(wrap_axis(impact.x-boxed.pos.x),impact.y-boxed.pos.y,wrap_axis(impact.z-boxed.pos.z));   // predicted miss: the pipper point IS the burst's arrival pulled back by his motion, so its distance from him is where the rounds land
				if(rng<900&&miss<12&&!brk&&!weapons_hold&&ownship.rounds>0&&(sim_time*5)%2<1){ hctx.font="16px monospace"; hctx.textAlign="center";   // the director commands the shot only on a VALID solution — in range AND the stream landing on the airframe, not merely a track
					hctx.fillText("SHOOT",pip[0],pip[1]-28); } } }
		else {   // funnel: stadiametric rails a 40 ft wingspan should touch at firing range
			hctx.strokeStyle=GR; hctx.setLineDash([]); hctx.lineWidth=1.2;
			const rails=[[],[]];
			for(let r=250;r<=1400;r+=115){ const l=round_length(ownship.pos.y); const t=(l/muzzle)*Math.expm1(r/l); const muz=body_offset(ownship,6.0,0.35,0.0);
				const at=muz.clone().addScaledVector(ownship.fwd,muzzle*t).addScaledVector(ownship.vel_dir,ownship.speed*t); at.y-=0.5*9.8*t*t;
				const pp=proj_point(at); if(!pp) continue;
				const halfw=Math.atan(5.7/r)*ppd*57.29578;   // half the 11.4 m span at that range, in screen pixels
				rails[0].push([pp[0]-halfw,pp[1]]); rails[1].push([pp[0]+halfw,pp[1]]); }
			for(const rail of rails){ if(rail.length<2) continue; hctx.beginPath(); hctx.moveTo(rail[0][0],rail[0][1]);
				for(let i=1;i<rail.length;i++) hctx.lineTo(rail[i][0],rail[i][1]); hctx.stroke(); }
			hctx.lineWidth=1.5; } }
	if(master==="9m"){
		const seeker=2.5*ppd;   // the 5° seeker circle
		const at=(lockon&&td)?td:bore;
		hctx.strokeStyle=GR; hctx.setLineDash([]); hctx.beginPath(); hctx.arc(at[0],at[1],seeker,0,Math.PI*2); hctx.stroke();
		if(lockon&&!brk&&!weapons_hold&&(sim_time*5)%2<1&&ownship.msl>0){ hctx.fillStyle=GR; hctx.font="16px monospace"; hctx.textAlign="center";   // no SHOOT inside the breakaway regime (the X owns it) or during the joust weapons hold — commanding a launch the trigger will refuse just confuses the merge
			hctx.fillText("SHOOT",at[0],at[1]-seeker-16); } }
	if(brk&&(sim_time*5)%2<1){   // breakaway X (flashing): the 9M can't arm, a gun pass this close eats debris — break off
		const R=2.2*ppd; hctx.strokeStyle=GR; hctx.setLineDash([]); hctx.lineWidth=2.5;
		hctx.beginPath(); hctx.moveTo(bore[0]-R,bore[1]-R); hctx.lineTo(bore[0]+R,bore[1]+R); hctx.moveTo(bore[0]+R,bore[1]-R); hctx.lineTo(bore[0]-R,bore[1]+R); hctx.stroke(); hctx.lineWidth=1.5; }
	if(glass) hctx.restore(); }

	// ---- instrument furniture (#133): NATOPS boxes and scales. On the glass in
	// cockpit view the cluster is clipped to the quad and SCALED into it (the
	// transform maps the virtual layout centred on cx,cy onto the glass).
	if(flight_symbols){ if(glass){ hctx.save(); glass_clip(glass);
		hctx.translate(glass.rcx,glass.rcy); hctx.scale(glass.scale,glass.scale); hctx.translate(-cx,-cy); }
	const ppdv=HH/45;                                   // the virtual layout's pixels per degree (zoom-independent)
	const wly=cy-4*ppdv;                                // the waterline datum: the airspeed/altitude box TOPS sit here (NATOPS)
	const aa=master!=="nav"&&!pa;                       // A/A master modes relocate the heading scale to the bottom
	// ---- heading scale: a moving 30° window with the caret beneath — the value reads off the scale (no digital box on the real HUD); REJ 2 removes the whole group ----
	if(declutter<2){
	const hty=glass?(aa?cy+170:cy-150):(aa?HH-64:46);
	hctx.save(); hctx.strokeStyle=GR; hctx.fillStyle=GR; hctx.textAlign="center"; hctx.font="11px monospace";
	const hdg=(Math.atan2(ownship.fwd.x,-ownship.fwd.z)*180/Math.PI+360)%360; const hppx=7, halfd=15;
	hctx.beginPath(); hctx.moveTo(cx-halfd*hppx,hty); hctx.lineTo(cx+halfd*hppx,hty); hctx.stroke();
	hctx.beginPath(); hctx.rect(cx-halfd*hppx-2,hty-22,halfd*hppx*2+4,40); hctx.clip();
	const m0=Math.ceil((hdg-halfd)/5)*5;
	for(let m=m0;m<=hdg+halfd;m+=5){ const hx=cx+(m-hdg)*hppx; const val=((m%360)+360)%360; const major=(m%10===0);
		hctx.beginPath(); hctx.moveTo(hx,hty); hctx.lineTo(hx,hty-(major?8:4)); hctx.stroke();
		if(major) hctx.fillText(val===0?"36":String(val/10).padStart(2,"0"),hx,hty-16); }
	hctx.restore();
	hctx.fillStyle=GR; hctx.beginPath(); hctx.moveTo(cx,hty+5); hctx.lineTo(cx-5,hty+13); hctx.lineTo(cx+5,hty+13); hctx.closePath(); hctx.fill();
	if(carrier_ols&&master==="nav"){   // command heading marker (NATOPS item 18): TACAN great-circle steering to the carrier, a hollow chevron sliding under the scale; pegs at the window edge when the boat is off-scale. NAV ONLY (#224): selecting an A/A weapon replaces the navigation picture with weapon symbology, as the real jet does — steering home means selecting NAV, or reading the HSI, which keeps its TACAN pointer in every mode
		const brg=(Math.atan2(wrap_axis(CARRIER.x-ownship.pos.x),-wrap_axis(CARRIER.z-ownship.pos.z))*180/Math.PI+360)%360;
		const dd=THREE.MathUtils.clamp(((brg-hdg+540)%360)-180,-halfd,halfd); const mx=cx+dd*hppx;
		hctx.strokeStyle=GR; hctx.setLineDash([]); hctx.beginPath();
		hctx.moveTo(mx-6,hty+21); hctx.lineTo(mx,hty+14); hctx.lineTo(mx+6,hty+21); hctx.stroke(); }
	}

	// ---- airspeed box (left): boxed KCAS, top at the waterline ----
	const kcas=(ownship.cas??ownship.speed)*1.94384; const ax=cx-4.2*ppdv;
	if(!declutter){ hctx.strokeStyle=GR; hctx.fillStyle=GR; hctx.lineWidth=1.5; hctx.setLineDash([]);
		hctx.strokeRect(ax-84,wly,84,30);
		hctx.font="600 20px monospace"; hctx.textAlign="right"; hctx.fillText(String(Math.round(kcas)),ax-8,wly+16); }

	// ---- altitude box (right): BARO or RDR (R suffix; flashing B fallback), NATOPS digit sizing ----
	const baro=ownship.pos.y*3.28084; const lx=cx+4.2*ppdv;
	let alt=baro, radar=false, flashB=false;
	if(alt_radar){ const g=ground_height(ownship.pos.x,ownship.pos.z);
		const agl=(ownship.pos.y-(g>-1e8?Math.max(g,0):0))*3.28084;
		if(agl<=5000){ alt=Math.max(agl,0); radar=true; } else flashB=true; }
	if(!declutter){ hctx.strokeRect(lx,wly,96,30);
		const shown=Math.max(0,Math.round(alt)); const thousands=Math.floor(shown/1000);
		hctx.textAlign="right";
		if(thousands>0){ const restStr=String(shown%1000).padStart(3,"0");
			hctx.font="600 16px monospace"; const rw=hctx.measureText(restStr).width; hctx.fillText(restStr,lx+88,wly+17);
			hctx.font="600 21px monospace"; hctx.fillText(String(thousands),lx+88-rw-2,wly+16); }   // 150% thousands, 120% tail — the NATOPS hierarchy
		else { hctx.font="600 21px monospace"; hctx.fillText(String(shown),lx+88,wly+16); }
		if(radar){ hctx.font="12px monospace"; hctx.textAlign="left"; hctx.fillText("R",lx+101,wly+16); }
		if(flashB&&(sim_time*3)%2<1){ hctx.font="12px monospace"; hctx.textAlign="left"; hctx.fillText("B",lx+101,wly+16); } }

	// ---- vertical velocity above the altitude box (NAV master mode only, per NATOPS) ----
	const vs=ownship.vel_dir.y*ownship.speed*196.85;
	if(master==="nav"){ hctx.font="13px monospace"; hctx.textAlign="left";   // "only displayed in the NAV master mode" — NATOPS 2.13.4.8 item 12; not on the reject list, so it survives REJ 1/2
		hctx.fillText((vs<0?"-":"")+Math.abs(Math.round(vs/10)*10),lx+2,wly-12); }

	// ---- AoA / Mach / G / peak-G block (left-centre); Mach and g are DELETED in the landing configuration ----
	{ hctx.font="13px monospace"; hctx.textAlign="left"; const bxl=ax-84; let dy=wly+52;
		hctx.fillText("\u03b1 "+(ownship.aoa??0).toFixed(1),bxl,dy); dy+=17;   // AoA survives REJ 1 \u2014 the NATOPS reject list names M/g/peak/boxes/bank, not alpha
		if(atc_on){ hctx.fillStyle=AM; hctx.fillText("ATC",bxl,dy); hctx.fillStyle=GR; dy+=17; }   // ATC advisory below the airspeed column, like the real HUD; the slot is free in the landing configuration (Mach/g deleted) and it rides the glass transform in cockpit view
		if(!declutter&&!pa){ const core=last_out;
			hctx.fillText("M "+(((core&&core[STATE.mach])??(ownship.speed/343))).toFixed(2),bxl,dy); dy+=17;
			hctx.fillText("G "+(ownship.gload??1).toFixed(1),bxl,dy); dy+=17;
			if(peak_g>=4) hctx.fillText(peak_g.toFixed(1),bxl+13,dy); }
		}   // the dev turn-rate readout moved to the developer line by the clock \u2014 EM validation data is not HUD symbology

	// ---- bank angle scale (bottom): ticks to 45°; the pointer pegs at 45 and flashes past 47 (NATOPS); dropped in the A/A masters, whose relocated heading scale owns the bottom of the display ----
	if(!declutter&&!aa){ const pivotY=cy+4.2*ppdv, br=3.2*ppdv;
		hctx.strokeStyle=GR; hctx.fillStyle=GR; hctx.setLineDash([]); hctx.lineWidth=1.2;
		for(const b of [-45,-30,-15,-5,0,5,15,30,45]){ const a=b*D2R; const sx=cx+Math.sin(a)*br, sy=pivotY+Math.cos(a)*br;
			const tl=(b===0||Math.abs(b)>=30)?9:5;
			hctx.beginPath(); hctx.moveTo(sx,sy); hctx.lineTo(cx+Math.sin(a)*(br+tl),pivotY+Math.cos(a)*(br+tl)); hctx.stroke(); }
		const bank=Math.atan2(ownship.right.y,ownship.up.y)*57.29578;
		const pegged=Math.abs(bank)>47, shownBank=THREE.MathUtils.clamp(-bank,-45,45)*D2R;
		if(!pegged||(sim_time*5)%2<1){ const px2=cx+Math.sin(shownBank)*br, py2=pivotY+Math.cos(shownBank)*br;
			const ix=cx+Math.sin(shownBank)*(br-9), iy=pivotY+Math.cos(shownBank)*(br-9);
			const tx=Math.cos(shownBank)*5, ty=-Math.sin(shownBank)*5;
			hctx.beginPath(); hctx.moveTo(ix,iy); hctx.lineTo(px2+tx,py2+ty); hctx.lineTo(px2-tx,py2-ty); hctx.closePath(); hctx.fill(); }
		hctx.lineWidth=1.5; }

	// ---- data blocks: TCN slant range to the carrier (lower right), selected weapon (lower left) ----
	hctx.font="13px monospace"; hctx.textAlign="left"; hctx.fillStyle=GR;
	if(carrier_ols&&master==="nav"&&declutter<2){ const slant=Math.hypot(wrap_axis(CARRIER.x-ownship.pos.x),ownship.pos.y,wrap_axis(CARRIER.z-ownship.pos.z))/1852;
		hctx.fillText("TCN "+slant.toFixed(1)+(SHIP.ident?" "+SHIP.ident:""),lx,cy+7.2*ppdv); }   // slant range + the station's ident, like the real data block (REJ 2 removes it; NAV only, with the chevron — #224)
	if(marshal&&!marshal.commenced&&declutter<2){ const left=marshal.push-sim_time;   // Case III push clock (#205): counts down to the assigned EAT, then counts UP the lateness
		hctx.fillStyle=(left<30)?AM:GR; hctx.textAlign="left"; hctx.font="13px monospace";
		hctx.fillText("PUSH "+(left>=0?clock_text(left):"+"+clock_text(-left)),lx,cy+8.1*ppdv); hctx.fillStyle=GR; }
	if(boxed&&aa){   // designated-target range and closure: fixed right-side data block, like the radar-track readouts on the real HUD — never text glued to the target
		hctx.fillText((rng/1852).toFixed(1)+" NM",lx,cy+5.4*ppdv);
		hctx.fillText((vc>0?"+":"")+Math.round(vc*1.94384)+" kt",lx,cy+6.3*ppdv); }
	{ const ly=cy+7.2*ppdv; const bxl=ax-84;
		if(master==="gun"){ hctx.fillStyle=input.guns?AM:GR; hctx.fillText(translate("GUN")+" "+(cheat("ammunition")?"\u221e":ownship.rounds),bxl,ly); hctx.fillStyle=GR; }
		else if(master==="9m") hctx.fillText("9M "+(cheat("ammunition")?"\u221e":ownship.msl),bxl,ly);
		else hctx.fillText("NAV",bxl,ly); }

	// ---- throttle gauge: hud-view furniture only — the real HUD carries no such thing, so it lives at the screen edge with the rest of the game furniture ----
	if(!authentic){ const tgx=30, tgcy=cy, tgh=140; hctx.strokeStyle=GR; hctx.fillStyle=GR; hctx.textAlign="center"; hctx.lineWidth=1.5;
	hctx.strokeRect(tgx-5,tgcy-tgh/2,10,tgh);
	const fh=tgh*(ownship.throttle*0.75+(ownship.burner??0)*0.25); hctx.fillRect(tgx-5,tgcy+tgh/2-fh,10,fh);   // the full lever: 0..75% dry, the top quarter is the AB range
	hctx.beginPath(); hctx.moveTo(tgx-5,tgcy+tgh/2-tgh*0.75); hctx.lineTo(tgx+5,tgcy+tgh/2-tgh*0.75); hctx.stroke();   // MIL detent tick
	hctx.font="11px monospace"; hctx.fillStyle=GR; hctx.fillText("THR",tgx,tgcy-tgh/2-9);
	const thrust=(ownship.spool??ownship.throttle)*100+(ownship.stage??0)*58;   // achieved thrust, % of military power; burner runs to ~158%
	hctx.font="15px monospace"; hctx.fillText(Math.round(thrust)+"%",tgx,tgcy+tgh/2+15);
	if((ownship.stage??0)>0.05){ hctx.font="11px monospace"; hctx.fillText("AB "+Math.max(1,Math.round((ownship.stage??0)*5)),tgx,tgcy+tgh/2+28); } }
	if(glass) hctx.restore(); }   // end of the on-glass instrument cluster

	// ---- gear / hook status (bottom-right) ----
	// Shown only while deployed (like the SPD BK convention): green = down & locked,
	// amber = in transit; nothing drawn in the clean configuration (gear up, hook stowed).
	hctx.textAlign="right"; hctx.font="13px monospace";
	if(ownship.gear<0.99){ hctx.fillStyle=ownship.gear<0.02?GR:AM; hctx.fillText(translate("GEAR"),HW-40,HH-70); }   // GEAR + HOOK stay in every view: no panel lights exist yet (#99), and a gear-up trap is a game-ender
	if((ownship.hook??0)>0.01){ hctx.fillStyle=(ownship.hook??0)>0.98?GR:AM; hctx.fillText(translate("HOOK"),HW-40,HH-52); }
	if(!authentic){   // the rest is hud-view furniture: the real HUD carries no configuration legend (#133)
	if((ownship.speedbrake??0)>0.02){ hctx.fillStyle=AM; hctx.fillText(translate("SPD BK"),HW-40,HH-88); }
	if(flap_select>0){ hctx.fillStyle=GR; hctx.fillText(translate(flap_select===1?"FLAPS HALF":"FLAPS FULL"),HW-40,HH-124); }   // the switch's non-AUTO positions only: AUTO is the silent default
	if(parking){ hctx.fillStyle=AM; hctx.fillText(translate("PARK"),HW-40,HH-142); }   // the parking brake holds the mains: amber, like a caution
	{ const datum=(last_out?last_out[STATE.datum]:0)||0, bank=(last_out?last_out[STATE.bank]:0)||0;   // the trim state, shown only when trimmed away from neutral
		const parts=[];
		if(hud_pa&&Math.abs(datum)>0.0025) parts.push(Math.abs(datum*57.3).toFixed(1)+(datum>0?"NU":"ND"));
		if(Math.abs(bank)>0.004) parts.push(Math.abs(bank*100).toFixed(0)+(bank>0?"RWD":"LWD"));
		if(parts.length){ hctx.fillStyle=GR; hctx.fillText("TRIM "+parts.join(" "),HW-40,HH-160); } }   // amber whenever the air brake is out (keys.md §3)
	if(stab_cycle>0){ hctx.fillStyle=AM; hctx.fillText("STAB "+stab_cycle,HW-40,HH-108); }   // Shift+E calibration state
	if(ownship.lights){ hctx.fillStyle=GR; hctx.fillText(translate("LIGHTS"),HW-40,HH-34); }   // below HOOK
	if((ownship.probe??0)>0.02){ hctx.fillStyle=GR; hctx.fillText(translate("PROBE"),HW-40,HH-22); }   // below LIGHTS
	if((ownship.canopy??0)>0.02){ hctx.fillStyle=GR; hctx.fillText(translate("CANOPY"),HW-40,HH-10); }   // below PROBE
	if((ownship.fold??0)>0.02){ hctx.fillStyle=AM; hctx.fillText(translate("WINGS"),HW-40,HH-124); } }   // amber, above SPD BK: not a flight configuration

	// ---- caution panel (#78): red for fires and the pilot, amber for degraded systems ----
	// Read straight from the core's damage words, so it works identically in SP and MP.
	// Annunciator text stays English by policy — real Hornet cockpits do worldwide.
	{ const RD="#ff5050";   // the stack renders the sim-step model (#47) — building it here left the tone dead outside this view
		hctx.textAlign="left"; hctx.font="13px monospace";
		let cy=HH-118;
		for(const [,label,red] of caution_list){ hctx.fillStyle=red?RD:AM; hctx.fillText(label,40,cy); cy-=18; }
	}
	if(law_active&&running&&(performance.now()%500)<280){   // the break-X (#243): the real jet's unmissable altitude call, flashed across HUD and helmet alike — numbers are exactly what a padlocked pilot stops reading
		hctx.strokeStyle="#ff5040"; hctx.lineWidth=5; hctx.beginPath();
		hctx.moveTo(HW/2-110,HH/2-110); hctx.lineTo(HW/2+110,HH/2+110);
		hctx.moveTo(HW/2+110,HH/2-110); hctx.lineTo(HW/2-110,HH/2+110); hctx.stroke();
		hctx.fillStyle="#ff5040"; hctx.font="bold 30px monospace"; hctx.textAlign="center";
		hctx.fillText("ALTITUDE",HW/2,HH/2+160); }   // annunciator-verbatim, like the caution panel: real Hornet warnings read in English in every operator's cockpit
	if(hit_flash>0){   // rounds are landing on us (#239): an edge-weighted vignette, not a flat wash —
		// the pain lives at the periphery and the pilot keeps the picture. In single
		// player the shooter is known, so the vignette centre shifts AWAY from the
		// bandit's screen direction and the red bites hardest on the threat side.
		let ox=0, oy=0;
		if(!MULTIPLAYER&&has_enemy){ _vig.copy(bandit.pos).sub(camera.position).normalize();
			const sx=_vig.dot(_vigr.setFromMatrixColumn(camera.matrixWorld,0)), sy=_vig.dot(_vigu.setFromMatrixColumn(camera.matrixWorld,1));
			const m=Math.hypot(sx,sy)||1; ox=-sx/m*HW*0.12; oy=sy/m*HH*0.12; }
		const g=hctx.createRadialGradient(HW/2+ox,HH/2+oy,Math.min(HW,HH)*0.32,HW/2+ox,HH/2+oy,Math.max(HW,HH)*0.72);
		g.addColorStop(0,"rgba(255,32,32,0)"); g.addColorStop(0.55,"rgba(255,32,32,"+(hit_flash*0.16).toFixed(3)+")"); g.addColorStop(1,"rgba(255,26,26,"+(hit_flash*0.5).toFixed(3)+")");
		hctx.fillStyle=g; hctx.fillRect(0,0,HW,HH); }

	// ---- weapon legend (bottom-left) ----
	// Cheats show in the symbology: ∞ replaces the counters the cheat makes
	// meaningless, and INVULNERABLE sits just above — so a cheat mission
	// announces itself, to multiplayer joiners as much as the mission owner.
	hctx.textAlign="left"; hctx.font="13px monospace";
	if(cheat("invulnerable")){ hctx.fillStyle=GR; hctx.fillText(translate("INVULNERABLE"),40,HH-106); }
	if(!authentic&&MULTIPLAYER&&net&&net.welcome&&net.welcome.spawn&&net.welcome.spawn.mode==="teams"){   // team score (game furniture): red and blue running totals above the stores legend
		hctx.fillStyle="#ff5a48"; hctx.fillText("RED "+(net.score.red||0),40,HH-142);
		hctx.fillStyle="#5a86ff"; hctx.fillText("BLUE "+(net.score.blue||0),40,HH-124); hctx.fillStyle=GR; }
	if(!authentic&&comms.length){   // the radio/chat log (#84): top-left, scrolling, fading — game furniture, never in the authentic cockpit. Single player too since the Case III radio script (#205)
		const cnow=performance.now(); comms=comms.filter(c=>c.until>cnow);
		hctx.save(); hctx.textAlign="left"; hctx.font="15px ui-monospace, SFMono-Regular, Menlo, monospace";
		let cy=128;
		for(const c of comms){ hctx.globalAlpha=Math.min(1,(c.until-cnow)/2000);
			hctx.fillStyle="#00000090"; hctx.fillText(c.text,41,cy+1);
			hctx.fillStyle=c.colour; hctx.fillText(c.text,40,cy); cy+=19; }
		hctx.restore(); }
	if(!authentic&&repeat&&!map_on){   // DDI repeater panel (#12): one display's live face in the corner — game furniture, HUD view only; the same canvas the pit textures, sized for the panel by screens_update
		const sc=(ownship.group.userData.screens||[]).find(s=>s.display===repeat);
		if(sc){ const size=repeat_size(), ox=HW-size-24, oy=HH-size-24;   // bottom-right: the stores counters own the bottom-left
			hctx.save(); hctx.shadowBlur=0;
			hctx.drawImage(sc.canvas,ox,oy,size,size);
			hctx.strokeStyle="#2a2f33"; hctx.lineWidth=2; hctx.strokeRect(ox-1,oy-1,size+2,size+2);
			hctx.fillStyle="#8fa0aa"; hctx.font="12px monospace"; hctx.textAlign="left"; hctx.textBaseline="middle";
			hctx.fillText(repeat==="center"?"AMPCD":repeat==="left"?"LEFT DDI":"RIGHT DDI",ox,oy-10);
			hctx.restore(); } }
	if(!authentic){   // stores furniture (hud view): the FULL counter set — the authentic data block shows only the selected weapon, so without these the other weapon's count is invisible; the IFEI fuel belongs to the cockpit panel, kept here for the fullscreen view
	hctx.fillStyle=input.guns?AM:GR;
	hctx.fillText(translate("GUN")+"  "+(cheat("ammunition")?"∞":ownship.rounds),40,HH-88); hctx.fillStyle=GR;
	hctx.fillText("9M  "+(cheat("ammunition")?"∞":ownship.msl),40,HH-70);
	hctx.fillText(translate("FLARES")+"  "+(cheat("ammunition")?"∞":ownship.cm),40,HH-52);
	if(cheat("fuel")) hctx.fillText(translate("FUEL")+"  ∞",40,HH-34);   // the tank is frozen: no pounds, no LO/BINGO colours
	else { const pounds=Math.round(((ownship.fuel??0)+(ownship.external??0))*2.2046/10)*10;   // the IFEI headline is TOTAL fuel, externals included (#17) — they burn first, so this is the number that counts down from the top
		if((ownship.fuel??1e9)<FUELLO) hctx.fillStyle=(sim_time%0.8<0.4)?"#ff5050":"#803030";   // FUEL LO flashes (internal — the feed-tank hardware caution)
		else if(((ownship.fuel??1e9)+(ownship.external??0))<BINGO) hctx.fillStyle="#ffb050";
		hctx.fillText(translate("FUEL")+"  "+pounds,40,HH-34); hctx.fillStyle=GR; } }

	// ---- catapult prompt ----
}

// ============================================================================ perf
const ft_ring=new Array(180).fill(16.7); let ft_i=0, accumulator=0;
function refresh_perf(dt){ ft_ring[ft_i]=dt*1000; ft_i=(ft_i+1)%ft_ring.length;   // frame-time ring (dynamic_res reads it)
	accumulator+=dt; if(accumulator<0.25 || !framerate) return; accumulator=0;        // fps + 1% low readout, ~4 Hz
	if(!cfg.framerate){ framerate.style.display="none"; return; }                     // gated by the graphics setting (default off)
	framerate.style.display="block";
	const s=[...ft_ring].sort((a,b)=>a-b), avg=s.reduce((x,v)=>x+v,0)/s.length, low=s[Math.floor(s.length*0.99)];
	framerate.textContent=Math.round(1000/avg)+" fps · "+Math.round(1000/low)+" 1% low"; }

// ============================================================================ sizing
// Supersample: render the scene at SUPERSAMPLE× the device resolution and let the blit downscale (SSAA).
// This is the only thing that smooths *texture-baked* detail like the carrier deck markings at grazing
// angles — anisotropy already maxed, but the lines are inside the texture so MSAA can't touch them.
// Kept separate from render_scale (the dyn-res perf knob, capped at 1.0) so it isn't scaled away or
// clobbered by a saved cfg. GATED TO dpr 1 (#148): a HiDPI screen already samples the deck textures at
// 2× density, so 1.5× SSAA there bought nothing visible while costing 2.25× the pixels ON TOP of the
// dpr — measured 26.7 -> 46.5 fps on an Arc iGPU at dpr 2 with SSAA off, no sharpness loss. At dpr 1
// (where the markings genuinely alias) it stays, and that config holds 60 fps.
function supersample(dpr){ if(Number.isFinite(SSAA_OVERRIDE)) return SSAA_OVERRIDE;   // &ssaa=X (dev) pins it for benchmarking
	return dpr>1.25?1.0:1.5; }
function apply_size(){ const w=innerWidth,h=innerHeight,dpr=Math.min(devicePixelRatio||1,2),sc=THREE.MathUtils.clamp(cfg.render_scale,0.3,2.0)*dpr*supersample(dpr);
	renderer.setSize(Math.round(w*sc),Math.round(h*sc),false); canvas.style.width=w+"px"; canvas.style.height=h+"px";
	camera.aspect=w/h; camera.updateProjectionMatrix(); cockpit_cam.aspect=w/h; cockpit_cam.updateProjectionMatrix(); hud_resize(); if(cloud_active()||rt) size_rt(); }
addEventListener("resize",apply_size,{ signal });
let dyn_cd=0, dyn_ceiling=2.0, dyn_ceiling_t=0, dyn_strain=0, dyn_health=0;
function dynamic_res(dt){ if(!cfg.dyn_res) return; dyn_cd-=dt; if((dyn_ceiling_t-=dt)<=0) dyn_ceiling=2.0; if(dyn_cd>0) return; dyn_cd=0.5;
	const last=ft_ring.slice(-30), recent=last.reduce((s,v)=>s+v,0)/30, spike=[...last].sort((a,b)=>a-b)[27];   // mean + p90 of the last 30 frames
	if(recent>18&&cfg.render_scale>0.45){ dyn_ceiling=Math.min(dyn_ceiling,cfg.render_scale); dyn_ceiling_t=30;   // this scale overloaded: don't climb back into it for a while
		cfg.render_scale=Math.max(0.45,cfg.render_scale-0.1); apply_size(); dyn_strain=0; dyn_health=0; }
	else if(recent>18){   // pinned at the floor and STILL over budget: the honest "this machine cannot hold it" verdict (#55), measured on the player's real scene. Only real gameplay under real acceleration counts — shader-compile stutter, the pause menu and SwiftShader must not condemn the machine.
		dyn_health=0;
		if(graphics_verdict===null&&running&&!loading&&!game_paused&&(dyn_strain+=0.5)>=30){ dyn_strain=0; shellStorage.setItem("air.performance","1"); } }
	// Raise while SOLIDLY vsynced. The old <14 ms test could never pass on a 60 Hz
	// display (a pegged frame reads 16.7 ms), so any loading stutter ratcheted the
	// scale to the floor permanently. Pegged-with-margin now qualifies (mean under
	// 17.2, p90 tight). A machine that pegs at scale S but overloads at S+0.05
	// would otherwise hunt forever (raise -> overload -> drop -> raise...), so the
	// overloaded scale becomes a 30 s ceiling and the governor settles one step
	// below it; raises are also slower (2 s) than drops (0.5 s).
	else if(recent<17.2&&spike<17.5&&cfg.render_scale<1.0&&cfg.render_scale+0.05<dyn_ceiling-0.001){ cfg.render_scale=Math.min(1.0,cfg.render_scale+0.05); dyn_cd=2; apply_size(); dyn_strain=0; }
	else if(recent<17.2&&cfg.render_scale>=1.0){ dyn_strain=0;   // holding FULL scale vsynced: the machine verdict self-heals (an upgraded GPU should not wear last year's warning)
		if((dyn_health+=0.5)>=30){ dyn_health=0; shellStorage.removeItem("air.performance"); } } }

// Benchmark reporting (#148): the sampler itself lives in bench.ts (imported
// first, so it survives an engine-init failure); here we hand it the resolved
// quality knobs and honour the &dynres override once cfg exists.
if(BENCH_PARAMS&&BENCH_PARAMS.get("bench")){
	const dynq=BENCH_PARAMS.get("dynres"); if(dynq==="1") cfg.dyn_res=true; else if(dynq==="0") cfg.dyn_res=false;
	// Submission-cost probe (#197): accumulate the CPU time spent INSIDE
	// renderer.render (WebGL command building + submission — the main-thread cost
	// a slow driver inflates). acc_* fields are cumulative; bench.ts diffs them
	// across the sample window and reports per-frame values.
	let submit_ms=0;
	const raw_render=renderer.render.bind(renderer);
	renderer.render=(s,c)=>{ const t0=performance.now(); raw_render(s,c); submit_ms+=performance.now()-t0; };
	bench_register(()=>({ scale:+cfg.render_scale.toFixed(2), ssaa:supersample(Math.min(devicePixelRatio||1,2)), msaa:!MSAA_OFF, dyn:!!cfg.dyn_res, clouds:cfg.clouds,
		acc_submit:+submit_ms.toFixed(1), draws:renderer.info.render.calls, tris:renderer.info.render.triangles, progs:(renderer.info.programs||[]).length, texs:renderer.info.memory.textures, geoms:renderer.info.memory.geometries }));
}

// ============================================================================ UI / menu
function cockpit_hidden(){ for(const o of ownship.group.userData.cockpitHide||[]) o.visible = cfg.view!=="cockpit"; }   // hide the pilot's head in first person; every external view keeps him
function set_view(v){
	if(v==="ddi" && cfg.view==="ddi"){ const d=DDI_ORDER[(DDI_ORDER.indexOf(ddi_focus())+1)%DDI_ORDER.length];   // re-press cycles left -> right -> AMPCD; the choice persists like zoom_<view>
		cfg.ddi=d; if(on_config) on_config({ ddi:d }); ddi_view_last=0; return; }
	if(v==="ddi") ddi_view_last=0;   // entering: draw the remembered display's face this frame
	if(v==="chase" && cfg.view!=="chase") cam_psi=Math.atan2(ownship.fwd.x,ownship.fwd.z);   // entering chase: reference the orbit to the current heading (no half-compass ease-in)
	if(v==="chase" && cfg.view==="chase"){ cam_az=0; cam_el=0.22; cam_dist=24; }   // re-press recentres the orbit (keys.md §4)
	if(v==="flypast") flyby_pos=null;   // (re)seed a fresh flyby each time it's selected
	if(v!==cfg.view) hist_valid=false;   // a view switch is a camera CUT: reprojecting cloud history across it smears the old view over the new one for a beat
	zoom_target=zoom_recall(v); view_zoom=zoom_target;   // each view wakes at its remembered zoom (#209) — no ease across the cut
	cfg.view=v;
	cockpit_hidden();
}
function apply_effects(){ renderer.shadowMap.enabled=cfg.shadows; sun.castShadow=cfg.shadows; effects_limits();
	const setc=g=>g.traverse(c=>{ if(c.isMesh&&(c.userData.body||c.userData.modelmesh))c.castShadow=cfg.shadows; }); setc(ownship.group); setc(bandit.group); }

// ============================================================================ multiplayer
// The server is authoritative (world/games/air runs the same placeholder
// kinematics); fly_player keeps running as the local predictor and is
// corrected from snapshots — snap when >20 m off (minimum-image), gentle pull
// otherwise. Remote players are interpolated ~100 ms behind live; the first
// reuses the bandit airframe, the rest get their own.
let net=null, flare_flag=false, missile_flag=false, session_over=false;
let net_notice="", net_notice_t=0;
let comms=[];   // the radio/chat log (#84): {text, colour, until} — top-left, hud-view furniture (multiplayer chat + the Case III radio script)
function comm(text,colour){ comms.push({ text:String(text).slice(0,80), colour, until:performance.now()+10000 }); while(comms.length>5) comms.shift(); }
function chat_scope(){ return (net&&net.welcome&&net.welcome.spawn&&net.welcome.spawn.mode==="teams")?"team":"all"; }
function exit_match(){ if(!running) return; running=false; /* #57 parked: head_close(); */
	if(MULTIPLAYER) net_finish("left");
	else net_record({   // EVERY completed flight is history (#212): a scoreless sortie or a carrier approach is exactly the one you want the recording of, and the cheat flag is data on the row, never a filter
		world:"local", session:"local-"+mission_began, mode:cfg.task==="joust"?"joust":"free", team:"",
		started:mission_began, ended:Date.now(),
		reason:own_kills>0?"victory":(own_deaths>0?"killed":"flown"),
		players:cfg.task==="joust"?"2":"1", kills:own_kills, deaths:own_deaths,
		cheated:(cfg.cheats&&Object.values(cfg.cheats).some(Boolean))?1:0 });
	// ...then upload the recording against that row, so it outlives the session
	// (#213). Deliberately after net_record and unawaited: the row must exist
	// for the save to bind to, and the menu should never wait on an upload.
	if(!MULTIPLAYER){ const replay=recording_file();
		if(replay) setTimeout(()=>void recording_store(replay.session,mission_began,replay.text),600); }
	if(onExit) onExit(); }
let mission_began=Date.now();   // local session identity for the history's replay-dedup key
let own_kills=0, own_deaths=0, match_started=0;
const remotes=new Map();   // slot -> aircraft state
let designated=-1;   // multiplayer L&S designation: the remote slot the pilot acquired (-1 = none) — HUD state only, like the real jet (the missile's seeker hunts its own cone)
// acquire_target: ACM boresight acquisition (#133) — designate the target nearest
// the nose within a 20° cone out to 10 nm; press again with the designated target
// still in the cone to STEP to the next candidate; an empty cone undesignates.
// This is the real change-of-target flow: undesignate/point/re-acquire.
function acquire_target(){
	const cone=[];
	for(const [slot,st] of remotes.entries()){ if(!st.group||!st.group.visible) continue;
		const dx=wrap_axis(st.pos.x-ownship.pos.x), dy=st.pos.y-ownship.pos.y, dz=wrap_axis(st.pos.z-ownship.pos.z);
		const d=Math.hypot(dx,dy,dz)||1; if(d>18520) continue;
		const off=(ownship.fwd.x*dx+ownship.fwd.y*dy+ownship.fwd.z*dz)/d;
		if(off>0.94) cone.push({slot,off}); }
	cone.sort((a,b)=>b.off-a.off);
	if(!cone.length){ designated=-1; return; }
	const at=cone.findIndex(c=>c.slot===designated);
	designated=cone[(at+1)%cone.length].slot;
}
function notice(text,secs){ net_notice=text; net_notice_t=secs||3; }   // the single centre-banner slot; each call REPLACES the last (the LSO grade, BOLTER and REARMED all route through here so they can never overprint each other)
// Team liveries (#130): the separately-named rig subtrees double as paint
// masks — the rudder nodes ride the tail fins and the folding outer panels
// are the wingtips, so tinting them flies team colours without touching the
// merged airframe. Materials are shared across the GLB: clone before painting.
const LIVERY=/rudder_percent_key_AN|wing_outer_AN/i;
function apply_livery(group, team){
	const color=team?new THREE.Color(team==="red"?0xc03028:0x2858c0):null;
	group.traverse(o=>{ if(!o.isMesh||!o.material) return;
		let node=o, hit=false;
		while(node&&node!==group){ if(LIVERY.test(node.name||"")){ hit=true; break; } node=node.parent; }
		if(!hit) return;
		if(!o.userData.liveried){ o.material=o.material.clone(); o.userData.base=o.material.color.clone(); o.userData.liveried=true; }
		if(color) o.material.color.copy(o.userData.base).lerp(color,0.8);
		else o.material.color.copy(o.userData.base);
	});
}
function remote_for(slot){ let st=remotes.get(slot); if(st) return st;
	if(![...remotes.values()].includes(bandit)) st=bandit;
	else { st=make_state(new THREE.Vector3(0,3000,0),new THREE.Vector3(1,0,0),200); st.group=make_jet(); scene.add(st.group); if(model_active) apply_model_to(st.group); }
	remotes.set(slot,st); st.group.visible=true;
	remote_racks(st,slot);   // the roster's granted loadout, when it has already arrived (#17)
	st.msl=st.msl??(st.loadout?stores_rounds(st.loadout).length:magazine()); update_rails(st,st.msl); return st; }
// remote_racks applies a remote jet's roster loadout: the roster event can
// land before or after the first pose, so both paths call this. A LATER
// roster with different stores is a jettison (#18) — the vanished pieces
// fall away and the new loadout applies.
function remote_racks(st,slot){ if(!net) return;
	const lo=net.racks&&net.racks.get(slot);
	if(!lo) return;
	const next=stores_normalize(lo);
	if(st.loadout){
		if(JSON.stringify(st.loadout)===JSON.stringify(next)) return;
		const gone=[];
		for(let station=2;station<=8;station++){
			const before=st.loadout[String(station)]; if(!before||!before.fixture) continue;
			const keep=new Set(stores_entries(station,next[String(station)]||{fixture:"",stores:[]}));
			for(const name of stores_entries(station,before)) if(!keep.has(name)) gone.push(name); }
		separate_debris(st, gone); }
	assign_loadout(st, next);
	if(st.msl===undefined) st.msl=stores_rounds(st.loadout).length;
	else st.msl=Math.min(st.msl, stores_rounds(st.loadout).length);
	update_rails(st, st.msl); }
let racks_seen=0;   // the net racksRevision already applied to the remote fleet
function remote_drop(slot){ const st=remotes.get(slot); if(!st) return; remotes.delete(slot); audio_remote_drop("r"+slot);
	if(st===bandit){ st.group.visible=false; }
	else { scene.remove(st.group); st.group.traverse(o=>{ if(o.isMesh&&o.material&&o.material.dispose)o.material.dispose(); }); } }
// apply_own_state adopts an authoritative state. reset=true (spawn/respawn)
// also restores the clean control configuration; a mid-flight snap correction
// (e.g. after a background tab wakes far off the prediction) must keep the
// pilot's throttle/gear/hook/speedbrake untouched.
function apply_own_state(state,reset=true){ if(!state||!state.position) return;
	ownship.pos.set(state.position[0],state.position[1],state.position[2]);
	ownship.vel_dir.set(state.direction[0],state.direction[1],state.direction[2]).normalize();
	ownship.q.set(state.attitude[1],state.attitude[2],state.attitude[3],state.attitude[0]);   // wire is [w,x,y,z]; THREE is (x,y,z,w)
	ownship.fwd.set(1,0,0).applyQuaternion(ownship.q); ownship.up.set(0,1,0).applyQuaternion(ownship.q); ownship.right.set(0,0,1).applyQuaternion(ownship.q);
	ownship.speed=state.speed;
	if(reset){ ownship.throttle=0.85;
		ownship.gearTarget=1; ownship.gear=1; ownship.hookTarget=0; ownship.hook=0; ownship.speedbrakeTarget=0; }
	ownship.grounded=false; ownship.trapped=false; ownship.launching=false;
	ownship.group.position.copy(ownship.pos); ownship.group.quaternion.copy(ownship.q); }
function remote_nearest(){ let best=null, range=1e12;
	for(const st of remotes.values()){ if(!st.group.visible) continue;
		const d=(st.pos.x-ownship.pos.x)**2+(st.pos.y-ownship.pos.y)**2+(st.pos.z-ownship.pos.z)**2;
		if(d<range){ best=st; range=d; } }
	return best; }
function net_event(e){ const slot=Number(e.slot);
	switch(e.kind){
	case "kill":
		if(net&&slot===net.slot){ own_deaths++;
			if(crash_t<=0){ crash_t=3.0; explosion_at(ownship.pos.x,ownship.pos.y,ownship.pos.z); ownship.group.visible=false; ownship.speed=0; } }
		else { if(Array.isArray(e.position)) explosion_at(e.position[0],e.position[1],e.position[2]);
			const st=remotes.get(slot); if(st) st.group.visible=false;
			if(net&&Number(e.by)===net.slot){ own_kills++; notice(translate("KILL")); } }
		if(net&&Number(e.by)>=0&&Number(e.by)!==net.slot){ const killer=Number(e.by); const myteam=net.teams.get(net.slot);   // SPLASH (#146): a teammate's kill, straight off the kill event — no server change, log only
			if(myteam&&net.teams.get(killer)===myteam) comm((net.names.get(killer)||"")+": "+translate("SPLASH"),"#ffd27f"); }
		break;
	case "respawn":
		if(net&&slot===net.slot){ apply_own_state(e.state); flight_push(); crash_t=0; ownship.group.visible=true; net_waiting=false; update_rails(ownship, ownship.msl); }   // in a joust the match-starting double-respawn releases the waiting room
		else { const st=remotes.get(slot); if(st){ st.msl=magazine(); update_rails(st,st.msl); } }   // a fresh jet comes with fresh rails
		break;
	case "missile":
		if(net&&slot!==net.slot){ const st=remotes.get(slot); if(st&&st.msl>0){ st.msl--; update_rails(st,st.msl); } }   // his wingtip empties as he shoots
		break;
	case "fighton": weapons_hold=false; notice(translate("FIGHT'S ON")); break;   // the server saw the merge (#87)
	case "flare": if(net&&slot!==net.slot){ const st=remotes.get(slot); if(st) dispense_flares(st); } break;
	case "hit": if(net&&slot===net.slot&&e.count){ hit_flash=Math.min(1,hit_flash+0.25*Number(e.count)); audio_hit(Number(e.count)); } break;   // the server says rounds are landing on us
	case "eject": case "pilot":
		if(net&&slot===net.slot&&!(e.kind==="eject"&&ejected)) notice(translate(e.kind==="eject"?"EJECTED":"PILOT DOWN"));   // our own eject already shows the banner
		break;   // the airframe flies on as a wreck; the kill event handles scoring and the fireball
	case "explode": { const st=(net&&slot===net.slot)?ownship:remotes.get(slot); if(st) explosion_at(st.pos.x,st.pos.y,st.pos.z); break; }
	case "splash": if(Array.isArray(e.position)) explosion_at(e.position[0],e.position[1],e.position[2],"water"); break;   // a wreck met the sea: pale steam/spray rather than an orange fuel ball
	case "join": if(!net||slot!==net.slot) notice((e.name||"")+" "+translate("JOINED")); break;
	case "leave": remote_drop(slot); notice((e.name||"")+" "+translate("LEFT")); break;
	case "call": {   // wingman brevity calls (#139): radio is team-scoped, callsigns verbatim, call words localised
		if(!net) break;
		const myteam=net.teams.get(net.slot); if(!myteam||net.teams.get(slot)!==myteam) break;
		const name=net.names.get(slot)||"";
		let call="";
		if(e.call==="engaged") call=name+": "+translate("ENGAGED");
		else if(e.call==="break"&&Number(e.target)===net.slot) call=name+": "+translate(e.direction==="right"?"BREAK RIGHT":"BREAK LEFT");   // direction words are relative to the warned pilot — nobody else's business
		else if(e.call==="missile"&&Number(e.target)===net.slot) call=name+": "+translate("MISSILE");   // a wingman saw the plume you didn't (#146)
		if(call){ notice(call,4); comm(call,"#ffd27f"); }   // urgent on the banner, and a copy in the log so it survives being replaced (#84)
		else if(e.call==="tally") comm(name+": "+translate("TALLY"),"#ffd27f");   // flavour tier (#146): the log only — the banner stays reserved for the calls that save lives
		else if(e.call==="rejoin") comm(name+": "+translate("REJOINING"),"#ffd27f");
		break; }
	case "chat": {   // match chat (#84): server-sanitized and team-scoped; player text renders verbatim, never translated
		if(!net) break;
		const name=e.name||net.names.get(slot)||"";
		const team=e.scope==="team";
		const tint=team?(net.teams.get(net.slot)==="red"?"#ff9d8f":"#8fb8ff"):"#ffffff";
		comm((team?"["+translate("TEAM")+"] ":"")+name+": "+(e.text||""),tint);
		break; }
	} }
function net_finish(reason){ if(session_over) return; session_over=true;
	if(net&&match_started){ net_record({ world:join.server, session:join.session,
		mode:String(net.welcome&&net.welcome.spawn&&net.welcome.spawn.mode||"furball"),   // the session's real mode (this recorded every match as a joust before)
		team:net.teams.get(net.slot)||"",
		started:match_started, ended:Date.now(), reason,
		players:JSON.stringify([...remotes.keys()].length+1), kills:own_kills, deaths:own_deaths,
		cheated:(cfg.cheats&&Object.values(cfg.cheats).some(Boolean))?1:0 }); }   // mark cheated matches so an honest history stays honest (the match rules from the welcome populate cfg.cheats)
	if(net){ net.leave(); net=null; } }
function net_end(reason,results){ if(session_over) return;
	net_finish(reason);
	if(results&&results.name){ notice(results.name+" "+translate("WINS")); }   // joust outcome
	else notice(translate("SESSION ENDED"));
	setTimeout(()=>{ if(running){ running=false; if(onExit) onExit(); } },1800); }
function net_frame(dt){
	{ const moved=net&&racks_seen!==net.racksRevision; if(moved) racks_seen=net.racksRevision;
		for(const [slot,st] of remotes.entries()){ if(!st.loadout||moved) remote_racks(st,slot); } }   // adopt a late roster grant (#17); re-apply on any stores change — a mid-flight jettison (#18)
	const c=last_controls;
	const sample={ pitch:c?c.pitch:input.pitch*cfg.sens, roll:c?c.roll:input.roll*cfg.sens, yaw:c?c.yaw:input.yaw*cfg.sens,
		throttle:ownship.throttle, speedbrake:ownship.speedbrakeTarget??0,
		reheat:ownship.burner??0, brake:input.brake, trim:input.trim||0, lean:input.lean||0, reset:reset_flag, flap:flap_select,
		gear:(ownship.gearTarget??0)<0.5, hook:(ownship.hookTarget??0)>0.5, probe:(ownship.probeTarget??0)>0.5,   // wire gear/hook: true = down/deployed
		override:c?c.override:false, dump:fuel_dump, port:secured[0], starboard:secured[1],
		fire:input.guns&&!ownship.launching&&(ownship.gear??0)>0.98, flare:flare_flag, missile:missile_flag, eject:eject_flag };
	const sequence=net.input(sample);
	if(sequence>0){ flare_flag=false; missile_flag=false; eject_flag=false; }
	// Prediction: the wire sample IS the sample the core flew, so the mark ring
	// replays exactly what the server applies. The mark covers every fixed step
	// since the previous send (input sends are capped at the tick rate).
	const predicting=flight_active && net.cored && net.welcome && net.welcome.spawn && net.welcome.spawn.model===flight_version();
	if(sequence>0 && flight_active && c){ flight_mark({...c, sequence}, marked_steps); marked_steps=0; }
	if(predicting && crash_t<=0){
		const fix=net.correction();
		if(fix){
			_v.copy(ownship.pos);   // present position under the old prediction
			const divergence=flight_ack(fix.sequence, fix.core);
			sync_core(flight_get());   // adopt the replayed present
			_v.sub(ownship.pos);       // the visual discontinuity at this instant
			if(divergence<0 || _v.length()>20 || _v.length()<0.02) render_offset.set(0,0,0);   // hard snap (or nothing to hide)
			else render_offset.add(_v); // decay it on the render group only
		}
	} else {
		const own=net.own();
		if(own&&own.alive&&crash_t<=0){
			const dx=wrap_axis(own.position[0]-ownship.pos.x), dy=own.position[1]-ownship.pos.y, dz=wrap_axis(own.position[2]-ownship.pos.z);
			if(Math.hypot(dx,dy,dz)>20){ apply_own_state(own,false); flight_push(); }   // way off (e.g. a woken background tab): snap the dynamics, keep the pilot's controls
			else if(!flight_active){ const k=Math.min(1,dt*3);
				ownship.pos.x+=dx*k; ownship.pos.y+=dy*k; ownship.pos.z+=dz*k; wrap_position(ownship.pos);
				ownship.speed+=(own.speed-ownship.speed)*k;
				_q.set(own.attitude[1],own.attitude[2],own.attitude[3],own.attitude[0]);
				ownship.q.slerp(_q,Math.min(1,dt*1.5)); ownship.q.normalize(); } }
	}
	{ const mine=net.teams.get(net.slot)||"";
		if(ownship.livery!==mine&&model_active){ apply_livery(ownship.group,mine); ownship.livery=mine; } }
	// The ownship's own damage, from the server's copy of it (#40). Single
	// player fills these from the local battle cascade; multiplayer never did,
	// so the pilot's own fire warnings, flame and fuel mist were the only ones
	// in the match nobody could see.
	{ const mine=net.self();
		if(mine){ own_burn[0]=mine.burn[0]; own_burn[1]=mine.burn[1]; own_burning=!!mine.burning; own_leak=mine.leak;
			if(mine.alive){ const worst=Math.max(own_burn[0],own_burn[1],own_burning?1:0);
				if(worst>0) burn_trail(ownship.pos,worst,ownship.velx,ownship.vely,ownship.velz);
				if(own_leak>0.1) leak_trail(ownship.pos,own_leak,ownship.velx,ownship.vely,ownship.velz); } } }
	const seen=new Set();
	for(const slot of net.slots()){ const pose=net.remote(slot); if(!pose) continue; seen.add(slot);
		const st=remote_for(slot);
		st.pos.set(pose.position[0],pose.position[1],pose.position[2]); st.speed=pose.speed;
		st.group.quaternion.set(pose.attitude[1],pose.attitude[2],pose.attitude[3],pose.attitude[0]);
		st.group.position.copy(st.pos);
		st.fwd.set(1,0,0).applyQuaternion(st.group.quaternion);
		st.velx=st.fwd.x*pose.speed; st.vely=st.fwd.y*pose.speed; st.velz=st.fwd.z*pose.speed;
		st.gearTarget=pose.gear?0:1; st.hookTarget=pose.hook?1:0; st.speedbrakeTarget=pose.speedbrake;
		st.name=pose.name; st.group.visible=pose.alive;
		{ const team=net.teams.get(slot)||"";
			if(st.livery!==team&&model_active){ apply_livery(st.group,team); st.livery=team; } }
		st.firing=!!(pose.alive&&pose.fire);
		if(st.firing){ dev_fired++; fire_gun(st,ownship,"r"+slot,dt,true); }   // his trigger rides the pose flags: tracers stream from his nose (visual only — the server scores the real rounds)
		if(pose.alive){ const rdx=st.pos.x-ownship.pos.x, rdy=st.pos.y-ownship.pos.y, rdz=st.pos.z-ownship.pos.z;
			const range=Math.hypot(rdx,rdy,rdz)||1;
			const closure=-((st.velx-ownship.velx)*rdx+(st.vely-ownship.vely)*rdy+(st.velz-ownship.velz)*rdz)/range;
			audio_remote("r"+slot, st.pos.x, st.pos.y, st.pos.z, closure, !!pose.reheat); }
		else audio_remote_drop("r"+slot);
		if(pose.alive){ const burning=Math.max(pose.burn?pose.burn[0]:0, pose.burn?pose.burn[1]:0);   // #78: the damage you inflicted shows on their jet
			if(burning>0) burn_trail(st.pos,burning,st.velx,st.vely,st.velz);
			if((pose.thrust||0)>0.06) engine_smoke(st.pos,pose.thrust,st.velx,st.vely,st.velz);   // harmless no-op on wires that do not carry it
			if((pose.leak||0)>0.1) leak_trail(st.pos,pose.leak,st.velx,st.vely,st.velz); } }
	for(const slot of [...remotes.keys()]) if(!seen.has(slot)) remote_drop(slot);
	update_darts(dt); }
// Server missiles ("darts", net.darts): every missile near the player rides
// the poses datagram as position+velocity+shooter. Render everyone ELSE's —
// the own launch already flies a local visual — dead-reckoned between the
// 20 Hz snapshots, with the same reduced-smoke trail as the local missiles.
const darts_pool=[]; const _dart_axis=new THREE.Vector3(1,0,0); const _dart_q=new THREE.Quaternion();
function update_darts(dt){
	if(!net) return;
	while(darts_pool.length<6){ const mesh=new THREE.Mesh(missile_geo,missile_mat); mesh.visible=false; scene.add(mesh); darts_pool.push({mesh,acc:0}); }
	const age=(performance.now()-(net.dartsAt||0))/1000;   // seconds since the dart set arrived
	let used=0;
	for(const d of (net.darts||[])){
		if(d.shooter===net.slot) continue;
		if(used>=darts_pool.length) break;
		const p=darts_pool[used++]; p.mesh.visible=age<1.0;   // a stale set (detonated, or out of the top six) disappears rather than flying on forever
		const x=d.position[0]+d.velocity[0]*age, y=d.position[1]+d.velocity[1]*age, z=d.position[2]+d.velocity[2]*age;
		p.mesh.position.set(x,y,z);
		_v.set(d.velocity[0],d.velocity[1],d.velocity[2]);
		if(_v.lengthSq()>1){ _dart_q.setFromUnitVectors(_dart_axis,_v.normalize()); p.mesh.quaternion.copy(_dart_q); }
		if(!p.mesh.visible) continue;
		p.acc+=dt; const puff=0.02;
		while(p.acc>puff){ p.acc-=puff; const k=pool_spawn(smoke); if(k<0) break;
			smoke.px[k]=x; smoke.py[k]=y; smoke.pz[k]=z; smoke.vx[k]=(Math.random()-0.5)*6; smoke.vy[k]=(Math.random()-0.5)*6+2; smoke.vz[k]=(Math.random()-0.5)*6;
			smoke.ttl[k]=smoke.life[k]=2.8; smoke.sz[k]=0.30+Math.random()*0.12; smoke.gr[k]=0.40; smoke.r[k]=0.7; smoke.g[k]=0.72; smoke.b[k]=0.75; } }
	for(let i=used;i<darts_pool.length;i++) darts_pool[i].mesh.visible=false;
}
function net_connect(){
	net_dial(join,{ event:net_event, end:(reason,results)=>net_end(reason||"finished",results), close:()=>net_end("gone") })
	.then((n)=>{ net=n; match_started=Date.now();
		if(n.welcome&&n.welcome.spawn){ apply_own_state(n.welcome.spawn.state); net_waiting=!!n.welcome.spawn.waiting; weapons_hold=n.welcome.spawn.mode==="joust";
			const rules=n.welcome.parameters||{};   // session-owned weather (#107): the match creator's sky wins over local preferences — every player flies the same clouds and clock
			if(typeof rules.tod==="string"&&TOD[rules.tod]){ cfg.tod=rules.tod; apply_time_of_day(cfg.tod); }
			if(typeof rules.clouds==="string"&&(rules.clouds==="none"||CLOUDS[rules.clouds])){ cfg.clouds=rules.clouds; apply_clouds(); } }
		apply_model_all();   // the welcome names the server-assigned aircraft; re-apply in case the picker had another type
		const rules=(n.welcome&&n.welcome.parameters)||{};   // the creator's weather + rules apply to every participant
		if(rules.tod==="day"||rules.tod==="night"){ cfg.tod=rules.tod; apply_time_of_day(cfg.tod); apply_effects(); }
		if(typeof rules.clouds==="string"&&["none","cumulus","high_stratus","low_stratus"].includes(rules.clouds)){
			cfg.clouds=rules.clouds; apply_clouds(); if(cloud_active()) size_rt(); }   // apply_clouds runs even for "none": it zeroes the overcast/shadow uniforms on the ocean and sky
		missiles_rule=rules.missiles===true;   // the creator's rule clamps the FLOWN loadout (#17): strip(cfg.stores) when forbidden, the persisted choice untouched
		assign_loadout(ownship, loadout()); ownship.msl=magazine(); update_rails(ownship, ownship.msl);
		cfg.cheats=(rules.cheats&&typeof rules.cheats==="object")?rules.cheats:{};   // the creator's match cheats: the server enforces them; the client mirrors the ammo gates so the HUD counters and the launch gate agree
		})
	.catch((error)=>{ console.error("air multiplayer:", error);   // the HUD shows the headline; the console keeps the cause
		notice(translate("CONNECTION FAILED")); setTimeout(()=>{ if(running){ running=false; if(onExit) onExit(); } },1800); }); }

function start_mission(){
	set_view("hud");   // every mission starts in HUD view — a cockpit/chase choice is per-flight, not sticky across missions
	const devq=new URLSearchParams(DEV_MODE?window.location.search:"");   // dev/screenshot hooks (#105), parsed ONLY in developer mode: force a cloud preset / time of day / inject damage
	const cloudq=devq.get("clouds"); if(cloudq!==null) cfg.clouds=cloudq;
	const todq=devq.get("tod"); if(todq!==null) cfg.tod=todq;
	harm_pending=devq.get("harm");
	// #57 parked: dev_head=devq.get("head")==="1";   // &head=1: force head tracking on for headless verification (#57)   // ?harm=wing|engine|leak|jam — inject damage into the live core a few seconds in (headless verification of the presentation layer)
	livery_pending=devq.get("livery");   // ?livery=red|blue — paint ownship that side and the bandit the other (headless livery verification)
	const viewq=devq.get("view"); if(viewq) set_view(viewq);   // ?view=cockpit|hud|chase — headless capture hook (#105)
	const storesq=devq.get("stores");   // &stores=gun|fox2|cap|tanks|right — headless loadout hook (#17): presets plus a three-tank fit and a starboard-only tank (the port/starboard sign check)
	if(storesq){ const extra={
		tanks:{ 1:{fixture:"rail",stores:["9m"]}, 3:{fixture:"pylon",stores:["tank"]}, 5:{fixture:"pylon",stores:["tank"]}, 7:{fixture:"pylon",stores:["tank"]}, 9:{fixture:"rail",stores:["9m"]} },
		right:{ 7:{fixture:"pylon",stores:["tank"]} } };
		const pick=stores_presets[storesq]||extra[storesq];
		if(pick){ cfg.stores=stores_normalize(pick); assign_loadout(ownship, loadout()); ownship.msl=magazine(); update_rails(ownship, ownship.msl); } }
	dev_fps=parseFloat(devq.get("fps")||"0")||0; dev_jitter=devq.get("jitter")==="1";   // ?fps=N + ?jitter=1: forced frame dt with optional stutter spikes
	const scq=devq.get("scenario"); if(scq!==null){ const n=parseInt(scq)||0; const arm=setInterval(()=>{ if(TESTS[n]&&TESTS[n].carrier?carrier_ols:airports.length){ clearInterval(arm); start_test(n); } }, 500); }   // &scenario=N: fire a landing test once ITS surface data exists (carrier scenarios need the OLS survey, not just the airfield list) — a fixed 3 s timer lost the race to the map load and the hook silently never ran
	const startq=devq.get("start"); if(startq){ cfg.start=startq; cfg.task="free"; }
	sweep_pending=devq.get("sweep");   // &sweep=<rig name> — wall-clock sweep of one rig entry (visible motion even in a ~5-frame headless capture)
	{ const azq=devq.get("az"); if(azq!==null){ set_view("chase"); cam_az=parseFloat(azq)||0; const elq=parseFloat(devq.get("el")||""); if(!isNaN(elq)) cam_el=elq; const dq=parseFloat(devq.get("dist")||""); if(!isNaN(dq)) cam_dist=dq; } }   // &az=<rad>[&el=&dist=] — headless chase-camera pose without relocating (unlike ?shot)
	{ const pq=devq.get("probe"); if(pq){ const [px,py]=pq.split(",").map(Number); dev_probe={x:px,y:py}; } }   // &probe=x,y (viewport fractions) — raycast that pixel each second and print the hit on the dev HUD (headless artifact identification)
	build_ocean(cfg.ocean_segments);
	apply_time_of_day(cfg.tod); apply_effects();
	apply_clouds(); if(cloud_active()) size_rt();   // runs even for "none": zeroes the overcast/shadow uniforms on the ocean and sky
	has_enemy=(cfg.task==="joust")&&!MULTIPLAYER; bandit.group.visible=has_enemy;   // multiplayer: the bandit airframe is a remote player's, posed from snapshots
	// The &ddi page hook applies AFTER reset_ownship (#48): the case start's
	// master-mode recall (#15) otherwise clobbered it, so headless captures
	// silently got the recalled set instead of the pages they asked for.
	reset_ownship(); apply_size();
	{ const dq=devq.get("ddi"); if(dq) for(const part of dq.split(",")){ const [d,p]=part.split(":"); const st=ddi_state[d]; if(!st) continue;
		if(DDI_PAGES[p]){ ddi_show(d,p); } else if(p==="tac"||p==="supt") st.menu=p; } }   // &ddi=left:eng,center:supt — headless page/menu selection for captures; records into the mode set like a real pick (#15)
	menu_hold=false; map_on=false; map_el.style.display="none";
	loading=!assets_ready(); loading_t0=performance.now();   // hold the LOADING screen until every async asset is in — no piecemeal pop-in of carrier/airfield/airframe
	cloud_mat.uniforms.uDebug.value=0;   // clear the Shift+C cloud A/B latch — a stale debug toggle must not survive into a fresh mission
	running=true; mission_began=Date.now(); own_kills=0; own_deaths=0; /* #57 parked: head_begin(); */   // fresh history identity and score per mission — module state survives remounts, and a reused session key would dedup the next joust away
	mission_done=false; mission_zero=sim_time;   // a fresh mission may follow an ended one without a page reload (#240)
	on_config=onConfig||null; on_over=onOver||null; zoom_target=zoom_recall(cfg.view); view_zoom=zoom_target;   // the starting view wakes at its remembered zoom (#209)
	recorder.clear(); record_started=new Date(); record_session="local-"+mission_began; live_recording=recording_file;   // a fresh recording per mission (#212)
	// Dev/screenshot preset: ?fly=1&shot=<az>,<el>,<alt>,<dist> — low pass over open water,
	// chase camera at the given azimuth/elevation. Judging water needs an external low view.
	const shotp=DEV_MODE?new URLSearchParams(window.location.search).get("shot"):null;
	if(shotp!==null){ const [saz,sel,salt,sdist]=shotp.split(",").map(Number);
		setTimeout(()=>{ try{
			flight_level(CARRIER.x+2500, isNaN(salt)?100:salt, CARRIER.z+2500, 0.9, -0.45, 120, 2450);
			set_view("chase"); cam_az=isNaN(saz)?2.4:saz; cam_el=isNaN(sel)?0.10:sel; cam_dist=isNaN(sdist)?40:sdist;
		}catch(e){ console.warn("shot preset failed", e); } }, 6000); }
	try{ window.focus(); stage.focus(); }catch{ /* focus best-effort */ }
}
function assets_ready(){ return !!carrier_model && model_active && airports.length>0 && flight_ready(); }   // the async loads: carrier GLB (+deck aids), fighter GLB, map/airfield, flight core wasm

// ============================================================================ boot
apply_time_of_day(cfg.tod); apply_effects(); apply_size();
help_el.style.display="none";   // controls list lives in the pause window now (shown while paused via P)
addEventListener("pointerdown",()=>{ audio_gesture(); try{ window.focus(); }catch{ /* focus best-effort */ } },{ signal });   // clicks are user activations too: without this, a mouse-started carrier mission is silent until the first keypress

function menu_backdrop(){ const a=performance.now()*0.00007; const r=440;
	camera.position.set(CARRIER.x+Math.cos(a)*r, CARRIER.deckY+70, CARRIER.z+Math.sin(a)*r);
	camera.up.set(0,1,0); camera.lookAt(CARRIER.x,CARRIER.deckY+12,CARRIER.z);
	ownship.group.visible=true; ownship.group.position.copy(ownship.pos); ownship.group.quaternion.copy(ownship.q); bandit.group.visible=false; }

const clock=new THREE.Clock();
function frame(){ let dt=Math.min(clock.getDelta(),0.05);
	if(DEV_MODE&&running){ const bk=Math.abs(Math.atan2(ownship.right.y,ownship.up.y))*180/Math.PI; if(bk>dev_peakbank&&bk<170) dev_peakbank=bk;
		const pt=Math.asin(Math.max(-1,Math.min(1,ownship.fwd.y)))*180/Math.PI; if(pt>dev_pitchhi)dev_pitchhi=pt; if(pt<dev_pitchlo)dev_pitchlo=pt; }   // true per-frame peak bank + pitch extent for #72
	if(DEV_MODE&&dev_fps>0){ dt=1/dev_fps; if(dev_jitter&&Math.random()<0.25) dt=0.05; }   // dev: force a fixed frame dt (?fps=N); ?jitter=1 randomly spikes to the 0.05 clamp to mimic real stutter (#72)
	if(DEV_MODE&&dt>0){ const sp=ownship.speed||1;   // instantaneous turn rate: how fast the velocity vector rotates
		const vx=ownship.velx/sp, vy=ownship.vely/sp, vz=ownship.velz/sp;
		const dot=Math.min(1,Math.max(-1,vx*turn_probe.x+vy*turn_probe.y+vz*turn_probe.z));
		const rate=Math.acos(dot)/dt*180/Math.PI;
		if(rate<200) turn_probe.rate+=(rate-turn_probe.rate)*Math.min(1,dt*8);   // EMA; ignore teleports/respawns
		turn_probe.x=vx; turn_probe.y=vy; turn_probe.z=vz; }
	game_paused = running && !MULTIPLAYER && (map_on || menu_hold);
	audio_enable(cfg.sound!==false && running && !game_paused);   // FIRST thing every frame — silence must not depend on anything below surviving (silent in the menu, paused, and the SP map)
	audio_volumes(cfg.volume);
	if(running && loading){   // hold on a black LOADING screen, then jump straight to the fully rendered scene (no piecemeal pop-in)
		{ const parts={ carrier:!!carrier_model, aircraft:model_active, map:airports.length>0, core:flight_ready() };   // load profiling: stamp each gate the first time it opens, report the breakdown once done
			for(const k of Object.keys(parts)) if(parts[k]&&load_marks[k]===undefined) load_marks[k]=performance.now()-loading_t0;
			load_pending=Object.keys(parts).filter(k=>!parts[k]); }
		if(assets_ready()){ loading=false;
			console.warn("[load] "+Object.entries(load_marks).map(([k,v])=>k+" "+(v/1000).toFixed(2)+"s").join(" · ")+" · total "+((performance.now()-loading_t0)/1000).toFixed(2)+"s");
			if(MULTIPLAYER && !net) net_connect(); }   // dial only NOW: connecting before the assets exist left the link idle for the whole download (slow connections were dropped mid-load and bounced back to the menu)
		else { const lp=load_progress();
			// A slow load is a slow load — the percentage moves and the player waits. Failure is a
			// FAILED fetch or 20 s with no byte anywhere: the old fixed 20 s wall-clock cap
			// force-started missions with missing models whenever the connection was merely slow.
			if(lp.failed || lp.idle>20000){ loading=false;
				console.error("air load failed:", lp.failed?"fetch error":"stalled", load_pending.join(","));
				notice(translate("LOADING FAILED")); setTimeout(()=>{ if(running){ running=false; if(onExit) onExit(); } },1800); }
			else { draw_loading(); __raf=requestAnimationFrame(frame); return; } }
	}
	if(running){
		if(!game_paused){ ocean_mat.uniforms.u_time.value+=dt; step_world(dt); }   // frozen world stops advancing
		update_camera(dt);
	} else { ocean_mat.uniforms.u_time.value+=dt; menu_backdrop(); }
	if(map_on&&running){ const pad=read_gamepad(); if(pad) scan_zoom(pad,pad_bindings(pad)); }   // the map pauses the world (read_input stops): poll the wheel here so it still zooms the map
	if(!map_on&&zoom_wheel&&running&&!game_paused){ zoom_target=THREE.MathUtils.clamp(zoom_target*Math.pow(3,zoom_wheel*4*dt),zoom_floor(),4); zoom_persist(); }   // axis-form wheels steer the target too
	view_zoom+=(zoom_target-view_zoom)*Math.min(1,dt*10);   // ease toward the notch target — direct FOV steps read as jerky
	{ const base=cfg.view==="cockpit"?72:45;   // wide field in the pit — at 45° the glareshield swallowed the canopy; 45° elsewhere keeps the HUD's 1:1 glideslope
		const fov=base/view_zoom; if(Math.abs(camera.fov-fov)>0.01){ camera.fov=fov; camera.updateProjectionMatrix(); cockpit_cam.fov=fov; cockpit_cam.updateProjectionMatrix(); } }
	if(ocean){ ocean.position.x=camera.position.x; ocean.position.z=camera.position.z; }
	sky.position.copy(camera.position); stars.position.copy(camera.position);
	// Resize BEFORE rendering: setSize clears the drawing buffer, so a dyn-res
	// step after the render composited one black frame per adjustment (visible
	// as black flicker while the governor hunted). Stepping first means the
	// resized buffer is repainted below before the compositor ever sees it.
	refresh_perf(dt); dynamic_res(dt);
	render_frame();
	stage.style.cursor=(running && !game_paused && cfg.view!=="ddi" && !PANEL_POINT)?"none":"";   // hide the mouse pointer while in flight; restore it in the menu / when paused — and head-down or panel-measuring, where the mouse IS the hand on the panel
	if(running){ draw_hud();
		if(net_notice_t>0){ net_notice_t-=dt; hud_message(net_notice); } } else hctx.clearRect(0,0,HW,HH);
	if(map_on){ const zf=Math.pow(2.2,dt), pr=map_range*dt*0.9;   // held − zooms out, = zooms in (smooth; wheel does notches); arrows pan, scaled to the zoom
		if(keys.has("Minus")) map_range=Math.min(MAP_RANGE_MAX,map_range*zf);
		if(keys.has("Equal")) map_range=Math.max(MAP_RANGE_MIN,map_range/zf);
		if(zoom_wheel) map_range=THREE.MathUtils.clamp(map_range*Math.pow(2.2,-zoom_wheel*4*dt),MAP_RANGE_MIN,MAP_RANGE_MAX);   // the thumbwheel zooms the MAP while it's up (same notch gain as the view zoom)
		if(keys.has("ArrowLeft")) map_px-=pr; if(keys.has("ArrowRight")) map_px+=pr;
		if(keys.has("ArrowUp")) map_pz-=pr; if(keys.has("ArrowDown")) map_pz+=pr;
		draw_map(); }
	__raf = requestAnimationFrame(frame); }
function draw_loading(){ hctx.clearRect(0,0,HW,HH); hctx.fillStyle="#000"; hctx.fillRect(0,0,HW,HH);   // opaque: covers the half-built 3D scene beneath
	hctx.textAlign="center"; hctx.fillStyle=AM; hctx.font="22px monospace";
	const lp=load_progress();   // real download percentage across the byte-counted assets (models + flight core)
	hctx.fillText(translate("LOADING")+".".repeat(1+Math.floor(performance.now()/400)%3)+(lp.percent>0&&lp.percent<100?" "+lp.percent+"%":""), HW/2, HH/2);
	if(load_pending.length){ hctx.font="12px monospace"; hctx.fillStyle="#8fa4b8"; hctx.fillText(load_pending.join(" · "), HW/2, HH/2+24); hctx.font="20px monospace"; } }   // what the gate is still waiting on — the answer to "what is taking so long
start_mission();
if(MULTIPLAYER && !loading) net_connect();   // assets already cached: dial at once; otherwise the loading gate dials on completion
__raf = requestAnimationFrame(frame);
void init_external_model(cfg.aircraft||"fa18c");   // one airframe today: ownship, bandit, and remotes all fly it (a second type would preload here too)
init_carrier_model();
void flight_load();   // the wasm flight core loads alongside the GLBs; assets_ready() gates on it

  function stop() {
    // #57 parked: head_close()
    if (MULTIPLAYER) net_finish('left')
    audio_enable(false)   // the frame-loop gate dies with the RAF below — silence the surviving AudioContext explicitly, or its loops play on under the menu
    try { __ac.abort() } catch { /* ignore */ }
    cancelAnimationFrame(__raf)
    try { renderer.dispose() } catch { /* ignore */ }
  }
  // Re-enter a game paused by Esc (running was set false; state is preserved).
  // Re-applies any settings changed in the menu that take effect live — sensitivity,
  // invert, render scale, shadows, time of day. Mission, start, clouds and ocean
  // detail only take effect on a Restart (a fresh start_mission).
  function resume(updated) {
    if (updated) {
      Object.assign(cfg, updated)
      sanitize_cfg()
      apply_size()
      apply_effects()
      apply_time_of_day(cfg.tod)
    }
    running = true
    try { stage.focus() } catch { /* ignore */ }
  }
  return { stop, resume,
    recording: recording_file,   // kept on the handle for callers that already hold one
    exit: exit_match,
    pause: (on) => { menu_hold = !!on },   // the Esc popup: freezes the SP world (game_paused gates on !MULTIPLAYER — it cannot freeze a server) without the P-pause banner/controls
    chat: (words, scope) => { if (MULTIPLAYER && net && running) net.chat(String(words).slice(0, 200), scope) },
    scope: chat_scope,
  }
}
