import { AmperoDevice, listPorts, requestMidi } from './device.js';
import {
  CMD, MAX_NAME, MODULES, PRESET_COUNT, STYLES, WRITE_CONFIRMED, compareStored, hex32, presetInfo, presetLabel,
  presetChain, presetRouting, rd32, setPresetName, setPresetStyle, tlvSplit,
} from './protocol.js';
import { buildBackup, dumpPresets, loadBackup } from './backup.js';
import { decodePrst, encodePrst } from './prst.js';
import { closeMenu, confirmSlots, contextMenu, promptText } from './ui.js';
import { initSniffer } from './sniffer-ui.js';
import { moduleIcon } from './icons.js';
import { diffProbes, probe } from './probe.js';
import { commandGroup } from './sniffer.js';

const $ = (id) => document.getElementById(id);
let sniffer = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {
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
  if (location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`);
  closeMenu();
  if (tab === 'edit') {
    requestAnimationFrame(drawRouting);
    requestAnimationFrame(scrollToCurrent);
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
    sel.value = ports.some((p) => p.id === keep) ? keep : pick?.id ?? ports[0]?.id ?? '';
  };
  fill($('inPort'), inputs, input);
  fill($('outPort'), outputs, output);
}

async function connect() {
  if (state.dev) {
    state.dev.close();
    return;
  }
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
  if (cmd === CMD.PRESET_DUMP) {
    if (!state.busy) onPushedDump(payload); // while busy the dumps are our own (late) answers
    return;
  }
  if (cmd === CMD.CURRENT_PRESET && payload.length >= 4) {
    setCurrent(rd32(payload, 0), state.scene);
  } else if (cmd === CMD.CURRENT_SCENE && payload.length >= 1) {
    setCurrent(state.current, payload[0]);
  }
  // Something was stored or changed by another program (the pedal forwards other hosts' set commands and
  // acknowledgements): read the names again soon.
  if (cmd === CMD.WRITE_ACK || cmd === CMD.PRESET_CHANGED || cmd === CMD.PRESET_SAVED ||
      ((cmd >>> 24) === 0x01 && (cmd & 0xffff) === 0x0001)) {
    state.namesDue = Math.min(state.namesDue, performance.now() + 300);
  }
  if (OTHER_HOST_SIGNS.has(cmd) || ((cmd >>> 24) === 0x01 && (cmd & 0xffff) === 0x0001) ||
      (cmd === CMD.WRITE_ACK && !state.busy)) {
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
  state.otherHost = true;
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
  setCurrent(index, scene);
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
  $('edStyle').hidden = !info?.style;
  $('edStyle').textContent = info?.style ?? '';
  const scene = Math.max(0, state.scene);
  const scenes = $('edScenes').children;
  for (let s = 0; s < 3; s++) {
    scenes[s].textContent = info?.scenes[s] || `Scene ${s + 1}`;
    scenes[s].classList.toggle('on', s === scene);
  }
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
    cm.textContent = `Chain: ${rt.name}`;
    cm.title = `routing bytes (tag 6 @2,4,6,456,457): ${rt.bytes.map((x) => x.toString(16).padStart(2, '0')).join(' ')}`;
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
  $('chain').className = `chain${raw ? '' : ' unknown'}`;
  const split = rt?.split ?? null, merge = rt?.merge ?? null, serial = !!rt?.serial;

  // inputs / outputs: row 1 always has an input; row 2 only without split. Row 1 has an output unless the
  // chain is serial; row 2 only without merge (in serial mode it carries the main output).
  const twoIn = rt && split === null, twoOut = rt && merge === null && !serial;
  const io = (on, label) => (on ? el('span', 'io', label) : el('span', 'io-gap'));
  $('chainLeft').replaceChildren(io(!!rt, twoIn ? '1' : '→'), io(twoIn, '2'));
  $('chainRight').replaceChildren(io(!!rt && !serial, twoOut ? '1' : '→'), io(!!rt && merge === null, serial ? '→' : '2'));

  const box = (c) => {
    if (!c || c.code === 0xffffffff) return el('div', 'fx empty', '+');
    const mod = MODULES[c.code >>> 24] ?? '?';
    const b = el('div', `fx m-${mod.replace(' ', '-')}${c.on[scene] ? '' : ' off'}`);
    const icon = el('span', 'fx-icon');
    icon.innerHTML = moduleIcon(mod) || mod.slice(0, 3);
    b.append(el('span', 'fx-label', mod), icon, el('span', 'fx-state'));
    b.title = `${mod} – slot ${c.slot + 1}, algorithm 0x${c.code.toString(16).padStart(8, '0')}, ` +
      `${c.on[scene] ? 'on' : 'off'} in scene ${scene + 1}`;
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
  initPresetListEvents();
  sniffer = initSniffer({ getAccess: () => state.access, getDevice: () => state.dev, log, download, onLive: setSniffing });
  showTab(['edit', 'backup', 'global', 'sniffer'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'edit');
  $('connectBtn').onclick = connect;
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
  for (const li of document.querySelectorAll('.mock-modules li')) {
    const mod = li.textContent.trim();
    li.innerHTML = `<span class="mi m-${mod.replace(' ', '-')}">${moduleIcon(mod)}</span>${mod}`;
  }
  [...$('edScenes').children].forEach((b, s) => {
    b.onclick = () => chooseScene(s);
  });
  renderEditor();
  updateButtons();
  try {
    state.access = await requestMidi();
    fillPorts();
    sniffer.fillInputs();
    state.access.onstatechange = () => {
      fillPorts();
      sniffer.fillInputs();
    };
    log('MIDI ready. Close the Hotone software, then press Connect.');
  } catch (e) {
    $('connectBtn').disabled = true;
    log(`MIDI not available: ${e.message}`);
  }
}

init();
