// Model → page (spec §9.1 render.ts). One section per State.s, `hidden` on the others. A new screen
// closes every dialog and moves focus to its h1 (or to its banner, or — on a desktop new
// conversation — into the message field), I6. Page attributes carry the screen and the presence,
// never any text of the conversation (I1).

import type { GlControl } from '../../gl/core/boot'
import type { PresenceHandle } from '../../gl/presence'
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

export function createView(dispatch: (action: Action) => void, gl: GlControl<PresenceHandle> | null, sound: SoundControl | null): View {
  const html = document.documentElement
  const main = document.querySelector<HTMLElement>('main')!
  const header = document.querySelector<HTMLElement>('[data-header]')!
  const account = document.querySelector<HTMLElement>('.account-toggle')!
  const help = document.querySelector<HTMLElement>('.help-link')!
  const presenceRoot = document.querySelector<HTMLElement>('.presence')!
  const sections = new Map<string, HTMLElement>(
    Array.from(document.querySelectorAll<HTMLElement>('[data-screen]')).map((section) => [section.dataset.screen!, section]),
  )

  // Heights of the sticky layers, measured (spec §3.1): text zoom or a wrapped header changes them.
  const heights = { header: 0, session: 0, composer: 0 }
  const measure = (): void => {
    const session = document.querySelector<HTMLElement>('[data-el="session"]')
    const composer = document.querySelector<HTMLElement>('[data-el="composer"]')
    heights.header = header.getBoundingClientRect().height
    heights.session = session && !session.hidden && session.closest('[hidden]') === null ? session.getBoundingClientRect().height : 0
    heights.composer = composer && !composer.hidden && composer.closest('[hidden]') === null ? composer.getBoundingClientRect().height : 0
    html.style.setProperty('--header-h', `${Math.round(heights.header)}px`)
    html.style.setProperty('--session-h', `${Math.round(heights.session)}px`)
    html.style.setProperty('--composer-h', `${Math.round(heights.composer)}px`)
  }
  const observer = new ResizeObserver(measure)
  observer.observe(header)
  for (const name of ['session', 'composer']) {
    const node = document.querySelector<HTMLElement>(`[data-el="${name}"]`)
    if (node) observer.observe(node)
  }

  const presence: PresenceView = createPresence(presenceRoot, gl, sound)
  const dialogs = createDialogs(dispatch)
  const chat = chatScreen(dispatch, () => ({ top: heights.header + heights.session, bottom: heights.composer }), () => presence.pulse())
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

  /** The light pauses where its slot is not shown: a phone in a running conversation, the crisis. */
  const syncSlot = (model: Model): void => {
    const { state } = model
    const talking = state.s === 'chat' && hasUserMessage(state.session, state.pending)
    const slotShown = WIDE.matches || !(talking || state.s === 'crisis')
    gl?.setActive(slotShown)
    html.dataset.talk = talking ? 'on' : 'off'
  }
  WIDE.addEventListener('change', () => {
    if (lastModel) syncSlot(lastModel)
  })

  const render = (model: Model, prev: Model | null): void => {
    lastModel = model
    const s = model.state.s
    const changed = prev === null || prev.state.s !== s
    if (changed) {
      for (const [name, section] of sections) show(section, name === s)
      html.dataset.screen = s
      setAttr(main, 'aria-busy', s === 'booting' ? 'true' : 'false')
    }
    const signedIn = model.ctx.me !== null && s !== 'signed-out' && s !== 'account-deleted' && s !== 'booting'
    show(account, signedIn)
    setAttr(help, 'aria-current', s === 'crisis' ? 'true' : null)

    screens[s].render(model, changed)
    dialogs.sync(model, changed)
    presence.sync(model, dialogs.helpOpen())
    syncSlot(model)
    measure()

    if (changed && s !== 'booting') {
      const section = sections.get(s)!
      const target = screens[s].focusTarget?.(model) ?? headingOf(section)
      target?.focus()
    }
  }

  return { render, chat, consent, review, dialogs }
}
