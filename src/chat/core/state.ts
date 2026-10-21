// The /chat/ state machine (spec §2): reduce(model, action) → [model, effects].
//
// Pure: no I/O, no timers, no clock. Effects (requests, aborts, timers, navigation) are data that
// src/chat/ui/effects.ts executes; time comes in with the actions that need it. Every invariant of
// §2.6 that the core can hold is held here and tested in tests/e2e/chat-core.spec.ts:
//   I1 the transcript lives only in the state (nothing here stores, logs or serialises it);
//   I2 at most one LLM request in flight; I3 a partial answer joins `messages` only on `done`;
//   I4 every retry sends the frozen request; I5 no way back from `crisis` into its conversation;
//   I6 a new screen closes every overlay; I7 leaveGuard(); I9 turnBody()/summarizeBody() in api.ts.
// The diary page (`journal`, spec §7.7) is a screen of its own here: it keeps the conversation it
// was opened from and gives it back, and its requests are stamped with ctx.seq like every other.
// The self-help tools (spec §3.13) are overlays like the others: a new screen — the crisis above
// all — closes them in the same step. What «Як ви зараз?» records stays in ctx.mood, never sent.

import { GOOGLE_START, grantBody, summarizeBody, turnBody } from './api'
import { DEFAULT_BUSY_RETRY_MS, outcomeUnknown, toUiError, uiError, type ApiError, type UiError } from './errors'
import { FALLBACK, PAUSED_LINE_NOTE_SHORT, maskPausedLineShort, oneLine, type SafeHelplines } from './helplines'
import { FALLBACK_TZ, formOf, maskedField, patchOf, searchQuery, shiftDay, type EntryForm, type PatchSent } from './journal'
import { NO_MOOD, isMoodWord, isToolKind, type MoodLog, type ToolKind } from './selfhelp'
import {
  MAX_BULLET,
  MAX_BULLETS,
  MAX_CONTENT,
  MAX_QUERY,
  MAX_REVISIT_IDS,
  MAX_TITLE,
  canSend,
  checkMessage,
  clampCodePoints,
  clampWords,
  draftFromOut,
  fieldIssues,
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
  type SummaryPatch,
  type TagCountOut,
  type TurnRequest,
  type WeeklyReviewOut,
} from './types'

// ── Constants ─────────────────────────────────────────────────────────────────────────────────

/** 429 without a usable Retry-After: the server counts turns per minute. */
export const RATE_LIMIT_FALLBACK_MS = 60_000
/** A record counts as "ours" after an unknown save result only if it is this fresh (§7.3). */
export const SAVE_MATCH_WINDOW_MS = 2 * 60_000
/** «→ У тези»: as many candidates as a record can hold theses (§3.7.2). */
export const MAX_MARKS = MAX_BULLETS
/** The reminder to pause (§3.7.7): 40 minutes after the first message was sent… */
export const PAUSE_AFTER_MS = 40 * 60_000
/** …or 60 replies in the conversation — the person's messages and the AI's answers, the opening
 *  message not counted — whichever comes first. */
export const PAUSE_AFTER_REPLIES = 60

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
  /** When each message of `messages` came, in ms since the epoch (a parallel array, like `cut`):
   *  the page shows it as HH:MM under the reply. null where the page did not see it come (the
   *  opening message). Never sent: the turn body carries only role and content. */
  times: readonly (number | null)[]
  /** «→ У тези» (spec §3.7.2): indices in `messages` of the AI's replies the person marked, in the
   *  order marked, at most MAX_MARKS. They wait on the theses screen as candidates (§7.2); never
   *  sent — neither the turn nor the summarize body carries them. */
  marks: readonly number[]
  /** The reminder to pause (spec §3.7.7): 'none' until it is due, then why it stands above the
   *  composer ('time' or 'count'), 'hidden' after «Сховати» or «Зібрати тези» — once a
   *  conversation. */
  pause: PauseState
}>

export type PauseState = 'none' | 'time' | 'count' | 'hidden'

/** The person's message that is not in `messages` yet. */
export type Pending = Readonly<{
  text: string
  /** The frozen request it went out with: every retry sends exactly this (I4). */
  request: readonly Msg[]
  status: 'sending' | 'failed' | 'stopped'
  error: UiError | null
  /** When «Надіслати» was pressed (the time under the message); null if the action had no clock. */
  at: number | null
}>

/** What to repeat after the consent screen; the turn keeps its frozen body (I4). */
export type Resume =
  | Readonly<{ kind: 'turn'; request: readonly Msg[]; revisitIds: readonly string[] }>
  | Readonly<{ kind: 'summarize' }>
  | Readonly<{ kind: 'save'; draft: Draft }>
  /** A PATCH of a diary record (403 consent_required): the diary as it was, its edit with the
   *  frozen body — after the consent the same body goes again, from `saved`/`ended` too, where
   *  there is no conversation. */
  | Readonly<{ kind: 'patch'; journal: JournalState }>

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
  /** `keep`: «Взяти з собою» (§7.5) — the first saved thesis the person brought in with «→ У
   *  тези», as the server stored it; absent when none of the saved theses came from a mark. */
  | Readonly<{ s: 'saved'; summary: SummaryOut; keep?: string }>
  | Readonly<{ s: 'ended' }>
  | JournalState
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

// ── The diary page (spec §7.7) ──

/** The conversation the diary was opened from; «До розмови» gives it back as the theses do
 *  (backToChat). null: opened from `saved` or `ended` — the way out is a new conversation. */
export type JournalBack = Readonly<{
  session: Session
  pending: Pending | null
  revertTo: ScenarioId
  /** The block «Записів… уже немає» stood instead of the composer: it comes back with it. */
  gone: boolean
}>

export type JournalEdit = Readonly<{
  form: EntryForm
  saving: boolean
  error: UiError | null
  issues: readonly DraftIssue[]
  /** The last PATCH that went out, with its index tables for a 422; repeated as it is after a
   *  consent. */
  sent: PatchSent | null
  req: number
}>

export type JournalNotice =
  | Readonly<{ kind: 'saved' }>
  | Readonly<{ kind: 'deleted' }>
  /** The record went meanwhile (404 on a PATCH, another tab). */
  | Readonly<{ kind: 'gone' }>
  | Readonly<{ kind: 'delete-failed'; error: UiError }>

export type JournalWeek = Readonly<{
  /** The Monday shown; null until the first answer (the week of today in `tz`). */
  start: string | null
  /** This week's Monday, as the first answer named it: «Наступний тиждень» stops there. */
  current: string | null
  review: Loadable<WeeklyReviewOut>
  req: number
}>

export type JournalState = Readonly<{
  s: 'journal'
  back: JournalBack | null
  /** The page's IANA zone (Intl), Europe/Kyiv once the server refused it, null without one. */
  tz: string | null
  /** The search and the theme the list is filtered by (AND on the server); paging keeps both. */
  q: string
  tag: string | null
  list: Diary | null
  loading: boolean
  failed: boolean
  /** The cursor of the page asked for last (null: the first page): a retry asks for it again. */
  cursor: string | null
  req: number
  tags: Loadable<readonly TagCountOut[]>
  /** The GET /tags asked for last: a PATCH and a DELETE each ask again, and an older answer that
   *  lands later must not bring back a theme the newer one no longer has. */
  tagsReq: number
  week: JournalWeek
  /** One record edited at a time, in place. */
  edit: JournalEdit | null
  /** The record whose DELETE is on its way. */
  deleting: string | null
  notice: JournalNotice | null
}>

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
  /** A 429 countdown of turns runs until then. It outlives the theses and back (§4.3: the manual
   *  retry only after it); cooldown/end clears it. */
  cooldown: number | null
  /** The last POST /summaries of this conversation may have landed (an unknown result, §7.3): no
   *  text may say that nothing reached the diary. */
  maybeSaved: boolean
  /** The page navigates away on the person's word («Піти», «Увійти»): at pagehide nothing of the
   *  conversation may stay behind for the bfcache (§5.6). */
  leaving: boolean
  /** «Як ви зараз?» of this conversation: the first word and the one at its end, in this tab only
   *  (spec §3.13). A new conversation, the crisis and a signed-out page start without them. */
  mood: MoodLog
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
  | 'delete-summary'
  | 'revisit-restart'
  | 'discard-edit'

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

/** «Як ви зараз?» at the start or in the middle (`before`), «А зараз?» on the theses, «Збережено»
 *  and «Розмову завершено» (`after`). */
export type MoodWhen = 'before' | 'after'

/** The self-help tools (spec §3.13). */
export type ToolOverlay =
  | Readonly<{ o: 'breathe' }>
  | Readonly<{ o: 'ground' }>
  | Readonly<{ o: 'mood'; when: MoodWhen }>
  | Readonly<{ o: 'shelter' }>

