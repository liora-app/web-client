// The diary page (spec §7.7): the week at the top, a search and the themes, the records as a calm
// list with dividers. A record is edited in place (title, theses, themes → PATCH), deleted after a
// confirm, copied as Markdown, or taken back into a conversation.
//
// Records are the AI's drafts the person kept: every text goes in through textContent, with the
// paused number masked, and the form's first values come masked from the core (journal.ts
// formOf). The list holds no text in data-* — only the record's id. Leaving the screen takes the
// records, the search and the week out of the hidden section.

import { maskPausedLineInline } from '../../core/helplines'
import { shiftDay, type EntryForm } from '../../core/journal'
import { MAX_BULLETS } from '../../core/limits'
import { journalBusy, revisitOffered, type Action, type JournalState, type Model } from '../../core/state'
import type { SummaryOut } from '../../core/types'
import {
  DRAFT_TEXT,
  JOURNAL_BACK,
  JOURNAL_DELETED,
  JOURNAL_EMPTY,
  JOURNAL_FAILED,
  JOURNAL_GONE,
  JOURNAL_LOADING,
  JOURNAL_NEW,
  JOURNAL_SAVED,
  THEMES_ISSUE,
  WEEK_FAILED,
  WEEK_THIS,
  deleteError,
  editError,
  entryMeta,
  journalNothing,
  requestIdLine,
  weekCount,
  weekRange,
  weekThemes,
} from '../copy'
import { byEl, fromTemplate, screenOf, setAttr, setText, show } from '../dom'
import type { Screen } from './text'

/** The search goes 300 ms after the last keystroke (§7.7), as in the record picker. */
const SEARCH_DEBOUNCE_MS = 300

export type JournalScreen = Screen & Readonly<{ act(name: string, target: HTMLElement): boolean }>

