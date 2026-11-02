import * as THREE from 'three'
import { noise3 } from './noise'

/**
 * Hand-made paper, painted once per page on a 2D canvas: fibres, chain lines, asemic brush calligraphy, a small seal
 * and a deckled (torn) edge in the alpha channel. Nothing here is readable text; the words live in the DOM.
 */

type Rand=()=>number
type Stroke=[number,number,number][]
const ink='rgba(34,28,22,.9)'

function seeded(seed:number):Rand {let s=(Math.imul(seed+1,2654435761)>>>0)||1;return ()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/4294967296}}
function context(width:number,height:number):[HTMLCanvasElement,CanvasRenderingContext2D] {
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height
  const c=canvas.getContext('2d');if(!c)throw new Error('Canvas texture unavailable');return [canvas,c]
}

/** Variable-width brush: a polygon offset along the path normals, so a line swells under pressure and tapers out. */
function brush(c:CanvasRenderingContext2D,points:Stroke):void {
  if(points.length<2)return
  const left:number[]=[],right:number[]=[]
  for(let i=0;i<points.length;i++){
    const [x,y,w]=points[i],a=points[Math.max(0,i-1)],b=points[Math.min(points.length-1,i+1)]
    let dx=b[0]-a[0],dy=b[1]-a[1];const l=Math.hypot(dx,dy)||1;dx/=l;dy/=l
    left.push(x-dy*w*.5,y+dx*w*.5);right.push(x+dy*w*.5,y-dx*w*.5)
  }
  c.beginPath();c.moveTo(left[0],left[1])
  for(let i=2;i<left.length;i+=2)c.lineTo(left[i],left[i+1])
  for(let i=right.length-2;i>=0;i-=2)c.lineTo(right[i],right[i+1])
  c.closePath();c.fill()
}

/** One line of quick brush notes. Each "word" is a single stroke of a soft brush along the baseline: pressed down at
 * the start, lifting towards the end, with a slow wobble and now and then a short rising or falling flick. Nothing in
 * it is a letter: from the camera it reads as written lines, up close as brush marks. A half-pixel blur lets the
 * ink bleed into the fibres. */
function brushNotes(c:CanvasRenderingContext2D,rand:Rand,x0:number,x1:number,base:number,size:number):void {
  let x=x0+rand()*size*1.5
  const drift=rand()*Math.PI*2
  c.save();c.filter='blur(.5px)'
  while(x<x1-size*2.5){
    const length=Math.min(x1-x,size*(3+rand()*7)),steps=Math.max(12,Math.round(length/1.2)),stroke:Stroke=[]
    const waves=1.2+rand()*1.4,lift=size*(.08+rand()*.08),phase=rand()*Math.PI*2,slope=(rand()-.5)*.04,load=.7+rand()*.4
    for(let i=0;i<=steps;i++){
      const t=i/steps,px=x+t*length,press=THREE.MathUtils.smoothstep(t,0,.12)*(1-.45*t)*load
      const y=base+Math.sin(px*.011+drift)*1.4+Math.sin(t*Math.PI*2*waves+phase)*lift+Math.sin(t*length/size*2.1+phase*3)*size*.05+slope*t*length
      stroke.push([px,y,size*(.1+.22*press)*(.85+.3*Math.sin(t*23+phase))])
    }
    c.fillStyle=`rgba(34,28,22,${.4+rand()*.12})`;brush(c,stroke)
    if(rand()<.3){
      const at=stroke[Math.floor(steps*(.15+rand()*.7))],up=rand()<.6?-1:1,reach=size*(.8+rand()*.4),flick:Stroke=[]
      for(let i=0;i<=8;i++){const t=i/8;flick.push([at[0]+t*size*.4,at[1]+up*t*reach,size*.2*(1-t*.75)])}
      brush(c,flick)
    }
    x+=length+size*(.6+rand()*.7)
  }
  c.restore()
}

/** An ensō: one breath of a loaded brush. It touches down heavy at the lower left (a small pool of ink), runs round
 * clockwise thinning as the brush empties, and its last third breaks into dry bristle streaks (kasure) that stop
 * short of the start: a hand-made mark with an uneven radius, not a ring with a gap. */
