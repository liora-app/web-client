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
// - A line over the field that the person did not ask for (the reminder to pause) does not cover
//   the end it lands on: with the end in view, the page moves up by the line's height (hold()).

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
  /** `change` makes the composer taller with something the person did not ask for (the reminder to
   *  pause): if the end of the conversation was in view, the page moves up by as much, so the line
   *  does not cover it. Scrolled up, nothing moves; the focus never does. */
  hold(change: () => void): void
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
  /** Counts the sends (and the resets): a scroll queued for an earlier one does not run. */
  let sends = 0

  const measure = (): void => {
    root.style.setProperty('--header-h', `${Math.round(shownHeight(header))}px`)
    root.style.setProperty('--session-h', `${Math.round(shownHeight(session))}px`)
    root.style.setProperty('--composer-h', `${Math.round(shownHeight(composer))}px`)
    // A classic scrollbar keeps its gutter (scrollbar-gutter: stable) in the page's background
    // colour; only then does the sky ease into that colour at the right edge (chat.css,
    // html[data-gutter]). Overlay scrollbars — phones, macOS — have none, and the same fade there
    // would be a dark band down the right edge. The root's box ends where the gutter begins
    // (clientWidth does not: Chromium leaves a reserved but empty gutter out of it). The header
    // spans that box, so its observer sees the gutter come and go.
    root.toggleAttribute('data-gutter', window.innerWidth - root.getBoundingClientRect().width > 1)
  }

  /** The bottom of what the last message shows (its body, not the room under it). */
  const lastBottom = (): number | null => {
    const last = talk.lastElementChild as HTMLElement | null
    if (last === null) return null
    const body = last.querySelector<HTMLElement>('.said__body') ?? last
    return body.getBoundingClientRect().bottom
  }

  /** Hides the pill. If it had the focus — pressed, or the page scrolled under it — the focus goes
   *  on (I6: never on body): from the keyboard to the field, from a tap to the screen's h1, since
   *  focusing the field inside a tap would pop the on-screen keyboard. */
  const hide = (): void => {
    if (jump.hidden) return
    if (document.activeElement !== jump) {
      show(jump, false)
      return
    }
    let fromKeys = false
    try {
      fromKeys = jump.matches(':focus-visible')
    } catch {
      fromKeys = false
    }
    show(jump, false)
    parts.focusAfterJump(fromKeys)?.focus({ preventScroll: true })
  }

  const check = (): void => {
    frame = 0
    if (!ctx.shown || shownHeight(composer) === 0) {
      hide()
      return
    }
    const bottom = lastBottom()
    if (bottom === null) {
      hide()
      return
    }
    setText(jumpText, ctx.streaming ? 'Далі відповідь' : 'До кінця')
    if (bottom - 4 > composer.getBoundingClientRect().top) show(jump, true)
    else hide()
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
      const turn = ++sends
      // After the whole render, not in the middle of it: the first message also hides the phone's
      // light slot, the starters and the composer's note in the same render, after the transcript.
      // Measured and scrolled before that, the room was sized for the old composer, the page then got
      // shorter and an instant scroll ended clamped short — the reply above rested half under the top
      // fade. A microtask still comes before the frame is painted.
      queueMicrotask(() => {
        if (turn !== sends || !message.isConnected) return
        if (answer !== null && answer.isConnected) {
          answer.style.setProperty('--sent-h', `${Math.round(message.getBoundingClientRect().height)}px`)
          answer.classList.add(ROOM)
        }
        // The header, the session row and the composer are measured now: scroll-padding-top and the
        // room are right.
        measure()
        message.scrollIntoView({ block: 'start', behavior: motionAllowed() ? 'smooth' : 'auto' })
        update()
      })
    },
    context(next) {
      // Renders come with every token: no layout read here (ResizeObserver tracks the sizes).
      ctx = next
      update()
    },
    update,
    jumpToEnd() {
      // An instant jump: 'auto' would take the page's smooth scroll-behavior, the check right after
      // would still see the pill needed, and it would hide later under the focus it had (a tap
      // focuses it too, on Android Chrome). hide() hands that focus on either way.
      const last = talk.lastElementChild as HTMLElement | null
      const body = last?.querySelector<HTMLElement>('.said__body') ?? last
      try {
        body?.scrollIntoView({ block: 'end', behavior: 'instant' })
      } catch {
        // An engine that does not know 'instant' (a WebIDL enum) throws; the plain call is instant.
        body?.scrollIntoView(false)
      }
      check()
    },
    hold(change) {
      // Two layout reads, and only when such a line comes (once a conversation), never per token.
      const before = ctx.shown && shownHeight(composer) > 0 ? lastBottom() : null
      const top = composer.getBoundingClientRect().top
      change()
      if (before === null || before - 4 > top) return
      const grown = top - composer.getBoundingClientRect().top
      if (grown <= 0 || before - 4 <= top - grown) return
      // The composer is sticky: it grew upward over the end. The room under the answer and the
      // scroll padding follow the new height first, then the page moves by exactly that — at once,
      // as the line comes, not a smooth scroll that shows the end covered first.
      measure()
      try {
        window.scrollBy({ top: grown, behavior: 'instant' })
      } catch {
        window.scrollBy(0, grown)
      }
      update()
    },
    reset() {
      room = null
      sends++
      if (frame !== 0) window.cancelAnimationFrame(frame)
      frame = 0
      ctx = { shown: false, streaming: false }
      // The screen is going or starting over: its own focus rule applies, not the pill's.
      show(jump, false)
    },
  }
}
