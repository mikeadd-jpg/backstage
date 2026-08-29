// RFC 8414 authorization server metadata, served at /.well-known/oauth-authorization-server.
// token_endpoint_auth_methods_supported is ["none"] because every client here is public:
// Claude's clients cannot keep a secret, so PKCE is what actually protects the exchange.
import { NextResponse } from 'next/server';
import { baseUrl, SCOPE } from '../../../../lib/oauth.js';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  const base = baseUrl(req);
  return NextResponse.json({
    issuer: base,
    authorization_endpoint: base + '/api/oauth/authorize',
    token_endpoint: base + '/api/oauth/token',
    registration_endpoint: base + '/api/oauth/register',
    scopes_supported: [SCOPE],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  });
}
