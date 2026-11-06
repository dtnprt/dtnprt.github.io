// Connection to the Ampero II Stomp over Web MIDI (Chrome / Edge; needs SysEx permission).

import {
  CMD, DamagedFrameError, HANDSHAKE, KIND_GET, KIND_SET, PRESET_COUNT, Reassembler, encodeTransfer, hex32,
  parsePresetList, presetInfo, rd32, u32le, cString, concat, WRITE_CONFIRMED,
} from './protocol.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function requestMidi() {
  if (!navigator.requestMIDIAccess) throw new Error('This browser has no Web MIDI. Use Chrome or Edge.');
  return navigator.requestMIDIAccess({ sysex: true });
}

const AMPERO_PORT = /ampero|mp-?300/i;

/** {inputs, outputs, input, output}: all ports plus the ones that look like the Ampero. */
export function listPorts(access) {
  const inputs = [...access.inputs.values()];
  const outputs = [...access.outputs.values()];
  return {
    inputs,
    outputs,
    input: inputs.find((p) => AMPERO_PORT.test(p.name)) || null,
    output: outputs.find((p) => AMPERO_PORT.test(p.name)) || null,
  };
}

/**
 * Events: 'log' {detail: text}, 'notify' {detail: {cmd, payload}} for messages nobody asked for,
 * 'close'.
 */
export class AmperoDevice extends EventTarget {
  constructor(input, output) {
    super();
    this.input = input;
    this.output = output;
    this.pending = null; // {cmd, resolve, reject, timer}
    this.queue = Promise.resolve();
    this.firmware = '';
    this.frameDelayMs = 0; // pause between the frames of a long transfer
    this.stats = { frames: 0, damaged: 0 };
    this.reasm = new Reassembler((tr) => this._onTransfer(tr), (e) => this._onReceiveError(e));
    this.lastRx = 0;
    this.t0 = performance.now();
    this.trace = []; // [time ms, 'IN'|'OUT', Uint8Array] – raw MIDI, for debugging
    this.traceMax = 20000;
    this._onMidi = (ev) => this._onMessage(ev.data);
    this._onState = (ev) => {
      if ((ev.port === this.input || ev.port === this.output) && ev.port.state === 'disconnected') {
        this._log('device disconnected');
        this.close();
      }
    };
  }

  _log(text) {
    this.dispatchEvent(new CustomEvent('log', { detail: text }));
  }

  async open() {
    await this.input.open();
    await this.output.open();
    this.input.addEventListener('midimessage', this._onMidi);
    this.input.addEventListener('statechange', this._onState);
    this.output.addEventListener('statechange', this._onState);

    // start-up like the editor: CONNECT, then the short handshake frame 5x every 200 ms
    this._send(CMD.CONNECT, new Uint8Array(0), KIND_GET);
    await sleep(60);
    for (let i = 0; i < 5; i++) {
      this._record('OUT', HANDSHAKE);
      this.output.send(HANDSHAKE);
      await sleep(200);
    }
    const v = await this.request(CMD.FIRMWARE_VERSION, new Uint8Array(0), { timeout: 1500, retries: 2 });
    this.firmware = cString(v, 0, v.length);
    this._log(`connected, firmware ${this.firmware}`);
    return this.firmware;
  }

