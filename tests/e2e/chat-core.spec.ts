// Pure tests of src/chat/core (spec §11.3): no page, no browser — the core runs in Playwright's
// Node worker, with a fake fetch that returns ReadableStreams and a fake clock. One project is
// enough for code that never touches a browser, so everything here runs only in `desktop`.
//
// Synthetic data only. The paused hotline number appears in fixtures on purpose: the sanitizer
// must drop it from every field it can hide in.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import {
  GOOGLE_START,
  createApi,
  summarizeBody,
  turnBody,
  type FetchLike,
} from '../../src/chat/core/api'
import { countryName } from '../../src/chat/core/country'
import { codeForStatus, fromResponse, outcomeUnknown, retryAfterMs, toUiError, type ApiError } from '../../src/chat/core/errors'
import { FALLBACK, FALLBACK_ABROAD, FALLBACK_MESSAGE, HOWAREU_URL, sanitizeHelplines } from '../../src/chat/core/helplines'
import {
  MAX_CONTENT,
  MAX_QUERY,
  canSend,
  checkMessage,
  clampCodePoints,
  codePoints,
  draftFromOut,
  newTagIssue,
  normalize,
  validateDraft,
  type Draft,
} from '../../src/chat/core/limits'
import { MAX_FRAME_BUFFER, ProtocolError, chatEvents, readFrames, type TurnEvent } from '../../src/chat/core/sse'
import {
  FALLBACK_SCENARIO,
  INITIAL_MODEL,
  authErrorFrom,
  leaveGuard,
  llmInFlight,
  matchesSaved,
  reduce,
  type Action,
  type ChatState,
  type Effect,
  type Model,
  type State,
} from '../../src/chat/core/state'
import {
  BOOT_TIMEOUT,
  HEADERS_TIMEOUT,
  IDLE_TIMEOUT,
  SUMMARIZE_TIMEOUT,
  linkSignals,
  runTurn,
  type TurnOutcome,
  type TurnProgress,
} from '../../src/chat/core/turn'
import type { ConsentState, ScenarioOut, SummaryCreate, SummaryList, SummaryOut, TurnRequest } from '../../src/chat/core/types'
// UI modules whose logic needs no DOM to load: what they decide is tested here, the page in CI.
import { CLEAR_AFTER_MS, createAnnouncer, type Region } from '../../src/chat/ui/announcer'
import { KEYBOARD_DROP, keyboardInset, keyboardShown } from '../../src/chat/ui/keyboard'
import { SKY_KEY, parseSky, skyAttribute } from '../../src/ui/sky'

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'pure core tests: one project is enough')
})

const PAUSED = '7333'
const enc = new TextEncoder()

// ── Shared helpers ───────────────────────────────────────────────────────────────────────────

const frame = (type: string, data: Record<string, unknown> = {}): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`

const CANONICAL =
  frame('meta', { request_id: 'req-1' }) +
  ['Привіт', ', ', 'як ', 'ви? ', '😀🌿 ї'].map((text) => frame('token', { text })).join('') +
  frame('done', { finish_reason: 'stop', usage: null })

/** A body stream that delivers `chunks` and stays open unless `close` is set. */
function streamOf(chunks: readonly (string | Uint8Array)[], opts: { close?: boolean; onCancel?: () => void } = {}) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(typeof chunk === 'string' ? enc.encode(chunk) : chunk)
      if (opts.close !== false) c.close()
    },
    cancel() {
      opts.onCancel?.()
    },
  })
}

async function collect(body: ReadableStream<Uint8Array>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = []
  for await (const event of chatEvents(readFrames(body))) out.push(event)
  return out
}

/** A fake clock: timers run only inside advance(); a real macrotask drains promises between them. */
function fakeClock(start = 1_700_000_000_000) {
  let now = start
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const flush = async () => {
    for (let i = 0; i < 8; i++) await new Promise<void>((r) => setTimeout(r, 0))
  }
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number): unknown => {
      const id = ++seq
      timers.set(id, { at: now + Math.max(0, ms), fn })
      return id
    },
    clearTimeout: (handle: unknown) => {
      timers.delete(handle as number)
    },
    /** Timers still set: 0 once a turn has its outcome (no watchdog left running). */
    pending: () => timers.size,
    flush,
    async advance(ms: number) {
      const end = now + ms
      await flush()
      for (;;) {
        let nextId = -1
        let nextAt = Infinity
        for (const [id, t] of timers) {
          if (t.at <= end && t.at < nextAt) {
            nextAt = t.at
            nextId = id
          }
        }
        if (nextId === -1) break
        const t = timers.get(nextId)!
        timers.delete(nextId)
        now = t.at
        t.fn()
        await flush()
      }
      now = end
      await flush()
    },
  }
}

const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8', 'x-request-id': 'req-1' }

/** A live SSE body the test writes into. Like a real fetch, an abort of the request's signal
 *  errors the body with the signal's reason (`aborted` then says so). */
function live() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>
  let cancelled = false
  let aborted: unknown = null
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c
    },
    cancel() {
      cancelled = true
    },
  })
  return {
    body,
    push(text: string) {
      ctl.enqueue(enc.encode(text))
    },
    end() {
      ctl.close()
    },
    /** The connection drops mid-stream (a phone changing networks): read() fails, no abort. */
    fail() {
      ctl.error(new TypeError('network reset'))
    },
    wire(signal: AbortSignal) {
      signal.addEventListener(
        'abort',
        () => {
          aborted = signal.reason
          try {
            ctl.error(signal.reason)
          } catch {
            // already closed
          }
        },
        { once: true },
      )
    },
    get cancelled() {
      return cancelled
    },
    /** The reason the request's own signal aborted with, or null: proves the body was torn down. */
    get aborted() {
      return aborted
    },
  }
}

type Handler = (init: RequestInit, signal: AbortSignal) => Promise<Response>

const sse =
  (stream: ReturnType<typeof live>, headers: Record<string, string> = SSE_HEADERS): Handler =>
  async (_init, signal) => {
    stream.wire(signal)
    return new Response(stream.body, { status: 200, headers })
  }

/** The whole SSE body at once, closed afterwards. */
const sseWhole = (text: string): Handler => {
  const stream = live()
  return async (init, signal) => {
    const res = await sse(stream)(init, signal)
    stream.push(text)
    stream.end()
    return res
  }
}

const json =
  (status: number, body: unknown, headers: Record<string, string> = {}): Handler =>
  async () =>
    new Response(body === undefined ? '' : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'x-request-id': 'req-e', ...headers },
    })

const hang: Handler = (_init, signal) =>
  new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))

const offline: Handler = async () => {
  throw new TypeError('Failed to fetch')
}

const BODY: TurnRequest = turnBody(
  'free',
  [
    { role: 'assistant', content: 'Про що вам хочеться поговорити сьогодні?' },
    { role: 'user', content: 'Синтетичне повідомлення для тесту.' },
  ],
  [],
)

function turnHarness(handlers: readonly Handler[]) {
  const clock = fakeClock()
  const calls: { init: RequestInit; at: number }[] = []
  const fetchFn: FetchLike = (_url, init) => {
    calls.push({ init, at: clock.now() })
    const handler = handlers[calls.length - 1]
    if (handler === undefined) return Promise.reject(new Error(`unexpected request #${calls.length}`))
    return handler(init, init.signal as AbortSignal)
  }
  const api = createApi({ fetch: fetchFn, now: clock.now })
  const user = new AbortController()
  const page = new AbortController()
  const progress: TurnProgress[] = []
  let outcome: TurnOutcome | null = null
  const promise = runTurn(
    { api, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now },
    BODY,
    { signals: [user.signal, page.signal], onProgress: (p) => progress.push(p) },
  ).then((o) => {
    outcome = o
    return o
  })
  return {
    clock,
    calls,
    user,
    page,
    progress,
    promise,
    get outcome() {
      return outcome
    },
    /** The outcome once it is in, with no watchdog or retry timer left running. */
    async settled(): Promise<TurnOutcome> {
      const o = await promise
      expect(clock.pending(), 'timers left after the outcome').toBe(0)
      return o
    },
  }
}

// ── SSE parser (§5.3–5.4) ────────────────────────────────────────────────────────────────────

test.describe('sse', () => {
  test('canonical stream cut at every byte position gives the same events', async () => {
    const bytes = enc.encode(CANONICAL)
    const reference = await collect(streamOf([bytes]))
    expect(reference.map((e) => e.type)).toEqual(['meta', 'token', 'token', 'token', 'token', 'token', 'done'])
    const text = reference.flatMap((e) => (e.type === 'token' ? [e.text] : [])).join('')
    expect(text).toBe('Привіт, як ви? 😀🌿 ї')
    for (let i = 1; i < bytes.length; i++) {
      const events = await collect(streamOf([bytes.slice(0, i), bytes.slice(i)]))
      expect(events, `cut at byte ${i}`).toEqual(reference)
    }
    // And one byte per chunk.
    const single = await collect(streamOf(Array.from(bytes, (b) => Uint8Array.of(b))))
    expect(single).toEqual(reference)
  })

  test('CRLF and CR line endings, also when "\\r" and "\\n" land in different chunks', async () => {
    const crlf = CANONICAL.replace(/\n/g, '\r\n')
    const reference = await collect(streamOf([CANONICAL]))
    expect(await collect(streamOf([crlf]))).toEqual(reference)
    // Every cut, including each one between a "\r" and its "\n" inside a frame (where a doubled
    // line break would end the frame early).
    const crlfBytes = enc.encode(crlf)
    for (let i = 1; i < crlfBytes.length; i++) {
      expect(await collect(streamOf([crlfBytes.slice(0, i), crlfBytes.slice(i)])), `CRLF cut at byte ${i}`).toEqual(reference)
    }
    const at = crlf.indexOf('\r\n') + 1 // after "event: meta\r", before its "\n"
    expect(await collect(streamOf([crlf.slice(0, at), crlf.slice(at)]))).toEqual(reference)
    const cr = CANONICAL.replace(/\n/g, '\r')
    expect(await collect(streamOf([cr]))).toEqual(reference)
    // A CR at the end of a chunk, an empty chunk, then LF: still one line break.
    expect(await collect(streamOf([crlf.slice(0, at), new Uint8Array(0), crlf.slice(at)]))).toEqual(reference)
  })

  test('": ping" before meta, between tokens and glued to a frame in one chunk', async () => {
    const reference = await collect(streamOf([CANONICAL]))
    const parts = CANONICAL.split('\n\n').filter(Boolean).map((p) => `${p}\n\n`)
    const pinged = [': ping\n\n', parts[0]!, ': ping\n\n', parts[1]!, `: ping\n\n${parts[2]!}`, ...parts.slice(3)]
    expect(await collect(streamOf(pinged))).toEqual(reference)
    expect(await collect(streamOf([pinged.join('')]))).toEqual(reference)
  })

  test('several data lines are joined; a field without a colon, id and retry are ignored', async () => {
    const body = 'id: 7\nretry: 1000\nevent: token\nfoo\ndata: {"type":"token",\ndata: "text":"разом"}\n\n' + frame('done', { finish_reason: null })
    const events = await collect(streamOf([body]))
    expect(events).toEqual([
      { type: 'token', text: 'разом' },
      { type: 'done', finishReason: null },
    ])
  })

  test('unknown type, type ≠ event and broken JSON are skipped', async () => {
    const body =
      frame('meta', { request_id: 'r' }) +
      frame('future', { text: 'нове' }) +
      'event: token\ndata: {"type":"done","finish_reason":"stop"}\n\n' +
      'event: token\ndata: {"type":"token","text":\n\n' +
      'event: token\ndata: {"type":"token","text":5}\n\n' +
      frame('token', { text: 'ok' }) +
      frame('done', { finish_reason: 'stop' })
    const events = await collect(streamOf([body]))
    expect(events.map((e) => e.type)).toEqual(['meta', 'token', 'done'])
  })

  test('a tail without the blank line is dropped (the stream ended without a final event)', async () => {
    const events = await collect(streamOf([frame('meta', { request_id: 'r' }) + frame('token', { text: 'a' }) + 'event: done\ndata: {"type":"done"}']))
    expect(events.map((e) => e.type)).toEqual(['meta', 'token'])
  })

  test('an unfinished frame over 256 KB is a ProtocolError', async () => {
    const big = 'event: token\ndata: ' + 'x'.repeat(MAX_FRAME_BUFFER + 10)
    await expect(collect(streamOf([big], { close: false }))).rejects.toBeInstanceOf(ProtocolError)
  })

  test('one chunk of many valid frames, over 256 KB in total, is not an error', async () => {
    const piece = 'я'.repeat(60_000)
    const body = Array.from({ length: 6 }, () => frame('token', { text: piece })).join('') + frame('done', { finish_reason: 'stop' })
    expect(body.length).toBeGreaterThan(MAX_FRAME_BUFFER)
    const events = await collect(streamOf([body]))
    expect(events).toHaveLength(7)
    expect(events[6]).toEqual({ type: 'done', finishReason: 'stop' })
  })

  test('nothing after the final event is read, and the reader is cancelled', async () => {
    let cancelled = false
    const body = streamOf([frame('token', { text: 'a' }) + frame('done', { finish_reason: 'stop' }) + frame('token', { text: 'після' }), frame('token', { text: 'ще' })], {
      close: false,
      onCancel: () => (cancelled = true),
    })
    const events = await collect(body)
    expect(events.map((e) => e.type)).toEqual(['token', 'done'])
    expect(cancelled).toBe(true)
  })

  test('a crisis frame is sanitized on arrival and wins over a broken source', async () => {
    const body = frame('crisis', { source: 'whatever', helplines: { message: `лід ${PAUSED}`, notes: PAUSED } })
    const [event] = await collect(streamOf([body]))
    expect(event?.type).toBe('crisis')
    expect(JSON.stringify(event)).not.toContain(PAUSED)
    if (event?.type === 'crisis') expect(event.source).toBe('model')
  })

  test('an unknown error code becomes internal', async () => {
    const [event] = await collect(streamOf([frame('error', { code: 'quota', retryable: true })]))
    expect(event).toEqual({ type: 'error', code: 'internal', retryable: true })
  })
})

// ── Turn: watchdogs and retries (§5.5) ───────────────────────────────────────────────────────

