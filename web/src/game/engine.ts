// @ts-nocheck
// Copyright © 2026 Mochi OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
//
// Furball game engine: the Three.js render loop, flight model and 2D-canvas HUD,
// extracted verbatim from the prototype. Imperative and self-contained; mounted by
// the React <GameCanvas> via startGame(). The mission-setup menu lives in React.
import * as THREE from 'three'
import {
  connect as net_dial,
  record as net_record,
  type Join as NetJoin,
  type Net as NetHandle,
} from './net'
import { flight_load, flight_ready, flight_failure, flight_init, flight_set, flight_get, flight_frame, flight_mark, flight_ack, flight_level, flight_clear, flight_version, steps as flight_steps, STATE } from './flight'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

export type GameConfig = Record<string, unknown>

export interface GameHandle {
  stop: () => void
  resume: (config?: GameConfig) => void
}

export function startGame({
  stage,
  hud,
  map,
  help,
  framerate,
  config = {},
  join = null,
  onExit,
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
  translate?: (text: string) => string
}): GameHandle {
  const __ac = new AbortController()
  const signal = __ac.signal
  let __raf = 0

// ============================================================================ config
const cfg = { render_scale:1.0, dyn_res:false, ocean_segments:256, exterior_detail:3, lod:true, extra_aircraft:0,
	tracers:true, missiles:true, flares:true, shadows:false, clouds:"none", afterburner:true,
	view:"hud", invert:false, framerate:false, sens:1.0,
	task:"joust", start:"carrier", tod:"day", help:false,
	cat_dy:2.46,                                        // aircraft rest height above the deck plane (shared by all cats; = measured wheel-bottom drop, keep equal to GEAR)
	cats:[ {x:48.06, z:18.62, h:5.18},                  // 1: starboard bow — x toward bow, z + starboard, heading deg (0=+X); all four aligned with the deck tool (key 0)
	       {x:48.43, z:-0.58, h:1.60},                  // 2: port bow (the carrier-start spawn)
	       {x:-36.06, z:-15.32, h:4.54},                // 3: starboard waist, down the angled deck
	       {x:-52.30, z:-26.34, h:-0.10} ] };           // 4: port waist
const SAVE_KEY="joust_cfg_v1";
const CAT_KEYS=["cats","cat_dy"];
const CAT_DEFAULTS={ cat_dy:cfg.cat_dy, cats:cfg.cats.map(c=>({...c})) };   // baked-in spawn = canonical; localStorage copy is only read in alignment mode
function load_cfg(){ try{ const s=localStorage.getItem(SAVE_KEY); if(s) Object.assign(cfg,JSON.parse(s)); }catch(e){}
	cfg.cat_dy=CAT_DEFAULTS.cat_dy; cfg.cats=CAT_DEFAULTS.cats.map(c=>({...c}));   // normal load always uses baked catapult positions, never the saved ones
	if(cfg.clouds==="simple"||cfg.clouds==="volumetric") cfg.clouds=cfg.clouds==="volumetric"?"cumulus":"none"; }   // migrate removed types
function save_cfg(){ try{ const cur={...cfg};
	if(!deck_edit){ const prev=JSON.parse(localStorage.getItem(SAVE_KEY)||"{}"); for(const k of CAT_KEYS) if(k in prev) cur[k]=prev[k]; }   // outside alignment, don't clobber the stored catapult scratch values
	localStorage.setItem(SAVE_KEY,JSON.stringify(cur)); }catch(e){} }
function enter_align(){ try{ const prev=JSON.parse(localStorage.getItem(SAVE_KEY)||"{}");
	if(Array.isArray(prev.cats) && prev.cats.length===4) cfg.cats=prev.cats.map(c=>({...c}));
	if("cat_dy" in prev) cfg.cat_dy=prev.cat_dy; }catch(e){} place_on_cat(cat_idx); }   // alignment mode resumes from the last saved catapult positions
function copy_cats(){   // on align exit: the tuned poses to the clipboard, in the cfg-defaults source format (paste back as the new baked values)
	const txt="cat_dy:"+cfg.cat_dy.toFixed(2)+",\n\tcats:[ "+cfg.cats.map(c=>"{x:"+c.x.toFixed(2)+", z:"+c.z.toFixed(2)+", h:"+c.h.toFixed(2)+"}").join(",\n\t       ")+" ]";
	const fallback=()=>{ try{ const ta=document.createElement("textarea"); ta.value=txt; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); }catch(e){} };   // sandboxed-iframe path: the async clipboard API is often blocked with an opaque origin
	try{ navigator.clipboard.writeText(txt).catch(fallback); }catch(e){ fallback(); }
}
load_cfg();
Object.assign(cfg, config);   // mission-setup menu overrides saved/defaults
cfg.view="hud";   // start in HUD (view 2); 1-5 select views, V swaps cockpit/HUD
let running=false, has_enemy=true;
const MULTIPLAYER=!!join;            // in a live match the map/P must never freeze the world
if(MULTIPLAYER){ cfg.task="joust"; cfg.extra_aircraft=0; cfg.missiles=false; }   // multiplayer: air start, no local AI; the match rules from the welcome may re-allow missiles
const DECK_ALIGN=false;              // dev-only catapult/deck alignment tool (key 0) — code kept, unreachable in player builds; flip on to retune the cat poses
const TEST_SCENARIOS=true;           // dev-only landing/trap test autopilot (Shift+1..0 fly scripted hands-off approaches) — flip off before release
let cat_idx=1;                       // selected catapult (0-based; default = #2 port bow, the carrier-start spawn); Shift+1-4 select in align mode (key 0)
let pause_toggle=false, game_paused=false;
let loading=false, loading_t0=0;   // flight-start LOADING screen: the sim + render hold until assets_ready() (20 s cap so a failed load can't hang the game)
let joust_side=1;   // which end of the merge the player drew this round (+1 = start west heading east); coin-flipped per joust start
const sun_dir = new THREE.Vector3(0.45,0.42,-0.32).normalize();
const CARRIER={ x:-18500, z:7500, deckY:19 };   // ~20 km WSW of Midway (leeward deep water); heading +X, bow at +x
const sky_horizon=new THREE.Color(0xbfd8e8), sky_zenith=new THREE.Color(0x2a5a8c), fog_colour=new THREE.Color(0xc4d6e2);
const col_sundisc=new THREE.Color(0xfff3da), col_deep=new THREE.Color(0x0a2a3a), col_shallow=new THREE.Color(0x1d6e86);

// ============================================================================ renderer/scene
const canvas = stage;
const renderer = new THREE.WebGLRenderer({ canvas, antialias:true, powerPreference:"high-performance" });
renderer.outputColorSpace=THREE.SRGBColorSpace; renderer.toneMapping=THREE.ACESFilmicToneMapping; renderer.toneMappingExposure=1.05;
renderer.shadowMap.type=THREE.PCFSoftShadowMap;
const scene = new THREE.Scene(); scene.fog=new THREE.FogExp2(fog_colour,0.000042);
const camera = new THREE.PerspectiveCamera(45,1,3.0,42000);   // 45° ≈ HUD-like 1:1 so a 3° glideslope reads right (was 62°, too wide → approaches felt low)

const sun = new THREE.DirectionalLight(0xfff4e0,2.4); sun.position.copy(sun_dir).multiplyScalar(4000); sun.castShadow=true;
sun.shadow.mapSize.set(1024,1024); sun.shadow.camera.near=100; sun.shadow.camera.far=8000;
sun.shadow.camera.left=-800; sun.shadow.camera.right=800; sun.shadow.camera.top=800; sun.shadow.camera.bottom=-800;
scene.add(sun,sun.target); const hemi=new THREE.HemisphereLight(0xbcd6ec,0x35506a,0.9); const amb=new THREE.AmbientLight(0x405060,0.4); scene.add(hemi,amb);

// ============================================================================ sky + ocean (proven)
const sky_mat = new THREE.ShaderMaterial({ side:THREE.BackSide, depthWrite:false, fog:false,
	uniforms:{ u_sun:{value:sun_dir}, u_horizon:{value:sky_horizon}, u_zenith:{value:sky_zenith}, u_sun_col:{value:col_sundisc} },
	vertexShader:`varying vec3 v_dir; void main(){ v_dir=normalize(position); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
	fragmentShader:`varying vec3 v_dir; uniform vec3 u_sun,u_horizon,u_zenith,u_sun_col;
		void main(){ vec3 d=normalize(v_dir); float t=clamp(d.y*1.2,0.0,1.0); vec3 col=mix(u_horizon,u_zenith,pow(t,0.65));
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
	day:  { sun:[0,0.866,0.5], sunCol:0xfff4e0, sunI:2.4,  disc:0xfff3da, hor:0xbfd8e8, zen:0x2a5a8c, fog:0xc4d6e2, deep:0x0a2a3a, shal:0x1d6e86, hs:0xbcd6ec, hg:0x35506a, hi:0.9,  ac:0x405060, ai:0.4,  exp:1.05, stars:0.0,  water:[1.0,1.0,1.0] },   // sun due south at 60° — high and exactly abeam an east-west joust merge, so neither pilot starts up-sun (fair by mirror symmetry; realistic for 28°N)
	night:{ sun:[0,0.866,0.5], sunCol:0x9fb6e0, sunI:0.32, disc:0xcdd8f0, hor:0x0f1626, zen:0x05080f, fog:0x0a111c, deep:0x030810, shal:0x0a2030, hs:0x1a2742, hg:0x05060a, hi:0.32, ac:0x0a0e18, ai:0.22, exp:1.18, stars:0.95, water:[0.30,0.36,0.50] },   // the moon takes the same slot at night — same fairness geometry, and no low glitter path on the sea
};
function apply_time_of_day(t){ const p=TOD[t]||TOD.day;
	sun_dir.set(p.sun[0],p.sun[1],p.sun[2]).normalize(); sun.position.copy(sun_dir).multiplyScalar(4000); sun.target.position.set(0,0,0);
	sun.color.setHex(p.sunCol); sun.intensity=p.sunI;
	col_sundisc.setHex(p.disc); sky_horizon.setHex(p.hor); sky_zenith.setHex(p.zen); col_deep.setHex(p.deep); col_shallow.setHex(p.shal);
	scene.fog.color.setHex(p.fog); fog_colour.setHex(p.fog);
	hemi.color.setHex(p.hs); hemi.groundColor.setHex(p.hg); hemi.intensity=p.hi; amb.color.setHex(p.ac); amb.intensity=p.ai;
	renderer.toneMappingExposure=p.exp; cloud_mat.uniforms.uExposure.value=p.exp; stars.material.opacity=p.stars;   // the cloud composite uses the same exposure as the scene
	if(p.water) ocean_mat.uniforms.u_water_tint.value.setRGB(p.water[0],p.water[1],p.water[2]);   // darken the reef/lagoon colour map at night
}

const ocean_mat = new THREE.ShaderMaterial({ fog:false,
	uniforms:{ u_time:{value:0}, u_sun:{value:sun_dir}, u_deep:{value:col_deep}, u_shallow:{value:col_shallow}, u_sky:{value:sky_horizon}, u_fog:{value:sky_horizon}, u_fog_density:{value:0.000075},
		u_water:{value:null}, u_lagoon:{value:null}, u_water_half:{value:12000.0}, u_water_on:{value:0.0}, u_water_tint:{value:new THREE.Color(1,1,1)} },   // Midway imagery (maps/midway/map.jpg) + atoll-interior calm mask (lagoon.png), see map.json region_half
	vertexShader:`uniform float u_time,u_water_half,u_water_on; uniform sampler2D u_water,u_lagoon; varying vec3 v_world; varying vec3 v_normal; varying float v_height; varying float v_calm;
		const vec4 W0=vec4(1.0,0.3,420.0,90.0); const vec4 W1=vec4(-0.7,0.7,230.0,60.0); const vec4 W2=vec4(0.4,-0.9,110.0,38.0); const vec4 W3=vec4(-0.2,0.5,55.0,24.0);
		float wave(vec2 p,vec4 w,float amp,out vec2 grad){ vec2 dir=normalize(w.xy); float k=6.2831853/w.z; float ph=dot(dir,p)*k+u_time*(w.w/w.z); grad=dir*(k*amp*cos(ph)); return amp*sin(ph); }
		void main(){ vec4 wp=modelMatrix*vec4(position,1.0); vec2 xz=wp.xz; vec2 g,gt=vec2(0.0); float h=0.0;
		float calm=0.0; if(u_water_on>0.5){ vec2 wuv=clamp((xz+u_water_half)/(2.0*u_water_half),0.0,1.0); calm=texture2D(u_lagoon,wuv).r; }   // atoll interior (reef flat + lagoon incl. the deep basin) = calm
		v_calm=calm; float ws=mix(1.0,0.12,calm);   // damp wave amplitude inside the reef
		h+=wave(xz,W0,2.0,g);gt+=g; h+=wave(xz,W1,1.1,g);gt+=g; h+=wave(xz,W2,0.5,g);gt+=g; h+=wave(xz,W3,0.25,g);gt+=g;
		h*=ws; gt*=ws;
		wp.y+=h; v_height=h; v_normal=normalize(vec3(-gt.x,1.0,-gt.y)); v_world=wp.xyz; gl_Position=projectionMatrix*viewMatrix*wp; }`,
	fragmentShader:`uniform vec3 u_sun,u_deep,u_shallow,u_sky,u_fog,u_water_tint; uniform float u_fog_density,u_time,u_water_half,u_water_on; uniform sampler2D u_water; varying vec3 v_world; varying vec3 v_normal; varying float v_height; varying float v_calm;
		vec2 ripple(vec2 p,vec2 dir,float wl,float amp,float spd){ dir=normalize(dir); float k=6.2831853/wl; float ph=dot(dir,p)*k+u_time*spd; return dir*(k*amp*cos(ph)); }
		float hash2(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
		vec3 sky_at(vec3 d){ d=normalize(d); float t=clamp(d.y*1.2,0.0,1.0); vec3 col=mix(u_sky, u_sky*0.55+vec3(0.04,0.10,0.22), pow(t,0.65));
			float s=max(dot(d,normalize(u_sun)),0.0); col+=vec3(1.0,0.95,0.8)*pow(s,500.0)*4.0; col+=vec3(1.0,0.96,0.85)*pow(s,14.0)*0.25; return col; }
		void main(){ vec3 V=normalize(cameraPosition-v_world); vec3 L=normalize(u_sun);
			vec2 xz=v_world.xz; vec2 g=vec2(0.0);
			g+=ripple(xz,vec2(1.0,0.4),26.0,0.06,1.2); g+=ripple(xz,vec2(-0.6,1.0),15.0,0.04,1.7); g+=ripple(xz,vec2(0.8,-0.7),8.0,0.025,2.2);
				g*=(1.0-0.8*v_calm);   // calm lagoon: damp surface ripples too
			vec3 N=normalize(v_normal+vec3(-g.x,0.0,-g.y));
			float fres=0.02+0.98*pow(1.0-max(dot(N,V),0.0),5.0);
			float diff=max(dot(N,L),0.0); vec3 body;
			if(u_water_on>0.5){ vec2 wuv=clamp((v_world.xz+u_water_half)/(2.0*u_water_half),0.0,1.0); body=texture2D(u_water,wuv).rgb*u_water_tint*(0.7+0.3*diff); }
			else { body=mix(u_deep,u_shallow,diff*0.8+0.2); }
			float shallow=clamp((body.g-0.25)*2.2,0.0,1.0);   // turquoise/foam → damp the sky reflection so the colour shows
			vec3 refl=sky_at(reflect(-V,N));
			vec3 col=mix(body,refl,fres*mix(1.0,0.35,shallow));
			vec3 H=normalize(L+V); float spec=pow(max(dot(N,H),0.0),220.0); col+=vec3(1.0,0.95,0.8)*spec*2.2;
			float foam=smoothstep(1.5,2.6,v_height)*(0.55+0.45*hash2(floor(xz*0.6))); foam*=smoothstep(0.15,0.55,1.0-N.y);
			col=mix(col,vec3(0.92,0.96,1.0),clamp(foam,0.0,0.85));
			float dist=length(cameraPosition-v_world); float fog=1.0-exp(-u_fog_density*u_fog_density*dist*dist); col=mix(col,u_fog,clamp(fog,0.0,1.0));
			gl_FragColor=vec4(col,1.0); }` });
let ocean=null;
function build_ocean(seg){ if(ocean){scene.remove(ocean);ocean.geometry.dispose();}
	const geo=new THREE.PlaneGeometry(40000,40000,seg,seg); geo.rotateX(-Math.PI/2);
	ocean=new THREE.Mesh(geo,ocean_mat); ocean.receiveShadow=true; ocean.frustumCulled=false; scene.add(ocean); }
build_ocean(cfg.ocean_segments);

// cloud layer types (rendered by the raymarch pass below)
const CLOUDS={   // cover: higher = more cloud (coverage remap). Trade-wind cumulus: low bases (~2,000 ft), most tops at the inversion, a few towers.
	cumulus:      { base:600,  top:2400, high:5000, cover:0.42, density:1.0,  flat:0.0 },   // the dense fuzzy broken sky (user-preferred over the scattered/eroded variants)
	high_stratus: { base:6000, top:6700, high:6700, cover:0.55, density:0.45, flat:1.0 },   // thin widespread cirrostratus
	low_stratus:  { base:600,  top:1150, high:1150, cover:0.80, density:1.2,  flat:1.0 },   // low grey overcast
};
function apply_clouds(){ const p=CLOUDS[cfg.clouds]; if(!p) return;
	cloud_mat.uniforms.uBase.value=p.base; cloud_mat.uniforms.uTop.value=p.top; cloud_mat.uniforms.uHigh.value=p.high;
	cloud_mat.uniforms.uCoverage.value=p.cover; cloud_mat.uniforms.uDensity.value=p.density; cloud_mat.uniforms.uFlat.value=p.flat; }
const cloud_active=()=>cfg.clouds&&cfg.clouds!=="none";

// ---- volumetric clouds: raymarched, composited against scene depth ----
// scene renders to an offscreen target (with depth); a fullscreen pass marches a
// cloud slab and composites over it, stopping at the scene surface for occlusion.
let rt=null, rt_cloud=null, rt_blur=null; const invVP=new THREE.Matrix4(); const _buf=new THREE.Vector2();
function size_rt(){ renderer.getDrawingBufferSize(_buf); const w=Math.max(2,_buf.x|0),h=Math.max(2,_buf.y|0);
	const hw=Math.max(2,w>>1), hh=Math.max(2,h>>1);   // clouds are soft: everything cloud-related runs at half resolution
	if(!rt){ rt=new THREE.WebGLRenderTarget(hw,hh,{depthBuffer:true}); rt.depthTexture=new THREE.DepthTexture(hw,hh);   // depth-source pass only — the scene the player SEES renders directly to the canvas, exactly like the no-clouds path (the full-res RT detour alone cost ~40% frame time and lost MSAA)
		rt_cloud=new THREE.WebGLRenderTarget(hw,hh);   // marched cloud light + transmittance
		rt_blur=new THREE.WebGLRenderTarget(hw,hh);    // gaussian-smoothed copy — the low-pass that kills the march dither grain ("fizzy edges")
		rt.texture.minFilter=THREE.LinearFilter; rt.texture.magFilter=THREE.LinearFilter; }
	else if(rt.width!==hw||rt.height!==hh){ rt.setSize(hw,hh); rt_cloud.setSize(hw,hh); rt_blur.setSize(hw,hh); } }
const fs_scene=new THREE.Scene(); const fs_cam=new THREE.OrthographicCamera(-1,1,1,-1,0,1);
const cloud_mat=new THREE.ShaderMaterial({ depthTest:false, depthWrite:false,   // NOTE: no glslVersion:GLSL3 — three compiles ShaderMaterial as 300 es on WebGL2 anyway (sampler3D works), and the GLSL3 flag REMOVES the gl_FragColor compatibility define
	uniforms:{ tDepth:{value:null}, tNoise:{value:null}, tDetail:{value:null}, uCamPos:{value:new THREE.Vector3()}, uInvVP:{value:new THREE.Matrix4()},
		uTime:{value:0}, uSun:{value:sun_dir}, uSunCol:{value:col_sundisc}, uSky:{value:sky_horizon}, uDebug:{value:0.0},
		uBase:{value:600.0}, uTop:{value:2400.0}, uHigh:{value:5000.0}, uCoverage:{value:0.42}, uDensity:{value:1.0}, uFlat:{value:0.0}, uExposure:{value:1.05} },
	vertexShader:`varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }`,
	fragmentShader:`varying vec2 vUv;
		uniform sampler2D tDepth; uniform highp sampler3D tNoise,tDetail;
		uniform vec3 uCamPos,uSun,uSunCol,uSky; uniform mat4 uInvVP;
		uniform float uTime,uBase,uTop,uHigh,uCoverage,uDensity,uFlat,uExposure,uDebug;
		float hash(vec3 p){ p=fract(p*0.3183099+vec3(0.1,0.2,0.3)); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
		float remap(float v,float a,float b,float c,float d){ return c+clamp((v-a)/(b-a),0.0,1.0)*(d-c); }
		float hg(float c,float g){ float g2=g*g; return (1.0-g2)/pow(1.0+g2-2.0*g*c,1.5); }
		// Trade-wind cumulus field: flat bases at uBase, most cells capped by the inversion at uTop, a minority of
		// vigorous cells towering to uHigh (per-cell vigour from low-frequency noise). Density: Perlin-Worley base
		// remapped by coverage, eroded at the edges by high-frequency Worley — the cauliflower billows.
		float vigour(vec2 xz){ return texture(tNoise, vec3(xz*2.0833e-5, 0.37)).g; }   // ~8 km cells
		float top_at(float vig){ return mix(mix(uTop,uHigh,smoothstep(0.62,0.95,vig)), uTop, uFlat); }
		float dens(vec3 p, float lod){   // lod 0 = near (full erosion detail) … 1 = far (soft stable masses — fine detail undersamples at long range and reads as clouds bubbling in and out)
			float vig=vigour(p.xz), top=top_at(vig);
			float h=(p.y-uBase)/(top-uBase); if(h<0.0||h>1.0) return 0.0;
			float prof=mix( smoothstep(0.02,0.12,h)*smoothstep(1.0,0.5,h),    // cumulus: flat defined base, domed top
			                smoothstep(0.0,0.25,h)*smoothstep(1.0,0.7,h), uFlat );   // stratus: thin even slab
			vec3 sp=p+vec3(uTime*8.0,0.0,uTime*3.0);                          // slow drift
			vec4 n=texture(tNoise, sp*1.6667e-4);                             // base field, ~6 km period
			float wf=n.g*0.625+n.b*0.25+n.a*0.125;
			float base=remap(n.r, wf-1.0, 1.0, 0.0, 1.0)*prof;
			float cov=uCoverage*mix(0.75+0.5*vig, 1.0, uFlat);                // vigorous cells run denser
			float d=remap(base, 1.0-cov, 1.0, 0.0, 1.0)*cov;
			if(d<=0.0) return 0.0;
			float hb=clamp(h*4.0,0.0,1.0), estr=mix(0.35,0.15,uFlat);
			float coarse=mix(n.b, 1.0-n.b, hb);                               // coarse erosion from the base sample: keeps far cells SEPARATE at zero cost and zero shimmer (fading erosion out entirely merged the horizon into a solid wall)
			float er=coarse;
			if(lod<0.7){
				vec3 dn=texture(tDetail, sp*8.333e-4).rgb;                    // fine erosion detail, ~1.2 km period (near field only — it undersamples and shimmers at range)
				float det=dn.r*0.625+dn.g*0.25+dn.b*0.125;
				er=mix(mix(det, 1.0-det, hb), coarse, smoothstep(0.25,0.7,lod));
			}
			d=remap(d, er*estr, 1.0, 0.0, 1.0);   // soft uniform erosion — the fuzzy look
			return clamp(d,0.0,1.0)*uDensity;
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
			vec3 cloudc=vec3(0.0); float ctr=1.0;
			if(uDebug<0.5 && abs(ray.y)>1.0e-4){   // uDebug=1: full RT path, zero cloud contribution (A/B against the no-clouds path)
				float slabTop=mix(uHigh,uTop,uFlat);
				float ta=(uBase-uCamPos.y)/ray.y, tb=(slabTop-uCamPos.y)/ray.y;
				float cfar=mix(24000.0,60000.0,uFlat);
				float t0=max(min(ta,tb),0.0), t1=min(max(ta,tb),min(sceneDist,cfar));
				if(t1>t0){ float dt=min((t1-t0)/56.0,180.0);   // cap the step: long skimming rays otherwise decide a whole puff from 1-2 jittered samples per pixel (full-body stipple)
					float ign=fract(52.9829189*fract(0.06711056*gl_FragCoord.x+0.00583715*gl_FragCoord.y));   // interleaved gradient noise: structured, so the blur pass removes it cleanly (white-noise hash read as fizz)
					float t=t0+ign*dt; float tr=1.0; vec3 col=vec3(0.0);   // FULL-step jitter: anything less leaves the march shells visible as horizontal banding across cloud faces
					float cosT=dot(ray,uSun); float ph=mix(hg(cosT,0.55), hg(cosT,-0.2), 0.35);   // two-lobe Henyey-Greenstein: forward silver lining + soft backscatter
					for(int i=0;i<96;i++){ if(t>t1||tr<0.03) break; vec3 pos=uCamPos+ray*t;
						float lod=clamp(t/12000.0,0.0,1.0); float d=dens(pos,lod);
						if(d>0.01){
							float ld=0.0; vec3 lp=pos; float ls=90.0;                       // optical depth toward the sun (metres-weighted)
							for(int j=0;j<5;j++){ lp+=uSun*ls; ld+=dens(lp,lod)*ls; ls*=1.35; }
							float beer=exp(-ld*0.010);
							float powder=1.0-exp(-ld*0.028);                                // Beer-powder: darkened crinkles on sun-facing billows
							float vig=vigour(pos.xz); float hcur=clamp((pos.y-uBase)/(top_at(vig)-uBase),0.0,1.0);
							vec3 ambient=mix(uSky*0.35, uSky*0.85+vec3(0.06), hcur);       // sky-lit tops, dimmer bases
							vec3 lit=uSunCol*beer*(0.35+0.65*powder)*ph*3.6 + ambient*0.62;
							float a=(1.0-exp(-d*0.09*dt))*smoothstep(cfar,cfar*0.65,t);   // fade the farthest field out instead of letting it pop at the range cap
							col+=tr*a*lit; tr*=1.0-a; }
						t+=dt; }
					cloudc=srgb(aces(col)); ctr=tr; } }   // display-encoded premultiplied cloud light + transmittance for the blend layer
			gl_FragColor=vec4(cloudc,ctr);
		}` });
fs_scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2,2),cloud_mat));
// One-time GPU bake of the tiling 3D cloud noise (Perlin-Worley base + Worley erosion detail), rendered
// slice by slice into 3D textures. Sampling these is ~10x cheaper than the old in-loop fbm, which is what
// pays for the richer lighting and step count above.
function build_cloud_noise(){
	const gen_mat=new THREE.ShaderMaterial({ depthTest:false, depthWrite:false,
		uniforms:{ uZ:{value:0}, uMode:{value:0} },
		vertexShader:`varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }`,
		fragmentShader:`varying vec2 vUv; uniform float uZ,uMode;
			vec3 h3(vec3 p){ p=vec3(dot(p,vec3(127.1,311.7,74.7)),dot(p,vec3(269.5,183.3,246.1)),dot(p,vec3(113.5,271.9,124.6))); return fract(sin(p)*43758.5453); }
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
					gl_FragColor=vec4(remap(pf,wf-1.0,1.0,0.0,1.0), w1,w2,w3);   // R: perlin-worley; GBA: worley fbm octaves
				} else {
					gl_FragColor=vec4(worley(p,4.0),worley(p,8.0),worley(p,16.0),1.0);   // erosion detail octaves
				} }` });
	const gs=new THREE.Scene(); gs.add(new THREE.Mesh(new THREE.PlaneGeometry(2,2),gen_mat));
	const mk=(size,mode)=>{ const t3=new THREE.WebGL3DRenderTarget(size,size,size);
		t3.texture.wrapS=t3.texture.wrapT=t3.texture.wrapR=THREE.RepeatWrapping; t3.texture.minFilter=THREE.LinearFilter; t3.texture.magFilter=THREE.LinearFilter;
		gen_mat.uniforms.uMode.value=mode;
		for(let z=0;z<size;z++){ gen_mat.uniforms.uZ.value=(z+0.5)/size; renderer.setRenderTarget(t3,z); renderer.render(gs,fs_cam); }
		renderer.setRenderTarget(null); return t3.texture; };
	cloud_mat.uniforms.tNoise.value=mk(128,0);
	cloud_mat.uniforms.tDetail.value=mk(64,1);
}
build_cloud_noise();
const comp_mat=new THREE.ShaderMaterial({ depthTest:false, depthWrite:false, transparent:true,
	blending:THREE.CustomBlending, blendSrc:THREE.OneFactor, blendDst:THREE.OneMinusSrcAlphaFactor,   // canvas = cloud.rgb + canvas*tr — the same premultiplied maths the RT composite used, done by the blender over the DIRECT scene render
	uniforms:{ tCloud:{value:null}, uTexel:{value:new THREE.Vector2(1/512,1/512)} },
	vertexShader:`varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }`,
	fragmentShader:`varying vec2 vUv; uniform sampler2D tCloud; uniform vec2 uTexel;
		void main(){   // 4-tap tent upsample of the half-res cloud layer: averages the dither grain away (clouds are soft, so no visible detail is lost)
			vec4 cl=( texture2D(tCloud,vUv+uTexel*vec2(-0.75,-0.75)) + texture2D(tCloud,vUv+uTexel*vec2(0.75,-0.75))
			        + texture2D(tCloud,vUv+uTexel*vec2(-0.75,0.75))  + texture2D(tCloud,vUv+uTexel*vec2(0.75,0.75)) )*0.25;
			gl_FragColor=vec4(cl.rgb,1.0-cl.a); }` });
