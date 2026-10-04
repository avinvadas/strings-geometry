import * as THREE from 'three/webgpu';

// A small studio, built from nothing: a dim gradient dome plus a few coloured soft-boxes at very
// different brightness and positions. Prefiltered (PMREM) it becomes image-based lighting, so
// each cell catches a different amount and colour of light depending on which way it faces.
const PANELS = {
  light: {
    top: 0xffffff, topK: 0.9, bottom: 0xb9b2a6, bottomK: 0.35,
    boxes: [   // [colour, brightness, position, width, height]
      [0xfff0d8, 7.0, [4.5, 4.0, 3.0], 5, 3],        // warm key, upper right front
      [0xbcd6ff, 3.0, [-5.0, 1.5, 1.0], 3, 6],       // cool fill, left
      [0xffffff, 6.0, [0.5, -1.5, -5.0], 6, 1.2],    // thin rim strip behind, low
      [0xffe3f0, 2.0, [-2.5, 4.5, -3.5], 4, 2],      // faint pink top back
    ],
  },
  dark: {
    top: 0x0b1626, topK: 0.5, bottom: 0x02050a, bottomK: 0.4,
    boxes: [
      [0x39e6d4, 4.5, [-5.0, -1.0, 2.5], 3, 5],      // teal, low left
      [0xb865ff, 4.0, [4.5, 3.5, 1.0], 4, 3],        // violet, upper right
      [0xcfe4ff, 6.5, [0.0, 4.5, -4.5], 7, 1.0],     // cold white strip, top back
      [0xff6fa8, 2.2, [3.5, -3.0, 4.0], 3, 2],       // pink accent, lower right front
    ],
  },
};

export function makeEnvironment(pmrem, theme) {
  const cfg = PANELS[theme], scene = new THREE.Scene();

  // gradient dome (vertex colours from `bottom` to `top`)
  const dome = new THREE.SphereGeometry(20, 32, 16), colours = [], top = new THREE.Color(cfg.top).multiplyScalar(cfg.topK), bottom = new THREE.Color(cfg.bottom).multiplyScalar(cfg.bottomK);
  const pos = dome.attributes.position;
  for (let i = 0; i < pos.count; i++) { const c = bottom.clone().lerp(top, (pos.getY(i) / 20) * 0.5 + 0.5); colours.push(c.r, c.g, c.b); }
  dome.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  scene.add(new THREE.Mesh(dome, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));

  // soft-boxes: HDR-bright planes aimed at the centre
  for (const [hex, k, p, w, h] of cfg.boxes) {
    const box = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k), side: THREE.DoubleSide }));
    box.position.set(...p); box.lookAt(0, 0, 0); scene.add(box);
  }
  return pmrem.fromScene(scene, 0.03);
}
