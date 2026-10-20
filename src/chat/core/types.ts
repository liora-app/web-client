// Liora API DTOs, as server/openapi.json describes them (server @ 628a571).
//
// Pure types and constants: the chat core (src/chat/core) has no DOM, no browser globals and no
// three.js, so the same logic can move to the mobile client later (ADR-007).

export const SCENARIO_IDS = ['free', 'situation', 'day', 'revisit'] as const
export type KnownScenarioId = (typeof SCENARIO_IDS)[number]
/** The four known ids, but the client keeps working with a scenario the server adds later. */
export type ScenarioId = KnownScenarioId | (string & {})

export const CONSENT_KINDS = ['data_processing', 'llm_transfer', 'age_18'] as const
export type ConsentKind = (typeof CONSENT_KINDS)[number]

export type Role = 'user' | 'assistant'
export type TagSource = 'ai' | 'user'

/** ChatMessageIn: content is 1..4000 Python code points (limits.ts counts the same way). */
export type ChatMessage = Readonly<{ role: Role; content: string }>

export type MeOut = Readonly<{ id: string; email: string; created_at: string; consents_ok: boolean }>

export type GrantedConsent = Readonly<{ kind: ConsentKind; policy_version: string; granted_at: string }>
export type LLMProviderInfo = Readonly<{ name: string; country: string }>

export type ConsentState = Readonly<{
  current_policy_version: string
  required: readonly ConsentKind[]
  granted: readonly GrantedConsent[]
  missing: readonly ConsentKind[]
  /** Required by the schema. api.ts turns a provider without a usable name into null and a
   *  missing or unusable country into '': nobody can agree to hand the conversation to a provider
   *  that is not named and located (spec §3.5, state.ts transferAskable). */
  llm_provider: LLMProviderInfo | null
}>

export type ConsentGrantIn = Readonly<{ policy_version: string; kinds: readonly ConsentKind[] }>

export type ScenarioOut = Readonly<{
  id: ScenarioId
  title: string
  description: string
  opening_message: string
  needs_summaries: boolean
}>

/** TurnRequest (extra="forbid"): revisit_summary_ids is present iff scenario === 'revisit'. */
export type TurnRequest = Readonly<{
  scenario: ScenarioId
  messages: readonly ChatMessage[]
  revisit_summary_ids?: readonly string[]
}>

/** SummarizeRequest (extra="forbid"): exactly these two fields. */
export type SummarizeRequest = Readonly<{ scenario: ScenarioId; messages: readonly ChatMessage[] }>

export type SummaryDraftOut = Readonly<{ title: string; bullets: readonly string[]; tags: readonly string[] }>

export type TagIn = Readonly<{ name: string; source: TagSource }>

/** SummaryCreate: title 1..120, bullets 1..5 of 1..500, tags up to 10 of 1..40, no NUL. */
export type SummaryCreate = Readonly<{
  scenario: ScenarioId
  title: string
  bullets: readonly string[]
  tags: readonly TagIn[]
}>

export type SummaryTagOut = Readonly<{ id: string; name: string; source: TagSource }>

export type SummaryOut = Readonly<{
  id: string
  scenario: ScenarioId
  title: string
  bullets: readonly string[]
  tags: readonly SummaryTagOut[]
  created_at: string
  edited_at: string | null
}>

export type SummaryList = Readonly<{ items: readonly SummaryOut[]; next_cursor: string | null }>

/** SummaryPatch (extra="forbid"): at least one field; each one sent replaces the whole field on
 *  the server — `tags` the whole set, so an AI tag must come back with source 'ai' or it turns
 *  into the person's (spec §7.7). */
export type SummaryPatch = Readonly<{ title?: string; bullets?: readonly string[]; tags?: readonly TagIn[] }>

/** GET /tags: the account's tags that still have a record, count DESC, name ASC, no paging. */
export type TagCountOut = Readonly<{ id: string; name: string; count: number }>

/** GET /reviews/weekly: counted from saved records only (a «не зберігати» conversation leaves
 *  nothing). `week_end` is the next Monday (exclusive); tags here are names, without ids. */
export type TagTrend = Readonly<{ name: string; count: number; prev_count: number }>
export type WeeklyReviewOut = Readonly<{
  week_start: string
  week_end: string
  tz: string
  sessions: number
  prev_sessions: number
  delta: number
  top_tags: readonly TagTrend[]
  recurring_tags: readonly string[]
  new_tags: readonly string[]
  faded_tags: readonly string[]
}>

// Wire shape of the helplines object (GET /helplines, SSE crisis, 409 crisis_stop details).
// Documentation only: the raw object is never rendered, stored or serialised — helplines.ts
// reads a whitelist of its fields and nothing else.
export type HelplineContact = Readonly<{ name: string; phone: string; hours: string; free: boolean | null }>
export type Helplines = Readonly<{
  verified_at: string
  message: string
  emergency: readonly HelplineContact[]
  lines: readonly HelplineContact[]
  abroad: Readonly<{ text: string; url: string }>
}>

// SSE events of POST /chat/turn (ChatEvent, discriminated by `type`).
export type TokenUsage = Readonly<{ prompt_tokens: number; completion_tokens: number }>
export type MetaEvent = Readonly<{ type: 'meta'; request_id: string }>
export type TokenEvent = Readonly<{ type: 'token'; text: string }>
export type DoneEvent = Readonly<{ type: 'done'; finish_reason: string | null; usage: TokenUsage | null }>
export type CrisisEvent = Readonly<{ type: 'crisis'; source: 'keyword' | 'model'; helplines: unknown }>
export type ErrorEvent = Readonly<{ type: 'error'; code: 'llm_failed' | 'llm_busy' | 'internal'; retryable: boolean }>
export type ChatEvent = MetaEvent | TokenEvent | DoneEvent | CrisisEvent | ErrorEvent

/** Error envelope. `message` is English and for developers: it never reaches the person. */
export type ErrorBody = Readonly<{ code: string; message: string; details?: unknown }>
export type ErrorResponse = Readonly<{ error: ErrorBody }>
export type ValidationDetail = Readonly<{ field: string; message: string }>
