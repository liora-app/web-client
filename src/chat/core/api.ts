// Same-origin client for /api/v1 (spec §5.1, ADR-007).
//
// Every request:
// - goes through the injected `fetch` in its default mode — never with a `mode` option: under
//   `Referrer-Policy: no-referrer` WebKit sends `Origin: null` for the same-origin mode, and the
//   server's CSRF check answers 403 csrf_failed;
// - sends the session cookie with `credentials: 'same-origin'`, never a bearer header;
// - carries `Content-Type: application/json` on every unsafe method (POST, PUT, PATCH, DELETE);
// - builds its JSON body field by field (the API forbids extra fields), never by spreading an
//   object it was given.

import { clientError, fromResponse, type ApiError } from './errors'
import { sanitizeHelplines, type SafeHelplines } from './helplines'
import { codePoints, MAX_CONTENT } from './limits'
import {
  CONSENT_KINDS,
  type ChatMessage,
  type ConsentGrantIn,
  type ConsentKind,
  type ConsentState,
  type GrantedConsent,
  type LLMProviderInfo,
  type MeOut,
  type ScenarioId,
  type ScenarioOut,
  type SummarizeRequest,
  type SummaryCreate,
  type SummaryDraftOut,
  type SummaryList,
  type SummaryOut,
  type SummaryPatch,
  type SummaryTagOut,
  type TagCountOut,
  type TagSource,
  type TagTrend,
  type TurnRequest,
  type WeeklyReviewOut,
} from './types'

export const API_BASE = '/api/v1'
/** Top-level navigation, not fetch: the sign-in leaves this page for Google and comes back. */
export const GOOGLE_START = `${API_BASE}/auth/google/start?next=/`
export const exportHref = (format: 'md' | 'json'): string => `${API_BASE}/export?format=${format}`

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>
export type ApiDeps = Readonly<{ fetch: FetchLike; now?: () => number }>

export type ApiOk<T> = Readonly<{ ok: true; data: T; status: number; requestId: string | null; date: string | null }>
export type ApiFail = Readonly<{ ok: false; error: ApiError }>
export type ApiResult<T> = ApiOk<T> | ApiFail

export type SummariesQuery = Readonly<{ limit?: number; cursor?: string | null; q?: string | null; tag?: string | null }>
/** GET /reviews/weekly: `weekStart` any day of the week (the server moves it to Monday), absent
 *  for the week of today in `tz`; `tz` an IANA zone, absent for the server's Europe/Kyiv. */
export type WeeklyQuery = Readonly<{ weekStart?: string | null; tz?: string | null }>

export type Api = Readonly<{
  me(signal?: AbortSignal): Promise<ApiResult<MeOut>>
  consents(signal?: AbortSignal): Promise<ApiResult<ConsentState>>
  grant(body: ConsentGrantIn, signal?: AbortSignal): Promise<ApiResult<ConsentState>>
  revoke(kind: ConsentKind, signal?: AbortSignal): Promise<ApiResult<ConsentState>>
  scenarios(signal?: AbortSignal): Promise<ApiResult<readonly ScenarioOut[]>>
  summaries(query: SummariesQuery, signal?: AbortSignal): Promise<ApiResult<SummaryList>>
  /** The raw Response: turn.ts reads the SSE body itself. Rejects like fetch does. */
  turn(body: TurnRequest, signal: AbortSignal): Promise<Response>
  summarize(body: SummarizeRequest, signal?: AbortSignal): Promise<ApiResult<SummaryDraftOut>>
  saveSummary(body: SummaryCreate, signal?: AbortSignal): Promise<ApiResult<SummaryOut>>
  /** PATCH /summaries/{id}: only the fields given, each replacing the stored one. */
  patchSummary(id: string, body: SummaryPatch, signal?: AbortSignal): Promise<ApiResult<SummaryOut>>
  /** DELETE /summaries/{id} → 204. */
  deleteSummary(id: string, signal?: AbortSignal): Promise<ApiResult<null>>
  tags(signal?: AbortSignal): Promise<ApiResult<readonly TagCountOut[]>>
  weekly(query: WeeklyQuery, signal?: AbortSignal): Promise<ApiResult<WeeklyReviewOut>>
  deleteMe(signal?: AbortSignal): Promise<ApiResult<null>>
  logout(signal?: AbortSignal): Promise<ApiResult<null>>
  /** Already sanitized: the raw payload never leaves this call. */
  helplines(signal?: AbortSignal): Promise<ApiResult<SafeHelplines>>
}>

// ── Request bodies ────────────────────────────────────────────────────────────────────────────

