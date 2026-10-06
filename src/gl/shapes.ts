// Procedural target shapes for the particle story "from noise to clarity".
// Every particle has one slot in each shape; the vertex shader blends between them.
// Deterministic (seeded) so the composition is identical on every visit.

export interface ShapeSet {
  count: number
  /** Breathing light (hero, final). Used as `position`. */
  orb: Float32Array
  /** Calm parallel threads: a conversation finding its line. */
  thread: Float32Array
  /** 3–5 bright clusters: the theses of a session summary. w: 0 = kept thesis, 0.5 = a thesis that is
   *  dropped at step 4 ("the decision is yours"), 1 = loose speck around them. */
  cluster: Float32Array
  /** Nodes joined by dotted lines: themes that recur across the diary. */
  constellation: Float32Array
  /** x: transition delay, y: colour mix, z: size, w: role (0 = main, 0.5 = constellation line, 1 = dust). */
  random: Float32Array
}

const DUST_SHARE = 0.18

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type Vec3 = [number, number, number]

export function gaussian(rand: () => number): number {
  // Box–Muller; clamp the tail so no particle flies far off.
  const u = Math.max(rand(), 1e-6)
  const v = rand()
  return Math.max(-3, Math.min(3, Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)))
}

export function onSphere(rand: () => number): Vec3 {
  const z = rand() * 2 - 1
  const phi = rand() * Math.PI * 2
  const r = Math.sqrt(1 - z * z)
  return [r * Math.cos(phi), r * Math.sin(phi), z]
}

function dust(rand: () => number, spread: Vec3): Vec3 {
  return [(rand() * 2 - 1) * spread[0], (rand() * 2 - 1) * spread[1], (rand() * 2 - 1) * spread[2]]
}

const CLUSTERS: { center: Vec3; radius: number; weight: number }[] = [
  { center: [-2.3, 0.25, 0.1], radius: 0.24, weight: 1.2 },
  { center: [-1.1, -0.35, -0.3], radius: 0.2, weight: 1 },
  { center: [0.05, 0.3, 0.2], radius: 0.27, weight: 1.35 },
  { center: [1.2, -0.25, -0.1], radius: 0.18, weight: 0.8 },
  { center: [2.3, 0.35, 0.15], radius: 0.16, weight: 0.65 },
]

// Two of the five theses are let go at step 4; the three kept ones match the example summary.
const DROPPED = new Set([1, 3])

const THREADS = 7

interface Constellation {
  nodes: { p: Vec3; weight: number }[]
  edges: [number, number][]
}

function buildConstellation(rand: () => number): Constellation {
  const nodes: { p: Vec3; weight: number }[] = []
  let guard = 0
  while (nodes.length < 13 && guard++ < 4000) {
    const p: Vec3 = [(rand() * 2 - 1) * 3.1, (rand() * 2 - 1) * 1.55, (rand() * 2 - 1) * 0.7]
    if (nodes.every((n) => Math.hypot(n.p[0] - p[0], n.p[1] - p[1], n.p[2] - p[2]) > 1.05)) {
      nodes.push({ p, weight: 0.5 + rand() * rand() * 1.6 })
    }
  }

  // Minimum spanning tree (Prim) so every theme is connected, plus a few short loops.
  const distance = (a: number, b: number): number =>
    Math.hypot(nodes[a].p[0] - nodes[b].p[0], nodes[a].p[1] - nodes[b].p[1], nodes[a].p[2] - nodes[b].p[2])
  const edges: [number, number][] = []
  const inTree = new Set([0])
  while (inTree.size < nodes.length) {
    let best: [number, number] | null = null
    let bestDistance = Infinity
    for (const a of inTree) {
      for (let b = 0; b < nodes.length; b++) {
        if (inTree.has(b)) continue
        const d = distance(a, b)
        if (d < bestDistance) {
          bestDistance = d
          best = [a, b]
        }
      }
    }
    if (!best) break
    edges.push(best)
    inTree.add(best[1])
  }
  const extra: { pair: [number, number]; d: number }[] = []
  for (let a = 0; a < nodes.length; a++) {
    for (let b = a + 1; b < nodes.length; b++) {
      if (edges.some(([x, y]) => (x === a && y === b) || (x === b && y === a))) continue
      extra.push({ pair: [a, b], d: distance(a, b) })
    }
  }
  extra.sort((x, y) => x.d - y.d)
  for (const { pair } of extra.slice(0, 3)) edges.push(pair)
  return { nodes, edges }
}

