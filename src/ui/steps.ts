// "How it works": the example session next to the steps follows the step in the middle of the
// viewport. Purely visual — every step's text is in the list itself, the example is illustration.

export function initSteps(): void {
  const transcript = document.querySelector<HTMLElement>('[data-transcript]')
  const steps = Array.from(document.querySelectorAll<HTMLElement>('[data-step]'))
  if (!transcript || steps.length === 0 || !('IntersectionObserver' in window)) return
  transcript.closest('.how__layout')?.setAttribute('data-js', '')

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const step = (entry.target as HTMLElement).dataset.step
        if (step) transcript.dataset.activeStep = step
        for (const item of steps) item.toggleAttribute('data-current', item === entry.target)
      }
    },
    // A thin band across the middle of the viewport decides which step is current.
    { rootMargin: '-45% 0px -45% 0px', threshold: 0 },
  )
  for (const step of steps) observer.observe(step)
}
