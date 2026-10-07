// The /chat/ state machine (spec §2): reduce(model, action) → [model, effects].
//
// Pure: no I/O, no timers, no clock. Effects (requests, aborts, timers, navigation) are data that
// src/chat/ui/effects.ts executes; time comes in with the actions that need it. Every invariant of
// §2.6 that the core can hold is held here and tested in tests/e2e/chat-core.spec.ts:
//   I1 the transcript lives only in the state (nothing here stores, logs or serialises it);
//   I2 at most one LLM request in flight; I3 a partial answer joins `messages` only on `done`;
//   I4 every retry sends the frozen request; I5 no way back from `crisis` into its conversation;
//   I6 a new screen closes every overlay; I7 leaveGuard(); I9 turnBody()/summarizeBody() in api.ts.

import { GOOGLE_START, grantBody, summarizeBody, turnBody } from './api'
import { DEFAULT_BUSY_RETRY_MS, outcomeUnknown, toUiError, uiError, type ApiError, type UiError } from './errors'
import { FALLBACK, type SafeHelplines } from './helplines'
import {
  MAX_CONTENT,
  MAX_QUERY,
  MAX_REVISIT_IDS,
  canSend,
  checkMessage,
  clampCodePoints,
  draftFromOut,
  normalize,
  validateDraft,
  type Draft,
  type DraftBody,
  type DraftIssue,
} from './limits'
import { BOOT_TIMEOUT, MAX_BUSY_RETRIES, SUMMARIZE_TIMEOUT, type TurnOutcome } from './turn'
import {
  CONSENT_KINDS,
  type ChatMessage,
  type ConsentGrantIn,
  type ConsentKind,
  type ConsentState,
  type MeOut,
  type ScenarioId,
  type ScenarioOut,
  type SummarizeRequest,
  type SummaryCreate,
  type SummaryDraftOut,
  type SummaryList,
  type SummaryOut,
  type TurnRequest,
} from './types'

// ── Constants ─────────────────────────────────────────────────────────────────────────────────

/** 429 without a usable Retry-After: the server counts turns per minute. */
export const RATE_LIMIT_FALLBACK_MS = 60_000
/** A record counts as "ours" after an unknown save result only if it is this fresh (§7.3). */
export const SAVE_MATCH_WINDOW_MS = 2 * 60_000

export const AUTH_CODES = ['access_denied', 'state_mismatch', 'expired', 'server_error', 'auth_unavailable', 'not_invited'] as const
export type AuthCode = (typeof AUTH_CODES)[number] | 'unknown'

/** The contract's `free` scenario: the conversation still opens when GET /scenarios fails (§3.6). */
export const FALLBACK_SCENARIO: ScenarioOut = Object.freeze({
  id: 'free',
  title: 'Вільна розмова',
  description: '',
  opening_message: 'Про що вам хочеться поговорити сьогодні?',
  needs_summaries: false,
})

// ── State ────────────────────────────────────────────────────────────────────────────────────

export type Msg = ChatMessage

export type Session = Readonly<{
  scenario: ScenarioId
  /** 1..5 ids ⇔ scenario === 'revisit' once a turn goes out; [] otherwise. */
  revisitIds: readonly string[]
  /** Confirmed messages only; [0] is the scenario's opening_message as 'assistant'. */
  messages: readonly Msg[]
  /** «Не зберігати цю розмову»: no POST /summaries for this conversation. */
  noSave: boolean
  /** Indices in `messages` of AI replies the model cut by length (finish_reason "length"). */
  cut: readonly number[]
}>

/** The person's message that is not in `messages` yet. */
export type Pending = Readonly<{
  text: string
  /** The frozen request it went out with: every retry sends exactly this (I4). */
  request: readonly Msg[]
  status: 'sending' | 'failed' | 'stopped'
  error: UiError | null
}>

/** What to repeat after the consent screen; the turn keeps its frozen body (I4). */
export type Resume =
  | Readonly<{ kind: 'turn'; request: readonly Msg[]; revisitIds: readonly string[] }>
  | Readonly<{ kind: 'summarize' }>
  | Readonly<{ kind: 'save'; draft: Draft }>

export type TurnPhase =
  | Readonly<{ p: 'idle' }>
  | Readonly<{ p: 'waiting'; id: number; stage: 'headers' | 'meta'; request: readonly Msg[]; trunc: 0 | 1; busy: 0 | 1 | 2 }>
  | Readonly<{ p: 'streaming'; id: number; partial: string; request: readonly Msg[]; trunc: 0 | 1; busy: 0 | 1 | 2 }>
  | Readonly<{ p: 'busy-wait'; id: number; until: number; request: readonly Msg[]; trunc: 0 | 1; busy: 1 | 2 }>
  | Readonly<{ p: 'cooldown'; until: number }>

export type AuthNotice =
  | Readonly<{ kind: 'auth-error'; code: AuthCode }>
  | Readonly<{ kind: 'logged-out' }>
  /** DELETE /me answered 401 on the first attempt: sign in again to delete (§3.3). */
  | Readonly<{ kind: 'delete-relogin' }>

export type ChatNotice =
  | Readonly<{ kind: 'need-records' }> // revisit without chosen records
  | Readonly<{ kind: 'too-long'; length: number }> // over 4000 code points
  | Readonly<{ kind: 'unsent' }> // a new message while an unsent one waits for «Надіслати ще раз» / «Змінити»
  | Readonly<{ kind: 'too-large' }> // 413: the block replaces the composer
  | Readonly<{ kind: 'revisit-gone' }> // 404 and the diary is empty now

export type ConsentMode = 'first' | 'update' | 'resume'

export type State =
  | Readonly<{ s: 'booting' }>
  | Readonly<{ s: 'signed-out'; variant: 'fresh' | 'logged-out'; notice: AuthNotice | null }>
  | Readonly<{ s: 'not-invited'; hasSession: boolean; stale: Session | null; pending: Pending | null; draft: Draft | null }>
  | Readonly<{
      s: 'consent'
      mode: ConsentMode
      policyChanged: boolean
      session: Session | null
      pending: Pending | null
      resume: Resume | null
      error: UiError | null
      /** A fresh GET /consents is on its way; the boxes wait for it. */
      loading: boolean
      /** ctx.consents is a valid source for the boxes, the version and the POST body: boot or
       *  DELETE /consents data in `first`, a fresh GET in `update` and `resume` (§3.5). False until
       *  that GET answers, and again after a 409: «Погоджуюся» then asks for it instead of POSTing
       *  stale data. */
      fresh: boolean
      submitting: boolean
      /** Bumped when the boxes must be reset from ctx.consents (fresh data, 409). */
      epoch: number
    }>
  | Readonly<{
      s: 'chat'
      session: Session
      turn: TurnPhase
      pending: Pending | null
      notice: ChatNotice | null
      /** Where the scenario goes back to when the record picker closes with nothing chosen. */
      revertTo: ScenarioId
    }>
  | Readonly<{ s: 'session-expired'; stale: Session; pending: Pending | null; draft: Draft | null }>
  | Readonly<{ s: 'crisis'; helplines: SafeHelplines; stale: readonly Msg[] }>
  | Readonly<{
      s: 'summarizing'
      session: Session
      /** The unsent message of the conversation: it comes back with «Повернутися до розмови». */
      pending: Pending | null
      id: number
      /** Automatic llm_busy retries so far. While `error` is null and `busy` > 0, the retry is
       *  scheduled for `until` (or already running): that is the countdown, not an error, and
       *  nothing else may start (I2). */
      busy: 0 | 1 | 2
      /** With `error` rate_limited: the manual retry waits until then. */
      until: number | null
      /** Final: only a manual retry, «Повернутися до розмови» or «Завершити без тез». */
      error: UiError | null
    }>
  | Readonly<{
      s: 'review'
      session: Session
      pending: Pending | null
      draft: Draft
      /** `unknown`: the last POST may have landed. The draft is read-only until the retry has
       *  looked at the newest record (§7.3), so the check compares with the body that went out. */
      saving: 'idle' | 'saving' | 'unknown'
      error: UiError | null
      issues: readonly DraftIssue[]
      /** The last body sent, with its index tables for a 422 (§7.2). */
      sent: DraftBody | null
      id: number
    }>
  | Readonly<{ s: 'saved'; summary: SummaryOut }>
  | Readonly<{ s: 'ended' }>
  | Readonly<{ s: 'account-deleted'; variant: 'confirmed' | 'presumed' }>
  | Readonly<{ s: 'fatal'; error: UiError }>

export type ScreenName = State['s']
type On<S extends ScreenName> = Extract<State, { s: S }>
export type ChatState = On<'chat'>
export type ConsentScreen = On<'consent'>
export type ReviewState = On<'review'>
export type SummarizingState = On<'summarizing'>

export type Loadable<T> =
  | Readonly<{ status: 'idle' }>
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'ok'; value: T }>
  | Readonly<{ status: 'failed' }>