export function buildShapes(count: number, seed = 20261006): ShapeSet {
  const rand = mulberry32(seed)
  const orb = new Float32Array(count * 3)
  const thread = new Float32Array(count * 3)
  const cluster = new Float32Array(count * 4)
  const constellation = new Float32Array(count * 3)
  const random = new Float32Array(count * 4)

  const clusterWeightSum = CLUSTERS.reduce((sum, c) => sum + c.weight, 0)
  const sky = buildConstellation(rand)
  const nodeWeightSum = sky.nodes.reduce((sum, n) => sum + n.weight, 0)
  const edgeLengths = sky.edges.map(([a, b]) =>
    Math.hypot(sky.nodes[a].p[0] - sky.nodes[b].p[0], sky.nodes[a].p[1] - sky.nodes[b].p[1], sky.nodes[a].p[2] - sky.nodes[b].p[2]),
  )
  const edgeLengthSum = edgeLengths.reduce((sum, l) => sum + l, 0)

  const pickWeighted = <T>(items: T[], weightOf: (item: T) => number, total: number): T => {
    let r = rand() * total
    for (const item of items) {
      r -= weightOf(item)
      if (r <= 0) return item
    }
    return items[items.length - 1]
  }

  for (let i = 0; i < count; i++) {
    const i3 = i * 3
    const isDust = rand() < DUST_SHARE

    random[i * 4] = rand() // transition delay
    random[i * 4 + 1] = rand() // colour mix
    random[i * 4 + 2] = rand() // size
    random[i * 4 + 3] = isDust ? 1 : 0

    // Orb: a bright shell, a softer core, and a halo of dust around it.
    let p: Vec3
    if (isDust) {
      const dir = onSphere(rand)
      const r = 1.25 + Math.pow(rand(), 1.6) * 2.4
      p = [dir[0] * r, dir[1] * r, dir[2] * r]
    } else if (rand() < 0.68) {
      const dir = onSphere(rand)
      const r = 0.9 + rand() * 0.1
      p = [dir[0] * r, dir[1] * r, dir[2] * r]
    } else {
      const dir = onSphere(rand)
      const r = Math.pow(rand(), 0.55) * 0.88
      p = [dir[0] * r, dir[1] * r, dir[2] * r]
    }
    orb.set(p, i3)

    // Threads: gentle parallel curves across the screen; the shader adds the slow wave.
    if (isDust) {
      p = dust(rand, [4.4, 2.2, 1.2])
    } else {
      const line = Math.floor(rand() * THREADS)
      const t = rand() * 2 - 1
      const y = (line / (THREADS - 1) - 0.5) * 2.1
      p = [t * 4.2, y + Math.sin(t * 2.4 + line * 0.9) * 0.18 + gaussian(rand) * 0.018, Math.sin(line * 1.7) * 0.4 + gaussian(rand) * 0.03]
    }
    thread.set(p, i3)

    // Clusters: the theses — each a small bright core inside a soft halo; most particles stay dust.
    const role = rand()
    const loose = isDust || role > 0.62
    let clusterRole = 1
    if (loose) {
      p = dust(rand, [4.6, 4.6, 1.6])
    } else {
      const c = pickWeighted(CLUSTERS, (item) => item.weight, clusterWeightSum)
      const spread = role < 0.22 ? c.radius * 0.45 : c.radius * 1.9
      p = [c.center[0] + gaussian(rand) * spread, c.center[1] + gaussian(rand) * spread, c.center[2] + gaussian(rand) * spread]
      clusterRole = DROPPED.has(CLUSTERS.indexOf(c)) ? 0.5 : 0
    }
    cluster.set([...p, clusterRole], i * 4)

    // Constellation: nodes (themes) and dotted edges (themes that came back).
    if (isDust) {
      p = dust(rand, [4.4, 2.3, 1.4])
    } else if (rand() < 0.38) {
      const node = pickWeighted(sky.nodes, (n) => n.weight, nodeWeightSum)
      const spread = 0.06 + node.weight * 0.06
      p = [node.p[0] + gaussian(rand) * spread, node.p[1] + gaussian(rand) * spread, node.p[2] + gaussian(rand) * spread]
    } else {
      random[i * 4 + 3] = 0.5 // a line between themes, drawn fainter than the themes themselves
      let r = rand() * edgeLengthSum
      let edge = 0
      while (edge < sky.edges.length - 1 && r > edgeLengths[edge]) r -= edgeLengths[edge++]
      const [a, b] = sky.edges[edge]
      const t = rand()
      const pa = sky.nodes[a].p
      const pb = sky.nodes[b].p
      p = [
        pa[0] + (pb[0] - pa[0]) * t + gaussian(rand) * 0.02,
        pa[1] + (pb[1] - pa[1]) * t + gaussian(rand) * 0.02,
        pa[2] + (pb[2] - pa[2]) * t + gaussian(rand) * 0.02,
      ]
    }
    constellation.set(p, i3)
  }

  // Shuffle-free on purpose: neighbours in the buffer are unrelated across shapes, which is what
  // makes the morph look like particles re-organising rather than a single mesh deforming.
  return { count, orb, thread, cluster, constellation, random }
}
