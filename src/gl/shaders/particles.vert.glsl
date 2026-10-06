// Particle story: 0 light · 1 noise · 2 threads · 3 theses · 4 constellation · 5 keep (the themes held
// in glass) · 6 release (quiet dust to read over) · 7 sunrise.
// `position` holds the orb slot; the other shapes come in as attributes (see shapes.ts).
// three.js injects projectionMatrix, modelViewMatrix and the GLSL3 conversion.

uniform float uTime;
uniform float uState;
uniform float uPixelRatio;
uniform float uSize;
uniform float uSizeScale; // apparent shape size vs the tuned reference (see scene.ts)
uniform float uMaxPointSize; // ALIASED_POINT_SIZE_RANGE max of this GPU
uniform float uAspect;
uniform float uFocus;
uniform float uBreath;
uniform float uIntensity;
uniform vec2 uBand;       // NDC x range where the light lives; outside it the text does (wide layout)
uniform float uDim;       // how much to calm particles outside that band (0..1)
uniform vec2 uPointer;
uniform float uPointerStrength;
uniform vec3 uCool;
uniform vec3 uWarm;
uniform vec3 uHighlight;
uniform float uDecide;    // 0..1: step 4 has been reached, the dropped theses dissolve

attribute vec3 aThread;
attribute vec4 aCluster; // w: 0 = kept thesis, 0.5 = thesis dropped at step 4, 1 = loose speck
attribute vec3 aConstellation;
attribute vec4 aRandom;

#ifdef NEURAL
// Spike (?scene=neural, see neural.ts): x, y = state 0 (t, wave offset), z, w = the same for state 2.
// t: -2 dust, -1 soma halo, 0..1 along an axon, 2..3 along a dendrite.
attribute vec4 aNeural;
uniform vec2 uWavePeriod; // axon lengths between two signals (state 0, state 2)
const float SIGNAL_SPEED = 1.6; // axon lengths per second
#endif

varying vec3 vColor;
varying float vAlpha;

mat2 rotate2d(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, -s, s, c);
}

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

vec3 threadShape(vec3 p, float seed) {
  float wave = sin(p.x * 1.2 + uTime * 0.3 + seed * 6.2831) * 0.07;
  return p + vec3(0.0, wave, 0.0);
}

// The constellation loosens into a field of dust that stays in frame.
vec3 releaseShape(vec3 p, float seed) {
  vec3 dir = normalize(p + vec3(0.0001));
  return p * 1.15 + dir * 0.5 + vec3(0.0, 0.3 + seed * 0.5, 0.0);
}

vec3 shapeFor(float s) {
  if (s < 0.5) return orbShape(position);
  if (s < 1.5) return noiseShape(position);
#ifdef NEURAL
  if (s < 2.5) return aThread; // the chain holds still; the signal moves
#else
  if (s < 2.5) return threadShape(aThread, aRandom.y);
#endif
  if (s < 3.5) return aCluster.xyz;
  if (s < 4.5) return aConstellation;
  if (s < 5.5) return aCluster.xyz * vec3(0.3, 0.7, 0.7); // the kept theses, gathered into the glass
  if (s < 6.5) return releaseShape(aConstellation, aRandom.x);
  return orbShape(position);
}

#ifdef NEURAL
// (t, wave offset) of this particle in state s; t = -3 where s is not a neural state.
vec2 neuralFor(float s) {
  if (s < 0.5 || s > 6.5) return aNeural.xy;
  if (s > 1.5 && s < 2.5) return aNeural.zw;
  return vec2(-3.0, 0.0);
}

float periodFor(float s) {
  return (s > 1.5 && s < 2.5) ? uWavePeriod.y : uWavePeriod.x;
}

