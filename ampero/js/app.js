import { AmperoDevice, listPorts, requestMidi } from './device.js';
import {
  CMD, MAX_NAME, MODULES, PRESET_COUNT, STYLES, WRITE_CONFIRMED, compareStored, hex32, presetInfo, presetLabel,
  presetChain, presetRouting, rd32, setPresetName, setPresetStyle, tlvSplit,
  paramPayload, presetParam, savePayload, setPresetParam,
  NAM_SLOTS, UPLOAD_NAME, USER_IRS,
  EMPTY_ALG, presetOn, presetSeq, reorderPayload, setAlgPayload, setPresetAlg, setPresetOn, setPresetSeq, slotOnPayload,
  FACTORY_IRS, SCENE_NAME_LEN, idNamePayload, presetScene, sceneNamePayload, sceneValuePayload, setPresetScene, u32Payload,
  FS_FUNCTIONS, STOMP_FS_FUNCTIONS, STOMP_FS_CTRL, STOMP_FS_FIXED, FS_SET, FS_SLOTS_SET,
  IO, IN_SOURCES, OUT_TARGETS, STOMP_IO, STAGE_IO, IN_CHANNELS, ioHasParams, presetIo, setPresetIoSource, setPresetIoParam,
  ioSourcePayload, ioParamPayload,
  MIDI, fsMidiPayload, midiText, midiValid, patchMidiPayload, presetMidi, setPresetMidi, fsFunctionName, fsSlotsPayload, isCtrlFunction, presetFs, presetFsSlots, setPresetFsClick, setPresetFsSlot,
  checkBlock, presetBlock, setPresetBlock, applyNodeParam, applyRoutingPush, presetSceneCount,
  TEMPLATE, applyTemplate, applyTemplateData, templateSavePayload, CHAIN_MODES,
  QKNOB, presetQuickKnobs, setPresetQuickKnob, qknobPayload,
  EXP, presetExpTargets, setPresetExpTarget, expTargetPayload, expRangePayload,
} from './protocol.js';
import { isNamb, namToNamb } from './nam2namb.js';
import { wavToIr } from './irwav.js';
import { EQ, EQ_BANDS, EQ_VOLUME, GLOBAL_GROUPS, eqValuePayload, groupOf, paramByte, paramPayload as globalPayload, paramValue, parseEq, rawByte, u32 as u32b } from './globals.js';
import { buildBackup, dumpPresets, loadBackup } from './backup.js';
import { decodePrst, encodePrst } from './prst.js';
import { closeMenu, confirmSlots, contextMenu, promptText, showAbout } from './ui.js';
import { initSniffer } from './sniffer-ui.js';
import { moduleIcon } from './icons.js';
import { diffProbes, probe } from './probe.js';
import { commandGroup } from './sniffer.js';
import { algDbLoaded, algInfo, algsOfCategory, categoryNames, clampValue, formatValue, groupsOfCategory, loadAlgDb } from './algdb.js';

const $ = (id) => document.getElementById(id);
let sniffer = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {
  selIo: null, // {out, chain}: input / output node shown in the parameter area (when no block is selected)
  dragCat: null, // module (category) dragged from the legend
  fsPick: false, // "pick blocks in the chain" mode for the selected footswitch
  selFs: 0, // footswitch shown in the footswitch panel (its positions are marked in the chain)
  selExp: 0, // expression pedal shown in the EXP panel (0 EXP1, 1 EXP2)
  fsFollow: false, // footswitch assignments move with a dragged block (option in the footswitch panel)
  access: null,
  dev: null,
  model: '', // from the MIDI port name
  deviceNames: null, // string[300] from the device
  presets: new Map(), // slot -> TLV preset as read from / written to the pedal in this session
  current: -1, // current preset on the device
  scene: -1, // active scene of the current preset
  tab: 'edit',
  listView: 'all', // 'all' | 'style'
  openStyles: new Set(), // expanded groups in the style view
  backup: null, // {manifest, presets}
  restoreStatus: new Map(), // slot index -> {cls, text} of the last restore
  restoreFilter: 'all', // 'all' | 'diff' (only slots whose backup name differs from the device)
  busy: false, // backup / restore / connect / preset action running
  abort: null,
  refreshing: false, // a refresh/poll is running
  namesDue: 0, // time (ms) when the preset names are read again
  lastDev: null, // kept after disconnect, for 'Save trace'
  seen: new Map(), // cmd -> count of unsolicited messages
  otherHost: false, // another program (Hotone software) talks to the pedal: stay quiet until "Resume"
  sniffing: false, // live sniffer running: the app only listens (sends nothing, no pause on other programs)
  probes: [], // last two probe results (older, newer)
  selSlot: -1, // effect slot (0..11) shown in the parameter editor
  dirty: -1, // preset index with parameter changes sent to the pedal but not saved
  dragging: false, // a knob is being dragged: do not rebuild the parameter editor
  dragPos: null, // chain position of the block being dragged
  blockClip: null, // copied block (presetBlock format)
  browse: null, // module browser: {cat, group} (lists of sub-categories and algorithms for the selected block)
  restoring: -1, // slot being restored: ignore the pedal's slot push with default values
  irNames: null, // string[50] user IR names from the pedal
  namNames: null, // string[30] NAM slot names from the pedal ('' = empty)
  uploadStatus: new Map(), // 'ir:3' / 'nam:1' -> {cls, text}
  globals: null, // Map get-command -> answer bytes
  eq: null, // {on, values}
};

// ------------------------------------------------------------------ log / status

function log(text) {
  const t = new Date().toLocaleTimeString();
  const el = $('log');
  el.textContent += `[${t}] ${text}\n`;
  el.scrollTop = el.scrollHeight;
  $('logLast').textContent = text;
}

function setStatus(kind, text) {
  const s = $('status');
  s.className = `status ${kind}`;
  s.textContent = text;
  $('model').hidden = !state.dev || !state.model;
  $('model').textContent = state.model;
}

function onlineStatus() {
  if (!state.dev) return setStatus('off', 'offline');
  const extra = state.sniffing ? ' · sniffing' : state.otherHost ? ' · paused' : '';
  setStatus(state.otherHost || state.sniffing ? 'busy' : 'on', `online · ${state.dev.firmware}${extra}`);
}

/** Model from the MIDI port name ("Ampero II Stomp", "MIDIIN2 (Ampero II Stage)", "MP-300" …). */
function modelName(port) {
  const n = (port?.name || '').replace(/^MIDI(IN|OUT)\d*\s*\((.*)\)$/i, '$2').replace(/^\d+-\s*/, '').trim();
  if (/mp-?300/i.test(n)) return 'Ampero II Stomp';
  return n;
}

/** The app may send something to the pedal now (connected, idle, not paused, not sniffing). */
function canTalk() {
  return !!state.dev && !state.busy && !state.otherHost && !state.sniffing;
}

function updateButtons() {
  const online = !!state.dev;
  const free = canTalk();
  $('connectBtn').textContent = online ? 'Disconnect' : 'Connect';
  $('connectBtn').disabled = state.busy;
  $('dumpBtn').disabled = !free;
  $('cancelBtn').disabled = !state.busy || !state.abort;
  $('traceBtn').disabled = !state.lastDev;
  $('irReadBtn').disabled = !free;
  $('globalReadBtn').disabled = !free;
  for (const x of document.querySelectorAll('#globalCards select, #globalCards input, #globalCards button')) x.disabled = !free || !state.globals;
  $('namReadBtn').disabled = !free;
  for (const b of document.querySelectorAll('#page-files .up-btn')) b.disabled = !free;
  $('refreshAllBtn').disabled = !free;
  $('refreshCurBtn').disabled = !free;
  $('restoreBtn').disabled = !free || !WRITE_CONFIRMED || !selectedRestore().length;
  $('prRun').disabled = !free;
  $('prCancel').disabled = !state.busy || !state.abort;
  $('prSave').disabled = !state.probes.length;
  const rs = $('readStylesBtn');
  if (rs) rs.disabled = !free;
}

// ------------------------------------------------------------------ pages

