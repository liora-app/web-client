import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { random } from './noise'
import { surfaceNoise } from './surface'

/** What the island tells the vegetation about its ground. All coordinates are island-local. */
export interface Ground {
  height:(x:number,z:number)=>number
  /** Largest placement radius (ellipse parameter, z is squashed by .84) at an angle, inside the moss lip. */
  edge:(angle:number)=>number
  /** True inside a keep-out (station bases, boulders, the cushion). */
  blocked:(x:number,z:number)=>boolean
  /** 0..1: how dense and tall the grass grows here (0 on bare soil). */
  lush:(x:number,z:number)=>number
}
export interface Vegetation {
  grass:THREE.InstancedMesh
  ferns:THREE.InstancedMesh
  flowers:THREE.InstancedMesh
  mushrooms:THREE.InstancedMesh
  update:(time:number,reduced:boolean)=>void
}

const SQUASH=.84,BLADE_HEIGHT=.16,BLADE_WIDTH=.019
/** A curved, tapering blade: 4 rows and a point (7 triangles). Normals bow outwards across the width so a flat card shades like a round leaf. */
function bladeGeometry():THREE.BufferGeometry {
  const rows=[0,.3,.56,.8],positions:number[]=[],normals:number[]=[],blade:number[]=[],indices:number[]=[],normal=new THREE.Vector3()
  const curl=.34
  for(const t of rows){
    const half=BLADE_WIDTH*.5*(1-Math.pow(t,1.3)*.8),y=t*BLADE_HEIGHT,z=curl*BLADE_HEIGHT*t*t
    for(const side of [-1,1]){positions.push(side*half,y,z);normal.set(side*.62,-2*curl*t,1).normalize();normals.push(normal.x,normal.y,normal.z);blade.push(t,BLADE_HEIGHT)}
  }
  positions.push(0,BLADE_HEIGHT,curl*BLADE_HEIGHT);normal.set(0,-2*curl,1).normalize();normals.push(normal.x,normal.y,normal.z);blade.push(1,BLADE_HEIGHT)
  for(let r=0;r<3;r++){const a=r*2;indices.push(a,a+1,a+2,a+1,a+3,a+2)}
  indices.push(6,7,8)
  const geometry=new THREE.BufferGeometry()
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));geometry.setAttribute('aBlade',new THREE.Float32BufferAttribute(blade,2))
  geometry.setIndex(indices);return geometry
}

/** One arching fern frond: a thin rachis and eight pairs of swept leaflets (38 triangles). Local +z is the direction it reaches. */
function frondGeometry():THREE.BufferGeometry {
  const length=.27,positions:number[]=[],blade:number[]=[],indices:number[]=[]
  const spine=(s:number,out:THREE.Vector3):THREE.Vector3=>out.set(0,length*(1.05*s-.78*s*s),length*s*.96)
  const point=new THREE.Vector3(),tip=new THREE.Vector3(),mid=new THREE.Vector3(),across=new THREE.Vector3(),direction=new THREE.Vector3(),up=new THREE.Vector3(0,1,0)
  const vertex=(v:THREE.Vector3,s:number):number=>{positions.push(v.x,v.y,v.z);blade.push(s,length);return positions.length/3-1}
  const rachis:number[]=[]
  for(let k=0;k<=4;k++){const s=k/4,w=.0055*(1-s*.75);spine(s,point);rachis.push(vertex(tip.set(-w,point.y,point.z),s),vertex(tip.set(w,point.y,point.z),s))}
  for(let k=0;k<4;k++){const a=rachis[k*2],b=rachis[k*2+1],c=rachis[k*2+2],d=rachis[k*2+3];indices.push(a,b,c,b,d,c)}
  for(let k=0;k<8;k++){
    const s=.16+k/7*.78,size=.085*Math.sin(Math.PI*Math.min(1,.18+s*.86))*(1-s*.35)
    spine(s,point)
    for(const side of [-1,1]){
      tip.copy(point).add(direction.set(side*size,-size*.32,size*.5))
      direction.subVectors(tip,point).normalize();across.crossVectors(up,direction).normalize().multiplyScalar(size*.2)
      mid.lerpVectors(point,tip,.42)
      const base=vertex(point,s),left=vertex(mid.clone().add(across),s+.03),end=vertex(tip,s+.06),right=vertex(mid.clone().sub(across),s+.03)
      indices.push(base,left,end,base,end,right)
    }
  }
  const geometry=new THREE.BufferGeometry()
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('aBlade',new THREE.Float32BufferAttribute(blade,2))
  geometry.setIndex(indices);geometry.computeVertexNormals();return geometry
}

