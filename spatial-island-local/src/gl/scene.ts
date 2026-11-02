import * as THREE from 'three'
import gsap from 'gsap'
import { breathe,disposeObject } from './craft'
import { createIsland } from './island'
import { createLotus } from './lotus'
import { createCompanion } from './companion'
import { createEnvironment } from './environment'
import { createLighting } from './lighting'
import { createGlow } from './glow'
import { configureRenderer,createPost,detectTier,qualityLadder,qualityPresets,type Tier } from './post'
import { surfaceOrigin } from './surface'

export interface SanctuaryScene {
  setProgress:(progress:number,velocity:number)=>void;setPointer:(x:number,y:number)=>void
  selectLantern:(index:number)=>void;turnPage:()=>void;setTalking:(talking:boolean)=>void
  setVoice:(volume:number)=>void;setReduced:(reduced:boolean)=>void;loadCompanion:(url:string)=>Promise<boolean>
  inspect:()=>SceneInspection
  motion:()=>{coreScale:number[];breath:number;avatar:ReturnType<ReturnType<typeof createCompanion>['pose']>}
  /** Render cost and quality state: tier, pixel ratio, buffer sizes, program and light counts, boot timings. */
  quality?:()=>QualityReport
  dispose:()=>void
}
export interface QualityReport {
  gpu:string;tier:Tier;rung:number;forced:boolean;adaptive:boolean;fpsCap:number;idle:boolean;dpr:number
  scene:number[];samples:number;bloom:number[];transmission:{scale:number;size:number[]};shadow:{size:number;hz:number}
  finery:boolean;programs:number;lights:{point:number;directional:number};boot:[string,number][]
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
/**
 * Fade a subtree without ever switching a shader program (render-2). Toggling `transparent` mid-scroll changed the
 * program key (#define OPAQUE) of every station and willow material and froze the first flight to the chat for ~1 s.
 * Instead, before the first compile: built-in materials get alphaHash and fade by opacity alone (at opacity 1 the hash
 * never discards; mid-fade it dithers under the film grain, while depth writes keep leaves and shards correctly occluded
 * instead of the old sorted-by-object "x-ray"). Custom shaders that read uFade are made transparent once; materials that
 * already blend, or use alpha-to-coverage, only scale their opacity.
 */
function fadingMaterials(root:THREE.Object3D):(opacity:number)=>void {
  const materials=new Map<THREE.Material,number>()
  root.traverse(object=>{
    if(!(object instanceof THREE.Mesh||object instanceof THREE.Line))return
    for(const mat of Array.isArray(object.material)?object.material:[object.material]){
      if(materials.has(mat))continue
      materials.set(mat,mat.opacity)
      if(mat instanceof THREE.ShaderMaterial){if(mat.uniforms.uFade&&!mat.transparent){mat.transparent=true;mat.needsUpdate=true}}
      else if(!mat.transparent&&!mat.alphaToCoverage&&!mat.alphaHash){mat.alphaHash=true;mat.needsUpdate=true}
    }
  })
  let last=-1
  return opacity=>{
    root.visible=opacity>.001;if(opacity===last)return;last=opacity
    for(const [mat,rest] of materials){mat.opacity=rest*opacity;if(mat instanceof THREE.ShaderMaterial&&mat.uniforms.uFade)mat.uniforms.uFade.value=opacity}
  }
}
/** Yield to the event loop between heavy build steps (MessageChannel: not clamped in background tabs like setTimeout). */
function yieldToMain():Promise<void> {
  return new Promise(resolve=>{const channel=new MessageChannel();channel.port1.onmessage=()=>{channel.port1.close();resolve()};channel.port2.postMessage(0)})
}
function within<T>(promise:Promise<T>,ms:number):Promise<T|undefined> {
  return Promise.race([promise,new Promise<undefined>(resolve=>setTimeout(()=>resolve(undefined),ms))])
}
/** User Timing entry for the boot breakdown; older engines without the options form must not break the boot. */
function measure(name:string,start:number|string,end=performance.now()):void {
  try{if(typeof start==='string')performance.measure(`sanctuary:${name}`,start);else performance.measure(`sanctuary:${name}`,{start,end})}catch{/* timing only */}
}

export async function createSanctuary(host:HTMLElement,onLantern:(index:number)=>void,onLost:()=>void):Promise<SanctuaryScene> {
  let renderer:THREE.WebGLRenderer
  try{renderer=new THREE.WebGLRenderer({antialias:false,alpha:false,stencil:false,powerPreference:'high-performance'})}catch{throw new Error('WebGL unavailable')}
  configureRenderer(renderer);renderer.info.autoReset=false
  // Quality: the start rung comes from the GPU name, then frame pacing moves it (see `pace`). In dev, ?quality=high|medium|low
  // pins a tier and ?fps=uncapped lifts the frame cap so --perf runs measure GPU time instead of the 60 fps limit.
  const query=new URLSearchParams(location.search),pinned=import.meta.env.DEV?query.get('quality'):null
  const forced=pinned==='high'||pinned==='medium'||pinned==='low',uncapped=import.meta.env.DEV&&query.get('fps')==='uncapped'
  const detected=detectTier(renderer),startRung=qualityLadder.findIndex(step=>step.tier===(forced?pinned:detected.tier)),adaptive=!forced&&!uncapped,fpsCap=uncapped?0:60
  let rung=startRung,preset=qualityPresets[qualityLadder[rung].tier]
  renderer.transmissionResolutionScale=preset.transmission
  const scene=new THREE.Scene();scene.background=new THREE.Color('#020509');scene.fog=new THREE.FogExp2('#0d2124',.028)
  const camera=new THREE.PerspectiveCamera(46,1,.035,120);host.append(renderer.domElement);renderer.domElement.setAttribute('aria-hidden','true')
  const cameraRig=curveRig(cameraWaypoints),targetRig=curveRig(targetWaypoints)
  // Boot is split into steps with a yield between them, so no single long task blocks the entry animation.
  performance.mark('sanctuary:start')
  const step=async<T>(name:string,build:()=>T):Promise<T>=>{const start=performance.now(),value=build();measure(name,start);await yieldToMain();return value}
  const environment=await step('environment',()=>createEnvironment(cameraRig.curve));scene.add(environment.group)
  const island=await step('island',createIsland)
  const lotus=await step('lotus',createLotus),companion=await step('companion',createCompanion);scene.add(island.group);island.group.add(lotus.group,companion.group)
  // render-7: the three per-lantern lights leave the graph; lighting.lantern is the single light they share.
  for(const lantern of island.lanterns)lantern.light.removeFromParent()
  const fadeCanopy=fadingMaterials(island.canopy),fadeStations=fadingMaterials(island.stations),filaments=island.canopy.getObjectByName('Falling light filaments')
  const lighting=await step('lighting',()=>createLighting(scene,renderer,island.group,{size:preset.shadowSize,hz:preset.shadowHz}))
  const glow=createGlow(island.group),post=createPost(renderer,scene,camera,preset)
  environment.bokeh.visible=preset.finery;if(filaments)filaments.visible=preset.finery
  let progress=0,velocity=0,volume=0,talking=false,reduced=matchMedia('(prefers-reduced-motion: reduce)').matches,disposed=false,frame=0,elapsed=0,lastStamp=0,selectedLantern=-1,hasGreeted=false,parallaxX=0,parallaxY=0,lastBreath=0,contextLost=false,privacyActive=false
  let paperOrbitGoal=0,privacyTween:gsap.core.Tween|undefined,paperTween:gsap.core.Tween|undefined,greetAt=-Infinity,shownAt=-Infinity
  const frameTimes:number[]=[],pointer=new THREE.Vector2(),position=new THREE.Vector3(),target=new THREE.Vector3(),raycaster=new THREE.Raycaster(),ndc=new THREE.Vector2(),cameraDirection=new THREE.Vector3(),cordEnd=new THREE.Vector3(),cordDirection=new THREE.Vector3(),up=new THREE.Vector3(0,1,0),worldCore=new THREE.Vector3()
  const lanternLight=lighting.lantern,lanternGoal=new THREE.Vector3(),lanternWorld=new THREE.Vector3(),lanternFeed={position:lanternWorld,level:0}
  // With no answer open the shared light rests dim inside the middle lantern. Like the old per-lantern lights it always
  // sits inside a paper body, where no leaf or brass cap is close enough to catch a hot spot.
  const restLantern=island.lanterns[Math.floor(island.lanterns.length/2)];lanternLight.position.copy(restLantern.root.position)

  // Frame pacing (render-5): at most 60 fps, 30 fps after 4 s with no scroll, pointer, speech or tween; an accumulating
  // schedule keeps the mean at 60 on 144 Hz panels (a plain "16.7 ms since the last frame" rule would drop to 48).
  let nextDue=0,lastActivity=performance.now(),idle=false
  const wake=():void=>{lastActivity=performance.now();if(idle){idle=false;nextDue=0}}
  // Adaptive quality: windows of 120 rendered frames (or 2 s), measured only while active, warm and capped. A slow window
  // (mean under ~54 fps, or 5% of frames missing two vsyncs) steps one rung down: DPR first, then the tier. Five clean
  // windows probe one rung back up, never above the start; a probe that fails locks further probing.
  const pacing={frames:[] as number[],span:0,good:0,probe:false,noProbe:false,warmUntil:Infinity}
  const holdPacing=(ms:number):void=>{pacing.frames.length=0;pacing.span=0;pacing.good=0;pacing.warmUntil=performance.now()+ms}
  const resize=():void=>{const w=innerWidth,h=innerHeight,ceiling=qualityLadder[rung],dpr=Math.min(devicePixelRatio,w<760?ceiling.mobileDpr:ceiling.dpr);renderer.setPixelRatio(dpr);renderer.setSize(w,h);post.setSize(w,h,dpr);camera.aspect=w/h;camera.updateProjectionMatrix();glow.setPixelRatio(dpr)}
  const onResize=():void=>{resize();wake();if(pacing.warmUntil!==Infinity)holdPacing(1500)}
  const applyQuality=():void=>{
    preset=qualityPresets[qualityLadder[rung].tier];post.setQuality(preset);renderer.transmissionResolutionScale=preset.transmission
    lighting.setShadowQuality(preset.shadowSize,preset.shadowHz);environment.bokeh.visible=preset.finery;if(filaments)filaments.visible=preset.finery;resize();holdPacing(1500)
  }
  const pace=(interval:number):void=>{
    pacing.frames.push(interval);pacing.span+=interval;if(pacing.frames.length<120&&(pacing.span<2000||pacing.frames.length<30))return
    const frames=pacing.frames,sorted=[...frames].sort((a,b)=>a-b),mean=pacing.span/frames.length,p95=sorted[Math.floor(sorted.length*.95)],budget=1000/fpsCap
    pacing.span=0
    frames.length=0
    if(mean>budget*1.12||p95>budget*1.9){pacing.good=0;if(pacing.probe)pacing.noProbe=true;pacing.probe=false;if(rung<qualityLadder.length-1){rung++;applyQuality()}}
    else if(mean<budget*1.03&&p95<budget*1.35){pacing.probe=false;if(++pacing.good>=5&&rung>startRung&&!pacing.noProbe){rung--;pacing.probe=true;applyQuality()}}
    else pacing.good=0
  }
  resize();window.addEventListener('resize',onResize)
  const hit=(event:PointerEvent):number=>{if(progress<.61||progress>.87||event.target instanceof Element&&event.target.closest('button,a,input,textarea,dialog,.glass'))return -1;ndc.set(event.clientX/innerWidth*2-1,-event.clientY/innerHeight*2+1);raycaster.setFromCamera(ndc,camera);const found=raycaster.intersectObjects(island.lanterns.map(l=>l.body),false)[0];return found?island.lanterns.findIndex(l=>l.body===found.object):-1}
  const onClick=(event:PointerEvent):void=>{const index=hit(event);if(index>=0)onLantern(index)}
  const onMove=(event:PointerEvent):void=>{document.body.classList.toggle('lantern-hover',hit(event)>=0)}
  window.addEventListener('pointerup',onClick);window.addEventListener('pointermove',onMove,{passive:true})
  const lost=(event:Event):void=>{event.preventDefault();contextLost=true;cancelAnimationFrame(frame);onLost()};renderer.domElement.addEventListener('webglcontextlost',lost)
  // The loop starts only once the boot compile is done (`booted`), so a tab shown mid-boot cannot start a second loop.
  let booted=false
  const visibility=():void=>{if(!booted)return;lastStamp=0;nextDue=0;wake();holdPacing(1500);cancelAnimationFrame(frame);if(!document.hidden&&!disposed&&!contextLost)frame=requestAnimationFrame(loop)};document.addEventListener('visibilitychange',visibility)
  function loop(stamp:number):void {
    if(disposed||contextLost)return
    frame=requestAnimationFrame(loop)
    if(fpsCap>0){
      // Speech, a running tween or the greeting keep the scene awake; otherwise it idles 4 s after the last input.
      if(talking||volume>.01||privacyTween?.isActive()||paperTween?.isActive()||elapsed-greetAt<3)lastActivity=Math.max(lastActivity,stamp)
      idle=stamp-lastActivity>4000
      const interval=1000/(idle?30:fpsCap)
      if(nextDue&&stamp<nextDue-2)return
      nextDue=nextDue&&stamp-nextDue<interval?nextDue+interval:stamp+interval
    }
    const gap=lastStamp?stamp-lastStamp:0
    render(stamp)
    if(adaptive&&!idle&&gap>0&&gap<500&&stamp>pacing.warmUntil)pace(gap)
  }
  function render(stamp:number):void {
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
    if(progress>.89&&!hasGreeted&&companion.ready){hasGreeted=true;greetAt=elapsed;companion.greet(elapsed)}
    const stationFade=1-THREE.MathUtils.smoothstep(progress,.84,.9);fadeCanopy(stationFade);fadeStations(stationFade)
    const inPrivacy=progress>=.42&&progress<=.58
    if(inPrivacy!==privacyActive){privacyActive=inPrivacy;privacyTween?.kill();privacyTween=gsap.to(island.privacyState,{closure:inPrivacy?1:0,duration:reduced?.35:1.3,ease:'power2.inOut'})}
    for(let i=0;i<island.lanterns.length;i++){
      const lantern=island.lanterns[i],active=i===selectedLantern,follow=1-Math.exp(-5*delta)
      lantern.material.emissiveIntensity=THREE.MathUtils.lerp(lantern.material.emissiveIntensity,active?3.1:.55,follow)
      lantern.root.position.y=THREE.MathUtils.lerp(lantern.root.position.y,lantern.restY-(active?.1:0),follow);lantern.root.rotation.z=reduced?0:Math.sin(elapsed*(active?1.1:.6)+i)*.025
      cordEnd.set(0,.19,0).applyQuaternion(lantern.root.quaternion).add(lantern.root.position);cordDirection.copy(lantern.anchor).sub(cordEnd)
      lantern.cord.position.lerpVectors(lantern.anchor,cordEnd,.5);lantern.cord.scale.y=cordDirection.length();lantern.cord.quaternion.setFromUnitVectors(up,cordDirection.normalize())
    }
    // The shared lantern light glides to the open answer's lantern, dimming while it travels so it reads as one light
    // handing over rather than a moving bulb, and rests dim in the middle lantern when none is open. It fades with the stations.
    lanternGoal.copy((selectedLantern>=0?island.lanterns[selectedLantern]:restLantern).root.position)
    lanternLight.position.lerp(lanternGoal,reduced?1:1-Math.exp(-4*delta))
    const travel=lanternLight.position.distanceTo(lanternGoal)
    // 1.6, not more: the neighbours hang .5–.66 m away and their pale paper catches this light first. At 2.4 the lantern
    // next to the open one washed out brighter than the open one itself (checked on the .75 stop with answer 2 open).
    lanternLight.intensity=THREE.MathUtils.lerp(lanternLight.intensity,(selectedLantern>=0?1.6:.45)*stationFade/(1+travel*4),reduced?1:1-Math.exp(-5*delta))
    lanternLight.getWorldPosition(lanternWorld);lanternFeed.level=lanternLight.intensity/1.6
    cameraDirection.copy(target).sub(position).normalize()
    glow.update({elapsed,delta,breath,volume,reduced,velocity,cameraDirection})
    glow.core.getWorldPosition(worldCore);environment.update(elapsed,reduced,worldCore,renderer.getPixelRatio(),lanternFeed)
    const moving=Boolean(paperTween?.isActive()||privacyTween?.isActive())||elapsed-greetAt<2.6||elapsed-shownAt<1
    lighting.update(elapsed,moving);renderer.info.reset();post.render(delta,elapsed,reduced)
  }
  /**
   * Compile programs in parallel (KHR_parallel_shader_compile) instead of inside the first frame. The scene pass draws
   * into the composer's linear HDR target, so that target is bound while parameters are captured; otherwise every program
   * would be built for the screen (tone mapped, sRGB) and built again on the first frame.
   */
  // The procedural fallback companion stays hidden unless the GLB fails, so it is left out of every compile (compile()
  // walks hidden objects too). It is detached only for the synchronous part of compileAsync, when parameters are captured.
  const precompile=(object:THREE.Object3D):Promise<unknown>=>{
    const previous=renderer.getRenderTarget(),spare=companion.group.children.filter(child=>!child.visible)
    spare.forEach(child=>child.removeFromParent());renderer.setRenderTarget(post.target())
    try{return within(renderer.compileAsync(object,camera,scene),8000)}finally{renderer.setRenderTarget(previous);spare.forEach(child=>companion.group.add(child))}
  }
  performance.mark('sanctuary:compile-start')
  const compiled=Promise.all([precompile(scene),within(post.warmup(),8000)])
  // While the GPU process compiles, the main thread is free: upload the procedural textures now instead of in frame one.
  const textures=new Set<THREE.Texture>()
  const collect=(object:THREE.Object3D):void=>{
    if(!object.visible&&object.parent===companion.group)return
    if(object instanceof THREE.Mesh||object instanceof THREE.Points||object instanceof THREE.Line||object instanceof THREE.Sprite)for(const mat of Array.isArray(object.material)?object.material:[object.material]){
      for(const value of Object.values(mat))if(value instanceof THREE.Texture)textures.add(value)
      if(mat instanceof THREE.ShaderMaterial)for(const uniform of Object.values(mat.uniforms))if(uniform.value instanceof THREE.Texture)textures.add(uniform.value)
    }
    for(const child of object.children)collect(child)
  }
  collect(scene)
  for(const texture of textures)if(!texture.isRenderTargetTexture)renderer.initTexture(texture)
  await compiled;measure('compile','sanctuary:compile-start')
  // The first frame still builds the small shadow-depth programs (compile() does not cover them).
  const firstFrame=performance.now();render(firstFrame);measure('first-frame',firstFrame)
  measure('boot','sanctuary:start')
  booted=true;lastStamp=firstFrame;if(!document.hidden&&!disposed&&!contextLost)frame=requestAnimationFrame(loop);holdPacing(2500)
  const report=():QualityReport=>{
    let point=0,directional=0;scene.traverseVisible(object=>{if(object instanceof THREE.PointLight)point++;else if(object instanceof THREE.DirectionalLight)directional++})
    const sizes=post.sizes(),buffer=renderer.getDrawingBufferSize(new THREE.Vector2()),scale=renderer.transmissionResolutionScale
    return {gpu:detected.gpu,tier:preset.tier,rung,forced,adaptive,fpsCap,idle,dpr:renderer.getPixelRatio(),scene:sizes.scene,samples:sizes.samples,bloom:sizes.bloom,transmission:{scale,size:[Math.floor(buffer.x*scale),Math.floor(buffer.y*scale)]},shadow:{size:lighting.moon.shadow.mapSize.x,hz:preset.shadowHz},
      finery:preset.finery,programs:renderer.info.programs?.length??0,lights:{point,directional},boot:performance.getEntriesByType('measure').filter(m=>m.name.startsWith('sanctuary:')).map(m=>[m.name.slice(10),Math.round(m.duration)] as [string,number])}
  }
  if(import.meta.env.DEV)Object.defineProperty(window,'__sanctuaryPerf',{configurable:true,value:report})
  return {
    // main.ts calls setProgress on every ticker frame: only a real change of value or velocity counts as activity.
    setProgress(p,v){const next=THREE.MathUtils.clamp(p,0,1),speed=Number.isFinite(v)?v:0;if(Math.abs(next-progress)>1e-5||Math.abs(speed)>.01)wake();progress=next;velocity=speed},
    setPointer(x,y){const nx=THREE.MathUtils.clamp(x,-1,1),ny=THREE.MathUtils.clamp(y,-1,1);if(nx!==pointer.x||ny!==pointer.y)wake();pointer.set(nx,ny)},
    setTalking(value){talking=value;wake()},setVoice(value){volume=THREE.MathUtils.clamp(value,0,1);if(volume>.01)wake()},setReduced(value){reduced=value;wake()},selectLantern(index){selectedLantern=index>=0&&index<3?index:-1;wake()},
    turnPage(){wake();paperTween?.kill();paperOrbitGoal+=Math.PI*2/3;paperTween=gsap.to(island.paperState,{orbit:paperOrbitGoal,duration:reduced?.3:1.2,ease:'power2.inOut'});glow.burst(island.paperCenter,elapsed)},
    async loadCompanion(url){
      const loaded=await companion.loadModel(url)
      // The knit GLB arrives after boot: compile it in parallel while it stays hidden, so it never stalls a frame.
      if(loaded&&!disposed&&!contextLost){const start=performance.now();companion.group.visible=false;try{await precompile(companion.group)}finally{companion.group.visible=true}measure('avatar-compile',start)}
      lighting.refreshShadow();shownAt=elapsed;wake();holdPacing(2000);return loaded
    },
    quality:report,
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
    dispose(){if(disposed)return;disposed=true;cancelAnimationFrame(frame);privacyTween?.kill();paperTween?.kill();window.removeEventListener('resize',onResize);if(import.meta.env.DEV)Reflect.deleteProperty(window,'__sanctuaryPerf');window.removeEventListener('pointerup',onClick);window.removeEventListener('pointermove',onMove);document.removeEventListener('visibilitychange',visibility);renderer.domElement.removeEventListener('webglcontextlost',lost);document.body.classList.remove('lantern-hover');companion.dispose();disposeObject(scene);lighting.dispose();post.dispose();renderer.dispose();renderer.domElement.remove()},
  }
}
