// One-off asset pipeline for public/models/companion.glb (not part of the build).
// The authored source is the 2M-triangle Tripo export from commit a143875:
//   git show a143875:spatial-island-local/public/models/companion.glb > companion.source.glb
// Run from a scratch directory so the site's package.json and lockfile stay untouched:
//   npm i --no-save @gltf-transform/core@4.5.1 @gltf-transform/extensions@4.5.1 @gltf-transform/functions@4.5.1 meshoptimizer@1.3.0 sharp@0.35.5
//   node optimize-model.mjs companion.source.glb companion.glb --ratio 0.03 --texture 1024
// Steps: drop the unused Liora_Breakdance clip → weld → meshoptimizer simplify (skin weights travel with the kept
// vertices) → prune/dedup → base colour to WebP → vertex-cache reorder → EXT_meshopt_compression.
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { weld, simplify, prune, dedup, reorder, textureCompress, meshopt } from '@gltf-transform/functions'
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer'
import sharp from 'sharp'

const [src, out] = process.argv.slice(2)
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? Number(process.argv[i + 1]) : fallback }
const ratio = arg('ratio', 0.03), error = arg('error', 1), size = arg('texture', 1024), quality = arg('quality', 84)
if (!src || !out) throw new Error('usage: node optimize-model.mjs <in.glb> <out.glb> [--ratio 0.03] [--texture 1024]')

await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready])
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder })
const doc = await io.read(src)
const count = () => doc.getRoot().listMeshes().flatMap(m => m.listPrimitives()).reduce((s, p) => s + (p.getIndices()?.getCount() ?? 0) / 3, 0)
const before = count()
for (const animation of doc.getRoot().listAnimations()) animation.dispose()
await doc.transform(
  weld(),
  simplify({ simplifier: MeshoptSimplifier, ratio, error, lockBorder: false }),
  prune({ keepLeaves: true }),
  dedup(),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [size, size], quality }),
  reorder({ encoder: MeshoptEncoder }),
  meshopt({ encoder: MeshoptEncoder, level: 'high' }),
)
const joints = doc.getRoot().listSkins().flatMap(s => s.listJoints()).map(j => j.getName())
await io.write(out, doc)
console.log(JSON.stringify({ ratio, trianglesBefore: before, trianglesAfter: count(), joints: joints.length, jointNames: joints, animations: doc.getRoot().listAnimations().length }))