export type Diary = Readonly<{ items: readonly SummaryOut[]; nextCursor: string | null }>

/** Page data outside State.s (§2.3). */
export type Ctx = Readonly<{
  me: MeOut | null
  consents: ConsentState | null
  scenarios: Loadable<readonly ScenarioOut[]>
  diary: Loadable<Diary>
  /** For the help dialog: GET /helplines once per page view, sanitized. */
  helplines: Loadable<SafeHelplines>
  afterCrisis: boolean
  /** Whitelisted ?auth_error, kept until GET /me answers. */
  authError: AuthCode | null
  /** «Новий вхід не відбувся…» over the next screen: ?auth_error came, but GET /me said 200. */
  authNotice: Readonly<{ code: AuthCode; email: string }> | null
  /** Open a new conversation as soon as GET /scenarios settles. */
  wantChat: boolean
  /** Last request id handed out; results with another id are stale and ignored. */
  seq: number
  /** 403 csrf_failed so far: the first gets «Спробуйте ще раз», a repeat «Оновіть сторінку». */
  csrfFailures: number
  /** DELETE /me already went out once with an unknown result (§8.5). */
  deleteAttempt: 'none' | 'unknown'
  /** The account operation in progress or failed (shown in its dialog or next to its button). */
  op: Readonly<{ name: 'logout' | 'delete-account' | 'revoke'; busy: boolean; error: UiError | null }> | null
}>

export type ConfirmKind =
  | 'end'
  | 'end-no-theses'
  | 'discard'
  | 'regenerate'
  | 'leave'
  | 'relogin'
  | 'logout'
  | 'new-after-crisis'
  | 'delete-account'
  | 'revoke'

export type PickOverlay = Readonly<{
  o: 'revisit-pick'
  selected: readonly string[]
  list: Diary | null
  loading: boolean
  failed: boolean
  q: string
  /** Reopened after a 404: «Одного з обраних записів уже немає…». */
  gone: boolean
  /** Scenario to restore when it closes with nothing chosen; null once the conversation runs. */
  revertTo: ScenarioId | null
}>

export type Overlay =
  | Readonly<{ o: 'account' }>
  | Readonly<{ o: 'help' }>
  | PickOverlay
  | Readonly<{
      o: 'confirm'
      kind: ConfirmKind
      revoke: ConsentKind | null
      leaveTo: 'home' | 'reload' | null
      /** end-no-theses opened from end: «Назад» goes back to end. */
      back: boolean
    }>

export type Model = Readonly<{ state: State; ctx: Ctx; overlay: readonly Overlay[] }>

export const INITIAL_CTX: Ctx = Object.freeze<Ctx>({
  me: null,
  consents: null,
  scenarios: { status: 'idle' },
  diary: { status: 'idle' },
  helplines: { status: 'idle' },
  afterCrisis: false,
  authError: null,
  authNotice: null,
  wantChat: false,
  seq: 0,
  csrfFailures: 0,
  deleteAttempt: 'none',
  op: null,
})

export const INITIAL_MODEL: Model = Object.freeze<Model>({ state: { s: 'booting' }, ctx: INITIAL_CTX, overlay: [] })

// ── Actions and effects ──────────────────────────────────────────────────────────────────────

type Purpose = 'boot' | 'pageshow'

export type Action =
  // boot and page data
  | Readonly<{ type: 'boot'; search: string }>
  | Readonly<{ type: 'me/ok'; purpose: Purpose; me: MeOut }>
  | Readonly<{ type: 'me/fail'; purpose: Purpose; error: ApiError }>
  | Readonly<{ type: 'consents/ok'; purpose: 'boot' | 'fresh'; consents: ConsentState }>
  | Readonly<{ type: 'consents/fail'; purpose: 'boot' | 'fresh'; error: ApiError }>
  | Readonly<{ type: 'scenarios/ok'; items: readonly ScenarioOut[] }>
  | Readonly<{ type: 'scenarios/fail'; error: ApiError }>
  | Readonly<{ type: 'scenarios/retry' }>
  | Readonly<{ type: 'diary/ok'; diary: Diary }>
  | Readonly<{ type: 'diary/fail'; error: ApiError }>
  | Readonly<{ type: 'diary/retry' }>
  | Readonly<{ type: 'helplines/ok'; helplines: SafeHelplines }>
  | Readonly<{ type: 'helplines/fail' }>
  | Readonly<{ type: 'page/show'; persisted: boolean }>
  // consent
  | Readonly<{ type: 'consent/agree'; checked: readonly ConsentKind[] }>
  | Readonly<{ type: 'consent/reload' }>
  | Readonly<{ type: 'grant/ok'; consents: ConsentState }>
  | Readonly<{ type: 'grant/fail'; error: ApiError }>
  // conversation
  | Readonly<{ type: 'chat/scenario'; id: ScenarioId }>
  | Readonly<{ type: 'chat/no-save'; on: boolean }>
  | Readonly<{ type: 'chat/send'; text: string }>
  | Readonly<{ type: 'chat/resend' }>
  | Readonly<{ type: 'chat/edit' }>
  | Readonly<{ type: 'chat/stop' }>
  | Readonly<{ type: 'chat/start-free' }>
  | Readonly<{ type: 'chat/summarize' }>
  | Readonly<{ type: 'chat/new' }>
  | Readonly<{ type: 'turn/meta'; id: number }>
  | Readonly<{ type: 'turn/token'; id: number; text: string }>
  | Readonly<{ type: 'turn/reset'; id: number }>
  | Readonly<{ type: 'turn/busy-wait'; id: number; until: number; retry: 1 | 2 }>
  | Readonly<{ type: 'turn/retry'; id: number; cause: 'truncated' | 'busy'; attempt: number }>
  | Readonly<{ type: 'turn/outcome'; id: number; outcome: TurnOutcome; now: number }>
  | Readonly<{ type: 'cooldown/end'; until: number }>
  // record picker («Повернення до теми»)
  | Readonly<{ type: 'revisit/open' }>
  | Readonly<{ type: 'revisit/toggle'; id: string }>
  | Readonly<{ type: 'revisit/search'; q: string }>
  | Readonly<{ type: 'revisit/more' }>
  | Readonly<{ type: 'revisit/list-ok'; purpose: 'pick' | 'pick-404'; q: string; cursor: string | null; diary: Diary }>
  | Readonly<{ type: 'revisit/list-fail'; purpose: 'pick' | 'pick-404'; q: string; cursor: string | null; error: ApiError }>
  | Readonly<{ type: 'revisit/confirm' }>
  // theses
  | Readonly<{ type: 'summarize/ok'; id: number; draft: SummaryDraftOut }>
  | Readonly<{ type: 'summarize/fail'; id: number; error: ApiError; now: number }>
  | Readonly<{ type: 'summarize/cancel' }>
  | Readonly<{ type: 'summarize/retry'; now: number }>
  | Readonly<{ type: 'review/update'; draft: Draft }>
  | Readonly<{ type: 'review/save' }>
  | Readonly<{ type: 'review/done' }>
  | Readonly<{ type: 'review/back' }>
  | Readonly<{ type: 'save/ok'; id: number; summary: SummaryOut }>
  | Readonly<{ type: 'save/fail'; id: number; error: ApiError }>
  | Readonly<{ type: 'save/check'; id: number; list: SummaryList; date: string | null }>
  | Readonly<{ type: 'save/check-fail'; id: number; error: ApiError }>
  // overlays and the account
  | Readonly<{ type: 'overlay/open'; overlay: 'account' | 'help' }>
  | Readonly<{ type: 'confirm/open'; kind: ConfirmKind; revoke?: ConsentKind; leaveTo?: 'home' | 'reload' }>
  | Readonly<{ type: 'confirm/switch'; kind: 'end' | 'end-no-theses' }>
  | Readonly<{ type: 'confirm/accept'; choice?: 'summarize' }>
  | Readonly<{ type: 'overlay/close' }>
  | Readonly<{ type: 'account/logout' }>
  | Readonly<{ type: 'logout/ok' }>
  | Readonly<{ type: 'logout/fail'; error: ApiError }>
  | Readonly<{ type: 'delete/ok' }>
  | Readonly<{ type: 'delete/fail'; error: ApiError }>
  | Readonly<{ type: 'revoke/ok'; kind: ConsentKind; consents: ConsentState }>
  | Readonly<{ type: 'revoke/fail'; kind: ConsentKind; error: ApiError }>

