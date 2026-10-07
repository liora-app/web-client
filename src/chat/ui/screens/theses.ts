// Theses (spec §7.1–7.3): the wait while the AI drafts them, then the draft edited in place.
//
// summarizing: an llm_busy retry is a countdown, not an error (`error` null, `busy` > 0, `until`):
// «Скласти ще раз» is not offered beside it (I2). After a 429 the manual retry waits for `until`.
// review: while `saving` is 'unknown' the draft is read-only — the retry first compares the newest
// record with the body that went out (§7.3). A 422 lands on the field the core mapped it to through
// the index tables of the filtered body (§7.2). «Повернути» has no timer; one thesis always stays.

import { BULLET_COUNTER_FROM, MAX_BULLET, MAX_BULLETS, MAX_TITLE, TITLE_COUNTER_FROM, codePoints, newTagIssue, type Draft } from '../../core/limits'
import type { Action, Model, State } from '../../core/state'
import { DRAFT_TEXT, busyWait, counter, requestIdLine, saveError, summarizeError } from '../copy'
import { byEl, fromTemplate, screenOf, setAttr, setText, show } from '../dom'
import type { Screen } from './text'

type Summarizing = Extract<State, { s: 'summarizing' }>
type Review = Extract<State, { s: 'review' }>

const LONG_WAIT_MS = 10_000

export function summarizingScreen(): Screen {
  const root = screenOf('summarizing')
  const el = (name: string): HTMLElement => byEl(name, root)
  let longTimer = 0
  let ticker = 0
  let last: Model | null = null

  const paint = (): void => {
    if (last === null || last.state.s !== 'summarizing') return
    const state = last.state as Summarizing
    const now = Date.now()
    const waitingBusy = state.error === null && state.busy > 0 && state.until !== null
    const error = state.error
    const code = error?.code ?? ''
    const left = state.until === null ? null : Math.max(0, Math.ceil((state.until - now) / 1000))
    const text = error !== null ? summarizeError(error, last.ctx.csrfFailures, code === 'rate_limited' ? left : null) : null
    setText(el('sum-status'), text !== null ? text.why : waitingBusy ? busyWait(left ?? 0) : '')
    const id = text?.showId === true ? requestIdLine(error!.requestId) : null
    setText(el('sum-request-id'), id ?? '')
    show(el('sum-request-id'), id !== null)
    const reload = text?.reload === true
    // 422 and 413: the same body would get the same answer, so no «Скласти ще раз» (§4.3).
    const canRetry = error !== null && !reload && code !== 'validation_error' && code !== 'payload_too_large'
    show(el('sum-retry-actions'), canRetry || code === 'payload_too_large')
    show(el('sum-retry'), canRetry)
    const cooling = code === 'rate_limited' && state.until !== null && now < state.until
    setAttr(el('sum-retry'), 'aria-disabled', cooling ? 'true' : null)
    show(el('sum-end-button'), code === 'payload_too_large')
    show(el('sum-reload-row'), reload)
    show(el('sum-cancel'), error === null)
    show(el('sum-back'), error !== null)
    show(el('sum-end'), error !== null && code !== 'payload_too_large')
    const needsTick = waitingBusy || cooling
    if (needsTick && ticker === 0) ticker = window.setInterval(paint, 1000)
    if (!needsTick && ticker !== 0) {
      window.clearInterval(ticker)
      ticker = 0
    }
  }

  return {
    render(model, entered) {
      last = model
      if (entered) {
        window.clearTimeout(longTimer)
        show(el('sum-long'), false)
        longTimer = window.setTimeout(() => {
          if (last?.state.s === 'summarizing') show(el('sum-long'), true)
        }, LONG_WAIT_MS)
      }
      paint()
    },
  }
}

export type ReviewScreen = Screen & Readonly<{ act(name: string, target: HTMLElement): boolean; draft(): Draft | null }>

