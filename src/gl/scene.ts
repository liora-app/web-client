// Continuous light filaments in the hero; a contour portrait in the scroll transition.
// The chat has its own independent scene.
// One palette per theme (core/palette.ts GL_PALETTES[theme].scene): light that adds up on the night,
// ink that covers the paper by day. The theme event (THEME_EVENT) swaps uniforms and blending in
// place — no new materials, no recompiled programs, no rebuilt scene.
import { OrthographicCamera, Scene } from 'three'
import { WIDE_LAYOUT, heroLight, onHeroLightChange } from '../ui/hero-light'
import type { SceneCallbacks, SceneHandle, SceneOptions } from './core/boot'
import { GL_PALETTES, type GlTheme } from './core/palette'
import { FrameGovernor, pickTier } from './core/quality'
import { createRenderer } from './core/renderer'
import { PointerTracker } from './pointer'
import { ScrollStates, damp } from './scroll'
import { createLuminousField } from './luminous-field'
import { createContourPortrait } from './contour-portrait'
import { createConversationFlow } from './conversation-flow'
import { THEME_EVENT, resolvedTheme } from '../ui/theme'

export interface SceneStats {
  tier: string
  vertices: number
  particles: number
  pixelRatio: number
  state: number
  frames: number
  fps: number
  quiet: number
  activity: number
  conversation: number
  draws: number
  layout: 'wide' | 'column'
}

declare global {
  interface Window {
    __lioraScene?: { stats(): SceneStats; sample(): number[] }
  }
}

interface Pose { x: number; y: number; size: number; opacity: number; turn: number; tilt: number }
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const clamp = (v: number): number => Math.max(0, Math.min(1, v))
const ease = (v: number): number => { const t = clamp(v); return t * t * (3 - 2 * t) }

function poses(width: number, height: number): Pose[] {
  const hero = heroLight() ?? { x: width * 0.72, y: height * 0.46, d: width * 0.32 }
  const sideX = width * 0.75
  const size = Math.min(width * 0.28, height * 0.43)
  const hidden: Pose = { x: sideX, y: height * 0.5, size, opacity: 0, turn: 0, tilt: 0.2 }
  return [
    { x: hero.x, y: hero.y, size: hero.d, opacity: 1, turn: -0.48, tilt: 0.4 },
    hidden,
    hidden,
    hidden,
    hidden,
    hidden,
    hidden,
    hidden,
  ]
}

