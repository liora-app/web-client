// The one place a WebGLRenderer is made: every scene (the landing, the chat presence, a future
// character) gets the same context, so the fallbacks in boot.ts mean the same thing everywhere.
// The canvas is transparent (the sky behind it is CSS) and the shaders write premultiplied colour.

import { WebGLRenderer } from 'three'

export interface RendererOptions {
  /** Solid landing sculptures need self-occlusion; the chat keeps depth off. */
  depth?: boolean
  /** 0: no multisampling. 4: an antialiased default framebuffer for solid geometry. */
  msaa: 0 | 4
}

/** Throws when WebGL2 cannot be created; boot.ts turns that into the static backdrop. */
export function createRenderer(canvas: HTMLCanvasElement, { msaa, depth = false }: RendererOptions): WebGLRenderer {
  const renderer = new WebGLRenderer({
    canvas,
    antialias: msaa > 0,
    alpha: true,
    premultipliedAlpha: true,
    depth,
    stencil: false,
    // A calm background layer has no business waking a discrete GPU; WebKit also throttles
    // 'high-performance' contexts hard on iPhones.
    powerPreference: 'low-power',
    failIfMajorPerformanceCaveat: true,
  })
  renderer.setClearColor(0x000000, 0)
  return renderer
}
