// The networks the particle story is told with: somas (cell bodies, instanced spheres in scene.ts),
// axons between them and dendrites around them. Particles draw the axons, the dendrites, a halo
// around each soma and, in the light, a warm glow. In every net a signal leaves the root of a
// spanning tree and reaches each level one axon later (see particles.vert.glsl).

import { type Vec3, gaussian, onSphere } from './random'

/** Soma instances: enough for the largest net (the chain); smaller nets leave the rest at radius 0. */
export const SOMAS = 28
/** Axon lengths between two signals: core, chain, theses, diary. */
export const WAVE_PERIOD: [number, number, number, number] = [4, 5, 3, 5]

export interface Soma {
  p: Vec3
  r: number
  depth: number // tree level plus a phase offset, in axon lengths
  dropped: boolean // a thesis let go at step 4
}

interface Axon {
  from: number
  to: number
  ctrl: Vec3
  /** Cumulative length at LUT_STEPS + 1 evenly spaced t, for sampling by arc length. */
  lut: Float32Array
  length: number
}

interface Dendrite {
  soma: number
  ctrl: Vec3
  tip: Vec3
}

export interface Net {
  somas: Soma[]
  axons: Axon[]
  dendrites: Dendrite[]
  axonLength: number
}

/** Shares of a net's particles; the rest draw dendrites. */
interface Mix {
  glow: number
  halo: number
  axon: number
}

const LUT_STEPS = 32
// The core's soma centres; with dendrites and halo everything stays within CORE_LIMIT (glass: 1.14).
const CORE_RADIUS = 0.76
export const CORE_LIMIT = 0.9

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2])
const distance = (a: Vec3, b: Vec3): number => length(sub(a, b))
const limited = (p: Vec3, limit: number): Vec3 => (length(p) > limit ? scale(p, limit / length(p)) : p)
const jittered = (p: Vec3, rand: () => number, amount: number): Vec3 =>
  add(p, [gaussian(rand) * amount, gaussian(rand) * amount, gaussian(rand) * amount])

function bezier(a: Vec3, c: Vec3, b: Vec3, t: number): Vec3 {
  const u = 1 - t
  return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1], u * u * a[2] + 2 * u * t * c[2] + t * t * b[2]]
}

// A random unit vector perpendicular to `dir`; `flat` < 1 keeps it closer to the screen plane.
function perpendicular(dir: Vec3, rand: () => number, flat = 1): Vec3 {
  const d = scale(dir, 1 / Math.max(length(dir), 1e-6))
  const r = onSphere(rand)
  r[2] *= flat
  const p = sub(r, scale(d, r[0] * d[0] + r[1] * d[1] + r[2] * d[2]))
  return scale(p, 1 / Math.max(length(p), 1e-6))
}

function axon(somas: Soma[], from: number, to: number, curl: number, rand: () => number, flat = 1): Axon {
  const a = somas[from].p
  const b = somas[to].p
  const ab = sub(b, a)
  const ctrl = add(scale(add(a, b), 0.5), scale(perpendicular(ab, rand, flat), length(ab) * curl))
  const lut = new Float32Array(LUT_STEPS + 1)
  let prev = a
  for (let i = 1; i <= LUT_STEPS; i++) {
    const p = bezier(a, ctrl, b, i / LUT_STEPS)
    lut[i] = lut[i - 1] + distance(prev, p)
    prev = p
  }
  return { from, to, ctrl, lut, length: lut[LUT_STEPS] }
}

// Curve parameter at a fraction `u` of the arc length: particles spread evenly along the axon and
// the signal moves at a constant speed.
function atLength(axon: Axon, u: number): number {
  const target = u * axon.length
  let i = 1
  while (i < LUT_STEPS && axon.lut[i] < target) i++
  const span = axon.lut[i] - axon.lut[i - 1] || 1
  return (i - 1 + (target - axon.lut[i - 1]) / span) / LUT_STEPS
}

function dendrites(somas: Soma[], count: () => number, reach: [number, number], rand: () => number, limit = Infinity): Dendrite[] {
  const out: Dendrite[] = []
  somas.forEach((soma, index) => {
    for (let k = count(); k > 0; k--) {
      const dir = onSphere(rand)
      const len = reach[0] + rand() * (reach[1] - reach[0])
      const tip = limited(add(soma.p, scale(dir, soma.r + len)), limit)
      const ctrl = add(add(soma.p, scale(dir, soma.r + len * 0.5)), scale(perpendicular(dir, rand), len * 0.35))
      out.push({ soma: index, ctrl, tip })
    }
  })
  return out
}

