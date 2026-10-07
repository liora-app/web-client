// The consent screen (spec §3.5): three separate boxes, the provider and its country from
// GET /consents, the button always active. No <form>: a native submit would send `Origin: null`
// under the site's Referrer-Policy and the server would answer 403 csrf_failed.
//
// Modes: `first` after boot (or after a revoke), `update` after a 409 policy_outdated, `resume`
// after a 403 consent_required on a turn, the theses or a save. `update` and `resume` take the
// boxes, the version and the POST body only from a fresh GET /consents (the core asks for it);
// while it is on its way the boxes wait, disabled.

import { countryName } from '../../core/country'
import type { Model, State } from '../../core/state'
import { hasUserMessage } from '../../core/state'
import { CONSENT_KINDS, type ConsentKind, type ConsentState } from '../../core/types'
import { CONSENT_UNCHECKED, accountOpError, consentError, policyVersion, shortDate } from '../copy'
import { allEl, byEl, screenOf, setAttr, setText, show } from '../dom'
import { authBanner, type Screen } from './text'

type ConsentScreen = Extract<State, { s: 'consent' }>

const regionNames = ((): Intl.DisplayNames | null => {
  try {
    return new Intl.DisplayNames(['uk'], { type: 'region' })
  } catch {
    return null
  }
})()

/** «Ollama Cloud (Ollama Inc.)» and «США» wherever the page names the provider. */
export function fillProvider(model: Model, root: ParentNode = document): void {
  const provider = model.ctx.consents?.llm_provider ?? null
  for (const node of allEl('provider', root)) setText(node, provider?.name ?? '')
  for (const node of allEl('country', root)) setText(node, provider === null ? '' : countryName(provider.country, regionNames))
}

export function consentScreen(): Screen & { checked(): ConsentKind[]; toggleLater(): void } {
  const root = screenOf('consent')
  const boxes = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-kind]'))
  const checks = byEl('consent-checks', root)
  const alert = byEl('consent-alert', root)
  const error = byEl('consent-error', root)
  const changed = byEl('consent-changed', root)
  const later = byEl('consent-later', root)
  const laterToggle = root.querySelector<HTMLButtonElement>('[data-act="consent-later"]')!
  let epoch = -1
  let lastError: ConsentScreen['error'] = null
  let lastConsents: ConsentState | null = null
  let prev: ConsentScreen | null = null

  const resetBoxes = (model: Model): void => {
    const consents = model.ctx.consents
    lastConsents = consents
    for (const box of boxes) {
      const kind = box.dataset.kind as ConsentKind
      const granted = consents?.granted.find((g) => g.kind === kind && g.policy_version === consents.current_policy_version)
      // Already given for these terms: the box stays checked, with the date next to it.
      box.checked = consents !== null && !consents.missing.includes(kind)
      const note = root.querySelector<HTMLElement>(`[data-granted="${kind}"]`)!
      setText(note, granted ? ` (ви вже погодилися ${shortDate(granted.granted_at)})` : '')
      show(note, granted !== undefined && box.checked)
    }
  }

  return {
    checked: () => boxes.filter((b) => b.checked).map((b) => b.dataset.kind as ConsentKind).filter((k) => CONSENT_KINDS.includes(k)),
    toggleLater() {
      const open = later.hidden !== false
      show(later, open)
      laterToggle.setAttribute('aria-expanded', String(open))
    },
    render(model, entered) {
      const state = model.state as ConsentScreen
      const consents = model.ctx.consents
      if (entered) {
        show(later, false)
        laterToggle.setAttribute('aria-expanded', 'false')
        lastError = null
        prev = null
      }
      authBanner(model, byEl('consent-auth', root), byEl('consent-auth-text', root))
      show(changed, state.policyChanged || state.mode === 'update')
      show(byEl('consent-resume', root), state.mode === 'resume')
      fillProvider(model, root)

      const noProvider = !state.loading && state.fresh && (consents === null || consents.llm_provider === null)
      show(byEl('consent-no-provider', root), noProvider || state.error?.code === 'provider_missing')
      show(checks, !noProvider)
      show(byEl('consent-agree', root), !noProvider)
      show(byEl('consent-reload', root), noProvider || state.error?.code === 'consents_load_failed')
      setText(byEl('consent-agree', root), state.mode === 'resume' ? 'Погоджуюся — продовжити' : 'Погоджуюся — почати')
      setAttr(byEl('consent-agree', root), 'aria-busy', state.submitting || state.loading ? 'true' : null)

      // Fresh data (or new terms after a 409, or a consent revoked meanwhile): the boxes start over.
      if (state.fresh && (state.epoch !== epoch || consents !== lastConsents)) {
        epoch = state.epoch
        resetBoxes(model)
      } else if (entered) {
        resetBoxes(model)
      }
      // The fresh GET is on its way: nothing to check against yet.
      for (const box of boxes) box.disabled = state.loading
      setAttr(checks, 'aria-busy', state.loading ? 'true' : null)

      const versionText = consents === null ? '' : policyVersion(consents.current_policy_version)
      setText(byEl('consent-version', root), versionText)

      const e = state.error
      setText(alert, e?.code === 'unchecked' ? CONSENT_UNCHECKED : '')
      const text = e === null ? null : consentError(e, model.ctx.csrfFailures)
      setText(error, text?.why ?? '')
      // A repeated csrf_failed: reload the page — the conversation can be copied first (§4.3).
      const talk = hasUserMessage(state.session, state.pending)
      show(byEl('consent-reload-row', root), text?.reload === true)
      show(byEl('consent-copy', root), text?.reload === true && talk)
      // The first box that is still empty gets the focus with the alert, once.
      if (e !== lastError && e?.code === 'unchecked') boxes.find((b) => !b.checked)?.focus()
      lastError = e

      // 409 policy_outdated: boxes cleared, the banner «Умови щойно оновилися…» takes the focus (§3.5).
      if (!entered && prev !== null && prev.submitting && !state.submitting && state.policyChanged && state.loading) changed.focus()
      prev = state

      const op = model.ctx.op
      const opText = op !== null && op.error !== null && op.name === 'logout' && model.overlay.length === 0 ? accountOpError(op.name, op.error).why : ''
      setText(byEl('consent-op-error', root), opText)
    },
    focusTarget(model) {
      const state = model.state as ConsentScreen
      if (model.ctx.authNotice !== null) return byEl('consent-auth', root)
      if (state.policyChanged || state.mode === 'update') return changed
      if (state.mode === 'resume') return byEl('consent-resume', root)
      return null
    },
  }
}
