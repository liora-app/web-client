// The crisis takeover (spec §6). 112 and 103 are constants in chat/index.html; from the payload
// only the sanitized fields reach the page (core/helplines.ts): the lead, the support lines and the
// text about other countries. The conversation is read-only, under the contacts, in <details>.
// There is no way back into it — only a new, empty conversation.

import type { Model, State } from '../../core/state'
import { fillLines } from '../dialogs'
import { byEl, screenOf, setText } from '../dom'
import { renderStatic } from '../transcript'
import type { Screen } from './text'

type Crisis = Extract<State, { s: 'crisis' }>

export function crisisScreen(): Screen {
  const root = screenOf('crisis')
  return {
    // A new conversation after the crisis: the old one leaves the page with the screen.
    leave: () => byEl<HTMLOListElement>('crisis-talk', root).replaceChildren(),
    render(model: Model, entered: boolean) {
      if (!entered) return
      const { helplines, stale } = model.state as Crisis
      setText(byEl('crisis-lead', root), helplines.message)
      fillLines(byEl('crisis-lines', root), byEl('crisis-lines-block', root), helplines.lines)
      setText(byEl('crisis-abroad', root), helplines.abroadText)
      const details = byEl<HTMLDetailsElement>('crisis-details', root)
      details.open = false
      renderStatic(byEl<HTMLOListElement>('crisis-talk', root), stale, null)
    },
  }
}
