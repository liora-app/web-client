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

/** Letter skeletons in x-height units (baseline 0, x-height 1), joined into words and smoothed by a spline:
 * arches, cups, small loops, one ascender and one descender form. Asemic: it reads as handwriting, never as words. */
const LETTERS:[number,number[][]][]=[
  [.78,[[0,.15],[.12,.85],[.22,.95],[.3,.5],[.34,.05],[.42,0],[.52,.5],[.58,1],[.6,.4],[.66,.02],[.78,.12]]],
  [.9,[[0,.1],[.1,.75],[.25,1],[.4,.85],[.44,.3],[.47,0],[.5,.5],[.62,1],[.78,.85],[.8,.2],[.9,.05]]],
  [.6,[[0,.15],[.3,.5],[.42,.8],[.32,.95],[.18,.75],[.2,.25],[.35,.02],[.6,.1]]],
  [.8,[[0,.4],[.15,.9],[.4,1],[.55,.6],[.42,.08],[.18,.1],[.12,.45],[.35,.8],[.7,.95],[.8,.6]]],
  [.62,[[0,.1],[.25,.9],[.45,1.8],[.5,2.25],[.38,2.35],[.28,2],[.26,1],[.3,.2],[.42,0],[.62,.15]]],
  [.75,[[0,.6],[.2,.98],[.42,.75],[.38,.25],[.2,.1],[.12,.45],[.35,.9],[.5,.6],[.48,-.4],[.38,-1.05],[.18,-1.1],[.2,-.7],[.55,-.1],[.75,.15]]],
  [.4,[[0,.1],[.12,.8],[.18,1],[.22,.5],[.26,.05],[.4,.1]]],
  [.78,[[0,.15],[.15,.95],[.3,.7],[.45,.95],[.55,.9],[.58,.4],[.62,0],[.78,.1]]],
]
const LETTER_WEIGHTS=[4,4,4,3,1.2,1,3,2.5]
function pickLetter(rand:Rand):[number,number[][]] {let r=rand()*LETTER_WEIGHTS.reduce((a,b)=>a+b,0);for(let i=0;i<LETTERS.length;i++){r-=LETTER_WEIGHTS[i];if(r<=0)return LETTERS[i]}return LETTERS[0]}

/** One line of asemic cursive in a pointed pen: hairline upstrokes, swelling downstrokes, a slight slant. */
function handwriting(c:CanvasRenderingContext2D,rand:Rand,x0:number,x1:number,base:number,xHeight:number):void {
  let x=x0+rand()*xHeight*2
  const nib=.55,slant=.3,drift=rand()*Math.PI*2
  while(x<x1-xHeight*3){
    const letters=2+Math.floor(rand()*5),stretch=1.15+rand()*.3,skeleton:THREE.Vector2[]=[]
    let cursor=x
    for(let l=0;l<letters;l++){
      const [width,shape]=pickLetter(rand),scale=xHeight*(.9+rand()*.2)
      for(const [px,py] of shape){const y=base+Math.sin(cursor*.012+drift)*1.6-py*scale;skeleton.push(new THREE.Vector2(cursor+px*xHeight*stretch+(base-y)*slant,y))}
      cursor+=width*xHeight*stretch
    }
    const samples=new THREE.SplineCurve(skeleton).getPoints(skeleton.length*5),stroke:Stroke=[]
    samples.forEach((p,i)=>{
      const q=samples[Math.min(samples.length-1,i+1)],o=samples[Math.max(0,i-1)],angle=Math.atan2(q.y-o.y,q.x-o.x),taper=Math.min(1,i/4,(samples.length-1-i)/6)
      stroke.push([p.x,p.y,xHeight*(.05+.2*Math.abs(Math.sin(angle-nib)))*(.35+.65*taper)])
    })
    c.fillStyle=`rgba(34,28,22,${.74+rand()*.18})`;brush(c,stroke)
    x=cursor+xHeight*(1.1+rand()*.9)
  }
}

