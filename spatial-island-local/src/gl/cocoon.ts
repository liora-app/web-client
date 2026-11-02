import * as THREE from 'three'
import type { Kit } from './artifacts'
import { fractal,noise3,random } from './noise'

/**
 * Kintsugi privacy cocoon: a dark tenmoku-glazed egg broken into six shards along irregular break lines. Each shard
 * has real wall thickness; the break faces and a hairline on the outer glaze are gold leaf (metal). The shards part
 * to show the warm memory core and close over it in the privacy chapter.
 */
export interface Cocoon {
  group:THREE.Group;core:THREE.Mesh
  /** Articulated parts that the static batcher must leave alone. */
  moving:THREE.Object3D[]
  update:(time:number,closure:number,reduced:boolean)=>void
}

const SHARDS=6,ROWS=24,COLUMNS=8,RADIUS=.316,HALF=.34,INNER=.955,HAIRLINE=.0026,CENTER_Y=.59
/** The glaze map is centred on .5 so it can both darken and lift the vertex colour. */
const MAP_BASE=.5

/** Egg surface: θ = 0 at the foot, π at the crown; fuller below the waist, narrower at the crown. */
function egg(theta:number,phi:number,scale:number,out:THREE.Vector3):THREE.Vector3 {
  const r=RADIUS*Math.sin(theta)*(1+.09*Math.cos(theta))*scale
  return out.set(-Math.cos(phi)*r,-Math.cos(theta)*HALF*scale,Math.sin(phi)*r)
}
const ringRadius=(theta:number):number=>RADIUS*Math.sin(theta)*(1+.09*Math.cos(theta))
/** Break line k at height θ. Neighbouring shards share it, so they close without a gap. */
function seam(k:number,theta:number):number {
  const id=k%SHARDS,wrap=Math.floor(k/SHARDS)*Math.PI*2
  return wrap+id*Math.PI/3+Math.sin(theta)*(noise3(theta*1.9,id*3.7+.31,.53)*.24+noise3(theta*7.3,id*1.9+.17,2.3)*.06)
}

const glazeDeep=new THREE.Color(.012,.031,.028),glazeBlue=new THREE.Color(.01,.025,.034),kaki=new THREE.Color(.13,.052,.02),glazePool=new THREE.Color(.007,.022,.026),clay=new THREE.Color(.2,.11,.055)
/** Broad glaze tone baked into vertex colours (object space, so it travels with the shard): a slow teal/blue-black
 * drift, the glaze breaking to persimmon brown where it runs thin at the crown, pooling darker at the foot.
 * The fine hare's-fur streaks and the crazing live in the glaze map. */
function glaze(p:THREE.Vector3,theta:number,out:THREE.Color):THREE.Color {
  const n=fractal(p.x*4+11,p.y*4,p.z*4),crown=THREE.MathUtils.smoothstep(theta/Math.PI+n*.12,.56,.92)
  out.copy(glazeDeep).lerp(glazeBlue,THREE.MathUtils.clamp(.5+n*1.2,0,1)).lerp(kaki,crown*.85).lerp(glazePool,(1-THREE.MathUtils.smoothstep(theta,.25,1.1))*.6)
  return out.multiplyScalar((1+n*.2)/MAP_BASE)
}

let glazeCache:{color:THREE.DataTexture;rough:THREE.DataTexture}|undefined
/** Tileable glaze map (u runs round the egg, v down it). Colour: fine hare's-fur streaks running down the glaze and a
 * two-scale crazing of lighter hairlines. Roughness (G): the crazing breaks the clear coat. */
