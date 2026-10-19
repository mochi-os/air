// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
// The FFT sea's GPU half: the initial amplitudes (spectrum.ts) evolved to this
// moment, transformed to the sea by an inverse FFT, every frame. The three
// cascades lie side by side in one strip of float targets, so each step is one
// draw for all of them:
//
//   evolve  h(k,t) and the seven fields derived from it, packed two complex
//           fields to a target pair: (Dx + i Dz, h + i Jxz) and
//           (Sx + i Sz, Jxx + i Jzz), since the inverse transform of a + i b,
//           for a and b the spectra of real fields, is a(x) + i b(x)
//   fft     a Stockham radix-2 pass per stage, 8 along x then 8 along z,
//           in natural order so there is no bit reversal
//   finish  per cascade: the sign the centred spectrum leaves, out to two
//           mipmapped half-float textures the sea samples - displacement
//           (Dx, h, Dz, Jxz) and derivatives (Sx, Sz, Jxx, Jzz)
//
// The horizontal displacement is choppiness times -i k/|k| h with the sign that
// sharpens crests and flattens troughs, as a Gerstner wave does.
import * as THREE from 'three'
import { amplitudes, CASCADES, SIZE, type Wind } from './spectrum'

export const CHOPPY = 1.25

const VERTEX = `void main(){ gl_Position=vec4(position.xy,0.0,1.0); }`

const COMMON = `precision highp float; precision highp int;
vec2 cmul(vec2 a, vec2 b){ return vec2(a.x*b.x-a.y*b.y, a.x*b.y+a.y*b.x); }
vec2 muli(vec2 a){ return vec2(-a.y,a.x); }`

export const EVOLVE = `${COMMON}
uniform sampler2D u_amplitudes; uniform float u_time, u_choppy; uniform vec3 u_lengths;
layout(location=0) out vec4 o_first; layout(location=1) out vec4 o_second;
void main(){
	ivec2 p=ivec2(gl_FragCoord.xy); int c=p.x/${SIZE}; int x=p.x-c*${SIZE};
	float L=c==0?u_lengths.x:(c==1?u_lengths.y:u_lengths.z);
	vec2 k=vec2(float(x-${SIZE / 2}),float(p.y-${SIZE / 2}))*(6.2831853/L); float kl=length(k);
	if(kl<1.0e-6){ o_first=vec4(0.0); o_second=vec4(0.0); return; }
	vec4 h0=texelFetch(u_amplitudes,p,0);
	float w=sqrt(9.81*kl+7.4e-5*kl*kl*kl); float phase=w*u_time; vec2 e=vec2(cos(phase),sin(phase));
	vec2 h=cmul(h0.xy,vec2(e.x,-e.y))+cmul(h0.zw,e);   // travels along +k
	vec2 ih=muli(h); float ik=1.0/kl;
	vec2 dx=ih*(u_choppy*k.x*ik), dz=ih*(u_choppy*k.y*ik);
	vec2 jxx=h*(-u_choppy*k.x*k.x*ik), jzz=h*(-u_choppy*k.y*k.y*ik), jxz=h*(-u_choppy*k.x*k.y*ik);
	vec2 sx=ih*k.x, sz=ih*k.y;
	o_first=vec4(dx+muli(dz), h+muli(jxz));
	o_second=vec4(sx+muli(sz), jxx+muli(jzz)); }`

export const FFT = `${COMMON}
uniform sampler2D u_first, u_second; uniform int u_stage, u_axis;
layout(location=0) out vec4 o_first; layout(location=1) out vec4 o_second;
void main(){
	ivec2 p=ivec2(gl_FragCoord.xy); int base=(p.x/${SIZE})*${SIZE};
	int o=u_axis==0?p.x-base:p.y; int span=1<<u_stage;
	int block=o/(2*span); int q=o-block*2*span; int r=q/span; int m=q-r*span; int j=block*span+m;
	ivec2 p0=u_axis==0?ivec2(base+j,p.y):ivec2(p.x,j);
	ivec2 p1=u_axis==0?ivec2(base+j+${SIZE / 2},p.y):ivec2(p.x,j+${SIZE / 2});
	float angle=3.14159265358979*float(m)/float(span); vec2 w=vec2(cos(angle),sin(angle));   // inverse transform: +2 pi m / (2 span)
	vec4 a0=texelFetch(u_first,p0,0), a1=texelFetch(u_first,p1,0), b0=texelFetch(u_second,p0,0), b1=texelFetch(u_second,p1,0);
	vec4 ta=vec4(cmul(a1.xy,w),cmul(a1.zw,w)), tb=vec4(cmul(b1.xy,w),cmul(b1.zw,w));
	float s=r==0?1.0:-1.0;
	o_first=a0+s*ta; o_second=b0+s*tb; }`

export const FINISH = `${COMMON}
uniform sampler2D u_first, u_second; uniform int u_cascade;
layout(location=0) out vec4 o_displacement; layout(location=1) out vec4 o_derivative;
void main(){
	ivec2 p=ivec2(gl_FragCoord.xy); ivec2 s=ivec2(p.x+u_cascade*${SIZE},p.y);
	float flip=((p.x+p.y)&1)==0?1.0:-1.0;   // the spectrum is stored centred: (-1)^(x+z)
	vec4 a=texelFetch(u_first,s,0)*flip, b=texelFetch(u_second,s,0)*flip;
	o_displacement=vec4(a.x,a.z,a.y,a.w);   // Dx, h, Dz, Jxz
	o_derivative=b; }` // Sx, Sz, Jxx, Jzz

