// Glass shell around the light (hero, the kept themes, final).
varying vec3 vNormal;
varying vec3 vView;
varying vec3 vObject;

void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vNormal = normalize(normalMatrix * normal);
  vView = normalize(-mvPosition.xyz);
  vObject = position;
  gl_Position = projectionMatrix * mvPosition;
}
