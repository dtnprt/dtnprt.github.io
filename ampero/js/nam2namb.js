// .nam (Neural Amp Modeler, JSON) -> .namb (compact binary model the Ampero loads).
// Port of nam2namb from TONE3000's nam-binary-loader (MIT License, Copyright (c) 2026 TONE3000,
// https://github.com/tone-3000/nam-binary-loader) - the converter the Hotone editor uses. Same output as
// tools/nam2namb.py in the ampero repo, which is byte-identical to a capture of the Hotone editor.
// NAM A2 models (SlimmableContainer) are reduced to one submodel first; slim 0 = the smallest, like the editor.

const ARCH = { Linear: 0, ConvNet: 1, LSTM: 2, WaveNet: 3 };
const ACTIVATIONS = ['Tanh', 'Hardtanh', 'Fasttanh', 'ReLU', 'LeakyReLU', 'PReLU', 'Sigmoid', 'SiLU', 'Hardswish',
  'LeakyHardtanh', 'Softsign'];
const GATING = { none: 0, gated: 1, blended: 2 };
const FILMS = ['conv_pre_film', 'conv_post_film', 'input_mixin_pre_film', 'input_mixin_post_film',
  'activation_pre_film', 'activation_post_film', 'layer1x1_post_film', 'head1x1_post_film'];

class Writer {
  constructor() {
    this.buf = new Uint8Array(1024);
    this.n = 0;
  }

  _room(k) {
    if (this.n + k <= this.buf.length) return;
    const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + k));
    b.set(this.buf.subarray(0, this.n));
    this.buf = b;
  }

  _put(k, f) {
    this._room(k);
    f(new DataView(this.buf.buffer), this.n);
    this.n += k;
  }

  u8(v) { this._put(1, (d, o) => d.setUint8(o, v)); }
  u16(v) { this._put(2, (d, o) => d.setUint16(o, v, true)); }
  u32(v) { this._put(4, (d, o) => d.setUint32(o, v, true)); }
  i32(v) { this._put(4, (d, o) => d.setInt32(o, v, true)); }
  f32(v) { this._put(4, (d, o) => d.setFloat32(o, v, true)); }
  f64(v) { this._put(8, (d, o) => d.setFloat64(o, v, true)); }
  zeros(k) { this._room(k); this.buf.fill(0, this.n, this.n + k); this.n += k; }
  setU16(o, v) { new DataView(this.buf.buffer).setUint16(o, v, true); }
  setU32(o, v) { new DataView(this.buf.buffer).setUint32(o, v, true); }
  bytes() { return this.buf.slice(0, this.n); }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (zlib) of the file without its checksum field (bytes 24..27). */
