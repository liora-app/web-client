// Fades sections' content in as they enter the viewport. Content is visible by default
// (no-JS, reduced motion, motion paused), and the hidden start state (html.js-reveal) comes only with
// the observer's first answer: if it never answers, nothing waits for it. What is on screen at that
// moment stays as it is — only what is still below the fold waits for the scroll — and wherever the
// scroll comes to rest, what is on screen is shown.

export function initReveal(): void {
  // #mind's copy unfolds with the scroll where scroll-driven animations exist (landing.css); elsewhere
  // its steps come in here, one after another. Never both on one element.
  if (!CSS.supports?.('animation-timeline', 'view()')) {
    for (const step of Array.from(document.querySelectorAll<HTMLElement>('[data-mind-step]'))) step.dataset.reveal = 'mind'
  }
  const items = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'))
  if (items.length === 0 || !('IntersectionObserver' in window)) return

  const root = document.documentElement
  const pending = new Set<Element>(items)
  const onScreen = (element: Element): boolean => {
    const box = element.getBoundingClientRect()
    return box.bottom > 0 && box.top < window.innerHeight && box.width > 0
  }
  const show = (element: Element): void => {
    element.classList.add('is-visible')
    observer.unobserve(element)
    pending.delete(element)
  }
  const observer = new IntersectionObserver(
    (entries) => {
      const first = !root.classList.contains('js-reveal')
      for (const entry of entries) {
        const box = entry.boundingClientRect
        const visible = box.bottom > 0 && box.top < window.innerHeight
        if (entry.isIntersecting || (first && visible)) show(entry.target)
      }
      if (first) {
        // The start state in one frame, transitions off (components.css): what waits below the fold
        // does not fade out on its way there. The forced style flush makes it final before they return.
        root.classList.add('js-reveal-start', 'js-reveal')
        void root.offsetHeight
        root.classList.remove('js-reveal-start')
      }
    },
    { rootMargin: '0px 0px -12% 0px', threshold: 0.08 },
  )
  for (const item of items) observer.observe(item)

  // Where the scroll comes to rest, whatever is on screen is shown. The observer's root ends 12 %
  // above the bottom edge, so a block whose top stops in that band would stay blank where the reader
  // looks: a deep link (/#faq — the first answer comes before the fragment's scroll), a find-in-page
  // match that needs no scroll, a stop with a row at the bottom edge. Nothing below the fold changes.
  let timer = 0
  const rest = (): void => {
    window.clearTimeout(timer)
    if (!root.classList.contains('js-reveal')) return
    for (const item of Array.from(pending)) if (onScreen(item)) show(item)
    if (pending.size === 0) {
      window.removeEventListener('scroll', soon)
      window.removeEventListener('scrollend', rest)
    }
  }
  const soon = (): void => {
    window.clearTimeout(timer)
    timer = window.setTimeout(rest, 150)
  }
  // scrollend where it exists; the debounce for the engines without it (and as a backstop).
  window.addEventListener('scroll', soon, { passive: true })
  window.addEventListener('scrollend', rest)

  // Keyboard focus must never land in a hidden or fading block (WCAG 2.4.7): show it at once.
  document.addEventListener('focusin', (event) => {
    const host = event.target instanceof Element ? event.target.closest('[data-reveal]') : null
    if (!host || host.classList.contains('is-visible')) return
    show(host)
  })
}