function showTab(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const p of document.querySelectorAll('.page')) p.hidden = p.id !== `page-${tab}`;
  document.querySelector('.layout').classList.toggle('no-sidebar', tab !== 'edit');
  $('editHint').hidden = tab !== 'edit';
  if (location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`);
  closeMenu();
  if (tab === 'edit') {
    requestAnimationFrame(drawRouting);
    requestAnimationFrame(scrollToCurrent);
  }
  if (tab === 'global') {
    renderGlobals();
    if (canTalk() && !state.globals) readGlobals();
  }
  if (tab === 'files') {
    renderFiles();
    if (canTalk() && (!state.irNames || !state.namNames)) readFileLists();
  }
}

// ------------------------------------------------------------------ ports / connection

function fillPorts() {
  const { inputs, outputs, input, output } = listPorts(state.access);
  const fill = (sel, ports, pick) => {
    const keep = sel.value;
    sel.innerHTML = '';
    if (!ports.length) sel.add(new Option('(no MIDI ports)', ''));
    for (const p of ports) sel.add(new Option(p.name, p.id));
    if (ports.length && !pick) sel.add(new Option('(no Ampero found – choose a port)', ''), 0);
    // keep the user's choice; otherwise preselect the Ampero, never just the first port (e.g. "Midi Through")
    sel.value = ports.some((p) => p.id === keep) ? keep : pick?.id ?? '';
  };
  fill($('inPort'), inputs, input);
  fill($('outPort'), outputs, output);
}

/** Connect by itself when an Ampero port pair is present (not after the user disconnected on purpose). */
function autoConnect() {
  if (state.dev || state.busy || state.manualOff || !state.access) return;
  const { input, output } = listPorts(state.access);
  if (!input || !output) {
    if (!state.dev) $('status').title = 'no Ampero found – plug it in, or choose the ports manually (⚙)';
    return;
  }
  $('inPort').value = input.id;
  $('outPort').value = output.id;
  connect(true);
}

async function connect(auto = false) {
  if (state.dev) {
    state.manualOff = true; // stays disconnected until "Connect" is pressed again
    state.dev.close();
    return;
  }
  if (auto !== true) state.manualOff = false;
  const input = state.access.inputs.get($('inPort').value);
  const output = state.access.outputs.get($('outPort').value);
  if (!input || !output) {
    log('Select the MIDI input and output of the Ampero first.');
    return;
  }
  const dev = new AmperoDevice(input, output);
  state.lastDev = dev;
  state.seen.clear();
  state.otherHost = false;
  state.presets.clear();
  state.irNames = state.namNames = null;
  state.globals = state.eq = null;
  state.uploadStatus.clear();
  state.model = modelName(input);
  dev.addEventListener('log', (e) => log(e.detail));
  dev.addEventListener('notify', (e) => onNotify(e.detail));
  dev.addEventListener('close', () => {
    if (state.dev !== dev) return;
    sniffer.deviceClosed(dev);
    state.dev = null;
    state.otherHost = false;
    $('otherHostNotice').hidden = true;
    state.current = -1;
    state.scene = -1;
    renderCurrent();
    renderList();
    onlineStatus();
    updateButtons();
  });
  state.busy = true;
  updateButtons();
  setStatus('busy', 'connecting…');
  try {
    await dev.open();
    state.dev = dev;
    onlineStatus();
    state.deviceNames = await dev.presetNames();
    state.namesDue = performance.now() + NAMES_POLL_MS;
    await refreshCurrent();
    log(`${state.model || 'device'}: preset list read (${state.deviceNames.length} names), current preset ${presetLabel(state.current)}`);
    renderList();
    renderCurrent();
    renderRestore();
  } catch (e) {
    log(`connect failed: ${e.message}`);
    log('Is the Hotone software closed? It must not talk to the pedal at the same time.');
    dev.close();
    onlineStatus();
  } finally {
    state.busy = false;
    updateButtons();
  }
  // like the Hotone software at start-up: read the preset that is active on the pedal, so the editor shows it
  if (state.dev === dev && state.current >= 0 && !state.presets.has(state.current)) await readIntoView(state.current);
  // names of the uploaded NAM models / IRs, shown under NAM and user IR blocks
  if (state.dev === dev && canTalk()) {
    await readFileLists();
    renderEditor();
  }
}

// ------------------------------------------------------------------ preset cache

/** Remember a preset as it is on the pedal now (read, written, or pushed by the pedal). */
function cachePreset(index, raw) {
  let info;
  try {
    info = presetInfo(raw);
  } catch {
    return;
  }
  const old = state.presets.get(index);
  state.presets.set(index, raw);
  if (state.deviceNames && state.deviceNames[index] !== info.name) {
    state.deviceNames = state.deviceNames.slice();
    state.deviceNames[index] = info.name;
  }
  const oldInfo = old ? presetInfo(old) : null;
  const nameChanged = oldInfo ? oldInfo.name !== info.name : false;
  const styleChanged = state.listView === 'style' && (!oldInfo || oldInfo.style !== info.style);
  if (nameChanged || styleChanged) renderList();
  if (index === state.current) renderCurrent();
}

/** Style of a slot: '' = none, null = not known (not read in this session). */
function styleOf(i) {
  if (!state.deviceNames && state.backup) {
    const p = state.backup.presets.find((x) => x.index === i);
    return p ? p.style : null;
  }
  const raw = state.presets.get(i);
  return raw ? presetInfo(raw).style : null;
}

// ------------------------------------------------------------------ notifications from the pedal

/**
 * The pedal pushes the dump of a preset by itself when the preset is switched on the pedal and after a
 * preset was saved on the pedal (e.g. renamed): take name and content from it right away.
 * (debug/ampero_trace_2026-11-06-10-32-01.txt: rename + save of A99-1 -> 03000003, dump of 297, 05000012)
 */
function onPushedDump(payload) {
  if (payload.length < 12) return;
  const index = rd32(payload, 0);
  if (index >= PRESET_COUNT) return;
  const raw = payload.slice(4);
  let name;
  try {
    name = presetInfo(raw).name;
  } catch {
    return; // damaged - the next names poll catches it
  }
  if (state.deviceNames && state.deviceNames[index] !== name) {
    log(`${presetLabel(index)} is now "${name}" (was "${state.deviceNames[index]}")`);
    renderRestore();
  }
  cachePreset(index, raw);
  setCurrent(index, state.scene);
  renderCurrent();
}

function onNotify({ cmd, payload }) {
  if (cmd === CMD.SLOT_PUSH) {
    onSlotPush(payload);
    return;
  }
  if (cmd === TEMPLATE.DATA) {
    applyTemplateRecord(payload);
    return;
  }
  // the pedal changed the routing of the current preset by itself (e.g. after a block was inserted)
  if (cmd === CMD.ROUTING_PUSH || cmd === CMD.SPLIT_PARAM || cmd === CMD.MIX_PARAM) {
    const raw = state.presets.get(state.current);
    if (raw) {
      try {
        const next = cmd === CMD.ROUTING_PUSH ? applyRoutingPush(raw, payload) : applyNodeParam(raw, cmd, payload);
        state.presets.set(state.current, next);
        if (cmd === CMD.ROUTING_PUSH) log(`pedal changed the routing: ${presetRouting(next).name}`);
        if (!state.dragging) renderEditor();
      } catch { /* ignore */ }
    }
    return;
  }
  if (cmd === CMD.PRESET_DUMP) {
    if (!state.busy) onPushedDump(payload); // while busy the dumps are our own (late) answers
    return;
  }
  if (cmd === CMD.CURRENT_PRESET && payload.length >= 4) {
    setCurrent(rd32(payload, 0), state.scene);
  } else if (cmd === CMD.CURRENT_SCENE && payload.length >= 1) {
    if (!state.sceneHop) setCurrent(state.current, payload[0]); // not while a block change hops to scene 1
  }
  // Something was stored or changed by another program (the pedal forwards other hosts' set commands and
  // acknowledgements): read the names again soon.
  if (cmd === CMD.WRITE_ACK || cmd === CMD.PRESET_CHANGED || cmd === CMD.PRESET_SAVED ||
      ((cmd >>> 24) === 0x01 && (cmd & 0xffff) === 0x0001)) {
    state.namesDue = Math.min(state.namesDue, performance.now() + 300);
  }
  // edits made on the pedal itself (footswitch assignment, functions, order) arrive with the same commands as an
  // editor's set commands – apply them, they are no sign of another program
  // (block on/off is always applied: the pedal reports the whole state of the scene, e.g. after a footswitch)
  if (cmd === CMD.SLOT_ON || !state.dev?.askedRecently(cmd)) applyPedalEdit(cmd, payload);
  if (OTHER_HOST_SIGNS.has(cmd) || (cmd === CMD.WRITE_ACK && !state.busy)) {
    otherHostDetected(cmd);
  }
  if (cmd === CMD.CURRENT_SCENE || cmd === CMD.CURRENT_PRESET || cmd === CMD.PRESET_CHANGED ||
      cmd === CMD.PRESET_SAVED || cmd === CMD.NAME_EDIT) return;
  const n = (state.seen.get(cmd) || 0) + 1;
  state.seen.set(cmd, n);
  if (n === 1 || n === 10 || n === 100 || n % 1000 === 0) {
    log(`device message ${hex32(cmd)} (${payload.length} bytes)${n > 1 ? ` – ${n}x so far` : ''}`);
  }
}

/** Apply an edit the pedal reports (made on the pedal) to the cached current preset. */
function applyPedalEdit(cmd, p) {
  const raw = state.presets.get(state.current);
  if (!raw) return;
  let next = null;
  try {
    if (cmd === FS_SLOTS_SET && p.length >= 13 && p[0] < 3) {
      next = raw;
      for (let s = 0; s < 12; s++) next = setPresetFsSlot(next, p[0], s, p[1 + s] === 1);
    } else if (cmd === FS_SET && p.length >= 3) {
      next = raw;
      for (let f = 0; f < 3; f++) next = setPresetFsClick(next, f, p[f]);
    } else if (cmd === CMD.SLOT_ON && p.length >= 13 && p[0] < presetSceneCount(raw)) {
      // u8 scene, u8 on[12] (+ 7 more bytes in the pedal's report) – sent when a footswitch switches blocks
      next = raw;
      for (let s = 0; s < 12; s++) next = setPresetOn(next, p[0], s, p[1 + s] === 1);
      if (presetOn(next, p[0]).join() === presetOn(raw, p[0]).join()) return;
    } else if (cmd === CMD.REORDER && p.length >= 12) {
      next = setPresetSeq(raw, Array.from(p.subarray(0, 12)));
    }
  } catch { /* ignore */ }
  if (!next) return;
  state.presets.set(state.current, next);
  log(`changed on the pedal: ${hex32(cmd)} ${Array.from(p.subarray(0, 13), (b) => b.toString(16).padStart(2, '0')).join(' ')}`);
  if (!state.dragging) renderEditor();
}

// ------------------------------------------------------------------ other program on the pedal
//
// The pedal sends its answers to every connected program. The Hotone software does not cope with answers
// it did not ask for: it crashed while importing a preset with this app connected (polling), and worked
// with the app disconnected. So as soon as the app sees traffic of another program, it stops talking to
// the pedal on its own (no polling, no reading/writing) until the user clicks "Resume".
// Signs: answers to requests this app never sends (the Hotone software's start-up queries), a preset list
// nobody here asked for, set commands / write acknowledgements of another program (forwarded by the pedal).

const OTHER_HOST_SIGNS = new Set([
  0x010a0003, 0x000a0000, 0x04000003, 0x0300000a, 0x07000003, 0x08000003, 0x05000013, 0x00070000,
  CMD.PRESET_LIST, CMD.FIRMWARE_VERSION,
]);

function otherHostDetected(cmd) {
  if (state.otherHost || state.sniffing) return; // while sniffing, other programs are what we want to see
  const dev = state.dev ?? state.lastDev;
  // not a sign of another program: a late or repeated answer to our own request, or what the pedal reports by
  // itself right after connecting (e.g. its firmware version)
  if (dev?.askedRecently(cmd) || !dev?.connectedAt || performance.now() - dev.connectedAt < 5000) return;
  state.otherHost = true;
  console.warn('other host detected by', hex32(cmd), 'asked:', [...(dev?.asked ?? [])].map(([c, t]) => `${hex32(c)} ${Math.round(performance.now() - t)} ms ago`));
  log(`Another program is talking to the pedal (message ${hex32(cmd)}) – probably the Hotone software. ` +
    'Automatic refresh and all reading/writing are paused so it is not disturbed. Click "Resume" after closing it.');
  updateOtherHost();
}

function updateOtherHost() {
  $('otherHostNotice').hidden = !state.otherHost || !state.dev;
  onlineStatus();
  updateButtons();
}

/** Live sniffer started/stopped: the app becomes a pure listener and does not pause on other programs. */
function setSniffing(active) {
  state.sniffing = active;
  if (active) {
    state.otherHost = false;
    if (state.dev) log('sniffing: the app now only listens – no polling, no pause when the Hotone software talks to the pedal');
  } else {
    state.namesDue = 0; // read everything again
    if (state.dev) log('sniffer stopped: automatic refresh is on again');
  }
  updateOtherHost();
}

function resumeAfterOtherHost() {
  state.otherHost = false;
  state.namesDue = 0; // read everything again
  log('resumed');
  updateOtherHost();
  poll();
}

// ------------------------------------------------------------------ refresh / polling
//
// The pedal does not report every change made on the pedal itself, so the app polls: the current preset +
// scene every second, the preset names every 10 s – and immediately when another program stored something,
// when the window gets focus, or on the refresh buttons. Polling pauses while busy. Reading the names does
// not load any preset.

const CURRENT_POLL_MS = 1000;
const NAMES_POLL_MS = 10000;

function setCurrent(index, scene) {
  if (index === state.current && scene === state.scene) return;
  const changed = index !== state.current;
  if (changed) {
    // the pedal drops unsaved changes when another preset is loaded: our edited copy is out of date too
    if (state.dirty >= 0 && state.dirty === state.current) {
      state.presets.delete(state.dirty);
      log(`${presetLabel(state.dirty)}: unsaved changes discarded (other preset selected)`);
    }
    state.dirty = -1;
    state.selSlot = -1;
    state.browse = null;
  }
  state.current = index;
  state.scene = scene;
  renderCurrent();
  if (changed) markCurrentInList();
}

/** Preset content for display: as read from the pedal, or from the loaded backup when not connected. */
function knownPreset(i) {
  if (state.presets.has(i)) return state.presets.get(i);
  if (!state.deviceNames && state.backup) return state.backup.presets.find((p) => p.index === i)?.raw ?? null;
  return null;
}

function renderCurrent() {
  const i = state.current;
  $('curLabel').textContent = i >= 0 ? presetLabel(i) : '–';
  $('curName').textContent = i >= 0 ? listEntries().names[i] ?? '' : '';
  $('curScene').textContent = i >= 0 && state.scene >= 0 ? `Scene ${state.scene + 1}` : '';
  renderEditor();
}

async function refreshCurrent() {
  const dev = state.dev;
  if (!dev) return;
  const index = await dev.currentPreset();
  const scene = await dev.currentScene().catch(() => -1);
  if (!state.sceneHop) setCurrent(index, scene);
}

async function refreshNames() {
  const dev = state.dev;
  if (!dev) return;
  const names = await dev.presetNames();
  state.namesDue = performance.now() + NAMES_POLL_MS;
  const old = state.deviceNames;
  const changed = !old || names.some((n, i) => n !== old[i]);
  if (changed && old) {
    const diff = names.map((n, i) => (n !== old[i] ? `${presetLabel(i)} "${n}"` : null)).filter(Boolean);
    log(`preset names changed: ${diff.slice(0, 5).join(', ')}${diff.length > 5 ? ` and ${diff.length - 5} more` : ''}`);
    // a cached preset whose name changed elsewhere is out of date
    names.forEach((n, i) => {
      if (n !== old[i]) state.presets.delete(i);
    });
  }
  state.deviceNames = names;
  if (changed) {
    renderList();
    renderCurrent();
    renderRestore();
  }
}

/** what: 'all' | 'names' | 'current'. manual = from a button: waits for a running poll, logs the result. */
async function refresh(what, manual = false) {
  if (manual) while (state.refreshing) await sleep(50);
  if (!canTalk() || state.refreshing) return;
  state.refreshing = true;
  try {
    if (what === 'all' || what === 'names') await refreshNames();
    if (what === 'all' || what === 'current') await refreshCurrent();
    if (manual) {
      log(what === 'current'
        ? `current preset: ${presetLabel(state.current)} "${state.deviceNames?.[state.current] ?? ''}", scene ${state.scene + 1}`
        : 'preset list refreshed');
    }
  } catch (e) {
    if (manual) log(`refresh failed: ${e.message}`);
  } finally {
    state.refreshing = false;
  }
}

function poll() {
  if (!canTalk() || state.refreshing || document.hidden) return;
  refresh(performance.now() >= state.namesDue ? 'all' : 'current');
}

// ------------------------------------------------------------------ preset list (sidebar, Edit page)

function listEntries() {
  if (state.deviceNames) return { src: 'device', names: state.deviceNames };
  if (state.backup) {
    const names = new Array(PRESET_COUNT).fill(null);
    for (const p of state.backup.presets) names[p.index] = p.name;
    return { src: 'backup', names };
  }
  return { src: '', names: [] };
}

function presetItem(i, name, extraClass = '') {
  const label = presetLabel(i);
  const li = document.createElement('li');
  li.className = `${i === state.current ? 'current' : ''} ${extraClass}`;
  li.dataset.index = i;
  li.innerHTML = '<span class="lbl"></span><span class="nm"></span><span class="menu-btn" title="menu">☰</span>';
  li.children[0].textContent = label;
  li.children[1].textContent = name;
  li.title = `${label} ${name}`;
  return li;
}

/** Click on a preset: select it on the pedal (single click). */
async function selectFromList(i) {
  if (i === state.current) return;
  if (!canTalk()) {
    log(`select ${presetLabel(i)}: not possible now${!state.dev ? ' (not connected)' : state.sniffing
      ? ' (the sniffer is running – listen only)' : state.otherHost ? ' (paused: another program uses the pedal)'
      : ' (busy)'}`);
    return;
  }
  setCurrent(i, state.scene); // highlight at once
  await state.dev.selectPreset(i);
  // like the Hotone software: read the preset that was just selected (it is freshly loaded, so reading it
  // loses nothing) – selecting from the app does not make the pedal push it
  await readIntoView(i);
}

/** Read slot i from the pedal for the editor view (the slot is or becomes the loaded preset). */
async function readIntoView(i) {
  if (!canTalk()) return;
  try {
    cachePreset(i, await state.dev.readPreset(i));
  } catch (e) {
    log(`read ${presetLabel(i)}: ${e.message}`);
  }
  renderCurrent();
}

/** Delegated mouse handling for the preset list (items are redrawn often). */
function initPresetListEvents() {
  const ul = $('presetList');
  const itemOf = (e) => e.target.closest('li[data-index]');
  ul.addEventListener('click', (e) => {
    const li = itemOf(e);
    if (!li) return;
    const i = +li.dataset.index;
    if (e.target.closest('.menu-btn')) {
      const r = e.target.getBoundingClientRect();
      openPresetMenu(i, r.right, r.top, li);
      return;
    }
    selectFromList(i);
  });
  ul.addEventListener('contextmenu', (e) => {
    const li = itemOf(e);
    if (!li) return;
    e.preventDefault();
    openPresetMenu(+li.dataset.index, e.clientX, e.clientY, li);
  });
}

/** Only the highlight of the current preset changes – no redraw of the list. */
function markCurrentInList() {
  for (const li of $('presetList').querySelectorAll('li[data-index]')) {
    li.classList.toggle('current', +li.dataset.index === state.current);
  }
  scrollToCurrent();
}

/** Scroll the preset list so that the current preset is visible (no movement if it already is). */
function scrollToCurrent() {
  const li = $('presetList').querySelector('li.current');
  if (li && li.offsetParent) li.scrollIntoView({ block: 'nearest' });
}

function renderList() {
  const { src, names } = listEntries();
  const q = $('search').value.trim().toLowerCase();
  const ul = $('presetList');
  const scroll = ul.scrollTop;
  ul.innerHTML = '';
  const match = (name, i) => !q || name.toLowerCase().includes(q) || presetLabel(i).toLowerCase().includes(q);
  $('viewAll').classList.toggle('on', state.listView === 'all');
  $('viewStyle').classList.toggle('on', state.listView === 'style');

  if (state.listView === 'all') {
    $('styleInfo').hidden = true;
    names.forEach((name, i) => {
      if (name != null && match(name, i)) ul.appendChild(presetItem(i, name));
    });
  } else {
    // style view: groups like the Hotone software, plus "No style" and "Not read yet"
    const groups = new Map([...STYLES, '', null].map((s) => [s, []]));
    names.forEach((name, i) => {
      if (name == null || !match(name, i)) return;
      const s = styleOf(i);
      (groups.has(s) ? groups.get(s) : groups.get(null)).push(i);
    });
    const unknown = groups.get(null).length;
    renderStyleInfo(src, unknown);
    for (const [style, list] of groups) {
      if ((style === '' || style === null) && !list.length) continue;
      const key = style === null ? '?' : style;
      const open = state.openStyles.has(key) || (q && list.length);
      const head = document.createElement('li');
      head.className = `style-group ${style === null ? 'unknown' : ''}`;
      head.innerHTML = '<span class="count"></span><span class="nm"></span><span class="chev"></span>';
      head.children[0].textContent = list.length;
      head.children[1].textContent = style === null ? 'Not read yet' : style || 'No style';
      head.children[2].textContent = open ? '▴' : '▾';
      head.onclick = () => {
        if (state.openStyles.has(key)) state.openStyles.delete(key);
        else state.openStyles.add(key);
        renderList();
      };
      ul.appendChild(head);
      if (open) for (const i of list) ul.appendChild(presetItem(i, names[i], 'in-group'));
    }
  }
  ul.scrollTop = scroll;
  scrollToCurrent();
}

function renderStyleInfo(src, unknown) {
  const box = $('styleInfo');
  if (src !== 'device' || !unknown) {
    box.hidden = src !== 'backup';
    box.textContent = src === 'backup' ? 'Styles from the loaded backup (not connected).' : '';
    return;
  }
  box.hidden = false;
  box.innerHTML = '';
  box.append(`The style of ${unknown} preset${unknown > 1 ? 's' : ''} is not known yet: the app learns it when a preset ` +
    'is read (backup, export, rename …) or when you switch to it on the pedal.');
  const b = document.createElement('button');
  b.id = 'readStylesBtn';
  b.className = 'small-btn';
  b.textContent = `Read all styles (~${Math.ceil(unknown * 0.65 / 60)} min)`;
  b.title = 'reads every unknown preset – the pedal loads each one while it is read';
  b.onclick = readStyles;
  box.append(document.createElement('br'), b);
  updateButtons();
}

// ------------------------------------------------------------------ editor (mockup)

function renderEditor() {
  const i = state.current;
  const raw = i >= 0 ? knownPreset(i) : null;
  let info = null;
  try {
    info = raw ? presetInfo(raw) : null;
  } catch { /* ignore */ }
  $('edLabel').textContent = i >= 0 ? presetLabel(i) : '–';
  $('edName').textContent = i >= 0 ? listEntries().names[i] ?? info?.name ?? '' : 'No preset';
  const styleSel = $('edStyleSel');
  const canStyle = i >= 0 && !!info && canTalk();
  $('edStyle').hidden = canStyle || !info?.style;
  $('edStyle').textContent = info?.style ?? '';
  styleSel.hidden = !canStyle;
  if (canStyle) {
    if (!styleSel.options.length) {
      styleSel.append(new Option('No style', ''));
      for (const s of STYLES) styleSel.append(new Option(s, s));
    }
    styleSel.value = info.style ?? '';
    styleSel.disabled = state.dirty === i;
    styleSel.title = state.dirty === i ? 'save the preset first (setting the style writes the stored preset)' : 'style of this preset';
  }
  const scene = Math.max(0, state.scene);
  const scenes = $('edScenes').children;
  for (let s = 0; s < 5; s++) {
    const n = sceneCount();
    scenes[s].hidden = s >= n && s !== scene;
    let name = `Scene ${s + 1}`;
    try {
      name = s < n ? info?.scenes[s] || name : name;
    } catch { /* ignore */ }
    scenes[s].textContent = name;
    scenes[s].classList.toggle('on', s === scene);
    scenes[s].title = s >= n ? 'the pedal is in this scene (switched by a footswitch), which this preset does not have – it cannot be edited'
      : raw ? 'click: select · double-click: rename' : '';
    scenes[s].disabled = s >= n;
  }
  let sv = null;
  try {
    sv = raw ? sceneMeta(raw, scene) : null;
  } catch { /* ignore */ }
  const live = !!sv && canTalk();
  $('edTempo').disabled = $('edVolume').disabled = !live;
  markDirty();
  if (document.activeElement !== $('edTempo')) $('edTempo').value = sv ? sv.tempo : '';
  if (document.activeElement !== $('edVolume')) $('edVolume').value = sv ? sv.volume : 0;
  $('edVolumeVal').textContent = sv ? $('edVolume').value : '';
  let chain = [];
  try {
    chain = raw ? presetChain(raw) : [];
  } catch { /* ignore */ }
  const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls, textContent: text ?? '' });
  // routing: where row 1 splits into row 2 and where they merge (nothing is guessed for unknown presets)
  let rt = null;
  try {
    if (raw) rt = presetRouting(raw);
  } catch { /* ignore */ }
  const cm = $('chainMode');
  cm.innerHTML = '';
  if (rt) {
    cm.textContent = `Chain: ${rt.name} `;
    cm.title = `routing bytes (tag 6 @2,4,6,456,457): ${rt.bytes.map((x) => x.toString(16).padStart(2, '0')).join(' ')}`;
    const tb = el('button', 'small-btn', 'Template ▾');
    tb.title = 'choose a chain template (factory or user) or save the current routing as user template';
    tb.disabled = !canTalk();
    tb.onclick = (e) => templateMenu(e);
    cm.append(tb);
  } else if (i >= 0) {
    cm.append('Content of this preset not loaded yet. ');
    if (state.dev) {
      const btn = el('button', 'small-btn', 'Read from pedal');
      btn.title = 'reads the current preset – it is loaded again from memory, unsaved changes on the pedal are lost';
      btn.disabled = !canTalk();
      btn.onclick = () => readIntoView(i);
      cm.append(btn);
    }
  }
  $('chain').className = `chain${raw ? '' : ' unknown'}${fsPicking(raw) ? ' fs-picking' : ''}`;
  if (fsPicking(raw)) {
    const hint = el('span', 'fs-pick-hint', ` Click blocks to assign them to FS${state.selFs + 1} `);
    const done = el('button', 'small-btn', 'Done');
    done.onclick = () => setFsPick(false);
    cm.append(hint, done);
  }
  const split = rt?.split ?? null, merge = rt?.merge ?? null, serial = !!rt?.serial;

  // inputs / outputs: row 1 always has an input; row 2 only without split. Row 1 has an output unless the
  // chain is serial; row 2 only without merge (in serial mode it carries the main output).
  const twoIn = rt && split === null, twoOut = rt && merge === null && !serial;
  // input / output nodes: black hexagon, white (inputs) or orange (outputs) outline, arrow or number in that color
  const io = (on, label, out, chainNo) => {
    if (!on) return el('span', 'io-gap');
    const isSel = state.selSlot < 0 && state.selIo?.out === out && state.selIo?.chain === chainNo;
    const n = el('span', `io${out ? ' out' : ''}${isSel ? ' sel' : ''}`);
    const inner = label === '→' ? '<path d="M12 20h15M21 14l6 6-6 6"/>' : `<text x="20" y="20">${label}</text>`;
    n.innerHTML = `<svg viewBox="0 0 40 40"><polygon points="11,3 29,3 38,20 29,37 11,37 2,20"/>${inner}</svg>`;
    n.title = `${out ? 'output' : 'input'} of chain ${chainNo ? 'B' : 'A'} – click for its settings`;
    if (raw) {
      n.onclick = () => {
        state.selIo = { out, chain: chainNo };
        state.selSlot = -1;
        state.browse = null;
        renderEditor();
      };
    }
    return n;
  };
  $('chainLeft').replaceChildren(io(!!rt, twoIn ? '1' : '→', false, 0), io(twoIn, '2', false, 1));
  $('chainRight').replaceChildren(io(!!rt && !serial, twoOut ? '1' : '→', true, 0), io(!!rt && merge === null, serial ? '→' : '2', true, 1));

  // drag & drop: drop a block on another position = swap the two positions (like the Hotone software)
  const dnd = (b, c) => {
    if (!raw || !c) return;
    b.ondragover = (e) => {
      if (state.dragCat != null) { // a module from the legend: insert / replace here
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        b.classList.add('drop');
        return;
      }
      if (state.dragPos == null || state.dragPos === c.pos) return;
      e.preventDefault();
      b.classList.add('drop');
    };
    b.ondragleave = () => b.classList.remove('drop');
    b.ondrop = (e) => {
      e.preventDefault();
      b.classList.remove('drop');
      if (state.dragCat != null) {
        const cat = state.dragCat;
        state.dragCat = null;
        dropModule(c, cat);
        return;
      }
      const from = state.dragPos;
      state.dragPos = null;
      if (from != null && from !== c.pos) swapPositions(from, c.pos);
    };
  };
  const box = (c) => {
    if (!c || c.code === 0xffffffff) {
      const e = el('div', `fx empty${c && c.slot === state.selSlot ? ' sel' : ''}${c && fsMarked(raw, c.pos) ? ' fs-mark' : ''}`, '+');
      const badges = c && raw ? fsBadges(raw, c.pos) : null;
      if (badges) e.append(badges);
      if (c && raw) {
        e.title = `empty position ${c.pos + 1} – click to insert a block, or drop one here`;
        e.onclick = () => {
          if (fsPicking(raw)) return toggleFsSlot(state.selFs, c.pos);
          state.selSlot = c.slot;
          state.browse = null;
          renderEditor();
        };
        e.oncontextmenu = (ev) => blockMenu(ev, raw, c);
        dnd(e, c);
      }
      return e;
    }
    const alg = algInfo(c.code);
    // module from the effect database: the highest byte of the code is ambiguous (0x06 = FX LOOP/SND/RTN, VOL, …)
    const mod = alg?.module ?? MODULES[c.code >>> 24] ?? '?';
    const on = raw ? sceneOn(raw, scene)[c.slot] : c.on[scene];
    const b = el('div', `fx m-${mod.replace(/ /g, '-')}${on ? '' : ' off'}`);
    const icon = el('span', 'fx-icon');
    icon.innerHTML = moduleIcon(mod) || moduleIcon(/^FX /.test(mod) ? 'FX LOOP' : '') || mod.slice(0, 3);
    if (c.slot === state.selSlot) b.classList.add('sel');
    if (fsMarked(raw, c.pos)) b.classList.add('fs-mark');
    b.onclick = () => {
      if (fsPicking(raw)) return toggleFsSlot(state.selFs, c.pos);
      state.selSlot = c.slot;
      state.browse = null;
      renderEditor();
    };
    b.oncontextmenu = (ev) => blockMenu(ev, raw, c);
    const dot = el('span', 'fx-state');
    dot.title = `${on ? 'on' : 'off'} in scene ${scene + 1} – click to switch`;
    dot.onclick = (e) => {
      e.stopPropagation();
      toggleOn(c.slot);
    };
    if (raw) {
      b.draggable = true;
      b.ondragstart = (e) => {
        state.dragPos = c.pos;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(c.pos));
      };
      b.ondragend = () => {
        state.dragPos = null;
      };
      dnd(b, c);
    }
    const pos = `${c.pos < 6 ? 'A' : 'B'}${(c.pos % 6) + 1}`;
    b.append(el('span', 'fx-label', mod), icon, dot, el('span', 'fx-pos', pos));
    const badges = fsBadges(raw, c.pos);
    if (badges) b.append(badges);
    const shown = blockName(c.code, alg);
    if (shown) b.append(el('span', 'fx-name', shown));
    b.title = `${pos} · ${shown || mod}${alg && shown !== alg.name ? ` (${alg.name})` : ''} (${mod}) – slot ${c.slot + 1}, algorithm ` +
      `0x${c.code.toString(16).padStart(8, '0')}, ${on ? 'on' : 'off'} in scene ${scene + 1}` +
      `${fsAssignments(raw, c.pos).length ? `, switched by ${fsAssignments(raw, c.pos).map((n) => `FS${n}`).join(' + ')}` : ''}`;
    return b;
  };
  const nodes = (target, k) => {
    if (split === k) target.append(el('span', 'chain-link'), el('span', 'node split'));
    if (merge === k) target.append(el('span', 'chain-link'), el('span', 'node merge'));
  };
  const rowA = $('chainRowA'), rowB = $('chainRowB');
  rowA.replaceChildren();
  rowB.replaceChildren();
  for (let k = 0; k < 6; k++) {
    nodes(rowA, k);
    rowA.append(el('span', 'chain-link'), box(chain[k]));
    rowB.append(el('span', 'chain-link'), box(chain[6 + k]));
  }
  nodes(rowA, 6);
  if (!serial) rowA.append(el('span', 'chain-link')); // serial: row 1 ends in the node, no output
  rowB.append(el('span', 'chain-link'));
  requestAnimationFrame(drawRouting);
  renderParams(raw, chain);
  renderLegend(raw, chain);
  renderFs(raw, chain);
  fillRanges();
}

// ------------------------------------------------------------------ chain templates

async function templateMenu(e) {
  const r = e.currentTarget.getBoundingClientRect();
  let users = [];
  try {
    users = await state.dev.templateNames();
  } catch (err) {
    log(`user templates: ${err.message}`);
  }
  contextMenu(r.left, r.bottom + 2, [
    { label: 'Factory template', items: CHAIN_MODES.map((m) => ({ label: m.name, action: () => selectTemplate(m.id, m) })) },
    { label: 'User template', disabled: !users.length, items: users.map((n, k) => ({
      label: n || `(empty ${k + 1})`, disabled: !n, action: () => selectTemplate(TEMPLATE.USER_BASE + k, null, n) })) },
    '-',
    { label: 'Save current routing as user template… (untested)', disabled: !users.length, action: () => saveTemplate(users) },
  ]);
}

/** Select a chain template. For factory templates the app sets the known routing bytes; the pedal reports what it
 *  did (routing push), which overrides that. */
async function selectTemplate(id, mode, name) {
  if (!editPreset((raw) => (mode ? applyTemplate(raw, mode) : raw))) return;
  renderEditor();
  state.templateData = false;
  // the chain structure changes: like block changes only in scene 1
  if (!(await inScene1('chain template', (dev) => dev.send(TEMPLATE.SELECT, u32Payload(id))))) return;
  log(`chain template: ${mode ? mode.name : `user "${name}"`}`);
  if (mode) return;
  // a user template's routing is only known to the pedal: take it from the template data it reports
  // (0x02000000); if it does not report it by itself, ask for it (assumption: get with u32 template)
  await state.dev.waitQuiet(300, 1500);
  if (state.templateData) return;
  try {
    const p = await state.dev.request(TEMPLATE.DATA, u32Payload(id), { timeout: 2000 });
    applyTemplateRecord(p);
  } catch (e) {
    log(`routing of the user template not received (${e.message}) – it is shown after saving the preset`);
  }
}

/** A template data record: take its routing into our copy of the current preset. */
function applyTemplateRecord(p) {
  state.templateData = true;
  const raw = state.presets.get(state.current);
  const next = raw && applyTemplateData(raw, p);
  if (!next) {
    log(`template data (${p.length} bytes) not understood`);
    return;
  }
  state.presets.set(state.current, next);
  log(`routing from the template: ${presetRouting(next).name}`);
  renderEditor();
}

async function saveTemplate(users) {
  const free = users.findIndex((n) => !n);
  const slot = await promptText({ title: 'Save routing as user template', text: `Number of the user template (1–${users.length}) ` +
    `and name, e.g. "${(free < 0 ? 0 : free) + 1} My Chain". ${UNTESTED}`, value: `${(free < 0 ? 0 : free) + 1} `, maxLength: 16,
  ok: 'Save', validate: (t) => (/^\s*\d+\s+\S/.test(t) && +t.trim().split(/\s+/)[0] >= 1 && +t.trim().split(/\s+/)[0] <= users.length
    ? '' : `number 1–${users.length}, then a name`) });
  if (slot == null) return;
  const [num, ...rest] = slot.trim().split(/\s+/);
  const n = +num - 1, name = rest.join(' ').slice(0, 11);
  await state.dev.send(TEMPLATE.SAVE, templateSavePayload(n, name));
  log(`user template ${n + 1} "${name}" saved (check the list)`);
}

// ------------------------------------------------------------------ module legend + browser (like the Hotone editor)

/** Modules of the legend, in the order of the effect database (categories that have algorithms). */
function legendModules() {
  return (categoryNames() ?? []).map((name, i) => ({ name, i })).filter((m) => algsOfCategory(m.i).length);
}

function renderLegend(raw, chain) {
  const ul = $('edModuleList');
  const c = chain.find((x) => x.slot === state.selSlot);
  const cur = state.browse?.cat ?? (c && c.code !== 0xffffffff ? algInfo(c.code)?.category : -1);
  ul.replaceChildren();
  for (const m of legendModules()) {
    const li = document.createElement('li');
    li.className = m.i === cur ? 'active' : '';
    li.innerHTML = `<span class="mi m-${m.name.replace(/ /g, '-')}">${moduleIcon(m.name) || moduleIcon(/^FX /.test(m.name) ? 'FX LOOP' : '')}</span>`;
    li.append(m.name);
    li.title = (c ? `choose a ${m.name} algorithm for ${c.pos < 6 ? 'A' : 'B'}${(c.pos % 6) + 1}` : 'select a block or an empty position in the chain first') +
      ' – or drag it onto a position in the chain';
    // drag a module onto a chain position: inserts its first algorithm there (or replaces the block)
    li.draggable = !!raw;
    li.ondragstart = (e) => {
      state.dragCat = m.i;
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', m.name);
    };
    li.ondragend = () => {
      state.dragCat = null;
    };
    li.onclick = () => {
      if (!c || !raw) {
        log('select a block or an empty position in the chain first');
        return;
      }
      const a = c.code !== 0xffffffff ? algInfo(c.code) : null;
      state.browse = { cat: m.i, group: a?.category === m.i ? a.group : null };
      renderEditor();
    };
    ul.append(li);
  }
}

/** A module dropped from the legend onto position c: its first algorithm there, the module's lists open. */
function dropModule(c, cat) {
  const group = groupsOfCategory(cat)[0] ?? null;
  const a = algsOfCategory(cat, group)[0] ?? algsOfCategory(cat)[0];
  if (!a) return;
  state.selSlot = c.slot;
  state.browse = { cat, group };
  setBlockAlg(c.slot, cat, a.code, c.code === 0xffffffff);
}

/** Lists of sub-categories and algorithms of the browsed module; a click sets the algorithm of the block. */
function moduleBrowser(c, empty, cat, wanted) {
  const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls ?? '', textContent: text ?? '' });
  const groups = groupsOfCategory(cat);
  const group = groups.includes(wanted) ? wanted : groups[0];
  const wrap = el('div', 'browser');
  const gl = el('ul', 'b-list groups');
  for (const g of groups) {
    const li = el('li', g === group ? 'on' : '', g || '–');
    li.onclick = () => {
      state.browse = { cat, group: g };
      renderEditor();
    };
    gl.append(li);
  }
  const al = el('ul', 'b-list algs');
  const live = canTalk();
  for (const a of algsOfCategory(cat, group)) {
    const li = el('li', !empty && a.code === c.code ? 'on' : '', blockName(a.code, a) || a.name);
    if (blockName(a.code, a) !== a.name) li.append(el('span', 'sub', a.name));
    li.title = live ? 'click to use this algorithm (resets the block\'s parameters)' : 'connect the pedal to change the block';
    li.onclick = () => {
      if (!live || (!empty && a.code === c.code)) return;
      state.browse = { cat, group };
      setBlockAlg(c.slot, cat, a.code, empty);
    };
    al.append(li);
  }
  wrap.append(gl, al);
  // keep the current algorithm in view
  requestAnimationFrame(() => al.querySelector('li.on')?.scrollIntoView({ block: 'nearest' }));
  return wrap;
}

/** Filled part of themed range sliders (Chrome/Brave draw it from the --fill variable). */
function sliderFill(r) {
  const min = +r.min || 0, max = +r.max || 100;
  r.style.setProperty('--fill', `${((+r.value - min) / (max - min || 1)) * 100}%`);
}
const fillRanges = () => document.querySelectorAll('input[type=range]').forEach(sliderFill);
document.addEventListener('input', (e) => {
  if (e.target.matches?.('input[type=range]')) sliderFill(e.target);
});

/** Display name of a block: the uploaded model / IR for NAM and user IR slots, else the algorithm name. */
function blockName(code, alg) {
  if ((code >>> 24) === 0x10 && state.namNames?.[code & 0xffff]) return state.namNames[code & 0xffff];
  if ((code >>> 16) === 0x0a10 && state.irNames?.[code & 0xffff]) return state.irNames[code & 0xffff];
  return alg?.name ?? '';
}

/** Footswitches (1..3) whose "Ctrl" function switches this slot. */
/** "Pick in chain" mode: clicks on chain positions (un)assign them to the selected footswitch instead of selecting. */
function fsPicking(raw) {
  try {
    return state.fsPick && !!raw && isCtrlFunction(presetFs(raw).click[state.selFs]);
  } catch {
    return false;
  }
}

function setFsPick(on) {
  state.fsPick = on;
  renderEditor();
}

/** True if the footswitch selected in the footswitch panel switches blocks and position pos is one of them. */
function fsMarked(raw, pos) {
  try {
    return !!raw && isCtrlFunction(presetFs(raw).click[state.selFs]) && presetFsSlots(raw, state.selFs)[pos];
  } catch {
    return false;
  }
}

/** "FS n" badges of a chain position; the footswitch selected in the footswitch panel is highlighted. */
function fsBadges(raw, pos) {
  const fsOf = fsAssignments(raw, pos);
  if (!fsOf.length) return null;
  const f = document.createElement('span');
  f.className = 'fx-fs';
  for (const n of fsOf) {
    const s = document.createElement('span');
    s.textContent = `FS${n}`;
    if (n - 1 === state.selFs) s.className = 'cur';
    s.title = `switched by FS${n}`;
    f.append(s);
  }
  return f;
}

/** Footswitches (1..3) that switch chain position pos (the assignment is per position, not per slot). */
function fsAssignments(raw, pos) {
  if (!raw) return [];
  try {
    const fs = presetFs(raw);
    return [0, 1, 2].filter((f) => isCtrlFunction(fs.click[f]) && presetFsSlots(raw, f)[pos]).map((f) => f + 1);
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ footswitches of the preset (tag 3 / tag 8)

const FS_CHOICES = [...FS_FUNCTIONS].filter(([c]) => c < 51 || c === 0xff); // 51..54 = global PATCH FS FUNC
/**
 * Footswitch functions offered for a preset: on the Stomp only the ones it accepts (others, e.g. Ctrl 5/6, stop its
 * firmware), "Scene n" only for scenes the preset has (Stomp: 1–3, Stage: 1–5).
 */
const fsChoices = (raw) => FS_CHOICES.filter(([c]) => (isStage() || STOMP_FS_FUNCTIONS.has(c)) &&
  (c < 27 || c > 31 || c - 27 < presetSceneCount(raw)));

/** The footswitch functions in groups for the dropdown (codes, see FS_FUNCTIONS). */
const FS_GROUPS = [
  ['', [0xff]],
  ['Ctrl – switch blocks', [12, 32, 33, 34, 35, 36, 37]],
  ['Block on/off', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]],
  ['Scenes', [27, 28, 29, 30, 31]],
  ['Patch & bank', [22, 23, 24, 25, 26, 38, 39, 15, 16, 40]],
  ['Tempo & tools', [13, 18, 19, 41, 20, 21]],
  ['Looper', [17, 42, 43, 47, 44, 45, 46, 49]],
  ['Drum', [50, 48]],
];

/** Fill a select with the allowed footswitch functions, grouped. */
function fillFsSelect(sel, allowed, current) {
  const ok = new Set(allowed.map(([c]) => c));
  for (const [label, codes] of FS_GROUPS) {
    const list = codes.filter((c) => ok.has(c));
    if (!list.length) continue;
    const parent = label ? Object.assign(document.createElement('optgroup'), { label }) : sel;
    for (const c of list) parent.append(new Option(fsFunctionName(c), String(c)));
    if (label) sel.append(parent);
  }
  if (![...sel.options].some((o) => +o.value === current)) sel.append(new Option(fsFunctionName(current), String(current)));
  sel.value = String(current);
}

function renderFs(raw, chain) {
  const box = $('edFs');
  const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls ?? '', textContent: text ?? '' });
  let fs = null;
  try {
    fs = raw ? presetFs(raw) : null;
  } catch { /* ignore */ }
  box.hidden = !fs;
  if (!fs) return;
  const live = canTalk();
  // option: when a block is moved, its footswitch assignment moves with it (the pedal itself keeps it at the position)
  const follow = el('label', 'fs-follow small');
  const cb = el('input');
  cb.type = 'checkbox';
  cb.checked = state.fsFollow;
  cb.onchange = () => {
    state.fsFollow = cb.checked;
    try { localStorage.setItem('ampero.fsFollow', cb.checked ? '1' : '0'); } catch { /* ignore */ }
  };
  follow.append(cb, ' footswitches move with the block');
  follow.title = 'off (like the pedal and the Hotone editor): a footswitch switches a position – a moved block leaves its ' +
    'footswitch behind. On: when you drag a block, its footswitch assignment is moved to the new position.';
  // like the scenes: one button per footswitch (its function at a glance), the selected one's settings below;
  // with "Effect slots" the positions it switches are marked in the chain above
  const sf = state.selFs;
  const summary = (f) => {
    if (!isCtrlFunction(fs.click[f])) return fsFunctionName(fs.click[f]);
    const on = presetFsSlots(raw, f);
    const list = chain.filter((c) => on[c.pos]).sort((x, y) => x.pos - y.pos)
      .map((c) => `${posName(c.pos)} ${c.code === 0xffffffff ? '–' : algInfo(c.code)?.module ?? ''}`);
    return list.length ? list.join(', ') : 'Effect slots: none';
  };
  const picks = el('div', 'fs-picks');
  for (let f = 0; f < 3; f++) {
    const b = el('button', `scene fs-pick${f === sf ? ' on' : ''}`);
    b.append(el('b', '', `FS${f + 1}`), el('span', '', summary(f)));
    b.title = summary(f);
    b.onclick = () => {
      state.selFs = f;
      renderEditor();
    };
    picks.append(b);
  }
  const left = el('div', 'fs-left');
  left.append(el('div', 'muted small', 'Footswitches (stomp mode)'), picks);
  box.replaceChildren(left);

  const f = sf;
  const b = el('div', 'fs-box');
  const sel = el('select');
  if (isStage()) {
    fillFsSelect(sel, fsChoices(raw), fs.click[f]);
  } else {
    // like the Hotone editor for the Stomp: "Effect slots" (= Ctrl n of this footswitch) or a fixed function
    sel.append(new Option('Effect slots', String(STOMP_FS_CTRL[f])));
    for (const c of STOMP_FS_FIXED) sel.append(new Option(fsFunctionName(c).replace(/^Off$/, 'OFF'), String(c)));
    if (![...sel.options].some((o) => +o.value === fs.click[f])) {
      sel.append(new Option(`${fsFunctionName(fs.click[f])} (not offered for the Stomp)`, String(fs.click[f])));
    }
    sel.value = String(fs.click[f]);
  }
  sel.disabled = !live;
  sel.onchange = () => setFsFunction(f, +sel.value);
  const head = el('div', 'fs-head');
  head.append(sel); // which footswitch: the selected button above
  b.append(head);
  if (fs.hold[f] !== 0xff) b.append(el('span', 'fs-hold', `hold: ${fsFunctionName(fs.hold[f])} (not editable yet)`));
  if (isCtrlFunction(fs.click[f])) {
    b.append(el('div', 'fs-title', `Switches the blocks marked "FS${f + 1}" (white) in the chain – click a position to (un)assign:`));
    // the assignment belongs to the chain position (a moved block leaves it behind, like on the pedal)
    const on = presetFsSlots(raw, f);
    const grid = el('div', 'fs-grid');
    for (const c of [...chain].sort((x, y) => x.pos - y.pos)) {
      const empty = c.code === 0xffffffff;
      const a = empty ? null : algInfo(c.code);
      const t = el('button', `${on[c.pos] ? 'on' : ''}${empty ? ' empty' : ''}`);
      t.append(el('span', 'fs-pos', posName(c.pos)), el('span', '', empty ? '+' : a?.module ?? '?'));
      t.title = `${posName(c.pos)} ${empty ? 'empty' : a?.name ?? ''} – click to (un)assign`;
      t.disabled = !live;
      t.onclick = () => toggleFsSlot(f, c.pos);
      grid.append(t);
    }
    b.append(grid);
    const pick = el('button', `small-btn${state.fsPick ? ' on' : ''}`, state.fsPick ? 'Done picking' : 'Pick blocks in the chain');
    pick.title = 'while on, a click on a block (or empty position) in the chain assigns it to this footswitch or removes it (Esc ends)';
    pick.disabled = !live;
    pick.onclick = () => setFsPick(!state.fsPick);
    b.append(pick);
    // option: when a block is moved, its footswitch assignment moves with it (the pedal itself keeps it at the position)
    const follow = el('label', 'fs-follow small');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = state.fsFollow;
    cb.onchange = () => {
      state.fsFollow = cb.checked;
      try { localStorage.setItem('ampero.fsFollow', cb.checked ? '1' : '0'); } catch { /* ignore */ }
    };
    follow.append(cb, ' assignments move with the block');
    follow.title = 'off (like the pedal and the Hotone editor): a footswitch switches a position – a moved block leaves its ' +
      'footswitch behind. On: when you drag a block, its footswitch assignments move to the new position.';
    b.append(follow);
  }
  b.append(midiRows(raw, 'fs', f));
  box.append(b);
  box.append(quickKnobBox(raw, chain));
  box.append(expBox(raw, chain));
  box.append(midiRows(raw, 'patch', 0));
}

// ------------------------------------------------------------------ quick knobs

const posName = (p) => `${p < 6 ? 'A' : 'B'}${(p % 6) + 1}`;

/** Label, value text and bar fill (0..1, null = empty) of quick knob target {obj, param}, like the pedal's display
 * ("A2-DYN Attack", "Patch Volume", "Patch Tempo"; value above the bar). */
function quickKnobView(raw, chain, q) {
  const scene = editScene();
  if (q.obj === QKNOB.VOLUME || q.obj === QKNOB.TEMPO) {
    const m = sceneMeta(raw, scene);
    return q.obj === QKNOB.VOLUME
      ? { label: 'Patch Volume', value: `${m.volume}`, at: m.volume / 100 }
      : { label: 'Patch Tempo', value: `${m.tempo}`, at: (m.tempo - 40) / 260 };
  }
  const c = q.obj < 12 ? chain.find((x) => x.pos === q.obj) : null;
  const a = c && c.code !== 0xffffffff ? algInfo(c.code) : null;
  if (!a) return { label: q.obj === QKNOB.OFF ? 'OFF' : `target ${q.obj}`, value: '', at: null };
  const p = a.params.find((x) => x.id === q.param);
  const label = `${posName(q.obj)}-${a.module} ${p ? p.name : `parameter ${q.param}`}`;
  if (!p) return { label, value: '', at: null };
  const v = sceneParam(raw, scene, c.slot, p.id);
  return { label, title: `${posName(q.obj)} ${a.name} · ${p.name}`, value: formatValue(p, v),
    at: p.max > p.min ? (v - p.min) / (p.max - p.min) : null };
}

/** Menu items to assign quick knob k: OFF, every block with its parameters, Patch Volume / Tempo. */
function quickKnobItems(chain, k, q) {
  const items = [{ label: 'OFF', checked: q.obj === QKNOB.OFF, action: () => setQuickKnob(k, QKNOB.OFF, 0, false) }, '-'];
  for (const c of chain.filter((x) => x.code !== 0xffffffff).sort((x, y) => x.pos - y.pos)) {
    const a = algInfo(c.code);
    if (!a) continue;
    items.push({ label: `${posName(c.pos)}  ${a.module} : ${a.name}`, checked: q.obj === c.pos,
      items: a.params.map((p) => ({ label: p.name, checked: q.obj === c.pos && q.param === p.id,
        action: () => setQuickKnob(k, c.pos, p.id, q.obj === c.pos) })) });
  }
  items.push('-', { label: 'Patch Volume', checked: q.obj === QKNOB.VOLUME, action: () => setQuickKnob(k, QKNOB.VOLUME, 0, false) },
    { label: 'Patch Tempo', checked: q.obj === QKNOB.TEMPO, action: () => setQuickKnob(k, QKNOB.TEMPO, 0, false) });
  return items;
}

/** Quick Access Para 1–3 like on the pedal: value, bar and label in the display, the three small knobs below.
 * Click a display field or a knob to assign it. */
function quickKnobBox(raw, chain) {
  const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls ?? '', textContent: text ?? '' });
  const box = el('div', 'qk-box');
  box.append(el('div', 'muted small', 'Quick knobs – click to assign, or right-click a parameter of a block'));
  let knobs;
  try {
    knobs = presetQuickKnobs(raw);
  } catch {
    return box;
  }
  const live = canTalk();
  const pedal = el('div', 'qk-pedal');
  const screen = el('div', 'qk-screen');
  const plate = el('div', 'qk-plate');
  knobs.forEach((q, k) => {
    const v = quickKnobView(raw, chain, q);
    const open = (b) => (e) => {
      const r = b.getBoundingClientRect();
      e.stopPropagation();
      contextMenu(r.left, r.bottom + 2, quickKnobItems(chain, k, q));
    };
    const tip = live ? `Quick knob ${k + 1}${v.title ? ` – ${v.title}` : ''} – click to assign` : 'connect the pedal to assign';
    const cell = el('button', `qk-cell${q.obj === QKNOB.OFF ? ' off' : ''}`);
    const bar = el('span', 'qk-bar');
    const fill = el('span', 'qk-fill');
    fill.style.width = `${v.at == null ? 0 : 100 * Math.min(1, Math.max(0, v.at))}%`;
    bar.append(fill);
    cell.append(el('span', 'qk-val', v.value || ' '), bar, el('span', 'qk-label', v.label));
    const knob = el('button', 'qk-knob');
    knob.append(el('span', 'qk-cap'));
    for (const b of [cell, knob]) {
      b.title = tip;
      b.disabled = !live;
      b.onclick = open(b);
    }
    screen.append(cell);
    plate.append(knob);
  });
  pedal.append(screen, plate);
  box.append(pedal);
  return box;
}

/** Quick knobs (1-based numbers) that point at parameter id of the block at chain position pos. */
function quickKnobsOf(raw, pos, id) {
  try {
    return presetQuickKnobs(raw).map((q, k) => (q.obj === pos && q.param === id ? k + 1 : 0)).filter(Boolean);
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ expression pedal targets

/** Display range of an EXP target (what the Hotone editor's Min / Max sliders offer). */
function expRange(raw, pos, param) {
  if (pos === EXP.TEMPO) return [40, 300];
  if (pos === EXP.VOLUME) return [0, 100];
  const c = pos < 12 ? presetChain(raw).find((x) => x.pos === pos) : null;
  const p = c ? algInfo(c.code)?.params.find((x) => x.id === param) : null;
  return p && Number.isFinite(p.min) && Number.isFinite(p.max) ? [p.min, p.max] : [0, 100];
}

/** EXP1 / EXP2: four targets each (OFF, a block parameter, Patch Volume, Patch Tempo) with range and curve. */
function expBox(raw, chain) {
  const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls ?? '', textContent: text ?? '' });
  const box = el('div', 'exp-box');
  let targets;
  const exp = state.selExp;
  try {
    targets = presetExpTargets(raw, exp);
  } catch {
    return box;
  }
  const head = el('div', 'exp-head');
  head.append(el('span', 'muted small', 'Expression pedal'));
  for (const e of [0, 1]) {
    const b = el('button', `small-btn${e === exp ? ' on' : ''}`, `EXP${e + 1}`);
    b.onclick = () => {
      state.selExp = e;
      renderEditor();
    };
    head.append(b);
  }
  box.append(head);
  const live = canTalk();
  const blocks = chain.filter((c) => c.code !== 0xffffffff).sort((x, y) => x.pos - y.pos);
  targets.forEach((x, t) => {
    const row = el('div', 'exp-row');
    const line = el('div', 'qk-row');
    line.append(el('span', 'qk-n', `Target ${t + 1}`));
    const sel = el('select');
    sel.append(new Option('OFF', String(EXP.OFF)));
    for (const c of blocks) {
      const a = algInfo(c.code);
      sel.append(new Option(`${posName(c.pos)} ${a ? `${a.module} : ${a.name}` : hex32(c.code)}`, String(c.pos)));
    }
    sel.append(new Option('Patch Volume', String(EXP.VOLUME)), new Option('Patch Tempo', String(EXP.TEMPO)));
    if (![...sel.options].some((o) => +o.value === x.pos)) sel.append(new Option(`target ${x.pos} (unknown)`, String(x.pos)));
    sel.value = String(x.pos);
    sel.disabled = !live;
    line.append(sel);
    const c = x.pos < 12 ? chain.find((y) => y.pos === x.pos) : null;
    const a = c ? algInfo(c.code) : null;
    sel.onchange = () => {
      const pos = +sel.value;
      const c2 = pos < 12 ? chain.find((y) => y.pos === pos) : null;
      setExpTarget(exp, t, pos, c2 ? algInfo(c2.code)?.params[0]?.id ?? 0 : 0xff);
    };
    if (a) {
      const p = el('select');
      for (const q of a.params) p.append(new Option(q.name, String(q.id)));
      if (!a.params.some((q) => q.id === x.param)) p.append(new Option(`parameter ${x.param}`, String(x.param)));
      p.value = String(x.param);
      p.disabled = !live;
      p.onchange = () => setExpTarget(exp, t, x.pos, +p.value);
      line.append(p);
    }
    row.append(line);
    if (x.pos !== EXP.OFF) {
      const [lo, hi] = expRange(raw, x.pos, x.param);
      const r = el('div', 'exp-range');
      const num = (label, key, min, max, step = 1) => {
        const lab = el('label', 'small', `${label} `);
        const i = el('input');
        Object.assign(i, { type: 'number', min, max, step, value: Math.round(x[key] * 100) / 100, disabled: !live });
        i.onchange = () => {
          const v = Math.min(max, Math.max(min, +i.value));
          if (!Number.isFinite(v)) return;
          setExpRange(exp, t, { ...x, [key]: v });
        };
        lab.append(i);
        return lab;
      };
      r.append(num('Min', 'min', lo, hi), num('Max', 'max', lo, hi));
      const cv = el('select');
      EXP.CURVES.forEach((n, k) => cv.append(new Option(n, String(k))));
      cv.value = String(Math.round(x.curve));
      cv.disabled = !live;
      cv.onchange = () => setExpRange(exp, t, { ...x, curve: +cv.value });
      r.append(cv);
      if (x.pos < 12) { // Auto-OFF only for block targets, like the Hotone editor
        const lab = el('label', 'small');
        const cb = el('input');
        Object.assign(cb, { type: 'checkbox', checked: x.autoOff, disabled: !live });
        cb.onchange = () => setExpRange(exp, t, { ...x, autoOff: cb.checked });
        lab.append(cb, ' Auto-OFF');
        lab.title = 'the pedal switches the block off when the expression pedal is at its minimum for the OFF time';
        r.append(lab);
        if (x.autoOff) r.append(num('OFF ms', 'offTime', EXP.OFF_TIME[0], EXP.OFF_TIME[1], 10));
      }
      row.append(r);
    }
    box.append(row);
  });
  return box;
}

async function setExpTarget(exp, t, pos, param) {
  const raw = state.presets.get(state.current);
  if (!raw) return;
  const c = pos < 12 ? presetChain(raw).find((x) => x.pos === pos) : null;
  const a = c ? algInfo(c.code) : null;
  if (pos < 12 && !a) return; // empty position / unknown block
  const payload = a ? expTargetPayload(exp, t, pos, a.category, a.code, param)
    : expTargetPayload(exp, t, pos, 0xff, 0xffffffff, 0xff);
  // the pedal resets the range after a target change (block 0–100, Patch Tempo 40–300); mirror that in the preset
  const [lo, hi] = pos === EXP.OFF ? [0, 100] : pos === EXP.TEMPO ? [40, 300] : [0, 100];
  if (!editPreset((r) => setPresetExpTarget(r, exp, t,
    { pos, param: a ? param : 0xff, min: lo, max: hi, curve: 0, autoOff: false, offTime: 600 }))) return;
  renderEditor();
  const what = `EXP${exp + 1} target ${t + 1}`;
  if (await inScene1(what, (dev) => dev.send(EXP.TARGET, payload))) {
    const name = pos === EXP.OFF ? 'OFF' : pos === EXP.VOLUME ? 'Patch Volume' : pos === EXP.TEMPO ? 'Patch Tempo'
      : `${posName(pos)} ${a.name} · ${a.params.find((x) => x.id === param)?.name ?? param}`;
    log(`${what}: ${name}${pos === EXP.OFF ? ' (OFF not confirmed by a capture yet)' : ''}`);
  }
}

async function setExpRange(exp, t, x) {
  if (!editPreset((r) => setPresetExpTarget(r, exp, t, x))) return;
  renderEditor();
  const what = `EXP${exp + 1} target ${t + 1} range`;
  if (await inScene1(what, (dev) => dev.send(EXP.RANGE, expRangePayload(exp, t, x)))) {
    log(`${what}: ${x.min}–${x.max}, ${EXP.CURVES[Math.round(x.curve)] ?? x.curve}${x.autoOff ? `, Auto-OFF ${x.offTime} ms` : ''}`);
  }
}

/** wide: only the parameter changed (the Hotone editor then sends the 9-byte form). */
async function setQuickKnob(knob, obj, param, wide) {
  const raw = state.presets.get(state.current);
  if (!raw) return;
  const c = obj < 12 ? presetChain(raw).find((x) => x.pos === obj) : null;
  const a = c ? algInfo(c.code) : null;
  if (obj < 12 && !a) return; // empty position / unknown block
  // like the Hotone editor: a new target goes out with parameter 0 (FF for functions / OFF) in the 8-byte form,
  // a parameter (also right after a new target) in the 9-byte form
  const cat = a ? a.category : 0xff, code = a ? a.code : 0xffffffff;
  const payloads = wide ? [qknobPayload(knob, obj, cat, code, param, true)]
    : [qknobPayload(knob, obj, cat, code, obj < 12 ? 0 : 0xff, false)];
  if (!wide && obj < 12 && param !== 0) payloads.push(qknobPayload(knob, obj, cat, code, param, true));
  if (!editPreset((r) => setPresetQuickKnob(r, knob, obj, obj < 12 ? param : 0))) return;
  renderEditor();
  // preset-wide like the I/O nodes: sent in scene 1 (the pedal switches there briefly and back)
  const what = `quick knob ${knob + 1}`;
  if (await inScene1(what, async (dev) => {
    for (const p of payloads) await dev.send(QKNOB.SET, p);
  })) {
    const name = obj === QKNOB.OFF ? 'OFF' : obj === QKNOB.VOLUME ? 'Patch Volume' : obj === QKNOB.TEMPO ? 'Patch Tempo'
      : `${posName(obj)} ${a.name} · ${a.params.find((x) => x.id === param)?.name ?? param}`;
    log(`${what}: ${name}`);
  }
}

/** MIDI messages of footswitch f (3) or of the preset (patch MIDI, 6) – collapsible, like the Hotone editor. */
function midiRows(raw, kind, f) {
  const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls ?? '', textContent: text ?? '' });
  let all = [];
  try {
    all = presetMidi(raw);
  } catch { /* ignore */ }
  const first = kind === 'fs' ? MIDI.FS_ROWS * f : MIDI.FS_ROWS * 3;
  const rows = all.slice(first, first + (kind === 'fs' ? MIDI.FS_ROWS : MIDI.PATCH_ROWS));
  const used = rows.filter((m) => m.ch !== MIDI.OFF).length;
  const d = el('details', `midi-box ${kind}`);
  const key = `${kind}${f}`;
  d.open = !!state.midiOpen?.[key];
  d.ontoggle = () => {
    (state.midiOpen ??= {})[key] = d.open;
  };
  d.append(el('summary', '', `${kind === 'fs' ? 'MIDI' : 'Patch MIDI (sent when the preset is loaded)'}${used ? ` · ${used} set` : ''}`));
  const live = canTalk();
  rows.forEach((m, r) => {
    const row = el('div', 'midi-row');
    const ch = el('select');
    ch.append(new Option('OFF', String(MIDI.OFF)));
    for (let c = 0; c < 16; c++) ch.append(new Option(`ch ${c + 1}`, String(c)));
    ch.value = String(m.ch);
    const cmd = el('select');
    for (let c = 0; c < 128; c++) cmd.append(new Option(`CC ${c}`, String(c)));
    cmd.append(new Option('PC', String(MIDI.PC)));
    cmd.value = String(m.cmd);
    const data = el('input');
    Object.assign(data, { type: 'number', min: 0, max: 127, step: 1, value: m.data });
    const off = m.ch === MIDI.OFF;
    ch.disabled = !live;
    cmd.disabled = data.disabled = !live || off;
    const send = () => setMidi(kind, f, r, first + r, { ch: +ch.value, cmd: +cmd.value, data: Math.max(0, Math.min(127, Math.round(+data.value) || 0)) });
    ch.onchange = cmd.onchange = data.onchange = send;
    row.append(el('span', 'midi-n', `${r + 1}`), ch, cmd, data);
    row.title = midiText(m);
    d.append(row);
  });
  return d;
}

async function setMidi(kind, f, row, index, m) {
  if (!midiValid(m)) {
    log(`MIDI: invalid value – not sent`);
    return;
  }
  if (!editPreset((raw) => setPresetMidi(raw, index, m))) return;
  renderEditor();
  await state.dev.send(kind === 'fs' ? MIDI.FS : MIDI.PATCH, kind === 'fs' ? fsMidiPayload(f, row, m) : patchMidiPayload(row, m));
  log(`${kind === 'fs' ? `FS${f + 1}` : 'Patch'} MIDI ${row + 1}: ${midiText(m)}`);
}

async function setFsFunction(f, code) {
  if (!isStage() && code !== STOMP_FS_CTRL[f] && !STOMP_FS_FIXED.includes(code)) {
    log(`FS${f + 1}: "${fsFunctionName(code)}" is not available on the Stomp (it stops its firmware) – not sent`);
    renderEditor();
    return;
  }
  let click;
  if (!editPreset((raw) => {
    const r = setPresetFsClick(raw, f, code);
    click = presetFs(r).click;
    return r;
  })) return;
  renderEditor();
  await state.dev.send(FS_SET, Uint8Array.from(click));
  log(`FS${f + 1}: ${fsFunctionName(code)}`);
}

async function toggleFsSlot(f, pos) {
  let on, click;
  if (!editPreset((raw) => {
    const r = setPresetFsSlot(raw, f, pos, !presetFsSlots(raw, f)[pos]);
    on = presetFsSlots(r, f);
    click = presetFs(r).click;
    return r;
  })) return;
  renderEditor();
  // like the Hotone editor: the assignment, then the functions again
  await state.dev.send(FS_SLOTS_SET, fsSlotsPayload(f, on));
  await state.dev.send(FS_SET, Uint8Array.from(click));
}

// ------------------------------------------------------------------ parameter editor
//
// Parameters are per scene (tag 5: f32 [scene][slot][25], index = Widget.ID). A change is sent as CMD.PARAM
// (u16 slot, u16 id, f32 value) and applies to the scene that is active on the pedal; the pedal does not
// answer. The app keeps its copy of the preset in step, marks it as modified, and Save stores it (CMD.SAVE).

const PARAM_SEND_MS = 70; // the Hotone editor sends ~12 changes per second while a knob turns

function editScene() {
  return Math.max(0, state.scene);
}

// ------------------------------------------------------------------ number of scenes
//
// Stomp presets have 3 scenes, Stage presets presumably 5 (presetSceneCount, from the preset format). A footswitch
// set to "Scene 4/5" still switches a Stomp there, but any edit in such a scene stops the Stomp's firmware with
// "Scene < SCENE_NUM" (PresetInterface.c:4196, V2.5.0). So scenes beyond the preset's count are never offered and
// all edits are blocked while the pedal is in one of them; "Scene 4/5" footswitch functions are only offered for
// presets that have these scenes.

/** Ampero II Stage (5 scenes): by the MIDI port name or by the current preset's format. */
function isStage() {
  const raw = state.presets.get(state.current);
  return /stage/i.test(state.model) || (raw ? presetSceneCount(raw) >= 5 : false);
}

function sceneCount() {
  const raw = state.presets.get(state.current);
  return raw ? presetSceneCount(raw) : 3;
}

function sceneEditable() {
  if (editScene() < sceneCount()) return true;
  log(`the pedal is in scene ${editScene() + 1}, which this preset does not have (the Stomp's firmware stops with an error when it is edited) – select scene 1–${sceneCount()}`);
  return false;
}

/** Display values of a scene the preset does not have: scene 1. */
const showScene = (raw, s) => (s < presetSceneCount(raw) ? s : 0);
const sceneParam = (raw, s, slot, id) => presetParam(raw, showScene(raw, s), slot, id);
const sceneOn = (raw, s) => presetOn(raw, showScene(raw, s));
function sceneMeta(raw, s) {
  return s < presetSceneCount(raw) ? presetScene(raw, s) : { ...presetScene(raw, 0), name: `Scene ${s + 1}` };
}

function renderParams(raw, chain) {
  if (state.dragging) return;
  const box = $('edParams');
  const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls, textContent: text ?? '' });
  const c = chain.find((x) => x.slot === state.selSlot);
  if (raw && !c && state.selIo) {
    box.replaceChildren(ioPanel(raw, state.selIo.out, state.selIo.chain));
    return;
  }
  if (!raw || !c) {
    box.replaceChildren(el('div', 'params-empty', raw ? 'Click an effect in the chain to edit it, or an empty position to insert one. Drag a block onto another position to swap them; the dot switches it on/off.'
      : 'Read a preset from the pedal to edit it.'));
    return;
  }
  const empty = c.code === 0xffffffff;
  const alg = empty ? null : algInfo(c.code);
  const scene = editScene();
  const head = el('div', 'params-head');
  head.append(el('span', 'p-title', empty ? 'Empty position' : alg ? alg.name : hex32(c.code)),
    el('span', 'muted small', `${empty ? `position ${c.pos + 1}` : `${alg?.module ?? MODULES[c.code >>> 24] ?? '?'} · slot ${c.slot + 1} · scene ${scene + 1}`}`));
  head.append(blockControls(raw, c, empty));
  // the selected block's module stays open: sub-categories | algorithms | parameters (module change via the legend)
  const cat = state.browse?.cat ?? alg?.category ?? -1;
  const group = state.browse?.group ?? (alg && alg.category === cat ? alg.group : null);
  const body = el('div', 'params-body');
  if (cat >= 0) body.append(moduleBrowser(c, empty, cat, group));
  const grid = el('div', 'params-grid');
  if (empty) {
    grid.append(el('div', 'muted', cat >= 0 ? 'Choose an algorithm to insert a block here.' : 'Choose a module on the left to insert a block here.'));
  } else if (!alg) {
    grid.append(el('div', 'muted', 'Unknown algorithm – effect database not loaded?'));
  } else if (alg.category !== cat) {
    grid.append(el('div', 'muted', `Choose a ${categoryNames()?.[cat] ?? ''} algorithm to replace ${alg.name}.`));
  } else {
    const live = canTalk();
    for (const p of alg.params) {
      const ctl = paramControl(raw, c.slot, p, scene, live);
      // quick knobs: badge on assigned parameters, right-click to put the parameter on a knob
      const on = quickKnobsOf(raw, c.pos, p.id);
      const name = ctl.querySelector('.name');
      if (name) for (const k of on) name.append(Object.assign(document.createElement('span'), { className: 'qk-badge', textContent: `Q${k}` }));
      ctl.oncontextmenu = (e) => {
        e.preventDefault();
        contextMenu(e.clientX, e.clientY, [0, 1, 2].map((k) => ({ label: `Quick knob ${k + 1}`, checked: on.includes(k + 1),
          disabled: !live, action: () => setQuickKnob(k, c.pos, p.id, false) })));
      };
      grid.append(ctl);
    }
  }
  // block type + parameters in one framed area, like the lists
  const panel = el('div', 'param-panel');
  panel.append(head, grid);
  body.append(panel);
  box.replaceChildren(body);
}