export type Effect =
  | Readonly<{ type: 'url/clean' }> // history.replaceState(null, '', '/chat/')
  | Readonly<{ type: 'me'; purpose: Purpose; timeoutMs: number }>
  | Readonly<{ type: 'consents'; purpose: 'boot' | 'fresh' }>
  | Readonly<{ type: 'scenarios' }>
  | Readonly<{ type: 'diary' }> // GET /summaries?limit=20
  | Readonly<{ type: 'pick-list'; purpose: 'pick' | 'pick-404'; q: string; cursor: string | null }>
  | Readonly<{ type: 'helplines' }>
  | Readonly<{ type: 'turn'; id: number; body: TurnRequest }> // runTurn
  | Readonly<{ type: 'summarize'; id: number; body: SummarizeRequest; delayMs: number; timeoutMs: number }>
  | Readonly<{ type: 'save'; id: number; body: SummaryCreate }>
  | Readonly<{ type: 'save-check'; id: number }> // GET /summaries?limit=1 before a second POST
  | Readonly<{ type: 'grant'; body: ConsentGrantIn }>
  | Readonly<{ type: 'revoke'; kind: ConsentKind }>
  | Readonly<{ type: 'logout' }>
  | Readonly<{ type: 'delete-me' }>
  | Readonly<{ type: 'abort'; target: 'turn' | 'summarize' | 'all' }> // reason 'user'
  | Readonly<{ type: 'after'; ms: number; action: Action }>
  | Readonly<{ type: 'navigate'; href: string }> // drops the leave guard first
  | Readonly<{ type: 'reload' }>
  | Readonly<{ type: 'composer'; text: string }> // put text back into the message field
  | Readonly<{ type: 'announcer/clear' }> // empty [data-announcer] (§5.7)

export type Step = readonly [Model, readonly Effect[]]

// ── Queries the screens use ──────────────────────────────────────────────────────────────────

export function authErrorFrom(search: string): AuthCode | null {
  let raw: string | null
  try {
    raw = new URLSearchParams(search).get('auth_error')
  } catch {
    return null
  }
  if (raw === null) return null
  return (AUTH_CODES as readonly string[]).includes(raw) ? (raw as AuthCode) : 'unknown'
}

export function hasUserMessage(session: Session | null, pending: Pending | null): boolean {
  return pending !== null || (session !== null && session.messages.some((m) => m.role === 'user'))
}

/** An AI reply to the person exists (the opening message does not count). */
export function hasReply(session: Session): boolean {
  return session.messages.some((m, i) => i > 0 && m.role === 'assistant')
}

/** I7: something would be lost by leaving the page. */
export function leaveGuard(state: State): boolean {
  switch (state.s) {
    case 'chat':
      return hasUserMessage(state.session, state.pending)
    case 'summarizing':
      return hasUserMessage(state.session, state.pending)
    case 'review':
      return true
    case 'consent':
      return hasUserMessage(state.session, state.pending) || state.resume?.kind === 'save'
    case 'session-expired':
      return hasUserMessage(state.stale, state.pending) || state.draft !== null
    case 'not-invited':
      return hasUserMessage(state.stale, state.pending) || state.draft !== null
    default:
      return false
  }
}

/** I2: a turn or a summarize is in flight (or waiting for its automatic retry). */
export function llmInFlight(state: State): boolean {
  if (state.s === 'chat') return state.turn.p === 'waiting' || state.turn.p === 'streaming' || state.turn.p === 'busy-wait'
  // `error` is set only once no automatic retry is left: the llm_busy countdown keeps it null.
  if (state.s === 'summarizing') return state.error === null
  return false
}

/** «Надіслати» would start a turn right now. */
export function canSendNow(state: ChatState): boolean {
  const { session } = state
  return (
    state.turn.p === 'idle' &&
    state.pending === null &&
    canSend(session.messages.length) &&
    !(session.scenario === 'revisit' && session.revisitIds.length === 0) &&
    state.notice?.kind !== 'too-large' &&
    state.notice?.kind !== 'revisit-gone'
  )
}

/** Scenarios the switcher offers: the server's list, or only `free` when it did not load. */
export function scenariosOf(ctx: Ctx): readonly ScenarioOut[] {
  return ctx.scenarios.status === 'ok' ? ctx.scenarios.value : [FALLBACK_SCENARIO]
}

/** After an unknown save result: is the newest record the one we sent? (§7.3) */
export function matchesSaved(body: SummaryCreate, item: SummaryOut, dateHeader: string | null): boolean {
  if (item.scenario !== body.scenario || item.title.trim() !== body.title.trim()) return false
  const bullets = item.bullets.map((b) => b.trim())
  if (bullets.length !== body.bullets.length || bullets.some((b, i) => b !== body.bullets[i]?.trim())) return false
  // Tag names as the server de-duplicates them: a tag that already exists comes back under its
  // stored name («робота» for «Робота», «пам'ять» for «памʼять»).
  const mine = new Set(body.tags.map((t) => normalize(t.name)))
  const theirs = new Set(item.tags.map((t) => normalize(t.name)))
  if (mine.size !== theirs.size || [...mine].some((n) => !theirs.has(n))) return false
  if (dateHeader !== null) {
    const serverNow = Date.parse(dateHeader)
    const created = Date.parse(item.created_at)
    if (Number.isFinite(serverNow) && Number.isFinite(created) && serverNow - created > SAVE_MATCH_WINDOW_MS) return false
  }
  return true
}

// ── Reducer ──────────────────────────────────────────────────────────────────────────────────

const NONE: readonly Effect[] = Object.freeze([])
const IDLE: TurnPhase = Object.freeze({ p: 'idle' })

function freezeMessages(messages: readonly Msg[]): readonly Msg[] {
  return Object.freeze(messages.map((m) => Object.freeze({ role: m.role, content: m.content })))
}

function scenarioById(ctx: Ctx, id: ScenarioId): ScenarioOut | undefined {
  return scenariosOf(ctx).find((s) => s.id === id) ?? (id === 'free' ? FALLBACK_SCENARIO : undefined)
}

function freshSession(ctx: Ctx, scenario: ScenarioId, noSave: boolean): Session {
  const chosen = scenarioById(ctx, scenario) ?? FALLBACK_SCENARIO
  return Object.freeze({
    scenario: chosen.id,
    revisitIds: Object.freeze([]),
    messages: freezeMessages([{ role: 'assistant', content: chosen.opening_message }]),
    noSave,
    cut: Object.freeze([]),
  })
}

function chat(session: Session, init: Partial<Omit<ChatState, 's' | 'session'>> = {}): ChatState {
  return { s: 'chat', session, turn: IDLE, pending: null, notice: null, revertTo: 'free', ...init }
}

function consent(mode: ConsentMode, init: Partial<Omit<ConsentScreen, 's' | 'mode'>> = {}): ConsentScreen {
  return {
    s: 'consent',
    mode,
    policyChanged: false,
    session: null,
    pending: null,
    resume: null,
    error: null,
    loading: false,
    fresh: false,
    submitting: false,
    epoch: 0,
    ...init,
  }
}

/** Back to the conversation from the theses, the unsent message with it (§7.1 «Розмова на
 *  місці»). After a 413 the block comes back too: the same message would get the same 413. */
function backToChat(session: Session, pending: Pending | null): ChatState {
  return chat(session, { pending, notice: pending?.error?.code === 'payload_too_large' ? { kind: 'too-large' } : null })
}

const loaded = <T>(value: T): Loadable<T> => ({ status: 'ok', value })
const EMPTY_DIARY: Loadable<Diary> = Object.freeze({ status: 'ok', value: Object.freeze({ items: [], nextCursor: null }) })

function withState(model: Model, state: State, effects: readonly Effect[] = NONE): Step {
  return [{ ...model, state }, effects]
}

function lastUserText(request: readonly Msg[]): string {
  for (let i = request.length - 1; i >= 0; i--) if (request[i]!.role === 'user') return request[i]!.content
  return ''
}

/** A new, empty conversation (§3.6). Clears the announcer when it replaces an old one. */
function startChat(model: Model, init: Readonly<{ afterCrisis?: boolean; wipe?: boolean }> = {}): Step {
  const ctx: Ctx = { ...model.ctx, wantChat: false, afterCrisis: init.afterCrisis ?? model.ctx.afterCrisis }
  const state = chat(freshSession(ctx, 'free', false))
  return [{ ...model, ctx, state }, init.wipe === true ? [{ type: 'announcer/clear' }] : NONE]
}

/** Opens the conversation once GET /scenarios has settled (success or failure, §2.4). */
function startWhenReady(model: Model): Step {
  const { state, ctx } = model
  const settled = ctx.scenarios.status === 'ok' || ctx.scenarios.status === 'failed'
  if (!ctx.wantChat || !settled) return [model, NONE]
  if (state.s === 'booting') return startChat(model)
  if (state.s === 'consent' && state.submitting && state.mode !== 'resume') return startChat(model)
  return [model, NONE]
}

function beginTurn(
  model: Model,
  base: ChatState,
  request: readonly Msg[],
  text: string,
  revisitIds: readonly string[],
): Step {
  const { session } = base
  if (session.scenario === 'revisit' && revisitIds.length === 0) {
    return withState(model, { ...base, turn: IDLE, notice: { kind: 'need-records' } })
  }
  const id = model.ctx.seq + 1
  const frozen = Object.isFrozen(request) ? request : freezeMessages(request)
  const pending: Pending = { text, request: frozen, status: 'sending', error: null }
  const turn: TurnPhase = { p: 'waiting', id, stage: 'headers', request: frozen, trunc: 0, busy: 0 }
  const state: ChatState = { ...base, session: { ...session, revisitIds }, turn, pending, notice: null }
  return [
    { ...model, ctx: { ...model.ctx, seq: id }, state },
    [{ type: 'turn', id, body: turnBody(session.scenario, frozen, revisitIds) }],
  ]
}

