import * as THREE from 'three'

/**
 * Shared tactile surface for stone, clay, bark, moss and ceramic.
 * A MeshStandard/Physical material gets world-space triplanar micro relief (screen-space bump, so no UVs or tangents
 * are needed and nothing stretches over cylinder UVs), albedo variation with a second tint, cavity darkening,
 * roughness variation and moss that grows on up-facing faces. One shared 256² tileable noise texture, two scales
 * (6 fetches). Works with InstancedMesh and SkinnedMesh.
 */
export interface SurfaceOptions {
  /** Noise tiles per world unit for the broad layer (the fine layer is ×4.3). Default 1.2. */
  scale?:number
  /** Relief height in world units. Default .018. */
  bump?:number
  /** Weight of the fine layer in the relief, 0..1. Default .35. */
  fine?:number
  /** Albedo variation, 0..1. Default .16. */
  variation?:number
  /** Colour the variation drifts towards in patches. Default white (no tint). */
  tint?:THREE.ColorRepresentation
  /** Darkening in noise valleys, 0..1. Default .22. */
  cavity?:number
  /** Roughness swing around the material roughness. Default .12. */
  roughnessVariation?:number
  /** Moss on up-facing faces: amount 0..1, the normal-y window it fades in over. */
  moss?:{color:THREE.ColorRepresentation;amount:number;low?:number;high?:number}
}

let noiseTexture:THREE.DataTexture|undefined
/** Tileable gradient noise; R,G,B,A hold periods 4, 8, 16 and 32 across the tile. Drawn once per page. */
export function surfaceNoise():THREE.DataTexture {
  if(noiseTexture)return noiseTexture
  const size=256,data=new Uint8Array(size*size*4),periods=[4,8,16,32]
  const hash=(x:number,y:number,p:number,c:number):number=>{let h=Math.imul(((x%p)+p)%p,374761393)^Math.imul(((y%p)+p)%p,668265263)^Math.imul(c+1,2246822519);h=Math.imul(h^(h>>>13),1274126177);return ((h^(h>>>16))>>>0)/4294967296*Math.PI*2}
  const fade=(t:number):number=>t*t*t*(t*(t*6-15)+10)
  for(let c=0;c<4;c++){
    const p=periods[c],cell=size/p
    for(let y=0;y<size;y++)for(let x=0;x<size;x++){
      const fx=x/cell,fy=y/cell,ix=Math.floor(fx),iy=Math.floor(fy),dx=fx-ix,dy=fy-iy
      const g=(gx:number,gy:number):number=>{const a=hash(ix+gx,iy+gy,p,c);return Math.cos(a)*(dx-gx)+Math.sin(a)*(dy-gy)}
      const u=fade(dx),v=fade(dy),top=g(0,0)+(g(1,0)-g(0,0))*u,bottom=g(0,1)+(g(1,1)-g(0,1))*u
      data[(y*size+x)*4+c]=Math.round(THREE.MathUtils.clamp(.5+(top+(bottom-top)*v)*.72,0,1)*255)
    }
  }
  noiseTexture=new THREE.DataTexture(data,size,size,THREE.RGBAFormat)
  noiseTexture.wrapS=noiseTexture.wrapT=THREE.RepeatWrapping;noiseTexture.magFilter=THREE.LinearFilter;noiseTexture.minFilter=THREE.LinearMipmapLinearFilter
  noiseTexture.generateMipmaps=true;noiseTexture.colorSpace=THREE.NoColorSpace;noiseTexture.anisotropy=4;noiseTexture.needsUpdate=true
  return noiseTexture
}

const vertexPars='varying vec3 vSurfWorld;varying vec3 vSurfNormal;\n'
const vertexMain=`
  vec4 surfWorld=vec4(transformed,1.);vec3 surfNormal=objectNormal;
  #ifdef USE_INSTANCING
    surfWorld=instanceMatrix*surfWorld;surfNormal=mat3(instanceMatrix)*surfNormal;
  #endif
  surfWorld=modelMatrix*surfWorld;vSurfWorld=surfWorld.xyz;vSurfNormal=normalize(mat3(modelMatrix)*surfNormal);`
