import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

export const palette = { forest:'#11221A', moss:'#2D4A3A', clay:'#3B362E', wood:'#4A3525', paper:'#F4EFE6', ivory:'#F2ECE1', terracotta:'#9E3B33', amber:'#FFB84D', gold:'#F5D08A' }

export function grainTexture(kind:'clay'|'wood'|'knit'|'paper',size=256):THREE.CanvasTexture {
  const canvas=document.createElement('canvas');canvas.width=canvas.height=size
  const c=canvas.getContext('2d');if(!c)throw new Error('Canvas texture unavailable')
  c.fillStyle='#969696';c.fillRect(0,0,size,size)
  let seed=57213
  const random=():number=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296}
  for(let i=0;i<7500;i++){const shade=70+random()*110;c.fillStyle=`rgba(${shade},${shade},${shade},${.1+random()*.4})`;c.fillRect(random()*size,random()*size,.5+random()*1.4,.5+random()*1.4)}
  if(kind==='wood')for(let x=0;x<size;x+=3){c.beginPath();c.strokeStyle=`rgba(35,35,35,${.12+random()*.25})`;c.lineWidth=.5+random();for(let y=0;y<=size;y+=4){const xx=x+Math.sin(y*.04+x*.1)*2;c.lineTo(xx,y)}c.stroke()}
  if(kind==='knit'){
    c.lineCap='round'
    for(let y=-12;y<size+12;y+=13)for(let x=-12;x<size+12;x+=14){c.strokeStyle='#626262';c.lineWidth=5;c.beginPath();c.moveTo(x-4,y-5);c.quadraticCurveTo(x-3,y+2,x,y+5);c.quadraticCurveTo(x+3,y+2,x+4,y-5);c.stroke();c.strokeStyle='#c6c6c6';c.lineWidth=2;c.beginPath();c.moveTo(x-3,y-5);c.quadraticCurveTo(x-1,y+3,x,y+4);c.stroke()}
  }
  const texture=new THREE.CanvasTexture(canvas);texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.colorSpace=THREE.NoColorSpace;return texture
}

export function material(color:string,roughness=.9,bumpMap?:THREE.Texture,bumpScale=.025):THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({color,roughness,metalness:0,bumpMap:bumpMap??null,bumpScale})
}

export function mesh(geometry:THREE.BufferGeometry,mat:THREE.Material,parent:THREE.Object3D,x=0,y=0,z=0):THREE.Mesh {
  const object=new THREE.Mesh(geometry,mat);object.position.set(x,y,z);object.castShadow=true;object.receiveShadow=true;parent.add(object);return object
}

export function ellipsoid(parent:THREE.Object3D,mat:THREE.Material,x:number,y:number,z:number,sx:number,sy:number,sz:number,segments=24):THREE.Mesh {
  const object=mesh(new THREE.SphereGeometry(1,segments,16),mat,parent,x,y,z);object.scale.set(sx,sy,sz);return object
}

export function roundedBox(w:number,h:number,d:number,r=.04):THREE.ExtrudeGeometry {
  const shape=new THREE.Shape(),x=-w/2,y=-h/2
  shape.moveTo(x+r,y);shape.lineTo(x+w-r,y);shape.quadraticCurveTo(x+w,y,x+w,y+r);shape.lineTo(x+w,y+h-r);shape.quadraticCurveTo(x+w,y+h,x+w-r,y+h);shape.lineTo(x+r,y+h);shape.quadraticCurveTo(x,y+h,x,y+h-r);shape.lineTo(x,y+r);shape.quadraticCurveTo(x,y,x+r,y)
  const g=new THREE.ExtrudeGeometry(shape,{depth:Math.max(.005,d-r*.6),bevelEnabled:true,bevelSize:r*.3,bevelThickness:r*.3,bevelSegments:3,steps:1,curveSegments:5});g.translate(0,0,-d/2+r*.3);g.computeVertexNormals();return g
}

export function tube(parent:THREE.Object3D,mat:THREE.Material,points:number[][],radius:number,segments=32):THREE.Mesh {
  const curve=new THREE.CatmullRomCurve3(points.map(v=>new THREE.Vector3(v[0],v[1],v[2])))
  return mesh(new THREE.TubeGeometry(curve,segments,radius,8,false),mat,parent)
}

