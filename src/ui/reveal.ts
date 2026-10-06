// Fades sections' content in as they enter the viewport. Content is visible by default
// (no-JS, reduced motion, motion paused); the hidden start state only applies once this runs.

export function initReveal(): void {
  const items = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'))
  if (items.length === 0 || !('IntersectionObserver' in window)) return

  document.documentElement.classList.add('js-reveal')
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        entry.target.classList.add('is-visible')
        observer.unobserve(entry.target)
      }
    },
    { rootMargin: '0px 0px -12% 0px', threshold: 0.08 },
  )
  for (const item of items) observer.observe(item)

  // Keyboard focus must never land in a hidden or fading block (WCAG 2.4.7): show it at once.
  document.addEventListener('focusin', (event) => {
    const host = event.target instanceof Element ? event.target.closest('[data-reveal]') : null
    if (!host || host.classList.contains('is-visible')) return
    host.classList.add('is-visible')
    observer.unobserve(host)
  })
}