function beginSummarize(model: Model, session: Session, pending: Pending | null): Step {
  const id = model.ctx.seq + 1
  return [
    { ...model, ctx: { ...model.ctx, seq: id }, state: { s: 'summarizing', session, pending, id, busy: 0, until: null, error: null } },
    [{ type: 'summarize', id, body: summarizeBody(session.scenario, session.messages), delayMs: 0, timeoutMs: SUMMARIZE_TIMEOUT }],
  ]
}

function beginSave(model: Model, review: ReviewState): Step {
  const check = validateDraft(review.draft, review.session.scenario)
  if (!check.ok) return withState(model, { ...review, issues: check.issues, error: null })
  const id = model.ctx.seq + 1
  const next: ReviewState = { ...review, saving: 'saving', sent: check.value, issues: [], error: null, id }
  const effect: Effect = review.saving === 'unknown' ? { type: 'save-check', id } : { type: 'save', id, body: check.value.body }
  return [{ ...model, ctx: { ...model.ctx, seq: id }, state: next }, [effect]]
}

function enterCrisis(model: Model, helplines: SafeHelplines, stale: readonly Msg[]): Step {
  return [
    { ...model, ctx: { ...model.ctx, helplines: loaded(helplines) }, state: { s: 'crisis', helplines, stale: freezeMessages(stale) } },
    [{ type: 'abort', target: 'all' }, { type: 'announcer/clear' }],
  ]
}

function enterResume(model: Model, session: Session, pending: Pending | null, resume: Resume, policyVersion: string | null): Step {
  const known = model.ctx.consents?.current_policy_version ?? null
  const policyChanged = policyVersion !== null && known !== null && policyVersion !== known
  return withState(model, consent('resume', { policyChanged, session, pending, resume, loading: true }), [
    { type: 'consents', purpose: 'fresh' },
  ])
}

/** Wipes the session and everything about the account from the page. */
function signedOut(model: Model, variant: 'fresh' | 'logged-out', notice: AuthNotice | null): Step {
  const ctx: Ctx = {
    ...model.ctx,
    me: null,
    consents: null,
    diary: { status: 'idle' },
    authNotice: null,
    wantChat: false,
    csrfFailures: 0,
    deleteAttempt: 'none',
    afterCrisis: false,
  }
  return [
    { ...model, ctx, state: { s: 'signed-out', variant, notice } },
    [{ type: 'abort', target: 'all' }, { type: 'announcer/clear' }],
  ]
}

function accountDeleted(model: Model, variant: 'confirmed' | 'presumed'): Step {
  const ctx: Ctx = { ...model.ctx, me: null, consents: null, diary: EMPTY_DIARY, authNotice: null, wantChat: false, deleteAttempt: 'none' }
  return [
    { ...model, ctx, state: { s: 'account-deleted', variant } },
    [{ type: 'abort', target: 'all' }, { type: 'announcer/clear' }],
  ]
}

/** 401 on a protected call: keep what the person wrote, read-only, when there is a session. */
function unauthenticated(model: Model, session: Session | null, pending: Pending | null, draft: Draft | null): Step {
  if (session === null) return signedOut(model, 'fresh', null)
  return withState(model, { s: 'session-expired', stale: session, pending, draft }, [{ type: 'abort', target: 'all' }])
}

function notInvited(model: Model, session: Session | null, pending: Pending | null, draft: Draft | null): Step {
  return withState(model, { s: 'not-invited', hasSession: true, stale: session, pending, draft }, [{ type: 'abort', target: 'all' }])
}

/** A screen reached with a live session (a 401 there means the session ended meanwhile). */
function signedInScreen(state: State): boolean {
  return state.s !== 'signed-out' && state.s !== 'account-deleted' && state.s !== 'fatal'
}

/** The conversation a screen holds (read-only on some of them). */
export function sessionOf(state: State): Session | null {
  switch (state.s) {
    case 'chat':
    case 'summarizing':
    case 'review':
      return state.session
    case 'consent':
      return state.session
    case 'session-expired':
    case 'not-invited':
      return state.stale
    default:
      return null
  }
}

/** The person's unsent message a screen holds. */
export function pendingOf(state: State): Pending | null {
  switch (state.s) {
    case 'chat':
    case 'consent':
    case 'summarizing':
    case 'review':
    case 'session-expired':
    case 'not-invited':
      return state.pending
    default:
      return null
  }
}

/** The draft of theses a screen holds (or the one a consent will save). */
export function draftOf(state: State): Draft | null {
  if (state.s === 'review') return state.draft
  if (state.s === 'consent') return state.resume?.kind === 'save' ? state.resume.draft : null
  if (state.s === 'session-expired' || state.s === 'not-invited') return state.draft
  return null
}

/** After a consent: repeat what the person had started, or open the conversation. */
function afterConsent(model: Model): Step {
  const { state } = model
  if (state.s !== 'consent') return [model, NONE]
  if (state.mode === 'resume' && state.resume !== null && state.session !== null) {
    const { session, resume } = state
    switch (resume.kind) {
      case 'turn': {
        const text = state.pending?.text ?? lastUserText(resume.request)
        return beginTurn(model, chat(session), resume.request, text, resume.revisitIds)
      }
      case 'summarize':
        return beginSummarize(model, session, state.pending)
      case 'save':
        return beginSave(model, {
          s: 'review',
          session,
          pending: state.pending,
          draft: resume.draft,
          saving: 'idle',
          error: null,
          issues: [],
          sent: null,
          id: 0,
        })
    }
  }
  return startWhenReady({ ...model, ctx: { ...model.ctx, wantChat: true }, state: { ...state, submitting: true, error: null } })
}

function replaceTop(model: Model, overlay: Overlay): Model {
  return { ...model, overlay: [...model.overlay.slice(0, -1), overlay] }
}

function topOverlay(model: Model): Overlay | undefined {
  return model.overlay[model.overlay.length - 1]
}

function topPick(model: Model): PickOverlay | null {
  const top = topOverlay(model)
  return top !== undefined && top.o === 'revisit-pick' ? top : null
}

function pick(init: Partial<Omit<PickOverlay, 'o'>>): PickOverlay {
  return { o: 'revisit-pick', selected: [], list: null, loading: false, failed: false, q: '', gone: false, revertTo: null, ...init }
}

function turnActive(state: State, id: number): Exclude<TurnPhase, { p: 'idle' } | { p: 'cooldown' }> | null {
  if (state.s !== 'chat') return null
  const t = state.turn
  if (t.p === 'idle' || t.p === 'cooldown' || t.id !== id) return null
  return t
}

function onTurnOutcome(model: Model, state: ChatState, outcome: TurnOutcome, now: number): Step {
  const turn = state.turn
  if (turn.p === 'idle' || turn.p === 'cooldown') return [model, NONE]
  const request = turn.request
  const pending: Pending = state.pending ?? { text: lastUserText(request), request, status: 'sending', error: null }
  const fail = (error: UiError, extra: Partial<ChatState> = {}, effects: readonly Effect[] = NONE): Step =>
    withState(model, { ...state, turn: IDLE, pending: { ...pending, status: 'failed', error }, ...extra }, effects)

  switch (outcome.kind) {
    case 'done': {
      if (outcome.text.trim() === '') return fail(uiError('empty_reply', { requestId: outcome.requestId }))
      // I3: the answer joins the history only here. Longer than 4000 code points, the screen keeps
      // it whole and the history keeps 4000, or the next turn would be a 422 (§5.8).
      const messages = freezeMessages([...request, { role: 'assistant', content: clampCodePoints(outcome.text, MAX_CONTENT) }])
      const cut = outcome.finishReason === 'length' ? [...state.session.cut, messages.length - 1] : state.session.cut
      return withState(model, { ...state, session: { ...state.session, messages, cut }, turn: IDLE, pending: null, notice: null })
    }
    case 'crisis':
      // I3, I5: the partial answer is gone, the conversation is locked.
      return enterCrisis(model, outcome.helplines, request)
    case 'streamError':
      return fail(uiError(outcome.code))
    case 'truncated':
      return fail(uiError('truncated'))
    case 'headersTimeout':
      return fail(uiError('headers_timeout'))
    case 'network':
      return fail(uiError('network'))
    case 'aborted':
      return withState(model, { ...state, turn: IDLE, pending: { ...pending, status: 'stopped', error: null } })
    case 'http':
      break
  }

  const error = outcome.error
  const ui = toUiError(error)
  const failed: Pending = { ...pending, status: 'failed', error: ui }
  if (error.status === 401) return unauthenticated(model, state.session, failed, null)
  switch (error.code) {
    case 'not_invited':
      return notInvited(model, state.session, failed, null)
    case 'consent_required':
      return enterResume(model, state.session, failed, { kind: 'turn', request, revisitIds: state.session.revisitIds }, error.policyVersion)
    case 'csrf_failed':
      return withState({ ...model, ctx: { ...model.ctx, csrfFailures: model.ctx.csrfFailures + 1 } }, { ...state, turn: IDLE, pending: failed })
    case 'not_found':
      if (state.session.scenario === 'revisit') {
        return fail(ui, {}, [{ type: 'pick-list', purpose: 'pick-404', q: '', cursor: null }])
      }
      return fail(ui)
    case 'payload_too_large':
      return fail(ui, { notice: { kind: 'too-large' } })
    case 'rate_limited': {
      // 429 is never retried automatically: a countdown, then «Надіслати ще раз» by hand.
      const ms = error.retryAfterMs ?? RATE_LIMIT_FALLBACK_MS
      const until = now + ms
      return withState(
        model,
        { ...state, turn: { p: 'cooldown', until }, pending: { ...failed, error: { ...ui, retryAfterMs: ms } } },
        [{ type: 'after', ms, action: { type: 'cooldown/end', until } }],
      )
    }
    default:
      return fail(ui)
  }
}

