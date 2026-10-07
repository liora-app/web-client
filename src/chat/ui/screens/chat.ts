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

import { maskPausedLine } from '../../core/helplines'
import type { Action, ChatState, Model } from '../../core/state'
import { canSendNow, hasReply, hasUserMessage, scenariosOf } from '../../core/state'
import { LONG_CONVERSATION_MESSAGES, SERVER_TRIM_CODE_POINTS, canSend, totalCodePoints } from '../../core/limits'
import type { ScenarioOut } from '../../core/types'
import {
  LIMIT_BLOCK,
  NEED_RECORDS,
  REVISIT_EMPTY,
  REVISIT_FAILED,
  REVISIT_GONE_BLOCK,
  LONG_CONVERSATION,
  SERVER_TRIM,
  TOO_LARGE_BLOCK,
  UNSENT,
  placeholder,
  scenarioAbout,
  tooLong,
} from '../copy'
import { byEl, fromTemplate, headingOf, screenOf, setAttr, setText, show } from '../dom'
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

export function chatScreen(dispatch: (action: Action) => void, onPulse: () => void): ChatScreen {
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
  let scenarioKey = ''
  let lastModel: Model | null = null
  let shownNotice: ChatState['notice'] = null
  let repeatTimer = 0

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
      dispatch({ type: 'chat/send', text })
      if (lastModel) screen.afterSend(lastModel, text)
    },
    () => dispatch({ type: 'chat/stop' }),
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
    leave() {
      // On a phone the field may hold the keyboard open: let it close before the field goes.
      const active = document.activeElement
      if (active instanceof HTMLElement && root.contains(active)) active.blur()
      transcript.reset()
      anchor.reset()
      sessionSlot.detach()
      composerSlot.detach()
      // The names of the chosen diary records and the email in «Новий вхід не відбувся…»: render()
      // writes them again on the way back.
      setText(el('revisit-names'), '')
      clearBanner(el('chat-auth'), el('chat-auth-text'))
      lastModel = null
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
      }

      fillProvider(model, root)
      // «Новий вхід не відбувся…» stays over the new conversation it led to (§3.3).
      const banner = el('chat-auth')
      if (started) show(banner, false)
      else authBanner(model, banner, el('chat-auth-text'))

      // Session row: from the first message on (§3.7.1).
      show(session, started)
      setText(el('session-title'), scenario.title)
      show(el('session-nosave'), s.noSave)
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
      show(el('scenario-flow'), s.scenario === 'situation')
      const chosenNames =
        revisit && diary.status === 'ok'
          ? s.revisitIds.map((id) => diary.value.items.find((item) => item.id === id)?.title).filter((t): t is string => t !== undefined)
          : []
      show(el('revisit-chosen'), revisit && s.revisitIds.length > 0)
      setText(el('revisit-names'), chosenNames.map(maskPausedLine).join(', '))
      show(el('revisit-actions'), revisit)
      show(el('revisit-open'), revisit && diary.status === 'ok' && diary.value.items.length > 0)
      setText(el('revisit-open'), s.revisitIds.length > 0 ? 'Змінити' : 'Обрати записи')
      show(el('diary-retry'), diaryFailed)
      show(el('revisit-free'), emptyDiary)

      // Transcript (§3.7.2).
      transcript.sync({
        messages: s.messages,
        cut: s.cut,
        pending: state.pending,
        stream: streamOf(state),
        csrfFailures: ctx.csrfFailures,
        cooldownUntil: state.turn.p === 'cooldown' ? state.turn.until : null,
        revisit,
      })

      // «Не зберігати» (§3.6): until the first message.
      show(nosave, !started)
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

      // Composer (§3.7.3).
      const composerShown = blockText === '' && !emptyDiary
      show(composer.element, composerShown)
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
