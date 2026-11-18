// Ampero II Stomp USB-MIDI SysEx protocol (see tools/FORMAT.md, chapter 6).
//
// Frame:  F0 21 25 4D 50 00 00 | cs | kind | totLo totHi | offLo offHi | nibbles … | F7
// Stream: u32 cmd | u32 len | data[len]   (data = LZO1X-1 stream, empty if len = 0)
//
// Field names of the Hotone app (Dart, bluetooth/trans.dart HeadDataMap): ManufactID1 21, ManufactID2 25,
// productID "MP", serId 00, resv 00, moduleCode (= cs), transType (= kind), totalLenL/H, offSetL/H;
// stream = CmdCode, dataLen, data.

import * as lzo from './lzo1x.js';

export const HEADER = Uint8Array.of(0xf0, 0x21, 0x25, 0x4d, 0x50, 0x00, 0x00);
export const KIND_GET = 0x11;
export const KIND_SET = 0x12;
export const KIND_ERROR = 0x13; // transType 0x13 = TransErrorStatus (seen in the app's Bluetooth path)
export const CHUNK = 183; // stream bytes per frame sent by the editor (captured); the device sends 185
const RX_CHUNKS = [183, 185];

/** Short frame the editor sends 5x every 200 ms after CONNECT; the device answers only afterwards. */
export const HANDSHAKE = Uint8Array.of(0xf0, 0x21, 0x25, 0x7f, 0x4d, 0x50, 0x01, 0x2c,
  0x11, 0x00, 0x00, 0x38, 0x00, 0x0e, 0x04, 0xf7);

export const CMD = {
  CONNECT: 0x05000017,
  CURRENT_PRESET: 0x00090000, // u32 index (get / select)
  PRESET_DUMP: 0x01000000, // get: u32 index -> u32 index + TLV preset
  PRESET_LIST: 0x01080000, // u16 order[300], char name[300][17], …
  CURRENT_SCENE: 0x03000001,
  PRESET_CHANGED: 0x03000003, // pushed by the pedal before it pushes the dump of a saved preset
  PRESET_SAVED: 0x05000012, // pushed after a preset was saved on the pedal (empty payload)
  NAME_EDIT: 0x00080003, // pushed around renaming on the pedal (0, then 1) - meaning assumed
  FIRMWARE_VERSION: 0x03000005,
  INPUT_LEVEL: 0x03000006,
  OUTPUT_LEVEL: 0x03000007,
  USER_IR_NAMES: 0x04000003,
  // Restore (debug/start-software-and-restore.pcapng: the editor imports "A99-1-Le Chug.prst" into A93-3):
  //   host -> PRESET_WRITE (kind 0x12): u32 slot + TLV preset (5068 B), 4 frames ~40 ms apart
  //   dev  -> WRITE_ACK    (kind 0x12): u32 0x01000001, u32 1, u32 slot   (~370 ms later)
  // then the editor reads the slot back with PRESET_DUMP.
  PRESET_WRITE: 0x01000001,
  WRITE_ACK: 0x06000000,
  // Edit commands (Hotone app functions; confirmed with captures/wine-edit-2026-11-17.txt, kind 0x12, no answer):
  PARAM: 0x01040003, // u16 slot, u16 param (Widget.ID), f32 value - current scene only
  SET_ALG: 0x01040002, // u8 slot, u8 category, u32 alg code, u8 on - resets the slot in all scenes
  REORDER: 0x01040001, // u8 seq[12]
  SLOT_ON: 0x01090004, // u8 scene, u8 on[12]
  SCENE_NAME: 0x01090007, // u32 scene, char name[8]
  SAVE: 0x05000000, // u32 preset, char name[17]
  SLOT_PUSH: 0x01040004, // pushed after SET_ALG: u32 slot, u32 category, u32 on, u32 alg, f32 params[25]
  // Uploads (captures/wine-upload-nam-ir-2026-11-17.txt), both acknowledged with WRITE_ACK [cmd, 1, index]:
  IR_UPLOAD: 0x04000000, // u32 30 + slot, char name[32], i32 samples[2048], u16 byte sum
  NAM_UPLOAD: 0x08000000, // u32 byte sum, u32 slot, char name[16], u32 0, u32 1, NAMB file
  NAM_LIST: 0x08000003, // char name[30][17] + 30 bytes
  // Pushed by the pedal when it changes the routing itself (e.g. after a block was inserted – trace
  // data/ampero_trace_2026-11-17-22-20-34.txt): i16 inputSource[2], i16 outputSource[2], u8 split, u8 mixer, 2 bytes
  ROUTING_PUSH: 0x0105000b,
  SPLIT_PARAM: 0x01050009, // u32 index, f32 value (split node parameter; also pushed by the pedal)
  MIX_PARAM: 0x0105000a, // u32 index, f32 value (mixer node parameter)
  // From the Hotone app, not confirmed by a capture yet (tools/FORMAT.md 6.4, status A):
  SCENE_VOLUME: 0x01090001, // u16 scene, u16 volume (confirmed)
  SCENE_TEMPO: 0x01090002, // u16 scene, u16 bpm (confirmed)
  PRESET_DELETE: 0x05000001, // u32 preset
  PRESET_MOVE: 0x05000004, // u32 to, u32 from
  IR_DELETE: 0x04000001, // u32 IR number (30 + slot)
  IR_RENAME: 0x04000002, // u32 IR number, char name[32]
  NAM_DELETE: 0x08000001, // u32 slot
  NAM_RENAME: 0x08000002, // u32 slot, char name[16]
};

export const WRITE_CONFIRMED = true;

export const PRESET_COUNT = 300;

export const hex32 = (v) => '0x' + (v >>> 0).toString(16).padStart(8, '0');

