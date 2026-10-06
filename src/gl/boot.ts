// Decides whether the WebGL scene runs and publishes the outcome on <html>:
//   data-gl="loading"  the scene is wanted and starting (chunk, shaders, first frame)
//   data-gl="on"       WebGL2 context alive and the first frame is on screen
//   data-gl="off"      static CSS backdrop; data-gl-reason says why
// The page is complete without the scene: all text lives in the DOM, the canvas is decorative.

import { motionAllowed, onMotionChange, systemReducesMotion } from '../ui/motion'
import type { SceneHandle } from './scene'

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

export function bootGL(canvas: HTMLCanvasElement): void {
  let handle: SceneHandle | null = null
  let starting = false
  let drawn = false
  let contextLost = false
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
      handle.resume()
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
      const { createScene } = await import('./scene')
      handle = await createScene(canvas, {
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
      })
    } catch (error) {
      console.error('[liora] WebGL scene failed to start', error)
      starting = false
      fail('error')
      return
    }
    starting = false
    sync()
  }

  onMotionChange(() => sync())
  forcedColors.addEventListener('change', () => sync())
  sync()
}
