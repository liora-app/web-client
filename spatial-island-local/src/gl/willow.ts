import * as THREE from 'three'
import type { Kit,Lantern } from './artifacts'
import { batchStatic,material,mesh } from './craft'
import { random } from './noise'
import { lanternPaperTexture } from './paper'
import { applySurface,surfaceNoise } from './surface'

/**
 * Weeping light willow: a rope trunk of five tapering strands that flare into buttress roots, arching boughs, a curtain
 * of hanging branchlets dressed in curved lanceolate leaves, a few soft light filaments and three ribbed paper lanterns.
 * Branchlets, leaves and filaments share one sway function, so they move together in the same slow air.
 */
export interface Willow {canopy:THREE.Group;lanterns:Lantern[];update:(time:number,reduced:boolean)=>void}

const TREE=new THREE.Vector3(1.85,0,-.85)
/** Camera position of the willow chapter (cameraWaypoints[3]); strands stay out of its line of sight to the lanterns. */
const VIEW=new THREE.Vector3(.25,1.75,2.1)
const LANTERNS=[[.85,2.25,-.15],[1.35,2.45,-.15],[1.85,2.15,-.45]]
const ANCHOR_Y=[2.68,2.91,2.62]
const BOUGH_ENDS=[[-1.48,2.58,.48],[-.96,2.94,-.33],[.12,3.05,.2],[.95,2.83,-.3],[.62,2.62,.65],[-.58,2.72,.9]]
const RIBS=12

/** aSway = (hang 0..1 below the attachment point, phase). Displacement grows with hang², so attachments never move. */
const SWAY_GLSL=`uniform float uSwayTime;attribute vec2 aSway;
vec3 willowSway(vec2 s){float h=s.x*s.x;return vec3(sin(uSwayTime*.52+s.y)*.62+sin(uSwayTime*.87+s.y*1.7)*.38,0.,cos(uSwayTime*.41+s.y*1.3)*.7)*.05*h;}
`
type Sway=(point:THREE.Vector3,t:number)=>[number,number]
const still:Sway=()=>[0,0]

/** Tube whose radius tapers from r0 to r1; uv.y runs in world length so bark texel density is even on every limb. */
function taperedTube(points:THREE.Vector3[],r0:number,r1:number,tubular:number,radial:number,sway:Sway=still,rgba?:(t:number)=>number[]):THREE.BufferGeometry {
  const curve=new THREE.CatmullRomCurve3(points,false,'centripetal'),frames=curve.computeFrenetFrames(tubular,false),length=curve.getLength()
  const positions:number[]=[],normals:number[]=[],uvs:number[]=[],swayData:number[]=[],colors:number[]=[],indices:number[]=[],p=new THREE.Vector3(),n=new THREE.Vector3()
  for(let i=0;i<=tubular;i++){
    const t=i/tubular,r=r0+(r1-r0)*Math.pow(t,.85),N=frames.normals[i],B=frames.binormals[i];curve.getPointAt(t,p);const s=sway(p,t),color=rgba?.(t)
    for(let j=0;j<=radial;j++){
      const v=j/radial*Math.PI*2,sin=Math.sin(v),cos=-Math.cos(v)
      n.set(cos*N.x+sin*B.x,cos*N.y+sin*B.y,cos*N.z+sin*B.z).normalize()
      positions.push(p.x+r*n.x,p.y+r*n.y,p.z+r*n.z);normals.push(n.x,n.y,n.z);uvs.push(j/radial,t*length*2.2);swayData.push(s[0],s[1]);if(color)colors.push(...color)
    }
  }
  for(let i=0;i<tubular;i++)for(let j=0;j<radial;j++){const a=i*(radial+1)+j,b=(i+1)*(radial+1)+j;indices.push(a,b,a+1,b,b+1,a+1)}
  const geometry=new THREE.BufferGeometry();geometry.setIndex(indices)
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3))
  geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));geometry.setAttribute('aSway',new THREE.Float32BufferAttribute(swayData,2))
  if(rgba)geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,4))
  return geometry
}

