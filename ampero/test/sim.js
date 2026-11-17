// Simulated Ampero II Stomp for testing the web editor without the pedal: open the app with "?sim".
// Replaces navigator.requestMIDIAccess with one fake port pair that answers like the pedal (firmware, preset
// list, current preset / scene, preset dumps from test/sim-presets.json = presets of a real capture) and applies
// the edit commands to its presets. Every command it receives is logged to the console and kept in
// window.simLog ({t, cmd, kind, payload}).

import {
  CMD, FACTORY_IRS, KIND_SET, NAM_SLOTS, PRESET_COUNT, Reassembler, USER_IRS, concat, encodeTransfer, hex32, paramPayload,
  presetInfo, rd32, setPresetAlg, setPresetName, setPresetOn, setPresetParam, setPresetScene, setPresetSeq, u32le,
  CHAIN_MODES, TEMPLATE, applyTemplate,
} from '../js/protocol.js';
import { algInfo, loadAlgDb } from '../js/algdb.js';

const unhex = (s) => Uint8Array.from(s.match(/../g) || [], (h) => parseInt(h, 16));

export async function install() {
  const data = await (await fetch(new URL('sim-presets.json', import.meta.url))).json();
  await loadAlgDb();
  const presets = new Map(Object.entries(data.presets).map(([k, h]) => [+k, unhex(h)]));
  const fallback = presets.values().next().value;
  let current = data.current ?? 0;
  let scene = 0;
  const log = (window.simLog = []);
  const listeners = new Set();
  let due = 0; // answers go out one frame after another, ~2 ms apart
  const emit = (cmd, payload = new Uint8Array(0)) => {
    for (const f of encodeTransfer(cmd, payload, KIND_SET)) {
      due = Math.max(due, performance.now()) + 2;
      setTimeout(() => listeners.forEach((l) => l({ data: f })), due - performance.now());
    }
  };
  const preset = (i) => presets.get(i) ?? fallback;
  const globals = new Map(Object.entries(data.globals ?? {}).map(([k, h]) => [+k, unhex(h)]));
  const irNames = Array.from({ length: USER_IRS }, (_, i) => `User IR ${i + 1}`);
  const namNames = Array.from({ length: NAM_SLOTS }, (_, i) => (i === 0 ? 'Fortin Cali DI 1' : ''));
  const str = (s, n) => {
    const b = new Uint8Array(n);
    b.set(new TextEncoder().encode(s).subarray(0, n));
    return b;
  };
  const userTemplates = ['My Chain', '', '', ''];
  const userTemplateData = [];
  const tag6 = (r) => { let k = 0; for (;;) { const len = rd32(r, k + 4); if (rd32(r, k) === 6) return k + 8; k += 8 + len; } };
  const sum = (b, from, to) => b.subarray(from, to).reduce((s, x) => s + x, 0) & 0xffff;
  const handle = ({ cmd, kind, payload }) => {
    log.push({ t: performance.now(), cmd, kind, payload });
    console.debug(`[sim] ${kind === KIND_SET ? 'set' : 'get'} ${hex32(cmd)} ${payload.length} B`);
    const get = kind !== KIND_SET;
    switch (cmd) {
      case CMD.FIRMWARE_VERSION:
        return emit(cmd, new TextEncoder().encode('V2.5.0\0\0\0\0\0\0'));
      case CMD.PRESET_LIST: {
        const p = new Uint8Array(2 * PRESET_COUNT + 17 * PRESET_COUNT + 24000);
        for (let i = 0; i < PRESET_COUNT; i++) {
          p[2 * i] = i & 0xff;
          p[2 * i + 1] = i >> 8;
          const name = presets.has(i) ? presetInfo(presets.get(i)).name : 'Empty';
          p.set(new TextEncoder().encode(name.slice(0, 16)), 2 * PRESET_COUNT + 17 * i);
        }
        return emit(cmd, p);
      }
      case CMD.CURRENT_PRESET:
        if (get) return emit(cmd, u32le(current));
        current = rd32(payload, 0);
        scene = 0;
        return undefined;
      case CMD.CURRENT_SCENE:
        if (get) return emit(cmd, u32le(scene));
        scene = payload[0];
        return undefined;
      case CMD.PRESET_DUMP: {
        const i = rd32(payload, 0);
        current = i; // reading a preset loads it (like the pedal)
        return emit(cmd, concat(u32le(i), preset(i)));
      }
      case CMD.PARAM: {
        const v = new DataView(payload.buffer, payload.byteOffset);
        const [slot, id, value] = [v.getUint16(0, true), v.getUint16(2, true), v.getFloat32(4, true)];
        if (scene < 3) presets.set(current, setPresetParam(preset(current), scene, slot, id, value)); // 4/5: not in the format
        console.info(`[sim] param slot ${slot} id ${id} = ${value} (scene ${scene + 1})`);
        return emit(CMD.PRESET_CHANGED, u32le(1));
      }
      case CMD.SLOT_ON:
        if (payload[0] < 3) for (let s = 0; s < 12; s++) presets.set(current, setPresetOn(preset(current), payload[0], s, payload[1 + s]));
        console.info(`[sim] scene ${payload[0] + 1} on ${Array.from(payload.subarray(1, 13)).join('')}`);
        return emit(CMD.PRESET_CHANGED, u32le(1));
      case CMD.REORDER:
        presets.set(current, setPresetSeq(preset(current), payload.subarray(0, 12)));
        console.info(`[sim] order ${Array.from(payload.subarray(0, 12)).join(' ')}`);
        return emit(CMD.PRESET_CHANGED, u32le(1));
      case CMD.SET_ALG: {
        const v = new DataView(payload.buffer, payload.byteOffset);
        const [slot, cat, code, on] = [payload[0], payload[1], v.getUint32(2, true), payload[6]];
        const params = new Float32Array(25);
        for (const p of algInfo(code)?.params ?? []) params[p.id] = p.def;
        presets.set(current, setPresetAlg(preset(current), slot, cat, code, Array.from(params)));
        console.info(`[sim] slot ${slot}: category ${cat}, alg ${hex32(code)}, on ${on}`);
        emit(CMD.PRESET_CHANGED, u32le(1));
        if (code === 0xffffffff) return undefined;
        const push = new Uint8Array(116);
        const pv = new DataView(push.buffer);
        pv.setUint32(0, slot, true); pv.setUint32(4, cat, true); pv.setUint32(8, on, true); pv.setUint32(12, code, true);
        params.forEach((x, i) => pv.setFloat32(16 + 4 * i, x, true));
        return setTimeout(() => emit(CMD.SLOT_PUSH, push), 150);
      }
      case CMD.SCENE_VOLUME:
      case CMD.SCENE_TEMPO: {
        const v = new DataView(payload.buffer, payload.byteOffset);
        const [sc, val] = [v.getUint16(0, true), v.getUint16(2, true)];
        presets.set(current, setPresetScene(preset(current), sc, cmd === CMD.SCENE_TEMPO ? { tempo: val } : { volume: val }));
        console.info(`[sim] scene ${sc + 1} ${cmd === CMD.SCENE_TEMPO ? 'tempo' : 'volume'} ${val}`);
        return emit(CMD.PRESET_CHANGED, u32le(1));
      }
      case CMD.SCENE_NAME: {
        const name = new TextDecoder().decode(payload.subarray(4, 12)).replace(/\0.*$/s, '');
        presets.set(current, setPresetScene(preset(current), rd32(payload, 0), { name }));
        return emit(CMD.PRESET_CHANGED, u32le(1));
      }
      case CMD.PRESET_DELETE:
        presets.set(rd32(payload, 0), setPresetName(fallback, 'Empty'));
        return undefined;
      case CMD.PRESET_MOVE: {
        const [to, from] = [rd32(payload, 0), rd32(payload, 4)];
        const a = preset(from), b = preset(to);
        presets.set(to, a);
        presets.set(from, b);
        return undefined;
      }
      case CMD.IR_RENAME:
        irNames[rd32(payload, 0) - FACTORY_IRS] = new TextDecoder().decode(payload.subarray(4, 36)).replace(/\0.*$/s, '');
        return undefined;
      case CMD.IR_DELETE:
        irNames[rd32(payload, 0) - FACTORY_IRS] = `User IR ${rd32(payload, 0) - FACTORY_IRS + 1}`;
        return undefined;
      case CMD.NAM_RENAME:
        namNames[rd32(payload, 0)] = new TextDecoder().decode(payload.subarray(4, 20)).replace(/\0.*$/s, '');
        return undefined;
      case CMD.NAM_DELETE:
        namNames[rd32(payload, 0)] = '';
        return undefined;
      case 0x01030001: { // footswitch functions
        let r = preset(current);
        const o = (() => { let k = 0; for (let t = 0; ; t++) { const len = rd32(r, k + 4); if (rd32(r, k) === 3) return k + 8; k += 8 + len; } })();
        r = r.slice(); r.set(payload.subarray(0, 3), o); presets.set(current, r);
        return emit(CMD.PRESET_CHANGED, u32le(1));
      }
      case 0x01070001: { // footswitch -> slots
        let r = preset(current);
        const o = (() => { let k = 0; for (;;) { const len = rd32(r, k + 4); if (rd32(r, k) === 8) return k + 8; k += 8 + len; } })();
        r = r.slice(); r.set(payload.subarray(1, 13), o + 3 + 12 * payload[0]); presets.set(current, r);
        return emit(CMD.PRESET_CHANGED, u32le(1));
      }
      case TEMPLATE.LIST:
        return emit(cmd, concat(...userTemplates.map((n) => (n ? str(n, 12) : new Uint8Array(12).fill(0xff)))));
      case TEMPLATE.SAVE: {
        const n = rd32(payload, 0) - TEMPLATE.USER_BASE;
        userTemplates[n] = new TextDecoder().decode(payload.subarray(4, 16)).replace(/\0.*$/s, '');
        const r = preset(current), o = tag6(r);
        userTemplateData[n] = r.slice(o, o + 540);
        return undefined;
      }
      case TEMPLATE.SELECT: {
        const id = rd32(payload, 0), m = CHAIN_MODES[id];
        if (m) presets.set(current, applyTemplate(preset(current), m));
        const td = userTemplateData[id - TEMPLATE.USER_BASE];
        if (td) { // like the pedal (assumed): apply and report the template data
          const r = preset(current).slice();
          r.set(td, tag6(r));
          presets.set(current, r);
          emit(TEMPLATE.DATA, concat(u32le(id), new Uint8Array(12), td));
        }
        return emit(CMD.PRESET_CHANGED, u32le(1));
      }
      case CMD.USER_IR_NAMES:
        return emit(cmd, concat(...irNames.map((n) => str(n, 32))));
      case CMD.NAM_LIST:
        return emit(cmd, concat(...namNames.map((n) => (n ? str(n, 17) : new Uint8Array(17).fill(0xff))), new Uint8Array(30)));
      case CMD.IR_UPLOAD: {
        const v = new DataView(payload.buffer, payload.byteOffset);
        const ok = payload.length === 8230 && sum(payload, 0, 8228) === v.getUint16(8228, true);
        const n = rd32(payload, 0);
        if (ok) irNames[n - FACTORY_IRS] = new TextDecoder().decode(payload.subarray(4, 36)).replace(/\0.*$/s, '');
        console.info(`[sim] IR upload into ${n}: checksum ${ok ? 'ok' : 'WRONG'}`);
        return setTimeout(() => emit(CMD.WRITE_ACK, concat(u32le(cmd), u32le(ok ? 1 : 0), u32le(n))), 300);
      }
      case CMD.NAM_UPLOAD: {
        const ok = sum(payload, 4, payload.length) === rd32(payload, 0) && rd32(payload, 32) === 0x4e414d42;
        const slot = rd32(payload, 4);
        if (ok) namNames[slot] = new TextDecoder().decode(payload.subarray(8, 24)).replace(/\0.*$/s, '');
        console.info(`[sim] NAM upload into slot ${slot}: ${payload.length - 32} B NAMB, checksum ${ok ? 'ok' : 'WRONG'}`);
        return setTimeout(() => emit(CMD.WRITE_ACK, concat(u32le(cmd), u32le(ok ? 1 : 0), u32le(slot))), 300);
      }
      case CMD.SAVE:
        console.info(`[sim] save into ${rd32(payload, 0)}`);
        return emit(CMD.PRESET_CHANGED, u32le(0));
      default:
        if (globals.has(cmd) && !(kind === KIND_SET)) return emit(cmd, globals.get(cmd));
        if (kind === KIND_SET && (cmd >>> 24) === 0 && (cmd & 0xffff)) { // global parameter
          const g = globals.get(cmd & 0xffff0000);
          if (cmd >>> 16 === 3) { // global EQ
            if ((cmd & 0xffff) === 2 && g) new DataView(g.buffer).setFloat32(4 + 4 * rd32(payload, 0), new DataView(payload.buffer, payload.byteOffset).getFloat32(4, true), true);
            if ((cmd & 0xffff) === 1 && g) new DataView(g.buffer).setFloat32(0, rd32(payload, 0), true);
          } else if (g && (cmd & 0xffff) <= g.length) {
            g[(cmd & 0xffff) - 1] = payload[0];
          }
          console.info(`[sim] global ${hex32(cmd)} = ${Array.from(payload).join(',')}`);
        }
        return undefined; // CONNECT and everything else: no answer
    }
  };
  const reasm = new Reassembler(handle, (e) => console.warn('[sim]', e.message));
  const port = (type, id) => ({
    id, type, name: 'Ampero II Stomp (simulated)', manufacturer: 'sim', state: 'connected', connection: 'open',
    open: async () => {}, close: async () => {},
    addEventListener(t, f) {
      if (t === 'midimessage') listeners.add(f);
    },
    removeEventListener(t, f) {
      listeners.delete(f);
    },
  });
  const input = port('input', 'sim-in');
  const output = Object.assign(port('output', 'sim-out'), {
    send(bytes) {
      if (bytes[3] !== 0x7f) reasm.push(Uint8Array.from(bytes)); // ignore the short handshake frames
    },
  });
  const access = { inputs: new Map([[input.id, input]]), outputs: new Map([[output.id, output]]), sysexEnabled: true,
    onstatechange: null };
  Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: async () => access });
  window.simParamPayload = paramPayload; // handy in the console
  window.simPreset = () => preset(current); // the simulated pedal's current preset (tests)
  console.info('[sim] simulated Ampero installed – presets', [...presets.keys()].join(', '));
}
