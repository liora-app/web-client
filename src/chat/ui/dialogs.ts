// Native <dialog>s opened with showModal(), kept in line with model.overlay (spec §2.5, §3.1
// «Діалоги»). The browser gives the focus trap, Esc and the inert page; focus coming back is ours:
// to the button that opened the dialog, else into the dialog still open under it, else «Акаунт»,
// else the screen's h1 (I6). A new screen closes every dialog without that return: focus goes to
// the new screen's h1 instead (render.ts).
//
// The stack is at most two deep, and only as account → confirm(logout | delete-account | revoke):
// closing the confirm leaves the account sheet open with the focus on the button that opened it.
//
// The page's live region moves into the dialog on top: showModal() makes the rest of the document
// inert, and an inert region is not read — an answer that arrives under «Якщо важко» would go
// unheard (§3.11, §5.7, WCAG 4.1.3). With no dialog open it is back in its place.

import type { Action, Model, Overlay, PickOverlay } from '../core/state'
import { hasReply, hasUserMessage, leaveGuard, pendingOf, sessionOf } from '../core/state'
import { maskPausedLine, type SafeLine } from '../core/helplines'
import { accountOpError, dayMonth, requestIdLine, shortDate } from './copy'
import { allEl, byEl, fromTemplate, headingOf, setAttr, setText, show } from './dom'

type Kind = Overlay['o']

type Open = { kind: Kind; el: HTMLDialogElement; opener: HTMLElement | null; confirm: string | null }

export type Dialogs = Readonly<{
  sync(model: Model, screenChanged: boolean): void
  helpOpen(): boolean
  /** «Продовжити» was pressed with nothing chosen: the picker shows its alert (spec §3.6). */
  pickTried(): void
  /** The control the person just pressed: the opener of a dialog it opens. Safari does not focus
   *  a clicked button, so document.activeElement alone would lose it. */
  noteOpener(el: HTMLElement): void
  /** The focus inside the dialog on top went away with its control: its first stop again (I6).
   *  False when no dialog is open. */
  focusTop(): boolean
}>

/** Debounce of the search in the record picker (§3.6). */
const SEARCH_DEBOUNCE_MS = 300

/** The confirms of an account operation (core/state.ts: one at a time). */
const ACCOUNT_CONFIRMS: ReadonlySet<string> = new Set(['logout', 'delete-account', 'revoke'])

export function fillLines(list: HTMLElement, block: HTMLElement, lines: readonly SafeLine[]): void {
  list.replaceChildren()
  for (const line of lines) {
    const li = fromTemplate<HTMLLIElement>('line')
    setText(li.querySelector('.line__name')!, line.name)
    const phone = li.querySelector<HTMLAnchorElement>('.line__phone')!
    phone.href = line.tel
    setText(phone, line.phone)
    const hours = [line.hours, line.free ? 'безкоштовно' : null].filter((x): x is string => x !== null).join(' · ')
    const hoursEl = li.querySelector<HTMLElement>('.line__hours')!
    setText(hoursEl, hours)
    show(hoursEl, hours !== '')
    list.append(li)
  }
  show(block, lines.length > 0)
}

/** The person wrote something that is still on the page (help: «Ваша розмова… нікуди не зникла»). */
function hasTalk(model: Model): boolean {
  return hasUserMessage(sessionOf(model.state), pendingOf(model.state))
}