// ------------------------------------------------------------------ input / output nodes

/** Settings of an input or output node (chain 0 = A, 1 = B), like the Hotone editor's node panel. */
function ioPanel(raw, out, chainNo) {
  const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls ?? '', textContent: text ?? '' });
  const io = presetIo(raw, out, chainNo);
  const names = out ? OUT_TARGETS : IN_SOURCES;
  const allowed = (isStage() ? STAGE_IO : STOMP_IO)[out ? 'out' : 'in'][chainNo];
  // the pedal only takes I/O changes in scene 1 – outside it the editor hops there and back (like block changes)
  const live = canTalk();
  const wrap = el('div', 'param-panel io-panel');
  const head = el('div', 'params-head');
  head.append(el('span', 'p-title', `${chainNo ? 'B' : 'A'} ${out ? 'Output' : 'Input'} Node`),
    el('span', 'muted small', 'for the whole preset (all scenes)'));
  wrap.append(head);
  if (editScene() !== 0) wrap.append(el('div', 'muted small', 'Changes are sent in scene 1 (the pedal switches there briefly and back).'));
  const grid = el('div', 'params-grid');
  // source / target
  const sw = el('div', `pk${live ? '' : ' disabled'}`);
  const sel = el('select');
  for (const v of allowed) sel.append(new Option(names.get(v), String(v)));
  if (!allowed.includes(io.source)) sel.append(new Option(`${names.get(io.source) ?? io.source} (not offered here)`, String(io.source)));
  sel.value = String(io.source);
  sel.disabled = !live;
  sel.onchange = () => setIoSource(out, chainNo, +sel.value);
  sw.append(sel, el('span', 'name', out ? 'Output To' : 'Source'));
  grid.append(sw);
  if (ioHasParams(out, io.source)) {
    const level = { id: -1, name: out ? (io.source === 1 ? 'Send Level' : 'Output Level') : 'Level', min: -61, max: 20, step: 1,
      unit: 'dB', muteAtMin: true, type: 0 };
    if (out) {
      grid.append(paramControl(raw, -1, level, 0, live, { value: io.params[0], set: (v) => setIoParam(out, chainNo, 0, v) }));
      const pan = { id: -1, name: 'Pan', min: -50, max: 50, step: 1, pan: true, type: 0 };
      grid.append(paramControl(raw, -1, pan, 0, live, { value: io.params[1], set: (v) => setIoParam(out, chainNo, 1, v) }));
    } else {
      const ch = { id: -1, name: 'Input Channel', min: 0, max: 3, step: 1, options: IN_CHANNELS, type: 2 };
      grid.append(paramControl(raw, -1, ch, 0, live, { value: io.params[0], set: (v) => setIoParam(out, chainNo, 0, v) }));
      grid.append(paramControl(raw, -1, level, 0, live, { value: io.params[1], set: (v) => setIoParam(out, chainNo, 1, v) }));
    }
  }
  wrap.append(grid);
  const body = el('div', 'params-body');
  body.append(wrap);
  return body;
}

