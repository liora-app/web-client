import * as THREE from 'three'
import { fractal,random } from './noise'
import { worldVertex } from './optics'
import { surfaceNoise } from './surface'

/** Where the moon disc sits in the sky (the light rig takes its azimuth for the moonlight). Low over the water, behind the willow. */
const moonAzimuth=-.79,moonElevation=.13
export const moonDirection=new THREE.Vector3(Math.cos(moonElevation)*Math.cos(moonAzimuth),Math.sin(moonElevation),Math.cos(moonElevation)*Math.sin(moonAzimuth))
/** Night palette (sRGB). Fog in scene.ts uses `horizon`, so the island, the water and the far ridges dissolve into one sky. */
export const night={zenith:'#020509',mid:'#06121a',horizon:'#0d2124',moonGlow:'#3d5560',deep:'#010605',ridge:'#030a0b',mist:'#1a3033'}

/** Exponential-squared distance haze shared by every unfogged shader (water, ridges, mist). */
const haze='float hazeFactor(vec3 p){float d=length(p.xz-cameraPosition.xz)*uHaze;return 1.-exp(-d*d);}'
const skyPars=`uniform vec3 uZenith,uMid,uHorizon,uMoonGlow,uMoonDir;
  vec3 skyGradient(vec3 dir){float h=dir.y;vec3 c=mix(uHorizon,uMid,smoothstep(-.02,.2,h));c=mix(c,uZenith,smoothstep(.16,.72,h));
    float md=max(dot(dir,uMoonDir),0.),ang=sqrt(max(0.,2.-2.*md));vec2 flat_=normalize(dir.xz+1e-5),moonFlat=normalize(uMoonDir.xz);
    c+=uMoonGlow*(exp(-ang*3.2)*.55+exp(-ang*14.)*.5);c+=uMoonGlow*.35*exp(-max(h,0.)*7.)*pow(max(dot(flat_,moonFlat),0.),3.);
    c+=vec3(.004,.012,.008)*exp(-pow((h-.09)*10.,2.));return c;}`

