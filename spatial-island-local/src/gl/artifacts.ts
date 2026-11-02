import * as THREE from 'three'
import { batchStatic,grainTexture,material,mesh,tube } from './craft'
import { fractal,random } from './noise'
import { lightRay } from './optics'
import { applySurface } from './surface'

export interface Lantern {
  root:THREE.Group;body:THREE.Mesh;cord:THREE.Mesh;anchor:THREE.Vector3
  light:THREE.PointLight;material:THREE.MeshStandardMaterial;restY:number
}
export interface Artifacts {
  stations:THREE.Group;canopy:THREE.Group;lanterns:Lantern[]
  paperState:{orbit:number};privacyState:{closure:number}
  paperCenter:THREE.Vector3;privacyCore:THREE.Mesh
  update:(time:number,reduced:boolean)=>void
}

function stoneGeometry(radius:number,height:number,seed:number):THREE.BufferGeometry {
  const geometry=new THREE.CylinderGeometry(radius*.92,radius,height,64,6),positions=geometry.getAttribute('position'),point=new THREE.Vector3()
  for(let i=0;i<positions.count;i++){
    point.fromBufferAttribute(positions,i)
    const n=fractal(point.x*4+seed,point.y*3,point.z*4),edge=1+n*.11
    point.x*=edge;point.z*=edge;point.y+=n*.018;positions.setXYZ(i,point.x,point.y,point.z)
  }
  geometry.computeVertexNormals();return geometry
}
function ring(parent:THREE.Object3D,radius:number,y:number,mat:THREE.Material,thickness=.003):void {
  const object=mesh(new THREE.TorusGeometry(radius,thickness,5,80),mat,parent,0,y,0);object.rotation.x=Math.PI/2;object.castShadow=false
}
function paperGeometry():THREE.PlaneGeometry {
  const geometry=new THREE.PlaneGeometry(.44,.56,10,14),positions=geometry.getAttribute('position')
  for(let i=0;i<positions.count;i++)positions.setZ(i,.05*Math.sin(positions.getY(i)*7)+.022*Math.cos(positions.getX(i)*8))
  geometry.computeVertexNormals();return geometry
}

