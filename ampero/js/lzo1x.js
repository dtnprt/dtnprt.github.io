// LZO1X for the Ampero II protocol – port of tools/lzo1x.py.
// decompress(): miniLZO 2.10 lzo1x_decompress (with bounds checks)
// compress():   miniLZO 2.10 lzo1x_1_compress, D_BITS = 14, x64 match extension –
//               byte-identical to what the Hotone editor (HTUSBTools.dll) sends.

export class LZOError extends Error {}

/** Decompress a raw LZO1X stream (no header) up to its end marker. Returns Uint8Array. */
export function decompress(src) {
  src = src instanceof Uint8Array ? src : new Uint8Array(src);
  const n = src.length;
  let out = new Uint8Array(Math.max(256, n * 4));
  let op = 0;
  let ip = 0;

  const need = (k) => {
    if (ip + k > n) throw new LZOError(`input overrun at ${ip}`);
  };
  const grow = (k) => {
    if (op + k <= out.length) return;
    let cap = out.length * 2;
    while (cap < op + k) cap *= 2;
    const o = new Uint8Array(cap);
    o.set(out.subarray(0, op));
    out = o;
  };
  const lits = (k) => {
    need(k);
    grow(k);
    out.set(src.subarray(ip, ip + k), op);
    ip += k;
    op += k;
  };
  const copy = (mpos, k) => {
    if (mpos < 0) throw new LZOError(`lookbehind overrun at out=${op}`);
    grow(k);
    for (let i = 0; i < k; i++) out[op + i] = out[mpos + i];
    op += k;
  };
  const byte = () => {
    need(1);
    return src[ip++];
  };
  const ext = (base) => {
    let v = 0;
    while (byte() === 0) v += 255;
    return v + base + src[ip - 1];
  };

  const LOOP = 0, FIRST_LIT = 1, MATCH = 2, MATCH_DONE = 3;
  let state = LOOP;
  let t = 0;
  need(1);
  if (src[0] > 17) {
    t = src[0] - 17;
    ip = 1;
    lits(t);
    if (t < 4) {
      t = byte();
      state = MATCH;
    } else {
      state = FIRST_LIT;
    }
  }
  for (;;) {
    if (state === LOOP) {
      t = byte();
      if (t >= 16) { state = MATCH; continue; }
      if (t === 0) t = ext(15);
      lits(t + 3);
      state = FIRST_LIT;
    } else if (state === FIRST_LIT) {
      t = byte();
      if (t >= 16) { state = MATCH; continue; }
      const b = byte();
      copy(op - 0x801 - (t >> 2) - (b << 2), 3);
      state = MATCH_DONE;
    } else if (state === MATCH) {
      if (t >= 64) {
        const b = byte();
        copy(op - 1 - ((t >> 2) & 7) - (b << 3), (t >> 5) + 1);
      } else if (t >= 32) {
        t &= 31;
        if (t === 0) t = ext(31);
        need(2);
        const d = (src[ip] | (src[ip + 1] << 8)) >> 2;
        ip += 2;
        copy(op - 1 - d, t + 2);
      } else if (t >= 16) {
        let mpos = op - ((t & 8) << 11);
        t &= 7;
        if (t === 0) t = ext(7);
        need(2);
        mpos -= (src[ip] | (src[ip + 1] << 8)) >> 2;
        ip += 2;
        if (mpos === op) break; // end of stream
        copy(mpos - 0x4000, t + 2);
      } else {
        const b = byte();
        copy(op - 1 - (t >> 2) - (b << 2), 2);
      }
      state = MATCH_DONE;
    } else {
      // MATCH_DONE
      t = src[ip - 2] & 3;
      if (t === 0) { state = LOOP; continue; }
      lits(t);
      t = byte();
      state = MATCH;
    }
  }
  return out.slice(0, op);
}

// ------------------------------------------------------------------ compressor

function litHeader(op, t, first) {
  if (first && t <= 238) {
    op.push(17 + t);
  } else if (t <= 3) {
    op[op.length - 2] |= t;
  } else if (t <= 18) {
    op.push(t - 3);
  } else {
    let tt = t - 18;
    op.push(0);
    while (tt > 255) {
      tt -= 255;
      op.push(0);
    }
    op.push(tt);
  }
}

