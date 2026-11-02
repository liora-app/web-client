import * as THREE from 'three'

export const worldVertex=`varying vec3 vWorld;varying vec2 vUv;void main(){vUv=uv;vec4 world=modelMatrix*vec4(position,1.);vWorld=world.xyz;gl_Position=projectionMatrix*viewMatrix*world;}`

/**
 * A faint shaft of lit dust, not a neon cone: brightest where the shaft faces the camera, soft at its silhouette,
 * fading out towards the top and the root, broken up by slow drifting motes instead of regular ribbons.
 */
export function lightRay(radius:number,height:number,color:string,opacity:number):THREE.Mesh<THREE.CylinderGeometry,THREE.ShaderMaterial> {
  const material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,side:THREE.DoubleSide,blending:THREE.AdditiveBlending,toneMapped:false,uniforms:{uColor:{value:new THREE.Color(color)},uOpacity:{value:opacity},uFade:{value:1},uTime:{value:0}},vertexShader:'varying vec3 vRayNormal,vRayView;'+worldVertex.replace('vUv=uv;','vUv=uv;vRayNormal=normalMatrix*normal;vRayView=-(modelViewMatrix*vec4(position,1.)).xyz;'),
    fragmentShader:`uniform vec3 uColor;uniform float uOpacity,uFade,uTime;varying vec2 vUv;varying vec3 vWorld,vRayNormal,vRayView;
      void main(){float facing=abs(dot(normalize(vRayNormal),normalize(vRayView)));float body=facing*facing*facing;
      float fade=pow(clamp(1.-vUv.y,0.,1.),2.4)*smoothstep(0.,.2,vUv.y);
      float motes=.78+.22*sin(vWorld.y*3.1-uTime*.11+sin(vWorld.x*4.3+vWorld.z*3.7))*sin(vUv.x*6.2832*2.+vWorld.y*1.7);
      gl_FragColor=vec4(uColor*.75,body*fade*motes*uOpacity*uFade);}`})
  const geometry=new THREE.CylinderGeometry(radius*1.8,radius*.16,height,32,1,true);geometry.translate(0,height/2,0)
  const object=new THREE.Mesh(geometry,material);object.name='Volumetric light shaft';object.renderOrder=2;return object
}

let haloTexture:THREE.CanvasTexture|undefined
/** Soft additive glow sprite. The falloff is close to an optical veil (no hard disc), drawn once and shared. */
export function softHalo(color:string,size:number,opacity:number):THREE.Sprite {
  if(!haloTexture){
    const canvas=document.createElement('canvas');canvas.width=canvas.height=128;const context=canvas.getContext('2d');if(!context)throw new Error('Halo canvas unavailable')
    const gradient=context.createRadialGradient(64,64,0,64,64,64)
    for(let i=0;i<=8;i++){const t=i/8,a=Math.exp(-t*t*7)*(1-t);gradient.addColorStop(t,`rgba(255,255,255,${(a*.62).toFixed(4)})`)}
    context.fillStyle=gradient;context.fillRect(0,0,128,128);haloTexture=new THREE.CanvasTexture(canvas)
  }
  const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:haloTexture,color,opacity,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,toneMapped:false}));sprite.scale.setScalar(size);return sprite
}
