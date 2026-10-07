// Crisis contacts from the API, reduced to a whitelist of checked fields (spec §6.3).
//
// - 112, 103 and the "Ти як?" directory are constants here and in the page: `emergency` and
//   `abroad.url` from the payload are never read.
// - Every text that could carry the paused hotline number is dropped (noPausedLine), digits
//   counted even when the number is split by spaces or dashes or spelled with a Cyrillic «З» for
//   a 3, and so is any text with bidi controls or right-to-left letters, which could draw the
//   number reversed from other digits, or with digits other than 0-9 after NFKC.
// - Unknown fields (notes, sources, verified_at, …) are never read, and the raw object is never
//   kept, stringified or logged: only the SafeHelplines built here leaves this module.
// - Texts the page did not write and cannot drop — the AI's replies and theses — get the number
//   masked instead (maskPausedLine), read the same way.

import { codePoints } from './limits'

export type SafeLine = Readonly<{
  name: string
  /** As the payload spells it, with spaces ("0 800 21 01 60"). */
  phone: string
  /** `tel:` href: digits and "+" only. */
  tel: string
  hours: string | null
  /** True only when the payload says `free: true`; anything else says nothing about cost. */
  free: boolean
}>

export type EmergencyNumber = Readonly<{ number: '112' | '103'; tel: 'tel:112' | 'tel:103' }>

export type SafeHelplines = Readonly<{
  message: string
  lines: readonly SafeLine[]
  abroadText: string
  emergency: readonly EmergencyNumber[]
  howareuUrl: typeof HOWAREU_URL
}>

export const EMERGENCY: readonly EmergencyNumber[] = Object.freeze([
  Object.freeze({ number: '112', tel: 'tel:112' } as const),
  Object.freeze({ number: '103', tel: 'tel:103' } as const),
])
export const HOWAREU_URL = 'https://howareu.com/hot-lines' as const

export const FALLBACK_MESSAGE =
  'Схоже, зараз вам дуже важко. Ви не мусите проходити через це наодинці. Будь ласка, зверніться до людей, які можуть допомогти просто зараз.'
export const FALLBACK_ABROAD =
  'За кордоном: у країнах ЄС працює 112. Номери ліній підтримки в інших країнах — на сторінці «Ти як?».'

/** What the page shows when the payload is missing or unusable. */
export const FALLBACK: SafeHelplines = Object.freeze({
  message: FALLBACK_MESSAGE,
  lines: Object.freeze([]) as readonly SafeLine[],
  abroadText: FALLBACK_ABROAD,
  emergency: EMERGENCY,
  howareuUrl: HOWAREU_URL,
})

const MAX_LINES = 8
const MAX_MESSAGE = 400
const MAX_NAME = 120
const MAX_HOURS = 80
const MAX_ABROAD = 300
/** 3..19 digits, "+" only in front, at most one space between digits: no dead `tel:` links such
 *  as "+++" or "1+2". */
const PHONE = /^\+?\d(?: ?\d){2,18}$/
// The paused national hotline. Kept as two halves so that no single literal in the source spells
// the number a page must never show.
const PAUSED = '73' + '33'

/** What the page shows in place of the paused number in a text it cannot drop (an AI reply, a
 *  thesis). It has no digits: masking a masked text changes nothing. */
export const PAUSED_LINE_NOTE = '[цей номер зараз не працює — актуальні контакти в «Якщо важко»]'

// ── Digits the way a person sees them ────────────────────────────────────────────────────────

const ASCII_DIGIT = /^[0-9]$/
const NUMBER = /\p{N}/u
const DECIMAL = /\p{Nd}/u
/** NFKC of one code point that draws digits: fullwidth 7 → 7, superscript 7 → 7, circled 10 →
 *  10, «digit seven full stop» → «7.». */
