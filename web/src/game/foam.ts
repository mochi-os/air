// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Sea foam's texture. The sea shader decides where foam lies and how much of
// it there is; this pattern mottles it there, so a whitecap is uneven white
// with bubbles and gaps rather than a flat smudge.

// The foam pattern, baked once into a tiling 1024x1024 texture by drawing this
// fragment shader over a full-screen quad; the sea lays one tile over 38 m. Every
// noise is periodic over the tile so the texture repeats seamlessly. Patches and
// lace share one tile so the sea reads both in one fetch: on the integrated GPUs
// Air is measured on, the sea's cost is its texture reads.
//   r  patches: warped noise cut into blotches, the shape of a foam patch
//   g  lace: the walls between bubbles of random size, half and a quarter metre
//   b  a slow density variation
//   a  streaks, noise stretched four to one, laid along the wind
export const PATTERN_VERTEX = `varying vec2 v_uv;
void main(){ v_uv=uv; gl_Position=vec4(position.xy,0.0,1.0); }`

export const PATTERN_FRAGMENT = `varying vec2 v_uv;
vec2 lattice(vec2 cell, vec2 period, float salt){
	cell=mod(cell,period);
	float h=fract(sin(dot(cell+salt,vec2(127.1,311.7)))*43758.5453);
	float a=h*6.2831853; return vec2(cos(a),sin(a)); }
float gradient(vec2 p, vec2 period, float salt){
	vec2 i=floor(p), f=fract(p); vec2 u=f*f*f*(f*(f*6.0-15.0)+10.0);
	float a=dot(lattice(i,period,salt),f);
	float b=dot(lattice(i+vec2(1.0,0.0),period,salt),f-vec2(1.0,0.0));
	float c=dot(lattice(i+vec2(0.0,1.0),period,salt),f-vec2(0.0,1.0));
	float d=dot(lattice(i+vec2(1.0,1.0),period,salt),f-vec2(1.0,1.0));
	return mix(mix(a,b,u.x),mix(c,d,u.x),u.y)*1.4; }
float fractal(vec2 p, vec2 period, int octaves, float salt){
	float sum=0.0, amplitude=0.5;
	for(int i=0;i<6;i++){ if(i>=octaves) break;
		sum+=amplitude*gradient(p,period,salt+float(i)*17.0); p*=2.0; period*=2.0; amplitude*=0.5; }
	return sum; }
vec2 scatter(vec2 cell, float salt){ return fract(sin(vec2(dot(cell+salt,vec2(127.1,311.7)),dot(cell+salt,vec2(269.5,183.3))))*43758.5453); }
float bubbles(vec2 uv, float period, float salt, float smallest, float largest){
	vec2 span=vec2(period);
	vec2 bend=vec2(fractal(uv*period*0.5,span*0.5,3,salt+3.0), fractal(uv*period*0.5+17.0,span*0.5,3,salt+5.0));
	vec2 p=uv*period+bend*0.9; vec2 ip=floor(p), fp=fract(p); float nearest=9.0;
	for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){
		vec2 o=vec2(float(i),float(j)); vec2 cell=mod(ip+o,span);
		vec2 r=o+scatter(cell,salt)*0.9+0.05-fp;
		float radius=mix(smallest,largest,scatter(cell,salt+7.0).x);
		nearest=min(nearest,length(r)/radius); }
	return smoothstep(0.8,1.25,nearest); }
void main(){ vec2 uv=v_uv;
	vec2 bend=vec2(fractal(uv*5.0,vec2(5.0),3,1.0), fractal(uv*5.0+vec2(3.0,9.0),vec2(5.0),3,2.0));
	float blot=smoothstep(-0.14,0.06,fractal(uv*10.0+bend*1.4,vec2(10.0),5,3.0));
	vec2 curl=vec2(fractal(uv*12.0+1.0,vec2(12.0),2,4.0), fractal(uv*12.0+8.0,vec2(12.0),2,5.0));
	float speck=smoothstep(-0.16,0.04,fractal(uv*27.0+curl*0.9,vec2(27.0),4,6.0));
	float coarse=bubbles(uv,76.0,37.0,0.06,0.45), fine=bubbles(uv,152.0,53.0,0.05,0.42);
	float density=fractal(uv*4.0,vec2(4.0),5,7.0)*0.5+0.5, grain=fractal(uv*16.0,vec2(16.0),3,8.0)*0.5+0.5;
	float patches=blot*(0.55+0.45*speck)*(0.75+0.25*coarse);
	float lace=0.45+0.55*coarse*(0.7+0.3*fine);
	float streak=fractal(uv*vec2(4.0,16.0),vec2(4.0,16.0),5,9.0)*0.5+0.5;
	gl_FragColor=vec4(clamp(patches*0.6+density*0.4,0.0,1.0), clamp(lace*0.8+grain*0.2,0.0,1.0), density, clamp(streak,0.0,1.0)); }`
