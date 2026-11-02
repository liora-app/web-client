import * as THREE from 'three'
import { mergeGeometries,mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import { batchStatic,contact,mesh,shadowTexture } from './craft'
import { createArtifacts } from './artifacts'
import { fractal,noise3,random } from './noise'
import { applySurface } from './surface'
import { createVegetation } from './vegetation'

const SQUASH=.84
const smooth=THREE.MathUtils.smoothstep,clamp=THREE.MathUtils.clamp
/** Ground footprints: x, z, radius x, radius z. Grass stays out, soil darkens around them, the mounds flatten out before them. */
type Footprint=[number,number,number,number]
const stations:Footprint[]=[[-.25,-.55,.78,.78],[-1.55,.75,.56,.56],[-1.05,1.55,.46,.46],[1.85,-.85,.3,.3],[.8,-1.1,.47,.33]]
const inside=(x:number,z:number,[cx,cz,rx,rz]:Footprint,grow=1):number=>Math.hypot((x-cx)/(rx*grow),(z-cz)/(rz*grow))
/** A few soft hillocks (x, z, radius, height) so the cap rolls like a diorama instead of lying flat. */
const mounds=[[-2.3,-1.25,.85,.13],[1.55,1.5,.75,.09],[3.05,.15,.7,.12],[-2.85,1.15,.6,.08],[.35,-2.35,.8,.1]]
function relief(x:number,z:number):number {
  let height=0;for(const [mx,mz,r,h] of mounds){const d=Math.hypot(x-mx,z-mz)/r;height+=h*Math.exp(-d*d*2.2)}
  for(const station of stations)height*=smooth(inside(x,z,station),1.05,1.7)
  return height
}
export function surfaceHeight(x:number,z:number):number {
  const distance=Math.hypot(x+.25,(z+.55)*1.12)
  return .018+fractal(x*.95,7,z*.95)*.065-.028*Math.exp(-distance*distance*1.8)+relief(x,z)
}
/** Outline of the moss cap (ellipse parameter; world z = sin·r·SQUASH). */
function rimRadius(angle:number):number {return 4.05*(1+Math.sin(angle*7)*.018+noise3(Math.cos(angle)*2,3,Math.sin(angle)*2)*.055)}

/** Bare soil: a few worn patches and a trodden ring round the two stone plinths. */
function bareness(x:number,z:number):number {
  const patches=smooth(fractal(x*.8+3.3,5,z*.8-1.7),.26,.42)*.85
  let worn=0
  for(const [cx,cz,r] of [[-1.55,.75,.52],[-1.05,1.55,.41]]){const d=Math.hypot(x-cx,z-cz)-r;worn=Math.max(worn,Math.exp(-Math.pow((d-.05)/.08,2))*.75)}
  return clamp(Math.max(patches,worn),0,1)
}

interface Boulder {x:number;z:number;size:number;height:number;seed:number;turn:number}
function placeBoulders():Boulder[] {
  const boulders:Boulder[]=[]
  for(let i=0;i<14;i++){
    const angle=i*2.39996+.35,reach=rimRadius(angle)-.12-random(i+50)*.32,x=Math.cos(angle)*reach,z=Math.sin(angle)*reach*SQUASH
    if(stations.some(s=>inside(x,z,s,1.25)<1))continue
    const size=.13+random(i+60)*.17;boulders.push({x,z,size,height:size*(.78+random(i+70)*.42),seed:i*3+4,turn:angle})
    if(i%3===0){const side=angle+(random(i+80)>.5?1:-1)*(size*1.5)/reach;boulders.push({x:Math.cos(side)*(reach+.04),z:Math.sin(side)*(reach+.04)*SQUASH,size:size*.45,height:size*.4,seed:i*3+40,turn:side*2})}
  }
  // Two stones by the willow roots and one behind the companion's cushion, so the interior is not a plain lawn.
  boulders.push({x:2.42,z:-.5,size:.16,height:.11,seed:91,turn:.4},{x:2.55,z:-.32,size:.07,height:.05,seed:92,turn:1.3},{x:1.42,z:-1.62,size:.12,height:.08,seed:93,turn:2.2})
  return boulders
}

/** One seamless polar mesh: moss carpet → rolled moss lip with an overhang → stratified rock face → wet base under the waterline. */
function islandMass(boulders:Boulder[]):{moss:THREE.BufferGeometry;rock:THREE.BufferGeometry} {
  const segments=144,topRings=22,lip=[[.03,-.016],[.055,-.046],[.058,-.084],[.036,-.118]],rockRings=13
  const positions:number[]=[],colors:number[]=[],color=new THREE.Color(),shade=new THREE.Color()
  const mossDeep=new THREE.Color('#1b3123'),mossMid=new THREE.Color('#2a4630'),mossSun=new THREE.Color('#465a33'),soil=new THREE.Color('#2c241a'),soilDark=new THREE.Color('#1d1812')
  const rock=new THREE.Color('#7b786a'),rockBrown=new THREE.Color('#665a48'),rockCool=new THREE.Color('#5c6862'),wet=new THREE.Color('#1c2420')
  const footprints:Footprint[]=[...stations,...boulders.map(b=>[b.x,b.z,b.size*.9,b.size*.9] as Footprint)]
  const groundColor=(x:number,z:number,out:THREE.Color):THREE.Color=>{
    const broad=fractal(x*1.25,2,z*1.25),fine=fractal(x*3.4+7,4,z*3.4)
    out.copy(mossDeep).lerp(mossMid,clamp(.5+broad*1.9,0,1)).lerp(mossSun,smooth(fine,.08,.38)*.7).multiplyScalar(.82+.36*smooth(broad,-.25,.3))
    const bare=bareness(x,z);shade.copy(soil).lerp(soilDark,clamp(.5+fine*2,0,1));out.lerp(shade,bare)
    let ao=1;for(const f of footprints){const d=inside(x,z,f);ao*=1-.42*Math.exp(-Math.max(0,d-.92)*7)}
    return out.multiplyScalar(ao)
  }
  // Top: centre vertex, then rings out to the rim.
  positions.push(0,surfaceHeight(0,0),0);groundColor(0,0,color);colors.push(color.r,color.g,color.b)
  for(let ring=1;ring<=topRings;ring++)for(let i=0;i<segments;i++){
    const angle=i/segments*Math.PI*2,reach=rimRadius(angle)*ring/topRings,x=Math.cos(angle)*reach,z=Math.sin(angle)*reach*SQUASH
    positions.push(x,surfaceHeight(x,z),z);groundColor(x,z,color);colors.push(color.r,color.g,color.b)
  }
  // Lip and rock: offsets from each column's rim point.
  const sideStart=positions.length/3
  for(let ring=0;ring<lip.length+rockRings;ring++)for(let i=0;i<segments;i++){
    const angle=i/segments*Math.PI*2,c=Math.cos(angle),s=Math.sin(angle),rim=rimRadius(angle),top=surfaceHeight(c*rim,s*rim*SQUASH)
    let out:number,y:number
    if(ring<lip.length){
      [out,y]=lip[ring];y+=top;groundColor(c*rim,s*rim*SQUASH,color).multiplyScalar([1.08,.95,.72,.45][ring])
    } else {
      const u=(ring-lip.length)/(rockRings-1)
      y=THREE.MathUtils.lerp(top-.15,-.74,Math.pow(u,.92))
      const band=(y+noise3(c*2.6,1.7,s*2.6)*.05)*8.2,stratum=band-Math.floor(band)
      out=-.035+.13*Math.pow(u,1.6)+.075*noise3(c*1.7+4,y*1.2,s*1.7)+.04*noise3(c*7.5,y*.8+2,s*7.5)+.04*Math.pow(stratum,3)
      if(ring===lip.length)out=-.045+.015*noise3(c*9,1,s*9)
      const tone=noise3(c*3.1+9,y*2.5,s*3.1)
      color.copy(rock).lerp(rockBrown,clamp(.5+tone*1.5,0,1)).lerp(rockCool,smooth(noise3(c*1.3,y*.6+5,s*1.3),.05,.4)*.6)
      color.multiplyScalar((.55+.45*stratum)*(.38+.62*smooth(u,0,.16)))
      color.lerp(wet,smooth(y,-.42,-.64)*.85)
    }
    const r=rim+out;positions.push(c*r,y,s*r*SQUASH);colors.push(color.r,color.g,color.b)
  }
  const mossIndex:number[]=[],rockIndex:number[]=[],ringStart=(ring:number):number=>1+(ring-1)*segments
  for(let i=0;i<segments;i++)mossIndex.push(0,ringStart(1)+(i+1)%segments,ringStart(1)+i)
  const quads=(list:number[],a0:number,b0:number):void=>{for(let i=0;i<segments;i++){const j=(i+1)%segments,a=a0+i,b=a0+j,c=b0+i,d=b0+j;list.push(a,b,c,b,d,c)}}
  for(let ring=1;ring<topRings;ring++)quads(mossIndex,ringStart(ring),ringStart(ring+1))
  quads(mossIndex,ringStart(topRings),sideStart)
  for(let ring=0;ring<lip.length+rockRings-1;ring++)quads(ring<lip.length-1?mossIndex:rockIndex,sideStart+ring*segments,sideStart+(ring+1)*segments)
  const whole=new THREE.BufferGeometry();whole.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));whole.setAttribute('color',new THREE.Float32BufferAttribute(colors,3))
  whole.setIndex([...mossIndex,...rockIndex]);whole.computeVertexNormals()
  const part=(index:number[]):THREE.BufferGeometry=>{const g=new THREE.BufferGeometry();for(const name of ['position','normal','color'])g.setAttribute(name,whole.getAttribute(name));g.setIndex(index);g.computeBoundingSphere();return g}
  return {moss:part(mossIndex),rock:part(rockIndex)}
}

