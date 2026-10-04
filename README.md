# strings geometry

A Three.js (WebGPU / TSL) study of translucent, cellular "fabric" shapes crossed by straight strings,
inspired by the materials and render of holtsetio.com/lab/aurelia.

- **Shapes:** cylindrical helix, spiral sphere, icosphere lattice, icosphere cells (hexagons / pentagons with radial veins)
- **Two materials:** milky-glass cellular surface, and thin straight strings (glow in dark mode, ink-on-paper multiply in bright mode)
- **Controls:** bright / dark mode (`T`), shape, subdivision, surface width, texture density, seeds, endpoints per anchor, anchor chance, background and grain

## Run

```bash
npm install
npm run dev
```

Needs a WebGPU-capable browser (current Chrome or Safari) and Node 18+ (Vite 5).

## Layout

| File | Purpose |
|---|---|
| `src/main.js` | scene, render pipeline, control panel |
| `src/shapes.js` | shape builders: fabric geometry + anchors |
| `src/geometry.js` | seeded string generation |
| `src/material.js` | surface and string materials (TSL) |
| `src/background.js` | backgrounds and film grain |
| `src/theme.js` | per-theme lights, fog, bloom |