function onSummarizeFail(model: Model, state: SummarizingState, error: ApiError, now: number): Step {
  const { session, pending } = state
  if (error.code === 'crisis_stop') return enterCrisis(model, error.helplines ?? FALLBACK, session.messages)
  if (error.status === 401) return unauthenticated(model, session, pending, null)
  if (error.code === 'not_invited') return notInvited(model, session, pending, null)
  if (error.code === 'consent_required') return enterResume(model, session, pending, { kind: 'summarize' }, error.policyVersion)
  if (error.code === 'llm_busy' && state.busy < MAX_BUSY_RETRIES) {
    const ms = error.retryAfterMs ?? DEFAULT_BUSY_RETRY_MS
    const id = model.ctx.seq + 1
    // The countdown is not an error: with `error` null the request still counts as in flight
    // (I2), and «Скласти ще раз» cannot start a second one beside the scheduled retry.
    return [
      {
        ...model,
        ctx: { ...model.ctx, seq: id },
        state: { ...state, id, busy: (state.busy + 1) as 1 | 2, until: now + ms, error: null },
      },
      [{ type: 'summarize', id, body: summarizeBody(session.scenario, session.messages), delayMs: ms, timeoutMs: SUMMARIZE_TIMEOUT }],
    ]
  }
  const ctx = error.code === 'csrf_failed' ? { ...model.ctx, csrfFailures: model.ctx.csrfFailures + 1 } : model.ctx
  const until = error.code === 'rate_limited' ? now + (error.retryAfterMs ?? RATE_LIMIT_FALLBACK_MS) : null
  // Busy after two retries, 502 llm_failed, our 150 s timeout, 413, 422, 5xx: a line on the screen,
  // and only manual retries.
  return [{ ...model, ctx, state: { ...state, until, error: toUiError(error) } }, NONE]
}

const FIELD = /^(?:(title)|bullets\.(\d+)|tags\.(\d+)(?:\.name)?)$/

function onSaveFail(model: Model, state: ReviewState, error: ApiError): Step {
  const { session, pending, draft } = state
  // Network, our timeout, a gateway without a body, or a 201 we could not read: the record may
  // exist. The next attempt first looks at the newest record (save-check), so a retry never
  // makes a duplicate (§7.3).
  if (outcomeUnknown(error)) {
    return withState(model, { ...state, saving: 'unknown', error: uiError('save_unknown', { requestId: error.requestId }) })
  }
  if (error.status === 401) return unauthenticated(model, session, pending, draft)
  if (error.code === 'not_invited') return notInvited(model, session, pending, draft)
  if (error.code === 'consent_required') return enterResume(model, session, pending, { kind: 'save', draft }, error.policyVersion)
  if (error.code === 'validation_error' && state.sent !== null) {
    const issues: DraftIssue[] = []
    let unmapped = error.fields.length === 0
    for (const path of error.fields) {
      const m = FIELD.exec(path)
      const fieldId =
        m === null ? undefined : m[1] !== undefined ? 'title' : m[2] !== undefined ? state.sent.bulletIndex[Number(m[2])] : state.sent.tagIndex[Number(m[3])]
      if (m === null || fieldId === undefined) {
        unmapped = true
        continue
      }
      const reason = m[1] !== undefined ? 'title-invalid' : m[2] !== undefined ? 'bullet-invalid' : 'tag-invalid'
      issues.push({ field: fieldId, reason })
    }
    return withState(model, { ...state, saving: 'idle', issues, error: unmapped ? toUiError(error) : null })
  }
  const ctx = error.code === 'csrf_failed' ? { ...model.ctx, csrfFailures: model.ctx.csrfFailures + 1 } : model.ctx
  return [{ ...model, ctx, state: { ...state, saving: 'idle', error: toUiError(error) } }, NONE]
}

function saved(model: Model, summary: SummaryOut): Step {
  return [
    { ...model, ctx: { ...model.ctx, diary: { status: 'loading' } }, state: { s: 'saved', summary } },
    [{ type: 'diary' }, { type: 'announcer/clear' }],
  ]
}

function ended(model: Model, effects: readonly Effect[] = NONE): Step {
  return [{ ...model, state: { s: 'ended' } }, [...effects, { type: 'announcer/clear' }]]
}

const STACKED: ReadonlySet<ConfirmKind> = new Set(['logout', 'delete-account', 'revoke'])

function confirmAllowed(model: Model, kind: ConfirmKind, revoke: ConsentKind | undefined): boolean {
  const { state, ctx } = model
  const idleChat = state.s === 'chat' && (state.turn.p === 'idle' || state.turn.p === 'cooldown')
  switch (kind) {
    case 'end':
      return idleChat && state.s === 'chat' && hasReply(state.session)
    case 'end-no-theses':
      return idleChat || state.s === 'summarizing'
    case 'discard':
      return state.s === 'review'
    case 'regenerate':
      return state.s === 'review' && state.saving !== 'saving'
    case 'leave':
      return true
    case 'relogin':
      return state.s === 'session-expired'
    case 'new-after-crisis':
      return state.s === 'crisis'
    case 'logout':
    case 'delete-account':
      return ctx.me !== null
    case 'revoke':
      return ctx.me !== null && revoke !== undefined
  }
}

function beginLogout(model: Model): Step {
  return [
    { ...model, ctx: { ...model.ctx, op: { name: 'logout', busy: true, error: null } } },
    [{ type: 'abort', target: 'all' }, { type: 'logout' }],
  ]
}

function onConfirmAccept(model: Model, choice: 'summarize' | undefined): Step {
  const top = topOverlay(model)
  if (top === undefined || top.o !== 'confirm') return [model, NONE]
  const { state, ctx } = model
  const popped: Model = { ...model, overlay: model.overlay.slice(0, -1) }
  switch (top.kind) {
    case 'end':
      return state.s === 'chat' && confirmAllowed(model, 'end', undefined) ? beginSummarize(model, state.session, state.pending) : [model, NONE]
    case 'end-no-theses':
      if (state.s === 'summarizing') return ended(model, [{ type: 'abort', target: 'summarize' }])
      return state.s === 'chat' ? ended(model, [{ type: 'abort', target: 'turn' }]) : [model, NONE]
    case 'discard':
      return state.s === 'review' ? ended(model) : [model, NONE]
    case 'regenerate':
      return state.s === 'review' && state.saving !== 'saving' ? beginSummarize(model, state.session, state.pending) : [model, NONE]
    case 'leave':
      if (choice === 'summarize') {
        const ok =
          state.s === 'chat' &&
          (state.turn.p === 'idle' || state.turn.p === 'cooldown') &&
          hasReply(state.session) &&
          !state.session.noSave
        return ok && state.s === 'chat' ? beginSummarize(model, state.session, state.pending) : [model, NONE]
      }
      return [popped, [top.leaveTo === 'reload' ? { type: 'reload' } : { type: 'navigate', href: '/' }]]
    case 'relogin':
      return [popped, [{ type: 'navigate', href: GOOGLE_START }]]
    case 'logout':
      return beginLogout(model)
    case 'new-after-crisis':
      return state.s === 'crisis' ? startChat(model, { afterCrisis: true, wipe: true }) : [model, NONE]
    case 'delete-account':
      return [
        { ...model, ctx: { ...ctx, op: { name: 'delete-account', busy: true, error: null } } },
        [{ type: 'abort', target: 'all' }, { type: 'delete-me' }],
      ]
    case 'revoke':
      if (top.revoke === null) return [model, NONE]
      return [{ ...model, ctx: { ...ctx, op: { name: 'revoke', busy: true, error: null } } }, [{ type: 'revoke', kind: top.revoke }]]
  }
}

