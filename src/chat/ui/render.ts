// Model → page (spec §9.1 render.ts). One section per State.s, `hidden` on the others. A new screen
// closes every dialog and moves focus to its h1 (or to its banner, or — on a desktop new
// conversation — into the message field), I6. Within a screen, a control that hides once pressed
// («Надіслати ще раз», «Спробувати ще раз»…) hands the focus on instead of dropping it on <body>.
// Page attributes carry the screen and the presence, never any text of the conversation (I1).

import type { GlControl } from '../../gl/core/boot'
import type { PresenceHandle } from '../../gl/presence'
import type { CharacterControl } from '../../ui/character'
import type { SkyControl } from '../../ui/sky'
import type { SoundControl } from '../../ui/sound'
import { skipThemeTransition } from '../../ui/theme'
import type { ThemePicker } from '../../ui/theme-picker'
import { canOpenJournal, hasUserMessage, sessionOf, type Action, type Model, type State } from '../core/state'
import { createDialogs, type Dialogs } from './dialogs'
import { finePointer, headingOf, setAttr, show } from './dom'
import { createPresence, type PresenceView } from './presence'
import { chatScreen, type ChatScreen } from './screens/chat'
import { consentScreen } from './screens/consent'
import { crisisScreen } from './screens/crisis'
import { journalScreen, type JournalScreen } from './screens/journal'
import {
  deletedScreen,
  endedScreen,
  expiredScreen,
  fatalScreen,
  notInvitedScreen,
  savedScreen,
  signInScreen,
  staticScreen,
  type Screen,
} from './screens/text'
import { reviewScreen, summarizingScreen, type ReviewScreen } from './screens/theses'
import { createTools, type Tools } from './tools'

export type View = Readonly<{
  render(model: Model, prev: Model | null): void
  chat: ChatScreen
  consent: ReturnType<typeof consentScreen>
  review: ReviewScreen
  journal: JournalScreen
  dialogs: Dialogs
  tools: Tools
}>

const WIDE = window.matchMedia('(min-width: 64em)')

export type ViewDeps = Readonly<{
  gl: GlControl<PresenceHandle> | null
  /** «Персонаж»: hidden, the light runs nowhere (src/ui/character.ts). */
  character: CharacterControl | null
  sound: SoundControl | null
  sky: SkyControl | null
  theme: ThemePicker | null
  /** The page's one polite live region (announcer.ts), for what a screen does where the focus is
   *  not: words put into the field from a touch screen, another week of the diary. */
  say: (text: string) => void
}>

