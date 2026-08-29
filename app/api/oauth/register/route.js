// RFC 7591 dynamic client registration. Claude registers itself on first connect, so this
// has to be open; it hands out an identifier only, never a credential. Bodies are JSON
// here, unlike /token which is form-encoded.
import { NextResponse } from 'next/server';
import { registerClient } from '../../../../lib/oauth.js';

export const dynamic = 'force-dynamic';

export async function POST(req) {
  try {
    const body = await req.json();
    const { clientId, redirectUris } = await registerClient({
      clientName: body.client_name,
      redirectUris: body.redirect_uris,
    });
    return NextResponse.json({
      client_id: clientId,
      client_name: body.client_name || 'Unnamed client',
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      client_id_issued_at: Math.floor(Date.now() / 1000),
    }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: 'invalid_client_metadata', error_description: String(err.message || err) },
      { status: 400 }
    );
  }
}