test.describe('turn', () => {
  test('a normal stream gives done with the joined text; one request', async () => {
    const h = turnHarness([sseWhole(CANONICAL)])
    await h.clock.flush()
    const outcome = await h.settled()
    expect(outcome).toEqual({ kind: 'done', text: 'Привіт, як ви? 😀🌿 ї', finishReason: 'stop', requestId: 'req-1' })
    expect(h.calls).toHaveLength(1)
    expect(h.progress.filter((p) => p.type === 'token')).toHaveLength(5)
  })

  test('a stream that ends without a final event is retried exactly once, with the identical body', async () => {
    const h = turnHarness([sseWhole(frame('meta', { request_id: 'a' }) + frame('token', { text: 'частина' })), sseWhole(CANONICAL)])
    await h.clock.flush()
    const outcome = await h.settled()
    expect(outcome.kind).toBe('done')
    expect(h.calls).toHaveLength(2)
    expect(h.calls[1]!.init.body).toBe(h.calls[0]!.init.body)
    expect(JSON.parse(String(h.calls[1]!.init.body))).toEqual(JSON.parse(String(h.calls[0]!.init.body)))
    // The partial answer is dropped before the retry.
    const types = h.progress.map((p) => p.type)
    expect(types.indexOf('reset')).toBeGreaterThan(types.indexOf('token'))
    expect(types.indexOf('reset')).toBeLessThan(types.lastIndexOf('token'))
  })

  test('a second cut stream fails the turn as truncated, without a third request', async () => {
    const cut = frame('meta', { request_id: 'a' }) + frame('token', { text: 'x' })
    const h = turnHarness([sseWhole(cut), sseWhole(cut)])
    await h.clock.flush()
    expect(await h.settled()).toEqual({ kind: 'truncated' })
    expect(h.calls).toHaveLength(2)
  })

  test('503 llm_busy with Retry-After: 3 → two retries 3 s apart, then the error', async () => {
    const busy = json(503, { error: { code: 'llm_busy', message: 'busy' } }, { 'retry-after': '3' })
    const h = turnHarness([busy, busy, busy])
    await h.clock.advance(10_000)
    const outcome = await h.settled()
    expect(outcome.kind).toBe('http')
    if (outcome.kind === 'http') expect(outcome.error.code).toBe('llm_busy')
    expect(h.calls.map((c) => c.at - h.calls[0]!.at)).toEqual([0, 3000, 6000])
    expect(h.progress.filter((p) => p.type === 'busy-wait')).toHaveLength(2)
    const bodies = new Set(h.calls.map((c) => c.init.body))
    expect(bodies.size).toBe(1)
  })

  test('503, 503, then a stream → done after three requests', async () => {
    const busy = json(503, { error: { code: 'llm_busy', message: 'busy' } }, { 'retry-after': '5' })
    const h = turnHarness([busy, busy, sseWhole(CANONICAL)])
    await h.clock.advance(11_000)
    expect((await h.settled()).kind).toBe('done')
    expect(h.calls).toHaveLength(3)
  })

  test('SSE error llm_busy waits 5 s and retries; llm_failed is not retried', async () => {
    const h = turnHarness([sseWhole(frame('meta', { request_id: 'a' }) + frame('error', { code: 'llm_busy', retryable: true })), sseWhole(CANONICAL)])
    await h.clock.advance(4_999)
    expect(h.calls).toHaveLength(1)
    await h.clock.advance(2)
    expect((await h.settled()).kind).toBe('done')
    expect(h.calls).toHaveLength(2)

    const f = turnHarness([sseWhole(frame('meta', { request_id: 'a' }) + frame('token', { text: 'x' }) + frame('error', { code: 'llm_failed', retryable: true }))])
    await f.clock.advance(10_000)
    expect(await f.settled()).toEqual({ kind: 'streamError', code: 'llm_failed' })
    expect(f.calls).toHaveLength(1)
  })

  test('an abort while waiting for Retry-After → aborted at once, no retry, no timer left', async () => {
    for (const reason of ['user', 'pagehide'] as const) {
      const h = turnHarness([json(503, { error: { code: 'llm_busy', message: 'busy' } }, { 'retry-after': '5' })])
      await h.clock.advance(1_000)
      expect(h.progress.map((p) => p.type), reason).toEqual(['reset', 'busy-wait'])
      ;(reason === 'user' ? h.user : h.page).abort(reason)
      // No clock movement: the countdown itself must stop, not the retry that follows it.
      await h.clock.flush()
      expect(h.outcome, reason).toEqual({ kind: 'aborted', reason })
      expect(h.clock.pending(), reason).toBe(0)
      expect(h.progress.map((p) => p.type), reason).toEqual(['reset', 'busy-wait'])
      expect(h.calls).toHaveLength(1)
    }
  })

  test('HEADERS_TIMEOUT fires → headersTimeout, no automatic retry', async () => {
    const h = turnHarness([hang])
    await h.clock.advance(HEADERS_TIMEOUT - 1)
    expect(h.outcome).toBeNull()
    await h.clock.advance(1)
    expect(await h.settled()).toEqual({ kind: 'headersTimeout' })
    await h.clock.advance(60_000)
    expect(h.calls).toHaveLength(1)
  })

  test('45 s without a byte → truncated → one retry; pings reset the idle watchdog', async () => {
    const quiet = live()
    const h = turnHarness([sse(quiet), sseWhole(CANONICAL)])
    await h.clock.flush()
    quiet.push(frame('meta', { request_id: 'a' }))
    await h.clock.advance(IDLE_TIMEOUT - 1)
    expect(h.calls).toHaveLength(1)
    await h.clock.advance(1)
    expect((await h.settled()).kind).toBe('done')
    expect(h.calls).toHaveLength(2)

    const pinged = live()
    const p = turnHarness([sse(pinged)])
    await p.clock.flush()
    pinged.push(frame('meta', { request_id: 'b' }))
    for (let t = 0; t < 7; t++) {
      await p.clock.advance(15_000)
      pinged.push(': ping\n\n')
    }
    pinged.push(frame('token', { text: 'жива' }) + frame('done', { finish_reason: 'stop' }))
    await p.clock.flush()
    expect(await p.settled()).toMatchObject({ kind: 'done', text: 'жива' })
    expect(p.calls).toHaveLength(1)
  })

  test('a long answer: tokens every 2 s for 40 s still ends in done — the headers timer is gone', async () => {
    const slow = live()
    const h = turnHarness([sse(slow)])
    await h.clock.flush()
    slow.push(frame('meta', { request_id: 'a' }))
    let expected = ''
    for (let t = 0; t < 20; t++) {
      await h.clock.advance(2_000)
      slow.push(frame('token', { text: `${t} ` }))
      expected += `${t} `
    }
    slow.push(frame('done', { finish_reason: 'stop' }))
    await h.clock.flush()
    expect(await h.settled()).toMatchObject({ kind: 'done', text: expected })
    expect(h.calls).toHaveLength(1)
  })

  test('abort reasons decide the outcome: user and pagehide → aborted at once, the body torn down, never retried', async () => {
    for (const reason of ['user', 'pagehide'] as const) {
      const stream = live()
      const h = turnHarness([sse(stream)])
      await h.clock.flush()
      stream.push(frame('meta', { request_id: 'a' }) + frame('token', { text: 'част' }))
      await h.clock.flush()
      ;(reason === 'user' ? h.user : h.page).abort(reason)
      // No clock movement: the idle watchdog must not be what ends it (the server slot is freed
      // only when the request itself is aborted).
      await h.clock.flush()
      expect(h.outcome, reason).toEqual({ kind: 'aborted', reason })
      expect(stream.aborted, reason).toBe(reason)
      expect(h.clock.pending(), reason).toBe(0)
      expect(h.progress.map((p) => p.type), reason).toEqual(['meta', 'token'])
      await h.clock.advance(60_000)
      expect(h.calls).toHaveLength(1)
    }
  })

  test('headers, then not a single byte → idle after 45 s → one retry with the same body', async () => {
    const silent = live()
    const h = turnHarness([sse(silent), sseWhole(CANONICAL)])
    await h.clock.advance(IDLE_TIMEOUT - 1)
    expect(h.calls).toHaveLength(1)
    expect(h.outcome).toBeNull()
    await h.clock.advance(1)
    expect(h.outcome).toMatchObject({ kind: 'done' })
    expect(h.calls).toHaveLength(2)
    expect(h.calls[1]!.init.body).toBe(h.calls[0]!.init.body)
    expect(silent.aborted).toBe('idle')
    expect(await h.settled()).toMatchObject({ kind: 'done' })
  })

  test('a 503 whose body never arrives does not hang: idle → truncated → one retry', async () => {
    const stalled = live()
    const h = turnHarness([
      async (_init, signal) => {
        stalled.wire(signal)
        return new Response(stalled.body, { status: 503, headers: { 'content-type': 'application/json', 'retry-after': '5' } })
      },
      sseWhole(CANONICAL),
    ])
    await h.clock.advance(IDLE_TIMEOUT - 1)
    expect(h.calls).toHaveLength(1)
    expect(h.outcome).toBeNull()
    await h.clock.advance(1)
    expect(h.outcome).toMatchObject({ kind: 'done' })
    expect(h.calls).toHaveLength(2)
    expect(h.calls[1]!.init.body).toBe(h.calls[0]!.init.body)
    expect(stalled.aborted).toBe('idle')
    expect(h.progress.filter((p) => p.type === 'retry')).toEqual([{ type: 'retry', cause: 'truncated', attempt: 1 }])
    await h.settled()
  })

  test('the connection drops mid-stream (read() fails, no abort) → truncated → one retry, reset first', async () => {
    const broken = live()
    const h = turnHarness([sse(broken), sseWhole(CANONICAL)])
    await h.clock.flush()
    broken.push(frame('meta', { request_id: 'a' }) + frame('token', { text: 'частина' }))
    await h.clock.flush()
    broken.fail()
    await h.clock.flush()
    expect(h.outcome).toMatchObject({ kind: 'done', text: 'Привіт, як ви? 😀🌿 ї' })
    expect(h.calls).toHaveLength(2)
    expect(h.calls[1]!.init.body).toBe(h.calls[0]!.init.body)
    const types = h.progress.map((p) => p.type)
    expect(types.slice(0, 4)).toEqual(['meta', 'token', 'reset', 'retry'])
    expect(h.progress.filter((p) => p.type === 'retry')).toEqual([{ type: 'retry', cause: 'truncated', attempt: 1 }])
    await h.settled()
  })

  test('an unfinished frame over 256 KB (ProtocolError) → one retry with the same body', async () => {
    const huge = live()
    const h = turnHarness([sse(huge), sseWhole(CANONICAL)])
    await h.clock.flush()
    huge.push(frame('meta', { request_id: 'a' }) + 'event: token\ndata: ' + 'x'.repeat(MAX_FRAME_BUFFER + 10))
    await h.clock.flush()
    expect(h.outcome).toMatchObject({ kind: 'done' })
    expect(h.calls).toHaveLength(2)
    expect(h.calls[1]!.init.body).toBe(h.calls[0]!.init.body)
    expect(huge.cancelled).toBe(true)
    await h.settled()
  })

  test('manual linking without AbortSignal.any keeps the reason', () => {
    const a = new AbortController()
    const b = new AbortController()
    const { signal, dispose } = linkSignals([a.signal, b.signal])
    b.abort('idle')
    expect(signal.aborted).toBe(true)
    expect(signal.reason).toBe('idle')
    dispose()
    const done = new AbortController()
    done.abort('pagehide')
    expect(linkSignals([done.signal]).signal.reason).toBe('pagehide')
  })

  test('200 with text/html → internal; 429 → http rate_limited, never retried; TypeError → network', async () => {
    const html = turnHarness([async () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } })])
    await html.clock.flush()
    const o1 = await html.settled()
    expect(o1.kind === 'http' && o1.error.code).toBe('internal')

    const limited = turnHarness([json(429, { error: { code: 'rate_limited', message: 'slow down' } }, { 'retry-after': '12' })])
    await limited.clock.advance(120_000)
    const o2 = await limited.settled()
    expect(o2.kind === 'http' && o2.error.code).toBe('rate_limited')
    expect(o2.kind === 'http' && o2.error.retryAfterMs).toBe(12_000)
    expect(limited.calls).toHaveLength(1)

    const off = turnHarness([offline])
    await off.clock.advance(60_000)
    expect(await off.settled()).toEqual({ kind: 'network' })
    expect(off.calls).toHaveLength(1)
  })

  test('crisis after tokens → crisis with sanitized helplines', async () => {
    const h = turnHarness([
      sseWhole(frame('meta', { request_id: 'a' }) + frame('token', { text: 'текст' }) + frame('crisis', { source: 'model', helplines: { notes: PAUSED } })),
    ])
    await h.clock.flush()
    const outcome = await h.settled()
    expect(outcome.kind).toBe('crisis')
    expect(JSON.stringify(outcome)).not.toContain(PAUSED)
  })
})

// ── API client (§5.1) ────────────────────────────────────────────────────────────────────────

test.describe('api', () => {
  function recorder(responder: (url: string, init: RequestInit) => Response = () => new Response('{}', { status: 200 })) {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, init })
      return responder(url, init)
    }
    return { calls, api: createApi({ fetch: fetchFn }) }
  }

  test('default fetch mode, same-origin credentials and referrer policy, no-store', async () => {
    const { calls, api } = recorder()
    await api.me()
    await api.grant({ policy_version: '2026-10-06', kinds: ['age_18'] })
    await api.deleteMe()
    await api.logout()
    await api.turn(BODY, new AbortController().signal)
    for (const { init } of calls) {
      expect(init.mode).toBeUndefined()
      expect('mode' in init).toBe(false)
      expect('keepalive' in init).toBe(false)
      expect(init.credentials).toBe('same-origin')
      expect(init.referrerPolicy).toBe('same-origin')
      expect(init.cache).toBe('no-store')
      expect(Object.keys(init.headers as Record<string, string>)).not.toContain('Authorization')
    }
    expect(calls.map((c) => c.url)).toEqual(['/api/v1/me', '/api/v1/consents', '/api/v1/me', '/api/v1/auth/logout', '/api/v1/chat/turn'])
  })

  test('Content-Type: application/json on every unsafe method and every body, never on GET', async () => {
    const { calls, api } = recorder()
    await api.me()
    await api.consents()
    await api.summaries({ limit: 20, q: 'сон', cursor: 'c1' })
    await api.grant({ policy_version: 'v', kinds: ['age_18'] })
    await api.revoke('llm_transfer')
    await api.summarize(summarizeBody('free', BODY.messages))
    await api.saveSummary({ scenario: 'free', title: 't', bullets: ['b'], tags: [] })
    await api.deleteMe()
    await api.logout()
    await api.turn(BODY, new AbortController().signal)
    for (const { init } of calls) {
      const headers = init.headers as Record<string, string>
      if (init.method === 'GET') expect(headers['Content-Type'], `GET ${String(init.body)}`).toBeUndefined()
      else expect(headers['Content-Type']).toBe('application/json')
      if (init.body !== undefined) expect(headers['Content-Type']).toBe('application/json')
    }
    expect(calls[2]!.url).toBe('/api/v1/summaries?limit=20&cursor=c1&q=%D1%81%D0%BE%D0%BD')
    expect(calls.find((c) => c.url.endsWith('/chat/turn'))!.init.headers).toMatchObject({ Accept: 'text/event-stream' })
  })

  test('the turn body is built field by field: no timezone, no extra keys; revisit ids only for revisit', async () => {
    const { calls, api } = recorder()
    const sloppy = {
      scenario: 'free',
      timezone: 'Europe/Kyiv',
      revisit_summary_ids: ['should-go'],
      messages: [
        { role: 'assistant', content: 'Питання', extra: 1 },
        { role: 'user', content: 'Відповідь', timezone: 'UTC' },
      ],
    } as unknown as TurnRequest
    await api.turn(sloppy, new AbortController().signal)
    const body = JSON.parse(String(calls[0]!.init.body))
    expect(body).toEqual({ scenario: 'free', messages: [{ role: 'assistant', content: 'Питання' }, { role: 'user', content: 'Відповідь' }] })
    expect(String(calls[0]!.init.body)).not.toContain('timezone')

    const revisit = turnBody('revisit', BODY.messages, ['id-1', 'id-2'])
    expect(revisit.revisit_summary_ids).toEqual(['id-1', 'id-2'])
    expect('revisit_summary_ids' in turnBody('day', BODY.messages, ['id-1'])).toBe(false)
    expect(() => turnBody('revisit', BODY.messages, [])).toThrow()
    expect(Object.keys(summarizeBody('revisit', BODY.messages)).sort()).toEqual(['messages', 'scenario'])
  })

  test('JSON results are checked; a 200 that is not JSON is internal; a network failure is network', async () => {
    const { api } = recorder(() => new Response('<html>proxy</html>', { status: 200 }))
    const bad = await api.me()
    expect(bad.ok === false && bad.error.code).toBe('internal')

    const net = createApi({ fetch: async () => Promise.reject(new TypeError('offline')) })
    const r = await net.consents()
    expect(r.ok === false && r.error).toMatchObject({ status: 0, code: 'network' })

    const timeout = new AbortController()
    timeout.abort('timeout')
    const t = await createApi({ fetch: async (_u, init) => Promise.reject((init.signal as AbortSignal).reason) }).me(timeout.signal)
    expect(t.ok === false && t.error.code).toBe('timeout')

    const consents = createApi({
      fetch: async () =>
        new Response(
          JSON.stringify({ current_policy_version: 'v1', required: [], granted: [], missing: ['age_18', 'bogus'], llm_provider: { name: '', country: 'US' } }),
          { status: 200 },
        ),
    })
    const c = await consents.consents()
    expect(c.ok && c.data.missing).toEqual(['age_18'])
    expect(c.ok && c.data.llm_provider).toBeNull()
  })

  test('helplines() returns the sanitized object only', async () => {
    const { api } = recorder(() => new Response(JSON.stringify(RAW_HELPLINES), { status: 200 }))
    const r = await api.helplines()
    expect(r.ok).toBe(true)
    expect(JSON.stringify(r)).not.toContain(PAUSED)
    expect(JSON.stringify(r)).not.toContain('evil')
  })

  test('scenarios with an opening message the server would refuse are dropped', async () => {
    const list = [
      { id: 'free', title: 'Вільна', description: '', opening_message: 'Про що?', needs_summaries: false },
      { id: 'day', title: 'День', description: '', opening_message: 'я'.repeat(MAX_CONTENT + 1), needs_summaries: false },
    ]
    const r = await createApi({ fetch: async () => new Response(JSON.stringify(list), { status: 200 }) }).scenarios()
    expect(r.ok && r.data.map((s) => s.id)).toEqual(['free'])
    expect(GOOGLE_START).toBe('/api/v1/auth/google/start?next=/chat/')
  })
})

