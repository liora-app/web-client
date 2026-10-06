// Particle story, told by networks of neurons (see neural.ts): 0 the AI core in glass · 1 scattered
// neurons (noise) · 2 a chain the signal runs along · 3 theses (small networks; two are let go at
// step 4) · 4 the diary graph · 5 keep (the kept theses held in glass) · 6 release (quiet dust to
// read over, no signal) · 7 sunrise (the core again).
// `position` holds the core slot; the other shapes come in as attributes (see shapes.ts).
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
uniform float uFire;      // 0..1: how much signal runs through the network (0 by the crisis contacts)
uniform float uFlash;     // 0..1: how far a flash may brighten a point (low where the net runs under text)
uniform vec4 uWavePeriod; // axon lengths between two signals: core, path, theses, diary

attribute vec3 aPath;
attribute vec4 aCluster; // w: 0 = kept thesis, 0.5 = thesis dropped at step 4, 1 = loose speck
attribute vec3 aConstellation;
attribute vec4 aRandom;
// (t, wave offset) in the core and the path; in the theses and the diary. t: -3 dust, -2 warm glow,
// -1 soma halo, 0..1 along an axon (parent → child), 2..3 along a dendrite (soma → tip).
attribute vec4 aNeural;
attribute vec4 aNeural2;

varying vec3 vColor;
varying float vAlpha;

const float SIGNAL_SPEED = 1.6; // axon lengths per second

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

// The diary graph loosens into a field of dust that stays in frame.
vec3 releaseShape(vec3 p, float seed) {
  vec3 dir = normalize(p + vec3(0.0001));
  return p * 1.15 + dir * 0.5 + vec3(0.0, 0.3 + seed * 0.5, 0.0);
}

vec3 shapeFor(float s) {
  if (s < 0.5) return orbShape(position);
  if (s < 1.5) return noiseShape(position);
  if (s < 2.5) return aPath;
  if (s < 3.5) return aCluster.xyz;
  if (s < 4.5) return aConstellation;
  if (s < 5.5) return aCluster.xyz * vec3(0.3, 0.7, 0.7); // the kept theses, gathered into the glass
  if (s < 6.5) return releaseShape(aConstellation, aRandom.x);
  return orbShape(position * 1.2); // sunrise: spread inside the glass, so its top rises above the fold
}

// This particle in the network of state s: (t, wave offset, wave period); t = -4 where s has none.
vec3 neuralFor(float s) {
  if (s < 1.5 || s > 6.5) return vec3(aNeural.xy, uWavePeriod.x);
  if (s < 2.5) return vec3(aNeural.zw, uWavePeriod.y);
  if (s < 3.5) return vec3(aNeural2.xy, uWavePeriod.z);
  if (s < 4.5) return vec3(aNeural2.zw, uWavePeriod.w);
  if (s < 5.5) return vec3(aNeural2.xy, uWavePeriod.z);
  return vec3(-4.0, 0.0, 1.0);
}

// The signal at this particle, 0..1. The wave leaves each tree level one axon length after the
// previous one; head = axon lengths since it left this particle's level.
float signalAt(vec3 n) {
  if (n.x < -1.5) return 0.0;
  float head = mod(uTime * SIGNAL_SPEED - n.y, n.z);
  if (n.x < -0.5) return 0.45 * exp(-head * 3.0); // soma halo: flashes as the wave arrives
  if (n.x < 1.5) {
    float d = head - n.x; // a bright head with a tail
    return d >= 0.0 ? exp(-d * 5.0) : exp(-d * d * 400.0);
  }
  float d = head * 2.5 - (n.x - 2.0); // dendrites light up outward from the soma, fainter
  return 0.6 * (d >= 0.0 ? exp(-d * 6.0) : exp(-d * d * 400.0));
}

// How visible a network particle is, for the same number of particles over a different area:
// the core packs the whole net into the glass, the noise spreads it over the screen.
float netScale(float s) {
  if (s < 0.5 || s > 6.5) return 0.3;
  if (s < 1.5) return 1.6;
  if (s < 2.5) return 1.0;
  if (s < 3.5) return 0.55;
  if (s < 4.5) return 0.85;
  return 0.75;
}