function net(somas: Soma[], axons: Axon[], dendriteList: Dendrite[]): Net {
  return { somas, axons, dendrites: dendriteList, axonLength: axons.reduce((sum, a) => sum + a.length, 0) }
}

// Prim's spanning tree from `root`: every axon points from parent to child, depth = tree level.
function spanningTree(somas: Soma[], root: number, curl: number, rand: () => number): Axon[] {
  const axons: Axon[] = []
  const inTree = new Set([root])
  somas[root].depth = 0
  while (inTree.size < somas.length) {
    let best: [number, number] | null = null
    let bestDistance = Infinity
    for (const a of inTree) {
      for (let b = 0; b < somas.length; b++) {
        if (inTree.has(b)) continue
        const d = distance(somas[a].p, somas[b].p)
        if (d < bestDistance) {
          bestDistance = d
          best = [a, b]
        }
      }
    }
    if (!best) break
    somas[best[1]].depth = somas[best[0]].depth + 1
    axons.push(axon(somas, best[0], best[1], curl * (0.5 + rand()), rand))
    inTree.add(best[1])
  }
  return axons
}

/** State 0 (and 1, 7): a ball of neurons inside the glass. */
export function buildCore(rand: () => number): Net {
  const COUNT = 24
  const somas: Soma[] = []
  let guard = 0
  while (somas.length < COUNT && guard++ < 40000) {
    const p = scale(onSphere(rand), CORE_RADIUS * Math.cbrt(rand()))
    if (somas.every((s) => distance(s.p, p) > 0.22)) somas.push({ p, r: 0.045 + rand() * 0.02, depth: 0, dropped: false })
  }
  let root = 0
  somas.forEach((s, i) => {
    if (length(s.p) < length(somas[root].p)) root = i
  })
  const axons = spanningTree(somas, root, 0.3, rand)
  // Short loops, so it reads as a network rather than a tree.
  const linked = new Set(axons.map((a) => `${Math.min(a.from, a.to)}:${Math.max(a.from, a.to)}`))
  const extra: [number, number, number][] = []
  for (let a = 0; a < somas.length; a++) {
    for (let b = a + 1; b < somas.length; b++) {
      if (!linked.has(`${a}:${b}`)) extra.push([a, b, distance(somas[a].p, somas[b].p)])
    }
  }
  extra.sort((x, y) => x[2] - y[2])
  for (const [a, b] of extra.slice(0, 12)) {
    const [from, to] = somas[a].depth <= somas[b].depth ? [a, b] : [b, a]
    axons.push(axon(somas, from, to, 0.35, rand))
  }
  return net(somas, axons, dendrites(somas, () => 3 + Math.floor(rand() * 2), [0.05, 0.11], rand, CORE_LIMIT))
}

/** State 2: a chain across the screen with side branches; the signal runs left to right. */
export function buildChain(rand: () => number): Net {
  const MAIN = 12
  const CHAIN = 28
  const somas: Soma[] = []
  for (let i = 0; i < MAIN; i++) {
    somas.push({
      p: [-4 + (i * 8) / (MAIN - 1), 0.32 * Math.sin(i * 1.25 + 0.4) + gaussian(rand) * 0.06, 0.4 * Math.cos(i * 0.85) + gaussian(rand) * 0.05],
      r: 0.1 + rand() * 0.025,
      depth: i,
      dropped: false,
    })
  }
  const axons: Axon[] = []
  for (let i = 0; i < MAIN - 1; i++) axons.push(axon(somas, i, i + 1, 0.12 + rand() * 0.1, rand, 0.4))
  let guard = 0
  while (somas.length < CHAIN && guard++ < 20000) {
    const parent = rand() < 0.7 || somas.length === MAIN ? Math.floor(rand() * MAIN) : MAIN + Math.floor(rand() * (somas.length - MAIN))
    const side = rand() < 0.5 ? -1 : 1
    const p = add(somas[parent].p, [(rand() * 2 - 1) * 0.45, side * (0.45 + rand() * 0.45), (rand() * 2 - 1) * 0.5])
    if (Math.abs(p[1]) > 1.2 || Math.abs(p[0]) > 4.2) continue
    if (!somas.every((s) => distance(s.p, p) > 0.38)) continue
    somas.push({ p, r: 0.065 + rand() * 0.02, depth: somas[parent].depth + 1, dropped: false })
    axons.push(axon(somas, parent, somas.length - 1, 0.25, rand, 0.4))
  }
  return net(somas, axons, dendrites(somas, () => 3 + Math.floor(rand() * 3), [0.1, 0.28], rand))
}

export interface Thesis {
  center: Vec3
  radius: number
  weight: number
  dropped: boolean
}

