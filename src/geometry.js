import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const STRINGS = {
  seed: 7,
  departChance: 0.4,        // chance an anchor sends strings at all
  endpoints: 5,             // strings per departing anchor
  radius: 0.004,            // thickness of the straight part
  flare: 3,                 // extra thickness at the surface (x radius)
  flareLength: 0.07,        // distance over which it blends into the straight string
};

export function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Straight tube from a to b whose radius flares out near both ends (where the
// string meets the fabric) and settles to `radius` after `flareLength`.
function straightString(a, b, { radius, flare, flareLength }, phase, segs = 28, radial = 6) {
  const dir = b.clone().sub(a), len = dir.length(); dir.normalize();
  const side = Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const n1 = new THREE.Vector3().crossVectors(dir, side).normalize();
  const n2 = new THREE.Vector3().crossVectors(dir, n1);
  const pos = [], nrm = [], uv = [], idx = [], c = new THREE.Vector3(), nn = new THREE.Vector3();
  for (let i = 0; i <= segs; i++) {
    const u = 0.5 - 0.5 * Math.cos(Math.PI * i / segs);          // dense near both ends
    const d = Math.min(u, 1 - u) * len;
    const r = radius * (1 + flare * Math.exp(-d / flareLength));
    c.copy(a).addScaledVector(dir, u * len);
    for (let j = 0; j <= radial; j++) {
      const th = (j / radial) * Math.PI * 2;
      nn.copy(n1).multiplyScalar(Math.cos(th)).addScaledVector(n2, Math.sin(th));
      pos.push(c.x + nn.x * r, c.y + nn.y * r, c.z + nn.z * r);
      nrm.push(nn.x, nn.y, nn.z);
      uv.push(u, j / radial);
    }
  }
  const row = radial + 1;
  for (let i = 0; i < segs; i++) for (let j = 0; j < radial; j++) {
    const p = i * row + j, q = p + row;
    idx.push(p, q, p + 1, q, q + 1, p + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aPhase', new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3).fill(phase), 1));
  g.setIndex(idx);
  return g;
}

// Anchors: [{ p, opp }] from a shape. Each anchor rolls (seeded) whether it departs;
// departing anchors pick `endpoints` targets among the anchors nearest to `opp`
// (the point facing it across the centre).
export function createStringsGeometry(anchors, opts = {}) {
  const cfg = { ...STRINGS, ...opts }, rand = mulberry32(cfg.seed), geos = [];
  const departing = new Set();
  const pool = Math.min(Math.max(9, cfg.endpoints * 2), anchors.length - 1);
  for (let ai = 0; ai < anchors.length; ai++) {
    const from = anchors[ai], roll = rand();       // always consume, so a seed stays stable
    if (roll > cfg.departChance || !from.opp) continue;
    const cands = anchors
      .map((q, i) => ({ q, i, d: q.p.distanceToSquared(from.opp) }))
      .filter((c) => c.i !== ai)
      .sort((x, y) => x.d - y.d).slice(0, pool).map((c) => c.q);
    for (let i = cands.length - 1; i > 0; i--) {   // seeded shuffle
      const j = Math.floor(rand() * (i + 1)); [cands[i], cands[j]] = [cands[j], cands[i]];
    }
    if (from.cell !== undefined) departing.add(from.cell);
    for (const to of cands.slice(0, cfg.endpoints)) geos.push(straightString(from.p, to.p, cfg, rand() * 6.283));
  }
  const out = geos.length ? mergeGeometries(geos) : new THREE.BufferGeometry();
  out.userData.departing = departing;                 // cell ids that send strings
  return out;
}
