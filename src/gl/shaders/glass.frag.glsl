// Thin glass: almost clear in the middle, a cool rim with a trace of thin film (no rainbow), one key
// highlight and a warm bounce from the light inside. No refraction pass — the text behind stays
// readable. Output is premultiplied and keeps rgb <= alpha, as the transparent canvas requires.

uniform float uTime;
uniform float uOpacity;
uniform float uRimPower;
uniform float uBody;
uniform float uSpecular;
uniform vec3 uWarm;
uniform vec3 uTint; // the rim's colour: cool glass at night, a teal-grey line on paper (palette.ts)

varying vec3 vNormal;
varying vec3 vView;
varying vec3 vObject;

vec3 thinFilm(float t) {
  return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67)));
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(vView);
  if (!gl_FrontFacing) n = -n;
  float ndv = clamp(dot(n, v), 0.0, 1.0);
  float rim = pow(1.0 - ndv, uRimPower);

  vec3 film = thinFilm(rim * 1.35 + vObject.y * 0.22 + uTime * 0.015);
  vec3 tint = mix(mix(uTint, uWarm, 0.15), film, 0.15);

  vec3 keyLight = normalize(vec3(-0.5, 0.7, 0.55));
  float spec = pow(max(dot(reflect(-keyLight, n), v), 0.0), 90.0) * uSpecular;
  float bounce = pow(max(dot(n, normalize(vec3(0.25, -0.85, 0.45))), 0.0), 2.5) * 0.35;

  float alpha = clamp(uBody + rim * 0.8 + spec + bounce * 0.4, 0.0, 1.0);
  vec3 color = tint * rim + vec3(spec) + uWarm * bounce;
  // Scale the whole colour down to alpha instead of clamping each channel: same hue, still premultiplied.
  float peak = max(color.r, max(color.g, color.b));
  color *= min(1.0, alpha / max(peak, 1e-4));
  // The silhouette is where the rim is brightest, and the canvas has no MSAA: fade the last two
  // pixels before the edge so the outline is smooth instead of a staircase. Near the silhouette
  // ndv ~ sqrt(2d/R) for a pixel d from the edge, so d ~ ndv / (2 * fwidth(ndv)) in screen pixels.
  float edgePx = ndv / max(2.0 * fwidth(ndv), 1e-4);
  float edge = smoothstep(0.0, 2.0, edgePx);
  gl_FragColor = vec4(color, alpha) * (uOpacity * edge);
}
