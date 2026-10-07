// The conversation screen (spec §3.6, §3.7): a new conversation with the scenario switch and «Не
// зберігати», then the conversation with its session row, transcript and composer.

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
import { byEl, fromTemplate, screenOf, setAttr, setText, show } from '../dom'
import { createComposer, type Composer } from '../composer'
import { Transcript, type StreamView } from '../transcript'
import { authBanner, type Screen } from './text'
import { fillProvider } from './consent'

export type ChatScreen = Screen &
  Readonly<{
    composer: Composer
    transcript: Transcript
    /** After «Надіслати»: the field empties once the reducer took the message. */
    afterSend(model: Model, text: string): void
    jumpToEnd(): void
  }>

export function chatScreen(dispatch: (action: Action) => void, chrome: () => Readonly<{ top: number; bottom: number }>, onFlush: () => void): ChatScreen {
  const root = screenOf('chat')
  const el = <T extends HTMLElement = HTMLElement>(name: string): T => byEl<T>(name, root)
  const session = el('session')
  const head = el('compose-head')
  const list = el('scenario-list')
  const nosave = el('nosave')
  const line = el('chat-line')
  const block = el('chat-block')
  const status = el('composer-status')
  const jump = el('jump')
  let scenarioKey = ''
  let lastModel: Model | null = null

  const transcript = new Transcript(el<HTMLOListElement>('talk'), { onFlush, chromeHeights: chrome })
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

  const updateJump = (): void => {
    const model = lastModel
    if (model === null || model.state.s !== 'chat' || root.hidden) {
      show(jump, false)
      return
    }
    const talk = el('talk')
    const lastItem = talk.lastElementChild as HTMLElement | null
    if (lastItem === null) {
      show(jump, false)
      return
    }
    const composerTop = composer.element.hidden ? window.innerHeight : composer.element.getBoundingClientRect().top
    const below = lastItem.getBoundingClientRect().bottom - 4 > composerTop
    const streaming = model.state.turn.p === 'streaming'
    setText(el('jump-text'), streaming ? 'Далі відповідь' : 'До кінця')
    show(jump, below && hasUserMessage(model.state.session, model.state.pending))
  }
  window.addEventListener('scroll', updateJump, { passive: true })

  const screen: ChatScreen = {
    composer,
    transcript,
    afterSend(model, text) {
      const state = model.state
      if (state.s === 'chat' && state.pending?.status === 'sending' && state.pending.text === text) composer.clear()
    },
    jumpToEnd() {
      const talk = el('talk')
      const lastItem = talk.lastElementChild as HTMLElement | null
      lastItem?.scrollIntoView({ block: 'end', behavior: 'auto' })
      updateJump()
    },
    render(model, entered) {
      lastModel = model
      const state = model.state as ChatState
      const { ctx } = model
      const s = state.session
      const started = hasUserMessage(s, state.pending)
      const scenarios = scenariosOf(ctx)
      const scenario = scenarios.find((x) => x.id === s.scenario) ?? scenarios[0]!
      if (entered) transcript.reset()

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
      setText(el('revisit-names'), chosenNames.join(', '))
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
      setText(line, lineText)
      show(line, lineText !== '' && started)

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
      setText(status, statusText)
      show(status, statusText !== '')

      updateJump()
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
