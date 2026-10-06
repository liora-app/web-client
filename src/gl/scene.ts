// The WebGL layer: a transparent full-screen canvas between the hero's display type and the
// text (see src/styles/stage.css). The night sky behind it is CSS. Here live the light — a network
// of neurons (instanced soma spheres, particles for the fibres) in a thin glass shell with a halo —
// and out-of-focus bokeh that drifts toward the camera as you scroll. No post-processing passes.
// Future 3D models (GLTF via three/addons) belong where the light sits: the hero and the final.

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
  type Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector4,
  WebGLRenderer,
} from 'three'
import { WIDE_LAYOUT, heroLight, onHeroLightChange, type HeroLight } from '../ui/hero-light'
import { GL_PALETTE, hexToVec3 } from './palette'
import { PointerTracker } from './pointer'
import { FrameGovernor, pickTier } from './quality'
import { ScrollStates, damp } from './scroll'
import { SOMAS, WAVE_PERIOD } from './neural'
import { buildShapes } from './shapes'
import bokehFrag from './shaders/bokeh.frag.glsl?raw'
import bokehVert from './shaders/bokeh.vert.glsl?raw'
import glassFrag from './shaders/glass.frag.glsl?raw'
import glassVert from './shaders/glass.vert.glsl?raw'
import glowFrag from './shaders/glow.frag.glsl?raw'
import glowVert from './shaders/glow.vert.glsl?raw'
import noise from './shaders/noise.glsl?raw'
import particlesFrag from './shaders/particles.frag.glsl?raw'
import particlesVert from './shaders/particles.vert.glsl?raw'
import somaFrag from './shaders/soma.frag.glsl?raw'
import somaVert from './shaders/soma.vert.glsl?raw'

export interface SceneCallbacks {
  onFirstFrame(): void
  onContextLost(): void
  onContextRestored(): void
  onTooSlow(): void
}

export interface SceneHandle {
  pause(): void
  resume(): void
  destroy(): void
}

export interface SceneStats {
  tier: string
  particles: number
  pixelRatio: number
  state: number
  frames: number
  fps: number
  quiet: number
  /** Signal strength in the network (0 by the crisis contacts). */
  fire: number
  /** Draw calls in the last frame. */
  draws: number
  /** 'wide' from 64em (two text columns), 'column' below: the same breakpoint as the CSS. */
  layout: 'wide' | 'column'
}

declare global {
  interface Window {
    /** Read-only diagnostics for tests and manual checks. */
    __lioraScene?: { stats(): SceneStats; sample(): number[]; edge(y: number): number[] }
  }
}

// Per-state composition: where the light sits and how loud the layer is behind the text.
interface Composition {
  x: number
  y: number
  scale: number
  turn: number // rotation (rad) — portrait screens stand the wide shapes up
  intensity: number
  dim: number // calming outside the clear band (wide layout), see uBand
  bandMin: number // NDC x range that stays bright: where the shape lives between the text
  bandMax: number
  glow: number
  glass: number // presence of the glass shell (hero, the kept themes, final)
  bokeh: number
  fire: number // how much signal runs through the network (0 by the crisis contacts)
}

const CAMERA_DISTANCE = 6.5
const FOV = 40
// 0 light · 1 noise · 2 chain · 3 theses · 4 diary graph · 5 keep · 6 release · 7 sunrise
const STATES = 8
const HALF_HEIGHT = CAMERA_DISTANCE * Math.tan(((FOV / 2) * Math.PI) / 180)
const GLASS_RADIUS = 1.14
const BOKEH_TUBE = 30

// The look was tuned on a 1440×900 desktop with 36k particles. Other screens and tiers keep the
// same apparent density: smaller shapes on a phone would otherwise burn out to white.
const REFERENCE_ASPECT = 1440 / 900
const REFERENCE_PX_PER_UNIT = 450 / HALF_HEIGHT
const REFERENCE_COUNT = 36000

