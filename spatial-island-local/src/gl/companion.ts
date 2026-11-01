import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { batchStatic,disposeObject,ellipsoid,grainTexture,material,mesh,tube } from './craft'

export interface Companion {
  group:THREE.Group
  headGroup:THREE.Group
  torsoGroup:THREE.Group
  rightArmGroup:THREE.Group
  leftArmGroup:THREE.Group
  eyesMesh:THREE.Group
  readonly ready:boolean
  readonly source:'loading'|'glb'|'fallback'
  update:(time:number,breath:number,pointer:THREE.Vector2,talking:boolean,reduced:boolean)=>void
  greet:(time:number)=>void
  loadModel:(url:string)=>Promise<boolean>
  pose:()=>{source:string;bones:string[];rightHand:number[];leftHand:number[]}
  inspect:()=>{source:string;bones:string[];rightHand:number[];leftHand:number[];bounds:number[][]}
  dispose:()=>void
}

export function createCompanion():Companion {
  const group=new THREE.Group();group.name='CompanionCharacter';group.position.set(.8,.15,-1.1)
  const figure=new THREE.Group();figure.visible=false;group.add(figure)
  const clay=grainTexture('clay'),knit=grainTexture('knit');knit.repeat.set(2,2)
  const skin=material('#bc9a75',.94,clay,.012),sweater=material('#677b53',.98,knit,.018),cuff=material('#4e6143',.98,knit,.013),trousers=material('#5c5241',.95,clay,.01),eye=material('#1b2118',.65),thread=material('#a1ac82',1),wood=material('#765435',.9,clay,.02)
  const torsoGroup=new THREE.Group();torsoGroup.name='torsoGroup';figure.add(torsoGroup);torsoGroup.position.y=.38
  ellipsoid(torsoGroup,sweater,0,.13,0,.29,.32,.2)
  const hem=mesh(new THREE.CylinderGeometry(.265,.25,.075,32),cuff,torsoGroup,0,-.065,.0);hem.scale.z=.73
  const collar=mesh(new THREE.TorusGeometry(.115,.032,8,32),cuff,torsoGroup,0,.375,0);collar.rotation.x=Math.PI/2
  // Real raised yarn columns keep the knitted silhouette tactile, even without textures.
  for(let i=0;i<20;i++){const angle=i/20*Math.PI*2;const x=Math.sin(angle)*.274,z=Math.cos(angle)*.194;tube(torsoGroup,thread,[[x*.78,-.05,z*.78],[x,.12,z],[x*.82,.31,z*.82]],.006,8)}
  for(const y of [.12,.23]){const button=mesh(new THREE.CylinderGeometry(.033,.033,.015,16),wood,torsoGroup,.035,y,.199);button.rotation.x=Math.PI/2;for(const x of [-.009,.009])ellipsoid(torsoGroup,eye,.035+x,y,.21,.003,.006,.002,8)}
  const headGroup=new THREE.Group();headGroup.name='headGroup';headGroup.position.set(0,.83,0);figure.add(headGroup)
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
  const budLight=new THREE.PointLight('#ffb84d',0,1.4,2);budLight.position.set(0,1.1,0);group.add(budLight)
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
  let nextBlink=3.7,greeting=-100,disposed=false,imported:THREE.Object3D|undefined,source:Companion['source']='loading'
  type RigPart={object:THREE.Object3D;rotation:THREE.Quaternion;position:THREE.Vector3;modelRotation:THREE.Quaternion;direction:THREE.Vector3}
  const importedParts=new Map<string,RigPart>(),pose=new THREE.Quaternion(),angles=new THREE.Euler()
  const modelRotation=new THREE.Quaternion(),parentInverse=new THREE.Quaternion(),worldRest=new THREE.Quaternion(),restDirection=new THREE.Vector3(),worldDirection=new THREE.Vector3()
  const thighLeft=new THREE.Vector3(.12,-.14,.98).normalize(),thighRight=new THREE.Vector3(-.12,-.14,.98).normalize(),shinDirection=new THREE.Vector3(0,-1,.08).normalize()
  const armDirection=new THREE.Vector3(),forearmDirection=new THREE.Vector3()
  const budPosition=new THREE.Vector3();let budOffset=.44
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
  const api:Companion={
    group,headGroup,torsoGroup,rightArmGroup,leftArmGroup,eyesMesh,
    get ready(){return source!=='loading'},get source(){return source},
    greet(time){greeting=time},
    update(time,breath,pointer,talking,reduced){
      torsoGroup.scale.y=1+(reduced?0:breath*.025);torsoGroup.position.y=.38+(reduced?0:breath*.006)
      const follow=reduced?0:pointer.x*.16
      headGroup.rotation.y=THREE.MathUtils.lerp(headGroup.rotation.y,follow,.045)
      headGroup.rotation.x=THREE.MathUtils.lerp(headGroup.rotation.x,(talking?-.025+Math.sin(time*2.7)*.035:.018)+(reduced?0:pointer.y*.05),.05)
      const elapsed=time-greeting
      if(elapsed>=0&&elapsed<2&&!reduced){const envelope=Math.sin(Math.min(1,elapsed/.3)*Math.PI/2)*Math.sin(Math.min(1,(2-elapsed)/.35)*Math.PI/2);rightArmGroup.rotation.z=-1.95*envelope;rightArmGroup.rotation.x=(-.1+Math.sin(elapsed*12)*.16)*envelope}
      else{rightArmGroup.rotation.z=THREE.MathUtils.lerp(rightArmGroup.rotation.z,talking&&!reduced?-.12-Math.sin(time*2.2)*.1:0,.05);rightArmGroup.rotation.x=THREE.MathUtils.lerp(rightArmGroup.rotation.x,talking&&!reduced?-.1:0,.05)}
      leftArmGroup.rotation.x=talking&&!reduced?Math.sin(time*1.8)*.06:0
      if(time>=nextBlink)nextBlink=time+3.2+(Math.sin(time*4.3)+1)*.85
      const till=nextBlink-time;eyesMesh.scale.y=!reduced&&till<.18?Math.max(.08,Math.abs(till-.09)/.09):1
      budMat.emissiveIntensity=.5+breath*.22+(talking?.45+Math.sin(time*3)*.12:0);budLight.intensity=source==='loading'?0:.12+breath*.08+(talking?.14:0)
      if(imported){
        for(const part of importedParts.values()){part.object.quaternion.copy(part.rotation);part.object.position.copy(part.position)}
        const chest=importedParts.get('chest'),head=importedParts.get('head')
        if(chest)chest.object.position.y+=reduced?0:breath*.008
        if(head){angles.set(headGroup.rotation.x,headGroup.rotation.y,0);head.object.quaternion.multiply(pose.setFromEuler(angles))}
        imported.updateWorldMatrix(true,true);imported.getWorldQuaternion(modelRotation)
        pointBone('thigh.L',thighLeft);pointBone('thigh.R',thighRight)
        pointBone('shin.L',shinDirection);pointBone('shin.R',shinDirection)
        restoreWorldOrientation('foot.L');restoreWorldOrientation('foot.R')
        const wave=elapsed>=0&&elapsed<2&&!reduced?Math.sin(Math.min(1,elapsed/.3)*Math.PI/2)*Math.sin(Math.min(1,(2-elapsed)/.35)*Math.PI/2):0
        for(const side of [-1,1]){
          const suffix=side<0?'R':'L',gesture=talking&&!reduced?Math.sin(time*2.2+side)*.07:0
          armDirection.set(side*.14,-.9,.30+gesture).normalize()
          forearmDirection.set(side*.05,-.40,.88+gesture).normalize()
          if(side<0&&wave>0){armDirection.lerp(worldDirection.set(-.86,.40,.12).normalize(),wave);forearmDirection.lerp(worldDirection.set(Math.sin(elapsed*11)*.28,.97,.18).normalize(),wave)}
          pointBone(`upper_arm.${suffix}`,armDirection);pointBone(`forearm.${suffix}`,forearmDirection);pointBone(`hand.${suffix}`,forearmDirection)
        }
        if(head){budPosition.set(0,budOffset,.02);head.object.localToWorld(budPosition);group.worldToLocal(budPosition);budLight.position.copy(budPosition)}
      }else if(source==='fallback'){
        bud.getWorldPosition(budPosition);group.worldToLocal(budPosition);budLight.position.copy(budPosition)
      }
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
        const head=importedParts.get('head');if(head)budOffset=box.max.y-head.object.getWorldPosition(new THREE.Vector3()).y-.04
        const hipY=pelvis?.getWorldPosition(new THREE.Vector3()).y??size.y*.45
        gltf.scene.scale.setScalar(scale);gltf.scene.position.set(-center.x*scale,.29-hipY*scale,-center.z*scale)
        gltf.scene.traverse(o=>{if(o instanceof THREE.Mesh){o.castShadow=o.receiveShadow=true;if(o instanceof THREE.SkinnedMesh)o.frustumCulled=false}})
        if(imported){imported.removeFromParent();disposeObject(imported)}
        imported=gltf.scene;group.add(imported);figure.visible=false;source='glb'
        return true
      }catch(error){if(!disposed){figure.visible=true;source='fallback';console.warn('Liora: using the procedural companion.',error instanceof Error?error.message:'Model unavailable')}return false}
    },
    pose(){return {source,bones:[...importedParts.keys()],rightHand:(importedParts.get('hand.R')?.object??rightArmGroup).getWorldPosition(new THREE.Vector3()).toArray(),leftHand:(importedParts.get('hand.L')?.object??leftArmGroup).getWorldPosition(new THREE.Vector3()).toArray()}},
    inspect(){if(imported)imported.traverse(object=>{if(object instanceof THREE.SkinnedMesh){object.skeleton.update();object.computeBoundingBox()}});const bounds=imported?new THREE.Box3().setFromObject(imported):new THREE.Box3().setFromObject(figure);return {...api.pose(),bounds:[bounds.min.toArray(),bounds.max.toArray()]}},
    dispose(){disposed=true;importedParts.clear()},
  }
  return api
}