function enso(c:CanvasRenderingContext2D,rand:Rand,cx:number,cy:number,radius:number,width:number):void {
  const bristles=22,start=1.9,sweep=5.9,wobble=rand()*Math.PI*2
  c.save();c.filter='blur(.4px)'
  c.fillStyle='rgba(28,23,18,.6)';c.beginPath();c.ellipse(cx+Math.cos(start+.04)*radius,cy+Math.sin(start+.04)*radius,width*.44,width*.3,start+Math.PI/2,0,Math.PI*2);c.fill()
  for(let b=0;b<bristles;b++){
    const across=b/(bristles-1)-.5,dry=.5+rand()*.4-Math.abs(across)*.45
    c.fillStyle=`rgba(28,23,18,${.55+rand()*.38})`
    let points:Stroke=[]
    for(let i=0;i<=160;i++){
      const t=i/160,press=Math.min(1,t*14)*(1-.72*Math.pow(t,.8))
      if(t>dry&&rand()<.12+t*.34){brush(c,points);points=[];continue}
      const a=start+sweep*t,r=radius*(1+.045*Math.sin(t*Math.PI*2+wobble)+.018*Math.sin(t*9.4+wobble*2)-.035*t)+across*width*(.35+1.3*press)
      points.push([cx+Math.cos(a)*r,cy+Math.sin(a)*r*.97,width/bristles*2.2*(.35+1.3*press)])
    }
    brush(c,points)
  }
  c.restore()
}

/** A willow sprig in ink wash: wet green-grey leaves first, then the stem and midribs in ink. */
function sprig(c:CanvasRenderingContext2D,rand:Rand,x0:number,y0:number,x1:number,y1:number):void {
  const stem:Stroke=[],bend=60
  for(let i=0;i<=40;i++){const t=i/40,x=x0+(x1-x0)*t+Math.sin(t*Math.PI)*bend,y=y0+(y1-y0)*t;stem.push([x,y,3.6*(1-t*.75)])}
  c.save();c.shadowColor='rgba(70,92,70,.45)';c.shadowBlur=4
  const leaves:[number,number,number,number][]=[]
  for(let i=4;i<40;i+=3){
    const [x,y]=stem[i],side=i%2?1:-1,angle=Math.atan2(stem[i+1][1]-y,stem[i+1][0]-x)+side*(.6+rand()*.35)+.5,length=34+rand()*26
    leaves.push([x,y,angle,length])
    c.fillStyle=`rgba(${62+rand()*20},${86+rand()*16},${66+rand()*10},${.32+rand()*.18})`
    c.beginPath();c.moveTo(x,y)
    c.quadraticCurveTo(x+Math.cos(angle-.18)*length*.5,y+Math.sin(angle-.18)*length*.5,x+Math.cos(angle)*length,y+Math.sin(angle)*length)
    c.quadraticCurveTo(x+Math.cos(angle+.18)*length*.5,y+Math.sin(angle+.18)*length*.5,x,y);c.fill()
  }
  c.restore();c.fillStyle=ink;brush(c,stem)
  c.strokeStyle='rgba(34,28,22,.55)';c.lineWidth=.8
  for(const [x,y,angle,length] of leaves){c.beginPath();c.moveTo(x,y);c.lineTo(x+Math.cos(angle)*length*.82,y+Math.sin(angle)*length*.82);c.stroke()}
}