const comp_scene=new THREE.Scene(); comp_scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2,2),comp_mat));
const depth_override=new THREE.MeshBasicMaterial({colorWrite:false});   // depth-only scene pass for the cloud raymarch
const blur_mat=new THREE.ShaderMaterial({ depthTest:false, depthWrite:false,
	uniforms:{ tSrc:{value:null}, uTexel:{value:new THREE.Vector2(1/512,1/512)} },
	vertexShader:`varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }`,
	fragmentShader:`varying vec2 vUv; uniform sampler2D tSrc; uniform vec2 uTexel;
		void main(){   // 3x3 gaussian at ±1.2 texels: clouds are soft, so this only removes the dither grain
			vec2 o=uTexel*1.5;
			vec4 c=texture2D(tSrc,vUv)*0.25;
			c+=(texture2D(tSrc,vUv+vec2(o.x,0.0))+texture2D(tSrc,vUv-vec2(o.x,0.0))+texture2D(tSrc,vUv+vec2(0.0,o.y))+texture2D(tSrc,vUv-vec2(0.0,o.y)))*0.125;
			c+=(texture2D(tSrc,vUv+o)+texture2D(tSrc,vUv-o)+texture2D(tSrc,vUv+vec2(o.x,-o.y))+texture2D(tSrc,vUv+vec2(-o.x,o.y)))*0.0625;
			gl_FragColor=c; }` });
const blur_scene=new THREE.Scene(); blur_scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2,2),blur_mat));
function render_frame(){
	if(cloud_active()){ size_rt();
		scene.overrideMaterial=depth_override; renderer.setRenderTarget(rt); renderer.render(scene,camera); scene.overrideMaterial=null;   // half-res pass, used only for scene DEPTH (cloud occlusion) — cheap flat shading, no lighting or textures
		invVP.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse).invert();
		cloud_mat.uniforms.tDepth.value=rt.depthTexture;
		cloud_mat.uniforms.uCamPos.value.copy(camera.position); cloud_mat.uniforms.uInvVP.value.copy(invVP); cloud_mat.uniforms.uTime.value=sim_time;
		renderer.setRenderTarget(rt_cloud); renderer.render(fs_scene,fs_cam);   // half-res raymarch
		blur_mat.uniforms.tSrc.value=rt_cloud.texture; blur_mat.uniforms.uTexel.value.set(1/rt_cloud.width,1/rt_cloud.height);
		renderer.setRenderTarget(rt_blur); renderer.render(blur_scene,fs_cam);   // low-pass the cloud layer (kills dither grain)
		renderer.setRenderTarget(null); renderer.render(scene,camera);   // the player-visible scene: the EXACT no-clouds path (canvas MSAA and all)
		comp_mat.uniforms.tCloud.value=rt_blur.texture; comp_mat.uniforms.uTexel.value.set(1/rt_blur.width,1/rt_blur.height);
		renderer.autoClear=false; renderer.render(comp_scene,fs_cam); renderer.autoClear=true;   // blend the cloud layer over it
	} else { renderer.render(scene,camera); }
}

// ============================================================================ geometry
function merge_geometries(geos){ let total=0; const parts=geos.map(g=>(g.index?g.toNonIndexed():g)); parts.forEach(g=>total+=g.attributes.position.count);
	const pos=new Float32Array(total*3),nor=new Float32Array(total*3); let o=0;
	for(const g of parts){ const p=g.attributes.position.array,n=g.attributes.normal.array; pos.set(p,o); nor.set(n,o); o+=p.length; }
	const out=new THREE.BufferGeometry(); out.setAttribute("position",new THREE.BufferAttribute(pos,3)); out.setAttribute("normal",new THREE.BufferAttribute(nor,3)); out.computeBoundingSphere(); return out; }
function load_blob(d,r){ return new THREE.IcosahedronGeometry(r,d); }
function build_exterior(detail){ const seg=[10,12,16,20,24,28][detail-1]; const parts=[];
	const body=new THREE.CylinderGeometry(0.62,0.95,9,seg,3); body.rotateZ(-Math.PI/2); parts.push(body);
	const nose=new THREE.ConeGeometry(0.62,3.4,seg); nose.rotateZ(-Math.PI/2); nose.translate(6.2,0,0); parts.push(nose);
	const tail=new THREE.ConeGeometry(0.95,1.6,seg); tail.rotateZ(Math.PI/2); tail.translate(-5.3,0,0); parts.push(tail);
	for(const side of [1,-1]){ const noz=new THREE.CylinderGeometry(0.45,0.55,1.4,seg,2); noz.rotateZ(Math.PI/2); noz.translate(-6.0,0,side*0.55); parts.push(noz);
		const ring=new THREE.TorusGeometry(0.5,0.08,Math.max(6,seg/2),seg); ring.rotateY(Math.PI/2); ring.translate(-6.7,0,side*0.55); parts.push(ring); }
	for(const side of [1,-1]){ const wing=new THREE.BoxGeometry(5.2,0.18,4.6,4,1,4); wing.translate(-0.6,-0.1,side*3.4); wing.rotateY(side*0.34); parts.push(wing);
		const ail=new THREE.BoxGeometry(1.6,0.16,1.2,2,1,2); ail.translate(-2.4,-0.1,side*4.6); ail.rotateY(side*0.34); parts.push(ail);
		const lex=new THREE.BoxGeometry(3.4,0.16,1.5,3,1,2); lex.translate(1.6,0.05,side*1.5); lex.rotateY(side*0.5); parts.push(lex);
		const vt=new THREE.BoxGeometry(2.0,1.8,0.14,2,2,1); vt.translate(-4.2,1.1,side*0.8); vt.rotateX(side*0.28); parts.push(vt);
		const hs=new THREE.BoxGeometry(1.8,0.14,2.0,2,1,2); hs.translate(-4.6,0,side*1.7); hs.rotateY(side*0.3); parts.push(hs);
		const pyl=new THREE.BoxGeometry(0.8,0.4,0.18); pyl.translate(-0.4,-0.5,side*3.0); parts.push(pyl);
		const msl=new THREE.CylinderGeometry(0.13,0.13,2.6,seg); msl.rotateZ(-Math.PI/2); msl.translate(-0.2,-0.8,side*3.0); parts.push(msl);
		const mtip=new THREE.ConeGeometry(0.13,0.5,seg); mtip.rotateZ(-Math.PI/2); mtip.translate(1.35,-0.8,side*3.0); parts.push(mtip); }
	const rivets=24*detail; for(let i=0;i<rivets;i++){ const r=new THREE.BoxGeometry(0.06,0.06,0.06); r.translate(5-(i/rivets)*10,0.62,0); parts.push(r); }
	parts.push(load_blob(Math.min(detail+2,7),0.8));
	return merge_geometries(parts); }
function build_exterior_low(){ const parts=[];
	const body=new THREE.CylinderGeometry(0.62,0.95,9,8); body.rotateZ(-Math.PI/2); parts.push(body);
	const nose=new THREE.ConeGeometry(0.62,3.4,8); nose.rotateZ(-Math.PI/2); nose.translate(6.2,0,0); parts.push(nose);
	for(const side of [1,-1]){ const wing=new THREE.BoxGeometry(5.2,0.18,4.6); wing.translate(-0.6,-0.1,side*3.4); wing.rotateY(side*0.34); parts.push(wing);
		const vt=new THREE.BoxGeometry(2.0,1.8,0.14); vt.translate(-4.2,1.1,side*0.8); vt.rotateX(side*0.28); parts.push(vt); }
	return merge_geometries(parts); }
const ab_geo=new THREE.ConeGeometry(0.3,2.6,12); ab_geo.rotateZ(Math.PI/2);
const ab_mat=new THREE.MeshBasicMaterial({color:0xffaa44,transparent:true,opacity:0.8,blending:THREE.AdditiveBlending,depthWrite:false,fog:false});
function make_jet(tint){ const g=new THREE.Group(); g.userData.tint=tint;   // afterburner cones only — the airframe is the loaded GLB (no procedural fallback)
	for(const side of [1,-1]){ const ab=new THREE.Mesh(ab_geo,ab_mat); ab.position.set(-9.3,-0.37,side*0.48); ab.userData.ab=true; g.add(ab); } return g; }   // at the Hornet's twin nozzles (Y raised from -0.95 after the gear extended the model bbox, shifting normalise's centre up ~0.58)

// ============================================================================ optional external GLB model (cosmetic only)
// Drop a downloaded glTF/GLB next to this file named "fighter.glb" to replace the procedural airframe.
// Source must be UNCOMPRESSED glTF/GLB (no Draco/Meshopt) — Sketchfab's plain "glTF" download works.
// If the file is missing or the loader CDN is blocked, the procedural jet is used automatically.
const MODEL = { url:"models/fighter.glb", length:18.3, yaw:0, pitch:0, roll:0 };  // length in world units (nose-tail); rot in degrees
// This asset is already nose +X / up +Y, so all rotations are 0. If you swap in a DIFFERENT model and it looks wrong:
// flies BACKWARDS -> yaw 180; on its SIDE / wings vertical -> roll 90 or -90; nose pitched up/down -> pitch 90 or -90; upside down -> roll 180.
const D2R=Math.PI/180;
let model_active=false, jet_proto=null;
let gear_clips=[], hook_clips=[]; const GEAR_RATE=0.5;   // fold clips baked into fighter.glb (gear_* + hook); GEAR_RATE = extend/retract speed of the 0..1 progress (~2s cycle)
function model_tint(hex){ return hex===0xb04a3a?0xff9a86 : hex===0x7f8a96?0xdde3ea : 0xffffff; }   // light team tints (white = untouched)
function normalise_model(scene){ scene.updateMatrixWorld(true);
	const box=new THREE.Box3().setFromObject(scene), size=box.getSize(new THREE.Vector3()), ctr=box.getCenter(new THREE.Vector3());
	const s=MODEL.length/Math.max(size.x,size.y,size.z,1e-3);
	scene.scale.setScalar(s); scene.position.set(-ctr.x*s,-ctr.y*s,-ctr.z*s);
	const proto=new THREE.Group(); proto.add(scene);
	proto.rotation.set(MODEL.pitch*D2R, MODEL.yaw*D2R, MODEL.roll*D2R); proto.updateMatrixWorld(true); return proto; }
function apply_model_to(g){ if(!jet_proto||g.userData.hasModel) return; g.userData.hasModel=true;
	g.children.forEach(c=>{ if(c.userData.body||c.userData.glass) c.visible=false; });   // hide procedural shell, keep afterburner cones
	const m=jet_proto.clone(true); m.userData.model=true; const tint=model_tint(g.userData.tint||0xffffff);
	m.traverse(o=>{ if(o.isMesh){ o.userData.modelmesh=true; o.castShadow=cfg.shadows;
		if(tint!==0xffffff && o.material && o.material.color){ o.material=o.material.clone(); o.material.color=o.material.color.clone().multiply(new THREE.Color(tint)); } } });
	g.add(m);
	if(gear_clips.length||hook_clips.length){ const mixer=new THREE.AnimationMixer(m); g.userData.gearMixer=mixer;   // per-aircraft gear+hook fold; scrubbed by progress in update_anim()
		g.userData.gearActions=gear_clips.map(c=>{ const a=mixer.clipAction(c); a.play(); return { action:a, dur:c.duration||1 }; });
		g.userData.hookActions=hook_clips.map(c=>{ const a=mixer.clipAction(c); a.play(); return { action:a, dur:c.duration||1 }; }); } }
function apply_model_all(){ apply_model_to(ownship.group); apply_model_to(bandit.group); extras.forEach(s=>apply_model_to(s.group)); position_aircraft_lights(); }   // re-pin the ownship lights to the real airframe
// --- minimal GLB container surgery (so we never trigger the loader's blob-URL texture path) ---
function glb_split(ab){ const dv=new DataView(ab); if(dv.getUint32(0,true)!==0x46546C67) throw new Error("not a GLB");
	let o=12; const jsonLen=dv.getUint32(o,true); o+=8; const json=JSON.parse(new TextDecoder().decode(new Uint8Array(ab,o,jsonLen))); o+=jsonLen;
	let bin=null; if(o<ab.byteLength){ const binLen=dv.getUint32(o,true); o+=8; bin=new Uint8Array(ab.slice(o,o+binLen)); } return {json,bin}; }
function glb_repack(json,bin){ const js=new TextEncoder().encode(JSON.stringify(json));
	const jsPad=(4-(js.length%4))%4, jsonLen=js.length+jsPad, binLen=bin?bin.length:0;
	const total=12+8+jsonLen+(bin?8+binLen:0), out=new Uint8Array(total), dv=new DataView(out.buffer);
	dv.setUint32(0,0x46546C67,true); dv.setUint32(4,2,true); dv.setUint32(8,total,true);
	dv.setUint32(12,jsonLen,true); dv.setUint32(16,0x4E4F534A,true);
	out.set(js,20); for(let i=20+js.length;i<20+jsonLen;i++) out[i]=0x20;
	if(bin){ const bo=20+jsonLen; dv.setUint32(bo,binLen,true); dv.setUint32(bo+4,0x004E4942,true); out.set(bin,bo+8); }
	return out.buffer; }
