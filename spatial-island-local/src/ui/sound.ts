export function setupSound(button:HTMLButtonElement,notify:(text:string)=>void):()=>void {
  let context:AudioContext|undefined,gain:GainNode|undefined,playing=false,disposed=false,frame=0,time=0
  const oscillators:OscillatorNode[]=[],path=button.querySelector('path')!,still=matchMedia('(prefers-reduced-motion: reduce)')
  // With reduced motion the wave is drawn once, in its playing shape, instead of rolling on every frame.
  const update=():void=>{if(!still.matches)time+=.04;const amount=playing?3.2:0;let d='M2 12';for(let x=3;x<=70;x+=2)d+=` L${x} ${12+Math.sin(x*.11+time)*Math.sin(x/72*Math.PI)*amount}`;path.setAttribute('d',d);if(playing&&!still.matches)frame=requestAnimationFrame(update)}
  const motion=():void=>{cancelAnimationFrame(frame);update()};still.addEventListener('change',motion)
  const click=async():Promise<void>=>{
    try{
      if(!context){context=new AudioContext();gain=context.createGain();gain.gain.value=0;const filter=context.createBiquadFilter();filter.type='lowpass';filter.frequency.value=700;filter.connect(gain).connect(context.destination)
        for(const [i,f] of [110,164.81,220,329.63].entries()){const oscillator=context.createOscillator();oscillator.type='sine';oscillator.frequency.value=f*(1+i*.0006);oscillator.connect(filter);oscillator.start();oscillators.push(oscillator)}
      }
      await context.resume();if(disposed)return;playing=!playing;button.setAttribute('aria-pressed',String(playing));button.setAttribute('aria-label',playing?'Вимкнути фоновий звук':'Увімкнути фоновий звук');gain!.gain.cancelScheduledValues(context.currentTime);gain!.gain.setTargetAtTime(playing?.013:0,context.currentTime,.6);cancelAnimationFrame(frame);update()
    }catch{notify('Звук зараз недоступний. Простір працює без аудіо.')}
  }
  const handler=():void=>{void click()};button.addEventListener('click',handler)
  const visibility=():void=>{if(document.hidden){cancelAnimationFrame(frame);void context?.suspend()}else if(playing){void context?.resume();cancelAnimationFrame(frame);update()}};document.addEventListener('visibilitychange',visibility)
  return ()=>{disposed=true;cancelAnimationFrame(frame);button.removeEventListener('click',handler);document.removeEventListener('visibilitychange',visibility);still.removeEventListener('change',motion);oscillators.forEach(o=>{o.stop();o.disconnect()});gain?.disconnect();void context?.close().catch(()=>undefined)}
}
