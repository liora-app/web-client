uniform float uOpacity;
uniform float uFinal;
uniform vec2 uProtect;
uniform vec2 uResolution;
// The theme's colours and how much of them (core/palette.ts ScenePalette.motes).
uniform vec3 uMoteCool;
uniform vec3 uMoteWarm;
uniform float uMoteAlpha;
varying float vAlpha;
varying float vWarm;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = dot(p, p);
  float alpha = exp(-r * 5.0) * (1.0 - smoothstep(0.5, 1.0, r)) * vAlpha * uOpacity * uMoteAlpha;
  vec2 screen = gl_FragCoord.xy / uResolution;
  alpha *= 1.0 - (1.0 - smoothstep(uProtect.x, uProtect.y, abs(screen.x - 0.5))) * uFinal;
  vec3 color = mix(uMoteCool, uMoteWarm, vWarm);
  gl_FragColor = vec4(color * alpha, alpha);
}