export function createArtifacts():Artifacts {
  const stations=new THREE.Group();stations.name='Luminous sanctuary artifacts'
  const canopy=new THREE.Group();canopy.name='Weeping light willow'
  const stone=applySurface(material('#26372c',.95),{scale:2.4,bump:.012,tint:'#d8c9a8',moss:{color:'#4a6a45',amount:.55,low:.55,high:.95}})
  const gold=new THREE.MeshBasicMaterial({color:new THREE.Color('#FFB84D').multiplyScalar(.8),toneMapped:false})
  const dullGold=material('#a8955e',.5);dullGold.metalness=.55
  const paperState={orbit:0},privacyState={closure:0},paperCenter=new THREE.Vector3(-1.55,.8,.75)
  const altar=new THREE.Group();altar.name='Origami altar';altar.position.set(-1.55,0,.75);stations.add(altar)
  mesh(stoneGeometry(.52,.12,1),stone,altar,0,.07,0)
  mesh(stoneGeometry(.43,.17,2),stone,altar,0,.21,0)
  mesh(stoneGeometry(.47,.045,3),stone,altar,0,.315,0)
  for(const [radius,y] of [[.515,.075],[.435,.17],[.425,.255],[.46,.332]])ring(altar,radius,y,gold,.0025)
  const altarRay=lightRay(.23,1.18,'#FFD285',.065);altarRay.position.y=.34;altar.add(altarRay)
  const papers:THREE.Group[]=[],paperMat=new THREE.MeshStandardMaterial({color:'#eee5cc',side:THREE.DoubleSide,roughness:.87,bumpMap:grainTexture('paper'),bumpScale:.007,emissive:'#FFB84D',emissiveIntensity:.025})
  const paperTime={value:0}
  paperMat.onBeforeCompile=shader=>{shader.uniforms.uPaperTime=paperTime;shader.vertexShader='uniform float uPaperTime;\n'+shader.vertexShader;shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\ntransformed.z+=sin(position.y*8.+uPaperTime*.9)*.018;')}
  paperMat.customProgramCacheKey=()=> 'floating-paper-v1'
  const paperGeo=paperGeometry(),edgeMat=new THREE.LineBasicMaterial({color:new THREE.Color('#FFC96D').multiplyScalar(1.0),transparent:true,opacity:.65,toneMapped:false})
  const ink=new THREE.LineBasicMaterial({color:'#78866b',transparent:true,opacity:.75})
  for(const lineMaterial of [edgeMat,ink]){lineMaterial.onBeforeCompile=shader=>{shader.uniforms.uPaperTime=paperTime;shader.vertexShader='uniform float uPaperTime;\n'+shader.vertexShader;shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\ntransformed.z+=sin(position.y*8.+uPaperTime*.9)*.018;')};lineMaterial.customProgramCacheKey=()=> 'floating-paper-ink-v1'}
  for(let i=0;i<3;i++){
    const sheet=new THREE.Group();sheet.name=`Floating calligraphy folio ${i+1}`;altar.add(sheet);papers.push(sheet)
    mesh(paperGeo,paperMat,sheet)
    const borderPoints=[[-.22,-.28],[-.22,.28],[.22,.28],[.22,-.28],[-.22,-.28]].map(([x,y])=>new THREE.Vector3(x,y,.05*Math.sin(y*7)+.022*Math.cos(x*8)+.003))
    sheet.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(borderPoints),edgeMat))
    for(let j=0;j<7;j++){
      const points:THREE.Vector3[]=[]
      for(let k=0;k<=22;k++){const x=-.16+k/22*(.24+random(i*19+j)*.08),y=.19-j*.057+Math.sin(k*.8+j)*.005;points.push(new THREE.Vector3(x,y,.05*Math.sin(y*7)+.022*Math.cos(x*8)+.004))}
      sheet.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),ink))
    }
  }

  const cocoon=new THREE.Group();cocoon.name='Kintsugi privacy cocoon';cocoon.position.set(-1.05,0,1.55);stations.add(cocoon)
  mesh(stoneGeometry(.41,.12,5),stone,cocoon,0,.07,0);mesh(stoneGeometry(.34,.1,6),stone,cocoon,0,.18,0)
  ring(cocoon,.345,.226,gold);ring(cocoon,.40,.105,dullGold,.005)
  const shellMat=material('#18241E',.88,grainTexture('clay'),.015),seamMat=gold.clone(),shells:{pivot:THREE.Group;angle:number}[]=[]
  const shellRadius=.345
  for(let i=0;i<6;i++){
    const angle=i/6*Math.PI*2,pivot=new THREE.Group();pivot.position.y=.59;cocoon.add(pivot)
    const shell=mesh(new THREE.SphereGeometry(shellRadius,20,24,angle+.012,Math.PI/3-.024,.045,Math.PI-.09),shellMat,pivot);shell.name=`Kintsugi ceramic segment ${i+1}`
    for(const edge of [angle+.012,angle+Math.PI/3-.012]){
      const points:number[][]=[];for(let j=0;j<=22;j++){const t=.045+j/22*(Math.PI-.09),a=edge+Math.sin(j*1.3+i)*.014;points.push([-Math.cos(a)*Math.sin(t)*(shellRadius+.002),Math.cos(t)*(shellRadius+.002),Math.sin(a)*Math.sin(t)*(shellRadius+.002)])}
      tube(pivot,seamMat,points,.0022,28).castShadow=false
    }
    const crack:number[][]=[];for(let j=0;j<10;j++){const t=.9+j*.055,a=angle+.1+j*.06+Math.sin(j*2.1)*.018;crack.push([-Math.cos(a)*Math.sin(t)*.348,Math.cos(t)*.348,Math.sin(a)*Math.sin(t)*.348])}tube(pivot,seamMat,crack,.0016,16).castShadow=false
    shells.push({pivot,angle:angle+Math.PI/6})
  }
  const memoryMat=new THREE.MeshBasicMaterial({color:new THREE.Color('#FFD285').multiplyScalar(3),toneMapped:false})
  const privacyCore=mesh(new THREE.IcosahedronGeometry(.105,2),memoryMat,cocoon,0,.59,0);privacyCore.castShadow=false;privacyCore.name='Protected memory core'

  const bark=material('#344237',.96,grainTexture('wood'),.026),tree=new THREE.Group();tree.position.set(1.85,0,-.85);canopy.add(tree)
  for(let strand=0;strand<5;strand++){
    const phase=strand/5*Math.PI*2,points:number[][]=[]
    for(let j=0;j<=18;j++){const t=j/18;points.push([-.14*Math.sin(t*5)+Math.cos(phase+t*5)*(.065+.025*(1-t)),t*2.63,Math.sin(phase+t*5)*.075])}
    tube(tree,bark,points,.037,42)
  }
  const branchEnds=[[-1.48,2.58,.48],[-.96,2.94,-.33],[.12,3.05,.2],[.95,2.83,-.3],[.62,2.62,.65],[-.58,2.72,.9]]
  branchEnds.forEach((end,i)=>tube(tree,bark,[[0,1.5+i*.105,0],[end[0]*.35,2.28,end[2]*.26],[end[0]*.76,end[1]+.12,end[2]*.8],end],.025,30))
  for(let i=0;i<8;i++){const a=i/8*Math.PI*2;tube(tree,bark,[[0,.18,0],[Math.cos(a)*.22,.035,Math.sin(a)*.22],[Math.cos(a)*.43,0,Math.sin(a)*.43]],.022,14)}
  const leafGeometry=new THREE.SphereGeometry(1,8,6),leafMat=new THREE.MeshStandardMaterial({color:'#477455',roughness:.9,transparent:true,opacity:.82,emissive:'#234832',emissiveIntensity:.3})
  const leaves=new THREE.InstancedMesh(leafGeometry,leafMat,360),dummy=new THREE.Object3D()
  for(let i=0;i<360;i++){
    const end=branchEnds[i%branchEnds.length],angle=random(i*7+1)*Math.PI*2,r=Math.sqrt(random(i*11+2))*.48
    dummy.position.set(end[0]+Math.cos(angle)*r,end[1]+(random(i*13+3)-.5)*.23,end[2]+Math.sin(angle)*r*.6)
    dummy.rotation.set(random(i+400)*2,angle,random(i+900)*2);dummy.scale.set(.08+random(i+100)*.05,.012,.027+random(i+150)*.025);dummy.updateMatrix();leaves.setMatrixAt(i,dummy.matrix)
  }
  leaves.receiveShadow=true;tree.add(leaves)
  const lightThreads=new THREE.Group();lightThreads.name='Falling light filaments';tree.add(lightThreads)
  const filamentMat=new THREE.MeshBasicMaterial({color:new THREE.Color('#CFE8AA').multiplyScalar(1.9),transparent:true,opacity:.3,toneMapped:false,depthWrite:false,blending:THREE.AdditiveBlending})
  const threadTime={value:0}
  filamentMat.onBeforeCompile=shader=>{shader.uniforms.uThreadTime=threadTime;shader.vertexShader='uniform float uThreadTime;attribute float aHang;\n'+shader.vertexShader;shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\ntransformed.x+=sin(uThreadTime*.45+position.y)*.025*aHang*aHang;transformed.z+=cos(uThreadTime*.38+position.x)*.018*aHang*aHang;')};filamentMat.customProgramCacheKey=()=> 'anchored-light-filaments-v1'
  for(let i=0;i<42;i++){
    const end=branchEnds[i%branchEnds.length],x=end[0]+(random(i*2+40)-.5)*.35,z=end[2]+(random(i*3+70)-.5)*.3,length=.35+random(i+90)*.85
    tube(tree,bark,[[end[0],end[1],end[2]],[x,end[1]+.015,z]],.006,5)
    const points:number[][]=[];for(let j=0;j<=12;j++){const t=j/12;points.push([x+Math.sin(t*2.7+i)*.025*t,end[1]-t*length,z+Math.sin(t*3+i)*.055*t])}
    const thread=tube(lightThreads,filamentMat,points,.0023,14);thread.castShadow=false;thread.receiveShadow=false
    const positions=thread.geometry.getAttribute('position'),hang=new Float32Array(positions.count);for(let j=0;j<positions.count;j++)hang[j]=THREE.MathUtils.clamp((end[1]-positions.getY(j))/length,0,1);thread.geometry.setAttribute('aHang',new THREE.BufferAttribute(hang,1))
  }
  const lanterns:Lantern[]=[],coordinates=[[.85,2.25,-.15],[1.35,2.45,-.15],[1.85,2.15,-.45]]
  const profile:THREE.Vector2[]=[]
  for(let j=0;j<=24;j++){const t=j/24;profile.push(new THREE.Vector2(.024+Math.pow(Math.sin(Math.PI*t),.7)*.105,-.19+t*.38))}
  const lanternGeo=new THREE.LatheGeometry(profile,32),cordMat=material('#8e9475',1)
  for(let i=0;i<3;i++){
    const [x,y,z]=coordinates[i],root=new THREE.Group();root.position.set(x,y,z);root.name=`Paper lantern ${i+1}`;canopy.add(root)
    const anchor=new THREE.Vector3(x+.02,[2.68,2.91,2.62][i],z-.03)
    const endpoint=[anchor.x-1.85,anchor.y,anchor.z+.85],start=branchEnds[i]
    tube(tree,bark,[start,[(start[0]+endpoint[0])*.5,anchor.y+.09,(start[2]+endpoint[2])*.5],endpoint],.014,20)
    const cord=mesh(new THREE.CylinderGeometry(.0025,.0025,1,5),cordMat,canopy);cord.castShadow=false
    const lanternMaterial=new THREE.MeshStandardMaterial({color:'#F4EACF',roughness:.86,bumpMap:grainTexture('paper'),bumpScale:.006,emissive:'#FFC46D',emissiveIntensity:.55})
    const body=mesh(lanternGeo,lanternMaterial,root);body.name=`lantern-hit-${i}`;body.castShadow=false
    for(let rib=0;rib<12;rib++){
      const a=rib/12*Math.PI*2,points:number[][]=[];for(const point of profile)points.push([Math.cos(a)*(point.x+.001),point.y,Math.sin(a)*(point.x+.001)])
      tube(root,dullGold,points,.0017,24).castShadow=false
    }
    for(const side of [-1,1])ring(root,.028,side*.188,gold,.0023)
    const light=new THREE.PointLight('#FFBF69',.2,2.4,2);light.position.copy(root.position);lanterns.push({root,body,cord,anchor,light,material:lanternMaterial,restY:y})
    batchStatic(root,[body])
  }
  batchStatic(altar,[...papers,altarRay]);batchStatic(cocoon,[...shells.map(s=>s.pivot),privacyCore]);shells.forEach(s=>batchStatic(s.pivot))
  batchStatic(tree,[leaves,lightThreads]);batchStatic(lightThreads)
  return {stations,canopy,lanterns,paperState,privacyState,paperCenter,privacyCore,update(time,reduced){
    paperTime.value=reduced?0:time
    papers.forEach((sheet,i)=>{const a=i*Math.PI*2/3+paperState.orbit;sheet.position.set(Math.cos(a)*.23,.78+(reduced?0:Math.sin(time*.65+i*1.3)*.045)+Math.sin(a)*.08,Math.sin(a)*.17);sheet.rotation.set(-.38+(reduced?0:Math.sin(time*.45+i)*.075),-.25+Math.sin(a)*.32,Math.cos(a)*.15)})
    for(const shell of shells){const open=1-privacyState.closure;shell.pivot.position.set(-Math.cos(shell.angle)*open*.17,.59+open*.055,Math.sin(shell.angle)*open*.17);shell.pivot.rotation.set(Math.sin(shell.angle)*open*.16,0,Math.cos(shell.angle)*open*.16)}
    seamMat.color.set('#FFB84D').multiplyScalar(.55+privacyState.closure*.65)
    privacyCore.rotation.y=reduced?0:time*.18;privacyCore.position.y=.59+(reduced?0:Math.sin(time*.8)*.018);privacyCore.visible=privacyState.closure<.98
    threadTime.value=reduced?0:time
    altarRay.material.uniforms.uTime.value=time
  }}
}