let barkCache:THREE.DataTexture|undefined
/** Bark height (tileable; u round the limb, v along it): narrow fissures running lengthwise, wandering sideways,
 * between them flat plates split now and then by a short cross-crack. Warped by the shared surface noise tile. */
function barkTexture():THREE.DataTexture {
  if(barkCache)return barkCache
  const width=64,height=256,data=new Uint8Array(width*height*4),tau=Math.PI*2,noise=(surfaceNoise().image as {data:Uint8Array}).data
  const sample=(channel:number,u:number,v:number):number=>noise[((Math.floor(v*256)&255)*256+(Math.floor(u*256)&255))*4+channel]/255
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const u=x/width,v=y/height,warp=(sample(0,u,v)-.5)*1.1+(sample(1,u,v)-.5)*.45
    const fissure=THREE.MathUtils.smoothstep(.5+.5*Math.cos(tau*(u*9+warp)),.72,.985),plate=.78+.22*sample(2,u,v),crack=THREE.MathUtils.smoothstep(sample(3,u,v),.8,.93)*(1-fissure)
    const value=Math.round(THREE.MathUtils.clamp(plate*(1-.82*fissure)-.28*crack,0,1)*255),i=(y*width+x)*4
    data[i]=data[i+1]=data[i+2]=value;data[i+3]=255
  }
  barkCache=new THREE.DataTexture(data,width,height,THREE.RGBAFormat);barkCache.wrapS=barkCache.wrapT=THREE.RepeatWrapping
  barkCache.magFilter=THREE.LinearFilter;barkCache.minFilter=THREE.LinearMipmapLinearFilter;barkCache.generateMipmaps=true;barkCache.anisotropy=4;barkCache.needsUpdate=true
  return barkCache
}

/** Lanceolate leaf card, length 1 along +Y, folded along the midrib and curling at the tip. 8 triangles. */
function leafGeometry():THREE.BufferGeometry {
  const positions:number[]=[0,0,0],uvs:number[]=[.5,0],indices:number[]=[]
  for(const [t,w] of [[.3,.075],[.66,.066]]){const curl=.09*t*t;for(const side of [-1,0,1]){positions.push(side*w,t,curl+Math.abs(side)*w*.42);uvs.push(.5+side*.5,t)}}
  positions.push(0,1,.09);uvs.push(.5,1)
  indices.push(0,2,1,0,3,2)
  indices.push(1,2,5,1,5,4,2,3,6,2,6,5)
  indices.push(4,5,7,5,6,7)
  const geometry=new THREE.BufferGeometry();geometry.setIndex(indices)
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));geometry.computeVertexNormals()
  return geometry
}

