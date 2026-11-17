// Sniffer logic: read captures (live MIDI, app traces, Wireshark/USBPcap .pcapng), reassemble the SysEx
// transfers of both directions and describe them as fields with byte ranges (for the hex view).

import {
  CATEGORIES, CHAIN_MODES, CMD, MODULES, PRESET_COUNT, SPECIAL_ALGS, TLV_SECTIONS, cString, decodeStream, parseFrame,
  presetChainMode, presetInfo, presetLabel, presetRouting, rd32,
} from './protocol.js';

const HOTONE_VID = 0x84ef;
const hex2 = (b) => b.toString(16).padStart(2, '0');
export const hex32 = (v) => (v >>> 0).toString(16).padStart(8, '0');
export const hexBytes = (b, max = 32) =>
  Array.from(b.subarray(0, max), hex2).join(' ') + (b.length > max ? ' …' : '');

// ------------------------------------------------------------------ inputs

/** App trace ("<ms> IN|OUT <hex bytes>" per line) -> messages [{t, dir, bytes}]. */
export function parseTraceText(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([\d.]+)\s+(IN|OUT)\s+([0-9a-fA-F ]+)$/.exec(line);
    if (m) out.push({ t: +m[1], dir: m[2], bytes: Uint8Array.from(m[3].trim().split(/\s+/), (h) => parseInt(h, 16)) });
  }
  return out;
}

/**
 * Wireshark / USBPcap capture -> messages [{t, dir, bytes}] of the Ampero (found by its USB device descriptor,
 * VID 0x84EF, or – if the capture started later – by its Hotone SysEx). Both directions.
 */
export function parsePcapng(buffer) {
  const dv = new DataView(buffer);
  const packets = [];
  for (let o = 0; o + 12 <= buffer.byteLength;) {
    const type = dv.getUint32(o, true), len = dv.getUint32(o + 4, true);
    if (len < 12 || o + len > buffer.byteLength) break;
    if (type === 6) { // enhanced packet block
      const t = (dv.getUint32(o + 12, true) * 4294967296 + dv.getUint32(o + 16, true)) / 1000; // µs -> ms
      const cap = dv.getUint32(o + 20, true);
      packets.push({ t, d: new Uint8Array(buffer, o + 28, cap) });
    }
    o += len;
  }
  const hdr = (d) => {
    const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
    return { hl: v.getUint16(0, true), bus: v.getUint16(17, true), dev: v.getUint16(19, true), ep: d[21],
      tt: d[22], dl: v.getUint32(23, true) };
  };
  let device = null;
  for (const p of packets) { // GET_DESCRIPTOR(DEVICE) answer with the Hotone VID
    if (p.d.length < 27) continue;
    const h = hdr(p.d);
    const q = p.d.subarray(h.hl, h.hl + h.dl);
    if (h.tt === 2 && q.length >= 18 && q[0] === 18 && q[1] === 1 && (q[8] | (q[9] << 8)) === HOTONE_VID) {
      device = `${h.bus}/${h.dev}`;
      break;
    }
  }
  if (!device) {
    for (const p of packets) {
      if (p.d.length < 27) continue;
      const h = hdr(p.d);
      const q = p.d.subarray(h.hl, h.hl + h.dl);
      for (let k = 0; h.tt === 3 && k + 4 <= q.length; k += 4) {
        if (q[k + 1] === 0xf0 && q[k + 2] === 0x21 && q[k + 3] === 0x25) {
          device = `${h.bus}/${h.dev}`;
          break;
        }
      }
      if (device) break;
    }
  }
  if (!device) throw new Error('no Ampero traffic in this capture (wrong USBPcap interface?)');
  const t0 = packets.length ? packets[0].t : 0;
  const msgs = [];
  const buf = { IN: [], OUT: [] };
  const len = { 4: 3, 5: 1, 6: 2, 7: 3 };
  for (const p of packets) {
    if (p.d.length < 27) continue;
    const h = hdr(p.d);
    if (`${h.bus}/${h.dev}` !== device || h.tt !== 3 || !h.dl) continue;
    const dir = h.ep & 0x80 ? 'IN' : 'OUT';
    const q = p.d.subarray(h.hl, h.hl + h.dl);
    for (let k = 0; k + 4 <= q.length; k += 4) { // USB-MIDI event packets
      const cin = q[k] & 0x0f;
      if (len[cin]) {
        for (let j = 0; j < len[cin]; j++) buf[dir].push(q[k + 1 + j]);
        if (cin !== 4) {
          msgs.push({ t: p.t - t0, dir, bytes: Uint8Array.from(buf[dir]) });
          buf[dir] = [];
        }
      } else if (cin >= 0x8 && cin <= 0xe) { // channel messages (CC, program change …)
        msgs.push({ t: p.t - t0, dir, bytes: q.slice(k + 1, k + (cin === 0xc || cin === 0xd ? 3 : 4)) });
      }
    }
  }
  return { device, messages: msgs };
}