const message = (m: ChatMessage): ChatMessage => ({ role: m.role, content: m.content })

/** TurnRequest with revisit_summary_ids iff the scenario is revisit (I9). No other field, ever. */
export function turnBody(scenario: ScenarioId, messages: readonly ChatMessage[], revisitIds: readonly string[]): TurnRequest {
  if (scenario === 'revisit') {
    if (revisitIds.length === 0) throw new Error('revisit turn without revisit_summary_ids')
    return { scenario, messages: messages.map(message), revisit_summary_ids: [...revisitIds] }
  }
  return { scenario, messages: messages.map(message) }
}

/** Exactly {scenario, messages}: summarize takes no revisit ids (I9, §7.1). */
export function summarizeBody(scenario: ScenarioId, messages: readonly ChatMessage[]): SummarizeRequest {
  return { scenario, messages: messages.map(message) }
}

export function grantBody(policyVersion: string, kinds: readonly ConsentKind[]): ConsentGrantIn {
  return { policy_version: policyVersion, kinds: [...kinds] }
}

export function summaryBody(body: SummaryCreate): SummaryCreate {
  return {
    scenario: body.scenario,
    title: body.title,
    bullets: [...body.bullets],
    tags: body.tags.map((t) => ({ name: t.name, source: t.source })),
  }
}

/** SummaryPatch field by field: a field left out stays as stored (an explicit null would mean the
 *  same, but nothing is simpler than not sending it). Tags keep their source. */
export function patchBody(body: SummaryPatch): SummaryPatch {
  const out: { title?: string; bullets?: string[]; tags?: { name: string; source: TagSource }[] } = {}
  if (body.title !== undefined) out.title = body.title
  if (body.bullets !== undefined) out.bullets = [...body.bullets]
  if (body.tags !== undefined) out.tags = body.tags.map((t) => ({ name: t.name, source: t.source }))
  return out
}

/** The query of GET /summaries, in this order: limit, cursor, q, tag. A blank `q` is not sent —
 *  the server would read «   » as a search that matches everything. */
export function summariesPath(query: SummariesQuery): string {
  const params = new URLSearchParams()
  params.set('limit', String(query.limit ?? 20))
  if (query.cursor) params.set('cursor', query.cursor)
  if (query.q && query.q.trim() !== '') params.set('q', query.q)
  if (query.tag) params.set('tag', query.tag)
  return `/summaries?${params.toString()}`
}

export function weeklyPath(query: WeeklyQuery): string {
  const params = new URLSearchParams()
  if (query.weekStart) params.set('week_start', query.weekStart)
  if (query.tz) params.set('tz', query.tz)
  const search = params.toString()
  return search === '' ? '/reviews/weekly' : `/reviews/weekly?${search}`
}

// ── Response checks (light: enough that the state machine never reads a wrong type) ──────────

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const kindsOf = (v: unknown): ConsentKind[] =>
  Array.isArray(v) ? v.filter((k): k is ConsentKind => (CONSENT_KINDS as readonly unknown[]).includes(k)) : []

function parseMe(raw: unknown): MeOut | null {
  if (!isObj(raw) || !isStr(raw.id) || !isStr(raw.email)) return null
  return {
    id: raw.id,
    email: raw.email,
    created_at: isStr(raw.created_at) ? raw.created_at : '',
    consents_ok: raw.consents_ok === true,
  }
}

/** Named, or not at all; the country when there is a usable one, '' otherwise. The page names the
 *  provider wherever it mentions it; the consent to hand it the conversation needs the country as
 *  well, and only the consent gate asks for it (state.ts transferAskable, §3.5). */
function parseProvider(raw: unknown): LLMProviderInfo | null {
  if (!isObj(raw) || !isStr(raw.name)) return null
  const name = raw.name.trim()
  const length = codePoints(name)
  if (length < 1 || length > 200) return null
  const country = isStr(raw.country) ? raw.country.trim() : ''
  return { name, country: codePoints(country) > 64 ? '' : country }
}

function parseConsents(raw: unknown): ConsentState | null {
  if (!isObj(raw) || !isStr(raw.current_policy_version) || !Array.isArray(raw.missing)) return null
  const granted: GrantedConsent[] = []
  if (Array.isArray(raw.granted)) {
    for (const g of raw.granted) {
      if (!isObj(g) || !isStr(g.policy_version) || !isStr(g.granted_at)) continue
      const [kind] = kindsOf([g.kind])
      if (kind !== undefined) granted.push({ kind, policy_version: g.policy_version, granted_at: g.granted_at })
    }
  }
  const required = kindsOf(raw.required)
  return {
    current_policy_version: raw.current_policy_version,
    required: required.length > 0 ? required : [...CONSENT_KINDS],
    granted,
    missing: kindsOf(raw.missing),
    llm_provider: parseProvider(raw.llm_provider),
  }
}

