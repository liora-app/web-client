// «Скопіювати текст розмови» / «Скопіювати тези» (spec §3.8, §7.2): only on an explicit press,
// in the format the person can paste anywhere. What the AI wrote goes out as the page shows it:
// with the paused hotline number masked (core/helplines.ts).

import { maskPausedLine, maskPausedLineInline } from '../core/helplines'
import type { Draft } from '../core/limits'
import type { Msg, Pending } from '../core/state'
import type { SummaryOut } from '../core/types'
import { entryDay, today } from './copy'

export function conversationText(messages: readonly Msg[], pending: Pending | null, now: Date = new Date()): string {
  const lines = [`Liora · розмова з AI · ${today(now)}`]
  for (const m of messages) lines.push(m.role === 'assistant' ? `AI: ${maskPausedLine(m.content)}` : `Ви: ${m.content}`)
  if (pending !== null) lines.push(`Ви (не надіслано): ${pending.text}`)
  return lines.join('\n\n')
}

export function thesesText(draft: Draft, now: Date = new Date()): string {
  const bullets = draft.bullets.filter((b) => !b.removed && b.text.trim() !== '')
  const lines = [`Liora · тези розмови з AI · ${today(now)}`, maskPausedLineInline(draft.title.trim())]
  bullets.forEach((b, i) => lines.push(`${String(i + 1).padStart(2, '0')} — ${maskPausedLineInline(b.text.trim())}`))
  if (draft.tags.length > 0) lines.push(draft.tags.map((t) => `#${maskPausedLineInline(t.name)}`).join(' '))
  return lines.join('\n\n')
}

/** One diary record as Markdown («Копіювати» in the diary, §7.7): the title as a heading, the day,
 *  the theses as a list, the themes. The AI drafted it: the paused number is masked, as on the page. */
export function entryMarkdown(summary: SummaryOut): string {
  const blocks = [`## ${maskPausedLineInline(summary.title.trim())}`, `_${entryDay(summary.created_at)}_`]
  const bullets = summary.bullets.map((b) => b.trim()).filter((b) => b !== '')
  if (bullets.length > 0) blocks.push(bullets.map((b) => `- ${maskPausedLineInline(b)}`).join('\n'))
  if (summary.tags.length > 0) blocks.push(`Теми: ${summary.tags.map((t) => maskPausedLineInline(t.name)).join(', ')}`)
  return blocks.join('\n\n')
}

/** Resolves false when the browser refuses (no permission, insecure context). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
