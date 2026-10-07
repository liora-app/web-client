// Crisis contacts from the API, reduced to a whitelist of checked fields (spec §6.3).
//
// - 112, 103 and the "Ти як?" directory are constants here and in the page: `emergency` and
//   `abroad.url` from the payload are never read.
// - Every text that could carry the paused hotline number is dropped (NO_PAUSED_LINE), digits
//   counted even when the number is split by spaces or dashes.
// - Unknown fields (notes, sources, verified_at, …) are never read, and the raw object is never
//   kept, stringified or logged: only the SafeHelplines built here leaves this module.

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

/** False when the text spells the paused line, as written or with its digits split apart. */
export function noPausedLine(text: string): boolean {
  const normal = text.normalize('NFKC')
  return !normal.includes(PAUSED) && !normal.replace(/\D/g, '').includes(PAUSED)
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '' || codePoints(text) > max || !noPausedLine(text)) return null
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
