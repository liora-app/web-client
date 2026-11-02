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
  selectLantern:(index:number)=>void;setTalking:(talking:boolean)=>void
  /** Bring folio `index` (the selected direction tab, 0…2) to the front the short way round; `instant` skips the turn. */
  turnPage:(index:number,instant?:boolean)=>void
  setVoice:(volume:number)=>void;setReduced:(reduced:boolean)=>void;loadCompanion:(url:string)=>Promise<boolean>
  /** A programmatic flight crosses stops on its way to stop `target` (-1: none): the stops it passes stay quiet. */
  setTransit:(target:number)=>void
  /** Stop drawing (e.g. while the help dialog covers the scene); resuming never makes the scene clock jump. */
  setPaused:(paused:boolean)=>void
  /** Top edge (CSS px) of each stop's panel: on phones the station is framed in the band between the header and it. */
  setPanelTops:(tops:number[])=>void
  /** Camera arc length (0…1) at the five stops, for flights that keep the camera's speed even across the stops. */
  readonly arcKnots:number[]
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
interface SceneInspection {progress:number;camera:number[];target:number[];coreScale:number[];breath:number;avatar:AvatarInspection;framing:{avatar:number[];lotus:number[]};lanterns:number[];lanternScreens:number[][];privacyClosure:number;paperOrbit:number;paperFront:number;fov:number;transit:number;resources:{geometries:number;textures:number};calls:number;cinematic:{grass:number;petals:number;particles:number;mistLayers:number;silhouettes:number;bloom:number[];exposure:number;transmission:number;grain:number;fps:number;frameP95:number;triangles:number;cameraClearance:number}}
export const cameraWaypoints=[[-2.1,2,5.6],[-2.25,1.1,1.95],[-1.75,.65,2.65],[.25,1.75,2.1],[0,1.35,1.85]]
export const targetWaypoints=[[.5,.45,0],[-1.55,.66,.75],[-1.05,.56,1.55],[1.35,2.3,-.3],[0,.55,-.8]]
function curveRig(points:number[][]):{curve:THREE.CatmullRomCurve3;sample:(p:number,out:THREE.Vector3)=>THREE.Vector3} {
  const curve=new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(p[0],p[1],p[2])),false,'centripetal');curve.arcLengthDivisions=1000
  const lengths=curve.getLengths(1000),total=lengths[1000],knots=[0,250,500,750,1000].map(i=>lengths[i]/total)
  return {curve,sample(p,out){const segment=Math.min(3,Math.floor(p*4)),fraction=p*4-segment;return curve.getPointAt(THREE.MathUtils.lerp(knots[segment],knots[segment+1],fraction),out)}}
}
/**
 * Lens and view offset are set per stop and carried between two stops by one smoothstep per leg (motion-10): every value
 * moves monotonically on each leg, so the first scroll no longer zooms in and back out, and at the stops the values are
 * exact. FOV in degrees; offsets as fractions of the viewport (+x moves the scene left, +y lifts it).
 */
const FOV_LEGS=[[.03,.23],[.29,.46],[.55,.67],[.83,1]],OFFSET_LEGS=[[.03,.23],[.29,.46],[.55,.72],[.8,.94]]
function blend(stops:number[],legs:number[][],p:number):number {
  let value=stops[0]
  for(let k=0;k<4;k++)value+=(stops[k+1]-stops[k])*THREE.MathUtils.smoothstep(p,legs[k][0],legs[k][1])
  return value
}
/** The breakpoint of style.css itself (max-width: 760px, i.e. ≤ 760): phones dock the stop panels to the bottom. */
const phoneQuery=matchMedia('(max-width: 760px)'),isPhone=():boolean=>phoneQuery.matches
/**
 * Phones (art-5, motion-8): the panels of stops 1–3 are bottom sheets, so the station must stand in the band between the
 * 80 px header and the sheet's top edge. The lens of each stop is tuned on 390×844 for that band and scaled with the
 * band's share of the screen elsewhere (a short phone widens the lens instead of cropping the station); the vertical
 * offset then puts the station's anchor in the middle of the band. A band thinner than bandFloor of the screen cannot
 * hold a station: there the lens stops widening and the station keeps its top above the sheet. Where the band is too thin
 * for all three lanterns (lanternsBand, e.g. a short phone whose FAQ sheet grows with an open answer), the frame follows
 * the lit lantern instead, so the answer's light is always seen. Panel tops can change (answers, steps): the framing then
 * glides to its new value instead of jumping.
 */