export function createDialogs(dispatch: (action: Action) => void): Dialogs {
  const elements: Record<Kind, HTMLDialogElement> = {
    account: document.querySelector<HTMLDialogElement>('[data-dialog="account"]')!,
    help: document.querySelector<HTMLDialogElement>('[data-dialog="help"]')!,
    'revisit-pick': document.querySelector<HTMLDialogElement>('[data-dialog="revisit-pick"]')!,
    confirm: document.querySelector<HTMLDialogElement>('[data-dialog="confirm"]')!,
  }
  const confirmBody = byEl('confirm-body')
  const pickRoot = elements['revisit-pick']
  const search = byEl<HTMLInputElement>('pick-q', pickRoot)
  const region = document.querySelector<HTMLElement>('[data-announcer]')
  const home = document.createComment('announcer')
  region?.before(home)
  let stack: Open[] = []
  let pickTried = false
  let last: Model | null = null
  let noted: HTMLElement | null = null
  let searchTimer = 0

  // Esc: the state decides (the confirm of a crisis restart treats it as «Скасувати» too).
  for (const el of Object.values(elements)) {
    el.addEventListener('cancel', (event) => {
      event.preventDefault()
      dispatch({ type: 'overlay/close' })
    })
    // A click on the backdrop of a sheet closes it, like the landing's menu.
    if (el.classList.contains('sheet')) {
      el.addEventListener('click', (event) => {
        if (event.target !== el) return
        const box = el.getBoundingClientRect()
        const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom
        if (!inside) dispatch({ type: 'overlay/close' })
      })
    }
  }

  // The picker's search: GET /summaries?q= 300 ms after the last keystroke (§3.6).
  search.addEventListener('input', () => {
    window.clearTimeout(searchTimer)
    searchTimer = window.setTimeout(() => dispatch({ type: 'revisit/search', q: search.value }), SEARCH_DEBOUNCE_MS)
  })
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return
    event.preventDefault()
    window.clearTimeout(searchTimer)
    dispatch({ type: 'revisit/search', q: search.value })
  })

  const confirmKey = (o: Overlay): string | null =>
    o.o !== 'confirm' ? null : o.kind === 'revoke' ? `revoke-${o.revoke ?? ''}` : o.kind

  function fillConfirm(key: string): void {
    const tpl = document.querySelector<HTMLTemplateElement>(`template[data-confirm="${key}"]`)
    confirmBody.replaceChildren()
    if (tpl) confirmBody.append(tpl.content.cloneNode(true))
  }

  function refreshConfirm(m: Model): void {
    const { state, ctx } = m
    const session = sessionOf(state)
    const userMessages = session?.messages.filter((x) => x.role === 'user').length ?? 0
    const conditions: Record<string, boolean> = {
      short: userMessages < 2,
      nosave: session?.noSave === true,
      // «Поточна розмова теж зникне» / «…закриється»: there is something to lose (I7).
      talk: leaveGuard(state),
      // «Хочете залишити тези — спершу підсумуйте» only where «Підсумувати» is offered beside it;
      // on the theses the way to keep them is the save (§3.12). Neither in «не зберігати».
      'can-summarize': state.s === 'chat' && hasReply(state.session) && !state.session.noSave,
      'review-save': state.s === 'review' && !state.session.noSave,
      // An unconfirmed save may have reached the diary: no «Liora їх не зберігала» (§7.3).
      'maybe-saved': ctx.maybeSaved,
      'not-maybe-saved': !ctx.maybeSaved,
    }
    for (const node of Array.from(confirmBody.querySelectorAll<HTMLElement>('[data-if]'))) {
      show(node, conditions[node.dataset.if ?? ''] === true)
    }
    const provider = ctx.consents?.llm_provider?.name ?? ''
    for (const node of allEl('provider', confirmBody)) setText(node, provider)
    const op = ctx.op
    const text = op !== null && op.error !== null ? accountOpError(op.name, op.error) : null
    const opError = confirmBody.querySelector<HTMLElement>('[data-op-error]')
    if (opError) setText(opError, text?.why ?? '')
    const opId = confirmBody.querySelector<HTMLElement>('[data-op-id]')
    if (opId) {
      const id = text?.showId === true && op?.error ? requestIdLine(op.error.requestId) : null
      setText(opId, id ?? '')
      show(opId, id !== null)
    }
    // While an account operation runs, every account confirm (logout, delete-account, revoke) is
    // busy: the core takes one operation at a time and ignores the press. A revoke stuck elsewhere
    // must not silence «Увійти» or «Завершити», which are not account operations.
    const top = m.overlay[m.overlay.length - 1]
    const busy = ctx.op?.busy === true && top?.o === 'confirm' && ACCOUNT_CONFIRMS.has(top.kind)
    for (const button of Array.from(confirmBody.querySelectorAll<HTMLButtonElement>('[data-act="accept"]'))) {
      setAttr(button, 'aria-busy', busy ? 'true' : null)
    }
  }

  function refreshAccount(m: Model): void {
    const { ctx } = m
    const root = elements.account
    setText(byEl('account-email', root), ctx.me?.email ?? '')
    const provider = ctx.consents?.llm_provider?.name ?? ''
    for (const node of allEl('provider', root)) setText(node, provider)
    for (const node of Array.from(root.querySelectorAll<HTMLElement>('[data-grant-date]'))) {
      const granted = ctx.consents?.granted.find((g) => g.kind === node.dataset.grantDate)
      setText(node, granted ? `надано ${shortDate(granted.granted_at)}` : 'не надано')
      // «Відкликати» only for what was given.
      const button = node.closest('.grants__item')?.querySelector<HTMLElement>('button')
      if (button) show(button.closest<HTMLElement>('.arrows') ?? button, granted !== undefined)
    }
    const op = ctx.op
    // «Вийти» without a confirm (nothing to lose) reports here; a stacked confirm reports itself.
    const own = op !== null && op.error !== null && op.name === 'logout' && m.overlay.length === 1
    setText(byEl('account-op-error', root), own && op?.error ? accountOpError(op.name, op.error).why : '')
    // «Вийти» waits for any account operation still running, not only its own.
    const logout = root.querySelector<HTMLElement>('[data-act="logout"]')
    if (logout) setAttr(logout, 'aria-busy', op?.busy === true ? 'true' : null)
  }

  /** No session any more (signed out, the account deleted, wiped): the closed sheet keeps neither
   *  the email nor the dates of the consents. */
  function clearAccount(): void {
    const root = elements.account
    setText(byEl('account-email', root), '')
    for (const node of Array.from(root.querySelectorAll<HTMLElement>('[data-grant-date]'))) setText(node, '')
  }

  /** The picker closed: its records (titles, tags, first theses) and the query leave the page with
   *  it — after a revoke of data_processing the server has erased them. It is filled again on
   *  the next open. */
  function clearPick(): void {
    window.clearTimeout(searchTimer)
    byEl('pick-list', pickRoot).replaceChildren()
    setText(byEl('pick-status', pickRoot), '')
    search.value = ''
  }

  function refreshHelp(m: Model): void {
    const helplines = m.ctx.helplines
    const root = elements.help
    fillLines(byEl('help-lines', root), byEl('help-lines-block', root), helplines.status === 'ok' ? helplines.value.lines : [])
    show(byEl('help-kept', root), hasTalk(m))
  }

  function refreshPick(m: Model): void {
    const top = m.overlay.find((o): o is PickOverlay => o.o === 'revisit-pick')
    if (top === undefined) return
    const root = pickRoot
    show(byEl('pick-gone', root), top.gone)
    // The search is there only when the diary has more than one page (or a search is running).
    const diary = m.ctx.diary
    const paged = diary.status === 'ok' && diary.value.nextCursor !== null
    show(byEl('pick-search', root), paged || top.q !== '')
    const items = top.list?.items ?? []
    const nothing = !top.loading && !top.failed && top.list !== null && items.length === 0 && top.q !== ''
    setText(
      byEl('pick-status', root),
      top.loading
        ? 'Завантажуємо записи…'
        : top.failed
          ? 'Не вдалося завантажити збережені тези.'
          : nothing
            ? `За запитом «${top.q}» нічого не знайшлося.`
            : '',
    )
    show(byEl('pick-retry', root), top.failed && !top.loading)
    const list = byEl('pick-list', root)
    const known = Array.from(list.querySelectorAll<HTMLElement>('[data-id]')).map((n) => n.dataset.id)
    if (known.length !== items.length || items.some((item, i) => known[i] !== item.id)) {
      list.replaceChildren()
      for (const item of items) {
        const li = fromTemplate<HTMLLIElement>('pick')
        li.dataset.id = item.id
        const input = li.querySelector<HTMLInputElement>('.pick__input')!
        input.dataset.act = 'revisit-toggle'
        input.dataset.id = item.id
        // Records the AI drafted: the paused number masked, as everywhere the AI's text is shown.
        setText(li.querySelector('.pick__title')!, maskPausedLine(item.title))
        const tags = item.tags.map((t) => `#${maskPausedLine(t.name)}`).join(' ')
        setText(li.querySelector('.pick__meta')!, [dayMonth(item.created_at), tags].filter((x) => x !== '').join(' · '))
        setText(li.querySelector('.pick__first')!, maskPausedLine(item.bullets[0] ?? ''))
        list.append(li)
      }
    }
    const full = top.selected.length >= 5
    for (const input of Array.from(list.querySelectorAll<HTMLInputElement>('.pick__input'))) {
      const checked = top.selected.includes(input.dataset.id ?? '')
      input.checked = checked
      input.disabled = full && !checked
    }
    setText(byEl('pick-count', root), `Обрано ${top.selected.length} з 5`)
    show(byEl('pick-max', root), full)
    setText(byEl('pick-confirm', root), `Продовжити (${top.selected.length})`)
    setText(byEl('pick-error', root), pickTried && top.selected.length === 0 ? 'Оберіть хоча б один запис.' : '')
    show(byEl('pick-more', root), top.list?.nextCursor != null)
  }

  function initialFocus(el: HTMLDialogElement): void {
    const target =
      el.querySelector<HTMLElement>('[data-focus]') ??
      el.querySelector<HTMLElement>('.sheet__close') ??
      el.querySelector<HTMLElement>('button, a[href], input, textarea')
    target?.focus()
  }

  /** I6: the opener; else the dialog still open under the closed one; else «Акаунт»; else the h1. */
  function returnFocus(opener: HTMLElement | null): void {
    const usable = (node: HTMLElement): boolean => {
      if (!node.isConnected || node.closest('[hidden]') !== null) return false
      const dialog = node.closest('dialog')
      return dialog === null ? stack.length === 0 : dialog.open && stack[stack.length - 1]?.el === dialog
    }
    if (opener !== null && usable(opener)) {
      opener.focus()
      return
    }
    const below = stack[stack.length - 1]
    if (below !== undefined) {
      initialFocus(below.el)
      return
    }
    const account = document.querySelector<HTMLElement>('[data-act="account"].account-toggle')
    if (account && !account.hidden) {
      account.focus()
      return
    }
    const screen = document.querySelector<HTMLElement>('[data-screen]:not([hidden])')
    if (screen) headingOf(screen)?.focus()
  }

  /** The live region follows the dialog on top (see the head of this file). */
  function placeRegion(): void {
    if (region === null) return
    const top = stack[stack.length - 1]
    if (top !== undefined) {
      if (region.parentElement !== top.el) top.el.append(region)
    } else if (region.previousSibling !== home) {
      home.after(region)
    }
  }

  function openerNow(): HTMLElement | null {
    const active = document.activeElement
    if (active instanceof HTMLElement && active !== document.body) return active
    return noted !== null && noted.isConnected ? noted : null
  }

  return {
    helpOpen: () => stack.some((o) => o.kind === 'help'),
    pickTried() {
      pickTried = true
      if (last !== null) refreshPick(last)
    },
    noteOpener(el) {
      noted = el
    },
    focusTop() {
      const top = stack[stack.length - 1]
      if (top === undefined) return false
      initialFocus(top.el)
      return true
    },
    sync(next, screenChanged) {
      last = next
      const wanted = next.overlay
      // Close from the top whatever no longer matches.
      let keep = 0
      while (keep < stack.length && keep < wanted.length && stack[keep]!.kind === wanted[keep]!.o) keep++
      while (stack.length > keep) {
        const top = stack.pop()!
        if (top.el.open) top.el.close()
        if (top.kind === 'revisit-pick') clearPick()
        if (!screenChanged) returnFocus(top.opener)
      }
      if (wanted.every((o) => o.o !== 'revisit-pick')) pickTried = false
      // Open what is new, in order (account under its confirm).
      for (let i = stack.length; i < wanted.length; i++) {
        const overlay = wanted[i]!
        const el = elements[overlay.o]
        const opener = openerNow()
        const key = confirmKey(overlay)
        if (key !== null) fillConfirm(key)
        if (overlay.o === 'revisit-pick') search.value = overlay.q
        stack.push({ kind: overlay.o, el, opener, confirm: key })
        if (overlay.o === 'confirm') refreshConfirm(next)
        if (overlay.o === 'account') refreshAccount(next)
        if (overlay.o === 'help') refreshHelp(next)
        if (overlay.o === 'revisit-pick') refreshPick(next)
        if (!el.open) el.showModal()
        initialFocus(el)
      }
      noted = null
      // The confirm that switches its content in place (end ↔ end-no-theses).
      for (const [i, open] of stack.entries()) {
        const overlay = wanted[i]!
        if (overlay.o !== 'confirm') continue
        const key = confirmKey(overlay)
        if (key !== open.confirm) {
          fillConfirm(key!)
          open.confirm = key
          refreshConfirm(next)
          const focus =
            key === 'end-no-theses'
              ? confirmBody.querySelector<HTMLElement>('[data-act="back"]')
              : confirmBody.querySelector<HTMLElement>('[data-act="switch-end-no-theses"]')
          focus?.focus()
        } else {
          refreshConfirm(next)
        }
      }
      if (stack.some((o) => o.kind === 'account')) refreshAccount(next)
      if (stack.some((o) => o.kind === 'help')) refreshHelp(next)
      if (stack.some((o) => o.kind === 'revisit-pick')) refreshPick(next)
      if (next.ctx.me === null) clearAccount()
      placeRegion()
    },
  }
}
