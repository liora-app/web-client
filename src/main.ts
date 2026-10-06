import './styles/fonts.css'
import './styles/tokens.css'
import './styles/base.css'
import './styles/stage.css'
import './styles/layout.css'
import './styles/components.css'
import './styles/sections.css'

import { bootGL } from './gl/boot'
import { initDecode } from './ui/decode'
import { initHeroLight } from './ui/hero-light'
import { initMotionToggle } from './ui/motion'
import { initNav } from './ui/nav'
import { initReveal } from './ui/reveal'
import { initSteps } from './ui/steps'

initHeroLight()
initMotionToggle(document.querySelector<HTMLButtonElement>('[data-motion-toggle]'))
initNav()
initReveal()
initSteps()
initDecode()

const canvas = document.querySelector<HTMLCanvasElement>('[data-gl-canvas]')
if (canvas) bootGL(canvas)
