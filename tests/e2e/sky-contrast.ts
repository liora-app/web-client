// The contrast model of «Аврора» (ADR-013): the sky, its fields and the glass, read from the CSS
// itself (tokens.css, stage.css, landing.css) — the port of the design session's contrast.mjs v2.
// chat-core.spec.ts walks every text token and every sole boundary over every ground built here.
//
// Grounds of a sky (a theme × a preset):
// - every stop of its gradient;
// - every field at its full alpha over every stop, and under the ribbon (the ribbon crosses the whole
//   width, so it may lie over any field);
// - by day, every pair of fields at full alpha over every stop (the day's corner fields are wide);
// - the exact composite of all the layers — stops, ribbon, fields, each with its real falloff — on a
//   grid of points in a 16:9, a 4:3 and a 9:16 window: what the overlaps of the fields really give.
// Composites are sRGB alpha blends, as the browser paints non-premultiplied colours over an opaque
// ground; the blur of a smooth gradient is the gradient itself, so backdrop-filter is not modelled.

export type Rgb = readonly [number, number, number]
export type Colour = Readonly<{ rgb: Rgb; a: number }>
export type Ground = Readonly<{ label: string; rgb: Rgb }>

export function colour(value: string): Colour {
  const v = value.trim()
  const hex = /^#([0-9a-f]{6})$/i.exec(v)
  if (hex) return { rgb: [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)) as unknown as Rgb, a: 1 }
  const rgb = /^rgb\((\d+)[ ,]+(\d+)[ ,]+(\d+)(?:\s*[/,]\s*([\d.]+))?\)$/.exec(v)
  if (!rgb) throw new Error(`not a colour: ${value}`)
  return { rgb: [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])], a: rgb[4] === undefined ? 1 : Number(rgb[4]) }
}

