import * as THREE from 'three'
import gsap from 'gsap'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { breathe,disposeObject } from './craft'
import { createIsland } from './island'
import { createLotus } from './lotus'
import { createCompanion } from './companion'
import { createEnvironment } from './environment'
import { calibrateRadiance,lightRay,softHalo } from './optics'
import { random } from './noise'

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
function fadingMaterials(root:THREE.Object3D):(opacity:number)=>void {
  const materials=new Map<THREE.Material,{opacity:number;depthWrite:boolean}>()
  root.traverse(object=>{if(object instanceof THREE.Mesh||object instanceof THREE.Line)for(const mat of Array.isArray(object.material)?object.material:[object.material])materials.set(mat,{opacity:mat.opacity,depthWrite:mat.depthWrite})})
  materials.forEach((_,mat)=>{mat.transparent=true})
  return opacity=>{root.visible=opacity>.001;for(const [mat,rest] of materials){mat.opacity=rest.opacity*opacity;mat.depthWrite=rest.depthWrite&&opacity>.995;if(mat instanceof THREE.ShaderMaterial&&mat.uniforms.uFade)mat.uniforms.uFade.value=opacity}}
}

export async function createSanctuary(host:HTMLElement,onLantern:(index:number)=>void,onLost:()=>void):Promise<SanctuaryScene> {
  let renderer:THREE.WebGLRenderer
  try{renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,powerPreference:'high-performance'})}catch{throw new Error('WebGL unavailable')}
  renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.15;renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap
  renderer.info.autoReset=false;renderer.transmissionResolutionScale=.5
  const scene=new THREE.Scene();scene.background=new THREE.Color('#050D0A');scene.fog=new THREE.FogExp2('#12291e',.028)
  const camera=new THREE.PerspectiveCamera(46,1,.035,120);host.append(renderer.domElement);renderer.domElement.setAttribute('aria-hidden','true')
  const cameraRig=curveRig(cameraWaypoints),targetRig=curveRig(targetWaypoints)
  const environment=createEnvironment(cameraRig.curve);scene.add(environment.group)
  const island=createIsland(),lotus=createLotus(),companion=createCompanion();scene.add(island.group);island.group.add(lotus.group,companion.group)
  const fadeCanopy=fadingMaterials(island.canopy),fadeStations=fadingMaterials(island.stations)
  scene.add(new THREE.AmbientLight('#c8b68b',.28),new THREE.HemisphereLight('#8aaf9d','#101d16',.9))
  const moon=new THREE.DirectionalLight('#b7d1c6',1.7);moon.position.set(-5,8,4);moon.castShadow=true;moon.shadow.mapSize.set(2048,2048);moon.shadow.bias=-.00035;moon.shadow.normalBias=.012;moon.shadow.radius=3;moon.shadow.autoUpdate=false;moon.shadow.needsUpdate=true
  Object.assign(moon.shadow.camera,{left:-5,right:5,top:5,bottom:-5,near:.5,far:22});scene.add(moon)
  const faceFill=new THREE.DirectionalLight('#b6c6ab',.65);faceFill.position.set(-2,2,5);scene.add(faceFill)
  const rim=new THREE.SpotLight('#FFD285',1.8,7,.7,1,2);rim.position.set(1.5,2.8,-2.5);rim.target.position.set(.8,.8,-1.1);scene.add(rim,rim.target)
  const light=new THREE.PointLight('#FFB84D',.13,7,2);light.position.set(-.25,.53,-.55);island.group.add(light)
  const core=new THREE.Mesh(new THREE.SphereGeometry(.215,32,24),new THREE.ShaderMaterial({toneMapped:false,
    vertexShader:'varying vec3 vNormal,vView;void main(){vec4 mv=modelViewMatrix*vec4(position,1.);vNormal=normalMatrix*normal;vView=-mv.xyz;gl_Position=projectionMatrix*mv;}',
    fragmentShader:'varying vec3 vNormal,vView;void main(){float edge=pow(1.-abs(dot(normalize(vNormal),normalize(vView))),2.);gl_FragColor=vec4(mix(vec3(1.35,.95,.44),vec3(1.,.49,.14),edge),1.);}'
  }));core.name='Breathing amber light';core.position.copy(light.position);island.group.add(core)
  const innerHalo=softHalo('#FFD285',.85,.36),outerHalo=softHalo('#FFC276',1.8,.19);innerHalo.position.copy(core.position);outerHalo.position.copy(core.position);island.group.add(innerHalo,outerHalo)
  const lotusRay=lightRay(.25,1.5,'#FFD285',.037);lotusRay.position.set(-.25,.36,-.55);island.group.add(lotusRay)
  const particlesCount=180,particlePositions=new Float32Array(particlesCount*3),seeds=new Float32Array(particlesCount*4),phases=new Float32Array(particlesCount),sizes=new Float32Array(particlesCount),particleColors=new Float32Array(particlesCount*3)
  const amber=new THREE.Color('#FFA733'),mint=new THREE.Color('#E6F5B0'),particleColor=new THREE.Color()
  for(let i=0;i<particlesCount;i++){const a=random(i*11+3)*Math.PI*2,r=Math.sqrt(random(i*13+4))*4.2;seeds.set([Math.cos(a)*r,.2+random(i*17+5)*3.2,Math.sin(a)*r*.8,random(i*19+6)*6.28],i*4);phases[i]=seeds[i*4+3];sizes[i]=1.3+random(i+800)*2.4;particleColor.copy(amber).lerp(mint,random(i+900)).multiplyScalar(1.8);particleColors.set(particleColor.toArray(),i*3)}
  const particleGeometry=new THREE.BufferGeometry();particleGeometry.setAttribute('position',new THREE.BufferAttribute(particlePositions,3));particleGeometry.setAttribute('aPhase',new THREE.BufferAttribute(phases,1));particleGeometry.setAttribute('aSize',new THREE.BufferAttribute(sizes,1));particleGeometry.setAttribute('color',new THREE.BufferAttribute(particleColors,3))
  const particleMaterial=new THREE.ShaderMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,toneMapped:false,vertexColors:true,uniforms:{uTime:{value:0},uOpacity:{value:.4},uSize:{value:1},uPixelRatio:{value:1}},
    vertexShader:'uniform float uTime,uSize,uPixelRatio;attribute float aPhase,aSize;varying vec3 vColor;varying float vTwinkle;void main(){vec4 mv=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*mv;gl_PointSize=clamp(aSize*uSize*uPixelRatio*19./max(.15,-mv.z),1.,24.);vColor=color;vTwinkle=.38+.62*pow(.5+.5*sin(uTime*.7+aPhase),2.);}',
    fragmentShader:'uniform float uOpacity;varying vec3 vColor;varying float vTwinkle;void main(){float d=length(gl_PointCoord-.5)*2.;float a=exp(-d*d*5.)*(1.-smoothstep(.6,1.,d));if(a<.005)discard;gl_FragColor=vec4(vColor,a*uOpacity*vTwinkle);}'})
  const particles=new THREE.Points(particleGeometry,particleMaterial);particles.frustumCulled=false;particles.name='180 amber and mint fireflies';island.group.add(particles)
  const sparkPositions=new Float32Array(15),sparkGeo=new THREE.BufferGeometry();sparkGeo.setAttribute('position',new THREE.BufferAttribute(sparkPositions,3))
  const sparkMat=new THREE.PointsMaterial({size:.035,color:new THREE.Color('#FFD285').multiplyScalar(2),transparent:true,opacity:0,depthWrite:false,blending:THREE.AdditiveBlending,toneMapped:false})
  const sparks=new THREE.Points(sparkGeo,sparkMat);sparks.name='Origami tab sparks';island.group.add(sparks)
  const targetBuffer=new THREE.WebGLRenderTarget(innerWidth,innerHeight,{type:THREE.HalfFloatType,samples:2})
  const composer=new EffectComposer(renderer,targetBuffer),renderPass=new RenderPass(scene,camera)
  const bloom=new UnrealBloomPass(new THREE.Vector2(innerWidth,innerHeight),.85,.55,.25)
  const grade=new ShaderPass({uniforms:{tDiffuse:{value:null},uTime:{value:0},uGrain:{value:.025}},vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader:'uniform sampler2D tDiffuse;uniform float uTime,uGrain;varying vec2 vUv;void main(){vec3 color=texture2D(tDiffuse,vUv).rgb;vec2 p=(vUv-.5)*1.25;float vignette=1.-smoothstep(.18,.88,dot(p,p))*.38;float grain=fract(sin(dot(gl_FragCoord.xy+mod(uTime,97.),vec2(12.9898,78.233)))*43758.5453)-.5;float luma=dot(color,vec3(.2126,.7152,.0722));color=max(vec3(0.),color*vignette+grain*uGrain*(.08+min(1.,luma)*.5));gl_FragColor=vec4(color,1.);}'})
  const output=new OutputPass();composer.addPass(renderPass);composer.addPass(bloom);composer.addPass(grade);composer.addPass(output)
  let progress=0,velocity=0,volume=0,talking=false,reduced=matchMedia('(prefers-reduced-motion: reduce)').matches,disposed=false,frame=0,elapsed=0,lastStamp=0,burst=-100,selectedLantern=-1,hasGreeted=false,parallaxX=0,parallaxY=0,particleActivity=0,lastBreath=0,contextLost=false,privacyActive=false
  let shadowFrame=0,paperOrbitGoal=0,privacyTween:gsap.core.Tween|undefined,paperTween:gsap.core.Tween|undefined
  const frameTimes:number[]=[],pointer=new THREE.Vector2(),position=new THREE.Vector3(),target=new THREE.Vector3(),raycaster=new THREE.Raycaster(),ndc=new THREE.Vector2(),sparkOrigin=new THREE.Vector3(),cameraDirection=new THREE.Vector3(),cordEnd=new THREE.Vector3(),cordDirection=new THREE.Vector3(),up=new THREE.Vector3(0,1,0),worldCore=new THREE.Vector3()
  const resize=():void=>{const w=innerWidth,h=innerHeight,dpr=Math.min(devicePixelRatio,w<760?1.5:1.75);renderer.setPixelRatio(dpr);renderer.setSize(w,h);composer.setPixelRatio(dpr);composer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();particleMaterial.uniforms.uPixelRatio.value=dpr}
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
    const breath=breathe(elapsed);lastBreath=breath;island.group.position.y=reduced?0:Math.sin(elapsed*.6)*.045
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
    const scale=1+breath*.16;core.scale.setScalar(scale);innerHalo.scale.setScalar(.85+breath*.12);outerHalo.scale.setScalar(1.8+breath*.22);innerHalo.material.opacity=.34+breath*.08;outerHalo.material.opacity=.16+breath*.035
    light.intensity=.10+breath*.035+volume*.025;lotusRay.material.uniforms.uTime.value=elapsed;lotusRay.material.uniforms.uOpacity.value=.03+breath*.012
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
    const factor=Math.min(Math.abs(velocity)*.12,1);particleActivity=THREE.MathUtils.lerp(particleActivity,factor,1-Math.exp(-delta/.25));particleMaterial.uniforms.uOpacity.value=.34+particleActivity*.28;particleMaterial.uniforms.uTime.value=reduced?0:elapsed
    particles.geometry.setDrawRange(0,180);cameraDirection.copy(target).sub(position).normalize()
    for(let i=0;i<particlesCount;i++){
      const index=i*3,seed=i*4,phase=seeds[seed+3],drift=reduced?0:elapsed*.06,trail=i/particlesCount
      const motionTime=reduced?0:elapsed,x=seeds[seed]+Math.sin(motionTime*.15+phase)*.1,y=(seeds[seed+1]+drift)%3.3+.12,z=seeds[seed+2]+Math.cos(motionTime*.13+phase)*.1,activity=i<36?particleActivity*.7:0
      particlePositions[index]=THREE.MathUtils.lerp(x,core.position.x-cameraDirection.x*trail*1.5+Math.sin(phase)*.09,activity);particlePositions[index+1]=THREE.MathUtils.lerp(y,core.position.y-cameraDirection.y*trail*1.5+Math.cos(phase)*.06,activity);particlePositions[index+2]=THREE.MathUtils.lerp(z,core.position.z-cameraDirection.z*trail*1.5+Math.cos(phase*2)*.09,activity)
    }
    particleGeometry.attributes.position.needsUpdate=true
    const age=elapsed-burst;sparks.visible=age<1.1
    if(sparks.visible){for(let i=0;i<5;i++){const a=i/5*Math.PI*2;sparkPositions[i*3]=sparkOrigin.x+Math.cos(a)*age*.26;sparkPositions[i*3+1]=sparkOrigin.y+age*.35-age*age*.12;sparkPositions[i*3+2]=sparkOrigin.z+Math.sin(a)*age*.2}sparkGeo.attributes.position.needsUpdate=true;sparkMat.opacity=Math.max(0,1-age/1.1)}
    core.getWorldPosition(worldCore);environment.update(elapsed,reduced,worldCore,renderer.getPixelRatio());grade.uniforms.uTime.value=reduced?0:elapsed
    if(shadowFrame++%3===0)moon.shadow.needsUpdate=true;renderer.info.reset();composer.render(delta);frame=requestAnimationFrame(render)
  }
  calibrateRadiance(scene)
  render(performance.now())
  return {
    setProgress(p,v){progress=THREE.MathUtils.clamp(p,0,1);velocity=Number.isFinite(v)?v:0},setPointer(x,y){pointer.set(THREE.MathUtils.clamp(x,-1,1),THREE.MathUtils.clamp(y,-1,1))},setTalking(value){talking=value},setVoice(value){volume=THREE.MathUtils.clamp(value,0,1)},setReduced(value){reduced=value},selectLantern(index){selectedLantern=index>=0&&index<3?index:-1},
    turnPage(){paperTween?.kill();paperOrbitGoal+=Math.PI*2/3;paperTween=gsap.to(island.paperState,{orbit:paperOrbitGoal,duration:reduced?.3:1.2,ease:'power2.inOut'});burst=elapsed;sparkOrigin.copy(island.paperCenter)},
    async loadCompanion(url){const loaded=await companion.loadModel(url);calibrateRadiance(companion.group);moon.shadow.needsUpdate=true;return loaded},
    motion(){return {coreScale:core.scale.toArray(),breath:lastBreath,avatar:companion.pose()}},
    inspect(){
      const avatar=companion.inspect(),projectBox=(box:THREE.Box3):number[]=>{const bounds=[Infinity,Infinity,-Infinity,-Infinity];for(const x of [box.min.x,box.max.x])for(const y of [box.min.y,box.max.y])for(const z of [box.min.z,box.max.z]){const v=new THREE.Vector3(x,y,z).project(camera),px=(v.x*.5+.5)*innerWidth,py=(.5-v.y*.5)*innerHeight;bounds[0]=Math.min(bounds[0],px);bounds[1]=Math.min(bounds[1],py);bounds[2]=Math.max(bounds[2],px);bounds[3]=Math.max(bounds[3],py)}return bounds}
      const lotusBounds=[Infinity,Infinity,-Infinity,-Infinity],vertex=new THREE.Vector3();lotus.group.updateWorldMatrix(true,true)
      lotus.group.traverse(object=>{if(!(object instanceof THREE.Mesh))return;const positions=object.geometry.getAttribute('position');for(let i=0;i<positions.count;i++){vertex.fromBufferAttribute(positions,i).applyMatrix4(object.matrixWorld).project(camera);const x=(vertex.x*.5+.5)*innerWidth,y=(.5-vertex.y*.5)*innerHeight;lotusBounds[0]=Math.min(lotusBounds[0],x);lotusBounds[1]=Math.min(lotusBounds[1],y);lotusBounds[2]=Math.max(lotusBounds[2],x);lotusBounds[3]=Math.max(lotusBounds[3],y)}})
      const sorted=[...frameTimes].sort((a,b)=>a-b),median=sorted[Math.floor(sorted.length/2)]??16.67
      const clearance=Math.min(camera.position.distanceTo(new THREE.Vector3(-1.55,.75,.75))-.55,camera.position.distanceTo(new THREE.Vector3(-1.05,.59,1.55))-.55,camera.position.distanceTo(new THREE.Vector3(-.25,.4,-.55))-1.05)
      return {progress,camera:camera.position.toArray(),target:target.toArray(),coreScale:core.scale.toArray(),breath:lastBreath,avatar,framing:{avatar:projectBox(new THREE.Box3(new THREE.Vector3().fromArray(avatar.bounds[0]),new THREE.Vector3().fromArray(avatar.bounds[1]))),lotus:lotusBounds},lanterns:island.lanterns.map(l=>l.material.emissiveIntensity),lanternScreens:island.lanterns.map(l=>{const p=l.body.getWorldPosition(new THREE.Vector3()).project(camera);return [(p.x*.5+.5)*innerWidth,(.5-p.y*.5)*innerHeight]}),privacyClosure:island.privacyState.closure,paperOrbit:island.paperState.orbit,resources:{...renderer.info.memory},calls:renderer.info.render.calls,cinematic:{grass:island.grass.count,petals:lotus.petalCount,particles:particlesCount,mistLayers:environment.mists.length,silhouettes:6,bloom:[bloom.strength,bloom.radius,bloom.threshold],exposure:renderer.toneMappingExposure,transmission:lotus.material.transmission,grain:grade.uniforms.uGrain.value,fps:1000/median,frameP95:sorted[Math.floor(sorted.length*.95)]??median,triangles:renderer.info.render.triangles,cameraClearance:clearance}}
    },
    dispose(){if(disposed)return;disposed=true;cancelAnimationFrame(frame);privacyTween?.kill();paperTween?.kill();window.removeEventListener('resize',resize);window.removeEventListener('pointerup',onClick);window.removeEventListener('pointermove',onMove);document.removeEventListener('visibilitychange',visibility);renderer.domElement.removeEventListener('webglcontextlost',lost);document.body.classList.remove('lantern-hover');companion.dispose();disposeObject(scene);moon.shadow.map?.dispose();bloom.dispose();grade.dispose();output.dispose();renderPass.dispose();composer.dispose();renderer.dispose();renderer.domElement.remove()},
  }
}



