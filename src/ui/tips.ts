// The small labels under the header's round buttons — «Пауза анімації», «Увімкнути звук», «Вигляд»:
// a CSS ::after shown on hover and on keyboard focus (layout.css). The button's accessible name is
// its own aria-label; the label is for the eye. WCAG 1.4.13 «Content on Hover or Focus»:
// - dismissible: Esc hides the label of the button under the pointer or with the focus, moving
//   neither (data-tip="off"); it comes back once the pointer and the keyboard focus have left it;
// - hoverable: while it is shown, on a device that hovers, the label and the gap above it take the
//   pointer (layout.css), so moving onto the label keeps the button hovered;
// - persistent: nothing else hides it.

const TIPPED = '.media__button, .theme-toggle, .character-toggle'

/** Hides the label of this button until the pointer and the keyboard focus have both left it. */
export function hideTip(button: HTMLElement): void {
  button.dataset.tip = 'off'
}

function showAgain(button: HTMLElement): void {
  if (button.dataset.tip !== undefined) delete button.dataset.tip
}

let wired = false

export function initTips(): void {
  if (wired) return
  wired = true
  // On the document: with the pointer alone on a button, Esc goes to whatever has the focus. A
  // handler that took Esc for itself (the «Вигляд» menu closing) calls hideTip() on its own.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing) return
    for (const button of Array.from(document.querySelectorAll<HTMLElement>(TIPPED))) {
      if (button.matches(':hover, :focus-visible')) hideTip(button)
    }
  })
  for (const button of Array.from(document.querySelectorAll<HTMLElement>(TIPPED))) {
    button.addEventListener('pointerleave', () => {
      if (!button.matches(':focus-visible')) showAgain(button)
    })
    button.addEventListener('blur', () => {
      if (!button.matches(':hover')) showAgain(button)
    })
  }
}