// ── Errors (§4.1) ────────────────────────────────────────────────────────────────────────────

test.describe('errors', () => {
  test('empty 502/504 and an HTML body do not throw and get a code from the status', async () => {
    const e502 = await fromResponse(new Response('', { status: 502 }))
    expect(e502).toMatchObject({ status: 502, code: 'upstream_unavailable', requestId: null })
    const e504 = await fromResponse(new Response(null, { status: 504 }))
    expect(e504.code).toBe('upstream_unavailable')
    const html = await fromResponse(new Response('<html>Bad gateway</html>', { status: 500, headers: { 'x-request-id': 'r-9' } }))
    expect(html).toMatchObject({ code: 'http_error', requestId: 'r-9' })
    expect(codeForStatus(413)).toBe('payload_too_large')
    expect(codeForStatus(405)).toBe('method_not_allowed')
    expect(codeForStatus(418)).toBe('http_error')
  })

  test('Retry-After: seconds, HTTP date, "abc", "0" and "999"', () => {
    const now = Date.parse('2026-10-07T12:00:00Z')
    expect(retryAfterMs('12', 'rate_limited', now)).toBe(12_000)
    expect(retryAfterMs('Wed, 07 Oct 2026 12:00:10 GMT', 'rate_limited', now)).toBe(10_000)
    expect(retryAfterMs('Wed, 07 Oct 2026 11:00:00 GMT', 'rate_limited', now)).toBe(1_000)
    expect(retryAfterMs('0', 'rate_limited', now)).toBe(1_000)
    expect(retryAfterMs('999', 'rate_limited', now)).toBe(60_000)
    // Assumption: a header that is neither seconds nor a date counts as absent.
    expect(retryAfterMs('abc', 'rate_limited', now)).toBeNull()
    expect(retryAfterMs('abc', 'llm_busy', now)).toBe(5_000)
    expect(retryAfterMs('1.5', 'llm_busy', now)).toBe(5_000)
    expect(retryAfterMs(null, 'llm_busy', now)).toBe(5_000)
    expect(retryAfterMs(null, 'internal', now)).toBeNull()
  })

  test('error.message never reaches the error the screen keeps; details are reduced', async () => {
    const marker = 'SERVER-PROSE-MARKER'
    const consent = await fromResponse(
      new Response(JSON.stringify({ error: { code: 'consent_required', message: marker, details: { missing: ['llm_transfer', 'x'], policy_version: 'v2' } } }), {
        status: 403,
      }),
    )
    expect(consent).toMatchObject({ code: 'consent_required', missing: ['llm_transfer'], policyVersion: 'v2' })
    expect(JSON.stringify(consent)).not.toContain(marker)
    expect(JSON.stringify(toUiError(consent))).not.toContain(marker)

    const crisis = await fromResponse(
      new Response(JSON.stringify({ error: { code: 'crisis_stop', message: marker, details: { helplines: RAW_HELPLINES } } }), { status: 409 }),
    )
    expect(crisis.helplines).not.toBeNull()
    expect(JSON.stringify(crisis)).not.toContain(PAUSED)

    const invalid = await fromResponse(
      new Response(JSON.stringify({ error: { code: 'validation_error', message: marker, details: [{ field: 'bullets.2', message: 'too long' }] } }), { status: 422 }),
    )
    expect(invalid.fields).toEqual(['bullets.2'])
    expect(JSON.stringify(invalid)).not.toContain('too long')
  })
})

// ── Helplines sanitizer (§6.3) ───────────────────────────────────────────────────────────────

const RAW_HELPLINES = {
  verified_at: '2026-10-05',
  review_every_days: 30,
  sources: ['https://example.invalid/sources'],
  notes: `Синтетична примітка: лінія ${PAUSED} на паузі.`,
  message: `Синтетичний лід із номером ${PAUSED}.`,
  emergency: [{ name: 'Підмінений номер', phone: '999', hours: 'завжди', free: true }],
  lines: [
    { name: 'Синтетична лінія підтримки', phone: '0 800 00 00 01', hours: 'цілодобово', free: true },
    { name: 'Лінія на паузі', phone: PAUSED, hours: 'цілодобово', free: true },
    { name: 'Розбитий номер', phone: '0 800 7 333 00', hours: 'цілодобово', free: true },
    { name: `Назва з ${PAUSED}`, phone: '0 800 00 00 02', hours: 'цілодобово', free: true },
    { name: 'Без вартості', phone: '116 000', hours: 'щодня', free: null },
    { name: 'Години з номером', phone: '0 800 00 00 03', hours: 'після 7-333', free: true },
    { name: 'Повноширинні цифри', phone: '0 800 00 00 04', hours: '７３３３', free: true },
    { name: 'Літери в номері', phone: '0 800 ABC', hours: 'цілодобово', free: true },
  ],
  abroad: { text: `За кордоном дзвоніть ${PAUSED}.`, url: 'https://evil.example' },
}

test.describe('helplines', () => {
  test('the paused number never survives, in any field or spelling', () => {
    const safe = sanitizeHelplines(RAW_HELPLINES)
    expect(JSON.stringify(safe)).not.toContain(PAUSED)
    expect(JSON.stringify(safe).replace(/\D/g, '')).not.toContain(PAUSED)
    expect(safe.lines.map((l) => l.name)).toEqual(['Синтетична лінія підтримки', 'Без вартості'])
    expect(safe.message).toBe(FALLBACK_MESSAGE)
    expect(safe.abroadText).toBe(FALLBACK_ABROAD)
  })

  test('112, 103 and the howareu link are constants; abroad.url and emergency are never read', () => {
    const safe = sanitizeHelplines(RAW_HELPLINES)
    expect(safe.howareuUrl).toBe(HOWAREU_URL)
    expect(HOWAREU_URL).toBe('https://howareu.com/hot-lines')
    expect(safe.emergency.map((e) => e.tel)).toEqual(['tel:112', 'tel:103'])
    expect(JSON.stringify(safe)).not.toContain('evil')
    expect(JSON.stringify(safe)).not.toContain('999')
    expect(JSON.stringify(safe)).not.toContain('example.invalid')
  })

  test('free: null says nothing about cost; tel: keeps digits and "+" only', () => {
    const safe = sanitizeHelplines(RAW_HELPLINES)
    expect(safe.lines[0]).toEqual({ name: 'Синтетична лінія підтримки', phone: '0 800 00 00 01', tel: 'tel:0800000001', hours: 'цілодобово', free: true })
    expect(safe.lines[1]!.free).toBe(false)
    const plus = sanitizeHelplines({ lines: [{ name: 'Міжнародна', phone: '+380 00 000 00 00', hours: null, free: true }] })
    expect(plus.lines[0]).toMatchObject({ tel: 'tel:+380000000000', hours: null })
  })

  test('a phone without enough digits, with "+" inside or doubled spaces is dropped: no dead tel: link', () => {
    const good = ['112', '+380 00 000 00 00', '0 800 00 00 05', '116 000']
    const bad = ['+++', '+ +', '1+2', '12+', '+ 1', '12', '0 800  00 00 06', ' + 380 00', '++380 00 000']
    const safe = sanitizeHelplines({ lines: [...good, ...bad].map((phone, i) => ({ name: `Лінія ${i}`, phone, hours: null, free: true })) })
    expect(safe.lines.map((l) => l.phone)).toEqual(good)
    expect(safe.lines.map((l) => l.tel)).toEqual(['tel:112', 'tel:+380000000000', 'tel:0800000005', 'tel:116000'])
  })

  test('broken shapes give the fallback or an empty list, never a throw', () => {
    for (const raw of [null, undefined, 'рядок', 42, [], { lines: 'рядок' }, { lines: null }, { lines: {} }, { message: 5, abroad: 'x' }]) {
      const safe = sanitizeHelplines(raw)
      expect(safe.lines).toEqual([])
      expect(safe.message).toBe(FALLBACK_MESSAGE)
      expect(safe.abroadText).toBe(FALLBACK_ABROAD)
    }
    expect(sanitizeHelplines(null)).toBe(FALLBACK)
    const many = sanitizeHelplines({ lines: Array.from({ length: 12 }, (_, i) => ({ name: `Лінія ${i}`, phone: '0 800 00 00 0' + (i % 10), hours: '', free: true })) })
    expect(many.lines).toHaveLength(8)
  })
})

// ── Limits and the draft (§3.7.3, §3.7.7, §7.2) ─────────────────────────────────────────────

test.describe('limits', () => {
  test('code points, not UTF-16 units: 4000 emoji go, 4001 do not; blank never goes', () => {
    expect(codePoints('😀'.repeat(4000))).toBe(4000)
    expect(checkMessage('😀'.repeat(4000))).toEqual({ ok: true })
    expect(checkMessage('😀'.repeat(4001))).toEqual({ ok: false, reason: 'too-long', length: 4001 })
    expect(checkMessage('   \n\t ')).toEqual({ ok: false, reason: 'blank' })
    expect(clampCodePoints('😀'.repeat(4005), MAX_CONTENT)).toBe('😀'.repeat(4000))
  })

  test('canSend on 197, 198 and 199 messages', () => {
    expect(canSend(197)).toBe(true)
    expect(canSend(198)).toBe(true)
    expect(canSend(199)).toBe(false)
  })

  test('the draft: empty theses dropped, trimmed body, index tables for a 422', () => {
    const draft: Draft = {
      title: '  Розмова про день  ',
      bullets: [
        { id: 'b0', text: 'перша', removed: true },
        { id: 'b1', text: '   ', removed: false },
        { id: 'b2', text: ' друга ', removed: false },
        { id: 'b3', text: 'третя', removed: false },
      ],
      tags: [
        { id: 't0', name: ' день ', source: 'ai' },
        { id: 't1', name: 'сон', source: 'user' },
      ],
    }
    const check = validateDraft(draft, 'day')
    expect(check.ok).toBe(true)
    if (!check.ok) return
    expect(check.value.body).toEqual({
      scenario: 'day',
      title: 'Розмова про день',
      bullets: ['друга', 'третя'],
      tags: [
        { name: 'день', source: 'ai' },
        { name: 'сон', source: 'user' },
      ],
    })
    expect(check.value.bulletIndex).toEqual(['b2', 'b3'])
    expect(check.value.tagIndex).toEqual(['t0', 't1'])
  })

  test('the draft: no thesis, long fields and duplicate tags are reported on their fields', () => {
    const bad = validateDraft(
      {
        title: 'я'.repeat(121),
        bullets: [{ id: 'b0', text: '  ', removed: false }],
        tags: [
          { id: 't0', name: 'Сон', source: 'ai' },
          { id: 't1', name: 'сон', source: 'user' },
        ],
      },
      'free',
    )
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.issues).toEqual([
      { field: 'title', reason: 'title-long' },
      { field: 'b0', reason: 'bullets-none' },
      { field: 't1', reason: 'tag-dup' },
    ])
    expect(newTagIssue('СОН', [{ id: 't0', name: 'сон', source: 'ai' }])).toBe('tag-dup')
    // Two names the server would merge into one tag are a duplicate here too.
    expect(newTagIssue("пам'ять", [{ id: 't0', name: 'Памʼять', source: 'ai' }])).toBe('tag-dup')
    expect(newTagIssue('Ёлка', [{ id: 't0', name: 'елка', source: 'ai' }])).toBe('tag-dup')
    expect(newTagIssue('нова тема', [{ id: 't0', name: 'Нова   тема', source: 'ai' }])).toBe('tag-dup')
    const merged = validateDraft(
      {
        title: 'Назва',
        bullets: [{ id: 'b0', text: 'теза', removed: false }],
        tags: [
          { id: 't0', name: 'памʼять', source: 'ai' },
          { id: 't1', name: "Пам'ять", source: 'user' },
        ],
      },
      'free',
    )
    expect(merged.ok === false && merged.issues).toEqual([{ field: 't1', reason: 'tag-dup' }])
    expect(normalize("  Памʼять’ ``Ё  ДЕНЬ\t")).toBe("пам'ять' ''е день")
    expect(newTagIssue('я'.repeat(41), [])).toBe('tag-long')
    expect(newTagIssue('новий', [])).toBeNull()
    expect(draftFromOut({ title: 't', bullets: ['a', 'b'], tags: ['x'] }).tags).toEqual([{ id: 't0', name: 'x', source: 'ai' }])
  })
})

test('country: US → «США», DE through Intl, XX → XX', () => {
  const names = new Intl.DisplayNames(['uk'], { type: 'region' })
  expect(countryName('US', names)).toBe('США')
  expect(countryName('DE', names)).toBe('Німеччина')
  expect(countryName('XX', names)).toBe('XX')
  expect(countryName('not a code', names)).toBe('NOT A CODE')
  expect(countryName('DE', null)).toBe('DE')
})

// ── State machine (§2.3–2.6) ─────────────────────────────────────────────────────────────────

const ME = { id: 'u-1', email: 'tester@example.com', created_at: '2026-10-01T10:00:00Z', consents_ok: true }
const KINDS = ['data_processing', 'llm_transfer', 'age_18'] as const
const CONSENTS_OK: ConsentState = {
  current_policy_version: '2026-10-06',
  required: [...KINDS],
  granted: KINDS.map((kind) => ({ kind, policy_version: '2026-10-06', granted_at: '2026-10-06T09:00:00Z' })),
  missing: [],
  llm_provider: { name: 'Ollama Cloud (Ollama Inc.)', country: 'US' },
}
const CONSENTS_NONE: ConsentState = { ...CONSENTS_OK, granted: [], missing: [...KINDS] }
const SCENARIOS: readonly ScenarioOut[] = [
  { id: 'free', title: 'Вільна розмова', description: 'd', opening_message: 'Про що вам хочеться поговорити сьогодні?', needs_summaries: false },
  { id: 'situation', title: 'Розбір ситуації', description: 'd', opening_message: 'Опишіть ситуацію, яка вас зачепила: що сталося?', needs_summaries: false },
  { id: 'day', title: 'Розбір дня', description: 'd', opening_message: 'Як минув ваш день? Що з нього запамʼяталося найбільше?', needs_summaries: false },
  { id: 'revisit', title: 'Повернення до теми', description: 'd', opening_message: 'До цієї теми ви вже поверталися. Що змінилося відтоді?', needs_summaries: true },
]
const SUMMARY: SummaryOut = {
  id: 's-1',
  scenario: 'day',
  title: 'Розмова про день',
  bullets: ['перша', 'друга', 'третя'],
  tags: [{ id: 'tg-1', name: 'день', source: 'ai' }],
  created_at: '2026-10-07T12:00:00Z',
  edited_at: null,
}
const DIARY = { items: [SUMMARY, { ...SUMMARY, id: 's-2', title: 'Інший запис' }], nextCursor: null }
const NOW = 1_700_000_000_000

function apiError(status: number, code: string, extra: Partial<ApiError> = {}): ApiError {
  return { status, code, requestId: null, retryAfterMs: null, missing: null, policyVersion: null, helplines: null, fields: [], ...extra }
}

/** Runs actions through reduce(), collecting every effect. */
function run(model: Model, ...actions: Action[]): { model: Model; effects: Effect[] } {
  const effects: Effect[] = []
  let m = model
  for (const action of actions) {
    const [next, fx] = reduce(m, action)
    m = next
    effects.push(...fx)
  }
  return { model: m, effects }
}

function booted(consents: ConsentState = CONSENTS_OK, search = ''): Model {
  return run(
    INITIAL_MODEL,
    { type: 'boot', search },
    { type: 'me/ok', purpose: 'boot', me: ME },
    { type: 'consents/ok', purpose: 'boot', consents },
    { type: 'scenarios/ok', items: SCENARIOS },
    { type: 'diary/ok', diary: DIARY },
  ).model
}

