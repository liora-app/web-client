// Soma bodies, one sphere instance each. They move between the states the way the particles do (see
// particles.vert.glsl) and flash when the signal reaches them. noise.glsl is prepended (scene.ts).

uniform float uTime;
uniform float uState;
uniform float uBreath;
uniform float uDecide;
uniform float uFire;
uniform float uFlash; // see particles.vert.glsl
uniform vec4 uWavePeriod;
uniform float uAspect;
uniform vec2 uBand;
uniform float uDim;
uniform vec2 uPointer;
uniform float uPointerStrength;

// Centre and radius (0 = absent) in each net; see shapes.ts (SomaSet).
attribute vec4 aSomaCore;
attribute vec4 aSomaPath;
attribute vec4 aSomaCluster;
attribute vec4 aSomaDiary;
attribute vec4 aSomaWave; // wave offsets: core, path, theses, diary
attribute vec4 aSomaMeta; // x: random, y: 1 = a thesis dropped at step 4

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

// Same motion as the particles' shapes.
vec3 orbShape(vec3 p) {
  vec3 q = p * (1.0 + 0.06 * uBreath);
  q.xz = rotate2d(uTime * 0.04) * q.xz;
  q.xy = rotate2d(0.35) * q.xy;
  return q;
}

vec3 noiseShape(vec3 p) {
  vec3 q = p * 0.5 + vec3(0.0, 0.0, uTime * 0.03);
  vec3 n = vec3(snoise(q), snoise(q + 19.1), snoise(q + 47.3));
  return p * 2.1 + n * 1.5;
}

vec4 somaFor(float s) {
  if (s < 0.5) return vec4(orbShape(aSomaCore.xyz), aSomaCore.w);
  // Sunrise (see particles.vert.glsl): smaller bodies, the light is large here.
  if (s > 6.5) return vec4(orbShape(aSomaCore.xyz * 1.2), aSomaCore.w * 0.55);
  if (s < 1.5) return vec4(noiseShape(aSomaCore.xyz), aSomaCore.w);
  if (s < 2.5) return aSomaPath;
  if (s < 3.5) return aSomaCluster;
  if (s < 4.5) return aSomaDiary;
  if (s < 5.5) return vec4(aSomaCluster.xyz * vec3(0.3, 0.7, 0.7), aSomaCluster.w * 0.9 * (1.0 - aSomaMeta.y));
  return vec4(0.0); // release: no network
}

// The soma flashes as the wave reaches its level (see signalAt in particles.vert.glsl).
float fireFor(float s) {
  vec2 wave = vec2(0.0);
  if (s < 1.5 || s > 6.5) wave = vec2(aSomaWave.x, uWavePeriod.x);
  else if (s < 2.5) wave = vec2(aSomaWave.y, uWavePeriod.y);
  else if (s < 3.5 || (s > 4.5 && s < 5.5)) wave = vec2(aSomaWave.z, uWavePeriod.z);
  else if (s < 4.5) wave = vec2(aSomaWave.w, uWavePeriod.w);
  else return 0.0;
  return exp(-mod(uTime * SIGNAL_SPEED - wave.x, wave.y) * 4.0);
}

void main() {
  float s0 = floor(uState);
  float f = uState - s0;
  float k = smoothstep(0.0, 1.0, clamp((f - aSomaMeta.x * 0.35) / 0.65, 0.0, 1.0));

  // A soma that exists in only one of the two states grows or shrinks in place.
  vec4 a = somaFor(s0);
  vec4 b = somaFor(s0 + 1.0);
  if (a.w == 0.0) a.xyz = b.xyz;
  if (b.w == 0.0) b.xyz = a.xyz;
  vec4 soma = mix(a, b, k);
  vFire = mix(a.w > 0.0 ? fireFor(s0) : 0.0, b.w > 0.0 ? fireFor(s0 + 1.0) : 0.0, k) * uFire * uFlash;

  // Step 4: the dropped theses shrink away with their particles.
  soma.w *= 1.0 - aSomaMeta.y * uDecide * (1.0 - min(1.0, abs(uState - 3.0)));

  vec3 p = soma.xyz + position * soma.w * (1.0 + 0.15 * vFire);
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