export function reviewScreen(dispatch: (action: Action) => void): ReviewScreen {
  const root = screenOf('review')
  const el = <T extends HTMLElement = HTMLElement>(name: string): T => byEl<T>(name, root)
  const title = el<HTMLInputElement>('review-title')
  const bullets = el('review-bullets')
  const tags = el('review-tags')
  const tagInput = el<HTMLInputElement>('review-tag-input')
  const tagError = el('review-tag-error')
  let last: Model | null = null
  let seq = 0
  let focusId: string | null = null
  let lastIssues: Review['issues'] = []

  const current = (): Review | null => (last !== null && last.state.s === 'review' ? (last.state as Review) : null)
  const update = (draft: Draft): void => dispatch({ type: 'review/update', draft })

  title.addEventListener('input', () => {
    const state = current()
    if (state) update({ ...state.draft, title: title.value })
  })
  bullets.addEventListener('input', (event) => {
    const state = current()
    const input = event.target as HTMLTextAreaElement
    const id = input.closest<HTMLElement>('[data-id]')?.dataset.id
    if (!state || !id) return
    update({ ...state.draft, bullets: state.draft.bullets.map((b) => (b.id === id ? { ...b, text: input.value } : b)) })
  })
  tagInput.addEventListener('keydown', (event) => {
    if (event.isComposing) return
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      addTag()
    }
  })

  function addTag(): void {
    const state = current()
    if (!state || state.saving !== 'idle') return
    const name = tagInput.value.replace(/,/g, ' ').trim()
    const issue = newTagIssue(name, state.draft.tags)
    if (issue !== null) {
      setText(tagError, issue === 'tag-empty' ? '' : (DRAFT_TEXT[issue] ?? ''))
      return
    }
    setText(tagError, '')
    seq++
    update({ ...state.draft, tags: [...state.draft.tags, { id: `u${seq}`, name, source: 'user' }] })
    tagInput.value = ''
  }

  const activeCount = (draft: Draft): number => draft.bullets.filter((b) => !b.removed).length

  const renderBullets = (state: Review): void => {
    const { draft } = state
    const rows = new Map(Array.from(bullets.querySelectorAll<HTMLLIElement>('li[data-id]')).map((li) => [li.dataset.id!, li]))
    const active = activeCount(draft)
    let n = 0
    let previous: HTMLLIElement | null = null
    for (const bullet of draft.bullets) {
      let li = rows.get(bullet.id)
      if (li === undefined) {
        li = fromTemplate<HTMLLIElement>('bullet')
        li.dataset.id = bullet.id
        const input = li.querySelector<HTMLTextAreaElement>('textarea')!
        input.id = `thesis-${bullet.id}`
        input.setAttribute('aria-describedby', `thesis-${bullet.id}-error`)
        li.querySelector<HTMLLabelElement>('label')!.htmlFor = input.id
        li.querySelector<HTMLElement>('.field-error')!.id = `thesis-${bullet.id}-error`
        for (const button of Array.from(li.querySelectorAll<HTMLElement>('button'))) button.dataset.id = bullet.id
      }
      rows.delete(bullet.id)
      const next: ChildNode | null = previous === null ? bullets.firstChild : previous.nextSibling
      if (next !== li) bullets.insertBefore(li, next)
      previous = li
      if (!bullet.removed) n++
      const label = `Теза ${n}`
      setText(li.querySelector('.thesis__index')!, bullet.removed ? '' : String(n).padStart(2, '0'))
      setText(li.querySelector('label')!, label)
      const input = li.querySelector<HTMLTextAreaElement>('textarea')!
      if (input.value !== bullet.text) input.value = bullet.text
      input.readOnly = state.saving !== 'idle'
      show(input.closest<HTMLElement>('.thesis__field')!, !bullet.removed)
      const remove = li.querySelector<HTMLElement>('.thesis__remove')!
      const restore = li.querySelector<HTMLElement>('[data-act="bullet-restore"]')!
      setAttr(restore, 'aria-disabled', state.saving !== 'idle' || active >= MAX_BULLETS ? 'true' : null)
      show(remove, !bullet.removed)
      setAttr(remove, 'aria-label', `Прибрати тезу ${n}`)
      const lastOne = !bullet.removed && active === 1
      setAttr(remove, 'aria-disabled', lastOne || state.saving !== 'idle' ? 'true' : null)
      show(li.querySelector<HTMLElement>('.thesis__hint')!, lastOne)
      show(li.querySelector<HTMLElement>('.thesis__removed')!, bullet.removed)
      li.classList.toggle('thesis--removed', bullet.removed)
      const length = codePoints(bullet.text.trim())
      const count = li.querySelector<HTMLElement>('.field__count')!
      setText(count, length >= BULLET_COUNTER_FROM ? counter(length, MAX_BULLET) : '')
      show(count, length >= BULLET_COUNTER_FROM && !bullet.removed)
      const issue = state.issues.find((i) => i.field === bullet.id && i.reason !== 'bullets-none')
      setText(li.querySelector('.field-error')!, issue ? (DRAFT_TEXT[issue.reason] ?? '') : '')
      setAttr(input, 'aria-invalid', issue ? 'true' : null)
    }
    for (const stale of rows.values()) stale.remove()
    const none = state.issues.find((i) => i.reason === 'bullets-none')
    setText(el('review-bullets-error'), none ? (DRAFT_TEXT[none.reason] ?? '') : '')
    show(el('review-add-wrap'), active < MAX_BULLETS && state.saving === 'idle')
  }

  const renderTags = (state: Review): void => {
    tags.replaceChildren()
    for (const tag of state.draft.tags) {
      const li = fromTemplate<HTMLLIElement>('tag')
      setText(li.querySelector('.tagpill__name')!, `#${tag.name}`)
      const remove = li.querySelector<HTMLElement>('.tagpill__remove')!
      remove.dataset.id = tag.id
      remove.setAttribute('aria-label', `Прибрати тег «${tag.name}»`)
      setAttr(remove, 'aria-disabled', state.saving !== 'idle' ? 'true' : null)
      const issue = state.issues.find((i) => i.field === tag.id)
      if (issue) li.classList.add('tagpill--invalid')
      tags.append(li)
    }
    show(el('review-tags-none'), state.draft.tags.length === 0)
    const tagIssue = state.issues.find((i) => state.draft.tags.some((t) => t.id === i.field))
    if (tagIssue) setText(tagError, DRAFT_TEXT[tagIssue.reason] ?? '')
  }

  return {
    draft: () => current()?.draft ?? null,
    act(name, target) {
      const state = current()
      if (!state) return false
      const id = target.dataset.id
      switch (name) {
        case 'bullet-remove': {
          if (state.saving !== 'idle' || target.getAttribute('aria-disabled') === 'true') return true
          if (activeCount(state.draft) <= 1) return true
          update({ ...state.draft, bullets: state.draft.bullets.map((b) => (b.id === id ? { ...b, removed: true } : b)) })
          root.querySelector<HTMLElement>(`li[data-id="${id}"] [data-act="bullet-restore"]`)?.focus()
          return true
        }
        case 'bullet-restore': {
          if (state.saving !== 'idle' || activeCount(state.draft) >= MAX_BULLETS) return true
          update({ ...state.draft, bullets: state.draft.bullets.map((b) => (b.id === id ? { ...b, removed: false } : b)) })
          root.querySelector<HTMLElement>(`#thesis-${id}`)?.focus()
          return true
        }
        case 'bullet-add': {
          if (state.saving !== 'idle' || activeCount(state.draft) >= MAX_BULLETS) return true
          seq++
          const fresh = `n${seq}`
          focusId = fresh
          update({ ...state.draft, bullets: [...state.draft.bullets, { id: fresh, text: '', removed: false }] })
          return true
        }
        case 'tag-remove':
          if (state.saving !== 'idle') return true
          update({ ...state.draft, tags: state.draft.tags.filter((t) => t.id !== id) })
          tagInput.focus()
          return true
        case 'tag-add':
          addTag()
          return true
        default:
          return false
      }
    },
    render(model, entered) {
      last = model
      const state = model.state as Review
      const { draft } = state
      if (entered) {
        lastIssues = []
        setText(tagError, '')
        tagInput.value = ''
      }
      if (title.value !== draft.title) title.value = draft.title
      title.readOnly = state.saving !== 'idle'
      const titleLength = codePoints(draft.title.trim())
      const titleCount = el('review-title-count')
      setText(titleCount, titleLength >= TITLE_COUNTER_FROM ? counter(titleLength, MAX_TITLE) : '')
      show(titleCount, titleLength >= TITLE_COUNTER_FROM)
      const titleIssue = state.issues.find((i) => i.field === 'title')
      setText(el('review-title-error'), titleIssue ? (DRAFT_TEXT[titleIssue.reason] ?? '') : '')
      setAttr(title, 'aria-invalid', titleIssue ? 'true' : null)

      renderBullets(state)
      renderTags(state)
      tagInput.readOnly = state.saving !== 'idle'
      setAttr(el('review-tag-add'), 'aria-disabled', state.saving !== 'idle' ? 'true' : null)

      const noSave = state.session.noSave
      show(el('review-nosave'), noSave)
      show(el('review-save'), !noSave)
      show(el('review-done'), noSave)
      show(el('review-copy'), noSave)
      const save = el('review-save')
      setText(save, state.saving === 'saving' ? 'Зберігаємо…' : state.saving === 'unknown' ? 'Спробувати ще раз' : 'Зберегти в щоденник')
      setAttr(save, 'aria-busy', state.saving === 'saving' ? 'true' : null)
      const text = state.error !== null ? saveError(state.error, model.ctx.csrfFailures) : null
      setText(el('review-error'), text?.why ?? '')
      const id = text?.showId === true ? requestIdLine(state.error!.requestId) : null
      setText(el('review-request-id'), id ?? '')
      show(el('review-request-id'), id !== null)
      // A repeated csrf_failed: copy the theses, then reload (§4.3).
      show(el('review-reload-row'), text?.reload === true)
      setAttr(el('review-discard'), 'aria-disabled', state.saving === 'saving' ? 'true' : null)

      // A failed check or a 422: focus the first field that is wrong (§7.2).
      if (state.issues !== lastIssues && state.issues.length > 0) {
        const first = state.issues[0]!
        const target =
          first.field === 'title'
            ? title
            : (root.querySelector<HTMLElement>(`#thesis-${first.field}`) ?? (first.reason === 'bullets-none' ? root.querySelector<HTMLElement>('.thesis__input') : tagInput))
        target?.focus()
      }
      lastIssues = state.issues
      if (focusId !== null) {
        root.querySelector<HTMLElement>(`#thesis-${focusId}`)?.focus()
        focusId = null
      }
    },
  }
}