function parseScenarios(raw: unknown): readonly ScenarioOut[] | null {
  if (!Array.isArray(raw)) return null
  const out: ScenarioOut[] = []
  for (const s of raw) {
    if (!isObj(s) || !isStr(s.id) || !isStr(s.title) || !isStr(s.opening_message)) continue
    if (s.id === '' || s.id.length > 32 || out.some((o) => o.id === s.id)) continue
    // The opening message goes back to the server as the first assistant message, so it must
    // fit ChatMessageIn (1..4000) or every turn of that scenario would be a 422.
    const opening = codePoints(s.opening_message)
    if (opening < 1 || opening > MAX_CONTENT || s.opening_message.trim() === '') continue
    out.push({
      id: s.id,
      title: s.title,
      description: isStr(s.description) ? s.description : '',
      opening_message: s.opening_message,
      needs_summaries: s.needs_summaries === true,
    })
  }
  return out.length > 0 ? out : null
}

function parseTag(raw: unknown): SummaryTagOut | null {
  if (!isObj(raw) || !isStr(raw.name)) return null
  return { id: isStr(raw.id) ? raw.id : '', name: raw.name, source: raw.source === 'ai' ? 'ai' : 'user' }
}

function parseSummary(raw: unknown): SummaryOut | null {
  if (!isObj(raw) || !isStr(raw.id) || !isStr(raw.title) || !isStr(raw.scenario) || !Array.isArray(raw.bullets)) return null
  return {
    id: raw.id,
    scenario: raw.scenario,
    title: raw.title,
    bullets: raw.bullets.filter(isStr),
    tags: Array.isArray(raw.tags) ? raw.tags.map(parseTag).filter((t): t is SummaryTagOut => t !== null) : [],
    created_at: isStr(raw.created_at) ? raw.created_at : '',
    edited_at: isStr(raw.edited_at) ? raw.edited_at : null,
  }
}

function parseSummaryList(raw: unknown): SummaryList | null {
  if (!isObj(raw) || !Array.isArray(raw.items)) return null
  return {
    items: raw.items.map(parseSummary).filter((s): s is SummaryOut => s !== null),
    next_cursor: isStr(raw.next_cursor) && raw.next_cursor !== '' ? raw.next_cursor : null,
  }
}

function parseTagCounts(raw: unknown): readonly TagCountOut[] | null {
  if (!Array.isArray(raw)) return null
  const out: TagCountOut[] = []
  for (const t of raw) {
    if (!isObj(t) || !isStr(t.id) || t.id === '' || !isStr(t.name) || t.name.trim() === '') continue
    if (out.some((o) => o.id === t.id)) continue
    out.push({ id: t.id, name: t.name, count: isCount(t.count) ? t.count : 0 })
  }
  return out
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((n): n is string => isStr(n) && n.trim() !== '') : [])

function parseWeekly(raw: unknown): WeeklyReviewOut | null {
  if (!isObj(raw) || !isStr(raw.week_start) || !ISO_DAY.test(raw.week_start) || !isStr(raw.week_end) || !ISO_DAY.test(raw.week_end)) return null
  if (!isCount(raw.sessions)) return null
  const top: TagTrend[] = []
  if (Array.isArray(raw.top_tags)) {
    for (const t of raw.top_tags) {
      if (!isObj(t) || !isStr(t.name) || t.name.trim() === '') continue
      top.push({ name: t.name, count: isCount(t.count) ? t.count : 0, prev_count: isCount(t.prev_count) ? t.prev_count : 0 })
    }
  }
  const prev = isCount(raw.prev_sessions) ? raw.prev_sessions : 0
  return {
    week_start: raw.week_start,
    week_end: raw.week_end,
    tz: isStr(raw.tz) ? raw.tz : '',
    sessions: raw.sessions,
    prev_sessions: prev,
    delta: typeof raw.delta === 'number' && Number.isInteger(raw.delta) ? raw.delta : raw.sessions - prev,
    top_tags: top,
    recurring_tags: names(raw.recurring_tags),
    new_tags: names(raw.new_tags),
    faded_tags: names(raw.faded_tags),
  }
}

function parseDraft(raw: unknown): SummaryDraftOut | null {
  if (!isObj(raw) || !isStr(raw.title) || !Array.isArray(raw.bullets)) return null
  const bullets = raw.bullets.filter(isStr)
  if (bullets.length === 0) return null
  return { title: raw.title, bullets, tags: Array.isArray(raw.tags) ? raw.tags.filter(isStr) : [] }
}