function chatOf(model: Model): ChatState {
  expect(model.state.s).toBe('chat')
  return model.state as ChatState
}

function turnEffect(effects: readonly Effect[]): Extract<Effect, { type: 'turn' }> {
  const fx = effects.find((e): e is Extract<Effect, { type: 'turn' }> => e.type === 'turn')
  expect(fx, 'a turn effect').toBeDefined()
  return fx!
}

/** chat → first message sent → answered. Returns the model after `done`. */
function answered(model: Model, text = 'Синтетичне перше повідомлення.'): Model {
  const sent = run(model, { type: 'chat/send', text })
  const { id } = turnEffect(sent.effects)
  return run(sent.model, { type: 'turn/outcome', id, now: NOW, outcome: { kind: 'done', text: 'Синтетична відповідь AI.', finishReason: 'stop', requestId: 'r' } }).model
}

const types = (effects: readonly Effect[]) => effects.map((e) => e.type)

test.describe('state: booting', () => {
  test('boot cleans the URL, keeps a whitelisted auth_error and asks GET /me with a 15 s deadline', () => {
    const { model, effects } = run(INITIAL_MODEL, { type: 'boot', search: '?auth_error=expired&x=1' })
    expect(model.state.s).toBe('booting')
    expect(model.ctx.authError).toBe('expired')
    expect(effects).toEqual([{ type: 'url/clean' }, { type: 'me', purpose: 'boot', timeoutMs: BOOT_TIMEOUT }])
    expect(authErrorFrom('?auth_error=<script>')).toBe('unknown')
    expect(authErrorFrom('?other=1')).toBeNull()
  })

  test('GET /me 200 → consents, scenarios and the diary in parallel; the auth_error becomes a banner', () => {
    const { model, effects } = run(INITIAL_MODEL, { type: 'boot', search: '?auth_error=not_invited' }, { type: 'me/ok', purpose: 'boot', me: ME })
    expect(types(effects)).toEqual(['url/clean', 'me', 'consents', 'scenarios', 'diary'])
    expect(model.ctx.authNotice).toEqual({ code: 'not_invited', email: ME.email })
    expect(model.ctx.authError).toBeNull()
  })

  test('missing consents → consent(first) at once, without waiting for /scenarios', () => {
    const { model } = run(
      INITIAL_MODEL,
      { type: 'boot', search: '' },
      { type: 'me/ok', purpose: 'boot', me: ME },
      { type: 'consents/ok', purpose: 'boot', consents: CONSENTS_NONE },
    )
    expect(model.state).toMatchObject({ s: 'consent', mode: 'first', resume: null })
  })

  test('no missing consents → chat, but only once /scenarios has settled; a failed /scenarios means only free', () => {
    const waiting = run(
      INITIAL_MODEL,
      { type: 'boot', search: '' },
      { type: 'me/ok', purpose: 'boot', me: ME },
      { type: 'consents/ok', purpose: 'boot', consents: CONSENTS_OK },
    ).model
    expect(waiting.state.s).toBe('booting')
    const ok = run(waiting, { type: 'scenarios/ok', items: SCENARIOS }).model
    expect(chatOf(ok).session.messages).toEqual([{ role: 'assistant', content: SCENARIOS[0]!.opening_message }])
    const failed = run(waiting, { type: 'scenarios/fail', error: apiError(502, 'upstream_unavailable') }).model
    const c = chatOf(failed)
    expect(c.session.scenario).toBe('free')
    expect(c.session.messages[0]!.content).toBe(FALLBACK_SCENARIO.opening_message)
    // The diary failing changes nothing for the conversation.
    expect(run(failed, { type: 'diary/fail', error: apiError(0, 'network') }).model.ctx.diary).toEqual({ status: 'failed' })
  })

  test('GET /me errors: 401 with and without auth_error, network/5xx/timeout → fatal', () => {
    const fail = (search: string, error: ApiError) =>
      run(INITIAL_MODEL, { type: 'boot', search }, { type: 'me/fail', purpose: 'boot', error }).model.state
    expect(fail('?auth_error=not_invited', apiError(401, 'unauthenticated'))).toEqual({ s: 'not-invited', hasSession: false, stale: null, pending: null, draft: null })
    expect(fail('?auth_error=expired', apiError(401, 'unauthenticated'))).toEqual({ s: 'signed-out', variant: 'fresh', notice: { kind: 'auth-error', code: 'expired' } })
    expect(fail('?auth_error=zzz', apiError(401, 'unauthenticated'))).toMatchObject({ notice: { code: 'unknown' } })
    expect(fail('', apiError(401, 'unauthenticated'))).toEqual({ s: 'signed-out', variant: 'fresh', notice: null })
    for (const error of [apiError(0, 'network'), apiError(502, 'upstream_unavailable'), apiError(0, 'timeout'), apiError(200, 'internal')]) {
      expect(fail('', error).s).toBe('fatal')
    }
    const consentsDown = run(INITIAL_MODEL, { type: 'boot', search: '' }, { type: 'me/ok', purpose: 'boot', me: ME }, { type: 'consents/fail', purpose: 'boot', error: apiError(500, 'internal') })
    expect(consentsDown.model.state.s).toBe('fatal')
  })

  test('fatal → «Спробувати ще раз» boots again', () => {
    const fatal = run(INITIAL_MODEL, { type: 'boot', search: '' }, { type: 'me/fail', purpose: 'boot', error: apiError(0, 'network') }).model
    const retry = run(fatal, { type: 'boot', search: '' })
    expect(retry.model.state.s).toBe('booting')
    expect(types(retry.effects)).toEqual(['url/clean', 'me'])
    // boot is ignored anywhere else.
    expect(run(booted(), { type: 'boot', search: '' }).model.state.s).toBe('chat')
  })
})

test.describe('state: consent', () => {
  const firstConsent = () =>
    run(INITIAL_MODEL, { type: 'boot', search: '' }, { type: 'me/ok', purpose: 'boot', me: ME }, { type: 'consents/ok', purpose: 'boot', consents: CONSENTS_NONE }).model

  test('all three boxes → POST {policy_version, kinds: missing}; fewer → an error and no POST', () => {
    const m = firstConsent()
    const two = run(m, { type: 'consent/agree', checked: ['age_18', 'llm_transfer'] })
    expect(two.effects).toEqual([])
    expect(two.model.state).toMatchObject({ error: { code: 'unchecked', fields: ['data_processing'] } })
    const all = run(m, { type: 'consent/agree', checked: [...KINDS] })
    expect(all.effects).toEqual([{ type: 'grant', body: { policy_version: '2026-10-06', kinds: [...KINDS] } }])
    // Granted → the conversation, once /scenarios is in.
    const granted = run(all.model, { type: 'grant/ok', consents: CONSENTS_OK })
    expect(granted.model.state.s).toBe('consent')
    expect(chatOf(run(granted.model, { type: 'scenarios/ok', items: SCENARIOS }).model).session.scenario).toBe('free')
  })

  test('no named provider → no consent at all', () => {
    const m = run(INITIAL_MODEL, { type: 'boot', search: '' }, { type: 'me/ok', purpose: 'boot', me: ME }, {
      type: 'consents/ok',
      purpose: 'boot',
      consents: { ...CONSENTS_NONE, llm_provider: null },
    }).model
    const r = run(m, { type: 'consent/agree', checked: [...KINDS] })
    expect(r.effects).toEqual([])
    expect(r.model.state).toMatchObject({ s: 'consent', error: { code: 'provider_missing' } })
  })

  test('409 policy_outdated in first → fresh GET, update mode, the banner; network/5xx/422 → a line, boxes kept', () => {
    const m = run(firstConsent(), { type: 'consent/agree', checked: [...KINDS] }).model
    const outdated = run(m, { type: 'grant/fail', error: apiError(409, 'policy_outdated', { policyVersion: '2026-11-01' }) })
    expect(outdated.effects).toEqual([{ type: 'consents', purpose: 'fresh' }])
    expect(outdated.model.state).toMatchObject({ s: 'consent', mode: 'update', policyChanged: true, loading: true })
    const fresh = run(outdated.model, { type: 'consents/ok', purpose: 'fresh', consents: { ...CONSENTS_NONE, current_policy_version: '2026-11-01' } })
    expect(fresh.model.state).toMatchObject({ loading: false, epoch: 1, policyChanged: true })
    for (const error of [apiError(0, 'network'), apiError(500, 'internal'), apiError(422, 'validation_error')]) {
      expect(run(m, { type: 'grant/fail', error }).model.state).toMatchObject({ s: 'consent', submitting: false, error: { code: error.code } })
    }
    // 401 without a conversation → signed out.
    expect(run(m, { type: 'grant/fail', error: apiError(401, 'unauthenticated') }).model.state.s).toBe('signed-out')
  })

  test('a failed fresh GET /consents keeps the screen with a line', () => {
    const m = run(firstConsent(), { type: 'consent/reload' }).model
    const r = run(m, { type: 'consents/fail', purpose: 'fresh', error: apiError(0, 'network') })
    expect(r.model.state).toMatchObject({ s: 'consent', loading: false, error: { code: 'consents_load_failed' } })
    // In `first` the boot data is the source: «Погоджуюся» still POSTs it.
    expect(run(r.model, { type: 'consent/agree', checked: [...KINDS] }).effects).toEqual([
      { type: 'grant', body: { policy_version: '2026-10-06', kinds: [...KINDS] } },
    ])
  })

  test('409, then the fresh GET fails: «Погоджуюся» asks for the terms again instead of re-POSTing the old version', () => {
    const m = run(firstConsent(), { type: 'consent/agree', checked: [...KINDS] }).model
    const outdated = run(m, { type: 'grant/fail', error: apiError(409, 'policy_outdated', { policyVersion: '2026-11-01' }) }).model
    const failed = run(outdated, { type: 'consents/fail', purpose: 'fresh', error: apiError(0, 'network') }).model
    expect(failed.state).toMatchObject({ s: 'consent', mode: 'update', loading: false, fresh: false })
    const agree = run(failed, { type: 'consent/agree', checked: [...KINDS] })
    expect(agree.effects).toEqual([{ type: 'consents', purpose: 'fresh' }])
    expect(agree.model.state).toMatchObject({ s: 'consent', loading: true, submitting: false, error: null })
    const v2 = { ...CONSENTS_NONE, current_policy_version: '2026-11-01' }
    const next = run(agree.model, { type: 'consents/ok', purpose: 'fresh', consents: v2 }, { type: 'consent/agree', checked: [...KINDS] })
    expect(next.effects.at(-1)).toEqual({ type: 'grant', body: { policy_version: '2026-11-01', kinds: [...KINDS] } })
  })
})

