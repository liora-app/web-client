// Motion preference: the OS setting (prefers-reduced-motion) is the default of html[data-motion],
// the on-page toggle overrides it for this browser (WCAG 2.2.2 Pause, Stop, Hide).
// The toggle keeps one accessible name ("Пауза анімації"); aria-pressed="true" = paused.
//
// What an explicit «Увімкнути анімацію» turns on under prefers-reduced-motion: reduce is the WebGL
// light (gl/core/boot.ts, motionAllowed) — the visitor asked for it. Every other movement of the page
// stays still under reduce, as ADR-012 §3 has it ("лише під html[data-motion='on'] і без
// prefers-reduced-motion: reduce"): the CSS by base.css's reduce rule, the JS motion the CSS cannot
// reach (a View Transition, Element.animate(), a smooth scroll asked for in JS) by decorativeMotion().

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

/** The JS side of the CSS rule for motion (html[data-motion='on'] and no prefers-reduced-motion:
 *  reduce): the theme's cross-fade, the first message's glide, the send anchor's smooth scroll. The
 *  stored «on» does not override the OS here — base.css stills the CSS under reduce whatever
 *  data-motion says, and these would move alone. */
export function decorativeMotion(): boolean {
  return motionAllowed() && !reduceQuery.matches
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