function onOverlayClose(model: Model): Step {
  const top = topOverlay(model)
  if (top === undefined) return [model, NONE]
  const popped: Model = { ...model, overlay: model.overlay.slice(0, -1) }
  if (top.o !== 'revisit-pick') return [popped, NONE]
  // «Скасувати», Esc and «Закрити» on the picker: chosen records stay as they were; with none, the
  // scenario goes back to the one before revisit. "revisit without ids" never survives the close.
  const { state } = popped
  if (state.s === 'chat' && top.revertTo !== null && !hasUserMessage(state.session, state.pending) && state.session.revisitIds.length === 0) {
    return withState(popped, { ...state, session: freshSession(popped.ctx, top.revertTo, state.session.noSave), notice: null })
  }
  return [popped, NONE]
}

function step(model: Model, action: Action): Step {
  const { state, ctx } = model
  switch (action.type) {
    // ── boot and page data ──
    case 'boot': {
      if (state.s !== 'booting' && state.s !== 'fatal') return [model, NONE]
      const authError = authErrorFrom(action.search) ?? ctx.authError
      return [
        { state: { s: 'booting' }, overlay: [], ctx: { ...INITIAL_CTX, authError, helplines: ctx.helplines, seq: ctx.seq } },
        [{ type: 'url/clean' }, { type: 'me', purpose: 'boot', timeoutMs: BOOT_TIMEOUT }],
      ]
    }
    case 'me/ok': {
      if (action.purpose === 'pageshow') return [{ ...model, ctx: { ...ctx, me: action.me } }, NONE]
      if (state.s !== 'booting') return [model, NONE]
      const authNotice = ctx.authError !== null ? { code: ctx.authError, email: action.me.email } : null
      return [
        {
          ...model,
          ctx: { ...ctx, me: action.me, authError: null, authNotice, scenarios: { status: 'loading' }, diary: { status: 'loading' } },
        },
        [{ type: 'consents', purpose: 'boot' }, { type: 'scenarios' }, { type: 'diary' }],
      ]
    }
    case 'me/fail': {
      if (action.purpose === 'pageshow') {
        // bfcache «Назад» after a logout on a shared computer: never show the old conversation.
        if (action.error.status !== 401) return [model, NONE]
        if (state.s === 'signed-out' || state.s === 'account-deleted' || state.s === 'booting' || state.s === 'fatal') return [model, NONE]
        return signedOut(model, 'fresh', null)
      }
      if (state.s !== 'booting') return [model, NONE]
      if (action.error.status === 401) {
        const code = ctx.authError
        const next: Model = { ...model, ctx: { ...ctx, authError: null, me: null } }
        if (code === 'not_invited') return withState(next, { s: 'not-invited', hasSession: false, stale: null, pending: null, draft: null })
        return withState(next, { s: 'signed-out', variant: 'fresh', notice: code !== null ? { kind: 'auth-error', code } : null })
      }
      return withState(model, { s: 'fatal', error: toUiError(action.error) })
    }
    case 'consents/ok': {
      const next: Model = { ...model, ctx: { ...ctx, consents: action.consents } }
      if (action.purpose === 'boot') {
        if (state.s !== 'booting') return [next, NONE]
        if (action.consents.missing.length > 0) return withState(next, consent('first', { fresh: true }))
        return startWhenReady({ ...next, ctx: { ...next.ctx, wantChat: true } })
      }
      if (state.s !== 'consent') return [next, NONE]
      // Boxes, «(ви вже погодилися …)», the version and the POST body come only from this fresh
      // answer (§3.5).
      const known = ctx.consents?.current_policy_version ?? null
      const policyChanged = state.policyChanged || (known !== null && known !== action.consents.current_policy_version)
      const fresh: Model = { ...next, state: { ...state, loading: false, fresh: true, epoch: state.epoch + 1, policyChanged, error: null } }
      // Agreed in another tab meanwhile: no POST (kinds must be 1..3), repeat the action now.
      if (action.consents.missing.length === 0) return afterConsent(fresh)
      return [fresh, NONE]
    }
    case 'consents/fail': {
      if (action.purpose === 'boot') {
        if (state.s !== 'booting') return [model, NONE]
        if (action.error.status === 401) return signedOut(model, 'fresh', null)
        return withState(model, { s: 'fatal', error: toUiError(action.error) })
      }
      if (state.s !== 'consent') return [model, NONE]
      if (action.error.status === 401) return unauthenticated(model, state.session, state.pending, draftOf(state))
      return withState(model, { ...state, loading: false, error: uiError('consents_load_failed', { requestId: action.error.requestId }) })
    }
    case 'scenarios/ok':
      return startWhenReady({ ...model, ctx: { ...ctx, scenarios: loaded(action.items) } })
    case 'scenarios/fail':
      return startWhenReady({ ...model, ctx: { ...ctx, scenarios: { status: 'failed' } } })
    case 'scenarios/retry':
      if (ctx.scenarios.status === 'loading') return [model, NONE]
      return [{ ...model, ctx: { ...ctx, scenarios: { status: 'loading' } } }, [{ type: 'scenarios' }]]
    case 'diary/ok':
      return [{ ...model, ctx: { ...ctx, diary: loaded(action.diary) } }, NONE]
    case 'diary/fail': {
      const next: Model = { ...model, ctx: { ...ctx, diary: { status: 'failed' } } }
      // A 401 on GET /summaries mid-session ends the session like any protected call (§4.3).
      if (action.error.status === 401 && signedInScreen(state)) return unauthenticated(next, sessionOf(state), pendingOf(state), draftOf(state))
      return [next, NONE]
    }
    case 'diary/retry':
      if (ctx.diary.status === 'loading' || ctx.me === null) return [model, NONE]
      return [{ ...model, ctx: { ...ctx, diary: { status: 'loading' } } }, [{ type: 'diary' }]]
    case 'helplines/ok':
      return [{ ...model, ctx: { ...ctx, helplines: loaded(action.helplines) } }, NONE]
    case 'helplines/fail':
      return [{ ...model, ctx: { ...ctx, helplines: { status: 'failed' } } }, NONE]
    case 'page/show':
      if (!action.persisted || ctx.me === null) return [model, NONE]
      return [model, [{ type: 'me', purpose: 'pageshow', timeoutMs: BOOT_TIMEOUT }]]

    // ── consent ──
    case 'consent/agree': {
      if (state.s !== 'consent' || state.loading || state.submitting) return [model, NONE]
      // The fresh GET failed (or a 409 made the data old): ctx.consents still holds the boot
      // answer — missing = [] or an outdated version. Ask again instead of acting on it (§2.4,
      // §3.5); the boxes reset when the answer comes.
      if (!state.fresh) return withState(model, { ...state, loading: true, error: null }, [{ type: 'consents', purpose: 'fresh' }])
      const consents = ctx.consents
      // No named provider, no consent to hand it the conversation (§3.5).
      if (consents === null || consents.llm_provider === null) return withState(model, { ...state, error: uiError('provider_missing') })
      const unchecked = CONSENT_KINDS.filter((k) => !action.checked.includes(k))
      if (unchecked.length > 0) return withState(model, { ...state, error: uiError('unchecked', { fields: unchecked }) })
      if (consents.missing.length === 0) return afterConsent(model)
      return withState(model, { ...state, submitting: true, error: null }, [
        { type: 'grant', body: grantBody(consents.current_policy_version, consents.missing) },
      ])
    }
    case 'consent/reload':
      if (state.s !== 'consent' || state.loading) return [model, NONE]
      return withState(model, { ...state, loading: true, error: null }, [{ type: 'consents', purpose: 'fresh' }])
    case 'grant/ok': {
      if (state.s !== 'consent') return [model, NONE]
      const me = ctx.me === null ? null : { ...ctx.me, consents_ok: true }
      return afterConsent({ ...model, ctx: { ...ctx, consents: action.consents, me } })
    }
    case 'grant/fail': {
      if (state.s !== 'consent') return [model, NONE]
      const error = action.error
      if (error.code === 'policy_outdated') {
        // New terms: a fresh GET, boxes cleared, the banner. `resume` and its mode stay, so the
        // action still repeats after the new consent; `first` becomes `update`.
        const mode: ConsentMode = state.mode === 'first' ? 'update' : state.mode
        return withState(model, { ...state, mode, submitting: false, loading: true, fresh: false, policyChanged: true, error: null }, [
          { type: 'consents', purpose: 'fresh' },
        ])
      }
      if (error.status === 401) return unauthenticated(model, state.session, state.pending, draftOf(state))
      if (error.code === 'not_invited') return notInvited(model, state.session, state.pending, draftOf(state))
      const next: Model = error.code === 'csrf_failed' ? { ...model, ctx: { ...ctx, csrfFailures: ctx.csrfFailures + 1 } } : model
      return withState(next, { ...state, submitting: false, error: toUiError(error) })
    }

    // ── conversation ──
    case 'chat/scenario': {
      if (state.s !== 'chat' || state.turn.p !== 'idle' || hasUserMessage(state.session, state.pending)) return [model, NONE]
      if (action.id === state.session.scenario || scenarioById(ctx, action.id) === undefined) return [model, NONE]
      const revertTo = action.id === 'revisit' ? (state.session.scenario === 'revisit' ? state.revertTo : state.session.scenario) : state.revertTo
      return withState(model, { ...state, session: freshSession(ctx, action.id, state.session.noSave), notice: null, revertTo })
    }
    case 'chat/no-save':
      if (state.s !== 'chat' || hasUserMessage(state.session, state.pending)) return [model, NONE]
      return withState(model, { ...state, session: { ...state.session, noSave: action.on } })
    case 'chat/send': {
      // I2: a double Enter or click while a turn runs (or a 429 countdown) sends nothing.
      if (state.s !== 'chat' || state.turn.p !== 'idle') return [model, NONE]
      if (state.notice?.kind === 'too-large' || state.notice?.kind === 'revisit-gone') return [model, NONE]
      if (state.pending !== null) return withState(model, { ...state, notice: { kind: 'unsent' } })
      const { session } = state
      if (!canSend(session.messages.length)) return [model, NONE]
      const check = checkMessage(action.text)
      if (!check.ok) {
        return check.reason === 'blank' ? [model, NONE] : withState(model, { ...state, notice: { kind: 'too-long', length: check.length } })
      }
      if (session.scenario === 'revisit' && session.revisitIds.length === 0) {
        return withState(model, { ...state, notice: { kind: 'need-records' } })
      }
      const request = freezeMessages([...session.messages, { role: 'user', content: action.text }])
      return beginTurn(model, state, request, action.text, session.revisitIds)
    }
    case 'chat/resend': {
      if (state.s !== 'chat' || state.turn.p !== 'idle' || state.pending === null || state.pending.status === 'sending') return [model, NONE]
      if (state.notice?.kind === 'too-large' || state.notice?.kind === 'revisit-gone') return [model, NONE]
      // I4: the same frozen request, not a rebuilt one.
      return beginTurn(model, state, state.pending.request, state.pending.text, state.session.revisitIds)
    }
    case 'chat/edit': {
      if (state.s !== 'chat' || state.pending === null || state.pending.status === 'sending') return [model, NONE]
      if (state.turn.p !== 'idle' && state.turn.p !== 'cooldown') return [model, NONE]
      const notice = state.notice?.kind === 'unsent' ? null : state.notice
      return withState(model, { ...state, pending: null, notice }, [{ type: 'composer', text: state.pending.text }])
    }
    case 'chat/stop': {
      if (state.s !== 'chat') return [model, NONE]
      const t = state.turn
      if (t.p !== 'waiting' && t.p !== 'streaming' && t.p !== 'busy-wait') return [model, NONE]
      // I3: the partial answer goes; whatever this turn still reports carries a stale id.
      const pending = state.pending === null ? null : { ...state.pending, status: 'stopped' as const, error: null }
      return withState(model, { ...state, turn: IDLE, pending }, [{ type: 'abort', target: 'turn' }])
    }
    case 'chat/start-free': {
      if (state.s !== 'chat' || state.notice?.kind !== 'revisit-gone' || hasReply(state.session)) return [model, NONE]
      const effects: readonly Effect[] = state.pending !== null ? [{ type: 'composer', text: state.pending.text }] : NONE
      return withState(model, chat(freshSession(ctx, 'free', state.session.noSave)), effects)
    }
    case 'chat/summarize':
      if (state.s !== 'chat' || (state.turn.p !== 'idle' && state.turn.p !== 'cooldown')) return [model, NONE]
      // An unsent message goes along, untouched: the theses are of `messages` only, and it is
      // back in place if the person returns to the conversation.
      return beginSummarize(model, state.session, state.pending)
    case 'chat/new':
      if (state.s !== 'saved' && state.s !== 'ended') return [model, NONE]
      return startChat(model)
    case 'turn/meta': {
      const t = turnActive(state, action.id)
      if (t === null || t.p !== 'waiting' || state.s !== 'chat') return [model, NONE]
      return withState(model, { ...state, turn: { ...t, stage: 'meta' } })
    }
    case 'turn/token': {
      const t = turnActive(state, action.id)
      if (t === null || state.s !== 'chat' || t.p === 'busy-wait') return [model, NONE]
      const partial = (t.p === 'streaming' ? t.partial : '') + action.text
      return withState(model, { ...state, turn: { p: 'streaming', id: t.id, partial, request: t.request, trunc: t.trunc, busy: t.busy } })
    }
    case 'turn/reset': {
      const t = turnActive(state, action.id)
      if (t === null || state.s !== 'chat' || t.p === 'busy-wait') return [model, NONE]
      return withState(model, { ...state, turn: { p: 'waiting', id: t.id, stage: 'headers', request: t.request, trunc: t.trunc, busy: t.busy } })
    }
    case 'turn/busy-wait': {
      const t = turnActive(state, action.id)
      if (t === null || state.s !== 'chat') return [model, NONE]
      return withState(model, { ...state, turn: { p: 'busy-wait', id: t.id, until: action.until, request: t.request, trunc: t.trunc, busy: action.retry } })
    }
    case 'turn/retry': {
      const t = turnActive(state, action.id)
      if (t === null || state.s !== 'chat') return [model, NONE]
      const trunc: 0 | 1 = action.cause === 'truncated' ? 1 : t.trunc
      const busy = (action.cause === 'busy' ? Math.min(2, Math.max(1, action.attempt)) : t.busy) as 0 | 1 | 2
      return withState(model, { ...state, turn: { p: 'waiting', id: t.id, stage: 'headers', request: t.request, trunc, busy } })
    }
    case 'turn/outcome': {
      if (turnActive(state, action.id) === null || state.s !== 'chat') return [model, NONE]
      return onTurnOutcome(model, state, action.outcome, action.now)
    }
    case 'cooldown/end':
      if (state.s !== 'chat' || state.turn.p !== 'cooldown' || state.turn.until !== action.until) return [model, NONE]
      return withState(model, { ...state, turn: IDLE })

    // ── record picker ──
    case 'revisit/open': {
      if (state.s !== 'chat' || state.session.scenario !== 'revisit' || llmInFlight(state)) return [model, NONE]
      const revertTo = hasUserMessage(state.session, state.pending) ? null : state.revertTo
      const overlay = pick({ selected: state.session.revisitIds, loading: true, revertTo })
      return [{ ...model, overlay: [overlay] }, [{ type: 'pick-list', purpose: 'pick', q: '', cursor: null }]]
    }
    case 'revisit/toggle': {
      const top = topPick(model)
      if (top === null) return [model, NONE]
      const has = top.selected.includes(action.id)
      if (!has && top.selected.length >= MAX_REVISIT_IDS) return [model, NONE]
      const selected = has ? top.selected.filter((id) => id !== action.id) : [...top.selected, action.id]
      return [replaceTop(model, { ...top, selected }), NONE]
    }
    case 'revisit/search': {
      const top = topPick(model)
      if (top === null) return [model, NONE]
      // What the server takes (≤ 200, no NUL), or the search would be a 422 «не вдалося завантажити».
      const q = clampCodePoints(action.q.replace(/\u0000/g, '').trim(), MAX_QUERY).trim()
      return [replaceTop(model, { ...top, q, loading: true, failed: false }), [{ type: 'pick-list', purpose: 'pick', q, cursor: null }]]
    }
    case 'revisit/more': {
      const top = topPick(model)
      if (top === null || top.loading || top.list?.nextCursor == null) return [model, NONE]
      const cursor = top.list.nextCursor
      return [replaceTop(model, { ...top, loading: true, failed: false }), [{ type: 'pick-list', purpose: 'pick', q: top.q, cursor }]]
    }
    case 'revisit/list-ok': {
      const firstPage = action.q === '' && action.cursor === null
      const next: Model = firstPage ? { ...model, ctx: { ...ctx, diary: loaded(action.diary) } } : model
      if (action.purpose === 'pick-404') {
        if (state.s !== 'chat') return [next, NONE]
        // 404 and the diary is empty now: no picker, a block instead of the composer (§3.6).
        if (action.diary.items.length === 0) return withState(next, { ...state, notice: { kind: 'revisit-gone' } })
        return [{ ...next, overlay: [pick({ list: action.diary, gone: true })] }, NONE]
      }
      const top = topPick(next)
      if (top === null || top.q !== action.q) return [next, NONE]
      let list: Diary
      if (action.cursor === null) list = action.diary
      else if (top.list !== null && top.list.nextCursor === action.cursor) {
        list = { items: [...top.list.items, ...action.diary.items], nextCursor: action.diary.nextCursor }
      } else return [next, NONE]
      return [replaceTop(next, { ...top, list, loading: false, failed: false }), NONE]
    }
    case 'revisit/list-fail': {
      if (action.error.status === 401 && signedInScreen(state)) return unauthenticated(model, sessionOf(state), pendingOf(state), draftOf(state))
      if (action.purpose === 'pick-404') {
        if (state.s !== 'chat') return [model, NONE]
        return [{ ...model, overlay: [pick({ gone: true, failed: true })] }, NONE]
      }
      const top = topPick(model)
      if (top === null || top.q !== action.q) return [model, NONE]
      return [replaceTop(model, { ...top, loading: false, failed: true }), NONE]
    }
    case 'revisit/confirm': {
      const top = topPick(model)
      if (top === null || state.s !== 'chat' || top.selected.length === 0 || top.selected.length > MAX_REVISIT_IDS) return [model, NONE]
      const popped: Model = { ...model, overlay: model.overlay.slice(0, -1) }
      const base: ChatState = { ...state, session: { ...state.session, revisitIds: [...top.selected] }, notice: null }
      // After a 404 the same turn goes again, with the new ids (§3.6).
      if (state.turn.p === 'idle' && state.pending !== null && state.pending.status === 'failed' && state.pending.error?.code === 'not_found') {
        return beginTurn(popped, base, state.pending.request, state.pending.text, top.selected)
      }
      return withState(popped, base)
    }

    // ── theses ──
    case 'summarize/ok':
      if (state.s !== 'summarizing' || state.id !== action.id) return [model, NONE]
      return withState(model, {
        s: 'review',
        session: state.session,
        pending: state.pending,
        draft: draftFromOut(action.draft),
        saving: 'idle',
        error: null,
        issues: [],
        sent: null,
        id: state.id,
      })
    case 'summarize/fail':
      if (state.s !== 'summarizing' || state.id !== action.id) return [model, NONE]
      return onSummarizeFail(model, state, action.error, action.now)
    case 'summarize/cancel':
      if (state.s !== 'summarizing') return [model, NONE]
      return withState(model, backToChat(state.session, state.pending), [{ type: 'abort', target: 'summarize' }])
    case 'summarize/retry':
      // I2: by hand only after a final error, never beside the scheduled llm_busy retry; after a
      // 429 only once its countdown is over.
      if (state.s !== 'summarizing' || state.error === null) return [model, NONE]
      if (state.until !== null && action.now < state.until) return [model, NONE]
      return beginSummarize(model, state.session, state.pending)
    case 'review/update':
      // Not while saving, and not after an unknown result: the save-check must compare the newest
      // record with the body that went out, not with a later edit (§7.3).
      if (state.s !== 'review' || state.saving !== 'idle') return [model, NONE]
      return withState(model, { ...state, draft: action.draft, issues: [], error: null })
    case 'review/save':
      if (state.s !== 'review' || state.session.noSave || state.saving === 'saving') return [model, NONE]
      return beginSave(model, state)
    case 'review/done':
      if (state.s !== 'review' || !state.session.noSave) return [model, NONE]
      return ended(model)
    case 'review/back':
      if (state.s !== 'review' || state.saving === 'saving') return [model, NONE]
      return withState(model, backToChat(state.session, state.pending))
    case 'save/ok':
      if (state.s !== 'review' || state.id !== action.id || state.saving !== 'saving') return [model, NONE]
      return saved(model, action.summary)
    case 'save/fail':
      if (state.s !== 'review' || state.id !== action.id || state.saving !== 'saving') return [model, NONE]
      return onSaveFail(model, state, action.error)
    case 'save/check': {
      if (state.s !== 'review' || state.id !== action.id || state.saving !== 'saving' || state.sent === null) return [model, NONE]
      const newest = action.list.items[0]
      if (newest !== undefined && matchesSaved(state.sent.body, newest, action.date)) return saved(model, newest)
      return [model, [{ type: 'save', id: state.id, body: state.sent.body }]]
    }
    case 'save/check-fail':
      if (state.s !== 'review' || state.id !== action.id || state.saving !== 'saving') return [model, NONE]
      if (action.error.status === 401) return unauthenticated(model, state.session, state.pending, state.draft)
      // Still unknown: never POST blind.
      return withState(model, { ...state, saving: 'unknown', error: uiError('save_unknown', { requestId: action.error.requestId }) })

    // ── overlays and the account ──
    case 'overlay/open': {
      if (action.overlay === 'account') {
        const signedIn = ctx.me !== null && state.s !== 'signed-out' && state.s !== 'account-deleted' && state.s !== 'booting'
        return signedIn ? [{ ...model, overlay: [{ o: 'account' }] }, NONE] : [model, NONE]
      }
      const opened: Model = { ...model, overlay: [{ o: 'help' }] }
      if (ctx.helplines.status !== 'idle') return [opened, NONE]
      return [{ ...opened, ctx: { ...ctx, helplines: { status: 'loading' } } }, [{ type: 'helplines' }]]
    }
    case 'confirm/open': {
      if (!confirmAllowed(model, action.kind, action.revoke)) return [model, NONE]
      const overlay: Overlay = {
        o: 'confirm',
        kind: action.kind,
        revoke: action.revoke ?? null,
        leaveTo: action.kind === 'leave' ? (action.leaveTo ?? 'home') : null,
        back: false,
      }
      const top = topOverlay(model)
      // account → confirm(logout | delete-account | revoke) is the only second level (§2.5).
      const stack = top?.o === 'account' && STACKED.has(action.kind) ? [...model.overlay, overlay] : [overlay]
      return [{ ...model, overlay: stack, ctx: ctx.op !== null && !ctx.op.busy ? { ...ctx, op: null } : ctx }, NONE]
    }
    case 'confirm/switch': {
      const top = topOverlay(model)
      if (top === undefined || top.o !== 'confirm') return [model, NONE]
      if (action.kind === 'end-no-theses' && top.kind === 'end') return [replaceTop(model, { ...top, kind: 'end-no-theses', back: true }), NONE]
      if (action.kind === 'end' && top.kind === 'end-no-theses' && top.back) return [replaceTop(model, { ...top, kind: 'end', back: false }), NONE]
      return [model, NONE]
    }
    case 'confirm/accept':
      return onConfirmAccept(model, action.choice)
    case 'overlay/close':
      return onOverlayClose(model)
    case 'account/logout':
      if (ctx.me === null || ctx.op?.busy === true) return [model, NONE]
      if (leaveGuard(state)) return step(model, { type: 'confirm/open', kind: 'logout' })
      return beginLogout(model)
    case 'logout/ok':
      return signedOut(model, 'logged-out', { kind: 'logged-out' })
    case 'logout/fail':
      return [{ ...model, ctx: { ...ctx, op: { name: 'logout', busy: false, error: toUiError(action.error) } } }, NONE]
    case 'delete/ok':
      return accountDeleted(model, 'confirmed')
    case 'delete/fail': {
      const error = action.error
      if (error.status === 401) {
        // A second DELETE after an unknown result finds no session: the first one, most likely,
        // erased the account with it. Asking to sign in would create a new, empty account.
        if (ctx.deleteAttempt === 'unknown') return accountDeleted(model, 'presumed')
        return signedOut(model, 'fresh', { kind: 'delete-relogin' })
      }
      const unknown = outcomeUnknown(error)
      const ui = unknown ? uiError('delete_unknown', { requestId: error.requestId }) : toUiError(error)
      return [
        { ...model, ctx: { ...ctx, deleteAttempt: unknown ? 'unknown' : ctx.deleteAttempt, op: { name: 'delete-account', busy: false, error: ui } } },
        NONE,
      ]
    }
    case 'revoke/ok': {
      // Withdrawing data_processing erases the journal on the server: drop it here too, or the
      // revisit picker would offer deleted records (§8.6).
      const diary = action.kind === 'data_processing' ? EMPTY_DIARY : ctx.diary
      const me = ctx.me === null ? null : { ...ctx.me, consents_ok: false }
      // Closed explicitly: revoking from the consent screen keeps `s`, so reduce() would not.
      return [
        { state: consent('first', { fresh: true }), overlay: [], ctx: { ...ctx, consents: action.consents, diary, me, op: null } },
        [{ type: 'abort', target: 'all' }, { type: 'announcer/clear' }],
      ]
    }
    case 'revoke/fail':
      if (action.error.status === 401) return unauthenticated(model, sessionOf(state), pendingOf(state), draftOf(state))
      return [{ ...model, ctx: { ...ctx, op: { name: 'revoke', busy: false, error: toUiError(action.error) } } }, NONE]
  }
}

/** The single entry point. A new screen closes every overlay (I6; focus goes to its h1 in
 *  ui/render.ts) and forgets the account operation that led there. */
export function reduce(model: Model, action: Action): Step {
  const [next, effects] = step(model, action)
  if (next.state.s === model.state.s) return [next, effects]
  return [{ ...next, overlay: [], ctx: next.ctx.op === null ? next.ctx : { ...next.ctx, op: null } }, effects]
}
