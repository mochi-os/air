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
interface Drawn { text: [string, number, number][]; rects: [number, number, number, number][]; arcs: [number, number, number][] }
function page(name: string, setup: string, display = 'left'): Drawn {
  const run = new Function(`const D2R=Math.PI/180, NM=1852, THREE={MathUtils:{clamp:(v,lo,hi)=>Math.min(hi,Math.max(lo,v))}};
    ${setup}
    ${lift('ddi_legend')} ${lift(name)}
    const text=[], rects=[], arcs=[];
    const x=new Proxy({}, { get:(t,k)=>{ if(k==='fillText') return (s,px,py)=>text.push([String(s),px,py]); if(k==='strokeRect') return (a,b,c,d)=>rects.push([a,b,c,d]); if(k==='arc') return (ax,ay,r)=>arcs.push([ax,ay,r]); if(k==='measureText') return (s)=>({ width:10*String(s).length }); return ()=>{}; }, set:()=>true });
    ${name}(x, ${JSON.stringify(display)}); return { text, rects, arcs };`)
  return run() as Drawn
}
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
    const hsi_state={ scale:40, dctr:false, map:false }, CARRIER={ x:18520, z:0 }, island_polygons=[], airports=[], wrap_axis=(v)=>v;
    const ifei_current=()=>({ elapsed:'0:12:34' });`
  it('puts the TACAN data at the upper left, ZTOD lower left, ET lower right and a T under the lubber line', () => {
    const d = page('ddi_hsi', setup)
    expect(at(d, 'TCN 090')).toEqual([24, 92])
    expect(at(d, '10.0 NM  3 MIN')).toEqual([24, 118])
    expect(at(d, 'ZTOD 12:34:56')).toEqual([24, 458])
    expect(at(d, 'ET 0:12:34')).toEqual([488, 458])
    expect(at(d, 'T')).toEqual([256, 52])
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
interface Pressed { ufc: Ufc; index: number; armed: boolean; set: boolean; pressed: string[]; silent: boolean; atc: boolean }
const fresh = (over: Partial<Ufc> = {}): Ufc => ({ func: '', ralt: false, entry: '', error: false, blink: 0, ...over })
function ufcface(state: Ufc, live: Live, now = 0): Face {
  const run = new Function('state', 'live', 'now', `${ufcdefs} ${lift('ufc_face')} return ufc_face(state, { silent:false, atc:false, ils:false, index:200, ...live }, now);`)
  return run(state, live, now) as Face
}
function ufcpress(buttons: string[], start: Partial<Ufc> = {}, index = 200): Pressed {
  const run = new Function('buttons', 'start', 'index', `${ufcdefs}
    let law_index=index, law_armed=true, law_set=false, atc_on=false, ufc_dirty=false; const RADAR={ sil:false }, pressed=[];
    const pit_press=(a)=>{ pressed.push(a); if(a==="radar") RADAR.sil=!RADAR.sil; if(a==="atc") atc_on=!atc_on; };
    const ufc_update=()=>{}; const performance={ now:()=>1000 };
    const ufc={ func:"", ralt:false, entry:"", error:false, blink:0, ...start };
    ${lift('ufc_press')}
    for(const b of buttons) ufc_press(b);
    return { ufc, index:law_index, armed:law_armed, set:law_set, pressed, silent:RADAR.sil, atc:atc_on };`)
  return run(buttons, start, index) as Pressed
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

  it('cue :RALT and put the index, then the keyed entry, in the scratchpad', () => {
    const f = ufcface(fresh({ func: 'ap', ralt: true }), { index: 200 })
    expect(f.options[3]).toBe(':RALT')
    expect(f.scratch).toBe('      200')
    expect(ufcface(fresh({ func: 'ap', ralt: true, entry: '500' }), { index: 200 }).scratch).toBe('      500')
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

describe('the UFC pushbuttons', () => {
  it('fill the entry from the keypad to seven digits, and CLR clears it first and the windows second', () => {
    expect(ufcpress(['1', '2', '3', '4', '5', '6', '7', '8'], { func: 'ap' }).ufc.entry).toBe('1234567')
    const once = ufcpress(['1', '2', 'clr'], { func: 'ap' })
    expect(once.ufc.entry).toBe('')
    expect(once.ufc.func).toBe('ap')
    expect(ufcpress(['1', '2', 'clr', 'clr'], { func: 'ap' }).ufc.func).toBe('')
  })

  it('key the low-altitude index through :RALT and ENT, up to 5,000 ft, and flag the rest ERROR', () => {
    const ok = ufcpress(['ap', 'opt3', '5', '0', '0', 'ent'])
    expect(ok.index).toBe(500)
    expect(ok.set).toBe(true)
    expect(ok.ufc.entry).toBe('')
    expect(ok.ufc.blink).toBeCloseTo(1.3)
    expect(ok.ufc.error).toBe(false)
    const high = ufcpress(['ap', 'opt3', '5', '0', '0', '1', 'ent'])
    expect(high.index).toBe(200)
    expect(high.ufc.error).toBe(true)
    expect(ufcpress(['ap', 'opt3', 'ent']).ufc.error).toBe(true)
    expect(ufcpress(['ap', '5', 'ent']).ufc.error).toBe(true)
    expect(ufcpress(['ap', 'opt3', '5', '0', '0', '1', 'ent', '7']).ufc.entry).toBe('5001')
    expect(ufcpress(['ap', 'opt3', '5', '0', '0', '1', 'ent', 'clr']).ufc.error).toBe(false)
  })

  it('select :RALT on the autopilot page only, and disable the warning when it is pressed again', () => {
    expect(ufcpress(['ap', 'opt3']).ufc.ralt).toBe(true)
    const off = ufcpress(['ap', 'opt3', 'opt3'])
    expect(off.ufc.ralt).toBe(false)
    expect(off.armed).toBe(false)
    expect(ufcpress(['ap', 'opt3']).armed).toBe(true)
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
    expect(source).toMatch(/build_ifei\(g\); build_ufc\(g\); mount_compass\(g\);/)
    expect(source).toMatch(/if\(pit\)\{ ifei_update\(stale\); ufc_update\(stale\); \}/)
    expect(source).toMatch(/if\(ownship\.group\.userData\.ufc\)\{ const h=_click_ray\.intersectObject\(ownship\.group,true\)\.find\(k=>!k\.object\.userData\.overlay&&shown\(k\.object\)\);/)
    expect(source).toMatch(/button=p&&p\.x>6\.10&&p\.x<6\.18\?ufc_button_at\(p\.y,p\.z\):null;\n\t\tif\(button\)\{ ufc_press\(button\); return; \}/)
    expect(source).toMatch(/if\(ch===key_of\("atc"\)\) pit_press\("atc",0\);/)
    expect(source).toMatch(/case "atc": if\(atc_on\) atc_on=false; else if\(ownship\.gearTarget<0\.5 && !on_ground\(\)\)\{ atc_on=true;/)
    expect(source).toMatch(/if\(agl>400\)\{ law_armed=true; if\(!law_set\) law_index=200; \}/)
    expect(source).toMatch(/ufc\.func=""; ufc\.ralt=false; ufc\.entry=""; ufc\.error=false; ufc\.blink=0; law_set=false; ufc_dirty=true;/)
    expect(source).toMatch(/new THREE\.MeshBasicMaterial\(\{ map:tex, toneMapped:false, transparent:true, depthWrite:false, side:THREE\.DoubleSide \}\)\);   \/\/ transparent: the painted keypad/)
  })
})
