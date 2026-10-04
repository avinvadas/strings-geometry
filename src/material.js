import * as THREE from 'three/webgpu';
import { Fn, vec3, float, color, time, uv, attribute, positionLocal, normalLocal, normalView,
         positionViewDirection, bumpMap, viewportMipTexture, screenUV, mx_noise_float, length, atan, floor, fract, mx_worley_noise_vec2, mx_fractal_noise_float, mx_fractal_noise_vec3,
         mix, uniform, pow, abs, sin, cos, dot, saturate, smoothstep } from 'three/tsl';

export const INK = 0x1f3040;   // light-mode material colour
export const uniforms = { density: uniform(8), cellMode: uniform(0), inkStrength: uniform(0.55) };   // density: cells per unit; cellMode 1: one cell per hexagon; inkStrength: bright-mode string ink

const fresnel = (p) => pow(float(1).sub(saturate(dot(normalView, positionViewDirection))), p);
const hueRamp = (h) => vec3(sin(h.mul(6.283)), sin(h.mul(6.283).add(2.1)), sin(h.mul(6.283).add(4.2))).mul(0.5).add(0.5);

// 1) Jellyfish fabric: cellular (Worley) tissue, lit, with a faked sub-surface glow.
// Cells bulge via bump-mapped normals; membranes between cells are thin and dark,
// nuclei glow softly from within. Low-frequency noise varies tone across the sheet.
// theme 'dark': glowing iridescent tissue.  theme 'light': ink-coloured (#1f3040) tissue.
export function createBodyMaterial(theme = 'dark', side = THREE.FrontSide) {
  const light = theme === 'light';
  const m = new THREE.MeshPhysicalNodeMaterial({
    transparent: true, side, depthWrite: false,
    roughness: 0.42, metalness: 0,
    iridescence: light ? 0.0 : 0.7, iridescenceIOR: 1.4,
    sheen: light ? 0.0 : 0.6, sheenColor: new THREE.Color(light ? 0x6f8ca6 : 0x9fd8ff),
  });

  m.positionNode = Fn(() => {
    const pulse = sin(time.mul(1.4).sub(uv().x.mul(18.0))).mul(0.015).mul(float(1).sub(uniforms.cellMode));   // none on the hex cells: keeps their edges clean
    return positionLocal.add(normalLocal.mul(pulse));
  })();

  // shared cell field (3D, so it never seams along the strip)
  const warp = mx_fractal_noise_vec3(positionLocal.mul(2.0).add(time.mul(0.05)), 2).mul(0.35);
  const cells = mx_worley_noise_vec2(positionLocal.mul(uniforms.density).add(warp), 1.0);
  // per-hexagon mode: aCell = (distance from cell centre 0..1, random id); worley otherwise
  const aCell = attribute('aCell', 'vec3'), hex = uniforms.cellMode;
  // cells that send strings take the strings' colour (ink / bright), fading outward from the centre
  const tintColor = light ? color(INK) : color(0xe8e4ff);
  const tintW = aCell.z.mul(pow(saturate(float(1).sub(aCell.x)), 1.4)).mul(hex);

  // Veins, after an Aurelia bell: one canal per cell side running from the cell centre to the
  // middle of that side. Canals wander organically but
  // keep heading for the edge middle, and fork gently on the way out.
  const aDir = attribute('aDir', 'vec3'), dirN = aDir.xy.div(length(aDir.xy).max(0.0001));
  const rr = aCell.x, cid = aCell.y, TAU = 6.2831853, sides = aDir.z.max(3.0);
  const sector = float(TAU).div(sides);
  const along = smoothstep(0.0, 0.1, rr).mul(smoothstep(1.0, 0.96, rr));                           // canals run from the centre to the rim
  const theta = atan(dirN.y, dirN.x);
  // signed angle to the nearest spoke, turned into a sideways distance from that spoke's axis
  const sideways = fract(theta.div(sector).add(0.5)).sub(0.5).mul(sector).mul(rr).mul(0.19);
  // thick at the centre and at the rim, thin through the middle
  const edgeness = saturate(abs(rr.sub(0.575)).div(0.4));
  const width = mix(0.005, 0.016, edgeness.mul(edgeness));
  // soft (slightly blurred) line profile
  const line = (offset, k) => smoothstep(width.mul(k * 1.9), width.mul(k * 0.1), abs(sideways.sub(offset)));

  // Per-vein randomness: every spoke of every cell gets its own hash, so weight, fork positions,
  // spread and even which branches exist differ from vein to vein.
  const spokeIdx = floor(theta.div(sector).add(0.5)), idxMod = spokeIdx.sub(floor(spokeIdx.div(sides)).mul(sides));
  let counter = 0;
  const rnd = () => fract(sin(idxMod.mul(12.9898).add(cid.mul(78.233)).add(++counter * 37.719)).mul(43758.5453));
  const weight = rnd().mul(0.8).add(0.5);                                                      // main vein weight
  const grow = (from, slope) => saturate(rr.sub(from)).mul(slope);
  // one fork: where it leaves its parent, how far it spreads, how heavy it is, whether it exists at all
  const branch = (parent, from, slope, k, side) => {
    const present = smoothstep(0.18, 0.26, rnd());                                              // some branches are missing
    const start = rnd().mul(0.14).sub(0.07).add(from);
    const spread = rnd().mul(0.9).add(0.55).mul(slope);
    return { off: parent.add(grow(start, spread).mul(side)), w: present.mul(rnd().mul(0.7).add(0.5)).mul(k) };
  };
  const alive = (b) => smoothstep(0.0, 0.2, b.w);                                               // children vanish with their parent

  // Fractal tree: the canal forks, each fork forks again, and again. Branches are straight,
  // keep diverging toward the rim (never rejoin), and each level splits later and spreads less.
  let canal = line(rnd().sub(0.5).mul(0.01), 1.0).mul(weight);
  for (const s1 of [-1, 1]) {
    const b1 = branch(float(0), 0.36, 0.09, 0.8, s1);
    canal = canal.max(line(b1.off, 0.8).mul(b1.w));
    for (const s2 of [-1, 1]) {
      const b2 = branch(b1.off, 0.56, 0.06, 0.6, s2);
      canal = canal.max(line(b2.off, 0.6).mul(b2.w).mul(alive(b1)));
      for (const s3 of [-1, 1]) {
        const b3 = branch(b2.off, 0.74, 0.04, 0.45, s3);
        canal = canal.max(line(b3.off, 0.45).mul(b3.w).mul(alive(b2)).mul(alive(b1)));
      }
    }
  }
  const veins = canal.mul(along).mul(hex);
  // Rim: the same tint also hugs the edge of every cell, fading inward
  const rim = smoothstep(0.72, 1.0, rr).mul(hex);
  // Everything that takes the tint (sender centres, rims, veins); the middle zone is left untouched
  const tintAll = tintW.max(rim).max(veins.mul(0.62));
  const f1 = mix(cells.x, aCell.x.mul(0.75), hex);
  const edge = mix(cells.y.sub(cells.x), float(1).sub(aCell.x).mul(1.2), hex);
  const membrane = smoothstep(0.0, 0.16, edge);                 // 0 on cell borders
  const nucleus = smoothstep(0.6, 0.05, f1);                    // 1 at cell centres
  const cellHeight = membrane.mul(0.55).add(nucleus.mul(0.45));
  const domeHeight = membrane.mul(0.3).add(float(1).sub(aCell.x.mul(aCell.x)).mul(0.7));   // smooth dome: no facets per fan triangle
  const height = mix(cellHeight, domeHeight, hex);
  m.normalNode = bumpMap(height, float(0.5).mul(float(1).sub(tintAll)).mul(mix(float(1), float(0.5), hex)));

  const noiseTone = mx_fractal_noise_float(positionLocal.mul(1.3).add(vec3(0, time.mul(0.04), 0)), 3).mul(0.5).add(0.5);
  const tone = mix(noiseTone, noiseTone.mul(0.45).add(aCell.y.mul(0.55)), hex);   // each hexagon gets its own tone
  let tissue;
  if (light) {
    const deep = color(0x131f2a), ink = color(INK), pale = color(0x4a6a84);
    tissue = mix(mix(deep, ink, smoothstep(0.25, 0.6, tone)), pale, smoothstep(0.55, 0.9, tone).mul(0.8));
  } else {
    const cold = vec3(0.10, 0.28, 0.55), warm = vec3(0.75, 0.30, 0.50), amber = vec3(0.95, 0.62, 0.35);
    tissue = mix(mix(cold, warm, smoothstep(0.25, 0.65, tone)), amber, smoothstep(0.62, 0.9, tone).mul(0.7));
  }

  m.colorNode = Fn(() => {
    const body = mix(tissue.mul(0.6), tissue.mul(1.3), nucleus);          // darker rims, brighter cores
    const base = mix(body.mul(0.6), body, membrane);
    return base.mul(float(1).sub(tintAll));   // membrane lines pull dark; tinted cells are emissive only
  })();

  m.emissiveNode = Fn(() => {
    if (light) {
      const inner = tissue.mul(nucleus).mul(0.18);
      return inner.add(color(0x4a6a84).mul(fresnel(3.0)).mul(0.25)).mul(float(1).sub(tintAll)).add(tintColor.mul(tintAll));
    }
    const inner = tissue.mul(nucleus).mul(0.85);                           // scattered light from cell cores
    const rimGlow = hueRamp(tone.add(time.mul(0.03))).mul(fresnel(3.0)).mul(0.4);
    return inner.add(rimGlow).mul(float(1).sub(tintAll)).add(tintColor.mul(tintAll));
  })();

  // Milky glass: surface colour over a blurred copy of whatever was drawn behind it
  // (strings and background, via the mip-mapped framebuffer), tinted toward milk.
  const opacity = light
    ? float(0.5).add(float(1).sub(membrane).mul(0.2)).sub(nucleus.mul(0.08)).add(fresnel(2.0).mul(0.15))
    : float(0.26).add(nucleus.mul(0.2)).add(float(1).sub(membrane).mul(0.18)).add(fresnel(2.0).mul(0.15));
  const alpha = mix(opacity, float(0.97), tintAll);
  const refract = screenUV.add(normalView.xy.mul(0.015));
  const blurred = viewportMipTexture(refract).level(float(3.5)).rgb;
  const sharp = viewportMipTexture(screenUV).level(float(0.0)).rgb;
  const milk = light ? color(0xf4f2ec) : color(0x1b2b40);
  m.backdropNode = mix(mix(sharp, blurred, 0.5), milk, 0.06);       // mostly blurred, a little sharp left
  m.backdropAlphaNode = float(1).sub(alpha);
  m.opacityNode = float(1);
  return m;
}