/** Number of equal leading bytes (0..8) of the 8-byte windows at a and b; bytes past the end count as 0. */
function eq8(src, a, b) {
  const n = src.length;
  for (let k = 0; k < 8; k++) {
    const x = a + k < n ? src[a + k] : 0;
    const y = b + k < n ? src[b + k] : 0;
    if (x !== y) return k;
  }
  return 8;
}

function doCompress(src, base, inLen, op, ti) {
  const D_BITS = 14;
  const D_MASK = (1 << D_BITS) - 1;
  const inEnd = base + inLen;
  const ipEnd = base + inLen - 20;
  const dict = new Uint32Array(1 << D_BITS);
  let ip = base;
  let ii = ip;
  ip += ti < 4 ? 4 - ti : 0;
  for (;;) {
    ip += 1 + ((ip - ii) >> 5);
    for (;;) {
      if (ip >= ipEnd) return inEnd - (ii - ti);
      const dv = (src[ip] | (src[ip + 1] << 8) | (src[ip + 2] << 16) | (src[ip + 3] << 24)) >>> 0;
      const dindex = (Math.imul(0x1824429d, dv) >>> (32 - D_BITS)) & D_MASK;
      const mPos = base + dict[dindex];
      dict[dindex] = ip - base;
      if (mPos >= ip || src[mPos] !== src[ip] || src[mPos + 1] !== src[ip + 1] ||
          src[mPos + 2] !== src[ip + 2] || src[mPos + 3] !== src[ip + 3]) {
        break; // -> literal
      }
      ii -= ti;
      ti = 0;
      const t = ip - ii;
      if (t) {
        litHeader(op, t, false);
        for (let k = 0; k < t; k++) op.push(src[ii + k]);
      }
      // 64-bit match extension of the x64 build: ip_end is checked only after each 8-byte step
      let mLen = 4;
      let e = eq8(src, ip + mLen, mPos + mLen);
      if (e === 8) {
        for (;;) {
          mLen += 8;
          e = eq8(src, ip + mLen, mPos + mLen);
          if (ip + mLen >= ipEnd) break;
          if (e !== 8) { mLen += e; break; }
        }
      } else {
        mLen += e;
      }
      let mOff = ip - mPos;
      ip += mLen;
      ii = ip;
      if (mLen <= 8 && mOff <= 0x800) {
        mOff -= 1;
        op.push(((mLen - 1) << 5) | ((mOff & 7) << 2));
        op.push(mOff >> 3);
      } else if (mOff <= 0x4000) {
        mOff -= 1;
        if (mLen <= 33) {
          op.push(32 | (mLen - 2));
        } else {
          mLen -= 33;
          op.push(32);
          while (mLen > 255) { mLen -= 255; op.push(0); }
          op.push(mLen);
        }
        op.push((mOff << 2) & 0xff);
        op.push((mOff >> 6) & 0xff);
      } else {
        mOff -= 0x4000;
        if (mLen <= 9) {
          op.push(16 | ((mOff >> 11) & 8) | (mLen - 2));
        } else {
          mLen -= 9;
          op.push(16 | ((mOff >> 11) & 8));
          while (mLen > 255) { mLen -= 255; op.push(0); }
          op.push(mLen);
        }
        op.push((mOff << 2) & 0xff);
        op.push((mOff >> 6) & 0xff);
      }
    }
  }
}

/** LZO1X-1 compress (raw stream incl. end marker, no header). Returns Uint8Array. */
export function compress(data) {
  const src = data instanceof Uint8Array ? data : new Uint8Array(data);
  const n = src.length;
  const op = [];
  let pos = 0;
  let left = n;
  let t = 0;
  while (left > 20) {
    const ll = Math.min(left, 49152);
    t = doCompress(src, pos, ll, op, t);
    pos += ll;
    left -= ll;
  }
  t += left;
  if (t > 0) {
    const ii = n - t;
    litHeader(op, t, op.length === 0);
    for (let k = 0; k < t; k++) op.push(src[ii + k]);
  }
  op.push(0x11, 0x00, 0x00);
  return Uint8Array.from(op);
}
