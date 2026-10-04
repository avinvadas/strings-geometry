import * as THREE from 'three/webgpu';
import { vec2, vec3, vec4, float, color, uniform, time, screenUV, screenCoordinate, mix, length, smoothstep, dot, sin, fract,
         mx_fractal_noise_float } from 'three/tsl';

// Every number and colour below is a uniform, so the control panel can change it live.
// Colours are given as sRGB hex strings (what a colour picker shows).
export const BG_DEFAULTS = {
  // bright
  gradient: 1, lift: 0.35, vignette: 0.05,
  // grain sits on top of the final image, in display (sRGB) units
  grainBright: 0.035, grainDark: 0.02,
  brightA: '#f6f4ee', brightB: '#e0ddd2',
  // dark
  blue: 0.42, teal: 0.34, violet: 0.22, frost: 0.06, drift: 1,
  darkBase: '#050b15', darkBlue: '#16385c', darkTeal: '#0f4650', darkViolet: '#2a1f55', darkFrost: '#4d6f96',
};
const isColour = (v) => typeof v === 'string';
export const U = Object.fromEntries(Object.entries(BG_DEFAULTS).map(([k, v]) =>
  [k, uniform(isColour(v) ? new THREE.Color(v) : v)]));
export const setBackgroundParam = (key, value) => { isColour(BG_DEFAULTS[key]) ? U[key].value.set(value) : (U[key].value = value); };

// Per-pixel white noise in [-0.5, 0.5]. A sine-free hash (Hoskins): the usual fract(sin(dot())) form
// loses precision at large pixel coordinates and leaves faint stripes.
const grain = () => {
  const p = screenCoordinate.xy.floor();
  const p3 = fract(vec3(p.x, p.y, p.x).mul(0.1031));
  const q = p3.add(dot(p3, p3.yzx.add(33.33)));
  return fract(q.x.add(q.y).mul(q.z)).sub(0.5);
};
const blob = (centre, radius) => smoothstep(radius, 0.0, length(screenUV.sub(centre)));

// Bright: a barely-there diagonal + radial gradient around #EDEBE4, with a vignette.
function bright() {
  const diagonal = screenUV.x.mul(0.35).add(screenUV.y.mul(0.65));
  const graded = mix(U.brightA, U.brightB, diagonal);
  const base = mix(color(0xedebe4), graded, U.gradient);                       // gradient strength
  const lit = mix(base, color(0xf7f5f0), blob(vec2(0.5, 0.45), 0.75).mul(U.lift));      // lift behind the subject
  const vig = smoothstep(0.35, 0.95, length(screenUV.sub(0.5)).mul(1.3)).mul(U.vignette);
  return lit.mul(float(1).sub(vig));
}

// Dark: frosted, blurred colour fields drifting slowly, a soft cloudy frost 
function dark() {
  const t = time.mul(0.03).mul(U.drift);
  const drift = (a, b) => vec2(a, b).add(vec2(sin(t.add(a * 9.0)), sin(t.mul(0.8).add(b * 7.0))).mul(0.04));
  let c = U.darkBase;
  c = c.add(U.darkBlue.mul(blob(drift(0.2, 0.2), 0.75)).mul(U.blue));          // upper left
  c = c.add(U.darkTeal.mul(blob(drift(0.82, 0.78), 0.8)).mul(U.teal));         // lower right
  c = c.add(U.darkViolet.mul(blob(drift(0.75, 0.15), 0.6)).mul(U.violet));     // upper right
  const f = mx_fractal_noise_float(vec3(screenUV.mul(vec2(3.0, 2.2)), t), 3).mul(0.5).add(0.5);
  c = c.add(U.darkFrost.mul(f.mul(f)).mul(U.frost));
  return c;
}

// Film grain over the whole rendered image (scene included). `node` must already be in display colour space.
export const withGrain = (node, theme) => {
  const g = grain().mul(theme === 'light' ? U.grainBright : U.grainDark);
  return node.add(vec4(g, g, g, 0));
};

export const makeBackground = (theme) => (theme === 'light' ? bright() : dark());