// After 2 s without scrolling or pointer movement the scene drops to ~30 fps, after 8 s to ~20 fps:
// the breath (10 s), the twinkle (4–16 s) and the drift are slow enough that nobody sees it.
const IDLE_AFTER_MS = 2000
const IDLE_FRAME_MS = 30
const DEEP_IDLE_AFTER_MS = 8000
const DEEP_IDLE_FRAME_MS = 48
// Halfway between one 120 Hz vsync (8.3 ms) and one 100 Hz vsync (10 ms): timestamp jitter neither
// halves 90/100 Hz screens nor lets 120 Hz run on every vsync; faster screens draw every 2nd–3rd one.
const ACTIVE_FRAME_MS = 9.2
// First start only: the light ignites — it unfolds from a small core, the halo flares once and the
// glass closes in around it. The text is on screen the whole time.
const INTRO_SECONDS = 2.6

// Two kinds of "portrait": `portrait` (aspect) is geometry — stand the wide shapes up, fit the sun;
// `column` is layout — one text column, exactly when the CSS has one (below 64em). Where the light
// may be bright depends on the layout, not on the aspect.
function compositions(aspect: number, wideLayout: boolean, hero: HeroLight | null = null, w = 0, h = 0): Composition[] {
  const halfHeight = HALF_HEIGHT
  const halfWidth = halfHeight * aspect
  const portrait = aspect < 0.85
  const column = !wideLayout
  const turn = portrait ? Math.PI / 2 : 0
  const wide = portrait ? Math.min(0.85, (halfHeight * 0.95) / 4.2) : Math.min(1, (halfWidth * 0.98) / 4.2)
  // One column: text spans the full width, so the whole layer gets quieter instead of one lane.
  const quiet = column ? 0.55 : 1
  const all = { bandMin: -3, bandMax: 3 }
  const middle = { bandMin: -0.24, bandMax: 0.24 }

  // Hero: measured by src/ui/hero-light.ts — beside the title lines, never on them (the title is
  // under this canvas). The formulas are the same defaults it starts from.
  let heroX = column ? 0 : halfWidth * 0.45
  let heroY = column ? halfHeight * 0.5 : halfHeight * 0.02
  let heroScale = column ? Math.min(0.72, halfWidth * 0.43) : Math.min(halfHeight * 0.4, halfWidth * 0.26)
  if (hero && w > 0 && h > 0) {
    const pxPerUnit = h / 2 / halfHeight
    heroX = ((2 * hero.x) / w - 1) * halfWidth
    heroY = (1 - (2 * hero.y) / h) * halfHeight
    heroScale = hero.d / 2 / pxPerUnit / GLASS_RADIUS
  }

  // Final: a sunrise — only the top of the light rises above the fold, under the closing words.
  const sunScale = portrait ? halfWidth * 1.05 : Math.min(2.4, halfWidth * 0.6)
  const sunY = -halfHeight - sunScale * (portrait ? 0.62 : 0.8)

  return [
    // 0 · The light. Quieter on wide layouts: the disc there is smaller than the one the density
    // reference was tuned with, and the same particles would otherwise burn brighter.
    { x: heroX, y: heroY, scale: heroScale, turn: 0, intensity: column ? 1 : 0.83, dim: 0, ...all, glow: 0.34, glass: 1, bokeh: 0.85, fire: 1 },
    // 1 · Noise: the network scattered into a restless knot in the lane between the columns.
    { x: 0, y: 0, scale: column ? 0.62 : 0.45, turn, intensity: (column ? 0.32 : 0.45) * quiet, dim: 0.8, ...middle, glow: column ? 0.06 : 0.1, glass: 0, bokeh: 1, fire: 0.4 },
    // 2 · A chain of neurons the signal runs along: a conversation finding its line.
    { x: 0, y: portrait ? 0 : -0.35, scale: wide, turn, intensity: 0.85 * quiet, dim: 0.86, ...middle, glow: 0.05, glass: 0, bokeh: 0.8, fire: 1 },
    // 3 · Theses stand up in a column: in the lane between the steps and the example on wide layouts,
    // near the edge in one column, where the text runs full width. The column is always upright, so
    // its size follows the geometry.
    { x: column ? halfWidth * 0.72 : 0, y: 0, scale: portrait ? wide * 0.8 : Math.min(0.62, (halfHeight * 0.8) / 2.4), turn: Math.PI / 2, intensity: column ? 0.4 : 0.95, dim: 0.4, ...middle, glow: 0.1, glass: 0, bokeh: 0.6, fire: 0.8 },
    // 4 · The diary graph of themes owns the right half on wide layouts (lying down even on a
    // portrait tablet); the diary text is on the left. In one column it runs under the text, so it is
    // only a trace there (as is the keep below: no clear band on a full-width column).
    { x: column ? halfWidth * 0.3 : halfWidth * 0.47, y: column ? 0 : 0.1, scale: column ? wide * 0.88 : Math.min(wide * 0.62, (halfWidth * 0.44) / 3.1), turn: column ? turn : 0, intensity: column ? 0.2 : 0.9, dim: 0.85, bandMin: 0.02, bandMax: 3, glow: 0.07, glass: 0, bokeh: 0.7, fire: 1 },
    // 5 · Keep: the kept theses gathered into glass, beside the privacy title (right half).
    { x: column ? halfWidth * 0.78 : halfWidth * 0.5, y: column ? 0 : 0.05, scale: column ? wide * 0.8 : 0.62, turn: column ? Math.PI / 2 : 0, intensity: column ? 0.2 : 0.6, dim: 0.85, bandMin: 0.2, bandMax: 3, glow: column ? 0.03 : 0.2, glass: column ? 0 : 0.9, bokeh: 0.5, fire: 0.6 },
    // 6 · Release: quiet dust to read over (principles, help, questions).
    { x: 0, y: 0, scale: wide, turn, intensity: 0.6, dim: 0.75, ...middle, glow: 0.03, glass: 0, bokeh: 0.4, fire: 0 },
    // 7 · Sunrise.
    { x: 0, y: sunY, scale: sunScale, turn: 0, intensity: 1, dim: 0, ...all, glow: 0.42, glass: 1, bokeh: 0.7, fire: 0.8 },
  ]
}