// Map each material's baseColor image (keyed by material name) so we can re-attach per-material
// textures after parse: the loader's own texture path builds blob: URLs the sandbox rejects, so we
// strip textures, parse, then decode each in-process and assign. Solid-colour materials (no
// baseColorTexture) keep their baseColorFactor, so a multi-material model renders its full livery.
function model_textures(parts){ const out={}; const images=parts.json.images||[], textures=parts.json.textures||[], bvs=parts.json.bufferViews||[];
	(parts.json.materials||[]).forEach(m=>{ const bct=m.pbrMetallicRoughness&&m.pbrMetallicRoughness.baseColorTexture;
		if(!bct||!m.name||!textures[bct.index]) return; const im=images[textures[bct.index].source]; if(!im||im.bufferView==null||!parts.bin) return;
		const bv=bvs[im.bufferView]; out[m.name]={ bytes:parts.bin.slice(bv.byteOffset||0,(bv.byteOffset||0)+bv.byteLength), mime:im.mimeType||"image/jpeg" }; });
	return out; }
async function init_external_model(){
	const tag=MODEL.url.startsWith("data:")?"embedded model":MODEL.url;
	try{
		// Fetch/decode the GLB bytes ourselves (the loader's .load() builds a Request that sandboxed iframes can't clone).
		let abuf;
		if(MODEL.url.startsWith("data:")){ const b64=MODEL.url.slice(MODEL.url.indexOf(",")+1); const bin=atob(b64);
			const u=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i); abuf=u.buffer; }
		else { const resp=await fetch(MODEL.url); if(!resp.ok) throw new Error("HTTP "+resp.status); abuf=await resp.arrayBuffer(); }
		// Capture per-material baseColor images, then strip texture refs so parse() never makes a blob: URL (which the sandbox rejects).
		const parts=glb_split(abuf); const tex_by_material=model_textures(parts);
		(parts.json.materials||[]).forEach(m=>{ if(m.pbrMetallicRoughness){ delete m.pbrMetallicRoughness.baseColorTexture; delete m.pbrMetallicRoughness.metallicRoughnessTexture; } delete m.normalTexture; delete m.occlusionTexture; delete m.emissiveTexture; });
		delete parts.json.textures; delete parts.json.images; delete parts.json.samplers;
		const clean=glb_repack(parts.json, parts.bin);
		new GLTFLoader().parse(clean, "",
			async gltf=>{ try{
				jet_proto=normalise_model(gltf.scene); const anims=gltf.animations||[];   // split baked clips: gear_* fold vs the hook
					gear_clips=anims.filter(c=>c.name&&c.name.indexOf("gear")===0); hook_clips=anims.filter(c=>c.name&&c.name.indexOf("hook")===0);
				if(typeof createImageBitmap==="function"){
					const decoded={};   // material name -> THREE.Texture (decoded in-process, no URL/fetch)
					await Promise.all(Object.keys(tex_by_material).map(async name=>{ try{
						const src=tex_by_material[name]; const bmp=await createImageBitmap(new Blob([src.bytes],{type:src.mime}));
						const tex=new THREE.Texture(bmp); tex.flipY=false; tex.colorSpace=THREE.SRGBColorSpace; tex.wrapS=tex.wrapT=THREE.RepeatWrapping; tex.anisotropy=4; tex.needsUpdate=true; decoded[name]=tex;
					}catch(te){ console.warn("[model] texture decode failed for "+name,te&&te.message||te); } }));
					jet_proto.traverse(o=>{ if(o.isMesh&&o.material){ (Array.isArray(o.material)?o.material:[o.material]).forEach(mm=>{
						if(decoded[mm.name]){ mm.map=decoded[mm.name]; }
						if(mm.metalness!==undefined && !/glass|screen|oleo|gear/i.test(mm.name||"")){ mm.metalness=0.0; mm.roughness=0.88; }   // matte low-vis tactical paint; keep canopy glass, chrome oleo, and the gear (semi-gloss, matching the donor) untouched
						mm.needsUpdate=true;
					}); } });
				}
				model_active=true; apply_model_all();
			}catch(e){ throw new Error("fighter model: failed to process "+tag+": "+(e&&e.message||e)); } },
			err=>{ throw new Error("fighter model: parse failed for "+tag+" ("+((err&&err.message)||"bad glTF")+") — ensure uncompressed glTF/GLB (no Draco)"); });
	}catch(e){ throw new Error("fighter model: not loaded "+tag+" ("+((e&&e.message)||e)+")"); }
}

// ============================================================================ optional external carrier model
const CARRIER_MODEL = { url:"models/carrier.glb", length:300, yaw:110, draft_frac:0.375 };   // yaw 110 → bow heading ~070°T (into the ENE trades, toward Midway); heading = 180 − yaw, so 90 was due-east
// Placed so bow -> +X (yaw 90; flip to -90 or +180 if reversed) and the waterline sits at y=0.
// draft_frac = fraction of the keel->deck height kept BELOW water; raise it to sit the hull deeper.
let carrier_model=null; const _ray=new THREE.Raycaster();
function glb_image(p,ti){ if(ti==null||!p.bin||!p.json.textures) return null; const t=p.json.textures[ti]; if(!t) return null;
	const im=p.json.images&&p.json.images[t.source]; if(!im||im.bufferView==null) return null; const bv=p.json.bufferViews[im.bufferView];
	return { bytes:p.bin.slice(bv.byteOffset||0,(bv.byteOffset||0)+bv.byteLength), mime:im.mimeType||"image/png" }; }
async function make_tex(src,srgb){ const bmp=await createImageBitmap(new Blob([src.bytes],{type:src.mime}));
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
function deck_y_at(grp,x,z,fallback){ _ray.set(new THREE.Vector3(x,5000,z), new THREE.Vector3(0,-1,0)); const hits=_ray.intersectObject(grp,true); return hits.length?hits[0].point.y:fallback; }
// Place ownship on the configured catapult (deck height found by raycast when a model carrier is present).
let deck_edit=false;
function place_on_cat(i=cat_idx){
	// A cat pose ({x,z} offset, h launch heading) was tuned at yaw 90; rotate it by the
	// carrier's yaw delta so it tracks the ship when the heading changes. R_y: x'=x·c+z·s, z'=−x·s+z·c.
	const cat=cfg.cats[i], yaw_delta=(CARRIER_MODEL.yaw-90)*D2R, c=Math.cos(yaw_delta), s=Math.sin(yaw_delta);
	const wx=CARRIER.x+(cat.x*c+cat.z*s), wz=CARRIER.z+(-cat.x*s+cat.z*c);
	const hd=cat.h*D2R, fx=Math.cos(hd), fz=-Math.sin(hd);
	const fwd=new THREE.Vector3(fx*c+fz*s,0,-fx*s+fz*c);
	const dy=carrier_model?deck_y_at(carrier_model,wx,wz,CARRIER.deckY):CARRIER.deckY;
	ownship.pos.set(wx, dy+cfg.cat_dy, wz); ownship.fwd.copy(fwd); ownship.vel_dir.copy(fwd);
	const r=new THREE.Vector3().crossVectors(fwd,world_up).normalize(), u=new THREE.Vector3().crossVectors(r,fwd).normalize();
	ownship.q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(fwd,u,r)); }
function edit_cat(dt){ const mv=dt*1.2, rot=dt*2.5, cat=cfg.cats[cat_idx]; let ch=false;   // 10x finer positional nudges + heading for precise alignment
	if(keys.has("KeyI")){ cat.x+=mv; ch=true; } if(keys.has("KeyK")){ cat.x-=mv; ch=true; }     // fore / aft
	if(keys.has("KeyJ")){ cat.z-=mv; ch=true; } if(keys.has("KeyL")){ cat.z+=mv; ch=true; }     // port / starboard
	if(keys.has("BracketRight")){ cfg.cat_dy+=mv*0.5; ch=true; } if(keys.has("BracketLeft")){ cfg.cat_dy-=mv*0.5; ch=true; }  // ] up / [ down (shared height)
	if(keys.has("KeyU")){ cat.h+=rot; ch=true; } if(keys.has("KeyO")){ cat.h-=rot; ch=true; }   // rotate heading
	if(ch) place_on_cat(); }
async function init_carrier_model(){
	const tag=CARRIER_MODEL.url.startsWith("data:")?"embedded carrier":CARRIER_MODEL.url;
	try{ 
		let abuf;
		if(CARRIER_MODEL.url.startsWith("data:")){ const b64=CARRIER_MODEL.url.slice(CARRIER_MODEL.url.indexOf(",")+1); const bin=atob(b64);
			const u=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i); abuf=u.buffer; }
		else { const resp=await fetch(CARRIER_MODEL.url); if(!resp.ok) throw new Error("HTTP "+resp.status); abuf=await resp.arrayBuffer(); }
		const parts=glb_split(abuf); const M=(parts.json.materials||[])[0]||{};
		const baseSrc=glb_image(parts, M.pbrMetallicRoughness&&M.pbrMetallicRoughness.baseColorTexture&&M.pbrMetallicRoughness.baseColorTexture.index);
		const normSrc=glb_image(parts, M.normalTexture&&M.normalTexture.index);
		(parts.json.materials||[]).forEach(m=>{ if(m.pbrMetallicRoughness){ delete m.pbrMetallicRoughness.baseColorTexture; delete m.pbrMetallicRoughness.metallicRoughnessTexture; } delete m.normalTexture; delete m.occlusionTexture; delete m.emissiveTexture; });
		delete parts.json.textures; delete parts.json.images; delete parts.json.samplers;
		const clean=glb_repack(parts.json, parts.bin);
		new GLTFLoader().parse(clean, "", async gltf=>{ try{
			const gscene=gltf.scene; gscene.updateMatrixWorld(true);
			const b0=new THREE.Box3().setFromObject(gscene), sz=b0.getSize(new THREE.Vector3());
			const s=CARRIER_MODEL.length/Math.max(sz.x,sz.y,sz.z,1e-3);
			const grp=new THREE.Group(); grp.add(gscene); grp.scale.setScalar(s); grp.rotation.y=CARRIER_MODEL.yaw*D2R; grp.updateMatrixWorld(true);
			const b1=new THREE.Box3().setFromObject(grp), c1=b1.getCenter(new THREE.Vector3());          // centre over CARRIER.x/z
			grp.position.x+=CARRIER.x-c1.x; grp.position.z+=CARRIER.z-c1.z; grp.updateMatrixWorld(true);
			const st=model_y_stats(grp); const waterline=st.keelY+CARRIER_MODEL.draft_frac*(st.deckY-st.keelY);   // sink so waterline -> y=0
			grp.position.y-=waterline; grp.updateMatrixWorld(true);
			let baseTex=null,normTex=null;
			if(baseSrc&&typeof createImageBitmap==="function"){ try{ baseTex=await make_tex(baseSrc,true); }catch(e){} }
			if(normSrc&&typeof createImageBitmap==="function"){ try{ normTex=await make_tex(normSrc,false); }catch(e){} }
			grp.traverse(o=>{ if(o.isMesh&&o.material){ const mm=o.material; if(baseTex)mm.map=baseTex; if(normTex)mm.normalMap=normTex; mm.metalness=0.0; mm.roughness=0.9; mm.needsUpdate=true; o.castShadow=cfg.shadows; o.receiveShadow=true; } });
			carrier_model=grp; scene.add(grp);
			/* procedural carrier removed; nothing to hide */
			const yd=(CARRIER_MODEL.yaw-90)*D2R, dc=Math.cos(yd), ds=Math.sin(yd);                        // rotate the sample spot with the carrier heading
			CARRIER.deckY=deck_y_at(grp, CARRIER.x+(70*dc-6*ds), CARRIER.z+(-70*ds-6*dc), st.deckY-waterline);   // deck height near the catapult spot (carrier-relative)
			build_carrier_deck_aids();   // wires + OLS, now that the deck height is known
			if(mission_start()==="carrier" && !ownship.launching && ownship.speed<5){ place_on_cat(); flight_push(); }   // re-spot on the cat at the now-known deck height, unless already taxiing / launched
		}catch(e){ throw new Error("carrier model: failed to process "+tag+": "+(e&&e.message||e)); } },
		err=>{ throw new Error("carrier model: parse failed for "+tag+" ("+((err&&err.message)||"bad glTF")+")"); });
	}catch(e){ throw new Error("carrier model: not loaded "+tag+" ("+((e&&e.message)||e)+")"); }
}

// ============================================================================ particles (proven)
function glow_texture(soft){ const c=document.createElement("canvas"); c.width=c.height=64; const x=c.getContext("2d"); const g=x.createRadialGradient(32,32,0,32,32,32);
	if(soft){ g.addColorStop(0,"rgba(180,180,180,0.5)"); g.addColorStop(0.5,"rgba(150,150,150,0.18)"); g.addColorStop(1,"rgba(150,150,150,0)"); }
	else { g.addColorStop(0,"rgba(255,255,255,1)"); g.addColorStop(0.3,"rgba(255,240,200,0.9)"); g.addColorStop(1,"rgba(255,200,120,0)"); }
	x.fillStyle=g; x.fillRect(0,0,64,64); return new THREE.CanvasTexture(c); }
function make_points(max,size,additive,tex){ const geo=new THREE.BufferGeometry();
	geo.setAttribute("position",new THREE.BufferAttribute(new Float32Array(max*3),3)); geo.setAttribute("color",new THREE.BufferAttribute(new Float32Array(max*3),3));
	const mat=new THREE.PointsMaterial({size,map:tex,vertexColors:true,transparent:true,blending:additive?THREE.AdditiveBlending:THREE.NormalBlending,depthWrite:false,sizeAttenuation:true,fog:!additive});
	const pts=new THREE.Points(geo,mat); pts.frustumCulled=false; scene.add(pts); return pts; }
const glow=glow_texture(false), soft=glow_texture(true);
function light_dot_texture(){ const c=document.createElement("canvas"); c.width=c.height=64; const x=c.getContext("2d"); const g=x.createRadialGradient(32,32,0,32,32,32);   // crisp light point (solid core, quick falloff) — no big halo, unlike the soft `glow`
	g.addColorStop(0,"rgba(255,255,255,1)"); g.addColorStop(0.36,"rgba(255,255,255,1)"); g.addColorStop(0.6,"rgba(255,255,255,0.3)"); g.addColorStop(1,"rgba(255,255,255,0)");   // solid opaque core → bright + crisp
	x.fillStyle=g; x.fillRect(0,0,64,64); return new THREE.CanvasTexture(c); }
const light_dot=light_dot_texture();
function windsock_texture(){ const c=document.createElement("canvas"); c.width=8; c.height=160; const x=c.getContext("2d");   // 5 alternating orange/white bands along the length (standard windsock)
	const cols=["#e8531a","#f2f2f2"]; for(let i=0;i<5;i++){ x.fillStyle=cols[i%2]; x.fillRect(0,i*32,8,32); }
	const t=new THREE.CanvasTexture(c); t.colorSpace=THREE.SRGBColorSpace; return t; }
function pool(max){ return { px:new Float32Array(max),py:new Float32Array(max),pz:new Float32Array(max), vx:new Float32Array(max),vy:new Float32Array(max),vz:new Float32Array(max),
	life:new Float32Array(max),ttl:new Float32Array(max), r:new Float32Array(max),g:new Float32Array(max),b:new Float32Array(max), active:new Uint8Array(max), max, next:0 }; }
function pool_spawn(p){ for(let i=0;i<p.max;i++){ const k=(p.next+i)%p.max; if(!p.active[k]){ p.next=(k+1)%p.max; p.active[k]=1; return k; } } return -1; }
const TR_MAX=4000,FL_MAX=2500,SM_MAX=3000;
const tracers=pool(TR_MAX),flares=pool(FL_MAX),smoke=pool(SM_MAX);
const tr_pts=make_points(TR_MAX,4,false,glow), fl_pts=make_points(FL_MAX,26,true,glow), sm_pts=make_points(SM_MAX,70,false,soft);   // tracers: small + NORMAL blend (additive blew the colour out to white against bright sky)
function flush_points(p,pts){ const pos=pts.geometry.attributes.position.array,col=pts.geometry.attributes.color.array; let n=0;
	for(let i=0;i<p.max;i++){ if(!p.active[i]) continue; const o=n*3; pos[o]=p.px[i];pos[o+1]=p.py[i];pos[o+2]=p.pz[i];
		const f=Math.max(0,p.life[i]/p.ttl[i]); col[o]=p.r[i]*f;col[o+1]=p.g[i]*f;col[o+2]=p.b[i]*f; n++; }
	pts.geometry.setDrawRange(0,n); pts.geometry.attributes.position.needsUpdate=true; pts.geometry.attributes.color.needsUpdate=true; return n; }
let live_particles=0;
function update_pool_ballistic(p,dt,grav,drag){ for(let i=0;i<p.max;i++){ if(!p.active[i]) continue;
	p.vy[i]-=grav*dt; if(drag){p.vx[i]*=drag;p.vy[i]*=drag;p.vz[i]*=drag;}
	p.px[i]+=p.vx[i]*dt; p.py[i]+=p.vy[i]*dt; p.pz[i]+=p.vz[i]*dt; p.life[i]-=dt; if(p.life[i]<=0||p.py[i]<0) p.active[i]=0; } }

const muzzle=1050; const gun={};
function fire_gun(st,target,key,dt,force){
	let active;
	if(force!==undefined) active=force;
	else { const to=target.pos.clone().sub(st.pos); const rng=to.length(); active=(rng<2500 && st.fwd.dot(to.normalize())>0.985); }
	if(!active) return; if(st.rounds!==undefined && st.rounds<=0) return; if(!cfg.tracers && st===ownship) {} // tracers toggle only affects render
	const rps=100; gun[key]=(gun[key]||0)+rps*dt;   // M61 Vulcan: 6000 rpm = 100 rounds/sec
	while(gun[key]>=1){ gun[key]-=1; if(st.rounds!==undefined){ if(st.rounds<=0) break; st.rounds--; }
		const tr=(Math.floor(gun[key+"_n"]||0)%5)===0; gun[key+"_n"]=(gun[key+"_n"]||0)+1;
		if(!tr) continue;   // only 1 in 5 rounds is a visible tracer; the rest fire invisibly
		const k=pool_spawn(tracers); if(k<0) break; const sp=body_offset(st,6.0,0.35,0.0);   // gun port: nose-top centreline (forward of the windscreen)
		tracers.px[k]=sp.x;tracers.py[k]=sp.y;tracers.pz[k]=sp.z; const spread=0.004;
		tracers.vx[k]=st.fwd.x*muzzle+(Math.random()-0.5)*spread*muzzle+st.velx;
		tracers.vy[k]=st.fwd.y*muzzle+(Math.random()-0.5)*spread*muzzle+st.vely;
		tracers.vz[k]=st.fwd.z*muzzle+(Math.random()-0.5)*spread*muzzle+st.velz;
		tracers.ttl[k]=tracers.life[k]=1.8;   // ~1.8s @1050m/s -> ~1900m burnout (real 20mm tracer range; no drag in this sim)
		tracers.r[k]=1.3;tracers.g[k]=0.42;tracers.b[k]=0.1; } }   // red-orange; normal-blended (see tr_pts) so the colour reads instead of blowing out white
const flare_timer={bandit:4.5};
function dispense_flares(st){ for(let i=0;i<36;i++){ const k=pool_spawn(flares); if(k<0) break; const sp=local_offset(st,-2,-0.3,0);
	flares.px[k]=sp.x;flares.py[k]=sp.y;flares.pz[k]=sp.z; flares.vx[k]=st.velx*0.5+(Math.random()-0.5)*40; flares.vy[k]=st.vely*0.5-Math.random()*25; flares.vz[k]=st.velz*0.5+(Math.random()-0.5)*40;
	flares.ttl[k]=flares.life[k]=3.5+Math.random()*1.5; flares.r[k]=2.6;flares.g[k]=2.3;flares.b[k]=1.2; } }   // brilliant white-hot with a warm tinge (burning magnesium), not orange
const MSL_MAX=8;
const missile_geo=(()=>{ const parts=[]; const b=new THREE.CylinderGeometry(0.12,0.12,2.4,12); b.rotateZ(-Math.PI/2); parts.push(b);
	const n=new THREE.ConeGeometry(0.12,0.5,12); n.rotateZ(-Math.PI/2); n.translate(1.45,0,0); parts.push(n);
	for(const s of [0,1,2,3]){ const f=new THREE.BoxGeometry(0.4,0.02,0.3); f.translate(-1.0,0,0); f.rotateX(s*Math.PI/2); parts.push(f); } return merge_geometries(parts); })();
const missile_mat=new THREE.MeshStandardMaterial({color:0xdedede,metalness:0.3,roughness:0.6});
const missiles=[]; for(let i=0;i<MSL_MAX;i++){ const m=new THREE.Mesh(missile_geo,missile_mat); m.visible=false; scene.add(m);
	missiles.push({mesh:m,active:false,px:0,py:0,pz:0,vx:0,vy:0,vz:0,life:0,target:null,smoke_acc:0}); }
function launch_missile(st,target){ const m=missiles.find(x=>!x.active); if(!m) return false; const sp=local_offset(st,1,-0.8,0);
	m.active=true; m.mesh.visible=true; m.px=sp.x;m.py=sp.y;m.pz=sp.z; m.vx=st.fwd.x*st.speed+st.fwd.x*60; m.vy=st.fwd.y*st.speed; m.vz=st.fwd.z*st.speed+st.fwd.z*60; m.life=8; m.target=target; m.smoke_acc=0; return true; }
