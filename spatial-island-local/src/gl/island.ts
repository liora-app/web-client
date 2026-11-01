import * as THREE from 'three'
import { batchStatic,contact,grainTexture,mesh,shadowTexture } from './craft'
import { createArtifacts } from './artifacts'
import { fractal,noise3,random } from './noise'
import { lightRay } from './optics'

export function surfaceHeight(x:number,z:number):number {
  const distance=Math.hypot(x+.25,(z+.55)*1.12)
  return .018+fractal(x*.95,7,z*.95)*.065-.028*Math.exp(-distance*distance*1.8)
}
function terrace(radius:number,height:number,y:number,seed:number):THREE.BufferGeometry {
  const geometry=new THREE.CylinderGeometry(radius*.97,radius*.88,height,112,10),positions=geometry.getAttribute('position'),colors:number[]=[]
  const stone=new THREE.Color('#141E18'),moss=new THREE.Color('#2A4B37'),olive=new THREE.Color('#4A6340'),color=new THREE.Color()
  for(let i=0;i<positions.count;i++){
    const x=positions.getX(i),py=positions.getY(i),z=positions.getZ(i),angle=Math.atan2(z,x)
    const noise=fractal(x*.95+seed,py*3,z*.95),edge=1+noise*.065+Math.sin(angle*7+seed)*.018
    const top=(py+height/2)/height
    positions.setXYZ(i,x*edge,py+y+noise*.055,z*edge*.84)
    color.copy(stone).lerp(moss,top*.7).lerp(olive,Math.max(0,noise)*top*.3);colors.push(color.r,color.g,color.b)
  }
  geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));geometry.computeVertexNormals();return geometry
}
function livingSurface():THREE.BufferGeometry {
  const rings=36,segments=112,positions:number[]=[],colors:number[]=[],uvs:number[]=[],indices:number[]=[]
  const moss=new THREE.Color('#2A4B37'),olive=new THREE.Color('#4A6340'),wet=new THREE.Color('#19291e'),color=new THREE.Color()
  for(let ring=0;ring<=rings;ring++)for(let i=0;i<=segments;i++){
    const angle=i/segments*Math.PI*2,fraction=ring/rings,radius=4.05*fraction*(1+Math.sin(angle*7)*.018+noise3(Math.cos(angle)*2,3,Math.sin(angle)*2)*.055)
    const x=Math.cos(angle)*radius,z=Math.sin(angle)*radius*.84,y=surfaceHeight(x,z)
    positions.push(x,y,z);uvs.push(x*.7,z*.7)
    const center=Math.exp(-Math.hypot(x+.25,z+.55)*.7),n=fractal(x*2,4,z*2)
    color.copy(wet).lerp(moss,.65+n*.25).lerp(olive,center*.38);colors.push(color.r,color.g,color.b)
  }
  for(let ring=0;ring<rings;ring++)for(let i=0;i<segments;i++){const a=ring*(segments+1)+i,b=a+1,c=a+segments+1;indices.push(a,b,c,b,c+1,c)}
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));geometry.setIndex(indices);geometry.computeVertexNormals();return geometry
}
function boulder(seed:number):THREE.BufferGeometry {
  const geometry=new THREE.IcosahedronGeometry(1,3),positions=geometry.getAttribute('position'),colors:number[]=[],color=new THREE.Color(),stone=new THREE.Color('#233329'),moss=new THREE.Color('#3e5738')
  for(let i=0;i<positions.count;i++){
    const x=positions.getX(i),y=positions.getY(i),z=positions.getZ(i),scale=1+fractal(x*2+seed,y*2,z*2)*.24
    positions.setXYZ(i,x*scale,y*scale,z*scale);color.copy(stone).lerp(moss,THREE.MathUtils.smoothstep(y,-.1,.9));colors.push(color.r,color.g,color.b)
  }
  geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));geometry.computeVertexNormals();return geometry
}