// ------------------------------------------------------------------ reassembly

/**
 * Messages -> entries (transfers). Per direction; several multi-frame transfers may be open at once
 * (matched by total and fill). Every entry: {n, t, dir, type: 'transfer'|'other'|'damaged'|'error',
 * kind, cmd, payload, stream, frames: [{t, bytes}], error}.
 */
export class Assembler {
  constructor() {
    this.entries = [];
    this.open = { IN: [], OUT: [] };
  }

  push({ t, dir, bytes }) {
    const add = (e) => {
      e.n = this.entries.length + 1;
      this.entries.push(e);
      return e;
    };
    if (bytes[0] !== 0xf0) return add({ t, dir, type: 'other', frames: [{ t, bytes }], what: 'MIDI' });
    const fr = parseFrame(bytes);
    if (!fr) return add({ t, dir, type: 'other', frames: [{ t, bytes }], what: shortFrame(bytes) });
    if (fr.damaged) {
      return add({ t, dir, type: 'damaged', frames: [{ t, bytes }],
        error: `damaged frame: ${bytes.length} bytes, offset ${fr.offset}/${fr.total}` });
    }
    const open = this.open[dir];
    let s;
    if (fr.offset === 0) {
      s = { t, kind: fr.kind, total: fr.total, data: new Uint8Array(fr.total), fill: 0, frames: [] };
      open.push(s);
    } else {
      s = open.find((o) => o.total === fr.total && o.fill === fr.offset);
      if (!s) {
        return add({ t, dir, type: 'error', frames: [{ t, bytes }],
          error: `frame offset ${fr.offset}/${fr.total} fits no open transfer` });
      }
    }
    s.data.set(fr.data.subarray(0, Math.min(fr.data.length, s.total - s.fill)), s.fill);
    s.fill += fr.data.length;
    s.frames.push({ t, bytes });
    if (s.fill < s.total) return null;
    open.splice(open.indexOf(s), 1);
    const e = { t: s.t, dir, type: 'transfer', kind: s.kind, stream: s.data, frames: s.frames };
    try {
      const d = decodeStream(s.data, s.kind);
      e.cmd = d.cmd;
      e.payload = d.payload;
    } catch (err) {
      e.cmd = s.data.length >= 4 ? rd32(s.data, 0) : 0;
      e.payload = new Uint8Array(0);
      e.type = 'error';
      e.error = err.message;
    }
    return add(e);
  }
}

function shortFrame(b) {
  if (b[1] === 0x21 && b[2] === 0x25 && b[3] === 0x7f) return 'short frame (handshake / keep-alive)';
  return 'SysEx (not Ampero)';
}

// ------------------------------------------------------------------ descriptions

/** field: {name, off, len, value, children} – offsets into the decompressed payload */
const F = (name, off, len, value = '', children) => ({ name, off, len, value, children });
const u32f = (p, name, off, fmt = (v) => `${v}`) => F(name, off, 4, p.length >= off + 4 ? fmt(rd32(p, off)) : '?');
const strf = (p, name, off, len) => F(name, off, len, `"${cString(p, off, len)}"`);
const rest = (p, off, name = 'unknown') => (p.length > off ? [F(name, off, p.length - off, hexBytes(p.subarray(off), 16))] : []);
const slotf = (p, name, off) => u32f(p, name, off, (v) => (v < PRESET_COUNT ? `${v} = ${presetLabel(v)}` : `${v}`));
const u16 = (p, o) => p[o] | (p[o + 1] << 8);

const f32 = (p, o) => new DataView(p.buffer, p.byteOffset + o, 4).getFloat32(0, true);
const fmtF = (v) => (Number.isNaN(v) ? 'NaN' : String(Math.round(v * 100) / 100));
const f32s = (p, o, n) => Array.from({ length: n }, (_, i) => f32(p, o + 4 * i));
const i16 = (p, o) => (u16(p, o) << 16) >> 16;
/** byte list, 0xFF shown as "–" (unused) */
const bytesf = (p, name, off, len, fmt = (b) => (b === 0xff ? '–' : `${b}`)) =>
  F(name, off, len, Array.from(p.subarray(off, off + len), fmt).join(' '));
const floatsf = (p, name, off, n) => F(name, off, 4 * n, f32s(p, off, n).map(fmtF).join(' '));
const slotNo = (b) => (b === 0xff ? '–' : `${b + 1}`);
const algName = (c) => (c === 0xffffffff ? 'empty' : `${SPECIAL_ALGS[c] ?? MODULES[c >>> 24] ?? '?'} 0x${hex32(c)}`);

