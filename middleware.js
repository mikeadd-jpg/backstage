// Gates the whole app behind a shared password.
// Allowed through without a cookie:
//   - /login and /api/login (so you can actually sign in)
//   - the cron endpoints /api/ingest and /api/scan, which authenticate with their own
//     secret headers (x-ingest-key or the Vercel Bearer token), not the cookie.
//   - /api/mcp, which authenticates with its own MCP_TOKEN bearer token.
//   - /api/oauth/* and /.well-known/*, the OAuth flow Claude uses to reach /api/mcp. The
//     consent screen checks APP_PASSWORD itself, so it gates its own approval step.
import { NextResponse } from 'next/server';

const PUBLIC_PATHS = ['/login', '/api/login', '/api/ingest', '/api/scan', '/api/mcp',
  '/api/oauth', '/.well-known'];

export function middleware(req) {
  const { pathname } = req.nextUrl;

  // Let Next internals and static assets through.
  if (pathname.startsWith('/_next') || pathname.startsWith('/favicon')) {
    return NextResponse.next();
  }
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }

  const cookie = req.cookies.get('backstage_auth');
  if (cookie && cookie.value === process.env.APP_PASSWORD) {
    return NextResponse.next();
  }

  // API calls get a 401; page requests get redirected to the login screen.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  return NextResponse.redirect(url);
}

export const config = {
  // Run on everything except static files.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
