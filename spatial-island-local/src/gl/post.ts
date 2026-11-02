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

export interface Post {
  setSize:(width:number,height:number,dpr:number)=>void
  render:(delta:number,elapsed:number,reduced:boolean)=>void
  inspect:()=>{bloom:number[];grain:number;exposure:number}
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

export function createPost(renderer:THREE.WebGLRenderer,scene:THREE.Scene,camera:THREE.Camera):Post {
  const targetBuffer=new THREE.WebGLRenderTarget(innerWidth,innerHeight,{type:THREE.HalfFloatType,samples:2})
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
  return {
    setSize(width,height,dpr){composer.setPixelRatio(dpr);composer.setSize(width,height);film.uniforms.uAspect.value=width/height},
    render(delta,elapsed,reduced){film.uniforms.uTime.value=reduced?0:elapsed;film.uniforms.toneMappingExposure.value=renderer.toneMappingExposure;composer.render(delta)},
    inspect(){return {bloom:[bloom.strength,bloom.radius,bloom.threshold],grain:film.uniforms.uGrain.value,exposure:renderer.toneMappingExposure}},
    dispose(){bloom.dispose();film.dispose();renderPass.dispose();composer.dispose()},
  }
}
