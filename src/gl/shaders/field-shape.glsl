const float TAU = 6.28318530718;

// Flow on a sphere: the polar bands twist into one another without a noisy silhouette.
vec3 sphereFlow(float t, float seed) {
  float u = t * TAU;
  float latitude = (seed - 0.5) * 3.04;
  latitude += 0.23 * sin(u * 3.0 + seed * 9.0 + uTime * 0.09) * sin(seed * 3.14159);
  float radius = 0.91 + 0.075 * sin(u * 3.0 + seed * 7.0) * sin(seed * 3.14159);
  float azimuth = u + latitude * 2.4 + 0.14 * sin(u * 2.0 - uTime * 0.08);
  return radius * vec3(cos(latitude) * cos(azimuth), sin(latitude), cos(latitude) * sin(azimuth));
}

vec3 flowPoint(float t, float seed) {
  vec3 orb = sphereFlow(t, seed);
  float u = t * TAU;
  float phase = seed * TAU;
  // One connected topography: nested closed contours, never a cluster of small spheres.
  float r = 0.035 + seed * 0.98;
  float ridge = 1.0 + 0.12 * sin(u * 3.0 + r * 4.0 + uTime * 0.06) + 0.065 * cos(u * 5.0 - r * 3.0);
  float a = u + r * 0.35;
  vec3 atlas = vec3(cos(a) * r * ridge, sin(a) * r * ridge * 1.02, 0.0);
  atlas.x += 0.12 * sin(r * 4.5);
  atlas.z = 0.52 * exp(-r * r * 2.8) + 0.17 * sin(u * 2.0 + r * 6.0) * r + 0.08 * cos(u * 3.0 + uTime * 0.1) * r;
  float map = smoothstep(3.0, 4.0, uState) * (1.0 - smoothstep(4.0, 5.0, uState));
  vec3 p = mix(orb, atlas, map);
  float breath = 1.0 + 0.018 * sin(uTime * 0.55);
  p *= breath;
  // Local, elastic response follows the pointer; no random shake or flashing.
  vec2 delta = p.xy - uPointer;
  float influence = exp(-dot(delta, delta) * 3.2) * uHover;
  p.xy += delta * influence * 0.13;
  p.z += influence * sin(length(delta) * 9.0 - uTime * 1.4) * 0.06;
  return p;
}
