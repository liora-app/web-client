import { setupVoice } from './voice'

export const starters=['Мені хочеться просто виговоритися і розібрати думки вголос…','Сьогодні сталася ситуація, яка не виходить у мене з голови…','Відчуваю сильне перевантаження і хочу трохи сповільнитися…']

function answer(text:string,turn:number):string {
  const value=text.toLocaleLowerCase('uk-UA')
  if(/не знаю|не розумію/.test(value))return 'Не обов’язково одразу знаходити точні слова. Якщо прислухатися до себе зараз — це більше втома, напруга, сум чи щось інше?'
  if(/перевантаж|спок|тривож|напруг|страш|страх/.test(value))return 'Схоже, зараз на вас припало багато. Можемо розбирати це маленькими частинами, у вашому темпі. Що найбільше забирає сили саме цієї миті?'
  if(/ситуац|сталася|робот|свар|конфлікт/.test(value))return 'Дякую, що поділилися. Пропоную спочатку відділити те, що сталося, від того, що ви про це подумали. Який момент у цій ситуації зачепив вас найбільше?'
  if(/втом|важко|сум|самот/.test(value))return 'Ці почуття заслуговують на увагу. Вам зараз більше хочеться, щоб вас просто вислухали, чи разом поміркувати, яка маленька підтримка була б доречною?'
  if(/дякую|легше|добре/.test(value))return 'Можна трохи побути з цим відчуттям. Що з нашої розмови ви хотіли б залишити собі як нагадування?'
  const replies=['Я чую вас. Що в цьому для вас найважливіше — і що хотілося б зрозуміти про себе краще?','Якби ви могли поставитися до себе зараз трохи добріше, що б ви собі сказали?','Спробуймо поглянути на це без поспіху. На що ви можете вплинути, а що поки варто просто помітити?']
  return replies[turn%replies.length]
}

export interface ChatController {prefill:(index:number)=>void;setActive:(active:boolean)=>void;dispose:()=>void}