/** Smooth river/glacial stone: welded icosphere, lumpy noise, two soft planar facets, flattened buried base, darker underside. */
function boulderGeometry(seed:number,detail:number):THREE.BufferGeometry {
  const sphere=new THREE.IcosahedronGeometry(1,detail);sphere.deleteAttribute('normal');sphere.deleteAttribute('uv')
  const geometry=mergeVertices(sphere),positions=geometry.getAttribute('position'),colors:number[]=[],v=new THREE.Vector3(),color=new THREE.Color()
  const cuts=[0,1].map(k=>({normal:new THREE.Vector3(random(seed*5+k)-.5,.2+random(seed*7+k)*.8,random(seed*11+k)-.5).normalize(),depth:.62+random(seed*13+k)*.18}))
  const stone=new THREE.Color('#5c5b51'),warm=new THREE.Color('#4b4337')
  for(let i=0;i<positions.count;i++){
    v.fromBufferAttribute(positions,i)
    v.multiplyScalar(1+fractal(v.x*1.2+seed,v.y*1.2,v.z*1.2)*.3+noise3(v.x*3.3,v.y*3.3+seed,v.z*3.3)*.05)
    for(const cut of cuts){const d=v.dot(cut.normal)-cut.depth;if(d>0)v.addScaledVector(cut.normal,-d*.8)}
    if(v.y<-.3)v.y=-.3+(v.y+.3)*.35
    positions.setXYZ(i,v.x,v.y,v.z)
    color.copy(stone).lerp(warm,clamp(.5+noise3(v.x*2+seed,v.y*2,v.z*2)*1.4,0,1)).multiplyScalar(.42+.58*smooth(v.y,-.35,.35))
    colors.push(color.r,color.g,color.b)
  }
  geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));geometry.computeVertexNormals();return geometry
}

