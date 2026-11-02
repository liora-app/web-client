import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'

/**
 * Renderer look: Khronos PBR Neutral tone mapping (keeps the lotus and lantern amber amber instead of bleaching them
 * to white like ACES, and keeps the saturation AgX washes out), PCF shadows (PCFSoftShadowMap is gone in r186).
 * The post chain is render → bloom → film, where film does tone mapping + grade + grain in one full-screen pass.
 */
export function configureRenderer(renderer:THREE.WebGLRenderer):void {
  renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.NeutralToneMapping;renderer.toneMappingExposure=1.45
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap
}

export type Tier='high'|'medium'|'low'
/**
 * What a quality tier may change. Every knob here lives outside the shader program keys (render-target sizes and
 * sample counts, the shadow map size, update rates, visibility of two decorative layers), so moving between tiers never
 * recompiles a shader. Light count, transmission .35 and the bloom settings stay fixed on every tier.
 */
export interface QualityPreset {
  tier:Tier
  /** MSAA samples of the HDR scene buffer (on Low the film grain has to mask the missing AA). */
  samples:number
  /** Bloom chain resolution relative to the drawing buffer (the pass itself already starts at half of it). */
  bloomScale:number
  /** renderer.transmissionResolutionScale: the lotus' see-through pass (MSAA ×4, HalfFloat, mipmapped). */
  transmission:number
  shadowSize:number
  /** Moon shadow refreshes per second while nothing moves fast (motion-14a: by time, not by frame count). */
  shadowHz:number
  /** Foreground bokeh and the willow's hair-thin filaments: sub-pixel additive detail that only aliases without MSAA. */
  finery:boolean
}
export const qualityPresets:Record<Tier,QualityPreset>={
  high:{tier:'high',samples:2,bloomScale:1,transmission:.25,shadowSize:2048,shadowHz:30,finery:true},
  // Medium keeps the full bloom chain: the bloom radius is fixed, so a half-resolution chain doubles the glow's spread on
  // screen (seen on Low near the lotus), against "glow on the source, not haze over the frame". Low accepts that trade.
  // Medium is where phones start (and integrated desktop GPUs: Intel, base Apple M, Radeon APUs, GeForce MX). On a phone
  // it draws at DPR ≤ 1.25 on a 3x screen, and without MSAA the petal and knit silhouettes stair-step under the upscale
  // (art-8). Two samples, as on High; tile-based mobile GPUs resolve them on chip, and pacing still steps down to Low
  // (no MSAA) wherever the resolve costs too much.
  medium:{tier:'medium',samples:2,bloomScale:1,transmission:.2,shadowSize:1024,shadowHz:30,finery:true},
  low:{tier:'low',samples:0,bloomScale:.5,transmission:.15,shadowSize:1024,shadowHz:15,finery:false},
}
/**
 * Rungs of the adaptive ladder, best first: a tier plus a device-pixel-ratio ceiling (phones get a lower one).
 * The start rung comes from the GPU name; measured frame pacing then only moves down (or probes one rung back up).
 */
export const qualityLadder:{tier:Tier;dpr:number;mobileDpr:number}[]=[
  {tier:'high',dpr:1.75,mobileDpr:1.5},{tier:'high',dpr:1.5,mobileDpr:1.35},{tier:'medium',dpr:1.25,mobileDpr:1.25},{tier:'medium',dpr:1.1,mobileDpr:1.1},{tier:'low',dpr:1,mobileDpr:1},
]
/** Start rung from the unmasked GPU name (a guess the frame pacing corrects): integrated and older mobile GPUs start lower. */
export function detectTier(renderer:THREE.WebGLRenderer):{tier:Tier;gpu:string} {
  const gl=renderer.getContext(),info=gl.getExtension('WEBGL_debug_renderer_info')
  const gpu=String((info?gl.getParameter(info.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER))??'')
  const coarse=matchMedia('(pointer: coarse)').matches
  if(!coarse&&/geforce (rtx|gtx)|nvidia rtx|quadro|radeon rx|radeon pro|arc\(tm\)|intel.*arc /i.test(gpu))return {tier:'high',gpu}
  if(/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic|mali-[t4]|mali-g[35]\d|adreno \(tm\) [2-5]\d\d|adreno [2-5]\d\d|powervr|sgx|intel.*(hd graphics|gma)|vivante|videocore/i.test(gpu))return {tier:'low',gpu}
  if(/intel|apple gpu|apple m[1-4](?! (pro|max|ultra))|mali|adreno|radeon\(tm\) graphics|radeon graphics|radeon vega|vega \d+ graphics|geforce mx|xclipse|immortalis|maleoon/i.test(gpu)||coarse)return {tier:'medium',gpu}
  return {tier:'high',gpu}
}

