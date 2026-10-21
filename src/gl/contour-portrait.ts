import { AdditiveBlending, BufferAttribute, BufferGeometry, DoubleSide, Float32BufferAttribute, Group, Mesh, NormalBlending, ShaderMaterial, Vector3 } from 'three'
import { type ScenePalette, setRgb } from './core/palette'

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
  const uniforms = {
    uTime: { value: 0 }, uOpacity: { value: 0 }, uProgress: { value: 0 },
    // The theme (setPalette, core/palette.ts ScenePalette.portrait and .trails).
    uCyan: { value: new Vector3() }, uViolet: { value: new Vector3() }, uCoral: { value: new Vector3() },
    uSkin: { value: new Vector3() }, uSkinLit: { value: new Vector3() },
    uOver: { value: 0 }, uLineGain: { value: 1 }, uSheen: { value: 0.22 }, uRim: { value: 0.11 },
    uTrailViolet: { value: new Vector3() }, uTrailTeal: { value: new Vector3() }, uTrailAlpha: { value: 1 },
  }
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
      uniform vec3 uCyan;
      uniform vec3 uViolet;
      uniform vec3 uCoral;
      uniform vec3 uSkin;
      uniform vec3 uSkinLit;
      uniform float uOver;
      uniform float uLineGain;
      uniform float uSheen;
      uniform float uRim;
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
        float warm = (1.0 - smoothstep(-0.8, 0.55, p.y + p.x * 1.35)) * 0.86;
        vec3 ink = mix(uCyan, uViolet, (1.0 - light) * 0.48);
        ink = mix(ink, uCoral, warm);
        vec3 skin = uSkin + uSkinLit * light;
        // uOver 0 (night): the lines and the rim add light to a dark head. uOver 1 (day): the paper
        // head is drawn towards the ink (a mix, lineGain keeps it at or under 1).
        vec3 color = skin + (ink - skin * uOver) * line * (0.33 + light * 0.55 + pulse * 0.55) * uLineGain;
        color += (uCyan - color * uOver) * (sheen * uSheen + rim * uRim);
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
    fragmentShader: `uniform float uTime; uniform float uOpacity; uniform vec3 uTrailViolet; uniform vec3 uTrailTeal; uniform float uTrailAlpha; varying vec2 vFlow;
      void main() {
        float a = (1.0 - smoothstep(0.05, 1.0, vFlow.x)) * (0.13 + 0.16 * pow(max(0.0, sin(vFlow.x * 12.0 - uTime * 0.6 + vFlow.y * 8.0)), 10.0)) * uOpacity * uTrailAlpha;
        vec3 color = mix(uTrailViolet, uTrailTeal, vFlow.y);
        gl_FragColor = vec4(color * a, a);
      }`,
  })
  const trails = new Mesh(trailsGeometry, trailsMaterial)
  trails.renderOrder = 3
  root.add(trails)
  /** The theme in place: colours, the head's way of drawing (uOver), the trails' blending. The head
   *  keeps NormalBlending in both themes: it is a solid surface that hides what is behind it. */
  const setPalette = ({ additive, portrait: head, trails: lines }: ScenePalette): void => {
    setRgb(uniforms.uCyan.value, head.cyan)
    setRgb(uniforms.uViolet.value, head.violet)
    setRgb(uniforms.uCoral.value, head.coral)
    setRgb(uniforms.uSkin.value, head.skin)
    setRgb(uniforms.uSkinLit.value, head.skinLit)
    uniforms.uOver.value = head.over
    uniforms.uLineGain.value = head.lineGain
    uniforms.uSheen.value = head.sheen
    uniforms.uRim.value = head.rim
    setRgb(uniforms.uTrailViolet.value, lines.violet)
    setRgb(uniforms.uTrailTeal.value, lines.teal)
    uniforms.uTrailAlpha.value = lines.alpha
    trailsMaterial.blending = additive ? AdditiveBlending : NormalBlending
  }
  return { root, uniforms, setPalette, vertices: count, dispose() {
    geometry.dispose(); material.dispose(); trailsGeometry.dispose(); trailsMaterial.dispose()
  } }
}
