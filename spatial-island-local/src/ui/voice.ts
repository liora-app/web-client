interface SpeechResult {isFinal:boolean;0:{transcript:string}}
interface SpeechEvent extends Event {resultIndex:number;results:{length:number;[index:number]:SpeechResult}}
interface SpeechError extends Event {error:string}
interface Recognition extends EventTarget {
  lang:string;continuous:boolean;interimResults:boolean
  start:()=>void;stop:()=>void;abort:()=>void
  onresult:((event:SpeechEvent)=>void)|null
  onerror:((event:SpeechError)=>void)|null
  onend:(()=>void)|null
}
type RecognitionConstructor=new()=>Recognition

export function setupVoice(button:HTMLButtonElement,input:HTMLInputElement,onVolume:(n:number)=>void,notify:(text:string)=>void):()=>void {
  const speechWindow=window as typeof window&{SpeechRecognition?:RecognitionConstructor;webkitSpeechRecognition?:RecognitionConstructor}
  const Constructor=speechWindow.SpeechRecognition??speechWindow.webkitSpeechRecognition
  let recognition:Recognition|undefined,stream:MediaStream|undefined,context:AudioContext|undefined,source:MediaStreamAudioSourceNode|undefined,analyser:AnalyserNode|undefined,frame=0,active=false,disposed=false,request=0
  const baseError='Мікрофон недоступний або доступ заборонено в налаштуваннях браузера. Ви можете продовжити розмову текстом.'
  const stop=():void=>{
    request++;active=false;button.setAttribute('aria-pressed','false');button.setAttribute('aria-label','Увімкнути голосове введення');cancelAnimationFrame(frame);onVolume(0)
    if(recognition){recognition.onend=null;recognition.onerror=null;recognition.onresult=null;recognition.abort();recognition=undefined}
    stream?.getTracks().forEach(t=>t.stop());stream=undefined;source?.disconnect();source=undefined;analyser?.disconnect();analyser=undefined
    if(context){void context.close().catch(()=>undefined);context=undefined}
  }
  const start=async():Promise<void>=>{
    if(active){stop();return}
    if(!Constructor||!navigator.mediaDevices?.getUserMedia){notify('Цей браузер не підтримує голосове введення. Ви можете продовжити розмову текстом.');return}
    const token=++request;active=true;button.setAttribute('aria-pressed','true');button.setAttribute('aria-label','Вимкнути голосове введення')
    try{
      const nextStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false})
      if(disposed||token!==request){nextStream.getTracks().forEach(t=>t.stop());return}
      stream=nextStream;const micContext=new AudioContext();context=micContext;await micContext.resume()
      if(disposed||token!==request){nextStream.getTracks().forEach(t=>t.stop());void micContext.close().catch(()=>undefined);return}
      analyser=context.createAnalyser();analyser.fftSize=256;source=context.createMediaStreamSource(stream);source.connect(analyser)
      const data=new Uint8Array(analyser.frequencyBinCount)
      const analyse=():void=>{if(!active||!analyser)return;analyser.getByteFrequencyData(data);let sum=0;for(const value of data)sum+=value;onVolume(Math.min(1,sum/data.length/80));frame=requestAnimationFrame(analyse)}
      analyse();recognition=new Constructor();recognition.lang='uk-UA';recognition.continuous=true;recognition.interimResults=true
      const original=input.value.trim()
      let committed=''
      recognition.onresult=(event)=>{
        let interim=''
        for(let i=event.resultIndex;i<event.results.length;i++){const result=event.results[i];if(result.isFinal)committed+=result[0].transcript+' ';else interim+=result[0].transcript}
        input.value=[original,committed,interim].filter(Boolean).join(' ').trim().slice(0,500);input.dispatchEvent(new Event('input',{bubbles:true}))
      }
      recognition.onerror=(event)=>{const error=event.error;stop();if(error==='aborted')return;notify(error==='no-speech'?'Не вдалося почути голос. Спробуйте ще раз або напишіть повідомлення.':error==='network'?'Сервіс розпізнавання голосу недоступний. Продовжте розмову текстом.':baseError)}
      recognition.onend=stop;recognition.start()
      notify('Голосове введення увімкнено. Розпізнавання може використовувати сервіс браузера; аудіо на сервер Liora не надсилається.')
    }catch(error){if(token!==request||disposed)return;stop();notify(error instanceof DOMException&&error.name==='NotAllowedError'?baseError:'Не вдалося увімкнути мікрофон. Спробуйте ще раз або продовжте текстом.')}
  }
  const click=():void=>{void start()};button.addEventListener('click',click)
  const visibility=():void=>{if(document.hidden)stop()};document.addEventListener('visibilitychange',visibility)
  return ()=>{disposed=true;stop();button.removeEventListener('click',click);document.removeEventListener('visibilitychange',visibility)}
}
