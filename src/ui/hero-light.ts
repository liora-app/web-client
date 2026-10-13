// Where the hero light stands. On wide layouts it sits beside the end of the title lines and never on
// them: the title lies under the WebGL canvas, and light over its glyphs would take their contrast
// away (WCAG 1.4.3). On one column it sits between the header and the title. The result goes to
// .hero as --light-x / --light-y / --light-d (CSS px; x from the viewport's left, y from the top of
// the page), so the static orb (sections.css) and the WebGL light (src/gl/scene.ts) stand in the
// same place and switching between them does not jump.

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

const GAP = 28 // CSS px between the end of the title and the glass, with room for the pointer parallax
const HEADER = 88 // var(--header-offset)

let current: HeroLight | null = null
const listeners = new Set<() => void>()

export function heroLight(): HeroLight | null {
  return current
}

export function onHeroLightChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// The glyph runs of the title lines. Each line is a block span, so the rect of the element would be
// the whole frame width; a range over its contents gives the text itself.
function titleBox(): { right: number; top: number } | null {
  const lines = Array.from(document.querySelectorAll('.hero__title .display__line'))
  if (lines.length === 0) return null
  const range = document.createRange()
  let right = -Infinity
  let top = Infinity
  for (const line of lines) {
    range.selectNodeContents(line)
    const rect = range.getBoundingClientRect()
    if (rect.width === 0) continue
    right = Math.max(right, rect.right)
    top = Math.min(top, rect.top + window.scrollY)
  }
  return Number.isFinite(right) ? { right, top } : null
}

function measure(): HeroLight | null {
  const title = titleBox()
  if (!title) return null
  const w = document.documentElement.clientWidth
  const h = window.innerHeight
  if (WIDE_LAYOUT.matches) {
    // A larger hero object, fitted into the remaining lane after the actual glyphs.
    const base = Math.min(0.3 * h, 0.22 * w)
    const gutter = Math.min(88, Math.max(24, 0.055 * w))
    const room = w - gutter - (title.right + GAP)
    const r = Math.max(1, Math.min(base, room * 0.43))
    const x = title.right + GAP + room / 2
    return { x, y: h * 0.47, d: 2 * r }
  }
  // One column: centred above the title, below the header; smaller on short screens.
  const base = Math.min(110, 0.2451 * w)
  const bottom = title.top - 20
  const r = Math.max(1, Math.min(base, (bottom - HEADER - 52) / 2))
  const y = bottom - r
  return { x: w / 2, y, d: 2 * r }
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
  // The title changes size when the font arrives, with zoom and with the window.
  const title = document.querySelector('.hero__title')
  if (title && 'ResizeObserver' in window) new ResizeObserver(schedule).observe(title)
  window.addEventListener('resize', schedule, { passive: true })
  WIDE_LAYOUT.addEventListener('change', schedule)
  void document.fonts?.ready.then(schedule)
}
