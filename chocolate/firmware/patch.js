// Chocolate Plus firmware patcher - runs entirely in the browser, the file never leaves the computer.
// JavaScript port of public-repo/firmware/build.py + fwsctool.py (settings of release 141).
// Input:  the original M-VAVE firmware FootCtrlPlus_012.fwsc (or the .ufw inside it), checked by SHA-256.
// Output: FootCtrlPlus_141-dtnprt.fwsc, only handed out if it is byte-identical to the official build.
'use strict';
(function (global) {

const STOCK_SHA256 = {
  '9deb9d90691415aa7f4514103842237a1500c681db34fe35e5f5136d173cb3bc': 'fwsc',  // FootCtrlPlus_012.fwsc
  'f2aad57cef8f8eb16bb97d1a8315780b5b6e8ca0254ec5514cd243c1bcc9971d': 'ufw',   // FootCtrlPlus_012.ufw
};
const KNOWN_OTHER = {
  'b5ba2041482640315c7dc70a0f7c79c9e81d24989226763868dc36dab81801c3': 'the original firmware 013',
  'fb479aa2da0efe27e7c92581884171bce0694e41a912a5d755a520129705f837': 'the already patched custom firmware 141',
};
const VERSION = 141, SUFFIX = '-dtnprt', NAME = 'FootCtrlPlus';
const OUT_NAME = `${NAME}_${VERSION}${SUFFIX}.fwsc`;
const RESULT_SHA256 = 'fb479aa2da0efe27e7c92581884171bce0694e41a912a5d755a520129705f837';

// ---- JieLi .ufw LFSR cipher, CRC16, Sinco .fwsc wrapper (fwsctool.py) ----
function lfsrNext(v) {
  const w10 = v >>> 0;
  const w16 = (w10 >>> 15) & 1;
  let w15 = (((w10 & 0xffff) >>> 11) & 1) ^ w16;
  let w1 = (w10 << 1) >>> 0;
  let w3 = (w1 & 0xffffe000) >>> 0;
  let w4 = w1 & 0x40;
  w1 = (w1 & ~1) | ((w10 >>> 15) & 1);
  w3 = (w3 & ~(1 << 12)) | ((w15 & 1) << 12);
  const w15b = w10 & 0xff;
  const w10b = (w15b >>> 7) & 1;
  w15 = ((w15b >>> 4) & 1) ^ w16;
  w3 = (w3 & ~(1 << 11)) | (((w10 >>> 10) & 1) << 11);
  w4 = (w4 & ~3) | (w1 & 3);
  w3 = (w3 & ~(1 << 10)) | (((w10 >>> 9) & 1) << 10);
  w4 = (w4 & ~(1 << 4)) | (((w10 >>> 3) & 1) << 4);
  w3 = (w3 & ~(1 << 9)) | (((w10 >>> 8) & 1) << 9);
  w4 = (w4 & ~(1 << 3)) | (((w10 >>> 2) & 1) << 3);
  w3 = (w3 & ~(1 << 8)) | ((w10b & 1) << 8);
  w4 = (w4 & ~(1 << 2)) | (((w10 >>> 1) & 1) << 2);
  w3 = (w3 & ~(1 << 7)) | (((w10 >>> 6) & 1) << 7);
  w4 = (w4 & ~(1 << 5)) | ((w15 & 1) << 5);
  return (w4 | w3) >>> 0;
}

function xcodeBlock(buf) {            // header/dir cipher, self-inverse
  const b = Uint8Array.from(buf);
  let v = 0xffff;
  if (b.length) b[0] = ~b[0] & 0xff;
  for (let i = 1; i < b.length; i++) { v = lfsrNext(v); b[i] ^= v & 0xff; }
  return b;
}

const CRC_T = [0x0, 0x1021, 0x2042, 0x3063, 0x4084, 0x50a5, 0x60c6, 0x70e7,
               0x8108, 0x9129, 0xa14a, 0xb16b, 0xc18c, 0xd1ad, 0xe1ce, 0xf1ef];
function crc16(data) {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    const byte = data[i];
    crc = (CRC_T[((crc >>> 12) ^ (byte >>> 4)) & 0xf] ^ (crc << 4)) & 0xffff;
    crc = (CRC_T[((crc >>> 12) ^ (byte & 0xf)) & 0xf] ^ (crc << 4)) & 0xffff;
  }
  return crc;
}

function memberDecrypt(buf, key, pos) {   // 32-byte blocks, reseeded per block; self-inverse
  const out = Uint8Array.from(buf);
  for (let i = 0; i < out.length; ) {
    const blk = Math.min(32, out.length - i);
    let st = (key ^ (pos >>> 2)) >>> 0;
    out[i] ^= st & 0xff;
    for (let j = 1; j < blk; j++) { st = lfsrNext(st); out[i + j] ^= st & 0xff; }
    i += blk; pos += blk;
  }
  return out;
}

function fwscUnwrap(data) {             // drop 1 metadata byte per 48-byte group (20 groups)
  const out = new Uint8Array(data.length - 20);
  let p = 0, o = 0;
  for (let g = 0; g < 20; g++) { out.set(data.subarray(p, p + 47), o); p += 48; o += 47; }
  out.set(data.subarray(p), o);
  return out;
}

function fwscWrap(ufw, name, version, suffix) {
  const hdr = `${name}_${String(version).padStart(3, '0')}${suffix}`.slice(0, 20);
  const out = new Uint8Array(ufw.length + 20);
  let p = 0, o = 0;
  for (let g = 0; g < 20; g++) {
    out.set(ufw.subarray(p, p + 47), o); p += 47; o += 47;
    let b = g < hdr.length ? hdr.charCodeAt(g) : 0x40;          // '@' padding
    if (g < hdr.length) b = (b + g + 1) & 0xff;
    out[o++] = b;
  }
  out.set(ufw.subarray(p), o);
  return out;
}

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const put16 = (b, o, v) => { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; };
const hex = (s) => Uint8Array.from(s.match(/../g).map((h) => parseInt(h, 16)));
const equal = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

function decodeHeader(ufw) {
  const hdr = xcodeBlock(ufw.subarray(0, 0x40));
  return { stored: u16(hdr, 0), calc: crc16(hdr.subarray(2, 0x40)), count: u16(hdr, 8) };
}

function fixHeaderCrc(ufw) {
  const hdr = xcodeBlock(ufw.subarray(0, 0x40));
  const count = u16(hdr, 8);
  put16(hdr, 2, crc16(ufw.subarray(0x40, 0x40 + count * 0x50)));
  put16(hdr, 0, crc16(hdr.subarray(2, 0x40)));
  ufw.set(xcodeBlock(hdr), 0);
}

// ---- patches (build.py) ----
const KEY = 0x180f, POS = 0x20000, UBOOT = 0x1000, VBASE = 0x01e00000;
const a = (vaddr) => vaddr - VBASE;
const D = 3, F = 6;                                     // debounce / combo window (5 ms ticks)
const CALL_CAVE = hex('80ea41a0'), CAVE = hex('00f80902c2ff3e20e10180f803c8c2ff8820e101d2008000'), CAVE_ADDR = 0x1e26088;
const IDENT_ADDR = 0x1e18c8e, IDENT_SLOT = 27, IDENT = `${NAME}_${VERSION}${SUFFIX}`;
const TEXT_TABLE = 0x1e19308, TEXT_TABLE_MAX = 32;
const TEXTS = hex('20202064746e50727420202000556572313431624174006e6f64');  // '   dtnPrt   ', Uer 141 bAt, nod
// boot greeting, mode-3 bank screen, dimmed LED: [address, stock bytes, new bytes]
const GREET = [
  [0x1e144ca, 'bfeacef1', 'bfea9c5f'],
  [0x1e00406, '7904041680ea274a4520bfeadafe0816c9ffa0930100049f50a3901806e1d8026716776006e81670786e84e8fa01706660e17f0440e17a0ff06690ea0de100e1e803f06550ec700080ea094a70166116bfeaeafec52185f8df0538ece803', '7604c6ff90340100c4ff0893e1014539484049414a4281ea402e4c814842f0584c834d3c484049414a4281ea362e4c834840f05880ea317080ea718b484149424a4381ea2a2e684080ea698b684080f8020680ea909768413604c0ea0392'],
  [0x1e11b06, '75040416bfea31f850e81b0a4d61055635e94000552052d641624020bfeacdf768e808454861081f81d7c861814350ee4501004440223504ffeaf3f7619e4020', '100400e1301049202217ca31432080eaef03c0ff9494010000ef800d0004412af4e100212316131b8b1e482082f902144831fa3601e1302002e13030c0eaada2'],
  [0x1e1305a, 'c0ffa093010050ee0a12402af4e1103000e13030e3e10a30991e41e13010d22122174320bfea', '80ea8f01c0ea100000ef0100ffeac6fc52eeeb11c0ff00501e0002ef01008142c2ef01008000'],
  [0x1e13322, '30e1ff4f', '38810000'],
  [0x1e13346, '4881', '3881'],
  [0x1e13370, '402af4e1304000e13040d121', '12163116bfeac7f3c0ea0900'],
  [0x1e1337c, '1217e1e10a40391e41e130104320bfea', 'c3ffe890010039403a461981ffeabdf3'],
  [0x1e129ee, '00ef0100', 'c0ea3803'],
  [0x1e11d78, '52eeeb11', '80ea7709'],
  [0x1e260a0, 'ffffffffffffffffffffffffffffffff', '43201004bfea276150168804d7ea648e'],
];

function check(cond, msg) { if (!cond) throw new Error(msg); }

function cmpImmPatch(d, vaddr, expect, value) {        // `if (rX < imm8) goto`
  const o = a(vaddr);
  let hw0 = u16(d, o), hw1 = u16(d, o + 2);
  const imm = (((hw0 >>> 4) & 1) << 7) | (hw1 >>> 9);
  check(imm === expect, `unexpected value at ${vaddr.toString(16)}`);
  hw0 = (hw0 & ~0x10) | (((value >>> 7) & 1) << 4);
  hw1 = (hw1 & 0x1ff) | ((value & 0x7f) << 9);
  put16(d, o, hw0); put16(d, o + 2, hw1);
}

function rebuildAreaCrcs(d) {
  const appAddr = u32(d, 0x24), appLen = u32(d, 0x28);
  put16(d, 0x22, crc16(d.subarray(appAddr, appAddr + appLen)));
  put16(d, 0x20, crc16(d.subarray(0x22, 0x40)));
  const areaLen = u32(d, 0x08);
  put16(d, 0x02, crc16(d.subarray(0x20, areaLen)));
  put16(d, 0x00, crc16(d.subarray(0x02, 0x20)));
}

function replace(d, vaddr, stock, repl, what) {
  const o = a(vaddr);
  check(equal(d.subarray(o, o + stock.length), stock), `${what}: unexpected original bytes at ${vaddr.toString(16)}`);
  d.set(repl, o);
}

function patchMember(member) {
  const d = memberDecrypt(member.subarray(UBOOT), KEY, POS);
  check(String.fromCharCode(...d.subarray(0x30, 0x37)) === 'app.bin', 'unexpected app-area layout');
  const t = Uint8Array.from(d); rebuildAreaCrcs(t);
  check(equal(t, d), 'CRC chain self-test failed');
  cmpImmPatch(d, 0x1e12034, 0x4, D);
  cmpImmPatch(d, 0x1e12090, 0xf, F);
  replace(d, 0x1e12002, hex('80f81c02'), CALL_CAVE, 'tap fix');
  replace(d, CAVE_ADDR, new Uint8Array(0x1e260b0 - CAVE_ADDR).fill(0xff), CAVE, 'tap fix cave');
  const identStock = new Uint8Array(IDENT_SLOT); identStock.set(new TextEncoder().encode('FootCtrlPlus_012'));
  const identNew = new Uint8Array(IDENT_SLOT); identNew.set(new TextEncoder().encode(IDENT));
  replace(d, IDENT_ADDR, identStock, identNew, 'name/version');
  for (const [addr, stock, repl] of GREET) replace(d, addr, hex(stock), hex(repl), 'display patch');
  replace(d, TEXT_TABLE, new Uint8Array(TEXT_TABLE_MAX).fill(0xff), TEXTS, 'text table');
  rebuildAreaCrcs(d);
  const out = Uint8Array.from(member);
  out.set(memberDecrypt(d, KEY, POS), UBOOT);
  return out;
}

function patchUfw(stock) {
  const ufw = Uint8Array.from(stock);
  const count = decodeHeader(ufw).count;
  const done = new Set();
  for (let i = 0; i < count; i++) {
    const at = 0x40 + i * 0x50;
    const e = xcodeBlock(ufw.subarray(at, at + 0x50));
    const nameBytes = e.subarray(0x40, 0x50);
    const name = String.fromCharCode(...nameBytes.subarray(0, nameBytes.indexOf(0) < 0 ? 16 : nameBytes.indexOf(0)));
    if (name !== 'flash.bin' && name !== 'flash2.bin') continue;
    const off = u32(e, 0x08), size = u32(e, 0x0c);
    const member = ufw.subarray(off, off + size);
    check(u16(e, 4) === crc16(member), `${name}: original checksum wrong`);
    const patched = patchMember(member);
    ufw.set(patched, off);
    put16(e, 4, crc16(patched));
    ufw.set(xcodeBlock(e), at);
    done.add(name);
  }
  check(done.size === 2, 'flash.bin / flash2.bin not found');
  fixHeaderCrc(ufw);
  const h = decodeHeader(ufw); check(h.stored === h.calc, 'header checksum wrong');
  return fwscWrap(ufw, NAME, VERSION, SUFFIX);
}

async function sha256(bytes) {
  check(global.crypto && crypto.subtle, 'this browser cannot compute SHA-256 here (open the page via https or localhost)');
  const h = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(h), (x) => x.toString(16).padStart(2, '0')).join('');
}