/** Small cinnabar seal, pressed a little unevenly, with carved paper-coloured lines. */
function seal(c:CanvasRenderingContext2D,rand:Rand,x:number,y:number,size:number):void {
  c.save();c.translate(x,y);c.rotate(-.05+rand()*.04)
  c.fillStyle='rgba(158,59,51,.86)';c.beginPath()
  const corners=[[0,0],[size,0],[size,size],[0,size]];corners.forEach(([px,py],i)=>{const jx=px+(rand()-.5)*2,jy=py+(rand()-.5)*2;if(i)c.lineTo(jx,jy);else c.moveTo(jx,jy)});c.closePath();c.fill()
  c.strokeStyle='rgba(236,226,204,.92)';c.lineWidth=size*.1;c.lineCap='square'
  c.beginPath();c.moveTo(size*.22,size*.25);c.lineTo(size*.78,size*.25);c.moveTo(size*.5,size*.25);c.lineTo(size*.5,size*.78);c.moveTo(size*.24,size*.55);c.lineTo(size*.38,size*.78);c.moveTo(size*.76,size*.55);c.lineTo(size*.64,size*.78);c.stroke()
  for(let i=0;i<26;i++){c.fillStyle=`rgba(236,226,204,${.25+rand()*.5})`;c.fillRect(rand()*size,rand()*size,.6+rand()*1.4,.6+rand()*1.2)}
  c.restore()
}

/** Paper body: base tone, soft mottling, chain lines, fibres and a few plant inclusions. */
function paperGround(c:CanvasRenderingContext2D,rand:Rand,width:number,height:number,tone:string):void {
  c.fillStyle=tone;c.fillRect(0,0,width,height)
  for(let i=0;i<26;i++){
    const x=rand()*width,y=rand()*height,r=30+rand()*110,light=rand()<.5,g=c.createRadialGradient(x,y,0,x,y,r)
    const rgb=light?'255,249,236':'196,178,146';g.addColorStop(0,`rgba(${rgb},${.05+rand()*.08})`);g.addColorStop(1,`rgba(${rgb},0)`);c.fillStyle=g;c.fillRect(x-r,y-r,r*2,r*2)
  }
  for(let x=10+rand()*10;x<width;x+=26+rand()*4){c.fillStyle='rgba(170,152,120,.05)';c.fillRect(x,0,1.3,height)}
  for(let y=0;y<height;y+=2.5)if(rand()<.55){c.fillStyle='rgba(255,250,238,.04)';c.fillRect(0,y,width,1)}
  c.lineCap='round'
  // Fibres go into a few shared paths (tone × alpha × width buckets): 1500 curves, a dozen stroke calls.
  const fibres=new Map<string,Path2D>()
  for(let i=0;i<1500;i++){
    const x=rand()*width,y=rand()*height,l=3+rand()*15,a=rand()*Math.PI*2,bend=(rand()-.5)*5,light=rand()<.58
    const alpha=light?.1+Math.floor(rand()*4)*.07:.05+Math.floor(rand()*3)*.05,key=`${light?'255,252,242':'150,128,96'}|${alpha.toFixed(2)}|${(.35+Math.floor(rand()*3)*.3).toFixed(2)}`
    let path=fibres.get(key);if(!path){path=new Path2D();fibres.set(key,path)}
    path.moveTo(x,y);path.quadraticCurveTo(x+Math.cos(a)*l*.5-Math.sin(a)*bend,y+Math.sin(a)*l*.5+Math.cos(a)*bend,x+Math.cos(a)*l,y+Math.sin(a)*l)
  }
  for(const [key,path] of fibres){const [rgb,alpha,line]=key.split('|');c.strokeStyle=`rgba(${rgb},${alpha})`;c.lineWidth=Number(line);c.stroke(path)}
  for(let i=0;i<34;i++){c.fillStyle=`rgba(104,88,62,${.15+rand()*.25})`;c.fillRect(rand()*width,rand()*height,.7+rand()*1.6,.6+rand()*1.1)}
}

/** Writes the canvas into an sRGB DataTexture with a deckled alpha edge. Colour stays intact under alpha 0 (no
 * premultiply round-trip), so mipmaps do not pull a dark fringe in. Rows are flipped: v=1 is the top of the sheet. */