test.describe('state: chat', () => {
  test('changing the scenario before the first message replaces the opening; revisit opens no overlay and cannot send without ids', () => {
    const m = booted()
    const day = run(m, { type: 'chat/scenario', id: 'day' }).model
    expect(chatOf(day).session.messages[0]!.content).toBe(SCENARIOS[2]!.opening_message)
    const revisit = run(day, { type: 'chat/scenario', id: 'revisit' })
    expect(revisit.effects).toEqual([])
    expect(revisit.model.overlay).toEqual([])
    expect(chatOf(revisit.model).revertTo).toBe('day')
    const send = run(revisit.model, { type: 'chat/send', text: 'Що змінилося' })
    expect(send.effects).toEqual([])
    expect(chatOf(send.model).notice).toEqual({ kind: 'need-records' })
    expect(chatOf(send.model).pending).toBeNull()
  })

  test('«Надіслати» → waiting with a frozen request; the turn body ends with the user message and has no timezone', () => {
    const { model, effects } = run(booted(), { type: 'chat/send', text: 'Синтетичний текст' })
    const c = chatOf(model)
    expect(c.turn).toMatchObject({ p: 'waiting', stage: 'headers', trunc: 0, busy: 0 })
    expect(Object.isFrozen(c.pending!.request)).toBe(true)
    const { body } = turnEffect(effects)
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'Синтетичний текст' })
    expect(body.messages[0]).toEqual({ role: 'assistant', content: SCENARIOS[0]!.opening_message })
    expect(JSON.stringify(body)).not.toContain('timezone')
    expect('revisit_summary_ids' in body).toBe(false)
    expect(c.session.messages).toHaveLength(1) // I3: nothing joins the history before `done`
  })

  test('meta → token → done: the history gets request + the answer; length cut is remembered', () => {
    const sent = run(booted(), { type: 'chat/send', text: 'Привіт' })
    const { id } = turnEffect(sent.effects)
    const meta = run(sent.model, { type: 'turn/meta', id })
    expect(chatOf(meta.model).turn).toMatchObject({ p: 'waiting', stage: 'meta' })
    const streaming = run(meta.model, { type: 'turn/token', id, text: 'Від' }, { type: 'turn/token', id, text: 'повідь' })
    expect(chatOf(streaming.model).turn).toMatchObject({ p: 'streaming', partial: 'Відповідь' })
    expect(chatOf(streaming.model).session.messages).toHaveLength(1)
    const done = run(streaming.model, { type: 'turn/outcome', id, now: NOW, outcome: { kind: 'done', text: 'Відповідь', finishReason: 'length', requestId: 'r' } })
    const c = chatOf(done.model)
    expect(c.turn).toEqual({ p: 'idle' })
    expect(c.pending).toBeNull()
    expect(c.session.messages.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant'])
    expect(c.session.cut).toEqual([2])
  })

  test('an answer over 4000 code points joins the history cut to 4000; an empty one joins nothing', () => {
    const sent = run(booted(), { type: 'chat/send', text: 'Привіт' })
    const { id } = turnEffect(sent.effects)
    const long = run(sent.model, { type: 'turn/outcome', id, now: NOW, outcome: { kind: 'done', text: '😀'.repeat(4100), finishReason: 'stop', requestId: null } })
    expect(codePoints(chatOf(long.model).session.messages[2]!.content)).toBe(4000)
    const empty = run(sent.model, { type: 'turn/outcome', id, now: NOW, outcome: { kind: 'done', text: '  ', finishReason: 'stop', requestId: null } })
    expect(chatOf(empty.model).session.messages).toHaveLength(1)
    expect(chatOf(empty.model).pending).toMatchObject({ status: 'failed', error: { code: 'empty_reply' } })
  })

  test('I2: a second «Надіслати» while the turn runs sends nothing', () => {
    const first = run(booted(), { type: 'chat/send', text: 'Раз' })
    const second = run(first.model, { type: 'chat/send', text: 'Раз' }, { type: 'chat/send', text: 'Два' })
    expect(second.effects).toEqual([])
    expect(second.model).toBe(first.model) // not even a notice: the turn simply runs on
    expect(llmInFlight(second.model.state)).toBe(true)
    // Nor during a 429 countdown, nor while a summarize runs.
    const { id } = turnEffect(first.effects)
    const cooldown = run(first.model, { type: 'turn/outcome', id, now: NOW, outcome: { kind: 'http', error: apiError(429, 'rate_limited', { retryAfterMs: 5000 }) } }).model
    expect(run(cooldown, { type: 'chat/send', text: 'Три' }, { type: 'chat/resend' }).effects).toEqual([])
    const summarizing = run(answered(booted()), { type: 'chat/summarize' }).model
    expect(llmInFlight(summarizing.state)).toBe(true)
    expect(run(summarizing, { type: 'chat/send', text: 'Чотири' }, { type: 'chat/summarize' }).effects).toEqual([])
  })

  test('I3: crisis or an error after tokens leaves no partial text anywhere in the state', () => {
    const sent = run(booted(), { type: 'chat/send', text: 'Синтетична фраза' })
    const { id } = turnEffect(sent.effects)
    const streaming = run(sent.model, { type: 'turn/token', id, text: 'ЧАСТКОВИЙ-ТЕКСТ' }).model
    const crisis = run(streaming, { type: 'turn/outcome', id, now: NOW, outcome: { kind: 'crisis', source: 'model', helplines: sanitizeHelplines(RAW_HELPLINES) } })
    expect(crisis.model.state.s).toBe('crisis')
    expect(JSON.stringify(crisis.model)).not.toContain('ЧАСТКОВИЙ-ТЕКСТ')
    expect(JSON.stringify(crisis.model)).not.toContain(PAUSED)
    expect(types(crisis.effects)).toEqual(['abort', 'announcer/clear'])
    if (crisis.model.state.s === 'crisis') expect(crisis.model.state.stale.at(-1)).toEqual({ role: 'user', content: 'Синтетична фраза' })
    const failed = run(streaming, { type: 'turn/outcome', id, now: NOW, outcome: { kind: 'streamError', code: 'llm_failed' } })
    expect(JSON.stringify(failed.model)).not.toContain('ЧАСТКОВИЙ-ТЕКСТ')
    expect(chatOf(failed.model).pending).toMatchObject({ status: 'failed', error: { code: 'llm_failed' } })
    const reset = run(streaming, { type: 'turn/reset', id })
    expect(JSON.stringify(reset.model)).not.toContain('ЧАСТКОВИЙ-ТЕКСТ')
  })

  test('I4: «Надіслати ще раз» sends the very same request; «Змінити» puts the text back', () => {
    const sent = run(booted(), { type: 'chat/send', text: 'Текст для повтору' })
    const first = turnEffect(sent.effects)
    const failed = run(sent.model, { type: 'turn/outcome', id: first.id, now: NOW, outcome: { kind: 'network' } }).model
    expect(chatOf(failed).pending).toMatchObject({ status: 'failed', error: { code: 'network' } })
    const again = run(failed, { type: 'chat/resend' })
    const second = turnEffect(again.effects)
    expect(second.body).toEqual(first.body)
    expect(chatOf(again.model).pending!.request).toBe(chatOf(sent.model).pending!.request)
    const edit = run(failed, { type: 'chat/edit' })
    expect(edit.effects).toEqual([{ type: 'composer', text: 'Текст для повтору' }])
    expect(chatOf(edit.model).pending).toBeNull()
    // A new message while an unsent one waits: nothing goes, the person is told.
    const blocked = run(failed, { type: 'chat/send', text: 'Інше' })
    expect(blocked.effects).toEqual([])
    expect(chatOf(blocked.model).notice).toEqual({ kind: 'unsent' })
  })

  test('«Зупинити» → abort, idle, «stopped»; whatever the old turn still reports is ignored', () => {
    const sent = run(booted(), { type: 'chat/send', text: 'Стоп' })
    const { id } = turnEffect(sent.effects)
    const stopped = run(sent.model, { type: 'turn/token', id, text: 'част' }, { type: 'chat/stop' })
    expect(stopped.effects).toEqual([{ type: 'abort', target: 'turn' }])
    const c = chatOf(stopped.model)
    expect(c.turn).toEqual({ p: 'idle' })
    expect(c.pending).toMatchObject({ status: 'stopped' })
    const late = run(stopped.model, { type: 'turn/token', id, text: 'пізно' }, { type: 'turn/outcome', id, now: NOW, outcome: { kind: 'done', text: 'пізно', finishReason: 'stop', requestId: null } })
    expect(late.model).toEqual(stopped.model)
  })

  test('turn errors by §4.3: headers timeout, truncated, 413 block, 422, csrf twice, upstream', () => {
    const sent = run(booted(), { type: 'chat/send', text: 'Помилки' })
    const { id } = turnEffect(sent.effects)
    const out = (outcome: TurnOutcome) => run(sent.model, { type: 'turn/outcome', id, now: NOW, outcome })
    expect(chatOf(out({ kind: 'headersTimeout' }).model).pending?.error?.code).toBe('headers_timeout')
    expect(chatOf(out({ kind: 'truncated' }).model).pending?.error?.code).toBe('truncated')
    const tooLarge = chatOf(out({ kind: 'http', error: apiError(413, 'payload_too_large') }).model)
    expect(tooLarge.notice).toEqual({ kind: 'too-large' })
    expect(run(out({ kind: 'http', error: apiError(413, 'payload_too_large') }).model, { type: 'chat/resend' }).effects).toEqual([])
    expect(chatOf(out({ kind: 'http', error: apiError(422, 'validation_error') }).model).pending?.error?.code).toBe('validation_error')
    const csrf = out({ kind: 'http', error: apiError(403, 'csrf_failed') }).model
    expect(csrf.ctx.csrfFailures).toBe(1)
    const again = run(csrf, { type: 'chat/resend' })
    const csrf2 = run(again.model, { type: 'turn/outcome', id: turnEffect(again.effects).id, now: NOW, outcome: { kind: 'http', error: apiError(403, 'csrf_failed') } })
    expect(csrf2.model.ctx.csrfFailures).toBe(2)
    expect(chatOf(out({ kind: 'http', error: apiError(502, 'upstream_unavailable') }).model).pending?.error?.code).toBe('upstream_unavailable')
    expect(chatOf(out({ kind: 'aborted', reason: 'pagehide' }).model).pending?.status).toBe('stopped')
  })

  test('429 → cooldown with a timer, manual retry only after it ends', () => {
    const sent = run(booted(), { type: 'chat/send', text: 'Ліміт' })
    const { id } = turnEffect(sent.effects)
    const limited = run(sent.model, { type: 'turn/outcome', id, now: NOW, outcome: { kind: 'http', error: apiError(429, 'rate_limited', { retryAfterMs: 12_000 }) } })
    const c = chatOf(limited.model)
    expect(c.turn).toEqual({ p: 'cooldown', until: NOW + 12_000 })
    expect(limited.effects).toEqual([{ type: 'after', ms: 12_000, action: { type: 'cooldown/end', until: NOW + 12_000 } }])
    expect(run(limited.model, { type: 'chat/resend' }).effects).toEqual([])
    expect(run(limited.model, { type: 'cooldown/end', until: NOW + 1 }).model).toEqual(limited.model)
    const over = run(limited.model, { type: 'cooldown/end', until: NOW + 12_000 }).model
    expect(chatOf(over).turn).toEqual({ p: 'idle' })
    expect(types(run(over, { type: 'chat/resend' }).effects)).toEqual(['turn'])
    // Without a usable Retry-After the countdown is a minute.
    const noHeader = run(sent.model, { type: 'turn/outcome', id, now: NOW, outcome: { kind: 'http', error: apiError(429, 'rate_limited') } })
    expect(chatOf(noHeader.model).turn).toEqual({ p: 'cooldown', until: NOW + 60_000 })
  })

  test('busy-wait and retries are mirrored from runTurn', () => {
    const sent = run(booted(), { type: 'chat/send', text: 'Зайнято' })
    const { id } = turnEffect(sent.effects)
    const wait = run(sent.model, { type: 'turn/busy-wait', id, until: NOW + 5000, retry: 1 }).model
    expect(chatOf(wait).turn).toMatchObject({ p: 'busy-wait', until: NOW + 5000, busy: 1 })
    expect(chatOf(run(wait, { type: 'turn/retry', id, cause: 'busy', attempt: 1 }).model).turn).toMatchObject({ p: 'waiting', busy: 1 })
    const trunc = run(sent.model, { type: 'turn/retry', id, cause: 'truncated', attempt: 1 }).model
    expect(chatOf(trunc).turn).toMatchObject({ p: 'waiting', trunc: 1 })
    // «Скасувати» in the countdown is «Зупинити».
    expect(run(wait, { type: 'chat/stop' }).effects).toEqual([{ type: 'abort', target: 'turn' }])
  })

  test('the 200-message limit: no turn beyond it, the summarize body stays ≤ 200', () => {
    let m = booted()
    for (let i = 0; i < 98; i++) m = answered(m, `Повідомлення ${i}`)
    expect(chatOf(m).session.messages).toHaveLength(197)
    m = answered(m, 'Останнє')
    expect(chatOf(m).session.messages).toHaveLength(199)
    expect(run(m, { type: 'chat/send', text: 'Ще одне' }).effects).toEqual([])
    const summarize = run(m, { type: 'chat/summarize' })
    const fx = summarize.effects.find((e): e is Extract<Effect, { type: 'summarize' }> => e.type === 'summarize')!
    expect(fx.body.messages.length).toBeLessThanOrEqual(200)
  })
})

test.describe('state: protected-call failures carry the unsent message', () => {
  function failTurn(error: ApiError) {
    const sent = run(booted(), { type: 'chat/send', text: 'НЕПОДАНИЙ-ТЕКСТ' })
    const first = turnEffect(sent.effects)
    const r = run(sent.model, { type: 'turn/outcome', id: first.id, now: NOW, outcome: { kind: 'http', error } })
    return { ...r, first }
  }

  test('401 → session-expired with pending; «Увійти знову» goes through confirm(relogin)', () => {
    const { model } = failTurn(apiError(401, 'unauthenticated'))
    expect(model.state).toMatchObject({ s: 'session-expired', pending: { text: 'НЕПОДАНИЙ-ТЕКСТ', status: 'failed' }, draft: null })
    expect(leaveGuard(model.state)).toBe(true)
    const relogin = run(model, { type: 'confirm/open', kind: 'relogin' }, { type: 'confirm/accept' })
    expect(relogin.effects).toEqual([{ type: 'navigate', href: GOOGLE_START }])
  })

  test('403 not_invited → not-invited(hasSession) with pending', () => {
    const { model } = failTurn(apiError(403, 'not_invited'))
    expect(model.state).toMatchObject({ s: 'not-invited', hasSession: true, pending: { text: 'НЕПОДАНИЙ-ТЕКСТ' } })
  })

  test('403 consent_required → consent(resume) with a fresh GET; after consent the turn repeats with the same body (I4)', () => {
    const { model, effects, first } = failTurn(apiError(403, 'consent_required', { missing: [...KINDS], policyVersion: '2026-10-06' }))
    expect(effects).toEqual([{ type: 'consents', purpose: 'fresh' }])
    expect(model.state).toMatchObject({ s: 'consent', mode: 'resume', policyChanged: false, loading: true, pending: { text: 'НЕПОДАНИЙ-ТЕКСТ' } })
    if (model.state.s === 'consent') expect(model.state.resume).toMatchObject({ kind: 'turn' })
    const fresh = run(model, { type: 'consents/ok', purpose: 'fresh', consents: CONSENTS_NONE })
    expect(fresh.effects).toEqual([])
    const agree = run(fresh.model, { type: 'consent/agree', checked: [...KINDS] })
    expect(agree.effects).toEqual([{ type: 'grant', body: { policy_version: '2026-10-06', kinds: [...KINDS] } }])
    const granted = run(agree.model, { type: 'grant/ok', consents: CONSENTS_OK })
    expect(granted.model.state.s).toBe('chat')
    expect(turnEffect(granted.effects).body).toEqual(first.body)
  })

  test('consent(resume) and a fresh missing = [] → no POST, the turn repeats at once', () => {
    const { model, first } = failTurn(apiError(403, 'consent_required', { missing: ['llm_transfer'] }))
    const fresh = run(model, { type: 'consents/ok', purpose: 'fresh', consents: CONSENTS_OK })
    expect(types(fresh.effects)).toEqual(['turn'])
    expect(turnEffect(fresh.effects).body).toEqual(first.body)
  })

  test('new terms mid-session: policyChanged; 409 in resume keeps mode and resume, and the turn still repeats', () => {
    const { model, first } = failTurn(apiError(403, 'consent_required', { missing: [...KINDS], policyVersion: '2026-11-01' }))
    expect(model.state).toMatchObject({ s: 'consent', mode: 'resume', policyChanged: true })
    const v2 = { ...CONSENTS_NONE, current_policy_version: '2026-11-01' }
    const agree = run(model, { type: 'consents/ok', purpose: 'fresh', consents: v2 }, { type: 'consent/agree', checked: [...KINDS] })
    expect(agree.effects.at(-1)).toEqual({ type: 'grant', body: { policy_version: '2026-11-01', kinds: [...KINDS] } })
    const outdated = run(agree.model, { type: 'grant/fail', error: apiError(409, 'policy_outdated', { policyVersion: '2026-12-01' }) })
    expect(outdated.model.state).toMatchObject({ s: 'consent', mode: 'resume', policyChanged: true, loading: true })
    if (outdated.model.state.s === 'consent' && model.state.s === 'consent') expect(outdated.model.state.resume).toBe(model.state.resume)
    const v3 = { ...CONSENTS_NONE, current_policy_version: '2026-12-01' }
    const retry = run(outdated.model, { type: 'consents/ok', purpose: 'fresh', consents: v3 }, { type: 'consent/agree', checked: [...KINDS] }, { type: 'grant/ok', consents: { ...CONSENTS_OK, current_policy_version: '2026-12-01' } })
    expect(turnEffect(retry.effects).body).toEqual(first.body)
  })

  test('consent(resume) and a failed fresh GET: «Погоджуюся» never acts on the boot data (missing = [] there)', () => {
    const { model } = failTurn(apiError(403, 'consent_required', { missing: [...KINDS], policyVersion: '2026-10-06' }))
    // ctx.consents is still the boot answer: missing = [].
    expect(model.ctx.consents?.missing).toEqual([])
    const failed = run(model, { type: 'consents/fail', purpose: 'fresh', error: apiError(0, 'network') }).model
    expect(failed.state).toMatchObject({ s: 'consent', mode: 'resume', loading: false, error: { code: 'consents_load_failed' } })
    const agree = run(failed, { type: 'consent/agree', checked: [...KINDS] })
    // Exactly a new GET: no turn repeated without consent, no grant.
    expect(agree.effects).toEqual([{ type: 'consents', purpose: 'fresh' }])
    expect(agree.model.state).toMatchObject({ s: 'consent', mode: 'resume', loading: true, pending: { text: 'НЕПОДАНИЙ-ТЕКСТ' } })
    const ok = run(agree.model, { type: 'consents/ok', purpose: 'fresh', consents: CONSENTS_NONE }, { type: 'consent/agree', checked: [...KINDS] })
    expect(ok.effects.at(-1)).toEqual({ type: 'grant', body: { policy_version: '2026-10-06', kinds: [...KINDS] } })
  })

  test('401 on the consent screen in resume → session-expired, the unsent message kept', () => {
    const { model } = failTurn(apiError(403, 'consent_required', { missing: [...KINDS] }))
    const r = run(model, { type: 'consents/fail', purpose: 'fresh', error: apiError(401, 'unauthenticated') })
    expect(r.model.state).toMatchObject({ s: 'session-expired', pending: { text: 'НЕПОДАНИЙ-ТЕКСТ' } })
  })
})

