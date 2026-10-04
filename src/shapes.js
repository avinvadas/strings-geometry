import * as THREE from 'three/webgpu';
import { mulberry32 } from './geometry.js';

// ---------------------------------------------------------------------------------------------
// One structure rule for every shape (the "icosphere cells" rule):
//   1. the shape's surface is tiled into cells (hexagons, plus 12 pentagons on a sphere);
//   2. a mask decides where the shape is (a helical band, a lattice of arcs, everything...);
//   3. each cell inside the mask is shown or hidden as a whole (seeded random, `coverage`);
//   4. a shown cell is one rounded polygon, shaded as a single cell (see material.js);
//   5. cell centres are the anchors that strings depart from / arrive at.
// A shape is therefore just: a tiling (surface), a mask and an "opposite" rule.
// ---------------------------------------------------------------------------------------------

const FAN = 3, INSET = 0.985, ROUND = 0.12, ARC = 4;     // fan subdivision, hairline gap, corner radius, arc smoothness
const R_SPHERE = 1.15, R_CYL = 1, H_CYL = 3.2, COLS = 28;

// ---- tilings --------------------------------------------------------------------------------
function icoTopology(detail) {
  const ico = new THREE.IcosahedronGeometry(1, detail), pos = ico.attributes.position;
  const ids = new Map(), verts = [], faces = [], v = new THREE.Vector3();
  const id = (vec) => {
    const k = `${Math.round(vec.x * 1e4)},${Math.round(vec.y * 1e4)},${Math.round(vec.z * 1e4)}`;
    if (!ids.has(k)) { ids.set(k, verts.length); verts.push(vec.clone().normalize()); }
    return ids.get(k);
  };
  for (let i = 0; i < pos.count; i += 3) faces.push([0, 1, 2].map((j) => id(v.fromBufferAttribute(pos, i + j))));
  return { verts, faces };
}

// Sphere: every icosphere vertex owns a cell whose corners are the centres of the faces around it.
function sphereSurface(detail, R = R_SPHERE) {
  const { verts, faces } = icoTopology(detail);
  const around = verts.map(() => []);
  const centroid = faces.map((f, fi) => { f.forEach((vi) => around[vi].push(fi)); return verts[f[0]].clone().add(verts[f[1]]).add(verts[f[2]]).normalize(); });
  return {
    cells: verts.map((c, vi) => ({ c, ring: around[vi].map((fi) => centroid[fi]) })),
    project: (v) => { const n = v.clone().normalize(); return { p: n.clone().multiplyScalar(R), n }; },
  };
}

// Cylinder: a honeycomb wrapped around it (COLS cells per ring, pointy-top hexagons).
function cylinderSurface(R = R_CYL, height = H_CYL, columns = COLS) {
  const dx = (2 * Math.PI * R) / columns, rh = dx / Math.sqrt(3), dy = 1.5 * rh;
  const at = (s, y) => new THREE.Vector3(Math.cos(s / R) * R, y, Math.sin(s / R) * R);
  const cells = [], rows = Math.ceil(height / dy) + 1;
  for (let j = 0; j < rows; j++) for (let i = 0; i < columns; i++) {
    const s = (i + 0.5 * (j & 1)) * dx, y = -height / 2 + j * dy;
    cells.push({ c: at(s, y), ring: [0, 1, 2, 3, 4, 5].map((k) => { const a = Math.PI / 2 + (k * Math.PI) / 3; return at(s + rh * Math.cos(a), y + rh * Math.sin(a)); }) });
  }
  return {
    cells,
    project: (v) => { const n = new THREE.Vector3(v.x, 0, v.z).normalize(); return { p: new THREE.Vector3(n.x * R, v.y, n.z * R), n }; },
  };
}

// ---- masks ----------------------------------------------------------------------------------
const azimuth = (c) => (Math.atan2(c.z, c.x) + 2 * Math.PI) % (2 * Math.PI);

// helical band round the cylinder: `turns` turns, `width` = share of the pitch covered
function helixMask(P) {
  const pitch = H_CYL / P.complexity;
  return (c) => {
    const t0 = azimuth(c) / (2 * Math.PI) / P.complexity;
    let d = Infinity;
    for (let k = 0; k < P.complexity; k++) d = Math.min(d, Math.abs(c.y - ((t0 + k / P.complexity - 0.5) * H_CYL)));
    return d < (P.width * pitch) / 2;
  };
}

// a strip winding pole to pole over the sphere
function spiralMask(P) {
  const m = 0.12, span = Math.PI - 2 * m;
  return (c) => {
    const phi = Math.acos(THREE.MathUtils.clamp(c.y / c.length(), -1, 1));
    if (phi < m || phi > Math.PI - m) return false;
    const t0 = azimuth(c) / (2 * Math.PI) / P.complexity;
    let d = Infinity;
    for (let k = 0; k < P.complexity; k++) d = Math.min(d, Math.abs(phi - (m + (t0 + k / P.complexity) * span)));
    return d < (P.width * (span / P.complexity)) / 2;
  };
}

