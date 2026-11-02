import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { mesh } from './craft'
import { coreBreath,createMotionClock } from './glow'
import { random } from './noise'
import { applySurface } from './surface'

/** Where glow.ts hangs the core, in lotus space: island (-.25,.53,-.55) minus the lotus origin (-.25,.15,-.55), over the .78 scale. */
const CORE=new THREE.Vector3(0,(.53-.15)/.78,0)

/**
 * One petal: a thin lens-section shell. Narrow claw at the base, widest a little past the middle, then tapering to a
 * pointed tip; boat-cupped across, and (petals) curling in towards the flower's heart along its length so the rings
 * read as a bowl, or (sepals, `reflex`) bending out. Local +z is the outer face.
 * uv.x runs once around the section (sin(2πu) is the across-petal coordinate, cos(2πu)>0 the outer face), uv.y base → tip.
 *
 * Shading normals are the porcelain sheet's own (the mid-surface normal, flipped on the inner face), and each rim is two
 * coincident vertex columns, one per face. Smooth normals averaged across the knife-thin rim pointed sideways and,
 * interpolated over the last 1/8 of the section, drew a dark crescent along every petal edge.
 */
function petalShell(length:number,width:number,seed:number,rows:number,columns:number,shape:{depth?:number;curl?:number;point?:number;reflex?:boolean}={}):THREE.BufferGeometry {
  const {depth=1,curl=0,point:tip=.38,reflex=false}=shape
  const positions:number[]=[],normals:number[]=[],uvs:number[]=[],indices:number[]=[]
  const cupping=(.88+random(seed)*.12)*depth,flutter=random(seed+1)*6.28,ripple=.003+random(seed+2)*.005
  const breadthAt=(t:number):number=>{const swell=Math.sin(Math.PI*Math.pow(t,1.15));return width*Math.pow(swell,.5+.7*t)*(1-tip*THREE.MathUtils.smoothstep(t,.74,1))}
  const mid=(t:number,v:number,out:THREE.Vector3):THREE.Vector3=>{
    const swell=Math.sin(Math.PI*Math.pow(t,1.15)),across=(reflex?.15:.2)*Math.pow(swell,.8)*(1-v*v)
    const along=reflex?.17*t*t-.1*Math.pow(t,6):-curl*t*t
    return out.set(breadthAt(t)*v,length*t,(across+along)*cupping+ripple*Math.sin(t*11+flutter+v*2)*v*v*t)
  }
  // Section angles: the outer face, a duplicated rim, the inner face, the other duplicated rim, back to the outer seam.
  const quarter=columns/4,angles:{a:number;inner:boolean}[]=[]
  for(let j=0;j<=columns;j++){const a=j/columns*Math.PI*2;angles.push({a,inner:j>quarter&&j<=3*quarter});if(j===quarter||j===3*quarter)angles.push({a,inner:j===quarter})}
  const point=new THREE.Vector3(),du=new THREE.Vector3(),dv=new THREE.Vector3(),normal=new THREE.Vector3(),e=1e-3
  for(let i=0;i<=rows;i++)for(const {a,inner} of angles){
    const t=i/rows,v=Math.sin(a),thickness=.022*Math.pow(Math.sin(Math.PI*t),.5)*(1-.3*t)
    mid(t,v,point);positions.push(point.x,point.y,point.z+thickness*Math.cos(a));uvs.push(a/(Math.PI*2),t)
    const tn=THREE.MathUtils.clamp(t,.02,.97),vn=THREE.MathUtils.clamp(v,-1+e,1-e)
    mid(tn+e,vn,du).sub(mid(tn-e,vn,point));mid(tn,vn+e,dv).sub(mid(tn,vn-e,point))
    normal.crossVectors(dv,du).normalize();if(normal.z<0)normal.negate();if(inner)normal.negate();normals.push(normal.x,normal.y,normal.z)
  }
  const stride=angles.length
  // The zero-width quads between the duplicated rim columns are skipped: same triangle count as a single seam.
  for(let i=0;i<rows;i++)for(let j=0;j<stride-1;j++){if(angles[j].a===angles[j+1].a)continue;const a=i*stride+j,b=a+1,c=a+stride;indices.push(a,b,c,b,c+1,c)}
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3))
  geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));geometry.setIndex(indices)
  return geometry
}

