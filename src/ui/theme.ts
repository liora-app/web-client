// The colour theme (ADR-012): «Як у системі» (the default), «Світла», «Темна».
//
// - public/theme-init.js puts html[data-theme] before the first frame (a classic script first in
//   <head>; the CSP allows no inline one) and only reads. This module is the one writer of
//   liora:theme: 'light' | 'dark' after an explicit choice, the key removed for «Як у системі».
//   Nothing is written on a visit that does not choose.
// - Without data-theme the CSS follows prefers-color-scheme (tokens.css, stage.css).
// - html[data-theme-lock] pins a page to one theme: no choice is read or written there. No page uses
//   it now — the landing follows the theme like the chat (its dark side is its own night, landing.css).
// - A switch cross-fades for 240 ms through a View Transition when motion is allowed, otherwise it is
//   instant; CSS transitions are off for the switch itself, so no property eases on its own clock.
// - Every change of the resolved theme is published as window event 'liora:theme' (detail: 'light' |
//   'dark') for the WebGL light, which swaps uniforms instead of rebuilding its scene.

import { motionAllowed } from './motion'

export type ThemeChoice = 'system' | 'light' | 'dark'
export type Theme = 'light' | 'dark'

export const THEME_KEY = 'liora:theme'
export const THEME_EVENT = 'liora:theme'

type ThemeListener = (choice: ThemeChoice, theme: Theme) => void

const root = document.documentElement
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)')
const listeners = new Set<ThemeListener>()

/** Anything but 'light' or 'dark' is «Як у системі» (an old or hand-edited value included). */
export function parseTheme(value: unknown): ThemeChoice {
  return value === 'light' || value === 'dark' ? value : 'system'
}

/** The theme the page shows for a choice. */
export function resolveTheme(choice: ThemeChoice, systemDark: boolean): Theme {
  return choice === 'system' ? (systemDark ? 'dark' : 'light') : choice
}

function lockedTo(): Theme | null {
  const lock = root.dataset.themeLock
  return lock === 'light' || lock === 'dark' ? lock : null
}

function readStored(): ThemeChoice | null {
  try {
    return parseTheme(localStorage.getItem(THEME_KEY))
  } catch {
    return null
  }
}

function writeStored(choice: ThemeChoice): void {
  try {
    if (choice === 'system') localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, choice)
  } catch {
    // Blocked storage: the choice holds for this page view only.
  }
}

// The early script has already put the stored choice on <html>; the attribute is the answer even
// when storage is blocked now. If that script did not run, the stored choice still applies here.
let choice: ThemeChoice = lockedTo() ? 'system' : parseTheme(root.dataset.theme ?? readStored())

export function themeChoice(): ThemeChoice {
  return lockedTo() ? lockedTo()! : choice
}

/** Both themes need light-dark(): an engine without it (Safari < 17.5, as tokens.css says) gets only the
 *  dark one from the CSS (tokens.css, landing.css, stage.css fallbacks), whatever is chosen or
 *  stored and whatever the system prefers. */
export function themesSupported(): boolean {
  return typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('color', 'light-dark(#000, #fff)')
}

/** The theme the CSS renders — what the WebGL light (scene.ts, presence.ts) and the 'liora:theme'
 *  event follow. A lock comes first: the CSS fallbacks leave a locked page alone too. */
export function resolvedTheme(): Theme {
  return lockedTo() ?? (themesSupported() ? resolveTheme(choice, prefersDark.matches) : 'dark')
}

export function onThemeChange(listener: ThemeListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The one meta theme-color follows the page's computed background (already a resolved rgb()). */
function syncThemeColor(): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  const color = getComputedStyle(root).backgroundColor
  if (meta && color && meta.content !== color) meta.content = color
}

/** The page's background changed without a theme change (the chat's «В укритті» is dark in both
 *  themes and darkens the root while it is open): the browser's bar follows it. This module stays
 *  the meta's only writer. */
export function refreshThemeColor(): void {
  syncThemeColor()
}

function applyAttribute(): void {
  const lock = lockedTo()
  const value = lock ?? (choice === 'system' ? null : choice)
  if (value === null) delete root.dataset.theme
  else if (root.dataset.theme !== value) root.dataset.theme = value
}

function publish(): void {
  const theme = resolvedTheme()
  for (const listener of listeners) listener(themeChoice(), theme)
  window.dispatchEvent(new CustomEvent<Theme>(THEME_EVENT, { detail: theme }))
}

/** Applies the attribute with every CSS transition off, then lets them back on: the forced style
 *  flush between the two makes the new colours final before transitions return. */
function switchInstantly(): void {
  root.dataset.themeSwitching = ''
  applyAttribute()
  void document.body?.offsetHeight
  delete root.dataset.themeSwitching
  syncThemeColor()
}

/** The theme's cross-fade while it runs (setTheme), so a new screen can end it at once. */
let crossFade: ViewTransition | null = null

/** Ends a running theme cross-fade at once: a new screen — the crisis above all — comes in one
 *  frame, never through a View Transition. The new theme is already applied (or is applied now). */
export function skipThemeTransition(): void {
  crossFade?.skipTransition()
}

export function setTheme(next: ThemeChoice): void {
  if (lockedTo()) return
  const before = resolvedTheme()
  choice = next
  writeStored(next)
  const after = resolvedTheme()
  const animate =
    before !== after && motionAllowed() && !document.hidden && typeof document.startViewTransition === 'function'
  // The controls and the WebGL light hear of the new theme only once it is on <html>: during a
  // cross-fade that is after the old frame was captured, so the old snapshot keeps the old colours.
  let committed = false
  const commit = (): void => {
    if (committed) return
    committed = true
    switchInstantly()
    publish()
  }
  if (!animate) {
    commit()
    return
  }
  try {
    const transition = document.startViewTransition(commit)
    crossFade = transition
    const clear = (): void => {
      if (crossFade === transition) crossFade = null
    }
    // A transition skipped or refused (a hidden tab, another one starting) rejects these: the update
    // still runs (or runs here), so the theme is right either way.
    transition.ready.catch(() => {})
    transition.updateCallbackDone.catch(commit)
    transition.finished.then(clear, clear)
  } catch {
    commit()
  }
}

let started = false

/** Once per page: puts the stored choice on <html> if the early script could not, sets the
 *  theme-color and follows the system while the choice is «Як у системі». */
export function initTheme(): void {
  if (started) return
  started = true
  applyAttribute()
  syncThemeColor()
  prefersDark.addEventListener('change', () => {
    if (lockedTo() || choice !== 'system') return
    syncThemeColor()
    publish()
  })
}
