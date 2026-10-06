// Seeded randomness for the procedural shapes: the composition is identical on every visit.

export type Vec3 = [number, number, number]

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
