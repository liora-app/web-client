// The crisis takeover (spec §6). 112 and 103 are constants in chat/index.html; from the payload
// only the sanitized fields reach the page (core/helplines.ts): the lead, the support lines and the
// text about other countries. The conversation is read-only, under the contacts, in <details>.
// There is no way back into it — only a new, empty conversation.

import type { Model, State } from '../../core/state'
import { fillLines } from '../dialogs'
import { byEl, screenOf, setText, show } from '../dom'
import { renderStatic } from '../transcript'
import type { Screen } from './text'

type Crisis = Extract<State, { s: 'crisis' }>

export function crisisScreen(): Screen {
  const root = screenOf('crisis')
  const details = byEl<HTMLDetailsElement>('crisis-details', root)
  const talk = byEl<HTMLOListElement>('crisis-talk', root)
  let shown: Crisis['stale'] | null = null
  return {
    // A new conversation after the crisis: the old one leaves the page with the screen.
    leave() {
      talk.replaceChildren()
      shown = null
    },
    render(model: Model, entered: boolean) {
      const { helplines, stale } = model.state as Crisis
      if (entered) {
        setText(byEl('crisis-lead', root), helplines.message)
        fillLines(byEl('crisis-lines', root), byEl('crisis-lines-block', root), helplines.lines)
        setText(byEl('crisis-abroad', root), helplines.abroadText)
        details.open = false
      }
      // pagehide empties it (page/left): the contacts stay, the conversation does not wait in the
      // bfcache.
      if (entered || stale !== shown) {
        shown = stale
        renderStatic(talk, stale, null)
        show(details, stale.length > 0)
      }
    },
  }
}
