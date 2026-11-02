import * as THREE from 'three'
import gsap from 'gsap'
import { breathe,disposeObject } from './craft'
import { createIsland } from './island'
import { createLotus } from './lotus'
import { createCompanion } from './companion'
import { createEnvironment } from './environment'
import { createLighting } from './lighting'
import { createGlow } from './glow'
import { configureRenderer,createPost } from './post'
import { surfaceOrigin } from './surface'

export interface SanctuaryScene {
  setProgress:(progress:number,velocity:number)=>void;setPointer:(x:number,y:number)=>void
  selectLantern:(index:number)=>void;turnPage:()=>void;setTalking:(talking:boolean)=>void
  setVoice:(volume:number)=>void;setReduced:(reduced:boolean)=>void;loadCompanion:(url:string)=>Promise<boolean>
  inspect:()=>SceneInspection
  motion:()=>{coreScale:number[];breath:number;avatar:ReturnType<ReturnType<typeof createCompanion>['pose']>}
  dispose:()=>void
}
type AvatarInspection=ReturnType<ReturnType<typeof createCompanion>['inspect']>
interface SceneInspection {progress:number;camera:number[];target:number[];coreScale:number[];breath:number;avatar:AvatarInspection;framing:{avatar:number[];lotus:number[]};lanterns:number[];lanternScreens:number[][];privacyClosure:number;paperOrbit:number;resources:{geometries:number;textures:number};calls:number;cinematic:{grass:number;petals:number;particles:number;mistLayers:number;silhouettes:number;bloom:number[];exposure:number;transmission:number;grain:number;fps:number;frameP95:number;triangles:number;cameraClearance:number}}
export const cameraWaypoints=[[-2.1,2,5.6],[-2.25,1.1,1.95],[-1.75,.65,2.65],[.25,1.75,2.1],[0,1.35,1.85]]
export const targetWaypoints=[[.5,.45,0],[-1.55,.66,.75],[-1.05,.56,1.55],[1.35,2.3,-.3],[0,.55,-.8]]
function curveRig(points:number[][]):{curve:THREE.CatmullRomCurve3;sample:(p:number,out:THREE.Vector3)=>THREE.Vector3} {
  const curve=new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(p[0],p[1],p[2])),false,'centripetal');curve.arcLengthDivisions=1000
  const lengths=curve.getLengths(1000),total=lengths[1000],knots=[0,250,500,750,1000].map(i=>lengths[i]/total)
  return {curve,sample(p,out){const segment=Math.min(3,Math.floor(p*4)),fraction=p*4-segment;return curve.getPointAt(THREE.MathUtils.lerp(knots[segment],knots[segment+1],fraction),out)}}
}
/** Fade a subtree. Materials only become transparent while actually fading, so opaque frames keep early-z and sorting. */
function fadingMaterials(root:THREE.Object3D):(opacity:number)=>void {
  const materials=new Map<THREE.Material,{opacity:number;depthWrite:boolean;transparent:boolean}>()
  root.traverse(object=>{if(object instanceof THREE.Mesh||object instanceof THREE.Line)for(const mat of Array.isArray(object.material)?object.material:[object.material])materials.set(mat,{opacity:mat.opacity,depthWrite:mat.depthWrite,transparent:mat.transparent})})
  let last=-1
  return opacity=>{
    root.visible=opacity>.001;if(opacity===last)return;last=opacity
    const fading=opacity<.995
    for(const [mat,rest] of materials){
      const transparent=rest.transparent||fading;if(mat.transparent!==transparent){mat.transparent=transparent;mat.needsUpdate=true}
      mat.opacity=rest.opacity*opacity;mat.depthWrite=rest.depthWrite&&!fading;if(mat instanceof THREE.ShaderMaterial&&mat.uniforms.uFade)mat.uniforms.uFade.value=opacity
    }
  }
}

