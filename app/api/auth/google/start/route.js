// Kick off Google sign-in. The state parameter is signed rather than stored, so this
// stays stateless: the callback can verify it came from us without a session table.
import { redirectUri, signState } from '../../../../../lib/google.js';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  const clientId = process.env.GMAIL_CLIENT_ID;
  if (!clientId) {
    return new Response('GMAIL_CLIENT_ID is not set on the server.', { status: 500 });
  }
  const next = new URL(req.url).searchParams.get('next') || '/';
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri(req));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', await signState(next));
  // Always offer the account chooser: several people share this laptop pattern, and a
  // silent sign-in as the wrong Google account is confusing to debug.
  url.searchParams.set('prompt', 'select_account');
  return Response.redirect(url.toString(), 302);
}