/** Felted moss hummock the companion sits on: lumpy, flat-bottomed, dark where it meets the ground. */
function cushionGeometry():THREE.BufferGeometry {
  const sphere=new THREE.SphereGeometry(1,40,22);sphere.deleteAttribute('normal');sphere.deleteAttribute('uv')
  const geometry=mergeVertices(sphere),positions=geometry.getAttribute('position'),colors:number[]=[],v=new THREE.Vector3(),color=new THREE.Color()
  const low=new THREE.Color('#22371f'),high=new THREE.Color('#38512e'),sun=new THREE.Color('#53683a')
  for(let i=0;i<positions.count;i++){
    v.fromBufferAttribute(positions,i)
    const lump=fractal(v.x*1.7,v.y*1.7+3,v.z*1.7)*.16+noise3(v.x*5.5,v.y*5.5,v.z*5.5)*.045
    v.multiplyScalar(1+lump);if(v.y<-.25)v.y=-.25+(v.y+.25)*.4
    positions.setXYZ(i,v.x,v.y,v.z)
    color.copy(low).lerp(high,smooth(v.y,-.3,.5)).lerp(sun,smooth(lump,.02,.09)*smooth(v.y,0,.8)*.6).multiplyScalar(.5+.5*smooth(v.y,-.28,.15))
    colors.push(color.r,color.g,color.b)
  }
  geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));geometry.computeVertexNormals();return geometry
}

