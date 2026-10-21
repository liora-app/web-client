// The quiet screens: sign-in, unverified email, session expired, saved, ended, account
// deleted, no connection (spec §3.3, §3.4, §3.8, §3.9, §7.5, §7.6, §8.5). Their copy is static in
// chat/index.html; here only what comes from the state or the API is filled in.

import { maskPausedLineInline } from '../../core/helplines'
import type { Model, State } from '../../core/state'
import { hasUserMessage } from '../../core/state'
import { accountOpError, longDateTime, requestIdLine, signInBanner, stillSignedIn } from '../copy'
import { byEl, screenOf, setAttr, setText, show } from '../dom'
import { renderStatic } from '../transcript'

type On<S extends State['s']> = Extract<State, { s: S }>

export type Screen = Readonly<{
  render(model: Model, entered: boolean): void
  /** What to focus on entering the screen instead of its h1 (a banner). */
  focusTarget?(model: Model): HTMLElement | null
  /** The page moves to another screen (`next`): before that one renders, this one lets go of
   *  whatever text of the conversation it holds, so a hidden section keeps none of it. */
  leave?(next: Model): void
}>

// ── signed-out ──

export function signInScreen(): Screen {
  const root = screenOf('signed-out')
  const banner = byEl('signin-banner', root)
  const label = byEl('signin-banner-label', root)
  const text = byEl('signin-banner-text', root)
  return {
    render(model) {
      const state = model.state as On<'signed-out'>
      if (state.notice === null) {
        show(banner, false)
        return
      }
      const copy = signInBanner(state.notice)
      setText(label, copy.label ?? '')
      show(label, copy.label !== null)
      setText(text, copy.text)
      show(banner, true)
    },
    focusTarget: (model) => ((model.state as On<'signed-out'>).notice !== null ? banner : null),
  }
}

/** «Новий вхід не відбувся…» over the first screen after boot (§3.3). Without a notice the banner
 *  keeps no text either: it names the account's email. */
export function authBanner(model: Model, banner: HTMLElement, text: HTMLElement): boolean {
  const notice = model.ctx.authNotice
  if (notice === null) {
    clearBanner(banner, text)
    return false
  }
  setText(text, stillSignedIn(notice.code, notice.email))
  show(banner, true)
  return true
}

/** A screen with the banner is left: the email goes with it (render() writes it again on return). */
export function clearBanner(banner: HTMLElement, text: HTMLElement): void {
  setText(text, '')
  show(banner, false)
}

// ── not-invited ──

export function notInvitedScreen(): Screen {
  const root = screenOf('not-invited')
  const guest = byEl('ni-guest', root)
  const member = byEl('ni-member', root)
  const kept = byEl('ni-kept', root)
  const talk = byEl<HTMLOListElement>('ni-talk', root)
  const copy = byEl('ni-copy', root)
  const email = byEl('ni-email', root)
  return {
    render(model, entered) {
      const state = model.state as On<'not-invited'>
      show(guest, !state.hasSession)
      show(member, state.hasSession)
      setText(email, model.ctx.me?.email ?? '')
      const hasTalk = hasUserMessage(state.stale, state.pending)
      show(kept, hasTalk || state.draft !== null)
      setText(copy, state.draft !== null ? 'Скопіювати тези' : 'Скопіювати текст розмови')
      copy.dataset.act = state.draft !== null ? 'copy-theses' : 'copy'
      if (entered) {
        renderStatic(talk, state.stale?.messages ?? [], state.pending)
        byEl<HTMLDetailsElement>('ni-details', root).open = false
      }
      // «-> Вийти» failed (the account sheet shows its own error when it is open).
      const op = model.ctx.op
      const opText = op !== null && op.error !== null && op.name === 'logout' && model.overlay.length === 0 ? accountOpError(op.name, op.error).why : ''
      setText(byEl('ni-op-error', root), opText)
    },
    // Signed out, the account deleted…: neither the conversation nor the email stays in the
    // hidden section.
    leave() {
      talk.replaceChildren()
      setText(email, '')
    },
  }
}

// ── session-expired ──