const emptyComposition = (): Composition => ({
  x: 0,
  y: 0,
  scale: 1,
  turn: 0,
  intensity: 1,
  dim: 0,
  bandMin: -3,
  bandMax: 3,
  glow: 0,
  glass: 0,
  bokeh: 0,
  fire: 0,
})

const BLENDED_KEYS = Object.keys(emptyComposition()) as (keyof Composition)[]

function blendComposition(list: Composition[], state: number, out: Composition): Composition {
  const s = Math.min(STATES - 1, Math.max(0, state))
  const i = Math.floor(s)
  const j = Math.min(STATES - 1, i + 1)
  const t = s - i
  const a = list[i]
  const b = list[j]
  for (const key of BLENDED_KEYS) out[key] = a[key] + (b[key] - a[key]) * t
  return out
}

// Breathing: ~6 breaths per minute, inhale 4 s, exhale 6 s, eased.
function breath(seconds: number): number {
  const t = seconds % 10
  const ease = (x: number): number => 0.5 - 0.5 * Math.cos(Math.PI * x)
  return t < 4 ? ease(t / 4) : 1 - ease((t - 4) / 6)
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

function buildBokeh(count: number, seed = 7341): BufferGeometry {
  let a = seed >>> 0
  const rand = (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const randoms = new Float32Array(count * 2)
  const palette = GL_PALETTE.bokeh.map(hexToVec3)
  for (let i = 0; i < count; i++) {
    // Keep the very centre of the view clear so discs do not sit on the light.
    let x = (rand() * 2 - 1) * 9
    const y = (rand() * 2 - 1) * 5.5
    if (Math.abs(x) < 1.2 && Math.abs(y) < 1.2) x += Math.sign(x || 1) * 1.6
    positions.set([x, y, rand() * BOKEH_TUBE], i * 3)
    const c = palette[Math.floor(rand() * palette.length)]
    colors.set([c.x, c.y, c.z], i * 3)
    randoms.set([rand(), rand()], i * 2)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('aColor', new BufferAttribute(colors, 3))
  geometry.setAttribute('aRandom', new BufferAttribute(randoms, 2))
  return geometry
}

export async function createScene(canvas: HTMLCanvasElement, callbacks: SceneCallbacks): Promise<SceneHandle> {
  const tier = pickTier()
  // Throws when WebGL2 cannot be created; boot.ts turns that into the static backdrop.
  const renderer = new WebGLRenderer({
    canvas,
    antialias: false,
    alpha: true,
    premultipliedAlpha: true,
    depth: false,
    stencil: false,
    // A calm background layer has no business waking a discrete GPU; WebKit also throttles
    // 'high-performance' contexts hard on iPhones.
    powerPreference: 'low-power',
    failIfMajorPerformanceCaveat: true,
  })
  renderer.setClearColor(0x000000, 0)

  const scene = new Scene()
  const camera = new PerspectiveCamera(FOV, 1, 0.1, 60)
  camera.position.set(0, 0, CAMERA_DISTANCE)

  const context = renderer.getContext()
  const pointRange = context.getParameter(context.ALIASED_POINT_SIZE_RANGE) as Float32Array | null
  const maxPointSize = pointRange ? pointRange[1] : 64

  // Everything that belongs to "the light" moves together with the composition.
  const light = new Group()
  scene.add(light)

  // Halo behind the light.
  const glowUniforms = {
    uColor: { value: hexToVec3(GL_PALETTE.glow) },
    uStrength: { value: 0.3 },
  }
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

  // Particles: the networks of neurons (shapes.ts, neural.ts) and the dust around them.
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
    uFire: { value: 1 },
    uFlash: { value: 1 },
    uWavePeriod: { value: new Vector4(...WAVE_PERIOD) },
    uCool: { value: hexToVec3(GL_PALETTE.particleCool) },
    uWarm: { value: hexToVec3(GL_PALETTE.particleWarm) },
    uHighlight: { value: hexToVec3(GL_PALETTE.particleHighlight) },
  }
  // Additive + premultiplied: three.js blends (ONE, ONE), the shader keeps rgb <= alpha.
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
      blending: AdditiveBlending,
      premultipliedAlpha: true,
    }),
  )
  particles.frustumCulled = false
  particles.renderOrder = 2
  light.add(particles)

  // Soma bodies: one instanced sphere per neuron, drawn over the particles and under the glass. A
  // child of the particles, so they turn with them; the uniforms they share are the same objects.
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
  // Normal blending: the bodies cover what lies behind them. There is no depth buffer, so two
  // overlapping bodies draw in instance order; they rarely overlap and look alike when they do.
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

  // Glass shell: a thin rim, no orbit around it — a lamp, not a planet.
  const glassUniforms = {
    uTime: { value: 0 },
    uOpacity: { value: 1 },
    uRimPower: { value: 3.2 },
    uBody: { value: 0.02 },
    uSpecular: { value: 0.9 },
    uWarm: { value: hexToVec3(GL_PALETTE.particleWarm) },
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

  // Bokeh: world space, not part of the light.
  const bokehUniforms = {
    uTravel: { value: 0 },
    uTime: { value: 0 },
    uPixelRatio: { value: 1 },
    uMaxPointSize: { value: maxPointSize },
    uIntensity: { value: 1 },
    uDim: { value: 0 },
    uBand: { value: new Vector2(-3, 3) },
  }
  const bokeh = new Points(
    buildBokeh(tier.bokeh),
    new ShaderMaterial({
      uniforms: bokehUniforms,
      vertexShader: bokehVert,
      fragmentShader: bokehFrag,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
      premultipliedAlpha: true,
    }),
  )
  bokeh.frustumCulled = false
  bokeh.renderOrder = 1
  scene.add(bokeh)

  // State
  const scroll = new ScrollStates()
  const pointer = new PointerTracker()
  const governor = new FrameGovernor()
  const pointerNow = new Vector2(0, 0)
  const comp = emptyComposition()
  const referenceComp = emptyComposition()
  const reference = compositions(REFERENCE_ASPECT, true)
  let wideLayout = WIDE_LAYOUT.matches
  let layouts = compositions(1, wideLayout)
  let dprCap = tier.dprCap // lowered by the governor; zoom and DPR changes respect it
  let pixelRatio = Math.min(window.devicePixelRatio || 1, dprCap)
  let ratioDirty = true // the pixel ratio changed (or the context came back): re-allocate the buffer
  let drawCount = shapes.count
  let bokehCount = tier.bokeh
  let state = scroll.target()
  let lastTarget = state
  let quiet = scroll.quiet()
  let decide = scroll.decide()
  let pointerStrength = 0
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
  // Big jumps (a header link from the top to the end) fade out, cut and fade back in instead of
  // racing the particles through every shape in between.
  let jump: 'none' | 'out' | 'in' = 'none'
  let fade = 1
  let introStart = -1

  // The canvas is 100lvh tall (stage.css). With a browser bar showing, its bottom (lvh − dvh) is
  // under the bar, and the sunrise is lifted by that much. Measured on events, eased per frame.
  const probe = document.createElement('div')
  probe.setAttribute('aria-hidden', 'true')
  // 100vh first: without dvh support the probe equals the canvas and the lift is 0.
  probe.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:100vh;height:100dvh;visibility:hidden;pointer-events:none'
  document.body.append(probe)
  let hiddenPx = 0
  let lift = 0
  const measureHidden = (): void => {
    const h = canvas.clientHeight
    hiddenPx = Math.max(0, h - (probe.clientHeight || h))
  }

  // Where the light and the shapes go: depends on the canvas size, the CSS layout and the measured
  // hero light. Cheap; called whenever one of them changes.
  const relayout = (): void => {
    wideLayout = WIDE_LAYOUT.matches
    layouts = compositions(camera.aspect, wideLayout, heroLight(), width, height)
  }

  // Runs at the start of every frame. A resized canvas is cleared, so the frame that resizes it
  // also draws it (see frame()).
  const resize = (): boolean => {
    const w = Math.max(1, canvas.clientWidth)
    const h = Math.max(1, canvas.clientHeight)
    if (!ratioDirty && w === width && h === height) return false
    ratioDirty = false
    width = w
    height = h
    // One buffer allocation; the CSS size stays with .scene. (Skips output.setSize: revisit if
    // post-processing is ever added.)
    renderer.setDrawingBufferSize(w, h, pixelRatio)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    relayout()
    particleUniforms.uAspect.value = camera.aspect
    particleUniforms.uPixelRatio.value = pixelRatio
    bokehUniforms.uPixelRatio.value = pixelRatio
    measureHidden()
    scroll.measure()
    return true
  }

  // The body changes height when an answer opens or the fonts arrive: re-measure the scroll stations
  // only. The canvas size is read in frame().
  const resizeObserver = new ResizeObserver(() => {
    measureHidden()
    scroll.measure()
  })
  resizeObserver.observe(document.body)
  resizeObserver.observe(probe)
  const stopHeroLight = onHeroLightChange(relayout)
  const onLayoutChange = (): void => relayout()
  WIDE_LAYOUT.addEventListener('change', onLayoutChange)
  void document.fonts?.ready.then(() => scroll.measure())

  // Moving the window to a screen with another pixel ratio, or zooming.
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
      // No resize here: it would clear the frame just drawn. The next frame resizes and draws.
      pixelRatio = Math.max(1, pixelRatio - 0.25)
      dprCap = pixelRatio
      ratioDirty = true
    } else if (action === 'fewer-bokeh') {
      bokehCount = Math.floor(bokehCount / 2)
      bokeh.geometry.setDrawRange(0, bokehCount)
    } else if (action === 'fewer-particles' || (action === 'lower-dpr' && pixelRatio <= 1)) {
      drawCount = Math.max(4000, Math.floor(drawCount * 0.65))
      geometry.setDrawRange(0, drawCount)
    } else if (action === 'give-up') {
      // Leave the animation frame before tearing the renderer down.
      queueMicrotask(() => callbacks.onTooSlow())
    }
  }

  const frame = (now: number): void => {
    if (lost) return
    const resized = resize()

    const target = scroll.target()
    const pointerMoving =
      pointer.active && (Math.abs(pointer.target.x - pointerNow.x) > 0.002 || Math.abs(pointer.target.y - pointerNow.y) > 0.002)
    if (Math.abs(target - lastTarget) > 0.0005 || Math.abs(target - state) > 0.01 || pointerMoving || jump !== 'none') {
      lastActivity = now
    }
    lastTarget = target
    const quietFor = now - lastActivity
    const idle = quietFor > IDLE_AFTER_MS
    // Idle frames are slow on purpose (see the constants); the governor skips them below.
    const minInterval = quietFor > DEEP_IDLE_AFTER_MS ? DEEP_IDLE_FRAME_MS : idle ? IDLE_FRAME_MS : ACTIVE_FRAME_MS
    if (!resized && last && now - last < minInterval) return

    const dtMs = last ? now - last : 16.7
    last = now
    const dt = Math.min(dtMs, 100) / 1000
    elapsed += dt
    if (introStart < 0) introStart = elapsed
    const introT = Math.min(1, (elapsed - introStart) / INTRO_SECONDS)
    const intro = 1 - Math.pow(1 - introT, 3)
    const flare = Math.exp(-Math.pow((introT - 0.2) / 0.13, 2))
    if (introT < 1) lastActivity = now

    if (jump === 'none' && Math.abs(target - state) > 1.5) jump = 'out'
    if (jump === 'out') {
      fade = damp(fade, 0, 9, dt)
      if (fade < 0.03) {
        state = target - Math.sign(target - state) * 0.35
        jump = 'in'
      }
    } else {
      state = damp(state, target, 2.6, dt)
      if (jump === 'in') {
        fade = damp(fade, 1, 3.5, dt)
        if (fade > 0.985) {
          fade = 1
          jump = 'none'
        }
      }
    }
    quiet = damp(quiet, scroll.quiet(), 3, dt)
    decide = damp(decide, scroll.decide(), 2.5, dt)
    const calm = 1 - quiet * 0.85
    blendComposition(layouts, state, comp)

    pointerNow.x = damp(pointerNow.x, pointer.target.x, 4, dt)
    pointerNow.y = damp(pointerNow.y, pointer.target.y, 4, dt)
    pointerStrength = damp(pointerStrength, pointer.active ? 1 : 0, 2, dt)

    const pxPerUnit = height / 2 / HALF_HEIGHT
    // One column: the hero light belongs to the hero and scrolls away with it, instead of standing
    // still while the title slides up under it.
    const anchor = wideLayout ? 0 : (window.scrollY / pxPerUnit) * Math.max(0, 1 - state)
    // The sunrise stays above a browser bar that covers the bottom of the 100lvh canvas.
    lift = damp(lift, hiddenPx / pxPerUnit, 3, dt)
    const sunrise = clamp01(state - (STATES - 2))
    light.position.set(comp.x + pointerNow.x * 0.08, comp.y + pointerNow.y * 0.06 + anchor + lift * sunrise, 0)
    light.scale.setScalar(comp.scale * (0.55 + 0.45 * intro))
    particles.rotation.z = comp.turn
    camera.position.x = pointerNow.x * 0.18
    camera.position.y = pointerNow.y * 0.12
    camera.lookAt(0, 0, 0)

    // Keep the apparent density of the tuned reference (1440×900, 36k particles).
    const apparent = pxPerUnit * comp.scale
    const apparentReference = REFERENCE_PX_PER_UNIT * blendComposition(reference, state, referenceComp).scale
    const ratio = apparent / apparentReference
    const density = Math.min(1.2, Math.max(0.25, ratio * ratio * (REFERENCE_COUNT / drawCount)))
    const breathing = breath(elapsed)

    particleUniforms.uTime.value = elapsed
    particleUniforms.uState.value = state
    particleUniforms.uBreath.value = breathing
    particleUniforms.uIntensity.value = comp.intensity * density * fade * calm * (0.15 + 0.85 * intro)
    particleUniforms.uSizeScale.value = Math.min(1.2, Math.max(0.6, Math.sqrt(ratio)))
    particleUniforms.uDim.value = wideLayout ? comp.dim : 0
    particleUniforms.uBand.value.set(comp.bandMin, comp.bandMax)
    particleUniforms.uPointer.value.copy(pointerNow)
    particleUniforms.uPointerStrength.value = pointerStrength * calm
    particleUniforms.uDecide.value = decide
    particleUniforms.uFire.value = comp.fire * calm
    // One column: the net runs under the reading text in every state but the light (hero, sunrise),
    // and there is no clear band to keep flashes in, so they stay low there.
    particleUniforms.uFlash.value = wideLayout ? 1 : 0.3 + 0.7 * comp.glass
    // Release (state 6) has no network: skip the draw call there.
    somas.visible = Math.abs(state - 6) > 0.001
    // The bodies cover what is behind them: under the reading text (one column, outside the glass)
    // they stay faint.
    const underText = wideLayout ? 1 : 0.45 + 0.55 * comp.glass
    somaUniforms.uOpacity.value = comp.intensity * fade * calm * (0.15 + 0.85 * intro) * underText

    // The glass opens up as the camera flies into the light and is gone before the next chapter's
    // title reaches it (comp.glass < 0.35); it closes in again for the kept themes and the final.
    const open = clamp01((comp.glass - 0.35) / 0.65)
    const glassPresence = open * open * (3 - 2 * open) * fade * clamp01((introT - 0.15) / 0.7)
    glass.visible = glassPresence > 0.004
    glass.scale.setScalar((1 + (1 - comp.glass) * 1.1) * (1 + breathing * 0.012))
    glass.rotation.set(0.25 + pointerNow.y * 0.2, elapsed * 0.05 + pointerNow.x * 0.3, 0)
    glassUniforms.uOpacity.value = glassPresence
    glassUniforms.uTime.value = elapsed
    // fade is 1 outside jumps; during a jump the halo goes out with everything else.
    glowUniforms.uStrength.value = comp.glow * fade * calm * (intro + flare * 1.4)

    bokehUniforms.uTravel.value = state * 2.4 + elapsed * 0.12
    bokehUniforms.uTime.value = elapsed
    bokehUniforms.uIntensity.value = comp.bokeh * fade * calm * intro
    bokehUniforms.uDim.value = wideLayout ? comp.dim * 0.8 : 0
    bokehUniforms.uBand.value.set(comp.bandMin, comp.bandMax)

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
    // Idle frames are slow on purpose; only judge the GPU on active ones.
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
  // bfcache: stop when the page is put away, continue when it comes back.
  const onPageHide = (): void => stop()
  const onPageShow = (): void => start()
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('pageshow', onPageShow)

  // three.js calls preventDefault() on context loss itself (so the browser may restore it) and
  // re-initialises its GL state on restore; here we only pause and report.
  const onLost = (): void => {
    lost = true
    firstFrameSent = false // 'on' is published again only after the first restored frame
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

  window.__lioraScene = {
    stats: () => ({
      tier: tier.name,
      particles: drawCount,
      pixelRatio,
      state,
      frames,
      fps,
      quiet,
      fire: particleUniforms.uFire.value,
      draws,
      layout: wideLayout ? 'wide' : 'column',
    }),
    // Renders one frame and reads a 9×9 grid of pixels in the same task (the drawing buffer is
    // still intact before compositing). Returns the luminance of the light (premultiplied, the
    // canvas is transparent), 0..255.
    sample: () => {
      if (lost) return []
      renderer.render(scene, camera)
      const gl = renderer.getContext()
      const out: number[] = []
      const pixel = new Uint8Array(4)
      const w = gl.drawingBufferWidth
      const h = gl.drawingBufferHeight
      for (let gy = 1; gy <= 9; gy++) {
        for (let gx = 1; gx <= 9; gx++) {
          gl.readPixels(Math.floor((w * gx) / 10), Math.floor((h * gy) / 10), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
          out.push(Math.round(0.2126 * pixel[0] + 0.7152 * pixel[1] + 0.0722 * pixel[2]))
        }
      }
      return out
    },
    // Alpha (0–255) of one full row of drawing-buffer pixels at a CSS y, with only the glass drawn:
    // how sharp its outline is, without the halo and particles around it.
    edge: (y: number) => {
      if (lost) return []
      const hidden: Object3D[] = []
      scene.traverse((node) => {
        if (node !== scene && node !== light && node !== glass && node.visible) {
          node.visible = false
          hidden.push(node)
        }
      })
      renderer.render(scene, camera)
      for (const node of hidden) node.visible = true
      const gl = renderer.getContext()
      const ratio = gl.drawingBufferWidth / canvas.clientWidth
      const width = gl.drawingBufferWidth
      const pixels = new Uint8Array(width * 4)
      gl.readPixels(0, Math.round(gl.drawingBufferHeight - y * ratio), width, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
      return Array.from({ length: width }, (_, i) => pixels[i * 4 + 3])
    },
  }

  // Compile every program before the first frame so the fade-in does not stutter, then draw once
  // while the canvas is still invisible (data-gl=loading): the lazy program checks and the driver's
  // pipelines happen here, outside the frames the governor judges.
  resize()
  await renderer.compileAsync(scene, camera)
  renderer.render(scene, camera)
  start()

  return {
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
      dprQuery?.removeEventListener('change', onDprChange)
      WIDE_LAYOUT.removeEventListener('change', onLayoutChange)
      stopHeroLight()
      resizeObserver.disconnect()
      probe.remove()
      pointer.dispose()
      scene.traverse((object) => {
        if (object instanceof Mesh || object instanceof Points) {
          object.geometry.dispose()
          ;(object.material as ShaderMaterial).dispose()
        }
      })
      // Terminal (too slow / failed): release the context now instead of at page unload.
      renderer.dispose()
      renderer.forceContextLoss()
      delete window.__lioraScene
    },
  }
}