export function journalScreen(dispatch: (action: Action) => void): JournalScreen {
  const root = screenOf('journal')
  const el = <T extends HTMLElement = HTMLElement>(name: string): T => byEl<T>(name, root)
  const list = el('journal-list')
  const search = el<HTMLInputElement>('journal-q')
  const themes = el('journal-theme-list')
  let last: Model | null = null
  let searchTimer = 0
  let themeKey = ''
  /** The edit open at the last render (its record's id), its issues, and a field to focus next. */
  let editing: string | null = null
  let shownIssues: unknown = null
  let focusNext: string | null = null
  /** The record each row shows: a new object (a PATCH, a reload) is written again. Never in data-*. */
  const shown = new WeakMap<HTMLLIElement, SummaryOut>()

  const current = (): JournalState | null => (last !== null && last.state.s === 'journal' ? last.state : null)

  search.addEventListener('input', () => {
    window.clearTimeout(searchTimer)
    searchTimer = window.setTimeout(() => dispatch({ type: 'journal/search', q: search.value }), SEARCH_DEBOUNCE_MS)
  })
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return
    event.preventDefault()
    window.clearTimeout(searchTimer)
    dispatch({ type: 'journal/search', q: search.value })
  })
  themes.addEventListener('change', (event) => {
    const input = event.target
    if (input instanceof HTMLInputElement && input.checked) dispatch({ type: 'journal/tag', id: input.value === '' ? null : input.value })
  })

  /** The edit form as the person left it in the fields: the core takes it whole. */
  const formFrom = (li: HTMLElement, id: string): EntryForm => ({
    id,
    title: li.querySelector<HTMLInputElement>('.entry__title-input')!.value,
    bullets: Array.from(li.querySelectorAll<HTMLTextAreaElement>('.entry__thesis-input')).map((field) => field.value),
    tags: li.querySelector<HTMLInputElement>('.entry__tags-input')!.value,
  })
  list.addEventListener('input', (event) => {
    const field = event.target
    if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) return
    const li = field.closest<HTMLElement>('li.entry')
    const id = li?.dataset.id
    if (li && id && current()?.edit?.form.id === id) dispatch({ type: 'journal/edit-update', form: formFrom(li, id) })
  })
  list.addEventListener('keydown', (event) => {
    // Esc in the form gives the record back as it was (nothing was saved).
    if (event.key !== 'Escape' || event.isComposing) return
    const li = (event.target as Element | null)?.closest?.('li.entry')
    if (li && current()?.edit?.saving === false) {
      event.preventDefault()
      dispatch({ type: 'journal/edit-cancel' })
    }
  })

  const entryOf = (id: string): HTMLLIElement | null => list.querySelector<HTMLLIElement>(`li.entry[data-id="${CSS.escape(id)}"]`)

  function renderWeek(state: JournalState, hidden: boolean): void {
    const week = state.week
    show(el('week'), !hidden)
    const review = week.review.status === 'ok' ? week.review.value : null
    const start = week.start
    const isThis = start !== null && start === week.current
    const sunday = review !== null && review.week_start === start ? shiftDay(review.week_end, -1) : start !== null ? shiftDay(start, 6) : null
    const title = start === null || isThis || sunday === null ? WEEK_THIS : weekRange(start, sunday, week.current?.slice(0, 4) ?? null)
    setText(el('week-title'), title)
    // While the next week loads, its range is up and its numbers are not: no old count under a new
    // title.
    const loaded = review !== null && review.week_start === start
    setText(el('week-count'), loaded ? weekCount(review.sessions) : '')
    const words = loaded ? weekThemes(review.top_tags.map((t) => t.name)) : ''
    setText(el('week-themes'), words)
    show(el('week-themes'), words !== '')
    const failed = week.review.status === 'failed'
    setText(el('week-status'), failed ? WEEK_FAILED : '')
    show(el('week-retry'), failed)
    const busy = week.review.status === 'loading'
    setAttr(el('week-prev'), 'aria-disabled', start === null || busy ? 'true' : null)
    setAttr(el('week-next'), 'aria-disabled', start === null || busy || week.current === null || start >= week.current ? 'true' : null)
  }

  function renderThemes(state: JournalState, hidden: boolean): void {
    const tags = state.tags.status === 'ok' ? state.tags.value : []
    show(el('journal-themes'), !hidden && tags.length > 0)
    const key = tags.map((t) => `${t.id}:${t.name}`).join('|')
    if (key !== themeKey) {
      themeKey = key
      themes.replaceChildren()
      for (const tag of [{ id: '', name: '' }, ...tags]) {
        const pill = fromTemplate<HTMLLabelElement>('theme')
        const input = pill.querySelector<HTMLInputElement>('input')!
        input.value = tag.id
        setText(pill.querySelector('.pill__text')!, tag.id === '' ? 'Усі теми' : `#${maskPausedLineInline(tag.name)}`)
        themes.append(pill)
      }
    }
    for (const input of Array.from(themes.querySelectorAll<HTMLInputElement>('input'))) {
      const on = input.value === (state.tag ?? '')
      if (input.checked !== on) input.checked = on
      input.closest('.pill')?.classList.toggle('pill--on', on)
    }
  }

  function fillView(li: HTMLLIElement, item: SummaryOut): void {
    setText(li.querySelector('.entry__meta')!, entryMeta(item.created_at, item.edited_at !== null))
    setText(li.querySelector('.entry__title')!, maskPausedLineInline(item.title))
    const bullets = li.querySelector<HTMLElement>('.entry__bullets')!
    bullets.replaceChildren()
    item.bullets.forEach((bullet, i) => {
      const row = document.createElement('li')
      const index = document.createElement('span')
      index.className = 'entry__index'
      index.setAttribute('aria-hidden', 'true')
      index.textContent = String(i + 1).padStart(2, '0')
      const text = document.createElement('p')
      text.textContent = maskPausedLineInline(bullet)
      row.append(index, text)
      bullets.append(row)
    })
    const tags = li.querySelector<HTMLElement>('.entry__themes')!
    setText(tags, item.tags.map((t) => `#${maskPausedLineInline(t.name)}`).join(' '))
    show(tags, item.tags.length > 0)
  }

  function newEntry(item: SummaryOut): HTMLLIElement {
    const li = fromTemplate<HTMLLIElement>('entry')
    li.dataset.id = item.id
    const heading = `entry-${item.id}-h`
    li.querySelector<HTMLElement>('.entry__title')!.id = heading
    for (const button of Array.from(li.querySelectorAll<HTMLElement>('.entry__actions button'))) {
      button.dataset.id = item.id
      // «Редагувати», «Видалити»… of which record: its title says it.
      button.setAttribute('aria-describedby', heading)
    }
    for (const button of Array.from(li.querySelectorAll<HTMLElement>('.entry__edit button'))) button.dataset.id = item.id
    const title = li.querySelector<HTMLInputElement>('.entry__title-input')!
    title.id = `entry-${item.id}-title`
    li.querySelector<HTMLLabelElement>('[data-for="title"]')!.htmlFor = title.id
    li.querySelector<HTMLElement>('[data-err="title"]')!.id = `${title.id}-error`
    title.setAttribute('aria-describedby', `${title.id}-error`)
    const tags = li.querySelector<HTMLInputElement>('.entry__tags-input')!
    tags.id = `entry-${item.id}-tags`
    li.querySelector<HTMLLabelElement>('[data-for="tags"]')!.htmlFor = tags.id
    li.querySelector<HTMLElement>('[data-hint="tags"]')!.id = `${tags.id}-hint`
    li.querySelector<HTMLElement>('[data-err="tags"]')!.id = `${tags.id}-error`
    tags.setAttribute('aria-describedby', `${tags.id}-hint ${tags.id}-error`)
    li.querySelector<HTMLElement>('[data-err="bullets"]')!.id = `entry-${item.id}-bullets-error`
    fillView(li, item)
    return li
  }

  function renderEdit(li: HTMLLIElement, state: JournalState): void {
    const edit = state.edit!
    const { form } = edit
    const id = form.id
    const title = li.querySelector<HTMLInputElement>('.entry__title-input')!
    if (title.value !== form.title) title.value = form.title
    title.readOnly = edit.saving
    const fields = li.querySelector<HTMLElement>('.entry__fields')!
    const rows = Array.from(fields.children) as HTMLLIElement[]
    for (let i = rows.length; i < form.bullets.length; i++) {
      const row = fromTemplate<HTMLLIElement>('entry-thesis')
      const input = row.querySelector<HTMLTextAreaElement>('textarea')!
      input.id = `entry-${id}-b${i}`
      row.querySelector<HTMLLabelElement>('label')!.htmlFor = input.id
      setText(row.querySelector('label')!, `Теза ${i + 1}`)
      row.querySelector<HTMLElement>('.field-error')!.id = `${input.id}-error`
      fields.append(row)
    }
    for (const stale of rows.slice(form.bullets.length)) stale.remove()
    const none = edit.issues.some((issue) => issue.reason === 'bullets-none')
    Array.from(fields.querySelectorAll<HTMLTextAreaElement>('textarea')).forEach((input, i) => {
      const text = form.bullets[i] ?? ''
      if (input.value !== text) input.value = text
      input.readOnly = edit.saving
      const issue = edit.issues.find((x) => x.field === `b${i}` && x.reason !== 'bullets-none')
      setText(input.parentElement!.querySelector('.field-error')!, issue ? (DRAFT_TEXT[issue.reason] ?? '') : '')
      setAttr(input, 'aria-invalid', issue || none ? 'true' : null)
      setAttr(input, 'aria-describedby', none ? `${input.id}-error entry-${id}-bullets-error` : `${input.id}-error`)
    })
    setText(li.querySelector('[data-err="bullets"]')!, none ? (DRAFT_TEXT['bullets-none'] ?? '') : '')
    show(li.querySelector<HTMLElement>('[data-slot="add"]')!, form.bullets.length < MAX_BULLETS && !edit.saving)

    const titleIssue = edit.issues.find((issue) => issue.field === 'title')
    setText(li.querySelector('[data-err="title"]')!, titleIssue ? (DRAFT_TEXT[titleIssue.reason] ?? '') : '')
    setAttr(title, 'aria-invalid', titleIssue ? 'true' : null)
    const tags = li.querySelector<HTMLInputElement>('.entry__tags-input')!
    if (tags.value !== form.tags) tags.value = form.tags
    tags.readOnly = edit.saving
    const tagIssue = edit.issues.some((issue) => issue.field.startsWith('t') && issue.field !== 'title')
    setText(li.querySelector('[data-err="tags"]')!, tagIssue ? THEMES_ISSUE : '')
    setAttr(tags, 'aria-invalid', tagIssue ? 'true' : null)

    const save = li.querySelector<HTMLElement>('[data-act="entry-save"]')!
    setText(save, edit.saving ? 'Зберігаємо…' : 'Зберегти')
    setAttr(save, 'aria-busy', edit.saving ? 'true' : null)
    setAttr(li.querySelector<HTMLElement>('[data-act="entry-cancel"]')!, 'aria-disabled', edit.saving ? 'true' : null)
    const text = edit.error !== null && last !== null ? editError(edit.error, last.ctx.csrfFailures) : null
    const id2 = text?.showId === true ? requestIdLine(edit.error!.requestId) : null
    setText(li.querySelector('[data-err="edit"]')!, text === null ? '' : id2 === null ? text.why : `${text.why} ${id2}`)

    // A check or a 422 found something: the first wrong field takes the focus (as on the theses).
    if (edit.issues !== shownIssues && edit.issues.length > 0) {
      const first = edit.issues[0]!
      const target =
        first.field === 'title'
          ? title
          : first.reason === 'bullets-none'
            ? fields.querySelector<HTMLElement>('textarea')
            : first.field.startsWith('b')
              ? li.querySelector<HTMLElement>(`#entry-${CSS.escape(id)}-b${first.field.slice(1)}`)
              : tags
      target?.focus()
    }
    shownIssues = edit.issues
  }

  function renderList(state: JournalState): void {
    const items = state.list?.items ?? []
    const before = Array.from(list.querySelectorAll<HTMLLIElement>('li.entry'))
    const rows = new Map(before.map((li) => [li.dataset.id!, li]))
    // A record that holds the focus and leaves now (deleted, gone meanwhile): the focus goes to the
    // record that takes its place, else the one above it, else the page's heading — never to <body>.
    const kept = new Set(items.map((item) => item.id))
    const at = before.findIndex((li) => !kept.has(li.dataset.id!) && li.contains(document.activeElement))
    const heir =
      at < 0 ? undefined : (before.slice(at + 1).find((li) => kept.has(li.dataset.id!)) ?? before.slice(0, at).reverse().find((li) => kept.has(li.dataset.id!)) ?? null)
    let previous: HTMLLIElement | null = null
    const offered = last !== null && revisitOffered(last.ctx)
    // A PATCH or a DELETE on its way: the ways off the page wait for its answer (the core holds them).
    const busy = journalBusy(state)
    const editId = state.edit?.form.id ?? null
    for (const item of items) {
      let li = rows.get(item.id)
      if (li === undefined) li = newEntry(item)
      else if (shown.get(li) !== item) fillView(li, item)
      shown.set(li, item)
      rows.delete(item.id)
      const next: ChildNode | null = previous === null ? list.firstChild : previous.nextSibling
      if (next !== li) list.insertBefore(li, next)
      previous = li
      const editingThis = editId === item.id
      show(li.querySelector<HTMLElement>('.entry__view')!, !editingThis)
      show(li.querySelector<HTMLElement>('.entry__edit')!, editingThis)
      if (editingThis) renderEdit(li, state)
      else li.querySelector<HTMLElement>('.entry__fields')!.replaceChildren()
      show(li.querySelector<HTMLElement>('[data-slot="revisit"]')!, offered)
      setAttr(li.querySelector<HTMLElement>('[data-act="entry-revisit"]')!, 'aria-disabled', busy ? 'true' : null)
      setAttr(li.querySelector<HTMLElement>('[data-act="entry-edit"]')!, 'aria-disabled', editId !== null || state.deleting === item.id ? 'true' : null)
      const remove = li.querySelector<HTMLElement>('[data-act="entry-delete"]')!
      setAttr(remove, 'aria-disabled', state.deleting !== null && state.deleting !== item.id ? 'true' : null)
      setAttr(remove, 'aria-busy', state.deleting === item.id ? 'true' : null)
    }
    for (const stale of rows.values()) stale.remove()
    if (heir !== undefined) (heir?.querySelector<HTMLElement>('[data-act="entry-edit"]') ?? root.querySelector<HTMLElement>('#journal-title'))?.focus()
  }

  /** The live line: the list loading or failed, else what just happened and what the list holds
   *  when it holds nothing — «нічого не знайшлося», the empty diary. One line for both, in the
   *  region that is always there: «Завантажуємо записи…» is said, so the answer must be said too
   *  (WCAG 4.1.3), not left in a plain paragraph that appears silently. */
  function statusText(state: JournalState, nothing: string): string {
    if (state.loading) return JOURNAL_LOADING
    if (state.failed) return JOURNAL_FAILED
    const notice = state.notice === null ? '' : noticeText(state.notice)
    return notice === '' ? nothing : nothing === '' ? notice : `${notice} ${nothing}`
  }

  function noticeText(notice: NonNullable<JournalState['notice']>): string {
    switch (notice.kind) {
      case 'saved':
        return JOURNAL_SAVED
      case 'deleted':
        return JOURNAL_DELETED
      case 'gone':
        return JOURNAL_GONE
      case 'delete-failed':
        return deleteError(notice.error, last?.ctx.csrfFailures ?? 0).why
    }
  }

  return {
    act(name, target) {
      const state = current()
      if (state === null) return false
      const id = target.dataset.id ?? ''
      switch (name) {
        case 'entry-edit':
          dispatch({ type: 'journal/edit', id })
          return true
        case 'entry-cancel':
          dispatch({ type: 'journal/edit-cancel' })
          return true
        case 'entry-save': {
          // What is in the fields now, even if the last keystroke has not reached the core yet.
          const li = entryOf(id)
          if (li !== null && state.edit?.form.id === id && !state.edit.saving) dispatch({ type: 'journal/edit-update', form: formFrom(li, id) })
          dispatch({ type: 'journal/edit-save' })
          return true
        }
        case 'entry-bullet-add':
          if (state.edit !== null) focusNext = `entry-${state.edit.form.id}-b${state.edit.form.bullets.length}`
          dispatch({ type: 'journal/edit-add' })
          return true
        case 'entry-delete':
          dispatch({ type: 'confirm/open', kind: 'delete-summary', summary: id })
          return true
        case 'entry-revisit':
          dispatch({ type: 'journal/revisit', id })
          return true
        default:
          return false
      }
    },
    render(model, entered) {
      last = model
      const state = model.state as JournalState
      if (entered) {
        window.clearTimeout(searchTimer)
        search.value = state.q
        editing = null
        shownIssues = null
      }
      setText(el('journal-back-label'), state.back !== null ? JOURNAL_BACK : JOURNAL_NEW)
      setAttr(root.querySelector<HTMLElement>('[data-act="journal-back"]')!, 'aria-disabled', journalBusy(state) ? 'true' : null)
      // An empty diary: one line, nothing to search, filter or count.
      const empty = state.list !== null && state.list.items.length === 0 && state.q === '' && state.tag === null && !state.loading && !state.failed
      renderWeek(state, empty)
      show(el('journal-tools'), !empty)
      renderThemes(state, empty)

      const nothing = state.list !== null && state.list.items.length === 0 && !state.loading && !state.failed
      setText(el('journal-status'), statusText(state, nothing ? (empty ? JOURNAL_EMPTY : journalNothing(state.q)) : ''))
      show(el('journal-retry'), state.failed && !state.loading)
      const more = el('journal-more')
      // «Показати ще» pressed for the last page goes away with it: the focus goes on to the first
      // record it brought, not back up to the heading.
      const fromMore = more.contains(document.activeElement)
      const shownBefore = list.querySelectorAll('li.entry').length
      renderList(state)
      show(more, state.list?.nextCursor != null && !state.failed)
      setAttr(more.querySelector('button')!, 'aria-disabled', state.loading ? 'true' : null)
      if (fromMore && more.hidden) {
        // …or, when that page failed, to «Спробувати ще раз» that stands in its place.
        const next = state.failed
          ? el('journal-retry').querySelector<HTMLElement>('button')
          : list.querySelectorAll<HTMLLIElement>('li.entry')[shownBefore]?.querySelector<HTMLElement>('[data-act="entry-edit"]')
        next?.focus()
      }

      // Focus: into the form when it opens; back to its «Редагувати» when it closes; onto a thesis
      // field just added.
      const editId = state.edit?.form.id ?? null
      if (editId !== editing) {
        if (editId !== null) {
          // The caret at the start: a long title in the one-line field then shows its beginning (on a
          // phone the end alone, cut at its first letter, read as a broken field).
          const field = entryOf(editId)?.querySelector<HTMLInputElement>('.entry__title-input')
          field?.focus()
          field?.setSelectionRange(0, 0)
          if (field) field.scrollLeft = 0
        } else if (editing !== null) entryOf(editing)?.querySelector<HTMLElement>('[data-act="entry-edit"]')?.focus()
        editing = editId
        shownIssues = state.edit?.issues ?? null
      }
      if (focusNext !== null) {
        root.querySelector<HTMLElement>(`#${CSS.escape(focusNext)}`)?.focus()
        focusNext = null
      }
    },
    // Another screen (the conversation, a sign-out, a consent): the records leave with this one.
    leave() {
      window.clearTimeout(searchTimer)
      last = null
      editing = null
      list.replaceChildren()
      themes.replaceChildren()
      themeKey = ''
      search.value = ''
      for (const name of ['week-count', 'week-themes', 'week-status', 'journal-status']) setText(el(name), '')
    },
  }
}
