// The hero's entrance on load: a short cascade (landing.css, html.js-intro) — the headline by opacity
// alone, the lead and the links rising 8 px, all within 600 ms. Only when motion is allowed and the
// page has not been painted yet: if the browser already showed the hero before this module ran, the
// text stays as it is instead of vanishing to come in again. The class goes once the cascade is over,
// so a later «Пауза» and play never replays it.

import { motionAllowed } from './motion'

const CASCADE_MS = 600

export function initIntro(): void {
  if (!motionAllowed() || document.visibilityState !== 'visible') return
  const painted = typeof performance.getEntriesByType === 'function' && performance.getEntriesByType('paint').length > 0
  if (painted) return
  const root = document.documentElement
  root.classList.add('js-intro')
  window.setTimeout(() => root.classList.remove('js-intro'), CASCADE_MS + 100)
}
