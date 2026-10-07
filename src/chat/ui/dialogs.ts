// Native <dialog>s opened with showModal(), kept in line with model.overlay (spec §2.5, §3.1
// «Діалоги»). The browser gives the focus trap, Esc and the inert page; focus coming back is ours:
// to the button that opened the dialog, else «Акаунт», else the screen's h1 (I6). A new screen
// closes every dialog without that return: focus goes to the new screen's h1 instead.

import type { Action, Model, Overlay } from '../core/state'
import { hasReply, hasUserMessage } from '../core/state'
import { accountOpError, dayMonth, shortDate } from './copy'
import { allEl, byEl, fromTemplate, headingOf, setText, show } from './dom'
import type { SafeLine } from '../core/helplines'

type Kind = Overlay['o']

type Open = { kind: Kind; el: HTMLDialogElement; opener: HTMLElement | null; confirm: string | null }

export type Dialogs = Readonly<{
  sync(model: Model, screenChanged: boolean): void
  helpOpen(): boolean
  /** «Продовжити» was pressed with nothing chosen: the picker shows its alert (spec §3.6). */
  pickTried(): void
}>

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

export function createDialogs(dispatch: (action: Action) => void): Dialogs {
  const elements: Record<Kind, HTMLDialogElement> = {
    account: document.querySelector<HTMLDialogElement>('[data-dialog="account"]')!,
    help: document.querySelector<HTMLDialogElement>('[data-dialog="help"]')!,
    'revisit-pick': document.querySelector<HTMLDialogElement>('[data-dialog="revisit-pick"]')!,
    confirm: document.querySelector<HTMLDialogElement>('[data-dialog="confirm"]')!,
  }
  const confirmBody = byEl('confirm-body')
  let stack: Open[] = []
  let pickTried = false
  let last: Model | null = null

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

  const confirmKey = (o: Overlay): string | null =>
    o.o !== 'confirm' ? null : o.kind === 'revoke' ? `revoke-${o.revoke ?? ''}` : o.kind

  function fillConfirm(key: string): void {
    const tpl = document.querySelector<HTMLTemplateElement>(`template[data-confirm="${key}"]`)
    confirmBody.replaceChildren()
    if (tpl) confirmBody.append(tpl.content.cloneNode(true))
  }

  function refreshConfirm(m: Model): void {
    const { state, ctx } = m
    const session = state.s === 'chat' || state.s === 'summarizing' || state.s === 'review' ? state.session : null
    const pending = state.s === 'chat' ? state.pending : null
    const userMessages = session?.messages.filter((x) => x.role === 'user').length ?? 0
    const conditions: Record<string, boolean> = {
      short: userMessages < 2,
      nosave: session?.noSave === true,
      talk: hasUserMessage(session, pending),
      'can-summarize': state.s === 'chat' && hasReply(state.session) && !state.session.noSave,
    }
    for (const node of Array.from(confirmBody.querySelectorAll<HTMLElement>('[data-if]'))) {
      show(node, conditions[node.dataset.if ?? ''] === true)
    }
    const provider = ctx.consents?.llm_provider?.name ?? ''
    for (const node of allEl('provider', confirmBody)) setText(node, provider)
    const opError = confirmBody.querySelector<HTMLElement>('[data-op-error]')
    if (opError) {
      const op = ctx.op
      setText(opError, op !== null && op.error !== null ? accountOpError(op.name, op.error) : '')
    }
    for (const button of Array.from(confirmBody.querySelectorAll<HTMLButtonElement>('[data-act="accept"]'))) {
      button.setAttribute('aria-busy', String(ctx.op?.busy === true))
    }
  }

  function refreshAccount(m: Model): void {
    const { ctx } = m
    setText(byEl('account-email', elements.account), ctx.me?.email ?? '')
    const provider = ctx.consents?.llm_provider?.name ?? ''
    for (const node of allEl('provider', elements.account)) setText(node, provider)
    for (const node of Array.from(elements.account.querySelectorAll<HTMLElement>('[data-grant-date]'))) {
      const granted = ctx.consents?.granted.find((g) => g.kind === node.dataset.grantDate)
      setText(node, granted ? `надано ${shortDate(granted.granted_at)}` : 'не надано')
      const button = node.closest('.grants__item')?.querySelector<HTMLElement>('button')
      if (button) show(button.closest<HTMLElement>('.arrows') ?? button, granted !== undefined)
    }
    const op = ctx.op
    const own = op !== null && op.error !== null && op.name === 'logout' && m.overlay.length === 1
    setText(byEl('account-op-error', elements.account), own && op?.error ? accountOpError(op.name, op.error) : '')
  }

  function refreshHelp(m: Model): void {
    const helplines = m.ctx.helplines
    fillLines(byEl('help-lines', elements.help), byEl('help-lines-block', elements.help), helplines.status === 'ok' ? helplines.value.lines : [])
    const state = m.state
    const session = state.s === 'chat' || state.s === 'summarizing' || state.s === 'review' ? state.session : null
    show(byEl('help-kept', elements.help), hasUserMessage(session, state.s === 'chat' ? state.pending : null))
  }

  function refreshPick(m: Model): void {
    const top = m.overlay.find((o) => o.o === 'revisit-pick')
    if (top === undefined || top.o !== 'revisit-pick') return
    const root = elements['revisit-pick']
    show(byEl('pick-gone', root), top.gone)
    setText(byEl('pick-status', root), top.loading ? 'Завантажуємо записи…' : top.failed ? 'Не вдалося завантажити збережені тези.' : '')
    const list = byEl('pick-list', root)
    const items = top.list?.items ?? []
    const known = new Set(Array.from(list.querySelectorAll<HTMLElement>('[data-id]')).map((n) => n.dataset.id))
    const wanted = new Set(items.map((i) => i.id))
    if (known.size !== wanted.size || [...wanted].some((id) => !known.has(id))) {
      list.replaceChildren()
      for (const item of items) {
        const li = fromTemplate<HTMLLIElement>('pick')
        li.dataset.id = item.id
        const input = li.querySelector<HTMLInputElement>('.pick__input')!
        input.dataset.act = 'revisit-toggle'
        input.dataset.id = item.id
        setText(li.querySelector('.pick__title')!, item.title)
        const tags = item.tags.map((t) => `#${t.name}`).join(' ')
        setText(li.querySelector('.pick__meta')!, [dayMonth(item.created_at), tags].filter((x) => x !== '').join(' · '))
        setText(li.querySelector('.pick__first')!, item.bullets[0] ?? '')
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

  function returnFocus(opener: HTMLElement | null): void {
    const inOpenDialog = (node: HTMLElement): boolean => {
      const dialog = node.closest('dialog')
      return dialog !== null && !dialog.open
    }
    if (opener !== null && opener.isConnected && !inOpenDialog(opener) && opener.closest('[hidden]') === null) {
      opener.focus()
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

  return {
    helpOpen: () => stack.some((o) => o.kind === 'help'),
    pickTried() {
      pickTried = true
      if (last !== null) refreshPick(last)
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
        if (!screenChanged) returnFocus(top.opener)
      }
      if (wanted.every((o) => o.o !== 'revisit-pick')) pickTried = false
      // Open what is new, in order (account under its confirm).
      for (let i = stack.length; i < wanted.length; i++) {
        const overlay = wanted[i]!
        const el = elements[overlay.o]
        const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
        const key = confirmKey(overlay)
        if (key !== null) fillConfirm(key)
        stack.push({ kind: overlay.o, el, opener, confirm: key })
        if (overlay.o === 'confirm') refreshConfirm(next)
        if (overlay.o === 'account') refreshAccount(next)
        if (overlay.o === 'help') refreshHelp(next)
        if (overlay.o === 'revisit-pick') refreshPick(next)
        if (!el.open) el.showModal()
        initialFocus(el)
      }
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
    },
  }
}