export type Overlay =
  | Readonly<{ o: 'account' }>
  | Readonly<{ o: 'help' }>
  | PickOverlay
  | ToolOverlay
  | Readonly<{
      o: 'confirm'
      kind: ConfirmKind
      revoke: ConsentKind | null
      /** leave: where the page goes. discard-edit: 'home' when the wordmark was pressed. */
      leaveTo: 'home' | 'reload' | null
      /** end-no-theses opened from end: «Назад» goes back to end. */
      back: boolean
      /** delete-summary, revisit-restart: the diary record it is about; discard-edit: the record
       *  «Повернутися до цього» was pressed on (absent otherwise: «До розмови» / «Нова розмова»). */
      summary?: string
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
  cooldown: null,
  maybeSaved: false,
  leaving: false,
  mood: NO_MOOD,
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
  /** pagehide (after the effects aborted what was in flight). */
  | Readonly<{ type: 'page/left' }>
  // consent
  | Readonly<{ type: 'consent/agree'; checked: readonly ConsentKind[] }>
  | Readonly<{ type: 'consent/reload' }>
  | Readonly<{ type: 'grant/ok'; consents: ConsentState }>
  | Readonly<{ type: 'grant/fail'; error: ApiError }>
  // conversation
  | Readonly<{ type: 'chat/scenario'; id: ScenarioId }>
  | Readonly<{ type: 'chat/no-save'; on: boolean }>
  /** `now`: the page's clock at the press (the core has none); the message's time on the screen. */
  | Readonly<{ type: 'chat/send'; text: string; now?: number }>
  | Readonly<{ type: 'chat/resend' }>
  | Readonly<{ type: 'chat/edit' }>
  | Readonly<{ type: 'chat/stop' }>
  | Readonly<{ type: 'chat/start-free' }>
  | Readonly<{ type: 'chat/summarize' }>
  | Readonly<{ type: 'chat/new' }>
  /** «→ У тези» under a reply of the AI: marks it, or takes the mark off (`index` in `messages`). */
  | Readonly<{ type: 'chat/mark'; index: number }>
  /** The page's timer: the reminder to pause may be due (`now`: the page's clock). */
  | Readonly<{ type: 'chat/pause-due'; now: number }>
  /** «Сховати» on the reminder. */
  | Readonly<{ type: 'chat/pause-hide' }>
  /** «Зібрати тези» on the reminder: it goes, and «Завершити розмову?» opens (§3.7.8). */
  | Readonly<{ type: 'chat/pause-collect' }>
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
  /** A marked reply becomes a thesis of the draft (`index` in `messages`). */
  | Readonly<{ type: 'review/take'; index: number }>
  /** A marked reply leaves the candidates (and its mark leaves the conversation). */
  | Readonly<{ type: 'review/unmark'; index: number }>
  | Readonly<{ type: 'save/ok'; id: number; summary: SummaryOut }>
  | Readonly<{ type: 'save/fail'; id: number; error: ApiError }>
  | Readonly<{ type: 'save/check'; id: number; list: SummaryList; date: string | null }>
  | Readonly<{ type: 'save/check-fail'; id: number; error: ApiError }>
  // overlays and the account
  /** A tool opens over «Якщо важко» and over «В укритті», over nothing else. `when` only for mood. */
  | Readonly<{ type: 'overlay/open'; overlay: 'account' | 'help' | ToolKind; when?: MoodWhen }>
  /** «Готово» / «Додати до розмови» in «Як ви зараз?»: a word of the dictionary, recorded in
   *  ctx.mood; the check-in closes. Esc and «Пропустити» record nothing. */
  | Readonly<{ type: 'mood/pick'; word: string }>
  | Readonly<{ type: 'confirm/open'; kind: ConfirmKind; revoke?: ConsentKind; leaveTo?: 'home' | 'reload'; summary?: string }>
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
  // the diary (§7.7). `tz`: the page's Intl zone — the core has no time zone database.
  | Readonly<{ type: 'journal/open'; tz: string | null }>
  | Readonly<{ type: 'journal/back' }>
  | Readonly<{ type: 'journal/search'; q: string }>
  | Readonly<{ type: 'journal/tag'; id: string | null }>
  | Readonly<{ type: 'journal/more' }>
  | Readonly<{ type: 'journal/retry' }>
  | Readonly<{ type: 'journal/list-ok'; req: number; diary: Diary }>
  | Readonly<{ type: 'journal/list-fail'; req: number; error: ApiError }>
  | Readonly<{ type: 'journal/tags-ok'; req: number; tags: readonly TagCountOut[] }>
  | Readonly<{ type: 'journal/tags-fail'; req: number; error: ApiError }>
  | Readonly<{ type: 'journal/week'; step: -1 | 1 }>
  | Readonly<{ type: 'journal/week-retry' }>
  | Readonly<{ type: 'journal/week-ok'; req: number; review: WeeklyReviewOut }>
  | Readonly<{ type: 'journal/week-fail'; req: number; error: ApiError }>
  | Readonly<{ type: 'journal/edit'; id: string }>
  | Readonly<{ type: 'journal/edit-update'; form: EntryForm }>
  | Readonly<{ type: 'journal/edit-add' }>
  | Readonly<{ type: 'journal/edit-cancel' }>
  | Readonly<{ type: 'journal/edit-save' }>
  | Readonly<{ type: 'journal/patch-ok'; req: number; summary: SummaryOut }>
  | Readonly<{ type: 'journal/patch-fail'; req: number; error: ApiError }>
  | Readonly<{ type: 'journal/delete-ok'; id: string }>
  | Readonly<{ type: 'journal/delete-fail'; id: string; error: ApiError }>
  /** «Повернутися до цього»: a revisit conversation with this one record. */
  | Readonly<{ type: 'journal/revisit'; id: string }>

export type Effect =
  | Readonly<{ type: 'url/clean' }> // history.replaceState(null, '', location.pathname)
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
  | Readonly<{ type: 'composer/clear' }> // empty the message field without focusing it
  // the diary (§7.7): GET /summaries?limit=20[&cursor][&q][&tag], GET /tags, GET /reviews/weekly
  | Readonly<{ type: 'journal-list'; req: number; q: string; tag: string | null; cursor: string | null }>
  | Readonly<{ type: 'journal-tags'; req: number }>
  | Readonly<{ type: 'journal-week'; req: number; weekStart: string | null; tz: string | null }>
  | Readonly<{ type: 'patch-summary'; req: number; id: string; body: SummaryPatch }>
  | Readonly<{ type: 'delete-summary'; id: string }>
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
    case 'journal':
      // The conversation it was opened from waits under it. An edit of a record does not count here:
      // «Піти з розмови?» speaks of the conversation. An unsaved edit has its own question,
      // «Скасувати зміни?» (editUnsaved), asked before this one.
      return state.back !== null && hasUserMessage(state.back.session, state.back.pending)
    default:
      return false
  }
}

/** An edit of a diary record whose fields are not the record any more (or fail its check): a way
 *  off the page would drop what the person typed, so it asks first («Скасувати зміни?»), and so
 *  does closing the tab. Unchanged, the form just closes with the page — as «Скасувати» would. */
export function editUnsaved(state: State): boolean {
  if (state.s !== 'journal' || state.edit === null) return false
  const item = journalItem(state, state.edit.form.id)
  if (item === undefined) return false
  const check = patchOf(state.edit.form, item)
  return !(check.ok && check.sent === null)
}

/** The diary opens from a conversation with nothing in flight (a 429 countdown is no request),
 *  from `saved` and from `ended` (spec §7.7). */
