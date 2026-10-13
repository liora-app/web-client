uniform float uTime;
uniform float uOpacity;
uniform float uGain;
uniform float uFinal;
uniform vec2 uResolution;
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
  vec3 blue = vec3(0.12, 0.37, 0.95);
  vec3 mint = vec3(0.26, 0.95, 0.85);
  vec3 gold = vec3(1.0, 0.66, 0.30);
  float warm = smoothstep(-0.35, 0.65, vLocal.x + vLocal.y * 0.5);
  vec3 color = mix(blue, mint, smoothstep(-0.8, 0.3, vLocal.y + vLocal.z * 0.6));
  color = mix(color, gold, warm * 0.9);
  color = mix(color, vec3(0.87, 0.99, 0.95), pulse * 0.65);
  float alpha = edge * (0.18 + 0.11 * flow + 0.56 * pulse) * variation * mix(0.22, 0.95, vDepth) * uOpacity * uGain;
  vec2 screen = gl_FragCoord.xy / uResolution;
  float protect = 1.0 - (1.0 - smoothstep(0.16, 0.34, abs(screen.x - 0.5))) * uFinal * 0.96;
  alpha = min(alpha * protect, 1.0);
  gl_FragColor = vec4(color * alpha, alpha);
}
