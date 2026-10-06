// Out-of-focus light drifting past the camera. The layer lives in a long tube along z;
// uTravel (scroll + a slow drift) moves it toward the camera and wraps it around, so
// scrolling reads as flying forward through the night.

uniform float uTravel;
uniform float uTime;
uniform float uPixelRatio;
uniform float uMaxPointSize;
uniform float uIntensity;
uniform float uDim;
uniform vec2 uBand;   // NDC x range kept clear of dimming (where the light is)

attribute vec3 aColor;
attribute vec2 aRandom; // x: size, y: phase

varying vec3 vColor;
varying float vAlpha;

const float TUBE = 30.0;
const float NEAR = 4.5;

void main() {
  vec3 p = position;
  p.z = mod(p.z + uTravel, TUBE) - TUBE + NEAR;
  p.x += sin(uTime * 0.05 + aRandom.y * 6.2831) * 0.25;
  p.y += cos(uTime * 0.04 + aRandom.y * 4.0) * 0.18;

  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  float depth = max(0.5, -mvPosition.z);
  float size = mix(26.0, 120.0, aRandom.x * aRandom.x) * uPixelRatio * (6.5 / depth);
  // Big discs are fill-rate: cap them at 180 CSS px.
  gl_PointSize = min(size, min(180.0 * uPixelRatio, uMaxPointSize));

  // Fade in from the far end, out before it reaches the lens.
  float far = smoothstep(-TUBE + NEAR, -TUBE + NEAR + 9.0, p.z);
  float near = 1.0 - smoothstep(NEAR - 4.0, NEAR - 0.5, p.z);
  vec2 ndc = gl_Position.xy / gl_Position.w;
  float outside = 1.0 - smoothstep(0.0, 0.25, min(ndc.x - uBand.x, uBand.y - ndc.x)) ;
  float textMask = 1.0 - uDim * clamp(outside, 0.0, 1.0);
  // Bigger discs are fainter, like real bokeh.
  vAlpha = far * near * textMask * uIntensity * mix(0.2, 0.07, aRandom.x);
  vColor = aColor;
  // Invisible discs are not rasterised at all: outside the clip volume (a point size of 0 is
  // undefined in GLSL ES 3.00).
  if (vAlpha < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
