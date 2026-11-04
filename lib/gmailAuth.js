// The Gmail mailbox Backstage reads and sends from, connected from Settings.
//
// Until someone connects a mailbox here, the pipeline keeps using GMAIL_REFRESH_TOKEN
// from env, exactly as before. Connecting stores a refresh token for the chosen account
// (the Workspace mailbox all three brands now deliver into) and from then on that wins.
//
// Why these scopes: gmail.modify reads every message including Sent, and sends; it is
// what replying from the Inbox tab needs. gmail.settings.basic reads the account's
// "Send mail as" list, which is how a reply goes out from the brand address the customer
// wrote to, with that address's own signature.
//
// The consent goes through the sign-in callback (/api/auth/google/callback) on purpose:
// that redirect URL is already registered on the OAuth client, so connecting needs no
// Google Cloud change. The signed state carries purpose 'gmail' to tell the two apart.
//
// The refresh token is encrypted at rest (AES-GCM, key derived from SESSION_SECRET), as
// Canva's is. Rotating SESSION_SECRET therefore disconnects the mailbox; ingest falls
// back to env and Settings says to reconnect. Google's refresh tokens do not rotate, so
// unlike Canva no lock is needed around refreshing.
import crypto from 'node:crypto';
import { getSetting, setSetting, deleteSetting } from './db.js';
import { redirectUri, signState } from './google.js';

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.settings.basic',
];

const AUTH_KEY = 'gmail_auth'; // { refresh (sealed), email, by, at, scopes, since }

function key() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not set');
  return crypto.createHash('sha256').update('gmail-token:' + secret).digest();
}
function seal(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => Buffer.from(b).toString('base64url')).join('.');
}
function unseal(sealed) {
  const [iv, tag, body] = String(sealed).split('.').map((p) => Buffer.from(p, 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString('utf8');
}

async function readAuth() {
  const raw = await getSetting(AUTH_KEY);
  return raw ? JSON.parse(raw) : null;
}

/** Google's consent URL for connecting a mailbox. Offline + consent so a refresh token comes back. */
export async function gmailConnectUrl(req, email) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', process.env.GMAIL_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri(req));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', ['openid', 'email', ...GMAIL_SCOPES].join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent select_account');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', await signState('/#settings', { purpose: 'gmail', by: email }));
  return url.toString();
}

/** Called from the sign-in callback when the state says purpose 'gmail'. */
export async function finishGmailConnect(req, { code, by }) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      redirect_uri: redirectUri(req),
      grant_type: 'authorization_code',
    }),
  });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Google refused the Gmail connection: ' + (tok.error_description || tok.error || res.status));
  if (!tok.refresh_token) throw new Error('Google returned no refresh token. Remove Backstage from the account\'s third-party access and connect again.');
  const granted = String(tok.scope || '').split(/\s+/);
  const missing = GMAIL_SCOPES.filter((s) => !granted.includes(s));
  if (missing.length) throw new Error('Tick every Gmail permission on the consent screen. Missing: ' + missing.map((s) => s.split('/').pop()).join(', '));

  // Which mailbox this is, from Gmail itself rather than the id_token, so it is the
  // account the token can actually read.
  const prof = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: 'Bearer ' + tok.access_token },
  }).then((r) => r.json());
  if (!prof.emailAddress) throw new Error('Connected, but Gmail would not say which mailbox it is.');

  const prev = await readAuth();
  const sameMailbox = prev && prev.email === prof.emailAddress.toLowerCase();
  await setSetting(AUTH_KEY, JSON.stringify({
    refresh: seal(tok.refresh_token),
    email: prof.emailAddress.toLowerCase(),
    by,
    at: new Date().toISOString(),
    scopes: tok.scope,
    // Ingest only reads mail newer than this, so switching mailboxes never re-ingests the
    // last two days that the old mailbox already delivered. Kept on a reconnect of the
    // same mailbox, since nothing is duplicated then.
    since: sameMailbox && prev.since ? prev.since : Math.floor(Date.now() / 1000),
  }));
  return prof.emailAddress.toLowerCase();
}

export async function disconnectGmail() {
  const auth = await readAuth();
  await deleteSetting(AUTH_KEY);
  if (auth) {
    try {
      await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(unseal(auth.refresh)), { method: 'POST' });
    } catch { /* the local copy is gone either way */ }
  }
}

/**
 * The credentials the Gmail client should use: the connected mailbox, else env.
 * `canSend` is false on the env token, which predates the send scope.
 */
export async function gmailCredentials() {
  const auth = await readAuth().catch(() => null);
  if (auth) {
    try {
      return { refreshToken: unseal(auth.refresh), email: auth.email, since: auth.since || null, connected: true, canSend: true };
    } catch {
      // SESSION_SECRET rotated: the stored token is unreadable. Fall back rather than stop ingest.
    }
  }
  if (!process.env.GMAIL_REFRESH_TOKEN) throw new Error('No Gmail mailbox is connected. Connect one in Settings.');
  return { refreshToken: process.env.GMAIL_REFRESH_TOKEN, email: null, since: null, connected: false, canSend: false };
}

export async function gmailStatus() {
  const auth = await readAuth().catch(() => null);
  let readable = true;
  if (auth) { try { unseal(auth.refresh); } catch { readable = false; } }
  return {
    configured: Boolean(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET),
    connected: Boolean(auth && readable),
    unreadable: Boolean(auth && !readable),
    email: auth ? auth.email : null,
    by: auth ? auth.by : null,
    at: auth ? auth.at : null,
    envFallback: Boolean(process.env.GMAIL_REFRESH_TOKEN),
  };
}