let tipMask:THREE.DataTexture|undefined
/** Emissive mask along a lathe's v: dark body, light gathering only in the last fifth of each crystal. */
function crystalTipMask():THREE.DataTexture {
  if(tipMask)return tipMask
  const size=32,data=new Uint8Array(size*4)
  for(let i=0;i<size;i++){const value=Math.round(Math.pow(smooth(i/(size-1),.7,1),1.6)*255);data.set([value,value,value,255],i*4)}
  tipMask=new THREE.DataTexture(data,1,size,THREE.RGBAFormat);tipMask.magFilter=THREE.LinearFilter;tipMask.minFilter=THREE.LinearFilter;tipMask.colorSpace=THREE.NoColorSpace;tipMask.needsUpdate=true
  return tipMask
}
/** A small cluster of faceted hexagonal crystals leaning out of the moss (flat facets on purpose: they are cut stone). */
function crystalCluster(seed:number):THREE.BufferGeometry {
  const parts:THREE.BufferGeometry[]=[],matrix=new THREE.Matrix4(),rotation=new THREE.Euler(),quaternion=new THREE.Quaternion(),scale=new THREE.Vector3(1,1,1),offset=new THREE.Vector3()
  for(let k=0;k<5;k++){
    const height=(k===0?.17:.06+random(seed*7+k)*.08),radius=height*(.16+random(seed*11+k)*.05),around=k/5*Math.PI*2+random(seed+k)
    const profile=[new THREE.Vector2(0,-.03),new THREE.Vector2(radius*.92,-.03),new THREE.Vector2(radius,height*.66),new THREE.Vector2(radius*.45,height*.88),new THREE.Vector2(0,height)]
    const prism=new THREE.LatheGeometry(profile,6)
    rotation.set(Math.sin(around)*(k===0?.12:.5),random(seed*3+k)*Math.PI,Math.cos(around)*(k===0?.1:.5));quaternion.setFromEuler(rotation)
    offset.set(Math.cos(around)*(k===0?0:.035),0,Math.sin(around)*(k===0?0:.035));matrix.compose(offset,quaternion,scale);prism.applyMatrix4(matrix)
    parts.push(prism.toNonIndexed())
  }
  const geometry=mergeGeometries(parts,false);parts.forEach(p=>p.dispose());geometry.computeVertexNormals();return geometry
}

