// Ampero II Stomp USB-MIDI SysEx protocol (see tools/FORMAT.md, chapter 6).
//
// Frame:  F0 21 25 4D 50 00 00 | cs | kind | totLo totHi | offLo offHi | nibbles … | F7
// Stream: u32 cmd | u32 len | data[len]   (data = LZO1X-1 stream, empty if len = 0)

import * as lzo from './lzo1x.js';

export const HEADER = Uint8Array.of(0xf0, 0x21, 0x25, 0x4d, 0x50, 0x00, 0x00);
export const KIND_GET = 0x11;
export const KIND_SET = 0x12;
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
 * length check catches it (the checksum of device frames follows an unknown rule).
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

/** u32 alg[12] of the effect slots (tag 4 at data offset 24); 0xFFFFFFFF = empty. */
export function presetSlots(raw) {
  const o = tagOffset(raw, 4) + 24;
  return Array.from({ length: 12 }, (_, i) => rd32(raw, o + 4 * i));
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
    const on = [0, 1, 2].map((s) => raw[t5 + 3600 + 12 * s + slot] !== 0);
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
 * Bytes 2, 4, 6 also differ between templates (meaning unknown, kept for display).
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

/** Kept for the sniffer: the template a preset matches, or {id: -1, name} with its routing. */
export function presetChainMode(raw) {
  const r = presetRouting(raw);
  return r.template ?? { id: -1, name: r.name, bytes: r.bytes };
}

/** Module of an algorithm code (highest byte), see tools/FORMAT.md chapter 5. */
export const MODULES = {
  0x00: 'DYN', 0x01: 'EQ', 0x03: 'DRV', 0x04: 'MOD', 0x05: 'WAH', 0x06: 'VOL', 0x07: 'AMP', 0x08: 'PRE AMP',
  0x09: 'CAB', 0x0a: 'IR', 0x0b: 'DLY', 0x0c: 'RVB', 0x0e: 'FREQ', 0x0f: 'CLONE', 0x10: 'NAM',
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
      for (let s = 0; s < 3; s++) info.scenes.push(cString(data, data.length - 24 + 8 * s, 8));
    }
  }
  return info;
}

/**
 * Compare a written preset with what the pedal stored (read back).
 * Known normalization (debug/ampero_trace_2026-11-06-10-21-56.txt, 185 of 300 slots): never-saved "Empty"
 * slots are format version 2 (tag 1 info, u32 version = 2) with tag 2 bytes 3..5 = FF FF FF; when such a
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

/** Answer of PRESET_LIST: u16 order[300], char name[300][17], … */
export function parsePresetList(p) {
  const names = [];
  for (let i = 0; i < PRESET_COUNT; i++) names.push(cString(p, 2 * PRESET_COUNT + 17 * i, 17));
  return names;
}
