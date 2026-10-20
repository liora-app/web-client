// Harness of the /chat/ browser tests (spec §11.2, §11.5, §11.6): the mocked API, synthetic SSE,
// a fetch shim for streams written chunk by chunk, page probes, the storage audit and the stop-list
// the landing shares.
//
// Every test of chat.spec.ts runs with the `api` fixture (auto): /api/v1/** answers from a table of
// synthetic replies, anything not in the table is aborted and fails the test, and after the test
//   - no Content-Security-Policy violation was reported,
//   - the console holds no error or warning (the browser's own line for a mocked 4xx/5xx or an
//     aborted /api/ request is the scenario, not a fault: only that exact line is let through),
//   - no uncaught exception,
//   - the DOM never contains the paused hotline number nor the server's English error message,
//   - every http(s) request went to the page's own origin.
//
// Synthetic data only: no real names, conversations or contacts. The paused number appears in the
// raw helplines on purpose — the page must drop it from every field it can hide in.

import AxeBuilder from '@axe-core/playwright'
import { expect, test as base, type Page, type Request, type Route } from '@playwright/test'
import { NO_WEBGL2 } from './helpers'

/** Kept in two halves so that no single literal in this file is the number itself. */
export const PAUSED = '73' + '33'
/** The `message` of every mocked error: English, for developers, never on the page (spec §4.1). */
export const SERVER_MESSAGE = 'Synthetic server message that never reaches the page'

// ── Synthetic API data (shapes from server/openapi.json, server @ 628a571) ─────────────────────

export const KINDS = ['data_processing', 'llm_transfer', 'age_18'] as const
export type Kind = (typeof KINDS)[number]
export const VERSION = '2026-10-06'
export const PROVIDER = { name: 'Ollama Cloud (Ollama Inc.)', country: 'US' }
export const EMAIL = 'tester@example.com'
export const ME = { id: '00000000-0000-4000-8000-000000000001', email: EMAIL, created_at: '2026-10-01T09:00:00Z', consents_ok: true }

export type ConsentsBody = {
  current_policy_version: string
  required: string[]
  granted: { kind: string; policy_version: string; granted_at: string }[]
  missing: string[]
  llm_provider: { name: string; country: string } | null
}

/** GET /consents: `missing` are the kinds still to give for `version`; the rest are granted. */
export function consents(missing: readonly Kind[] = [], version = VERSION, provider: ConsentsBody['llm_provider'] = PROVIDER): ConsentsBody {
  return {
    current_policy_version: version,
    required: [...KINDS],
    granted: KINDS.filter((kind) => !missing.includes(kind)).map((kind) => ({ kind, policy_version: version, granted_at: '2026-10-06T10:00:00Z' })),
    missing: [...missing],
    llm_provider: provider,
  }
}
export const CONSENTS_OK = consents()
export const CONSENTS_NONE = consents([...KINDS])

/** The contract's four scenarios. The server's `situation` text names a psychotherapy method: the
 *  page must show its own description instead (spec §3.6). */
export const SCENARIOS = [
  { id: 'free', title: 'Вільна розмова', description: 'Будь-яка тема.', opening_message: 'Про що вам хочеться поговорити сьогодні?', needs_summaries: false },
  {
    id: 'situation',
    title: 'Розбір ситуації',
    description: 'Тригер → реакція → альтернативний погляд (техніка з КПТ).',
    opening_message: 'Опишіть ситуацію, яка вас зачепила: що сталося?',
    needs_summaries: false,
  },
  { id: 'day', title: 'Розбір дня', description: 'День.', opening_message: 'Як минув ваш день? Що з нього запамʼяталося найбільше?', needs_summaries: false },
  { id: 'revisit', title: 'Повернення до теми', description: 'Тема.', opening_message: 'До цієї теми ви вже поверталися. Що змінилося відтоді?', needs_summaries: true },
] as const

/** The raw helplines object (GET /helplines, SSE crisis, 409 crisis_stop), with the paused number in
 *  notes, message, a line's name, a line's phone (as written and split by spaces) and abroad.text,
 *  and a foreign abroad.url. Two lines are valid and must be the only ones on the page. */