// ── Transport ────────────────────────────────────────────────────────────────────────────────

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** The RequestInit every call uses. Exported for the guard test (§5.1). */
export function requestInit(method: string, accept: string, body: unknown, signal: AbortSignal | undefined): RequestInit {
  const headers: Record<string, string> = { Accept: accept }
  if (UNSAFE.has(method) || body !== undefined) headers['Content-Type'] = 'application/json'
  const init: RequestInit = {
    method,
    headers,
    credentials: 'same-origin',
    referrerPolicy: 'same-origin',
    cache: 'no-store',
  }
  if (body !== undefined) init.body = JSON.stringify(body)
  if (signal !== undefined) init.signal = signal
  return init
}

function abortCode(signal: AbortSignal | undefined): 'timeout' | 'aborted' | null {
  if (signal === undefined || !signal.aborted) return null
  return signal.reason === 'timeout' ? 'timeout' : 'aborted'
}

export function createApi(deps: ApiDeps): Api {
  // Called detached, never as `deps.fetch(…)`: a browser's fetch throws "Illegal invocation" when
  // its receiver is not the global object.
  const fetchFn = deps.fetch
  const now = deps.now ?? (() => Date.now())

  async function call<T>(
    method: string,
    path: string,
    opts: Readonly<{ body?: unknown; signal?: AbortSignal; parse: ((raw: unknown) => T | null) | 'empty' }>,
  ): Promise<ApiResult<T>> {
    let res: Response
    try {
      res = await fetchFn(API_BASE + path, requestInit(method, 'application/json', opts.body, opts.signal))
    } catch {
      return { ok: false, error: clientError(abortCode(opts.signal) ?? 'network') }
    }
    const requestId = res.headers.get('x-request-id')
    if (!res.ok) return { ok: false, error: await fromResponse(res, now()) }
    const meta = { status: res.status, requestId, date: res.headers.get('date') }
    if (opts.parse === 'empty') {
      try {
        await res.body?.cancel()
      } catch {
        // Nothing to read on a 204.
      }
      return { ok: true, data: null as T, ...meta }
    }
    let text: string
    try {
      text = await res.text()
    } catch {
      return { ok: false, error: clientError(abortCode(opts.signal) ?? 'network', { status: res.status, requestId }) }
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return { ok: false, error: clientError('internal', { status: res.status, requestId }) }
    }
    const data = opts.parse(raw)
    if (data === null) return { ok: false, error: clientError('internal', { status: res.status, requestId }) }
    return { ok: true, data, ...meta }
  }

  return {
    me: (signal) => call('GET', '/me', { signal, parse: parseMe }),
    consents: (signal) => call('GET', '/consents', { signal, parse: parseConsents }),
    grant: (body, signal) =>
      call('POST', '/consents', { body: grantBody(body.policy_version, body.kinds), signal, parse: parseConsents }),
    revoke: (kind, signal) => call('DELETE', `/consents/${encodeURIComponent(kind)}`, { signal, parse: parseConsents }),
    scenarios: (signal) => call('GET', '/scenarios', { signal, parse: parseScenarios }),
    summaries: (query, signal) => call('GET', summariesPath(query), { signal, parse: parseSummaryList }),
    turn: (body, signal) =>
      fetchFn(
        `${API_BASE}/chat/turn`,
        requestInit('POST', 'text/event-stream', turnBody(body.scenario, body.messages, body.revisit_summary_ids ?? []), signal),
      ),
    summarize: (body, signal) =>
      call('POST', '/chat/summarize', { body: summarizeBody(body.scenario, body.messages), signal, parse: parseDraft }),
    saveSummary: (body, signal) => call('POST', '/summaries', { body: summaryBody(body), signal, parse: parseSummary }),
    patchSummary: (id, body, signal) =>
      call('PATCH', `/summaries/${encodeURIComponent(id)}`, { body: patchBody(body), signal, parse: parseSummary }),
    deleteSummary: (id, signal) => call('DELETE', `/summaries/${encodeURIComponent(id)}`, { signal, parse: 'empty' }),
    tags: (signal) => call('GET', '/tags', { signal, parse: parseTagCounts }),
    weekly: (query, signal) => call('GET', weeklyPath(query), { signal, parse: parseWeekly }),
    deleteMe: (signal) => call('DELETE', '/me', { signal, parse: 'empty' }),
    logout: (signal) => call('POST', '/auth/logout', { signal, parse: 'empty' }),
    helplines: (signal) => call('GET', '/helplines', { signal, parse: sanitizeHelplines }),
  }
}
