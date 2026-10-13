uniform float uTime;
uniform float uOpacity;
uniform float uState;
uniform float uFinal;
uniform vec2 uResolution;
varying vec2 vUv;
void main() {
  vec2 p = (vUv - 0.5) * 3.6;
  float r = length(p);
  float a = atan(p.y, p.x);
  float hero = 1.0 - 0.6 * smoothstep(3.0, 4.0, uState) * (1.0 - smoothstep(4.0, 5.0, uState));
  float ring = exp(-pow((r - 0.89 - 0.025 * sin(a * 3.0 + uTime * 0.1)) / 0.12, 2.0));
  float halo = exp(-r * r * 1.8);
  float heart = exp(-dot(p - vec2(0.18, -0.08), p - vec2(0.18, -0.08)) * 7.0);
  float wisps = 0.5 + 0.5 * sin(a * 4.0 - r * 9.0 + uTime * 0.12);
  vec3 cool = vec3(0.07, 0.37, 0.52);
  vec3 warm = vec3(0.8, 0.32, 0.09);
  vec3 color = mix(cool, warm, smoothstep(-0.8, 0.7, p.x + p.y * 0.55));
  float alpha = (halo * 0.27 + ring * 0.22 * wisps + heart * 0.2) * uOpacity * hero;
  vec2 screen = gl_FragCoord.xy / uResolution;
  alpha *= 1.0 - (1.0 - smoothstep(0.16, 0.34, abs(screen.x - 0.5))) * uFinal;
  gl_FragColor = vec4(color * alpha, alpha);
}
