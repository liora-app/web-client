uniform float uTime;
uniform float uState;
uniform float uHover;
uniform vec2 uPointer;
uniform float uPixelRatio;
uniform float uSize;
attribute vec3 aFlow;
varying float vAlpha;
varying float vWarm;
#include <field_shape>
void main() {
  float t = fract(aFlow.x + uTime * (0.009 + aFlow.z * 0.007));
  vec3 p = flowPoint(t, aFlow.y);
  // Some lights float in front of and behind the main body, with a gentle parallax.
  float outer = step(0.76, aFlow.z);
  p *= 1.0 + outer * (aFlow.z - 0.74) * 3.0;
  p += outer * vec3(sin(aFlow.y * 38.0), cos(aFlow.x * 34.0), sin(aFlow.z * 40.0)) * 0.11;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = uPixelRatio * uSize * mix(1.0, 3.6, pow(aFlow.z, 5.0));
  vAlpha = (0.2 + 0.65 * pow(max(0.0, sin(aFlow.x * 80.0 + uTime * 0.4)), 4.0)) * mix(0.28, 1.0, smoothstep(-0.8, 0.6, p.z));
  vWarm = smoothstep(-0.2, 0.6, p.x + p.y * 0.5);
}
