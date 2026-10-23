// Where the hero light stands: in the slot between the title's halves («Менше шуму.» · the presence ·
// «Більше себе.», ADR-013). The slot is an empty, aria-hidden part of the title with a column (on one
// column, a row) of its own and a gap of at least 16 px to the glyphs on either side: the title lies
// under the WebGL canvas, and light over its glyphs would take their contrast away (WCAG 1.4.3). The
// result goes to .hero as --light-x / --light-y / --light-d (CSS px; x from the viewport's left, y from
// the top of the page), so the static orb (sections.css), the day's sun in the hero's sky
// (landing.css) and the WebGL light (src/gl/scene.ts) stand in the same place and switching between
// them does not jump.

export interface HeroLight {
  /** Centre, CSS px from the left edge of the viewport. */
  x: number
  /** Centre, CSS px from the top of the page (the hero starts at 0). */
  y: number
  /** Diameter of the glass, CSS px. */
  d: number
}

/** Two text columns from here on: the same breakpoint as the CSS (sections.css, layout.css). */
export const WIDE_LAYOUT = window.matchMedia('(min-width: 64em)')

let current: HeroLight | null = null
const listeners = new Set<() => void>()

export function heroLight(): HeroLight | null {
  return current
}

export function onHeroLightChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const REM = (): number => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16

function measure(): HeroLight | null {
  const slot = document.querySelector<HTMLElement>('[data-hero-slot]')
  if (!slot) return null
  const box = slot.getBoundingClientRect()
  if (box.width === 0 || box.height === 0) return null
  const w = document.documentElement.clientWidth
  // The CSS sizes of the slot (landing.css): clamp(240px, 25vw, 360px) beside the halves,
  // min(62vw, 15rem) between them on one column.
  const cap = WIDE_LAYOUT.matches ? Math.min(360, Math.max(240, 0.25 * w)) : Math.min(0.62 * w, 15 * REM())
  const d = Math.max(1, Math.min(box.width, box.height, cap))
  return { x: box.left + box.width / 2, y: box.top + window.scrollY + box.height / 2, d }
}

function update(): void {
  const next = measure()
  if (!next) return
  const same = current && Math.abs(current.x - next.x) < 0.5 && Math.abs(current.y - next.y) < 0.5 && Math.abs(current.d - next.d) < 0.5
  if (same) return
  current = next
  const hero = document.querySelector<HTMLElement>('.hero')
  hero?.style.setProperty('--light-x', `${next.x.toFixed(1)}px`)
  hero?.style.setProperty('--light-y', `${next.y.toFixed(1)}px`)
  hero?.style.setProperty('--light-d', `${next.d.toFixed(1)}px`)
  for (const listener of listeners) listener()
}

export function initHeroLight(): void {
  update()
  let queued = false
  const schedule = (): void => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      update()
    })
  }
  // The title (and with it the slot) changes size when the font arrives, with zoom and with the window.
  const title = document.querySelector('.hero__title')
  if (title && 'ResizeObserver' in window) new ResizeObserver(schedule).observe(title)
  window.addEventListener('resize', schedule, { passive: true })
  WIDE_LAYOUT.addEventListener('change', schedule)
  void document.fonts?.ready.then(schedule)
}