function glazeMaps():{color:THREE.DataTexture;rough:THREE.DataTexture} {
  if(glazeCache)return glazeCache
  const size=256,color=new Uint8Array(size*size*4),rough=new Uint8Array(size*size*4),tau=Math.PI*2
  const sites=(cells:number,seed:number):Float32Array=>{const points=new Float32Array(cells*cells*2);for(let i=0;i<points.length;i++)points[i]=random(seed+i);return points}
  const coarse=sites(16,1101),fine=sites(34,2707)
  const edge=(points:Float32Array,cells:number,u:number,v:number):number=>{
    const gx=u*cells,gy=v*cells,ix=Math.floor(gx),iy=Math.floor(gy);let f1=9,f2=9
    for(let oy=-1;oy<=1;oy++)for(let ox=-1;ox<=1;ox++){
      const cx=ix+ox,cy=iy+oy,k=((((cy%cells)+cells)%cells)*cells+(((cx%cells)+cells)%cells))*2,dx=cx+points[k]-gx,dy=cy+points[k+1]-gy,d=Math.sqrt(dx*dx+dy*dy)
      if(d<f1){f2=f1;f1=d}else if(d<f2)f2=d
    }
    return (f2-f1)*.5/cells*size
  }
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const u=(x+.5)/size,v=(y+.5)/size,i=(y*size+x)*4
    const warp=Math.sin(tau*(v+u*2))*.35+Math.sin(tau*v*2+1.7)*.2
    const fur=Math.pow(Math.max(0,Math.sin(tau*(u*29+warp))*.55+Math.sin(tau*(u*47-warp*.6+v))*.45),3)*(.55+.45*Math.sin(tau*(u*5+v*3)))
    const line=Math.max(1-THREE.MathUtils.smoothstep(edge(coarse,16,u,v),.12,.95),(1-THREE.MathUtils.smoothstep(edge(fine,34,u,v),.08,.6))*.45),lift=1+line*.32
    color[i]=Math.round(Math.min(1,MAP_BASE*(1+fur*1.4)*lift)*255);color[i+1]=Math.round(Math.min(1,MAP_BASE*(1+fur*.6)*lift)*255);color[i+2]=Math.round(Math.min(1,MAP_BASE*(1-fur*.2)*lift)*255);color[i+3]=255
    rough[i]=rough[i+2]=0;rough[i+1]=Math.round((.24+.5*line+.15*fur)*255);rough[i+3]=255
  }
  const texture=(data:Uint8Array):THREE.DataTexture=>{const t=new THREE.DataTexture(data,size,size,THREE.RGBAFormat);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.magFilter=THREE.LinearFilter;t.minFilter=THREE.LinearMipmapLinearFilter;t.generateMipmaps=true;t.anisotropy=8;t.colorSpace=THREE.NoColorSpace;t.needsUpdate=true;return t}
  glazeCache={color:texture(color),rough:texture(rough)}
  return glazeCache
}