function deckled(c:CanvasRenderingContext2D,rand:Rand,width:number,height:number,seed:number):THREE.DataTexture {
  const source=c.getImageData(0,0,width,height).data,out=new Uint8Array(width*height*4)
  const edge=(length:number,k:number):Float32Array=>{const values=new Float32Array(length);for(let i=0;i<length;i++)values[i]=7.5+noise3(i*.043,seed+k*1.37,.41)*7+noise3(i*.19,seed+k*2.11,1.7)*2.4+(rand()-.5)*1.8;return values}
  const top=edge(width,1),bottom=edge(width,2),left=edge(height,3),right=edge(height,4)
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const distance=Math.min(y-top[x],height-1-y-bottom[x],x-left[y],width-1-x-right[y]),alpha=THREE.MathUtils.clamp(distance*.75+.5,0,1)
    const rim=1-THREE.MathUtils.clamp(1-distance/6,0,1)*.12
    const i=(y*width+x)*4,o=((height-1-y)*width+x)*4
    out[o]=source[i]*rim;out[o+1]=source[i+1]*rim*.985;out[o+2]=source[i+2]*rim*.95;out[o+3]=alpha*255
  }
  const texture=new THREE.DataTexture(out,width,height,THREE.RGBAFormat)
  texture.colorSpace=THREE.SRGBColorSpace;texture.magFilter=THREE.LinearFilter;texture.minFilter=THREE.LinearMipmapLinearFilter
  texture.generateMipmaps=true;texture.anisotropy=8;texture.needsUpdate=true
  return texture
}

const sheets=new Map<number,THREE.DataTexture>()
/** Folio i (0 talk, 1 calm, 2 care): 400×512, the sheet's own aspect. Painted once, then reused. */
export function paperSheetTexture(index:number):THREE.DataTexture {
  const cached=sheets.get(index);if(cached)return cached
  const width=400,height=512,rand=seeded(4000+index*977),[,c]=context(width,height)
  paperGround(c,rand,width,height,['#f0e2c6','#f2e6cd','#eedfc2'][index])
  if(index===0){
    for(let line=0;line<10;line++)brushNotes(c,rand,line%4===0?64:44,350-rand()*70*(line%3===2?1:0),80+line*36,10)
    seal(c,rand,318,446,30)
  } else if(index===1){
    enso(c,rand,200,196,104,30)
    for(let line=0;line<3;line++)brushNotes(c,rand,64,300+rand()*40,356+line*34,9.5)
    seal(c,rand,304,446,26)
  } else {
    sprig(c,rand,96,420,286,92)
    for(let line=0;line<4;line++)brushNotes(c,rand,186,356,168+line*34,9)
    seal(c,rand,52,448,26)
  }
  const texture=deckled(c,rand,width,height,index*5+1);sheets.set(index,texture);return texture
}

/** Lantern crest (mon), ~10 cm across on the body, in the current fill: a brushed ring round three leaves, a crescent
 * moon or a willow sprig. Drawn in a frame squashed to the lathe's texel aspect, so it stays round on the paper. */
function crest(c:CanvasRenderingContext2D,rand:Rand,index:number,cx:number,cy:number):void {
  c.save();c.translate(cx,cy);c.scale(1,.89)
  const ring=(r:number,w:number):void=>{const points:Stroke=[],from=rand()*Math.PI*2;for(let i=0;i<=80;i++){const t=i/80,a=from+t*Math.PI*2.03;points.push([Math.cos(a)*r,Math.sin(a)*r,w*(.75+.45*Math.sin(t*Math.PI))])}brush(c,points)}
  const leaf=(x:number,y:number,a:number,length:number,w:number):void=>{const points:Stroke=[];for(let i=0;i<=18;i++){const t=i/18,bend=Math.sin(t*Math.PI)*length*.06;points.push([x+Math.cos(a)*t*length-Math.sin(a)*bend,y+Math.sin(a)*t*length+Math.cos(a)*bend,w*Math.pow(Math.sin(Math.PI*Math.min(1,.08+t*.95)),.7)])}brush(c,points)}
  ring(31,4.2)
  if(index===0)for(let k=0;k<3;k++){const a=-Math.PI/2+k*Math.PI*2/3+(rand()-.5)*.08;leaf(Math.cos(a)*3,Math.sin(a)*3,a,21,10.5)}
  else if(index===1){c.save();c.beginPath();c.arc(0,0,20,0,Math.PI*2);c.clip();c.beginPath();c.arc(0,0,20,0,Math.PI*2);c.arc(8,-5,17.5,0,Math.PI*2);c.fill('evenodd');c.restore()}
  else{
    const stem:Stroke=[];for(let i=0;i<=20;i++){const t=i/20;stem.push([-12+t*22+Math.sin(t*Math.PI)*-6,19-t*38,2.6*(1-t*.6)])}brush(c,stem)
    for(let k=0;k<5;k++){const [x,y]=stem[3+k*4],side=k%2?1:-1;leaf(x,y,-Math.PI/2+side*(.75+rand()*.2),12+rand()*3,4.6)}
  }
  c.restore()
}

