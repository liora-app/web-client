// Motion preference: the OS setting (prefers-reduced-motion) is the default,
// the on-page toggle overrides it for this browser (WCAG 2.2.2 Pause, Stop, Hide).
// The toggle keeps one accessible name ("Пауза анімації"); aria-pressed="true" = paused.

type MotionListener = (allowed: boolean) => void

const STORAGE_KEY = 'liora:motion'
const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
const listeners = new Set<MotionListener>()

function readStoredPreference(): 'on' | 'off' | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    return value === 'on' || value === 'off' ? value : null
  } catch {
    return null
  }
}

function storePreference(value: 'on' | 'off'): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value)
  } catch {
    // Private mode or blocked storage: the choice simply lasts for this page view.
  }
}

let userPreference = readStoredPreference()

export function systemReducesMotion(): boolean {
  return reduceQuery.matches
}

/** The visitor pressed «Пауза» (not just the OS setting): everything that moves or sounds stops. */
export function userPaused(): boolean {
  return userPreference === 'off'
}

export function motionAllowed(): boolean {
  return userPreference ? userPreference === 'on' : !reduceQuery.matches
}

export function onMotionChange(listener: MotionListener): void {
  listeners.add(listener)
}

export function initMotionToggle(button: HTMLButtonElement | null): void {
  const render = (): void => {
    const allowed = motionAllowed()
    document.documentElement.dataset.motion = allowed ? 'on' : 'off'
    button?.setAttribute('aria-pressed', String(!allowed))
  }

  const notify = (): void => {
    const allowed = motionAllowed()
    for (const listener of listeners) listener(allowed)
  }

  if (button) {
    button.hidden = false
    button.addEventListener('click', () => {
      userPreference = motionAllowed() ? 'off' : 'on'
      storePreference(userPreference)
      render()
      notify()
    })
  }

  reduceQuery.addEventListener('change', () => {
    if (userPreference) return
    render()
    notify()
  })

  render()
}
