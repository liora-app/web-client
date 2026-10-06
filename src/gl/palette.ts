// WebGL colours. Keep in sync with the CSS tokens in src/styles/tokens.css.
// Values are sRGB and reach the shaders unconverted: ShaderMaterial without
// <colorspace_fragment> writes them to the sRGB canvas as they are.
// The canvas is transparent: the night sky behind it is CSS (src/styles/stage.css).

import { Vector3 } from 'three'

export const GL_PALETTE = {
  glow: '#ffb070',
  particleCool: '#a6dde2',
  particleWarm: '#ffc58f',
  particleHighlight: '#fff4e2',
  // Out-of-focus light drifting past the camera.
  bokeh: ['#3fb8a8', '#e8a060', '#8f7cff', '#d97a9c', '#a6dde2'],
} as const

export function hexToVec3(hex: string): Vector3 {
  const value = Number.parseInt(hex.slice(1), 16)
  return new Vector3(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255)
}