export function createWillow(kit:Kit):Willow {
  const canopy=new THREE.Group();canopy.name='Weeping light willow'
  const tree=new THREE.Group();tree.name='Willow tree';tree.position.copy(TREE);canopy.add(tree)
  const swayTime={value:0},levels={value:new THREE.Vector3()}
  const groundAt=(x:number,z:number):number=>kit.ground(x+TREE.x,z+TREE.z)
  const v=(x:number,y:number,z:number):THREE.Vector3=>new THREE.Vector3(x,y,z)

  const bark=material('#4a4034',.94,barkTexture(),.04)
  bark.onBeforeCompile=shader=>{shader.uniforms.uSwayTime=swayTime;shader.vertexShader=SWAY_GLSL+shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\ntransformed+=willowSway(aSway);')}
  bark.customProgramCacheKey=()=>'willow-bark-sway-v1'
  applySurface(bark,{scale:3.5,bump:.004,fine:.3,variation:.16,tint:'#d6d8c2',cavity:.1,roughnessVariation:.1,moss:{color:'#4f6d43',amount:.38,low:.62,high:.95}})
  const limb=(geometry:THREE.BufferGeometry):THREE.Mesh=>mesh(geometry,bark,tree)

  // Trunk: five strands twisting up, flaring into buttress roots that dive into the moss.
  const trunkX=(y:number):number=>-.14*Math.sin((y+.04)/2.67*5)
  for(let strand=0;strand<5;strand++){
    const phase=strand/5*Math.PI*2,points:THREE.Vector3[]=[]
    const rootX=Math.cos(phase)*.37,rootZ=Math.sin(phase)*.35;points.push(v(rootX,groundAt(rootX,rootZ)-.06,rootZ))
    for(let j=0;j<=20;j++){const t=j/20,y=-.02+t*2.67,orbit=.068+.02*(1-t)+.17*Math.exp(-t*11),a=phase+t*5;points.push(v(trunkX(y)+Math.cos(a)*orbit,y,Math.sin(a)*orbit*.95))}
    limb(taperedTube(points,.05,.018,34,6))
  }
  for(let i=0;i<7;i++){
    const a=i/7*Math.PI*2+.45,c=Math.cos(a),s=Math.sin(a),bend=(random(i+310)-.5)*.5,points:THREE.Vector3[]=[]
    for(const [r,lift] of [[.07,.15],[.2,.05],[.36,.014],[.52,-.004],[.66,-.05]]){const x=c*r-s*bend*r*r,z=s*r+c*bend*r*r;points.push(v(x,(lift>.1?lift:groundAt(x,z)+lift),z))}
    limb(taperedTube(points,.034,.005,11,5))
  }

  // Boughs rise, arch and droop to the same ends as before; two side branches each.
  const branches:{curve:THREE.CatmullRomCurve3;from:number}[]=[],boughs:THREE.CatmullRomCurve3[]=[]
  BOUGH_ENDS.forEach((end,i)=>{
    const y=1.5+i*.105,points=[v(trunkX(y),y,0),v(end[0]*.35,2.28+(end[1]-2.6)*.3,end[2]*.26),v(end[0]*.76,end[1]+.12,end[2]*.8),v(end[0],end[1],end[2])]
    limb(taperedTube(points,.034,.008,20,6));const curve=new THREE.CatmullRomCurve3(points,false,'centripetal');branches.push({curve,from:.38});boughs.push(curve)
    const out=v(end[0],0,end[2]).normalize()
    for(const [s,turn,length] of [[.5,.75,.42],[.7,-.65,.5]]){
      const start=curve.getPointAt(s),dir=out.clone().applyAxisAngle(v(0,1,0),turn*(i%2?1:-1)),side=[start,start.clone().addScaledVector(dir,length*.36).add(v(0,.13,0)),start.clone().addScaledVector(dir,length*.76).add(v(0,.1,0)),start.clone().addScaledVector(dir,length).add(v(0,-.05,0))]
      limb(taperedTube(side,.013,.004,10,4));branches.push({curve:new THREE.CatmullRomCurve3(side,false,'centripetal'),from:.25})
    }
  })

  // Keep the willow chapter's view of each lantern clear of hanging strands and leaves.
  const eye=VIEW.clone().sub(TREE),targets=LANTERNS.map(([x,y,z])=>v(x-TREE.x,y,z-TREE.z))
  const blocks=(x:number,z:number,top:number,bottom:number):boolean=>targets.some(target=>{
    if(Math.hypot(x-target.x,z-target.z)<.2&&bottom<target.y+.26&&top>target.y-.36)return true
    const dx=target.x-eye.x,dz=target.z-eye.z,s=((x-eye.x)*dx+(z-eye.z)*dz)/(dx*dx+dz*dz)
    if(s<.05||s>1.05)return false
    const sightY=eye.y+(target.y-eye.y)*s
    return Math.hypot(x-(eye.x+dx*s),z-(eye.z+dz*s))<.17&&sightY<top+.1&&sightY>bottom-.1
  })

  // Leaves are gathered first and written into one instanced mesh.
  const leafMatrices:THREE.Matrix4[]=[],leafColors:THREE.Color[]=[],leafSway:number[]=[],leafGlow:number[]=[]
  const basis=new THREE.Matrix4(),side=new THREE.Vector3(),normal=new THREE.Vector3(),roll=new THREE.Quaternion(),scale=new THREE.Vector3()
  const greens=['#557f4b','#4b7448','#628a50','#41693f','#6f8a4c','#7f9152'].map(c=>new THREE.Color(c))
  /** Blade along `direction`; its face turns outwards for hanging leaves and upwards for leaves held out sideways. */
  const addLeaf=(at:THREE.Vector3,direction:THREE.Vector3,size:number,hang:number,phase:number,seed:number):void=>{
    const d=direction.clone().normalize()
    if(Math.abs(d.y)>.7)normal.set(d.x,0,d.z);else normal.set(0,1,0)
    if(normal.lengthSq()<1e-6)normal.set(1,0,0)
    normal.addScaledVector(d,-normal.dot(d)).normalize();side.crossVectors(d,normal)
    basis.makeBasis(side,d,normal);roll.setFromAxisAngle(d,(random(seed)-.5)*1.1)
    const matrix=new THREE.Matrix4().makeRotationFromQuaternion(roll).multiply(basis).scale(scale.setScalar(size)).setPosition(at)
    leafMatrices.push(matrix)
    const color=greens[Math.floor(random(seed+7)*greens.length)].clone().multiplyScalar(.82+random(seed+9)*.3)
    color.lerp(greens[5],THREE.MathUtils.clamp((at.y-2.3)*.6,0,.45));leafColors.push(color)
    leafSway.push(hang,phase);for(const target of targets)leafGlow.push(Math.exp(-at.distanceToSquared(target)/.08))
  }

  // Hanging branchlets: the willow curtain. Each is a thin tapering twig with leaves spiralling down it.
  const lights=new THREE.Group();lights.name='Falling light filaments';tree.add(lights)
  const hangPoint=new THREE.Vector3(),down=v(0,-1,0)
  let seed=1
  for(const {curve,from} of branches){
    for(let s=from+random(seed)*.05;s<.99;s+=.07+random(seed+900)*.05){
      seed++;const top=curve.getPointAt(s),out=curve.getTangentAt(s).setY(0).normalize(),length=.32+random(seed+40)*.5+s*.25,phase=random(seed+80)*Math.PI*2
      if(blocks(top.x,top.z,top.y,top.y-length))continue
      const jitter=v((random(seed+120)-.5)*.06,0,(random(seed+160)-.5)*.06)
      const points=[top,top.clone().addScaledVector(out,.05).add(v(0,.03,0)),top.clone().addScaledVector(out,.085).add(v(0,-.13,0)).add(jitter),top.clone().addScaledVector(out,.1).add(v(0,-length*.55,0)).add(jitter),top.clone().addScaledVector(out,.11).add(v(0,-length,0)).addScaledVector(jitter,1.6)]
      const hang=(p:THREE.Vector3):number=>THREE.MathUtils.clamp((top.y-p.y)/1.1,0,1)
      // Hair-thin twigs cast no useful shadow: they batch apart from the shadow-casting limbs.
      limb(taperedTube(points,.0045,.0012,8,3,p=>[hang(p),phase])).castShadow=false
      const twig=new THREE.CatmullRomCurve3(points,false,'centripetal'),nodes=Math.round(length/.056)
      for(let k=1;k<=nodes;k++){
        const t=.08+.9*k/nodes;twig.getPointAt(t,hangPoint);const beta=k*2.4+phase,tilt=.45+random(seed*31+k)*.5
        const direction=down.clone().multiplyScalar(Math.cos(tilt)).add(v(Math.cos(beta)*Math.sin(tilt),0,Math.sin(beta)*Math.sin(tilt)))
        addLeaf(hangPoint,direction,.068+random(seed*37+k)*.03,hang(hangPoint),phase,seed*53+k)
      }
    }
    // The crown: sprays of leaves along the upper side of every limb.
    for(let s=from-.05;s<1;s+=.055){
      const at=curve.getPointAt(s)
      for(let k=0;k<2;k++){
        const beta=random(seed*7+k)*Math.PI*2,lift=-1.1+random(seed*11+k)*.85,offset=v(Math.cos(beta)*.035,random(seed*13+k)*.03-.01,Math.sin(beta)*.035)
        const p=at.clone().add(offset);if(blocks(p.x,p.z,p.y+.05,p.y-.08))continue
        addLeaf(p,v(Math.cos(beta),lift,Math.sin(beta)),.075+random(seed*17+k)*.03,0,random(seed*19+k)*6.28,seed*59+k)
      }
      seed++
    }
  }

  // Light filaments: a few, hair-thin, brightest where they leave the branch and fading out towards the tips.
  const threadMat=new THREE.MeshBasicMaterial({color:'#ffffff',vertexColors:true,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending})
  threadMat.onBeforeCompile=shader=>{shader.uniforms.uSwayTime=swayTime;shader.vertexShader=SWAY_GLSL+shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\ntransformed+=willowSway(aSway);')}
  threadMat.customProgramCacheKey=()=>'willow-filament-v2'
  for(let i=0,made=0;i<120&&made<24;i++){
    const curve=boughs[i%boughs.length],s=.5+random(i+4400)*.48,top=curve.getPointAt(s).add(v((random(i+4500)-.5)*.12,-.01,(random(i+4600)-.5)*.12)),length=.45+random(i+4700)*.55,phase=random(i+4800)*Math.PI*2
    if(blocks(top.x,top.z,top.y,top.y-length))continue
    const points:THREE.Vector3[]=[];for(let j=0;j<=6;j++){const t=j/6;points.push(top.clone().add(v(Math.sin(t*2.6+i)*.02*t,-t*length,Math.sin(t*3+i)*.04*t)))}
    const thread=mesh(taperedTube(points,.0017,.0011,12,3,p=>[THREE.MathUtils.clamp((top.y-p.y)/1.1,0,1),phase],t=>[1,.9,.64,THREE.MathUtils.smoothstep(t,0,.06)*Math.pow(1-t,1.5)*.62]),threadMat,lights)
    thread.castShadow=thread.receiveShadow=false;made++
  }

  // Lanterns: ribbed paper chōchin with brass caps and a small cinnabar tassel.
  const lanterns:Lantern[]=[],profile:THREE.Vector2[]=[],steps=RIBS*3
  for(let j=0;j<=steps;j++){const t=j/steps,between=Math.pow(Math.sin(Math.PI*((t*RIBS)%1)),.6),r=(.03+Math.pow(Math.sin(Math.PI*t),.72)*.098)*(1-.024*between);profile.push(new THREE.Vector2(r,-.19+t*.38))}
  const bodyGeometry=new THREE.LatheGeometry(profile,24)
  const capProfile=[[.025,-.011],[.034,-.011],[.0365,-.007],[.0365,.007],[.034,.011],[.025,.011],[.025,-.011]].map(([x,y])=>new THREE.Vector2(x,y))
  const tasselProfile=[[0,-.2],[.009,-.203],[.0125,-.211],[.009,-.22],[.0055,-.226],[.007,-.25],[.011,-.282],[.0135,-.296],[.006,-.3],[0,-.3]].map(([x,y])=>new THREE.Vector2(x,y))
  const tasselMat=material('#8a3a2d',.96),cordMat=material('#5f5642',1)
  for(let i=0;i<3;i++){
    const [x,y,z]=LANTERNS[i],root=new THREE.Group();root.position.set(x,y,z);root.rotation.y=Math.atan2(-(VIEW.x-x),-(VIEW.z-z));root.name=`Paper lantern ${i+1}`;canopy.add(root)
    const anchor=new THREE.Vector3(x+.02,ANCHOR_Y[i],z-.03),local=anchor.clone().sub(TREE),start=BOUGH_ENDS[i]
    limb(taperedTube([v(start[0],start[1],start[2]),v((start[0]+local.x)*.5,anchor.y+.09,(start[2]+local.z)*.5),local.clone().add(v(0,.012,0))],.012,.005,12,4))
    const cord=mesh(new THREE.CylinderGeometry(.0025,.0025,1,5),cordMat,canopy);cord.castShadow=false
    const texture=lanternPaperTexture(i,RIBS)
    const lanternMaterial=new THREE.MeshStandardMaterial({color:'#f2e4c4',map:texture,roughness:.86,emissive:'#a5652f',emissiveMap:texture,emissiveIntensity:.55})
    const body=mesh(bodyGeometry,lanternMaterial,root);body.name=`lantern-hit-${i}`;body.castShadow=false
    for(const capY of [-.19,.19]){const cap=mesh(new THREE.LatheGeometry(capProfile,16),kit.brass,root,0,capY,0);cap.castShadow=false}
    mesh(new THREE.LatheGeometry(tasselProfile,10),tasselMat,root).castShadow=false
    const light=new THREE.PointLight('#FFBF69',.2,2.4,2);light.position.copy(root.position)
    lanterns.push({root,body,cord,anchor,light,material:lanternMaterial,restY:y})
    batchStatic(root,[body])
  }

  // Leaves: one instanced draw; warm light from a lit lantern shows through the nearby blades.
  const leafMat=new THREE.MeshStandardMaterial({color:'#ffffff',roughness:.7,side:THREE.DoubleSide})
  leafMat.onBeforeCompile=shader=>{
    shader.uniforms.uSwayTime=swayTime;shader.uniforms.uLanternLevels=levels
    shader.vertexShader=SWAY_GLSL+'attribute vec3 aGlow;uniform vec3 uLanternLevels;varying vec2 vLeafUv;varying float vLeafGlow;\n'+shader.vertexShader
      .replace('#include <begin_vertex>','#include <begin_vertex>\nvLeafUv=uv;vLeafGlow=dot(aGlow,uLanternLevels);')
      .replace('#include <project_vertex>',`vec4 mvPosition=vec4(transformed,1.);
        #ifdef USE_INSTANCING
          mvPosition=instanceMatrix*mvPosition;
        #endif
        mvPosition.xyz+=willowSway(aSway)+vec3(sin(uSwayTime*1.6+aSway.y*9.),0.,cos(uSwayTime*1.25+aSway.y*5.))*.0045*position.y;
        mvPosition=modelViewMatrix*mvPosition;gl_Position=projectionMatrix*mvPosition;`)
    shader.fragmentShader='varying vec2 vLeafUv;varying float vLeafGlow;\n'+shader.fragmentShader
      .replace('#include <color_fragment>',`#include <color_fragment>
        float leafRib=1.-smoothstep(0.,.07,abs(vLeafUv.x-.5));
        diffuseColor.rgb*=mix(.78,1.,smoothstep(0.,.4,vLeafUv.y))*(1.+leafRib*.32)*mix(1.,.86,smoothstep(.25,.5,abs(vLeafUv.x-.5)));
        if(!gl_FrontFacing)diffuseColor.rgb*=vec3(1.1,1.14,.86);`)
      .replace('#include <emissivemap_fragment>','#include <emissivemap_fragment>\ntotalEmissiveRadiance+=diffuseColor.rgb*vec3(1.,.62,.3)*vLeafGlow*2.2;')
  }
  leafMat.customProgramCacheKey=()=>'willow-leaf-v1'
  const leafGeo=leafGeometry(),leaves=new THREE.InstancedMesh(leafGeo,leafMat,leafMatrices.length);leaves.name=`${leafMatrices.length} willow leaves`
  leafMatrices.forEach((matrix,i)=>{leaves.setMatrixAt(i,matrix);leaves.setColorAt(i,leafColors[i])})
  leafGeo.setAttribute('aSway',new THREE.InstancedBufferAttribute(new Float32Array(leafSway),2));leafGeo.setAttribute('aGlow',new THREE.InstancedBufferAttribute(new Float32Array(leafGlow),3))
  leaves.receiveShadow=true;leaves.computeBoundingSphere();tree.add(leaves)

  batchStatic(tree,[leaves,lights]);batchStatic(lights)
  return {canopy,lanterns,update(time,reduced){
    swayTime.value=reduced?0:time
    levels.value.set(lanterns[0].material.emissiveIntensity/3.1,lanterns[1].material.emissiveIntensity/3.1,lanterns[2].material.emissiveIntensity/3.1)
  }}
}