/** State 3 (and 5): each thesis a small net — one large soma and two or three around it. */
export function buildThesis(thesis: Thesis, index: number, rand: () => number): Net {
  const somas: Soma[] = [{ p: thesis.center, r: 0.07 + thesis.weight * 0.02, depth: index * 0.8, dropped: thesis.dropped }]
  const satellites = thesis.weight >= 1 ? 3 : 2
  let guard = 0
  while (somas.length <= satellites && guard++ < 4000) {
    const p = add(thesis.center, scale(onSphere(rand), thesis.radius * (1.3 + rand() * 0.6)))
    if (somas.every((s) => distance(s.p, p) > 0.14)) somas.push({ p, r: 0.04 + rand() * 0.012, depth: index * 0.8 + 1, dropped: thesis.dropped })
  }
  const axons = somas.slice(1).map((_, i) => axon(somas, 0, i + 1, 0.3, rand))
  return net(somas, axons, dendrites(somas, () => 3, [0.04, 0.09], rand))
}

// The diary graph's themes, laid out on a 560×360 plane (centred and scaled below). The landing's static
// constellation that shared them (.diary__sky) went with ADR-013's spread; only this graph uses them now.
const DIARY_NODES: [number, number, number][] = [
  [40, 150, 3], [150, 80, 4], [270, 45, 5], [360, 120, 6], [290, 190, 4], [500, 60, 3],
  [460, 170, 5], [470, 310, 3], [360, 300, 4], [180, 215, 4], [150, 310, 3], [30, 280, 3],
]
const DIARY_LINKS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4], [4, 9], [9, 0], [3, 6], [6, 5], [6, 7], [7, 8], [8, 4], [9, 10], [10, 11],
]

/** State 4: the diary graph — themes are somas, the links between them are axons. */
export function buildDiary(rand: () => number): Net {
  const somas: Soma[] = DIARY_NODES.map(([x, y, r]) => ({
    p: [((x - 280) / 280) * 3.1, (-(y - 180) / 180) * 1.55, (rand() * 2 - 1) * 0.6],
    r: 0.035 + r * 0.012,
    depth: Infinity,
    dropped: false,
  }))
  // Breadth-first from the strongest theme: the signal spreads from there.
  const root = DIARY_NODES.reduce((best, node, i) => (node[2] > DIARY_NODES[best][2] ? i : best), 0)
  somas[root].depth = 0
  const queue = [root]
  const axons: Axon[] = []
  const seen = new Set<string>()
  while (queue.length) {
    const a = queue.shift() as number
    for (const [x, y] of DIARY_LINKS) {
      const b = x === a ? y : y === a ? x : -1
      const key = `${Math.min(a, b)}:${Math.max(a, b)}`
      if (b < 0 || seen.has(key)) continue
      seen.add(key)
      if (somas[b].depth === Infinity) {
        somas[b].depth = somas[a].depth + 1
        queue.push(b)
      }
      axons.push(axon(somas, a, b, 0.15, rand, 0.4))
    }
  }
  return net(somas, axons, dendrites(somas, () => 3 + Math.floor(rand() * 2), [0.08, 0.2], rand))
}

/** One particle's place in a net: position, t (-2 glow, -1 halo, 0..1 axon, 2..3 dendrite), wave offset. */
export function place(n: Net, rand: () => number, mix: Mix, jitter: number, limit = Infinity): [Vec3, number, number] {
  const role = rand()
  if (role < mix.glow) {
    // A warm cloud at the centre of the light, densest in the middle.
    return [scale(onSphere(rand), Math.pow(rand(), 0.8) * 0.62), -2, 0]
  }
  if (role < mix.glow + mix.halo) {
    const s = n.somas[Math.floor(rand() * n.somas.length)]
    return [limited(jittered(s.p, rand, s.r * 0.9), limit), -1, s.depth]
  }
  if (role < mix.glow + mix.halo + mix.axon) {
    let r = rand() * n.axonLength
    let index = 0
    while (index < n.axons.length - 1 && r > n.axons[index].length) r -= n.axons[index++].length
    const a = n.axons[index]
    const u = rand()
    const p = bezier(n.somas[a.from].p, a.ctrl, n.somas[a.to].p, atLength(a, u))
    return [limited(jittered(p, rand, jitter), limit), u, n.somas[a.from].depth]
  }
  const d = n.dendrites[Math.floor(rand() * n.dendrites.length)]
  const u = Math.pow(rand(), 1.4) // denser near the soma
  const p = bezier(n.somas[d.soma].p, d.ctrl, d.tip, u)
  return [limited(jittered(p, rand, jitter * 0.7), limit), 2 + u, n.somas[d.soma].depth]
}
