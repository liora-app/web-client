import { AdditiveBlending, BufferGeometry, DoubleSide, Float32BufferAttribute, Group, Mesh, NormalBlending, PlaneGeometry, Points, ShaderMaterial, Vector2, Vector3 } from 'three'
import { type ScenePalette, setRgb } from './core/palette'
import fieldShape from './shaders/field-shape.glsl?raw'
import fieldVertex from './shaders/field.vert.glsl?raw'
import fieldFragment from './shaders/field.frag.glsl?raw'
import motesVertex from './shaders/motes.vert.glsl?raw'
import motesFragment from './shaders/motes.frag.glsl?raw'
import atmosphereVertex from './shaders/atmosphere.vert.glsl?raw'
import atmosphereFragment from './shaders/atmosphere.frag.glsl?raw'

/** Deterministic geometry, animated on the GPU; no per-frame buffer allocations. */
export function createLuminousField(low: boolean) {
  const strands = low ? 100 : 220
  const segments = low ? 112 : 192
  const motesCount = low ? 650 : 1600
  const uniforms = {
    uTime: { value: 0 }, uState: { value: 0 }, uHover: { value: 0 },
    uPointer: { value: new Vector2(8, 8) }, uOpacity: { value: 0 },
    uStroke: { value: 1 }, uPixelRatio: { value: 1 }, uSize: { value: 1 },
    uFinal: { value: 0 }, uResolution: { value: new Vector2(1, 1) },
    uGain: { value: 1.65 },
    // The theme (setPalette): shared by every material below, so one write reaches all of them.
    uFieldBlue: { value: new Vector3() }, uFieldMint: { value: new Vector3() }, uFieldGold: { value: new Vector3() },
    uFieldFlash: { value: new Vector3() }, uFieldAlpha: { value: 1 },
    uMoteCool: { value: new Vector3() }, uMoteWarm: { value: new Vector3() }, uMoteAlpha: { value: 1 },
    uAtmosphereCool: { value: new Vector3() }, uAtmosphereWarm: { value: new Vector3() }, uAtmosphereAlpha: { value: 1 },
  }
  const flow: number[] = [], side: number[] = [], positions: number[] = [], indices: number[] = []
  for (let i = 0; i < strands; i++) {
    const seed = (i + 0.5) / strands
    const random = (Math.sin(i * 127.1 + 4.7) * 43758.5453) % 1
    for (let j = 0; j <= segments; j++) {
      for (const s of [-1, 1]) { positions.push(0, 0, 0); flow.push(j / segments, seed, Math.abs(random)); side.push(s) }
      if (j < segments) {
        const a = (i * (segments + 1) + j) * 2
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
      }
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('aFlow', new Float32BufferAttribute(flow, 3))
  geometry.setAttribute('aSide', new Float32BufferAttribute(side, 1))
  geometry.setIndex(indices)
  const material = (vertexShader: string, fragmentShader: string) => new ShaderMaterial({
    vertexShader: vertexShader.replace('#include <field_shape>', fieldShape), fragmentShader,
    uniforms, side: DoubleSide, forceSinglePass: true, transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest: false, premultipliedAlpha: true,
  })
  const filaments = new Mesh(geometry, material(fieldVertex, fieldFragment))
  filaments.frustumCulled = false
  const innerMaterial = material(fieldVertex, fieldFragment)
  innerMaterial.uniforms = { ...uniforms, uGain: { value: 1.3 } }
  const inner = new Mesh(geometry, innerMaterial)
  inner.scale.setScalar(0.61)
  inner.rotation.set(0.9, 0.3, 1.4)
  inner.frustumCulled = false
  const orbitGeometry = new BufferGeometry()
  const orbitFlow: number[] = [], orbitSide: number[] = [], orbitPositions: number[] = [], orbitIndices: number[] = []
  for (let ring = 0; ring < 3; ring++) {
    for (let j = 0; j <= 320; j++) {
      for (const s of [-1, 1]) { orbitPositions.push(0, 0, 0); orbitFlow.push(j / 320, (ring + 0.5) / 3, 0.3); orbitSide.push(s) }
      if (j < 320) { const a = (ring * 321 + j) * 2; orbitIndices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2) }
    }
  }
  orbitGeometry.setAttribute('position', new Float32BufferAttribute(orbitPositions, 3))
  orbitGeometry.setAttribute('aFlow', new Float32BufferAttribute(orbitFlow, 3))
  orbitGeometry.setAttribute('aSide', new Float32BufferAttribute(orbitSide, 1))
  orbitGeometry.setIndex(orbitIndices)
  const orbitMaterial = material('#define ORBIT\n' + fieldVertex, fieldFragment)
  orbitMaterial.uniforms = { ...uniforms, uGain: { value: 0.48 } }
  const orbits = new Mesh(orbitGeometry, orbitMaterial)
  orbits.frustumCulled = false
  const motesGeometry = new BufferGeometry()
  const seeds: number[] = []
  for (let i = 0; i < motesCount; i++) seeds.push((i * 0.61803398875) % 1, (i * 0.7548776662) % 1, (i * 0.56984029) % 1)
  motesGeometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(motesCount * 3), 3))
  motesGeometry.setAttribute('aFlow', new Float32BufferAttribute(seeds, 3))
  const motes = new Points(motesGeometry, material(motesVertex, motesFragment))
  motes.frustumCulled = false
  const body = new Group()
  body.add(filaments, inner, orbits, motes)
  const atmosphere = new Mesh(new PlaneGeometry(3.6, 3.6), material(atmosphereVertex, atmosphereFragment))
  atmosphere.frustumCulled = false
  atmosphere.renderOrder = -1
  const root = new Group()
  root.add(atmosphere, body)
  const materials = [filaments.material, innerMaterial, orbitMaterial, motes.material, atmosphere.material]
  /** The theme's colours in place, and its blending: draw state, no new program, no rebuilt scene. */
  const setPalette = ({ additive, field, motes: dust, atmosphere: air }: ScenePalette): void => {
    setRgb(uniforms.uFieldBlue.value, field.blue)
    setRgb(uniforms.uFieldMint.value, field.mint)
    setRgb(uniforms.uFieldGold.value, field.gold)
    setRgb(uniforms.uFieldFlash.value, field.flash)
    uniforms.uFieldAlpha.value = field.alpha
    setRgb(uniforms.uMoteCool.value, dust.cool)
    setRgb(uniforms.uMoteWarm.value, dust.warm)
    uniforms.uMoteAlpha.value = dust.alpha
    setRgb(uniforms.uAtmosphereCool.value, air.cool)
    setRgb(uniforms.uAtmosphereWarm.value, air.warm)
    uniforms.uAtmosphereAlpha.value = air.alpha
    for (const material of materials) material.blending = additive ? AdditiveBlending : NormalBlending
  }
  return {
    root, body, inner, orbits, uniforms, setPalette, vertices: positions.length / 3, particles: motesCount,
    simplify: () => { motesGeometry.setDrawRange(0, Math.floor(motesCount / 2)); geometry.setDrawRange(0, Math.floor(strands / 2) * segments * 6) },
    dispose: () => {
      for (const object of [filaments, motes, atmosphere, orbits]) { object.geometry.dispose(); object.material.dispose() }
      innerMaterial.dispose()
    },
  }
}
