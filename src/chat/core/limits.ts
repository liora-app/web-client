// Limits of the conversation and of the theses draft (spec §3.7.3, §3.7.7, §5.8, §7.2).
//
// Lengths are counted in code points, the way the server (Python) counts them: `.length` counts
// UTF-16 units and would call 2001 emoji "too long" while the server accepts them.

import type { ChatMessage, ScenarioId, SummaryCreate, SummaryDraftOut, TagSource } from './types'

export const MAX_MESSAGES = 200
export const MAX_CONTENT = 4000
/** From this length the composer shows a counter. */
export const CONTENT_COUNTER_FROM = 3500
/** From this many messages a line suggests summarising soon. */
export const LONG_CONVERSATION_MESSAGES = 180
/** Above this the server trims the oldest history, for the model only. */
export const SERVER_TRIM_CODE_POINTS = 24_000
export const MAX_REVISIT_IDS = 5

export const MAX_TITLE = 120
export const TITLE_COUNTER_FROM = 100
export const MAX_BULLETS = 5
export const MAX_BULLET = 500
export const BULLET_COUNTER_FROM = 450
export const MAX_TAGS = 10
export const MAX_TAG = 40
/** GET /summaries `q`: the server takes up to 200 characters and no NUL (422 otherwise). */
export const MAX_QUERY = 200

