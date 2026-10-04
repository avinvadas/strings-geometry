import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { pass, renderOutput } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import GUI from 'three/addons/libs/lil-gui.module.min.js';
import { createStringsGeometry, STRINGS } from './geometry.js';
import { SHAPES, orientOutward } from './shapes.js';
import { createBodyMaterial, createStringMaterial, uniforms } from './material.js';
import { THEMES } from './theme.js';
import { makeEnvironment } from './environment.js';
import { makeBackground, withGrain, BG_DEFAULTS, setBackgroundParam } from './background.js';

const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
await renderer.init();

const pmrem = new THREE.PMREMGenerator(renderer);
let envTarget = null;
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x000000, 0.25);

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 0.6, 5);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const hemi = new THREE.HemisphereLight(); scene.add(hemi);
const key = new THREE.DirectionalLight(); key.position.set(2, 3, 2); scene.add(key);
const rimLight = new THREE.DirectionalLight(); rimLight.position.set(-3, 0.5, -2); scene.add(rimLight);

// Far-side surface (back faces) -> strings -> near-side surface (front faces), so strings
// read as inside the shape: blurred by the near glass, in front of the far glass.
const bodyBack = new THREE.Mesh(new THREE.BufferGeometry(), createBodyMaterial('dark', THREE.BackSide));
const body = new THREE.Mesh(new THREE.BufferGeometry(), createBodyMaterial());
const strings = new THREE.Mesh(new THREE.BufferGeometry(), createStringMaterial());
bodyBack.renderOrder = 0; strings.renderOrder = 1; body.renderOrder = 2;
const mesh = new THREE.Group();
mesh.add(bodyBack, strings, body);
scene.add(mesh);

const post = new THREE.RenderPipeline(renderer);
const scenePass = pass(scene, camera);
post.outputColorTransform = false;           // we convert with renderOutput() ourselves, so grain is added in display space
const bloomed = scenePass.add(bloom(scenePass, 0.3, 0.4, 0.55));

// ---- parameters + rebuilding ----------------------------------------------
const params = {
  bright: true,
  shape: 'Cylindrical helix',
  subdivision: SHAPES['Cylindrical helix'].subdivision.value,
  complexity: SHAPES['Cylindrical helix'].complexity.value,
  width: SHAPES['Cylindrical helix'].defaultWidth,
  coverage: SHAPES['Cylindrical helix'].defaultCoverage,
  environment: 1,
  envRotation: 0,
  directLight: 0.6,
  endpoints: STRINGS.endpoints,
  seed: STRINGS.seed,
  faceSeed: 3,
  fabricOnly: true,
  departChance: STRINGS.departChance,
};
let anchors = [], pending = new Set();
function schedule(what) {                       // coalesce slider drags into one rebuild per frame
  if (!pending.size) requestAnimationFrame(() => { const p = pending; pending = new Set(); flush(p); });
  pending.add(what);
}
function swap(mesh, geometry) {
  if (!geometry.attributes.aCell && geometry.attributes.position)       // material reads aCell on every body
    geometry.setAttribute('aCell', new THREE.Float32BufferAttribute(new Float32Array(geometry.attributes.position.count * 3), 3));
  if (!geometry.attributes.aDir && geometry.attributes.position)
    geometry.setAttribute('aDir', new THREE.Float32BufferAttribute(new Float32Array(geometry.attributes.position.count * 3), 3));
  mesh.geometry.dispose(); mesh.geometry = geometry;
}
// cells that send strings get aCell.z = 1, so the material can tint them like the strings
function markDeparting(cells) {
  const attr = body.geometry.attributes.aCell, ranges = body.geometry.userData.cellRanges;
  if (!attr || attr.itemSize !== 3) return;
  for (let i = 2; i < attr.array.length; i += 3) attr.array[i] = 0;
  if (ranges && cells) for (const c of cells) {
    const r = ranges.get(c); if (!r) continue;
    for (let v = r[0]; v < r[0] + r[1]; v++) attr.array[v * 3 + 2] = 1;
  }
  attr.needsUpdate = true;
}
function flush(p) {
  if (p.has('body')) {
    const built = SHAPES[params.shape].build({ subdivision: params.subdivision, complexity: params.complexity ?? 1, width: params.width, coverage: params.coverage, faceSeed: params.faceSeed, fabricOnly: params.fabricOnly });
    swap(body, orientOutward(built.body)); anchors = built.anchors;
    bodyBack.geometry = body.geometry;                       // shared; only `body` owns/disposes it
  }
  const sg = createStringsGeometry(anchors, { seed: params.seed, endpoints: params.endpoints, departChance: params.departChance });
  swap(strings, sg);
  markDeparting(sg.userData.departing);
}