  close() {
    this.input.removeEventListener('midimessage', this._onMidi);
    this.input.removeEventListener('statechange', this._onState);
    this.output.removeEventListener('statechange', this._onState);
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error('connection closed'));
      this.pending = null;
    }
    this.input.close().catch(() => {});
    this.output.close().catch(() => {});
    this.dispatchEvent(new Event('close'));
  }

  _record(dir, bytes) {
    if (this.trace.length >= this.traceMax) this.trace.splice(0, this.trace.length - this.traceMax + 1);
    const copy = Uint8Array.from(bytes);
    this.trace.push([performance.now() - this.t0, dir, copy]);
    this.dispatchEvent(new CustomEvent('frame', { detail: { dir, bytes: copy } })); // for the sniffer
  }

  /** Raw MIDI trace as text: "<ms> IN|OUT <hex>" per line. */
  traceText() {
    const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
    return this.trace.map(([t, d, b]) => `${t.toFixed(1).padStart(10)} ${d.padEnd(3)} ${hex(b)}`).join('\n') + '\n';
  }

  _send(cmd, payload, kind) {
    const frames = encodeTransfer(cmd, payload, kind);
    const out = (f) => {
      this._record('OUT', f);
      this.output.send(f);
    };
    if (!this.frameDelayMs || frames.length === 1) {
      frames.forEach(out);
      return Promise.resolve();
    }
    return (async () => {
      for (const f of frames) {
        out(f);
        await sleep(this.frameDelayMs);
      }
    })();
  }

  _onMessage(data) {
    this._record('IN', data);
    if (data[0] !== 0xf0) return; // CC, clock, active sensing …
    this.lastRx = performance.now();
    this.stats.frames++;
    this.reasm.push(data, this.lastRx);
  }

  _onReceiveError(e) {
    if (!(e instanceof DamagedFrameError)) {
      this._log('receive: ' + e.message);
      return;
    }
    this.stats.damaged++;
    // The answer we wait for may be the damaged one: fail now instead of waiting for the timeout.
    // (If the frame belonged to something else, this only costs one repeated request.)
    const p = this.pending;
    if (p) {
      clearTimeout(p.timer);
      this.pending = null;
      p.reject(e);
    } else {
      this._log('receive: ' + e.message);
    }
  }

  /** Wait until nothing arrived for `ms` and no multi-frame transfer is open (max `maxMs`). */
  async waitQuiet(ms = 50, maxMs = 2000) {
    const end = performance.now() + maxMs;
    while (performance.now() < end) {
      const idle = performance.now() - this.lastRx;
      if (idle >= ms && !this.reasm.busy) return true;
      await sleep(Math.max(5, ms - idle));
    }
    return false;
  }

  _onTransfer({ cmd, payload, ambiguous }) {
    const p = this.pending;
    if (p && p.cmd === cmd) {
      clearTimeout(p.timer);
      this.pending = null;
      if (ambiguous) p.reject(new Error(`answer to ${hex32(cmd)} was mixed with another transfer`));
      else p.resolve(payload);
      return;
    }
    if (cmd !== CMD.INPUT_LEVEL && cmd !== CMD.OUTPUT_LEVEL) {
      this.dispatchEvent(new CustomEvent('notify', { detail: { cmd, payload } }));
    }
  }

  /** Send one request and wait for the answer with the same cmd. Requests run one after another. */
  request(cmd, payload = new Uint8Array(0), { kind = KIND_GET, timeout = 2000, retries = 0, answer = cmd } = {}) {
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this._requestOnce(cmd, payload, kind, timeout, answer);
        } catch (e) {
          if (attempt >= retries || e.message === 'connection closed') throw e;
          this._log(`${e.message} – retry ${attempt + 1}/${retries}`);
          await this.waitQuiet(200, 4000); // let the rest of a damaged answer pass
        }
      }
    };
    const r = this.queue.then(run, run);
    this.queue = r.catch(() => {});
    return r;
  }

  _requestOnce(cmd, payload, kind, timeout, answer = cmd) {
    return new Promise((resolve, reject) => {
      this.pending = {
        cmd: answer,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pending = null;
          reject(new Error(`no answer to ${hex32(cmd)} within ${timeout} ms`));
        }, timeout),
      };
      this._send(cmd, payload, kind);
    });
  }

  // ---------------------------------------------------------------- high level

  async presetNames() {
    const p = await this.request(CMD.PRESET_LIST, new Uint8Array(0), { timeout: 4000, retries: 2 });
    return parsePresetList(p);
  }

  async currentPreset() {
    return rd32(await this.request(CMD.CURRENT_PRESET), 0);
  }

  /** Active scene 0..2 of the current preset. */
  async currentScene() {
    return rd32(await this.request(CMD.CURRENT_SCENE), 0);
  }

  /** Switch the scene (0..2) of the current preset – what the editor sends. */
  async selectScene(scene) {
    const run = () => this._send(CMD.CURRENT_SCENE, Uint8Array.of(scene), KIND_SET);
    const r = this.queue.then(run, run);
    this.queue = r.catch(() => {});
    await r;
  }

  async selectPreset(index) {
    const run = () => this._send(CMD.CURRENT_PRESET, u32le(index), KIND_SET);
    const r = this.queue.then(run, run);
    this.queue = r.catch(() => {});
    await r;
  }

  /**
   * Preset `index` as TLV bytes (5068 bytes on firmware 2.5). The answer is validated (index, TLV chain);
   * on a broken or mixed-up answer the request is repeated once the line is quiet.
   */
  async readPreset(index, { attempts = 4 } = {}) {
    let last;
    for (let a = 1; a <= attempts; a++) {
      await this.waitQuiet(30);
      try {
        const p = await this.request(CMD.PRESET_DUMP, u32le(index), { timeout: 3000 });
        const got = rd32(p, 0);
        if (got !== index) throw new Error(`asked for preset ${index}, device sent ${got}`);
        const raw = p.slice(4);
        presetInfo(raw); // throws if the TLV chain is broken
        return raw;
      } catch (e) {
        last = e;
        if (e.message === 'connection closed') throw e;
        this._log(`preset ${index}: ${e.message} (attempt ${a}/${attempts})`);
        await this.waitQuiet(200, 4000);
      }
    }
    throw last;
  }

  /**
   * Write a TLV preset into slot `index` like the Hotone editor: PRESET_WRITE (u32 slot + TLV, frames
   * ~40 ms apart), the pedal answers WRITE_ACK [0x01000001, 1, slot]. Callers verify by reading back.
   * Note: like reading, this probably loads the slot on the pedal.
   */
  async writePreset(index, raw) {
    if (!WRITE_CONFIRMED) throw new Error('Writing presets is not enabled.');
    await this.waitQuiet(50);
    const before = this.frameDelayMs;
    this.frameDelayMs = 40;
    let ack;
    try {
      ack = await this.request(CMD.PRESET_WRITE, concat(u32le(index), raw),
        { kind: KIND_SET, answer: CMD.WRITE_ACK, timeout: 4000 });
    } finally {
      this.frameDelayMs = before;
    }
    if (ack.length < 12 || rd32(ack, 0) !== CMD.PRESET_WRITE || rd32(ack, 8) !== index) {
      throw new Error(`unexpected write acknowledgement ${Array.from(ack, (x) => x.toString(16).padStart(2, '0')).join(' ')}`);
    }
    if (rd32(ack, 4) !== 1) throw new Error(`pedal reported status ${rd32(ack, 4)} for the write`);
  }
}

export { PRESET_COUNT };