/** Sections 2, 3, 6, 7, 8 – names and sizes from the Hotone app (HTModelPreset.get…Data), see FORMAT.md 3. */
function sectionFields(p, tag, d, len, base) {
  if (tag === 2 && len >= 6) {
    return [bytesf(p, 'obj[3] (target slot per knob)', d, 3, slotNo), bytesf(p, 'param[3] (parameter index)', d + 3, 3)];
  }
  if (tag === 3 && len >= 8) {
    const h = (b) => (b === 0xff ? '–' : hex2(b));
    return [bytesf(p, 'click[3] (FS1–3 function)', d, 3, h), bytesf(p, 'hold[3] (function when held)', d + 3, 3, h),
      bytesf(p, 'comb[2] (combinations)', d + 6, 2, h), ...(len > 8 ? [F('rest', d + 8, len - 8, hexBytes(p.subarray(d + 8, d + len)))] : [])];
  }
  if (tag === 6 && len >= 540) {
    const r = presetRouting(p.subarray(base)); // wants the whole TLV chain
    const pos = (v) => (v === 0xff ? 'none' : v === 6 ? 'end of row 1' : `before row-1 position ${v + 1}`);
    return [
      F('routing', d + 456, 2, `${r.name}${r.template ? ' (template)' : ''}`),
      F('i16 inputSource[2]', d, 4, `${i16(p, d)} ${i16(p, d + 2)}`),
      F('i16 outputSource[2]', d + 4, 4, `${i16(p, d + 4)} ${i16(p, d + 6)}`),
      F('f32 inputSourceParam[56]', d + 8, 224, f32s(p, d + 8, 8).map(fmtF).join(' ') + ' …'),
      F('f32 outputSourceParam[56]', d + 232, 224, f32s(p, d + 232, 8).map(fmtF).join(' ') + ' …'),
      F('splitNodeAddr', d + 456, 1, pos(p[d + 456])),
      F('mixerNodeAddr (merge)', d + 457, 1, pos(p[d + 457])),
      F('splitNodeMode', d + 458, 1, `${p[d + 458]}`),
      F('mixerNodeMode', d + 459, 1, `${p[d + 459]}`),
      floatsf(p, 'f32 splitNodeModeParam[10]', d + 460, 10),
      floatsf(p, 'f32 mixerNodeModeParam[10] (A/B level, A/B pan, B polarity, master …)', d + 500, 10),
    ];
  }
  if (tag === 7 && len >= 114) {
    const targets = [];
    for (let i = 0; i < 8; i++) {
      if (p[d + 2 + i] === 0xff) continue;
      targets.push(F(`target ${i + 1}`, d + 2 + i, 1, `slot ${slotNo(p[d + 2 + i])}, param ${p[d + 10 + i]}, ` +
        `${fmtF(f32(p, d + 18 + 4 * i))}…${fmtF(f32(p, d + 50 + 4 * i))}, curve ${fmtF(f32(p, d + 82 + 4 * i))}`));
    }
    return [
      bytesf(p, 'expState[2] (EXP1/EXP2)', d, 2),
      bytesf(p, 'expTargetAlgorObjectList[8] (slot)', d + 2, 8, slotNo),
      bytesf(p, 'expTargetAlgorEffectNum[8] (parameter)', d + 10, 8),
      floatsf(p, 'f32 min[8]', d + 18, 8), floatsf(p, 'f32 max[8]', d + 50, 8), floatsf(p, 'f32 curve[8]', d + 82, 8),
      ...(targets.length ? [F('used targets', d + 2, 16, `${targets.length}`, targets)] : []),
      ...(len >= 178 ? [floatsf(p, 'f32 autoOff[8] (pedal only)', d + 114, 8), floatsf(p, 'f32 offTime[8] (pedal only)', d + 146, 8)] : []),
    ];
  }
  if (tag === 8 && len >= 39) {
    const fs = [0, 1, 2].map((i) => {
      const o = d + 3 + 12 * i;
      const on = [];
      for (let s = 0; s < 12; s++) if (p[o + s] === 1) on.push(s + 1);
      return F(`FS${i + 1} → slots`, o, 12, on.length ? on.join(' ') : 'none', [bytesf(p, 'ctrlTargetSlot[12]', o, 12)]);
    });
    return [bytesf(p, 'ctrlLED[3]', d, 3), ...fs];
  }
  return null;
}

