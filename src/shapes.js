import * as THREE from 'three/webgpu';
import { mulberry32 } from './geometry.js';

// A shape turns { complexity, width } into:
//   body:    BufferGeometry (the fabric)
//   anchors: [{ p, opp }]  departure points on the fabric, and the point that
//            "faces" each one across the centre (strings go to anchors near opp)
// To add a shape: write a build(P) and register it in SHAPES below.

const PER_TURN = 12;                 // strip anchors per revolution (even)
const ROWS = [-0.7, 0, 0.7];         // strip anchors across the width (-1..1)

// ---- generic helical strip ---------------------------------------------------
// point(P, t, s, target): t 0..1 along the strip, s -1..1 across it.
function buildStrip(P, point, opposite, { steps = 480, across = 24 } = {}) {
  const pos = [], uv = [], idx = [], p = new THREE.Vector3();
  for (let i = 0; i <= steps; i++) for (let j = 0; j <= across; j++) {
    point(P, i / steps, (j / across) * 2 - 1, p);
    pos.push(p.x, p.y, p.z); uv.push(i / steps, j / across);
  }
  const row = across + 1;
  for (let i = 0; i < steps; i++) for (let j = 0; j < across; j++) {
    const a = i * row + j, b = a + row;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const body = new THREE.BufferGeometry();
  body.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  body.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  body.setIndex(idx); body.computeVertexNormals();

  const anchors = [], n = P.complexity * PER_TURN;
  for (let k = 0; k < n; k++) for (const s of ROWS) {
    const t = (k + 0.5) / n, a = point(P, t, s, new THREE.Vector3());
    anchors.push({ p: a, opp: opposite(P, t, s, a) });
  }
  return { body, anchors };
}

const taper = (t) => Math.sin(Math.PI * t) ** 0.4;     // strip narrows to a point at both ends

// ---- 1. cylindrical helix ---------------------------------------------------
const H = { radius: 1, height: 3.2, ripple: 0.05 };
function helixPoint(P, t, s, target) {
  const a = t * P.complexity * Math.PI * 2, edge = Math.abs(s);
  const halfWidth = (H.height / P.complexity) * P.width / 2;
  const r = H.radius * (1 + H.ripple * edge * edge * Math.sin(a * 3 + s * 2.5));
  const y = (t - 0.5) * H.height + s * halfWidth * taper(t) + 0.015 * edge * Math.sin(a * 2 + 1.3);
  return target.set(Math.cos(a) * r, y, Math.sin(a) * r);
}
const helixOpposite = (P, t, s, _p) => {
  const t2 = t + 0.5 / P.complexity;                   // half a turn further = other side
  return t2 > 0.97 ? null : helixPoint(P, t2, s, new THREE.Vector3());
};

// ---- 2. spiral sphere: a strip winding pole to pole over a sphere -----------
const S = { radius: 1.2, margin: 0.12, ripple: 0.05 };
function spherePoint(P, t, s, target) {
  const span = Math.PI - 2 * S.margin, edge = Math.abs(s);
  const halfWidth = (span / P.complexity) * P.width / 2;      // angular half-width
  const a = t * P.complexity * Math.PI * 2;
  const phi = S.margin + t * span + s * halfWidth * taper(t);
  const r = S.radius * (1 + S.ripple * edge * edge * Math.sin(a * 3 + s * 2.5));
  return target.set(Math.sin(phi) * Math.cos(a) * r, Math.cos(phi) * r, Math.sin(phi) * Math.sin(a) * r);
}
const pointOpposite = (_P, _t, _s, p) => p.clone().negate();

// ---- icosphere topology (shared by the lattice and the faces shapes) ----------
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

// ---- 4. icosphere cells: hexagons (pentagons at the 12 poles) --------------------
// Every icosphere vertex owns the cell formed by the faces around it: corners are
// the centroids of those faces, so the cells tile the sphere exactly. Each cell is
// shown or hidden as a whole. aCell = (distance from cell centre 0..1, random id).
function buildCells(P) {
  const R = 1.15, N = 3, INSET = 0.985, ROUND = 0.12, ARC = 4, { verts, faces } = icoTopology(P.complexity), rand = mulberry32(P.faceSeed);
  const around = verts.map(() => []);
  faces.forEach((f, fi) => f.forEach((v) => around[v].push(fi)));
  const centroid = faces.map((f) => verts[f[0]].clone().add(verts[f[1]]).add(verts[f[2]]).normalize());

  const pos = [], nrm = [], uv = [], cell = [], dirs = [], idx = [], shown = new Set(), ranges = new Map();
  verts.forEach((c, vi) => {
    const visible = rand() <= P.width, id = rand();           // always consume, so seeds stay stable
    if (!visible) return;
    shown.add(vi);
    const start = pos.length / 3;
    const e1 = new THREE.Vector3().crossVectors(c, Math.abs(c.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
    const e2 = new THREE.Vector3().crossVectors(c, e1);
    const ring = around[vi].map((fi) => centroid[fi])
      .sort((p, q) => Math.atan2(p.dot(e2), p.dot(e1)) - Math.atan2(q.dot(e2), q.dot(e1)));
    // Re-aim the basis at the middle of the first edge, so edge middles sit at k * (2*PI / sides)
    // in the shader (the veins run to them).
    const mid = ring[0].clone().add(ring[1]).normalize();
    e1.copy(mid.sub(c.clone().multiplyScalar(mid.dot(c)))).normalize();
    e2.crossVectors(c, e1);
    // Rounded outline: each corner is replaced by a quadratic arc (ROUND = share of the
    // adjacent edges that gets rounded off), then the cell is a fan from its centre.
    const outline = [];
    for (let k = 0; k < ring.length; k++) {
      const prev = ring[(k + ring.length - 1) % ring.length], cur = ring[k], next = ring[(k + 1) % ring.length];
      const pin = cur.clone().lerp(prev, ROUND), pout = cur.clone().lerp(next, ROUND);
      for (let s = 0; s <= ARC; s++) {
        const t = s / ARC, a = (1 - t) * (1 - t), b = 2 * t * (1 - t), c2 = t * t;
        outline.push(pin.clone().multiplyScalar(a).addScaledVector(cur, b).addScaledVector(pout, c2).normalize());
      }
    }
    const dirOf = (p) => { const x = p.dot(e1), y = p.dot(e2), l = Math.hypot(x, y) || 1; return [x / l, y / l]; };
    for (let k = 0; k < outline.length; k++) {                 // fan: centre, outline k, outline k+1
      const A = c, B = outline[k], C = outline[(k + 1) % outline.length], dB = dirOf(B), dC = dirOf(C);
      const base = pos.length / 3, rows = [];
      let n = 0;
      for (let i = 0; i <= N; i++) {
        rows.push(n);
        for (let j = 0; j <= N - i; j++, n++) {
          const u = i / N, w = j / N, ui = u * INSET, wi = w * INSET;   // INSET leaves a hairline between cells
          const p = A.clone().multiplyScalar(1 - ui - wi).addScaledVector(B, ui).addScaledVector(C, wi).normalize();
          pos.push(p.x * R, p.y * R, p.z * R); nrm.push(p.x, p.y, p.z);
          uv.push(u + vi * 0.37, w); cell.push(u + w, id, 0);
          dirs.push(u * dB[0] + w * dC[0], u * dB[1] + w * dC[1], ring.length);     // direction from the centre; atan2 of it gives the angle
        }
      }
      for (let i = 0; i < N; i++) for (let j = 0; j < N - i; j++) {
        const a = base + rows[i] + j, b = base + rows[i + 1] + j;
        idx.push(a, b, a + 1);
        if (j < N - i - 1) idx.push(a + 1, b, b + 1);
      }
    }
    ranges.set(vi, [start, pos.length / 3 - start]);
  });
  const body = new THREE.BufferGeometry();
  body.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  body.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  body.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  body.setAttribute('aCell', new THREE.Float32BufferAttribute(cell, 3));   // (distance from centre, id, sends strings)
  body.setAttribute('aDir', new THREE.Float32BufferAttribute(dirs, 3));    // (direction from the centre, number of sides)
  body.userData.cellRanges = ranges;
  body.setIndex(idx);
  const anchors = verts.map((d, i) => ({ d, i })).filter(({ i }) => !P.fabricOnly || shown.has(i))
    .map(({ d, i }) => { const p = d.clone().multiplyScalar(R); return { p, opp: p.clone().negate(), cell: i }; });
  return { body, anchors };
}

// ---- 3. icosphere lattice: ribbons along the edges of a geodesic sphere -----
function buildLattice(P) {
  const R = 1.15, ico = new THREE.IcosahedronGeometry(1, P.complexity), pos = ico.attributes.position;
  const verts = new Map(), list = [], edges = new Map(), v = new THREE.Vector3();
  const id = (vec) => {
    const k = `${Math.round(vec.x * 1e4)},${Math.round(vec.y * 1e4)},${Math.round(vec.z * 1e4)}`;
    if (!verts.has(k)) { verts.set(k, list.length); list.push(vec.clone().normalize()); }
    return verts.get(k);
  };
  for (let i = 0; i < pos.count; i += 3) {
    const f = [0, 1, 2].map((j) => id(v.fromBufferAttribute(pos, i + j)));
    for (const [x, y] of [[f[0], f[1]], [f[1], f[2]], [f[2], f[0]]]) edges.set(Math.min(x, y) + '_' + Math.max(x, y), [Math.min(x, y), Math.max(x, y)]);
  }
  const P3 = [], UV = [], IDX = [], SEG = 8, ACR = 4;
  let e = 0;
  for (const [ia, ib] of edges.values()) {
    const a = list[ia], b = list[ib], hw = a.angleTo(b) * P.width * 0.35, base0 = P3.length / 3;
    for (let i = 0; i <= SEG; i++) {
      const u = i / SEG, base = a.clone().lerp(b, u).normalize();
      const tan = b.clone().sub(a).sub(base.clone().multiplyScalar(b.clone().sub(a).dot(base))).normalize();
      const side = new THREE.Vector3().crossVectors(base, tan);
      const w = hw * (0.45 + 0.55 * Math.sin(Math.PI * u));
      for (let j = 0; j <= ACR; j++) {
        const s = (j / ACR) * 2 - 1, q = base.clone().addScaledVector(side, s * w).normalize().multiplyScalar(R);
        P3.push(q.x, q.y, q.z); UV.push(u + e * 0.37, j / ACR);
      }
    }
    for (let i = 0; i < SEG; i++) for (let j = 0; j < ACR; j++) {
      const p = base0 + i * (ACR + 1) + j, q = p + ACR + 1;
      IDX.push(p, q, p + 1, q, q + 1, p + 1);
    }
    e++;
  }
  const body = new THREE.BufferGeometry();
  body.setAttribute('position', new THREE.Float32BufferAttribute(P3, 3));
  body.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  body.setIndex(IDX); body.computeVertexNormals();
  const anchors = list.map((d) => { const p = d.clone().multiplyScalar(R); return { p, opp: p.clone().negate() }; });
  return { body, anchors };
}

export const SHAPES = {
  'Cylindrical helix': {
    complexity: { label: 'Turns', min: 2, max: 8, value: 4 },
    departChance: 0.4,
    build: (P) => buildStrip(P, helixPoint, helixOpposite),
  },
  'Spiral sphere': {
    complexity: { label: 'Turns', min: 3, max: 12, value: 6 },
    departChance: 0.15,
    build: (P) => buildStrip(P, spherePoint, pointOpposite, { steps: 700 }),
  },
  'Icosphere cells': {
    complexity: { label: 'Subdivision', min: 0, max: 3, value: 2 },
    departChance: 0.6,
    defaultWidth: 0.55,
    cells: true,                       // shade each cell individually (see material.js)
    build: buildCells,
  },
  'Icosphere lattice': {
    complexity: { label: 'Subdivision', min: 0, max: 3, value: 1 },
    departChance: 0.5,
    build: buildLattice,
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