const PHONE={header:80,referenceHeight:844,referenceBand:[0,255,327,284],fov:[74,82,78,56,96],maxFov:84,bandFloor:.16,heroShift:-.1,lanternsBand:150}
/**
 * The character only belongs to the hero and the final stop (render-6, art-11, motion-7): between them it peeks from
 * behind the folios, over the shell and from the bottom edge under the lanterns. Presence is a target for the companion's
 * own spring (~.45 s, alpha-hashed, no recompile); these windows are where the figure is clear of the frame edges.
 */
const PRESENCE_OUT=[.06,.14],PRESENCE_IN=[.86,.94]
/**
 * Greeting (motion-14e): at the final stop, scroll at rest, character shown (presence still rising past .8 while the
 * hold runs, so it is ≈.95 when the wave starts and ≥.97 once the arm is up ~.2 s later), held for GREET_HOLD seconds.
 */
const GREET_HOLD=.2,GREET_PRESENCE=.8,GREET_REACH=.025,GREET_VELOCITY=.5
/** Privacy (motion-11): the shell closes once the camera has (almost) arrived at .5, after a short beat, within 1.3 s. */
const PRIVACY_ARRIVE=.03,PRIVACY_LEAVE=.08,PRIVACY_BEAT=.15,PRIVACY_CLOSE=1.1
/** One folio step on the altar carousel; folio i faces the .25 camera at orbit (1 - i)·PAGE (the front slot is at 2π/3). */
const PAGE=Math.PI*2/3
/**
 * The shared lantern light only warms the cords, caps and leaves right at the open lantern: the willow's warm pool is
 * emissive (willow.ts), and the neighbours hang .54–.66 m away, so the light ends before their paper (reach, metres).
 */
