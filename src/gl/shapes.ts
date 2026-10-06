// Procedural target shapes for the particle story "from noise to clarity", told by networks of
// neurons (neural.ts). Every particle has one slot in each shape; the vertex shader blends between
// them. Deterministic (seeded) so the composition is identical on every visit.

import { CORE_LIMIT, type Net, SOMAS, type Thesis, buildChain, buildCore, buildDiary, buildThesis, place } from './neural'
import { type Vec3, mulberry32, onSphere } from './random'

export interface SomaSet {
  /** Per instance, centre + radius (0 = absent) in each net: core (states 0, 1, 7), path (2),
   *  cluster (3, 5) and constellation (4). */
  core: Float32Array
  path: Float32Array
  cluster: Float32Array
  constellation: Float32Array
  /** Wave offsets in the same four nets. */
  wave: Float32Array
  /** x: random (transition delay), y: 1 = a thesis dropped at step 4. */
  meta: Float32Array
}

export interface ShapeSet {
  count: number
  /** The network in the light (hero, final); `position`. Dust: a halo around the glass. */
  core: Float32Array
  /** A chain of neurons across the screen: a conversation finding its line. */
  path: Float32Array
  /** 3–5 small networks: the theses of a session summary. w: 0 = kept thesis, 0.5 = a thesis that is
   *  dropped at step 4 ("the decision is yours"), 1 = loose speck around them. */
  cluster: Float32Array
  /** The diary graph: themes that recur across the diary. */
  constellation: Float32Array
  /** x: transition delay, y: colour mix, z: size, w: 1 = dust. */
  random: Float32Array
  /** (t, wave offset) in the core and in the path; (t, wave offset) in the cluster and in the
   *  constellation. t: -3 dust, -2 warm glow, -1 soma halo, 0..1 along an axon, 2..3 along a dendrite. */
  neural: Float32Array
  neural2: Float32Array
  somas: SomaSet
}

const DUST_SHARE = 0.18

function dust(rand: () => number, spread: Vec3): Vec3 {
  return [(rand() * 2 - 1) * spread[0], (rand() * 2 - 1) * spread[1], (rand() * 2 - 1) * spread[2]]
}

// Two of the five theses are let go at step 4; the three kept ones match the example summary.
const THESES: Thesis[] = [
  { center: [-2.3, 0.25, 0.1], radius: 0.24, weight: 1.2, dropped: false },
  { center: [-1.1, -0.35, -0.3], radius: 0.2, weight: 1, dropped: true },
  { center: [0.05, 0.3, 0.2], radius: 0.27, weight: 1.35, dropped: false },
  { center: [1.2, -0.25, -0.1], radius: 0.18, weight: 0.8, dropped: true },
  { center: [2.3, 0.35, 0.15], radius: 0.16, weight: 0.65, dropped: false },
]

// Particle shares per net: the light keeps a warm glow at its centre; the wide nets need none.
const CORE_MIX = { glow: 0.22, halo: 0.14, axon: 0.42 }
const NET_MIX = { glow: 0, halo: 0.18, axon: 0.52 }

function somaSlots(somas: { p: Vec3; r: number }[]): Float32Array {
  const out = new Float32Array(SOMAS * 4)
  somas.slice(0, SOMAS).forEach((s, i) => out.set([...s.p, s.r], i * 4))
  return out
}

export function buildShapes(count: number, seed = 20261006): ShapeSet {
  const rand = mulberry32(seed)
  const netRand = mulberry32(seed + 1)
  const coreNet = buildCore(netRand)
  const pathNet = buildChain(netRand)
  const theses = THESES.map((thesis, i) => buildThesis(thesis, i, netRand))
  const diaryNet = buildDiary(netRand)
  const thesisWeightSum = THESES.reduce((sum, t) => sum + t.weight, 0)

  const core = new Float32Array(count * 3)
  const path = new Float32Array(count * 3)
  const cluster = new Float32Array(count * 4)
  const constellation = new Float32Array(count * 3)
  const random = new Float32Array(count * 4)
  const neural = new Float32Array(count * 4)
  const neural2 = new Float32Array(count * 4)

  const pickThesis = (): number => {
    let r = rand() * thesisWeightSum
    for (let i = 0; i < THESES.length; i++) {
      r -= THESES[i].weight
      if (r <= 0) return i
    }
    return THESES.length - 1
  }

  for (let i = 0; i < count; i++) {
    const i3 = i * 3
    const i4 = i * 4
    const isDust = rand() < DUST_SHARE

    random[i4] = rand() // transition delay
    random[i4 + 1] = rand() // colour mix
    random[i4 + 2] = rand() // size
    random[i4 + 3] = isDust ? 1 : 0

    // Core: dust is a halo around the glass; everything else is the network inside it.
    if (isDust) {
      const dir = onSphere(rand)
      const r = 1.25 + Math.pow(rand(), 1.6) * 2.4
      core.set([dir[0] * r, dir[1] * r, dir[2] * r], i3)
      neural[i4] = -3
    } else {
      const [p, t, wave] = place(coreNet, rand, CORE_MIX, 0.007, CORE_LIMIT)
      core.set(p, i3)
      neural[i4] = t
      neural[i4 + 1] = wave
    }

    // Path: the chain; dust is a wide field around it.
    if (isDust) {
      path.set(dust(rand, [4.4, 2.2, 1.2]), i3)
      neural[i4 + 2] = -3
    } else {
      const [p, t, wave] = place(pathNet, rand, NET_MIX, 0.012)
      path.set(p, i3)
      neural[i4 + 2] = t
      neural[i4 + 3] = wave
    }

    // Clusters: the theses — each a small network; over a third of the particles stay loose specks.
    if (isDust || rand() > 0.62) {
      cluster.set([...dust(rand, [4.6, 4.6, 1.6]), 1], i4)
      neural2[i4] = -3
    } else {
      const thesis = pickThesis()
      const [p, t, wave] = place(theses[thesis], rand, NET_MIX, 0.008)
      cluster.set([...p, THESES[thesis].dropped ? 0.5 : 0], i4)
      neural2[i4] = t
      neural2[i4 + 1] = wave
    }

    // Constellation: the diary graph.
    if (isDust) {
      constellation.set(dust(rand, [4.4, 2.3, 1.4]), i3)
      neural2[i4 + 2] = -3
    } else {
      const [p, t, wave] = place(diaryNet, rand, NET_MIX, 0.01)
      constellation.set(p, i3)
      neural2[i4 + 2] = t
      neural2[i4 + 3] = wave
    }
  }

  const thesisSomas = theses.flatMap((n: Net) => n.somas)
  const wave = new Float32Array(SOMAS * 4)
  const meta = new Float32Array(SOMAS * 4)
  for (let i = 0; i < SOMAS; i++) {
    wave.set([coreNet.somas[i]?.depth ?? 0, pathNet.somas[i]?.depth ?? 0, thesisSomas[i]?.depth ?? 0, diaryNet.somas[i]?.depth ?? 0], i * 4)
    meta.set([netRand(), thesisSomas[i]?.dropped ? 1 : 0, 0, 0], i * 4)
  }

  // Shuffle-free on purpose: neighbours in the buffer are unrelated across shapes, which is what
  // makes the morph look like particles re-organising rather than a single mesh deforming.
  return {
    count,
    core,
    path,
    cluster,
    constellation,
    random,
    neural,
    neural2,
    somas: {
      core: somaSlots(coreNet.somas),
      path: somaSlots(pathNet.somas),
      cluster: somaSlots(thesisSomas),
      constellation: somaSlots(diaryNet.somas),
      wave,
      meta,
    },
  }
}