export interface Post {
  setSize:(width:number,height:number,dpr:number)=>void
  render:(delta:number,elapsed:number,reduced:boolean)=>void
  inspect:()=>{bloom:number[];grain:number;exposure:number}
  /** The HDR buffer the scene pass draws into; programs must be precompiled against it (tone mapping off, linear). */
  target:()=>THREE.WebGLRenderTarget
  /** Change MSAA samples / bloom resolution in place (render targets only, no shader is rebuilt). */
  setQuality:(preset:QualityPreset)=>void
  /** Compile the bloom and film programs in parallel ahead of the first frame (resolves when they are linked). */
  warmup:()=>Promise<unknown>

  /** Pixel sizes of the scene buffer and the first bloom level, for the dev perf readout. */
  sizes:()=>{scene:number[];bloom:number[];samples:number}
  dispose:()=>void
}

/**
 * Replaces grade + OutputPass with one pass: HDR → Neutral tone map → sRGB, then the film grade in display space
 * (gentle S-curve around a low pivot for a night key, cool emerald shadows / warm amber lights, a touch less
 * saturation, a soft vignette) and luma-weighted grain plus a fixed ±1 LSB dither so dark gradients never band.
 */
const filmShader=`precision highp float;
uniform sampler2D tDiffuse;uniform float uTime,uGrain,uAspect,uContrast,uSaturation,uVignette,uLift;
uniform vec3 uShadowTint,uLightTint;
#include <tonemapping_pars_fragment>
#include <colorspace_pars_fragment>
varying vec2 vUv;
float hash12(vec2 p){vec3 p3=fract(vec3(p.xyx)*.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}
void main(){
  vec3 c=sRGBTransferOETF(vec4(NeutralToneMapping(max(texture2D(tDiffuse,vUv).rgb,0.)),1.)).rgb;
  float l=dot(c,vec3(.2126,.7152,.0722));
  c+=uContrast*c*(1.-c)*(c-.2)*4.;
  float shadows=1.-smoothstep(0.,.38,l),lights=smoothstep(.32,.9,l);
  c*=mix(vec3(1.),uShadowTint,shadows)*mix(vec3(1.),uLightTint,lights);
  c+=uLift*vec3(.55,1.,.95)*(1.-smoothstep(0.,.12,l));
  l=dot(c,vec3(.2126,.7152,.0722));c=mix(vec3(l),c,uSaturation);
  vec2 v=(vUv-.5)*vec2(uAspect,1.)/length(vec2(uAspect,1.))*2.;
  c*=1.-uVignette*smoothstep(.25,1.15,dot(v,v));
  float t=fract(uTime*.61)*311.;
  float grain=hash12(gl_FragCoord.xy+t)-.5,dither=hash12(gl_FragCoord.xy*1.31+vec2(17.3,5.9)+t)-hash12(gl_FragCoord.xy*.97+vec2(3.1,41.7)+t);
  c+=grain*uGrain*smoothstep(0.,.22,l)*(1.15-l)+dither/255.;
  gl_FragColor=vec4(clamp(c,0.,1.),1.);
}`
const quadVertex='precision highp float;uniform mat4 modelViewMatrix,projectionMatrix;attribute vec3 position;attribute vec2 uv;varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}'