export async function createScene(canvas: HTMLCanvasElement, callbacks: SceneCallbacks, options: SceneOptions = {}): Promise<SceneHandle> {
  const tier = pickTier({ force: options.tier })
  const renderer = createRenderer(canvas, { msaa: 4, depth: true })
  let pixelRatio = Math.min(window.devicePixelRatio || 1, options.dprCap ?? tier.dprCap, 1.75)
  const scene = new Scene()
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 2400)
  camera.position.z = 1200
  const field = createLuminousField(tier.name === 'low')
  const portrait = await createContourPortrait().catch(error => {
    field.dispose()
    renderer.dispose()
    renderer.forceContextLoss()
    throw error
  })
  const conversation = createConversationFlow(tier.name === 'low')
  scene.add(field.root, portrait.root, conversation.root)
  let theme: GlTheme = resolvedTheme()
  const applyPalette = (next: GlTheme): void => {
    theme = next
    const palette = GL_PALETTES[next].scene
    field.setPalette(palette)
    portrait.setPalette(palette)
    conversation.setPalette(palette)
  }
  applyPalette(theme)
  const pointer = new PointerTracker()
  const scroll = new ScrollStates()
  const transition = document.querySelector<HTMLElement>('[data-portrait]')
  const diaryArt = document.querySelector<HTMLElement>('.diary__sky')
  const finalArt = document.querySelector<HTMLElement>('.final__art')
  const finalSection = document.querySelector<HTMLElement>('.final')
  const howArt = document.querySelector<HTMLElement>('.how__motion')
  const howDrawing = document.querySelector<HTMLElement>('.how__drawing')
  const steps = Array.from(document.querySelectorAll<HTMLElement>('[data-step]'))
  const governor = new FrameGovernor()
  let width = 1
  let height = 1
  let layouts: Pose[] = []
  let state = scroll.target()
  let quiet = 0
  let activity = 1
  let elapsed = 0
  let frames = 0
  let fps = 0
  let fpsStart = 0
  let fpsFrames = 0
  let frameId = 0
  let running = false
  let wanted = true
  let lost = false
  let destroyed = false
  let last = 0
  let lastTick = 0
  let firstFrame = false
  let lastActivity = performance.now()
  let mouseX = 0
  let mouseY = 0
  let portraitProgress = 0
  let conversationProgress = 0

  const resize = (): void => {
    if (destroyed) return
    width = document.documentElement.clientWidth
    height = canvas.clientHeight || window.innerHeight
    camera.left = -width / 2
    camera.right = width / 2
    camera.top = height / 2
    camera.bottom = -height / 2
    camera.updateProjectionMatrix()
    renderer.setPixelRatio(pixelRatio)
    renderer.setSize(width, height, false)
    layouts = poses(width, window.innerHeight)
    scroll.measure()
    lastActivity = performance.now()
  }
  const stop = (): void => {
    running = false
    cancelAnimationFrame(frameId)
    frameId = 0
    last = 0
    lastTick = 0
  }
  const frame = (now: number): void => {
    if (!running) return
    frameId = requestAnimationFrame(frame)
    const tickMs = lastTick ? now - lastTick : 16.7
    lastTick = now
    const target = scroll.target()
    if (Math.abs(target - state) > 0.003 || Math.abs(pointer.target.x - mouseX) > 0.015 || Math.abs(pointer.target.y - mouseY) > 0.015) lastActivity = now
    const interval = now - lastActivity > 4000 ? 40 : 16
    if (last && now - last < interval) return
    const frameMs = last ? now - last : 33
    const dt = Math.min(frameMs / 1000, 0.08)
    last = now
    elapsed += dt
    state = damp(state, target, 4.2, dt)
    quiet = damp(quiet, scroll.quiet(), 5, dt)
    mouseX = damp(mouseX, pointer.target.x, 3, dt)
    mouseY = damp(mouseY, pointer.target.y, 3, dt)
    const index = Math.min(7, Math.max(0, Math.floor(state)))
    const next = Math.min(7, index + 1)
    const fraction = state - index
    const a = layouts[index]
    const b = layouts[next]
    const wide = WIDE_LAYOUT.matches
    let size = lerp(a.size, b.size, fraction)
    let opacity = lerp(a.opacity, b.opacity, fraction) * (1 - Math.min(1, quiet * 2))
    let x = lerp(a.x, b.x, fraction)
    let y = lerp(a.y, b.y, fraction)
    let atlas = false
    let finale = false
    let portraitOpacity = 0
    const rect = transition?.getBoundingClientRect()
    if (rect && rect.top < height && rect.bottom > 0) {
      const enter = ease((height - rect.top) / (height * 0.9))
      const leave = ease(rect.bottom / height)
      portraitProgress = damp(portraitProgress, clamp(-rect.top / Math.max(1, rect.height - height)), 5, dt)
      portraitOpacity = enter * leave
      opacity *= 1 - enter
      y -= (1 - enter) * window.scrollY * 0.25
    } else if (rect && rect.bottom <= 0 && state < 0.5) opacity = 0
    else if (!wide) y -= window.scrollY * Math.max(0, 1 - state)
    // Each artwork owns a measured space in the document, so it cannot drift across a card.
    const inView = (box: DOMRect): number => box.width > 0 && box.height > 0
      ? ease((height - box.top) / (height * 0.24)) * ease(box.bottom / (height * 0.24)) : 0
    const diaryBox = diaryArt?.getBoundingClientRect()
    const finalBox = finalArt?.getBoundingClientRect()
    const finalSectionBox = finalSection?.getBoundingClientRect()
    if (diaryBox && inView(diaryBox) > 0) {
      x = diaryBox.left + diaryBox.width / 2
      y = diaryBox.top + diaryBox.height / 2
      size = diaryBox.width * 0.88
      opacity = inView(diaryBox)
      atlas = true
    }
    if (finalBox && finalSectionBox && inView(finalSectionBox) > 0) {
      x = finalBox.left + finalBox.width / 2
      y = finalBox.top + finalBox.height / 2
      size = finalBox.height
      opacity = inView(finalSectionBox) * (wide ? 0.82 : 0.52)
      finale = true
    }
    const howBox = howArt?.getBoundingClientRect()
    const howOpacity = howBox ? inView(howBox) : 0
    conversation.root.visible = howOpacity > 0.005
    if (howBox && conversation.root.visible) {
      const centers = steps.map(step => { const box = step.getBoundingClientRect(); return box.top + box.height / 2 })
      const focus = height * 0.45
      let progress = 0
      for (let i = 0; i < centers.length - 1; i++) progress += clamp((focus - centers[i]) / Math.max(1, centers[i + 1] - centers[i]))
      conversationProgress = damp(conversationProgress, progress, 5, dt)
      conversation.root.position.set(howBox.left + howBox.width / 2 - width / 2, height / 2 - howBox.top - howBox.height / 2, 40)
      conversation.root.scale.setScalar(Math.min(howBox.width / 1.85, howBox.height / 2.85))
      conversation.root.rotation.set(0.08 + mouseY * 0.025, Math.sin(elapsed * 0.12) * 0.16 + mouseX * 0.035, -0.03)
      conversation.uniforms.uOpacity.value = howOpacity
      conversation.uniforms.uTime.value = elapsed
      conversation.uniforms.uStage.value = conversationProgress
      howDrawing?.style.setProperty('--journey-progress', String(conversationProgress / 3))
    }
    activity = Math.max(opacity, portraitOpacity, howOpacity)
    field.root.visible = opacity > 0.005
    field.root.position.set(x - width / 2, height / 2 - y, 0)
    field.root.scale.setScalar(size / 2.2)
    field.body.rotation.set(atlas ? 0.35 : 0.4 + mouseY * 0.045, atlas ? -0.3 + Math.sin(elapsed * 0.12) * 0.045 : -0.48 + elapsed * 0.035 + mouseX * 0.07, atlas ? -0.18 : 0.06 * Math.sin(elapsed * 0.12))
    field.inner.visible = !atlas
    field.orbits.visible = !atlas
    field.inner.rotation.z = 1.4 - elapsed * 0.035
    field.uniforms.uTime.value = elapsed
    field.uniforms.uState.value = atlas ? 4 : 0
    field.uniforms.uOpacity.value = opacity
    field.uniforms.uHover.value = 0.35
    field.uniforms.uPointer.value.set(mouseX * 1.5, mouseY * 1.5)
    field.uniforms.uPixelRatio.value = pixelRatio
    field.uniforms.uSize.value = Math.min(1.1, size / 400)
    field.uniforms.uStroke.value = atlas ? 0.72 : wide ? 0.58 : 0.48
    field.uniforms.uGain.value = atlas ? 2.6 : 1.65
    field.uniforms.uResolution.value.set(width * pixelRatio, height * pixelRatio)
    field.uniforms.uFinal.value = finale ? 0.72 : 0
    const headSize = wide ? Math.min(width * 0.35, height * 0.68) : Math.min(width * 0.85, Math.max(140, height * 0.79 - 300))
    portrait.root.visible = portraitOpacity > 0.005
    portrait.root.position.set(width * (wide ? 0.22 : 0.04), wide ? height * -0.005 : height * 0.105 - 140, 60)
    portrait.root.scale.setScalar(headSize / 2 * (1 + Math.sin(portraitProgress * Math.PI) * 0.1))
    portrait.root.rotation.set(0.035 + mouseY * 0.018, -0.72 + portraitProgress * 0.66 + mouseX * 0.04, -0.025)
    portrait.uniforms.uTime.value = elapsed
    portrait.uniforms.uOpacity.value = portraitOpacity
    portrait.uniforms.uProgress.value = portraitProgress
    const started = performance.now()
    renderer.render(scene, camera)
    const renderMs = performance.now() - started
    frames++
    fpsFrames++
    if (now - fpsStart >= 1000) {
      fps = Math.round(fpsFrames * 1000 / Math.max(1, now - fpsStart))
      fpsStart = now
      fpsFrames = 0
    }
    if (!firstFrame) { firstFrame = true; callbacks.onFirstFrame() }
    // Measure the browser's frame interval, excluding our deliberate idle pacing.
    const action = governor.sample(tickMs, renderMs)
    if (action === 'give-up') { stop(); callbacks.onTooSlow(); return }
    if (action === 'lower-dpr') { pixelRatio = Math.max(0.75, pixelRatio * 0.75); resize() }
    if (action === 'fewer-particles' || action === 'fewer-bokeh') field.simplify()
  }
  const start = (): void => {
    if (running || !wanted || lost || destroyed || document.hidden) return
    running = true
    last = 0
    fpsStart = performance.now()
    fpsFrames = 0
    frameId = requestAnimationFrame(frame)
  }
  const onVisibility = (): void => { if (document.hidden) stop(); else start() }
  const onLost = (): void => { lost = true; firstFrame = false; stop(); callbacks.onContextLost() }
  const onRestored = (): void => { lost = false; resize(); callbacks.onContextRestored(); start() }
  const onPageHide = (): void => stop()
  const onPageShow = (): void => start()
  // While the scene is paused the page shows the static art (html[data-gl='off'] hides the canvas):
  // the next frame after resume() is drawn in the new colours, nothing to draw now.
  const onTheme = (event: Event): void => {
    const next = (event as CustomEvent<unknown>).detail
    if ((next !== 'light' && next !== 'dark') || next === theme) return
    applyPalette(next)
  }
  window.addEventListener(THEME_EVENT, onTheme)
  const observer = new ResizeObserver(resize)
  observer.observe(document.body)
  window.addEventListener('resize', resize, { passive: true })
  WIDE_LAYOUT.addEventListener('change', resize)
  const stopHero = onHeroLightChange(resize)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('pageshow', onPageShow)
  canvas.addEventListener('webglcontextlost', onLost)
  canvas.addEventListener('webglcontextrestored', onRestored)
  window.__lioraScene = {
    stats: () => ({ tier: tier.name, vertices: field.vertices + portrait.vertices + conversation.vertices, particles: field.particles, pixelRatio, state, frames, fps, quiet, activity, conversation: conversationProgress, draws: renderer.info.render.calls, layout: WIDE_LAYOUT.matches ? 'wide' : 'column' }),
    sample: () => {
      if (lost) return []
      renderer.render(scene, camera)
      const gl = renderer.getContext()
      const pixel = new Uint8Array(4)
      const samples: number[] = []
      for (let y = 1; y <= 9; y++) for (let x = 1; x <= 9; x++) {
        gl.readPixels(Math.floor(gl.drawingBufferWidth * x / 10), Math.floor(gl.drawingBufferHeight * y / 10), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
        samples.push(Math.round(pixel[0] * 0.2126 + pixel[1] * 0.7152 + pixel[2] * 0.0722))
      }
      return samples
    },
  }
  resize()
  await renderer.compileAsync(scene, camera)
  renderer.render(scene, camera)
  start()
  return {
    pause: () => { wanted = false; stop() },
    resume: () => { wanted = true; start() },
    destroy: () => {
      destroyed = true
      wanted = false
      stop()
      observer.disconnect()
      stopHero()
      pointer.dispose()
      window.removeEventListener('resize', resize)
      WIDE_LAYOUT.removeEventListener('change', resize)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
      window.removeEventListener(THEME_EVENT, onTheme)
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      field.dispose()
      portrait.dispose()
      conversation.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      delete window.__lioraScene
    },
  }
}