export function canOpenJournal(state: State): boolean {
  if (state.s === 'saved' || state.s === 'ended') return true
  return state.s === 'chat' && (state.turn.p === 'idle' || state.turn.p === 'cooldown')
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

/** When the conversation began: the press of its first message (Session.times), null where the
 *  page had no clock. The reminder to pause counts from here (§3.7.7). */
export function conversationStart(session: Session): number | null {
  for (let i = 1; i < session.messages.length; i++) {
    if (session.messages[i]!.role === 'user') return session.times[i] ?? null
  }
  return null
}

/** Is the reminder to pause due, and why (§3.7.7)? 60 replies, or 40 minutes since the first
 *  message — once a conversation: never again after it showed. */
export function pauseDue(session: Session, now: number): 'time' | 'count' | null {
  if (session.pause !== 'none') return null
  if (session.messages.length - 1 >= PAUSE_AFTER_REPLIES) return 'count'
  const start = conversationStart(session)
  return start !== null && Number.isFinite(now) && now - start >= PAUSE_AFTER_MS ? 'time' : null
}

/** When the 40 minutes run out (the page arms one timer for it), or null: no clock, or the
 *  reminder already showed. */
export function pauseAt(session: Session): number | null {
  if (session.pause !== 'none') return null
  const start = conversationStart(session)
  return start === null ? null : start + PAUSE_AFTER_MS
}

/** A marked reply as a thesis: one line, the paused number masked with the short note, as in the
 *  AI's theses (the draft is what gets saved), cut at a word to fit 500 code points — never inside
 *  the note. One line first, the mask after: a number the reply broke over two lines is one number
 *  on the thesis's one line. Then one line again: the mask takes out bidi controls, which leave
 *  their spaces side by side. */
export function markText(content: string): string {
  const flat = oneLine(maskPausedLineShort(oneLine(content))).trim()
  return clampWords(flat, MAX_BULLET, PAUSED_LINE_NOTE_SHORT)
}

export type MarkCandidate = Readonly<{ index: number; text: string }>

/** The draft's id of a thesis taken from the reply at `index`. */
const markId = (index: number): string => `m${index}`

/** The marked replies still waiting on the theses screen: those the draft does not hold yet — a
 *  taken one is a thesis now, «×» and «Повернути» included (§7.2). */
export function markCandidates(review: ReviewState): readonly MarkCandidate[] {
  const taken = new Set(review.draft.bullets.map((b) => b.id))
  return review.session.marks.flatMap((index) => {
    const message = review.session.messages[index]
    return taken.has(markId(index)) || message?.role !== 'assistant' ? [] : [{ index, text: markText(message.content) }]
  })
}

/** «Взяти з собою» on «Збережено» (§7.5): the first saved thesis that came from a mark, as the
 *  server stored it. `sent.bulletIndex` names the field each saved thesis came from. */
function keepOf(review: ReviewState, summary: SummaryOut): string | null {
  const at = review.sent?.bulletIndex.findIndex((id) => id.startsWith('m')) ?? -1
  const text = at < 0 ? undefined : summary.bullets[at]
  return text === undefined || text.trim() === '' ? null : text
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
    times: Object.freeze([null]),
    marks: Object.freeze([]),
    pause: 'none',
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
 *  місці»). After a 413 the block comes back too: the same message would get the same 413. A 429
 *  countdown still running comes back with it: «Надіслати ще раз» waits for its end (§4.3). */
function backToChat(ctx: Ctx, session: Session, pending: Pending | null): ChatState {
  const turn: TurnPhase = ctx.cooldown !== null ? { p: 'cooldown', until: ctx.cooldown } : IDLE
  return chat(session, { pending, turn, notice: pending?.error?.code === 'payload_too_large' ? { kind: 'too-large' } : null })
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

/** A new, empty conversation (§3.6). Clears the announcer when it replaces an old one. Nothing of
 *  the old one carries over: neither its 429 countdown nor its unconfirmed save. */
function startChat(model: Model, init: Readonly<{ afterCrisis?: boolean; wipe?: boolean }> = {}): Step {
  const ctx: Ctx = {
    ...model.ctx,
    wantChat: false,
    afterCrisis: init.afterCrisis ?? model.ctx.afterCrisis,
    cooldown: null,
    maybeSaved: false,
    mood: NO_MOOD,
  }
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
  at: number | null,
): Step {
  const { session } = base
  if (session.scenario === 'revisit' && revisitIds.length === 0) {
    return withState(model, { ...base, turn: IDLE, notice: { kind: 'need-records' } })
  }
  const id = model.ctx.seq + 1
  const frozen = Object.isFrozen(request) ? request : freezeMessages(request)
  const pending: Pending = { text, request: frozen, status: 'sending', error: null, at }
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
    // What «Як ви зараз?» recorded goes with the conversation (selfhelp §5: a tool the crisis
    // interrupts keeps nothing).
    { ...model, ctx: { ...model.ctx, helplines: loaded(helplines), mood: NO_MOOD }, state: { s: 'crisis', helplines, stale: freezeMessages(stale) } },
    [{ type: 'abort', target: 'all' }, { type: 'announcer/clear' }],
  ]
}

function enterResume(model: Model, session: Session | null, pending: Pending | null, resume: Resume, policyVersion: string | null): Step {
  const known = model.ctx.consents?.current_policy_version ?? null
  const policyChanged = policyVersion !== null && known !== null && policyVersion !== known
  return withState(model, consent('resume', { policyChanged, session, pending, resume, loading: true }), [
    { type: 'consents', purpose: 'fresh' },
  ])
}

/** Wipes the session and everything about the account from the page — the account operation too:
 *  reduce() keeps one that is still busy across a screen change. */
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
    op: null,
    mood: NO_MOOD,
  }
  return [
    { ...model, ctx, state: { s: 'signed-out', variant, notice } },
    [{ type: 'abort', target: 'all' }, { type: 'announcer/clear' }],
  ]
}

function accountDeleted(model: Model, variant: 'confirmed' | 'presumed'): Step {
  const ctx: Ctx = {
    ...model.ctx,
    me: null,
    consents: null,
    diary: EMPTY_DIARY,
    authNotice: null,
    wantChat: false,
    deleteAttempt: 'none',
    op: null,
    mood: NO_MOOD,
  }
  return [
    { ...model, ctx, state: { s: 'account-deleted', variant } },
    [{ type: 'abort', target: 'all' }, { type: 'announcer/clear' }],
  ]
}

/** 401 on a protected call: keep what the person wrote, read-only, when there is a session. The
 *  account operation goes with the session: reduce() keeps a busy one across a new screen, and a
 *  401 that keeps `session-expired` would leave it busy for good. */
function unauthenticated(model: Model, session: Session | null, pending: Pending | null, draft: Draft | null): Step {
  const next: Model = model.ctx.op === null ? model : { ...model, ctx: { ...model.ctx, op: null } }
  if (session === null) return signedOut(next, 'fresh', null)
  return withState(next, { s: 'session-expired', stale: session, pending, draft }, [{ type: 'abort', target: 'all' }])
}

/** The revoke is over, whatever screen the page is on. Its answer lets go of the revoke only: an
 *  operation of another name is not its to end. */
function withoutRevoke(model: Model): Model {
  return model.ctx.op?.name !== 'revoke' ? model : { ...model, ctx: { ...model.ctx, op: null } }
}

/** The page as a fresh load has it: no session, no conversation, no account data (§5.6). */
function wiped(model: Model): Step {
  return [
    { state: { s: 'booting' }, overlay: [], ctx: { ...INITIAL_CTX, helplines: model.ctx.helplines, seq: model.ctx.seq } },
    [{ type: 'abort', target: 'all' }, { type: 'announcer/clear' }],
  ]
}

/** Wipe, then boot again: another account answered GET /me on a page restored from the bfcache. */
function reboot(model: Model): Step {
  const [clean, effects] = wiped(model)
  const [next, more] = step(clean, { type: 'boot', search: '' })
  return [next, [...effects, ...more]]
}

/** The account menu and its operations: only with a live session (§8.1). */
function accountReachable(model: Model): boolean {
  const s = model.state.s
  return model.ctx.me !== null && s !== 'signed-out' && s !== 'account-deleted' && s !== 'booting' && s !== 'session-expired'
}

/** The consent to hand the conversation over needs the provider's name and its country (§3.5).
 *  Without the country the page still names the provider wherever it mentions it. */