export const RAW_HELPLINES = {
  verified_at: '2026-10-05',
  review_every_days: 30,
  sources: ['https://example.org/synthetic-source'],
  notes: `Синтетична примітка: лінія ${PAUSED} на паузі.`,
  message: `Синтетичний текст із номером ${PAUSED}.`,
  emergency: [
    { name: 'Екстрені служби', phone: '112', hours: 'цілодобово', free: true },
    { name: 'Швидка допомога', phone: '103', hours: 'цілодобово', free: true },
  ],
  lines: [
    { name: 'Синтетична лінія підтримки', phone: '0 800 000 001', hours: 'цілодобово', free: true },
    { name: 'Друга синтетична лінія', phone: '0 800 000 002', hours: 'пн–пт, 9:00–21:00', free: null },
    { name: `Лінія ${PAUSED}`, phone: '0 800 000 003', hours: 'цілодобово', free: true },
    { name: 'Лінія на паузі', phone: PAUSED, hours: 'цілодобово', free: true },
    { name: 'Номер, розбитий пробілами', phone: '0 800 7 333 00', hours: 'цілодобово', free: true },
  ],
  abroad: { text: `За кордоном — синтетичний текст ${PAUSED}.`, url: 'https://evil.example/hot-lines' },
}
/** What the page may show of RAW_HELPLINES. */
export const SAFE_LINES = [
  { name: 'Синтетична лінія підтримки', phone: '0 800 000 001', tel: 'tel:0800000001' },
  { name: 'Друга синтетична лінія', phone: '0 800 000 002', tel: 'tel:0800000002' },
]

export const DRAFT = {
  title: 'Відкладена розмова з колегою',
  bullets: [
    'Відкладена розмова забирає сили ще до того, як відбулася.',
    'Найбільше лякає можлива реакція колеги.',
    'Мета розмови — домовитися, а не звинуватити.',
    'Можна почати з того, чого я хочу для нас обох.',
  ],
  tags: ['робота', 'стосунки'],
}

export type Summary = {
  id: string
  scenario: string
  title: string
  bullets: string[]
  tags: { id: string; name: string; source: string }[]
  created_at: string
  edited_at: string | null
}

