import * as THREE from 'three'
import { batchStatic,material,mesh } from './craft'
import { createCocoon } from './cocoon'
import { fractal } from './noise'
import { paperSheetTexture } from './paper'
import { applySurface } from './surface'
import { createWillow } from './willow'

export interface Lantern {
  root:THREE.Group;body:THREE.Mesh;cord:THREE.Mesh;anchor:THREE.Vector3
  light:THREE.PointLight;material:THREE.MeshStandardMaterial;restY:number
}
export interface Artifacts {
  stations:THREE.Group;canopy:THREE.Group;lanterns:Lantern[]
  paperState:{orbit:number};privacyState:{closure:number}
  paperCenter:THREE.Vector3;privacyCore:THREE.Mesh
  update:(time:number,reduced:boolean)=>void
}
/** What the altar, the cocoon and the willow share. */
export interface Kit {
  /** Reflect the scene's prefiltered night sky at this material's own strength instead of the scene-wide one. */
  environment:<T extends THREE.MeshStandardMaterial>(material:T,intensity:number)=>T
  stone:THREE.MeshStandardMaterial;brass:THREE.MeshStandardMaterial
  /** Old brass set into the stone grooves: patinated and satin, so it never draws a bright line round a silhouette. */
  inlay:THREE.MeshStandardMaterial
  ground:(x:number,z:number)=>number
  /** Lathe whose radius can be re-carved per vertex; normals are rebuilt and the seam stays invisible. */
  lathe:(profile:number[][],segments:number,radius?:(angle:number,y:number,r:number)=>number)=>THREE.BufferGeometry
  /** Horizontal ring that follows the same per-angle wobble as the groove it sits in. */
  ring:(radius:number,y:number,tube:number,wobble:(angle:number,y:number)=>number)=>THREE.BufferGeometry
}

/** island.ts surfaceHeight, repeated because island.ts imports this module. */
function ground(x:number,z:number):number {const d=Math.hypot(x+.25,(z+.55)*1.12);return .018+fractal(x*.95,7,z*.95)*.065-.028*Math.exp(-d*d*1.8)}

/**
 * Own reflection strength. While material.envMap is null, r186 overwrites envMapIntensity with
 * scene.environmentIntensity (2.4) on every draw, and scene.environment does not exist yet when the stations are built
 * (the lighting is made after the island). So the scene's prefiltered night sky is bound on the material's first draw.
 * It is the same texture the renderer would have used, so the program does not change. Material-level on purpose:
 * batchStatic replaces the meshes, the materials survive.
 */
function environment<T extends THREE.MeshStandardMaterial>(material:T,intensity:number):T {
  material.envMapIntensity=intensity
  material.onBeforeRender=(_renderer,scene)=>{if(material.envMap===null&&scene.environment)material.envMap=scene.environment}
  return material
}

function lathe(profile:number[][],segments:number,radius?:(angle:number,y:number,r:number)=>number):THREE.BufferGeometry {
  const geometry=new THREE.LatheGeometry(profile.map(([r,y])=>new THREE.Vector2(r,y)),segments)
  if(!radius)return geometry
  const position=geometry.getAttribute('position')
  for(let i=0;i<position.count;i++){const x=position.getX(i),y=position.getY(i),z=position.getZ(i),r=Math.hypot(x,z);if(r<1e-6)continue;const scale=radius(Math.atan2(x,z),y,r)/r;position.setXYZ(i,x*scale,y,z*scale)}
  geometry.computeVertexNormals()
  const normal=geometry.getAttribute('normal'),points=profile.length,last=segments*points,n=new THREE.Vector3(),m=new THREE.Vector3()
  for(let j=0;j<points;j++){n.fromBufferAttribute(normal,j).add(m.fromBufferAttribute(normal,last+j)).normalize();normal.setXYZ(j,n.x,n.y,n.z);normal.setXYZ(last+j,n.x,n.y,n.z)}
  // Vertices on the axis belong to every slice: give them the true axial normal so no star shows on top.
  for(let i=0;i<position.count;i++)if(Math.hypot(position.getX(i),position.getZ(i))<1e-6)normal.setXYZ(i,0,Math.sign(normal.getY(i))||1,0)
  return geometry
}
function ring(radius:number,y:number,tube:number,wobble:(angle:number,y:number)=>number):THREE.BufferGeometry {
  const geometry=new THREE.TorusGeometry(radius,tube,8,96);geometry.rotateX(Math.PI/2);geometry.scale(1,.8,1)
  const position=geometry.getAttribute('position')
  for(let i=0;i<position.count;i++){const x=position.getX(i),z=position.getZ(i),scale=wobble(Math.atan2(x,z),y);position.setXYZ(i,x*scale,position.getY(i)+y,z*scale)}
  return geometry
}

