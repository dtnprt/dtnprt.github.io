// Global settings of the Ampero II Stomp (captures/wine-global-settings-2026-11-17.txt + screenshots of the Hotone
// editor, labels/ranges partly from the Hotone app; tools/FORMAT.md 6.5).
//
// Every setting is a parameter address 0xGGGG00nn. "get" 0xGGGG0000 (kind 0x11) answers with one byte per
// parameter: parameter n at byte n-1 (some trailing bytes are filler). Setting one parameter = set command with the
// address as cmd and the value as payload (1 byte, signed for levels). The pedal does not answer set commands.
// Options marked `guess: true` are not confirmed (order taken from the Hotone app for the Stage or from labels).

export const GLOBAL_GROUPS = [
  {
    id: 'io', title: 'Input / Output', get: 0x00010000, params: [
      { addr: 0x00010001, name: 'Input Mode (L)', options: ['Electric Guitar', 'Acoustic Guitar', 'Line'], guess: true },
      { addr: 0x00010002, name: 'Input Mode (R)', options: ['Electric Guitar', 'Acoustic Guitar', 'Line'], guess: true },
      { addr: 0x0001000e, name: 'Output Level', options: ['Instrument', 'Line'] },
      { addr: 0x00010009, name: 'Bypass Mode', options: ['True Bypass', 'DSP Bypass'], guess: true },
      { addr: 0x0001000f, name: 'Output Source', options: ['Normal', 'USB Only', 'Dry'] },
      { addr: 0x00010008, name: 'FX Send Source', options: ['Normal', 'USB Only', 'Dry'] },
      { addr: 0x00010010, name: 'No Cab Mode (L)', options: ['OFF', 'CAB Only', 'IR Only', 'CAB+IR'] },
      { addr: 0x00010011, name: 'No Cab Mode (R)', options: ['OFF', 'CAB Only', 'IR Only', 'CAB+IR'] },
    ],
  },
  {
    id: 'usb', title: 'USB Audio', get: 0x00020000, params: [
      { addr: 0x00020001, name: 'Rec Level (1/2)', level: [-61, 20] },
      { addr: 0x00020002, name: 'Rec Level (3/4)', level: [-61, 20] },
      { addr: 0x00020003, name: 'Rec Level (5/6)', level: [-61, 20] },
      { addr: 0x00020004, name: 'Rec Level (7/8)', level: [-61, 20] },
      { addr: 0x00020005, name: 'Monitor Level', level: [-61, 6] },
      { addr: 0x00020009, name: 'Output Source', options: ['USB Out OFF', 'USB Out 1/2', 'USB Out 3/4', 'USB Out 5/6', 'USB Out 7/8'] },
      { addr: 0x00020007, name: 'FX Send Source', options: ['USB Out OFF', 'USB Out 1/2', 'USB Out 3/4', 'USB Out 5/6', 'USB Out 7/8'] },
    ],
  },
  {
    id: 'controls', title: 'Controls', note: 'PATCH FS FUNC (0x00070005) and EXP/CTRL Function (0x00070001) are not '
      + 'decoded yet.', params: [
      { addr: 0x00080004, name: 'Bank Select Mode', options: ['Initial', 'Wait'], guess: true },
      { addr: 0x00080001, name: 'Auto Cab Match', switch: true },
      { addr: 0x00070006, name: 'Global Tempo', switch: true },
    ],
  },
  {
    id: 'midi', title: 'MIDI', get: 0x00060000, params: [
      { addr: 0x00060001, name: 'MIDI In Source', options: null, max: 4, guess: true }, // options unknown ("DIN Only" …)
      { addr: 0x00060002, name: 'Input Channel (DIN)', channel: true },
      { addr: 0x00060003, name: 'Input Channel (USB)', channel: true },
      { addr: 0x00060008, name: 'Clock Source', options: null, max: 4, guess: true }, // options unknown ("Mixed" …)
      { addr: 0x00060006, name: 'Clock Out (DIN)', switch: true },
      { addr: 0x00060007, name: 'Clock Out (USB)', switch: true },
    ],
  },
  {
    id: 'display', title: 'Device Display', get: 0x00080000, params: [
      { addr: 0x00080002, name: 'Patch Mode', options: ['Mode 1', 'Mode 2'] },
      { addr: 0x0008000d, name: 'Stomp Mode', options: ['Footswitch', 'Effect Chain'] },
      { addr: 0x00080006, name: 'Color', colors: ['#f5b041', '#ff4d4d', '#4d7cff', '#a05cff', '#4dd2ff', '#7dff4d', '#ff9a3d'] },
      { addr: 0x00080007, name: 'Display Time', options: ['1 Min', '3 Min', '5 Min', '10 Min', '15 Min', '30 Min', '60 Min', 'Always On'], guess: true },
    ],
  },
];

/** Group of a parameter address and the get command that reads it. */
export const groupOf = (addr) => addr & 0xffff0000;

/** Value of parameter `addr` from the answer of its group's get command (byte n-1, signed for levels). */
export function paramValue(p, answer) {
  const i = (p.addr & 0xffff) - 1;
  if (!answer || i >= answer.length) return null;
  const b = answer[i];
  return p.level ? (b << 24) >> 24 : b;
}

/** Set command payload: one byte (two's complement for negative levels). */
export const paramPayload = (value) => Uint8Array.of(value & 0xff);

// ------------------------------------------------------------------ Global EQ (group 0x0003)
//
// get 0x00030000: f32[37] = [EQ on, then the bands below, volume, 0…]. Set: 0x00030001 u32 on/off,
// 0x00030002 u32 index + f32 value (index = position in that array minus 1), 0x00030004 u32 0 = reset.

export const EQ_BANDS = [
  { name: 'Low Cut', on: 0, freq: 1, q: 2 },
  { name: 'Low Shelf', on: 3, freq: 4, q: 5, gain: 6 },
  { name: 'Band 1', on: 7, freq: 8, q: 9, gain: 10 },
  { name: 'Band 2', on: 11, freq: 12, q: 13, gain: 14 },
  { name: 'Band 3', on: 15, freq: 16, q: 17, gain: 18 },
  { name: 'Band 4', on: 19, freq: 20, q: 21, gain: 22 },
  { name: 'High Shelf', on: 23, freq: 24, q: 25, gain: 26 },
  { name: 'High Cut', on: 27, freq: 28, q: 29 },
];
export const EQ_VOLUME = 30;
export const EQ = { GET: 0x00030000, SWITCH: 0x00030001, VALUE: 0x00030002, RESET: 0x00030004 };

/** {on, values: number[36]} from the EQ answer (values[i] = settable index i). */
export function parseEq(p) {
  const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const n = Math.floor(p.length / 4);
  const f = Array.from({ length: n }, (_, i) => v.getFloat32(4 * i, true));
  return { on: f[0] >= 0.5, values: f.slice(1) };
}

export function eqValuePayload(index, value) {
  const p = new Uint8Array(8);
  const v = new DataView(p.buffer);
  v.setUint32(0, index, true);
  v.setFloat32(4, value, true);
  return p;
}

export const u32 = (x) => {
  const p = new Uint8Array(4);
  new DataView(p.buffer).setUint32(0, x, true);
  return p;
};