/**
 * Shared foliage shading: dark root (ambient occlusion) to a lighter tip, amber light through the tips near the lotus,
 * wind gusts that travel across the island as a noise field, and blades that bow out of the way right in front of the lens.
 */
function foliageMaterial(time:{value:number}):THREE.MeshStandardMaterial {
  const material=new THREE.MeshStandardMaterial({color:'#ffffff',roughness:.9,metalness:0,side:THREE.DoubleSide})
  const uniforms={uWindTime:time,uWindNoise:{value:surfaceNoise()},uLotus:{value:new THREE.Vector3(-.25,.53,-.55)},uLotusGlow:{value:new THREE.Color('#ffb25a')}}
  material.onBeforeCompile=shader=>{
    Object.assign(shader.uniforms,uniforms)
    shader.vertexShader='uniform float uWindTime;uniform sampler2D uWindNoise;uniform vec3 uLotus;attribute vec2 aBlade;varying float vTip;varying float vLotus;varying vec3 vToLotus;\n'+shader.vertexShader
      .replace('#include <begin_vertex>',`#include <begin_vertex>
        vec3 bladeRoot=instanceMatrix[3].xyz;
        float lensNear=smoothstep(.4,1.15,distance(cameraPosition,(modelMatrix*vec4(bladeRoot,1.)).xyz));
        transformed.y*=mix(.22,1.,lensNear);transformed.xz*=mix(.5,1.,lensNear);
        vTip=aBlade.x;`)
      .replace('#include <project_vertex>',`
        vec4 mvPosition=instanceMatrix*vec4(transformed,1.);
        float bladeLength=aBlade.y*length(instanceMatrix[1].xyz)*mix(.22,1.,lensNear);
        vec2 windDir=vec2(.86,.51);
        float gust=smoothstep(.38,.8,texture2D(uWindNoise,bladeRoot.xz*.085-windDir*uWindTime*.024).r);
        float flutter=sin(uWindTime*1.3+dot(bladeRoot.xz,vec2(3.1,2.3)))*.55+sin(uWindTime*2.9+bladeRoot.x*11.+bladeRoot.z*7.)*.2;
        float bend=(.16+gust*.85+flutter*(.12+gust*.2))*vTip*vTip*bladeLength*.6;
        mvPosition.xz+=windDir*bend+vec2(-windDir.y,windDir.x)*flutter*.07*vTip*vTip*bladeLength;
        mvPosition.y-=bend*bend/max(bladeLength,.01)*.55;
        vLotus=exp(-length(bladeRoot.xz-uLotus.xz)*1.35);
        vec3 lotusView=(modelViewMatrix*vec4(uLotus,1.)).xyz;
        mvPosition=modelViewMatrix*mvPosition;
        vToLotus=lotusView-mvPosition.xyz;
        gl_Position=projectionMatrix*mvPosition;`)
    shader.fragmentShader='uniform vec3 uLotusGlow;varying float vTip;varying float vLotus;varying vec3 vToLotus;\n'+shader.fragmentShader
      .replace('#include <color_fragment>',`#include <color_fragment>
        float bladeLight=smoothstep(0.,.8,vTip);
        diffuseColor.rgb*=mix(.26,1.,bladeLight);
        diffuseColor.rgb=mix(diffuseColor.rgb,diffuseColor.rgb*vec3(1.22,1.16,.82),smoothstep(.6,1.,vTip)*.7);`)
      .replace('#include <aomap_fragment>',`
        float throughLeaf=pow(max(0.,dot(normalize(-vViewPosition),normalize(vToLotus))),3.);
        reflectedLight.indirectDiffuse+=diffuseColor.rgb*uLotusGlow*vLotus*(.25+throughLeaf)*smoothstep(.3,1.,vTip)*1.4;
        #include <aomap_fragment>`)
  }
  material.customProgramCacheKey=()=> 'liora-foliage-v2'
  return material
}

