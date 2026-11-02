import './style.css'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import Lenis from 'lenis'
import { setupChat } from './ui/chat'
import { setupSound } from './ui/sound'
import type { SanctuaryScene } from './gl/scene'

gsap.registerPlugin(ScrollTrigger)
// Lenis and scrub share real time, including slower frames during GPU compilation.
gsap.ticker.lagSmoothing(0)
history.scrollRestoration='manual';window.scrollTo(0,0)
const root=document.documentElement,host=document.querySelector<HTMLElement>('#webgl-container')!,entry=document.querySelector<HTMLElement>('.entry')!,notice=document.querySelector<HTMLElement>('.webgl-notice')!,toast=document.querySelector<HTMLElement>('.toast')!,dialog=document.querySelector<HTMLDialogElement>('.help-dialog')!
const reducedQuery=matchMedia('(prefers-reduced-motion: reduce)')
let reduced=reducedQuery.matches,scene:SanctuaryScene|undefined,disposed=false,stage=0,selectedDirection=0,selectedLantern=-1,toastTimer=0,currentVelocity=0,sceneGeneration=0,sceneTalking=false,sceneVolume=0
const state={p:0},cleanup:(()=>void)[]=[]
// Smoothed wheel only when motion is welcome, from the very first frame (motion() keeps it in sync).
const lenis=new Lenis({lerp:.08,smoothWheel:!reduced,autoRaf:false,prevent:node=>Boolean(node.closest('#chat-messages,.notes-panel,dialog,textarea')||node.classList.contains('stage-content')&&node.scrollHeight>node.clientHeight+2)})
const notify=(text:string):void=>{clearTimeout(toastTimer);toast.textContent=text;toast.hidden=false;toastTimer=window.setTimeout(()=>{toast.hidden=true},6500)}
const chat=setupChat(value=>{sceneTalking=value;scene?.setTalking(value)},value=>{sceneVolume=value;scene?.setVoice(value)},notify)
const soundDispose=setupSound(document.querySelector<HTMLButtonElement>('[data-sound]')!,notify)
const sections=[...document.querySelectorAll<HTMLElement>('.stage')]
const footerLabels=['Гортайте повільно','Ваш напрямок','Особисте — ваше','Кілька відповідей','Ви вже тут']
const visibilityWindows=[[-1,0,.12,.15],[.18,.19,.32,.34],[.41,.42,.57,.59],[.66,.67,.82,.84],[.89,.9,1,2]]
let visibleStage=-1
const smooth=(value:number):number=>{const p=Math.max(0,Math.min(1,value));return p*p*(3-2*p)}
// UI motion state. Every value is written only when it changes: this runs on each scrub frame.
const stops=[0,.25,.5,.75,1],stepsHost=document.querySelector<HTMLElement>('.stage-steps')!,stageLabel=document.querySelector<HTMLElement>('[data-stage-label]')!,stageCount=document.querySelector<HTMLElement>('[data-stage-count]')!
const presented=sections.map(()=>({opacity:'',approach:'',dir:'',settled:null as boolean|null,shown:null as boolean|null,inert:null as boolean|null}))
let journey='',labelIndex=-1
// One programmatic arrival at a time (nav, footer, CTA, keys). While a jump crosses other stops,
// the panel it leaves fades out as usual and only the destination may appear; the stops between
// stay hidden and inert until progress reaches the destination window (scrub lags Lenis, so
// Lenis' onComplete would release them too early).
// When the destination settles, focus moves to its heading (or the chat input) for keyboard users.
let arrival={target:-1,origin:-1,transit:false},arrivalTimer=0
const clearArrival=():void=>{arrival={target:-1,origin:-1,transit:false};clearTimeout(arrivalTimer)}
const coarsePointer=matchMedia('(pointer: coarse)')
const focusStage=(index:number):void=>{
  const section=sections[index];if(!section||section.inert||dialog.open)return
  // On touch, focusing the input would raise the keyboard and resize the viewport mid-arrival.
  const destination=index===4&&!coarsePointer.matches?document.querySelector<HTMLElement>('#chat-input'):section.querySelector<HTMLElement>('h1,h2')
  destination?.focus({preventScroll:true})
}
const cue=(element:HTMLElement):void=>{if(!reduced)element.animate([{opacity:0,transform:'translateY(5px)'},{opacity:1,transform:'none'}],{duration:560,easing:'cubic-bezier(.22,.8,.24,1)'})}
const updatePresentation=(progress:number):void=>{
  const index=Math.round(progress*4)
  if(arrival.transit){const [start,,,hidden]=visibilityWindows[arrival.target];if(progress>start&&progress<hidden)arrival.transit=false}
  let visible=-1
  sections.forEach((section,i)=>{
    const [start,full,end,hidden]=visibilityWindows[i],last=presented[i]
    const opacity=arrival.transit&&i!==arrival.target&&i!==arrival.origin?0:smooth((progress-start)/(full-start))*(1-smooth((progress-end)/(hidden-end)))
    const shown=opacity>.001
    // The visibility windows fade a panel in over ~1% of the scroll, too fast to read as motion.
    // The cascade instead follows how close the camera is to this stop, so the content writes
    // itself in while the camera settles and clears before the panel fades.
    const approach=smooth((.095-Math.abs(progress-stops[i]))/.08).toFixed(3)
    const dir=progress<(full+end)/2?'1':'-1',settled=opacity>.999&&approach==='1.000',inert=!shown||opacity<.2
    const value=String(opacity)
    if(value!==last.opacity){last.opacity=value;section.style.setProperty('--stage-opacity',value)}
    if(approach!==last.approach){last.approach=approach;section.style.setProperty('--approach',approach)}
    if(dir!==last.dir){last.dir=dir;section.style.setProperty('--dir',dir)}
    if(settled!==last.settled){last.settled=settled;section.classList.toggle('is-settled',settled)}
    if(shown!==last.shown){last.shown=shown;section.classList.toggle('is-active',shown);section.setAttribute('aria-hidden',String(!shown))}
    if(inert!==last.inert){last.inert=inert;section.inert=inert}
    if(shown)visible=i
    if(settled&&i===arrival.target&&!arrival.transit){clearArrival();focusStage(i)}
  })
  const fill=progress.toFixed(4);if(fill!==journey){journey=fill;stepsHost.style.setProperty('--journey',fill)}
  const visibleKey=visible<0?'none':String(visible);if(root.dataset.visibleStage!==visibleKey)root.dataset.visibleStage=visibleKey
  if(visibleStage!==visible){visibleStage=visible;chat.setActive(visible===4)}
  if(stage!==index||!root.dataset.initialized){stage=index;root.dataset.stage=String(index)}
  // A jump names its destination at once instead of flicking through the stops it crosses.
  const shownLabel=arrival.target>=0?arrival.target:index
  if(labelIndex===shownLabel)return
  const changed=labelIndex>=0
  labelIndex=shownLabel;root.dataset.initialized='true'
  stageCount.textContent=`0${shownLabel+1} / 05`
  stageLabel.textContent=footerLabels[shownLabel]
  if(changed){cue(stageLabel);cue(stageCount)}
  document.querySelectorAll<HTMLElement>('.stage-steps [data-go]').forEach((button,i)=>{button.classList.toggle('is-current',i===shownLabel);if(i===shownLabel)button.setAttribute('aria-current','step');else button.removeAttribute('aria-current')})
  document.querySelectorAll<HTMLAnchorElement>('.nav [data-go]').forEach(link=>{if(Number(link.dataset.go)===shownLabel)link.setAttribute('aria-current','location');else link.removeAttribute('aria-current')})
}
// Paper tooth for the UI sheets and the entry: one small procedural tile, made once.
// The production CSP allows blob: images (img-src 'self' blob:), unlike data: URIs.
let grainUrl=''
const makeGrain=():void=>{
  const size=160,canvas=document.createElement('canvas');canvas.width=canvas.height=size
  const context=canvas.getContext('2d');if(!context)return
  const image=context.createImageData(size,size)
  for(let i=0;i<image.data.length;i+=4){const v=Math.random(),tone=v>.5?236:4;image.data[i]=tone;image.data[i+1]=tone-4;image.data[i+2]=tone-12>0?tone-12:0;image.data[i+3]=Math.round(Math.abs(v-.5)*2*Math.random()*20)}
  context.putImageData(image,0,0)
  canvas.toBlob(blob=>{if(!blob||disposed)return;grainUrl=URL.createObjectURL(blob);root.style.setProperty('--grain',`url("${grainUrl}")`)})
}
makeGrain()
updatePresentation(0)
const tween=gsap.to(state,{p:1,ease:'none',duration:1,paused:true,onUpdate:()=>updatePresentation(state.p)})
// Numeric document bounds avoid an early body-margin measurement before the font/CSS paint.
const trigger=ScrollTrigger.create({trigger:'#scroll-wrapper',start:0,end:()=>Math.max(1,document.querySelector<HTMLElement>('#scroll-wrapper')!.offsetHeight-innerHeight),invalidateOnRefresh:true,animation:tween,scrub:reduced?.35:1.2,snap:reduced?undefined:{snapTo:[0,.25,.5,.75,1],duration:{min:.4,max:.85},delay:.05,ease:'power2.inOut',inertia:false}})
let layoutFrame=0
// svh can settle a frame after the browser's resize event. Observe the actual scroll surface.
const layoutObserver=new ResizeObserver(()=>{cancelAnimationFrame(layoutFrame);layoutFrame=requestAnimationFrame(()=>{reserveFaq();lenis.resize();trigger.refresh()})})
layoutObserver.observe(document.querySelector('#scroll-wrapper')!)
const lenisScroll=():void=>{currentVelocity=lenis.velocity;ScrollTrigger.update()};lenis.on('scroll',lenisScroll)
const tick=(time:number):void=>{lenis.raf(time*1000);currentVelocity=lenis.velocity;scene?.setProgress(state.p,currentVelocity)}
gsap.ticker.add(tick)
const mobileNav=document.querySelector<HTMLElement>('#mobile-nav')!,menu=document.querySelector<HTMLButtonElement>('.menu-toggle')!
const setMenu=(open:boolean):void=>{mobileNav.hidden=!open;menu.setAttribute('aria-expanded',String(open));menu.setAttribute('aria-label',open?'Закрити навігацію':'Відкрити навігацію')}
const go=(index:number):void=>{
  const target=Math.max(0,Math.min(4,index));setMenu(false)
  if(target===4)chat.prefill(selectedDirection===0?0:selectedDirection===1?2:0)
  const max=document.documentElement.scrollHeight-innerHeight,duration=reduced?.4:target===4?2.2:1.4
  // More than one leg away means the camera crosses other stops on the way.
  const origin=visibleStage;clearArrival();arrival={target,origin,transit:Math.abs(target-state.p*4)>1.02}
  // Safety net: a stalled or interrupted scroll never leaves panels hidden for long.
  arrivalTimer=window.setTimeout(()=>{if(arrival.target!==target)return;clearArrival();updatePresentation(state.p)},(duration+3.5)*1000)
  lenis.scrollTo(max*target/4,{duration,easing:t=>1-Math.pow(1-t,3),force:true})
  updatePresentation(state.p)
}
// The visitor takes over (wheel or touch): stop holding panels and moving focus.
const interrupt=():void=>{if(arrival.target<0)return;clearArrival();updatePresentation(state.p)}
window.addEventListener('wheel',interrupt,{passive:true});window.addEventListener('touchstart',interrupt,{passive:true})
const navigate=(event:MouseEvent):void=>{const button=(event.target as Element).closest<HTMLElement>('[data-go]');if(!button)return;event.preventDefault();go(Number(button.dataset.go))};document.addEventListener('click',navigate)
const next=():void=>go(stage===4?0:stage+1);document.querySelector('[data-next]')!.addEventListener('click',next)
const toggleMenu=():void=>setMenu(Boolean(mobileNav.hidden));menu.addEventListener('click',toggleMenu)
const pointer=(event:PointerEvent):void=>scene?.setPointer(event.clientX/innerWidth*2-1,1-event.clientY/innerHeight*2);window.addEventListener('pointermove',pointer,{passive:true})
const directionButtons=[...document.querySelectorAll<HTMLButtonElement>('[data-direction]')],directionStatus=['Можемо почати з того, як минув ваш день.','Сповільнімося й помітимо, що відчувається зараз.','Поговорімо про те, якої підтримки вам бракує.']
const selectDirection=(index:number):void=>{
  selectedDirection=index;directionButtons.forEach((button,i)=>{button.setAttribute('aria-selected',String(i===index));button.tabIndex=i===index?0:-1;button.classList.toggle('is-selected',i===index)})
  document.querySelector('.direction-status')!.textContent=directionStatus[index];document.querySelector('#direction-detail')!.setAttribute('aria-labelledby',`direction-${index}`);scene?.turnPage()
}
directionButtons.forEach((button,index)=>{
  const click=():void=>selectDirection(index),key=(event:KeyboardEvent):void=>{if(!['ArrowRight','ArrowLeft','ArrowDown','ArrowUp','Home','End'].includes(event.key))return;event.preventDefault();event.stopPropagation();const next=event.key==='Home'?0:event.key==='End'?2:(index+(['ArrowRight','ArrowDown'].includes(event.key)?1:2))%3;selectDirection(next);directionButtons[next].focus()}
  button.addEventListener('click',click);button.addEventListener('keydown',key);cleanup.push(()=>{button.removeEventListener('click',click);button.removeEventListener('keydown',key)})
})
const faqButtons=[...document.querySelectorAll<HTMLButtonElement>('[data-lantern]')],faqPanel=document.querySelector<HTMLElement>('.faq-panel')!
const answers=faqButtons.map((_,i)=>document.querySelector<HTMLElement>(`#answer-${i}`)!),answerTimers=answers.map(()=>0)
// An answer opens by growing its row (CSS @starting-style) and closes the same way before it is
// hidden; it is inert while it folds. With reduced motion it toggles at once.
const setAnswer=(i:number,open:boolean):void=>{
  const region=answers[i];clearTimeout(answerTimers[i])
  if(open){region.classList.remove('is-closing');region.inert=false;region.hidden=false;return}
  if(region.hidden)return
  if(reduced){region.classList.remove('is-closing');region.inert=false;region.hidden=true;return}
  region.classList.add('is-closing');region.inert=true
  answerTimers[i]=window.setTimeout(()=>{region.hidden=true;region.inert=false;region.classList.remove('is-closing')},460)
}
const selectLantern=(index:number):void=>{
  selectedLantern=index===selectedLantern?-1:index
  faqButtons.forEach((button,i)=>{const open=i===selectedLantern;button.setAttribute('aria-expanded',String(open));setAnswer(i,open)});scene?.selectLantern(selectedLantern)
}
// Phone sheets are docked to the bottom. The FAQ sheet keeps room for its tallest answer, so an
// opening answer grows into reserved space instead of lifting the question under the finger. On
// short phones (<=700px) that room would bury the lanterns, so there the sheet simply grows upwards.
const sheetQuery=matchMedia('(max-width: 760px) and (min-height: 701px)')
const reserveFaq=():void=>{
  faqPanel.style.removeProperty('min-height')
  if(!sheetQuery.matches)return
  faqPanel.classList.add('is-measuring')
  const heights=answers.map(region=>region.getBoundingClientRect().height),all=faqPanel.getBoundingClientRect().height
  faqPanel.classList.remove('is-measuring')
  faqPanel.style.minHeight=`${Math.ceil(all-heights.reduce((sum,h)=>sum+h,0)+Math.max(...heights))}px`
}
reserveFaq()
faqButtons.forEach((button,index)=>{const click=():void=>selectLantern(index);button.addEventListener('click',click);cleanup.push(()=>button.removeEventListener('click',click))})
let returnFocus:HTMLElement|null=null
const openHelp=():void=>{returnFocus=document.activeElement as HTMLElement;dialog.showModal();lenis.stop();dialog.querySelector<HTMLButtonElement>('.dialog-close')!.focus()}
const closeHelp=():void=>dialog.close()
const onClose=():void=>{lenis.start();returnFocus?.focus({preventScroll:true})}
const backdrop=(event:MouseEvent):void=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close()}}
document.querySelector('[data-help]')!.addEventListener('click',openHelp);dialog.querySelector('.dialog-close')!.addEventListener('click',closeHelp);dialog.addEventListener('close',onClose);dialog.addEventListener('click',backdrop)
const keyboard=(event:KeyboardEvent):void=>{
  if(event.key==='Escape'){if(!mobileNav.hidden){setMenu(false);menu.focus()}return}
  if(dialog.open||event.target instanceof Element&&event.target.closest('input,textarea,[contenteditable],#chat-messages,.notes-panel,[role=tablist],summary'))return
  if(['ArrowDown','PageDown','ArrowUp','PageUp','Home','End'].includes(event.key)){
    event.preventDefault();go(event.key==='Home'?0:event.key==='End'?4:stage+(['ArrowDown','PageDown'].includes(event.key)?1:-1))
  }
};window.addEventListener('keydown',keyboard)
const motion=():void=>{reduced=reducedQuery.matches;scene?.setReduced(reduced);lenis.options.smoothWheel=!reduced;trigger.vars.scrub=reduced?.35:1.2;trigger.vars.snap=reduced?undefined:{snapTo:[0,.25,.5,.75,1],duration:{min:.4,max:.85},delay:.05,ease:'power2.inOut',inertia:false};trigger.refresh()};reducedQuery.addEventListener('change',motion)
let loading=false
const startScene=async():Promise<void>=>{
  if(loading||disposed)return;loading=true;const generation=++sceneGeneration
  scene?.dispose();scene=undefined;host.replaceChildren();host.classList.remove('fallback-scene');notice.hidden=true
  try{
    const {createSanctuary}=await import('./gl/scene')
    if(disposed||generation!==sceneGeneration)return
    const created=await createSanctuary(host,selectLantern,()=>{root.dataset.webgl='fallback';notice.hidden=false;host.classList.add('fallback-scene');notify('3D-простір призупинено. Можна продовжити розмову або перезапустити 3D.')})
    if(disposed||generation!==sceneGeneration){created.dispose();return}
    scene=created;scene.setProgress(state.p,currentVelocity);scene.setReduced(reduced);scene.selectLantern(selectedLantern);scene.setTalking(sceneTalking);scene.setVoice(sceneVolume)
    // Commit the canvas' hidden start style first, so data-webgl=ready fades it in (CSS).
    const canvas=host.querySelector('canvas');if(canvas)void getComputedStyle(canvas).opacity
    root.dataset.webgl='ready'
    root.dataset.avatar='loading'
    void scene.loadCompanion('/models/companion.glb').then(ok=>{if(disposed||generation!==sceneGeneration)return;root.dataset.avatar=ok?'ready':'fallback';if(!ok)notify('Не вдалося завантажити вашу модель. Тимчасово доступний резервний компаньйон.')})
  }catch(error){root.dataset.webgl='fallback';host.classList.add('fallback-scene');notice.hidden=false;console.warn('Liora 3D fallback:',error instanceof Error?error.message:'WebGL unavailable')}
  finally{loading=false;if(!disposed)revealEntry()}
}
// The words never wait for WebGL: the hero writes itself in as soon as its font is ready (or after
// 600 ms at most). The entry only covers the canvas, and opens like an iris once the island exists.
let introTimer=0
const playIntro=():void=>{clearTimeout(introTimer);if(!root.dataset.intro)root.dataset.intro='play'}
introTimer=window.setTimeout(playIntro,600)
function revealEntry():void{
  if(!entry.isConnected||entry.classList.contains('is-ready'))return
  playIntro();root.dataset.revealed='true';entry.classList.add('is-ready')
  window.setTimeout(()=>entry.remove(),reduced?120:1500)
}
const retry=():void=>{void startScene()};document.querySelector('[data-retry]')!.addEventListener('click',retry)
void startScene()
void document.fonts.ready.then(()=>{if(disposed)return;playIntro();reserveFaq();ScrollTrigger.refresh()})
if(import.meta.env.DEV){
  Object.defineProperty(window,'sanctuary',{configurable:true,value:{go,progress:()=>state.p,inspect:()=>scene?.inspect(),motion:()=>scene?.motion(),scrollInfo:()=>({start:trigger.start,end:trigger.end,y:scrollY,top:document.querySelector('#scroll-wrapper')!.getBoundingClientRect().top+scrollY,margin:getComputedStyle(document.body).margin}),selectDirection,selectLantern,lenis,setProgress:(value:number)=>{clearArrival();lenis.scrollTo((document.documentElement.scrollHeight-innerHeight)*value,{immediate:true,force:true});state.p=value;scene?.setProgress(value,0);updatePresentation(value)}}})
}
const dispose=():void=>{
  if(disposed)return;disposed=true;sceneGeneration++;clearTimeout(toastTimer);clearArrival();clearTimeout(introTimer);answerTimers.forEach(timer=>clearTimeout(timer));window.removeEventListener('wheel',interrupt);window.removeEventListener('touchstart',interrupt);if(grainUrl){URL.revokeObjectURL(grainUrl);root.style.removeProperty('--grain')};cancelAnimationFrame(layoutFrame);layoutObserver.disconnect();scene?.dispose();chat.dispose();soundDispose();gsap.ticker.remove(tick);trigger.kill();tween.kill();lenis.off('scroll',lenisScroll);lenis.destroy();cleanup.forEach(remove=>remove());document.removeEventListener('click',navigate);document.querySelector('[data-next]')!.removeEventListener('click',next);menu.removeEventListener('click',toggleMenu);window.removeEventListener('pointermove',pointer);window.removeEventListener('keydown',keyboard);reducedQuery.removeEventListener('change',motion);document.querySelector('[data-help]')!.removeEventListener('click',openHelp);dialog.querySelector('.dialog-close')!.removeEventListener('click',closeHelp);dialog.removeEventListener('close',onClose);dialog.removeEventListener('click',backdrop);document.querySelector('[data-retry]')!.removeEventListener('click',retry)
}
window.addEventListener('pagehide',event=>{if(!event.persisted)dispose()})
if(import.meta.hot)import.meta.hot.dispose(dispose)