async function setIoSource(out, chainNo, source) {
  const allowed = (isStage() ? STAGE_IO : STOMP_IO)[out ? 'out' : 'in'][chainNo];
  if (!allowed.includes(source) || !canTalk()) return;
  if (!editPreset((raw) => setPresetIoSource(raw, out, chainNo, source))) return;
  renderEditor();
  const what = `${chainNo ? 'B' : 'A'} ${out ? 'output to' : 'input source'}`;
  if (await inScene1(what, (dev) => dev.send(out ? IO.OUT_SOURCE : IO.IN_SOURCE, ioSourcePayload(chainNo, source)))) {
    log(`${what}: ${(out ? OUT_TARGETS : IN_SOURCES).get(source)}`);
  }
}

// I/O levels outside scene 1: collected while the control moves, then sent in one hop to scene 1
const pendingIo = new Map(); // "out/chain/param" -> {out, chainNo, p, value}
let ioTimer = 0;
const IO_HOP_MS = 400;

function setIoParam(out, chainNo, p, value) {
  if (!canTalk()) return;
  if (!editPreset((raw) => setPresetIoParam(raw, out, chainNo, p, value))) return;
  markDirty();
  if (editScene() === 0 && !state.sceneHop) {
    state.dev.send(out ? IO.OUT_PARAM : IO.IN_PARAM, ioParamPayload(chainNo, p, value)).catch((e) => log(`I/O level: ${e.message}`));
    return;
  }
  pendingIo.set(`${+out}/${chainNo}/${p}`, { out, chainNo, p, value });
  clearTimeout(ioTimer);
  ioTimer = setTimeout(flushIo, IO_HOP_MS);
}

