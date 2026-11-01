import * as THREE from 'three'
import { grainTexture,mesh } from './craft'

function petal(length:number,width:number):THREE.BufferGeometry {
  const rows=32,columns=20,positions:number[]=[],colors:number[]=[],uvs:number[]=[],indices:number[]=[]
  const ivory=new THREE.Color('#FFFDF9'),ruby=new THREE.Color('#B83A32'),color=new THREE.Color()
  for(let i=0;i<=rows;i++)for(let j=0;j<=columns;j++){
    const t=i/rows,a=j/columns*Math.PI*2,s=Math.sin(Math.PI*t),v=Math.sin(a)
    const breadth=width*Math.pow(s,.62),thickness=.027*Math.pow(s,.5)
    const cup=.15*Math.pow(s,.8)*(1-v*v)+.17*t*t-.095*Math.pow(t,7)
    positions.push(breadth*v,length*t,cup+thickness*Math.cos(a));uvs.push(j/columns,t)
    const pigment=THREE.MathUtils.smoothstep(t+.018*Math.sin(v*9),.66,.99)
    color.copy(ivory).lerp(ruby,pigment*.94);colors.push(color.r,color.g,color.b)
  }
  for(let i=0;i<rows;i++)for(let j=0;j<columns;j++){const a=i*(columns+1)+j,b=a+1,c=a+columns+1;indices.push(a,b,c,b,c+1,c)}
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));geometry.setIndex(indices);geometry.computeVertexNormals()
  const normals=geometry.getAttribute('normal'),normal=new THREE.Vector3(),other=new THREE.Vector3()
  for(let row=1;row<rows;row++){const a=row*(columns+1),b=a+columns;normal.fromBufferAttribute(normals,a).add(other.fromBufferAttribute(normals,b)).normalize();normals.setXYZ(a,normal.x,normal.y,normal.z);normals.setXYZ(b,normal.x,normal.y,normal.z)}
  for(const row of [0,rows])for(let j=0;j<=columns;j++)normals.setXYZ(row*(columns+1)+j,0,row===0?-1:1,0)
  return geometry
}

export function createLotus():{group:THREE.Group;petalCount:number;material:THREE.MeshPhysicalMaterial;update:(time:number,reduced:boolean)=>void} {
  const group=new THREE.Group();group.name='Porcelain Lotus — 36 petals';group.position.set(-.25,.15,-.55);group.scale.setScalar(.78)
  const material=new THREE.MeshPhysicalMaterial({color:'#ffffff',vertexColors:true,transmission:.35,thickness:.6,roughness:.45,metalness:0,ior:1.38,specularIntensity:.36,bumpMap:grainTexture('clay'),bumpScale:.008})
  const petals:{pivot:THREE.Group;tilt:number;layer:number;phase:number}[]=[]
  const rings=[{length:.81,width:.29,radius:.17,y:-.08,tilt:1.27,count:11},{length:.87,width:.285,radius:.12,y:.035,tilt:1.04,count:10},{length:.83,width:.26,radius:.075,y:.15,tilt:.79,count:8},{length:.68,width:.23,radius:.035,y:.245,tilt:.53,count:7}]
  rings.forEach((ring,layer)=>{
    const geometry=petal(ring.length,ring.width)
    for(let i=0;i<ring.count;i++){
      const angle=i/ring.count*Math.PI*2+layer*.37,root=new THREE.Group(),pivot=new THREE.Group()
      root.position.set(Math.sin(angle)*ring.radius,ring.y,Math.cos(angle)*ring.radius);root.rotation.y=angle
      const tilt=ring.tilt+Math.max(0,Math.cos(angle))*(layer===3?.42:layer===2?.28:.035)
      pivot.rotation.x=tilt;const object=mesh(geometry,material,pivot);object.name=`Porcelain petal ${petals.length+1}`
      root.add(pivot);group.add(root);petals.push({pivot,tilt,layer,phase:i*.29})
    }
  })
  const base=mesh(new THREE.SphereGeometry(.19,24,16),new THREE.MeshStandardMaterial({color:'#b7aa83',roughness:.9}),group,0,-.05,0);base.scale.y=.7
  return {group,material,petalCount:petals.length,update(time,reduced){for(const p of petals)p.pivot.rotation.x=p.tilt+(reduced?0:Math.sin(time*.72+p.layer*.12)*.028+Math.sin(time*.29+p.phase)*.006)}}
}