// angular distance from unit vector p to the arc a-b
function arcDistance(p, a, b, nrm, arcLen) {
  const off = p.dot(nrm), q = p.clone().addScaledVector(nrm, -off);
  if (q.lengthSq() > 1e-9) {
    q.normalize();
    if (Math.abs(a.angleTo(q) + q.angleTo(b) - arcLen) < 1e-4) return Math.asin(THREE.MathUtils.clamp(Math.abs(off), 0, 1));
  }
  return Math.min(p.angleTo(a), p.angleTo(b));
}

// lattice: the edges of a geodesic sphere, `width` scales how thick they are
function latticeMask(P) {
  const { verts, faces } = icoTopology(P.complexity);
  const seen = new Set(), arcs = [];
  for (const f of faces) for (let k = 0; k < 3; k++) {
    const i = f[k], j = f[(k + 1) % 3], key = Math.min(i, j) + '_' + Math.max(i, j);
    if (seen.has(key)) continue; seen.add(key);
    const a = verts[i], b = verts[j];
    arcs.push({ a, b, nrm: new THREE.Vector3().crossVectors(a, b).normalize(), len: a.angleTo(b) });
  }
  return (c) => {
    const p = c.clone().normalize();
    for (const e of arcs) if (arcDistance(p, e.a, e.b, e.nrm, e.len) < P.width * 0.25) return true;
    return false;
  };
}

