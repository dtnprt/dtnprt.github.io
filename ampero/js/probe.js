// Probe: ask the pedal (read-only, kind 0x11) for every command in the firmware's command table and record
// the answers. Run it, change ONE setting on the pedal, run it again: the diff shows which command carries it.

import { COMMAND_GROUPS } from './sniffer.js';
import { u32le } from './protocol.js';

/**
 * Codes that are NOT asked: system group 0x05 (save, connect, reset …), whole preset 0x0100 (dump/write),
 * chain templates 0x0200 except the user template list (selecting a template changes the preset).
 */
export function probeCodes() {
  const out = [];
  for (const [g, n] of COMMAND_GROUPS) {
    if (g === 0x0500 || g === 0x0100) continue;
    for (let k = 0; k < n; k++) {
      const cmd = ((g << 16) | k) >>> 0;
      if (g === 0x0200 && cmd !== 0x02000004) continue;
      out.push(cmd);
    }
  }
  return out;
}

/**
 * Ask every code; per code: {cmd, req: 'empty'|'u32 0'|null, answer: hex string or null}.
 * onProgress(done, total, cmd). signal: AbortSignal.
 */
export async function probe(dev, { onProgress = () => {}, signal } = {}) {
  const codes = probeCodes();
  const results = [];
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  for (const cmd of codes) {
    if (signal?.aborted) throw new Error('cancelled');
    let res = { cmd, req: null, answer: null };
    for (const [req, payload] of [['empty', new Uint8Array(0)], ['u32 0', u32le(0)]]) {
      try {
        await dev.waitQuiet(20, 500);
        const a = await dev.request(cmd, payload, { timeout: 400 });
        res = { cmd, req, answer: hex(a) };
        break;
      } catch {
        // no answer – try the next request form
      }
    }
    results.push(res);
    onProgress(results.length, codes.length, cmd);
  }
  return { created: new Date().toISOString(), firmware: dev.firmware, results };
}

/** Codes whose answer differs between two probes: [{cmd, a, b, bytes: [changed byte offsets]}]. */
export function diffProbes(a, b) {
  const map = new Map(a.results.map((r) => [r.cmd, r.answer]));
  const out = [];
  for (const r of b.results) {
    const x = map.get(r.cmd);
    if (x === undefined || x === r.answer) continue;
    const bytes = [];
    const n = Math.max((x ?? '').length, (r.answer ?? '').length) / 2;
    for (let k = 0; k < n; k++) if ((x ?? '').slice(2 * k, 2 * k + 2) !== (r.answer ?? '').slice(2 * k, 2 * k + 2)) bytes.push(k);
    out.push({ cmd: r.cmd, a: x, b: r.answer, bytes });
  }
  return out;
}
