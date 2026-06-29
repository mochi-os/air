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
  onExit,
  translate = (s) => s,
}: {
  stage: HTMLCanvasElement
  hud: HTMLCanvasElement
  map: HTMLCanvasElement
  help: HTMLElement
  framerate?: HTMLElement
  config?: GameConfig
  onExit?: () => void
  translate?: (text: string) => string
}): GameHandle {
  const __ac = new AbortController()
  const signal = __ac.signal
  let __raf = 0

// ============================================================================ config
const cfg = { render_scale:1.0, dyn_res:false, ocean_segments:256, exterior_detail:3, lod:true, extra_aircraft:0,
	tracers:true, fire_rate:3, missiles:true, flares:true, shadows:false, clouds:"none", afterburner:true,
	view:"hud", invert:false, framerate:false, sens:1.0,
	task:"joust", start:"carrier", tod:"day", help:false,
	cat_x:49.31, cat_z:-0.58, cat_h:1.6, cat_dy:2.26 };   // carrier spawn = #2 (port bow) catapult, tuned: x toward bow, z to port, heading deg (0=+X), dy = height above deck
const SAVE_KEY="joust_cfg_v1";
const CAT_KEYS=["cat_x","cat_z","cat_h","cat_dy"];
const CAT_DEFAULTS={cat_x:cfg.cat_x, cat_z:cfg.cat_z, cat_h:cfg.cat_h, cat_dy:cfg.cat_dy};   // baked-in spawn = canonical; localStorage copy is only read in alignment mode
function load_cfg(){ try{ const s=localStorage.getItem(SAVE_KEY); if(s) Object.assign(cfg,JSON.parse(s)); }catch(e){}
	Object.assign(cfg,CAT_DEFAULTS);   // normal load always uses baked catapult position, never the saved one
	if(cfg.clouds==="simple"||cfg.clouds==="volumetric") cfg.clouds=cfg.clouds==="volumetric"?"cumulus":"none"; }   // migrate removed types
function save_cfg(){ try{ const cur={...cfg};
	if(!deck_edit){ const prev=JSON.parse(localStorage.getItem(SAVE_KEY)||"{}"); for(const k of CAT_KEYS) if(k in prev) cur[k]=prev[k]; }   // outside alignment, don't clobber the stored catapult scratch values
	localStorage.setItem(SAVE_KEY,JSON.stringify(cur)); }catch(e){} }
function enter_align(){ try{ const prev=JSON.parse(localStorage.getItem(SAVE_KEY)||"{}"); for(const k of CAT_KEYS) if(k in prev) cfg[k]=prev[k]; }catch(e){} place_on_cat(); }   // alignment mode resumes from the last saved catapult position
load_cfg();
Object.assign(cfg, config);   // mission-setup menu overrides saved/defaults
cfg.view="hud";   // always start in HUD view (V still cycles during play)
cfg.help=false;   // keys-help overlay hidden by default and not persisted (H toggles it for the session only)
let running=false, has_enemy=true;
const MULTIPLAYER=false;             // single-player today; map/P pause only when this is false
let pause_toggle=false, game_paused=false;
const sun_dir = new THREE.Vector3(0.45,0.42,-0.32).normalize();
const CARRIER={ x:0, z:0, deckY:19 };   // heading +X, bow at +x
const sky_horizon=new THREE.Color(0xbfd8e8), sky_zenith=new THREE.Color(0x2a5a8c), fog_colour=new THREE.Color(0xc4d6e2);
const col_sundisc=new THREE.Color(0xfff3da), col_deep=new THREE.Color(0x0a2a3a), col_shallow=new THREE.Color(0x1d6e86);

// ============================================================================ renderer/scene
const canvas = stage;
const renderer = new THREE.WebGLRenderer({ canvas, antialias:true, powerPreference:"high-performance" });
renderer.outputColorSpace=THREE.SRGBColorSpace; renderer.toneMapping=THREE.ACESFilmicToneMapping; renderer.toneMappingExposure=1.05;
renderer.shadowMap.type=THREE.PCFSoftShadowMap;
const scene = new THREE.Scene(); scene.fog=new THREE.FogExp2(fog_colour,0.000042);
const camera = new THREE.PerspectiveCamera(62,1,3.0,42000);

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
	day:  { sun:[0.45,0.42,-0.32], sunCol:0xfff4e0, sunI:2.4,  disc:0xfff3da, hor:0xbfd8e8, zen:0x2a5a8c, fog:0xc4d6e2, deep:0x0a2a3a, shal:0x1d6e86, hs:0xbcd6ec, hg:0x35506a, hi:0.9,  ac:0x405060, ai:0.4,  exp:1.05, stars:0.0 },
	dusk: { sun:[0.96,0.10,-0.26], sunCol:0xffb060, sunI:1.7,  disc:0xffd49a, hor:0xf3a064, zen:0x39376e, fog:0xd7a585, deep:0x10202e, shal:0x39555f, hs:0xc89a82, hg:0x402f3a, hi:0.6,  ac:0x40303a, ai:0.34, exp:1.0,  stars:0.18 },
	night:{ sun:[0.30,0.55,-0.40], sunCol:0x9fb6e0, sunI:0.32, disc:0xcdd8f0, hor:0x0f1626, zen:0x05080f, fog:0x0a111c, deep:0x030810, shal:0x0a2030, hs:0x1a2742, hg:0x05060a, hi:0.32, ac:0x0a0e18, ai:0.22, exp:1.18, stars:0.95 },
};
function apply_time_of_day(t){ const p=TOD[t]||TOD.day;
	sun_dir.set(p.sun[0],p.sun[1],p.sun[2]).normalize(); sun.position.copy(sun_dir).multiplyScalar(4000); sun.target.position.set(0,0,0);
	sun.color.setHex(p.sunCol); sun.intensity=p.sunI;
	col_sundisc.setHex(p.disc); sky_horizon.setHex(p.hor); sky_zenith.setHex(p.zen); col_deep.setHex(p.deep); col_shallow.setHex(p.shal);
	scene.fog.color.setHex(p.fog); fog_colour.setHex(p.fog);
	hemi.color.setHex(p.hs); hemi.groundColor.setHex(p.hg); hemi.intensity=p.hi; amb.color.setHex(p.ac); amb.intensity=p.ai;
	renderer.toneMappingExposure=p.exp; stars.material.opacity=p.stars;
}

