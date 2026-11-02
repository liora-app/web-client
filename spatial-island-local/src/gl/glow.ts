import * as THREE from 'three'
import { random } from './noise'

/** The breathing amber core above the lotus, its halo, the 180 fireflies and the tab sparks. */
export interface Glow {
  core:THREE.Mesh
  light:THREE.PointLight
  particleCount:number
  /** Sparks fly from this point (paper tab change). */
  burst:(origin:THREE.Vector3,elapsed:number)=>void
  setPixelRatio:(dpr:number)=>void
  /** `breath` is the scene's metronome and is ignored: the core breathes on its own drifting clock (coreBreath). */
  update:(state:{elapsed:number;delta:number;breath:number;volume:number;reduced:boolean;velocity:number;cameraDirection:THREE.Vector3})=>void
}

const valueNoise=`
float glowHash(vec3 p){p=fract(p*.3183099+.1);p*=17.;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
float glowNoise(vec3 x){vec3 i=floor(x),f=fract(x);f=f*f*(3.-2.*f);
  return mix(mix(mix(glowHash(i),glowHash(i+vec3(1,0,0)),f.x),mix(glowHash(i+vec3(0,1,0)),glowHash(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(glowHash(i+vec3(0,0,1)),glowHash(i+vec3(1,0,1)),f.x),mix(glowHash(i+vec3(0,1,1)),glowHash(i+vec3(1,1,1)),f.x),f.y),f.z);}
`
/** Point sprites sized in world units: projectionMatrix[1][1] × half the drawing-buffer height ÷ depth. */
const worldPointSize='float pointPixels(float size,float depth){return size*projectionMatrix[1][1]*uPointScale/max(depth,.05);}'

/**
 * The core's breath, 0…1: a calm inhale over 40 % of the cycle and a longer exhale. The clock is a smooth time warp by
 * two slow incommensurate sines, so one cycle drifts between ~9.45 s and ~10.6 s and never settles into a metronome.
 * Stateless and continuous in time: the lotus follows the same rhythm a beat later without sharing state.
 * The full 0…1 swing is kept on every breath (no shallow cycles, no rest at the bottom): any ~3 s window must still move
 * the core by > .025 in scale (verify-production 'keeps breathing'); worst case here ≈ .0295, the old 10 s curve .033.
 */
export function coreBreath(time:number):number {
  const phase=time/10+.022*Math.sin(time*.1698+.3)+.02*Math.sin(time*.1033+1.7),u=phase-Math.floor(phase)
  return u<.4?.5-.5*Math.cos(u/.4*Math.PI):.5+.5*Math.cos((u-.4)/.6*Math.PI)
}

/**
 * Motion time that stops (rather than snapping back to 0) under prefers-reduced-motion and never leaps more than .25 s
 * after a stall (the scene's own delta clamp, so a slow but steady renderer still runs at wall-clock speed), plus a 0…1
 * 'live' amplitude easing in or out over ~.5 s, so toggling the setting never teleports anything.
 */
export interface MotionClock {time:number;live:number;tick:(delta:number,reduced:boolean)=>void}
export function createMotionClock():MotionClock {
  const clock:MotionClock={time:0,live:-1,tick(delta,reduced){
    const step=Math.min(Math.max(delta,0),.25);if(clock.live<0)clock.live=reduced?0:1
    clock.time+=reduced?0:step;clock.live+=((reduced?0:1)-clock.live)*(1-Math.exp(-step/.18))
  }}
  return clock
}

/** In the island frame: the core sits inside the bowl; the one lotus light hangs above the petal tips. */
const CORE_POSITION=new THREE.Vector3(-.25,.53,-.55),LIGHT_POSITION=new THREE.Vector3(-.25,1,-.55),LIGHT_INTENSITY=1.3

