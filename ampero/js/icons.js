// Module icons for the chain view – own line drawings (24×24, stroke = currentColor), deliberately different
// motifs from the Hotone software's icons.

const svg = (body) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ` +
  `stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  // dynamics: a big wave squeezed into a small one
  DYN: svg('<path d="M2 12c1-7 2.2-7 3.2 0s2.2 7 3.2 0c.8-4.5 1.7-4.5 2.5 0s1.7 4.5 2.5 0c.6-2.4 1.2-2.4 1.8 0s1.2 2.4 1.8 0"/>' +
    '<path d="M19.5 3.5v4M17.8 5.8l1.7 1.7 1.7-1.7M19.5 20.5v-4M17.8 18.2l1.7-1.7 1.7 1.7"/>'),
  // graphic EQ: bars of different height with a curve over them
  EQ: svg('<path d="M4 20v-5M8 20v-9M12 20v-12M16 20v-7M20 20v-4"/><path d="M3 12c4-6 9-8 18-2" stroke-dasharray="2 2"/>'),
  // filter / frequency: low-pass curve with cutoff marker
  FREQ: svg('<path d="M2 8h9c4 0 5 10 11 10"/><path d="M13 4v16" stroke-dasharray="1.5 2"/><circle cx="13" cy="10" r="1.6"/>'),
  // wah: rocking treadle seen from the side
  WAH: svg('<path d="M3 19h18"/><path d="M5 19l2-4h11l1 4"/><path d="M6 14l13-6"/><circle cx="12" cy="15.5" r="1"/>'),
  // drive: a sine wave with clipped peaks
  DRV: svg('<path d="M2 12c1-4 2-6 3-6h3c1 0 2 2 3 6s2 6 3 6h3c1 0 2-2 3-6"/><path d="M2 6h20M2 18h20" stroke-dasharray="1 2.5" stroke-width="1"/>'),
  // amp head: handle, panel with dials, grille slots
  AMP: svg('<path d="M9 5h6"/><rect x="3" y="7" width="18" height="12" rx="1.5"/><path d="M3 11h18"/>' +
    '<circle cx="7" cy="9" r=".8"/><circle cx="10.5" cy="9" r=".8"/><circle cx="14" cy="9" r=".8"/><circle cx="17.5" cy="9" r=".8"/>' +
    '<path d="M6 14h12M6 16.5h12"/>'),
  // pre amp: a vacuum tube
  'PRE AMP': svg('<path d="M8 17V8a4 4 0 0 1 8 0v9"/><path d="M7 17h10v3H7z"/><path d="M10 14V9h4v5M12 9V6"/><path d="M9 20v2M12 20v2M15 20v2"/>'),
  // cabinet: two stacked speakers
  CAB: svg('<rect x="5" y="2.5" width="14" height="19" rx="1.5"/><circle cx="12" cy="8" r="3.5"/><circle cx="12" cy="8" r="1"/>' +
    '<circle cx="12" cy="16" r="3.5"/><circle cx="12" cy="16" r="1"/>'),
  // impulse response: spike with decaying echoes
  IR: svg('<path d="M2 20h20"/><path d="M5 20V4"/><path d="M8 20v-9M11 20v-6M14 20v-4M17 20v-2.5M20 20v-1.5"/><path d="M5 4c3 6 9 12 16 15" stroke-dasharray="1.5 2" stroke-width="1"/>'),
  // NAM: a small neural network
  NAM: svg('<circle cx="4" cy="7" r="1.8"/><circle cx="4" cy="17" r="1.8"/><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/>' +
    '<circle cx="12" cy="19" r="1.8"/><circle cx="20" cy="12" r="1.8"/><path d="M5.7 7.6l4.6-2M5.7 8l4.6 3.5M5.7 16.2l4.6-3.5M5.7 17.4l4.6 1.4M13.8 5.8l4.6 5.2M13.8 12h4.4M13.8 18.2l4.6-5.2"/>'),
  // clone: a waveform and its copy
  CLONE: svg('<rect x="3" y="5" width="12" height="10" rx="1.5"/><rect x="9" y="9" width="12" height="10" rx="1.5"/><path d="M11 14c1.3-3 2.7-3 4 0s2.7 3 4 0"/>'),
  // modulation: a sine wave inside a rotating arrow (LFO)
  MOD: svg('<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M18 3v3.5h-3.5"/><path d="M7 12c1.2-3 2.5-3 3.7 0s2.5 3 3.7 0"/>'),
  // delay: repeats getting smaller and fainter
  DLY: svg('<circle cx="5" cy="12" r="3.2"/><circle cx="12" cy="12" r="2.4" opacity=".75"/><circle cx="17.5" cy="12" r="1.7" opacity=".5"/>' +
    '<circle cx="21.5" cy="12" r="1" opacity=".3"/>'),
  // reverb: sound reflecting inside a room
  RVB: svg('<path d="M3 4v16h18V4"/><circle cx="7" cy="16" r="1.2"/><path d="M10 16a3 3 0 0 0-3-3M13 16a6 6 0 0 0-6-6M16.5 16A9.5 9.5 0 0 0 7 6.5" />'),
  // effects loop: out to an external box and back
  'FX LOOP': svg('<rect x="14" y="6" width="7" height="12" rx="1.2"/><path d="M3 9h9M9.5 6.5L12 9l-2.5 2.5M12 15H3M5.5 12.5L3 15l2.5 2.5"/>'),
  // volume: speaker with a rising wedge
  VOL: svg('<path d="M3 10h3l4-3.5v11L6 14H3z"/><path d="M13 18L21 6v12z"/>'),
};

/** Icon for a module name (MODULES value), or '' if none. */
export function moduleIcon(mod) {
  return ICONS[mod] ?? '';
}
