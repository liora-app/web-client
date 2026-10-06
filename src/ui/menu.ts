// The chapter menu for narrow screens: a native modal <dialog> (focus trap, Esc and the inert page
// come from the browser). The button that opens it stays hidden without JS; the page is complete
// without the menu, it only saves scrolling.

export function initMenu(): void {
  const dialog = document.querySelector<HTMLDialogElement>('[data-menu]')
  const opener = document.querySelector<HTMLButtonElement>('[data-menu-open]')
  if (!dialog || !opener || typeof dialog.showModal !== 'function') return

  // Following a link moves focus to its chapter; only Esc and «Закрити» hand it back to the button.
  let toChapter = false

  opener.hidden = false
  opener.addEventListener('click', () => {
    toChapter = false
    dialog.showModal()
    opener.setAttribute('aria-expanded', 'true')
  })

  dialog.querySelector<HTMLButtonElement>('[data-menu-close]')?.addEventListener('click', () => dialog.close())

  // Close before the link is followed: an open modal keeps the page inert, so the jump would land
  // behind it.
  for (const link of dialog.querySelectorAll<HTMLAnchorElement>('[data-menu-link]')) {
    link.addEventListener('click', () => {
      toChapter = true
      dialog.close()
    })
  }

  // A click on the backdrop (outside the panel) closes the menu, like Esc.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      const box = dialog.getBoundingClientRect()
      const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom
      if (!inside) dialog.close()
    }
  })

  dialog.addEventListener('close', () => {
    opener.setAttribute('aria-expanded', 'false')
    if (!toChapter) opener.focus()
  })

  // Widening the window past the menu's breakpoint leaves no button to come back to: close it.
  const wide = window.matchMedia('(min-width: 64em)')
  wide.addEventListener('change', () => {
    if (wide.matches && dialog.open) dialog.close()
  })
}
