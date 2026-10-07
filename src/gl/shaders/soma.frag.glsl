// Soma body: a luminous pearl lit from the upper left (the glass's key light): a warm body that
// glows a little on its own, a cool rim and one glossy highlight; it brightens while the signal
// passes. Normal blending, premultiplied (rgb <= alpha): the bodies cover what is behind them, which
// is what makes them read as objects rather than more light.

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
  vec3 keyLight = normalize(vec3(-0.5, 0.7, 0.55));
  float lit = max((dot(n, keyLight) + 0.3) / 1.3, 0.0); // a soft terminator
  float rim = pow(1.0 - ndv, 2.5);
  float spec = pow(max(dot(reflect(-keyLight, n), v), 0.0), 48.0);

  vec3 body = mix(uWarm, uHighlight, 0.45 + 0.5 * vFire);
  vec3 color = body * (0.32 + 0.6 * lit + 0.3 * vFire) + uCool * rim * 0.5 + vec3(spec * 0.9);
  // No MSAA: soften the last two pixels of the silhouette (see glass.frag.glsl).
  float edge = smoothstep(0.0, 2.0, ndv / max(2.0 * fwidth(ndv), 1e-4));
  float alpha = 0.85 * uOpacity * vMask * edge;
  gl_FragColor = vec4(min(color, vec3(1.0)) * alpha, alpha);
}