test.describe('state: revisit', () => {
  function revisitChat() {
    return run(booted(), { type: 'chat/scenario', id: 'revisit' }).model
  }

  test('the picker: open → list; 1..5 chosen; confirm sets the ids; Esc with none restores the scenario', () => {
    const opened = run(revisitChat(), { type: 'revisit/open' })
    expect(opened.effects).toEqual([{ type: 'pick-list', purpose: 'pick', q: '', cursor: null }])
    const loaded = run(opened.model, { type: 'revisit/list-ok', purpose: 'pick', q: '', cursor: null, diary: DIARY }).model
    const closed = run(loaded, { type: 'overlay/close' }).model
    expect(chatOf(closed).session.scenario).toBe('free')
    const six = run(loaded, ...['a', 'b', 'c', 'd', 'e', 'f'].map((id): Action => ({ type: 'revisit/toggle', id }))).model
    expect(six.overlay[0]).toMatchObject({ selected: ['a', 'b', 'c', 'd', 'e'] })
    const chosen = run(six, { type: 'revisit/confirm' }).model
    expect(chosen.overlay).toEqual([])
    expect(chatOf(chosen).session.revisitIds).toEqual(['a', 'b', 'c', 'd', 'e'])
    const sent = run(chosen, { type: 'chat/send', text: 'Повертаюся' })
    expect(turnEffect(sent.effects).body.revisit_summary_ids).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  test('the picker search sends what the server takes: ≤ 200 code points, no NUL', () => {
    const opened = run(revisitChat(), { type: 'revisit/open' }).model
    const long = run(opened, { type: 'revisit/search', q: `  сон\u0000${'😀'.repeat(250)}  ` })
    const fx = long.effects[0] as Extract<Effect, { type: 'pick-list' }>
    expect(fx.type).toBe('pick-list')
    expect(fx.q.includes('\u0000')).toBe(false)
    expect(codePoints(fx.q)).toBe(MAX_QUERY)
    expect(fx.q.startsWith('сон😀')).toBe(true)
    expect(long.model.overlay[0]).toMatchObject({ o: 'revisit-pick', q: fx.q, loading: true })
    // The answer for that query still lands.
    const ok = run(long.model, { type: 'revisit/list-ok', purpose: 'pick', q: fx.q, cursor: null, diary: DIARY }).model
    expect(ok.overlay[0]).toMatchObject({ loading: false, list: DIARY })
    expect((run(opened, { type: 'revisit/search', q: ' сон ' }).effects[0] as Extract<Effect, { type: 'pick-list' }>).q).toBe('сон')
  })

  test('404 on a revisit turn → the picker again with the banner; a new choice repeats the same turn', () => {
    const chosen = run(revisitChat(), { type: 'revisit/open' }, { type: 'revisit/toggle', id: 'old' }, { type: 'revisit/confirm' }).model
    const sent = run(chosen, { type: 'chat/send', text: 'Повертаюся' })
    const first = turnEffect(sent.effects)
    const notFound = run(sent.model, { type: 'turn/outcome', id: first.id, now: NOW, outcome: { kind: 'http', error: apiError(404, 'not_found') } })
    expect(notFound.effects).toEqual([{ type: 'pick-list', purpose: 'pick-404', q: '', cursor: null }])
    const reopened = run(notFound.model, { type: 'revisit/list-ok', purpose: 'pick-404', q: '', cursor: null, diary: DIARY }).model
    expect(reopened.overlay[0]).toMatchObject({ o: 'revisit-pick', gone: true, revertTo: null })
    const again = run(reopened, { type: 'revisit/toggle', id: 's-1' }, { type: 'revisit/confirm' })
    const second = turnEffect(again.effects)
    expect(second.body.messages).toEqual(first.body.messages)
    expect(second.body.revisit_summary_ids).toEqual(['s-1'])
    // Esc after a 404 keeps revisit and the unsent message.
    const esc = run(reopened, { type: 'overlay/close' }).model
    expect(chatOf(esc).session.scenario).toBe('revisit')
    expect(chatOf(esc).pending?.status).toBe('failed')
    // 404 and an empty diary → the block, then «Почати вільну розмову» gives the text back.
    const gone = run(notFound.model, { type: 'revisit/list-ok', purpose: 'pick-404', q: '', cursor: null, diary: { items: [], nextCursor: null } })
    expect(chatOf(gone.model).notice).toEqual({ kind: 'revisit-gone' })
    expect(gone.model.overlay).toEqual([])
    const free = run(gone.model, { type: 'chat/start-free' })
    expect(free.effects).toEqual([{ type: 'composer', text: 'Повертаюся' }])
    expect(chatOf(free.model).session.scenario).toBe('free')
  })
})

test.describe('state: theses', () => {
  function summarizing() {
    const m = run(answered(booted()), { type: 'confirm/open', kind: 'end' }).model
    expect(m.overlay[0]).toMatchObject({ o: 'confirm', kind: 'end' })
    return run(m, { type: 'confirm/accept' })
  }
  const summarizeFx = (effects: readonly Effect[]) => effects.find((e): e is Extract<Effect, { type: 'summarize' }> => e.type === 'summarize')!

  test('«Підсумувати» → summarizing, body exactly {scenario, messages}, 150 s; the dialog closes', () => {
    const { model, effects } = summarizing()
    expect(model.state.s).toBe('summarizing')
    expect(model.overlay).toEqual([])
    const fx = summarizeFx(effects)
    expect(Object.keys(fx.body).sort()).toEqual(['messages', 'scenario'])
    expect(fx.timeoutMs).toBe(SUMMARIZE_TIMEOUT)
    expect(fx.delayMs).toBe(0)
  })

  test('200 → review; 409 crisis_stop → crisis; 503 → two automatic retries, then a line', () => {
    const { model, effects } = summarizing()
    const { id } = summarizeFx(effects)
    const review = run(model, { type: 'summarize/ok', id, draft: { title: 'Розмова про день', bullets: ['a', 'b', 'c'], tags: ['день'] } })
    expect(review.model.state).toMatchObject({ s: 'review', saving: 'idle', draft: { title: 'Розмова про день' } })
    const crisis = run(model, { type: 'summarize/fail', id, now: NOW, error: apiError(409, 'crisis_stop', { helplines: FALLBACK }) })
    expect(crisis.model.state.s).toBe('crisis')
    const busy = apiError(503, 'llm_busy', { retryAfterMs: 5000 })
    const b1 = run(model, { type: 'summarize/fail', id, now: NOW, error: busy })
    const fx1 = summarizeFx(b1.effects)
    expect(fx1.delayMs).toBe(5000)
    // The countdown is not an error: the request still counts as in flight (I2).
    expect(b1.model.state).toMatchObject({ s: 'summarizing', busy: 1, until: NOW + 5000, error: null })
    const b2 = run(b1.model, { type: 'summarize/fail', id: fx1.id, now: NOW, error: busy })
    const fx2 = summarizeFx(b2.effects)
    const b3 = run(b2.model, { type: 'summarize/fail', id: fx2.id, now: NOW, error: busy })
    expect(b3.effects).toEqual([])
    expect(b3.model.state).toMatchObject({ s: 'summarizing', busy: 2, error: { code: 'llm_busy' } })
    for (const error of [apiError(502, 'llm_failed'), apiError(0, 'timeout'), apiError(422, 'validation_error'), apiError(413, 'payload_too_large')]) {
      expect(run(model, { type: 'summarize/fail', id, now: NOW, error }).model.state).toMatchObject({ s: 'summarizing', error: { code: error.code } })
    }
  })

  test('I2: no second summarize beside the scheduled llm_busy retry; after a 429 only once the countdown is over', () => {
    const { model, effects } = summarizing()
    const { id } = summarizeFx(effects)
    const busy = apiError(503, 'llm_busy', { retryAfterMs: 5000 })
    const b1 = run(model, { type: 'summarize/fail', id, now: NOW, error: busy })
    expect(llmInFlight(b1.model.state)).toBe(true)
    const early = run(b1.model, { type: 'summarize/retry', now: NOW + 1000 })
    expect(early.effects).toEqual([])
    expect(early.model).toBe(b1.model)
    // After the two automatic retries the error is final, and «Скласти ще раз» goes at once.
    const b2 = run(b1.model, { type: 'summarize/fail', id: summarizeFx(b1.effects).id, now: NOW, error: busy })
    const b3 = run(b2.model, { type: 'summarize/fail', id: summarizeFx(b2.effects).id, now: NOW, error: busy })
    expect(llmInFlight(b3.model.state)).toBe(false)
    const manual = run(b3.model, { type: 'summarize/retry', now: NOW })
    expect(types(manual.effects)).toEqual(['summarize'])
    expect(summarizeFx(manual.effects).delayMs).toBe(0)
    expect(manual.model.state).toMatchObject({ s: 'summarizing', busy: 0, error: null })

    const limited = run(model, { type: 'summarize/fail', id, now: NOW, error: apiError(429, 'rate_limited', { retryAfterMs: 12_000 }) }).model
    expect(limited.state).toMatchObject({ s: 'summarizing', until: NOW + 12_000, error: { code: 'rate_limited' } })
    expect(run(limited, { type: 'summarize/retry', now: NOW + 11_999 }).effects).toEqual([])
    expect(types(run(limited, { type: 'summarize/retry', now: NOW + 12_000 }).effects)).toEqual(['summarize'])
  })

  test('«Скасувати» → back to the same conversation and an abort; a late answer is ignored', () => {
    const { model, effects } = summarizing()
    const { id } = summarizeFx(effects)
    const back = run(model, { type: 'summarize/cancel' })
    expect(back.effects).toEqual([{ type: 'abort', target: 'summarize' }])
    expect(chatOf(back.model).session).toBe(model.state.s === 'summarizing' ? model.state.session : null)
    expect(run(back.model, { type: 'summarize/ok', id, draft: { title: 't', bullets: ['a'], tags: [] } }).model).toEqual(back.model)
  })

  /** A conversation with an AI reply and a second message that did not go (network). */
  function withUnsent(error: TurnOutcome = { kind: 'network' }) {
    const sent = run(answered(booted()), { type: 'chat/send', text: 'ДРУГЕ НЕПОДАНЕ' })
    const m = run(sent.model, { type: 'turn/outcome', id: turnEffect(sent.effects).id, now: NOW, outcome: error }).model
    expect(chatOf(m).pending).toMatchObject({ text: 'ДРУГЕ НЕПОДАНЕ', status: 'failed' })
    return m
  }

  test('an unsent message survives the theses: back from summarizing and from review, and into every screen that keeps it', () => {
    const m = withUnsent()
    const s = run(m, { type: 'confirm/open', kind: 'end' }, { type: 'confirm/accept' })
    expect(s.model.state).toMatchObject({ s: 'summarizing', pending: { text: 'ДРУГЕ НЕПОДАНЕ' } })
    // The theses are of the confirmed messages only.
    expect(JSON.stringify(summarizeFx(s.effects).body)).not.toContain('ДРУГЕ НЕПОДАНЕ')
    expect(leaveGuard(s.model.state)).toBe(true)
    const cancelled = chatOf(run(s.model, { type: 'summarize/cancel' }).model)
    expect(cancelled.pending).toMatchObject({ text: 'ДРУГЕ НЕПОДАНЕ', status: 'failed' })
    expect(cancelled.notice).toBeNull()

    const { id } = summarizeFx(s.effects)
    const review = run(s.model, { type: 'summarize/ok', id, draft: { title: 'Розмова про день', bullets: ['a'], tags: [] } }).model
    expect(review.state).toMatchObject({ s: 'review', pending: { text: 'ДРУГЕ НЕПОДАНЕ' } })
    expect(chatOf(run(review, { type: 'review/back' }).model).pending).toMatchObject({ text: 'ДРУГЕ НЕПОДАНЕ' })
    // «Скласти заново» keeps it too.
    const again = run(review, { type: 'confirm/open', kind: 'regenerate' }, { type: 'confirm/accept' }).model
    expect(again.state).toMatchObject({ s: 'summarizing', pending: { text: 'ДРУГЕ НЕПОДАНЕ' } })

    // 401 / 403 on summarize or save: the read-only copy carries it.
    expect(run(s.model, { type: 'summarize/fail', id, now: NOW, error: apiError(401, 'unauthenticated') }).model.state).toMatchObject({
      s: 'session-expired',
      pending: { text: 'ДРУГЕ НЕПОДАНЕ' },
    })
    const save = run(review, { type: 'review/save' })
    const saveId = (save.effects[0] as Extract<Effect, { type: 'save' }>).id
    expect(run(save.model, { type: 'save/fail', id: saveId, error: apiError(403, 'not_invited') }).model.state).toMatchObject({
      s: 'not-invited',
      pending: { text: 'ДРУГЕ НЕПОДАНЕ' },
    })
    // consent_required on summarize → consent(resume) with it → the summarize repeats, still with it.
    const resume = run(s.model, { type: 'summarize/fail', id, now: NOW, error: apiError(403, 'consent_required', { missing: ['llm_transfer'] }) }).model
    expect(resume.state).toMatchObject({ s: 'consent', mode: 'resume', pending: { text: 'ДРУГЕ НЕПОДАНЕ' } })
    const resumed = run(resume, { type: 'consents/ok', purpose: 'fresh', consents: CONSENTS_OK })
    expect(resumed.model.state).toMatchObject({ s: 'summarizing', pending: { text: 'ДРУГЕ НЕПОДАНЕ' } })
    // A 401 on GET /summaries while on review keeps it as well.
    expect(run(review, { type: 'diary/fail', error: apiError(401, 'unauthenticated') }).model.state).toMatchObject({
      s: 'session-expired',
      pending: { text: 'ДРУГЕ НЕПОДАНЕ' },
    })
  })

  test('413: «Підсумувати» from the block still works, and «Скасувати» brings the block back', () => {
    const m = withUnsent({ kind: 'http', error: apiError(413, 'payload_too_large') })
    expect(chatOf(m).notice).toEqual({ kind: 'too-large' })
    const s = run(m, { type: 'chat/summarize' })
    expect(types(s.effects)).toEqual(['summarize'])
    const back = chatOf(run(s.model, { type: 'summarize/cancel' }).model)
    expect(back.notice).toEqual({ kind: 'too-large' })
    expect(back.pending).toMatchObject({ text: 'ДРУГЕ НЕПОДАНЕ', error: { code: 'payload_too_large' } })
  })

  function reviewModel(noSave = false) {
    let m = booted()
    if (noSave) m = run(m, { type: 'chat/no-save', on: true }).model
    const s = run(answered(m), { type: 'chat/summarize' })
    const { id } = summarizeFx(s.effects)
    return run(s.model, { type: 'summarize/ok', id, draft: { title: 'Розмова про день', bullets: ['перша', 'друга', 'третя'], tags: ['день'] } }).model
  }

  test('save → 201 → saved, with the diary refreshed and the announcer cleared', () => {
    const save = run(reviewModel(), { type: 'review/save' })
    const fx = save.effects[0] as Extract<Effect, { type: 'save' }>
    expect(fx.type).toBe('save')
    expect(fx.body).toEqual({ scenario: 'free', title: 'Розмова про день', bullets: ['перша', 'друга', 'третя'], tags: [{ name: 'день', source: 'ai' }] })
    const done = run(save.model, { type: 'save/ok', id: fx.id, summary: SUMMARY })
    expect(done.model.state).toEqual({ s: 'saved', summary: SUMMARY })
    expect(types(done.effects)).toEqual(['diary', 'announcer/clear'])
    expect(leaveGuard(done.model.state)).toBe(false)
    expect(chatOf(run(done.model, { type: 'chat/new' }).model).session.messages).toHaveLength(1)
  })

  test('an unknown save result: the retry looks at the newest record first — a match is saved without a second POST', () => {
    const save = run(reviewModel(), { type: 'review/save' })
    const fx = save.effects[0] as Extract<Effect, { type: 'save' }>
    const unknown = run(save.model, { type: 'save/fail', id: fx.id, error: apiError(0, 'network') })
    expect(unknown.model.state).toMatchObject({ s: 'review', saving: 'unknown', error: { code: 'save_unknown' } })
    const retry = run(unknown.model, { type: 'review/save' })
    expect(types(retry.effects)).toEqual(['save-check'])
    const checkId = (retry.effects[0] as Extract<Effect, { type: 'save-check' }>).id
    const record: SummaryOut = { ...SUMMARY, scenario: 'free', title: 'Розмова про день', bullets: ['перша', 'друга', 'третя'], tags: [{ id: 'x', name: 'день', source: 'ai' }] }
    const list: SummaryList = { items: [record], next_cursor: null }
    const match = run(retry.model, { type: 'save/check', id: checkId, list, date: 'Wed, 07 Oct 2026 12:00:30 GMT' })
    expect(match.model.state.s).toBe('saved')
    expect(types(match.effects)).not.toContain('save')
    // Same title, other theses → the second POST goes.
    const other = run(retry.model, { type: 'save/check', id: checkId, list: { items: [{ ...record, bullets: ['інша'] }], next_cursor: null }, date: null })
    expect(types(other.effects)).toEqual(['save'])
    // Too old by the server's own clock → not ours.
    expect(matchesSaved(fx.body, record, 'Wed, 07 Oct 2026 12:10:00 GMT')).toBe(false)
    expect(matchesSaved(fx.body, record, null)).toBe(true)
  })

  test('after an unknown save result the draft is locked, so the check compares with the body that went out', () => {
    const save = run(reviewModel(), { type: 'review/save' })
    const fx = save.effects[0] as Extract<Effect, { type: 'save' }>
    const unknown = run(save.model, { type: 'save/fail', id: fx.id, error: apiError(0, 'network') }).model
    expect(unknown.state).toMatchObject({ s: 'review', saving: 'unknown' })
    if (unknown.state.s !== 'review') return
    const edit = run(unknown, { type: 'review/update', draft: { ...unknown.state.draft, title: 'Розмова про день (правка)' } })
    expect(edit.model).toBe(unknown)
    const retry = run(edit.model, { type: 'review/save' })
    expect(types(retry.effects)).toEqual(['save-check'])
    const checkId = (retry.effects[0] as Extract<Effect, { type: 'save-check' }>).id
    // The first POST did land: its record is the newest one → saved, no second POST.
    const landed: SummaryOut = { ...SUMMARY, scenario: fx.body.scenario, title: fx.body.title, bullets: [...fx.body.bullets], tags: [{ id: 'x', name: 'день', source: 'ai' }] }
    const match = run(retry.model, { type: 'save/check', id: checkId, list: { items: [landed], next_cursor: null }, date: null })
    expect(match.model.state.s).toBe('saved')
    expect(types(match.effects)).not.toContain('save')
    // Once a retry has settled it (saving idle again after a known failure), editing works.
    const known = run(save.model, { type: 'save/fail', id: fx.id, error: apiError(500, 'internal') }).model
    if (known.state.s !== 'review') throw new Error('review expected')
    expect(run(known, { type: 'review/update', draft: { ...known.state.draft, title: 'Інша назва' } }).model.state).toMatchObject({ draft: { title: 'Інша назва' } })
  })

  test('a 201 whose body broke off is an unknown result: the retry checks first instead of POSTing again', async () => {
    const api = createApi({
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(enc.encode('{"id":'))
              c.error(new TypeError('network reset'))
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        ),
    })
    const r = await api.saveSummary({ scenario: 'free', title: 't', bullets: ['b'], tags: [] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatchObject({ status: 201, code: 'network' })
    expect(outcomeUnknown(r.error)).toBe(true)
    expect(outcomeUnknown(apiError(200, 'internal'))).toBe(true)
    expect(outcomeUnknown(apiError(404, 'not_found'))).toBe(false)
    expect(outcomeUnknown(apiError(500, 'internal'))).toBe(false)
    const save = run(reviewModel(), { type: 'review/save' })
    const fx = save.effects[0] as Extract<Effect, { type: 'save' }>
    const failed = run(save.model, { type: 'save/fail', id: fx.id, error: r.error }).model
    expect(failed.state).toMatchObject({ s: 'review', saving: 'unknown', error: { code: 'save_unknown' } })
    expect(types(run(failed, { type: 'review/save' }).effects)).toEqual(['save-check'])
  })

  test('the save-check matches tag names the way the server de-duplicates them', () => {
    const body: SummaryCreate = { scenario: 'day', title: 'Розмова про день', bullets: ['перша'], tags: [
      { name: 'Робота', source: 'user' as const },
      { name: 'памʼять', source: 'ai' as const },
      { name: 'нова  тема', source: 'user' as const },
    ] }
    // The server answers with the names already stored for the same normal form.
    const stored: SummaryOut = { ...SUMMARY, scenario: 'day', title: 'Розмова про день', bullets: ['перша'], tags: [
      { id: 'a', name: 'робота', source: 'user' },
      { id: 'b', name: "пам'ять", source: 'ai' },
      { id: 'c', name: 'Нова тема', source: 'user' },
    ] }
    expect(matchesSaved(body, stored, null)).toBe(true)
    expect(matchesSaved(body, { ...stored, tags: [...stored.tags.slice(0, 2), { id: 'd', name: 'інша тема', source: 'user' }] }, null)).toBe(false)
    expect(matchesSaved(body, { ...stored, tags: stored.tags.slice(0, 2) }, null)).toBe(false)
  })

  test('save errors: 422 lands on the right field through the index table; 403 consent_required resumes the save', () => {
    const m = reviewModel()
    const edited: Draft = {
      title: 'Назва',
      bullets: [
        { id: 'b0', text: 'перша', removed: true },
        { id: 'b1', text: 'друга', removed: false },
        { id: 'b2', text: 'третя', removed: false },
      ],
      tags: [{ id: 't0', name: 'день', source: 'ai' }],
    }
    const save = run(m, { type: 'review/update', draft: edited }, { type: 'review/save' })
    const fx = save.effects.at(-1) as Extract<Effect, { type: 'save' }>
    const invalid = run(save.model, { type: 'save/fail', id: fx.id, error: apiError(422, 'validation_error', { fields: ['bullets.1', 'tags.0.name'] }) })
    expect(invalid.model.state).toMatchObject({
      s: 'review',
      saving: 'idle',
      error: null,
      issues: [
        { field: 'b2', reason: 'bullet-invalid' },
        { field: 't0', reason: 'tag-invalid' },
      ],
    })
    const resume = run(save.model, { type: 'save/fail', id: fx.id, error: apiError(403, 'consent_required', { missing: ['data_processing', 'age_18'] }) })
    expect(resume.model.state).toMatchObject({ s: 'consent', mode: 'resume', resume: { kind: 'save' } })
    expect(leaveGuard(resume.model.state)).toBe(true)
    const again = run(resume.model, { type: 'consents/ok', purpose: 'fresh', consents: CONSENTS_OK })
    expect(again.model.state).toMatchObject({ s: 'review', saving: 'saving' })
    expect((again.effects[0] as Extract<Effect, { type: 'save' }>).body).toEqual(fx.body)
    expect(run(save.model, { type: 'save/fail', id: fx.id, error: apiError(401, 'unauthenticated') }).model.state).toMatchObject({ s: 'session-expired', draft: edited })
  })

  test('discard → ended without a request; regenerate → summarizing; back → the conversation; «не зберігати» has no save', () => {
    const m = reviewModel()
    const discard = run(m, { type: 'confirm/open', kind: 'discard' }, { type: 'confirm/accept' })
    expect(discard.model.state).toEqual({ s: 'ended' })
    expect(types(discard.effects)).toEqual(['announcer/clear'])
    expect(run(m, { type: 'confirm/open', kind: 'regenerate' }, { type: 'confirm/accept' }).model.state.s).toBe('summarizing')
    expect(run(m, { type: 'review/back' }).model.state.s).toBe('chat')
    const quiet = reviewModel(true)
    expect(run(quiet, { type: 'review/save' }).effects).toEqual([])
    expect(run(quiet, { type: 'review/done' }).model.state).toEqual({ s: 'ended' })
  })

  test('confirm(end) ↔ end-no-theses in the same dialog; «Завершити» → ended', () => {
    const m = run(answered(booted()), { type: 'confirm/open', kind: 'end' }, { type: 'confirm/switch', kind: 'end-no-theses' }).model
    expect(m.overlay[0]).toMatchObject({ kind: 'end-no-theses', back: true })
    expect(run(m, { type: 'confirm/switch', kind: 'end' }).model.overlay[0]).toMatchObject({ kind: 'end' })
    const end = run(m, { type: 'confirm/accept' })
    expect(end.model.state).toEqual({ s: 'ended' })
    expect(end.model.overlay).toEqual([])
    expect(types(end.effects)).toContain('announcer/clear')
  })
})

test.describe('state: crisis and invariants', () => {
  function crisisModel() {
    const sent = run(booted(), { type: 'chat/send', text: 'Синтетична кризова фраза' })
    const { id } = turnEffect(sent.effects)
    return run(sent.model, { type: 'turn/outcome', id, now: NOW, outcome: { kind: 'crisis', source: 'keyword', helplines: sanitizeHelplines(RAW_HELPLINES) } }).model
  }

  test('I5: from crisis no action leads back into that conversation; only a new, empty one', () => {
    const crisis = crisisModel()
    expect(leaveGuard(crisis.state)).toBe(false)
    const actions: Action[] = [
      { type: 'chat/send', text: 'ще' },
      { type: 'chat/resend' },
      { type: 'chat/summarize' },
      { type: 'chat/new' },
      { type: 'chat/scenario', id: 'day' },
      { type: 'turn/outcome', id: 1, now: NOW, outcome: { kind: 'done', text: 'x', finishReason: 'stop', requestId: null } },
      { type: 'summarize/ok', id: 1, draft: { title: 't', bullets: ['a'], tags: [] } },
      { type: 'review/back' },
      { type: 'boot', search: '' },
      { type: 'consents/ok', purpose: 'fresh', consents: CONSENTS_OK },
      { type: 'grant/ok', consents: CONSENTS_OK },
      { type: 'confirm/open', kind: 'end' },
      { type: 'confirm/accept' },
      { type: 'overlay/close' },
      { type: 'revisit/open' },
      { type: 'page/show', persisted: false },
    ]
    for (const action of actions) {
      const [next] = reduce(crisis, action)
      expect(next.state.s, action.type).toBe('crisis')
    }
    const fresh = run(crisis, { type: 'confirm/open', kind: 'new-after-crisis' }, { type: 'confirm/accept' })
    const c = chatOf(fresh.model)
    expect(c.session.messages).toHaveLength(1)
    expect(fresh.model.ctx.afterCrisis).toBe(true)
    expect(types(fresh.effects)).toContain('announcer/clear')
    expect(JSON.stringify(fresh.model.state)).not.toContain('Синтетична кризова фраза')
  })

  test('I6: a new screen closes every overlay (help open during the stream, then crisis)', () => {
    const sent = run(booted(), { type: 'chat/send', text: 'Текст' })
    const { id } = turnEffect(sent.effects)
    const help = run(sent.model, { type: 'overlay/open', overlay: 'help' })
    expect(help.model.overlay).toEqual([{ o: 'help' }])
    expect(help.effects).toEqual([{ type: 'helplines' }])
    const crisis = run(help.model, { type: 'turn/outcome', id, now: NOW, outcome: { kind: 'crisis', source: 'model', helplines: FALLBACK } })
    expect(crisis.model.overlay).toEqual([])
    // The account menu over a 401 too.
    const account = run(sent.model, { type: 'overlay/open', overlay: 'account' }).model
    const expired = run(account, { type: 'turn/outcome', id, now: NOW, outcome: { kind: 'http', error: apiError(401, 'unauthenticated') } })
    expect(expired.model.overlay).toEqual([])
  })

  test('I7: leaveGuard only when something would be lost', () => {
    const fresh = booted()
    expect(leaveGuard(fresh.state)).toBe(false)
    expect(leaveGuard(run(fresh, { type: 'chat/send', text: 'x' }).model.state)).toBe(true)
    expect(leaveGuard(answered(fresh).state)).toBe(true)
    for (const s of [{ s: 'ended' }, { s: 'saved', summary: SUMMARY }, { s: 'booting' }, { s: 'fatal', error: toUiError(apiError(0, 'network')) }] as State[]) {
      expect(leaveGuard(s), s.s).toBe(false)
    }
  })

  test('I1: nothing in the core writes the transcript anywhere but the state', () => {
    // The reducer emits no effect that carries message text, except putting the person's own text
    // back into the field («Змінити») and the request body itself.
    const m = answered(booted(), 'ПРИВАТНИЙ-ТЕКСТ')
    const all = run(m, { type: 'chat/send', text: 'ДРУГИЙ' }, { type: 'confirm/open', kind: 'leave' }, { type: 'overlay/close' })
    for (const effect of all.effects) {
      if (effect.type === 'turn') continue
      expect(JSON.stringify(effect)).not.toContain('ПРИВАТНИЙ-ТЕКСТ')
    }
  })
})

test.describe('state: account and page life', () => {
  test('logout with a conversation → confirm(logout) over the account menu; accepted → abort, POST, signed-out', () => {
    const m = run(answered(booted()), { type: 'overlay/open', overlay: 'account' }, { type: 'account/logout' }).model
    expect(m.overlay.map((o) => o.o)).toEqual(['account', 'confirm'])
    const cancel = run(m, { type: 'overlay/close' }).model
    expect(cancel.overlay.map((o) => o.o)).toEqual(['account'])
    const go = run(m, { type: 'confirm/accept' })
    expect(go.effects).toEqual([{ type: 'abort', target: 'all' }, { type: 'logout' }])
    const out = run(go.model, { type: 'logout/ok' })
    expect(out.model.state).toEqual({ s: 'signed-out', variant: 'logged-out', notice: { kind: 'logged-out' } })
    expect(out.model.overlay).toEqual([])
    expect(out.model.ctx.me).toBeNull()
    expect(types(out.effects)).toContain('announcer/clear')
    // Without a conversation the logout goes at once.
    expect(run(booted(), { type: 'account/logout' }).effects).toEqual([{ type: 'abort', target: 'all' }, { type: 'logout' }])
  })

  test('DELETE /me: 204 → account-deleted; network then 401 → presumed; 401 at once → signed-out with the banner', () => {
    const ask = run(booted(), { type: 'overlay/open', overlay: 'account' }, { type: 'confirm/open', kind: 'delete-account' }).model
    expect(ask.overlay.map((o) => o.o)).toEqual(['account', 'confirm'])
    const go = run(ask, { type: 'confirm/accept' })
    expect(go.effects).toEqual([{ type: 'abort', target: 'all' }, { type: 'delete-me' }])
    expect(run(go.model, { type: 'delete/ok' }).model.state).toEqual({ s: 'account-deleted', variant: 'confirmed' })
    const unknown = run(go.model, { type: 'delete/fail', error: apiError(0, 'network') }).model
    expect(unknown.ctx.deleteAttempt).toBe('unknown')
    expect(unknown.ctx.op).toMatchObject({ name: 'delete-account', busy: false, error: { code: 'delete_unknown' } })
    const presumed = run(unknown, { type: 'confirm/accept' }, { type: 'delete/fail', error: apiError(401, 'unauthenticated') })
    expect(presumed.model.state).toEqual({ s: 'account-deleted', variant: 'presumed' })
    expect(presumed.model.ctx.diary).toEqual({ status: 'ok', value: { items: [], nextCursor: null } })
    expect(run(go.model, { type: 'delete/fail', error: apiError(401, 'unauthenticated') }).model.state).toEqual({
      s: 'signed-out',
      variant: 'fresh',
      notice: { kind: 'delete-relogin' },
    })
  })

  test('revoking data_processing empties the diary and opens consent(first)', () => {
    const m = run(answered(booted()), { type: 'overlay/open', overlay: 'account' }, { type: 'confirm/open', kind: 'revoke', revoke: 'data_processing' }, { type: 'confirm/accept' })
    expect(m.effects.at(-1)).toEqual({ type: 'revoke', kind: 'data_processing' })
    const done = run(m.model, { type: 'revoke/ok', kind: 'data_processing', consents: { ...CONSENTS_OK, missing: ['data_processing'] } })
    expect(done.model.state).toMatchObject({ s: 'consent', mode: 'first', session: null })
    expect(done.model.overlay).toEqual([])
    expect(done.model.ctx.diary).toEqual({ status: 'ok', value: { items: [], nextCursor: null } })
    expect(types(done.effects)).toEqual(['abort', 'announcer/clear'])
  })

  test('pageshow from the bfcache asks GET /me; a 401 wipes the conversation', () => {
    const m = answered(booted())
    const show = run(m, { type: 'page/show', persisted: true })
    expect(show.effects).toEqual([{ type: 'me', purpose: 'pageshow', timeoutMs: BOOT_TIMEOUT }])
    const wiped = run(m, { type: 'me/fail', purpose: 'pageshow', error: apiError(401, 'unauthenticated') })
    expect(wiped.model.state).toEqual({ s: 'signed-out', variant: 'fresh', notice: null })
    expect(types(wiped.effects)).toEqual(['abort', 'announcer/clear'])
    expect(JSON.stringify(wiped.model)).not.toContain('Синтетичне перше повідомлення.')
    expect(run(m, { type: 'page/show', persisted: false }).effects).toEqual([])
    expect(run(m, { type: 'me/fail', purpose: 'pageshow', error: apiError(0, 'network') }).model).toEqual(m)
  })

  test('not-invited with an unsent message: «Вийти» asks first; a deleted account clears the announcer', () => {
    const sent = run(booted(), { type: 'chat/send', text: 'Запрошення' })
    const blocked = run(sent.model, { type: 'turn/outcome', id: turnEffect(sent.effects).id, now: NOW, outcome: { kind: 'http', error: apiError(403, 'not_invited') } }).model
    expect(leaveGuard(blocked.state)).toBe(true)
    const ask = run(blocked, { type: 'account/logout' })
    expect(ask.effects).toEqual([])
    expect(ask.model.overlay).toEqual([{ o: 'confirm', kind: 'logout', revoke: null, leaveTo: null, back: false }])
    expect(types(run(ask.model, { type: 'confirm/accept' }).effects)).toEqual(['abort', 'logout'])
    const deleted = run(blocked, { type: 'confirm/open', kind: 'delete-account' }, { type: 'confirm/accept' }, { type: 'delete/ok' })
    expect(deleted.model.state).toEqual({ s: 'account-deleted', variant: 'confirmed' })
    expect(types(deleted.effects)).toContain('announcer/clear')
    expect(JSON.stringify(deleted.model)).not.toContain('Запрошення')
  })

  test('confirm(end) needs an AI reply first; help in crisis reuses the crisis payload', () => {
    expect(run(booted(), { type: 'confirm/open', kind: 'end' }).model.overlay).toEqual([])
    const sent = run(booted(), { type: 'chat/send', text: 'Криза' })
    const helplines = sanitizeHelplines(RAW_HELPLINES)
    const crisis = run(sent.model, { type: 'turn/outcome', id: turnEffect(sent.effects).id, now: NOW, outcome: { kind: 'crisis', source: 'keyword', helplines } }).model
    expect(crisis.ctx.helplines).toEqual({ status: 'ok', value: helplines })
    expect(run(crisis, { type: 'overlay/open', overlay: 'help' }).effects).toEqual([])
  })

  test('a 401 on GET /summaries mid-session ends the session: the diary refresh and the record picker', () => {
    const m = answered(booted())
    const diary = run(m, { type: 'diary/retry' }, { type: 'diary/fail', error: apiError(401, 'unauthenticated') })
    expect(diary.model.state).toMatchObject({ s: 'session-expired', pending: null, draft: null })
    expect(types(diary.effects)).toEqual(['diary', 'abort'])
    // Any other failure only marks the diary.
    const down = run(m, { type: 'diary/fail', error: apiError(502, 'upstream_unavailable') }).model
    expect(down.state.s).toBe('chat')
    expect(down.ctx.diary).toEqual({ status: 'failed' })
    // After «Збережено» nothing is left to keep: signed out.
    const s = run(m, { type: 'chat/summarize' })
    const sid = (s.effects[0] as Extract<Effect, { type: 'summarize' }>).id
    const save = run(s.model, { type: 'summarize/ok', id: sid, draft: { title: 'Т', bullets: ['a'], tags: [] } }, { type: 'review/save' })
    const saveId = (save.effects.at(-1) as Extract<Effect, { type: 'save' }>).id
    const done = run(save.model, { type: 'save/ok', id: saveId, summary: SUMMARY }).model
    expect(run(done, { type: 'diary/fail', error: apiError(401, 'unauthenticated') }).model.state).toEqual({ s: 'signed-out', variant: 'fresh', notice: null })

    const picker = run(booted(), { type: 'chat/scenario', id: 'revisit' }, { type: 'revisit/open' })
    const expired = run(picker.model, { type: 'revisit/list-fail', purpose: 'pick', q: '', cursor: null, error: apiError(401, 'unauthenticated') })
    expect(expired.model.state.s).toBe('session-expired')
    expect(expired.model.overlay).toEqual([])
    const offlinePick = run(picker.model, { type: 'revisit/list-fail', purpose: 'pick', q: '', cursor: null, error: apiError(0, 'network') })
    expect(offlinePick.model.state.s).toBe('chat')
    expect(offlinePick.model.overlay[0]).toMatchObject({ o: 'revisit-pick', failed: true, loading: false })
  })

  test('the help dialog fetches GET /helplines once per page view', () => {
    const m = run(booted(), { type: 'overlay/open', overlay: 'help' })
    expect(m.effects).toEqual([{ type: 'helplines' }])
    const loaded = run(m.model, { type: 'helplines/ok', helplines: FALLBACK }, { type: 'overlay/close' }, { type: 'overlay/open', overlay: 'help' })
    expect(loaded.effects).toEqual([])
  })
})

// ── UI decisions without a page: the live region, the keyboard, the sky ─────────────────────────

/** Timers that run only when told to; the region records every non-empty write (test #42). */
function liveRegion() {
  let now = 0
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const writes: string[] = []
  let text: string | null = ''
  const region: Region = {
    get textContent() {
      return text
    },
    set textContent(value) {
      text = value
      if (value) writes.push(value)
    },
  }
  return {
    region,
    writes,
    text: () => text,
    timers: {
      setTimeout: (fn: () => void, ms: number): number => {
        timers.set(++seq, { at: now + ms, fn })
        return seq
      },
      clearTimeout: (handle: number) => {
        timers.delete(handle)
      },
    },
    advance(ms: number) {
      const end = now + ms
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (next === undefined) break
        timers.delete(next[0])
        now = next[1].at
        next[1].fn()
      }
      now = end
    },
    pending: () => timers.size,
  }
}

test.describe('announcer', () => {
  test('a turn writes at most twice: the first progress line and the end; the rest is dropped', () => {
    const live = liveRegion()
    const announcer = createAnnouncer(live.region, live.timers)
    announcer.turn()
    announcer.progress('Пробуємо ще раз через 5 секунд')
    announcer.progress('AI думає над відповіддю')
    announcer.progress('Пробуємо ще раз через 5 секунд')
    announcer.final('Відповідь AI: Привіт.')
    announcer.final('Відповідь зупинено')
    announcer.progress('AI думає над відповіддю')
    expect(live.writes).toEqual(['Пробуємо ще раз через 5 секунд', 'Відповідь AI: Привіт.'])

    // The next turn has its own two.
    announcer.turn()
    announcer.final('Не надіслано. Сервер зараз не відповідає.')
    expect(live.writes).toHaveLength(3)
    // One-off announcements outside a turn are not counted against it.
    announcer.say('Можна надіслати ще раз')
    expect(live.writes.at(-1)).toBe('Можна надіслати ще раз')
  })

  test('nothing before a turn starts; a turn without progress still says how it ended', () => {
    const live = liveRegion()
    const announcer = createAnnouncer(live.region, live.timers)
    announcer.progress('AI думає над відповіддю')
    announcer.final('Відповідь зупинено')
    expect(live.writes).toEqual([])
    announcer.turn()
    announcer.final('Відповідь AI: Так.')
    expect(live.writes).toEqual(['Відповідь AI: Так.'])
  })

  test('the reply does not stay: emptied ≈ 5 s later, and at once on clear (a wipe), silently', () => {
    const live = liveRegion()
    const announcer = createAnnouncer(live.region, live.timers)
    announcer.turn()
    announcer.final('Відповідь AI: Довга відповідь.')
    live.advance(CLEAR_AFTER_MS - 1)
    expect(live.text()).toBe('Відповідь AI: Довга відповідь.')
    live.advance(1)
    expect(live.text()).toBe('')

    announcer.say('Збережено в щоденник')
    announcer.clear()
    expect(live.text()).toBe('')
    expect(live.pending()).toBe(0)
    // Emptying is not a write (test #42 counts non-empty ones only).
    expect(live.writes).toEqual(['Відповідь AI: Довга відповідь.', 'Збережено в щоденник'])
  })

  test('the same line twice in a row is emptied first, so it is heard again; blank lines are not written', () => {
    const live = liveRegion()
    const announcer = createAnnouncer(live.region, live.timers)
    announcer.say('Можна надіслати ще раз')
    announcer.say('Можна надіслати ще раз')
    expect(live.text()).toBe('')
    live.advance(100)
    expect(live.text()).toBe('Можна надіслати ще раз')
    expect(live.writes).toHaveLength(2)
    announcer.say('   ')
    expect(live.writes).toHaveLength(2)
  })
})

test('keyboard: the inset is what the keyboard covers of the layout viewport; 150 px counts as a keyboard', () => {
  // iOS Safari: the layout viewport keeps 844, the visual one is 508 under the keyboard.
  expect(keyboardInset(844, 508, 0)).toBe(336)
  // The visual viewport scrolled within the layout one: less of it is covered.
  expect(keyboardInset(844, 508, 120.4)).toBe(216)
  // Android Chrome with interactive-widget=resizes-content: both shrink, nothing to lift.
  expect(keyboardInset(500, 500, 0)).toBe(0)
  expect(keyboardInset(500, 520, 0)).toBe(0)
  expect(KEYBOARD_DROP).toBe(150)
  expect(keyboardShown(800, 650)).toBe(true)
  expect(keyboardShown(800, 651)).toBe(false)
  expect(keyboardShown(800, 800)).toBe(false)
})

test.describe('sky presets', () => {
  test('only dusk and dawn are presets; anything else is the night, and the crisis is always the night', () => {
    expect(SKY_KEY).toBe('liora:sky')
    expect(parseSky('dusk')).toBe('dusk')
    expect(parseSky('dawn')).toBe('dawn')
    for (const other of [null, '', 'night', 'DUSK', 'noon', '{"sky":"dusk"}', 1]) expect(parseSky(other)).toBe('night')
    expect(skyAttribute('night', false)).toBeNull()
    expect(skyAttribute('dusk', false)).toBe('dusk')
    expect(skyAttribute('dawn', false)).toBe('dawn')
    expect(skyAttribute('dusk', true)).toBeNull()
    expect(skyAttribute('dawn', true)).toBeNull()
  })

  test('no preset layer is lighter than the night: bases under its lightest base, each haze under its own', () => {
    const css = readFileSync(resolve(test.info().project.testDir, '..', '..', 'src', 'styles', 'stage.css'), 'utf8')
    const block = (selector: string): Record<string, number[]> => {
      const start = css.indexOf(`${selector} {`)
      expect(start, selector).toBeGreaterThanOrEqual(0)
      const body = css.slice(start, css.indexOf('}', start))
      return Object.fromEntries([...body.matchAll(/--(sky-[a-z-]+):\s*(\d+)\s+(\d+)\s+(\d+)/g)].map((m) => [m[1]!, [Number(m[2]), Number(m[3]), Number(m[4])]]))
    }
    const lin = (c: number): number => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4)
    const lum = ([r, g, b]: number[]): number => 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!)
    const contrast = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    const BASES = ['sky-top', 'sky-mid', 'sky-bottom', 'sky-glow-teal', 'sky-glow-violet']
    const HAZES = ['sky-haze-teal', 'sky-haze-violet', 'sky-haze-amber']

    const night = block(':root')
    expect(Object.keys(night).sort()).toEqual([...BASES, ...HAZES].sort())
    const nightBase = Math.max(...BASES.map((k) => lum(night[k]!)))
    // --color-text-dim on the night's lightest base: the margin the presets may not eat into.
    expect(contrast(lum([132, 145, 141]), nightBase)).toBeGreaterThanOrEqual(4.5)
    for (const preset of ['dusk', 'dawn']) {
      const sky = block(`html[data-sky='${preset}']`)
      expect(Object.keys(sky).sort(), preset).toEqual([...BASES, ...HAZES].sort())
      for (const k of BASES) expect(lum(sky[k]!), `${preset} ${k}`).toBeLessThanOrEqual(nightBase)
      for (const k of HAZES) expect(lum(sky[k]!), `${preset} ${k}`).toBeLessThanOrEqual(lum(night[k]!))
    }
  })
})

