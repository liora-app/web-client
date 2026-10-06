// Spike (?scene=neural): a small neural network instead of the orb's points (state 0, inside the
// glass) and instead of the threads (state 2, a chain the signal runs along). The soma bodies are 3D
// instances (see scene.ts); the particles draw their halo, the axons and the dendrites.
// A signal leaves the root of a spanning tree and reaches each soma one axon later per tree level.

import { type ShapeSet, type Vec3, gaussian, mulberry32, onSphere } from './shapes'

export const SOMAS = 28
/** Wave period in axon lengths: a new signal leaves the root this often (state 0, state 2). */
export const WAVE_PERIOD: [number, number] = [4, 5]

export interface NeuralSet {
  /** Per particle: x, y = state 0 (t, wave offset), z, w = the same for state 2. t: -2 dust,
   *  -1 soma halo, 0..1 along an axon (parent → child, by arc length), 2..3 along a dendrite. */
  particles: Float32Array
  /** Per soma instance: centre and radius in state 0 (A) and state 2 (B); radius 0 = absent. */
  somaA: Float32Array
  somaB: Float32Array
  /** x: wave offset in state 0, y: in state 2, z: random. */
  somaWave: Float32Array
}

interface Soma {
  p: Vec3
  r: number
  depth: number
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

interface Net {
  somas: Soma[]
  axons: Axon[]
  dendrites: Dendrite[]
}

const LUT_STEPS = 32
const CORE_RADIUS = 0.74 // soma centres; with dendrites everything stays within ~0.9 (glass: 1.14)
const CORE_LIMIT = 0.9

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2])
const distance = (a: Vec3, b: Vec3): number => length(sub(a, b))

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
    if (soma.r === 0) return
    for (let k = count(); k > 0; k--) {
      const dir = onSphere(rand)
      const len = reach[0] + rand() * (reach[1] - reach[0])
      let tip = add(soma.p, scale(dir, soma.r + len))
      if (length(tip) > limit) tip = scale(tip, limit / length(tip))
      const ctrl = add(add(soma.p, scale(dir, soma.r + len * 0.5)), scale(perpendicular(dir, rand), len * 0.35))
      out.push({ soma: index, ctrl, tip })
    }
  })
  return out
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

// State 0: a ball of neurons inside the glass.
function buildCore(rand: () => number): Net {
  const somas: Soma[] = []
  let guard = 0
  while (somas.length < SOMAS && guard++ < 20000) {
    const p = scale(onSphere(rand), CORE_RADIUS * Math.cbrt(rand()))
    if (somas.every((s) => distance(s.p, p) > 0.2)) somas.push({ p, r: 0.04 + rand() * 0.025, depth: 0 })
  }
  let root = 0
  somas.forEach((s, i) => {
    if (length(s.p) < length(somas[root].p)) root = i
  })
  const axons = spanningTree(somas, root, 0.3, rand)
  // A few short loops, so it reads as a network rather than a tree.
  const linked = new Set(axons.map((a) => `${Math.min(a.from, a.to)}:${Math.max(a.from, a.to)}`))
  const extra: [number, number, number][] = []
  for (let a = 0; a < somas.length; a++) {
    for (let b = a + 1; b < somas.length; b++) {
      if (!linked.has(`${a}:${b}`)) extra.push([a, b, distance(somas[a].p, somas[b].p)])
    }
  }
  extra.sort((x, y) => x[2] - y[2])
  for (const [a, b] of extra.slice(0, 14)) {
    const [from, to] = somas[a].depth <= somas[b].depth ? [a, b] : [b, a]
    axons.push(axon(somas, from, to, 0.35, rand))
  }
  while (somas.length < SOMAS) somas.push({ p: [0, 0, 0], r: 0, depth: 0 })
  return { somas, axons, dendrites: dendrites(somas, () => 3 + Math.floor(rand() * 3), [0.05, 0.12], rand, CORE_LIMIT) }
}