export function expiredScreen(): Screen {
  const root = screenOf('session-expired')
  const talk = byEl<HTMLOListElement>('expired-talk', root)
  const copy = byEl('expired-copy', root)
  return {
    render(model, entered) {
      const state = model.state as On<'session-expired'>
      setText(copy, state.draft !== null ? 'Скопіювати тези' : 'Скопіювати текст розмови')
      copy.dataset.act = state.draft !== null ? 'copy-theses' : 'copy'
      if (entered) renderStatic(talk, state.stale.messages, state.pending)
    },
    leave: () => talk.replaceChildren(),
  }
}

// ── saved ──

export function savedScreen(): Screen {
  const root = screenOf('saved')
  return {
    // Signed out or the account deleted from here: the record leaves the hidden section too.
    leave() {
      setText(byEl('saved-date', root), '')
      setText(byEl('saved-title', root), '')
      byEl('saved-bullets', root).replaceChildren()
      setText(byEl('saved-tags', root), '')
      setText(byEl('saved-keep-text', root), '')
    },
    render(model, entered) {
      if (!entered) return
      const { summary } = model.state as On<'saved'>
      setText(byEl('saved-date', root), longDateTime(summary.created_at))
      // The record as saved; the AI drafted it, so the paused number is masked here too.
      setText(byEl('saved-title', root), maskPausedLineInline(summary.title))
      const list = byEl('saved-bullets', root)
      list.replaceChildren()
      summary.bullets.forEach((bullet, i) => {
        const li = document.createElement('li')
        const index = document.createElement('span')
        index.className = 'record__index'
        index.setAttribute('aria-hidden', 'true')
        index.textContent = String(i + 1).padStart(2, '0')
        const text = document.createElement('p')
        text.textContent = maskPausedLineInline(bullet)
        li.append(index, text)
        list.append(li)
      })
      const tags = byEl('saved-tags', root)
      setText(tags, summary.tags.map((t) => `#${maskPausedLineInline(t.name)}`).join(' '))
      show(tags, summary.tags.length > 0)
      // «Взяти з собою» (§7.5): only a thesis the person marked themselves; nothing otherwise.
      const { keep } = model.state as On<'saved'>
      setText(byEl('saved-keep-text', root), keep === undefined ? '' : maskPausedLineInline(keep))
      show(byEl('saved-keep', root), keep !== undefined)
    },
  }
}

// ── ended ──

/** «У щоденник нічого не потрапило» only when that is known: after an unconfirmed save the
 *  record may be there (§7.3, §7.6). */
export function endedScreen(): Screen {
  const root = screenOf('ended')
  const none = byEl('ended-none', root)
  const maybe = byEl('ended-maybe', root)
  return {
    render(model) {
      const maybeSaved = model.ctx.maybeSaved
      show(none, !maybeSaved)
      show(maybe, maybeSaved)
      setAttr(root, 'aria-labelledby', maybeSaved ? 'ended-maybe-title' : 'ended-title')
    },
  }
}

// ── account-deleted ──

export function deletedScreen(): Screen {
  const root = screenOf('account-deleted')
  return {
    render(model) {
      const { variant } = model.state as On<'account-deleted'>
      show(byEl('deleted-confirmed', root), variant === 'confirmed')
      show(byEl('deleted-presumed', root), variant === 'presumed')
      show(byEl('deleted-again', root), variant === 'confirmed')
    },
  }
}

// ── fatal ──

export function fatalScreen(): Screen {
  const root = screenOf('fatal')
  const connection = (): void => {
    const offline = navigator.onLine === false
    show(byEl('fatal-online', root), !offline)
    show(byEl('fatal-offline', root), offline)
  }
  // «Схоже, немає інтернету» follows the connection while the screen is up (§3.9).
  window.addEventListener('online', connection)
  window.addEventListener('offline', connection)
  return {
    render(model) {
      const { error } = model.state as On<'fatal'>
      connection()
      const id = requestIdLine(error.requestId)
      const line = byEl('fatal-request-id', root)
      setText(line, id ?? '')
      show(line, id !== null)
    },
  }
}

export const staticScreen: Screen = { render() {} }
