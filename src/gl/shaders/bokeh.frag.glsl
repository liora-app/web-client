varying vec3 vColor;
varying float vAlpha;

void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  // A lens disc: flat body, slightly brighter rim, soft edge.
  float disc = 1.0 - smoothstep(0.84, 1.0, d);
  float rim = smoothstep(0.62, 0.92, d) * disc;
  float a = (disc * 0.55 + rim * 0.45) * vAlpha;
  // Premultiplied, rgb <= alpha.
  gl_FragColor = vec4(vColor * a, a);
}
