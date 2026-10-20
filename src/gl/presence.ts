// The chat's presence (spec §9.2): the landing's light — a network of neurons in a thin glass shell
// with a halo — alone in the scene slot of /chat/, where the 3D character will stand later.
//
// - One composition: state 0 of the landing, centred in the slot. No scroll states, no hero light,
//   no bokeh, no pointer: the slot is small and the page around it is for reading.
// - The canvas fills its slot (options.sizeTo), measured with a ResizeObserver, not the window.
// - setPresence() changes how much signal runs through the network and how bright the halo is;
//   pulse() flashes the halo once per write of streamed text. The shape never changes, so nothing
//   leaves the slot's soft mask.
// - The same FrameGovernor as the landing: full rate while the AI thinks or answers, ~30 fps after
//   2 s of calm, ~20 fps after 8 s.
// - One palette per theme (core/palette.ts): the theme event (THEME_EVENT) swaps uniforms and the
//   particles' blending in place — no new materials, no recompiled programs, no rebuilt scene.

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector4,
} from 'three'
import type { SceneCallbacks, SceneHandle, SceneOptions } from './core/boot'
import { GL_PALETTES, hexToVec3, type GlTheme } from './core/palette'
import { FrameGovernor, pickTier } from './core/quality'
import { createRenderer } from './core/renderer'
import { SOMAS, WAVE_PERIOD } from './neural'
import { damp } from './scroll'
import { buildShapes } from './shapes'
import glassFrag from './shaders/glass.frag.glsl?raw'
import glassVert from './shaders/glass.vert.glsl?raw'
import glowFrag from './shaders/glow.frag.glsl?raw'
import glowVert from './shaders/glow.vert.glsl?raw'
import noise from './shaders/noise.glsl?raw'
import particlesFrag from './shaders/particles.frag.glsl?raw'
import particlesVert from './shaders/particles.vert.glsl?raw'
import somaFrag from './shaders/soma.frag.glsl?raw'
import somaVert from './shaders/soma.vert.glsl?raw'
import { THEME_EVENT, resolvedTheme } from '../ui/theme'

export type Presence = 'idle' | 'listening' | 'thinking' | 'speaking' | 'summary' | 'saved' | 'quiet'

export interface PresenceHandle extends SceneHandle {
  setPresence(presence: Presence): void
  /** One flash of the halo (a write of streamed text); the page keeps it to ≤ 4 a second. */
  pulse(): void
}

export interface PresenceStats {
  tier: string
  particles: number
  pixelRatio: number
  presence: Presence
  fire: number
  frames: number
  fps: number
  draws: number
  width: number
  height: number
}

declare global {
  interface Window {
    /** Read-only diagnostics of the chat's light, for tests and manual checks. */
    __lioraPresence?: { stats(): PresenceStats }
  }
}

const CAMERA_DISTANCE = 6.5
const FOV = 40
const HALF_HEIGHT = CAMERA_DISTANCE * Math.tan(((FOV / 2) * Math.PI) / 180)
const GLASS_RADIUS = 1.14
/** Glass diameter as a share of the slot: inside the opaque part of the slot's radial mask (72 %),
 *  with room for the halo to fade out. */
const GLASS_SHARE = 0.56

// Same density reference as the landing (src/gl/scene.ts): 1440×900, 36k particles, hero light.
const REFERENCE_PX_PER_UNIT = (450 / HALF_HEIGHT) * Math.min(HALF_HEIGHT * 0.4, HALF_HEIGHT * 1.6 * 0.26)
const REFERENCE_COUNT = 36000

const IDLE_AFTER_MS = 2000
const IDLE_FRAME_MS = 30
const DEEP_IDLE_AFTER_MS = 8000
const DEEP_IDLE_FRAME_MS = 48
const ACTIVE_FRAME_MS = 9.2