/** An R G B triple of stage.css («70 180 170»). */
export function triple(value: string): Rgb {
  const m = /^(\d+)\s+(\d+)\s+(\d+)$/.exec(value.trim())
  if (!m) throw new Error(`not a triple: ${value}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

const lin = (c: number): number => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4)
export const lum = (c: Rgb): number => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])
export function ratio(a: Rgb, b: Rgb): number {
  const [x, y] = [lum(a), lum(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
export const over = (fg: Rgb, alpha: number, bg: Rgb): Rgb => [0, 1, 2].map((i) => fg[i]! * alpha + bg[i]! * (1 - alpha)) as unknown as Rgb
export const hexOf = (c: Rgb): string => '#' + c.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')

/** The body of the first rule `selector {` at or after `from`, up to its own closing brace. */
export function block(text: string, selector: string, from = 0): string {
  const start = text.indexOf(`${selector} {`, from)
  if (start < 0) throw new Error(`no rule ${selector}`)
  let depth = 0
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return text.slice(start, i)
  }
  throw new Error(`unclosed ${selector}`)
}

export const props = (body: string): Map<string, string> => new Map([...body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.replace(/\s+/g, ' ').trim()]))

const PAIR = /^light-dark\((#[0-9a-f]{6}|rgb\([^)]*\)),\s*(#[0-9a-f]{6}|rgb\([^)]*\))\)$/i

/** The themes of tokens.css: light-dark(<light>, <dark>) of :root:not([data-theme-lock]). */
export function themes(tokensCss: string): Record<'light' | 'dark', (name: string) => Colour> {
  const theme = props(block(tokensCss, ':root:not([data-theme-lock])'))
  const side = (i: 1 | 2) => (name: string): Colour => {
    const m = PAIR.exec(theme.get(name) ?? '')
    if (!m) throw new Error(`--${name} is not light-dark(<colour>, <colour>)`)
    return colour(m[i]!)
  }
  return { light: side(1), dark: side(2) }
}

type Field = Readonly<{ slot: string; rx: number; ry: number; cx: number; cy: number; rgb: Rgb; a: number }>
type Ribbon = Readonly<{ angle: number; from: number; peak: number; to: number; rgb: Rgb; a: number }>
export type Sky = Readonly<{ label: string; stops: readonly Rgb[]; positions: readonly number[]; fields: readonly Field[]; ribbon: Ribbon }>

/** One sky of stage.css: the theme's own block (geometry, alphas) with a preset's triples over it. */
export function sky(label: string, theme: Map<string, string>, preset: Map<string, string>, stopsImage: string): Sky {
  const value = (name: string): string => preset.get(name) ?? theme.get(name) ?? ''
  const image = theme.get('sky-image') ?? ''
  const positions = [...stopsImage.matchAll(/rgb\(var\(--sky-(\d)\)\) (\d+)%/g)].map((m) => Number(m[2]))
  const stops = [...stopsImage.matchAll(/rgb\(var\(--sky-(\d)\)\) (\d+)%/g)].map((m) => triple(value(`sky-${m[1]}`)))
  const fields = [
    ...image.matchAll(
      /radial-gradient\(ellipse ([\d.]+)% ([\d.]+)% at ([\d.]+)% ([\d.]+)%, rgb\(var\(--sky-field-(\d)\) \/ var\(--sky-a-(\d)\)\) 0%, rgb\(var\(--sky-field-\d\) \/ 0\) 100%\)/g,
    ),
  ].map((m) => ({
    slot: m[5]!,
    rx: Number(m[1]) / 100,
    ry: Number(m[2]) / 100,
    cx: Number(m[3]) / 100,
    cy: Number(m[4]) / 100,
    rgb: triple(value(`sky-field-${m[5]}`)),
    a: Number(value(`sky-a-${m[6]}`)),
  }))
  const r = /linear-gradient\((\d+)deg, rgb\(var\(--sky-ribbon\) \/ 0\)(?: (\d+)%)?, rgb\(var\(--sky-ribbon\) \/ var\(--sky-a-ribbon\)\)(?: (\d+)%)?, rgb\(var\(--sky-ribbon\) \/ 0\)(?: (\d+)%)?\)/.exec(image)
  if (!r) throw new Error(`${label}: no ribbon layer`)
  const ribbon = { angle: Number(r[1]), from: Number(r[2] ?? 0) / 100, peak: Number(r[3] ?? 50) / 100, to: Number(r[4] ?? 100) / 100, rgb: triple(value('sky-ribbon')), a: Number(value('sky-a-ribbon')) }
  return { label, stops, positions, fields, ribbon }
}

/** sRGB colour of the stops at t (0 top … 1 bottom), as CSS interpolates opaque stops. */
function stopAt(s: Sky, t: number): Rgb {
  const p = s.positions.map((x) => x / 100)
  if (t <= p[0]!) return s.stops[0]!
  for (let i = 0; i < p.length - 1; i++) {
    if (t <= p[i + 1]!) {
      const k = (t - p[i]!) / (p[i + 1]! - p[i]! || 1)
      return [0, 1, 2].map((c) => s.stops[i]![c]! + (s.stops[i + 1]![c]! - s.stops[i]![c]!) * k) as unknown as Rgb
    }
  }
  return s.stops[s.stops.length - 1]!
}

/** The grounds text may stand on in this sky (see the header). */
export function grounds(s: Sky, pairs: boolean): Ground[] {
  const out: Ground[] = []
  const live = s.fields.filter((f) => f.a > 0)
  for (const [i, stop] of s.stops.entries()) {
    const at = `${s.label} stop ${i + 1}`
    out.push({ label: at, rgb: stop })
    if (s.ribbon.a > 0) out.push({ label: `${at} + ribbon`, rgb: over(s.ribbon.rgb, s.ribbon.a, stop) })
    for (const f of live) {
      const g = over(f.rgb, f.a, stop)
      out.push({ label: `${at} + field ${f.slot}`, rgb: g })
      if (s.ribbon.a > 0) out.push({ label: `${at} + field ${f.slot} + ribbon`, rgb: over(s.ribbon.rgb, s.ribbon.a, g) })
      if (pairs) for (const h of live) if (h.slot > f.slot) out.push({ label: `${at} + fields ${f.slot}+${h.slot}`, rgb: over(h.rgb, h.a, g) })
    }
  }
  return out
}

/** The exact composite of every layer at a grid of points in each window (w × h). */
export function sampled(s: Sky, windows: readonly (readonly [number, number])[] = [[1600, 900], [1200, 900], [412, 839]], n = 33): Ground[] {
  const out: Ground[] = []
  const rad = (s.ribbon.angle * Math.PI) / 180
  for (const [w, h] of windows) {
    const length = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad))
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const x = (w * i) / (n - 1)
        const y = (h * j) / (n - 1)
        let c = stopAt(s, y / h)
        const t = 0.5 + ((x - w / 2) * Math.sin(rad) - (y - h / 2) * Math.cos(rad)) / length
        const { from, peak, to } = s.ribbon
        const k = t <= from || t >= to ? 0 : t <= peak ? (t - from) / (peak - from || 1) : (to - t) / (to - peak || 1)
        c = over(s.ribbon.rgb, s.ribbon.a * k, c)
        // The first layer of the list is painted last (on top).
        for (const f of [...s.fields].reverse()) {
          const d = Math.hypot((x - f.cx * w) / (f.rx * w), (y - f.cy * h) / (f.ry * h))
          c = over(f.rgb, f.a * Math.max(0, 1 - d), c)
        }
        out.push({ label: `${s.label} ${w}×${h} at ${Math.round(x)},${Math.round(y)}`, rgb: c })
      }
    }
  }
  return out
}

/** The extreme ground: the darkest by day (dark text), the lightest at night (light text). */
export function worst(list: readonly Ground[], day: boolean): Ground {
  return list.reduce((a, b) => ((day ? lum(b.rgb) < lum(a.rgb) : lum(b.rgb) > lum(a.rgb)) ? b : a))
}

export type Check = Readonly<{ pair: string; ratio: number; min: number }>
export function checkAll(fgs: Readonly<Record<string, Rgb>>, list: readonly Ground[], min: number): Check[] {
  const out: Check[] = []
  for (const [name, fg] of Object.entries(fgs)) for (const g of list) out.push({ pair: `${name} ${hexOf(fg)} on ${g.label} ${hexOf(g.rgb)}`, ratio: ratio(fg, g.rgb), min })
  return out
}

// ---------------------------------------------------------------- the landing's section skies
// landing.css gives each section two lists, --sky-fields (translucent: radial fields, linear ribbons)
// over --sky-stops (opaque), in literal colours. Grounds: every stop; every field and every ribbon
// over every stop; every field under every ribbon; by day (outside the night band) every pair of
// fields too. In the dark the fields never meet — fieldsMeet() checks it, the drift included.

/** The top-level layers of a background-image list (commas inside functions do not split). */
export function layers(image: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < image.length; i++) {
    const c = image[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ',' && depth === 0) {
      out.push(image.slice(start, i).trim())
      start = i + 1
    }
  }
  const last = image.slice(start).trim()
  if (last) out.push(last)
  return out.filter((layer) => layer !== 'none')
}

/** The colours of a layer that paint something (alpha above 0). */
export function colours(layer: string): Colour[] {
  return [...layer.matchAll(/#[0-9a-f]{6}\b|rgb\([^)]*\)/gi)].map((m) => colour(m[0])).filter((c) => c.a > 0)
}

export type Ellipse = Readonly<{ rx: number; ry: number; cx: number; cy: number; sign: number }>
export type SectionSky = Readonly<{ label: string; stops: readonly Rgb[]; fields: readonly Colour[]; ribbons: readonly Colour[]; ellipses: readonly Ellipse[] }>

/** One section's sky from its two lists. */
export function sectionSky(label: string, fieldsList: string, stopsList: string): SectionSky {
  const stops = layers(stopsList).flatMap(colours)
  if (stops.length === 0 || stops.some((c) => c.a !== 1)) throw new Error(`${label}: --sky-stops must be opaque colours`)
  const fields: Colour[] = []
  const ribbons: Colour[] = []
  const ellipses: Ellipse[] = []
  for (const layer of layers(fieldsList)) {
    const strongest = colours(layer).reduce((a, b) => (b.a > a.a ? b : a))
    if (layer.startsWith('linear-gradient(')) ribbons.push(strongest)
    else if (layer.startsWith('radial-gradient(')) {
      fields.push(strongest)
      const e = /ellipse ([\d.]+)% ([\d.]+)% at (?:calc\(([\d.]+)% ([+-]) var\(--drift, 0%\)\)|([\d.]+)%) ([\d.]+)%/.exec(layer)
      if (e) ellipses.push({ rx: Number(e[1]) / 100, ry: Number(e[2]) / 100, cx: Number(e[3] ?? e[5]) / 100, cy: Number(e[6]) / 100, sign: e[4] === '-' ? -1 : e[4] === '+' ? 1 : 0 })
      else if (!/^radial-gradient\(circle /.test(layer)) throw new Error(`${label}: a field of an unknown shape: ${layer}`)
    } else throw new Error(`${label}: an unknown layer: ${layer}`)
  }
  return { label, stops: stops.map((c) => c.rgb), fields, ribbons, ellipses }
}

/** The grounds of a section sky (see above). */
export function sectionGrounds(s: SectionSky, pairs: boolean): Ground[] {
  const out: Ground[] = []
  for (const [i, stop] of s.stops.entries()) {
    const at = `${s.label} stop ${i + 1}`
    out.push({ label: at, rgb: stop })
    for (const r of s.ribbons) out.push({ label: `${at} + ribbon`, rgb: over(r.rgb, r.a, stop) })
    for (const [j, f] of s.fields.entries()) {
      const g = over(f.rgb, f.a, stop)
      out.push({ label: `${at} + field ${j + 1}`, rgb: g })
      for (const r of s.ribbons) out.push({ label: `${at} + field ${j + 1} + ribbon`, rgb: over(r.rgb, r.a, g) })
      if (pairs) for (const [k, h] of s.fields.entries()) if (k > j) out.push({ label: `${at} + fields ${j + 1}+${k + 1}`, rgb: over(h.rgb, h.a, g) })
    }
  }
  return out
}

/** Whether two fields of a sky meet anywhere in the section's box at any drift in [0, amplitude]
 *  (positions in fractions of the box, so the answer holds for every aspect ratio). */
export function fieldsMeet(s: SectionSky, amplitude: number, steps = 8, grid = 100): string[] {
  const met: string[] = []
  for (let a = 0; a < s.ellipses.length; a++) {
    for (let b = a + 1; b < s.ellipses.length; b++) {
      search: for (let k = 0; k <= steps; k++) {
        const d = (amplitude * k) / steps
        const [e, f] = [s.ellipses[a]!, s.ellipses[b]!]
        for (let i = 0; i <= grid; i++) {
          for (let j = 0; j <= grid; j++) {
            const [u, v] = [i / grid, j / grid]
            const inE = ((u - e.cx - e.sign * d) / e.rx) ** 2 + ((v - e.cy) / e.ry) ** 2 < 1
            const inF = ((u - f.cx - f.sign * d) / f.rx) ** 2 + ((v - f.cy) / f.ry) ** 2 < 1
            if (inE && inF) {
              met.push(`${s.label}: fields ${a + 1} and ${b + 1} meet at ${u.toFixed(2)},${v.toFixed(2)} (drift ${d.toFixed(3)})`)
              break search
            }
          }
        }
      }
    }
  }
  return met
}