const _v=new THREE.Vector3();
function update_missiles(dt){ for(const m of missiles){ if(!m.active) continue; m.life-=dt; if(m.life<=0){ m.active=false; m.mesh.visible=false; continue; }
	const t=m.target; if(t){ _v.set(t.pos.x-m.px,t.pos.y-m.py,t.pos.z-m.pz); const dist=_v.length(); if(dist<25){ m.active=false; m.mesh.visible=false; continue; } _v.normalize();
		const spd=Math.min(900,Math.hypot(m.vx,m.vy,m.vz)+450*dt); let dx=m.vx,dy=m.vy,dz=m.vz; const dl=Math.hypot(dx,dy,dz)||1; dx/=dl;dy/=dl;dz/=dl;
		const turn=Math.min(1,dt*2.5); dx+=(_v.x-dx)*turn; dy+=(_v.y-dy)*turn; dz+=(_v.z-dz)*turn; const nl=Math.hypot(dx,dy,dz)||1; m.vx=dx/nl*spd;m.vy=dy/nl*spd;m.vz=dz/nl*spd;
	} else { const spd=Math.min(900,Math.hypot(m.vx,m.vy,m.vz)+450*dt); const l=Math.hypot(m.vx,m.vy,m.vz)||1; m.vx=m.vx/l*spd;m.vy=m.vy/l*spd;m.vz=m.vz/l*spd; }
	m.px+=m.vx*dt;m.py+=m.vy*dt;m.pz+=m.vz*dt; m.mesh.position.set(m.px,m.py,m.pz); m.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(1,0,0),new THREE.Vector3(m.vx,m.vy,m.vz).normalize());
	m.smoke_acc+=dt; while(m.smoke_acc>0.02){ m.smoke_acc-=0.02; const k=pool_spawn(smoke); if(k<0) break;
		smoke.px[k]=m.px-m.vx*0.01;smoke.py[k]=m.py;smoke.pz[k]=m.pz-m.vz*0.01; smoke.vx[k]=(Math.random()-0.5)*6;smoke.vy[k]=(Math.random()-0.5)*6+2;smoke.vz[k]=(Math.random()-0.5)*6;
		smoke.ttl[k]=smoke.life[k]=2.8; smoke.r[k]=0.7;smoke.g[k]=0.72;smoke.b[k]=0.75; } } }

// ============================================================================ flight
const world_up=new THREE.Vector3(0,1,0);
function make_state(pos,fwd,speed){ return { pos:pos.clone(), fwd:fwd.clone().normalize(), speed, bank:0, group:null,
	break_t:0, break_dir:new THREE.Vector3(1,0,0), circle_phase:Math.random()*Math.PI*2, circle_radius:1500+Math.random()*2500, circle_alt:1600+Math.random()*2200, velx:0,vely:0,velz:0, gear:1, gearTarget:1, hook:0, hookTarget:0, speedbrake:0, speedbrakeTarget:0 }; }   // gear 0=down 1=up, hook 0=stowed 1=deployed, speedbrake 0=stowed 1=deployed (default clean for bandits/extras)
function steer(st,desired,dt,max_rate,max_bank){ desired.normalize(); let ang=st.fwd.angleTo(desired); const max=max_rate*dt;
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
ownship.vel_dir=ownship.fwd.clone(); ownship.throttle=0.85; ownship.rounds=578; ownship.msl=4; ownship.cm=60; ownship.aoa=0; ownship.gload=1;
ownship.launching=false;
// init quaternion from initial fwd
(()=>{ const r=new THREE.Vector3().crossVectors(ownship.fwd,world_up).normalize(); const u=new THREE.Vector3().crossVectors(r,ownship.fwd).normalize();
	ownship.q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(ownship.fwd,u,r)); })();
const bandit=make_state(new THREE.Vector3(3000,2400,-1000),new THREE.Vector3(-0.3,0,1),195);
let aircraft_lights=null;
ownship.group=make_jet(0x9aa6b2); bandit.group=make_jet(0xb04a3a); scene.add(ownship.group,bandit.group);
build_aircraft_lights();

// ---- aircraft carrier (static landmark + launch platform) ----
function deck_texture(){ const c=document.createElement("canvas"); c.width=1024; c.height=320; const x=c.getContext("2d");
	x.fillStyle="#30343a"; x.fillRect(0,0,1024,320);
	// 4 elevator outlines (deck-edge)
	x.strokeStyle="#5a5f66"; x.lineWidth=3; x.setLineDash([]);
	[[150,8,90,70],[470,8,90,70],[760,8,90,70],[150,244,90,70]].forEach(([ex,ey,ew,eh])=>{ x.fillStyle="#3a3f45"; x.fillRect(ex,ey,ew,eh); x.strokeRect(ex,ey,ew,eh); });
	// angled landing area
	x.save(); x.translate(430,170); x.rotate(-9*Math.PI/180);
	x.strokeStyle="#f0f0f0"; x.lineWidth=4; x.strokeRect(-320,-58,640,116);
	x.setLineDash([30,22]); x.lineWidth=7; x.strokeStyle="#f4f4f4"; x.beginPath(); x.moveTo(-320,0); x.lineTo(320,0); x.stroke(); x.setLineDash([]);
	// touchdown target + arrestor reference bars
	x.fillStyle="#f4f4f4"; for(let i=-2;i<=2;i++){ x.fillRect(-40,i*16-4,80,8); }
	x.restore();
	// landing number
	x.fillStyle="#ededed"; x.font="bold 110px sans-serif"; x.textAlign="center"; x.textBaseline="middle";
	x.save(); x.translate(250,170); x.rotate(-9*Math.PI/180); x.fillText("68",0,0); x.restore();
	// bow catapult tracks (toward +u)
	x.strokeStyle="#dadada"; x.lineWidth=4; x.beginPath();
	x.moveTo(700,120); x.lineTo(1010,96); x.moveTo(700,176); x.lineTo(1010,176); x.stroke();
	// JBD / foul lines
	x.strokeStyle="#d9b430"; x.lineWidth=5; x.beginPath(); x.moveTo(660,60); x.lineTo(1010,46); x.moveTo(640,300); x.lineTo(420,210); x.stroke();
	const t=new THREE.CanvasTexture(c); t.colorSpace=THREE.SRGBColorSpace; t.anisotropy=renderer.capabilities.getMaxAnisotropy(); return t; }
function build_carrier(){
	const g=new THREE.Group();
	const hullMat=new THREE.MeshStandardMaterial({color:0x474c52,metalness:0.45,roughness:0.72,flatShading:true});
	const deckMat=new THREE.MeshStandardMaterial({color:0x31353b,metalness:0.2,roughness:0.93});
	const islMat=new THREE.MeshStandardMaterial({color:0x565b61,metalness:0.45,roughness:0.68,flatShading:true});
	const drkMat=new THREE.MeshStandardMaterial({color:0x202327,metalness:0.5,roughness:0.6,flatShading:true});
	// hull: main box, tapered bow, transom stern, bulb
	const hp=[];
	const hull=new THREE.BoxGeometry(286,24,40); hull.translate(0,7,0); hp.push(hull);
	// bow taper — two angled side wedges + prow
	for(const s of [1,-1]){ const side=new THREE.BoxGeometry(54,24,22); side.rotateY(-s*0.34); side.translate(150,7,s*9); hp.push(side); }
	const prow=new THREE.BoxGeometry(18,24,14); prow.translate(172,7,0); hp.push(prow);
	const stern=new THREE.BoxGeometry(16,24,40); stern.translate(-150,7,0); hp.push(stern);
	const bulb=new THREE.BoxGeometry(120,8,26); bulb.translate(20,-3,0); hp.push(bulb);
	const hullMesh=new THREE.Mesh(merge_geometries(hp),hullMat); hullMesh.castShadow=true; hullMesh.receiveShadow=true; g.add(hullMesh);
	// flight deck: main + angled landing deck (port) + round-down stern + sponson overhangs
	const dp=[];
	const deck=new THREE.BoxGeometry(312,2,72); deck.translate(0,19,0); dp.push(deck);
	const ang=new THREE.BoxGeometry(210,2,30); ang.rotateY(9*Math.PI/180); ang.translate(-36,19.05,-30); dp.push(ang);
	for(const s of [1,-1]){ const cw=new THREE.BoxGeometry(280,1.2,4); cw.translate(0,18.4,s*37); dp.push(cw); }      // catwalk edge
	const deckMesh=new THREE.Mesh(merge_geometries(dp),deckMat); deckMesh.receiveShadow=true; g.add(deckMesh);
	// deck markings
	const mark=new THREE.Mesh(new THREE.PlaneGeometry(312,72),new THREE.MeshBasicMaterial({map:deck_texture(),transparent:true}));
	mark.rotation.x=-Math.PI/2; mark.position.set(0,20.08,0); g.add(mark);
	// arrestor wires across the landing area
	const wireMat=new THREE.MeshStandardMaterial({color:0x101010});
	for(let i=0;i<4;i++){ const w=new THREE.Mesh(new THREE.BoxGeometry(46,0.25,0.25),wireMat); w.position.set(-70+i*12,20.2,-22); w.rotation.y=9*Math.PI/180; g.add(w); }
	// island superstructure (starboard), multi-tier + funnel + masts + radars
	const ip=[];
	ip.push(new THREE.BoxGeometry(40,10,13).translate(-34,25,28));
	ip.push(new THREE.BoxGeometry(30,7,12).translate(-34,33.5,28));
	ip.push(new THREE.BoxGeometry(20,6,11).translate(-30,40,28));     // bridge
	ip.push(new THREE.BoxGeometry(10,9,9).translate(-44,42,28));      // funnel
	const islMesh=new THREE.Mesh(merge_geometries(ip),islMat); islMesh.castShadow=true; g.add(islMesh);
	// dark glass bridge band
	const gl=new THREE.Mesh(new THREE.BoxGeometry(20.4,3,11.4),drkMat); gl.position.set(-30,40.5,28); g.add(gl);
	// masts + antennas + radar dishes
	const mp=[];
	mp.push(new THREE.CylinderGeometry(0.5,0.8,22,8).translate(-30,56,28));
	mp.push(new THREE.CylinderGeometry(0.4,0.5,14,6).translate(-44,53,28));
	for(let i=0;i<10;i++){ mp.push(new THREE.BoxGeometry(0.35,2.4,0.35).translate(-30+(Math.random()-0.5)*10,60+Math.random()*6,28+(Math.random()-0.5)*7)); }
	const mastMesh=new THREE.Mesh(merge_geometries(mp),islMat); g.add(mastMesh);
	for(const [mx,my,mz,r] of [[-30,49,33,3.2],[-26,52,24,2.4]]){ const dish=new THREE.Mesh(new THREE.BoxGeometry(r,r,0.5),drkMat); dish.position.set(mx,my,mz); dish.rotation.y=Math.random(); g.add(dish); }
	// CIWS / sponson mounts at deck corners
	for(const [sx,sz] of [[150,-22],[-140,26],[-140,-26],[120,30]]){ const sp=new THREE.Mesh(new THREE.BoxGeometry(6,4,6),islMat); sp.position.set(sx,16.5,sz); g.add(sp);
		const dome=new THREE.Mesh(new THREE.SphereGeometry(2,8,6),drkMat); dome.position.set(sx,19,sz); g.add(dome); }
	// deck-edge lights (visible at night)
	const lg=new THREE.BufferGeometry(); const lp=[]; for(let i=-150;i<=150;i+=10){ lp.push(i,20.2,36, i,20.2,-36); }
	lg.setAttribute("position",new THREE.BufferAttribute(new Float32Array(lp),3));
	g.add(new THREE.Points(lg,new THREE.PointsMaterial({color:0xffe9b0,size:1.6,sizeAttenuation:true,transparent:true,opacity:0.9})));
	g.position.set(CARRIER.x,0,CARRIER.z);
	return g;
}
const carrier_proc=null;   // procedural carrier removed — the carrier is the loaded GLB (crash if it fails to load)

