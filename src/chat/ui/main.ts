// Entry of chat/index.html (spec §9.1): styles, «Пауза» and «Звук», the theme and the sky preset,
// the light in its slot, the on-screen keyboard, and the state machine of src/chat/core driven
// through store → render → effects.

import '../../styles/fonts.css'
import '../../styles/tokens.css'
import '../../styles/base.css'
import '../../styles/stage.css'
import '../../styles/layout.css'
import '../../styles/components.css'
import '../../styles/chat.css'

import { bootGL } from '../../gl/core/boot'
import type { PresenceHandle } from '../../gl/presence'
import { initMotionToggle } from '../../ui/motion'
import { initSky } from '../../ui/sky'
import { initSound } from '../../ui/sound'
import { initThemePicker } from '../../ui/theme-picker'
import { createApi } from '../core/api'
import { maskPausedLine } from '../core/helplines'
import { draftOf, leaveGuard, pendingOf, sessionOf, type Action, type Model } from '../core/state'
import type { ConsentKind } from '../core/types'
import { createAnnouncer } from './announcer'
import { conversationText, copyText, entryMarkdown, thesesText } from './clipboard'
import { COPIED, COPY_FAILED_LABEL, copyFailed } from './copy'
import { createEffects } from './effects'
import { initKeyboard } from './keyboard'
import { createLeaveGuard } from './leave-guard'
import { applyPresence } from './presence'
import { createView, type View } from './render'
import { createStore } from './store'

// The theme and the sky preset are on <html> before the first frame (public/theme-init.js); these
// wire their controls and keep the page in step with a new choice.
const sky = initSky(document.querySelector<HTMLElement>('[data-sky-pick]'))
const theme = initThemePicker({
  root: document.querySelector<HTMLElement>('[data-theme-pick]'),
  radios: document.querySelector<HTMLElement>('[data-theme-radios]'),
})
initMotionToggle(document.querySelector<HTMLButtonElement>('[data-motion-toggle]'))
// The page sets the chord and the silence itself (presence.ts): no chapters to follow here.
const sound = initSound({ follow: 'manual' })
initKeyboard()

const canvas = document.querySelector<HTMLCanvasElement>('[data-gl-canvas]')
const slot = document.querySelector<HTMLElement>('[data-presence-slot]')
const presenceRoot = document.querySelector<HTMLElement>('.presence')
// The light is its own lazy chunk (with three.js): the low tier at DPR 1, sized to its slot.
const gl =
  canvas && slot && presenceRoot
    ? bootGL<PresenceHandle>(canvas, {
        load: () => import('../../gl/presence'),
        tier: 'low',
        dprCap: 1,
        sizeTo: slot,
        onReady: (handle) => applyPresence(handle, presenceRoot),
      })
    : null

// Called through an arrow: a detached window.fetch throws "Illegal invocation".
const api = createApi({ fetch: (input, init) => window.fetch(input, init) })
const announcer = createAnnouncer(document.querySelector<HTMLElement>('[data-announcer]'))
// Page life (§5.6): pagehide aborts everything in flight ('pagehide'); the bfcache asks GET /me.
// After «Піти» / «Увійти знову» (and out of the crisis) the conversation is wiped right here,
// synchronously, before the browser keeps the page for «Назад».
const leave = createLeaveGuard({
  onPageHide() {
    effects.pageHide()
    view.chat.transcript.dropStreamNow()
    announcer.clear()
    dispatch({ type: 'page/left' })
  },
  onPageShow(persisted) {
    effects.pageShow()
    if (persisted) dispatch({ type: 'page/show', persisted: true })
  },
})

let view: View
const store = createStore(() => ({ render: view.render, run: effects.run, guard: leave.set }))
const dispatch = (action: Action): void => store.dispatch(action)
const effects = createEffects({
  api,
  dispatch,
  model: store.model,
  announcer,
  leave,
  composer: (text) => view.chat.composer.put(text),
  clearComposer: () => view.chat.composer.clear(),
})
view = createView(dispatch, { gl, sound, sky, theme })

// ── One delegated handler for every [data-act] on the page and in the dialogs ──

function topOverlay(model: Model) {
  return model.overlay[model.overlay.length - 1]
}