export function shadowTexture():THREE.CanvasTexture {
  const canvas=document.createElement('canvas');canvas.width=canvas.height=128;const c=canvas.getContext('2d');if(!c)throw new Error('Contact shadow unavailable')
  const g=c.createRadialGradient(64,64,5,64,64,63);g.addColorStop(0,'rgba(9,19,14,.68)');g.addColorStop(.45,'rgba(9,19,14,.38)');g.addColorStop(1,'rgba(9,19,14,0)');c.fillStyle=g;c.fillRect(0,0,128,128);return new THREE.CanvasTexture(canvas)
}

export function contact(parent:THREE.Object3D,texture:THREE.Texture,x:number,z:number,w:number,d:number):void {
  const shadow=mesh(new THREE.PlaneGeometry(w,d),new THREE.MeshBasicMaterial({map:texture,transparent:true,depthWrite:false,opacity:.85}),parent,x,.014,z);shadow.rotation.x=-Math.PI/2;shadow.castShadow=false;shadow.receiveShadow=false
}

export function disposeObject(root:THREE.Object3D):void {
  const geometries=new Set<THREE.BufferGeometry>(),materials=new Set<THREE.Material>(),textures=new Set<THREE.Texture>()
  root.traverse(object=>{
    if(object instanceof THREE.InstancedMesh)object.dispose()
    if(object instanceof THREE.SkinnedMesh)object.skeleton.dispose()
    if(object instanceof THREE.Mesh||object instanceof THREE.Points||object instanceof THREE.Line||object instanceof THREE.Sprite){if(!(object instanceof THREE.Sprite))geometries.add(object.geometry);for(const mat of Array.isArray(object.material)?object.material:[object.material]){materials.add(mat);for(const value of Object.values(mat))if(value instanceof THREE.Texture)textures.add(value);if(mat instanceof THREE.ShaderMaterial)for(const u of Object.values(mat.uniforms))if(u.value instanceof THREE.Texture)textures.add(u.value)}}
  })
  geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());textures.forEach(t=>{t.dispose();if(typeof ImageBitmap!=='undefined'&&t.source.data instanceof ImageBitmap)t.source.data.close()})
}

export function breathe(time:number):number {
  const cycle=(time%10)/10
  return cycle<.4?.5-.5*Math.cos(cycle/.4*Math.PI):.5+.5*Math.cos((cycle-.4)/.6*Math.PI)
}

/** Bake static siblings into material batches while preserving every articulated subtree. */
export function batchStatic(root:THREE.Object3D,exclude:THREE.Object3D[]=[]):void {
  root.updateWorldMatrix(true,true)
  const inverse=root.matrixWorld.clone().invert(),transform=new THREE.Matrix4(),batches=new Map<string,{material:THREE.Material;meshes:THREE.Mesh[]}>()
  root.traverse(object=>{
    if(!(object instanceof THREE.Mesh)||object instanceof THREE.InstancedMesh||object instanceof THREE.SkinnedMesh||Array.isArray(object.material))return
    let ancestor:THREE.Object3D|null=object
    while(ancestor&&ancestor!==root){if(exclude.includes(ancestor))return;ancestor=ancestor.parent}
    const key=`${object.material.uuid}:${object.castShadow}:${object.receiveShadow}`
    const batch:{material:THREE.Material;meshes:THREE.Mesh[]}=batches.get(key)??{material:object.material,meshes:[]};batch.meshes.push(object);batches.set(key,batch)
  })
  for(const batch of batches.values()){
    if(batch.meshes.length<2)continue
    const geometries=batch.meshes.map(object=>{const geometry=object.geometry.index?object.geometry.toNonIndexed():object.geometry.clone();transform.multiplyMatrices(inverse,object.matrixWorld);geometry.applyMatrix4(transform);return geometry})
    const combined=mergeGeometries(geometries,false);geometries.forEach(g=>g.dispose());if(!combined)continue
    const merged=new THREE.Mesh(combined,batch.material);merged.castShadow=batch.meshes[0].castShadow;merged.receiveShadow=batch.meshes[0].receiveShadow;merged.name='Static material batch';root.add(merged)
    const obsolete=new Set<THREE.BufferGeometry>();for(const object of batch.meshes){obsolete.add(object.geometry);object.removeFromParent()}obsolete.forEach(g=>g.dispose())
  }
}
