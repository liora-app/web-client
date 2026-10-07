import './styles/fonts.css'
import './styles/tokens.css'
import './styles/base.css'
import './styles/stage.css'
import './styles/layout.css'
import './styles/components.css'
import './styles/sections.css'

import { bootGL } from './gl/core/boot'
import { initDecode } from './ui/decode'
import { initHeroLight } from './ui/hero-light'
import { initMenu } from './ui/menu'
import { initMotionToggle } from './ui/motion'
import { initNav } from './ui/nav'
import { initReveal } from './ui/reveal'
import { initSound } from './ui/sound'
import { initSteps } from './ui/steps'

initHeroLight()
initMotionToggle(document.querySelector<HTMLButtonElement>('[data-motion-toggle]'))
initNav()
initMenu()
initSound()
initReveal()
initSteps()
initDecode()

const canvas = document.querySelector<HTMLCanvasElement>('[data-gl-canvas]')
// The scene is its own lazy chunk (with three.js), requested only after the page has painted.
if (canvas) bootGL(canvas, { load: () => import('./gl/scene') })