// ---- the one builder ---------------------------------------------------------------------------
// surface: { cells:[{c, ring}], project(v)->{p,n} }   mask(c)->bool   opposite(p)->Vector3
function buildCellShape(P, surface, mask, opposite) {
  const rand = mulberry32(P.faceSeed), { cells, project } = surface;
  const pos = [], nrm = [], uv = [], cell = [], dirs = [], idx = [], shown = new Set(), ranges = new Map();

  cells.forEach((cellDef, ci) => {
    const roll = rand(), id = rand();                        // always consume, so a seed stays stable
    if (!mask(cellDef.c) || roll > P.coverage) return;
    shown.add(ci);
    const start = pos.length / 3, A = cellDef.c, centre = project(A), n = centre.n;

    // tangent basis at the centre, ring sorted counter-clockwise (seen from outside)
    let e1 = new THREE.Vector3().crossVectors(n, Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
    let e2 = new THREE.Vector3().crossVectors(n, e1);
    const ring = cellDef.ring.slice().sort((p, q) => {
      const dp = p.clone().sub(A), dq = q.clone().sub(A);
      return Math.atan2(dp.dot(e2), dp.dot(e1)) - Math.atan2(dq.dot(e2), dq.dot(e1));
    });
    // re-aim the basis at the middle of the first edge, so edge middles sit at k * (2*PI / sides)
    // in the shader (the veins run to them)
    const mid = ring[0].clone().add(ring[1]).multiplyScalar(0.5).sub(A);
    e1 = mid.addScaledVector(n, -mid.dot(n)).normalize();
    e2 = new THREE.Vector3().crossVectors(n, e1);

    // rounded outline: each corner becomes a short quadratic arc
    const outline = [];
    for (let k = 0; k < ring.length; k++) {
      const prev = ring[(k + ring.length - 1) % ring.length], cur = ring[k], next = ring[(k + 1) % ring.length];
      const pin = cur.clone().lerp(prev, ROUND), pout = cur.clone().lerp(next, ROUND);
      for (let s = 0; s <= ARC; s++) {
        const t = s / ARC;
        outline.push(pin.clone().multiplyScalar((1 - t) * (1 - t)).addScaledVector(cur, 2 * t * (1 - t)).addScaledVector(pout, t * t));
      }
    }
    const dirOf = (p) => { const d = p.clone().sub(A), x = d.dot(e1), y = d.dot(e2), l = Math.hypot(x, y) || 1; return [x / l, y / l]; };

    for (let k = 0; k < outline.length; k++) {               // fan: centre, outline k, outline k+1
      const B = outline[k], C = outline[(k + 1) % outline.length], dB = dirOf(B), dC = dirOf(C);
      const base = pos.length / 3, rows = [];
      let cnt = 0;
      for (let i = 0; i <= FAN; i++) {
        rows.push(cnt);
        for (let j = 0; j <= FAN - i; j++, cnt++) {
          const u = i / FAN, w = j / FAN, ui = u * INSET, wi = w * INSET;     // INSET leaves a hairline between cells
          const q = project(A.clone().multiplyScalar(1 - ui - wi).addScaledVector(B, ui).addScaledVector(C, wi));
          pos.push(q.p.x, q.p.y, q.p.z); nrm.push(q.n.x, q.n.y, q.n.z);
          uv.push(u + ci * 0.37, w); cell.push(u + w, id, 0);
          dirs.push(u * dB[0] + w * dC[0], u * dB[1] + w * dC[1], ring.length);   // direction from the centre + number of sides
        }
      }
      for (let i = 0; i < FAN; i++) for (let j = 0; j < FAN - i; j++) {
        const a = base + rows[i] + j, b = base + rows[i + 1] + j;
        idx.push(a, b, a + 1);
        if (j < FAN - i - 1) idx.push(a + 1, b, b + 1);
      }
    }
    ranges.set(ci, [start, pos.length / 3 - start]);
  });

  const body = new THREE.BufferGeometry();
  body.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  body.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  body.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  body.setAttribute('aCell', new THREE.Float32BufferAttribute(cell, 3));   // (distance from centre, id, sends strings)
  body.setAttribute('aDir', new THREE.Float32BufferAttribute(dirs, 3));    // (direction from the centre, number of sides)
  body.userData.cellRanges = ranges;
  body.setIndex(idx);

  const anchors = [];
  cells.forEach((cellDef, ci) => {
    if (P.fabricOnly && !shown.has(ci)) return;
    const p = project(cellDef.c).p;
    anchors.push({ p, opp: opposite(p), cell: ci });
  });
  return { body, anchors };
}

// ---- the shapes ---------------------------------------------------------------------------------
const antipode = (p) => p.clone().negate();

export const SHAPES = {
  'Cylindrical helix': {
    subdivision: { label: 'Subdivision (cells around)', min: 12, max: 56, step: 2, value: 28 },
    complexity: { label: 'Turns', min: 2, max: 8, value: 4 },
    usesWidth: true, defaultWidth: 0.5, defaultCoverage: 0.85, departChance: 0.4,
    // facing point: across the cylinder, half a turn further along the helix
    build: (P) => buildCellShape(P, cylinderSurface(R_CYL, H_CYL, P.subdivision), helixMask(P), (p) => new THREE.Vector3(-p.x, p.y + H_CYL / P.complexity / 2, -p.z)),
  },
  'Spiral sphere': {
    subdivision: { label: 'Subdivision', min: 1, max: 4, step: 1, value: 3 },
    complexity: { label: 'Turns', min: 3, max: 12, value: 6 },
    usesWidth: true, defaultWidth: 0.45, defaultCoverage: 0.85, departChance: 0.2,
    build: (P) => buildCellShape(P, sphereSurface(P.subdivision), spiralMask(P), antipode),
  },
  'Icosphere lattice': {
    subdivision: { label: 'Subdivision', min: 1, max: 4, step: 1, value: 3 },
    complexity: { label: 'Lattice density', min: 0, max: 1, step: 1, value: 0 },
    usesWidth: true, defaultWidth: 0.22, defaultCoverage: 0.9, departChance: 0.3,
    build: (P) => buildCellShape(P, sphereSurface(P.subdivision), latticeMask(P), antipode),
  },
  'Icosphere cells': {
    subdivision: { label: 'Subdivision', min: 0, max: 4, step: 1, value: 2 },
    complexity: null,                                   // nothing to tune besides the subdivision
    usesWidth: false, defaultWidth: 1, defaultCoverage: 0.55, departChance: 0.6,
    build: (P) => buildCellShape(P, sphereSurface(P.subdivision), () => true, antipode),
  },
};

// Make triangle winding (and normals) point away from the origin, so FrontSide = the
// side facing outward. The renderer draws far-side surfaces, then strings, then near-side.
export function orientOutward(body) {
  const pos = body.attributes.position, idx = body.index; if (!idx) return body;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  let sum = 0;
  for (let i = 0; i < idx.count; i += 3) {
    a.fromBufferAttribute(pos, idx.getX(i)); b.fromBufferAttribute(pos, idx.getX(i + 1)); c.fromBufferAttribute(pos, idx.getX(i + 2));
    n.crossVectors(b.clone().sub(a), c.clone().sub(a));
    sum += n.dot(a.add(b).add(c));
  }
  if (sum < 0) {
    for (let i = 0; i < idx.count; i += 3) { const t = idx.getY(i); idx.setY(i, idx.getZ(i)); idx.setZ(i, t); }
    const nr = body.attributes.normal;
    if (nr) { for (let i = 0; i < nr.array.length; i++) nr.array[i] = -nr.array[i]; nr.needsUpdate = true; }
    idx.needsUpdate = true;
  }
  return body;
}
