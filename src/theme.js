// Scene-level look per theme: gradient background, fog, lights, bloom.
export const THEMES = {
  dark: {
    bgCenter: 0x0a1522, bgEdge: 0x02060c, fog: 0x02060c, fogDensity: 0.25, bloom: true,
    hemi: [0x6fa8ff, 0x2a1038, 2.2], key: [0xffc4a0, 3.4], rim: [0x40ffd0, 2.2],
  },
  // centre / edge average out around #EDEBE4
  light: {
    bgCenter: 0xf4f2ec, bgEdge: 0xe0ddd3, fog: 0xedebe4, fogDensity: 0.02, bloom: false,
    hemi: [0xdfe8f0, 0x6b7884, 0.7], key: [0xfff1e0, 1.0], rim: [0xcfe4ff, 0.6],
  },
};
