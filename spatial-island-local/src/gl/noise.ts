// Deterministic gradient noise shared by terrain, rocks and placement.
const fade=(t:number):number=>t*t*t*(t*(t*6-15)+10)
const mix=(a:number,b:number,t:number):number=>a+(b-a)*t
export const random=(seed:number):number=>{let value=Math.imul(seed^0x45d9f3b,0x45d9f3b);value=Math.imul(value^(value>>>16),0x45d9f3b);return ((value^(value>>>16))>>>0)/4294967296}
const gradient=(x:number,y:number,z:number,dx:number,dy:number,dz:number):number=>{
  const hash=(Math.imul(x,374761393)^Math.imul(y,668265263)^Math.imul(z,2147483647))&15
  const a=hash<8?dx:dy,b=hash<4?dy:hash===12||hash===14?dx:dz
  return ((hash&1)?-a:a)+((hash&2)?-b:b)
}
export function noise3(x:number,y:number,z:number):number {
  const ix=Math.floor(x),iy=Math.floor(y),iz=Math.floor(z),dx=x-ix,dy=y-iy,dz=z-iz,u=fade(dx),v=fade(dy),w=fade(dz)
  const row=(j:number,k:number):number=>mix(gradient(ix,iy+j,iz+k,dx,dy-j,dz-k),gradient(ix+1,iy+j,iz+k,dx-1,dy-j,dz-k),u)
  return mix(mix(row(0,0),row(1,0),v),mix(row(0,1),row(1,1),v),w)
}
export function fractal(x:number,y:number,z:number):number {return noise3(x,y,z)*.62+noise3(x*2.03+13,y*2.03+7,z*2.03)*.26+noise3(x*4.07,y*4.07+19,z*4.07)*.12}
