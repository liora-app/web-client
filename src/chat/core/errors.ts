// API errors → one typed value the state machine reads (spec §4.1).
//
// - The body is read as text and parsed in a try: Caddy's own 502/504 have an empty body and a
//   proxy may answer with HTML, so JSON is never assumed.
// - `error.message` (English, for developers) is never kept: the person sees text from the
//   client dictionary, chosen by `code`.
// - `details` are reduced to the fields the client needs; a crisis payload goes through the
//   helplines sanitizer before it leaves this module.

import { sanitizeHelplines, type SafeHelplines } from './helplines'
import { CONSENT_KINDS, type ConsentKind } from './types'

/** Codes the client gives to failures that carry no server code. */
export type ClientCode =
  | 'network' //         fetch rejected before any response (offline, DNS, reset)
  | 'timeout' //         our own deadline (boot 15 s, summarize 150 s)
  | 'aborted' //         the person (or the page) cancelled the request
  | 'headers_timeout' // turn: 35 s without response headers
  | 'truncated' //       turn: the stream ended without a final event, twice
  | 'empty_reply' //     turn: `done` without any visible text
  | 'internal' //        a 200 that is not what the contract promises (HTML instead of SSE/JSON)

export type ApiError = Readonly<{
  /** HTTP status; 0 when no response arrived. */
  status: number
  /** Server `error.code`, else derived from the status (§4.1 table), else a ClientCode. */
  code: string
  requestId: string | null
  retryAfterMs: number | null
  /** consent_required: the kinds the server says are missing. */
  missing: readonly ConsentKind[] | null
  /** consent_required / policy_outdated: the policy version the server is on now. */
  policyVersion: string | null
  /** crisis_stop: always set for that code (the fallback when the payload is broken). */
  helplines: SafeHelplines | null
  /** validation_error: `details[].field` paths such as "bullets.2" or "tags.0.name". */
  fields: readonly string[]
}>

/** What a screen keeps about a failure: a code to pick the text by, and nothing from the server's
 *  prose. */
export type UiError = Readonly<{
  code: string
  status: number | null
  requestId: string | null
  retryAfterMs: number | null
  fields: readonly string[]
}>

export const DEFAULT_BUSY_RETRY_MS = 5_000
const MIN_RETRY_MS = 1_000
const MAX_RETRY_MS = 60_000

export function codeForStatus(status: number): string {
  switch (status) {
    case 400:
      return 'bad_request'
    case 401:
      return 'unauthenticated'
    case 403:
      return 'forbidden'
    case 404:
      return 'not_found'
    case 405:
      return 'method_not_allowed'
    case 413:
      return 'payload_too_large'
    case 502:
    case 503:
    case 504:
      return 'upstream_unavailable'
    default:
      return 'http_error'
  }
}

/** `Retry-After` in ms, clamped to [1 s, 60 s]. A header that is neither whole seconds nor an
 *  HTTP date counts as absent; absent means 5 s for llm_busy and null for everything else. */
export function retryAfterMs(header: string | null, code: string, now: number): number | null {
  const value = header?.trim() ?? ''
  let ms: number | null = null
  if (/^\d+$/.test(value)) {
    ms = Number(value) * 1000
  } else if (/^[A-Za-z]{3}/.test(value)) {
    // HTTP-date ("Wed, 07 Oct 2026 12:00:05 GMT"). The leading letters keep Date.parse from
    // reading "1.5" or "-5" as dates.
    const at = Date.parse(value)
    if (Number.isFinite(at)) ms = at - now
  }
  if (ms === null || !Number.isFinite(ms)) return code === 'llm_busy' ? DEFAULT_BUSY_RETRY_MS : null
  return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, ms))
}

export function clientError(code: ClientCode, init: Partial<Pick<ApiError, 'status' | 'requestId'>> = {}): ApiError {
  return {
    status: init.status ?? 0,
    code,
    requestId: init.requestId ?? null,
    retryAfterMs: null,
    missing: null,
    policyVersion: null,
    helplines: null,
    fields: [],
  }
}

type Envelope = Readonly<{ code: string; details: unknown }>

function parseEnvelope(text: string): Envelope | null {
  if (text.trim() === '') return null
  try {
    const raw: unknown = JSON.parse(text)
    if (typeof raw !== 'object' || raw === null) return null
    const error = (raw as Record<string, unknown>).error
    if (typeof error !== 'object' || error === null) return null
    const code = (error as Record<string, unknown>).code
    if (typeof code !== 'string' || code === '') return null
    return { code, details: (error as Record<string, unknown>).details }
  } catch {
    return null
  }
}

function field(details: unknown, name: string): unknown {
  return typeof details === 'object' && details !== null && !Array.isArray(details)
    ? (details as Record<string, unknown>)[name]
    : undefined
}

function kinds(value: unknown): readonly ConsentKind[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((k): k is ConsentKind => (CONSENT_KINDS as readonly unknown[]).includes(k))
}

function fieldPaths(details: unknown): readonly string[] {
  if (!Array.isArray(details)) return []
  const out: string[] = []
  for (const d of details) {
    const f = field(d, 'field')
    if (typeof f === 'string') out.push(f)
  }
  return out
}

/** Never throws: an unreadable body is an empty body. */
export async function fromResponse(res: Response, now: number = Date.now()): Promise<ApiError> {
  let text = ''
  try {
    text = await res.text()
  } catch {
    text = ''
  }
  const envelope = parseEnvelope(text)
  const code = envelope?.code ?? codeForStatus(res.status)
  const details = envelope?.details
  const version = field(details, 'policy_version')
  return {
    status: res.status,
    code,
    requestId: res.headers.get('x-request-id'),
    retryAfterMs: retryAfterMs(res.headers.get('retry-after'), code, now),
    missing: code === 'consent_required' ? kinds(field(details, 'missing')) : null,
    policyVersion: typeof version === 'string' ? version : null,
    helplines: code === 'crisis_stop' ? sanitizeHelplines(field(details, 'helplines')) : null,
    fields: code === 'validation_error' ? fieldPaths(details) : [],
  }
}

export function toUiError(error: ApiError): UiError {
  return {
    code: error.code,
    status: error.status === 0 ? null : error.status,
    requestId: error.requestId,
    retryAfterMs: error.retryAfterMs,
    fields: error.fields,
  }
}

export function uiError(code: string, init: Partial<UiError> = {}): UiError {
  return {
    code,
    status: init.status ?? null,
    requestId: init.requestId ?? null,
    retryAfterMs: init.retryAfterMs ?? null,
    fields: init.fields ?? [],
  }
}

/** Network failure, our own timeout, or a gateway that answered without a body: the request may
 *  or may not have reached the server. */
export function outcomeUnknown(error: ApiError): boolean {
  return error.status === 0 || (error.status >= 500 && error.code === 'upstream_unavailable')
}
