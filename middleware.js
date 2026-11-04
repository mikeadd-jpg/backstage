// Gates the whole app behind Google sign-in.
//
// Access is two steps: Google proves who you are, and the allowed_users table decides
// whether you are let in. That check happens once at sign-in; afterwards this middleware
// only verifies the signed session cookie, which keeps it free of database calls and
// therefore able to run on the Edge runtime.
//
// Allowed through without a session:
//   - /login and the /api/auth/* routes, or you could never sign in
//   - /api/ingest, /api/scan, /api/email-snapshot and /api/printers-refresh, the cron
//     endpoints, which authenticate with their own secret headers (x-ingest-key or the
//     Vercel Bearer token)
//   - /api/inspiration-refresh, the competitor ads cron, same secrets as the others
//   - /api/inspiration/capture, the iPhone Shortcut's upload door, which checks its own
//     upload key (hash in app_settings) and can only hand out a capture upload link
//   - /api/recreate/worker, which hands an Inspiration batch from one invocation to the
//     next and checks INGEST_SECRET itself
//   - /api/mcp, which authenticates with MCP_TOKEN or an OAuth access token
//   - /api/oauth/* and /.well-known/*, the OAuth flow Claude uses to reach /api/mcp. Its
//     consent screen does its own session check, so approval is still gated.
import { NextResponse } from 'next/server';
import { readSession, SESSION_COOKIE } from './lib/session.js';

const PUBLIC_PATHS = [
  '/login', '/api/auth',
  '/api/ingest', '/api/scan', '/api/email-snapshot', '/api/printers-refresh', '/api/inspiration-refresh',
  '/api/inspiration/capture', '/api/recreate/worker',
  '/api/mcp', '/api/oauth', '/.well-known',
];

export async function middleware(req) {
  const { pathname } = req.nextUrl;

  if (pathname.startsWith('/_next') || pathname.startsWith('/favicon')) {
    return NextResponse.next();
  }
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }

  const session = await readSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (session) return NextResponse.next();

  // API calls get a 401; page requests go to the login screen and come back afterwards.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = pathname === '/' ? '' : '?next=' + encodeURIComponent(pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
