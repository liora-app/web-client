// Where the conversation sits on the screen (spec §3.1, §3.7.6). The document scrolls, not a box.
//
// - The sticky layers are measured, not assumed: ResizeObserver on the header, the session row and
//   the composer writes --header-h, --session-h and --composer-h on :root (CSSOM setProperty, which
//   the CSP allows). chat.css turns them into scroll-padding, so focus never hides under them
//   (WCAG 2.2 SC 2.4.11), and into the room under a sent message.
// - The send anchor: after «Надіслати» the person's message goes to the top (smoothly only with
//   motion) and the answer's slot gets the room under it (.said--room), so the answer grows into
//   empty space and the page does not move while it streams.
// - The answer is not followed. Once its end is under the composer, the «↓» pill appears over the
//   field: «Далі відповідь» while it streams, «До кінця» after; it goes as soon as the end is in
//   view. If the person scrolled up, nothing moves.

import { motionAllowed } from '../../ui/motion'
import { setText, show } from './dom'

export type AnchorContext = Readonly<{
  /** The chat screen is up and the person has written something: the pill may show. */
  shown: boolean
  /** The answer is streaming (the pill says «Далі відповідь»). */
  streaming: boolean
}>

export type ScrollAnchor = Readonly<{
  /** The message just sent goes to the top; the answer under it gets the room. */
  sent(message: HTMLElement, answer: HTMLElement | null): void
  /** The chat screen's render: whether the pill may show at all, and what it says. */
  context(next: AnchorContext): void
  /** Look again once the layout settled (a write of streamed text, a render). One read a frame. */
  update(): void
  /** «↓ До кінця»: the end of the last message just above the composer. */
  jumpToEnd(): void
  /** A new conversation or another screen: no room kept, no pill. */
  reset(): void
}>

export type AnchorParts = Readonly<{
  header: HTMLElement
  session: HTMLElement
  composer: HTMLElement
  talk: HTMLElement
  jump: HTMLElement
  jumpText: HTMLElement
  /** Where focus goes when the pill it was on disappears (I6: never on body); fromKeys: the pill
   *  was pressed from the keyboard, not tapped. */
  focusAfterJump: (fromKeys: boolean) => HTMLElement | null
}>

const ROOM = 'said--room'

/** Shown: in the document, not hidden, not inside something hidden. */
function shownHeight(node: HTMLElement): number {
  if (!node.isConnected || node.hidden || node.closest('[hidden]') !== null) return 0
  return node.getBoundingClientRect().height
}

export function createScrollAnchor(parts: AnchorParts): ScrollAnchor {
  const { header, session, composer, talk, jump, jumpText } = parts
  const root = document.documentElement
  let ctx: AnchorContext = { shown: false, streaming: false }
  let room: HTMLElement | null = null
  let frame = 0

  const measure = (): void => {
    root.style.setProperty('--header-h', `${Math.round(shownHeight(header))}px`)
    root.style.setProperty('--session-h', `${Math.round(shownHeight(session))}px`)
    root.style.setProperty('--composer-h', `${Math.round(shownHeight(composer))}px`)
  }

  /** The bottom of what the last message shows (its body, not the room under it). */
  const lastBottom = (): number | null => {
    const last = talk.lastElementChild as HTMLElement | null
    if (last === null) return null
    const body = last.querySelector<HTMLElement>('.said__body') ?? last
    return body.getBoundingClientRect().bottom
  }

  const check = (): void => {
    frame = 0
    if (!ctx.shown || shownHeight(composer) === 0) {
      show(jump, false)
      return
    }
    const bottom = lastBottom()
    if (bottom === null) {
      show(jump, false)
      return
    }
    setText(jumpText, ctx.streaming ? 'Далі відповідь' : 'До кінця')
    show(jump, bottom - 4 > composer.getBoundingClientRect().top)
  }

  const update = (): void => {
    if (frame === 0) frame = window.requestAnimationFrame(check)
  }

  const observer = new ResizeObserver(() => {
    measure()
    update()
  })
  for (const node of [header, session, composer]) observer.observe(node)
  window.addEventListener('scroll', update, { passive: true })
  window.addEventListener('resize', update)
  measure()

  return {
    sent(message, answer) {
      if (room !== null && room !== answer) {
        room.classList.remove(ROOM)
        room.style.removeProperty('--sent-h')
      }
      room = answer
      if (answer !== null) {
        answer.style.setProperty('--sent-h', `${Math.round(message.getBoundingClientRect().height)}px`)
        answer.classList.add(ROOM)
      }
      // The header and the session row are measured by now: scroll-padding-top is right.
      measure()
      message.scrollIntoView({ block: 'start', behavior: motionAllowed() ? 'smooth' : 'auto' })
      update()
    },
    context(next) {
      // Renders come with every token: no layout read here (ResizeObserver tracks the sizes).
      ctx = next
      update()
    },
    update,
    jumpToEnd() {
      // The pill hides under the focus it had (a tap focuses it too, on Android Chrome). From the
      // keyboard focus goes on to the field; from a tap to the screen's h1, since focusing the
      // field inside a tap would pop the on-screen keyboard.
      const hadFocus = document.activeElement === jump
      let fromKeys = false
      try {
        fromKeys = hadFocus && jump.matches(':focus-visible')
      } catch {
        fromKeys = false
      }
      const last = talk.lastElementChild as HTMLElement | null
      const body = last?.querySelector<HTMLElement>('.said__body') ?? last
      body?.scrollIntoView({ block: 'end', behavior: 'auto' })
      check()
      if (hadFocus && jump.hidden) parts.focusAfterJump(fromKeys)?.focus({ preventScroll: true })
    },
    reset() {
      room = null
      if (frame !== 0) window.cancelAnimationFrame(frame)
      frame = 0
      ctx = { shown: false, streaming: false }
      show(jump, false)
    },
  }
}
