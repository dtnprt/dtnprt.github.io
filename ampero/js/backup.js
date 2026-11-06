// Backup container: ZIP with manifest.json + presets/A00-1-Name.prst
//   version 2: one .prst per preset, as exported by the Hotone software (can be imported there directly)
//   version 1: presets/NNN_A00-1_Name.raw (plain TLV) – still read
// size / crc32 in the manifest always refer to the TLV preset (decompressed).

import { PRESET_COUNT, presetInfo, presetLabel } from './protocol.js';
import { decodePrst, encodePrst } from './prst.js';
import { crc32, makeZip, readZip } from './zip.js';

export const BACKUP_FORMAT = 'ampero2-stomp-backup';
export const BACKUP_VERSION = 2;

/** Name as file name: characters Windows does not allow are replaced. */
const safe = (s) => s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim() || 'unnamed';

/** Like the Hotone software's export: "A99-1-Le Chug.prst". */
export function presetFileName(index, name) {
  return `presets/${presetLabel(index)}-${safe(name)}.prst`;
}

/**
 * Read presets from the device.
 * opts: {from, to, onProgress(i, done, total, name), signal, onRestore(index)}
 *
 * Reading a preset makes the pedal LOAD it (verified on the device with the Hotone editor closed: the
 * display switches to every preset that is read). Unsaved edits of the current preset are therefore lost.
 * The preset that was selected before is selected again at the end – also when the backup fails or is
 * cancelled.
 * Returns [{index, name, scenes, raw}]
 */
export async function dumpPresets(dev, { from = 0, to = PRESET_COUNT - 1, onProgress = () => {}, signal,
  onRestore = () => {} } = {}) {
  const out = [];
  const total = to - from + 1;
  const original = await dev.currentPreset().catch(() => -1);
  try {
    for (let i = from; i <= to; i++) {
      if (signal?.aborted) throw new Error('cancelled');
      const raw = await dev.readPreset(i);
      const info = presetInfo(raw);
      out.push({ index: i, name: info.name, style: info.style, scenes: info.scenes, raw });
      onProgress(i, out.length, total, info.name);
    }
  } finally {
    if (original >= 0) {
      await dev.waitQuiet(100);
      await dev.selectPreset(original).catch(() => {});
      onRestore(original);
    }
  }
  return out;
}

export function buildBackup(presets, { firmware = '', presetList = null } = {}) {
  const created = new Date();
  const files = [];
  const manifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    created: created.toISOString(),
    firmware,
    presets: [],
  };
  for (const p of presets) {
    const file = presetFileName(p.index, p.name);
    files.push({ name: file, data: encodePrst(p.raw) });
    manifest.presets.push({
      index: p.index, label: presetLabel(p.index), name: p.name, scenes: p.scenes,
      file, size: p.raw.length, crc32: crc32(p.raw),
    });
  }
  if (presetList) {
    files.push({ name: 'preset_list.bin', data: presetList });
    manifest.presetList = 'preset_list.bin';
  }
  files.unshift({ name: 'manifest.json', data: JSON.stringify(manifest, null, 2) });
  const p2 = (v) => String(v).padStart(2, '0');
  const stamp = `${created.getFullYear()}-${p2(created.getMonth() + 1)}-${p2(created.getDate())}_` +
    `${p2(created.getHours())}${p2(created.getMinutes())}`;
  return { blob: makeZip(files, created), fileName: `Ampero_Backup_${stamp}.zip`, manifest };
}

/** Uint8Array (zip) -> {manifest, presets: [{index, name, scenes, raw}]} */
export async function loadBackup(buf) {
  const files = await readZip(buf);
  const m = files.get('manifest.json');
  if (!m) throw new Error('manifest.json missing – not an Ampero backup');
  const manifest = JSON.parse(new TextDecoder().decode(m));
  if (manifest.format !== BACKUP_FORMAT) throw new Error(`unknown backup format "${manifest.format}"`);
  const presets = [];
  for (const e of manifest.presets) {
    const data = files.get(e.file);
    if (!data) throw new Error(`${e.file} missing in backup`);
    const raw = e.file.toLowerCase().endsWith('.prst') ? decodePrst(data) : data;
    if (raw.length !== e.size || crc32(raw) !== e.crc32) throw new Error(`${e.file}: size/CRC differs from manifest`);
    const info = presetInfo(raw);
    presets.push({ index: e.index, name: info.name, style: info.style, scenes: info.scenes, raw });
  }
  return { manifest, presets };
}