const APOSTROPHES = /[ʼ’‘`´ʹ]/g

/** The server's `normalize` (server/app/text.py): one apostrophe form, lower case, ё → е,
 *  collapsed whitespace. Two tags with the same normal form are one tag on the server: it keeps
 *  the first and answers with the name already stored. */
export function normalize(text: string): string {
  return text.replace(APOSTROPHES, "'").toLowerCase().replace(/ё/g, 'е').trim().split(/\s+/).join(' ')
}

export function codePoints(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    // A high surrogate followed by a low one is one code point.
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) i++
    }
    n++
  }
  return n
}

/** The first `max` code points of `text`. */
export function clampCodePoints(text: string, max: number): string {
  if (codePoints(text) <= max) return text
  return Array.from(text).slice(0, max).join('')
}

/** `text` in at most `max` code points (max ≥ 2), cut at the end of a word, «…» after it. `whole`
 *  is never cut in half: when the cut falls inside it, it goes entirely. One word longer than the
 *  room is cut where the room ends. */
export function clampWords(text: string, max: number, whole = ''): string {
  if (codePoints(text) <= max) return text
  const room = Array.from(text).slice(0, max - 1).join('')
  let end = room.length
  if (whole !== '') {
    for (let at = text.indexOf(whole); at !== -1 && at < end; at = text.indexOf(whole, at + whole.length)) {
      if (at + whole.length > end) end = at
    }
  }
  let head = text.slice(0, end)
  // In the middle of a word: back to the space before it.
  if (!/\s/.test(text.charAt(end))) {
    const space = head.search(/\s\S*$/)
    if (space > 0) head = head.slice(0, space)
  }
  head = head.trimEnd()
  return (head === '' ? room : head) + '…'
}

/** One more "Надіслати" is allowed while the reply and a later summarize still fit in 200. */
export function canSend(messageCount: number): boolean {
  return messageCount + 2 <= MAX_MESSAGES
}

export type MessageCheck =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: 'blank' }>
  | Readonly<{ ok: false; reason: 'too-long'; length: number }>

export function checkMessage(text: string): MessageCheck {
  if (text.trim() === '') return { ok: false, reason: 'blank' }
  const length = codePoints(text)
  if (length > MAX_CONTENT) return { ok: false, reason: 'too-long', length }
  return { ok: true }
}

export function totalCodePoints(messages: readonly ChatMessage[]): number {
  let n = 0
  for (const m of messages) n += codePoints(m.content)
  return n
}

// ── Theses draft (review screen) ──────────────────────────────────────────────────────────────

export type DraftBullet = Readonly<{ id: string; text: string; removed: boolean }>
export type DraftTag = Readonly<{ id: string; name: string; source: TagSource }>
export type Draft = Readonly<{ title: string; bullets: readonly DraftBullet[]; tags: readonly DraftTag[] }>

export type DraftIssueReason =
  | 'title-empty'
  | 'title-long'
  | 'title-nul'
  | 'bullets-none'
  | 'bullets-many'
  | 'bullet-long'
  | 'bullet-nul'
  | 'tags-many'
  | 'tag-empty'
  | 'tag-long'
  | 'tag-nul'
  | 'tag-dup'
  // The server's 422 on POST /summaries, mapped back to the field (spec §4.3).
  | 'title-invalid'
  | 'bullet-invalid'
  | 'tag-invalid'
/** `field` is the id of the field the message belongs to: 'title', a bullet id or a tag id. */
export type DraftIssue = Readonly<{ field: string; reason: DraftIssueReason }>

/** What POST /summaries gets, and which field each array index came from (for 422, §7.2). */
export type DraftBody = Readonly<{
  body: SummaryCreate
  bulletIndex: readonly string[]
  tagIndex: readonly string[]
}>

export type DraftCheck = Readonly<{ ok: true; value: DraftBody }> | Readonly<{ ok: false; issues: readonly DraftIssue[] }>

export function draftFromOut(out: SummaryDraftOut): Draft {
  return {
    title: out.title,
    bullets: out.bullets.map((text, i) => ({ id: `b${i}`, text, removed: false })),
    tags: out.tags.map((name, i) => ({ id: `t${i}`, name, source: 'ai' as const })),
  }
}

/** Checks the draft the way the server will, and builds the request body.
 *  Empty theses are dropped silently (spec §7.2); the rest must fit the schema. */
export function validateDraft(draft: Draft, scenario: ScenarioId): DraftCheck {
  const issues: DraftIssue[] = []

  const title = draft.title.trim()
  if (title === '') issues.push({ field: 'title', reason: 'title-empty' })
  else if (title.includes('\u0000')) issues.push({ field: 'title', reason: 'title-nul' })
  else if (codePoints(title) > MAX_TITLE) issues.push({ field: 'title', reason: 'title-long' })

  const active = draft.bullets.filter((b) => !b.removed)
  const bullets: string[] = []
  const bulletIndex: string[] = []
  for (const b of active) {
    const text = b.text.trim()
    if (text === '') continue
    if (text.includes('\u0000')) issues.push({ field: b.id, reason: 'bullet-nul' })
    else if (codePoints(text) > MAX_BULLET) issues.push({ field: b.id, reason: 'bullet-long' })
    bullets.push(text)
    bulletIndex.push(b.id)
  }
  if (bullets.length === 0) issues.push({ field: active[0]?.id ?? 'bullets', reason: 'bullets-none' })
  if (bullets.length > MAX_BULLETS) issues.push({ field: bulletIndex[MAX_BULLETS] ?? 'bullets', reason: 'bullets-many' })

  const tags: { name: string; source: TagSource }[] = []
  const tagIndex: string[] = []
  const seen = new Set<string>()
  for (const t of draft.tags) {
    const name = t.name.trim()
    if (name === '') issues.push({ field: t.id, reason: 'tag-empty' })
    else if (name.includes('\u0000')) issues.push({ field: t.id, reason: 'tag-nul' })
    else if (codePoints(name) > MAX_TAG) issues.push({ field: t.id, reason: 'tag-long' })
    else if (seen.has(normalize(name))) issues.push({ field: t.id, reason: 'tag-dup' })
    seen.add(normalize(name))
    tags.push({ name, source: t.source })
    tagIndex.push(t.id)
  }
  if (tags.length > MAX_TAGS) issues.push({ field: tagIndex[MAX_TAGS] ?? 'tags', reason: 'tags-many' })

  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, value: { body: { scenario, title, bullets, tags }, bulletIndex, tagIndex } }
}

/** Why a new tag cannot be added, or null when it can (the "Додати" button, §7.2). */
export function newTagIssue(name: string, tags: readonly DraftTag[]): DraftIssueReason | null {
  const trimmed = name.trim()
  if (trimmed === '') return 'tag-empty'
  if (trimmed.includes('\u0000')) return 'tag-nul'
  if (codePoints(trimmed) > MAX_TAG) return 'tag-long'
  const key = normalize(trimmed)
  if (tags.some((t) => normalize(t.name) === key)) return 'tag-dup'
  if (tags.length >= MAX_TAGS) return 'tags-many'
  return null
}
