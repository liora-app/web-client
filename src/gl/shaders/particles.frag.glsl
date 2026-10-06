varying vec3 vColor;
varying float vAlpha;

void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  // Soft body + small bright core; overlaps add up to glow (no bloom pass).
  float glow = exp(-r2 * 3.4) * (1.0 - smoothstep(0.7, 1.0, r2));
  float core = exp(-r2 * 20.0) * 0.55;
  float a = (glow + core) * vAlpha;
  // Premultiplied, rgb <= alpha: the canvas is transparent (see scene.ts, blending).
  gl_FragColor = vec4(vColor * a, a);
}