async function flushIo() {
  ioTimer = 0;
  if (!pendingIo.size || !state.dev) return;
  if (state.sceneHop) { // another hop is running – try again afterwards
    ioTimer = setTimeout(flushIo, IO_HOP_MS);
    return;
  }
  const items = [...pendingIo.values()];
  pendingIo.clear();
  await inScene1('I/O level', async (dev) => {
    for (const x of items) await dev.send(x.out ? IO.OUT_PARAM : IO.IN_PARAM, ioParamPayload(x.chainNo, x.p, x.value));
  });
}

function paramControl(raw, slot, p, scene, live, own = null) {
  const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls, textContent: text ?? '' });
  const wrap = el('div', `pk${live ? '' : ' disabled'}`);
  wrap.title = live ? '' : 'connect the pedal (and stop the sniffer / resume) to edit';
  // own = {value, set(v)}: a control that is not a block parameter (input / output nodes)
  let value = own ? own.value : sceneParam(raw, scene, slot, p.id);
  const label = el('span', 'name', p.name);
  const set = (v, update) => {
    v = clampValue(p, v);
    if (v === value) return;
    value = v;
    update();
    if (own) own.set(v);
    else changeParam(slot, p.id, v);
  };
  if (p.type === 3) { // switch
    const b = el('button', 'sw');
    const update = () => {
      b.textContent = formatValue(p, value);
      b.classList.toggle('on', value > p.min);
    };
    b.onclick = () => set(value > p.min ? p.min : p.max, update);
    update();
    wrap.append(b, label);
  } else if (p.type === 2 || p.options) { // selector
    const s = el('select');
    for (let v = p.min; v <= p.max; v += p.step) s.append(new Option(formatValue(p, v), v));
    s.value = String(value);
    s.onchange = () => set(+s.value, () => {});
    wrap.append(s, label);
  } else { // knob (type 0) / EQ slider (type 4)
    const dial = el('div', 'dial');
    dial.tabIndex = 0;
    const val = el('span', 'val');
    const update = () => {
      const f = p.max > p.min ? (value - p.min) / (p.max - p.min) : 0;
      dial.style.setProperty('--a', `${-135 + 270 * f}deg`);
      val.textContent = formatValue(p, value);
    };
    const range = p.max - p.min;
    dial.onpointerdown = (e) => {
      if (!canTalk()) return;
      dial.setPointerCapture(e.pointerId);
      state.dragging = true;
      const y0 = e.clientY, v0 = value;
      dial.onpointermove = (m) => set(v0 + ((y0 - m.clientY) / (m.shiftKey ? 1000 : 200)) * range, update);
      dial.onpointerup = dial.onpointercancel = () => {
        dial.onpointermove = dial.onpointerup = dial.onpointercancel = null;
        state.dragging = false;
      };
    };
    const nudge = (dir, big) => set(value + dir * (big ? Math.max(p.step, range / 20) : p.step), update);
    dial.onwheel = (e) => {
      if (!canTalk()) return;
      e.preventDefault();
      nudge(e.deltaY < 0 ? 1 : -1, e.shiftKey);
    };
    dial.onkeydown = (e) => {
      const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
      if (d) {
        e.preventDefault();
        nudge(d, e.shiftKey);
      }
    };
    dial.ondblclick = () => set(p.def, update);
    dial.title = `${p.name}: drag up/down (Shift = fine), wheel, arrow keys; double-click = default (${formatValue(p, p.def)})`;
    update();
    wrap.append(dial, val, label);
  }
  return wrap;
}

// ------------------------------------------------------------------ blocks: algorithm, on/off, order

/** Module + algorithm selectors, on/off and remove for the selected block. */
function blockControls(raw, c, empty) {
  const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls, textContent: text ?? '' });
  const wrap = el('span', 'block-ctl');
  // Copy / Paste / Save / Load / Delete: in the block's context menu (right-click)
  if (!empty) {
    const on = sceneOn(raw, editScene())[c.slot];
    const t = el('button', `small-btn sw${on ? ' on' : ''}`, on ? 'On' : 'Off');
    t.title = `on/off in scene ${editScene() + 1} – right-click the block for copy, paste, save, load, delete`;
    t.disabled = !canTalk();
    t.onclick = () => toggleOn(c.slot);
    wrap.append(t);
  }
  return wrap;
}

function copyBlock(raw, c) {
  state.blockClip = presetBlock(raw, c.slot);
  state.blockClip.name = blockName(c.code, algInfo(c.code)) || hex32(c.code);
  try { localStorage.setItem('ampero.blockClip', JSON.stringify(state.blockClip)); } catch { /* ignore */ }
  log(`copied block "${state.blockClip.name}"`);
  renderEditor();
}

function saveBlockFile(raw, c) {
  const b = { ...presetBlock(raw, c.slot), name: blockName(c.code, algInfo(c.code)) || hex32(c.code) };
  download(new Blob([JSON.stringify(b, null, 1)], { type: 'application/json' }), `${b.name.replace(/[^\w.-]+/g, '_')}.ampblock`);
}

async function loadBlockFile(c) {
  const f = await pickFile('.ampblock,.json');
  if (!f) return;
  try {
    await restoreBlock(c.slot, checkBlock(JSON.parse(await f.text())));
  } catch (e) {
    log(`load block: ${e.message}`);
  }
}

/** Right-click menu of a block / an empty position. */
function blockMenu(e, raw, c) {
  e.preventDefault();
  e.stopPropagation();
  state.selSlot = c.slot;
  renderEditor();
  const empty = c.code === 0xffffffff, live = canTalk(), clip = state.blockClip;
  contextMenu(e.clientX, e.clientY, [
    { label: 'Copy', action: () => copyBlock(raw, c), disabled: empty },
    { label: clip ? `Paste "${clip.name}"` : 'Paste', action: () => restoreBlock(c.slot, clip), disabled: !clip || !live },
    '-',
    { label: 'Save as file…', action: () => saveBlockFile(raw, c), disabled: empty },
    { label: 'Load from file…', action: () => loadBlockFile(c), disabled: !live },
    '-',
    { label: 'Delete', action: () => removeBlock(c.slot), disabled: empty || !live, danger: true },
    '-',
    ...[0, 1, 2].map((f) => {
      const fs = presetFs(raw);
      const ctrl = isCtrlFunction(fs.click[f]);
      const has = ctrl && presetFsSlots(raw, f)[c.pos];
      return { label: `${has ? 'Remove from' : 'Switch with'} FS${f + 1}`, action: () => toggleFsSlot(f, c.pos), disabled: !ctrl || !live,
        title: ctrl ? '' : `FS${f + 1} is set to "${fsFunctionName(fs.click[f])}" – choose "Effect slots" for it first` };
    }),
  ]);
}

/** Option label: NAM / user IR slots show the name of the uploaded model / IR. */
function algLabel(a) {
  if ((a.code >>> 24) === 0x10 && state.namNames) {
    const n = state.namNames[a.code & 0xffff];
    return n ? `${a.name} – ${n}` : `${a.name} (empty)`;
  }
  if ((a.code >>> 16) === 0x0a10 && state.irNames?.[a.code & 0xffff]) return `${a.name} – ${state.irNames[a.code & 0xffff]}`;
  return a.name;
}

/** Apply an edit to our copy of the current preset and mark it modified. */
function editPreset(fn) {
  const i = state.current, raw = state.presets.get(i);
  if (!sceneEditable()) return false; // no edits at all while the pedal is in scene 4/5
  if (!raw || !canTalk()) {
    if (!canTalk()) log('editing needs the pedal (connected, not paused, sniffer off)');
    return false;
  }
  state.presets.set(i, fn(raw));
  state.dirty = i;
  return true;
}

async function toggleOn(slot) {
  const scene = editScene();
  if (!sceneEditable()) return;
  let on;
  if (!editPreset((raw) => {
    on = sceneOn(raw, scene);
    on[slot] = !on[slot];
    return setPresetOn(raw, scene, slot, on[slot]);
  })) return;
  renderEditor();
  await state.dev.send(CMD.SLOT_ON, slotOnPayload(scene, on));
}

// ------------------------------------------------------------------ block changes only in scene 1
//
// Inserting, replacing, deleting and moving blocks is only allowed in scene 1: the pedal and the Hotone editor forbid
// it in scenes 2/3, and inserting a block while the Stomp was in scene 2 crashed it. The editor may show any scene;
// for such a change it switches the pedal to scene 1, checks that it is there, sends the change and switches back.

/** Select scene 1 on the pedal and make sure it is there (throws otherwise). */
async function pedalToScene1(dev) {
  await dev.selectScene(0);
  await dev.waitQuiet(150, 1500);
  const now = await dev.currentScene();
  if (now !== 0) throw new Error(`the pedal did not switch to scene 1 (it reports scene ${now + 1}) – nothing sent`);
}

/** Run `send(dev)` with the pedal in scene 1, then return to the scene shown in the editor. */
async function inScene1(what, send) {
  const dev = state.dev;
  const back = editScene();
  state.busy = true;
  state.sceneHop = true;
  updateButtons();
  try {
    if (back !== 0) await pedalToScene1(dev);
    await send(dev);
    return true;
  } catch (e) {
    log(`${what}: ${e.message}`);
    return false;
  } finally {
    if (back !== 0) {
      try {
        await dev.waitQuiet(150, 1500);
        await dev.selectScene(back);
      } catch { /* ignore */ }
    }
    state.sceneHop = false;
    state.busy = false;
    updateButtons();
  }
}

async function setBlockAlg(slot, category, code, wasEmpty) {
  const a = algInfo(code);
  const params = [];
  for (const p of a?.params ?? []) params[p.id] = p.def;
  const scene = editScene();
  let on = true;
  if (!editPreset((raw) => {
    if (!wasEmpty) on = sceneOn(raw, scene)[slot];
    let r = setPresetAlg(raw, slot, category, code, params);
    if (wasEmpty) for (let s = 0; s < presetSceneCount(raw); s++) r = setPresetOn(r, s, slot, true);
    return r;
  })) return;
  state.selSlot = slot;
  renderEditor();
  if (await inScene1('change block', (dev) => dev.send(CMD.SET_ALG, setAlgPayload(slot, category, code, on)))) {
    log(`slot ${slot + 1}: ${a?.name ?? hex32(code)}${editScene() ? ' (sent in scene 1)' : ''}`);
  }
}

/**
 * Put a saved block into `slot` with confirmed commands only: set the algorithm (the pedal resets the parameters
 * of all scenes), then per scene select it and send every parameter, and the on/off states; finally select the
 * scene that was active before.
 */
async function restoreBlock(slot, block) {
  if (!block || !canTalk()) return;
  const a = algInfo(block.code);
  const ids = a ? a.params.map((p) => p.id) : Array.from({ length: 25 }, (_, i) => i);
  const scene = editScene();
  if (!editPreset((raw) => setPresetBlock(raw, slot, block))) return;
  state.selSlot = slot;
  state.restoring = slot;
  state.busy = true;
  updateButtons();
  renderEditor();
  try {
    const dev = state.dev;
    state.sceneHop = true;
    await pedalToScene1(dev); // block changes only in scene 1 (see inScene1)
    await dev.send(CMD.SET_ALG, setAlgPayload(slot, block.category, block.code, block.on[0]));
    await dev.waitQuiet(150, 1500);
    const nScenes = presetSceneCount(state.presets.get(state.current));
    for (let s = 0; s < nScenes; s++) {
      const src = Math.min(s, block.params.length - 1);
      await dev.selectScene(s);
      for (const id of ids) await dev.send(CMD.PARAM, paramPayload(slot, id, block.params[src][id] ?? 0));
      await dev.send(CMD.SLOT_ON, slotOnPayload(s, presetOn(state.presets.get(state.current), s)));
    }
    await dev.selectScene(scene);
    log(`slot ${slot + 1}: block "${block.name ?? a?.name ?? hex32(block.code)}" restored`);
  } catch (e) {
    log(`restore block: ${e.message}`);
  } finally {
    await state.dev?.waitQuiet(150, 1500);
    if (state.dev && editScene() !== 0) await state.dev.selectScene(editScene()).catch(() => {});
    state.sceneHop = false;
    state.restoring = -1;
    state.busy = false;
    updateButtons();
    renderEditor();
  }
}

async function removeBlock(slot) {
  if (!editPreset((raw) => {
    let r = setPresetAlg(raw, slot, 0xff, EMPTY_ALG, []);
    for (let s = 0; s < presetSceneCount(raw); s++) r = setPresetOn(r, s, slot, false);
    return r;
  })) return;
  renderEditor();
  // what the Hotone app sends (deleteSlotData) – not confirmed by a capture yet
  if (await inScene1('delete block', (dev) => dev.send(CMD.SET_ALG, setAlgPayload(slot, 0xff, EMPTY_ALG, false)))) {
    log(`slot ${slot + 1}: deleted`);
  }
}