/** The page's IANA zone for the weekly review (the core has no time zone database), if Intl has one. */
function timeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof zone === 'string' && zone !== '' && zone.length <= 64 ? zone : null
  } catch {
    return null
  }
}

/** «Скопіювати текст розмови» / «Скопіювати тези» on whichever screen still holds them (§3.8), and
 *  «Копіювати» under one reply of the AI: its text from the model, the paused number masked — never
 *  read back from the page. The result is said through the live region too: a changed name of the
 *  focused button is not announced by most screen readers (WCAG 4.1.3). */
async function copy(button: HTMLElement, kind: 'talk' | 'theses' | 'reply' | 'entry'): Promise<void> {
  const { state } = store.model()
  let text = ''
  if (kind === 'entry') {
    // One diary record as Markdown, from the model (masked), never read back from the page.
    const item = state.s === 'journal' ? state.list?.items.find((x) => x.id === button.dataset.id) : undefined
    if (item) text = entryMarkdown(item)
  } else if (kind === 'theses') {
    const draft = draftOf(state)
    if (draft) text = thesesText(draft)
  } else if (kind === 'reply') {
    const message = sessionOf(state)?.messages[Number(button.dataset.i)]
    if (message?.role === 'assistant') text = maskPausedLine(message.content)
  } else {
    const session = sessionOf(state)
    const pending = pendingOf(state)
    if (session !== null || pending !== null) text = conversationText(session?.messages ?? [], pending)
  }
  if (text === '') return
  const ok = await copyText(text)
  const shown = ok ? COPIED : COPY_FAILED_LABEL
  // The words of the button (its label, beside an icon), kept across quick repeated presses (a
  // failure, then a success).
  const words = button.querySelector<HTMLElement>('.said__copy-label') ?? button
  const label = button.dataset.label ?? words.textContent ?? ''
  button.dataset.label = label
  words.textContent = shown
  announcer.say(ok ? COPIED : copyFailed(kind))
  window.setTimeout(() => {
    if (words.textContent !== shown) return
    words.textContent = label
    delete button.dataset.label
  }, 2000)
}