// ============================================================================ procedural world (fixed seed → deterministic, no stored map)
function mulberry32(a){ return function(){ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
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
				let nx=(p1[1]-p0[1])+(p2[1]-p1[1]), nz=-((p1[0]-p0[0])+(p2[0]-p1[0])); const l=Math.hypot(nx,nz)||1; vn.push([nx/l,nz/l]); }   // per-vertex normal (adjacent edges averaged) → gap-free ribbon at corners
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
	const off=points.map((p,i)=>{ const a=points[Math.max(0,i-1)], b=points[Math.min(points.length-1,i+1)];
		let dx=b[0]-a[0], dz=b[1]-a[1]; const l=Math.hypot(dx,dz)||1; return [-dz/l*hw, dx/l*hw]; });   // perpendicular (left) offset
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
		const papiPts=new THREE.Points(pg,new THREE.PointsMaterial({size:13,map:light_dot,vertexColors:true,transparent:true,blending:THREE.NormalBlending,depthWrite:false,sizeAttenuation:true})); papiPts.frustumCulled=false; papiPts.visible=false; scene.add(papiPts);   // base: normal-blended so the red reads red in daylight (additive washed it pale-orange)
		const wg=new THREE.BufferGeometry(); wg.setAttribute("position",pg.getAttribute("position")); wg.setAttribute("color",new THREE.BufferAttribute(new Float32Array(gcol.length),3));
		const papiWhite=new THREE.Points(wg,new THREE.PointsMaterial({size:13,map:light_dot,vertexColors:true,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,sizeAttenuation:true})); papiWhite.frustumCulled=false; papiWhite.visible=false; scene.add(papiWhite);   // additive boost lit ONLY on the white units, so they punch through bright daylight (red units stay normal-blended)
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
function ols_points(pts,color,size){   // like glow_points but SCREEN-SPACE (constant pixels) so the meatball reads small up close and far, not a 9 m blob
	const g=new THREE.BufferGeometry(); g.setAttribute("position",new THREE.BufferAttribute(new Float32Array(pts),3));
	const p=new THREE.Points(g,new THREE.PointsMaterial({size,map:light_dot,color,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,sizeAttenuation:false})); p.frustumCulled=false; scene.add(p); return p;
}
function build_carrier_deck_aids(){   // arrestor wires + OLS meatball on the flight deck (called once the carrier GLB has loaded and CARRIER.deckY is known)
	const dy=CARRIER.deckY;
	// --- 3 arrestor wires across the landing strip, at the trap fore-aft positions (angled to the strip) ---
	const wireMat=new THREE.MeshStandardMaterial({color:0x101012,metalness:0.4,roughness:0.6});
	const sheaveMat=new THREE.MeshStandardMaterial({color:0x1a1d20,metalness:0.5,roughness:0.5});
	const wires=[];
	for(const wfa of WIRES){
		const clat=strip_lat(wfa), hw=WIRE_HALFSPAN;   // span the strip width, perpendicular to its centreline
		const a=carrier_world(wfa-STRIP_ULAT*hw,clat+STRIP_UFA*hw), b=carrier_world(wfa+STRIP_ULAT*hw,clat-STRIP_UFA*hw);
		const ddx=b.x-a.x, ddz=b.z-a.z, len=Math.hypot(ddx,ddz);
		const w=new THREE.Mesh(new THREE.BoxGeometry(len,0.08,0.09),wireMat); w.position.set((a.x+b.x)/2,dy+0.12,(a.z+b.z)/2); w.rotation.y=Math.atan2(-ddz,ddx); w.castShadow=true; scene.add(w);
		wires.push({ax:a.x,az:a.z,bx:b.x,bz:b.z,mesh:w});
		for(const e of [a,b]){ const s=new THREE.Mesh(new THREE.BoxGeometry(0.4,0.25,0.4),sheaveMat); s.position.set(e.x,dy+0.14,e.z); scene.add(s); }   // deck-edge sheaves
	}
	const vsegs=[0,1].map(()=>{ const m=new THREE.Mesh(new THREE.BoxGeometry(1,0.08,0.09),wireMat); m.visible=false; m.castShadow=true; scene.add(m); return m; });   // the caught wire, dragged into a V by the hook
	// --- OLS (meatball) on the port bracket of the carrier (measured); glideslope stays referenced to the touchdown, not this housing ---
	const twfa=WIRES[1], ofa=16.9, olat=-35.4;   // OLS bracket position on the carrier's port side
	const o=carrier_world(ofa,olat), datumY=dy+0.8, travel=1.0;   // lowered to sit on the bracket, not hover above it
	const house=new THREE.Mesh(new THREE.BoxGeometry(2.0,1.4,0.6),new THREE.MeshStandardMaterial({color:0x181b1f,metalness:0.4,roughness:0.6})); house.position.set(o.x,dy+0.2,o.z); house.rotation.y=Math.atan2(-CARRIER_C,CARRIER_S); house.castShadow=true; scene.add(house);
	const at=(d,h)=>{ const q=carrier_world(ofa-STRIP_ULAT*d,olat+STRIP_UFA*d); return [q.x,h,q.z]; };   // flank the ball perpendicular to the strip (square to the approach)
	const dpos=[]; for(const d of [-3.3,-2.5,-1.7,-0.9, 0.9,1.7,2.5,3.3]) dpos.push(...at(d,datumY)); ols_points(dpos,0x35e06a,7);   // green datum row (flanks the ball)
	const cpos=[]; for(const d of [-1.5,-0.5,0.5,1.5]) cpos.push(...at(d,dy+1.6)); ols_points(cpos,0x35e06a,4);   // cut lights (static)
	const wpos=[]; for(const d of [-2.0,-0.7,0.7,2.0]) wpos.push(...at(d,dy+2.0)); const wavePts=ols_points(wpos,0xff2a1e,7); wavePts.visible=false;   // waveoff (flashes on a low approach)
	// structure: horizontal arms carrying the datum / cut / waveoff light rows, on a mast up from the housing (so the lights aren't floating)
	const strut=new THREE.MeshStandardMaterial({color:0x15181c,metalness:0.5,roughness:0.6});
	const arm=(d,y,th)=>{ const a=at(-d,y), b=at(d,y), dx=b[0]-a[0], dz=b[2]-a[2], len=Math.hypot(dx,dz); const m=new THREE.Mesh(new THREE.BoxGeometry(len,th,th),strut); m.position.set((a[0]+b[0])/2,y,(a[2]+b[2])/2); m.rotation.y=Math.atan2(-dz,dx); m.castShadow=true; scene.add(m); };
	arm(3.9,datumY,0.13);   // datum arm (through the housing)
	const mast=new THREE.Mesh(new THREE.BoxGeometry(0.13,2.1,0.13),strut); mast.position.set(o.x,dy+1.1,o.z); mast.castShadow=true; scene.add(mast);   // mast from the housing up to the cut/waveoff
	arm(2.3,dy+1.6,0.1); arm(2.3,dy+2.0,0.1);   // cut + waveoff arms
	const bg=new THREE.BufferGeometry(); bg.setAttribute("position",new THREE.BufferAttribute(new Float32Array([o.x,datumY,o.z]),3)); bg.setAttribute("color",new THREE.BufferAttribute(new Float32Array([1,0.62,0]),3));
	const ballPts=new THREE.Points(bg,new THREE.PointsMaterial({size:11,map:light_dot,vertexColors:true,transparent:true,blending:THREE.NormalBlending,depthWrite:false,sizeAttenuation:false})); ballPts.frustumCulled=false; ballPts.visible=false; scene.add(ballPts);   // the amber "ball" — screen-space, normal-blended so it reads amber/red
	const td=carrier_world(twfa,strip_lat(twfa));   // touchdown reference (the 2-wire) — the glideslope references the wires, NOT the OLS housing on the bracket
	const sdx=STRIP_UFA*CARRIER_C+STRIP_ULAT*CARRIER_S, sdz=-STRIP_UFA*CARRIER_S+STRIP_ULAT*CARRIER_C, sl=Math.hypot(sdx,sdz);
	carrier_ols={ x:o.x, z:o.z, dy, datumY, travel, ballPts, wavePts, wires, vsegs, tdx:td.x, tdz:td.z, apx:-sdx/sl, apz:-sdz/sl };   // approach comes from the −fa (aft) side, opposite the rollout
	// --- night lighting (darken-ship, night-only); heights + edges sampled off the REAL deck (which isn't flat), not a rectangle at deckY ---
	const dh=(f,l)=>{ const w=carrier_world(f,l); return { x:w.x, z:w.z, y:deck_y_at(carrier_model,w.x,w.z,-1e9) }; };   // world pos + deck height at a carrier-local point (−1e9 = off the deck)
	const edge_lat=(f,dir)=>{ let e=null; for(let l=0;Math.abs(l)<42;l+=dir*4){ const d=dh(f,l); if(d.y>-1e8 && d.y<dy+4) e=l; else if(e!==null) break; } return e; };   // scan out from the centre to the outermost still-flat-deck lat → traces the real edge
	const edge=[];
	for(let f=-145;f<=150;f+=18){ for(const dir of [1,-1]){ const e=edge_lat(f,dir); if(e!==null){ const d=dh(f,e); edge.push(d.x,d.y+0.3,d.z); } } }
	night_lights.push(glow_points(edge,0xf0d18a,4));                                      // warm-white deck-edge outline, on the real edge + deck height
	const line=[]; for(let f=-118;f<=48;f+=9){ const d=dh(f,strip_lat(f)); line.push(d.x,(d.y>-1e8?d.y:dy)+0.25,d.z); }   // angled-deck centreline / lineup
	night_lights.push(glow_points(line,0xbfe6cf,3));
	const dd=dh(-140,strip_lat(-140)), db=dd.y>-1e8?dd.y:dy; const drop=[]; for(let h=0;h>=-16;h-=2.2) drop.push(dd.x,db+h,dd.z);   // red drop line down the round-down
	night_lights.push(glow_points(drop,0xff3222,5));
	for(const [dir,col] of [[-1,0xff2418],[1,0x24ff2a]]){ const e=edge_lat(-5,dir); if(e!==null){ const d=dh(-5,e); night_lights.push(glow_points([d.x,d.y+1.2,d.z],col,6)); } }   // red (port) / green (starboard) nav lights on the beam edges
	let my=-1e9,mx=0,mz=0; for(let f=-100;f<=60;f+=5) for(let l=10;l<=45;l+=3){ const d=dh(f,l); if(d.y>my){ my=d.y; mx=d.x; mz=d.z; } }   // tallest point over the starboard side = the island mast
	if(my>dy+3) night_lights.push(glow_points([mx,my+1.2,mz],0xffffff,7));                // white masthead just above the mast top
}
const HOOK_DROP=4, HOOK_AFT=9;   // the tailhook rides ~4 m below and ~9 m aft of the pilot's eye; the meatball flies the HOOK onto the wire, so the eye rides well above the 3.5° glideslope
function ols_dev(p,o){   // hook's deviation off the 3.5° glideslope to the touchdown: along/lateral/distance + dev (+ high, − low)
	const rx=p.x-o.tdx, rz=p.z-o.tdz, along=rx*o.apx+rz*o.apz, lat=rx*(-o.apz)+rz*o.apx;
	return { along, lat, dist:Math.hypot(rx,rz), dev:Math.atan2(p.y-o.dy-HOOK_DROP,Math.max(along+HOOK_AFT,1))*180/Math.PI-3.5 };
}
function update_ols(p){   // 3D ball on the bracket, driven by the hook's deviation off the glideslope to the touchdown
	if(!carrier_ols) return; const o=carrier_ols, s=ols_dev(p,o);
	const approach = s.dist>40 && s.dist<5000 && s.along>40 && ownship.vely<3 && p.y>o.dy;
	o.ballPts.visible=approach; if(!approach){ o.wavePts.visible=false; return; }
	const low=s.dev<-0.7;
	const pos=o.ballPts.geometry.attributes.position; pos.setY(0, o.datumY+THREE.MathUtils.clamp(s.dev/0.8,-1,1)*o.travel); pos.needsUpdate=true;
	const col=o.ballPts.geometry.attributes.color; col.setXYZ(0, 1, low?0.1:0.62, 0); col.needsUpdate=true;
	o.wavePts.visible = low && (performance.now()%400)<200;
}
function seg_between(mesh,ax,az,bx,bz,y){ const dx=bx-ax, dz=bz-az, len=Math.hypot(dx,dz)||0.001; mesh.position.set((ax+bx)/2,y,(az+bz)/2); mesh.rotation.y=Math.atan2(-dz,dx); mesh.scale.x=len; }
function seg_cross(ax,az,bx,bz,cx,cz,dx,dz){   // do the x-z segments A→B and C→D intersect? (orientation of the endpoints)
	const s1=(bx-ax)*(cz-az)-(bz-az)*(cx-ax), s2=(bx-ax)*(dz-az)-(bz-az)*(dx-ax), s3=(dx-cx)*(az-cz)-(dz-cz)*(ax-cx), s4=(dx-cx)*(bz-cz)-(dz-cz)*(bx-cx);
	return (s1>0)!==(s2>0) && (s3>0)!==(s4>0);
}
function update_wire_drag(){   // the caught wire deforms into a V, its apex dragged forward by the tailhook; released wires snap back straight
	if(!carrier_ols) return; const o=carrier_ols, caught=ownship.trapped?ownship.wire:0;
	for(let i=0;i<o.wires.length;i++) o.wires[i].mesh.visible=(i+1)!==caught;
	if(!caught){ o.vsegs[0].visible=o.vsegs[1].visible=false; return; }
	const w=o.wires[caught-1], hx=ownship.pos.x-ownship.fwd.x*6.5, hz=ownship.pos.z-ownship.fwd.z*6.5, hy=o.dy+0.5;   // V apex at the tailhook claw: ~6.5 m aft of the origin, lifted ~0.5 m off the deck (where the claw holds the wire)
	seg_between(o.vsegs[0],w.ax,w.az,hx,hz,hy); seg_between(o.vsegs[1],hx,hz,w.bx,w.bz,hy); o.vsegs[0].visible=o.vsegs[1].visible=true;
}
function build_aircraft_lights(){   // nav position lights (red port / green stbd / white tail) + white anti-collision strobes + forward landing light, on the ownship
	const mk=(color,x,y,z,size)=>{ const g=new THREE.BufferGeometry(); g.setAttribute("position",new THREE.BufferAttribute(new Float32Array([x,y,z]),3));
		const p=new THREE.Points(g,new THREE.PointsMaterial({size,map:light_dot,color,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,sizeAttenuation:true})); p.frustumCulled=false; ownship.group.add(p); return p; };   // aircraft-local: +x nose, +y up, +z starboard
	const spot=new THREE.SpotLight(0xfff2d8,200,500,0.34,0.5,1); spot.castShadow=false;   // decay 1 (not inverse-square) so the beam still reaches the deck from up the approach; tuned so it lights a pool ahead without flooding the whole transom
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
function update_aircraft_lights(){
	if(!aircraft_lights) return; const on=!!ownship.lights, strobe=on && (performance.now()%1100)<70;   // ~1 Hz strobe flash
	const geardown=(ownship.gear??0)<0.02, land=on && geardown;   // the landing light rides the nose gear strut: on when the extend animation finishes (down & locked, the HUD's green GEAR threshold), dark the moment retraction starts
	for(const p of aircraft_lights.pos) p.visible=on; for(const p of aircraft_lights.landing) p.visible=land; for(const p of aircraft_lights.strobe) p.visible=strobe;
	const spot=aircraft_lights.spot; spot.visible=land;   // the landing-light beam lights whatever it points at (kept in the scene so it works in first-person, where the aircraft group is hidden)
	if(land){ const n=aircraft_lights.nose; spot.position.copy(ownship.pos).addScaledVector(ownship.fwd,n.x).addScaledVector(ownship.up,n.y);   // at the strut
		aircraft_lights.spotTarget.position.copy(ownship.pos).addScaledVector(ownship.fwd,70).addScaledVector(ownship.up,-15); }   // aim forward + ~12° down
}
function meatball_state(p){   // 2D OLS: shown in an approach cone aft of the carrier with gear + hook down; returns the glideslope deviation
	if(!carrier_ols) return null; const o=carrier_ols, s=ols_dev(p,o);
	const geardown=(ownship.gear??0)<0.5, hookdown=(ownship.hook??0)>0.5;
	if(!(geardown && hookdown && ownship.vely<3 && s.along>40 && s.dist<9260 && Math.abs(s.lat)<s.along*0.36 && p.y>o.dy)) return null;   // ~20° cone, out to 5 nm, descending only (so a climb-out / launch doesn't trip it)
	return { dev:s.dev, low:s.dev<-0.7 };
}
function draw_icls(){   // ICLS/ACLS "needles": azimuth (lineup) + glideslope bars referenced to the touchdown; the instrument approach aid, from further out than the visual meatball
	if(!carrier_ols) return; const o=carrier_ols, p=ownship.pos, s=ols_dev(p,o);
	const toward=(o.tdx-p.x)*ownship.fwd.x+(o.tdz-p.z)*ownship.fwd.z;   // >0 = nose pointing at the touchdown
	if(!(s.along>60 && s.dist<15000 && toward>0 && p.y>o.dy)) return;   // on the approach: aft, within ~8 nm, heading at the boat
	const cx=HW/2, cy=HH/2, R=64;
	const az=Math.atan2(s.lat,Math.max(s.along,1))*180/Math.PI;                        // ° off the extended centreline
	const azx=cx+THREE.MathUtils.clamp(az/3,-1,1)*R, gsy=cy+THREE.MathUtils.clamp(s.dev/0.8,-1,1)*R;   // fly-TO sensing (like civilian ILS): the bar sits on the side the centreline/glideslope is on — steer toward it
	hctx.save(); hctx.strokeStyle=GR; hctx.lineWidth=1.5;
	hctx.beginPath(); hctx.moveTo(azx,cy-R); hctx.lineTo(azx,cy+R); hctx.stroke();     // azimuth (lineup) needle
	hctx.beginPath(); hctx.moveTo(cx-R,gsy); hctx.lineTo(cx+R,gsy); hctx.stroke();     // glideslope needle
	hctx.restore();
}
generate_world();
const extras=[];
function sync_extras(n){ while(extras.length<n){ const a=Math.random()*Math.PI*2,r=2000+Math.random()*4000;
	const st=make_state(new THREE.Vector3(Math.cos(a)*r,1600+Math.random()*2400,Math.sin(a)*r),new THREE.Vector3(-Math.sin(a),0,Math.cos(a)),170+Math.random()*60);
	st.group=make_jet(0x7f8a96); scene.add(st.group); extras.push(st); if(model_active) apply_model_to(st.group); }
	while(extras.length>n){ const st=extras.pop(); scene.remove(st.group); st.group.traverse(o=>{ if(o.isMesh&&o.material&&o.material.dispose)o.material.dispose(); }); } }

// ---- input ----
const input={ pitch:0, roll:0, yaw:0, guns:false, brake:false };
const keys=new Set();
let cam_az=0, cam_el=0.22, cam_dist=24, cam_psi=0;   // chase view: orbit around the aircraft; cam_psi = smoothed heading the orbit is referenced to
let flyby_pos=null, flyby_side=1;          // flypast view: fixed world point the jet flies past, re-seeded ahead as it recedes
let cat_saved_t=0;                              // "deck position saved" flash timer
// True while the aircraft is sitting/rolling on the deck or runway (not yet airborne) — gear can't retract then.
function mission_start(){ return cfg.task==="joust"?"joust":cfg.start; }   // joust always starts at the merge; the Start selector applies to free flight only
function takeoff_surface(){ const st=mission_start(); if(st==="carrier") return CARRIER.deckY; if(st==="runway"&&airports.length) return airports[0].start.y; return 8; }
function on_ground(){ return deck_edit||ownship.launching||!!ownship.grounded; }   // the real resting flag, not an altitude guess — off the cat you fly level at deck height, where a +12 m heuristic left G dead
addEventListener("keydown",e=>{ if(["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"," ","PageUp","PageDown","/"].includes(e.key)) e.preventDefault();
	const k=e.code; if(!keys.has(k)){ // edge-triggered actions
		if(k==="Enter" && launch_status()===2){ start_launch(); }   // only when spotted on the cat, lined up, at full power
		if(k==="KeyR" && !ownship.launching && (ownship.gear??0)>0.98 && cfg.missiles && ownship.msl>0){
			if(MULTIPLAYER) missile_flag=true;   // the server acquires and scores; the local launch is the visual
			if(launch_missile(ownship,MULTIPLAYER?remote_nearest():(has_enemy?bandit:null))) ownship.msl--; }   // weapons safe unless the gear is fully up
		if(k==="KeyF" && cfg.flares && ownship.cm>0){ dispense_flares(ownship); ownship.cm--; flare_flag=true; }
		if(k==="KeyX"){ ownship.rounds=578; ownship.msl=4; ownship.cm=60; }
		if(k==="Digit0" && DECK_ALIGN && carrier_model){ deck_edit=!deck_edit; if(deck_edit){ enter_align(); } else { save_cfg(); copy_cats(); cat_saved_t=1.8; } }   // 0: deck-alignment tool, gated by DECK_ALIGN (dev-only) — exit saves + copies the poses to the clipboard
		if(TEST_SCENARIOS && !deck_edit && e.shiftKey && /^Digit\d$/.test(k)){ start_test((+k.slice(5)+9)%10); }   // Shift+1..0: scripted landing test scenarios (dev-only)
		if(TEST_SCENARIOS && e.shiftKey && k==="KeyC"){ const u=cloud_mat.uniforms.uDebug; u.value=u.value>0.5?0:1; }   // Shift+C (dev): keep the cloud render path but zero the cloud contribution — the definitive plumbing-vs-cloud-light A/B
		else if(deck_edit && e.shiftKey && (k==="Digit1"||k==="Digit2"||k==="Digit3"||k==="Digit4")){ cat_idx=+k.slice(5)-1; place_on_cat(cat_idx); }   // in align mode, Shift+1-4 select the catapult being aligned (plain 1-5 stay views)
		else { if(k==="Digit1") set_view("cockpit");   // 1 Cockpit — pending art, resolves to the HUD eye-point for now (not a dead key)
			if(k==="Digit2") set_view("hud");        // 2 HUD (default start view)
			if(k==="Digit3") set_view("chase");      // 3 Chase
			if(k==="Digit4") set_view("flypast");    // 4 Flypast
			if(k==="Digit5") set_view("padlock"); }  // 5 Padlock
		if(k==="KeyV") set_view(cfg.view==="cockpit"?"hud":"cockpit");   // V: Cockpit↔HUD fast-swap (any other view → Cockpit)
		if(k==="KeyM"){ map_on=!map_on; map_el.style.display=map_on?"block":"none"; if(map_on){ map_px=0; map_pz=0; map_resize(); } }   // reopening always returns centred on own aircraft
		if(k==="KeyP" && !MULTIPLAYER){ pause_toggle=!pause_toggle; }
		if(k==="KeyH"){ ownship.hookTarget = ownship.hookTarget>0.5?0:1; }   // arrestor hook deploy/stow
		if(k==="KeyL"){ ownship.lights=!ownship.lights; }   // aircraft position/strobe/landing lights

		if(k==="Slash"){ ownship.speedbrakeTarget = ownship.speedbrakeTarget>0.5?0:1; }   // / : speed brake (air brake) toggle
		if(k==="KeyG" && !on_ground()){ ownship.gearTarget = ownship.gearTarget>0.5?0:1; }   // G: landing gear up/down — only once airborne, never on deck/runway
		if(k==="Escape" && running){ running=false; if(MULTIPLAYER) net_finish("left"); if(onExit) onExit(); } }
	keys.add(k); }, { signal });
addEventListener("keyup",e=>keys.delete(e.code),{ signal });
addEventListener("blur",()=>keys.clear(),{ signal });
addEventListener("pagehide",()=>{ if(MULTIPLAYER) net_finish("left"); },{ signal });   // closing/navigating the tab sends a clean leave — otherwise the QUIC connection lingers as a ghost player (the browser ACKs snapshots even with the page dead)

// ---- mouse look / orbit (keys.md §5): left-drag orbits the chase camera, sharing
// cam_az/cam_el with the keyboard orbit and holding on release (no spring-back). Left
// button only (fire stays Space); never in HUD. Pointer capture — not pointer lock, which
// the sandboxed shell iframe can block. Zoom stays on -/= (not the wheel), so no wheel handler.
let dragging=false, drag_x=0, drag_y=0;
stage.addEventListener("pointerdown",e=>{ if(e.button!==0 || cfg.view!=="chase") return;
	dragging=true; drag_x=e.clientX; drag_y=e.clientY; try{ stage.setPointerCapture(e.pointerId); }catch(_){} e.preventDefault(); }, { signal });
stage.addEventListener("pointermove",e=>{ if(!dragging) return;
	const dx=e.clientX-drag_x, dy=e.clientY-drag_y; drag_x=e.clientX; drag_y=e.clientY;
	const f=0.005*(cfg.sens||1);   // radians per pixel, scaled by the control-sensitivity setting
	cam_az-=dx*f; cam_el=THREE.MathUtils.clamp(cam_el+dy*f,-1.2,1.45); }, { signal });   // both axes reversed (grab-the-world feel): drag right = orbit left, drag up = camera lowers
function end_drag(e){ if(!dragging) return; dragging=false; try{ stage.releasePointerCapture(e.pointerId); }catch(_){} }
stage.addEventListener("pointerup",end_drag,{ signal });
stage.addEventListener("pointercancel",end_drag,{ signal });
function read_input(dt){
	let tp=0,tr=0,ty=0;   // target axis deflections from the held keys (flight is W/S/A/D/Q/E only — arrows look/orbit, keys.md §2/§5)
	if(keys.has("KeyS")) tp+=1;   // pull / nose up
	if(keys.has("KeyW")) tp-=1;   // nose down
	if(keys.has("KeyD")) tr+=1;   // roll right
	if(keys.has("KeyA")) tr-=1;   // roll left
	if(keys.has("KeyE")) ty+=1; if(keys.has("KeyQ")) ty-=1;   // rudder / yaw
	tp=THREE.MathUtils.clamp(tp,-1,1)*(cfg.invert?-1:1); tr=THREE.MathUtils.clamp(tr,-1,1); ty=THREE.MathUtils.clamp(ty,-1,1);
	// ramp toward full deflection while held, decay to centre on release (~0.25s) — keys.md §2, so digital keys don't fly bang-bang
	const R=4.0*dt;
	input.pitch+=THREE.MathUtils.clamp(tp-input.pitch,-R,R);
	input.roll+=THREE.MathUtils.clamp(tr-input.roll,-R,R);
	input.yaw+=THREE.MathUtils.clamp(ty-input.yaw,-R,R);
	input.guns=keys.has("Space"); input.brake=keys.has("KeyB");   // B: wheel brakes, held (both mains together)
	if(!deck_edit && keys.has("BracketRight")) ownship.throttle=Math.min(1,ownship.throttle+dt*0.5);   // throttle up (], held & ramped)
	if(!deck_edit && keys.has("BracketLeft")) ownship.throttle=Math.max(0,ownship.throttle-dt*0.5);    // throttle down ([)
}

let sim_time=0;
const _q=new THREE.Quaternion(), _fwd=new THREE.Vector3(), _up=new THREE.Vector3(), _right=new THREE.Vector3();
function start_launch(){ launch_flag=true; ownship.trapped=false; ownship.throttle=Math.max(ownship.throttle,0.9); }   // requests the shot; the core fires it while attached to the shuttle (caller gates on launch_status()===2)
let crash_t=0;   // >0 = crashed; counts down to the respawn
function explosion_at(x,y,z){ for(let i=0;i<64;i++){ const k=pool_spawn(smoke); if(k<0) break;
	const fire=i<28, a=Math.random()*Math.PI*2, e=Math.random()*Math.PI-Math.PI/2, sp=fire?(9+Math.random()*40):(3+Math.random()*15);
	smoke.px[k]=x; smoke.py[k]=y+1; smoke.pz[k]=z;
	smoke.vx[k]=Math.cos(a)*Math.cos(e)*sp; smoke.vy[k]=Math.abs(Math.sin(e))*sp*0.8+6; smoke.vz[k]=Math.sin(a)*Math.cos(e)*sp;
	smoke.ttl[k]=smoke.life[k]=fire?(0.5+Math.random()*0.7):(2.6+Math.random()*2.6);
	if(fire){ smoke.r[k]=1.0; smoke.g[k]=0.42+Math.random()*0.25; smoke.b[k]=0.08; } else { smoke.r[k]=0.30; smoke.g[k]=0.30; smoke.b[k]=0.32; } } }
function crash_ownship(){ if(crash_t>0) return; crash_t=3.0; explosion_at(ownship.pos.x,ownship.pos.y,ownship.pos.z); ownship.group.visible=false; ownship.speed=0; }
function over_runway(p){ const r=obstacles.runway; if(!r) return false; const dx=p.x-r.x, dz=p.z-r.z;
	return Math.abs(dx*r.fx+dz*r.fz)<r.hl && Math.abs(dx*r.fz-dz*r.fx)<r.hw; }
const GEAR=2.46;   // the aircraft origin rests this far above whatever surface is beneath it — the model's wheel bottoms measure 2.457 m below the (bbox-centred) origin in the gear-down pose; keep equal to cfg.cat_dy. Lower buries the wheels
const HOOK_DECK_CAP=0.88;   // max hook-deploy progress while resting on a surface — stops the claw at deck level instead of rotating through it
const CARRIER_YD=(CARRIER_MODEL.yaw-90)*D2R, CARRIER_C=Math.cos(CARRIER_YD), CARRIER_S=Math.sin(CARRIER_YD);   // same yaw-delta frame as place_on_cat
function carrier_fore_aft(x,z){ return (x-CARRIER.x)*CARRIER_C-(z-CARRIER.z)*CARRIER_S; }   // carrier-local fore/aft: + toward the bow (catapult ≈ +48), the arrestor wires are aft (≈ −50)
function carrier_world(lx,lz){ return { x:CARRIER.x+lx*CARRIER_C+lz*CARRIER_S, z:CARRIER.z-lx*CARRIER_S+lz*CARRIER_C }; }   // carrier-local (fore-aft, lateral: −=port) → world x/z (same frame as place_on_cat)
function carrier_lateral(x,z){ return (x-CARRIER.x)*CARRIER_S+(z-CARRIER.z)*CARRIER_C; }   // inverse of the lateral axis: how far port(−)/starboard(+) of the ship centreline
function cat_spot(i=cat_idx){ const cat=cfg.cats[i]; return { x:CARRIER.x+cat.x*CARRIER_C+cat.z*CARRIER_S, z:CARRIER.z-cat.x*CARRIER_S+cat.z*CARRIER_C }; }   // world position of a catapult spot
const CAT_POS_TOL=3, CAT_HEADING_DOT=0.99;   // "spotted on the cat": within 3 m of the spot and ~8° of the launch heading — tight, so the launch (which fires from the actual pose, never snapped) always looks clean
function on_cat_spot(){   // which catapult the aircraft is parked on, lined up down its launch heading — -1 for none (works before the carrier GLB finishes loading — the spots are fixed world coords)
	if(ownship.launching) return -1;
	const fh=Math.hypot(ownship.fwd.x,ownship.fwd.z)||1;
	for(let i=0;i<cfg.cats.length;i++){
		const cs=cat_spot(i); if(Math.hypot(ownship.pos.x-cs.x,ownship.pos.z-cs.z)>CAT_POS_TOL) continue;
		const hd=cfg.cats[i].h*D2R, fx=Math.cos(hd), fz=-Math.sin(hd), cfx=fx*CARRIER_C+fz*CARRIER_S, cfz=-fx*CARRIER_S+fz*CARRIER_C;   // this cat's launch heading in world
		if((ownship.fwd.x*cfx+ownship.fwd.z*cfz)/fh >= CAT_HEADING_DOT) return i;
	}
	return -1;
}
function launch_status(){ return (flight_active?(core_catapult>=0&&core_stroke<0):on_cat_spot()>=0) ? (ownship.throttle>=0.9?2:1) : 0; }   // 0 off the cat / not attached · 1 attached, run up · 2 attached + full power, ready
// Landing line, measured directly at the three wire crossings on the landing path.
const STRIP_A={fa:-96.6,lat:0.9}, STRIP_B={fa:-71.6,lat:-3.0};   // 1-wire and 3-wire crossings
const STRIP_SLOPE=(STRIP_B.lat-STRIP_A.lat)/(STRIP_B.fa-STRIP_A.fa);
function strip_lat(fa){ return STRIP_A.lat+(fa-STRIP_A.fa)*STRIP_SLOPE; }   // lateral of the landing centreline at a given fore-aft
const _slen=Math.hypot(STRIP_B.fa-STRIP_A.fa,STRIP_B.lat-STRIP_A.lat), STRIP_UFA=(STRIP_B.fa-STRIP_A.fa)/_slen, STRIP_ULAT=(STRIP_B.lat-STRIP_A.lat)/_slen;   // unit vector along the landing line (toward +fa = the rollout)
const WIRES=[-96.6,-86.8,-71.6];   // arrestor wires 1..3 (aft→forward, increasing fore-aft; touchdown ≈ 1-wire, roll toward +fa); the 2-wire (−86.8) is the target
const WIRE_HALFSPAN=14;            // each wire stretches this far each side of the landing centreline (drawn span == trap span)
let ground_kind="";   // surface kind under the last ground_height() hit: deck / runway / apron / ground / "" (sea) — read right after the call
function ground_height(x,z){   // top of the solid surface under (x,z): carrier deck / runway / apron / island; -inf = open sea (no landing)
	ground_kind="";
	if(Math.abs(x-CARRIER.x)<160 && Math.abs(z-CARRIER.z)<160){
		if(!carrier_model){ ground_kind="deck"; return CARRIER.deckY; }   // GLB still loading — treat the deck box as solid at the known height so a carrier start doesn't fall through to the flight model
		const h=deck_y_at(carrier_model,x,z,-1e9);
		if(h>-1e8 && h<CARRIER.deckY+4){ ground_kind="deck"; return h>CARRIER.deckY-2.5?CARRIER.deckY:h; }   // the flight deck is one horizontal plane — the GLB models it as two flat layers 1.72 m apart (gaps in the top layer expose the lower), so near-deck hits snap to the measured plane; genuinely lower hits (catwalks/sponsons off the edge) stay real. Taller hits are the island superstructure — see check_collisions
	}
	if(obstacles.runway && over_runway({x,z})){ ground_kind="runway"; return ISLAND_H+1.5; }
	for(const a of obstacles.aprons){ if(pip(x,z,a)){ ground_kind="apron"; return ISLAND_H+AIRFIELD_FLOAT; } }
	for(const is of obstacles.islands){ if(x>is.minx-SKIRT&&x<is.maxx+SKIRT&&z>is.minz-SKIRT&&z<is.maxz+SKIRT){
		if(pip(x,z,is.pts)){ ground_kind="ground"; return ISLAND_H; }
		if(in_harbour(x,z)){ const d=edge_distance(x,z,is.pts); if(d<QUAY_APRON){ ground_kind="ground"; return ISLAND_H-(ISLAND_H-QUAY)*(d/QUAY_APRON); } }   // harbour: short apron to the quay edge, then the wall drops into deep water
		else { const d=edge_distance(x,z,is.pts); if(d<SKIRT){ ground_kind="ground"; return ISLAND_H-(ISLAND_H+SKIRT_DROP)*(d/SKIRT); } }   // the beach skirt is a real sloped surface (sand → soft-field rules)
	} }
	return -1e9;
}
function check_collisions(){   // ownship vs sea / buildings / structures / carrier / other aircraft (land landings handled by the ground floor in fly_player)
	if(crash_t>0) return; const p=ownship.pos;
	if(p.y<3.4 && ground_height(p.x,p.z)<-1e8) return crash_ownship();   // the sea — but not the beach skirt, which slopes below this line down to the waterline
	if(p.y<45){
		for(const b of obstacles.buildings){ if(p.y<b.topY+2 && p.x>b.minx&&p.x<b.maxx&&p.z>b.minz&&p.z<b.maxz && pip(p.x,p.z,b.pts)) return crash_ownship(); }
		for(const s of obstacles.posts){ if(p.y<s.y1 && Math.hypot(p.x-s.x,p.z-s.z)<s.r+4) return crash_ownship(); }
	}
	if(carrier_model && p.y<80 && Math.abs(p.x-CARRIER.x)<160 && Math.abs(p.z-CARRIER.z)<160){
		const h=deck_y_at(carrier_model,p.x,p.z,-1e9);   // the flat deck is a landing surface (ground floor); only the taller island superstructure is an obstacle here
		if(h>CARRIER.deckY+4 && p.y<h) return crash_ownship();   // flew into the island superstructure
	}
	if(has_enemy && wrap_distance(p,bandit.pos)<14){ explosion_at(bandit.pos.x,bandit.pos.y,bandit.pos.z); bandit.pos.set(3000,2400,-1000); return crash_ownship(); }
	for(const ex of extras){ if(wrap_distance(p,ex.pos)<14){ explosion_at(ex.pos.x,ex.pos.y,ex.pos.z);
		const a=Math.random()*Math.PI*2, r=3000+Math.random()*4000; ex.pos.set(Math.cos(a)*r,1600+Math.random()*2400,Math.sin(a)*r); return crash_ownship(); } }
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
	{name:"6 runway - overspeed 115 m/s (tire failure)",    V:115, S:2.5, pitch:2},
	{name:"7 runway - gentle belly landing (slides)",       V:70,  S:1.2, pitch:2, gearup:true},
	{name:"8 runway - hard belly landing (crashes)",        V:70,  S:4,   pitch:2, gearup:true},
	{name:"9 carrier - on glideslope (traps)",              V:70,  S:4.3, pitch:4, carrier:true, hook:true},
	{name:"0 carrier - flat and floaty (hook skip, bolter)",V:75,  S:0.8, pitch:2, carrier:true, hook:true, short:18},
];
let test_active=null;
function start_test(i){ const sc=TESTS[i]; if(!sc || crash_t>0) return;
	let T,d;
	if(sc.carrier){ if(!carrier_ols) return; const o=carrier_ols;
		d=new THREE.Vector3(-o.apx,0,-o.apz).normalize(); T=new THREE.Vector3(o.tdx,0,o.tdz);   // fly the approach axis toward the 2-wire touchdown
		if(sc.short) T.addScaledVector(d,-sc.short); }                                          // aim short of the wires (the floaty hook-skip case)
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
	ownship.pass={gs:0,az:0,n:0}; ownship.waved=false; ownship.pass_t=0;
	test_active={ name:sc.name, q:q.clone(), vd:vd.clone(), V, t0:sim_time };
	flight_push();
}
function test_drive(){   // hold the prescribed approach exactly; hand control back the moment the outcome is decided
	const t=test_active;
	if(crash_t>0 || ownship.trapped || (ownship.touch && ownship.touch.t>=t.t0)){ test_active=null; return; }
	const b=flight_get();   // hold the prescribed approach exactly; position integrates in the core
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
const FUEL=3000;           // spawn fuel, kg (matches the multiplayer server)
const NOSEGEAR=5.3;        // nose-gear x ahead of the origin (fighter.go) — the cat shuttle sits there (#83: aircraft-independent alignment)
let flight_active=false, control_sequence=0, launch_flag=false, core_catapult=-1, core_stroke=-1, prev_wire=-1, prev_wow=false;
let last_controls=null, marked_steps=0;   // multiplayer prediction: the sample the core flew this frame + fixed steps since the last mark
const render_offset=new THREE.Vector3();  // reconciliation discontinuity, decayed on ownship.group only (~150 ms)
function flight_world(){
	// Multiplayer must mirror the SERVER's world exactly (sea-only, the match
	// seed and wrap) — a client-side carrier the server doesn't simulate would
	// poison prediction; deck operations stay single-player for now.
	if(MULTIPLAYER) return { environment:{ seed:(net&&net.welcome&&net.welcome.seed)||1, wrap:(net&&net.wrap)||WORLD_WRAP }, world:{ sea:3 } };
	const fields=[{ height:ISLAND_H+AIRFIELD_FLOAT, strips:physics_strips.map(c=>({ a:{x:c.a[0], z:c.a[1]}, b:{x:c.b[0], z:c.b[1]}, width:c.w })) }];
	for(const is of obstacles.islands) fields.push({ height:ISLAND_H, coast:is.pts.map(q=>({x:q[0], z:q[1]})) });
	const carrier={ position:{x:CARRIER.x, y:CARRIER.deckY, z:CARRIER.z}, heading:CARRIER_YD, speed:0,
		deck:[{x:-152,z:-38},{x:152,z:-38},{x:152,z:38},{x:-152,z:38}],   // rectangle at the GLB's beam; refine against the drawn edge with #72/#83
		catapults:cfg.cats.map(c=>{ const hd=c.h*D2R; return { position:{x:c.x+NOSEGEAR*Math.cos(hd), y:0, z:c.z-NOSEGEAR*Math.sin(hd)}, heading:hd, stroke:85, speed:88 }; }),
		wires:WIRES.map(fa=>({ a:{x:fa, y:0, z:strip_lat(fa)-WIRE_HALFSPAN}, b:{x:fa, y:0, z:strip_lat(fa)+WIRE_HALFSPAN} })) };
	return { environment:{ seed:1, wrap:WORLD_WRAP }, world:{ sea:0, fields, carrier } };
}
function sync_core(out){   // core state -> the ownship object every consumer reads (HUD, cameras, weapons, LSO)
	ownship.pos.set(out[STATE.position],out[STATE.position+1],out[STATE.position+2]);
	ownship.q.set(out[STATE.attitude+1],out[STATE.attitude+2],out[STATE.attitude+3],out[STATE.attitude]);
	ownship.fwd.set(1,0,0).applyQuaternion(ownship.q); ownship.up.set(0,1,0).applyQuaternion(ownship.q); ownship.right.set(0,0,1).applyQuaternion(ownship.q);
	ownship.velx=out[STATE.velocity]; ownship.vely=out[STATE.velocity+1]; ownship.velz=out[STATE.velocity+2];
	ownship.speed=Math.hypot(ownship.velx,ownship.vely,ownship.velz);
	if(ownship.speed>0.5) ownship.vel_dir.set(ownship.velx/ownship.speed,ownship.vely/ownship.speed,ownship.velz/ownship.speed); else ownship.vel_dir.copy(ownship.fwd);
	ownship.aoa=out[STATE.alpha]*180/Math.PI; ownship.gload=out[STATE.nz];
	ownship.cas=out[STATE.cas];   // calibrated airspeed, m/s — the real jet's HUD speed source
	ownship.spool=(out[STATE.engine]+out[STATE.engine+2])/2; ownship.stage=(out[STATE.engine+1]+out[STATE.engine+3])/2;
	ownship.gear=1-out[STATE.extension]; ownship.speedbrake=out[STATE.speedbrake];
	ownship.grounded=out[STATE.wow]>0.5;
	core_catapult=out[STATE.catapult]; core_stroke=out[STATE.stroke];
	ownship.launching=core_catapult>=0&&core_stroke>=0;
	const wire=out[STATE.wire];
	if(wire>=0&&prev_wire<0){ ownship.trapped=true; ownship.wire=wire+1; ownship.grade=lso_grade(); ownship.pass_t=10; }
	else if(wire<0&&prev_wire>=0){ ownship.trapped=false; }
	prev_wire=wire;
}
function flight_push(){   // deliver the ownship pose to the core: trimmed level flight when airborne, a composed state on the ground / in a test
	if(!flight_active) return;
	prev_wire=-1;
	if(!test_active && ownship.speed>50 && !ownship.grounded){
		flight_level(ownship.pos.x,ownship.pos.y,ownship.pos.z, ownship.fwd.x,ownship.fwd.z, ownship.speed, FUEL);
		sync_core(flight_get()); return;
	}
	const b=flight_get();   // keep time (carrier pose, wind field) and fuel across resets
	if(ownship.speed<1){ const g=ground_height(ownship.pos.x,ownship.pos.z);   // ground spawns: rest the wheels ON the surface — legacy spawn heights assume the old glue, and an interpenetrated spawn fires the bottomed-out struts like a mortar
		if(g>-1e8) ownship.pos.y=Math.max(ownship.pos.y,g+GEAR); }
	b[STATE.position]=ownship.pos.x; b[STATE.position+1]=ownship.pos.y; b[STATE.position+2]=ownship.pos.z;
	b[STATE.velocity]=ownship.vel_dir.x*ownship.speed; b[STATE.velocity+1]=ownship.vel_dir.y*ownship.speed; b[STATE.velocity+2]=ownship.vel_dir.z*ownship.speed;
	b[STATE.attitude]=ownship.q.w; b[STATE.attitude+1]=ownship.q.x; b[STATE.attitude+2]=ownship.q.y; b[STATE.attitude+3]=ownship.q.z;
	b[STATE.omega]=0; b[STATE.omega+1]=0; b[STATE.omega+2]=0;
	if(b[STATE.fuel]<500) b[STATE.fuel]=FUEL;
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
	const die=()=>{ ownship.group.position.copy(ownship.pos); crash_ownship(); return true; };
	if(deck && ownship.touch.fa<-134) return die();                   // ramp strike: caught the round-down at the stern
	if(out[STATE.extension]<0.5){                                     // belly arrival: survivable only feather-soft and level
		if(sink>2 || bank>0.09 || pitch>0.21 || pitch<-0.04) return die();
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
	if(crash_t>0){ if(MULTIPLAYER){ read_input(dt); return; }   // multiplayer: hold in the fireball until the server's respawn event places us
		crash_t-=dt; if(crash_t<=0){ crash_t=0; ownship.group.visible=true; reset_ownship(); } return; }   // hold through the fireball, then respawn
	read_input(dt);
	ownship.fwd.set(1,0,0).applyQuaternion(ownship.q); ownship.up.set(0,1,0).applyQuaternion(ownship.q); ownship.right.set(0,0,1).applyQuaternion(ownship.q);
	if(deck_edit){   // dev-only deck-alignment tool: freeze on the cat while nudging the pose
		edit_cat(dt);
		ownship.speed=0; ownship.velx=ownship.vely=ownship.velz=0; ownship.aoa=0; ownship.gload=1; ownship.vel_dir.copy(ownship.fwd);
		ownship.group.quaternion.copy(ownship.q); ownship.group.position.copy(ownship.pos); return;
	}
	if(!flight_active){   // bind the core to this mission's world on the first live frame past the loading gate
		if(MULTIPLAYER && !(net&&net.welcome)) return;   // the world payload needs the match seed/wrap from the welcome
		if(!flight_ready()){ if(flight_failure()) notice(translate("FLIGHT CORE FAILED")); return; }
		if(!flight_init(flight_world())){ notice(translate("FLIGHT CORE FAILED")); return; }
		flight_active=true; flight_push();
	}
	if(test_active) test_drive();   // scripted test approach: prescribes attitude + velocity into the core each frame
	const controls={ pitch:THREE.MathUtils.clamp(input.pitch*cfg.sens,-1,1), roll:THREE.MathUtils.clamp(input.roll*cfg.sens,-1,1), yaw:THREE.MathUtils.clamp(input.yaw*cfg.sens,-1,1),
		throttle:ownship.throttle, speedbrake:ownship.speedbrakeTarget??0,
		reheat:ownship.throttle>=0.98, brake:input.brake,
		gear:(ownship.gearTarget??0)<0.5, hook:(ownship.hookTarget??0)>0.5,
		launch:launch_flag, override:keys.has("KeyO"), sequence:++control_sequence };
	const out=flight_frame(controls,dt);
	if(flight_steps.value>0) launch_flag=false;   // the edge was consumed by the core
	last_controls=controls; marked_steps+=flight_steps.value;
	sync_core(out);
	if(out[STATE.contact]>=0){ flight_clear(); ownship.group.position.copy(ownship.pos); return crash_ownship(); }   // crash probe: any non-permitted airframe contact
	if(out[STATE.touch]>0.5){ const crashed=verdict(out); flight_clear(); if(crashed) return; }
	// bolter: hook down, touched the deck this pass, airborne again without a wire
	if(prev_wow&&!ownship.grounded&&!ownship.trapped&&(ownship.hookTarget??0)>0.5&&ownship.touch&&ownship.touch.deck&&(sim_time-ownship.touch.t)<8&&ownship.speed>30){ ownship.grade="BOLTER"; ownship.pass_t=6; }
	prev_wow=ownship.grounded;
	ownship.group.quaternion.copy(ownship.q); ownship.group.position.copy(ownship.pos);
	if(MULTIPLAYER && render_offset.lengthSq()>1e-8){ render_offset.multiplyScalar(Math.max(0,1-dt*7)); ownship.group.position.add(render_offset); }   // the correction shows as a ~150 ms visual decay, never a physics change
	check_collisions();
}
function fly_bandit(dt){
	bandit.break_t-=dt;
	const to_own=ownship.pos.clone().sub(bandit.pos); const rng=to_own.length();
	if(bandit.merging){   // joust run-in: pure pursuit straight at the player — no weaving — until the pass, then the fight is on
		if(rng<500 || to_own.dot(bandit.fwd)<0){ bandit.merging=false; }
		else { steer(bandit,to_own.clone(),dt,0.3,1.0); apply_orientation(bandit); fire_gun(bandit,ownship,"bandit",dt); return; }
	}
	const threatened = rng<1800 && ownship.fwd.dot(to_own.clone().multiplyScalar(-1).normalize())>0.5; // ownship pointing at bandit from behind-ish
	if(bandit.break_t<=0){ const a=Math.random()*Math.PI*2; bandit.break_dir.set(Math.cos(a),0,Math.sin(a)); bandit.break_t=threatened?(2+Math.random()*2):(5+Math.random()*5);
		if(threatened && cfg.flares) dispense_flares(bandit); }
	const b=bandit.break_dir.clone(); b.x+=Math.sin(sim_time*0.7)*0.6; b.z+=Math.cos(sim_time*0.9)*0.6;
	if(bandit.pos.length()>5500) b.addScaledVector(bandit.pos.clone().negate().setY(0).normalize(),1.2);
	hold_altitude(b,bandit,1400,3600); steer(bandit,b,dt,threatened?0.5:0.34,1.2); apply_orientation(bandit);
	// bandit guns at ownship
	fire_gun(bandit,ownship,"bandit",dt);
}
function apply_anim(st){ const g=st.group; if(!g||!g.userData.gearMixer) return;   // scrub the baked clips: gear to st.gear (0=down,1=up), hook to st.hook (0=stowed,1=deployed)
	const tg=THREE.MathUtils.clamp(st.gear,0,1); for(const a of g.userData.gearActions) a.action.time=tg*a.dur;
	let th=THREE.MathUtils.clamp(st.hook??0,0,1);
	if(th>0.05){ const surf=ground_height(st.pos.x,st.pos.z); if(surf>-1e8 && st.pos.y<=surf+GEAR+0.6) th=Math.min(th,HOOK_DECK_CAP); }   // resting on a surface: stop the hook short of full deploy so the claw sits on the deck, not through it
	for(const a of g.userData.hookActions) a.action.time=th*a.dur;
	g.userData.gearMixer.update(0); }
function ease_to(cur,tgt,dt){ const d=tgt-cur; return Math.abs(d)>1e-4 ? cur+Math.sign(d)*Math.min(Math.abs(d),GEAR_RATE*dt) : tgt; }
function update_anim(dt){ for(const st of [ownship,bandit,...extras]){
	const owned=st===ownship&&flight_active;   // the core's actuators drive ownship gear + speedbrake progress (sync_core); don't ease over them
	if(!owned){ if(st.gear===undefined) st.gear=st.gearTarget??1; st.gear=ease_to(st.gear,st.gearTarget??1,dt);
		if(st.speedbrake===undefined) st.speedbrake=st.speedbrakeTarget??0; st.speedbrake+=THREE.MathUtils.clamp((st.speedbrakeTarget??0)-st.speedbrake,-1.5*dt,1.5*dt); }   // air-brake ease for the aircraft the core doesn't fly
	if(st.hook===undefined) st.hook=st.hookTarget??0; st.hook=ease_to(st.hook,st.hookTarget??0,dt);
	apply_anim(st); } }
function step_world(dt){ sim_time+=dt;
	fly_player(dt); if(has_enemy) fly_bandit(dt); if(MULTIPLAYER&&net) net_frame(dt);
	for(const st of extras){ st.circle_phase+=dt*(st.speed/st.circle_radius);
		const tgt=new THREE.Vector3(Math.cos(st.circle_phase)*st.circle_radius,st.circle_alt+Math.sin(st.circle_phase*0.5)*200,Math.sin(st.circle_phase)*st.circle_radius);
		steer(st,tgt.sub(st.pos),dt,0.3,1.0); apply_orientation(st); }
	const flick=0.6+Math.random()*0.4; const set_ab=(g,on)=>g.children.forEach(c=>{ if(c.userData.ab){ c.visible=on; c.scale.z=flick; c.material.opacity=on?0.55+Math.random()*0.35:0; } });
	set_ab(ownship.group,cfg.afterburner&&ownship.throttle>=0.98); set_ab(bandit.group,cfg.afterburner); extras.forEach(st=>set_ab(st.group,cfg.afterburner));   // reheat = throttle at max (keys.md §3: no detent, full throttle is burner)
	// player guns
	fire_gun(ownship,MULTIPLAYER?null:bandit,"own",dt,input.guns&&!ownship.launching&&!deck_edit&&(ownship.gear??0)>0.98);   // weapons safe unless the gear is fully up (a weight-on-wheels-style interlock); in multiplayer the tracers are local, the damage is the server's
	update_pool_ballistic(tracers,dt,9.8,0); update_missiles(dt);
	update_pool_ballistic(flares,dt,9.8,0.985); update_pool_ballistic(smoke,dt,-0.5,0.96);
	live_particles=flush_points(tracers,tr_pts)+flush_points(flares,fl_pts)+flush_points(smoke,sm_pts);
	tr_pts.visible=cfg.tracers; fl_pts.visible=cfg.flares;
	update_anim(dt);
	update_papi(ownship.pos); update_ols(ownship.pos); update_wire_drag(); update_aircraft_lights();
	if(carrier_ols && !ownship.trapped && (ownship.hook??0)>0.5){   // LSO watch: accumulate glideslope/lineup deviation through the in-close portion of a pass, and call the waveoff
		const s=ols_dev(ownship.pos,carrier_ols);
		ownship.waving=false;   // current waveoff call (drives the flashing banner); waved is sticky for the pass grade
		if(s.along>2500 || s.along<0){ ownship.pass={gs:0,az:0,n:0}; ownship.waved=false; }   // outside the pass (or past the ship) → fresh slate for the next one
		else if(!ownship.grounded && s.dist<1852 && s.along>40){
			const p=ownship.pass||(ownship.pass={gs:0,az:0,n:0});
			p.gs+=Math.abs(s.dev); p.az+=Math.abs(Math.atan2(s.lat,Math.max(s.along,1)))*180/Math.PI; p.n++;
			if(s.dev<-0.7 && s.dist>250){ ownship.waved=true; ownship.waving=true; }   // dangerously low in close — the LSO waves it off (same threshold as the OLS waveoff lights); inside ~250 m the call is over (and hook-geometry makes a good pass read falsely low there)
		}
	} else ownship.waving=false;
}

function reset_ownship(){
	ownship.q.set(0,0,0,1); ownship.fwd.set(1,0,0); ownship.up.set(0,1,0); ownship.right.set(0,0,1); ownship.vel_dir.set(1,0,0);
	ownship.rounds=578; ownship.msl=4; ownship.cm=60; ownship.aoa=0; ownship.gload=1; ownship.launching=false; ownship.trapped=false; ownship.wire=0; ownship.lights=(cfg.tod!=="day");   // lights default on at night, off by day
	ownship.grounded=false; ownship.touch=null; ownship.pass={gs:0,az:0,n:0}; ownship.pass_t=0; ownship.grade=""; ownship.waved=false;   // landing / LSO pass state
	test_active=null;   // a test scenario must not keep driving across a crash respawn (it would fly the fresh spawn straight into the deck, forever)
	const st=mission_start();
	if(st==="carrier"){ ownship.speed=0; ownship.throttle=0.95; place_on_cat(); }   // spotted on the cat at military power — the real-world standard shot at this weight (full throttle = burner, the heavy-day technique); Enter fires, throttle back + steer to taxi off
	else if(st==="runway" && airports.length){ const ap=airports[0];          // start on the near airport runway
		ownship.pos.set(ap.start.x,ap.start.y,ap.start.z); ownship.fwd.copy(ap.dir).normalize(); ownship.speed=0; ownship.throttle=0;
		const r=new THREE.Vector3().crossVectors(ownship.fwd,world_up).normalize(); const u=new THREE.Vector3().crossVectors(r,ownship.fwd).normalize();
		ownship.q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(ownship.fwd,u,r)); ownship.vel_dir.copy(ownship.fwd); }
	else if(st==="landing"){   // carrier landing: on the ICLS ~5 NM astern, a touch low and left, configured to trap
		const A=carrier_world(STRIP_A.fa,STRIP_A.lat), B=carrier_world(STRIP_B.fa,STRIP_B.lat);   // landing centreline, A (aft) → B (forward, toward the rollout)
		let ldx=B.x-A.x, ldz=B.z-A.z; const ll=Math.hypot(ldx,ldz)||1; ldx/=ll; ldz/=ll;           // unit landing direction (the way the aircraft rolls out)
		const td=carrier_world(-86.8,strip_lat(-86.8)), dist=3*1852, gs=3.5*D2R;                    // touchdown ≈ the 2-wire; 3 NM back on the 3.5° glideslope
		ownship.pos.set(td.x-ldx*dist+ldz*100, CARRIER.deckY+dist*Math.tan(gs)+HOOK_DROP-50, td.z-ldz*dist-ldx*100);   // 3 NM astern, 100 m left of centre, 50 m low — a deliberate off-glideslope, off-centre intercept
		ownship.speed=70; ownship.throttle=0;   // ~135 kt approach speed
		const yaw=5*D2R, cy=Math.cos(yaw), sy=Math.sin(yaw); ownship.fwd.set(ldx*cy-ldz*sy,0,ldz*cy+ldx*sy).normalize();   // level flight, heading ~5° to starboard of the centreline — pilot rolls out onto the ICLS and pushes over onto the glideslope from below
		const r=new THREE.Vector3().crossVectors(ownship.fwd,world_up).normalize(); const u=new THREE.Vector3().crossVectors(r,ownship.fwd).normalize();
		ownship.q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(ownship.fwd,u,r)); ownship.vel_dir.copy(ownship.fwd); }
	else if(st==="joust"){   // 1v1 merge: head-on east-west directly over the atoll at 15,000 ft, 1 NM either side, equal AIRSPEED — symmetric in every respect (island below both at all fight orientations, sun/moon abeam both noses); the side is a coin flip so the sun-left/sun-right mirror can't systematically favour one player
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
	{ const down=(st==="carrier"||st==="runway"||st==="landing"); ownship.gearTarget=down?0:1; ownship.gear=ownship.gearTarget; }   // gear down on deck/runway/landing, up for an air start
	{ const hk=(st==="landing")?1:0; ownship.hookTarget=hk; ownship.hook=hk; }   // hook down for a carrier-landing start, else stowed (deploy manually with H)
	flight_push();   // deliver the spawn to the flight core (no-op until it boots; the boot pushes this pose itself)
	ownship.group.quaternion.copy(ownship.q); ownship.group.position.copy(ownship.pos);
	if(st==="joust"){ bandit.pos.set(joust_side*1.5*NM,4572,0); bandit.fwd.set(-joust_side,0,0); bandit.speed=220; bandit.merging=true; }   // merging: the bandit flies straight at the player until the pass, so the merge can be timed   // the other end of the merge, same airspeed (equal TAS is the fair condition once wind exists)
	else { bandit.pos.set(3000,2400,-1000); bandit.fwd.set(-0.3,0,1).normalize(); bandit.speed=195; bandit.merging=false; }   // ground/deck starts: the bandit orbits near Midway as before
	bandit.break_t=0;
}

// ============================================================================ camera
function update_camera(dt){
	const editing = deck_edit;
	const firstPerson = (cfg.view==="hud"||cfg.view==="cockpit");   // cockpit ≡ HUD eye-point until cockpit art exists
	ownship.group.visible=(!firstPerson) || editing;
	if(cfg.view==="chase" && !map_on){   // keyboard orbit (shares cam_az/el with the mouse drag): ←→ azimuth, ↑↓ elevation, −/= zoom — keys.md §5; with the map up, −/= zoom the map instead
		const ar=dt*0.9, zr=dt*40;
		cam_az+=((keys.has("ArrowRight")?1:0)-(keys.has("ArrowLeft")?1:0))*ar;           // ←/→ orbit
		cam_el=THREE.MathUtils.clamp(cam_el+((keys.has("ArrowUp")?1:0)-(keys.has("ArrowDown")?1:0))*ar,-1.2,1.45);   // ↑/↓ tilt
		if(keys.has("Minus")) cam_dist=Math.min(140,cam_dist+zr);           // - back
		if(keys.has("Equal")) cam_dist=Math.max(8,cam_dist-zr);             // = in
	}
	if(firstPerson){ const eye=body_offset(ownship,3.0,0.6,0); camera.position.copy(eye); camera.up.copy(ownship.up);
		camera.lookAt(eye.clone().addScaledVector(ownship.fwd,200)); }
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

function update_flypast(dt){   // fixed-ground flyby: the jet flies past a stationary camera; re-seed ahead once it recedes
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
function proj_dir(d){ _p.copy(camera.position).addScaledVector(d,1000).project(camera); if(_p.z>1) return null; return [(_p.x*0.5+0.5)*HW,(-_p.y*0.5+0.5)*HH]; }
let GR="#15b85f"; const AM="#ffc14d";   // GR switches to a brighter daytime green in draw_hud (real HUDs have a brightness knob)

// ---- full-screen map (M) — aircraft, islands, airports, carrier; never bandits ----
const map_el=map; const mctx=map_el.getContext("2d"); let map_on=false;
const help_el=help;
function map_resize(){ const dpr=Math.min(devicePixelRatio||1,2); map_el.width=innerWidth*dpr; map_el.height=innerHeight*dpr; map_el.style.width=innerWidth+"px"; map_el.style.height=innerHeight+"px"; mctx.setTransform(dpr,0,0,dpr,0,0); }
const NM=1852;
let map_range=40000; const MAP_RANGE_MIN=5*NM, MAP_RANGE_MAX=100*NM;   // half-width of the map view in metres; − / = / mouse wheel zoom
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
	// player aircraft: triangle pointing along heading
	const hx=ownship.fwd.x, hz=ownship.fwd.z, hl=Math.hypot(hx,hz)||1; const ux=hx/hl, uz=hz/hl, rxv=-uz, rzv=ux;
	mctx.fillStyle="#ffffff"; mctx.beginPath();
	mctx.moveTo(px+ux*12,py+uz*12); mctx.lineTo(px-ux*8+rxv*7,py-uz*8+rzv*7); mctx.lineTo(px-ux*8-rxv*7,py-uz*8-rzv*7); mctx.closePath(); mctx.fill();
	mctx.fillStyle="#ffffff"; mctx.font="10px monospace"; mctx.fillText(translate("YOU"),px,py+24);
}
addEventListener("resize",()=>{ if(map_on) map_resize(); },{ signal });
map_el.addEventListener("wheel",e=>{ e.preventDefault(); map_range=THREE.MathUtils.clamp(map_range*Math.pow(1.2,Math.sign(e.deltaY)),MAP_RANGE_MIN,MAP_RANGE_MAX); },{ signal, passive:false });   // wheel down = zoom out (map only — chase zoom deliberately stays on −/=)

let last_range=0;
function dir_at(headFwd, rightH, yawRad, pitchRad){ const d=headFwd.clone().applyAxisAngle(world_up,yawRad); d.applyAxisAngle(rightH,pitchRad); return d; }
function hud_message(text){ hctx.textAlign="center"; hctx.fillStyle=AM; hctx.font="20px monospace"; hctx.fillText(text, HW/2, HH/2+180); }   // shared centre banner for important messages (RUN UP ENGINE / PRESS SPACE TO LAUNCH / N WIRE)
function draw_hud(dt){
	hctx.clearRect(0,0,HW,HH);
	GR=cfg.tod==="day"?"#23e57d":"#15b85f";   // daytime brightness up — the muted night green washes out against a sunlit sea/sky
	hctx.shadowColor="rgba(0,0,0,0.85)"; hctx.shadowBlur=3; hctx.shadowOffsetX=0; hctx.shadowOffsetY=0;   // dark halo behind every HUD glyph/line so it stays readable over any background
	const cx=HW/2, cy=HH/2;
	if(crash_t>0){ hctx.textAlign="center"; hctx.fillStyle="#ff5040"; hctx.font="bold 36px monospace"; hctx.fillText(translate("CRASHED"),cx,cy-60); return; }
	if(crash_t<=0 && ownship.pass_t>0){ ownship.pass_t-=dt;   // LSO debrief: grade + wire (or BOLTER), held for a few seconds after the pass
		hud_message(ownship.grade==="BOLTER"?translate("BOLTER"):translate(ownship.grade)+", "+translate(ownship.wire+" WIRE")); }
	else if(crash_t<=0 && ownship.waving && (performance.now()%400)<200){ hud_message(translate("WAVE OFF")); }   // flashing waveoff call while dangerously low in close (matches the OLS waveoff lights)
	if(test_active){ hctx.textAlign="left"; hctx.fillStyle="#7fc8ff"; hctx.font="13px monospace"; hctx.fillText("TEST  "+test_active.name, 14, 28); }   // dev test-scenario label (untranslated, like the align overlay)
	if(deck_edit && carrier_model){   // carrier-frame position + centreline — only in the dev deck-alignment mode (key 0)
		hctx.textAlign="left"; hctx.fillStyle="#7fc8ff"; hctx.font="14px monospace";
		hctx.fillText("deck  fa="+carrier_fore_aft(ownship.pos.x,ownship.pos.z).toFixed(1)+"  lat="+carrier_lateral(ownship.pos.x,ownship.pos.z).toFixed(1)+"  h="+(ownship.pos.y-CARRIER.deckY).toFixed(1), 14, 28);
		hctx.save(); hctx.strokeStyle="rgba(127,200,255,0.55)"; hctx.lineWidth=1; hctx.setLineDash([7,7]); hctx.beginPath(); hctx.moveTo(cx,0); hctx.lineTo(cx,HH); hctx.stroke(); hctx.restore(); }   // alignment centreline
	// ---- carrier / deck-align overlay: shown in every view (incl. chase) ----
	if(deck_edit){ hctx.textAlign="center"; hctx.save(); hctx.strokeStyle="rgba(255,193,77,0.55)"; hctx.lineWidth=1; hctx.setLineDash([6,6]);
			hctx.beginPath(); hctx.moveTo(cx,0); hctx.lineTo(cx,HH); hctx.stroke(); hctx.restore();
			hctx.fillStyle=AM; hctx.font="13px monospace"; hctx.fillText("DECK ALIGN  CAT "+(cat_idx+1)+"  Shift+1-4 select · I/K fore-aft · J/L port-stbd · [ ] height · U/O rotate · 0 save",cx,cy+182);
			hctx.fillStyle=GR; hctx.fillText("x="+cfg.cats[cat_idx].x.toFixed(2)+"  z="+cfg.cats[cat_idx].z.toFixed(2)+"  height="+cfg.cat_dy.toFixed(2)+"  hdg="+cfg.cats[cat_idx].h.toFixed(1)+"\u00b0    (camera: Shift+\u2190\u2192 orbit · ,/. tilt · \u2212/= zoom)",cx,cy+200); }
		else { const ls=launch_status(); if(ls>0) hud_message(translate(ls===2?"PRESS ENTER TO LAUNCH":"RUN UP ENGINE")); }
	if(cat_saved_t>0){ cat_saved_t-=dt; hctx.textAlign="center"; hctx.fillStyle=GR; hctx.font="14px monospace"; hctx.fillText(translate("DECK POSITION SAVED"),cx,cy+182); }
	if(cfg.view!=="hud" && cfg.view!=="cockpit"){ return; }
	{ const mb=meatball_state(ownship.pos);   // 2D OLS meatball, top-left, when on the carrier approach with gear + hook down
		if(mb){ const bx=72, by=150, half=58; hctx.save();
			hctx.fillStyle="rgba(0,0,0,0.35)"; hctx.fillRect(bx-11,by-half-10,22,half*2+20); hctx.strokeStyle="rgba(150,150,150,0.5)"; hctx.lineWidth=1; hctx.strokeRect(bx-11,by-half-10,22,half*2+20);
			hctx.fillStyle="#35e06a"; for(const s of [-1,1]) for(let i=1;i<=3;i++){ hctx.beginPath(); hctx.arc(bx+s*(13+i*7),by,2.4,0,Math.PI*2); hctx.fill(); }   // green datum lights
			const off=THREE.MathUtils.clamp(mb.dev/0.8,-1,1)*half; hctx.fillStyle=mb.low?"#ff2a1e":"#ffb020"; hctx.beginPath(); hctx.arc(bx,by-off,6.5,0,Math.PI*2); hctx.fill();   // the ball — up when high, red when low
			hctx.restore(); } }
	draw_icls();   // ICLS/ACLS needles (centre): lineup + glideslope on the carrier approach
	hctx.lineWidth=1.5; hctx.strokeStyle=GR; hctx.fillStyle=GR; hctx.font="13px "+getComputedStyle(document.body).fontFamily;
	hctx.textAlign="center"; hctx.textBaseline="middle";

	// ---- pitch ladder (projected, world-aligned) ----
	const headFwd=new THREE.Vector3(ownship.fwd.x,0,ownship.fwd.z);
	if(headFwd.lengthSq()>0.0025){ headFwd.normalize(); const rightH=new THREE.Vector3().crossVectors(world_up,headFwd).normalize();
		for(let p=-80;p<=80;p+=10){ const span=(p===0?14:7)*Math.PI/180; const pr=p*Math.PI/180;
			const L=proj_dir(dir_at(headFwd,rightH,span,pr)), R=proj_dir(dir_at(headFwd,rightH,-span,pr)); if(!L||!R) continue;
			const climb=p>0, dive=p<0; hctx.save(); hctx.strokeStyle=GR; hctx.fillStyle=GR;
			if(dive){ hctx.setLineDash([7,6]); } else hctx.setLineDash([]);
			const midx=(L[0]+R[0])/2, midy=(L[1]+R[1])/2; const gap=p===0?28:24;
			const ang=Math.atan2(R[1]-L[1],R[0]-L[0]); const gx=Math.cos(ang)*gap, gy=Math.sin(ang)*gap;
			hctx.beginPath(); hctx.moveTo(L[0],L[1]); hctx.lineTo(midx-gx,midy-gy); hctx.moveTo(midx+gx,midy+gy); hctx.lineTo(R[0],R[1]); hctx.stroke();
			if(p!==0){ const tick=climb?10:-10; hctx.setLineDash([]); hctx.beginPath();
				hctx.moveTo(L[0],L[1]); hctx.lineTo(L[0],L[1]+tick); hctx.moveTo(R[0],R[1]); hctx.lineTo(R[0],R[1]+tick); hctx.stroke();
				hctx.font="11px monospace"; hctx.fillText(Math.abs(p),L[0]-14,L[1]); hctx.fillText(Math.abs(p),R[0]+14,R[1]); }
			hctx.restore(); } }

	// ---- boresight gun cross (screen centre) ----
	hctx.strokeStyle=GR; hctx.setLineDash([]); hctx.beginPath();
	hctx.moveTo(cx-12,cy); hctx.lineTo(cx-4,cy); hctx.moveTo(cx+4,cy); hctx.lineTo(cx+12,cy);
	hctx.moveTo(cx,cy-12); hctx.lineTo(cx,cy-4); hctx.stroke();

	// ---- flight-path marker (velocity vector) ----
	const fpm=proj_dir(ownship.vel_dir);
	if(fpm){ hctx.beginPath(); hctx.arc(fpm[0],fpm[1],6,0,Math.PI*2);
		hctx.moveTo(fpm[0]-6,fpm[1]); hctx.lineTo(fpm[0]-14,fpm[1]); hctx.moveTo(fpm[0]+6,fpm[1]); hctx.lineTo(fpm[0]+14,fpm[1]); hctx.moveTo(fpm[0],fpm[1]-6); hctx.lineTo(fpm[0],fpm[1]-12); hctx.stroke(); }

	// ---- target boxes: the AI bandit (joust) or every remote player (multiplayer) ----
	let rng = has_enemy ? wrap_distance(ownship.pos,bandit.pos) : 1500;   // minimum-image across the toroidal wrap
	if(has_enemy){ const closure=dt>0?(last_range-rng)/dt*1.94384:0; last_range=rng;
		const tb=proj_point(bandit.pos);
		if(tb){ hctx.strokeStyle=AM; hctx.fillStyle=AM; hctx.strokeRect(tb[0]-22,tb[1]-22,44,44);
			hctx.font="11px monospace"; hctx.textAlign="left";
			hctx.fillText((rng/1852).toFixed(1)+" NM",tb[0]+28,tb[1]-8); hctx.fillText((closure>0?"+":"")+Math.round(closure)+" kt",tb[0]+28,tb[1]+8); } }
	else if(MULTIPLAYER&&net){ let nearest=1e12;   // box every live remote with callsign + range; the pipper ranges on the nearest
		for(const st of remotes.values()){ if(!st.group.visible) continue;
			const r=wrap_distance(ownship.pos,st.pos); if(r<nearest) nearest=r;
			const tb=proj_point(st.pos);
			if(tb){ hctx.strokeStyle=AM; hctx.fillStyle=AM; hctx.strokeRect(tb[0]-22,tb[1]-22,44,44);
				hctx.font="11px monospace"; hctx.textAlign="left";
				if(st.name) hctx.fillText(st.name,tb[0]+28,tb[1]-8);
				hctx.fillText((r/1852).toFixed(1)+" NM",tb[0]+28,tb[1]+8); } }
		if(nearest<1e12) rng=nearest; }

	// ---- lead-computing gun pipper ----
	const t=Math.min(rng,2000)/muzzle; const muz=body_offset(ownship,6.0,0.35,0.0);   // match the gun port used in fire_gun
	const impact=muz.clone().addScaledVector(ownship.fwd,muzzle*t).addScaledVector(ownship.vel_dir,ownship.speed*t); impact.y-=0.5*9.8*t*t;
	const pip=proj_point(impact);
	if(pip){ hctx.strokeStyle=GR; hctx.fillStyle=GR; hctx.beginPath(); hctx.arc(pip[0],pip[1],4,0,Math.PI*2); hctx.fill();
		hctx.beginPath(); hctx.arc(pip[0],pip[1],11,0,Math.PI*2); hctx.stroke(); }

	// ---- heading tape (top), smooth scrolling ----
	hctx.save(); hctx.strokeStyle=GR; hctx.fillStyle=GR; hctx.textAlign="center"; hctx.font="11px monospace";
	const hdg=(Math.atan2(ownship.fwd.x,-ownship.fwd.z)*180/Math.PI+360)%360; const ppd=7, halfd=40;
	hctx.beginPath(); hctx.moveTo(cx-280,46); hctx.lineTo(cx+280,46); hctx.stroke();
	hctx.beginPath(); hctx.rect(cx-282,24,564,40); hctx.clip();                          // clip ticks to the tape window
	const m0=Math.ceil((hdg-halfd)/5)*5;
	for(let m=m0;m<=hdg+halfd;m+=5){ const hx=cx+(m-hdg)*ppd; const val=((m%360)+360)%360; const major=(m%10===0);
		hctx.beginPath(); hctx.moveTo(hx,46); hctx.lineTo(hx,major?38:42); hctx.stroke();
		if(major) hctx.fillText(val===0?"36":String(val/10).padStart(2,"0"),hx,30); }
	hctx.restore();
	hctx.fillStyle=GR; hctx.beginPath(); hctx.moveTo(cx,52); hctx.lineTo(cx-6,60); hctx.lineTo(cx+6,60); hctx.closePath(); hctx.fill();
	hctx.textAlign="center"; hctx.font="14px monospace"; hctx.fillText(String(Math.round(hdg)%360).padStart(3,"0"),cx,72);

	// ---- airspeed tape (left), smooth scrolling ----
	const kcas=(ownship.cas??ownship.speed)*1.94384; const axr=cx-150, atop=cy-105, abot=cy+105, appu=1.5;   // px per knot — CAS, the F/A-18 HUD's speed source (not TAS)
	hctx.save(); hctx.strokeStyle=GR; hctx.fillStyle=GR; hctx.lineWidth=1.2;
	hctx.beginPath(); hctx.moveTo(axr,atop); hctx.lineTo(axr,abot); hctx.stroke();           // reference line
	hctx.beginPath(); hctx.rect(axr-58,atop,58,abot-atop); hctx.clip();
	const sv0=Math.ceil((kcas-(abot-atop)/2/appu)/10)*10;
	hctx.textAlign="right"; hctx.font="11px monospace";
	for(let v=Math.max(0,sv0); v<=kcas+(abot-atop)/2/appu; v+=10){ const y=cy+(kcas-v)*appu; const major=(v%50===0);
		hctx.beginPath(); hctx.moveTo(axr,y); hctx.lineTo(axr-(major?12:7),y); hctx.stroke();
		if(major) hctx.fillText(String(v),axr-16,y+4); }
	hctx.restore();
	hctx.fillStyle=GR; hctx.strokeStyle=GR; hctx.beginPath();                                 // current-value pointer
	hctx.moveTo(axr,cy); hctx.lineTo(axr-8,cy-9); hctx.lineTo(axr-54,cy-9); hctx.lineTo(axr-54,cy+9); hctx.lineTo(axr-8,cy+9); hctx.closePath(); hctx.stroke();
	hctx.fillStyle=GR; hctx.textAlign="right"; hctx.font="15px monospace"; hctx.fillText(String(Math.round(kcas)),axr-10,cy+5);
	hctx.textAlign="left"; hctx.font="11px monospace"; hctx.fillText("M "+(ownship.speed/343).toFixed(2),axr-52,abot+18);
	hctx.fillText("G "+ownship.gload.toFixed(1),axr-52,abot+34); hctx.fillText("\u03b1 "+ownship.aoa.toFixed(0),axr-52,abot+50);

	// ---- altitude tape (right) with integrated VSI, smooth scrolling ----
	const ft=ownship.pos.y*3.28084; const lxl=cx+150, ltop=cy-105, lbot=cy+105, lppu=0.05;     // px per foot
	hctx.save(); hctx.strokeStyle=GR; hctx.fillStyle=GR; hctx.lineWidth=1.2;
	hctx.beginPath(); hctx.moveTo(lxl,ltop); hctx.lineTo(lxl,lbot); hctx.stroke();
	hctx.beginPath(); hctx.rect(lxl,ltop,72,lbot-ltop); hctx.clip();
	const lv0=Math.ceil((ft-(lbot-ltop)/2/lppu)/200)*200;
	hctx.textAlign="left"; hctx.font="11px monospace";
	for(let v=lv0; v<=ft+(lbot-ltop)/2/lppu; v+=200){ const y=cy+(ft-v)*lppu; const major=(v%1000===0);
		hctx.beginPath(); hctx.moveTo(lxl,y); hctx.lineTo(lxl+(major?12:7),y); hctx.stroke();
		if(major) hctx.fillText(String(v),lxl+16,y+4); }
	hctx.restore();
	hctx.fillStyle=GR; hctx.strokeStyle=GR; hctx.beginPath();                                  // current-value pointer
	hctx.moveTo(lxl,cy); hctx.lineTo(lxl+8,cy-9); hctx.lineTo(lxl+58,cy-9); hctx.lineTo(lxl+58,cy+9); hctx.lineTo(lxl+8,cy+9); hctx.closePath(); hctx.stroke();
	hctx.fillStyle=GR; hctx.textAlign="left"; hctx.font="15px monospace"; hctx.fillText(String(Math.round(ft)),lxl+12,cy+5);
	hctx.font="10px monospace"; hctx.textAlign="center"; hctx.fillText("FT",lxl+30,ltop-8);
	// VSI: a green triangle that slides up/down the right side of the altitude tape (climb up, descent down)
	const vs=ownship.vel_dir.y*ownship.speed*196.85; const vxx=lxl+72, vmax=(lbot-ltop)/2;
	hctx.strokeStyle=GR; hctx.lineWidth=1; hctx.beginPath(); hctx.moveTo(vxx,ltop); hctx.lineTo(vxx,lbot); hctx.stroke();   // travel guide
	for(const tk of [2000,4000,6000]){ for(const s of [1,-1]){ const y=cy-s*tk/6000*vmax; hctx.beginPath(); hctx.moveTo(vxx,y); hctx.lineTo(vxx+4,y); hctx.stroke(); } }
	const vy=cy-THREE.MathUtils.clamp(vs/6000,-1,1)*vmax;
	hctx.fillStyle=GR; hctx.beginPath(); hctx.moveTo(vxx,vy); hctx.lineTo(vxx+13,vy-8); hctx.lineTo(vxx+13,vy+8); hctx.closePath(); hctx.fill();
	hctx.textAlign="left"; hctx.font="10px monospace"; hctx.fillText((vs>=0?"+":"")+(Math.round(vs/100)*100),vxx+17,vy+4);

	// ---- throttle vertical gauge (left of airspeed) ----
	const tgx=cx-262, tgcy=cy, tgh=140; hctx.strokeStyle=GR; hctx.fillStyle=GR; hctx.textAlign="center"; hctx.lineWidth=1.5;
	hctx.strokeRect(tgx-8,tgcy-tgh/2,16,tgh);
	const fh=tgh*ownship.throttle; hctx.fillRect(tgx-8,tgcy+tgh/2-fh,16,fh);
	hctx.font="11px monospace"; hctx.fillStyle=GR; hctx.fillText("THR",tgx,tgcy-tgh/2-9);
	const thrust=(ownship.spool??ownship.throttle)*100+(ownship.stage??0)*58;   // achieved thrust, % of military power; burner runs to ~158%
	hctx.font="15px monospace"; hctx.fillText(Math.round(thrust)+"%",tgx,tgcy+tgh/2+15);
	if((ownship.stage??0)>0.1){ hctx.font="11px monospace"; hctx.fillText("AB",tgx,tgcy+tgh/2+28); }

	// ---- gear / hook status (bottom-right) ----
	// Shown only while deployed (like the SPD BK convention): green = down & locked,
	// amber = in transit; nothing drawn in the clean configuration (gear up, hook stowed).
	hctx.textAlign="right"; hctx.font="13px monospace";
	if((ownship.speedbrake??0)>0.02){ hctx.fillStyle=AM; hctx.fillText(translate("SPD BK"),HW-40,HH-88); }   // amber whenever the air brake is out (keys.md §3)
	if(ownship.gear<0.99){ hctx.fillStyle=ownship.gear<0.02?GR:AM; hctx.fillText(translate("GEAR"),HW-40,HH-70); }
	if((ownship.hook??0)>0.01){ hctx.fillStyle=(ownship.hook??0)>0.98?GR:AM; hctx.fillText(translate("HOOK"),HW-40,HH-52); }
	if(ownship.lights){ hctx.fillStyle=GR; hctx.fillText(translate("LIGHTS"),HW-40,HH-34); }   // below HOOK

	// ---- weapon legend (bottom-left) ----
	hctx.textAlign="left"; hctx.font="13px monospace"; hctx.fillStyle=input.guns?AM:GR;
	hctx.fillText(translate("GUN")+"  "+ownship.rounds,40,HH-88); hctx.fillStyle=GR;
	hctx.fillText("IR  "+ownship.msl,40,HH-70); hctx.fillText(translate("FLARES")+"  "+ownship.cm,40,HH-52);

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
// clobbered by a saved cfg. 1.5 = ~2.25× pixels; raise toward 2.0 for crisper, lower if a client struggles.
const SUPERSAMPLE=1.5;
function apply_size(){ const w=innerWidth,h=innerHeight,dpr=Math.min(devicePixelRatio||1,2),sc=THREE.MathUtils.clamp(cfg.render_scale,0.3,2.0)*dpr*SUPERSAMPLE;
	renderer.setSize(Math.round(w*sc),Math.round(h*sc),false); canvas.style.width=w+"px"; canvas.style.height=h+"px";
	camera.aspect=w/h; camera.updateProjectionMatrix(); hud_resize(); if(cloud_active()||rt) size_rt(); }
addEventListener("resize",apply_size,{ signal });
let dyn_cd=0;
function dynamic_res(dt){ if(!cfg.dyn_res) return; dyn_cd-=dt; if(dyn_cd>0) return; dyn_cd=0.5; const recent=ft_ring.slice(-30).reduce((s,v)=>s+v,0)/30;
	if(recent>18&&cfg.render_scale>0.45){ cfg.render_scale=Math.max(0.45,cfg.render_scale-0.1); apply_size(); }
	else if(recent<14&&cfg.render_scale<1.0){ cfg.render_scale=Math.min(1.0,cfg.render_scale+0.05); apply_size(); } }

// ============================================================================ UI / menu
function set_view(v){
	if(v==="chase" && cfg.view!=="chase") cam_psi=Math.atan2(ownship.fwd.x,ownship.fwd.z);   // entering chase: reference the orbit to the current heading (no half-compass ease-in)
	if(v==="chase" && cfg.view==="chase"){ cam_az=0; cam_el=0.22; cam_dist=24; }   // re-press recentres the orbit (keys.md §4)
	if(v==="flypast") flyby_pos=null;   // (re)seed a fresh flyby each time it's selected
	cfg.view=v;
}
function apply_effects(){ renderer.shadowMap.enabled=cfg.shadows; sun.castShadow=cfg.shadows;
	const setc=g=>g.traverse(c=>{ if(c.isMesh&&(c.userData.body||c.userData.modelmesh))c.castShadow=cfg.shadows; }); setc(ownship.group); setc(bandit.group); extras.forEach(s=>setc(s.group)); }

// ============================================================================ multiplayer
// The server is authoritative (world/games/furball runs the same placeholder
// kinematics); fly_player keeps running as the local predictor and is
// corrected from snapshots — snap when >20 m off (minimum-image), gentle pull
// otherwise. Remote players are interpolated ~100 ms behind live; the first
// reuses the bandit airframe, the rest get their own.
let net=null, flare_flag=false, missile_flag=false, session_over=false;
let net_notice="", net_notice_t=0;
let own_kills=0, own_deaths=0, match_started=0;
const remotes=new Map();   // slot -> aircraft state
function notice(text){ net_notice=text; net_notice_t=3; }
function remote_for(slot){ let st=remotes.get(slot); if(st) return st;
	if(![...remotes.values()].includes(bandit)) st=bandit;
	else { st=make_state(new THREE.Vector3(0,3000,0),new THREE.Vector3(1,0,0),200); st.group=make_jet(0xb04a3a); scene.add(st.group); if(model_active) apply_model_to(st.group); }
	remotes.set(slot,st); st.group.visible=true; return st; }
function remote_drop(slot){ const st=remotes.get(slot); if(!st) return; remotes.delete(slot);
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
		break;
	case "respawn":
		if(net&&slot===net.slot){ apply_own_state(e.state); flight_push(); crash_t=0; ownship.group.visible=true; }
		break;
	case "flare": if(net&&slot!==net.slot){ const st=remotes.get(slot); if(st&&cfg.flares) dispense_flares(st); } break;
	case "join": if(!net||slot!==net.slot) notice((e.name||"")+" "+translate("JOINED")); break;
	case "leave": remote_drop(slot); notice((e.name||"")+" "+translate("LEFT")); break;
	} }
function net_finish(reason){ if(session_over) return; session_over=true;
	if(net&&match_started){ net_record({ world:join.server, session:join.session, mode:"joust",
		started:match_started, ended:Date.now(), reason,
		players:JSON.stringify([...remotes.keys()].length+1), kills:own_kills, deaths:own_deaths }); }
	if(net){ net.leave(); net=null; } }
function net_end(reason,results){ if(session_over) return;
	net_finish(reason);
	if(results&&results.name){ notice(results.name+" "+translate("WINS")); }   // joust outcome
	else notice(translate("SESSION ENDED"));
	setTimeout(()=>{ if(running){ running=false; if(onExit) onExit(); } },1800); }
function net_frame(dt){
	const c=last_controls;
	const sample={ pitch:c?c.pitch:input.pitch*cfg.sens, roll:c?c.roll:input.roll*cfg.sens, yaw:c?c.yaw:input.yaw*cfg.sens,
		throttle:ownship.throttle, speedbrake:ownship.speedbrakeTarget??0,
		reheat:ownship.throttle>=0.98, brake:input.brake,
		gear:(ownship.gearTarget??0)<0.5, hook:(ownship.hookTarget??0)>0.5,   // wire gear/hook: true = down/deployed
		override:c?c.override:false,
		fire:input.guns&&!ownship.launching&&(ownship.gear??0)>0.98, flare:flare_flag, missile:missile_flag };
	const sequence=net.input(sample);
	if(sequence>0){ flare_flag=false; missile_flag=false; }
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
	const seen=new Set();
	for(const slot of net.slots()){ const pose=net.remote(slot); if(!pose) continue; seen.add(slot);
		const st=remote_for(slot);
		st.pos.set(pose.position[0],pose.position[1],pose.position[2]); st.speed=pose.speed;
		st.group.quaternion.set(pose.attitude[1],pose.attitude[2],pose.attitude[3],pose.attitude[0]);
		st.group.position.copy(st.pos);
		st.fwd.set(1,0,0).applyQuaternion(st.group.quaternion);
		st.velx=st.fwd.x*pose.speed; st.vely=st.fwd.y*pose.speed; st.velz=st.fwd.z*pose.speed;
		st.gearTarget=pose.gear?0:1; st.hookTarget=pose.hook?1:0; st.speedbrakeTarget=pose.speedbrake;
		st.name=pose.name; st.group.visible=pose.alive; }
	for(const slot of [...remotes.keys()]) if(!seen.has(slot)) remote_drop(slot); }
function net_connect(){
	net_dial(join,{ event:net_event, end:(reason,results)=>net_end(reason||"finished",results), close:()=>net_end("gone") })
	.then((n)=>{ net=n; match_started=Date.now();
		if(n.welcome&&n.welcome.spawn) apply_own_state(n.welcome.spawn.state);
		const rules=(n.welcome&&n.welcome.parameters)||{};   // the creator's weather + rules apply to every participant
		if(rules.tod==="day"||rules.tod==="night"){ cfg.tod=rules.tod; apply_time_of_day(cfg.tod); apply_effects(); }
		if(typeof rules.clouds==="string"&&["none","cumulus","high_stratus","low_stratus"].includes(rules.clouds)){
			cfg.clouds=rules.clouds; if(cloud_active()){ apply_clouds(); size_rt(); } }
		cfg.missiles=rules.missiles===true;
		})
	.catch((error)=>{ console.error("furball multiplayer:", error);   // the HUD shows the headline; the console keeps the cause
		notice(translate("CONNECTION FAILED")); setTimeout(()=>{ if(running){ running=false; if(onExit) onExit(); } },1800); }); }

function start_mission(){
	build_ocean(cfg.ocean_segments);
	apply_time_of_day(cfg.tod); apply_effects();
	if(cloud_active()){ apply_clouds(); size_rt(); }
	has_enemy=(cfg.task==="joust")&&!MULTIPLAYER; bandit.group.visible=has_enemy;   // multiplayer: the bandit airframe is a remote player's, posed from snapshots
	sync_extras(cfg.extra_aircraft);
	reset_ownship(); apply_size(); save_cfg();
	pause_toggle=false; map_on=false; map_el.style.display="none";
	loading=!assets_ready(); loading_t0=performance.now();   // hold the LOADING screen until every async asset is in — no piecemeal pop-in of carrier/airfield/airframe
	cloud_mat.uniforms.uDebug.value=0;   // clear the Shift+C cloud A/B latch — a stale debug toggle must not survive into a fresh mission
	running=true;
	try{ window.focus(); stage.focus(); }catch(e){}
}
function assets_ready(){ return !!carrier_model && model_active && airports.length>0 && flight_ready(); }   // the async loads: carrier GLB (+deck aids), fighter GLB, map/airfield, flight core wasm

// ============================================================================ boot
apply_time_of_day(cfg.tod); apply_effects(); apply_size();
help_el.style.display="none";   // controls list lives in the pause window now (shown while paused via P)
addEventListener("pointerdown",()=>{ try{ window.focus(); }catch(e){} },{ signal });

function menu_backdrop(){ const a=performance.now()*0.00007; const r=440;
	camera.position.set(CARRIER.x+Math.cos(a)*r, CARRIER.deckY+70, CARRIER.z+Math.sin(a)*r);
	camera.up.set(0,1,0); camera.lookAt(CARRIER.x,CARRIER.deckY+12,CARRIER.z);
	ownship.group.visible=true; ownship.group.position.copy(ownship.pos); ownship.group.quaternion.copy(ownship.q); bandit.group.visible=false; }

const clock=new THREE.Clock();
function frame(){ const dt=Math.min(clock.getDelta(),0.05);
	if(running && loading){   // hold on a black LOADING screen, then jump straight to the fully rendered scene (no piecemeal pop-in)
		if(assets_ready() || performance.now()-loading_t0>20000){ loading=false; }
		else { draw_loading(); __raf=requestAnimationFrame(frame); return; }
	}
	game_paused = running && !MULTIPLAYER && (map_on || pause_toggle);
	if(running){
		if(!game_paused){ ocean_mat.uniforms.u_time.value+=dt; step_world(dt); }   // frozen world stops advancing
		update_camera(dt);
	} else { ocean_mat.uniforms.u_time.value+=dt; menu_backdrop(); }
	if(ocean){ ocean.position.x=camera.position.x; ocean.position.z=camera.position.z; }
	sky.position.copy(camera.position); stars.position.copy(camera.position);
	render_frame();
	stage.style.cursor=(running && !game_paused)?"none":"";   // hide the mouse pointer while in flight; restore it in the menu / when paused
	help_el.style.display=(running && pause_toggle && !map_on)?"":"none";   // pause window: controls list appears while paused via P
	if(running){ draw_hud(dt); if(game_paused && !map_on) draw_pause_banner();
		if(net_notice_t>0){ net_notice_t-=dt; hud_message(net_notice); } } else hctx.clearRect(0,0,HW,HH);
	if(map_on){ const zf=Math.pow(2.2,dt), pr=map_range*dt*0.9;   // held − zooms out, = zooms in (smooth; wheel does notches); arrows pan, scaled to the zoom
		if(keys.has("Minus")) map_range=Math.min(MAP_RANGE_MAX,map_range*zf);
		if(keys.has("Equal")) map_range=Math.max(MAP_RANGE_MIN,map_range/zf);
		if(keys.has("ArrowLeft")) map_px-=pr; if(keys.has("ArrowRight")) map_px+=pr;
		if(keys.has("ArrowUp")) map_pz-=pr; if(keys.has("ArrowDown")) map_pz+=pr;
		draw_map(); }
	refresh_perf(dt); dynamic_res(dt);
	__raf = requestAnimationFrame(frame); }
function draw_loading(){ hctx.clearRect(0,0,HW,HH); hctx.fillStyle="#000"; hctx.fillRect(0,0,HW,HH);   // opaque: covers the half-built 3D scene beneath
	hctx.textAlign="center"; hctx.fillStyle=AM; hctx.font="22px monospace";
	hctx.fillText(translate("LOADING")+".".repeat(1+Math.floor(performance.now()/400)%3), HW/2, HH/2); }
function draw_pause_banner(){ hctx.save(); hctx.textAlign="center"; hctx.fillStyle="rgba(3,12,9,0.45)"; hctx.fillRect(HW/2-150,HH/2-44,300,88);
	hctx.fillStyle=AM; hctx.font="34px monospace"; hctx.fillText(translate("PAUSED"),HW/2,HH/2-2);
	hctx.fillStyle=GR; hctx.font="12px monospace"; hctx.fillText(translate("P to resume \u00b7 M map \u00b7 Esc menu"),HW/2,HH/2+24); hctx.restore(); }
start_mission();
if(MULTIPLAYER) net_connect();
__raf = requestAnimationFrame(frame);
init_external_model();
init_carrier_model();
void flight_load();   // the wasm flight core loads alongside the GLBs; assets_ready() gates on it

  function stop() {
    if (MULTIPLAYER) net_finish('left')
    try { __ac.abort() } catch (e) {}
    cancelAnimationFrame(__raf)
    try { renderer.dispose() } catch (e) {}
  }
  // Re-enter a game paused by Esc (running was set false; state is preserved).
  // Re-applies any settings changed in the menu that take effect live — sensitivity,
  // invert, render scale, shadows, time of day. Mission, start, clouds and ocean
  // detail only take effect on a Restart (a fresh start_mission).
  function resume(updated) {
    if (updated) {
      Object.assign(cfg, updated)
      apply_size()
      apply_effects()
      apply_time_of_day(cfg.tod)
    }
    running = true
    try { stage.focus() } catch (e) {}
  }
  return { stop, resume }
}