// Main entry: ArrayBuffer/Uint8Array of the user's file -> { ok, message, data?, name?, sha256? }
async function patchFirmware(input) {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);
  const digest = await sha256(data);
  const kind = STOCK_SHA256[digest];
  if (!kind) {
    if (KNOWN_OTHER[digest]) return { ok: false, message: `This is ${KNOWN_OTHER[digest]}, not the original firmware 012.` };
    return { ok: false, message: `This is not the original M-VAVE firmware 012 (FootCtrlPlus_012.fwsc). ` +
      (data.length === 583476 ? 'The size is right but the content differs: the file is damaged or a different firmware.'
        : `It has ${data.length} bytes instead of 583476: the file is incomplete or a different file.`) };
  }
  const ufw = kind === 'fwsc' ? fwscUnwrap(data) : data;
  check(STOCK_SHA256[await sha256(ufw)] === 'ufw', 'unpacked firmware does not match');
  const out = patchUfw(ufw);
  const outDigest = await sha256(out);
  if (outDigest !== RESULT_SHA256) return { ok: false, message: 'Internal error: the result differs from the official build. Nothing was saved.' };
  return { ok: true, message: 'Patched. The result is identical to the official build.', data: out, name: OUT_NAME, sha256: outDigest };
}

global.FwPatch = { patchFirmware, OUT_NAME, RESULT_SHA256 };

