import './styles/fonts.css'
import './styles/tokens.css'
import './styles/base.css'
import './styles/stage.css'
import './styles/layout.css'
import './styles/components.css'
import './styles/sections.css'
import './styles/landing.css'
import './styles/mascot.css'
import './styles/mascot-layers.css'

import { bootGL } from './gl/core/boot'
import { initDecode } from './ui/decode'
import { initHeroLight } from './ui/hero-light'
import { initMascots } from './ui/mascot'
import { initIntro } from './ui/intro'
import { initMenu } from './ui/menu'
import { initMotionToggle } from './ui/motion'
import { initNav } from './ui/nav'
import { initReveal } from './ui/reveal'
import { initSound } from './ui/sound'
import { initThemePicker } from './ui/theme-picker'
import { initTips } from './ui/tips'

// A sign-in error that came back to "/" belongs to the chat (ADR-007): without the flow cookie the
// server does not know `next` yet and sends the person here. Only known codes travel on (the same
// list as AUTH_CODES in src/chat/core/state.ts, kept here so the landing loads no chat code); the
// chat shows the message. Nothing is asked of the API.
const AUTH_ERRORS = new Set(['access_denied', 'state_mismatch', 'expired', 'not_invited', 'server_error', 'auth_unavailable'])
const authError = new URLSearchParams(location.search).get('auth_error')

if (authError !== null) {
  location.replace(`/chat/?auth_error=${AUTH_ERRORS.has(authError) ? authError : 'unknown'}`)
} else {
  // The theme is on <html> before the first frame (public/theme-init.js); this wires «Вигляд» in the
  // header (the chat's control, src/ui/theme.ts the one writer) and keeps the page in step with it.
  initThemePicker({ root: document.querySelector<HTMLElement>('[data-theme-pick]'), radios: null })
  initHeroLight()
  initMascots()
  initMotionToggle(document.querySelector<HTMLButtonElement>('[data-motion-toggle]'))
  initTips()
  // Right after the motion choice is on <html>: the hero's cascade starts in the same frame, or not at all.
  initIntro()
  initNav()
  initMenu()
  initSound()
  initReveal()
  initDecode()

  const canvas = document.querySelector<HTMLCanvasElement>('[data-gl-canvas]')
  // The scene is its own lazy chunk (with three.js), requested only after the page has painted.
  if (canvas) bootGL(canvas, { load: () => import('./gl/scene') })
}
