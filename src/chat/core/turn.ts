// One "Надіслати": request, watchdogs and automatic retries → one TurnOutcome (spec §5.5).
//
// Four controllers, each aborting with its own reason:
//   user             «Зупинити», «Скасувати» in the countdown, logout, account deletion → 'user'
//   page             pagehide → 'pagehide'
//   headers (inner)  35 s without response headers → 'headers-timeout'
//   idle (inner)     45 s without a single byte after the headers → 'idle'
// The caller owns the first two and passes their signals; runTurn makes the other two per
// attempt. A failure is classified by `signal.reason`, not by the error's type: fetch and read()
// reject with the reason itself, and «Зупинити», pagehide and a dead connection look alike from
// read().
//
// The headers timer is a plain timer cleared as soon as fetch resolves, not AbortSignal.timeout:
// that one keeps running and would cut a long streamed answer at the 35th second.
//
// Retries, always with the identical request body (I4):
//   truncated (EOF without a final event, read() failed, idle, ProtocolError) → once;
//   llm_busy (HTTP 503 or SSE error) → twice, after Retry-After (5 s by default);
//   everything else, 429 included, is left to the person.

import type { Api } from './api'
import { DEFAULT_BUSY_RETRY_MS, clientError, fromResponse, type ApiError } from './errors'
import type { SafeHelplines } from './helplines'
import { ProtocolError, chatEvents, readFrames, type StreamErrorCode } from './sse'
import type { TurnRequest } from './types'

export const HEADERS_TIMEOUT = 35_000
export const IDLE_TIMEOUT = 45_000
export const MAX_TRUNC_RETRIES = 1
export const MAX_BUSY_RETRIES = 2
export const SUMMARIZE_TIMEOUT = 150_000
export const BOOT_TIMEOUT = 15_000

export type AbortReason = 'user' | 'pagehide' | 'headers-timeout' | 'idle'

export type TurnOutcome =
  | Readonly<{ kind: 'done'; text: string; finishReason: string | null; requestId: string | null }>
  | Readonly<{ kind: 'crisis'; source: 'keyword' | 'model'; helplines: SafeHelplines }>
  | Readonly<{ kind: 'streamError'; code: StreamErrorCode }>
  | Readonly<{ kind: 'http'; error: ApiError }>
  | Readonly<{ kind: 'truncated' }>
  | Readonly<{ kind: 'headersTimeout' }>
  | Readonly<{ kind: 'network' }>
  | Readonly<{ kind: 'aborted'; reason: 'user' | 'pagehide' }>

/** What the screen shows while the turn runs. `reset` drops the partial answer (from the DOM
 *  and from the state) before an automatic retry. */
export type TurnProgress =
  | Readonly<{ type: 'meta'; requestId: string | null }>
  | Readonly<{ type: 'token'; text: string }>
  | Readonly<{ type: 'reset' }>
  | Readonly<{ type: 'busy-wait'; until: number; retry: 1 | 2 }>
  | Readonly<{ type: 'retry'; cause: 'truncated' | 'busy'; attempt: number }>

export type Timers = Readonly<{
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  now: () => number
}>

export type TurnDeps = Timers & Readonly<{ api: Pick<Api, 'turn'> }>

export type TurnOptions = Readonly<{
  /** The caller's controllers: userCtl.signal and pageCtl.signal. */
  signals: readonly AbortSignal[]
  onProgress?: (progress: TurnProgress) => void
}>

/** Links signals into one that aborts with the first source's reason. Manual fallback for
 *  browsers without AbortSignal.any; exported so the test can check the reason survives. */
export function linkSignals(signals: readonly AbortSignal[]): Readonly<{ signal: AbortSignal; dispose: () => void }> {
  const out = new AbortController()
  const first = signals.find((s) => s.aborted)
  if (first !== undefined) {
    out.abort(first.reason)
    return { signal: out.signal, dispose: () => {} }
  }
  const listeners = signals.map((src) => {
    const onAbort = () => out.abort(src.reason)
    src.addEventListener('abort', onAbort, { once: true })
    return () => src.removeEventListener('abort', onAbort)
  })
  return { signal: out.signal, dispose: () => listeners.forEach((off) => off()) }
}

export function anySignal(signals: readonly AbortSignal[]): Readonly<{ signal: AbortSignal; dispose: () => void }> {
  const native = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any
  if (typeof native === 'function') return { signal: native.call(AbortSignal, [...signals]), dispose: () => {} }
  return linkSignals(signals)
}

type Attempt = TurnOutcome

function byReason(reason: unknown): TurnOutcome {
  if (reason === 'idle') return { kind: 'truncated' }
  if (reason === 'headers-timeout') return { kind: 'headersTimeout' }
  if (reason === 'pagehide') return { kind: 'aborted', reason: 'pagehide' }
  return { kind: 'aborted', reason: 'user' }
}

