import * as THREE from 'three'

/** Scene-wide light rig: sky fill, moonlight with the only shadow map, a face fill and the companion rim. */
export interface Lighting {
  moon:THREE.DirectionalLight
  /** Re-render the soft shadow map now (e.g. after the GLB arrives). */
  refreshShadow:()=>void
  update:(frameIndex:number)=>void
}

export function createLighting(scene:THREE.Scene):Lighting {
  scene.add(new THREE.AmbientLight('#c8b68b',.28),new THREE.HemisphereLight('#8aaf9d','#101d16',.9))
  const moon=new THREE.DirectionalLight('#b7d1c6',1.7);moon.position.set(-5,8,4);moon.castShadow=true;moon.shadow.mapSize.set(2048,2048);moon.shadow.bias=-.00035;moon.shadow.normalBias=.012;moon.shadow.radius=3;moon.shadow.autoUpdate=false;moon.shadow.needsUpdate=true
  Object.assign(moon.shadow.camera,{left:-5,right:5,top:5,bottom:-5,near:.5,far:22});scene.add(moon)
  const faceFill=new THREE.DirectionalLight('#b6c6ab',.65);faceFill.position.set(-2,2,5);scene.add(faceFill)
  const rim=new THREE.SpotLight('#FFD285',1.8,7,.7,1,2);rim.position.set(1.5,2.8,-2.5);rim.target.position.set(.8,.8,-1.1);scene.add(rim,rim.target)
  return {
    moon,
    refreshShadow(){moon.shadow.needsUpdate=true},
    // The soft shadow map refreshes every third frame; lights and animation update every frame.
    update(frameIndex){if(frameIndex%3===0)moon.shadow.needsUpdate=true},
  }
}
