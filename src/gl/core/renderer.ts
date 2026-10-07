// The one place a WebGLRenderer is made: every scene (the landing, the chat presence, a future
// character) gets the same context, so the fallbacks in boot.ts mean the same thing everywhere.
// The canvas is transparent (the sky behind it is CSS) and the shaders write premultiplied colour.

import { WebGLRenderer } from 'three'

export interface RendererOptions {
  /** 0: no multisampling (the landing smooths its edges in the shaders). 4: an antialiased default
   *  framebuffer for a scene with hard geometry edges (the character, phase 4). */
  msaa: 0 | 4
}

/** Throws when WebGL2 cannot be created; boot.ts turns that into the static backdrop. */
export function createRenderer(canvas: HTMLCanvasElement, { msaa }: RendererOptions): WebGLRenderer {
  const renderer = new WebGLRenderer({
    canvas,
    antialias: msaa > 0,
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
  return renderer
}