const ocean_mat = new THREE.ShaderMaterial({ fog:false,
	uniforms:{ u_time:{value:0}, u_sun:{value:sun_dir}, u_deep:{value:col_deep}, u_shallow:{value:col_shallow}, u_sky:{value:sky_horizon}, u_fog:{value:sky_horizon}, u_fog_density:{value:0.000075} },
	vertexShader:`uniform float u_time; varying vec3 v_world; varying vec3 v_normal; varying float v_height;
		const vec4 W0=vec4(1.0,0.3,420.0,90.0); const vec4 W1=vec4(-0.7,0.7,230.0,60.0); const vec4 W2=vec4(0.4,-0.9,110.0,38.0); const vec4 W3=vec4(-0.2,0.5,55.0,24.0);
		float wave(vec2 p,vec4 w,float amp,out vec2 grad){ vec2 dir=normalize(w.xy); float k=6.2831853/w.z; float ph=dot(dir,p)*k+u_time*(w.w/w.z); grad=dir*(k*amp*cos(ph)); return amp*sin(ph); }
		void main(){ vec4 wp=modelMatrix*vec4(position,1.0); vec2 xz=wp.xz; vec2 g,gt=vec2(0.0); float h=0.0;
		h+=wave(xz,W0,2.0,g);gt+=g; h+=wave(xz,W1,1.1,g);gt+=g; h+=wave(xz,W2,0.5,g);gt+=g; h+=wave(xz,W3,0.25,g);gt+=g;
		wp.y+=h; v_height=h; v_normal=normalize(vec3(-gt.x,1.0,-gt.y)); v_world=wp.xyz; gl_Position=projectionMatrix*viewMatrix*wp; }`,
	fragmentShader:`uniform vec3 u_sun,u_deep,u_shallow,u_sky,u_fog; uniform float u_fog_density,u_time; varying vec3 v_world; varying vec3 v_normal; varying float v_height;
		vec2 ripple(vec2 p,vec2 dir,float wl,float amp,float spd){ dir=normalize(dir); float k=6.2831853/wl; float ph=dot(dir,p)*k+u_time*spd; return dir*(k*amp*cos(ph)); }
		float hash2(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
		vec3 sky_at(vec3 d){ d=normalize(d); float t=clamp(d.y*1.2,0.0,1.0); vec3 col=mix(u_sky, u_sky*0.55+vec3(0.04,0.10,0.22), pow(t,0.65));
			float s=max(dot(d,normalize(u_sun)),0.0); col+=vec3(1.0,0.95,0.8)*pow(s,500.0)*4.0; col+=vec3(1.0,0.96,0.85)*pow(s,14.0)*0.25; return col; }
		void main(){ vec3 V=normalize(cameraPosition-v_world); vec3 L=normalize(u_sun);
			vec2 xz=v_world.xz; vec2 g=vec2(0.0);
			g+=ripple(xz,vec2(1.0,0.4),26.0,0.06,1.2); g+=ripple(xz,vec2(-0.6,1.0),15.0,0.04,1.7); g+=ripple(xz,vec2(0.8,-0.7),8.0,0.025,2.2);
			vec3 N=normalize(v_normal+vec3(-g.x,0.0,-g.y));
			float fres=0.02+0.98*pow(1.0-max(dot(N,V),0.0),5.0);
			float diff=max(dot(N,L),0.0); vec3 body=mix(u_deep,u_shallow,diff*0.8+0.2);
			vec3 refl=sky_at(reflect(-V,N));
			vec3 col=mix(body,refl,fres);
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
const CLOUDS={
	cumulus:      { base:1400, top:2900, cover:0.50, density:1.05, flat:0.0 },   // broken puffy mid-level
	high_stratus: { base:6000, top:6700, cover:0.30, density:0.45, flat:1.0 },   // thin widespread cirrostratus
	low_stratus:  { base:600,  top:1150, cover:0.18, density:1.35, flat:1.0 },   // low grey overcast
};
function apply_clouds(){ const p=CLOUDS[cfg.clouds]; if(!p) return;
	cloud_mat.uniforms.uBase.value=p.base; cloud_mat.uniforms.uTop.value=p.top;
	cloud_mat.uniforms.uCoverage.value=p.cover; cloud_mat.uniforms.uDensity.value=p.density; cloud_mat.uniforms.uFlat.value=p.flat; }
const cloud_active=()=>cfg.clouds&&cfg.clouds!=="none";

// ---- volumetric clouds: raymarched, composited against scene depth ----
// scene renders to an offscreen target (with depth); a fullscreen pass marches a
// cloud slab and composites over it, stopping at the scene surface for occlusion.
let rt=null; const invVP=new THREE.Matrix4(); const _buf=new THREE.Vector2();
function size_rt(){ renderer.getDrawingBufferSize(_buf); const w=Math.max(2,_buf.x|0),h=Math.max(2,_buf.y|0);
	if(!rt){ rt=new THREE.WebGLRenderTarget(w,h,{depthBuffer:true}); rt.depthTexture=new THREE.DepthTexture(w,h);
		rt.texture.minFilter=THREE.LinearFilter; rt.texture.magFilter=THREE.LinearFilter; }
	else if(rt.width!==w||rt.height!==h){ rt.setSize(w,h); } }
const fs_scene=new THREE.Scene(); const fs_cam=new THREE.OrthographicCamera(-1,1,1,-1,0,1);
const cloud_mat=new THREE.ShaderMaterial({ depthTest:false, depthWrite:false,
	uniforms:{ tScene:{value:null}, tDepth:{value:null}, uCamPos:{value:new THREE.Vector3()}, uInvVP:{value:new THREE.Matrix4()},
		uTime:{value:0}, uSun:{value:sun_dir}, uSunCol:{value:col_sundisc}, uSky:{value:sky_horizon},
		uBase:{value:1400.0}, uTop:{value:3200.0}, uCoverage:{value:0.46}, uDensity:{value:1.0}, uFlat:{value:0.0}, uExposure:{value:1.05} },
	vertexShader:`varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }`,
	fragmentShader:`precision highp float; varying vec2 vUv;
		uniform sampler2D tScene,tDepth; uniform vec3 uCamPos,uSun,uSunCol,uSky; uniform mat4 uInvVP;
		uniform float uTime,uBase,uTop,uCoverage,uDensity,uFlat,uExposure;
		float hash(vec3 p){ p=fract(p*0.3183099+vec3(0.1,0.2,0.3)); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
		float vnoise(vec3 x){ vec3 i=floor(x),f=fract(x); f=f*f*(3.0-2.0*f);
			return mix(mix(mix(hash(i),hash(i+vec3(1.,0.,0.)),f.x),mix(hash(i+vec3(0.,1.,0.)),hash(i+vec3(1.,1.,0.)),f.x),f.y),
			           mix(mix(hash(i+vec3(0.,0.,1.)),hash(i+vec3(1.,0.,1.)),f.x),mix(hash(i+vec3(0.,1.,1.)),hash(i+vec3(1.,1.,1.)),f.x),f.y),f.z); }
		float fbm(vec3 p){ float s=0.0,a=0.5; for(int i=0;i<4;i++){ s+=a*vnoise(p); p=p*2.02+vec3(11.3,7.7,3.1); a*=0.5; } return s; }
		float dens(vec3 p){ float h=clamp((p.y-uBase)/(uTop-uBase),0.0,1.0);
			// flat layers vary mostly horizontally; cumulus has full 3-D billows
			vec3 wp=p*mix(0.0006,0.00035,uFlat); wp.y*=mix(1.0,0.25,uFlat); wp.x+=uTime*0.015; wp.z+=uTime*0.01;
			float n=fbm(wp);
			float hf=mix( smoothstep(0.0,0.15,h)*smoothstep(1.0,0.55,h),   // cumulus: rounded vertical profile
			              smoothstep(0.0,0.25,h)*smoothstep(1.0,0.7,h),    // stratus: thin even slab
			              uFlat );
			return clamp(n*hf-uCoverage,0.0,1.0)*uDensity; }
		vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.0,1.0); }
		void main(){
			float depth=texture2D(tDepth,vUv).r; vec3 scene=texture2D(tScene,vUv).rgb;
			vec4 fp=uInvVP*vec4(vUv*2.0-1.0,1.0,1.0); vec3 ray=normalize(fp.xyz/fp.w-uCamPos);
			float sceneDist=1.0e9;
			if(depth<1.0){ vec4 wp=uInvVP*vec4(vUv*2.0-1.0,depth*2.0-1.0,1.0); sceneDist=length(wp.xyz/wp.w-uCamPos); }
			vec3 outc=scene;
			if(abs(ray.y)>1.0e-4){
				float ta=(uBase-uCamPos.y)/ray.y, tb=(uTop-uCamPos.y)/ray.y;
				float cfar=mix(14000.0,60000.0,uFlat);
				float t0=max(min(ta,tb),0.0), t1=min(max(ta,tb),min(sceneDist,cfar));
				if(t1>t0){ float dt=(t1-t0)/40.0; float t=t0+hash(vec3(vUv*999.0,uTime))*dt; float tr=1.0; vec3 col=vec3(0.0);
					for(int i=0;i<40;i++){ if(t>t1||tr<0.04) break; vec3 pos=uCamPos+ray*t; float d=dens(pos);
						if(d>0.02){ float ld=0.0; vec3 lp=pos; for(int j=0;j<4;j++){ lp+=uSun*90.0; ld+=dens(lp); }
							float light=exp(-ld*1.1); float a=1.0-exp(-d*0.06*dt);
							vec3 shadowC=uSky*0.6+vec3(0.03,0.05,0.08); vec3 sunC=uSunCol*1.25;
							float hfrac=clamp((pos.y-uBase)/(uTop-uBase),0.0,1.0);
							vec3 lit=mix(shadowC,sunC,light)*(0.55+0.45*hfrac);
							col+=tr*a*lit; tr*=1.0-a; }
						t+=dt; }
					outc=scene*tr+col; } }
			outc=aces(outc*uExposure); outc=pow(outc,vec3(1.0/2.2));   // match the off-path tonemap+sRGB
			gl_FragColor=vec4(outc,1.0);
		}` });
fs_scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2,2),cloud_mat));
function render_frame(){
	if(cloud_active()){ size_rt();
		renderer.setRenderTarget(rt); renderer.render(scene,camera); renderer.setRenderTarget(null);
		invVP.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse).invert();
		cloud_mat.uniforms.tScene.value=rt.texture; cloud_mat.uniforms.tDepth.value=rt.depthTexture;
		cloud_mat.uniforms.uCamPos.value.copy(camera.position); cloud_mat.uniforms.uInvVP.value.copy(invVP); cloud_mat.uniforms.uTime.value=sim_time;
		renderer.render(fs_scene,fs_cam);
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
	for(const side of [1,-1]){ const ab=new THREE.Mesh(ab_geo,ab_mat); ab.position.set(-9.3,-0.95,side*0.48); ab.userData.ab=true; g.add(ab); } return g; }   // at the Hornet's twin nozzles (computed from engine-mesh bbox)

// ============================================================================ optional external GLB model (cosmetic only)
// Drop a downloaded glTF/GLB next to this file named "fighter.glb" to replace the procedural airframe.
// Source must be UNCOMPRESSED glTF/GLB (no Draco/Meshopt) — Sketchfab's plain "glTF" download works.
// If the file is missing or the loader CDN is blocked, the procedural jet is used automatically.
const MODEL = { url:"models/fighter.glb", length:18.3, yaw:0, pitch:0, roll:0 };  // length in world units (nose-tail); rot in degrees
// This asset is already nose +X / up +Y, so all rotations are 0. If you swap in a DIFFERENT model and it looks wrong:
// flies BACKWARDS -> yaw 180; on its SIDE / wings vertical -> roll 90 or -90; nose pitched up/down -> pitch 90 or -90; upside down -> roll 180.
const D2R=Math.PI/180;
let model_active=false, jet_proto=null;
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
	g.add(m); }
function apply_model_all(){ apply_model_to(ownship.group); apply_model_to(bandit.group); extras.forEach(s=>apply_model_to(s.group)); }
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
				jet_proto=normalise_model(gltf.scene);
				if(typeof createImageBitmap==="function"){
					const decoded={};   // material name -> THREE.Texture (decoded in-process, no URL/fetch)
					await Promise.all(Object.keys(tex_by_material).map(async name=>{ try{
						const src=tex_by_material[name]; const bmp=await createImageBitmap(new Blob([src.bytes],{type:src.mime}));
						const tex=new THREE.Texture(bmp); tex.flipY=false; tex.colorSpace=THREE.SRGBColorSpace; tex.wrapS=tex.wrapT=THREE.RepeatWrapping; tex.anisotropy=4; tex.needsUpdate=true; decoded[name]=tex;
					}catch(te){ console.warn("[model] texture decode failed for "+name,te&&te.message||te); } }));
					jet_proto.traverse(o=>{ if(o.isMesh&&o.material){ (Array.isArray(o.material)?o.material:[o.material]).forEach(mm=>{ if(decoded[mm.name]){ mm.map=decoded[mm.name]; mm.needsUpdate=true; } }); } });
				}
				model_active=true; apply_model_all();
			}catch(e){ throw new Error("fighter model: failed to process "+tag+": "+(e&&e.message||e)); } },
			err=>{ throw new Error("fighter model: parse failed for "+tag+" ("+((err&&err.message)||"bad glTF")+") — ensure uncompressed glTF/GLB (no Draco)"); });
	}catch(e){ throw new Error("fighter model: not loaded "+tag+" ("+((e&&e.message)||e)+")"); }
}

// ============================================================================ optional external carrier model
const CARRIER_MODEL = { url:"models/carrier.glb", length:300, yaw:90, draft_frac:0.375 };
// Placed so bow -> +X (yaw 90; flip to -90 or +180 if reversed) and the waterline sits at y=0.
// draft_frac = fraction of the keel->deck height kept BELOW water; raise it to sit the hull deeper.
let carrier_model=null; const _ray=new THREE.Raycaster();
function glb_image(p,ti){ if(ti==null||!p.bin||!p.json.textures) return null; const t=p.json.textures[ti]; if(!t) return null;
	const im=p.json.images&&p.json.images[t.source]; if(!im||im.bufferView==null) return null; const bv=p.json.bufferViews[im.bufferView];
	return { bytes:p.bin.slice(bv.byteOffset||0,(bv.byteOffset||0)+bv.byteLength), mime:im.mimeType||"image/png" }; }
async function make_tex(src,srgb){ const bmp=await createImageBitmap(new Blob([src.bytes],{type:src.mime}));
	const t=new THREE.Texture(bmp); t.flipY=false; t.colorSpace=srgb?THREE.SRGBColorSpace:THREE.LinearSRGBColorSpace; t.wrapS=t.wrapT=THREE.RepeatWrapping; t.anisotropy=4; t.needsUpdate=true; return t; }
function model_y_stats(grp){ grp.updateMatrixWorld(true); const v=new THREE.Vector3(); let mn=Infinity,mx=-Infinity; const ys=[];
	grp.traverse(o=>{ if(o.isMesh&&o.geometry&&o.geometry.attributes.position){ const pa=o.geometry.attributes.position; o.updateWorldMatrix(true,false);
		for(let i=0;i<pa.count;i++){ v.fromBufferAttribute(pa,i).applyMatrix4(o.matrixWorld); if(v.y<mn)mn=v.y; if(v.y>mx)mx=v.y; ys.push(v.y); } } });
	const NB=80,w=(mx-mn)/NB||1,h=new Array(NB).fill(0); for(const y of ys){ let b=Math.floor((y-mn)/w); if(b<0)b=0; if(b>=NB)b=NB-1; h[b]++; }
	let pk=0; for(let i=0;i<NB;i++) if(h[i]>h[pk])pk=i; return { keelY:mn, topY:mx, deckY:mn+(pk+0.5)*w }; }
function deck_y_at(grp,x,z,fallback){ _ray.set(new THREE.Vector3(x,5000,z), new THREE.Vector3(0,-1,0)); const hits=_ray.intersectObject(grp,true); return hits.length?hits[0].point.y:fallback; }
// Place ownship on the configured catapult (deck height found by raycast when a model carrier is present).
let deck_edit=false;
function place_on_cat(){ const hd=cfg.cat_h*D2R; const fwd=new THREE.Vector3(Math.cos(hd),0,-Math.sin(hd));
	const dy=carrier_model?deck_y_at(carrier_model,cfg.cat_x,cfg.cat_z,CARRIER.deckY):CARRIER.deckY;
	ownship.pos.set(cfg.cat_x, dy+cfg.cat_dy, cfg.cat_z); ownship.fwd.copy(fwd); ownship.vel_dir.copy(fwd);
	const r=new THREE.Vector3().crossVectors(fwd,world_up).normalize(), u=new THREE.Vector3().crossVectors(r,fwd).normalize();
	ownship.q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(fwd,u,r)); }
function edit_cat(dt){ const mv=dt*1.2, rot=dt*2.5; let ch=false;   // 10x finer positional nudges + heading for precise alignment
	if(keys.has("KeyI")){ cfg.cat_x+=mv; ch=true; } if(keys.has("KeyK")){ cfg.cat_x-=mv; ch=true; }     // fore / aft
	if(keys.has("KeyJ")){ cfg.cat_z-=mv; ch=true; } if(keys.has("KeyL")){ cfg.cat_z+=mv; ch=true; }     // port / starboard
	if(keys.has("BracketRight")){ cfg.cat_dy+=mv*0.5; ch=true; } if(keys.has("BracketLeft")){ cfg.cat_dy-=mv*0.5; ch=true; }  // ] up / [ down
	if(keys.has("KeyU")){ cfg.cat_h+=rot; ch=true; } if(keys.has("KeyO")){ cfg.cat_h-=rot; ch=true; }   // rotate heading
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
			CARRIER.deckY=deck_y_at(grp, 70, -6, st.deckY-waterline);                                   // deck height at the catapult spot
			if(ownship.on_cat){ place_on_cat(); }
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
function pool(max){ return { px:new Float32Array(max),py:new Float32Array(max),pz:new Float32Array(max), vx:new Float32Array(max),vy:new Float32Array(max),vz:new Float32Array(max),
	life:new Float32Array(max),ttl:new Float32Array(max), r:new Float32Array(max),g:new Float32Array(max),b:new Float32Array(max), active:new Uint8Array(max), max, next:0 }; }
function pool_spawn(p){ for(let i=0;i<p.max;i++){ const k=(p.next+i)%p.max; if(!p.active[k]){ p.next=(k+1)%p.max; p.active[k]=1; return k; } } return -1; }
const TR_MAX=4000,FL_MAX=2500,SM_MAX=3000;
const tracers=pool(TR_MAX),flares=pool(FL_MAX),smoke=pool(SM_MAX);
const tr_pts=make_points(TR_MAX,7,true,glow), fl_pts=make_points(FL_MAX,26,true,glow), sm_pts=make_points(SM_MAX,70,false,soft);
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
	const rps=100*cfg.fire_rate; gun[key]=(gun[key]||0)+rps*dt;
	while(gun[key]>=1){ gun[key]-=1; if(st.rounds!==undefined){ if(st.rounds<=0) break; st.rounds--; }
		const k=pool_spawn(tracers); if(k<0) break; const sp=body_offset(st,6.5,0.0,1.2);
		tracers.px[k]=sp.x;tracers.py[k]=sp.y;tracers.pz[k]=sp.z; const spread=0.004;
		tracers.vx[k]=st.fwd.x*muzzle+(Math.random()-0.5)*spread*muzzle+st.velx;
		tracers.vy[k]=st.fwd.y*muzzle+(Math.random()-0.5)*spread*muzzle+st.vely;
		tracers.vz[k]=st.fwd.z*muzzle+(Math.random()-0.5)*spread*muzzle+st.velz;
		const tr=(Math.floor(gun[key+"_n"]||0)%4)===0; gun[key+"_n"]=(gun[key+"_n"]||0)+1; tracers.ttl[k]=tracers.life[k]=2.4;
		if(tr){tracers.r[k]=1.6;tracers.g[k]=0.9;tracers.b[k]=0.3;} else {tracers.r[k]=0.5;tracers.g[k]=0.35;tracers.b[k]=0.2;} } }
const flare_timer={bandit:4.5};
function dispense_flares(st){ for(let i=0;i<36;i++){ const k=pool_spawn(flares); if(k<0) break; const sp=local_offset(st,-2,-0.3,0);
	flares.px[k]=sp.x;flares.py[k]=sp.y;flares.pz[k]=sp.z; flares.vx[k]=st.velx*0.5+(Math.random()-0.5)*40; flares.vy[k]=st.vely*0.5-Math.random()*25; flares.vz[k]=st.velz*0.5+(Math.random()-0.5)*40;
	flares.ttl[k]=flares.life[k]=3.5+Math.random()*1.5; flares.r[k]=2.0;flares.g[k]=1.2;flares.b[k]=0.5; } }
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
	break_t:0, break_dir:new THREE.Vector3(1,0,0), circle_phase:Math.random()*Math.PI*2, circle_radius:1500+Math.random()*2500, circle_alt:1600+Math.random()*2200, velx:0,vely:0,velz:0 }; }
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
const ownship=make_state(new THREE.Vector3(70,CARRIER.deckY+1.8,-6),new THREE.Vector3(1,0,0),0);
ownship.player=true; ownship.q=new THREE.Quaternion(); ownship.up=new THREE.Vector3(0,1,0); ownship.right=new THREE.Vector3(0,0,1);
ownship.vel_dir=ownship.fwd.clone(); ownship.throttle=0.85; ownship.rounds=600; ownship.msl=4; ownship.cm=60; ownship.aoa=0; ownship.gload=1;
ownship.on_cat=true; ownship.launching=false; ownship.launch_dist=0;
// init quaternion from initial fwd
(()=>{ const r=new THREE.Vector3().crossVectors(ownship.fwd,world_up).normalize(); const u=new THREE.Vector3().crossVectors(r,ownship.fwd).normalize();
	ownship.q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(ownship.fwd,u,r)); })();
const bandit=make_state(new THREE.Vector3(3000,2400,-1000),new THREE.Vector3(-0.3,0,1),195);
ownship.group=make_jet(0x9aa6b2); bandit.group=make_jet(0xb04a3a); scene.add(ownship.group,bandit.group);

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
	const t=new THREE.CanvasTexture(c); t.colorSpace=THREE.SRGBColorSpace; t.anisotropy=4; return t; }
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
const airports=[]; const map_islands=[];
function generate_world(){
	const rng=mulberry32(1337);
	const islands=[];
	const far=(x,z,min,r,sep)=>{ if(Math.hypot(x,z)<min) return false; for(const o of islands){ if(Math.hypot(x-o.x,z-o.z)<o.r+r+sep) return false; } return true; };
	const mk=(x,z,r,flat,h)=>({x,z,r,h,flat,a1:(flat?0.10:0.12)+rng()*0.08,a2:(flat?0.08:0.10)+rng()*0.06,a3:0.05+rng()*0.05,p1:rng()*6.28,p2:rng()*6.28,p3:rng()*6.28,hd:rng()*Math.PI});
	// airport islands: compact, tall plateaus (mesas) that clearly rise from the sea, flat-topped for the runway
	const big=[];
	{ const ang=rng()*6.28, dist=10000+rng()*4000, r=2600+rng()*900; const o=mk(Math.cos(ang)*dist,Math.sin(ang)*dist,r,true,210); big.push(o); islands.push(o); }
	let tries=0; while(big.length<4 && tries++<800){ const x=(rng()*2-1)*46000, z=(rng()*2-1)*46000, r=2600+rng()*1400;
		if(!far(x,z,14000,r,5000)) continue; const o=mk(x,z,r,true,210); big.push(o); islands.push(o); }
	// scattered green islands: spread proportionally, no overlaps
	for(let i=0;i<40;i++){ let placed=false,t=0; while(!placed&&t++<80){ const x=(rng()*2-1)*60000, z=(rng()*2-1)*60000, r=1200+rng()*4800;
		if(!far(x,z,8000,r,3000)) continue; islands.push(mk(x,z,r,false,120+rng()*700)); placed=true; } }

	// build merged island geometry (flat-shaded, vertex-coloured)
	const P=[],N=[],C=[];
	const coastR=(o,ang)=>o.r*THREE.MathUtils.clamp(0.72+o.a1*Math.sin(ang*2+o.p1)+o.a2*Math.sin(ang*3+o.p2)+o.a3*Math.sin(ang*5+o.p3),0.5,1.25);
	const hgt=(d,cr,o)=>{ if(d>=cr) return Math.max(-6,-6*(d-cr)/(0.12*cr)); const t=d/cr;
		return o.flat ? (t<0.80 ? o.h : o.h*Math.pow(1-(t-0.80)/0.20,1.4)) : o.h*Math.pow(Math.cos(t*Math.PI/2),1.3); };
	const colf=(h,o)=>{ if(h<2.5) return [0.82,0.74,0.55]; const g=THREE.MathUtils.clamp((h-2.5)/Math.max(8,o.h*0.6),0,1); return [0.16+0.16*g,0.40+0.15*g,0.15+0.10*g]; };
	const pushv=(p,n,c)=>{ P.push(p[0],p[1],p[2]); N.push(n[0],n[1],n[2]); C.push(c[0],c[1],c[2]); };
	const tri=(a,b,c,ca,cb,cc)=>{ const ux=b[0]-a[0],uy=b[1]-a[1],uz=b[2]-a[2],vx=c[0]-a[0],vy=c[1]-a[1],vz=c[2]-a[2];
		let nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx; const l=Math.hypot(nx,ny,nz)||1; nx/=l;ny/=l;nz/=l; if(ny<0){nx=-nx;ny=-ny;nz=-nz;}
		pushv(a,[nx,ny,nz],ca); pushv(b,[nx,ny,nz],cb); pushv(c,[nx,ny,nz],cc); };
	const NS=28,NR=8;
	for(const o of islands){ const grid=[];
		for(let i=0;i<=NR;i++){ const row=[]; for(let j=0;j<=NS;j++){ const ang=j/NS*Math.PI*2; const cr=coastR(o,ang); const d=(i/NR)*cr*1.1; const h=hgt(d,cr,o);
			row.push({p:[o.x+Math.cos(ang)*d,h,o.z+Math.sin(ang)*d],c:colf(h,o)}); } grid.push(row); }
		for(let i=0;i<NR;i++) for(let j=0;j<NS;j++){ const a=grid[i][j],b=grid[i+1][j],c=grid[i+1][j+1],e=grid[i][j+1];
			tri(a.p,b.p,c.p,a.c,b.c,c.c); tri(a.p,c.p,e.p,a.c,c.c,e.c); } }
	const geo=new THREE.BufferGeometry();
	geo.setAttribute("position",new THREE.BufferAttribute(new Float32Array(P),3));
	geo.setAttribute("normal",new THREE.BufferAttribute(new Float32Array(N),3));
	geo.setAttribute("color",new THREE.BufferAttribute(new Float32Array(C),3));
	const islMesh=new THREE.Mesh(geo,new THREE.MeshStandardMaterial({vertexColors:true,roughness:0.95,metalness:0.0,flatShading:true,side:THREE.DoubleSide}));
	islMesh.receiveShadow=true; scene.add(islMesh);

	// airports on the big islands
	for(const o of big) build_airport(o);
	for(const o of islands) map_islands.push({x:o.x,z:o.z,r:o.r,flat:o.flat,a1:o.a1,a2:o.a2,a3:o.a3,p1:o.p1,p2:o.p2,p3:o.p3});
}
function runway_texture(nTop,nBottom){ const c=document.createElement("canvas"); c.width=128; c.height=1024; const x=c.getContext("2d");
	x.fillStyle="#26282b"; x.fillRect(0,0,128,1024);
	x.fillStyle="#d8d8d8"; x.fillRect(8,0,4,1024); x.fillRect(116,0,4,1024);                         // side stripes
	x.fillStyle="#eaeaea"; for(let y=120;y<1024-120;y+=56){ x.fillRect(62,y,4,30); }                 // centreline dashes
	const keys=(yc,dir)=>{ x.fillStyle="#eaeaea"; for(let k=-3;k<=3;k++){ x.fillRect(64+k*9-3,yc,6,46*dir); } };
	keys(20,1); keys(1004,-1);                                                                        // threshold piano keys
	x.fillStyle="#eaeaea"; x.fillRect(40,150,12,60); x.fillRect(76,150,12,60); x.fillRect(40,814,12,60); x.fillRect(76,814,12,60); // aiming points
	// each number reads upright to the aircraft approaching that end (glyph top points down-runway toward the centre)
	x.fillStyle="#f2f2f2"; x.font="bold 52px sans-serif"; x.textAlign="center"; x.textBaseline="middle";
	x.save(); x.translate(64,92);  x.rotate(Math.PI); x.fillText(String(nTop).padStart(2,"0"),0,0); x.restore();      // +y end
	x.save(); x.translate(64,932);                    x.fillText(String(nBottom).padStart(2,"0"),0,0); x.restore();   // -y end
	const t=new THREE.CanvasTexture(c); t.colorSpace=THREE.SRGBColorSpace; t.anisotropy=4; return t; }
function build_airport(o){
	const L=2400, W=60, y=o.h+1.5, H=o.hd;                                   // H = compass heading (rad) you fly taking off / landing in +fwd
	const up=new THREE.Vector3(0,1,0);
	const fwd=new THREE.Vector3(Math.sin(H),0,-Math.cos(H));                 // world dir whose compass heading is H
	const right=new THREE.Vector3().crossVectors(fwd,up);                    // to the right of the landing direction
	const hdeg=((H*180/Math.PI)%360+360)%360;
	const nPlus=Math.round(hdeg/10)%36||36;                                  // shown to aircraft landing/​departing on heading H
	const nMinus=Math.round(((hdeg+180)%360)/10)%36||36;                     // the reciprocal end
	// runway surface (local +y == fwd == the +y/canvas-top end; nMinus is painted there, nPlus at the -y end)
	const rmesh=new THREE.Mesh(new THREE.PlaneGeometry(W,L),new THREE.MeshStandardMaterial({map:runway_texture(nMinus,nPlus),roughness:0.95,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2}));
	rmesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right,fwd,up));
	rmesh.position.set(o.x,y,o.z); rmesh.receiveShadow=true; scene.add(rmesh);
	// control tower (concrete base + glass cab + roof), offset to the side near midfield
	const tp=new THREE.Vector3(o.x,0,o.z).addScaledVector(right,110).addScaledVector(fwd,150);
	const tg=[]; tg.push(new THREE.CylinderGeometry(6,8,34,12).translate(tp.x,o.h+17,tp.z));
	const tower=new THREE.Mesh(merge_geometries(tg),new THREE.MeshStandardMaterial({color:0xbfc4c8,roughness:0.8})); tower.castShadow=true; scene.add(tower);
	const cab=new THREE.Mesh(new THREE.CylinderGeometry(9,7.5,7,12),new THREE.MeshStandardMaterial({color:0x1c2024,metalness:0.4,roughness:0.4})); cab.position.set(tp.x,o.h+37,tp.z); scene.add(cab);
	const roof=new THREE.Mesh(new THREE.CylinderGeometry(10,10,1.5,12),new THREE.MeshStandardMaterial({color:0x44494e})); roof.position.set(tp.x,o.h+41,tp.z); scene.add(roof);
	// PAPI on BOTH ends, on the left as seen by the approaching aircraft, each visible only within its approach beam
	const setAng=[3.5,3.167,2.833,2.5];
	function build_papi(tdz,leftVec,beam){ const papi=[],gpos=[],gcol=[];
		for(let i=0;i<4;i++){ const p=tdz.clone().addScaledVector(leftVec,(W/2+25)+i*22);
			const post=new THREE.Mesh(new THREE.BoxGeometry(2,7,2),new THREE.MeshStandardMaterial({color:0x2a2d31})); post.position.set(p.x,o.h+3.5,p.z); scene.add(post);
			const m=new THREE.Mesh(new THREE.BoxGeometry(14,7,8),new THREE.MeshBasicMaterial({color:0x23262b})); m.position.set(p.x,o.h+9,p.z); scene.add(m);
			gpos.push(p.x,o.h+9,p.z); gcol.push(1,1,1); papi.push({mesh:m,x:p.x,y:o.h+9,z:p.z,set:setAng[i]}); }
		const pg=new THREE.BufferGeometry(); pg.setAttribute("position",new THREE.BufferAttribute(new Float32Array(gpos),3)); pg.setAttribute("color",new THREE.BufferAttribute(new Float32Array(gcol),3));
		const papiPts=new THREE.Points(pg,new THREE.PointsMaterial({size:120,map:glow,vertexColors:true,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,sizeAttenuation:true})); papiPts.frustumCulled=false; papiPts.visible=false; scene.add(papiPts);
		return {papi,papiPts,cx:tdz.x,cz:tdz.z,bx:beam.x,bz:beam.z}; }
	const thrP=new THREE.Vector3(o.x,y,o.z).addScaledVector(fwd,-L/2);        // -y end: approach for heading H, fly +fwd, left=-right, beam back along -fwd
	const thrM=new THREE.Vector3(o.x,y,o.z).addScaledVector(fwd, L/2);        // +y end: approach for heading H+180, fly -fwd, left=+right, beam along +fwd
	const papis=[ build_papi(thrP.clone().addScaledVector(fwd,320), right.clone().multiplyScalar(-1), fwd.clone().multiplyScalar(-1)),
	              build_papi(thrM.clone().addScaledVector(fwd,-320), right.clone(),                    fwd.clone()) ];
	const takeoff=thrP.clone().addScaledVector(fwd,55);                       // at the start of the runway, before the numbers, rolling toward +fwd
	airports.push({x:o.x,z:o.z,papis,dir:fwd,sy:o.h+2.2,start:{x:takeoff.x,y:o.h+2.2,z:takeoff.z}});
}
function update_papi(p){ for(const ap of airports){ for(const set of ap.papis){
	const dx=p.x-set.cx, dz=p.z-set.cz; const horiz=Math.hypot(dx,dz);
	// realistic beam: visible only ahead of the lights, within ~±18° azimuth and out to ~16 km
	const vis = horiz>30 && horiz<16000 && (dx*set.bx+dz*set.bz)/horiz > 0.95;
	set.papiPts.visible=vis; const col=set.papiPts.geometry.attributes.color;
	for(let i=0;i<set.papi.length;i++){ const L=set.papi[i];
		if(!vis){ L.mesh.material.color.setHex(0x23262b); continue; }
		const h2=Math.hypot(p.x-L.x,p.z-L.z)||1; const white=(Math.atan2(p.y-L.y,h2)*180/Math.PI)>=L.set;
		L.mesh.material.color.setHex(white?0xffffff:0xff2200); col.array[i*3]=1; col.array[i*3+1]=white?1:0.12; col.array[i*3+2]=white?1:0.03; }
	if(vis) col.needsUpdate=true;
} } }
generate_world();
const extras=[];
function sync_extras(n){ while(extras.length<n){ const a=Math.random()*Math.PI*2,r=2000+Math.random()*4000;
	const st=make_state(new THREE.Vector3(Math.cos(a)*r,1600+Math.random()*2400,Math.sin(a)*r),new THREE.Vector3(-Math.sin(a),0,Math.cos(a)),170+Math.random()*60);
	st.group=make_jet(0x7f8a96); scene.add(st.group); extras.push(st); if(model_active) apply_model_to(st.group); }
	while(extras.length>n){ const st=extras.pop(); scene.remove(st.group); st.group.traverse(o=>{ if(o.isMesh&&o.material&&o.material.dispose)o.material.dispose(); }); } }

// ---- input ----
const input={ pitch:0, roll:0, yaw:0, guns:false };
const keys=new Set();
let cam_az=0, cam_el=0.22, cam_dist=24;   // chase view: orbit around the aircraft
let cat_saved_t=0;                              // "deck position saved" flash timer
addEventListener("keydown",e=>{ if(["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"," "].includes(e.key)) e.preventDefault();
	const k=e.code; if(!keys.has(k)){ // edge-triggered actions
		if(k==="Space" && ownship.on_cat){ start_launch(); }
		if(k==="KeyR" && !ownship.on_cat && !ownship.launching && cfg.missiles && ownship.msl>0){ if(launch_missile(ownship,has_enemy?bandit:null)) ownship.msl--; }
		if(k==="KeyF" && cfg.flares && ownship.cm>0){ dispense_flares(ownship); ownship.cm--; }
		if(k==="KeyX"){ ownship.rounds=600; ownship.msl=4; ownship.cm=60; }
		if(k==="KeyV"){ const order=["hud","chase","padlock","action"]; cfg.view=order[(order.indexOf(cfg.view)+1)%order.length]; }
		if(k==="KeyM"){ map_on=!map_on; map_el.style.display=map_on?"block":"none"; if(map_on) map_resize(); }
		if(k==="KeyP" && !MULTIPLAYER){ pause_toggle=!pause_toggle; }
		if(k==="KeyH"){ cfg.help=!cfg.help; help_el.style.display=cfg.help?"":"none"; }
		// G key disabled. Alignment mode (deck_edit / edit_cat / overlay) is retained for future use — e.g. marking arrestor cable positions. To re-enable: if(k==="KeyG" && cfg.start==="carrier"){ deck_edit=!deck_edit; if(deck_edit){ enter_align(); } else { save_cfg(); cat_saved_t=1.8; } }
		if(k==="Escape" && running){ running=false; if(onExit) onExit(); } }
	keys.add(k); }, { signal });
addEventListener("keyup",e=>keys.delete(e.code),{ signal });
addEventListener("blur",()=>keys.clear(),{ signal });
function read_input(dt){
	let pitch=0,roll=0,yaw=0;
	const shift=keys.has("ShiftLeft")||keys.has("ShiftRight");
	const camOrbit=cfg.view==="chase"&&shift&&(keys.has("ArrowLeft")||keys.has("ArrowRight"));   // Shift+←/→ orbit camera
	if(keys.has("KeyS")||keys.has("ArrowDown")) pitch+=1;   // pull / nose up
	if(keys.has("KeyW")||keys.has("ArrowUp")) pitch-=1;
	if(keys.has("KeyD")||(!camOrbit&&keys.has("ArrowRight"))) roll+=1;
	if(keys.has("KeyA")||(!camOrbit&&keys.has("ArrowLeft"))) roll-=1;
	if(keys.has("KeyE")) yaw+=1; if(keys.has("KeyQ")) yaw-=1;
	input.pitch=THREE.MathUtils.clamp(pitch,-1,1)*(cfg.invert?-1:1);
	input.roll=THREE.MathUtils.clamp(roll,-1,1); input.yaw=THREE.MathUtils.clamp(yaw,-1,1);
	input.guns=keys.has("Space");
	if(shift && !camOrbit) ownship.throttle=Math.min(1,ownship.throttle+dt*0.5);
	if(keys.has("ControlLeft")||keys.has("ControlRight")) ownship.throttle=Math.max(0,ownship.throttle-dt*0.5);
}

let sim_time=0;
const _q=new THREE.Quaternion(), _fwd=new THREE.Vector3(), _up=new THREE.Vector3(), _right=new THREE.Vector3();
function start_launch(){ if(!ownship.on_cat) return; ownship.on_cat=false; ownship.launching=true; ownship.launch_dist=0; ownship.throttle=Math.max(ownship.throttle,0.9); }
function fly_player(dt){
	read_input(dt);
	ownship.fwd.set(1,0,0).applyQuaternion(ownship.q); ownship.up.set(0,1,0).applyQuaternion(ownship.q); ownship.right.set(0,0,1).applyQuaternion(ownship.q);
	if(ownship.on_cat){
		if(deck_edit) edit_cat(dt);
		ownship.speed=0; ownship.velx=ownship.vely=ownship.velz=0; ownship.aoa=0; ownship.gload=1; ownship.vel_dir.copy(ownship.fwd);
		ownship.group.quaternion.copy(ownship.q); ownship.group.position.copy(ownship.pos); return;
	}
	if(ownship.launching){
		ownship.speed=Math.min(82, ownship.speed+78*dt); ownship.vel_dir.copy(ownship.fwd);
		ownship.velx=ownship.fwd.x*ownship.speed; ownship.vely=ownship.fwd.y*ownship.speed; ownship.velz=ownship.fwd.z*ownship.speed;
		ownship.pos.addScaledVector(ownship.fwd,ownship.speed*dt); ownship.launch_dist+=ownship.speed*dt; ownship.aoa=0; ownship.gload=1;
		ownship.group.quaternion.copy(ownship.q); ownship.group.position.copy(ownship.pos);
		if(ownship.launch_dist>85) ownship.launching=false; return;
	}
	const s=cfg.sens; const roll_rate=3.0*s, pitch_rate=1.3*s, yaw_rate=0.6*s;
	_q.setFromAxisAngle(ownship.right, input.pitch*pitch_rate*dt); ownship.q.premultiply(_q);
	_q.setFromAxisAngle(ownship.up, -input.yaw*yaw_rate*dt); ownship.q.premultiply(_q);
	_q.setFromAxisAngle(ownship.fwd, input.roll*roll_rate*dt); ownship.q.premultiply(_q);
	ownship.q.normalize();
	ownship.fwd.set(1,0,0).applyQuaternion(ownship.q); ownship.up.set(0,1,0).applyQuaternion(ownship.q); ownship.right.set(0,0,1).applyQuaternion(ownship.q);
	// coordinated turn: bank angle drives a level-turn heading change (omega = g·tan φ / V); velocity then tracks the nose
	const bank=Math.atan2(-ownship.right.y, Math.max(0.25,ownship.up.y));
	const omega=THREE.MathUtils.clamp(9.81*Math.tan(THREE.MathUtils.clamp(bank,-1.3,1.3))/Math.max(ownship.speed,70),-0.7,0.7);
	_q.setFromAxisAngle(world_up,-omega*dt); ownship.q.premultiply(_q); ownship.q.normalize();
	ownship.fwd.set(1,0,0).applyQuaternion(ownship.q); ownship.up.set(0,1,0).applyQuaternion(ownship.q); ownship.right.set(0,0,1).applyQuaternion(ownship.q);
	const target=120+ownship.throttle*200; const pitch_ang=Math.asin(THREE.MathUtils.clamp(ownship.fwd.y,-1,1));
	ownship.speed+=(target-ownship.speed)*Math.min(1,dt*0.5); ownship.speed-=9.81*Math.sin(pitch_ang)*dt*1.6; ownship.speed=THREE.MathUtils.clamp(ownship.speed,55,360);
	ownship.vel_dir.lerp(ownship.fwd,Math.min(1,dt*2.5)).normalize();
	ownship.velx=ownship.vel_dir.x*ownship.speed; ownship.vely=ownship.vel_dir.y*ownship.speed; ownship.velz=ownship.vel_dir.z*ownship.speed;
	ownship.aoa=THREE.MathUtils.radToDeg(ownship.fwd.angleTo(ownship.vel_dir));
	ownship.gload=1+Math.abs(input.pitch)*(ownship.speed/90);
	ownship.pos.addScaledVector(ownship.vel_dir,ownship.speed*dt);
	if(ownship.pos.y<8){ ownship.pos.y=8; if(ownship.vel_dir.y<0){ ownship.vel_dir.y=0; ownship.vel_dir.normalize(); } }
	ownship.group.quaternion.copy(ownship.q); ownship.group.position.copy(ownship.pos);
}
function fly_bandit(dt){
	bandit.break_t-=dt;
	const to_own=ownship.pos.clone().sub(bandit.pos); const rng=to_own.length();
	const threatened = rng<1800 && ownship.fwd.dot(to_own.clone().multiplyScalar(-1).normalize())>0.5; // ownship pointing at bandit from behind-ish
	if(bandit.break_t<=0){ const a=Math.random()*Math.PI*2; bandit.break_dir.set(Math.cos(a),0,Math.sin(a)); bandit.break_t=threatened?(2+Math.random()*2):(5+Math.random()*5);
		if(threatened && cfg.flares) dispense_flares(bandit); }
	const b=bandit.break_dir.clone(); b.x+=Math.sin(sim_time*0.7)*0.6; b.z+=Math.cos(sim_time*0.9)*0.6;
	if(bandit.pos.length()>5500) b.addScaledVector(bandit.pos.clone().negate().setY(0).normalize(),1.2);
	hold_altitude(b,bandit,1400,3600); steer(bandit,b,dt,threatened?0.5:0.34,1.2); apply_orientation(bandit);
	// bandit guns at ownship
	fire_gun(bandit,ownship,"bandit",dt);
}
function step_world(dt){ sim_time+=dt;
	fly_player(dt); if(has_enemy) fly_bandit(dt);
	for(const st of extras){ st.circle_phase+=dt*(st.speed/st.circle_radius);
		const tgt=new THREE.Vector3(Math.cos(st.circle_phase)*st.circle_radius,st.circle_alt+Math.sin(st.circle_phase*0.5)*200,Math.sin(st.circle_phase)*st.circle_radius);
		steer(st,tgt.sub(st.pos),dt,0.3,1.0); apply_orientation(st); }
	const flick=0.6+Math.random()*0.4; const set_ab=(g,on)=>g.children.forEach(c=>{ if(c.userData.ab){ c.visible=on; c.scale.z=flick; c.material.opacity=on?0.55+Math.random()*0.35:0; } });
	set_ab(ownship.group,cfg.afterburner&&ownship.throttle>0.6); set_ab(bandit.group,cfg.afterburner); extras.forEach(st=>set_ab(st.group,cfg.afterburner));
	// player guns
	fire_gun(ownship,bandit,"own",dt,input.guns&&!ownship.on_cat&&!ownship.launching);
	update_pool_ballistic(tracers,dt,9.8,0); update_missiles(dt);
	update_pool_ballistic(flares,dt,9.8,0.985); update_pool_ballistic(smoke,dt,-0.5,0.96);
	live_particles=flush_points(tracers,tr_pts)+flush_points(flares,fl_pts)+flush_points(smoke,sm_pts);
	tr_pts.visible=cfg.tracers; fl_pts.visible=cfg.flares;
	update_papi(ownship.pos);
}

function reset_ownship(){
	ownship.q.set(0,0,0,1); ownship.fwd.set(1,0,0); ownship.up.set(0,1,0); ownship.right.set(0,0,1); ownship.vel_dir.set(1,0,0);
	ownship.rounds=600; ownship.msl=4; ownship.cm=60; ownship.aoa=0; ownship.gload=1; ownship.launching=false; ownship.launch_dist=0; ownship.on_cat=false;
	if(cfg.start==="carrier"){ ownship.speed=0; ownship.throttle=0.85; ownship.on_cat=true; place_on_cat(); }
	else if(cfg.start==="runway" && airports.length){ const ap=airports[0];          // start on the near airport runway
		ownship.pos.set(ap.start.x,ap.start.y,ap.start.z); ownship.fwd.copy(ap.dir).normalize(); ownship.speed=0; ownship.throttle=0.85;
		const r=new THREE.Vector3().crossVectors(ownship.fwd,world_up).normalize(); const u=new THREE.Vector3().crossVectors(r,ownship.fwd).normalize();
		ownship.q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(ownship.fwd,u,r)); ownship.vel_dir.copy(ownship.fwd); }
	else { ownship.pos.set(-700,1400,200); ownship.speed=220; ownship.throttle=0.8; }
	ownship.group.quaternion.copy(ownship.q); ownship.group.position.copy(ownship.pos);
	bandit.pos.set(3000,2400,-1000); bandit.fwd.set(-0.3,0,1).normalize(); bandit.break_t=0; bandit.speed=195;
}

// ============================================================================ camera
function update_camera(dt){
	const editing = deck_edit && ownship.on_cat;
	ownship.group.visible=(cfg.view!=="hud") || editing;
	if(cfg.view==="chase"){   // orbit input around the aircraft
		const shift=keys.has("ShiftLeft")||keys.has("ShiftRight"); const ar=dt*0.9, zr=dt*40;
		const da=(keys.has("ArrowRight")?1:0)-(keys.has("ArrowLeft")?1:0);   // Shift+←/→ azimuth
		if(shift) cam_az+=da*ar;
		const de=(keys.has("Period")?1:0)-(keys.has("Comma")?1:0);          // . up / , down  (no shift)
		cam_el=THREE.MathUtils.clamp(cam_el+de*ar,-1.2,1.45);
		if(keys.has("Minus")) cam_dist=Math.min(140,cam_dist+zr);           // - back
		if(keys.has("Equal")) cam_dist=Math.max(8,cam_dist-zr);             // = in
	}
	if(cfg.view==="hud"){ const eye=body_offset(ownship,3.0,0.6,0); camera.position.copy(eye); camera.up.copy(ownship.up);
		camera.lookAt(eye.clone().addScaledVector(ownship.fwd,200)); }
	else if(cfg.view==="padlock"){ const eye=body_offset(ownship,-12,4,0); camera.position.copy(eye); camera.up.set(0,1,0); camera.lookAt(bandit.pos); }
	else if(cfg.view==="chase"){   // orbit around the aircraft
		const ce=Math.cos(cam_el),se=Math.sin(cam_el),ca=Math.cos(cam_az),sa=Math.sin(cam_az);
		const tgt=ownship.pos.clone().addScaledVector(ownship.up,1.2);
		const off=ownship.fwd.clone().multiplyScalar(-ce*ca).addScaledVector(ownship.right,ce*sa).addScaledVector(ownship.up,se).multiplyScalar(cam_dist);
		camera.position.lerp(tgt.clone().add(off),Math.min(1,dt*6)); camera.up.set(0,1,0); camera.lookAt(tgt); }
	else { const mid=ownship.pos.clone().add(bandit.pos).multiplyScalar(0.5); const r=Math.max(ownship.pos.distanceTo(bandit.pos)*1.3,600); const a=sim_time*0.15;
		camera.position.set(mid.x+Math.cos(a)*r,mid.y+r*0.35,mid.z+Math.sin(a)*r); camera.up.set(0,1,0); camera.lookAt(mid); }
}

// ============================================================================ HUD (2D canvas overlay)
const hctx=hud.getContext("2d");
let HW=innerWidth, HH=innerHeight;
function hud_resize(){ HW=innerWidth; HH=innerHeight; const dpr=Math.min(devicePixelRatio||1,2);
	hud.width=HW*dpr; hud.height=HH*dpr; hud.style.width=HW+"px"; hud.style.height=HH+"px"; hctx.setTransform(dpr,0,0,dpr,0,0); }
const _p=new THREE.Vector3();
function proj_point(v){ _p.copy(v).project(camera); if(_p.z>1) return null; return [(_p.x*0.5+0.5)*HW,(-_p.y*0.5+0.5)*HH]; }
function proj_dir(d){ _p.copy(camera.position).addScaledVector(d,1000).project(camera); if(_p.z>1) return null; return [(_p.x*0.5+0.5)*HW,(-_p.y*0.5+0.5)*HH]; }
const GR="#15b85f", AM="#ffc14d";

// ---- full-screen map (M) — aircraft, islands, airports, carrier; never bandits ----
const map_el=map; const mctx=map_el.getContext("2d"); let map_on=false;
const help_el=help;
function map_resize(){ const dpr=Math.min(devicePixelRatio||1,2); map_el.width=innerWidth*dpr; map_el.height=innerHeight*dpr; map_el.style.width=innerWidth+"px"; map_el.style.height=innerHeight+"px"; mctx.setTransform(dpr,0,0,dpr,0,0); }
function draw_map(){ const W=innerWidth,H=innerHeight; mctx.clearRect(0,0,W,H);
	const cxp=W/2, cyp=H/2, worldR=70000, s=Math.min(W,H)*0.46/worldR;
	const X=x=>cxp+x*s, Y=z=>cyp+z*s;                          // north up: +x→east(right), +z→south(down)
	// frame + title
	mctx.fillStyle=GR; mctx.font="14px monospace"; mctx.textAlign="left"; mctx.fillText(translate("TACTICAL MAP"),24,30);
	mctx.fillStyle="#7fcfa6"; mctx.font="11px monospace"; mctx.fillText(translate("M to close"),24,48);
	// range rings around the player (every 20 km)
	const px=X(ownship.pos.x), py=Y(ownship.pos.z);
	mctx.strokeStyle="rgba(95,200,150,0.18)"; mctx.lineWidth=1; mctx.textAlign="left";
	for(let km=20;km<=120;km+=20){ const rr=km*1000*s; mctx.beginPath(); mctx.arc(px,py,rr,0,Math.PI*2); mctx.stroke();
		mctx.fillStyle="rgba(127,207,166,0.4)"; mctx.font="9px monospace"; mctx.fillText(km+"km",px+4,py-rr+12); }
	// islands — actual coastline outline (same harmonics as the 3-D geometry)
	const coastr=(o,a)=>o.r*Math.max(0.5,Math.min(1.25,0.72+o.a1*Math.sin(a*2+o.p1)+o.a2*Math.sin(a*3+o.p2)+o.a3*Math.sin(a*5+o.p3)));
	for(const o of map_islands){ mctx.beginPath();
		for(let k=0;k<=48;k++){ const a=k/48*Math.PI*2, rr=coastr(o,a); const sx=X(o.x+Math.cos(a)*rr), sy=Y(o.z+Math.sin(a)*rr); if(k===0) mctx.moveTo(sx,sy); else mctx.lineTo(sx,sy); }
		mctx.closePath();
		if(o.flat){ mctx.fillStyle="#3c6b4a"; mctx.fill(); mctx.strokeStyle="#7adf9f"; mctx.lineWidth=1.5; mctx.stroke(); }
		else { mctx.fillStyle="#2c6a44"; mctx.fill(); } }
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
	// compass N
	mctx.fillStyle=GR; mctx.font="13px monospace"; mctx.textAlign="center"; mctx.fillText("N",W-40,40); mctx.fillText("\u2191",W-40,26);
}
addEventListener("resize",()=>{ if(map_on) map_resize(); },{ signal });

let last_range=0;
function dir_at(headFwd, rightH, yawRad, pitchRad){ const d=headFwd.clone().applyAxisAngle(world_up,yawRad); d.applyAxisAngle(rightH,pitchRad); return d; }
function draw_hud(dt){
	hctx.clearRect(0,0,HW,HH);
	const cx=HW/2, cy=HH/2;
	// ---- carrier / deck-align overlay: shown in every view (incl. chase) ----
	if(ownship.on_cat){ hctx.textAlign="center"; hctx.fillStyle=AM; hctx.font="20px monospace"; hctx.fillText(translate("PRESS SPACE TO LAUNCH"),cx,cy+180);
		if(deck_edit){ hctx.save(); hctx.strokeStyle="rgba(255,193,77,0.55)"; hctx.lineWidth=1; hctx.setLineDash([6,6]);
			hctx.beginPath(); hctx.moveTo(cx,0); hctx.lineTo(cx,HH); hctx.stroke(); hctx.restore();
			hctx.fillStyle=AM; hctx.font="13px monospace"; hctx.fillText("DECK ALIGN  I/K fore-aft · J/L port-stbd · [ ] height · U/O rotate · G save",cx,cy+182);
			hctx.fillStyle=GR; hctx.fillText("x="+cfg.cat_x.toFixed(2)+"  z="+cfg.cat_z.toFixed(2)+"  height="+cfg.cat_dy.toFixed(2)+"  hdg="+cfg.cat_h.toFixed(1)+"\u00b0    (camera: Shift+\u2190\u2192 orbit · ,/. tilt · \u2212/= zoom)",cx,cy+200); } }
	else if(ownship.launching){ hctx.textAlign="center"; hctx.fillStyle=AM; hctx.font="22px monospace"; hctx.fillText(translate("LAUNCH"),cx,cy+130); }
	if(cat_saved_t>0){ cat_saved_t-=dt; hctx.textAlign="center"; hctx.fillStyle=GR; hctx.font="14px monospace"; hctx.fillText(translate("DECK POSITION SAVED"),cx,cy+182); }
	if(cfg.view!=="hud"){ return; }
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

	// ---- target box + range/closure (joust only) ----
	const rng = has_enemy ? ownship.pos.distanceTo(bandit.pos) : 1500;
	if(has_enemy){ const closure=dt>0?(last_range-rng)/dt*1.94384:0; last_range=rng;
		const tb=proj_point(bandit.pos);
		if(tb){ hctx.strokeStyle=AM; hctx.fillStyle=AM; hctx.strokeRect(tb[0]-22,tb[1]-22,44,44);
			hctx.font="11px monospace"; hctx.textAlign="left";
			hctx.fillText((rng/1852).toFixed(1)+" NM",tb[0]+28,tb[1]-8); hctx.fillText((closure>0?"+":"")+Math.round(closure)+" kt",tb[0]+28,tb[1]+8); } }

	// ---- lead-computing gun pipper ----
	const t=Math.min(rng,2000)/muzzle; const muz=body_offset(ownship,6.5,0.0,1.2);
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
	const kcas=ownship.speed*1.94384; const axr=cx-150, atop=cy-105, abot=cy+105, appu=1.5;   // px per knot
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
	hctx.font="10px monospace"; hctx.textAlign="center"; hctx.fillText("KCAS",axr-30,atop-8);
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
	const aby=tgcy+tgh/2-tgh*0.6; hctx.strokeStyle=AM; hctx.beginPath(); hctx.moveTo(tgx-11,aby); hctx.lineTo(tgx+11,aby); hctx.stroke(); hctx.strokeStyle=GR;
	hctx.font="11px monospace"; hctx.fillStyle=GR; hctx.fillText("THR",tgx,tgcy-tgh/2-9);
	hctx.font="15px monospace"; hctx.fillText(Math.round(ownship.throttle*100)+"%",tgx,tgcy+tgh/2+15);

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
function apply_size(){ const w=innerWidth,h=innerHeight,dpr=Math.min(devicePixelRatio||1,2),sc=THREE.MathUtils.clamp(cfg.render_scale,0.3,2.0)*dpr;
	renderer.setSize(Math.round(w*sc),Math.round(h*sc),false); canvas.style.width=w+"px"; canvas.style.height=h+"px";
	camera.aspect=w/h; camera.updateProjectionMatrix(); hud_resize(); if(cloud_active()||rt) size_rt(); }
addEventListener("resize",apply_size,{ signal });
let dyn_cd=0;
function dynamic_res(dt){ if(!cfg.dyn_res) return; dyn_cd-=dt; if(dyn_cd>0) return; dyn_cd=0.5; const recent=ft_ring.slice(-30).reduce((s,v)=>s+v,0)/30;
	if(recent>18&&cfg.render_scale>0.45){ cfg.render_scale=Math.max(0.45,cfg.render_scale-0.1); apply_size(); }
	else if(recent<14&&cfg.render_scale<1.0){ cfg.render_scale=Math.min(1.0,cfg.render_scale+0.05); apply_size(); } }

// ============================================================================ UI / menu
function set_view(v){ cfg.view=v; }
function apply_effects(){ renderer.shadowMap.enabled=cfg.shadows; sun.castShadow=cfg.shadows;
	const setc=g=>g.traverse(c=>{ if(c.isMesh&&(c.userData.body||c.userData.modelmesh))c.castShadow=cfg.shadows; }); setc(ownship.group); setc(bandit.group); extras.forEach(s=>setc(s.group)); }

function start_mission(){
	build_ocean(cfg.ocean_segments);
	apply_time_of_day(cfg.tod); apply_effects();
	if(cloud_active()){ apply_clouds(); size_rt(); }
	has_enemy=(cfg.task==="joust"); bandit.group.visible=has_enemy;
	sync_extras(cfg.extra_aircraft);
	reset_ownship(); apply_size(); save_cfg();
	pause_toggle=false; map_on=false; map_el.style.display="none";
	running=true;
	try{ window.focus(); stage.focus(); }catch(e){}
}

// ============================================================================ boot
apply_time_of_day(cfg.tod); apply_effects(); apply_size();
help_el.style.display=cfg.help?"":"none";
addEventListener("pointerdown",()=>{ try{ window.focus(); }catch(e){} },{ signal });

function menu_backdrop(){ const a=performance.now()*0.00007; const r=440;
	camera.position.set(CARRIER.x+Math.cos(a)*r, CARRIER.deckY+70, CARRIER.z+Math.sin(a)*r);
	camera.up.set(0,1,0); camera.lookAt(CARRIER.x,CARRIER.deckY+12,CARRIER.z);
	ownship.group.visible=true; ownship.group.position.copy(ownship.pos); ownship.group.quaternion.copy(ownship.q); bandit.group.visible=false; }

const clock=new THREE.Clock();
function frame(){ const dt=Math.min(clock.getDelta(),0.05);
	game_paused = running && !MULTIPLAYER && (map_on || pause_toggle);
	if(running){
		if(!game_paused){ ocean_mat.uniforms.u_time.value+=dt; step_world(dt); }   // frozen world stops advancing
		update_camera(dt);
	} else { ocean_mat.uniforms.u_time.value+=dt; menu_backdrop(); }
	if(ocean){ ocean.position.x=camera.position.x; ocean.position.z=camera.position.z; }
	sky.position.copy(camera.position); stars.position.copy(camera.position);
	render_frame();
	if(running){ draw_hud(dt); if(game_paused && !map_on) draw_pause_banner(); } else hctx.clearRect(0,0,HW,HH);
	if(map_on) draw_map();
	refresh_perf(dt); dynamic_res(dt);
	__raf = requestAnimationFrame(frame); }
function draw_pause_banner(){ hctx.save(); hctx.textAlign="center"; hctx.fillStyle="rgba(3,12,9,0.45)"; hctx.fillRect(HW/2-150,HH/2-44,300,88);
	hctx.fillStyle=AM; hctx.font="34px monospace"; hctx.fillText(translate("PAUSED"),HW/2,HH/2-2);
	hctx.fillStyle=GR; hctx.font="12px monospace"; hctx.fillText(translate("P to resume \u00b7 M map \u00b7 Esc menu"),HW/2,HH/2+24); hctx.restore(); }
start_mission();
__raf = requestAnimationFrame(frame);
init_external_model();
init_carrier_model();

  function stop() {
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