export function createIsland() {
  const group=new THREE.Group();group.name='Moss-capped rock sanctuary'
  const artifacts=createArtifacts();group.add(artifacts.stations,artifacts.canopy);for(const lantern of artifacts.lanterns)group.add(lantern.light)
  const boulders=placeBoulders()
  // Moss carpet: colour lives in the vertices (soil patches, contact darkening); the shader adds felted micro relief.
  const mossMat=applySurface(new THREE.MeshStandardMaterial({color:'#ffffff',roughness:.96,vertexColors:true}),{scale:2.6,bump:.013,fine:.62,variation:.38,tint:'#e2d58c',cavity:.34,roughnessVariation:.05})
  const rockMat=applySurface(new THREE.MeshStandardMaterial({color:'#ffffff',roughness:.86,vertexColors:true}),{scale:1.7,bump:.05,fine:.5,variation:.24,tint:'#bcae92',cavity:.55,roughnessVariation:.14,moss:{color:'#33533a',amount:.9,low:.5,high:.85}})
  const mass=islandMass(boulders)
  const carpet=mesh(mass.moss,mossMat,group);carpet.name='Moss carpet and rolled lip';carpet.castShadow=false
  const cliff=mesh(mass.rock,rockMat,group);cliff.name='Stratified rock mass';cliff.castShadow=false
  const boulderMat=applySurface(new THREE.MeshStandardMaterial({color:'#ffffff',roughness:.84,vertexColors:true}),{scale:2.8,bump:.026,fine:.45,variation:.2,tint:'#c6b99d',cavity:.45,roughnessVariation:.12,moss:{color:'#2c472d',amount:.85,low:.42,high:.82}})
  for(const b of boulders){
    const stone=mesh(boulderGeometry(b.seed,b.size>.26?4:b.size>.17?3:2),boulderMat,group,b.x,surfaceHeight(b.x,b.z)-b.height*.22,b.z)
    stone.name='Moss boulder';stone.scale.set(b.size,b.height,b.size*(.75+random(b.seed+5)*.4));stone.rotation.y=b.turn
  }
  // Pebbles share the rock material (and its shadow flags), so batching folds them into the cliff draw call.
  for(let i=0;i<70;i++){
    const anchor=boulders[i%boulders.length],angle=random(i*7+300)*Math.PI*2,distance=anchor.size*(1+random(i*5+301)*1.4)
    const x=anchor.x+Math.cos(angle)*distance,z=anchor.z+Math.sin(angle)*distance*.9
    if(stations.some(s=>inside(x,z,s)<1.02)||Math.hypot(x,z/SQUASH)>rimRadius(Math.atan2(z/SQUASH,x))-.06)continue
    const size=.012+random(i*3+302)*.022,pebble=mesh(boulderGeometry(i+500,0),rockMat,group,x,surfaceHeight(x,z)-size*.2,z)
    pebble.name='Pebble';pebble.scale.set(size,size*.6,size*.85);pebble.rotation.y=random(i+303)*6.28;pebble.castShadow=false
  }
  const cushionMat=applySurface(new THREE.MeshStandardMaterial({color:'#ffffff',roughness:1,vertexColors:true}),{scale:7,bump:.011,fine:.75,variation:.26,tint:'#dcd59c',cavity:.38,roughnessVariation:.04,moss:{color:'#55743f',amount:.35,low:.3,high:.95}})
  const cushion=mesh(cushionGeometry(),cushionMat,group,.8,.205,-1.1);cushion.name='Companion moss cushion';cushion.scale.set(.49,.22,.34)
  // Only the cushion gets a contact disc; the lotus is a light source, its clearing is grounded by the vertex occlusion instead.
  contact(group,shadowTexture(),.8,-1.1,1.3,.95)
  // Matte crystals: only the tips carry light, and gently.
  const crystalMat=new THREE.MeshStandardMaterial({color:'#7c958a',roughness:.38,metalness:0,emissive:'#d9e8bb',emissiveIntensity:.85,emissiveMap:crystalTipMask()})
  const crystalSpots:[number,number][]=[]
  for(let i=0;i<3;i++){
    const angle=-.8+i*2.2,x=Math.cos(angle)*3.2,z=Math.sin(angle)*3.2*SQUASH;crystalSpots.push([x,z])
    const cluster=mesh(crystalCluster(i*17+3),crystalMat,group,x,surfaceHeight(x,z)-.01,z);cluster.name='Quiet crystal cluster';cluster.castShadow=false;cluster.rotation.y=angle;cluster.scale.setScalar(1.15)
  }
  const fernClumps:[number,number][]=[[2.4,-.12],[1.25,-1.62],[.15,-1.72],[2.75,-1.25],[-2.45,1.35],[-3.15,.3],[-2.2,-1.75],[.9,2.55],[2.9,1.1],[-.95,2.35],[1.75,.55],[-1.9,-.6]]
  const keepouts:Footprint[]=[...stations,...boulders.map(b=>[b.x,b.z,b.size*.8,b.size*.75] as Footprint),...crystalSpots.map(([x,z])=>[x,z,.09,.09] as Footprint),...fernClumps.map(([x,z])=>[x,z,.07,.07] as Footprint)]
  const vegetation=createVegetation({
    height:surfaceHeight,
    edge:angle=>rimRadius(angle)-.07,
    blocked:(x,z)=>keepouts.some(f=>inside(x,z,f)<1),
    lush:(x,z)=>{
      const rim=smooth(Math.hypot(x,z/SQUASH)/rimRadius(Math.atan2(z/SQUASH,x)),.72,.97)
      let near=0;for(const b of boulders)near=Math.max(near,Math.exp(-Math.max(0,Math.hypot(x-b.x,z-b.z)-b.size)*5))
      return clamp((.42+fractal(x*.7+17,1,z*.7)*1.2+rim*.35+near*.3+relief(x,z)*3)*(1-bareness(x,z)*.92),0,1)
    },
  },fernClumps,[[1.25,-.8],[.4,-1.6],[-1.25,-1.3],[.65,.7],[2.25,.4],[-2.55,.5],[-.35,1.05],[1.05,1.65]],[[2.32,-1.08],[1.4,-.5],[2.62,-.55],[-2.05,-1.55]])
  group.add(vegetation.grass,vegetation.ferns,vegetation.flowers,vegetation.mushrooms)
  batchStatic(group,[artifacts.stations,artifacts.canopy,vegetation.grass,vegetation.ferns,...artifacts.lanterns.map(l=>l.light)])
  return {group,...artifacts,grass:vegetation.grass,terraces:3,update(time:number,reduced:boolean){vegetation.update(time,reduced);artifacts.update(time,reduced)}}
}