function applyLights() {                        // direct lights are scaled down: the environment now does most of the work
  const t = THEMES[theme], k = params.directLight;
  hemi.intensity = t.hemi[2] * k; key.intensity = t.key[1] * k; rimLight.intensity = t.rim[1] * k;
}
// ---- theme (dark / bright) -------------------------------------------------
let theme;
function applyTheme(name) {
  theme = name; const t = THEMES[name];
  scene.backgroundNode = makeBackground(name);
  bgBright.show(name === 'light'); bgDark.show(name === 'dark');
  scene.fog.color.setHex(t.fog); scene.fog.density = t.fogDensity;
  hemi.color.setHex(t.hemi[0]); hemi.groundColor.setHex(t.hemi[1]);
  key.color.setHex(t.key[0]); rimLight.color.setHex(t.rim[0]);
  applyLights();
  if (envTarget) envTarget.dispose();
  envTarget = makeEnvironment(pmrem, name); scene.environment = envTarget.texture;     // image-based lighting
  body.material.dispose(); bodyBack.material.dispose(); strings.material.dispose();
  body.material = createBodyMaterial(name);
  bodyBack.material = createBodyMaterial(name, THREE.BackSide);
  strings.material = createStringMaterial(name);
  post.outputNode = withGrain(renderOutput(t.bloom ? bloomed : scenePass), name);   // grain on top of everything, after colour conversion
  post.needsUpdate = true;
  document.body.style.background = name === 'light' ? '#edebe4' : '#02060c';
  try { localStorage.setItem('theme', name); } catch {}
}

// ---- control panel -----------------------------------------------------------
const gui = new GUI({ title: 'Controls' });
const bright = gui.add(params, 'bright').name('Bright mode').onChange((v) => applyTheme(v ? 'light' : 'dark'));
gui.add(params, 'shape', Object.keys(SHAPES)).name('Shape').onChange((name) => {
  const def = SHAPES[name], sub = def.subdivision, c = def.complexity;
  chanceCtl.setValue(def.departChance);
  widthCtl.setValue(def.defaultWidth); widthCtl.show(def.usesWidth);
  coverageCtl.setValue(def.defaultCoverage);
  if (c) { complexityCtl.name(c.label).min(c.min).max(c.max).step(c.step ?? 1).setValue(c.value); }
  complexityCtl.show(!!c);
  subdivisionCtl.name(sub.label).min(sub.min).max(sub.max).step(sub.step).setValue(sub.value);   // setValue triggers the rebuild
});
const subdivisionCtl = gui.add(params, 'subdivision', 12, 56, 2).name(SHAPES[params.shape].subdivision.label).onChange(() => schedule('body'));
const complexityCtl = gui.add(params, 'complexity', 2, 8, 1).name('Turns').onChange(() => schedule('body'));
const surface = gui.addFolder('Surface');
const widthCtl = surface.add(params, 'width', 0.05, 1, 0.01).name('Width (band / edges)').onChange(() => schedule('body'));
const coverageCtl = surface.add(params, 'coverage', 0.05, 1, 0.01).name('Cell coverage').onChange(() => schedule('body'));
const faceSeedCtl = surface.add(params, 'faceSeed', 0, 9999, 1).name('Visibility seed').onChange(() => schedule('body'));
surface.add({ randomize() { faceSeedCtl.setValue(Math.floor(Math.random() * 10000)); } }, 'randomize').name('Randomize visibility');
const strs = gui.addFolder('Strings');
strs.add(params, 'endpoints', 1, 12, 1).name('Endpoints per anchor').onChange(() => schedule('strings'));
strs.add(uniforms.inkStrength, 'value', 0.05, 1, 0.01).name('Bright: string ink');
const chanceCtl = strs.add(params, 'departChance', 0, 1, 0.01).name('Anchor chance').onChange(() => schedule('strings'));
strs.add(params, 'fabricOnly').name('Anchors only on fabric').onChange(() => schedule('body'));
const seedCtl = strs.add(params, 'seed', 0, 9999, 1).name('Seed').onChange(() => schedule('strings'));
strs.add({ randomize() { seedCtl.setValue(Math.floor(Math.random() * 10000)); } }, 'randomize').name('Randomize seed');


