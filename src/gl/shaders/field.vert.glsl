uniform float uTime;
uniform float uState;
uniform float uHover;
uniform vec2 uPointer;
uniform float uStroke;
attribute vec3 aFlow;
attribute float aSide;
varying float vEdge;
varying float vAlong;
varying float vSeed;
varying float vDepth;
varying vec3 vLocal;
#include <field_shape>
void main() {
  vec3 p = flowPoint(aFlow.x, aFlow.y);
  vec3 next = flowPoint(aFlow.x + 0.0005, aFlow.y);
#ifdef ORBIT
  float angle = aFlow.x * TAU;
  float orbit = aFlow.y * TAU;
  p = vec3(cos(angle) * 1.18, sin(angle) * 0.48, sin(angle) * 0.98);
  next = vec3(cos(angle + 0.001) * 1.18, sin(angle + 0.001) * 0.48, sin(angle + 0.001) * 0.98);
  mat2 turn = mat2(cos(orbit), -sin(orbit), sin(orbit), cos(orbit));
  p.xy = turn * p.xy;
  next.xy = turn * next.xy;
#endif
  vec4 view = modelViewMatrix * vec4(p, 1.0);
  vec4 viewNext = modelViewMatrix * vec4(next, 1.0);
  vec2 tangent = normalize(viewNext.xy - view.xy + vec2(0.00001));
  vec2 normal = vec2(-tangent.y, tangent.x);
  view.xy += normal * aSide * uStroke * (0.7 + 0.5 * aFlow.z);
  gl_Position = projectionMatrix * view;
  vEdge = aSide;
  vAlong = aFlow.x;
  vSeed = aFlow.y;
  vDepth = clamp(0.52 + p.z * 0.45, 0.0, 1.0);
  vLocal = p;
}