export function u32le(v) {
  return Uint8Array.of(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}

export function rd32(b, o = 0) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

export function concat(...parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Build the SysEx frames for one transfer (identical to the editor / ampero_sysex.py encode). */
export function encodeTransfer(cmd, payload = new Uint8Array(0), kind = KIND_SET) {
  const data = payload.length ? lzo.compress(payload) : new Uint8Array(0);
  const stream = concat(u32le(cmd), u32le(data.length), data);
  const tot = stream.length;
  if (tot >= 1 << 14) throw new Error(`stream too long for one transfer (${tot} bytes)`);
  const frames = [];
  for (let off = 0; off < tot; off += CHUNK) {
    const part = stream.subarray(off, off + CHUNK);
    const f = new Uint8Array(14 + 2 * part.length);
    f.set(HEADER, 0);
    let sum = 0;
    for (let i = 0; i < part.length; i++) {
      const hi = part[i] >> 4, lo = part[i] & 0x0f;
      f[13 + 2 * i] = hi;
      f[14 + 2 * i] = lo;
      sum += hi + lo;
    }
    f[7] = sum & 0x7f;
    f[8] = kind;
    f[9] = tot & 0x7f;
    f[10] = tot >> 7;
    f[11] = off & 0x7f;
    f[12] = off >> 7;
    f[f.length - 1] = 0xf7;
    frames.push(f);
  }
  return frames;
}

/**
 * Parse one frame. Returns null for foreign messages, {damaged: true, …} for an Ampero frame whose length
 * does not match its header: on Windows/Web MIDI about 1 % of the device's frames arrive with 1–5 bytes
 * missing (debug/ampero_trace_2026-11-06-08-06-00.txt). A missing byte always shortens the frame, so the
 * length check catches it. The checksum (byte 7) is not checked: the Hotone editor checks device frames with
 * the same rule as host frames (sum of nibbles & 0x7F, HTUSBTools.dll RVA 0xce1fa) but the pedal follows another,
 * unknown rule – the editor only logs "crc fail != crcFlag" and uses the frame anyway.
 */
export function parseFrame(m) {
  if (m.length < 14 || m[m.length - 1] !== 0xf7) return null;
  for (let i = 0; i < HEADER.length; i++) if (m[i] !== HEADER[i]) return null;
  const total = m[9] | (m[10] << 7), offset = m[11] | (m[12] << 7);
  const nib = m.length - 14;
  const n = nib / 2, rest = total - offset;
  if (offset >= total || (nib & 1) || n > rest || (n < rest && !RX_CHUNKS.includes(n))) {
    return { damaged: true, kind: m[8], total, offset, length: m.length };
  }
  const data = new Uint8Array(nib / 2);
  for (let i = 0; i < data.length; i++) data[i] = (m[13 + 2 * i] << 4) | (m[14 + 2 * i] & 0x0f);
  return { kind: m[8], total, offset, data };
}

export class DamagedFrameError extends Error {}

/** Decode a complete stream -> {cmd, kind, payload} (payload decompressed). */
export function decodeStream(s, kind) {
  if (s.length < 8) throw new Error('stream too short');
  const cmd = rd32(s, 0);
  const len = rd32(s, 4);
  if (8 + len > s.length) throw new Error(`stream ${hex32(cmd)}: length ${len} > ${s.length - 8}`);
  const payload = len ? lzo.decompress(s.subarray(8, 8 + len)) : new Uint8Array(0);
  return { cmd, kind, payload };
}

/**
 * Collects frames into transfers. Frames carry only (total, offset) – the cmd is in the first frame –
 * so frames of different transfers can only be told apart by those two numbers:
 *  - a transfer that fits into one frame is decoded on its own (it may arrive between the frames of a
 *    multi-frame answer);
 *  - several multi-frame transfers may be open at the same time (the device can push a transfer of its
 *    own while answering a request); a frame goes to the open transfer with the same total whose fill
 *    equals the frame's offset. If more than one transfer fits, the result is ambiguous: it is still
 *    decoded, but marked `ambiguous` (callers validate the payload and retry).
 */
export class Reassembler {
  constructor(onTransfer, onError = () => {}) {
    this.onTransfer = onTransfer;
    this.onError = onError;
    this.open = []; // [{cmd, total, kind, data, fill, t, ambiguous}]
  }

  get busy() {
    return this.open.length > 0;
  }

  _emit(data, kind, ambiguous) {
    const tr = decodeStream(data, kind);
    tr.ambiguous = ambiguous;
    this.onTransfer(tr);
  }

  push(m, now = performance.now()) {
    const fr = parseFrame(m);
    if (!fr) return false;
    this.open = this.open.filter((s) => now - s.t < 3000); // forget incomplete transfers
    if (fr.damaged) {
      // the transfer this frame belongs to cannot be completed: drop it (its remaining frames are then
      // reported as not fitting, which is harmless)
      const s = this.open.find((o) => o.total === fr.total && o.fill === fr.offset);
      if (s) this.open.splice(this.open.indexOf(s), 1);
      this.onError(new DamagedFrameError(`damaged frame (${fr.length} bytes, offset ${fr.offset}/${fr.total}` +
        (s ? `, drops ${hex32(s.cmd)}` : '') + ')'));
      return true;
    }
    try {
      if (fr.offset === 0 && fr.data.length === fr.total) {
        this._emit(fr.data, fr.kind, false);
        return true;
      }
      if (fr.offset === 0) {
        const s = { cmd: fr.data.length >= 4 ? rd32(fr.data, 0) : 0, total: fr.total, kind: fr.kind,
          data: new Uint8Array(fr.total), fill: 0, t: now, ambiguous: false };
        if (this.open.length) {
          this.onError(new Error(`transfer ${hex32(s.cmd)} (${s.total} B) starts while ` +
            this.open.map((o) => `${hex32(o.cmd)} ${o.fill}/${o.total}`).join(', ') + ' still open'));
        }
        this.open.push(s);
      }
      const fit = this.open.filter((s) => s.total === fr.total && s.fill === fr.offset &&
        s.fill + fr.data.length <= s.total);
      if (!fit.length) {
        this.onError(new Error(`frame offset ${fr.offset}/${fr.total} fits no open transfer (` +
          (this.open.map((o) => `${hex32(o.cmd)} ${o.fill}/${o.total}`).join(', ') || 'none') + ')'));
        return true;
      }
      const s = fit[0]; // oldest
      if (fit.length > 1) s.ambiguous = true;
      s.data.set(fr.data, s.fill);
      s.fill += fr.data.length;
      s.t = now;
      if (s.fill === s.total) {
        this.open.splice(this.open.indexOf(s), 1);
        this._emit(s.data, s.kind, s.ambiguous);
      }
    } catch (e) {
      this.onError(e);
    }
    return true;
  }
}

// ------------------------------------------------------------------ presets

/** Slot label as shown on the device: index 0 = A00-1, 299 = A99-3. */
export function presetLabel(i) {
  return `A${String(Math.floor(i / 3)).padStart(2, '0')}-${(i % 3) + 1}`;
}

export function cString(b, o, n) {
  let s = '';
  for (let i = 0; i < n && o + i < b.length && b[o + i]; i++) {
    const c = b[o + i];
    s += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '?';
  }
  return s;
}

/** Split a TLV preset ([u32 tag][u32 len][data]…). Throws if the chain is broken. */
export function tlvSplit(raw) {
  const out = [];
  let o = 0;
  while (o < raw.length) {
    if (o + 8 > raw.length) throw new Error(`TLV: truncated header at ${o}`);
    const tag = rd32(raw, o), len = rd32(raw, o + 4);
    if (o + 8 + len > raw.length) throw new Error(`TLV: tag ${tag} exceeds preset (${o}+${len})`);
    out.push({ tag, data: raw.subarray(o + 8, o + 8 + len) });
    o += 8 + len;
  }
  return out;
}

/**
 * Styles of the Hotone software ("Style" view / context menu), in its order. Stored as text in the info
 * block (tag 1, char style[10] at data offset 91). Verified for "Metal" (debug/LeChugMetal); the others are
 * assumed to be stored the same way. Empty = no style.
 */
export const STYLES = ['Rock', 'Metal', 'Pop', 'Blues', 'Country', 'Jazz', 'Fusion', 'Folk', 'Funk', 'Acoustic'];
const INFO_NAME = 4, NAME_LEN = 17, INFO_STYLE = 91, STYLE_LEN = 10;
export const MAX_NAME = NAME_LEN - 1;

/** Offset of the data of `tag` in a TLV preset. */
function tagOffset(raw, tag) {
  let o = 0;
  for (const t of tlvSplit(raw)) {
    if (t.tag === tag) return o + 8;
    o += 8 + t.data.length;
  }
  throw new Error(`TLV: tag ${tag} missing`);
}

function putString(out, off, len, text) {
  for (let i = 0; i < len; i++) out[off + i] = i < text.length ? text.charCodeAt(i) : 0;
}

/** Copy of the preset with a new name (ASCII, max 16 characters; rest of the field 0 like the pedal). */
export function setPresetName(raw, name) {
  if (!/^[\x20-\x7e]*$/.test(name)) throw new Error('only plain ASCII characters are allowed');
  if (name.length > MAX_NAME) throw new Error(`at most ${MAX_NAME} characters`);
  const out = raw.slice();
  putString(out, tagOffset(raw, 1) + INFO_NAME, NAME_LEN, name);
  return out;
}

/** Copy of the preset with a new style ('' = none). */
export function setPresetStyle(raw, style) {
  if (style.length >= STYLE_LEN) throw new Error('style too long');
  const out = raw.slice();
  putString(out, tagOffset(raw, 1) + INFO_STYLE, STYLE_LEN, style);
  return out;
}

/**
 * Preset sections (TLV tags) as the Hotone app builds them (HTModelPreset.getSendData, in this order):
 * 0 Setting, 1 Info, 2 Knob (quick knobs), 3 FS, 4 Effect, 5 Scene, 6 Temp (routing), 7 Exp, 8 Ctrl, 9 Midi.
 * Layouts: see tools/FORMAT.md chapter 3.
 */
export const TLV_SECTIONS = { 0: 'setting', 1: 'info', 2: 'quick knobs', 3: 'footswitches', 4: 'effect slots',
  5: 'scenes', 6: 'routing', 7: 'expression', 8: 'ctrl (FS → slots)', 9: 'midi' };

/**
 * Module category of a slot (tag 4: u8 mod[12]) = Catalog[].Index of the algorithm database
 * (verified against the alg codes of all sample presets). 0xFF = empty.
 */
export const CATEGORIES = ['DYN', 'FREQ', 'WAH', 'DRV', 'AMP', 'PRE AMP', 'CAB', 'IR', 'EQ', 'MOD', 'DLY', 'RVB',
  'FX SND', 'FX RTN', 'FX LOOP', 'VOL', 'CLONE', 'NAM'];

/** u32 alg[12] of the effect slots (tag 4 at data offset 24); 0xFFFFFFFF = empty. */
export function presetSlots(raw) {
  const o = tagOffset(raw, 4) + 24;
  return Array.from({ length: 12 }, (_, i) => rd32(raw, o + 4 * i));
}

/**
 * Number of scenes of a preset, from the length of tag 5: per scene f32[12][25] + u8 on[12] + u16 volume + u16 tempo
 * + char name[8] = 1224 bytes, plus 317 bytes of other data. Stomp: 3989 bytes = 3 scenes (confirmed). An Ampero II
 * Stage preset with 5 scenes would have 6437 bytes (derived, not confirmed with a Stage). Unknown lengths: 3.
 */
export const SCENE_BYTES = 1224;
const SCENE_EXTRA = 317;
export function presetSceneCount(raw) {
  try {
    const len = rd32(raw, tagOffset(raw, 5) - 4);
    const n = (len - SCENE_EXTRA) / SCENE_BYTES;
    return Number.isInteger(n) && n >= 1 && n <= 8 ? n : 3;
  } catch {
    return 3;
  }
}

/**
 * Signal chain as the Hotone software shows it: 12 positions (2 rows of 6, serial), position p holds
 * slot order[p] (tag 4: u8 order[12]); per scene the slot is on/off (tag 5 at data offset 3600:
 * u8 on[3][12] by slot, 0 = off). Verified with the software's screenshots of A00-1 and A99-1.
 * Returns [{pos, slot, code, on: [bool, bool, bool]}] (code 0xFFFFFFFF = empty position).
 */
export function presetChain(raw) {
  const t4 = tagOffset(raw, 4), t5 = tagOffset(raw, 5);
  return Array.from({ length: 12 }, (_, pos) => {
    const slot = raw[t4 + pos] < 12 ? raw[t4 + pos] : pos;
    const code = rd32(raw, t4 + 24 + 4 * slot);
    const n = presetSceneCount(raw);
    const on = Array.from({ length: n }, (_, s) => raw[t5 + 1200 * n + 12 * s + slot] !== 0);
    return { pos, slot, code, on };
  });
}

/**
 * Routing of the two rows (tag 6 "routing", data offsets 456 / 457):
 *   split = the signal splits before row-1 position k (0..6, 6 = after the last block), 0xFF = no split
 *   merge = the branches merge again before row-1 position k, 0xFF = no merge
 * Row 2 is the parallel branch: it starts at the split node (else it has its own input) and ends at the merge
 * node (else it has its own output). Serial = split at the end of row 1 and no merge: row 1 continues in row 2
 * and has no output of its own (bytes 2/4/6 = 05 02 00 there).
 * Verified with screenshots of the Hotone software: Sweet Dream 04/05, Dual Plexi 01/03, Tap Tap 03/04,
 * Ampero Strikes!/Le Chug (Serial); the five factory templates from debug/chain-changes.pcapng.
 * Bytes 2, 4, 6 also differ between templates. Names from the Hotone app (Temp section): i16 inputSource[2]
 * (bytes 0–3), i16 outputSource[2] (bytes 4–7) – so byte 2 = input source of row 2, bytes 4/6 = output source
 * of row 1/2 (values not decoded yet). 456 = splitNodeAddr, 457 = mixerNodeAddr.
 */
export const CHAIN_MODES = [
  { id: 0, name: 'Parallel', sig: [0x06, 0x00, 0x03, 0xff, 0xff] },
  { id: 1, name: 'Split → Mix', sig: [0x06, 0x00, 0x03, 0x00, 0x06] },
  { id: 2, name: 'A/B → Y', sig: [0x00, 0x00, 0x03, 0xff, 0x06] },
  { id: 3, name: 'Y → A/B', sig: [0x06, 0x00, 0x00, 0x00, 0xff] },
  { id: 4, name: 'Serial', sig: [0x05, 0x02, 0x00, 0x06, 0xff] },
];
const MODE_BYTES = [2, 4, 6, 456, 457];

/**
 * {split, merge (position 0..6 or null), serial, template (CHAIN_MODES entry or null), name, bytes}
 */
export function presetRouting(raw) {
  const o = tagOffset(raw, 6);
  const bytes = MODE_BYTES.map((k) => raw[o + k]);
  const pos = (v) => (v <= 6 ? v : null);
  const split = pos(bytes[3]), merge = pos(bytes[4]);
  const serial = split === 6 && merge === null;
  const template = CHAIN_MODES.find((m) => m.sig.every((v, k) => v === bytes[k])) ?? null;
  const at = (k) => (k === 6 ? 'end' : `before ${k + 1}`);
  const name = template ? template.name : serial ? 'Serial'
    : [split !== null ? `split ${at(split)}` : 'two inputs', merge !== null ? `merge ${at(merge)}` : 'two outputs'].join(', ');
  return { split, merge, serial, template, name, bytes };
}

// Chain templates: 0x02000003 u32 id selects one (0..4 = CHAIN_MODES, 5 + n = user template n, confirmed for 0..4),
// 0x02000004 lists the user templates (char name[12] each), 0x02000002 u32 5 + n, char name[12] saves the current
// routing as user template n (from the Hotone app, not confirmed).
export const TEMPLATE = { SELECT: 0x02000003, SAVE: 0x02000002, LIST: 0x02000004, DATA: 0x02000000, USER_BASE: 5 };
const TEMP_LEN = 540; // routing section (tag 6)

/**
 * Copy of the preset with the routing of a template data record (0x02000000: u32 template, 12 bytes, then the
 * routing section like tag 6 – Hotone app: HTModelPreset.readTempDataSingle). Returns null for an unexpected record.
 */
export function applyTemplateData(raw, p) {
  if (p.length < 16 + TEMP_LEN) return null;
  const out = raw.slice();
  out.set(p.subarray(16, 16 + TEMP_LEN), tagOffset(raw, 6));
  return out;
}

export function parseTemplateList(p) {
  return Array.from({ length: Math.floor(p.length / 12) }, (_, i) => (p[12 * i] === 0xff ? '' : cString(p, 12 * i, 12)));
}

export function templateSavePayload(n, name) {
  const p = new Uint8Array(16);
  p.set(u32le(TEMPLATE.USER_BASE + n), 0);
  putString(p, 4, 12, name.slice(0, 11));
  return p;
}

/** Copy of the preset with the routing bytes of a factory template (what the pedal stores for it). */
export function applyTemplate(raw, mode) {
  const out = raw.slice();
  const o = tagOffset(raw, 6);
  MODE_BYTES.forEach((k, j) => {
    out[o + k] = mode.sig[j];
  });
  return out;
}

/** Copy of the preset with a routing push (CMD.ROUTING_PUSH) applied to tag 6. */
export function applyRoutingPush(raw, p) {
  if (p.length < 10) return raw;
  const out = raw.slice();
  const o = tagOffset(raw, 6);
  out.set(p.subarray(0, 8), o); // inputSource[2], outputSource[2]
  out[o + 456] = p[8]; // splitNodeAddr
  out[o + 457] = p[9]; // mixerNodeAddr
  return out;
}

/** Copy of the preset with a split (CMD.SPLIT_PARAM) or mixer (CMD.MIX_PARAM) node parameter. */
export function applyNodeParam(raw, cmd, p) {
  if (p.length < 8) return raw;
  const i = rd32(p, 0);
  if (i >= 10) return raw;
  const out = raw.slice();
  const o = tagOffset(raw, 6) + (cmd === CMD.SPLIT_PARAM ? 460 : 500) + 4 * i;
  out.set(p.subarray(4, 8), o);
  return out;
}

/** Kept for the sniffer: the template a preset matches, or {id: -1, name} with its routing. */
export function presetChainMode(raw) {
  const r = presetRouting(raw);
  return r.template ?? { id: -1, name: r.name, bytes: r.bytes };
}

/**
 * Module of an algorithm code (highest byte), see tools/FORMAT.md chapter 5. 0x06 also holds FX LOOP/SND/RTN
 * and – Ampero II Stage only – the Split Mixer (0x06000004–06); 0x01 also Global EQ 2 (0x0100004B, Stage).
 */
export const MODULES = {
  0x00: 'DYN', 0x01: 'EQ', 0x03: 'DRV', 0x04: 'MOD', 0x05: 'WAH', 0x06: 'VOL', 0x07: 'AMP', 0x08: 'PRE AMP',
  0x09: 'CAB', 0x0a: 'IR', 0x0b: 'DLY', 0x0c: 'RVB', 0x0e: 'FREQ', 0x0f: 'CLONE', 0x10: 'NAM',
};

/** Single algorithms with their own name (Stage-only codes from the Android app's database). */
export const SPECIAL_ALGS = {
  0x0100004b: 'Global EQ 2', 0x06000004: 'Split (Mode I)', 0x06000005: 'Mixer', 0x06000006: 'Split (Mode II)',
};

/** Name, style and scene names from a TLV preset (tag 1 = info, tag 5 = scenes). */
export function presetInfo(raw) {
  const info = { name: '', style: '', scenes: [] };
  for (const { tag, data } of tlvSplit(raw)) {
    if (tag === 1 && data.length >= 21) info.name = cString(data, 4, 17);
    if (tag === 1 && data.length >= INFO_STYLE + STYLE_LEN) {
      const s = data.subarray(INFO_STYLE, INFO_STYLE + STYLE_LEN);
      info.style = s[0] === 0xff ? '' : cString(s, 0, STYLE_LEN);
    }
    if (tag === 5 && data.length >= 24) {
      const n = Number.isInteger((data.length - SCENE_EXTRA) / SCENE_BYTES) ? (data.length - SCENE_EXTRA) / SCENE_BYTES : 3;
      for (let s = 0; s < n; s++) info.scenes.push(cString(data, data.length - 8 * n + 8 * s, 8));
    }
  }
  return info;
}

/**
 * Compare a written preset with what the pedal stored (read back).
 * Known normalization (debug/ampero_trace_2026-11-06-10-21-56.txt, 185 of 300 slots): never-saved "Empty"
 * slots are format version 2 (tag 1 info, u32 version = 2) with tag 2 bytes 3..5 (quick knobs: u8 param[3])
 * = FF FF FF; when such a
 * preset is written, the pedal stores it as version 3 with 00 00 00 there. Nothing else changes.
 * Returns {identical, upgraded, diff}: upgraded = the only differences are exactly that conversion.
 */
export function compareStored(written, stored) {
  const diffs = [];
  const n = Math.max(written.length, stored.length);
  for (let k = 0; k < n; k++) if (written[k] !== stored[k]) diffs.push(k);
  if (!diffs.length) return { identical: true, upgraded: false, diff: 0 };
  let upgraded = false;
  try {
    const off = {};
    let o = 0;
    for (const { tag, data } of tlvSplit(written)) {
      off[tag] = o + 8;
      o += 8 + data.length;
    }
    const allowed = new Set([off[1], off[2] + 3, off[2] + 4, off[2] + 5]);
    upgraded = written.length === stored.length && diffs.every((k) => allowed.has(k)) &&
      written[off[1]] === 2 && stored[off[1]] === 3 &&
      [3, 4, 5].every((j) => written[off[2] + j] === 0xff && stored[off[2] + j] === 0x00);
  } catch { /* broken TLV: not the known case */ }
  return { identical: false, upgraded, diff: diffs.length };
}

// ------------------------------------------------------------------ effect parameters (tag 5)

export const SLOTS = 12;
export const SLOT_PARAMS = 25;

/** Byte offset of parameter `id` of `slot` in `scene` (tag 5: f32 [3 scenes][12 slots][25]). */
export function paramOffset(raw, scene, slot, id) {
  return tagOffset(raw, 5) + 4 * ((scene * SLOTS + slot) * SLOT_PARAMS + id);
}

export function presetParam(raw, scene, slot, id) {
  return new DataView(raw.buffer, raw.byteOffset).getFloat32(paramOffset(raw, scene, slot, id), true);
}

/** Copy of the preset with one parameter changed (what the pedal does on PARAM). */
export function setPresetParam(raw, scene, slot, id, value) {
  const out = raw.slice();
  new DataView(out.buffer).setFloat32(paramOffset(raw, scene, slot, id), value, true);
  return out;
}

/** Payload of CMD.PARAM. */
export function paramPayload(slot, id, value) {
  const p = new Uint8Array(8);
  const v = new DataView(p.buffer);
  v.setUint16(0, slot, true);
  v.setUint16(2, id, true);
  v.setFloat32(4, value, true);
  return p;
}

// ------------------------------------------------------------------ blocks (effect slots)

export const EMPTY_ALG = 0xffffffff;
// tag 5 layout for n scenes: f32 params[n][12][25] @0, u8 on[n][12] @1200n, u16 vol[n] @1212n, u16 tempo[n] @1214n,
// 317 bytes, char name[n][8] at the end
const onOffset = (raw) => 1200 * presetSceneCount(raw);

/** Payload of CMD.SET_ALG: u8 slot, u8 category, u32 alg code, u8 on. Remove = category 0xFF, code 0xFFFFFFFF, on 0. */
export function setAlgPayload(slot, category, code, on) {
  const p = new Uint8Array(7);
  const v = new DataView(p.buffer);
  p[0] = slot;
  p[1] = category & 0xff;
  v.setUint32(2, code >>> 0, true);
  p[6] = on ? 1 : 0;
  return p;
}

/** Payload of CMD.SLOT_ON: u8 scene, u8 on[12]. */
export function slotOnPayload(scene, on) {
  return Uint8Array.of(scene, ...Array.from({ length: SLOTS }, (_, s) => (on[s] ? 1 : 0)));
}

/** Payload of CMD.REORDER: u8 seq[12] (position -> slot). */
export const reorderPayload = (seq) => Uint8Array.from(seq);

/** u8 seq[12] (tag 4: position -> slot). */
export function presetSeq(raw) {
  const o = tagOffset(raw, 4);
  return Array.from(raw.subarray(o, o + SLOTS));
}

/** Copy of the preset with a new order (what the pedal does on REORDER). */
export function setPresetSeq(raw, seq) {
  const out = raw.slice();
  out.set(seq, tagOffset(raw, 4));
  return out;
}

/** Slot on/off states of one scene: bool[12]. */
export function presetOn(raw, scene) {
  const o = tagOffset(raw, 5) + onOffset(raw) + SLOTS * scene;
  return Array.from(raw.subarray(o, o + SLOTS), (b) => b !== 0);
}

export function setPresetOn(raw, scene, slot, on) {
  const out = raw.slice();
  out[tagOffset(raw, 5) + onOffset(raw) + SLOTS * scene + slot] = on ? 1 : 0;
  return out;
}

/**
 * Copy of the preset with another algorithm in `slot` (what the pedal does on SET_ALG): category and code in tag 4,
 * the slot's 25 parameters in all three scenes = `params` (missing ids 0). code EMPTY_ALG removes the block.
 */
export function setPresetAlg(raw, slot, category, code, params = []) {
  const out = raw.slice();
  const v = new DataView(out.buffer);
  const t4 = tagOffset(raw, 4);
  out[t4 + SLOTS + slot] = category & 0xff;
  v.setUint32(t4 + 2 * SLOTS + 4 * slot, code >>> 0, true);
  for (let s = 0; s < presetSceneCount(raw); s++) {
    for (let id = 0; id < SLOT_PARAMS; id++) v.setFloat32(paramOffset(raw, s, slot, id), params[id] ?? 0, true);
  }
  return out;
}

// ------------------------------------------------------------------ scenes (tag 5)

const sceneVol = (n) => 1212 * n, sceneBpm = (n) => 1214 * n; // u16 [n] each
export const SCENE_NAME_LEN = 8; // char name[8]; the pedal keeps everything up to the first 0

export function presetScene(raw, scene) {
  const o = tagOffset(raw, 5), d = new DataView(raw.buffer, raw.byteOffset);
  const len = rd32(raw, o - 4);
  const n = presetSceneCount(raw);
  return { volume: d.getUint16(o + sceneVol(n) + 2 * scene, true), tempo: d.getUint16(o + sceneBpm(n) + 2 * scene, true),
    name: cString(raw, o + len - SCENE_NAME_LEN * n + SCENE_NAME_LEN * scene, SCENE_NAME_LEN) };
}

/** Copy of the preset with scene volume / tempo / name changed ({volume, tempo, name}, each optional). */
export function setPresetScene(raw, scene, { volume, tempo, name } = {}) {
  const out = raw.slice();
  const o = tagOffset(raw, 5), d = new DataView(out.buffer);
  const len = rd32(raw, o - 4);
  const n = presetSceneCount(raw);
  if (volume != null) d.setUint16(o + sceneVol(n) + 2 * scene, volume, true);
  if (tempo != null) d.setUint16(o + sceneBpm(n) + 2 * scene, tempo, true);
  if (name != null) { // like the pedal: only up to and including the terminating 0
    const at = o + len - SCENE_NAME_LEN * n + SCENE_NAME_LEN * scene;
    const b = new TextEncoder().encode(name.slice(0, SCENE_NAME_LEN - 1));
    out.set(b, at);
    out[at + b.length] = 0;
  }
  return out;
}

export function sceneValuePayload(scene, value) {
  const p = new Uint8Array(4);
  new DataView(p.buffer).setUint16(0, scene, true);
  new DataView(p.buffer).setUint16(2, value, true);
  return p;
}

export function sceneNamePayload(scene, name) {
  const p = new Uint8Array(4 + SCENE_NAME_LEN);
  p.set(u32le(scene), 0);
  putString(p, 4, SCENE_NAME_LEN, name.slice(0, SCENE_NAME_LEN - 1));
  return p;
}

/** u32 + u32 / u32 + string payloads of the file / preset management commands. */
export const u32Payload = (...v) => concat(...v.map(u32le));
export function idNamePayload(id, name, len) {
  const p = new Uint8Array(4 + len);
  p.set(u32le(id), 0);
  putString(p, 4, len, asciiName(name));
  return p;
}

// ------------------------------------------------------------------ block backup ("ampero-block" files)

/** One block (slot) of a preset: algorithm, its 25 parameters per scene and on/off per scene. */
export function presetBlock(raw, slot) {
  const t4 = tagOffset(raw, 4);
  return {
    format: 'ampero-block', version: 1,
    code: rd32(raw, t4 + 2 * SLOTS + 4 * slot), category: raw[t4 + SLOTS + slot],
    on: Array.from({ length: presetSceneCount(raw) }, (_, s) => presetOn(raw, s)[slot]),
    params: Array.from({ length: presetSceneCount(raw) }, (_, s) => Array.from({ length: SLOT_PARAMS }, (_, id) => presetParam(raw, s, slot, id))),
  };
}

/** Copy of the preset with `block` in `slot` (what the pedal ends up with after restoreBlock). */
export function setPresetBlock(raw, slot, block) {
  let r = setPresetAlg(raw, slot, block.category, block.code, block.params[0]);
  for (let s = 0; s < presetSceneCount(raw); s++) {
    const src = Math.min(s, block.params.length - 1); // a block from a preset with fewer scenes: repeat its last one
    for (let id = 0; id < SLOT_PARAMS; id++) r = setPresetParam(r, s, slot, id, block.params[src][id] ?? 0);
    r = setPresetOn(r, s, slot, block.on[src]);
  }
  return r;
}

/** Validate a parsed block file; throws on a bad one. */
export function checkBlock(b) {
  if (b?.format !== 'ampero-block' || !Number.isInteger(b.code) || !Array.isArray(b.params) || !b.params.length ||
      b.params.some((p) => !Array.isArray(p)) || !Array.isArray(b.on)) throw new Error('not an Ampero block file');
  return b;
}

/** Payload of CMD.SAVE: u32 preset, char name[17]. */
export function savePayload(index, name) {
  const p = new Uint8Array(4 + NAME_LEN);
  p.set(u32le(index), 0);
  putString(p, 4, NAME_LEN, name);
  return p;
}

// ------------------------------------------------------------------ footswitch functions

/**
 * Footswitch function codes (preset tag 3 click/hold, CTRL footswitches, PATCH FS FUNC), from the Hotone app's
 * HTBaseDefine.kFSMapFunc. 0xFF = Off. "Ctrl n" switches the slots assigned to it (tag 8 / 0x01070001).
 */
export const FS_FUNCTIONS = new Map([
  [0xff, 'Off'],
  ...['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6'].map((s, i) => [i, `${s} On/Off`]),
  [12, 'Ctrl 1'], [13, 'Tap Tempo'], [15, 'Bank +'], [16, 'Bank -'], [17, 'Looper'], [18, 'Tuner'], [19, 'Bypass'],
  [20, 'Mode Change'], [21, 'Ctrl Temp Change'],
  ...[1, 2, 3, 4, 5].map((n) => [21 + n, `Patch ${n}`]), ...[1, 2, 3, 4, 5].map((n) => [26 + n, `Scene ${n}`]),
  ...[2, 3, 4, 5, 6, 7].map((n) => [30 + n, `Ctrl ${n}`]),
  [38, 'Patch +'], [39, 'Patch -'], [40, 'Bank Select'], [41, 'EXP 1/2'], // 40: "UI Open" in the app's table [42, 'Looper Rec/Play'], [43, 'Looper Stop'],
  [44, 'Looper 1/2 SPD'], [45, 'Looper Rev'], [46, 'Loop FX'], [47, 'Looper Undo/Redo'], [48, 'Drum Play/Stop'],
  [49, 'Looper Exit'], [50, 'Drum'], [51, 'Patch'], [52, 'Patch/FX Slot 1'], [53, 'Patch/Scene 2'], [54, 'Patch/Bypass'],
]);

export const fsFunctionName = (code) => FS_FUNCTIONS.get(code) ?? `function ${code}`;

/** "Ctrl n" functions: the footswitch switches the slots assigned to it (tag 8 ctrlTargetSlot). */
export const isCtrlFunction = (code) => code === 12 || (code >= 32 && code <= 37);

export const FS_SET = 0x01030001; // u8 click[3] (confirmed: windows/wireshark.pcapng)
export const FS_SLOTS_SET = 0x01070001; // u8 fs, u8 on[12] per chain position (confirmed)

/** Footswitches of a preset: {click: [3], hold: [3]} (tag 3). */
export function presetFs(raw) {
  const o = tagOffset(raw, 3);
  return { click: Array.from(raw.subarray(o, o + 3)), hold: Array.from(raw.subarray(o + 3, o + 6)) };
}

export function setPresetFsClick(raw, fs, code) {
  const out = raw.slice();
  out[tagOffset(raw, 3) + fs] = code;
  return out;
}

/**
 * Chain positions switched by footswitch fs (tag 8: u8 led[3], u8 on[3][12]). Indexed by position A1..B6, not by slot:
 * the Hotone editor sends index 1 for a block at A2, and after moving the block the footswitch keeps switching A2
 * (captures/session-2026-11-18-watch.txt). The block on/off states (tag 5, SLOT_ON) are per slot.
 */
export function presetFsSlots(raw, fs) {
  const o = tagOffset(raw, 8) + 3 + 12 * fs;
  return Array.from(raw.subarray(o, o + 12), (b) => b === 1);
}

export function setPresetFsSlot(raw, fs, slot, on) {
  const out = raw.slice();
  out[tagOffset(raw, 8) + 3 + 12 * fs + slot] = on ? 1 : 0;
  return out;
}

export const fsSlotsPayload = (fs, on) => Uint8Array.of(fs, ...on.map((x) => (x ? 1 : 0)));

// ------------------------------------------------------------------ MIDI messages (tag 9)
//
// tag 9 = 15 messages of 3 bytes: u8 channel (0xFF = OFF, 0..15 = channel 1..16), u8 command (0..127 = CC n,
// 128 = PC), u8 data (0..127). Messages 0..8: footswitch MIDI, FS n message r at 3n + r; 9..14: patch MIDI (sent
// when the preset is loaded). Verified with data/A98-1-MIDI-Test.raw (values set in the Hotone editor).
// Set (from the Hotone app, HTModelPreset.setFSMidiParam / setPatchMidiParam – not yet seen in a capture):
// 0x010B0001 u32 fs, u32 id, char[3]; 0x010B0002 u32 id, char[3]. id = row within the footswitch / patch MIDI.
export const MIDI = { FS: 0x010b0001, PATCH: 0x010b0002, FS_ROWS: 3, PATCH_ROWS: 6, PC: 128, OFF: 0xff };

export function presetMidi(raw) {
  const o = tagOffset(raw, 9), len = rd32(raw, o - 4);
  return Array.from({ length: Math.floor(len / 3) }, (_, i) => ({ ch: raw[o + 3 * i], cmd: raw[o + 3 * i + 1], data: raw[o + 3 * i + 2] }));
}

export function setPresetMidi(raw, index, m) {
  const out = raw.slice();
  out.set([m.ch, m.cmd, m.data], tagOffset(raw, 9) + 3 * index);
  return out;
}

/** A message limited to the values the Hotone editor uses. */
export const midiValid = (m) => (m.ch === MIDI.OFF || (m.ch >= 0 && m.ch <= 15)) && m.cmd >= 0 && m.cmd <= MIDI.PC &&
  m.data >= 0 && m.data <= 127;

export const fsMidiPayload = (fs, row, m) => concat(u32le(fs), u32le(row), Uint8Array.of(m.ch, m.cmd, m.data));
export const patchMidiPayload = (row, m) => concat(u32le(row), Uint8Array.of(m.ch, m.cmd, m.data));
export const midiText = (m) => (m.ch === MIDI.OFF ? 'OFF' : `ch ${m.ch + 1} · ${m.cmd === MIDI.PC ? 'PC' : `CC ${m.cmd}`} · ${m.data}`);

/**
 * Footswitch functions the Ampero II Stomp accepts. The table above is from the app for both models; on the Stomp,
 * "Ctrl 5/6" (and editing scenes 4/5) stop the firmware with an error. Allowed: what the Stomp's factory presets use
 * (Ctrl 1–3, Tap Tempo, EXP 1/2) and what the Hotone editor for the Stomp offers for the CTRL footswitch
 * (kFSTapList: looper, drum, bank/patch ±, tap, scenes 1–3, A1–B6), plus Off.
 */
export const STOMP_FS_FUNCTIONS = new Set([0xff, 12, 32, 33, 13, 41, 15, 16, 38, 39, 18, 17, 42, 43, 44, 45, 46, 47, 49,
  48, 50, 20, 27, 28, 29, 40, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]); // 40 Bank Select: seen on the Stomp

/**
 * Preset footswitch choices of the Hotone editor for the Stomp (Patch Settings → Footswitch Settings, screenshot
 * data/fs1.png): "Effect slots" – the footswitch switches the blocks assigned to it; on the pedal that is the
 * function "Ctrl n" of this very footswitch (FS1 = Ctrl 1, FS2 = Ctrl 2, FS3 = Ctrl 3) – or one fixed function.
 */
export const STOMP_FS_CTRL = [12, 32, 33];
export const STOMP_FS_FIXED = [27, 28, 29, 13, 41, 19, 18, 17, 0xff]; // Scene 1–3, Tap Tempo, EXP 1/2, Bypass, Tuner, Looper, OFF

/** Functions offered for the external CTRL footswitches (HTBaseDefine.kFSTapList, in the app's order). */
export const CTRL_FS_FUNCTIONS = [42, 43, 47, 44, 45, 17, 49, 18, 50, 48, 15, 16, 13, 38, 39, 27, 28, 29, 30, 31, 41,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

// ------------------------------------------------------------------ user IRs / NAM models

export const USER_IRS = 50; // user IR slots ("User IR 1" … "User IR 50", algorithm 0x0A100000 + slot)
export const FACTORY_IRS = 30; // IR numbers 0..29 on the wire; user IR slot s is number 30 + s
export const NAM_SLOTS = 30; // "NAM Slot 1" … "NAM Slot 30", algorithm 0x10000000 + slot
export const UPLOAD_NAME = 16; // the editor cuts names to 16 characters

const byteSum = (b, from = 0, to = b.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += b[i];
  return s & 0xffff;
};

function asciiName(name) {
  return Array.from(name.slice(0, UPLOAD_NAME), (c) => (c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) < 0x7f ? c : '_')).join('');
}

/** Payload of CMD.IR_UPLOAD for user IR `slot` (0..49); samples = Int32Array(2048), 24-bit values at 44.1 kHz. */
export function irPayload(slot, name, samples) {
  const p = new Uint8Array(4 + 32 + 4 * 2048 + 2);
  const v = new DataView(p.buffer);
  v.setUint32(0, FACTORY_IRS + slot, true);
  putString(p, 4, 32, asciiName(name));
  for (let i = 0; i < 2048; i++) v.setInt32(36 + 4 * i, samples[i] ?? 0, true);
  v.setUint16(p.length - 2, byteSum(p, 0, p.length - 2), true);
  return p;
}

/** Payload of CMD.NAM_UPLOAD for NAM slot `slot` (0..29); namb = .namb file bytes. */
export function namPayload(slot, name, namb) {
  const p = new Uint8Array(32 + namb.length);
  const v = new DataView(p.buffer);
  v.setUint32(4, slot, true);
  putString(p, 8, 16, asciiName(name));
  v.setUint32(28, 1, true);
  p.set(namb, 32);
  v.setUint32(0, byteSum(p, 4), true);
  return p;
}

/** Answer of USER_IR_NAMES: char name[50][32]. */
export function parseIrNames(p) {
  return Array.from({ length: Math.min(USER_IRS, Math.floor(p.length / 32)) }, (_, i) => cString(p, 32 * i, 32));
}

/** Answer of NAM_LIST: char name[30][17] (0xFF… = empty slot) + 30 bytes. */
export function parseNamList(p) {
  return Array.from({ length: Math.min(NAM_SLOTS, Math.floor(p.length / 17)) }, (_, i) =>
    (p[17 * i] === 0xff ? '' : cString(p, 17 * i, 17)));
}

/** Answer of PRESET_LIST: u16 order[300], char name[300][17], … */
export function parsePresetList(p) {
  const names = [];
  for (let i = 0; i < PRESET_COUNT; i++) names.push(cString(p, 2 * PRESET_COUNT + 17 * i, 17));
  return names;
}
