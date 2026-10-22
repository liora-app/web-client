// The conversation on the page (spec §3.7.2, §3.7.4, §5.7).
//
// - Append-only: confirmed messages are cloned from <template data-tpl="said"> once and kept; only a
//   new conversation (or a changed opening message) re-renders the list.
// - Text goes in through textContent, Text.appendData and new nodes only (I8), split into <p> on "\n\n".
// - The person's message is a bubble on the right; the AI's reply stands on the page under a small
//   light and the label «AI». Under each: its time (Session.times, never inside .said__text) and,
//   under a reply, «Копіювати» (copies the reply from the model, the paused number masked) and «→ У
//   тези» (a toggle: Session.marks). Each action's name says which reply: «Копіювати відповідь 2,
//   23:10» — the visible words first (WCAG 2.5.3), two replies of one minute still apart.
// - The answer being streamed is written once per frame (requestAnimationFrame), every 250 ms in a
//   hidden tab (rAF stands still there, so a frame already asked for is swapped for the timer), every
//   300 ms without motion. Its target is the state's `partial`; the DOM catches up. With motion each
//   new piece comes in as a <span class="w"> that fades in (chat.css); on `done` every paragraph is one
//   Text node again. A trailing run of digits waits for the next character: a phone number shows only
//   whole, after the mask of core/helplines.ts has seen its last digit.
// - On any end but `done` (crisis, error, «Зупинити», pagehide, the screen leaving) the scheduled
//   write is cancelled, the target emptied and the answer's <li> leaves the DOM before anything else
//   (I3). A cut stream before its retry keeps the slot, but its text goes at once, not a frame later.
//   On `done` the rest is written at once and the <li> becomes a confirmed message in place.
// - Only what comes in while the person watches enters with a short rise (.said--in): the sent
//   message, the answer's slot, a swapped opening message. A list built again (back from the theses)
//   just stands there.
// - Where the page scrolls is scroll-anchor.ts: the transcript only says what was sent and when
//   text was written.
// - The AI's text reaches the DOM only through shown(): the paused hotline number masked
//   (core/helplines.ts). A streamed answer is masked as a whole on every write, so a number split
//   across tokens is caught once its last digit is in.

import { maskPausedLine } from '../core/helplines'
import type { Msg, Pending } from '../core/state'
import { busyWait, clock, replyWhich, requestIdLine, turnError, waitLabel } from './copy'
import { fromTemplate, setAttr, setText, show } from './dom'
import { decorativeMotion } from '../../ui/motion'

export type StreamView = Readonly<{
  id: number
  phase: 'waiting' | 'streaming' | 'busy-wait'
  stage: 'headers' | 'meta'
  partial: string
  /** busy-wait: when the automatic retry goes. */
  until: number | null
}>

export type TranscriptView = Readonly<{
  messages: readonly Msg[]
  /** When each message came (Session.times): null where the page did not see it. */
  times: readonly (number | null)[]
  cut: readonly number[]
  pending: Pending | null
  stream: StreamView | null
  /** 403 csrf_failed so far (the second one asks to reload the page). */
  csrfFailures: number
  /** A 429 countdown is running until then. */
  cooldownUntil: number | null
  /** After a 404 on a revisit turn: «Обрати записи» instead of «Надіслати ще раз». */
  revisit: boolean
  /** «→ У тези» (Session.marks): indices of the marked replies. */
  marks: readonly number[]
}>

type Para = { readonly paras: Text[] }

/** The streamed answer's paragraphs: what each one shows so far. */
type Live = { p: HTMLParagraphElement; text: string }[]

type Item = Readonly<{ li: HTMLLIElement; role: Msg['role']; content: string; text: Para }>

export type TranscriptHooks = Readonly<{
  /** While text streams in, at most 4 times a second (the presence pulses with it, §5.7). */
  onPulse?: () => void
  /** After every write of streamed text and every sync of the list (the «↓» pill looks again). */
  onWrite?: () => void
  /** The person's message just went; the answer's slot, if there is one yet, stands under it. */
  onSent?: (sent: HTMLLIElement, answer: HTMLLIElement | null) => void
}>

