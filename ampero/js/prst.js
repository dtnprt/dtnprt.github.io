// .prst preset files of the Hotone Ampero II software:
//   base64( "[b0,b1,…]" )  with b = LZO1X-1 compressed TLV preset (5068 bytes on firmware 2.5)
// encodePrst() is byte-identical to the software's export (checked with an exported .prst, see tests).

import * as lzo from './lzo1x.js';

/** TLV preset -> .prst file bytes (ASCII). */
export function encodePrst(raw) {
  const json = '[' + Array.from(lzo.compress(raw)).join(',') + ']';
  return new TextEncoder().encode(btoa(json));
}

/** .prst file bytes -> TLV preset. */
export function decodePrst(bytes) {
  const text = new TextDecoder().decode(bytes).replace(/\s+/g, '');
  let arr;
  try {
    arr = JSON.parse(atob(text));
  } catch {
    throw new Error('not a .prst file');
  }
  if (!Array.isArray(arr)) throw new Error('not a .prst file');
  return lzo.decompress(Uint8Array.from(arr));
}
