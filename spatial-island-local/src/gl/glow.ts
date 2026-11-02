import * as THREE from 'three'
import { lightRay,softHalo } from './optics'
import { random } from './noise'

/** The breathing amber core above the lotus, its halos and shaft, the 180 fireflies and the tab sparks. */
export interface Glow {
  core:THREE.Mesh
  light:THREE.PointLight
  particleCount:number
  /** Five sparks fly from this point (paper tab change). */
  burst:(origin:THREE.Vector3,elapsed:number)=>void
  setPixelRatio:(dpr:number)=>void
  update:(state:{elapsed:number;delta:number;breath:number;volume:number;reduced:boolean;velocity:number;cameraDirection:THREE.Vector3})=>void
}

export function createGlow(parent:THREE.Object3D):Glow {
  const light=new THREE.PointLight('#FFB84D',.13,7,2);light.position.set(-.25,.53,-.55);parent.add(light)
  const core=new THREE.Mesh(new THREE.SphereGeometry(.215,32,24),new THREE.ShaderMaterial({toneMapped:false,
    vertexShader:'varying vec3 vNormal,vView;void main(){vec4 mv=modelViewMatrix*vec4(position,1.);vNormal=normalMatrix*normal;vView=-mv.xyz;gl_Position=projectionMatrix*mv;}',
    fragmentShader:'varying vec3 vNormal,vView;void main(){float edge=pow(1.-abs(dot(normalize(vNormal),normalize(vView))),2.);gl_FragColor=vec4(mix(vec3(1.35,.95,.44),vec3(1.,.49,.14),edge),1.);}'
  }));core.name='Breathing amber light';core.position.copy(light.position);parent.add(core)
  const innerHalo=softHalo('#FFD285',.85,.36),outerHalo=softHalo('#FFC276',1.8,.19);innerHalo.position.copy(core.position);outerHalo.position.copy(core.position);parent.add(innerHalo,outerHalo)
  const lotusRay=lightRay(.25,1.5,'#FFD285',.037);lotusRay.position.set(-.25,.36,-.55);parent.add(lotusRay)
  const particlesCount=180,particlePositions=new Float32Array(particlesCount*3),seeds=new Float32Array(particlesCount*4),phases=new Float32Array(particlesCount),sizes=new Float32Array(particlesCount),particleColors=new Float32Array(particlesCount*3)
  const amber=new THREE.Color('#FFA733'),mint=new THREE.Color('#E6F5B0'),particleColor=new THREE.Color()
  for(let i=0;i<particlesCount;i++){const a=random(i*11+3)*Math.PI*2,r=Math.sqrt(random(i*13+4))*4.2;seeds.set([Math.cos(a)*r,.2+random(i*17+5)*3.2,Math.sin(a)*r*.8,random(i*19+6)*6.28],i*4);phases[i]=seeds[i*4+3];sizes[i]=1.3+random(i+800)*2.4;particleColor.copy(amber).lerp(mint,random(i+900)).multiplyScalar(1.8);particleColors.set(particleColor.toArray(),i*3)}
  const particleGeometry=new THREE.BufferGeometry();particleGeometry.setAttribute('position',new THREE.BufferAttribute(particlePositions,3));particleGeometry.setAttribute('aPhase',new THREE.BufferAttribute(phases,1));particleGeometry.setAttribute('aSize',new THREE.BufferAttribute(sizes,1));particleGeometry.setAttribute('color',new THREE.BufferAttribute(particleColors,3))
  const particleMaterial=new THREE.ShaderMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,toneMapped:false,vertexColors:true,uniforms:{uTime:{value:0},uOpacity:{value:.4},uSize:{value:1},uPixelRatio:{value:1}},
    vertexShader:'uniform float uTime,uSize,uPixelRatio;attribute float aPhase,aSize;varying vec3 vColor;varying float vTwinkle;void main(){vec4 mv=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*mv;gl_PointSize=clamp(aSize*uSize*uPixelRatio*19./max(.15,-mv.z),1.,24.);vColor=color;vTwinkle=.38+.62*pow(.5+.5*sin(uTime*.7+aPhase),2.);}',
    fragmentShader:'uniform float uOpacity;varying vec3 vColor;varying float vTwinkle;void main(){float d=length(gl_PointCoord-.5)*2.;float a=exp(-d*d*5.)*(1.-smoothstep(.6,1.,d));if(a<.005)discard;gl_FragColor=vec4(vColor,a*uOpacity*vTwinkle);}'})
  const particles=new THREE.Points(particleGeometry,particleMaterial);particles.frustumCulled=false;particles.name='180 amber and mint fireflies';parent.add(particles)
  const sparkPositions=new Float32Array(15),sparkGeo=new THREE.BufferGeometry();sparkGeo.setAttribute('position',new THREE.BufferAttribute(sparkPositions,3))
  const sparkMat=new THREE.PointsMaterial({size:.035,color:new THREE.Color('#FFD285').multiplyScalar(2),transparent:true,opacity:0,depthWrite:false,blending:THREE.AdditiveBlending,toneMapped:false})
  const sparks=new THREE.Points(sparkGeo,sparkMat);sparks.name='Origami tab sparks';parent.add(sparks)
  const sparkOrigin=new THREE.Vector3();let burstAt=-100,particleActivity=0
  return {
    core,light,particleCount:particlesCount,
    burst(origin,elapsed){sparkOrigin.copy(origin);burstAt=elapsed},
    update({elapsed,delta,breath,volume,reduced,velocity,cameraDirection}){
      const scale=1+breath*.16;core.scale.setScalar(scale);innerHalo.scale.setScalar(.85+breath*.12);outerHalo.scale.setScalar(1.8+breath*.22);innerHalo.material.opacity=.34+breath*.08;outerHalo.material.opacity=.16+breath*.035
      light.intensity=.10+breath*.035+volume*.025;lotusRay.material.uniforms.uTime.value=elapsed;lotusRay.material.uniforms.uOpacity.value=.03+breath*.012
      const factor=Math.min(Math.abs(velocity)*.12,1);particleActivity=THREE.MathUtils.lerp(particleActivity,factor,1-Math.exp(-delta/.25));particleMaterial.uniforms.uOpacity.value=.34+particleActivity*.28;particleMaterial.uniforms.uTime.value=reduced?0:elapsed
      for(let i=0;i<particlesCount;i++){
        const index=i*3,seed=i*4,phase=seeds[seed+3],drift=reduced?0:elapsed*.06,trail=i/particlesCount
        const motionTime=reduced?0:elapsed,x=seeds[seed]+Math.sin(motionTime*.15+phase)*.1,y=(seeds[seed+1]+drift)%3.3+.12,z=seeds[seed+2]+Math.cos(motionTime*.13+phase)*.1,activity=i<36?particleActivity*.7:0
        particlePositions[index]=THREE.MathUtils.lerp(x,core.position.x-cameraDirection.x*trail*1.5+Math.sin(phase)*.09,activity);particlePositions[index+1]=THREE.MathUtils.lerp(y,core.position.y-cameraDirection.y*trail*1.5+Math.cos(phase)*.06,activity);particlePositions[index+2]=THREE.MathUtils.lerp(z,core.position.z-cameraDirection.z*trail*1.5+Math.cos(phase*2)*.09,activity)
      }
      particleGeometry.attributes.position.needsUpdate=true
      const age=elapsed-burstAt;sparks.visible=age<1.1
      if(sparks.visible){for(let i=0;i<5;i++){const a=i/5*Math.PI*2;sparkPositions[i*3]=sparkOrigin.x+Math.cos(a)*age*.26;sparkPositions[i*3+1]=sparkOrigin.y+age*.35-age*age*.12;sparkPositions[i*3+2]=sparkOrigin.z+Math.sin(a)*age*.2}sparkGeo.attributes.position.needsUpdate=true;sparkMat.opacity=Math.max(0,1-age/1.1)}
    },
    setPixelRatio(dpr){particleMaterial.uniforms.uPixelRatio.value=dpr},
  }
}