/** The altar's soft bend: a held page, curling a little at one corner, different on each folio. */
function sheetGeometry(index:number):THREE.PlaneGeometry {
  const geometry=new THREE.PlaneGeometry(.44,.56,12,16),position=geometry.getAttribute('position')
  const curl=[.045,.032,.04][index],lift=[.035,.05,.025][index],twist=[.018,-.022,.012][index]
  for(let i=0;i<position.count;i++){const x=position.getX(i)/.22,y=position.getY(i)/.28;position.setZ(i,curl*x*x+lift*Math.pow(Math.max(0,(x+y)*.5),3)+twist*x*y+.01*Math.sin(y*2.2+index))}
  geometry.computeVertexNormals();return geometry
}

export function createArtifacts():Artifacts {
  const stations=new THREE.Group();stations.name='Luminous sanctuary artifacts'
  // Cold fine-grained basalt, a thin skin of moss only where rain sits on the top faces: it no longer reads as the
  // island's mottled moss.
  const stone=applySurface(material('#45474a',.93),{scale:5,bump:.01,fine:.55,variation:.06,tint:'#e4e4e0',cavity:.12,roughnessVariation:.14,moss:{color:'#4d6b44',amount:.3,low:.86,high:.99}})
  const brass=environment(new THREE.MeshStandardMaterial({color:'#a07e4c',metalness:.9,roughness:.46}),1.05)
  const inlay=environment(new THREE.MeshStandardMaterial({color:'#7d6743',metalness:.85,roughness:.58}),.85)
  const kit:Kit={environment,stone,brass,inlay,ground,lathe,ring}
  const paperState={orbit:0},privacyState={closure:0},paperCenter=new THREE.Vector3(-1.55,.8,.75)

  // Altar: one carved block — buried foot, inlaid foot band, fluted waist with a brass ring, overhanging slab, dished top.
  const altar=new THREE.Group();altar.name='Origami altar';altar.position.set(-1.55,0,.75);stations.add(altar)
  const wobble=(angle:number,y:number):number=>1+fractal(Math.sin(angle)*1.5+3,y*2.4,Math.cos(angle)*1.5)*.03
  const profile=[[0,-.05],[.47,-.05],[.506,-.022],[.522,.012],[.528,.052],[.528,.061],[.516,.063],[.516,.079],[.528,.081],[.528,.097],[.513,.116],[.49,.125],[.43,.13],[.405,.139],
    [.395,.158],[.392,.188],[.38,.191],[.38,.211],[.392,.214],[.395,.252],[.405,.271],[.44,.281],[.468,.289],[.475,.302],[.475,.31],[.463,.312],[.463,.325],[.475,.327],[.475,.333],[.463,.346],[.432,.352],[.3,.349],[.12,.344],[0,.343]]
  const block=mesh(lathe(profile,80,(angle,y,r)=>r*wobble(angle,y)-(y>.14&&y<.27&&r>.386?.0045*(.5+.5*Math.cos(angle*10)):0)),stone,altar);block.name='Carved altar stone'
  // One inlaid band under the slab lip; the lower grooves stay bare stone.
  mesh(ring(.4685,.3185,.008,wobble),inlay,altar).castShadow=false
  // A clay oil lamp on the altar: the one real warm source here, which the folios glow from.
  const lamp=mesh(lathe([[0,0],[.032,0],[.046,.008],[.056,.02],[.058,.026],[.052,.027],[.04,.016],[0,.013]],20),material('#7a4c31',.82),altar,0,.343,0);lamp.name='Clay oil lamp'
  const flameProfile=[[0,0],[.006,.004],[.0095,.012],[.0102,.02],[.0082,.03],[.0052,.04],[.002,.048],[0,.054]],flameGeometry=lathe(flameProfile,10),flameColors:number[]=[]
  const flamePosition=flameGeometry.getAttribute('position')
  for(let i=0;i<flamePosition.count;i++){const t=flamePosition.getY(i)/.054,heat=Math.sin(Math.PI*Math.min(1,t*1.6))*(1-t*.5);flameColors.push(.9+1.3*heat,.32+1.1*heat*heat,.06+.42*heat*heat*heat)}
  flameGeometry.setAttribute('color',new THREE.Float32BufferAttribute(flameColors,3))
  const flame=mesh(flameGeometry,new THREE.MeshBasicMaterial({vertexColors:true}),altar,0,.357,0);flame.castShadow=flame.receiveShadow=false;flame.name='Oil lamp flame'

  // Folios: hand-made paper with a torn edge, brush calligraphy in the paper itself, lit through by the lamp.
  const paperTime={value:0},lampWorld={value:new THREE.Vector3()},papers:THREE.Group[]=[]
  for(let i=0;i<3;i++){
    const texture=paperSheetTexture(i)
    // Paper at night by an oil lamp: the albedo sits well under white and the sky barely reflects in it; the lamp's
    // warmth falls off fast with height, so the sheet is warm at the bottom and cools to moonlight at the top.
    const paper=environment(new THREE.MeshStandardMaterial({color:'#d8ccb4',map:texture,side:THREE.DoubleSide,roughness:.92,alphaTest:.5,alphaToCoverage:true,bumpMap:texture,bumpScale:.0035,emissive:'#ffc890',emissiveMap:texture,emissiveIntensity:.11}),.4)
    paper.onBeforeCompile=shader=>{
      shader.uniforms.uPaperTime=paperTime;shader.uniforms.uPaperPhase={value:i*2.1};shader.uniforms.uLamp=lampWorld
      shader.vertexShader='uniform float uPaperTime,uPaperPhase;varying vec3 vPaperWorld;\n'+shader.vertexShader
        .replace('#include <begin_vertex>','#include <begin_vertex>\ntransformed.z+=(sin(position.y*6.+uPaperTime*.85+uPaperPhase)*.6+sin(position.x*5.-uPaperTime*.6+uPaperPhase)*.4)*.007*(.4+.6*smoothstep(-.28,.28,position.y));')
        .replace('#include <project_vertex>','#include <project_vertex>\nvPaperWorld=(modelMatrix*vec4(transformed,1.)).xyz;')
      shader.fragmentShader='uniform vec3 uLamp;varying vec3 vPaperWorld;\n'+shader.fragmentShader
        .replace('#include <map_fragment>','#include <map_fragment>\nif(!gl_FrontFacing)diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.8,.74,.6),.5);')
        .replace('#include <emissivemap_fragment>','#include <emissivemap_fragment>\ntotalEmissiveRadiance*=.12+2.2*exp(-distance(vPaperWorld,uLamp)*3.4);')
    }
    paper.customProgramCacheKey=()=>'folio-paper-v2'
    const sheet=new THREE.Group();sheet.name=`Floating calligraphy folio ${i+1}`;altar.add(sheet);papers.push(sheet)
    const leaf=mesh(sheetGeometry(i),paper,sheet);leaf.castShadow=true
  }

  const cocoon=createCocoon(kit);stations.add(cocoon.group)
  const willow=createWillow(kit)
  // Stone, brass and clay of both stations become one draw each; the moving parts stay articulated.
  batchStatic(stations,[...papers,flame,...cocoon.moving])
  return {stations,canopy:willow.canopy,lanterns:willow.lanterns,paperState,privacyState,paperCenter,privacyCore:cocoon.core,update(time,reduced){
    paperTime.value=reduced?0:time
    papers.forEach((sheet,i)=>{const a=i*Math.PI*2/3+paperState.orbit;sheet.position.set(Math.cos(a)*.23,.78+(reduced?0:Math.sin(time*.65+i*1.3)*.045)+Math.sin(a)*.08,Math.sin(a)*.17);sheet.rotation.set(-.38+(reduced?0:Math.sin(time*.45+i)*.075),-.25+Math.sin(a)*.32,Math.cos(a)*.15)})
    const flicker=reduced?0:Math.sin(time*7.3)*.5+Math.sin(time*11.9+1.3)*.3+Math.sin(time*3.1+.4)*.2
    flame.scale.set(1-flicker*.04,1+flicker*.1,1-flicker*.04);flame.getWorldPosition(lampWorld.value).y+=.02
    cocoon.update(time,privacyState.closure,reduced)
    willow.update(time,reduced)
  }}
}