const grassTones=['#28462f','#33553a','#3d5a3c','#4b6440','#2f4f45','#5a6340'].map(c=>new THREE.Color(c))
/** A tiny five-petal flower on a stem (7 triangles); it sways with the grass through the foliage material. */
function flowerGeometry():THREE.BufferGeometry {
  const height=.05,positions:number[]=[0,0,-.0012,0,0,.0012,0,height,0],blade:number[]=[0,height,0,height,1,height],indices:number[]=[0,1,2]
  const centre=positions.length/3;positions.push(0,height,0);blade.push(1,height)
  for(let k=0;k<5;k++)for(const side of [-.42,.42]){const a=k/5*Math.PI*2+side;positions.push(Math.cos(a)*.016,height+.004,Math.sin(a)*.016);blade.push(1,height)}
  for(let k=0;k<5;k++)indices.push(centre,centre+1+k*2,centre+2+k*2)
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('aBlade',new THREE.Float32BufferAttribute(blade,2))
  geometry.setIndex(indices);geometry.computeVertexNormals();return geometry
}
/** A small mushroom: lathed cap with pale gills under it and a stem, coloured per vertex. */
function mushroomGeometry():THREE.BufferGeometry {
  const capProfile=[[.003,.026],[.026,.03],[.02,.041],[0,.046]].map(([x,y])=>new THREE.Vector2(x,y))
  const cap=new THREE.LatheGeometry(capProfile,7),stem=new THREE.CylinderGeometry(.0042,.006,.03,6,1,true);stem.translate(0,.015,0)
  const paint=(geometry:THREE.BufferGeometry,colour:(y:number)=>THREE.Color):THREE.BufferGeometry=>{const p=geometry.getAttribute('position'),c:number[]=[];for(let i=0;i<p.count;i++){const v=colour(p.getY(i));c.push(v.r,v.g,v.b)}geometry.deleteAttribute('uv');geometry.setAttribute('color',new THREE.Float32BufferAttribute(c,3));return geometry}
  const gill=new THREE.Color('#bfae8c'),capLow=new THREE.Color('#5c3f2d'),capTop=new THREE.Color('#8a6646'),stemColour=new THREE.Color('#cfc3a4'),tmp=new THREE.Color()
  const merged=mergeGeometries([paint(cap,y=>y<.028?gill:tmp.copy(capLow).lerp(capTop,THREE.MathUtils.smoothstep(y,.03,.046))),paint(stem,y=>tmp.copy(stemColour).multiplyScalar(.55+.45*THREE.MathUtils.smoothstep(y,0,.025)))],false)
  cap.dispose();stem.dispose();return merged
}

const fernTones=['#355f3c','#41693f','#4d7045'].map(c=>new THREE.Color(c))
const petalTones=['#d9d3bf','#cfc8d6','#e3d6b0'].map(c=>new THREE.Color(c))

