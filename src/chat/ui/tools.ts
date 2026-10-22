// The self-help tools (spec §3.13): «Подихати хвилину», «Заземлення 5-4-3-2-1», «Як ви зараз?» and
// «В укритті». Each is a native <dialog> that dialogs.ts keeps in line with model.overlay; this
// module runs what happens inside them, and the controls that open them on the page.
//
// - Nothing is stored or sent. The minute's clock and the grounding step live here only while the
//   dialog is open and start over on every opening; a mood word goes to the state (mood/pick) and,
//   only on «Додати до розмови», into the message field — the person decides whether to send it.
// - The crisis closes every tool in the frame it comes (reduce empties the overlays, dialogs.ts
//   closes the dialog and calls close() synchronously): no timer of an exercise outlives it.
// - Motion: the circle breathes only under html[data-motion='on'] without prefers-reduced-motion
//   (chat.css). Otherwise the same minute is a calm count in words: «Вдих · 4 3 2 1».

import type { Action, Model, MoodWhen, ToolOverlay } from '../core/state'
import {
  MOOD_QUADRANTS,
  MOOD_WORDS,
  breathAt,
  breathNextChangeMs,
  isMoodWord,
  isToolKind,
  type BreathPattern,
  type MoodQuadrant,
} from '../core/selfhelp'
import type { Composer } from './composer'
import { BREATH_CLOSE, BREATH_DONE, BREATH_PHASE, BREATH_STOP, MOOD_TITLE, groundProgress, moodLine, moodSentence } from './copy'
import { refreshThemeColor } from '../../ui/theme'
import { byEl, setAttr, setText, show } from './dom'

type Kind = ToolOverlay['o']

export type Tools = Readonly<{
  /** The tool's dialog is about to open (dialogs.ts): it starts from its first step. */
  open(overlay: ToolOverlay, model: Model, overShelter: boolean): void
  /** Its dialog has closed (dialogs.ts, synchronously): its clock stops, its choices go. */
  close(kind: Kind): void
  /** Every render: what follows the model — «А зараз?» on the end screens, «Додати до розмови»,
   *  the tools of «Якщо важко» (none in the crisis). */
  sync(model: Model): void
  /** A press on a tool's control; false when the name is not a tool's. */
  act(name: string, target: HTMLElement): boolean
}>

const dialogOf = (kind: Kind): HTMLDialogElement => document.querySelector<HTMLDialogElement>(`[data-dialog="${kind}"]`)!

/** Grounding: the breath first, then 5 · 4 · 3 · 2 · 1; the step after the last is the end. */
const GROUND_STEPS = 6

