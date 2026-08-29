// Signed session cookies.
//
// This module is imported by middleware.js, which runs on the Edge runtime, so it must
// use Web Crypto rather than node:crypto and must not touch the database. Anything
// needing Postgres lives in lib/users.js instead.
//
// A session is payload.signature, both base64url. The payload is readable by design, it
// is the signature that matters: without SESSION_SECRET you cannot forge one.

export const SESSION_COOKIE = 'backstage_session';
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

const enc = new TextEncoder();

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlToString = (s) =>
  atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));

async function sign(data) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not set');
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

// Constant time: a length-independent early return would leak how much of the signature
// an attacker had guessed right.
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createSession({ email, role, name }) {
  const payload = b64url(enc.encode(JSON.stringify({
    email, role, name: name || null, exp: Date.now() + SESSION_TTL_MS,
  })));
  return payload + '.' + (await sign(payload));
}

export async function readSession(value) {
  if (!value || typeof value !== 'string') return null;
  const dot = value.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = value.slice(0, dot);
  const signature = value.slice(dot + 1);

  let expected;
  try { expected = await sign(payload); } catch { return null; }
  if (!safeEqual(signature, expected)) return null;

  let data;
  try { data = JSON.parse(b64urlToString(payload)); } catch { return null; }
  if (!data || !data.email || !data.exp || data.exp < Date.now()) return null;
  return data;
}

export const cookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
  maxAge: Math.floor(SESSION_TTL_MS / 1000),
};
