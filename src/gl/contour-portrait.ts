import { AdditiveBlending, BufferAttribute, BufferGeometry, DoubleSide, Float32BufferAttribute, Group, Mesh, ShaderMaterial } from 'three'

/** A contour study, not a character: one 63 kB local mesh, two GPU draw calls. */
export async function createContourPortrait() {
  const response = await fetch('/portrait/head.bin')
  if (!response.ok) throw new Error('Portrait asset unavailable')
  const data = await response.arrayBuffer()
  const header = new DataView(data)
  const count = header.getUint32(0, true), indices = header.getUint32(4, true)
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(data, 8, count * 3), 3))
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(data, 8 + count * 12, count * 3), 3))
  geometry.setIndex(new BufferAttribute(new Uint16Array(data, 8 + count * 24, indices), 1))
  const uniforms = { uTime: { value: 0 }, uOpacity: { value: 0 }, uProgress: { value: 0 } }
  const material = new ShaderMaterial({
    uniforms, transparent: true, depthWrite: true, premultipliedAlpha: true,
    vertexShader: `
      varying vec3 vPosition;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vPosition = position;
        vNormal = normalize(normalMatrix * normal);
        vec4 view = modelViewMatrix * vec4(position, 1.0);
        vView = -view.xyz;
        gl_Position = projectionMatrix * view;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uOpacity;
      uniform float uProgress;
      varying vec3 vPosition;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vec3 n = normalize(vNormal);
        vec3 eye = normalize(vView);
        vec3 p = vPosition;
        float rim = pow(1.0 - max(0.0, dot(n, eye)), 3.0);
        float light = max(0.0, dot(n, normalize(vec3(-0.6, 0.8, 1.2))));
        float sheen = pow(max(0.0, dot(reflect(-normalize(vec3(-0.8, 0.9, 1.0)), n), eye)), 28.0);
        float phase = (p.y + 0.065 * sin(p.x * 5.0 + p.z * 2.4) + 0.014 * sin(p.z * 12.0 + uTime * 0.23)) * 69.0;
        float distanceToLine = abs(fract(phase - 0.018 * uTime) - 0.5);
        float aa = max(fwidth(phase) * 0.65, 0.015);
        float line = 1.0 - smoothstep(0.065, 0.065 + aa, distanceToLine);
        float pulse = pow(max(0.0, sin(p.y * 2.4 + p.z * 2.1 - uTime * 0.7)), 12.0);
        vec3 cyan = vec3(0.06, 0.79, 0.94);
        vec3 violet = vec3(0.32, 0.24, 0.83);
        vec3 coral = vec3(1.0, 0.25, 0.16);
        float warm = (1.0 - smoothstep(-0.8, 0.55, p.y + p.x * 1.35)) * 0.86;
        vec3 ink = mix(cyan, violet, (1.0 - light) * 0.48);
        ink = mix(ink, coral, warm);
        vec3 skin = vec3(0.009, 0.019, 0.033) + vec3(0.013, 0.056, 0.085) * light;
        vec3 color = skin + ink * line * (0.33 + light * 0.55 + pulse * 0.55);
        color += cyan * (sheen * 0.22 + rim * 0.11);
        float edge = smoothstep(-1.0, -0.58, p.y);
        float reveal = smoothstep(-1.3, -0.9, p.x + uProgress * 2.4);
        float alpha = uOpacity * edge * reveal;
        gl_FragColor = vec4(clamp(color, 0.0, 1.0) * alpha, alpha);
      }
    `,
  })
  const head = new Mesh(geometry, material)
  head.renderOrder = 2
  const root = new Group()
  root.add(head)

  // Fine trailing contours continue off the back of the head, like a long exposure.
  const points: number[] = [], flow: number[] = [], index: number[] = []
  const strands = 46, segments = 88
  for (let row = 0; row < strands; row++) {
    const y = -0.56 + row / (strands - 1) * 1.38
    for (let j = 0; j <= segments; j++) {
      const t = j / segments
      for (const side of [-1, 1]) {
        points.push(0.12 + t * 2.4, y + Math.sin(t * 4 + row * 0.045) * t * 0.14 + side * 0.0015, -0.55 - t * 0.95)
        flow.push(t, row / strands)
      }
      if (j < segments) { const a = (row * (segments + 1) + j) * 2; index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2) }
    }
  }
  const trailsGeometry = new BufferGeometry()
  trailsGeometry.setAttribute('position', new Float32BufferAttribute(points, 3))
  trailsGeometry.setAttribute('aFlow', new Float32BufferAttribute(flow, 2))
  trailsGeometry.setIndex(index)
  const trailsMaterial = new ShaderMaterial({
    uniforms, side: DoubleSide, transparent: true, depthWrite: false, depthTest: true,
    blending: AdditiveBlending, premultipliedAlpha: true, forceSinglePass: true,
    vertexShader: `uniform float uTime; attribute vec2 aFlow; varying vec2 vFlow;
      void main() { vFlow = aFlow; vec3 p = position; p.y += sin(aFlow.x * 6.0 - uTime * 0.3 + aFlow.y * 9.0) * aFlow.x * 0.025;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }`,
    fragmentShader: `uniform float uTime; uniform float uOpacity; varying vec2 vFlow;
      void main() {
        float a = (1.0 - smoothstep(0.05, 1.0, vFlow.x)) * (0.13 + 0.16 * pow(max(0.0, sin(vFlow.x * 12.0 - uTime * 0.6 + vFlow.y * 8.0)), 10.0)) * uOpacity;
        vec3 color = mix(vec3(0.48, 0.2, 0.64), vec3(0.07, 0.67, 0.8), vFlow.y);
        gl_FragColor = vec4(color * a, a);
      }`,
  })
  const trails = new Mesh(trailsGeometry, trailsMaterial)
  trails.renderOrder = 3
  root.add(trails)
  return { root, uniforms, vertices: count, dispose() {
    geometry.dispose(); material.dispose(); trailsGeometry.dispose(); trailsMaterial.dispose()
  } }
}