const LABEL: Readonly<Record<Msg['role'], string>> = { assistant: 'AI', user: 'Ви' }

/** A tail that may be the start of a phone number, read as broadly as the mask of core/helplines.ts
 *  reads one: digits of any script (fullwidth, superscript, circled…), a Cyrillic «З»/«з» for a 3,
 *  marks drawn on a digit (keycap, strike-through), and what may join the groups — spaces, brackets,
 *  a plus, dashes, dots, invisible format characters — up to the end of the text so far. It waits
 *  for the next character (or `done`); holding back too much costs a frame, too little shows part
 *  of the number. */
const NUMBER_TAIL =
  /[\p{N}+(\u0417\u0437][\p{N}\p{M}\s()+\-.\u00AD\u00B7\u061C\u180E\u2000-\u200F\u2010-\u2015\u2024\u2027\u202A-\u202F\u205F-\u206F\u2212\u3000\uFE58\uFE63\uFEFF\uFF0D\uFF0E\u0417\u0437]*$/u
/** How far back that tail is looked for: a number with its marks and gaps is far shorter, and the
 *  search stays short on a long answer full of digits. */
const TAIL_WINDOW = 96

/** The text so far without a number that may still be coming in. */
function holdNumberTail(text: string): string {
  const from = Math.max(0, text.length - TAIL_WINDOW)
  const match = NUMBER_TAIL.exec(text.slice(from))
  return match === null ? text : text.slice(0, from + match.index)
}

/** Writes `full` into the container as paragraphs, appending where it can. */
function writeText(container: HTMLElement, state: Para, full: string): void {
  const parts = full.split('\n\n')
  for (let i = 0; i < parts.length; i++) {
    const want = parts[i]!
    const node = state.paras[i]
    if (node === undefined) {
      const p = document.createElement('p')
      const t = document.createTextNode(want)
      p.append(t)
      container.append(p)
      state.paras.push(t)
    } else if (node.data !== want) {
      if (want.startsWith(node.data)) node.appendData(want.slice(node.data.length))
      else node.data = want
    }
  }
  while (state.paras.length > parts.length) state.paras.pop()?.parentElement?.remove()
}

/** The streamed answer: what continues the text comes in as a new node — with motion a
 *  <span class="w"> that fades in; anything that does not continue it (the mask, a retry) rebuilds
 *  the paragraph without a fade. */
function writeLive(container: HTMLElement, live: Live, full: string, fade: boolean): void {
  const parts = full.split('\n\n')
  for (let i = 0; i < parts.length; i++) {
    const want = parts[i]!
    let para = live[i]
    if (para === undefined) {
      const p = document.createElement('p')
      container.append(p)
      para = { p, text: '' }
      live.push(para)
    }
    if (para.text === want) continue
    if (want.startsWith(para.text)) {
      const piece = want.slice(para.text.length)
      if (fade) {
        const word = document.createElement('span')
        word.className = 'w'
        word.textContent = piece
        para.p.append(word)
      } else {
        para.p.append(document.createTextNode(piece))
      }
    } else {
      para.p.textContent = want
    }
    para.text = want
  }
  while (live.length > parts.length) live.pop()?.p.remove()
}

/** On `done`: each paragraph becomes one Text node again (no spans left for a screen reader to
 *  read in pieces), and the answer continues as a confirmed message. */
function settle(live: Live): Para {
  const paras: Text[] = []
  for (const { p, text } of live) {
    const node = document.createTextNode(text)
    p.replaceChildren(node)
    paras.push(node)
  }
  return { paras }
}

function said(role: Msg['role']): { li: HTMLLIElement; text: Para } {
  const li = fromTemplate<HTMLLIElement>('said')
  li.classList.add(role === 'assistant' ? 'said--ai' : 'said--you')
  const who = li.querySelector<HTMLElement>('.said__who')!
  setText(who, LABEL[role])
  // «Ви» is said to a screen reader, not shown: the bubble on the right already says whose it is.
  if (role === 'user') who.classList.add('visually-hidden')
  return { li, text: { paras: [] } }
}

/** What a message shows: the person's own words as written, the AI's with the paused number masked. */
function shown(role: Msg['role'], content: string): string {
  return role === 'assistant' ? maskPausedLine(content) : content
}

function textBox(li: HTMLElement): HTMLElement {
  return li.querySelector<HTMLElement>('.said__text')!
}

/** The line under a message: its time, and under a reply of the AI (`index` in the history; the
 *  opening message is no reply) «Копіювати» and «→ У тези». `replyNo`: the reply's number among the
 *  AI's replies, for the names of its actions. */
function writeMeta(li: HTMLLIElement, role: Msg['role'], index: number | null, time: number | null, replyNo = 0): void {
  const meta = li.querySelector<HTMLElement>('.said__meta')
  if (meta === null) return
  const stamp = meta.querySelector<HTMLTimeElement>('.said__time')!
  if (time !== null) {
    setText(stamp, clock(time))
    setAttr(stamp, 'datetime', new Date(time).toISOString())
  }
  show(stamp, time !== null)
  const reply = role === 'assistant' && index !== null && index > 0
  for (const action of Array.from(meta.querySelectorAll<HTMLElement>('.said__act'))) {
    if (reply) {
      action.dataset.i = String(index)
      setText(action.querySelector('.said__which')!, replyWhich(replyNo, time === null ? null : clock(time)))
    }
    show(action, reply)
  }
  show(meta, time !== null || reply)
}

/** A read-only copy of a conversation (crisis, not-invited, session-expired): no actions — not
 *  even hidden ones in the tree, under any record. */
export function renderStatic(list: HTMLOListElement, messages: readonly Msg[], pending: Pending | null): void {
  list.replaceChildren()
  for (const m of messages) {
    const { li, text } = said(m.role)
    writeText(textBox(li), text, shown(m.role, m.content))
    list.append(li)
    li.querySelector('.said__status')?.remove()
    li.querySelector('.said__meta')?.remove()
  }
  if (pending !== null) {
    const { li, text } = said('user')
    writeText(textBox(li), text, pending.text)
    li.querySelector('.said__meta')?.remove()
    const status = li.querySelector<HTMLElement>('.said__status')!
    setText(status.querySelector('.said__flag')!, 'Не надіслано')
    status.querySelector('.said__actions')?.remove()
    status.hidden = false
    list.append(li)
  }
}

export class Transcript {
  private readonly list: HTMLOListElement
  private readonly hooks: TranscriptHooks
  private items: Item[] = []
  /** The AI's replies among `items` so far (the opening message not counted). */
  private replies = 0
  private lastMessages: readonly Msg[] | null = null
  private pendingLi: HTMLLIElement | null = null
  private pendingText: Para = { paras: [] }
  private pendingKey = ''
  private streamLi: HTMLLIElement | null = null
  private streamText: Live = []
  private streamId = -1
  private target = ''
  private scheduled: { kind: 'raf' | 'timer'; handle: number } | null = null
  private ticker: number | null = null
  private waitSince = 0
  private waitKey = ''
  private lastPulse = 0
  private sentLi: HTMLLIElement | null = null
  private view: TranscriptView | null = null

  constructor(list: HTMLOListElement, hooks: TranscriptHooks = {}) {
    this.list = list
    this.hooks = hooks
    window.addEventListener('online', () => this.connectionChanged())
    window.addEventListener('offline', () => this.connectionChanged())
    // A frame asked for just before the tab went hidden would wait until the tab is shown again.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.scheduled?.kind === 'raf') {
        this.cancelFlush()
        this.scheduleFlush()
      }
    })
  }

  /** The newest text shown for the answer in progress (for the announcer on `done`). */
  streamed(): string {
    return this.target
  }

  sync(view: TranscriptView): void {
    const previous = this.view
    this.view = view
    const stream = view.stream
    const messagesChanged = view.messages !== this.lastMessages
    const last = view.messages[view.messages.length - 1]
    // `done`: the answer joined the history; its <li> is adopted below, its text written in full.
    const finished = stream === null && this.streamLi !== null && messagesChanged && last?.role === 'assistant' && view.messages.length > this.items.length
    if (stream === null && this.streamLi !== null && !finished) this.dropStream()
    if (stream !== null && this.streamLi !== null && stream.id !== this.streamId) this.dropStream()

    if (messagesChanged) this.reconcile(view, finished)
    this.syncMarks(view.marks)
    this.syncPending(view, previous)
    if (stream !== null) this.syncStream(stream)
    this.syncTicker(view)
    // After the answer's slot exists: the room under the message is what lets it reach the top.
    if (this.sentLi !== null) {
      const li = this.sentLi
      this.sentLi = null
      if (li.isConnected) this.hooks.onSent?.(li, this.streamLi)
    }
    this.hooks.onWrite?.()
  }

  /** Clears the list (a new conversation, or a screen that no longer shows it). The answer in
   *  progress goes first, with its scheduled write (I3). */
  reset(): void {
    this.dropStream()
    this.items = []
    this.replies = 0
    this.lastMessages = null
    this.pendingLi = null
    this.pendingKey = ''
    this.sentLi = null
    this.view = null
    this.list.replaceChildren()
    this.syncTicker(null)
  }

  /** pagehide: the answer in progress is aborted with the page, so its text must not be what a
   *  page restored from the bfcache shows. The state drops it as well once the abort comes back. */
  dropStreamNow(): void {
    this.dropStream()
  }

  // ── confirmed messages ──

  private reconcile(view: TranscriptView, finished: boolean): void {
    const { messages } = view
    // A different conversation (or the opening message swapped before the first message): start over.
    const first = messages[0]
    const head = this.items[0]
    // The opening message swapped for another scenario's, in front of the person: it comes in.
    let swapped = false
    if (messages.length < this.items.length || (head !== undefined && (first === undefined || head.content !== first.content))) {
      swapped = messages.length === 1 && head !== undefined
      const keepStream = finished ? null : this.streamLi
      this.list.replaceChildren()
      this.items = []
      this.replies = 0
      this.pendingLi = null
      this.pendingKey = ''
      if (keepStream) this.list.append(keepStream)
    }
    for (let i = this.items.length; i < messages.length; i++) {
      const m = messages[i]!
      const time = view.times[i] ?? null
      let li: HTMLLIElement
      let text: Para
      if (m.role === 'user' && this.pendingLi !== null && this.pendingLi.isConnected && i === messages.length - 2 && finished) {
        li = this.pendingLi
        text = this.pendingText
        this.clearStatus(li)
        this.pendingLi = null
        this.pendingKey = ''
      } else if (m.role === 'assistant' && finished && i === messages.length - 1 && this.streamLi !== null) {
        li = this.streamLi
        this.cancelFlush()
        text = settle(this.streamText)
        // The screen keeps the whole answer even when the history keeps 4000 code points (§5.8).
        writeText(textBox(li), text, shown('assistant', this.target.length >= m.content.length ? this.target : m.content))
        li.classList.remove('said--streaming', 'said--waiting')
        setAttr(li, 'aria-busy', 'false')
        show(li.querySelector<HTMLElement>('.said__wait')!, false)
        this.streamLi = null
        this.streamText = []
        this.streamId = -1
        this.target = ''
      } else {
        const fresh = said(m.role)
        li = fresh.li
        text = fresh.text
        if (swapped) li.classList.add('said--in')
        writeText(textBox(li), text, shown(m.role, m.content))
        // Before the pending message, so the order stays: history, then what is still on its way.
        const before = this.pendingLi?.isConnected ? this.pendingLi : this.streamLi?.isConnected ? this.streamLi : null
        if (before) this.list.insertBefore(li, before)
        else this.list.append(li)
      }
      if (m.role === 'assistant' && i > 0) this.replies++
      writeMeta(li, m.role, i, time, this.replies)
      this.items.push({ li, role: m.role, content: m.content, text })
    }
    for (const [i, item] of this.items.entries()) show(item.li.querySelector<HTMLElement>('.said__cut')!, view.cut.includes(i))
    this.lastMessages = messages
  }

  /** «→ У тези»: pressed on the marked replies, on every sync (cheap: an attribute that only
   *  changes when a mark does). */
  private syncMarks(marks: readonly number[]): void {
    for (const [i, item] of this.items.entries()) {
      if (item.role !== 'assistant' || i === 0) continue
      const keep = item.li.querySelector<HTMLElement>('.said__keep')
      if (keep !== null) setAttr(keep, 'aria-pressed', marks.includes(i) ? 'true' : 'false')
    }
  }

  // ── the person's message that is not in the history yet ──

  private syncPending(view: TranscriptView, previous: TranscriptView | null): void {
    const pending = view.pending
    if (pending === null) {
      if (this.pendingLi !== null) {
        this.pendingLi.remove()
        this.pendingLi = null
        this.pendingKey = ''
      }
      return
    }
    const key = `${pending.text.length}:${pending.request.length}`
    if (this.pendingLi === null || this.pendingKey !== key || !this.pendingLi.isConnected) {
      this.pendingLi?.remove()
      const { li, text } = said('user')
      li.classList.add('said--in')
      writeText(textBox(li), text, pending.text)
      writeMeta(li, 'user', null, pending.at ?? null)
      const before = this.streamLi?.isConnected ? this.streamLi : null
      if (before) this.list.insertBefore(li, before)
      else this.list.append(li)
      this.pendingLi = li
      this.pendingText = text
      this.pendingKey = key
    }
    // The first send and «Надіслати ще раз» alike: the message goes to the top (§3.7.6).
    if (pending.status === 'sending' && previous?.pending?.status !== 'sending') this.sentLi = this.pendingLi
    this.renderStatus(this.pendingLi, view)
  }

  private renderStatus(li: HTMLLIElement, view: TranscriptView): void {
    const pending = view.pending!
    const status = li.querySelector<HTMLElement>('.said__status')!
    const flag = status.querySelector<HTMLElement>('.said__flag')!
    const why = status.querySelector<HTMLElement>('.said__why')!
    const id = status.querySelector<HTMLElement>('.said__id')!
    const slot = (name: string): HTMLElement => status.querySelector<HTMLElement>(`[data-slot="${name}"]`)!
    const resend = slot('resend').querySelector('button')!
    const only = (...names: string[]): void => {
      for (const name of ['resend', 'edit', 'pick', 'busy-cancel', 'copy', 'reload']) show(slot(name), names.includes(name))
    }
    if (pending.status === 'sending') {
      // llm_busy: the countdown is in the AI's slot, «Скасувати» under the message (§4.3).
      const busy = view.stream?.phase === 'busy-wait'
      show(status, busy)
      if (!busy) return
      show(flag, false)
      show(why, false)
      show(id, false)
      only('busy-cancel')
      return
    }
    show(status, true)
    show(flag, true)
    if (pending.status === 'stopped') {
      setText(flag, 'Відповідь зупинено')
      setText(why, '')
      show(why, false)
      show(id, false)
      only('resend', 'edit')
      setAttr(resend, 'aria-disabled', null)
      return
    }
    const error = pending.error
    const seconds = view.cooldownUntil === null ? null : Math.max(0, Math.ceil((view.cooldownUntil - Date.now()) / 1000))
    const text = error === null ? { why: '', reload: false, showId: false } : turnError(error, view.csrfFailures, seconds, view.revisit)
    setText(flag, 'Не надіслано')
    setText(why, text.why)
    show(why, text.why !== '')
    const idLine = text.showId && error !== null ? requestIdLine(error.requestId) : null
    setText(id, idLine ?? '')
    show(id, idLine !== null)
    const notFound = view.revisit && error?.code === 'not_found'
    const tooLarge = error?.code === 'payload_too_large'
    if (text.reload) only('copy', 'reload')
    else if (tooLarge) only()
    else if (notFound) only('pick', 'edit')
    else only('resend', 'edit')
    // Offline: «Надіслати ще раз» comes back with the `online` event (§4.3); a 429 waits its countdown.
    const offline = error?.code === 'network' && navigator.onLine === false
    setAttr(resend, 'aria-disabled', view.cooldownUntil !== null || offline ? 'true' : null)
  }

  /** online / offline: the unsent message's «Надіслати ще раз» follows the connection. */
  connectionChanged(): void {
    if (this.view?.pending && this.pendingLi?.isConnected) this.renderStatus(this.pendingLi, this.view)
  }

  private clearStatus(li: HTMLLIElement): void {
    show(li.querySelector<HTMLElement>('.said__status')!, false)
  }

  // ── the answer in progress ──

  private syncStream(stream: StreamView): void {
    if (this.streamLi === null) {
      const { li } = said('assistant')
      li.classList.add('said--live', 'said--in')
      setAttr(li, 'aria-busy', 'true')
      this.list.append(li)
      this.streamLi = li
      this.streamText = []
      this.streamId = stream.id
      this.target = ''
    }
    const li = this.streamLi
    const waiting = stream.phase !== 'streaming'
    li.classList.toggle('said--waiting', waiting)
    li.classList.toggle('said--streaming', !waiting)
    const wait = li.querySelector<HTMLElement>('.said__wait')!
    const key = `${stream.id}:${stream.phase}:${stream.stage}`
    if (key !== this.waitKey) {
      this.waitKey = key
      this.waitSince = Date.now()
    }
    if (waiting) {
      show(wait, true)
      this.updateWait()
    } else {
      show(wait, false)
    }
    if (stream.partial !== this.target) {
      const grows = stream.partial.startsWith(this.target)
      this.target = stream.partial
      if (grows) {
        this.scheduleFlush()
      } else {
        // A retry starts over (turn/reset): the cut attempt's text leaves now, not a frame later.
        this.cancelFlush()
        this.flush()
      }
    }
  }

  private updateWait(): void {
    const stream = this.view?.stream
    if (!stream || !this.streamLi || stream.phase === 'streaming') return
    const wait = this.streamLi.querySelector<HTMLElement>('.said__wait-text')!
    if (stream.phase === 'busy-wait') {
      const seconds = stream.until === null ? 0 : Math.ceil((stream.until - Date.now()) / 1000)
      setText(wait, busyWait(seconds))
    } else {
      setText(wait, waitLabel(stream.stage, Date.now() - this.waitSince))
    }
  }

  private syncTicker(view: TranscriptView | null): void {
    const needs =
      view !== null &&
      ((view.stream !== null && view.stream.phase !== 'streaming') || (view.cooldownUntil !== null && view.pending !== null))
    if (needs && this.ticker === null) {
      this.ticker = window.setInterval(() => {
        this.updateWait()
        if (this.view?.pending && this.pendingLi && this.view.cooldownUntil !== null) this.renderStatus(this.pendingLi, this.view)
      }, 1000)
    } else if (!needs && this.ticker !== null) {
      window.clearInterval(this.ticker)
      this.ticker = null
    }
  }

  private scheduleFlush(): void {
    if (this.scheduled !== null) return
    if (document.hidden) {
      this.scheduled = { kind: 'timer', handle: window.setTimeout(() => this.flush(), 250) }
    } else if (!decorativeMotion()) {
      this.scheduled = { kind: 'timer', handle: window.setTimeout(() => this.flush(), 300) }
    } else {
      this.scheduled = { kind: 'raf', handle: window.requestAnimationFrame(() => this.flush()) }
    }
  }

  private cancelFlush(): void {
    if (this.scheduled === null) return
    if (this.scheduled.kind === 'raf') window.cancelAnimationFrame(this.scheduled.handle)
    else window.clearTimeout(this.scheduled.handle)
    this.scheduled = null
  }

  private flush(): void {
    this.scheduled = null
    if (this.streamLi === null) return
    // The whole answer so far, masked: digits that came in separate tokens are one number here. A
    // number still coming in (a trailing run of digits) waits until its end is in.
    const masked = shown('assistant', this.target)
    writeLive(textBox(this.streamLi), this.streamText, holdNumberTail(masked), decorativeMotion() && !document.hidden)
    this.hooks.onWrite?.()
    if (this.target === '') return
    const now = performance.now()
    if (now - this.lastPulse >= 250) {
      this.lastPulse = now
      this.hooks.onPulse?.()
    }
  }

  private dropStream(): void {
    this.cancelFlush()
    this.target = ''
    this.streamLi?.remove()
    this.streamLi = null
    this.streamText = []
    this.streamId = -1
    this.waitKey = ''
  }
}
