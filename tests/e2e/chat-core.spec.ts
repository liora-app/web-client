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
  patchBody,
  summariesPath,
  summarizeBody,
  turnBody,
  weeklyPath,
  type FetchLike,
} from '../../src/chat/core/api'
import { countryName } from '../../src/chat/core/country'
import { codeForStatus, fromResponse, outcomeUnknown, retryAfterMs, toUiError, type ApiError } from '../../src/chat/core/errors'
import {
  FALLBACK,
  FALLBACK_ABROAD,
  FALLBACK_MESSAGE,
  HOWAREU_URL,
  PAUSED_LINE_NOTE,
  PAUSED_LINE_NOTE_SHORT,
  maskPausedLine,
  maskPausedLineInline,
  noPausedLine,
  oneLine,
  sanitizeHelplines,
} from '../../src/chat/core/helplines'
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
import { formOf, patchOf, searchQuery, shiftDay, tagsFromText } from '../../src/chat/core/journal'
import {
  MOOD_QUADRANTS,
  MOOD_WORDS,
  NO_MOOD,
  TOOL_KINDS,
  breathAt,
  breathCycleMs,
  breathNextChangeMs,
  breathTotalMs,
  isMoodWord,
  isToolKind,
  type BreathPattern,
} from '../../src/chat/core/selfhelp'
import { MAX_FRAME_BUFFER, ProtocolError, chatEvents, readFrames, type TurnEvent } from '../../src/chat/core/sse'
import {
  FALLBACK_SCENARIO,
  INITIAL_MODEL,
  MAX_MARKS,
  PAUSE_AFTER_MS,
  PAUSE_AFTER_REPLIES,
  authErrorFrom,
  canOpenJournal,
  canSendNow,
  editUnsaved,
  journalBusy,
  leaveGuard,
  llmInFlight,
  markCandidates,
  markText,
  matchesSaved,
  pauseAt,
  pauseDue,
  reduce,
  topTool,
  transferAskable,
  type Action,
  type ChatState,
  type Effect,
  type JournalState,
  type Model,
  type ReviewState,
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
import type { ConsentState, ScenarioOut, SummaryCreate, SummaryList, SummaryOut, SummaryPatch, TurnRequest, WeeklyReviewOut } from '../../src/chat/core/types'
// UI modules whose logic needs no DOM to load: what they decide is tested here, the page in CI.
import { CLEAR_AFTER_MS, createAnnouncer, type Region } from '../../src/chat/ui/announcer'
import { conversationText, entryMarkdown, thesesText } from '../../src/chat/ui/clipboard'
import { moodLine, moodSentence, sayAnswer, sayRetry } from '../../src/chat/ui/copy'
import { KEYBOARD_DROP, keyboardInset, keyboardShown } from '../../src/chat/ui/keyboard'
import { presenceOf } from '../../src/chat/ui/presence'
import { CHARACTER_KEY, parseCharacter } from '../../src/ui/character'
import { SKY_KEY, parseSky, skyAttribute } from '../../src/ui/sky'
import { block, checkAll, colour, fieldsMeet, grounds, hexOf, lum, over, props, ratio, sampled, sectionGrounds, sectionSky, sky, themes, worst, type Check, type Ground, type Rgb } from './sky-contrast'

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

  test('a provider without a country keeps its name (country ""); one without a name is no provider', async () => {
    const withProvider = (llm_provider: unknown) =>
      createApi({
        fetch: async () => new Response(JSON.stringify({ current_policy_version: 'v1', required: [], granted: [], missing: [], llm_provider }), { status: 200 }),
      }).consents()
    // The name still goes on the page; only the consent gate needs the country (transferAskable).
    for (const provider of [
      { name: 'Ollama Cloud (Ollama Inc.)', country: '' },
      { name: 'Ollama Cloud (Ollama Inc.)', country: '   ' },
      { name: 'Ollama Cloud (Ollama Inc.)', country: 'X'.repeat(65) },
      { name: 'Ollama Cloud (Ollama Inc.)', country: 7 },
      { name: 'Ollama Cloud (Ollama Inc.)' },
    ]) {
      const r = await withProvider(provider)
      expect(r.ok && r.data.llm_provider, JSON.stringify(provider)).toEqual({ name: 'Ollama Cloud (Ollama Inc.)', country: '' })
      expect(r.ok && transferAskable(r.data), JSON.stringify(provider)).toBe(false)
    }
    for (const provider of [{ name: '', country: 'US' }, { name: '   ', country: 'US' }, { country: 'US' }, { name: 'X'.repeat(201), country: 'US' }, 'Ollama', null]) {
      const r = await withProvider(provider)
      expect(r.ok && r.data.llm_provider, JSON.stringify(provider)).toBeNull()
    }
    const ok = await withProvider({ name: '  Ollama Cloud (Ollama Inc.) ', country: ' US ' })
    expect(ok.ok && ok.data.llm_provider).toEqual({ name: 'Ollama Cloud (Ollama Inc.)', country: 'US' })
    expect(ok.ok && transferAskable(ok.data)).toBe(true)
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
    expect(GOOGLE_START).toBe('/api/v1/auth/google/start?next=/')
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

  test('bidi controls drop the text: «3337» under a right-to-left override would draw the paused number', () => {
    // Escapes, never the invisible characters themselves.
    const reversed = '\u202E' + '3337'
    // The digit checks alone let it through: the digits, in order, are not the paused number.
    expect(reversed.normalize('NFKC').replace(/\D/g, '')).not.toContain(PAUSED)
    const safe = sanitizeHelplines({
      message: `Синтетичний лід ${reversed}`,
      lines: [
        { name: `Лінія ${reversed}`, phone: '0 800 00 00 07', hours: null, free: true },
        { name: 'Синтетична лінія з годинами', phone: '0 800 00 00 08', hours: `з ${reversed}`, free: true },
        { name: 'Синтетична лінія з ізоляцією', phone: '0 800 00 00 09', hours: '\u2067цілодобово\u2069', free: true },
        { name: 'Синтетична лінія з міткою', phone: '0 800 00 00 10', hours: '\u200Fцілодобово', free: true },
        { name: 'Звичайна синтетична лінія', phone: '0 800 00 00 11', hours: 'цілодобово', free: true },
      ],
      abroad: { text: `За кордоном: ${reversed}` },
    })
    expect(safe.lines.map((l) => l.name)).toEqual(['Звичайна синтетична лінія'])
    expect(safe.message).toBe(FALLBACK_MESSAGE)
    expect(safe.abroadText).toBe(FALLBACK_ABROAD)
    expect(JSON.stringify(safe)).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/)
  })

  test('digits other than 0-9, right-to-left letters and a Cyrillic «З» for a 3 drop the text: message, name, hours, abroad.text', () => {
    // Code points and escapes only, never the characters themselves.
    const arabic = [...PAUSED].map((d) => String.fromCodePoint(0x0660 + Number(d))).join('')
    const dingbats = [...PAUSED].map((d) => String.fromCodePoint(0x2775 + Number(d))).join('')
    const ze = PAUSED.slice(0, 3) + '\u{0417}'
    const zeApart = PAUSED.slice(0, 1) + ' \u{0437}\u{0437}\u{0437}'
    // Beside a right-to-left letter «333 7» is drawn as «7 333»; its digits, in order, are not the number.
    const rtl = '\u{05D0} ' + PAUSED.slice(1) + ' ' + PAUSED.slice(0, 1)
    expect(noPausedLine(rtl)).toBe(true)
    // Not even the number: any digit outside 0-9 is a number the checks cannot vouch for.
    const otherDigits = String.fromCodePoint(0x2776, 0x2777)
    for (const trick of [arabic, dingbats, ze, zeApart, rtl, otherDigits]) {
      const safe = sanitizeHelplines({
        message: `Синтетичний лід ${trick}`,
        lines: [
          { name: `Лінія ${trick}`, phone: '0 800 00 00 12', hours: null, free: true },
          { name: 'Синтетична лінія з годинами', phone: '0 800 00 00 13', hours: `до ${trick}`, free: true },
          { name: 'Звичайна синтетична лінія', phone: '0 800 00 00 14', hours: 'цілодобово', free: true },
        ],
        abroad: { text: `За кордоном: ${trick}` },
      })
      expect(safe.lines.map((l) => l.name), JSON.stringify(trick)).toEqual(['Звичайна синтетична лінія'])
      expect(safe.message, JSON.stringify(trick)).toBe(FALLBACK_MESSAGE)
      expect(safe.abroadText, JSON.stringify(trick)).toBe(FALLBACK_ABROAD)
    }
    // «з» inside words, and the preposition with no digit beside it, drop nothing.
    const plain = sanitizeHelplines({
      message: 'Лінія працює 24/7. Зверніться зараз, з будь-яким питанням.',
      lines: [{ name: 'Синтетична лінія звʼязку', phone: '0 800 00 00 15', hours: 'з 9:00 до 18:00', free: true }],
      abroad: { text: 'За кордоном зверніться до 112.' },
    })
    expect(plain.message).toBe('Лінія працює 24/7. Зверніться зараз, з будь-яким питанням.')
    expect(plain.lines.map((l) => l.hours)).toEqual(['з 9:00 до 18:00'])
    expect(plain.abroadText).toBe('За кордоном зверніться до 112.')
  })

  test('maskPausedLine: every spelling of the paused number in the AI’s text is masked; other numbers and words stay', () => {
    const [a, b, c, d] = [...PAUSED] as [string, string, string, string]
    const fullwidth = [...PAUSED].map((x) => String.fromCodePoint(0xff10 + Number(x))).join('')
    const arabic = [...PAUSED].map((x) => String.fromCodePoint(0x0660 + Number(x))).join('')
    const dingbats = [...PAUSED].map((x) => String.fromCodePoint(0x2775 + Number(x))).join('')
    const N = PAUSED_LINE_NOTE
    const cases: readonly (readonly [string, string])[] = [
      [`Дзвоніть ${PAUSED}.`, `Дзвоніть ${N}.`],
      [`${a} ${b}${c}${d}`, N],
      [`${a}-${b}-${c}-${d}`, N],
      [`${a} - ${b}${c}${d}`, N],
      [`${a}.${b}${c}.${d}`, N],
      [`${a}\u{200B}${b}${c}${d}`, N],
      [fullwidth, N],
      [arabic, N],
      [dingbats, N],
      [`${a}${b}${c}\u{0417}`, N],
      [`${a} \u{0437}\u{0437}\u{0437}`, N],
      [`(${PAUSED})`, `(${N})`],
      // Inside a spaced longer number too: a mask too many costs less than the number on the screen.
      [`0 800 ${PAUSED}`, `0 800 ${N}`],
      [`${PAUSED}, 112 або 103`, `${N}, 112 або 103`],
      [`${PAUSED} ${PAUSED}`, `${N} ${N}`],
    ]
    for (const [text, want] of cases) expect(maskPausedLine(text), JSON.stringify(text)).toBe(want)
    // An unbroken longer number is another number (decided: a digit group is never split); a time,
    // a comma, a line break or a word end the number; «з» in a word is a letter.
    const kept = [
      `1${PAUSED}`,
      `${PAUSED}1`,
      `${PAUSED}${PAUSED}`,
      `${a}${b}${c} зараз`,
      `${a}${b}:${c}${d}`,
      `${a}${b}${c},${d}`,
      `${a}${b}${c}\n\n${d}`,
      'Зверніться зараз, з будь-яким питанням: 112 або 103.',
    ]
    for (const text of kept) expect(maskPausedLine(text), JSON.stringify(text)).toBe(text)
    // The note itself has no digits: masking twice changes nothing.
    expect(N).not.toMatch(/\p{N}/u)
    expect(maskPausedLine(`Номер ${PAUSED}`)).toBe(maskPausedLine(maskPausedLine(`Номер ${PAUSED}`)))
  })

  test('maskPausedLine: a digit drawn with a mark is still a digit; one small «з» is a preposition; bidi controls go', () => {
    const N = PAUSED_LINE_NOTE
    // Escapes only: each digit followed by what draws it differently.
    const marked = (marks: string) => [...PAUSED].map((d) => d + marks).join('')
    const keycap = marked('\u{FE0F}\u{20E3}')
    const cases: readonly (readonly [string, string])[] = [
      [keycap, N],
      [`Дзвоніть ${keycap}.`, `Дзвоніть ${N}.`],
      [marked('\u{20E3}'), N],
      [marked('\u{0336}'), N],
      [marked('\u{20DD}'), N],
      [marked('\u{0332}'), N],
      // A capital «З», or several in a row, still reads as threes.
      [`${PAUSED.slice(0, 1)} \u{0417}\u{0417}\u{0417}`, N],
    ]
    for (const [text, want] of cases) expect(maskPausedLine(text), JSON.stringify(text)).toBe(want)
    // The filter reads these the same way: the number is there.
    for (const text of [keycap, marked('\u{0336}')]) expect(noPausedLine(text), JSON.stringify(text)).toBe(false)
    // «У 7 з 33 випадків»: one small «з» between two numbers joins nothing.
    const [a, b, c] = [...PAUSED] as [string, string, string, string]
    const preposition = `У ${a} \u{0437} ${b}${c} випадків`
    expect(maskPausedLine(preposition)).toBe(preposition)
    // An override or an isolate around the reversed digits would draw the number: the controls go,
    // the digits stay as written.
    const reversed = [...PAUSED].reverse().join('')
    expect(maskPausedLine(`Номер \u{202E}${reversed}`)).toBe(`Номер ${reversed}`)
    expect(maskPausedLine(`\u{2067}${reversed}\u{2069} і 112`)).toBe(`${reversed} і 112`)
    // A text without a digit stays as it is (a tag is kept only when the mask leaves it unchanged).
    expect(maskPausedLine('\u{200F}тег')).toBe('\u{200F}тег')
  })

  test('a number split across tokens: masking the whole answer at every write catches it once its last digit is in', () => {
    const tokens = ['Можна подзвонити на ', PAUSED.slice(0, 1), PAUSED.slice(1, 2) + ' ', PAUSED.slice(2, 3), PAUSED.slice(3) + ' — або 112.']
    let partial = ''
    const writes: string[] = []
    for (const t of tokens) {
      partial += t
      writes.push(maskPausedLine(partial))
    }
    expect(partial).toContain(PAUSED.slice(0, 2) + ' ' + PAUSED.slice(2))
    expect(writes.at(-1)).toBe(`Можна подзвонити на ${PAUSED_LINE_NOTE} — або 112.`)
    for (const w of writes) expect(w.replace(/\D/g, '')).not.toContain(PAUSED)
  })

  test('the live region and the copied text carry the masked AI text; the person’s own words stay as written', () => {
    const now = new Date('2026-10-07T12:00:00Z')
    expect(sayAnswer(`Номер ${PAUSED}.`)).toBe(`Відповідь AI: Номер ${PAUSED_LINE_NOTE}.`)
    const talk = conversationText(
      [
        { role: 'assistant', content: `Спробуйте ${PAUSED}.` },
        { role: 'user', content: 'Синтетична відповідь людини.' },
      ],
      null,
      now,
    )
    expect(talk).toContain(`AI: Спробуйте ${PAUSED_LINE_NOTE}.`)
    expect(talk).toContain('Ви: Синтетична відповідь людини.')
    expect(talk).not.toContain(PAUSED)
    const draft: Draft = {
      title: `Тема ${PAUSED}`,
      bullets: [{ id: 'b0', text: `Теза про ${PAUSED}`, removed: false }],
      tags: [{ id: 't0', name: `день ${PAUSED}`, source: 'user' }],
    }
    const theses = thesesText(draft, now)
    expect(theses).not.toContain(PAUSED)
    expect(theses).toContain(`01 — Теза про ${PAUSED_LINE_NOTE}`)
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

  test('no named provider → no consent at all; named without a country → no consent either', () => {
    for (const llm_provider of [null, { name: 'Ollama Cloud (Ollama Inc.)', country: '' }]) {
      const m = run(INITIAL_MODEL, { type: 'boot', search: '' }, { type: 'me/ok', purpose: 'boot', me: ME }, {
        type: 'consents/ok',
        purpose: 'boot',
        consents: { ...CONSENTS_NONE, llm_provider },
      }).model
      const r = run(m, { type: 'consent/agree', checked: [...KINDS] })
      expect(r.effects, JSON.stringify(llm_provider)).toEqual([])
      expect(r.model.state, JSON.stringify(llm_provider)).toMatchObject({ s: 'consent', error: { code: 'provider_missing' } })
    }
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

  test('times run beside the history: none for the opening, the press for the message, `done` for the answer', () => {
    const DONE = { kind: 'done', text: 'Синтетична відповідь.', finishReason: 'stop', requestId: 'r' } as const
    const sent = run(booted(), { type: 'chat/send', text: 'Привіт', now: NOW - 5000 })
    expect(chatOf(sent.model).pending).toMatchObject({ at: NOW - 5000 })
    expect(chatOf(sent.model).session.times).toEqual([null])
    const first = run(sent.model, { type: 'turn/outcome', id: turnEffect(sent.effects).id, now: NOW, outcome: DONE })
    expect(chatOf(first.model).session.times).toEqual([null, NOW - 5000, NOW])
    // The second turn keeps the first one's times; a failed send and its «Надіслати ще раз» keep
    // the moment of the press, not of the repeat.
    const next = run(first.model, { type: 'chat/send', text: 'Ще одне', now: NOW + 1000 })
    const failed = run(next.model, { type: 'turn/outcome', id: turnEffect(next.effects).id, now: NOW + 2000, outcome: { kind: 'network' } }).model
    const again = run(failed, { type: 'chat/resend' })
    const second = run(again.model, { type: 'turn/outcome', id: turnEffect(again.effects).id, now: NOW + 9000, outcome: DONE })
    const c = chatOf(second.model)
    expect(c.session.times).toEqual([null, NOW - 5000, NOW, NOW + 1000, NOW + 9000])
    expect(c.session.times).toHaveLength(c.session.messages.length)
    // A send without a time (no clock in the caller): the message takes the answer's.
    const plain = run(booted(), { type: 'chat/send', text: 'Привіт' })
    const answered = run(plain.model, { type: 'turn/outcome', id: turnEffect(plain.effects).id, now: NOW, outcome: DONE })
    expect(chatOf(answered.model).session.times).toEqual([null, NOW, NOW])
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

  test('the AI’s theses arrive masked: the draft shows, copies and saves no paused number; a tag that spells it goes', () => {
    const { model, effects } = summarizing()
    const { id } = summarizeFx(effects)
    const spaced = PAUSED.slice(0, 1) + ' ' + PAUSED.slice(1)
    const review = run(model, {
      type: 'summarize/ok',
      id,
      draft: { title: `Дзвінок на ${PAUSED}`, bullets: ['перша', `Номер ${spaced} не відповів.`], tags: ['день', PAUSED, `лінія ${PAUSED}`] },
    }).model
    expect(review.state.s).toBe('review')
    const draft = (review.state as Extract<State, { s: 'review' }>).draft
    // The short note: no digits, nothing dated, and it does not eat the field's limit.
    expect(PAUSED_LINE_NOTE_SHORT).not.toMatch(/\p{N}/u)
    expect(codePoints(PAUSED_LINE_NOTE_SHORT)).toBeLessThanOrEqual(20)
    expect(draft.title).toBe(`Дзвінок на ${PAUSED_LINE_NOTE_SHORT}`)
    expect(draft.bullets.map((b) => b.text)).toEqual(['перша', `Номер ${PAUSED_LINE_NOTE_SHORT} не відповів.`])
    expect(draft.tags.map((t) => t.name)).toEqual(['день'])
    const save = run(review, { type: 'review/save' })
    const body = (save.effects.find((e) => e.type === 'save') as Extract<Effect, { type: 'save' }>).body
    expect(JSON.stringify(body)).not.toContain(PAUSED)
  })

  test('a number the AI broke over two lines is masked too: every screen draws a thesis on one line', () => {
    const { model, effects } = summarizing()
    const { id } = summarizeFx(effects)
    const split = `${PAUSED.slice(0, 2)}\n${PAUSED.slice(2)}`
    const review = run(model, {
      type: 'summarize/ok',
      id,
      draft: { title: `Лінія ${split}`, bullets: [`Номер ${split} мовчить.`, 'Перше.\nДруге.'], tags: [split, 'день'] },
    }).model
    const draft = (review.state as Extract<State, { s: 'review' }>).draft
    expect(draft.title).toBe(`Лінія ${PAUSED_LINE_NOTE_SHORT}`)
    // A field with nothing to mask stays as the AI wrote it.
    expect(draft.bullets.map((b) => b.text)).toEqual([`Номер ${PAUSED_LINE_NOTE_SHORT} мовчить.`, 'Перше.\nДруге.'])
    expect(draft.tags.map((t) => t.name)).toEqual(['день'])
    const body = (run(review, { type: 'review/save' }).effects.find((e) => e.type === 'save') as Extract<Effect, { type: 'save' }>).body
    for (const text of [body.title, ...body.bullets]) expect(noPausedLine(oneLine(text)), text).toBe(true)
    // The copy of the theses: one line per field.
    const copied = thesesText({ title: `Лінія ${split}`, bullets: [{ id: 'b0', text: `Теза ${split}`, removed: false }], tags: [] })
    expect(copied).not.toContain(split)
    expect(copied).toContain(`01 — Теза ${PAUSED_LINE_NOTE}`)
  })

  test('masked theses still fit: a long title or thesis with the number saves without a length error the person did not make', () => {
    const { model, effects } = summarizing()
    const { id } = summarizeFx(effects)
    const filler = 'дуже '.repeat(200)
    const fill = (head: string, tail: string, length: number) => head + filler.slice(0, length - codePoints(head) - codePoints(tail)) + tail
    // The number near the start, and at the very end, where a cut would fall inside the note.
    const title = fill(`Дзвінок на ${PAUSED}: `, '', 118)
    const early = fill(`Номер ${PAUSED} `, '.', 498)
    const late = fill('Теза ', ` ${PAUSED}`, 498)
    expect([title, early, late].map(codePoints)).toEqual([118, 498, 498])
    const review = run(model, { type: 'summarize/ok', id, draft: { title, bullets: [early, late], tags: [] } }).model
    const draft = (review.state as Extract<State, { s: 'review' }>).draft
    expect(codePoints(draft.title)).toBeLessThanOrEqual(120)
    for (const b of draft.bullets) expect(codePoints(b.text), b.text).toBeLessThanOrEqual(500)
    for (const text of [draft.title, ...draft.bullets.map((b) => b.text)]) {
      expect(text).not.toContain(PAUSED)
      // Never half a note: a bracket that opens closes.
      expect(text, text).not.toMatch(/\[[^\]]*$/)
    }
    const save = run(review, { type: 'review/save' })
    expect((save.model.state as Extract<State, { s: 'review' }>).issues).toEqual([])
    expect(types(save.effects)).toEqual(['save'])
    // A title that fits as masked is left whole.
    const short = run(model, { type: 'summarize/ok', id, draft: { title: `Дзвінок на ${PAUSED}`, bullets: ['a'], tags: [] } }).model
    expect((short.state as Extract<State, { s: 'review' }>).draft.title).not.toMatch(/…$/)
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
    // A 401 on GET /summaries (a refresh in flight) while on review keeps it as well.
    expect(run(review, { type: 'diary/retry' }, { type: 'diary/fail', error: apiError(401, 'unauthenticated') }).model.state).toMatchObject({
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

// ── The diary (§7.7): the wrappers, the helpers, the screen's steps ──────────────────────────

// ── «→ У тези», the reminder to pause, the end (spec §3.7.2, §3.7.7, §7.2, §7.5) ─────────────

test.describe('state: «→ У тези», the reminder to pause, the soft end', () => {
  /** A conversation of `turns` exchanges; message n (from 0) sent at `start + n·step`. */
  function talk(turns: number, opts: Readonly<{ start?: number; step?: number; reply?: (n: number) => string }> = {}): Model {
    const start = opts.start ?? NOW
    const step = opts.step ?? 1000
    let m = booted()
    for (let n = 0; n < turns; n++) {
      const at = start + n * step
      const sent = run(m, { type: 'chat/send', text: `Синтетичне повідомлення ${n + 1}.`, now: at })
      const text = opts.reply?.(n) ?? `Синтетична відповідь ${n + 1}.`
      m = run(sent.model, { type: 'turn/outcome', id: turnEffect(sent.effects).id, now: at + 500, outcome: { kind: 'done', text, finishReason: 'stop', requestId: 'r' } }).model
    }
    return m
  }
  const toReview = (m: Model, bullets: readonly string[] = ['перша', 'друга', 'третя']): Model => {
    const s = run(m, { type: 'chat/summarize' })
    const fx = s.effects.find((e): e is Extract<Effect, { type: 'summarize' }> => e.type === 'summarize')!
    return run(s.model, { type: 'summarize/ok', id: fx.id, draft: { title: 'Розмова про день', bullets: [...bullets], tags: ['день'] } }).model
  }
  const reviewOf = (m: Model): ReviewState => {
    expect(m.state.s).toBe('review')
    return m.state as ReviewState
  }

  test('a reply is marked and unmarked; only the AI’s replies, never the opening one; five at most; the turn and the theses bodies never carry a mark', () => {
    const m = talk(7)
    // Replies sit at 2, 4, 6…; 0 is the opening message, odd indices are the person's.
    const marked = run(m, { type: 'chat/mark', index: 2 }, { type: 'chat/mark', index: 4 }).model
    expect(chatOf(marked).session.marks).toEqual([2, 4])
    expect(chatOf(run(marked, { type: 'chat/mark', index: 2 }).model).session.marks).toEqual([4])
    for (const index of [0, 1, 3, 99, -2, 2.5, Number.NaN]) {
      expect(run(m, { type: 'chat/mark', index }).model, `index ${index}`).toBe(m)
    }
    const full = run(m, ...[2, 4, 6, 8, 10].map((index): Action => ({ type: 'chat/mark', index }))).model
    expect(chatOf(full).session.marks).toHaveLength(MAX_MARKS)
    expect(run(full, { type: 'chat/mark', index: 12 }).model).toBe(full)
    // Taking one off makes room again.
    expect(chatOf(run(full, { type: 'chat/mark', index: 6 }, { type: 'chat/mark', index: 12 }).model).session.marks).toEqual([2, 4, 8, 10, 12])

    const sent = run(full, { type: 'chat/send', text: 'Ще одне.', now: NOW + 99_000 })
    expect(Object.keys(turnEffect(sent.effects).body).sort()).toEqual(['messages', 'scenario'])
    const sum = run(full, { type: 'chat/summarize' })
    const fx = sum.effects.find((e): e is Extract<Effect, { type: 'summarize' }> => e.type === 'summarize')!
    expect(Object.keys(fx.body).sort()).toEqual(['messages', 'scenario'])
    expect(JSON.stringify(fx.body)).not.toContain('marks')
  })

  test('marks live with the conversation: the theses and back keep them; a new conversation and the crisis have none; no mark is set outside the conversation', () => {
    const m = run(talk(2), { type: 'chat/mark', index: 2 }).model
    const back = run(toReview(m), { type: 'review/back' }).model
    expect(chatOf(back).session.marks).toEqual([2])
    const review = toReview(m)
    expect(run(review, { type: 'chat/mark', index: 4 }).model).toBe(review)
    const sent = run(m, { type: 'chat/send', text: 'Синтетичне повідомлення.', now: NOW + 9000 })
    const crisis = run(sent.model, { type: 'turn/outcome', id: turnEffect(sent.effects).id, now: NOW, outcome: { kind: 'crisis', source: 'keyword', helplines: FALLBACK } }).model
    expect(crisis.state.s).toBe('crisis')
    expect(run(crisis, { type: 'chat/mark', index: 2 }).model).toBe(crisis)
    expect(chatOf(run(booted(), { type: 'chat/scenario', id: 'day' }).model).session.marks).toEqual([])
  })

  test('on the theses the marked replies wait as candidates: «Додати до тез» makes one a thesis (never a sixth), «Прибрати» takes its mark off; not while saving', () => {
    const m = run(talk(4), { type: 'chat/mark', index: 4 }, { type: 'chat/mark', index: 2 }).model
    const review = toReview(m)
    expect(markCandidates(reviewOf(review))).toEqual([
      { index: 4, text: 'Синтетична відповідь 2.' },
      { index: 2, text: 'Синтетична відповідь 1.' },
    ])
    const taken = run(review, { type: 'review/take', index: 2 }).model
    expect(reviewOf(taken).draft.bullets.map((b) => [b.id, b.text])).toEqual([
      ['b0', 'перша'],
      ['b1', 'друга'],
      ['b2', 'третя'],
      ['m2', 'Синтетична відповідь 1.'],
    ])
    expect(markCandidates(reviewOf(taken)).map((c) => c.index)).toEqual([4])
    // A taken thesis is a thesis: removed, it does not come back as a candidate (it has «Повернути»).
    const removed = run(taken, {
      type: 'review/update',
      draft: { ...reviewOf(taken).draft, bullets: reviewOf(taken).draft.bullets.map((b) => (b.id === 'm2' ? { ...b, removed: true } : b)) },
    }).model
    expect(markCandidates(reviewOf(removed)).map((c) => c.index)).toEqual([4])
    // Five theses: the candidate waits.
    const five = toReview(m, ['1', '2', '3', '4', '5'])
    expect(run(five, { type: 'review/take', index: 2 }).model).toBe(five)
    // «Прибрати»: off the candidates and off the conversation.
    const dropped = run(review, { type: 'review/unmark', index: 4 }).model
    expect(markCandidates(reviewOf(dropped)).map((c) => c.index)).toEqual([2])
    expect(chatOf(run(dropped, { type: 'review/back' }).model).session.marks).toEqual([2])
    // While the save is on its way the draft is read-only.
    const saving = run(review, { type: 'review/save' }).model
    expect(reviewOf(saving).saving).toBe('saving')
    expect(run(saving, { type: 'review/take', index: 2 }).model).toBe(saving)
    expect(run(saving, { type: 'review/unmark', index: 2 }).model).toBe(saving)
    // «Скласти заново»: a new draft, the candidates again.
    const again = run(taken, { type: 'confirm/open', kind: 'regenerate' }, { type: 'confirm/accept' })
    const fx = again.effects.find((e): e is Extract<Effect, { type: 'summarize' }> => e.type === 'summarize')!
    const fresh = run(again.model, { type: 'summarize/ok', id: fx.id, draft: { title: 'Інша', bullets: ['одна'], tags: [] } }).model
    expect(markCandidates(reviewOf(fresh)).map((c) => c.index)).toEqual([4, 2])
  })

  test('a marked reply becomes one line of at most 500 code points, the paused number masked with the short note and never cut', () => {
    const spaced = PAUSED.slice(0, 1) + ' ' + PAUSED.slice(1)
    expect(markText('Перше.\n\nДруге   речення.')).toBe('Перше. Друге речення.')
    const masked = markText(`Можна подзвонити на ${spaced}, це безкоштовно.`)
    expect(masked).toContain(PAUSED_LINE_NOTE_SHORT)
    expect(masked).not.toMatch(/\p{N}/u)
    const long = markText(`${'слово '.repeat(120)}${spaced} кінець`)
    expect(codePoints(long)).toBeLessThanOrEqual(500)
    expect(long.endsWith('…')).toBe(true)
    expect(long).not.toMatch(/\p{N}/u)
    // Near the end the note goes whole or not at all.
    for (let pad = 470; pad <= 500; pad += 3) {
      const text = markText(`${'а'.repeat(pad)} ${spaced} хвіст`)
      expect(codePoints(text), `pad ${pad}`).toBeLessThanOrEqual(500)
      if (text.includes(PAUSED_LINE_NOTE_SHORT.slice(0, 3))) expect(text, `pad ${pad}`).toContain(PAUSED_LINE_NOTE_SHORT)
      expect(text, `pad ${pad}`).not.toMatch(/\p{N}/u)
    }
    // The candidate on the theses screen is that text.
    const m = run(talk(1, { reply: () => `Номер ${spaced} не відповідає.` }), { type: 'chat/mark', index: 2 }).model
    expect(markCandidates(reviewOf(toReview(m)))[0]!.text).toBe(`Номер ${PAUSED_LINE_NOTE_SHORT} не відповідає.`)
    // A number the reply broke over lines is one number on the thesis's one line: the reply is
    // put on one line first, masked after.
    for (const split of [
      `${PAUSED.slice(0, 2)}\n${PAUSED.slice(2)}`,
      `${PAUSED.slice(0, 1)}\r\n${PAUSED.slice(1)}`,
      `${PAUSED.slice(0, 2)}\u2028${PAUSED.slice(2)}`,
      `${PAUSED.slice(0, 2)}\n\n${PAUSED.slice(2)}`,
      [...PAUSED].join('\n'),
    ]) {
      const text = markText(`Лінія: ${split}`)
      expect(text, JSON.stringify(split)).toBe(`Лінія: ${PAUSED_LINE_NOTE_SHORT}`)
      expect(noPausedLine(text)).toBe(true)
    }
    const broken = run(talk(1, { reply: () => `Подзвоніть на ${PAUSED.slice(0, 2)}\n${PAUSED.slice(2)}.` }), { type: 'chat/mark', index: 2 }).model
    expect(markCandidates(reviewOf(toReview(broken)))[0]!.text).toBe(`Подзвоніть на ${PAUSED_LINE_NOTE_SHORT}.`)
    // The bidi controls the mask takes out leave no two spaces side by side.
    expect(markText(`а \u200E б ${PAUSED}`)).toBe(`а б ${PAUSED_LINE_NOTE_SHORT}`)
  })

  test('«Збережено» keeps one thought to take along: the first saved thesis that came from a mark — none without one', () => {
    const m = run(talk(2), { type: 'chat/mark', index: 4 }).model
    const review = run(toReview(m), { type: 'review/take', index: 4 }).model
    const save = run(review, { type: 'review/save' })
    const fx = save.effects[0] as Extract<Effect, { type: 'save' }>
    expect(fx.body.bullets).toEqual(['перша', 'друга', 'третя', 'Синтетична відповідь 2.'])
    const stored: SummaryOut = { ...SUMMARY, bullets: ['перша', 'друга', 'третя', 'Синтетична відповідь 2 (як зберіг сервер).'] }
    expect(run(save.model, { type: 'save/ok', id: fx.id, summary: stored }).model.state).toEqual({ s: 'saved', summary: stored, keep: 'Синтетична відповідь 2 (як зберіг сервер).' })
    // Not taken: nothing to take along (the shape of `saved` stays as it was).
    const plain = run(toReview(m), { type: 'review/save' })
    const pfx = plain.effects[0] as Extract<Effect, { type: 'save' }>
    expect(run(plain.model, { type: 'save/ok', id: pfx.id, summary: SUMMARY }).model.state).toEqual({ s: 'saved', summary: SUMMARY })
    // A save confirmed by the newest record after an unknown result keeps it too.
    const unknown = run(review, { type: 'review/save' })
    const ufx = unknown.effects[0] as Extract<Effect, { type: 'save' }>
    const lost = run(unknown.model, { type: 'save/fail', id: ufx.id, error: apiError(0, 'network') }).model
    const retry = run(lost, { type: 'review/save' })
    const check = retry.effects[0] as Extract<Effect, { type: 'save-check' }>
    expect(check.type).toBe('save-check')
    const newest: SummaryOut = { ...SUMMARY, scenario: 'free', title: 'Розмова про день', bullets: ['перша', 'друга', 'третя', 'Синтетична відповідь 2.'], tags: [{ id: 't', name: 'день', source: 'ai' }] }
    const matched = run(retry.model, { type: 'save/check', id: check.id, list: { items: [newest], next_cursor: null }, date: null }).model
    expect(matched.state).toMatchObject({ s: 'saved', keep: 'Синтетична відповідь 2.' })
  })

  test('the reminder to pause: after 60 replies with the answer that makes them, or 40 minutes after the first message — once, never mid-answer', () => {
    expect(PAUSE_AFTER_MS).toBe(40 * 60_000)
    expect(PAUSE_AFTER_REPLIES).toBe(60)
    // 29 exchanges = 58 replies: nothing; the 30th answer brings it, as `count`.
    const almost = talk(29)
    expect(chatOf(almost).session.pause).toBe('none')
    expect(pauseDue(chatOf(almost).session, NOW + 60_000)).toBeNull()
    const sixty = run(almost, { type: 'chat/send', text: 'Ще.', now: NOW + 60_000 })
    const counted = run(sixty.model, { type: 'turn/outcome', id: turnEffect(sixty.effects).id, now: NOW + 61_000, outcome: { kind: 'done', text: 'Відповідь.', finishReason: 'stop', requestId: 'r' } }).model
    expect(chatOf(counted).session.messages.length - 1).toBe(60)
    expect(chatOf(counted).session.pause).toBe('count')

    // Time: the first message's press starts the 40 minutes; the page's timer asks.
    const m = talk(2, { start: NOW })
    expect(pauseAt(chatOf(m).session)).toBe(NOW + PAUSE_AFTER_MS)
    expect(run(m, { type: 'chat/pause-due', now: NOW + PAUSE_AFTER_MS - 1 }).model).toBe(m)
    const due = run(m, { type: 'chat/pause-due', now: NOW + PAUSE_AFTER_MS }).model
    expect(chatOf(due).session.pause).toBe('time')
    expect(pauseAt(chatOf(due).session)).toBeNull()
    // Once: «Сховати», and it never comes back — not with the timer, not with an answer.
    const hidden = run(due, { type: 'chat/pause-hide' }).model
    expect(chatOf(hidden).session.pause).toBe('hidden')
    expect(run(hidden, { type: 'chat/pause-due', now: NOW + 10 * PAUSE_AFTER_MS }).model).toBe(hidden)
    const later = run(hidden, { type: 'chat/send', text: 'Ще.', now: NOW + 3 * PAUSE_AFTER_MS })
    const after = run(later.model, { type: 'turn/outcome', id: turnEffect(later.effects).id, now: NOW + 3 * PAUSE_AFTER_MS, outcome: { kind: 'done', text: 'Так.', finishReason: 'stop', requestId: 'r' } }).model
    expect(chatOf(after).session.pause).toBe('hidden')

    // Mid-answer the timer is ignored; the answer's `done` brings the reminder.
    const sent = run(m, { type: 'chat/send', text: 'Довге питання.', now: NOW + PAUSE_AFTER_MS - 5000 })
    expect(run(sent.model, { type: 'chat/pause-due', now: NOW + PAUSE_AFTER_MS }).model).toBe(sent.model)
    const done = run(sent.model, { type: 'turn/outcome', id: turnEffect(sent.effects).id, now: NOW + PAUSE_AFTER_MS + 2000, outcome: { kind: 'done', text: 'Відповідь.', finishReason: 'stop', requestId: 'r' } }).model
    expect(chatOf(done).session.pause).toBe('time')
    // The clock starts at the press of the first message (answered() sends without one: its time
    // is that of `done`).
    expect(pauseAt(chatOf(answered(booted())).session)).toBe(NOW + PAUSE_AFTER_MS)
    expect(pauseAt(chatOf(booted()).session)).toBeNull()
  })

  test('the reminder lives with its conversation: the diary and the theses keep it; the crisis takes it; a new conversation starts over; «Зібрати тези» opens «Завершити розмову?»', () => {
    const due = run(talk(2), { type: 'chat/pause-due', now: NOW + PAUSE_AFTER_MS }).model
    expect(chatOf(due).session.pause).toBe('time')
    const journal = run(due, { type: 'journal/open', tz: 'Europe/Kyiv' }).model
    expect(journal.state.s).toBe('journal')
    expect(run(journal, { type: 'chat/pause-hide' }).model).toBe(journal)
    expect(chatOf(run(journal, { type: 'journal/back' }).model).session.pause).toBe('time')
    expect(chatOf(run(toReview(due), { type: 'review/back' }).model).session.pause).toBe('time')
    // «Зібрати тези»: the line goes, and the confirm that says the text goes to the provider again.
    const collect = run(due, { type: 'chat/pause-collect' })
    expect(chatOf(collect.model).session.pause).toBe('hidden')
    expect(collect.model.overlay).toEqual([{ o: 'confirm', kind: 'end', revoke: null, leaveTo: null, back: false }])
    expect(collect.effects).toEqual([])
    // While an answer comes: nothing (the button waits).
    const sent = run(due, { type: 'chat/send', text: 'Ще.', now: NOW + PAUSE_AFTER_MS + 1000 })
    expect(run(sent.model, { type: 'chat/pause-collect' }).model).toBe(sent.model)
    // The crisis: the conversation and its reminder are gone; a new conversation starts at none.
    const crisis = run(sent.model, { type: 'turn/outcome', id: turnEffect(sent.effects).id, now: NOW, outcome: { kind: 'crisis', source: 'keyword', helplines: FALLBACK } }).model
    expect(crisis.state.s).toBe('crisis')
    expect(run(crisis, { type: 'chat/pause-due', now: NOW + 9 * PAUSE_AFTER_MS }).model).toBe(crisis)
    const fresh = run(crisis, { type: 'confirm/open', kind: 'new-after-crisis' }, { type: 'confirm/accept' }).model
    expect(chatOf(fresh).session).toMatchObject({ pause: 'none', marks: [] })
  })
})

test.describe('api: the diary', () => {
  function recorder(responder: (url: string, init: RequestInit) => Response = () => new Response('{}', { status: 200 })) {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, init })
      return responder(url, init)
    }
    return { calls, api: createApi({ fetch: fetchFn }) }
  }

  test('GET /summaries: limit, cursor, q, tag in this order; a blank q is not sent', async () => {
    const { calls, api } = recorder(() => new Response(JSON.stringify({ items: [], next_cursor: null }), { status: 200 }))
    await api.summaries({ limit: 20, cursor: 'c1', q: 'сон', tag: '00000000-0000-4000-9000-000000000101' })
    await api.summaries({ q: '   ', tag: null })
    expect(calls.map((c) => c.url)).toEqual([
      '/api/v1/summaries?limit=20&cursor=c1&q=%D1%81%D0%BE%D0%BD&tag=00000000-0000-4000-9000-000000000101',
      '/api/v1/summaries?limit=20',
    ])
    expect(summariesPath({})).toBe('/summaries?limit=20')
  })

  test('PATCH /summaries/{id}: the id encoded, the body field by field, tags as {name, source}; DELETE is a 204 without a body', async () => {
    const { calls, api } = recorder((_url, init) =>
      init.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({ ...SUMMARY, title: 'Нова назва', edited_at: '2026-10-08T10:00:00Z' }), { status: 200 }),
    )
    const sloppy = {
      title: 'Нова назва',
      bullets: ['одна'],
      tags: [{ name: 'день', source: 'ai', id: 'tg-1', extra: 1 }],
      scenario: 'day',
      created_at: 'x',
    } as unknown as SummaryPatch
    const patched = await api.patchSummary('s/1?x', sloppy)
    expect(patched.ok && patched.data.title).toBe('Нова назва')
    expect(calls[0]!.url).toBe('/api/v1/summaries/s%2F1%3Fx')
    expect(calls[0]!.init.method).toBe('PATCH')
    expect((calls[0]!.init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ title: 'Нова назва', bullets: ['одна'], tags: [{ name: 'день', source: 'ai' }] })
    // Only what was given: a field left out stays as stored.
    expect(patchBody({ tags: [] })).toEqual({ tags: [] })
    expect(Object.keys(patchBody({ title: 't' }))).toEqual(['title'])
    const removed = await api.deleteSummary('s-1')
    expect(removed).toMatchObject({ ok: true, data: null, status: 204 })
    expect(calls[1]).toMatchObject({ url: '/api/v1/summaries/s-1', init: { method: 'DELETE' } })
    expect((calls[1]!.init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  test('GET /tags and GET /reviews/weekly: the query, light checks of the answers', async () => {
    const tagsApi = createApi({
      fetch: async () =>
        new Response(
          JSON.stringify([
            { id: 'tg-1', name: 'робота', count: 3 },
            { id: 'tg-1', name: 'дубль', count: 1 },
            { id: '', name: 'без id', count: 1 },
            { id: 'tg-2', name: '  ', count: 1 },
            { id: 'tg-3', name: 'сон', count: 'x' },
          ]),
          { status: 200 },
        ),
    })
    const tags = await tagsApi.tags()
    expect(tags.ok && tags.data).toEqual([
      { id: 'tg-1', name: 'робота', count: 3 },
      { id: 'tg-3', name: 'сон', count: 0 },
    ])
    const review = { week_start: '2026-10-05', week_end: '2026-10-12', tz: 'Europe/Kyiv', sessions: 2, prev_sessions: 1, delta: 1, top_tags: [{ name: 'робота', count: 2, prev_count: 0 }, { name: 7 }], recurring_tags: ['робота'], new_tags: [], faded_tags: ['спорт', 3] }
    const { calls, api } = recorder(() => new Response(JSON.stringify(review), { status: 200 }))
    const week = await api.weekly({ tz: 'Europe/Kyiv' })
    await api.weekly({ weekStart: '2026-09-28', tz: 'America/Argentina/Buenos_Aires' })
    await api.weekly({})
    expect(calls.map((c) => c.url)).toEqual([
      '/api/v1/reviews/weekly?tz=Europe%2FKyiv',
      '/api/v1/reviews/weekly?week_start=2026-09-28&tz=America%2FArgentina%2FBuenos_Aires',
      '/api/v1/reviews/weekly',
    ])
    expect(weeklyPath({ weekStart: null, tz: null })).toBe('/reviews/weekly')
    expect(week.ok && week.data).toMatchObject({ week_start: '2026-10-05', sessions: 2, top_tags: [{ name: 'робота', count: 2, prev_count: 0 }], faded_tags: ['спорт'] })
    const broken = await createApi({ fetch: async () => new Response(JSON.stringify({ week_start: 'today', sessions: 1 }), { status: 200 }) }).weekly({})
    expect(broken.ok === false && broken.error.code).toBe('internal')
  })
})

test.describe('journal helpers', () => {
  test('weeks move on the calendar, not the clock: month and year ends, a leap day', () => {
    expect(shiftDay('2026-10-19', -7)).toBe('2026-10-12')
    expect(shiftDay('2026-10-26', 7)).toBe('2026-11-02')
    expect(shiftDay('2026-12-28', 7)).toBe('2027-01-04')
    expect(shiftDay('2028-02-26', 7)).toBe('2028-03-04')
    expect(shiftDay('26.10.2026', 7)).toBeNull()
  })

  test('the search is what the server takes: trimmed, no NUL, ≤ 200 code points; spaces are no search', () => {
    expect(searchQuery('  сон \u0000 ')).toBe('сон')
    expect(searchQuery('   ')).toBe('')
    expect(codePoints(searchQuery('😀'.repeat(300)))).toBe(MAX_QUERY)
  })

  test('themes typed as one line: an AI tag keeps its source and stored spelling, a new one is the person’s, repeats go', () => {
    const own = [
      { id: 'a', name: 'робота', source: 'ai' as const },
      { id: 'b', name: 'пам’ять', source: 'user' as const },
    ]
    expect(tagsFromText('Робота, памʼять,  сон , , робота', own)).toEqual([
      { id: 't0', name: 'робота', source: 'ai' },
      { id: 't1', name: 'пам’ять', source: 'user' },
      { id: 't2', name: 'сон', source: 'user' },
    ])
  })

  test('the PATCH of an edit: nothing changed → no PATCH; a change sends all three fields; a check finds the field', () => {
    const form = formOf(SUMMARY)
    expect(form).toEqual({ id: 's-1', title: 'Розмова про день', bullets: ['перша', 'друга', 'третя'], tags: 'день' })
    expect(patchOf(form, SUMMARY)).toEqual({ ok: true, sent: null })
    const changed = patchOf({ ...form, bullets: ['перша', '  ', 'третя '], tags: 'день, сон' }, SUMMARY)
    expect(changed).toEqual({
      ok: true,
      sent: {
        body: { title: 'Розмова про день', bullets: ['перша', 'третя'], tags: [{ name: 'день', source: 'ai' }, { name: 'сон', source: 'user' }] },
        index: { bulletIndex: ['b0', 'b2'], tagIndex: ['t0', 't1'] },
      },
    })
    const wrong = patchOf({ ...form, title: ' ', tags: 'я'.repeat(41) }, SUMMARY)
    expect(wrong.ok === false && wrong.issues).toEqual([
      { field: 'title', reason: 'title-empty' },
      { field: 't0', reason: 'tag-long' },
    ])
  })

  test('a theme with a comma in its name: a title-only edit sends no themes; an edited line keeps it one theme, the AI’s still', () => {
    const comma: SummaryOut = { ...SUMMARY, tags: [{ id: 'c', name: 'стосунки, родина', source: 'ai' }, { id: 'd', name: 'робота', source: 'user' }] }
    const form = formOf(comma)
    expect(form.tags).toBe('стосунки, родина, робота')
    // Only the title changed: the stored themes stay as they are (no `tags` in the PATCH).
    expect(patchOf({ ...form, title: 'Нова назва' }, comma)).toEqual({
      ok: true,
      sent: { body: { title: 'Нова назва', bullets: ['перша', 'друга', 'третя'] }, index: { bulletIndex: ['b0', 'b1', 'b2'], tagIndex: [] } },
    })
    // The line edited: the stored name with a comma is one theme again, with its source.
    const themed = patchOf({ ...form, tags: 'Стосунки,  родина, робота, сон' }, comma)
    expect(themed.ok && themed.sent?.body.tags).toEqual([
      { name: 'стосунки, родина', source: 'ai' },
      { name: 'робота', source: 'user' },
      { name: 'сон', source: 'user' },
    ])
    expect(tagsFromText('родина, стосунки', comma.tags)).toEqual([
      { id: 't0', name: 'родина', source: 'user' },
      { id: 't1', name: 'стосунки', source: 'user' },
    ])
    // A theme the form leaves out (it spells the paused number) is not deleted by a title edit.
    const numbered: SummaryOut = { ...SUMMARY, tags: [{ id: 'x', name: PAUSED, source: 'ai' }, ...SUMMARY.tags] }
    const titled = patchOf({ ...formOf(numbered), title: 'Інша назва' }, numbered)
    expect(titled.ok && titled.sent !== null && 'tags' in titled.sent.body).toBe(false)
  })

  test('the edit form starts masked: the paused number never reaches a field', () => {
    const numbered: SummaryOut = { ...SUMMARY, title: `Лінія ${PAUSED}`, bullets: [`Дзвонити на ${PAUSED}`], tags: [{ id: 'x', name: PAUSED, source: 'ai' }, { id: 'y', name: 'день', source: 'ai' }] }
    const form = formOf(numbered)
    expect(JSON.stringify(form)).not.toContain(PAUSED)
    expect(form.title).toBe(`Лінія ${PAUSED_LINE_NOTE_SHORT}`)
    expect(form.tags).toBe('день')
    expect(entryMarkdown(numbered)).not.toContain(PAUSED)
  })

  test('a record with the number broken over two lines: the form, the page and the copy read it on one line', () => {
    const split = `${PAUSED.slice(0, 2)}\n${PAUSED.slice(2)}`
    const stored: SummaryOut = {
      ...SUMMARY,
      title: `Лінія ${split}`,
      bullets: [`Дзвонити на ${split}, цілодобово`, 'Перше.\nДруге.'],
      tags: [{ id: 'x', name: split, source: 'ai' }, { id: 'y', name: 'день', source: 'ai' }],
    }
    const form = formOf(stored)
    expect(form.title).toBe(`Лінія ${PAUSED_LINE_NOTE_SHORT}`)
    expect(form.bullets).toEqual([`Дзвонити на ${PAUSED_LINE_NOTE_SHORT}, цілодобово`, 'Перше.\nДруге.'])
    expect(form.tags).toBe('день')
    const md = entryMarkdown(stored)
    expect(md).not.toContain(split)
    expect(md).toContain(`## Лінія ${PAUSED_LINE_NOTE}`)
    expect(md).toContain(`- Дзвонити на ${PAUSED_LINE_NOTE}, цілодобово`)
    // What the diary and «Збережено» draw (no pre-wrap there): the number masked, a text with
    // nothing to mask as it was.
    expect(maskPausedLineInline(`Лінія ${split}`)).toBe(`Лінія ${PAUSED_LINE_NOTE}`)
    expect(maskPausedLineInline(`7\r\n${PAUSED.slice(1)}`)).toBe(PAUSED_LINE_NOTE)
    expect(maskPausedLineInline('Перше.\nДруге.')).toBe('Перше.\nДруге.')
    // The transcript is drawn pre-wrap: there a line break still ends a number (as on the screen).
    expect(maskPausedLine(`Лінія ${split}`)).toBe(`Лінія ${split}`)
  })

  test('one record as Markdown: a heading, the day, the theses as a list, the themes', () => {
    const md = entryMarkdown({ ...SUMMARY, created_at: '2026-10-07T12:00:00Z' })
    expect(md).toBe('## Розмова про день\n\n_7 жовтня 2026_\n\n- перша\n- друга\n- третя\n\nТеми: день')
  })
})

test.describe('state: the diary', () => {
  const TZ = 'Europe/Berlin'
  const REVIEW: WeeklyReviewOut = {
    week_start: '2026-10-19',
    week_end: '2026-10-26',
    tz: TZ,
    sessions: 2,
    prev_sessions: 1,
    delta: 1,
    top_tags: [{ name: 'день', count: 2, prev_count: 0 }],
    recurring_tags: ['день'],
    new_tags: ['день'],
    faded_tags: [],
  }
  const listFx = (effects: readonly Effect[]) => effects.find((e): e is Extract<Effect, { type: 'journal-list' }> => e.type === 'journal-list')!
  const weekFx = (effects: readonly Effect[]) => effects.find((e): e is Extract<Effect, { type: 'journal-week' }> => e.type === 'journal-week')!
  const patchFx = (effects: readonly Effect[]) => effects.find((e): e is Extract<Effect, { type: 'patch-summary' }> => e.type === 'patch-summary')!
  const tagsFx = (effects: readonly Effect[]) => effects.find((e): e is Extract<Effect, { type: 'journal-tags' }> => e.type === 'journal-tags')!
  const journalOf = (model: Model): JournalState => {
    expect(model.state.s).toBe('journal')
    return model.state as JournalState
  }

  /** The diary opened from `from`, its first page and week in. */
  function opened(from: Model = booted()) {
    const open = run(from, { type: 'journal/open', tz: TZ })
    const list = listFx(open.effects)
    const week = weekFx(open.effects)
    const loaded = run(
      open.model,
      { type: 'journal/list-ok', req: list.req, diary: DIARY },
      { type: 'journal/week-ok', req: week.req, review: REVIEW },
      { type: 'journal/tags-ok', req: tagsFx(open.effects).req, tags: [{ id: 'tg-1', name: 'день', count: 2 }] },
    )
    return { open, model: loaded.model }
  }

  test('opens lazily from a conversation at rest, «Збережено» and «Розмову завершено» — never while the AI works', () => {
    const { open } = opened()
    expect(types(open.effects)).toEqual(['journal-week', 'journal-tags', 'journal-list'])
    expect(weekFx(open.effects)).toMatchObject({ weekStart: null, tz: TZ })
    expect(listFx(open.effects)).toMatchObject({ q: '', tag: null, cursor: null })
    expect(journalOf(open.model)).toMatchObject({ loading: true, tags: { status: 'loading' }, week: { review: { status: 'loading' } } })
    const streaming = run(booted(), { type: 'chat/send', text: 'Текст' }).model
    expect(run(streaming, { type: 'journal/open', tz: TZ }).model.state.s).toBe('chat')
    const saved: Model = { ...booted(), state: { s: 'saved', summary: SUMMARY } }
    const ended: Model = { ...booted(), state: { s: 'ended' } }
    expect(canOpenJournal(saved.state) && canOpenJournal(ended.state)).toBe(true)
    expect(journalOf(run(saved, { type: 'journal/open', tz: null }).model).back).toBeNull()
    expect(canOpenJournal({ s: 'summarizing', session: chatOf(booted()).session, pending: null, id: 1, busy: 0, until: null, error: null })).toBe(false)
  })

  test('back to the conversation: the same session and the unsent message; from «Збережено» back is a new conversation', () => {
    const talk = answered(booted(), 'РОЗМОВА-ПІД-ЩОДЕННИКОМ')
    const { model } = opened(talk)
    expect(leaveGuard(model.state)).toBe(true)
    const back = run(model, { type: 'journal/back' })
    expect(chatOf(back.model).session).toEqual(chatOf(talk).session)
    expect(back.effects).toEqual([])
    const fromSaved = opened({ ...booted(), state: { s: 'saved', summary: SUMMARY } })
    expect(leaveGuard(fromSaved.model.state)).toBe(false)
    expect(chatOf(run(fromSaved.model, { type: 'journal/back' }).model).session.messages).toHaveLength(1)
  })

  test('the week: back a week by week_start, never past this week; a refused zone is retried once with Europe/Kyiv', () => {
    const { model, open } = opened()
    expect(journalOf(model).week).toMatchObject({ start: '2026-10-19', current: '2026-10-19' })
    expect(run(model, { type: 'journal/week', step: 1 }).effects).toEqual([])
    const prev = run(model, { type: 'journal/week', step: -1 })
    expect(weekFx(prev.effects)).toMatchObject({ weekStart: '2026-10-12', tz: TZ })
    const prevOk = run(prev.model, { type: 'journal/week-ok', req: weekFx(prev.effects).req, review: { ...REVIEW, week_start: '2026-10-12', week_end: '2026-10-19' } })
    const next = run(prevOk.model, { type: 'journal/week', step: 1 })
    expect(weekFx(next.effects)).toMatchObject({ weekStart: '2026-10-19' })

    const first = weekFx(open.effects)
    const refused = run(open.model, { type: 'journal/week-fail', req: first.req, error: apiError(422, 'invalid_timezone') })
    const retry = weekFx(refused.effects)
    expect(retry).toMatchObject({ weekStart: null, tz: 'Europe/Kyiv' })
    const again = run(refused.model, { type: 'journal/week-fail', req: retry.req, error: apiError(422, 'invalid_timezone') })
    expect(again.effects).toEqual([])
    expect(journalOf(again.model).week.review).toEqual({ status: 'failed' })
    // A late answer to the first request changes nothing.
    expect(run(refused.model, { type: 'journal/week-ok', req: first.req, review: REVIEW }).model).toBe(refused.model)
  })

  test('search, theme and «Показати ще» keep each other; a stale page is ignored; a gone theme resets the filter', () => {
    const { model } = opened()
    const search = run(model, { type: 'journal/search', q: '  день \u0000' })
    expect(listFx(search.effects)).toMatchObject({ q: 'день', tag: null, cursor: null })
    const tag = run(search.model, { type: 'journal/tag', id: 'tg-1' })
    const tagFx = listFx(tag.effects)
    expect(tagFx).toMatchObject({ q: 'день', tag: 'tg-1', cursor: null })
    // The search's answer comes after the theme's request went: it is not the list any more.
    expect(run(tag.model, { type: 'journal/list-ok', req: listFx(search.effects).req, diary: DIARY }).model).toBe(tag.model)
    const page1 = run(tag.model, { type: 'journal/list-ok', req: tagFx.req, diary: { items: [SUMMARY], nextCursor: 'c2' } })
    const more = run(page1.model, { type: 'journal/more' })
    expect(listFx(more.effects)).toMatchObject({ q: 'день', tag: 'tg-1', cursor: 'c2' })
    const page2 = run(more.model, { type: 'journal/list-ok', req: listFx(more.effects).req, diary: { items: [{ ...SUMMARY, id: 's-3' }], nextCursor: null } })
    expect(journalOf(page2.model).list?.items.map((i) => i.id)).toEqual(['s-1', 's-3'])
    const gone = run(page2.model, { type: 'journal/tags-ok', req: journalOf(page2.model).tagsReq, tags: [] })
    expect(listFx(gone.effects)).toMatchObject({ tag: null, cursor: null })
    const failed = run(page2.model, { type: 'journal/search', q: 'інше' })
    const failure = run(failed.model, { type: 'journal/list-fail', req: listFx(failed.effects).req, error: apiError(0, 'network') })
    expect(journalOf(failure.model)).toMatchObject({ failed: true, loading: false })
    expect(listFx(run(failure.model, { type: 'journal/retry' }).effects)).toMatchObject({ q: 'інше', cursor: null })
  })

  test('edit: nothing changed closes the form without a PATCH; a change goes field by field, the AI tag still «ai»', () => {
    const { model } = opened()
    const edit = run(model, { type: 'journal/edit', id: 's-1' })
    const form = journalOf(edit.model).edit!.form
    const same = run(edit.model, { type: 'journal/edit-save' })
    expect(same.effects).toEqual([])
    expect(journalOf(same.model).edit).toBeNull()
    const changed = run(edit.model, { type: 'journal/edit-update', form: { ...form, title: 'Інша назва', tags: 'день, сон' } }, { type: 'journal/edit-save' })
    const fx = patchFx(changed.effects)
    expect(fx).toMatchObject({ id: 's-1', body: { title: 'Інша назва', bullets: ['перша', 'друга', 'третя'], tags: [{ name: 'день', source: 'ai' }, { name: 'сон', source: 'user' }] } })
    expect(journalOf(changed.model).edit).toMatchObject({ saving: true })
    // One record at a time.
    expect(run(changed.model, { type: 'journal/edit', id: 's-2' }).model).toBe(changed.model)
    const stored = { ...SUMMARY, title: 'Інша назва', edited_at: '2026-10-08T10:00:00Z' }
    const ok = run(changed.model, { type: 'journal/patch-ok', req: fx.req, summary: stored })
    expect(journalOf(ok.model)).toMatchObject({ edit: null, notice: { kind: 'saved' } })
    expect(journalOf(ok.model).list?.items[0]).toEqual(stored)
    // The week and the themes again; the page's diary changes in place (no GET, no window without names).
    expect(types(ok.effects)).toEqual(['journal-week', 'journal-tags'])
    expect(ok.model.ctx.diary).toEqual({ status: 'ok', value: { items: [stored, DIARY.items[1]], nextCursor: null } })
  })

  test('PATCH errors: a 422 lands on its field; 404 drops the record; 403 consent_required from «Збережено» resumes the same PATCH', () => {
    const fromSaved = opened({ ...booted(), state: { s: 'saved', summary: SUMMARY } }).model
    const edit = run(fromSaved, { type: 'journal/edit', id: 's-1' })
    const form = journalOf(edit.model).edit!.form
    const save = run(edit.model, { type: 'journal/edit-update', form: { ...form, bullets: ['', 'друга', 'нова третя'] } }, { type: 'journal/edit-save' })
    const fx = patchFx(save.effects)
    expect(fx.body.bullets).toEqual(['друга', 'нова третя'])
    const invalid = run(save.model, { type: 'journal/patch-fail', req: fx.req, error: apiError(422, 'validation_error', { fields: ['bullets.1'] }) })
    expect(journalOf(invalid.model).edit).toMatchObject({ saving: false, error: null, issues: [{ field: 'b2', reason: 'bullet-invalid' }] })
    const gone = run(save.model, { type: 'journal/patch-fail', req: fx.req, error: apiError(404, 'not_found') })
    expect(journalOf(gone.model)).toMatchObject({ edit: null, notice: { kind: 'gone' } })
    expect(journalOf(gone.model).list?.items.map((i) => i.id)).toEqual(['s-2'])

    const resume = run(save.model, { type: 'journal/patch-fail', req: fx.req, error: apiError(403, 'consent_required', { missing: ['data_processing', 'age_18'] }) })
    expect(resume.model.state).toMatchObject({ s: 'consent', mode: 'resume', session: null, resume: { kind: 'patch' } })
    expect(resume.effects).toEqual([{ type: 'consents', purpose: 'fresh' }])
    const fresh = run(resume.model, { type: 'consents/ok', purpose: 'fresh', consents: { ...CONSENTS_OK, missing: ['data_processing', 'age_18'] } })
    const agree = run(fresh.model, { type: 'consent/agree', checked: [...KINDS] })
    const granted = run(agree.model, { type: 'grant/ok', consents: CONSENTS_OK })
    expect(journalOf(granted.model)).toMatchObject({ back: null, edit: { saving: true } })
    expect(patchFx(granted.effects).body).toEqual(fx.body)
    expect(run(save.model, { type: 'journal/patch-fail', req: fx.req, error: apiError(401, 'unauthenticated') }).model.state.s).toBe('signed-out')
  })

  test('delete: a confirm that names the record, one DELETE, the record gone; a 404 is gone too', () => {
    const { model } = opened()
    const ask = run(model, { type: 'confirm/open', kind: 'delete-summary', summary: 's-2' })
    expect(ask.model.overlay).toEqual([{ o: 'confirm', kind: 'delete-summary', revoke: null, leaveTo: null, back: false, summary: 's-2' }])
    const accepted = run(ask.model, { type: 'confirm/accept' })
    expect(accepted.model.overlay).toEqual([])
    expect(accepted.effects).toEqual([{ type: 'delete-summary', id: 's-2' }])
    expect(journalOf(accepted.model).deleting).toBe('s-2')
    expect(run(accepted.model, { type: 'confirm/open', kind: 'delete-summary', summary: 's-1' }).model.overlay).toEqual([])
    const done = run(accepted.model, { type: 'journal/delete-ok', id: 's-2' })
    expect(journalOf(done.model)).toMatchObject({ deleting: null, notice: { kind: 'deleted' } })
    expect(journalOf(done.model).list?.items.map((i) => i.id)).toEqual(['s-1'])
    expect(types(done.effects)).toEqual(['journal-week', 'journal-tags'])
    const missing = run(accepted.model, { type: 'journal/delete-fail', id: 's-2', error: apiError(404, 'not_found') })
    expect(journalOf(missing.model).list?.items.map((i) => i.id)).toEqual(['s-1'])
    const failed = run(accepted.model, { type: 'journal/delete-fail', id: 's-2', error: apiError(0, 'network') })
    expect(journalOf(failed.model)).toMatchObject({ deleting: null, notice: { kind: 'delete-failed', error: { code: 'network' } } })
  })

  test('«Повернутися до цього»: a revisit conversation with that one record; over a conversation under way, a confirm first', () => {
    const { model } = opened()
    const go = run(model, { type: 'journal/revisit', id: 's-2' })
    const c = chatOf(go.model)
    expect(c.session).toMatchObject({ scenario: 'revisit', revisitIds: ['s-2'] })
    expect(go.effects).toEqual([])
    const sent = run(go.model, { type: 'chat/send', text: 'Повертаюся' })
    expect(turnEffect(sent.effects).body.revisit_summary_ids).toEqual(['s-2'])

    const talk = opened(answered(booted())).model
    const ask = run(talk, { type: 'journal/revisit', id: 's-1' })
    expect(ask.model.overlay).toEqual([{ o: 'confirm', kind: 'revisit-restart', revoke: null, leaveTo: null, back: false, summary: 's-1' }])
    const replaced = run(ask.model, { type: 'confirm/accept' })
    expect(chatOf(replaced.model).session).toMatchObject({ scenario: 'revisit', revisitIds: ['s-1'] })
    expect(chatOf(replaced.model).session.messages).toHaveLength(1)
    expect(types(replaced.effects)).toEqual(['composer/clear', 'announcer/clear'])
    // Without the revisit scenario (GET /scenarios failed) there is nothing to go back with.
    const onlyFree = opened(run(INITIAL_MODEL, { type: 'boot', search: '' }, { type: 'me/ok', purpose: 'boot', me: ME }, { type: 'consents/ok', purpose: 'boot', consents: CONSENTS_OK }, { type: 'scenarios/fail', error: apiError(502, 'upstream_unavailable') }).model).model
    expect(run(onlyFree, { type: 'journal/revisit', id: 's-1' }).model).toBe(onlyFree)
  })

  test('an edit typed and not saved: every way off the page asks «Скасувати зміни?» first; unchanged, the page just goes', () => {
    const { model } = opened()
    const editing = run(model, { type: 'journal/edit', id: 's-1' }).model
    const form = journalOf(editing).edit!.form
    // Opened, nothing typed: nothing to lose, no question.
    expect(editUnsaved(editing.state)).toBe(false)
    expect(run(editing, { type: 'confirm/open', kind: 'discard-edit' }).model.overlay).toEqual([])
    expect(run(editing, { type: 'journal/back' }).model.state.s).toBe('chat')
    const typed = run(editing, { type: 'journal/edit-update', form: { ...form, title: 'Синтетична нова назва' } }).model
    expect(editUnsaved(typed.state)).toBe(true)
    // A field emptied (it fails the check) is a change too.
    expect(editUnsaved(run(editing, { type: 'journal/edit-update', form: { ...form, title: ' ' } }).model.state)).toBe(true)

    // «До розмови» / «Нова розмова».
    const ask = run(typed, { type: 'journal/back' })
    expect(ask.model.overlay).toEqual([{ o: 'confirm', kind: 'discard-edit', revoke: null, leaveTo: null, back: false }])
    expect(ask.effects).toEqual([])
    // «Редагувати далі»: the form and what was typed stay.
    expect(journalOf(run(ask.model, { type: 'overlay/close' }).model).edit?.form.title).toBe('Синтетична нова назва')
    // «Скасувати зміни»: the edit goes, then the way off the page — no PATCH.
    const gone = run(ask.model, { type: 'confirm/accept' })
    expect(gone.model.state.s).toBe('chat')
    expect(gone.model.overlay).toEqual([])
    expect(types(gone.effects)).not.toContain('patch-summary')

    // «Повернутися до цього» carries its record through the question.
    const revisit = run(typed, { type: 'journal/revisit', id: 's-2' })
    expect(revisit.model.overlay).toEqual([{ o: 'confirm', kind: 'discard-edit', revoke: null, leaveTo: null, back: false, summary: 's-2' }])
    expect(chatOf(run(revisit.model, { type: 'confirm/accept' }).model).session).toMatchObject({ scenario: 'revisit', revisitIds: ['s-2'] })

    // The wordmark: home after the answer.
    const home = run(typed, { type: 'confirm/open', kind: 'discard-edit', leaveTo: 'home' })
    expect(home.model.overlay).toEqual([{ o: 'confirm', kind: 'discard-edit', revoke: null, leaveTo: 'home', back: false }])
    expect(run(home.model, { type: 'confirm/accept' }).effects).toEqual([{ type: 'navigate', href: '/' }])
    // With a conversation under the diary, its own question follows instead.
    const under = opened(answered(booted())).model
    const underEditing = run(under, { type: 'journal/edit', id: 's-1' }).model
    const underTyped = run(underEditing, { type: 'journal/edit-update', form: { ...form, title: 'Синтетична нова назва' } }).model
    const homeUnder = run(underTyped, { type: 'confirm/open', kind: 'discard-edit', leaveTo: 'home' }, { type: 'confirm/accept' })
    expect(homeUnder.model.overlay).toEqual([{ o: 'confirm', kind: 'leave', revoke: null, leaveTo: 'home', back: false }])
    expect(homeUnder.effects).toEqual([])

    // «Вийти» asks too, though no conversation is under the diary.
    expect(leaveGuard(typed.state)).toBe(false)
    expect(run(typed, { type: 'account/logout' }).model.overlay.at(-1)).toMatchObject({ o: 'confirm', kind: 'logout' })
    expect(types(run(editing, { type: 'account/logout' }).effects)).toContain('logout')
  })

  test('a 401 on the diary ends the session with the conversation kept; answers after leaving change nothing', () => {
    const talk = answered(booted(), 'ЗБЕРЕЖЕНА-РОЗМОВА')
    const open = run(talk, { type: 'journal/open', tz: TZ })
    const expired = run(open.model, { type: 'journal/list-fail', req: listFx(open.effects).req, error: apiError(401, 'unauthenticated') })
    expect(expired.model.state).toMatchObject({ s: 'session-expired', stale: { messages: chatOf(talk).session.messages } })
    const back = run(open.model, { type: 'journal/back' })
    expect(run(back.model, { type: 'journal/list-ok', req: listFx(open.effects).req, diary: DIARY }).model).toBe(back.model)
  })

  test('an edit keeps its record through a search, a theme and a filter reset: the form never loses its row', () => {
    const { model } = opened()
    const edit = run(model, { type: 'journal/edit', id: 's-1' })
    const search = run(edit.model, { type: 'journal/search', q: 'інший' })
    // The search finds only s-2: the record being edited stays, first, with its form.
    const found = run(search.model, { type: 'journal/list-ok', req: listFx(search.effects).req, diary: { items: [DIARY.items[1]!], nextCursor: 'c2' } })
    expect(journalOf(found.model).list?.items.map((i) => i.id)).toEqual(['s-1', 's-2'])
    expect(journalOf(found.model).edit?.form.id).toBe('s-1')
    // «Показати ще» does not repeat it.
    const more = run(found.model, { type: 'journal/more' })
    const page2 = run(more.model, { type: 'journal/list-ok', req: listFx(more.effects).req, diary: { items: [SUMMARY], nextCursor: null } })
    expect(journalOf(page2.model).list?.items.map((i) => i.id)).toEqual(['s-1', 's-2'])
    // A theme, then the theme gone (its last record went): the record under edit stays each time.
    const themed = run(found.model, { type: 'journal/tag', id: 'tg-1' })
    const themePage = run(themed.model, { type: 'journal/list-ok', req: listFx(themed.effects).req, diary: { items: [], nextCursor: null } })
    expect(journalOf(themePage.model).list?.items.map((i) => i.id)).toEqual(['s-1'])
    const goneTheme = run(themePage.model, { type: 'journal/tags-ok', req: journalOf(themePage.model).tagsReq, tags: [] })
    expect(journalOf(goneTheme.model).tag).toBeNull()
    const reset = run(goneTheme.model, { type: 'journal/list-ok', req: listFx(goneTheme.effects).req, diary: { items: [DIARY.items[1]!], nextCursor: null } })
    expect(journalOf(reset.model).list?.items.map((i) => i.id)).toEqual(['s-1', 's-2'])
    // «Зберегти» still finds it: what was typed goes out.
    const typed = run(reset.model, { type: 'journal/edit-update', form: { ...journalOf(reset.model).edit!.form, title: 'Набране під час пошуку' } }, { type: 'journal/edit-save' })
    expect(patchFx(typed.effects)).toMatchObject({ id: 's-1', body: { title: 'Набране під час пошуку' } })
    // Closed, it is a record like any other: the next search leaves it out.
    const closed = run(found.model, { type: 'journal/edit-cancel' }, { type: 'journal/search', q: 'інший запис' })
    const after = run(closed.model, { type: 'journal/list-ok', req: listFx(closed.effects).req, diary: { items: [DIARY.items[1]!], nextCursor: null } })
    expect(journalOf(after.model).list?.items.map((i) => i.id)).toEqual(['s-2'])
  })

  test('theme answers are stamped: an older GET /tags that lands last changes nothing', () => {
    const { model } = opened()
    const edit = run(model, { type: 'journal/edit', id: 's-1' })
    const form = journalOf(edit.model).edit!.form
    const save = run(edit.model, { type: 'journal/edit-update', form: { ...form, tags: 'сон' } }, { type: 'journal/edit-save' })
    const patched = run(save.model, { type: 'journal/patch-ok', req: patchFx(save.effects).req, summary: { ...SUMMARY, tags: [{ id: 'tg-2', name: 'сон', source: 'user' }] } })
    const first = tagsFx(patched.effects)
    const removed = run(patched.model, { type: 'confirm/open', kind: 'delete-summary', summary: 's-2' }, { type: 'confirm/accept' }, { type: 'journal/delete-ok', id: 's-2' })
    const second = tagsFx(removed.effects)
    expect(second.req).not.toBe(first.req)
    const latest = run(removed.model, { type: 'journal/tags-ok', req: second.req, tags: [{ id: 'tg-2', name: 'сон', count: 1 }] })
    // The PATCH's answer, older, comes last: «день» does not come back.
    const stale = run(latest.model, { type: 'journal/tags-ok', req: first.req, tags: [{ id: 'tg-1', name: 'день', count: 1 }, { id: 'tg-2', name: 'сон', count: 1 }] })
    expect(stale.model).toBe(latest.model)
    expect(run(latest.model, { type: 'journal/tags-fail', req: first.req, error: apiError(0, 'network') }).model).toBe(latest.model)
  })

  test('after a PATCH or a DELETE the page’s diary changes in place: no window where it is loading, no extra GET', () => {
    const { model } = opened()
    const edit = run(model, { type: 'journal/edit', id: 's-2' })
    const form = journalOf(edit.model).edit!.form
    const save = run(edit.model, { type: 'journal/edit-update', form: { ...form, title: 'Нова назва' } }, { type: 'journal/edit-save' })
    const stored = { ...DIARY.items[1]!, title: 'Нова назва', edited_at: '2026-10-08T10:00:00Z' }
    const ok = run(save.model, { type: 'journal/patch-ok', req: patchFx(save.effects).req, summary: stored })
    expect(types(ok.effects)).toEqual(['journal-week', 'journal-tags'])
    expect(ok.model.ctx.diary).toEqual({ status: 'ok', value: { items: [SUMMARY, stored], nextCursor: null } })
    const removed = run(ok.model, { type: 'confirm/open', kind: 'delete-summary', summary: 's-1' }, { type: 'confirm/accept' }, { type: 'journal/delete-ok', id: 's-1' })
    expect(types(removed.effects)).toEqual(['delete-summary', 'journal-week', 'journal-tags'])
    expect(removed.model.ctx.diary).toEqual({ status: 'ok', value: { items: [stored], nextCursor: null } })
    // «Повернутися до цього» right after: the name is there at once.
    const go = run(removed.model, { type: 'journal/revisit', id: 's-2' })
    expect(go.model.ctx.diary.status === 'ok' && go.model.ctx.diary.value.items.map((i) => i.title)).toEqual(['Нова назва'])
  })

  test('a record taken back from the diary keeps its name when the picker loads a first page without it', () => {
    const { model } = opened()
    const later: SummaryOut = { ...SUMMARY, id: 's-9', title: 'Запис із другої сторінки' }
    const search = run(model, { type: 'journal/search', q: 'другої' })
    const found = run(search.model, { type: 'journal/list-ok', req: listFx(search.effects).req, diary: { items: [later], nextCursor: null } })
    const go = run(found.model, { type: 'journal/revisit', id: 's-9' })
    expect(chatOf(go.model).session.revisitIds).toEqual(['s-9'])
    const names = (m: Model) => (m.ctx.diary.status === 'ok' ? m.ctx.diary.value.items.map((i) => i.id) : [])
    expect(names(go.model)).toContain('s-9')
    // «Змінити»: the picker's first page replaces the page's diary — the chosen record stays in it.
    const pickerOpen = run(go.model, { type: 'revisit/open' })
    const page = run(pickerOpen.model, { type: 'revisit/list-ok', purpose: 'pick', q: '', cursor: null, diary: DIARY })
    expect(names(page.model)).toEqual(['s-1', 's-2', 's-9'])
    // Chosen in the picker from a search, a record off the first page is named too.
    const picked = run(page.model, { type: 'revisit/search', q: 'далеко' })
    const far: SummaryOut = { ...SUMMARY, id: 's-12', title: 'Далекий запис' }
    const farPage = run(picked.model, { type: 'revisit/list-ok', purpose: 'pick', q: 'далеко', cursor: null, diary: { items: [far], nextCursor: null } })
    const chosen = run(farPage.model, { type: 'revisit/toggle', id: 's-12' }, { type: 'revisit/confirm' })
    expect(chatOf(chosen.model).session.revisitIds).toEqual(['s-9', 's-12'])
    expect(names(chosen.model)).toEqual(['s-1', 's-2', 's-9', 's-12'])
  })

  test('a page emptied by deletes with more records behind it asks for the first page again', () => {
    const open = run(booted(), { type: 'journal/open', tz: TZ })
    const one = run(open.model, { type: 'journal/list-ok', req: listFx(open.effects).req, diary: { items: [SUMMARY], nextCursor: 'c2' } })
    const removed = run(one.model, { type: 'confirm/open', kind: 'delete-summary', summary: 's-1' }, { type: 'confirm/accept' }, { type: 'journal/delete-ok', id: 's-1' })
    expect(listFx(removed.effects)).toMatchObject({ cursor: null, q: '', tag: null })
    expect(journalOf(removed.model)).toMatchObject({ loading: true, notice: { kind: 'deleted' } })
  })

  test('«До розмови» waits while a change is on its way: its answer is the page’s to show', () => {
    const talk = opened(answered(booted())).model
    const edit = run(talk, { type: 'journal/edit', id: 's-1' })
    const form = journalOf(edit.model).edit!.form
    const save = run(edit.model, { type: 'journal/edit-update', form: { ...form, title: 'Інша' } }, { type: 'journal/edit-save' })
    expect(run(save.model, { type: 'journal/back' }).model).toBe(save.model)
    const deleting = run(talk, { type: 'confirm/open', kind: 'delete-summary', summary: 's-2' }, { type: 'confirm/accept' })
    expect(run(deleting.model, { type: 'journal/back' }).model).toBe(deleting.model)
    expect(chatOf(run(talk, { type: 'journal/back' }).model).session).toEqual(chatOf(answered(booted())).session)
    // «Повернутися до цього» leaves the page too: it waits the same way, its confirm does not open.
    expect(journalBusy(journalOf(save.model)) && journalBusy(journalOf(deleting.model)) && !journalBusy(journalOf(talk))).toBe(true)
    expect(run(save.model, { type: 'journal/revisit', id: 's-2' }).model).toBe(save.model)
    expect(run(deleting.model, { type: 'journal/revisit', id: 's-1' }).model).toBe(deleting.model)
    const fromSaved = opened({ ...booted(), state: { s: 'saved', summary: SUMMARY } }).model
    const busy = run(fromSaved, { type: 'confirm/open', kind: 'delete-summary', summary: 's-2' }, { type: 'confirm/accept' })
    expect(run(busy.model, { type: 'journal/revisit', id: 's-1' }).model).toBe(busy.model)
    // The answer lands: the way out is open again.
    const done = run(deleting.model, { type: 'journal/delete-ok', id: 's-2' })
    expect(run(done.model, { type: 'journal/back' }).model.state.s).toBe('chat')
  })

  test('a DELETE on its way when a PATCH asks for consent: back from it, nothing waits for its lost answer; a going record is not edited', () => {
    const talk = opened(answered(booted())).model
    const deleting = run(talk, { type: 'confirm/open', kind: 'delete-summary', summary: 's-2' }, { type: 'confirm/accept' })
    expect(run(deleting.model, { type: 'journal/edit', id: 's-2' }).model).toBe(deleting.model)
    const edit = run(deleting.model, { type: 'journal/edit', id: 's-1' })
    const form = journalOf(edit.model).edit!.form
    const save = run(edit.model, { type: 'journal/edit-update', form: { ...form, title: 'Інша' } }, { type: 'journal/edit-save' })
    const resume = run(save.model, { type: 'journal/patch-fail', req: patchFx(save.effects).req, error: apiError(403, 'consent_required', { missing: ['data_processing'] }) })
    const fresh = run(resume.model, { type: 'consents/ok', purpose: 'fresh', consents: { ...CONSENTS_OK, missing: ['data_processing'] } })
    const granted = run(fresh.model, { type: 'consent/agree', checked: [...KINDS] }, { type: 'grant/ok', consents: CONSENTS_OK })
    expect(journalOf(granted.model)).toMatchObject({ deleting: null, edit: { saving: true } })
    const done = run(granted.model, { type: 'journal/patch-ok', req: patchFx(granted.effects).req, summary: { ...SUMMARY, title: 'Інша' } })
    expect(journalBusy(journalOf(done.model))).toBe(false)
    expect(chatOf(run(done.model, { type: 'journal/back' }).model).session.messages).toHaveLength(3)
  })

  test('the page’s diary keeps chosen names through the picker: another search, a 404’s first page; a first page still on its way is dropped', () => {
    const go = run(opened().model, { type: 'journal/revisit', id: 's-1' })
    const names = (m: Model) => (m.ctx.diary.status === 'ok' ? m.ctx.diary.value.items.map((i) => i.id) : [])
    const open = run(go.model, { type: 'revisit/open' }, { type: 'revisit/list-ok', purpose: 'pick', q: '', cursor: null, diary: DIARY })
    // Chosen from one search, then another search replaces that list: the name is already kept.
    const far: SummaryOut = { ...SUMMARY, id: 's-12', title: 'Далекий запис' }
    const one = run(open.model, { type: 'revisit/search', q: 'далеко' })
    const found = run(one.model, { type: 'revisit/list-ok', purpose: 'pick', q: 'далеко', cursor: null, diary: { items: [far], nextCursor: null } }, { type: 'revisit/toggle', id: 's-12' })
    const other = run(found.model, { type: 'revisit/search', q: 'інше' })
    const otherList = run(other.model, { type: 'revisit/list-ok', purpose: 'pick', q: 'інше', cursor: null, diary: { items: [], nextCursor: null } }, { type: 'revisit/confirm' })
    expect(chatOf(otherList.model).session.revisitIds).toEqual(['s-1', 's-12'])
    expect(names(otherList.model)).toEqual(['s-1', 's-2', 's-12'])
    // A 404: one of the chosen is gone — the first page is the diary as the server has it.
    const gone = run(otherList.model, { type: 'revisit/list-ok', purpose: 'pick-404', q: '', cursor: null, diary: { items: [DIARY.items[1]!], nextCursor: null } })
    expect(names(gone.model)).toEqual(['s-2'])

    // Taken back while the page's first page is still on its way: the record alone, the late page dropped.
    const loading: Model = { ...opened().model, ctx: { ...opened().model.ctx, diary: { status: 'loading' } } }
    const early = run(loading, { type: 'journal/search', q: 'другої' })
    const later: SummaryOut = { ...SUMMARY, id: 's-9', title: 'Запис із другої сторінки' }
    const taken = run(early.model, { type: 'journal/list-ok', req: listFx(early.effects).req, diary: { items: [later], nextCursor: null } }, { type: 'journal/revisit', id: 's-9' })
    expect(names(taken.model)).toEqual(['s-9'])
    expect(names(run(taken.model, { type: 'diary/ok', diary: DIARY }).model)).toEqual(['s-9'])
  })

  test('a 401 over an unsaved edit of a record: the next screen says the changes did not reach the diary — session-expired under a conversation, the sign-in notice without one', () => {
    /** The diary opened from `from`, s-1 edited and «Зберегти» pressed: the PATCH on its way. */
    const saving = (from: Model) => {
      const edit = run(opened(from).model, { type: 'journal/edit', id: 's-1' })
      const form = journalOf(edit.model).edit!.form
      return run(edit.model, { type: 'journal/edit-update', form: { ...form, title: 'Набрана назва' } }, { type: 'journal/edit-save' })
    }
    const unauthorized = apiError(401, 'unauthenticated')
    const talk = answered(booted(), 'РОЗМОВА-ПІД-ЩОДЕННИКОМ')
    const underTalk = saving(talk)
    const expired = run(underTalk.model, { type: 'journal/patch-fail', req: patchFx(underTalk.effects).req, error: unauthorized }).model
    expect(expired.state).toMatchObject({ s: 'session-expired', editLost: true, draft: null, stale: { messages: chatOf(talk).session.messages } })
    // From «Розмову завершено» / «Збережено» there is no conversation to keep: the sign-in screen says it.
    for (const from of [{ s: 'ended' }, { s: 'saved', summary: SUMMARY }] as const) {
      const fromEnd = saving({ ...booted(), state: from })
      const out = run(fromEnd.model, { type: 'journal/patch-fail', req: patchFx(fromEnd.effects).req, error: unauthorized })
      expect(out.model.state).toEqual({ s: 'signed-out', variant: 'fresh', notice: { kind: 'edit-lost' } })
      expect(types(out.effects)).toEqual(['abort', 'announcer/clear'])
    }
    // Any 401 on the diary while the edit is typed and not saved says the same (a search's GET).
    const typed = run(opened({ ...booted(), state: { s: 'ended' } }).model, { type: 'journal/edit', id: 's-1' })
    const form = journalOf(typed.model).edit!.form
    const search = run(typed.model, { type: 'journal/edit-update', form: { ...form, title: 'Ще не збережено' } }, { type: 'journal/search', q: 'сон' })
    expect(run(search.model, { type: 'journal/list-fail', req: listFx(search.effects).req, error: unauthorized }).model.state).toMatchObject({ s: 'signed-out', notice: { kind: 'edit-lost' } })
    // Nothing typed (a form opened and unchanged, or none): nothing to say.
    const untouched = run(typed.model, { type: 'journal/search', q: 'сон' })
    expect(run(untouched.model, { type: 'journal/list-fail', req: listFx(untouched.effects).req, error: unauthorized }).model.state).toEqual({ s: 'signed-out', variant: 'fresh', notice: null })
    const open = run(talk, { type: 'journal/open', tz: TZ })
    expect(run(open.model, { type: 'journal/list-fail', req: listFx(open.effects).req, error: unauthorized }).model.state).toMatchObject({ s: 'session-expired', editLost: false })
    // The consent a PATCH asked for holds the edit: a 401 there (its GET or its POST) says the same.
    const consentFor = (from: Model) => {
      const pending = saving(from)
      return run(pending.model, { type: 'journal/patch-fail', req: patchFx(pending.effects).req, error: apiError(403, 'consent_required', { missing: ['data_processing'] }) }).model
    }
    const resumeEnded = consentFor({ ...booted(), state: { s: 'ended' } })
    expect(resumeEnded.state).toMatchObject({ s: 'consent', mode: 'resume', resume: { kind: 'patch' } })
    expect(run(resumeEnded, { type: 'consents/fail', purpose: 'fresh', error: unauthorized }).model.state).toEqual({ s: 'signed-out', variant: 'fresh', notice: { kind: 'edit-lost' } })
    const resumeTalk = run(consentFor(talk), { type: 'consents/ok', purpose: 'fresh', consents: { ...CONSENTS_OK, missing: ['data_processing'] } }, { type: 'consent/agree', checked: [...KINDS] }).model
    expect(run(resumeTalk, { type: 'grant/fail', error: unauthorized }).model.state).toMatchObject({ s: 'session-expired', editLost: true })
    // A consent for the conversation (a turn) has no edit to speak of.
    const turnConsent = run(talk, { type: 'chat/send', text: 'Ще.' })
    const asked = run(turnConsent.model, { type: 'turn/outcome', id: turnEffect(turnConsent.effects).id, now: NOW, outcome: { kind: 'http', error: apiError(403, 'consent_required', { missing: ['llm_transfer'] }) } }).model
    expect(run(asked, { type: 'consents/fail', purpose: 'fresh', error: unauthorized }).model.state).toMatchObject({ s: 'session-expired', editLost: false })
  })

  test('the record a revisit goes back to leaves the diary: under way, «До розмови» brings the block «Записів… уже немає»; not begun, the record is no longer chosen', () => {
    /** A revisit with s-1 chosen, from a page whose diary is `items`; the diary opened over it. */
    const revisitWith = (items: readonly SummaryOut[], begun: boolean) => {
      const base = booted()
      const page: Model = { ...base, ctx: { ...base.ctx, diary: { status: 'ok', value: { items, nextCursor: null } } } }
      const chosen = run(
        page,
        { type: 'chat/scenario', id: 'revisit' },
        { type: 'revisit/open' },
        { type: 'revisit/list-ok', purpose: 'pick', q: '', cursor: null, diary: { items, nextCursor: null } },
        { type: 'revisit/toggle', id: 's-1' },
        { type: 'revisit/confirm' },
      ).model
      const talk = begun ? answered(chosen, 'Повертаюся до теми.') : chosen
      const open = run(talk, { type: 'journal/open', tz: TZ })
      return run(open.model, { type: 'journal/list-ok', req: listFx(open.effects).req, diary: { items, nextCursor: null } }).model
    }
    const remove = (m: Model, id: string) => run(m, { type: 'confirm/open', kind: 'delete-summary', summary: id }, { type: 'confirm/accept' }, { type: 'journal/delete-ok', id }).model

    // Under way, the only record deleted: the block, not a page without a field.
    const emptied = run(remove(revisitWith([SUMMARY], true), 's-1'), { type: 'journal/back' }).model
    expect(emptied.ctx.diary).toEqual({ status: 'ok', value: { items: [], nextCursor: null } })
    expect(chatOf(emptied).notice).toEqual({ kind: 'revisit-gone' })
    expect(canSendNow(chatOf(emptied))).toBe(false)
    // The same when a PATCH finds it gone (404), and when its DELETE answers 404.
    const editing = run(revisitWith([SUMMARY], true), { type: 'journal/edit', id: 's-1' })
    const form = journalOf(editing.model).edit!.form
    const save = run(editing.model, { type: 'journal/edit-update', form: { ...form, title: 'Інша назва' } }, { type: 'journal/edit-save' })
    const patch404 = run(save.model, { type: 'journal/patch-fail', req: patchFx(save.effects).req, error: apiError(404, 'not_found') }, { type: 'journal/back' }).model
    expect(chatOf(patch404).notice).toEqual({ kind: 'revisit-gone' })
    const delete404 = run(
      revisitWith([SUMMARY], true),
      { type: 'confirm/open', kind: 'delete-summary', summary: 's-1' },
      { type: 'confirm/accept' },
      { type: 'journal/delete-fail', id: 's-1', error: apiError(404, 'not_found') },
      { type: 'journal/back' },
    ).model
    expect(chatOf(delete404).notice).toEqual({ kind: 'revisit-gone' })
    // Under way with records left: the conversation as it was (the next turn's 404 opens the picker).
    const left = run(remove(revisitWith(DIARY.items, true), 's-1'), { type: 'journal/back' }).model
    expect(chatOf(left)).toMatchObject({ notice: null, session: { revisitIds: ['s-1'] } })

    // Not begun: the deleted record is no longer chosen, and no block covers the head that explains.
    const notBegun = run(remove(revisitWith(DIARY.items, false), 's-1'), { type: 'journal/back' }).model
    expect(chatOf(notBegun)).toMatchObject({ notice: null, session: { scenario: 'revisit', revisitIds: [] } })
    const notBegunEmpty = run(remove(revisitWith([SUMMARY], false), 's-1'), { type: 'journal/back' }).model
    expect(chatOf(notBegunEmpty)).toMatchObject({ notice: null, session: { scenario: 'revisit', revisitIds: [] } })
    // Another record deleted: the chosen one stays chosen.
    const other = run(remove(revisitWith(DIARY.items, false), 's-2'), { type: 'journal/back' }).model
    expect(chatOf(other).session.revisitIds).toEqual(['s-1'])
  })

  test('a late first page of the record picker changes nothing once the picker is closed: a chosen name stays, a deleted record stays gone', () => {
    const names = (m: Model) => (m.ctx.diary.status === 'ok' ? m.ctx.diary.value.items.map((i) => i.id) : [])
    // s-12 chosen from a search (it is not on the first page), then «Змінити» and Esc before the
    // picker's first page came; the diary opens.
    const far: SummaryOut = { ...SUMMARY, id: 's-12', title: 'Далекий запис' }
    const picked = run(
      booted(),
      { type: 'chat/scenario', id: 'revisit' },
      { type: 'revisit/open' },
      { type: 'revisit/list-ok', purpose: 'pick', q: '', cursor: null, diary: DIARY },
      { type: 'revisit/search', q: 'далеко' },
      { type: 'revisit/list-ok', purpose: 'pick', q: 'далеко', cursor: null, diary: { items: [far], nextCursor: null } },
      { type: 'revisit/toggle', id: 's-12' },
      { type: 'revisit/confirm' },
    ).model
    expect(names(picked)).toEqual(['s-1', 's-2', 's-12'])
    const reopened = run(picked, { type: 'revisit/open' })
    expect(reopened.effects).toEqual([{ type: 'pick-list', purpose: 'pick', q: '', cursor: null }])
    const opening = run(reopened.model, { type: 'overlay/close' }, { type: 'journal/open', tz: TZ })
    const open = run(opening.model, { type: 'journal/list-ok', req: listFx(opening.effects).req, diary: DIARY })
    const late: Action = { type: 'revisit/list-ok', purpose: 'pick', q: '', cursor: null, diary: DIARY }
    const onDiary = run(open.model, late)
    expect(names(onDiary.model)).toEqual(['s-1', 's-2', 's-12'])
    const back = run(onDiary.model, { type: 'journal/back' }).model
    expect(chatOf(back).session.revisitIds).toEqual(['s-12'])
    expect(names(back)).toContain('s-12')
    // Back in the conversation with the picker closed, the same late page changes nothing either.
    expect(run(back, late).model).toBe(back)
    // A record deleted in the diary meanwhile does not come back with the late page.
    const deleted = run(open.model, { type: 'confirm/open', kind: 'delete-summary', summary: 's-2' }, { type: 'confirm/accept' }, { type: 'journal/delete-ok', id: 's-2' })
    expect(names(deleted.model)).toEqual(['s-1', 's-12'])
    expect(names(run(deleted.model, late).model)).toEqual(['s-1', 's-12'])
    // A 404's first page that lands on the diary does not replace it either.
    expect(run(open.model, { type: 'revisit/list-ok', purpose: 'pick-404', q: '', cursor: null, diary: { items: [], nextCursor: null } }).model.ctx).toBe(open.model.ctx)
  })

  test('a failed refresh of the themes keeps the pills (a filter can still be taken off); a delete that empties the page’s diary asks it again', () => {
    const { model } = opened()
    const filtered = run(model, { type: 'journal/tag', id: 'tg-1' })
    const page = run(filtered.model, { type: 'journal/list-ok', req: listFx(filtered.effects).req, diary: { items: [SUMMARY], nextCursor: null } })
    const removed = run(page.model, { type: 'confirm/open', kind: 'delete-summary', summary: 's-2' }, { type: 'confirm/accept' }, { type: 'journal/delete-ok', id: 's-2' })
    const failed = run(removed.model, { type: 'journal/tags-fail', req: journalOf(removed.model).tagsReq, error: apiError(0, 'network') })
    expect(journalOf(failed.model)).toMatchObject({ tag: 'tg-1', tags: { status: 'ok' } })
    // On the way in nothing was shown yet: a failure hides the group.
    const open = run(booted(), { type: 'journal/open', tz: TZ })
    expect(journalOf(run(open.model, { type: 'journal/tags-fail', req: journalOf(open.model).tagsReq, error: apiError(0, 'network') }).model).tags).toEqual({ status: 'failed' })

    // The page's diary had one record and more behind it: deleted, it is asked for again.
    const one: Model = { ...model, ctx: { ...model.ctx, diary: { status: 'ok', value: { items: [SUMMARY], nextCursor: 'c2' } } } }
    const emptied = run(one, { type: 'confirm/open', kind: 'delete-summary', summary: 's-1' }, { type: 'confirm/accept' }, { type: 'journal/delete-ok', id: 's-1' })
    expect(types(emptied.effects)).toEqual(['delete-summary', 'journal-week', 'journal-tags', 'diary'])
    expect(emptied.model.ctx.diary).toEqual({ status: 'loading' })
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
      { type: 'page/left' },
      { type: 'journal/open', tz: 'Europe/Kyiv' },
      { type: 'journal/back' },
      { type: 'journal/revisit', id: 's-1' },
      { type: 'confirm/open', kind: 'delete-summary', summary: 's-1' },
      { type: 'confirm/open', kind: 'revisit-restart', summary: 's-1' },
      // The self-help tools (§3.13): no dialog and no timer open beside the contacts.
      { type: 'overlay/open', overlay: 'breathe' },
      { type: 'overlay/open', overlay: 'ground' },
      { type: 'overlay/open', overlay: 'mood' },
      { type: 'overlay/open', overlay: 'mood', when: 'after' },
      { type: 'overlay/open', overlay: 'shelter' },
      { type: 'mood/pick', word: 'спокій' },
    ]
    for (const action of actions) {
      const [next] = reduce(crisis, action)
      expect(next.state.s, action.type).toBe('crisis')
      if (action.type === 'overlay/open' && action.overlay !== 'help' && action.overlay !== 'account') expect(next.overlay, action.overlay).toEqual([])
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

// ── The self-help tools (spec §3.13) ─────────────────────────────────────────────────────────

test.describe('state: the self-help tools', () => {
  const crisisOutcome = (id: number): Action => ({
    type: 'turn/outcome',
    id,
    now: NOW,
    outcome: { kind: 'crisis', source: 'keyword', helplines: sanitizeHelplines(RAW_HELPLINES) },
  })
  /** The conversation (answered) through «Підсумувати» to the theses. */
  function toReview(model: Model): Model {
    const s = run(answered(model), { type: 'chat/summarize' })
    const fx = s.effects.find((e): e is Extract<Effect, { type: 'summarize' }> => e.type === 'summarize')!
    return run(s.model, { type: 'summarize/ok', id: fx.id, draft: { title: 'Розмова про день', bullets: ['перша', 'друга'], tags: ['день'] } }).model
  }
  const checkedIn = (model: Model, word: string): Model => run(model, { type: 'overlay/open', overlay: 'mood' }, { type: 'mood/pick', word }).model

  test('a tool opens over nothing, stacks over «Якщо важко» and the shelter, asks the server nothing; never in the crisis or the boot', () => {
    const m = booted()
    for (const kind of TOOL_KINDS) {
      const open = run(m, { type: 'overlay/open', overlay: kind })
      expect(open.model.overlay, kind).toEqual([kind === 'mood' ? { o: 'mood', when: 'before' } : { o: kind }])
      expect(open.effects, kind).toEqual([])
      expect(topTool(open.model)?.o, kind).toBe(kind)
      // The same tool again changes nothing.
      expect(run(open.model, { type: 'overlay/open', overlay: kind }).model, kind).toBe(open.model)
    }
    // «Якщо важко» → «В укритті» → breathing: three deep, Esc gives back each one under it.
    const deep = run(m, { type: 'overlay/open', overlay: 'help' }, { type: 'overlay/open', overlay: 'shelter' }, { type: 'overlay/open', overlay: 'breathe' })
    expect(deep.model.overlay).toEqual([{ o: 'help' }, { o: 'shelter' }, { o: 'breathe' }])
    expect(types(deep.effects)).toEqual(['helplines'])
    expect(run(deep.model, { type: 'overlay/close' }).model.overlay).toEqual([{ o: 'help' }, { o: 'shelter' }])
    expect(run(deep.model, { type: 'overlay/close' }, { type: 'overlay/close' }).model.overlay).toEqual([{ o: 'help' }])
    // Over the shelter only breathing and grounding stack; anything over another tool replaces it.
    const shelter = run(m, { type: 'overlay/open', overlay: 'shelter' }).model
    expect(run(shelter, { type: 'overlay/open', overlay: 'ground' }).model.overlay).toEqual([{ o: 'shelter' }, { o: 'ground' }])
    expect(run(shelter, { type: 'overlay/open', overlay: 'mood' }).model.overlay).toEqual([{ o: 'mood', when: 'before' }])
    const breathing = run(m, { type: 'overlay/open', overlay: 'breathe' }).model
    expect(run(breathing, { type: 'overlay/open', overlay: 'ground' }).model.overlay).toEqual([{ o: 'ground' }])
    // Signed out: no session needed.
    const out = run(INITIAL_MODEL, { type: 'boot', search: '' }, { type: 'me/fail', purpose: 'boot', error: apiError(401, 'unauthenticated') }).model
    expect(out.state.s).toBe('signed-out')
    expect(run(out, { type: 'overlay/open', overlay: 'ground' }).model.overlay).toEqual([{ o: 'ground' }])
    // Booting: nothing yet.
    expect(run(INITIAL_MODEL, { type: 'overlay/open', overlay: 'breathe' }).model).toBe(INITIAL_MODEL)
    // The crisis: no dialog and no timer beside the contacts, not even from «Якщо важко» there.
    const sent = run(m, { type: 'chat/send', text: 'Синтетична кризова фраза' })
    const crisis = run(sent.model, crisisOutcome(turnEffect(sent.effects).id)).model
    for (const kind of TOOL_KINDS) expect(run(crisis, { type: 'overlay/open', overlay: kind }).model, kind).toBe(crisis)
    const help = run(crisis, { type: 'overlay/open', overlay: 'help' }).model
    expect(run(help, { type: 'overlay/open', overlay: 'breathe' }).model.overlay).toEqual([{ o: 'help' }])
  })

  test('the crisis closes every tool in the step it comes, the stack under it too, and forgets the check-in', () => {
    const before = checkedIn(booted(), 'напруга')
    const sent = run(before, { type: 'chat/send', text: 'Синтетична кризова фраза' })
    const { id } = turnEffect(sent.effects)
    for (const stack of [['breathe'], ['ground'], ['mood'], ['shelter'], ['help', 'shelter', 'breathe'], ['shelter', 'ground']] as const) {
      const open = run(sent.model, ...stack.map((overlay): Action => ({ type: 'overlay/open', overlay })))
      expect(open.model.overlay.map((o) => o.o), stack.join(' → ')).toEqual([...stack])
      const crisis = run(open.model, crisisOutcome(id)).model
      expect(crisis.state.s).toBe('crisis')
      expect(crisis.overlay, stack.join(' → ')).toEqual([])
      expect(crisis.ctx.mood).toEqual(NO_MOOD)
    }
    // A 401 under a tool: session-expired, the tool closed (I6).
    const tool = run(sent.model, { type: 'overlay/open', overlay: 'breathe' }).model
    const expired = run(tool, { type: 'turn/outcome', id, now: NOW, outcome: { kind: 'http', error: apiError(401, 'unauthenticated') } }).model
    expect(expired.state.s).toBe('session-expired')
    expect(expired.overlay).toEqual([])
  })

  test('the check-in takes a word of the dictionary; the first stays; «А зараз?» only at the end with a first word; nothing carries it out', () => {
    const m = booted()
    expect(run(m, { type: 'mood/pick', word: 'спокій' }).model).toBe(m)
    const open = run(m, { type: 'overlay/open', overlay: 'mood' }).model
    // A word the page does not offer is not taken (and the check-in stays open).
    expect(run(open, { type: 'mood/pick', word: 'синтетичне-слово' }).model).toBe(open)
    const first = run(open, { type: 'mood/pick', word: 'неспокій' })
    expect(first.model.ctx.mood).toEqual({ before: 'неспокій', after: null })
    expect(first.model.overlay).toEqual([])
    expect(first.effects).toEqual([])
    // A check-in in the middle names a feeling; «спершу» stays the first word.
    const again = checkedIn(answered(first.model), 'радість')
    expect(again.ctx.mood).toEqual({ before: 'неспокій', after: null })
    expect(again.overlay).toEqual([])
    // «А зараз?» is the end's question: not in the conversation, not without a first word.
    expect(run(again, { type: 'overlay/open', overlay: 'mood', when: 'after' }).model).toBe(again)
    const noFirst = toReview(m)
    expect(run(noFirst, { type: 'overlay/open', overlay: 'mood', when: 'after' }).model).toBe(noFirst)
    // On the theses, «Збережено» and «Розмову завершено».
    const review = toReview(first.model)
    const after = run(review, { type: 'overlay/open', overlay: 'mood', when: 'after' })
    expect(after.model.overlay).toEqual([{ o: 'mood', when: 'after' }])
    const picked = run(after.model, { type: 'mood/pick', word: 'спокій' })
    expect(picked.model.ctx.mood).toEqual({ before: 'неспокій', after: 'спокій' })
    const ended: Model = { ...picked.model, state: { s: 'ended' }, overlay: [] }
    expect(run(ended, { type: 'overlay/open', overlay: 'mood', when: 'after' }).model.overlay).toEqual([{ o: 'mood', when: 'after' }])
    // Not while the theses are being saved: «Збережено» would close it half chosen (I6).
    const saving = run(review, { type: 'review/save' }).model
    expect(saving.state.s === 'review' && saving.state.saving).toBe('saving')
    expect(run(saving, { type: 'overlay/open', overlay: 'mood', when: 'after' }).model).toBe(saving)
    // Never a tag, never in a body: the save and the theses send what they always sent (I1, I9).
    const save = run(picked.model, { type: 'review/save' })
    const all = [...first.effects, ...after.effects, ...picked.effects, ...save.effects]
    for (const word of ['неспокій', 'радість', 'спокій']) expect(JSON.stringify(all)).not.toContain(word)
    const body = (save.effects[0] as Extract<Effect, { type: 'save' }>).body
    expect(body.tags).toEqual([{ name: 'день', source: 'ai' }])
  })

  test('the check-in goes with its conversation: a new one, a revisit, a sign-out, a deleted account; the diary and back keep it', () => {
    const talk = answered(checkedIn(booted(), 'втома'))
    expect(talk.ctx.mood.before).toBe('втома')
    // The diary from the conversation and back: the same conversation, the same word.
    const diary = run(talk, { type: 'journal/open', tz: 'Europe/Kyiv' }).model
    expect(run(diary, { type: 'journal/back' }).model.ctx.mood.before).toBe('втома')
    // «Почати нову розмову» from «Збережено» / «Розмову завершено», and the diary opened there.
    const saved: Model = { ...talk, state: { s: 'saved', summary: SUMMARY } }
    expect(run(saved, { type: 'chat/new' }).model.ctx.mood).toEqual(NO_MOOD)
    expect(run(saved, { type: 'journal/open', tz: null }, { type: 'journal/back' }).model.ctx.mood).toEqual(NO_MOOD)
    // «Повернутися до цього» starts another conversation.
    const opened = run(talk, { type: 'journal/open', tz: 'Europe/Kyiv' })
    const list = opened.effects.find((e): e is Extract<Effect, { type: 'journal-list' }> => e.type === 'journal-list')!
    const listed = run(opened.model, { type: 'journal/list-ok', req: list.req, diary: DIARY }).model
    const revisit = run(listed, { type: 'journal/revisit', id: 's-1' }, { type: 'confirm/accept' }).model
    expect(chatOf(revisit).session.scenario).toBe('revisit')
    expect(revisit.ctx.mood).toEqual(NO_MOOD)
    // Signed out, the account deleted, a fresh boot.
    expect(run(talk, { type: 'account/logout' }, { type: 'confirm/accept' }, { type: 'logout/ok' }).model.ctx.mood).toEqual(NO_MOOD)
    expect(run(talk, { type: 'overlay/open', overlay: 'account' }, { type: 'confirm/open', kind: 'delete-account' }, { type: 'confirm/accept' }, { type: 'delete/ok' }).model.ctx.mood).toEqual(NO_MOOD)
    expect(INITIAL_MODEL.ctx.mood).toEqual(NO_MOOD)
  })

  test('the light breathes with the exercise and is quiet in the crisis', () => {
    const m = booted()
    expect(presenceOf(m)).toBe('idle')
    expect(presenceOf(run(m, { type: 'overlay/open', overlay: 'breathe' }).model)).toBe('breathing')
    expect(presenceOf(run(m, { type: 'overlay/open', overlay: 'shelter' }, { type: 'overlay/open', overlay: 'breathe' }).model)).toBe('breathing')
    expect(presenceOf(run(m, { type: 'overlay/open', overlay: 'ground' }).model)).toBe('idle')
    const sent = run(m, { type: 'chat/send', text: 'Синтетична кризова фраза' }, { type: 'overlay/open', overlay: 'breathe' })
    expect(presenceOf(sent.model)).toBe('breathing')
    expect(presenceOf(run(sent.model, crisisOutcome(turnEffect(sent.effects).id)).model)).toBe('quiet')
  })
})

test.describe('self-help: the minute, the words', () => {
  test('slow breathing is in 4 s, out 6 s, six times; the cyclic sigh 2 + 1 + 6 s, seven times; the count runs 4 3 2 1', () => {
    expect(breathCycleMs('slow')).toBe(10_000)
    expect(breathTotalMs('slow')).toBe(60_000)
    expect(breathCycleMs('sigh')).toBe(9_000)
    expect(breathTotalMs('sigh')).toBe(63_000)
    const at = (pattern: BreathPattern, ms: number) => {
      const x = breathAt(pattern, ms)
      return [x.phase, x.left, x.round, x.done]
    }
    expect(at('slow', 0)).toEqual(['in', 4, 0, false])
    expect(at('slow', 999)).toEqual(['in', 4, 0, false])
    expect(at('slow', 1000)).toEqual(['in', 3, 0, false])
    expect(at('slow', 3999)).toEqual(['in', 1, 0, false])
    expect(at('slow', 4000)).toEqual(['out', 6, 0, false])
    expect(at('slow', 9999)).toEqual(['out', 1, 0, false])
    expect(at('slow', 10_000)).toEqual(['in', 4, 1, false])
    expect(at('slow', 59_999)).toEqual(['out', 1, 5, false])
    expect(breathAt('slow', 60_000).done).toBe(true)
    expect(at('sigh', 0)).toEqual(['in', 2, 0, false])
    expect(at('sigh', 2000)).toEqual(['top', 1, 0, false])
    expect(at('sigh', 3000)).toEqual(['out', 6, 0, false])
    expect(at('sigh', 62_999)).toEqual(['out', 1, 6, false])
    expect(breathAt('sigh', 63_000).done).toBe(true)
    // Garbage time is the start, not a crash.
    expect(at('slow', Number.NaN)).toEqual(['in', 4, 0, false])
    expect(at('slow', -5)).toEqual(['in', 4, 0, false])
    // The next tick lands where the count changes.
    expect(breathNextChangeMs(breathAt('slow', 250))).toBe(750)
    expect(breathNextChangeMs(breathAt('slow', 3000))).toBe(1000)
    expect(breathNextChangeMs(breathAt('sigh', 2500))).toBe(500)
  })

  test('the check-in dictionary: four cells of six words, each once, none on the stop-list; the sentences say words, not scores', () => {
    const all = MOOD_QUADRANTS.flatMap((q) => [...MOOD_WORDS[q]])
    for (const q of MOOD_QUADRANTS) expect(MOOD_WORDS[q], q).toHaveLength(6)
    expect(new Set(all).size).toBe(24)
    const clinical = /терапі|терапевт|психолог|психіатр|лікув|лікує|діагно[зс]|депрес|тривог|тривожн/
    for (const word of all) {
      expect(word, word).not.toMatch(clinical)
      expect(isMoodWord(word)).toBe(true)
    }
    expect(isMoodWord('Спокій')).toBe(false)
    expect(isToolKind('shelter') && isToolKind('breathe') && !isToolKind('account')).toBe(true)
    expect(moodSentence('втома')).toBe('Зараз у мене — втома.')
    expect(moodLine('втома', null)).toBe('Спершу — втома.')
    expect(moodLine('втома', 'спокій')).toBe('Спершу — втома, зараз — спокій.')
    expect(moodLine('втома', 'спокій')).not.toMatch(/\d|краще|гірше|%/)
  })

  test('the shelter is the dark theme whatever the page: its tokens are the dark side of each light-dark()', () => {
    const tokens = readFileSync(resolve(test.info().project.testDir, '..', '..', 'src', 'styles', 'tokens.css'), 'utf8')
    const block = (selector: string): string => {
      const start = tokens.indexOf(`${selector} {`)
      expect(start, selector).toBeGreaterThanOrEqual(0)
      return tokens.slice(start, tokens.indexOf('}', start))
    }
    const theme = block(':root:not([data-theme-lock])')
    const shelter = block(':root:not([data-theme-lock]) :is(.sheet--shelter, .sheet--tool[data-shelter])')
    expect(shelter).toContain('color-scheme: dark;')
    const pairs = [...shelter.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()] as const)
    expect(pairs.length).toBeGreaterThan(20)
    for (const [name, value] of pairs) {
      const source = theme.match(new RegExp(`--${name}:\\s*light-dark\\((#[0-9a-f]{6}|rgb\\([^)]*\\)),\\s*(#[0-9a-f]{6}|rgb\\([^)]*\\))\\)`, 'i'))
      expect(source, name).not.toBeNull()
      expect(value, name).toBe(source![2])
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
    const down = run(m, { type: 'diary/retry' }, { type: 'diary/fail', error: apiError(502, 'upstream_unavailable') }).model
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

test.describe('state: leaving the page, the account after a 401, countdowns, unconfirmed saves', () => {
  const OTHER = { ...ME, id: 'u-2', email: 'other@example.com' }
  const TEXT = 'Синтетичне перше повідомлення.'

  /** review with a draft of the answered conversation. */
  function review(): Model {
    const s = run(answered(booted()), { type: 'chat/summarize' })
    const fx = s.effects.find((e): e is Extract<Effect, { type: 'summarize' }> => e.type === 'summarize')!
    return run(s.model, { type: 'summarize/ok', id: fx.id, draft: { title: 'Розмова про день', bullets: ['перша'], tags: [] } }).model
  }

  /** review whose POST /summaries ended without an answer (§7.3). */
  function unconfirmed(): Model {
    const save = run(review(), { type: 'review/save' })
    const fx = save.effects[0] as Extract<Effect, { type: 'save' }>
    return run(save.model, { type: 'save/fail', id: fx.id, error: apiError(0, 'network') }).model
  }

  test('«Піти» and «Увійти знову» wipe the conversation at pagehide; a restored page boots again', () => {
    const m = answered(booted())
    // Nothing was promised: a plain pagehide keeps the page as it is.
    expect(run(m, { type: 'page/left' }).model).toEqual(m)
    const left = run(m, { type: 'confirm/open', kind: 'leave', leaveTo: 'home' }, { type: 'confirm/accept' })
    expect(left.effects).toEqual([{ type: 'navigate', href: '/' }])
    const hidden = run(left.model, { type: 'page/left' })
    expect(hidden.model.state).toEqual({ s: 'booting' })
    expect(hidden.model.ctx.me).toBeNull()
    expect(hidden.model.overlay).toEqual([])
    expect(types(hidden.effects)).toEqual(['abort', 'announcer/clear'])
    expect(JSON.stringify(hidden.model)).not.toContain(TEXT)
    const shown = run(hidden.model, { type: 'page/show', persisted: true })
    expect(shown.effects).toEqual([{ type: 'url/clean' }, { type: 'me', purpose: 'boot', timeoutMs: BOOT_TIMEOUT }])

    const expired = run(m, { type: 'chat/send', text: 'Друге' })
    const ended = run(expired.model, { type: 'turn/outcome', id: turnEffect(expired.effects).id, now: NOW, outcome: { kind: 'http', error: apiError(401, 'unauthenticated') } }).model
    const relogin = run(ended, { type: 'confirm/open', kind: 'relogin' }, { type: 'confirm/accept' }, { type: 'page/left' })
    expect(relogin.model.state).toEqual({ s: 'booting' })
    expect(JSON.stringify(relogin.model)).not.toContain('Друге')
  })

  test('pagehide in the crisis empties the conversation under <details> and keeps the contacts', () => {
    const sent = run(booted(), { type: 'chat/send', text: 'Синтетична кризова фраза' })
    const crisis = run(sent.model, { type: 'turn/outcome', id: turnEffect(sent.effects).id, now: NOW, outcome: { kind: 'crisis', source: 'keyword', helplines: FALLBACK } }).model
    const hidden = run(crisis, { type: 'page/left' }).model
    expect(hidden.state).toMatchObject({ s: 'crisis', helplines: FALLBACK, stale: [] })
    expect(JSON.stringify(hidden)).not.toContain('Синтетична кризова фраза')
  })

  test('pageshow: GET /me answers for another account → wiped and booted again as that account', () => {
    const m = answered(booted())
    const same = run(m, { type: 'me/ok', purpose: 'pageshow', me: { ...ME, consents_ok: true } })
    expect(chatOf(same.model).session.messages).toHaveLength(3)
    const other = run(m, { type: 'me/ok', purpose: 'pageshow', me: OTHER })
    expect(other.model.state).toEqual({ s: 'booting' })
    expect(other.model.ctx.me).toBeNull()
    expect(JSON.stringify(other.model)).not.toContain(TEXT)
    expect(types(other.effects)).toEqual(['abort', 'announcer/clear', 'url/clean', 'me'])
  })

  test('session-expired: no account menu; a 401 on a revoke leaves no busy operation behind', () => {
    const m = answered(booted())
    const revoking = run(m, { type: 'overlay/open', overlay: 'account' }, { type: 'confirm/open', kind: 'revoke', revoke: 'llm_transfer' }, { type: 'confirm/accept' }).model
    expect(revoking.ctx.op).toMatchObject({ name: 'revoke', busy: true })
    const expired = run(revoking, { type: 'revoke/fail', kind: 'llm_transfer', error: apiError(401, 'unauthenticated') }).model
    expect(expired.state.s).toBe('session-expired')
    expect(expired.ctx.op).toBeNull()
    // The same 401 while already on session-expired (the screen does not change): still no op.
    const stuck: Model = { ...expired, ctx: { ...expired.ctx, op: { name: 'revoke', busy: true, error: null } } }
    expect(run(stuck, { type: 'revoke/fail', kind: 'llm_transfer', error: apiError(401, 'unauthenticated') }).model.ctx.op).toBeNull()
    // The menu and its operations need a live session.
    expect(run(expired, { type: 'overlay/open', overlay: 'account' }).model.overlay).toEqual([])
    for (const kind of ['logout', 'delete-account'] as const) expect(run(expired, { type: 'confirm/open', kind }).model.overlay).toEqual([])
    expect(run(expired, { type: 'account/logout' }).effects).toEqual([])
    // «Увійти знову» still goes.
    expect(run(expired, { type: 'confirm/open', kind: 'relogin' }, { type: 'confirm/accept' }).effects).toEqual([{ type: 'navigate', href: GOOGLE_START }])
  })

  test('a late GET /summaries never brings back an erased diary', () => {
    const save = run(review(), { type: 'review/save' })
    const fx = save.effects[0] as Extract<Effect, { type: 'save' }>
    const savedModel = run(save.model, { type: 'save/ok', id: fx.id, summary: SUMMARY }).model
    expect(savedModel.ctx.diary).toEqual({ status: 'loading' })
    const revoked = run(
      savedModel,
      { type: 'overlay/open', overlay: 'account' },
      { type: 'confirm/open', kind: 'revoke', revoke: 'data_processing' },
      { type: 'confirm/accept' },
      { type: 'revoke/ok', kind: 'data_processing', consents: { ...CONSENTS_OK, missing: ['data_processing'] } },
    ).model
    const late = run(revoked, { type: 'diary/ok', diary: DIARY }).model
    expect(late.ctx.diary).toEqual({ status: 'ok', value: { items: [], nextCursor: null } })
    expect(run(revoked, { type: 'diary/fail', error: apiError(401, 'unauthenticated') }).model).toEqual(revoked)
    const out = run(savedModel, { type: 'account/logout' }, { type: 'logout/ok' }).model
    expect(run(out, { type: 'diary/ok', diary: DIARY }).model.ctx.diary).toEqual({ status: 'idle' })
    // A load that failed may still be answered by a second one.
    const failed = run(savedModel, { type: 'diary/fail', error: apiError(0, 'aborted') }).model
    expect(run(failed, { type: 'diary/ok', diary: DIARY }).model.ctx.diary).toEqual({ status: 'ok', value: DIARY })
  })

  test('a 429 countdown survives the theses and back; a new conversation does not inherit it', () => {
    const sent = run(answered(booted()), { type: 'chat/send', text: 'Ліміт' })
    const limited = run(sent.model, {
      type: 'turn/outcome',
      id: turnEffect(sent.effects).id,
      now: NOW,
      outcome: { kind: 'http', error: apiError(429, 'rate_limited', { retryAfterMs: 12_000 }) },
    }).model
    expect(limited.ctx.cooldown).toBe(NOW + 12_000)
    const back = run(limited, { type: 'chat/summarize' }, { type: 'summarize/cancel' }).model
    expect(chatOf(back).turn).toEqual({ p: 'cooldown', until: NOW + 12_000 })
    expect(run(back, { type: 'chat/resend' }).effects).toEqual([])
    // Over while on the theses: back in the conversation it is not restored.
    const away = run(limited, { type: 'chat/summarize' }, { type: 'cooldown/end', until: NOW + 12_000 }, { type: 'summarize/cancel' }).model
    expect(chatOf(away).turn).toEqual({ p: 'idle' })
    expect(types(run(away, { type: 'chat/resend' }).effects)).toEqual(['turn'])
    // Ended without theses, then a new conversation: idle, and the old timer changes nothing.
    const fresh = run(limited, { type: 'confirm/open', kind: 'end-no-theses' }, { type: 'confirm/accept' }, { type: 'chat/new' }).model
    expect(fresh.ctx.cooldown).toBeNull()
    expect(chatOf(fresh).turn).toEqual({ p: 'idle' })
    expect(run(fresh, { type: 'cooldown/end', until: NOW + 12_000 }).model).toEqual(fresh)
  })

  test('an unconfirmed save is remembered until it is confirmed or the conversation is over', () => {
    const unknown = unconfirmed()
    expect(unknown.ctx.maybeSaved).toBe(true)
    // «Видалити тези», back to the conversation, «Скласти заново»: none of them forgets it.
    const discarded = run(unknown, { type: 'confirm/open', kind: 'discard' }, { type: 'confirm/accept' }).model
    expect(discarded.state).toEqual({ s: 'ended' })
    expect(discarded.ctx.maybeSaved).toBe(true)
    const back = run(unknown, { type: 'review/back' }).model
    expect(back.ctx.maybeSaved).toBe(true)
    expect(run(back, { type: 'confirm/open', kind: 'end' }, { type: 'confirm/switch', kind: 'end-no-theses' }, { type: 'confirm/accept' }).model.ctx.maybeSaved).toBe(true)
    // A new conversation starts clean.
    expect(run(discarded, { type: 'chat/new' }).model.ctx.maybeSaved).toBe(false)
    // The check finds the record: saved, confirmed.
    const retry = run(unknown, { type: 'review/save' })
    const checkId = (retry.effects[0] as Extract<Effect, { type: 'save-check' }>).id
    const sent = (retry.model.state as Extract<State, { s: 'review' }>).sent!.body
    const mine: SummaryOut = { ...SUMMARY, scenario: sent.scenario, title: sent.title, bullets: [...sent.bullets], tags: [] }
    expect(run(retry.model, { type: 'save/check', id: checkId, list: { items: [mine], next_cursor: null }, date: null }).model.ctx.maybeSaved).toBe(false)
    // The newest record is not ours: the first POST did not land.
    expect(run(retry.model, { type: 'save/check', id: checkId, list: { items: [], next_cursor: null }, date: null }).model.ctx.maybeSaved).toBe(false)
    // The check itself fails: still unknown.
    expect(run(retry.model, { type: 'save/check-fail', id: checkId, error: apiError(0, 'network') }).model.ctx.maybeSaved).toBe(true)
  })
})

test.describe('state: one account operation at a time, late answers, a boot cut by pagehide', () => {
  function revoking(): Model {
    return run(answered(booted()), { type: 'overlay/open', overlay: 'account' }, { type: 'confirm/open', kind: 'revoke', revoke: 'data_processing' }, { type: 'confirm/accept' })
      .model
  }

  test('a revoke on its way, its confirm closed with Esc: no DELETE /me, logout or second revoke beside it', () => {
    const busy = revoking()
    expect(busy.ctx.op).toMatchObject({ name: 'revoke', busy: true })
    const closed = run(busy, { type: 'overlay/close' }).model
    expect(closed.overlay.map((o) => o.o)).toEqual(['account'])
    expect(closed.ctx.op).toEqual(busy.ctx.op)
    for (const kind of ['delete-account', 'logout'] as const) {
      const pressed = run(closed, { type: 'confirm/open', kind }, { type: 'confirm/accept' })
      expect(pressed.effects, kind).toEqual([])
      expect(pressed.model.ctx.op, kind).toEqual(busy.ctx.op)
    }
    expect(run(closed, { type: 'confirm/open', kind: 'revoke', revoke: 'age_18' }, { type: 'confirm/accept' }).effects).toEqual([])
    expect(run(closed, { type: 'account/logout' }).effects).toEqual([])
    // Not an account operation: «Завершити» still goes.
    const end = run(closed, { type: 'overlay/close' }, { type: 'confirm/open', kind: 'end' }, { type: 'confirm/accept' })
    expect(end.model.state.s).toBe('summarizing')
    // Once the revoke failed (not a 401), the next operation may start.
    const failed = run(closed, { type: 'revoke/fail', kind: 'data_processing', error: apiError(0, 'network') }).model
    expect(failed.ctx.op).toMatchObject({ name: 'revoke', busy: false })
    expect(run(failed, { type: 'confirm/open', kind: 'delete-account' }, { type: 'confirm/accept' }).effects).toEqual([
      { type: 'abort', target: 'all' },
      { type: 'delete-me' },
    ])
  })

  test('a revoke on its way outlives a screen change: no DELETE /me from the theses, and its answer ends only itself', () => {
    const deleteFrom = (m: Model) =>
      run(m, { type: 'overlay/open', overlay: 'account' }, { type: 'confirm/open', kind: 'delete-account' }, { type: 'confirm/accept' })
    // Revoke in flight, its confirm closed → «Завершити» → summarizing: the lock is still there.
    const closed = run(revoking(), { type: 'overlay/close' }, { type: 'overlay/close' }).model
    const summarizing = run(closed, { type: 'confirm/open', kind: 'end' }, { type: 'confirm/accept' })
    expect(summarizing.model.state.s).toBe('summarizing')
    expect(summarizing.model.ctx.op).toMatchObject({ name: 'revoke', busy: true })
    const pressed = deleteFrom(summarizing.model)
    expect(pressed.effects).toEqual([])
    expect(pressed.model.ctx.op).toMatchObject({ name: 'revoke', busy: true })
    expect(run(summarizing.model, { type: 'account/logout' }).effects).toEqual([])

    // A revoke started on summarizing, then the theses come: review keeps the lock.
    const fromSummarizing = run(summarizing.model, { type: 'revoke/fail', kind: 'data_processing', error: apiError(0, 'network') }).model
    expect(fromSummarizing.ctx.op).toMatchObject({ name: 'revoke', busy: false })
    const again = run(fromSummarizing, { type: 'overlay/open', overlay: 'account' }, { type: 'confirm/open', kind: 'revoke', revoke: 'age_18' }, { type: 'confirm/accept' })
    expect(again.effects).toEqual([{ type: 'revoke', kind: 'age_18' }])
    const id = (summarizing.effects.find((e) => e.type === 'summarize') as Extract<Effect, { type: 'summarize' }>).id
    const review = run(again.model, { type: 'summarize/ok', id, draft: { title: 'Розмова про день', bullets: ['a'], tags: [] } }).model
    expect(review.state.s).toBe('review')
    expect(review.overlay).toEqual([])
    expect(review.ctx.op).toMatchObject({ name: 'revoke', busy: true })
    expect(deleteFrom(review).effects).toEqual([])
    // Its answer ends the revoke, on whatever screen it comes.
    const consents: ConsentState = { ...CONSENTS_OK, missing: ['age_18'] }
    const answered = run(review, { type: 'revoke/ok', kind: 'age_18', consents }).model
    expect(answered.state).toMatchObject({ s: 'consent', mode: 'first' })
    expect(answered.ctx.op).toBeNull()

    // A revoke answer never ends another operation: a DELETE /me under way stays busy.
    const deleting: Model = { ...review, ctx: { ...review.ctx, op: { name: 'delete-account', busy: true, error: null } } }
    expect(run(deleting, { type: 'revoke/fail', kind: 'age_18', error: apiError(0, 'network') }).model.ctx.op).toEqual(deleting.ctx.op)
    expect(run(deleting, { type: 'revoke/ok', kind: 'age_18', consents }).model.ctx.op).toEqual(deleting.ctx.op)
    // An operation that is over (failed, not busy) is still forgotten on a new screen.
    const failed: Model = { ...review, ctx: { ...review.ctx, op: { name: 'logout', busy: false, error: toUiError(apiError(0, 'network')) } } }
    const back = run(failed, { type: 'review/back' }).model
    expect(back.state.s).toBe('chat')
    expect(back.ctx.op).toBeNull()
  })

  test('I5: a late revoke answer on the crisis screen keeps the contacts; the withdrawn consent comes with the new conversation', () => {
    const toCrisis = (m: Model): Model => {
      const sent = run(m, { type: 'chat/send', text: 'Синтетична кризова фраза' })
      return run(sent.model, { type: 'turn/outcome', id: turnEffect(sent.effects).id, now: NOW, outcome: { kind: 'crisis', source: 'keyword', helplines: FALLBACK } }).model
    }
    const consents: ConsentState = { ...CONSENTS_OK, missing: ['data_processing'] }
    // Revoke confirmed, its confirm and the sheet closed with Esc, then the crisis.
    const crisis = toCrisis(run(revoking(), { type: 'overlay/close' }, { type: 'overlay/close' }).model)
    expect(crisis.state.s).toBe('crisis')
    expect(crisis.ctx.op).toMatchObject({ name: 'revoke', busy: true })
    const late = run(crisis, { type: 'revoke/ok', kind: 'data_processing', consents })
    expect(late.model.state).toEqual(crisis.state)
    expect(late.effects).toEqual([])
    expect(late.model.ctx.op).toBeNull()
    expect(late.model.ctx.consents).toEqual(consents)
    expect(late.model.ctx.me?.consents_ok).toBe(false)
    expect(late.model.ctx.diary).toEqual({ status: 'ok', value: { items: [], nextCursor: null } })
    // «Почати нову розмову»: the consent withdrawn meanwhile comes first, the crisis line after it.
    const next = run(late.model, { type: 'confirm/open', kind: 'new-after-crisis' }, { type: 'confirm/accept' })
    expect(next.model.state).toMatchObject({ s: 'consent', mode: 'first', fresh: true })
    expect(next.model.ctx.afterCrisis).toBe(true)
    expect(types(next.effects)).toEqual(['announcer/clear'])

    // A revoke started on the crisis screen itself: its answer closes its own confirm, the sheet
    // stays open over the contacts.
    const onCrisis = run(
      toCrisis(answered(booted())),
      { type: 'overlay/open', overlay: 'account' },
      { type: 'confirm/open', kind: 'revoke', revoke: 'age_18' },
      { type: 'confirm/accept' },
    ).model
    expect(onCrisis.overlay.map((o) => o.o)).toEqual(['account', 'confirm'])
    const answer = run(onCrisis, { type: 'revoke/ok', kind: 'age_18', consents: { ...CONSENTS_OK, missing: ['age_18'] } }).model
    expect(answer.state).toEqual(onCrisis.state)
    expect(answer.overlay.map((o) => o.o)).toEqual(['account'])
    expect(answer.ctx.op).toBeNull()
    // With every consent in place, «Почати нову розмову» opens the conversation as before.
    const restart = run(toCrisis(answered(booted())), { type: 'confirm/open', kind: 'new-after-crisis' }, { type: 'confirm/accept' }).model
    expect(restart.state.s).toBe('chat')
  })

  test('signing out and a deleted account let go of a busy operation themselves', () => {
    for (const end of [{ type: 'logout/ok' }, { type: 'delete/ok' }] as const) {
      const after = run(revoking(), end).model
      expect(after.state.s, end.type).toBe(end.type === 'logout/ok' ? 'signed-out' : 'account-deleted')
      expect(after.ctx.op, end.type).toBeNull()
    }
  })

  test('a late revoke answer changes no screen once the session is gone: account-deleted and signed-out stay', () => {
    const busy = revoking()
    const consents: ConsentState = { ...CONSENTS_OK, missing: ['data_processing'] }
    const deleted = run(busy, { type: 'delete/ok' }).model
    expect(deleted.state).toEqual({ s: 'account-deleted', variant: 'confirmed' })
    for (const late of [
      { type: 'revoke/ok', kind: 'data_processing', consents },
      { type: 'revoke/fail', kind: 'data_processing', error: apiError(401, 'unauthenticated') },
    ] as const) {
      const after = run(deleted, late).model
      expect(after.state, late.type).toEqual(deleted.state)
      expect(after.ctx.me, late.type).toBeNull()
      expect(after.ctx.consents, late.type).toBeNull()
      expect(after.ctx.op, late.type).toBeNull()
    }
    const out = run(busy, { type: 'logout/ok' }).model
    expect(run(out, { type: 'revoke/ok', kind: 'data_processing', consents }).model.state).toEqual(out.state)
    // session-expired with an operation still marked busy: let go of it, stay on the screen.
    const sent = run(answered(booted()), { type: 'chat/send', text: 'Друге' })
    const expired = run(sent.model, { type: 'turn/outcome', id: turnEffect(sent.effects).id, now: NOW, outcome: { kind: 'http', error: apiError(401, 'unauthenticated') } }).model
    const stuck: Model = { ...expired, ctx: { ...expired.ctx, op: { name: 'revoke', busy: true, error: null } } }
    const released = run(stuck, { type: 'revoke/ok', kind: 'data_processing', consents }).model
    expect(released.state.s).toBe('session-expired')
    expect(released.ctx.op).toBeNull()
  })

  test('pagehide during the boot keeps it booting, and the page restored from the bfcache boots again', () => {
    const start = run(INITIAL_MODEL, { type: 'boot', search: '' }).model
    const cut = run(start, { type: 'me/fail', purpose: 'boot', error: apiError(0, 'aborted') })
    expect(cut.model.state).toEqual({ s: 'booting' })
    expect(cut.effects).toEqual([])
    expect(run(cut.model, { type: 'page/show', persisted: true }).effects).toEqual([{ type: 'url/clean' }, { type: 'me', purpose: 'boot', timeoutMs: BOOT_TIMEOUT }])
    const half = run(start, { type: 'me/ok', purpose: 'boot', me: ME }).model
    const consentsCut = run(half, { type: 'consents/fail', purpose: 'boot', error: apiError(0, 'aborted') })
    expect(consentsCut.model.state).toEqual({ s: 'booting' })
    expect(consentsCut.effects).toEqual([])
    expect(types(run(consentsCut.model, { type: 'page/show', persisted: true }).effects)).toEqual(['url/clean', 'me'])
    // The boot's own deadline is still «немає зʼєднання».
    expect(run(start, { type: 'me/fail', purpose: 'boot', error: apiError(0, 'timeout') }).model.state.s).toBe('fatal')
    expect(run(half, { type: 'consents/fail', purpose: 'boot', error: apiError(0, 'timeout') }).model.state.s).toBe('fatal')
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

test('copy: «Пробуємо ще раз через {n} …» agrees with the number', () => {
  expect([1, 2, 3, 4, 5, 11, 21, 22, 25, 30].map(sayRetry)).toEqual([
    'Пробуємо ще раз через 1 секунду',
    'Пробуємо ще раз через 2 секунди',
    'Пробуємо ще раз через 3 секунди',
    'Пробуємо ще раз через 4 секунди',
    'Пробуємо ще раз через 5 секунд',
    'Пробуємо ще раз через 11 секунд',
    'Пробуємо ще раз через 21 секунду',
    'Пробуємо ще раз через 22 секунди',
    'Пробуємо ще раз через 25 секунд',
    'Пробуємо ще раз через 30 секунд',
  ])
})

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
  test('only dusk and dawn are presets; anything else is the plain sky, and the crisis takes the preset off', () => {
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

  // ADR-013: «Персонаж» is on unless the person hid it; only the stored 'off' hides it, so an old,
  // odd or hand-edited value never takes the character away.
  test('the character: only "off" hides it; anything else, a missing key included, is on', () => {
    expect(CHARACTER_KEY).toBe('liora:character')
    expect(parseCharacter('off')).toBe('off')
    for (const other of [null, undefined, '', 'on', 'OFF', 'Off', ' off', 'false', '0', '{"character":"off"}', 1, 0, false]) {
      expect(parseCharacter(other), String(other)).toBe('on')
    }
  })

  // ADR-013 («Аврора»): the threshold of luminance (ADR-012: dark ≤ L 0.023, light ≥ L 0.76) became a
  // list of pairs. Every text token keeps 4.5:1, and every sole boundary of a control (its stroke, a
  // field's border, the focus ring, the edge of the primary fill) keeps 3:1, on every ground of every
  // theme × preset: each stop, each field at its full alpha, the ribbon over each field, by day each
  // pair of fields, the exact composite of the layers over three windows (tests/e2e/sky-contrast.ts),
  // and the glass over the worst of them, its opaque fallback included. Values come from the CSS.
  // The chat's dark fields meet (teal or peach with the low rose one, stage.css) — unlike the landing's
  // section skies, whose dark fields never do (fieldsMeet below): their overlaps are counted by the
  // composite at the alphas they really have there. Both at full alpha is no place on the screen (and
  // would fail: dusk and dawn, field 2 over field 4, 4.18:1 for the dim ink).
  test('each theme × preset keeps text ≥ 4.5:1 and sole boundaries ≥ 3:1 on its sky, its fields, their overlaps and its glass', () => {
    const styles = resolve(test.info().project.testDir, '..', '..', 'src', 'styles')
    const stage = readFileSync(join(styles, 'stage.css'), 'utf8')
    const tokens = readFileSync(join(styles, 'tokens.css'), 'utf8')
    const T = themes(tokens)
    const stopsImage = props(block(stage, ':root')).get('sky-stops') ?? ''
    expect(stopsImage).toMatch(/^linear-gradient\(180deg,/)
    const SKIES = {
      dark: { night: ':root', dusk: "html[data-sky='dusk']", dawn: "html[data-sky='dawn']" },
      light: {
        night: ":root[data-theme='light']:not([data-theme-lock])",
        dusk: ":root[data-theme='light'][data-sky='dusk']:not([data-theme-lock])",
        dawn: ":root[data-theme='light'][data-sky='dawn']:not([data-theme-lock])",
      },
    } as const
    const TEXT = ['color-text', 'color-text-soft', 'color-text-muted', 'color-text-dim', 'color-ai', 'color-teal', 'color-light', 'color-light-strong']
    // --color-stroke-warm: the mark's edge (the breathing circle, the marked reply's rule, a marked dot).
    const BOUNDS = ['color-stroke', 'color-stroke-warm', 'color-field-border', 'color-focus', 'color-accent']
    const TRIPLE = /^sky-(?:\d|field-\d|ribbon)$/
    const checks: Check[] = []
    const all: Record<'light' | 'dark', Ground[]> = { light: [], dark: [] }

    for (const theme of ['dark', 'light'] as const) {
      const day = theme === 'light'
      const own = props(block(stage, SKIES[theme].night))
      const text = Object.fromEntries(TEXT.map((n) => [n, T[theme](n).rgb]))
      const bounds = Object.fromEntries(BOUNDS.map((n) => [n, T[theme](n).rgb]))
      for (const preset of ['night', 'dusk', 'dawn'] as const) {
        const label = `${theme} ${preset}`
        const block_ = preset === 'night' ? own : props(block(stage, SKIES[theme][preset]))
        // A preset changes colours only: the theme's triples, no alphas, no geometry (stage.css).
        expect([...block_.keys()].filter((k) => TRIPLE.test(k)).sort(), label).toEqual([...own.keys()].filter((k) => TRIPLE.test(k)).sort())
        if (preset !== 'night') expect([...block_.keys()].filter((k) => !TRIPLE.test(k)), `${label}: colours only`).toEqual([])
        const s = sky(label, own, block_, stopsImage)
        expect(s.stops, label).toHaveLength(7)
        expect(s.fields.map((f) => f.slot), label).toEqual(['1', '2', '3', '4'])
        const list = [...grounds(s, day), ...sampled(s)]
        all[theme].push(...list)
        checks.push(...checkAll(text, list, 4.5), ...checkAll(bounds, list, 3))
      }
      // The glass over the worst ground of the theme, and its opaque fallback.
      const w = worst(all[theme], day)
      const capsule = T[theme]('color-capsule')
      const panel = T[theme]('color-panel')
      const solid = T[theme]('color-sheet-solid')
      expect(solid.a, '--color-sheet-solid is opaque: the fallback of all glass').toBe(1)
      const glass: Ground[] = [
        { label: `${theme} capsule over the worst sky`, rgb: over(capsule.rgb, capsule.a, w.rgb) },
        { label: `${theme} painted sheet over the worst sky`, rgb: over(panel.rgb, panel.a, w.rgb) },
        { label: `${theme} fallback --color-sheet-solid`, rgb: solid.rgb },
        { label: `${theme} --color-surface`, rgb: T[theme]('color-surface').rgb },
      ]
      for (const tint of ['color-accent-tint', 'color-accent-tint-strong']) {
        const c = T[theme](tint)
        glass.push({ label: `${theme} ${tint} over --color-sheet-solid`, rgb: over(c.rgb, c.a, solid.rgb) })
      }
      checks.push(...checkAll(text, glass, 4.5), ...checkAll(bounds, glass, 3))
      // The capsule floats over the page's own text (the landing scrolls under it): its text, its
      // control strokes and the crisis ink (no fill at night) hold over solid text of any colour.
      const under: Ground[] = Object.entries(text).map(([n, c]) => ({ label: `${theme} capsule over solid ${n}`, rgb: over(capsule.rgb, capsule.a, c) }))
      const capsuleText = Object.fromEntries(['color-text', 'color-text-soft'].map((n) => [n, T[theme](n).rgb]))
      checks.push(...checkAll(capsuleText, under, 4.5), ...checkAll({ 'color-stroke': T[theme]('color-stroke').rgb }, under, 3))
      // The painted sheet's opaque ground is its worst composite (#97 reads backgroundColor).
      const ground = T[theme]('color-sheet-ground').rgb
      const derived = over(panel.rgb, panel.a, w.rgb)
      for (const i of [0, 1, 2]) expect(Math.abs(ground[i]! - derived[i]!), `${theme} --color-sheet-ground ${hexOf(ground)} = panel over ${w.label} ${hexOf(derived)}`).toBeLessThanOrEqual(2)
      // Fills: the text on its own fill, the ring on its gap, the gap on the primary fill.
      const fill = (fg: string, bg: string, min: number): void => {
        checks.push({ pair: `${theme} --${fg} on --${bg}`, ratio: ratio(T[theme](fg).rgb, T[theme](bg).rgb), min })
      }
      fill('color-on-accent', 'color-accent', 4.5)
      fill('color-on-accent', 'color-accent-strong', 4.5)
      fill('color-on-mark', 'color-mark', 4.5)
      fill('color-on-bubble-you', 'color-bubble-you', 4.5)
      fill('color-text-soft', 'color-sheet-solid', 4.5)
      fill('color-focus', 'color-focus-gap', 3)
      fill('color-focus-gap', 'color-accent', 3)
      fill('color-crisis-line', 'color-sheet-solid', 3)
      if (day) {
        // Terracotta only on its own opaque cream (never on glass or bare sky).
        expect(T.light('color-crisis-fill').a, 'the crisis pill is opaque by day').toBe(1)
        fill('color-crisis-ink', 'color-crisis-fill', 4.5)
      } else {
        checks.push(...checkAll({ 'color-crisis-ink': T.dark('color-crisis-ink').rgb }, [...glass, ...under, w], 4.5))
      }
    }

    const failures = checks.filter((c) => c.ratio < c.min).map((c) => `${c.ratio.toFixed(2)} < ${c.min}: ${c.pair}`)
    expect(failures.slice(0, 25), `${failures.length} of ${checks.length} pairs`).toEqual([])
    expect(checks.length).toBeGreaterThan(50_000)

    // The system's light (no choice made) is a copy of the chosen light theme, preset by preset.
    const SYSTEM = {
      night: ':root:not([data-theme]):not([data-theme-lock])',
      dusk: ":root:not([data-theme]):not([data-theme-lock])[data-sky='dusk']",
      dawn: ":root:not([data-theme]):not([data-theme-lock])[data-sky='dawn']",
    } as const
    for (const preset of ['night', 'dusk', 'dawn'] as const) {
      expect(props(block(stage, SYSTEM[preset])), `system light ${preset}`).toEqual(props(block(stage, SKIES.light[preset])))
    }
    // The crisis drops the fields and the stars everywhere the sky is painted.
    const crisis = props(block(stage, "html[data-screen='crisis']"))
    expect(crisis.get('sky-image')).toBe('var(--sky-image-quiet) !important')
    expect(crisis.get('sky-stars')).toBe('none !important')
    expect(props(block(stage, ':root')).get('sky-image-quiet')).toBe('none, none, none, none, none, var(--sky-stops)')
  })

  // ADR-013 §1.4 (the landing): each section paints its own sky in literal colours (landing.css). Every
  // text token keeps 4.5:1 and every sole boundary 3:1 on every ground of every section × theme —
  // its stops, each field and ribbon over them, by day each pair of fields — with the night subtree's
  // tokens (the dark side) over the night band and the footer, and the glass over the worst of them.
  // In the dark (and in the night band by day) the fields never meet, the drift included.
  test('the landing: each section sky keeps text ≥ 4.5:1 and sole boundaries ≥ 3:1, and in the dark its fields never meet', () => {
    const styles = resolve(test.info().project.testDir, '..', '..', 'src', 'styles')
    const tokens = readFileSync(join(styles, 'tokens.css'), 'utf8')
    const landing = readFileSync(join(styles, 'landing.css'), 'utf8')
    const T = themes(tokens)
    const TEXT = ['color-text', 'color-text-soft', 'color-text-muted', 'color-text-dim', 'color-ai', 'color-teal', 'color-light', 'color-light-strong']
    const BOUNDS = ['color-stroke', 'color-field-border', 'color-focus', 'color-accent']
    const SECTIONS = ['.hero', '.mind', '.how', '.scenarios', '.diary', '.night', '.final'] as const
    const DAY = ":root[data-theme='light']:not([data-theme-lock])"
    const SYSTEM = ':root:not([data-theme]):not([data-theme-lock])'
    const amplitude = Number(/@keyframes sky-drift \{\s*to \{ --drift: ([\d.]+)%; \}/.exec(landing)?.[1]) / 100
    expect(amplitude, 'the drift of the fields').toBeGreaterThan(0)
    // Every section paints its two lists, and the crisis quiets the night to its stops.
    expect(props(block(landing, '.stage[data-quiet] ~ main .night')).size).toBe(0)
    expect(block(landing, '.stage[data-quiet] ~ main .night')).toContain('background-image: var(--sky-stops);')

    const checks: Check[] = []
    const met: string[] = []
    const pick = (theme: 'light' | 'dark', names: readonly string[]): Record<string, Rgb> => Object.fromEntries(names.map((n) => [n, T[theme](n).rgb]))
    for (const theme of ['dark', 'light'] as const) {
      const worst: Record<'own' | 'night', Ground[]> = { own: [], night: [] }
      for (const section of SECTIONS) {
        const own = props(block(landing, theme === 'dark' ? section : `${DAY} ${section}`))
        if (theme === 'light') expect(props(block(landing, `${SYSTEM} ${section}`)), `system light ${section}`).toEqual(own)
        const fields = own.get('sky-fields')
        const stops = own.get('sky-stops')
        expect([fields, stops].every(Boolean), `${theme} ${section}: --sky-fields and --sky-stops`).toBe(true)
        const night = section === '.night' // the night subtree: the dark side by day too (tokens.css)
        const sky = sectionSky(`${theme} ${section}`, fields!, stops!)
        const day = theme === 'light' && !night
        const list = sectionGrounds(sky, day)
        if (!day) met.push(...fieldsMeet(sky, amplitude))
        worst[night ? 'night' : 'own'].push(...list)
        const inks = night ? 'dark' : theme
        checks.push(...checkAll(pick(inks, TEXT), list, 4.5), ...checkAll(pick(inks, BOUNDS), list, 3))
      }
      // Glass over the worst ground: the cards of the sections (the theme's capsule), the night's
      // (the dark capsule) and the crisis card (its own night glass, ADR-013 §1.5).
      const capsule = T[theme]('color-capsule')
      const dark = T.dark('color-capsule')
      const w = worst.own.reduce((a, b) => ((theme === 'light' ? lum(b.rgb) < lum(a.rgb) : lum(b.rgb) > lum(a.rgb)) ? b : a))
      const n = worst.night.reduce((a, b) => (lum(b.rgb) > lum(a.rgb) ? b : a))
      const card = colour(/\.help-card \{[^}]*background: (rgb\([^)]*\));/.exec(landing)![1]!)
      checks.push(
        ...checkAll(pick(theme, TEXT), [{ label: `${theme} glass over ${w.label}`, rgb: over(capsule.rgb, capsule.a, w.rgb) }], 4.5),
        ...checkAll(pick('dark', TEXT), [{ label: `${theme} night glass over ${n.label}`, rgb: over(dark.rgb, dark.a, n.rgb) }], 4.5),
        ...checkAll({ ...pick('dark', TEXT), 'color-crisis-ink': T.dark('color-crisis-ink').rgb }, [{ label: `${theme} crisis card over ${n.label}`, rgb: over(card.rgb, card.a, n.rgb) }], 4.5),
      )
    }
    // The footer: the night subtree on its own ground.
    const footer = /--landing-footer: light-dark\((#[0-9a-f]{6}), (#[0-9a-f]{6})\)/.exec(landing)!
    const grounds = [footer[1]!, footer[2]!].map((hex) => ({ label: `footer ${hex}`, rgb: colour(hex).rgb }))
    checks.push(...checkAll(pick('dark', TEXT), grounds, 4.5), ...checkAll(pick('dark', BOUNDS), grounds, 3))

    expect(met, 'in the dark the fields never meet').toEqual([])
    const failures = checks.filter((c) => c.ratio < c.min).map((c) => `${c.ratio.toFixed(2)} < ${c.min}: ${c.pair}`)
    expect(failures.slice(0, 25), `${failures.length} of ${checks.length} pairs`).toEqual([])
    expect(checks.length).toBeGreaterThan(1_000)
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

  // ADR-013 adds the fourth writer, «Персонаж» (liora:character); the list stays closed.
  test('localStorage.setItem only in src/ui/motion.ts, src/ui/sky.ts, src/ui/theme.ts and src/ui/character.ts', () => {
    const writers = offenders(sources(''), /localStorage\s*\.\s*setItem\b/).map((o) => o.split(':')[0])
    expect(writers).toContain('src/ui/character.ts')
    const allowed = ['src/ui/motion.ts', 'src/ui/sky.ts', 'src/ui/theme.ts', 'src/ui/character.ts']
    expect(writers.every((p) => allowed.includes(p!)), writers.join(', ')).toBe(true)
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
      ['api', 'country', 'errors', 'helplines', 'journal', 'limits', 'selfhelp', 'sse', 'state', 'turn', 'types'].map((n) => `src/chat/core/${n}.ts`),
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

  test('chat/index.html: every text field is left out of the browser’s form restore (autocomplete="off")', () => {
    // Firefox's session store keeps a textarea's text on disk unless it has autocomplete="off"; the
    // consent screen promises the browser keeps only the session cookie and four choices (motion,
    // theme, sky, character; §3.5).
    const repo = resolve(test.info().project.testDir, '..', '..')
    const chat = readFileSync(join(repo, 'chat', 'index.html'), 'utf8')
    const tags = [...chat.matchAll(/<textarea\b[^>]*>/g), ...chat.matchAll(/<input\b[^>]*>/g)].map((m) => m[0])
    const fields = tags.filter((tag) => tag.startsWith('<textarea') || !/\stype="/.test(tag) || /\stype="(?:text|search)"/.test(tag))
    // The message, the title, a thesis (template), a new tag, the picker's search.
    expect(fields.length).toBeGreaterThanOrEqual(5)
    expect(fields.filter((tag) => !/\sautocomplete="off"/.test(tag))).toEqual([])
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

  test('the character: one module knows the key; the landing has no toggle and never reads it; /chat/ has one toggle with a state', () => {
    const keyHolders = offenders(sources(''), /liora:character/).map((o) => o.split(':')[0])
    expect(keyHolders.length).toBeGreaterThan(0)
    expect(keyHolders.every((p) => p === 'src/ui/character.ts'), keyHolders.join(', ')).toBe(true)
    const repo = resolve(test.info().project.testDir, '..', '..')
    expect(readFileSync(join(repo, 'src', 'main.ts'), 'utf8')).not.toMatch(/ui\/character/)
    expect(readFileSync(join(repo, 'index.html'), 'utf8')).not.toMatch(/data-character/)
    expect(readFileSync(join(repo, 'public', 'theme-init.js'), 'utf8')).not.toMatch(/character/)
    const chat = readFileSync(join(repo, 'chat', 'index.html'), 'utf8')
    const toggles = chat.match(/<button\b[^>]*\bdata-character-toggle\b[^>]*>/g) ?? []
    expect(toggles).toHaveLength(1)
    // A toggle with a fixed name (APG): its state is aria-pressed, «true» (shown) before the module
    // reads the choice, and the button is hidden until the module wires it.
    expect(toggles[0]).toMatch(/\saria-pressed="true"/)
    expect(toggles[0]).toMatch(/\saria-label="Персонаж"/)
    expect(toggles[0]).toMatch(/\shidden(?:\s|>)/)
    expect(chat.match(/data-character-toggle/g)).toHaveLength(1)
    // Hidden, the light's chunk (three.js) is never fetched: the choice is read before bootGL, and
    // setActive(false) follows it in the same task, before the scene starts loading (gl/core/boot.ts).
    // A static guard: a headless run never loads that chunk anyway (no GPU), so no test sees it.
    const main = readFileSync(join(repo, 'src', 'chat', 'ui', 'main.ts'), 'utf8')
    const read = main.indexOf('initCharacter(')
    const boot = main.search(/\bbootGL\s*(?:<[^>]*>)?\s*\(/)
    const hold = main.indexOf('if (!character.shown()) gl?.setActive(false)')
    expect(read).toBeGreaterThan(0)
    expect(boot).toBeGreaterThan(read)
    expect(hold).toBeGreaterThan(boot)
    expect(main.slice(boot, hold)).not.toMatch(/\bawait\b|\.then\(/)
    // And every render keeps it so: «live» in render.ts asks the character.
    expect(readFileSync(join(repo, 'src', 'chat', 'ui', 'render.ts'), 'utf8')).toMatch(/const live = \(character\?\.shown\(\) \?\? true\) && /)
  })

  test('theme: one module knows the key; public/theme-init.js only reads storage, sets two attributes and the theme-color, first in <head> of both pages', () => {
    const keyHolders = offenders(sources(''), /liora:theme/).map((o) => o.split(':')[0])
    expect(keyHolders.length).toBeGreaterThan(0)
    expect(keyHolders.every((p) => p === 'src/ui/theme.ts'), keyHolders.join(', ')).toBe(true)

    const repo = resolve(test.info().project.testDir, '..', '..')
    const init = readFileSync(join(repo, 'public', 'theme-init.js'), 'utf8')
    const code = init.replace(/\/\/[^\n]*/g, '')
    // A classic script before the first frame: small, and nothing but reads and two attributes.
    expect(init.length).toBeLessThan(1500)
    for (const pattern of [
      /\bsetItem\b/,
      /\bremoveItem\b/,
      /\.clear\s*\(/,
      /\bsessionStorage\b/,
      /\bindexedDB\b/,
      /\bcookie\b/,
      /\bfetch\b/,
      /XMLHttpRequest/,
      /\bimport\b/,
      /innerHTML|outerHTML|insertAdjacent|document\.write/,
      /\.style\b|cssText|setProperty/,
      /\beval\b|\bFunction\b/,
      /\.dataset\b/,
    ]) {
      expect(code, String(pattern)).not.toMatch(pattern)
    }
    expect([...code.matchAll(/localStorage\.getItem\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]).sort()).toEqual(['liora:sky', 'liora:theme'])
    expect([...new Set([...code.matchAll(/\.setAttribute\(\s*'([^']+)'/g)].map((m) => m[1]))].sort()).toEqual(['data-sky', 'data-theme'])
    expect([...code.matchAll(/\.setAttribute\(/g)]).toHaveLength([...code.matchAll(/\.setAttribute\(\s*'data-(?:theme|sky)'/g)].length)
    // The sky only where the page asks for it (the landing never has a preset).
    expect(code).toMatch(/hasAttribute\('data-sky'\)/)

    for (const [page, sky] of [
      ['index.html', false],
      [join('chat', 'index.html'), true],
    ] as const) {
      const html = readFileSync(join(repo, page), 'utf8')
      const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'))
      const scripts = head.match(/<script\b[^>]*>/g) ?? []
      expect(scripts[0], page).toBe(sky ? '<script src="/theme-init.js" data-sky>' : '<script src="/theme-init.js">')
      // Right after the charset and the one theme-color (the script sets the latter in the chat),
      // before every other tag of the head.
      const tags = head.replace(/<!--[\s\S]*?-->/g, '').match(/<(?:meta|link|script|title)\b[^>]*>/g)!
      expect(tags[0], page).toBe('<meta charset="UTF-8" />')
      expect(tags[1], page).toMatch(/^<meta name="theme-color" content="#[0-9a-f]{6}" \/>$/)
      expect(tags[2], page).toBe(scripts[0])
      expect(head.match(/<meta name="theme-color"/g), page).toHaveLength(1)
    }
    // The theme-color it writes before the first frame is --color-bg of each theme, in the very
    // form theme.ts writes later (getComputedStyle: rgb(r, g, b)) — no change, no flash in the bar.
    // One palette on both pages (ADR-013): light is the day's first stop (a literal), dark the night,
    // read from the hex both metas ship. landing.css has no --color-bg of its own any more.
    const tokens = readFileSync(join(repo, 'src', 'styles', 'tokens.css'), 'utf8')
    const landingCss = readFileSync(join(repo, 'src', 'styles', 'landing.css'), 'utf8')
    const bgOf = (css: string): RegExpExecArray => /--color-bg: light-dark\(#([0-9a-f]{6}), #([0-9a-f]{6})\)/.exec(css)!
    const rgb = (hex: string): string => `rgb(${[0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`
    expect(landingCss).not.toMatch(/--color-bg\s*:/)
    expect(code).toContain(`'${rgb(bgOf(tokens)[1]!)}' : 'rgb(' + (n >> 16)`)
    expect(code).toMatch(/var n = parseInt\(meta\.content\.slice\(1\), 16\)/)
    for (const page of ['index.html', join('chat', 'index.html')]) {
      const html = readFileSync(join(repo, page), 'utf8')
      expect(/<meta name="theme-color" content="#([0-9a-f]{6})" \/>/.exec(html)![1], page).toBe(bgOf(tokens)[2])
    }
    expect(code).toMatch(/meta\.content = /)
    expect(code).toMatch(/prefers-color-scheme: light/)
    // Both pages follow the system before any CSS (ADR-012); no page is pinned to one theme.
    const chat = readFileSync(join(repo, 'chat', 'index.html'), 'utf8')
    const landing = readFileSync(join(repo, 'index.html'), 'utf8')
    for (const [page, html] of [
      ['chat', chat],
      ['landing', landing],
    ] as const) {
      expect(html, page).toContain('<meta name="color-scheme" content="light dark" />')
      expect(html, page).not.toMatch(/data-theme-lock/)
      // The header's menu: three menuitemradio, plain buttons (the landing has no inputs at all).
      expect([...html.matchAll(/<button[^>]*role="menuitemradio"[^>]*data-theme-choice="([a-z]+)"/g)].map((m) => m[1]), page).toEqual(['system', 'light', 'dark'])
    }
    // The chat also has the sheet's radios: two controls, one choice.
    expect([...chat.matchAll(/<input[^>]*name="theme"[^>]*value="([a-z]+)"/g)].map((m) => m[1])).toEqual(['system', 'light', 'dark'])
  })

  // ADR-013: one palette on both pages. landing.css restates no colour token of tokens.css (it was
  // the landing's own night beside the chat's lamp); the night of :root, the fallback without
  // light-dark(), «В укритті» and the landing's night subtree (.night, the footer) each hold the dark
  // side of every light-dark() token word for word — light-dark() resolves on :root, so a subtree
  // cannot flip it. The landing's own tokens are --landing-* (light-dark, with their own fallback).
  test('one palette: landing.css restates no token; :root, the fallback, «В укритті» and the night subtree hold the dark side of every token', () => {
    const styles = resolve(test.info().project.testDir, '..', '..', 'src', 'styles')
    const tokens = readFileSync(join(styles, 'tokens.css'), 'utf8')
    const landing = readFileSync(join(styles, 'landing.css'), 'utf8')
    const pair = /^light-dark\((#[0-9a-f]{6}|rgb\([^)]*\)),\s*(#[0-9a-f]{6}|rgb\([^)]*\))\)$/i
    const theme = props(block(tokens, ':root:not([data-theme-lock])'))
    const dark = new Map<string, string>()
    for (const [name, value] of theme) {
      const m = pair.exec(value)
      // Every side of every theme token is #rrggbb or rgb(…): no var(), no transparent, no names.
      expect(m, `--${name}: light-dark(<#hex|rgb()>, <#hex|rgb()>)`).not.toBeNull()
      dark.set(name, m![2]!)
    }
    expect(dark.size).toBeGreaterThan(50)
    const fallbackAt = tokens.indexOf('@supports not (color: light-dark(#000, #fff))')
    expect(fallbackAt).toBeGreaterThan(tokens.indexOf(':root:not([data-theme-lock]) {'))
    expect(tokens.slice(fallbackAt, tokens.indexOf(':root[data-theme]:not([data-theme-lock])', fallbackAt))).toContain(':root:not([data-theme-lock]),')
    const copies = [
      ['the night of :root', block(tokens, ':root')],
      ['the fallback without light-dark()', block(tokens, ':root[data-theme]:not([data-theme-lock])', fallbackAt)],
      ['«В укритті»', block(tokens, ':root:not([data-theme-lock]) :is(.sheet--shelter, .sheet--tool[data-shelter])')],
      ['the night subtree', block(tokens, ':root:not([data-theme-lock]) :is(.night, .site-footer)')],
    ] as const
    for (const [label, body] of copies) {
      expect(body, label).toContain('color-scheme: dark;')
      const own = props(body)
      for (const [name, value] of dark) expect(own.get(name), `${label}: --${name}`).toBe(value)
    }

    // landing.css: no colour token of tokens.css, anywhere in the file.
    const declared = [...landing.matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]!)
    expect(declared.filter((name) => dark.has(name))).toEqual([])
    // Its own colours: --landing-* as light-dark(), the night once more without light-dark().
    const own = props(block(landing, ':root:not([data-theme-lock])'))
    expect(own.size).toBeGreaterThan(0)
    const at = landing.indexOf('@supports not (color: light-dark(#000, #fff))')
    expect(at).toBeGreaterThan(0)
    const fallback = props(block(landing, ':root[data-theme]:not([data-theme-lock])', at))
    for (const [name, value] of own) {
      expect(name, 'a token only the landing has').toMatch(/^landing-/)
      const m = pair.exec(value)
      expect(m, `--${name}: light-dark(<light>, <dark>)`).not.toBeNull()
      expect(fallback.get(name), `--${name} fallback`).toBe(m![2])
    }
    expect([...fallback.keys()].sort()).toEqual([...own.keys()].sort())
  })

  // ADR-013 §2: glass only with an opaque fallback. Chromium cannot emulate @supports not
  // (backdrop-filter) and Playwright has no reduced-transparency option, so this reads the CSS: every
  // selector that sets a backdrop-filter is named in both fallbacks with the sheet's own opaque tone
  // (--color-sheet-solid, alpha 1 — the contrast test counts it), and the reduced one drops the blur.
  test('glass: every backdrop-filter, capsule tint and painted sheet has an opaque fallback without backdrop-filter, with reduced transparency and in forced colours', () => {
    const styles = resolve(test.info().project.testDir, '..', '..', 'src', 'styles')
    const files = readdirSync(styles, { recursive: true, encoding: 'utf8' }).filter((p) => p.endsWith('.css'))
    const css = files.map((p) => readFileSync(join(styles, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')).join('\n')
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: m[1]!.split(',').map((s) => s.trim()), body: m[2]! }))
    const glassy = rules.filter((r) => /(?:^|[;\s])backdrop-filter:\s*(?!none)/.test(r.body)).flatMap((r) => r.selectors)
    expect(glassy.length).toBeGreaterThan(1)
    const inside = (opener: string): { selectors: string[]; body: string }[] => {
      const out: { selectors: string[]; body: string }[] = []
      let from = 0
      for (;;) {
        const at = css.indexOf(opener, from)
        if (at < 0) return out
        let depth = 0
        let end = at
        for (let i = css.indexOf('{', at); i < css.length; i++) {
          if (css[i] === '{') depth++
          else if (css[i] === '}' && --depth === 0) {
            end = i
            break
          }
        }
        const body = css.slice(css.indexOf('{', at) + 1, end)
        out.push(...[...body.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: m[1]!.split(',').map((s) => s.trim()), body: m[2]! })))
        from = end
      }
    }
    const opaque = (r: { body: string }): boolean => /background(?:-color)?:\s*var\(--color-sheet-solid\)/.test(r.body)
    const noSupport = inside('@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))').filter(opaque).flatMap((r) => r.selectors)
    const reduced = inside('@media (prefers-reduced-transparency: reduce)')
    const reducedOpaque = reduced.filter((r) => opaque(r) && /(?:^|[;\s])backdrop-filter:\s*none/.test(r.body)).flatMap((r) => r.selectors)
    const named = (list: string[], selector: string): boolean => list.some((s) => s === selector || s === `:root ${selector}`)
    for (const selector of glassy) {
      expect(named(noSupport, selector), `${selector}: opaque without backdrop-filter`).toBe(true)
      expect(named(reducedOpaque, selector), `${selector}: opaque with reduced transparency`).toBe(true)
    }

    // Translucent without a blur: the capsule's tint on a pill (the chip «AI · не людина», the hero's
    // AI note and «Як це працює») and the chat's painted sheet (the panel over the sky). With reduced
    // transparency each is opaque too — its bottom layer the sheet's own tone — and the sheet, which
    // paints its own fixed sky, also gives way to the system's canvas in forced colours.
    const last = (name: string): RegExp => new RegExp(`background(?:-color)?:\\s*[^;]*var\\(--${name}\\)\\s*(?:;|$)`)
    const outside = rules.filter((r) => !r.selectors.some((s) => s.startsWith(':root ')))
    const tinted = outside.filter((r) => last('color-capsule').test(r.body)).flatMap((r) => r.selectors)
    const painted = outside.filter((r) => /var\(--color-panel\)/.test(r.body)).flatMap((r) => r.selectors)
    expect(tinted, 'the capsule tint on pills').toEqual(expect.arrayContaining(['.ai-chip', '.hero__note', '.hero__links .text-link']))
    expect(painted, 'the painted sheet').toEqual(expect.arrayContaining(['.chat__text', '.chat__text::before', '.session::before', '.composer::before']))
    const reducedLast = reduced.filter((r) => last('color-sheet-solid').test(r.body)).flatMap((r) => r.selectors)
    const forcedCanvas = inside('@media (forced-colors: active)')
      .filter((r) => /background(?:-color)?:\s*Canvas\s*(?:;|$)/.test(r.body))
      .flatMap((r) => r.selectors)
    for (const selector of [...tinted, ...painted].filter((s) => !glassy.includes(s))) {
      expect(named(reducedLast, selector), `${selector}: opaque with reduced transparency`).toBe(true)
    }
    for (const selector of painted) expect(named(forcedCanvas, selector), `${selector}: the canvas in forced colours`).toBe(true)
  })

  // The mark (--color-mark: #ffb185 by day) is 1.33–1.65:1 on the sheet and its tints: a fill, never an
  // edge on its own. A border of the mark's colour is allowed only around its own fill (a pressed
  // «У тези»); the circle of «Подихати хвилину», the marked reply's rule, a candidate's rule and the
  // marked dots draw their edge with --color-stroke-warm (ink by day, the mark at night; the contrast
  // test above counts it as a sole boundary).
  test('the mark is a fill: no border of --color-mark except around its own fill', () => {
    const styles = resolve(test.info().project.testDir, '..', '..', 'src', 'styles')
    const files = readdirSync(styles, { recursive: true, encoding: 'utf8' }).filter((p) => p.endsWith('.css'))
    const offending: string[] = []
    for (const file of files) {
      const css = readFileSync(join(styles, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const body = m[2]!
        if (/(?:^|[;\s])border(?:-[a-z]+)*:\s*[^;]*var\(--color-mark\)/.test(body) && !/background(?:-color)?:\s*var\(--color-mark\)/.test(body)) offending.push(`${file}: ${m[1]!.trim()}`)
      }
    }
    expect(offending).toEqual([])
    const chat = readFileSync(join(styles, 'chat.css'), 'utf8')
    for (const rule of [/\.breathe__circle \{[^}]*border: 2px solid var\(--color-stroke-warm\)/, /\.said--ai::before \{[^}]*border-left: 3px solid var\(--color-stroke-warm\)/, /\.candidate__text \{[^}]*border-left: 3px solid var\(--color-stroke-warm\)/]) {
      expect(chat, String(rule)).toMatch(rule)
    }
  })

  test('page life lives in the leave guard: pagehide and pageshow are listened to in one place', () => {
    const listeners = offenders(sources('chat'), /addEventListener\(\s*['"](?:pagehide|pageshow|beforeunload)['"]/).map((o) => o.split(':')[0])
    expect(listeners.length).toBeGreaterThan(0)
    expect(listeners.every((p) => p === 'src/chat/ui/leave-guard.ts'), listeners.join(', ')).toBe(true)
  })
})
