// RFC 9728 metadata for the creative MCP connection, served at
// /.well-known/oauth-protected-resource/api/mcp/creative (the path after the well-known
// prefix names the resource) through a rewrite in next.config.js. The customer-service
// connection's own metadata is the route one level up.
import { NextResponse } from 'next/server';
import { baseUrl, CREATIVE_SCOPE, CREATIVE_PATH } from '../../../../../lib/oauth.js';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  const base = baseUrl(req);
  return NextResponse.json({
    resource: base + CREATIVE_PATH,
    authorization_servers: [base],
    scopes_supported: [CREATIVE_SCOPE],
    bearer_methods_supported: ['header'],
  });
}
