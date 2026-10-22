// The diary page («Щоденник», spec §7.7): what the screen needs besides the reducer steps — the
// week arithmetic, the search the server takes, the edit form and the PATCH it becomes.
//
// Pure, like the rest of the core: no clock (the server names this week in its first answer), no
// time zone database (the page passes its Intl zone in), no DOM.

import { PAUSED_LINE_NOTE_SHORT, maskPausedLineShort, oneLine } from './helplines'
import {
  MAX_BULLET,
  MAX_QUERY,
  MAX_TITLE,
  clampCodePoints,
  clampWords,
  normalize,
  validateDraft,
  type DraftBody,
  type DraftIssue,
  type DraftTag,
} from './limits'
import type { SummaryOut, SummaryPatch, SummaryTagOut } from './types'

/** One page of the list, as «Показати ще» loads it. */
export const JOURNAL_PAGE = 20
/** The zone the weekly review falls back to after a 422 invalid_timezone (the server's default). */
export const FALLBACK_TZ = 'Europe/Kyiv'

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_MS = 86_400_000

/** 'YYYY-MM-DD' moved by `days`: calendar arithmetic in UTC, so no zone and no clock moves it. */
export function shiftDay(day: string, days: number): string | null {
  const m = ISO_DAY.exec(day)
  if (m === null) return null
  const at = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * DAY_MS
  if (!Number.isFinite(at)) return null
  const shifted = new Date(at)
  if (Number.isNaN(shifted.getTime())) return null
  return shifted.toISOString().slice(0, 10)
}

/** The search as the server takes it: no NUL, trimmed, at most 200 code points; '' is no search
 *  (a query of spaces would match every record). */
export function searchQuery(raw: string): string {
  return clampCodePoints(raw.replace(/\u0000/g, '').trim(), MAX_QUERY).trim()
}

/** The edit form of one record: the title, one field per thesis, the themes as one line. */
export type EntryForm = Readonly<{
  id: string
  title: string
  bullets: readonly string[]
  /** «робота, сон»: comma-separated. */
  tags: string
}>

/** A title or a thesis the AI drafted, as the theses draft and the diary's edit form hold it: the
 *  paused number masked with the short note, the field cut at a word when the note would not fit
 *  (never inside the note) — the person must not meet a length error in a text they did not write.
 *  It is read on one line, as every screen draws it (oneLine): a number broken over two lines is
 *  one number there. A field with nothing to mask stays exactly as it came. */
export function maskedField(text: string, max: number): string {
  const flat = oneLine(text)
  const masked = maskPausedLineShort(flat)
  return masked === flat ? text : clampWords(oneLine(masked).trim(), max, PAUSED_LINE_NOTE_SHORT)
}

/** The form's first values: the record as the page shows it. The AI drafted it, so the paused
 *  number is masked here too — the rule of the theses draft (maskedField). A tag that spells it is
 *  left out. */
export function formOf(summary: SummaryOut): EntryForm {
  return {
    id: summary.id,
    title: maskedField(summary.title, MAX_TITLE),
    bullets: summary.bullets.map((bullet) => maskedField(bullet, MAX_BULLET)),
    tags: summary.tags
      .filter((tag) => maskPausedLineShort(oneLine(tag.name)) === oneLine(tag.name))
      .map((tag) => tag.name)
      .join(', '),
  }
}

/** The themes line → the tags of the PATCH. A name that is one of the record's own tags (as the
 *  server normalizes it) keeps the stored spelling and its source: an AI tag goes back as 'ai',
 *  or the PATCH would turn it into the person's (journal-api §2.3). A new name is the person's.
 *  Empty pieces and repeats go, as the server would fold them.
 *
 *  A comma separates themes, but a stored name may hold one: the server takes any 1..40 code
 *  points, and the AI may draft «стосунки, родина». The pieces such a name of the record spans in
 *  the line are that one theme again (the longest name first), not two new ones of the person. */
export function tagsFromText(text: string, own: readonly SummaryTagOut[]): DraftTag[] {
  const pieces = text.split(',')
  const parts = (name: string): number => name.split(',').length
  const joined = own.filter((tag) => tag.name.includes(',')).sort((a, b) => parts(b.name) - parts(a.name))
  const out: DraftTag[] = []
  const seen = new Set<string>()
  for (let i = 0; i < pieces.length; ) {
    let name = pieces[i]!.trim()
    let span = 1
    for (const tag of joined) {
      const k = parts(tag.name)
      const whole = pieces.slice(i, i + k).join(',').trim()
      if (i + k <= pieces.length && normalize(whole) === normalize(tag.name)) {
        name = whole
        span = k
        break
      }
    }
    i += span
    if (name === '') continue
    const key = normalize(name)
    if (seen.has(key)) continue
    seen.add(key)
    const stored = own.find((tag) => normalize(tag.name) === key)
    out.push({ id: `t${out.length}`, name: stored?.name ?? name, source: stored?.source ?? 'user' })
  }
  return out
}

export type PatchSent = Readonly<{ body: SummaryPatch; index: Pick<DraftBody, 'bulletIndex' | 'tagIndex'> }>

export type PatchCheck =
  | Readonly<{ ok: true; sent: PatchSent }>
  /** Nothing changed: no PATCH — the server stamps edited_at on every one. */
  | Readonly<{ ok: true; sent: null }>
  | Readonly<{ ok: false; issues: readonly DraftIssue[] }>

/** `themes`: the themes line was changed — only then are its tags read (and checked). */
function draftOfForm(form: EntryForm, own: readonly SummaryTagOut[], themes: boolean) {
  return {
    title: form.title,
    bullets: form.bullets.map((text, i) => ({ id: `b${i}`, text, removed: false })),
    tags: themes ? tagsFromText(form.tags, own) : [],
  }
}

const sameList = <T>(a: readonly T[], b: readonly T[], eq: (x: T, y: T) => boolean): boolean =>
  a.length === b.length && a.every((x, i) => eq(x, b[i]!))

/** The PATCH of an edit, checked the way the theses are (validateDraft: empty theses dropped, the
 *  rest within the schema). Issues name the fields: 'title', 'b{i}' (the i-th thesis field), 't{i}'
 *  (the i-th theme of the line). The title and the theses always go, each replacing the stored
 *  one. The themes go only when their line differs from the one the form opened with: `tags`
 *  replaces the record's whole set, and a line read back unchanged could still lose a theme the
 *  form leaves out (the paused number) or a stored name it cannot tell apart. Left out, the server
 *  keeps the tags as stored (SummaryPatch.tags = None). */
export function patchOf(form: EntryForm, summary: SummaryOut): PatchCheck {
  const first = formOf(summary)
  const themes = form.tags !== first.tags
  const check = validateDraft(draftOfForm(form, summary.tags, themes), summary.scenario)
  if (!check.ok) return { ok: false, issues: check.issues }
  const { title, bullets, tags } = check.value.body
  const before = validateDraft(draftOfForm(first, summary.tags, themes), summary.scenario)
  if (
    before.ok &&
    before.value.body.title === title &&
    sameList(before.value.body.bullets, bullets, (x, y) => x === y) &&
    sameList(before.value.body.tags, tags, (x, y) => x.name === y.name && x.source === y.source)
  ) {
    return { ok: true, sent: null }
  }
  const body: SummaryPatch = themes
    ? { title, bullets: [...bullets], tags: tags.map((t) => ({ name: t.name, source: t.source })) }
    : { title, bullets: [...bullets] }
  return { ok: true, sent: { body, index: { bulletIndex: check.value.bulletIndex, tagIndex: themes ? check.value.tagIndex : [] } } }
}
