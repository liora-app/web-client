import * as THREE from 'three'
import { moonDirection,night } from './environment'

/**
 * Scene-wide light rig: motivated sources only, no flat ambient wash.
 * - The night sky as a prefiltered environment (one-off PMREM of a tiny gradient scene): soft cool light from above,
 *   a dark ground bounce, and a moon hot spot that gives glazed ceramic, gold and wet stone a real specular glint.
 * - The moon: a cool directional key/rim from behind-right with the only shadow map; the frustum is fitted to the island.
 * - A soft cool fill from the camera side without shadows (the moonlit sky behind the viewer), so faces and paper read.
 * - The lotus: a warm point light in the core that lights the petals from within, the grass around and the
 *   companion's face. (It replaces the old warm rim spot; ambient + hemisphere are replaced by the environment.)
 */
export interface Lighting {
  moon:THREE.DirectionalLight
  /** Re-render the soft shadow map now (e.g. after the GLB arrives). */
  refreshShadow:()=>void
  update:(frameIndex:number)=>void
}

function skyEnvironment(renderer:THREE.WebGLRenderer):THREE.Texture {
  const envScene=new THREE.Scene(),geometry=new THREE.SphereGeometry(10,48,24)
  const material=new THREE.ShaderMaterial({side:THREE.BackSide,depthWrite:false,uniforms:{
    uZenith:{value:new THREE.Color(night.mid).multiplyScalar(2.2)},uHorizon:{value:new THREE.Color(night.horizon).multiplyScalar(2.6)},
    uGround:{value:new THREE.Color('#06100a')},uMoon:{value:new THREE.Color('#cfe0ea').multiplyScalar(22)},uMoonDir:{value:moonDirection}},
    vertexShader:'varying vec3 vDir;void main(){vDir=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader:`uniform vec3 uZenith,uHorizon,uGround,uMoon,uMoonDir;varying vec3 vDir;void main(){vec3 d=normalize(vDir);
      vec3 c=d.y>0.?mix(uHorizon,uZenith,smoothstep(0.,.65,d.y)):mix(uHorizon*.55,uGround,smoothstep(0.,.25,-d.y));
      float m=max(dot(d,normalize(uMoonDir+vec3(0.,.35,0.))),0.);c+=uMoon*pow(m,900.)+uMoon*.012*pow(m,12.);gl_FragColor=vec4(c,1.);}`})
  envScene.add(new THREE.Mesh(geometry,material))
  const pmrem=new THREE.PMREMGenerator(renderer),target=pmrem.fromScene(envScene,0,.1,50)
  pmrem.dispose();geometry.dispose();material.dispose()
  return target.texture
}

export function createLighting(scene:THREE.Scene,renderer:THREE.WebGLRenderer):Lighting {
  scene.environment=skyEnvironment(renderer);scene.environmentIntensity=2.4
  // Light comes from the moon's side of the sky but higher than the disc drawn low over the water, so tops and faces read.
  const azimuth=Math.atan2(moonDirection.z,moonDirection.x)+.35,elevation=.72
  const moon=new THREE.DirectionalLight('#b9cfe0',3.2);moon.position.set(Math.cos(elevation)*Math.cos(azimuth),Math.sin(elevation),Math.cos(elevation)*Math.sin(azimuth)).multiplyScalar(10)
  moon.castShadow=true;moon.shadow.mapSize.set(2048,2048);moon.shadow.bias=-.0004;moon.shadow.normalBias=.02;moon.shadow.radius=3.5;moon.shadow.autoUpdate=false;moon.shadow.needsUpdate=true
  // Fit the orthographic shadow frustum to the island, the willow and the lanterns as seen from the moon.
  const view=new THREE.Matrix4().lookAt(moon.position,moon.target.position,new THREE.Vector3(0,1,0)).setPosition(moon.position).invert(),corner=new THREE.Vector3(),bounds=new THREE.Box3()
  for(let i=0;i<8;i++)bounds.expandByPoint(corner.set(i&1?4.25:-4.25,i&2?3.45:-.75,i&4?3.6:-3.6).applyMatrix4(view))
  Object.assign(moon.shadow.camera,{left:bounds.min.x,right:bounds.max.x,bottom:bounds.min.y,top:bounds.max.y,near:Math.max(.1,-bounds.max.z-.5),far:-bounds.min.z+.5});moon.shadow.camera.updateProjectionMatrix();scene.add(moon)
  const skyFill=new THREE.DirectionalLight('#aab9cf',.8);skyFill.position.set(-3.2,3.4,6.2);scene.add(skyFill)
  const lotus=new THREE.PointLight('#ffa64d',1.5,5.5,2);lotus.position.set(-.25,.57,-.55);scene.add(lotus)
  return {
    moon,
    refreshShadow(){moon.shadow.needsUpdate=true},
    // The soft shadow map refreshes every third frame; lights and animation update every frame.
    update(frameIndex){if(frameIndex%3===0)moon.shadow.needsUpdate=true},
  }
}