const lighting = gui.addFolder('Lighting');
lighting.add(params, 'environment', 0, 4, 0.01).name('Environment light').onChange((v) => { scene.environmentIntensity = v; });
lighting.add(params, 'envRotation', 0, 360, 1).name('Environment rotation').onChange((v) => { scene.environmentRotation.y = THREE.MathUtils.degToRad(v); });
lighting.add(params, 'directLight', 0, 2, 0.01).name('Direct lights').onChange(() => applyLights());
lighting.close();

// ---- background controls (only the folder for the current mode is shown) ----
const bgParams = { ...BG_DEFAULTS };
function bgFolder(title, rows) {
  const f = gui.addFolder(title);
  for (const [key, label, min, max, step] of rows) {
    const c = typeof BG_DEFAULTS[key] === 'string' ? f.addColor(bgParams, key) : f.add(bgParams, key, min, max, step);
    c.name(label).onChange((v) => setBackgroundParam(key, v));
  }
  f.add({ reset() { f.reset(); } }, 'reset').name('Reset');
  f.close();
  return f;
}
const bgBright = bgFolder('Background (bright)', [
  ['gradient', 'Gradient strength', 0, 2, 0.01], ['brightA', 'Colour, top-left'], ['brightB', 'Colour, bottom-right'],
  ['lift', 'Light behind subject', 0, 1, 0.01], ['vignette', 'Vignette', 0, 0.4, 0.005], ['grainBright', 'Grain (over scene)', 0, 0.2, 0.0025]]);
const bgDark = bgFolder('Background (dark)', [
  ['darkBase', 'Base colour'],
  ['blue', 'Blue field', 0, 1.5, 0.01], ['darkBlue', 'Blue colour'],
  ['teal', 'Teal field', 0, 1.5, 0.01], ['darkTeal', 'Teal colour'],
  ['violet', 'Violet field', 0, 1.5, 0.01], ['darkViolet', 'Violet colour'],
  ['frost', 'Frost', 0, 0.3, 0.005], ['darkFrost', 'Frost colour'],
  ['grainDark', 'Grain (over scene)', 0, 0.2, 0.0025], ['drift', 'Drift speed', 0, 4, 0.05]]);


// ---- copy the exact settings (both modes) as JSON, to paste into a prompt ----
const r3 = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);
function settingsSnapshot() {
  const pick = (keys) => Object.fromEntries(keys.map((k) => [k, r3(bgParams[k])]));
  const def = SHAPES[params.shape];
  return {
    mode: params.bright ? 'bright' : 'dark',
    shape: params.shape,
    subdivision: params.subdivision,
    ...(def.complexity ? { [def.complexity.label.toLowerCase()]: params.complexity } : {}),
    ...(def.usesWidth ? { width: r3(params.width) } : {}),
    cellCoverage: r3(params.coverage),
    lighting: { environmentLight: r3(params.environment), environmentRotation: params.envRotation, directLights: r3(params.directLight) },
    visibilitySeed: params.faceSeed,
    strings: {
      endpointsPerAnchor: params.endpoints, anchorChance: r3(params.departChance), anchorsOnlyOnFabric: params.fabricOnly,
      seed: params.seed, brightInkStrength: r3(uniforms.inkStrength.value),
    },
    background: {
      bright: pick(['gradient', 'brightA', 'brightB', 'lift', 'vignette', 'grainBright']),
      dark: pick(['darkBase', 'blue', 'darkBlue', 'teal', 'darkTeal', 'violet', 'darkViolet', 'frost', 'darkFrost', 'grainDark', 'drift']),
    },
    camera: { position: camera.position.toArray().map(r3), target: controls.target.toArray().map(r3) },
  };
}
const copyCtl = gui.add({
  async copy() {
    const text = JSON.stringify(settingsSnapshot(), null, 2);
    try { await navigator.clipboard.writeText(text); }
    catch { const ta = Object.assign(document.createElement('textarea'), { value: text }); document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
    copyCtl.name('Copied!'); setTimeout(() => copyCtl.name('Copy settings'), 1400);
    console.log(text);
  },
}, 'copy').name('Copy settings');
gui.$children.insertBefore(copyCtl.domElement, gui.$children.firstChild);   // show it first in the panel
addEventListener('keydown', (e) => { if (e.key === 't' || e.key === 'T') bright.setValue(!params.bright); });
let saved; try { saved = localStorage.getItem('theme'); } catch {}
params.bright = saved !== 'dark'; bright.updateDisplay();      // default: bright
applyTheme(params.bright ? 'light' : 'dark');
flush(new Set(['body']));

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

renderer.setAnimationLoop(() => {
  mesh.rotation.y += 0.002;
  controls.update();
  post.render();
});
