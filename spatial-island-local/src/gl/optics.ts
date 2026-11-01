import * as THREE from 'three'
const calibrated=new WeakSet<THREE.Material>()
// Keep reflected surfaces below the specified low bloom threshold; emission remains HDR.
export function calibrateRadiance(root:THREE.Object3D):void {
  root.traverse(object=>{
    if(!(object instanceof THREE.Mesh))return
    for(const material of Array.isArray(object.material)?object.material:[object.material]){
      if(!(material instanceof THREE.MeshStandardMaterial)||calibrated.has(material))continue
      calibrated.add(material)
      const previous=material.onBeforeCompile,key=material.customProgramCacheKey()
      material.onBeforeCompile=(shader,renderer)=>{
        previous.call(material,shader,renderer)
        shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>',`vec3 reflectedRadiance=max(vec3(0.),outgoingLight-totalEmissiveRadiance);
          float reflectedLuma=dot(reflectedRadiance,vec3(.2126,.7152,.0722));
          outgoingLight=reflectedRadiance*(.23/(.23+reflectedLuma))+totalEmissiveRadiance;
          #include <opaque_fragment>`)
      }
      material.customProgramCacheKey=()=>key+'-cinematic-radiance-v1';material.needsUpdate=true
    }
  })
}
export const worldVertex=`varying vec3 vWorld;varying vec2 vUv;void main(){vUv=uv;vec4 world=modelMatrix*vec4(position,1.);vWorld=world.xyz;gl_Position=projectionMatrix*viewMatrix*world;}`
export function lightRay(radius:number,height:number,color:string,opacity:number):THREE.Mesh<THREE.CylinderGeometry,THREE.ShaderMaterial> {
  const material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,side:THREE.DoubleSide,blending:THREE.AdditiveBlending,toneMapped:false,uniforms:{uColor:{value:new THREE.Color(color)},uOpacity:{value:opacity},uFade:{value:1},uTime:{value:0}},vertexShader:'varying vec3 vRayNormal,vRayView;'+worldVertex.replace('vUv=uv;','vUv=uv;vRayNormal=normalMatrix*normal;vRayView=-(modelViewMatrix*vec4(position,1.)).xyz;'),
    fragmentShader:`uniform vec3 uColor;uniform float uOpacity,uFade,uTime;varying vec2 vUv;varying vec3 vWorld,vRayNormal,vRayView;void main(){float rim=pow(abs(dot(normalize(vRayNormal),normalize(vRayView))),1.7);float fade=pow(1.-vUv.y,2.)*smoothstep(0.,.12,vUv.y);float ribbons=.87+.13*sin(vWorld.y*6.+vUv.x*9.+uTime*.14);gl_FragColor=vec4(uColor*1.6,rim*fade*ribbons*uOpacity*uFade);}`})
  const geometry=new THREE.CylinderGeometry(radius*1.8,radius*.16,height,32,1,true);geometry.translate(0,height/2,0)
  const object=new THREE.Mesh(geometry,material);object.name='Volumetric light shaft';object.renderOrder=2;return object
}
export function softHalo(color:string,size:number,opacity:number):THREE.Sprite {
  const canvas=document.createElement('canvas');canvas.width=canvas.height=128;const context=canvas.getContext('2d');if(!context)throw new Error('Halo canvas unavailable')
  const gradient=context.createRadialGradient(64,64,0,64,64,64);gradient.addColorStop(0,'rgba(255,255,255,.8)');gradient.addColorStop(.14,'rgba(255,255,255,.27)');gradient.addColorStop(.5,'rgba(255,255,255,.045)');gradient.addColorStop(1,'rgba(255,255,255,0)');context.fillStyle=gradient;context.fillRect(0,0,128,128)
  const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(canvas),color,opacity,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,toneMapped:false}));sprite.scale.setScalar(size);return sprite
}
