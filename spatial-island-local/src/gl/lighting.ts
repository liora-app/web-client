import * as THREE from 'three'
import { moonDirection,night } from './environment'

/**
 * Scene-wide light rig: motivated sources only, no flat ambient wash.
 * - The night sky as a prefiltered environment (one-off PMREM of a tiny gradient scene): soft cool light from above,
 *   a dark ground bounce, and a moon hot spot that gives glazed ceramic, gold and wet stone a real specular glint
 *   (on the direct moon's own direction, so the two make one glint).
 * - The moon: a cool directional key/rim from behind-right with the only shadow map; the frustum is fitted to the island.
 * - A soft cool fill from the camera side without shadows (the moonlit sky behind the viewer), so faces and paper read.
 * - The lotus light lives in glow.ts: one warm breathing point light above the bowl that lights the grass around and the
 *   companion's face. (It replaces the old warm rim spot; ambient + hemisphere are replaced by the environment.)
 * - The lanterns: one warm point light shared by all three (scene.ts moves it to the lantern whose answer is open).
 * Point lights in total: two — the lotus (glow.ts) and the lantern. The count never changes at runtime.
 */
export interface Lighting {
  moon:THREE.DirectionalLight
  /**
   * The one warm light the three paper lanterns share (render-7): it glides to the lantern whose answer is open and
   * rests dim inside the middle one otherwise. One light instead of three keeps every lit shader two loop turns shorter, and its
   * count never changes (a change would rebuild every program).
   */
  lantern:THREE.PointLight
  /** Re-render the soft shadow map now (e.g. after the GLB arrives). */
  refreshShadow:()=>void
  /**
   * Refresh the shadow map by time, not by frame count (motion-14a): `shadowHz` times a second whatever the frame rate,
   * and on every frame while `moving` (a sheet turning, the shell closing, the greeting wave).
   */
  update:(elapsed:number,moving:boolean)=>void
  /** Shadow map resolution and refresh rate of the current quality tier (re-allocates the map, no shader change). */
  setShadowQuality:(size:number,hz:number)=>void
  /** Free the prefiltered sky environment and the shadow map. */
  dispose:()=>void
}

/**
 * Where the moonlight comes from: the moon's side of the sky but higher than the disc drawn low over the water, so tops
 * and faces read. The sky environment's moon hot spot sits on this same direction: it used to sit 23° away (the disc
 * lifted by .35), and every glossy thing showed two glints of one moon, the direct one and the reflected one.
 */
export const moonLightDirection=((azimuth:number,elevation:number)=>new THREE.Vector3(Math.cos(elevation)*Math.cos(azimuth),Math.sin(elevation),Math.cos(elevation)*Math.sin(azimuth)))(Math.atan2(moonDirection.z,moonDirection.x)+.35,.72)
/** The cool fill from the camera side (aimed at the origin). The kintsugi glaze keeps it out of its coat (cocoon.ts). */
export const skyFillPosition=new THREE.Vector3(-3.2,3.4,6.2)

function skyEnvironment(renderer:THREE.WebGLRenderer):THREE.Texture {
  const envScene=new THREE.Scene(),geometry=new THREE.SphereGeometry(10,48,24)
  const material=new THREE.ShaderMaterial({side:THREE.BackSide,depthWrite:false,uniforms:{
    uZenith:{value:new THREE.Color(night.mid).multiplyScalar(2.2)},uHorizon:{value:new THREE.Color(night.horizon).multiplyScalar(2.6)},
    uGround:{value:new THREE.Color('#06100a')},uMoon:{value:new THREE.Color('#cfe0ea').multiplyScalar(22)},uMoonDir:{value:moonLightDirection}},
    vertexShader:'varying vec3 vDir;void main(){vDir=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader:`uniform vec3 uZenith,uHorizon,uGround,uMoon,uMoonDir;varying vec3 vDir;void main(){vec3 d=normalize(vDir);
      vec3 c=d.y>0.?mix(uHorizon,uZenith,smoothstep(0.,.65,d.y)):mix(uHorizon*.55,uGround,smoothstep(0.,.25,-d.y));
      float m=max(dot(d,uMoonDir),0.);c+=uMoon*pow(m,900.)+uMoon*.012*pow(m,12.);gl_FragColor=vec4(c,1.);}`})
  envScene.add(new THREE.Mesh(geometry,material))
  performance.mark('sanctuary:pmrem-start')
  // Measured on the reference GPU: size 64 and 256 both take ~430 ms, all of it the synchronous compile of PMREM's own
  // GGX/blur shaders, so the size stays 256 (a sharper moon glint on glaze and gold costs nothing extra).
  const pmrem=new THREE.PMREMGenerator(renderer),target=pmrem.fromScene(envScene,0,.1,50)
  pmrem.dispose();geometry.dispose();material.dispose()
  performance.measure('sanctuary:pmrem','sanctuary:pmrem-start')
  return target.texture
}

export function createLighting(scene:THREE.Scene,renderer:THREE.WebGLRenderer,island:THREE.Object3D,shadow:{size:number;hz:number}):Lighting {
  const environment=skyEnvironment(renderer);scene.environment=environment;scene.environmentIntensity=2.4
  const moon=new THREE.DirectionalLight('#b9cfe0',3.2);moon.position.copy(moonLightDirection).multiplyScalar(10)
  moon.castShadow=true;moon.shadow.mapSize.set(shadow.size,shadow.size);moon.shadow.bias=-.0004;moon.shadow.normalBias=.02;moon.shadow.radius=3.5;moon.shadow.autoUpdate=false;moon.shadow.needsUpdate=true
  // Fit the orthographic shadow frustum to the island, the willow and the lanterns as seen from the moon.
  const view=new THREE.Matrix4().lookAt(moon.position,moon.target.position,new THREE.Vector3(0,1,0)).setPosition(moon.position).invert(),corner=new THREE.Vector3(),bounds=new THREE.Box3()
  for(let i=0;i<8;i++)bounds.expandByPoint(corner.set(i&1?4.25:-4.25,i&2?3.45:-.75,i&4?3.6:-3.6).applyMatrix4(view))
  Object.assign(moon.shadow.camera,{left:bounds.min.x,right:bounds.max.x,bottom:bounds.min.y,top:bounds.max.y,near:Math.max(.1,-bounds.max.z-.5),far:-bounds.min.z+.5});moon.shadow.camera.updateProjectionMatrix();scene.add(moon)
  const skyFill=new THREE.DirectionalLight('#aab9cf',.8);skyFill.position.copy(skyFillPosition);scene.add(skyFill)
  // Lives in the island frame like the lanterns it serves, so it bobs with them. scene.ts steers position and intensity.
  const lantern=new THREE.PointLight('#ffbf69',0,3.2,2);lantern.name='Shared lantern light';island.add(lantern)
  let interval=1/shadow.hz,lastShadow=-Infinity
  return {
    moon,lantern,
    refreshShadow(){moon.shadow.needsUpdate=true},
    update(elapsed,moving){if(moving||elapsed-lastShadow>=interval-1e-4||elapsed<lastShadow){moon.shadow.needsUpdate=true;lastShadow=elapsed}},
    setShadowQuality(size,hz){
      interval=1/hz
      if(moon.shadow.mapSize.x!==size){moon.shadow.mapSize.set(size,size);moon.shadow.map?.dispose();moon.shadow.map=null;moon.shadow.needsUpdate=true}
    },
    dispose(){environment.dispose();moon.shadow.map?.dispose()},
  }
}
