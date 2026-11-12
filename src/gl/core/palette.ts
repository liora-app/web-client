// WebGL colours, one palette per theme (ADR-012). Keep in sync with the CSS tokens in
// src/styles/tokens.css («Аврора», ADR-013). Values are sRGB and reach the shaders unconverted: ShaderMaterial without
// <colorspace_fragment> writes them to the sRGB canvas as they are.
// The canvas is transparent and premultiplied (rgb <= alpha); the sky behind it is CSS
// (src/styles/stage.css). On the dark page the light adds up (AdditiveBlending); on paper light
// cannot add anything, so the light theme draws a pearl instead (the chat), or ink on paper (the
// landing's scene, ScenePalette): mid-dark, saturated colours with NormalBlending, still
// premultiplied. The theme event swaps these values in place.

import { Vector3 } from 'three'

export type GlTheme = 'dark' | 'light'

/** sRGB channels 0–1, as the shaders had them inline: the dark values are those literals, unchanged. */
export type Rgb = readonly [number, number, number]

/** The landing's scene (src/gl/scene.ts): luminous field (filaments, inner, orbits), motes, the
 *  atmosphere behind them and the contour portrait (head and trails). The same formulas in both themes; only these numbers change.
 *  - additive: the night adds light (AdditiveBlending); by day ink covers the paper (NormalBlending,
 *    still premultiplied, rgb <= alpha).
 *  - *.alpha multiplies a layer's alpha. At night faint strokes sum to brightness; by day each stroke
 *    only covers the paper, so the field and the motes need MORE alpha than at night (the shader
 *    clamps each fragment at 1). At 0.55 the hero sphere measured 1.2 % of pixels at >= 1.5:1 to the
 *    paper; at 2.4, 25.5 % (the night: 17.5 %), web-client#22.
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

/** Exact sRGB palette values from Figma 122:2, without linear colour conversion. */
function rgb(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16)
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255]
}

/** Night: the original dark mascot's aqua, blue and warm gold. */
const NIGHT_SCENE: ScenePalette = {
  additive: true,
  field: { blue: rgb('#2b5b7c'), mint: rgb('#84f7eb'), gold: rgb('#f6be85'), flash: rgb('#f4faff'), alpha: 1 },
  motes: { cool: rgb('#9afbf0'), warm: rgb('#f6be85'), alpha: 1 },
  atmosphere: { cool: rgb('#2b5b7c'), warm: rgb('#8b5a44'), alpha: 1 },
  portrait: {
    cyan: rgb('#84f7eb'),
    violet: rgb('#2b5b7c'),
    coral: rgb('#f6be85'),
    skin: rgb('#132440'),
    skinLit: rgb('#1b355c'),
    over: 0,
    lineGain: 1,
    sheen: 0.22,
    rim: 0.11,
  },
  trails: { violet: rgb('#2b5b7c'), teal: rgb('#84f7eb'), alpha: 1 },
}

/** Day, «світанок» (ADR-013): the strokes are --color-stroke #164a4d and the warm --color-light
 *  #6b2208 — opaque ink, ≥ 3:1 to every stop of the day's sky and to the sun disc (the light
 *  sphere's translucent lines had 1.53:1 and 1.29:1 on paper); the alpha is raised so a single stroke
 *  is near opaque (the final's text column is protected in field.frag.glsl); a peach head (#f8c6a0, the
 *  sky of #mind) drawn in ink; the atmosphere a light wash, not smoke. */
const DAY_SCENE: ScenePalette = {
  additive: false,
  field: { blue: rgb('#164a4d'), mint: rgb('#164a4d'), gold: rgb('#6b2208'), flash: rgb('#6b2208'), alpha: 3 },
  motes: { cool: rgb('#164a4d'), warm: rgb('#8f3414'), alpha: 1.4 },
  atmosphere: { cool: rgb('#c6e1c8'), warm: rgb('#f7deb6'), alpha: 0.6 },
  portrait: {
    cyan: rgb('#164a4d'),
    violet: rgb('#164a4d'),
    coral: rgb('#6b2208'),
    skin: rgb('#f8c6a0'),
    skinLit: rgb('#0f2e31'),
    over: 1,
    lineGain: 0.7,
    sheen: 0,
    rim: 0.45,
  },
  trails: { violet: rgb('#164a4d'), teal: rgb('#37968e'), alpha: 1 },
}

export const GL_PALETTES: Readonly<Record<GlTheme, GlPalette>> = {
  dark: {
    glow: '#f6be85',
    glowStrength: 1,
    particleCool: '#9afbf0',
    particleWarm: '#f6be85',
    particleHighlight: '#f4faff',
    glassTint: '#f4faff',
    intensity: 1,
    additive: true,
    // Out-of-focus light drifting past the camera.
    bokeh: ['#84f7eb', '#f6be85', '#2b5b7c', '#8b5a44', '#9afbf0'],
    scene: NIGHT_SCENE,
  },
  // Day (ADR-013): ink and ember particles on the sun disc — --color-stroke, --color-light,
  // --color-crisis-ink — near opaque; the halo the sun's own peach.
  light: {
    glow: '#f8c6a0',
    glowStrength: 0.8,
    particleCool: '#164a4d',
    particleWarm: '#6b2208',
    particleHighlight: '#8f3414',
    glassTint: '#164a4d',
    intensity: 0.9,
    additive: false,
    bokeh: ['#164a4d', '#6b2208', '#164a4d', '#8f3414', '#164a4d'],
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