async function swapPositions(a, b) {
  let seq, moved = [], click;
  if (!editPreset((raw) => {
    seq = presetSeq(raw);
    [seq[a], seq[b]] = [seq[b], seq[a]];
    let r = setPresetSeq(raw, seq);
    if (state.fsFollow) {
      // the assignment is per position: swap the two positions in the table of every footswitch that has them
      for (let f = 0; f < 3; f++) {
        const on = presetFsSlots(r, f);
        if (on[a] === on[b]) continue;
        r = setPresetFsSlot(r, f, a, on[b]);
        r = setPresetFsSlot(r, f, b, on[a]);
        moved.push(f);
      }
      click = presetFs(r).click;
    }
    return r;
  })) return;
  renderEditor();
  const raw = state.presets.get(state.current);
  await inScene1('move block', async (dev) => {
    await dev.send(CMD.REORDER, reorderPayload(seq));
    if (!moved.length) return;
    // like the Hotone editor after an assignment: the table of the footswitch, then the functions
    for (const f of moved) await dev.send(FS_SLOTS_SET, fsSlotsPayload(f, presetFsSlots(raw, f)));
    await dev.send(FS_SET, Uint8Array.from(click));
    log(`footswitch ${moved.map((f) => `FS${f + 1}`).join(', ')} moved with the block`);
  });
}

/** The pedal reports the new contents of a slot after SET_ALG: take its parameters (all scenes). */
function onSlotPush(payload) {
  const raw = state.presets.get(state.current);
  if (!raw || payload.length < 116) return;
  const v = new DataView(payload.buffer, payload.byteOffset);
  const slot = v.getUint32(0, true), code = v.getUint32(12, true);
  if (slot === state.restoring) return; // our own restore sends the real values next
  if (slot >= 12 || presetChain(raw).find((x) => x.slot === slot)?.code !== code) return;
  const params = Array.from({ length: 25 }, (_, i) => v.getFloat32(16 + 4 * i, true));
  state.presets.set(state.current, setPresetAlg(raw, slot, v.getUint32(4, true), code, params));
  if (!state.dragging) renderEditor();
}

// ------------------------------------------------------------------ scenes: tempo, volume, name

async function setSceneValue(what, value) {
  const scene = editScene();
  const v = what === 'tempo' ? Math.max(40, Math.min(300, Math.round(value) || 120)) : Math.max(0, Math.min(100, Math.round(value)));
  if (!sceneEditable()) return;
  if (!editPreset((raw) => setPresetScene(raw, scene, { [what]: v }))) return;
  markDirty();
  await state.dev.send(what === 'tempo' ? CMD.SCENE_TEMPO : CMD.SCENE_VOLUME, sceneValuePayload(scene, v));
  log(`scene ${scene + 1}: ${what} ${v}`);
}

async function renameScene(s) {
  const raw = state.presets.get(state.current);
  if (!raw || !canTalk()) return;
  const old = sceneMeta(raw, s).name || `Scene ${s + 1}`;
  const name = await promptText({ title: `Rename scene ${s + 1}`, text: `At most ${SCENE_NAME_LEN - 1} characters.`, value: old,
    maxLength: SCENE_NAME_LEN - 1, ok: 'Rename', validate: (t) => (!t.trim() ? 'enter a name'
      : /^[\x20-\x7e]*$/.test(t) ? '' : 'only plain ASCII characters') });
  if (name == null || name === old) return;
  if (!editPreset((r) => setPresetScene(r, s, { name }))) return;
  renderEditor();
  await state.dev.send(CMD.SCENE_NAME, sceneNamePayload(s, name));
  log(`scene ${s + 1} renamed to "${name}"`);
}

/** One parameter changed: update our copy of the preset, send to the pedal (throttled, last value wins). */
const pendingParams = new Map(); // "slot/id" -> {slot, id, value, timer, sent}

function changeParam(slot, id, value) {
  const i = state.current;
  const raw = state.presets.get(i);
  if (!raw || !canTalk() || !sceneEditable()) return;
  state.presets.set(i, setPresetParam(raw, editScene(), slot, id, value));
  if (state.dirty !== i) {
    state.dirty = i;
    markDirty(); // only the head - rebuilding the panel would take the focus / drag from the control
  }
  const key = `${slot}/${id}`;
  const p = pendingParams.get(key) ?? { slot, id, timer: 0, sent: NaN };
  p.value = value;
  pendingParams.set(key, p);
  if (p.timer) return; // sent when the timer fires
  const flush = () => {
    p.timer = 0;
    if (p.value === p.sent || !state.dev) return;
    p.sent = p.value;
    state.dev.send(CMD.PARAM, paramPayload(p.slot, p.id, p.value)).catch((e) => log(`parameter: ${e.message}`));
    p.timer = setTimeout(flush, PARAM_SEND_MS);
  };
  flush();
}

/** Show / hide "modified – not saved" and Save in the preset head (without rebuilding anything else). */
function markDirty() {
  const dirty = state.dirty >= 0 && state.dirty === state.current;
  $('edDirty').hidden = !dirty;
  $('edSave').hidden = !dirty;
  $('edSave').disabled = !canTalk();
}

// ------------------------------------------------------------------ global settings

async function readGlobals() {
  if (!canTalk()) return;
  state.busy = true;
  updateButtons();
  try {
    const m = new Map();
    for (const g of [0x00010000, 0x00020000, 0x00060000, 0x00070000, 0x00080000]) {
      m.set(g, await state.dev.request(g, new Uint8Array(0), { timeout: 2000, retries: 1 }));
    }
    state.globals = m;
    state.eq = parseEq(await state.dev.request(EQ.GET, new Uint8Array(0), { timeout: 2000, retries: 1 }));
    $('globalInfo').textContent = '';
  } catch (e) {
    log(`reading global settings: ${e.message}`);
  } finally {
    state.busy = false;
    updateButtons();
  }
  renderGlobals();
}

async function setGlobal(p, value) {
  if (!canTalk()) return;
  if (p.choices && !isStage() && !STOMP_FS_FUNCTIONS.has(value)) {
    log(`${p.name}: "${describeGlobal(p, value)}" is not available on the Stomp – not sent`);
    return;
  }
  const ans = state.globals?.get(groupOf(p.addr));
  const i = paramByte(p);
  if (ans && i < ans.length) ans[i] = rawByte(p, value);
  await state.dev.send(p.addr, globalPayload(p, value));
  log(`${p.name}: ${describeGlobal(p, value)}`);
}

function describeGlobal(p, v) {
  if (p.switch) return v ? 'on' : 'off';
  if (p.level) return v <= p.level[0] ? 'Mute' : `${v} dB`;
  if (p.channel) return v >= 16 ? 'Omni' : `${v + 1}`;
  if (p.colors) return `color ${v + 1}`;
  if (p.choices) return p.choices.find(([val]) => val === v)?.[1] ?? `value ${v}`;
  return p.options?.[v] ?? `value ${v}`;
}

function renderGlobals() {
  const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls ?? '', textContent: text ?? '' });
  const box = $('globalCards');
  box.replaceChildren();
  $('globalInfo').textContent = state.globals ? '' : state.dev ? 'not read yet' : 'connect the pedal to read the settings';
  const live = canTalk() && !!state.globals;
  // EXP/CTRL Function decides which EXT FS rows are shown
  const modeParam = GLOBAL_GROUPS.flatMap((g) => g.params).find((p) => p.addr === 0x00070001);
  const ctrlMode = paramValue(modeParam, state.globals?.get(groupOf(modeParam.addr)));
  for (const g of GLOBAL_GROUPS) {
    const card = el('div', 'card');
    card.append(el('h2', '', g.title));
    for (const p of g.params) {
      const v = paramValue(p, state.globals?.get(groupOf(p.addr)));
      const row = el('div', 'gs-row');
      if (p.mode != null && ctrlMode != null && p.mode !== ctrlMode) continue; // EXT FS rows of the other modes
      const label = el('span', '', ctrlMode == null && p.mode != null ? `${p.name} (${p.mode === 1 ? 'Single' : 'Dual'} FS)` : p.name);
      if (p.guess) {
        const q = el('span', 'gs-guess', ' ?');
        q.title = 'option names not confirmed yet – the raw value is shown in brackets';
        label.append(q);
      }
      row.append(label);
      if (p.switch) {
        const b = el('button', `sw${v ? ' on' : ''}`, v ? 'On' : 'Off');
        b.onclick = async () => {
          await setGlobal(p, v ? 0 : 1);
          renderGlobals();
        };
        b.disabled = !live;
        row.append(b);
      } else if (p.level) {
        const r = el('input');
        Object.assign(r, { type: 'range', min: p.level[0], max: p.level[1], step: 1, value: v ?? 0, disabled: !live });
        const val = el('span', 'gs-val', v == null ? '' : describeGlobal(p, v));
        r.oninput = () => {
          val.textContent = describeGlobal(p, +r.value);
        };
        r.onchange = () => setGlobal(p, +r.value);
        row.append(r, val);
      } else if (p.colors) {
        const c = el('span', 'gs-colors');
        p.colors.forEach((color, k) => {
          const b = el('button', k === v ? 'on' : '');
          b.style.background = color;
          b.title = `color ${k + 1}`;
          b.disabled = !live;
          b.onclick = async () => {
            await setGlobal(p, k);
            renderGlobals();
          };
          c.append(b);
        });
        row.append(c);
      } else {
        const s = el('select');
        if (p.choices) { // explicit [value, label] pairs; "Scene 4/5" only on a pedal with 5 scenes (Stage)
          const choices = p.choices.filter(([val]) => isStage() || STOMP_FS_FUNCTIONS.has(val));
          for (const [val, lab] of choices) s.append(new Option(lab, String(val)));
          if (v != null && !p.choices.some(([val]) => val === v)) s.append(new Option(`value ${v}`, String(v)));
          s.value = v == null ? '' : String(v);
          s.disabled = !live;
          s.onchange = () => setGlobal(p, +s.value);
          row.append(s);
          card.append(row);
          continue;
        }
        const opts = p.channel ? [...Array.from({ length: 16 }, (_, k) => `Channel ${k + 1}`), 'Omni']
          : p.options ?? Array.from({ length: (p.max ?? 0) + 1 }, (_, k) => `value ${k}`);
        opts.forEach((o, k) => s.append(new Option(p.guess && p.options ? `${o} [${k}]` : o, String(k))));
        if (v != null && v >= opts.length) s.append(new Option(`value ${v}`, String(v)));
        s.value = v == null ? '' : String(v);
        s.disabled = !live;
        s.onchange = async () => {
          await setGlobal(p, +s.value);
          if (p === modeParam) renderGlobals(); // the EXT FS rows follow EXP/CTRL Function
        };
        row.append(s);
      }
      card.append(row);
    }
    if (g.note) card.append(el('p', 'muted small', g.note));
    box.append(card);
  }
  box.append(renderEq(live));
  fillRanges();
}


function renderEq(live) {
  const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls ?? '', textContent: text ?? '' });
  const card = el('div', 'card gs-eq');
  card.append(el('h2', '', 'Global EQ'));
  const eq = state.eq;
  const head = el('div', 'gs-row');
  const sw = el('button', `sw${eq?.on ? ' on' : ''}`, eq?.on ? 'On' : 'Off');
  sw.disabled = !live;
  sw.onclick = async () => {
    eq.on = !eq.on;
    await state.dev.send(EQ.SWITCH, u32b(eq.on ? 1 : 0));
    log(`Global EQ ${eq.on ? 'on' : 'off'}`);
    renderGlobals();
  };
  const vol = el('input');
  Object.assign(vol, { type: 'range', min: 0, max: 100, step: 1, value: eq?.values[EQ_VOLUME] ?? 50, disabled: !live });
  const volVal = el('span', 'gs-val', eq ? `${Math.round(eq.values[EQ_VOLUME])}` : '');
  vol.oninput = () => {
    volVal.textContent = vol.value;
  };
  vol.onchange = () => setEq(EQ_VOLUME, +vol.value);
  const reset = el('button', '', 'Reset');
  reset.title = 'reset the global EQ to its defaults';
  reset.disabled = !live;
  reset.onclick = async () => {
    await state.dev.send(EQ.RESET, u32b(0));
    state.eq = parseEq(await state.dev.request(EQ.GET, new Uint8Array(0), { timeout: 2000, retries: 1 }));
    log('Global EQ reset');
    renderGlobals();
  };
  const view = el('button', 'small-btn', state.eqTable ? 'Graph' : 'Table');
  view.title = 'switch between the graphic view and the table of values';
  view.onclick = () => {
    state.eqTable = !state.eqTable;
    renderGlobals();
  };
  head.append(el('span', '', 'EQ'), sw, el('span', 'muted small', 'Volume'), vol, volVal, reset, view);
  card.append(head);
  if (!state.eqTable) {
    card.append(eqGraph(eq, live));
    return card;
  }
  const t = el('table', 'eq-table');
  t.innerHTML = '<thead><tr><th>Band</th><th>On</th><th>Freq (Hz)</th><th>Q</th><th>Gain (dB)</th></tr></thead>';
  const tb = t.createTBody();
  for (const b of EQ_BANDS) {
    const tr = tb.insertRow();
    tr.insertCell().textContent = b.name;
    const on = el('input');
    Object.assign(on, { type: 'checkbox', checked: (eq?.values[b.on] ?? 0) >= 0.5, disabled: !live });
    on.onchange = () => setEq(b.on, on.checked ? 1 : 0);
    tr.insertCell().append(on);
    for (const [k, min, max, step] of [['freq', 20, 20000, 1], ['q', 0.1, 10, 0.01], ['gain', -15, 15, 0.1]]) {
      const c = tr.insertCell();
      if (b[k] == null) continue;
      const n = el('input');
      Object.assign(n, { type: 'number', min, max, step, value: eq ? +eq.values[b[k]].toFixed(k === 'freq' ? 0 : 2) : '', disabled: !live });
      n.onchange = () => setEq(b[k], Math.min(max, Math.max(min, +n.value)));
      c.append(n);
    }
  }
  card.append(t, el('p', 'muted small', 'Values as in the Hotone software (frequency, Q, gain per band). Ranges of Q and gain are not confirmed.'));
  return card;
}

// ------------------------------------------------------------------ graphic global EQ

const EQ_COLORS = ['#e05a6d', '#e07a3a', '#b5d33a', '#3ad16b', '#3acfc7', '#4d6bff', '#a05cff', '#d64dc8'];
const EQ_FS = 44100;

/** |H(f)| in dB of one band (RBJ audio EQ cookbook biquads). kind: hp, ls, pk, hs, lp. */
function bandDb(kind, f0, q, gain, f) {
  const A = 10 ** (gain / 40), w0 = 2 * Math.PI * Math.min(f0, EQ_FS / 2.05) / EQ_FS, cw = Math.cos(w0), sw = Math.sin(w0);
  const al = sw / (2 * Math.max(q, 0.05));
  let b0, b1, b2, a0, a1, a2;
  if (kind === 'hp') [b0, b1, b2, a0, a1, a2] = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2, 1 + al, -2 * cw, 1 - al];
  else if (kind === 'lp') [b0, b1, b2, a0, a1, a2] = [(1 - cw) / 2, 1 - cw, (1 - cw) / 2, 1 + al, -2 * cw, 1 - al];
  else if (kind === 'pk') [b0, b1, b2, a0, a1, a2] = [1 + al * A, -2 * cw, 1 - al * A, 1 + al / A, -2 * cw, 1 - al / A];
  else {
    const s = 2 * Math.sqrt(A) * al, sg = kind === 'ls' ? 1 : -1;
    b0 = A * ((A + 1) - sg * (A - 1) * cw + s); b1 = sg * 2 * A * ((A - 1) - sg * (A + 1) * cw); b2 = A * ((A + 1) - sg * (A - 1) * cw - s);
    a0 = (A + 1) + sg * (A - 1) * cw + s; a1 = -sg * 2 * ((A - 1) + sg * (A + 1) * cw); a2 = (A + 1) + sg * (A - 1) * cw - s;
  }
  const w = 2 * Math.PI * f / EQ_FS;
  const re = (c0, c1, c2) => c0 + c1 * Math.cos(w) + c2 * Math.cos(2 * w), im = (c1, c2) => -(c1 * Math.sin(w) + c2 * Math.sin(2 * w));
  const num = re(b0, b1, b2) ** 2 + im(b1, b2) ** 2, den = re(a0, a1, a2) ** 2 + im(a1, a2) ** 2;
  return 10 * Math.log10(num / den);
}

const EQ_KINDS = ['hp', 'ls', 'pk', 'pk', 'pk', 'pk', 'hs', 'lp'];

function eqGraph(eq, live) {
  const NS = 'http://www.w3.org/2000/svg', W = 900, H = 260, L = 34, R = 26, T = 10, B = 24, DB = 25;
  const fx = (f) => L + (Math.log10(f / 20) / 3) * (W - L - R), fy = (db) => T + ((DB - db) / (2 * DB)) * (H - T - B);
  const xf = (x) => 20 * 10 ** (((x - L) / (W - L - R)) * 3), yd = (y) => DB - ((y - T) / (H - T - B)) * 2 * DB;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.classList.add('eq-graph');
  const add = (tag, attrs, text) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    svg.append(e);
    return e;
  };
  for (const db of [-25, -20, -15, -10, -5, 0, 5, 10, 15, 20, 25]) {
    add('line', { x1: L, x2: W - R, y1: fy(db), y2: fy(db), class: db === 0 ? 'g0' : 'g' });
    add('text', { x: L - 6, y: fy(db) + 4, class: 'gl', 'text-anchor': 'end' }, db);
  }
  for (const f of [20, 30, 40, 50, 60, 70, 80, 90, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 20000]) {
    add('line', { x1: fx(f), x2: fx(f), y1: T, y2: H - B, class: 'g' });
  }
  for (const [f, t] of [[20, '20'], [50, '50'], [100, '100'], [200, '200'], [500, '500'], [1000, '1.0k'], [2000, '2.0k'], [5000, '5.0k'], [10000, '10.0k'], [20000, '20.0k']]) {
    add('text', { x: fx(f), y: H - 6, class: 'gl', 'text-anchor': 'middle' }, t);
  }
  if (!eq) return svg;
  const v = eq.values;
  const curve = add('path', { class: 'eq-curve' });
  const draw = () => {
    let d = '';
    for (let x = L; x <= W - R; x += 3) {
      const f = xf(x);
      let db = 0;
      EQ_BANDS.forEach((b, k) => {
        if (v[b.on] >= 0.5) db += bandDb(EQ_KINDS[k], v[b.freq], v[b.q], b.gain != null ? v[b.gain] : 0, f);
      });
      d += `${d ? 'L' : 'M'}${x.toFixed(1)},${fy(Math.max(-DB, Math.min(DB, db))).toFixed(1)}`;
    }
    curve.setAttribute('d', d);
  };
  draw();
  EQ_BANDS.forEach((b, k) => {
    const on = v[b.on] >= 0.5;
    const g = add('circle', { r: 7, class: `eq-pt${on ? '' : ' off'}`, stroke: EQ_COLORS[k] });
    const place = () => {
      g.setAttribute('cx', fx(Math.min(20000, Math.max(20, v[b.freq]))));
      g.setAttribute('cy', fy(b.gain != null ? v[b.gain] : 0));
    };
    place();
    const tip = () => `${b.name}: ${Math.round(v[b.freq])} Hz, Q ${v[b.q].toFixed(2)}${b.gain != null ? `, ${v[b.gain].toFixed(1)} dB` : ''}` +
      `${on ? '' : ' (off – double-click to switch on)'}\ndrag: frequency${b.gain != null ? ' / gain' : ''} · wheel: Q · double-click: on/off`;
    const title = document.createElementNS(NS, 'title');
    title.textContent = tip();
    g.append(title);
    if (!live) return;
    const send = throttle((i, x) => setEq(i, x), 80);
    g.onpointerdown = (e) => {
      g.setPointerCapture(e.pointerId);
      const rect = svg.getBoundingClientRect(), sx = W / rect.width, sy = H / rect.height;
      g.onpointermove = (m) => {
        const x = (m.clientX - rect.left) * sx, y = (m.clientY - rect.top) * sy;
        v[b.freq] = Math.round(Math.min(20000, Math.max(20, xf(x))));
        send(b.freq, v[b.freq]);
        if (b.gain != null) {
          v[b.gain] = Math.round(Math.max(-15, Math.min(15, yd(y))) * 10) / 10;
          send(b.gain, v[b.gain]);
        }
        place();
        draw();
        title.textContent = tip();
      };
      g.onpointerup = g.onpointercancel = () => {
        g.onpointermove = g.onpointerup = g.onpointercancel = null;
      };
    };
    g.onwheel = (e) => {
      e.preventDefault();
      v[b.q] = Math.round(Math.max(0.1, Math.min(10, v[b.q] * (e.deltaY < 0 ? 1.1 : 1 / 1.1))) * 100) / 100;
      send(b.q, v[b.q]);
      draw();
      title.textContent = tip();
    };
    g.ondblclick = () => {
      v[b.on] = on ? 0 : 1;
      setEq(b.on, v[b.on]);
      renderGlobals();
    };
  });
  return svg;
}

