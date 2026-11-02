export const starters=['Мені хочеться просто виговоритися і розібрати думки вголос…','Сьогодні сталася ситуація, яка не виходить у мене з голови…','Відчуваю сильне перевантаження і хочу трохи сповільнитися…']

export interface ChatController {prefill:(index:number)=>void;setActive:(active:boolean)=>void;dispose:()=>void}

// No replies, no microphone (ADR-015 step 0, devops#61): canned replies cannot recognise a crisis, so every message gets the
// same fixed notice that nobody answers here, with a way to the help dialog. The real chat replaces this demo later.
export function setupChat(notify:(text:string)=>void,onHelp:()=>void):ChatController {
  const form=document.querySelector<HTMLFormElement>('.composer')!,input=document.querySelector<HTMLInputElement>('#chat-input')!,send=document.querySelector<HTMLButtonElement>('.send')!,messages=document.querySelector<HTMLElement>('#chat-messages')!,privacy=document.querySelector<HTMLInputElement>('#private-mode')!,notesPanel=document.querySelector<HTMLElement>('#notes-panel')!,notesHost=document.querySelector<HTMLElement>('[data-notes]')!,notesToggle=document.querySelector<HTMLButtonElement>('.notes-toggle')!,noteCount=document.querySelector<HTMLElement>('[data-note-count]')!
  let disposed=false,active=false,notice:HTMLElement|undefined
  const listeners: (()=>void)[]=[]
  const sync=():void=>{send.disabled=input.value.trim().length===0}
  input.addEventListener('input',sync)
  function prefill(index:number):void {input.value=starters[Math.max(0,Math.min(2,index))];sync();if(active)input.focus({preventScroll:true})}
  const chips=document.querySelectorAll<HTMLButtonElement>('[data-scenario]')
  chips.forEach(button=>{const click=():void=>prefill(Number(button.dataset.scenario));button.addEventListener('click',click);listeners.push(()=>button.removeEventListener('click',click))})
  // iOS zooms into a field under 16px, so phones type at 16px (style.css): there the long placeholder would be cut off.
  const narrow=matchMedia('(max-width: 400px)'),placeholder=():void=>{input.placeholder=narrow.matches?'Напишіть думку…':'Пишіть так, як думаєте…'}
  placeholder();narrow.addEventListener('change',placeholder)
  const scroll=():void=>{messages.scrollTop=messages.scrollHeight}
  const trim=():void=>{while(messages.children.length>60)messages.firstElementChild?.remove()}
  const add=(text:string):HTMLElement=>{
    messages.querySelector('.chat-welcome')?.remove()
    // All content, including adversarial input, enters as text nodes.
    const article=document.createElement('article');article.className='message message--user'
    const author=document.createElement('span');author.className='message__author';author.textContent='Ви'
    const body=document.createElement('p');body.className='message__text';body.textContent=text;article.append(author,body)
    messages.append(article);trim();scroll();return article
  }
  // One notice, always last. A new node on every message: Chromium does not announce a node that only moves within the
  // same live region, while a new one is an addition; removing the old one is not announced (aria-relevant=additions).
  const showNotice=():void=>{
    notice?.remove()
    notice=document.createElement('article');notice.className='message message--notice'
    const author=document.createElement('span');author.className='message__author';author.textContent='Демо · не AI'
    const body=document.createElement('p');body.className='message__text';body.textContent='Тут поки ніхто не відповідає й не читає повідомлень. Якщо зараз важко, не лишайтеся з цим наодинці.'
    const help=document.createElement('button');help.className='notice-help';help.type='button';help.textContent='Куди звернутися →';help.addEventListener('click',onHelp)
    notice.append(author,body,help);messages.append(notice);trim();scroll()
    // A log shorter than the notice (80px on short phones, style.css) shows its start, not just the button.
    if(notice.offsetHeight>messages.clientHeight)messages.scrollTop+=notice.getBoundingClientRect().top-messages.getBoundingClientRect().top
  }
  const updateNotes=():void=>{noteCount.textContent=String(notesHost.children.length)}
  const save=(text:string,button:HTMLButtonElement):void=>{
    if(privacy.checked){notify('Щоб обрати тезу, вимкніть «Не зберігати цю розмову». Вона залишиться лише в пам’яті цієї вкладки.');return}
    if(notesHost.children.length>=20){notify('Можна залишити до 20 тез. Видаліть зайву перед додаванням нової.');return}
    const note=document.createElement('div');note.className='note';const edit=document.createElement('textarea');edit.value=text;edit.maxLength=500;edit.setAttribute('aria-label','Відредагуйте важливу тезу');const remove=document.createElement('button');remove.textContent='Видалити тезу';remove.type='button';remove.addEventListener('click',()=>{note.remove();button.disabled=false;button.textContent='Залишити важливе +';updateNotes()});note.append(edit,remove);notesHost.append(note);button.disabled=true;button.textContent='Залишено ✓';updateNotes();notify('Тезу додано. Її можна відредагувати в «Важливе».')
  }
  const submit=(event:SubmitEvent):void=>{
    event.preventDefault();const text=input.value.trim().slice(0,500)
    if(!text||disposed)return
    input.value='';sync();const article=add(text)
    // A point to keep is the person's own words. In private mode (the default) the button is hidden (style.css) and the
    // latest message says how to keep a point instead; the hint is visual only: the switch itself carries the same fact
    // for screen readers (aria-describedby).
    const button=document.createElement('button');button.className='save-note';button.textContent='Залишити важливе +';button.type='button';button.addEventListener('click',()=>save(text,button))
    const hint=document.createElement('p');hint.className='save-hint';hint.setAttribute('aria-hidden','true');hint.textContent='Щоб залишити тезу, вимкніть «Не зберігати цю розмову».'
    article.append(button,hint);showNotice()
  }
  form.addEventListener('submit',submit)
  const toggleNotes=():void=>{notesPanel.hidden=!notesPanel.hidden;notesToggle.setAttribute('aria-expanded',String(!notesPanel.hidden))};notesToggle.addEventListener('click',toggleNotes)
  const privateChange=():void=>{if(privacy.checked){notesHost.replaceChildren();messages.querySelectorAll<HTMLButtonElement>('.save-note').forEach(b=>{b.disabled=false;b.textContent='Залишити важливе +'});updateNotes();notesPanel.hidden=true;notesToggle.setAttribute('aria-expanded','false')}};privacy.addEventListener('change',privateChange)
  return {prefill,setActive(value){active=value},dispose(){disposed=true;narrow.removeEventListener('change',placeholder);input.removeEventListener('input',sync);form.removeEventListener('submit',submit);notesToggle.removeEventListener('click',toggleNotes);privacy.removeEventListener('change',privateChange);listeners.forEach(remove=>remove())}}
}
