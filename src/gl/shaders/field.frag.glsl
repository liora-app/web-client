uniform float uTime;
uniform float uOpacity;
uniform float uGain;
uniform float uFinal;
// The final's text column (half-widths from the centre, screen fraction): inner edge, outer edge.
uniform vec2 uProtect;
uniform vec2 uResolution;
// The theme's colours and how much of them (core/palette.ts ScenePalette.field).
uniform vec3 uFieldBlue;
uniform vec3 uFieldMint;
uniform vec3 uFieldGold;
uniform vec3 uFieldFlash;
uniform float uFieldAlpha;
varying float vEdge;
varying float vAlong;
varying float vSeed;
varying float vDepth;
varying vec3 vLocal;
void main() {
  float edge = exp(-vEdge * vEdge * 4.2) * (1.0 - smoothstep(0.78, 1.0, abs(vEdge)));
  float flow = sin(vAlong * 24.0 - uTime * 0.55 + vSeed * 27.0);
  float pulse = pow(max(0.0, sin(vAlong * 6.28318 - uTime * 0.23 + vSeed * 5.0)), 14.0);
  float variation = 0.45 + 0.55 * sin(vSeed * 239.7) * sin(vSeed * 239.7);
  float warm = smoothstep(-0.35, 0.65, vLocal.x + vLocal.y * 0.5);
  vec3 color = mix(uFieldBlue, uFieldMint, smoothstep(-0.8, 0.3, vLocal.y + vLocal.z * 0.6));
  color = mix(color, uFieldGold, warm * 0.9);
  color = mix(color, uFieldFlash, pulse * 0.65);
  float alpha = edge * (0.18 + 0.11 * flow + 0.56 * pulse) * variation * mix(0.22, 0.95, vDepth) * uOpacity * uGain * uFieldAlpha;
  vec2 screen = gl_FragCoord.xy / uResolution;
  // Under the final's words the light is at most 1 − uFinal (.15) of its own: clipped to 1 first, then
  // guarded, so a pulse cannot lift it past the guard (the text keeps 4.5:1, ADR-013).
  float protect = 1.0 - (1.0 - smoothstep(uProtect.x, uProtect.y, abs(screen.x - 0.5))) * uFinal;
  alpha = min(alpha, 1.0) * protect;
  gl_FragColor = vec4(color * alpha, alpha);
}
