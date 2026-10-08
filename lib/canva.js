// Pushes an approved mockup into Canva, one folder per brand, so a reel can be built
// from it there. Uploads only: it does not create a design, edit one, or publish
// anything. Same line lib/meta.js draws: the asset is in place, a human makes the reel.
//
// Canva's Connect API has no API keys. Every call acts as a Canva user through OAuth
// (authorization code + PKCE), so someone with the settings area connects their Canva
// account once from Settings and every upload lands in that account. The tokens live in
// app_settings under canva_auth, encrypted with a key derived from SESSION_SECRET:
// unlike the MCP tokens in lib/oauth.js these have to be usable, so hashing is not an
// option. Rotating SESSION_SECRET therefore also disconnects Canva, which suits it
// being the panic button.
//
// Refresh tokens are single-use and rotate on every refresh. Two functions refreshing
// at once would leave one holding a burned token and the account disconnected, so the
// refresh runs under withSettingLock and re-reads the row inside the lock.
//
// Autofill (filling a reel template) would need Canva Enterprise. This is the version
// that works on every plan.
import crypto from 'node:crypto';
import { getSetting, setSetting, deleteSetting, withSettingLock } from './db.js';
import { BRANDS } from './brands.js';

const AUTHORIZE = 'https://www.canva.com/api/oauth/authorize';
const API = 'https://api.canva.com/rest/v1';
// asset:read is needed to poll the upload job; write does not imply read in Canva.
// All four must also be ticked on the integration in Canva's Developer Portal.
const SCOPES = 'asset:read asset:write folder:read folder:write';

const AUTH_KEY = 'canva_auth';         // { access, refresh (sealed), expiresAt, by, at }
const PENDING_KEY = 'canva_pkce';      // the one connection attempt in flight
const FOLDERS_KEY = 'canva_folders';   // brand -> Canva folder id

const RECONNECT = 'Reconnect Canva in Settings.';

export const canvaConfigured = () =>
  Boolean(process.env.CANVA_CLIENT_ID && process.env.CANVA_CLIENT_SECRET);

export const canvaRedirectUri = (base) => base + '/api/canva/callback';

// Canva's folder pages live at this path. Used only for a convenience link.
export const canvaFolderUrl = (id) => 'https://www.canva.com/folder/' + id;

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// ---- encryption at rest -------------------------------------------------------------

function key() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not set');
  return crypto.createHash('sha256').update('canva-token:' + secret).digest();
}
function seal(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map(b64url).join('.');
}
function unseal(sealed) {
  try {
    const [iv, tag, body] = String(sealed).split('.').map((p) => Buffer.from(p, 'base64url'));
    const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString('utf8');
  } catch {
    // Almost always SESSION_SECRET having been rotated since the account was connected.
    throw new Error('The stored Canva connection can no longer be read. ' + RECONNECT);
  }
}

// ---- connecting -----------------------------------------------------------------------

/** The Canva consent URL. The PKCE verifier stays server side, never in state. */
export async function startConnect(base, email) {
  if (!canvaConfigured()) throw new Error('CANVA_CLIENT_ID and CANVA_CLIENT_SECRET are not set.');
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(24));
  await setSetting(PENDING_KEY, JSON.stringify({ state, verifier: seal(verifier), by: email, t: Date.now() }));

  const url = new URL(AUTHORIZE);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', process.env.CANVA_CLIENT_ID);
  url.searchParams.set('redirect_uri', canvaRedirectUri(base));
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  return url.toString();
}

/** Called from the callback. The pending attempt is burned whatever happens. */
export async function finishConnect(base, { code, state, email }) {
  const raw = await getSetting(PENDING_KEY);
  await deleteSetting(PENDING_KEY);
  const pending = raw ? JSON.parse(raw) : null;
  if (!pending || !state || pending.state !== state) {
    throw new Error('That Canva connection attempt is not the one in progress. Start again from Settings.');
  }
  if (Date.now() - pending.t > 10 * 60 * 1000) throw new Error('That Canva connection attempt expired. Start again.');
  if (pending.by !== email) throw new Error('The Canva connection was started by someone else. Start again.');
  if (!code) throw new Error('Canva did not return an authorization code.');

  const tok = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    code_verifier: unseal(pending.verifier),
    redirect_uri: canvaRedirectUri(base),
  });
  await setSetting(AUTH_KEY, pack(tok, { by: email, at: new Date().toISOString() }));
  // A different Canva account cannot see the old account's folders.
  await deleteSetting(FOLDERS_KEY);
  memo = null;
}

export async function disconnect() {
  const raw = await getSetting(AUTH_KEY);
  await deleteSetting(AUTH_KEY);
  await deleteSetting(FOLDERS_KEY);
  memo = null;
  // Best effort: tell Canva too, so the grant disappears from the account's app list.
  if (raw) {
    try {
      const refresh = unseal(JSON.parse(raw).refresh);
      await fetch(API + '/oauth/revoke', {
        method: 'POST',
        headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refresh }),
      });
    } catch { /* the local copy is gone either way */ }
  }
}

export async function canvaStatus() {
  const raw = await getSetting(AUTH_KEY);
  const auth = raw ? JSON.parse(raw) : null;
  return {
    configured: canvaConfigured(),
    connected: Boolean(auth),
    by: auth ? auth.by : null,
    at: auth ? auth.at : null,
  };
}

// ---- tokens -----------------------------------------------------------------------------

const basicAuth = () => 'Basic ' + Buffer.from(
  process.env.CANVA_CLIENT_ID + ':' + process.env.CANVA_CLIENT_SECRET
).toString('base64');