/** An ensō: one breath of a loaded brush, bristles running dry towards the end. */
function enso(c:CanvasRenderingContext2D,rand:Rand,cx:number,cy:number,radius:number,width:number):void {
  const bristles=18,start=-1.75,sweep=5.45
  for(let b=0;b<bristles;b++){
    const across=b/(bristles-1)-.5,dry=.55+rand()*.45-Math.abs(across)*.35
    c.fillStyle=`rgba(30,25,20,${.5+rand()*.42})`
    let points:Stroke=[]
    for(let i=0;i<=140;i++){
      const t=i/140,press=Math.min(1,t*7)*(1-.5*t)
      if(t>dry&&rand()<.18+t*.3){brush(c,points);points=[];continue}
      const a=start+sweep*t+Math.sin(t*3.1)*.03,r=radius+across*width*(.55+.45*press)+Math.sin(t*11+b)*.8
      points.push([cx+Math.cos(a)*r,cy+Math.sin(a)*r*.97,width/bristles*2*(.5+press)])
    }
    brush(c,points)
  }
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
    for(let line=0;line<10;line++)handwriting(c,rand,line%4===0?64:44,350-rand()*70*(line%3===2?1:0),80+line*36,10)
    seal(c,rand,318,446,30)
  } else if(index===1){
    enso(c,rand,200,196,104,26)
    for(let line=0;line<3;line++)handwriting(c,rand,64,300+rand()*40,356+line*34,9.5)
    seal(c,rand,304,446,26)
  } else {
    sprig(c,rand,96,420,286,92)
    for(let line=0;line<4;line++)handwriting(c,rand,186,356,168+line*34,9)
    seal(c,rand,52,448,26)
  }
  const texture=deckled(c,rand,width,height,index*5+1);sheets.set(index,texture);return texture
}

const lanterns=new Map<number,THREE.CanvasTexture>()
/**
 * Paper for lantern i, used as both albedo and emission: brightest at the waist, darker towards the caps, a dark line
 * at every bamboo rib, glued panel seams and one brush motif facing -Z (u = .5). Canvas top = lantern top.
 */
export function lanternPaperTexture(index:number,ribs:number):THREE.CanvasTexture {
  const cached=lanterns.get(index);if(cached)return cached
  const width=128,height=256,rand=seeded(9100+index*131),[canvas,c]=context(width,height)
  for(let y=0;y<height;y++){const t=1-y/height,glow=.34+.66*Math.pow(Math.sin(Math.PI*t),1.35),v=Math.round(255*glow);c.fillStyle=`rgb(${v},${Math.round(v*.97)},${Math.round(v*.9)})`;c.fillRect(0,y,width,1)}
  c.lineCap='round'
  const light=new Path2D(),dark=new Path2D()
  for(let i=0;i<500;i++){const x=rand()*width,y=rand()*height,l=2+rand()*7,a=rand()*Math.PI,path=rand()<.5?light:dark;path.moveTo(x,y);path.lineTo(x+Math.cos(a)*l,y+Math.sin(a)*l)}
  c.lineWidth=.6;c.strokeStyle='rgba(255,250,236,.14)';c.stroke(light);c.strokeStyle='rgba(110,86,58,.1)';c.stroke(dark)
  for(let k=1;k<ribs;k++){const y=k/ribs*height;for(const [w,a] of [[4,.12],[2.2,.26],[1,.42]]){c.fillStyle=`rgba(40,26,14,${a})`;c.fillRect(0,y-w/2,width,w)}}
  for(let k=0;k<8;k++){const x=(k+.5)/8*width;c.fillStyle='rgba(90,66,40,.07)';c.fillRect(x,0,1.2,height)}
  c.fillStyle='rgba(58,38,22,.7)';c.strokeStyle='rgba(58,38,22,.7)'
  const cx=width*.5,cy=height*.5
  if(index===0)enso(c,rand,cx,cy,22,7)
  else if(index===1){for(let i=0;i<3;i++){const points:Stroke=[];for(let j=0;j<=24;j++){const t=j/24;points.push([cx-24+t*48,cy-16+i*15+Math.sin(t*Math.PI*2+i)*4,3.2*Math.sin(Math.PI*t)+.4])}brush(c,points)}}
  else{const points:Stroke=[];for(let j=0;j<=24;j++){const t=j/24;points.push([cx+Math.sin(t*Math.PI)*10-5,cy+30-t*60,3.4*(1-t*.7)])}brush(c,points);for(let i=0;i<4;i++){const [x,y]=points[5+i*4],side=i%2?1:-1;c.beginPath();c.ellipse(x+side*10,y+4,11,3.2,side*.7,0,Math.PI*2);c.fill()}}
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.wrapS=THREE.RepeatWrapping;texture.anisotropy=4
  lanterns.set(index,texture);return texture
}
