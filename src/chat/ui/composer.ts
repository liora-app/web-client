// The message field (spec §3.7.3). No <form>, no maxlength (it would cut a pasted text silently).
// - Lengths in code points, the way the server counts them.
// - pointer: fine — Enter sends, Shift+Enter is a new line; pointer: coarse — Enter is a new line and
//   only the button sends; Ctrl/Cmd+Enter always sends; never during IME composition.
// - The button keeps the focus in the field on touch (pointerdown → preventDefault).
// - A pill: «Інструменти» on the left and «Надіслати» / «Зупинити» on the right sit inside the field;
//   the field grows with its text (field-sizing: content, the scrollHeight fallback below).

import { CONTENT_COUNTER_FROM, MAX_CONTENT, codePoints } from '../core/limits'
import { SAY_ALREADY, SAY_INSERTED, counter } from './copy'
import { byEl, finePointer, setAttr, setText, show } from './dom'

export type ComposerMode = 'send' | 'stop'

export type Composer = Readonly<{
  value(): string
  clear(): void
  put(text: string): void
  /** A starter's words: into the field (after what is there), the caret at the end. The focus goes
   *  there on a fine pointer only — on a phone it would pop the keyboard over the page, so there the
   *  live region says where the words went (WCAG 4.1.3). Words the field already ends with are not
   *  put twice. */
  insert(text: string): void
  focus(): void
  setPlaceholder(text: string): void
  /** send: «Надіслати» (aria-disabled while empty or blocked); stop: «Зупинити відповідь». */
  setMode(mode: ComposerMode, blocked: boolean): void
  element: HTMLElement
}>

export function createComposer(
  root: HTMLElement,
  onSend: () => void,
  onStop: () => void,
  onType: () => void = () => {},
  say: (text: string) => void = () => {},
): Composer {
  const input = root.querySelector<HTMLTextAreaElement>('textarea')!
  const button = byEl<HTMLButtonElement>('composer-send', root)
  const count = byEl('composer-count', root)
  const keys = root.querySelector<HTMLElement>('.composer__keys')!
  let mode: ComposerMode = 'send'
  let blocked = false
  const autoSize = !CSS.supports('field-sizing', 'content')

  const grow = (): void => {
    if (!autoSize) return
    input.style.setProperty('height', 'auto')
    input.style.setProperty('height', `${input.scrollHeight + 2}px`)
  }

  const refresh = (): void => {
    const text = input.value
    const length = codePoints(text)
    const over = length > MAX_CONTENT
    show(count, length >= CONTENT_COUNTER_FROM)
    setText(count, length >= CONTENT_COUNTER_FROM ? counter(length, MAX_CONTENT) : '')
    count.classList.toggle('composer__count--over', over)
    if (mode === 'stop') {
      setAttr(button, 'aria-label', 'Зупинити відповідь')
      setAttr(button, 'aria-disabled', null)
      button.dataset.mode = 'stop'
      return
    }
    // Over 4000 code points it is as inactive as it looks (§3.7.3); a press still reaches onSend and
    // repeats the hint.
    const inactive = text.trim() === '' || blocked || over
    button.dataset.mode = inactive ? 'empty' : 'ready'
    setAttr(button, 'aria-label', 'Надіслати')
    setAttr(button, 'aria-disabled', inactive ? 'true' : null)
  }

  const describe = (): void => {
    // The key hint is true only for a fine pointer.
    setAttr(input, 'aria-describedby', finePointer() ? 'composer-keys composer-note' : 'composer-note')
    setAttr(input, 'enterkeyhint', finePointer() ? 'send' : 'enter')
    show(keys, finePointer())
  }

  input.addEventListener('input', () => {
    grow()
    refresh()
    onType()
  })
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return
    const always = event.ctrlKey || event.metaKey
    if (!always && (event.shiftKey || !finePointer())) return
    event.preventDefault()
    // While the answer comes, Enter neither sends nor stops (§3.7.3).
    if (mode === 'send') onSend()
  })
  button.addEventListener('pointerdown', (event) => event.preventDefault())
  button.addEventListener('click', () => {
    if (mode === 'stop') onStop()
    else onSend()
  })
  window.matchMedia('(pointer: fine)').addEventListener('change', describe)
  describe()
  refresh()

  return {
    element: root,
    value: () => input.value,
    clear() {
      input.value = ''
      grow()
      refresh()
    },
    put(text) {
      input.value = text
      grow()
      refresh()
      input.focus()
    },
    insert(text) {
      const before = input.value.trimEnd()
      const already = before.endsWith(text)
      if (!already) input.value = before === '' ? text : `${before} ${text}`
      grow()
      refresh()
      if (finePointer()) {
        input.focus()
        input.setSelectionRange(input.value.length, input.value.length)
      } else {
        say(already ? SAY_ALREADY : SAY_INSERTED)
      }
    },
    focus: () => input.focus(),
    setPlaceholder(text) {
      setAttr(input, 'placeholder', text)
    },
    setMode(next, isBlocked) {
      if (next === mode && isBlocked === blocked) return
      mode = next
      blocked = isBlocked
      refresh()
    },
  }
}