export function transferAskable(consents: ConsentState | null): boolean {
  const provider = consents?.llm_provider ?? null
  return provider !== null && provider.country !== ''
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
    case 'journal':
      return state.back?.session ?? null
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
    case 'journal':
      return state.back?.pending ?? null
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
  // The diary's PATCH needs no conversation: it may come from `saved` or `ended`.
  if (state.mode === 'resume' && state.resume?.kind === 'patch') return resumeJournal(model, state.resume.journal)
  if (state.mode === 'resume' && state.resume !== null && state.session !== null) {
    const { session, resume } = state
    switch (resume.kind) {
      case 'turn': {
        const text = state.pending?.text ?? lastUserText(resume.request)
        return beginTurn(model, chat(session), resume.request, text, resume.revisitIds, state.pending?.at ?? null)
      }
      case 'summarize':
        return beginSummarize(model, session, state.pending)
      case 'patch':
        return resumeJournal(model, resume.journal)
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

/** `times` of the history after `done` (`length` messages): the times kept so far, the person's
 *  message at its press (or, without one, with the answer), then the answer at `now`. */
function timesAfter(session: Session, length: number, at: number | null, now: number): readonly (number | null)[] {
  const kept: (number | null)[] = session.times.slice(0, Math.max(0, length - 2))
  while (kept.length < length - 2) kept.push(null)
  return Object.freeze([...kept, at ?? now, now])
}

function onTurnOutcome(model: Model, state: ChatState, outcome: TurnOutcome, now: number): Step {
  const turn = state.turn
  if (turn.p === 'idle' || turn.p === 'cooldown') return [model, NONE]
  const request = turn.request
  const pending: Pending = state.pending ?? { text: lastUserText(request), request, status: 'sending', error: null, at: null }
  const fail = (error: UiError, extra: Partial<ChatState> = {}, effects: readonly Effect[] = NONE): Step =>
    withState(model, { ...state, turn: IDLE, pending: { ...pending, status: 'failed', error }, ...extra }, effects)

  switch (outcome.kind) {
    case 'done': {
      if (outcome.text.trim() === '') return fail(uiError('empty_reply', { requestId: outcome.requestId }))
      // I3: the answer joins the history only here. Longer than 4000 code points, the screen keeps
      // it whole and the history keeps 4000, or the next turn would be a 422 (§5.8).
      const messages = freezeMessages([...request, { role: 'assistant', content: clampCodePoints(outcome.text, MAX_CONTENT) }])
      const cut = outcome.finishReason === 'length' ? [...state.session.cut, messages.length - 1] : state.session.cut
      const times = timesAfter(state.session, messages.length, pending.at, now)
      // The reminder to pause comes with an answer, never in the middle of one (§3.7.7).
      const next: Session = { ...state.session, messages, cut, times }
      const why = pauseDue(next, now)
      const session: Session = why === null ? next : { ...next, pause: why }
      return withState(model, { ...state, session, turn: IDLE, pending: null, notice: null })
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
        { ...model, ctx: { ...model.ctx, cooldown: until } },
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

function onSaveFail(model: Model, state: ReviewState, error: ApiError): Step {
  const { session, pending, draft } = state
  // Network, our timeout, a gateway without a body, or a 201 we could not read: the record may
  // exist. The next attempt first looks at the newest record (save-check), so a retry never
  // makes a duplicate (§7.3).
  if (outcomeUnknown(error)) {
    return withState({ ...model, ctx: { ...model.ctx, maybeSaved: true } }, {
      ...state,
      saving: 'unknown',
      error: uiError('save_unknown', { requestId: error.requestId }),
    })
  }
  if (error.status === 401) return unauthenticated(model, session, pending, draft)
  if (error.code === 'not_invited') return notInvited(model, session, pending, draft)
  if (error.code === 'consent_required') return enterResume(model, session, pending, { kind: 'save', draft }, error.policyVersion)
  if (error.code === 'validation_error' && state.sent !== null) {
    const { issues, unmapped } = fieldIssues(error.fields, state.sent)
    return withState(model, { ...state, saving: 'idle', issues, error: unmapped ? toUiError(error) : null })
  }
  const ctx = error.code === 'csrf_failed' ? { ...model.ctx, csrfFailures: model.ctx.csrfFailures + 1 } : model.ctx
  return [{ ...model, ctx, state: { ...state, saving: 'idle', error: toUiError(error) } }, NONE]
}

function saved(model: Model, summary: SummaryOut, keep: string | null = null): Step {
  const state: State = keep === null ? { s: 'saved', summary } : { s: 'saved', summary, keep }
  return [
    { ...model, ctx: { ...model.ctx, diary: { status: 'loading' }, maybeSaved: false }, state },
    [{ type: 'diary' }, { type: 'announcer/clear' }],
  ]
}

/** The theses as the AI drafted them, the paused number masked: the draft is what the page shows,
 *  copies and saves — to the diary and its export file, so with the short note. A field the mask
 *  made longer than its limit is cut at a word, never inside the note: the person must not meet a
 *  length error in a text they did not write. A tag that spells the number goes — a tag names a
 *  topic, and the note would not fit the 40 code points of one. The fields are read on one line,
 *  as every screen draws them (oneLine): a number broken over two lines is masked too, and that
 *  field stays on one line. */
function maskedDraft(out: SummaryDraftOut): SummaryDraftOut {
  return {
    title: maskedField(out.title, MAX_TITLE),
    bullets: out.bullets.map((bullet) => maskedField(bullet, MAX_BULLET)),
    tags: out.tags.filter((tag) => maskPausedLineShort(oneLine(tag)) === oneLine(tag)),
  }
}

function ended(model: Model, effects: readonly Effect[] = NONE): Step {
  return [{ ...model, state: { s: 'ended' } }, [...effects, { type: 'announcer/clear' }]]
}

const STACKED: ReadonlySet<ConfirmKind> = new Set(['logout', 'delete-account', 'revoke'])

function confirmAllowed(model: Model, kind: ConfirmKind, revoke: ConsentKind | undefined, summary?: string): boolean {
  const { state } = model
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
      return accountReachable(model)
    case 'revoke':
      return accountReachable(model) && revoke !== undefined
    case 'delete-summary':
      return state.s === 'journal' && state.deleting === null && summary !== undefined && journalItem(state, summary) !== undefined
    case 'revisit-restart':
      return state.s === 'journal' && !journalBusy(state) && summary !== undefined && journalItem(state, summary) !== undefined && revisitOffered(model.ctx)
    case 'discard-edit':
      return state.s === 'journal' && !journalBusy(state) && editUnsaved(state)
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
  // One account operation at a time: a revoke still on its way (its confirm closed with Esc) must
  // not let a DELETE /me or a logout start beside it — the later answer would land on the wrong
  // screen. «Увійти» and «Завершити» are not account operations and stay free.
  if (STACKED.has(top.kind) && ctx.op?.busy === true) return [model, NONE]
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
      // «Якщо підете, на цій сторінці його вже не буде»: page/left wipes it at pagehide (§5.6).
      return [{ ...popped, ctx: { ...ctx, leaving: true } }, [top.leaveTo === 'reload' ? { type: 'reload' } : { type: 'navigate', href: '/' }]]
    case 'relogin':
      // «Текст цієї розмови зникне зі сторінки»: the same at pagehide.
      return [{ ...popped, ctx: { ...ctx, leaving: true } }, [{ type: 'navigate', href: GOOGLE_START }]]
    case 'logout':
      return beginLogout(model)
    case 'new-after-crisis':
      if (state.s !== 'crisis') return [model, NONE]
      // A consent withdrawn while the contacts were on the screen (a late revoke/ok keeps them):
      // the consent first, then the new conversation with its line about the crisis.
      if (ctx.consents !== null && ctx.consents.missing.length > 0) {
        return [{ ...popped, ctx: { ...ctx, afterCrisis: true }, state: consent('first', { fresh: true }) }, [{ type: 'announcer/clear' }]]
      }
      return startChat(model, { afterCrisis: true, wipe: true })
    case 'delete-account':
      return [
        { ...model, ctx: { ...ctx, op: { name: 'delete-account', busy: true, error: null } } },
        [{ type: 'abort', target: 'all' }, { type: 'delete-me' }],
      ]
    case 'revoke':
      if (top.revoke === null) return [model, NONE]
      return [{ ...model, ctx: { ...ctx, op: { name: 'revoke', busy: true, error: null } } }, [{ type: 'revoke', kind: top.revoke }]]
    case 'delete-summary':
      // The screen stays: the dialog closes here, not by a change of screen.
      if (popped.state.s !== 'journal' || top.summary === undefined || popped.state.deleting !== null) return [popped, NONE]
      return [{ ...popped, state: { ...popped.state, deleting: top.summary, notice: null } }, [{ type: 'delete-summary', id: top.summary }]]
    case 'discard-edit': {
      // «Скасувати зміни»: the edit goes as «Скасувати» would take it, then the page goes the way
      // the person took — which may ask about the conversation under it next (a different question).
      if (popped.state.s !== 'journal' || journalBusy(popped.state)) return [popped, NONE]
      const dropped: Model = { ...popped, state: { ...popped.state, edit: null } }
      if (top.leaveTo === 'home') {
        if (leaveGuard(dropped.state)) return step(dropped, { type: 'confirm/open', kind: 'leave', leaveTo: 'home' })
        return [dropped, [{ type: 'navigate', href: '/' }]]
      }
      return step(dropped, top.summary !== undefined ? { type: 'journal/revisit', id: top.summary } : { type: 'journal/back' })
    }
    case 'revisit-restart': {
      if (popped.state.s !== 'journal' || top.summary === undefined || journalBusy(popped.state)) return [popped, NONE]
      const item = journalItem(popped.state, top.summary)
      // «Текст цієї розмови зникне зі сторінки»: the field's text goes with it.
      return item === undefined ? [popped, NONE] : startRevisit(popped, item, true)
    }
  }
}

/** The screens with «А зараз?»: the conversation is over or about to be (spec §3.13). */
const AFTER_SCREENS: ReadonlySet<State['s']> = new Set(['review', 'saved', 'ended'])

/** A self-help tool (spec §3.13). Never in the crisis — there are no dialogs and no timers there,
 *  the contacts come first (§6.7) — nor while the page boots. Over «Якщо важко» it stacks, so Esc
 *  gives the contacts back; over «В укритті» breathing and grounding stack the same way. Anywhere
 *  else it replaces whatever is open. No request: the tools need nothing from the server. */
function openTool(model: Model, kind: ToolKind, when: MoodWhen | undefined): Step {
  const { state, ctx } = model
  if (state.s === 'crisis' || state.s === 'booting') return [model, NONE]
  const after = kind === 'mood' && when === 'after'
  // «А зараз?» compares with a word from the start: without one there is nothing to ask after. Not
  // while the theses are being saved: «Збережено» would close it half chosen (I6); it asks there.
  if (after && (ctx.mood.before === null || !AFTER_SCREENS.has(state.s))) return [model, NONE]
  if (after && state.s === 'review' && state.saving === 'saving') return [model, NONE]
  const overlay: ToolOverlay = kind === 'mood' ? { o: 'mood', when: after ? 'after' : 'before' } : { o: kind }
  const top = topOverlay(model)
  if (top !== undefined && top.o === overlay.o) return [model, NONE]
  const stacks = top !== undefined && (top.o === 'help' || (top.o === 'shelter' && (kind === 'breathe' || kind === 'ground')))
  return [{ ...model, overlay: stacks ? [...model.overlay, overlay] : [overlay] }, NONE]
}

/** The tool open on top, if any. */
export function topTool(model: Model): ToolOverlay | null {
  const top = topOverlay(model)
  return top !== undefined && (top.o === 'breathe' || top.o === 'ground' || top.o === 'mood' || top.o === 'shelter') ? top : null
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

// ── The diary (spec §7.7) ──

/** «Повернутися до цього» needs the revisit scenario (a failed GET /scenarios leaves only free). */
export function revisitOffered(ctx: Ctx): boolean {
  return scenariosOf(ctx).some((s) => s.id === 'revisit')
}

function journalItem(state: JournalState, id: string): SummaryOut | undefined {
  return state.list?.items.find((item) => item.id === id)
}

/** A PATCH or a DELETE is on its way: the page stays until its answer (the way out waits). */
export function journalBusy(state: JournalState): boolean {
  return state.edit?.saving === true || state.deleting !== null
}

/** One more request id (ctx.seq): an answer with another id is stale. */
function nextReq(model: Model): [Model, number] {
  const req = model.ctx.seq + 1
  return [{ ...model, ctx: { ...model.ctx, seq: req } }, req]
}

function journalList(model: Model, state: JournalState, cursor: string | null): Step {
  const [next, req] = nextReq(model)
  const journal: JournalState = { ...state, loading: true, failed: false, cursor, req }
  return [{ ...next, state: journal }, [{ type: 'journal-list', req, q: journal.q, tag: journal.tag, cursor }]]
}

function journalWeek(model: Model, state: JournalState, weekStart: string | null, tz: string | null = state.tz): Step {
  const [next, req] = nextReq(model)
  const journal: JournalState = { ...state, tz, week: { ...state.week, review: { status: 'loading' }, req } }
  return [{ ...next, state: journal }, [{ type: 'journal-week', req, weekStart, tz }]]
}

/** GET /tags, stamped: only the answer to the last one counts. Themes already shown stay up while
 *  it is on its way (no pills flicker after a change); none yet, they load. */
function journalTags(model: Model, state: JournalState): Step {
  const [next, req] = nextReq(model)
  const journal: JournalState = { ...state, tags: state.tags.status === 'ok' ? state.tags : { status: 'loading' }, tagsReq: req }
  return [{ ...next, state: journal }, [{ type: 'journal-tags', req }]]
}

function openJournal(model: Model, tz: string | null): Step {
  const { state } = model
  const back: JournalBack | null =
    state.s === 'chat' ? { session: state.session, pending: state.pending, revertTo: state.revertTo, gone: state.notice?.kind === 'revisit-gone' } : null
  const journal: JournalState = {
    s: 'journal',
    back,
    tz,
    q: '',
    tag: null,
    list: null,
    loading: false,
    failed: false,
    cursor: null,
    req: 0,
    tags: { status: 'loading' },
    tagsReq: 0,
    week: { start: null, current: null, review: { status: 'loading' }, req: 0 },
    edit: null,
    deleting: null,
    notice: null,
  }
  // Lazily, on the way in (never at the page's start): the week, the themes, the first page.
  const [weekModel, weekFx] = journalWeek(model, journal, null)
  const [tagsModel, tagsFx] = journalTags(weekModel, weekModel.state as JournalState)
  const [listModel, listFx] = journalList(tagsModel, tagsModel.state as JournalState, null)
  return [listModel, [...weekFx, ...tagsFx, ...listFx]]
}

/** After a PATCH or a DELETE: the themes (an orphan tag is gone) and the week shown are asked for
 *  again; the page's diary changes in place (diaryAfter). */
function afterChange(model: Model, state: JournalState, change: Parameters<typeof diaryAfter>[1]): Step {
  const [weekModel, weekFx] = state.week.start !== null || state.week.review.status !== 'loading' ? journalWeek(model, state, state.week.start) : [{ ...model, state }, NONE]
  const [tagsModel, tagsFx] = journalTags(weekModel, weekModel.state as JournalState)
  const [diaryModel, diaryFx] = diaryAfter(tagsModel, change)
  return [diaryModel, [...weekFx, ...tagsFx, ...diaryFx]]
}

function beginPatch(model: Model, state: JournalState, sent: PatchSent): Step {
  if (state.edit === null) return withState(model, state)
  const [next, req] = nextReq(model)
  const edit: JournalEdit = { ...state.edit, saving: true, error: null, issues: [], sent, req }
  return [{ ...next, state: { ...state, edit, notice: null } }, [{ type: 'patch-summary', req, id: state.edit.form.id, body: sent.body }]]
}

/** Back from the consent a PATCH asked for: the diary as it was. What it had on its way then was
 *  answered while the consent was up (and ignored there): it is asked for again. A DELETE that was
 *  on its way is not — its answer is lost, so the record is no longer marked as going (or the page
 *  would wait for it for good); pressed again, a 404 says it is gone. */
function resumeJournal(model: Model, saved: JournalState): Step {
  const snapshot: JournalState = saved.deleting === null ? saved : { ...saved, deleting: null }
  let step: Step = [{ ...model, state: snapshot }, NONE]
  const effects: Effect[] = []
  const then = (next: Step): void => {
    step = next
    effects.push(...next[1])
  }
  if (snapshot.loading) then(journalList(step[0], step[0].state as JournalState, snapshot.cursor))
  if (snapshot.week.review.status === 'loading') then(journalWeek(step[0], step[0].state as JournalState, snapshot.week.start))
  if (snapshot.tags.status === 'loading') then(journalTags(step[0], step[0].state as JournalState))
  const journal = step[0].state as JournalState
  const sent = journal.edit?.sent ?? null
  if (sent === null) return [step[0], effects]
  const [patched, patchFx] = beginPatch(step[0], journal, sent)
  return [patched, [...effects, ...patchFx]]
}

const without = (list: Diary | null, id: string): Diary | null =>
  list === null ? null : { items: list.items.filter((item) => item.id !== id), nextCursor: list.nextCursor }

/** A new first page (a search, a theme, a theme gone) while a record is edited: the record keeps its
 *  row, first, with its form — or «Зберегти» would find no record and drop what was typed. Closed,
 *  it is a record like any other again. */
function keepEdited(page: Diary, state: JournalState): Diary {
  const id = state.edit?.form.id
  if (id === undefined || page.items.some((item) => item.id === id)) return page
  const item = journalItem(state, id)
  return item === undefined ? page : { items: [item, ...page.items], nextCursor: page.nextCursor }
}

/** The page's diary (ctx.diary: the record picker and «Ви повертаєтеся до:» read it) after a PATCH
 *  or a record gone: changed in place, no GET — a GET would leave a moment where a record taken
 *  back has no name. Emptied while more records stand behind it, it asks for the first page again.
 *  Not loaded (or still loading), it stays as it is: the answer on its way stands. */
function diaryAfter(model: Model, change: Readonly<{ patched: SummaryOut }> | Readonly<{ dropped: string }>): Step {
  const { diary } = model.ctx
  if (diary.status !== 'ok') return [model, NONE]
  const { items, nextCursor } = diary.value
  const next =
    'patched' in change
      ? items.map((item) => (item.id === change.patched.id ? change.patched : item))
      : items.filter((item) => item.id !== change.dropped)
  if (next.length === 0 && nextCursor !== null) return [{ ...model, ctx: { ...model.ctx, diary: { status: 'loading' } } }, [{ type: 'diary' }]]
  return [{ ...model, ctx: { ...model.ctx, diary: loaded({ items: next, nextCursor }) } }, NONE]
}

/** Records chosen for a revisit keep their names in the page's diary when a first page replaces
 *  it: those of `from` among `ids` that the page does not have, after it. */
function keepChosen(page: Diary, ids: readonly string[], from: readonly SummaryOut[]): Diary {
  const extra: SummaryOut[] = []
  for (const id of ids) {
    if (page.items.some((item) => item.id === id) || extra.some((item) => item.id === id)) continue
    const item = from.find((x) => x.id === id)
    if (item !== undefined) extra.push(item)
  }
  return extra.length === 0 ? page : { items: [...page.items, ...extra], nextCursor: page.nextCursor }
}

/** A record left the diary (deleted, or gone meanwhile): off the list, its edit closed. A page it
 *  leaves empty while more records stand behind it is asked for again from the top: «Тут
 *  зʼявляться тези…» over a diary that has them would be untrue. */
function dropRecord(model: Model, state: JournalState, id: string, notice: JournalNotice): Step {
  const journal: JournalState = {
    ...state,
    list: without(state.list, id),
    edit: state.edit?.form.id === id ? null : state.edit,
    deleting: state.deleting === id ? null : state.deleting,
    notice,
  }
  const [changed, effects] = afterChange(model, journal, { dropped: id })
  const after = changed.state as JournalState
  if (after.loading || after.list === null || after.list.items.length > 0 || after.list.nextCursor === null) return [changed, effects]
  const [listed, listFx] = journalList(changed, after, null)
  return [listed, [...effects, ...listFx]]
}

/** «Повернутися до цього»: a new conversation in «Повернення до теми» with this record chosen.
 *  Its name must be in ctx.diary for «Ви повертаєтеся до:» (a record found by a search or on a
 *  later page is not on the first page the page loaded). `wipe`: a conversation is replaced. */
function startRevisit(model: Model, item: SummaryOut, wipe: boolean): Step {
  const { ctx } = model
  const diary: Loadable<Diary> =
    ctx.diary.status === 'ok'
      ? ctx.diary.value.items.some((x) => x.id === item.id)
        ? loaded({ items: ctx.diary.value.items.map((x) => (x.id === item.id ? item : x)), nextCursor: ctx.diary.value.nextCursor })
        : loaded({ items: [...ctx.diary.value.items, item], nextCursor: ctx.diary.value.nextCursor })
      : // Not loaded yet (or failed): the record alone. A first page still on its way is dropped — it
        // would replace the diary without this record; the picker loads its own first page.
        loaded({ items: [item], nextCursor: null })
  const next: Ctx = { ...ctx, wantChat: false, cooldown: null, maybeSaved: false, diary, mood: NO_MOOD }
  const session: Session = { ...freshSession(next, 'revisit', false), revisitIds: Object.freeze([item.id]) }
  const effects: readonly Effect[] = wipe ? [{ type: 'composer/clear' }, { type: 'announcer/clear' }] : NONE
  return [{ ...model, ctx: next, state: chat(session, { revertTo: 'free' }) }, effects]
}

function onPatchFail(model: Model, state: JournalState, edit: JournalEdit, error: ApiError): Step {
  const back = state.back
  const idle: JournalState = { ...state, edit: { ...edit, saving: false } }
  if (error.status === 401) return unauthenticated(model, back?.session ?? null, back?.pending ?? null, null)
  if (error.code === 'not_invited') return notInvited(model, back?.session ?? null, back?.pending ?? null, null)
  if (error.code === 'consent_required') {
    return enterResume(model, back?.session ?? null, back?.pending ?? null, { kind: 'patch', journal: idle }, error.policyVersion)
  }
  if (error.code === 'not_found') return dropRecord(model, state, edit.form.id, { kind: 'gone' })
  if (error.code === 'validation_error' && edit.sent !== null) {
    const { issues, unmapped } = fieldIssues(error.fields, edit.sent.index)
    return withState(model, { ...idle, edit: { ...idle.edit!, issues, error: unmapped ? toUiError(error) : null } })
  }
  const next: Model = error.code === 'csrf_failed' ? { ...model, ctx: { ...model.ctx, csrfFailures: model.ctx.csrfFailures + 1 } } : model
  return withState(next, { ...idle, edit: { ...idle.edit!, error: toUiError(error) } })
}

function journalStep(model: Model, state: JournalState, action: Action): Step | null {
  const { ctx } = model
  switch (action.type) {
    case 'journal/back':
      // A PATCH or a DELETE on its way: its answer is this page's to show (saved, failed, consent).
      if (journalBusy(state)) return [model, NONE]
      // Typed into a record and not saved: ask before it goes.
      if (editUnsaved(state)) return step(model, { type: 'confirm/open', kind: 'discard-edit' })
      if (state.back === null) return startChat(model)
      {
        const { session, pending, revertTo, gone } = state.back
        const back = backToChat(ctx, session, pending)
        return withState(model, { ...back, revertTo, notice: gone ? { kind: 'revisit-gone' } : back.notice })
      }
    case 'journal/search': {
      const q = searchQuery(action.q)
      if (q === state.q && !state.failed && state.list !== null) return [model, NONE]
      return journalList(model, { ...state, q, notice: null }, null)
    }
    case 'journal/tag':
      if (action.id === state.tag) return [model, NONE]
      return journalList(model, { ...state, tag: action.id, notice: null }, null)
    case 'journal/more':
      if (state.loading || state.list?.nextCursor == null) return [model, NONE]
      return journalList(model, state, state.list.nextCursor)
    case 'journal/retry':
      if (state.loading) return [model, NONE]
      return journalList(model, state, state.list === null ? null : state.cursor)
    case 'journal/list-ok': {
      if (action.req !== state.req || !state.loading) return [model, NONE]
      let list: Diary
      if (state.cursor === null) list = keepEdited(action.diary, state)
      else if (state.list !== null && state.list.nextCursor === state.cursor) {
        list = { items: [...state.list.items, ...action.diary.items.filter((item) => !state.list!.items.some((x) => x.id === item.id))], nextCursor: action.diary.nextCursor }
      } else return withState(model, { ...state, loading: false })
      return withState(model, { ...state, list, loading: false, failed: false })
    }
    case 'journal/list-fail':
      if (action.req !== state.req || !state.loading) return [model, NONE]
      if (action.error.status === 401) return unauthenticated(model, sessionOf(state), pendingOf(state), null)
      return withState(model, { ...state, loading: false, failed: true })
    case 'journal/tags-ok': {
      // Only the last GET /tags: an older answer landing later would bring back a theme gone since.
      if (action.req !== state.tagsReq) return [model, NONE]
      const tags = loaded(action.tags)
      // The theme filtered by is gone (its last record changed or went): the whole list again.
      if (state.tag !== null && !action.tags.some((t) => t.id === state.tag)) return journalList(model, { ...state, tags, tag: null }, null)
      return withState(model, { ...state, tags })
    }
    case 'journal/tags-fail':
      if (action.req !== state.tagsReq) return [model, NONE]
      if (action.error.status === 401) return unauthenticated(model, sessionOf(state), pendingOf(state), null)
      // Themes already shown stay (a refresh after a change failed): without them a theme filter
      // could not be taken off.
      if (state.tags.status === 'ok') return [model, NONE]
      return withState(model, { ...state, tags: { status: 'failed' } })
    case 'journal/week': {
      const { start, current } = state.week
      if (start === null || state.week.review.status === 'loading') return [model, NONE]
      const to = shiftDay(start, 7 * action.step)
      if (to === null || (action.step === 1 && (current === null || to > current))) return [model, NONE]
      return journalWeek(model, { ...state, week: { ...state.week, start: to } }, to)
    }
    case 'journal/week-retry':
      if (state.week.review.status === 'loading') return [model, NONE]
      return journalWeek(model, state, state.week.start)
    case 'journal/week-ok': {
      if (action.req !== state.week.req) return [model, NONE]
      const { review } = action
      return withState(model, {
        ...state,
        week: { start: review.week_start, current: state.week.current ?? review.week_start, review: loaded(review), req: state.week.req },
      })
    }
    case 'journal/week-fail': {
      if (action.req !== state.week.req) return [model, NONE]
      if (action.error.status === 401) return unauthenticated(model, sessionOf(state), pendingOf(state), null)
      // A zone the server does not know (an old browser's alias): once more with its default.
      if (action.error.code === 'invalid_timezone' && state.tz !== FALLBACK_TZ) return journalWeek(model, state, state.week.start, FALLBACK_TZ)
      return withState(model, { ...state, week: { ...state.week, review: { status: 'failed' } } })
    }
    case 'journal/edit': {
      // One at a time, and not a record whose DELETE is on its way.
      if (state.edit !== null || state.deleting === action.id) return [model, NONE]
      const item = journalItem(state, action.id)
      if (item === undefined) return [model, NONE]
      return withState(model, { ...state, notice: null, edit: { form: formOf(item), saving: false, error: null, issues: [], sent: null, req: 0 } })
    }
    case 'journal/edit-update':
      if (state.edit === null || state.edit.saving || action.form.id !== state.edit.form.id) return [model, NONE]
      return withState(model, { ...state, edit: { ...state.edit, form: action.form, issues: [], error: null } })
    case 'journal/edit-add': {
      const edit = state.edit
      if (edit === null || edit.saving || edit.form.bullets.length >= MAX_BULLETS) return [model, NONE]
      return withState(model, { ...state, edit: { ...edit, form: { ...edit.form, bullets: [...edit.form.bullets, ''] } } })
    }
    case 'journal/edit-cancel':
      if (state.edit === null || state.edit.saving) return [model, NONE]
      return withState(model, { ...state, edit: null })
    case 'journal/edit-save': {
      const edit = state.edit
      if (edit === null || edit.saving) return [model, NONE]
      const item = journalItem(state, edit.form.id)
      if (item === undefined) return withState(model, { ...state, edit: null })
      const check = patchOf(edit.form, item)
      if (!check.ok) return withState(model, { ...state, edit: { ...edit, issues: check.issues, error: null } })
      // Nothing changed: the form closes without a PATCH (it would stamp «змінено»).
      if (check.sent === null) return withState(model, { ...state, edit: null })
      return beginPatch(model, state, check.sent)
    }
    case 'journal/patch-ok': {
      const edit = state.edit
      if (edit === null || !edit.saving || edit.req !== action.req) return [model, NONE]
      const list = state.list === null ? null : { ...state.list, items: state.list.items.map((item) => (item.id === action.summary.id ? action.summary : item)) }
      return afterChange(model, { ...state, list, edit: null, notice: { kind: 'saved' } }, { patched: action.summary })
    }
    case 'journal/patch-fail': {
      const edit = state.edit
      if (edit === null || !edit.saving || edit.req !== action.req) return [model, NONE]
      return onPatchFail(model, state, edit, action.error)
    }
    case 'journal/delete-ok':
      if (state.deleting !== action.id) return [model, NONE]
      return dropRecord(model, state, action.id, { kind: 'deleted' })
    case 'journal/delete-fail': {
      if (state.deleting !== action.id) return [model, NONE]
      const error = action.error
      if (error.status === 401) return unauthenticated(model, sessionOf(state), pendingOf(state), null)
      // Already gone (another tab, a repeat after a lost answer): what the person asked for.
      if (error.code === 'not_found') return dropRecord(model, state, action.id, { kind: 'deleted' })
      const next: Model = error.code === 'csrf_failed' ? { ...model, ctx: { ...ctx, csrfFailures: ctx.csrfFailures + 1 } } : model
      return withState(next, { ...state, deleting: null, notice: { kind: 'delete-failed', error: toUiError(error) } })
    }
    case 'journal/revisit': {
      const item = journalItem(state, action.id)
      if (item === undefined || !revisitOffered(ctx) || journalBusy(state)) return [model, NONE]
      // Typed into a record and not saved: that first.
      if (editUnsaved(state)) return step(model, { type: 'confirm/open', kind: 'discard-edit', summary: item.id })
      // A conversation under way would be replaced: ask first.
      if (state.back !== null && hasUserMessage(state.back.session, state.back.pending)) {
        return step(model, { type: 'confirm/open', kind: 'revisit-restart', summary: item.id })
      }
      return startRevisit(model, item, false)
    }
    default:
      return null
  }
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
      if (action.purpose === 'pageshow') {
        // Another account signed in meanwhile (a shared computer): the old conversation must not go
        // on under its session. Wipe and start over as that account (§5.6).
        if (ctx.me !== null && action.me.id !== ctx.me.id) return reboot(model)
        return [{ ...model, ctx: { ...ctx, me: action.me } }, NONE]
      }
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
      // Only pagehide aborts the boot (its deadline is 'timeout'): the page stays `booting`, and
      // a restore from the bfcache boots it again (page/show) instead of «немає зʼєднання».
      if (action.error.code === 'aborted') return [model, NONE]
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
        if (action.error.code === 'aborted') return [model, NONE]
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
      // Only an answer someone waits for: a late one must not bring back a diary that a revoke, a
      // deleted account or a sign-out has erased meanwhile (§8.6). After a failure a second load
      // may still be on its way (a page restored and booted again), and its answer counts.
      if (ctx.diary.status !== 'loading' && ctx.diary.status !== 'failed') return [model, NONE]
      return [{ ...model, ctx: { ...ctx, diary: loaded(action.diary) } }, NONE]
    case 'diary/fail': {
      if (ctx.diary.status !== 'loading') return [model, NONE]
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
      if (!action.persisted) return [model, NONE]
      // Wiped at pagehide (page/left): start over the way a fresh load would.
      if (state.s === 'booting') return step(model, { type: 'boot', search: '' })
      if (ctx.me === null) return [model, NONE]
      return [model, [{ type: 'me', purpose: 'pageshow', timeoutMs: BOOT_TIMEOUT }]]
    case 'page/left':
      // The crisis: whatever way out the person took, the conversation under <details> does not
      // wait in the bfcache; the contacts stay (§6).
      if (state.s === 'crisis') return state.stale.length === 0 ? [model, NONE] : withState(model, { ...state, stale: [] })
      // «Піти», «Увійти знову»: the page promised the text would be gone (§3.12, §5.6).
      if (!ctx.leaving) return [model, NONE]
      return wiped(model)

    // ── consent ──
    case 'consent/agree': {
      if (state.s !== 'consent' || state.loading || state.submitting) return [model, NONE]
      // The fresh GET failed (or a 409 made the data old): ctx.consents still holds the boot
      // answer — missing = [] or an outdated version. Ask again instead of acting on it (§2.4,
      // §3.5); the boxes reset when the answer comes.
      if (!state.fresh) return withState(model, { ...state, loading: true, error: null }, [{ type: 'consents', purpose: 'fresh' }])
      const consents = ctx.consents
      // No named and located provider, no consent to hand it the conversation (§3.5).
      if (consents === null || !transferAskable(consents)) return withState(model, { ...state, error: uiError('provider_missing') })
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
      return beginTurn(model, state, request, action.text, session.revisitIds, action.now ?? null)
    }
    case 'chat/resend': {
      if (state.s !== 'chat' || state.turn.p !== 'idle' || state.pending === null || state.pending.status === 'sending') return [model, NONE]
      if (state.notice?.kind === 'too-large' || state.notice?.kind === 'revisit-gone') return [model, NONE]
      // I4: the same frozen request, not a rebuilt one.
      return beginTurn(model, state, state.pending.request, state.pending.text, state.session.revisitIds, state.pending.at)
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
    case 'chat/mark': {
      // Only in a running conversation: the crisis, read-only copies and the theses have no marks
      // to set. The opening message is not a reply.
      if (state.s !== 'chat' || !Number.isInteger(action.index) || action.index <= 0) return [model, NONE]
      const { session } = state
      if (session.messages[action.index]?.role !== 'assistant') return [model, NONE]
      const on = session.marks.includes(action.index)
      if (!on && session.marks.length >= MAX_MARKS) return [model, NONE]
      const marks = Object.freeze(on ? session.marks.filter((i) => i !== action.index) : [...session.marks, action.index])
      return withState(model, { ...state, session: { ...session, marks } })
    }
    case 'chat/pause-due': {
      // Between answers only: a reminder that comes while the AI writes waits for its `done`.
      if (state.s !== 'chat' || (state.turn.p !== 'idle' && state.turn.p !== 'cooldown')) return [model, NONE]
      const why = pauseDue(state.session, action.now)
      return why === null ? [model, NONE] : withState(model, { ...state, session: { ...state.session, pause: why } })
    }
    case 'chat/pause-hide':
      if (state.s !== 'chat' || (state.session.pause !== 'time' && state.session.pause !== 'count')) return [model, NONE]
      return withState(model, { ...state, session: { ...state.session, pause: 'hidden' } })
    case 'chat/pause-collect': {
      // «Зібрати тези» goes the way «Завершити розмову» goes: through the confirm that says the
      // text goes to the AI's provider once more (§3.7.8). While an answer comes, nothing.
      if (state.s !== 'chat' || (state.session.pause !== 'time' && state.session.pause !== 'count')) return [model, NONE]
      if (!confirmAllowed(model, 'end', undefined)) return [model, NONE]
      const [hidden] = withState(model, { ...state, session: { ...state.session, pause: 'hidden' } })
      return step(hidden, { type: 'confirm/open', kind: 'end' })
    }
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
    case 'cooldown/end': {
      // Over wherever the person is (the theses, say): back in the conversation it is not restored.
      const next: Model = ctx.cooldown === action.until ? { ...model, ctx: { ...ctx, cooldown: null } } : model
      if (state.s !== 'chat' || state.turn.p !== 'cooldown' || state.turn.until !== action.until) return [next, NONE]
      return withState(next, { ...state, turn: IDLE })
    }

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
      // A record chosen from a search or a later page: its name goes into the page's diary now, for
      // «Ви повертаєтеся до:» — the list it came from may be gone by «Продовжити».
      const item = has ? undefined : top.list?.items.find((x) => x.id === action.id)
      const named: Model = item !== undefined && ctx.diary.status === 'ok' ? { ...model, ctx: { ...ctx, diary: loaded(keepChosen(ctx.diary.value, [item.id], [item])) } } : model
      return [replaceTop(named, { ...top, selected }), NONE]
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
      let next: Model = model
      if (firstPage) {
        // The first page is the page's diary now; the records chosen keep their names in it. Not after
        // a 404: one of them is gone, and the page shows the diary as the server has it.
        const top = topPick(model)
        const chosen = action.purpose === 'pick' ? [...(state.s === 'chat' ? state.session.revisitIds : []), ...(top?.selected ?? [])] : []
        const from = [...(ctx.diary.status === 'ok' ? ctx.diary.value.items : []), ...(top?.list?.items ?? [])]
        next = { ...model, ctx: { ...ctx, diary: loaded(keepChosen(action.diary, chosen, from)) } }
      }
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
        return beginTurn(popped, base, state.pending.request, state.pending.text, top.selected, state.pending.at)
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
        draft: draftFromOut(maskedDraft(action.draft)),
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
      return withState(model, backToChat(ctx, state.session, state.pending), [{ type: 'abort', target: 'summarize' }])
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
      return withState(model, backToChat(ctx, state.session, state.pending))
    case 'review/take': {
      // Not while saving or after an unknown result (the draft is read-only then, §7.3), and never
      // past five theses: a full draft says so beside the candidate instead (§7.2).
      if (state.s !== 'review' || state.saving !== 'idle') return [model, NONE]
      const candidate = markCandidates(state).find((c) => c.index === action.index)
      const active = state.draft.bullets.filter((b) => !b.removed).length
      if (candidate === undefined || active >= MAX_BULLETS) return [model, NONE]
      const bullets = [...state.draft.bullets, { id: markId(candidate.index), text: candidate.text, removed: false }]
      return withState(model, { ...state, draft: { ...state.draft, bullets }, issues: [], error: null })
    }
    case 'review/unmark': {
      if (state.s !== 'review' || state.saving !== 'idle' || !state.session.marks.includes(action.index)) return [model, NONE]
      const marks = Object.freeze(state.session.marks.filter((i) => i !== action.index))
      return withState(model, { ...state, session: { ...state.session, marks } })
    }
    case 'save/ok':
      if (state.s !== 'review' || state.id !== action.id || state.saving !== 'saving') return [model, NONE]
      return saved(model, action.summary, keepOf(state, action.summary))
    case 'save/fail':
      if (state.s !== 'review' || state.id !== action.id || state.saving !== 'saving') return [model, NONE]
      return onSaveFail(model, state, action.error)
    case 'save/check': {
      if (state.s !== 'review' || state.id !== action.id || state.saving !== 'saving' || state.sent === null) return [model, NONE]
      const newest = action.list.items[0]
      if (newest !== undefined && matchesSaved(state.sent.body, newest, action.date)) return saved(model, newest, keepOf(state, newest))
      // The newest record is not ours: the earlier POST did not land. This one may again.
      return [{ ...model, ctx: { ...ctx, maybeSaved: false } }, [{ type: 'save', id: state.id, body: state.sent.body }]]
    }
    case 'save/check-fail':
      if (state.s !== 'review' || state.id !== action.id || state.saving !== 'saving') return [model, NONE]
      if (action.error.status === 401) return unauthenticated(model, state.session, state.pending, state.draft)
      // Still unknown: never POST blind.
      return withState({ ...model, ctx: { ...ctx, maybeSaved: true } }, {
        ...state,
        saving: 'unknown',
        error: uiError('save_unknown', { requestId: action.error.requestId }),
      })

    // ── overlays and the account ──
    case 'overlay/open': {
      if (isToolKind(action.overlay)) return openTool(model, action.overlay, action.when)
      if (action.overlay === 'account') return accountReachable(model) ? [{ ...model, overlay: [{ o: 'account' }] }, NONE] : [model, NONE]
      const opened: Model = { ...model, overlay: [{ o: 'help' }] }
      if (ctx.helplines.status !== 'idle') return [opened, NONE]
      return [{ ...opened, ctx: { ...ctx, helplines: { status: 'loading' } } }, [{ type: 'helplines' }]]
    }
    case 'confirm/open': {
      if (!confirmAllowed(model, action.kind, action.revoke, action.summary)) return [model, NONE]
      const overlay: Overlay = {
        o: 'confirm',
        kind: action.kind,
        revoke: action.revoke ?? null,
        leaveTo: action.kind === 'leave' ? (action.leaveTo ?? 'home') : action.kind === 'discard-edit' && action.leaveTo === 'home' ? 'home' : null,
        back: false,
        // Only where it means something: the other confirms keep their shape.
        ...(action.summary !== undefined && (action.kind === 'delete-summary' || action.kind === 'revisit-restart' || action.kind === 'discard-edit')
          ? { summary: action.summary }
          : {}),
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
    case 'mood/pick': {
      const top = topOverlay(model)
      if (top === undefined || top.o !== 'mood' || !isMoodWord(action.word)) return [model, NONE]
      const { mood } = ctx
      // The first word of the conversation stays its «спершу»; a later check-in in the middle
      // records nothing new (it names the feeling, or goes into the field). «А зараз?» is the end.
      const next: MoodLog =
        top.when === 'after' ? { ...mood, after: action.word } : mood.before === null ? { ...mood, before: action.word } : mood
      return [{ ...model, overlay: model.overlay.slice(0, -1), ctx: next === mood ? ctx : { ...ctx, mood: next } }, NONE]
    }
    case 'account/logout':
      if (!accountReachable(model) || ctx.op?.busy === true) return [model, NONE]
      // A conversation, or a record's unsaved edit, would go with the session: ask first.
      if (leaveGuard(state) || editUnsaved(state)) return step(model, { type: 'confirm/open', kind: 'logout' })
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
      // A late answer after the session ended (signed out, account deleted, 401 meanwhile) changes
      // no screen; it only lets go of the revoke.
      if (!accountReachable(model)) return [withoutRevoke(model), NONE]
      // Withdrawing data_processing erases the journal on the server: drop it here too, or the
      // revisit picker would offer deleted records (§8.6).
      const diary = action.kind === 'data_processing' ? EMPTY_DIARY : ctx.diary
      const me = ctx.me === null ? null : { ...ctx.me, consents_ok: false }
      // The revoke is over; an operation of another name is not this answer's to end.
      const op = ctx.op?.name === 'revoke' ? null : ctx.op
      const account: Ctx = { ...ctx, consents: action.consents, diary, me, op }
      if (state.s === 'crisis') {
        // I5: the contacts stay. Only the account data changes, and the revoke's own confirm (if
        // it is still on top) closes; the consent comes with «Почати нову розмову».
        const top = topOverlay(model)
        const overlay = top?.o === 'confirm' && top.kind === 'revoke' ? model.overlay.slice(0, -1) : model.overlay
        return [{ ...model, overlay, ctx: account }, NONE]
      }
      // Closed explicitly: revoking from the consent screen keeps `s`, so reduce() would not.
      return [
        { state: consent('first', { fresh: true }), overlay: [], ctx: account },
        [{ type: 'abort', target: 'all' }, { type: 'announcer/clear' }],
      ]
    }
    case 'journal/open':
      if (!canOpenJournal(state)) return [model, NONE]
      return openJournal(model, action.tz)
    case 'journal/back':
    case 'journal/search':
    case 'journal/tag':
    case 'journal/more':
    case 'journal/retry':
    case 'journal/list-ok':
    case 'journal/list-fail':
    case 'journal/tags-ok':
    case 'journal/tags-fail':
    case 'journal/week':
    case 'journal/week-retry':
    case 'journal/week-ok':
    case 'journal/week-fail':
    case 'journal/edit':
    case 'journal/edit-update':
    case 'journal/edit-add':
    case 'journal/edit-cancel':
    case 'journal/edit-save':
    case 'journal/patch-ok':
    case 'journal/patch-fail':
    case 'journal/delete-ok':
    case 'journal/delete-fail':
    case 'journal/revisit':
      // Only on the diary: an answer that comes after it was left changes nothing.
      return state.s === 'journal' ? (journalStep(model, state, action) ?? [model, NONE]) : [model, NONE]
    case 'revoke/fail':
      // The same for a late failure: a 401 must not turn «акаунт видалено» into the sign-in screen.
      if (!accountReachable(model)) return [withoutRevoke(model), NONE]
      if (action.error.status === 401) return unauthenticated(model, sessionOf(state), pendingOf(state), draftOf(state))
      // Only the revoke's own operation takes its failure: a DELETE /me under way stays as it is.
      if (ctx.op?.name !== 'revoke') return [model, NONE]
      return [{ ...model, ctx: { ...ctx, op: { name: 'revoke', busy: false, error: toUiError(action.error) } } }, NONE]
  }
}

/** The single entry point. A new screen closes every overlay (I6; focus goes to its h1 in
 *  ui/render.ts) and forgets the account operation that led there — unless it is still under
 *  way: «one account operation at a time» holds until its answer comes, on whatever screen. */
export function reduce(model: Model, action: Action): Step {
  const [next, effects] = step(model, action)
  if (next.state.s === model.state.s) return [next, effects]
  const op = next.ctx.op
  return [{ ...next, overlay: [], ctx: op === null || op.busy ? next.ctx : { ...next.ctx, op: null } }, effects]
}