function outerReason(signals: readonly AbortSignal[]): unknown {
  return signals.find((s) => s.aborted)?.reason
}

export async function runTurn(deps: TurnDeps, body: TurnRequest, opts: TurnOptions): Promise<TurnOutcome> {
  // Detached on purpose: a browser's setTimeout throws when its receiver is not the global object.
  const setT = deps.setTimeout
  const clearT = deps.clearTimeout
  const now = deps.now
  const api = deps.api
  const emit = opts.onProgress ?? (() => {})
  const outer = opts.signals

  async function attempt(): Promise<Attempt> {
    if (outer.some((s) => s.aborted)) return byReason(outerReason(outer))
    const headersCtl = new AbortController()
    const idleCtl = new AbortController()
    const { signal, dispose } = anySignal([...outer, headersCtl.signal, idleCtl.signal])
    let idle: unknown = null
    let responded = false
    const headersTimer = setT(() => headersCtl.abort('headers-timeout'), HEADERS_TIMEOUT)
    try {
      let res: Response
      try {
        res = await api.turn(body, signal)
      } finally {
        clearT(headersTimer)
      }
      responded = true
      // From the headers on, 45 s of silence ends any body, an error body included: a 503 whose
      // JSON never arrives must not leave the turn waiting for ever (§5.5).
      const arm = () => {
        if (idle !== null) clearT(idle)
        idle = setT(() => idleCtl.abort('idle'), IDLE_TIMEOUT)
      }
      arm()
      if (!res.ok) {
        const error = await fromResponse(res, now())
        if (signal.aborted) return byReason(signal.reason)
        return { kind: 'http', error }
      }
      const requestId = res.headers.get('x-request-id')
      const type = (res.headers.get('content-type') ?? '').toLowerCase()
      if (!type.startsWith('text/event-stream')) {
        res.body?.cancel().catch(() => {})
        return { kind: 'http', error: clientError('internal', { status: res.status, requestId }) }
      }
      if (res.body === null) return { kind: 'truncated' }
      let text = ''
      let metaId: string | null = null
      for await (const event of chatEvents(readFrames(res.body, arm))) {
        switch (event.type) {
          case 'meta':
            metaId = event.requestId
            emit({ type: 'meta', requestId: event.requestId })
            break
          case 'token':
            text += event.text
            emit({ type: 'token', text: event.text })
            break
          case 'done':
            return { kind: 'done', text, finishReason: event.finishReason, requestId: metaId ?? requestId }
          case 'crisis':
            return { kind: 'crisis', source: event.source, helplines: event.helplines }
          case 'error':
            return { kind: 'streamError', code: event.code }
        }
      }
      return { kind: 'truncated' }
    } catch (error) {
      if (signal.aborted) return byReason(signal.reason)
      if (error instanceof ProtocolError || responded) return { kind: 'truncated' }
      return { kind: 'network' }
    } finally {
      if (idle !== null) clearT(idle)
      dispose()
    }
  }

  /** Resolves true after `ms`, false as soon as the person or the page aborts. */
  function wait(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (outer.some((s) => s.aborted)) {
        resolve(false)
        return
      }
      const off = () => outer.forEach((s) => s.removeEventListener('abort', onAbort))
      const timer = setT(() => {
        off()
        resolve(true)
      }, ms)
      function onAbort() {
        clearT(timer)
        off()
        resolve(false)
      }
      outer.forEach((s) => s.addEventListener('abort', onAbort, { once: true }))
    })
  }

  let truncRetries = 0
  let busyRetries = 0
  for (;;) {
    const outcome = await attempt()
    if (outcome.kind === 'truncated' && truncRetries < MAX_TRUNC_RETRIES) {
      truncRetries++
      emit({ type: 'reset' })
      emit({ type: 'retry', cause: 'truncated', attempt: truncRetries })
      continue
    }
    const busy =
      (outcome.kind === 'http' && outcome.error.code === 'llm_busy') ||
      (outcome.kind === 'streamError' && outcome.code === 'llm_busy')
    if (busy && busyRetries < MAX_BUSY_RETRIES) {
      busyRetries++
      const ms = outcome.kind === 'http' ? (outcome.error.retryAfterMs ?? DEFAULT_BUSY_RETRY_MS) : DEFAULT_BUSY_RETRY_MS
      emit({ type: 'reset' })
      emit({ type: 'busy-wait', until: now() + ms, retry: busyRetries as 1 | 2 })
      if (!(await wait(ms))) return byReason(outerReason(outer))
      emit({ type: 'retry', cause: 'busy', attempt: busyRetries })
      continue
    }
    return outcome
  }
}
