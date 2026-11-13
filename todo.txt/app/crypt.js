// Encrypted todo files (AES-256-GCM) for the browser, WebCrypto only. Same format as cli/src/crypt.rs:
//
//   todotxt-enc1 pbkdf2-sha256 600000 <salt, base64> <nonce, base64>
//   <ciphertext + GCM tag, base64, wrapped at 76 columns>
//
// Key = PBKDF2-HMAC-SHA256(password, salt, iterations); the header line is the authenticated data.
// No DOM, so node can test it (node:test, WebCrypto is global in Node 20+).

export const MAGIC = 'todotxt-enc1';
export const ITERATIONS = 600000;
const MAX_ITERATIONS = 20000000;

export const isEncrypted = (text) => text.startsWith(MAGIC + ' ');

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const bytes64 = (buf) => { // chunked, so large files do not overflow the argument limit
  const a = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000));
  return btoa(s);
};

let session = null;
const keys = new Map();
export const setSession = (pw) => { session = pw; keys.clear(); };
export const getSession = () => session;
export const hasSession = () => session !== null;

async function keyFor(password, salt, iterations) {
  const id = `${password}\u0000${b64(salt)}\u0000${iterations}`;
  if (keys.has(id)) return keys.get(id);
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  if (keys.size >= 8) keys.delete(keys.keys().next().value);
  keys.set(id, key);
  return key;
}

let sealSalt = null;

/** Encrypt `plain` (the salt, and with it the key, is reused for the session; the nonce is fresh every time). */
export async function seal(plain, password, opts = {}) {
  return sealBytes(enc.encode(plain), password, opts);
}

/** Encrypt bytes (Uint8Array), e.g. a pasted image; same text format. */
export async function sealBytes(data, password, { salt, nonce, iterations = ITERATIONS } = {}) {
  salt = salt || (sealSalt ||= crypto.getRandomValues(new Uint8Array(16)));
  nonce = nonce || crypto.getRandomValues(new Uint8Array(12));
  const header = `${MAGIC} pbkdf2-sha256 ${iterations} ${b64(salt)} ${b64(nonce)}`;
  const key = await keyFor(password, salt, iterations);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: enc.encode(header) }, key, data);
  const body = bytes64(ct).match(/.{1,76}/g) || [];
  return `${header}\n${body.join('\n')}\n`;
}

/** Decrypt a file text. Throws Error('wrong password …') or Error('damaged encrypted file: …'). */
export async function open(text, password) {
  return dec.decode(await openBytes(text, password));
}

/** Decrypt to bytes (Uint8Array). */
export async function openBytes(text, password) {
  const nl = text.indexOf('\n');
  const header = (nl < 0 ? text : text.slice(0, nl)).replace(/\r$/, '');
  const body = nl < 0 ? '' : text.slice(nl + 1);
  const p = header.split(/\s+/);
  if (p.length !== 5 || p[0] !== MAGIC) throw new Error('damaged encrypted file: bad header');
  if (p[1] !== 'pbkdf2-sha256') throw new Error(`damaged encrypted file: unknown key derivation ${p[1]}`);
  const iterations = Number(p[2]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS) throw new Error('damaged encrypted file: bad iteration count');
  let salt, nonce, ct;
  try { salt = unb64(p[3]); nonce = unb64(p[4]); ct = unb64(body.replace(/\s+/g, '')); } catch { throw new Error('damaged encrypted file: bad base64'); }
  if (nonce.length !== 12 || salt.length < 8) throw new Error('damaged encrypted file: bad salt or nonce');
  const key = await keyFor(password, salt, iterations);
  let plain;
  try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: enc.encode(header) }, key, ct); }
  catch { throw new Error('wrong password (or the encrypted file was modified)'); }
  return new Uint8Array(plain);
}

/** Is this file content (ArrayBuffer/Uint8Array) an encrypted-file text? */
export function isEncryptedBytes(buf) {
  const b = new Uint8Array(buf).subarray(0, MAGIC.length + 1);
  return b.length === MAGIC.length + 1 && String.fromCharCode(...b) === MAGIC + ' ';
}

/** Encrypt bytes and return the encrypted file as bytes (UTF-8 text), ready to be written. */
export async function seal2bytes(data, password, opts = {}) {
  return enc.encode(await sealBytes(data, password, opts));
}
