uniform vec3 uColor;
uniform float uStrength;

varying vec2 vUv;

void main() {
  float d = length(vUv - 0.5) * 2.0;
  float a = exp(-d * d * 3.2) * (1.0 - smoothstep(0.75, 1.0, d)) * uStrength;
  // Premultiplied, rgb <= alpha.
  gl_FragColor = vec4(uColor * a, a);
}
