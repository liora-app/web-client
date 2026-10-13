import { AdditiveBlending, BufferGeometry, DoubleSide, Float32BufferAttribute, Group, Mesh, ShaderMaterial } from 'three'

/** One continuous drawing: thought → dialogue → three notes → a chosen note.
 * All four shapes share the same closed strands, so scrolling reshapes the drawing.
 */
export function createConversationFlow(low: boolean) {
  const strands = low ? 30 : 90
  const segments = low ? 80 : 160
  const positions: number[] = [], flows: number[] = [], sides: number[] = [], indices: number[] = []
  for (let i = 0; i < strands; i++) {
    for (let j = 0; j <= segments; j++) {
      for (const side of [-1, 1]) {
        positions.push(0, 0, 0)
        flows.push(j / segments, (i + 0.5) / strands)
        sides.push(side)
      }
      if (j < segments) {
        const a = (i * (segments + 1) + j) * 2
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
      }
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('aFlow', new Float32BufferAttribute(flows, 2))
  geometry.setAttribute('aSide', new Float32BufferAttribute(sides, 1))
  geometry.setIndex(indices)
  const uniforms = { uTime: { value: 0 }, uStage: { value: 0 }, uOpacity: { value: 0 }, uStroke: { value: 0.7 }, uGlow: { value: 0 } }
  const material = new ShaderMaterial({
    uniforms, side: DoubleSide, forceSinglePass: true, transparent: true,
    depthTest: false, depthWrite: false, blending: AdditiveBlending, premultipliedAlpha: true,
    vertexShader: `
      uniform float uTime;
      uniform float uStage;
      uniform float uStroke;
      attribute vec2 aFlow;
      attribute float aSide;
      varying vec2 vFlow;
      varying float vEdge;
      varying float vDepth;
      vec3 drawing(float t, float s) {
        float a = t * 6.283185;
        float drift = sin(uTime * 0.24) * 0.1;
        float band = fract(s * 3.0);
        float group = floor(s * 3.0) - 1.0;
        // A loose, asymmetrical handwritten loop, with light travelling along it.
        vec3 thought = vec3(
          (0.48 + s * 0.3) * sin(a + s * 2.8 + drift) + 0.13 * sin(a * 3.0 + s * 4.0),
          1.18 * cos(a) + 0.19 * sin(a * 2.0 + s * 5.0),
          0.3 * sin(a * 2.0 + s * 3.0));
        float voice = step(0.5, s) * 2.0 - 1.0;
        float thread = fract(s * 2.0);
        vec3 dialogue = vec3(
          voice * 0.26 + (0.19 + thread * 0.24) * cos(a) + 0.17 * sin(a * 2.0 + drift),
          (0.86 + thread * 0.28) * sin(a),
          voice * 0.28 * cos(a) + 0.12 * sin(a * 2.0));
        // Three paper-thin leaves: distinct notes, rather than three spheres.
        vec3 notes = vec3(
          (0.06 + band * 0.76) * cos(a),
          group * 0.72 + (0.015 + band * 0.24) * sin(a) + 0.15 * cos(a) * band + 0.06 * sin(a * 2.0 + uTime * 0.3 + group) * band,
          0.27 * sin(a) * band + 0.045 * sin(uTime * 0.4 + group));
        float selected = 1.0 - abs(group);
        float radius = 0.32 + band * 0.58;
        vec3 outline = vec3(radius * cos(a) * (0.84 + 0.07 * sin(a * 3.0)), radius * 1.2 * sin(a), 0.18 * sin(a * 2.0) + group * 0.1);
        vec3 note = vec3((0.04 + band * 0.65) * cos(a), (0.015 + band * 0.18) * sin(a) + 0.22 * cos(a) * band, 0.22 * sin(a) * band);
        vec3 choice = mix(outline, note, selected);
        vec3 p = mix(thought, dialogue, smoothstep(0.12, 0.88, uStage));
        p = mix(p, notes, smoothstep(1.12, 1.88, uStage));
        p = mix(p, choice, smoothstep(2.12, 2.88, uStage));
        p *= 1.0 + 0.016 * sin(uTime * 0.7);
        return p;
      }
      void main() {
        vec3 p = drawing(aFlow.x, aFlow.y);
        vec4 view = modelViewMatrix * vec4(p, 1.0);
        vec4 next = modelViewMatrix * vec4(drawing(aFlow.x + 0.0005, aFlow.y), 1.0);
        vec2 tangent = normalize(next.xy - view.xy + vec2(0.00001));
        view.xy += vec2(-tangent.y, tangent.x) * aSide * uStroke;
        gl_Position = projectionMatrix * view;
        vEdge = aSide;
        vFlow = aFlow;
        vDepth = 0.7 + p.z * 0.6;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uStage;
      uniform float uOpacity;
      uniform float uGlow;
      varying vec2 vFlow;
      varying float vEdge;
      varying float vDepth;
      void main() {
        float edge = exp(-vEdge * vEdge * 4.0) * (1.0 - smoothstep(0.8, 1.0, abs(vEdge)));
        float pulse = pow(max(0.0, sin(vFlow.x * 6.283185 - uTime * 0.65 + vFlow.y * 2.0)), 18.0);
        vec3 cyan = vec3(0.13, 0.78, 0.91);
        vec3 gold = vec3(1.0, 0.68, 0.32);
        float warm = smoothstep(0.35, 0.9, vFlow.y);
        float chosen = 1.0 - abs(floor(vFlow.y * 3.0) - 1.0);
        warm = mix(warm, chosen, smoothstep(1.1, 2.0, uStage));
        vec3 color = mix(cyan, gold, warm);
        color = mix(color, vec3(0.94, 1.0, 0.97), pulse * 0.6);
        float alpha = edge * (0.32 + pulse * 0.65) * vDepth * uOpacity;
        alpha *= mix(1.0, 0.065, uGlow);
        gl_FragColor = vec4(color * alpha, alpha);
      }
    `,
  })
  const lines = new Mesh(geometry, material)
  lines.frustumCulled = false
  const glowMaterial = material.clone()
  glowMaterial.uniforms = { ...uniforms, uStroke: { value: 4.5 }, uGlow: { value: 1 } }
  const glow = new Mesh(geometry, glowMaterial)
  glow.frustumCulled = false
  const root = new Group()
  root.add(glow, lines)
  return {
    root, uniforms, vertices: positions.length / 3,
    dispose() { geometry.dispose(); material.dispose(); glowMaterial.dispose() },
  }
}
