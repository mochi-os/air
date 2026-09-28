// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The DDI pages against NATOPS (#24): the EADI (2.13.4.3), the engine monitor
// display (2.1.1.7.6) and the HSI (2.13.4.7). engine.ts cannot be imported
// (WebGL at module scope), so each page's draw is lifted as text and run
// against a recording context with stand-ins for the engine's state.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
function lift(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`${name} not found in engine.ts`)
  const rest = source.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  return end ? rest.slice(0, end.index + 1) : rest
}
interface Drawn { text: [string, number, number][]; rects: [number, number, number, number][]; arcs: [number, number, number][]; rotate: number[]; moves: [number, number][]; styled: [string, number, number][] }
function page(name: string, setup: string, display = 'left'): Drawn {
  const run = new Function(`const D2R=Math.PI/180, NM=1852, THREE={MathUtils:{clamp:(v,lo,hi)=>Math.min(hi,Math.max(lo,v))}};
    ${setup}
    ${lift('ddi_legend')} ${lift(name)}
    const text=[], rects=[], arcs=[], rotate=[], moves=[], styled=[]; let style='';
    const x=new Proxy({}, { get:(t,k)=>{ if(k==='fillText') return (s,px,py)=>text.push([String(s),px,py]); if(k==='strokeRect') return (a,b,c,d)=>rects.push([a,b,c,d]); if(k==='arc') return (ax,ay,r)=>arcs.push([ax,ay,r]); if(k==='rotate') return (a)=>rotate.push(a); if(k==='moveTo') return (mx,my)=>{ moves.push([mx,my]); styled.push([style,mx,my]); }; if(k==='measureText') return (s)=>({ width:10*String(s).length }); return ()=>{}; }, set:(t,k,v)=>{ if(k==='strokeStyle') style=v; return true; } });
    ${name}(x, ${JSON.stringify(display)}); return { text, rects, arcs, rotate, moves, styled };`)
  return run() as Drawn
}
// The bank gauge every attitude display reads, lifted from the gauges block and
// evaluated for a jet facing +x rolled right: the right wing (+z) dips.
function bank_right(degrees: number): number {
  const expression = /\n\township\.gauges=\{[\s\S]*?\n\t\tbank:(.*?),(?:\s*\/\/[^\n]*)?\n/.exec(source)?.[1] ?? ''
  if (!expression) throw new Error('the bank gauge not found in engine.ts')
  const r = degrees * Math.PI / 180
  const ownship = { right: { x: 0, y: -Math.sin(r), z: Math.cos(r) }, up: { x: 0, y: Math.cos(r), z: Math.sin(r) } }
  return new Function('ownship', `return ${expression}`)(ownship) as number
}
// The pointer's tip: the one path start at that radius from the display centre.
const tip = (d: Drawn, cx: number, cy: number, radius: number) => d.moves.filter(([mx, my]) => Math.abs(Math.hypot(mx - cx, my - cy) - radius) < 1e-6)
const texts = (d: Drawn) => d.text.map((t) => t[0])
const at = (d: Drawn, s: string) => d.text.find((t) => t[0] === s)?.slice(1)

describe('the EADI page', () => {
  const setup = (yaw: number, source: string) => `const ownship={ cas:100, speed:100, gauges:{ pitch:10*D2R, bank:0, yaw:${yaw}, altitude:1500, vspeed:-480, slip:0 } };
    const alt_radar=false, adi_source=${JSON.stringify(source)}, approach_deviation=()=>null;`
  it('draws the zenith circle and the nadir circle with a cross on the ball', () => {
    const d = page('ddi_adi', setup(0, 'ins'))
    const ppd = 5.2, off = 10 * ppd
    expect(d.arcs.some(([ax, ay, r]) => ax === 0 && Math.abs(ay - (off - 90 * ppd)) < 1e-9 && r === 10)).toBe(true)
    expect(d.arcs.some(([ax, ay, r]) => ax === 0 && Math.abs(ay - (off + 90 * ppd)) < 1e-9 && r === 10)).toBe(true)
  })

  it('puts the turn indicator\'s lower box under an end box at a standard rate turn', () => {
    const cx = 256, cy = 246, R = 186, sy = cy + R + 12
    const level = page('ddi_adi', setup(0, 'ins'))
    expect(level.rects).toContainEqual([cx - 12, sy + 12, 24, 16])
    const standard = page('ddi_adi', setup(3 * Math.PI / 180, 'ins'))
    expect(standard.rects).toContainEqual([cx + 60 - 12, sy + 12, 24, 16])
    expect(standard.rects).toContainEqual([cx + 60 - 12, sy - 8, 24, 16]) // the end box it sits under
    expect(texts(level)).not.toContain('slip') // the slip ball went with it
  })

  it('shows airspeed and altitude boxed at the top left, the source beside and vertical velocity above', () => {
    const d = page('ddi_adi', setup(0, 'ins'))
    expect(at(d, '194')).toEqual([22, 89]) // 100 m/s in knots, in the airspeed box
    expect(at(d, '1500')).toEqual([22, 125])
    expect(at(d, 'BARO')).toEqual([130, 125])
    expect(at(d, '-480')).toEqual([22, 60])
    expect(d.rects).toContainEqual([16, 74, 88, 30])
    expect(d.rects).toContainEqual([16, 110, 104, 30])
  })

  it('offers INS and STBY at the bottom, boxes the source and switches it on a press', () => {
    const d = page('ddi_adi', setup(0, 'stby'))
    expect(texts(d)).toContain('INS')
    expect(texts(d)).toContain('STBY')
    const press = new Function(`let adi_source='stby'; ${lift('adi_press')}
      const a=adi_press(20), s1=adi_source; const b=adi_press(19), s2=adi_source; const c=adi_press(17); return [a,s1,b,s2,c];`)() as [boolean, string, boolean, string, boolean]
    expect(press).toEqual([true, 'ins', true, 'stby', false])
    expect(source).toMatch(/adi:\{draw:ddi_adi,press:adi_press\}/)
    expect(source).toMatch(/adi_source=\(st==="runway"\|\|st==="carrier"\)\?"stby":"ins";/)
  })
})

// In a right bank the world turns anticlockwise about the jet: the attitude
// ball and ladder turn that way, a sky pointer at the top swings left, and a
// pointer at the bottom (the HUD's) swings right.
describe('the attitude pages in a right bank', () => {
  const gauges = `pitch:0, bank:${bank_right(30)}, yaw:0, slip:0, altitude:1500, vspeed:0, casKt:250, mach:0.4, fpm:0, heading:0`
  const turn = -30 * Math.PI / 180 // the canvas y axis runs down, so a negative turn is anticlockwise

  it('turns the EADI ball anticlockwise and swings its sky pointer left', () => {
    const d = page('ddi_adi', `const ownship={ cas:100, speed:100, gauges:{ ${gauges} } };
      const alt_radar=false, adi_source="ins", approach_deviation=()=>null;`)
    expect(d.rotate[0]).toBeCloseTo(turn, 9)
    const [pointer] = tip(d, 256, 246, 186 - 4)
    expect(pointer[0]).toBeCloseTo(256 + Math.cos(-Math.PI / 2 + turn) * 182, 6)
    expect(pointer[0]).toBeLessThan(256)
  })

  it('turns the HUD repeater ladder anticlockwise and swings its bank pointer right, as the HUD does', () => {
    const d = page('ddi_hud', `const ownship={ aoa:0, gload:1, gauges:{ ${gauges} } };`)
    expect(d.rotate[0]).toBeCloseTo(turn, 9)
    const [pointer] = tip(d, 256, 250, 180 - 4)
    expect(pointer[0]).toBeCloseTo(256 + Math.cos(Math.PI / 2 + turn) * 176, 6)
    expect(pointer[0]).toBeGreaterThan(256)
    expect(pointer[1]).toBeGreaterThan(250)
  })
})

describe('the engine monitor display', () => {
  it('lists the thirteen EMD rows with the -402 EPE line and derives the rest from the spool', () => {
    const d = page('ddi_eng', `const ownship={ gauges:{ rpmL:99, rpmR:65, egtL:810, egtR:450, flowL:5000, flowR:1000, nozL:0, nozR:100, oilL:100, oilR:55, oat:-5 } };`)
    const shown = texts(d)
    for (const label of ['INLET °C', 'N1 %', 'N2 %', 'EGT °C', 'FF PPH', 'NOZ %', 'OIL PSI', 'THRUST %', 'VIB', 'FUEL °C', 'EPR', 'CDP PSI', 'TDP PSI', 'LEFT EPE', 'RIGHT EPE'])
      expect(shown, label).toContain(label)
    const row = (label: string) => { const y = at(d, label)![1]; return d.text.filter((t) => t[2] === y && t[0] !== label).map((t) => t[0]) }
    expect(row('N1 %')).toEqual(['100', '30']) // MIL on the left, idle on the right
    expect(row('THRUST %')).toEqual(['100', '0'])
    expect(row('EPR')).toEqual(['1.7', '1.0'])
    expect(row('INLET °C')).toEqual(['-5', '-5'])
    expect(row('CDP PSI')).toEqual(['300', '60'])
  })
})

describe('the HSI page', () => {
  const setup = `const ownship={ pos:{x:0,y:1000,z:0}, gauges:{ heading:0, ground:200, track:0, zulu:45296 } };
    const hsi_state={ scale:40, dctr:false, map:false }, ufc={ func:"" }, CARRIER={ x:18520, z:0 }, island_polygons=[], airports=[], wrap_axis=(v)=>v;
    const ifei_current=()=>({ elapsed:'0:12:34' });`
  it('puts the TACAN data at the upper left, ZTOD lower left, ET lower right and a T under the lubber line', () => {
    const d = page('ddi_hsi', setup)
    expect(at(d, 'TCN 090')).toEqual([24, 92])
    expect(at(d, '10.0 NM  3 MIN')).toEqual([24, 118])
    expect(at(d, 'ZTOD 12:34:56')).toEqual([24, 458])
    expect(at(d, 'ET 0:12:34')).toEqual([488, 458])
    expect(at(d, 'T')).toEqual([256, 52])
  })

  // The C's DDIs are monochrome green; only the centre AMPCD is colour. The
  // TACAN pointer starts at (0,-196) in the pointer's rotated frame.
  it('draws the TACAN pointer green on a DDI and in colour only on the AMPCD', () => {
    const pointer = (display: string) => page('ddi_hsi', setup, display).styled.find(([, mx, my]) => mx === 0 && my === -196)?.[0]
    expect(pointer('left')).toBe('#39e07a')
    expect(pointer('right')).toBe('#39e07a')
    expect(pointer('center')).toBe('#ffd24a')
  })
})

describe('the gauges the pages read', () => {
  it('carry a smoothed yaw rate, vertical speed, air temperature and zulu seconds', () => {
    expect(source).toMatch(/heading, yaw:yaw_state\.rate, vspeed:fpm, oat:15-0\.0065\*ownship\.pos\.y, zulu:now\.getUTCHours\(\)\*3600\+now\.getUTCMinutes\(\)\*60\+now\.getUTCSeconds\(\),/)
    expect(source).toMatch(/yaw_state\.rate\+=\(d\/\(t-yaw_state\.t\)-yaw_state\.rate\)\*Math\.min\(1,\(t-yaw_state\.t\)\/0\.5\);/)
  })
})

// The UFC (#15, NATOPS 2.13.5): ufc_face is what the windows show for a state and
// the equipment it reads; ufc_press is one pushbutton against stand-ins for the
// index, the warning latch and the actions it fires; ufc_button_at maps a panel
// point to the painted button under it.
const ufcdefs = ['UFC_PAGES', 'UFC_CUES', 'UFC_BUTTONS', 'UFC_RADIUS'].map((n) => {
  const m = new RegExp(`\\nconst ${n}=[\\s\\S]*?;`).exec(source)?.[0]
  if (!m) throw new Error(`${n} not found in engine.ts`)
  return m
}).join('\n')
interface Face { scratch: string; options: string[] }
interface Ufc { func: string; ralt: boolean; entry: string; error: boolean; blink: number }
interface Live { silent?: boolean; atc?: boolean; ils?: boolean; index?: number }
interface Pressed { ufc: Ufc; index: number; disabled: boolean; pressed: string[]; silent: boolean; atc: boolean }
const fresh = (over: Partial<Ufc> = {}): Ufc => ({ func: '', ralt: false, entry: '', error: false, blink: 0, ...over })
function ufcface(state: Ufc, live: Live, now = 0): Face {
  const run = new Function('state', 'live', 'now', `${ufcdefs} ${lift('ufc_face')} return ufc_face(state, { silent:false, atc:false, ils:false, index:200, ...live }, now);`)
  return run(state, live, now) as Face
}
function ufcpress(buttons: string[], start: Partial<Ufc> = {}, index = 200, sounding = false): Pressed {
  const run = new Function('buttons', 'start', 'index', 'sounding', `${ufcdefs}
    let law_index=index, law_primary=sounding, law_disabled=false, atc_on=false, ufc_dirty=false; const RADAR={ sil:false }, pressed=[];
    const pit_press=(a)=>{ pressed.push(a); if(a==="radar") RADAR.sil=!RADAR.sil; if(a==="atc") atc_on=!atc_on; };
    const ufc_update=()=>{}; const performance={ now:()=>1000 };
    const ufc={ func:"", ralt:false, entry:"", error:false, blink:0, ...start };
    ${lift('ufc_press')}
    for(const b of buttons) ufc_press(b);
    return { ufc, index:law_index, disabled:law_disabled, pressed, silent:RADAR.sil, atc:atc_on };`)
  return run(buttons, start, index, sounding) as Pressed
}
function ufcbutton(y: number, z: number): string | null {
  const run = new Function('y', 'z', `${ufcdefs} ${lift('ufc_button_at')} return ufc_button_at(y, z);`)
  return run(y, z) as string | null
}
const blank = ' '.repeat(9)

describe('the UFC windows', () => {
  it('power up clear', () => {
    expect(ufcface(fresh(), {})).toEqual({ scratch: blank, options: ['', '', '', '', ''] })
  })

  it('show the autopilot page with ON while the approach power compensator is engaged', () => {
    expect(ufcface(fresh({ func: 'ap' }), {}).options).toEqual([' ATTH', ' HSEL', ' BALT', ' RALT', ' CPL'])
    expect(ufcface(fresh({ func: 'ap' }), {}).scratch).toBe(blank)
    expect(ufcface(fresh({ func: 'ap' }), { atc: true }).scratch).toBe('ON       ')
  })

  it('cue :RALT, with only a keyed entry in the scratchpad: the index is the knob\'s (NATOPS 2.12.5.4.1)', () => {
    const f = ufcface(fresh({ func: 'ap', ralt: true }), {})
    expect(f.options[3]).toBe(':RALT')
    expect(f.scratch).toBe(blank)
    expect(ufcface(fresh({ func: 'ap', ralt: true, entry: '500' }), {}).scratch).toBe('      500')
  })

  it('show TACAN on in T/R on the X band, and ILS on only while the needles are live', () => {
    const t = ufcface(fresh({ func: 'tcn' }), {})
    expect(t.options).toEqual([':T/R', ' RCV', ' A/A', ':X', ' Y'])
    expect(t.scratch.slice(0, 2)).toBe('ON')
    expect(ufcface(fresh({ func: 'ils' }), { ils: true }).scratch.slice(0, 2)).toBe('ON')
    expect(ufcface(fresh({ func: 'ils' }), { ils: false }).scratch.slice(0, 2)).toBe('  ')
    expect(ufcface(fresh({ func: 'ils' }), {}).options[0]).toBe(':CHNL')
  })

  it('run E M C O N down the option windows under radar silence, whatever the page', () => {
    expect(ufcface(fresh({ func: 'tcn' }), { silent: true }).options).toEqual(['E', 'M', 'C', 'O', 'N'])
    expect(ufcface(fresh(), { silent: true }).options).toEqual(['E', 'M', 'C', 'O', 'N'])
  })

  it('flash ERROR at 2 Hz and blank the scratchpad once after a valid entry', () => {
    expect(ufcface(fresh({ error: true }), {}, 0).scratch).toBe('ERROR    ')
    expect(ufcface(fresh({ error: true }), {}, 0.5).scratch).toBe(blank)
    expect(ufcface(fresh({ error: true }), {}, 1.0).scratch).toBe('ERROR    ')
    expect(ufcface(fresh({ func: 'tcn', blink: 2 }), {}, 1.9).scratch).toBe(blank)
    expect(ufcface(fresh({ func: 'tcn', blink: 2 }), {}, 2.1).scratch.slice(0, 2)).toBe('ON')
  })
})

// The IFEI's six pushbuttons are painted on the cockpit shell down the unit's
// middle column; a click on the unit's quad answers the nearest painted legend.
function ifeibutton(y: number, z: number): string | null {
  const defs = /\nconst IFEI_BUTTONS=[^\n]*\n/.exec(source)?.[0] ?? ''
  const run = new Function('y', 'z', `${defs} const ifei_buttons=["mode","qty","up","down","zone","et"], ownship={ group:{ worldToLocal:(p)=>p } };
    ${lift('ifei_button_at')} return ifei_button_at({ clone:()=>({ x:6.211, y, z }) });`)
  return run(y, z) as string | null
}

describe('the IFEI pushbuttons', () => {
  it('answer at their painted legends, MODE at the top of the column to ET at its foot', () => {
    expect(ifeibutton(0.200, -0.205)).toBe('mode')
    expect(ifeibutton(0.163, -0.203)).toBe('up')
    expect(ifeibutton(0.142, -0.207)).toBe('down')
    expect(ifeibutton(0.102, -0.205)).toBe('et')
  })

  it('leave the windows either side and the panel below to the rest of the pit', () => {
    expect(ifeibutton(0.150, -0.265)).toBe(null) // the engine window
    expect(ifeibutton(0.190, -0.160)).toBe(null) // the fuel window
    expect(ifeibutton(0.080, -0.205)).toBe(null)
  })
})

describe('the UFC pushbuttons', () => {
  it('fill the entry from the keypad to seven digits, and CLR clears it first and the windows second', () => {
    expect(ufcpress(['1', '2', '3', '4', '5', '6', '7', '8'], { func: 'ap' }).ufc.entry).toBe('1234567')
    const once = ufcpress(['1', '2', 'clr'], { func: 'ap' })
    expect(once.ufc.entry).toBe('')
    expect(once.ufc.func).toBe('ap')
    expect(ufcpress(['1', '2', 'clr', 'clr'], { func: 'ap' }).ufc.func).toBe('')
  })

  it('key nothing with ENT: the low-altitude index is the knob\'s, not the UFC\'s, so an entry flags ERROR', () => {
    const keyed = ufcpress(['ap', 'opt3', '5', '0', '0', 'ent'])
    expect(keyed.index).toBe(200)
    expect(keyed.ufc.error).toBe(true)
    expect(ufcpress(['ap', 'opt3', 'ent']).ufc.error).toBe(true)
    expect(ufcpress(['ap', '5', 'ent']).ufc.error).toBe(true)
    expect(ufcpress(['ap', 'opt3', '5', '0', '0', 'ent', '7']).ufc.entry).toBe('500')
    expect(ufcpress(['ap', 'opt3', '5', '0', '0', 'ent', 'clr']).ufc.error).toBe(false)
  })

  it('select :RALT on the autopilot page only, and disable a sounding primary warning with it or with another UFC mode (NATOPS 2.12.5.1)', () => {
    expect(ufcpress(['ap', 'opt3']).ufc.ralt).toBe(true)
    expect(ufcpress(['ap', 'opt3', 'opt3']).ufc.ralt).toBe(false)
    expect(ufcpress(['opt3'], { func: 'ap' }, 200, true).disabled).toBe(true)
    expect(ufcpress(['tcn'], {}, 200, true).disabled).toBe(true)
    expect(ufcpress(['opt3'], { func: 'ap' }, 200, false).disabled).toBe(false) // nothing sounding, nothing to disable
    expect(ufcpress(['1', 'clr'], { func: 'ap' }, 200, true).disabled).toBe(false) // the keypad is not a mode change
    expect(ufcpress(['tcn', 'opt3']).ufc.ralt).toBe(false)
    expect(ufcpress(['ap', 'opt2']).ufc.ralt).toBe(false)
  })

  it('engage the approach power compensator from the A/P selector once, and clear the display on the second press', () => {
    const on = ufcpress(['ap'])
    expect(on.ufc.func).toBe('ap')
    expect(on.pressed).toEqual(['atc'])
    const twice = ufcpress(['ap', 'ap'])
    expect(twice.ufc.func).toBe('')
    expect(twice.pressed).toEqual(['atc'])
    expect(ufcpress(['tcn']).pressed).toEqual([])
  })

  it('toggle the radar silence from EMCON and drop the entry on a page change', () => {
    const e = ufcpress(['emcon'])
    expect(e.pressed).toEqual(['radar'])
    expect(e.silent).toBe(true)
    expect(ufcpress(['emcon', 'emcon']).silent).toBe(false)
    const moved = ufcpress(['ap', 'opt3', '5', 'tcn'])
    expect(moved.ufc).toMatchObject({ func: 'tcn', ralt: false, entry: '' })
  })

  it('map a panel point to the painted button under it, within the key pitch', () => {
    expect(ufcbutton(0.453, -0.061)).toBe('1')
    expect(ufcbutton(0.386, -0.018)).toBe('ent')
    expect(ufcbutton(0.351, -0.065)).toBe('ap')
    expect(ufcbutton(0.412, 0.006)).toBe('opt3')
    expect(ufcbutton(0.450, -0.085)).toBe('emcon')
    expect(ufcbutton(0.453 + 0.008, -0.061)).toBe('1')
    expect(ufcbutton(0.470, -0.050)).toBe(null)
    expect(ufcbutton(0.300, 0)).toBe(null)
  })

  it('are wired: built with the faces, redrawn on the 120 ms economy, clicked through the panel point, ATC and the index shared', () => {
    expect(source).toMatch(/build_ifei\(g\); build_ufc\(g\); \}/)
    expect(source).toMatch(/if\(pit\)\{ ifei_update\(stale\); ufc_update\(stale\); \}/)
    expect(source).toMatch(/if\(ownship\.group\.userData\.ufc\)\{ const h=_click_ray\.intersectObject\(ownship\.group,true\)\.find\(k=>!k\.object\.userData\.overlay&&shown\(k\.object\)\);/)
    expect(source).toMatch(/button=p&&p\.x>6\.10&&p\.x<6\.18\?ufc_button_at\(p\.y,p\.z\):null;\n\t\tif\(button\)\{ ufc_press\(button\); return; \}/)
    expect(source).toMatch(/if\(ch===key_of\("atc"\)\) pit_press\("atc",0\);/)
    expect(source).toMatch(/case "atc": if\(atc_on\)\{ atc_on=false; atc_flash=-Infinity; \} else if\(ownship\.gearTarget<0\.5 && !on_ground\(\)\)\{ atc_on=true;/)
    expect(source).toMatch(/law_primary=false; law_disabled=false; law_index=st==="carrier"\?40:200;/)
    expect(source).toMatch(/ufc\.func=""; ufc\.ralt=false; ufc\.entry=""; ufc\.error=false; ufc\.blink=0; ufc_dirty=true;/)
    expect(source).toMatch(/new THREE\.MeshBasicMaterial\(\{ map:tex, toneMapped:false, transparent:true, depthWrite:false, side:THREE\.DoubleSide \}\)\);   \/\/ transparent: the painted keypad/)
  })
})

// The HSI's TIMEUFC (NATOPS 24.1.3.15, figure 24-9) loads the UFC with the timer
// options; each shows or blanks its timer on the HUD, one at a time; ENT starts
// and stops the one shown, and a keypad entry (MMSS) presets CD and starts it, a
// value past 59:59 setting 59:59 frozen (24.2.5.7.4-6). A number in the button
// list moves the sim clock to that time.
describe('the TIMEUFC page', () => {
  const timers = /\n\/\/ The mission computer's timers[\s\S]*?\n(?=const ufc=\{)/.exec(source)?.[0] ?? ''
  interface Timed { ufc: Ufc; shown: string; et: number; cd: number; running: { et: boolean; cd: boolean }; face: Face }
  const timeufc = (buttons: (string | number)[]): Timed => new Function('buttons', `${ufcdefs} let sim_time=0; ${timers}
    let law_primary=false, law_disabled=false, atc_on=false, ufc_dirty=false; const RADAR={ sil:false }, pit_press=()=>{}, ufc_update=()=>{}, performance={ now:()=>1000 };
    const ufc={ func:"", ralt:false, entry:"", error:false, blink:0 }, hsi_state={ dctr:false, map:false }, hsi_range=()=>{};
    ${lift('ufc_press')} ${lift('hsi_press')} ${lift('ufc_face')}
    for(const b of buttons){ if(typeof b==="number") sim_time=b; else if(b==="timeufc") hsi_press(17,"left"); else ufc_press(b); }
    return { ufc, shown:timer.shown, et:timer_seconds("et"), cd:timer_seconds("cd"), running:{ et:timer.et.since!==null, cd:timer.cd.since!==null },
      face:ufc_face(ufc, { silent:false, atc:false, ils:false, timer:timer.shown }, 0) };`)(buttons) as Timed

  it('is loaded by TIMEUFC, boxed while it holds the UFC, and cleared by a second press', () => {
    expect(timers).not.toBe('')
    expect(timeufc(['timeufc']).ufc.func).toBe('time')
    expect(timeufc(['timeufc']).face.options).toEqual(['', ' ET', ' CD', ' ZTOD', ''])
    expect(timeufc(['timeufc', 'timeufc']).ufc.func).toBe('')
    expect(source).toMatch(/ddi_legend\(x,17,"TIMEUFC",true,ufc\.func==="time"\);/)
  })

  it('shows one timer at a time, cued with a colon, and blanks it on a second press', () => {
    expect(timeufc(['timeufc', 'opt1']).shown).toBe('et')
    expect(timeufc(['timeufc', 'opt1']).face.options[1]).toBe(':ET')
    expect(timeufc(['timeufc', 'opt1', 'opt2']).shown).toBe('cd')
    expect(timeufc(['timeufc', 'opt3']).shown).toBe('ztod')
    expect(timeufc(['timeufc', 'opt1', 'opt1']).shown).toBe('')
    expect(timeufc(['timeufc', 'opt0', 'opt4']).shown).toBe('')
  })

  it('starts and stops the timer shown with ENT, and flags ERROR with none to start', () => {
    const run = timeufc(['timeufc', 'opt1', 'ent', 100])
    expect(run.running.et).toBe(true)
    expect(run.et).toBe(100)
    const stopped = timeufc(['timeufc', 'opt1', 'ent', 100, 'ent', 250])
    expect(stopped.running.et).toBe(false)
    expect(stopped.et).toBe(100)
    expect(timeufc(['timeufc', 'ent']).ufc.error).toBe(true)
    expect(timeufc(['timeufc', 'opt3', 'ent']).ufc.error).toBe(true)
  })

  it('presets CD from the keypad and starts it, freezes a value past 59:59 at 59:59, and flags ERROR on bad seconds', () => {
    const set = timeufc(['timeufc', '0', '3', '3', '0', 'ent', 10])
    expect(set.cd).toBe(200)
    expect(set.running.cd).toBe(true)
    expect(set.ufc.entry).toBe('')
    expect(set.ufc.error).toBe(false)
    const frozen = timeufc(['timeufc', '9', '9', '0', '0', 'ent', 10])
    expect(frozen.cd).toBe(3599)
    expect(frozen.running.cd).toBe(false)
    expect(timeufc(['timeufc', '0', '0', '7', '5', 'ent']).ufc.error).toBe(true)
  })
})


// The DDI view (#12): the first 3 of a mission opens the display carrying the
// radar page, so a BVR fight starts on the attack format whichever display the
// pilot last looked at; after that 3 returns to the display last shown.
describe('the DDI view', () => {
  const start = source.indexOf('function set_view(v){')
  const view = source.slice(start, source.indexOf('\n}\n', start) + 2)
  function rig(pages: Record<string, string>, remembered: string) {
    const run = new Function('pages', 'remembered', `
      const DDI_ORDER=["left","right","center"];
      const cfg={ view:"hud", ddi:remembered }, saved=[];
      const ddi_state={ left:{page:pages.left,menu:""}, right:{page:pages.right,menu:""}, center:{page:pages.center,menu:""} };
      const on_config=(c)=>saved.push(c.ddi);
      let ddi_view_last=0, cam_psi=0, cam_az=0, cam_el=0, cam_dist=0, flyby_pos=null, hist_valid=true, zoom_target=1, view_zoom=1;
      const ownship={ fwd:{x:0,z:1} }, zoom_recall=()=>1, cockpit_hidden=()=>{};
      let ddi_fresh=true;
      ${lift('ddi_focus')} ${lift('ddi_open')} ${view}
      return { press:(v)=>set_view(v), shown:()=>cfg.view==="ddi"?ddi_focus():null, saved, spawn:()=>{ ddi_fresh=true; if(cfg.view==="ddi") ddi_open(); }, move:(d,p)=>{ ddi_state[d].page=p; } };`)
    return run(pages, remembered) as { press(v: string): void; shown(): string | null; saved: string[]; spawn(): void; move(d: string, p: string): void }
  }
  const aa = { left: 'sms', right: 'rdr', center: 'sa' }

  it('opens the radar on the first 3 of a mission, whichever display was looked at last', () => {
    const r = rig(aa, 'left')
    r.press('ddi')
    expect(r.shown()).toBe('right')
  })
  it('does not save that pick: it is the game\'s, not the pilot\'s', () => {
    const r = rig(aa, 'left')
    r.press('ddi')
    expect(r.saved).toEqual([])
  })
  it('cycles from the radar on a re-press, and saves the pilot\'s choice', () => {
    const r = rig(aa, 'left')
    r.press('ddi'); r.press('ddi')
    expect(r.shown()).toBe('center')
    expect(r.saved).toEqual(['center'])
  })
  it('returns to the display last shown after that, not to the radar', () => {
    const r = rig(aa, 'left')
    r.press('ddi'); r.press('ddi'); r.press('hud'); r.press('ddi')
    expect(r.shown()).toBe('center')
  })
  it('follows the radar page to whichever display carries it', () => {
    const r = rig({ left: 'rdr', right: 'fuel', center: 'sa' }, 'center')
    r.press('ddi')
    expect(r.shown()).toBe('left')
  })
  it('keeps the remembered display when it carries the radar too', () => {
    const r = rig({ left: 'rdr', right: 'rdr', center: 'sa' }, 'right')
    r.press('ddi')
    expect(r.shown()).toBe('right')
  })
  it('keeps the remembered display when no display carries the radar', () => {
    const r = rig({ left: 'chklst', right: 'fuel', center: 'hsi' }, 'center')
    r.press('ddi')
    expect(r.shown()).toBe('center')
  })
  it('opens the radar again on the first 3 of the next mission, and at once if the view is already up', () => {
    const r = rig(aa, 'left')
    r.press('ddi'); r.press('ddi'); r.press('hud')
    r.spawn(); r.press('ddi')
    expect(r.shown()).toBe('right')
    r.press('ddi'); r.spawn()
    expect(r.shown()).toBe('right')
  })
  it('re-arms at every spawn, after the spawn\'s display set is recalled', () => {
    expect(source).toMatch(/\tddi_recall\(\);[^\n]*\n\tddi_fresh=true; if\(cfg\.view==="ddi"\) ddi_open\(\);/)
  })
})

// The TAC and SUPT menus against figure 2-22: each option at its jet pushbutton,
// no legend for a page the game does not build, and the menu's name boxed just
// above MENU (2.13.4.2.1).
describe('the TAC and SUPT menus', () => {
  const menus = new Function(`${/\nconst DDI_MENUS=\{[\s\S]*?\};/.exec(source)?.[0] ?? ''}; return DDI_MENUS`)() as Record<string, [number, string, string][]>
  const built = [...(/\nconst DDI_PAGES=\{([\s\S]*?)\};/.exec(source)?.[1] ?? '').matchAll(/(\w+):\{draw:/g)].map((m) => m[1])
  function run(menu: string, press = 0) {
    return new Function(`let ddi_draws=0, ddi_dirty=false, shown='';
      const ddi_state={ left:{ page:'hud', menu:${JSON.stringify(menu)} } }, DDI_PAGES={}, DDI_MENUS=${JSON.stringify(menus)};
      function cautions_draw(){} function ddi_show(d,p){ shown=p; }
      ${lift('ddi_legend')} ${lift('ddi_render')} ${lift('ddi_press')}
      const text=[], rects=[];
      const x=new Proxy({}, { get:(t,k)=>{ if(k==='fillText') return (s,px,py)=>text.push([String(s),px,py]); if(k==='strokeRect') return (a,b,c,d)=>rects.push([a,b,c,d]); if(k==='measureText') return (s)=>({ width:10*String(s).length }); return ()=>{}; }, set:()=>true });
      if(${press}) ddi_press('left',${press}); else ddi_render(x,512,'left');
      return { text, rects, shown };`)() as { text: [string, number, number][]; rects: [number, number, number, number][]; shown: string }
  }
  it('puts each TAC option at its pushbutton', () => {
    const d = run('tac')
    expect(d.text.filter((t) => t[0] !== 'TAC')).toEqual([['STORES', 10, 96], ['RDR ATTK', 10, 176], ['HUD', 10, 256], ['SA', 502, 256], ['EW', 336, 482], ['MENU', 256, 482]])
  })
  it('puts each SUPT option at its pushbutton', () => {
    const d = run('supt')
    expect(d.text.filter((t) => t[0] !== 'SUPT')).toEqual([['HSI', 10, 336], ['ADI', 10, 416], ['CHKLST', 502, 96], ['ENG', 502, 176], ['FCS', 502, 416], ['FUEL', 96, 482], ['FPAS', 176, 482], ['MENU', 256, 482]])
  })
  it('shows only options the game builds', () => {
    for (const rows of Object.values(menus)) for (const [, , target] of rows) expect(built).toContain(target)
  })
  it('opens the page at the pushbutton the jet has it on', () => {
    expect(run('tac', 5).shown).toBe('sms')
    expect(run('tac', 13).shown).toBe('sa')
    expect(run('supt', 20).shown).toBe('fuel')
    expect(run('supt', 11).shown).toBe('chklst')
    expect(run('tac', 7).shown).toBe('')
    expect(run('supt', 13).shown).toBe('')
  })
  it('boxes the menu name just above MENU', () => {
    for (const [menu, name] of [['tac', 'TAC'], ['supt', 'SUPT']]) {
      const d = run(menu)
      const [, nx, ny] = d.text.find((t) => t[0] === name) ?? []
      expect([nx, ny]).toEqual([256, 446])
      const box = d.rects.find(([bx, by, bw, bh]) => bx < 256 - 5 * name.length && bx + bw > 256 + 5 * name.length && by < 446 && by + bh > 446)
      expect(box).toBeDefined()
      const [, by, , bh] = box!
      expect(by + bh).toBeLessThan(482 - 14)   // clear of the MENU legend's box
    }
  })
})
