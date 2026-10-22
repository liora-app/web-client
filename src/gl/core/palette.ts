// WebGL colours, one palette per theme (ADR-012). Keep in sync with the CSS tokens in
// src/styles/tokens.css. Values are sRGB and reach the shaders unconverted: ShaderMaterial without
// <colorspace_fragment> writes them to the sRGB canvas as they are.
// The canvas is transparent and premultiplied (rgb <= alpha); the sky behind it is CSS
// (src/styles/stage.css). On the dark page the light adds up (AdditiveBlending); on paper light
// cannot add anything, so the light theme draws a pearl instead (the chat), or ink on paper (the
// landing's scene, ScenePalette): mid-dark, saturated colours with NormalBlending, still
// premultiplied, and less of them (intensity, alpha). The theme event swaps these values in place.

import { Vector3 } from 'three'

export type GlTheme = 'dark' | 'light'

/** sRGB channels 0–1, as the shaders had them inline: the dark values are those literals, unchanged. */
export type Rgb = readonly [number, number, number]

/** The landing's scene (src/gl/scene.ts): luminous field (filaments, inner, orbits), motes, the
 *  atmosphere behind them, the contour portrait (head and trails) and the conversation drawing
 *  (lines and their glow). The same formulas in both themes; only these numbers change.
 *  - additive: the night adds light (AdditiveBlending); by day ink covers the paper (NormalBlending,
 *    still premultiplied, rgb <= alpha).
 *  - *.alpha multiplies a layer's alpha: by day overlapping strokes add up to coverage, not to
 *    brightness, so they are thinner.
 *  - portrait.over: 0 adds the lines and the rim to the skin (light on a dark head); 1 mixes the skin
 *    towards them (ink on a paper head). lineGain keeps that mix at or under 1. */
export interface ScenePalette {
  additive: boolean
  field: { blue: Rgb; mint: Rgb; gold: Rgb; flash: Rgb; alpha: number }
  motes: { cool: Rgb; warm: Rgb; alpha: number }
  atmosphere: { cool: Rgb; warm: Rgb; alpha: number }
  portrait: {
    cyan: Rgb
    violet: Rgb
    coral: Rgb
    skin: Rgb
    skinLit: Rgb
    over: number
    lineGain: number
    sheen: number
    rim: number
  }
  trails: { violet: Rgb; teal: Rgb; alpha: number }
  conversation: { cyan: Rgb; gold: Rgb; flash: Rgb; alpha: number }
}

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
  /** The landing's scene. */
  scene: ScenePalette
}

/** Night: the colours the landing's shaders were written with. */
const NIGHT_SCENE: ScenePalette = {
  additive: true,
  field: { blue: [0.12, 0.37, 0.95], mint: [0.26, 0.95, 0.85], gold: [1.0, 0.66, 0.3], flash: [0.87, 0.99, 0.95], alpha: 1 },
  motes: { cool: [0.34, 0.82, 1.0], warm: [1.0, 0.78, 0.47], alpha: 1 },
  atmosphere: { cool: [0.07, 0.37, 0.52], warm: [0.8, 0.32, 0.09], alpha: 1 },
  portrait: {
    cyan: [0.06, 0.79, 0.94],
    violet: [0.32, 0.24, 0.83],
    coral: [1.0, 0.25, 0.16],
    skin: [0.009, 0.019, 0.033],
    skinLit: [0.013, 0.056, 0.085],
    over: 0,
    lineGain: 1,
    sheen: 0.22,
    rim: 0.11,
  },
  trails: { violet: [0.48, 0.2, 0.64], teal: [0.07, 0.67, 0.8], alpha: 1 },
  conversation: { cyan: [0.13, 0.78, 0.91], gold: [1.0, 0.68, 0.32], flash: [0.94, 1.0, 0.97], alpha: 1 },
}

/** Day, «ранковий папір»: the tokens' teal ink (--color-ai #0e5c55) and terracotta (--color-accent
 *  #b5532a), a deeper ink where the night flashes white; a paper head (#f6f1ea) drawn in ink; the
 *  atmosphere a pale wash, not smoke. */
const DAY_SCENE: ScenePalette = {
  additive: false,
  field: { blue: [0.07, 0.29, 0.42], mint: [0.05, 0.42, 0.38], gold: [0.71, 0.33, 0.16], flash: [0.48, 0.2, 0.08], alpha: 0.55 },
  motes: { cool: [0.08, 0.4, 0.42], warm: [0.71, 0.36, 0.18], alpha: 0.7 },
  atmosphere: { cool: [0.82, 0.9, 0.88], warm: [0.98, 0.85, 0.72], alpha: 0.8 },
  portrait: {
    cyan: [0.05, 0.36, 0.33],
    violet: [0.27, 0.24, 0.5],
    coral: [0.71, 0.3, 0.15],
    skin: [0.89, 0.87, 0.83],
    skinLit: [0.075, 0.07, 0.065],
    over: 1,
    lineGain: 0.7,
    sheen: 0,
    rim: 0.45,
  },
  trails: { violet: [0.3, 0.25, 0.52], teal: [0.05, 0.4, 0.4], alpha: 1 },
  conversation: { cyan: [0.05, 0.4, 0.38], gold: [0.71, 0.33, 0.16], flash: [0.48, 0.2, 0.08], alpha: 0.9 },
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
    scene: NIGHT_SCENE,
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
    scene: DAY_SCENE,
  },
}

/** The dark palette: what the landing's light and the chat's evening share. */
export const GL_PALETTE = GL_PALETTES.dark

export function hexToVec3(hex: string): Vector3 {
  const value = Number.parseInt(hex.slice(1), 16)
  return new Vector3(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255)
}

/** A uniform's vec3 takes a palette colour in place (no new objects per switch). */
export function setRgb(target: Vector3, rgb: Rgb): Vector3 {
  return target.set(rgb[0], rgb[1], rgb[2])
}