const petalVertexPars=`
attribute vec3 aPivot;attribute vec4 aPetal;
uniform float uTime,uSway,uOpen;uniform vec3 uCore;
varying vec2 vPetalUv;varying float vPetalRand,vPetalLayer;varying vec3 vCoreView;
vec3 petalRotate(vec3 v,vec3 k,float a){float c=cos(a),s=sin(a);return v*c+cross(k,v)*s+k*dot(k,v)*(1.-c);}
`
// Each petal swings about its own root (the old per-petal pivot), so 36 petals stay one draw call.
const petalNormal=`
float petalAngle=uSway*(sin(uTime*.72+aPetal.y*.12)*.028+sin(uTime*.29+aPetal.z)*.006)+uOpen*(.012+aPetal.y*.01);
vec3 petalAxis=vec3(cos(aPetal.x),0.,-sin(aPetal.x));
objectNormal=petalRotate(objectNormal,petalAxis,petalAngle);
`
const petalBegin=`
transformed=aPivot+petalRotate(transformed-aPivot,petalAxis,petalAngle);
vPetalUv=uv;vPetalRand=aPetal.w;vPetalLayer=aPetal.y;vCoreView=(modelViewMatrix*vec4(uCore,1.)).xyz;
`
const petalFragmentPars=`
uniform float uGlow,uRelief;uniform vec3 uGlowColor,uBase,uIvory,uBlush,uRose;
varying vec2 vPetalUv;varying float vPetalRand,vPetalLayer;varying vec3 vCoreView;
float petalVein,petalEdge,petalThin;vec3 petalTint;
vec3 petalPerturb(vec3 p,vec3 n,float h,float faceDir){
  vec3 sx=dFdx(p),sy=dFdy(p),r1=cross(sy,n),r2=cross(n,sx);float det=dot(sx,r1)*faceDir;
  vec3 grad=sign(det)*(dFdx(h)*r1+dFdy(h)*r2)*uRelief;return normalize(abs(det)*n-grad);}
`
// Ivory body, a creamy-green heart at the base, a dusty blush gathering at the tip and along the rim; fine veins
// fan out from the base (iso-lines of the across coordinate) and fade before they alias.
const petalColor=`
float petalA=vPetalUv.x*6.28318530718,petalAcross=sin(petalA),petalSide=cos(petalA),petalT=vPetalUv.y;
petalEdge=smoothstep(.6,1.,abs(petalAcross));
float petalQ=petalAcross*(6.5+vPetalRand*1.5)+sin(petalT*4.+petalAcross*2.5)*.18*petalT,petalQw=fwidth(petalQ);
float petalFine=(1.-smoothstep(.02,.07+petalQw,abs(fract(petalQ+.5)-.5)))*(1.-smoothstep(.12,.32,petalQw));
petalFine*=smoothstep(.02,.14,petalT)*(1.-smoothstep(.78,.97,petalT))*(1.-petalEdge*.7);
float petalMid=(1.-smoothstep(0.,.045+fwidth(petalAcross)*1.5,abs(petalAcross)))*smoothstep(0.,.1,petalT)*(1.-smoothstep(.55,.9,petalT));
petalVein=max(petalFine*.55,petalMid*.7);
float petalOuter=1.-smoothstep(1.2,2.6,vPetalLayer);
float petalBlush=smoothstep(.4,.95,petalT*.9+petalEdge*.25+(vPetalRand-.5)*.2)*mix(.7,1.,step(0.,petalSide))*petalOuter;
vec3 petalPigment=mix(uBase,uIvory,smoothstep(.02,.3,petalT));
petalPigment=mix(petalPigment,uBlush,petalBlush*.85);
petalPigment=mix(petalPigment,uRose,smoothstep(.74,1.02,petalT+petalEdge*.12)*petalBlush*.8);
petalPigment*=1.-petalVein*mix(.012,.045,petalBlush);
petalTint=petalPigment;
petalThin=max(1.-abs(petalSide)*.45,smoothstep(.72,1.,petalT));
diffuseColor.rgb*=petalPigment;
`
const petalRoughness=`
roughnessFactor=clamp(roughnessFactor+petalVein*.07-petalEdge*.06,.05,1.);
`
const petalNormalMap=`
normal=petalPerturb(-vViewPosition,normal,petalVein,faceDirection);
`
// Thin porcelain lets the core through: strongest where the core sits behind the petal, at thin rims and tips,
// dimmer along the veins. Emitted, so the reflected-light calibration in optics.ts does not flatten it.
const petalEmissive=`
vec3 petalToCore=vCoreView+vViewPosition;float petalDist=max(length(petalToCore),1e-4);petalToCore/=petalDist;
float petalNear=exp(-petalDist*petalDist*3.);
float petalBack=clamp(dot(petalToCore,normalize(-vViewPosition)),0.,1.);
float petalLit=clamp(dot(normal,petalToCore),0.,1.);
float petalSss=petalNear*(.16+.84*petalBack*petalBack)*petalThin*(1.-petalVein*.4);
totalEmissiveRadiance+=uGlowColor*uGlow*(mix(vec3(1.),petalTint,.6)*petalSss+petalTint*petalNear*petalLit*.3+petalEdge*petalBack*.25);
`

