// Runs the effects the state machine asks for (spec §2.3): requests, aborts, timers, navigation.
// The reducer stays pure; every result comes back as an action. Requests that the person or the
// page can cancel get their own AbortController; `pagehide` aborts everything in flight (§5.6),
// so the server frees the LLM slot and nothing is kept.

import type { Api } from '../core/api'
import type { ApiError } from '../core/errors'
import type { Action, Effect, Model } from '../core/state'
import { anySignal, runTurn, type TurnOutcome } from '../core/turn'
import type { Announcer } from './announcer'
import { COOLDOWN_OVER, SAY_STOPPED, SAY_THINKING, sayAnswer, sayRetry, sayTheses, SAY_SAVED, turnError } from './copy'
import type { LeaveGuard } from './leave-guard'

/** POST /summaries without an answer after this long counts as an unknown result (§7.3). */
const SAVE_TIMEOUT = 30_000
/** Small account calls (consents, logout, DELETE /me). */
const CALL_TIMEOUT = 20_000

export type EffectDeps = Readonly<{
  api: Api
  dispatch: (action: Action) => void
  model: () => Model
  announcer: Announcer
  leave: LeaveGuard
  /** Puts text back into the message field (after «Змінити»). */
  composer: (text: string) => void
}>

export type Effects = Readonly<{
  run(effect: Effect): void
  /** pagehide: abort everything in flight with the reason 'pagehide'. */
  pageHide(): void
  pageShow(): void
}>

type Ctl = AbortController | null

