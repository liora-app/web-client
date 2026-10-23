// The conversation screen (spec §3.6, §3.7): a new conversation with the scenario switch and «Не
// зберігати», then the conversation with its session row, transcript and composer.
//
// Leaving the screen (any other State.s) empties its transcript — the answer in progress and its
// scheduled write first (I3) — and takes the composer and the session row out of the DOM, not just
// out of sight (§6.2: in the crisis there is no field to type into). They come back, the same
// nodes, when the screen is entered again; the typed text survives only while the conversation
// does (theses and back, a consent), not its end — render.ts empties the field on any screen
// change that ends the conversation, from whichever screen.
//
// The lines above the composer are live regions that stay rendered while empty (visually hidden
// by CSS, never [hidden]): a region that appears together with its text is not reliably read
// (§5.7).
//
// The reminder to pause (§3.7.7) is one line in the composer: its 40 minutes are one timer armed
// here for the time left (the core has no clock), between answers only, cleared on every way out
// of the screen — the crisis above all — and armed again on the way back. 60 replies need no
// timer: the core looks at each answer.

import { maskPausedLineInline } from '../../core/helplines'
import type { Action, ChatState, Model } from '../../core/state'
import { MAX_MARKS, canSendNow, hasReply, hasUserMessage, pauseAt, scenariosOf } from '../../core/state'
import { LONG_CONVERSATION_MESSAGES, SERVER_TRIM_CODE_POINTS, canSend, totalCodePoints } from '../../core/limits'
import type { ScenarioOut } from '../../core/types'
import {
  LIMIT_BLOCK,
  NEED_RECORDS,
  PAUSE_LINE,
  REVISIT_EMPTY,
  REVISIT_FAILED,
  REVISIT_GONE_BLOCK,
  LONG_CONVERSATION,
  SERVER_TRIM,
  TOO_LARGE_BLOCK,
  UNSENT,
  marksCounter,
  placeholder,
  scenarioAbout,
  starters,
  tooLong,
} from '../copy'
import { byEl, fromTemplate, headingOf, screenOf, setAttr, setText, show } from '../dom'
import { decorativeMotion, onMotionChange } from '../../../ui/motion'
import { REPEAT_GAP_MS } from '../announcer'
import { createComposer, type Composer } from '../composer'
import { createScrollAnchor } from '../scroll-anchor'
import { Transcript, type StreamView } from '../transcript'
import { authBanner, clearBanner, type Screen } from './text'
import { fillProvider } from './consent'

export type ChatScreen = Screen &
  Readonly<{
    composer: Composer
    transcript: Transcript
    /** After «Надіслати»: the field empties once the reducer took the message. */
    afterSend(model: Model, text: string): void
    jumpToEnd(): void
    /** A starter chip: its words go into the field (never sent by themselves). */
    start(index: number): void
  }>

/** A node that leaves the DOM and comes back to the same place (a comment marks the spot). */
function detachable(node: HTMLElement): Readonly<{ detach(): void; attach(): void }> {
  const marker = document.createComment(node.dataset.el ?? '')
  return {
    detach() {
      if (node.isConnected) node.replaceWith(marker)
    },
    attach() {
      if (!node.isConnected && marker.isConnected) marker.replaceWith(node)
    },
  }
}

/** A toggletip or the tools menu left open in a part that goes away (the head after the first
 *  message, a field replaced by a block, the screen itself — the crisis above all) closes with it:
 *  hidden, it would still be open and come back open with that part. */
function closePopovers(scope: HTMLElement): void {
  for (const node of Array.from(scope.querySelectorAll<HTMLElement>('[popover]'))) {
    try {
      if (node.matches(':popover-open')) node.hidePopover()
    } catch {
      // An engine without popovers: nothing there is open.
    }
  }
}

/** The first «Надіслати» takes the new conversation's head away; the transcript glides up into its
 *  place instead of jumping (a FLIP on the list, spec §3.6). Only with motion. */