function tlvFields(p, base) {
  const out = [];
  let o = base;
  while (o + 8 <= p.length) {
    const tag = rd32(p, o), len = rd32(p, o + 4);
    if (o + 8 + len > p.length) {
      out.push(F('broken TLV', o, p.length - o));
      break;
    }
    const d = o + 8;
    const ch = [u32f(p, 'tag', o), u32f(p, 'length', o + 4)];
    const sec = sectionFields(p, tag, d, len, base);
    if (sec) {
      ch.push(...sec);
    } else if (tag === 1 && len >= 101) {
      ch.push(u32f(p, 'version', d), strf(p, 'name', d + 4, 17), strf(p, 'patchAuthorInfo (author)', d + 21, 20),
        strf(p, 'info (description)', d + 41, 50), strf(p, 'pathTypeinfo (style)', d + 91, 10));
    } else if (tag === 4 && len >= 72) {
      const algs = [];
      for (let s = 0; s < 12; s++) {
        const c = rd32(p, d + 24 + 4 * s);
        algs.push(F(`slot ${s + 1}`, d + 24 + 4 * s, 4, algName(c)));
      }
      ch.push(F('seq[12] (position → slot)', d, 12, Array.from(p.subarray(d, d + 12)).join(' ')),
        bytesf(p, 'mod[12] (category per slot)', d + 12, 12, (b) => (b === 0xff ? '–' : CATEGORIES[b] ?? `${b}`)),
        F('alg[12]', d + 24, 48, '', algs));
    } else if (tag === 5 && len >= 3648) {
      const on = [0, 1, 2].map((s) => F(`scene ${s + 1} on[12]`, d + 3600 + 12 * s, 12,
        Array.from(p.subarray(d + 3600 + 12 * s, d + 3612 + 12 * s), (b) => (b ? '1' : '0')).join('')));
      const names = [0, 1, 2].map((s) => strf(p, `scene ${s + 1} name`, d + len - 24 + 8 * s, 8));
      ch.push(F('effectSlotAlgroParam', d, 3600, '3 scenes × 12 slots × 25 floats …'),
        F('effectSlotState (slot on/off)', d + 3600, 36, '', on),
        F('patchVol[3]', d + 3636, 6, [0, 1, 2].map((s) => u16(p, d + 3636 + 2 * s)).join(' ')),
        F('patchTempo[3] (BPM)', d + 3642, 6, [0, 1, 2].map((s) => u16(p, d + 3642 + 2 * s)).join(' ')),
        F('empty / vol / bpm / sta / para (scene follow?)', d + 3648, len - 3648 - 24, hexBytes(p.subarray(d + 3648, d + len - 24), 8)),
        F('scene names', d + len - 24, 24, '', names));
    } else if (len) {
      ch.push(F('data', d, len, hexBytes(p.subarray(d, d + len), 16)));
    }
    out.push(F(`tag ${tag} – ${TLV_SECTIONS[tag] ?? '?'}`, o, 8 + len, `${len} B`, ch));
    o += 8 + len;
  }
  return out;
}

/** "A93-1 "Empty" · Metal · Serial" for a payload u32 slot + TLV preset. */
function presetSummary(p) {
  if (p.length <= 8) return p.length >= 4 ? `slot ${presetLabel(rd32(p, 0))}` : '';
  const raw = p.subarray(4);
  const info = presetInfo(raw);
  let mode = '';
  try {
    mode = presetChainMode(raw).name;
  } catch { /* ignore */ }
  return `${presetLabel(rd32(p, 0))} "${info.name}"${info.style ? ` · ${info.style}` : ''}${mode ? ` · chain ${mode}` : ''}`;
}

const presetFields = (p) => [slotf(p, 'slot', 0), F('preset (TLV)', 4, p.length - 4, `${p.length - 4} B`, tlvFields(p, 4))];

/**
 * Declarative payload decoder: [[name, type, n?], …] -> fields (+ "unknown" for trailing bytes).
 * Types: u8 u16 i16 u32 f32, str (n bytes), bytes (n bytes, or the rest), f32s (rest as floats),
 * preset (u32 preset slot), scene (u8/u16/u32 by n, shown 1-based), cmd (u32 command code).
 * Fields that do not fit into the payload are left out (requests are often shorter than answers).
 */
const SIZES = { u8: 1, u16: 2, i16: 2, u32: 4, f32: 4, preset: 4, cmd: 4 };
function struct(spec) {
  return (p) => {
    const out = [];
    let o = 0;
    for (const [name, type, n] of spec) {
      const size = type === 'str' || type === 'bytes' ? (n ?? p.length - o) : type === 'f32s' ? p.length - o
        : type === 'scene' ? (n ?? 1) : SIZES[type];
      if (size <= 0 || o + size > p.length) break;
      let v;
      if (type === 'u8') v = `${p[o]}`;
      else if (type === 'u16') v = `${u16(p, o)}`;
      else if (type === 'i16') v = `${i16(p, o)}`;
      else if (type === 'u32') v = `${rd32(p, o)}`;
      else if (type === 'f32') v = fmtF(f32(p, o));
      else if (type === 'str') v = `"${cString(p, o, size)}"`;
      else if (type === 'bytes') v = hexBytes(p.subarray(o, o + size), 16);
      else if (type === 'f32s') v = f32s(p, o, Math.floor(size / 4)).slice(0, 12).map(fmtF).join(' ') + (size > 48 ? ' …' : '');
      else if (type === 'preset') v = rd32(p, o) < PRESET_COUNT ? `${rd32(p, o)} = ${presetLabel(rd32(p, o))}` : `${rd32(p, o)}`;
      else if (type === 'scene') v = `${(size === 1 ? p[o] : size === 2 ? u16(p, o) : rd32(p, o)) + 1}`;
      else if (type === 'cmd') v = `0x${hex32(rd32(p, o))}${KNOWN[rd32(p, o)] ? ` (${KNOWN[rd32(p, o)].name})` : ''}`;
      out.push(F(name, o, size, v));
      o += size;
    }
    return [...out, ...rest(p, o)];
  };
}