const LANTERN_REACH=.55,LANTERN_LIT=1.2,LANTERN_REST=.3
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
  // The camera's arc length at each stop (the same knots curveRig samples with; getLengths reads its cache).
  const cameraLengths=cameraRig.curve.getLengths(1000),arcKnots=[0,250,500,750,1000].map(i=>cameraLengths[i]/cameraLengths[1000])
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
  let privacyTween:gsap.core.Tween|undefined,paperTween:gsap.core.Tween|undefined,greetAt=-Infinity,shownAt=-Infinity,paused=false,transitTo=-1,greetHold=0,privacyHold=0
  // Folio 0 faces the camera to match the first direction tab (motion-6); turnPage(index) keeps the two in step.
  let paperIndex=0;island.paperState.orbit=PAGE*(1-paperIndex)
  // Framing per stop (see blend): desktop values are fixed, phone values follow the measured panel tops (reframe).
  // `framing` is what is drawn; it eases towards `frameGoal` (a resize snaps it).
  const framing={fov:[0,0,0,0,0],x:[0,0,0,0,0],y:[0,0,0,0,0]},frameGoal={fov:[0,0,0,0,0],x:[0,0,0,0,0],y:[0,0,0,0,0]}
  // `freshLayout`: the viewport changed and the panel tops held are stale; the next measurement snaps instead of gliding.
  let freshLayout=true
  const panelTops:number[]=[],probe=new THREE.PerspectiveCamera(),probeTarget=new THREE.Vector3(),litAnchor=new THREE.Vector3()
  const lanternCentre=island.lanterns.reduce((sum,l)=>sum.add(l.root.getWorldPosition(probeTarget)),new THREE.Vector3()).divideScalar(island.lanterns.length)
  const stationAnchors=[new THREE.Vector3(...targetWaypoints[0]),new THREE.Vector3(-1.55,.8,.75),island.privacyCore.getWorldPosition(new THREE.Vector3()),lanternCentre.setY(lanternCentre.y-.05),new THREE.Vector3(...targetWaypoints[4])]
  /** Screen y (CSS px) of stop k's anchor seen from stop k's camera through `fov`, without any view offset. */
  const anchorY=(k:number,fov:number,anchor:THREE.Vector3):number=>{
    probe.fov=fov;probe.aspect=innerWidth/innerHeight;probe.updateProjectionMatrix();probe.position.fromArray(cameraWaypoints[k]);probe.lookAt(probeTarget.fromArray(targetWaypoints[k]));probe.updateMatrixWorld()
    return (.5-probeTarget.copy(anchor).project(probe).y*.5)*innerHeight
  }
  const reframe=(snap:boolean):void=>{
    const h=innerHeight,short=1-THREE.MathUtils.smoothstep(h,650,900),goal=frameGoal
    if(!isPhone()){goal.fov=[58,65,65,46,78+18*short];goal.x=[-.17,.19,.19,-.18,0];goal.y=[0,0,0,0,.21-.015*short]}
    else{
      goal.fov=[...PHONE.fov];goal.x=[PHONE.heroShift,0,0,0,0];goal.y=[-.23,.21,.21,.2,.22-.015*short]
      for(let k=1;k<=3;k++){
        const top=panelTops[k];if(!(top>PHONE.header))continue
        // Lens: same share of the band as on the reference phone, never narrower than the reference, never wider than maxFov.
        const band=Math.max(top-PHONE.header,PHONE.bandFloor*h),share=PHONE.referenceBand[k]/PHONE.referenceHeight
        const fov=THREE.MathUtils.radToDeg(2*Math.atan(Math.tan(THREE.MathUtils.degToRad(PHONE.fov[k])/2)*share/(band/h)))
        goal.fov[k]=THREE.MathUtils.clamp(fov,PHONE.fov[k],PHONE.maxFov)
        let anchor=stationAnchors[k]
        if(k===3&&selectedLantern>=0){
          const lit=island.lanterns[selectedLantern],follow=THREE.MathUtils.clamp((PHONE.lanternsBand-band)/60,0,1)
          anchor=litAnchor.set(lit.root.position.x,lit.restY-.1,lit.root.position.z).lerp(stationAnchors[3],1-follow)
        }
        // Offset: the anchor goes to the middle of the band (a positive offset lifts the scene).
        goal.y[k]=(anchorY(k,goal.fov[k],anchor)-(PHONE.header+band/2))/h
      }
    }
    if(snap)for(const key of ['fov','x','y'] as const)framing[key]=[...goal[key]]
  }
  const frameTimes:number[]=[],pointer=new THREE.Vector2(),position=new THREE.Vector3(),target=new THREE.Vector3(),raycaster=new THREE.Raycaster(),ndc=new THREE.Vector2(),cameraDirection=new THREE.Vector3(),cordEnd=new THREE.Vector3(),cordDirection=new THREE.Vector3(),up=new THREE.Vector3(0,1,0),worldCore=new THREE.Vector3()
  const lanternLight=lighting.lantern,lanternGoal=new THREE.Vector3(),lanternWorld=new THREE.Vector3(),lanternFeed={position:lanternWorld,level:0}
  // With no answer open the shared light rests dim inside the middle lantern. Like the old per-lantern lights it always
  // sits inside a paper body, where no leaf or brass cap is close enough to catch a hot spot.
  const restLantern=island.lanterns[Math.floor(island.lanterns.length/2)];lanternLight.position.copy(restLantern.root.position)
  // Short reach (a uniform, no recompile): see LANTERN_REACH.
  lanternLight.distance=LANTERN_REACH

  // Frame pacing (render-5): at most 60 fps, 30 fps after 4 s with no scroll, pointer, speech or tween; an accumulating
  // schedule keeps the mean at 60 on 144 Hz panels (a plain "16.7 ms since the last frame" rule would drop to 48).
  let nextDue=0,lastActivity=performance.now(),idle=false
  const wake=():void=>{lastActivity=performance.now();if(idle){idle=false;nextDue=0}}
  // Adaptive quality: windows of 120 rendered frames (or 2 s), measured only while active, warm and capped. A slow window
  // (mean under ~54 fps, or 5% of frames missing two vsyncs) steps one rung down: DPR first, then the tier. Five clean
  // windows probe one rung back up, never above the start; a probe that fails locks further probing.
  const pacing={frames:[] as number[],span:0,good:0,probe:false,noProbe:false,warmUntil:Infinity}
  const holdPacing=(ms:number):void=>{pacing.frames.length=0;pacing.span=0;pacing.good=0;pacing.warmUntil=performance.now()+ms}
  const resize=():void=>{const w=innerWidth,h=innerHeight,ceiling=qualityLadder[rung],dpr=Math.min(devicePixelRatio,isPhone()?ceiling.mobileDpr:ceiling.dpr);renderer.setPixelRatio(dpr);renderer.setSize(w,h);post.setSize(w,h,dpr);camera.aspect=w/h;camera.updateProjectionMatrix();glow.setPixelRatio(dpr);reframe(true);freshLayout=true}
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
  // A lantern counts as clicked only when the press starts and ends on it without travelling (motion-14f): releasing a
  // text selection or a drag over a lantern no longer toggles an answer.
  let press:{id:number;index:number;x:number;y:number}|undefined
  const onPress=(event:PointerEvent):void=>{const index=hit(event);press=index>=0?{id:event.pointerId,index,x:event.clientX,y:event.clientY}:undefined}
  const onClick=(event:PointerEvent):void=>{
    const down=press;press=undefined
    if(!down||down.id!==event.pointerId||Math.hypot(event.clientX-down.x,event.clientY-down.y)>(event.pointerType==='touch'?10:6))return
    if(hit(event)===down.index)onLantern(down.index)
  }
  const onCancel=():void=>{press=undefined}
  const onMove=(event:PointerEvent):void=>{if(event.pointerType!=='touch')document.body.classList.toggle('lantern-hover',hit(event)>=0)}
  window.addEventListener('pointerdown',onPress);window.addEventListener('pointerup',onClick);window.addEventListener('pointercancel',onCancel);window.addEventListener('pointermove',onMove,{passive:true})
  const lost=(event:Event):void=>{event.preventDefault();contextLost=true;cancelAnimationFrame(frame);onLost()};renderer.domElement.addEventListener('webglcontextlost',lost)
  // The loop starts only once the boot compile is done (`booted`), so a tab shown mid-boot cannot start a second loop.
  let booted=false
  // Also the resume path of setPaused: lastStamp=0 makes the next frame a 1/60 s step, so the scene clock never jumps.
  const visibility=():void=>{if(!booted)return;lastStamp=0;nextDue=0;wake();holdPacing(1500);cancelAnimationFrame(frame);if(!document.hidden&&!disposed&&!contextLost&&!paused)frame=requestAnimationFrame(loop)};document.addEventListener('visibilitychange',visibility)
  function loop(stamp:number):void {
    if(disposed||contextLost||paused)return
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
    const glide=reduced?1:1-Math.exp(-4*delta)
    for(const key of ['fov','x','y'] as const)for(let k=0;k<5;k++)framing[key][k]+=(frameGoal[key][k]-framing[key][k])*glide
    camera.fov=blend(framing.fov,FOV_LEGS,progress)
    camera.setViewOffset(innerWidth,innerHeight,blend(framing.x,OFFSET_LEGS,progress)*innerWidth,blend(framing.y,OFFSET_LEGS,progress)*innerHeight,innerWidth,innerHeight)
    companion.setPresence?.(1-THREE.MathUtils.smoothstep(progress,PRESENCE_OUT[0],PRESENCE_OUT[1])+THREE.MathUtils.smoothstep(progress,PRESENCE_IN[0],PRESENCE_IN[1]))
    lotus.update(elapsed,reduced);island.update(elapsed,reduced);companion.update(elapsed,breath,pointer,talking,reduced)
    // The wave waits for the character to be there and the camera to rest at the final stop (motion-14e), so its peak no
    // longer lands mid-flight; a flight bound elsewhere never greets on the way.
    const atRest=!hasGreeted&&companion.ready&&(transitTo<0||transitTo===4)&&Math.abs(progress-1)<GREET_REACH&&Math.abs(velocity)<GREET_VELOCITY&&companion.presence>=GREET_PRESENCE
    greetHold=atRest?greetHold+delta:0
    if(greetHold>=GREET_HOLD){hasGreeted=true;greetAt=elapsed;companion.greet(elapsed)}
    const stationFade=1-THREE.MathUtils.smoothstep(progress,.84,.9);fadeCanopy(stationFade);fadeStations(stationFade)
    // The shell seals once the camera has all but arrived (and not on a flight bound elsewhere), after a short beat, and
    // opens as soon as the camera leaves the stop: closing used to start at .42 and be over before the camera arrived.
    const fromPrivacy=Math.abs(progress-.5),mayClose=transitTo<0||transitTo===2
    const arrived=mayClose&&fromPrivacy<PRIVACY_ARRIVE
    privacyHold=!privacyActive&&arrived?privacyHold+delta:0
    const sealing=privacyActive?fromPrivacy<=PRIVACY_LEAVE:arrived&&privacyHold>=(reduced?0:PRIVACY_BEAT)
    if(sealing!==privacyActive){privacyActive=sealing;privacyHold=0;privacyTween?.kill();privacyTween=gsap.to(island.privacyState,{closure:sealing?1:0,duration:reduced?.35:PRIVACY_CLOSE,ease:'power2.inOut'})}
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
    // The neighbours hang .54–.66 m away and their pale paper used to catch this light first (at reach 3.2 and 2.4 the
    // lantern next to the open one washed out brighter than the open one); the short reach now ends before them.
    lanternLight.intensity=THREE.MathUtils.lerp(lanternLight.intensity,(selectedLantern>=0?LANTERN_LIT:LANTERN_REST)*stationFade/(1+travel*4),reduced?1:1-Math.exp(-5*delta))
    lanternLight.getWorldPosition(lanternWorld);lanternFeed.level=lanternLight.intensity/LANTERN_LIT
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
  booted=true;lastStamp=firstFrame;if(!document.hidden&&!disposed&&!contextLost&&!paused)frame=requestAnimationFrame(loop);holdPacing(2500)
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
    setTalking(value){talking=value;wake()},setVoice(value){volume=THREE.MathUtils.clamp(value,0,1);if(volume>.01)wake()},setReduced(value){reduced=value;wake()},selectLantern(index){selectedLantern=index>=0&&index<3?index:-1;reframe(false);wake()},
    turnPage(index,instant=false){
      const next=((Math.round(index)%3)+3)%3;if(!Number.isFinite(next)||next===paperIndex&&!instant)return
      // The same folio comes round every 2π: take the turn that is nearest to where the carousel is now.
      const base=PAGE*(1-next),now=island.paperState.orbit,goal=base+Math.PI*2*Math.round((now-base)/(Math.PI*2))
      paperIndex=next;paperTween?.kill();paperTween=undefined;wake()
      if(instant){island.paperState.orbit=goal;return}
      paperTween=gsap.to(island.paperState,{orbit:goal,duration:reduced?.3:1.2,ease:'power2.inOut'});glow.burst(island.paperCenter,elapsed)
    },
    setTransit(value){const next=Number.isInteger(value)&&value>=0&&value<=4?value:-1;if(next!==transitTo){transitTo=next;wake()}},
    setPaused(value){if(value===paused)return;paused=value;visibility()},
    setPanelTops(tops){panelTops.length=0;for(const top of tops)panelTops.push(Number.isFinite(top)?top:NaN);reframe(freshLayout);freshLayout=false;wake()},
    arcKnots,
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
      return {progress,camera:camera.position.toArray(),target:target.toArray(),coreScale:glow.core.scale.toArray(),breath:lastBreath,avatar,framing:{avatar:projectBox(new THREE.Box3(new THREE.Vector3().fromArray(avatar.bounds[0]),new THREE.Vector3().fromArray(avatar.bounds[1]))),lotus:lotusBounds},lanterns:island.lanterns.map(l=>l.material.emissiveIntensity),lanternScreens:island.lanterns.map(l=>{const p=l.body.getWorldPosition(new THREE.Vector3()).project(camera);return [(p.x*.5+.5)*innerWidth,(.5-p.y*.5)*innerHeight]}),privacyClosure:island.privacyState.closure,paperOrbit:island.paperState.orbit,paperFront:((Math.round((PAGE-island.paperState.orbit)/PAGE)%3)+3)%3,fov:camera.fov,transit:transitTo,resources:{...renderer.info.memory},calls:renderer.info.render.calls,cinematic:{grass:island.grass.count,petals:lotus.petalCount,particles:glow.particleCount,mistLayers:environment.mists.length,silhouettes:6,bloom:look.bloom,exposure:look.exposure,transmission:lotus.material.transmission,grain:look.grain,fps:1000/median,frameP95:sorted[Math.floor(sorted.length*.95)]??median,triangles:renderer.info.render.triangles,cameraClearance:clearance}}
    },
    dispose(){if(disposed)return;disposed=true;cancelAnimationFrame(frame);privacyTween?.kill();paperTween?.kill();window.removeEventListener('resize',onResize);if(import.meta.env.DEV)Reflect.deleteProperty(window,'__sanctuaryPerf');window.removeEventListener('pointerdown',onPress);window.removeEventListener('pointerup',onClick);window.removeEventListener('pointercancel',onCancel);window.removeEventListener('pointermove',onMove);document.removeEventListener('visibilitychange',visibility);renderer.domElement.removeEventListener('webglcontextlost',lost);document.body.classList.remove('lantern-hover');companion.dispose();disposeObject(scene);lighting.dispose();post.dispose();renderer.dispose();renderer.domElement.remove()},
  }
}