export function createVegetation(ground:Ground,fernClumps:[number,number][],flowerDrifts:[number,number][],mushroomRings:[number,number][]):Vegetation {
  const windTime={value:0},material=foliageMaterial(windTime),dummy=new THREE.Object3D(),color=new THREE.Color()
  dummy.rotation.order='YXZ'
  const grass=new THREE.InstancedMesh(bladeGeometry(),material,4500);grass.name='4500 living blades';grass.receiveShadow=true
  // Tufts, not a uniform scatter: dense where the moss is lush, sparse or bare on soil, each tuft fanning outwards.
  let placed=0,attempt=0
  while(placed<4500){
    const seed=attempt++,angle=random(seed*7+1)*Math.PI*2,reach=Math.sqrt(random(seed*11+2))*ground.edge(angle)
    const cx=Math.cos(angle)*reach,cz=Math.sin(angle)*reach*SQUASH
    if(ground.blocked(cx,cz))continue
    const lush=ground.lush(cx,cz)
    if(random(seed*13+5)>.3+lush*.7)continue
    // A third are loose singles and pairs between the tufts, so the lawn never reads as a grid of rosettes.
    const loose=random(seed*71+18)<.34,count=loose?1+Math.floor(random(seed*17+3)*2):4+Math.floor(random(seed*17+3)*(4+lush*9)),spread=loose?.06:.014+random(seed*19+4)*.022+lush*.012
    const tall=(.78+lush*.72)*(.8+random(seed*23+6)*.45),tone=grassTones[Math.floor(random(seed*29+7)*grassTones.length)]
    for(let b=0;b<count&&placed<4500;b++){
      const around=random(seed*31+b*7+8)*Math.PI*2,out=Math.sqrt(random(seed*37+b*5+9)),x=cx+Math.cos(around)*out*spread,z=cz+Math.sin(around)*out*spread
      if(ground.blocked(x,z))continue
      const height=tall*(.66+random(seed*41+b*3+10)*.5)*(1.1-out*.25),width=.78+random(seed*43+b*11+12)*.45
      dummy.position.set(x,ground.height(x,z)-.006,z)
      dummy.rotation.set(.04+out*(loose?.12:.26)+random(seed*47+b+13)*.1,Math.atan2(Math.cos(around),Math.sin(around))+(random(seed*53+b+14)-.5)*.9,(random(seed*59+b+15)-.5)*.16)
      dummy.scale.set(width,height,(width+height)*.5);dummy.updateMatrix();grass.setMatrixAt(placed,dummy.matrix)
      color.copy(tone).lerp(grassTones[(seed+b)%grassTones.length],random(seed*61+b+16)*.35).multiplyScalar(.85+random(seed*67+b+17)*.3);grass.setColorAt(placed,color)
      placed++
    }
  }
  grass.computeBoundingSphere()
  // 96 fronds as 12 clumps of 8, each clump a shuttlecock of arching fronds.
  const ferns=new THREE.InstancedMesh(frondGeometry(),material,96);ferns.name='Fern clumps';ferns.receiveShadow=true
  for(let i=0;i<96;i++){
    const clump=Math.floor(i/8),k=i%8,[cx,cz]=fernClumps[clump%fernClumps.length],seed=i*13+clump*101
    const yaw=k/8*Math.PI*2+clump*.7+(random(seed+1)-.5)*.5,size=(.75+random(clump*7+3)*.45)*(.78+random(seed+2)*.35)
    const x=cx+Math.sin(yaw)*.012,z=cz+Math.cos(yaw)*.012
    dummy.position.set(x,ground.height(x,z)-.004,z);dummy.rotation.set(-.18+random(seed+3)*.42,yaw,(random(seed+4)-.5)*.2);dummy.scale.setScalar(size);dummy.updateMatrix();ferns.setMatrixAt(i,dummy.matrix)
    color.copy(fernTones[clump%fernTones.length]).multiplyScalar(.85+random(seed+5)*.3);ferns.setColorAt(i,color)
  }
  ferns.computeBoundingSphere()
  // Drifts of tiny pale flowers between the tufts.
  const flowers=new THREE.InstancedMesh(flowerGeometry(),material,140);flowers.name='Night flower drifts';flowers.receiveShadow=true
  let bloom=0
  for(let i=0;bloom<140&&i<2000;i++){
    const [cx,cz]=flowerDrifts[i%flowerDrifts.length],angle=random(i*7+900)*Math.PI*2,out=Math.pow(random(i*11+901),.7)*.3,x=cx+Math.cos(angle)*out,z=cz+Math.sin(angle)*out*.8
    if(ground.blocked(x,z))continue
    dummy.position.set(x,ground.height(x,z)-.004,z);dummy.rotation.set((random(i+902)-.5)*.5,random(i+903)*6.28,(random(i+904)-.5)*.5);dummy.scale.setScalar(.75+random(i+905)*.6);dummy.updateMatrix();flowers.setMatrixAt(bloom,dummy.matrix)
    color.copy(petalTones[i%petalTones.length]).multiplyScalar(.62+random(i+906)*.2);flowers.setColorAt(bloom,color);bloom++
  }
  flowers.count=bloom;flowers.computeBoundingSphere()
  // Little rings of mushrooms by the willow roots and the stones.
  const mushrooms=new THREE.InstancedMesh(mushroomGeometry(),new THREE.MeshStandardMaterial({color:'#ffffff',vertexColors:true,roughness:.78,metalness:0}),mushroomRings.length*6);mushrooms.name='Mushroom rings';mushrooms.receiveShadow=true
  for(let i=0;i<mushrooms.count;i++){
    const [cx,cz]=mushroomRings[Math.floor(i/6)],angle=i%6/6*Math.PI*2+random(i+950),out=.03+random(i+951)*.07,x=cx+Math.cos(angle)*out,z=cz+Math.sin(angle)*out
    dummy.position.set(x,ground.height(x,z)-.003,z);dummy.rotation.set((random(i+952)-.5)*.3,random(i+953)*6.28,(random(i+954)-.5)*.3);dummy.scale.setScalar(.6+random(i+955)*.9);dummy.updateMatrix();mushrooms.setMatrixAt(i,dummy.matrix)
    mushrooms.setColorAt(i,color.setScalar(.85+random(i+956)*.25))
  }
  mushrooms.computeBoundingSphere()
  return {grass,ferns,flowers,mushrooms,update(time,reduced){windTime.value=reduced?0:time}}
}