export async function createSanctuary(host:HTMLElement,onLantern:(index:number)=>void,onLost:()=>void):Promise<SanctuaryScene> {
  let renderer:THREE.WebGLRenderer
  try{renderer=new THREE.WebGLRenderer({antialias:false,alpha:false,stencil:false,powerPreference:'high-performance'})}catch{throw new Error('WebGL unavailable')}
  configureRenderer(renderer);renderer.info.autoReset=false;renderer.transmissionResolutionScale=.5
  const scene=new THREE.Scene();scene.background=new THREE.Color('#020509');scene.fog=new THREE.FogExp2('#0d2124',.028)
  const camera=new THREE.PerspectiveCamera(46,1,.035,120);host.append(renderer.domElement);renderer.domElement.setAttribute('aria-hidden','true')
  const cameraRig=curveRig(cameraWaypoints),targetRig=curveRig(targetWaypoints)
  const environment=createEnvironment(cameraRig.curve);scene.add(environment.group)
  const island=createIsland(),lotus=createLotus(),companion=createCompanion();scene.add(island.group);island.group.add(lotus.group,companion.group)
  const fadeCanopy=fadingMaterials(island.canopy),fadeStations=fadingMaterials(island.stations)
  const lighting=createLighting(scene,renderer),glow=createGlow(island.group),post=createPost(renderer,scene,camera)
  let progress=0,velocity=0,volume=0,talking=false,reduced=matchMedia('(prefers-reduced-motion: reduce)').matches,disposed=false,frame=0,elapsed=0,lastStamp=0,selectedLantern=-1,hasGreeted=false,parallaxX=0,parallaxY=0,lastBreath=0,contextLost=false,privacyActive=false
  let frameIndex=0,paperOrbitGoal=0,privacyTween:gsap.core.Tween|undefined,paperTween:gsap.core.Tween|undefined
  const frameTimes:number[]=[],pointer=new THREE.Vector2(),position=new THREE.Vector3(),target=new THREE.Vector3(),raycaster=new THREE.Raycaster(),ndc=new THREE.Vector2(),cameraDirection=new THREE.Vector3(),cordEnd=new THREE.Vector3(),cordDirection=new THREE.Vector3(),up=new THREE.Vector3(0,1,0),worldCore=new THREE.Vector3()
  const resize=():void=>{const w=innerWidth,h=innerHeight,dpr=Math.min(devicePixelRatio,w<760?1.5:1.75);renderer.setPixelRatio(dpr);renderer.setSize(w,h);post.setSize(w,h,dpr);camera.aspect=w/h;camera.updateProjectionMatrix();glow.setPixelRatio(dpr)}
  resize();window.addEventListener('resize',resize)
  const hit=(event:PointerEvent):number=>{if(progress<.61||progress>.87||event.target instanceof Element&&event.target.closest('button,a,input,textarea,dialog,.glass'))return -1;ndc.set(event.clientX/innerWidth*2-1,-event.clientY/innerHeight*2+1);raycaster.setFromCamera(ndc,camera);const found=raycaster.intersectObjects(island.lanterns.map(l=>l.body),false)[0];return found?island.lanterns.findIndex(l=>l.body===found.object):-1}
  const onClick=(event:PointerEvent):void=>{const index=hit(event);if(index>=0)onLantern(index)}
  const onMove=(event:PointerEvent):void=>{document.body.classList.toggle('lantern-hover',hit(event)>=0)}
  window.addEventListener('pointerup',onClick);window.addEventListener('pointermove',onMove,{passive:true})
  const lost=(event:Event):void=>{event.preventDefault();contextLost=true;cancelAnimationFrame(frame);onLost()};renderer.domElement.addEventListener('webglcontextlost',lost)
  const visibility=():void=>{lastStamp=0;if(document.hidden)cancelAnimationFrame(frame);else if(!disposed&&!contextLost)frame=requestAnimationFrame(render)};document.addEventListener('visibilitychange',visibility)
  function render(stamp:number):void {
    if(disposed||contextLost)return
    const rawDelta=lastStamp?Math.max(0,(stamp-lastStamp)/1000):1/60,delta=Math.min(.25,rawDelta);lastStamp=stamp;elapsed+=rawDelta
    if(rawDelta>0&&rawDelta<.5){frameTimes.push(rawDelta*1000);if(frameTimes.length>120)frameTimes.shift()}
    const breath=breathe(elapsed);lastBreath=breath;island.group.position.y=reduced?0:Math.sin(elapsed*.6)*.045;surfaceOrigin.value.copy(island.group.position)
    cameraRig.sample(progress,position);targetRig.sample(progress,target)
    const calm=progress>.85?.3:1
    parallaxX=THREE.MathUtils.lerp(parallaxX,reduced?0:pointer.x*.2*calm,1-Math.exp(-3.08*delta));parallaxY=THREE.MathUtils.lerp(parallaxY,reduced?0:pointer.y*.12*calm,1-Math.exp(-3.08*delta))
    camera.position.copy(position);camera.position.x+=parallaxX;camera.position.y+=parallaxY+island.group.position.y;target.y+=island.group.position.y;camera.lookAt(target)
    const mobile=innerWidth<760,hero=1-THREE.MathUtils.smoothstep(progress,.03,.17),desk=THREE.MathUtils.smoothstep(progress,.08,.23)*(1-THREE.MathUtils.smoothstep(progress,.55,.67)),faq=THREE.MathUtils.smoothstep(progress,.59,.72)*(1-THREE.MathUtils.smoothstep(progress,.8,.89)),seated=THREE.MathUtils.smoothstep(progress,.83,1),shortFraming=1-THREE.MathUtils.smoothstep(innerHeight,650,900)
    camera.fov=THREE.MathUtils.lerp(mobile?58+hero*16+desk*8:46+hero*12+desk*19,mobile?96:78+18*shortFraming,seated)
    let offsetX=(-.17*hero+.19*desk-.18*faq)*innerWidth,offsetY=0
    if(mobile){offsetX=0;offsetY=(-.23*hero+.21*desk+.20*faq)*innerHeight}
    offsetY+=seated*((mobile?.22:.21)-.015*shortFraming)*innerHeight;camera.setViewOffset(innerWidth,innerHeight,offsetX,offsetY,innerWidth,innerHeight)
    lotus.update(elapsed,reduced);island.update(elapsed,reduced);companion.update(elapsed,breath,pointer,talking,reduced)
    if(progress>.89&&!hasGreeted&&companion.ready){hasGreeted=true;companion.greet(elapsed)}
    const stationFade=1-THREE.MathUtils.smoothstep(progress,.84,.9);fadeCanopy(stationFade);fadeStations(stationFade)
    const inPrivacy=progress>=.42&&progress<=.58
    if(inPrivacy!==privacyActive){privacyActive=inPrivacy;privacyTween?.kill();privacyTween=gsap.to(island.privacyState,{closure:inPrivacy?1:0,duration:reduced?.35:1.3,ease:'power2.inOut'})}
    for(let i=0;i<island.lanterns.length;i++){
      const lantern=island.lanterns[i],active=i===selectedLantern,follow=1-Math.exp(-5*delta)
      lantern.material.emissiveIntensity=THREE.MathUtils.lerp(lantern.material.emissiveIntensity,active?3.1:.55,follow);lantern.light.intensity=THREE.MathUtils.lerp(lantern.light.intensity,(active?1.6:.2)*stationFade,follow)
      lantern.root.position.y=THREE.MathUtils.lerp(lantern.root.position.y,lantern.restY-(active?.1:0),follow);lantern.root.rotation.z=reduced?0:Math.sin(elapsed*(active?1.1:.6)+i)*.025
      lantern.light.position.copy(lantern.root.position);cordEnd.set(0,.19,0).applyQuaternion(lantern.root.quaternion).add(lantern.root.position);cordDirection.copy(lantern.anchor).sub(cordEnd)
      lantern.cord.position.lerpVectors(lantern.anchor,cordEnd,.5);lantern.cord.scale.y=cordDirection.length();lantern.cord.quaternion.setFromUnitVectors(up,cordDirection.normalize())
    }
    cameraDirection.copy(target).sub(position).normalize()
    glow.update({elapsed,delta,breath,volume,reduced,velocity,cameraDirection})
    glow.core.getWorldPosition(worldCore);environment.update(elapsed,reduced,worldCore,renderer.getPixelRatio())
    lighting.update(frameIndex++);renderer.info.reset();post.render(delta,elapsed,reduced);frame=requestAnimationFrame(render)
  }
  render(performance.now())
  return {
    setProgress(p,v){progress=THREE.MathUtils.clamp(p,0,1);velocity=Number.isFinite(v)?v:0},setPointer(x,y){pointer.set(THREE.MathUtils.clamp(x,-1,1),THREE.MathUtils.clamp(y,-1,1))},setTalking(value){talking=value},setVoice(value){volume=THREE.MathUtils.clamp(value,0,1)},setReduced(value){reduced=value},selectLantern(index){selectedLantern=index>=0&&index<3?index:-1},
    turnPage(){paperTween?.kill();paperOrbitGoal+=Math.PI*2/3;paperTween=gsap.to(island.paperState,{orbit:paperOrbitGoal,duration:reduced?.3:1.2,ease:'power2.inOut'});glow.burst(island.paperCenter,elapsed)},
    async loadCompanion(url){const loaded=await companion.loadModel(url);lighting.refreshShadow();return loaded},
    motion(){return {coreScale:glow.core.scale.toArray(),breath:lastBreath,avatar:companion.pose()}},
    inspect(){
      const avatar=companion.inspect(),projectBox=(box:THREE.Box3):number[]=>{const bounds=[Infinity,Infinity,-Infinity,-Infinity];for(const x of [box.min.x,box.max.x])for(const y of [box.min.y,box.max.y])for(const z of [box.min.z,box.max.z]){const v=new THREE.Vector3(x,y,z).project(camera),px=(v.x*.5+.5)*innerWidth,py=(.5-v.y*.5)*innerHeight;bounds[0]=Math.min(bounds[0],px);bounds[1]=Math.min(bounds[1],py);bounds[2]=Math.max(bounds[2],px);bounds[3]=Math.max(bounds[3],py)}return bounds}
      const lotusBounds=[Infinity,Infinity,-Infinity,-Infinity],vertex=new THREE.Vector3();lotus.group.updateWorldMatrix(true,true)
      lotus.group.traverse(object=>{if(!(object instanceof THREE.Mesh))return;const positions=object.geometry.getAttribute('position');for(let i=0;i<positions.count;i++){vertex.fromBufferAttribute(positions,i).applyMatrix4(object.matrixWorld).project(camera);const x=(vertex.x*.5+.5)*innerWidth,y=(.5-vertex.y*.5)*innerHeight;lotusBounds[0]=Math.min(lotusBounds[0],x);lotusBounds[1]=Math.min(lotusBounds[1],y);lotusBounds[2]=Math.max(lotusBounds[2],x);lotusBounds[3]=Math.max(lotusBounds[3],y)}})
      const sorted=[...frameTimes].sort((a,b)=>a-b),median=sorted[Math.floor(sorted.length/2)]??16.67
      const clearance=Math.min(camera.position.distanceTo(new THREE.Vector3(-1.55,.75,.75))-.55,camera.position.distanceTo(new THREE.Vector3(-1.05,.59,1.55))-.55,camera.position.distanceTo(new THREE.Vector3(-.25,.4,-.55))-1.05)
      const look=post.inspect()
      return {progress,camera:camera.position.toArray(),target:target.toArray(),coreScale:glow.core.scale.toArray(),breath:lastBreath,avatar,framing:{avatar:projectBox(new THREE.Box3(new THREE.Vector3().fromArray(avatar.bounds[0]),new THREE.Vector3().fromArray(avatar.bounds[1]))),lotus:lotusBounds},lanterns:island.lanterns.map(l=>l.material.emissiveIntensity),lanternScreens:island.lanterns.map(l=>{const p=l.body.getWorldPosition(new THREE.Vector3()).project(camera);return [(p.x*.5+.5)*innerWidth,(.5-p.y*.5)*innerHeight]}),privacyClosure:island.privacyState.closure,paperOrbit:island.paperState.orbit,resources:{...renderer.info.memory},calls:renderer.info.render.calls,cinematic:{grass:island.grass.count,petals:lotus.petalCount,particles:glow.particleCount,mistLayers:environment.mists.length,silhouettes:6,bloom:look.bloom,exposure:look.exposure,transmission:lotus.material.transmission,grain:look.grain,fps:1000/median,frameP95:sorted[Math.floor(sorted.length*.95)]??median,triangles:renderer.info.render.triangles,cameraClearance:clearance}}
    },
    dispose(){if(disposed)return;disposed=true;cancelAnimationFrame(frame);privacyTween?.kill();paperTween?.kill();window.removeEventListener('resize',resize);window.removeEventListener('pointerup',onClick);window.removeEventListener('pointermove',onMove);document.removeEventListener('visibilitychange',visibility);renderer.domElement.removeEventListener('webglcontextlost',lost);document.body.classList.remove('lantern-hover');companion.dispose();disposeObject(scene);lighting.dispose();post.dispose();renderer.dispose();renderer.domElement.remove()},
  }
}