export function createIsland() {
  const group=new THREE.Group();group.name='Terraced organic sanctuary'
  const artifacts=createArtifacts();group.add(artifacts.stations,artifacts.canopy);for(const lantern of artifacts.lanterns)group.add(lantern.light)
  const clay=grainTexture('clay'),groundMat=new THREE.MeshStandardMaterial({color:'#ffffff',roughness:.98,vertexColors:true,bumpMap:clay,bumpScale:.045})
  const lower=mesh(terrace(3.32,.23,-.50,19),groundMat,group);lower.name='Lower wet rock terrace'
  const middle=mesh(terrace(3.76,.27,-.29,31),groundMat,group);middle.name='Middle moss terrace'
  const upper=mesh(terrace(4.05,.18,-.105,7),groundMat,group);upper.name='Upper sculpted terrace'
  const surface=mesh(livingSurface(),groundMat,group);surface.name='Noise sculpted moss basin'
  const grassGeo=new THREE.PlaneGeometry(.026,.17,1,3);grassGeo.translate(0,.085,0)
  const grassPositions=grassGeo.getAttribute('position')
  for(let i=0;i<grassPositions.count;i++){const t=grassPositions.getY(i)/.17;grassPositions.setX(i,grassPositions.getX(i)*(1-t*.92));grassPositions.setZ(i,t*t*.048)}grassGeo.computeVertexNormals()
  const windTime={value:0},grassMat=new THREE.MeshStandardMaterial({color:'#ffffff',emissive:'#18321f',emissiveIntensity:.12,roughness:1,side:THREE.DoubleSide,vertexColors:false})
  grassMat.onBeforeCompile=shader=>{
    shader.uniforms.uWindTime=windTime
    shader.vertexShader='uniform float uWindTime;varying float vGrassTip;varying float vNearLotus;\n'+shader.vertexShader
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
      vec3 bladeOrigin=instanceMatrix[3].xyz;float tip=clamp(position.y/.17,0.,1.);float wind=sin(uWindTime*.65+bladeOrigin.x*.9+bladeOrigin.z*.6)*.65+sin(uWindTime*.93+bladeOrigin.z*1.8)*.35;
      transformed.x+=wind*.035*tip*tip;transformed.z+=cos(uWindTime*.45+bladeOrigin.x)*.018*tip*tip;
      vGrassTip=tip;vNearLotus=exp(-length(bladeOrigin.xz-vec2(-.25,-.55))*1.6);`)
    shader.fragmentShader='varying float vGrassTip;varying float vNearLotus;\n'+shader.fragmentShader
    shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>','#include <color_fragment>\ndiffuseColor.rgb*=mix(.46,1.15,vGrassTip);diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.72,.48,.15),vGrassTip*vGrassTip*vNearLotus*.5);')
  }
  grassMat.customProgramCacheKey=()=> 'sanctuary-wind-grass-v1'
  const grass=new THREE.InstancedMesh(grassGeo,grassMat,4500);grass.name='4500 living blades and fern fronds';grass.receiveShadow=true
  const dummy=new THREE.Object3D(),color=new THREE.Color()
  let accepted=0,attempt=0
  while(accepted<4500){
    const seed=attempt++,a=random(seed*7+1)*Math.PI*2,r=Math.sqrt(random(seed*11+2))*3.98,x=Math.cos(a)*r,z=Math.sin(a)*r*.84
    const blocked=Math.hypot(x+.25,z+.55)<.78||Math.hypot(x+1.55,z-.75)<.55||Math.hypot(x+1.05,z-1.55)<.46||Math.hypot(x-.8,z+1.1)<.55||Math.hypot(x-1.85,z+.85)<.31
    if(blocked)continue
    dummy.position.set(x,surfaceHeight(x,z)+.002,z);dummy.rotation.set(0,a,0)
    const height=.6+random(seed+600)*1.0,fern=accepted%13===0;dummy.scale.set(fern?2.2:.7+random(seed+700)*.7,height*(fern?1.25:1),1);dummy.updateMatrix();grass.setMatrixAt(accepted,dummy.matrix)
    color.set('#3f6646').lerp(new THREE.Color('#7c8950'),random(seed+800)*.5);grass.setColorAt(accepted,color);accepted++
  }
  grass.computeBoundingSphere();group.add(grass)
  const fernPositions:number[]=[],fernUvs:number[]=[],fernIndices:number[]=[]
  for(let j=0;j<6;j++)for(const side of [-1,1]){
    const t=(j+1)/7,y=t*.24,breadth=.075*(1-t*.7),offset=fernPositions.length/3
    fernPositions.push(0,y,.04*t*t,side*breadth,y+.021,.04*t*t+.015,side*breadth*.48,y-.027,.04*t*t+.008)
    fernUvs.push(.5,t,side<0?0:1,t+.08,.5,t-.1);fernIndices.push(offset,offset+1,offset+2)
  }
  const fernGeo=new THREE.BufferGeometry();fernGeo.setAttribute('position',new THREE.Float32BufferAttribute(fernPositions,3));fernGeo.setAttribute('uv',new THREE.Float32BufferAttribute(fernUvs,2));fernGeo.setIndex(fernIndices);fernGeo.computeVertexNormals()
  const ferns=new THREE.InstancedMesh(fernGeo,grassMat,96);ferns.name='Small wind-swept ferns';ferns.receiveShadow=true
  for(let i=0;i<96;i++){const a=i*2.39996,r=2.5+random(i+2400)*.9,x=Math.cos(a)*r,z=Math.sin(a)*r*.84;dummy.position.set(x,surfaceHeight(x,z),z);dummy.rotation.set(0,a,0);dummy.scale.setScalar(.65+random(i+2600)*.55);dummy.updateMatrix();ferns.setMatrixAt(i,dummy.matrix);ferns.setColorAt(i,color.set('#52855a'))}
  ferns.computeBoundingSphere();group.add(ferns)
  for(let i=0;i<19;i++){
    const a=i*2.39996,r=3.63+random(i+50)*.25,stone=mesh(boulder(i*3+4),groundMat,group,Math.cos(a)*r,-.025,Math.sin(a)*r*.84)
    stone.name='Sculptural moss boulder';stone.scale.set(.19+random(i+60)*.19,.15+random(i+70)*.22,.22+random(i+80)*.22);stone.rotation.y=a
  }
  const cushionGeometry=new THREE.SphereGeometry(1,40,24),cushionPositions=cushionGeometry.getAttribute('position')
  for(let i=0;i<cushionPositions.count;i++){const x=cushionPositions.getX(i),y=cushionPositions.getY(i),z=cushionPositions.getZ(i),scale=1+fractal(x*3,y*3,z*3)*.035;cushionPositions.setXYZ(i,x*scale,y*scale,z*scale)}cushionGeometry.computeVertexNormals()
  const cushion=mesh(cushionGeometry,new THREE.MeshStandardMaterial({color:'#70885a',roughness:1,bumpMap:grainTexture('knit'),bumpScale:.028}),group,.8,.205,-1.1);cushion.name='Companion moss cushion';cushion.scale.set(.49,.22,.34)
  const shadow=shadowTexture();contact(group,shadow,.8,-1.1,1.3,.95);contact(group,shadow,-.25,-.55,1.8,1.7)
  const crystalMat=new THREE.MeshPhysicalMaterial({color:'#c4d99a',roughness:.32,transmission:.15,thickness:.25,emissive:'#b1c880',emissiveIntensity:1.5})
  const rays:ReturnType<typeof lightRay>[]=[]
  for(let i=0;i<3;i++){
    const a=-.8+i*2.2,r=3.2,x=Math.cos(a)*r,z=Math.sin(a)*r*.84
    const crystal=mesh(new THREE.CylinderGeometry(0,.065,.32,5),crystalMat,group,x,.1,z);crystal.rotation.set(.12,0,.12)
    const ray=lightRay(.22,1.7,'#a6c993',.037);ray.position.set(x,-.46,z);ray.rotation.z=(i-1)*.12;group.add(ray);rays.push(ray)
  }
  batchStatic(group,[artifacts.stations,artifacts.canopy,grass,ferns,...artifacts.lanterns.map(l=>l.light),...rays])
  return {group,...artifacts,grass,terraces:3,update(time:number,reduced:boolean){windTime.value=reduced?0:time;artifacts.update(time,reduced);for(const ray of rays)ray.material.uniforms.uTime.value=time}}
}