// The signal at this particle, 0..1. The wave leaves each tree level one axon length after the
// previous one; head = axon lengths since it left this particle's level.
float signalAt(vec2 n, float period) {
  if (n.x < -1.5) return 0.0;
  float head = mod(uTime * SIGNAL_SPEED - n.y, period);
  if (n.x < -0.5) return 0.45 * exp(-head * 3.0); // soma halo: flashes as the wave arrives
  if (n.x < 1.5) {
    float d = head - n.x; // a bright head with a tail
    return d >= 0.0 ? exp(-d * 5.0) : exp(-d * d * 400.0);
  }
  float d = head * 2.5 - (n.x - 2.0); // dendrites light up outward from the soma, fainter
  return 0.6 * (d >= 0.0 ? exp(-d * 6.0) : exp(-d * d * 400.0));
}

// The core (state 0) packs the whole network into the glass: same particles, a fraction of the area.
float neuralAlpha(vec2 n, float s) {
  float k = (s > 1.5 && s < 2.5) ? 1.0 : 0.22;
  if (n.x < -0.5) return 0.3 * k;
  if (n.x < 1.5) return 0.2 * k;
  return 0.16 * k * (1.0 - 0.6 * (n.x - 2.0)); // thinner toward the dendrite's tip
}
#endif

// How visible a particle is in each state (dust = 1 for background specks, line = 1 for
// particles that draw the constellation's connections). In the light (orb) the outer shell stays
// faint — the glass carries the silhouette — and the warm core carries the light.
float orbAlpha(float dust) {
  float shell = smoothstep(0.84, 0.9, length(position));
  return mix(mix(0.62, 0.18, shell), 0.24, dust);
}

float alphaFor(float s, float dust, float line) {
#ifdef NEURAL
  vec2 n = neuralFor(s);
  if (n.x > -1.5) return neuralAlpha(n, s);
#endif
  if (s < 0.5) return orbAlpha(dust);
  if (s < 1.5) return 0.42;
  if (s < 2.5) return mix(0.6, 0.22, dust);
  if (s < 3.5) return mix(0.3, 0.06, max(dust, step(0.75, aCluster.w)));
  if (s < 4.5) return mix(mix(0.42, 0.11, line), 0.1, dust);
  if (s < 5.5) return mix(0.14, 0.02, max(dust, step(0.25, aCluster.w)));
  if (s < 6.5) return mix(0.12, 0.05, dust);
  return orbAlpha(dust);
}

// Defocus per state: the noise is out of focus, clarity is sharp. Blur grows the point (fill-rate),
// so it is kept small: the light per particle stays the same (see the bokeh divisor in main()).
float blurFor(float s) {
  if (s > 0.5 && s < 1.5) return 0.5;
#ifdef NEURAL
  if (s > 1.5 && s < 2.5) return 0.08;
#else
  if (s > 1.5 && s < 2.5) return 0.25;
#endif
  if (s > 5.5 && s < 6.5) return 0.15;
  return 0.0;
}

// How strongly main particles take the highlight colour (clarity states glow warmer).
float clarityFor(float s, float line) {
  if (s > 2.5 && s < 3.5) return 1.0;
  if (s > 3.5 && s < 4.5) return 1.0 - line;
  if (s > 4.5 && s < 5.5) return 1.0;
  if (s > 1.5 && s < 2.5) return 0.35;
  return 0.0;
}

// Orb states: warm core, cool rim.
float orbFor(float s) {
  return (s < 0.5 || s > 6.5) ? 1.0 : 0.0;
}