export function createEnvironment(cameraCurve:THREE.CatmullRomCurve3) {
  const group=new THREE.Group();group.name='Sky, distant ridges, water and mist'
  const time={value:0},lightPosition={value:new THREE.Vector3(-.25,.4,-.55)},noise={value:surfaceNoise()},hazeAmount={value:.028}
  const skyUniforms={uZenith:{value:new THREE.Color(night.zenith)},uMid:{value:new THREE.Color(night.mid)},uHorizon:{value:new THREE.Color(night.horizon)},uMoonGlow:{value:new THREE.Color(night.moonGlow)},uMoonDir:{value:moonDirection}}

  // Sky: deep gradient, faint airglow, a moon with a two-tier halo, sparse twinkling stars and thin moonlit cloud.
  const skyMat=new THREE.ShaderMaterial({side:THREE.BackSide,depthWrite:false,uniforms:{uTime:time,uNoise:noise,...skyUniforms},vertexShader:worldVertex,
    fragmentShader:`uniform float uTime;uniform sampler2D uNoise;${skyPars}varying vec3 vWorld;
      float hash13(vec3 p){p=fract(p*.1031);p+=dot(p,p.zyx+31.32);return fract((p.x+p.y)*p.z);}
      void main(){vec3 dir=normalize(vWorld-cameraPosition);vec3 color=skyGradient(dir);float h=dir.y;
        float md=dot(dir,uMoonDir),ang=sqrt(max(0.,2.-2.*md)),fw=fwidth(ang);
        vec2 disc=vec2(dot(dir,normalize(cross(uMoonDir,vec3(0.,1.,0.)))),dir.y-uMoonDir.y)/.0135;
        float maria=texture2D(uNoise,disc*.18+.31).g*.6+texture2D(uNoise,disc*.41+.7).b*.4,limb=sqrt(max(0.,1.-dot(disc,disc)));
        float moon=smoothstep(.0135+fw,.0135-fw-1e-5,ang);color=mix(color,vec3(1.,1.08,1.1)*(.72+.28*limb)*(.8+.3*smoothstep(.38,.68,maria)),moon);
        vec2 cloudUv=dir.xz/(h+.14)*.32+vec2(uTime*.0016,uTime*.0007);
        float cloudNoise=texture2D(uNoise,cloudUv*.5).g*.62+texture2D(uNoise,cloudUv*1.9+.4).r*.38;
        float cloud=smoothstep(.5,.78,cloudNoise)*smoothstep(.0,.07,h)*(1.-smoothstep(.22,.42,h))*.85;
        vec3 p=dir*260.,cell=floor(p);float pick=hash13(cell);
        vec3 jitter=.2+.6*vec3(hash13(cell+11.3),hash13(cell+23.7),hash13(cell+37.1));float d=length(fract(p)-jitter);
        float size=mix(.09,.2,pow(hash13(cell+5.1),6.));float star=smoothstep(size+length(fwidth(p))*.6,size*.25,d)*step(.955,pick);
        float twinkle=.72+.28*sin(uTime*(.7+2.3*hash13(cell+3.3))+pick*40.);
        star*=twinkle*mix(.35,1.6,pow(hash13(cell+7.7),4.))*smoothstep(.05,.32,h)*smoothstep(.06,.4,ang)*(1.-cloud);
        color+=star*mix(vec3(.75,.85,1.),vec3(1.,.9,.75),hash13(cell+9.9));
        vec3 cloudLit=mix(uHorizon*1.25,uMoonGlow*2.4,exp(-ang*2.6));color=mix(color,cloudLit,cloud*(1.-moon*.7)*.75);
        gl_FragColor=vec4(color,1.);}`})
  const sky=new THREE.Mesh(new THREE.SphereGeometry(80,32,16),skyMat);sky.name='Night sky with moon, stars and thin cloud';sky.renderOrder=-10;sky.frustumCulled=false;group.add(sky)

  // Six layered ridges on the horizon: near ones carry a pine-spiked crest, far ones are softer and sink into the haze.
  const ridges=[{az:-.4,span:1.25,r:17,h:1.6,pines:1},{az:-1.45,span:1.15,r:19,h:2.1,pines:1},{az:-2.45,span:1.1,r:21,h:1.5,pines:1},{az:-.95,span:1.4,r:29,h:4.4,pines:0},{az:-2.05,span:1.5,r:36,h:6.6,pines:0},{az:.15,span:1.2,r:42,h:7.2,pines:0}]
  ridges.forEach((ridge,i)=>{
    const length=ridge.span*ridge.r,columns=Math.round(length*(ridge.pines?26:7)),positions:number[]=[],uvs:number[]=[],indices:number[]=[]
    // Conifers: irregular spacing, heights and widths, thinned out in clearings, so the crest never reads as a comb.
    const trees:{s:number;h:number;w:number}[]=[]
    if(ridge.pines)for(let s=0,n=0;s<length;n++){const seed=i*977+n,gap=.12+random(seed)*.3,clearing=fractal(s*.22+i*3.1,2.3,i)>.18;s+=gap;if(!clearing)trees.push({s,h:.22+Math.pow(random(seed+17),1.6)*.62,w:.07+random(seed+31)*.11})}
    for(let k=0;k<=columns;k++){
      const t=k/columns,s=t*length,a=ridge.az-ridge.span/2+t*ridge.span,x=Math.cos(a)*ridge.r,z=Math.sin(a)*ridge.r,envelope=Math.pow(Math.sin(Math.PI*t),.55)
      let top=ridge.h*envelope*(.62+.38*(fractal(t*5+i*7.3,i,1.7)*1.6+.5)),forest=0
      for(const tree of trees){const d=Math.abs(s-tree.s);if(d<tree.w)forest=Math.max(forest,tree.h*Math.pow(1-d/tree.w,1.25))}
      top+=forest*envelope
      positions.push(x,-3,z,x,top-.65,z);uvs.push(t,0,t,1)
      if(k<columns){const b=k*2;indices.push(b,b+2,b+1,b+1,b+2,b+3)}
    }
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));geometry.setIndex(indices)
    // Darker than the sky behind them, then hazed towards that same sky colour with distance (aerial perspective).
    const material=new THREE.ShaderMaterial({side:THREE.DoubleSide,uniforms:{uColor:{value:new THREE.Color(night.ridge)},uMist:{value:new THREE.Color(night.mist)},uHaze:hazeAmount,...skyUniforms},vertexShader:worldVertex,
      fragmentShader:`uniform vec3 uColor,uMist;uniform float uHaze;varying vec2 vUv;varying vec3 vWorld;${skyPars}${haze}
        void main(){vec3 dir=normalize(vWorld-cameraPosition);vec3 behind=skyGradient(vec3(dir.x,max(dir.y,0.),dir.z))*.62;
          vec3 c=mix(uColor,behind,hazeFactor(vWorld));float base=1.-smoothstep(-.65,.05,vWorld.y);c=mix(c,uMist*.8,base*.45);gl_FragColor=vec4(c,1.);}`})
    const ridgeMesh=new THREE.Mesh(geometry,material);ridgeMesh.name=`Distant ridge silhouette ${i+1}`;ridgeMesh.renderOrder=-5;group.add(ridgeMesh)
  })

  // Dark still water: rippled normals reflect the sky gradient by Fresnel, the moon lays a glitter path to the camera,
  // the lotus a warm sheen near the shore; faint rings breathe out from the island edge only, then everything hazes out.
  const waterMat=new THREE.ShaderMaterial({uniforms:{uTime:time,uLight:lightPosition,uNoise:noise,uHaze:hazeAmount,uDeep:{value:new THREE.Color(night.deep)},...skyUniforms},vertexShader:worldVertex,
    fragmentShader:`uniform float uTime,uHaze;uniform vec3 uLight,uDeep;uniform sampler2D uNoise;${skyPars}varying vec3 vWorld;${haze}
      void main(){vec2 p=vWorld.xz;float dist=length(p-cameraPosition.xz);
        vec4 n1=texture2D(uNoise,p*.085+vec2(uTime*.0045,uTime*.003)),n2=texture2D(uNoise,p*.29-vec2(uTime*.008,-uTime*.006));
        float calm=1./(1.+dist*.04);vec2 slope=((n1.rg-.5)*.09+(n2.ba-.5)*.06)*calm;
        float shore=length(vec2(p.x+.12,(p.y+.2)/.84));float ringPhase=shore*4.1-uTime*.22;
        float rings=(.5+.5*sin(ringPhase))*smoothstep(4.05,4.3,shore)*(1.-smoothstep(4.3,5.6,shore));slope+=normalize(p+1e-4)*rings*.022;
        vec3 n=normalize(vec3(slope.x,1.,slope.y)),view=normalize(cameraPosition-vWorld),r=reflect(-view,n);r.y=abs(r.y);
        float fresnel=.02+.98*pow(1.-max(dot(view,n),0.),5.);
        vec3 c=mix(uDeep,skyGradient(r),fresnel);
        float sparkle=smoothstep(.55,.8,texture2D(uNoise,p*1.7+vec2(uTime*.02,-uTime*.015)).a);
        float moonLobe=max(dot(r,uMoonDir),0.);c+=vec3(.75,.85,.9)*(pow(moonLobe,2600.)*(.6+3.4*sparkle)+pow(moonLobe,160.)*.035)*fresnel;
        vec3 toLight=normalize(uLight-vWorld);float sheen=pow(max(dot(r,toLight),0.),48.)*exp(-length(p-uLight.xz)*.3);c+=vec3(.9,.5,.16)*sheen*.35;
        c=mix(c,uHorizon,hazeFactor(vWorld));gl_FragColor=vec4(c,1.);}`})
  const water=new THREE.Mesh(new THREE.CircleGeometry(60,64),waterMat);water.rotation.x=-Math.PI/2;water.position.y=-.65;water.name='Still night water';group.add(water)

  // Three low banks of moonlit mist over the water. They never reach the island, so no plane cuts through the rock.
  const mists:THREE.Mesh<THREE.PlaneGeometry,THREE.ShaderMaterial>[]=[]
  for(let i=0;i<3;i++){
    const mistMat=new THREE.ShaderMaterial({transparent:true,depthWrite:false,side:THREE.DoubleSide,uniforms:{uTime:time,uNoise:noise,uHaze:hazeAmount,uPhase:{value:i*.37},uOpacity:{value:[.3,.22,.16][i]},uColor:{value:new THREE.Color(night.mist)},uHorizon:skyUniforms.uHorizon},vertexShader:worldVertex,
      fragmentShader:`uniform float uTime,uPhase,uOpacity,uHaze;uniform vec3 uColor,uHorizon;uniform sampler2D uNoise;varying vec2 vUv;varying vec3 vWorld;${haze}
        void main(){float r=length((vUv-.5)*2.);float edge=1.-smoothstep(.4,1.,r);float island=smoothstep(4.3,5.8,length(vec2(vWorld.x+.12,(vWorld.z+.2)/.84)));
          vec2 q=vWorld.xz*.075+vec2(uTime*.0035+uPhase,uTime*.0024-uPhase);float n=texture2D(uNoise,q).g*.62+texture2D(uNoise,q*2.4+uPhase).b*.38;
          float cloud=smoothstep(.36,.72,n);gl_FragColor=vec4(mix(uColor,uHorizon,hazeFactor(vWorld)*.6),edge*island*cloud*uOpacity);}`})
    const mist=new THREE.Mesh(new THREE.PlaneGeometry(30+i*6,30+i*6),mistMat);mist.rotation.x=-Math.PI/2;mist.position.y=-.55+i*.11;mist.name=`Low mist bank ${i+1}`;mist.renderOrder=1;group.add(mist);mists.push(mist)
  }
  // World-space points lie beside the actual camera spline, rather than following the screen.
  const count=34,positions=new Float32Array(count*3),phases=new Float32Array(count),sizes=new Float32Array(count)
  for(let i=0;i<count;i++){const p=cameraCurve.getPoint(i/(count-1)),angle=random(i+600)*Math.PI*2,r=.4+random(i+700)*1.25;positions.set([p.x+Math.cos(angle)*r,p.y+(random(i+800)-.5)*1.4,p.z+Math.sin(angle)*r],i*3);phases[i]=random(i+900)*6.28;sizes[i]=.018+random(i+1000)*.028}
  const bokehGeo=new THREE.BufferGeometry();bokehGeo.setAttribute('position',new THREE.BufferAttribute(positions,3));bokehGeo.setAttribute('aPhase',new THREE.BufferAttribute(phases,1));bokehGeo.setAttribute('aSize',new THREE.BufferAttribute(sizes,1))
  const bokehMat=new THREE.ShaderMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,toneMapped:false,uniforms:{uTime:time,uPixelRatio:{value:1}},
    vertexShader:`uniform float uTime,uPixelRatio;attribute float aPhase,aSize;varying float vAlpha;void main(){vec3 p=position;p.y+=sin(uTime*.15+aPhase)*.065;vec4 mv=modelViewMatrix*vec4(p,1.);float d=-mv.z;gl_Position=projectionMatrix*mv;gl_PointSize=clamp(aSize*340.*uPixelRatio/max(.1,d),2.,22.);vAlpha=smoothstep(.25,.7,d)*(1.-smoothstep(1.4,4.,d))*(.045+.02*sin(uTime*.6+aPhase));}`,
    fragmentShader:`varying float vAlpha;void main(){float r=length(gl_PointCoord-.5)*2.;float disc=(1.-smoothstep(.72,1.,r))*(.82+.18*smoothstep(.4,.95,r));gl_FragColor=vec4(vec3(1.15,1.05,.85),disc*vAlpha);}`})
  const bokeh=new THREE.Points(bokehGeo,bokehMat);bokeh.frustumCulled=false;bokeh.name='Foreground spline bokeh';group.add(bokeh)
  return {group,water,sky,mists,bokeh,update(elapsed:number,reduced:boolean,light:THREE.Vector3,pixelRatio:number){time.value=reduced?0:elapsed;lightPosition.value.copy(light);bokehMat.uniforms.uPixelRatio.value=pixelRatio;for(let i=0;i<mists.length;i++)mists[i].rotation.z=reduced?i*.7:i*.7+elapsed*(i%2?-.004:.003)}}
}
