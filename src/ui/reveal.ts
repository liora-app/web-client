// Fades sections' content in as they enter the viewport. Content is visible by default
// (no-JS, reduced motion, motion paused), and the hidden start state (html.js-reveal) comes only with
// the observer's first answer: if it never answers, nothing waits for it. What is on screen at that
// moment stays as it is — only what is still below the fold waits for the scroll.

export function initReveal(): void {
  const items = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'))
  if (items.length === 0 || !('IntersectionObserver' in window)) return

  const root = document.documentElement
  const show = (element: Element): void => {
    element.classList.add('is-visible')
    observer.unobserve(element)
  }
  const observer = new IntersectionObserver(
    (entries) => {
      const first = !root.classList.contains('js-reveal')
      for (const entry of entries) {
        const box = entry.boundingClientRect
        const onScreen = box.bottom > 0 && box.top < window.innerHeight
        if (entry.isIntersecting || (first && onScreen)) show(entry.target)
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

  // Keyboard focus must never land in a hidden or fading block (WCAG 2.4.7): show it at once.
  document.addEventListener('focusin', (event) => {
    const host = event.target instanceof Element ? event.target.closest('[data-reveal]') : null
    if (!host || host.classList.contains('is-visible')) return
    show(host)
  })
}