export function setupChat(onTalking:(value:boolean)=>void,onVoice:(value:number)=>void,notify:(text:string)=>void):ChatController {
  const form=document.querySelector<HTMLFormElement>('.composer')!,input=document.querySelector<HTMLInputElement>('#chat-input')!,send=document.querySelector<HTMLButtonElement>('.send')!,messages=document.querySelector<HTMLElement>('#chat-messages')!,privacy=document.querySelector<HTMLInputElement>('#private-mode')!,notesPanel=document.querySelector<HTMLElement>('#notes-panel')!,notesHost=document.querySelector<HTMLElement>('[data-notes]')!,notesToggle=document.querySelector<HTMLButtonElement>('.notes-toggle')!,noteCount=document.querySelector<HTMLElement>('[data-note-count]')!
  let busy=false,disposed=false,turn=0,timer=0,active=false
  const listeners: (()=>void)[]=[]
  const sync=():void=>{send.disabled=busy||input.value.trim().length===0}
  input.addEventListener('input',sync)
  function prefill(index:number):void {input.value=starters[Math.max(0,Math.min(2,index))];sync();if(active)input.focus({preventScroll:true})}
  const chips=document.querySelectorAll<HTMLButtonElement>('[data-scenario]')
  chips.forEach(button=>{const click=():void=>prefill(Number(button.dataset.scenario));button.addEventListener('click',click);listeners.push(()=>button.removeEventListener('click',click))})
  // iOS zooms into a field under 16px, so phones type at 16px (style.css): there the long placeholder would be cut off.
  const narrow=matchMedia('(max-width: 400px)'),placeholder=():void=>{input.placeholder=narrow.matches?'Напишіть думку…':'Пишіть так, як думаєте…'}
  placeholder();narrow.addEventListener('change',placeholder)
  const scroll=():void=>{messages.scrollTop=messages.scrollHeight}
  // `typed`: a reply that types itself in. The typed copy, rewritten on every step, stays out of the accessibility tree;
  // the whole reply joins the log as one sr-only addition once typing ends (type(), below).
  const add=(role:'user'|'assistant',text:string,typed=false):{article:HTMLElement;body:HTMLElement}=>{
    messages.querySelector('.chat-welcome')?.remove()
    // All content, including adversarial input and generated replies, enters as text nodes.
    const article=document.createElement('article');article.className=`message message--${role}`
    const author=document.createElement('span');author.className='message__author';author.textContent=role==='user'?'Ви':'Liora · демовідповідь'
    const body=document.createElement('p');body.className='message__text';body.textContent=text;article.append(author,body)
    if(typed)body.setAttribute('aria-hidden','true')
    messages.append(article)
    while(messages.children.length>60)messages.firstElementChild?.remove()
    scroll();return {article,body}
  }
  const updateNotes=():void=>{noteCount.textContent=String(notesHost.children.length)}
  const save=(text:string,button:HTMLButtonElement):void=>{
    if(privacy.checked){notify('Щоб обрати тезу, вимкніть «Не зберігати цю розмову». Вона залишиться лише в пам’яті цієї вкладки.');return}
    if(notesHost.children.length>=20){notify('Можна залишити до 20 тез. Видаліть зайву перед додаванням нової.');return}
    const note=document.createElement('div');note.className='note';const edit=document.createElement('textarea');edit.value=text;edit.maxLength=500;edit.setAttribute('aria-label','Відредагуйте важливу тезу');const remove=document.createElement('button');remove.textContent='Видалити тезу';remove.type='button';remove.addEventListener('click',()=>{note.remove();button.disabled=false;button.textContent='Залишити важливе +';updateNotes()});note.append(edit,remove);notesHost.append(note);button.disabled=true;button.textContent='Залишено ✓';updateNotes();notify('Тезу додано. Її можна відредагувати в «Важливе».')
  }
  const submit=(event:SubmitEvent):void=>{
    event.preventDefault();const text=input.value.trim().slice(0,500)
    if(!text||busy||disposed)return
    busy=true;input.value='';sync();add('user',text);onTalking(true)
    const reply=answer(text,turn++),{article,body}=add('assistant','…',true);messages.setAttribute('aria-busy','true')
    const began=performance.now()+350
    let offset=0
    const type=():void=>{
      if(disposed)return
      offset=matchMedia('(prefers-reduced-motion: reduce)').matches?reply.length:Math.min(reply.length,Math.max(1,Math.floor((performance.now()-began)*.07)));body.textContent=reply.slice(0,offset);scroll()
      if(offset<reply.length){timer=window.setTimeout(type,20);return}
      busy=false;onTalking(false);messages.removeAttribute('aria-busy');sync()
      // The full reply is added only now, in the task that clears aria-busy: a node added while the log is busy raises no
      // live-region event (Chromium), and clearing the flag does not replay it, so an earlier copy would go unspoken.
      const full=document.createElement('span');full.className='sr-only';full.textContent=reply
      // In private mode (the default) the button is hidden (style.css) and the last reply says how to keep a point instead;
      // the hint is visual only: the switch itself carries the same fact for screen readers (aria-describedby).
      const button=document.createElement('button');button.className='save-note';button.textContent='Залишити важливе +';button.type='button';button.addEventListener('click',()=>save(reply,button))
      const hint=document.createElement('p');hint.className='save-hint';hint.setAttribute('aria-hidden','true');hint.textContent='Щоб залишити тезу, вимкніть «Не зберігати цю розмову».'
      article.append(full,button,hint);scroll()
    }
    timer=window.setTimeout(type,350)
  }
  form.addEventListener('submit',submit)
  const toggleNotes=():void=>{notesPanel.hidden=!notesPanel.hidden;notesToggle.setAttribute('aria-expanded',String(!notesPanel.hidden))};notesToggle.addEventListener('click',toggleNotes)
  const privateChange=():void=>{if(privacy.checked){notesHost.replaceChildren();messages.querySelectorAll<HTMLButtonElement>('.save-note').forEach(b=>{b.disabled=false;b.textContent='Залишити важливе +'});updateNotes();notesPanel.hidden=true;notesToggle.setAttribute('aria-expanded','false')}};privacy.addEventListener('change',privateChange)
  const microphone=document.querySelector<HTMLButtonElement>('.microphone')!
  let disposeVoice=setupVoice(microphone,input,onVoice,notify)
  return {prefill,setActive(value){if(active&&!value){disposeVoice();disposeVoice=setupVoice(microphone,input,onVoice,notify)}active=value},dispose(){disposed=true;clearTimeout(timer);onTalking(false);disposeVoice();narrow.removeEventListener('change',placeholder);input.removeEventListener('input',sync);form.removeEventListener('submit',submit);notesToggle.removeEventListener('click',toggleNotes);privacy.removeEventListener('change',privateChange);listeners.forEach(remove=>remove())}}
}