/** One shard: outer glaze with a gold hairline along both breaks, inner wall, gold break faces, gold veins. */
function shardGeometry(k:number):THREE.BufferGeometry {
  const positions:number[]=[],colors:number[]=[],uvs:number[]=[],inner:number[]=[],ceramic:number[]=[],gold:number[]=[]
  const p=new THREE.Vector3(),color=new THREE.Color(),white=new THREE.Color(1,1,1)
  const vertex=(v:THREE.Vector3,c:THREE.Color,u:number,w:number,isInner:number):number=>{positions.push(v.x,v.y,v.z);colors.push(c.r,c.g,c.b);uvs.push(u,w);inner.push(isInner);return positions.length/3-1}
  const diagonal=new THREE.Vector3(),other=new THREE.Vector3()
  /** Quad i0-i1-i2-i3, wound so its normal (cross of the diagonals, safe at the poles) agrees with `facing`. */
  const quad=(list:number[],i0:number,i1:number,i2:number,i3:number,facing:THREE.Vector3):void=>{
    diagonal.fromArray(positions,i2*3).sub(other.fromArray(positions,i0*3));other.fromArray(positions,i3*3).sub(p.fromArray(positions,i1*3))
    if(diagonal.cross(other).dot(facing)>=0)list.push(i0,i1,i2,i0,i2,i3);else list.push(i0,i2,i1,i0,i3,i2)
  }
  const thetas:number[]=[];for(let i=0;i<=ROWS;i++)thetas.push(.02+(Math.PI-.04)*i/ROWS)
  const outerGrid:number[][]=[],innerGrid:number[][]=[],phis:number[][]=[]
  for(const theta of thetas){
    const start=seam(k,theta),span=seam(k+1,theta)-start,band=Math.min(.28,HAIRLINE/Math.max(1e-4,ringRadius(theta)*span))
    const fractions=[0,band];for(let m=1;m<COLUMNS;m++)fractions.push(band+(1-band*2)*m/COLUMNS);fractions.push(1-band,1)
    const outerRow:number[]=[],innerRow:number[]=[],phiRow:number[]=[]
    for(const f of fractions){
      const phi=start+span*f,u=phi*ringRadius(theta)/RADIUS*1.3,w=theta/Math.PI*4.25;phiRow.push(phi)
      egg(theta,phi,1,p);outerRow.push(vertex(p,glaze(p,theta,color),u,w,0))
      egg(theta,phi,INNER,p);const n=fractal(p.x*7,p.y*7+3,p.z*7);innerRow.push(vertex(p,color.copy(clay).multiplyScalar((1+n*.3)/MAP_BASE),u,w,1))
    }
    outerGrid.push(outerRow);innerGrid.push(innerRow);phis.push(phiRow)
  }
  const facing=new THREE.Vector3(),centroid=new THREE.Vector3(),last=COLUMNS+2
  for(let i=0;i<ROWS;i++)for(let j=0;j<last;j++){
    const o=outerGrid,n=innerGrid
    centroid.fromArray(positions,o[i][j]*3).add(p.fromArray(positions,o[i+1][j+1]*3)).multiplyScalar(.5)
    quad(j===0||j===last-1?gold:ceramic,o[i][j],o[i+1][j],o[i+1][j+1],o[i][j+1],facing.copy(centroid))
    quad(ceramic,n[i][j],n[i+1][j],n[i+1][j+1],n[i][j+1],facing.copy(centroid).negate())
  }
  // Break faces: their own vertices (a crisp edge against the glaze), shared along the break so the gold reads smooth.
  for(const [column,sign] of [[0,-1],[last,1]] as const){
    const lip=outerGrid.map((row,r)=>[vertex(p.fromArray(positions,row[column]*3),white,0,0,0),vertex(p.fromArray(positions,innerGrid[r][column]*3),white,0,0,0)])
    for(let i=0;i<ROWS;i++){
      const phi=(phis[i][column]+phis[i+1][column])*.5;facing.set(Math.sin(phi),0,Math.cos(phi)).multiplyScalar(sign)
      quad(gold,lip[i][0],lip[i+1][0],lip[i+1][1],lip[i][1],facing)
    }
  }
  // Pole caps close the wall at the foot and the crown.
  for(const [r,sign] of [[0,-1],[ROWS,1]] as const)for(let j=0;j<last;j++)quad(gold,outerGrid[r][j],outerGrid[r][j+1],innerGrid[r][j+1],innerGrid[r][j],facing.set(0,sign,0))
  // A branching gold vein on two shards, lying on the glaze like repaired hairline cracks.
  if(k===1||k===4){
    const start=k===1?1.25:1.85,steps=16,path:THREE.Vector3[]=[]
    for(let s=0;s<=steps;s++){const t=s/steps,theta=start+Math.sin(t*2.6+k)*.22+(random(k*40+s)-.5)*.04,from=seam(k,theta),span=seam(k+1,theta)-from;path.push(egg(theta,from+span*(t*.58+(random(k*70+s)-.5)*.015),1.0025,new THREE.Vector3()))}
    const tangent=new THREE.Vector3(),side=new THREE.Vector3(),up=new THREE.Vector3(),pairs:number[][]=[]
    path.forEach((point,s)=>{
      tangent.subVectors(path[Math.min(steps,s+1)],path[Math.max(0,s-1)]).normalize();up.copy(point).normalize();side.crossVectors(up,tangent).normalize()
      const width=.0042*(1-Math.pow(s/steps,1.4))+.0004
      pairs.push([vertex(p.copy(point).addScaledVector(side,width*.5),white,0,0,0),vertex(p.copy(point).addScaledVector(side,-width*.5),white,0,0,0)])
    })
    for(let s=0;s<steps;s++)quad(gold,pairs[s][0],pairs[s+1][0],pairs[s+1][1],pairs[s][1],facing.copy(path[s]))
  }
  const geometry=new THREE.BufferGeometry()
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3))
  geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));geometry.setAttribute('aInner',new THREE.Float32BufferAttribute(inner,1))
  geometry.setIndex([...ceramic,...gold]);geometry.addGroup(0,ceramic.length,0);geometry.addGroup(ceramic.length,gold.length,1)
  geometry.computeVertexNormals();return geometry
}

