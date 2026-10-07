// SSE over a POST response body (spec §5.3–5.4). EventSource cannot POST, so the turn reads
// `fetch(…).body` and parses frames itself.

import { sanitizeHelplines, type SafeHelplines } from './helplines'

export type SseFrame = Readonly<{ event: string; data: string }>

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProtocolError'
  }
}

/** Limit on a frame that has not ended yet. Complete frames are cut out first, so one big chunk
 *  holding many valid frames (a thawed tab, a fulfilled mock) is not an error. */
export const MAX_FRAME_BUFFER = 256 * 1024

/**
 * Frames of an event stream, in order. `onBytes` runs on every chunk, comments (": ping")
 * included, so the idle watchdog sees that the connection is alive.
 * - A UTF-8 character split between chunks is joined (TextDecoder in stream mode).
 * - CRLF, CR and LF all end a line, even when "\r" and "\n" arrive in different chunks.
 * - A tail without the blank line is an incomplete frame and is dropped: the caller sees the end
 *   of the stream without a final event.
 * - Leaving the loop (a final event, an abort) cancels the reader, which closes the connection.
 */
export async function* readFrames(
  body: ReadableStream<Uint8Array>,
  onBytes: () => void = () => {},
  maxBuffer: number = MAX_FRAME_BUFFER,
): AsyncGenerator<SseFrame, void, undefined> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buf = ''
  let carryCR = false
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      onBytes()
      let text = decoder.decode(value, { stream: true })
      if (text === '') continue
      if (carryCR && text.startsWith('\n')) text = text.slice(1)
      carryCR = text.endsWith('\r')
      buf += text.replace(/\r\n?/g, '\n')
      for (let cut = buf.indexOf('\n\n'); cut !== -1; cut = buf.indexOf('\n\n')) {
        const frame = parseBlock(buf.slice(0, cut))
        buf = buf.slice(cut + 2)
        if (frame !== null) yield frame
      }
      if (buf.length > maxBuffer) throw new ProtocolError('frame too large')
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

function parseBlock(block: string): SseFrame | null {
  let event = 'message'
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue // ": ping" and any other comment
    const i = line.indexOf(':')
    const name = i === -1 ? line : line.slice(0, i)
    const value = i === -1 ? '' : line.slice(i + 1).replace(/^ /, '')
    if (name === 'event') event = value
    else if (name === 'data') data.push(value)
    // id, retry and unknown fields are ignored.
  }
  return data.length > 0 ? { event, data: data.join('\n') } : null
}

// ── Events of POST /chat/turn ────────────────────────────────────────────────────────────────

export type StreamErrorCode = 'llm_failed' | 'llm_busy' | 'internal'

/** A checked event. `crisis.helplines` is already sanitized: the raw object stops here. */
export type TurnEvent =
  | Readonly<{ type: 'meta'; requestId: string | null }>
  | Readonly<{ type: 'token'; text: string }>
  | Readonly<{ type: 'done'; finishReason: string | null }>
  | Readonly<{ type: 'crisis'; source: 'keyword' | 'model'; helplines: SafeHelplines }>
  | Readonly<{ type: 'error'; code: StreamErrorCode; retryable: boolean }>

const TYPES = new Set(['meta', 'token', 'done', 'crisis', 'error'])
const ERROR_CODES = new Set<string>(['llm_failed', 'llm_busy', 'internal'])

export function isFinal(event: TurnEvent): boolean {
  return event.type === 'done' || event.type === 'crisis' || event.type === 'error'
}

/** One frame → one checked event, or null to skip it (unknown type, `type` ≠ event name, broken
 *  JSON: forward compatibility, not an error). */
export function parseEvent(frame: SseFrame): TurnEvent | null {
  let raw: unknown
  try {
    raw = JSON.parse(frame.data)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (typeof o.type !== 'string' || o.type !== frame.event || !TYPES.has(o.type)) return null
  switch (o.type) {
    case 'meta':
      return { type: 'meta', requestId: typeof o.request_id === 'string' ? o.request_id : null }
    case 'token':
      return typeof o.text === 'string' ? { type: 'token', text: o.text } : null
    case 'done':
      return { type: 'done', finishReason: typeof o.finish_reason === 'string' ? o.finish_reason : null }
    case 'crisis':
      // Any crisis frame stops the conversation, whatever else is wrong with it.
      return { type: 'crisis', source: o.source === 'keyword' ? 'keyword' : 'model', helplines: sanitizeHelplines(o.helplines) }
    case 'error':
      return {
        type: 'error',
        code: typeof o.code === 'string' && ERROR_CODES.has(o.code) ? (o.code as StreamErrorCode) : 'internal',
        retryable: o.retryable === true,
      }
    default:
      return null
  }
}

/**
 * `meta` → `token`* → exactly one final event (`done`, `crisis` or `error`). Reading stops at the
 * final event — the frame source is closed, so the reader is cancelled and whatever follows is
 * never read. A missing `meta` is tolerated (the request id is also in a header).
 */
export async function* chatEvents(frames: AsyncIterable<SseFrame>): AsyncGenerator<TurnEvent, void, undefined> {
  for await (const frame of frames) {
    const event = parseEvent(frame)
    if (event === null) continue
    yield event
    if (isFinal(event)) return
  }
}