/** Calyx cup, five sepals and the seed head, one low-poly batch tucked under the petals (within the old base footprint). */
function lotusBase():THREE.BufferGeometry {
  const parts:THREE.BufferGeometry[]=[],olive=new THREE.Color('#4a5730'),pod=new THREE.Color('#9d9a52'),color=new THREE.Color()
  const paint=(geometry:THREE.BufferGeometry,from:THREE.Color,to:THREE.Color,low:number,high:number):THREE.BufferGeometry=>{
    const positions=geometry.getAttribute('position'),colors:number[]=[]
    for(let i=0;i<positions.count;i++){color.copy(from).lerp(to,THREE.MathUtils.smoothstep(positions.getY(i),low,high));colors.push(color.r,color.g,color.b)}
    geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));return geometry
  }
  const calyx=new THREE.LatheGeometry([[0,-.18],[.05,-.177],[.1,-.163],[.14,-.135],[.163,-.1],[.168,-.07],[.15,-.046],[.1,-.032],[0,-.026]].map(([x,y])=>new THREE.Vector2(x,y)),18)
  const positions=calyx.getAttribute('position')
  for(let i=0;i<positions.count;i++){const x=positions.getX(i),z=positions.getZ(i),rib=1+.06*Math.sin(Math.atan2(z,x)*5)*THREE.MathUtils.smoothstep(positions.getY(i),-.18,-.08);positions.setXYZ(i,x*rib,positions.getY(i),z*rib)}
  calyx.computeVertexNormals();parts.push(paint(calyx,new THREE.Color('#2f3a22'),olive,-.18,-.06))
  const head=new THREE.LatheGeometry([[0,-.03],[.04,-.03],[.06,.06],[.082,.16],[.088,.19],[.07,.2],[0,.205]].map(([x,y])=>new THREE.Vector2(x,y)),14)
  parts.push(paint(head,olive,pod,.0,.19))
  const helper=new THREE.Object3D()
  for(let i=0;i<5;i++){
    const sepal=petalShell(.3,.12,900+i*7,10,8,{depth:.3,reflex:true}),angle=i/5*Math.PI*2+.31
    helper.position.set(Math.sin(angle)*.11,-.13,Math.cos(angle)*.11);helper.rotation.set(1.36+random(940+i)*.12,angle,0,'YXZ');helper.scale.setScalar(.9+random(950+i)*.1);helper.updateMatrix()
    sepal.applyMatrix4(helper.matrix);parts.push(paint(sepal,new THREE.Color('#38452a'),new THREE.Color('#6b5a3a'),-.14,-.11))
  }
  const merged=mergeGeometries(parts,false);parts.forEach(g=>g.dispose());if(!merged)throw new Error('Lotus base merge failed')
  return merged
}