export function createGlow(parent:THREE.Object3D):Glow {
  // The only lotus light. It rides in the island frame (the island bobs; a world-space light would swing the hot spot
  // across the petals out of step with the breath) and hangs ~.2 above the inner petal tips: the petals get a warm key of
  // a few units instead of ~60-100 from a light inside the bowl, and the glow inside the bowl comes from the petals' own
  // emission (lotus.ts). Same colour and reach as the light it replaces.
  const light=new THREE.PointLight('#ffa64d',LIGHT_INTENSITY,5.5,2);light.name='Lotus light';light.position.copy(LIGHT_POSITION);parent.add(light)

  // Core: a small emitting volume of warm haze in the cup of the petals, not a lit ball. Premultiplied alpha lets it glow
  // and lightly veil the petals behind it; it stays under the bloom threshold except a soft, broad nucleus, so the bowl
  // reads as lit from within instead of holding a white or orange blot. The chord through a sphere grows with N·V: nucleus
  // in the middle, amber body around it, a shell that thins to nothing at the silhouette (no hard membrane rim, which
  // drew a disc in the cup). Slow warped noise turns inside.
  const coreUniforms={uTime:{value:0},uBreath:{value:0},uVoice:{value:0}}
  const core=new THREE.Mesh(new THREE.SphereGeometry(.215,32,24),new THREE.ShaderMaterial({transparent:true,premultipliedAlpha:true,depthWrite:false,uniforms:coreUniforms,
    vertexShader:'varying vec3 vNormal,vView,vLocal;void main(){vLocal=position*4.65;vec4 mv=modelViewMatrix*vec4(position,1.);vNormal=normalMatrix*normal;vView=-mv.xyz;gl_Position=projectionMatrix*mv;}',
    fragmentShader:`uniform float uTime,uBreath,uVoice;varying vec3 vNormal,vView,vLocal;${valueNoise}
      void main(){
        float mu=clamp(dot(normalize(vNormal),normalize(vView)),0.,1.);
        float a=uTime*.11;vec3 p=vLocal*1.35;p.xz=mat2(cos(a),-sin(a),sin(a),cos(a))*p.xz;p.y-=uTime*.045;
        float warp=glowNoise(p*1.7+vec3(0.,uTime*.03,0.));
        float swirl=glowNoise(p+warp*1.6)*.7+glowNoise(p*2.9-warp)*.3;
        vec3 color=vec3(.3,.1,.02)*pow(mu,1.1)*(.5+.8*swirl)+vec3(.42,.2,.05)*pow(mu,3.)*(.35+.65*swirl)
          +vec3(1.3,.88,.48)*pow(mu,56.)*(.34+.14*uBreath+.4*uVoice)+vec3(.2,.09,.03)*pow(1.-mu,3.)*smoothstep(0.,.25,mu)*.25;
        gl_FragColor=vec4(color,.34*smoothstep(0.,.85,mu));
      }`}))
  core.name='Breathing amber light';core.position.copy(CORE_POSITION);parent.add(core)

  // One soft camera-facing halo (humid night air around the light), computed analytically: no sprite texture, no lens look.
  const haloUniforms={uSize:{value:.8},uStrength:{value:.09},uColor:{value:new THREE.Color('#ffb25e')}}
  const halo=new THREE.Mesh(new THREE.PlaneGeometry(2,2),new THREE.ShaderMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,uniforms:haloUniforms,
    vertexShader:'uniform float uSize;varying vec2 vUv;void main(){vUv=position.xy;vec4 mv=modelViewMatrix*vec4(0.,0.,0.,1.);mv.xy+=position.xy*uSize;gl_Position=projectionMatrix*mv;}',
    fragmentShader:'uniform vec3 uColor;uniform float uStrength;varying vec2 vUv;void main(){float r=length(vUv);float g=exp(-r*3.2)*(1.-smoothstep(.55,1.,r));gl_FragColor=vec4(uColor*g*uStrength,1.);}'}))
  halo.name='Core halo';halo.position.copy(core.position);halo.renderOrder=3;parent.add(halo)

  // Fireflies: static attributes, all motion and flashing on the GPU. Clusters: a ring around the lotus (the first 36 also
  // form the scroll trail), low over the meadow, along the island rim, and a few drifting up by the willow.
  const particlesCount=180,home=new Float32Array(particlesCount*3),motion=new Float32Array(particlesCount*4),flash=new Float32Array(particlesCount*4),colors=new Float32Array(particlesCount*3),trail=new Float32Array(particlesCount)
  const amber=new THREE.Color('#ffb04a'),green=new THREE.Color('#c6e070'),tone=new THREE.Color()
  for(let i=0;i<particlesCount;i++){
    const r=(k:number):number=>random(i*29+k*7+11),a=r(1)*Math.PI*2
    let x:number,y:number,z:number
    if(i<60){const d=.45+r(2)*1.05;x=-.25+Math.cos(a)*d;z=-.55+Math.sin(a)*d*.85;y=.22+r(3)*r(3)*.95}
    else if(i<130){const d=Math.sqrt(r(2))*3.5;x=Math.cos(a)*d;z=Math.sin(a)*d*.84;y=.1+r(3)*r(3)*.6}
    else if(i<165){const d=3.35+r(2)*.95;x=Math.cos(a)*d;z=Math.sin(a)*d*.84;y=.02+r(3)*.6}
    else{x=1.85+(r(2)-.5)*2.4;z=-.85+(r(4)-.5)*2;y=.9+r(3)*1.6}
    home.set([x,y,z],i*3)
    motion.set([.06+r(5)*.22,.04+r(6)*.1,.1+r(7)*.22,r(8)*Math.PI*2],i*4)
    flash.set([2.8+r(9)*4.6,r(10),r(11)<.3?1:0,.028+r(12)*.022],i*4)
    tone.copy(amber).lerp(green,r(13));colors.set([tone.r,tone.g,tone.b],i*3)
    trail[i]=i<36?i/35:-1
  }
  const particleGeometry=new THREE.BufferGeometry();particleGeometry.setAttribute('position',new THREE.BufferAttribute(home,3));particleGeometry.setAttribute('aMotion',new THREE.BufferAttribute(motion,4));particleGeometry.setAttribute('aFlash',new THREE.BufferAttribute(flash,4));particleGeometry.setAttribute('color',new THREE.BufferAttribute(colors,3));particleGeometry.setAttribute('aTrail',new THREE.BufferAttribute(trail,1))
  const particleUniforms={uTime:{value:0},uActivity:{value:0},uReduced:{value:0},uPointScale:{value:450},uCore:{value:core.position.clone()},uCamDir:{value:new THREE.Vector3(0,0,-1)}}
  const particleMaterial=new THREE.ShaderMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,vertexColors:true,uniforms:particleUniforms,
    vertexShader:`uniform float uTime,uActivity,uReduced,uPointScale;uniform vec3 uCore,uCamDir;attribute vec4 aMotion,aFlash;attribute float aTrail;
      varying vec3 vColor;varying float vGlow,vFlash;${worldPointSize}
      void main(){
        float t=uTime*aMotion.z+aMotion.w;
        vec3 p=position+vec3((sin(t)+.5*sin(t*2.27+1.3))*aMotion.x,(sin(t*1.37+2.)*.75+.25*sin(t*3.1+.7))*aMotion.y,(cos(t*.83+.4)+.5*sin(t*1.93+2.6))*aMotion.x);
        float pulled=0.;
        if(aTrail>=0.){
          vec3 tail=uCore-uCamDir*(.22+aTrail*1.25)+vec3(sin(aMotion.w*3.),cos(aMotion.w*5.),sin(aMotion.w*7.))*(.03+.06*aTrail);
          pulled=smoothstep(aTrail*.45,aTrail*.45+.55,uActivity)*.75;p=mix(p,tail,pulled);
        }
        // Long dark rests, a short soft flash (some fireflies double-flash), every one on its own clock.
        float c=fract(uTime/aFlash.x+aFlash.y);
        float f=smoothstep(0.,.03,c)*(1.-smoothstep(.03,.15,c))+aFlash.z*smoothstep(.2,.23,c)*(1.-smoothstep(.23,.33,c))*.75;
        f=mix(max(f,pulled*.6),.42,uReduced);
        vec4 mv=modelViewMatrix*vec4(p,1.);gl_Position=projectionMatrix*mv;
        float depth=-mv.z;
        float ember=.22+.08*sin(uTime*.6+aMotion.w*3.);
        vGlow=(ember+(1.-ember)*f)*smoothstep(.25,.7,depth);vFlash=f;vColor=color;
        gl_PointSize=clamp(pointPixels(aFlash.w*(.8+.5*f),depth),2.,30.);
      }`,
    fragmentShader:`varying vec3 vColor;varying float vGlow,vFlash;
      void main(){vec2 q=gl_PointCoord-.5;float d2=dot(q,q)*4.;float core=exp(-d2*18.),halo=exp(-d2*3.2)*(1.-smoothstep(.5,1.,d2));
        float a=vGlow*(core+halo*.35);if(a<.002)discard;
        gl_FragColor=vec4((vColor*(core*1.5+halo*.35)+vec3(1.,.93,.72)*core*vFlash*1.1)*vGlow,1.);}`})
  const particles=new THREE.Points(particleGeometry,particleMaterial);particles.frustumCulled=false;particles.name='180 amber and green fireflies';parent.add(particles)

  // Sparks: seven embers, each with a sixteen-sample trail of its own past positions, all evaluated from the burst age.
  const sparkCount=7,sparkTrail=16,sparkData=new Float32Array(sparkCount*sparkTrail*2)
  for(let i=0;i<sparkCount;i++)for(let k=0;k<sparkTrail;k++)sparkData.set([i,k/(sparkTrail-1)],(i*sparkTrail+k)*2)
  const sparkGeo=new THREE.BufferGeometry();sparkGeo.setAttribute('position',new THREE.BufferAttribute(new Float32Array(sparkCount*sparkTrail*3),3));sparkGeo.setAttribute('aSpark',new THREE.BufferAttribute(sparkData,2))
  const sparkUniforms={uOrigin:{value:new THREE.Vector3()},uAge:{value:10},uPointScale:particleUniforms.uPointScale}
  const sparkMat=new THREE.ShaderMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,uniforms:sparkUniforms,
    vertexShader:`uniform vec3 uOrigin;uniform float uAge,uPointScale;attribute vec2 aSpark;varying float vFade,vHead;${worldPointSize}
      void main(){
        float id=aSpark.x,lag=aSpark.y,tau=uAge-lag*.14,born=step(0.,tau);tau=max(tau,0.);
        float a=id*.8976+.5+sin(id*12.9)*.25;
        vec3 dir=vec3(cos(a)*1.25,.95+.3*sin(id*3.7),sin(a));
        vec3 off=dir*(1.-exp(-tau*2.2))/2.2*.85;
        float spin=tau*1.1*(mod(id,2.)<.5?1.:-1.);off.xz=mat2(cos(spin),-sin(spin),sin(spin),cos(spin))*off.xz;off.y-=tau*tau*.07;
        vec4 mv=modelViewMatrix*vec4(uOrigin+off,1.);gl_Position=projectionMatrix*mv;
        vFade=born*(1.-smoothstep(.5,1.1,tau))*pow(1.-lag,1.6)*.7;vHead=1.-lag;
        gl_PointSize=clamp(pointPixels(.012+.018*vHead*vHead,-mv.z),1.,24.);
      }`,
    fragmentShader:`varying float vFade,vHead;void main(){vec2 q=gl_PointCoord-.5;float d2=dot(q,q)*4.;float a=exp(-d2*5.)*(1.-smoothstep(.6,1.,d2))*vFade;if(a<.002)discard;
      gl_FragColor=vec4(mix(vec3(.9,.42,.12),vec3(1.5,1.18,.74),vHead)*a*1.5,1.);}`})
  const sparks=new THREE.Points(sparkGeo,sparkMat);sparks.frustumCulled=false;sparks.visible=false;sparks.name='Origami tab sparks';parent.add(sparks)

  let burstAt=-100,particleActivity=0
  const clock=createMotionClock()
  return {
    core,light,particleCount:particlesCount,
    burst(origin,elapsed){sparkUniforms.uOrigin.value.copy(origin);burstAt=elapsed},
    // The scene's metronome `breath` is not used: the core keeps its own drifting rhythm (coreBreath), held at .5 and
    // motionless under reduced motion.
    update({elapsed,delta,volume,reduced,velocity,cameraDirection}){
      clock.tick(delta,reduced)
      const breath=.5+(coreBreath(clock.time)-.5)*clock.live
      core.scale.setScalar(1+breath*.16)
      coreUniforms.uTime.value=clock.time;coreUniforms.uBreath.value=breath;coreUniforms.uVoice.value=volume
      haloUniforms.uSize.value=1.05+breath*.08;haloUniforms.uStrength.value=.04+breath*.012+volume*.02
      light.intensity=LIGHT_INTENSITY*(.9+.2*breath)+volume*.25
      const factor=reduced?0:Math.min(Math.abs(velocity)*.12,1);particleActivity=THREE.MathUtils.lerp(particleActivity,factor,1-Math.exp(-delta/.25))
      particleUniforms.uTime.value=clock.time;particleUniforms.uActivity.value=particleActivity;particleUniforms.uReduced.value=reduced?1:0;particleUniforms.uCamDir.value.copy(cameraDirection)
      const age=elapsed-burstAt;sparks.visible=!reduced&&age<1.15;sparkUniforms.uAge.value=age
    },
    setPixelRatio(dpr){particleUniforms.uPointScale.value=dpr*innerHeight*.5},
  }
}
