// The controls of the theme (src/ui/theme.ts): a button in the header of both pages that opens a
// small menu of three menuitemradio items (plain buttons: the landing has no inputs), and a radio
// group in the chat's «Акаунт» sheet. Both show the same choice and change it through setTheme only.
//
// The menu button follows the WAI-ARIA APG menu button: Enter, Space or ↓ open it on the chosen
// item (↑ on the last), ↑ ↓ Home End move, Enter or Space choose and close, Esc closes and gives the
// focus back to the button, Tab closes and moves on, a click outside closes it. Without JS (or
// without light-dark(), where only the dark theme exists) the button stays hidden.

import { initTheme, onThemeChange, setTheme, themeChoice, parseTheme, type ThemeChoice } from './theme'

const LABEL: Readonly<Record<ThemeChoice, string>> = {
  system: 'як у системі',
  light: 'світла',
  dark: 'темна',
}

export interface ThemePicker {
  /** Closes the menu without moving the focus (a new screen takes it, the crisis above all). */
  close(): void
}

export function themesSupported(): boolean {
  return typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('color', 'light-dark(#000, #fff)')
}

export function initThemePicker(options: { root: HTMLElement | null; radios: HTMLElement | null }): ThemePicker {
  initTheme()
  const supported = themesSupported()
  const root = options.root
  const button = root?.querySelector<HTMLButtonElement>('[data-theme-toggle]') ?? null
  const menu = root?.querySelector<HTMLElement>('[data-theme-menu]') ?? null
  const items = menu ? Array.from(menu.querySelectorAll<HTMLButtonElement>('[data-theme-choice]')) : []
  const group = options.radios
  const radios = group ? Array.from(group.querySelectorAll<HTMLInputElement>('input[type="radio"]')) : []

  const sync = (): void => {
    const choice = themeChoice()
    if (button) {
      button.dataset.choice = choice
      button.setAttribute('aria-label', `Вигляд: ${LABEL[choice]}`)
    }
    for (const item of items) {
      const on = parseTheme(item.dataset.themeChoice) === choice
      item.setAttribute('aria-checked', String(on))
    }
    for (const radio of radios) {
      const on = parseTheme(radio.value) === choice
      if (radio.checked !== on) radio.checked = on
      radio.closest('label')?.classList.toggle('pill--on', on)
    }
  }

  const isOpen = (): boolean => menu !== null && !menu.hidden

  const close = (returnFocus: boolean): void => {
    if (!menu || !button || menu.hidden) return
    menu.hidden = true
    button.setAttribute('aria-expanded', 'false')
    document.removeEventListener('pointerdown', onOutside, true)
    if (returnFocus) button.focus()
  }

  const focusItem = (index: number): void => {
    if (items.length === 0) return
    const i = (index + items.length) % items.length
    items.forEach((item, n) => (item.tabIndex = n === i ? 0 : -1))
    items[i]!.focus()
  }

  const open = (at: 'chosen' | 'last'): void => {
    if (!menu || !button) return
    if (!isOpen()) {
      menu.hidden = false
      button.setAttribute('aria-expanded', 'true')
      document.addEventListener('pointerdown', onOutside, true)
    }
    const chosen = items.findIndex((item) => item.getAttribute('aria-checked') === 'true')
    focusItem(at === 'last' ? items.length - 1 : Math.max(0, chosen))
  }

  function onOutside(event: Event): void {
    if (root && event.target instanceof Node && root.contains(event.target)) return
    close(false)
  }

  const choose = (item: HTMLButtonElement): void => {
    setTheme(parseTheme(item.dataset.themeChoice))
    close(true)
  }

  if (supported && root && button && menu) {
    root.hidden = false
    button.addEventListener('click', () => (isOpen() ? close(true) : open('chosen')))
    button.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        open(event.key === 'ArrowUp' ? 'last' : 'chosen')
      }
    })
    menu.addEventListener('click', (event) => {
      const item = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-theme-choice]') : null
      if (item) choose(item)
    })
    menu.addEventListener('keydown', (event) => {
      const at = items.indexOf(document.activeElement as HTMLButtonElement)
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault()
          return focusItem(at + 1)
        case 'ArrowUp':
          event.preventDefault()
          return focusItem(at - 1)
        case 'Home':
          event.preventDefault()
          return focusItem(0)
        case 'End':
          event.preventDefault()
          return focusItem(items.length - 1)
        case 'Escape':
          event.preventDefault()
          event.stopPropagation()
          return close(true)
        case 'Tab':
          return close(false)
      }
    })
    // Focus moved somewhere else on the page (a screen taking it, say) closes it. A tap that only
    // blurs (iOS does not focus a tapped button) is left to the click and the outside pointer.
    root.addEventListener('focusout', (event) => {
      const next = event.relatedTarget
      if (isOpen() && next instanceof Node && !root.contains(next)) close(false)
    })
  }

  if (supported && group) {
    group.addEventListener('change', (event) => {
      const radio = event.target
      if (!(radio instanceof HTMLInputElement) || radio.type !== 'radio' || !radio.checked) return
      setTheme(parseTheme(radio.value))
    })
  } else if (group) {
    // Only the dark theme exists in this browser: no choice to offer.
    group.hidden = true
  }

  onThemeChange(sync)
  sync()

  return { close: () => close(false) }
}