/** Per presence: signal in the network, halo strength, brightness of the light. */
const MOOD: Readonly<Record<Presence, Readonly<{ fire: number; glow: number; intensity: number }>>> = {
  idle: { fire: 0.2, glow: 0.3, intensity: 0.9 },
  // The person is typing: a little more awake than idle, far from thinking (nothing has been sent).
  listening: { fire: 0.32, glow: 0.33, intensity: 0.93 },
  thinking: { fire: 0.6, glow: 0.34, intensity: 0.95 },
  speaking: { fire: 0.8, glow: 0.36, intensity: 1 },
  summary: { fire: 0.5, glow: 0.32, intensity: 0.92 },
  saved: { fire: 0.6, glow: 0.4, intensity: 1 },
  quiet: { fire: 0, glow: 0.2, intensity: 0.7 },
}

function breath(seconds: number): number {
  const t = seconds % 10
  const ease = (x: number): number => 0.5 - 0.5 * Math.cos(Math.PI * x)
  return t < 4 ? ease(t / 4) : 1 - ease((t - 4) / 6)
}

export async function createScene(canvas: HTMLCanvasElement, callbacks: SceneCallbacks, options: SceneOptions = {}): Promise<PresenceHandle> {
  const tier = pickTier({ force: options.tier })
  const slot = options.sizeTo ?? canvas.parentElement ?? canvas
  // Throws when WebGL2 cannot be created; core/boot.ts turns that into the static orb.
  const renderer = createRenderer(canvas, { msaa: tier.msaa })

  const scene = new Scene()
  const camera = new PerspectiveCamera(FOV, 1, 0.1, 60)
  camera.position.set(0, 0, CAMERA_DISTANCE)

  const context = renderer.getContext()
  const pointRange = context.getParameter(context.ALIASED_POINT_SIZE_RANGE) as Float32Array | null
  const maxPointSize = pointRange ? pointRange[1] : 64

  const light = new Group()
  scene.add(light)

  let theme: GlTheme = resolvedTheme()
  let palette = GL_PALETTES[theme]

  // Halo behind the light.
  const glowUniforms = { uColor: { value: hexToVec3(palette.glow) }, uStrength: { value: 0.3 } }
  const glow = new Mesh(
    new PlaneGeometry(1, 1),
    new ShaderMaterial({
      uniforms: glowUniforms,
      vertexShader: glowVert,
      fragmentShader: glowFrag,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: NormalBlending,
      premultipliedAlpha: true,
    }),
  )
  glow.position.z = -0.6
  glow.scale.setScalar(4.6)
  glow.renderOrder = 0
  light.add(glow)

  // The network of neurons and the dust around it (the landing's shapes; only state 0 is used).
  const shapes = buildShapes(tier.particles)
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(shapes.core, 3))
  geometry.setAttribute('aPath', new BufferAttribute(shapes.path, 3))
  geometry.setAttribute('aCluster', new BufferAttribute(shapes.cluster, 4))
  geometry.setAttribute('aConstellation', new BufferAttribute(shapes.constellation, 3))
  geometry.setAttribute('aRandom', new BufferAttribute(shapes.random, 4))
  geometry.setAttribute('aNeural', new BufferAttribute(shapes.neural, 4))
  geometry.setAttribute('aNeural2', new BufferAttribute(shapes.neural2, 4))

  const particleUniforms = {
    uTime: { value: 0 },
    uState: { value: 0 },
    uPixelRatio: { value: 1 },
    uSize: { value: 4.4 },
    uSizeScale: { value: 1 },
    uMaxPointSize: { value: maxPointSize },
    uAspect: { value: 1 },
    uFocus: { value: CAMERA_DISTANCE },
    uBreath: { value: 0 },
    uIntensity: { value: 1 },
    uBand: { value: new Vector2(-3, 3) },
    uDim: { value: 0 },
    uPointer: { value: new Vector2(0, 0) },
    uPointerStrength: { value: 0 },
    uDecide: { value: 0 },
    uFire: { value: MOOD.idle.fire },
    uFlash: { value: 1 },
    uWavePeriod: { value: new Vector4(...WAVE_PERIOD) },
    uCool: { value: hexToVec3(palette.particleCool) },
    uWarm: { value: hexToVec3(palette.particleWarm) },
    uHighlight: { value: hexToVec3(palette.particleHighlight) },
  }
  const particles = new Points(
    geometry,
    new ShaderMaterial({
      uniforms: particleUniforms,
      vertexShader: `${noise}
${particlesVert}`,
      fragmentShader: particlesFrag,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: palette.additive ? AdditiveBlending : NormalBlending,
      premultipliedAlpha: true,
    }),
  )
  particles.frustumCulled = false
  particles.renderOrder = 2
  light.add(particles)

  const somaUniforms = {
    uTime: particleUniforms.uTime,
    uState: particleUniforms.uState,
    uBreath: particleUniforms.uBreath,
    uDecide: particleUniforms.uDecide,
    uFire: particleUniforms.uFire,
    uFlash: particleUniforms.uFlash,
    uWavePeriod: particleUniforms.uWavePeriod,
    uAspect: particleUniforms.uAspect,
    uBand: particleUniforms.uBand,
    uDim: particleUniforms.uDim,
    uPointer: particleUniforms.uPointer,
    uPointerStrength: particleUniforms.uPointerStrength,
    uCool: particleUniforms.uCool,
    uWarm: particleUniforms.uWarm,
    uHighlight: particleUniforms.uHighlight,
    uOpacity: { value: 1 },
  }
  const ball = new IcosahedronGeometry(1, 3)
  const somaGeometry = new InstancedBufferGeometry()
  somaGeometry.setAttribute('position', ball.getAttribute('position'))
  somaGeometry.setAttribute('normal', ball.getAttribute('normal'))
  ball.dispose()
  somaGeometry.setAttribute('aSomaCore', new InstancedBufferAttribute(shapes.somas.core, 4))
  somaGeometry.setAttribute('aSomaPath', new InstancedBufferAttribute(shapes.somas.path, 4))
  somaGeometry.setAttribute('aSomaCluster', new InstancedBufferAttribute(shapes.somas.cluster, 4))
  somaGeometry.setAttribute('aSomaDiary', new InstancedBufferAttribute(shapes.somas.constellation, 4))
  somaGeometry.setAttribute('aSomaWave', new InstancedBufferAttribute(shapes.somas.wave, 4))
  somaGeometry.setAttribute('aSomaMeta', new InstancedBufferAttribute(shapes.somas.meta, 4))
  somaGeometry.instanceCount = SOMAS
  const somas = new Mesh(
    somaGeometry,
    new ShaderMaterial({
      uniforms: somaUniforms,
      vertexShader: `${noise}
${somaVert}`,
      fragmentShader: somaFrag,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: NormalBlending,
      premultipliedAlpha: true,
    }),
  )
  somas.frustumCulled = false
  somas.renderOrder = 3
  particles.add(somas)

  const glassUniforms = {
    uTime: { value: 0 },
    uOpacity: { value: 1 },
    uRimPower: { value: 3.2 },
    uBody: { value: 0.02 },
    uSpecular: { value: 0.9 },
    uWarm: { value: hexToVec3(palette.particleWarm) },
    uTint: { value: hexToVec3(palette.glassTint) },
  }
  const glass = new Mesh(
    new SphereGeometry(GLASS_RADIUS, 96, 64),
    new ShaderMaterial({
      uniforms: glassUniforms,
      vertexShader: glassVert,
      fragmentShader: glassFrag,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: NormalBlending,
      premultipliedAlpha: true,
    }),
  )
  glass.renderOrder = 4
  light.add(glass)

  const particleMaterial = particles.material as ShaderMaterial
  /** The other theme's colours, in place (uniforms are read every frame; blending is draw state). */
  const applyPalette = (next: GlTheme): void => {
    theme = next
    palette = GL_PALETTES[next]
    glowUniforms.uColor.value.copy(hexToVec3(palette.glow))
    particleUniforms.uCool.value.copy(hexToVec3(palette.particleCool))
    particleUniforms.uWarm.value.copy(hexToVec3(palette.particleWarm))
    particleUniforms.uHighlight.value.copy(hexToVec3(palette.particleHighlight))
    glassUniforms.uWarm.value.copy(hexToVec3(palette.particleWarm))
    glassUniforms.uTint.value.copy(hexToVec3(palette.glassTint))
    particleMaterial.blending = palette.additive ? AdditiveBlending : NormalBlending
  }

  // State
  const governor = new FrameGovernor()
  let presence: Presence = 'idle'
  let fire = MOOD.idle.fire
  let glowLevel = MOOD.idle.glow
  let intensity = MOOD.idle.intensity
  let flash = 0
  let spin = 1
  let dprCap = options.dprCap ?? tier.dprCap
  let pixelRatio = Math.min(window.devicePixelRatio || 1, dprCap)
  let ratioDirty = true
  let drawCount = shapes.count
  let elapsed = 0
  let last = 0
  let lastActivity = 0
  let frames = 0
  let fpsWindowStart = 0
  let fpsFrames = 0
  let fps = 0
  let draws = 0
  let running = false
  let wantRunning = true
  let firstFrameSent = false
  let lost = false
  let width = 0
  let height = 0
  let scale = 1

  // The slot is square; the light fills GLASS_SHARE of it whatever its size.
  const resize = (): boolean => {
    const w = Math.round(slot.clientWidth)
    const h = Math.round(slot.clientHeight)
    if (w < 2 || h < 2) return false
    if (!ratioDirty && w === width && h === height) return false
    ratioDirty = false
    width = w
    height = h
    renderer.setDrawingBufferSize(w, h, pixelRatio)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    const halfUnits = HALF_HEIGHT * Math.min(1, camera.aspect)
    scale = (GLASS_SHARE * halfUnits) / GLASS_RADIUS
    particleUniforms.uAspect.value = camera.aspect
    particleUniforms.uPixelRatio.value = pixelRatio
    return true
  }

  const resizeObserver = new ResizeObserver(() => {
    ratioDirty = true
  })
  resizeObserver.observe(slot)

  let dprQuery: MediaQueryList | null = null
  const onDprChange = (): void => {
    pixelRatio = Math.min(window.devicePixelRatio || 1, dprCap)
    ratioDirty = true
    watchDpr()
  }
  const watchDpr = (): void => {
    dprQuery?.removeEventListener('change', onDprChange)
    dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
    dprQuery.addEventListener('change', onDprChange, { once: true })
  }
  watchDpr()

  const applyGovernor = (dt: number, renderMs: number): void => {
    const action = governor.sample(dt, renderMs)
    if (action === 'lower-dpr' && pixelRatio > 1) {
      pixelRatio = Math.max(1, pixelRatio - 0.25)
      dprCap = pixelRatio
      ratioDirty = true
    } else if (action === 'fewer-particles' || action === 'fewer-bokeh' || (action === 'lower-dpr' && pixelRatio <= 1)) {
      drawCount = Math.max(4000, Math.floor(drawCount * 0.65))
      geometry.setDrawRange(0, drawCount)
    } else if (action === 'give-up') {
      queueMicrotask(() => callbacks.onTooSlow())
    }
  }

  const busy = (): boolean => presence === 'thinking' || presence === 'speaking' || presence === 'summary'

  const frame = (now: number): void => {
    if (lost) return
    const resized = resize()
    if (width === 0) return
    if (busy() || flash > 0.01) lastActivity = now
    const quietFor = now - lastActivity
    const idle = quietFor > IDLE_AFTER_MS
    const minInterval = quietFor > DEEP_IDLE_AFTER_MS ? DEEP_IDLE_FRAME_MS : idle ? IDLE_FRAME_MS : ACTIVE_FRAME_MS
    if (!resized && last && now - last < minInterval) return

    const dtMs = last ? now - last : 16.7
    last = now
    const dt = Math.min(dtMs, 100) / 1000
    const mood = MOOD[presence]
    // The crisis drops the signal in one frame; everything else eases.
    fire = presence === 'quiet' ? 0 : damp(fire, mood.fire, 2.5, dt)
    glowLevel = damp(glowLevel, mood.glow, 2, dt)
    intensity = damp(intensity, mood.intensity, 2, dt)
    spin = damp(spin, presence === 'quiet' ? 0.15 : 1, 1 / 1.2, dt)
    flash = damp(flash, 0, 6, dt)
    elapsed += dt * spin

    light.scale.setScalar(scale)
    const pxPerUnit = height / 2 / HALF_HEIGHT
    const ratio = (pxPerUnit * scale) / REFERENCE_PX_PER_UNIT
    const density = Math.min(1.2, Math.max(0.25, ratio * ratio * (REFERENCE_COUNT / drawCount)))
    const breathing = breath(elapsed)

    particleUniforms.uTime.value = elapsed
    particleUniforms.uBreath.value = breathing
    particleUniforms.uIntensity.value = intensity * density * palette.intensity
    particleUniforms.uSizeScale.value = Math.min(1.2, Math.max(0.6, Math.sqrt(ratio)))
    particleUniforms.uFire.value = fire
    somaUniforms.uOpacity.value = intensity
    glass.scale.setScalar(1 + breathing * 0.012)
    glass.rotation.set(0.25, elapsed * 0.05, 0)
    glassUniforms.uTime.value = elapsed
    glowUniforms.uStrength.value = (glowLevel + flash * 0.12) * palette.glowStrength

    const renderStart = performance.now()
    renderer.render(scene, camera)
    const renderMs = performance.now() - renderStart
    draws = renderer.info.render.calls
    frames++
    fpsFrames++
    if (now - fpsWindowStart >= 1000) {
      fps = Math.round((fpsFrames * 1000) / (now - fpsWindowStart))
      fpsWindowStart = now
      fpsFrames = 0
    }
    if (!firstFrameSent) {
      firstFrameSent = true
      callbacks.onFirstFrame()
    }
    if (!idle) applyGovernor(dtMs, renderMs)
  }

  const start = (): void => {
    if (running || lost || !wantRunning || document.hidden) return
    running = true
    last = 0
    lastActivity = performance.now()
    renderer.setAnimationLoop(frame)
  }
  const stop = (): void => {
    running = false
    renderer.setAnimationLoop(null)
  }

  const onVisibility = (): void => {
    if (document.hidden) stop()
    else start()
  }
  const onPageHide = (): void => stop()
  const onPageShow = (): void => start()
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('pageshow', onPageShow)

  const onLost = (): void => {
    lost = true
    firstFrameSent = false
    stop()
    callbacks.onContextLost()
  }
  const onRestored = (): void => {
    lost = false
    ratioDirty = true
    callbacks.onContextRestored()
    start()
  }
  canvas.addEventListener('webglcontextlost', onLost)
  canvas.addEventListener('webglcontextrestored', onRestored)

  const onTheme = (event: Event): void => {
    const next = (event as CustomEvent<unknown>).detail
    if ((next !== 'light' && next !== 'dark') || next === theme) return
    applyPalette(next)
    // A paused scene keeps its last frame on screen: draw it once in the new colours.
    if (!running && !lost && width > 0) renderer.render(scene, camera)
  }
  window.addEventListener(THEME_EVENT, onTheme)

  window.__lioraPresence = {
    stats: () => ({ tier: tier.name, particles: drawCount, pixelRatio, presence, fire, frames, fps, draws, width, height }),
  }

  resize()
  light.scale.setScalar(scale)
  await renderer.compileAsync(scene, camera)
  if (width > 0) renderer.render(scene, camera)
  start()

  return {
    setPresence: (next) => {
      if (next === presence) return
      presence = next
      if (next === 'quiet') {
        fire = 0
        particleUniforms.uFire.value = 0
      }
    },
    pulse: () => {
      if (presence !== 'quiet') flash = 1
    },
    pause: () => {
      wantRunning = false
      stop()
    },
    resume: () => {
      wantRunning = true
      start()
    },
    destroy: () => {
      wantRunning = false
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      window.removeEventListener(THEME_EVENT, onTheme)
      dprQuery?.removeEventListener('change', onDprChange)
      resizeObserver.disconnect()
      scene.traverse((object) => {
        if (object instanceof Mesh || object instanceof Points) {
          object.geometry.dispose()
          ;(object.material as ShaderMaterial).dispose()
        }
      })
      renderer.dispose()
      renderer.forceContextLoss()
      delete window.__lioraPresence
    },
  }
}