const fragmentPars=`
  uniform sampler2D uSurfNoise;uniform float uSurfScale,uSurfBump,uSurfFine,uSurfVariation,uSurfCavity,uSurfRoughness;
  uniform vec3 uSurfTint,uSurfMossColor,uSurfMoss;varying vec3 vSurfWorld;varying vec3 vSurfNormal;
  vec4 surfTriplanar(vec3 p,vec3 w){return texture2D(uSurfNoise,p.yz)*w.x+texture2D(uSurfNoise,p.xz)*w.y+texture2D(uSurfNoise,p.xy)*w.z;}
  vec3 surfPerturb(vec3 surfPos,vec3 surfNorm,vec2 dHdxy,float faceDir){
    vec3 sigmaX=normalize(dFdx(surfPos)),sigmaY=normalize(dFdy(surfPos)),r1=cross(sigmaY,surfNorm),r2=cross(surfNorm,sigmaX);
    float det=dot(sigmaX,r1)*faceDir;vec3 grad=sign(det)*(dHdxy.x*r1+dHdxy.y*r2);return normalize(abs(det)*surfNorm-grad);}
  float surfHeight;float surfMoss;`
const colorMain=`
  vec3 surfN=normalize(vSurfNormal);vec3 surfW=pow(abs(surfN),vec3(4.));surfW/=surfW.x+surfW.y+surfW.z;
  vec4 surfBroad=surfTriplanar(vSurfWorld*uSurfScale,surfW),surfDetail=surfTriplanar(vSurfWorld*uSurfScale*4.3+vec3(.37,.11,.73),surfW);
  surfHeight=mix(dot(surfBroad,vec4(.46,.3,.16,.08)),dot(surfDetail,vec4(.2,.35,.3,.15)),uSurfFine);
  diffuseColor.rgb*=1.+(surfBroad.r-.5)*2.*uSurfVariation;
  diffuseColor.rgb=mix(diffuseColor.rgb,diffuseColor.rgb*uSurfTint,smoothstep(.42,.68,surfBroad.g));
  diffuseColor.rgb*=1.-uSurfCavity*smoothstep(.5,.24,surfHeight);
  surfMoss=uSurfMoss.x*smoothstep(uSurfMoss.y,uSurfMoss.z,surfN.y+(surfBroad.b-.5)*.7+(surfDetail.g-.5)*.18);
  diffuseColor.rgb=mix(diffuseColor.rgb,uSurfMossColor*(.78+.44*surfDetail.r),surfMoss);`
const roughnessMain='\n  roughnessFactor=clamp(roughnessFactor+(surfHeight-.5)*2.*uSurfRoughness+surfMoss*.06,.04,1.);'
const normalMain=`
  normal=surfPerturb(-vViewPosition,normal,vec2(dFdx(surfHeight+surfMoss*(surfDetail.a-.5)*.6),dFdy(surfHeight+surfMoss*(surfDetail.a-.5)*.6))*uSurfBump,faceDirection);`

/** Patch a standard/physical material in place; earlier onBeforeCompile hooks keep running first. */
export function applySurface<T extends THREE.MeshStandardMaterial>(material:T,options:SurfaceOptions={}):T {
  const moss=options.moss
  const uniforms={
    uSurfNoise:{value:surfaceNoise()},uSurfScale:{value:options.scale??1.2},uSurfBump:{value:options.bump??.018},uSurfFine:{value:options.fine??.35},
    uSurfVariation:{value:options.variation??.16},uSurfTint:{value:new THREE.Color(options.tint??'#ffffff')},uSurfCavity:{value:options.cavity??.22},
    uSurfRoughness:{value:options.roughnessVariation??.12},uSurfMossColor:{value:new THREE.Color(moss?.color??'#3d5a3a')},
    uSurfMoss:{value:new THREE.Vector3(moss?.amount??0,moss?.low??.35,moss?.high??.8)},
  }
  material.userData.surface=uniforms
  const previous=material.onBeforeCompile,key=material.customProgramCacheKey()
  material.onBeforeCompile=(shader,renderer)=>{
    previous.call(material,shader,renderer)
    Object.assign(shader.uniforms,uniforms)
    shader.vertexShader=vertexPars+shader.vertexShader.replace('#include <project_vertex>','#include <project_vertex>'+vertexMain)
    shader.fragmentShader=shader.fragmentShader
      .replace('#include <common>','#include <common>'+fragmentPars)
      .replace('#include <color_fragment>','#include <color_fragment>'+colorMain)
      .replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>'+roughnessMain)
      .replace('#include <normal_fragment_maps>','#include <normal_fragment_maps>'+normalMain)
  }
  material.customProgramCacheKey=()=>key+'|surface-v1'
  material.needsUpdate=true
  return material
}