const NFKC_DIGITS = /^\(?([0-9]+)[.,)]?$/
/** Cyrillic «З» and «з», which read as a 3 among digits. */
const ZE = /^[\u{0417}\u{0437}]$/u
/** A letter, a combining mark or an apostrophe: a «з» that touches one is part of a word. */
const WORDISH = /[\p{L}\p{M}'\u{2019}\u{02BC}`]/u
/** What may stand between two parts of one number: horizontal spaces, invisible format
 *  characters (zero-width, bidi marks and controls, soft hyphen), dashes and dots. Not a line
 *  break, a comma or a slash. */
const SEPARATOR =
  /^[-\t \u{00A0}\u{00AD}\u{061C}\u{1680}\u{180E}\u{2000}-\u{200F}\u{2010}-\u{2015}\u{202A}-\u{202F}\u{205F}-\u{206F}\u{2212}\u{3000}\u{FE58}\u{FE63}\u{FEFF}\u{FF0D}.\u{00B7}\u{2024}\u{2027}\u{FF0E}]$/u
/** At most this many separators in a row still join two digit groups («7 - 333»). */
const MAX_GAP = 3

/** The digits one code point draws, or null: ASCII; what NFKC turns into digits (fullwidth,
 *  superscript, circled, mathematical); any other decimal digit (Arabic-Indic, Devanagari, …);
 *  the dingbat circled digits, which NFKC leaves as they are. */
function digitsOf(ch: string): string | null {
  if (ASCII_DIGIT.test(ch)) return ch
  if (!NUMBER.test(ch)) return null
  const nfkc = NFKC_DIGITS.exec(ch.normalize('NFKC'))
  if (nfkc !== null) return nfkc[1]!
  const cp = ch.codePointAt(0)!
  if (DECIMAL.test(ch)) {
    // Decimal digits come in runs of ten, zero first (Unicode's stability policy); the one longer
    // run, the mathematical digits, NFKC has already read.
    let value = 0
    while (value < 9 && DECIMAL.test(String.fromCodePoint(cp - value - 1))) value++
    return String(value)
  }
  // The dingbat circled digits: three runs of 1..10 from U+2776.
  if (cp >= 0x2776 && cp <= 0x2793) return String(((cp - 0x2776) % 10) + 1)
  return null
}

/** Digit-like code points with nothing between them, as [start, end) of the text. */
type Group = Readonly<{ start: number; end: number; digits: string; real: boolean }>

/** The numbers of a text as runs of digit groups: groups joined by up to MAX_GAP separators are
 *  one run («7 333», «7-3-3-3», a zero-width space inside).
 *  - A «З»/«з» counts as 3 inside a group with a real digit («73З3»), or standing alone between
 *    non-letters («7 ЗЗЗ»); inside a word («зараз») it is a letter.
 *  - A run without a single real digit is no number at all: «з» on its own is a preposition. */
function digitRuns(text: string): Group[][] {
  type Cell = Readonly<{ at: number; end: number; ch: string; digits: string | null; ze: boolean }>
  const cells: Cell[] = []
  let at = 0
  for (const ch of text) {
    const digits = digitsOf(ch)
    cells.push({ at, end: at + ch.length, ch, digits, ze: digits === null && ZE.test(ch) })
    at += ch.length
  }
  const groups: Group[] = []
  for (let i = 0; i < cells.length; ) {
    const first = cells[i]!
    if (first.digits === null && !first.ze) {
      i++
      continue
    }
    let j = i
    let digits = ''
    let real = false
    while (j < cells.length && (cells[j]!.digits !== null || cells[j]!.ze)) {
      const cell = cells[j]!
      if (cell.digits !== null) real = true
      digits += cell.digits ?? '3'
      j++
    }
    const before = cells[i - 1]?.ch ?? ''
    const after = cells[j]?.ch ?? ''
    if (real || (!WORDISH.test(before) && !WORDISH.test(after))) groups.push({ start: first.at, end: cells[j - 1]!.end, digits, real })
    i = j
  }
  const runs: Group[][] = []
  let run: Group[] = []
  for (const group of groups) {
    const last = run[run.length - 1]
    const gap = last === undefined ? [] : Array.from(text.slice(last.end, group.start))
    if (last !== undefined && !(gap.length <= MAX_GAP && gap.every((c) => SEPARATOR.test(c)))) {
      runs.push(run)
      run = []
    }
    run.push(group)
  }
  if (run.length > 0) runs.push(run)
  return runs.filter((r) => r.some((g) => g.real))
}

/** False when the text spells the paused line, as written or with its digits split apart — by
 *  anything at all: every digit of the text counts, in order. */
export function noPausedLine(text: string): boolean {
  const digits = digitRuns(text.normalize('NFKC'))
    .flat()
    .map((g) => g.digits)
    .join('')
  return !digits.includes(PAUSED)
}

/** The text with every spelling of the paused number replaced by PAUSED_LINE_NOTE.
 *
 *  What counts: whole digit groups of one run (see digitRuns) whose digits together are exactly
 *  the number — spaced, dashed, fullwidth, Arabic-Indic, with a Cyrillic «З» for a 3, and also
 *  inside a spaced longer number («0 800» before it): a mask too many costs less than the number
 *  on the screen. A group is never split, so an unbroken longer number (1 before it or after it,
 *  no space) is another number and stays. Runs are read forwards only: the bidi tricks the
 *  helplines filter drops a text for are not looked for here. */
export function maskPausedLine(text: string): string {
  if (!NUMBER.test(text)) return text
  const cuts: [number, number][] = []
  for (const run of digitRuns(text)) {
    for (let i = 0; i < run.length; i++) {
      let digits = ''
      for (let j = i; j < run.length; j++) {
        digits += run[j]!.digits
        if (digits === PAUSED) {
          cuts.push([run[i]!.start, run[j]!.end])
          i = j
          break
        }
        if (digits.length >= PAUSED.length) break
      }
    }
  }
  if (cuts.length === 0) return text
  let out = ''
  let from = 0
  for (const [start, end] of cuts) {
    out += text.slice(from, start) + PAUSED_LINE_NOTE
    from = end
  }
  return out + text.slice(from)
}

/** Bidi controls (embeddings, overrides, isolates, marks): an override before «3337» passes every
 *  digit check and still draws the paused number, reversed. No text the page shows needs them. */
const BIDI_CONTROLS = /[\u{202A}-\u{202E}\u{2066}-\u{2069}\u{200E}\u{200F}\u{061C}]/u
/** Strong right-to-left letters (Hebrew, Arabic, Syriac, Thaana, NKo, … with their presentation
 *  forms, and the historic RTL scripts of plane 1): beside one, «333 7» is drawn as «7 333». */
const RTL_LETTERS = /[\u{0590}-\u{08FF}\u{FB1D}-\u{FDFF}\u{FE70}-\u{FEFE}\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u
/** Digits other than 0-9 that NFKC leaves as they are (Arabic-Indic, dingbats, …): a reader may
 *  see a number in them. */
const OTHER_DIGITS = /(?![0-9])[\p{Nd}\p{No}]/u

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '' || codePoints(text) > max || !noPausedLine(text) || BIDI_CONTROLS.test(text)) return null
  const normal = text.normalize('NFKC')
  if (OTHER_DIGITS.test(normal) || RTL_LETTERS.test(normal)) return null
  return text
}