void main() {
  float dust = step(0.75, aRandom.w);
  float line = (1.0 - dust) * step(0.25, aRandom.w);
  float s0 = floor(uState);
  float f = uState - s0;
  // Stagger: each particle starts its move a little later than the previous ones.
  float delay = aRandom.x * 0.35;
  float k = smoothstep(0.0, 1.0, clamp((f - delay) / 0.65, 0.0, 1.0));

  vec3 p = mix(shapeFor(s0), shapeFor(s0 + 1.0), k);

#ifdef NEURAL
  vec2 na = neuralFor(s0);
  vec2 nb = neuralFor(s0 + 1.0);
  float signal = mix(signalAt(na, periodFor(s0)), signalAt(nb, periodFor(s0 + 1.0)), k);
#endif

  // Step 4: the two dropped theses drift apart and toward the lens, where the defocus dissolves
  // them into the bokeh. Only around the theses state; the kept three stay where they are.
  float drop = step(0.25, aCluster.w) * (1.0 - step(0.75, aCluster.w)) * uDecide * (1.0 - min(1.0, abs(uState - 3.0)));
  p += ((aRandom.xyz - 0.5) * vec3(2.4, 2.4, 0.0) + vec3(0.0, 0.0, 2.2)) * drop;

  // Idle drift so nothing is ever perfectly still.
  vec3 dq = p * 0.7 + aRandom.xyz * 9.0 + vec3(uTime * 0.045);
  p += vec3(snoise(dq), snoise(dq + 31.7), snoise(dq + 57.1)) * 0.03;

  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);

  // Pointer: a soft swirl around the cursor, never a hard push.
  vec4 clip = projectionMatrix * mvPosition;
  vec2 ndc = clip.xy / clip.w;
  vec2 d = ndc - uPointer;
  d.x *= uAspect;
  float dist = length(d);
  float push = uPointerStrength * (1.0 - smoothstep(0.0, 0.42, dist));
  vec2 dir = d / max(dist, 0.0001);
  vec2 swirl = vec2(-dir.y, dir.x);
  mvPosition.xy += (dir * 0.55 + swirl * 0.45) * push * 0.035 * -mvPosition.z;

  gl_Position = projectionMatrix * mvPosition;

  float depth = -mvPosition.z;
  float blur = mix(blurFor(s0), blurFor(s0 + 1.0), k);
  float sizeRandom = mix(0.6, 1.8, aRandom.z * aRandom.z);
  float coc = abs(depth - uFocus);
  float bokeh = 1.0 + coc * coc * 0.55 + blur * (0.8 + aRandom.z * 1.6);
  float size = uSize * uSizeScale * sizeRandom * bokeh * uPixelRatio * (6.5 / depth);
#ifdef NEURAL
  size *= 1.0 + 0.9 * signal;
#endif
  gl_PointSize = min(size, min(56.0 * uPixelRatio, uMaxPointSize));

  float twinkle = 0.88 + 0.12 * sin(uTime * (0.4 + aRandom.y) + aRandom.x * 40.0);
  float alpha = mix(alphaFor(s0, dust, line), alphaFor(s0 + 1.0, dust, line), k);

  // Calm the particles that sit behind text (wide layout): full strength inside uBand, softened outside.
  float inside = smoothstep(-0.12, 0.3, min(ndc.x - uBand.x, uBand.y - ndc.x));
  float textMask = 1.0 - uDim * (1.0 - inside);

  vAlpha = alpha * twinkle * uIntensity * textMask / (bokeh * bokeh * 0.7 + 0.3) * (1.0 - drop * 0.85);

  float clarity = mix(clarityFor(s0, line), clarityFor(s0 + 1.0, line), k) * (1.0 - dust);
  float orbness = mix(orbFor(s0), orbFor(s0 + 1.0), k);
  float core = 1.0 - smoothstep(0.25, 0.95, length(position));
  vec3 base = mix(uCool, uWarm, smoothstep(0.25, 0.85, aRandom.y));
  base = mix(base, uWarm, orbness * core * 0.85);
  base = mix(base, uHighlight, orbness * core * core * 0.6);
  // Clarity (theses, themes) glows warm rather than white.
  vColor = mix(base, mix(uWarm, uHighlight, 0.45), clarity * 0.6);

#ifdef NEURAL
  float neural = mix(step(-1.5, na.x), step(-1.5, nb.x), k);
  float body = mix(step(-1.5, na.x) * (1.0 - step(-0.5, na.x)), step(-1.5, nb.x) * (1.0 - step(-0.5, nb.x)), k);
  vec3 fibre = mix(uCool, uWarm, aRandom.y * 0.35);
  vColor = mix(vColor, mix(fibre, mix(uWarm, uHighlight, 0.4), body), neural);
  vColor = mix(vColor, uHighlight, signal);
  vAlpha *= 1.0 + 4.0 * signal * textMask; // flashes stay calm behind the text, too
#endif
}