/** Call fn(key, value) at most every ms milliseconds per key, always with the latest value. */
function throttle(fn, ms) {
  const last = new Map();
  return (key, value) => {
    const s = last.get(key) ?? { t: 0, v: null, timer: 0 };
    s.v = value;
    last.set(key, s);
    const now = performance.now();
    if (now - s.t >= ms) {
      s.t = now;
      fn(key, value);
    } else if (!s.timer) {
      s.timer = setTimeout(() => {
        s.timer = 0;
        s.t = performance.now();
        fn(key, s.v);
      }, ms - (now - s.t));
    }
  };
}

async function setEq(index, value) {
  if (!canTalk() || !state.eq) return;
  state.eq.values[index] = value;
  await state.dev.send(EQ.VALUE, eqValuePayload(index, value));
  log(`Global EQ [${index}] = ${value}`);
}

// ------------------------------------------------------------------ IR & NAM uploads

async function readFileLists() {
  if (!canTalk()) return;
  state.busy = true;
  updateButtons();
  try {
    state.irNames = await state.dev.irNames();
    state.namNames = await state.dev.namNames();
  } catch (e) {
    log(`reading IR / NAM lists: ${e.message}`);
  } finally {
    state.busy = false;
    updateButtons();
  }
  renderFiles();
}

function renderFiles() {
  const fill = (table, kind, count, names, label) => {
    const tb = $(table).tBodies[0];
    tb.replaceChildren();
    for (let s = 0; s < count; s++) {
      const tr = tb.insertRow();
      const name = names?.[s];
      const st = state.uploadStatus.get(`${kind}:${s}`);
      tr.insertCell().textContent = label(s);
      const nm = tr.insertCell();
      nm.className = `nm${!name ? ' empty' : ''}`;
      nm.textContent = names ? name || '(empty)' : '–';
      const b = document.createElement('button');
      b.className = 'up-btn small-btn';
      b.textContent = 'Upload…';
      b.disabled = !canTalk();
      b.onclick = () => (kind === 'ir' ? uploadIr(s) : uploadNam(s));
      const rn = document.createElement('button');
      rn.className = 'up-btn small-btn';
      rn.textContent = 'Rename…';
      rn.title = 'untested: command from the Hotone app';
      rn.disabled = !canTalk() || !name;
      rn.onclick = () => renameFile(kind, s);
      const del = document.createElement('button');
      del.className = 'up-btn small-btn';
      del.textContent = 'Delete';
      del.title = 'untested: command from the Hotone app';
      del.disabled = !canTalk() || !name;
      del.onclick = () => deleteFile(kind, s);
      tr.insertCell().append(b, rn, del);
      const c = tr.insertCell();
      c.className = `st ${st?.cls ?? ''}`;
      c.textContent = st?.text ?? '';
    }
  };
  fill('irTable', 'ir', USER_IRS, state.irNames, (s) => `User IR ${s + 1}`);
  fill('namTable', 'nam', NAM_SLOTS, state.namNames, (s) => `NAM ${s + 1}`);
  $('irInfo').textContent = state.irNames ? '' : state.dev ? 'not read yet' : 'connect the pedal to read the list';
  $('namInfo').textContent = state.namNames ? '' : state.dev ? 'not read yet' : 'connect the pedal to read the list';
}

function pickFile(accept) {
  return new Promise((resolve) => {
    const input = $('uploadFile');
    input.value = '';
    input.accept = accept;
    input.onchange = () => resolve(input.files[0] ?? null);
    input.click();
  });
}

const baseName = (f) => f.name.replace(/\.[^.]*$/, '').replace(/[^\x20-\x7e]/g, '_').slice(0, UPLOAD_NAME);
const validName = (t) => (!t.trim() ? 'enter a name' : /^[\x20-\x7e]*$/.test(t) ? '' : 'only plain ASCII characters');

async function uploadIr(slot) {
  const file = await pickFile('.wav,audio/wav');
  if (!file) return;
  const key = `ir:${slot}`;
  let ir;
  try {
    ir = wavToIr(new Uint8Array(await file.arrayBuffer()));
  } catch (e) {
    state.uploadStatus.set(key, { cls: 'err', text: `${file.name}: ${e.message}` });
    renderFiles();
    return;
  }
  const i = ir.info;
  const desc = `${file.name}: ${i.rate} Hz, ${i.float ? 'float' : `${i.bits} bit`}, ${i.channels === 1 ? 'mono' : `${i.channels} channels (first used)`}, ` +
    `${Math.round(i.ms)} ms${i.truncated ? ' (cut to 46 ms)' : ''}${i.clipped ? `, ${i.clipped} samples clipped` : ''}.`;
  const old = state.irNames?.[slot];
  const name = await promptText({ title: `Upload IR into User IR ${slot + 1}`,
    text: `${desc} This replaces ${old ? `"${old}"` : 'the IR'} in User IR ${slot + 1}. Name (max. ${UPLOAD_NAME} characters):`,
    value: baseName(file), maxLength: UPLOAD_NAME, ok: 'Upload', validate: validName });
  if (name == null) return;
  await runUpload(key, `User IR ${slot + 1}`, () => state.dev.uploadIr(slot, name, ir.samples));
}

async function uploadNam(slot) {
  const file = await pickFile('.nam,.namb');
  if (!file) return;
  const key = `nam:${slot}`;
  let namb, desc;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (isNamb(bytes)) {
      namb = bytes;
      desc = `${file.name}: NAMB file, ${bytes.length} bytes.`;
    } else {
      const model = JSON.parse(new TextDecoder().decode(bytes));
      if (model.architecture !== 'SlimmableContainer') {
        throw new Error(`this is a NAM A1 model (${model.architecture}) – the Hotone software converts those into its own ` +
          'format, which this app does not support. Use a NAM A2 model.');
      }
      const r = namToNamb(model);
      namb = r.namb;
      desc = `${file.name}: ${r.architecture}, ${r.weights} weights, ${namb.length} bytes` +
        `${r.submodel ? ` (NAM A2: submodel ${r.submodel.index + 1} of ${r.submodel.count}, the smallest)` : ''}.`;
    }
  } catch (e) {
    state.uploadStatus.set(key, { cls: 'err', text: `${file.name}: ${e.message}` });
    renderFiles();
    return;
  }
  const old = state.namNames?.[slot];
  const name = await promptText({ title: `Upload NAM model into NAM ${slot + 1}`,
    text: `${desc} This replaces ${old ? `"${old}"` : 'the model'} in NAM ${slot + 1}. Name (max. ${UPLOAD_NAME} characters):`,
    value: baseName(file), maxLength: UPLOAD_NAME, ok: 'Upload', validate: validName });
  if (name == null) return;
  await runUpload(key, `NAM ${slot + 1}`, () => state.dev.uploadNam(slot, name, namb));
}

async function renameFile(kind, s) {
  const old = (kind === 'ir' ? state.irNames : state.namNames)?.[s] ?? '';
  const label = kind === 'ir' ? `User IR ${s + 1}` : `NAM ${s + 1}`;
  const name = await promptText({ title: `Rename ${label}`, text: `At most ${UPLOAD_NAME} characters. ${UNTESTED}`, value: old,
    maxLength: UPLOAD_NAME, ok: 'Rename', validate: validName });
  if (name == null || name === old) return;
  await runUpload(`${kind}:${s}`, label, () => (kind === 'ir'
    ? state.dev.send(CMD.IR_RENAME, idNamePayload(FACTORY_IRS + s, name, 32))
    : state.dev.send(CMD.NAM_RENAME, idNamePayload(s, name, 16))).then(() => state.dev.waitQuiet(300, 3000)), 'renamed');
}

async function deleteFile(kind, s) {
  const names = kind === 'ir' ? state.irNames : state.namNames;
  const label = kind === 'ir' ? `User IR ${s + 1}` : `NAM ${s + 1}`;
  const ok = await confirmSlots({ title: `Delete ${label}?`, text: `Presets that use it lose the ${kind === 'ir' ? 'IR' : 'model'}. ${UNTESTED}`,
    rows: [{ slot: label, now: names?.[s] ?? '', next: '(deleted)' }], ok: 'Delete' });
  if (!ok) return;
  await runUpload(`${kind}:${s}`, label, () => state.dev.send(kind === 'ir' ? CMD.IR_DELETE : CMD.NAM_DELETE,
    u32Payload(kind === 'ir' ? FACTORY_IRS + s : s)).then(() => state.dev.waitQuiet(300, 3000)), 'deleted');
}

async function runUpload(key, label, send, done = 'uploaded') {
  if (!canTalk()) return;
  state.busy = true;
  updateButtons();
  state.uploadStatus.set(key, { cls: 'busy', text: done === 'uploaded' ? 'uploading…' : '…' });
  renderFiles();
  try {
    await send();
    state.uploadStatus.set(key, { cls: 'ok', text: done });
    log(`${label}: ${done}`);
  } catch (e) {
    state.uploadStatus.set(key, { cls: 'err', text: e.message });
    log(`${label}: upload failed – ${e.message}`);
  } finally {
    state.busy = false;
    updateButtons();
  }
  await readFileLists();
}

async function savePreset() {
  const i = state.current, raw = state.presets.get(i);
  if (!raw || !canTalk() || !sceneEditable()) return;
  const name = presetInfo(raw).name;
  await state.dev.send(CMD.SAVE, savePayload(i, name));
  state.dirty = -1;
  log(`${presetLabel(i)} "${name}" saved`);
  await readIntoView(i); // what the pedal stored (it is saved now, so reading it loses nothing)
}

/**
 * Lines of the routing (SVG over the chain, measured after layout), like the Hotone software:
 * split node -> down, to the left, into row 2;  end of row 2 -> to the right, up, into the merge node.
 */
function drawRouting() {
  const chain = $('chain');
  let svg = $('chainSvg');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'chainSvg';
    svg.classList.add('chain-svg');
    chain.appendChild(svg);
  }
  svg.innerHTML = '';
  if (!chain.offsetWidth) return;
  const c = chain.getBoundingClientRect();
  const rel = (r) => ({ l: r.left - c.left, r: r.right - c.left, t: r.top - c.top, b: r.bottom - c.top,
    x: (r.left + r.right) / 2 - c.left, y: (r.top + r.bottom) / 2 - c.top });
  const A = rel($('chainRowA').getBoundingClientRect());
  const B = rel($('chainRowB').getBoundingClientRect());
  const L = rel($('chainLeft').getBoundingClientRect());
  const R = rel($('chainRight').getBoundingClientRect());
  const yMid = (A.y + B.y) / 2 + 4; // horizontal lines between the rows
  const rad = 12;
  const add = (d) => {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  };
  const sn = chain.querySelector('#chainRowA .node.split');
  if (sn) { // split node -> row 2
    const n = rel(sn.getBoundingClientRect());
    const x0 = L.x;
    add(`M ${n.x} ${n.b} V ${yMid - rad} Q ${n.x} ${yMid} ${n.x - rad} ${yMid} H ${x0 + rad} ` +
      `Q ${x0} ${yMid} ${x0} ${yMid + rad} V ${B.y - rad} Q ${x0} ${B.y} ${x0 + rad} ${B.y} H ${B.l}`);
  }
  const mn = chain.querySelector('#chainRowA .node.merge');
  if (mn) { // row 2 -> merge node
    const n = rel(mn.getBoundingClientRect());
    const x1 = R.x;
    add(`M ${B.r} ${B.y} H ${x1 - rad} Q ${x1} ${B.y} ${x1} ${B.y - rad} V ${yMid + rad} ` +
      `Q ${x1} ${yMid} ${x1 - rad} ${yMid} H ${n.x + rad} Q ${n.x} ${yMid} ${n.x} ${yMid - rad} V ${n.b}`);
  }
}

/** Scene buttons of the editor: preview the scene, and switch it on the pedal when connected. */
async function chooseScene(s) {
  if (s >= sceneCount()) return; // never select a scene the preset does not have (see sceneEditable)
  if (canTalk()) {
    await state.dev.selectScene(s);
    log(`scene ${s + 1}`);
  }
  state.scene = s;
  renderCurrent();
}

// ------------------------------------------------------------------ preset actions (context menu)

function openPresetMenu(i, x, y, li) {
  const online = !!state.dev && !state.otherHost && !state.sniffing;
  const why = !state.dev ? 'connect the pedal first' : state.sniffing ? 'the sniffer is running (listen only)'
    : state.otherHost ? 'paused: another program uses the pedal' : '';
  const canExport = online || !!state.backup?.presets.find((p) => p.index === i);
  const style = styleOf(i);
  li.classList.add('menu-open');
  contextMenu(x, y, [
    { label: 'Import Patch', items: [
      { label: 'From .prst / .raw file…', action: () => importToSlot(i), disabled: !online || state.busy, title: why },
    ] },
    { label: 'Export Patch', disabled: !canExport, title: canExport ? '' : why, items: [
      { label: '.prst (Hotone software)', action: () => exportSlot(i, 'prst') },
      { label: '.raw (TLV)', action: () => exportSlot(i, 'raw') },
    ] },
    { label: 'Rename…', action: () => renameSlot(i), disabled: !online || state.busy, title: why },
    { label: 'Move to… (untested)', action: () => movePreset(i), disabled: !online || state.busy, title: why },
    { label: 'Delete… (untested)', action: () => deletePreset(i), disabled: !online || state.busy, title: why, danger: true },
    { label: 'Style', disabled: !online || state.busy, title: why, items: [
      ...STYLES.map((s) => ({ label: s, checked: style === s, action: () => setStyleSlot(i, s) })),
      '-',
      { label: 'No style', checked: style === '', action: () => setStyleSlot(i, '') },
    ] },
  ]);
  const clear = () => li.classList.remove('menu-open');
  document.addEventListener('mousedown', clear, { once: true });
}

/**
 * Run fn() with exclusive access to the pedal. Reading/writing a slot loads it on the pedal, so the preset
 * that was selected before is selected again afterwards.
 */
async function withPedal(what, fn) {
  if (!canTalk()) {
    log(`${what}: not possible now${state.sniffing ? ' (the sniffer is running – listen only)'
      : state.otherHost ? ' (paused: another program uses the pedal)' : ''}`);
    return;
  }
  await beginBusy();
  const original = await state.dev.currentPreset().catch(() => -1);
  try {
    await fn();
  } catch (e) {
    log(`${what} failed: ${e.message}`);
  } finally {
    if (original >= 0) {
      await state.dev.waitQuiet(100);
      await state.dev.selectPreset(original).catch(() => {});
      setCurrent(original, state.scene);
    }
    endBusy();
    renderList();
    renderCurrent();
    renderRestore();
  }
}

async function readSlot(i) {
  const raw = await state.dev.readPreset(i);
  cachePreset(i, raw);
  return raw;
}

/** Write a preset into a slot, read it back and compare. Returns a short result text. */
async function writeSlot(i, raw) {
  await state.dev.writePreset(i, raw);
  const back = await state.dev.readPreset(i);
  cachePreset(i, back);
  const cmp = compareStored(raw, back);
  if (cmp.identical) return 'verified';
  if (cmp.upgraded) return 'verified (stored in current format)';
  return `stored with ${cmp.diff} byte(s) differing`;
}

function decodePresetFile(name, bytes) {
  const raw = /\.prst$/i.test(name) ? decodePrst(bytes) : bytes;
  tlvSplit(raw); // throws if this is no TLV preset
  if (raw.length < 4000) throw new Error(`unexpected preset size ${raw.length} bytes`);
  return raw;
}

function importToSlot(i) {
  const input = $('importFile');
  input.value = '';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    let raw, info;
    try {
      raw = decodePresetFile(file.name, new Uint8Array(await file.arrayBuffer()));
      info = presetInfo(raw);
    } catch (e) {
      log(`import: ${file.name} is not a valid preset file (${e.message})`);
      return;
    }
    const ok = await confirmSlots({
      title: `Import "${info.name}" into ${presetLabel(i)}?`,
      text: `From ${file.name}. The preset in this slot is replaced; this cannot be undone.`,
      rows: [{ slot: presetLabel(i), now: state.deviceNames?.[i] ?? '?', next: info.name }],
      columns: ['Slot', 'Now on the pedal', '', 'Imported'],
      ok: 'Import',
    });
    if (!ok) return;
    await withPedal('import', async () => {
      const res = await writeSlot(i, raw);
      log(`imported ${file.name} into ${presetLabel(i)} "${info.name}" – ${res}`);
    });
  };
  input.click();
}

async function exportSlot(i, fmt) {
  let raw = null;
  if (state.dev && !state.otherHost && !state.sniffing) {
    // read the current state from the pedal (loads it; the previous preset is selected again)
    await withPedal('export', async () => {
      raw = await readSlot(i);
    });
  } else {
    raw = state.backup?.presets.find((p) => p.index === i)?.raw ?? null;
    if (raw) log(`export ${presetLabel(i)}: from the loaded backup (not connected)`);
  }
  if (!raw) return;
  const name = presetInfo(raw).name;
  const safe = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'unnamed';
  const file = `${presetLabel(i)}-${safe}.${fmt}`;
  const data = fmt === 'prst' ? encodePrst(raw) : raw;
  download(new Blob([data], { type: 'application/octet-stream' }), file);
  log(`exported ${presetLabel(i)} "${name}" as ${file}`);
}

const UNTESTED = 'This command is taken from the Hotone app and has not been confirmed with the pedal yet.';

/** 0x05000004: move a preset to another slot (like dragging it in the Hotone app's patch list). */
async function movePreset(i) {
  const t = await promptText({ title: `Move ${presetLabel(i)} "${state.deviceNames?.[i] ?? ''}"`,
    text: `Target slot, e.g. A12-3. ${UNTESTED}`, value: presetLabel(i), maxLength: 5, ok: 'Move',
    validate: (v) => (labelIndex(v) < 0 ? 'enter a slot like A12-3' : labelIndex(v) === i ? 'choose another slot' : '') });
  if (t == null) return;
  const to = labelIndex(t);
  await withPedal('move preset', async () => {
    await state.dev.send(CMD.PRESET_MOVE, u32Payload(to, i));
    await state.dev.waitQuiet(300, 3000);
    state.presets.delete(i);
    state.presets.delete(to);
    await refreshNames();
    log(`moved ${presetLabel(i)} → ${presetLabel(to)} (check the list)`);
  });
}

function labelIndex(t) {
  const m = /^\s*A?(\d{1,2})-([123])\s*$/i.exec(t);
  return m && +m[1] < 100 ? 3 * +m[1] + (+m[2] - 1) : -1;
}