// State 2: a chain across the screen with side branches; the signal runs left to right.
function buildChain(rand: () => number): Net {
  const MAIN = 12
  const somas: Soma[] = []
  for (let i = 0; i < MAIN; i++) {
    somas.push({
      p: [-4 + (i * 8) / (MAIN - 1), 0.32 * Math.sin(i * 1.25 + 0.4) + gaussian(rand) * 0.06, 0.4 * Math.cos(i * 0.85) + gaussian(rand) * 0.05],
      r: 0.08 + rand() * 0.02,
      depth: i,
    })
  }
  const axons: Axon[] = []
  for (let i = 0; i < MAIN - 1; i++) axons.push(axon(somas, i, i + 1, 0.12 + rand() * 0.1, rand, 0.4))
  let guard = 0
  while (somas.length < SOMAS && guard++ < 20000) {
    const parent = rand() < 0.7 || somas.length === MAIN ? Math.floor(rand() * MAIN) : MAIN + Math.floor(rand() * (somas.length - MAIN))
    const side = rand() < 0.5 ? -1 : 1
    const p = add(somas[parent].p, [(rand() * 2 - 1) * 0.45, side * (0.45 + rand() * 0.45), (rand() * 2 - 1) * 0.5])
    if (Math.abs(p[1]) > 1.2 || Math.abs(p[0]) > 4.2) continue
    if (!somas.every((s) => distance(s.p, p) > 0.38)) continue
    somas.push({ p, r: 0.05 + rand() * 0.02, depth: somas[parent].depth + 1 })
    axons.push(axon(somas, parent, somas.length - 1, 0.25, rand, 0.4))
  }
  return { somas, axons, dendrites: dendrites(somas, () => 3 + Math.floor(rand() * 3), [0.1, 0.28], rand) }
}

// One particle's place in a net: [x, y, z, t, wave offset].
function place(net: Net, rand: () => number, jitter: number, axonLengthSum: number, limit = Infinity): [Vec3, number, number] {
  const role = rand()
  if (role < 0.2) {
    const live = net.somas.filter((s) => s.r > 0)
    const s = live[Math.floor(rand() * live.length)]
    const spread = s.r * 0.8
    return [add(s.p, [gaussian(rand) * spread, gaussian(rand) * spread, gaussian(rand) * spread]), -1, s.depth]
  }
  if (role < 0.72) {
    let r = rand() * axonLengthSum
    let index = 0
    while (index < net.axons.length - 1 && r > net.axons[index].length) r -= net.axons[index++].length
    const a = net.axons[index]
    const u = rand()
    const p = bezier(net.somas[a.from].p, a.ctrl, net.somas[a.to].p, atLength(a, u))
    return [add(p, [gaussian(rand) * jitter, gaussian(rand) * jitter, gaussian(rand) * jitter]), u, net.somas[a.from].depth]
  }
  const d = net.dendrites[Math.floor(rand() * net.dendrites.length)]
  const u = Math.pow(rand(), 1.4) // denser near the soma
  let p = bezier(net.somas[d.soma].p, d.ctrl, d.tip, u)
  p = add(p, [gaussian(rand) * jitter * 0.7, gaussian(rand) * jitter * 0.7, gaussian(rand) * jitter * 0.7])
  if (length(p) > limit) p = scale(p, limit / length(p))
  return [p, 2 + u, net.somas[d.soma].depth]
}

/** Rewrites the orb (state 0) and thread (state 2) slots of every non-dust particle. */
export function buildNeural(shapes: ShapeSet, seed = 20261007): NeuralSet {
  const rand = mulberry32(seed)
  const core = buildCore(rand)
  const chain = buildChain(rand)
  const coreLength = core.axons.reduce((sum, a) => sum + a.length, 0)
  const chainLength = chain.axons.reduce((sum, a) => sum + a.length, 0)

  const particles = new Float32Array(shapes.count * 4)
  for (let i = 0; i < shapes.count; i++) {
    if (shapes.random[i * 4 + 3] > 0.75) {
      particles.set([-2, 0, -2, 0], i * 4) // dust keeps its orb halo and thread field
      continue
    }
    const [p0, t0, w0] = place(core, rand, 0.007, coreLength, CORE_LIMIT)
    shapes.orb.set(p0, i * 3)
    const [p2, t2, w2] = place(chain, rand, 0.012, chainLength)
    shapes.thread.set(p2, i * 3)
    particles.set([t0, w0, t2, w2], i * 4)
  }

  const somaA = new Float32Array(SOMAS * 4)
  const somaB = new Float32Array(SOMAS * 4)
  const somaWave = new Float32Array(SOMAS * 4)
  for (let i = 0; i < SOMAS; i++) {
    const a = core.somas[i]
    const b = chain.somas[i] ?? { p: [0, 0, 0], r: 0, depth: 0 }
    somaA.set([...a.p, a.r], i * 4)
    somaB.set([...b.p, b.r], i * 4)
    somaWave.set([a.depth, b.depth, rand(), 0], i * 4)
  }
  return { particles, somaA, somaB, somaWave }
}
