// Entry of chat/index.html (spec §9.1): styles, «Пауза» and «Звук», the light in its slot, and the
// state machine of src/chat/core driven through store → render → effects.

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
import { initSound } from '../../ui/sound'
import { createApi } from '../core/api'
import { leaveGuard, type Action, type Model } from '../core/state'
import type { ConsentKind } from '../core/types'
import { createAnnouncer } from './announcer'
import { conversationText, copyText, thesesText } from './clipboard'
import { createEffects } from './effects'
import { createLeaveGuard } from './leave-guard'
import { applyPresence } from './presence'
import { createView, type View } from './render'
import { createStore } from './store'

initMotionToggle(document.querySelector<HTMLButtonElement>('[data-motion-toggle]'))
const sound = initSound({ follow: 'manual' })

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
const leave = createLeaveGuard()

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
})
view = createView(dispatch, gl, sound)

// ── One delegated handler for every [data-act] on the page and in the dialogs ──

function topOverlay(model: Model) {
  return model.overlay[model.overlay.length - 1]
}

async function copy(button: HTMLElement, kind: 'talk' | 'theses'): Promise<void> {
  const { state } = store.model()
  let text = ''
  if (kind === 'theses') {
    const draft = state.s === 'review' ? state.draft : state.s === 'session-expired' || state.s === 'not-invited' ? state.draft : null
    if (draft) text = thesesText(draft)
  } else {
    const session = state.s === 'chat' ? state.session : state.s === 'session-expired' || state.s === 'not-invited' ? state.stale : null
    const pending = state.s === 'chat' || state.s === 'session-expired' || state.s === 'not-invited' ? state.pending : null
    if (session !== null || pending !== null) text = conversationText(session?.messages ?? [], pending)
  }
  if (text === '' || !(await copyText(text))) return
  const label = button.textContent
  button.textContent = 'Скопійовано'
  window.setTimeout(() => {
    if (button.textContent === 'Скопійовано') button.textContent = label
  }, 2000)
}

function act(name: string, target: HTMLElement, event: Event): void {
  const model = store.model()
  const { state } = model
  if (target.getAttribute('aria-disabled') === 'true' && name !== 'send') return
  if (view.review.act(name, target)) return
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
      return dispatch({ type: 'confirm/open', kind: 'leave', leaveTo: 'reload' })
    case 'copy':
      void copy(target, 'talk')
      return
    case 'copy-theses':
      void copy(target, 'theses')
      return
  }
}

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-act]') : null
  if (target === null || target instanceof HTMLInputElement) return
  act(target.dataset.act ?? '', target, event)
})

document.addEventListener('change', (event) => {
  const input = event.target
  if (!(input instanceof HTMLInputElement)) return
  if (input.dataset.act === 'scenario' && input.checked) dispatch({ type: 'chat/scenario', id: input.value })
  if (input.dataset.act === 'revisit-toggle' && input.dataset.id) dispatch({ type: 'revisit/toggle', id: input.dataset.id })
})

// ── Page life (spec §5.6) ──

window.addEventListener('pagehide', () => effects.pageHide())
window.addEventListener('pageshow', (event) => {
  effects.pageShow()
  if (event.persisted) dispatch({ type: 'page/show', persisted: true })
})

store.start()
dispatch({ type: 'boot', search: window.location.search })
