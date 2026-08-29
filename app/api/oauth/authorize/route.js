// The consent screen. GET renders it, POST approves and redirects back with a code.
//
// Approval requires a signed-in Backstage user. This route is exempt from the middleware
// gate so the OAuth handshake can reach it, which means it has to check the session
// itself: without that, anyone who found the URL could approve a connector.
import { checkRedirect, issueCode, SCOPE } from '../../../../lib/oauth.js';
import { readSession, SESSION_COOKIE } from '../../../../lib/session.js';

export const dynamic = 'force-dynamic';

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function page({ params, error, user }) {
  const hidden = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope']
    .map((k) => '<input type="hidden" name="' + k + '" value="' + esc(params[k]) + '">').join('');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Backstage to Claude</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f7;
         margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; }
  .card { background: #fff; border-radius: 14px; padding: 30px; max-width: 400px; width: 100%;
          box-shadow: 0 1px 3px rgba(0,0,0,.1), 0 8px 28px rgba(0,0,0,.06); }
  h1 { font-size: 19px; margin: 0 0 6px; }
  p { color: #555; font-size: 14px; line-height: 1.5; margin: 0 0 18px; }
  ul { color: #555; font-size: 13px; line-height: 1.7; margin: 0 0 18px; padding-left: 20px; }
  input[type=password] { width: 100%; padding: 11px 12px; font-size: 15px; border: 1px solid #d3d3d8;
                         border-radius: 9px; box-sizing: border-box; }
  button { width: 100%; margin-top: 12px; padding: 12px; font-size: 15px; font-weight: 600; color: #fff;
           background: #16161a; border: 0; border-radius: 9px; cursor: pointer; }
  .err { color: #c0392b; font-size: 13px; margin-top: 10px; }
  .who { font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: #666;
         background: #f2f2f4; padding: 8px 10px; border-radius: 7px; word-break: break-all; }
</style></head><body><div class="card">
  <h1>Connect Backstage to Claude</h1>
  <p>Claude is asking to read your Backstage data. It will be able to:</p>
  <ul>
    <li>Read at-risk orders and support inquiries</li>
    <li>Look up orders across your Shopify stores</li>
    <li>Draft replies, without sending anything</li>
  </ul>
  <div class="who">${esc(params.client_name || params.client_id)}</div>
  <p style="margin:14px 0 0;font-size:13px;color:#555">Signed in as <strong>${esc(user.email)}</strong></p>
  <form method="POST" style="margin-top:10px">${hidden}
    <button type="submit">Approve</button>
    ${error ? '<div class="err">' + esc(error) + '</div>' : ''}
  </form>
</div></body></html>`;
}

const html = (body, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

// Errors before we trust redirect_uri must be shown, not redirected, or we become an
// open redirector.
const fail = (msg) => html('<p style="font-family:sans-serif;padding:24px">' + esc(msg) + '</p>', 400);

function readParams(sp) {
  return {
    client_id: sp.get('client_id') || '',
    redirect_uri: sp.get('redirect_uri') || '',
    state: sp.get('state') || '',
    code_challenge: sp.get('code_challenge') || '',
    code_challenge_method: sp.get('code_challenge_method') || '',
    scope: sp.get('scope') || SCOPE,
    client_name: sp.get('client_name') || '',
  };
}

async function validate(p) {
  if (!p.client_id || !p.redirect_uri) return 'Missing client_id or redirect_uri.';
  if (!p.code_challenge) return 'PKCE is required: no code_challenge was sent.';
  if (p.code_challenge_method !== 'S256') return 'Only the S256 PKCE method is supported.';
  const check = await checkRedirect(p.client_id, p.redirect_uri);
  if (!check.ok) return check.error;
  return null;
}

export async function GET(req) {
  const p = readParams(new URL(req.url).searchParams);
  const bad = await validate(p);
  if (bad) return fail(bad);

  // Not signed in: bounce through Google and come straight back to this same consent URL.
  const session = await readSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    const here = new URL(req.url);
    const next = here.pathname + here.search;
    return Response.redirect(new URL('/api/auth/google/start?next=' + encodeURIComponent(next), req.url).toString(), 302);
  }

  const client = await checkRedirect(p.client_id, p.redirect_uri);
  return html(page({ params: { ...p, client_name: client.client.client_name }, error: null, user: session }));
}

export async function POST(req) {
  const form = await req.formData();
  const p = readParams(form); // FormData exposes .get, same as URLSearchParams
  const bad = await validate(p);
  if (bad) return fail(bad);

  const session = await readSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return fail('Your session expired before you approved. Start the connection again.');

  const code = await issueCode({
    clientId: p.client_id,
    redirectUri: p.redirect_uri,
    codeChallenge: p.code_challenge,
    scope: p.scope,
  });

  const dest = new URL(p.redirect_uri);
  dest.searchParams.set('code', code);
  if (p.state) dest.searchParams.set('state', p.state);
  return Response.redirect(dest.toString(), 302);
}