export function createView(dispatch: (action: Action) => void, { gl, character, sound, sky, theme, say }: ViewDeps): View {
  const html = document.documentElement
  const main = document.querySelector<HTMLElement>('main')!
  const account = document.querySelector<HTMLElement>('.account-toggle')!
  const journalToggle = document.querySelector<HTMLElement>('[data-el="journal-toggle"]')!
  const help = document.querySelector<HTMLElement>('.help-link')!
  const presenceRoot = document.querySelector<HTMLElement>('.presence')!
  const sections = new Map<string, HTMLElement>(
    Array.from(document.querySelectorAll<HTMLElement>('[data-screen]')).map((section) => [section.dataset.screen!, section]),
  )

  const presence: PresenceView = createPresence(presenceRoot, gl, sound)
  // The self-help tools (§3.13) put a mood sentence into the field: the chat screen's composer,
  // created just below.
  const tools = createTools(dispatch, () => chat.composer)
  const dialogs = createDialogs(dispatch, tools)
  const chat = chatScreen(dispatch, () => presence.pulse(), () => presence.listen(), say)
  const consent = consentScreen()
  const review = reviewScreen(dispatch)
  const journal = journalScreen(dispatch, say)
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
    ended: endedScreen(),
    journal,
    'account-deleted': deletedScreen(),
    fatal: fatalScreen(),
  }

  let lastModel: Model | null = null

  /** Where the WebGL light runs (§3.1, §9.2 item 6). Desktop: always, in the scene column. Phone:
   *  only in a new conversation, until the first message — after «Надіслати» it pauses, a new
   *  conversation resumes it; on the other screens the slot shows the still CSS orb
   *  (html[data-slot="still"]), and in the crisis there is no light at all, at any width (ADR-013:
   *  chat.css takes the scene out too). A hidden tab pauses the scene by itself (gl/presence.ts).
   *  With «Персонаж» off it runs nowhere: the one place that says so, or the next render would
   *  start it again. */
  const syncSlot = (model: Model): void => {
    const { state } = model
    const talking = state.s === 'chat' && hasUserMessage(state.session, state.pending)
    const live = (character?.shown() ?? true) && state.s !== 'crisis' && (WIDE.matches || (state.s === 'chat' && !talking))
    gl?.setActive(live)
    // Renders come with every token: touch the attributes only when they change.
    setAttr(html, 'data-talk', talking ? 'on' : 'off')
    setAttr(html, 'data-slot', live ? 'live' : 'still')
  }
  WIDE.addEventListener('change', () => {
    if (lastModel) syncSlot(lastModel)
  })
  character?.onChange(() => {
    if (lastModel) syncSlot(lastModel)
  })

  /** Where the focus goes when the control that had it went away within the screen (I6). */
  const fallback = (model: Model): HTMLElement | null => {
    const section = sections.get(model.state.s)!
    if (model.state.s === 'chat') {
      // The field on a desktop (on a phone it would pop the keyboard), else a block that replaced it.
      const field = section.querySelector<HTMLElement>('textarea')
      if (finePointer() && field !== null && field.isConnected && field.closest('[hidden]') === null) return field
      const block = section.querySelector<HTMLElement>('[data-el="chat-block"]:not([hidden]) button:not([hidden])')
      if (block !== null && block.closest('[hidden]') === null) return block
    }
    return headingOf(section) ?? main
  }

  /** Checked once the click handler and the effects are through: they may have placed the focus
   *  themselves («Змінити» puts the text back into the field, «Прибрати» focuses «Повернути»). */
  const keepFocus = (lost: Element | null): void => {
    if (!(lost instanceof HTMLElement) || lost === document.body) return
    queueMicrotask(() => {
      if (lastModel === null) return
      if (lost.isConnected && lost.closest('[hidden]') === null) return
      const active = document.activeElement
      if (active !== null && active !== document.body && active !== lost) return
      if (dialogs.focusTop()) return
      fallback(lastModel)?.focus({ preventScroll: true })
    })
  }

  const render = (model: Model, prev: Model | null): void => {
    lastModel = model
    const s = model.state.s
    const changed = prev === null || prev.state.s !== s
    const focused = document.activeElement
    if (changed) {
      // The screen being left lets go of the conversation first — the answer in progress and its
      // scheduled write before anything else (I3, §5.7) — then the new one shows.
      if (prev !== null) screens[prev.state.s].leave?.(model)
      // The conversation is over (saved, ended, crisis, signed out, wiped at pagehide…): so is what
      // was typed for it, whichever screen the page was on — the theses, a consent, session-expired.
      // The field itself is out of the DOM there, so the text would come back with it. Not
      // through the `composer` effect: that one focuses the field and pops a phone's keyboard.
      if (sessionOf(model.state) === null) chat.composer.clear()
      for (const [name, section] of sections) show(section, name === s)
      html.dataset.screen = s
      // A screen starts at its top. The document scrolls, and the offset the last screen left (the
      // send anchor moves the conversation up, smoothly while motion is on) would otherwise carry
      // over: the crisis numbers could open below the fold on a phone (§6.4). An instant scroll
      // also stops a smooth one still running. Whatever the new screen scrolls to — its focus, the
      // send anchor of a repeated turn — comes after this. An engine that does not know 'instant'
      // throws on it (a WebIDL enum); the plain call still gets the screen to its top, and the
      // render goes on — the crisis screen above all.
      try {
        window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
      } catch {
        window.scrollTo(0, 0)
      }
      setAttr(main, 'aria-busy', s === 'booting' ? 'true' : 'false')
      // The crisis keeps the person's theme but takes off the sky preset (and, in chat.css, the
      // haze, the grain and the vignette): the help contacts stand on the theme's plain sky (§9.2).
      sky?.setSuppressed(s === 'crisis')
      // The «Вигляд» menu does not stay open over a new screen — over the crisis above all — and a
      // theme cross-fade still running ends at once: a screen comes in one frame (§0).
      theme?.close()
      skipThemeTransition()
    }
    // «Акаунт» only with a live session: not after a 401 either (§8.1).
    const signedIn = model.ctx.me !== null && s !== 'signed-out' && s !== 'account-deleted' && s !== 'booting' && s !== 'session-expired'
    show(account, signedIn)
    // «Щоденник» beside it: there while «Акаунт» is, aria-disabled while the diary cannot open (the AI
    // writes, the theses are open…); pressed then, it says why (main.ts).
    show(journalToggle, signedIn)
    setAttr(journalToggle, 'aria-disabled', canOpenJournal(model.state) ? null : 'true')
    setAttr(help, 'aria-current', s === 'crisis' ? 'true' : null)

    screens[s].render(model, changed)
    dialogs.sync(model, changed)
    tools.sync(model)
    presence.sync(model, dialogs.helpOpen())
    syncSlot(model)

    // The first paint keeps the browser's focus; any later screen takes it — `booting` again (after
    // «Спробувати ще раз», say) has no h1, so <main> holds it until the next screen (I6).
    if (changed && (s !== 'booting' || prev !== null)) {
      const section = sections.get(s)!
      const target = screens[s].focusTarget?.(model) ?? headingOf(section) ?? main
      // The message field sits in the sticky composer, always in view: focusing it must not scroll
      // the page away from the top it was just put at (§3.6).
      target.focus(target instanceof HTMLTextAreaElement ? { preventScroll: true } : undefined)
    } else if (!changed) {
      keepFocus(focused)
    }
  }

  return { render, chat, consent, review, journal, dialogs, tools }
}