/** 0x05000001: delete a preset (the slot becomes an empty preset). */
async function deletePreset(i) {
  const ok = await confirmSlots({ title: `Delete ${presetLabel(i)}?`, text: `The preset is deleted on the pedal. ${UNTESTED}`,
    rows: [{ slot: presetLabel(i), now: state.deviceNames?.[i] ?? '', next: '(deleted)' }], ok: 'Delete' });
  if (!ok) return;
  await withPedal('delete preset', async () => {
    await state.dev.send(CMD.PRESET_DELETE, u32Payload(i));
    await state.dev.waitQuiet(300, 3000);
    state.presets.delete(i);
    await refreshNames();
    log(`deleted ${presetLabel(i)} – now "${state.deviceNames?.[i] ?? ''}"`);
  });
}

async function renameSlot(i) {
  const old = state.deviceNames?.[i] ?? '';
  const name = await promptText({
    title: `Rename ${presetLabel(i)}`,
    text: `Current name: "${old}". At most ${MAX_NAME} characters (letters, digits, spaces, punctuation).`,
    value: old,
    maxLength: MAX_NAME,
    ok: 'Rename',
    validate: (v) => (!v.trim() ? 'the name must not be empty'
      : !/^[\x20-\x7e]*$/.test(v) ? 'only plain ASCII characters (no umlauts)' : ''),
  });
  if (name === null || name === old) return;
  await withPedal('rename', async () => {
    const raw = await readSlot(i);
    const res = await writeSlot(i, setPresetName(raw, name));
    log(`renamed ${presetLabel(i)} "${old}" → "${name}" – ${res}`);
  });
}

async function setStyleSlot(i, style) {
  await withPedal('set style', async () => {
    const raw = await readSlot(i);
    if (presetInfo(raw).style === style) return;
    const res = await writeSlot(i, setPresetStyle(raw, style));
    log(`${presetLabel(i)} "${state.deviceNames?.[i] ?? ''}": style ${style || 'none'} – ${res}`);
  });
}

async function readStyles() {
  const names = state.deviceNames;
  if (!names) return;
  const todo = names.map((_, i) => i).filter((i) => styleOf(i) === null);
  if (!todo.length) return;
  const ok = await confirmSlots({
    title: `Read ${todo.length} presets to learn their styles?`,
    text: `The pedal loads every preset while it is read (the display switches through them, the sound changes) – ` +
      `save unsaved edits on the pedal first. Takes about ${Math.ceil(todo.length * 0.65 / 60)} minute(s); ` +
      'the preset that is active now is selected again at the end.',
    rows: [],
    ok: 'Read',
  });
  if (!ok) return;
  state.abort = new AbortController();
  await withPedal('read styles', async () => {
    let n = 0;
    for (const i of todo) {
      if (state.abort.signal.aborted) throw new Error('cancelled');
      await readSlot(i);
      if (++n % 10 === 0) log(`read styles: ${n} / ${todo.length}`);
    }
    log(`read styles: ${n} presets read`);
  });
}

// ------------------------------------------------------------------ backup

function fillRange() {
  for (const sel of [$('fromSlot'), $('toSlot')]) {
    for (let i = 0; i < PRESET_COUNT; i++) sel.add(new Option(presetLabel(i), i));
  }
  $('fromSlot').value = 0;
  $('toSlot').value = PRESET_COUNT - 1;
}

/** Wait until a running poll is finished, then mark the app busy (polling pauses). */
async function beginBusy() {
  state.busy = true;
  updateButtons();
  while (state.refreshing) await sleep(50);
}

function endBusy() {
  state.busy = false;
  state.abort = null;
  state.namesDue = performance.now() + 300; // names may have changed
  updateButtons();
}

async function dump() {
  const from = +$('fromSlot').value, to = +$('toSlot').value;
  if (to < from) {
    log('"to" must not be before "from".');
    return;
  }
  state.abort = new AbortController();
  await beginBusy();
  const t0 = performance.now();
  $('progressBar').style.width = '0';
  try {
    const presets = await dumpPresets(state.dev, {
      from, to, signal: state.abort.signal,
      onProgress: (i, done, total, name) => {
        $('progressBar').style.width = `${(100 * done) / total}%`;
        $('progressText').textContent = `${done} / ${total} · ${presetLabel(i)} ${name}`;
        setCurrent(i, state.scene); // reading loads the preset on the pedal
      },
      onRestore: (i) => {
        setCurrent(i, state.scene);
        log(`selected ${presetLabel(i)} again`);
      },
    });
    for (const p of presets) cachePreset(p.index, p.raw);
    const list = await state.dev.request(CMD.PRESET_LIST, new Uint8Array(0), { timeout: 4000, retries: 2 });
    const { blob, fileName } = buildBackup(presets, { firmware: state.dev.firmware, presetList: list });
    download(blob, fileName);
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    $('progressText').textContent = `${presets.length} presets saved to ${fileName} (${secs} s)`;
    const st = state.dev.stats;
    log(`backup: ${presets.length} presets, ${secs} s -> ${fileName} ` +
      `(${st.damaged} of ${st.frames} received frames were damaged and re-requested)`);
  } catch (e) {
    $('progressText').textContent = `failed: ${e.message}`;
    log(`backup failed: ${e.message}`);
  } finally {
    endBusy();
  }
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ------------------------------------------------------------------ restore

async function openBackup(file) {
  try {
    state.backup = await loadBackup(new Uint8Array(await file.arrayBuffer()));
    state.restoreStatus.clear();
    const m = state.backup.manifest;
    $('backupInfo').textContent =
      `${file.name}: ${state.backup.presets.length} presets, firmware ${m.firmware || '?'}, ${new Date(m.created).toLocaleString()}`;
    log(`backup loaded: ${file.name}`);
  } catch (e) {
    state.backup = null;
    $('backupInfo').textContent = '';
    log(`cannot open ${file.name}: ${e.message}`);
  }
  renderRestore();
  renderList();
  updateButtons();
}

/** (Re)build the restore table; keeps check marks and the status of the last restore. */
function renderRestore() {
  const tb = $('restoreTable').tBodies[0];
  const checked = new Set([...tb.rows].filter((r) => r.dataset.index && r.cells[0].firstChild.checked)
    .map((r) => +r.dataset.index));
  tb.innerHTML = '';
  const has = !!state.backup;
  $('restoreTable').hidden = !has;
  $('restoreTools').hidden = !has;
  if (!has) return;
  for (const p of state.backup.presets) {
    const onDev = state.deviceNames?.[p.index];
    const tr = document.createElement('tr');
    tr.dataset.index = p.index;
    if (onDev != null && onDev !== p.name) tr.className = 'diff';
    tr.innerHTML = '<td><input type="checkbox"></td><td></td><td></td><td></td><td class="st"></td>';
    tr.cells[1].textContent = presetLabel(p.index);
    tr.cells[2].textContent = p.name;
    tr.cells[3].textContent = onDev ?? '–';
    tr.cells[0].firstChild.checked = checked.has(p.index);
    tr.cells[0].firstChild.onchange = () => {
      updateSelCount();
      updateButtons();
    };
    const st = state.restoreStatus.get(p.index);
    if (st) {
      tr.cells[4].className = st.cls;
      tr.cells[4].textContent = st.text;
    }
    tr.hidden = state.restoreFilter === 'diff' && tr.className !== 'diff';
    tb.appendChild(tr);
  }
  const rows = [...tb.rows];
  $('showAll').classList.toggle('on', state.restoreFilter === 'all');
  $('showDiff').classList.toggle('on', state.restoreFilter === 'diff');
  $('showDiff').textContent = `Different names (${rows.filter((r) => r.className === 'diff').length})`;
  if (state.restoreFilter === 'diff' && !rows.some((r) => !r.hidden)) {
    const tr = tb.insertRow();
    tr.innerHTML = '<td colspan="5" class="muted">No slot has a different name on the device.</td>';
  }
  updateSelCount();
}

function updateSelCount() {
  const n = selectedRestore().length;
  $('selCount').textContent = n ? `${n} selected` : '';
}

/** Checked rows that are shown (a filter hides rows - hidden ones are never restored). */
function selectedRestore() {
  if (!state.backup) return [];
  return [...$('restoreTable').tBodies[0].rows]
    .filter((r) => r.dataset.index && !r.hidden && r.cells[0].firstChild.checked)
    .map((r) => state.backup.presets.find((p) => p.index === +r.dataset.index));
}

/** Check / uncheck the shown rows. */
function setSelection(on) {
  for (const r of $('restoreTable').tBodies[0].rows) {
    if (r.dataset.index && !r.hidden) r.cells[0].firstChild.checked = on;
  }
  updateSelCount();
  updateButtons();
}

function setFilter(f) {
  state.restoreFilter = f;
  renderRestore();
  updateButtons();
}

async function restore() {
  const sel = selectedRestore();
  if (!sel.length) return;
  const n = sel.length;
  const what = `${n} preset${n > 1 ? 's' : ''}`;
  const ok = await confirmSlots({
    title: `Overwrite ${what} on the pedal?`,
    text: 'The presets in these slots are replaced by the ones from the backup. ' +
      'This cannot be undone - make a backup first if you are not sure.',
    rows: sel.map((p) => ({ slot: presetLabel(p.index), now: state.deviceNames?.[p.index] ?? '?', next: p.name })),
    columns: ['Slot', 'Now on the pedal', '', 'From the backup'],
    ok: `Overwrite ${what}`,
  });
  if (!ok) return;
  await beginBusy();
  const rowOf = (i) => [...$('restoreTable').tBodies[0].rows].find((r) => +r.dataset.index === i);
  const setSt = (i, cls, text) => {
    state.restoreStatus.set(i, { cls, text });
    const r = rowOf(i);
    if (r) {
      r.cells[4].className = cls;
      r.cells[4].textContent = text;
    }
  };
  let good = 0, upgraded = 0, warn = 0;
  const original = await state.dev.currentPreset().catch(() => -1);
  try {
    for (const p of sel) {
      setSt(p.index, 'st', 'writing…');
      rowOf(p.index)?.scrollIntoView({ block: 'nearest' });
      try {
        await state.dev.writePreset(p.index, p.raw);
        setSt(p.index, 'st', 'verifying…');
        const back = await state.dev.readPreset(p.index); // verify by reading it back
        cachePreset(p.index, back);
        setCurrent(p.index, state.scene);
        const cmp = compareStored(p.raw, back);
        if (cmp.identical) {
          good++;
          setSt(p.index, 'ok', 'ok (verified)');
        } else if (cmp.upgraded) {
          // never-saved "Empty" slot: the pedal stores it as format version 3 (4 bytes) – content identical
          upgraded++;
          setSt(p.index, 'ok', 'ok (empty preset, stored in current format)');
        } else {
          warn++;
          setSt(p.index, 'warn', `written – pedal stored ${cmp.diff} byte(s) differently`);
          log(`restore ${presetLabel(p.index)}: read-back differs in ${cmp.diff} byte(s)`);
        }
      } catch (e) {
        setSt(p.index, 'err', e.message);
        log(`restore ${presetLabel(p.index)} failed: ${e.message}`);
      }
    }
    if (original >= 0) {
      await state.dev.waitQuiet(100);
      await state.dev.selectPreset(original).catch(() => {});
      setCurrent(original, state.scene);
    }
    log(`restore: ${good + upgraded}/${sel.length} written and verified` +
      (upgraded ? ` (${upgraded} empty presets stored in the current format)` : '') +
      (warn ? `, ${warn} stored with differences` : ''));
    state.deviceNames = await state.dev.presetNames().catch(() => state.deviceNames);
  } finally {
    renderRestore();
    renderList();
    renderCurrent();
    endBusy();
  }
}

// ------------------------------------------------------------------ probe (Sniffer page)

async function runProbe() {
  state.abort = new AbortController();
  await beginBusy();
  const t0 = performance.now();
  try {
    const res = await probe(state.dev, {
      signal: state.abort.signal,
      onProgress: (done, total, cmd) => {
        $('prStatus').textContent = `${done} / ${total} · ${cmd.toString(16).padStart(8, '0')}`;
      },
    });
    addProbe(res);
    const answered = res.results.filter((r) => r.answer !== null).length;
    log(`probe: ${answered} of ${res.results.length} commands answered (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
  } catch (e) {
    log(`probe failed: ${e.message}`);
    $('prStatus').textContent = `failed: ${e.message}`;
  } finally {
    endBusy();
  }
}

function addProbe(res) {
  state.probes = [...state.probes.slice(-1), res];
  renderProbe();
  updateButtons();
}

function renderProbe() {
  const [older, newer] = state.probes.length > 1 ? state.probes : [null, state.probes[0]];
  const tb = $('prRows');
  tb.innerHTML = '';
  if (!newer) return;
  const diff = older ? new Map(diffProbes(older, newer).map((d) => [d.cmd, d])) : new Map();
  const before = older ? new Map(older.results.map((r) => [r.cmd, r.answer])) : new Map();
  const only = $('prOnlyChanged').checked;
  const mark = (hexStr, bytes) => {
    if (!hexStr) return '–';
    const parts = hexStr.match(/../g) ?? [];
    return parts.map((h, k) => (bytes?.includes(k) ? `<span class="chg">${h}</span>` : h)).join(' ');
  };
  let shown = 0;
  for (const r of newer.results) {
    const d = diff.get(r.cmd);
    if (only && !d) continue;
    if (!only && r.answer === null && !before.get(r.cmd)) continue; // not answered at all: hide
    const tr = tb.insertRow();
    tr.className = d ? 'changed' : r.answer === null ? 'noanswer' : '';
    const g = commandGroup(r.cmd);
    tr.insertCell().textContent = r.cmd.toString(16).padStart(8, '0');
    tr.insertCell().textContent = g ? g.name : '';
    tr.insertCell().textContent = r.req ?? 'no answer';
    tr.insertCell().textContent = r.answer ? r.answer.length / 2 : '';
    tr.insertCell().innerHTML = mark(r.answer?.slice(0, 96), d?.bytes) + ((r.answer?.length ?? 0) > 96 ? ' …' : '');
    tr.insertCell().innerHTML = d ? mark(d.a?.slice(0, 96), d.bytes) : '';
    shown++;
  }
  const answered = newer.results.filter((r) => r.answer !== null).length;
  $('prStatus').textContent = `${new Date(newer.created).toLocaleTimeString()}: ${answered} answered` +
    (older ? `, ${diff.size} changed since ${new Date(older.created).toLocaleTimeString()}` : '') + ` · ${shown} shown`;
}

function saveProbe() {
  const res = state.probes[state.probes.length - 1];
  const stamp = new Date(res.created).toISOString().slice(0, 19).replace(/[T:]/g, '-');
  download(new Blob([JSON.stringify(res, null, 1)], { type: 'application/json' }), `ampero_probe_${stamp}.json`);
}

async function openProbe(file) {
  try {
    const res = JSON.parse(await file.text());
    if (!Array.isArray(res.results)) throw new Error('not a probe file');
    addProbe(res);
    log(`probe loaded: ${file.name}`);
  } catch (e) {
    log(`cannot open ${file.name}: ${e.message}`);
  }
}

// ------------------------------------------------------------------ start

async function init() {
  fillRange();
  for (const b of document.querySelectorAll('.tab')) b.onclick = () => showTab(b.dataset.tab);
  $('irReadBtn').onclick = readFileLists;
  try {
    const c = JSON.parse(localStorage.getItem('ampero.blockClip') || 'null');
    if (c) state.blockClip = checkBlock(c);
  } catch { /* ignore */ }
  $('aboutLink').onclick = (e) => {
    e.preventDefault();
    showAbout();
  };
  $('globalReadBtn').onclick = readGlobals;
  $('namReadBtn').onclick = readFileLists;
  initPresetListEvents();
  sniffer = initSniffer({ getAccess: () => state.access, getDevice: () => state.dev, log, download, onLive: setSniffing });
  showTab(['edit', 'backup', 'files', 'global', 'sniffer'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'edit');
  $('connectBtn').onclick = () => connect(false);
  $('dumpBtn').onclick = dump;
  $('cancelBtn').onclick = () => state.abort?.abort();
  $('search').oninput = renderList;
  $('viewAll').onclick = () => {
    state.listView = 'all';
    renderList();
  };
  $('viewStyle').onclick = () => {
    state.listView = 'style';
    renderList();
  };
  $('backupFile').onchange = (e) => e.target.files[0] && openBackup(e.target.files[0]);
  $('selAll').onclick = () => setSelection(true);
  $('selNone').onclick = () => setSelection(false);
  $('showAll').onclick = () => setFilter('all');
  $('showDiff').onclick = () => setFilter('diff');
  $('restoreBtn').onclick = restore;
  $('refreshAllBtn').onclick = () => refresh('all', true);
  $('refreshCurBtn').onclick = () => refresh('current', true);
  $('resumeBtn').onclick = resumeAfterOtherHost;
  $('prRun').onclick = runProbe;
  $('prCancel').onclick = () => state.abort?.abort();
  $('prSave').onclick = saveProbe;
  $('prFile').onchange = (e) => e.target.files[0] && openProbe(e.target.files[0]);
  $('prOnlyChanged').onchange = renderProbe;
  $('logToggle').onclick = () => {
    const c = $('logPanel').classList.toggle('collapsed');
    $('logToggle').textContent = c ? 'Log ▴' : 'Log ▾';
  };
  $('logPanel').classList.add('collapsed');
  $('traceBtn').onclick = () => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    download(new Blob([state.lastDev.traceText()], { type: 'text/plain' }), `ampero_trace_${stamp}.txt`);
  };
  window.addEventListener('resize', () => requestAnimationFrame(drawRouting));
  window.addEventListener('focus', () => {
    state.namesDue = 0; // back in the window: refresh everything at the next poll
    poll();
  });
  setInterval(poll, CURRENT_POLL_MS);
  // reload / close: release the MIDI ports cleanly (a hard reload with open ports left Firefox's Web MIDI without
  // any device until the browser was restarted)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.fsPick) setFsPick(false);
  });
  window.addEventListener('pagehide', () => {
    try {
      state.dev?.close();
    } catch { /* ignore */ }
  });
  [...$('edScenes').children].forEach((b, s) => {
    b.onclick = () => chooseScene(s);
    b.ondblclick = () => renameScene(s);
  });
  try {
    localStorage.removeItem('ampero.scenes45'); // the experimental scenes 4/5 option was removed (crashes the Stomp)
    state.fsFollow = localStorage.getItem('ampero.fsFollow') === '1';
  } catch { /* ignore */ }
  $('edSave').onclick = savePreset;
  $('edStyleSel').onchange = () => setStyleSlot(state.current, $('edStyleSel').value);
  $('portToggle').onclick = () => {
    $('portSel').hidden = !$('portSel').hidden;
  };
  $('edTempo').onchange = () => setSceneValue('tempo', +$('edTempo').value);
  $('edVolume').oninput = () => {
    $('edVolumeVal').textContent = $('edVolume').value;
  };
  $('edVolume').onchange = () => setSceneValue('volume', +$('edVolume').value);
  renderEditor();
  updateButtons();
  loadAlgDb().then((ok) => {
    if (ok) renderEditor();
    else log('Effect database (data/algorithms.json) not loaded – showing modules only.');
  });
  try {
    // "?sim": simulated pedal for testing without hardware (test/sim.js)
    if (new URLSearchParams(location.search).has('sim')) await (await import('../test/sim.js')).install();
    state.access = await requestMidi();
    fillPorts();
    sniffer.fillInputs();
    state.access.onstatechange = () => {
      fillPorts();
      sniffer.fillInputs();
      autoConnect();
    };
    log('MIDI ready. Close the Hotone software – the Ampero is connected automatically when it is found.');
    autoConnect();
  } catch (e) {
    $('connectBtn').disabled = true;
    log(`MIDI not available: ${e.message}`);
  }
}

init();