function act(name: string, target: HTMLElement, event: Event): void {
  const model = store.model()
  const { state } = model
  if (target.getAttribute('aria-disabled') === 'true' && name !== 'send') return
  // The account operation (or the save) is on its way: a second press sends nothing.
  if (target.getAttribute('aria-busy') === 'true') return
  if (view.review.act(name, target)) return
  if (view.journal.act(name, target)) return
  if (view.tools.act(name, target)) return
  switch (name) {
    case 'leave-home':
      // Something would be lost: ask first (spec §3.12); otherwise the link just works.
      if (leaveGuard(state)) {
        event.preventDefault()
        dispatch({ type: 'confirm/open', kind: 'leave', leaveTo: 'home' })
      }
      return
    case 'help':
      return dispatch({ type: 'overlay/open', overlay: 'help' })
    case 'account':
      return dispatch({ type: 'overlay/open', overlay: 'account' })
    case 'close':
      return dispatch({ type: 'overlay/close' })
    case 'accept':
      return dispatch({ type: 'confirm/accept' })
    case 'accept-summarize':
      return dispatch({ type: 'confirm/accept', choice: 'summarize' })
    case 'switch-end-no-theses':
      return dispatch({ type: 'confirm/switch', kind: 'end-no-theses' })
    case 'back': {
      const top = topOverlay(model)
      if (top?.o === 'confirm' && top.kind === 'end-no-theses' && top.back) return dispatch({ type: 'confirm/switch', kind: 'end' })
      return dispatch({ type: 'overlay/close' })
    }
    case 'retry-boot':
      return dispatch({ type: 'boot', search: '' })
    case 'consent-agree':
      return dispatch({ type: 'consent/agree', checked: view.consent.checked() as ConsentKind[] })
    case 'consent-reload':
      return dispatch({ type: 'consent/reload' })
    case 'consent-later':
      return view.consent.toggleLater()
    case 'logout':
      return dispatch({ type: 'account/logout' })
    case 'delete-account':
      return dispatch({ type: 'confirm/open', kind: 'delete-account' })
    case 'revoke': {
      const kind = target.dataset.kind as ConsentKind | undefined
      if (kind) dispatch({ type: 'confirm/open', kind: 'revoke', revoke: kind })
      return
    }
    case 'no-save':
      if (state.s === 'chat') dispatch({ type: 'chat/no-save', on: !state.session.noSave })
      return
    case 'resend':
      return dispatch({ type: 'chat/resend' })
    case 'edit':
      return dispatch({ type: 'chat/edit' })
    case 'stop':
      return dispatch({ type: 'chat/stop' })
    case 'end':
      return dispatch({ type: 'confirm/open', kind: 'end' })
    case 'end-no-theses':
      return dispatch({ type: 'confirm/open', kind: 'end-no-theses' })
    case 'summarize':
      return dispatch({ type: 'chat/summarize' })
    case 'start-free':
      if (state.s === 'chat' && state.notice?.kind === 'revisit-gone') return dispatch({ type: 'chat/start-free' })
      return dispatch({ type: 'chat/scenario', id: 'free' })
    case 'revisit-open':
      return dispatch({ type: 'revisit/open' })
    case 'revisit-more':
      return dispatch({ type: 'revisit/more' })
    case 'revisit-confirm': {
      const top = topOverlay(model)
      if (top?.o === 'revisit-pick' && top.selected.length === 0) return view.dialogs.pickTried()
      return dispatch({ type: 'revisit/confirm' })
    }
    case 'scenarios-retry':
      return dispatch({ type: 'scenarios/retry' })
    case 'diary-retry':
      return dispatch({ type: 'diary/retry' })
    case 'jump-end':
      return view.chat.jumpToEnd()
    case 'summarize-cancel':
      return dispatch({ type: 'summarize/cancel' })
    case 'summarize-retry':
      return dispatch({ type: 'summarize/retry', now: Date.now() })
    case 'review-save':
      return dispatch({ type: 'review/save' })
    case 'review-done':
      return dispatch({ type: 'review/done' })
    case 'review-discard':
      return dispatch({ type: 'confirm/open', kind: 'discard' })
    case 'review-regenerate':
      return dispatch({ type: 'confirm/open', kind: 'regenerate' })
    case 'review-back':
      return dispatch({ type: 'review/back' })
    case 'new-chat':
      return dispatch({ type: 'chat/new' })
    case 'new-after-crisis':
      return dispatch({ type: 'confirm/open', kind: 'new-after-crisis' })
    case 'relogin':
      return dispatch({ type: 'confirm/open', kind: 'relogin' })
    case 'reload':
      // A repeated csrf_failed (§4.3): through «Піти з розмови?» when something would be lost.
      if (leaveGuard(state)) return dispatch({ type: 'confirm/open', kind: 'leave', leaveTo: 'reload' })
      window.location.reload()
      return
    case 'revisit-retry': {
      const top = topOverlay(model)
      if (top?.o === 'revisit-pick') dispatch({ type: 'revisit/search', q: top.q })
      return
    }
    case 'copy':
      void copy(target, 'talk')
      return
    case 'copy-theses':
      void copy(target, 'theses')
      return
    case 'copy-reply':
      void copy(target, 'reply')
      return
    case 'starter':
      return view.chat.start(Number(target.dataset.i))
    // The diary (§7.7).
    case 'journal-open':
      return dispatch({ type: 'journal/open', tz: timeZone() })
    case 'journal-back':
      return dispatch({ type: 'journal/back' })
    case 'journal-more':
      return dispatch({ type: 'journal/more' })
    case 'journal-retry':
      return dispatch({ type: 'journal/retry' })
    case 'week-prev':
      return dispatch({ type: 'journal/week', step: -1 })
    case 'week-next':
      return dispatch({ type: 'journal/week', step: 1 })
    case 'week-retry':
      return dispatch({ type: 'journal/week-retry' })
    case 'entry-copy':
      void copy(target, 'entry')
      return
  }
}

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-act]') : null
  if (target === null || target instanceof HTMLInputElement) return
  view.dialogs.noteOpener(target)
  act(target.dataset.act ?? '', target, event)
})

document.addEventListener('change', (event) => {
  const input = event.target
  if (!(input instanceof HTMLInputElement)) return
  if (input.dataset.act === 'scenario' && input.checked) dispatch({ type: 'chat/scenario', id: input.value })
  if (input.dataset.act === 'revisit-toggle' && input.dataset.id) dispatch({ type: 'revisit/toggle', id: input.dataset.id })
})

store.start()
dispatch({ type: 'boot', search: window.location.search })