function fileCrc(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) {
    if (i >= 24 && i < 28) continue;
    c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function activation(w, a) {
  if (typeof a === 'string') a = { type: a };
  const t = a.type === 'Swish' ? 'SiLU' : a.type;
  const id = ACTIVATIONS.indexOf(t);
  if (id < 0) throw new Error(`unknown activation "${a.type}"`);
  let params = [];
  if (t === 'LeakyReLU' && a.negative_slope != null) params = [a.negative_slope];
  else if (t === 'PReLU') params = a.negative_slopes ?? (a.negative_slope != null ? [a.negative_slope] : []);
  else if (t === 'LeakyHardtanh') params = [a.min_val ?? -1, a.max_val ?? 1, a.min_slope ?? 0.01, a.max_slope ?? 0.01];
  w.u8(id);
  w.u8(params.length);
  for (const p of params) w.f32(p);
}

function film(w, layer, key) {
  const f = layer[key];
  if (!f) {
    w.u8(0); w.u8(0); w.u16(1);
    return;
  }
  w.u8(((f.active ?? true) ? 1 : 0) | ((f.shift ?? true) ? 2 : 0));
  w.u8(0);
  w.u16(f.groups ?? 1);
}

function metadata(w, m) {
  const [major = 0, minor = 0, patch = 0] = String(m.version ?? '0.0.0').split('.').map((x) => parseInt(x, 10) || 0);
  w.u8(major); w.u8(minor); w.u8(patch);
  const meta = m.metadata ?? {};
  let flags = 0;
  const vals = [['loudness', 1], ['input_level_dbu', 2], ['output_level_dbu', 4]].map(([k, bit]) => {
    if (meta[k] == null) return 0;
    flags |= bit;
    return +meta[k];
  });
  w.u8(flags);
  w.f64(m.sample_rate != null ? +m.sample_rate : -1);
  for (const v of vals) w.f64(v);
  w.zeros(12);
}

function collectWeights(m, out) {
  if (m.architecture === 'WaveNet' && m.config.condition_dsp) collectWeights(m.config.condition_dsp, out);
  for (const x of m.weights ?? []) out.push(x);
}

function wavenet(w, m) {
  const c = m.config;
  const head = c.head != null;
  w.u8(c.in_channels ?? 1); w.u8(head ? 1 : 0); w.u8(c.layers.length); w.u8(c.condition_dsp ? 1 : 0);
  if (c.condition_dsp) {
    const cw = [];
    collectWeights(c.condition_dsp, cw);
    w.u32(cw.length);
    metadata(w, c.condition_dsp);
    modelBlock(w, c.condition_dsp);
  }
  for (const L of c.layers) {
    const ch = L.channels, dil = L.dilations, n = dil.length;
    const ks = Array.isArray(L.kernel_sizes) ? L.kernel_sizes : new Array(n).fill(L.kernel_size);
    if (ks.length !== n || ks.some((k) => k == null)) throw new Error('kernel_sizes do not match dilations');
    let hs, hk = 1, hb;
    if (L.head != null) [hs, hk, hb] = [L.head.out_channels, L.head.kernel_size, L.head.bias];
    else [hs, hb] = [L.head_size, L.head_bias];
    for (const v of [L.input_size, L.condition_size, hs, ch, L.bottleneck ?? ch, hk]) w.u16(v);
    w.u8(hb ? 1 : 0); w.u8(n);
    w.u16(L.groups_input ?? 1); w.u16(L.groups_input_mixin ?? 1);
    const l1 = L.layer1x1 ?? { active: true, groups: 1 };
    w.u8(l1.active ? 1 : 0); w.u16(l1.groups); w.u8(0);
    const h1 = L.head1x1 ?? { active: false, out_channels: ch, groups: 1 };
    w.u8(h1.active ? 1 : 0); w.u16(h1.out_channels); w.u16(h1.groups); w.u8(0);
    for (const k of FILMS) film(w, L, k);
    for (const d of dil) w.i32(d);
    for (const k of ks) w.u16(k);
    for (const a of Array.isArray(L.activation) ? L.activation : new Array(n).fill(L.activation)) activation(w, a);
    let gm;
    if (L.gating_mode != null) {
      gm = (Array.isArray(L.gating_mode) ? L.gating_mode : new Array(n).fill(L.gating_mode)).map((g) => {
        if (!(g in GATING)) throw new Error(`invalid gating_mode "${g}"`);
        return GATING[g];
      });
    } else {
      gm = new Array(n).fill(L.gated ? GATING.gated : GATING.none);
    }
    for (const g of gm) w.u8(g);
    const sec = L.secondary_activation;
    gm.forEach((g, i) => {
      if (!g) {
        w.u8(ACTIVATIONS.indexOf('Tanh')); w.u8(0); // placeholder
      } else if (sec == null) {
        w.u8(ACTIVATIONS.indexOf('Sigmoid')); w.u8(0);
      } else {
        activation(w, Array.isArray(sec) ? sec[i] : sec);
      }
    });
  }
}

function modelBlock(w, m) {
  const arch = ARCH[m.architecture];
  if (arch === undefined) throw new Error(`unsupported architecture "${m.architecture}"`);
  const c = m.config;
  w.u8(arch); w.u8(0);
  const sizePos = w.n;
  w.u16(0);
  const start = w.n;
  if (arch === 0) {
    w.i32(c.receptive_field); w.u8(c.bias ? 1 : 0); w.u8(c.in_channels ?? 1); w.u8(c.out_channels ?? 1); w.u8(0);
  } else if (arch === 1) {
    w.u16(c.channels); w.u8(c.batchnorm ? 1 : 0); w.u8(c.dilations.length); w.u16(c.groups ?? 1);
    w.u8(c.in_channels ?? 1); w.u8(c.out_channels ?? 1);
    activation(w, c.activation);
    for (const d of c.dilations) w.i32(d);
  } else if (arch === 2) {
    w.u16(c.num_layers); w.u16(c.input_size); w.u16(c.hidden_size);
    w.u8(c.in_channels ?? 1); w.u8(c.out_channels ?? 1); w.u16(0);
  } else {
    wavenet(w, m);
  }
  const size = w.n - start;
  if (size > 65535) throw new Error('model config too large');
  w.setU16(sizePos, size);
}

/** Pick one submodel of a SlimmableContainer (first with slim < max_value, else the last). */
export function resolveSlimmable(m, slim = 0) {
  const subs = m.config?.submodels;
  if (!Array.isArray(subs) || !subs.length) throw new Error("SlimmableContainer: 'submodels' must be a non-empty array");
  let idx = subs.findIndex((s) => slim < s.max_value);
  if (idx < 0) idx = subs.length - 1;
  const sel = { ...subs[idx].model };
  for (const k of ['version', 'metadata', 'sample_rate']) if (k in m && !(k in sel)) sel[k] = m[k];
  return { model: sel, index: idx, count: subs.length };
}

/**
 * Convert a parsed .nam model. Returns {namb (Uint8Array), weights, architecture, submodel: {index, count} | null}.
 */
export function namToNamb(model, slim = 0) {
  let m = model, submodel = null;
  if (m.architecture === 'SlimmableContainer') {
    const r = resolveSlimmable(m, slim);
    m = r.model;
    submodel = { index: r.index, count: r.count };
  }
  const w = new Writer();
  w.u32(0x4e414d42); w.u16(1); w.u16(0);
  w.zeros(24);
  metadata(w, m);
  const start = w.n;
  modelBlock(w, m);
  const block = w.n - start;
  while (w.n % 4) w.u8(0);
  const woff = w.n;
  const weights = [];
  collectWeights(m, weights);
  for (const x of weights) w.f32(x);
  w.setU32(8, w.n); w.setU32(12, woff); w.setU32(16, weights.length); w.setU32(20, block);
  const out = w.bytes();
  new DataView(out.buffer).setUint32(24, fileCrc(out), true);
  return { namb: out, weights: weights.length, architecture: m.architecture, submodel };
}

/** True if the bytes are a .namb file (magic "NAMB"). */
export const isNamb = (b) => b.length >= 32 && b[0] === 0x42 && b[1] === 0x4d && b[2] === 0x41 && b[3] === 0x4e;