// How visible a particle is in each state (dust = 1 for background specks). In the light the
// network carries the shape — the glass carries the silhouette — and the warm glow the light.
float alphaFor(float s, float dust) {
  vec3 n = neuralFor(s);
  if (n.x > -2.5 && n.x < -1.5) return s > 0.5 && s < 1.5 ? 0.42 : 0.22; // warm glow
  if (n.x > -1.5) {
    float a = n.x < -0.5 ? 0.3 : n.x < 1.5 ? 0.2 : 0.16 * (1.0 - 0.6 * (n.x - 2.0)); // halo, axon, dendrite
    // Keep: only the kept theses come into the glass.
    float dropped = step(0.25, aCluster.w) * (1.0 - step(0.75, aCluster.w));
    if (s > 4.5 && s < 5.5) a *= 1.0 - 0.9 * dropped;
    return a * netScale(s);
  }
  // Dust and loose specks.
  if (s < 0.5 || s > 6.5) return 0.24;
  if (s < 1.5) return 0.42;
  if (s < 2.5) return 0.22;
  if (s < 3.5) return 0.06;
  if (s < 4.5) return 0.1;
  if (s < 5.5) return 0.02;
  return mix(0.12, 0.05, dust);
}

// Defocus per state: the noise is out of focus, clarity is sharp. Blur grows the point (fill-rate),
// so it is kept small: the light per particle stays the same (see the bokeh divisor in main()).
float blurFor(float s) {
  if (s > 0.5 && s < 1.5) return 0.5;
  if (s > 1.5 && s < 2.5) return 0.08;
  if (s > 5.5 && s < 6.5) return 0.15;
  return 0.0;
}

// Light states (warm core, cool rim).
float orbFor(float s) {
  return (s < 0.5 || s > 6.5) ? 1.0 : 0.0;
}

// Colour of a network particle, premultiplied by how much it replaces the base colour (a): the halo
// is warm, the fibres cool with a little warmth; dust and the glow keep the base colour.
vec4 toneFor(vec3 n) {
  if (n.x < -1.5) return vec4(0.0);
  if (n.x < -0.5) return vec4(mix(uWarm, uHighlight, 0.4), 1.0);
  return vec4(mix(uCool, uWarm, aRandom.y * 0.35), 1.0);
}

void main() {
  float dust = step(0.75, aRandom.w);
  float s0 = floor(uState);
  float f = uState - s0;
  // Stagger: each particle starts its move a little later than the previous ones.
  float delay = aRandom.x * 0.35;
  float k = smoothstep(0.0, 1.0, clamp((f - delay) / 0.65, 0.0, 1.0));

  vec3 p = mix(shapeFor(s0), shapeFor(s0 + 1.0), k);
  vec3 na = neuralFor(s0);
  vec3 nb = neuralFor(s0 + 1.0);
  float signal = mix(signalAt(na), signalAt(nb), k) * uFire;

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
  float size = uSize * uSizeScale * sizeRandom * bokeh * uPixelRatio * (6.5 / depth) * (1.0 + 0.9 * signal * uFlash);
  gl_PointSize = min(size, min(56.0 * uPixelRatio, uMaxPointSize));

  float twinkle = 0.88 + 0.12 * sin(uTime * (0.4 + aRandom.y) + aRandom.x * 40.0);
  float alpha = mix(alphaFor(s0, dust), alphaFor(s0 + 1.0, dust), k);

  // Calm the particles that sit behind text (wide layout): full strength inside uBand, softened outside.
  float inside = smoothstep(-0.12, 0.3, min(ndc.x - uBand.x, uBand.y - ndc.x));
  float textMask = 1.0 - uDim * (1.0 - inside);

  // Flashes stay calm behind the text, too: outside the band (textMask) and in one column (uFlash).
  vAlpha = alpha * twinkle * uIntensity * textMask / (bokeh * bokeh * 0.7 + 0.3) * (1.0 - drop * 0.85) * (1.0 + 4.0 * signal * textMask * uFlash);

  float orbness = mix(orbFor(s0), orbFor(s0 + 1.0), k);
  float core = 1.0 - smoothstep(0.25, 0.95, length(position));
  vec3 base = mix(uCool, uWarm, smoothstep(0.25, 0.85, aRandom.y));
  base = mix(base, uWarm, orbness * core * 0.85);
  base = mix(base, uHighlight, orbness * core * core * 0.6);
  vec4 tone = mix(toneFor(na), toneFor(nb), k);
  vColor = mix(base * (1.0 - tone.a) + tone.rgb, uHighlight, signal);
}