export function createTools(dispatch: (action: Action) => void, composer: () => Composer): Tools {
  let last: Model | null = null

  // ── «Подихати хвилину» ──

  const breathe = dialogOf('breathe')
  const b = <T extends HTMLElement = HTMLElement>(name: string): T => byEl<T>(name, breathe)
  const breatheClose = b('breathe-close')
  const breatheStatus = b('breathe-status')
  const breathePhase = b('breathe-phase')
  const breatheCount = b('breathe-count')
  const sigh = b('breathe-sigh')
  let pattern: BreathPattern = 'slow'
  let started = 0
  let timer = 0
  let shown = { round: -1, step: -1, left: -1 }

  const breatheView = (view: 'ready' | 'run' | 'done'): void => {
    show(b('breathe-ready'), view === 'ready')
    show(b('breathe-run'), view === 'run')
    show(b('breathe-done'), view === 'done')
    breathe.dataset.view = view
    // «Стоп» stays in the head, in view on any phone: it ends the exercise and closes it.
    setText(breatheClose, view === 'run' ? BREATH_STOP : BREATH_CLOSE)
  }

  const breatheStop = (): void => {
    window.clearTimeout(timer)
    timer = 0
  }

  const breatheTick = (): void => {
    timer = 0
    const at = breathAt(pattern, performance.now() - started)
    if (at.done) {
      breatheFinish()
      return
    }
    if (at.round !== shown.round || at.step !== shown.step) {
      // The circle eases to the step's size over what is left of the step (a tab that slept
      // catches up instead of drifting); the duration goes first, then the step that uses it.
      breathe.style.setProperty('--breath-ms', `${Math.round(at.phaseMs - at.intoMs)}ms`)
      breathe.dataset.phase = at.phase
      setText(breathePhase, BREATH_PHASE[at.phase])
      // Said once a step, never every second.
      setText(breatheStatus, BREATH_PHASE[at.phase])
    }
    if (at.left !== shown.left) setText(breatheCount, String(at.left))
    shown = { round: at.round, step: at.step, left: at.left }
    timer = window.setTimeout(breatheTick, breathNextChangeMs(at) + 16)
  }

  const breatheStart = (): void => {
    breatheStop()
    started = performance.now()
    shown = { round: -1, step: -1, left: -1 }
    delete breathe.dataset.phase
    breatheView('run')
    // «Почати» is gone: the focus goes to «Стоп».
    breatheClose.focus()
    breatheTick()
  }

  const breatheFinish = (): void => {
    breatheStop()
    delete breathe.dataset.phase
    breatheView('done')
    setText(breatheStatus, BREATH_DONE)
  }

  const breathePattern = (next: BreathPattern): void => {
    pattern = next
    breathe.dataset.pattern = next
    setAttr(sigh, 'aria-checked', String(next === 'sigh'))
    show(b('breathe-line-slow'), next === 'slow')
    show(b('breathe-line-sigh'), next === 'sigh')
  }

  const breatheReset = (): void => {
    breatheStop()
    delete breathe.dataset.phase
    breathe.style.removeProperty('--breath-ms')
    breathePattern('slow')
    breatheView('ready')
    setText(breatheStatus, '')
    setText(breathePhase, '')
    setText(breatheCount, '')
    shown = { round: -1, step: -1, left: -1 }
    b('breathe-ready').querySelector('details')?.removeAttribute('open')
  }

  // ── «Заземлення 5-4-3-2-1» ──

  const ground = dialogOf('ground')
  const g = <T extends HTMLElement = HTMLElement>(name: string): T => byEl<T>(name, ground)
  const groundSteps = Array.from(ground.querySelectorAll<HTMLElement>('.ground__step'))
  let step = 0
  let groundOverShelter = false

  const groundRender = (say: boolean): void => {
    const end = step >= GROUND_STEPS
    for (const node of groundSteps) show(node, Number(node.dataset.step) === step)
    // At the end the line keeps its last words, unseen (chat.css): its height stays, and so do the
    // buttons under it.
    const progress = groundProgress(Math.min(step + 1, GROUND_STEPS), GROUND_STEPS)
    setText(g('ground-progress'), progress)
    show(g('ground-progress'), !end)
    show(g('ground-back'), step > 0 && !end)
    show(g('ground-next'), !end)
    show(g('ground-done'), end)
    show(g('ground-again'), end)
    // In the shelter the person already is where the line sends them.
    show(g('ground-safety'), step === 0 && !groundOverShelter)
    if (!say) return
    const text = groundSteps.find((node) => Number(node.dataset.step) === step)?.querySelector('.ground__text')?.textContent ?? ''
    setText(g('ground-status'), end ? text : `${progress}. ${text}`)
  }

  const groundGo = (to: number): void => {
    step = Math.max(0, Math.min(GROUND_STEPS, to))
    groundRender(true)
  }

  // ── «Як ви зараз?» ──

  const mood = dialogOf('mood')
  const m = <T extends HTMLElement = HTMLElement>(name: string): T => byEl<T>(name, mood)
  const cells = Array.from(mood.querySelectorAll<HTMLElement>('[data-quadrant]'))
  const words = m('mood-words')
  // The chips, once, from the core's dictionary: a word the page shows is a word the state takes.
  // One word of the cell's six: a radio group, like the cells (APG «Radio Group»).
  for (const quadrant of MOOD_QUADRANTS) {
    const group = document.createElement('div')
    group.className = 'mood__group'
    group.setAttribute('role', 'radiogroup')
    group.dataset.group = quadrant
    const label = cells.find((cell) => cell.dataset.quadrant === quadrant)?.textContent?.trim() ?? ''
    group.setAttribute('aria-label', label)
    group.hidden = true
    for (const word of MOOD_WORDS[quadrant]) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'mood__word'
      chip.dataset.act = 'mood-word'
      chip.dataset.word = word
      chip.setAttribute('role', 'radio')
      chip.setAttribute('aria-checked', 'false')
      chip.tabIndex = -1
      chip.textContent = word
      group.append(chip)
    }
    words.append(group)
  }
  let quadrant: MoodQuadrant | null = null
  let word: string | null = null
  let when: MoodWhen = 'before'

  /** «Додати до розмови»: only where the field is there to take the words. */
  const canAdd = (model: Model | null): boolean => {
    if (model === null || model.state.s !== 'chat' || when !== 'before') return false
    const field = composer().element
    return field.isConnected && !field.hidden
  }

  /** A radio group's state: aria-checked on the chosen one, and one Tab stop — the chosen one, else
   *  the first (roving tabindex). */
  const rove = (items: readonly HTMLElement[], chosen: (item: HTMLElement) => boolean): void => {
    const stop = Math.max(0, items.findIndex(chosen))
    items.forEach((item, i) => {
      setAttr(item, 'aria-checked', String(chosen(item)))
      setAttr(item, 'tabindex', i === stop ? '0' : '-1')
    })
  }

  const moodRender = (): void => {
    setText(m('mood-title'), MOOD_TITLE[when])
    rove(cells, (cell) => cell.dataset.quadrant === quadrant)
    for (const group of Array.from(words.querySelectorAll<HTMLElement>('.mood__group'))) {
      show(group, group.dataset.group === quadrant)
      rove(Array.from(group.querySelectorAll<HTMLElement>('.mood__word')), (chip) => chip.dataset.word === word)
    }
    show(m('mood-actions'), word !== null)
    show(m('mood-add'), word !== null && canAdd(last))
  }

  /** A cell: another one takes the choice and lets the word go; the chosen one again keeps both
   *  (a radio is not a toggle). */
  const chooseQuadrant = (next: string | undefined): void => {
    if (next === undefined || !(MOOD_QUADRANTS as readonly string[]).includes(next)) return
    if (next !== quadrant) word = null
    quadrant = next as MoodQuadrant
    moodRender()
  }

  const chooseWord = (next: string | undefined): void => {
    if (next !== undefined && isMoodWord(next)) word = next
    moodRender()
  }

  // The arrows of a radio group (APG): the next one (→ ↓) or the one before (← ↑), round the ends,
  // takes the focus and the choice. Tab leaves the group from its one stop.
  mood.addEventListener('keydown', (event) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (step === 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const item = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[role="radio"]') : null
    const group = item?.closest<HTMLElement>('[role="radiogroup"]')
    if (!item || !group) return
    event.preventDefault()
    const items = Array.from(group.querySelectorAll<HTMLElement>('[role="radio"]'))
    const next = items[(items.indexOf(item) + step + items.length) % items.length]!
    if (next.dataset.act === 'mood-quadrant') chooseQuadrant(next.dataset.quadrant)
    else chooseWord(next.dataset.word)
    next.focus()
  })

  // ── open, close, sync ──

  /** What colours the root, and so the browser's bar: «В укритті» (or a tool over it) — dark;
   *  another dialog — the scrim's colour where a classic scrollbar has a gutter; else the page. */
  let rootLook: 'shelter' | 'dialog' | 'page' = 'page'

  const tools: Tools = {
    open(overlay, model, overShelter) {
      last = model
      const el = dialogOf(overlay.o)
      // Breathing and grounding opened from the shelter keep its dark, quiet look.
      setAttr(el, 'data-shelter', overShelter ? '' : null)
      switch (overlay.o) {
        case 'breathe':
          breatheReset()
          return
        case 'ground':
          groundOverShelter = overShelter
          step = 0
          setText(g('ground-status'), '')
          groundRender(false)
          return
        case 'mood':
          when = overlay.when
          quadrant = null
          word = null
          moodRender()
          return
        case 'shelter':
          return
      }
    },
    close(kind) {
      if (kind === 'breathe') breatheReset()
      if (kind === 'ground') {
        step = 0
        setText(g('ground-status'), '')
      }
      if (kind === 'mood') {
        quadrant = null
        word = null
      }
      setAttr(dialogOf(kind), 'data-shelter', null)
    },
    sync(model) {
      last = model
      const { state, ctx } = model
      // «А зараз?» and the words of this conversation, on the screen that shows them.
      for (const block of Array.from(document.querySelectorAll<HTMLElement>('[data-el="mood-after"]'))) {
        const before = ctx.mood.before
        const here = before !== null && block.closest(`[data-screen="${state.s}"]`) !== null
        show(block, here)
        setText(byEl('mood-line', block), here && before !== null ? moodLine(before, ctx.mood.after) : '')
      }
      // While the theses are being saved, «А зараз?» waits like the other controls there: the
      // «Збережено» that follows would close a check-in opened now, half chosen (I6).
      const saving = state.s === 'review' && state.saving === 'saving'
      for (const button of Array.from(document.querySelectorAll<HTMLElement>('[data-el="mood-after"] [data-act="tool"]'))) {
        setAttr(button, 'aria-disabled', saving ? 'true' : null)
      }
      show(byEl('help-tools'), state.s !== 'crisis')
      if (mood.open) moodRender()
      // After dialogs.ts has opened or closed the dialogs of this render — the crisis closes the
      // shelter in this same step, and the bar turns back with it. Any dialog counts, not only the
      // shelter: under one a classic scrollbar's gutter takes the scrim's colour (chat.css), and a
      // theme picked in «Акаунт» was read from it — the bar kept that grey once the sheet closed.
      const look = model.overlay.some((o) => o.o === 'shelter') ? 'shelter' : document.querySelector('dialog[open]') !== null ? 'dialog' : 'page'
      if (look !== rootLook) {
        rootLook = look
        refreshThemeColor()
      }
    },
    act(name, target) {
      switch (name) {
        case 'tool': {
          const kind = target.dataset.tool ?? ''
          if (!isToolKind(kind) || target.getAttribute('aria-disabled') === 'true') return true
          // From the «+» menu: the menu closes first, and «Інструменти» takes the focus — the dialog
          // gives it back there (an item of a closed menu cannot hold it).
          const menu = target.closest<HTMLElement>('[popover]')
          if (menu !== null) {
            try {
              if (menu.matches(':popover-open')) menu.hidePopover()
            } catch {
              // An engine without popovers: the menu is not open.
            }
            document.querySelector<HTMLElement>(`[popovertarget="${menu.id}"]`)?.focus()
          }
          const after = target.dataset.when === 'after'
          dispatch(after ? { type: 'overlay/open', overlay: kind, when: 'after' } : { type: 'overlay/open', overlay: kind })
          return true
        }
        case 'breathe-start':
        case 'breathe-again':
          breatheStart()
          return true
        case 'breathe-sigh':
          breathePattern(pattern === 'slow' ? 'sigh' : 'slow')
          return true
        case 'ground-next':
          groundGo(step + 1)
          // The last step leads to the end: «Далі» is gone, «Готово» takes the focus.
          if (step >= GROUND_STEPS) g('ground-done').focus()
          return true
        case 'ground-back':
          groundGo(step - 1)
          if (step === 0) g('ground-next').focus()
          return true
        case 'ground-again':
          groundGo(0)
          g('ground-next').focus()
          return true
        case 'mood-quadrant':
          chooseQuadrant(target.dataset.quadrant)
          return true
        case 'mood-word':
          chooseWord(target.dataset.word)
          return true
        case 'mood-done':
        case 'mood-add': {
          if (word === null) return true
          const chosen = word
          const add = name === 'mood-add' && canAdd(last)
          dispatch({ type: 'mood/pick', word: chosen })
          // The dialog is closed and the focus back on what opened it; the sentence goes into the
          // field after what is there (on a fine pointer the focus follows it).
          if (add) composer().insert(moodSentence(chosen))
          return true
        }
        default:
          return false
      }
    },
  }
  breatheReset()
  return tools
}