export function createPost(renderer:THREE.WebGLRenderer,scene:THREE.Scene,camera:THREE.Camera,preset:QualityPreset):Post {
  let samples=preset.samples,bloomScale=preset.bloomScale,width=innerWidth,height=innerHeight,ratio=1
  const targetBuffer=new THREE.WebGLRenderTarget(innerWidth,innerHeight,{type:THREE.HalfFloatType,samples})
  const composer=new EffectComposer(renderer,targetBuffer),renderPass=new RenderPass(scene,camera)
  // Linear-HDR threshold with a soft knee: only real emitters (lotus core, lanterns, moon, fireflies) bloom;
  // lit paper, petals and skin stay below it. A small radius keeps the glow on the source instead of hazing the frame.
  const bloom=new UnrealBloomPass(new THREE.Vector2(innerWidth,innerHeight),.5,.4,.8);bloom.materialHighPassFilter.uniforms.smoothWidth.value=.45
  const film=new ShaderPass(new THREE.RawShaderMaterial({name:'FilmGrade',vertexShader:quadVertex,fragmentShader:filmShader,depthTest:false,depthWrite:false,uniforms:{
    tDiffuse:{value:null},toneMappingExposure:{value:renderer.toneMappingExposure},uTime:{value:0},uGrain:{value:.03},uAspect:{value:innerWidth/innerHeight},
    uContrast:{value:.14},uSaturation:{value:.92},uVignette:{value:.3},uLift:{value:.006},
    uShadowTint:{value:new THREE.Vector3(.94,1.01,1.04)},uLightTint:{value:new THREE.Vector3(1.05,1.,.9)},
  }}))
  composer.addPass(renderPass);composer.addPass(bloom);composer.addPass(film)
  // The composer sizes every pass to the full drawing buffer; the bloom chain is then re-sized to its own scale.
  const fitBloom=():void=>{if(bloomScale<1)bloom.setSize(Math.max(2,Math.round(width*ratio*bloomScale)),Math.max(2,Math.round(height*ratio*bloomScale)))}
  return {
    setSize(w,h,dpr){width=w;height=h;ratio=dpr;composer.setPixelRatio(dpr);composer.setSize(w,h);fitBloom();film.uniforms.uAspect.value=w/h},
    target(){return composer.renderTarget1},
    setQuality(next){
      if(next.samples!==samples){samples=next.samples;composer.renderTarget1.samples=samples;composer.reset()}
      if(next.bloomScale!==bloomScale){bloomScale=next.bloomScale;composer.setSize(width,height);fitBloom()}
    },
    warmup(){
      // Same render-target state as the real passes: bloom draws off-screen (linear, no tone mapping), film to the screen.
      const quad=new THREE.PlaneGeometry(2,2),offscreen=new THREE.Scene(),screen=new THREE.Scene(),previous=renderer.getRenderTarget()
      for(const mat of [bloom.materialHighPassFilter,...bloom.separableBlurMaterials,bloom.compositeMaterial,bloom.blendMaterial])offscreen.add(new THREE.Mesh(quad,mat))
      screen.add(new THREE.Mesh(quad,film.material))
      renderer.setRenderTarget(bloom.renderTargetBright);const bloomReady=renderer.compileAsync(offscreen,camera)
      renderer.setRenderTarget(null);const filmReady=renderer.compileAsync(screen,camera)
      renderer.setRenderTarget(previous)
      return Promise.all([bloomReady,filmReady]).finally(()=>quad.dispose())
    },
    sizes(){const bright=bloom.renderTargetBright;return {scene:[composer.renderTarget1.width,composer.renderTarget1.height],bloom:[bright.width,bright.height],samples}},
    render(delta,elapsed,reduced){film.uniforms.uTime.value=reduced?0:elapsed;film.uniforms.toneMappingExposure.value=renderer.toneMappingExposure;composer.render(delta)},
    inspect(){return {bloom:[bloom.strength,bloom.radius,bloom.threshold],grain:film.uniforms.uGrain.value,exposure:renderer.toneMappingExposure}},
    dispose(){bloom.dispose();film.dispose();renderPass.dispose();composer.dispose()},
  }
}
