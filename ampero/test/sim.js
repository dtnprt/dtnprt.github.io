// Simulated Ampero II Stomp for testing the web editor without the pedal: open the app with "?sim".
// Replaces navigator.requestMIDIAccess with one fake port pair that answers like the pedal (firmware, preset
// list, current preset / scene, preset dumps from test/sim-presets.json = presets of a real capture) and applies
// the edit commands to its presets. Every command it receives is logged to the console and kept in
// window.simLog ({t, cmd, kind, payload}).

import {
  CMD, KIND_SET, PRESET_COUNT, Reassembler, concat, encodeTransfer, hex32, paramPayload, presetInfo, rd32, setPresetParam,
  u32le,
} from '../js/protocol.js';

const unhex = (s) => Uint8Array.from(s.match(/../g) || [], (h) => parseInt(h, 16));

export async function install() {
  const data = await (await fetch(new URL('sim-presets.json', import.meta.url))).json();
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
        presets.set(current, setPresetParam(preset(current), scene, slot, id, value));
        console.info(`[sim] param slot ${slot} id ${id} = ${value} (scene ${scene + 1})`);
        return emit(CMD.PRESET_CHANGED, u32le(1));
      }
      case CMD.SAVE:
        console.info(`[sim] save into ${rd32(payload, 0)}`);
        return emit(CMD.PRESET_CHANGED, u32le(0));
      default:
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
  console.info('[sim] simulated Ampero installed – presets', [...presets.keys()].join(', '));
}