async function tokenRequest(params) {
  const res = await fetch(API + '/oauth/token', {
    method: 'POST',
    headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.access_token) {
    const msg = (data && (data.error_description || data.message || data.error)) || ('HTTP ' + res.status);
    if (params.grant_type === 'refresh_token') {
      throw new Error('Canva refused to renew the connection (' + msg + '). ' + RECONNECT);
    }
    throw new Error('Canva rejected the connection: ' + msg);
  }
  return data;
}

function pack(tok, who) {
  return JSON.stringify({
    access: seal(tok.access_token),
    refresh: seal(tok.refresh_token),
    expiresAt: Date.now() + (Number(tok.expires_in) || 14400) * 1000,
    by: who.by,
    at: who.at,
  });
}

// A warm function reuses its token without a database round trip. Access tokens last
// about four hours, so this is the common path.
let memo = null; // { token, expiresAt }

async function accessToken() {
  if (memo && memo.expiresAt - Date.now() > 60 * 1000) return memo.token;
  return withSettingLock(AUTH_KEY, async (raw) => {
    if (!raw) throw new Error('Canva is not connected. Someone with Settings access can connect it there.');
    const auth = JSON.parse(raw);
    // Inside the lock: another function may have refreshed while we waited.
    if (auth.expiresAt - Date.now() > 60 * 1000) {
      memo = { token: unseal(auth.access), expiresAt: auth.expiresAt };
      return { result: memo.token };
    }
    const tok = await tokenRequest({ grant_type: 'refresh_token', refresh_token: unseal(auth.refresh) });
    const value = pack(tok, auth);
    memo = { token: tok.access_token, expiresAt: JSON.parse(value).expiresAt };
    return { value, result: tok.access_token };
  });
}

async function canva(path, { method = 'GET', headers = {}, body, json } = {}) {
  const token = await accessToken();
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : body,
  });
  if (res.status === 204) return {};
  const data = await res.json().catch(() => null);
  if (res.ok) return data || {};

  const code = data && data.code;
  const msg = (data && data.message) || ('HTTP ' + res.status);
  const err = new Error(
    res.status === 401 ? 'Canva rejected the stored connection. ' + RECONNECT
      : res.status === 403 && /scope/i.test(msg)
        ? 'The Canva integration is missing a scope (' + msg + '). Tick ' + SCOPES +
          ' in the Developer Portal, then reconnect in Settings.'
      : res.status === 429 ? 'Canva is rate limiting uploads (30 a minute). Try again in a minute.'
      : 'Canva said: ' + msg
  );
  if (res.status === 401) memo = null;
  err.code = code;
  throw err;
}

// ---- folders and upload -------------------------------------------------------------------

const folderName = (brand) => 'Backstage · ' + ((BRANDS[brand] && BRANDS[brand].name) || brand) + ' mockups';

async function brandFolder(brand, { fresh = false } = {}) {
  return withSettingLock(FOLDERS_KEY, async (raw) => {
    const map = raw ? JSON.parse(raw) : {};
    if (map[brand] && !fresh) return { result: map[brand] };
    const d = await canva('/folders', { method: 'POST', json: { name: folderName(brand), parent_folder_id: 'root' } });
    if (!d.folder || !d.folder.id) throw new Error('Canva created no folder.');
    map[brand] = d.folder.id;
    return { value: JSON.stringify(map), result: d.folder.id };
  });
}

async function waitForUpload(job) {
  const deadline = Date.now() + 90 * 1000;
  let wait = 1000;
  while (job.status === 'in_progress') {
    if (Date.now() > deadline) throw new Error('Canva is still processing the upload. It should appear in Uploads shortly.');
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(wait + 1000, 4000);
    job = (await canva('/asset-uploads/' + encodeURIComponent(job.id))).job;
  }
  if (job.status !== 'success' || !job.asset) {
    const e = job.error || {};
    throw new Error(e.code === 'file_too_big'
      ? 'Canva says the image is too big to upload.'
      : 'Canva could not import the image: ' + (e.message || e.code || 'no detail'));
  }
  return job.asset;
}

/**
 * Upload a base64 PNG and file it in the brand's folder. Returns
 * { assetId, folderId, folderUrl, moveError }. A failed move still leaves the image in
 * the account's Uploads, so it is reported, not thrown.
 */
export async function uploadToCanva(brand, b64, name) {
  if (!b64) throw new Error('No image to send.');
  // Canva caps the unencoded name at 50 characters and needs no extension.
  const clean = String(name || brand + '-lifestyle').replace(/\.png$/i, '').slice(0, 50);
  const start = await canva('/asset-uploads', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Asset-Upload-Metadata': JSON.stringify({ name_base64: Buffer.from(clean, 'utf8').toString('base64') }),
    },
    body: Buffer.from(b64, 'base64'),
  });
  const asset = await waitForUpload(start.job);

  let folderId = null;
  let moveError = null;
  try {
    folderId = await brandFolder(brand);
    try {
      await canva('/folders/move', { method: 'POST', json: { to_folder_id: folderId, item_id: asset.id } });
    } catch (err) {
      // Someone deleted the folder in Canva. Make a new one and try once more.
      if (err.code !== 'folder_not_found') throw err;
      folderId = await brandFolder(brand, { fresh: true });
      await canva('/folders/move', { method: 'POST', json: { to_folder_id: folderId, item_id: asset.id } });
    }
  } catch (err) {
    moveError = 'Uploaded, but left in Uploads rather than the brand folder: ' + String(err.message || err);
    folderId = null;
  }

  return { assetId: asset.id, folderId, folderUrl: folderId ? canvaFolderUrl(folderId) : null, moveError };
}
