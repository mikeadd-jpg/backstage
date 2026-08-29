// Google sign-in helpers. Sign-in reuses the OAuth client the Gmail pipeline already
// uses (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET), so there is no second Google app to
// manage. It does mean the callback URL has to be registered on that client.
const enc = new TextEncoder();

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function baseUrl(req) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/+$/, '');
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
  const proto = req.headers.get('x-forwarded-proto') || (host && host.startsWith('localhost') ? 'http' : 'https');
  return proto + '://' + host;
}

export const redirectUri = (req) => baseUrl(req) + '/api/auth/google/callback';

async function hmac(data) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not set');
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

// State carries the post-login destination and doubles as CSRF protection.
export async function signState(next) {
  const body = b64url(enc.encode(JSON.stringify({ next, t: Date.now() })));
  return body + '.' + (await hmac(body));
}

export async function readState(state) {
  if (!state) return null;
  const dot = state.lastIndexOf('.');
  if (dot < 1) return null;
  const body = state.slice(0, dot);
  if ((await hmac(body)) !== state.slice(dot + 1)) return null;
  try {
    const data = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(body.length / 4) * 4, '=')));
    if (Date.now() - data.t > 10 * 60 * 1000) return null; // a stale login attempt
    // Only ever redirect within this app, never to an absolute URL an attacker supplied.
    const next = typeof data.next === 'string' && data.next.startsWith('/') && !data.next.startsWith('//') ? data.next : '/';
    return { next };
  } catch { return null; }
}

// Exchange the authorization code and read the identity out of the id_token.
// The token comes straight from Google over TLS in response to our authenticated
// request, which is why OpenID Connect allows skipping signature verification here.
export async function exchangeGoogleCode(code, redirect) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      redirect_uri: redirect,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error('Google rejected the sign-in: ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const data = await res.json();
  if (!data.id_token) throw new Error('Google returned no id_token.');

  const part = data.id_token.split('.')[1];
  const claims = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')));
  if (!claims.email) throw new Error('Google returned no email address.');
  if (claims.email_verified === false) throw new Error('That Google account has an unverified email address.');
  return { email: String(claims.email).toLowerCase(), name: claims.name || null, hd: claims.hd || null };
}