function cleanLine(raw: unknown): SafeLine | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const entry = raw as Record<string, unknown>
  const name = cleanText(entry.name, MAX_NAME)
  if (name === null) return null
  const phone = typeof entry.phone === 'string' ? entry.phone.trim() : ''
  if (!PHONE.test(phone) || !noPausedLine(phone)) return null
  let hours: string | null = null
  if (entry.hours !== undefined && entry.hours !== null) {
    if (typeof entry.hours !== 'string') return null
    if (entry.hours.trim() !== '') {
      hours = cleanText(entry.hours, MAX_HOURS)
      if (hours === null) return null
    }
  }
  return Object.freeze({ name, phone, tel: 'tel:' + phone.replace(/[^\d+]/g, ''), hours, free: entry.free === true })
}

/** Never throws, never returns anything taken from `raw` without a check. */
export function sanitizeHelplines(raw: unknown): SafeHelplines {
  try {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return FALLBACK
    const payload = raw as Record<string, unknown>
    const lines: SafeLine[] = []
    if (Array.isArray(payload.lines)) {
      for (const entry of payload.lines) {
        const line = cleanLine(entry)
        if (line !== null) lines.push(line)
        if (lines.length === MAX_LINES) break
      }
    }
    const abroad = payload.abroad
    const abroadText =
      typeof abroad === 'object' && abroad !== null ? cleanText((abroad as Record<string, unknown>).text, MAX_ABROAD) : null
    return Object.freeze({
      message: cleanText(payload.message, MAX_MESSAGE) ?? FALLBACK_MESSAGE,
      lines: Object.freeze(lines),
      abroadText: abroadText ?? FALLBACK_ABROAD,
      emergency: EMERGENCY,
      howareuUrl: HOWAREU_URL,
    })
  } catch {
    return FALLBACK
  }
}
