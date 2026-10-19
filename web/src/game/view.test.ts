// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'

// The recording's View channel (#70): "the view zoomed in with no input" could
// not be checked against anything, because nothing recorded the view, its zoom
// or what moved them. Every change is now noted with its source and drained
// into the ownship's samples. engine.ts cannot be imported (WebGL at module
// scope), so the functions are lifted as text and run with stand-ins.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
function lift(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`${name} not found in engine.ts`)
  const rest = source.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  if (!end) return rest
  const cut = end.index + 1
  return rest.startsWith('\n}', cut) ? rest.slice(0, cut + 2) : rest.slice(0, cut) // a closing brace on its own line is the function's
}
// line returns the one source line holding a fragment
function line(fragment: string): string {
  const lines = source.split('\n').filter((l) => l.includes(fragment))
  expect(lines, fragment).toHaveLength(1)
  return lines[0]
}

type Rig = { events: string[]; zoom: number; view: string; padlocked: boolean }
// rig runs a body in the HUD view at 1x, the HUD view's saved zoom 1.38 and
// the chase view's 1, with the clock at 12.34 s
function rig(body: string): Rig {
  return new Function('THREE', `let sim_time=12.34, running=true, map_on=false, padlocked=false, look_home=false, head_az=0, head_el=0;
    let zoom_target=1, view_zoom=1, zoom_save=0, view_events=[], zoom_wheel=0, game_paused=false, dt=1/60;
    const cfg={ view:"hud", zoom_hud:1.38, zoom_chase:1, ddi:"left" }, HUD_FIELD=60, on_config=null, window={ setTimeout:()=>1 }, clearTimeout=()=>{};
    let ddi_view_last=0, cam_psi=0, cam_az=0, cam_el=0, cam_dist=0, flyby_pos=null, hist_valid=true;
    const ownship={ fwd:{x:0,z:1} }, cockpit_hidden=()=>{}, ddi_open=()=>{}, ddi_range=()=>{}, DDI_ORDER=["left","right","center"], ddi_focus=()=>cfg.ddi, ddi_state={}, DDI_PAGES={};
    ${['view_note', 'zoom_floor', 'zoom_recall', 'zoom_persist', 'zoom_to', 'zoom_step', 'latch', 'set_view', 'view_reset'].map(lift).join('\n')}
    ${body}
    return { events:view_events, zoom:zoom_target, view:cfg.view, padlocked };`)(THREE) as Rig
}

describe('the View channel', () => {
  it('opens each match on the view and zoom it began with, and drops what came before', () => {
    const start = line('view_events.length=0; view_note("view",cfg.view,"start")')
    const s = rig(`view_note("map","open","key"); zoom_target=zoom_recall(cfg.view); view_zoom=zoom_target; ${start}`)
    expect(s.events).toEqual(['12.3|view|hud|start', '12.3|zoom|1.38|start'])
  })

  it('notes a zoom notch with its source', () => {
    expect(rig('zoom_step(1,"key");').events).toEqual(['12.3|zoom|1.18|key'])
    expect(rig('zoom_step(-1,"stick");').events).toEqual(['12.3|zoom|0.85|stick'])
  })

  it('folds a zoom that keeps moving from one source into its pending entry', () => {
    const s = rig('zoom_step(1,"stick"); sim_time=12.4; zoom_step(1,"stick");')
    expect(s.events).toEqual(['12.4|zoom|1.39|stick'])
  })

  it('keeps zooms from different sources apart, and a zoom drained to a sample', () => {
    expect(rig('zoom_step(1,"key"); zoom_step(1,"stick");').events).toHaveLength(2)
    expect(rig('zoom_step(1,"key"); view_events.splice(0); zoom_step(1,"key");').events).toEqual(['12.3|zoom|1.39|key'])
  })

  it('notes nothing when the zoom cannot move: at its limit, or outside a match', () => {
    expect(rig('zoom_target=4; zoom_step(1,"key");').events).toEqual([])
    expect(rig('running=false; zoom_step(1,"key");').events).toEqual([])
  })

  it('names the wheel, the held keys and a zoom axis as the sources of their zooms', () => {
    expect(line('zoom_to(zoom_target*Math.pow(1.5,notch),')).toContain('zoom_to(zoom_target*Math.pow(1.5,notch),"wheel")')
    expect(line('zoom_to(zoom_target*Math.pow(2.4,sweep),')).toContain('zoom_to(zoom_target*Math.pow(2.4,sweep),"key")')
    const axis = line('zoom_to(zoom_target*Math.pow(3,zoom_wheel*4*dt),')
    const s = rig(`zoom_wheel=0.5; for(let i=0;i<30;i++){ sim_time+=1/60; ${axis}\n}`) // the line ends in a comment
    expect(s.events).toHaveLength(1)
    expect(s.events[0]).toBe('12.8|zoom|3.00|axis') // half the axis for half a second: 3 to the power 0.5 x 4 x 0.5
  })

  it('notes a view switch and the zoom the new view recalls', () => {
    expect(rig('set_view("chase","key"); set_view("hud","stick");').events).toEqual([
      '12.3|view|chase|key',
      '12.3|view|hud|stick',
      '12.3|zoom|1.38|view',
    ])
  })

  it('notes nothing for a press of the view already shown, and the display a DDI re-press picks', () => {
    expect(rig('set_view("hud","key");').events).toEqual(['12.3|zoom|1.38|view'])
    expect(rig('zoom_target=1.38; set_view("hud","key");').events).toEqual([])
    expect(rig('set_view("ddi","key"); view_events.splice(0); set_view("ddi","key");').events).toEqual(['12.3|display|right|key'])
  })

  it('notes a reset, the padlock it lets go and the zoom it restores', () => {
    expect(rig('zoom_target=1.38; padlocked=true; view_reset("stick");').events).toEqual([
      '12.3|padlock|off|stick',
      '12.3|reset|hud|stick',
      '12.3|zoom|1.00|reset',
    ])
  })

  it('takes its sources from the key handler: the keyboard, or a stick button replayed as a key', () => {
    expect(line('source=e.isTrusted?"key":"stick"')).toContain('const ch=(e.shiftKey?"Shift+":"")+k, source=e.isTrusted?"key":"stick";')
    for (const call of [
      'set_view("cockpit",source)',
      'else set_view("hud",source)',
      'set_view("ddi",source)',
      'set_view("chase",source)',
      'set_view("flypast",source)',
      'set_view("padlock",source)',
      'set_view(cfg.view==="cockpit"?"hud":"cockpit",source)',
      'view_reset(source)',
      'look_press(source)',
      'zoom_step(1,source)',
      'zoom_step(-1,source)',
      'view_note("map",map_on?"open":"closed",source)',
    ])
      expect(source, call).toContain(call)
    expect(source).toContain('if(down) zoom_step(action==="zoom.in"?1:-1,"stick")')
    expect(source).toContain('if(action==="view") set_view(cfg.view==="cockpit"?"hud":"cockpit","stick")')
    expect(source).toContain('set_view("hud","start");   // every mission starts in HUD view')
  })

  it('drains into the ownship sample on a frame the recorder keeps', () => {
    expect(source).toContain('...(due&&view_events.length?{view:view_events.splice(0).join(";")}:{}),')
  })
})
