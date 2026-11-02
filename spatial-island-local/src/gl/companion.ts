import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { batchStatic,disposeObject,ellipsoid,grainTexture,material,mesh,tube } from './craft'
import { noise3,random } from './noise'

export interface Companion {
  group:THREE.Group
  headGroup:THREE.Group
  torsoGroup:THREE.Group
  rightArmGroup:THREE.Group
  leftArmGroup:THREE.Group
  eyesMesh:THREE.Group
  /** Procedural stand-in (child of the presence-carrying body); hidden unless the GLB fails. */
  fallback:THREE.Object3D
  readonly ready:boolean
  readonly source:'loading'|'glb'|'fallback'
  /** How much of the character is drawn right now, 0…1 (entrance × presence spring); cheap, unlike inspect(). */
  readonly presence:number
  update:(time:number,breath:number,pointer:THREE.Vector2,talking:boolean,reduced:boolean)=>void
  /**
   * Wave once, starting at `time` (the clock passed to update; a later time schedules it). A call while a wave is
   * still playing is ignored; a call that arrives before the entrance, or while presence is held below .5, waits
   * until the character shows. Under reduced motion it is a no-op.
   */
  greet:(time:number)=>void
  /**
   * Show (1) or hide (0) the character, e.g. at stations where it would only peek in at the frame edge. The value is
   * a target: the companion eases towards it on a critically damped spring (~.45 s), so a plain switch and an
   * already smoothed scroll window both work. Nothing recompiles: every companion material is alpha-hashed from its
   * first frame and only `opacity` changes, so the body dissolves without sorting artefacts and its moon shadow thins
   * out with it. At 1 the character is fully opaque; near 0 it is not drawn at all (no draw call, no shadow).
   */
  setPresence?:(value:number)=>void
  loadModel:(url:string)=>Promise<boolean>
  pose:()=>{source:string;bones:string[];rightHand:number[];leftHand:number[]}
  /** Pose and world box as drawn; `settled` measures the figure at full size, as it stands once the entrance is over. */
  inspect:(settled?:boolean)=>{source:string;bones:string[];rightHand:number[];leftHand:number[];bounds:number[][];presence:number}
  dispose:()=>void
}

/** Scalar spring. It is stepped in fixed 1/240 s slices, so a pose depends on elapsed time and never on the frame rate. */
interface Spring {x:number;v:number}
const SLICE=1/240,TAU=Math.PI*2,SIDES=[-1,1] as const
const ARM_BONES=[['upper_arm.R','forearm.R','hand.R'],['upper_arm.L','forearm.L','hand.L']] as const,SHOULDERS=['upper_arm.L','upper_arm.R'] as const
/** Lotus core in the island frame the companion group shares (glow.ts: the light above the lotus). */
const LOTUS_CORE=new THREE.Vector3(-.25,.53,-.55)
const spring=():Spring=>({x:0,v:0})
/** omega: stiffness in rad/s; zeta: 1 = critically damped, below 1 overshoots. snap: jump straight to the target. */
function drive(s:Spring,target:number,omega:number,zeta:number,dt:number,snap:boolean):number {
  if(snap){s.x=target;s.v=0;return target}
  for(let left=dt;left>0;left-=SLICE){const h=Math.min(left,SLICE);s.v+=(omega*omega*(target-s.x)-2*zeta*omega*s.v)*h;s.x+=s.v*h}
  return s.x
}
/** Greeting length in seconds: anticipation, raise, waves and the settle back onto the knee. */
const GREET_LENGTH=2.6
/** Entrance after a model arrives: hashed fade-in time and the size it settles up from. */
const ENTRANCE=.6,ENTRANCE_SCALE=.96
/** 0 → 1 over [a,b], held, 1 → 0 over [c,d]; smooth at every corner. */
const window4=(x:number,a:number,b:number,c:number,d:number):number=>THREE.MathUtils.smoothstep(x,a,b)*(1-THREE.MathUtils.smoothstep(x,c,d))

/**
 * Knitted clay toy: the Tripo base colour stays the only texture. Sheen gives the yarn its soft warm fuzz along the
 * silhouette, a low specular keeps it matte instead of plastic, and the painted cables double as a bump map.
 */
