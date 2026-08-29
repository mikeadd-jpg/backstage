// RFC 9728 protected resource metadata, served at /.well-known/oauth-protected-resource
// via a rewrite in next.config.js (App Router will not route a literal .well-known dir).
// `resource` must match the MCP URL exactly as the user types it into Claude.
import { NextResponse } from 'next/server';
import { baseUrl, SCOPE } from '../../../../lib/oauth.js';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  const base = baseUrl(req);
  return NextResponse.json({
    resource: base + '/api/mcp',
    authorization_servers: [base],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
  });
}
