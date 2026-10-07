// Decides whether the WebGL scene runs and publishes the outcome on <html>:
//   data-gl="loading"  the scene is wanted and starting (chunk, shaders, first frame)
//   data-gl="on"       WebGL2 context alive and the first frame is on screen
//   data-gl="off"      static CSS backdrop; data-gl-reason says why
// The page is complete without the scene: all text lives in the DOM, the canvas is decorative.
// Which scene runs is the page's choice (BootOptions.load); the reasons to stay static are the same
// for every scene. bootGL returns a GlControl: the page reaches the scene's own handle (the chat's
// setPresence/pulse) and can suspend the scene (a hidden slot) without it counting as a reason
// to stay static. This module lands in the page's entry chunk: type-only imports from the GL side,
// so three.js stays in the lazy scene chunk.

import { motionAllowed, onMotionChange, systemReducesMotion } from '../../ui/motion'
import type { TierName } from './quality'

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

export interface SceneOptions {
  /** Forces a quality tier (pickTier({ force })); without it: ?tier, then the device. */
  tier?: TierName
  /** Replaces the tier's DPR cap; the frame governor may still lower it. */
  dprCap?: number
  /** The element whose box the scene fills (the chat's slot). The landing scene ignores it: its
   *  canvas is the full-screen .scene layer. */
  sizeTo?: HTMLElement
}

/** What a lazily imported scene module (../scene, the chat's ../presence) exports. H is the
 *  scene's own handle: SceneHandle plus whatever the page drives (the chat's setPresence, pulse). */
export interface SceneModule<H extends SceneHandle = SceneHandle> {
  createScene(canvas: HTMLCanvasElement, callbacks: SceneCallbacks, options?: SceneOptions): Promise<H>
}

export interface BootOptions<H extends SceneHandle = SceneHandle> extends SceneOptions {
  /** Loads the scene module as its own chunk: () => import('./gl/scene'). */
  load: () => Promise<SceneModule<H>>
  /** Called once, when the scene exists and is already paused or running as it should be:
   *  the place to apply the page's current state to it (the chat's data-presence). */
  onReady?: (handle: H) => void
}

/** What bootGL gives back to the page. The landing ignores it. */
export interface GlControl<H extends SceneHandle = SceneHandle> {
  /** The live scene, or null before it started and after it gave up (slow, error, …).
   *  Read it each time instead of keeping the onReady argument. */
  handle(): H | null
  /** false pauses the scene and keeps it paused through every later sync (motion toggle,
   *  forced colors, a restored context) until true. Not a reason to stay static: data-gl and
   *  data-gl-reason do not change. */
  setActive(active: boolean): void
}

export type GlReason =
  | 'reduced-motion'
  | 'user'
  | 'forced-colors'
  | 'save-data'
  | 'no-webgl2'
  | 'software'
  | 'slow'
  | 'context-lost'
  | 'error'

const root = document.documentElement
const forcedColors = window.matchMedia('(forced-colors: active)')

export function setGlStatus(status: 'loading' | 'on' | 'off', reason?: GlReason): void {
  root.dataset.gl = status
  if (reason) root.dataset.glReason = reason
  else delete root.dataset.glReason
}

// Software rasterizers (SwiftShader, llvmpipe, WARP) would burn the CPU for a decorative layer.
// failIfMajorPerformanceCaveat does not catch them in current Chromium, so check the renderer name.
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render/i

function probeWebGL2(): 'ok' | 'none' | 'software' {
  if (typeof WebGL2RenderingContext === 'undefined') return 'none'
  try {
    const probe = document.createElement('canvas')
    const gl = probe.getContext('webgl2', { failIfMajorPerformanceCaveat: true })
    if (!gl) return 'none'
    let renderer = String(gl.getParameter(gl.RENDERER) ?? '')
    // Chromium and Safari mask RENDERER; the debug extension still names the real device.
    if (!SOFTWARE_RENDERER.test(renderer) && /^webkit/i.test(renderer)) {
      const info = gl.getExtension('WEBGL_debug_renderer_info')
      if (info) renderer = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? renderer)
    }
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return SOFTWARE_RENDERER.test(renderer) ? 'software' : 'ok'
  } catch {
    return 'none'
  }
}

function saveDataRequested(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
  return connection?.saveData === true
}

// Start the scene only after the page has painted its text (LCP) and the main thread is idle.
function afterFirstPaint(task: () => void): void {
  const schedule = (): void => {
    if ('requestIdleCallback' in window) window.requestIdleCallback(task, { timeout: 1500 })
    else setTimeout(task, 200)
  }
  if (document.readyState === 'complete') schedule()
  else window.addEventListener('load', schedule, { once: true })
}

export function bootGL<H extends SceneHandle = SceneHandle>(
  canvas: HTMLCanvasElement,
  { load, onReady, ...sceneOptions }: BootOptions<H>,
): GlControl<H> {
  let handle: H | null = null
  let starting = false
  let drawn = false
  let contextLost = false
  // The page put the scene away (GlControl.setActive(false)): paused, but not a fallback reason.
  let suspended = false
  // Set once the scene proved it cannot run here; the static backdrop then stays for this visit.
  let unavailable: GlReason | null = null

  // Why the scene must not animate right now, most fundamental reason first.
  const offReason = (): GlReason | null => {
    if (unavailable) return unavailable
    // Windows High Contrast and similar: a bitmap cannot follow the user's palette.
    if (forcedColors.matches) return 'forced-colors'
    if (saveDataRequested()) return 'save-data'
    if (!motionAllowed()) return systemReducesMotion() ? 'reduced-motion' : 'user'
    if (contextLost) return 'context-lost'
    return null
  }

  // Brings the scene and the published status in line with the current facts. Safe to call
  // from any event, any number of times.
  const sync = (): void => {
    const reason = offReason()
    if (reason) {
      handle?.pause()
      setGlStatus('off', reason)
    } else if (handle) {
      if (suspended) handle.pause()
      else handle.resume()
      setGlStatus(drawn ? 'on' : 'loading')
    } else if (!starting) {
      starting = true
      setGlStatus('loading')
      afterFirstPaint(() => void start())
    }
  }

  const fail = (reason: GlReason): void => {
    unavailable = reason
    handle?.destroy()
    handle = null
    sync()
  }

  const callbacks: SceneCallbacks = {
    onFirstFrame: () => {
      drawn = true
      sync()
    },
    onContextLost: () => {
      contextLost = true
      drawn = false // 'on' again only after the first restored frame (see the top of this file)
      sync()
    },
    onContextRestored: () => {
      contextLost = false
      sync()
    },
    onTooSlow: () => fail('slow'),
  }

  const start = async (): Promise<void> => {
    // The facts may have changed while waiting for an idle moment.
    if (offReason()) {
      starting = false
      sync()
      return
    }
    const support = probeWebGL2()
    if (support !== 'ok') {
      starting = false
      fail(support === 'software' ? 'software' : 'no-webgl2')
      return
    }
    try {
      const { createScene } = await load()
      handle = await createScene(canvas, callbacks, sceneOptions)
    } catch (error) {
      console.error('[liora] WebGL scene failed to start', error)
      starting = false
      fail('error')
      return
    }
    starting = false
    sync()
    // Outside the try: a bug in the page's handler must not tear down a working scene.
    if (handle) onReady?.(handle)
  }

  onMotionChange(() => sync())
  forcedColors.addEventListener('change', () => sync())
  sync()

  return {
    handle: () => handle,
    setActive: (active) => {
      suspended = !active
      sync()
    },
  }
}
