import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'

/** Renderer look (tone mapping, exposure) and the HDR post chain: render → bloom → grade → output. */
export function configureRenderer(renderer:THREE.WebGLRenderer):void {
  renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.15
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap
}

export interface Post {
  setSize:(width:number,height:number,dpr:number)=>void
  render:(delta:number,elapsed:number,reduced:boolean)=>void
  inspect:()=>{bloom:number[];grain:number;exposure:number}
  dispose:()=>void
}

export function createPost(renderer:THREE.WebGLRenderer,scene:THREE.Scene,camera:THREE.Camera):Post {
  const targetBuffer=new THREE.WebGLRenderTarget(innerWidth,innerHeight,{type:THREE.HalfFloatType,samples:2})
  const composer=new EffectComposer(renderer,targetBuffer),renderPass=new RenderPass(scene,camera)
  const bloom=new UnrealBloomPass(new THREE.Vector2(innerWidth,innerHeight),.85,.55,.25)
  const grade=new ShaderPass({uniforms:{tDiffuse:{value:null},uTime:{value:0},uGrain:{value:.025}},vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader:'uniform sampler2D tDiffuse;uniform float uTime,uGrain;varying vec2 vUv;void main(){vec3 color=texture2D(tDiffuse,vUv).rgb;vec2 p=(vUv-.5)*1.25;float vignette=1.-smoothstep(.18,.88,dot(p,p))*.38;float grain=fract(sin(dot(gl_FragCoord.xy+mod(uTime,97.),vec2(12.9898,78.233)))*43758.5453)-.5;float luma=dot(color,vec3(.2126,.7152,.0722));color=max(vec3(0.),color*vignette+grain*uGrain*(.08+min(1.,luma)*.5));gl_FragColor=vec4(color,1.);}'})
  const output=new OutputPass();composer.addPass(renderPass);composer.addPass(bloom);composer.addPass(grade);composer.addPass(output)
  return {
    setSize(width,height,dpr){composer.setPixelRatio(dpr);composer.setSize(width,height)},
    render(delta,elapsed,reduced){grade.uniforms.uTime.value=reduced?0:elapsed;composer.render(delta)},
    inspect(){return {bloom:[bloom.strength,bloom.radius,bloom.threshold],grain:grade.uniforms.uGrain.value,exposure:renderer.toneMappingExposure}},
    dispose(){bloom.dispose();grade.dispose();output.dispose();renderPass.dispose();composer.dispose()},
  }
}
