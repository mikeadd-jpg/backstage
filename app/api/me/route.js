// Who is signed in, for the UI. Middleware has already verified the cookie by the time
// this runs, so this only has to decode it.
import { NextResponse } from 'next/server';
import { readSession, SESSION_COOKIE } from '../../../lib/session.js';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  const session = await readSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ user: null }, { status: 401 });
  return NextResponse.json({
    user: { email: session.email, role: session.role, name: session.name },
  });
}