export function createLotus():{group:THREE.Group;petalCount:number;material:THREE.MeshPhysicalMaterial;update:(time:number,reduced:boolean)=>void} {
  const group=new THREE.Group();group.name='Porcelain Lotus — 36 petals';group.position.set(-.25,.15,-.55);group.scale.setScalar(.78)
  const material=new THREE.MeshPhysicalMaterial({color:'#ffffff',transmission:.35,thickness:.2,roughness:.46,metalness:0,ior:1.42,specularIntensity:.42,
    sheen:.55,sheenRoughness:.55,sheenColor:new THREE.Color('#ffd6c8'),clearcoat:.2,clearcoatRoughness:.32,attenuationColor:new THREE.Color('#f5c4ae'),attenuationDistance:.45})
  const uniforms={uTime:{value:0},uSway:{value:1},uOpen:{value:0},uCore:{value:CORE},uGlow:{value:.5},uRelief:{value:.0006},
    uGlowColor:{value:new THREE.Color('#ffc58a')},uBase:{value:new THREE.Color('#e6e0bb')},uIvory:{value:new THREE.Color('#fbf4ea')},uBlush:{value:new THREE.Color('#eeb3bb')},uRose:{value:new THREE.Color('#b4566e')}}
  material.onBeforeCompile=shader=>{
    Object.assign(shader.uniforms,uniforms)
    shader.vertexShader=petalVertexPars+shader.vertexShader.replace('#include <beginnormal_vertex>','#include <beginnormal_vertex>'+petalNormal).replace('#include <begin_vertex>','#include <begin_vertex>'+petalBegin)
    shader.fragmentShader=petalFragmentPars+shader.fragmentShader
      .replace('#include <color_fragment>','#include <color_fragment>'+petalColor)
      .replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>'+petalRoughness)
      .replace('#include <normal_fragment_maps>','#include <normal_fragment_maps>'+petalNormalMap)
      .replace('#include <emissivemap_fragment>','#include <emissivemap_fragment>'+petalEmissive)
  }
  material.customProgramCacheKey=()=>'liora-porcelain-petal-v3'
  // A bowl, not a stack of saucers: each ring leaves the receptacle a little more upright than the one outside it and
  // curls in towards the heart (curl), so the outer petals cup the inner ones instead of fanning out flat.
  const rings=[{length:.8,width:.27,radius:.17,y:-.08,tilt:1.22,curl:.14,point:.4,count:11},{length:.85,width:.265,radius:.12,y:.035,tilt:.94,curl:.13,point:.32,count:10},{length:.8,width:.26,radius:.075,y:.15,tilt:.8,curl:.14,point:.18,count:8},{length:.68,width:.24,radius:.035,y:.245,tilt:.6,curl:.15,point:.08,count:7}]
  const shells:THREE.BufferGeometry[]=[],helper=new THREE.Object3D()
  let index=0
  rings.forEach((ring,layer)=>{
    for(let i=0;i<ring.count;i++,index++){
      // Hand-made spread: a little angle, twist and size jitter per petal; the jitter only closes the tilt and only shrinks
      // the scale. The front petals of the inner rings open a little towards the viewers so the lit cup shows. The bowl stays
      // inside the old footprint: scene.inspect() frames every vertex against the header and the chat panel (checked at
      // 320×568, 390×844 and 1000×600).
      const seed=index*31+7,angle=i/ring.count*Math.PI*2+layer*.37+(random(seed)-.5)*.1
      const tilt=ring.tilt+Math.max(0,Math.cos(angle))*(layer===3?.26:layer===2?.16:.03)-random(seed+1)*.1
      const geometry=petalShell(ring.length,ring.width,seed,28,16,{curl:ring.curl,point:ring.point}),count=geometry.getAttribute('position').count
      helper.position.set(Math.sin(angle)*ring.radius,ring.y,Math.cos(angle)*ring.radius);helper.rotation.set(tilt,angle,(random(seed+2)-.5)*.2,'YXZ');helper.scale.setScalar(.93+random(seed+3)*.07);helper.updateMatrix()
      geometry.applyMatrix4(helper.matrix)
      const pivot=new Float32Array(count*3),petal=new Float32Array(count*4)
      for(let k=0;k<count;k++){pivot.set([helper.position.x,helper.position.y,helper.position.z],k*3);petal.set([angle,layer,i*.29,random(seed+4)],k*4)}
      geometry.setAttribute('aPivot',new THREE.BufferAttribute(pivot,3));geometry.setAttribute('aPetal',new THREE.BufferAttribute(petal,4));shells.push(geometry)
    }
  })
  const merged=mergeGeometries(shells,false);shells.forEach(g=>g.dispose());if(!merged)throw new Error('Lotus petal merge failed')
  const petals=mesh(merged,material,group);petals.name='Porcelain petals (36, one batch)'
  const baseMaterial=applySurface(new THREE.MeshStandardMaterial({color:'#ffffff',vertexColors:true,roughness:.82,metalness:0}),{scale:7,bump:.005,fine:.5,variation:.2,tint:'#8a7448',cavity:.3,roughnessVariation:.1})
  const base=mesh(lotusBase(),baseMaterial,group);base.name='Lotus calyx, sepals and seed head';base.castShadow=false
  // The petals share the core's drifting rhythm (glow.ts): the glow through the porcelain is light, so it follows the core
  // at once; the petals themselves ease open a beat (.35 s) behind it. Under reduced motion both settle and hold still.
  const clock=createMotionClock();let lastTime=0
  return {group,material,petalCount:index,update(time,reduced){
    clock.tick(time-lastTime,reduced);lastTime=time
    const glow=.5+(coreBreath(clock.time)-.5)*clock.live
    uniforms.uTime.value=clock.time;uniforms.uSway.value=clock.live;uniforms.uOpen.value=coreBreath(clock.time-.35)*clock.live;uniforms.uGlow.value=.44+.12*glow
  }}
}
