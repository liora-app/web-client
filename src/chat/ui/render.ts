// Model → page (spec §9.1 render.ts). One section per State.s, `hidden` on the others. A new screen
// closes every dialog and moves focus to its h1 (or to its banner, or — on a desktop new
// conversation — into the message field), I6. Page attributes carry the screen and the presence,
// never any text of the conversation (I1).

import type { GlControl } from '../../gl/core/boot'
import type { PresenceHandle } from '../../gl/presence'
import type { SkyControl } from '../../ui/sky'
import type { SoundControl } from '../../ui/sound'
import { hasUserMessage, type Action, type Model, type State } from '../core/state'
import { createDialogs, type Dialogs } from './dialogs'
import { headingOf, setAttr, show } from './dom'
import { createPresence, type PresenceView } from './presence'
import { chatScreen, type ChatScreen } from './screens/chat'
import { consentScreen } from './screens/consent'
import { crisisScreen } from './screens/crisis'
import {
  deletedScreen,
  expiredScreen,
  fatalScreen,
  notInvitedScreen,
  savedScreen,
  signInScreen,
  staticScreen,
  type Screen,
} from './screens/text'
import { reviewScreen, summarizingScreen, type ReviewScreen } from './screens/theses'

export type View = Readonly<{
  render(model: Model, prev: Model | null): void
  chat: ChatScreen
  consent: ReturnType<typeof consentScreen>
  review: ReviewScreen
  dialogs: Dialogs
}>

const WIDE = window.matchMedia('(min-width: 64em)')

export type ViewDeps = Readonly<{
  gl: GlControl<PresenceHandle> | null
  sound: SoundControl | null
  sky: SkyControl | null
}>

export function createView(dispatch: (action: Action) => void, { gl, sound, sky }: ViewDeps): View {
  const html = document.documentElement
  const main = document.querySelector<HTMLElement>('main')!
  const account = document.querySelector<HTMLElement>('.account-toggle')!
  const help = document.querySelector<HTMLElement>('.help-link')!
  const presenceRoot = document.querySelector<HTMLElement>('.presence')!
  const sections = new Map<string, HTMLElement>(
    Array.from(document.querySelectorAll<HTMLElement>('[data-screen]')).map((section) => [section.dataset.screen!, section]),
  )

  const presence: PresenceView = createPresence(presenceRoot, gl, sound)
  const dialogs = createDialogs(dispatch)
  const chat = chatScreen(dispatch, () => presence.pulse())
  const consent = consentScreen()
  const review = reviewScreen(dispatch)
  const screens: Record<State['s'], Screen> = {
    booting: staticScreen,
    'signed-out': signInScreen(),
    'not-invited': notInvitedScreen(),
    consent,
    chat,
    'session-expired': expiredScreen(),
    crisis: crisisScreen(),
    summarizing: summarizingScreen(),
    review,
    saved: savedScreen(),
    ended: staticScreen,
    'account-deleted': deletedScreen(),
    fatal: fatalScreen(),
  }

  let lastModel: Model | null = null

  /** Where the WebGL light runs (§3.1, §9.2 item 6). Desktop: always, in the scene column. Phone:
   *  only in a new conversation, until the first message — after «Надіслати» it pauses, a new
   *  conversation resumes it; on the other screens the slot shows the still CSS orb
   *  (html[data-slot="still"]), and in the crisis there is no light at all. A hidden tab pauses
   *  the scene by itself (gl/presence.ts). */
  const syncSlot = (model: Model): void => {
    const { state } = model
    const talking = state.s === 'chat' && hasUserMessage(state.session, state.pending)
    const live = WIDE.matches || (state.s === 'chat' && !talking)
    gl?.setActive(live)
    // Renders come with every token: touch the attributes only when they change.
    setAttr(html, 'data-talk', talking ? 'on' : 'off')
    setAttr(html, 'data-slot', live ? 'live' : 'still')
  }
  WIDE.addEventListener('change', () => {
    if (lastModel) syncSlot(lastModel)
  })

  const render = (model: Model, prev: Model | null): void => {
    lastModel = model
    const s = model.state.s
    const changed = prev === null || prev.state.s !== s
    if (changed) {
      // The screen being left lets go of the conversation first — the answer in progress and its
      // scheduled write before anything else (I3, §5.7) — then the new one shows.
      if (prev !== null) screens[prev.state.s].leave?.(model)
      for (const [name, section] of sections) show(section, name === s)
      html.dataset.screen = s
      // A screen starts at its top. The document scrolls, and the offset the last screen left (the
      // send anchor moves the conversation up, smoothly while motion is on) would otherwise carry
      // over: the crisis numbers could open below the fold on a phone (§6.4). An instant scroll
      // also stops a smooth one still running. Whatever the new screen scrolls to — its focus, the
      // send anchor of a repeated turn — comes after this.
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
      setAttr(main, 'aria-busy', s === 'booting' ? 'true' : 'false')
      // The help contacts always stand on the night sky (§9.2).
      sky?.setSuppressed(s === 'crisis')
    }
    const signedIn = model.ctx.me !== null && s !== 'signed-out' && s !== 'account-deleted' && s !== 'booting'
    show(account, signedIn)
    setAttr(help, 'aria-current', s === 'crisis' ? 'true' : null)

    screens[s].render(model, changed)
    dialogs.sync(model, changed)
    presence.sync(model, dialogs.helpOpen())
    syncSlot(model)

    if (changed && s !== 'booting') {
      const section = sections.get(s)!
      const target = screens[s].focusTarget?.(model) ?? headingOf(section)
      target?.focus()
    }
  }

  return { render, chat, consent, review, dialogs }
}
