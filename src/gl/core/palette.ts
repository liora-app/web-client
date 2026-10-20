// WebGL colours, one palette per theme (ADR-012). Keep in sync with the CSS tokens in
// src/styles/tokens.css. Values are sRGB and reach the shaders unconverted: ShaderMaterial without
// <colorspace_fragment> writes them to the sRGB canvas as they are.
// The canvas is transparent and premultiplied (rgb <= alpha); the sky behind it is CSS
// (src/styles/stage.css). On the dark page the light adds up (AdditiveBlending); on paper light
// cannot add anything, so the light theme draws a pearl instead: mid-dark, saturated colours with
// NormalBlending, still premultiplied, and less of them (intensity).

import { Vector3 } from 'three'

export type GlTheme = 'dark' | 'light'

export interface GlPalette {
  glow: string
  /** Multiplies the halo's strength. */
  glowStrength: number
  particleCool: string
  particleWarm: string
  particleHighlight: string
  /** The glass's rim (glass.frag.glsl uTint). */
  glassTint: string
  /** Multiplies the particles' alpha. */
  intensity: number
  /** true: particles add up like light; false: they cover the paper (NormalBlending). */
  additive: boolean
  bokeh: readonly string[]
}

export const GL_PALETTES: Readonly<Record<GlTheme, GlPalette>> = {
  dark: {
    glow: '#ffb070',
    glowStrength: 1,
    particleCool: '#a6dde2',
    particleWarm: '#ffc58f',
    particleHighlight: '#fff4e2',
    glassTint: '#d1edf5',
    intensity: 1,
    additive: true,
    // Out-of-focus light drifting past the camera.
    bokeh: ['#3fb8a8', '#e8a060', '#8f7cff', '#d97a9c', '#a6dde2'],
  },
  light: {
    glow: '#e8894a',
    glowStrength: 0.8,
    particleCool: '#2f8f86',
    particleWarm: '#d9773a',
    particleHighlight: '#c4622c',
    glassTint: '#5b8f8a',
    intensity: 0.55,
    additive: false,
    bokeh: ['#2f8f86', '#d9824a', '#7d6bd6', '#c46a8c', '#5aa9a4'],
  },
}

/** The dark palette: what the landing's light and the chat's evening share. */
export const GL_PALETTE = GL_PALETTES.dark

export function hexToVec3(hex: string): Vector3 {
  const value = Number.parseInt(hex.slice(1), 16)
  return new Vector3(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255)
}
