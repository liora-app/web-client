// «Скопіювати текст розмови» / «Скопіювати тези» (spec §3.8, §7.2): only on an explicit press,
// in the format the person can paste anywhere.

import type { Draft } from '../core/limits'
import type { Msg, Pending } from '../core/state'
import { today } from './copy'

export function conversationText(messages: readonly Msg[], pending: Pending | null, now: Date = new Date()): string {
  const lines = [`Liora · розмова з AI · ${today(now)}`]
  for (const m of messages) lines.push(`${m.role === 'assistant' ? 'AI' : 'Ви'}: ${m.content}`)
  if (pending !== null) lines.push(`Ви (не надіслано): ${pending.text}`)
  return lines.join('\n\n')
}

export function thesesText(draft: Draft, now: Date = new Date()): string {
  const bullets = draft.bullets.filter((b) => !b.removed && b.text.trim() !== '')
  const lines = [`Liora · тези розмови з AI · ${today(now)}`, draft.title.trim()]
  bullets.forEach((b, i) => lines.push(`${String(i + 1).padStart(2, '0')} — ${b.text.trim()}`))
  if (draft.tags.length > 0) lines.push(draft.tags.map((t) => `#${t.name}`).join(' '))
  return lines.join('\n\n')
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