export class Waves {
  readonly displacement: THREE.Texture[] = []
  readonly derivative: THREE.Texture[] = []
  private readonly amplitudes: THREE.DataTexture
  private readonly ping: THREE.WebGLMultipleRenderTargets
  private readonly pong: THREE.WebGLMultipleRenderTargets
  private readonly outputs: THREE.WebGLMultipleRenderTargets[] = []
  private readonly evolve: THREE.ShaderMaterial
  private readonly fft: THREE.ShaderMaterial
  private readonly finish: THREE.ShaderMaterial
  private last: number | null = null
  private readonly quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2))
  private readonly room = new THREE.Scene()
  private readonly camera = new THREE.Camera()

  constructor(wind: Wind, seed: number) {
    const width = SIZE * CASCADES.length
    this.amplitudes = new THREE.DataTexture(
      amplitudes(wind, seed),
      width,
      SIZE,
      THREE.RGBAFormat,
      THREE.FloatType
    )
    this.amplitudes.minFilter = this.amplitudes.magFilter = THREE.NearestFilter
    this.amplitudes.needsUpdate = true
    const strip = () =>
      new THREE.WebGLMultipleRenderTargets(width, SIZE, 2, {
        type: THREE.HalfFloatType,
        depthBuffer: false,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
      })
    this.ping = strip()
    this.pong = strip()
    for (let c = 0; c < CASCADES.length; c++) {
      const out = new THREE.WebGLMultipleRenderTargets(SIZE, SIZE, 2, {
        type: THREE.HalfFloatType,
        depthBuffer: false,
        generateMipmaps: true,
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS: THREE.RepeatWrapping,
        wrapT: THREE.RepeatWrapping,
      })
      for (const t of out.texture) {
        t.generateMipmaps = true
        t.minFilter = THREE.LinearMipmapLinearFilter
        t.magFilter = THREE.LinearFilter
        t.wrapS = t.wrapT = THREE.RepeatWrapping
        t.anisotropy = 2 // the sea's account of the slopes a pixel cannot show assumes this filter
      }
      this.outputs.push(out)
      this.displacement.push(out.texture[0])
      this.derivative.push(out.texture[1])
    }
    const material = (
      fragmentShader: string,
      uniforms: Record<string, THREE.IUniform>
    ) =>
      new THREE.ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader,
        uniforms,
        glslVersion: THREE.GLSL3,
        depthTest: false,
        depthWrite: false,
      })
    this.evolve = material(EVOLVE, {
      u_amplitudes: { value: this.amplitudes },
      u_time: { value: 0 },
      u_choppy: { value: CHOPPY },
      u_lengths: {
        value: new THREE.Vector3(CASCADES[0], CASCADES[1], CASCADES[2]),
      },
    })
    this.fft = material(FFT, {
      u_first: { value: null },
      u_second: { value: null },
      u_stage: { value: 0 },
      u_axis: { value: 0 },
    })
    this.finish = material(FINISH, {
      u_first: { value: null },
      u_second: { value: null },
      u_cascade: { value: 0 },
    })
    this.quad.frustumCulled = false
    this.room.add(this.quad)
  }

  private pass(
    renderer: THREE.WebGLRenderer,
    material: THREE.ShaderMaterial,
    target: THREE.WebGLRenderTarget | THREE.WebGLMultipleRenderTargets
  ) {
    this.quad.material = material
    renderer.setRenderTarget(target)
    renderer.render(this.room, this.camera)
  }

  // The sea at time t, s, into the cascades' textures.
  update(renderer: THREE.WebGLRenderer, time: number) {
    if (time === this.last) return
    this.last = time
    const was = renderer.getRenderTarget(),
      clear = renderer.autoClear
    renderer.autoClear = false // every pass writes every texel of its target: a clear first is bandwidth for nothing
    this.evolve.uniforms.u_time.value = time
    this.pass(renderer, this.evolve, this.ping)
    let from = this.ping,
      to = this.pong
    const stages = Math.log2(SIZE)
    for (let axis = 0; axis < 2; axis++)
      for (let stage = 0; stage < stages; stage++) {
        this.fft.uniforms.u_first.value = from.texture[0]
        this.fft.uniforms.u_second.value = from.texture[1]
        this.fft.uniforms.u_stage.value = stage
        this.fft.uniforms.u_axis.value = axis
        this.pass(renderer, this.fft, to)
        ;[from, to] = [to, from]
      }
    this.finish.uniforms.u_first.value = from.texture[0]
    this.finish.uniforms.u_second.value = from.texture[1]
    for (let c = 0; c < CASCADES.length; c++) {
      this.finish.uniforms.u_cascade.value = c
      this.pass(renderer, this.finish, this.outputs[c])
    }
    renderer.setRenderTarget(was)
    renderer.autoClear = clear
  }
}