function knitMaterial(source:THREE.MeshStandardMaterial):THREE.MeshPhysicalMaterial {
  const map=source.map;if(map)map.anisotropy=8
  // alphaHash is on from the first compile so presence fades are a uniform change only (the base colour is opaque
  // lossy WebP, so at opacity 1 no fragment is ever discarded).
  const result=new THREE.MeshPhysicalMaterial({
    name:source.name,map,color:source.color,metalness:0,roughness:.86,specularIntensity:.42,
    sheen:1,sheenColor:new THREE.Color('#ffd9b5'),sheenColorMap:map,sheenRoughness:.5,bumpMap:map,bumpScale:.9,alphaHash:true,
  })
  source.dispose();return result
}

export function createCompanion():Companion {
  const group=new THREE.Group();group.name='CompanionCharacter';group.position.set(.8,.15,-1.1)
  // `body` carries presence: the entrance scale (pivot at the cushion, so the figure settles onto its seat) and the
  // draw switch. `figure` stays the procedural-vs-GLB switch.
  const body=new THREE.Group();body.name='CompanionBody';group.add(body)
  const figure=new THREE.Group();figure.visible=false;body.add(figure)
  const clay=grainTexture('clay'),knit=grainTexture('knit');knit.repeat.set(2,2)
  const skin=material('#bc9a75',.94,clay,.012),sweater=material('#677b53',.98,knit,.018),cuff=material('#4e6143',.98,knit,.013),trousers=material('#5c5241',.95,clay,.01),eye=material('#1b2118',.65),thread=material('#a1ac82',1),wood=material('#765435',.9,clay,.02)
  const torsoGroup=new THREE.Group();torsoGroup.name='torsoGroup';figure.add(torsoGroup);torsoGroup.position.y=.38
  ellipsoid(torsoGroup,sweater,0,.13,0,.29,.32,.2)
  const hem=mesh(new THREE.CylinderGeometry(.265,.25,.075,32),cuff,torsoGroup,0,-.065,.0);hem.scale.z=.73
  const collar=mesh(new THREE.TorusGeometry(.115,.032,8,32),cuff,torsoGroup,0,.375,0);collar.rotation.x=Math.PI/2
  // Real raised yarn columns keep the knitted silhouette tactile, even without textures.
  for(let i=0;i<20;i++){const angle=i/20*Math.PI*2;const x=Math.sin(angle)*.274,z=Math.cos(angle)*.194;tube(torsoGroup,thread,[[x*.78,-.05,z*.78],[x,.12,z],[x*.82,.31,z*.82]],.006,8)}
  for(const y of [.12,.23]){const button=mesh(new THREE.CylinderGeometry(.033,.033,.015,16),wood,torsoGroup,.035,y,.199);button.rotation.x=Math.PI/2;for(const x of [-.009,.009])ellipsoid(torsoGroup,eye,.035+x,y,.21,.003,.006,.002,8)}
  const headGroup=new THREE.Group();headGroup.name='headGroup';headGroup.position.set(0,.83,0);headGroup.rotation.order='YXZ';figure.add(headGroup)
  ellipsoid(headGroup,skin,0,.02,.015,.227,.245,.205)
  ellipsoid(headGroup,skin,-.223,.005,.005,.045,.07,.042);ellipsoid(headGroup,skin,.223,.005,.005,.045,.07,.042)
  const eyesMesh=new THREE.Group();eyesMesh.name='eyesMesh';headGroup.add(eyesMesh)
  for(const x of [-.085,.085]){
    const socket=ellipsoid(eyesMesh,material('#8d7153',1),x,.035,.193,.053,.062,.016)
    socket.position.y=.035
    ellipsoid(eyesMesh,eye,x,.04,.209,.032,.041,.013)
    ellipsoid(eyesMesh,material('#d8d3b1',.75),x-.008,.055,.219,.007,.008,.003,12)
    tube(headGroup,material('#6d533c',1),[[x-.04,.116,.178],[x,.131,.185],[x+.038,.117,.176]],.008,10)
  }
  ellipsoid(headGroup,skin,0,-.025,.211,.026,.033,.029)
  tube(headGroup,material('#795740',1),[[-.043,-.092,.177],[0,-.105,.19],[.043,-.092,.177]],.005,10)
  const hair=material('#526142',1,knit,.012)
  for(let i=0;i<14;i++){const angle=i/14*Math.PI*2;ellipsoid(headGroup,hair,Math.sin(angle)*.16,.19+Math.cos(angle)*.014,Math.cos(angle)*.13,.07,.075,.065,16)}
  tube(headGroup,cuff,[[0,.23,0],[.015,.32,0],[-.015,.39,.015]],.012,12)
  const bud=new THREE.Group();bud.position.set(-.015,.39,.015);headGroup.add(bud)
  const budMat=new THREE.MeshStandardMaterial({color:'#d4bd87',emissive:'#ffb84d',emissiveIntensity:.55,roughness:.88})
  for(let i=0;i<5;i++){const angle=i/5*Math.PI*2;const p=ellipsoid(bud,budMat,Math.sin(angle)*.035,.035,Math.cos(angle)*.035,.031,.065,.025,16);p.rotation.z=-Math.sin(angle)*.28;p.rotation.x=Math.cos(angle)*.28}
  // Only the fallback's bud glows; the GLB wears a green sprout, so the scene renders one point light fewer.
  const budLight=new THREE.PointLight('#ffb84d',0,1.4,2);budLight.position.set(0,1.1,0)
  const makeArm=(side:number):THREE.Group=>{
    const root=new THREE.Group();root.name=side<0?'rightArmGroup':'leftArmGroup';root.position.set(side*.25,.58,0);figure.add(root)
    const sleeve=mesh(new THREE.CapsuleGeometry(.08,.17,6,16),sweater,root,side*.045,-.12,.025);sleeve.rotation.z=side*.25
    const forearm=mesh(new THREE.CapsuleGeometry(.055,.13,6,16),skin,root,side*.085,-.29,.10);forearm.rotation.x=-.5
    ellipsoid(root,cuff,side*.078,-.225,.07,.072,.038,.074)
    const hand=ellipsoid(root,skin,side*.085,-.37,.14,.067,.085,.035)
    for(let i=0;i<4;i++)ellipsoid(root,skin,side*.085+(i-1.5)*.021,-.415,.145,.013,.032,.018,12)
    hand.rotation.z=side*.1
    return root
  }
  const rightArmGroup=makeArm(-1),leftArmGroup=makeArm(1)
  for(const side of [-1,1]){
    const thigh=mesh(new THREE.CapsuleGeometry(.105,.22,6,20),trousers,figure,side*.14,.22,.14);thigh.rotation.x=Math.PI/2
    mesh(new THREE.CapsuleGeometry(.075,.2,6,16),trousers,figure,side*.14,.075,.31).rotation.x=-.13
    ellipsoid(figure,skin,side*.14,-.075,.38,.09,.055,.13)
  }
  batchStatic(figure,[headGroup,torsoGroup,rightArmGroup,leftArmGroup]);batchStatic(torsoGroup);batchStatic(headGroup,[eyesMesh,bud]);batchStatic(eyesMesh);batchStatic(rightArmGroup);batchStatic(leftArmGroup)

  // Presence fades write `opacity` only. Each shadow caster gets a hashed depth material, because the renderer's shared
  // one copies neither alphaHash nor opacity: without it the shadow would stay solid while the body dissolves.
  // GLB and fallback get one each so neither ever switches between a mapped and an unmapped depth program.
  const fadeMaterials=new Set<THREE.Material>(),fallbackDepth=new THREE.MeshDepthMaterial({alphaHash:true}),modelDepth=new THREE.MeshDepthMaterial({alphaHash:true})
  const fadeable=(root:THREE.Object3D,depth:THREE.MeshDepthMaterial):void=>{
    fadeMaterials.add(depth)
    root.traverse(object=>{
      if(!(object instanceof THREE.Mesh))return
      for(const mat of Array.isArray(object.material)?object.material:[object.material]){mat.alphaHash=true;fadeMaterials.add(mat)}
      object.customDepthMaterial=depth;object.onBeforeShadow=shadowWatch
    })
  }
  // Entrance state: `drawn`/`shadowDrawn` turn true once the current model has been through the main and the shadow
  // pass (its shaders are compiled then); the 0.6 s fade-in only starts after that, so the compile stall happens while
  // the character is still fully hashed out instead of freezing a half-visible frame.
  let drawn=false,shadowDrawn=false,loadedAt=-1,entryStart=-1,entryClock=0,pendingGreet:number|undefined,goal=1,shown=-1
  const presence=spring(),grow=spring(),breathFollow=spring();presence.x=1;grow.x=ENTRANCE_SCALE
  const shadowWatch=():void=>{shadowDrawn=true}
  // A new model (or the fallback) starts hashed out and waits for its first drawn frame.
  const restartEntrance=():void=>{drawn=shadowDrawn=false;loadedAt=entryStart=shown=-1}
  fadeable(figure,fallbackDepth)

  let nextBlink=3.7,greeting=-100,disposed=false,imported:THREE.Object3D|undefined,source:Companion['source']='loading'
  type RigPart={object:THREE.Object3D;rotation:THREE.Quaternion;position:THREE.Vector3;modelRotation:THREE.Quaternion;direction:THREE.Vector3}
  const importedParts=new Map<string,RigPart>(),pose=new THREE.Quaternion()
  const modelRotation=new THREE.Quaternion(),parentInverse=new THREE.Quaternion(),worldRest=new THREE.Quaternion(),restDirection=new THREE.Vector3(),worldDirection=new THREE.Vector3()
  const thighLeft=new THREE.Vector3(.12,-.14,.98).normalize(),thighRight=new THREE.Vector3(-.12,-.14,.98).normalize(),shinDirection=new THREE.Vector3(0,-1,.08).normalize()
  const armDirection=new THREE.Vector3(),forearmDirection=new THREE.Vector3(),handDirection=new THREE.Vector3(),scratch=new THREE.Vector3()
  const budPosition=new THREE.Vector3()

  // Motion state. Springs snap to their targets while `settle` is set: before the first frame with a model and a known viewer.
  let lastTime=-1,settle=true,viewer:THREE.Camera|undefined,eyeLift=.04,seed=917,nextFlick=.6,nextGlance=10,glanceEnd=0,talkClock=0,flickYaw=0,flickPitch=0
  const gazeYaw=spring(),gazePitch=spring(),tilt=spring(),flickYawSpring=spring(),flickPitchSpring=spring(),talk=spring(),raise=spring(),gesture=spring(),lean=spring()
  const euler=new THREE.Euler(0,0,0,'YXZ'),turn=new THREE.Quaternion(),headLocal=new THREE.Vector3(),viewPoint=new THREE.Vector3(),ray=new THREE.Vector3(),look=new THREE.Vector3()
  // The main camera, captured as the character is drawn: the shadow pass calls onBeforeShadow instead, so this is the viewer.
  const watch=(_renderer:THREE.WebGLRenderer,_scene:THREE.Object3D,camera:THREE.Camera):void=>{viewer=camera;drawn=true}
  const watcher=torsoGroup.children.find(child=>child instanceof THREE.Mesh);if(watcher)watcher.onBeforeRender=watch

  const pointBone=(name:string,direction:THREE.Vector3):void=>{
    const part=importedParts.get(name);if(!part?.object.parent||!imported)return
    restDirection.copy(part.direction).applyQuaternion(modelRotation)
    worldDirection.copy(direction).normalize().applyQuaternion(modelRotation)
    pose.setFromUnitVectors(restDirection,worldDirection)
    worldRest.copy(modelRotation).multiply(part.modelRotation).premultiply(pose)
    parentInverse.copy(part.object.parent.getWorldQuaternion(parentInverse)).invert()
    part.object.quaternion.copy(parentInverse).multiply(worldRest);part.object.updateWorldMatrix(false,true)
  }
  const restoreWorldOrientation=(name:string):void=>{
    const part=importedParts.get(name);if(!part?.object.parent)return
    parentInverse.copy(part.object.parent.getWorldQuaternion(parentInverse)).invert()
    part.object.quaternion.copy(parentInverse).multiply(modelRotation).multiply(part.modelRotation);part.object.updateWorldMatrix(false,true)
  }
  /** Rotate a rest-identity bone in its own (= model) frame: pitch about x (+ looks down), yaw about y, roll about z. */
  const bend=(name:string,x:number,y:number,z:number):void=>{const part=importedParts.get(name);if(part)part.object.quaternion.multiply(turn.setFromEuler(euler.set(x,y,z,'YXZ')))}

  const api:Companion={
    group,headGroup,torsoGroup,rightArmGroup,leftArmGroup,eyesMesh,fallback:figure,
    get ready(){return source!=='loading'},get source(){return source},get presence(){return Math.max(0,shown)},
    greet(time){
      if(!Number.isFinite(time))return
      // Restarting mid-wave would reset the swing phase and snap the forearm; a second call is simply ignored.
      const playing=lastTime>=greeting&&lastTime-greeting<GREET_LENGTH
      if(playing)return
      if(entryStart<0||goal<.5)pendingGreet=time;else greeting=time
    },
    setPresence(value){goal=Number.isFinite(value)?THREE.MathUtils.clamp(value,0,1):goal},
    update(time,breath,pointer,talking,reduced){
      const dt=lastTime<0?0:THREE.MathUtils.clamp(time-lastTime,0,.1),snap=reduced||settle;lastTime=time

      // Entrance: wait for the first drawn frame (compile), then fade in over ENTRANCE while a soft spring (ζ .7)
      // settles the figure from 96 % up to full size. Presence follows `goal` on its own critically damped spring.
      // The clock waits while the scene keeps the group hidden for its parallel compile (code-4): a compile longer than
      // the .6 s fallback timer would otherwise play the whole fade unseen and pop the character in at full opacity.
      if(source!=='loading'&&group.visible){
        if(loadedAt<0)loadedAt=time
        if(entryStart<0&&(drawn||time-loadedAt>.6)){entryStart=time;entryClock=0;grow.x=ENTRANCE_SCALE;grow.v=0}
      }
      const entering=entryStart<0
      // A wave asked for before the entrance, or while the scene keeps the character hidden, starts once it shows.
      if(reduced)pendingGreet=undefined
      else if(pendingGreet!==undefined&&!entering&&goal>=.5){greeting=Math.max(pendingGreet,time);pendingGreet=undefined}
      // The entrance runs on the clamped frame clock like the springs, so a stall elsewhere never makes it jump.
      if(!entering)entryClock+=dt
      const entrance=entering?0:THREE.MathUtils.smootherstep(entryClock,0,ENTRANCE)
      drive(presence,goal,9,1,dt,entering);if(Math.abs(goal-presence.x)<.002&&Math.abs(presence.v)<.03){presence.x=goal;presence.v=0}
      const follow=THREE.MathUtils.clamp(presence.x,0,1)
      const visibleNow=entrance*follow
      // Reduced motion: opacity still eases (it is not movement), the size never changes.
      const size=entering?reduced?1:ENTRANCE_SCALE:drive(grow,1,9,.7,dt,reduced)

      const live=reduced?0:1,since=time-greeting,greetingNow=!reduced&&since>=0&&since<GREET_LENGTH,speaking=talking&&!reduced
      const head=importedParts.get('head');

      // Gaze: towards the viewer, pulled along the pointer ray; now and then a glance down at the lotus.
      (head?.object??headGroup).getWorldPosition(headLocal);group.worldToLocal(headLocal);headLocal.y+=eyeLift
      let yawTarget=-.12,pitchTarget=.05,engaged=0
      const talkAmount=drive(talk,speaking?1:0,3.5,1,dt,snap)
      if(!reduced){
        if(viewer){
          viewPoint.setFromMatrixPosition(viewer.matrixWorld)
          ray.set(pointer.x,pointer.y,.5).unproject(viewer).sub(viewPoint).normalize()
          look.copy(headLocal);group.localToWorld(look);const distance=viewPoint.distanceTo(look)
          // A point on the pointer ray between the viewer and the character: the cursor steers the gaze, and while
          // replying the character keeps eye contact.
          look.copy(viewPoint).addScaledVector(ray,distance*THREE.MathUtils.lerp(.4,.12,talkAmount));group.worldToLocal(look).sub(headLocal)
          yawTarget=Math.atan2(look.x,look.z);pitchTarget=Math.atan2(look.y,Math.hypot(look.x,look.z))
          engaged=1-THREE.MathUtils.smoothstep(distance,3.45,4.1)
        }else{yawTarget=pointer.x*.3;pitchTarget=pointer.y*.12}
        if(time>=nextGlance){if(talking||greetingNow)nextGlance=time+2.5;else{glanceEnd=time+1.7+random(seed++)*.9;nextGlance=glanceEnd+8+random(seed++)*7}}
        if(time<glanceEnd&&!talking&&!greetingNow){look.copy(LOTUS_CORE).sub(group.position).sub(headLocal);yawTarget=Math.atan2(look.x,look.z);pitchTarget=Math.atan2(look.y,Math.hypot(look.x,look.z))}
        // Micro-saccades: tiny held jumps through a fast spring, never a continuous jitter.
        if(time>=nextFlick){nextFlick=time+.9+random(seed++)*2.1;flickYaw=(random(seed++)-.5)*.05;flickPitch=(random(seed++)-.5)*.03}
      }else{flickYaw=flickPitch=0}
      const yaw=drive(gazeYaw,THREE.MathUtils.clamp(yawTarget,-.78,.6),6,1,dt,snap)+drive(flickYawSpring,flickYaw,22,1,dt,snap)
      const pitch=drive(gazePitch,THREE.MathUtils.clamp(pitchTarget,-.36,.3),6,1,dt,snap)+drive(flickPitchSpring,flickPitch,22,1,dt,snap)

      // Greeting (~2.3 s): anticipation, the arm springs up past its mark, 2–3 waves with the hand lagging the
      // forearm, then a critically damped return so the hand settles on the knee instead of bouncing through it.
      const raiseTarget=greetingNow?since<.18?-.12:since<1.5?1:0:0
      // Only reduced motion snaps the arms: a wave that starts while the pose is still settling must not teleport.
      const raised=drive(raise,raiseTarget,raiseTarget>.5?10:7.5,raiseTarget>.5?.48:1,dt,reduced)
      const swing=greetingNow?window4(since,.42,.62,1.22,1.48):0,phase=TAU*2.3*(since-.45)
      const forearmSwing=Math.sin(phase)*swing,handSwing=Math.sin(phase-.95)*swing
      const greetTilt=greetingNow?window4(since,.1,.45,1.35,1.85):0,greetNod=greetingNow?window4(since,.25,.5,.5,.95)*.05:0
      const anticipation=greetingNow?window4(since,0,.12,.12,.4):0

      // Talking: soft uneven nods and, once per reply cycle, one open-handed gesture.
      talkClock=speaking?talkClock+dt:0
      const opened=drive(gesture,talkClock>0?window4(talkClock%7,.35,.9,1.7,2.5):0,6,.75,dt,reduced)
      const nod=live*talkAmount*.032*Math.max(0,Math.sin(time*TAU*.85))**2*(.65+.35*noise3(time*.6,1.7,4.2))

      // Idle body: breath lifts chest and shoulders; the weight drifts between the hips on two incommensurate periods.
      // The character breathes with the lotus core but is not locked to it: it follows the core's breath through a
      // spring (≈.25–.36 s behind, the lag wandering slowly) and each breath is a little deeper or shallower.
      const breathLag=drive(breathFollow,breath,6.7+1.3*noise3(time*.05,5.3,.7),1,dt,snap),depth=1+.3*noise3(time*.09,2.9,6.1)
      const inhale=live*Math.max(0,breathLag*depth),shift=live*(Math.sin(time*TAU/7.7)*.62+Math.sin(time*TAU/11.3+1.7)*.38),sway=live*Math.sin(time*TAU/9.1+.6)
      const leanIn=drive(lean,live*(engaged*(1-talkAmount)*.03+talkAmount*.014),2.2,1,dt,snap)
      const roll=drive(tilt,live*(engaged*(1-talkAmount)*.075*(1+.25*Math.sin(time*.21))+talkAmount*.02+greetTilt*.085),3,1,dt,snap)

      if(time>=nextBlink)nextBlink=time+3.2+(Math.sin(time*4.3)+1)*.85
      const till=nextBlink-time;eyesMesh.scale.y=!reduced&&till<.18?Math.max(.08,Math.abs(till-.09)/.09):1

      if(imported){
        for(const part of importedParts.values()){part.object.quaternion.copy(part.rotation);part.object.position.copy(part.position)}
        bend('pelvis',0,sway*.006,shift*.013)
        bend('spine',-inhale*.006+leanIn*.4,yaw*.07,-shift*.008)
        bend('chest',-inhale*.02+leanIn*.6-anticipation*.035,yaw*.18,-shift*.004-greetTilt*.02)
        bend('head',-pitch*.85+nod+greetNod-leanIn*.5,yaw*.75,roll)
        const chest=importedParts.get('chest');if(chest)chest.object.position.y+=inhale*.011
        for(const name of SHOULDERS){const part=importedParts.get(name);if(part)part.object.position.y+=inhale*.008}
        imported.updateWorldMatrix(true,true);imported.getWorldQuaternion(modelRotation)
        pointBone('thigh.L',thighLeft);pointBone('thigh.R',thighRight)
        pointBone('shin.L',shinDirection);pointBone('shin.R',shinDirection)
        restoreWorldOrientation('foot.L');restoreWorldOrientation('foot.R')
        for(const side of SIDES){
          armDirection.set(side*.14,-.9,.30);forearmDirection.set(side*.05,-.40,.88);handDirection.set(side*.05,-.52,.84)
          if(side<0&&raised!==0){
            armDirection.lerp(scratch.set(-.86,.40,.12),raised)
            forearmDirection.lerp(scratch.set(forearmSwing*.3,.97,.18),raised)
            handDirection.lerp(scratch.set(handSwing*.62,.9,.22),raised)
          }
          if(side>0&&opened>0){
            armDirection.lerp(scratch.set(.24,-.76,.6),opened)
            forearmDirection.lerp(scratch.set(.12,.2,.97),opened)
            handDirection.lerp(scratch.set(.22,.32,.92),opened)
          }
          const [upper,fore,hand]=ARM_BONES[side<0?0:1]
          pointBone(upper,armDirection);pointBone(fore,forearmDirection);pointBone(hand,handDirection)
        }
      }else if(source==='fallback'){
        torsoGroup.scale.y=1+inhale*.025;torsoGroup.position.y=.38+inhale*.006;torsoGroup.rotation.set(leanIn-anticipation*.035,yaw*.15,-shift*.01)
        headGroup.rotation.set(-pitch*.85+nod+greetNod,yaw*.8,roll)
        rightArmGroup.rotation.z=-1.95*raised;rightArmGroup.rotation.x=(-.1+forearmSwing*.16)*raised
        leftArmGroup.rotation.x=-opened*.55;leftArmGroup.rotation.z=opened*.2
        budMat.emissiveIntensity=.5+inhale*.22+(speaking?.45+Math.sin(time*3)*.12:0);budLight.intensity=(.12+inhale*.08+(speaking?.14:0))*visibleNow
        bud.getWorldPosition(budPosition);group.worldToLocal(budPosition);budLight.position.copy(budPosition)
      }
      // Presence: one opacity uniform per material; the draw switch only flips once the shaders exist, so hiding never
      // postpones a compile into the middle of a scroll.
      body.scale.setScalar(size)
      if(visibleNow!==shown){shown=visibleNow;for(const mat of fadeMaterials)mat.opacity=shown}
      const warm=drawn&&shadowDrawn||loadedAt>=0&&time-loadedAt>1.2
      body.visible=shown>.002||!warm
      // Stay snapped until the viewer is known, so the first visible pose already looks at the camera.
      if(source!=='loading'&&(viewer||reduced))settle=false
    },
    async loadModel(url){
      try{
        const gltf=await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url)
        if(disposed){disposeObject(gltf.scene);return false}
        const box=new THREE.Box3().setFromObject(gltf.scene),size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3())
        if(!Number.isFinite(size.y)||size.y<=0){disposeObject(gltf.scene);throw new Error('Invalid companion bounds')}
        gltf.scene.updateWorldMatrix(true,true)
        const inverseModel=gltf.scene.getWorldQuaternion(new THREE.Quaternion()).invert()
        for(const name of ['pelvis','spine','chest','head','upper_arm.R','forearm.R','hand.R','upper_arm.L','forearm.L','hand.L','thigh.R','shin.R','foot.R','thigh.L','shin.L','foot.L']){
          const object=gltf.scene.getObjectByName(name)??gltf.scene.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(name));if(!object)continue
          const rotation=inverseModel.clone().multiply(object.getWorldQuaternion(new THREE.Quaternion()))
          const child=object.children.find(child=>child instanceof THREE.Bone)
          const direction=child?child.getWorldPosition(new THREE.Vector3()).sub(object.getWorldPosition(new THREE.Vector3())).normalize().applyQuaternion(inverseModel):new THREE.Vector3(0,1,0).applyQuaternion(rotation)
          importedParts.set(name,{object,rotation:object.quaternion.clone(),position:object.position.clone(),modelRotation:rotation,direction})
        }
        const scale=1.32/size.y,pelvis=gltf.scene.getObjectByName('pelvis')
        const headY=importedParts.get('head')?.object.getWorldPosition(new THREE.Vector3()).y
        // Eyes sit a little under half way from the head bone to the crown.
        if(headY!==undefined)eyeLift=(box.max.y-headY)*.42*scale
        const hipY=pelvis?.getWorldPosition(new THREE.Vector3()).y??size.y*.45
        gltf.scene.scale.setScalar(scale);gltf.scene.position.set(-center.x*scale,.29-hipY*scale,-center.z*scale)
        gltf.scene.traverse(o=>{
          if(!(o instanceof THREE.Mesh))return
          o.castShadow=o.receiveShadow=true
          if(o instanceof THREE.SkinnedMesh){o.frustumCulled=false;o.onBeforeRender=watch}
          if(o.material instanceof THREE.MeshStandardMaterial&&!(o.material instanceof THREE.MeshPhysicalMaterial))o.material=knitMaterial(o.material)
        })
        fadeable(gltf.scene,modelDepth)
        if(imported){imported.traverse(o=>{if(o instanceof THREE.Mesh)for(const mat of Array.isArray(o.material)?o.material:[o.material])fadeMaterials.delete(mat)});imported.removeFromParent();disposeObject(imported)}
        imported=gltf.scene;body.add(imported);figure.visible=false;source='glb';settle=true;restartEntrance()
        return true
      }catch(error){if(!disposed){figure.visible=true;group.add(budLight);source='fallback';settle=true;restartEntrance();console.warn('Liora: using the procedural companion.',error instanceof Error?error.message:'Model unavailable')}return false}
    },
    pose(){return {source,bones:[...importedParts.keys()],rightHand:(importedParts.get('hand.R')?.object??rightArmGroup).getWorldPosition(new THREE.Vector3()).toArray(),leftHand:(importedParts.get('hand.L')?.object??leftArmGroup).getWorldPosition(new THREE.Vector3()).toArray()}},
    inspect(settled=false){
      // Until the entrance runs the body holds ENTRANCE_SCALE (pivot at the cushion); a settled box is taken at full size.
      const size=body.scale.x,unscale=settled&&size!==1
      if(unscale){body.scale.setScalar(1);body.updateWorldMatrix(true,true)}
      if(imported)imported.traverse(object=>{if(object instanceof THREE.SkinnedMesh){object.skeleton.update();object.computeBoundingBox()}})
      const bounds=imported?new THREE.Box3().setFromObject(imported):new THREE.Box3().setFromObject(figure)
      if(unscale){body.scale.setScalar(size);body.updateWorldMatrix(false,true)}
      return {...api.pose(),bounds:[bounds.min.toArray(),bounds.max.toArray()],presence:Math.max(0,shown)}
    },
    dispose(){disposed=true;viewer=undefined;importedParts.clear();fallbackDepth.dispose();modelDepth.dispose()},
  }
  return api
}