/**
 * Known commands: name + decoder (payload, entry) -> fields.
 * Names in brackets are the functions of the Hotone app that send the command (decompiled Android app,
 * HTModelPreset.dart and views/main/Global/*); payload layouts are taken from their field maps. "(app)" marks the
 * ones not confirmed by a capture yet; confirmed with the Hotone editor under Wine (captures/wine-edit-2026-11-17.txt
 * in the ampero repo): 01040001/2/3, 01090004, 01090007, 03000001, 05000000.
 */
export const KNOWN = {
  [CMD.CONNECT]: { name: 'connect / screen lock query [requestScrrenIsLock]' },
  [CMD.CURRENT_PRESET]: { name: 'current preset (get / select)', fields: (p) => (p.length >= 4 ? [slotf(p, 'preset', 0)] : []) },
  [CMD.PRESET_DUMP]: { name: 'preset dump', summary: presetSummary, fields: (p) => (p.length > 8 ? presetFields(p) : p.length >= 4 ? [slotf(p, 'slot', 0)] : []) },
  [CMD.PRESET_WRITE]: { name: 'write preset into slot', summary: presetSummary, fields: presetFields },
  [CMD.WRITE_ACK]: { name: 'acknowledgement', fields: (p) => [u32f(p, 'command', 0, (v) => `0x${hex32(v)}${KNOWN[v] ? ` (${KNOWN[v].name})` : ''}`), u32f(p, 'status', 4), slotf(p, 'slot', 8), ...rest(p, 12)] },
  [CMD.PRESET_LIST]: { name: 'preset list', fields: (p) => {
    if (p.length < 600 + 17 * PRESET_COUNT) return rest(p, 0);
    const names = Array.from({ length: PRESET_COUNT }, (_, i) => strf(p, presetLabel(i), 600 + 17 * i, 17));
    return [F('u16 order[300]', 0, 600, Array.from({ length: 8 }, (_, i) => u16(p, 2 * i)).join(' ') + ' …'),
      F('char name[300][17]', 600, 5100, '', names), ...rest(p, 5700, 'unknown (300 × 80 B?)')];
  } },
  [CMD.CURRENT_SCENE]: { name: 'current scene', fields: (p) => (p.length ? [F('scene', 0, Math.min(4, p.length), `${p[0] + 1}`)] : []) },
  // The pedal sets this flag when the current preset is modified – also by another program. Changes sent by
  // the Hotone software (e.g. 01090001 volume, 01090002 tempo) are NOT forwarded: a MIDI listener only sees
  // this flag once (0 -> 1); the values themselves are only in a USB capture (debug/chain-changes.pcapng).
  [CMD.PRESET_CHANGED]: { name: 'preset changed flag', fields: (p) => [u32f(p, 'changed', 0,
    (v) => (v ? '1 = current preset modified (changes by another program are not forwarded – see a USB capture)' : '0 = saved / unchanged'))] },
  [CMD.FIRMWARE_VERSION]: { name: 'firmware version', fields: (p) => [strf(p, 'version', 0, p.length)] },
  [CMD.INPUT_LEVEL]: { name: 'input level meter' },
  [CMD.OUTPUT_LEVEL]: { name: 'output level meter' },
  [CMD.USER_IR_NAMES]: { name: 'user IR names', fields: (p) => [F('char name[50][32]', 0, p.length, '',
    Array.from({ length: Math.floor(p.length / 32) }, (_, i) => strf(p, `IR ${i + 1}`, 32 * i, 32)))] },
  [CMD.PRESET_SAVED]: { name: 'preset saved on the pedal' },
  [CMD.NAME_EDIT]: { name: 'name editor (0 open / 1 closed?)', fields: (p) => [u32f(p, 'value', 0)] },
  0x01030000: { name: 'footswitch functions (get)', fields: (p) => (p.length >= 8 ? sectionFields(p, 3, 0, p.length, 0) : [F('click[3]', 0, 3, hexBytes(p.subarray(0, 3))), ...rest(p, 3, 'rest')]) },
  0x01030001: { name: 'footswitch functions (set)', fields: (p) => [F('click[3]', 0, 3, hexBytes(p.subarray(0, 3))), ...rest(p, 3)] },
  0x01070001: { name: 'ctrl: footswitch → slots (set) [setCtrlSetting]', fields: (p) => [F('footswitch', 0, 1, `${p[0] + 1}`), F('ctrlTargetSlot[12]', 1, 12, hexBytes(p.subarray(1, 13))), ...rest(p, 13)] },
  0x01090001: { name: 'scene volume [setVol]', fields: struct([['scene', 'scene', 2], ['volume', 'u16']]) },
  0x01090002: { name: 'scene tempo (BPM) [setBpmWithInt]', fields: struct([['scene', 'scene', 2], ['tempo', 'u16']]) },
  0x01090004: { name: 'slot on/off states [setCurretAlgStateWithScene]', fields: (p) => [F('scene', 0, 1, `${p[0] + 1}`), F('on[12]', 1, 12, hexBytes(p.subarray(1, 13))), ...rest(p, 13)] },
  // pushed by the pedal after an algorithm change (debug: captures/wine-edit-2026-11-17.txt): new slot contents
  0x01040004: { name: 'slot state (pushed after algorithm change)', fields: (p) => {
    const f = struct([['slot', 'u32'], ['category', 'u32'], ['on', 'u32'], ['model (alg code)', 'u32'], ['params', 'f32s']])(p);
    if (p.length >= 16) f[1].value += ` = ${CATEGORIES[rd32(p, 4)] ?? '?'}`, f[3].value = algName(rd32(p, 12));
    return f;
  } },
  0x02000003: { name: 'select chain template [setEffectData]', fields: (p) => [u32f(p, 'template', 0, (v) => `${v} = ${CHAIN_MODES[v]?.name ?? '?'}`), ...rest(p, 4)] },
  0x02000004: { name: 'user chain templates (list) [getUserTemplateList]', fields: (p) => [F('templates', 0, p.length, '',
    Array.from({ length: Math.floor(p.length / 12) }, (_, i) => strf(p, `template ${i + 1}`, 12 * i, 12)))] },
  0x02000000: { name: 'chain template data', fields: (p) => [u32f(p, 'template', 0, (v) => `${v} = ${CHAIN_MODES[v]?.name ?? '?'}`), ...rest(p, 4, 'data')] },
  0x05000000: { name: 'save current preset into slot [savePreset]', fields: (p) => [slotf(p, 'slot', 0), strf(p, 'name', 4, 17), ...rest(p, 21)] },
  0x010a0003: { name: 'slot time / DSP load [getSlotTimeData]', fields: struct([['slot', 'u32'], ['time (answer)', 'f32']]) },
  0x0300000a: { name: 'algorithm times [requestAlgTimes]' },
  0x08000003: { name: 'NAM list [getNamList]' },
  0x07000003: { name: 'tone catch (clone) list [getToneCatchList]' },
  0x00070000: { name: 'control settings (get)' },

  // ---- from the Hotone app (decompiled Android app); layouts from its field maps, not all confirmed
  // global settings
  0x00010000: { name: 'input / output settings (get)' },
  0x00020000: { name: 'USB audio settings (get)' },
  0x00030000: { name: 'global EQ (get)' },
  0x00030001: { name: 'global EQ on/off [setEQSwitch] (app)', fields: struct([['value', 'u32']]) },
  0x00030002: { name: 'global EQ value [setEQValue] (app)', fields: struct([['index', 'u32'], ['value', 'f32']]) },
  0x00030003: { name: 'global EQ output [setOutPut] (app)', fields: struct([['value', 'u32']]) },
  0x00030004: { name: 'global EQ reset (app)' },
  0x00060000: { name: 'MIDI settings (get)' },
  0x00070005: { name: 'control setting (app)', fields: struct([['value', 'u32']]) },
  0x00070006: { name: 'global control value [setGlobalControlValue] (app)' },
  0x00070007: { name: 'global tempo [setBpmWithInt] (app)', fields: struct([['bpm', 'u32']]) },
  0x00080000: { name: 'display / control settings (get)' },
  0x000a0000: { name: 'drum machine (get)' },
  0x000a0001: { name: 'drum sync [setDrumSync] (app)', fields: struct([['sync', 'u32']]) },
  0x000a0002: { name: 'drum volume [setDrumVolume] (app)', fields: struct([['volume', 'u32']]) },
  0x000a0003: { name: 'drum BPM [setDrumBMP] (app)', fields: struct([['bpm', 'u32']]) },
  0x000a0004: { name: 'drum style [setDrumStyle] (app)', fields: struct([['style', 'u32']]) },
  0x000a0005: { name: 'drum play state [setDrumState] (app)', fields: struct([['state', 'u32']]) },
  // preset: info, quick knobs, effect slots
  0x01010000: { name: 'preset info [addPatchRemark] (app)', fields: struct([['preset', 'preset'], ['version', 'u32'],
    ['name', 'str', 17], ['author', 'str', 20], ['info', 'str', 50], ['style', 'str', 10]]) },
  0x01010001: { name: 'rename preset [presetRename] (app)', fields: struct([['preset', 'preset'], ['name', 'str', 17]]) },
  0x01010003: { name: 'preset style [patchBindStyle] (app)', fields: struct([['preset', 'preset'], ['style', 'str', 10]]) },
  0x01020001: { name: 'quick knob [setQKnobTarget/Param] (app)', fields: struct([['knob', 'u8'], ['target slot', 'u8'],
    ['mode', 'u8'], ['effect (alg code)', 'u32'], ['param', 'u8']]) },
  0x01040001: { name: 'reorder effect chain [effectChainReorder]', fields: struct([['sequence[12]', 'bytes', 12]]) },
  0x01040002: { name: 'set / delete slot algorithm [setCurretAlgWithMsg]', fields: (p) => {
    const f = struct([['slot', 'u8'], ['category', 'u8'], ['model (alg code)', 'u32'], ['on', 'u8']])(p);
    if (p.length >= 6) f[1].value += ` = ${CATEGORIES[p[1]] ?? '?'}`, f[2].value = algName(rd32(p, 2));
    return f;
  } },
  0x01040003: { name: 'effect parameter [algKnobChangeValue]', fields: struct([['slot', 'u16'], ['param (Widget.ID)', 'u16'], ['value', 'f32']]) },
  // preset: routing (Temp section)
  0x01050001: { name: 'routing: input source [setInputSource] (app)', fields: struct([['chain', 'u16'], ['source', 'u16']]) },
  0x01050002: { name: 'routing: output source [setOutputSource] (app)', fields: struct([['chain', 'u16'], ['source', 'u16']]) },
  0x01050003: { name: 'routing: input parameter [setInputSourceParam] (app)', fields: struct([['chain', 'u16'], ['param', 'u16'], ['value', 'f32']]) },
  0x01050004: { name: 'routing: output parameter [setOutputSourceParam] (app)', fields: struct([['chain', 'u16'], ['param', 'u16'], ['value', 'f32']]) },
  0x01050005: { name: 'routing: split position [setSplitNodeAddr] (app)', fields: struct([['position', 'u32']]) },
  0x01050006: { name: 'routing: mixer position [setMixNodeAddr] (app)', fields: struct([['position', 'u32']]) },
  0x01050007: { name: 'routing: split mode [setSplitMode] (app)', fields: struct([['mode', 'u32']]) },
  0x01050009: { name: 'routing: split parameter [setSplitNodeParam] (app)', fields: struct([['param', 'u32'], ['value', 'f32']]) },
  0x0105000a: { name: 'routing: mixer parameter [setMixNodeParam] (app)', fields: struct([['param', 'u32'], ['value', 'f32']]) },
  // preset: expression pedal, ctrl, scenes, MIDI
  0x01060002: { name: 'expression target [setExpTarget/CtrlParam] (app)', fields: struct([['exp', 'u8'], ['target #', 'u8'],
    ['target slot', 'u8'], ['mode', 'u8'], ['effect (alg code)', 'u32'], ['param', 'u8']]) },
  0x01060003: { name: 'expression range [setExpRange] (app)', fields: struct([['exp', 'u16'], ['target #', 'u16'], ['min', 'f32'],
    ['max', 'f32'], ['curve', 'f32'], ['autoOff', 'f32'], ['offTime', 'f32']]) },
  0x01070000: { name: 'ctrl settings (get)' },
  0x01090005: { name: 'slot parameters [_restoreSlotParams] (app)', fields: struct([['slot', 'u16'], ['algID', 'u16'], ['params', 'f32s']]) },
  0x01090007: { name: 'scene name [setSceneName]', fields: struct([['scene', 'scene', 4], ['name', 'str', 8]]) },
  0x010a0002: { name: 'slot data [parseSlotData] (app)', fields: (p) => {
    const f = struct([['slot', 'u16'], ['category', 'u8'], ['state', 'u8'], ['alg', 'u32'], ['params', 'f32s']])(p);
    if (p.length >= 8) f[1].value += ` = ${CATEGORIES[p[2]] ?? '?'}`, f[3].value = algName(rd32(p, 4));
    return f;
  } },
  0x010b0001: { name: 'footswitch MIDI [setFSMidiParam] (app)', fields: struct([['fs', 'u32'], ['id', 'u32'], ['data', 'bytes']]) },
  0x010b0002: { name: 'patch MIDI [setPatchMidiParam] (app)', fields: struct([['id', 'u32'], ['data', 'bytes']]) },
  // chain templates, IRs, system, clone / NAM
  0x02000002: { name: 'save user chain template [setUserTmplate] (app)', fields: struct([['template', 'u32'], ['name', 'str', 12]]) },
  0x04000000: { name: 'import user IR [beginImportIR] (app)', fields: struct([['IR', 'u32'], ['name', 'str', 32], ['data', 'bytes', 8192], ['checksum', 'u16']]) },
  0x04000001: { name: 'delete user IR [deleteUserIr] (app)', fields: struct([['IR', 'u32']]) },
  0x04000002: { name: 'rename user IR [renameUserIr] (app)', fields: struct([['IR', 'u32'], ['name', 'str', 32]]) },
  0x05000001: { name: 'delete preset [deletePreset] (app)', fields: struct([['preset', 'preset']]) },
  0x05000004: { name: 'move preset [onReorder] (app)', fields: struct([['to', 'preset'], ['from', 'preset']]) },
  0x05000006: { name: 'factory reset (app)', fields: struct([['type', 'u32'], ['value', 'u32']]) },
  0x05000007: { name: 'device name (app)', fields: struct([['name', 'str', 17]]) },
  0x05000016: { name: 'cancel listener [cancelListener]' },
  0x07000000: { name: 'tone catch (clone) import / export (app)', fields: struct([['id / refresh', 'u32'], ['data', 'bytes']]) },
  0x07000001: { name: 'delete tone catch (clone) (app)', fields: struct([['id', 'u32']]) },
  0x07000002: { name: 'rename tone catch (clone) (app)', fields: struct([['id', 'u32'], ['name', 'str', 16]]) },
  0x08000000: { name: 'import NAM model [importNam] (app)', fields: struct([['refresh', 'u32'], ['data', 'bytes']]) },
  0x08000001: { name: 'delete NAM model [deleteNam] (app)', fields: struct([['id', 'u32']]) },
  0x08000002: { name: 'rename NAM model [renameNam] (app)', fields: struct([['id', 'u32'], ['name', 'str', 16]]) },
};

