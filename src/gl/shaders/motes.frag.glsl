uniform float uOpacity;
uniform float uFinal;
uniform vec2 uResolution;
varying float vAlpha;
varying float vWarm;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = dot(p, p);
  float alpha = exp(-r * 5.0) * (1.0 - smoothstep(0.5, 1.0, r)) * vAlpha * uOpacity;
  vec2 screen = gl_FragCoord.xy / uResolution;
  alpha *= 1.0 - (1.0 - smoothstep(0.16, 0.34, abs(screen.x - 0.5))) * uFinal * 0.98;
  vec3 color = mix(vec3(0.34, 0.82, 1.0), vec3(1.0, 0.78, 0.47), vWarm);
  gl_FragColor = vec4(color * alpha, alpha);
}