export function createCocoon(kit:Kit):Cocoon {
  const group=new THREE.Group();group.name='Kintsugi privacy cocoon';group.position.set(-1.05,0,1.55)
  // Carved cradle: foot, inlaid waist, scalloped rim with one lobe under each shard, a shallow bowl for the egg.
  const wobble=(angle:number,y:number):number=>1+fractal(Math.sin(angle)*1.4+7,y*2.6,Math.cos(angle)*1.4)*.035
  const cradle=[[0,-.06],[.37,-.06],[.4,-.025],[.414,.025],[.418,.068],[.404,.093],[.374,.104],[.336,.11],[.312,.124],[.302,.148],[.298,.163],[.287,.166],[.287,.184],[.298,.187],[.302,.205],[.306,.226],[.297,.246],[.276,.258],[.25,.261],[.233,.255],[.19,.239],[.12,.229],[0,.225]]
  const pedestal=new THREE.Mesh(kit.lathe(cradle,64,(angle,y,r)=>r*wobble(angle,y)+(y>.2&&r>.2?.006*Math.cos(angle*6):0)),kit.stone);pedestal.castShadow=pedestal.receiveShadow=true;pedestal.name='Carved cocoon cradle';group.add(pedestal)
  const band=new THREE.Mesh(kit.ring(.2925,.175,.0055,wobble),kit.inlay);band.castShadow=false;band.receiveShadow=true;band.name='Brass cradle inlay';group.add(band)

  const textures=glazeMaps(),coreGlow={value:0}
  const glazeMat=new THREE.MeshPhysicalMaterial({color:'#ffffff',vertexColors:true,map:textures.color,roughness:.46,metalness:0,clearcoat:1,clearcoatRoughness:.42,clearcoatRoughnessMap:textures.rough,specularIntensity:.6})
  glazeMat.onBeforeCompile=shader=>{
    shader.uniforms.uCoreGlow=coreGlow
    shader.vertexShader='attribute float aInner;varying float vInner;varying float vShellY;\n'+shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvInner=aInner;vShellY=position.y;')
    // The inner wall is plain fired clay (no glaze map). When the shell is open it is lit by the core it holds:
    // that is the core's light falling on it, kept well under the bloom threshold.
    shader.fragmentShader='uniform float uCoreGlow;varying float vInner;varying float vShellY;\n'+shader.fragmentShader
      .replace('#include <map_fragment>',`#include <map_fragment>\ndiffuseColor.rgb=mix(diffuseColor.rgb,vec3(${MAP_BASE.toFixed(2)}),vInner);`)
      .replace('#include <emissivemap_fragment>','#include <emissivemap_fragment>\ntotalEmissiveRadiance+=diffuseColor.rgb*vec3(1.,.6,.3)*vInner*uCoreGlow*exp(-abs(vShellY)*4.5)*.6;')
  }
  glazeMat.customProgramCacheKey=()=>'kintsugi-glaze-v3';kit.reflect(glazeMat,1.6)
  const goldMat=kit.reflect(new THREE.MeshStandardMaterial({color:'#d2a04e',metalness:1,roughness:.3,emissive:'#ff9a3c',emissiveIntensity:0}),1.8)
  const pivots:THREE.Group[]=[]
  for(let k=0;k<SHARDS;k++){
    const pivot=new THREE.Group();pivot.position.y=CENTER_Y;group.add(pivot);pivots.push(pivot)
    const shard=new THREE.Mesh(shardGeometry(k),[glazeMat,goldMat]);shard.castShadow=shard.receiveShadow=true;shard.name=`Kintsugi ceramic segment ${k+1}`;pivot.add(shard)
  }
  const coreMat=new THREE.ShaderMaterial({uniforms:{uFade:{value:1},uPulse:{value:0}},
    vertexShader:'varying vec3 vCoreNormal,vCoreView,vCoreObject;void main(){vCoreObject=position;vec4 mv=modelViewMatrix*vec4(position,1.);vCoreNormal=normalize(normalMatrix*normal);vCoreView=-mv.xyz;gl_Position=projectionMatrix*mv;}',
    fragmentShader:'uniform float uFade,uPulse;varying vec3 vCoreNormal,vCoreView,vCoreObject;void main(){float facing=abs(dot(normalize(vCoreNormal),normalize(vCoreView)));float heart=pow(facing,2.4);float swirl=.9+.1*sin(vCoreObject.y*48.+sin(vCoreObject.x*31.+vCoreObject.z*17.)*2.2);vec3 color=mix(vec3(.5,.18,.05),vec3(1.15,.72,.32),heart)*swirl*(.88+.12*uPulse);gl_FragColor=vec4(color,uFade);}'})
  const core=new THREE.Mesh(new THREE.IcosahedronGeometry(.1,3),coreMat);core.position.y=CENTER_Y;core.castShadow=false;core.name='Protected memory core';group.add(core)
  const opening=(open:number,k:number):number=>{const raw=THREE.MathUtils.clamp(open*1.3-k*.06,0,1);return raw*raw*(3-2*raw)}
  return {group,core,moving:[...pivots,core],update(time,closure,reduced){
    const open=1-closure
    pivots.forEach((pivot,k)=>{const a=(k+.5)*Math.PI/3,o=opening(open,k);pivot.position.set(-Math.cos(a)*o*.17,CENTER_Y+o*.055,Math.sin(a)*o*.17);pivot.rotation.set(Math.sin(a)*o*.16,0,Math.cos(a)*o*.16)})
    // The gold only warms a little as the shell seals; the core's light inside fades with the gap.
    goldMat.emissiveIntensity=closure*.045
    const pulse=reduced?.5:.5+.5*Math.sin(time*1.15);coreMat.uniforms.uPulse.value=pulse;coreGlow.value=open*(.85+.15*pulse)
    core.rotation.set(reduced?0:Math.sin(time*.17+1)*.22,reduced?0:Math.sin(time*.23)*.6,0);core.position.y=CENTER_Y+(reduced?0:Math.sin(time*.8)*.018);core.visible=closure<.98
  }}
}
