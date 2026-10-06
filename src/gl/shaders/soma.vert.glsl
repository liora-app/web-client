// Spike (?scene=neural): soma bodies, one sphere instance each. They move between the neural states
// the way the particles do (see particles.vert.glsl) and flash when the signal reaches them.

uniform float uTime;
uniform float uState;
uniform float uBreath;
uniform vec2 uWavePeriod;
uniform float uAspect;
uniform vec2 uBand;
uniform float uDim;
uniform vec2 uPointer;
uniform float uPointerStrength;

attribute vec4 aSomaA;    // state 0: centre, radius (0 = absent)
attribute vec4 aSomaB;    // state 2
attribute vec4 aSomaWave; // x: wave offset in state 0, y: in state 2, z: random

varying vec3 vNormal;
varying vec3 vView;
varying float vFire;
varying float vMask;

const float SIGNAL_SPEED = 1.6;

mat2 rotate2d(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, -s, s, c);
}

// Same motion as the particles' orbShape.
vec3 orbShape(vec3 p) {
  vec3 q = p * (1.0 + 0.06 * uBreath);
  q.xz = rotate2d(uTime * 0.04) * q.xz;
  q.xy = rotate2d(0.35) * q.xy;
  return q;
}

vec4 somaFor(float s) {
  if (s < 0.5 || s > 6.5) return vec4(orbShape(aSomaA.xyz), aSomaA.w);
  if (s > 1.5 && s < 2.5) return aSomaB;
  return vec4(0.0);
}

float fireFor(float s) {
  bool chain = s > 1.5 && s < 2.5;
  return exp(-mod(uTime * SIGNAL_SPEED - (chain ? aSomaWave.y : aSomaWave.x), chain ? uWavePeriod.y : uWavePeriod.x) * 4.0);
}

void main() {
  float s0 = floor(uState);
  float f = uState - s0;
  float k = smoothstep(0.0, 1.0, clamp((f - aSomaWave.z * 0.35) / 0.65, 0.0, 1.0));

  // A soma that exists in only one of the two states grows or shrinks in place.
  vec4 a = somaFor(s0);
  vec4 b = somaFor(s0 + 1.0);
  if (a.w == 0.0) a.xyz = b.xyz;
  if (b.w == 0.0) b.xyz = a.xyz;
  vec4 soma = mix(a, b, k);
  vFire = mix(a.w > 0.0 ? fireFor(s0) : 0.0, b.w > 0.0 ? fireFor(s0 + 1.0) : 0.0, k);

  vec3 p = soma.xyz + position * soma.w * (1.0 + 0.2 * vFire);
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);

  // The particles' pointer swirl, measured at the soma's centre so the body stays round.
  vec4 centre = modelViewMatrix * vec4(soma.xyz, 1.0);
  vec4 clip = projectionMatrix * centre;
  vec2 d = clip.xy / clip.w - uPointer;
  d.x *= uAspect;
  float dist = length(d);
  float push = uPointerStrength * (1.0 - smoothstep(0.0, 0.42, dist));
  vec2 dir = d / max(dist, 0.0001);
  mvPosition.xy += (dir * 0.55 + vec2(-dir.y, dir.x) * 0.45) * push * 0.035 * -centre.z;

  vNormal = normalize(normalMatrix * normal);
  vView = normalize(-mvPosition.xyz);
  gl_Position = projectionMatrix * mvPosition;

  vec2 ndc = gl_Position.xy / gl_Position.w;
  float inside = smoothstep(-0.12, 0.3, min(ndc.x - uBand.x, uBand.y - ndc.x));
  vMask = 1.0 - uDim * (1.0 - inside);
}