export interface LanternPaper {albedo:THREE.CanvasTexture;glow:THREE.CanvasTexture}
const lanterns=new Map<number,LanternPaper>()
/**
 * Paper for lantern i as two maps of the same sheet, 512×256 so a texel is close to square on the lathe (u runs ~.8 m
 * round the waist, v ~.45 m along the profile): the crest is no longer smeared 3.6:1 round the body.
 * - albedo: the sheet seen from outside at night: even washi, a hairline at each bamboo rib, the crest at half ink.
 * - glow: the same sheet lit from within: brightest at the waist, cloudy where the fibres bunch, and every rib, glued
 *   panel seam and the crest standing dark against the flame, so they only read while the lantern burns.
 * Canvas top = lantern top; the crest faces -Z (u = .5).
 */
export function lanternPaperTextures(index:number,ribs:number):LanternPaper {
  const cached=lanterns.get(index);if(cached)return cached
  const width=512,height=256
  const paint=(lit:boolean):THREE.CanvasTexture=>{
    const rand=seeded(9100+index*131),[canvas,c]=context(width,height)
    for(let y=0;y<height;y++){const s=Math.sin(Math.PI*(1-y/height)),v=Math.round(255*(lit?.24+.76*Math.pow(s,2.2):.8+.2*Math.pow(s,.8)));c.fillStyle=`rgb(${v},${Math.round(v*.97)},${Math.round(v*.9)})`;c.fillRect(0,y,width,1)}
    // Thickness clouds of hand-made paper: faint in reflected light, plain against the flame.
    for(let i=0;i<40;i++){const x=rand()*width,y=rand()*height,r=12+rand()*40,dark=rand()<.5,g=c.createRadialGradient(x,y,0,x,y,r),rgb=dark?'90,60,30':'255,246,226',a=(lit?.12:.03)*(.5+rand());g.addColorStop(0,`rgba(${rgb},${a})`);g.addColorStop(1,`rgba(${rgb},0)`);c.fillStyle=g;c.fillRect(x-r,y-r,r*2,r*2)}
    c.lineCap='round'
    const light=new Path2D(),dark=new Path2D()
    for(let i=0;i<1600;i++){const x=rand()*width,y=rand()*height,l=2+rand()*8,a=rand()*Math.PI,path=rand()<.5?light:dark;path.moveTo(x,y);path.lineTo(x+Math.cos(a)*l,y+Math.sin(a)*l*.9)}
    c.lineWidth=.7;c.strokeStyle=`rgba(255,250,236,${lit?.2:.12})`;c.stroke(light);c.strokeStyle=`rgba(110,86,58,${lit?.24:.09})`;c.stroke(dark)
    // Bamboo ribs: a hairline from outside; a soft shadow with a dark core against the light inside.
    for(let k=1;k<ribs;k++){const y=k/ribs*height;for(const [w,a] of lit?[[5.5,.3],[2.5,.75]]:[[1.2,.22]]){c.fillStyle=`rgba(40,26,14,${a})`;c.fillRect(0,y-w/2,width,w)}}
    // Glued panel seams: the overlap is double paper, darker in transmitted light.
    for(let k=0;k<8;k++){const x=(k+.5)/8*width;c.fillStyle=`rgba(90,66,40,${lit?.2:.05})`;c.fillRect(x-1.5,0,3,height)}
    c.fillStyle=`rgba(46,30,18,${lit?.9:.5})`;crest(c,seeded(9300+index*17),index,width*.5,height*.5)
    const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.wrapS=THREE.RepeatWrapping;texture.anisotropy=4
    return texture
  }
  const paper={albedo:paint(false),glow:paint(true)};lanterns.set(index,paper);return paper
}