export function createEffects(deps: EffectDeps): Effects {
  const { api, dispatch, announcer } = deps
  let page = new AbortController()
  let turn: Ctl = null
  let summarize: Ctl = null
  let save: Ctl = null
  let pick: Ctl = null

  /** A signal that aborts on the caller's controller, on pagehide, and with 'timeout' after ms. */
  function signalFor(ctl: AbortController | null, timeoutMs: number | null): Readonly<{ signal: AbortSignal; done: () => void }> {
    const own = ctl ?? new AbortController()
    let timer = 0
    if (timeoutMs !== null) timer = window.setTimeout(() => own.abort('timeout'), timeoutMs)
    const linked = anySignal([own.signal, page.signal])
    return {
      signal: linked.signal,
      done: () => {
        window.clearTimeout(timer)
        linked.dispose()
      },
    }
  }

  async function call<T>(
    run: (signal: AbortSignal) => Promise<{ ok: true; data: T; date: string | null } | { ok: false; error: ApiError }>,
    ok: (data: T, date: string | null) => Action,
    fail: (error: ApiError) => Action,
    opts: Readonly<{ ctl?: AbortController | null; timeoutMs?: number | null }> = {},
  ): Promise<void> {
    const { signal, done } = signalFor(opts.ctl ?? null, opts.timeoutMs ?? CALL_TIMEOUT)
    try {
      const result = await run(signal)
      dispatch(result.ok ? ok(result.data, result.date) : fail(result.error))
    } finally {
      done()
    }
  }

  /** The turn's outcome will be taken by the reducer (not a stale id after «Зупинити»). */
  function current(id: number): boolean {
    const { state } = deps.model()
    return state.s === 'chat' && state.turn.p !== 'idle' && state.turn.p !== 'cooldown' && state.turn.id === id
  }

  function announceOutcome(outcome: TurnOutcome): void {
    const model = deps.model()
    switch (outcome.kind) {
      case 'done':
        if (outcome.text.trim() !== '') announcer.say(sayAnswer(outcome.text))
        return
      case 'crisis':
        // The crisis screen takes focus on its h1; no announcement over it (§6.2).
        return
      case 'aborted':
        return
      default: {
        const state = model.state
        if (state.s === 'chat' && state.pending?.status === 'failed' && state.pending.error !== null) {
          announcer.say(`Не надіслано. ${turnError(state.pending.error, model.ctx.csrfFailures, null, state.session.scenario === 'revisit').why}`)
        }
      }
    }
  }

  function runTurnEffect(effect: Extract<Effect, { type: 'turn' }>): void {
    turn?.abort('user')
    const ctl = new AbortController()
    turn = ctl
    let gotToken = false
    const thinking = window.setTimeout(() => {
      if (!gotToken && turn === ctl) announcer.say(SAY_THINKING)
    }, 700)
    void runTurn(
      {
        api,
        // Detached on purpose: window.setTimeout throws when called on another receiver.
        setTimeout: (fn, ms) => window.setTimeout(fn, ms),
        clearTimeout: (handle) => window.clearTimeout(handle as number),
        now: () => Date.now(),
      },
      effect.body,
      {
        signals: [ctl.signal, page.signal],
        onProgress: (progress) => {
          if (turn !== ctl) return
          switch (progress.type) {
            case 'meta':
              dispatch({ type: 'turn/meta', id: effect.id })
              break
            case 'token':
              gotToken = true
              dispatch({ type: 'turn/token', id: effect.id, text: progress.text })
              break
            case 'reset':
              dispatch({ type: 'turn/reset', id: effect.id })
              break
            case 'busy-wait':
              dispatch({ type: 'turn/busy-wait', id: effect.id, until: progress.until, retry: progress.retry })
              announcer.say(sayRetry(Math.max(1, Math.round((progress.until - Date.now()) / 1000))))
              break
            case 'retry':
              dispatch({ type: 'turn/retry', id: effect.id, cause: progress.cause, attempt: progress.attempt })
              break
          }
        },
      },
    ).then((outcome) => {
      window.clearTimeout(thinking)
      if (turn === ctl) turn = null
      const accepted = current(effect.id)
      dispatch({ type: 'turn/outcome', id: effect.id, outcome, now: Date.now() })
      if (accepted) announceOutcome(outcome)
    })
  }

  function runSummarize(effect: Extract<Effect, { type: 'summarize' }>): void {
    summarize?.abort('user')
    const ctl = new AbortController()
    summarize = ctl
    const go = (): void => {
      void call(
        (signal) => api.summarize(effect.body, signal),
        (draft) => {
          const n = draft.bullets.length
          window.setTimeout(() => {
            if (deps.model().state.s === 'review') announcer.say(sayTheses(n))
          }, 0)
          return { type: 'summarize/ok', id: effect.id, draft }
        },
        (error) => ({ type: 'summarize/fail', id: effect.id, error, now: Date.now() }),
        { ctl, timeoutMs: effect.timeoutMs },
      ).finally(() => {
        if (summarize === ctl) summarize = null
      })
    }
    if (effect.delayMs > 0) {
      const timer = window.setTimeout(go, effect.delayMs)
      ctl.signal.addEventListener('abort', () => window.clearTimeout(timer), { once: true })
      page.signal.addEventListener('abort', () => window.clearTimeout(timer), { once: true })
    } else {
      go()
    }
  }

  function abort(target: 'turn' | 'summarize' | 'all'): void {
    if (target === 'turn' || target === 'all') {
      if (turn !== null && target === 'turn' && deps.model().state.s === 'chat') announcer.say(SAY_STOPPED)
      turn?.abort('user')
      turn = null
    }
    if (target === 'summarize' || target === 'all') {
      summarize?.abort('user')
      summarize = null
    }
    if (target === 'all') {
      save?.abort('user')
      save = null
      pick?.abort('user')
      pick = null
    }
  }

  function run(effect: Effect): void {
    switch (effect.type) {
      case 'url/clean':
        try {
          history.replaceState(null, '', '/chat/')
        } catch {
          // A sandboxed frame may refuse; the code is already read.
        }
        return
      case 'me':
        void call(
          (signal) => api.me(signal),
          (me) => ({ type: 'me/ok', purpose: effect.purpose, me }),
          (error) => ({ type: 'me/fail', purpose: effect.purpose, error }),
          { timeoutMs: effect.timeoutMs },
        )
        return
      case 'consents':
        void call(
          (signal) => api.consents(signal),
          (consents) => ({ type: 'consents/ok', purpose: effect.purpose, consents }),
          (error) => ({ type: 'consents/fail', purpose: effect.purpose, error }),
        )
        return
      case 'scenarios':
        void call(
          (signal) => api.scenarios(signal),
          (items) => ({ type: 'scenarios/ok', items }),
          (error) => ({ type: 'scenarios/fail', error }),
        )
        return
      case 'diary':
        void call(
          (signal) => api.summaries({ limit: 20 }, signal),
          (list) => ({ type: 'diary/ok', diary: { items: list.items, nextCursor: list.next_cursor } }),
          (error) => ({ type: 'diary/fail', error }),
        )
        return
      case 'pick-list': {
        pick?.abort('user')
        const ctl = new AbortController()
        pick = ctl
        void call(
          (signal) => api.summaries({ limit: 20, cursor: effect.cursor, q: effect.q }, signal),
          (list) => ({
            type: 'revisit/list-ok',
            purpose: effect.purpose,
            q: effect.q,
            cursor: effect.cursor,
            diary: { items: list.items, nextCursor: list.next_cursor },
          }),
          (error) => ({ type: 'revisit/list-fail', purpose: effect.purpose, q: effect.q, cursor: effect.cursor, error }),
          { ctl },
        )
        return
      }
      case 'helplines':
        void call(
          (signal) => api.helplines(signal),
          (helplines) => ({ type: 'helplines/ok', helplines }),
          () => ({ type: 'helplines/fail' }),
        )
        return
      case 'turn':
        runTurnEffect(effect)
        return
      case 'summarize':
        runSummarize(effect)
        return
      case 'save': {
        save?.abort('user')
        const ctl = new AbortController()
        save = ctl
        void call(
          (signal) => api.saveSummary(effect.body, signal),
          (summary) => {
            window.setTimeout(() => {
              if (deps.model().state.s === 'saved') announcer.say(SAY_SAVED)
            }, 0)
            return { type: 'save/ok', id: effect.id, summary }
          },
          (error) => ({ type: 'save/fail', id: effect.id, error }),
          { ctl, timeoutMs: SAVE_TIMEOUT },
        )
        return
      }
      case 'save-check':
        void call(
          (signal) => api.summaries({ limit: 1 }, signal),
          (list, date) => ({ type: 'save/check', id: effect.id, list, date }),
          (error) => ({ type: 'save/check-fail', id: effect.id, error }),
        )
        return
      case 'grant':
        void call(
          (signal) => api.grant(effect.body, signal),
          (consents) => ({ type: 'grant/ok', consents }),
          (error) => ({ type: 'grant/fail', error }),
        )
        return
      case 'revoke':
        void call(
          (signal) => api.revoke(effect.kind, signal),
          (consents) => ({ type: 'revoke/ok', kind: effect.kind, consents }),
          (error) => ({ type: 'revoke/fail', kind: effect.kind, error }),
        )
        return
      case 'logout':
        void call(
          (signal) => api.logout(signal),
          () => ({ type: 'logout/ok' }),
          (error) => ({ type: 'logout/fail', error }),
        )
        return
      case 'delete-me':
        void call(
          (signal) => api.deleteMe(signal),
          () => ({ type: 'delete/ok' }),
          (error) => ({ type: 'delete/fail', error }),
        )
        return
      case 'abort':
        abort(effect.target)
        return
      case 'after':
        window.setTimeout(() => {
          dispatch(effect.action)
          if (effect.action.type === 'cooldown/end') {
            const { state } = deps.model()
            if (state.s === 'chat' && state.turn.p === 'idle') announcer.say(COOLDOWN_OVER)
          }
        }, effect.ms)
        return
      case 'navigate':
        deps.leave.drop()
        window.location.assign(effect.href)
        return
      case 'reload':
        deps.leave.drop()
        window.location.reload()
        return
      case 'composer':
        deps.composer(effect.text)
        return
      case 'announcer/clear':
        announcer.clear()
        return
    }
  }

  return {
    run,
    pageHide() {
      page.abort('pagehide')
    },
    pageShow() {
      if (page.signal.aborted) page = new AbortController()
    },
  }
}