// ---- UI (only if the page has the patcher elements) ----
function initUi() {
  const drop = document.getElementById('patch-drop');
  if (!drop) return;
  const input = document.getElementById('patch-file');
  const status = document.getElementById('patch-status');
  const save = document.getElementById('patch-save');
  let url = null;

  const show = (cls, html) => { status.className = 'patch-status ' + cls; status.innerHTML = html; };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function handle(file) {
    if (!file) return;
    if (url) { URL.revokeObjectURL(url); url = null; }
    save.hidden = true;
    show('busy', `Checking <code>${esc(file.name)}</code> …`);
    try {
      const res = await patchFirmware(await file.arrayBuffer());
      if (!res.ok) { show('err', `✗ ${esc(res.message)}`); return; }
      url = URL.createObjectURL(new Blob([res.data], { type: 'application/octet-stream' }));
      save.href = url; save.download = res.name; save.textContent = `⬇ Save ${res.name}`; save.hidden = false;
      show('ok', `✓ <code>${esc(file.name)}</code> is the original firmware 012. ${esc(res.message)}<br>` +
        `<span class="muted small">SHA-256 <code class="hash">${res.sha256}</code></span>`);
    } catch (e) {
      show('err', `✗ ${esc(e.message || e)}`);
    }
  }

  input.addEventListener('change', () => handle(input.files[0]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); handle(e.dataTransfer.files[0]); });
}
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUi); else initUi();
}
})(typeof window !== 'undefined' ? window : globalThis);
