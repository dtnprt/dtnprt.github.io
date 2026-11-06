// Sniffer logic: read captures (live MIDI, app traces, Wireshark/USBPcap .pcapng), reassemble the SysEx
// transfers of both directions and describe them as fields with byte ranges (for the hex view).

import {
  CHAIN_MODES, CMD, MODULES, PRESET_COUNT, cString, decodeStream, parseFrame, presetChainMode, presetInfo, presetLabel,
  presetRouting, rd32,
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

const TLV_NAMES = { 0: 'header', 1: 'info', 2: 'tag 2', 3: 'footswitch', 4: 'slots', 5: 'scenes', 6: 'routing',
  7: 'tag 7', 8: 'ctrl / fs slots', 9: 'midi' };

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
    if (tag === 1 && len >= 101) {
      ch.push(u32f(p, 'version', d), strf(p, 'name', d + 4, 17), F('unknown', d + 21, 70, hexBytes(p.subarray(d + 21, d + 91), 8)),
        strf(p, 'style', d + 91, 10));
    } else if (tag === 3 && len >= 3) {
      ch.push(F('fs_func[3]', d, 3, hexBytes(p.subarray(d, d + 3))), ...(len > 3 ? [F('rest', d + 3, len - 3, hexBytes(p.subarray(d + 3, d + len)))] : []));
    } else if (tag === 4 && len >= 72) {
      const algs = [];
      for (let s = 0; s < 12; s++) {
        const c = rd32(p, d + 24 + 4 * s);
        algs.push(F(`slot ${s + 1}`, d + 24 + 4 * s, 4, c === 0xffffffff ? 'empty' : `${MODULES[c >>> 24] ?? '?'} 0x${hex32(c)}`));
      }
      ch.push(F('order[12] (position → slot)', d, 12, Array.from(p.subarray(d, d + 12)).join(' ')),
        F('chain[12]', d + 12, 12, hexBytes(p.subarray(d + 12, d + 24))), F('alg[12]', d + 24, 48, '', algs));
    } else if (tag === 5 && len >= 3636) {
      const on = [0, 1, 2].map((s) => F(`scene ${s + 1} on[12]`, d + 3600 + 12 * s, 12,
        Array.from(p.subarray(d + 3600 + 12 * s, d + 3612 + 12 * s), (b) => (b ? '1' : '0')).join('')));
      const names = [0, 1, 2].map((s) => strf(p, `scene ${s + 1} name`, d + len - 24 + 8 * s, 8));
      ch.push(F('parameters', d, 3600, '12 slots × 25 floats per scene …'), F('slot on/off', d + 3600, 36, '', on),
        F('more', d + 3636, len - 3636 - 24, ''), F('scene names', d + len - 24, 24, '', names));
    } else if (tag === 6 && len >= 458) {
      const r = presetRouting(p.subarray(base));
      const pos = (v) => (v === 0xff ? 'none' : v === 6 ? 'end of row 1' : `before row-1 position ${v + 1}`);
      ch.push(F('routing', d + 2, 456, `${r.name}${r.template ? ' (template)' : ''}`, [
        F('bytes 2 / 4 / 6 (meaning unknown)', d + 2, 5, [2, 4, 6].map((k) => hex2(p[d + k])).join(' ')),
        F('split', d + 456, 1, pos(p[d + 456])),
        F('merge', d + 457, 1, pos(p[d + 457])),
      ]));
    } else if (len) {
      ch.push(F('data', d, len, hexBytes(p.subarray(d, d + len), 16)));
    }
    out.push(F(`tag ${tag} – ${TLV_NAMES[tag] ?? '?'}`, o, 8 + len, `${len} B`, ch));
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

/** Known commands: name + decoder (payload, entry) -> fields. */
export const KNOWN = {
  [CMD.CONNECT]: { name: 'connect' },
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
  0x01030000: { name: 'footswitch functions (get)', fields: (p) => [F('fs_func[3]', 0, 3, hexBytes(p.subarray(0, 3))), ...rest(p, 3, 'rest')] },
  0x01030001: { name: 'footswitch functions (set)', fields: (p) => [F('fs_func[3]', 0, 3, hexBytes(p.subarray(0, 3))), ...rest(p, 3)] },
  0x01070001: { name: 'footswitch → slots (set)', fields: (p) => [F('footswitch', 0, 1, `${p[0] + 1}`), F('slot_on[12]', 1, 12, hexBytes(p.subarray(1, 13))), ...rest(p, 13)] },
  0x01090001: { name: 'patch volume', fields: (p) => [F('u16 ?', 0, 2, `${u16(p, 0)}`), F('volume', 2, 2, `${u16(p, 2)}`), ...rest(p, 4)] },
  0x01090002: { name: 'patch tempo (BPM)', fields: (p) => [F('u16 ?', 0, 2, `${u16(p, 0)}`), F('tempo', 2, 2, `${u16(p, 2)}`), ...rest(p, 4)] },
  0x01090004: { name: 'slot on/off states', fields: (p) => [F('scene', 0, 1, `${p[0] + 1}`), F('on[12]', 1, 12, hexBytes(p.subarray(1, 13))), ...rest(p, 13)] },
  0x01040004: { name: 'slot state', fields: (p) => [u32f(p, 'slot', 0, (v) => `${v + 1}`), u32f(p, 'category', 4), u32f(p, 'on', 8), u32f(p, 'model', 12, (v) => `0x${hex32(v)}`), ...rest(p, 16)] },
  0x02000003: { name: 'select chain template', fields: (p) => [u32f(p, 'template', 0, (v) => `${v} = ${CHAIN_MODES[v]?.name ?? '?'}`), ...rest(p, 4)] },
  0x02000004: { name: 'user chain templates (list)', fields: (p) => [F('templates', 0, p.length, '',
    Array.from({ length: Math.floor(p.length / 12) }, (_, i) => strf(p, `template ${i + 1}`, 12 * i, 12)))] },
  0x02000000: { name: 'chain template data', fields: (p) => [u32f(p, 'template', 0, (v) => `${v} = ${CHAIN_MODES[v]?.name ?? '?'}`), ...rest(p, 4, 'data')] },
  0x05000000: { name: 'save current preset into slot', fields: (p) => [slotf(p, 'slot', 0), strf(p, 'name', 4, 17), ...rest(p, 21)] },
  0x010a0003: { name: 'slot time / DSP load (?)' },
  0x0300000a: { name: 'algorithm times (?)' },
  0x08000003: { name: 'clone / NAM names (?)' },
  0x07000003: { name: 'name list (?)' },
  0x00070000: { name: 'global settings (?)' },
};

/**
 * Command groups of the firmware: table in the ARM image (V2.5.0, section 0 at 0xe429c), one u32 per group:
 * high 16 bits = group, low 16 bits = number of commands (codes group·0000 … group·(count-1)).
 * Names: what is known about the group from captures; 01xx follow the preset's TLV tags.
 */
export const COMMAND_GROUPS = [
  [0x0000, 1, 'global ?'], [0x0001, 19, 'global settings (pushed at power-on)'], [0x0002, 10, 'global ?'],
  [0x0003, 5, 'global ?'], [0x0004, 3, 'global ?'], [0x0005, 7, 'global ?'], [0x0006, 12, 'global ?'],
  [0x0007, 8, 'global settings (00070000)'], [0x0008, 14, 'global / system (0008000a, name editor 00080003)'],
  [0x0009, 1, 'current preset'], [0x000a, 7, 'global ?'],
  [0x0100, 2, 'preset (dump / write)'], [0x0101, 5, 'preset info (tag 1: name, style)'], [0x0102, 2, 'preset tag 2'],
  [0x0103, 2, 'preset footswitches (tag 3)'], [0x0104, 5, 'preset slots (tag 4)'], [0x0105, 12, 'preset scenes (tag 5)'],
  [0x0106, 5, 'preset routing (tag 6)'], [0x0107, 2, 'preset tag 7 / FS → slots'], [0x0108, 2, 'preset list'],
  [0x0109, 9, 'scene parameters (volume, tempo, slot on/off)'], [0x010a, 4, 'slot times / DSP load'], [0x010b, 3, 'preset ?'],
  [0x0200, 5, 'chain templates'], [0x0300, 11, 'runtime state (scene, changed, firmware, meters)'],
  [0x0400, 4, 'user IRs'], [0x0500, 28, 'system (save, connect, …)'], [0x0700, 4, 'name list ?'], [0x0800, 4, 'clone / NAM'],
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