// 2) Strings: thin filaments with pulses travelling along them.
// dark: additive hot-white glow.  light: ink-coloured, pulses darken/solidify.
export function createStringMaterial(theme = 'dark') {
  const light = theme === 'light';
  const m = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false,
    // bright: multiply (ink on paper) - each string only tints what is behind it, so a lone string
    // stays faint while crossings and clusters compound into dark. dark: additive glow.
    blending: light ? THREE.MultiplyBlending : THREE.AdditiveBlending,
    premultipliedAlpha: light,
  });
  const along = uv().x, phase = attribute('aPhase');
  const pulse = pow(saturate(sin(along.mul(14.0).sub(time.mul(2.5)).add(phase))), 6.0);
  const ends = smoothstep(0.0, 0.02, along).mul(smoothstep(1.0, 0.98, along));
  // slightly transparent toward the silhouette of the tube
  const facing = saturate(dot(normalView, positionViewDirection));
  const soft = mix(float(0.55), float(1.0), pow(facing, 0.8));
  if (light) {
    m.colorNode = mix(color(INK), color(0x0d1620), pulse);
    // alpha = how strongly this string inks the pixel (result = behind * mix(1, ink, alpha))
    m.opacityNode = uniforms.inkStrength.mul(float(0.8).add(pulse.mul(0.5))).mul(ends).mul(soft);
  } else {
    m.colorNode = Fn(() => {
      const base = mix(vec3(0.25, 0.6, 0.9), vec3(1.0, 0.5, 0.85), phase.div(6.283));
      return base.mul(0.55).add(vec3(1.0, 0.95, 0.9).mul(pulse).mul(0.7));
    })();
    m.opacityNode = ends.mul(soft);
  }
  return m;
}
