// The on-screen keyboard (spec §3.1 «Екранна клавіатура»).
//
// Android Chrome takes interactive-widget=resizes-content from the viewport meta and shrinks the
// layout viewport, so the sticky composer stays above the keyboard by itself. iOS Safari ignores
// that key: the layout viewport keeps its height, the keyboard covers its bottom, and `bottom: 0`
// would put the composer under it. So, from visualViewport:
//
// - html[data-kb] while a text field has focus, the pointer is coarse and the visual viewport is at
//   least 150 px shorter than when the field took focus. It goes on focusout (to something that is
//   not a text field) or when the height comes back (the keyboard was put away, focus kept).
// - While it is on: --kb = max(0, innerHeight − visualViewport.height − visualViewport.offsetTop)
//   (≈ 0 on Android, the keyboard's height on iOS) for the composer's `bottom`, and --vvh = the
//   visual viewport's height for the record picker's sheet. Both are removed when it goes off, so a
//   pinch zoom without a keyboard never moves the composer.
// - chat.css does the rest under html[data-kb] (and the same under max-height: 30em, a phone on its
//   side): the header and the session row scroll with the page, only the mono line stays under the
//   field, the composer's bottom padding loses the safe area and its fade is 12 px.

/** How much shorter the visual viewport must get to count as a keyboard (spec: 150 px). */
export const KEYBOARD_DROP = 150

/** The part of the layout viewport the keyboard covers (the composer's `bottom`). */
export function keyboardInset(innerHeight: number, viewportHeight: number, offsetTop: number): number {
  return Math.max(0, Math.round(innerHeight - viewportHeight - offsetTop))
}

/** The keyboard is up: the visual viewport lost at least KEYBOARD_DROP since the field took focus. */
export function keyboardShown(heightAtFocus: number, viewportHeight: number): boolean {
  return heightAtFocus - viewportHeight >= KEYBOARD_DROP
}

const TEXT_INPUTS = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number'])

function isTextField(node: Element | null): boolean {
  if (node instanceof HTMLTextAreaElement) return !node.readOnly
  if (node instanceof HTMLInputElement) return TEXT_INPUTS.has(node.type) && !node.readOnly
  return node instanceof HTMLElement && node.isContentEditable
}

export function initKeyboard(): void {
  const viewport = window.visualViewport
  if (!viewport) return
  const root = document.documentElement
  const coarse = window.matchMedia('(pointer: coarse)')
  // The visual viewport's height when a text field took focus (before the keyboard came up).
  let heightAtFocus: number | null = null
  let open = false
  let pending = 0

  const update = (): void => {
    pending = 0
    const typing = coarse.matches && isTextField(document.activeElement)
    if (!typing) heightAtFocus = null
    else if (heightAtFocus === null) heightAtFocus = viewport.height
    const next = typing && heightAtFocus !== null && keyboardShown(heightAtFocus, viewport.height)
    if (next !== open) {
      open = next
      if (open) root.dataset.kb = ''
      else delete root.dataset.kb
    }
    if (open) {
      root.style.setProperty('--kb', `${keyboardInset(window.innerHeight, viewport.height, viewport.offsetTop)}px`)
      root.style.setProperty('--vvh', `${Math.round(viewport.height)}px`)
    } else {
      root.style.removeProperty('--kb')
      root.style.removeProperty('--vvh')
    }
  }

  // Focus moving from one field to the next passes through focusout: look once it has settled,
  // so the height measured before the keyboard came up is kept.
  const later = (): void => {
    if (pending === 0) pending = window.setTimeout(update, 0)
  }

  document.addEventListener('focusin', update)
  document.addEventListener('focusout', later)
  viewport.addEventListener('resize', update)
  viewport.addEventListener('scroll', update)
  coarse.addEventListener('change', update)
  update()
}
