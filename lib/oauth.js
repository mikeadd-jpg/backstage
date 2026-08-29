// A minimal OAuth 2.1 authorization server, existing only so Claude's hosted surfaces
// (web, Desktop, mobile) can reach /api/mcp. Their connector UI takes OAuth or nothing,
// and "nothing" would put customer data on the open internet.
//
// Deliberately narrow: public clients with PKCE S256, authorization code and refresh
// grants, no client secrets, no user accounts. The consent screen authenticates against
// the APP_PASSWORD the dashboard already uses, so there is no second identity to manage.
import { createHash, randomBytes } from 'crypto';
import { Pool } from 'pg';

let pool;
function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

const CODE_TTL_MS = 60 * 1000;                 // codes are single use and short lived
const ACCESS_TTL_MS = 60 * 60 * 1000;          // 1 hour
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const SCOPE = 'backstage:read';

const sha256 = (v) => createHash('sha256').update(String(v)).digest('hex');
const token = () => randomBytes(32).toString('base64url');

// Anthropic requires the resource identifier to match the MCP URL exactly as typed, so
// derive the origin from the request rather than hardcoding a deployment alias.
export function baseUrl(req) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/+$/, '');
  const h = req.headers;
  const host = h.get('x-forwarded-host') || h.get('host');
  const proto = h.get('x-forwarded-proto') || 'https';
  return proto + '://' + host;
}

// Claude Code uses an RFC 8252 loopback redirect on an ephemeral port, so localhost and
// 127.0.0.1 must match with the port ignored. Everything else must match exactly.
function redirectAllowed(registered, candidate) {
  if (registered.includes(candidate)) return true;
  let u;
  try { u = new URL(candidate); } catch { return false; }
  if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return false;
  return registered.some((r) => {
    let x;
    try { x = new URL(r); } catch { return false; }
    return (x.hostname === 'localhost' || x.hostname === '127.0.0.1') && x.pathname === u.pathname;
  });
}

export async function registerClient({ clientName, redirectUris }) {
  if (!Array.isArray(redirectUris) || !redirectUris.length) {
    throw new Error('redirect_uris is required');
  }
  const clientId = 'bkc_' + randomBytes(16).toString('base64url');
  await getPool().query(
    'INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1,$2,$3)',
    [clientId, clientName || 'Unnamed client', redirectUris]
  );
  return { clientId, redirectUris };
}

export async function getClient(clientId) {
  const { rows } = await getPool().query(
    'SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = $1', [clientId]
  );
  return rows[0] || null;
}

export async function checkRedirect(clientId, redirectUri) {
  const c = await getClient(clientId);
  if (!c) return { ok: false, error: 'Unknown client_id' };
  if (!redirectAllowed(c.redirect_uris, redirectUri)) return { ok: false, error: 'redirect_uri not registered' };
  return { ok: true, client: c };
}

export async function issueCode({ clientId, redirectUri, codeChallenge, scope }) {
  const code = token();
  await getPool().query(
    `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, scope, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + make_interval(secs => $6))`,
    [sha256(code), clientId, redirectUri, codeChallenge, scope || SCOPE, CODE_TTL_MS / 1000]
  );
  return code;
}

async function mintTokens(clientId, scope) {
  const access = token();
  const refresh = token();
  const pool = getPool();
  await pool.query(
    `INSERT INTO oauth_tokens (token_hash, kind, client_id, scope, expires_at)
     VALUES ($1,'access',$2,$3, now() + make_interval(secs => $4)),
            ($5,'refresh',$2,$3, now() + make_interval(secs => $6))`,
    [sha256(access), clientId, scope, ACCESS_TTL_MS / 1000, sha256(refresh), REFRESH_TTL_MS / 1000]
  );
  return {
    access_token: access,
    refresh_token: refresh,
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    scope,
  };
}

// PKCE S256 only: the spec requires it and there is no reason to accept plain here.
export async function exchangeCode({ code, clientId, redirectUri, codeVerifier }) {
  const pool = getPool();
  const hash = sha256(code);
  const { rows } = await pool.query('SELECT * FROM oauth_codes WHERE code_hash = $1', [hash]);
  const row = rows[0];
  // Burn the code whether or not it validates, so it can never be replayed.
  await pool.query('DELETE FROM oauth_codes WHERE code_hash = $1', [hash]);

  if (!row) throw new Error('invalid_grant');
  if (new Date(row.expires_at).getTime() < Date.now()) throw new Error('invalid_grant');
  if (row.client_id !== clientId) throw new Error('invalid_grant');
  if (row.redirect_uri !== redirectUri) throw new Error('invalid_grant');
  if (!codeVerifier) throw new Error('invalid_grant');

  const derived = createHash('sha256').update(codeVerifier).digest('base64url');
  if (derived !== row.code_challenge) throw new Error('invalid_grant');

  return mintTokens(row.client_id, row.scope);
}

// Public clients must rotate refresh tokens, so the old one dies with the exchange.
export async function refreshTokens({ refreshToken, clientId }) {
  const pool = getPool();
  const hash = sha256(refreshToken);
  const { rows } = await pool.query(
    "SELECT * FROM oauth_tokens WHERE token_hash = $1 AND kind = 'refresh'", [hash]
  );
  const row = rows[0];
  await pool.query('DELETE FROM oauth_tokens WHERE token_hash = $1', [hash]);

  if (!row) throw new Error('invalid_grant');
  if (new Date(row.expires_at).getTime() < Date.now()) throw new Error('invalid_grant');
  if (clientId && row.client_id !== clientId) throw new Error('invalid_grant');

  return mintTokens(row.client_id, row.scope);
}

export async function verifyAccessToken(accessToken) {
  if (!accessToken) return null;
  const { rows } = await getPool().query(
    "SELECT client_id, scope, expires_at FROM oauth_tokens WHERE token_hash = $1 AND kind = 'access'",
    [sha256(accessToken)]
  );
  const row = rows[0];
  if (!row || new Date(row.expires_at).getTime() < Date.now()) return null;
  return { clientId: row.client_id, scope: row.scope };
}

// Housekeeping, cheap enough to run opportunistically from the token endpoint.
export async function purgeExpired() {
  const pool = getPool();
  await pool.query('DELETE FROM oauth_codes WHERE expires_at < now()');
  await pool.query('DELETE FROM oauth_tokens WHERE expires_at < now()');
}