/** A diary record (1 ≤ i ≤ 9). */
export function record(i: number, init: Partial<Summary> = {}): Summary {
  return {
    id: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`,
    scenario: 'free',
    title: `Синтетичний запис ${i}`,
    bullets: [`Перша теза запису ${i}.`, `Друга теза запису ${i}.`],
    tags: [{ id: `00000000-0000-4000-9000-0000000001${String(i).padStart(2, '0')}`, name: 'робота', source: 'ai' }],
    created_at: `2026-10-0${i}T10:00:00Z`,
    edited_at: null,
    ...init,
  }
}

export const diary = (items: Summary[] = [], next: string | null = null): { items: Summary[]; next_cursor: string | null } => ({ items, next_cursor: next })

/** POST /summaries → 201: the record as the server would store it. */
export function storedFrom(body: unknown): Summary {
  const b = body as { scenario: string; title: string; bullets: string[]; tags: { name: string; source: string }[] }
  return {
    id: '00000000-0000-4000-8000-000000000999',
    scenario: b.scenario,
    title: b.title,
    bullets: b.bullets,
    tags: b.tags.map((t, i) => ({ id: `00000000-0000-4000-9000-00000000099${i}`, name: t.name, source: t.source })),
    created_at: '2026-10-07T12:00:00Z',
    edited_at: null,
  }
}

// ── SSE ──────────────────────────────────────────────────────────────────────────────────────

export const frame = (type: string, data: Record<string, unknown> = {}): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
export const ping = (): string => ': ping\n\n'
export const meta = (id = 'req-1'): string => frame('meta', { request_id: id })
export const token = (text: string): string => frame('token', { text })
export const done = (finish: string | null = 'stop'): string => frame('done', { finish_reason: finish, usage: null })
export const crisis = (source: 'keyword' | 'model', helplines: unknown = RAW_HELPLINES): string => frame('crisis', { source, helplines })
export const streamError = (code: 'llm_failed' | 'llm_busy' | 'internal', retryable = true): string => frame('error', { code, retryable })
/** Frames (and comments) back to back: one body. */
export const sse = (...parts: string[]): string => parts.join('')

export const REPLY = ['Схоже, ця розмова ', 'забирає багато сил. ', 'Що в ній найважче?']
export const REPLY_TEXT = REPLY.join('')
/** meta, the tokens, done. */
export const reply = (tokens: readonly string[] = REPLY): string => meta() + tokens.map(token).join('') + done()

// ── The mocked API ───────────────────────────────────────────────────────────────────────────

export type ApiCall = Readonly<{
  method: string
  /** Without /api/v1 and without the query. */
  path: string
  query: URLSearchParams
  /** Parsed JSON body (or the raw text when it is not JSON); null without a body. */
  body: unknown
  raw: string | null
  headers: Record<string, string>
  request: Request
}>

export type Reply = Readonly<{
  status?: number
  json?: unknown
  sse?: string
  body?: string
  contentType?: string
  headers?: Record<string, string>
  /** route.abort(): the request fails like a dropped connection. */
  abort?: boolean
}>

export type Handler = Reply | ((call: ApiCall, index: number) => Reply | Promise<Reply>)

/** The error envelope (`message` is never shown, spec §4.1). */
export function fail(status: number, code: string, details?: unknown, headers?: Record<string, string>): Reply {
  return { status, json: { error: { code, message: SERVER_MESSAGE, ...(details === undefined ? {} : { details }) } }, headers }
}

/** A response that waits until the test opens it. */
export type Gate = Readonly<{ wait: Promise<void>; open: () => void }>
export function gate(): Gate {
  let open = (): void => {}
  const wait = new Promise<void>((resolve) => (open = resolve))
  return { wait, open }
}

const DEFAULTS: Record<string, Handler> = {
  'GET /me': { json: ME },
  'GET /consents': { json: CONSENTS_OK },
  'POST /consents': { json: CONSENTS_OK },
  'GET /scenarios': { json: SCENARIOS },
  'GET /summaries': { json: diary() },
  'GET /helplines': { json: RAW_HELPLINES },
  'POST /chat/turn': { sse: reply() },
  'POST /chat/summarize': { json: DRAFT },
  'POST /summaries': (call) => ({ status: 201, json: storedFrom(call.body) }),
  'POST /auth/logout': { status: 204 },
  'DELETE /me': { status: 204 },
  'DELETE /consents/data_processing': { json: consents(['data_processing']) },
  'DELETE /consents/llm_transfer': { json: consents(['llm_transfer']) },
  'DELETE /consents/age_18': { json: consents(['age_18']) },
  // Top-level navigation of «Увійти знову»: a stand-in page instead of Google.
  'GET /auth/google/start': { contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>Google</title><p>Вхід</p>' },
}

export class MockApi {
  readonly calls: ApiCall[] = []
  readonly unexpected: string[] = []
  private readonly table = new Map<string, readonly Handler[]>()
  private served = 0

  constructor() {
    for (const [key, handler] of Object.entries(DEFAULTS)) this.table.set(key, [handler])
  }

  /** Replaces the answer to "METHOD /path". Several handlers answer the 1st, 2nd, … call; the last
   *  one answers every later call. */
  on(key: string, ...handlers: Handler[]): this {
    this.table.set(key, handlers)
    return this
  }

  /** Calls of "METHOD /path", in order. */
  of(key: string): ApiCall[] {
    return this.calls.filter((call) => `${call.method} ${call.path}` === key)
  }

  count(key: string): number {
    return this.of(key).length
  }

  bodies(key: string): unknown[] {
    return this.of(key).map((call) => call.body)
  }

  async handle(route: Route): Promise<void> {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^\/api\/v1/, '')
    const key = `${request.method()} ${path}`
    const raw = request.postData()
    let body: unknown = null
    if (raw !== null && raw !== '') {
      try {
        body = JSON.parse(raw)
      } catch {
        body = raw
      }
    }
    // headers() here: allHeaders() may wait for network data a fulfilled route never produces. A test
    // that needs Origin reads call.request.allHeaders() once the response is in.
    const headers = request.headers()
    const index = this.count(key)
    const call: ApiCall = { method: request.method(), path, query: url.searchParams, body, raw, headers, request }
    this.calls.push(call)
    const handlers = this.table.get(key)
    if (handlers === undefined || handlers.length === 0) {
      this.unexpected.push(`${key}${url.search}`)
      await route.abort().catch(() => {})
      return
    }
    const handler = handlers[Math.min(index, handlers.length - 1)]!
    const answer = typeof handler === 'function' ? await handler(call, index) : handler
    await this.fulfil(route, answer).catch(() => {})
  }

  private fulfil(route: Route, answer: Reply): Promise<void> {
    if (answer.abort === true) return route.abort('failed')
    this.served++
    const headers: Record<string, string> = { 'x-request-id': `req-test-${this.served}`, ...answer.headers }
    const status = answer.status ?? 200
    if (answer.sse !== undefined) {
      return route.fulfill({ status, headers: { 'content-type': 'text/event-stream; charset=utf-8', ...headers }, body: answer.sse })
    }
    if (answer.json !== undefined) {
      return route.fulfill({ status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(answer.json) })
    }
    if (answer.contentType !== undefined) headers['content-type'] = answer.contentType
    return route.fulfill({ status, headers, body: answer.body ?? '' })
  }
}

// ── Page probes (an init script: runs before the page's own code on every navigation) ───────

type Probes = {
  __csp: string[]
  /** [data-announcer] text after each change (an emptying included). */
  __announced: string[]
  /** aria-busy of the answer being streamed, as it changes. */
  __busy: string[]
  /** beforeunload listeners registered on window right now. */
  __beforeunload: () => number
}

function probes(): void {
  const w = window as unknown as Probes
  const csp: string[] = []
  const announced: string[] = []
  const busy: string[] = []
  w.__csp = csp
  w.__announced = announced
  w.__busy = busy
  document.addEventListener('securitypolicyviolation', (event) => csp.push(`${event.violatedDirective} ${event.blockedURI}`))

  const add = window.addEventListener
  const remove = window.removeEventListener
  const active = new Set<unknown>()
  window.addEventListener = function (this: Window, type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void {
    if (type === 'beforeunload' && listener) active.add(listener)
    add.call(this ?? window, type, listener, options)
  } as typeof window.addEventListener
  window.removeEventListener = function (this: Window, type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void {
    if (type === 'beforeunload' && listener) active.delete(listener)
    remove.call(this ?? window, type, listener, options)
  } as typeof window.removeEventListener
  w.__beforeunload = () => active.size

  const watch = (): void => {
    const region = document.querySelector('[data-announcer]')
    if (region) new MutationObserver(() => announced.push(region.textContent ?? '')).observe(region, { childList: true, characterData: true, subtree: true })
    const talk = document.querySelector('[data-el="talk"]')
    if (talk) {
      new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === 'attributes' && record.target instanceof Element && record.target.matches('.said--live')) {
            busy.push(record.target.getAttribute('aria-busy') ?? '')
          }
          for (const node of Array.from(record.addedNodes)) {
            if (node instanceof Element && node.matches('.said--live')) busy.push(node.getAttribute('aria-busy') ?? '')
          }
        }
      }).observe(talk, { attributes: true, attributeFilter: ['aria-busy'], childList: true, subtree: true })
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch, { once: true })
  else watch()
}

export const announced = (page: Page): Promise<string[]> => page.evaluate(() => [...(window as unknown as Probes).__announced])
export const busyLog = (page: Page): Promise<string[]> => page.evaluate(() => [...(window as unknown as Probes).__busy])
export const beforeUnload = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as Probes).__beforeunload())

// ── A stream written chunk by chunk (fetch shim for POST /chat/turn, spec §11.2) ──────────────

type ShimCall = {
  body: string
  mode: string | null
  credentials: string | null
  referrerPolicy: string | null
  contentType: string | null
  aborted: boolean
  reason: string | null
  write(bytes: number[]): void
  close(): void
}

/** route.fulfill hands over a body in one piece; this shim answers the page's fetch of
 *  /api/v1/chat/turn at once (200, text/event-stream) with a ReadableStream the test writes into,
 *  and keeps what the request carried and whether (and why) its signal aborted. An abort errors
 *  the body with the signal's reason, as a real fetch does. Other requests go to the real fetch. */
function streamShim(): void {
  const calls: ShimCall[] = []
  ;(window as unknown as { __sse: ShimCall[] }).__sse = calls
  const original = window.fetch
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.includes('/api/v1/chat/turn')) return original.call(window, input, init)
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null
    let finished = false
    const call: ShimCall = {
      body: typeof init?.body === 'string' ? init.body : '',
      mode: init?.mode ?? null,
      credentials: init?.credentials ?? null,
      referrerPolicy: init?.referrerPolicy ?? null,
      contentType: new Headers(init?.headers).get('content-type'),
      aborted: false,
      reason: null,
      write(bytes) {
        if (finished || controller === null) return
        try {
          controller.enqueue(new Uint8Array(bytes))
        } catch {
          finished = true
        }
      },
      close() {
        if (finished || controller === null) return
        finished = true
        try {
          controller.close()
        } catch {
          // Already cancelled by the reader.
        }
      },
    }
    calls.push(call)
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
      },
      cancel() {
        finished = true
      },
    })
    const signal = init?.signal ?? null
    if (signal !== null) {
      const onAbort = (): void => {
        call.aborted = true
        call.reason = typeof signal.reason === 'string' ? signal.reason : String(signal.reason)
        if (!finished && controller !== null) {
          finished = true
          try {
            controller.error(signal.reason)
          } catch {
            // Closed meanwhile.
          }
        }
      }
      if (signal.aborted) {
        onAbort()
        return Promise.reject(signal.reason)
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    return Promise.resolve(
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'x-request-id': 'req-stream' } }),
    )
  }
}

export type StreamInfo = Readonly<{
  body: string
  mode: string | null
  credentials: string | null
  referrerPolicy: string | null
  contentType: string | null
  aborted: boolean
  reason: string | null
}>

export class Stream {
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  count(): Promise<number> {
    return this.page.evaluate(() => (window as unknown as { __sse: ShimCall[] }).__sse.length)
  }

  /** Waits until the page has made `n` turn requests. */
  async requests(n: number): Promise<void> {
    await expect.poll(() => this.count(), { message: `${n} turn request(s)` }).toBe(n)
  }

  /** Writes UTF-8 of `text` as one chunk into request `at` (−1: the last one). */
  write(text: string, at = -1): Promise<void> {
    return this.bytes(Array.from(new TextEncoder().encode(text)), at)
  }

  bytes(bytes: number[], at = -1): Promise<void> {
    return this.page.evaluate(
      ({ bytes, at }) => (window as unknown as { __sse: ShimCall[] }).__sse.at(at)?.write(bytes),
      { bytes, at },
    )
  }

  close(at = -1): Promise<void> {
    return this.page.evaluate((at) => (window as unknown as { __sse: ShimCall[] }).__sse.at(at)?.close(), at)
  }

  info(at = -1): Promise<StreamInfo> {
    return this.page.evaluate((at) => {
      const call = (window as unknown as { __sse: ShimCall[] }).__sse.at(at)
      if (call === undefined) throw new Error('no turn request yet')
      return {
        body: call.body,
        mode: call.mode,
        credentials: call.credentials,
        referrerPolicy: call.referrerPolicy,
        contentType: call.contentType,
        aborted: call.aborted,
        reason: call.reason,
      }
    }, at)
  }
}

/** Installs the shim; call before page.goto. */
export async function streamTurns(page: Page): Promise<Stream> {
  await page.addInitScript(streamShim)
  return new Stream(page)
}

// ── The fixture ──────────────────────────────────────────────────────────────────────────────

/** The browser's own console line for a mocked 4xx/5xx or an aborted request under /api/v1/. */
function networkLine(text: string, where: string): boolean {
  if (!/^Failed to load resource: (the server responded with a status of \d{3}\b|net::ERR_FAILED|net::ERR_ABORTED)/.test(text)) return false
  try {
    return new URL(where).pathname.startsWith('/api/v1/')
  } catch {
    return false
  }
}

export type ChatFixtures = {
  /** The mocked API (auto: every test of chat.spec.ts runs with it and with the audit). */
  api: MockApi
  /** Every console line of the test (for "the message is not in the console", spec §11.5). */
  consoleLines: string[]
  /** false (default): the page sees no WebGL2 and keeps its static light — the chat tests check the
   *  chat, not the scene, and stay light on a machine with a GPU. @gpu tests set it to true. */
  webgl: boolean
}

async function pageEval<T>(page: Page, fn: () => T): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.waitForLoadState('domcontentloaded')
      return await page.evaluate(fn)
    } catch {
      // A navigation was on its way: try once more on the new document.
    }
  }
  return null
}

export const test = base.extend<ChatFixtures>({
  webgl: [false, { option: true }],
  consoleLines: async ({}, use) => {
    await use([])
  },
  api: [
    async ({ page, baseURL, webgl, consoleLines }, use, testInfo) => {
      const api = new MockApi()
      const problems: string[] = []
      const foreign = new Set<string>()
      const own = new URL(baseURL ?? 'http://localhost:4173').origin
      if (!webgl) await page.addInitScript(NO_WEBGL2)
      await page.addInitScript(probes)
      page.on('console', (message) => {
        const text = message.text()
        consoleLines.push(text)
        const type = message.type()
        if (type !== 'error' && type !== 'warning') return
        if (networkLine(text, message.location().url)) return
        problems.push(`${type}: ${text}`)
      })
      page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
      page.on('request', (request) => {
        const url = request.url()
        if (!/^https?:/.test(url)) return
        const origin = new URL(url).origin
        if (origin !== own) foreign.add(origin)
      })
      await page.route('**/api/v1/**', (route) => api.handle(route))

      await use(api)

      const passed = testInfo.status === testInfo.expectedStatus && testInfo.status === 'passed'
      if (passed && !page.isClosed()) {
        const html = (await pageEval(page, () => document.documentElement.outerHTML)) ?? ''
        expect(html.includes(PAUSED), 'the paused hotline number is in the DOM').toBe(false)
        expect(html.includes(SERVER_MESSAGE), "the server's error.message reached the page").toBe(false)
        expect((await pageEval(page, () => (window as unknown as Partial<Probes>).__csp ?? [])) ?? [], 'CSP violations').toEqual([])
      }
      if (passed) {
        expect(problems, 'console errors, warnings and uncaught exceptions').toEqual([])
        expect([...foreign], 'requests to other origins').toEqual([])
        expect(api.unexpected, 'API requests the test did not expect').toEqual([])
      }
      if (!page.isClosed()) await page.unrouteAll({ behavior: 'ignoreErrors' })
    },
    { auto: true },
  ],
})

export { expect }

// ── Helpers for the screens ──────────────────────────────────────────────────────────────────

export const html = (page: Page) => page.locator('html')

/** Waits for the screen (html[data-screen]). */
export async function onScreen(page: Page, name: string): Promise<void> {
  await expect(html(page)).toHaveAttribute('data-screen', name)
}

export async function openChat(page: Page, path = '/chat/', screen = 'chat'): Promise<void> {
  await page.goto(path)
  await onScreen(page, screen)
}

export const composer = (page: Page) => page.locator('#composer-input')
export const sendButton = (page: Page) => page.locator('[data-el="composer-send"]')
export const talk = (page: Page) => page.locator('[data-el="talk"]')
/** The AI's messages in the conversation, the opening message first. */
export const aiMessages = (page: Page) => page.locator('[data-el="talk"] > li.said--ai')
export const userMessages = (page: Page) => page.locator('[data-el="talk"] > li.said--you')
export const lastUser = (page: Page) => userMessages(page).last()

/** Types the message and presses «Надіслати» (Enter on a fine pointer with via: 'enter'). */
export async function send(page: Page, text: string, via: 'button' | 'enter' = 'button'): Promise<void> {
  await composer(page).fill(text)
  if (via === 'enter') await composer(page).press('Enter')
  else await sendButton(page).click()
}

/** `n` answers of the AI are in, none streaming. */
export async function answered(page: Page, n: number): Promise<void> {
  await expect(aiMessages(page)).toHaveCount(n + 1)
  await expect(page.locator('[data-el="talk"] > li[aria-busy="true"]')).toHaveCount(0)
}

/** A new conversation, one message, one answer. */
export async function exchange(page: Page, text = 'Синтетичне повідомлення про робочий тиждень.'): Promise<void> {
  const before = await aiMessages(page).count()
  await send(page, text)
  await answered(page, before)
}

/** From the conversation (with an answer) through «Завершити розмову» → «Підсумувати» to review. */
export async function toReview(page: Page): Promise<void> {
  await page.locator('[data-el="session-end"]').click()
  await page.locator('#confirm-dialog').getByRole('button', { name: 'Підсумувати' }).click()
  await onScreen(page, 'review')
}

export const confirmDialog = (page: Page) => page.locator('#confirm-dialog')

export async function axe(page: Page, label: string): Promise<void> {
  // The screen and the messages rise in for a few hundred ms (spec §3.1): measuring contrast in the
  // middle of a fade would read a colour the text never rests on. Endless loops (the orb's breath)
  // are left alone — they never move the text's colour.
  await page.evaluate(() =>
    Promise.race([
      Promise.all(
        document
          .getAnimations()
          .filter((a) => Number.isFinite(Number(a.effect?.getComputedTiming().endTime)))
          .map((a) => a.finished.catch(() => undefined)),
      ),
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ]),
  )
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
  expect(summary, `axe: ${label}`).toEqual([])
}

// ── Storage audit (spec §11.5) ───────────────────────────────────────────────────────────────

export async function storageAudit(page: Page, secret: string | null = null, consoleLines: readonly string[] = []): Promise<void> {
  const audit = await page.evaluate(async () => ({
    local: Object.keys(localStorage),
    values: Object.keys(localStorage).map((key) => localStorage.getItem(key) ?? ''),
    session: sessionStorage.length,
    idb: (await indexedDB.databases?.())?.length ?? 0,
    caches: (await caches.keys()).length,
    sw: (await navigator.serviceWorker?.getRegistrations())?.length ?? 0,
    cookie: document.cookie,
    title: document.title,
    url: location.href,
  }))
  expect(audit.local.every((key) => key === 'liora:motion' || key === 'liora:sky' || key === 'liora:theme'), `storage keys: ${audit.local.join(', ')}`).toBe(true)
  expect(audit).toMatchObject({ session: 0, idb: 0, caches: 0, sw: 0, cookie: '' })
  if (secret !== null) {
    expect(audit.values.some((value) => value.includes(secret)), 'the message is in localStorage').toBe(false)
    expect(audit.url.includes(encodeURIComponent(secret)) || audit.url.includes(secret), 'the message is in the URL').toBe(false)
    expect(audit.title.includes(secret), 'the message is in the title').toBe(false)
    expect(consoleLines.some((line) => line.includes(secret)), 'the message is in the console').toBe(false)
  }
}

// ── Stop-list (spec §11.6): one list for the landing and the chat ───────────────────────────

/** Never acceptable, in any context. \w is ASCII-only in JS: Cyrillic endings need \S*. */
export const FORBIDDEN: readonly RegExp[] = [
  /№\s?1/,
  /перш\S* у світі/,
  /military/,
  /навчанн\S* (ші|ai|моделей)/,
  /ніхто,? навіть ми/,
  /наскрізн\S* шифруван/,
  new RegExp(PAUSED),
  /zero retention/,
  /нульов\S* (зберіган|утриман)/,
  // «у Liora нічого не залишиться» / «ми нічого не зберегли» are the same zero-retention promise:
  // the server writes technical records on every request (spec §3.4, §3.7.8, §11.6).
  /нічого не (залиш|зберег|зберіга)/,
  /анонімн/,
  // Promises about the AI provider ("постачальник не логує", "навіть постачальник не бачить").
  /(постачальник|провайдер)[^.\n]{0,60}не (логу|зберіга|бач)/,
  /(ні|навіть)\s+(постачальник|провайдер)/,
]

/** A sieve, not a proof: clinical words may only appear negated in the same sentence ("не терапія",
 *  "не призначена для діагностики") or inside a question the page then answers. Lower-case text. */
export function clinicalOffenders(text: string): string[] {
  const clinical = /терапі|терапевт|психолог|психіатр|лікув|лікує|діагно[зс]|депрес|тривог|тривожн/g
  const offenders: string[] = []
  for (const match of text.matchAll(clinical)) {
    const at = match.index ?? 0
    const clause = text.slice(Math.max(0, at - 160), at).split(/[.!?\n]/).pop() ?? ''
    const sentenceEnd = text.slice(at).search(/[.!?\n]/)
    const isQuestion = sentenceEnd >= 0 && text[at + sentenceEnd] === '?'
    if (!/(^|[\s(«])(не|ні)\s/.test(clause) && !isQuestion) offenders.push(text.slice(Math.max(0, at - 40), at + 30))
  }
  return offenders
}