/**
 * Command groups of the firmware: table in the ARM image (V2.5.0, section 0 at 0xe429c), one u32 per group:
 * high 16 bits = group, low 16 bits = number of commands (codes group·0000 … group·(count-1)).
 * Names: from captures and from the Hotone app's functions that send them (decompiled Android app).
 */
export const COMMAND_GROUPS = [
  [0x0000, 1, 'global ?'], [0x0001, 19, 'global input / output settings (pushed at power-on)'],
  [0x0002, 10, 'USB audio settings'], [0x0003, 5, 'global EQ'], [0x0004, 3, 'global ?'], [0x0005, 7, 'global ?'],
  [0x0006, 12, 'MIDI settings'], [0x0007, 8, 'control settings, global tempo'],
  [0x0008, 14, 'display / system (0008000a, name editor 00080003)'],
  [0x0009, 1, 'current preset'], [0x000a, 7, 'drum machine'],
  [0x0100, 2, 'preset (dump / write)'], [0x0101, 5, 'preset info (name, author, style)'], [0x0102, 2, 'quick knobs'],
  [0x0103, 2, 'footswitches'], [0x0104, 5, 'effect slots (algorithm, parameter, order)'], [0x0105, 12, 'routing (split / mixer)'],
  [0x0106, 5, 'expression pedal'], [0x0107, 2, 'ctrl: footswitch → slots'], [0x0108, 2, 'preset list'],
  [0x0109, 9, 'scenes (volume, tempo, slot on/off, slot parameters, name)'], [0x010a, 4, 'slot data / times'],
  [0x010b, 3, 'preset MIDI'],
  [0x0200, 5, 'chain templates'], [0x0300, 11, 'runtime state (scene, changed, firmware, meters)'],
  [0x0400, 4, 'user IRs'], [0x0500, 28, 'system (save, delete, move, connect, …)'], [0x0700, 4, 'tone catch (clone)'],
  [0x0800, 4, 'NAM models'],
];

