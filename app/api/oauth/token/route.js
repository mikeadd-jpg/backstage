// Token endpoint. Must accept application/x-www-form-urlencoded: Claude sends both the
// initial exchange and refreshes that way, and a JSON-only parser would 415 them.
import { NextResponse } from 'next/server';
import { exchangeCode, refreshTokens, purgeExpired } from '../../../../lib/oauth.js';

export const dynamic = 'force-dynamic';

const oauthError = (code, description, status = 400) =>
  NextResponse.json({ error: code, error_description: description }, {
    status, headers: { 'Cache-Control': 'no-store' },
  });

async function readForm(req) {
  const type = req.headers.get('content-type') || '';
  if (type.includes('application/json')) return await req.json();
  const form = await req.formData();
  return Object.fromEntries([...form.entries()]);
}

export async function POST(req) {
  let body;
  try { body = await readForm(req); } catch { return oauthError('invalid_request', 'Could not parse the request body.'); }

  const grant = body.grant_type;
  try {
    if (grant === 'authorization_code') {
      const tokens = await exchangeCode({
        code: body.code,
        clientId: body.client_id,
        redirectUri: body.redirect_uri,
        codeVerifier: body.code_verifier,
      });
      purgeExpired().catch(() => {}); // opportunistic housekeeping, never blocks the response
      return NextResponse.json(tokens, { headers: { 'Cache-Control': 'no-store' } });
    }

    if (grant === 'refresh_token') {
      const tokens = await refreshTokens({
        refreshToken: body.refresh_token,
        clientId: body.client_id,
      });
      return NextResponse.json(tokens, { headers: { 'Cache-Control': 'no-store' } });
    }

    return oauthError('unsupported_grant_type', 'Supported grants: authorization_code, refresh_token.');
  } catch (err) {
    // RFC 6749 codes exactly: Claude keys its refresh retry logic on invalid_grant.
    const msg = String(err.message || err);
    if (msg === 'invalid_grant') return oauthError('invalid_grant', 'The code or refresh token is invalid, expired, or already used.');
    return oauthError('server_error', msg, 500);
  }
}
