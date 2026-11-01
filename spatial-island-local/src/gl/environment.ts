import * as THREE from 'three'
import { fractal,random } from './noise'
import { worldVertex } from './optics'

export function createEnvironment(cameraCurve:THREE.CatmullRomCurve3) {
  const group=new THREE.Group();group.name='Sky, distant islands, water and mist'
  const time={value:0},lightPosition={value:new THREE.Vector3(-.25,.4,-.55)}
  const skyMat=new THREE.ShaderMaterial({side:THREE.BackSide,depthWrite:false,uniforms:{uTime:time,uZenith:{value:new THREE.Color('#050D0A')},uHorizon:{value:new THREE.Color('#1A3326')},uGreen:{value:new THREE.Color('#244D39')},uAmber:{value:new THREE.Color('#5A4827')}},vertexShader:worldVertex,
    fragmentShader:`uniform float uTime;uniform vec3 uZenith,uHorizon,uGreen,uAmber;varying vec3 vWorld;
      void main(){vec3 dir=normalize(vWorld-cameraPosition);float h=smoothstep(-.12,.7,dir.y);vec3 color=mix(uHorizon,uZenith,h);float angle=atan(dir.z,dir.x);
      float wave=.18+sin(angle*2.4+uTime*.025)*.08+sin(angle*5.2-uTime*.017)*.025;float curtain=exp(-pow((dir.y-wave)*9.,2.));float filaments=.45+.3*sin(angle*19.+sin(angle*7.+uTime*.04)*2.);
      color+=mix(uAmber,uGreen,.5+.5*sin(angle*1.6+uTime*.01))*curtain*filaments*.52;float haze=exp(-abs(dir.y+.02)*8.);color+=uAmber*haze*.12;gl_FragColor=vec4(color,1.);}`})
  const sky=new THREE.Mesh(new THREE.SphereGeometry(80,32,32),skyMat);sky.name='Procedural emerald aurora skydome';sky.renderOrder=-10;group.add(sky)
  for(let i=0;i<6;i++){
    const geometry=new THREE.IcosahedronGeometry(1,3),positions=geometry.getAttribute('position')
    for(let j=0;j<positions.count;j++){const x=positions.getX(j),y=positions.getY(j),z=positions.getZ(j),n=fractal(x*2+i*4,y*2,z*2);positions.setXYZ(j,x*(1+n*.17),y*(1+n*.25),z*(1+n*.17))}geometry.computeVertexNormals()
    const rock=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color:i%2?'#0c2017':'#142c20',roughness:1,transparent:true,opacity:.48,flatShading:true}))
    rock.name=`Distant floating silhouette ${i+1}`;rock.position.set(-18+i*7,-1+random(i+20)*2.4,-15-i*3.8);rock.scale.set(3+random(i+30)*4,.9+random(i+40)*1.7,2.2+random(i+50)*2.3);group.add(rock)
  }
  const waterMat=new THREE.ShaderMaterial({uniforms:{uTime:time,uLight:lightPosition},vertexShader:worldVertex,
    fragmentShader:`uniform float uTime;uniform vec3 uLight;varying vec3 vWorld;void main(){
      vec2 p=vWorld.xz;float distance=length(p);vec2 delta=p-uLight.xz;
      float wave=sin(distance*1.8-uTime*.45+sin(p.x*.7)*.18);float ring=pow(max(0.,wave),22.);float fade=exp(-distance*.25)*smoothstep(2.3,4.8,distance)*(1.-smoothstep(16.,28.,distance));
      vec3 normal=normalize(vec3(cos(p.x*.8+uTime*.12)*.017,1.,sin(p.y*.9-uTime*.13)*.021));vec3 view=normalize(cameraPosition-vWorld);float fresnel=pow(1.-max(0.,dot(view,normal)),3.);
      float glitter=.7+.3*sin(p.x*24.+sin(p.y*11.+uTime*.24)*2.);float reflection=exp(-delta.x*delta.x*2.2-abs(delta.y)*.52)*glitter*.28;
      vec3 color=mix(vec3(.003,.012,.009),vec3(.018,.042,.027),fresnel);color+=vec3(.62,.36,.11)*reflection; color+=vec3(1.4,1.1,.55)*ring*fade*1.7;
      float goldRing=pow(max(0.,sin(length(delta)*4.-uTime*.62)),30.)*exp(-length(delta)*.22);color+=vec3(.42,.24,.065)*goldRing*.08;
      gl_FragColor=vec4(color,1.);}`})
  const water=new THREE.Mesh(new THREE.CircleGeometry(60,64),waterMat);water.rotation.x=-Math.PI/2;water.position.y=-.65;water.name='Amber reflecting ripple water';group.add(water)
  const mists:THREE.Mesh<THREE.PlaneGeometry,THREE.ShaderMaterial>[]=[]
  for(let i=0;i<3;i++){
    const mistMat=new THREE.ShaderMaterial({transparent:true,depthWrite:false,side:THREE.DoubleSide,blending:i===1?THREE.AdditiveBlending:THREE.NormalBlending,uniforms:{uTime:time,uPhase:{value:i*2.1},uColor:{value:new THREE.Color(i===1?'#354b32':'#233f30')}},vertexShader:worldVertex,
      fragmentShader:`uniform float uTime,uPhase;uniform vec3 uColor;varying vec2 vUv;varying vec3 vWorld;
        void main(){vec2 p=(vUv-.5)*2.;float radius=length(p);float edge=(1.-smoothstep(.35,1.,radius))*smoothstep(.08,.42,radius);float a=sin(vWorld.x*.65+sin(vWorld.z*.4+uPhase)+uTime*.045)*sin(vWorld.z*.7-uTime*.03+uPhase);float cloud=.48+.28*a+.14*sin(vWorld.x*1.7+vWorld.z*.8+uPhase);gl_FragColor=vec4(uColor,edge*cloud*.16);}`})
    const mist=new THREE.Mesh(new THREE.PlaneGeometry(25+i*5,25+i*5),mistMat);mist.rotation.x=-Math.PI/2;mist.position.y=-.49+i*.12;mist.name=`Horizontal volumetric mist layer ${i+1}`;mist.renderOrder=1;group.add(mist);mists.push(mist)
  }
  // World-space points lie beside the actual camera spline, rather than following the screen.
  const count=34,positions=new Float32Array(count*3),phases=new Float32Array(count),sizes=new Float32Array(count)
  for(let i=0;i<count;i++){const p=cameraCurve.getPoint(i/(count-1)),angle=random(i+600)*Math.PI*2,r=.4+random(i+700)*1.25;positions.set([p.x+Math.cos(angle)*r,p.y+(random(i+800)-.5)*1.4,p.z+Math.sin(angle)*r],i*3);phases[i]=random(i+900)*6.28;sizes[i]=.018+random(i+1000)*.028}
  const bokehGeo=new THREE.BufferGeometry();bokehGeo.setAttribute('position',new THREE.BufferAttribute(positions,3));bokehGeo.setAttribute('aPhase',new THREE.BufferAttribute(phases,1));bokehGeo.setAttribute('aSize',new THREE.BufferAttribute(sizes,1))
  const bokehMat=new THREE.ShaderMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,toneMapped:false,uniforms:{uTime:time,uPixelRatio:{value:1}},
    vertexShader:`uniform float uTime,uPixelRatio;attribute float aPhase,aSize;varying float vAlpha;void main(){vec3 p=position;p.y+=sin(uTime*.15+aPhase)*.065;vec4 mv=modelViewMatrix*vec4(p,1.);float d=-mv.z;gl_Position=projectionMatrix*mv;gl_PointSize=clamp(aSize*700.*uPixelRatio/max(.1,d),2.,95.);vAlpha=smoothstep(.16,.5,d)*(1.-smoothstep(1.4,4.5,d))*(.1+.04*sin(uTime*.6+aPhase));}`,
    fragmentShader:`varying float vAlpha;void main(){float radius=length(gl_PointCoord-.5)*2.;float a=exp(-radius*radius*4.)*(1.-smoothstep(.6,1.,radius));gl_FragColor=vec4(vec3(1.35,1.1,.58),a*vAlpha);}`})
  const bokeh=new THREE.Points(bokehGeo,bokehMat);bokeh.frustumCulled=false;bokeh.name='Foreground spline bokeh';group.add(bokeh)
  return {group,water,sky,mists,bokeh,update(elapsed:number,reduced:boolean,light:THREE.Vector3,pixelRatio:number){time.value=reduced?0:elapsed;lightPosition.value.copy(light);bokehMat.uniforms.uPixelRatio.value=pixelRatio;for(let i=0;i<mists.length;i++)mists[i].rotation.z=reduced?i*.7:i*.7+elapsed*(i%2?-.007:.005)}}
}


