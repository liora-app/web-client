// Header behaviour: marks the chapter in the middle of the viewport (aria-current on its link),
// drives the decorative chapter HUD and passes the scroll progress to the CSS sky (--progress, the
// drifting lights of landing.css; data-quiet on the stage beside the crisis contacts).

import { decodeTo } from './decode'

export function initNav(): void {
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('[data-nav-link]'))
  const chapters = Array.from(document.querySelectorAll<HTMLElement>('[data-chapter]'))
  const stage = document.querySelector<HTMLElement>('[data-stage]')
  const hudIndex = document.querySelector<HTMLElement>('[data-hud-index]')
  const hudName = document.querySelector<HTMLElement>('[data-hud-name]')
  let current: HTMLElement | null = null

  const setCurrent = (chapter: HTMLElement): void => {
    if (chapter === current) return
    current = chapter
    for (const link of links) {
      if (link.hash === `#${chapter.id}`) link.setAttribute('aria-current', 'location')
      else link.removeAttribute('aria-current')
    }
    if (hudIndex) hudIndex.textContent = chapter.dataset.chapter ?? ''
    // The sky's drifting lights (landing.css) go out while the crisis contacts are read (ADR-011).
    stage?.toggleAttribute('data-quiet', chapter.hasAttribute('data-gl-quiet'))
    const name = chapter.dataset.chapterName ?? ''
    if (hudName) {
      // The crisis chapter is read in silence (data-gl-quiet, see gl/scroll.ts): no decode in the HUD either.
      if (chapter.hasAttribute('data-gl-quiet')) hudName.textContent = name
      else decodeTo(hudName, name)
    }
  }

  if (chapters.length > 0 && 'IntersectionObserver' in window) {
    // The chapter that crosses the middle line of the viewport is the current one.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setCurrent(entry.target as HTMLElement)
        }
      },
      { rootMargin: '-50% 0px -50% 0px', threshold: 0 },
    )
    for (const chapter of chapters) observer.observe(chapter)
  }

  let ticking = false
  const update = (): void => {
    ticking = false
    const max = document.documentElement.scrollHeight - window.innerHeight
    const ratio = max > 0 ? Math.min(1, window.scrollY / max) : 0
    stage?.style.setProperty('--progress', ratio.toFixed(4))
  }
  window.addEventListener(
    'scroll',
    () => {
      if (ticking) return
      ticking = true
      window.requestAnimationFrame(update)
    },
    { passive: true },
  )
  window.addEventListener('resize', update, { passive: true })
  update()
}
