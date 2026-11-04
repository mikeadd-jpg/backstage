// The consent screen. GET renders it, POST approves and redirects back with a code.
//
// Approval requires a signed-in Backstage user. This route is exempt from the middleware
// gate so the OAuth handshake can reach it, which means it has to check the session
// itself: without that, anyone who found the URL could approve a connector.
//
// Being signed in is not enough. For the customer-service connection (scope
// backstage:read) the role must include the connect area (owner, admin): it reads every
// inquiry and order with no per-person identity, so letting a Creative approve one would
// hand out the customer data their role deliberately omits. The creative connection
// (backstage:creative, /api/mcp/creative) holds no customer data and acts as the person
// who approved it, so anyone with the inspiration, mockups and ads areas may approve it,
// and their email rides on the code and tokens.
import { checkRedirect, issueCode, scopeFor, CREATIVE_SCOPE } from '../../../../lib/oauth.js';
import { readSession, SESSION_COOKIE } from '../../../../lib/session.js';
import { getAccess } from '../../../../lib/access.js';

const NOT_ALLOWED = "Your role can't connect Claude to Backstage. Ask an admin or owner to approve the connection.";
const NOT_ALLOWED_CREATIVE = "Your role can't connect Claude to Backstage's creative tools: it needs Inspiration, Mockups and Ads.";
const CREATIVE_AREAS = ['inspiration', 'mockups', 'ads'];
const allowed = (access, scope) => Boolean(access) && (scope === CREATIVE_SCOPE
  ? CREATIVE_AREAS.every((a) => access.areas.includes(a)) : access.areas.includes('connect'));

const WHAT = {
  read: {
    title: 'Connect Backstage to Claude',
    lead: 'Claude is asking to read your Backstage data. It will be able to:',
    items: ['Read at-risk orders and support inquiries', 'Look up orders across your Shopify stores', 'Draft replies, without sending anything'],
  },
  creative: {
    title: 'Connect Backstage creative tools to Claude',
    lead: 'Claude is asking to work in Backstage\'s creative tools as you. It will be able to:',
    items: [
      'Read Inspiration, your products, brand kits and Drafts',
      'Make mockups and recreate ads in bulk (paid images, at most 20 per batch)',
      'Plan, render and favourite video and image ads in Drafts',
      'Send a finished ad to Meta as a creative, and add it to an ad set paused. Never live, never a budget',
    ],
  },
};

export const dynamic = 'force-dynamic';

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function page({ params, error, user }) {
  const hidden = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource']
    .map((k) => '<input type="hidden" name="' + k + '" value="' + esc(params[k]) + '">').join('');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(params.what.title)}</title>
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
  <h1>${esc(params.what.title)}</h1>
  <p>${esc(params.what.lead)}</p>
  <ul>${params.what.items.map((i) => '<li>' + esc(i) + '</li>').join('')}</ul>
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
    scope: sp.get('scope') || '',
    resource: sp.get('resource') || '',
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

  const scope = scopeFor(p);
  const access = await getAccess(req);
  if (!allowed(access, scope)) return fail(scope === CREATIVE_SCOPE ? NOT_ALLOWED_CREATIVE : NOT_ALLOWED);

  const client = await checkRedirect(p.client_id, p.redirect_uri);
  const what = WHAT[scope === CREATIVE_SCOPE ? 'creative' : 'read'];
  return html(page({ params: { ...p, client_name: client.client.client_name, what }, error: null, user: session }));
}

export async function POST(req) {
  const form = await req.formData();
  const p = readParams(form); // FormData exposes .get, same as URLSearchParams
  const bad = await validate(p);
  if (bad) return fail(bad);

  const session = await readSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return fail('Your session expired before you approved. Start the connection again.');
  const scope = scopeFor(p);
  const access = await getAccess(req);
  if (!allowed(access, scope)) return fail(scope === CREATIVE_SCOPE ? NOT_ALLOWED_CREATIVE : NOT_ALLOWED);

  const code = await issueCode({
    clientId: p.client_id,
    redirectUri: p.redirect_uri,
    codeChallenge: p.code_challenge,
    scope,
    userEmail: access.email,
  });

  const dest = new URL(p.redirect_uri);
  dest.searchParams.set('code', code);
  if (p.state) dest.searchParams.set('state', p.state);
  return Response.redirect(dest.toString(), 302);
}
