// Impulse responses for the Ampero's user IR slots (command 0x04000000): the pedal takes 2048 samples at 44.1 kHz
// as 24-bit values in i32. The Hotone editor resamples the WAV with its native getNormalWav() and sends the first
// 2048 samples without changing the level (captures/wine-upload-nam-ir-2026-11-17.txt in the ampero repo).

export const IR_RATE = 44100;
export const IR_SAMPLES = 2048;
const FULL = 8388607; // 2^23 - 1

/** Parse a RIFF/WAVE file: {rate, channels, bits, float, samples: Float32Array (first channel, -1..1)}. */
export function parseWav(bytes) {
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let fmt = null, data = null;
  for (let o = 12; o + 8 <= bytes.length;) {
    const id = tag(o), len = d.getUint32(o + 4, true);
    if (id === 'fmt ') {
      let format = d.getUint16(o + 8, true);
      if (format === 0xfffe && len >= 26) format = d.getUint16(o + 32, true); // WAVE_FORMAT_EXTENSIBLE: sub format
      fmt = { format, channels: d.getUint16(o + 10, true), rate: d.getUint32(o + 12, true), bits: d.getUint16(o + 22, true) };
    } else if (id === 'data') {
      data = { o: o + 8, len: Math.min(len, bytes.length - o - 8) };
    }
    o += 8 + len + (len & 1);
  }
  if (!fmt || !data) throw new Error('WAV without fmt or data chunk');
  const { format, channels, rate, bits } = fmt;
  const isFloat = format === 3;
  if (!(format === 1 || isFloat) || !(isFloat ? [32, 64] : [8, 16, 24, 32]).includes(bits)) {
    throw new Error(`unsupported WAV format (format ${format}, ${bits} bit)`);
  }
  const step = (bits / 8) * channels;
  const n = Math.floor(data.len / step);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = data.o + i * step; // first channel
    let v;
    if (isFloat) v = bits === 32 ? d.getFloat32(o, true) : d.getFloat64(o, true);
    else if (bits === 8) v = (bytes[o] - 128) / 128;
    else if (bits === 16) v = d.getInt16(o, true) / 32768;
    else if (bits === 24) v = ((bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16)) << 8 >> 8) / 8388608;
    else v = d.getInt32(o, true) / 2147483648;
    s[i] = v;
  }
  return { rate, channels, bits, float: isFloat, samples: s };
}

/** Band-limited resampling (windowed sinc, Blackman, 32 zero crossings) of the first `count` output samples. */
export function resample(src, from, to, count) {
  if (from === to) return Float32Array.from({ length: count }, (_, i) => src[i] ?? 0);
  const ratio = from / to;
  const cutoff = Math.min(1, to / from); // relative to the source Nyquist
  const half = 32 / cutoff; // filter half width in source samples
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const x = i * ratio;
    const lo = Math.max(0, Math.ceil(x - half)), hi = Math.min(src.length - 1, Math.floor(x + half));
    let acc = 0;
    for (let k = lo; k <= hi; k++) {
      const t = k - x;
      const a = Math.PI * t * cutoff;
      const sinc = t === 0 ? 1 : Math.sin(a) / a;
      const wpos = (t + half) / (2 * half); // 0..1
      const win = 0.42 - 0.5 * Math.cos(2 * Math.PI * wpos) + 0.08 * Math.cos(4 * Math.PI * wpos);
      acc += src[k] * sinc * win * cutoff;
    }
    out[i] = acc;
  }
  return out;
}

/** WAV bytes -> {samples: Int32Array(2048) of 24-bit values, info} ready for the pedal. */
export function wavToIr(bytes) {
  const w = parseWav(bytes);
  const r = resample(w.samples, w.rate, IR_RATE, IR_SAMPLES);
  let clipped = 0;
  const samples = Int32Array.from(r, (v) => {
    const x = Math.round(v * 8388608);
    if (x > FULL || x < -FULL - 1) clipped++;
    return Math.max(-FULL - 1, Math.min(FULL, x));
  });
  const ms = (w.samples.length / w.rate) * 1000;
  return { samples, info: { rate: w.rate, channels: w.channels, bits: w.bits, float: w.float, ms, clipped,
    truncated: ms > (IR_SAMPLES / IR_RATE) * 1000 } };
}
