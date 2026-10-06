// «Звук»: an optional generative pad (sound-engine.ts, loaded on the first press). Off on every
// visit, never remembered. The AudioContext is created inside that click: browsers allow audio
// only after a gesture, Safari only within it. Silent by the crisis contacts (data-gl-quiet), while
// the visitor has paused the page and in a hidden tab — and only those: the OS reduced-motion
// setting alone does not mute it, the visitor asked for sound.
// <html data-sound="off|on|muted"> shows the state (tests, CSS).

import { onMotionChange, userPaused } from './motion'
import type { Pad } from './sound-engine'

export function initSound(): void {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-sound-toggle]'))
  const AudioContextClass = window.AudioContext as typeof AudioContext | undefined
  if (buttons.length === 0 || !AudioContextClass) return

  const root = document.documentElement
  let context: AudioContext | null = null
  let pad: Pad | null = null
  let wanted = false
  let mood = 0
  let crisis = false

  const render = (): void => {
    const muted = crisis || userPaused() || document.hidden
    root.dataset.sound = !wanted ? 'off' : muted ? 'muted' : 'on'
    for (const button of buttons) button.setAttribute('aria-pressed', String(wanted))
    pad?.setMood(mood)
    pad?.setLevel(wanted && !muted ? 1 : 0)
  }

  for (const button of buttons) {
    button.hidden = false
    button.addEventListener('click', () => {
      wanted = !wanted
      if (wanted && !context) {
        context = new AudioContextClass()
        const started = context
        void import('./sound-engine').then(({ startPad }) => {
          pad = startPad(started)
          render()
        })
      }
      render()
    })
  }

  // Which chapter holds the middle of the viewport: its scene state sets the chord, and the crisis
  // chapter (data-gl-quiet) silences the pad. Plain DOM, so it works with the scene off too.
  const watched = Array.from(document.querySelectorAll<HTMLElement>('[data-gl-state], [data-gl-quiet]'))
  if (watched.length > 0 && 'IntersectionObserver' in window) {
    const inMiddle = new Set<HTMLElement>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const element = entry.target as HTMLElement
          if (entry.isIntersecting) inMiddle.add(element)
          else inMiddle.delete(element)
        }
        crisis = [...inMiddle].some((element) => element.hasAttribute('data-gl-quiet'))
        const states = [...inMiddle].filter((element) => element.dataset.glState !== undefined)
        if (states.length > 0) mood = Number(states[states.length - 1].dataset.glState) || 0
        render()
      },
      { rootMargin: '-50% 0px -50% 0px', threshold: 0 },
    )
    for (const element of watched) observer.observe(element)
  }

  onMotionChange(() => render())
  document.addEventListener('visibilitychange', render)
  render()
}