// ── Source rules that keep the CSP and the core honest (§10.5) ───────────────────────────────

test.describe('source rules', () => {
  function sources(sub: string): { path: string; text: string }[] {
    const root = resolve(test.info().project.testDir, '..', '..', 'src', sub)
    return readdirSync(root, { recursive: true, encoding: 'utf8' })
      .map((p) => p.replace(/\\/g, '/'))
      .filter((p) => statSync(join(root, p)).isFile())
      .map((p) => ({ path: `src/${sub ? `${sub}/` : ''}${p}`, text: readFileSync(join(root, p), 'utf8') }))
  }

  function offenders(files: { path: string; text: string }[], pattern: RegExp): string[] {
    return files.flatMap(({ path, text }) =>
      text
        .split('\n')
        .map((line, i) => (pattern.test(line) ? `${path}:${i + 1}: ${line.trim()}` : null))
        .filter((x): x is string => x !== null),
    )
  }

  test('src/**: no HTML injection and no inline style writes', () => {
    const all = sources('')
    expect(all.length).toBeGreaterThan(10)
    for (const pattern of [
      /\binnerHTML\b/,
      /\bouterHTML\b/,
      /\binsertAdjacentHTML\b/,
      /\bdocument\.write\b/,
      /\beval\s*\(/,
      /\bnew\s+Function\b/,
      /setAttribute\(\s*['"`]style['"`]/,
      /\.cssText\b/,
    ]) {
      expect(offenders(all, pattern), String(pattern)).toEqual([])
    }
  })

  test('localStorage.setItem only in src/ui/motion.ts and src/ui/sky.ts', () => {
    const writers = offenders(sources(''), /localStorage\s*\.\s*setItem\b/).map((o) => o.split(':')[0])
    expect(writers.every((p) => p === 'src/ui/motion.ts' || p === 'src/ui/sky.ts'), writers.join(', ')).toBe(true)
  })

  test('src/chat/**: no fetch mode, keepalive, bearer header, EventSource or storage', () => {
    const chat = sources('chat')
    expect(chat.length).toBeGreaterThan(5)
    // The rule is about RequestInit.mode (§5.1); the consent screen's own `mode` field is state.
    for (const pattern of [
      /\bmode\s*:\s*['"`](?:same-origin|no-cors|cors|navigate)['"`]/,
      /\bkeepalive\s*:/,
      /['"`]Authorization['"`]/,
      /\bnew\s+EventSource\b/,
      /\blocalStorage\b/,
      /\bsessionStorage\b/,
    ]) {
      expect(offenders(chat, pattern), String(pattern)).toEqual([])
    }
  })

  test('src/chat/core/**: no DOM, browser globals, storage, three.js, UI imports or console', () => {
    const core = sources('chat/core')
    expect(core.map((f) => f.path).sort()).toEqual(
      ['api', 'country', 'errors', 'helplines', 'limits', 'sse', 'state', 'turn', 'types'].map((n) => `src/chat/core/${n}.ts`),
    )
    for (const pattern of [
      /\bdocument\b/,
      /\bwindow\b/,
      /\bnavigator\b/,
      /\bHTMLElement\b/,
      /\blocalStorage\b/,
      /\bsessionStorage\b/,
      /\bindexedDB\b/,
      /from\s+['"]three/,
      /import\(\s*['"]three/,
      /from\s+['"](?:\.\.\/)+(?:ui|gl)\b/,
      /from\s+['"][^'"]*\/ui\//,
      /\bconsole\./,
      /\benum\s+\w/,
      /\bnamespace\s+\w/,
    ]) {
      expect(offenders(core, pattern), String(pattern)).toEqual([])
    }
  })

  test('the paused number is spelled nowhere in src', () => {
    expect(offenders(sources(''), new RegExp(PAUSED))).toEqual([])
  })

  test('sky presets: one module knows the key; the landing never reads it; /chat/ offers the three skies', () => {
    const keyHolders = offenders(sources(''), /liora:sky/).map((o) => o.split(':')[0])
    expect(keyHolders.every((p) => p === 'src/ui/sky.ts'), keyHolders.join(', ')).toBe(true)
    const repo = resolve(test.info().project.testDir, '..', '..')
    const landing = readFileSync(join(repo, 'src', 'main.ts'), 'utf8')
    expect(landing).not.toMatch(/ui\/sky/)
    expect(readFileSync(join(repo, 'index.html'), 'utf8')).not.toMatch(/data-sky|name="sky"/)
    const chat = readFileSync(join(repo, 'chat', 'index.html'), 'utf8')
    const radios = [...chat.matchAll(/<input[^>]*name="sky"[^>]*value="([a-z]+)"/g)].map((m) => m[1])
    expect(radios).toEqual(['night', 'dusk', 'dawn'])
    expect(chat).toContain('data-sky-pick')
  })

  test('page life lives in the leave guard: pagehide and pageshow are listened to in one place', () => {
    const listeners = offenders(sources('chat'), /addEventListener\(\s*['"](?:pagehide|pageshow|beforeunload)['"]/).map((o) => o.split(':')[0])
    expect(listeners.length).toBeGreaterThan(0)
    expect(listeners.every((p) => p === 'src/chat/ui/leave-guard.ts'), listeners.join(', ')).toBe(true)
  })
})