/** Group of a command code from the firmware table, or null. */
export function commandGroup(cmd) {
  if (cmd === undefined) return null;
  const hi = cmd >>> 16, lo = cmd & 0xffff;
  const g = COMMAND_GROUPS.find(([grp]) => grp === hi);
  return g && lo < g[1] ? { group: hi, count: g[1], name: g[2] } : null;
}

/** {name, known, summary, fields} for an entry. */
export function describe(e) {
  if (e.type === 'other') return { name: e.what, known: true, summary: hexBytes(e.frames[0].bytes, 16), fields: [] };
  if (e.type === 'damaged' || (e.type === 'error' && e.cmd === undefined)) {
    return { name: e.error, known: false, summary: hexBytes(e.frames[0].bytes, 16), fields: [] };
  }
  const k = KNOWN[e.cmd];
  const p = e.payload;
  let fields = [];
  try {
    fields = k?.fields ? k.fields(p, e) : p.length ? rest(p, 0, 'payload') : [];
  } catch (err) {
    fields = [F(`decoder error: ${err.message}`, 0, p.length)];
  }
  const leaf = (fs) => fs.flatMap((f) => (f.children?.length ? leaf(f.children) : [f]));
  let custom = '';
  try {
    custom = k?.summary ? k.summary(p) : '';
  } catch { /* fall back */ }
  const summary = e.error ? e.error : custom || leaf(fields).filter((f) => f.value).slice(0, 3).map((f) => `${f.name}: ${f.value}`).join(' · ') ||
    (p.length ? `${p.length} B` : '');
  const g = commandGroup(e.cmd);
  const name = k?.name ?? (g ? `unknown (${g.name} group, #${e.cmd & 0xffff} of ${g.count})` : 'unknown – not in the firmware\'s command table');
  return { name, known: !!k, summary, fields };
}