const COLLAPSE_MS = 240

export function chatScreen(
  dispatch: (action: Action) => void,
  onPulse: () => void,
  onType: () => void = () => {},
  say: (text: string) => void = () => {},
): ChatScreen {
  const root = screenOf('chat')
  const el = <T extends HTMLElement = HTMLElement>(name: string): T => byEl<T>(name, root)
  const session = el('session')
  const head = el('compose-head')
  const list = el('scenario-list')
  const nosave = el('nosave')
  const line = el('chat-line')
  const block = el('chat-block')
  const status = el('composer-status')
  const talk = el<HTMLOListElement>('talk')
  const starterBox = el('starters')
  /** The starters' row: their visible label «Почати зі слів» (the group's name) and the group. */
  const starterRow = el('starters-row')
  /** «Як ви зараз?» (§3.13): after the starters, in the same row; it opens the check-in. */
  const checkin = el('checkin')
  let scenarioKey = ''
  /** The scenario the row last showed as chosen (see renderScenarios). */
  let scenarioShown = ''
  let starterKey = ''
  /** The last render showed a conversation already under way (the head gone). */
  let wasStarted = false
  /** The glide in flight: «Пауза» or leaving the screen ends it where it is going. */
  let glide: Animation | null = null
  onMotionChange((allowed) => {
    if (!allowed) glide?.finish()
  })
  let lastModel: Model | null = null
  let shownNotice: ChatState['notice'] = null
  let repeatTimer = 0
  /** The reminder's timer, and the moment it is armed for: one timer, never one per render. It
   *  stands only between answers (the core takes the reminder only then): while an answer comes it
   *  is taken off, and when the turn ends — `done`, «Зупинити», an error, a 429 — it is armed again,
   *  firing at once if the moment passed meanwhile. `done` brings the reminder itself (the core
   *  checks it there), and then nothing is armed. */
  let pauseTimer = 0
  let pauseFor: number | null = null
  const disarmPause = (): void => {
    window.clearTimeout(pauseTimer)
    pauseTimer = 0
    pauseFor = null
  }
  const armPause = (at: number | null): void => {
    if (at === pauseFor) return
    window.clearTimeout(pauseTimer)
    pauseTimer = 0
    pauseFor = at
    if (at === null) return
    // setTimeout holds at most 2^31 − 1 ms; 40 minutes are far below it.
    pauseTimer = window.setTimeout(() => {
      pauseTimer = 0
      dispatch({ type: 'chat/pause-due', now: Date.now() })
    }, Math.max(0, at - Date.now()))
  }

  const anchor = createScrollAnchor({
    header: document.querySelector<HTMLElement>('[data-header]')!,
    session,
    composer: el('composer'),
    talk,
    jump: el('jump'),
    jumpText: el('jump-text'),
    focusAfterJump: (fromKeys) => (fromKeys && !composer.element.hidden ? root.querySelector<HTMLElement>('textarea') : headingOf(root)),
  })
  const transcript = new Transcript(talk, {
    onPulse,
    onWrite: () => anchor.update(),
    onSent: (sent, answer) => anchor.sent(sent, answer),
  })
  const sessionSlot = detachable(session)
  const composerSlot = detachable(el('composer'))
  const composer = createComposer(
    el('composer'),
    () => {
      const text = composer.value()
      dispatch({ type: 'chat/send', text, now: Date.now() })
      if (lastModel) screen.afterSend(lastModel, text)
    },
    () => dispatch({ type: 'chat/stop' }),
    onType,
    say,
  )

  const renderScenarios = (items: readonly ScenarioOut[], chosen: string): void => {
    const key = items.map((s) => `${s.id}:${s.title}`).join('|')
    if (key !== scenarioKey) {
      scenarioKey = key
      list.replaceChildren()
      for (const item of items) {
        const pill = fromTemplate<HTMLLabelElement>('scenario')
        const input = pill.querySelector<HTMLInputElement>('input')!
        input.value = item.id
        input.dataset.act = 'scenario'
        setText(pill.querySelector('.pill__text')!, item.title)
        list.append(pill)
      }
    }
    for (const input of Array.from(list.querySelectorAll<HTMLInputElement>('input'))) {
      const on = input.value === chosen
      if (input.checked !== on) input.checked = on
      input.closest('.pill')?.classList.toggle('pill--on', on)
    }
    // Arrow keys move the focus and the choice along the radios, but Chromium does not scroll a radio
    // focused that way into view: on a phone the row (it scrolls sideways, ADR-013) brings the focused
    // pill in itself, a whole padding in, clear of its faded ends (#141). Only when the choice moved,
    // after the ✦ changed the pills' widths: a later render never pulls the row or the page back.
    if (chosen !== scenarioShown) {
      scenarioShown = chosen
      const focused = document.activeElement
      if (focused instanceof HTMLInputElement && list.contains(focused)) focused.closest('.pill')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }

  const renderStarters = (scenario: string, visible: boolean): void => {
    const lines = starters(scenario)
    if (scenario !== starterKey) {
      starterKey = scenario
      starterBox.replaceChildren()
      for (const [i, line] of lines.entries()) {
        const chip = fromTemplate<HTMLButtonElement>('starter')
        chip.dataset.i = String(i)
        setText(chip, line)
        starterBox.append(chip)
      }
      starterBox.append(checkin)
    }
    // «Як ви зараз?» is always there before the first message, a scenario without starters of its
    // own (one the server added later) included.
    show(starterBox, visible)
    show(starterRow, visible)
  }

  const streamOf = (state: ChatState): StreamView | null => {
    const t = state.turn
    if (t.p === 'waiting') return { id: t.id, phase: 'waiting', stage: t.stage, partial: '', until: null }
    if (t.p === 'streaming') return { id: t.id, phase: 'streaming', stage: 'meta', partial: t.partial, until: null }
    if (t.p === 'busy-wait') return { id: t.id, phase: 'busy-wait', stage: 'headers', partial: '', until: t.until }
    return null
  }

  const screen: ChatScreen = {
    composer,
    transcript,
    afterSend(model, text) {
      const state = model.state
      if (state.s === 'chat' && state.pending?.status === 'sending' && state.pending.text === text) composer.clear()
    },
    jumpToEnd() {
      anchor.jumpToEnd()
    },
    start(index) {
      const state = lastModel?.state
      if (state?.s !== 'chat' || hasUserMessage(state.session, state.pending)) return
      const line = starters(state.session.scenario)[index]
      if (line !== undefined) composer.insert(line)
    },
    leave() {
      // On a phone the field may hold the keyboard open: let it close before the field goes.
      const active = document.activeElement
      if (active instanceof HTMLElement && root.contains(active)) active.blur()
      closePopovers(root)
      disarmPause()
      glide?.finish()
      glide = null
      transcript.reset()
      anchor.reset()
      sessionSlot.detach()
      composerSlot.detach()
      // The names of the chosen diary records and the email in «Новий вхід не відбувся…»: render()
      // writes them again on the way back.
      setText(el('revisit-names'), '')
      clearBanner(el('chat-auth'), el('chat-auth-text'))
      lastModel = null
      wasStarted = false
    },
    render(model, entered) {
      lastModel = model
      const state = model.state as ChatState
      const { ctx } = model
      const s = state.session
      const started = hasUserMessage(s, state.pending)
      const scenarios = scenariosOf(ctx)
      const scenario = scenarios.find((x) => x.id === s.scenario) ?? scenarios[0]!
      if (entered) {
        sessionSlot.attach()
        composerSlot.attach()
        transcript.reset()
        anchor.reset()
        wasStarted = started
      }
      // The first message: where the list stood before the head goes (the glide's start). Not under
      // prefers-reduced-motion, even with a stored «on» (decorativeMotion, ADR-012 §3).
      const collapsing = started && !wasStarted && decorativeMotion() && !document.hidden
      const fromTop = collapsing ? talk.getBoundingClientRect().top : 0
      wasStarted = started

      fillProvider(model, root)
      // «Новий вхід не відбувся…» stays over the new conversation it led to (§3.3).
      const banner = el('chat-auth')
      if (started) show(banner, false)
      else authBanner(model, banner, el('chat-auth-text'))

      // Session row: from the first message on (§3.7.1).
      show(session, started)
      setText(el('session-title'), scenario.title)
      show(el('session-nosave'), s.noSave)
      setText(el('session-marks'), marksCounter(s.marks.length, MAX_MARKS))
      setAttr(el('session-marks-row'), 'data-marks', String(s.marks.length))
      const idle = state.turn.p === 'idle' || state.turn.p === 'cooldown'
      show(el('session-end'), hasReply(s) && idle)

      // New conversation (§3.6).
      show(head, !started)
      show(el('after-crisis'), ctx.afterCrisis)
      const failed = ctx.scenarios.status === 'failed'
      show(el('scenarios'), !failed)
      show(el('scenarios-failed'), failed)
      renderScenarios(scenarios, s.scenario)

      const revisit = s.scenario === 'revisit'
      const diary = ctx.diary
      const emptyDiary = revisit && diary.status === 'ok' && diary.value.items.length === 0
      const diaryFailed = revisit && diary.status === 'failed'
      setText(el('scenario-text'), emptyDiary ? REVISIT_EMPTY : diaryFailed ? REVISIT_FAILED : scenarioAbout(scenario))
      const chosenNames =
        revisit && diary.status === 'ok'
          ? s.revisitIds.map((id) => diary.value.items.find((item) => item.id === id)?.title).filter((t): t is string => t !== undefined)
          : []
      show(el('revisit-chosen'), revisit && s.revisitIds.length > 0)
      setText(el('revisit-names'), chosenNames.map(maskPausedLineInline).join(', '))
      show(el('revisit-actions'), revisit)
      show(el('revisit-open'), revisit && diary.status === 'ok' && diary.value.items.length > 0)
      setText(el('revisit-open'), s.revisitIds.length > 0 ? 'Змінити' : 'Обрати записи')
      show(el('diary-retry'), diaryFailed)
      show(el('revisit-free'), emptyDiary)

      // The glide: measured once the head is gone and the session row is in, before the send anchor
      // scrolls (it reads the list where it ends up, not where it is drawn).
      const shift = collapsing ? fromTop - talk.getBoundingClientRect().top : 0

      // Transcript (§3.7.2).
      transcript.sync({
        messages: s.messages,
        times: s.times,
        cut: s.cut,
        pending: state.pending,
        stream: streamOf(state),
        csrfFailures: ctx.csrfFailures,
        cooldownUntil: state.turn.p === 'cooldown' ? state.turn.until : null,
        revisit,
        marks: s.marks,
      })

      if (shift > 1) {
        glide = talk.animate([{ transform: `translate3d(0, ${Math.round(shift)}px, 0)` }, { transform: 'none' }], {
          duration: COLLAPSE_MS,
          easing: 'cubic-bezier(0.2, 0, 0, 1)',
        })
      }

      // «Не зберігати» (§3.6): until the first message.
      show(nosave, !started)
      if (started) closePopovers(nosave)
      const toggle = nosave.querySelector<HTMLElement>('[role="switch"]')!
      setAttr(toggle, 'aria-checked', String(s.noSave))
      setText(el('nosave-state'), s.noSave ? 'Увімкнено' : 'Вимкнено')

      // Lines above the composer and the blocks that replace it (§3.7.7, §4.2).
      const n = s.messages.length
      const lineText = n >= LONG_CONVERSATION_MESSAGES ? LONG_CONVERSATION : totalCodePoints(s.messages) > SERVER_TRIM_CODE_POINTS ? SERVER_TRIM : ''
      setText(line, started ? lineText : '')

      const notice = state.notice
      let blockText = ''
      if (notice?.kind === 'too-large') blockText = TOO_LARGE_BLOCK
      else if (notice?.kind === 'revisit-gone') blockText = REVISIT_GONE_BLOCK
      else if (!canSend(n) && idle) blockText = LIMIT_BLOCK
      setText(el('chat-block-text'), blockText)
      show(block, blockText !== '')
      const goneFirst = notice?.kind === 'revisit-gone' && !hasReply(s)
      show(el('block-summarize'), blockText !== '' && !goneFirst)
      show(el('block-free'), goneFirst)

      // Composer (§3.7.3). Without it, «AI, не людина · може помилятися · не терапія» still stands
      // on the screen: the line under the field goes with the field (§3.7.1).
      const composerShown = blockText === '' && !emptyDiary
      show(composer.element, composerShown)
      if (!composerShown) closePopovers(composer.element)
      show(el('chat-ai'), !composerShown)
      // The reminder to pause (§3.7.7): with the field, never instead of it. «Зібрати тези» waits
      // while an answer comes (the confirm opens between answers only). The timer too: one that
      // fired mid-answer would be refused, and an answer that ends without `done` (stopped, failed,
      // a 429) would never bring the line.
      armPause(idle ? pauseAt(s) : null)
      const pause = s.pause === 'time' || s.pause === 'count' ? s.pause : null
      const pauseText = el('pause-text')
      const pauseLine = pause !== null && composerShown ? PAUSE_LINE[pause] : ''
      const putPause = (): void => {
        setText(pauseText, pauseLine)
        show(el('pause-actions'), pauseLine !== '')
      }
      // It grows the sticky composer upward: coming, it must not cover the end of the reply it
      // came with (a phone at 320 × 640 had the reply's last line and «↓ До кінця» under it).
      if (pauseLine !== '' && pauseText.textContent === '') anchor.hold(putPause)
      else putPause()
      const answering = state.turn.p === 'waiting' || state.turn.p === 'streaming' || state.turn.p === 'busy-wait'
      setAttr(el('pause-collect'), 'aria-disabled', answering ? 'true' : null)

      // Starters: a new conversation with the field there to take them (§3.6).
      renderStarters(s.scenario, !started && composerShown)
      composer.setPlaceholder(placeholder(s.scenario, !hasUserMessage(s, null)))
      const inFlight = state.turn.p === 'waiting' || state.turn.p === 'streaming' || state.turn.p === 'busy-wait'
      const blocked = !inFlight && !canSendNow(state) && state.pending === null && !(revisit && s.revisitIds.length === 0)
      composer.setMode(inFlight ? 'stop' : 'send', blocked || state.turn.p === 'cooldown')
      const statusText =
        notice?.kind === 'need-records' ? NEED_RECORDS : notice?.kind === 'too-long' ? tooLong(notice.length) : notice?.kind === 'unsent' ? UNSENT : ''
      // A press again gives a new notice with the same text: emptied first, so the live line is
      // heard again (§3.7.3 «натиск лише повторює підказку»).
      const repeated = notice !== shownNotice && statusText !== '' && status.textContent === statusText
      shownNotice = notice
      window.clearTimeout(repeatTimer)
      if (repeated) {
        status.textContent = ''
        repeatTimer = window.setTimeout(() => setText(status, statusText), REPEAT_GAP_MS)
      } else {
        setText(status, statusText)
      }

      // The «↓» pill: only once the person has written something (§3.7.6).
      anchor.context({ shown: started, streaming: state.turn.p === 'streaming' })
    },
    focusTarget(model) {
      const state = model.state as ChatState
      if (model.ctx.authNotice !== null && !hasUserMessage(state.session, state.pending)) return el('chat-auth')
      if (!hasUserMessage(state.session, state.pending) && window.matchMedia('(pointer: fine)').matches && !composer.element.hidden) {
        return root.querySelector<HTMLElement>('textarea')
      }
      return null
    },
  }
  return screen
}
