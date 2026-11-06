// Sniffer page: passive MIDI capture, open/save captures, list of transfers, field tree + colored hex dump.
//
// Live capture only LISTENS (nothing is sent). A browser sees only what the pedal sends on its MIDI output –
// its answers (also those meant for the Hotone software) and the set commands it forwards – but not the
// requests the Hotone software sends to the pedal. For both directions open a Wireshark/USBPcap .pcapng.

import { Assembler, describe, hexBytes, hex32, parsePcapng, parseTraceText } from './sniffer.js';

const $ = (id) => document.getElementById(id);
const COLORS = ['#2e5a88', '#7a4b16', '#2f6b3a', '#6b2f6b', '#7a6a16', '#235f66', '#6b3030', '#4a4a7a', '#3e6b16', '#6b4a30'];
const POLL_CMDS = new Set([0x00090000, 0x03000001]); // current preset / scene – polled by this app
const METERS = new Set([0x03000006, 0x03000007]);

export function initSniffer({ getAccess, getDevice, log, download, onLive = () => {} }) {
  const s = {
    messages: [], // [{t, dir, bytes}]
    asm: new Assembler(),
    live: null, // {stop()}
    t0: 0,
    sel: null, // selected entry
    selField: null,
    view: 'payload',
    pending: false,
    source: '',
  };

  // ---------------------------------------------------------------- capture sources

  function reset(source) {
    s.messages = [];
    s.asm = new Assembler();
    s.sel = null;
    s.selField = null;
    s.source = source;
    renderDetail();
  }

  function add(msg) {
    s.messages.push(msg);
    s.asm.push(msg);
  }

  function fillInputs() {
    const sel = $('snInput');
    const keep = sel.value;
    sel.innerHTML = '';
    const access = getAccess();
    const ins = access ? [...access.inputs.values()] : [];
    if (!ins.length) sel.add(new Option('(no MIDI input)', ''));
    for (const p of ins) sel.add(new Option(p.name, p.id));
    sel.value = ins.some((p) => p.id === keep) ? keep : (ins.find((p) => /ampero|mp-?300/i.test(p.name)) ?? ins[0])?.id ?? '';
  }

  async function startLive() {
    stopLive();
    reset('live');
    s.t0 = performance.now();
    const dev = getDevice();
    if (dev) {
      // the app is connected: take its frames (both directions, incl. its own requests – it sends none while
      // sniffing, apart from what was in flight)
      const on = (e) => {
        add({ t: performance.now() - s.t0, dir: e.detail.dir, bytes: e.detail.bytes });
        schedule();
      };
      dev.addEventListener('frame', on);
      s.live = { dev, stop: () => dev.removeEventListener('frame', on), what: 'the app\'s connection (both directions)' };
    } else {
      const input = getAccess()?.inputs.get($('snInput').value);
      if (!input) {
        log('sniffer: no MIDI input selected');
        return;
      }
      await input.open();
      const on = (e) => {
        add({ t: performance.now() - s.t0, dir: 'IN', bytes: Uint8Array.from(e.data) });
        schedule();
      };
      input.addEventListener('midimessage', on);
      s.live = { stop: () => input.removeEventListener('midimessage', on), what: `${input.name} (listen only, pedal → PC)` };
    }
    log(`sniffer: live capture from ${s.live.what}`);
    onLive(true);
    updateToolbar();
    render();
  }

  function stopLive() {
    if (!s.live) return;
    s.live.stop();
    log(`sniffer: stopped, ${s.messages.length} messages`);
    s.live = null;
    onLive(false);
    updateToolbar();
  }

  async function openFile(file) {
    stopLive();
    try {
      const buf = await file.arrayBuffer();
      const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
      let msgs;
      if (head[0] === 0x0a && head[1] === 0x0d && head[2] === 0x0d && head[3] === 0x0a) {
        const r = parsePcapng(buf);
        msgs = r.messages;
        log(`sniffer: ${file.name}: Ampero = USB device ${r.device}, ${msgs.length} MIDI messages`);
      } else {
        msgs = parseTraceText(new TextDecoder().decode(buf));
        log(`sniffer: ${file.name}: ${msgs.length} messages`);
      }
      reset(file.name);
      for (const m of msgs) add(m);
    } catch (e) {
      log(`sniffer: cannot read ${file.name}: ${e.message}`);
    }
    render();
  }

  function save() {
    const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
    const text = s.messages.map((m) => `${m.t.toFixed(1).padStart(10)} ${m.dir.padEnd(3)} ${hex(m.bytes)}`).join('\n') + '\n';
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    download(new Blob([text], { type: 'text/plain' }), `ampero_sniff_${stamp}.txt`);
  }

  // ---------------------------------------------------------------- list

  function schedule() {
    if (s.pending) return;
    s.pending = true;
    requestAnimationFrame(() => {
      s.pending = false;
      render();
    });
  }

  function visible(e, d) {
    const f = $('snFilter').value.trim().toLowerCase();
    if (e.type === 'other' && !$('snShowOther').checked) return false;
    if ($('snHideMeters').checked && METERS.has(e.cmd)) return false;
    if ($('snHidePoll').checked && POLL_CMDS.has(e.cmd) && e.payload?.length <= 4) return false;
    if ($('snOnlyUnknown').checked && d.known) return false;
    if (f && !(e.cmd !== undefined && hex32(e.cmd).includes(f.replace(/^0x/, ''))) && !d.name.toLowerCase().includes(f) &&
        !d.summary.toLowerCase().includes(f)) return false;
    return true;
  }

  function render() {
    const tb = $('snRows');
    const wrap = $('snListWrap');
    const atBottom = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 30;
    const rows = [];
    for (const e of s.asm.entries) {
      e.d ??= describe(e);
      if (visible(e, e.d)) rows.push(e);
    }
    const shown = rows.slice(-3000);
    tb.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const e of shown) {
      const tr = document.createElement('tr');
      tr.className = `${e.dir === 'IN' ? 'in' : 'out'} ${e.type !== 'transfer' && e.type !== 'other' ? 'bad' : ''} ` +
        `${e.type === 'transfer' && !e.d.known ? 'unknown' : ''} ${e === s.sel ? 'sel' : ''}`;
      const len = e.payload ? e.payload.length : e.frames[0].bytes.length;
      for (const v of [e.n, (e.t / 1000).toFixed(3), e.dir, e.kind !== undefined ? e.kind.toString(16) : '',
        e.cmd !== undefined ? hex32(e.cmd) : '', e.d.name, len, e.d.summary]) {
        tr.insertCell().textContent = v;
      }
      tr.onclick = () => select(e);
      frag.appendChild(tr);
    }
    tb.appendChild(frag);
    const unknown = rows.filter((e) => e.type === 'transfer' && !e.d.known).length;
    $('snStats').textContent = `${s.source ? `${s.source}: ` : ''}${s.messages.length} messages, ${s.asm.entries.length} entries, ` +
      `${rows.length} shown${rows.length > shown.length ? ` (last ${shown.length})` : ''}, ${unknown} unknown`;
    if (s.live && atBottom) wrap.scrollTop = wrap.scrollHeight;
  }

  function select(e) {
    s.sel = e;
    s.selField = null;
    for (const tr of $('snRows').rows) tr.classList.toggle('sel', tr.cells[0].textContent === String(e.n));
    renderDetail();
  }

  // ---------------------------------------------------------------- detail: fields + hex

  function leaves(fields) {
    return fields.flatMap((f) => (f.children?.length ? leaves(f.children) : [f]));
  }

  function renderDetail() {
    const e = s.sel;
    const title = $('snDetailTitle');
    const tree = $('snFields');
    const hexEl = $('snHex');
    tree.innerHTML = '';
    hexEl.innerHTML = '';
    if (!e) {
      title.textContent = 'Click an entry to see its fields and bytes.';
      return;
    }
    const d = e.d;
    title.textContent = `#${e.n} · ${(e.t / 1000).toFixed(3)} s · ${e.dir} · ` +
      (e.cmd !== undefined ? `0x${hex32(e.cmd)} ${d.name} · kind ${e.kind?.toString(16)} · ` : `${d.name} · `) +
      `${e.payload ? `${e.payload.length} B payload, ` : ''}${e.frames.length} frame(s)`;
    $('snViewPayload').classList.toggle('on', s.view === 'payload');
    $('snViewFrames').classList.toggle('on', s.view === 'frames');
    if (s.view === 'frames' || !e.payload) {
      renderFrames(e, hexEl);
      return;
    }
    // color every leaf field
    const ls = leaves(d.fields);
    ls.forEach((f, i) => {
      f.color = COLORS[i % COLORS.length];
    });
    const owner = new Array(e.payload.length).fill(null);
    for (const f of ls) for (let k = f.off; k < f.off + f.len && k < owner.length; k++) owner[k] = f;
    // tree
    const build = (fields, parent) => {
      for (const f of fields) {
        const li = document.createElement('li');
        const row = document.createElement('div');
        row.className = 'fld';
        row.innerHTML = '<span class="sw"></span><span class="fn"></span><span class="fv"></span><span class="fo"></span>';
        row.children[0].style.background = f.color ?? 'transparent';
        row.children[1].textContent = f.name;
        row.children[2].textContent = f.value;
        row.children[3].textContent = `@${f.off} +${f.len}`;
        row.onclick = (ev) => {
          ev.stopPropagation();
          s.selField = f;
          highlight();
        };
        f.row = row;
        li.appendChild(row);
        if (f.children?.length) {
          const ul = document.createElement('ul');
          build(f.children, ul);
          li.appendChild(ul);
          if (f.children.length > 40) {
            ul.hidden = true;
            row.classList.add('collapsed');
          }
          row.ondblclick = () => {
            ul.hidden = !ul.hidden;
            row.classList.toggle('collapsed', ul.hidden);
          };
        }
        parent.appendChild(li);
      }
    };
    if (!d.fields.length) tree.innerHTML = '<li class="muted">no known fields</li>';
    build(d.fields, tree);
    // hex dump
    const p = e.payload;
    const max = Math.min(p.length, $('snAllBytes').checked ? p.length : 4096);
    const frag = document.createDocumentFragment();
    for (let o = 0; o < max; o += 16) {
      const line = document.createElement('div');
      line.className = 'hl';
      line.appendChild(Object.assign(document.createElement('span'), { className: 'ho', textContent: o.toString(16).padStart(5, '0') }));
      const asc = [];
      for (let k = o; k < o + 16; k++) {
        const b = document.createElement('span');
        if (k < max) {
          b.textContent = p[k].toString(16).padStart(2, '0');
          b.dataset.k = k;
          const f = owner[k];
          if (f) b.style.background = f.color;
          b.onclick = () => {
            s.selField = owner[k];
            highlight();
          };
          asc.push(p[k] >= 0x20 && p[k] < 0x7f ? String.fromCharCode(p[k]) : '.');
        } else {
          b.textContent = '  ';
        }
        b.className = 'hb';
        line.appendChild(b);
      }
      line.appendChild(Object.assign(document.createElement('span'), { className: 'ha', textContent: asc.join('') }));
      frag.appendChild(line);
    }
    hexEl.appendChild(frag);
    if (max < p.length) hexEl.appendChild(Object.assign(document.createElement('div'), { className: 'muted small', textContent: `… ${p.length - max} more bytes (tick "all bytes")` }));
    s.highlight = { owner, hexEl };
  }

  function highlight() {
    const f = s.selField;
    for (const el of $('snFields').querySelectorAll('.fld.on')) el.classList.remove('on');
    for (const el of $('snHex').querySelectorAll('.hb.on')) el.classList.remove('on');
    if (!f) return;
    f.row?.classList.add('on');
    f.row?.scrollIntoView({ block: 'nearest' });
    let first = null;
    for (let k = f.off; k < f.off + f.len; k++) {
      const b = $('snHex').querySelector(`.hb[data-k="${k}"]`);
      if (b) {
        b.classList.add('on');
        first ??= b;
      }
    }
    first?.scrollIntoView({ block: 'nearest' });
  }

  /** Raw frames with their header fields colored. */
  function renderFrames(e, el) {
    const seg = [
      ['F0 21 25 4D 50 00 00 header', 0, 7, '#444'], ['checksum', 7, 1, COLORS[1]], ['kind', 8, 1, COLORS[2]],
      ['total (7-bit lo/hi)', 9, 2, COLORS[3]], ['offset (7-bit lo/hi)', 11, 2, COLORS[4]],
    ];
    const legend = document.createElement('div');
    legend.className = 'legend small';
    for (const [n, , , c] of seg) legend.append(Object.assign(document.createElement('span'), { textContent: n, style: `background:${c}` }));
    legend.append(Object.assign(document.createElement('span'), { textContent: 'data nibbles', style: `background:${COLORS[0]}` }));
    el.appendChild(legend);
    for (const fr of e.frames) {
      const b = fr.bytes;
      const head = document.createElement('div');
      head.className = 'muted small';
      head.textContent = `${(fr.t / 1000).toFixed(3)} s · ${b.length} bytes`;
      el.appendChild(head);
      const line = document.createElement('div');
      line.className = 'frame-bytes';
      b.forEach((x, k) => {
        const sp = document.createElement('span');
        sp.textContent = x.toString(16).padStart(2, '0');
        const s2 = seg.find(([, o, l]) => k >= o && k < o + l);
        sp.style.background = b[0] === 0xf0 && b[3] !== 0x7f ? (s2 ? s2[3] : k === b.length - 1 ? '#444' : COLORS[0]) : 'transparent';
        line.appendChild(sp);
      });
      el.appendChild(line);
    }
    if (e.stream) {
      el.appendChild(Object.assign(document.createElement('div'), { className: 'muted small',
        textContent: `stream: cmd 0x${hex32(e.cmd)}, LZO ${e.stream.length - 8} B → payload ${e.payload.length} B · stream ${hexBytes(e.stream, 24)}` }));
    }
  }

  // ---------------------------------------------------------------- toolbar

  function updateToolbar() {
    $('snLive').textContent = s.live ? '■ Stop' : '● Start live';
    $('snLive').classList.toggle('danger', !!s.live);
    $('snInput').disabled = !!s.live;
  }

  $('snLive').onclick = () => (s.live ? stopLive() : startLive());
  $('snFile').onchange = (ev) => ev.target.files[0] && openFile(ev.target.files[0]);
  $('snSave').onclick = save;
  $('snClear').onclick = () => {
    reset(s.live ? 'live' : '');
    render();
  };
  for (const id of ['snFilter', 'snHideMeters', 'snHidePoll', 'snOnlyUnknown', 'snShowOther']) $(id).oninput = render;
  $('snViewPayload').onclick = () => {
    s.view = 'payload';
    renderDetail();
  };
  $('snViewFrames').onclick = () => {
    s.view = 'frames';
    renderDetail();
  };
  $('snAllBytes').onchange = renderDetail;
  // drop a capture onto the page
  const page = $('page-sniffer');
  page.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    page.classList.add('drop');
  });
  page.addEventListener('dragleave', () => page.classList.remove('drop'));
  page.addEventListener('drop', (ev) => {
    ev.preventDefault();
    page.classList.remove('drop');
    if (ev.dataTransfer.files[0]) openFile(ev.dataTransfer.files[0]);
  });
  updateToolbar();
  render();
  return {
    fillInputs,
    stopLive,
    /** the app's connection was closed: a live capture through it ends */
    deviceClosed: (dev) => {
      if (s.live?.dev === dev) stopLive();
    },
    openFile,
    selectEntry: (n) => {
      const e = s.asm.entries[n - 1];
      if (e) select(e);
    },
  };
}
