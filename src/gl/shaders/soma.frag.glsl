// Soma body: a warm core seen through a cool rim, one glossy highlight, brighter while the signal
// passes. Additive and premultiplied (rgb <= alpha), like the particles.

uniform float uOpacity;
uniform vec3 uCool;
uniform vec3 uWarm;
uniform vec3 uHighlight;

varying vec3 vNormal;
varying vec3 vView;
varying float vFire;
varying float vMask;

void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(vView);
  float ndv = clamp(dot(n, v), 0.0, 1.0);
  float core = pow(ndv, 2.2);
  float rim = pow(1.0 - ndv, 2.0);
  vec3 keyLight = normalize(vec3(-0.5, 0.7, 0.55));
  float spec = pow(max(dot(reflect(-keyLight, n), v), 0.0), 40.0) * 0.7;

  vec3 tint = mix(uCool, mix(uWarm, uHighlight, 0.35 + 0.65 * vFire), core / (core + rim + 1e-3));
  tint = mix(tint, uHighlight, min(1.0, spec));
  float alpha = clamp(core * (0.5 + 0.5 * vFire) + rim * 0.45 + spec, 0.0, 1.0);
  // No MSAA: soften the last two pixels of the silhouette (see glass.frag.glsl).
  float edge = smoothstep(0.0, 2.0, ndv / max(2.0 * fwidth(ndv), 1e-4));
  alpha *= uOpacity * vMask * edge;
  gl_FragColor = vec4(tint * alpha, alpha);
}
